import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeTestPlan } from './run-node-tests.mjs'
import * as diagnostic from './worlds-command-profile.mjs'
import { createStorageAbReportOnly, validateStorageAbRunAdmission } from './worlds-command-storage-ab.mjs'
import { applyWorldCommandBatch, canonicalWorldCommandBatchPayload, fingerprintWorldCommandBatch } from '../src/areas/worlds/core/worldCommands.ts'
import { validateWorldProjectSnapshot } from '../src/areas/worlds/core/worldDocuments.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = `${root}/scripts/worlds-command-profile.mjs`
const node = '/opt/modly-node-v24.14.1/bin/node'
const frame = (functionName, url = '', lineNumber = 0, columnNumber = 0) => ({ functionName, url, lineNumber, columnNumber, scriptId: '1' })
const profile = () => ({ startTime: 100, endTime: 210, nodes: [
  { id: 1, callFrame: frame('(root)'), children: [2, 5, 6, 7] },
  { id: 2, callFrame: frame('work', `file://${root}/electron/main/world-project-repository.ts`), children: [3] },
  { id: 3, callFrame: frame('work', `file://${root}/electron/main/world-project-repository.ts`), children: [4] },
  { id: 4, callFrame: frame('helper', `file://${root}/src/areas/worlds/core/worldDocuments.ts`) },
  { id: 5, callFrame: frame('(idle)') },
  { id: 6, callFrame: frame('(garbage collector)') },
  { id: 7, callFrame: frame('(program)') },
], samples: [3, 4, 5, 6, 7], timeDeltas: [10, 20, 30, 15, 25] })
const group = (summary, name) => summary.groups.find((item) => item.functionName === name)
const canonicalBytes = (value) => Buffer.from(`${canonicalWorldCommandBatchPayload(value)}\n`)
const emptySnapshot = (projectKey, sceneId, sceneFile = `scene-${'b'.repeat(32)}.world-scene.json`) => ({
  project: { schema: 'modly.world-project.v1', projectId: 'project:test', name: 'Contract fixture', revision: 0, resources: [],
    scenes: [{ id: sceneId, name: 'Scene', documentPath: `Worlds/${projectKey}/scenes/${sceneFile}` }], startSceneId: sceneId,
    inputActions: [], graphicsProfiles: [{ id: 'graphics:balanced', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'fxaa' }], activeGraphicsProfileId: 'graphics:balanced' },
  scenes: [{ schema: 'modly.world-scene.v1', projectId: 'project:test', sceneId, name: 'Scene',
    environment: { backgroundColor: '#17191d', ambientIntensity: 0.3 }, editor: { initialView: { position: [8, 5, 12], target: [0, 1, 0], up: [0, 1, 0] } }, entities: [], sequences: [] }],
})
const emptyEntity = (id, name) => ({ id, name, parentId: null, enabled: true, locked: false, tags: [],
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] })

test('profile reducer weights leaves and recursive inclusive groups without double counting', () => {
  const raw = profile(), before = structuredClone(raw)
  const reduced = diagnostic.reduceCpuProfile(raw)
  assert.equal(reduced.totalSampleWeightUs, 100)
  assert.equal(reduced.unassignedTailUs, 10)
  assert.equal(reduced.sampleCount, 5)
  assert.equal(group(reduced, 'work').exclusiveWeightUs, 10)
  assert.equal(group(reduced, 'work').inclusiveWeightUs, 30)
  assert.equal(group(reduced, 'work').inclusiveSamples, 2)
  assert.equal(group(reduced, 'work').nodeCount, 2)
  assert.equal(group(reduced, 'helper').exclusiveWeightUs, 20)
  assert.equal(group(reduced, '(root)').inclusiveWeightUs, 100)
  assert.deepEqual(raw, before)
})

test('profile reducer separates idle garbage collector program harness inspector and application', () => {
  const raw = profile()
  raw.nodes.push({ id: 8, callFrame: frame('capture', `file://${script}`) }, { id: 9, callFrame: frame('post', 'node:inspector') })
  raw.nodes[0].children.push(8, 9)
  raw.samples.push(8, 9); raw.timeDeltas.push(3, 7)
  const reduced = diagnostic.reduceCpuProfile(raw)
  for (const [name, category] of [['(idle)', 'idle'], ['(garbage collector)', 'gc'], ['(program)', 'unattributed'],
    ['capture', 'harness'], ['post', 'inspector'], ['work', 'application']]) assert.equal(group(reduced, name).category, category)
  assert.equal(reduced.categories.reduce((sum, item) => sum + item.exclusiveWeightUs, 0), 110)
  assert.equal(reduced.performanceAcceptance, 'NOT_ASSESSED')
  assert.equal(Object.hasOwn(reduced, 'p95Ms'), false)
})

test('profile reducer rejects duplicate cyclic disconnected multiparent and dangling graphs', () => {
  const mutate = [
    (p) => p.nodes.push(structuredClone(p.nodes[1])),
    (p) => { p.nodes[3].children = [1] },
    (p) => { p.nodes[0].children = [5, 6, 7] },
    (p) => p.nodes[0].children.push(4),
    (p) => p.nodes[0].children.push(99),
    (p) => p.nodes[0].children.push(2),
    (p) => { p.nodes[1].children = 'bad' },
    (p) => { p.nodes[0].id = 0 },
  ]
  for (const change of mutate) { const raw = profile(); change(raw); assert.throws(() => diagnostic.reduceCpuProfile(raw)) }
})

test('profile reducer rejects missing empty invalid or mismatched samples and time domains', () => {
  const mutate = [
    (p) => { delete p.samples }, (p) => { p.samples = [] }, (p) => p.samples.push(3),
    (p) => { p.samples[0] = 99 }, (p) => { p.timeDeltas[0] = -1 }, (p) => { p.timeDeltas[0] = NaN },
    (p) => { p.timeDeltas[0] = Infinity }, (p) => { p.timeDeltas = p.timeDeltas.map(() => 0) },
    (p) => { p.endTime = 99 }, (p) => { p.startTime = NaN }, (p) => { p.endTime = 150 },
    (p) => { p.nodes[1].callFrame.lineNumber = -2 }, (p) => { p.nodes[1].callFrame.url = null },
  ]
  for (const change of mutate) { const raw = profile(); change(raw); assert.throws(() => diagnostic.reduceCpuProfile(raw)) }
})

test('profile aggregation preserves additive exclusive weights but not additive inclusive totals', () => {
  const one = diagnostic.reduceCpuProfile(profile())
  const result = diagnostic.aggregateCpuSummaries([one, one])
  assert.equal(result.profileCount, 2)
  assert.equal(result.totalSampleWeightUs, 200)
  assert.equal(result.sampleCount, 10)
  assert.equal(group(result, 'work').exclusiveWeightUs, 20)
  assert.equal(group(result, 'work').inclusiveWeightUs, 60)
  assert.equal(result.groups.reduce((sum, item) => sum + item.exclusiveWeightUs, 0), 200)
  assert.ok(result.groups.reduce((sum, item) => sum + item.inclusiveWeightUs, 0) > 200)
  assert.throws(() => diagnostic.aggregateCpuSummaries([]))
})

test('profile scenario reuses exact32setup20transforms without inheriting benchmark labels', () => {
  const entities = Array.from({ length: 100 }, (_, i) => ({ id: `entity:${i}` }))
  const result = diagnostic.buildProfileScenario({ projectKey: 'test-only' }, entities)
  assert.equal(result.schema, 'worlds-command-profile-v1')
  assert.equal(result.instrumentation, 'inspector-cpu+controller-lifecycle')
  assert.equal(result.performanceAcceptance, 'NOT_ASSESSED')
  assert.equal(result.batches.filter((item) => item.phase === 'setup').length, 32)
  assert.equal(result.batches.filter((item) => item.phase === 'profile').length, 20)
  assert.equal(result.batches[32].baseRevision, 32)
  assert.deepEqual(result.batches[51].position, [51, 0, 0])
  assert.equal(new Set(result.batches.map((item) => item.transactionId)).size, 52)
  assert.equal(Object.hasOwn(result, 'thresholdNs'), false)
  assert.equal(Object.hasOwn(result, 'measuredBatches'), false)
  assert.throws(() => diagnostic.buildProfileScenario({}, entities.slice(1)))
  assert.ok(Object.isFrozen(diagnostic.PROFILE_CONTRACT))
})

test('profile artifact budget rejects a21st profile and bytes above64MiB without mutation', () => {
  const budget = { count: 19, bytes: 64 * 1024 * 1024 - 1 }
  assert.deepEqual(diagnostic.reserveProfileArtifact(budget, 1), { count: 20, bytes: 64 * 1024 * 1024 })
  assert.deepEqual(budget, { count: 19, bytes: 64 * 1024 * 1024 - 1 })
  for (const [state, bytes] of [[budget, 2], [{ count: 20, bytes: 0 }, 1], [budget, 0], [budget, NaN], [budget, -1]]) {
    assert.throws(() => diagnostic.reserveProfileArtifact(state, bytes))
  }
})

const clock = () => { let now = 0n; return () => ++now }
const fakeCapture = async ({ dispatchError, stopError, startError, afterStartError } = {}) => {
  const calls = [], tick = clock(), recorder = diagnostic.createLifecycleRecorder(tick)
  let checks = 0
  const profiler = { async post(method) {
    calls.push(method)
    if (method === 'Profiler.start' && startError) throw startError
    if (method === 'Profiler.stop' && stopError) throw stopError
    return method === 'Profiler.stop' ? { profile: profile() } : undefined
  } }
  const result = await diagnostic.captureProfiledDispatch({ profiler, recorder, clock: tick,
    checkAdmission() { checks++; if (checks === 2 && afterStartError) throw afterStartError },
    async operation() {
      calls.push('dispatch')
      recorder.listener({ lifecycle: 'loading', session: { snapshot: { project: { revision: 32 } } } })
      await Promise.resolve()
      if (dispatchError) throw dispatchError
      recorder.listener({ lifecycle: 'ready', session: { snapshot: { project: { revision: 33 } } } })
      return { ok: true, value: { revision: 33 } }
    },
  })
  return { calls, result }
}

test('profile capture encloses dispatch settlement and collects coarse lifecycle clocks', async () => {
  const { calls, result } = await fakeCapture()
  assert.deepEqual(calls, ['Profiler.start', 'dispatch', 'Profiler.stop'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.operationStarted, true)
  assert.equal(result.operationSettled, true)
  assert.equal(result.result.value.revision, 33)
  assert.deepEqual(diagnostic.lifecycleBrackets(result, 32), { beforeLoadingNs: '1', loadingToReadyNs: '1', readyToSettlementNs: '1', dispatchWallNs: '3' })
  assert.deepEqual(result.profile, profile())
})

test('profile capture preserves dispatch and stop errors together without masking either', async () => {
  const { result, calls } = await fakeCapture({ dispatchError: new Error('dispatch broke'), stopError: new Error('stop broke') })
  assert.deepEqual(calls, ['Profiler.start', 'dispatch', 'Profiler.stop'])
  assert.deepEqual(result.errors.map((error) => [error.stage, error.message]), [['dispatch', 'dispatch broke'], ['profiler-stop', 'stop broke']])
  assert.equal(result.operationSettled, true)
  assert.equal(result.profile, null)
  assert.ok(BigInt(result.endedNs) >= BigInt(result.startedNs))
})

test('profile failed start or expired admission never dispatches and attempts profiler settlement', async () => {
  for (const options of [{ startError: new Error('start broke') }, { afterStartError: new Error('deadline') }]) {
    const { calls, result } = await fakeCapture(options)
    assert.deepEqual(calls, ['Profiler.start', 'Profiler.stop'])
    assert.equal(result.operationStarted, false)
    assert.equal(result.operationSettled, true)
    assert.equal(result.errors.length, 1)
    assert.equal(result.startedNs, null)
  }
})

test('profile rejected admission retains its error without starting a profiler or dispatch', async () => {
  const calls = []
  const capture = await diagnostic.captureProfiledDispatch({ profiler: { post: async () => { calls.push('profile') } },
    recorder: diagnostic.createLifecycleRecorder(clock()), operation: async () => { calls.push('dispatch') },
    checkAdmission: () => { throw new Error('admission expired') } })
  assert.deepEqual(calls, [])
  assert.equal(capture.operationStarted, false); assert.equal(capture.operationSettled, true)
  assert.equal(capture.profile, null)
  assert.equal(capture.errors[0].stage, 'admission'); assert.match(capture.errors[0].message, /admission expired/)
})

test('profile recorder bounds events and exposes listener failure despite controller isolation', () => {
  const recorder = diagnostic.createLifecycleRecorder(clock())
  recorder.listener({})
  recorder.begin()
  for (let i = 0; i < 6; i++) recorder.listener({ lifecycle: 'loading', session: { snapshot: { project: { revision: 32 } } } })
  const result = recorder.finish()
  assert.equal(result.events.length, 4)
  assert.equal(result.errors.length, 1)
  const throwing = diagnostic.createLifecycleRecorder(() => { throw new Error('clock failure') })
  throwing.begin(); assert.doesNotThrow(() => throwing.listener({ lifecycle: 'ready' }))
  assert.equal(throwing.finish().errors.length, 1)
})

test('profile lifecycle brackets reject wrong revisions missing markers and foreign clocks', async () => {
  const { result } = await fakeCapture()
  const wrongRevision = structuredClone(result); wrongRevision.lifecycle.events[1].revision = 40
  const wrongClock = structuredClone(result); wrongClock.lifecycle.events[0].hrtimeNs = '999'
  const missing = structuredClone(result); missing.lifecycle.events.pop()
  for (const bad of [wrongRevision, wrongClock, missing]) assert.throws(() => diagnostic.lifecycleBrackets(bad, 32))
})

test('profile resource release unsubscribes and disconnects once while retaining both failures', () => {
  const calls = []
  const resources = { unsubscribe() { calls.push('unsubscribe'); throw new Error('unsubscribe failed') },
    session: { disconnect() { calls.push('disconnect'); throw new Error('disconnect failed') } } }
  const result = diagnostic.releaseProfileResources(resources)
  assert.equal(result.settled, false)
  assert.deepEqual(result.errors.map((error) => error.message), ['unsubscribe failed', 'disconnect failed'])
  assert.deepEqual(diagnostic.releaseProfileResources(resources), { settled: true, errors: [] })
  assert.deepEqual(calls, ['unsubscribe', 'disconnect'])
})

const owned = () => ({ token: 'b'.repeat(32), path: '/tmp/modly-worlds-command-profile-new-Ab12cd', dev: '23', ino: '456', uid: 1000 })
const observed = () => ({ path: owned().path, realPath: owned().path, dev: '23', ino: '456', uid: 1000, isDirectory: true, isSymbolicLink: false })
test('profile ownership identity rejects aliases replacements and foreign roots without authorizing deletion', () => {
  assert.equal(diagnostic.matchesWorkspaceIdentity(owned(), observed(), owned()), true)
  for (const update of [{ path: '/tmp' }, { realPath: '/tmp/other' }, { dev: '9' }, { ino: '9' }, { uid: 0 }, { isDirectory: false }, { isSymbolicLink: true }]) {
    assert.equal(diagnostic.matchesWorkspaceIdentity(owned(), { ...observed(), ...update }, owned()), false)
  }
  assert.equal(diagnostic.matchesWorkspaceIdentity(owned(), observed(), { ...owned(), token: 'c'.repeat(32) }), false)
  for (const path of ['/tmp', '/home/user/app', '/tmp/modly-worlds-command-latency-new-Ab12cd', `${owned().path}/child`]) {
    assert.equal(diagnostic.matchesWorkspaceIdentity({ ...owned(), path }, { ...observed(), path, realPath: path }, owned()), false)
  }
})

const fakeRetention = async (options = {}) => {
  const writes = [], calls = []
  const result = await diagnostic.finalizeOwnedWorkspace(owned(), { settled: true, interrupted: false, ...options }, {
    readOwnership: async () => options.wrongToken ? { ...owned(), token: 'c'.repeat(32) } : owned(),
    observe: async () => observed(),
    save: async (name, data) => { writes.push({ name, data }); calls.push(name) },
    remove: async () => { calls.push('FORBIDDEN_DESTRUCTION') },
  })
  return { writes, calls, result }
}

test('profile retention preserves initial admission and final identities with no deletion on success', async () => {
  const { calls, writes, result } = await fakeRetention()
  assert.deepEqual(calls, ['workspace-admission.json', 'workspace-final.json'])
  assert.deepEqual(writes[0].data.observed, observed())
  assert.equal(writes[0].data.status, 'WORKSPACE_RETAINED_BY_DESIGN')
  assert.equal(writes[1].data.status, 'WORKSPACE_RETAINED_BY_DESIGN')
  assert.equal(result.destructionAttempted, false)
})

test('profile retention records interrupted unsettled or unverified roots without destructive calls', async () => {
  for (const options of [{ interrupted: true }, { settled: false }, { wrongToken: true }]) {
    const { calls, result } = await fakeRetention(options)
    assert.equal(calls.includes('FORBIDDEN_DESTRUCTION'), false)
    assert.equal(result.status, options.wrongToken ? 'OWNERSHIP_UNVERIFIED' : 'WORKSPACE_RETAINED_BY_DESIGN')
    assert.equal(result.settled, options.settled ?? true)
    assert.equal(result.interrupted, options.interrupted ?? false)
  }
})

test('profile retention records interruption during admission persistence in separate final evidence', async () => {
  let interrupted = false, removed = false
  const result = await diagnostic.finalizeOwnedWorkspace(owned(), { settled: true, interrupted: false, isInterrupted: () => interrupted }, {
    readOwnership: async () => owned(), observe: async () => observed(),
    save: async (name) => { if (name === 'workspace-admission.json') interrupted = true },
    remove: async () => { removed = true }, absent: async () => true,
  })
  assert.equal(result.status, 'WORKSPACE_RETAINED_BY_DESIGN'); assert.equal(result.interrupted, true); assert.equal(removed, false)
})

const base = () => ({ sourceSealSha256: 'a'.repeat(64), sources: [{ path: 'scripts/worlds-command-latency.mjs', sha256: 'b'.repeat(64), size: 3 }],
  runtime: { executable: node, version: 'v24.14.1', sha256: 'c'.repeat(64), execArgv: ['--experimental-strip-types'] }, edges: [], loader: null })
const extras = () => [{ path: 'scripts/worlds-command-profile.mjs', size: 7, sha256: 'd'.repeat(64) }]

test('profile seal binds inherited closure diagnostic inputs import edges and fixed contract', () => {
  const original = diagnostic.sealProfileManifest(base(), extras(), [])
  assert.match(original.sourceSealSha256, /^[a-f0-9]{64}$/)
  assert.notEqual(original.sourceSealSha256, base().sourceSealSha256)
  for (const changed of [
    diagnostic.sealProfileManifest({ ...base(), sourceSealSha256: 'f'.repeat(64) }, extras(), []),
    diagnostic.sealProfileManifest(base(), [{ ...extras()[0], sha256: 'e'.repeat(64) }], []),
    diagnostic.sealProfileManifest(base(), extras(), [{ specifier: 'node:inspector' }]),
    diagnostic.sealProfileManifest(base(), extras(), [], { ...diagnostic.PROFILE_CONTRACT, samplingIntervalUs: 2000 }),
    diagnostic.sealProfileManifest(base(), extras(), [], { ...diagnostic.PROFILE_CONTRACT, workspacePolicy: 'DELETE' }),
    diagnostic.sealProfileManifest(base(), extras(), [], { ...diagnostic.PROFILE_CONTRACT, maxEvidenceBodyBytes: 1 }),
  ]) assert.notEqual(changed.sourceSealSha256, original.sourceSealSha256)
})

test('profile import edge admission rejects new application dependencies instead of extending authority', () => {
  assert.deepEqual(diagnostic.checkDiagnosticImports("import { buildScenario } from './worlds-command-latency.mjs'\nconst i = await import('node:inspector')", base().sources).map((edge) => edge.specifier), ['./worlds-command-latency.mjs', 'node:inspector'])
  for (const source of ["import './unexpected.mjs'", "import '../electron/main/other.ts'", "import 'three'", "import 'node:not-a-real-builtin'", 'const x = import(variable)', "const x = require('fs')"]) {
    assert.throws(() => diagnostic.checkDiagnosticImports(source, base().sources))
  }
  const importer = `${root}/scripts/worlds-command-profile.contract.test.mjs`
  const edges = diagnostic.checkDiagnosticImports("import * as diagnostic from './worlds-command-profile.mjs'", extras(), importer)
  assert.deepEqual(edges, [{ importer: 'scripts/worlds-command-profile.contract.test.mjs', specifier: './worlds-command-profile.mjs', target: 'scripts/worlds-command-profile.mjs' }])
  assert.throws(() => diagnostic.checkDiagnosticImports("import './unsealed-contract-helper.mjs'", extras(), importer))
})

test('profile modes and runtime admission reject mismatched seals flags environment and roots', () => {
  const readiness = diagnostic.sealProfileManifest(base(), extras(), [])
  const options = { mode: 'run', sealSha256: readiness.sourceSealSha256 }
  const env = { cwd: root, executable: node, version: 'v24.14.1', execArgv: ['--experimental-strip-types'], nodeOptions: '', nodePath: '' }
  assert.doesNotThrow(() => diagnostic.validateProfileAdmission(options, readiness, env))
  assert.equal(diagnostic.createProfileReportOnly(readiness).proposedArgv[0], node)
  assert.throws(() => diagnostic.validateProfileAdmission({ ...options, sealSha256: 'f'.repeat(64) }, readiness, env))
  for (const update of [{ cwd: '/tmp' }, { executable: '/usr/bin/node' }, { version: 'v22.0.0' }, { nodeOptions: '--inspect' }, { nodePath: '/tmp' }, { execArgv: ['--cpu-prof'] }]) {
    assert.throws(() => diagnostic.validateProfileAdmission(options, readiness, { ...env, ...update }))
  }
  const wrongRuntime = diagnostic.sealProfileManifest({ ...base(), runtime: { ...base().runtime, version: 'v22.0.0' } }, extras(), [])
  assert.throws(() => diagnostic.createProfileReportOnly(wrongRuntime), /version/i)
  for (const args of [[], ['--run'], ['--run', '--workspace', '/tmp'], ['--run', '--cleanup'], ['--run', '--seal-sha256', options.sealSha256, '--samples', '1']]) assert.throws(() => diagnostic.parseArguments(args))
  assert.equal(diagnostic.parseArguments(['--report-only']).mode, 'report-only')
})

test('storage ab report and admission bind the sealed runtime path and version', () => {
  const readiness = { sourceSealSha256: 'a'.repeat(64), runtime: { executable: node, version: 'v24.14.1',
    sha256: 'b'.repeat(64), execArgv: ['--experimental-strip-types', '--loader', `${root}/scripts/node-ts-extensionless-loader.mjs`] },
  diagnostic: { schema: 'modly.worlds-command-storage-ab.v1', diagnosticFlag: '--diagnostic-storage-ab', entities: 100,
    setupBatchesPerLane: 32, measuredBatchesPerLane: 20, lanes: ['v1', 'v2'], order: 'odd-v1-v2-even-v2-v1',
    fileSync: 'default', directorySync: 'default', maxRecordsPerDispatch: 8192, historicalComparison: false,
    performanceAcceptance: 'NOT_ASSESSED', thresholdGainUnder50Ms: null, gainAcceptance: null } }
  const environment = { cwd: root, executable: node, version: 'v24.14.1', execArgv: readiness.runtime.execArgv,
    nodeOptions: '', nodePath: '' }
  const options = { mode: 'run', sealSha256: readiness.sourceSealSha256, diagnosticStorageAb: true }
  assert.equal(createStorageAbReportOnly(readiness).proposedArgv[0], node)
  assert.doesNotThrow(() => validateStorageAbRunAdmission(options, readiness, environment))
  for (const update of [{ executable: '/usr/bin/node' }, { version: 'v22.0.0' }, { nodeOptions: '--inspect' },
    { nodePath: '/tmp/node-path' }, { execArgv: ['--experimental-strip-types'] }]) {
    assert.throws(() => validateStorageAbRunAdmission(options, readiness, { ...environment, ...update }))
  }
  assert.throws(() => createStorageAbReportOnly({ ...readiness, runtime: { ...readiness.runtime, version: 'v25.0.0' } }), /version/i)
})

test('profile import is inert and baseline benchmark bytes remain frozen', async () => {
  const names = async () => (await readdir('/tmp')).filter((name) => name.startsWith('modly-worlds-command-profile-new-')).sort()
  const before = await names()
  await import('./worlds-command-profile.mjs?pure-inert-evaluation')
  assert.deepEqual(await names(), before)
  for (const [path, expected] of [
    ['scripts/worlds-command-latency.mjs', '97d1e6eebea2d81ccd8609b879bd4ddc4c7716a04588364e1319251dc8e98941'],
    ['scripts/worlds-command-latency.test.mjs', '4487d0f412ed542e43faec6d141ba4bda53c80fbab25da562832188f250ff5ef'],
    ['docs/worlds-command-latency.md', 'd2258c67be9c22468a2e9b34612efb0b861f9a234d6e3209ce2d2f69abdafa16'],
  ]) assert.equal(createHash('sha256').update(await readFile(resolve(root, path))).digest('hex'), expected)
  const source = await readFile(script, 'utf8')
  assert.equal(source.includes('inspector.open('), false)
  assert.equal(source.includes('failureCheckpoint:'), false)
  assert.equal(source.includes('syncDirectory:'), false)
  assert.doesNotMatch(source, /\b(?:rm|rmdir|rename)\s*\(/)
  assert.equal(source.includes('cleanupStatus'), false)
})

test('profile governed runner actually plans the focused mjs suite once', async () => {
  const plan = await createNodeTestPlan()
  for (const file of ['scripts/worlds-command-profile.test.mjs', 'scripts/worlds-command-profile.contract.test.mjs']) {
    const entries = plan.filter((entry) => entry.file === file)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].phase, 'mjs')
    assert.deepEqual(entries[0].args, ['--test', '--test-concurrency=1', file])
  }
  assert.ok(plan.length <= 256)
})

// In-memory workflow ports: no application imports, inspector connections or scratch IO.
const digest = (value) => createHash('sha256').update(value).digest('hex')
const workflow = async ({ stopFailure = false, dispatchFailure = false, malformed = false, brokenLifecycle = false,
  failWrite = null, diskFailure = false, stateFailure = false, releaseFailure = false, lstatFailure = false, custodyReader = null } = {}) => {
  const files = new Map(), calls = [], workspace = owned().path, evidence = '/fake/diagnostic-evidence'
  const readiness = diagnostic.sealProfileManifest(base(), extras(), [])
  const projectKey = `world-${'a'.repeat(32)}`, sceneId = 'scene:unit-controller'
  let snapshot = emptySnapshot(projectKey, sceneId)
  let receipts = [], durableReceipts = [], state, listener = null, nextEntity = 0
  const ok = (value = {}) => ({ ok: true, value })
  const update = () => { Object.freeze(snapshot); state = { lifecycle: 'ready', activeSceneId: sceneId, savedRevision: snapshot.project.revision,
    canUndo: receipts.length > 0, canRedo: false, session: Object.freeze({ snapshot, undoStack: receipts.map(() => ({})), redoStack: [], receipts }) } }
  update()
  const controller = {
    getState: () => { if (stateFailure && snapshot.project.revision === 33) throw new Error('state unavailable'); return state },
    async openProject() { receipts = []; update(); return ok({}) },
    async closeProject() { calls.push('close'); state = { lifecycle: 'closed', session: null }; return ok() },
    subscribe(fn) { listener = fn; return () => { calls.push('unsubscribe'); listener = null } },
    async dispatchCommands(request, authority) {
      const revision = snapshot.project.revision + 1
      calls.push(`dispatch:${revision}`)
      listener?.({ ...state, lifecycle: 'loading' })
      if (dispatchFailure && revision === 33) throw new Error('dispatch failed independently')
      const batch = { schema: 'modly.world-command-batch.v1', transactionId: request.transactionId, projectId: snapshot.project.projectId,
        baseRevision: revision - 1, origin: 'ui', commands: structuredClone(request.commands) }
      const canonicalPayload = canonicalWorldCommandBatchPayload(batch), evaluated = applyWorldCommandBatch(snapshot, batch)
      assert.equal(evaluated.success, true, JSON.stringify(evaluated.issues))
      snapshot = evaluated.snapshot
      const storedResult = { schema: 'modly.world-command-result.v1', transactionId: request.transactionId, snapshot,
        newRevision: revision, changes: evaluated.changes, warnings: evaluated.warnings, inverse: evaluated.inverse }
      const receipt = { transactionId: request.transactionId, appliedRevision: revision, payloadSha256: digest(canonicalPayload), resultSha256: digest(canonicalBytes(storedResult)) }
      receipts = [...receipts, { transactionId: request.transactionId, fingerprint: fingerprintWorldCommandBatch(batch), canonicalPayload, appliedRevision: revision }]
      durableReceipts = [...durableReceipts, { ...receipt, canonicalPayload, transactionDigest: digest(`${request.transactionId}\n${canonicalPayload}`) }]; update()
      if (!brokenLifecycle || revision !== 33) listener?.(state)
      return ok({ idempotent: false, revision, transactionId: request.transactionId, receipt, warnings: [] })
    },
  }
  const service = { create: async () => { calls.push('create'); return ok({ projectKey, snapshot }) }, open: async () => ok({ snapshot }) }
  class Session {
    connect() { calls.push('connect') }
    disconnect() { calls.push('disconnect'); if (releaseFailure) throw new Error('disconnect failed independently') }
    post(method, _params, callback) {
      calls.push(method)
      if (method === 'Profiler.stop' && stopFailure) callback(new Error('stop failed independently'))
      else callback(null, method === 'Profiler.stop' ? { profile: malformed ? {} : profile() } : {})
    }
  }
  const inspect = async () => {
    calls.push(`disk:${snapshot.project.revision}`)
    if (diskFailure && snapshot.project.revision === 33) throw new Error('custody read failed')
    if (custodyReader && snapshot.project.revision === 33) await custodyReader()
    return { state: { committedRevision: snapshot.project.revision, transactions: durableReceipts.slice(-32) }, snapshot,
      backups: Array.from({ length: Math.min(8, snapshot.project.revision) }, (_, i) => String(i)), journalAbsent: true,
      custody: { status: 'PASS', files: [{ path: 'fake-durable-result', sha256: 'a'.repeat(64) }] } }
  }
  const result = await diagnostic.runDiagnostic(readiness, {
    createEvidenceDirectory: async () => evidence, realpath: async (path) => path, statfs: async () => ({ type: 1n }),
    safeDirectory: async () => {}, mkdtemp: async () => { calls.push('allocate'); return workspace }, release: () => 'fake-os',
    lstat: async () => { if (lstatFailure) throw new Error('initial identity read failed'); return { dev: 23n, ino: 456n, uid: 1000n, isDirectory: () => true, isSymbolicLink: () => false } },
    writeFile: async (path, bytes) => { calls.push(`write:${path.slice(evidence.length + 1)}`); if (failWrite && path.endsWith(failWrite)) throw new Error(`write failed: ${failWrite}`); files.set(path, String(bytes)) },
    appendFile: async (path, bytes) => files.set(path, (files.get(path) ?? '') + bytes),
    readJsonFile: async (path) => JSON.parse(files.get(path)), inspectSettled: inspect,
    rm: async () => { calls.push('DESTRUCTIVE_REMOVE') }, absent: async () => true,
    collectProfileManifest: async () => readiness,
    loadInspector: async () => ({ Session }),
    loadApplication: async () => [{ WorldProjectRepository: class {} }, { createWorldProjectService: () => service },
      { createWorldEditorController: () => controller }, { buildAddEmptyEntityCommands: (_context, { name }) => [{ type: 'add-entity', sceneId, entity: emptyEntity(`entity:${nextEntity++}`, name) }] },
      { createDeterministicWorldEditorIdentityGenerator: () => ({}), buildPatchEntityTransformsCommands: (_snapshot, sceneId, transforms) => transforms.map(({ entityId, transform }) => ({ type: 'patch-entity', sceneId, entityId, patch: { transform } })) }],
  })
  return { result, calls, read: (name) => files.has(`${evidence}/${name}`) ? JSON.parse(files.get(`${evidence}/${name}`)) : null }
}

test('F1 retains replacement during awaited admission recording without any destruction', async () => {
  let current = observed(), destroyed = false
  const records = []
  const result = await diagnostic.finalizeOwnedWorkspace(owned(), { settled: true, interrupted: false }, {
    readOwnership: async () => owned(), observe: async () => ({ ...current }),
    save: async (name, value) => { records.push({ name, value: structuredClone(value) }); if (name.endsWith('admission.json')) current = { ...current, ino: '999' } },
    remove: async () => { destroyed = true }, absent: async () => true,
  })
  assert.equal(destroyed, false, 'No identity or pathname may be destroyed, including a replacement during evidence persistence.')
  assert.equal(result.status, 'OWNERSHIP_UNVERIFIED')
  assert.equal(records[0].value.observed.ino, '456')
  assert.equal(records.at(-1).value.observed.ino, '999')
})

test('F2 full workflow retains actual settled state and disk despite profiler stop failure', async () => {
  const run = await workflow({ stopFailure: true })
  assert.ok(run.calls.includes('dispatch:33'), 'Fake workflow reached the admitted profiled dispatch.')
  assert.ok(run.result.errors.some((error) => error.message === 'stop failed independently'))
  assert.equal(run.read('profile-01-observed.json')?.snapshot.project.revision, 33, 'Profiler failure must not bypass actual post-command custody.')
  assert.equal(run.read('profile-01-disk.json')?.state.committedRevision, 33)
  assert.equal(run.read('profile-01-observed.json').result.value.revision, 33)
  assert.ok(run.calls.indexOf('disconnect') < run.calls.indexOf('disk:33'), 'Failed capture attempts disconnect before durable custody.')
  assert.equal(run.calls.includes('DESTRUCTIVE_REMOVE'), false)
  assert.equal(run.result.status, 'INCOMPLETE')
})

const custodyFixture = ({ sceneId = 'scene:d1f4b8c0c24d353f3a38977361bd6820', sceneFile = 'scene-d1f4b8c0c24d353f3a38977361bd6820.world-scene.json', emptyBackup = false } = {}) => {
  const projectKey = 'world-543ca8b22502fc984e3b1481f4bb0cc0', workspace = owned().path
  const projectPath = `Worlds/${projectKey}`, scenePath = `${projectPath}/scenes/${sceneFile}`
  const files = new Map(), stored = []
  const add = (path, value) => { const bytes = Buffer.isBuffer(value) ? value : canonicalBytes(value); files.set(`${workspace}/${path}`, bytes); return digest(bytes) }
  const initial = emptySnapshot(projectKey, sceneId, sceneFile)
  assert.equal(validateWorldProjectSnapshot(initial).success, true)
  const binding = { id: sceneId, documentPath: scenePath, projectId: initial.project.projectId }
  const makeStep = (before, revision, commands) => {
    const batch = { schema: 'modly.world-command-batch.v1', transactionId: `tx:test:${revision}`, projectId: initial.project.projectId, baseRevision: revision - 1, origin: 'ui', commands }
    const evaluated = applyWorldCommandBatch(before, batch); assert.equal(evaluated.success, true, JSON.stringify(evaluated.issues))
    const result = { schema: 'modly.world-command-result.v1', transactionId: batch.transactionId, snapshot: evaluated.snapshot,
      newRevision: revision, changes: evaluated.changes, warnings: evaluated.warnings, inverse: evaluated.inverse }
    const canonicalPayload = canonicalWorldCommandBatchPayload(batch), transactionDigest = digest(`${batch.transactionId}\n${canonicalPayload}`)
    return { result, bytes: canonicalBytes(result), transaction: { transactionId: batch.transactionId, transactionDigest, canonicalPayload,
      payloadSha256: digest(canonicalPayload), resultSha256: digest(canonicalBytes(result)), appliedRevision: revision } }
  }
  const first = makeStep(initial, 1, [{ type: 'add-entity', sceneId, entity: emptyEntity('entity:test', 'Entity') }])
  const latest = emptyBackup ? first : makeStep(first.result.snapshot, 2, [{ type: 'patch-entity', sceneId, entityId: 'entity:test', patch: { name: 'Renamed' } }])
  const steps = emptyBackup ? [first] : [first, latest], backupSteps = emptyBackup ? [] : [first]
  const snapshot = latest.result.snapshot, backupSnapshot = emptyBackup ? initial : first.result.snapshot
  const stateFor = (value, transactions, lastValidBackup = null) => ({ schema: 'modly.world-project-state.v1', projectKey, projectId: initial.project.projectId,
    committedRevision: value.project.revision, project: { path: `${projectPath}/project.world-project.json`, sha256: digest(canonicalBytes(value.project)) },
    scenes: [{ sceneId, path: scenePath, sha256: digest(canonicalBytes(value.scenes[0])) }], transactions, lastValidBackup })
  const backupName = `${backupSnapshot.project.revision}-${latest.transaction.transactionDigest}`, backupPath = `${projectPath}/.modly/backups/${backupName}`
  const state = stateFor(snapshot, steps.map((step) => step.transaction), `.modly/backups/${backupName}`)
  add(`${projectPath}/project.world-project.json`, snapshot.project); add(scenePath, snapshot.scenes[0])
  add(`${projectPath}/.modly/state.v1.json`, state)
  for (const step of steps) add(`${projectPath}/.modly/transactions/${step.transaction.transactionDigest}/after/result.v1.json`, step.bytes)
  const resultPath = `${projectPath}/.modly/transactions/${latest.transaction.transactionDigest}/after/result.v1.json`
  const backupState = stateFor(backupSnapshot, backupSteps.map((step) => step.transaction))
  const stateSha256 = add(`${backupPath}/state.v1.json`, backupState)
  add(`${backupPath}/project.world-project.json`, backupSnapshot.project); add(`${backupPath}/scenes/${sceneFile}`, backupSnapshot.scenes[0])
  const pack = Buffer.concat(backupSteps.map((step) => step.bytes))
  add(`${backupPath}/transactions.pack.v1`, pack)
  const index = { schema: 'modly.world-backup-transaction-pack.v1', projectKey, projectId: initial.project.projectId, committedRevision: backupSnapshot.project.revision, stateSha256,
    pack: { path: 'transactions.pack.v1', byteLength: pack.length, sha256: digest(pack) }, entries: backupSteps.map(({ transaction, bytes }) => ({ transactionId: transaction.transactionId, transactionDigest: transaction.transactionDigest, resultSha256: transaction.resultSha256, offset: 0, length: bytes.length })) }
  add(`${backupPath}/transactions.index.v1.json`, index)
  const io = { safeDirectory: async () => {}, readJsonFile: async (path) => JSON.parse(files.get(path)),
    readdir: async () => [{ name: backupName, isDirectory: () => true, isSymbolicLink: () => false }], absent: async () => true,
    readBytes: async (path) => { assert.ok(files.has(path), `Unknown fake read: ${path}`); return files.get(path) },
    retainBytes: async (path, bytes) => { stored.push({ path, bytes: Buffer.from(bytes) }); return { path, sha256: digest(bytes), byteLength: bytes.length, blob: `blobs/${digest(bytes)}` } } }
  return { workspace, projectKey, io, files, stored, result: latest.result, resultPath, backupPath, index, binding, initial, add, state, backupState }
}

test('F3 retains independently hashed result inverse and actual backup bytes instead of metadata only', async () => {
  const fixture = custodyFixture()
  const disk = await diagnostic.inspectSettled(fixture.workspace, fixture.projectKey, fixture.io, fixture.binding)
  assert.ok(disk.custody?.files.some((entry) => entry.path.endsWith('/after/result.v1.json')), 'Actual durable result body custody is mandatory.')
  for (const suffix of ['state.v1.json', 'transactions.index.v1.json', 'transactions.pack.v1']) {
    assert.ok(fixture.stored.some((entry) => entry.path === `${fixture.backupPath}/${suffix}`), `Missing actual backup bytes: ${suffix}`)
  }
  assert.deepEqual(JSON.parse(fixture.stored.find((entry) => entry.path === fixture.resultPath).bytes).inverse, fixture.result.inverse)
})

test('full fake workflow preserves actual custody across reduction lifecycle and evidence failures', async (t) => {
  for (const [name, options] of [
    ['reducer', { malformed: true }], ['lifecycle', { brokenLifecycle: true }],
    ['capture write', { failWrite: 'profile-01-capture.json' }], ['raw profile write', { failWrite: 'profile-01.cpuprofile' }],
    ['observed write', { failWrite: 'profile-01-observed.json' }], ['disk write', { failWrite: 'profile-01-disk.json' }],
    ['resource release', { stopFailure: true, releaseFailure: true }],
  ]) await t.test(name, async () => {
    const run = await workflow(options)
    assert.equal(run.result.status, 'INCOMPLETE')
    assert.equal(run.read('last-settled-actual.json').actual.result.value.revision, 33)
    assert.equal(run.read('last-settled-actual.json').actual.snapshot.project.revision, 33)
    assert.equal(run.read('last-settled-actual.json').disk.state.committedRevision, 33)
    assert.ok(run.calls.indexOf('disk:33') < run.calls.lastIndexOf('close'))
    assert.equal(run.calls.filter((call) => call === 'disconnect').length, 1)
    assert.equal(run.calls.filter((call) => call === 'unsubscribe').length, 1)
    assert.equal(run.calls.includes('DESTRUCTIVE_REMOVE'), false)
    assert.equal(run.read('workspace-final.json').status, 'WORKSPACE_RETAINED_BY_DESIGN')
  })
})

test('full fake workflow preserves independent dispatch stop and evidence errors together', async () => {
  const run = await workflow({ dispatchFailure: true, stopFailure: true, failWrite: 'profile-01-capture.json' })
  for (const message of ['dispatch failed independently', 'stop failed independently', 'write failed: profile-01-capture.json']) {
    assert.ok(run.result.errors.some((error) => error.message === message), message)
    assert.ok(run.read('errors.json').some((error) => error.message === message), `Durable original error: ${message}`)
  }
  assert.equal(run.read('profile-01-observed.json').snapshot.project.revision, 32)
  assert.equal(run.read('profile-01-disk.json').state.committedRevision, 32)
  assert.equal(run.result.status, 'INCOMPLETE')
})

test('full fake workflow missing actual state or disk custody never becomes complete', async () => {
  for (const options of [{ diskFailure: true }, { stateFailure: true }]) {
    const run = await workflow(options)
    assert.equal(run.result.status, 'INCOMPLETE')
    assert.equal(run.read('profile-01-capture.json').result.value.revision, 33)
    assert.ok(run.result.errors.some((error) => /custody read failed|state unavailable/.test(error.message)))
    assert.equal(run.read('pending-command.json').status, 'SETTLED')
    assert.equal(run.calls.includes('DESTRUCTIVE_REMOVE'), false)
  }
})

test('full fake workflow records pre-capture failures with no application or workspace admission', async () => {
  const run = await workflow({ failWrite: 'metadata.json' })
  assert.equal(run.result.status, 'INCOMPLETE'); assert.equal(run.result.workspaceStatus, 'NOT_CREATED')
  assert.equal(run.calls.some((call) => call.startsWith('dispatch:')), false)
  assert.equal(run.calls.includes('connect'), false)
  assert.ok(run.read('errors.json').some((error) => error.message === 'write failed: metadata.json'))
})

test('full fake workflow completes52 settled commands and20 profiles with retained workspace not cleanup PASS', async () => {
  const run = await workflow()
  assert.equal(run.result.status, 'DIAGNOSTIC_COMPLETE', JSON.stringify(run.result.errors))
  assert.equal(run.result.successfulSetup, 32); assert.equal(run.result.successfulProfiledCommands, 20)
  assert.equal(run.result.usableProfiles, 20)
  assert.equal(run.result.workspaceStatus, 'WORKSPACE_RETAINED_BY_DESIGN')
  assert.equal(run.result.performanceAcceptance, 'NOT_ASSESSED')
  assert.equal(run.calls.filter((call) => call.startsWith('dispatch:')).length, 52)
  assert.equal(run.read('reopened-state.json').session.undoStack.length, 0)
  assert.equal(run.read('reopened-disk.json').state.transactions.length, 32)
  assert.equal(run.read('profile-20-observed.json').localReceipt.canonicalPayload.length > 0, true)
  assert.deepEqual(run.read('profile-20-observed.json').publicReceipt, run.read('profile-20-observed.json').result.value.receipt)
  assert.equal(run.calls.includes('DESTRUCTIVE_REMOVE'), false)
})

test('retention final identity is still recorded when admission persistence fails', async () => {
  const writes = []
  const result = await diagnostic.finalizeOwnedWorkspace(owned(), { settled: true, interrupted: false }, {
    readOwnership: async () => owned(), observe: async () => observed(),
    save: async (name, value) => { if (name === 'workspace-admission.json') throw new Error('admission disk full'); writes.push({ name, value }) },
    remove: () => assert.fail('Destructive port must remain unused'),
  })
  assert.equal(result.status, 'EVIDENCE_INCOMPLETE')
  assert.equal(writes[0].name, 'workspace-final.json')
  assert.deepEqual(writes[0].value.observed, observed())
  assert.equal(result.errors[0].message, 'admission disk full')
})

test('body custody deduplicates actual bytes and enforces separate256MiB budget without unbounded writes', async () => {
  const writes = []
  const store = diagnostic.createEvidenceBodyStore(async (path, bytes) => writes.push({ path, bytes }), 3)
  const a = await store.retainBytes('one', Buffer.from('abc')), b = await store.retainBytes('two', Buffer.from('abc'))
  assert.equal(a.blob, b.blob); assert.equal(a.sha256, digest(Buffer.from('abc')))
  assert.equal(writes.length, 1); assert.equal(store.budget().reservedBytes, 3)
  await assert.rejects(store.retainBytes('third', Buffer.from('x')), /byte budget/)
  assert.equal(writes.length, 1)
  assert.throws(() => diagnostic.createEvidenceBodyStore(() => {}, 256 * 1024 * 1024 + 1))
  const failing = diagnostic.createEvidenceBodyStore(async () => { throw new Error('partial blob write') }, 3)
  await assert.rejects(failing.retainBytes('one', Buffer.from('abc')), /partial blob write/)
  assert.equal(failing.budget().reservedBytes, 3)
  assert.equal(failing.budget().uniqueBlobs, 0)
})

test('actual primary and backup custody rejects hash index range and per-file bound violations', async () => {
  for (const corrupt of ['result', 'pack', 'range', 'oversized', 'escape']) {
    const fixture = custodyFixture()
    const path = corrupt === 'result' ? fixture.resultPath : `${fixture.backupPath}/transactions.pack.v1`
    if (['result', 'pack'].includes(corrupt)) fixture.files.set(`${fixture.workspace}/${path}`, Buffer.from('tampered'))
    if (corrupt === 'range') {
      fixture.index.entries[0].offset = 1
      fixture.files.set(`${fixture.workspace}/${fixture.backupPath}/transactions.index.v1.json`, Buffer.from(JSON.stringify(fixture.index)))
    }
    if (corrupt === 'oversized') fixture.io.readBytes = async () => Buffer.alloc(diagnostic.PROFILE_CONTRACT.maxDocumentBytes + 1)
    if (corrupt === 'escape') {
      const statePath = `${fixture.workspace}/Worlds/${fixture.projectKey}/.modly/state.v1.json`
      const state = JSON.parse(fixture.files.get(statePath)); state.project.path = '../outside'
      fixture.files.set(statePath, Buffer.from(JSON.stringify(state)))
    }
    await assert.rejects(diagnostic.inspectSettled(fixture.workspace, fixture.projectKey, fixture.io, fixture.binding))
    if (['result', 'pack'].includes(corrupt)) assert.ok(fixture.stored.some((item) => item.path === path && item.bytes.toString() === 'tampered'))
  }
})

test('repeated fixed custody inventories write identical blobs once while reading and hashing every observation', async () => {
  const fixture = custodyFixture(), writes = [], store = diagnostic.createEvidenceBodyStore(async (path, bytes) => writes.push({ path, bytes }))
  fixture.io.retainBytes = store.retainBytes
  const first = await diagnostic.inspectSettled(fixture.workspace, fixture.projectKey, fixture.io, fixture.binding)
  const count = writes.length
  const second = await diagnostic.inspectSettled(fixture.workspace, fixture.projectKey, fixture.io, fixture.binding)
  assert.deepEqual(first, second); assert.equal(writes.length, count)
  assert.ok(first.custody.files.length > writes.length, 'Identical primary/backup documents share blob content, not copied bodies.')
})

const fileReader = ({ symlink = false, parentSymlink = false, alias = false, oversized = false, grow = false, shrink = false, replacement = false,
  parentSwap = false, readFailure = false, readError = null, closeError = null } = {}) => {
  const calls = [], workspace = owned().path, path = `${workspace}/payload`, bytes = Buffer.from('abc')
  let read = false
  const info = (file) => ({ dev: 23n, ino: file ? (read && replacement ? 999n : 456n) : (read && parentSwap ? 8n : 7n), uid: 1000n,
    size: file ? (oversized ? 99n : grow && read ? 4n : 3n) : 0n, mtimeNs: 1n, ctimeNs: 1n,
    isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => file ? symlink : parentSymlink })
  const io = {
    lstat: async (target) => info(target === path), realpath: async (target) => alias ? '/foreign' : target,
    open: async (target, flags) => { calls.push('open'); assert.equal(target, path); assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW); return {
      stat: async () => info(true), close: async () => { calls.push('close'); if (closeError) throw closeError },
    } },
    readOpened: async (_handle, maximum, size) => { calls.push('read'); assert.equal(maximum, 3); assert.equal(size, 3); read = true;
      if (readError) throw readError
      if (readFailure) throw new Error('read failed'); return shrink ? Buffer.from('ab') : bytes },
  }
  return { path, workspace, calls, io }
}

test('bounded nofollow descriptor reader retains identity and closes after success or changed unreadable inputs', async () => {
  const fixture = fileReader()
  const result = await diagnostic.readEvidenceFile(fixture.workspace, fixture.path, 3, fixture.io)
  assert.equal(result.bytes.toString(), 'abc'); assert.equal(result.identity.noFollow, true); assert.equal(result.identity.type, 'regular-file')
  assert.deepEqual(fixture.calls, ['open', 'read', 'close'])
  for (const kind of ['symlink', 'parentSymlink', 'alias', 'oversized', 'grow', 'shrink', 'replacement', 'parentSwap', 'readFailure']) {
    const bad = fileReader({ [kind]: true })
    await assert.rejects(diagnostic.readEvidenceFile(bad.workspace, bad.path, 3, bad.io))
    assert.equal(bad.calls.filter((call) => call === 'close').length, bad.calls.includes('open') ? 1 : 0, kind)
  }
  await assert.rejects(diagnostic.readEvidenceFile(fixture.workspace, '/tmp/foreign', 3, fixture.io), /escapes/)
})

test('fixed custody accepts the initial empty packed backup without inventing result samples', async () => {
  const fixture = custodyFixture({ emptyBackup: true })
  const disk = await diagnostic.inspectSettled(fixture.workspace, fixture.projectKey, fixture.io, fixture.binding)
  assert.equal(disk.custody.status, 'PASS')
  assert.ok(fixture.stored.some((item) => item.path.endsWith('/transactions.pack.v1') && item.bytes.length === 0))
})

test('storage binding accepts captured canonical ID path and revision0 backup actual bytes', async () => {
  const fixture = custodyFixture({ emptyBackup: true })
  assert.deepEqual(diagnostic.pinSceneBinding(fixture.projectKey, fixture.initial), fixture.binding)
  const disk = await diagnostic.inspectSettled(fixture.workspace, fixture.projectKey, fixture.io, fixture.binding)
  assert.deepEqual(disk.snapshot.project.scenes[0], fixture.initial.project.scenes[0])
  assert.equal(disk.snapshot.scenes[0].sceneId, fixture.binding.id)
  assert.equal(disk.state.committedRevision, 1)
  assert.equal(disk.custody.status, 'PASS')
  for (const suffix of ['state.v1.json', 'project.world-project.json', 'transactions.index.v1.json', 'transactions.pack.v1']) {
    assert.ok(disk.custody.files.some((file) => file.path === `${fixture.backupPath}/${suffix}`), suffix)
  }
})

test('storage binding accepts independent physical keys for all canonical custom semantic IDs', async () => {
  for (const sceneId of ['scene:custom', 'SCENE:custom', 'custom-id', `scene-${'f'.repeat(32)}`]) {
    const fixture = custodyFixture({ sceneId, sceneFile: `scene-${'e'.repeat(32)}.world-scene.json`, emptyBackup: true })
    const pinned = diagnostic.pinSceneBinding(fixture.projectKey, fixture.initial)
    assert.ok(Object.isFrozen(pinned)); assert.deepEqual(pinned, fixture.binding)
    const disk = await diagnostic.inspectSettled(fixture.workspace, fixture.projectKey, fixture.io, fixture.binding)
    assert.equal(disk.snapshot.scenes[0].sceneId, sceneId)
    assert.ok(fixture.stored.some((file) => file.path === fixture.binding.documentPath))
  }
})

test('pinned custody rejects changed primary or backup IDs paths and missing bodies even with matching hashes', async () => {
  for (const backup of [false, true]) for (const kind of ['stateId', 'projectId', 'bodyId', 'bodyProject', 'stateProject', 'projectProject', 'statePath', 'projectPath', 'coherentPath', 'missing']) {
    const fixture = custodyFixture({ emptyBackup: true }), prefix = `Worlds/${fixture.projectKey}`
    const packagePath = backup ? fixture.backupPath : prefix
    const statePath = `${packagePath}/${backup ? '' : '.modly/'}state.v1.json`
    const projectPath = `${packagePath}/project.world-project.json`, bodyPath = `${packagePath}/scenes/${fixture.binding.documentPath.split('/').at(-1)}`
    const get = (path) => JSON.parse(fixture.files.get(`${fixture.workspace}/${path}`))
    const state = get(statePath), project = get(projectPath), body = get(bodyPath)
    if (kind === 'stateId') state.scenes[0].sceneId = 'scene:changed'
    if (kind === 'projectId') project.scenes[0].id = 'scene:changed'
    if (kind === 'bodyId') body.sceneId = 'scene:changed'
    if (kind === 'bodyProject') body.projectId = 'project:changed'
    if (kind === 'stateProject') state.projectId = 'project:changed'
    if (kind === 'projectProject') project.projectId = 'project:changed'
    const changedPath = `${prefix}/scenes/scene-${'a'.repeat(32)}.world-scene.json`
    if (['statePath', 'coherentPath'].includes(kind)) state.scenes[0].path = changedPath
    if (['projectPath', 'coherentPath'].includes(kind)) project.scenes[0].documentPath = changedPath
    state.project.sha256 = fixture.add(projectPath, project)
    state.scenes[0].sha256 = fixture.add(bodyPath, body)
    if (kind === 'coherentPath') fixture.add(`${packagePath}/scenes/${changedPath.split('/').at(-1)}`, body)
    if (['coherentPath', 'missing'].includes(kind)) fixture.files.delete(`${fixture.workspace}/${bodyPath}`)
    const stateSha256 = fixture.add(statePath, state)
    if (backup) fixture.add(`${packagePath}/transactions.index.v1.json`, { ...fixture.index, stateSha256 })
    await assert.rejects(diagnostic.inspectSettled(fixture.workspace, fixture.projectKey, fixture.io, fixture.binding), undefined, `${backup}:${kind}`)
  }
})

test('pinned custody rejects unsafe bound filenames before reading any body', async () => {
  const fixture = custodyFixture(), prefix = `Worlds/${fixture.projectKey}/scenes/`, good = fixture.binding.documentPath.slice(prefix.length)
  const paths = [good.toUpperCase(), good.replace('scene-', 'scene-a'), good.replace('.json', '.JSON'), `nested/${good}`, `../${good}`, `/${good}`].map((suffix) => `${prefix}${suffix}`)
  paths.push(`/tmp/${good}`, `Worlds/world-${'f'.repeat(32)}/scenes/${good}`)
  for (const documentPath of paths) {
    let reads = 0
    await assert.rejects(diagnostic.inspectSettled(fixture.workspace, fixture.projectKey, { ...fixture.io, readBytes: () => { reads++; throw new Error('Unsafe read admitted') } }, { ...fixture.binding, documentPath }))
    assert.equal(reads, 0, documentPath)
  }
})

test('provisional workspace custody preserves allocated path when initial identity read fails before commands', async () => {
  const run = await workflow({ lstatFailure: true })
  assert.ok(run.calls.includes('allocate'))
  assert.equal(run.result.workspaceStatus, 'CREATED_IDENTITY_UNCONFIRMED')
  assert.equal(run.result.allocatedWorkspace.path, owned().path)
  assert.equal(run.result.ownedWorkspace, null, 'Unknown identity must not be fabricated.')
  assert.equal(run.read('workspace-provisional.json').path, owned().path)
  assert.equal(run.read('workspace-final.json').status, 'CREATED_IDENTITY_UNCONFIRMED')
  assert.equal(run.read('workspace-final.json').allocated.path, owned().path)
  assert.ok(run.read('errors.json').some((error) => error.message === 'initial identity read failed'))
  assert.equal(run.calls.some((call) => call === 'create' || call.startsWith('dispatch:') || call === 'connect'), false)
  assert.equal(run.calls.includes('DESTRUCTIVE_REMOVE'), false)
  assert.equal(run.result.status, 'INCOMPLETE')
})

// Promoted from the independent remediation-review targeted counterexample.
const readerErrorMessages = (error) => !error ? [] : [String(error.message), ...readerErrorMessages(error.cause),
  ...(Array.isArray(error.errors) ? error.errors.flatMap(readerErrorMessages) : [])]

test('F4 bounded custody retains primary read and independent descriptor close failures', async () => {
  const fixture = fileReader({ readError: new Error('PRIMARY_EVIDENCE_READ_FAILURE'), closeError: new Error('INDEPENDENT_DESCRIPTOR_CLOSE_FAILURE') })
  let caught
  try { await diagnostic.readEvidenceFile(fixture.workspace, fixture.path, 3, fixture.io) } catch (error) { caught = error }
  assert.deepEqual(fixture.calls, ['open', 'read', 'close'])
  const observed = readerErrorMessages(caught)
  assert.ok(observed.includes('PRIMARY_EVIDENCE_READ_FAILURE'), 'The original evidence-read failure must survive descriptor-finalization failure.')
  assert.ok(observed.includes('INDEPENDENT_DESCRIPTOR_CLOSE_FAILURE'), 'The independent close failure must remain available.')
})

test('F4 bounded custody preserves each isolated original error and closes exactly once', async () => {
  for (const kind of ['readError', 'closeError']) {
    const original = new Error(kind), fixture = fileReader({ [kind]: original })
    await assert.rejects(diagnostic.readEvidenceFile(fixture.workspace, fixture.path, 3, fixture.io), (observed) => observed === original)
    assert.deepEqual(fixture.calls, ['open', 'read', 'close'])
  }
})

test('F4 full orchestration serializes distinct read integrity and close records into returned and durable ledgers', async () => {
  for (const integrity of [false, true]) {
    const primary = new Error('PRIMARY_EVIDENCE_READ_FAILURE'); primary.code = 'TEST_READ_FAILURE'
    const closeError = new Error('INDEPENDENT_DESCRIPTOR_CLOSE_FAILURE'); closeError.code = 'TEST_CLOSE_FAILURE'
    const fixture = fileReader({ ...(integrity ? { shrink: true } : { readError: primary }), closeError })
    const run = await workflow({ custodyReader: () => diagnostic.readEvidenceFile(fixture.workspace, fixture.path, 3, fixture.io) })
    assert.deepEqual(fixture.calls, ['open', 'read', 'close'])
    for (const ledger of [run.result.errors, run.read('errors.json'), run.read('summary.json').errors, run.read('pending-command.json').errors]) {
      const failure = ledger.find((record) => record.stage === 'profile-01:disk-read')
      assert.ok(failure, 'Actual workflow must retain the custody failure stage.')
      assert.ok(readerErrorMessages(failure).some((message) => message.includes(integrity ? 'Evidence body shrank while reading.' : primary.message)), 'The serialized workflow ledger must retain the primary error.')
      assert.deepEqual(failure.errors.map((record) => record.stage), ['evidence-read', 'descriptor-close'])
      assert.equal(failure.errors[0].code, integrity ? 'ERR_ASSERTION' : 'TEST_READ_FAILURE')
      assert.equal(failure.errors[1].message, closeError.message)
      assert.equal(failure.errors[1].code, 'TEST_CLOSE_FAILURE')
    }
    assert.equal(run.read('profile-01-observed.json').result.value.revision, 33)
    assert.equal(run.result.status, 'INCOMPLETE')
    assert.equal(run.result.workspaceStatus, 'WORKSPACE_RETAINED_BY_DESIGN')
    assert.equal(run.calls.includes('DESTRUCTIVE_REMOVE'), false)
  }
})
