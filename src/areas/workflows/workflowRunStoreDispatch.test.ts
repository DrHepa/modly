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
  onProcessRun = undefined
  appState = {
    apiUrl: 'http://inert.invalid', currentJob: null,
    selectedImagePath: '/tmp/source.png', selectedImageData: Buffer.from('png-bytes').toString('base64'),
    setCurrentJob(value) { this.currentJob = value },
    updateCurrentJob(value) { this.currentJob = { ...this.currentJob, ...value } },
  }
  const fixture = { app: appState, get client() { return axiosClientMock } }
  const window = { electron: {
    settings: { get: async () => ({ workspaceDir: '/workspace' }) },
    fs: {
      deleteDirectory: async () => ({ success: true }),
      listFiles: async () => [],
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

for (const type of ['model', 'process'] as const) {
  test(`actual ${type} dispatch reads live params again on each While iteration`, async () => {
    const ext = createWorkflowExtension({ type })
    const target = createExtensionNode(ext.id)
    target.parentId = 'while'
    target.data.params = { count: 1, custom: 'original' }
    const workflow = createWorkflow(target)
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
