import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

function section(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `Missing source boundaries: ${start}`)
  return source.slice(from, to)
}

function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
}

// Run the real registered handlers, not a duplicate readiness implementation.
// Only their filesystem, manifest, settings and ownership boundaries are mocked.
const source = readFileSync(new URL('./ipc-handlers.ts', import.meta.url), 'utf8')
const create = new Function(`${compile(`function create(deps) {
  const { ipcMain, app, getSettings, getBuiltinExtensionsDir, listModelExtensions,
    listDownloadedModelCapabilities, listDownloadedModels,
    resolveInstalledModelDownloadPlan, resolveOwnershipContext,
    areModelSourcesDownloaded, areWeightGroupSourcesDownloaded, isOwnedModelDownloaded } = deps;
  ${section(source, "  ipcMain.handle('model:listDownloaded'", "  ipcMain.handle('model:hasLocalData'")}
}`)}; return create;`)()

// Preserve the real legacy fallback's top-level ID shape, without touching disk.
const downloader = readFileSync(new URL('./model-downloader.ts', import.meta.url), 'utf8')
const rawSource = section(downloader, 'export function listDownloadedModels(', 'type StructuredAssetDownloadRequest')
const createRaw = new Function(`${compile(`function createRaw(deps) {
  const { existsSync, readdirSync, statSync, join, dirSizeBytes, getModelSizeFromHFMetadata } = deps;
  ${rawSource.replace('export function', 'function')}
  return listDownloadedModels;
}`)}; return createRaw;`)()
const rawFallback = createRaw({
  existsSync: () => true,
  readdirSync: (path) => path === '/mock/models' ? ['fixture'] : ['enhanced', '_shared'],
  statSync: () => ({ isDirectory: () => true }),
  join,
  dirSizeBytes: () => 1e9,
  getModelSizeFromHFMetadata: () => 0,
})

const id = 'fixture/enhanced'
const group = { id: 'main', targetId: 'fixture/_shared/main', sources: [{ id: 'image' }] }
const privateSource = { id: 'pe', destination: 'prompt_enhancer' }
const plan = (sources = [privateSource], groups = [group]) => ({
  kind: 'multi-source', extensionId: 'fixture', sources, sharedGroups: groups,
})
const node = (nodeId = 'enhanced', fields = {}) => ({ id: nodeId, name: nodeId, hasModelSources: true, ...fields })
const row = (nodeId = id, fields = {}) => ({ id: nodeId, name: 'Preserved display name', size_gb: 18.8, ...fields })

function harness({
  extensions = [{ id: 'fixture', type: 'model', nodes: [node()] }],
  collected = [row()],
  plans = new Map([[id, plan()]]),
  owners = new Map(),
  privateReady = new Map([[id, true]]),
  sharedReady = new Map([['main', true]]),
  ownerErrors = new Set(),
  legacyReady = true,
} = {}) {
  const handlers = new Map()
  const calls = { plans: [], private: [], shared: [], legacy: [] }
  create({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { getPath: () => '/mock/user-data' },
    getSettings: () => ({ modelsDir: '/mock/models', extensionsDir: '/mock/extensions' }),
    getBuiltinExtensionsDir: () => '/mock/builtins',
    listModelExtensions: async () => structuredClone(extensions),
    listDownloadedModelCapabilities: () => structuredClone(collected),
    listDownloadedModels: rawFallback,
    resolveInstalledModelDownloadPlan: async (request) => {
      calls.plans.push(request)
      const found = plans.get(request.modelId)
      if (!found || found instanceof Error) throw found ?? new Error('No installed plan')
      return found
    },
    resolveOwnershipContext: async (_, modelId) => {
      if (ownerErrors.has(modelId)) throw new Error('Invalid ownership')
      return { ownership: { capabilityId: modelId, weightOwnerId: owners.get(modelId) ?? modelId, legacyPaths: [modelId] } }
    },
    areModelSourcesDownloaded: (modelsDir, ownerId, sources) => {
      calls.private.push({ modelsDir, ownerId, sources })
      return privateReady.get(ownerId) === true
    },
    areWeightGroupSourcesDownloaded: (modelsDir, extensionId, requiredGroup) => {
      calls.shared.push({ modelsDir, extensionId, group: requiredGroup })
      return sharedReady.get(requiredGroup.id) === true
    },
    isOwnedModelDownloaded: (modelsDir, ownership) => {
      calls.legacy.push({ modelsDir, ownership })
      return legacyReady
    },
  })
  return { calls, sharedReady, privateReady,
    list: () => handlers.get('model:listDownloaded')(),
    isDownloaded: (modelId = id) => handlers.get('model:isDownloaded')(null, modelId),
  }
}

test('private-complete collector entry is rejected when its shared main is missing (primary regression)', async () => {
  const h = harness({ sharedReady: new Map([['main', false]]) })
  const result = await h.list()
  assert.equal(result.some((entry) => entry.id === id), false)
  assert.deepEqual(result, [{ id: 'fixture', name: 'fixture', size_gb: 1 }])
  assert.equal(await h.isDownloaded(), false)
})

for (const scenario of [
  { name: 'enhanced all complete', private: true, groups: [true], expected: true },
  { name: 'enhanced private missing', private: false, groups: [true], expected: false },
  { name: 'enhanced both missing', private: false, groups: [false], expected: false },
  { name: 'second required group missing', private: true, groups: [true, false], expected: false },
  { name: 'two required groups complete', private: true, groups: [true, true], expected: true },
  { name: 'group-only complete', private: null, groups: [true], expected: true },
  { name: 'group-only missing', private: null, groups: [false], expected: false },
  { name: 'private-only complete', private: true, groups: [], expected: true },
  { name: 'private-only missing', private: false, groups: [], expected: false },
]) {
  test(`list and isDownloaded agree: ${scenario.name}`, async () => {
    const groups = scenario.groups.map((_, index) => ({ ...group, id: `group-${index}` }))
    const sources = scenario.private === null ? [] : [privateSource]
    const h = harness({
      collected: scenario.private === true ? [row()] : [],
      plans: new Map([[id, plan(sources, groups)]]),
      privateReady: new Map([[id, scenario.private]]),
      sharedReady: new Map(groups.map((g, index) => [g.id, scenario.groups[index]])),
    })
    const result = await h.list()
    assert.equal(result.some((entry) => entry.id === id), scenario.expected)
    assert.equal(await h.isDownloaded(), scenario.expected)
    if (scenario.private === null) assert.equal(h.calls.private.length, 0)
    if (groups.length === 0) assert.equal(h.calls.shared.length, 0)
    if (scenario.expected) assert.equal(result.filter((entry) => entry.id === id).length, 1)
  })
}

test('complete source capability retains original metadata and exact private owner/shared arguments', async () => {
  const original = row(id, { customMetadata: 'untouched' })
  const h = harness({ collected: [original], owners: new Map([[id, 'fixture/private-owner']]),
    privateReady: new Map([['fixture/private-owner', true]]) })
  assert.deepEqual(await h.list(), [original])
  assert.deepEqual(h.calls.private, [{ modelsDir: '/mock/models', ownerId: 'fixture/private-owner', sources: [privateSource] }])
  assert.deepEqual(h.calls.shared, [{ modelsDir: '/mock/models', extensionId: 'fixture', group }])
})

test('four nodes require the same shared main and only their respective private PE', async () => {
  const names = ['generate', 'edit', 'generate-enhanced', 'edit-enhanced']
  const plans = new Map(names.map((name) => [`fixture/${name}`, plan(name.endsWith('-enhanced') ? [privateSource] : [])]))
  const h = harness({ extensions: [{ id: 'fixture', type: 'model', nodes: names.map((name) => node(name)) }],
    plans, collected: [row('fixture/generate-enhanced'), row('fixture/edit-enhanced')],
    privateReady: new Map([['fixture/generate-enhanced', true], ['fixture/edit-enhanced', false]]) })
  const ids = async () => (await h.list()).map((entry) => entry.id).sort()
  assert.deepEqual(await ids(), ['fixture/edit', 'fixture/generate', 'fixture/generate-enhanced'])
  h.privateReady.set('fixture/generate-enhanced', false); h.privateReady.set('fixture/edit-enhanced', true)
  assert.deepEqual(await ids(), ['fixture/edit', 'fixture/edit-enhanced', 'fixture/generate'])
  h.sharedReady.set('main', false)
  assert.deepEqual(await ids(), ['fixture'])
})

for (const failure of ['resolve', 'ownership', 'inconsistent-kind']) {
  test(`source-managed ${failure} failure discards provisional entry without hiding valid legacy node`, async () => {
    const legacy = row('fixture/legacy', { name: 'Legacy' })
    const h = harness({ extensions: [{ id: 'fixture', type: 'model', nodes: [node(), node('legacy', { hasModelSources: false })] }],
      collected: [row(), legacy], ownerErrors: new Set(failure === 'ownership' ? [id] : []),
      plans: new Map([[id, failure === 'resolve' ? new Error('Bad plan') : failure === 'inconsistent-kind' ? { kind: 'legacy-hf' } : plan()],
        ['fixture/legacy', { kind: 'legacy-hf' }]]) })
    assert.deepEqual(await h.list(), [legacy])
  })
}

test('successful source-plan resolution is authoritative even without advertised source metadata', async () => {
  const h = harness({ extensions: [{ id: 'fixture', type: 'model', nodes: [node('enhanced', { hasModelSources: undefined })] }],
    sharedReady: new Map([['main', false]]) })
  assert.deepEqual((await h.list()).map((entry) => entry.id), ['fixture'])
})

test('legacy owner aliases and read-through preserve two rows despite missing installed plans', async () => {
  const originals = [row('fixture/alias-one', { name: 'One', size_gb: 4 }), row('fixture/alias-two', { name: 'Two', size_gb: 5 })]
  const h = harness({ extensions: [{ id: 'fixture', type: 'model', nodes: originals.map((r) => node(r.id.split('/')[1], { hasModelSources: false })) }],
    collected: originals, plans: new Map(), owners: new Map(originals.map((r) => [r.id, 'fixture/owner'])) })
  assert.deepEqual(await h.list(), originals)
  for (const original of originals) assert.equal(await h.isDownloaded(original.id), true)
  assert.deepEqual(h.calls.legacy.map((call) => call.ownership.weightOwnerId), ['fixture/owner', 'fixture/owner'])
  assert.equal(h.calls.private.length, 0); assert.equal(h.calls.shared.length, 0)
})

test('readiness is freshly recomputed after main disappears and is restored', async () => {
  const h = harness()
  assert.deepEqual(await h.list(), [row()])
  h.sharedReady.set('main', false)
  assert.deepEqual((await h.list()).map((entry) => entry.id), ['fixture'])
  h.sharedReady.set('main', true)
  assert.deepEqual(await h.list(), [row()])
  assert.equal(h.calls.plans.length, 3)
})

test('raw legacy fallback retains top-level IDs and process extensions are not resolved as models', async () => {
  for (const extensions of [[], [{ id: 'process', type: 'process', nodes: [node()] }]]) {
    const h = harness({ extensions, collected: [], plans: new Map() })
    assert.deepEqual(await h.list(), [{ id: 'fixture', name: 'fixture', size_gb: 1 }])
    assert.equal(h.calls.plans.length, 0)
  }
})
