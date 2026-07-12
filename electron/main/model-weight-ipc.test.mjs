import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync, transformSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
function moduleFromCode(code, dependencies = require) {
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: dependencies, process, console, Buffer, setTimeout, clearTimeout })
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
const ipcCode = transformSync(readFileSync('electron/main/ipc-handlers.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code
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
    download: async (id) => {
      const dir = realSources.resolveWeightStorageRoot(settings.modelsDir, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'weights.bin'), 'complete')
    },
  }
  const stub = new Proxy({}, { get: () => () => {} })
  const deps = (name) => {
    if (name === 'electron') return { ipcMain: { handle: (id, fn) => handlers.set(id, fn), on: () => {} }, app: { getPath: () => root, on: () => {} } }
    if (name === 'axios') return {
      post: (...args) => hooks.unload(...args),
      get: (...args) => hooks.listModels(...args),
      isAxiosError: (err) => Boolean(err?.isAxiosError),
    }
    if (name === './automation-capabilities') return { ...realCapabilities, activeExtensionInstalls: new Set() }
    if (name === './model-ownership') return realOwnership
    if (name === './model-sources') return realSources
    if (name === './model-download-plan') return realPlan
    if (name === './extension-path-guard') return realGuard
    if (name === './model-weight-operations') return realOperations
    if (name === './settings-store') return { getSettings: () => settings, setSettings: (_, patch) => Object.assign(settings, patch) }
    if (name === './builtin-sync') return { getBuiltinExtensionsDir: () => join(root, 'builtin') }
    if (name === './python-bridge') return { API_BASE_URL: 'http://test' }
    if (name === './model-downloader') return {
      ...downloader,
      downloadModelSourcesFromHF: async (...args) => { calls.push(args[0]); await hooks.download(...args) },
    }
    if (name === './extension-install-recovery') return { rmWithRetry: async (dir) => { removed.push(dir); rmSync(dir, { recursive: true, force: true }); return { ok: true } } }
    if (name.startsWith('./') || name === 'electron-updater') return stub
    return require(name)
  }
  const downloader = moduleFromCode(downloaderCode, deps)
  moduleFromCode(ipcCode, deps).setupIpcHandlers({}, () => ({ webContents: { send: (...event) => events.push(event) } }))
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
