import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import axios from 'axios'
import type {
  ArtifactRef,
  HumanoidDraftSidecarReadResult,
  HumanoidDraftSidecarV1,
  HumanoidPromotionSidecarReadResult,
  HumanoidPromotionSidecarV1,
  RigMetaSidecarReadResult,
  Workflow,
  WFEdge,
  WFNode,
} from '../../shared/types/electron.d'
import { REQUIRED_LANDMARK_IDS, type LandmarkCaptureState, type LandmarkId, type LandmarkPoint, type LandmarkSidecarV1 } from './landmarks.ts'
import { createLandmarkPointIntent, deriveLandmarkMarkers } from '../generate/components/viewerLandmarkPicking.ts'
import { resolveViewerAssetTarget } from '../generate/viewerAssetTarget.ts'
import type { WorkflowExtension } from './mockExtensions'
import { resolveWorkflowDispatch } from './workflowDispatch.ts'
import { buildEditedCheckpointArtifactRef, deriveArtifactHistoryRows, type LandmarkSidecarLineageMetadata } from './workflowArtifacts.ts'

const localStorageMock = {
  getItem(): string | null {
    return null
  },
  setItem(): void {},
  removeItem(): void {},
  clear(): void {},
  key(): string | null {
    return null
  },
  length: 0,
}

if (!globalThis.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    configurable: true,
  })
}

const { useAppStore } = await import(new URL('../../shared/stores/appStore.ts', import.meta.url).href)
const { useWorldsSceneStore } = await import(new URL('../worlds/worldsSceneStore.ts', import.meta.url).href)
const {
  useWorkflowRunStore,
  buildModelGenerationRequest,
  shouldUsePreviousNodeFallback,
} = await import(new URL('./workflowRunStore.ts', import.meta.url).href)

type AxiosClientMock = {
  post: (path: string, data?: unknown, config?: unknown) => Promise<unknown>
  get: (path: string) => Promise<unknown>
}

type RunProcessCall = {
  extensionId: string
  input: unknown
  params: Record<string, unknown>
}

type LandmarkSidecarWriteCall = {
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  sidecar: LandmarkSidecarV1
}

type HumanoidDraftReadCall = {
  meshWorkspacePath: string
}

type HumanoidPromotionReadCall = {
  meshWorkspacePath: string
}

type RigMetaReadCall = {
  sourceWorkspacePath: string
}

const originalAxiosCreate = axios.create
const originalSetTimeout = globalThis.setTimeout

let axiosClientMock: AxiosClientMock
let runProcessCalls: RunProcessCall[]
test('workflowRunStore ignores disabled siblings and still runs an active inputless model', async () => {
  const activeExt = createWorkflowExtension({
    id: 'sense/open-image',
    extensionId: 'sense',
    nodeId: 'open-image',
    type: 'model',
    input: 'none',
    output: 'image',
  })
  const disabledExt = createWorkflowExtension({
    id: 'disabled/requires-image',
    extensionId: 'disabled',
    nodeId: 'requires-image',
    type: 'model',
    input: 'image',
    output: 'mesh',
    inputs: [{ name: 'image', type: 'image', required: true }],
  })
  const workflow: Workflow = {
    id: 'workflow-disabled-sibling',
    name: 'Disabled sibling',
    description: '',
    nodes: [
      createNode('active-model', 'extensionNode', { extensionId: activeExt.id, enabled: true, params: {} }),
      createNode('disabled-model', 'extensionNode', { extensionId: disabledExt.id, enabled: false, params: {} }),
      createNode('output-node', 'outputNode', { enabled: true, params: {} }),
    ],
    edges: [
      { id: 'edge-active-output', source: 'active-model', target: 'output-node' },
      { id: 'edge-disabled-input', source: 'active-model', target: 'disabled-model', targetHandle: 'image' },
    ],
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  }
  const postCalls: string[] = []

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string) {
      postCalls.push(path)
      assert.equal(path, '/generate/from-none')
      return { data: { job_id: 'job-disabled-sibling' } }
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-disabled-sibling')
      return { data: { status: 'done', output_url: '/workspace/Workflows/generated.png', output_kind: 'image' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [activeExt, disabledExt])

  assert.deepEqual(postCalls, ['/generate/from-none'])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(runProcessCalls.length, 0)
})

let fsReadCalls: string[]
let landmarkSidecarWriteCalls: LandmarkSidecarWriteCall[]
let humanoidDraftReadCalls: HumanoidDraftReadCall[]
let humanoidPromotionReadCalls: HumanoidPromotionReadCall[]
let rigMetaReadCalls: RigMetaReadCall[]
let humanoidDraftReadResult: HumanoidDraftSidecarReadResult
let humanoidPromotionReadResult: HumanoidPromotionSidecarReadResult
let rigMetaReadResult: RigMetaSidecarReadResult

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
    async post() {
      throw new Error('Unexpected axios.post call')
    },
    async get() {
      throw new Error('Unexpected axios.get call')
    },
  }
  runProcessCalls = []
  fsReadCalls = []
  landmarkSidecarWriteCalls = []
  humanoidDraftReadCalls = []
  humanoidPromotionReadCalls = []
  rigMetaReadCalls = []
  humanoidDraftReadResult = {
    success: true,
    status: 'not-found',
    sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-draft.v1.json',
  }
  humanoidPromotionReadResult = {
    success: true,
    status: 'not-found',
    sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-promotion.v1.json',
  }
  rigMetaReadResult = {
    success: true,
    status: 'not-found',
    rigMetaWorkspacePath: 'Workflows/generated/avatar.rigmeta.json',
  }
  axios.create = (() => axiosClientMock) as typeof axios.create

  useWorkflowRunStore.getState().reset()
  useAppStore.setState({
    apiUrl: 'http://127.0.0.1:8000',
    currentJob: null,
    selectedImagePath: '/tmp/source.png',
    selectedImageData: Buffer.from('png-bytes').toString('base64'),
  })

  globalThis.window = {
    electron: {
      settings: {
        get: async () => ({ workspaceDir: '/workspace' }),
      },
      fs: {
        deleteDirectory: async () => {},
        readFileBase64: async (filePath: string) => {
          fsReadCalls.push(filePath)
          if (filePath.endsWith('/scene-manifest.json')) {
            return Buffer.from(JSON.stringify({
              schema: 'modly.scene-manifest.v1',
              sceneRoot: '.',
              assets: [],
            }), 'utf8').toString('base64')
          }
          return Buffer.from('fs-bytes').toString('base64')
        },
      },
      workspace: {
        artifacts: {
          readRigMetaSidecar: async (request: RigMetaReadCall) => {
            rigMetaReadCalls.push(request)
            return rigMetaReadResult
          },
          readHumanoidDraftSidecar: async (request: HumanoidDraftReadCall) => {
            humanoidDraftReadCalls.push(request)
            return humanoidDraftReadResult
          },
          readHumanoidPromotionSidecar: async (request: HumanoidPromotionReadCall) => {
            humanoidPromotionReadCalls.push(request)
            return humanoidPromotionReadResult
          },
          writeLandmarkSidecar: async (request: LandmarkSidecarWriteCall) => {
            landmarkSidecarWriteCalls.push(request)
            return {
              success: true,
              sidecarWorkspacePath: request.sidecarWorkspacePath,
              sidecar: request.sidecar,
            }
          },
        },
      },
      extensions: {
        runProcess: async (extensionId: string, input: unknown, params: Record<string, unknown>) => {
          runProcessCalls.push({ extensionId, input, params })
          return { success: true, result: { filePath: '/workspace/output/process.glb' } }
        },
      },
    },
  } as unknown as typeof globalThis.window
})

afterEach(() => {
  axios.create = originalAxiosCreate
  globalThis.setTimeout = originalSetTimeout
  useWorkflowRunStore.getState().reset()
  useWorldsSceneStore.setState({
    sceneItems: [],
    collisionSurfaces: [],
    initialView: null,
    selectedSceneItemId: null,
    selectedSceneItemIds: [],
    pendingSurfacePlacementItemId: null,
    collisionEditMode: false,
    selectedCollisionSurfaceId: null,
    transformMode: null,
    sceneItemAnchors: {},
  })
  useAppStore.setState({
    apiUrl: '',
    currentJob: null,
    selectedImagePath: null,
    selectedImageData: null,
  })
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

type ModelWorkflowExtension = Extract<WorkflowExtension, { type: 'model' }>
type ProcessWorkflowExtension = Extract<WorkflowExtension, { type: 'process' }>
type ModelWorkflowExtensionOverrides = Partial<Omit<ModelWorkflowExtension, 'type'>>
type ProcessWorkflowExtensionOverrides = Partial<Omit<ProcessWorkflowExtension, 'type'>>

function createWorkflowExtension(
  overrides: ModelWorkflowExtensionOverrides & { type?: 'model' },
): ModelWorkflowExtension
function createWorkflowExtension(
  overrides: ProcessWorkflowExtensionOverrides & { type: 'process' },
): ProcessWorkflowExtension
function createWorkflowExtension(
  overrides:
    | (ModelWorkflowExtensionOverrides & { type?: 'model' })
    | (ProcessWorkflowExtensionOverrides & { type: 'process' }),
): ModelWorkflowExtension | ProcessWorkflowExtension {
  if (overrides.type === 'process') {
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
      ...overrides,
      type: 'process',
    }
  }

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
    ...overrides,
    type: 'model',
  }
}

function createNamedImageModelExtension(overrides: ModelWorkflowExtensionOverrides = {}): ModelWorkflowExtension {
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
    createNode('image-source', 'imageNode', { enabled: true, params: {} }),
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

function createWaitWorkflow(args: {
  id?: string
  sourceFilePath?: string
  afterWaitNode?: WFNode
  waitExtensionId?: string | null
} = {}): Workflow {
  const waitNode = createNode('wait-node', 'waitNode', {
    ...(args.waitExtensionId === null ? {} : { extensionId: args.waitExtensionId ?? 'workflow/wait' }),
    enabled: true,
    params: {},
  })
  const outputNode = createNode('output-node', 'outputNode', { enabled: true, params: {} })
  const afterWaitNode = args.afterWaitNode

  return {
    id: args.id ?? 'workflow-wait-runtime',
    name: 'Wait Runtime',
    description: '',
    nodes: [
      createNode('mesh-source', 'meshNode', {
        enabled: true,
        params: { source: 'file', filePath: args.sourceFilePath ?? '/workspace/meshes/original.glb' },
      }),
      waitNode,
      ...(afterWaitNode ? [afterWaitNode] : []),
      outputNode,
    ],
    edges: [
      { id: 'edge-mesh-wait', source: 'mesh-source', target: 'wait-node' },
      afterWaitNode
        ? { id: 'edge-wait-after', source: 'wait-node', target: afterWaitNode.id }
        : { id: 'edge-wait-output', source: 'wait-node', target: 'output-node' },
      ...(afterWaitNode ? [{ id: 'edge-after-output', source: afterWaitNode.id, target: 'output-node' }] : []),
    ],
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
  }
}

function createWaitExtension(overrides: ProcessWorkflowExtensionOverrides = {}): ProcessWorkflowExtension {
  return createWorkflowExtension({
    id: 'workflow/wait',
    extensionId: 'workflow',
    nodeId: 'wait',
    name: 'Wait',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
    ...overrides,
  })
}

function createKimodoAnimateExtension(overrides: ModelWorkflowExtensionOverrides = {}): ModelWorkflowExtension {
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

function createLandmarksWorkflow(args: {
  id?: string
  sourceFilePath?: string
  afterLandmarksNode?: WFNode
  includeMeshEdge?: boolean
  landmarkExtensionId?: string | null
} = {}): Workflow {
  const landmarksNode = createNode('landmarks-node', 'landmarksNode', {
    ...(args.landmarkExtensionId === null ? {} : { extensionId: args.landmarkExtensionId ?? 'workflow/landmarks' }),
    enabled: true,
    params: {},
  })
  const outputNode = createNode('output-node', 'outputNode', { enabled: true, params: {} })
  const afterLandmarksNode = args.afterLandmarksNode

  return {
    id: args.id ?? 'workflow-landmarks-runtime',
    name: 'Landmarks Runtime',
    description: '',
    nodes: [
      createNode('mesh-source', 'meshNode', {
        enabled: true,
        params: { source: 'file', filePath: args.sourceFilePath ?? '/workspace/meshes/original.glb' },
      }),
      landmarksNode,
      ...(afterLandmarksNode ? [afterLandmarksNode] : []),
      outputNode,
    ],
    edges: [
      ...(args.includeMeshEdge === false ? [] : [{ id: 'edge-mesh-landmarks', source: 'mesh-source', target: 'landmarks-node' }]),
      afterLandmarksNode
        ? { id: 'edge-landmarks-after', source: 'landmarks-node', target: afterLandmarksNode.id }
        : { id: 'edge-landmarks-output', source: 'landmarks-node', target: 'output-node' },
      ...(afterLandmarksNode ? [{ id: 'edge-after-output', source: afterLandmarksNode.id, target: 'output-node' }] : []),
    ],
    createdAt: '2026-05-17T00:00:00.000Z',
    updatedAt: '2026-05-17T00:00:00.000Z',
  }
}

function createLandmarksExtension(overrides: ProcessWorkflowExtensionOverrides = {}): ProcessWorkflowExtension {
  return createWorkflowExtension({
    id: 'workflow/landmarks',
    extensionId: 'workflow',
    nodeId: 'landmarks',
    name: 'Landmarks',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
    ...overrides,
  })
}

function landmarkPoint(id: LandmarkId, x: number, objectName = 'avatar-mesh'): LandmarkPoint {
  return {
    id,
    name: id.replace(/_/g, ' '),
    world: { x, y: x + 1, z: x + 2 },
    objectName,
    confidence: 1,
    source: 'manual',
  }
}

function markAllRequiredLandmarks(): void {
  landmarksApi().markLandmark(landmarkPoint('left_shoulder', 1))
  landmarksApi().markLandmark(landmarkPoint('right_shoulder', 2))
  landmarksApi().markLandmark(landmarkPoint('hip', 3))
  landmarksApi().markLandmark(landmarkPoint('left_knee', 4))
  landmarksApi().markLandmark(landmarkPoint('right_knee', 5))
}

type WorkflowRunLandmarksApi = {
  landmarkSession?: LandmarkCaptureState & { captureId?: string; captureRevision?: number; sidecarStatus?: 'pending-write' | 'not_started' | 'error' }
  landmarkSidecars?: Record<string, LandmarkSidecarLineageMetadata>
  markLandmark: (point: LandmarkPoint) => void
  selectLandmarkForEditing: (id: LandmarkId) => void
  resetLandmarks: (nodeId?: string) => void
}

function landmarksApi(): WorkflowRunLandmarksApi {
  const state = useWorkflowRunStore.getState() as unknown as Partial<WorkflowRunLandmarksApi>
  assert.equal(typeof state.markLandmark, 'function', 'workflowRunStore must expose landmark mark helper')
  assert.equal(typeof state.selectLandmarkForEditing, 'function', 'workflowRunStore must expose landmark edit-selection helper')
  assert.equal(typeof state.resetLandmarks, 'function', 'workflowRunStore must expose landmark reset helper')
  return state as WorkflowRunLandmarksApi
}

function markPickedLandmark(id: LandmarkId, x: number): void {
  const checkpointMesh = { name: 'checkpoint-mesh', userData: { landmarkClickable: true, objectName: 'checkpoint-mesh' } }
  const intent = createLandmarkPointIntent({
    activeLandmarkId: id,
    pointer: { clientX: 60 + x, clientY: 80 + x },
    canvas: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) },
    intersections: [{ object: checkpointMesh, point: { x, y: x + 1, z: x + 2 } }],
    clickableObjects: [checkpointMesh],
  })
  assert.ok(intent, `expected ${id} pick to hit the checkpoint mesh`)
  landmarksApi().markLandmark(intent.point)
}

function assertLandmarkCapturePath(pathValue: string | undefined, workflowId: string, nodeId = 'landmarks-node'): string {
  assert.equal(typeof pathValue, 'string')
  const sidecarPath = pathValue as string
  assert.match(sidecarPath, new RegExp(`^Workflows/landmarks/${workflowId}/${nodeId}/[A-Za-z0-9_.-]+\\.landmarks\\.v1\\.json$`))
  return sidecarPath
}

function createMeshArtifactRef(overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  const uri = overrides.uri ?? '/workspace/meshes/replacement.glb'
  const id = overrides.id ?? 'artifact-replacement-mesh'
  return {
    id,
    kind: 'mesh',
    uri,
    versionId: overrides.versionId ?? `${id}-edited`,
    legacy: overrides.legacy ?? { filePath: uri, outputType: 'mesh' },
    ...overrides,
  }
}

type WorkflowRunCheckpointApi = {
  continueRun: (options?: { replacementArtifact?: ArtifactRef }) => void
  setPendingReplacement: (replacement: ArtifactRef | undefined) => void
  getPendingReplacement: () => ArtifactRef | undefined
  pendingReplacement?: ArtifactRef
}

type WaitCheckpointReviewSnapshot = {
  status: 'manual_confirmed' | 'draft_only' | 'stale' | 'diagnostics_only'
  headline: string
  diagnostics: string[]
  downstreamHumanoidStatus?: 'manual_confirmed'
  promotionSidecarWorkspacePath?: string
}

function checkpointApi(): WorkflowRunCheckpointApi {
  const state = useWorkflowRunStore.getState() as unknown as Partial<WorkflowRunCheckpointApi>
  assert.equal(typeof state.continueRun, 'function')
  assert.equal(typeof state.setPendingReplacement, 'function', 'workflowRunStore must expose pending replacement helper')
  assert.equal(typeof state.getPendingReplacement, 'function', 'workflowRunStore must expose pending replacement inspection helper')
  return state as WorkflowRunCheckpointApi
}

function waitCheckpointReviewState(): WaitCheckpointReviewSnapshot | undefined {
  return (useWorkflowRunStore.getState() as unknown as { waitCheckpointReview?: WaitCheckpointReviewSnapshot }).waitCheckpointReview
}

async function waitForPause(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

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
  assert.deepEqual(useWorkflowRunStore.getState().nodeImageOutputs, {})
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

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
  useAppStore.setState({
    selectedImagePath: null,
    selectedImageData: null,
  })

  const ext = createNamedImageModelExtension()
  const workflow = createMultiInputWorkflow({
    node: createNode('model-node', 'extensionNode', {
      extensionId: ext.id,
      enabled: true,
      params: {},
    }),
    imageSources: [{ id: 'legacy-source', filePath: '/tmp/legacy-primary.png' }],
  })
  const postCalls: FormData[] = []

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-image') {
        postCalls.push(data as FormData)
        return { data: { job_id: 'job-legacy-untargeted' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/legacy-untargeted.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.equal((postCalls[0].get('image') as File).name, 'legacy-primary.png')
  assert.deepEqual(fsReadCalls, ['/tmp/legacy-primary.png'])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

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
  assert.deepEqual(fsReadCalls, [])
})

test('workflowRunStore preserves the legacy missing-primary-image failure when front and selected image are both absent', async () => {
  useAppStore.setState({
    selectedImagePath: null,
    selectedImageData: null,
  })

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
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /ENOENT/)
})

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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown, config?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: data as Record<string, unknown>, config })
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: data as Record<string, unknown> })
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
      rigged_mesh_path: 'rigs/avatar.glb',
      mesh_path: 'rigs/avatar.glb',
      node_id: 'animate-rigged-mesh',
      model_id: ext.id,
      motion_prompt: 'Jump and wave',
    },
  })
  assert.deepEqual(fsReadCalls, [])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.deepEqual(useWorkflowRunStore.getState().runState.artifact?.provenance, {
    workflowId: 'workflow-text-mesh',
    workflowNodeId: 'animate-node',
    extensionId: 'kimodo-soma-rp',
    extensionNodeId: 'animate-rigged-mesh',
  })
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['animate-node']?.provenance, {
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

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
test('workflowRunStore falls back stale mesh target handle into single rigged mesh input', async () => {
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
      params: { duration: 3 },
    }),
    text: 'Jump and wave',
    meshFilePath: '/workspace/rigs/avatar.glb',
    meshTargetHandle: 'mesh',
  })
  const postCalls: Array<{ path: string; data: Record<string, unknown> }> = []

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: data as Record<string, unknown> })
        return { data: { job_id: 'job-text-mesh-stale-handle' } }
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
      rigged_mesh_path: 'rigs/avatar.glb',
      mesh_path: 'rigs/avatar.glb',
      node_id: 'animate-rigged-mesh',
      model_id: ext.id,
      motion_prompt: 'Jump and wave',
    },
  })
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

test('workflowRunStore still dispatches animate-rigged-mesh when rigged mesh is missing', async () => {
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
  const postCalls: Array<{ path: string; data: Record<string, unknown> }> = []
  let getCalls = 0

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      postCalls.push({ path, data: data as Record<string, unknown> })
      assert.equal(path, '/generate/from-text')
      return { data: { job_id: 'job-animate-without-rigged-mesh' } }
    },
    async get(path: string) {
      getCalls += 1
      assert.equal(path, '/generate/status/job-animate-without-rigged-mesh')
      return { data: { status: 'done', output_url: '/workspace/output/animated.glb' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.equal(getCalls, 1)
  assert.deepEqual(postCalls[0].data, {
    prompt: 'Walk forward',
    model_id: ext.id,
    collection: 'Workflows',
    remesh: 'none',
    enable_texture: false,
    texture_resolution: 1024,
    params: {
      motion_prompt: 'Walk forward',
    },
  })
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

test('workflowRunStore blocks model dispatch before backend requests when capability input metadata is missing or unsupported', async () => {
  const scenarios: Array<{ name: string; input: WorkflowExtension['input'] | undefined; expectedError: string }> = [
    {
      name: 'missing capability input',
      input: undefined,
      expectedError: 'Error: Missing workflow capability input metadata for extension: invalid/missing-input',
    },
    {
      name: 'unsupported capability input',
      input: 'mesh',
      expectedError: 'Error: Unsupported workflow capability input for extension invalid/unsupported-input: mesh',
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

test('buildModelGenerationRequest accepts scene model inputs as scene path params', () => {
  const ext = createWorkflowExtension({
    id: 'hy-world-2/worldstereo-2',
    extensionId: 'hy-world-2',
    nodeId: 'worldstereo-2',
    type: 'model',
    input: 'scene',
    output: 'scene',
  })
  const node = createNode('worldstereo-node', 'extensionNode', {
    extensionId: ext.id,
    enabled: true,
    params: { steps: 12 },
  })

  const request = buildModelGenerationRequest({
    ext,
    node,
    nodeParams: { steps: 12 },
    nodeInputPath: '/home/drhepa/Documentos/Modly/workspace/Default/worlds/scene.scene.json',
    workspaceDir: '/home/drhepa/Documentos/Modly/workspace',
  })

  assert.equal(request.kind, 'scene')
  assert.equal(request.scenePath, 'Default/worlds/scene.scene.json')
  assert.deepEqual(request.params, {
    steps: 12,
    scene_path: 'Default/worlds/scene.scene.json',
    input_scene_path: 'Default/worlds/scene.scene.json',
  })
})

test('workflowRunStore dispatches scene-capability model nodes to /generate/from-scene as JSON without reading image bytes', async () => {
  const ext = createWorkflowExtension({
    id: 'hy-world-2/worldstereo-2',
    extensionId: 'hy-world-2',
    nodeId: 'worldstereo-2',
    type: 'model',
    input: 'scene',
    output: 'scene',
  })
  const workflow: Workflow = {
    id: 'workflow-scene-model',
    name: 'Scene Dispatch Workflow',
    description: '',
    nodes: [
      createNode('scene-source', 'sceneNode', {
        enabled: true,
        params: { path: 'Default/worlds/hero-scene' },
      }),
      createNode('scene-model-node', 'extensionNode', {
        extensionId: ext.id,
        enabled: true,
        params: { steps: 12 },
      }),
      createNode('output-node', 'outputNode', { enabled: true, params: {} }),
    ],
    edges: [
      { id: 'edge-scene', source: 'scene-source', target: 'scene-model-node' },
      { id: 'edge-output', source: 'scene-model-node', target: 'output-node' },
    ],
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  }
  const postCalls: Array<{ path: string; data: Record<string, unknown>; config: unknown }> = []

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown, config?: unknown) {
      postCalls.push({ path, data: data as Record<string, unknown>, config })
      return { data: { job_id: 'job-scene-1' } }
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/world.scene.json' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(postCalls.length, 1)
  assert.equal(postCalls[0].path, '/generate/from-scene')
  assert.deepEqual(postCalls[0].data, {
    scene_path: 'Default/worlds/hero-scene/scene-manifest.json',
    model_id: ext.id,
    collection: 'Workflows',
    remesh: 'none',
    enable_texture: false,
    texture_resolution: 1024,
    params: {
      steps: 12,
      scene_path: 'Default/worlds/hero-scene/scene-manifest.json',
      input_scene_path: 'Default/worlds/hero-scene/scene-manifest.json',
    },
  })
  assert.equal(postCalls[0].config, undefined)
  assert.deepEqual(fsReadCalls, ['/workspace/Default/worlds/hero-scene/scene-manifest.json'])
  assert.equal(runProcessCalls.length, 0)
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/output/world.scene.json')
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['scene-source']?.legacy, {
    filePath: '/workspace/Default/worlds/hero-scene/scene-manifest.json',
    outputType: 'scene',
  })
})

test('workflowRunStore sends Load Scene outputs to downstream scene process nodes without rerouting through image handling', async () => {
  const ext = createWorkflowExtension({
    id: 'hy-world-2/worldmirror-2',
    extensionId: 'hy-world-2',
    nodeId: 'worldmirror-2',
    type: 'process',
    input: 'scene',
    output: 'mesh',
  })
  const workflow: Workflow = {
    id: 'workflow-scene-process',
    name: 'Scene Process Workflow',
    description: '',
    nodes: [
      createNode('scene-source', 'sceneNode', { enabled: true, params: { path: 'Default/worlds/hero-scene' } }),
      createNode('scene-process-node', 'extensionNode', { extensionId: ext.id, enabled: true, params: { variant: 'mirror' } }),
      createNode('output-node', 'outputNode', { enabled: true, params: {} }),
    ],
    edges: [
      { id: 'edge-scene', source: 'scene-source', target: 'scene-process-node' },
      { id: 'edge-output', source: 'scene-process-node', target: 'output-node' },
    ],
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.deepEqual(fsReadCalls, ['/workspace/Default/worlds/hero-scene/scene-manifest.json'])
  assert.equal(runProcessCalls.length, 1)
  assert.deepEqual(runProcessCalls[0], {
    extensionId: 'hy-world-2',
    input: {
      filePath: '/workspace/Default/worlds/hero-scene/scene-manifest.json',
      text: undefined,
      nodeId: 'worldmirror-2',
    },
    params: { variant: 'mirror' },
  })
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
    text: undefined,
    nodeId: 'mesh-refiner',
  })
  assert.deepEqual(runProcessCalls[0].params, { quality: 'high' })
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/output/process.glb')
  assert.deepEqual(useWorkflowRunStore.getState().runState.artifact?.legacy, {
    filePath: '/workspace/output/process.glb',
    outputType: 'mesh',
  })
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['process-node']?.legacy, {
    filePath: '/workspace/output/process.glb',
    outputType: 'mesh',
  })
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['process-node']?.kind, 'mesh')
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

  window.electron.extensions.runProcess = async (extensionId: string, input: unknown, params: Record<string, unknown>) => {
    runProcessCalls.push({ extensionId, input, params })
    return { success: true, result: { filePath: '/workspace/video/generated.mp4' } }
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/video/generated.mp4')
  assert.equal(useWorkflowRunStore.getState().runState.artifact?.kind, 'video')
  assert.deepEqual(useWorkflowRunStore.getState().nodeVideoOutputs, {
    'video-node': '/workspace/video/generated.mp4',
  })
  assert.equal(useAppStore.getState().currentJob?.outputUrl, undefined)
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

test('workflowRunStore pauses a built-in landmarksNode without extensionId instead of resolving an external extension', async () => {
  const workflow = createLandmarksWorkflow({
    id: 'workflow-landmarks-builtin-no-extension',
    landmarkExtensionId: null,
  })
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

  const runPromise = useWorkflowRunStore.getState().run(workflow, [])
  await waitForPause()

  try {
    const state = useWorkflowRunStore.getState()
    assert.equal(state.runState.status, 'paused')
    assert.equal(state.runState.error, undefined)
    assert.notEqual(state.runState.error, 'Error: Unresolved workflow extension:')
    assert.equal(state.runState.blockStep, 'Paused — mark required landmarks')
    assert.equal(state.runState.substitutionPoint?.nodeId, 'landmarks-node')
    assert.deepEqual(state.runState.artifact?.legacy, {
      filePath: '/workspace/meshes/original.glb',
      outputType: 'mesh',
    })
    assert.equal(landmarksApi().landmarkSession?.nodeId, 'landmarks-node')
    assert.equal(landmarksApi().landmarkSession?.targetArtifact.id, 'workflow-workflow-landmarks-builtin-no-extension-node-mesh-source')
    assert.equal(axiosPostCalls, 0)
    assert.equal(axiosGetCalls, 0)
    assert.equal(runProcessCalls.length, 0)
  } finally {
    useWorkflowRunStore.getState().cancel()
    await runPromise
  }
})

test('workflowRunStore keeps missing external extensionNode failures strict after built-in checkpoint handling', async () => {
  const workflow = createWorkflow(createNode('missing-external-node', 'extensionNode', {
    extensionId: 'missing/mesh-process',
    enabled: true,
    params: {},
  }))

  await useWorkflowRunStore.getState().run(workflow, [])

  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.equal(
    useWorkflowRunStore.getState().runState.error,
    'Error: Unresolved workflow extension: missing/mesh-process',
  )
  assert.equal(useWorkflowRunStore.getState().runState.substitutionPoint, undefined)
  assert.equal(landmarksApi().landmarkSession, undefined)
  assert.equal(runProcessCalls.length, 0)
})

test('workflowRunStore pauses and continues a built-in waitNode without extensionId', async () => {
  const workflow = createWaitWorkflow({
    id: 'workflow-wait-builtin-no-extension',
    waitExtensionId: null,
  })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [])
  await waitForPause()

  assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
  assert.equal(useWorkflowRunStore.getState().runState.error, undefined)
  assert.equal(useWorkflowRunStore.getState().runState.blockStep, 'Paused — click Continue')
  assert.equal(useWorkflowRunStore.getState().runState.substitutionPoint?.nodeId, 'wait-node')
  assert.deepEqual(useWorkflowRunStore.getState().runState.artifact?.legacy, {
    filePath: '/workspace/meshes/original.glb',
    outputType: 'mesh',
  })

  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(runProcessCalls.length, 0)
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['wait-node']?.legacy, {
    filePath: '/workspace/meshes/original.glb',
    outputType: 'mesh',
  })
})

test('workflowRunStore exposes a declarative substitution checkpoint for wait nodes without editing the artifact', async () => {
  const waitExt = createWorkflowExtension({
    id: 'workflow/wait',
    extensionId: 'workflow',
    nodeId: 'wait',
    name: 'Wait',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const workflow: Workflow = {
    id: 'workflow-wait-substitution',
    name: 'Wait Substitution',
    description: '',
    nodes: [
      createNode('mesh-source', 'meshNode', { enabled: true, params: { source: 'file', filePath: '/workspace/meshes/original.glb' } }),
      createNode('wait-node', 'waitNode', { extensionId: waitExt.id, enabled: true, params: {} }),
      createNode('output-node', 'outputNode', { enabled: true, params: {} }),
    ],
    edges: [
      { id: 'edge-mesh-wait', source: 'mesh-source', target: 'wait-node' },
      { id: 'edge-wait-output', source: 'wait-node', target: 'output-node' },
    ],
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [waitExt])
  await new Promise((resolve) => setImmediate(resolve))

  const paused = useWorkflowRunStore.getState().runState
  assert.equal(paused.status, 'paused')
  assert.equal(paused.substitutionPoint?.kind, 'artifact_substitution')
  assert.equal(paused.substitutionPoint?.nodeId, 'wait-node')
  assert.equal(paused.substitutionPoint?.inputArtifactId, 'workflow-workflow-wait-substitution-node-mesh-source')
  assert.deepEqual(paused.substitutionPoint?.allowedKinds, ['mesh'])
  assert.deepEqual(paused.substitutionPoint?.interaction, {
    boundary: 'ui_only',
    headless: false,
    editor: 'none',
    continueMode: 'manual',
  })
  assert.equal(paused.substitutionPoint?.replacementArtifactId, undefined)
  assert.deepEqual(paused.artifact?.legacy, {
    filePath: '/workspace/meshes/original.glb',
    outputType: 'mesh',
  })

  useWorkflowRunStore.getState().continueRun()
  await runPromise

  const done = useWorkflowRunStore.getState().runState
  assert.equal(done.status, 'done')
  assert.equal(done.substitutionPoint, undefined)
  assert.equal(runProcessCalls.length, 0)
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['wait-node']?.legacy, {
    filePath: '/workspace/meshes/original.glb',
    outputType: 'mesh',
  })
})

test('workflowRunStore continue without replacement preserves original wait passthrough for downstream nodes', async () => {
  const processNode = createNode('process-after-wait', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: { quality: 'preview' },
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const workflow = createWaitWorkflow({ afterWaitNode: processNode })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension(), processExt])
  await waitForPause()

  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(runProcessCalls.length, 1)
  assert.deepEqual(runProcessCalls[0].input, {
    filePath: '/workspace/meshes/original.glb',
    text: undefined,
    nodeId: 'mesh-process',
  })
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['wait-node']?.legacy, {
    filePath: '/workspace/meshes/original.glb',
    outputType: 'mesh',
  })
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

test('workflowRunStore continue with valid replacement routes replacement as wait legacy output to downstream nodes', async () => {
  const processNode = createNode('process-after-wait', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: {},
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const replacement = createMeshArtifactRef({ uri: '/workspace/meshes/replacement.glb' })
  const workflow = createWaitWorkflow({ afterWaitNode: processNode })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension(), processExt])
  await waitForPause()

  useWorkflowRunStore.getState().continueRun({ replacementArtifact: replacement })
  await runPromise

  assert.equal(runProcessCalls.length, 1)
  assert.deepEqual(runProcessCalls[0].input, {
    filePath: '/workspace/meshes/replacement.glb',
    text: undefined,
    nodeId: 'mesh-process',
  })
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['wait-node']?.legacy, {
    filePath: '/workspace/meshes/replacement.glb',
    outputType: 'mesh',
  })
  assert.equal(useWorkflowRunStore.getState().artifactLineages['workflow-workflow-wait-runtime-node-mesh-source']?.currentVersionId, 'workflow-workflow-wait-runtime-node-mesh-source-artifact-replacement-mesh-edited')
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

test('workflowRunStore consumes edited checkpoint ArtifactRef pending replacement with lineage after save success', async () => {
  const processNode = createNode('process-after-wait', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: {},
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const workflow = createWaitWorkflow({ afterWaitNode: processNode })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension(), processExt])
  await waitForPause()

  const original = useWorkflowRunStore.getState().runState.substitutionPoint?.inputArtifact
  assert.ok(original)
  const edited = buildEditedCheckpointArtifactRef(original, {
    workspacePath: '/workspace/Workflows/edited/source-edited.glb',
    sidecarWorkspacePath: 'Workflows/edited/source-edited.json',
    createdAt: '2026-05-17T15:30:00.000Z',
  })
  const api = checkpointApi()
  api.setPendingReplacement(edited.artifact)
  assert.deepEqual(useWorkflowRunStore.getState().pendingReplacement, edited.artifact)

  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.deepEqual(runProcessCalls[0].input, {
    filePath: '/workspace/Workflows/edited/source-edited.glb',
    text: undefined,
    nodeId: 'mesh-process',
  })
  assert.equal(api.getPendingReplacement(), undefined)
  assert.equal(useWorkflowRunStore.getState().pendingReplacement, undefined)
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['wait-node']?.legacy, {
    filePath: '/workspace/Workflows/edited/source-edited.glb',
    outputType: 'mesh',
  })
  assert.equal(
    useWorkflowRunStore.getState().artifactLineages[original.id]?.currentVersionId,
    `${original.id}-${edited.artifact.versionId}`,
  )
  assert.equal(edited.lineageIntent.sidecarWorkspacePath, 'Workflows/edited/source-edited.json')
})

test('workflowRunStore rejects replacement with invalid kind without corrupting wait outputs or artifacts', async () => {
  const imageReplacement: ArtifactRef = {
    id: 'artifact-invalid-image',
    kind: 'image',
    uri: '/workspace/images/not-a-mesh.png',
    versionId: 'artifact-invalid-image-edited',
    legacy: { filePath: '/workspace/images/not-a-mesh.png', outputType: 'image' },
  }
  const workflow = createWaitWorkflow()

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension()])
  await waitForPause()

  useWorkflowRunStore.getState().continueRun({ replacementArtifact: imageReplacement })
  await runPromise

  const state = useWorkflowRunStore.getState() as unknown as {
    runState: { replacementResult?: { status?: string; reason?: string } }
  }
  assert.deepEqual(state.runState.replacementResult, {
    status: 'rejected',
    reason: 'kind_not_allowed',
  })
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['wait-node']?.legacy, {
    filePath: '/workspace/meshes/original.glb',
    outputType: 'mesh',
  })
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/meshes/original.glb')
})

test('workflowRunStore rejects mesh replacement without legacy-convertible payload and exposes legacy_unavailable', async () => {
  const replacementWithoutLegacy: ArtifactRef = {
    id: 'artifact-mesh-without-payload',
    kind: 'mesh',
    versionId: 'artifact-mesh-without-payload-edited',
  }
  const workflow = createWaitWorkflow()

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension()])
  await waitForPause()

  useWorkflowRunStore.getState().continueRun({ replacementArtifact: replacementWithoutLegacy })
  await runPromise

  const state = useWorkflowRunStore.getState() as unknown as {
    runState: { replacementResult?: { status?: string; reason?: string } }
  }
  assert.deepEqual(state.runState.replacementResult, {
    status: 'rejected',
    reason: 'legacy_unavailable',
  })
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['wait-node']?.legacy, {
    filePath: '/workspace/meshes/original.glb',
    outputType: 'mesh',
  })
})

test('workflowRunStore clears pending replacement and checkpoint state on cancel, reset, and error transitions', async () => {
  const replacement = createMeshArtifactRef({ uri: '/workspace/meshes/pending.glb' })
  const scenarios: Array<'cancel' | 'reset' | 'error'> = ['cancel', 'reset', 'error']

  for (const scenario of scenarios) {
    useWorkflowRunStore.getState().reset()
    runProcessCalls = []
    const api = checkpointApi()
    const failingModelNode = createNode('unsupported-model-after-wait', 'extensionNode', {
      extensionId: 'vendor/unsupported-model',
      enabled: true,
      params: {},
    })
    const failingModel = createWorkflowExtension({
      id: 'vendor/unsupported-model',
      extensionId: 'vendor',
      nodeId: 'unsupported-model',
      type: 'model',
      input: 'mesh',
      output: 'mesh',
    })
    const workflow = createWaitWorkflow({
      id: `workflow-wait-${scenario}`,
      afterWaitNode: scenario === 'error' ? failingModelNode : undefined,
    })
    const runPromise = useWorkflowRunStore.getState().run(
      workflow,
      scenario === 'error' ? [createWaitExtension(), failingModel] : [createWaitExtension()],
    )
    await waitForPause()
    api.setPendingReplacement(replacement)
    assert.deepEqual(useWorkflowRunStore.getState().pendingReplacement, replacement, `${scenario} should expose pending replacement snapshot`)

    if (scenario === 'cancel') {
      useWorkflowRunStore.getState().cancel()
      await runPromise
    } else if (scenario === 'reset') {
      useWorkflowRunStore.getState().reset()
      useWorkflowRunStore.getState().cancel()
      await runPromise
    } else {
      useWorkflowRunStore.getState().continueRun()
      await runPromise
      assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
    }

    assert.equal(api.getPendingReplacement(), undefined, `${scenario} should clear pending replacement`)
    assert.equal(useWorkflowRunStore.getState().pendingReplacement, undefined, `${scenario} should clear pending replacement snapshot`)
    assert.equal(useWorkflowRunStore.getState().runState.substitutionPoint, undefined, `${scenario} should clear substitution point`)
    assert.equal(useAppStore.getState().currentJob?.step, undefined, `${scenario} should clear checkpoint step metadata`)
    assert.equal(useAppStore.getState().currentJob?.outputUrl, undefined, `${scenario} should clear checkpoint output URL`)
    assert.equal(useAppStore.getState().currentJob?.previewKind, undefined, `${scenario} should clear checkpoint preview metadata`)
  }
})

test('workflowRunStore exposes pending replacement snapshot and clears it on explicit reset', () => {
  const api = checkpointApi()
  const first = createMeshArtifactRef({ id: 'pending-first', uri: '/workspace/meshes/pending-first.glb' })
  const second = createMeshArtifactRef({ id: 'pending-second', uri: '/workspace/meshes/pending-second.glb' })

  api.setPendingReplacement(first)
  assert.deepEqual(api.getPendingReplacement(), first)
  assert.deepEqual(useWorkflowRunStore.getState().pendingReplacement, first)

  api.setPendingReplacement(second)
  assert.deepEqual(api.getPendingReplacement(), second)
  assert.deepEqual(useWorkflowRunStore.getState().pendingReplacement, second)

  api.setPendingReplacement(undefined)
  assert.equal(api.getPendingReplacement(), undefined)
  assert.equal(useWorkflowRunStore.getState().pendingReplacement, undefined)
})

test('workflowRunStore publishes safe mesh wait checkpoints to currentJob without marking workflow final', async () => {
  const workflow = createWaitWorkflow({ id: 'workflow-wait-checkpoint-preview' })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension()])
  await waitForPause()

  try {
    assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
    assert.equal(useWorkflowRunStore.getState().runState.outputUrl, undefined)
    assert.deepEqual(useAppStore.getState().currentJob, {
      ...useAppStore.getState().currentJob,
      status: 'generating',
      progress: 100,
      step: 'Workflow checkpoint',
      outputUrl: '/workspace/meshes/original.glb',
      previewKind: 'workflow-checkpoint',
    })
  } finally {
    useWorkflowRunStore.getState().continueRun()
    await runPromise
  }
})

test('workflowRunStore clears checkpoint preview metadata when a wait checkpoint completes as final output', async () => {
  const workflow = createWaitWorkflow({ id: 'workflow-wait-final-clears-preview' })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension()])
  await waitForPause()

  assert.equal(useAppStore.getState().currentJob?.previewKind, 'workflow-checkpoint')

  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useAppStore.getState().currentJob?.status, 'done')
  assert.equal(useAppStore.getState().currentJob?.outputUrl, '/workspace/meshes/original.glb')
  assert.equal(useAppStore.getState().currentJob?.previewKind, undefined)
})

test('workflowRunStore resolves a paused checkpoint viewer target from artifact-backed workflow state', async () => {
  const workflow = createWaitWorkflow({ id: 'workflow-wait-checkpoint-target' })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension()])
  await waitForPause()

  try {
    const { apiUrl, currentJob } = useAppStore.getState()
    const { runState } = useWorkflowRunStore.getState()

    assert.ok(currentJob)
    assert.ok(runState.artifact)

    assert.deepEqual(resolveViewerAssetTarget({
      currentJob,
      apiUrl,
      workflowArtifact: runState.artifact,
    }), {
      kind: 'workflow-checkpoint',
      modelUrl: 'http://127.0.0.1:8000/workspace/meshes/original.glb',
      isCheckpointPreview: true,
      label: 'Temporary checkpoint — not final output',
      sourceLabel: 'Temporary checkpoint — not final output',
      sourceKind: 'workflow',
      workspacePath: 'meshes/original.glb',
      artifactId: 'workflow-workflow-wait-checkpoint-target-node-mesh-source',
      versionId: 'workflow-workflow-wait-checkpoint-target-node-mesh-source-original',
    })
  } finally {
    useWorkflowRunStore.getState().continueRun()
    await runPromise
  }
})

test('workflowRunStore keeps workflow viewer identity on final output and drops stale artifact metadata for undo history targets', async () => {
  const workflow = createWaitWorkflow({ id: 'workflow-wait-history-target' })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension()])
  await waitForPause()
  useWorkflowRunStore.getState().continueRun()
  await runPromise

  const { apiUrl, currentJob, pushMeshUrl, undoMesh } = useAppStore.getState()
  const { runState } = useWorkflowRunStore.getState()

  assert.ok(currentJob)
  assert.ok(runState.artifact)

  assert.deepEqual(resolveViewerAssetTarget({
    currentJob,
    apiUrl,
    workflowArtifact: runState.artifact,
  }), {
    kind: 'final',
    modelUrl: 'http://127.0.0.1:8000/workspace/meshes/original.glb',
    isCheckpointPreview: false,
    label: 'Final output',
    sourceLabel: 'Final output',
    sourceKind: 'workflow',
    workspacePath: 'meshes/original.glb',
    artifactId: 'workflow-workflow-wait-history-target-node-wait-node',
    versionId: 'workflow-workflow-wait-history-target-node-wait-node-original',
  })

  pushMeshUrl('/workspace/history/older.glb')
  pushMeshUrl(currentJob.outputUrl!)
  undoMesh()

  assert.deepEqual(resolveViewerAssetTarget({
    currentJob: useAppStore.getState().currentJob,
    apiUrl,
    workflowArtifact: runState.artifact,
    sourceKind: 'history',
  }), {
    kind: 'final',
    modelUrl: 'http://127.0.0.1:8000/workspace/history/older.glb',
    isCheckpointPreview: false,
    label: 'Final output',
    sourceLabel: 'Final output',
    sourceKind: 'history',
    workspacePath: 'history/older.glb',
  })
})

test('workflowRunStore clears checkpoint preview metadata after normal continue before downstream processing', async () => {
  const processNode = createNode('process-after-wait', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: {},
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const workflow = createWaitWorkflow({ id: 'workflow-wait-normal-continue-preview', afterWaitNode: processNode })

  window.electron.extensions.runProcess = async (extensionId: string, input: unknown, params: Record<string, unknown>) => {
    assert.equal(useAppStore.getState().currentJob?.previewKind, undefined)
    assert.equal(useAppStore.getState().currentJob?.outputUrl, undefined)
    runProcessCalls.push({ extensionId, input, params })
    return { success: true, result: { filePath: '/workspace/output/process.glb' } }
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension(), processExt])
  await waitForPause()

  assert.equal(useAppStore.getState().currentJob?.previewKind, 'workflow-checkpoint')

  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(runProcessCalls.length, 1)
  assert.equal(useAppStore.getState().currentJob?.status, 'done')
  assert.equal(useAppStore.getState().currentJob?.outputUrl, '/workspace/output/process.glb')
  assert.equal(useAppStore.getState().currentJob?.previewKind, undefined)
})

test('workflowRunStore clears checkpoint preview metadata after substituted continue before downstream processing', async () => {
  const processNode = createNode('process-after-substitution', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: {},
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const replacement = createMeshArtifactRef({ uri: '/workspace/meshes/replacement.glb' })
  const workflow = createWaitWorkflow({ id: 'workflow-wait-substituted-continue-preview', afterWaitNode: processNode })

  window.electron.extensions.runProcess = async (extensionId: string, input: unknown, params: Record<string, unknown>) => {
    assert.equal(useAppStore.getState().currentJob?.previewKind, undefined)
    assert.equal(useAppStore.getState().currentJob?.outputUrl, undefined)
    runProcessCalls.push({ extensionId, input, params })
    return { success: true, result: { filePath: '/workspace/output/replacement-process.glb' } }
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension(), processExt])
  await waitForPause()

  assert.equal(useAppStore.getState().currentJob?.previewKind, 'workflow-checkpoint')

  useWorkflowRunStore.getState().continueRun({ replacementArtifact: replacement })
  await runPromise

  assert.deepEqual(runProcessCalls[0].input, {
    filePath: '/workspace/meshes/replacement.glb',
    text: undefined,
    nodeId: 'mesh-process',
  })
  assert.equal(useAppStore.getState().currentJob?.status, 'done')
  assert.equal(useAppStore.getState().currentJob?.outputUrl, '/workspace/output/replacement-process.glb')
  assert.equal(useAppStore.getState().currentJob?.previewKind, undefined)
})

test('workflowRunStore pauses landmarksNode like a mesh checkpoint and publishes landmark session preview', async () => {
  const workflow = createLandmarksWorkflow({ id: 'workflow-landmarks-preview' })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension()])
  await waitForPause()

  try {
    const state = useWorkflowRunStore.getState()
    const api = landmarksApi()

    assert.equal(state.runState.status, 'paused')
    assert.equal(state.runState.substitutionPoint?.kind, 'artifact_substitution')
    assert.equal(state.runState.substitutionPoint?.nodeId, 'landmarks-node')
    assert.deepEqual(state.runState.substitutionPoint?.allowedKinds, ['mesh'])
    assert.deepEqual(state.runState.artifact?.legacy, {
      filePath: '/workspace/meshes/original.glb',
      outputType: 'mesh',
    })
    assert.deepEqual(useAppStore.getState().currentJob, {
      ...useAppStore.getState().currentJob,
      status: 'generating',
      progress: 100,
      step: 'Workflow checkpoint',
      outputUrl: '/workspace/meshes/original.glb',
      previewKind: 'workflow-checkpoint',
    })
    assert.equal(api.landmarkSession?.nodeId, 'landmarks-node')
    assert.equal(api.landmarkSession?.targetArtifact.id, 'workflow-workflow-landmarks-preview-node-mesh-source')
    assert.equal(api.landmarkSession?.activeLandmarkId, 'left_shoulder')
    assert.deepEqual(api.landmarkSession?.completed, {})
    assert.deepEqual(api.landmarkSession?.validity, {
      valid: false,
      missing: ['left_shoulder', 'right_shoulder', 'hip', 'left_knee', 'right_knee'],
    })
    assert.equal(api.landmarkSession?.canContinue, false)
    assert.equal(api.landmarkSession?.captureRevision, 1)
    assert.equal(typeof api.landmarkSession?.captureId, 'string')
    assertLandmarkCapturePath(api.landmarkSession?.sidecarPath, 'workflow-landmarks-preview')
    assert.equal(api.landmarkSession?.sidecarStatus, 'not_started')
  } finally {
    useWorkflowRunStore.getState().cancel()
    await runPromise
  }
})

test('workflowRunStore blocks landmarks continue while required landmarks are missing without advancing silently', async () => {
  const processNode = createNode('process-after-landmarks', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: {},
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const workflow = createLandmarksWorkflow({ afterLandmarksNode: processNode })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension(), processExt])
  await waitForPause()

  landmarksApi().markLandmark(landmarkPoint('left_shoulder', 1))
  useWorkflowRunStore.getState().continueRun()
  await waitForPause()

  assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /Missing required landmarks: right_shoulder, hip, left_knee, right_knee/)
  assert.match(landmarksApi().landmarkSession?.error ?? '', /Missing required landmarks: right_shoulder, hip, left_knee, right_knee/)
  assert.equal(runProcessCalls.length, 0)
  assert.equal(landmarksApi().landmarkSession?.canContinue, false)

  landmarksApi().markLandmark(landmarkPoint('right_shoulder', 2))
  landmarksApi().markLandmark(landmarkPoint('hip', 3))
  landmarksApi().markLandmark(landmarkPoint('left_knee', 4))
  landmarksApi().markLandmark(landmarkPoint('right_knee', 5))
  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(runProcessCalls.length, 1)
  assert.deepEqual(runProcessCalls[0].input, {
    filePath: '/workspace/meshes/original.glb',
    text: undefined,
    nodeId: 'mesh-process',
  })
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

test('workflowRunStore writes a valid landmark sidecar and preserves the original mesh legacy output on continue', async () => {
  const workflow = createLandmarksWorkflow({ id: 'workflow-landmarks-sidecar' })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension()])
  await waitForPause()

  markAllRequiredLandmarks()
  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(landmarkSidecarWriteCalls.length, 1)
  assert.deepEqual(landmarkSidecarWriteCalls[0].sourceWorkspacePath, 'meshes/original.glb')
  const sidecarPath = assertLandmarkCapturePath(landmarkSidecarWriteCalls[0].sidecarWorkspacePath, 'workflow-landmarks-sidecar')
  assert.deepEqual(landmarkSidecarWriteCalls[0].sidecar.target, {
    artifactId: 'workflow-workflow-landmarks-sidecar-node-mesh-source',
    versionId: 'workflow-workflow-landmarks-sidecar-node-mesh-source-original',
    kind: 'mesh',
    meshPath: 'meshes/original.glb',
    lineage: {
      sidecarRole: 'landmarks-sidecar',
      runId: 'workflow-landmarks-sidecar',
      nodeId: 'landmarks-node',
      sidecarWorkspacePath: sidecarPath,
      targetArtifactId: 'workflow-workflow-landmarks-sidecar-node-mesh-source',
      targetVersionId: 'workflow-workflow-landmarks-sidecar-node-mesh-source-original',
      targetMeshPath: 'meshes/original.glb',
      downstreamParam: 'landmarks_sidecar_path',
    },
  })
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['landmarks-node']?.legacy, {
    filePath: '/workspace/meshes/original.glb',
    outputType: 'mesh',
  })
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/meshes/original.glb')
})

test('workflowRunStore normalizes absolute workspace mesh paths before writing landmark sidecar IPC', async () => {
  const workflow = createLandmarksWorkflow({
    id: 'workflow-landmarks-workspace-relative-sidecar',
    sourceFilePath: '/workspace/Workflows/generated/foo.glb',
  })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension()])
  await waitForPause()

  markAllRequiredLandmarks()
  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(landmarkSidecarWriteCalls.length, 1)
  assert.equal(landmarkSidecarWriteCalls[0].sourceWorkspacePath, 'Workflows/generated/foo.glb')
  assert.equal(landmarkSidecarWriteCalls[0].sidecar.target.meshPath, 'Workflows/generated/foo.glb')
  assert.equal((landmarkSidecarWriteCalls[0].sidecar.target.lineage as LandmarkSidecarLineageMetadata | undefined)?.targetMeshPath, 'Workflows/generated/foo.glb')
  assert.doesNotMatch(landmarkSidecarWriteCalls[0].sourceWorkspacePath, /^\//)
})

test('workflowRunStore rejects landmark sidecar writes when mesh path cannot be normalized inside workspace', async () => {
  const workflow = createLandmarksWorkflow({
    id: 'workflow-landmarks-outside-workspace-sidecar',
    sourceFilePath: '/tmp/outside-workspace.glb',
  })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension()])
  await waitForPause()

  markAllRequiredLandmarks()
  useWorkflowRunStore.getState().continueRun()
  await waitForPause()

  assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /outside workspace/i)
  assert.equal(landmarkSidecarWriteCalls.length, 0)

  useWorkflowRunStore.getState().cancel()
  await runPromise
})

test('workflowRunStore completes node to pick to write to continue and exposes sidecar history metadata', async () => {
  const processNode = createNode('process-after-picked-landmarks', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: {},
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const workflow = createLandmarksWorkflow({ id: 'workflow-landmarks-picked-happy-path', afterLandmarksNode: processNode })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension(), processExt])
  await waitForPause()

  markPickedLandmark('left_shoulder', 1)
  markPickedLandmark('right_shoulder', 2)
  markPickedLandmark('hip', 3)
  markPickedLandmark('left_knee', 4)
  markPickedLandmark('right_knee', 5)
  useWorkflowRunStore.getState().continueRun()
  await runPromise

  const sidecarPath = assertLandmarkCapturePath(
    landmarkSidecarWriteCalls[0]?.sidecarWorkspacePath,
    'workflow-landmarks-picked-happy-path',
  )
  assert.equal(landmarkSidecarWriteCalls.length, 1)
  assert.deepEqual(
    landmarkSidecarWriteCalls[0].sidecar.landmarks.map((landmark) => ({ id: landmark.id, x: landmark.world.x, objectName: landmark.objectName })),
    [
      { id: 'left_shoulder', x: 1, objectName: 'checkpoint-mesh' },
      { id: 'right_shoulder', x: 2, objectName: 'checkpoint-mesh' },
      { id: 'hip', x: 3, objectName: 'checkpoint-mesh' },
      { id: 'left_knee', x: 4, objectName: 'checkpoint-mesh' },
      { id: 'right_knee', x: 5, objectName: 'checkpoint-mesh' },
    ],
  )
  assert.deepEqual(runProcessCalls[0].input, {
    filePath: '/workspace/meshes/original.glb',
    text: undefined,
    nodeId: 'mesh-process',
  })
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts['landmarks-node']?.legacy, {
    filePath: '/workspace/meshes/original.glb',
    outputType: 'mesh',
  })
  assert.deepEqual(landmarksApi().landmarkSidecars?.['landmarks-node'], {
    sidecarRole: 'landmarks-sidecar',
    runId: 'workflow-landmarks-picked-happy-path',
    nodeId: 'landmarks-node',
    sidecarWorkspacePath: sidecarPath,
    targetArtifactId: 'workflow-workflow-landmarks-picked-happy-path-node-mesh-source',
    targetVersionId: 'workflow-workflow-landmarks-picked-happy-path-node-mesh-source-original',
    targetMeshPath: 'meshes/original.glb',
    downstreamParam: 'landmarks_sidecar_path',
  })
  assert.deepEqual(
    deriveArtifactHistoryRows({
      waitNodeId: 'landmarks-node',
      nodeArtifacts: useWorkflowRunStore.getState().nodeArtifacts,
      artifactLineages: useWorkflowRunStore.getState().artifactLineages,
      landmarkSidecar: landmarksApi().landmarkSidecars?.['landmarks-node'],
    }).map((row) => row.kind),
    ['checkpoint-original', 'landmark-sidecar'],
  )
})

test('workflowRunStore surfaces draft-only humanoid wait review state before Kimodo without inventing trust', async () => {
  const kimodoExt = createKimodoAnimateExtension()
  const workflow = createKimodoWaitWorkflow({ id: 'workflow-wait-kimodo-draft-only' })
  humanoidDraftReadResult = {
    success: true,
    status: 'found',
    sidecarWorkspacePath: 'Workflows/generated/avatar.humanoid-draft.v1.json',
    sidecar: structuredClone(humanoidDraftSidecar),
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension(), kimodoExt])
  await waitForPause()

  try {
    const review = waitCheckpointReviewState()
    assert.deepEqual(rigMetaReadCalls, [{ sourceWorkspacePath: 'Workflows/generated/avatar.glb' }])
    assert.deepEqual(humanoidDraftReadCalls, [{ meshWorkspacePath: 'Workflows/generated/avatar.glb' }])
    assert.deepEqual(humanoidPromotionReadCalls, [{ meshWorkspacePath: 'Workflows/generated/avatar.glb' }])
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: data as Record<string, unknown> })
        return { data: { job_id: 'job-kimodo-draft-only' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/kimodo-draft-only.glb' } }
    },
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension(), kimodoExt])
  await waitForPause()

  useWorkflowRunStore.getState().continueRun()
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: data as Record<string, unknown> })
        return { data: { job_id: 'job-kimodo-promoted' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/kimodo-promoted.glb' } }
    },
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension(), kimodoExt])
  await waitForPause()

  assert.equal(waitCheckpointReviewState()?.status, 'manual_confirmed')

  useWorkflowRunStore.getState().continueRun()
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: data as Record<string, unknown> })
        return { data: { job_id: 'job-kimodo-stale' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/kimodo-stale.glb' } }
    },
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createWaitExtension(), kimodoExt])
  await waitForPause()

  const review = waitCheckpointReviewState()
  assert.equal(review?.status, 'stale')
  assert.match(review?.headline ?? '', /stale/i)
  assert.match((review?.diagnostics ?? []).join('\n'), /mesh_output_sha256_mismatch|draft_sha256_mismatch/)

  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(postCalls.length, 1)
  assert.deepEqual(postCalls[0].data.params, {
    rigged_mesh_path: 'Workflows/generated/avatar.glb',
    mesh_path: 'Workflows/generated/avatar.glb',
    node_id: 'animate-rigged-mesh',
    model_id: kimodoExt.id,
    motion_prompt: 'Walk forward',
  })
})

test('workflowRunStore injects landmarks_sidecar_path into single-input UniRig Rig Mesh process params without model mesh routing', async () => {
  const rigMeshExt = createWorkflowExtension({
    id: 'unirig/rig-mesh',
    extensionId: 'unirig-tools',
    nodeId: 'rig-mesh',
    name: 'UniRig Rig Mesh',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
    params: [{ id: 'quality', label: 'Quality', type: 'string', default: 'draft' }],
  })
  const rigNode = createNode('single-input-rig-mesh-node', 'extensionNode', {
    extensionId: rigMeshExt.id,
    enabled: true,
    params: { quality: 'draft' },
  })
  const workflow = createLandmarksWorkflow({ id: 'workflow-landmarks-single-input-rig-mesh', afterLandmarksNode: rigNode })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension(), rigMeshExt])
  await waitForPause()

  markAllRequiredLandmarks()
  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(runProcessCalls.length, 1)
  assert.deepEqual(runProcessCalls[0].input, {
    filePath: '/workspace/meshes/original.glb',
    text: undefined,
    nodeId: 'rig-mesh',
  })
  assert.deepEqual(runProcessCalls[0].params, {
    quality: 'draft',
    landmarks_sidecar_path: assertLandmarkCapturePath(
      landmarkSidecarWriteCalls[0]?.sidecarWorkspacePath,
      'workflow-landmarks-single-input-rig-mesh',
    ),
  })
})


test('workflowRunStore injects landmarks_sidecar_path into Rig Mesh params with the original mesh path', async () => {
  const rigMeshExt = createWorkflowExtension({
    id: 'rigging/rig-mesh',
    extensionId: 'rigging-tools',
    nodeId: 'rig-mesh',
    name: 'Rig Mesh',
    type: 'model',
    input: 'image',
    output: 'mesh',
    inputs: [{ name: 'mesh', type: 'mesh', required: true }],
    params: [],
  })
  const rigNode = createNode('rig-mesh-node', 'extensionNode', {
    extensionId: rigMeshExt.id,
    enabled: true,
    params: { quality: 'draft' },
  })
  const workflow = createLandmarksWorkflow({ id: 'workflow-landmarks-rig-mesh', afterLandmarksNode: rigNode })
  const postCalls: FormData[] = []

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-image') {
        postCalls.push(data as FormData)
        return { data: { job_id: 'job-rig-mesh-landmarks' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/rigged.glb' } }
    },
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension(), rigMeshExt])
  await waitForPause()

  markAllRequiredLandmarks()
  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(postCalls.length, 1)
  assert.deepEqual(JSON.parse(String(postCalls[0].get('params'))), {
    quality: 'draft',
    mesh_path: 'meshes/original.glb',
    landmarks_sidecar_path: assertLandmarkCapturePath(landmarkSidecarWriteCalls[0]?.sidecarWorkspacePath, 'workflow-landmarks-rig-mesh'),
  })
})

test('workflowRunStore injects landmarks_sidecar_path into Unirig params with the original mesh path', async () => {
  const unirigExt = createWorkflowExtension({
    id: 'unirig/unirig',
    extensionId: 'unirig-tools',
    nodeId: 'unirig',
    name: 'Unirig',
    type: 'model',
    input: 'text',
    output: 'mesh',
    inputs: [
      { name: 'prompt', type: 'text', required: true },
      { name: 'rigged_mesh', type: 'mesh', required: true },
    ],
    params: [{ id: 'prompt', label: 'Prompt', type: 'string', default: 'Make a neutral rig' }],
  })
  const unirigNode = createNode('unirig-node', 'extensionNode', {
    extensionId: unirigExt.id,
    enabled: true,
    params: { prompt: 'Make a neutral rig' },
  })
  const workflow = createLandmarksWorkflow({ id: 'workflow-landmarks-unirig', afterLandmarksNode: unirigNode })
  const postCalls: Array<{ path: string; data: Record<string, unknown> }> = []

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-text') {
        postCalls.push({ path, data: data as Record<string, unknown> })
        return { data: { job_id: 'job-unirig-landmarks' } }
      }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get() {
      return { data: { status: 'done', output_url: '/workspace/output/unirigged.glb' } }
    },
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension(), unirigExt])
  await waitForPause()

  markAllRequiredLandmarks()
  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(postCalls.length, 1)
  assert.deepEqual(postCalls[0].data, {
    prompt: 'Make a neutral rig',
    model_id: unirigExt.id,
    collection: 'Workflows',
    remesh: 'none',
    enable_texture: false,
    texture_resolution: 1024,
    params: {
      rigged_mesh_path: 'meshes/original.glb',
      mesh_path: 'meshes/original.glb',
      node_id: 'unirig',
      model_id: unirigExt.id,
      landmarks_sidecar_path: assertLandmarkCapturePath(landmarkSidecarWriteCalls[0]?.sidecarWorkspacePath, 'workflow-landmarks-unirig'),
    },
  })
})

test('workflowRunStore keeps landmarks paused recoverably when sidecar write returns an invalid path', async () => {
  const processNode = createNode('process-after-invalid-landmarks-sidecar', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: {},
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const workflow = createLandmarksWorkflow({ id: 'workflow-landmarks-invalid-sidecar', afterLandmarksNode: processNode })
  window.electron.workspace.artifacts.writeLandmarkSidecar = async (request: LandmarkSidecarWriteCall) => {
    landmarkSidecarWriteCalls.push(request)
    return {
      success: true,
      sidecarWorkspacePath: 'Workflows/landmarks/workflow-landmarks-invalid-sidecar/wrong-node.landmarks.v1.json',
      sidecar: request.sidecar,
    }
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension(), processExt])
  await waitForPause()

  markAllRequiredLandmarks()
  useWorkflowRunStore.getState().continueRun()
  await waitForPause()

  assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /landmark sidecar/i)
  assert.equal(landmarksApi().landmarkSession?.sidecarStatus, 'error')
  assert.equal(runProcessCalls.length, 0)

  useWorkflowRunStore.getState().cancel()
  await runPromise
})

test('workflowRunStore keeps landmarks paused and cleans sidecar state when sidecar write fails recoverably', async () => {
  const processNode = createNode('process-after-missing-landmarks-sidecar', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: {},
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const workflow = createLandmarksWorkflow({ id: 'workflow-landmarks-missing-sidecar', afterLandmarksNode: processNode })
  window.electron.workspace.artifacts.writeLandmarkSidecar = async (request: LandmarkSidecarWriteCall) => {
    landmarkSidecarWriteCalls.push(request)
    return { success: false, error: 'sidecar file is missing after write' }
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension(), processExt])
  await waitForPause()

  markAllRequiredLandmarks()
  useWorkflowRunStore.getState().continueRun()
  await waitForPause()

  assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /sidecar file is missing after write/)
  assert.equal(landmarksApi().landmarkSession?.sidecarStatus, 'error')
  assert.equal(runProcessCalls.length, 0)
  assert.deepEqual(landmarksApi().landmarkSidecars, {})

  useWorkflowRunStore.getState().cancel()
  await runPromise

  assert.equal(landmarksApi().landmarkSession, undefined)
  assert.deepEqual(landmarksApi().landmarkSidecars, {})
  assert.deepEqual(useWorkflowRunStore.getState().nodeArtifacts, {})
})

test('workflowRunStore renews sidecar path after clear so re-marking continues without overwriting prior sidecar', async () => {
  const processNode = createNode('process-after-clear-landmarks', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: {},
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const workflow = createLandmarksWorkflow({ id: 'workflow-landmarks-clear-retry', afterLandmarksNode: processNode })
  const existingSidecarPaths = new Set<string>()
  window.electron.workspace.artifacts.writeLandmarkSidecar = async (request: LandmarkSidecarWriteCall) => {
    landmarkSidecarWriteCalls.push(request)
    if (existingSidecarPaths.has(request.sidecarWorkspacePath)) {
      return { success: false, error: 'Edited scene artifact landmark sidecar already exists; refusing to overwrite' }
    }
    existingSidecarPaths.add(request.sidecarWorkspacePath)
    return { success: true, sidecarWorkspacePath: request.sidecarWorkspacePath, sidecar: request.sidecar }
  }

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension(), processExt])
  await waitForPause()

  const firstPath = assertLandmarkCapturePath(landmarksApi().landmarkSession?.sidecarPath, 'workflow-landmarks-clear-retry')
  existingSidecarPaths.add(firstPath)
  markAllRequiredLandmarks()
  useWorkflowRunStore.getState().continueRun()
  await waitForPause()

  assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /already exists|overwrite/i)

  landmarksApi().resetLandmarks('landmarks-node')
  const retryPath = assertLandmarkCapturePath(landmarksApi().landmarkSession?.sidecarPath, 'workflow-landmarks-clear-retry')
  assert.notEqual(retryPath, firstPath)
  markAllRequiredLandmarks()
  useWorkflowRunStore.getState().continueRun()
  await runPromise

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(runProcessCalls.length, 1)
  assert.equal(landmarkSidecarWriteCalls.length, 2)
  assert.equal(landmarkSidecarWriteCalls[1].sidecarWorkspacePath, retryPath)
  assert.doesNotMatch(useWorkflowRunStore.getState().runState.error ?? '', /overwrite/i)
})

test('workflowRunStore creates distinct landmark sidecar paths for separate executions of the same workflow node', async () => {
  const workflow = createLandmarksWorkflow({ id: 'workflow-landmarks-distinct-sessions' })

  const firstRun = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension()])
  await waitForPause()
  const firstPath = assertLandmarkCapturePath(landmarksApi().landmarkSession?.sidecarPath, 'workflow-landmarks-distinct-sessions')
  useWorkflowRunStore.getState().cancel()
  await firstRun

  const secondRun = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension()])
  await waitForPause()
  const secondPath = assertLandmarkCapturePath(landmarksApi().landmarkSession?.sidecarPath, 'workflow-landmarks-distinct-sessions')
  useWorkflowRunStore.getState().cancel()
  await secondRun

  assert.notEqual(firstPath, secondPath)
})

test('workflowRunStore mark and re-mark replace landmarks while advancing the active landmark id', async () => {
  const workflow = createLandmarksWorkflow()

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension()])
  await waitForPause()

  try {
    landmarksApi().markLandmark(landmarkPoint('left_shoulder', 1, 'first-hit'))
    assert.equal(landmarksApi().landmarkSession?.activeLandmarkId, 'right_shoulder')
    assert.equal(landmarksApi().landmarkSession?.completed.left_shoulder?.world.x, 1)

    landmarksApi().markLandmark(landmarkPoint('left_shoulder', 9, 'replacement-hit'))
    assert.equal(landmarksApi().landmarkSession?.activeLandmarkId, 'right_shoulder')
    assert.equal(landmarksApi().landmarkSession?.completed.left_shoulder?.world.x, 9)
    assert.equal(landmarksApi().landmarkSession?.completed.left_shoulder?.objectName, 'replacement-hit')

    landmarksApi().markLandmark(landmarkPoint('right_shoulder', 2))
    assert.equal(landmarksApi().landmarkSession?.activeLandmarkId, 'hip')
    assert.deepEqual(landmarksApi().landmarkSession?.validity.missing, ['hip', 'left_knee', 'right_knee'])
  } finally {
    useWorkflowRunStore.getState().cancel()
    await runPromise
  }
})

test('workflowRunStore resetLandmarks clears placed points while keeping the active capture at 0 of 5', async () => {
  const workflow = createLandmarksWorkflow()

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension()])
  await waitForPause()

  landmarksApi().markLandmark(landmarkPoint('left_shoulder', 1))
  const initialCaptureId = landmarksApi().landmarkSession?.captureId
  const initialSidecarPath = landmarksApi().landmarkSession?.sidecarPath
  const initialRevision = landmarksApi().landmarkSession?.captureRevision
  const stateBeforeResetError = useWorkflowRunStore.getState()
  useWorkflowRunStore.setState({
    runState: { ...stateBeforeResetError.runState, error: 'Landmark sidecar is not ready: existing path' },
    landmarkSession: stateBeforeResetError.landmarkSession
      ? { ...stateBeforeResetError.landmarkSession, error: 'Landmark sidecar is not ready: existing path', sidecarStatus: 'error' }
      : undefined,
  })
  assert.equal(landmarksApi().landmarkSession?.completed.left_shoulder?.world.x, 1)

  landmarksApi().resetLandmarks('landmarks-node')
  assert.equal(landmarksApi().landmarkSession?.nodeId, 'landmarks-node')
  assert.equal(landmarksApi().landmarkSession?.activeLandmarkId, 'left_shoulder')
  assert.deepEqual(landmarksApi().landmarkSession?.completed, {})
  assert.deepEqual(deriveLandmarkMarkers(landmarksApi().landmarkSession?.completed), [])
  assert.equal(REQUIRED_LANDMARK_IDS.filter((id) => landmarksApi().landmarkSession?.completed[id] !== undefined).length, 0)
  assert.equal(landmarksApi().landmarkSession?.canContinue, false)
  assert.notEqual(landmarksApi().landmarkSession?.captureId, initialCaptureId)
  assert.notEqual(landmarksApi().landmarkSession?.sidecarPath, initialSidecarPath)
  assert.equal(landmarksApi().landmarkSession?.captureRevision, (initialRevision ?? 0) + 1)
  assert.equal(landmarksApi().landmarkSession?.error, undefined)
  assert.equal(landmarksApi().landmarkSession?.sidecarStatus, 'not_started')
  assert.equal(useWorkflowRunStore.getState().runState.error, undefined)
  assert.deepEqual(landmarksApi().landmarkSession?.validity, {
    valid: false,
    missing: ['left_shoulder', 'right_shoulder', 'hip', 'left_knee', 'right_knee'],
  })
  assert.equal(landmarksApi().landmarkSession?.canContinue, false)

  useWorkflowRunStore.getState().cancel()
  await runPromise
  assert.equal(landmarksApi().landmarkSession, undefined)

  const secondRunPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension()])
  await waitForPause()
  landmarksApi().markLandmark(landmarkPoint('left_shoulder', 7))
  useWorkflowRunStore.getState().reset()
  useWorkflowRunStore.getState().cancel()
  await secondRunPromise

  assert.equal(landmarksApi().landmarkSession, undefined)
  assert.equal(useWorkflowRunStore.getState().runState.status, 'idle')
})

test('workflowRunStore selects a placed landmark for editing so the next mesh click re-marks that point', async () => {
  const workflow = createLandmarksWorkflow()

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension()])
  await waitForPause()

  try {
    landmarksApi().markLandmark(landmarkPoint('left_shoulder', 1, 'initial-left-shoulder'))
    landmarksApi().markLandmark(landmarkPoint('right_shoulder', 2))
    assert.equal(landmarksApi().landmarkSession?.activeLandmarkId, 'hip')

    landmarksApi().selectLandmarkForEditing('left_shoulder')
    assert.equal(landmarksApi().landmarkSession?.activeLandmarkId, 'left_shoulder')

    landmarksApi().markLandmark(landmarkPoint('left_shoulder', 9, 'edited-left-shoulder'))
    assert.equal(landmarksApi().landmarkSession?.completed.left_shoulder?.world.x, 9)
    assert.equal(landmarksApi().landmarkSession?.completed.left_shoulder?.objectName, 'edited-left-shoulder')
    assert.equal(landmarksApi().landmarkSession?.activeLandmarkId, 'hip')
  } finally {
    useWorkflowRunStore.getState().cancel()
    await runPromise
  }
})

test('workflowRunStore keeps landmarks errors recoverable and state consistent after reset then continue', async () => {
  const processNode = createNode('process-after-landmarks-error', 'extensionNode', {
    extensionId: 'vendor/mesh-process',
    enabled: true,
    params: {},
  })
  const processExt = createWorkflowExtension({
    id: 'vendor/mesh-process',
    extensionId: 'vendor-process',
    nodeId: 'mesh-process',
    type: 'process',
    input: 'mesh',
    output: 'mesh',
  })
  const workflow = createLandmarksWorkflow({ afterLandmarksNode: processNode })

  const runPromise = useWorkflowRunStore.getState().run(workflow, [createLandmarksExtension(), processExt])
  await waitForPause()

  landmarksApi().resetLandmarks('landmarks-node')
  useWorkflowRunStore.getState().continueRun()
  await waitForPause()

  assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /Missing required landmarks: left_shoulder, right_shoulder, hip, left_knee, right_knee/)
  assert.equal(useWorkflowRunStore.getState().runState.substitutionPoint?.nodeId, 'landmarks-node')
  assert.equal(runProcessCalls.length, 0)
  assert.equal(useWorkflowRunStore.getState().nodeArtifacts['landmarks-node'], undefined)

  useWorkflowRunStore.getState().cancel()
  await runPromise
})

test('workflowRunStore surfaces a recoverable error instead of silently no-oping when a paused checkpoint has no live continuation', () => {
  const targetArtifact = createMeshArtifactRef({ id: 'stale-target', uri: '/workspace/meshes/stale.glb' })
  useWorkflowRunStore.setState({
    activeNodeId: 'landmarks-node',
    runState: {
      status: 'paused',
      blockIndex: 1,
      blockTotal: 4,
      blockProgress: 100,
      blockStep: 'Paused — mark required landmarks',
      artifact: targetArtifact,
      substitutionPoint: {
        kind: 'artifact_substitution',
        nodeId: 'landmarks-node',
        inputArtifactId: targetArtifact.id,
        inputArtifact: targetArtifact,
        allowedKinds: ['mesh'],
        status: 'declared',
        interaction: { boundary: 'ui_only', headless: false, editor: 'none', continueMode: 'manual' },
      },
    },
    landmarkSession: {
      nodeId: 'landmarks-node',
      targetArtifact,
      activeLandmarkId: 'right_knee',
      completed: {
        left_shoulder: landmarkPoint('left_shoulder', 1),
        right_shoulder: landmarkPoint('right_shoulder', 2),
        hip: landmarkPoint('hip', 3),
        left_knee: landmarkPoint('left_knee', 4),
        right_knee: landmarkPoint('right_knee', 5),
      },
      validity: { valid: true, missing: [] },
      canContinue: true,
      sidecarPath: 'Workflows/landmarks/stale/landmarks-node.landmarks.v1.json',
      sidecarStatus: 'pending-write',
    },
  })

  useWorkflowRunStore.getState().continueRun()

  assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /not resumable/i)
  assert.equal(landmarksApi().landmarkSession?.sidecarStatus, 'error')
})


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

  assert.deepEqual(request, {
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      postCalls.push({ path, data })
      if (path === '/generate/from-none') return { data: { job_id: 'job-gaussiangpt-none' } }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-gaussiangpt-none')
      return { data: { status: 'done', output_url: '/workspace/Workflows/gaussiangpt.glb' } }
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
  assert.equal(useWorkflowRunStore.getState().runState.outputUrl, '/workspace/Workflows/gaussiangpt.glb')
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      postCalls.push({ path, data })
      if (path === '/generate/from-none') return { data: { job_id: 'job-none-no-fallback' } }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-none-no-fallback')
      return { data: { status: 'done', output_url: '/workspace/Workflows/no-fallback.glb' } }
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

test('workflowRunStore ignores incoming edges for inputless models and still runs them as sources', async () => {
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string) {
      assert.equal(path, '/generate/from-none')
      return { data: { job_id: 'job-inputless-ignores-edge' } }
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-inputless-ignores-edge')
      return { data: { status: 'done', output_url: '/workspace/Workflows/generated.scene.json', output_kind: 'scene' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-none') return { data: { job_id: 'job-kind-mismatch' } }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-kind-mismatch')
      return { data: { status: 'done', output_url: '/workspace/Workflows/generated.scene.json', output_kind: 'scene' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(useWorkflowRunStore.getState().runState.status, 'error')
  assert.match(useWorkflowRunStore.getState().runState.error ?? '', /declared output "mesh" but generated "scene"/i)
  assert.deepEqual(useWorldsSceneStore.getState().sceneItems, [])
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

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

test('workflowRunStore preserves hard output-kind enforcement while accepting declared image outputs', async () => {
  const ext = createWorkflowExtension({
    id: 'dreamcube/generate-image',
    extensionId: 'dreamcube',
    nodeId: 'generate-image',
    name: 'DreamCube Image',
    input: 'none',
    output: 'image',
    params: [],
  })
  const workflow: Workflow = {
    id: 'workflow-image-output-kind',
    name: 'Image output kind',
    description: '',
    nodes: [createNode('model-node', 'extensionNode', { extensionId: ext.id, enabled: true, params: {} })],
    edges: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  axiosClientMock = {
    async post(path: string, data?: unknown) {
      if (path === '/generate/from-none') return { data: { job_id: 'job-image-output-kind' } }
      throw new Error(`Unexpected axios.post call: ${path}`)
    },
    async get(path: string) {
      assert.equal(path, '/generate/status/job-image-output-kind')
      return { data: { status: 'done', output_url: '/workspace/Workflows/generated.png', output_kind: 'image' } }
    },
  }

  await useWorkflowRunStore.getState().run(workflow, [ext])

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().nodeArtifacts['model-node']?.kind, 'image')
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

  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

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
      return { data: { status: 'done', output_url: '/workspace/Workflows/generated.scene.json', output_kind: 'scene' } }
    },
  }

  try {
    await useWorkflowRunStore.getState().run(workflow, [ext])
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
  assert.equal(useWorkflowRunStore.getState().nodeArtifacts['model-node']?.kind, 'scene')
  assert.deepEqual(useWorldsSceneStore.getState().sceneItems.map((item) => item.id), ['base'])
})
