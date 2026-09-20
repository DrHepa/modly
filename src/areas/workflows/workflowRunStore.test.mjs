import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'modly-workflow-store-'))
const stub = (name, source) => {
  const path = join(dir, name)
  writeFileSync(path, source)
  return path
}

const appStoreStub = stub('appStore.ts', `
export const appState: any = (globalThis as any).__workflowAppState ??= {
  apiUrl: 'http://modly.test', currentJob: null, selectedImagePath: undefined, selectedImageData: undefined,
  setCurrentJob(job: any) { this.currentJob = job },
  updateCurrentJob(patch: any) { this.currentJob = this.currentJob ? { ...this.currentJob, ...patch } : { ...patch } },
}
export const useAppStore: any = (selector: any) => selector(appState)
useAppStore.getState = () => appState
`)
const axiosStub = stub('axios.ts', `
const axios: any = { create: () => (globalThis as any).__workflowClient }
export default axios
export type AxiosInstance = any
`)
const extensionsStub = stub('extensions.ts', `
export const getWorkflowExtension = (id: string, all: any[]) => all.find((ext) => ext.id === id)
export type WorkflowExtension = any
`)
const notificationStub = stub('notification.ts', `export const showCompletionNotification = async () => {}`)
const sceneStub = stub('scene.ts', `export const resolveSceneSourceManifest = async () => ({ ok: false, error: 'unused' })`)
const captureStub = stub('capture.ts', `export const resolveCaptureSourceManifest = async ({ capturePath }) => ({ ok: true, manifestWorkspacePath: capturePath, manifestAbsolutePath: capturePath })`)

const outfile = join(dir, 'store.cjs')
const aliases = new Map([
  ['axios', axiosStub],
  ['@shared/stores/appStore', appStoreStub],
  ['./mockExtensions', extensionsStub],
  ['@shared/utils/notification', notificationStub],
  ['./workflowSceneSource', sceneStub],
  ['./workflowCaptureSource', captureStub],
])
writeFileSync(outfile, (await build({
  entryPoints: [resolve('src/areas/workflows/workflowRunStore.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [{
    name: 'workflow-store-test-aliases',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => aliases.has(args.path) ? { path: aliases.get(args.path) } : null)
    },
  }],
})).outputFiles[0].text)
const require = createRequire(import.meta.url)
const { useWorkflowRunStore, toWorkspaceUrl } = require(outfile)
const { appState } = require(appStoreStub)

const node = (id, type, params = {}, extensionId) => ({
  id, type, position: { x: 0, y: 0 },
  data: { enabled: true, params, ...(extensionId ? { extensionId } : {}) },
})
const edge = (source, target) => ({ id: `${source}->${target}`, source, target })
const workflow = (nodes, edges) => ({ id: 'wf', name: 'Test', description: '', nodes, edges, createdAt: '', updatedAt: '' })
const processExt = (id = 'proc') => ({ id, type: 'process', name: id, input: 'mesh', output: 'mesh' })
const modelExt = (id = 'model', input = 'image') => ({ id, type: 'model', name: id, input, output: input === 'capture' ? 'scene' : 'mesh', params: [] })

let processImpl
let imports
let posts

function resetHarness() {
  useWorkflowRunStore.getState().reset()
  appState.currentJob = null
  imports = []
  posts = []
  processImpl = async (input) => ({ success: true, result: { filePath: input.filePath } })
  globalThis.window = {
    electron: {
      settings: { get: async () => ({ workspaceDir: '/workspace' }) },
      fs: { deleteDirectory: async () => ({ success: true }), listFiles: async () => [], readFileBase64: async () => '' },
      extensions: { runProcess: (...args) => processImpl(...args) },
    },
  }
  globalThis.__workflowClient = {
    post: async (url, body) => {
      posts.push(url)
      if (url === '/optimize/import-by-path') {
        imports.push(body.path)
        return { data: { url: `/optimize/serve-file?path=${encodeURIComponent(body.path)}` } }
      }
      return { data: { job_id: 'job' } }
    },
    get: async () => ({ data: { status: 'done', progress: 100, output_url: '/workspace/generated.glb' } }),
  }
}

test.beforeEach(resetHarness)

test('cancelled async execution cannot repopulate mesh outputs or current job', async () => {
  let release
  processImpl = () => new Promise((resolve) => { release = resolve })
  const wf = workflow(
    [node('mesh', 'meshNode', { source: 'file', filePath: '/workspace/in.glb' }), node('proc', 'extensionNode', {}, 'proc'), node('out', 'outputNode')],
    [edge('mesh', 'proc'), edge('proc', 'out')],
  )
  const running = useWorkflowRunStore.getState().run(wf, [processExt()])
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  useWorkflowRunStore.getState().cancel()
  release({ success: true, result: { filePath: '/workspace/late.glb' } })
  await running
  assert.deepEqual(useWorkflowRunStore.getState().nodeMeshOutputs, {})
  assert.equal(appState.currentJob, null)
})

test('late image submission is cancelled by its returned id without touching the newer run', async () => {
  let releaseOld
  let imagePosts = 0
  globalThis.__workflowClient.post = async (url) => {
    posts.push(url)
    if (url !== '/generate/from-image') return { data: {} }
    imagePosts++
    if (imagePosts === 1) return new Promise((resolve) => { releaseOld = resolve })
    return { data: { job_id: 'job-new-image' } }
  }
  const wf = workflow([node('model', 'extensionNode', {}, 'model'), node('out', 'outputNode')], [edge('model', 'out')])
  const oldRun = useWorkflowRunStore.getState().run(wf, [modelExt()], 'aW1hZ2U=')
  while (!releaseOld) await new Promise((resolve) => setImmediate(resolve))
  useWorkflowRunStore.getState().cancel()
  const newerRun = useWorkflowRunStore.getState().run(wf, [modelExt()], 'aW1hZ2U=')
  while (imagePosts < 2) await new Promise((resolve) => setImmediate(resolve))
  releaseOld({ data: { job_id: 'job-old-image' } })
  await oldRun
  assert.ok(posts.includes('/generate/cancel/job-old-image'))
  assert.ok(!posts.includes('/generate/cancel/job-new-image'))
  await newerRun
})

test('late artifact submission is cancelled by its returned id without touching the newer run', async () => {
  let releaseOld
  let artifactPosts = 0
  globalThis.__workflowClient.post = async (url) => {
    posts.push(url)
    if (url !== '/generate/from-artifact') return { data: {} }
    artifactPosts++
    if (artifactPosts === 1) return new Promise((resolve) => { releaseOld = resolve })
    return { data: { job_id: 'job-new-artifact' } }
  }
  const wf = workflow(
    [node('capture', 'captureNode', { path: '/workspace/capture.json' }), node('model', 'extensionNode', {}, 'model'), node('out', 'outputNode')],
    [edge('capture', 'model'), edge('model', 'out')],
  )
  const oldRun = useWorkflowRunStore.getState().run(wf, [modelExt('model', 'capture')])
  while (!releaseOld) await new Promise((resolve) => setImmediate(resolve))
  useWorkflowRunStore.getState().cancel()
  const newerRun = useWorkflowRunStore.getState().run(wf, [modelExt('model', 'capture')])
  while (artifactPosts < 2) await new Promise((resolve) => setImmediate(resolve))
  releaseOld({ data: { job_id: 'job-old-artifact' } })
  await oldRun
  assert.ok(posts.includes('/generate/cancel/job-old-artifact'))
  assert.ok(!posts.includes('/generate/cancel/job-new-artifact'))
  await newerRun
})

test('producer mesh is published while the workflow is paused at a Wait', async () => {
  processImpl = async () => ({ success: true, result: { filePath: '/workspace/pre-wait.glb' } })
  const wf = workflow(
    [node('mesh', 'meshNode', { source: 'file', filePath: '/workspace/in.glb' }), node('proc', 'extensionNode', {}, 'proc'), node('wait', 'waitNode'), node('out', 'outputNode')],
    [edge('mesh', 'proc'), edge('proc', 'wait'), edge('wait', 'out')],
  )
  await useWorkflowRunStore.getState().run(wf, [processExt()])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
  assert.equal(useWorkflowRunStore.getState().nodeMeshOutputs.proc, '/workspace/pre-wait.glb')
})

test('completed branch publishes its mesh while another branch is still pending', async () => {
  processImpl = async (_id, input) => ({ success: true, result: { filePath: input.filePath.replace('.glb', '-done.glb') } })
  const wf = workflow(
    [
      node('a', 'meshNode', { source: 'file', filePath: '/workspace/a.glb' }), node('wa', 'waitNode'), node('pa', 'extensionNode', {}, 'pa'), node('oa', 'outputNode'),
      node('b', 'meshNode', { source: 'file', filePath: '/workspace/b.glb' }), node('wb', 'waitNode'), node('pb', 'extensionNode', {}, 'pb'), node('ob', 'outputNode'),
    ],
    [edge('a', 'wa'), edge('wa', 'pa'), edge('pa', 'oa'), edge('b', 'wb'), edge('wb', 'pb'), edge('pb', 'ob')],
  )
  await useWorkflowRunStore.getState().run(wf, [processExt('pa'), processExt('pb')])
  await useWorkflowRunStore.getState().continueRun('wa')
  assert.equal(useWorkflowRunStore.getState().runState.status, 'paused')
  assert.equal(useWorkflowRunStore.getState().nodeMeshOutputs.pa, '/workspace/a-done.glb')
  assert.equal(useWorkflowRunStore.getState().nodeMeshOutputs.pb, undefined)
})

test('workspace containment is path-boundary aware', () => {
  assert.equal(toWorkspaceUrl('/workspace/result.glb', '/workspace'), '/workspace/result.glb')
  assert.equal(toWorkspaceUrl('/workspace-sibling/result.glb', '/workspace'), undefined)
})

test('workspace containment canonicalizes dot segments before classification', () => {
  assert.equal(toWorkspaceUrl('/workspace/safe/../result.glb', '/workspace'), '/workspace/result.glb')
  assert.equal(toWorkspaceUrl('/workspace/safe/../../escape.glb', '/workspace'), undefined)
  assert.equal(toWorkspaceUrl('C:\\workspace\\safe\\..\\result.glb', 'C:\\workspace'), '/workspace/result.glb')
  assert.equal(toWorkspaceUrl('C:\\workspace\\safe\\..\\..\\escape.glb', 'C:\\workspace'), undefined)
})

test('external Load 3D Mesh is imported through the existing safe viewer URL route', async () => {
  const wf = workflow(
    [node('mesh', 'meshNode', { source: 'file', filePath: '/external/model.glb' }), node('out', 'outputNode')],
    [edge('mesh', 'out')],
  )
  await useWorkflowRunStore.getState().run(wf, [])
  assert.deepEqual(imports, ['/external/model.glb'])
  assert.equal(useWorkflowRunStore.getState().nodeMeshOutputs.mesh, '/optimize/serve-file?path=%2Fexternal%2Fmodel.glb')
})

test('unconnected stale external mesh is not eagerly imported', async () => {
  await useWorkflowRunStore.getState().run(workflow([
    node('stale', 'meshNode', { source: 'file', filePath: '/missing/unconnected.glb' }),
  ], []), [])
  assert.deepEqual(imports, [])
  assert.equal(useWorkflowRunStore.getState().runState.status, 'done')
})

test('failed branch retry clears the stale viewer owned by that branch', async () => {
  const wf = workflow(
    [node('mesh', 'meshNode', { source: 'file', filePath: '/workspace/in.glb' }), node('wait', 'waitNode'), node('proc', 'extensionNode', {}, 'proc'), node('out', 'outputNode')],
    [edge('mesh', 'wait'), edge('wait', 'proc'), edge('proc', 'out')],
  )
  processImpl = async () => ({ success: true, result: { filePath: '/workspace/success.glb' } })
  await useWorkflowRunStore.getState().run(wf, [processExt()])
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(appState.currentJob.outputUrl, '/workspace/success.glb')
  processImpl = async () => ({ success: false, error: 'retry failed' })
  await useWorkflowRunStore.getState().continueRun('wait')
  assert.equal(appState.currentJob, null)
})

test('retrying an ancestor clears a stale viewer owned by an invalidated descendant', async () => {
  const wf = workflow(
    [
      node('mesh', 'meshNode', { source: 'file', filePath: '/workspace/in.glb' }), node('parent-wait', 'waitNode'),
      node('parent', 'extensionNode', {}, 'parent'), node('child-wait', 'waitNode'),
      node('child', 'extensionNode', {}, 'child'), node('out', 'outputNode'),
    ],
    [edge('mesh', 'parent-wait'), edge('parent-wait', 'parent'), edge('parent', 'child-wait'), edge('child-wait', 'child'), edge('child', 'out')],
  )
  processImpl = async (id) => ({ success: true, result: { filePath: `/workspace/${id}.glb` } })
  await useWorkflowRunStore.getState().run(wf, [processExt('parent'), processExt('child')])
  await useWorkflowRunStore.getState().continueRun('parent-wait')
  await useWorkflowRunStore.getState().continueRun('child-wait')
  assert.equal(appState.currentJob.outputUrl, '/workspace/child.glb')

  let release
  processImpl = () => new Promise((resolve) => { release = resolve })
  const retry = useWorkflowRunStore.getState().continueRun('parent-wait')
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(appState.currentJob, null)
  useWorkflowRunStore.getState().cancel()
  release({ success: true, result: { filePath: '/workspace/late.glb' } })
  await retry
})

test('retrying one branch preserves the unrelated last valid branch viewer', async () => {
  const wf = workflow(
    [
      node('a', 'meshNode', { source: 'file', filePath: '/workspace/a.glb' }), node('wa', 'waitNode'), node('pa', 'extensionNode', {}, 'pa'), node('oa', 'outputNode'),
      node('b', 'meshNode', { source: 'file', filePath: '/workspace/b.glb' }), node('wb', 'waitNode'), node('pb', 'extensionNode', {}, 'pb'), node('ob', 'outputNode'),
    ],
    [edge('a', 'wa'), edge('wa', 'pa'), edge('pa', 'oa'), edge('b', 'wb'), edge('wb', 'pb'), edge('pb', 'ob')],
  )
  processImpl = async (id) => ({ success: true, result: { filePath: `/workspace/${id}.glb` } })
  await useWorkflowRunStore.getState().run(wf, [processExt('pa'), processExt('pb')])
  await useWorkflowRunStore.getState().continueRun('wa')
  await useWorkflowRunStore.getState().continueRun('wb')
  assert.equal(appState.currentJob.outputUrl, '/workspace/pb.glb')

  let release
  processImpl = () => new Promise((resolve) => { release = resolve })
  const retry = useWorkflowRunStore.getState().continueRun('wa')
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(appState.currentJob.outputUrl, '/workspace/pb.glb')
  useWorkflowRunStore.getState().cancel()
  release({ success: true, result: { filePath: '/workspace/late.glb' } })
  await retry
})

test('new runs, cancel, and reset clear stale mesh outputs', async () => {
  const wf = workflow(
    [node('mesh', 'meshNode', { source: 'file', filePath: '/workspace/model.glb' }), node('out', 'outputNode')],
    [edge('mesh', 'out')],
  )
  await useWorkflowRunStore.getState().run(wf, [])
  assert.equal(useWorkflowRunStore.getState().nodeMeshOutputs.mesh, '/workspace/model.glb')

  let release
  processImpl = () => new Promise((resolve) => { release = resolve })
  const next = workflow(
    [node('fresh', 'meshNode', { source: 'file', filePath: '/workspace/fresh.glb' }), node('proc', 'extensionNode', {}, 'proc'), node('out2', 'outputNode')],
    [edge('fresh', 'proc'), edge('proc', 'out2')],
  )
  const pending = useWorkflowRunStore.getState().run(next, [processExt()])
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(useWorkflowRunStore.getState().nodeMeshOutputs.mesh, undefined)
  useWorkflowRunStore.getState().cancel()
  release({ success: true, result: { filePath: '/workspace/late-fresh.glb' } })
  await pending
  assert.deepEqual(useWorkflowRunStore.getState().nodeMeshOutputs, {})
  await useWorkflowRunStore.getState().run(wf, [])
  useWorkflowRunStore.getState().reset()
  assert.deepEqual(useWorkflowRunStore.getState().nodeMeshOutputs, {})
})
