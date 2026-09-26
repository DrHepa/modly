import assert from 'node:assert/strict'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'

import {
  assertRepositoryNodeRuntime,
  buildWorldsCodexDirectEditFixture,
  nativeAuthorityGateCommand,
  nativeSupervisorPreexecReceiptFormat,
  parseBuildArguments,
} from './worlds-codex-direct-edit-electron-fixture.mjs'

const require = createRequire(import.meta.url)
const {
  PINNED_RUNTIME_ADDITIONS,
  PINNED_RUNTIME_ADMISSION,
  classifyProcEnvironment,
  createArgvSha256,
  createEnvironmentAdmissionReceipt,
  createEnvironmentContract,
  createLaunchBindingSha256,
  createProcfsPriorGateProof,
  createRuntimeEnvironmentAllowance,
  inspectRuntimeExecutable,
  materializePinnedRuntimeIdentity,
  persistProcfsObservation,
  readBoundedProcEnvironment,
  requireAcceptedProcfsObservation,
  secureReadPrivateFile,
  validateBuildReceipts,
  validateEnvironmentAdmissionReceipt,
  validateExactEnvironment,
  validateSupervisorReceipt,
  validateRuntimeEnvironment,
  validateRuntimeEnvironmentAllowance,
  validateRuntimeIdentity,
  validateProcfsObservation,
} = require('./worlds-codex-direct-edit-electron-fixture/bootstrap.cjs')

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const fixtureRoot = path.join(repositoryRoot, 'scripts/worlds-codex-direct-edit-electron-fixture')
const relocatedRepositoryRoot = '/tmp/relocated-modly'
const PINNED_RUNTIME_IDENTITY = materializePinnedRuntimeIdentity(relocatedRepositoryRoot)
const owners = [
  'scripts/worlds-codex-direct-edit-electron-fixture.mjs',
  'scripts/worlds-codex-direct-edit-electron-fixture.test.mjs',
  ...['bootstrap.cjs', 'main.ts', 'preload.ts', 'renderer.tsx', 'driver.ts', 'shared.ts', 'inspection.ts', 'index.html', 'styles.css', 'tsconfig.json']
    .map((name) => `scripts/worlds-codex-direct-edit-electron-fixture/${name}`),
]

const read = (relative) => readFile(path.join(repositoryRoot, relative), 'utf8')

const sha256 = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex')
const domainHash = (domain, value) => sha256(Buffer.from(`${domain}\0${JSON.stringify(value)}`))

function tamperValue(value) {
  if (value === null) return 'FORGED'
  if (typeof value === 'boolean') return !value
  if (typeof value === 'number') return value + 1
  if (typeof value === 'string') return `${value}-forged`
  if (Array.isArray(value)) return [...value, 'FORGED']
  return { ...value, extra: true }
}

function syntheticCustody(stateRoot = '/tmp/modly-worlds-c3-native-ABCDEF/native-state') {
  const environment = {
    HOME: path.join(stateRoot, 'home'),
    XDG_CONFIG_HOME: path.join(stateRoot, 'config'),
    XDG_CACHE_HOME: path.join(stateRoot, 'cache'),
    XDG_RUNTIME_DIR: path.join(stateRoot, 'runtime'),
    TMPDIR: path.join(stateRoot, 'tmp'),
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    DBUS_SESSION_BUS_ADDRESS: 'disabled:',
    DISPLAY: ':97',
    XAUTHORITY: path.join(stateRoot, 'x11/Xauthority'),
  }
  const launch = {
    paths: { stateRoot, userData: path.join(stateRoot, 'userData') },
    display: { name: ':97', number: 97, authorityPath: environment.XAUTHORITY, lockPath: '/tmp/.X97-lock', socketPath: '/tmp/.X11-unix/X97' },
    supervisor: {
      commandShape: 'supervised-Xvfb-then-direct-env-i-Electron', expectedOwnerUid: process.getuid(),
      environmentKeys: Object.keys(environment).sort(),
      evidencePath: path.join(stateRoot, 'supervisor-preexec.v2.json'),
      startedEvidencePath: path.join(stateRoot, 'supervisor-started.json'),
    },
    scenarios: {}, preparedDirectories: [],
    argv: ['/fixture/electron', '/tmp/modly-worlds-c3-native-test/bootstrap.cjs', `--user-data-dir=${path.join(stateRoot, 'userData')}`],
    environment,
  }
  launch.environmentContract = createEnvironmentContract(environment)
  launch.runtimeEnvironmentAllowance = createRuntimeEnvironmentAllowance(
    launch.environmentContract,
    PINNED_RUNTIME_ADDITIONS,
    PINNED_RUNTIME_IDENTITY,
  )
  launch.argvSha256 = createArgvSha256(launch.argv)
  const build = {
    schema: 'modly.worlds-codex-direct-edit-native-build.v1', scope: 'source-module-c3-direct-edit-native-fixture',
    execution: 'NOT_RUN', nativeEvidence: 'ABSENT', outputDirectory: '/tmp/modly-worlds-c3-native-test',
    repositoryRoot, sourceAggregateSha256: 'a'.repeat(64),
    outputs: { 'bootstrap.cjs': { bytes: 3, sha256: 'b'.repeat(64) } }, outputInventory: ['bootstrap.cjs'],
    launch,
  }
  launch.launchBindingSha256 = createLaunchBindingSha256(build)
  const manifestBytes = Buffer.from(JSON.stringify(build))
  const receipt = {
    schema: 'modly.worlds-c3-supervisor-preexec.v2', phase: 'PRE_EXEC',
    manifestFileSha256: sha256(manifestBytes), launchBindingSha256: launch.launchBindingSha256,
    environmentContractSha256: launch.environmentContract.sha256, environmentEntries: launch.environmentContract.entries,
    argvSha256: launch.argvSha256, supervisorPid: 4242, supervisorUid: process.getuid(), xvfbPid: 4243,
    display: launch.display.name, authorityPath: launch.display.authorityPath,
    authority: { uid: process.getuid(), mode: '600', nlink: 1 }, authenticatedReady: true,
  }
  return { build, environment, manifestBytes, receipt }
}

function procfsCustody(stateRoot) {
  const fixture = syntheticCustody(stateRoot)
  const allowance = fixture.build.launch.runtimeEnvironmentAllowance
  const liveEnvironment = { ...fixture.environment,
    ...Object.fromEntries(allowance.entries.map((entry) => [entry.name, entry.value])) }
  const validatedLive = validateRuntimeEnvironment(fixture.environment, fixture.build.launch.environmentContract,
    allowance, liveEnvironment, PINNED_RUNTIME_IDENTITY)
  const priorGates = createProcfsPriorGateProof({
    validatedLive,
    manifestFileSha256: sha256(fixture.manifestBytes),
    launchBindingSha256: fixture.build.launch.launchBindingSha256,
    supervisorReceiptSha256: sha256(JSON.stringify(fixture.receipt)),
    supervisorPid: process.ppid,
    bootstrapPid: process.pid,
    sourceAggregateSha256: fixture.build.sourceAggregateSha256,
    outputReceiptsSha256: 'd'.repeat(64),
    authorityGateSha256: 'e'.repeat(64),
    sandboxGateSha256: 'f'.repeat(64),
    buildReceiptGatesPassed: true,
  })
  return { ...fixture, allowance, liveEnvironment, validatedLive, priorGates }
}

function procfsRecordBytes(records, terminalNul = true) {
  const pieces = []
  for (const record of records) pieces.push(Buffer.from(record), Buffer.from([0]))
  if (!terminalNul && pieces.length > 0) pieces.pop()
  return Buffer.concat(pieces)
}

function procfsBytes(environment, malformed = [], terminalNul = true) {
  return procfsRecordBytes([
    ...Object.entries(environment).map(([name, value]) => Buffer.from(`${name}=${value}`)),
    ...malformed,
  ], terminalNul)
}

test('exact live environment is authoritative and rejects extra, missing, mutated, or Electron-prefixed keys', () => {
  const { build, environment } = syntheticCustody()
  assert.deepEqual(validateExactEnvironment(environment, build.launch.environmentContract, { ...environment }), build.launch.environmentContract)
  for (const actual of [
    { ...environment, AMBIENT: '1' },
    Object.fromEntries(Object.entries(environment).filter(([name]) => name !== 'HOME')),
    { ...environment, ELECTRON_RUN_AS_NODE: '1' },
  ]) assert.throws(() => validateExactEnvironment(environment, build.launch.environmentContract, actual), /environment/i)
  for (const name of Object.keys(environment)) {
    assert.throws(() => validateExactEnvironment(environment, build.launch.environmentContract,
      { ...environment, [name]: `${environment[name]}-mutated` }), new RegExp(name))
  }
  assert.deepEqual(createEnvironmentContract({ ZED: 'last', ALPHA: 'first' }).entries.map(([name]) => name), ['ALPHA', 'ZED'])
  for (const invalid of [{ 'bad-name': 'x' }, { VALID: 'line\nfeed' }, { VALID: 1 }]) {
    assert.throws(() => createEnvironmentContract(invalid), /environment/i)
  }
})

test('runtime environment admits only the exact required two additions under the pinned identity', () => {
  const { build, environment } = syntheticCustody()
  const allowance = build.launch.runtimeEnvironmentAllowance
  const additions = Object.fromEntries(allowance.entries.map((entry) => [entry.name, entry.value]))
  assert.deepEqual(additions, { CHROME_DESKTOP: 'electron.desktop', FC_FONTATIONS: '1' })
  assert.deepEqual(allowance.entries.map((entry) => entry.receipt), [
    ['CHROME_DESKTOP', 16, '77f9b10e61d4aa14b11f2addb44e5d6130df8b46bd4701709d15be8c002b2eb9'],
    ['FC_FONTATIONS', 1, '6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b'],
  ])
  const live = { ...environment, ...additions }
  const accepted = validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance, live, PINNED_RUNTIME_IDENTITY)
  assert.equal(accepted.base.count, 11)
  assert.equal(accepted.additions.count, 2)
  assert.deepEqual(accepted.additions.names, ['CHROME_DESKTOP', 'FC_FONTATIONS'])
  for (const name of Object.keys(live)) {
    assert.throws(() => validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance,
      { ...live, [name]: `${live[name]}-mutated` }, PINNED_RUNTIME_IDENTITY), new RegExp(name))
    assert.throws(() => validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance,
      Object.fromEntries(Object.entries(live).filter(([key]) => key !== name)), PINNED_RUNTIME_IDENTITY), /environment/i)
  }
  for (const extra of ['THIRD_EXTRA', 'ELECTRON_FUTURE_FLAG', 'NODE_OPTIONS', 'SESSION_MANAGER']) {
    assert.throws(() => validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance,
      { ...live, [extra]: '1' }, PINNED_RUNTIME_IDENTITY), /environment/i)
  }
  assert.throws(() => validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance,
    { ...environment }, PINNED_RUNTIME_IDENTITY), /environment/i)
  for (const only of Object.keys(additions)) {
    assert.throws(() => validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance,
      { ...environment, [only]: additions[only] }, PINNED_RUNTIME_IDENTITY), /environment/i)
  }
  assert.throws(() => validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance,
    { ...live, chrome_desktop: live.CHROME_DESKTOP, CHROME_DESKTOP: undefined }, PINNED_RUNTIME_IDENTITY), /environment/i)
  assert.throws(() => validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance,
    { ...live, CHROME_DESKTOP: live.FC_FONTATIONS, FC_FONTATIONS: live.CHROME_DESKTOP }, PINNED_RUNTIME_IDENTITY), /CHROME_DESKTOP|FC_FONTATIONS/)
  for (const value of ['', 'wrong', 'line\nfeed', 'carriage\rreturn', 'nul\0value']) {
    assert.throws(() => validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance,
      { ...live, CHROME_DESKTOP: value }, PINNED_RUNTIME_IDENTITY), /CHROME_DESKTOP|environment/i)
  }
  for (const rejected of ['chatgpt.desktop', 'chromium.desktop', 'Electron.desktop', 'electron.desktop ']) {
    assert.throws(() => validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance,
      { ...live, CHROME_DESKTOP: rejected }, PINNED_RUNTIME_IDENTITY), /CHROME_DESKTOP|environment/i)
  }
  for (const mutate of [
    (copy) => { copy.electronVersion = '44.1.2' }, (copy) => { copy.platform = 'darwin' },
    (copy) => { copy.arch = 'x64' }, (copy) => { copy.executable.path = '/tmp/other-electron' },
  ]) {
    const changedIdentity = structuredClone(PINNED_RUNTIME_IDENTITY)
    mutate(changedIdentity)
    assert.throws(() => validateRuntimeEnvironment(environment, build.launch.environmentContract, allowance,
      live, changedIdentity), /runtime|identity|executable/i)
  }
})

test('runtime identity materializes only the fixed repository Electron under a canonical relocated root', async () => {
  assert.deepEqual(PINNED_RUNTIME_IDENTITY, {
    schema: 'modly.worlds-c3-runtime-identity.v1',
    electronVersion: '44.1.1',
    platform: 'linux',
    arch: 'arm64',
    executable: {
      path: '/tmp/relocated-modly/node_modules/electron/dist/electron',
      ...PINNED_RUNTIME_ADMISSION.executableReceipt,
    },
  })
  for (const root of ['relative/root', '/tmp/../tmp/relocated-modly', '/tmp/relocated-modly\0']) {
    assert.throws(() => materializePinnedRuntimeIdentity(root), /repository|root|path/i)
  }
  for (const admission of [
    { ...PINNED_RUNTIME_ADMISSION, executableRelativePath: '/usr/bin/electron' },
    { ...PINNED_RUNTIME_ADMISSION, executableRelativePath: '../electron' },
    { ...PINNED_RUNTIME_ADMISSION, executableRelativePath: 'node_modules/electron/../../outside' },
    { ...PINNED_RUNTIME_ADMISSION, executableRelativePath: 'node_modules/electron/dist/electron\0' },
    { ...PINNED_RUNTIME_ADMISSION, extra: true },
  ]) assert.throws(() => materializePinnedRuntimeIdentity(relocatedRepositoryRoot, admission), /admission|path|relative/i)
  const [bootstrapSource, builderSource] = await Promise.all([
    read('scripts/worlds-codex-direct-edit-electron-fixture/bootstrap.cjs'),
    read('scripts/worlds-codex-direct-edit-electron-fixture.mjs'),
  ])
  const bootstrapMaterialization = bootstrapSource.indexOf('const expectedRuntimeIdentity = materializePinnedRuntimeIdentity(build.repositoryRoot)')
  const bootstrapInspection = bootstrapSource.indexOf('inspectRuntimeExecutable(process.execPath)')
  const builderMaterialization = builderSource.indexOf('const expectedRuntimeIdentity = materializePinnedRuntimeIdentity(repositoryRoot)')
  const builderInspection = builderSource.indexOf('inspectRuntimeExecutable(argv[0])')
  assert.ok(bootstrapMaterialization >= 0 && bootstrapMaterialization < bootstrapInspection)
  assert.ok(builderMaterialization >= 0 && builderMaterialization < builderInspection)
})

test('runtime allowance is exact, canonical, disjoint, identity-bound, and launch-bound', () => {
  const fixture = syntheticCustody()
  const allowance = fixture.build.launch.runtimeEnvironmentAllowance
  assert.doesNotThrow(() => validateRuntimeEnvironmentAllowance(fixture.build.launch.environmentContract, allowance))
  const mutations = [
    (copy) => { copy.schema = 'forged' },
    (copy) => { copy.entries.reverse() },
    (copy) => { copy.entries[0].required = false },
    (copy) => { copy.entries[0].name = 'HOME' },
    (copy) => { copy.entries[0].value = 'wrong' },
    (copy) => { copy.entries[0].receipt[0] = 'WRONG' },
    (copy) => { copy.entries[0].receipt[1] += 1 },
    (copy) => { copy.entries[0].receipt[2] = '0'.repeat(64) },
    (copy) => { copy.entries[0].extra = true },
    (copy) => { delete copy.entries[0].required },
    (copy) => { copy.entries.push(structuredClone(copy.entries[0])) },
    (copy) => { copy.runtimeEnvironmentAllowanceSha256 = '0'.repeat(64) },
    (copy) => { copy.runtimeIdentity.schema = 'forged' },
    (copy) => { copy.runtimeIdentity.electronVersion = '44.1.2' },
    (copy) => { copy.runtimeIdentity.platform = 'darwin' },
    (copy) => { copy.runtimeIdentity.arch = 'x64' },
    (copy) => { copy.runtimeIdentity.executable.path = '/tmp/wrong' },
    (copy) => { copy.runtimeIdentity.executable.type = 'directory' },
    (copy) => { copy.runtimeIdentity.executable.uid += 1 },
    (copy) => { copy.runtimeIdentity.executable.mode = '700' },
    (copy) => { copy.runtimeIdentity.executable.nlink = 2 },
    (copy) => { copy.runtimeIdentity.executable.size += 1 },
    (copy) => { copy.runtimeIdentity.executable.sha256 = '0'.repeat(64) },
    (copy) => { copy.runtimeIdentity.executable.extra = true },
    (copy) => { delete copy.runtimeIdentity.executable.type },
    (copy) => { copy.runtimeIdentity.extra = true },
    (copy) => { delete copy.runtimeIdentity.arch },
    (copy) => { copy.runtimeIdentitySha256 = '0'.repeat(64) },
    (copy) => { copy.liveEnvironmentAdmissionSha256 = '0'.repeat(64) },
    (copy) => { copy.extra = true },
    (copy) => { delete copy.entries },
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(fixture.build)
    mutate(changed.launch.runtimeEnvironmentAllowance)
    assert.notEqual(createLaunchBindingSha256(changed), fixture.build.launch.launchBindingSha256)
    assert.throws(() => validateSupervisorReceipt(changed, fixture.manifestBytes, fixture.receipt, 4242),
      /allowance|runtime|identity|launch|environment|keys/i)
  }
  for (const additions of [
    { CHROME_DESKTOP: 'line\nfeed', FC_FONTATIONS: '1' },
    { CHROME_DESKTOP: 'electron.desktop', FC_FONTATIONS: 'nul\0value' },
    { HOME: 'overlap', FC_FONTATIONS: '1' },
    { 'ELECTRON_*': '1', CHROME_DESKTOP: 'electron.desktop', FC_FONTATIONS: '1' },
    { ELECTRON_FUTURE_FLAG: '1', CHROME_DESKTOP: 'electron.desktop', FC_FONTATIONS: '1' },
  ]) assert.throws(() => createRuntimeEnvironmentAllowance(fixture.build.launch.environmentContract, additions, PINNED_RUNTIME_IDENTITY), /runtime|environment|overlap|unsafe/i)
})

test('runtime executable identity rejects every mismatched field and unsafe file shape', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-runtime-identity-'))
  const executable = path.join(root, 'electron')
  await writeFile(executable, 'runtime-binary', { mode: 0o755 })
  await chmod(executable, 0o755)
  const executableReceipt = inspectRuntimeExecutable(executable)
  const expected = { schema: PINNED_RUNTIME_IDENTITY.schema, electronVersion: '44.1.1', platform: 'linux', arch: 'arm64', executable: executableReceipt }
  assert.doesNotThrow(() => validateRuntimeIdentity(expected, structuredClone(expected)))
  for (const mutate of [
    (copy) => { copy.electronVersion = '44.1.2' }, (copy) => { copy.platform = 'darwin' },
    (copy) => { copy.arch = 'x64' }, (copy) => { copy.executable.path = '/tmp/wrong' },
    (copy) => { copy.executable.type = 'directory' }, (copy) => { copy.executable.uid += 1 },
    (copy) => { copy.executable.mode = '700' }, (copy) => { copy.executable.nlink = 2 },
    (copy) => { copy.executable.size += 1 }, (copy) => { copy.executable.sha256 = '0'.repeat(64) },
  ]) {
    const changed = structuredClone(expected)
    mutate(changed)
    assert.throws(() => validateRuntimeIdentity(expected, changed), /runtime|identity|executable/i)
  }
  await chmod(executable, 0o700)
  assert.throws(() => validateRuntimeIdentity(expected, { ...expected, executable: inspectRuntimeExecutable(executable) }), /runtime|identity|executable/i)
  await chmod(executable, 0o755)
  const hardlink = `${executable}.hard`
  await link(executable, hardlink)
  assert.throws(() => validateRuntimeIdentity(expected, { ...expected, executable: inspectRuntimeExecutable(executable) }), /runtime|identity|executable/i)
  await unlink(hardlink)
  const symbolic = `${executable}.symbolic`
  await symlink(executable, symbolic)
  assert.throws(() => inspectRuntimeExecutable(symbolic), /symbolic|ELOOP|runtime/i)
  assert.throws(() => inspectRuntimeExecutable(root), /regular|runtime/i)
  await writeFile(executable, 'changed-runtime-binary', { mode: 0o755 })
  assert.throws(() => validateRuntimeIdentity(expected, { ...expected, executable: inspectRuntimeExecutable(executable) }), /runtime|identity|executable/i)
})

test('procfs bounded reader and exact observations preserve established labels', async () => {
  const { environment, allowance, liveEnvironment, validatedLive, priorGates } = procfsCustody()
  const classify = (observation) => classifyProcEnvironment(
    observation, environment, allowance, validatedLive, priorGates)
  for (const [accepted, status, contract] of [
    [environment, 'SEALED_LAUNCH_CORROBORATION', 'SEALED_11'],
    [liveEnvironment, 'FULL_LIVE_CORROBORATION', 'FULL_LIVE_13'],
  ]) {
    const observation = classify({ bytes: procfsBytes(accepted) })
    assert.equal(observation.status, status)
    assert.equal(observation.schema, 'modly.worlds-c3-procfs-observation.v4')
    assert.equal(observation.corroboratedContract, contract)
    assert.doesNotThrow(() => validateProcfsObservation(observation, environment, allowance))
  }
  assert.equal(classify({ bytes: Buffer.alloc(0) }).status, 'EMPTY_NON_AUTHORITATIVE')
  for (const errorCode of ['ENOENT', 'EACCES', 'ENOSYS', 'ENOTSUP']) {
    assert.equal(classify({ errorCode }).status, 'UNAVAILABLE_NON_AUTHORITATIVE')
  }
  for (const fatal of [classify({ errorCode: 'EIO' }), classify({ bytes: Buffer.alloc(65_537) })]) {
    assert.equal(fatal.status, 'FATAL')
    assert.equal(fatal.accepted, false)
    assert.throws(() => requireAcceptedProcfsObservation(fatal), /procfs environment classification failed/i)
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-procfs-bound-'))
  const exact = path.join(root, 'exact')
  const overflow = path.join(root, 'overflow')
  await writeFile(exact, Buffer.alloc(65_536))
  await writeFile(overflow, Buffer.alloc(65_537))
  assert.equal(readBoundedProcEnvironment(exact).bytes.length, 65_536)
  assert.equal(readBoundedProcEnvironment(overflow).overflow.byteLength, 65_537)
  const exactBoundary = classify({ bytes: Buffer.alloc(65_536) })
  assert.equal(exactBoundary.status, 'FATAL')
  assert.equal(exactBoundary.byteLength, 65_536)
  assert.equal(exactBoundary.sha256, sha256(Buffer.alloc(65_536)))
  const overflowBoundary = classify({ bytes: Buffer.alloc(65_537) })
  assert.equal(overflowBoundary.status, 'FATAL')
  assert.equal(overflowBoundary.byteLength, 65_537)
})

test('procfs v5 admits only the exact derived sealed-length all-zero observation', () => {
  const { build, environment, allowance, liveEnvironment, validatedLive, priorGates } = procfsCustody()
  const classify = (bytes) => classifyProcEnvironment(
    { bytes }, environment, allowance, validatedLive, priorGates)
  const sealedByteLength = build.launch.environmentContract.entries.reduce((total, [name, valueByteLength]) =>
    total + Buffer.byteLength(name) + 1 + valueByteLength + 1, 0)
  assert.equal(sealedByteLength, 497)
  const exactBytes = Buffer.alloc(sealedByteLength)
  const exact = classify(exactBytes)
  assert.equal(exact.schema, 'modly.worlds-c3-procfs-observation.v4')
  assert.equal(exact.status, 'ZERO_FILLED_NON_AUTHORITATIVE')
  assert.equal(exact.accepted, true)
  assert.equal(exact.byteLength, sealedByteLength)
  assert.equal(exact.sha256, sha256(exactBytes))
  assert.equal(exact.sha256, 'eb83e1aef91b5a2ef84074c7d4470d7a7b142df7409896132bcaad3140b1e19c')
  assert.equal(exact.terminalNul, true)
  assert.equal(exact.recordSlotCount, sealedByteLength)
  assert.equal(exact.wellFormedRecordCount, 0)
  assert.equal(exact.malformedRecordCount, sealedByteLength)
  assert.equal(exact.structuralDefectCount, sealedByteLength)
  assert.deepEqual(exact.malformedReasons, [['EMPTY_RECORD', sealedByteLength]])
  assert.deepEqual(exact.classificationReasons, ['EXACT_ALL_ZERO_SEALED_11_LENGTH'])
  assert.deepEqual(exact.knownRecordCounts, Object.keys(liveEnvironment).sort().map((name) => [name, 0]))
  assert.deepEqual(exact.knownMatchingNames, [])
  assert.deepEqual(exact.missingLiveNames, Object.keys(liveEnvironment).sort())
  assert.deepEqual(exact.contradictedKnownNames, [])
  assert.equal(exact.corroboratedContract, null)
  assert.equal(exact.corroboratedContractSha256, null)
  assert.doesNotThrow(() => validateProcfsObservation(exact, environment, allowance, validatedLive, priorGates))

  for (const mutate of [
    (copy) => { copy.runtimeIdentity.electronVersion = '44.1.2' },
    (copy) => { copy.runtimeIdentity.executable.sha256 = '0'.repeat(64) },
    (copy) => { copy.entries[0].value = 'chatgpt.desktop' },
    (copy) => { copy.entries[1].value = '0' },
    (copy) => { copy.liveEnvironmentAdmissionSha256 = '0'.repeat(64) },
  ]) {
    const changed = structuredClone(allowance)
    mutate(changed)
    assert.throws(() => classifyProcEnvironment(
      { bytes: exactBytes }, environment, changed, validatedLive, priorGates), /runtime|identity|allowance|environment/i)
  }
  for (const mutate of [
    (copy) => { copy.base.count -= 1 },
    (copy) => { copy.additions.entries[0][2] = '0'.repeat(64) },
    (copy) => { copy.runtimeIdentitySha256 = '0'.repeat(64) },
    (copy) => { copy.liveEnvironmentAdmissionSha256 = '0'.repeat(64) },
  ]) {
    const changed = structuredClone(validatedLive)
    mutate(changed)
    assert.throws(() => classifyProcEnvironment(
      { bytes: exactBytes }, environment, allowance, changed, priorGates), /validated|procfs|environment|binding/i)
  }

  assert.equal(classify(Buffer.alloc(0)).status, 'EMPTY_NON_AUTHORITATIVE')
  for (const length of [1, sealedByteLength - 1, sealedByteLength + 1, 65_536]) {
    const result = classify(Buffer.alloc(length))
    assert.equal(result.status, 'FATAL', `unexpected zero-buffer admission for length ${length}`)
  }
  assert.equal(classify(Buffer.alloc(65_537)).status, 'FATAL')
  for (let index = 0; index < sealedByteLength; index += 1) {
    const changed = Buffer.alloc(sealedByteLength)
    changed[index] = (index % 255) + 1
    assert.equal(classify(changed).status, 'FATAL', `nonzero byte admitted at ${index}`)
  }
  for (const bytes of [
    Buffer.concat([Buffer.alloc(10), Buffer.from('MIXED_FRAGMENT'), Buffer.alloc(10)]),
    procfsRecordBytes([Buffer.from('UNKNOWN_SENTINEL=RAW_SECRET_VALUE')]),
    procfsBytes({ ...liveEnvironment, HOME: 'TOP_SECRET_CHANGED' }),
    procfsRecordBytes([...Object.entries(liveEnvironment).map(([name, value]) => Buffer.from(`${name}=${value}`)),
      Buffer.from(`HOME=${liveEnvironment.HOME}`)]),
    procfsRecordBytes([Buffer.concat([Buffer.from('HOME='), Buffer.from([0xff])])]),
    procfsBytes(environment, [], false),
  ]) assert.notEqual(classify(bytes).status, 'ZERO_FILLED_NON_AUTHORITATIVE')
})

test('procfs v5 zero-filled evidence rejects every fully rebound semantic forgery', () => {
  const { build, environment, allowance, validatedLive, priorGates } = procfsCustody()
  const sealedByteLength = build.launch.environmentContract.entries.reduce((total, [name, valueByteLength]) =>
    total + Buffer.byteLength(name) + 1 + valueByteLength + 1, 0)
  const observation = classifyProcEnvironment(
    { bytes: Buffer.alloc(sealedByteLength) }, environment, allowance, validatedLive, priorGates)
  assert.equal(observation.status, 'ZERO_FILLED_NON_AUTHORITATIVE')
  const rebound = (mutate) => {
    const copy = structuredClone(observation)
    mutate(copy)
    delete copy.procfsObservationBindingSha256
    copy.procfsObservationBindingSha256 = domainHash('modly.worlds-c3-procfs-observation-binding.v4', copy)
    return copy
  }
  const forgeries = [
    (copy) => { copy.sha256 = '0'.repeat(64) },
    (copy) => { copy.byteLength -= 1 },
    (copy) => { copy.terminalNul = false },
    (copy) => { copy.recordSlotCount -= 1 },
    (copy) => { copy.malformedRecordCount -= 1 },
    (copy) => { copy.structuralDefectCount -= 1 },
    (copy) => { copy.malformedReasons = [['EMPTY_RECORD', sealedByteLength - 1]] },
    (copy) => { copy.knownRecordCounts[0][1] = 1 },
    (copy) => {
      const name = copy.missingLiveNames.shift()
      copy.missingLiveCount -= 1
      copy.knownMatchingNames = [name]
      copy.knownMatchingCount = 1
      copy.knownMatchingSubsetSha256 = domainHash('modly.worlds-c3-procfs-known-subset.v1',
        [allowance.liveEnvironmentAdmissionSha256, [name]])
    },
    (copy) => { copy.contradictedKnownNames = ['HOME'] },
    (copy) => { copy.status = 'MALFORMED_NON_AUTHORITATIVE' },
    (copy) => { copy.classificationReasons = ['STRUCTURAL_INCOMPLETE'] },
    (copy) => {
      copy.priorGates.manifestFileSha256 = '0'.repeat(64)
      delete copy.priorGates.priorGateBindingSha256
      copy.priorGates.priorGateBindingSha256 = domainHash(
        'modly.worlds-c3-procfs-prior-gates.v1', copy.priorGates)
    },
    (copy) => { copy.corroboratedContract = 'SEALED_11' },
    (copy) => { copy.corroboratedContractSha256 = build.launch.environmentContract.sha256 },
    (copy) => {
      const alternateLength = sealedByteLength - 1
      copy.byteLength = alternateLength
      copy.sha256 = sha256(Buffer.alloc(alternateLength))
      copy.recordSlotCount = alternateLength
      copy.malformedRecordCount = alternateLength
      copy.structuralDefectCount = alternateLength
      copy.malformedReasons = [['EMPTY_RECORD', alternateLength]]
    },
  ]
  for (const mutate of forgeries) {
    const forged = rebound(mutate)
    assert.throws(() => validateProcfsObservation(
      forged, environment, allowance, validatedLive, priorGates), /.+/)
  }
})

test('procfs v5 retains every live-name subset without authorizing values or unknown names', () => {
  const { environment, allowance, liveEnvironment, validatedLive, priorGates } = procfsCustody()
  const liveNames = Object.keys(liveEnvironment).sort()
  const sealedNames = Object.keys(environment).sort()
  for (let mask = 0; mask < 2 ** liveNames.length; mask += 1) {
    const names = liveNames.filter((_, index) => (mask & 2 ** index) !== 0)
    const expectedStatus = names.length === 0 ? 'EMPTY_NON_AUTHORITATIVE'
      : names.length === liveNames.length ? 'FULL_LIVE_CORROBORATION'
        : JSON.stringify(names) === JSON.stringify(sealedNames) ? 'SEALED_LAUNCH_CORROBORATION'
          : 'INCOMPLETE_NON_AUTHORITATIVE'
    for (const order of [names, [...names].reverse()]) {
      const bytes = names.length === 0 ? Buffer.alloc(0)
        : procfsRecordBytes(order.map((name) => Buffer.from(`${name}=${liveEnvironment[name]}`)))
      const result = classifyProcEnvironment({ bytes }, environment, allowance, validatedLive, priorGates)
      assert.equal(result.schema, 'modly.worlds-c3-procfs-observation.v4')
      assert.equal(result.status, expectedStatus)
      assert.equal(result.accepted, true)
      assert.deepEqual(result.knownMatchingNames, names)
      assert.deepEqual(result.knownRecordCounts,
        liveNames.map((name) => [name, names.includes(name) ? 1 : 0]))
      assert.deepEqual(result.missingLiveNames, liveNames.filter((name) => !names.includes(name)))
      assert.equal(result.knownMatchingSubsetSha256,
        domainHash('modly.worlds-c3-procfs-known-subset.v1', [allowance.liveEnvironmentAdmissionSha256, names]))
      assert.doesNotMatch(JSON.stringify(result), /disabled:|electron\.desktop|native-state/)
    }
  }
})

test('procfs and admission validators reject coordinated semantic forgeries with every digest recomputed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-coordinated-admission-'))
  await chmod(root, 0o700)
  const fixture = procfsCustody(root)
  const { environment, allowance, liveEnvironment, validatedLive, priorGates } = fixture
  const classify = (input) => classifyProcEnvironment(input, environment, allowance, validatedLive, priorGates)
  const observationWith = (observation, mutate) => {
    const forged = structuredClone(observation)
    mutate(forged)
    delete forged.procfsObservationBindingSha256
    forged.procfsObservationBindingSha256 = domainHash(
      'modly.worlds-c3-procfs-observation-binding.v4', forged)
    return forged
  }
  const fieldsFor = (procfs) => ({
    validated: validatedLive,
    allowance,
    manifestFileSha256: sha256(fixture.manifestBytes),
    launchBindingSha256: fixture.build.launch.launchBindingSha256,
    supervisorReceiptSha256: sha256(JSON.stringify(fixture.receipt)),
    supervisorPid: process.ppid,
    bootstrapPid: process.pid,
    priorGates,
    procfs,
    build: fixture.build,
    expectedUid: process.getuid(),
  })
  const admissionWith = (receipt, procfs) => {
    const forged = structuredClone(receipt)
    forged.procfs = structuredClone(procfs)
    forged.procfsObservationSha256 = procfs.procfsObservationBindingSha256
    forged.procfsObservationFileSha256 = sha256(Buffer.from(`${JSON.stringify(procfs)}\n`))
    delete forged.environmentAdmissionBindingSha256
    forged.environmentAdmissionBindingSha256 = domainHash(
      'modly.worlds-c3-environment-admission-binding.v5', forged)
    return forged
  }
  const observations = {
    empty: classify({ bytes: Buffer.alloc(0) }),
    unavailable: classify({ errorCode: 'ENOENT' }),
    incomplete: classify({ bytes: procfsBytes({ HOME: liveEnvironment.HOME }) }),
    sealed: classify({ bytes: procfsBytes(environment) }),
    full: classify({ bytes: procfsBytes(liveEnvironment) }),
    malformedSealed: classify({ bytes: procfsBytes(environment, [Buffer.from('OPAQUE_WITHOUT_EQUALS')]) }),
    malformedFull: classify({ bytes: procfsBytes(liveEnvironment, [Buffer.from('OPAQUE_WITHOUT_EQUALS')]) }),
    malformedTerminal: classify({ bytes: procfsBytes(environment, [], false) }),
  }
  const forgeries = [
    ['empty digest', observations.empty, (copy) => { copy.sha256 = '0'.repeat(64) }],
    ['unavailable records', observations.unavailable, (copy) => {
      copy.recordSlotCount = 1; copy.malformedRecordCount = 1
    }],
    ['reviewer incomplete probe', observations.incomplete, (copy) => {
      copy.wellFormedRecordCount = 0; copy.malformedRecordCount = 1
    }],
    ['incomplete subset/count/complement', observations.incomplete, (copy) => {
      copy.knownMatchingNames = []
      copy.knownMatchingCount = 0
      copy.missingLiveNames = Object.keys(liveEnvironment).sort()
      copy.missingLiveCount = copy.missingLiveNames.length
      copy.knownMatchingSubsetSha256 = domainHash(
        'modly.worlds-c3-procfs-known-subset.v1', [allowance.liveEnvironmentAdmissionSha256, []])
      copy.recordSlotCount = 0
      copy.wellFormedRecordCount = 0
    }],
    ['sealed record relation', observations.sealed, (copy) => {
      copy.wellFormedRecordCount -= 1; copy.malformedRecordCount = 1
    }],
    ['full record relation', observations.full, (copy) => {
      copy.wellFormedRecordCount -= 1; copy.malformedRecordCount = 1
    }],
    ['malformed sealed reason relation', observations.malformedSealed, (copy) => {
      copy.wellFormedRecordCount += 1; copy.malformedRecordCount -= 1
    }],
    ['malformed full reason relation', observations.malformedFull, (copy) => {
      copy.wellFormedRecordCount += 1; copy.malformedRecordCount -= 1
    }],
    ['terminal NUL reason relation', observations.malformedTerminal, (copy) => { copy.terminalNul = true }],
  ]
  for (const [label, observation, mutate] of forgeries) {
    assert.equal(observation.accepted, true, label)
    const procfsObservationPath = path.join(root, 'procfs-observation.v4.json')
    persistProcfsObservation(procfsObservationPath, observation, process.getuid(),
      environment, allowance, validatedLive, priorGates)
    const originalFields = fieldsFor(observation)
    const receipt = createEnvironmentAdmissionReceipt(originalFields)
    const forgedObservation = observationWith(observation, mutate)
    const forgedFields = fieldsFor(forgedObservation)
    const forgedReceipt = admissionWith(receipt, forgedObservation)
    assert.throws(() => validateProcfsObservation(
      forgedObservation, environment, allowance, validatedLive, priorGates), /procfs/i, label)
    assert.throws(() => createEnvironmentAdmissionReceipt(forgedFields), /procfs/i, label)
    assert.throws(() => validateEnvironmentAdmissionReceipt(forgedReceipt, forgedFields), /procfs/i, label)
    await unlink(procfsObservationPath)
  }

  const fatalUnknown = classify({ bytes: procfsRecordBytes([Buffer.from('UNKNOWN_SENTINEL=RAW_SECRET_VALUE')]) })
  const forgedFatal = observationWith(fatalUnknown, (copy) => { copy.contradictedKnownNames = ['HOME'] })
  assert.throws(() => validateProcfsObservation(
    forgedFatal, environment, allowance, validatedLive, priorGates), /procfs/i)
})

test('admission v5 derives the exact custody-protected persisted-observation path and file digest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-admission-file-binding-'))
  await chmod(root, 0o700)
  const fixture = procfsCustody(root)
  const { environment, allowance, liveEnvironment, validatedLive, priorGates } = fixture
  const procfs = classifyProcEnvironment({ bytes: procfsBytes({ HOME: liveEnvironment.HOME }) },
    environment, allowance, validatedLive, priorGates)
  const procfsObservationPath = path.join(root, 'procfs-observation.v4.json')
  const persisted = persistProcfsObservation(procfsObservationPath, procfs, process.getuid(),
    environment, allowance, validatedLive, priorGates)
  const fields = {
    validated: validatedLive,
    allowance,
    manifestFileSha256: sha256(fixture.manifestBytes),
    launchBindingSha256: fixture.build.launch.launchBindingSha256,
    supervisorReceiptSha256: sha256(JSON.stringify(fixture.receipt)),
    supervisorPid: process.ppid,
    bootstrapPid: process.pid,
    priorGates,
    procfs,
    build: fixture.build,
    expectedUid: process.getuid(),
  }
  const receipt = createEnvironmentAdmissionReceipt(fields)
  assert.equal(receipt.procfsObservationPath, procfsObservationPath)
  assert.equal(receipt.procfsObservationFileSha256, persisted.fileSha256)
  const forgedReceipt = structuredClone(receipt)
  forgedReceipt.procfsObservationFileSha256 = '0'.repeat(64)
  delete forgedReceipt.environmentAdmissionBindingSha256
  forgedReceipt.environmentAdmissionBindingSha256 = domainHash(
    'modly.worlds-c3-environment-admission-binding.v5', forgedReceipt)
  assert.throws(() => validateEnvironmentAdmissionReceipt(forgedReceipt, fields), /procfs|persisted|file|binding/i)
  assert.throws(() => createEnvironmentAdmissionReceipt({
    ...fields, procfsObservationFileSha256: '0'.repeat(64),
  }), /keys|admission/i)

  const staleRoot = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-admission-stale-file-'))
  await chmod(staleRoot, 0o700)
  const stalePath = path.join(staleRoot, 'procfs-observation.v4.json')
  const staleObservation = classifyProcEnvironment({ bytes: Buffer.alloc(0) },
    environment, allowance, validatedLive, priorGates)
  persistProcfsObservation(stalePath, staleObservation, process.getuid(),
    environment, allowance, validatedLive, priorGates)
  assert.throws(() => createEnvironmentAdmissionReceipt({ ...fields, procfsObservationPath: stalePath }),
    /keys|admission/i)
  const reboundRoot = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-admission-rebound-file-'))
  await chmod(reboundRoot, 0o700)
  const reboundPath = path.join(reboundRoot, 'procfs-observation.v4.json')
  await writeFile(reboundPath, await readFile(procfsObservationPath), { flag: 'wx', mode: 0o600 })
  const reboundBuild = structuredClone(fixture.build)
  reboundBuild.launch.paths.stateRoot = reboundRoot
  assert.throws(() => createEnvironmentAdmissionReceipt({ ...fields, build: reboundBuild }),
    /canonical launch binding/i)
  const reboundReceipt = structuredClone(receipt)
  reboundReceipt.procfsObservationPath = reboundPath
  delete reboundReceipt.environmentAdmissionBindingSha256
  reboundReceipt.environmentAdmissionBindingSha256 = domainHash(
    'modly.worlds-c3-environment-admission-binding.v5', reboundReceipt)
  assert.throws(() => validateEnvironmentAdmissionReceipt(reboundReceipt, fields), /path binding/i)
  const exactPersistedBytes = await readFile(procfsObservationPath)
  await writeFile(procfsObservationPath, Buffer.concat([exactPersistedBytes, Buffer.from(' ')]))
  assert.throws(() => createEnvironmentAdmissionReceipt(fields), /persisted observation bytes changed/i)
  await writeFile(procfsObservationPath, exactPersistedBytes)
  await chmod(procfsObservationPath, 0o644)
  assert.throws(() => createEnvironmentAdmissionReceipt(fields), /mode|custody/i)
})

test('fatal duplicate-known evidence cannot erase the exact contradicted known name after rebinding', () => {
  const { environment, allowance, liveEnvironment, validatedLive, priorGates } = procfsCustody()
  const records = Object.entries(liveEnvironment).map(([name, value]) => Buffer.from(`${name}=${value}`))
  records.push(Buffer.from(`HOME=${liveEnvironment.HOME}`))
  const observation = classifyProcEnvironment({ bytes: procfsRecordBytes(records) },
    environment, allowance, validatedLive, priorGates)
  assert.equal(observation.status, 'FATAL')
  assert.equal(observation.duplicateRecordCount, 1)
  assert.deepEqual(observation.contradictedKnownNames, ['HOME'])
  const forged = structuredClone(observation)
  forged.contradictedKnownNames = []
  delete forged.procfsObservationBindingSha256
  forged.procfsObservationBindingSha256 = domainHash(
    'modly.worlds-c3-procfs-observation-binding.v4', forged)
  assert.throws(() => validateProcfsObservation(
    forged, environment, allowance, validatedLive, priorGates), /procfs|contradicted|duplicate/i)
})

test('mixed unknown records cannot hide a rebound duplicate-known contradiction name', () => {
  const { environment, allowance, liveEnvironment, validatedLive, priorGates } = procfsCustody()
  const records = Object.entries(liveEnvironment).map(([name, value]) => Buffer.from(`${name}=${value}`))
  records.push(Buffer.from(`HOME=${liveEnvironment.HOME}`),
    Buffer.from('UNKNOWN_ALPHA=RAW_SECRET_ALPHA'), Buffer.from('UNKNOWN_BETA=RAW_SECRET_BETA'))
  const observation = classifyProcEnvironment({ bytes: procfsRecordBytes(records) },
    environment, allowance, validatedLive, priorGates)
  assert.equal(observation.status, 'FATAL')
  assert.equal(observation.duplicateRecordCount, 1)
  assert.equal(observation.unknownRecordCount, 2)
  assert.deepEqual(observation.contradictedKnownNames, ['HOME'])
  assert.deepEqual(observation.knownRecordCounts,
    Object.keys(liveEnvironment).sort().map((name) => [name, name === 'HOME' ? 2 : 1]))
  const forged = structuredClone(observation)
  forged.contradictedKnownNames = []
  delete forged.procfsObservationBindingSha256
  forged.procfsObservationBindingSha256 = domainHash(
    'modly.worlds-c3-procfs-observation-binding.v4', forged)
  assert.throws(() => validateProcfsObservation(
    forged, environment, allowance, validatedLive, priorGates), /procfs|contradicted|duplicate/i)
  assert.doesNotMatch(JSON.stringify(observation), /UNKNOWN_ALPHA|UNKNOWN_BETA|RAW_SECRET/)
})

test('procfs v5 keeps every per-key contradiction fatal and persists only sanitized failure evidence', async () => {
  const { environment, allowance, liveEnvironment, validatedLive, priorGates } = procfsCustody()
  const entries = Object.entries(liveEnvironment)
  const classify = (bytes) => classifyProcEnvironment(
    { bytes }, environment, allowance, validatedLive, priorGates)
  let caseNumber = 0
  const assertPersistedFatal = async (bytes) => {
    const result = classify(bytes)
    assert.equal(result.status, 'FATAL')
    assert.equal(result.accepted, false)
    let thrown
    try { requireAcceptedProcfsObservation(result) } catch (error) { thrown = error }
    assert.equal(thrown?.message, 'Procfs environment classification failed.')
    const root = await mkdtemp(path.join(os.tmpdir(), `modly-c3-procfs-fatal-${caseNumber++}-`))
    await chmod(root, 0o700)
    const filename = path.join(root, 'procfs-observation.v4.json')
    persistProcfsObservation(filename, result, process.getuid(), environment, allowance, validatedLive, priorGates)
    const serialized = await readFile(filename, 'utf8')
    assert.doesNotMatch(serialized, /TOP_SECRET_CHANGED|UNKNOWN_SENTINEL|RAW_SECRET_VALUE|electron\.desktop|disabled:/)
    assert.equal(await lstat(path.join(root, 'environment-admission.v5.json')).then(() => true, () => false), false)
    assert.equal(await lstat(path.join(root, 'startup-attempt.json')).then(() => true, () => false), false)
    return result
  }
  for (const [targetName] of entries) {
    const omitted = Object.fromEntries(entries.filter(([name]) => name !== targetName))
    assert.equal(classify(procfsBytes(omitted)).status, 'INCOMPLETE_NON_AUTHORITATIVE')
    await assertPersistedFatal(procfsBytes({ ...liveEnvironment, [targetName]: 'TOP_SECRET_CHANGED' }))
    await assertPersistedFatal(procfsRecordBytes([
      ...entries.map(([name, value]) => Buffer.from(`${name}=${value}`)),
      Buffer.from(`${targetName}=${liveEnvironment[targetName]}`),
    ]))
    await assertPersistedFatal(procfsRecordBytes([
      ...entries.map(([name, value]) => Buffer.from(`${name}=${value}`)),
      Buffer.from(`${targetName}=TOP_SECRET_CHANGED`),
    ]))
    await assertPersistedFatal(procfsRecordBytes(entries.map(([name, value]) => name === targetName
      ? Buffer.concat([Buffer.from(`${name}=`), Buffer.from([0xff])])
      : Buffer.from(`${name}=${value}`))))
  }
  const records = entries.map(([name, value]) => Buffer.from(`${name}=${value}`))
  for (const position of [0, Math.floor(records.length / 2), records.length]) {
    const withUnknown = [...records]
    withUnknown.splice(position, 0, Buffer.from('UNKNOWN_SENTINEL=RAW_SECRET_VALUE'))
    const fatal = await assertPersistedFatal(procfsRecordBytes(withUnknown))
    assert.equal(fatal.unknownRecordCount, 1)
    assert.deepEqual(fatal.contradictedKnownNames, [])
  }
})

test('procfs structural noise is secret-safe and non-authoritative only beside a complete accepted set', () => {
  const { environment, allowance, liveEnvironment, validatedLive, priorGates } = procfsCustody()
  const classify = (bytes) => classifyProcEnvironment(
    { bytes }, environment, allowance, validatedLive, priorGates)
  const structuralCases = [
    { reason: 'EMPTY_RECORD', malformed: [Buffer.alloc(0)], malformedCount: 1 },
    { reason: 'MISSING_EQUALS', malformed: [Buffer.from('TOP_SECRET_FRAGMENT')], malformedCount: 1 },
    { reason: 'EMPTY_NAME', malformed: [Buffer.from('=TOP_SECRET_FRAGMENT')], malformedCount: 1 },
    { reason: 'INVALID_NAME', malformed: [Buffer.from('lowercase=TOP_SECRET_FRAGMENT')], malformedCount: 1 },
    { reason: 'INVALID_UTF8', malformed: [Buffer.from([0xff, 0x3d, 0x78])], malformedCount: 1 },
    { reason: 'MISSING_TERMINAL_NUL', malformed: [], terminalNul: false, malformedCount: 0 },
  ]
  for (const [accepted, contract, digest] of [
    [environment, 'SEALED_11', syntheticCustody().build.launch.environmentContract.sha256],
    [liveEnvironment, 'FULL_LIVE_13', allowance.liveEnvironmentAdmissionSha256],
  ]) {
    for (const entry of structuralCases) {
      const bytes = procfsBytes(accepted, entry.malformed, entry.terminalNul ?? true)
      const result = classify(bytes)
      assert.equal(result.status, 'MALFORMED_NON_AUTHORITATIVE')
      assert.equal(result.byteLength, bytes.length)
      assert.equal(result.sha256, sha256(bytes))
      assert.equal(result.malformedRecordCount, entry.malformedCount)
      assert.equal(result.structuralDefectCount, 1)
      assert.deepEqual(result.malformedReasons, [[entry.reason, 1]])
      assert.equal(result.corroboratedContract, contract)
      assert.equal(result.corroboratedContractSha256, digest)
      assert.deepEqual(result.knownMatchingNames, Object.keys(accepted).sort())
      assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET_FRAGMENT|disabled:|electron\.desktop/)
      assert.doesNotThrow(() => validateProcfsObservation(result, environment, allowance))
    }
    const multipleBytes = procfsBytes(accepted, [Buffer.alloc(0), Buffer.from('TOP_SECRET_FRAGMENT')])
    const multiple = classify(multipleBytes)
    assert.deepEqual(multiple.malformedReasons, [['EMPTY_RECORD', 1], ['MISSING_EQUALS', 1]])
    assert.equal(multiple.malformedRecordCount, 2)
    assert.equal(multiple.structuralDefectCount, 2)
  }
  const incomplete = { HOME: liveEnvironment.HOME }
  for (const entry of structuralCases) {
    const result = classify(procfsBytes(incomplete, entry.malformed, entry.terminalNul ?? true))
    assert.equal(result.status, 'FATAL')
    assert.equal(result.accepted, false)
    assert.deepEqual(result.knownMatchingNames, ['HOME'])
    assert.ok(result.structuralDefectCount > 0)
  }
  const multipleIncomplete = classify(procfsBytes(incomplete,
    [Buffer.alloc(0), Buffer.from('TOP_SECRET_FRAGMENT'), Buffer.from('=TOP_SECRET_FRAGMENT')]))
  assert.equal(multipleIncomplete.status, 'FATAL')
  assert.equal(multipleIncomplete.structuralDefectCount, 3)
  assert.deepEqual(multipleIncomplete.malformedReasons,
    [['EMPTY_NAME', 1], ['EMPTY_RECORD', 1], ['MISSING_EQUALS', 1]])
  assert.doesNotMatch(JSON.stringify(multipleIncomplete), /TOP_SECRET_FRAGMENT|disabled:|electron\.desktop/)
})

test('procfs parseable contradictions remain fatal even alongside structural noise', () => {
  const { environment, allowance, liveEnvironment, validatedLive, priorGates } = procfsCustody()
  const classify = (bytes) => classifyProcEnvironment(
    { bytes }, environment, allowance, validatedLive, priorGates)
  const assertFatal = (bytes) => {
    const result = classify(bytes)
    assert.equal(result.status, 'FATAL')
    assert.equal(result.accepted, false)
    assert.throws(() => requireAcceptedProcfsObservation(result), /procfs environment classification failed/i)
    assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET|disabled:|electron\.desktop|PARSEABLE_EXTRA/)
    return result
  }
  const malformed = [Buffer.from('OPAQUE_WITHOUT_EQUALS')]
  for (const accepted of [environment, liveEnvironment]) {
    const entries = Object.entries(accepted)
    const first = entries[0]
    const otherValue = first[1] === 'TOP_SECRET_CHANGED' ? 'other' : 'TOP_SECRET_CHANGED'
    for (const [name] of entries) {
      assertFatal(procfsBytes(Object.fromEntries(entries.filter(([candidate]) => candidate !== name)), malformed))
      assertFatal(procfsBytes({ ...accepted, [name]: 'TOP_SECRET_CHANGED' }, malformed))
    }
    const fatal = [
      procfsBytes(Object.fromEntries(entries.slice(1)), malformed),
      procfsBytes({ ...accepted, [first[0]]: otherValue }, malformed),
      procfsBytes(accepted, [...malformed, Buffer.from('PARSEABLE_EXTRA=TOP_SECRET')]),
      procfsBytes(accepted, [...malformed, Buffer.from(`${first[0]}=${first[1]}`)]),
      procfsBytes(accepted, [...malformed, Buffer.from(`${first[0]}=TOP_SECRET_CHANGED`)]),
      procfsRecordBytes([
        Buffer.from(`${first[0]}=${first[1]}`), Buffer.from('OPAQUE_WITHOUT_EQUALS'),
        ...entries.map(([name, value]) => Buffer.from(`${name}=${value}`)),
      ]),
      procfsBytes(Object.fromEntries(entries.slice(1)), [Buffer.from(first[0])]),
      procfsRecordBytes(entries.map(([name, value], index) => index === 0
        ? Buffer.concat([Buffer.from(`${name}=`), Buffer.from([0xff])])
        : Buffer.from(`${name}=${value}`))),
    ]
    for (const bytes of fatal) {
      assertFatal(bytes)
    }
  }
  const onlyChrome = { ...environment, CHROME_DESKTOP: allowance.entries[0].value }
  assertFatal(procfsBytes(onlyChrome, malformed))
  const onlyFontations = { ...environment, FC_FONTATIONS: allowance.entries[1].value }
  assertFatal(procfsBytes(onlyFontations, malformed))
})

test('procfs malformed classification requires exact same-invocation prior-gate proof', () => {
  const { environment, allowance, validatedLive, priorGates } = procfsCustody()
  const malformed = procfsBytes(environment, [Buffer.from('OPAQUE_WITHOUT_EQUALS')])
  assert.equal(classifyProcEnvironment({ bytes: malformed }, environment, allowance, validatedLive, priorGates).status,
    'MALFORMED_NON_AUTHORITATIVE')
  assert.throws(() => classifyProcEnvironment({ bytes: malformed }, environment, allowance), /prior|gate|validated/i)
  const mutations = [
    (copy) => { copy.schema = 'forged' }, (copy) => { copy.validatedLiveSha256 = '0'.repeat(64) },
    (copy) => { copy.manifestFileSha256 = '0'.repeat(64) }, (copy) => { copy.launchBindingSha256 = '0'.repeat(64) },
    (copy) => { copy.supervisorReceiptSha256 = '0'.repeat(64) }, (copy) => { copy.supervisorPid += 1 },
    (copy) => { copy.bootstrapPid += 1 }, (copy) => { copy.baseEnvironmentContractSha256 = '0'.repeat(64) },
    (copy) => { copy.runtimeEnvironmentAllowanceSha256 = '0'.repeat(64) },
    (copy) => { copy.runtimeIdentitySha256 = '0'.repeat(64) },
    (copy) => { copy.liveEnvironmentAdmissionSha256 = '0'.repeat(64) },
    (copy) => { copy.sourceAggregateSha256 = '0'.repeat(64) },
    (copy) => { copy.outputReceiptsSha256 = '0'.repeat(64) },
    (copy) => { copy.authorityGateSha256 = '0'.repeat(64) },
    (copy) => { copy.sandboxGateSha256 = '0'.repeat(64) },
    (copy) => { copy.buildReceiptGatesPassed = false },
    (copy) => { copy.priorGateBindingSha256 = '0'.repeat(64) },
    (copy) => { copy.extra = true }, (copy) => { delete copy.manifestFileSha256 },
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(priorGates)
    mutate(changed)
    assert.throws(() => classifyProcEnvironment(
      { bytes: malformed }, environment, allowance, validatedLive, changed), /procfs|prior|gate|binding|keys/i)
  }
  for (const mutate of [
    (copy) => { copy.base.count -= 1 }, (copy) => { copy.additions.count -= 1 },
    (copy) => { copy.runtimeIdentitySha256 = '0'.repeat(64) },
    (copy) => { copy.liveEnvironmentAdmissionSha256 = '0'.repeat(64) },
    (copy) => { copy.extra = true }, (copy) => { delete copy.base },
  ]) {
    const changed = structuredClone(validatedLive)
    mutate(changed)
    assert.throws(() => classifyProcEnvironment(
      { bytes: malformed }, environment, allowance, changed, priorGates), /procfs|validated|gate|binding|keys/i)
  }
  const staleBuildProof = createProcfsPriorGateProof({
    validatedLive,
    manifestFileSha256: '1'.repeat(64),
    launchBindingSha256: '2'.repeat(64),
    supervisorReceiptSha256: '3'.repeat(64),
    supervisorPid: process.ppid,
    bootstrapPid: process.pid,
    sourceAggregateSha256: '4'.repeat(64),
    outputReceiptsSha256: priorGates.outputReceiptsSha256,
    authorityGateSha256: priorGates.authorityGateSha256,
    sandboxGateSha256: priorGates.sandboxGateSha256,
    buildReceiptGatesPassed: true,
  })
  const staleObservation = classifyProcEnvironment(
    { bytes: malformed }, environment, allowance, validatedLive, staleBuildProof)
  assert.throws(() => validateProcfsObservation(
    staleObservation, environment, allowance, validatedLive, priorGates), /prior-gate proof changed/i)
})

test('procfs v4 observation receipt persists pass and fatal evidence exactly once without secrets', async () => {
  const { build, environment, allowance, liveEnvironment, validatedLive, priorGates } = procfsCustody()
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-procfs-v4-receipt-'))
  await chmod(root, 0o700)
  const sealedByteLength = build.launch.environmentContract.entries.reduce((total, [name, valueByteLength]) =>
    total + Buffer.byteLength(name) + 1 + valueByteLength + 1, 0)
  const observations = [
    classifyProcEnvironment({ bytes: Buffer.alloc(sealedByteLength) },
      environment, allowance, validatedLive, priorGates),
    classifyProcEnvironment({ bytes: procfsBytes({ HOME: liveEnvironment.HOME }) },
      environment, allowance, validatedLive, priorGates),
    classifyProcEnvironment({ bytes: procfsRecordBytes([Buffer.from('UNKNOWN_SENTINEL=RAW_SECRET_VALUE')]) },
      environment, allowance, validatedLive, priorGates),
  ]
  assert.deepEqual(observations.map((entry) => entry.accepted), [true, true, false])
  for (const [index, observation] of observations.entries()) {
    const caseRoot = path.join(root, String(index))
    await mkdir(caseRoot, { mode: 0o700 })
    const filename = path.join(caseRoot, 'procfs-observation.v4.json')
    const persisted = persistProcfsObservation(filename, observation, process.getuid(),
      environment, allowance, validatedLive, priorGates)
    assert.match(persisted.fileSha256, /^[a-f0-9]{64}$/)
    assert.equal((await lstat(filename)).mode & 0o777, 0o600)
    const serialized = await readFile(filename, 'utf8')
    assert.doesNotMatch(serialized, /UNKNOWN_SENTINEL|RAW_SECRET_VALUE|native-state|electron\.desktop/)
    assert.throws(() => persistProcfsObservation(filename, observation, process.getuid(),
      environment, allowance, validatedLive, priorGates), /EEXIST/)
  }
})

test('supervisor pre-exec receipt is exact, manifest-bound, parent-bound, and rejects forgery or staleness', () => {
  const fixture = syntheticCustody()
  assert.doesNotThrow(() => validateSupervisorReceipt(fixture.build, fixture.manifestBytes, fixture.receipt, 4242))
  for (const mutate of [
    (copy) => { copy.manifestFileSha256 = '0'.repeat(64) },
    (copy) => { copy.launchBindingSha256 = '0'.repeat(64) },
    (copy) => { copy.environmentContractSha256 = '0'.repeat(64) },
    (copy) => { copy.environmentEntries[0][2] = '0'.repeat(64) },
    (copy) => { copy.argvSha256 = '0'.repeat(64) },
    (copy) => { copy.schema = 'forged' },
    (copy) => { copy.supervisorPid = 1 },
    (copy) => { copy.supervisorUid += 1 },
    (copy) => { copy.xvfbPid = 1 },
    (copy) => { copy.display = ':999' },
    (copy) => { copy.authorityPath = '/tmp/forged' },
    (copy) => { copy.authority.uid += 1 },
    (copy) => { copy.authority.mode = '644' },
    (copy) => { copy.authority.nlink = 2 },
    (copy) => { copy.authenticatedReady = false },
    (copy) => { copy.extra = true },
    (copy) => { delete copy.phase },
  ]) {
    const forged = structuredClone(fixture.receipt)
    mutate(forged)
    assert.throws(() => validateSupervisorReceipt(fixture.build, fixture.manifestBytes, forged, 4242),
      /supervisor|receipt|binding|manifest|environment|argv|schema|uid|xvfb|display|authority|readiness/i)
  }
  assert.throws(() => validateSupervisorReceipt(fixture.build, fixture.manifestBytes, fixture.receipt, 9999), /parent/i)
  assert.throws(() => validateSupervisorReceipt(fixture.build, Buffer.from(`${fixture.manifestBytes} `), fixture.receipt, 4242), /manifest/i)
  const other = syntheticCustody()
  other.build.sourceAggregateSha256 = 'c'.repeat(64)
  other.build.launch.launchBindingSha256 = createLaunchBindingSha256(other.build)
  assert.throws(() => validateSupervisorReceipt(other.build, fixture.manifestBytes, fixture.receipt, 4242), /binding/i)
})

test('environment admission v5 binds prior gates and persisted procfs evidence exactly once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-admission-once-'))
  await chmod(root, 0o700)
  const fixture = procfsCustody(root)
  const { allowance, validatedLive: validated, priorGates } = fixture
  const sealedByteLength = fixture.build.launch.environmentContract.entries.reduce((total, [name, valueByteLength]) =>
    total + Buffer.byteLength(name) + 1 + valueByteLength + 1, 0)
  const procfs = classifyProcEnvironment({ bytes: Buffer.alloc(sealedByteLength) },
    fixture.environment, allowance, validated, priorGates)
  const procfsObservationPath = path.join(root, 'procfs-observation.v4.json')
  const procfsReceipt = persistProcfsObservation(procfsObservationPath, procfs, process.getuid(),
    fixture.environment, allowance, validated, priorGates)
  const fields = {
    validated,
    allowance,
    manifestFileSha256: sha256(fixture.manifestBytes),
    launchBindingSha256: fixture.build.launch.launchBindingSha256,
    supervisorReceiptSha256: sha256(JSON.stringify(fixture.receipt)),
    supervisorPid: process.ppid,
    bootstrapPid: process.pid,
    priorGates,
    procfs,
    build: fixture.build,
    expectedUid: process.getuid(),
  }
  const receipt = createEnvironmentAdmissionReceipt(fields)
  assert.equal(receipt.schema, 'modly.worlds-c3-environment-admission.v5')
  assert.equal(receipt.status, 'PASS_EXACT_RUNTIME_BOUND_ENVIRONMENT')
  assert.equal(receipt.base.count, 11)
  assert.equal(receipt.additions.count, 2)
  assert.equal(receipt.procfs.status, 'ZERO_FILLED_NON_AUTHORITATIVE')
  assert.equal(receipt.priorGateBindingSha256, priorGates.priorGateBindingSha256)
  assert.equal(receipt.procfsObservationSha256, procfs.procfsObservationBindingSha256)
  assert.equal(receipt.procfsObservationPath, procfsObservationPath)
  assert.equal(receipt.procfsObservationFileSha256, procfsReceipt.fileSha256)
  const { environmentAdmissionBindingSha256, ...bindingProjection } = receipt
  assert.equal(environmentAdmissionBindingSha256,
    domainHash('modly.worlds-c3-environment-admission-binding.v5', bindingProjection))
  assert.doesNotMatch(JSON.stringify(receipt), /OPAQUE_WITHOUT_EQUALS|(?:chatgpt|electron)\.desktop|disabled:/)
  assert.doesNotThrow(() => validateEnvironmentAdmissionReceipt(receipt, fields))
  for (const key of ['manifestFileSha256', 'launchBindingSha256', 'supervisorReceiptSha256',
    'supervisorPid', 'bootstrapPid']) {
    const changedFields = structuredClone(fields)
    changedFields[key] = typeof changedFields[key] === 'number' ? changedFields[key] + 1 : '0'.repeat(64)
    assert.throws(() => createEnvironmentAdmissionReceipt(changedFields),
      /prior-gate field changed|manifest launch binding changed/i)
  }

  for (const key of Object.keys(receipt.procfs)) {
    const changed = structuredClone(receipt)
    changed.procfs[key] = tamperValue(changed.procfs[key])
    assert.throws(() => validateEnvironmentAdmissionReceipt(changed, fields), /.+/)
    const deleted = structuredClone(receipt)
    delete deleted.procfs[key]
    assert.throws(() => validateEnvironmentAdmissionReceipt(deleted, fields), /.+/)
  }
  const rawInjected = structuredClone(receipt)
  rawInjected.procfs.raw = 'OPAQUE_WITHOUT_EQUALS'
  assert.throws(() => validateEnvironmentAdmissionReceipt(rawInjected, fields), /procfs|keys/i)

  for (const key of Object.keys(receipt)) {
    const changed = structuredClone(receipt)
    changed[key] = tamperValue(changed[key])
    assert.throws(() => validateEnvironmentAdmissionReceipt(changed, fields), /.+/)
    const deleted = structuredClone(receipt)
    delete deleted[key]
    assert.throws(() => validateEnvironmentAdmissionReceipt(deleted, fields), /.+/)
  }
  const added = structuredClone(receipt)
  added.extra = true
  assert.throws(() => validateEnvironmentAdmissionReceipt(added, fields), /keys|receipt/i)

  for (const mutate of [
    (copy) => { copy.base.count = 10 }, (copy) => { copy.base.names.pop() },
    (copy) => { copy.base.entries[0][0] = 'WRONG' }, (copy) => { copy.base.entries[0][1] += 1 },
    (copy) => { copy.base.entries[0][2] = '0'.repeat(64) }, (copy) => { copy.base.sha256 = '0'.repeat(64) },
    (copy) => { copy.additions.count = 1 }, (copy) => { copy.additions.names.reverse() },
    (copy) => { copy.additions.entries[0][0] = 'WRONG' }, (copy) => { copy.additions.entries[0][1] += 1 },
    (copy) => { copy.additions.entries[0][2] = '0'.repeat(64) },
    (copy) => { copy.additions.runtimeEnvironmentAllowanceSha256 = '0'.repeat(64) },
    (copy) => { copy.runtimeIdentity.schema = 'forged' }, (copy) => { copy.runtimeIdentity.electronVersion = '44.1.2' },
    (copy) => { copy.runtimeIdentity.platform = 'darwin' }, (copy) => { copy.runtimeIdentity.arch = 'x64' },
    (copy) => { copy.runtimeIdentity.executable.path = '/tmp/forged' },
    (copy) => { copy.runtimeIdentity.executable.sha256 = '0'.repeat(64) },
    (copy) => { copy.procfs.malformedReasons[0][0] = 'INVALID_NAME' },
    (copy) => { copy.procfs.malformedReasons[0][1] += 1 },
    (copy) => { copy.procfs.priorGates.manifestFileSha256 = '0'.repeat(64) },
  ]) {
    const changed = structuredClone(receipt)
    mutate(changed)
    assert.throws(() => validateEnvironmentAdmissionReceipt(changed, fields), /.+/)
  }
  const filename = path.join(root, 'environment-admission.v5.json')
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
  const validatePersistedAdmission = () => {
    const persistedBytes = secureReadPrivateFile(filename, process.getuid())
    assert.deepEqual(persistedBytes, receiptBytes, 'Environment admission persisted bytes changed.')
    return validateEnvironmentAdmissionReceipt(JSON.parse(persistedBytes.toString('utf8')), fields)
  }
  await writeFile(filename, receiptBytes, { flag: 'wx', mode: 0o600 })
  assert.doesNotThrow(validatePersistedAdmission)
  await writeFile(filename, Buffer.concat([receiptBytes, Buffer.from(' ')]))
  assert.throws(validatePersistedAdmission, /persisted bytes changed/i)
  await writeFile(filename, receiptBytes)
  await assert.rejects(() => writeFile(filename, receiptBytes, { flag: 'wx', mode: 0o600 }), /EEXIST/)
  assert.equal((await lstat(filename)).mode & 0o777, 0o600)
})

test('emitted pre-exec receipt format accepts real GNU stat octal mode text', async () => {
  const fixture = syntheticCustody()
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-mode-format-'))
  const authority = path.join(root, 'Xauthority')
  await writeFile(authority, 'authority', { mode: 0o600 })
  await chmod(authority, 0o600)
  const info = await lstat(authority)
  const statMode = spawnSync('/usr/bin/stat', ['-c', '%a', authority], { encoding: 'utf8' }).stdout.trim()
  assert.equal(statMode, '600')
  const format = nativeSupervisorPreexecReceiptFormat(fixture.build.launch)
  const rendered = spawnSync('/usr/bin/printf', [format, sha256(fixture.manifestBytes), '4242', String(process.getuid()), '4243',
    String(info.uid), statMode, String(info.nlink)], { encoding: 'utf8' })
  assert.equal(rendered.status, 0, rendered.stderr)
  const receipt = JSON.parse(rendered.stdout)
  assert.equal(receipt.authority.mode, '600')
  assert.doesNotThrow(() => validateSupervisorReceipt(fixture.build, fixture.manifestBytes, receipt, 4242))
})

test('private manifest, both evidence receipts, and Xauthority reject symlink, wrong mode/owner, and hard links', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-custody-test-'))
  await chmod(root, 0o700)
  for (const name of ['fixture-build.json', 'supervisor-preexec.v2.json', 'procfs-observation.v4.json',
    'environment-admission.v5.json', 'Xauthority']) {
    const filename = path.join(root, name)
    await writeFile(filename, 'custody', { mode: 0o600 })
    assert.equal(secureReadPrivateFile(filename, process.getuid(), 0o600).toString(), 'custody')
    await chmod(filename, 0o644)
    assert.throws(() => secureReadPrivateFile(filename, process.getuid(), 0o600), /mode|custody/i)
    await chmod(filename, 0o600)
    assert.throws(() => secureReadPrivateFile(filename, process.getuid() + 1, 0o600), /owner|custody/i)
    const hardlink = `${filename}.hard`
    await link(filename, hardlink)
    assert.throws(() => secureReadPrivateFile(filename, process.getuid(), 0o600), /link|custody/i)
    await unlink(hardlink)
    const symbolic = `${filename}.symbolic`
    await symlink(filename, symbolic)
    assert.throws(() => secureReadPrivateFile(symbolic, process.getuid(), 0o600), /symbolic|ELOOP|custody/i)
  }
})

test('procfs and admission receipts reject precreated files, links, directories, overwrite, and reuse', async () => {
  const { environment, allowance, liveEnvironment, validatedLive, priorGates } = procfsCustody()
  const observation = classifyProcEnvironment({ bytes: procfsBytes({ HOME: liveEnvironment.HOME }) },
    environment, allowance, validatedLive, priorGates)
  const writeExclusive = (filename) => writeFile(filename, 'receipt\n', { flag: 'wx', mode: 0o600 })
  for (const receiptName of ['procfs-observation.v4.json', 'environment-admission.v5.json']) {
    for (const shape of ['file', 'symlink', 'hardlink', 'directory']) {
      const root = await mkdtemp(path.join(os.tmpdir(), `modly-c3-${shape}-`))
      await chmod(root, 0o700)
      const filename = path.join(root, receiptName)
      const source = path.join(root, 'source')
      if (shape === 'file') await writeFile(filename, 'precreated', { mode: 0o644 })
      else if (shape === 'symlink') {
        await writeFile(source, 'source', { mode: 0o600 })
        await symlink(source, filename)
      } else if (shape === 'hardlink') {
        await writeFile(source, 'source', { mode: 0o600 })
        await link(source, filename)
      } else await mkdir(filename, { mode: 0o700 })
      if (receiptName.startsWith('procfs')) {
        assert.throws(() => persistProcfsObservation(filename, observation, process.getuid(),
          environment, allowance, validatedLive, priorGates), /EEXIST/)
      } else await assert.rejects(() => writeExclusive(filename), /EEXIST/)
    }
    const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-exclusive-'))
    const filename = path.join(root, receiptName)
    await writeExclusive(filename)
    await assert.rejects(() => writeExclusive(filename), /EEXIST/)
    assert.equal((await lstat(filename)).mode & 0o777, 0o600)
  }
})

test('supervisor pre-exec receipt creation is single-use under the emitted noclobber recipe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-preexec-once-'))
  const receiptPath = path.join(root, 'supervisor-preexec.json')
  const recipe = 'set -eu; umask 077; test ! -e "$1"; set -C; printf "%s\\n" receipt >"$1"; set +C; chmod 600 "$1"'
  assert.equal(spawnSync('/bin/sh', ['-c', recipe, 'preexec-test', receiptPath]).status, 0)
  assert.notEqual(spawnSync('/bin/sh', ['-c', recipe, 'preexec-test', receiptPath]).status, 0)
  assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600)
})

test('a copied synthetic build fails closed on stale source and output bytes without native launch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-c3-stale-test-'))
  const source = path.join(root, 'source.ts')
  const output = path.join(root, 'main.cjs')
  await writeFile(source, 'source', { mode: 0o600 })
  await writeFile(output, 'output', { mode: 0o600 })
  const copiedBuild = structuredClone(syntheticCustody().build)
  copiedBuild.sourceInputs = [{ path: source, bytes: 6, sha256: sha256('source') }]
  copiedBuild.outputs = { 'main.cjs': { bytes: 6, sha256: sha256('output') } }
  assert.doesNotThrow(() => validateBuildReceipts(copiedBuild, root, process.getuid()))
  await writeFile(source, 'changed', { mode: 0o600 })
  assert.throws(() => validateBuildReceipts(copiedBuild, root, process.getuid()), /stale|receipt/i)
  await writeFile(source, 'source', { mode: 0o600 })
  await writeFile(output, 'changed', { mode: 0o600 })
  assert.throws(() => validateBuildReceipts(copiedBuild, root, process.getuid()), /stale|receipt|hash/i)
})

test('builder accepts build-only and rejects every execution-shaped argument', () => {
  assert.deepEqual(parseBuildArguments(['--build-only']), { buildOnly: true })
  for (const args of [[], ['--run'], ['--build-only', '--run'], ['--build-only=true'], ['--help']]) {
    assert.throws(() => parseBuildArguments(args), /--build-only/)
  }
})

test('builder requires the repository Node 24 runtime and forbids /usr/bin/node', () => {
  assert.equal(Number.parseInt(process.versions.node.split('.')[0], 10), 24)
  assert.notEqual(process.execPath, '/usr/bin/node')
  assert.doesNotThrow(() => assertRepositoryNodeRuntime(process.versions, process.execPath))
  for (const [versions, executable] of [
    [{ node: '18.19.1' }, '/usr/bin/node'],
    [{ node: '23.11.0' }, '/opt/node/bin/node'],
    [{ node: '24.14.1' }, '/usr/bin/node'],
  ]) assert.throws(() => assertRepositoryNodeRuntime(versions, executable), /repository Node 24|forbidden/i)
})

test('the exact twelve-owner fixture composes real production authorities without a test mutation channel', async () => {
  assert.equal(owners.length, 12)
  for (const owner of owners) assert.equal((await stat(path.join(repositoryRoot, owner))).isFile(), true, owner)
  const [bootstrap, main, preload, renderer, driver, shared, inspection, builder] = await Promise.all([
    read('scripts/worlds-codex-direct-edit-electron-fixture/bootstrap.cjs'),
    read('scripts/worlds-codex-direct-edit-electron-fixture/main.ts'),
    read('scripts/worlds-codex-direct-edit-electron-fixture/preload.ts'),
    read('scripts/worlds-codex-direct-edit-electron-fixture/renderer.tsx'),
    read('scripts/worlds-codex-direct-edit-electron-fixture/driver.ts'),
    read('scripts/worlds-codex-direct-edit-electron-fixture/shared.ts'),
    read('scripts/worlds-codex-direct-edit-electron-fixture/inspection.ts'),
    read('scripts/worlds-codex-direct-edit-electron-fixture.mjs'),
  ])
  for (const productionOwner of [
    'WorldProjectRepository', 'registerWorldProjectsIpcHandlers', 'registerWorldsCliEditorContextBroker',
    'registerWorldsCliReadinessBroker', 'registerWorldsCliDirectEditBroker', 'createWorldsCliDirectEditDispatch',
    'WorldsCliTransport',
  ]) assert.match(main, new RegExp(`\\b${productionOwner}\\b`), productionOwner)
  assert.match(preload, /createElectronApi/)
  assert.match(renderer, /<WorldsWorkbench\s*\/?>/)
  assert.match(renderer, /worldEditorController\.subscribe/)
  assert.match(renderer, /useNavStore\.getState\(\)\.navigate\('generate'\)/)
  assert.match(driver, /nativeKeySequence/)
  assert.match(inspection, /canonicalWorldProjectSnapshotPayload/)
  assert.match(shared, /PASS_NATIVE_PRIMARY/)
  assert.match(main, /FIXTURE_SEEDED_PROPOSE/)
  assert.match(preload, /recordObservation/)
  assert.match(renderer, /recordObservation/)
  assert.doesNotMatch(main, /setupIpcHandlers|recordCliAiObservation|\.plans\b|pendingDelivery\s*=|python/i)
  assert.match(main, /execFileAsync\('\/usr\/bin\/git'/)
  assert.doesNotMatch(preload, /directEditCommit['"]\s*\)|directEditAdopt['"]\s*\)|directEditCancel['"]\s*\)|directEditReadinessResponse['"]\s*\)/)
  assert.doesNotMatch(renderer, />[^<{]*(?:Review|CLI|pairing|terminal)[^<{]*</i)
  assert.match(builder, /execFileAsync\('\/usr\/bin\/git'/)
  assert.match(builder, /spawnSync\('\/bin\/sh', \['-n', '-c', script\]/)
  assert.doesNotMatch(builder, /spawn\(|fork\(|python/i)
  assert.match(bootstrap, /validateRuntimeEnvironment\(\s*launch\.environment, launch\.environmentContract, launch\.runtimeEnvironmentAllowance, process\.env, actualRuntimeIdentity\)/)
  assert.match(bootstrap, /EMPTY_NON_AUTHORITATIVE/)
  assert.match(bootstrap, /UNAVAILABLE_NON_AUTHORITATIVE/)
  assert.match(bootstrap, /validateSupervisorReceipt\(build, manifestBytes, supervisorReceipt, process\.ppid\)/)
  assert.match(main, /assertFixtureLaunch\(process\.argv, process\.env, startup\.launch, startup\.assertLiveEnvironment\)/)
  assert.match(shared, /assertLiveEnvironment\(env\)/)
  const linter = new Linter()
  for (const name of ['main.ts', 'preload.ts', 'renderer.tsx', 'driver.ts', 'shared.ts', 'inspection.ts']) {
    const messages = linter.verify(await read(`scripts/worlds-codex-direct-edit-electron-fixture/${name}`),
      [...tseslint.configs.recommended, { rules: { '@typescript-eslint/no-explicit-any': 'error' } }], { filename: name })
    assert.deepEqual(messages, [], `Programmatic fixture lint failed for ${name}`)
  }
})

test('source declares five real inbound/outbound UDS frames and the exact observation gate', async () => {
  const main = await read('scripts/worlds-codex-direct-edit-electron-fixture/main.ts')
  assert.match(main, /\['pair',\s*'plan',\s*'query',\s*'ack',\s*'propose'\]/)
  assert.match(main, /kind:\s*'entities'/)
  assert.match(main, /entityId:\s*TARGET_ENTITY_ID/)
  assert.match(main, /deliveryId/)
  assert.match(main, /direct-edit-dispatched/)
  assert.match(main, /inboundFrames:\s*5/)
  assert.match(main, /outboundFrames:\s*5/)
  assert.doesNotMatch(main, /operation:\s*['"](?:pair\.request|list|open|edit|edit-status|status)['"]/)
})

test('source declares sandbox, custody, three isolated cases, lost-reply and cancellation ordering', async () => {
  const [bootstrap, main, preload, driver] = await Promise.all([
    read('scripts/worlds-codex-direct-edit-electron-fixture/bootstrap.cjs'),
    read('scripts/worlds-codex-direct-edit-electron-fixture/main.ts'),
    read('scripts/worlds-codex-direct-edit-electron-fixture/preload.ts'),
    read('scripts/worlds-codex-direct-edit-electron-fixture/driver.ts'),
  ])
  for (const source of [bootstrap, main]) {
    assert.match(source, /enableSandbox\(\)/)
    for (const flag of ['no-sandbox', 'disable-setuid-sandbox', 'disable-gpu-sandbox', 'disable-web-security']) assert.match(source, new RegExp(flag))
  }
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /onBeforeRequest/)
  assert.match(main, /\['primary',\s*'duplicate-loss',\s*'cancellation'\]/)
  assert.match(main, /50/)
  assert.match(preload, /INJECTED_LOST_COMMIT_REPLY/)
  for (const event of ['request', 'commit-attempt-held', 'navigation-request', 'direct-cancel-ipc', 'cancel-ack-stale', 'held-commit-returns-stale', 'navigation-complete']) {
    assert.match(`${main}\n${driver}`, new RegExp(event))
  }
  assert.match(main, /result\.status === 'STALE'/)
  assert.match(main, /result\.code === 'STALE'/)
  assert.doesNotMatch(main, /event\('navigation-(?:request|complete)'\)/)
  assert.match(main, /page\.kind, 'entities'/)
  assert.match(main, /planned\.projectKey/)
  assert.match(main, /planned\.revision/)
  assert.match(main, /planned\.sceneId/)
  assert.match(main, /planned\.expiresAt/)
  assert.match(main, /state\.transactions\.length/)
  assert.match(main, /h2\.snapshot\.project\.revision/)
  assert.match(main, /controllerViews/)
  assert.match(main, /retryCommitIpcCount/)
  assert.match(driver, /applied-visible\.png/)
  assert.match(driver, /undo-restored\.png/)
  assert.match(driver, /reopened\.png/)
  const runtimeGate = bootstrap.indexOf('const liveEnvironment = validateRuntimeEnvironment(')
  const buildReceiptGate = bootstrap.lastIndexOf('validateBuildReceipts(build, bundleDirectory, process.getuid())')
  const procfsRead = bootstrap.lastIndexOf('readBoundedProcEnvironment()')
  const observationWrite = bootstrap.lastIndexOf("'procfs-observation.v4.json'")
  const fatalGate = bootstrap.lastIndexOf('requireAcceptedProcfsObservation(procfs)')
  const admissionWrite = bootstrap.lastIndexOf("'environment-admission.v5.json'")
  const startupWrite = bootstrap.lastIndexOf("'startup-attempt.json'")
  const mainImport = bootstrap.lastIndexOf("require(path.join(bundleDirectory, 'main.cjs'))")
  assert.ok(runtimeGate >= 0 && buildReceiptGate > runtimeGate && procfsRead > buildReceiptGate
    && observationWrite > procfsRead && fatalGate > observationWrite && admissionWrite > fatalGate
    && startupWrite > admissionWrite && mainImport > startupWrite)
})

test('build-only emits a fresh private reproducible bundle and bounded hashed source graph', { timeout: 120_000 }, async () => {
  const first = await buildWorldsCodexDirectEditFixture()
  const second = await buildWorldsCodexDirectEditFixture()
  for (const result of [first, second]) {
    assert.equal(result.schema, 'modly.worlds-codex-direct-edit-native-build.v1')
    assert.equal(result.execution, 'NOT_RUN')
    assert.equal(result.nativeEvidence, 'ABSENT')
    assert.equal(path.dirname(result.outputDirectory), '/tmp')
    assert.match(path.basename(result.outputDirectory), /^modly-worlds-c3-native-/)
    assert.equal(await realpath(result.outputDirectory), result.outputDirectory)
    const directoryInfo = await lstat(result.outputDirectory)
    assert.equal(directoryInfo.isDirectory(), true)
    assert.equal(directoryInfo.mode & 0o777, 0o700)
    const manifestInfo = await lstat(path.join(result.outputDirectory, 'fixture-build.json'))
    assert.equal(manifestInfo.mode & 0o777, 0o600)
    assert.deepEqual(Object.keys(result.outputs).sort(), [...result.outputInventory].sort())
    for (const required of ['bootstrap.cjs', 'main.cjs', 'preload.cjs', 'renderer/index.html']) assert.ok(result.outputs[required], required)
    assert.ok(Object.keys(result.outputs).some((name) => /^renderer\/assets\/.+\.js$/.test(name)))
    assert.doesNotMatch(result.nextCommand, /xvfb-run/)
    assert.match(result.nextCommand, /\/usr\/bin\/Xvfb/)
    assert.match(result.nextCommand, /\/usr\/bin\/xauth/)
    assert.match(result.nextCommand, /\/usr\/bin\/xdpyinfo/)
    assert.match(result.nextCommand, /env -i/)
    assert.doesNotMatch(result.nextCommand, /&;/)
    assert.equal(spawnSync('/bin/sh', ['-n', '-c', result.nextCommand], { encoding: 'utf8' }).status, 0)
    assert.equal(result.launch.environment.DISPLAY, result.launch.display.name)
    assert.equal(result.launch.environment.XAUTHORITY, result.launch.display.authorityPath)
    assert.deepEqual(Object.keys(result.launch.environment).sort(), [
      'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XAUTHORITY',
      'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
    ])
    assert.deepEqual(result.launch.environmentContract, createEnvironmentContract(result.launch.environment))
    const repositoryRuntimeIdentity = materializePinnedRuntimeIdentity(repositoryRoot)
    assert.equal(result.launch.argv[0], repositoryRuntimeIdentity.executable.path)
    assert.deepEqual(result.launch.runtimeEnvironmentAllowance,
      createRuntimeEnvironmentAllowance(result.launch.environmentContract, PINNED_RUNTIME_ADDITIONS, repositoryRuntimeIdentity))
    assert.doesNotThrow(() => validateRuntimeEnvironmentAllowance(result.launch.environmentContract, result.launch.runtimeEnvironmentAllowance))
    assert.equal(result.launch.argvSha256, createArgvSha256(result.launch.argv))
    assert.equal(result.launch.launchBindingSha256, createLaunchBindingSha256(result))
    assert.equal(result.launch.supervisor.commandShape, 'supervised-Xvfb-then-direct-env-i-Electron')
    assert.deepEqual(result.launch.supervisor.environmentKeys, Object.keys(result.launch.environment).sort())
    assert.match(result.launch.supervisor.evidencePath, /supervisor-preexec\.v2\.json$/)
    assert.match(result.launch.supervisor.startedEvidencePath, /supervisor-started\.json$/)
    const commandLines = result.nextCommand.split('\n')
    const preexecLine = commandLines.findIndex((line) => line.includes('modly.worlds-c3-supervisor-preexec.v2'))
    const electronLine = commandLines.findIndex((line) => line.includes(result.launch.argv[0]))
    assert.ok(preexecLine >= 0 && electronLine > preexecLine)
    assert.match(commandLines[electronLine].trim(), /^\/usr\/bin\/env -i /)
    assert.doesNotMatch(commandLines[electronLine], /\/bin\/(?:ba)?sh|xvfb-run/)
    assert.doesNotMatch(commandLines[electronLine], /CHROME_DESKTOP=|FC_FONTATIONS=/)
    assert.match(result.nextCommand, /test ! -e "\$preexec"/)
    assert.match(result.nextCommand, /set -C/)
    assert.doesNotMatch(result.nextCommand, /ELECTRON_\*/)
    let previousAssignment = -1
    for (const [name] of result.launch.environmentContract.entries) {
      const position = commandLines[electronLine].indexOf(`${name}=`)
      assert.ok(position > previousAssignment, `Non-canonical Electron environment assignment: ${name}`)
      previousAssignment = position
    }
    assert.match(result.nextCommand, /test -f/)
    assert.match(result.nextCommand, /test ! -L/)
    assert.doesNotMatch(result.nextCommand, /600:1:regular (?:empty )?file/)
    const authorityGate = nativeAuthorityGateCommand(
      result.launch.display.authorityPath,
      result.launch.supervisor.expectedOwnerUid,
    )
    assert.match(authorityGate, /test -f/)
    assert.match(authorityGate, /test ! -L/)
    assert.match(authorityGate, /stat -c '%u'/)
    assert.match(authorityGate, /stat -c '%a'/)
    assert.doesNotMatch(authorityGate, /%F|regular (?:empty )?file/)
    await writeFile(result.launch.display.authorityPath, '', { flag: 'wx', mode: 0o600 })
    await chmod(result.launch.display.authorityPath, 0o600)
    const emptyAuthority = await lstat(result.launch.display.authorityPath)
    assert.equal(emptyAuthority.isFile(), true)
    assert.equal(emptyAuthority.size, 0)
    assert.equal(emptyAuthority.isSymbolicLink(), false)
    const gateResult = spawnSync('/bin/sh', ['-eu', '-c', authorityGate], { encoding: 'utf8' })
    assert.equal(gateResult.status, 0, gateResult.stderr)
    await unlink(result.launch.display.authorityPath)
    assert.match(result.nextCommand, /authenticatedReady/)
    assert.match(result.nextCommand, /xvfb_pid/)
    assert.match(result.nextCommand, /electron_pid/)
    assert.match(result.nextCommand, /trap cleanup/)
    assert.ok(result.sourceInputs.length > 40)
    for (const input of result.sourceInputs) {
      assert.equal(path.isAbsolute(input.path), true)
      assert.ok(Number.isSafeInteger(input.bytes) && input.bytes > 0)
      assert.match(input.sha256, /^[a-f0-9]{64}$/)
    }
    for (const owner of owners) assert.ok(result.sourceInputs.some((input) => input.path === path.join(repositoryRoot, owner)), owner)
    for (const production of [
      'electron/main/world-project-repository.ts', 'electron/main/world-projects-ipc.ts', 'electron/main/worlds-cli-ipc.ts',
      'electron/main/worlds-cli-readiness-broker.ts', 'electron/main/worlds-cli-direct-edit-broker.ts',
      'electron/main/worlds-cli-direct-edit-dispatch.ts', 'electron/main/worlds-cli-transport.ts',
      'electron/preload/electron-api.ts', 'src/areas/worlds/components/WorldsWorkbench.tsx',
    ]) assert.ok(result.sourceInputs.some((input) => input.path === path.join(repositoryRoot, production)), production)
    for (const configInput of ['scripts/world-ffmpeg-build-trust.mjs', 'scripts/world-ffmpeg-durability.mjs']) {
      assert.ok(result.sourceInputs.some((input) => input.path === path.join(repositoryRoot, configInput)), configInput)
      assert.ok(result.sourceGraph.configExecutionClosure.includes(path.join(repositoryRoot, configInput)), configInput)
    }
    assert.equal(result.sourceGraph.definition, 'esbuild-metafiles+vite-load-graph+fixture-tree+project-local-config-import-closure')
    assert.match(result.nextCommand, /timeout/)
    assert.match(result.nextCommand, /env -i/)
    assert.doesNotMatch(result.nextCommand, /--no-sandbox|--disable-setuid-sandbox|--disable-gpu-sandbox/)
  }
  assert.notEqual(first.outputDirectory, second.outputDirectory)
  assert.equal(first.sourceAggregateSha256, second.sourceAggregateSha256)
  assert.deepEqual(first.sourceInputs, second.sourceInputs)
  assert.deepEqual(first.outputInventory, second.outputInventory)
  assert.deepEqual(first.outputs, second.outputs)
})
