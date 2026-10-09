import type { HumanoidDraftSidecarReadResult, HumanoidDraftSidecarV1, HumanoidPromotionSidecarReadResult, HumanoidPromotionSidecarV1, RigMetaSidecarReadResult } from '../../shared/types/electron.d'
import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import type { GenerationJob } from '../../shared/stores/appStore.ts'
import { resolveViewerAssetTarget } from '../generate/viewerAssetTarget.ts'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import type { Workflow, WFEdge, WFNode } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions'
import { resolveWorkflowDispatch } from './workflowDispatch.ts'
import { artifactRefToLegacyOutput, legacyOutputToArtifactRef } from './workflowArtifacts.ts'
import React from 'react'
import { useStore } from 'zustand'

type WorkflowRunStore = typeof import('./workflowRunStore').useWorkflowRunStore

type AxiosClientMock = {
  post: (path: string, data?: unknown, config?: unknown) => Promise<unknown>
  get: (path: string) => Promise<unknown>
}
type RunProcessCall = {
  extensionId: string
  input: unknown
  params: Record<string, unknown>
}

// Execute the current store, preserving upstream alias imports, with only its
// host boundaries replaced. No HTTP, Electron, filesystem reads or model runs.
const storeBundle = (await build({
  stdin: { contents: "export * from './workflowRunStore.ts'; export { useWorldsSceneStore } from '../worlds/worldsSceneStore.ts'", resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'dispatch-fixture.ts', loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'inert-dispatch-adapters', setup(builder) {
    builder.onResolve({ filter: /^(axios|@shared\/stores\/appStore|\.\.\/\.\.\/shared\/stores\/appStore\.ts|@shared\/utils\/notification)$/ }, (args) => ({ path: args.path, namespace: 'inert' }))
    builder.onLoad({ filter: /.*/, namespace: 'inert' }, ({ path: id }) => ({ loader: 'ts', contents: id === 'axios'
      ? 'export default { create: () => globalThis.fixture.client }'
      : /appStore(?:\.ts)?$/.test(id) ? 'export const useAppStore = { getState: () => globalThis.fixture.app }'
      : 'export const showCompletionNotification = () => {}; export const showErrorNotification = () => {}' }))
  } }],
})).outputFiles[0].text

let buildModelGenerationRequest: typeof import('./workflowRunStore').buildModelGenerationRequest
let shouldUsePreviousNodeFallback: typeof import('./workflowRunStore').shouldUsePreviousNodeFallback
let useWorldsSceneStore: typeof import('../worlds/worldsSceneStore.ts').useWorldsSceneStore
let useWorkflowRunStore: WorkflowRunStore
let axiosClientMock: AxiosClientMock
let runProcessCalls: RunProcessCall[]
let fsReadCalls: string[]
let iteratorFileNames: string[]
let workspaceDir: string
let onProcessRun: ((call: RunProcessCall) => void) | undefined
let processResult: ((call: RunProcessCall) => Promise<unknown>) | undefined
let writeSidecar: (input: any) => Promise<any>
let sidecarWrites: any[]
let readFile: ((filePath: string) => Promise<string>) | undefined
let settingsGet: (() => Promise<{ workspaceDir: string }>) | undefined
let appState: {
  apiUrl: string
  selectedImagePath: string | undefined
  selectedImageData: string | undefined
  currentJob: Record<string, unknown> | null
  setCurrentJob(value: Record<string, unknown>): void
  updateCurrentJob(value: Record<string, unknown>): void
}

let humanoidDraftReadCalls: Array<{ meshWorkspacePath: string }>
let humanoidPromotionReadCalls: Array<{ meshWorkspacePath: string }>
let rigMetaReadCalls: Array<{ sourceWorkspacePath: string }>
let humanoidDraftReadResult: HumanoidDraftSidecarReadResult
let humanoidPromotionReadResult: HumanoidPromotionSidecarReadResult
let rigMetaReadResult: RigMetaSidecarReadResult
let readerPorts: Partial<Window['electron']['workspace']['artifacts']>
const humanoidDraftSidecar = Object.freeze({
  schema: 'modly.humanoid-draft.v1',
  version: 1,
  source: { workspacePath: 'Workflows/generated/avatar-source.glb' },
  output: { workspacePath: 'Workflows/generated/avatar.glb' },
  meshOutputSha256: 'mesh-sha-1',
  rigmetaSha256: 'rigmeta-sha-1',
  draftSha256: 'draft-sha-1',
  trust: { status: 'draft', reasons: ['semantic_trust_failed'], trusted: false },
  provenance: { producer: 'unirig', runId: 'run-1', extensionId: 'unirig', createdAt: '2026-05-22T20:00:00.000Z' },
  assignments: {
    roles: { hips: { boneId: 'bone:hips', label: 'Hips', confidence: 0.88 } },
    chains: { spine: ['bone:hips', 'bone:spine'] },
  },
  confidence: { overall: 0.74 },
  completeness: { requiredRolesMissing: ['head'], score: 0.81 },
  diagnostics: ['Manual review required before Kimodo handoff.'],
} satisfies HumanoidDraftSidecarV1)

const humanoidPromotionSidecar = Object.freeze({
  schema: 'modly.humanoid-promotion.v1',
  version: 1,
  promotionId: 'promotion-1',
  source: { workspacePath: 'Workflows/generated/avatar-source.glb' },
  output: { workspacePath: 'Workflows/generated/avatar.glb' },
  meshOutputSha256: 'mesh-sha-1',
  rigmetaSha256: 'rigmeta-sha-1',
  draftSha256: 'draft-sha-1',
  draftSchema: 'modly.humanoid-draft.v1',
  promotedAssignments: structuredClone(humanoidDraftSidecar.assignments),
  provenance: { basis: 'modly.humanoid-draft.v1', trustStatus: 'manual_confirmed' },
  audit: {
    confirmedBy: 'modly:user:local:tester',
    confirmedByLabel: 'Local Tester',
    createdAt: '2026-05-22T20:10:00.000Z',
    method: 'viewer3d',
    rationale: 'Reviewed the draft manually for downstream manual_confirmed eligibility.',
  },
} satisfies HumanoidPromotionSidecarV1)

beforeEach(() => {
  axiosClientMock = {
    async post() { throw new Error('Unexpected axios.post call') },
    async get() { throw new Error('Unexpected axios.get call') },
  }
  runProcessCalls = []
  fsReadCalls = []
  iteratorFileNames = []
  workspaceDir = '/workspace'
  onProcessRun = undefined
  processResult = undefined
  readFile = undefined
  settingsGet = undefined
  sidecarWrites = []
  writeSidecar = async (input) => { sidecarWrites.push(input); return { success: true, sidecarWorkspacePath: input.sidecarWorkspacePath, sidecar: input.sidecar } }
  appState = {
    apiUrl: 'http://inert.invalid', currentJob: null,
    selectedImagePath: '/tmp/source.png', selectedImageData: Buffer.from('png-bytes').toString('base64'),
    setCurrentJob(value) { this.currentJob = value },
    updateCurrentJob(value) { this.currentJob = { ...this.currentJob, ...value } },
  }
  humanoidDraftReadCalls = []; humanoidPromotionReadCalls = []; rigMetaReadCalls = []
  humanoidDraftReadResult = { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-draft.v1.json' }
  humanoidPromotionReadResult = { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-promotion.v1.json' }
  rigMetaReadResult = { success: true, status: 'not-found', rigMetaWorkspacePath: 'Workflows/generated/avatar.rigmeta.json' }
  readerPorts = {
    readHumanoidDraftSidecar: async (request) => { humanoidDraftReadCalls.push(request); return humanoidDraftReadResult },
    readHumanoidPromotionSidecar: async (request) => { humanoidPromotionReadCalls.push(request); return humanoidPromotionReadResult },
    readRigMetaSidecar: async (request) => { rigMetaReadCalls.push(request); return rigMetaReadResult },
    writeLandmarkSidecar: (input) => writeSidecar(input),
  }
  const fixture = { app: appState, get client() { return axiosClientMock } }
  const window = { electron: {
    settings: { get: async () => settingsGet ? settingsGet() : ({ workspaceDir }) },
    workspace: { artifacts: readerPorts },
    fs: {
      deleteDirectory: async () => ({ success: true }),
      listFiles: async () => iteratorFileNames,
      readFileBase64: async (filePath: string) => {
        fsReadCalls.push(filePath)
        return readFile ? readFile(filePath) : Buffer.from('fs-bytes').toString('base64')
      },
    },
    extensions: { runProcess: async (extensionId: string, input: unknown, params: Record<string, unknown>) => {
      runProcessCalls.push(JSON.parse(JSON.stringify({ extensionId, input, params })))
      onProcessRun?.(runProcessCalls.at(-1)!)
      return processResult ? processResult(runProcessCalls.at(-1)!) : { success: true, result: { filePath: '/workspace/output/process.glb' } }
    } },
  } }
  const module = { exports: {} as { useWorkflowRunStore: WorkflowRunStore; buildModelGenerationRequest: typeof buildModelGenerationRequest; shouldUsePreviousNodeFallback: typeof shouldUsePreviousNodeFallback; useWorldsSceneStore: typeof useWorldsSceneStore } }
  vm.runInNewContext(storeBundle, {
    module, exports: module.exports, require: createRequire(import.meta.url), fixture, window,
    process, console, crypto, Blob, FormData, atob, URL, fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    // Polling delay is inert; each client is a bounded in-memory fixture.
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay === 5000 ? delay : 0), clearTimeout, TextDecoder,
  })
  useWorkflowRunStore = module.exports.useWorkflowRunStore
  buildModelGenerationRequest = module.exports.buildModelGenerationRequest
  shouldUsePreviousNodeFallback = module.exports.shouldUsePreviousNodeFallback
  useWorldsSceneStore = module.exports.useWorldsSceneStore
})

function createExtensionNode(extensionId: string): WFNode {
  return {
    id: 'node-1',
    type: 'extensionNode',
    position: { x: 0, y: 0 },
    data: {
      extensionId,
      enabled: true,
      params: {},
    },
  }
}

function createWorkflowExtension(overrides: Partial<WorkflowExtension>): WorkflowExtension {
  return {
    id: 'ext/image-to-mesh',
    extensionId: 'ext',
    extensionName: 'Extension',
    extensionAuthor: 'Tests',
    nodeId: 'image-to-mesh',
    name: 'Image To Mesh',
    description: 'Test extension',
    input: 'image',
    output: 'mesh',
    params: [],
    builtin: false,
    type: 'model',
    ...overrides,
  }
}

function createNamedImageModelExtension(overrides: Partial<WorkflowExtension> = {}): WorkflowExtension {
  return createWorkflowExtension({
    id: 'multi/image-to-mesh',
    extensionId: 'multi',
    nodeId: 'image-to-mesh',
    type: 'model',
    input: 'image',
    output: 'mesh',
    inputs: [
      { name: 'front', type: 'image', required: true },
      { name: 'left', type: 'image', required: false },
      { name: 'back', type: 'image', required: false },
      { name: 'right', type: 'image', required: false },
    ],
    ...overrides,
  })
}

function createNode(id: string, type: WFNode['type'], data: WFNode['data'] = { enabled: true, params: {} }): WFNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
  }
}

function createWorkflow(node: WFNode): Workflow {
  const nodes = [
    createNode('image-source', 'imageNode', { enabled: true, params: { filePath: '/tmp/source.png' } }),
    node,
    createNode('output-node', 'outputNode', { enabled: true, params: {} }),
  ]
  const edges: WFEdge[] = [
    { id: 'edge-image', source: 'image-source', target: node.id },
    { id: 'edge-output', source: node.id, target: 'output-node' },
  ]

  return {
    id: 'workflow-1',
    name: 'Dispatch Workflow',
    description: '',
    nodes,
    edges,
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:00.000Z',
  }
}

function createMultiInputWorkflow(args: {
  node: WFNode
  imageSources: Array<{ id: string; filePath: string; targetHandle?: 'front' | 'left' | 'back' | 'right' }>
}): Workflow {
  const nodes = [
    ...args.imageSources.map((source) => createNode(source.id, 'imageNode', { enabled: true, params: { filePath: source.filePath } })),
    args.node,
    createNode('output-node', 'outputNode', { enabled: true, params: {} }),
  ]
  const edges: WFEdge[] = [
    ...args.imageSources.map((source) => ({
      id: `edge-${source.id}`,
      source: source.id,
      target: args.node.id,
      targetHandle: source.targetHandle,
    })),
    { id: 'edge-output', source: args.node.id, target: 'output-node' },
  ]

  return {
    id: 'workflow-multi-input',
    name: 'Dispatch Workflow Multi Input',
    description: '',
    nodes,
    edges,
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
  }
}

function createTextMeshWorkflow(args: {
  node: WFNode
  text?: string
  meshFilePath?: string
  includeMeshEdge?: boolean
  meshTargetHandle?: string
}): Workflow {
  const nodes = [
    createNode('text-source', 'textNode', { enabled: true, params: { text: args.text ?? 'Walk forward' } }),
    createNode('mesh-source', 'meshNode', { enabled: true, params: { source: 'file', filePath: args.meshFilePath ?? '/workspace/rigs/avatar.glb' } }),
    args.node,
    createNode('output-node', 'outputNode', { enabled: true, params: {} }),
  ]
  const edges: WFEdge[] = [
    { id: 'edge-text', source: 'text-source', target: args.node.id, targetHandle: 'prompt' },
    ...(args.includeMeshEdge === false
      ? []
      : [{ id: 'edge-mesh', source: 'mesh-source', target: args.node.id, targetHandle: args.meshTargetHandle ?? 'rigged_mesh' }]),
    { id: 'edge-output', source: args.node.id, target: 'output-node' },
  ]

  return {
    id: 'workflow-text-mesh',
    name: 'Dispatch Workflow Text Mesh',
    description: '',
    nodes,
    edges,
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z',
  }
}

function createNamedTextMeshModelExtension(overrides: Partial<WorkflowExtension> = {}): WorkflowExtension {
  return createWorkflowExtension({
    id: 'motion/animate', extensionId: 'motion-owner', nodeId: 'animate', input: 'text',
    inputs: [{ name: 'prompt', type: 'text' }, { name: 'rigged_mesh', type: 'mesh' }],
    ...overrides,
  })
}

function captureTextRequests(): Record<string, unknown>[] {
  const posts: Record<string, unknown>[] = []
  axiosClientMock = {
    async post(path, data) {
      assert.equal(path, '/generate/from-text')
      posts.push(JSON.parse(JSON.stringify(data)))
      return { data: { job_id: 'named-mesh' } }
    },
    async get() { return { data: { status: 'done', output_url: '/workspace/output/animated.glb' } } },
  }
  return posts
}

test('resolves model dispatch from extension type even for image-to-mesh nodes', () => {
  const ext = createWorkflowExtension({ type: 'model' })

  const dispatch = resolveWorkflowDispatch(createExtensionNode(ext.id), [ext])

  assert.equal(dispatch.mode, 'model')
  assert.equal(dispatch.ext, ext)
  assert.equal(dispatch.ext.extensionId, 'ext')
  assert.equal(dispatch.ext.nodeId, 'image-to-mesh')
})

test('resolves process dispatch from extension type even for image-to-mesh nodes', () => {
  const ext = createWorkflowExtension({ type: 'process' })

  const dispatch = resolveWorkflowDispatch(createExtensionNode(ext.id), [ext])

  assert.equal(dispatch.mode, 'process')
  assert.equal(dispatch.ext, ext)
  assert.equal(dispatch.ext.extensionId, 'ext')
  assert.equal(dispatch.ext.nodeId, 'image-to-mesh')
})

test('throws the unresolved-extension error contract when extension metadata is missing', () => {
  assert.throws(
    () => resolveWorkflowDispatch(createExtensionNode('missing/image-to-mesh'), []),
    { message: 'Unresolved workflow extension: missing/image-to-mesh' },
  )
})

test('workflowRunStore keeps legacy image-to-mesh model nodes on the model API path', async () => {
  const ext = createWorkflowExtension({
    id: 'legacy/image-to-mesh',
    extensionId: 'legacy',
    nodeId: 'image-to-mesh',
    type: 'model',
    params: [
      { id: 'prompt', label: 'Prompt', type: 'string', default: 'fallback prompt' },
      { id: 'strength', label: 'Strength', type: 'float', default: 0.75 },
    ],
  })
  const workflow = createWorkflow(createNode('model-node', 'extensionNode', {
    extensionId: ext.id,
    enabled: true,
    params: { prompt: 'refine' },
  }))
  const postCalls: Array<{ path: string; data: FormData; config: unknown }> = []
  const getCalls: string[] = []

  axiosClientMock = {
    async post(path: string, data?: unknown, config?: unknown) {
      if (path === '/generate/from-image') {
        postCalls.push({ path, data: data as FormData, config })
        return { data: { job_id: 'job-1' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      getCalls.push(path)
      return { data: { status: 'done', output_url: '/workspace/output/model.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.equal(postCalls[0].path, '/generate/from-image')
  assert.equal(postCalls[0].data.get('model_id'), ext.id)
  assert.equal(postCalls[0].data.get('params'), JSON.stringify({ prompt: 'refine', strength: 0.75 }))
  assert.deepEqual(getCalls, ['/generate/status/job-1'])
  assert.equal(runProcessCalls.length, 0)
  assert.deepEqual(fsReadCalls, ['/tmp/source.png'])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/output/model.glb')
  assert.deepEqual(Object.keys(useWorkflowRunStore.getState().nodeImageOutputs), [])
})

test('workflowRunStore routes the named front edge as multipart image instead of using the last image edge', async () => {
  const ext = createNamedImageModelExtension()
  const workflow = createMultiInputWorkflow({
    node: createNode('model-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: {},
    }),
    imageSources: [
      { id: 'left-source', filePath: '/tmp/left-view.png', targetHandle: 'left' },
      { id: 'front-source', filePath: '/tmp/front-view.png', targetHandle: 'front' },
      { id: 'right-source', filePath: '/tmp/right-view.png', targetHandle: 'right' },
    ],
  })
  const postCalls: Array<{ path: string; data: FormData }> = []

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-image') {
        postCalls.push({ path, data: data as FormData })
        return { data: { job_id: 'job-front-route' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/front-route.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.equal((postCalls[0].data.get('image') as File).name, 'front-view.png')
  assert.deepEqual(fsReadCalls, ['/tmp/front-view.png'])
})

test('workflowRunStore keeps an untargeted legacy image edge as primary for named-input model nodes', async () => {
  appState.selectedImagePath = undefined
  appState.selectedImageData = undefined
  const ext = createNamedImageModelExtension()
  const workflow = createMultiInputWorkflow({
    node: createNode('model-node', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
    imageSources: [{ id: 'legacy-source', filePath: '/tmp/legacy-primary.png' }],
  })
  const posts = captureImageRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(posts.length, 1)
  assert.equal((posts[0].get('image') as File).name, 'legacy-primary.png')
  assert.deepEqual(fsReadCalls, ['/tmp/legacy-primary.png'])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

for (const reversed of [false, true]) {
  for (const withFront of [false, true]) {
    test(`named MODEL primary prefers front then legacy over selected path and bytes (${withFront}, ${reversed})`, async () => {
      const ext = createNamedImageModelExtension()
      const workflow = createMultiInputWorkflow({
        node: createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
        imageSources: [
          ...(withFront ? [{ id: 'front', filePath: '/front.png', targetHandle: 'front' as const }] : []),
          { id: 'left', filePath: '/left.png', targetHandle: 'left' },
          { id: 'legacy', filePath: '/legacy.png' },
          { id: 'back', filePath: '/back.png', targetHandle: 'back' },
          { id: 'right', filePath: '/right.png', targetHandle: 'right' },
        ],
      })
      if (reversed) workflow.edges.reverse()
      const posts = captureImageRequests()
      await useWorkflowRunStore.getState().run(workflow, [ext])
      assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
      assert.equal(posts.length, 1)
      const image = posts[0].get('image') as File
      assert.equal(image.name, withFront ? 'front.png' : 'legacy.png')
      assert.equal(await image.text(), 'fs-bytes')
      assert.deepEqual(fsReadCalls, [withFront ? '/front.png' : '/legacy.png'])
      assert.deepEqual(JSON.parse(String(posts[0].get('params'))), {
        left_image_path: '/left.png', back_image_path: '/back.png', right_image_path: '/right.png',
      })
    })
  }
}

test('named MODEL primary resolves a legacy image through preview and Wait before resuming', async () => {
  appState.selectedImagePath = undefined
  appState.selectedImageData = undefined
  const ext = createNamedImageModelExtension()
  const workflow = createMultiInputWorkflow({
    node: createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
    imageSources: [{ id: 'legacy', filePath: '/legacy.png' }],
  })
  workflow.nodes.push(createNode('preview', 'imagePreviewNode'), createNode('wait', 'waitNode'))
  workflow.edges[0].source = 'wait'
  workflow.edges.push(
    { id: 'legacy-preview', source: 'legacy', target: 'preview' },
    { id: 'preview-wait', source: 'preview', target: 'wait' },
  )
  const posts = captureImageRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(posts.length, 0)
  assert.deepEqual(fsReadCalls, [])
  assert.equal(useWorkflowRunStore.getState().waitStates.wait, 'pending')
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(posts.length, 1)
  assert.equal((posts[0].get('image') as File).name, 'legacy.png')
  assert.deepEqual(fsReadCalls, ['/legacy.png'])
})

for (const targetHandle of [null, '', 'unknown', 0, false]) {
  test(`named MODEL primary treats only nullish imported handles as untargeted (${JSON.stringify(targetHandle)})`, async () => {
    const ext = createNamedImageModelExtension()
    const workflow = createMultiInputWorkflow({
      node: createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
      imageSources: [{ id: 'legacy', filePath: '/legacy.png' }],
    })
    // Imported workflow JSON is not made type-safe by its TypeScript annotation.
    workflow.edges[0] = JSON.parse(JSON.stringify({ ...workflow.edges[0], targetHandle }))
    const posts = captureImageRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
    assert.equal(posts.length, 1)
    assert.equal((posts[0].get('image') as File).name, targetHandle === null ? 'legacy.png' : 'placeholder.png')
    assert.deepEqual(fsReadCalls, targetHandle === null ? ['/legacy.png'] : [])
  })
}

test('named MODEL primary ignores untargeted non-image output', async () => {
  const ext = createNamedImageModelExtension()
  const workflow = createMultiInputWorkflow({
    node: createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
    imageSources: [{ id: 'mesh', filePath: '/mesh.glb' }],
  })
  workflow.nodes[0].type = 'meshNode'
  const posts = captureImageRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(posts.length, 1)
  assert.equal((posts[0].get('image') as File).name, 'placeholder.png')
  assert.deepEqual(fsReadCalls, [])
})

test('workflowRunStore flattens only connected named side views into model params', async () => {
  const ext = createNamedImageModelExtension({
    params: [
      { id: 'prompt', label: 'Prompt', type: 'string', default: 'fallback prompt' },
      { id: 'strength', label: 'Strength', type: 'float', default: 0.75 },
    ],
  })
  const workflow = createMultiInputWorkflow({
    node: createNode('model-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: { prompt: 'refine' },
    }),
    imageSources: [
      { id: 'front-source', filePath: '/tmp/front.png', targetHandle: 'front' },
      { id: 'left-source', filePath: '/tmp/left.png', targetHandle: 'left' },
      { id: 'back-source', filePath: '/tmp/back.png', targetHandle: 'back' },
      { id: 'right-source', filePath: '/tmp/right.png', targetHandle: 'right' },
    ],
  })
  const postCalls: FormData[] = []

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-image') {
        postCalls.push(data as FormData)
        return { data: { job_id: 'job-side-params' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/side-params.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.deepEqual(JSON.parse(String(postCalls[0].get('params'))), {
    prompt: 'refine',
    strength: 0.75,
    left_image_path: '/tmp/left.png',
    back_image_path: '/tmp/back.png',
    right_image_path: '/tmp/right.png',
  })
})

test('workflowRunStore omits unconnected side views and removes stale reserved side params', async () => {
  const ext = createNamedImageModelExtension()
  const workflow = createMultiInputWorkflow({
    node: createNode('model-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: {
        keep: 'value',
        left_image_path: '/tmp/stale-left.png',
        back_image_path: '/tmp/stale-back.png',
        right_image_path: '/tmp/stale-right.png',
      },
    }),
    imageSources: [{ id: 'front-source', filePath: '/tmp/front.png', targetHandle: 'front' }],
  })
  const postCalls: FormData[] = []

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-image') {
        postCalls.push(data as FormData)
        return { data: { job_id: 'job-omit-stale' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/omit-stale.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.deepEqual(JSON.parse(String(postCalls[0].get('params'))), { keep: 'value' })
})

test('workflowRunStore falls back to selectedImagePath when front is missing but keeps connected side-view params', async () => {
  appState.selectedImageData = undefined
  const ext = createNamedImageModelExtension()
  const workflow = createMultiInputWorkflow({
    node: createNode('model-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: {},
    }),
    imageSources: [{ id: 'left-source', filePath: '/tmp/left-only.png', targetHandle: 'left' }],
  })
  const postCalls: FormData[] = []

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-image') {
        postCalls.push(data as FormData)
        return { data: { job_id: 'job-fallback' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/fallback.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.equal((postCalls[0].get('image') as File).name, 'source.png')
  assert.deepEqual(JSON.parse(String(postCalls[0].get('params'))), { left_image_path: '/tmp/left-only.png' })
  assert.deepEqual(fsReadCalls, ['/tmp/source.png'])
})

test('workflowRunStore preserves the legacy missing-primary-image failure when front and selected image are both absent', async () => {
  appState.selectedImagePath = undefined
  appState.selectedImageData = undefined

  const ext = createNamedImageModelExtension()
  const workflow = createMultiInputWorkflow({
    node: createNode('model-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: {
        left_image_path: '/tmp/stale-left.png',
      },
    }),
    imageSources: [{ id: 'left-source', filePath: '/tmp/left-only.png', targetHandle: 'left' }],
  })
  let postCalls = 0
  let getCalls = 0

  axiosClientMock = {
    async post(path: string) {
      postCalls += 1
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      getCalls += 1
      throw new Error(`Unexpected axios.get call: ${path}`)
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls, 0)
  assert.equal(getCalls, 0)
  assert.equal(runProcessCalls.length, 0)
  assert.deepEqual(fsReadCalls, [])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /No input image selected for model node/)
})

function captureImageRequests(): FormData[] {
  const posts: FormData[] = []
  axiosClientMock = {
    async post(path, data) {
      assert.equal(path, '/generate/from-image')
      assert.ok(data instanceof FormData)
      posts.push(data)
      return { data: { job_id: 'named-images' } }
    },
    async get() { return { data: { status: 'done', output_url: '/workspace/output/model.glb' } } },
  }
  return posts
}

for (const reversed of [false, true]) {
  test(`named MODEL front and side routing traverses Wait regardless of edge order (${reversed})`, async () => {
    const ext = createNamedImageModelExtension()
    const workflow = createMultiInputWorkflow({
      node: createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
      imageSources: [
        { id: 'front', filePath: '/front.png', targetHandle: 'front' },
        { id: 'side', filePath: '/side.png', targetHandle: 'left' },
      ],
    })
    workflow.nodes.push(createNode('wait-front', 'waitNode'), createNode('wait-side', 'waitNode'))
    workflow.edges[0].source = 'wait-front'
    workflow.edges[1].source = 'wait-side'
    workflow.edges.push(
      { id: 'front-wait', source: 'front', target: 'wait-front' },
      { id: 'side-wait', source: 'side', target: 'wait-side' },
    )
    if (reversed) workflow.edges.reverse()
    const posts = captureImageRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    // Independent Waits merge into the pre-phase under the accepted executor.
    assert.equal(posts.length, 1)
    assert.equal((posts[0].get('image') as File).name, 'front.png')
    assert.deepEqual(JSON.parse(String(posts[0].get('params'))), { left_image_path: '/side.png' })
    assert.deepEqual(fsReadCalls, ['/front.png'])
    await useWorkflowRunStore.getState().continueRun('wait-front')
    await useWorkflowRunStore.getState().continueRun('wait-side')
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  })
}

test('named MODEL front resumes through a single Wait branch', async () => {
  const ext = createNamedImageModelExtension()
  const workflow = createMultiInputWorkflow({
    node: createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
    imageSources: [{ id: 'front', filePath: '/front.png', targetHandle: 'front' }],
  })
  workflow.nodes.push(createNode('wait', 'waitNode'))
  workflow.edges[0].source = 'wait'
  workflow.edges.push({ id: 'front-wait', source: 'front', target: 'wait' })
  const posts = captureImageRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(posts.length, 0)
  assert.equal(useWorkflowRunStore.getState().waitStates.wait, 'pending')
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal((posts[0].get('image') as File).name, 'front.png')
  assert.deepEqual(fsReadCalls, ['/front.png'])
})

test('named MODEL fallback accepts selected bytes without a path and retains primitive and unknown params', async () => {
  appState.selectedImagePath = undefined
  const ext = createNamedImageModelExtension()
  const params = { count: 0, enabled: false, prompt: '', unknown: { keep: true }, right_image_path: '/stale.png' }
  const workflow = createMultiInputWorkflow({
    node: createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params }),
    imageSources: [{ id: 'side', filePath: '/side.png', targetHandle: 'left' }],
  })
  const posts = captureImageRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal((posts[0].get('image') as File).name, 'placeholder.png')
  assert.equal(await (posts[0].get('image') as File).text(), 'png-bytes')
  assert.deepEqual(JSON.parse(String(posts[0].get('params'))), {
    count: 0, enabled: false, prompt: '', unknown: { keep: true }, left_image_path: '/side.png',
  })
  assert.deepEqual(fsReadCalls, [])
  assert.equal(params.right_image_path, '/stale.png', 'Routing must not mutate the saved workflow')
})

test('named MODEL image ports do not consume mesh outputs or undeclared side handles', async () => {
  const ext = createNamedImageModelExtension({ inputs: [{ name: 'front', type: 'image' }] })
  const workflow = createMultiInputWorkflow({
    node: createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params: { left_image_path: 'user-left' } }),
    imageSources: [
      { id: 'wrong-kind', filePath: '/mesh.glb', targetHandle: 'front' },
      { id: 'undeclared', filePath: '/side.png', targetHandle: 'left' },
    ],
  })
  workflow.nodes[0].type = 'meshNode'
  const posts = captureImageRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal((posts[0].get('image') as File).name, 'placeholder.png')
  assert.deepEqual(JSON.parse(String(posts[0].get('params'))), { left_image_path: 'user-left' })
  assert.deepEqual(fsReadCalls, [])
})

for (const inputs of [undefined, ['image', 'image'], [{ name: 'reference', type: 'image' }]] satisfies WorkflowExtension['inputs'][]) {
  test(`MODEL side-key cleanup does not apply to other contracts ${JSON.stringify(inputs)}`, async () => {
    const ext = createWorkflowExtension({ inputs })
    const target = createExtensionNode(ext.id)
    target.data.params = { left_image_path: 'user-left', back_image_path: 'user-back', right_image_path: 'user-right' }
    const workflow = createWorkflow(target)
    if (inputs && typeof inputs[0] !== 'string') workflow.edges[0].targetHandle = 'reference'
    const posts = captureImageRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
    assert.deepEqual(JSON.parse(String(posts[0].get('params'))), target.data.params)
    assert.deepEqual(fsReadCalls, ['/tmp/source.png'])
  })
}

test('named PROCESS front and side handles keep typed descriptors and same-named user params', async () => {
  const ext = createNamedImageModelExtension({ type: 'process' })
  const params = { left_image_path: 'process-user-param', flag: false, zero: 0, empty: '' }
  const workflow = createMultiInputWorkflow({
    node: createNode('process', 'extensionNode', { extensionId: ext.id, enabled: true, params }),
    imageSources: [
      { id: 'front', filePath: '/front.png', targetHandle: 'front' },
      { id: 'left', filePath: '/left.png', targetHandle: 'left' },
    ],
  })
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.deepEqual(runProcessCalls, [{ extensionId: ext.extensionId, input: { nodeId: ext.nodeId, inputs: {
    front: { type: 'image', filePath: '/front.png', sourceNodeId: 'front' },
    left: { type: 'image', filePath: '/left.png', sourceNodeId: 'left' },
  } }, params }])
  assert.deepEqual(fsReadCalls, [])
})

for (const targetHandle of ['front', undefined] as const) {
  test(`named MODEL resolves each For Each image through the upstream image-preview passthrough (${targetHandle ?? 'legacy'})`, async () => {
    iteratorFileNames = ['a.png', 'b.png']
    const ext = createNamedImageModelExtension()
    const workflow = createMultiInputWorkflow({
      node: createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
      imageSources: [
        { id: 'front', filePath: '/unused.png', targetHandle },
        { id: 'side', filePath: '/side.png', targetHandle: 'left' },
      ],
    })
    workflow.nodes[0] = createNode('front', 'forEachNode', { enabled: true, params: { dir: '/images', mode: 'image' } })
    workflow.nodes.push(createNode('preview', 'imagePreviewNode'))
    workflow.edges[0].source = 'preview'
    workflow.edges.push({ id: 'iterator-preview', source: 'front', target: 'preview' })
    const posts = captureImageRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
    assert.deepEqual(posts.map((post) => (post.get('image') as File).name), ['a.png', 'b.png'])
    assert.deepEqual(posts.map((post) => JSON.parse(String(post.get('params')))), [
      { left_image_path: '/side.png' }, { left_image_path: '/side.png' },
    ])
    assert.deepEqual(fsReadCalls, ['/images/a.png', '/images/b.png'])
  })
}

test('workflowRunStore dispatches text-capability model nodes through the text generation endpoint without reading image bytes', async () => {
  const ext = createWorkflowExtension({
    id: 'text/model',
    extensionId: 'text-vendor',
    nodeId: 'text-to-mesh',
    type: 'model',
    input: 'text',
    params: [
      { id: 'prompt', label: 'Prompt', type: 'string', default: 'fallback prompt' },
      { id: 'seed', label: 'Seed', type: 'int', default: 99 },
      { id: 'enable_detail', label: 'Enable detail', type: 'boolean', default: true },
      { id: 'negative_prompt', label: 'Negative prompt', type: 'string', default: 'blurry' },
      { id: 'sampler', label: 'Sampler', type: 'select', default: 'ddim', options: [{ value: 'ddim', label: 'DDIM' }] },
    ],
  })
  const workflow = createWorkflow(createNode('text-model-node', 'extensionNode', {
    extensionId: ext.id,
    enabled: true,
    params: {
      prompt: 'A stone castle',
      seed: 0,
      enable_detail: false,
      negative_prompt: '',
    },
  }))
  const postCalls: Array<{ path: string; data: Record<string, unknown>; config: unknown }> = []
  const getCalls: string[] = []

  axiosClientMock = {
    async post(path: string, data?: unknown, config?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: JSON.parse(JSON.stringify(data)), config })
        return { data: { job_id: 'job-text-1' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      getCalls.push(path)
      return { data: { status: 'done', output_url: '/workspace/output/text-model.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.equal(postCalls[0].path, '/generate/from-text')
  assert.deepEqual(postCalls[0].data, {
    prompt: 'A stone castle',
    model_id: ext.id,
    collection: 'Workflows',
    remesh: 'none',
    enable_texture: false,
    texture_resolution: 1024,
    params: {
      seed: 0,
      enable_detail: false,
      negative_prompt: '',
      sampler: 'ddim',
    },
  })
  assert.deepEqual(getCalls, ['/generate/status/job-text-1'])
  assert.equal(runProcessCalls.length, 0)
  assert.deepEqual(fsReadCalls, [])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/output/text-model.glb')
})

test('workflowRunStore routes named rigged mesh input into text generation params', async () => {
  const ext = createWorkflowExtension({
    id: 'kimodo/animate-rigged-mesh',
    extensionId: 'kimodo-soma-rp',
    nodeId: 'animate-rigged-mesh',
    name: 'Animate Rigged Mesh',
    type: 'model',
    input: 'text',
    output: 'mesh',
    inputs: [
      { name: 'prompt', type: 'text', required: true },
      { name: 'rigged_mesh', type: 'mesh', required: true },
    ],
    params: [
      { id: 'prompt', label: 'Prompt', type: 'string', default: '' },
      { id: 'duration', label: 'Duration', type: 'float', default: 5 },
    ],
  })
  const workflow = createTextMeshWorkflow({
    node: createNode('animate-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: { duration: 3 },
    }),
    text: 'Jump and wave',
    meshFilePath: '/workspace/rigs/avatar.glb',
  })
  const postCalls: Array<{ path: string; data: Record<string, unknown> }> = []

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: JSON.parse(JSON.stringify(data)) })
        return { data: { job_id: 'job-text-mesh' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/animated.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.deepEqual(postCalls[0].data, {
    prompt: 'Jump and wave',
    model_id: ext.id,
    collection: 'Workflows',
    remesh: 'none',
    enable_texture: false,
    texture_resolution: 1024,
    params: {
      duration: 3,
      prompt: 'Jump and wave',
      text: 'Jump and wave',
      rigged_mesh_path: 'rigs/avatar.glb',
      mesh_path: 'rigs/avatar.glb',
      node_id: 'animate-rigged-mesh',
      model_id: ext.id,
      motion_prompt: 'Jump and wave',
    },
  })
  assert.deepEqual(fsReadCalls, [])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.deepEqual({ ...useWorkflowRunStore.getState().runState.artifact?.provenance }, {
    workflowId: 'workflow-text-mesh',
    workflowNodeId: 'animate-node',
    extensionId: 'kimodo-soma-rp',
    extensionNodeId: 'animate-rigged-mesh',
  })
  assert.deepEqual({ ...useWorkflowRunStore.getState().nodeArtifacts['animate-node']?.provenance }, {
    workflowId: 'workflow-text-mesh',
    workflowNodeId: 'animate-node',
    extensionId: 'kimodo-soma-rp',
    extensionNodeId: 'animate-rigged-mesh',
  })
})

test('workflowRunStore routes Animate Rigged Mesh node prompt as motion prompt and keeps source text separate', async () => {
  const ext = createKimodoAnimateExtension({
    params: [
      { id: 'prompt', label: 'Prompt', type: 'string', default: '' },
      { id: 'duration', label: 'Duration', type: 'float', default: 5 },
    ],
  })
  const workflow = createTextMeshWorkflow({
    node: createNode('animate-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: {
        prompt: 'a person walking',
        duration: 3,
      },
    }),
    text: 'Nekomimi Woman, blue jeans, T-Pose, Full PBR',
    meshFilePath: '/workspace/rigs/nekomimi.glb',
  })
  const postCalls: Array<{ path: string; data: Record<string, unknown> }> = []

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: data as Record<string, unknown> })
        return { data: { job_id: 'job-motion-prompt' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/animated.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.equal(postCalls[0].path, '/generate/from-text')
  assert.equal(postCalls[0].data.prompt, 'a person walking')
  assert.equal((postCalls[0].data.params as Record<string, unknown>).motion_prompt, 'a person walking')
  assert.equal((postCalls[0].data.params as Record<string, unknown>).character_prompt, 'Nekomimi Woman, blue jeans, T-Pose, Full PBR')
  assert.equal((postCalls[0].data.params as Record<string, unknown>).prompt, 'a person walking')
  assert.equal((postCalls[0].data.params as Record<string, unknown>).text, 'a person walking')
  assert.notEqual(postCalls[0].data.prompt, 'Nekomimi Woman, blue jeans, T-Pose, Full PBR')
})
test('workflowRunStore blocks Animate Rigged Mesh when node motion prompt is empty even if source text exists', async () => {
  const ext = createKimodoAnimateExtension({
    params: [{ id: 'prompt', label: 'Prompt', type: 'string', default: '' }],
  })
  const workflow = createTextMeshWorkflow({
    node: createNode('animate-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: { prompt: '   ' },
    }),
    text: 'Nekomimi Woman, blue jeans, T-Pose, Full PBR',
    meshFilePath: '/workspace/rigs/nekomimi.glb',
  })
  let postCalls = 0

  axiosClientMock = {
    async post(path: string) {
      postCalls += 1
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      throw new Error('Unexpected axios.get call')
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls, 0)
  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /Missing required motion prompt input for extension kimodo\/animate-rigged-mesh/)
})
test('workflowRunStore rejects stale named mesh handles instead of authorizing a single-mesh fallback', async () => {
  const ext = createKimodoAnimateExtension()
  const workflow = createTextMeshWorkflow({
    node: createNode('animate-node', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
    text: 'Jump and wave', meshTargetHandle: 'mesh',
  })
  const posts = captureTextRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(posts.length, 0)
  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /Missing required rigged_mesh mesh input/)
  assert.deepEqual(humanoidPromotionReadCalls, [])
})

test('workflowRunStore blocks animate-rigged-mesh before generation when rigged mesh is missing', async () => {
  const ext = createWorkflowExtension({
    id: 'kimodo/animate-rigged-mesh',
    extensionId: 'kimodo-soma-rp',
    nodeId: 'animate-rigged-mesh',
    type: 'model',
    input: 'text',
    inputs: [
      { name: 'prompt', type: 'text', required: true },
      { name: 'rigged_mesh', type: 'mesh', required: true },
    ],
    params: [{ id: 'prompt', label: 'Prompt', type: 'string', default: '' }],
  })
  const workflow = createTextMeshWorkflow({
    node: createNode('animate-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: {},
    }),
    includeMeshEdge: false,
  })
  let postCalls = 0
  let getCalls = 0

  axiosClientMock = {
    async post(path: string) {
      postCalls += 1
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      getCalls += 1
      throw new Error(`Unexpected axios.get call: ${path}`)
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls, 0)
  assert.equal(getCalls, 0)
  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.equal(
    useWorkflowRunStore.getState().runState.error,
    'Error: Missing required rigged_mesh mesh input for extension kimodo/animate-rigged-mesh',
  )
})

for (const [workspace, filePath, expected] of [
  ['/workspace', '/workspace/rigs/avatar.glb', 'rigs/avatar.glb'],
  ['/workspace', '/workspace-other/avatar.glb', '/workspace-other/avatar.glb'],
  ['/workspace/', 'rigs\\avatar.glb', 'rigs/avatar.glb'],
  ['C:\\workspace\\', 'C:\\workspace\\rigs\\avatar.glb', 'rigs/avatar.glb'],
  ['C:\\workspace', 'C:\\workspace-other\\avatar.glb', 'C:/workspace-other/avatar.glb'],
]) {
  test(`named rigged mesh path respects workspace boundaries: ${filePath}`, async () => {
    workspaceDir = workspace
    const ext = createNamedTextMeshModelExtension()
    const workflow = createTextMeshWorkflow({ node: createExtensionNode(ext.id), meshFilePath: filePath })
    workflow.nodes[2].data.params = { node_id: 'stale-node', model_id: 'stale-model' }
    const posts = captureTextRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
    assert.equal(posts[0].model_id, ext.id)
    assert.deepEqual(posts[0].params, {
      prompt: 'Walk forward', text: 'Walk forward', rigged_mesh_path: expected, mesh_path: expected,
      node_id: ext.nodeId, model_id: ext.id,
    })
    assert.deepEqual(fsReadCalls, [])
  })
}

for (const wrongKind of [false, true]) {
  test(`required named mesh uses typed Wait sources before image reads or HTTP (${wrongKind})`, async () => {
    const ext = createNamedTextMeshModelExtension()
    const workflow = createTextMeshWorkflow({ node: createExtensionNode(ext.id) })
    if (wrongKind) workflow.nodes[1].type = 'imageNode'
    workflow.nodes.push(createNode('wait', 'waitNode'))
    workflow.edges[1].source = 'wait'
    workflow.edges.push({ id: 'mesh-wait', source: 'mesh-source', target: 'wait' })
    workflow.edges.reverse()
    const posts = captureTextRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(posts.length, 0)
    await useWorkflowRunStore.getState().continueRun('wait')
    assert.equal(posts.length, wrongKind ? 0 : 1)
    assert.equal(useWorkflowRunStore.getState().runState.status, wrongKind ? 'error' : 'done')
    if (wrongKind) assert.match(useWorkflowRunStore.getState().runState.error ?? '', /Missing required rigged_mesh mesh input/)
    else assert.equal((posts[0].params as Record<string, unknown>).rigged_mesh_path, 'rigs/avatar.glb')
    assert.deepEqual(fsReadCalls, [])
    assert.equal(runProcessCalls.length, 0)
  })
}

test('omitted required defaults to true and validates mesh before the image MODEL reads its front', async () => {
  const ext = createNamedImageModelExtension({ inputs: [{ name: 'front', type: 'image' }, { name: 'rigged_mesh', type: 'mesh' }] })
  const workflow = createMultiInputWorkflow({ node: createExtensionNode(ext.id), imageSources: [
    { id: 'front', filePath: '/front.png', targetHandle: 'front' },
  ] })
  const posts = captureImageRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /Missing required rigged_mesh mesh input/)
  assert.equal(posts.length, 0)
  assert.deepEqual(fsReadCalls, [])
})

test('optional mesh and prompt permit omission and retain falsy/unknown parameters', async () => {
  const ext = createNamedTextMeshModelExtension({ inputs: [
    { name: 'prompt', type: 'text', required: false }, { name: 'rigged_mesh', type: 'mesh', required: false },
  ] })
  const node = createExtensionNode(ext.id)
  node.data.params = { prompt: '', seed: 0, enabled: false, empty: '', unknown: { keep: true } }
  const workflow = createTextMeshWorkflow({ node, text: '', includeMeshEdge: false })
  const posts = captureTextRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(posts[0].prompt, '')
  assert.deepEqual(posts[0].params, { seed: 0, enabled: false, empty: '', unknown: { keep: true } })
  assert.deepEqual(fsReadCalls, [])
  assert.equal(node.data.params.prompt, '')
})

for (const connected of [false, true]) {
  test(`declared required prompt rejects blanks without falling back over connected empty text (${connected})`, async () => {
    const ext = createNamedTextMeshModelExtension()
    const node = createExtensionNode(ext.id)
    node.data.params = { prompt: connected ? 'must not replace connected blank' : '  ' }
    const workflow = createTextMeshWorkflow({ node, text: '  ' })
    if (!connected) workflow.edges = workflow.edges.filter((edge) => edge.id !== 'edge-text')
    const posts = captureTextRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
    assert.match(useWorkflowRunStore.getState().runState.error ?? '', /Missing required prompt input/)
    assert.equal(posts.length, 0)
    assert.deepEqual(fsReadCalls, [])
  })
}

test('required prompt still accepts the current text alias when no prompt edge is connected', async () => {
  const ext = createNamedTextMeshModelExtension({ params: [{ id: 'text', label: 'Text', type: 'string', default: 'Alias motion' }] })
  const workflow = createTextMeshWorkflow({ node: createExtensionNode(ext.id) })
  workflow.edges = workflow.edges.filter((edge) => edge.id !== 'edge-text')
  const posts = captureTextRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(posts[0].prompt, 'Alias motion')
})

test('unrelated named text declarations do not gain a required-prompt rule or generic mesh transport', async () => {
  const ext = createNamedTextMeshModelExtension({ inputs: [
    { name: 'description', type: 'text' }, { name: 'reference_mesh', type: 'mesh' },
  ] })
  const workflow = createTextMeshWorkflow({ node: createExtensionNode(ext.id), text: '' })
  workflow.edges[0].targetHandle = 'description'
  workflow.edges[1].targetHandle = 'reference_mesh'
  const posts = captureTextRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(posts[0].prompt, '')
  assert.deepEqual(posts[0].params, {})
})

test('mixed positional text and mesh keeps the existing image adapter without blank-prompt validation', async () => {
  const ext = createWorkflowExtension({ input: 'text', inputs: ['text', 'mesh', 'image'] })
  const workflow = createTextMeshWorkflow({ node: createExtensionNode(ext.id), text: '', meshFilePath: '/workspace-other/avatar.glb' })
  workflow.edges[0].targetHandle = 'input-0'
  workflow.edges[1].targetHandle = 'input-1'
  const posts = captureImageRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.deepEqual(JSON.parse(String(posts[0].get('params'))), { mesh_path: '/workspace-other/avatar.glb' })
  assert.deepEqual(fsReadCalls, [])
})

test('named text MODEL resolves every For Each mesh with its current capability identity', async () => {
  iteratorFileNames = ['a.glb', 'b.glb']
  const ext = createNamedTextMeshModelExtension()
  const workflow = createTextMeshWorkflow({ node: createExtensionNode(ext.id) })
  workflow.nodes[1] = createNode('mesh-source', 'forEachNode', { enabled: true, params: { dir: '/workspace/rigs', mode: 'mesh' } })
  const posts = captureTextRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.deepEqual(posts.map((post) => (post.params as Record<string, unknown>).rigged_mesh_path), ['rigs/a.glb', 'rigs/b.glb'])
  assert.deepEqual(fsReadCalls, [])
})

test('named rigged mesh PROCESS input stays typed and does not acquire MODEL metadata params', async () => {
  const ext = createNamedTextMeshModelExtension({ type: 'process' })
  const node = createExtensionNode(ext.id)
  node.data.params = { mesh_path: 'user-mesh', node_id: 'user-node', enabled: false }
  const workflow = createTextMeshWorkflow({ node })
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.deepEqual(runProcessCalls, [{ extensionId: ext.extensionId, input: { nodeId: ext.nodeId, inputs: {
    prompt: { type: 'text', text: 'Walk forward', sourceNodeId: 'text-source' },
    rigged_mesh: { type: 'mesh', filePath: '/workspace/rigs/avatar.glb', sourceNodeId: 'mesh-source' },
  } }, params: node.data.params }])
  assert.deepEqual(fsReadCalls, [])
})

test('workflowRunStore blocks model dispatch before backend requests when capability input metadata is missing', async () => {
  const scenarios: Array<{ name: string; input: WorkflowExtension['input'] | undefined; expectedError: string }> = [
    {
      name: 'missing capability input',
      input: undefined,
      expectedError: 'Error: Missing workflow capability input metadata for extension: invalid/missing-input',
    },
  ]

  for (const scenario of scenarios) {
    useWorkflowRunStore.getState().reset()

    const ext = createWorkflowExtension({
      id: scenario.name === 'missing capability input' ? 'invalid/missing-input' : 'invalid/unsupported-input',
      extensionId: 'invalid',
      nodeId: 'invalid-node',
      type: 'model',
      input: scenario.input as WorkflowExtension['input'],
    })
    const workflow = createWorkflow(createNode('invalid-model-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: { prompt: 'should not dispatch' },
    }))
    let axiosPostCalls = 0
    let axiosGetCalls = 0

    axiosClientMock = {
      async post(path: string) {
        axiosPostCalls += 1
        throw new Error(`Unexpected axios.post call: ${path}`)
      },
      async get(path: string) {
        axiosGetCalls += 1
        throw new Error(`Unexpected axios.get call: ${path}`)
      },
    }

    await useWorkflowRunStore.getState().run(workflow, [ext])

    assert.equal(axiosPostCalls, 0, `${scenario.name} should not call axios.post`)
    assert.equal(axiosGetCalls, 0, `${scenario.name} should not call axios.get`)
    assert.equal(runProcessCalls.length, 0, `${scenario.name} should not run process extensions`)
    assert.deepEqual(fsReadCalls, [], `${scenario.name} should not read image bytes`)
    assert.equal(useWorkflowRunStore.getState().activeNodeId, null)
    assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
    assert.equal(useWorkflowRunStore.getState().runState.error, scenario.expectedError)
  }
})

function sceneWorkflow(): { workflow: Workflow; ext: WorkflowExtension } {
  const ext = createWorkflowExtension({ id: 'scene/model', extensionId: 'scene', nodeId: 'model', input: 'scene', output: 'scene', type: 'model' })
  const workflow = createWorkflow(createNode('scene-model', 'extensionNode', { enabled: true, extensionId: ext.id, params: { steps: 12, flag: false, zero: 0, metadata: { opaque: ['preserved'] } } }))
  workflow.nodes = [createNode('scene-source', 'sceneNode', { enabled: true, params: { path: 'Scenes/hero', manifestPath: 'stale/scene-manifest.json' } }), ...workflow.nodes.filter((node) => node.type !== 'imageNode')]
  workflow.edges = [{ id: 'scene-model', source: 'scene-source', target: 'scene-model' }]
  return { workflow, ext }
}

const validSceneBytes = (): string => Buffer.from(JSON.stringify({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [], metadata: { opaque: true } })).toString('base64')

test('runtime scene validation uses current path and typed from-artifact JSON without reading image bytes', async () => {
  const { workflow, ext } = sceneWorkflow()
  readFile = async () => validSceneBytes()
  const requests: unknown[] = []
  axiosClientMock = {
    async post(path, body, config) { requests.push({ path, body: JSON.parse(JSON.stringify(body)), config }); return { data: { job_id: 'scene-job' } } },
    async get() { return { data: { status: 'done', output_url: '/workspace/output/scene-manifest.json' } } },
  }
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.deepEqual(requests, [{ path: '/generate/from-artifact', body: { input_kind: 'scene', input_path: 'Scenes/hero/scene-manifest.json', model_id: ext.id, collection: 'Workflows', params: { steps: 12, flag: false, zero: 0, metadata: { opaque: ['preserved'] } } }, config: undefined }])
  assert.deepEqual(fsReadCalls, ['/workspace/Scenes/hero/scene-manifest.json'])
  assert.equal(runProcessCalls.length, 0)
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().runState.outputPath, '/workspace/output/scene-manifest.json')
  assert.deepEqual(JSON.parse(JSON.stringify(useWorkflowRunStore.getState().nodeArtifacts['scene-source']?.legacy)), { filePath: '/workspace/Scenes/hero/scene-manifest.json', outputType: 'scene' })
})

test('runtime scene validation rejects invalid manifests instead of trusting cached validation', async () => {
  const { workflow, ext } = sceneWorkflow()
  readFile = async () => Buffer.from('{"schema":"wrong"}').toString('base64')
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /Load Scene:.*schema/)
  assert.deepEqual(fsReadCalls, ['/workspace/Scenes/hero/scene-manifest.json'])
  assert.deepEqual(Object.keys(useWorkflowRunStore.getState().nodeArtifacts), [])
  assert.equal(runProcessCalls.length, 0)
})

for (const operation of ['cancel', 'reset', 'replace'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    test(`late scene validation cannot resurrect a run after ${operation}/${outcome}`, async () => {
      const { workflow, ext } = sceneWorkflow()
      const gate = deferred<string>()
      readFile = () => gate.promise
      const pending = useWorkflowRunStore.getState().run(workflow, [ext])
      await waitFor(() => fsReadCalls.length === 1)
      if (operation === 'replace') await useWorkflowRunStore.getState().run(checkpointWorkflow(), [])
      else useWorkflowRunStore.getState()[operation]()
      const state = useWorkflowRunStore.getState()
      const job = appState.currentJob
      const jobBytes = JSON.stringify(job)
      if (outcome === 'resolve') gate.resolve(validSceneBytes())
      else gate.reject(new Error('old read failed'))
      await pending
      assert.equal(useWorkflowRunStore.getState(), state)
      assert.equal(appState.currentJob, job)
      assert.equal(JSON.stringify(appState.currentJob), jobBytes)
      assert.equal(runProcessCalls.length, 0)
    })
  }
}

test('Load Scene dispatches PROCESS with canonical scene input and producer identity', async () => {
  const { workflow, ext } = sceneWorkflow()
  ext.type = 'process'; ext.output = 'mesh'
  readFile = async () => validSceneBytes()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.deepEqual(fsReadCalls, ['/workspace/Scenes/hero/scene-manifest.json'])
  assert.equal(runProcessCalls.length, 1)
  assert.deepEqual(runProcessCalls[0].input, { nodeId: ext.nodeId, filePath: '/workspace/Scenes/hero/scene-manifest.json', inputs: {
    'input-0': { type: 'scene', filePath: '/workspace/Scenes/hero/scene-manifest.json', sourceNodeId: 'scene-source' },
  } })
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

test('workflowRunStore sends resolved process image-to-mesh nodes through runProcess', async () => {
  const ext = createWorkflowExtension({
    id: 'vendor/image-to-mesh',
    extensionId: 'vendor-process',
    nodeId: 'mesh-refiner',
    type: 'process',
  })
  const workflow = createWorkflow(createNode('process-node', 'extensionNode', {
    extensionId: ext.id,
    enabled: true,
    params: { quality: 'high' },
  }))
  let axiosPostCalls = 0
  let axiosGetCalls = 0

  axiosClientMock = {
    async post(path: string) {
      axiosPostCalls += 1
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      axiosGetCalls += 1
      throw new Error(`Unexpected axios.get call: ${path}`)
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(axiosPostCalls, 0)
  assert.equal(axiosGetCalls, 0)
  assert.equal(runProcessCalls.length, 1)
  assert.equal(runProcessCalls[0].extensionId, 'vendor-process')
  assert.deepEqual(runProcessCalls[0].input, {
    filePath: '/tmp/source.png',
    nodeId: 'mesh-refiner',
  })
  assert.deepEqual(runProcessCalls[0].params, { quality: 'high' })
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/output/process.glb')
})

test('workflowRunStore captures video process outputs for video preview nodes without publishing them to Generate Viewer3D', async () => {
  const ext = createWorkflowExtension({
    id: 'vendor/image-to-video',
    extensionId: 'vendor-video-process',
    nodeId: 'image-to-video',
    type: 'process',
    output: 'video',
  })
  const workflow = createWorkflow(createNode('video-node', 'extensionNode', {
    extensionId: ext.id,
    enabled: true,
    params: {},
  }))

  processResult = async () => ({ success: true, result: { filePath: '/workspace/video/generated.mp4' } })

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/video/generated.mp4')
  assert.equal(useWorkflowRunStore.getState().runState.artifact?.kind, 'video')
  assert.deepEqual(structuredClone(useWorkflowRunStore.getState().nodeVideoOutputs), {
    'video-node': '/workspace/video/generated.mp4',
  })
  assert.equal(appState.currentJob?.outputUrl, undefined)
})

test('workflowRunStore hydrates missing defaults for legacy process nodes before runProcess', async () => {
  const ext = createWorkflowExtension({
    id: 'vendor/legacy-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-refiner',
    type: 'process',
    params: [
      { id: 'quality', label: 'Quality', type: 'string', default: 'medium' },
      { id: 'strength', label: 'Strength', type: 'float', default: 0.75 },
    ],
  })
  const workflow = createWorkflow(createNode('process-node', 'extensionNode', {
    extensionId: ext.id,
    enabled: true,
    params: { quality: 'high' },
  }))

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(runProcessCalls.length, 1)
  assert.deepEqual(runProcessCalls[0].params, { quality: 'high', strength: 0.75 })
})

test('workflowRunStore preserves falsy process params during hydration without mutating the workflow document', async () => {
  const ext = createWorkflowExtension({
    id: 'vendor/process-falsy',
    extensionId: 'vendor-process',
    nodeId: 'mesh-refiner',
    type: 'process',
    params: [
      { id: 'enabled', label: 'Enabled', type: 'boolean', default: true },
      { id: 'retries', label: 'Retries', type: 'int', default: 3 },
      { id: 'note', label: 'Note', type: 'string', default: 'fallback note' },
      { id: 'sampler', label: 'Sampler', type: 'select', default: 'ddim', options: [{ value: 'ddim', label: 'DDIM' }] },
    ],
  })
  const rawParams = {
    enabled: false,
    retries: 0,
    note: '',
  }
  const workflow = createWorkflow(createNode('process-node', 'extensionNode', {
    extensionId: ext.id,
    enabled: true,
    params: rawParams,
  }))

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(runProcessCalls.length, 1)
  assert.deepEqual(runProcessCalls[0].params, {
    enabled: false,
    retries: 0,
    note: '',
    sampler: 'ddim',
  })
  assert.deepEqual(workflow.nodes[1].data.params, rawParams)
})

test('workflowRunStore surfaces unresolved extension ids before dispatch', async () => {
  const workflow = createWorkflow(createNode('missing-node', 'extensionNode', {
    extensionId: 'missing/image-to-mesh',
    enabled: true,
    params: {},
  }))
  let axiosPostCalls = 0
  let axiosGetCalls = 0

  axiosClientMock = {
    async post(path: string) {
      axiosPostCalls += 1
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      axiosGetCalls += 1
      throw new Error(`Unexpected axios.get call: ${path}`)
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [])

  assert.equal(axiosPostCalls, 0)
  assert.equal(axiosGetCalls, 0)
  assert.equal(runProcessCalls.length, 0)
  assert.equal(useWorkflowRunStore.getState().activeNodeId, null)
  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.equal(
    useWorkflowRunStore.getState().runState.error,
    'Error: Unresolved workflow extension: missing/image-to-mesh',
  )
})

for (const type of ['model', 'process'] as const) {
  test(`dispatch does not impose an input/output allowlist on ${type} metadata`, () => {
    const ext = createWorkflowExtension({ type, input: 'capture', output: 'video' })
    assert.deepEqual(resolveWorkflowDispatch(createExtensionNode(ext.id), [ext]), { ext, mode: type })
  })
}

test('actual named PROCESS dispatch uses resolved identities and preserves source and output type', async () => {
  const ext = createWorkflowExtension({
    id: 'alias/image-to-mesh', extensionId: 'real-package', nodeId: 'real-node', type: 'process', output: 'audio',
    inputs: [{ name: 'reference', type: 'image' }],
  })
  const workflow = createWorkflow(createExtensionNode(ext.id))
  workflow.edges[0].targetHandle = 'reference'
  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.deepEqual(runProcessCalls, [{
    extensionId: 'real-package',
    input: { nodeId: 'real-node', inputs: { reference: { type: 'image', sourceNodeId: 'image-source', filePath: '/tmp/source.png' } } },
    params: {},
  }])
  // The inert process returns a .glb path; declared audio must still not enter the mesh viewer.
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, undefined)
  assert.equal(useWorkflowRunStore.getState().runState.outputPath, '/workspace/output/process.glb')
  assert.deepEqual(fsReadCalls, [])
})

test('actual MODEL dispatch retains positional gaps, extra images and raw schema defaults without model switching', async () => {
  const ext = createWorkflowExtension({ inputs: ['image', 'text', 'image', 'image', 'mesh'], output: 'image', params: [
    { id: 'steps', label: 'Steps', type: 'int', default: 12 },
    { id: 'custom', label: 'Custom', type: 'unsupported', rawType: 'json', reason: 'Custom descriptor', default: { nested: true } },
  ] })
  const target = createExtensionNode(ext.id)
  target.data.params = { steps: 0, unknown: { keep: false } }
  const workflow = createWorkflow(target)
  workflow.nodes.push(
    createNode('side', 'imageNode', { enabled: true, params: { filePath: '/side.png' } }),
    createNode('mesh', 'meshNode', { enabled: true, params: { filePath: '/workspace/source.glb' } }),
  )
  workflow.edges[0].targetHandle = 'input-2'
  workflow.edges.unshift({ id: 'side', source: 'side', target: target.id, targetHandle: 'input-3' })
  workflow.edges.unshift({ id: 'mesh', source: 'mesh', target: target.id, targetHandle: 'input-4' })
  const posts: string[] = []
  axiosClientMock = {
    async post(path, data) {
      posts.push(path)
      assert.equal(path, '/generate/from-image', 'Dispatch must not switch the global active model')
      assert.ok(data instanceof FormData)
      assert.equal(data.get('model_id'), ext.id)
      assert.deepEqual(JSON.parse(String(data.get('params'))), {
        steps: 0, custom: { nested: true }, unknown: { keep: false }, mesh_path: 'source.glb', extra_image_paths: ['/side.png'],
      })
      return { data: { job_id: 'positional-model' } }
    },
    async get(path) {
      assert.equal(path, '/generate/status/positional-model')
      return { data: { status: 'done', output_url: '/workspace/output/result.png' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done', useWorkflowRunStore.getState().runState.error)
  assert.deepEqual(posts, ['/generate/from-image'])
  assert.deepEqual(fsReadCalls, ['/tmp/source.png'])
  assert.equal(runProcessCalls.length, 0)
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/output/result.png')
  assert.equal(useWorkflowRunStore.getState().nodeImageOutputs[target.id], '/workspace/output/result.png')
})

test('unresolved MODEL-looking ids fail before even reading image input', async () => {
  const workflow = createWorkflow(createExtensionNode('missing/model'))
  await useWorkflowRunStore.getState().run(workflow, [createWorkflowExtension({ type: 'process' })])
  assert.equal(useWorkflowRunStore.getState().runState.error, 'Error: Unresolved workflow extension: missing/model')
  assert.deepEqual(fsReadCalls, [])
  assert.equal(runProcessCalls.length, 0)
})

for (const kind of ['model', 'named-model', 'process'] as const) {
  test(`actual ${kind} dispatch reads live params again on each While iteration`, async () => {
    const type = kind === 'process' ? 'process' : 'model'
    const ext = kind === 'named-model' ? createNamedImageModelExtension() : createWorkflowExtension({ type })
    const target = createExtensionNode(ext.id)
    target.parentId = 'while'
    target.data.params = { count: 1, custom: 'original' }
    const workflow = createWorkflow(target)
    if (kind === 'named-model') workflow.edges[0].targetHandle = 'front'
    for (const node of workflow.nodes) node.position = { x: 1000, y: 1000 }
    const container = createNode('while', 'whileNode', { enabled: true, params: {}, iterations: 2 })
    container.width = 420
    container.height = 240
    workflow.nodes.unshift(container)
    const received: Record<string, unknown>[] = []
    const receive = (params: Record<string, unknown>) => {
      received.push(JSON.parse(JSON.stringify(params)))
      if (received.length === 1) useWorkflowRunStore.getState().setLiveNodeParams(target.id, { count: 0, custom: { live: true }, unknown: false })
    }
    onProcessRun = (call) => receive(call.params)
    axiosClientMock = {
      async post(path, data) {
        assert.equal(path, '/generate/from-image')
        assert.ok(data instanceof FormData)
        receive(JSON.parse(String(data.get('params'))))
        return { data: { job_id: 'loop' } }
      },
      async get() { return { data: { status: 'done', output_url: '/workspace/output/model.glb' } } },
    }
    const pending = useWorkflowRunStore.getState().run(workflow, [ext])
    try {
      await waitFor(() => useWorkflowRunStore.getState().runState.status === 'paused')
      assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
      useWorkflowRunStore.getState().continueWhile()
      await pending
    } finally {
      if (useWorkflowRunStore.getState().runState.status !== 'done') useWorkflowRunStore.getState().cancel()
    }
    assert.deepEqual(received, [{ count: 1, custom: 'original' }, { count: 0, custom: { live: true }, unknown: false }])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
    assert.deepEqual(target.data.params, { count: 1, custom: 'original' })
    assert.equal(runProcessCalls.length, type === 'process' ? 2 : 0)
  })
}

for (const supplied of [{}, { prompt: '' }, { prompt: 'explicit' }]) {
  test(`text executor resolves alias defaults and preserves explicit prompt ${JSON.stringify(supplied)}`, { timeout: 2000 }, async () => {
    const ext = createWorkflowExtension({ input: 'text', params: [{ id: 'text', label: 'Text', type: 'string', default: 'alias default' }] })
    const workflow = createWorkflow(createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params: supplied }))
    workflow.nodes = workflow.nodes.filter((node) => node.type !== 'imageNode')
    workflow.edges = workflow.edges.filter((edge) => edge.source !== 'image-source')
    const calls: Record<string, unknown>[] = []
    axiosClientMock = {
      async post(path, data) { assert.equal(path, '/generate/from-text'); calls.push(JSON.parse(JSON.stringify(data))); return { data: { job_id: 'text-job' } } },
      async get() { return { data: { status: 'done', output_url: '/workspace/text.glb' } } },
    }
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
    assert.equal(calls[0].prompt, Object.hasOwn(supplied, 'prompt') ? supplied.prompt : 'alias default')
    assert.equal((calls[0].params as Record<string, unknown>).text, 'alias default')
    assert.deepEqual(fsReadCalls, [])
  })
}


async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.fail('Inert workflow did not reach the expected state within 200 event-loop turns')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function checkpointWorkflow(type = 'waitNode'): Workflow {
  return {
    ...createWorkflow(createExtensionNode('unused')),
    nodes: [createNode('source', 'meshNode', { enabled: true, params: { source: 'file', filePath: '/workspace/source.glb' } }), createNode('wait', type)],
    edges: [{ id: 'source-wait', source: 'source', target: 'wait' }],
  }
}

function editedRef(versionId = 'edited') {
  return { id: 'edited-asset', versionId, kind: 'mesh' as const, uri: '/workspace/edited.glb', legacy: { filePath: '/workspace/edited.glb', outputType: 'mesh' as const } }
}

function owner(id = 'wait') {
  const token = useWorkflowRunStore.getState().getCheckpointOwner(id)
  assert.ok(token)
  return token
}

function addProcess(workflow: Workflow, id: string, wait: string, named = false) {
  const ext = createWorkflowExtension({ id: `ext/${id}`, nodeId: id, input: 'mesh', type: 'process', ...(named ? { inputs: [{ name: 'mesh', type: 'mesh', required: true }] } : {}) })
  workflow.nodes.push(createNode(id, 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }))
  workflow.edges.push({ id: `${wait}-${id}`, source: wait, target: id, ...(named ? { targetHandle: 'mesh' } : {}) })
  return ext
}

for (const named of [false, true]) {
  test(`checkpoint replacement reaches ${named ? 'named' : 'positional'} PROCESS and preserves its independent sibling`, async () => {
    const workflow = checkpointWorkflow()
    workflow.nodes.push(createNode('sibling', 'waitNode'), createNode('preview', 'imagePreviewNode'))
    workflow.edges.push({ id: 'source-sibling', source: 'source', target: 'sibling' }, { id: 'wait-preview', source: 'wait', target: 'preview' })
    const a = addProcess(workflow, 'first', 'preview', named)
    const b = addProcess(workflow, 'second', 'sibling', named)
    await useWorkflowRunStore.getState().run(workflow, [a, b])
    assert.equal(useWorkflowRunStore.getState().setPendingReplacement(owner(), editedRef()), true)
    assert.equal(useWorkflowRunStore.getState().checkpoints.sibling.pendingReplacement, undefined)
    await useWorkflowRunStore.getState().continueRun('wait', { owner: owner(), replacementArtifact: editedRef() })
    await useWorkflowRunStore.getState().continueRun('sibling')
    assert.equal((runProcessCalls[0].input as any)[named ? 'inputs' : 'filePath']?.mesh?.filePath ?? (runProcessCalls[0].input as any).filePath, '/workspace/edited.glb')
    assert.equal((runProcessCalls[1].input as any).inputs?.mesh?.filePath ?? (runProcessCalls[1].input as any).filePath, '/workspace/source.glb')
    assert.equal(useWorkflowRunStore.getState().nodeArtifacts.source.uri, '/workspace/source.glb')
    assert.equal(appState.currentJob?.previewKind, undefined)
  })
}

test('normal Continue explicitly ignores pending edits and preview never becomes final output', async () => {
  await useWorkflowRunStore.getState().run(checkpointWorkflow(), [])
  assert.equal(appState.currentJob?.previewKind, 'workflow-checkpoint')
  assert.equal(appState.currentJob?.outputUrl, '/workspace/source.glb')
  const token = owner()
  useWorkflowRunStore.getState().setPendingReplacement(token, editedRef())
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(useWorkflowRunStore.getState().checkpoints.wait.replacementResult?.status, 'noop')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, undefined)
  assert.equal(appState.currentJob?.outputUrl, undefined)
  assert.equal(appState.currentJob?.previewKind, undefined)
  assert.equal(useWorkflowRunStore.getState().setPendingReplacement(token, editedRef()), false)
})

test('owner mismatch rejects run/node/input version/revision without resuming or selecting', async () => {
  const workflow = checkpointWorkflow()
  const ext = addProcess(workflow, 'process', 'wait')
  await useWorkflowRunStore.getState().run(workflow, [ext])
  const token = owner()
  for (const patch of [{ runId: 'other' }, { nodeId: 'other' }, { inputArtifactId: 'other' }, { inputVersionId: 'other' }, { revision: token.revision + 1 }]) {
    const stale = { ...token, ...patch }
    assert.equal(useWorkflowRunStore.getState().setPendingReplacement(stale, editedRef()), false)
    await useWorkflowRunStore.getState().continueRun('wait', { owner: stale, replacementArtifact: editedRef() })
    assert.equal(runProcessCalls.length, 0)
  }
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.notEqual(owner().runId, token.runId)
  assert.equal(useWorkflowRunStore.getState().setPendingReplacement(token, editedRef()), false)
})

test('nested waits materialize edited parent outputs and retry invalidates descendant owners', async () => {
  const workflow = checkpointWorkflow()
  workflow.nodes.push(createNode('nested', 'waitNode'))
  const ext = addProcess(workflow, 'process', 'wait')
  workflow.edges.push({ id: 'process-nested', source: 'process', target: 'nested' })
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().getCheckpointOwner('nested'), undefined)
  await useWorkflowRunStore.getState().continueRun('nested')
  assert.equal(runProcessCalls.length, 0)
  await useWorkflowRunStore.getState().continueRun('wait', { owner: owner(), replacementArtifact: editedRef() })
  const firstNested = owner('nested')
  assert.equal(useWorkflowRunStore.getState().checkpoints.nested.input?.filePath, '/workspace/output/process.glb')
  await useWorkflowRunStore.getState().continueRun('nested')
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.notEqual(owner('nested').inputVersionId, firstNested.inputVersionId)
  assert.equal(useWorkflowRunStore.getState().setPendingReplacement(firstNested, editedRef()), false)
  assert.equal((runProcessCalls[1].input as any).filePath, '/workspace/source.glb')
})

for (const operation of ['cancel', 'reset', 'new-run'] as const) {
  test(`late process result cannot publish after ${operation}`, async () => {
    const workflow = checkpointWorkflow()
    const ext = addProcess(workflow, 'process', 'wait')
    await useWorkflowRunStore.getState().run(workflow, [ext])
    const response = deferred<any>()
    processResult = () => response.promise
    const oldOwner = owner()
    const branch = useWorkflowRunStore.getState().continueRun('wait')
    await waitFor(() => runProcessCalls.length === 1)
    if (operation === 'new-run') await useWorkflowRunStore.getState().run(checkpointWorkflow(), [])
    else useWorkflowRunStore.getState()[operation]()
    const before = JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob })
    response.resolve({ success: true, result: { filePath: '/workspace/late.glb' } })
    await branch
    assert.equal(JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob }), before)
    assert.equal(useWorkflowRunStore.getState().setPendingReplacement(oldOwner, editedRef()), false)
  })
}

const landmarkIds = ['left_shoulder', 'right_shoulder', 'hip', 'left_knee', 'right_knee'] as const
function completeCapture() {
  for (const [i, id] of landmarkIds.entries()) assert.equal(useWorkflowRunStore.getState().markLandmark(owner(), { id, name: id, source: 'manual', confidence: 1, world: { x: i, y: 1, z: 2 } }), true)
}

test('Landmarks is a manual mesh boundary without extension identity, with scoped sidecar routing', async () => {
  const workflow = checkpointWorkflow('landmarksNode')
  const ext = addProcess(workflow, 'rig-mesh', 'wait', true)
  await useWorkflowRunStore.getState().run(workflow, [ext])
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(runProcessCalls.length, 0)
  assert.equal(useWorkflowRunStore.getState().markLandmark(owner(), { id: 'hip', name: 'Hip', source: 'manual', confidence: 1, world: { x: NaN, y: 0, z: 0 } }), false)
  completeCapture()
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(runProcessCalls.length, 1)
  assert.equal((runProcessCalls[0].input as any).inputs.mesh.filePath, '/workspace/source.glb')
  assert.equal(runProcessCalls[0].params.landmarks_sidecar_path, sidecarWrites[0].sidecarWorkspacePath)
  assert.equal(sidecarWrites[0].sidecar.runId, useWorkflowRunStore.getState().executionId)
  assert.notEqual(sidecarWrites[0].sidecar.runId, workflow.id)
})

for (const operation of ['clear', 'remark', 'cancel', 'reset', 'new-run'] as const) {
  test(`deferred landmark capture cannot continue or publish after ${operation}`, async () => {
    await useWorkflowRunStore.getState().run(checkpointWorkflow('landmarksNode'), [])
    completeCapture()
    const response = deferred<any>()
    let request: any
    writeSidecar = async (input) => { request = input; return response.promise }
    const token = owner()
    const pending = useWorkflowRunStore.getState().continueRun('wait')
    await waitFor(() => !!request)
    if (operation === 'new-run') await useWorkflowRunStore.getState().run(checkpointWorkflow('landmarksNode'), [])
    else if (operation === 'clear') useWorkflowRunStore.getState().clearLandmarks(token)
    else if (operation === 'remark') useWorkflowRunStore.getState().markLandmark(token, { id: 'hip', name: 'Hip', source: 'manual', confidence: 1, world: { x: 99, y: 0, z: 0 } })
    else useWorkflowRunStore.getState()[operation]()
    const before = JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob })
    response.resolve({ success: true, sidecarWorkspacePath: request.sidecarWorkspacePath, sidecar: request.sidecar })
    await pending
    assert.equal(JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob }), before)
    assert.equal(sidecarWrites.length, 0)
  })
}

for (const preview of ['imagePreviewNode']) {
  test(`edited mesh reaches named MODEL and explicit scene through ${preview}`, async () => {
    const workflow = checkpointWorkflow()
    workflow.nodes.push(createNode('preview', preview), createNode('text', 'textNode', { enabled: true, params: { text: 'walk' } }))
    const ext = createNamedTextMeshModelExtension()
    workflow.nodes.push(createNode('animate', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }))
    workflow.edges.push({ id: 'preview', source: 'wait', target: 'preview' }, { id: 'mesh', source: 'preview', target: 'animate', targetHandle: 'rigged_mesh' }, { id: 'text', source: 'text', target: 'animate', targetHandle: 'prompt' })
    const posts = captureTextRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    await useWorkflowRunStore.getState().continueRun('wait', { owner: owner(), replacementArtifact: editedRef() })
    assert.equal((posts[0].params as any).rigged_mesh_path, 'edited.glb')
    assert.equal((posts[0].params as any).model_id, ext.id)
    assert.equal((posts[0].params as any).node_id, ext.nodeId)
    assert.equal(useWorkflowRunStore.getState().nodeArtifacts.source.uri, '/workspace/source.glb')
  })
}

test('MODEL reads only an explicitly selected edited image through Wait and keeps selected image state', async () => {
  const ext = createNamedImageModelExtension()
  const workflow = checkpointWorkflow()
  workflow.nodes[0] = createNode('source', 'imageNode', { enabled: true, params: { filePath: '/workspace/original.png' } })
  workflow.nodes.push(createNode('preview', 'imagePreviewNode'), createNode('model', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }))
  workflow.edges.push({ id: 'p', source: 'wait', target: 'preview' }, { id: 'm', source: 'preview', target: 'model', targetHandle: 'front' })
  const posts = captureImageRequests()
  const selected = appState.selectedImagePath
  await useWorkflowRunStore.getState().run(workflow, [ext])
  await useWorkflowRunStore.getState().continueRun('wait', { owner: owner(), replacementArtifact: { id: 'edit', versionId: 'v2', kind: 'image', uri: '/workspace/edited.png' } })
  assert.deepEqual(fsReadCalls, ['/workspace/edited.png'])
  assert.equal((posts[0].get('image') as File).name, 'edited.png')
  assert.equal(appState.selectedImagePath, selected)
  assert.equal(useWorkflowRunStore.getState().nodeImageOutputs.wait, '/workspace/edited.png')
})

test('explicit Wait-to-scene continuation is final, unlike a mere checkpoint preview', async () => {
  const workflow = checkpointWorkflow()
  workflow.nodes.push(createNode('output', 'outputNode'))
  workflow.edges.push({ id: 'output', source: 'wait', target: 'output' })
  await useWorkflowRunStore.getState().run(workflow, [])
  await useWorkflowRunStore.getState().continueRun('wait', { owner: owner(), replacementArtifact: editedRef() })
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/edited.glb')
  assert.equal(useWorkflowRunStore.getState().runState.artifact?.uri, '/workspace/edited.glb')
  assert.equal(appState.currentJob?.previewKind, undefined)
})

for (const output of ['audio']) {
  test(`${output} PROCESS output remains non-mesh across a checkpoint`, async () => {
    const workflow = checkpointWorkflow()
    const ext = addProcess(workflow, 'process', 'wait')
    ext.output = output
    const path = `/workspace/final.${output === 'audio' ? 'wav' : 'json'}`
    processResult = async () => ({ success: true, result: { filePath: path } })
    await useWorkflowRunStore.getState().run(workflow, [ext])
    await useWorkflowRunStore.getState().continueRun('wait')
    assert.equal(useWorkflowRunStore.getState().runState.outputPath, path)
    assert.equal(useWorkflowRunStore.getState().runState.outputUrl, undefined)
    assert.equal(appState.currentJob?.outputUrl, undefined)
  })
}

test('failed branch stays retryable, but descendants cannot bypass their failed parent', async () => {
  const workflow = checkpointWorkflow()
  const ext = addProcess(workflow, 'process', 'wait')
  workflow.nodes.push(createNode('nested', 'waitNode'))
  workflow.edges.push({ id: 'nested', source: 'process', target: 'nested' })
  processResult = async () => ({ success: false, error: 'injected failure' })
  await useWorkflowRunStore.getState().run(workflow, [ext])
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(useWorkflowRunStore.getState().waitStates.wait, 'error')
  await useWorkflowRunStore.getState().continueRun('nested')
  assert.equal(useWorkflowRunStore.getState().waitStates.nested, 'error')
  processResult = undefined
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(useWorkflowRunStore.getState().waitStates.nested, 'pending')
  await useWorkflowRunStore.getState().continueRun('nested')
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

test('While manual Retry reads live params; its Continue does not resume an unrelated Wait', async () => {
  const ext = createWorkflowExtension({ type: 'process' })
  const target = createExtensionNode(ext.id)
  target.parentId = 'loop'
  const workflow = createWorkflow(target)
  for (const node of workflow.nodes) node.position = { x: 1000, y: 1000 }
  const loop = createNode('loop', 'whileNode', { enabled: true, params: {} })
  loop.width = 500; loop.height = 300
  workflow.nodes.push(loop, createNode('wait', 'waitNode'))
  workflow.edges.push({ id: 'wait', source: target.id, target: 'wait' })
  const pending = useWorkflowRunStore.getState().run(workflow, [ext])
  await waitFor(() => useWorkflowRunStore.getState().runState.status === 'paused')
  assert.equal(runProcessCalls.length, 1)
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(runProcessCalls.length, 1)
  useWorkflowRunStore.getState().setLiveNodeParams(target.id, { count: 0, live: false })
  useWorkflowRunStore.getState().retryWhile()
  await waitFor(() => runProcessCalls.length === 2 && useWorkflowRunStore.getState().runState.status === 'paused')
  assert.deepEqual(runProcessCalls[1].params, { count: 0, live: false })
  useWorkflowRunStore.getState().continueWhile()
  await pending
  assert.equal(useWorkflowRunStore.getState().waitStates.wait, 'pending')
  assert.ok(owner())
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

test('For Each lockstep pause/retry preserves current files, advances together and reads live params', async () => {
  iteratorFileNames = ['a.glb', 'b.glb']
  const ext = createWorkflowExtension({ type: 'process', input: 'mesh', inputs: ['mesh', 'mesh'] })
  const target = createExtensionNode(ext.id)
  const workflow = { ...checkpointWorkflow(), nodes: [createNode('one', 'forEachNode', { enabled: true, params: { mode: 'mesh', dir: '/one' } }), createNode('two', 'forEachNode', { enabled: true, params: { mode: 'mesh', dir: '/two' } }), target], edges: [
    { id: 'one', source: 'one', target: target.id, targetHandle: 'input-0' }, { id: 'two', source: 'two', target: target.id, targetHandle: 'input-1' },
  ] }
  onProcessRun = () => { if (runProcessCalls.length <= 2) useWorkflowRunStore.getState().pauseWhile() }
  const pending = useWorkflowRunStore.getState().run(workflow, [ext])
  await waitFor(() => useWorkflowRunStore.getState().runState.status === 'paused')
  assert.deepEqual([...useWorkflowRunStore.getState().pausedGroup].sort(), ['one', 'two'])
  useWorkflowRunStore.getState().setLiveNodeParams(target.id, { live: true })
  useWorkflowRunStore.getState().retryWhile()
  await waitFor(() => runProcessCalls.length === 2 && useWorkflowRunStore.getState().runState.status === 'paused')
  assert.equal((runProcessCalls[0].input as any).filePath, (runProcessCalls[1].input as any).filePath)
  assert.deepEqual(runProcessCalls[1].params, { live: true })
  useWorkflowRunStore.getState().continueWhile()
  await pending
  assert.equal(runProcessCalls.length, 3)
  assert.match((runProcessCalls[2].input as any).filePath, /b\.glb$/)
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

for (const operation of ['cancel', 'reset', 'new-run'] as const) {
  test(`late model status cannot publish after ${operation}`, async () => {
    const ext = createWorkflowExtension({ input: 'text' })
    const workflow = { ...checkpointWorkflow(), nodes: [createExtensionNode(ext.id)], edges: [] }
    const response = deferred<any>()
    let polling = false
    axiosClientMock = { async post() { return { data: { job_id: 'old' } } }, async get() { polling = true; return response.promise } }
    const pending = useWorkflowRunStore.getState().run(workflow, [ext])
    await waitFor(() => polling)
    if (operation === 'new-run') await useWorkflowRunStore.getState().run(checkpointWorkflow(), [])
    else useWorkflowRunStore.getState()[operation]()
    const before = JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob })
    response.resolve({ data: { status: 'done', output_url: '/workspace/late.glb' } })
    await pending
    assert.equal(JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob }), before)
  })
}

test('preview and cancel do not overwrite an unrelated current job', async () => {
  await useWorkflowRunStore.getState().run(checkpointWorkflow(), [])
  const otherJob = { id: 'unrelated', outputUrl: '/unrelated.glb', previewKind: 'external' }
  appState.setCurrentJob(otherJob)
  useWorkflowRunStore.getState().selectCheckpoint(owner())
  useWorkflowRunStore.getState().cancel()
  assert.deepEqual(appState.currentJob, otherJob)
})


test('workspace-relative edited copies are materialized as absolute runtime PROCESS input', async () => {
  const workflow = checkpointWorkflow()
  const ext = addProcess(workflow, 'process', 'wait')
  await useWorkflowRunStore.getState().run(workflow, [ext])
  await useWorkflowRunStore.getState().continueRun('wait', { owner: owner(), replacementArtifact: { id: 'edit', versionId: 'v2', kind: 'mesh', uri: 'Workflows/edited/edit.glb' } })
  assert.equal((runProcessCalls[0].input as any).filePath, '/workspace/Workflows/edited/edit.glb')
})

test('scene MODEL preserves from-artifact routing and outputPath through a manual boundary', async () => {
  const workflow = checkpointWorkflow()
  workflow.nodes[0] = createNode('source', 'sceneNode', { enabled: true, params: { path: 'input', manifestPath: 'input/scene-manifest.json' } })
  readFile = async () => validSceneBytes()
  const ext = addProcess(workflow, 'model', 'wait')
  ext.type = 'model'; ext.input = 'scene'; ext.output = 'scene'
  const requests: any[] = []
  axiosClientMock = { async post(path, body) { requests.push(JSON.parse(JSON.stringify({ path, body }))); return { data: { job_id: 'scene' } } }, async get() { return { data: { status: 'done', output_url: '/workspace/final/scene.json' } } } }
  await useWorkflowRunStore.getState().run(workflow, [ext])
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.deepEqual(requests, [{ path: '/generate/from-artifact', body: { input_kind: 'scene', input_path: 'input/scene-manifest.json', model_id: ext.id, collection: 'Workflows', params: {} } }])
  assert.equal(useWorkflowRunStore.getState().runState.outputPath, '/workspace/final/scene.json')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, undefined)
  assert.deepEqual(fsReadCalls, ['/workspace/input/scene-manifest.json'])
})

test('scene PROCESS output survives Wait continuation with declared scene provenance', async () => {
  const workflow = checkpointWorkflow()
  const ext = addProcess(workflow, 'process', 'wait'); ext.output = 'scene'
  processResult = async () => ({ success: true, result: { filePath: '/workspace/output/scene-manifest.json' } })
  await useWorkflowRunStore.getState().run(workflow, [ext])
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(runProcessCalls.length, 1)
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().runState.outputPath, '/workspace/output/scene-manifest.json')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, undefined)
})

test('audio PROCESS input remains an audio path and is never coerced into checkpoint mesh', async () => {
  const workflow = checkpointWorkflow()
  const producer = createWorkflowExtension({ id: 'audio/generate', extensionId: 'audio', nodeId: 'generate', input: 'text', type: 'process', output: 'audio' })
  workflow.nodes[0] = createNode('source', 'extensionNode', { enabled: true, params: {}, extensionId: producer.id })
  workflow.nodes.push(createNode('text', 'textNode', { enabled: true, params: { text: 'sound' } }))
  workflow.edges.push({ id: 'text', source: 'text', target: 'source' })
  const consumer = addProcess(workflow, 'process', 'wait'); consumer.input = 'audio'; consumer.output = 'audio'
  processResult = async () => ({ success: true, result: { filePath: '/workspace/audio.wav' } })
  await useWorkflowRunStore.getState().run(workflow, [producer, consumer])
  assert.equal(appState.currentJob?.previewKind, undefined)
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal((runProcessCalls[1].input as any).filePath, '/workspace/audio.wav')
  assert.equal(useWorkflowRunStore.getState().runState.outputPath, '/workspace/audio.wav')
})

test('clearing pending edits invalidates captured exporters and original Retry resets lineage selection', async () => {
  await useWorkflowRunStore.getState().run(checkpointWorkflow(), [])
  const captured = owner()
  assert.equal(useWorkflowRunStore.getState().setPendingReplacement(captured, undefined), true)
  assert.equal(useWorkflowRunStore.getState().setPendingReplacement(captured, editedRef()), false)
  await useWorkflowRunStore.getState().continueRun('wait', { owner: owner(), replacementArtifact: editedRef() })
  const cp = useWorkflowRunStore.getState().checkpoints.wait
  assert.notEqual(cp.lineage?.currentVersionId, cp.lineage?.originalVersionId)
  await useWorkflowRunStore.getState().continueRun('wait')
  const original = useWorkflowRunStore.getState().checkpoints.wait
  assert.equal(original.lineage?.currentVersionId, original.lineage?.originalVersionId)
  assert.equal(original.lineage?.versions.length, 2)
})

for (const finishPrevious of [true, false]) {
  test(`Current Mesh keeps a prior final output but not a checkpoint preview (${finishPrevious})`, async () => {
    workspaceDir = '/real/workspace'
    const first = checkpointWorkflow()
    const ext = addProcess(first, 'process', 'wait')
    first.nodes.push(createNode('scene', 'outputNode'))
    first.edges.push({ id: 'process-scene', source: 'process', target: 'scene' })
    processResult = async () => ({ success: true, result: { filePath: `${workspaceDir}/output/result.glb` } })
    // Keep the checkpoint source in the actual workspace, not a /workspace URL.
    first.nodes[0].data.params.filePath = `${workspaceDir}/source.glb`
    await useWorkflowRunStore.getState().run(first, [ext])
    if (finishPrevious) await useWorkflowRunStore.getState().continueRun('wait')
    assert.equal(appState.currentJob?.previewKind, finishPrevious ? undefined : 'workflow-checkpoint')
    assert.equal(appState.currentJob?.outputUrl, finishPrevious ? '/workspace/output/result.glb' : '/workspace/source.glb')

    const next = checkpointWorkflow()
    next.nodes = [createNode('current', 'meshNode', { enabled: true, params: { source: 'current' } }), createNode('next', 'extensionNode', { enabled: true, extensionId: ext.id, params: {} })]
    next.edges = [{ id: 'current-next', source: 'current', target: 'next' }]
    await useWorkflowRunStore.getState().run(next, [ext])
    if (finishPrevious) {
      assert.equal(runProcessCalls.length, 2)
      assert.equal((runProcessCalls[1].input as { filePath: string }).filePath, '/real/workspace/output/result.glb')
      assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
    } else {
      assert.equal(runProcessCalls.length, 0)
      assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
      assert.match(useWorkflowRunStore.getState().runState.error ?? '', /needs an incoming mesh/)
    }
  })
}

for (const rejectCleanup of [false, true]) {
  test(`late cancelled MODEL submission cleans its own job without unhandled cleanup rejection (${rejectCleanup})`, async () => {
    const ext = createWorkflowExtension({ input: 'text' })
    const workflow = { ...checkpointWorkflow(), nodes: [createExtensionNode(ext.id)], edges: [] }
    const response = deferred<{ data: { job_id: string } }>()
    const paths: string[] = []
    axiosClientMock = {
      async post(path) {
        paths.push(path)
        if (path === '/generate/from-text') return response.promise
        assert.equal(path, '/generate/cancel/late-owned-job')
        if (rejectCleanup) throw new Error('Injected cancellation failure')
        return { data: {} }
      },
      async get() { assert.fail('A cancelled late submission must never be polled') },
    }
    const pending = useWorkflowRunStore.getState().run(workflow, [ext])
    await waitFor(() => paths.length === 1)
    useWorkflowRunStore.getState().cancel()
    const cancelled = JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob })
    response.resolve({ data: { job_id: 'late-owned-job' } })
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(paths, ['/generate/from-text', '/generate/cancel/late-owned-job'])
    assert.equal(JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob }), cancelled)
  })
}

for (const rejectCleanup of [false, true]) {
  test(`old MODEL acknowledgement uses old client and leaves newer active backend job intact (${rejectCleanup})`, async () => {
    const ext = createWorkflowExtension({ input: 'text' })
    const workflow = { ...checkpointWorkflow(), nodes: [createExtensionNode(ext.id)], edges: [] }
    const oldResponse = deferred<{ data: { job_id: string } }>()
    const oldPaths: string[] = []
    axiosClientMock = {
      async post(path) {
        oldPaths.push(path)
        if (path === '/generate/from-text') return oldResponse.promise
        assert.equal(path, '/generate/cancel/old-owned-job')
        if (rejectCleanup) throw new Error('Old client cancellation rejected')
        return { data: {} }
      },
      async get() { assert.fail('Old submission must never be polled after cancellation') },
    }
    const oldRun = useWorkflowRunStore.getState().run(workflow, [ext])
    await waitFor(() => oldPaths.length === 1)
    useWorkflowRunStore.getState().cancel()

    const newStatus = deferred<{ data: { status: string; output_url: string } }>()
    const newPaths: string[] = []
    const newPolls: string[] = []
    axiosClientMock = {
      async post(path) {
        newPaths.push(path)
        if (path === '/generate/from-text') return { data: { job_id: 'new-owned-job' } }
        assert.equal(path, '/generate/cancel/new-owned-job')
        return { data: {} }
      },
      async get(path) { newPolls.push(path); return newStatus.promise },
    }
    const newRun = useWorkflowRunStore.getState().run(workflow, [ext])
    await waitFor(() => newPolls.length === 1)
    const newerState = JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob })
    oldResponse.resolve({ data: { job_id: 'old-owned-job' } })
    await oldRun
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(oldPaths, ['/generate/from-text', '/generate/cancel/old-owned-job'])
    assert.deepEqual(newPaths, ['/generate/from-text'])
    assert.deepEqual(newPolls, ['/generate/status/new-owned-job'])
    assert.equal(JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob }), newerState)
    // The old acknowledgement must not overwrite OR clear the newer global job id.
    useWorkflowRunStore.getState().cancel()
    assert.deepEqual(newPaths, ['/generate/from-text', '/generate/cancel/new-owned-job'])
    newStatus.resolve({ data: { status: 'done', output_url: '/workspace/late-new.glb' } })
    await newRun
    assert.equal(useWorkflowRunStore.getState().runState.status, 'idle')
  })
}

for (const [label, responseValue] of [
  ['absent data', {}], ['null data', { data: null }],
  ['absent id', { data: {} }], ['null id', { data: { job_id: null } }],
  ['empty id', { data: { job_id: '' } }], ['blank id', { data: { job_id: ' \t\n ' } }],
  ['numeric id', { data: { job_id: 27 } }], ['true id', { data: { job_id: true } }],
  ['false id', { data: { job_id: false } }], ['object id', { data: { job_id: {} } }],
  ['array id', { data: { job_id: ['new-owned-job'] } }], ['empty array id', { data: { job_id: [] } }],
] as const) {
  test(`malformed late MODEL acknowledgement never targets the newer backend job (${label})`, async () => {
    const ext = createWorkflowExtension({ input: 'text' })
    const workflow = { ...checkpointWorkflow(), nodes: [createExtensionNode(ext.id)], edges: [] }
    const response = deferred<unknown>()
    const oldPaths: string[] = []
    axiosClientMock = {
      async post(path) { oldPaths.push(path); return path === '/generate/from-text' ? response.promise : { data: {} } },
      async get() { assert.fail('A stale acknowledgement must never be polled') },
    }
    const oldRun = useWorkflowRunStore.getState().run(workflow, [ext])
    await waitFor(() => oldPaths.length === 1)
    useWorkflowRunStore.getState().cancel()

    const status = deferred<unknown>(), newPaths: string[] = [], newPolls: string[] = []
    axiosClientMock = {
      async post(path) { newPaths.push(path); return { data: { job_id: 'new-owned-job' } } },
      async get(path) { newPolls.push(path); return status.promise },
    }
    const newRun = useWorkflowRunStore.getState().run(workflow, [ext])
    await waitFor(() => newPolls.length === 1)
    const newerState = JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob })
    response.resolve(responseValue)
    await oldRun
    try {
      assert.deepEqual(oldPaths, ['/generate/from-text'], 'malformed ids must not be coerced into cancellation paths')
      assert.deepEqual(newPaths, ['/generate/from-text'])
      assert.equal(JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob }), newerState)
    } finally {
      useWorkflowRunStore.getState().cancel()
      status.resolve({ data: { status: 'done', output_url: '/workspace/new.glb' } })
      await newRun
    }
    assert.deepEqual(newPaths, ['/generate/from-text', '/generate/cancel/new-owned-job'])
    assert.deepEqual(newPolls, ['/generate/status/new-owned-job'])
  })
}

test('late MODEL cleanup preserves a non-blank opaque string id without trimming it', async () => {
  const ext = createWorkflowExtension({ input: 'text' })
  const workflow = { ...checkpointWorkflow(), nodes: [createExtensionNode(ext.id)], edges: [] }
  const response = deferred<unknown>(), paths: string[] = []
  axiosClientMock = {
    async post(path) { paths.push(path); return path === '/generate/from-text' ? response.promise : { data: {} } },
    async get() { assert.fail('A cancelled MODEL must not be polled') },
  }
  const run = useWorkflowRunStore.getState().run(workflow, [ext])
  await waitFor(() => paths.length === 1)
  useWorkflowRunStore.getState().cancel()
  response.resolve({ data: { job_id: ' opaque-job:27 ' } })
  await run
  assert.deepEqual(paths, ['/generate/from-text', '/generate/cancel/ opaque-job:27 '])
})

function createKimodoAnimateExtension(overrides: Partial<WorkflowExtension> = {}): WorkflowExtension {
  return createWorkflowExtension({
    id: 'kimodo/animate-rigged-mesh',
    extensionId: 'kimodo-soma-rp',
    nodeId: 'animate-rigged-mesh',
    name: 'Animate Rigged Mesh',
    type: 'model',
    input: 'text',
    output: 'mesh',
    inputs: [
      { name: 'prompt', type: 'text', required: true },
      { name: 'rigged_mesh', type: 'mesh', required: true },
    ],
    params: [{ id: 'prompt', label: 'Prompt', type: 'string', default: 'Walk forward' }],
    ...overrides,
  })
}

function createKimodoWaitWorkflow(args: { id: string; meshFilePath?: string } ): Workflow {
  const kimodoExt = createKimodoAnimateExtension()
  return {
    id: args.id,
    name: 'Wait Before Kimodo',
    description: '',
    nodes: [
      createNode('text-source', 'textNode', { enabled: true, params: { text: 'Walk forward' } }),
      createNode('mesh-source', 'meshNode', { enabled: true, params: { source: 'file', filePath: args.meshFilePath ?? '/workspace/Workflows/generated/avatar.glb' } }),
      createNode('wait-node', 'waitNode', { extensionId: 'workflow/wait', enabled: true, params: {} }),
      createNode('kimodo-node', 'extensionNode', { extensionId: kimodoExt.id, enabled: true, params: {} }),
      createNode('output-node', 'outputNode', { enabled: true, params: {} }),
    ],
    edges: [
      { id: 'edge-text-kimodo', source: 'text-source', target: 'kimodo-node', targetHandle: 'prompt' },
      { id: 'edge-mesh-wait', source: 'mesh-source', target: 'wait-node' },
      { id: 'edge-wait-kimodo', source: 'wait-node', target: 'kimodo-node', targetHandle: 'rigged_mesh' },
      { id: 'edge-kimodo-output', source: 'kimodo-node', target: 'output-node' },
    ],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
  }
}

function waitCheckpointReviewState(nodeId = 'wait-node') {
  return useWorkflowRunStore.getState().checkpoints[nodeId]?.humanoidReview?.state
}
async function waitForHumanoidReview(nodeId = 'wait-node') {
  for (let i = 0; i < 40; i++) {
    if (waitCheckpointReviewState(nodeId)?.headline && !waitCheckpointReviewState(nodeId)!.headline.startsWith('Reading ')) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.fail('Humanoid checkpoint review did not finish')
}

test('workflowRunStore surfaces draft-only humanoid wait review state before Kimodo without inventing trust', async () => {
  const kimodoExt = createKimodoAnimateExtension()
  const workflow = createKimodoWaitWorkflow({ id: 'workflow-wait-kimodo-draft-only' })
  humanoidDraftReadResult = {
    success: true,
    status: 'found',
    sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-draft.v1.json',
    sidecar: structuredClone(humanoidDraftSidecar),
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [kimodoExt])
  await runPromise
  await waitForHumanoidReview()

  try {
    const review = waitCheckpointReviewState()
    assert.deepEqual(JSON.parse(JSON.stringify(rigMetaReadCalls)), [{ sourceWorkspacePath: 'Workflows/generated/avatar.glb' }])
    assert.deepEqual(JSON.parse(JSON.stringify(humanoidDraftReadCalls)), [{ meshWorkspacePath: 'Workflows/generated/avatar.glb' }])
    assert.deepEqual(JSON.parse(JSON.stringify(humanoidPromotionReadCalls)), [{ meshWorkspacePath: 'Workflows/generated/avatar.glb' }])
    assert.equal(review?.status, 'draft_only')
    assert.match(review?.headline ?? '', /manual review/i)
    assert.match((review?.diagnostics ?? []).join('\n'), /manual review required/i)
    assert.equal(review?.downstreamHumanoidStatus, undefined)
  } finally {
    useWorkflowRunStore.getState().cancel()
    await runPromise
  }
})
test('workflowRunStore continues Wait before Kimodo fail-closed when only a humanoid draft exists', async () => {
  const kimodoExt = createKimodoAnimateExtension()
  const workflow = createKimodoWaitWorkflow({ id: 'workflow-wait-kimodo-fail-closed' })
  const postCalls: Array<{ path: string; data: Record<string, unknown> }> = []
  humanoidDraftReadResult = {
    success: true,
    status: 'found',
    sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-draft.v1.json',
    sidecar: structuredClone(humanoidDraftSidecar),
  }

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: JSON.parse(JSON.stringify(data)) })
        return { data: { job_id: 'job-kimodo-draft-only' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/kimodo-draft-only.glb' } }
    },
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [kimodoExt])
  await runPromise
  await waitForHumanoidReview()

  await useWorkflowRunStore.getState().continueRun('wait-node')
  await runPromise

  assert.equal(postCalls.length, 1)
  assert.deepEqual(postCalls[0].data, {
    prompt: 'Walk forward',
    model_id: kimodoExt.id,
    collection: 'Workflows',
    remesh: 'none',
    enable_texture: false,
    texture_resolution: 1024,
    params: {
      prompt: 'Walk forward', text: 'Walk forward',
      rigged_mesh_path: 'Workflows/generated/avatar.glb',
      mesh_path: 'Workflows/generated/avatar.glb',
      node_id: 'animate-rigged-mesh',
      model_id: kimodoExt.id,
      motion_prompt: 'Walk forward',
    },
  })
})

test('workflowRunStore forwards only manual_confirmed humanoid promotion references downstream after Wait', async () => {
  const kimodoExt = createKimodoAnimateExtension()
  const workflow = createKimodoWaitWorkflow({ id: 'workflow-wait-kimodo-promoted' })
  const postCalls: Array<{ path: string; data: Record<string, unknown> }> = []
  humanoidDraftReadResult = {
    success: true,
    status: 'found',
    sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-draft.v1.json',
    sidecar: structuredClone(humanoidDraftSidecar),
  }
  humanoidPromotionReadResult = {
    success: true,
    status: 'found',
    sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-promotion.v1.json',
    sidecar: structuredClone(humanoidPromotionSidecar),
  }

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: JSON.parse(JSON.stringify(data)) })
        return { data: { job_id: 'job-kimodo-promoted' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/kimodo-promoted.glb' } }
    },
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [kimodoExt])
  await runPromise
  await waitForHumanoidReview()

  assert.equal(waitCheckpointReviewState()?.status, 'manual_confirmed')

  await useWorkflowRunStore.getState().continueRun('wait-node')
  await runPromise

  assert.equal(postCalls.length, 1)
  assert.deepEqual(postCalls[0].data, {
    prompt: 'Walk forward',
    model_id: kimodoExt.id,
    collection: 'Workflows',
    remesh: 'none',
    enable_texture: false,
    texture_resolution: 1024,
    params: {
      prompt: 'Walk forward', text: 'Walk forward',
      rigged_mesh_path: 'Workflows/generated/avatar.glb',
      mesh_path: 'Workflows/generated/avatar.glb',
      node_id: 'animate-rigged-mesh',
      model_id: kimodoExt.id,
      humanoid_input_status: 'manual_confirmed',
      humanoid_promotion_sidecar_path: 'Workflows/generated/avatar.humanoid-promotion.v1.json',
      motion_prompt: 'Walk forward',
    },
  })
})

test('workflowRunStore diagnoses stale humanoid promotion state before Kimodo and does not forward it', async () => {
  const kimodoExt = createKimodoAnimateExtension()
  const workflow = createKimodoWaitWorkflow({ id: 'workflow-wait-kimodo-stale' })
  const postCalls: Array<{ path: string; data: Record<string, unknown> }> = []
  humanoidDraftReadResult = {
    success: true,
    status: 'stale',
    sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-draft.v1.json',
    sidecar: structuredClone(humanoidDraftSidecar),
    staleReasons: ['mesh_output_sha256_mismatch'],
  }
  humanoidPromotionReadResult = {
    success: true,
    status: 'stale',
    sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-promotion.v1.json',
    sidecar: structuredClone(humanoidPromotionSidecar),
    staleReasons: ['draft_sha256_mismatch'],
  }

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: JSON.parse(JSON.stringify(data)) })
        return { data: { job_id: 'job-kimodo-stale' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/kimodo-stale.glb' } }
    },
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [kimodoExt])
  await runPromise
  await waitForHumanoidReview()

  const review = waitCheckpointReviewState()
  assert.equal(review?.status, 'stale')
  assert.match(review?.headline ?? '', /stale/i)
  assert.match((review?.diagnostics ?? []).join('\n'), /mesh_output_sha256_mismatch|draft_sha256_mismatch/)

  await useWorkflowRunStore.getState().continueRun('wait-node')
  await runPromise

  assert.equal(postCalls.length, 1)
  assert.deepEqual(postCalls[0].data.params, {
    prompt: 'Walk forward', text: 'Walk forward',
    rigged_mesh_path: 'Workflows/generated/avatar.glb',
    mesh_path: 'Workflows/generated/avatar.glb',
    node_id: 'animate-rigged-mesh',
    model_id: kimodoExt.id,
    motion_prompt: 'Walk forward',
  })
})

function foundPromotion(path = 'Workflows/generated/avatar.humanoid-promotion.v1.json'): HumanoidPromotionSidecarReadResult {
  return { success: true, status: 'found', sidecarWorkspacePath: path, sidecar: structuredClone(humanoidPromotionSidecar) }
}
function noPromotion(): HumanoidPromotionSidecarReadResult {
  return { success: true, status: 'not-found', sidecarWorkspacePath: 'missing.humanoid-promotion.v1.json' }
}
function humanoidOwner(id = 'wait-node') { return useWorkflowRunStore.getState().getCheckpointOwner(id)! }
function editedHumanoidMesh(path = 'Workflows/edited/replacement.glb') {
  return { id: 'edited-mesh', versionId: 'edited-v2', kind: 'mesh' as const, uri: path }
}

test('humanoid review remains checkpoint-local for two Waits, selection and out-of-order reads', async () => {
  const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: 'two-reviews' })
  workflow.nodes.push(createNode('source-b', 'meshNode', { enabled: true, params: { source: 'file', filePath: '/workspace/other.glb' } }),
    createNode('wait-b', 'waitNode'), createNode('consumer-b', 'extensionNode', { enabled: true, extensionId: ext.id, params: {} }))
  workflow.edges.push({ id: 'b-source', source: 'source-b', target: 'wait-b' },
    { id: 'b-mesh', source: 'wait-b', target: 'consumer-b', targetHandle: 'rigged_mesh' })
  const first = deferred<HumanoidPromotionSidecarReadResult>(), second = deferred<HumanoidPromotionSidecarReadResult>()
  readerPorts.readHumanoidPromotionSidecar = ({ meshWorkspacePath }) => meshWorkspacePath === 'other.glb' ? second.promise : first.promise
  await useWorkflowRunStore.getState().run(workflow, [ext])
  useWorkflowRunStore.getState().selectCheckpoint(humanoidOwner())
  second.resolve(noPromotion()); await waitForHumanoidReview('wait-b')
  assert.equal(useWorkflowRunStore.getState().activeCheckpointNodeId, 'wait-node')
  assert.equal(waitCheckpointReviewState('wait-b')?.status, 'diagnostics_only')
  first.resolve(foundPromotion()); await waitForHumanoidReview()
  assert.equal(waitCheckpointReviewState()?.status, 'manual_confirmed')
  assert.equal(waitCheckpointReviewState('wait-b')?.downstreamHumanoidStatus, undefined)
})

for (const reset of ['cancel', 'reset', 'new-run'] as const) {
  for (const rejects of [false, true]) {
    test(`humanoid ${rejects ? 'failed' : 'successful'} old read cannot change ${reset} ownership`, async () => {
      const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: 'old-review' })
      const old = deferred<HumanoidPromotionSidecarReadResult>()
      readerPorts.readHumanoidPromotionSidecar = () => old.promise
      await useWorkflowRunStore.getState().run(workflow, [ext])
      if (reset === 'new-run') {
        readerPorts.readHumanoidPromotionSidecar = async () => noPromotion()
        await useWorkflowRunStore.getState().run(workflow, [ext]); await waitForHumanoidReview()
      } else useWorkflowRunStore.getState()[reset]()
      const snapshot = JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob })
      if (rejects) old.reject(new Error('old read failed')); else old.resolve(foundPromotion())
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(JSON.stringify({ state: useWorkflowRunStore.getState(), job: appState.currentJob }), snapshot)
    })
  }
}

for (const explicit of [false, true]) {
  test(`humanoid ${explicit ? 'replacement' : 'normal'} Continue refreshes its actual artifact after pending edit`, async () => {
    const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: 'replacement-review' })
    const reads: string[] = [], posts = captureTextRequests()
    readerPorts.readHumanoidPromotionSidecar = async ({ meshWorkspacePath }) => {
      reads.push(meshWorkspacePath)
      return meshWorkspacePath.includes('replacement') ? noPromotion() : foundPromotion()
    }
    await useWorkflowRunStore.getState().run(workflow, [ext]); await waitForHumanoidReview()
    const oldOwner = humanoidOwner(), replacement = editedHumanoidMesh()
    assert.equal(useWorkflowRunStore.getState().setPendingReplacement(oldOwner, replacement), true)
    assert.notEqual(humanoidOwner().revision, oldOwner.revision)
    await useWorkflowRunStore.getState().continueRun('wait-node', { owner: oldOwner, replacementArtifact: replacement })
    assert.equal(posts.length, 0, 'stale replacement token cannot run')
    const start = reads.length
    await useWorkflowRunStore.getState().continueRun('wait-node', explicit ? { owner: humanoidOwner(), replacementArtifact: replacement } : undefined)
    const params = posts[0].params as Record<string, unknown>
    assert.equal(params.rigged_mesh_path, explicit ? 'Workflows/edited/replacement.glb' : 'Workflows/generated/avatar.glb')
    assert.equal(params.humanoid_input_status, explicit ? undefined : 'manual_confirmed')
    assert.ok(reads.slice(start).includes(String(params.rigged_mesh_path)))
    assert.equal(useWorkflowRunStore.getState().waitStates['wait-node'], 'done')
  })
}

test('old rejection after replacement clear cannot erase the current review', async () => {
  const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: 'revision-review' })
  const old = deferred<HumanoidPromotionSidecarReadResult>()
  readerPorts.readHumanoidPromotionSidecar = () => old.promise
  await useWorkflowRunStore.getState().run(workflow, [ext])
  readerPorts.readHumanoidPromotionSidecar = async () => foundPromotion()
  useWorkflowRunStore.getState().setPendingReplacement(humanoidOwner(), editedHumanoidMesh())
  useWorkflowRunStore.getState().setPendingReplacement(humanoidOwner(), undefined)
  await waitForHumanoidReview()
  const snapshot = JSON.stringify(useWorkflowRunStore.getState().checkpoints)
  old.reject(new Error('late old revision failure')); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(JSON.stringify(useWorkflowRunStore.getState().checkpoints), snapshot)
})

test('Continue reserves the branch before awaiting and cancellation cannot resume dispatch', async () => {
  const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: 'continue-lock' }), posts = captureTextRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext]); await waitForHumanoidReview()
  const pending = deferred<HumanoidPromotionSidecarReadResult>()
  readerPorts.readHumanoidPromotionSidecar = () => pending.promise
  const first = useWorkflowRunStore.getState().continueRun('wait-node')
  assert.equal(useWorkflowRunStore.getState().runningBranchId, 'wait-node')
  await useWorkflowRunStore.getState().continueRun('wait-node')
  useWorkflowRunStore.getState().cancel()
  pending.resolve(foundPromotion()); await first
  assert.equal(posts.length, 0)
  assert.equal(useWorkflowRunStore.getState().runState.status, 'idle')
})

test('Continue and actual dispatch each refresh promotion instead of trusting paused cache', async () => {
  const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: 'double-refresh' }), posts = captureTextRequests()
  let call = 0
  readerPorts.readHumanoidPromotionSidecar = async () => ++call < 3 ? foundPromotion() : noPromotion()
  workflow.nodes.find(n => n.id === 'kimodo-node')!.data.params = {
    humanoid_input_status: 'trusted', humanoid_promotion_sidecar_path: 'forged.json', unknown: false, count: 0,
  }
  await useWorkflowRunStore.getState().run(workflow, [ext]); await waitForHumanoidReview()
  assert.equal(waitCheckpointReviewState()?.status, 'manual_confirmed')
  await useWorkflowRunStore.getState().continueRun('wait-node')
  const params = posts[0].params as any
  assert.equal(call, 3); assert.equal(params.humanoid_input_status, undefined); assert.equal(params.humanoid_promotion_sidecar_path, undefined)
  assert.equal(params.unknown, false); assert.equal(params.count, 0)
})

for (const failure of ['absent', 'throw', 'reject'] as const) {
  test(`humanoid ${failure} readers degrade without blocking Continue or auto-promoting`, async () => {
    const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: failure }), posts = captureTextRequests()
    if (failure === 'absent') {
      delete readerPorts.readRigMetaSidecar; delete readerPorts.readHumanoidDraftSidecar; delete readerPorts.readHumanoidPromotionSidecar
    } else {
      const fail = () => { if (failure === 'throw') throw new Error('sync failure'); return Promise.reject(new Error('async failure')) }
      readerPorts.readRigMetaSidecar = fail; readerPorts.readHumanoidDraftSidecar = fail; readerPorts.readHumanoidPromotionSidecar = fail
    }
    readerPorts.writeHumanoidPromotionSidecar = async () => assert.fail('Wait must never promote')
    await useWorkflowRunStore.getState().run(workflow, [ext]); await waitForHumanoidReview()
    assert.equal(waitCheckpointReviewState()?.status, 'diagnostics_only')
    assert.equal(waitCheckpointReviewState()?.diagnostics.length, 3)
    await useWorkflowRunStore.getState().continueRun('wait-node')
    assert.equal((posts[0].params as any).humanoid_input_status, undefined)
    assert.equal(useWorkflowRunStore.getState().waitStates['wait-node'], 'done')
  })
}

test('reader functions are captured before await and refreshed on the next Continue', async () => {
  const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: 'reader-capture' }), posts = captureTextRequests()
  let oldCalls = 0, newCalls = 0
  readerPorts.readRigMetaSidecar = async () => {
    readerPorts.readHumanoidPromotionSidecar = async () => { newCalls++; return noPromotion() }
    return rigMetaReadResult
  }
  readerPorts.readHumanoidPromotionSidecar = async () => { oldCalls++; return foundPromotion() }
  await useWorkflowRunStore.getState().run(workflow, [ext]); await waitForHumanoidReview()
  assert.equal(oldCalls, 1); assert.equal(waitCheckpointReviewState()?.status, 'manual_confirmed')
  await useWorkflowRunStore.getState().continueRun('wait-node')
  assert.equal(newCalls, 2); assert.equal((posts[0].params as any).humanoid_input_status, undefined)
})

for (const route of ['preview', 'wrong-handle', 'competing-mesh', 'unrelated-text'] as const) {
  test(`humanoid review follows the actual ${route} consumed route`, async () => {
    const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: route }), posts = captureTextRequests()
    const meshEdge = workflow.edges.find(e => e.id === 'edge-wait-kimodo')!
    if (route === 'preview') {
      workflow.nodes.push(createNode('preview', 'imagePreviewNode')); meshEdge.source = 'preview'
      workflow.edges.push({ id: 'wait-preview', source: 'wait-node', target: 'preview' })
    } else if (route === 'wrong-handle') meshEdge.targetHandle = 'wrong-rigged_mesh'
    else {
      workflow.nodes.push(createNode('unreviewed', 'meshNode', { enabled: true, params: { source: 'file', filePath: '/workspace/unreviewed.glb' } }))
      workflow.edges.push({ id: 'other-mesh', source: 'unreviewed', target: 'kimodo-node', targetHandle: 'rigged_mesh' })
      if (route === 'unrelated-text') meshEdge.targetHandle = 'prompt'
    }
    readerPorts.readHumanoidPromotionSidecar = async ({ meshWorkspacePath }) => meshWorkspacePath.includes('avatar') ? foundPromotion() : noPromotion()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    if (route === 'preview') { await waitForHumanoidReview(); assert.equal(waitCheckpointReviewState()?.status, 'manual_confirmed') }
    else assert.equal(waitCheckpointReviewState(), undefined)
    await useWorkflowRunStore.getState().continueRun('wait-node')
    if (route === 'wrong-handle') {
      assert.equal(posts.length, 0); assert.match(useWorkflowRunStore.getState().runState.error ?? '', /Missing required rigged_mesh/)
    } else {
      const params = posts[0].params as any
      assert.equal(params.humanoid_input_status, route === 'preview' ? 'manual_confirmed' : undefined)
      assert.equal(params.rigged_mesh_path, route === 'preview' ? 'Workflows/generated/avatar.glb' : 'unreviewed.glb')
    }
  })
}

test('ordinary named providers retain reserved-looking user parameters and ignore Kimodo display labels', async () => {
  const ext = createKimodoAnimateExtension({ extensionId: 'ordinary-owner', nodeId: 'ordinary-node', name: 'Kimodo Animate Rigged Mesh' })
  const workflow = createKimodoWaitWorkflow({ id: 'ordinary' }), posts = captureTextRequests()
  workflow.nodes.find(n => n.id === 'kimodo-node')!.data.params = { humanoid_input_status: false, humanoid_promotion_sidecar_path: '', unknown: 0 }
  await useWorkflowRunStore.getState().run(workflow, [ext]); assert.equal(waitCheckpointReviewState(), undefined)
  await useWorkflowRunStore.getState().continueRun('wait-node')
  const params = posts[0].params as any
  assert.equal(params.humanoid_input_status, false); assert.equal(params.humanoid_promotion_sidecar_path, ''); assert.equal(params.unknown, 0)
  assert.equal(humanoidPromotionReadCalls.length, 0)
})

test('named PROCESS humanoid capability refreshes its own mesh without altering named transport', async () => {
  const ext = createKimodoAnimateExtension({ type: 'process' }), workflow = createKimodoWaitWorkflow({ id: 'named-process' })
  humanoidPromotionReadResult = foundPromotion()
  await useWorkflowRunStore.getState().run(workflow, [ext]); await waitForHumanoidReview()
  await useWorkflowRunStore.getState().continueRun('wait-node')
  assert.equal(runProcessCalls.length, 1)
  const input = runProcessCalls[0].input as any
  assert.equal(input.inputs.rigged_mesh.sourceNodeId, 'wait-node')
  assert.equal(input.inputs.rigged_mesh.filePath, '/workspace/Workflows/generated/avatar.glb')
  assert.equal(input.filePath, undefined)
  assert.equal(runProcessCalls[0].params.humanoid_input_status, 'manual_confirmed')
})

// Mount the real Wait and shared button hook against this file's actual-store VM.
// Only host elements/Flow are inert: subscriptions, actions and async ownership run.
async function mountCurrentWait() {
  const require = createRequire(import.meta.url)
  // The store bundle owns a separate React copy; subscribe to its actual vanilla
  // API with the renderer's React instance, as the application's bound hook does.
  const hook = (selector: (state: ReturnType<WorkflowRunStore['getState']>) => unknown) => useStore(useWorkflowRunStore, selector)
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./nodes/WaitNode.tsx', import.meta.url))],
    tsconfig: fileURLToPath(new URL('../../../tsconfig.web.json', import.meta.url)),
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react/*', '@xyflow/react', '../workflowRunStore', './workflowRunStore', './BaseNode'],
  })
  const module = { exports: {} as { default: React.ComponentType<any> } }
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, console,
    require: (id: string) => id.endsWith('/workflowRunStore') ? { useWorkflowRunStore: hook }
      : id === '@xyflow/react' ? { Handle: 'handle', Position: { Left: 'left', Right: 'right' } }
      : id === './BaseNode' ? { __esModule: true, default: ({ subheader, children }: any) => React.createElement('section', null, subheader, children) }
      : require(id),
  })
  const container: any = { children: [] }, context = {}
  const append = (parent: any, child: any) => parent.children.push(child)
  const remove = (parent: any, child: any) => parent.children.splice(parent.children.indexOf(child), 1)
  const renderer = require('react-reconciler')({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context,
    getPublicInstance: (value: any) => value, prepareForCommit: () => null, resetAfterCommit: () => {},
    createInstance: (type: string, props: any) => ({ type, props, children: [] }),
    createTextInstance: (text: string) => ({ type: '#text', text, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove,
    insertBefore: (parent: any, child: any, before: any) => parent.children.splice(parent.children.indexOf(before), 0, child),
    shouldSetTextContent: () => false, finalizeInitialChildren: () => false, prepareUpdate: () => true,
    commitUpdate: (instance: any, _payload: any, _type: any, _old: any, props: any) => { instance.props = props },
    commitTextUpdate: (instance: any, _old: any, text: string) => { instance.text = text },
    clearContainer: (target: any) => { target.children = [] },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
    detachDeletedInstance: () => {}, getCurrentEventPriority: () => 1,
  })
  const tree = renderer.createContainer(container, 0, null, false, null, '', (error: Error) => { throw error }, null)
  const act = (fn: () => void) => { renderer.flushSync(fn); renderer.flushPassiveEffects() }
  const all = (node: any = container): any[] => [node, ...node.children.flatMap((child: any) => all(child))]
  const text = (node: any = container): string => node.text ?? node.children.map(text).join('')
  const button = (label: string) => all().find(node => node.type === 'button' && text(node).trim() === label)
  act(() => renderer.updateContainer(React.createElement(module.exports.default, { id: 'wait-node', data: { enabled: true } }), tree, null))
  return { act, button, text, unmount: () => act(() => renderer.updateContainer(null, tree, null)) }
}

for (const action of ['normal', 'replacement', 'retry-done', 'retry-error'] as const) {
  for (const rejects of [false, true]) {
    test(`mounted humanoid ${action} reserves visible controls before ${rejects ? 'failed' : 'successful'} review`, async () => {
      const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: 'mounted-busy' })
      const posts = captureTextRequests(), post = axiosClientMock.post
      await useWorkflowRunStore.getState().run(workflow, [ext]); await waitForHumanoidReview()
      if (action.startsWith('retry')) {
        if (action === 'retry-error') axiosClientMock.post = async () => { throw new Error('Prior branch failed') }
        await useWorkflowRunStore.getState().continueRun('wait-node')
        assert.equal(useWorkflowRunStore.getState().waitStates['wait-node'], action === 'retry-error' ? 'error' : 'done')
        // The current run deliberately retains its captured client instance.
        axiosClientMock.post = post
        posts.length = 0
      } else {
        assert.equal(useWorkflowRunStore.getState().setPendingReplacement(humanoidOwner(), editedHumanoidMesh()), true)
        await waitForHumanoidReview()
      }
      const h = await mountCurrentWait(), gate = deferred<HumanoidPromotionSidecarReadResult>()
      const operations: Promise<void>[] = [], original = useWorkflowRunStore.getState().continueRun
      useWorkflowRunStore.setState({ continueRun: (...args) => { const operation = original(...args); operations.push(operation); return operation } })
      readerPorts.readHumanoidPromotionSidecar = () => gate.promise
      const owner = humanoidOwner()
      try {
        h.act(() => h.button(action === 'replacement' ? 'Continue with replacement' : action.startsWith('retry') ? 'Retry' : 'Continue degraded').props.onClick())
        const current = useWorkflowRunStore.getState()
        assert.equal(current.runningBranchId, 'wait-node')
        assert.equal(current.waitStates['wait-node'], 'running')
        assert.equal(current.runState.status, 'running')
        assert.equal(h.button('Running…')?.props.disabled, true)
        assert.equal(h.button('Show checkpoint')?.props.disabled, true)
        if (!action.startsWith('retry')) assert.equal(h.button('Continue with replacement')?.props.disabled, true)
        assert.doesNotMatch(h.text(), /Continuing will not send a manual_confirmed/)
        assert.equal(posts.length, 0)
        await current.continueRun('wait-node', { owner, replacementArtifact: editedHumanoidMesh() })
        assert.equal(current.selectCheckpoint(owner), false)
        assert.equal(current.setPendingReplacement(owner, undefined), false)
        if (rejects) gate.reject(new Error('Review read failed')); else gate.resolve(foundPromotion())
        await Promise.all(operations); h.act(() => {})
        assert.equal(posts.length, 1)
        const params = posts[0].params as Record<string, unknown>
        assert.equal(params.rigged_mesh_path, action === 'replacement' ? 'Workflows/edited/replacement.glb' : 'Workflows/generated/avatar.glb')
        assert.equal(params.humanoid_input_status, rejects ? undefined : 'manual_confirmed')
        assert.equal(useWorkflowRunStore.getState().waitStates['wait-node'], 'done')
        assert.equal(h.button('Retry')?.props.disabled, false)
        assert.equal(h.button('Show checkpoint')?.props.disabled, false)
        assert.equal(h.button('Continue with replacement'), undefined)
      } finally { gate.resolve(noPromotion()); await Promise.all(operations); h.unmount(); useWorkflowRunStore.getState().reset() }
    })
  }
}

test('mounted initial humanoid background hydration leaves Continue and Show usable', async () => {
  const gate = deferred<HumanoidPromotionSidecarReadResult>()
  readerPorts.readHumanoidPromotionSidecar = () => gate.promise
  await useWorkflowRunStore.getState().run(createKimodoWaitWorkflow({ id: 'mounted-hydration' }), [createKimodoAnimateExtension()])
  const h = await mountCurrentWait()
  try {
    assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
    assert.equal(useWorkflowRunStore.getState().runningBranchId, null)
    assert.equal(h.button('Continue degraded')?.props.disabled, false)
    assert.equal(h.button('Show checkpoint')?.props.disabled, false)
    assert.equal(h.button('Running…'), undefined)
    h.act(() => useWorkflowRunStore.getState().setPendingReplacement(humanoidOwner(), editedHumanoidMesh()))
    assert.equal(h.button('Continue with replacement')?.props.disabled, false)
  } finally { gate.resolve(noPromotion()); await waitForHumanoidReview(); h.unmount(); useWorkflowRunStore.getState().reset() }
})

test('mounted cancellation clears busy state and late rejection cannot clear a new current owner', async () => {
  const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: 'mounted-cancel' }), posts = captureTextRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext]); await waitForHumanoidReview()
  const h = await mountCurrentWait(), old = deferred<HumanoidPromotionSidecarReadResult>()
  let operation: Promise<void> | undefined
  try {
    readerPorts.readHumanoidPromotionSidecar = () => old.promise
    h.act(() => { operation = useWorkflowRunStore.getState().continueRun('wait-node') })
    assert.equal(h.button('Running…')?.props.disabled, true)
    h.act(() => useWorkflowRunStore.getState().cancel())
    assert.equal(h.button('Running…'), undefined)
    assert.equal(useWorkflowRunStore.getState().runState.status, 'idle')
    readerPorts.readHumanoidPromotionSidecar = async () => foundPromotion()
    await useWorkflowRunStore.getState().run(workflow, [ext]); await waitForHumanoidReview(); h.act(() => {})
    const owner = humanoidOwner()
    old.reject(new Error('Old reservation failed')); await operation; h.act(() => {})
    assert.deepEqual(humanoidOwner(), owner)
    assert.equal(h.button('Continue manual-confirmed')?.props.disabled, false)
    assert.equal(useWorkflowRunStore.getState().runningBranchId, null)
    assert.equal(posts.length, 0)
  } finally { old.resolve(noPromotion()); await operation; h.unmount(); useWorkflowRunStore.getState().reset() }
})

// Original54: provenance is descriptive lineage, never a humanoid trust receipt.
test('artifact adapter adds optional provenance without changing identity, legacy payload or absent behavior', () => {
  const provenance = { workflowId: 'workflow', workflowNodeId: 'node', extensionId: 'resolved', extensionNodeId: 'capability' }
  for (const outputType of ['image', 'mesh', 'text', 'scene', 'audio', 'video']) {
    const output = outputType === 'text' ? { text: '', outputType } : { filePath: `/workspace/result.${outputType}`, outputType }
    const original = legacyOutputToArtifactRef(output)!
    const described = legacyOutputToArtifactRef(output, { provenance })!
    assert.equal(original.kind, outputType)
    assert.deepEqual(artifactRefToLegacyOutput(original), output)
    assert.deepEqual(described, { ...original, provenance })
    assert.deepEqual(artifactRefToLegacyOutput(described), artifactRefToLegacyOutput(original))
    assert.equal(Object.hasOwn(original, 'provenance'), false)
    assert.deepEqual(legacyOutputToArtifactRef(output, { artifactId: 'run:node', versionId: 'run:node:2', provenance }), {
      ...original, id: 'run:node', versionId: 'run:node:2', provenance,
    })
  }
  for (const absent of [undefined, {}, { outputType: 'mesh' }, { outputType: 'scene' }, { filePath: '/unsupported', outputType: 'unknown' }]) {
    assert.equal(legacyOutputToArtifactRef(absent, { provenance }), undefined)
  }
  assert.equal(legacyOutputToArtifactRef({ text: 'legacy text', outputType: 'unknown' }, { provenance })?.kind, 'text')
})

for (const raw of [{ prompt: '' }, { prompt: ' \n ' }]) {
  test(`only explicit blank rigged motion fails even with optional prompt and character text: ${JSON.stringify(raw)}`, async () => {
    const ext = createKimodoAnimateExtension({ inputs: [{ name: 'prompt', type: 'text', required: false }, { name: 'rigged_mesh', type: 'mesh' }] })
    const workflow = createTextMeshWorkflow({ node: createNode('animate', 'extensionNode', { extensionId: ext.id, enabled: true, params: raw }), text: 'Character description' })
    const posts = captureTextRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(posts.length, 0)
    assert.match(useWorkflowRunStore.getState().runState.error ?? '', /Missing required motion prompt/)
    assert.deepEqual(humanoidPromotionReadCalls, [])
  })
}

for (const scenario of [
  { name: 'default is not explicit', raw: {}, connected: ' Character description ', expected: 'Character description' },
  { name: 'missing connected text uses default', raw: {}, connected: undefined, expected: 'Default motion' },
  { name: 'explicit motion is trimmed', raw: { prompt: '  Turn left  ', text: 'stale alias', motion_prompt: 'stale motion', character_prompt: 'stale character', zero: 0, flag: false }, connected: ' Character description ', expected: 'Turn left' },
  { name: 'matching character text is not duplicated', raw: { prompt: ' Turn left ', character_prompt: 'stale character' }, connected: 'Turn left', expected: 'Turn left' },
  { name: 'blank character text is not forwarded', raw: { prompt: 'Turn left', character_prompt: 'stale character' }, connected: '   ', expected: 'Turn left' },
  { name: 'non-string own prompt is not explicit motion', raw: { prompt: false }, connected: 'Character description', expected: 'Character description' },
] as const) {
  test(`rigged motion parameter presence: ${scenario.name}`, async () => {
    const ext = createKimodoAnimateExtension({ params: [{ id: 'prompt', label: 'Prompt', type: 'string', default: 'Default motion' }] })
    const workflow = createTextMeshWorkflow({ node: createNode('animate', 'extensionNode', { extensionId: ext.id, enabled: true, params: { ...scenario.raw } }), text: scenario.connected })
    if (scenario.connected === undefined) workflow.edges = workflow.edges.filter((edge) => edge.source !== 'text-source')
    const posts = captureTextRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done', useWorkflowRunStore.getState().runState.error)
    assert.equal(posts.length, 1)
    const params = posts[0].params as Record<string, unknown>
    assert.equal(posts[0].prompt, scenario.expected)
    assert.equal(params.motion_prompt, scenario.expected)
    for (const alias of ['prompt', 'text']) if (Object.hasOwn(params, alias)) assert.equal(params[alias], scenario.expected)
    assert.equal(params.character_prompt, scenario.name === 'explicit motion is trimmed' ? 'Character description' : undefined)
    if (scenario.name === 'explicit motion is trimmed') {
      assert.equal(params.zero, 0)
      assert.equal(params.flag, false)
    }
    assert.deepEqual(workflow.nodes.find((node) => node.id === 'animate')!.data.params, scenario.raw)
  })
}

for (const overrides of [
  { extensionId: 'other-provider', id: 'other/animate-rigged-mesh' },
  { nodeId: 'not-animate-rigged-mesh', id: 'kimodo/prefix-animate-rigged-mesh' },
  { inputs: undefined },
  { inputs: ['text'] },
] satisfies Partial<WorkflowExtension>[]) {
  test(`ordinary MODEL prompt precedence is not selected by label or id substring: ${JSON.stringify(overrides)}`, async () => {
    const ext = createKimodoAnimateExtension(overrides)
    const raw = { prompt: '', text: 'alias', motion_prompt: 'user motion', character_prompt: 'user character', zero: 0, flag: false, unknown: { retained: true } }
    const workflow = createTextMeshWorkflow({ node: createNode('ordinary', 'extensionNode', { extensionId: ext.id, enabled: true, params: raw }), text: '  Connected text  ' })
    const posts = captureTextRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
    assert.equal(posts[0].prompt, '  Connected text  ')
    const params = posts[0].params as Record<string, unknown>
    assert.equal(params.prompt, '  Connected text  ')
    assert.equal(params.text, '  Connected text  ')
    assert.equal(params.motion_prompt, 'user motion')
    assert.equal(params.character_prompt, 'user character')
    assert.equal(params.zero, 0)
    assert.equal(params.flag, false)
    assert.deepEqual(params.unknown, { retained: true })
  })
}

test('named Kimodo PROCESS retains separate prompt and typed text input instead of applying MODEL motion routing', async () => {
  const ext = createKimodoAnimateExtension({ type: 'process' })
  const workflow = createTextMeshWorkflow({ node: createNode('animate', 'extensionNode', { extensionId: ext.id, enabled: true, params: { prompt: '', text: 'own alias', motion_prompt: 'own motion' } }), text: 'Character description' })
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(runProcessCalls.length, 1)
  assert.deepEqual(runProcessCalls[0].params, { prompt: '', text: 'own alias', motion_prompt: 'own motion' })
  assert.equal((runProcessCalls[0].input as any).inputs.prompt.text, 'Character description')
})

for (const targetHandle of [undefined, 'input-0']) {
  test(`legacy positional text MODEL remains connected-first without named semantics: ${targetHandle ?? 'no handle'}`, async () => {
    const ext = createKimodoAnimateExtension({ inputs: ['text'] })
    const workflow = createTextMeshWorkflow({ node: createNode('animate', 'extensionNode', { extensionId: ext.id, enabled: true, params: { prompt: 'Own prompt' } }), text: 'Legacy connected', includeMeshEdge: false })
    workflow.edges[0].targetHandle = targetHandle
    const posts = captureTextRequests()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
    assert.equal(posts[0].prompt, 'Legacy connected')
    assert.equal((posts[0].params as Record<string, unknown>).motion_prompt, undefined)
  })
}

for (const targetHandle of [undefined, 'input-0']) {
  test(`single-input legacy UniRig PROCESS keeps routing and landmark sidecar: ${targetHandle ?? 'no handle'}`, async () => {
    const workflow = checkpointWorkflow('landmarksNode')
    const ext = addProcess(workflow, 'rig-mesh', 'wait')
    ext.extensionId = 'unirig-tools'
    ext.name = 'UniRig Rig Mesh'
    ext.params = [{ id: 'quality', label: 'Quality', type: 'string', default: 'draft' }]
    workflow.edges.find((edge) => edge.target === 'rig-mesh')!.targetHandle = targetHandle
    await useWorkflowRunStore.getState().run(workflow, [ext])
    completeCapture()
    await useWorkflowRunStore.getState().continueRun('wait')
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
    assert.equal(runProcessCalls.length, 1)
    assert.deepEqual(runProcessCalls[0], { extensionId: 'unirig-tools', input: { filePath: '/workspace/source.glb', nodeId: 'rig-mesh' }, params: {
      quality: 'draft', landmarks_sidecar_path: sidecarWrites[0].sidecarWorkspacePath,
    } })
    assert.equal(sidecarWrites[0].sidecar.runId, useWorkflowRunStore.getState().executionId)
    assert.equal(useWorkflowRunStore.getState().nodeArtifacts.source.provenance, undefined)
    assert.deepEqual({ ...useWorkflowRunStore.getState().nodeArtifacts['rig-mesh'].provenance }, { workflowId: workflow.id, workflowNodeId: 'rig-mesh', extensionId: 'unirig-tools', extensionNodeId: 'rig-mesh' })
  })
}

test('motion MODEL reads fresh explicit params at paused Continue and failed Retry without losing revision identity', async () => {
  const ext = createKimodoAnimateExtension(), workflow = createKimodoWaitWorkflow({ id: 'motion-live-retry' })
  workflow.nodes.find((node) => node.id === 'kimodo-node')!.data.params = { prompt: 'Saved motion' }
  const posts = captureTextRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  await waitForHumanoidReview()
  const source = useWorkflowRunStore.getState().nodeArtifacts['mesh-source']
  const runId = useWorkflowRunStore.getState().executionId!
  assert.equal(source.provenance, undefined)
  useWorkflowRunStore.getState().setLiveNodeParams('kimodo-node', { prompt: '' })
  await useWorkflowRunStore.getState().continueRun('wait-node')
  assert.equal(posts.length, 0)
  assert.equal(useWorkflowRunStore.getState().waitStates['wait-node'], 'error')
  useWorkflowRunStore.getState().setLiveNodeParams('kimodo-node', { prompt: ' Live motion ' })
  await useWorkflowRunStore.getState().continueRun('wait-node')
  assert.equal(posts[0].prompt, 'Live motion')
  const first = useWorkflowRunStore.getState().nodeArtifacts['kimodo-node']
  assert.equal(first.id, `${runId}:kimodo-node`)
  assert.equal(first.versionId, `${runId}:kimodo-node:1`)
  assert.deepEqual({ ...first.provenance }, { workflowId: workflow.id, workflowNodeId: 'kimodo-node', extensionId: ext.extensionId, extensionNodeId: ext.nodeId })
  assert.deepEqual(useWorkflowRunStore.getState().runState.artifact, first)
  useWorkflowRunStore.getState().setLiveNodeParams('kimodo-node', { prompt: 'Retry motion' })
  await useWorkflowRunStore.getState().continueRun('wait-node')
  const second = useWorkflowRunStore.getState().nodeArtifacts['kimodo-node']
  assert.equal(posts[1].prompt, 'Retry motion')
  assert.equal(second.id, first.id)
  assert.equal(second.versionId, `${runId}:kimodo-node:2`)
  assert.deepEqual(second.provenance, first.provenance)
  assert.deepEqual(useWorkflowRunStore.getState().checkpoints['wait-node'].lineage?.versions[0].ref, source)
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.notEqual(useWorkflowRunStore.getState().executionId, runId)
  assert.notEqual(useWorkflowRunStore.getState().nodeArtifacts['mesh-source'].id, source.id)
  assert.equal(useWorkflowRunStore.getState().nodeArtifacts['kimodo-node'], undefined)
})

test('motion MODEL recaptures raw explicit presence on While Retry and falls back to connected text when removed', async () => {
  const ext = createKimodoAnimateExtension()
  const target = createNode('animate', 'extensionNode', { enabled: true, extensionId: ext.id, params: { prompt: 'Initial motion' } })
  target.parentId = 'loop'
  const workflow = createTextMeshWorkflow({ node: target, text: 'Connected motion' })
  for (const node of workflow.nodes) node.position = { x: 1000, y: 1000 }
  const loop = createNode('loop', 'whileNode', { enabled: true, params: {} })
  loop.width = 500; loop.height = 300
  workflow.nodes.push(loop)
  const posts = captureTextRequests()
  const pending = useWorkflowRunStore.getState().run(workflow, [ext])
  try {
    await waitFor(() => useWorkflowRunStore.getState().runState.status === 'paused')
    useWorkflowRunStore.getState().setLiveNodeParams(target.id, { prompt: 'Retry motion' })
    useWorkflowRunStore.getState().retryWhile()
    await waitFor(() => posts.length === 2 && useWorkflowRunStore.getState().runState.status === 'paused')
    useWorkflowRunStore.getState().setLiveNodeParams(target.id, {})
    useWorkflowRunStore.getState().retryWhile()
    await waitFor(() => posts.length === 3 && useWorkflowRunStore.getState().runState.status === 'paused')
    useWorkflowRunStore.getState().continueWhile()
    await pending
  } finally {
    if (useWorkflowRunStore.getState().runState.status !== 'done') useWorkflowRunStore.getState().cancel()
    await pending
  }
  assert.deepEqual(posts.map((post) => post.prompt), ['Initial motion', 'Retry motion', 'Connected motion'])
  assert.deepEqual(posts.map((post) => (post.params as Record<string, unknown>).motion_prompt), ['Initial motion', 'Retry motion', 'Connected motion'])
  assert.deepEqual(posts.map((post) => (post.params as Record<string, unknown>).character_prompt), ['Connected motion', 'Connected motion', undefined])
  const artifact = useWorkflowRunStore.getState().nodeArtifacts.animate
  assert.equal(artifact.versionId, `${useWorkflowRunStore.getState().executionId}:animate:3`)
  assert.equal(artifact.provenance?.workflowNodeId, 'animate')
})

for (const type of ['model', 'process'] as const) {
  for (const targetHandle of [undefined, 'input-0', 'mesh']) {
    test(`named rigged ${type} rejects non-declared mesh route without borrowing authority: ${targetHandle ?? 'no handle'}`, async () => {
      const ext = createKimodoAnimateExtension({ type })
      const workflow = createTextMeshWorkflow({ node: createNode('animate', 'extensionNode', { extensionId: ext.id, enabled: true, params: { prompt: 'Move' } }) })
      workflow.edges.find((edge) => edge.source === 'mesh-source')!.targetHandle = targetHandle
      const posts = captureTextRequests()
      humanoidPromotionReadResult = foundPromotion()
      await useWorkflowRunStore.getState().run(workflow, [ext])
      assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
      assert.equal(posts.length, 0)
      assert.equal(runProcessCalls.length, 0)
      assert.deepEqual(humanoidPromotionReadCalls, [])
      assert.equal(useWorkflowRunStore.getState().nodeArtifacts.animate, undefined)
    })
  }
}

test('provenance follows an extension checkpoint original, not the edited copy or source', async () => {
  const workflow = checkpointWorkflow()
  const producer = createWorkflowExtension({ id: 'resolved-alias', extensionId: 'actual-provider', nodeId: 'actual-capability', type: 'process', input: 'mesh' })
  workflow.nodes.push(createNode('producer', 'extensionNode', { extensionId: producer.id, enabled: true, params: {} }))
  workflow.edges = [{ id: 'source-producer', source: 'source', target: 'producer' }, { id: 'producer-wait', source: 'producer', target: 'wait' }]
  const consumer = addProcess(workflow, 'consumer', 'wait')
  await useWorkflowRunStore.getState().run(workflow, [producer, consumer])
  const first = useWorkflowRunStore.getState().nodeArtifacts.producer
  assert.deepEqual({ ...first.provenance }, { workflowId: workflow.id, workflowNodeId: 'producer', extensionId: 'actual-provider', extensionNodeId: 'actual-capability' })
  assert.equal(useWorkflowRunStore.getState().nodeArtifacts.source.provenance, undefined)
  assert.equal(useWorkflowRunStore.getState().checkpoints.wait.substitutionPoint?.inputArtifact, first)
  assert.equal(useWorkflowRunStore.getState().checkpoints.wait.lineage?.versions[0].ref, first)
  assert.equal(useWorkflowRunStore.getState().setPendingReplacement(owner(), editedRef()), true)
  await useWorkflowRunStore.getState().continueRun('wait', { owner: owner(), replacementArtifact: editedRef() })
  const state = useWorkflowRunStore.getState()
  assert.equal(state.nodeArtifacts.wait.provenance, undefined)
  assert.equal(state.checkpoints.wait.lineage?.versions[0].ref, first)
  assert.equal(state.checkpoints.wait.lineage?.versions[1].ref.provenance, undefined)
  assert.equal(state.checkpoints.wait.lineage?.versions[1].parentVersionId, first.versionId)
  assert.equal(state.nodeArtifacts.consumer.provenance?.workflowNodeId, 'consumer')
  assert.equal(state.nodeArtifacts.consumer.provenance?.extensionNodeId, consumer.nodeId)
  assert.equal(Object.hasOwn(state.nodeArtifacts.consumer.provenance!, 'trusted'), false)
})

test('For Each artifacts remain provenance-free while successful extension revisions retain their resolved producer', async () => {
  iteratorFileNames = ['a.glb', 'b.glb']
  const ext = createWorkflowExtension({ type: 'process', input: 'mesh' })
  const target = createExtensionNode(ext.id)
  const workflow = { ...checkpointWorkflow(), nodes: [createNode('iterator', 'forEachNode', { enabled: true, params: { mode: 'mesh', dir: '/workspace/rigs' } }), target], edges: [{ id: 'input', source: 'iterator', target: target.id }] }
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(runProcessCalls.length, 2)
  const state = useWorkflowRunStore.getState()
  assert.equal(state.nodeArtifacts.iterator.provenance, undefined)
  assert.equal(state.nodeArtifacts.iterator.versionId, `${state.executionId}:iterator:2`)
  assert.equal(state.nodeArtifacts[target.id].versionId, `${state.executionId}:${target.id}:2`)
  assert.deepEqual({ ...state.nodeArtifacts[target.id].provenance }, { workflowId: workflow.id, workflowNodeId: target.id, extensionId: ext.extensionId, extensionNodeId: ext.nodeId })
})

test('inherited raw prompt is not an explicit motion parameter', async () => {
  const ext = createKimodoAnimateExtension()
  const raw = Object.create({ prompt: 'Inherited motion' })
  const workflow = createTextMeshWorkflow({ node: createNode('animate', 'extensionNode', { extensionId: ext.id, enabled: true, params: raw }), text: 'Connected motion' })
  const posts = captureTextRequests()
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(posts[0].prompt, 'Connected motion')
  assert.equal((posts[0].params as Record<string, unknown>).motion_prompt, 'Connected motion')
  assert.equal((posts[0].params as Record<string, unknown>).character_prompt, undefined)
})

test('workflowRunStore resolves a paused checkpoint viewer target from the selected current owner', async () => {
  await useWorkflowRunStore.getState().run(checkpointWorkflow(), [])
  const state = useWorkflowRunStore.getState()
  const checkpoint = state.checkpoints.wait
  const input = checkpoint.substitutionPoint?.inputArtifact
  assert.ok(input)
  assert.equal(state.activeCheckpointNodeId, 'wait')
  assert.equal(input.id, owner().inputArtifactId)
  assert.equal(input.versionId, owner().inputVersionId)
  assert.equal(appState.currentJob?.status, 'generating')
  const target = resolveViewerAssetTarget({ currentJob: appState.currentJob as unknown as GenerationJob,
    apiUrl: appState.apiUrl, workflowArtifact: input })
  assert.deepEqual(target, {
    kind: 'workflow-checkpoint', modelUrl: 'http://inert.invalid/workspace/source.glb',
    isCheckpointPreview: true, label: 'Temporary checkpoint — not final output',
    sourceLabel: 'Temporary checkpoint — not final output', sourceKind: 'workflow',
    workspacePath: 'source.glb', artifactId: input.id, versionId: input.versionId,
  })
  useWorkflowRunStore.getState().cancel()
})

test('workflowRunStore keeps final viewer identity and drops stale artifact metadata after actual mesh-history undo', async () => {
  const workflow = checkpointWorkflow()
  workflow.nodes.push(createNode('output', 'outputNode'))
  workflow.edges.push({ id: 'output', source: 'wait', target: 'output' })
  await useWorkflowRunStore.getState().run(workflow, [])
  await useWorkflowRunStore.getState().continueRun('wait', { owner: owner() })
  const { runState } = useWorkflowRunStore.getState()
  const artifact = runState.artifact
  assert.ok(artifact)
  assert.equal(runState.status, 'done')
  assert.equal(appState.currentJob?.status, 'done')
  const currentJob = appState.currentJob as unknown as GenerationJob
  assert.deepEqual(resolveViewerAssetTarget({ currentJob, apiUrl: appState.apiUrl, workflowArtifact: artifact }), {
    kind: 'final', modelUrl: 'http://inert.invalid/workspace/source.glb', isCheckpointPreview: false,
    label: 'Final output', sourceLabel: 'Final output', sourceKind: 'workflow', workspacePath: 'source.glb',
    artifactId: artifact.id, versionId: artifact.versionId,
  })
  // Run the real app store history reducer; no native/storage/backend calls.
  const { useAppStore } = await import('../../shared/stores/appStore.ts')
  const before = useAppStore.getState()
  try {
    useAppStore.getState().setCurrentJob(currentJob)
    useAppStore.getState().pushMeshUrl('/workspace/history/older.glb')
    useAppStore.getState().pushMeshUrl(currentJob.outputUrl!)
    useAppStore.getState().undoMesh()
    assert.equal(useAppStore.getState().currentJob?.outputUrl, '/workspace/history/older.glb')
    assert.deepEqual(resolveViewerAssetTarget({ currentJob: useAppStore.getState().currentJob,
      apiUrl: appState.apiUrl, workflowArtifact: artifact, sourceKind: 'history' }), {
      kind: 'final', modelUrl: 'http://inert.invalid/workspace/history/older.glb', isCheckpointPreview: false,
      label: 'Final output', sourceLabel: 'Final output', sourceKind: 'history', workspacePath: 'history/older.glb',
    })
  } finally { useAppStore.setState(before, true) }
})

test('actual store preserves repeated scene slots, text index and scene provenance without image fallback contamination', async () => {
  const { workflow, ext } = sceneWorkflow()
  ext.type = 'process'; ext.inputs = ['scene', 'text', 'scene']; ext.output = 'scene'
  workflow.nodes.push(createNode('scene-b', 'sceneNode', { enabled: true, params: { path: 'Scenes/b', manifestPath: 'Scenes/b/scene-manifest.json' } }),
    createNode('prompt', 'textNode', { enabled: true, params: { text: 'combine' } }))
  workflow.edges = [
    { id: 'b', source: 'scene-b', target: 'scene-model', targetHandle: 'input-2' },
    { id: 'a', source: 'scene-source', target: 'scene-model', targetHandle: 'input-0' },
    { id: 't', source: 'prompt', target: 'scene-model', targetHandle: 'input-1' },
  ]
  readFile = async () => validSceneBytes()
  processResult = async () => ({ success: true, result: { filePath: '/workspace/result/scene-manifest.json', outputType: 'scene' } })
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  const input = runProcessCalls[0].input as any
  assert.deepEqual(input.inputs, {
    'input-0': { type: 'scene', filePath: '/workspace/Scenes/hero/scene-manifest.json', sourceNodeId: 'scene-source' },
    'input-1': { type: 'text', text: 'combine', sourceNodeId: 'prompt' },
    'input-2': { type: 'scene', filePath: '/workspace/Scenes/b/scene-manifest.json', sourceNodeId: 'scene-b' },
  })
  assert.equal(input.filePath, '/workspace/Scenes/hero/scene-manifest.json')
  assert.deepEqual(input.texts, [null, 'combine']) // JSON IPC fixture retains the legacy sparse texts array.
  assert.equal(runProcessCalls[0].params.extra_image_paths, undefined)
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, undefined)
})

for (const boundary of ['input-validation', 'worker-and-output-validation']) {
  for (const outcome of ['resolve', 'reject']) test(`late scene PROCESS ${boundary} ${outcome} cannot resurrect cancelled/replaced state`, async () => {
    const { workflow, ext } = sceneWorkflow(); ext.type = 'process'
    let release!: (value: any) => void, reject!: (error: Error) => void
    const gate = new Promise<any>((resolve, fail) => { release = resolve; reject = fail })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    readFile = async () => { if (boundary === 'input-validation') { entered(); return gate }; return validSceneBytes() }
    processResult = async () => { entered(); return gate }
    const pending = useWorkflowRunStore.getState().run(workflow, [ext])
    await started
    useWorkflowRunStore.getState().cancel()
    useWorkflowRunStore.getState().reset()
    const replacement = checkpointWorkflow(); replacement.id = 'replacement'
    await useWorkflowRunStore.getState().run(replacement, [])
    const state = useWorkflowRunStore.getState(), job = appState.currentJob
    const stateBytes = JSON.stringify(state), jobBytes = JSON.stringify(job)
    if (outcome === 'reject') reject(new Error('late boundary failed'))
    else release(boundary === 'input-validation' ? validSceneBytes() : { success: true, result: { filePath: '/workspace/stale/scene-manifest.json' } })
    await pending
    assert.equal(useWorkflowRunStore.getState(), state)
    assert.equal(JSON.stringify(state), stateBytes)
    assert.equal(appState.currentJob, job)
    assert.equal(JSON.stringify(job), jobBytes)
  })
}

test('declared scene output never uses legacy input fallback when the process returns no explicit file', async () => {
  const { workflow, ext } = sceneWorkflow(); ext.type = 'process'
  readFile = async () => validSceneBytes()
  processResult = async () => ({ success: true, result: { outputType: 'scene' } })
  await useWorkflowRunStore.getState().run(workflow, [ext])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /explicit scene manifest/)
})

for (const name of ['__proto__', 'constructor', 'toString', 'normal']) {
  test(`named scene port ownership allows omitted optional ${name}`, async () => {
    const ext = createWorkflowExtension({ type: 'process', output: 'audio', inputs: [
      { name: 'reference', type: 'image' }, { name, type: 'scene', required: false },
    ] })
    const workflow = createWorkflow(createExtensionNode(ext.id))
    workflow.edges[0].targetHandle = 'reference'
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done', useWorkflowRunStore.getState().runState.error)
    assert.equal(runProcessCalls.length, 1)
    const input = runProcessCalls[0].input as { inputs: Record<string, unknown> }
    assert.equal(Object.hasOwn(input.inputs, name), false)
    assert.deepEqual(input.inputs, { reference: { type: 'image', sourceNodeId: 'image-source', filePath: '/tmp/source.png' } })
  })

  test(`named scene port ownership preserves connected optional ${name}`, async () => {
    const ext = createWorkflowExtension({ type: 'process', output: 'audio', inputs: [
      { name: 'reference', type: 'image' }, { name, type: 'scene', required: false },
    ] })
    const workflow = createWorkflow(createExtensionNode(ext.id))
    workflow.edges[0].targetHandle = 'reference'
    workflow.nodes.push(createNode('scene-source', 'sceneNode', { enabled: true, params: { path: 'Scenes/hero' } }))
    workflow.edges.push({ id: 'scene-input', source: 'scene-source', target: 'node-1', targetHandle: name })
    readFile = async () => validSceneBytes()
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(useWorkflowRunStore.getState().runState.status, 'done', useWorkflowRunStore.getState().runState.error)
    assert.equal(runProcessCalls.length, 1)
    const input = runProcessCalls[0].input as { inputs: Record<string, unknown> }
    assert.equal(Object.hasOwn(input.inputs, name), true)
    assert.deepEqual(input.inputs, {
      reference: { type: 'image', sourceNodeId: 'image-source', filePath: '/tmp/source.png' },
      [name]: { type: 'scene', sourceNodeId: 'scene-source', filePath: '/workspace/Scenes/hero/scene-manifest.json' },
    })
    assert.equal(Object.hasOwn(input, 'filePath'), false)
    assert.equal(Object.hasOwn(input, 'text'), false)
  })

  test(`named scene port ownership rejects missing required ${name}`, async () => {
    const ext = createWorkflowExtension({ type: 'process', output: 'audio', inputs: [
      { name: 'reference', type: 'image' }, { name, type: 'scene', required: true },
    ] })
    const workflow = createWorkflow(createExtensionNode(ext.id))
    workflow.edges[0].targetHandle = 'reference'
    await useWorkflowRunStore.getState().run(workflow, [ext])
    assert.equal(runProcessCalls.length, 0)
    assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
    assert.ok(useWorkflowRunStore.getState().runState.error?.includes(`Required port "${name}" is missing.`))
  })
}

test('buildModelGenerationRequest creates a payload-only request for inputless model sources', () => {
  const ext = createWorkflowExtension({
    id: 'gaussiangpt/generate',
    extensionId: 'gaussiangpt',
    nodeId: 'generate',
    input: 'none',
    output: 'scene',
  })
  const node = createExtensionNode(ext.id)
  node.data.params = { seed: 17, num_points: 32768 }

  const request = buildModelGenerationRequest({
    ext,
    node,
    nodeParams: node.data.params,
    selectedImagePath: '/tmp/must-not-be-used.png',
    selectedImageData: Buffer.from('must-not-be-used').toString('base64'),
    workspaceDir: '/workspace',
  })

  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    kind: 'none',
    payload: {
      model_id: 'gaussiangpt/generate',
      collection: 'Workflows',
      remesh: 'none',
      enable_texture: false,
      texture_resolution: 1024,
      params: { seed: 17, num_points: 32768 },
    },
  })
})

test('workflowRunStore runs an inputless model as a source through generate/from-none', async () => {
  const ext = createWorkflowExtension({
    id: 'gaussiangpt/generate',
    extensionId: 'gaussiangpt',
    nodeId: 'generate',
    name: 'GaussianGPT',
    input: 'none',
    output: 'scene',
    params: [{ id: 'seed', label: 'Seed', type: 'int', default: 0 }],
  })
  const node = createExtensionNode(ext.id)
  node.data.params = { seed: 23 }
  const workflow: Workflow = {
    id: 'workflow-inputless-source',
    name: 'Inputless source',
    description: '',
    nodes: [node],
    edges: [],
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  }
  const postCalls: Array<{ path: string; data: unknown }> = []

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      postCalls.push({ path, data: JSON.parse(JSON.stringify(data)) })
      if (path === '/generate/from-none') return { data: { job_id: 'job-gaussiangpt-none' } }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-gaussiangpt-none')
      return { data: { status: 'done', output_url: '/workspace/Workflows/gaussiangpt/scene-manifest.json' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.deepEqual(postCalls, [{
    path: '/generate/from-none',
    data: {
      model_id: 'gaussiangpt/generate',
      collection: 'Workflows',
      remesh: 'none',
      enable_texture: false,
      texture_resolution: 1024,
      params: { seed: 23 },
    },
  }])
  assert.deepEqual(fsReadCalls, [])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().runState.outputPath, '/workspace/Workflows/gaussiangpt/scene-manifest.json')
  assert.equal(useWorkflowRunStore.getState().nodeArtifacts[node.id]?.kind, 'scene')
})


test('workflowRunStore never falls back from an unrelated prior output into an inputless model', async () => {
  const ext = createWorkflowExtension({
    id: 'gaussiangpt/generate',
    extensionId: 'gaussiangpt',
    nodeId: 'generate',
    name: 'GaussianGPT',
    input: 'none',
    output: 'scene',
    params: [{ id: 'seed', label: 'Seed', type: 'int', default: 0 }],
  })
  const noneNode = createExtensionNode(ext.id)
  noneNode.data.params = { seed: 31 }
  const workflow: Workflow = {
    id: 'workflow-inputless-after-unrelated-output',
    name: 'Inputless after unrelated output',
    description: '',
    nodes: [
      createNode('unrelated-image', 'imageNode', {
        enabled: true,
        params: { filePath: '/workspace/unrelated/source.png' },
      }),
      noneNode,
    ],
    edges: [],
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  }
  const postCalls: Array<{ path: string; data: unknown }> = []

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      postCalls.push({ path, data: JSON.parse(JSON.stringify(data)) })
      if (path === '/generate/from-none') return { data: { job_id: 'job-none-no-fallback' } }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-none-no-fallback')
      return { data: { status: 'done', output_url: '/workspace/Workflows/no-fallback/scene-manifest.json' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.deepEqual(postCalls, [{
    path: '/generate/from-none',
    data: {
      model_id: 'gaussiangpt/generate',
      collection: 'Workflows',
      remesh: 'none',
      enable_texture: false,
      texture_resolution: 1024,
      params: { seed: 31 },
    },
  }])
  assert.deepEqual(Object.keys(postCalls[0].data as Record<string, unknown>).sort(), [
    'collection',
    'enable_texture',
    'model_id',
    'params',
    'remesh',
    'texture_resolution',
  ])
  assert.deepEqual(fsReadCalls, [])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})


test('shouldUsePreviousNodeFallback disables positional fallback only for inputless models', () => {
  assert.equal(shouldUsePreviousNodeFallback('none'), false)
  assert.equal(shouldUsePreviousNodeFallback('image'), true)
  assert.equal(shouldUsePreviousNodeFallback('text'), true)
  assert.equal(shouldUsePreviousNodeFallback('scene'), true)
})

test('workflowRunStore fails stale incoming edges into inputless models with an actionable runtime error', async () => {
  const ext = createWorkflowExtension({
    id: 'gaussiangpt/generate',
    extensionId: 'gaussiangpt',
    nodeId: 'generate',
    name: 'GaussianGPT',
    input: 'none',
    output: 'scene',
    params: [],
  })
  const workflow: Workflow = {
    id: 'workflow-inputless-stale-edge',
    name: 'Inputless stale edge',
    description: '',
    nodes: [
      createNode('image-source', 'imageNode', { enabled: true, params: { filePath: '/workspace/input.png' } }),
      createNode('none-node', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
    ],
    edges: [{ id: 'edge-illegal', source: 'image-source', target: 'none-node' }],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /declares input "none" and cannot accept incoming edges/i)
})

test('workflowRunStore fails when actual generation output kind mismatches the declared model output and does not route it', async () => {
  const ext = createWorkflowExtension({
    id: 'gaussiangpt/generate',
    extensionId: 'gaussiangpt',
    nodeId: 'generate',
    name: 'GaussianGPT',
    input: 'none',
    output: 'mesh',
    params: [],
  })
  const workflow: Workflow = {
    id: 'workflow-output-kind-mismatch',
    name: 'Output kind mismatch',
    description: '',
    nodes: [
      createNode('model-node', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
      createNode('worlds-node', 'addToWorldsNode', { enabled: true, params: {} }),
    ],
    edges: [{ id: 'edge-worlds', source: 'model-node', target: 'worlds-node' }],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-none') return { data: { job_id: 'job-kind-mismatch' } }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-kind-mismatch')
      return { data: { status: 'done', output_url: '/workspace/Workflows/generated/scene-manifest.json', output_kind: 'scene' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /declared output "mesh" but generated "scene"/i)
  assert.deepEqual(Array.from(useWorldsSceneStore.getState().sceneItems), [])
})

test('workflowRunStore falls back to declared output when generation status omits actual output kind', async () => {
  const ext = createWorkflowExtension({
    id: 'gaussiangpt/generate',
    extensionId: 'gaussiangpt',
    nodeId: 'generate',
    name: 'GaussianGPT',
    input: 'none',
    output: 'mesh',
    params: [],
  })
  const workflow: Workflow = {
    id: 'workflow-output-kind-fallback',
    name: 'Output kind fallback',
    description: '',
    nodes: [createNode('model-node', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} })],
    edges: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-none') return { data: { job_id: 'job-kind-fallback' } }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-kind-fallback')
      return { data: { status: 'done', output_url: '/workspace/Workflows/generated.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().nodeArtifacts['model-node']?.kind, 'mesh')
})

test('workflowRunStore uses actual scene output kind for Add to Worlds scene routing', async () => {
  const ext = createWorkflowExtension({
    id: 'gaussiangpt/generate',
    extensionId: 'gaussiangpt',
    nodeId: 'generate',
    name: 'GaussianGPT',
    input: 'none',
    output: 'scene',
    params: [],
  })
  const workflow: Workflow = {
    id: 'workflow-scene-worlds-routing',
    name: 'Scene worlds routing',
    description: '',
    nodes: [
      createNode('model-node', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} }),
      createNode('worlds-node', 'addToWorldsNode', { enabled: true, params: {} }),
    ],
    edges: [{ id: 'edge-worlds', source: 'model-node', target: 'worlds-node' }],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({
      schema: 'modly.scene-manifest.v1',
      sceneRoot: '.',
      generator: 'modly.worlds',
      version: 1,
      createdAt: '2026-07-12T00:00:00.000Z',
      assets: [{
        id: 'base',
        role: 'base-scene',
        workspacePath: 'Workflows/generated/base.glb',
        kind: 'glb',
        visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }],
    }),
  } as Response)) as typeof fetch

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-none') return { data: { job_id: 'job-scene-worlds' } }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-scene-worlds')
      return { data: { status: 'done', output_url: '/workspace/Workflows/generated/scene-manifest.json', output_kind: 'scene' } }
    },
  }

  try {
    await useWorkflowRunStore.getState().run(workflow, [ext])
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().nodeArtifacts['model-node']?.kind, 'scene')
  assert.deepEqual(Array.from(useWorldsSceneStore.getState().sceneItems, (item) => item.id), ['base'])
})
