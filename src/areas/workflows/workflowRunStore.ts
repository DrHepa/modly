import { create } from 'zustand'
import axios from 'axios'
import { useAppStore } from '../../shared/stores/appStore.ts'
import type { WorkflowExtension } from './mockExtensions.ts'
import type { Workflow, WFNode, WFEdge } from '../../shared/types/electron.d'
import { buildProcessExecutionInput } from './processExecution.ts'
import { resolveWorkflowDispatch } from './workflowDispatch.ts'
import { hydrateWorkflowNodeParams } from './workflowNodeParams.ts'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowRunState {
  status:        'idle' | 'running' | 'paused' | 'done' | 'error'
  blockIndex:    number
  blockTotal:    number
  blockProgress: number
  blockStep:     string
  outputUrl?:    string
  outputPath?:   string
  error?:        string
}

const IDLE: WorkflowRunState = {
  status: 'idle', blockIndex: 0, blockTotal: 0, blockProgress: 0, blockStep: '',
}

// Module-level refs — survive component unmounts / navigation
const _cancel      = { current: false }
const _activeJobId = { current: null as string | null }
const _resume      = { current: null as (() => void) | null }

function flushResume(): void {
  const fn = _resume.current
  if (!fn) return
  _resume.current = null
  fn()
}

type ModelGenerationRequest =
  | {
      kind: 'image'
      imagePath: string
      imageData?: string
      params: Record<string, unknown>
    }
  | {
      kind: 'text'
      payload: {
        prompt: string
        model_id: string
        collection: string
        remesh: string
        enable_texture: boolean
        texture_resolution: number
        params: Record<string, unknown>
      }
    }

function buildModelGenerationRequest(args: {
  ext: WorkflowExtension
  node: WFNode
  nodeParams: Record<string, unknown>
  nodeInputPath?: string
  nodeInputText?: string
  nodeInputMeshPath?: string
  selectedImagePath: string
  selectedImageData?: string
  workspaceDir: string
}): ModelGenerationRequest {
  const {
    ext,
    node,
    nodeParams,
    nodeInputPath,
    nodeInputText,
    nodeInputMeshPath,
    selectedImagePath,
    selectedImageData,
    workspaceDir,
  } = args

  if (ext.input === undefined) {
    throw new Error(`Missing workflow capability input metadata for extension: ${ext.id}`)
  }

  if (ext.input === 'text') {
    const promptParam = typeof nodeParams.prompt === 'string' ? nodeParams.prompt : undefined
    const prompt = nodeInputText ?? promptParam ?? ''
    const { prompt: _prompt, ...params } = nodeParams

    return {
      kind: 'text',
      payload: {
        prompt,
        model_id: node.data.extensionId ?? '',
        collection: 'Workflows',
        remesh: 'none',
        enable_texture: false,
        texture_resolution: 1024,
        params,
      },
    }
  }

  if (ext.input !== 'image') {
    throw new Error(`Unsupported workflow capability input for extension ${ext.id}: ${String(ext.input)}`)
  }

  const activeImagePath = nodeInputPath ?? selectedImagePath
  const extraParams: Record<string, unknown> = {}
  if (nodeInputMeshPath) {
    const norm = nodeInputMeshPath.replace(/\\/g, '/')
    extraParams.mesh_path = norm.startsWith(workspaceDir)
      ? norm.slice(workspaceDir.length).replace(/^\//, '')
      : norm
  }

  return {
    kind: 'image',
    imagePath: activeImagePath,
    imageData: selectedImageData && nodeInputPath === undefined ? selectedImageData : undefined,
    params: { ...nodeParams, ...extraParams },
  }
}

// ─── Topological sort ─────────────────────────────────────────────────────────

function topoSort(nodes: WFNode[], edges: WFEdge[]): WFNode[] {
  const nodeMap  = new Map(nodes.map((n) => [n.id, n]))
  const inDegree = new Map(nodes.map((n) => [n.id, 0]))
  const adj      = new Map(nodes.map((n) => [n.id, [] as string[]]))
  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
  }
  const queue  = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0)
  const result: WFNode[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    result.push(node)
    for (const neighbor of adj.get(node.id) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 0) - 1
      inDegree.set(neighbor, deg)
      if (deg === 0) queue.push(nodeMap.get(neighbor)!)
    }
  }
  return result
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface WorkflowRunStore {
  runState:         WorkflowRunState
  activeNodeId:     string | null
  activeWorkflowId: string | null
  /** nodeId → workspace URL for image outputs (populated after each run) */
  nodeImageOutputs: Record<string, string>

  run:         (workflow: Workflow, allExtensions: WorkflowExtension[], overrideImageData?: string) => Promise<void>
  cancel:      () => void
  reset:       () => void
  continueRun: () => void
}

export const useWorkflowRunStore = create<WorkflowRunStore>((set) => ({
  runState:         IDLE,
  activeNodeId:     null,
  activeWorkflowId: null,
  nodeImageOutputs: {},

  async run(workflow, allExtensions, overrideImageData?) {
    _cancel.current = false

    const appState     = useAppStore.getState()
    const apiUrl       = appState.apiUrl
    const ordered      = topoSort(workflow.nodes, workflow.edges)
    const execNodes    = ordered.filter((n) =>
      (n.type === 'extensionNode' || n.type === 'waitNode') && n.data.enabled,
    )

    const selectedImagePath = appState.selectedImagePath ?? ''
    const selectedImageData = overrideImageData ?? appState.selectedImageData ?? undefined
    const currentMeshUrl    = appState.currentJob?.outputUrl

    set({
      activeWorkflowId: workflow.id,
      nodeImageOutputs: {},
      runState: { status: 'running', blockIndex: 0, blockTotal: execNodes.length, blockProgress: 0, blockStep: 'Starting…' },
    })

    appState.setCurrentJob({
      id: crypto.randomUUID(),
      imageFile: selectedImagePath,
      status: 'generating',
      progress: 0,
      createdAt: Date.now(),
    })

    try {
      const client   = axios.create({ baseURL: apiUrl })
      const settings = await window.electron.settings.get()
      const workspaceDir = settings.workspaceDir.replace(/\\/g, '/')

      // Clean up tmp folder from previous run
      const tmpAbsPath = settings.workspaceDir.replace(/[\\/]+$/, '') + '/tmp'
      window.electron.fs.deleteDirectory(tmpAbsPath).catch(() => {})

      // nodeId → { filePath, text, outputType }
      const nodeOutputs = new Map<string, { filePath?: string; text?: string; outputType?: string }>()
      const outputNodeIds = new Set(ordered.filter((n) => n.type === 'outputNode').map((n) => n.id))

      // Pre-populate source nodes
      for (const node of ordered) {
        if (node.type === 'imageNode') {
          const fp = node.data.params?.filePath as string | undefined
          // When the agent provides an override image, ignore any hardcoded filePath so the
          // model node falls through to selectedImageData (= overrideImageData).
          const resolvedPath = overrideImageData ? undefined : (fp ?? selectedImagePath ?? undefined)
          nodeOutputs.set(node.id, { filePath: resolvedPath, outputType: 'image' })
        }
        if (node.type === 'textNode') {
          nodeOutputs.set(node.id, { text: node.data.params?.text as string | undefined })
        }
        if (node.type === 'meshNode') {
          const source = node.data.params?.source as 'file' | 'current' | undefined
          if (source === 'current' && currentMeshUrl) {
            let meshFilePath: string
            if (currentMeshUrl.includes('serve-file?path=')) {
              // URL like /optimize/serve-file?path=D%3A%5C... → extract and decode the real path
              const encoded = currentMeshUrl.split('serve-file?path=')[1]
              meshFilePath = decodeURIComponent(encoded).replace(/\\/g, '/')
            } else {
              // URL like /workspace/Workflows/file.glb → resolve to absolute path
              const rel = currentMeshUrl.replace(/^\/workspace\//, '')
              meshFilePath = `${workspaceDir}/${rel}`
            }
            nodeOutputs.set(node.id, { filePath: meshFilePath, outputType: 'mesh' })
          } else {
            const fp = node.data.params?.filePath as string | undefined
            if (fp) nodeOutputs.set(node.id, { filePath: fp, outputType: 'mesh' })
          }
        }
      }

      for (let i = 0; i < execNodes.length; i++) {
        if (_cancel.current) { set({ runState: IDLE, activeNodeId: null }); return }

        const node = execNodes[i]
        const dispatch = resolveWorkflowDispatch(node, allExtensions)
        const { ext, mode } = dispatch
        const hydratedParams = hydrateWorkflowNodeParams(ext, node.data.params as Record<string, unknown> | undefined)

        // ── Resolve inputs ────────────────────────────────────────────────
        let nodeInputPath:     string | undefined
        let nodeInputText:     string | undefined
        let nodeInputMeshPath: string | undefined

        const incomingEdges = workflow.edges.filter((e) => e.target === node.id)

        if (ext?.inputs && ext.inputs.length > 1) {
          // Multi-input: route each incoming edge by the source node's outputType
          for (const edge of incomingEdges) {
            const src = nodeOutputs.get(edge.source)
            if (!src) continue
            if (src.outputType === 'mesh')        nodeInputMeshPath = src.filePath
            else if (src.outputType === 'image')  nodeInputPath     = src.filePath
            else if (src.filePath !== undefined)  nodeInputPath     = src.filePath
            if (src.text !== undefined)           nodeInputText     = src.text
          }
        } else {
          // Single-input
          for (const edge of incomingEdges) {
            const src = nodeOutputs.get(edge.source)
            if (src?.filePath !== undefined) nodeInputPath = src.filePath
            if (src?.text     !== undefined) nodeInputText = src.text
          }
          // Fallback to previous node's output
          if (nodeInputPath === undefined && nodeInputText === undefined && i > 0) {
            const prev = nodeOutputs.get(execNodes[i - 1].id)
            if (prev?.filePath !== undefined) nodeInputPath = prev.filePath
            if (prev?.text     !== undefined) nodeInputText = prev.text
          }
        }

        set((s) => ({
          activeNodeId: node.id,
          runState: { ...s.runState, blockIndex: i, blockProgress: 0, blockStep: 'Starting…' },
        }))

        // ── Wait node → pause until continueRun(), then passthrough ───────
        if (node.type === 'waitNode') {
          set((s) => ({ runState: { ...s.runState, status: 'paused', blockStep: 'Paused — click Continue' } }))
          await new Promise<void>((resolve) => { _resume.current = resolve })
          if (_cancel.current) { set({ runState: IDLE, activeNodeId: null }); return }

          nodeOutputs.set(node.id, {
            filePath:   nodeInputPath,
            text:       nodeInputText,
            outputType: incomingEdges[0] ? nodeOutputs.get(incomingEdges[0].source)?.outputType : undefined,
          })
          set((s) => ({ runState: { ...s.runState, status: 'running' } }))
          continue
        }

        // ── Model extensions → HTTP API ───────────────────────────────────
        // Process extensions → IPC runProcess
        if (mode === 'model') {
          const request = buildModelGenerationRequest({
            ext,
            node,
            nodeParams: hydratedParams,
            nodeInputPath,
            nodeInputText,
            nodeInputMeshPath,
            selectedImagePath,
            selectedImageData,
            workspaceDir,
          })

          set((s) => ({ runState: { ...s.runState, blockProgress: 5, blockStep: 'Submitting to model…' } }))

          const { data } = await (request.kind === 'image'
            ? (async () => {
              const base64 = request.imageData ?? await window.electron.fs.readFileBase64(request.imagePath)
              const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
              const blob  = new Blob([bytes], { type: 'image/png' })
              const fname = request.imagePath.split(/[\\/]/).pop() ?? 'image.png'
              const fd = new FormData()
              fd.append('image', blob, fname)
              fd.append('model_id', node.data.extensionId ?? '')
              fd.append('collection', 'Workflows')
              fd.append('remesh', 'none')
              fd.append('enable_texture', 'false')
              fd.append('texture_resolution', '1024')
              fd.append('params', JSON.stringify(request.params))
              return client.post<{ job_id: string }>(
                '/generate/from-image', fd,
                { headers: { 'Content-Type': 'multipart/form-data' } },
              )
            })()
            : client.post<{ job_id: string }>('/generate/from-text', request.payload))
          _activeJobId.current = data.job_id

          while (true) {
            if (_cancel.current) {
              await client.post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
              _activeJobId.current = null
              set({ runState: IDLE, activeNodeId: null })
              return
            }
            await new Promise((r) => setTimeout(r, 1200))

            const { data: st } = await client.get<{
              status: string; progress?: number; step?: string; output_url?: string; error?: string
            }>(`/generate/status/${_activeJobId.current}`)

            if (st.status === 'done' && st.output_url) {
              const rel = st.output_url.replace(/^\/workspace\//, '')
              nodeInputPath = `${workspaceDir}/${rel}`
              _activeJobId.current = null
              set((s) => ({ runState: { ...s.runState, blockProgress: 100, blockStep: 'Generation complete' } }))
              break
            }
            if (st.status === 'error') throw new Error(st.error ?? 'Generation failed')

            const total   = execNodes.length
            const overall = total > 0
              ? Math.round((i / total) * 100 + (st.progress ?? 0) / total)
              : st.progress ?? 0
            set((s) => ({
              runState: { ...s.runState, blockProgress: st.progress ?? s.runState.blockProgress, blockStep: st.step ?? 'Generating…' },
            }))
            useAppStore.getState().updateCurrentJob({ status: 'generating', progress: overall, step: st.step })
          }

        } else {
          const processInput = buildProcessExecutionInput({
            node,
            nodes: workflow.nodes,
            edges: workflow.edges,
            allExtensions,
            nodeOutputs,
            previousNodeOutput: i > 0 ? nodeOutputs.get(execNodes[i - 1].id) : undefined,
          })
          const result = await window.electron.extensions.runProcess(
            ext.extensionId,
            processInput,
            hydratedParams,
          )
          if (!result.success) throw new Error(result.error ?? 'Process extension failed')
          nodeInputPath = processInput.filePath
          nodeInputText = processInput.text
          nodeInputPath = result.result?.filePath ?? nodeInputPath
          nodeInputText = result.result?.text     ?? nodeInputText
          set((s) => ({ runState: { ...s.runState, blockProgress: 100, blockStep: 'Done' } }))
        }

        // Store output with type for downstream routing
        const outputType = ext?.output ?? (nodeInputPath ? 'mesh' : undefined)
        nodeOutputs.set(node.id, { filePath: nodeInputPath, text: nodeInputText, outputType })

        // If this node feeds an Add-to-Scene, push the mesh to currentJob
        // immediately so the 3D viewer loads it without waiting for the rest of the run.
        const norm = nodeInputPath?.replace(/\\/g, '/')
        if (
          norm?.startsWith(workspaceDir) &&
          workflow.edges.some((e) => e.source === node.id && outputNodeIds.has(e.target))
        ) {
          useAppStore.getState().updateCurrentJob({
            status:    'done',
            progress:  100,
            outputUrl: `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`,
          })
        }
      }

      // ── Collect image outputs for preview nodes ───────────────────────
      const imageOutputs: Record<string, string> = {}
      for (const [nodeId, out] of nodeOutputs) {
        if (out.outputType === 'image' && out.filePath) {
          const norm = out.filePath.replace(/\\/g, '/')
          if (norm.startsWith(workspaceDir)) {
            imageOutputs[nodeId] = `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
          }
        }
      }

      // ── Resolve final output URL ──────────────────────────────────────
      let outputUrl:  string | undefined
      let outputPath: string | undefined

      // Use the last AddToScene in topo order — its predecessor is the final scene mesh.
      const outputNodeDef = [...ordered].reverse().find((n) => n.type === 'outputNode')
      if (outputNodeDef) {
        for (const edge of workflow.edges.filter((e) => e.target === outputNodeDef.id)) {
          const src = nodeOutputs.get(edge.source)
          if (src?.filePath) {
            const norm = src.filePath.replace(/\\/g, '/')
            if (norm.startsWith(workspaceDir)) {
              outputUrl = `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
            }
          }
        }
      }
      if (!outputUrl) {
        for (const node of execNodes) {
          const out = nodeOutputs.get(node.id)
          if (out?.filePath) {
            const norm = out.filePath.replace(/\\/g, '/')
            if (norm.startsWith(workspaceDir)) {
              outputUrl = `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
            } else {
              outputPath = out.filePath
            }
          }
        }
      }

      set({
        activeNodeId:     null,
        nodeImageOutputs: imageOutputs,
        runState: {
          status:        'done',
          blockIndex:    execNodes.length > 0 ? execNodes.length - 1 : 0,
          blockTotal:    execNodes.length,
          blockProgress: 100,
          blockStep:     'Done',
          outputUrl,
          outputPath,
        },
      })
      useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl })

    } catch (err) {
      if (!_cancel.current) {
        set((s) => ({ runState: { ...s.runState, status: 'error', error: String(err) }, activeNodeId: null }))
        useAppStore.getState().updateCurrentJob({ status: 'error', error: String(err) })
      }
    }
  },

  cancel() {
    _cancel.current = true
    flushResume()
    if (_activeJobId.current) {
      const apiUrl = useAppStore.getState().apiUrl
      axios.create({ baseURL: apiUrl }).post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
      _activeJobId.current = null
    }
    set({ runState: IDLE, activeNodeId: null, activeWorkflowId: null, nodeImageOutputs: {} })
  },

  reset() {
    set({ runState: IDLE, activeNodeId: null, activeWorkflowId: null, nodeImageOutputs: {} })
  },

  continueRun() {
    flushResume()
  },
}))
