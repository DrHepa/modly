import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
function load(file) {
  const directory = mkdtempSync(join(tmpdir(), 'modly-param-compat-'))
  const out = join(directory, 'module.cjs')
  try {
    writeFileSync(out, buildSync({ entryPoints: [resolve(file)], bundle: true, platform: 'node', format: 'cjs', write: false,
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve(file)).href) }, logOverride: { 'empty-import-meta': 'error' },
    }).outputFiles[0].text)
    return require(out)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
const schema = load('src/areas/workflows/workflowParamSchema.ts')
const state = load('src/areas/workflows/components/workflowParamControlState.ts')
const string = (extra = {}) => ({ id: 'path', label: 'Path', type: 'string', default: '', ...extra })
const fs = () => ({
  selectDirectory: async () => 'folder', selectImage: async () => 'image', selectMeshFile: async () => 'mesh',
  selectTextFile: async () => 'text', savePath: async () => 'save',
})

test('preserves show_if for all display types, including false and zero', () => {
  for (const raw of [string(), { id: 'n', label: 'N', type: 'int', default: 0 }, { id: 'f', label: 'F', type: 'float', default: 0 }, { id: 'b', label: 'B', type: 'boolean', default: false }, { id: 's', label: 'S', type: 'select', default: 0 }, { id: 'u', label: 'U', type: 'json', default: '{}' }]) {
    const show_if = { enabled: [true, false], mode: 0, folder: '' }
    assert.deepEqual(schema.normalizeWorkflowParam({ ...raw, show_if }).show_if, show_if)
  }
})

test('file-select retains dir_from, extensions and default filename', () => {
  const raw = { id: 'preset', label: 'Preset', type: 'file-select', default: 'a.json', dir_from: 'path', extensions: ['json'], show_if: { enabled: true } }
  assert.deepEqual(schema.normalizeWorkflowParam(raw), raw)
})

test('normalization retains both upstream picker spellings and their precedence', async () => {
  for (const intent of ['folder', 'text', 'image', 'mesh']) {
    for (const key of ['pickerIntent', 'picker_intent']) {
      const param = schema.normalizeWorkflowParam(string({ [key]: intent }))
      assert.equal(param[key], intent)
      assert.equal(await state.selectWorkflowParamPath(fs(), param, ''), intent)
    }
  }
  assert.equal(await state.selectWorkflowParamPath(fs(), schema.normalizeWorkflowParam(string({ pickerIntent: 'mesh', picker_intent: 'image' })), ''), 'mesh')
})

test('legacy plain strings remain editable with upstream folder browsing; no invented opt-out field', async () => {
  const param = schema.normalizeWorkflowParam(string())
  assert.equal(state.isPickerEnabled(param), true)
  assert.equal(await state.selectWorkflowParamPath(fs(), param, 'typed text'), 'folder')
  assert.equal(await state.selectWorkflowParamPath(fs(), schema.normalizeWorkflowParam(string({ pickerIntent: 'future-intent', picker_intent: 'image' })), ''), 'folder')
})

test('private directory and save-path intents never fall back to folder accidentally', async () => {
  assert.equal(await state.selectWorkflowParamPath(fs(), schema.normalizeWorkflowParam(string({ pickerIntent: 'directory' })), ''), 'folder')
  assert.equal(await state.selectWorkflowParamPath(fs(), schema.normalizeWorkflowParam(string({ pickerIntent: 'save-path' })), ''), 'save')
  assert.equal(await state.selectWorkflowParamPath(fs(), schema.normalizeWorkflowParam(string({ pickerIntent: 'generic-file' })), ''), null)
})

test('root schema/default inheritance and per-node overrides survive parser -> workflow normalization for models and processes', () => {
  const { parseExtensionManifest } = load('electron/main/automation-capabilities.ts')
  const { buildAllWorkflowExtensions } = load('src/areas/workflows/mockExtensions.ts')
  const schema = [string(), { id: 'enabled', label: 'Enabled', type: 'boolean', default: true }, { id: 'n', label: 'N', type: 'int', default: 8 }]
  for (const type of ['model', 'process']) {
    const raw = { id: 'pack', name: 'Pack', type, entry: 'index.js', params_schema: schema, param_defaults: { path: '/root', enabled: true, n: 2 }, nodes: [
      { id: 'root', name: 'Root' }, { id: 'overridden', name: 'Overridden', param_defaults: { path: '', enabled: false, n: 0 } },
      { id: 'own', name: 'Own', params_schema: [{ id: 'own', label: 'Own', type: 'float', default: 0.5, min: 0, max: 1, step: 0.1 }] },
    ] }
    const before = JSON.stringify(raw)
    const parsed = parseExtensionManifest(raw, 'pack', new Set())
    const result = buildAllWorkflowExtensions(type === 'model' ? [parsed] : [], type === 'process' ? [parsed] : [])
    assert.deepEqual(result[0].params.map((p) => p.default), ['/root', true, 2])
    assert.deepEqual(result[1].params.map((p) => p.default), ['', false, 0])
    assert.equal(result[2].params[0].id, 'own')
    assert.equal(result[2].params[0].step, 0.1)
    assert.equal(JSON.stringify(raw), before)
  }
})

test('display visibility uses defaults and supplied false/zero/empty values without deleting unknown runtime params', () => {
  const params = schema.normalizeWorkflowParams([
    { id: 'enabled', label: 'Enabled', type: 'boolean', default: true }, string({ default: '/default' }),
    { id: 'n', label: 'N', type: 'int', default: 10 }, { id: 'advanced', label: 'Advanced', type: 'json', default: '{}' },
  ])
  const supplied = { enabled: false, path: '', n: 0, advanced: { nested: true }, unknown: [1, 2] }
  const before = JSON.stringify(supplied)
  const resolved = state.resolveWorkflowParamValues(params, supplied)
  assert.deepEqual(resolved, supplied)
  assert.equal(state.isWorkflowParamVisible({ show_if: { enabled: [true, false], path: '', n: 0 } }, resolved), true)
  assert.equal(state.isWorkflowParamVisible({ show_if: { enabled: true } }, resolved), false)
  assert.equal(state.isWorkflowParamVisible({ show_if: { enabled: true, path: '/default' } }, state.resolveWorkflowParamValues(params, {})), true)
  assert.equal(state.resolveWorkflowParamValues(params, { enabled: null }).enabled, true)
  assert.equal(JSON.stringify(supplied), before)
})

test('malformed display descriptors do not crash extension discovery before normalization', () => {
  const { buildAllWorkflowExtensions } = load('src/areas/workflows/mockExtensions.ts')
  const make = (paramsSchema) => ({ type: 'process', id: 'bad-display', name: 'Bad display', nodes: [{ id: 'run', name: 'Run', input: 'image', output: 'mesh', paramsSchema }] })
  assert.deepEqual(buildAllWorkflowExtensions([], [make(null)])[0].params, [])
  const params = buildAllWorkflowExtensions([], [make([null, false, 3, []])])[0].params
  assert.equal(params.length, 4)
  assert.ok(params.every((p) => p.type === 'unsupported'))
})

test('select options without labels keep upstream value-label fallback, including zero', () => {
  const param = schema.normalizeWorkflowParam({ id: 'choice', label: 'Choice', type: 'select', default: 0, options: [{ value: 0 }, { value: 'auto' }, { value: 'named', label: 'Named' }] })
  assert.deepEqual(param.options, [{ value: 0, label: '0' }, { value: 'auto', label: 'auto' }, { value: 'named', label: 'Named' }])
})

test('unsupported display types retain raw runtime defaults and inherited overrides before actual MODEL submission', async () => {
  const { build } = await import('esbuild')
  const vm = await import('node:vm')
  const { parseExtensionManifest } = load('electron/main/automation-capabilities.ts')
  const { buildAllWorkflowExtensions } = load('src/areas/workflows/mockExtensions.ts')
  const bundle = (await build({
    entryPoints: ['src/areas/workflows/workflowRunStore.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'inert-model-adapters', setup(builder) {
      builder.onResolve({ filter: /^(axios|@shared\/stores\/appStore|@shared\/utils\/notification)$/ }, (args) => ({ path: args.path, namespace: 'inert' }))
      builder.onLoad({ filter: /.*/, namespace: 'inert' }, ({ path }) => ({ loader: 'ts', contents: path === 'axios'
        ? 'export default { create: () => globalThis.fixture.client }'
        : path.endsWith('appStore') ? 'export const useAppStore = { getState: () => globalThis.fixture.app }'
        : 'export const showCompletionNotification = () => {}; export const showErrorNotification = () => {}' }))
    } }],
  })).outputFiles[0].text
  const rawDefaults = { custom: '{"enabled":true}', bool: true, zero: 8, empty: 'base', object: { nested: [1, false] }, nullable: null }
  const rootDefaults = { custom: '{"root":true}', bool: false, zero: 0, empty: '' }
  const nodeDefaults = { custom: '{"node":true}', bool: true, zero: 9, empty: 'node' }
  for (const scenario of [
    { name: 'omitted raw', root: {}, node: {}, supplied: {}, expected: rawDefaults },
    { name: 'omitted root', root: rootDefaults, node: {}, supplied: {}, expected: { ...rawDefaults, ...rootDefaults } },
    { name: 'omitted node', root: rootDefaults, node: nodeDefaults, supplied: {}, expected: { ...rawDefaults, ...rootDefaults, ...nodeDefaults } },
    { name: 'explicit falsy and unknown', root: rootDefaults, node: nodeDefaults, supplied: { custom: '', bool: false, zero: 0, empty: '', object: { supplied: true }, unknown: ['keep'] }, expected: { ...rawDefaults, custom: '', bool: false, zero: 0, empty: '', object: { supplied: true }, unknown: ['keep'] } },
  ]) {
    const parsed = parseExtensionManifest({ type: 'model', id: 'pack', name: 'Pack',
      params_schema: Object.entries(rawDefaults).map(([id, value]) => ({ id, label: id, type: 'future-type', default: value })),
      param_defaults: scenario.root,
      nodes: [{ id: 'run', name: 'Run', input: 'scene', output: 'scene', param_defaults: scenario.node }],
    }, 'pack', new Set())
    const extensions = buildAllWorkflowExtensions([parsed], [])
    assert.ok(extensions[0].params.every((param) => param.type === 'unsupported'))
    const posts = []
    const fixture = {
      app: { apiUrl: 'http://inert.invalid', currentJob: null, setCurrentJob(job) { this.currentJob = job }, updateCurrentJob(job) { this.currentJob = { ...this.currentJob, ...job } } },
      client: {
        post: async (url, body) => { posts.push({ url, body }); return { data: { job_id: 'fixture' } } },
        get: async () => ({ data: { status: 'done', progress: 100, output_url: '/workspace/Workflows/result/scene-manifest.json' } }),
      },
    }
    const sceneReads = []
    const sceneJson = JSON.stringify({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [] })
    const window = { electron: { settings: { get: async () => ({ workspaceDir: '/workspace' }) }, fs: {
      deleteDirectory: async () => ({ success: true }), listFiles: async () => [],
      readFileBase64: async (filePath) => {
        sceneReads.push(filePath)
        assert.equal(filePath, '/workspace/Workflows/input/scene-manifest.json', 'only the live source manifest may be read')
        return Buffer.from(sceneJson, 'utf8').toString('base64')
      },
    } } }
    const module = { exports: {} }
    vm.runInNewContext(bundle, { module, exports: module.exports, require, fixture, window, process, console, crypto, Blob, FormData, atob, structuredClone, TextDecoder, setTimeout, clearTimeout })
    const store = module.exports.useWorkflowRunStore
    await store.getState().run({ id: 'wf', name: 'Scene', description: '', createdAt: '', updatedAt: '', nodes: [
      { id: 'source', type: 'sceneNode', position: { x: 0, y: 0 }, data: { enabled: true, params: { path: 'Workflows/input/scene-manifest.json' } } },
      { id: 'model', type: 'extensionNode', position: { x: 1, y: 0 }, data: { enabled: true, extensionId: 'pack/run', params: scenario.supplied } },
    ], edges: [{ id: 'e', source: 'source', target: 'model' }] }, extensions)
    assert.deepEqual(sceneReads, ['/workspace/Workflows/input/scene-manifest.json'])
    assert.equal(store.getState().runState.status, 'done', store.getState().runState.error)
    assert.equal(posts[0].url, '/generate/from-artifact')
    assert.deepEqual(JSON.parse(JSON.stringify(posts[0].body.params)), scenario.expected, scenario.name)
    assert.equal(store.getState().runState.outputPath, '/workspace/Workflows/result/scene-manifest.json')
  }
})
