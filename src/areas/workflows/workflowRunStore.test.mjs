import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadStore() {
  const dir = mkdtempSync(join(tmpdir(), 'modly-runstore-test-'))
  const outfile = join(dir, 'workflowRunStore.cjs')
  const axiosStub = join(dir, 'axios-stub.mjs')
  const appStoreStub = join(dir, 'app-store-stub.mjs')
  const require = createRequire(import.meta.url)
  writeFileSync(axiosStub, `
    const axios = {
      create(config) {
        return globalThis.__modlyAxiosCreate(config)
      },
    }
    export default axios
  `, 'utf8')
  writeFileSync(appStoreStub, `
    export const useAppStore = {
      getState() {
        return globalThis.__modlyAppState
      },
    }
  `, 'utf8')
  const result = buildSync({
    entryPoints: [resolve('src/areas/workflows/workflowRunStore.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    alias: {
      axios: axiosStub,
      '@shared/stores/appStore': appStoreStub,
      '@shared/utils/inputPorts': resolve('src/shared/utils/inputPorts.ts'),
    },
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile).useWorkflowRunStore
}

function stubWindow() {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { randomUUID: () => 'run-id' },
  })
  globalThis.__modlyAppState = {
    apiUrl: 'http://test.local',
    selectedImagePath: undefined,
    selectedImageData: undefined,
    currentJob: undefined,
    setCurrentJob: () => {},
    updateCurrentJob: () => {},
  }
  globalThis.window = {
    electron: {
      settings: { get: async () => ({ workspaceDir: '/workspace' }) },
      fs: {
        deleteDirectory: async () => {},
        readFileBase64: async () => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    },
  }
}

const workflow = {
  id: 'wf',
  name: 'wf',
  description: '',
  nodes: [
    { id: 'subject-img', type: 'imageNode', position: { x: 0, y: 0 }, data: { params: { filePath: '/workspace/subject.png' } } },
    { id: 'style-img', type: 'imageNode', position: { x: 0, y: 0 }, data: { params: { filePath: '/workspace/style.png' } } },
    { id: 'gen', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/model', enabled: true, params: {} } },
  ],
  edges: [
    { id: 'e1', source: 'style-img', target: 'gen', targetHandle: 'style' },
    { id: 'e2', source: 'subject-img', target: 'gen', targetHandle: 'subject' },
  ],
}

const namedModel = {
  id: 'pack/model',
  extensionId: 'pack',
  extensionName: 'Pack',
  extensionAuthor: 'tester',
  nodeId: 'model',
  name: 'Named Model',
  description: '',
  input: 'image',
  output: 'mesh',
  params: [],
  builtin: false,
  type: 'model',
  io_contract: 'named-v1',
  input_ports: [
    { name: 'subject', type: 'image', required: true },
    { name: 'style', type: 'image', required: false },
  ],
}

test('named-v1 model posts repeated images and image_names in manifest order', async () => {
  stubWindow()
  const calls = []
  globalThis.__modlyAxiosCreate = () => ({
    post: async (url, body) => {
      calls.push({ url, body })
      return { data: { job_id: 'job-1' } }
    },
    get: async () => ({ data: { status: 'done', output_url: '/workspace/out.glb' } }),
  })
  const useStore = loadStore()

  await useStore.getState().run(workflow, [namedModel])

  const generationCall = calls.find((call) => call.url === '/generate/from-images')
  assert.ok(generationCall)
  assert.deepEqual(generationCall.body.getAll('image_names'), ['subject', 'style'])
  assert.equal(generationCall.body.getAll('images').length, 2)
})
