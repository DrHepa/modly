import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlowProvider,
  useNodesState, useEdgesState, useReactFlow,
  type Node as FlowNode, type Edge as FlowEdge,
} from '@xyflow/react'
// ReactFlowProvider wraps EmbeddedCanvas so useReactFlow() works in param rows
import { useWorkflowsStore }   from '@shared/stores/workflowsStore'
import { useExtensionsStore }  from '@shared/stores/extensionsStore'
import { useNavStore }         from '@shared/stores/navStore'
import { useWorkflowRunStore } from '@areas/workflows/workflowRunStore'
import { useWaitButton } from '@areas/workflows/useWaitButton'
import { buildAllWorkflowExtensions, getWorkflowExtension } from '@areas/workflows/mockExtensions'
import { validateWorkflowPreflight } from '@areas/workflows/preflight'
import type { WorkflowExtension } from '@areas/workflows/mockExtensions'
import ChatPanel from './ChatPanel'

type PanelMode = 'basic' | 'chat'
import { validateWorkflowProcessRun } from '@areas/workflows/processConnectionRules'
import AdvancedOptionsSection from '@areas/workflows/components/AdvancedOptionsSection'
import WorkflowParamControl from '@areas/workflows/components/WorkflowParamControl'
import { partitionAdvancedParams } from '@areas/workflows/workflowParamSchema'
import { resolveWaitCheckpointUiState } from '@areas/workflows/nodes/WaitNode'
import type { Workflow, WFNode, WFEdge } from '@shared/types/electron.d'
import type { WorkflowRunState } from '@areas/workflows/workflowRunStore'
import { REQUIRED_LANDMARK_IDS, type LandmarkCaptureState, type LandmarkId } from '@areas/workflows/landmarks'
import { LANDMARK_GUIDE_ITEM_BY_ID } from '@areas/workflows/landmarkGuideModel'
import { deriveArtifactHistoryRows, type ArtifactHistoryRow, type LandmarkSidecarLineageMetadata } from '@areas/workflows/workflowArtifacts'
import type {
  ArtifactLineage,
  ArtifactRef,
  ArtifactReplacementResult,
  ArtifactSubstitutionPoint,
} from '@shared/types/artifacts'

const toFlowNodes = (nodes: WFNode[]): FlowNode[] => nodes as unknown as FlowNode[]
const toFlowEdges = (edges: WFEdge[]): FlowEdge[] => edges as unknown as FlowEdge[]
const toWorkflowNodes = (nodes: FlowNode[]): WFNode[] => nodes as unknown as WFNode[]
const toWorkflowEdges = (edges: FlowEdge[]): WFEdge[] => edges as unknown as WFEdge[]

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  image: '#38bdf8',
  mesh:  '#a78bfa',
  text:  '#fbbf24',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function topoSortNodes(nodes: Workflow['nodes'], edges: Workflow['edges']): WFNode[] {
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

function mimeFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

type WorkflowRunErrorCopy = {
  title: string
  detail: string
}

type WorkflowPanelLandmarkSession = Pick<
  LandmarkCaptureState,
  'nodeId' | 'activeLandmarkId' | 'completed' | 'validity' | 'canContinue' | 'error'
>

type LandmarkLabelCopy = { id: LandmarkId; label: string; token: string }

export type WorkflowPanelLandmarkGuidance = {
  isActive: boolean
  currentLabel: string
  currentToken: string
  progressLabel: string
  remainingLabel: string
  remainingLandmarks: LandmarkLabelCopy[]
  instruction: string
  continueLabel: string
  continueDisabled: boolean
  placedLandmarks: LandmarkLabelCopy[]
  error?: string
}

export type WorkflowRunPrimaryAction =
  | { kind: 'generate'; label: 'Generate 3D Model'; disabled: boolean }
  | { kind: 'stop'; label: 'Stop'; disabled: false }
  | { kind: 'continue-landmarks'; label: string; disabled: boolean }

export type WorkflowLandmarkGuidanceAction =
  | { kind: 'continue-landmarks'; disabled: boolean }
  | { kind: 'clear-landmarks'; nodeId: string; disabled: boolean }

export type WorkflowRunLandmarkClearAction = { kind: 'clear-landmarks'; nodeId: string; disabled: boolean }

function formatLandmarkLabel(id: LandmarkId): string {
  return LANDMARK_GUIDE_ITEM_BY_ID[id].label
}

function formatLandmarkToken(id: LandmarkId): string {
  return LANDMARK_GUIDE_ITEM_BY_ID[id].token
}

function formatLandmarkCopy(id: LandmarkId): LandmarkLabelCopy {
  return { id, label: formatLandmarkLabel(id), token: formatLandmarkToken(id) }
}

function countCompletedRequiredLandmarks(session: WorkflowPanelLandmarkSession): number {
  return REQUIRED_LANDMARK_IDS.filter((id) => session.completed[id] !== undefined).length
}

export function resolveWorkflowPanelLandmarkGuidance(input: {
  nodeId: string
  activeNodeId: string | null
  session?: WorkflowPanelLandmarkSession
}): WorkflowPanelLandmarkGuidance {
  const isActive = input.activeNodeId === input.nodeId && input.session?.nodeId === input.nodeId

  if (!isActive || !input.session) {
    return {
      isActive: false,
      currentLabel: 'Landmarks',
      currentToken: '•',
      progressLabel: 'Waiting for the workflow to pause here.',
      remainingLabel: 'Run the workflow to start guided landmark capture.',
      remainingLandmarks: REQUIRED_LANDMARK_IDS.map(formatLandmarkCopy),
      instruction: 'When this step is active, Modly will guide you through five mesh clicks.',
      continueLabel: 'Continue workflow',
      continueDisabled: true,
      placedLandmarks: [],
    }
  }

  const session = input.session

  const completedCount = countCompletedRequiredLandmarks(session)
  const totalCount = REQUIRED_LANDMARK_IDS.length
  const remainingLabel = session.validity.missing.length === 0
    ? 'All required landmarks are marked. You can continue.'
    : `Still needed: ${session.validity.missing.map(formatLandmarkLabel).join(', ')}`
  const remainingLandmarks = session.validity.missing.map(formatLandmarkCopy)

  return {
    isActive: true,
    currentLabel: formatLandmarkLabel(session.activeLandmarkId),
    currentToken: formatLandmarkToken(session.activeLandmarkId),
    progressLabel: `${completedCount} of ${totalCount} landmarks marked`,
    remainingLabel,
    remainingLandmarks,
    instruction: 'Click the mesh in the 3D viewer to place this point. To re-mark a point, click the same landmark again in the viewer.',
    continueLabel: session.canContinue ? 'Continue workflow' : 'Finish all landmarks to continue',
    continueDisabled: !session.canContinue,
    placedLandmarks: REQUIRED_LANDMARK_IDS
      .filter((id) => session.completed[id] !== undefined)
      .map(formatLandmarkCopy),
    error: session.error,
  }
}

export function resolveWorkflowRunPrimaryAction(input: {
  runState: Pick<WorkflowRunState, 'status' | 'blockStep' | 'substitutionPoint'>
  activeNodeId: string | null
  landmarkSession?: WorkflowPanelLandmarkSession
  hasRunValidationIssue: boolean
}): WorkflowRunPrimaryAction {
  const pausedLandmarksNodeId = input.runState.status === 'paused' && input.runState.blockStep === 'Paused — mark required landmarks'
    ? input.runState.substitutionPoint?.nodeId
    : undefined

  if (pausedLandmarksNodeId && input.activeNodeId === pausedLandmarksNodeId && input.landmarkSession?.nodeId === pausedLandmarksNodeId) {
    return {
      kind: 'continue-landmarks',
      label: input.landmarkSession.canContinue ? 'Continue workflow' : 'Finish all landmarks to continue',
      disabled: !input.landmarkSession.canContinue,
    }
  }

  if (input.runState.status === 'running' || input.runState.status === 'paused') {
    return { kind: 'stop', label: 'Stop', disabled: false }
  }

  return { kind: 'generate', label: 'Generate 3D Model', disabled: input.hasRunValidationIssue }
}

export function resolveWorkflowRunLandmarkClearAction(input: {
  runState: Pick<WorkflowRunState, 'status' | 'blockStep' | 'substitutionPoint'>
  landmarkSession?: WorkflowPanelLandmarkSession
}): WorkflowRunLandmarkClearAction | undefined {
  const pausedLandmarksNodeId = input.runState.status === 'paused' && input.runState.blockStep === 'Paused — mark required landmarks'
    ? input.runState.substitutionPoint?.nodeId
    : undefined
  if (!pausedLandmarksNodeId || input.landmarkSession?.nodeId !== pausedLandmarksNodeId) return undefined
  if (countCompletedRequiredLandmarks(input.landmarkSession) === 0) return undefined
  return { kind: 'clear-landmarks', nodeId: pausedLandmarksNodeId, disabled: false }
}

export function executeWorkflowRunPrimaryAction(
  action: WorkflowRunPrimaryAction,
  handlers: { generate: () => void; cancel: () => void; continueRun: () => void },
): void {
  if (action.disabled) return
  if (action.kind === 'continue-landmarks') {
    handlers.continueRun()
    return
  }
  if (action.kind === 'stop') {
    handlers.cancel()
    return
  }
  handlers.generate()
}

export function executeWorkflowLandmarkGuidanceAction(
  action: WorkflowLandmarkGuidanceAction,
  handlers: { continueRun: () => void; resetLandmarks: (nodeId: string) => void },
): void {
  if (action.disabled) return
  if (action.kind === 'clear-landmarks') {
    handlers.resetLandmarks(action.nodeId)
    return
  }
  handlers.continueRun()
}

export function WorkflowRunFooter({
  primaryAction,
  landmarkClearAction,
  runState,
  runValidationIssue,
  isRunning,
  onGenerate,
  onCancel,
  onContinueRun,
  onResetLandmarks,
}: {
  primaryAction: WorkflowRunPrimaryAction
  landmarkClearAction?: WorkflowRunLandmarkClearAction
  runState: WorkflowRunState
  runValidationIssue: { message: string } | null
  isRunning: boolean
  onGenerate: () => void
  onCancel: () => void
  onContinueRun: () => void
  onResetLandmarks?: (nodeId: string) => void
}) {
  const handlers = { generate: onGenerate, cancel: onCancel, continueRun: onContinueRun }
  const buttonClass = primaryAction.kind === 'stop'
    ? 'w-full py-2.5 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors'
    : primaryAction.kind === 'continue-landmarks'
      ? 'w-full py-2.5 rounded-lg text-sm font-semibold bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-950 transition-colors'
      : 'w-full py-2.5 rounded-lg text-sm font-semibold bg-accent hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors'

  return (
    <div className="shrink-0 px-4 pt-3 pb-4 border-t border-zinc-800 flex flex-col gap-2">
      <WorkflowRunFeedback runState={runState} runValidationIssue={runValidationIssue} isRunning={isRunning} />
      <button
        onClick={() => executeWorkflowRunPrimaryAction(primaryAction, handlers)}
        disabled={primaryAction.disabled}
        className={buttonClass}
      >
        {primaryAction.label}
      </button>
      {landmarkClearAction && (
        <button
          type="button"
          onClick={() => executeWorkflowLandmarkGuidanceAction(landmarkClearAction, {
            continueRun: onContinueRun,
            resetLandmarks: (nodeId) => onResetLandmarks?.(nodeId),
          })}
          disabled={landmarkClearAction.disabled}
          className="w-full py-2 rounded-lg text-xs font-semibold border border-zinc-700 text-zinc-300 hover:border-amber-400/60 hover:text-amber-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Clear landmarks
        </button>
      )}
    </div>
  )
}

function normalizeWorkflowRunError(error?: string): string {
  return error?.replace(/^Error:\s*/, '').trim() ?? ''
}

export function resolveWorkflowRunErrorCopy(error?: string): WorkflowRunErrorCopy | null {
  const normalizedError = normalizeWorkflowRunError(error)

  if (!normalizedError) return null

  if (/prompt is required/i.test(normalizedError)) {
    return {
      title: 'Prompt required',
      detail: 'Add text in the workflow prompt field before generating.',
    }
  }

  if (/Missing workflow capability input metadata/i.test(normalizedError)) {
    return {
      title: 'Capability metadata is incomplete',
      detail: 'Modly cannot tell whether this model expects text or an image.',
    }
  }

  if (/Unsupported workflow capability input/i.test(normalizedError)) {
    return {
      title: 'Unsupported model mode',
      detail: 'This Generate panel only supports models that start from text or image inputs.',
    }
  }

  return {
    title: 'Workflow run failed',
    detail: normalizedError,
  }
}

export function WorkflowRunFeedback({
  runState,
  runValidationIssue,
  isRunning,
}: {
  runState: WorkflowRunState
  runValidationIssue: { message: string } | null
  isRunning: boolean
}) {
  if (!isRunning) {
    const runErrorCopy = resolveWorkflowRunErrorCopy(runState.error)

    if (runErrorCopy) {
      return (
        <div className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-red-950/40 border border-red-800/50">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0 mt-0.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] text-red-300 font-semibold">{runErrorCopy.title}</span>
            <span className="text-[10px] text-red-400 font-medium">{runErrorCopy.detail}</span>
          </div>
        </div>
      )
    }
  }

  if (runValidationIssue && !isRunning) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-red-950/40 border border-red-800/50">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span className="text-[10px] text-red-400 font-medium">{runValidationIssue.message}</span>
      </div>
    )
  }

  return null
}

// ─── Workflow dropdown ────────────────────────────────────────────────────────

function WorkflowDropdown({ workflows, value, onChange }: {
  workflows: Workflow[]
  value:     string | null
  onChange:  (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected        = workflows.find((w) => w.id === value)

  if (workflows.length === 0) {
    return (
      <div className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-600 text-xs">
        No workflows yet
      </div>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-900 border text-left transition-colors ${open ? 'border-zinc-600' : 'border-zinc-800 hover:border-zinc-700'}`}
      >
        <span className="text-xs font-medium text-zinc-200 truncate">
          {selected?.name ?? 'Select a workflow…'}
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`shrink-0 ml-2 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 right-0 z-50 rounded-lg bg-zinc-900 border border-zinc-700 shadow-xl overflow-hidden">
          {workflows.map((wf, i) => (
            <button key={wf.id} onClick={() => { onChange(wf.id); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors
                ${i > 0 ? 'border-t border-zinc-800' : ''}
                ${wf.id === value ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/60'}`}>
              <span className="flex-1 truncate">{wf.name}</span>
              <span className="text-[9px] text-zinc-600 shrink-0">
                {wf.nodes.filter((n) => n.type === 'extensionNode').length} nodes
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Node param rows ──────────────────────────────────────────────────────────
// These components receive nodes + onPatch directly from EmbeddedCanvas
// to avoid relying on the React Flow store (which requires a mounted <ReactFlow>).

type PatchFn = (nodeId: string, patch: Record<string, unknown>) => void

function ImageParamRow({ nodeId, nodes, onPatch }: { nodeId: string; nodes: FlowNode[]; onPatch: PatchFn }) {
  const node     = nodes.find((n) => n.id === nodeId)
  const data     = node?.data as { params: Record<string, unknown> } | undefined
  const preview  = data?.params.preview as string | undefined

  const browse = useCallback(async () => {
    const p = await window.electron.fs.selectImage()
    if (!p) return
    const base64 = await window.electron.fs.readFileBase64(p)
    const src = `data:${mimeFromPath(p)};base64,${base64}`
    onPatch(nodeId, { params: { ...(data?.params ?? {}), filePath: p, preview: src } })
  }, [nodeId, data?.params, onPatch])

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <span className="text-[11px] font-medium text-zinc-300">Image</span>
      </div>
      {preview ? (
        <button onClick={browse} className="relative w-full aspect-square rounded-lg overflow-hidden border border-zinc-700 group">
          <img src={preview} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center">
            <span className="text-[10px] text-white font-medium opacity-0 group-hover:opacity-100 transition-opacity">Change…</span>
          </div>
        </button>
      ) : (
        <button onClick={browse}
          className="w-full aspect-square flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700 hover:border-sky-500/50 hover:bg-sky-500/5 transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          <span className="text-[10px] text-zinc-500">Browse image…</span>
        </button>
      )}
    </div>
  )
}

function MeshParamRow({ nodeId, nodes, onPatch }: { nodeId: string; nodes: FlowNode[]; onPatch: PatchFn }) {
  const node     = nodes.find((n) => n.id === nodeId)
  const data     = node?.data as { params: Record<string, unknown> } | undefined
  const source   = (data?.params.source as 'file' | 'current' | undefined) ?? 'file'
  const fileName = data?.params.fileName as string | undefined

  const browse = useCallback(async () => {
    const p = await window.electron.fs.selectMeshFile()
    if (!p) return
    const name = p.split(/[\\/]/).pop() ?? p
    onPatch(nodeId, { params: { ...(data?.params ?? {}), filePath: p, fileName: name, source: 'file' } })
  }, [nodeId, data?.params, onPatch])

  const toggleSource = useCallback(() => {
    const next = source === 'file' ? 'current' : 'file'
    onPatch(nodeId, { params: { ...(data?.params ?? {}), source: next } })
  }, [nodeId, data?.params, source, onPatch])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        <span className="text-[11px] font-medium text-zinc-300">Load 3D Mesh</span>
      </div>

      {/* Toggle: use current model */}
      <button onClick={toggleSource} className="flex items-center gap-2 w-full text-left">
        <div className={`w-7 h-4 rounded-full relative shrink-0 transition-colors ${source === 'current' ? 'bg-violet-500' : 'bg-zinc-700'}`}>
          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${source === 'current' ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </div>
        <span className="text-[10px] text-zinc-400">Use current model</span>
      </button>

      {source === 'file' ? (
        fileName ? (
          <button onClick={browse}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors group">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" className="shrink-0">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <span className="text-[10px] text-zinc-300 truncate flex-1 text-left">{fileName}</span>
            <span className="text-[9px] text-zinc-500 group-hover:text-zinc-400 shrink-0">Change…</span>
          </button>
        ) : (
          <button onClick={browse}
            className="w-full flex items-center justify-center gap-2 py-5 rounded-lg border border-dashed border-zinc-700 hover:border-violet-500/50 hover:bg-violet-500/5 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <span className="text-[10px] text-zinc-500">Browse mesh…</span>
          </button>
        )
      ) : (
        <div className="px-2.5 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/40">
          <span className="text-[10px] text-zinc-500">Uses the model currently loaded in the 3D viewer</span>
        </div>
      )}
    </div>
  )
}

function TextParamRow({ nodeId, nodes, onPatch }: { nodeId: string; nodes: FlowNode[]; onPatch: PatchFn }) {
  const node = nodes.find((n) => n.id === nodeId)
  const data = node?.data as { params: Record<string, unknown> } | undefined
  const text = (data?.params.text as string | undefined) ?? ''

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2">
          <path d="M17 6.1H3M21 12.1H3M15.1 18H3"/>
        </svg>
        <span className="text-[11px] font-medium text-zinc-300">Text</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => onPatch(nodeId, { params: { ...(data?.params ?? {}), text: e.target.value } })}
        placeholder="Enter text…" rows={3}
        className="w-full bg-zinc-800 border border-zinc-700/80 rounded-md px-2.5 py-2 text-[11px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-500/40 resize-none leading-relaxed"
      />
    </div>
  )
}

export function ArtifactHistoryDisclosure({
  rows,
  defaultExpanded = false,
  isWaitCheckpoint = true,
}: {
  rows: ArtifactHistoryRow[]
  defaultExpanded?: boolean
  isWaitCheckpoint?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  if (!isWaitCheckpoint) return null

  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/45 px-2.5 py-2">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <span className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[10px] font-semibold text-zinc-300">Artifact history</span>
          <span className="text-[10px] text-zinc-500 leading-relaxed">Review the checkpoint artifact before you continue.</span>
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`shrink-0 text-zinc-600 transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {expanded && (
        rows.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1.5">
            {rows.map((row) => (
              <div key={`${row.kind}-${row.artifact?.id ?? row.label}-${row.artifact?.versionId ?? row.status ?? 'row'}`} className="rounded-md bg-zinc-950/40 border border-zinc-800/60 px-2 py-1.5">
                <p className="text-[10px] font-medium text-zinc-300">{row.label}</p>
                <p className="mt-0.5 text-[10px] text-zinc-500 leading-relaxed">{row.description}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[10px] text-zinc-500 leading-relaxed">No artifact history yet.</p>
        )
      )}
    </div>
  )
}

export function deriveWaitParamRowArtifactHistoryRows(input: {
  waitNodeId: string
  nodeArtifacts: Record<string, ArtifactRef>
  artifactLineages: Record<string, ArtifactLineage>
  substitutionPoint?: ArtifactSubstitutionPoint
  runArtifact?: ArtifactRef
  replacementResult?: ArtifactReplacementResult
  pendingReplacement?: ArtifactRef
  landmarkSidecar?: LandmarkSidecarLineageMetadata
}): ArtifactHistoryRow[] {
  return deriveArtifactHistoryRows(input)
}

function WaitParamRow({ nodeId }: { nodeId: string }) {
  const runState           = useWorkflowRunStore((s) => s.runState)
  const activeNodeId       = useWorkflowRunStore((s) => s.activeNodeId)
  const continueRun        = useWorkflowRunStore((s) => s.continueRun)
  const pendingReplacement = useWorkflowRunStore((s) => s.pendingReplacement)
  const nodeArtifacts      = useWorkflowRunStore((s) => s.nodeArtifacts)
  const artifactLineages   = useWorkflowRunStore((s) => s.artifactLineages)
  const landmarkSidecars   = useWorkflowRunStore((s) => s.landmarkSidecars)
  const checkpointUi          = resolveWaitCheckpointUiState({ nodeId, activeNodeId, runState, pendingReplacement })
  const artifactHistoryRows = deriveWaitParamRowArtifactHistoryRows({
    waitNodeId: nodeId,
    nodeArtifacts,
    artifactLineages,
    substitutionPoint: runState.substitutionPoint,
    runArtifact: runState.artifact,
    replacementResult: runState.replacementResult,
    pendingReplacement,
    landmarkSidecar: landmarkSidecars[nodeId],
  })

  const handleContinue = useCallback(() => {
    continueRun()
  }, [continueRun])

  const handleContinueWithReplacement = useCallback(() => {
    if (!pendingReplacement) return
    continueRun({ replacementArtifact: pendingReplacement })
  }, [continueRun, pendingReplacement])

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <span className="text-[11px] font-medium text-zinc-300">Wait</span>
      </div>
      {checkpointUi.isPaused ? (
        <div className="flex flex-col gap-1.5">
          {checkpointUi.isCheckpoint && (
            <div className="px-2.5 py-2 rounded-md bg-amber-500/10 border border-amber-500/25">
              <p className="text-[9px] uppercase tracking-wide text-amber-300 font-semibold">{checkpointUi.statusLabel}</p>
              <p className="mt-0.5 text-[10px] text-zinc-400 leading-relaxed">{checkpointUi.description}</p>
            </div>
          )}
          <button
            onClick={handleContinue}
            className="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 transition-colors text-[11px] font-medium animate-pulse"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            {checkpointUi.normalContinueLabel}
          </button>
          {checkpointUi.showSubstitutedContinue && (
            <button
              onClick={handleContinueWithReplacement}
              className="w-full px-2.5 py-2 rounded-md bg-violet-500/15 border border-violet-500/30 text-violet-200 hover:bg-violet-500/25 transition-colors text-[11px] font-medium"
            >
              {checkpointUi.substitutedContinueLabel}
            </button>
          )}
          <ArtifactHistoryDisclosure rows={artifactHistoryRows} />
        </div>
      ) : (
        <>
          <p className="text-[10px] text-zinc-600 italic px-0.5">
            {checkpointUi.description}
          </p>
          {artifactHistoryRows.length > 0 && (
            <ArtifactHistoryDisclosure rows={artifactHistoryRows} />
          )}
        </>
      )}
      {checkpointUi.rejectionCopy && (
        <p className="text-[10px] text-zinc-500 leading-relaxed px-0.5">
          {checkpointUi.rejectionCopy}
        </p>
      )}
    </div>
  )
}

export function WorkflowLandmarkGuidance({
  nodeId,
  activeNodeId,
  session,
  onContinue,
  onReset,
  onSelectLandmark,
}: {
  nodeId: string
  activeNodeId: string | null
  session?: WorkflowPanelLandmarkSession
  onContinue?: () => void
  onReset?: () => void
  onSelectLandmark?: (id: LandmarkId) => void
}) {
  const guidance = resolveWorkflowPanelLandmarkGuidance({ nodeId, activeNodeId, session })

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2">
          <path d="M12 2v20"/><path d="M5 9h14"/><path d="M7 16h10"/>
        </svg>
        <span className="text-[11px] font-medium text-zinc-300">Landmarks</span>
      </div>

      {guidance.isActive ? (
        <div className="flex flex-col gap-1.5">
          <div className="px-2.5 py-2 rounded-md bg-amber-500/10 border border-amber-500/25">
            <p className="text-[9px] uppercase tracking-wide text-amber-300 font-semibold">Mark: <span className="inline-flex items-center justify-center min-w-5 rounded-full bg-amber-400/20 px-1 text-amber-100">{guidance.currentToken}</span> {guidance.currentLabel}</p>
            <p className="mt-0.5 text-[10px] text-zinc-400 leading-relaxed">{guidance.instruction}</p>
            <p className="mt-1 text-[10px] text-zinc-300 font-medium">{guidance.progressLabel}</p>
            <p className="mt-0.5 text-[10px] text-zinc-500 leading-relaxed">{guidance.remainingLabel}</p>
            {guidance.remainingLandmarks.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                <span className="text-[9px] uppercase tracking-wide text-zinc-500 font-semibold">Next points</span>
                {guidance.remainingLandmarks.map((landmark) => (
                  <span key={landmark.id} className="rounded-full border border-zinc-700/70 px-1.5 py-0.5 text-[9px] text-zinc-300">
                    {landmark.token} {landmark.label}
                  </span>
                ))}
              </div>
            )}
          </div>

          {guidance.error && (
            <p className="px-2.5 py-1.5 rounded-md bg-red-950/40 border border-red-800/50 text-[10px] text-red-300 leading-relaxed">
              {guidance.error}
            </p>
          )}

          {guidance.placedLandmarks.length > 0 && (
            <div className="rounded-md border border-zinc-800/70 bg-zinc-950/30 px-2.5 py-2">
              <p className="text-[9px] uppercase tracking-wide text-zinc-500 font-semibold">Placed landmarks</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {guidance.placedLandmarks.map((landmark) => (
                  <button
                    key={landmark.id}
                    type="button"
                    onClick={() => onSelectLandmark?.(landmark.id)}
                    className="rounded-md border border-zinc-700/70 px-2 py-1 text-[10px] font-medium text-zinc-300 hover:border-amber-400/50 hover:text-amber-200 transition-colors"
                  >
                    Re-mark {landmark.token} {landmark.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => executeWorkflowLandmarkGuidanceAction({ kind: 'continue-landmarks', disabled: guidance.continueDisabled }, {
              continueRun: onContinue ?? (() => {}),
              resetLandmarks: () => {},
            })}
            disabled={guidance.continueDisabled}
            className="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 disabled:opacity-45 disabled:cursor-not-allowed transition-colors text-[11px] font-medium"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            {guidance.continueLabel}
          </button>

          <button
            type="button"
            onClick={() => executeWorkflowLandmarkGuidanceAction({ kind: 'clear-landmarks', nodeId, disabled: false }, {
              continueRun: () => {},
              resetLandmarks: () => onReset?.(),
            })}
            className="w-full px-2.5 py-1.5 rounded-md border border-zinc-700/70 text-[10px] font-medium text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
          >
            Clear landmarks
          </button>
        </div>
      ) : (
        <p className="text-[10px] text-zinc-600 italic px-0.5 leading-relaxed">
          {guidance.instruction}
        </p>
      )}
    </div>
  )
}

function LandmarksParamRow({ nodeId }: { nodeId: string }) {
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)
  const landmarkSession = useWorkflowRunStore((s) => s.landmarkSession)
  const continueRun = useWorkflowRunStore((s) => s.continueRun)
  const resetLandmarks = useWorkflowRunStore((s) => s.resetLandmarks)
  const selectLandmarkForEditing = useWorkflowRunStore((s) => s.selectLandmarkForEditing)

  const handleContinue = useCallback(() => {
    continueRun()
  }, [continueRun])

  const handleReset = useCallback(() => {
    resetLandmarks(nodeId)
  }, [nodeId, resetLandmarks])

  return (
    <WorkflowLandmarkGuidance
      nodeId={nodeId}
      activeNodeId={activeNodeId}
      session={landmarkSession}
      onContinue={handleContinue}
      onReset={handleReset}
      onSelectLandmark={selectLandmarkForEditing}
    />
  )
}

function ExtensionParamRow({ nodeId, ext, nodes, onPatch }: { nodeId: string; ext: WorkflowExtension; nodes: FlowNode[]; onPatch: PatchFn }) {
  const [expanded, setExpanded] = useState(true)
  const node    = nodes.find((n) => n.id === nodeId)
  const data    = node?.data as { enabled: boolean; params: Record<string, unknown> } | undefined
  const enabled = data?.enabled ?? true
  const paramSections = partitionAdvancedParams(ext.params)

  const inputColor  = TYPE_COLOR[ext.input]  ?? '#71717a'
  const outputColor = TYPE_COLOR[ext.output] ?? '#71717a'

  return (
    <div className={`flex flex-col transition-opacity ${enabled ? '' : 'opacity-40'}`}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-medium text-zinc-200 truncate">{ext.name}</p>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[9px]" style={{ color: inputColor }}>{ext.input}</span>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600">
              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>
            <span className="text-[9px]" style={{ color: outputColor }}>{ext.output}</span>
          </div>
        </div>

        {/* Toggle enabled */}
        <button onClick={() => onPatch(nodeId, { enabled: !enabled })}
          className="relative shrink-0" style={{ width: 26, height: 15 }}>
          <span className={`absolute inset-0 rounded-full transition-colors ${enabled ? 'bg-accent/70' : 'bg-zinc-700'}`} />
          <span className={`absolute top-[1.5px] w-3 h-3 rounded-full bg-white shadow transition-all ${enabled ? 'left-[11px]' : 'left-[1.5px]'}`} />
        </button>

        {ext.params.length > 0 && (
          <button onClick={() => setExpanded((v) => !v)}
            className="p-0.5 rounded text-zinc-600 hover:text-zinc-400 transition-colors">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        )}
      </div>

      {expanded && ext.params.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {paramSections.basic.map((param) => {
            const val = ((data?.params[param.id] ?? param.default) as boolean | number | string)
            return (
              <div key={param.id} className="flex items-start gap-2 min-w-0">
                <label className="text-[10px] text-zinc-500 w-20 shrink-0 truncate leading-tight">{param.label}</label>
                <div className="min-w-0 flex-1">
                  <WorkflowParamControl param={param} value={val}
                    onChange={(v) => onPatch(nodeId, { params: { ...(data?.params ?? {}), [param.id]: v } })} />
                </div>
              </div>
            )
          })}
          <AdvancedOptionsSection>
            {paramSections.advanced.map((param) => {
              const val = ((data?.params[param.id] ?? param.default) as boolean | number | string)
              return (
                <div key={param.id} className="flex items-start gap-2 min-w-0">
                  <label className="text-[10px] text-zinc-500 w-20 shrink-0 truncate leading-tight">{param.label}</label>
                  <div className="min-w-0 flex-1">
                    <WorkflowParamControl param={param} value={val}
                      onChange={(v) => onPatch(nodeId, { params: { ...(data?.params ?? {}), [param.id]: v } })} />
                  </div>
                </div>
              )
            })}
          </AdvancedOptionsSection>
        </div>
      )}
    </div>
  )
}

// ─── Embedded canvas ──────────────────────────────────────────────────────────

function EmbeddedCanvas({ workflow, allExtensions }: {
  workflow:      Workflow
  allExtensions: ReturnType<typeof buildAllWorkflowExtensions>
}) {
  const [nodes, setNodes] = useNodesState(toFlowNodes(workflow.nodes))
  const [edges] = useEdgesState(toFlowEdges(workflow.edges))
  const { updateNodeData }               = useReactFlow()
  const { navigate }                     = useNavStore()

  // Direct patch into controlled nodes state — no React Flow store dependency
  const patchNode = useCallback<PatchFn>((nodeId, patch) => {
    setNodes((nds) => nds.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n,
    ))
    // Push params live so a paused/looping run uses the latest values on the next node start.
    if (patch.params) {
      useWorkflowRunStore.getState().setLiveNodeParams(nodeId, patch.params as Record<string, unknown>)
    }
  }, [setNodes])

  const runState = useWorkflowRunStore((s) => s.runState)
  const run = useWorkflowRunStore((s) => s.run)
  const cancel = useWorkflowRunStore((s) => s.cancel)
  const activeNodeId = useWorkflowRunStore((s) => s.activeNodeId)
  const landmarkSession = useWorkflowRunStore((s) => s.landmarkSession)
  const continueRun = useWorkflowRunStore((s) => s.continueRun)
  const resetLandmarks = useWorkflowRunStore((s) => s.resetLandmarks)
  const isRunning = runState.status === 'running' || runState.status === 'paused'

  // Update AddToScene node when run completes
  useEffect(() => {
    if (runState.status !== 'done' || !runState.outputUrl) return
    const out = nodes.find((n) => n.type === 'outputNode')
    if (out) updateNodeData(out.id, { params: { outputUrl: runState.outputUrl } })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to run completion; nodes/updateNodeData read at that point
  }, [runState.status, runState.outputUrl])

  const runValidationIssue = useMemo(() => validateWorkflowProcessRun({
    nodes: toWorkflowNodes(nodes),
    edges: toWorkflowEdges(edges),
    allExtensions,
  }), [nodes, edges, allExtensions])

  // Ordered nodes for params list — only those marked showInGenerate
  const sortedNodes = useMemo(
    () => topoSortNodes(toWorkflowNodes(nodes), toWorkflowEdges(edges)),
    [nodes, edges],
  )

  const paramNodes = sortedNodes.filter((n) =>
    (n.type === 'imageNode' || n.type === 'textNode' || n.type === 'meshNode' || n.type === 'extensionNode' || n.type === 'waitNode' || n.type === 'landmarksNode')
    && (n.data as { showInGenerate?: boolean }).showInGenerate === true,
  )

  const handleGenerate = useCallback(() => {
    const wf: Workflow = { ...workflow, nodes: toWorkflowNodes(nodes), edges: toWorkflowEdges(edges) }
    run(wf, allExtensions)
  }, [firstPreflightIssue, nodes, edges, workflow, allExtensions, run, showToast])

  const primaryAction = resolveWorkflowRunPrimaryAction({
    runState,
    activeNodeId,
    landmarkSession,
    hasRunValidationIssue: Boolean(runValidationIssue),
  })
  const landmarkClearAction = resolveWorkflowRunLandmarkClearAction({ runState, landmarkSession })

  return (
    <div className="flex flex-col flex-1 min-h-0">

      {/* Params list */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 flex flex-col gap-4">
        {paramNodes.map((node, i) => {
          const isLast = i === paramNodes.length - 1
          return (
            <div key={node.id}>
              {node.type === 'imageNode' && <ImageParamRow nodeId={node.id} nodes={nodes} onPatch={patchNode} />}
              {node.type === 'textNode'  && <TextParamRow  nodeId={node.id} nodes={nodes} onPatch={patchNode} />}
              {node.type === 'meshNode'  && <MeshParamRow  nodeId={node.id} nodes={nodes} onPatch={patchNode} />}
              {node.type === 'waitNode'  && <WaitParamRow  nodeId={node.id} />}
              {node.type === 'landmarksNode' && <LandmarksParamRow nodeId={node.id} />}
              {node.type === 'extensionNode' && (() => {
                const ext = getWorkflowExtension(node.data.extensionId ?? '', allExtensions)
                return ext ? <ExtensionParamRow nodeId={node.id} ext={ext} nodes={nodes} onPatch={patchNode} /> : null
              })()}
              {!isLast && <div className="mt-4 border-t border-zinc-800/60" />}
            </div>
          )
        })}

        {paramNodes.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-8 px-2">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-700">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
            <p className="text-[11px] text-zinc-600 text-center leading-relaxed">
              No nodes pinned to Generate.<br/>
              Click the <span className="text-zinc-400">eye icon</span> on a node in the workflow editor.
            </p>
            <button onClick={() => navigate('workflows')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-zinc-200 text-[10px] font-medium transition-colors">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Open workflow editor
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <WorkflowRunFooter
        primaryAction={primaryAction}
        landmarkClearAction={landmarkClearAction}
        runState={runState}
        runValidationIssue={runValidationIssue}
        isRunning={isRunning}
        onGenerate={handleGenerate}
        onCancel={cancel}
        onContinueRun={continueRun}
        onResetLandmarks={resetLandmarks}
      />
    </div>
  )
}

// ─── Mode toggle ──────────────────────────────────────────────────────────────

function ModeToggle({ mode, onChange }: { mode: PanelMode; onChange: (m: PanelMode) => void }): JSX.Element {
  return (
    <div className="shrink-0 px-3 pt-3 pb-2.5">
      <div className="flex bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
        {(['basic', 'chat'] as PanelMode[]).map((m) => (
          <button
            key={m}
            onClick={() => onChange(m)}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
              mode === m
                ? 'bg-zinc-700 text-zinc-100 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export default function WorkflowPanel() {
  const { workflows, load, activeId } = useWorkflowsStore()
  const { modelExtensions, processExtensions } = useExtensionsStore()
  const loadExtensions         = useExtensionsStore((s) => s.loadExtensions)
  const { navigate }           = useNavStore()
  const [selectedId, setSelectedId] = useState<string | null>(activeId)
  const [mode, setMode]             = useState<PanelMode>('basic')

  const allExtensions = useMemo(
    () => buildAllWorkflowExtensions(modelExtensions, processExtensions),
    [modelExtensions, processExtensions],
  )

  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  useEffect(() => { load(); loadExtensions() }, [])

  // Sync when navigated here from the workflow editor (activeId set externally)
  useEffect(() => {
    if (activeId) setSelectedId(activeId)
  }, [activeId])

  useEffect(() => {
    if (!selectedId && workflows.length > 0) setSelectedId(workflows[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- default selection reacts to workflows list only
  }, [workflows])

  const workflow = workflows.find((w) => w.id === selectedId) ?? null

  return (
    <div className="flex flex-col flex-1 min-h-0">

      {/* Mode toggle */}
      <ModeToggle mode={mode} onChange={setMode} />

      {mode === 'chat' ? (
        <>
          <div className="shrink-0 h-px bg-zinc-800" />
          <ChatPanel />
        </>
      ) : (
        <>
          {/* Header */}
          <div className="shrink-0 px-4 pt-2.5 pb-3 border-b border-zinc-800 flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Workflow</h2>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <WorkflowDropdown workflows={workflows} value={selectedId} onChange={setSelectedId} />
              </div>
              {selectedId && (
                <button
                  onClick={() => { useWorkflowsStore.getState().setActive(selectedId!); navigate('workflows') }}
                  title="Edit workflow"
                  className="shrink-0 p-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 text-zinc-400
                             hover:text-zinc-100 hover:bg-zinc-700 hover:border-zinc-600 transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Canvas or empty state */}
          {workflow ? (
            <ReactFlowProvider>
              <EmbeddedCanvas
                key={workflow.id}
                workflow={workflow}
                allExtensions={allExtensions}
              />
            </ReactFlowProvider>
          ) : (
            <div className="flex-1 flex items-center justify-center px-6">
              <p className="text-xs text-zinc-600 text-center leading-relaxed">
                No workflows yet.<br/>Create one in the Workflows tab.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
