import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir, mkdtemp, chmod, lstat, writeFile, rename, mkdir, symlink, open, link } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeTestPlan } from './run-node-tests.mjs'
import { parseArguments, nearestRank, classifyObservation, canCleanupOwnedWorkspace,
  buildScenario, moduleSpecifiers, collectSourceManifest, createLatencyReportOnly, validateRunAdmission, success, SCENARIO } from './worlds-command-latency.mjs'
import * as stageHarness from './worlds-command-latency.mjs'
import fsPromises from 'node:fs/promises'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { relative } from 'node:path'

const seal = 'a'.repeat(64)
const rows = (ns = '49999999') => Array.from({ length: 20 }, (_, i) => ({ phase: 'measure', index: i + 1, durationNs: ns, ok: true }))
const complete = { functionalStatus: 'PASS', sourceStatus: 'PASS', cleanupStatus: 'PASS', finished: true }

test('latency arguments require an explicit report-only or sealed run mode', () => {
  assert.deepEqual(parseArguments(['--report-only']), { mode: 'report-only', sealSha256: null })
  assert.deepEqual(parseArguments(['--run', '--seal-sha256', seal]), { mode: 'run', sealSha256: seal })
  assert.equal(parseArguments(['--help']).mode, 'help')
  assert.throws(() => parseArguments([]), /explicit mode/)
  assert.throws(() => parseArguments(['--run']), /seal/)
})

test('latency arguments reject workspace overrides duplicates ambiguous modes and bad seals', () => {
  for (const args of [
    ['--run', '--workspace', '/home/user/app'], ['--report-only', '--report-only'],
    ['--report-only', '--run'], ['--report-only', '--seal-sha256', seal],
    ['--run', '--seal-sha256', 'bad'], ['--run', '--seal-sha256', seal, '--seal-sha256', seal],
    ['--run', '--seal-sha256', seal, '--samples', '1'],
  ]) assert.throws(() => parseArguments(args), /argument|mode|seal/i)
})

test('latency nearest rank uses item10 p50 and item19 p95 without mutating raw order', () => {
  const raw = Array.from({ length: 20 }, (_, i) => String(20 - i))
  assert.equal(nearestRank(raw, 0.5), '10')
  assert.equal(nearestRank(raw, 0.95), '19')
  assert.equal(nearestRank(raw, 1), '20')
  assert.equal(raw[0], '20')
})

test('latency nearest rank preserves integer precision and rejects invalid inputs', () => {
  assert.equal(nearestRank(['9007199254740993', '9007199254740992'], 1), '9007199254740993')
  for (const raw of [[], ['-1'], ['1.5'], ['NaN'], ['01'], [NaN], ['']]) assert.throws(() => nearestRank(raw, 0.95), /duration|sample/)
  for (const rank of [0, -1, 1.01, NaN]) assert.throws(() => nearestRank(['1'], rank), /percentile/)
})

test('latency strict target fails at exactly50ms even when nearest-rank p95 passes', () => {
  const raw = rows()
  raw[19].durationNs = '50000000'
  const result = classifyObservation(raw, complete)
  assert.equal(result.status, 'LATENCY_FAIL')
  assert.equal(result.exitCode, 2)
  assert.equal(result.p95Under50Ms, true)
  assert.equal(result.allCommandsUnder50Ms, false)
  assert.equal(result.metrics.maxNs, '50000000')
  assert.equal(classifyObservation(rows(), complete).status, 'PASS')
})

test('latency classification never drops failed missing duplicate or malformed rows', () => {
  const failed = rows(); failed[7].ok = false
  const duplicate = rows(); duplicate[19].index = 19
  const malformed = rows(); malformed[0].durationNs = '-1'
  for (const raw of [rows().slice(1), [...rows(), rows()[0]], failed, duplicate, malformed]) {
    const result = classifyObservation(raw, complete)
    assert.notEqual(result.status, 'PASS')
    assert.equal(result.exitCode, 1)
    assert.equal(result.allCommandsUnder50Ms, null)
    assert.equal(result.metrics, null)
  }
})

test('latency classification distinguishes functional failure source drift partial and cleanup failure', () => {
  assert.equal(classifyObservation(rows(), { ...complete, functionalStatus: 'FAIL' }).status, 'FUNCTIONAL_FAIL')
  assert.equal(classifyObservation(rows(), { ...complete, sourceStatus: 'FAIL' }).status, 'INVALID_SOURCE')
  assert.equal(classifyObservation(rows(), { ...complete, finished: false }).status, 'PARTIAL')
  assert.equal(classifyObservation(rows(), { ...complete, cleanupStatus: 'FAIL' }).status, 'CLEANUP_FAIL')
  assert.equal(classifyObservation([], { functionalStatus: 'UNTESTED', sourceStatus: 'UNTESTED', cleanupStatus: 'UNTESTED', finished: false }).status, 'PARTIAL')
})

const owned = () => ({ token: 'b'.repeat(32), path: '/tmp/modly-worlds-command-latency-new-Ab12cd', dev: '23', ino: '456', uid: 1000 })
const observed = () => ({ ...owned(), realPath: owned().path, isDirectory: true, isSymbolicLink: false })

test('latency cleanup requires exact owned identity a settled process and intact durable token', () => {
  assert.equal(canCleanupOwnedWorkspace(owned(), observed(), { settled: true, durableToken: owned().token }), true)
  assert.equal(canCleanupOwnedWorkspace(owned(), observed(), { settled: false, durableToken: owned().token }), false)
  assert.equal(canCleanupOwnedWorkspace(owned(), observed(), { settled: true, durableToken: 'c'.repeat(32) }), false)
})

test('latency cleanup denies root aliases symlinks replacement inode and foreign ownership', () => {
  for (const change of [
    { realPath: '/tmp/elsewhere' }, { path: '/tmp/elsewhere' }, { dev: '99' }, { ino: '999' },
    { uid: 0 }, { isDirectory: false }, { isSymbolicLink: true }, { token: 'c'.repeat(32) },
  ]) assert.equal(canCleanupOwnedWorkspace(owned(), { ...observed(), ...change }, { settled: true, durableToken: owned().token }), false)
  for (const path of ['/tmp', '/tmp/modly-worlds-command-latency-new-Ab12cd/child', '/home/user/app', '/tmp/modly-worlds-command-latency-new-']) {
    const bad = { ...owned(), path }
    assert.equal(canCleanupOwnedWorkspace(bad, { ...observed(), ...bad, realPath: path }, { settled: true, durableToken: bad.token }), false)
  }
  assert.equal(canCleanupOwnedWorkspace(null, observed(), { settled: true, durableToken: owned().token }), false)
})

test('latency fixed scenario has32setup and20samples with original revisions and unique transactions', () => {
  const entities = Array.from({ length: 100 }, (_, index) => ({ id: `entity:${index}` }))
  const scenario = buildScenario({ projectKey: 'test-plan-only' }, entities)
  const setup = scenario.batches.filter((batch) => batch.phase === 'setup')
  const measured = scenario.batches.filter((batch) => batch.phase === 'measure')
  assert.equal(setup.length, 32)
  assert.equal(measured.length, 20)
  assert.equal(scenario.entityCount, 100)
  assert.equal(new Set(scenario.batches.map((batch) => batch.transactionId)).size, 52)
  assert.equal(setup[0].baseRevision, 0)
  assert.equal(setup[0].position, null)
  assert.deepEqual(setup[31].position, [31, 0, 0])
  assert.deepEqual(measured.map((batch) => batch.index), Array.from({ length: 20 }, (_, i) => i + 1))
  assert.equal(measured[0].baseRevision, 32)
  assert.equal(measured[19].baseRevision, 51)
  assert.deepEqual(measured[19].position, [51, 0, 0])
  assert.throws(() => buildScenario({}, entities.slice(1)))
  assert.throws(() => buildScenario({}, [...entities.slice(1), entities[1]]))
})

test('latency operation gate accepts void close but rejects all degraded durability warnings', () => {
  assert.equal(success({ ok: true, value: undefined }), undefined)
  for (const value of [{ durabilityWarnings: ['durability-degraded'] }, { warnings: ['durability-degraded'] }]) {
    assert.throws(() => success({ ok: true, value }), /warning/)
  }
  assert.throws(() => success({ ok: false, error: { code: 'write_failed' } }), /write_failed/)
  assert.throws(() => success({ ok: true, value: { warnings: ['transaction-idempotent'] } }), /warning/)
  const retry = { warnings: ['transaction-idempotent'] }
  assert.equal(success({ ok: true, value: retry }, ['transaction-idempotent']), retry)
})

test('latency partial helper failure never reports a win from otherwise fast samples', () => {
  const result = classifyObservation(rows('1'), { ...complete, finished: false, functionalStatus: 'FAIL' })
  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.functionalStatus, 'FAIL')
  assert.equal(result.exitCode, 1)
  assert.equal(result.metrics, null)
  assert.equal(result.p95Under50Ms, null)
  const wrongPhase = rows(); wrongPhase[0].phase = 'setup'
  assert.equal(classifyObservation(wrongPhase, complete).status, 'INVALID_SAMPLES')
  assert.equal(classifyObservation(rows(), { ...complete, sourceStatus: 'UNTESTED' }).exitCode, 1)
})

test('latency closure follows literal runtime imports and ignores type-only imports', () => {
  const source = [
    "import type { X } from './types.ts'", "import { value, type Shape } from './value.ts'",
    "export { renamed } from './other.ts'", "import 'node:fs'", "const module = await import('./dynamic.ts')",
  ].join('\n')
  assert.deepEqual(moduleSpecifiers(source), ['./value.ts', './other.ts', 'node:fs', './dynamic.ts'])
  assert.throws(() => moduleSpecifiers('const module = import(name)'), /Unsupported/)
  assert.throws(() => moduleSpecifiers("const module = require('three')"), /Unsupported/)
  assert.throws(() => moduleSpecifiers("import x, * as other from './other.ts'"), /Unsupported/)
})

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixedNode = '/opt/modly-node-v24.14.1/bin/node'
test('latency run admission rejects drift flags environment injection and foreign runtime before workload', () => {
  const readiness = { sourceSealSha256: seal, runtime: { executable: fixedNode, version: 'v24.14.1', execArgv: ['--experimental-strip-types'] } }
  const options = parseArguments(['--run', '--seal-sha256', seal])
  const environment = { cwd: root, executable: fixedNode, version: 'v24.14.1', execArgv: readiness.runtime.execArgv, nodeOptions: '', nodePath: '' }
  assert.doesNotThrow(() => validateRunAdmission(options, readiness, environment))
  assert.equal(createLatencyReportOnly(readiness).proposedArgv[0], fixedNode)
  assert.throws(() => validateRunAdmission({ ...options, sealSha256: 'b'.repeat(64) }, readiness, environment), /seal/)
  assert.throws(() => validateRunAdmission(parseArguments(['--report-only']), readiness, environment), /run/)
  for (const change of [{ cwd: '/tmp' }, { executable: '/usr/bin/node' }, { version: 'v22.0.0' },
    { nodeOptions: '--inspect' }, { nodePath: '/tmp/modules' }, { execArgv: ['--experimental-strip-types', '--inspect'] },
    { execArgv: ['--experimental-strip-types', '--loader', '/tmp/foreign-loader.mjs'] }]) {
    assert.throws(() => validateRunAdmission(options, readiness, { ...environment, ...change }))
  }
  assert.throws(() => createLatencyReportOnly({ ...readiness, runtime: { ...readiness.runtime, version: 'v22.0.0' } }), /version/i)
  assert.throws(() => validateRunAdmission(options, { ...readiness, runtime: { ...readiness.runtime, version: 'v25.0.0' } },
    { ...environment, version: 'v25.0.0' }), /version/i)
})

test('latency portability privacy contract removes developer home literals from blocker owners', async () => {
  const owners = [
    'docs/worlds-command-latency.md',
    'docs/worlds-command-profile.md',
    'docs/worlds-engine-acceptance.md',
    'docs/worlds-engine-current-status.md',
    'scripts/worlds-command-latency.mjs',
    'scripts/worlds-command-profile.mjs',
    'scripts/worlds-command-storage-ab.mjs',
    'scripts/worlds-command-latency.test.mjs',
    'scripts/worlds-command-profile.test.mjs',
  ]
  const contents = new Map(await Promise.all(owners.map(async (owner) => [owner, await readFile(resolve(root, owner), 'utf8')])))
  const privateHomeLiteral = '/home/' + 'drhepa'
  for (const [owner, source] of contents) assert.equal(source.includes(privateHomeLiteral), false, owner)
  assert.match(contents.get('docs/worlds-command-latency.md'), /REPO_ROOT/)
  assert.match(contents.get('docs/worlds-command-latency.md'), /NODE24/)
  assert.match(contents.get('docs/worlds-command-profile.md'), /REPO_ROOT/)
  assert.match(contents.get('docs/worlds-command-profile.md'), /NODE24/)
  assert.match(contents.get('docs/worlds-engine-current-status.md'), /<observed-repo>/)
  assert.match(contents.get('docs/worlds-engine-current-status.md'), /host-specific evidence/i)
  assert.match(contents.get('docs/worlds-engine-acceptance.md'), /<observed-home>\/\.config\/Electron/)
})

test('latency actual read-only source inventory seals real builder Three closure without creating a workspace', async () => {
  const before = (await readdir('/tmp')).filter((name) => name.startsWith('modly-worlds-command-latency-new-')).sort()
  const inventory = await collectSourceManifest()
  const paths = inventory.sources.map((source) => source.path)
  for (const required of ['electron/main/world-project-repository.ts', 'src/areas/worlds/editor/worldEditorController.ts',
    'src/areas/worlds/worldProjectService.ts', 'src/areas/worlds/editor/worldAuthoringModel.ts',
    'src/areas/worlds/runtime/worldRuntimeEntityGraph.ts', 'node_modules/three/package.json',
    'node_modules/three/build/three.module.js', 'node_modules/three/build/three.core.js',
    'scripts/worlds-command-latency.mjs', 'scripts/worlds-command-latency.test.mjs', 'docs/worlds-command-latency.md', 'package-lock.json']) {
    assert.ok(paths.includes(required), required)
  }
  assert.equal(paths.some((path) => path.includes('worldRapierRuntime')), false)
  assert.match(inventory.sourceSealSha256, /^[a-f0-9]{64}$/)
  assert.equal(inventory.runtime.executable, await fsPromises.realpath(process.execPath))
  assert.equal(inventory.runtime.version, 'v24.14.1')
  assert.match(inventory.runtime.sha256, /^[a-f0-9]{64}$/)
  assert.equal(createLatencyReportOnly(inventory).proposedArgv[0], inventory.runtime.executable)
  assert.equal(inventory.sources.length, new Set(paths).size)
  assert.deepEqual((await readdir('/tmp')).filter((name) => name.startsWith('modly-worlds-command-latency-new-')).sort(), before)
})

test('latency canonical runner includes the suite in its actual bounded read-only plan without dispatch', async () => {
  const runner = await readFile(resolve(root, 'scripts/run-node-tests.mjs'), 'utf8')
  assert.equal(runner.split("join(repositoryRoot, 'scripts', 'worlds-command-latency.test.mjs')").length - 1, 1)
  assert.match(runner, /const MAX_TEST_FILES = 256/)
  assert.match(runner, /const MAX_WORLDS_TYPESCRIPT_TEST_FILES = 128/)
  const plan = await createNodeTestPlan()
  const entries = plan.filter((entry) => entry.file === 'scripts/worlds-command-latency.test.mjs')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].phase, 'mjs')
  assert.deepEqual(entries[0].args, ['--test', '--test-concurrency=1', 'scripts/worlds-command-latency.test.mjs'])
  assert.ok(plan.length <= 256)
  assert.equal(new Set(plan.map((entry) => entry.file)).size, plan.length)
})

const profileBase = resolve(root, 'docs/worlds-engine-evidence/2026-09-12/command-latency-cpu-profile')
const profileFilename = 'worlds-command-latency.cpuprofile'
const profileOwnerFilename = 'owned-cpu-profile.json'
const jsonLf = (value) => `${JSON.stringify(value, null, 2)}\n`
const hash = (value) => createHash('sha256').update(value).digest('hex')
async function profileFixture() {
  const path = await mkdtemp(`${profileBase}/attempt-test-`)
  await chmod(path, 0o700)
  const info = await lstat(path, { bigint: true })
  const owner = { schema: 'worlds-command-latency-cpu-profile-owner.v1', token: randomBytes(16).toString('hex'),
    path, uid: Number(info.uid), dev: String(info.dev), ino: String(info.ino), filename: profileFilename }
  const ownerPath = resolve(path, profileOwnerFilename)
  await writeFile(ownerPath, jsonLf(owner), { mode: 0o600, flag: 'wx' })
  return { path, owner, ownerPath, options: { diagnosticCpuProfileDir: path } }
}

test('latency diagnostic arguments accept only the exact final owned canonical directory option', () => {
  const path = `${profileBase}/attempt-test-arguments`
  assert.deepEqual(parseArguments(['--report-only', '--diagnostic-cpu-profile-dir', path]),
    { mode: 'report-only', sealSha256: null, diagnosticCpuProfileDir: path })
  assert.deepEqual(parseArguments(['--run', '--seal-sha256', seal, '--diagnostic-cpu-profile-dir', path]),
    { mode: 'run', sealSha256: seal, diagnosticCpuProfileDir: path })
  for (const bad of ['relative', '/tmp/attempt-test-arguments', profileBase, `${path}/child`,
    `${profileBase}/../attempt-test-arguments`, `${profileBase}//attempt-test-arguments`, `${path}/`, `${profileBase}/attempt-.`]) {
    assert.throws(() => parseArguments(['--report-only', '--diagnostic-cpu-profile-dir', bad]))
  }
  for (const args of [['--help', '--diagnostic-cpu-profile-dir', path],
    ['--report-only', '--diagnostic-cpu-profile-dir'], ['--report-only', '--diagnostic-cpu-profile-dir', path, '--diagnostic-cpu-profile-dir', path],
    ['--diagnostic-cpu-profile-dir', path, '--report-only']]) assert.throws(() => parseArguments(args))
})

test('latency diagnostic classification never turns profiled fast or slow samples into a latency win', () => {
  const diagnosticCpuProfile = { instrumentation: 'node-startup-cpu-profile' }
  for (const ns of ['1', '50000000', '999999999']) {
    const result = classifyObservation(rows(ns), { ...complete, diagnosticCpuProfile })
    assert.equal(result.status, 'DIAGNOSTIC_WORKLOAD_COMPLETE')
    assert.equal(result.exitCode, 0)
    assert.equal(result.allCommandsUnder50Ms, null); assert.equal(result.p95Under50Ms, null)
    assert.equal(result.profileArtifactStatus, 'PENDING_EXIT')
    assert.equal(result.sampleComparability, 'NON_COMPARABLE_DIAGNOSTIC')
    assert.equal(result.metrics.p95Ns, ns)
  }
  for (const change of [{ finished: false }, { functionalStatus: 'FAIL' }, { sourceStatus: 'FAIL' }, { cleanupStatus: 'FAIL' }]) {
    assert.equal(classifyObservation(rows('1'), { ...complete, diagnosticCpuProfile, ...change }).exitCode, 1)
  }
  assert.equal(classifyObservation(rows().slice(1), { ...complete, diagnosticCpuProfile }).status, 'INVALID_SAMPLES')
  assert.equal(classifyObservation(rows('1'), complete).status, 'PASS')
})

test('latency diagnostic actual collector seals owned descriptor flags without writes or application imports', async () => {
  const fixture = await profileFixture()
  const before = await readdir(fixture.path)
  const inventory = await collectSourceManifest(fixture.options)
  assert.ok(inventory.diagnosticCpuProfile, 'diagnostic descriptor required')
  assert.deepEqual(inventory.diagnosticCpuProfile.owner, fixture.owner)
  assert.equal(inventory.diagnosticCpuProfile.ownerFile.sha256, hash(await readFile(fixture.ownerPath)))
  assert.equal(inventory.diagnosticCpuProfile.instrumentation, 'node-startup-cpu-profile')
  assert.deepEqual(inventory.runtime.execArgv, ['--experimental-strip-types', ...(inventory.loader ? ['--loader', inventory.loader] : []),
    '--cpu-prof', `--cpu-prof-dir=${fixture.path}`, `--cpu-prof-name=${profileFilename}`])
  const defaultInventory = await collectSourceManifest()
  assert.equal(defaultInventory.diagnosticCpuProfile, undefined)
  assert.equal(defaultInventory.sourceSealSha256, hash(`${defaultInventory.tsv}${jsonLf(defaultInventory.runtime)}${jsonLf(SCENARIO)}`))
  assert.equal(inventory.sourceSealSha256, hash(`${inventory.tsv}${jsonLf(inventory.runtime)}${jsonLf(SCENARIO)}${jsonLf(inventory.diagnosticCpuProfile)}`))
  assert.notEqual(inventory.sourceSealSha256, defaultInventory.sourceSealSha256)
  assert.deepEqual(inventory.sources, defaultInventory.sources)
  assert.deepEqual(await readdir(fixture.path), before)
  assert.equal(SCENARIO.instrumentation, 'none'); assert.equal(SCENARIO.measuredBatches, 20)
  const changed = { ...fixture.owner, token: randomBytes(16).toString('hex') }
  await writeFile(fixture.ownerPath, jsonLf(changed))
  assert.notEqual((await collectSourceManifest(fixture.options)).sourceSealSha256, inventory.sourceSealSha256)
})

test('latency diagnostic actual admission binds exact options runtime flags and owner seal', async () => {
  const fixture = await profileFixture(), readiness = await collectSourceManifest(fixture.options)
  const options = { mode: 'run', sealSha256: readiness.sourceSealSha256, ...fixture.options }
  const environment = { cwd: root, executable: readiness.runtime.executable, version: process.version,
    execArgv: readiness.runtime.execArgv, nodeOptions: '', nodePath: '' }
  assert.doesNotThrow(() => validateRunAdmission(options, readiness, environment))
  assert.throws(() => validateRunAdmission({ ...options, diagnosticCpuProfileDir: `${fixture.path}-foreign` }, readiness, environment))
  assert.throws(() => validateRunAdmission({ mode: 'run', sealSha256: options.sealSha256 }, readiness, environment))
  for (const change of [{ execArgv: ['--experimental-strip-types'] }, { execArgv: [...environment.execArgv, '--inspect'] },
    { nodeOptions: '--cpu-prof' }, { nodePath: '/tmp/injected' }]) {
    assert.throws(() => validateRunAdmission(options, readiness, { ...environment, ...change }))
  }
})

test('latency diagnostic actual directory custody rejects mode inode uid symlink token and existing profile', async () => {
  for (const kind of ['mode', 'inode', 'uid', 'token', 'extra', 'oversize', 'owner-mode', 'owner-symlink', 'directory-symlink', 'profile']) {
    const fixture = await profileFixture()
    if (kind === 'mode') await chmod(fixture.path, 0o755)
    else if (kind === 'inode') { await rename(fixture.path, `${fixture.path}-retained`); await mkdir(fixture.path, { mode: 0o700 });
      await writeFile(fixture.ownerPath, jsonLf(fixture.owner), { mode: 0o600, flag: 'wx' }) }
    else if (kind === 'owner-mode') await chmod(fixture.ownerPath, 0o644)
    else if (kind === 'owner-symlink') { await rename(fixture.ownerPath, `${fixture.ownerPath}.retained`);
      await symlink(`${fixture.ownerPath}.retained`, fixture.ownerPath) }
    else if (kind === 'directory-symlink') { await rename(fixture.path, `${fixture.path}-retained`);
      await symlink(`${fixture.path}-retained`, fixture.path) }
    else if (kind === 'profile') await writeFile(resolve(fixture.path, profileFilename), '{}', { mode: 0o600, flag: 'wx' })
    else await writeFile(fixture.ownerPath, kind === 'oversize' ? ' '.repeat(4097) : jsonLf({ ...fixture.owner,
      ...(kind === 'uid' ? { uid: fixture.owner.uid + 1 } : kind === 'token' ? { token: 'bad' } : { extra: true }) }))
    await assert.rejects(collectSourceManifest(fixture.options), undefined, kind)
  }
})

test('latency diagnostic FIFO owner rejects without waiting for an external writer', { timeout: 7000 }, async () => {
  const fixture = await profileFixture()
  await rename(fixture.ownerPath, `${fixture.ownerPath}.retained`)
  await new Promise((resolve, reject) => execFile('/usr/bin/mkfifo', ['-m', '0600', '--', fixture.ownerPath],
    (error) => error ? reject(error) : resolve()))
  const info = await lstat(fixture.ownerPath)
  assert.equal(info.isFIFO(), true); assert.equal(info.mode & 0o7777, 0o600)
  const startedNs = process.hrtime.bigint(); let settled = false, timer, settledBeforeWriter, writerRequired = false, outcome
  const pending = collectSourceManifest(fixture.options).then(() => ({ accepted: true }),
    (error) => ({ accepted: false, name: error.name, message: error.message })).finally(() => { settled = true })
  try {
    settledBeforeWriter = await Promise.race([pending.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 2000) })])
  } finally {
    clearTimeout(timer)
    // Release only the invalid private pre-fix FIFO; no bytes written or fixture removed.
    if (!settled) {
      const writer = await open(fixture.ownerPath, constants.O_WRONLY | constants.O_NONBLOCK)
      try { writerRequired = true } finally { await writer.close() }
    }
    outcome = await pending
  }
  const observation = { settledBeforeWriter, writerRequired, elapsedNs: String(process.hrtime.bigint() - startedNs), outcome }
  await writeFile(resolve(fixture.path, 'fifo-observation.json'), jsonLf(observation), { mode: 0o600, flag: 'wx' })
  assert.equal(outcome.accepted, false); assert.match(outcome.message, /Unsafe or oversized CPU-profile owner file/)
  assert.equal(settledBeforeWriter, true, 'Collector stayed blocked until a private external writer released the FIFO.')
  assert.equal(writerRequired, false)
})

test('latency diagnostic hardlinked owner rejects its actual second filesystem link', async () => {
  const fixture = await profileFixture()
  await link(fixture.ownerPath, resolve(fixture.path, 'retained-hardlink.json'))
  assert.equal((await lstat(fixture.ownerPath)).nlink, 2)
  await assert.rejects(collectSourceManifest(fixture.options), /Unsafe or oversized CPU-profile owner file/)
})

const stageIdentity = { runId: 'stage-test', sourceSealSha256: seal, runtime: { version: 'v24.14.1', sha256: 'b'.repeat(64) } }
const documents = ['project.world-project.json', 'scenes/scene-0123456789abcdef0123456789abcdef.world-scene.json']
const checkpoints = ['root-lock-directory-created', 'after-package', 'backup-created', 'journal-published',
  ...documents.map((path) => `document-published:${path}`), 'state-published', 'removed-scenes-cleaned', 'journal-cleaned']
function stageObserver(runtime) {
  assert.equal(typeof stageHarness.createStageDiagnostic, 'function', 'Same-clock observation helper required.')
  return stageHarness.createStageDiagnostic(stageHarness.STAGE_DIAGNOSTIC, stageIdentity, runtime)
}
const plan = (index = 1) => ({ phase: 'measure', index, transactionId: `tx:stage:${index}`, documents })
function fakeRuntime() {
  let clock = 1000n, thread = 10, cpu = 100
  return { pid: 42, version: 'v24.14.1', hrtime: { bigint: () => (clock += 100n) },
    threadCpuUsage: () => ({ user: ++thread, system: ++thread }), cpuUsage: () => ({ user: ++cpu, system: ++cpu }) }
}

test('same-clock opt-in is sealed separately with null thresholds and no disabled wrappers', async () => {
  assert.deepEqual(parseArguments(['--report-only', '--diagnostic-stages']), { mode: 'report-only', sealSha256: null, diagnosticStages: true })
  assert.equal(parseArguments(['--run', '--seal-sha256', seal, '--diagnostic-stages']).diagnosticStages, true)
  for (const args of [['--help', '--diagnostic-stages'], ['--report-only', '--diagnostic-stages', '--diagnostic-stages'],
    ['--report-only', '--diagnostic-stages', '--diagnostic-cpu-profile-dir', `${profileBase}/attempt-test-mixed`]]) assert.throws(() => parseArguments(args))
  assert.equal(stageHarness.createStageDiagnostic(undefined, stageIdentity, {}), null)
  const source = await readFile(resolve(root, 'scripts/worlds-command-latency.mjs'), 'utf8')
  assert.match(source, /stageDiagnostic \? \{ getWorkspaceRoot: \(\) => workspace, \.\.\.stageDiagnostic.repositoryOptions \} : \{ getWorkspaceRoot: \(\) => workspace \}/)
  assert.match(source, /else \{ result = await pair.controller.dispatchCommands\(request, authority\) \}/)
  const inventory = await collectSourceManifest({ diagnosticStages: true })
  assert.equal(inventory.diagnosticStages.thresholdNs, null)
  assert.equal(inventory.diagnosticStages.sampleComparability, 'NON_COMPARABLE_DIAGNOSTIC')
  assert.equal(inventory.sourceSealSha256, hash(`${inventory.tsv}${jsonLf(inventory.runtime)}${jsonLf(SCENARIO)}${jsonLf(inventory.diagnosticStages)}`))
  assert.notEqual(inventory.sourceSealSha256, hash(`${inventory.tsv}${jsonLf(inventory.runtime)}${jsonLf(SCENARIO)}`))
  const options = { mode: 'run', sealSha256: inventory.sourceSealSha256, diagnosticStages: true }
  const environment = { cwd: root, executable: inventory.runtime.executable, version: process.version, execArgv: inventory.runtime.execArgv, nodeOptions: '', nodePath: '' }
  assert.doesNotThrow(() => validateRunAdmission(options, inventory, environment))
  assert.throws(() => validateRunAdmission({ ...options, diagnosticStages: undefined }, inventory, environment))
  for (const ns of ['1', '999999999']) {
    const result = classifyObservation(rows(ns), { ...complete, diagnosticStages: inventory.diagnosticStages, stageStatus: 'PASS' })
    assert.equal(result.status, 'DIAGNOSTIC_WORKLOAD_COMPLETE'); assert.equal(result.allCommandsUnder50Ms, null)
    assert.equal(result.p95Under50Ms, null); assert.equal(result.thresholdNs, null)
  }
  assert.equal(classifyObservation(rows(), { ...complete, diagnosticStages: inventory.diagnosticStages, stageStatus: 'FAIL' }).status, 'INVALID_DIAGNOSTIC')
  assert.equal(SCENARIO.instrumentation, 'none'); assert.equal(SCENARIO.thresholdNs, '50000000')
})

test('same-clock exact API admission rejects missing thread/process clocks without fallback', () => {
  assert.equal(typeof stageHarness.createStageDiagnostic, 'function', 'API admission must exercise the actual helper.')
  for (const key of ['threadCpuUsage', 'cpuUsage', 'hrtime']) {
    const runtime = fakeRuntime(); delete runtime[key]
    assert.throws(() => stageObserver(runtime))
  }
  assert.throws(() => stageObserver({ ...fakeRuntime(), version: 'v22.0.0' }))
  assert.equal(typeof process.threadCpuUsage, 'function')
  assert.ok(process.threadCpuUsage().user >= 0)
})

test('same-clock markers retain exact integers bracketing exclusive intervals and bounded association', async () => {
  const observer = stageObserver(fakeRuntime()), value = { ok: true, value: { durable: 'original' } }
  const repository = { async applyCommands() { for (const stage of checkpoints) observer.repositoryOptions.failureCheckpoint(stage); return value } }
  observer.installRepository(repository)
  assert.equal(await observer.dispatch(plan(), () => repository.applyCommands({ batch: { transactionId: plan().transactionId } })), value)
  const record = observer.takeRecord()
  assert.equal(record.status, 'PASS'); assert.equal(record.pid, 42); assert.equal(record.runId, stageIdentity.runId)
  assert.equal(record.sourceSealSha256, seal); assert.equal(record.nodeSha256, stageIdentity.runtime.sha256)
  assert.equal(record.transactionId, plan().transactionId)
  assert.deepEqual(record.markers.map((marker) => marker.stage), ['dispatch-start', 'repository-entry', ...checkpoints, 'repository-settled', 'dispatch-settled'])
  let sum = 0n
  for (const marker of record.markers) {
    assert.ok(BigInt(marker.thread.beforeNs) <= BigInt(marker.thread.afterNs))
    assert.ok(BigInt(marker.thread.afterNs) <= BigInt(marker.process.beforeNs))
    assert.ok(BigInt(marker.process.beforeNs) <= BigInt(marker.process.afterNs))
  }
  for (const [i, segment] of record.exclusive.entries()) {
    const left = record.markers[i], right = record.markers[i + 1]
    assert.equal(segment.wallNs, String(BigInt(right.ns) - BigInt(left.ns)))
    for (const scope of ['thread', 'process']) for (const kind of ['user', 'system']) assert.equal(segment[scope][kind], String(BigInt(right[scope][kind]) - BigInt(left[scope][kind])))
    sum += BigInt(segment.wallNs)
  }
  assert.equal(String(sum), String(BigInt(record.markers.at(-1).ns) - BigInt(record.markers[0].ns)))
  await assert.rejects(observer.dispatch(plan(), () => repository.applyCommands({ batch: { transactionId: plan().transactionId } })), /association/)
  await assert.rejects(observer.dispatch({ ...plan(2), index: 21 }, async () => value), /association/)
})

test('same-clock diagnostics never disguise original delayed success or rejection settlement', async () => {
  for (const rejects of [false, true]) {
    const observer = stageObserver(fakeRuntime()), originalError = new Error('original apply rejection')
    let release, settled = false
    const held = new Promise((resolve) => { release = resolve })
    const repository = { async applyCommands() { for (const stage of checkpoints) observer.repositoryOptions.failureCheckpoint(stage); await held; if (rejects) throw originalError; return 17 } }
    observer.installRepository(repository)
    const pending = observer.dispatch(plan(), () => repository.applyCommands({ batch: { transactionId: plan().transactionId } })).then((value) => ({ value }), (error) => ({ error })).finally(() => { settled = true })
    await Promise.resolve(); assert.equal(settled, false); assert.equal(observer.takeRecord(), null)
    release(); const outcome = await pending
    assert.equal(rejects ? outcome.error : outcome.value, rejects ? originalError : 17)
    const record = observer.takeRecord(); assert.equal(record.status, 'PASS'); assert.equal(record.repositoryOutcome, rejects ? 'rejected' : 'fulfilled')
    assert.equal(record.dispatchOutcome, rejects ? 'rejected' : 'fulfilled')
  }
  const observer = stageObserver(fakeRuntime()), value = { ok: true }
  let releaseDispatch, settled = false
  const adoption = new Promise((resolve) => { releaseDispatch = resolve })
  const repository = { async applyCommands() { for (const stage of checkpoints) observer.repositoryOptions.failureCheckpoint(stage); return value } }
  observer.installRepository(repository)
  const pending = observer.dispatch(plan(), async () => { await repository.applyCommands({ batch: { transactionId: plan().transactionId } }); await adoption; return value }).finally(() => { settled = true })
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false); assert.equal(observer.takeRecord(), null)
  releaseDispatch(); assert.equal(await pending, value)
  assert.equal(observer.takeRecord().markers.at(-1).stage, 'dispatch-settled')
  for (let index = 2; index <= 20; index++) {
    const outcome = { ok: false, error: { code: 'original_rejection' } }
    const rejected = { async applyCommands() { observer.repositoryOptions.failureCheckpoint('root-lock-directory-created'); return outcome } }
    observer.installRepository(rejected)
    assert.equal(await observer.dispatch(plan(index), () => rejected.applyCommands({ batch: { transactionId: plan(index).transactionId } })), outcome)
    assert.equal(observer.takeRecord().status, 'PASS')
  }
  await assert.rejects(observer.dispatch(plan(21), async () => value), /association/)
})

test('same-clock malformed missing duplicate unexpected and nonmonotonic markers fail explicitly after settlement', async () => {
  for (const kind of ['missing', 'duplicate', 'unexpected', 'transaction', 'negative-cpu', 'decreasing-cpu', 'api-throws', 'nonmonotonic', 'overflow']) {
    const runtime = fakeRuntime()
    if (kind === 'negative-cpu') runtime.cpuUsage = () => ({ user: -1, system: 0 })
    if (kind === 'decreasing-cpu') { let counter = 1000; runtime.threadCpuUsage = () => ({ user: --counter, system: 0 }) }
    if (kind === 'api-throws') runtime.cpuUsage = () => { throw undefined }
    if (kind === 'nonmonotonic') runtime.hrtime.bigint = () => 1n
    const observer = stageObserver(runtime), value = { ok: true }
    const repository = { async applyCommands() {
      for (const stage of kind === 'missing' ? checkpoints.slice(1) : checkpoints) observer.repositoryOptions.failureCheckpoint(stage)
      if (kind === 'duplicate') observer.repositoryOptions.failureCheckpoint('journal-cleaned')
      if (kind === 'unexpected') observer.repositoryOptions.failureCheckpoint('invented')
      if (kind === 'overflow') for (let i = 0; i < 60; i++) observer.repositoryOptions.failureCheckpoint('invented')
      return value
    } }
    observer.installRepository(repository)
    assert.equal(await observer.dispatch(plan(), () => repository.applyCommands({ batch: { transactionId: kind === 'transaction' ? 'wrong' : plan().transactionId } })), value)
    const record = observer.takeRecord(); assert.equal(record.status, 'FAIL', kind); assert.ok(record.error, kind)
    assert.ok(record.markers.length <= stageHarness.STAGE_DIAGNOSTIC.maxMarkers)
    assert.equal(record.exclusive, null)
  }
})

test('same-clock actual public default-sync small workspace retains publication order and durable reopen', async () => {
  const { build } = await import('esbuild')
  const directory = await mkdtemp('/tmp/modly-worlds-stage-unit-')
  const entry = resolve(root, 'electron/main/world-project-repository.ts'), outfile = resolve(directory, 'repository.mjs')
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { WorldProjectRepository } = await import(fileURLToPath(new URL(`file://${outfile}`)))
  const observer = stageObserver(process)
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => directory, ...observer.repositoryOptions })
  observer.installRepository(repository)
  const created = success(await repository.create({ name: 'Small diagnostic', initialSceneName: 'Scene' }))
  const snapshot = created.snapshot, transactionId = plan().transactionId
  const actualPlan = { ...plan(), documents: ['project.world-project.json', `scenes/${snapshot.project.scenes[0].documentPath.split('/').at(-1)}`] }
  const batch = { schema: 'modly.world-command-batch.v1', transactionId, projectId: snapshot.project.projectId, baseRevision: 0, origin: 'ui', commands: [{ type: 'rename-project', name: 'Durably renamed' }] }
  const applied = success(await observer.dispatch(actualPlan, () => repository.applyCommands({ projectKey: created.projectKey, batch })))
  const record = observer.takeRecord(); assert.equal(record.status, 'PASS', JSON.stringify(record.error))
  const reopened = success(await new WorldProjectRepository({ getWorkspaceRoot: () => directory }).open({ projectKey: created.projectKey }))
  assert.deepEqual(reopened.snapshot, applied.snapshot); assert.equal(reopened.snapshot.project.name, 'Durably renamed')
  const projectRoot = resolve(directory, 'Worlds', created.projectKey)
  await assert.rejects(lstat(resolve(projectRoot, '.modly/journal.v1.json')), { code: 'ENOENT' })
  const state = JSON.parse(await readFile(resolve(projectRoot, '.modly/state.v1.json'), 'utf8'))
  assert.equal(state.committedRevision, 1); assert.equal(state.transactions[0].transactionId, transactionId)
  await writeFile(resolve(directory, 'stage-integration-evidence.json'), jsonLf({ record, applied, reopened, state }), { mode: 0o600, flag: 'wx' })
})

test('same-clock hostile observer errors preserve held original success and rejection identities', async () => {
  const witnesses = []
  const cases = [
    ['null-prototype', () => Object.create(null)],
    ['message-getter', () => Object.defineProperty({}, 'message', { get() { throw new Error('message access failed') } })],
    ['coercion', () => ({ [Symbol.toPrimitive]() { throw new Error('coercion failed') } })],
    ['proxy', () => new Proxy({}, { get() { throw new Error('proxy access failed') } })],
    ['oversize-message', () => ({ message: 'x'.repeat(10000) })],
  ]
  for (const [kind, makeError] of cases) for (const rejects of [false, true]) {
    const runtime = fakeRuntime(), originalCpu = runtime.cpuUsage
    let cpuCalls = 0, releaseApply, releaseDispatch, enteredHold = false, applySettled = false, settled = false
    runtime.cpuUsage = () => { if (++cpuCalls === 3) throw makeError(); return originalCpu() }
    const observer = stageObserver(runtime), value = { ok: true, original: kind }, originalError = new Error(`held original ${kind}`)
    const held = new Promise((resolve) => { releaseApply = resolve }), adoption = new Promise((resolve) => { releaseDispatch = resolve })
    const repository = { async applyCommands() {
      for (const stage of checkpoints) observer.repositoryOptions.failureCheckpoint(stage)
      enteredHold = true; await held; applySettled = true
      if (rejects) throw originalError
      return value
    } }
    observer.installRepository(repository)
    const pending = observer.dispatch(plan(), async () => {
      let outcome, rejection
      try { outcome = await repository.applyCommands({ batch: { transactionId: plan().transactionId } }) } catch (error) { rejection = error }
      await adoption
      if (rejection) throw rejection
      return outcome
    }).then((result) => ({ result }), (error) => ({ error })).finally(() => { settled = true })
    for (let index = 0; index < 8; index++) await Promise.resolve()
    const beforeRelease = { enteredHold, applySettled, settled, recordPending: observer.takeRecord() === null }
    releaseApply(); for (let index = 0; index < 8; index++) await Promise.resolve()
    const afterApply = { applySettled, settled, recordPending: observer.takeRecord() === null }
    releaseDispatch(); const outcome = await pending, record = observer.takeRecord()
    witnesses.push({ kind, rejects, cpuCalls, beforeRelease, afterApply,
      identityPreserved: rejects ? outcome.error === originalError : outcome.result === value, record })
  }
  const directory = await mkdtemp('/tmp/modly-worlds-stage-hostile-errors-')
  await writeFile(resolve(directory, 'witnesses.json'), jsonLf(witnesses), { flag: 'wx', mode: 0o600 })
  for (const witness of witnesses) {
    assert.deepEqual(witness.beforeRelease, { enteredHold: true, applySettled: false, settled: false, recordPending: true }, `${witness.kind}: original hold must be reached`)
    assert.deepEqual(witness.afterApply, { applySettled: true, settled: false, recordPending: true }, `${witness.kind}: original controller must remain pending`)
    assert.equal(witness.identityPreserved, true, witness.kind); assert.equal(witness.cpuCalls, checkpoints.length + 4)
    assert.equal(witness.record.status, 'FAIL', witness.kind); assert.equal(witness.record.exclusive, null)
    assert.equal(typeof witness.record.error, 'string'); assert.ok(witness.record.error.length > 0 && witness.record.error.length <= 512)
    assert.equal(witness.record.markers.at(-1).stage, 'dispatch-settled')
  }
})

// The baseline fallback exercises the incumbent exported observer, not an absent-helper RED.
const nestedObserver = (runtime = fakeRuntime()) => stageHarness.createStageDiagnostic(
  stageHarness.NESTED_BACKUP_DIAGNOSTIC ?? stageHarness.STAGE_DIAGNOSTIC, stageIdentity, runtime)
const nestedPair = ['backup-final-verification-entry', 'backup-final-verification-settled']
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function nestedRepository(observer, verify, stages = checkpoints) {
  const repository = {
    async verifyBackupPackage(...args) { assert.equal(this, repository); return verify(...args) },
    async createBackup(...args) { assert.equal(this, repository); return await this.verifyBackupPackage(...args) },
    async applyCommands() {
      assert.equal(this, repository)
      for (const stage of stages.slice(0, 2)) observer.repositoryOptions.failureCheckpoint(stage)
      const value = await this.createBackup('private-argument')
      for (const stage of stages.slice(2)) observer.repositoryOptions.failureCheckpoint(stage)
      return value
    },
  }
  observer.installRepository(repository); return repository
}
const nestedStages = (record) => record.markers.map((marker) => marker.stage).filter((stage) => stage.startsWith('backup-final-'))

test('nested backup proof preserves held verifier and controller success false falsy and rejection identities', async () => {
  const directory = await mkdtemp('/tmp/modly-worlds-nested-held-'), witnesses = []
  for (const rejects of [false, true]) for (const value of [17, false, 0, null, undefined, new Error('original')]) {
    const observer = nestedObserver(); let release, releaseController, calls = 0, settled = false
    const hold = new Promise((resolve) => { release = resolve }), adoption = new Promise((resolve) => { releaseController = resolve })
    const repository = nestedRepository(observer, async (argument) => { calls++; assert.equal(argument, 'private-argument'); await hold; if (rejects) throw value; return value })
    const pending = observer.dispatch(plan(), async () => {
      let outcome, rejected = false
      try { outcome = await repository.applyCommands({ batch: { transactionId: plan().transactionId } }) }
      catch (error) { rejected = true; outcome = error }
      await adoption; if (rejected) throw outcome; return outcome
    }).then((result) => ({ rejected: false, result }), (error) => ({ rejected: true, result: error })).finally(() => { settled = true })
    await tick(); assert.equal(calls, 1); assert.equal(settled, false); assert.equal(observer.takeRecord(), null)
    release(); await tick(); assert.equal(settled, false); assert.equal(observer.takeRecord(), null)
    releaseController(); const outcome = await pending, record = observer.takeRecord()
    witnesses.push({ rejects, valueKind: value === null ? 'null' : typeof value, calls, identity: outcome.result === value, record })
    assert.equal(outcome.rejected, rejects); assert.equal(outcome.result, value); assert.equal(record.status, 'PASS', record.error)
    assert.deepEqual(nestedStages(record), nestedPair); assert.doesNotMatch(JSON.stringify(record), /private-argument/)
    const start = record.markers.findIndex((marker) => marker.stage === 'after-package')
    const end = record.markers.findIndex((marker) => marker.stage === (rejects ? 'repository-settled' : 'backup-created'))
    assert.equal(record.exclusive.slice(start, end).reduce((sum, segment) => sum + BigInt(segment.wallNs), 0n), BigInt(record.markers[end].ns) - BigInt(record.markers[start].ns))
  }
  await writeFile(resolve(directory, 'witnesses.json'), jsonLf(witnesses), { flag: 'wx', mode: 0o600 })
  process.stdout.write(`nested-held-fixture:${directory}\n`)
})

test('nested backup proof excludes unrelated async scopes and faults duplicate reentrant concurrent prefixes', async () => {
  for (const kind of ['ordinary', 'duplicate', 'reentrant', 'concurrent']) {
    const observer = nestedObserver(); let release, entered, calls = 0, measuring = false
    const hold = new Promise((resolve) => { release = resolve }), entry = new Promise((resolve) => { entered = resolve })
    const repository = nestedRepository(observer, async () => { calls++; entered(); if (measuring) await hold; return 19 })
    const originalCreate = repository.createBackup
    if (kind !== 'ordinary') repository.createBackup = async function (...args) {
      if (kind === 'duplicate') { await originalCreate.apply(this, args); return originalCreate.apply(this, args) }
      if (kind === 'concurrent') return (await Promise.all([originalCreate.apply(this, args), originalCreate.apply(this, args)]))[0]
      return originalCreate.apply(this, args)
    }
    if (kind === 'reentrant') { const originalVerify = repository.verifyBackupPackage; repository.verifyBackupPackage = async function (...args) { if (calls === 0) { calls++; await originalCreate.apply(this, args) } return originalVerify.apply(this, args) } }
    await repository.verifyBackupPackage(); // Inactive open/load/list-like verification has no record.
    calls = 0; measuring = true
    const pending = observer.dispatch(plan(), () => repository.applyCommands({ batch: { transactionId: plan().transactionId } }))
    await entry; await tick(); const unrelatedVerify = repository.verifyBackupPackage(), unrelatedBackup = originalCreate.call(repository)
    release(); await unrelatedVerify; await unrelatedBackup; await pending
    const record = observer.takeRecord()
    assert.equal(record.status, kind === 'ordinary' ? 'PASS' : 'FAIL', `${kind}: ${record.error}`)
    if (kind === 'ordinary') assert.deepEqual(nestedStages(record), nestedPair)
    assert.ok(record.markers.length <= 48)
  }
})

test('nested backup proof contains clock CPU getters result observers unknown markers and install faults', async () => {
  for (const rejects of [false, true]) {
    const observer = nestedObserver(), originalError = new Error('late original'); let release, originalPending
    const hold = new Promise((resolve) => { release = resolve }), repository = nestedRepository(observer, async () => { await hold; if (rejects) throw originalError; return 19 })
    assert.equal(await observer.dispatch(plan(), () => { originalPending = repository.applyCommands({ batch: { transactionId: plan().transactionId } }).then((value) => ({ value }), (error) => ({ error })); return 19 }), 19)
    assert.equal(observer.takeRecord().status, 'FAIL'); release(); const outcome = await originalPending; assert.equal(rejects ? outcome.error : outcome.value, rejects ? originalError : 19)
    assert.equal(observer.takeRecord(), null)
  }
  for (const kind of ['cpu-getter', 'clock-coercion', 'result-getter', 'unknown', 'overflow', 'missing-method', 'method-getter']) {
    const runtime = fakeRuntime(), originalCpu = runtime.cpuUsage; let cpuCalls = 0
    if (kind === 'cpu-getter') runtime.cpuUsage = () => ++cpuCalls === 5 ? Object.defineProperty({}, 'user', { get() { throw Object.create(null) } }) : originalCpu()
    if (kind === 'clock-coercion') { const originalClock = runtime.hrtime.bigint; let clockCalls = 0; runtime.hrtime.bigint = () => ++clockCalls === 25 ? { [Symbol.toPrimitive]() { throw null } } : originalClock() }
    const observer = nestedObserver(runtime), value = kind === 'result-getter' ? Object.defineProperty({}, 'ok', { get() { throw false } }) : 19
    const repository = nestedRepository(observer, async () => value)
    if (kind === 'missing-method' || kind === 'method-getter') { const missing = { async applyCommands() { return value } }; if (kind === 'method-getter') Object.defineProperty(missing, 'createBackup', { get() { throw new Proxy({}, { get() { throw undefined } }) } }); assert.equal(observer.installRepository(missing), false); assert.equal(await observer.dispatch(plan(), () => missing.applyCommands({ batch: { transactionId: plan().transactionId } })), value) }
    else assert.equal(await observer.dispatch(plan(), async () => {
      const result = await repository.applyCommands({ batch: { transactionId: plan().transactionId } })
      if (kind === 'unknown' || kind === 'overflow') for (let i = 0; i < (kind === 'overflow' ? 60 : 1); i++) observer.repositoryOptions.failureCheckpoint('unknown-literal')
      return result
    }), value)
    const record = observer.takeRecord(); assert.equal(record.status, 'FAIL', kind); assert.equal(record.exclusive, null)
    assert.equal(typeof record.error, 'string'); assert.ok(record.error.length <= 512); assert.ok(record.markers.length <= 48)
    if (kind === 'unknown') assert.ok(record.markers.some((marker) => marker.stage === 'unknown-literal'))
  }
})

test('nested backup proof flag is distinct mutually exclusive and admission cannot reuse v1 grammar', async () => {
  assert.deepEqual(parseArguments(['--report-only', '--diagnostic-nested-backup']), { mode: 'report-only', sealSha256: null, diagnosticNestedBackup: true })
  for (const flags of [['--diagnostic-stages', '--diagnostic-nested-backup'], ['--diagnostic-nested-backup', '--diagnostic-stages'], ['--diagnostic-nested-backup', '--diagnostic-nested-backup'], ['--diagnostic-nested-backup', '--diagnostic-cpu-profile-dir', `${profileBase}/attempt-test-mixed`]]) assert.throws(() => parseArguments(['--report-only', ...flags]))
  assert.equal(stageHarness.STAGE_DIAGNOSTIC.schema, 'worlds-command-stage-diagnostic.v1')
  assert.equal(stageHarness.NESTED_BACKUP_DIAGNOSTIC.schema, 'worlds-command-stage-diagnostic.v2')
  assert.equal(stageHarness.NESTED_BACKUP_DIAGNOSTIC.maxMarkers, 48); assert.equal(stageHarness.NESTED_BACKUP_DIAGNOSTIC.maxDispatches, 20)
  assert.equal(stageHarness.NESTED_BACKUP_DIAGNOSTIC.thresholdNs, null); assert.equal(stageHarness.NESTED_BACKUP_DIAGNOSTIC.gainAcceptance, null)
  const readiness = { sourceSealSha256: seal, runtime: { executable: fixedNode, version: 'v24.14.1',
    execArgv: ['--experimental-strip-types'] }, diagnosticStages: stageHarness.NESTED_BACKUP_DIAGNOSTIC }
  const environment = { cwd: root, executable: readiness.runtime.executable, version: process.version, execArgv: readiness.runtime.execArgv, nodeOptions: '', nodePath: '' }
  assert.doesNotThrow(() => validateRunAdmission({ mode: 'run', sealSha256: seal, diagnosticNestedBackup: true }, readiness, environment))
  assert.throws(() => validateRunAdmission({ mode: 'run', sealSha256: seal, diagnosticStages: true }, readiness, environment))
  const observer = nestedObserver(), repository = nestedRepository(observer, async () => 19)
  for (let index = 1; index <= 20; index++) { assert.equal(await observer.dispatch(plan(index), () => repository.applyCommands({ batch: { transactionId: plan(index).transactionId } })), 19); assert.equal(observer.takeRecord().status, 'PASS') }
  await assert.rejects(observer.dispatch(plan(21), async () => 19), /association/)
  const manyDocuments = ['project.world-project.json', ...Array.from({ length: 31 }, (_, i) => `scenes/scene-${String(i).padStart(32, '0')}.world-scene.json`)]
  const bounded = nestedObserver(), many = nestedRepository(bounded, async () => 19, [...checkpoints.slice(0, 4), ...manyDocuments.map((path) => `document-published:${path}`), ...checkpoints.slice(-3)])
  await bounded.dispatch({ ...plan(), documents: manyDocuments }, () => many.applyCommands({ batch: { transactionId: plan().transactionId } })); const record = bounded.takeRecord(); assert.equal(record.status, 'PASS'); assert.equal(record.markers.length, 45)
})

test('nested backup proof actual public default-sync two-scene OFF ON physical byte and phase parity', async () => {
  const { build } = await import('esbuild'), directory = await mkdtemp('/tmp/modly-worlds-nested-parity-')
  const entry = resolve(directory, 'entry.mjs'), outfile = resolve(directory, 'runtime.mjs')
  await writeFile(entry, ['electron/main/world-project-repository.ts', 'src/areas/worlds/worldProjectService.ts', 'src/areas/worlds/editor/worldEditorController.ts', 'src/areas/worlds/editor/worldEditorCommandBuilders.ts'].map((path) => `export * from ${JSON.stringify(resolve(root, path))}`).join('\n'))
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const api = await import(`file://${outfile}`), lanes = []
  for (const enabled of [false, true]) {
    const workspace = resolve(directory, enabled ? 'on' : 'off'); await mkdir(workspace)
    const observer = enabled ? nestedObserver(process) : null, trace = [], phases = [], hashPhases = {}, verificationHashes = []; let phase = 'start', hashes = 0, appliedResult, observing = false
    const repository = new api.WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => `world-${'a'.repeat(32)}`, createSceneKey: () => `scene-${'b'.repeat(32)}`, now: () => new Date('2026-09-02T00:00:00.000Z'), failureCheckpoint(stage) { phase = stage; phases.push(stage); if (observing) trace.push({ phase, op: 'checkpoint', path: '@checkpoint', state: 'settled' }); observer?.repositoryOptions.failureCheckpoint(stage) } })
    for (const op of ['createBackup', 'verifyBackupPackage']) { const original = repository[op]; repository[op] = async function (...args) {
      const path = resolve(args[0], args[2]), startHashes = hashes, startPhase = phase
      if (observing) event(op, path, 'entry')
      try { return await original.apply(this, args) } finally { if (observing) { event(op, path, 'settled'); if (op === 'verifyBackupPackage') verificationHashes.push({ phase: startPhase, hashes: hashes - startHashes }) } }
    } }
    if (observer) observer.installRepository(repository)
    const originalApply = repository.applyCommands; repository.applyCommands = async function (...args) { appliedResult = await originalApply.apply(this, args); return appliedResult }
    const service = api.createWorldProjectService(repository), controller = api.createWorldEditorController(service)
    const created = success(await service.create({ name: 'Nested parity', initialSceneName: 'One', projectId: 'project:nested-parity', initialSceneId: 'scene:nested-one' })); success(await controller.openProject(created.projectKey))
    success(await controller.dispatchCommands({ transactionId: 'tx:nested:seed', origin: 'ui', commands: api.buildAddSceneCommands({ snapshot: created.snapshot, projectKey: created.projectKey, identities: api.createDeterministicWorldEditorIdentityGenerator('nested-parity') }, { name: 'Two' }) }))
    const before = structuredClone(controller.getState()), request = { transactionId: plan().transactionId, origin: 'ui', commands: [{ type: 'rename-project', name: 'Nested renamed' }] }
    const authority = { projectKey: created.projectKey, projectId: before.session.snapshot.project.projectId, baseRevision: 1, activeSceneId: before.activeSceneId }
    const actualPlan = { ...plan(), documents: ['project.world-project.json', ...before.session.snapshot.project.scenes.map((scene) => `scenes/${scene.documentPath.split('/').at(-1)}`).sort()] }
    phases.length = 0; phase = 'start'; observing = true
    const saved = { open: fsPromises.open, readFile: fsPromises.readFile, writeFile: fsPromises.writeFile, createHash: crypto.createHash }
    const semantic = (path) => relative(workspace, String(path)).replace(/\.tmp-[a-f0-9]{24}/g, '.tmp-TOKEN')
    const event = (op, path, state) => trace.push({ phase, op, path: semantic(path), state })
    try {
      for (const op of ['readFile', 'writeFile']) fsPromises[op] = async function (path, ...args) { event(op, path, 'entry'); const value = await saved[op].call(this, path, ...args); event(op, path, 'settled'); return value }
      fsPromises.open = async function (path, ...args) {
        event('open', path, 'entry'); const handle = await saved.open.call(this, path, ...args); event('open', path, 'settled')
        for (const op of ['read', 'write', 'writeFile', 'sync', 'close']) { const original = handle[op]; handle[op] = async function (...parameters) { event(op, path, 'entry'); const value = await original.apply(this, parameters); event(op, path, 'settled'); return value } }
        return handle
      }
      crypto.createHash = function (...args) { hashes++; hashPhases[phase] = (hashPhases[phase] ?? 0) + 1; return saved.createHash.apply(this, args) }; syncBuiltinESMExports()
      const result = enabled ? await observer.dispatch(actualPlan, () => controller.dispatchCommands(request, authority)) : await controller.dispatchCommands(request, authority)
      success(result); lanes.push({ enabled, before, request, authority, result, appliedResult, after: structuredClone(controller.getState()), hashes, hashPhases, verificationHashes, trace, phases: [...phases], record: observer?.takeRecord() ?? null })
    } finally { observing = false; Object.assign(fsPromises, { open: saved.open, readFile: saved.readFile, writeFile: saved.writeFile }); crypto.createHash = saved.createHash; syncBuiltinESMExports() }
    const lane = lanes.at(-1), projectRoot = resolve(workspace, 'Worlds', created.projectKey)
    lane.reopened = success(await new api.WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: created.projectKey }))
    lane.state = JSON.parse(await readFile(resolve(projectRoot, '.modly/state.v1.json'), 'utf8'))
    const backupRoot = resolve(projectRoot, lane.state.lastValidBackup), index = JSON.parse(await readFile(resolve(backupRoot, 'transactions.index.v1.json'), 'utf8')), pack = await readFile(resolve(backupRoot, 'transactions.pack.v1'))
    lane.index = index; lane.packHex = pack.toString('hex'); assert.equal(index.pack.sha256, hash(pack)); assert.equal(index.pack.byteLength, pack.length); assert.equal(index.entries.length, 1)
    const entry = index.entries[0], primary = resolve(projectRoot, '.modly/transactions', entry.transactionDigest, 'after/result.v1.json'), primaryBytes = await readFile(primary)
    assert.equal(entry.offset, 0); assert.equal(entry.length, pack.length); assert.equal(entry.resultSha256, hash(primaryBytes)); assert.deepEqual(pack, primaryBytes)
    const packStat = await lstat(resolve(backupRoot, 'transactions.pack.v1')), primaryStat = await lstat(primary); assert.notEqual(`${packStat.dev}:${packStat.ino}`, `${primaryStat.dev}:${primaryStat.ino}`)
    lane.bytes = {}; async function tree(path) { for (const name of (await readdir(path)).sort()) { const child = resolve(path, name); if ((await lstat(child)).isDirectory()) await tree(child); else lane.bytes[relative(projectRoot, child)] = (await readFile(child)).toString('hex') } }; await tree(projectRoot)
    const corrupted = Buffer.from(pack); corrupted[0] ^= 1; await chmod(resolve(backupRoot, 'transactions.pack.v1'), 0o600); await writeFile(resolve(backupRoot, 'transactions.pack.v1'), corrupted)
    assert.deepEqual(await readFile(primary), primaryBytes); const primaryAfter = await lstat(primary); assert.equal(primaryAfter.ino, primaryStat.ino); assert.equal(primaryAfter.dev, primaryStat.dev)
    lane.independence = { preCorruptionPackHash: hash(pack), corruptedPackHash: hash(corrupted), primaryBeforeHash: hash(primaryBytes), primaryAfterHash: hash(await readFile(primary)), primaryIdentityPreserved: true }
    await writeFile(resolve(directory, `${enabled ? 'on' : 'off'}.json`), jsonLf(lane), { flag: 'wx', mode: 0o600 })
  }
  const [off, on] = lanes
  for (const key of ['before', 'request', 'authority', 'result', 'appliedResult', 'after', 'reopened', 'state', 'index', 'packHex', 'bytes', 'independence', 'hashes', 'hashPhases', 'verificationHashes', 'phases']) assert.deepEqual(on[key], off[key], key)
  // Preserve per-path chronological order across awaited phase barriers, not incidental parallel-path completion order.
  const orderedPaths = (trace) => { const paths = {}; for (const event of trace) (paths[event.path] ??= []).push([event.phase, event.op, event.state]); return Object.fromEntries(Object.entries(paths).sort()) }
  assert.deepEqual(orderedPaths(on.trace), orderedPaths(off.trace)); assert.ok(on.hashes > 0)
  for (const lane of lanes) { const syncs = lane.trace.filter((event) => event.op === 'sync' && event.state === 'settled'); assert.ok(syncs.some((event) => event.path.endsWith('/scenes') && event.phase === 'after-package')); assert.ok(syncs.some((event) => event.path.endsWith('/transactions.pack.v1') && event.phase === 'after-package')); assert.equal(lane.after.session.snapshot.project.revision, 2) }
  for (const lane of lanes) {
    const verificationEntry = lane.trace.findIndex((event) => event.op === 'verifyBackupPackage' && event.phase === 'after-package' && event.state === 'entry')
    const verificationSettled = lane.trace.findIndex((event) => event.op === 'verifyBackupPackage' && event.phase === 'after-package' && event.state === 'settled')
    const packClosed = lane.trace.findIndex((event) => event.op === 'close' && event.path.endsWith('/transactions.pack.v1') && event.phase === 'after-package' && event.state === 'settled')
    const backupCreated = lane.trace.findIndex((event) => event.op === 'checkpoint' && event.phase === 'backup-created')
    assert.ok(packClosed >= 0 && packClosed < verificationEntry && verificationEntry < verificationSettled && verificationSettled < backupCreated)
    assert.ok(lane.trace.slice(0, verificationEntry).some((event) => event.op === 'close' && event.state === 'settled' && event.phase === 'after-package' && event.path.endsWith('/.modly/backups')))
    assert.ok(lane.verificationHashes.find((entry) => entry.phase === 'after-package').hashes > 0)
  }
  assert.equal(off.record, null); assert.equal(on.record.status, 'PASS', on.record.error); assert.deepEqual(nestedStages(on.record), nestedPair); assert.equal(on.record.markers.length, 16)
  process.stdout.write(`nested-parity-fixture:${directory}\n`)
})

test('nested admission contains observer-only apply binding failures before installing any wrapper', async () => {
  const directory = await mkdtemp('/tmp/modly-worlds-nested-admission-'), witnesses = []
  const cases = [
    ...[false, 0, null, undefined, new Error('binding getter')].map((value, index) => [`bind-getter-${index}`, ({ originalApply }) => Object.defineProperty(originalApply, 'bind', { get() { throw value } })]),
    ['bind-call', ({ originalApply }) => Object.defineProperty(originalApply, 'bind', { value() { throw false } })],
    ['bind-not-callable', ({ originalApply }) => Object.defineProperty(originalApply, 'bind', { value: 0 })],
    ['bind-result-not-callable', ({ originalApply }) => Object.defineProperty(originalApply, 'bind', { value() { return false } })],
    ['apply-getter', ({ repository, originalApply, armed }) => Object.defineProperty(repository, 'applyCommands', { get() { if (armed()) throw false; return originalApply } })],
    ['apply-missing', ({ repository, originalApply, armed }) => Object.defineProperty(repository, 'applyCommands', { get() { return armed() ? undefined : originalApply } })],
    ['hostile-detail', ({ originalApply, coerced }) => Object.defineProperty(originalApply, 'bind', { get() { throw { get message() { throw false }, [Symbol.toPrimitive]() { coerced(); throw new Error('must not coerce') } } } })],
  ]
  for (const [kind, configure] of cases) {
    const observer = nestedObserver(); let originalCalls = 0, observing = false, coercions = 0
    const repository = { async createBackup() { return true }, async verifyBackupPackage() { return true } }
    const originalCreate = repository.createBackup, originalVerify = repository.verifyBackupPackage
    const originalApply = async function () { assert.equal(this, repository); originalCalls++; return 17 }
    repository.applyCommands = originalApply
    configure({ repository, originalApply, armed: () => observing, coerced: () => { coercions++ } })
    assert.equal(await repository.applyCommands(), 17)
    let escaped = false, thrown, installed
    observing = true
    try { installed = observer.installRepository(repository) } catch (error) { escaped = true; thrown = error } finally { observing = false }
    let afterOutcome, afterEscaped = false
    try { afterOutcome = await repository.applyCommands() } catch { afterEscaped = true }
    const unwrapped = repository.applyCommands === originalApply && repository.createBackup === originalCreate && repository.verifyBackupPackage === originalVerify
    assert.equal(await observer.dispatch(plan(), async () => 17), 17)
    const record = observer.takeRecord()
    witnesses.push({ kind, escaped, thrown: typeof thrown === 'object' && thrown !== null ? 'object' : thrown, installed: installed ?? null, originalCalls, originalOutcomePreserved: !afterEscaped && afterOutcome === 17, afterEscaped, afterOutcome, unwrapped, coercions, record })
  }
  await writeFile(resolve(directory, 'admission-witnesses.json'), jsonLf(witnesses), { flag: 'wx', mode: 0o600 })
  process.stdout.write(`nested-admission-fixture:${directory}\n`)
  for (const witness of witnesses) {
    assert.equal(witness.escaped, false, `${witness.kind}: Observer-specific binding escaped instead of contained admission failure.`)
    assert.equal(witness.installed, false, witness.kind); assert.equal(witness.originalOutcomePreserved, true, witness.kind); assert.equal(witness.originalCalls, 2); assert.equal(witness.unwrapped, true, witness.kind); assert.equal(witness.coercions, 0)
    assert.equal(witness.record.status, 'FAIL'); assert.equal(typeof witness.record.error, 'string'); assert.ok(witness.record.error.startsWith('Nested method admission failed:') && witness.record.error.length <= 512)
  }
  // V1 intentionally preserves the incumbent uncontained getter failure behavior.
  const v1 = stageObserver(fakeRuntime()); let v1Calls = 0, v1Escaped = false, v1Thrown
  const v1Repository = { applyCommands: async function () { assert.equal(this, v1Repository); v1Calls++; return 17 } }
  Object.defineProperty(v1Repository.applyCommands, 'bind', { get() { throw false } })
  assert.equal(await v1Repository.applyCommands(), 17)
  try { v1.installRepository(v1Repository) } catch (error) { v1Escaped = true; v1Thrown = error }
  assert.equal(await v1Repository.applyCommands(), 17); assert.equal(v1Escaped, true); assert.equal(v1Thrown, false); assert.equal(v1Calls, 2)
})

test('nested captured originals bypass own apply call getters and successful bind substitution', async () => {
  const directory = await mkdtemp('/tmp/modly-worlds-nested-invocation-'), witnesses = []
  for (const method of ['createBackup', 'verifyBackupPackage', 'bind-substitution']) {
    const observer = nestedObserver(); let createCalls = 0, verifyCalls = 0, applyCalls = 0, getterCalls = 0, substituteCalls = 0, bindCalls = 0
    const repository = {
      async verifyBackupPackage(argument) { assert.equal(this, repository); assert.equal(argument, 'private-argument'); verifyCalls++; return 17 },
      async createBackup(argument) { assert.equal(this, repository); createCalls++; return await this.verifyBackupPackage(argument) },
      async applyCommands() { assert.equal(this, repository); applyCalls++; for (const stage of checkpoints.slice(0, 2)) observer.repositoryOptions.failureCheckpoint(stage); const value = await this.createBackup('private-argument'); for (const stage of checkpoints.slice(2)) observer.repositoryOptions.failureCheckpoint(stage); return value },
    }
    const originals = { applyCommands: repository.applyCommands, createBackup: repository.createBackup, verifyBackupPackage: repository.verifyBackupPackage }
    if (method === 'bind-substitution') Object.defineProperty(originals.applyCommands, 'bind', { value() { bindCalls++; return async () => { substituteCalls++; return 99 } } })
    else for (const key of ['apply', 'call']) Object.defineProperty(originals[method], key, { get() { getterCalls++; throw false } })
    const before = await repository.applyCommands(), installed = observer.installRepository(repository)
    let observedRejected = false, observedOutcome, inactiveRejected = false, inactiveOutcome
    try { observedOutcome = await observer.dispatch(plan(), () => repository.applyCommands({ batch: { transactionId: plan().transactionId } })) } catch (error) { observedRejected = true; observedOutcome = error }
    const record = observer.takeRecord()
    try { inactiveOutcome = await repository.createBackup('private-argument') } catch (error) { inactiveRejected = true; inactiveOutcome = error }
    Object.assign(repository, originals); const after = await repository.applyCommands()
    witnesses.push({ method, before, after, installed, observedRejected, observedOutcome, inactiveRejected, inactiveOutcome, createCalls, verifyCalls, applyCalls, getterCalls, substituteCalls, bindCalls, record })
  }
  await writeFile(resolve(directory, 'invocation-witnesses.json'), jsonLf(witnesses), { flag: 'wx', mode: 0o600 }); process.stdout.write(`nested-invocation-fixture:${directory}\n`)
  for (const witness of witnesses) {
    assert.equal(witness.installed, true); assert.deepEqual([witness.before, witness.after, witness.observedRejected, witness.observedOutcome, witness.inactiveRejected, witness.inactiveOutcome], [17, 17, false, 17, false, 17], witness.method)
    assert.deepEqual([witness.createCalls, witness.verifyCalls, witness.applyCalls, witness.getterCalls, witness.substituteCalls], [4, 4, 3, 0, 0], witness.method); assert.equal(witness.bindCalls, witness.method === 'bind-substitution' ? 1 : 0)
    assert.equal(witness.record.status, 'PASS'); assert.deepEqual(nestedStages(witness.record), nestedPair); assert.doesNotMatch(JSON.stringify(witness.record), /private-argument/)
  }
})

const fineKinds = ['envelope', 'bounded-read', 'read-await', 'write-file', 'write-positional', 'file-sync',
  'directory-sync', 'utf8-decode', 'json-parse', 'validate', 'canonical-parse', 'canonical-encode', 'replay',
  'encode-buffer', 'hash', 'copy', 'proof-lookup', 'metadata', 'cache-hit', 'cache-miss', 'cache-admit', 'cache-evict']
const finePhases = ['prior-proof', 'copy-package', 'pack-ledger', 'index', 'seal-sync']
const fineRecord = (changes = {}) => Object.freeze({
  schema: 'modly.world-backup-cost.v1', invocation: 7, sequence: 1, span: 1, parent: null,
  phase: 'prior-proof', kind: 'envelope', edge: 'begin', ns: '100', ledgerIndex: null,
  appliedRevision: null, target: 'directory', requestedBytes: null, completedBytes: null,
  sourceBytes: null, calls: 0, outcome: 'pending', durable: null, ...changes,
})
function fineSuccessRecords(invocation = 7) {
  return [
    fineRecord({ invocation }),
    fineRecord({ invocation, sequence: 2, span: 2, parent: 1, kind: 'read-await', target: 'receipt',
      ns: '110', requestedBytes: 10, sourceBytes: 10 }),
    fineRecord({ invocation, sequence: 3, span: 3, parent: 1, kind: 'read-await', target: 'receipt',
      ns: '120', requestedBytes: 12, sourceBytes: 12 }),
    fineRecord({ invocation, sequence: 4, span: 2, parent: 1, kind: 'read-await', target: 'receipt', edge: 'settled',
      ns: '160', requestedBytes: 10, completedBytes: 10, sourceBytes: 10, calls: 1, outcome: 'fulfilled' }),
    fineRecord({ invocation, sequence: 5, span: 3, parent: 1, kind: 'read-await', target: 'receipt', edge: 'settled',
      ns: '170', requestedBytes: 12, completedBytes: 12, sourceBytes: 12, calls: 1, outcome: 'fulfilled' }),
    fineRecord({ invocation, sequence: 6, span: 4, parent: 1, kind: 'cache-hit', target: 'receipt',
      ns: '172', sourceBytes: 10 }),
    fineRecord({ invocation, sequence: 7, span: 4, parent: 1, kind: 'cache-hit', target: 'receipt', edge: 'settled',
      ns: '173', sourceBytes: 10, calls: 0, outcome: 'fulfilled' }),
    fineRecord({ invocation, sequence: 8, edge: 'settled', ns: '200', calls: 1, outcome: 'fulfilled' }),
  ]
}
const fineFaultRecord = (invocation = 7, sequence = 9) => fineRecord({ invocation, sequence, span: 0, parent: null,
  kind: 'observer-fault', edge: 'settled', ns: '201', calls: 0, outcome: 'rejected' })
const fineObserver = (runtime = fakeRuntime()) => stageHarness.createStageDiagnostic(
  stageHarness.FINE_BACKUP_DIAGNOSTIC ?? stageHarness.STAGE_DIAGNOSTIC, stageIdentity, runtime)

test('fine backup cost diagnostic uses a distinct sealed v3 flag and non-comparable profile', async () => {
  const descriptor = stageHarness.FINE_BACKUP_DIAGNOSTIC
  assert.equal(descriptor?.schema, 'worlds-command-stage-diagnostic.v3', 'Missing fine-backup v3 descriptor.')
  assert.equal(descriptor.maxRecordsPerDispatch, 8192); assert.equal(descriptor.maxDispatches, 20)
  assert.deepEqual(descriptor.profile, { entities: 100, setupBatches: 32, measuredBatches: 20, fileSync: 'default', directorySync: 'default' })
  assert.equal(descriptor.thresholdNs, null); assert.equal(descriptor.gainAcceptance, null)
  assert.equal(descriptor.thresholdGainUnder50Ms, null); assert.equal(descriptor.sampleComparability, 'NON_COMPARABLE_DIAGNOSTIC')
  assert.deepEqual(parseArguments(['--report-only', '--diagnostic-fine-backup']),
    { mode: 'report-only', sealSha256: null, diagnosticFineBackup: true })
  assert.deepEqual(parseArguments(['--run', '--seal-sha256', seal, '--diagnostic-fine-backup']),
    { mode: 'run', sealSha256: seal, diagnosticFineBackup: true })
  for (const flags of [['--diagnostic-stages'], ['--diagnostic-nested-backup'],
    ['--diagnostic-fine-backup'], ['--diagnostic-cpu-profile-dir', `${profileBase}/attempt-test-fine`]]) {
    assert.throws(() => parseArguments(['--report-only', '--diagnostic-fine-backup', ...flags]))
  }
  const inventory = await collectSourceManifest({ diagnosticFineBackup: true })
  assert.deepEqual(inventory.diagnosticStages, descriptor)
  assert.equal(inventory.sourceSealSha256, hash(`${inventory.tsv}${jsonLf(inventory.runtime)}${jsonLf(SCENARIO)}${jsonLf(descriptor)}`))
  const defaultInventory = await collectSourceManifest(), nestedInventory = await collectSourceManifest({ diagnosticNestedBackup: true })
  assert.notEqual(inventory.sourceSealSha256, defaultInventory.sourceSealSha256)
  assert.notEqual(inventory.sourceSealSha256, nestedInventory.sourceSealSha256)
  assert.deepEqual(inventory.sources, defaultInventory.sources)
  const environment = { cwd: root, executable: inventory.runtime.executable, version: process.version, execArgv: inventory.runtime.execArgv, nodeOptions: '', nodePath: '' }
  assert.doesNotThrow(() => validateRunAdmission({ mode: 'run', sealSha256: inventory.sourceSealSha256, diagnosticFineBackup: true }, inventory, environment))
  assert.throws(() => validateRunAdmission({ mode: 'run', sealSha256: inventory.sourceSealSha256, diagnosticNestedBackup: true }, inventory, environment))
})

test('fine backup cost diagnostic validates primitive pairs and overlap-safe prior-proof accounting', () => {
  assert.equal(typeof stageHarness.summarizeFineBackupRecords, 'function', 'Missing fine-backup grammar validator.')
  const summary = stageHarness.summarizeFineBackupRecords(fineSuccessRecords())
  assert.equal(summary.schema, 'worlds-command-backup-cost-summary.v1')
  assert.equal(summary.status, 'PASS'); assert.equal(summary.faultCode, null)
  assert.equal(summary.invocation, 7); assert.equal(summary.recordCount, 8); assert.equal(summary.logicalSpanCount, 4)
  assert.deepEqual(summary.root, { span: 1, durationNs: '100', outcome: 'fulfilled', durable: null })
  assert.deepEqual(summary.cache, { hits: 1, misses: 0, admits: 0, evicts: 0 })
  assert.equal(summary.bytes.requested, '22'); assert.equal(summary.bytes.completed, '22'); assert.equal(summary.bytes.source, '32')
  assert.deepEqual(Object.keys(summary.kinds).sort(), fineKinds.sort())
  assert.deepEqual(Object.keys(summary.phases).sort(), finePhases.sort())
  assert.deepEqual(summary.priorProof, { spanCount: 3, intervalUnionNs: '61', overlapNs: '40', maxConcurrency: 2, residualNs: '2' })
  assert.equal(summary.kinds['read-await'].settled, 2); assert.equal(summary.kinds['file-sync'].settled, 0)
  assert.equal(summary.kinds.replay.settled, 0); assert.equal(summary.kinds.hash.settled, 0)
  assert.equal(summary.kinds.copy.settled, 0); assert.equal(summary.kinds['proof-lookup'].settled, 0)
  assert.equal(Object.isFrozen(summary), true); assert.equal(Object.isFrozen(summary.priorProof), true)
  const contained = stageHarness.summarizeFineBackupRecords([
    fineRecord({ invocation: 8, ns: '100' }),
    fineRecord({ invocation: 8, sequence: 2, span: 2, parent: 1, kind: 'read-await', target: 'receipt', ns: '110' }),
    fineRecord({ invocation: 8, sequence: 3, span: 3, parent: 1, kind: 'read-await', target: 'receipt', ns: '160' }),
    fineRecord({ invocation: 8, sequence: 4, span: 3, parent: 1, kind: 'read-await', target: 'receipt',
      edge: 'settled', ns: '170', calls: 1, outcome: 'fulfilled' }),
    fineRecord({ invocation: 8, sequence: 5, span: 2, parent: 1, kind: 'read-await', target: 'receipt',
      edge: 'settled', ns: '210', calls: 1, outcome: 'fulfilled' }),
    fineRecord({ invocation: 8, sequence: 6, edge: 'settled', ns: '300', calls: 1, outcome: 'fulfilled' }),
  ])
  assert.equal(contained.status, 'PASS')
  assert.deepEqual(contained.priorProof, { spanCount: 2, intervalUnionNs: '100', overlapNs: '10', maxConcurrency: 2, residualNs: '0' })
})

test('fine backup cost diagnostic rejects bounded malformed pending mixed and nonterminal fault streams without leaks', () => {
  const analyze = stageHarness.summarizeFineBackupRecords
  assert.equal(typeof analyze, 'function', 'Missing fine-backup grammar validator.')
  const good = fineSuccessRecords()
  const failures = [
    ['SEQUENCE', good.map((record, index) => index === 2 ? fineRecord({ ...record, sequence: 9 }) : record)],
    ['INVOCATION', good.map((record, index) => index === 3 ? fineRecord({ ...record, invocation: 8 }) : record)],
    ['PAIRING', good.slice(0, -1)],
    ['RECORD_SCHEMA', good.map((record, index) => index === 1 ? Object.freeze({ ...record, path: '/private/world' }) : record)],
    ['TERMINAL', [...good, fineFaultRecord(), fineRecord({ ...good.at(-1), sequence: 10, ns: '202' })]],
    ['RECORD_BOUND', Array.from({ length: 8193 }, () => good[0])],
  ]
  for (const [faultCode, records] of failures) {
    const summary = analyze(records)
    assert.equal(summary.status, 'FAIL', faultCode); assert.equal(summary.faultCode, faultCode)
    const serialized = JSON.stringify(summary)
    for (const forbidden of ['/private/world', 'projectId', 'transactionId', 'payload', 'sha256', 'error']) assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'))
  }
  const faulted = analyze([...good, fineFaultRecord()])
  assert.equal(faulted.status, 'FAIL'); assert.equal(faulted.faultCode, 'OBSERVER_FAULT')
  assert.equal(faulted.terminalFault, true); assert.equal(faulted.recordCount, 9)
})

test('fine backup cost diagnostic binds direct constructor callbacks to one measured repository scope', async () => {
  const observer = fineObserver(), value = { ok: true, durable: 'original' }
  assert.equal(observer.repositoryOptions.backupCostObserver(fineSuccessRecords()[0]), undefined)
  let invocation = 1
  const repository = { async applyCommands() {
    for (const stage of checkpoints.slice(0, 2)) observer.repositoryOptions.failureCheckpoint(stage)
    for (const record of fineSuccessRecords(invocation)) observer.repositoryOptions.backupCostObserver(record)
    for (const stage of checkpoints.slice(2)) observer.repositoryOptions.failureCheckpoint(stage)
    return value
  } }
  assert.equal(observer.installRepository(repository), true)
  for (; invocation <= 20; invocation++) {
    const outcome = await observer.dispatch(plan(invocation), () => repository.applyCommands({ batch: { transactionId: plan(invocation).transactionId } }))
    assert.equal(outcome, value)
    const record = observer.takeRecord(); assert.equal(record.status, 'PASS', record.error)
    assert.equal(record.fineBackup.status, 'PASS'); assert.equal(record.fineBackup.invocation, invocation)
    assert.equal(record.fineBackup.recordCount, 8); assert.equal(record.fineBackup.logicalSpanCount, 4)
    const serialized = JSON.stringify(record.fineBackup)
    for (const forbidden of ['projectId', 'transactionId', 'payload', 'sha256', 'error']) assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'))
  }
  await assert.rejects(observer.dispatch(plan(21), async () => value), /association/)
  assert.equal(observer.repositoryOptions.backupCostObserver(fineSuccessRecords(21)[0]), undefined)
  assert.equal(observer.takeRecord(), null)
})

test('fine backup cost diagnostic invalidation preserves original outcomes and never reports a gain', async () => {
  for (const terminalFault of [false, true]) {
    const observer = fineObserver(), original = terminalFault ? new Error('original identity') : { ok: true }
    const repository = { async applyCommands() {
      for (const stage of checkpoints.slice(0, 2)) observer.repositoryOptions.failureCheckpoint(stage)
      for (const record of [...fineSuccessRecords(), ...(terminalFault ? [fineFaultRecord()] : [])]) observer.repositoryOptions.backupCostObserver(record)
      for (const stage of checkpoints.slice(2)) observer.repositoryOptions.failureCheckpoint(stage)
      if (terminalFault) throw original
      return original
    } }
    observer.installRepository(repository)
    const outcome = await observer.dispatch(plan(), () => repository.applyCommands({ batch: { transactionId: plan().transactionId } }))
      .then((value) => ({ value }), (error) => ({ error }))
    assert.equal(terminalFault ? outcome.error : outcome.value, original)
    const record = observer.takeRecord()
    assert.equal(record.status, terminalFault ? 'FAIL' : 'PASS')
    assert.equal(record.fineBackup.status, terminalFault ? 'FAIL' : 'PASS')
    assert.equal(record.fineBackup.faultCode, terminalFault ? 'OBSERVER_FAULT' : null)
  }
  const descriptor = stageHarness.FINE_BACKUP_DIAGNOSTIC
  for (const ns of ['1', '50000000', '999999999']) {
    const result = classifyObservation(rows(ns), { ...complete, diagnosticStages: descriptor, stageStatus: 'PASS' })
    assert.equal(result.status, 'DIAGNOSTIC_WORKLOAD_COMPLETE'); assert.equal(result.exitCode, 0)
    assert.equal(result.allCommandsUnder50Ms, null); assert.equal(result.p95Under50Ms, null)
    assert.equal(result.thresholdNs, null); assert.equal(result.gainAcceptance, null)
    assert.equal(result.thresholdGainUnder50Ms, null); assert.equal(result.sampleComparability, 'NON_COMPARABLE_DIAGNOSTIC')
  }
  assert.equal(classifyObservation(rows('1'), { ...complete, diagnosticStages: descriptor, stageStatus: 'FAIL' }).status, 'INVALID_DIAGNOSTIC')
  assert.equal(stageHarness.STAGE_DIAGNOSTIC.schema, 'worlds-command-stage-diagnostic.v1')
  assert.equal(stageHarness.NESTED_BACKUP_DIAGNOSTIC.schema, 'worlds-command-stage-diagnostic.v2')
  assert.equal(stageHarness.createStageDiagnostic(undefined, stageIdentity, {}), null)
})
