import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import type { Workflow, WFEdge, WFNode } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions'
import { resolveWorkflowDispatch } from './workflowDispatch.ts'

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
  entryPoints: [fileURLToPath(new URL('./workflowRunStore.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'inert-dispatch-adapters', setup(builder) {
    builder.onResolve({ filter: /^(axios|@shared\/stores\/appStore|@shared\/utils\/notification)$/ }, (args) => ({ path: args.path, namespace: 'inert' }))
    builder.onLoad({ filter: /.*/, namespace: 'inert' }, ({ path: id }) => ({ loader: 'ts', contents: id === 'axios'
      ? 'export default { create: () => globalThis.fixture.client }'
      : id.endsWith('appStore') ? 'export const useAppStore = { getState: () => globalThis.fixture.app }'
      : 'export const showCompletionNotification = () => {}; export const showErrorNotification = () => {}' }))
  } }],
})).outputFiles[0].text

let useWorkflowRunStore: WorkflowRunStore
let axiosClientMock: AxiosClientMock
let runProcessCalls: RunProcessCall[]
let fsReadCalls: string[]
let iteratorFileNames: string[]
let workspaceDir: string
let onProcessRun: ((call: RunProcessCall) => void) | undefined
let appState: {
  apiUrl: string
  selectedImagePath: string | undefined
  selectedImageData: string | undefined
  currentJob: Record<string, unknown> | null
  setCurrentJob(value: Record<string, unknown>): void
  updateCurrentJob(value: Record<string, unknown>): void
}

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
  appState = {
    apiUrl: 'http://inert.invalid', currentJob: null,
    selectedImagePath: '/tmp/source.png', selectedImageData: Buffer.from('png-bytes').toString('base64'),
    setCurrentJob(value) { this.currentJob = value },
    updateCurrentJob(value) { this.currentJob = { ...this.currentJob, ...value } },
  }
  const fixture = { app: appState, get client() { return axiosClientMock } }
  const window = { electron: {
    settings: { get: async () => ({ workspaceDir }) },
    fs: {
      deleteDirectory: async () => ({ success: true }),
      listFiles: async () => iteratorFileNames,
      readFileBase64: async (filePath: string) => {
        fsReadCalls.push(filePath)
        return Buffer.from('fs-bytes').toString('base64')
      },
    },
    extensions: { runProcess: async (extensionId: string, input: unknown, params: Record<string, unknown>) => {
      runProcessCalls.push(JSON.parse(JSON.stringify({ extensionId, input, params })))
      onProcessRun?.(runProcessCalls.at(-1)!)
      return { success: true, result: { filePath: '/workspace/output/process.glb' } }
    } },
  } }
  const module = { exports: {} as { useWorkflowRunStore: WorkflowRunStore } }
  vm.runInNewContext(storeBundle, {
    module, exports: module.exports, require: createRequire(import.meta.url), fixture, window,
    process, console, crypto, Blob, FormData, atob,
    // Polling delay is inert; each client is a bounded in-memory fixture.
    setTimeout: (callback: () => void) => { callback(); return 0 }, clearTimeout: () => {},
  })
  useWorkflowRunStore = module.exports.useWorkflowRunStore
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

function createTextMeshWorkflow(args: { node: WFNode; text?: string; meshFilePath?: string; includeMeshEdge?: boolean }): Workflow {
  const nodes = [
    createNode('text-source', 'textNode', { enabled: true, params: { text: args.text ?? 'Walk forward' } }),
    createNode('mesh-source', 'meshNode', { enabled: true, params: { source: 'file', filePath: args.meshFilePath ?? '/workspace/rigs/avatar.glb' } }),
    args.node,
    createNode('output-node', 'outputNode', { enabled: true, params: {} }),
  ]
  const edges: WFEdge[] = [
    { id: 'edge-text', source: 'text-source', target: args.node.id, targetHandle: 'prompt' },
    ...(args.includeMeshEdge === false ? [] : [{ id: 'edge-mesh', source: 'mesh-source', target: args.node.id, targetHandle: 'rigged_mesh' }]),
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
    },
  })
  assert.deepEqual(fsReadCalls, [])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
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
      for (let i = 0; i < 100 && useWorkflowRunStore.getState().runState.status !== 'paused'; i++) await Promise.resolve()
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
