import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('./ipc-handlers.ts', import.meta.url), 'utf8')
const nodeId = 'fixture/generate'

function section(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `Missing IPC source boundaries: ${start}`)
  return source.slice(from, to)
}

// Execute the real handler and reservation/control closures without importing
// Electron's unrelated startup graph. Only external I/O dependencies are mocked.
const compiled = ts.transpileModule(`
function create(deps) {
  const { ipcMain, app, getSettings, getBuiltinExtensionsDir,
    parseLegacyModelDownloadPayloadContract, resolveOwnershipContext,
    resolveInstalledModelDownloadPlan, areWeightGroupSourcesDownloaded,
    areModelSourcesDownloaded, downloadModelSourcesFromHF,
    mapDownloadProgressToCapability, ModelAssetDownloadError, axios,
    API_BASE_URL, resolveModelRoot, resolveWeightGroupRoot,
    removePartialDownloadArtifacts } = deps;
  ${section('function modelAssetDownloadResult(', 'function createFallbackOwnership(')}
  ${section('  type TrackedDownloadProgress =', '  const getWorldsWorkspaceRoot =')}
  ${section("  ipcMain.handle('model:downloadSources'", "  ipcMain.handle('model:download',")}
  ${section("  ipcMain.handle('model:pauseDownload'", '  // Export mesh to GLB')}
  return {activeDownloads, activeDownloadSettlements, localDownloadControls, activeWeightTargets};
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const create = new Function(`${compiled}; return create;`)()

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function ownership(modelId, ownerId = modelId) {
  return { ownership: { capabilityId: modelId, weightOwnerId: ownerId, legacyPaths: [] }, siblingCapabilityIds: [] }
}

function plan({ groups = [], sources = [{ repoId: 'fixture/weights' }] } = {}) {
  return { kind: 'multi-source', extensionId: 'fixture', sources, sharedGroups: groups }
}

async function until(predicate) {
  for (let turn = 0; turn < 50 && !predicate(); turn += 1) await Promise.resolve()
  assert.ok(predicate(), 'Expected asynchronous handler stage was not reached')
}

function harness({ resolveOwner = async (_, modelId) => ownership(modelId),
  resolvePlan = async () => plan(), download = async () => {}, post = async () => {} } = {}) {
  const handlers = new Map()
  const calls = []
  const posts = []
  const removed = []
  const events = []
  const state = create({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { getPath: () => '/mock/user-data' },
    getSettings: () => ({ modelsDir: '/mock/models', extensionsDir: '/mock/extensions' }),
    getBuiltinExtensionsDir: () => '/mock/builtins',
    parseLegacyModelDownloadPayloadContract: (payload) => ({ modelId: payload.modelId }),
    resolveOwnershipContext: resolveOwner,
    resolveInstalledModelDownloadPlan: resolvePlan,
    areWeightGroupSourcesDownloaded: () => false,
    areModelSourcesDownloaded: () => false,
    downloadModelSourcesFromHF: async (...args) => { calls.push(args); await download(...args) },
    mapDownloadProgressToCapability: (modelId, progress) => ({ modelId, ...progress }),
    ModelAssetDownloadError: class extends Error {
      constructor(failure) { super(failure.message); this.failure = failure }
    },
    axios: { post: async (...args) => { posts.push(args); await post(...args) } },
    API_BASE_URL: 'http://mock.invalid',
    resolveModelRoot: (_, modelId) => modelId,
    resolveWeightGroupRoot: (_, extensionId, groupId) => `${extensionId}/_shared/${groupId}`,
    removePartialDownloadArtifacts: async (path) => { removed.push(path) },
  })
  const event = { sender: { send: (...args) => events.push(args) } }
  return { ...state, calls, posts, removed, events,
    start: (modelId = nodeId) => handlers.get('model:downloadSources')(event, { modelId }),
    control: (action, modelId = nodeId) => handlers.get(`model:${action}Download`)(event, modelId),
    assertReleased() {
      for (const map of Object.values(state)) assert.equal(map.size, 0, 'Reservation/control state leaked')
    },
  }
}

test('first ordinary source request reaches downloader when requested ID equals owner', async () => {
  const h = harness()
  assert.deepEqual(await h.start(), { success: true })
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0].slice(0, 2), [nodeId, nodeId])
  h.assertReleased()
  assert.deepEqual(await h.start(), { success: true })
  assert.equal(h.calls.length, 2)
  h.assertReleased()
})

test('same-node pending request rejects duplicate without overwriting its reservation', async () => {
  const gate = deferred()
  let ownerCalls = 0
  const h = harness({ resolveOwner: async (_, id) => { ownerCalls += 1; await gate.promise; return ownership(id) } })
  const first = h.start()
  const reserved = h.activeDownloadSettlements.get(nodeId)
  try {
    const duplicate = h.start()
    await until(() => ownerCalls > 1 || h.activeDownloadSettlements.get(nodeId) === reserved)
    assert.equal(ownerCalls, 1)
    assert.equal((await duplicate).failure.code, 'download_in_progress')
    assert.equal(h.activeDownloadSettlements.get(nodeId), reserved)
  } finally { gate.resolve(); await first }
  assert.equal(h.calls.length, 1)
  h.assertReleased()
})

test('same-node in-flight request rejects duplicate and preserves active progress/control', async () => {
  const gate = deferred()
  const h = harness({ download: () => gate.promise })
  const first = h.start()
  try {
    await until(() => h.calls.length === 1)
    const control = h.localDownloadControls.get(nodeId)
    const reservation = h.activeDownloadSettlements.get(nodeId)
    assert.equal((await h.start()).failure.code, 'download_in_progress')
    assert.equal(h.calls.length, 1)
    assert.equal(h.localDownloadControls.get(nodeId), control)
    assert.equal(h.activeDownloadSettlements.get(nodeId), reservation)
    assert.equal(h.activeDownloads.has(nodeId), true)
  } finally { gate.resolve(); await first }
  h.assertReleased()
})

test('competing shared-owner request rejects without clearing the active owner state', async () => {
  const gate = deferred()
  const owner = 'fixture/owner'
  const h = harness({ resolveOwner: async (_, id) => ownership(id, owner), download: () => gate.promise })
  const first = h.start('fixture/first')
  try {
    await until(() => h.calls.length === 1)
    const control = h.localDownloadControls.get(owner)
    assert.equal((await h.start('fixture/second')).failure.code, 'download_in_progress')
    assert.equal(h.calls.length, 1)
    assert.equal(h.activeDownloads.has(owner), true)
    assert.equal(h.localDownloadControls.get(owner), control)
  } finally { gate.resolve(); await first }
  h.assertReleased()
  assert.deepEqual(await h.start('fixture/second'), { success: true })
  h.assertReleased()
})

test('competing shared-group request still rejects while its target is reserved', async () => {
  const gate = deferred()
  const targetId = 'fixture/_shared/base'
  const h = harness({ resolvePlan: async () => plan({ sources: [], groups: [{ targetId, sources: [{}] }] }), download: () => gate.promise })
  const first = h.start('fixture/first')
  try {
    await until(() => h.calls.length === 1)
    const control = h.localDownloadControls.get(targetId)
    assert.equal((await h.start('fixture/second')).failure.code, 'download_in_progress')
    assert.equal(h.activeDownloads.has(targetId), true)
    assert.equal(h.localDownloadControls.get(targetId), control)
    assert.equal(h.calls.length, 1)
  } finally { gate.resolve(); await first }
  h.assertReleased()
})

for (const stage of ['ownership', 'plan', 'download']) {
  test(`source request releases its reservation after ${stage} failure`, async () => {
    let fail = true
    const h = harness({
      resolveOwner: async (_, id) => { if (fail && stage === 'ownership') throw new Error('owner failure'); return ownership(id) },
      resolvePlan: async () => fail && stage === 'plan' ? { kind: 'legacy' } : plan(),
      download: async () => { if (fail && stage === 'download') throw new Error('download failure') },
    })
    assert.equal((await h.start()).success, false)
    h.assertReleased()
    fail = false
    assert.deepEqual(await h.start(), { success: true })
    h.assertReleased()
  })
}

for (const action of ['cancel', 'pause']) {
  test(`early ${action} waits for pending resolution and releases the request without downloading`, async () => {
    const gate = deferred()
    let ownerCalls = 0
    const h = harness({ resolveOwner: async (_, id) => { if (++ownerCalls === 1) await gate.promise; return ownership(id) } })
    const first = h.start()
    let settled = false
    const controlled = h.control(action).then((result) => { settled = true; return result })
    await until(() => h.posts.length === 1)
    assert.equal(settled, false)
    assert.equal(h.localDownloadControls.get(nodeId)[action], true)
    gate.resolve()
    assert.deepEqual(await first, { success: true })
    assert.deepEqual(await controlled, { success: true })
    assert.equal(h.calls.length, 0)
    h.assertReleased()
    assert.deepEqual(await h.start(), { success: true })
    h.assertReleased()
  })
}

test('cancel during a shared group releases both reservations without starting the later private target', async () => {
  const gate = deferred()
  const targetId = 'fixture/_shared/base'
  const h = harness({ resolvePlan: async () => plan({ groups: [{ targetId, sources: [{}] }] }),
    download: () => gate.promise, post: async () => { gate.resolve() } })
  const first = h.start()
  await until(() => h.calls.length === 1)
  assert.deepEqual(await h.control('cancel'), { success: true })
  assert.deepEqual(await first, { success: true })
  assert.equal(h.calls.length, 1)
  assert.equal(h.posts[0][2].params.model_id, targetId)
  h.assertReleased()
})

// A later target is not reserved while an earlier transfer is awaiting I/O.
// Another valid request may acquire it before this request advances.
test('staggered shared plans reject a later occupied target without stealing its state', async () => {
  const first = deferred()
  const shared = deferred()
  const firstId = 'fixture/_shared/first'
  const sharedId = 'fixture/_shared/shared'
  const h = harness({
    resolvePlan: async ({ modelId }) => plan({ sources: [], groups: [
      ...(modelId === 'fixture/left' ? [{ targetId: firstId, sources: [{}] }] : []),
      { targetId: sharedId, sources: [{}] },
    ] }),
    download: (_, targetId) => targetId === firstId ? first.promise : shared.promise,
  })
  const left = h.start('fixture/left')
  let right
  try {
    await until(() => h.calls.length === 1)
    right = h.start('fixture/right')
    await until(() => h.calls.length === 2)
    const progress = h.activeDownloads.get(sharedId)
    const control = h.localDownloadControls.get(sharedId)
    const settlement = h.activeDownloadSettlements.get(sharedId)
    first.resolve()
    await until(() => h.calls.length === 3 || !h.activeDownloadSettlements.has('fixture/left'))
    assert.equal(h.calls.length, 2, 'The occupied later target must not start twice')
    assert.equal((await left).failure.code, 'download_in_progress')
    assert.equal(h.activeDownloads.get(sharedId), progress)
    assert.equal(h.localDownloadControls.get(sharedId), control)
    assert.equal(h.activeDownloadSettlements.get(sharedId), settlement)
    assert.equal(h.activeDownloadSettlements.has('fixture/right'), true)
  } finally { first.resolve(); shared.resolve(); await left; if (right) await right }
  h.assertReleased()
})

for (const failFirst of [true, false]) {
  test(`${failFirst ? 'mid-plan failure' : 'later private-owner conflict'} leaves the foreign owner's state intact`, async () => {
    const first = deferred()
    const foreign = deferred()
    const firstId = 'fixture/_shared/first'
    const ownerId = 'fixture/owner'
    const h = harness({
      resolveOwner: async (_, id) => ownership(id, ownerId),
      resolvePlan: async ({ modelId }) => plan({
        groups: modelId === 'fixture/left' ? [{ targetId: firstId, sources: [{}] }] : [],
      }),
      download: async (_, targetId) => {
        if (targetId === firstId) {
          await first.promise
          if (failFirst) throw new Error('first transfer failed')
        } else { await foreign.promise }
      },
    })
    const left = h.start('fixture/left')
    let right
    try {
      await until(() => h.calls.length === 1)
      right = h.start('fixture/right')
      await until(() => h.calls.length === 2)
      const progress = h.activeDownloads.get(ownerId)
      const control = h.localDownloadControls.get(ownerId)
      const settlement = h.activeDownloadSettlements.get(ownerId)
      first.resolve()
      await until(() => h.calls.length === 3 || !h.activeDownloadSettlements.has('fixture/left'))
      assert.equal(h.calls.length, 2, 'A later private target must not replace the foreign owner')
      const result = await left
      assert.equal(result.success, false)
      if (!failFirst) assert.equal(result.failure.code, 'download_in_progress')
      assert.equal(h.activeDownloads.get(ownerId), progress, 'Failure must not clear foreign progress')
      assert.equal(h.localDownloadControls.get(ownerId), control)
      assert.equal(h.activeDownloadSettlements.get(ownerId), settlement)
      assert.equal(h.activeDownloadSettlements.has('fixture/right'), true)
    } finally { first.resolve(); foreign.resolve(); await left; if (right) await right }
    h.assertReleased()
  })
}
