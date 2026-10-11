import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync, transformSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, URL } from 'node:url'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
function moduleFromCode(code, dependencies = require) {
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: dependencies, process, console, Buffer, URL, setTimeout, clearTimeout })
  return module.exports
}
function loadModule(path) {
  return moduleFromCode(buildSync({
    entryPoints: [resolve(path)], bundle: true, platform: 'node', format: 'cjs', write: false,
    // Bundled main-process modules share this directory; keep createRequire's base URL.
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve(path)).href) },
  }).outputFiles[0].text)
}
const realSources = loadModule('electron/main/model-sources.ts')
const realPlan = loadModule('electron/main/model-download-plan.ts')
const realGuard = loadModule('electron/main/extension-path-guard.ts')
const realOperations = loadModule('electron/main/model-weight-operations.ts')
const realOwnership = loadModule('electron/main/model-ownership.ts')
const realCapabilities = loadModule('electron/main/automation-capabilities.ts')
const ipcText = readFileSync('electron/main/ipc-handlers.ts', 'utf8')
const downloaderCode = transformSync(readFileSync('electron/main/model-downloader.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code
const source = { id: 'weights', provider: 'huggingface', repo_id: 'org/base', destination: '.', checks: ['weights.bin'] }
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'modly-weight-ipc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const settings = { modelsDir: join(root, 'models'), extensionsDir: join(root, 'extensions') }
  const extension = join(settings.extensionsDir, 'demo')
  mkdirSync(extension, { recursive: true })
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({
    id: 'demo', type: 'model', weight_groups: [{ id: 'base', model_sources: [source] }],
    nodes: [{ id: 'a', weight_groups: ['base'] }, { id: 'b', weight_groups: ['base'], model_sources: [{ ...source, repo_id: 'org/adapter' }] }],
  }))
  const handlers = new Map(), events = [], removed = [], calls = []
  const hooks = {
    unload: async () => ({ data: { unloaded: true } }),
    listModels: async () => ({ data: [{ id: 'demo/a' }, { id: 'demo/b' }, { id: 'other/generate' }] }),
    resolvePlan: realPlan.resolveInstalledModelDownloadPlan,
    download: async (id) => {
      const dir = realSources.resolveWeightStorageRoot(settings.modelsDir, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'weights.bin'), 'complete')
    },
  }
  const deps = (name) => {
    if (name === './settings-store') return { getSettings: () => settings }
    if (name === './model-ownership') return realOwnership
    if (name === './model-sources.ts') return realSources
    if (name === './model-download-events.ts') return loadModule('electron/main/model-download-events.ts')
    if (name === './hf-token') return { getHfToken: () => '' }
    if (name === './logger') return { logger: { info() {}, warn() {}, error() {} } }
    if (name.startsWith('./')) return {}
    return require(name)
  }
  const downloader = moduleFromCode(downloaderCode, deps)
  function section(start, end) {
    const from = ipcText.indexOf(start), to = ipcText.indexOf(end, from + start.length)
    assert.ok(from >= 0 && to > from, `Missing actual model IPC closure: ${start}`)
    return ipcText.slice(from, to)
  }
  const bound = transformSync(`function bind(deps) {
    const { app, getSettings, setSettings, getBuiltinExtensionsDir, ipcMain,
      listVisibleExtensions, activeExtensionInstalls, resolveModelOwnership,
      resolveInstalledModelDownloadPlan, resolveInstalledExtensionSharedWeightGroups,
      privateModelStorageId, legacyDownloadSteps, ModelWeightOperations,
      isOwnedModelDownloaded, listDownloadedModelCapabilities, listDownloadedModels,
      isModelDownloaded, installedWeightVariants, areModelSourcesDownloaded,
      areWeightGroupSourcesDownloaded, areModelSourcesDownloadedAtRoot,
      resolveModelRoot, resolveWeightStorageRoot, resolveWeightGroupRoot,
      resolveExtensionModelRoot, assertSafeExtensionId, modelHasLocalData,
      weightStorageHasLocalData, getCanonicalModelPath, listWeightVariantFiles,
      existsSync, rmAsync, join, ModelAssetDownloadError, downloadModelSourcesFromHF,
      downloadModelFromHF, downloadModelAssetsFromHF, downloadModelAssetsFromHttps,
      parseLegacyModelDownloadPayloadContract, mapDownloadProgressToCapability,
      removePartialDownloadArtifacts, rmWithRetry, axios, API_BASE_URL,
      setHfToken, getHfToken, process } = deps
    const activeDownloads = new Map(), interruptedTargets = new Map()
    const weightOperations = new ModelWeightOperations()
    const notifyWeightChange = () => deps.notifyWeightChange()
    ${section('function modelAssetDownloadResult(', 'function createFallbackOwnership(')}
    ${section('function createFallbackOwnership(', 'const rmWithRetry =')}
    ${section('  const backendUnreachable =', '  const LOCKED_MODEL_FILES_ERROR =')}
    const LOCKED_MODEL_FILES_ERROR = 'locked'
    ${section('  const handleStructuredModelAssetDownload =', '  // Logging from renderer')}
    ${section("  ipcMain.handle('model:delete',", "  ipcMain.handle('model:showInFolder'")}
    ${section("  ipcMain.handle('model:listDownloaded'", "  ipcMain.handle('model:activeDownloads'")}
    ${section("  ipcMain.handle('model:activeDownloads'", '  // Export mesh to GLB')}
    ${section("  ipcMain.handle('settings:set'", '  // Directory picker')}
    ${section("  ipcMain.handle('api:updatePaths'", '  // ── Workflows ─')}
  }`, { loader: 'ts', format: 'cjs' }).code
  const { rm: rmAsync } = require('node:fs/promises')
  moduleFromCode(bound + '; module.exports = bind;')({
    ...realSources, ...realPlan, ...realOwnership, ...realGuard, ...realOperations, ...downloader,
    resolveInstalledModelDownloadPlan: (...args) => hooks.resolvePlan(...args),
    app: { getPath: () => root }, getSettings: () => settings,
    setSettings: (_, patch) => Object.assign(settings, patch),
    getBuiltinExtensionsDir: () => join(root, 'builtin'),
    listVisibleExtensions: realCapabilities.listVisibleExtensions, activeExtensionInstalls: new Set(),
    ipcMain: { handle: (id, fn) => handlers.set(id, fn) }, existsSync, join, rmAsync, process,
    axios: { post: (...args) => hooks.unload(...args), get: (...args) => hooks.listModels(...args), isAxiosError: (error) => Boolean(error?.isAxiosError) },
    API_BASE_URL: 'http://test',
    downloadModelSourcesFromHF: async (capabilityId, targetOwnerId, onProgress) => {
      calls.push(targetOwnerId); await hooks.download(targetOwnerId, onProgress)
    },
    rmWithRetry: async (dir) => { removed.push(dir); rmSync(dir, { recursive: true, force: true }); return { ok: true } },
    parseLegacyModelDownloadPayloadContract: loadModule('electron/main/model-download-ipc-contract.ts').parseLegacyModelDownloadPayload,
    notifyWeightChange: () => events.push(['model:weightsChanged']), setHfToken: () => {}, getHfToken: () => '',
  })
  for (const name of ['deleteSharedGroup', 'deleteExtensionWeights', 'download', 'pauseDownload', 'cancelDownload', 'isDownloaded', 'listDownloaded']) {
    assert.equal(typeof handlers.get(`model:${name}`), 'function', `Actual handler ${name} must be registered`)
  }
  const event = { sender: { send: (...args) => events.push(args) } }
  const invoke = (name, ...args) => handlers.get(`model:${name}`)(event, ...args)
  return { settings, hooks, invoke, removed, events, calls, handlers, root }
}

for (const action of ['deleteSharedGroup', 'deleteExtensionWeights']) {
  test(`${action} reserves its root before awaiting unload and releases it afterwards`, async (t) => {
    const f = fixture(t), entered = deferred(), finish = deferred()
    f.hooks.unload = async () => { entered.resolve(); await finish.promise; return { data: { unloaded: true } } }
    const deleting = f.invoke(action, 'demo', 'base')
    await Promise.race([entered.promise, deleting.then((result) => { throw new Error(`Removal finished before unload: ${JSON.stringify(result)}`) })])
    const blocked = await f.invoke('download', 'demo/a')
    assert.equal(blocked.success, false)
    assert.match(blocked.error, /busy/)
    assert.equal(f.calls.length, 0)
    finish.resolve()
    assert.equal((await deleting).success, true)
    assert.equal((await f.invoke('download', 'demo/a')).success, true)
  })
  test(`${action} preserves files when unload fails or is not confirmed`, async (t) => {
    const f = fixture(t)
    for (const unload of [async () => { throw new Error('timeout') }, async () => ({ data: {} })]) {
      f.hooks.unload = unload
      assert.equal((await f.invoke(action, 'demo', 'base')).success, false)
      assert.equal(f.removed.length, 0)
    }
    // Failure must release the lease as well.
    assert.equal((await f.invoke('download', 'demo/a')).success, true)
  })
}

function connectionRefused() {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8765'), { isAxiosError: true, code: 'ECONNREFUSED' })
}

for (const action of ['deleteSharedGroup', 'deleteExtensionWeights']) {
  test(`${action} still removes weights when the backend is not running`, async (t) => {
    // No backend means no Python process can hold the files open.
    const f = fixture(t)
    await f.invoke('download', 'demo/a')
    f.hooks.unload = async () => { throw connectionRefused() }
    f.hooks.listModels = async () => { throw connectionRefused() }
    assert.equal((await f.invoke(action, 'demo', 'base')).success, true)
    assert.equal(f.removed.length, 1)
  })
}

test('deleteExtensionWeights unloads only that extension models', async (t) => {
  const f = fixture(t), unloaded = []
  f.hooks.unload = async (url) => { unloaded.push(url); return { data: { unloaded: true } } }
  assert.equal((await f.invoke('deleteExtensionWeights', 'demo')).success, true)
  assert.deepEqual(unloaded, ['http://test/model/unload/demo%2Fa', 'http://test/model/unload/demo%2Fb'])
})

test('active download blocks deletion, including a complete base needed by a private adapter', async (t) => {
  const f = fixture(t)
  await f.invoke('download', 'demo/a')
  const entered = deferred(), finish = deferred()
  f.hooks.download = async () => { entered.resolve(); await finish.promise }
  const downloading = f.invoke('download', 'demo/b')
  await entered.promise
  assert.equal((await f.invoke('deleteSharedGroup', 'demo', 'base')).success, false)
  assert.equal(f.removed.length, 0)
  finish.resolve()
  await downloading
})

test('paused shared cancellation cleans the original target and preserves completed files', async (t) => {
  const f = fixture(t)
  const groupDir = join(f.settings.modelsDir, 'demo', '_shared', 'base')
  f.hooks.download = async () => {
    mkdirSync(groupDir, { recursive: true })
    writeFileSync(join(groupDir, 'weights.bin.part'), 'partial')
    writeFileSync(join(groupDir, 'finished.bin'), 'complete')
    throw new Error('Model download paused')
  }
  assert.equal((await f.invoke('download', 'demo/a')).paused, true)
  f.settings.modelsDir = join(f.root, 'new-models')
  assert.equal((await f.invoke('cancelDownload', 'demo/a')).success, true)
  assert.equal(existsSync(join(groupDir, 'weights.bin.part')), false)
  assert.equal(existsSync(join(groupDir, 'finished.bin')), true)
})

test('paused cleanup cannot delete a sibling download partials', async (t) => {
  const f = fixture(t)
  f.hooks.download = async () => { throw new Error('Model download paused') }
  await f.invoke('download', 'demo/a')
  const entered = deferred(), finish = deferred()
  f.hooks.download = async () => { entered.resolve(); await finish.promise }
  const sibling = f.invoke('download', 'demo/b')
  await entered.promise
  const result = await f.invoke('cancelDownload', 'demo/a')
  assert.equal(result.success, false)
  assert.match(result.error, /busy/)
  finish.resolve()
  await sibling
})

test('private failure notifies readiness changes and preserves the usable shared base', async (t) => {
  const f = fixture(t), normalDownload = f.hooks.download
  f.hooks.download = async (id) => {
    if (id === 'demo/b') throw new Error('adapter failed')
    await normalDownload(id)
  }
  const result = await f.invoke('download', 'demo/b')
  assert.equal(result.success, false)
  assert.equal(await f.invoke('isDownloaded', 'demo/a'), true)
  assert.equal(await f.invoke('isDownloaded', 'demo/b'), false)
  assert.ok(f.events.filter(([name]) => name === 'model:weightsChanged').length >= 2)
})

test('physical locks reject case aliases and parent roots without blocking unrelated roots', () => {
  const locks = new realOperations.ModelWeightOperations()
  const release = locks.acquire('node', [resolve('Models/Demo/Fast')])
  assert.throws(() => locks.acquire('alias', [resolve('models/demo/fast')]), /busy/)
  assert.throws(() => locks.acquire('extension', [resolve('models/demo')]), /busy/)
  locks.acquire('sibling', [resolve('models/demo/other')])()
  release()
  assert.equal(locks.busy, false)
})

for (const action of ['pauseDownload', 'cancelDownload']) {
  test(`${action} at a target boundary does not start the private source`, async (t) => {
    const f = fixture(t), entered = deferred(), finish = deferred()
    f.hooks.download = async () => { entered.resolve(); await finish.promise }
    const downloading = f.invoke('download', 'demo/b')
    await entered.promise
    const stopping = f.invoke(action, 'demo/b')
    finish.resolve()
    assert.equal((await stopping).success, true)
    const result = await downloading
    assert.equal(result[action === 'pauseDownload' ? 'paused' : 'cancelled'], true)
    assert.deepEqual(f.calls, ['demo/_shared/base'])
  })
}

test('model path changes are rejected while weights are reserved', async (t) => {
  const f = fixture(t), entered = deferred(), finish = deferred()
  f.hooks.download = async () => { entered.resolve(); await finish.promise }
  const downloading = f.invoke('download', 'demo/a')
  await entered.promise
  await assert.rejects(f.handlers.get('settings:set')(null, { modelsDir: join(f.root, 'new') }), /busy/)
  assert.equal((await f.handlers.get('api:updatePaths')(null, { modelsDir: join(f.root, 'new') })).success, false)
  finish.resolve()
  await downloading
})

test('pending installed-plan lookup pins model paths before the first target lease', async (t) => {
  const f = fixture(t), entered = deferred(), finish = deferred()
  const realResolve = f.hooks.resolvePlan
  f.hooks.resolvePlan = async (...args) => { entered.resolve(); await finish.promise; return realResolve(...args) }
  const downloading = f.invoke('download', 'demo/a')
  try {
    await entered.promise
    const modelsDir = f.settings.modelsDir
    await assert.rejects(f.handlers.get('settings:set')(null, { modelsDir: join(f.root, 'changed') }), /busy/)
    assert.equal((await f.handlers.get('api:updatePaths')(null, { modelsDir: join(f.root, 'changed') })).success, false)
    assert.equal(f.settings.modelsDir, modelsDir)
    assert.deepEqual(f.calls, [], 'No transfer may precede strict plan admission')
  } finally { finish.resolve() }
  assert.equal((await downloading).success, true)
})

test('later multi-source stage skips a private target completed by a sibling during its shared transfer', async (t) => {
  const f = ownerFixture(t), entered = deferred(), finish = deferred()
  const realDownload = f.hooks.download
  f.hooks.download = async (id, onProgress) => {
    if (id === 'demo/_shared/base') { entered.resolve(); await finish.promise }
    await realDownload(id, onProgress)
  }
  const first = f.invoke('download', 'demo/a')
  try {
    await Promise.race([entered.promise, first.then(result => { throw new Error(`Shared stage never entered: ${JSON.stringify(result)}`) })])
    assert.deepEqual(f.calls, ['demo/_shared/base'])
    assert.equal((await f.invoke('download', 'demo/b')).success, true, 'the sibling can complete its separately leased private target')
    assert.deepEqual(f.calls, ['demo/_shared/base', 'demo/private'])
    assert.equal(await f.invoke('isDownloaded', 'demo/b'), true)
    assert.equal(await f.invoke('isDownloaded', 'demo/a'), false, 'the still-pending shared source remains required')
  } finally { finish.resolve() }
  assert.equal((await first).success, true)
  assert.deepEqual(f.calls, ['demo/_shared/base', 'demo/private'], 'the first request must not transfer the now-complete private target again')
  assert.equal(f.calls.filter(id => id === 'demo/private').length, 1)
  assert.equal(await f.invoke('isDownloaded', 'demo/a'), true)
  assert.equal(await f.invoke('isDownloaded', 'demo/b'), true)
  assert.equal(readFileSync(join(f.settings.modelsDir, 'demo/private/weights.bin'), 'utf8'), 'complete')
  assert.ok(f.events.some(([name, progress]) => name === 'model:downloadProgress' && progress.capabilityId === 'demo/a' && progress.percent === 100))
  assert.equal((await f.invoke('deleteExtensionWeights', 'demo')).success, true, 'actual request and physical leases settle before owner-root removal')
  assert.equal((await f.invoke('download', 'demo/b')).success, true, 'the settled request slot permits a genuine new transfer')
  assert.deepEqual(f.calls, ['demo/_shared/base', 'demo/private', 'demo/private'])
})

function ownerFixture(t) {
  const f = fixture(t)
  writeFileSync(join(f.settings.extensionsDir, 'demo', 'manifest.json'), JSON.stringify({
    id: 'demo', type: 'model', weight_groups: [{ id: 'base', model_sources: [source] }],
    nodes: [
      { id: 'a', weight_owner_id: 'private', model_sources: [source], weight_groups: ['base'] },
      { id: 'b', weight_owner_id: 'private', model_sources: [source] },
    ],
  }))
  return f
}

test('private owner aliases preserve per-capability group readiness without moving legacy weights', async (t) => {
  const f = ownerFixture(t)
  const legacy = join(f.settings.modelsDir, 'demo/b')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'weights.bin'), 'legacy')
  assert.equal(await f.invoke('isDownloaded', 'demo/b'), true)
  assert.equal(await f.invoke('isDownloaded', 'demo/a'), false)
  assert.equal(await f.invoke('hasLocalData', 'demo/a'), true)
  const group = join(f.settings.modelsDir, 'demo/_shared/base')
  mkdirSync(group, { recursive: true })
  writeFileSync(join(group, 'weights.bin'), 'group')
  assert.equal(await f.invoke('isDownloaded', 'demo/a'), true)
  assert.equal(existsSync(join(f.settings.modelsDir, 'demo/private')), false)
  assert.equal(readFileSync(join(legacy, 'weights.bin'), 'utf8'), 'legacy')
})

test('alias download reserves canonical private root, leaves groups separate, and blocks sibling deletion/download', async (t) => {
  const f = ownerFixture(t), entered = deferred(), finish = deferred()
  f.hooks.download = async (id) => {
    if (id === 'demo/private') { entered.resolve(); await finish.promise }
  }
  const first = f.invoke('download', 'demo/b')
  // Avoid an unbounded wait when a regression targets the capability instead of the owner.
  await Promise.race([entered.promise, first])
  assert.deepEqual(f.calls, ['demo/private'])
  const sibling = await f.invoke('download', 'demo/a')
  assert.equal(sibling.success, false)
  assert.equal((await f.invoke('delete', 'demo/a')).success, false)
  finish.resolve()
  assert.equal((await first).success, true)
  const deleted = await f.invoke('delete', 'demo/a')
  assert.equal(deleted.success, false)
  assert.match(deleted.warning, /demo\/b/)
  assert.equal(f.removed.length, 0)
})

test('bundled private and shared roots download independently with capability progress identity', async (t) => {
  const f = ownerFixture(t)
  assert.equal((await f.invoke('download', 'demo/a')).success, true)
  assert.deepEqual(f.calls, ['demo/_shared/base', 'demo/private'])
  assert.equal(await f.invoke('isDownloaded', 'demo/a'), true)
  assert.equal(await f.invoke('isDownloaded', 'demo/b'), true)
  assert.ok(f.events.some(([name, event]) => name === 'model:downloadProgress' && event.modelId === 'demo/a' && event.capabilityId === 'demo/a'))
})

test('variant removal reserves canonical plus legacy aliases and keeps its selected path across unload', async (t) => {
  const f = fixture(t), entered = deferred(), finish = deferred()
  writeFileSync(join(f.settings.extensionsDir, 'demo', 'manifest.json'), JSON.stringify({
    id: 'demo', type: 'model', nodes: [{
      id: 'a', weight_owner_id: 'owner', hf_repo: 'org/base', download_check: 'pipeline.json',
      params_schema: [{ id: 'quant', type: 'select', default: 'Q4', options: ['Q4'] }],
      weight_variants: { param: 'quant', default: 'Q4', options: [{ id: 'Q4', include_prefixes: ['q4/'], checks: ['q4/weights.bin'] }] },
    }],
  }))
  const legacy = join(f.settings.modelsDir, 'demo/a'), canonical = join(f.settings.modelsDir, 'demo/owner')
  mkdirSync(join(legacy, 'q4'), { recursive: true })
  writeFileSync(join(legacy, 'pipeline.json'), '{}')
  writeFileSync(join(legacy, 'q4/weights.bin'), 'legacy')
  f.hooks.unload = async () => { entered.resolve(); await finish.promise; return { data: { unloaded: true } } }
  const removing = f.invoke('deleteWeightVariant', 'demo/a', 'Q4')
  await Promise.race([entered.promise, removing.then((result) => { throw new Error(`Removal finished before unload: ${JSON.stringify(result)}`) })])
  try {
    const blocked = await f.invoke('download', 'demo/a', 'Q4')
    assert.equal(blocked.success, false)
    assert.match(blocked.error, /busy/)
    // Simulate an external filesystem change, not another Modly operation.
    mkdirSync(join(canonical, 'q4'), { recursive: true })
    writeFileSync(join(canonical, 'q4/weights.bin'), 'canonical')
  } finally { finish.resolve() }
  assert.equal((await removing).success, true)
  assert.equal(existsSync(join(legacy, 'q4/weights.bin')), false)
  assert.equal(readFileSync(join(canonical, 'q4/weights.bin'), 'utf8'), 'canonical')
  assert.equal(readFileSync(join(legacy, 'pipeline.json'), 'utf8'), '{}')
})

for (const [label, owners] of [
  ['canonical case aliases', ['Shared', 'shared']],
  ['canonical versus legacy case alias', ['B', 'other']],
]) {
  test(`installed plan rejects ${label} before any unload or removal`, async (t) => {
    const f = fixture(t), unloaded = []
    writeFileSync(join(f.settings.extensionsDir, 'demo/manifest.json'), JSON.stringify({
      id: 'demo', type: 'model', nodes: owners.map((owner, index) => ({
        id: index ? 'b' : 'a', weight_owner_id: owner, model_sources: [source],
      })),
    }))
    f.hooks.unload = async (url) => { unloaded.push(url); return { data: { unloaded: true } } }
    for (const action of ['delete', 'download']) {
      const result = await f.invoke(action, 'demo/a')
      assert.equal(result.success, false)
      assert.match(result.error, /portable|overlap/i)
    }
    assert.deepEqual(unloaded, [])
    assert.deepEqual(f.removed, [])
    assert.deepEqual(f.calls, [])
  })
}


const structuredHfAssets = [{
  repo_id: 'org/assets', revision: 'a'.repeat(40), target_subdir: 'assets', files: [{ path: 'model.pt' }],
}]

async function assertDownloadedNode(f, expected) {
  assert.equal(await f.invoke('isDownloaded', 'demo/a'), expected)
  const downloaded = await f.invoke('listDownloaded')
  assert.equal(downloaded.some((model) => model.id === 'demo/a'), expected)
}

test('mixed structured assets require every declared private source and shared group before reporting downloaded', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.settings.extensionsDir, 'demo/manifest.json'), JSON.stringify({
    id: 'demo', type: 'model', weight_groups: [{ id: 'base', model_sources: [{ ...source, checks: ['base.bin'] }] }],
    nodes: [{
      id: 'a', weight_owner_id: 'owner', hf_downloads: structuredHfAssets,
      model_sources: [{ ...source, checks: ['private.bin'] }], weight_groups: ['base'],
    }],
  }))
  const owner = join(f.settings.modelsDir, 'demo/owner')
  mkdirSync(join(owner, 'assets'), { recursive: true })
  writeFileSync(join(owner, 'assets/model.pt'), 'structured-ready')
  await assertDownloadedNode(f, false)

  writeFileSync(join(owner, 'private.bin'), 'private-ready')
  await assertDownloadedNode(f, false)

  const shared = join(f.settings.modelsDir, 'demo/_shared/base')
  mkdirSync(shared, { recursive: true })
  writeFileSync(join(shared, 'base.bin'), 'shared-ready')
  await assertDownloadedNode(f, true)

  rmSync(join(owner, 'private.bin'))
  await assertDownloadedNode(f, false)
  writeFileSync(join(owner, 'private.bin'), 'private-ready')
  rmSync(join(owner, 'assets/model.pt'))
  await assertDownloadedNode(f, false)
})

test('mixed structured assets preserve the existing upstream weight-variant readiness requirement', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.settings.extensionsDir, 'demo/manifest.json'), JSON.stringify({
    id: 'demo', type: 'model', nodes: [{
      id: 'a', weight_owner_id: 'owner', hf_repo: 'org/base', hf_downloads: structuredHfAssets,
      params_schema: [{ id: 'quant', type: 'select', default: 'Q4', options: ['Q4'] }],
      weight_variants: { param: 'quant', default: 'Q4', options: [{ id: 'Q4', include_prefixes: ['q4/'], checks: ['q4/weights.bin'] }] },
    }],
  }))
  const owner = join(f.settings.modelsDir, 'demo/owner')
  mkdirSync(join(owner, 'assets'), { recursive: true })
  writeFileSync(join(owner, 'assets/model.pt'), 'structured-ready')
  await assertDownloadedNode(f, false)

  mkdirSync(join(owner, 'q4'), { recursive: true })
  writeFileSync(join(owner, 'q4/weights.bin'), 'variant-ready')
  await assertDownloadedNode(f, true)
  rmSync(join(owner, 'assets/model.pt'))
  await assertDownloadedNode(f, false)
})

for (const legacyMetadata of [{}, { hf_repo: 'org/fallback', download_check: 'legacy.bin' }]) {
  test(`structured-only readiness does not require legacy fallback files (hf_repo=${Boolean(legacyMetadata.hf_repo)})`, async (t) => {
    const f = fixture(t)
    writeFileSync(join(f.settings.extensionsDir, 'demo/manifest.json'), JSON.stringify({
      id: 'demo', type: 'model', nodes: [{ id: 'a', hf_downloads: structuredHfAssets, ...legacyMetadata }],
    }))
    const owner = join(f.settings.modelsDir, 'demo/a')
    mkdirSync(join(owner, 'assets'), { recursive: true })
    writeFileSync(join(owner, 'assets/model.pt'), 'structured-ready')
    await assertDownloadedNode(f, true)
    assert.equal(existsSync(join(owner, 'legacy.bin')), false)
    rmSync(join(owner, 'assets/model.pt'))
    await assertDownloadedNode(f, false)
  })
}


// Focused N1 coverage binds actual IPC closures, without the unrelated startup
// graph or its legacy fixture stubs. Manifest discovery/planning stay real.
function n1StorageFixture(t, nodes, afterPlanResolution) {
  const root = mkdtempSync(join(tmpdir(), 'modly-n1-storage-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const settings = { modelsDir: join(root, 'models'), extensionsDir: join(root, 'extensions') }
  mkdirSync(join(settings.extensionsDir, 'demo'), { recursive: true })
  writeFileSync(join(settings.extensionsDir, 'demo/manifest.json'), JSON.stringify({ id: 'demo', type: 'model', nodes }))
  const effects = { reserve: 0, unload: 0, download: 0, remove: 0, cleanup: 0 }
  const handlers = new Map()
  const text = readFileSync('electron/main/ipc-handlers.ts', 'utf8')
  function section(start, end) {
    const from = text.indexOf(start), to = text.indexOf(end, from + start.length)
    assert.ok(from >= 0 && to > from, `Missing actual N1 IPC closure: ${start}`)
    return text.slice(from, to)
  }
  const compiled = transformSync(`
function bind(deps) {
  const { app, getSettings, getBuiltinExtensionsDir, listVisibleExtensions,
    resolveModelOwnership, describeModelOwnership, resolveInstalledModelDownloadPlan,
    activeExtensionInstalls, ipcMain, ModelAssetDownloadError,
    legacyDownloadSteps, privateModelStorageId, resolveModelRoot, resolveWeightStorageRoot,
    areModelSourcesDownloadedAtRoot, downloadModelFromHF, downloadModelSourcesFromHF,
    downloadModelAssetsFromHF, downloadModelAssetsFromHttps, removePartialDownloadArtifacts,
    weightOperations, unloadForRemoval, rmWithRetry, notifyWeightChange,
    parseLegacyModelDownloadPayloadContract } = deps
  const activeDownloads = new Map(), interruptedTargets = new Map()
  const LOCKED_MODEL_FILES_ERROR = 'locked'
  ${section('function modelAssetDownloadResult(', 'function createFallbackOwnership(')}
  ${section('function createFallbackOwnership(', 'const rmWithRetry =')}
  ${section('  const resolveModelPlan =', '  const LOCKED_MODEL_FILES_ERROR =')}
  ${section('  const handleStructuredModelAssetDownload =', '  // Logging from renderer')}
  ${section("  ipcMain.handle('model:delete',", "  ipcMain.handle('model:showInFolder'")}
  ${section("  ipcMain.handle('model:downloadAssets'", "  ipcMain.handle('model:pauseDownload'")}
  ${section("  ipcMain.handle('model:cancelDownload'", '  // Export mesh to GLB')}
  return { activeDownloads, interruptedTargets }
}`, { loader: 'ts', format: 'cjs' }).code
  const operations = new realOperations.ModelWeightOperations()
  const download = async () => { effects.download += 1 }
  const state = moduleFromCode(compiled + '; module.exports = bind;')({
    ...realSources, ...realPlan, ...realOwnership,
    resolveInstalledModelDownloadPlan: async (args) => {
      const plan = await realPlan.resolveInstalledModelDownloadPlan(args)
      afterPlanResolution?.(args, plan)
      return plan
    },
    listVisibleExtensions: realCapabilities.listVisibleExtensions,
    app: { getPath: () => root }, getSettings: () => settings,
    getBuiltinExtensionsDir: () => join(root, 'builtin'), activeExtensionInstalls: new Set(),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    ModelAssetDownloadError: class extends Error { constructor(failure) { super(failure.message); this.failure = failure } },
    parseLegacyModelDownloadPayloadContract: loadModule('electron/main/model-download-ipc-contract.ts').parseLegacyModelDownloadPayload,
    downloadModelFromHF: download, downloadModelSourcesFromHF: download,
    downloadModelAssetsFromHF: download, downloadModelAssetsFromHttps: download,
    weightOperations: {
      acquire(...args) { effects.reserve += 1; return operations.acquire(...args) },
      remove(...args) { effects.reserve += 1; return operations.remove(...args) },
    },
    unloadForRemoval: async () => { effects.unload += 1 },
    rmWithRetry: async () => { effects.remove += 1; return { ok: true } },
    removePartialDownloadArtifacts: async () => { effects.cleanup += 1 },
    notifyWeightChange: () => {},
  })
  const event = { sender: { send: () => {} } }
  return { settings, state, effects,
    invoke: (name, ...args) => handlers.get(`model:${name}`)(event, ...args),
    visible: () => realCapabilities.listVisibleExtensions({ builtinDir: join(root, 'builtin'), userExtensionsDir: settings.extensionsDir, trustedRepos: new Set() }),
  }
}

const n1LegacyWriteMetadata = {
  hf_repo: 'org/model', download_check: 'base.bin',
  params_schema: [{ id: 'variant', type: 'select', options: ['small'] }],
  weight_variants: { param: 'variant', default: 'small', options: [{ id: 'small', include_prefixes: ['small/'], checks: ['small/weights.bin'] }] },
}
for (const order of [['Foo', 'foo'], ['foo', 'Foo']]) {
  for (const action of ['download', 'downloadAssets', 'downloadHttpsAssets', 'delete', 'deleteWeightVariant', 'cancelDownload']) {
    test(`N1 storage boundary rejects ${action} after visible case discovery: ${order.join(',')}`, async (t) => {
      const metadata = action === 'downloadAssets' ? { hf_downloads: structuredHfAssets }
        : action === 'downloadHttpsAssets' ? { https_downloads: [{ url: 'https://assets.example/weights.bin', filename: 'weights.bin', size_bytes: 1, sha256: 'a'.repeat(64) }] }
          : n1LegacyWriteMetadata
      const f = n1StorageFixture(t, order.map((id) => ({ id, ...metadata })))
      assert.deepEqual(Array.from((await f.visible())[0].nodes, (node) => node.id), order)
      const modelId = 'demo/Foo'
      const payload = action === 'downloadAssets' || action === 'downloadHttpsAssets' ? { modelId } : modelId
      const result = await f.invoke(action, payload, ...(action === 'deleteWeightVariant' ? ['small'] : []))
      assert.equal(result.success, false)
      assert.match(result.error, /portable-unique|overlaps/)
      assert.deepEqual(f.effects, { reserve: 0, unload: 0, download: 0, remove: 0, cleanup: 0 })
      assert.equal(f.state.activeDownloads.size, 0)
      assert.equal(f.state.interruptedTargets.size, 0)
      assert.equal(existsSync(f.settings.modelsDir), false)
    })
  }
}

test('N1 storage boundary preserves safe exact-case ordinary downloads', async (t) => {
  const f = n1StorageFixture(t, [{ id: 'Foo', ...n1LegacyWriteMetadata }])
  assert.deepEqual(Array.from((await f.visible())[0].nodes, (node) => node.id), ['Foo'])
  assert.equal((await f.invoke('download', 'demo/Foo', 'small')).success, true)
  assert.equal(f.effects.reserve, 1)
  assert.equal(f.effects.download, 2)
  assert.equal(f.state.activeDownloads.size, 0)
})

for (const action of ['download', 'downloadAssets', 'downloadHttpsAssets', 'delete', 'deleteWeightVariant', 'cancelDownload']) {
  test(`N1 storage boundary rejects ${action} from user collision despite safe builtin duplicate`, async (t) => {
    const metadata = action === 'downloadAssets' ? { hf_downloads: structuredHfAssets }
      : action === 'downloadHttpsAssets' ? { https_downloads: [{ url: 'https://assets.example/weights.bin', filename: 'weights.bin', size_bytes: 1, sha256: 'a'.repeat(64) }] }
        : n1LegacyWriteMetadata
    const f = n1StorageFixture(t, ['Foo', 'foo'].map((id) => ({ id, ...metadata })))
    const builtin = join(f.settings.extensionsDir, '..', 'builtin', 'demo')
    mkdirSync(builtin, { recursive: true })
    writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({ id: 'demo', type: 'model', nodes: [{ id: 'Foo', ...metadata }] }))
    assert.deepEqual(Array.from(await f.visible(), (extension) => Array.from(extension.nodes, (node) => node.id)), [['Foo'], ['Foo', 'foo']])
    const payload = action === 'downloadAssets' || action === 'downloadHttpsAssets' ? { modelId: 'demo/Foo' } : 'demo/Foo'
    const result = await f.invoke(action, payload, ...(action === 'deleteWeightVariant' ? ['small'] : []))
    assert.equal(result.success, false)
    assert.match(result.error, /portable-unique|overlaps/)
    assert.deepEqual(f.effects, { reserve: 0, unload: 0, download: 0, remove: 0, cleanup: 0 })
    assert.equal(f.state.activeDownloads.size, 0)
    assert.equal(f.state.interruptedTargets.size, 0)
    assert.equal(existsSync(f.settings.modelsDir), false)
  })
}

for (const action of ['download', 'delete', 'deleteWeightVariant', 'cancelDownload']) {
  test(`N1 storage boundary revalidates ${action} when manifest changes after strict read`, async (t) => {
    let reads = 0
    const f = n1StorageFixture(t, [{ id: 'Foo', ...n1LegacyWriteMetadata }], (args) => {
      reads += 1
      assert.equal(args.validateStorageOwnership, true)
      if (reads === 1) {
        writeFileSync(join(f.settings.extensionsDir, 'demo/manifest.json'), JSON.stringify({
          id: 'demo', type: 'model', nodes: ['Foo', 'foo'].map((id) => ({ id, ...n1LegacyWriteMetadata })),
        }))
      }
    })
    const result = await f.invoke(action, 'demo/Foo', ...(action === 'deleteWeightVariant' ? ['small'] : []))
    assert.equal(result.success, false)
    assert.match(result.error, /portable-unique|overlaps/)
    assert.equal(reads, 1) // The subsequent real resolver rejects before returning a plan.
    assert.deepEqual(f.effects, { reserve: 0, unload: 0, download: 0, remove: 0, cleanup: 0 })
    assert.equal(f.state.activeDownloads.size, 0)
    assert.equal(f.state.interruptedTargets.size, 0)
    assert.equal(existsSync(f.settings.modelsDir), false)
  })
}
