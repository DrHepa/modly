import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import axios from 'axios'
import type { Workflow, WFEdge, WFNode } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions'
import { resolveWorkflowDispatch } from './workflowDispatch.ts'

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
const { useWorkflowRunStore } = await import(new URL('./workflowRunStore.ts', import.meta.url).href)

type AxiosClientMock = {
  post: (path: string, data?: unknown, config?: unknown) => Promise<unknown>
  get: (path: string) => Promise<unknown>
}

type RunProcessCall = {
  extensionId: string
  input: unknown
  params: Record<string, unknown>
}

const originalAxiosCreate = axios.create
const originalSetTimeout = globalThis.setTimeout

let axiosClientMock: AxiosClientMock
let runProcessCalls: RunProcessCall[]
let fsReadCalls: string[]

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
          return Buffer.from('fs-bytes').toString('base64')
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
