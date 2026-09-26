'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { TextDecoder } = require('node:util')

const ENVIRONMENT_SCHEMA = 'modly.worlds-c3-environment-contract.v1'
const PREEXEC_SCHEMA = 'modly.worlds-c3-supervisor-preexec.v2'
const RUNTIME_ALLOWANCE_SCHEMA = 'modly.worlds-c3-runtime-environment-allowance.v1'
const RUNTIME_IDENTITY_SCHEMA = 'modly.worlds-c3-runtime-identity.v1'
const PROCFS_OBSERVATION_SCHEMA = 'modly.worlds-c3-procfs-observation.v4'
const PROCFS_PRIOR_GATES_SCHEMA = 'modly.worlds-c3-procfs-prior-gates.v1'
const PROCFS_LIMIT = 65_536
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hashJson = (domain, value) => sha256(Buffer.from(`${domain}\0${JSON.stringify(value)}`))

const PINNED_RUNTIME_ADDITIONS = Object.freeze({ CHROME_DESKTOP: 'electron.desktop', FC_FONTATIONS: '1' })
const PINNED_RUNTIME_ADMISSION = Object.freeze({
  schema: RUNTIME_IDENTITY_SCHEMA,
  electronVersion: '44.1.1',
  platform: 'linux',
  arch: 'arm64',
  executableRelativePath: 'node_modules/electron/dist/electron',
  executableReceipt: Object.freeze({
    type: 'file',
    uid: 1000,
    mode: '755',
    nlink: 1,
    size: 219942280,
    sha256: '3290b494c85a2fa6799c3b4b57cd774d15010f1d5d3f6f9f5dd7886e7c73e924',
  }),
})

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a record.`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys changed.`)
}

function materializePinnedRuntimeIdentity(repositoryRoot, admission = PINNED_RUNTIME_ADMISSION) {
  assert.equal(typeof repositoryRoot, 'string', 'Runtime repository root must be a string.')
  assert.equal(path.isAbsolute(repositoryRoot), true, 'Runtime repository root must be absolute.')
  assert.equal(path.resolve(repositoryRoot), repositoryRoot, 'Runtime repository root must be canonical.')
  assert.equal(repositoryRoot.includes('\0'), false, 'Runtime repository root contains NUL.')
  exactKeys(admission, ['schema', 'electronVersion', 'platform', 'arch', 'executableRelativePath', 'executableReceipt'], 'Pinned runtime admission')
  exactKeys(admission.executableReceipt, ['type', 'uid', 'mode', 'nlink', 'size', 'sha256'], 'Pinned runtime executable receipt')
  assert.deepEqual(admission, PINNED_RUNTIME_ADMISSION, 'Pinned runtime admission changed.')
  const relative = admission.executableRelativePath
  assert.equal(typeof relative, 'string', 'Runtime executable relative path must be a string.')
  assert.equal(path.isAbsolute(relative), false, 'Runtime executable admission must be relative.')
  assert.equal(relative.includes('\0'), false, 'Runtime executable admission contains NUL.')
  assert.equal(path.normalize(relative), relative, 'Runtime executable admission must be normalized.')
  assert.equal(relative.split(path.sep).includes('..'), false, 'Runtime executable admission traverses repository root.')
  const executablePath = path.resolve(repositoryRoot, relative)
  assert.ok(executablePath.startsWith(`${repositoryRoot}${path.sep}`), 'Runtime executable admission escaped repository root.')
  return {
    schema: admission.schema,
    electronVersion: admission.electronVersion,
    platform: admission.platform,
    arch: admission.arch,
    executable: { path: executablePath, ...admission.executableReceipt },
  }
}

function createEnvironmentContract(environment) {
  assert.ok(environment && typeof environment === 'object' && !Array.isArray(environment), 'Environment must be a record.')
  const entries = Object.keys(environment).sort().map((name) => {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, `Invalid environment name: ${name}`)
    const value = environment[name]
    assert.equal(typeof value, 'string', `Environment value must be a string: ${name}`)
    assert.equal(/[\0\r\n]/.test(value), false, `Unsafe environment value: ${name}`)
    return [name, Buffer.byteLength(value, 'utf8'), sha256(Buffer.from(value))]
  })
  assert.ok(entries.length > 0, 'Environment contract cannot be empty.')
  return { schema: ENVIRONMENT_SCHEMA, entries, sha256: hashJson(ENVIRONMENT_SCHEMA, entries) }
}

function deriveSealedEnvironmentByteLength(baseContract) {
  assert.equal(baseContract.schema, ENVIRONMENT_SCHEMA, 'Sealed environment contract schema changed.')
  assert.ok(Array.isArray(baseContract.entries) && baseContract.entries.length > 0,
    'Sealed environment contract entries changed.')
  const byteLength = baseContract.entries.reduce((total, entry) => {
    assert.ok(Array.isArray(entry) && entry.length === 3, 'Sealed environment contract entry changed.')
    assert.match(entry[0], /^[A-Z][A-Z0-9_]*$/, 'Sealed environment contract name changed.')
    assert.ok(Number.isSafeInteger(entry[1]) && entry[1] >= 0,
      'Sealed environment contract value length changed.')
    assert.match(entry[2], /^[a-f0-9]{64}$/, 'Sealed environment contract value digest changed.')
    return total + Buffer.byteLength(entry[0]) + 1 + entry[1] + 1
  }, 0)
  assert.ok(byteLength > 0 && byteLength <= PROCFS_LIMIT, 'Sealed environment serialized length changed.')
  return byteLength
}

function createArgvSha256(argv) {
  assert.ok(Array.isArray(argv) && argv.length > 0, 'Argv must be non-empty.')
  for (const value of argv) {
    assert.equal(typeof value, 'string', 'Argv values must be strings.')
    assert.equal(/[\0\r\n]/.test(value), false, 'Unsafe argv value.')
  }
  return hashJson('modly.worlds-c3-argv.v1', argv)
}

function validateRuntimeIdentity(expected, actual) {
  for (const [value, label] of [[expected, 'Expected runtime identity'], [actual, 'Actual runtime identity']]) {
    exactKeys(value, ['schema', 'electronVersion', 'platform', 'arch', 'executable'], label)
    exactKeys(value.executable, ['path', 'type', 'uid', 'mode', 'nlink', 'size', 'sha256'], `${label} executable`)
    assert.equal(value.schema, RUNTIME_IDENTITY_SCHEMA, `${label} schema changed.`)
    assert.match(value.executable.sha256, /^[a-f0-9]{64}$/, `${label} executable hash changed.`)
  }
  assert.deepEqual(actual, expected, 'Runtime identity or executable receipt changed.')
  return actual
}

function inspectRuntimeExecutable(filename) {
  assert.equal(path.isAbsolute(filename), true, 'Runtime executable path must be absolute.')
  assert.ok(Number.isInteger(fs.constants.O_NOFOLLOW), 'O_NOFOLLOW is required for runtime executable custody.')
  let descriptor
  try { descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch (error) {
    throw new Error(`Runtime executable symbolic-link or open custody failed: ${filename}`, { cause: error })
  }
  try {
    const info = fs.fstatSync(descriptor)
    assert.ok(info.isFile(), `Runtime executable must be a regular file: ${filename}`)
    assert.equal(fs.realpathSync(filename), filename, `Runtime executable canonical path changed: ${filename}`)
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return {
      path: filename,
      type: 'file',
      uid: info.uid,
      mode: (info.mode & 0o777).toString(8),
      nlink: info.nlink,
      size: info.size,
      sha256: digest.digest('hex'),
    }
  } finally { fs.closeSync(descriptor) }
}

function createRuntimeEnvironmentAllowance(baseContract, additions, runtimeIdentity) {
  const baseNames = new Set(baseContract.entries.map(([name]) => name))
  const entries = Object.keys(additions).sort().map((name) => {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, `Invalid runtime environment name: ${name}`)
    assert.equal(baseNames.has(name), false, `Runtime environment overlap: ${name}`)
    const value = additions[name]
    assert.equal(typeof value, 'string', `Runtime environment value must be a string: ${name}`)
    assert.equal(/[\0\r\n]/.test(value), false, `Unsafe runtime environment value: ${name}`)
    return { name, required: true, value, receipt: [name, Buffer.byteLength(value, 'utf8'), sha256(Buffer.from(value))] }
  })
  const allowanceSha256 = hashJson(RUNTIME_ALLOWANCE_SCHEMA, entries)
  const runtimeIdentitySha256 = hashJson(RUNTIME_IDENTITY_SCHEMA, runtimeIdentity)
  const allowance = {
    schema: RUNTIME_ALLOWANCE_SCHEMA,
    entries,
    runtimeEnvironmentAllowanceSha256: allowanceSha256,
    runtimeIdentity: structuredClone(runtimeIdentity),
    runtimeIdentitySha256,
    liveEnvironmentAdmissionSha256: hashJson('modly.worlds-c3-live-environment-admission.v1',
      [baseContract.sha256, allowanceSha256, runtimeIdentitySha256]),
  }
  validateRuntimeEnvironmentAllowance(baseContract, allowance, runtimeIdentity)
  return allowance
}

function validateRuntimeEnvironmentAllowance(baseContract, allowance, expectedRuntimeIdentity = allowance.runtimeIdentity) {
  exactKeys(baseContract, ['schema', 'entries', 'sha256'], 'Base environment contract')
  exactKeys(allowance, ['schema', 'entries', 'runtimeEnvironmentAllowanceSha256', 'runtimeIdentity', 'runtimeIdentitySha256', 'liveEnvironmentAdmissionSha256'],
    'Runtime environment allowance')
  assert.equal(allowance.schema, RUNTIME_ALLOWANCE_SCHEMA, 'Runtime environment allowance schema changed.')
  assert.ok(Array.isArray(allowance.entries), 'Runtime environment allowance entries changed.')
  const baseNames = new Set(baseContract.entries.map(([name]) => name))
  const names = []
  for (const entry of allowance.entries) {
    exactKeys(entry, ['name', 'required', 'value', 'receipt'], 'Runtime environment allowance entry')
    assert.match(entry.name, /^[A-Z][A-Z0-9_]*$/, 'Runtime environment allowance name changed.')
    assert.equal(names.includes(entry.name), false, `Duplicate runtime environment allowance: ${entry.name}`)
    assert.equal(baseNames.has(entry.name), false, `Runtime environment allowance overlaps base: ${entry.name}`)
    assert.equal(entry.required, true, `Runtime environment allowance is not required: ${entry.name}`)
    assert.equal(typeof entry.value, 'string', `Runtime environment allowance value changed: ${entry.name}`)
    assert.equal(/[\0\r\n]/.test(entry.value), false, `Unsafe runtime environment allowance value: ${entry.name}`)
    assert.deepEqual(entry.receipt,
      [entry.name, Buffer.byteLength(entry.value, 'utf8'), sha256(Buffer.from(entry.value))],
      `Runtime environment allowance receipt changed: ${entry.name}`)
    names.push(entry.name)
  }
  assert.deepEqual(names, [...names].sort(), 'Runtime environment allowance order changed.')
  assert.deepEqual(Object.fromEntries(allowance.entries.map((entry) => [entry.name, entry.value])), PINNED_RUNTIME_ADDITIONS,
    'Runtime environment allowance values changed.')
  assert.equal(allowance.runtimeEnvironmentAllowanceSha256, hashJson(RUNTIME_ALLOWANCE_SCHEMA, allowance.entries),
    'Runtime environment allowance hash changed.')
  validateRuntimeIdentity(expectedRuntimeIdentity, allowance.runtimeIdentity)
  assert.equal(allowance.runtimeIdentitySha256, hashJson(RUNTIME_IDENTITY_SCHEMA, allowance.runtimeIdentity), 'Runtime identity hash changed.')
  assert.equal(allowance.liveEnvironmentAdmissionSha256,
    hashJson('modly.worlds-c3-live-environment-admission.v1',
      [baseContract.sha256, allowance.runtimeEnvironmentAllowanceSha256, allowance.runtimeIdentitySha256]),
    'Live environment admission hash changed.')
  return allowance
}

function validateRuntimeEnvironment(baseEnvironment, baseContract, allowance, actualEnvironment, actualRuntimeIdentity) {
  assert.deepEqual(createEnvironmentContract(baseEnvironment), baseContract, 'Base environment contract changed.')
  validateRuntimeEnvironmentAllowance(baseContract, allowance)
  validateRuntimeIdentity(allowance.runtimeIdentity, actualRuntimeIdentity)
  const additions = Object.fromEntries(allowance.entries.map((entry) => [entry.name, entry.value]))
  const expected = { ...baseEnvironment, ...additions }
  const expectedNames = Object.keys(expected).sort()
  assert.deepEqual(Object.keys(actualEnvironment).sort(), expectedNames, 'Exact runtime environment key set changed.')
  for (const name of expectedNames) {
    assert.equal(typeof actualEnvironment[name], 'string', `Runtime environment value must be a string: ${name}`)
    assert.equal(actualEnvironment[name], expected[name], `Runtime environment value changed: ${name}`)
  }
  return expectedValidatedLive(baseContract, allowance)
}

function expectedValidatedLive(baseContract, allowance) {
  return {
    base: { count: baseContract.entries.length, names: baseContract.entries.map(([name]) => name), entries: baseContract.entries,
      sha256: baseContract.sha256 },
    additions: { count: allowance.entries.length, names: allowance.entries.map((entry) => entry.name),
      entries: allowance.entries.map((entry) => entry.receipt),
      runtimeEnvironmentAllowanceSha256: allowance.runtimeEnvironmentAllowanceSha256 },
    runtimeIdentitySha256: allowance.runtimeIdentitySha256,
    liveEnvironmentAdmissionSha256: allowance.liveEnvironmentAdmissionSha256,
  }
}

function createProcfsPriorGateProof(fields) {
  exactKeys(fields, ['validatedLive', 'manifestFileSha256', 'launchBindingSha256', 'supervisorReceiptSha256',
    'supervisorPid', 'bootstrapPid', 'sourceAggregateSha256', 'outputReceiptsSha256', 'authorityGateSha256',
    'sandboxGateSha256', 'buildReceiptGatesPassed'], 'Procfs prior-gate fields')
  exactKeys(fields.validatedLive, ['base', 'additions', 'runtimeIdentitySha256', 'liveEnvironmentAdmissionSha256'],
    'Validated live environment evidence')
  const proof = {
    schema: PROCFS_PRIOR_GATES_SCHEMA,
    validatedLiveSha256: hashJson('modly.worlds-c3-validated-live-environment.v1', fields.validatedLive),
    manifestFileSha256: fields.manifestFileSha256,
    launchBindingSha256: fields.launchBindingSha256,
    supervisorReceiptSha256: fields.supervisorReceiptSha256,
    supervisorPid: fields.supervisorPid,
    bootstrapPid: fields.bootstrapPid,
    baseEnvironmentContractSha256: fields.validatedLive.base.sha256,
    runtimeEnvironmentAllowanceSha256: fields.validatedLive.additions.runtimeEnvironmentAllowanceSha256,
    runtimeIdentitySha256: fields.validatedLive.runtimeIdentitySha256,
    liveEnvironmentAdmissionSha256: fields.validatedLive.liveEnvironmentAdmissionSha256,
    sourceAggregateSha256: fields.sourceAggregateSha256,
    outputReceiptsSha256: fields.outputReceiptsSha256,
    authorityGateSha256: fields.authorityGateSha256,
    sandboxGateSha256: fields.sandboxGateSha256,
    buildReceiptGatesPassed: fields.buildReceiptGatesPassed,
  }
  proof.priorGateBindingSha256 = hashJson(PROCFS_PRIOR_GATES_SCHEMA, proof)
  validateProcfsPriorGateProof(proof, fields.validatedLive)
  return proof
}

function validateProcfsPriorGateProof(proof, validatedLive, baseContract, allowance) {
  exactKeys(proof, ['schema', 'validatedLiveSha256', 'manifestFileSha256', 'launchBindingSha256',
    'supervisorReceiptSha256', 'supervisorPid', 'bootstrapPid', 'baseEnvironmentContractSha256',
    'runtimeEnvironmentAllowanceSha256', 'runtimeIdentitySha256', 'liveEnvironmentAdmissionSha256',
    'sourceAggregateSha256', 'outputReceiptsSha256', 'authorityGateSha256', 'sandboxGateSha256',
    'buildReceiptGatesPassed', 'priorGateBindingSha256'], 'Procfs prior-gate proof')
  exactKeys(validatedLive, ['base', 'additions', 'runtimeIdentitySha256', 'liveEnvironmentAdmissionSha256'],
    'Validated live environment evidence')
  assert.equal(proof.schema, PROCFS_PRIOR_GATES_SCHEMA, 'Procfs prior-gate schema changed.')
  for (const name of ['validatedLiveSha256', 'manifestFileSha256', 'launchBindingSha256', 'supervisorReceiptSha256',
    'baseEnvironmentContractSha256', 'runtimeEnvironmentAllowanceSha256', 'runtimeIdentitySha256',
    'liveEnvironmentAdmissionSha256', 'sourceAggregateSha256', 'outputReceiptsSha256', 'authorityGateSha256',
    'sandboxGateSha256', 'priorGateBindingSha256']) assert.match(proof[name], /^[a-f0-9]{64}$/, `Procfs prior-gate hash changed: ${name}`)
  assert.ok(Number.isSafeInteger(proof.supervisorPid) && proof.supervisorPid > 1, 'Procfs prior-gate supervisor PID changed.')
  assert.equal(proof.supervisorPid, process.ppid, 'Procfs prior-gate parent binding changed.')
  assert.equal(proof.bootstrapPid, process.pid, 'Procfs prior-gate invocation binding changed.')
  assert.equal(proof.buildReceiptGatesPassed, true, 'Procfs prior build receipt gate was not passed.')
  assert.equal(proof.validatedLiveSha256,
    hashJson('modly.worlds-c3-validated-live-environment.v1', validatedLive), 'Procfs validated-live binding changed.')
  assert.equal(proof.baseEnvironmentContractSha256, validatedLive.base.sha256, 'Procfs base environment binding changed.')
  assert.equal(proof.runtimeEnvironmentAllowanceSha256, validatedLive.additions.runtimeEnvironmentAllowanceSha256,
    'Procfs runtime allowance binding changed.')
  assert.equal(proof.runtimeIdentitySha256, validatedLive.runtimeIdentitySha256, 'Procfs runtime identity binding changed.')
  assert.equal(proof.liveEnvironmentAdmissionSha256, validatedLive.liveEnvironmentAdmissionSha256,
    'Procfs live environment binding changed.')
  if (baseContract && allowance) assert.deepEqual(validatedLive, expectedValidatedLive(baseContract, allowance),
    'Procfs validated-live evidence changed.')
  const { priorGateBindingSha256, ...projection } = proof
  assert.equal(priorGateBindingSha256, hashJson(PROCFS_PRIOR_GATES_SCHEMA, projection), 'Procfs prior-gate binding changed.')
  return proof
}

function createLaunchBindingSha256(build) {
  const launch = build.launch
  assert.ok(launch && typeof launch === 'object', 'Launch binding is missing.')
  const outputs = Object.keys(build.outputs ?? {}).sort().map((name) => [name, build.outputs[name].bytes, build.outputs[name].sha256])
  const paths = Object.keys(launch.paths ?? {}).sort().map((name) => [name, launch.paths[name]])
  const scenarios = Object.keys(launch.scenarios ?? {}).sort().map((name) => [name,
    Object.keys(launch.scenarios[name]).sort().map((key) => [key, launch.scenarios[name][key]])])
  const preparedDirectories = (launch.preparedDirectories ?? []).map(({ path: filename, uid, mode }) => [filename, uid, mode])
  const projection = {
    schema: build.schema,
    scope: build.scope,
    outputDirectory: build.outputDirectory,
    repositoryRoot: build.repositoryRoot,
    sourceAggregateSha256: build.sourceAggregateSha256,
    outputs,
    outputInventory: build.outputInventory,
    argv: launch.argv,
    argvSha256: launch.argvSha256,
    environmentContract: launch.environmentContract,
    runtimeEnvironmentAllowance: launch.runtimeEnvironmentAllowance,
    paths,
    scenarios,
    preparedDirectories,
    display: launch.display,
    supervisor: {
      commandShape: launch.supervisor.commandShape,
      expectedOwnerUid: launch.supervisor.expectedOwnerUid,
      environmentKeys: launch.supervisor.environmentKeys,
      evidencePath: launch.supervisor.evidencePath,
      startedEvidencePath: launch.supervisor.startedEvidencePath,
    },
  }
  return hashJson('modly.worlds-c3-launch-binding.v1', projection)
}

function validateExactEnvironment(expectedEnvironment, expectedContract, actualEnvironment) {
  exactKeys(expectedContract, ['schema', 'entries', 'sha256'], 'Environment contract')
  const rebuiltExpected = createEnvironmentContract(expectedEnvironment)
  assert.deepEqual(expectedContract, rebuiltExpected, 'Expected environment contract changed.')
  const expectedNames = Object.keys(expectedEnvironment).sort()
  const actualNames = Object.keys(actualEnvironment).sort()
  assert.deepEqual(actualNames, expectedNames, 'Exact environment key set changed.')
  for (const name of expectedNames) assert.equal(actualEnvironment[name], expectedEnvironment[name], `Exact environment value changed: ${name}`)
  const actualContract = createEnvironmentContract(Object.fromEntries(actualNames.map((name) => [name, actualEnvironment[name]])))
  assert.deepEqual(actualContract, expectedContract, 'Live environment contract changed.')
  return actualContract
}

function readBoundedProcEnvironment(filename = '/proc/self/environ') {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY)
  try {
    const chunks = []
    const digest = createHash('sha256')
    let total = 0
    for (;;) {
      const remaining = PROCFS_LIMIT + 1 - total
      if (remaining <= 0) return { overflow: { byteLength: total, sha256: digest.digest('hex') } }
      const buffer = Buffer.allocUnsafe(Math.min(8192, remaining))
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      const retained = buffer.subarray(0, bytesRead)
      chunks.push(retained)
      digest.update(retained)
      total += bytesRead
      if (total > PROCFS_LIMIT) return { overflow: { byteLength: total, sha256: digest.digest('hex') } }
    }
    return { bytes: Buffer.concat(chunks, total) }
  } finally { fs.closeSync(descriptor) }
}

const PROCFS_OBSERVATION_KEYS = ['schema', 'status', 'accepted', 'byteLength', 'sha256', 'readErrorCode',
  'terminalNul', 'recordSlotCount', 'wellFormedRecordCount', 'malformedRecordCount', 'structuralDefectCount',
  'malformedReasons', 'classificationReasons', 'priorGates', 'knownRecordCounts', 'knownMatchingNames', 'knownMatchingCount',
  'missingLiveNames', 'missingLiveCount', 'contradictedKnownNames', 'unknownRecordCount', 'duplicateRecordCount',
  'valueMismatchRecordCount', 'invalidValueRecordCount', 'knownMatchingSubsetSha256', 'corroboratedContract',
  'corroboratedContractSha256', 'procfsObservationBindingSha256']

function createProcfsObservation(fields, priorGates, liveEnvironmentAdmissionSha256) {
  const knownMatchingNames = [...new Set(fields.knownMatchingNames)].sort()
  const observation = {
    schema: PROCFS_OBSERVATION_SCHEMA,
    status: fields.status,
    accepted: fields.accepted,
    byteLength: fields.byteLength,
    sha256: fields.sha256,
    readErrorCode: fields.readErrorCode,
    terminalNul: fields.terminalNul,
    recordSlotCount: fields.recordSlotCount,
    wellFormedRecordCount: fields.wellFormedRecordCount,
    malformedRecordCount: fields.malformedRecordCount,
    structuralDefectCount: fields.structuralDefectCount,
    malformedReasons: fields.malformedReasons,
    classificationReasons: [...new Set(fields.classificationReasons)].sort(),
    priorGates: structuredClone(priorGates),
    knownRecordCounts: fields.liveNames.map((name) => [name, fields.knownRecordCounts[name]]),
    knownMatchingNames,
    knownMatchingCount: knownMatchingNames.length,
    missingLiveNames: fields.liveNames.filter((name) => !knownMatchingNames.includes(name)),
    missingLiveCount: fields.liveNames.length - knownMatchingNames.length,
    contradictedKnownNames: [...new Set(fields.contradictedKnownNames)].sort(),
    unknownRecordCount: fields.unknownRecordCount,
    duplicateRecordCount: fields.duplicateRecordCount,
    valueMismatchRecordCount: fields.valueMismatchRecordCount,
    invalidValueRecordCount: fields.invalidValueRecordCount,
    knownMatchingSubsetSha256: hashJson('modly.worlds-c3-procfs-known-subset.v1',
      [liveEnvironmentAdmissionSha256, knownMatchingNames]),
    corroboratedContract: fields.corroboratedContract,
    corroboratedContractSha256: fields.corroboratedContractSha256,
  }
  observation.procfsObservationBindingSha256 = hashJson('modly.worlds-c3-procfs-observation-binding.v4', observation)
  return observation
}

function validateProcfsObservation(observation, expectedEnvironment, allowance, validatedLive, priorGates) {
  exactKeys(observation, PROCFS_OBSERVATION_KEYS, 'Procfs sanitized observation')
  assert.equal(observation.schema, PROCFS_OBSERVATION_SCHEMA, 'Procfs observation schema changed.')
  assert.equal(typeof observation.accepted, 'boolean', 'Procfs accepted evidence changed.')
  assert.equal(observation.accepted, observation.status !== 'FATAL', 'Procfs fatal status changed.')
  const baseContract = expectedEnvironment?.schema === ENVIRONMENT_SCHEMA
    ? expectedEnvironment : createEnvironmentContract(expectedEnvironment)
  validateRuntimeEnvironmentAllowance(baseContract, allowance)
  const expectedValidated = expectedValidatedLive(baseContract, allowance)
  const boundValidated = validatedLive ?? expectedValidated
  assert.deepEqual(boundValidated, expectedValidated, 'Procfs validated-live evidence changed.')
  validateProcfsPriorGateProof(observation.priorGates, boundValidated, baseContract, allowance)
  if (priorGates) assert.deepEqual(observation.priorGates, priorGates, 'Procfs prior-gate proof changed.')
  const liveNames = [...baseContract.entries.map(([name]) => name), ...allowance.entries.map((entry) => entry.name)].sort()
  const baseNames = baseContract.entries.map(([name]) => name).sort()
  const sealedByteLength = deriveSealedEnvironmentByteLength(baseContract)
  const liveValueByteLengths = Object.fromEntries([
    ...baseContract.entries.map(([name, byteLength]) => [name, byteLength]),
    ...allowance.entries.map((entry) => [entry.name, entry.receipt[1]]),
  ])
  const exactRecordByteLength = (names) => names.reduce((total, name) => total
    + Buffer.byteLength(name) + 1 + liveValueByteLengths[name] + 1, 0)
  for (const name of ['knownMatchingNames', 'missingLiveNames', 'contradictedKnownNames', 'classificationReasons']) {
    assert.ok(Array.isArray(observation[name]), `Procfs array changed: ${name}`)
    assert.deepEqual(observation[name], [...new Set(observation[name])].sort(), `Procfs array order changed: ${name}`)
  }
  for (const name of [...observation.knownMatchingNames, ...observation.missingLiveNames,
    ...observation.contradictedKnownNames]) assert.ok(liveNames.includes(name), 'Procfs retained a non-allowlisted name.')
  assert.ok(Array.isArray(observation.knownRecordCounts), 'Procfs known-record evidence changed.')
  assert.equal(observation.knownRecordCounts.length, liveNames.length, 'Procfs known-record evidence changed.')
  const knownRecordCounts = {}
  for (let index = 0; index < liveNames.length; index += 1) {
    const pair = observation.knownRecordCounts[index]
    assert.ok(Array.isArray(pair) && pair.length === 2 && pair[0] === liveNames[index],
      'Procfs known-record name evidence changed.')
    assert.ok(Number.isSafeInteger(pair[1]) && pair[1] >= 0, 'Procfs known-record count evidence changed.')
    knownRecordCounts[pair[0]] = pair[1]
  }
  assert.deepEqual([...observation.knownMatchingNames, ...observation.missingLiveNames].sort(), liveNames,
    'Procfs live-name complement changed.')
  assert.equal(observation.knownMatchingCount, observation.knownMatchingNames.length, 'Procfs matching count changed.')
  assert.equal(observation.missingLiveCount, observation.missingLiveNames.length, 'Procfs missing count changed.')
  assert.equal(observation.knownMatchingSubsetSha256,
    hashJson('modly.worlds-c3-procfs-known-subset.v1',
      [allowance.liveEnvironmentAdmissionSha256, observation.knownMatchingNames]), 'Procfs subset binding changed.')
  for (const name of ['recordSlotCount', 'wellFormedRecordCount', 'malformedRecordCount', 'structuralDefectCount',
    'unknownRecordCount', 'duplicateRecordCount', 'valueMismatchRecordCount', 'invalidValueRecordCount']) {
    assert.ok(Number.isSafeInteger(observation[name]) && observation[name] >= 0, `Procfs count changed: ${name}`)
  }
  assert.ok(Array.isArray(observation.malformedReasons), 'Procfs malformed reasons changed.')
  const allowedReasons = ['EMPTY_NAME', 'EMPTY_RECORD', 'INVALID_NAME', 'INVALID_UTF8', 'MISSING_EQUALS', 'MISSING_TERMINAL_NUL']
  const malformedReasonCounts = new Map()
  let reasonCount = 0
  let previous = ''
  for (const pair of observation.malformedReasons) {
    assert.ok(Array.isArray(pair) && pair.length === 2 && allowedReasons.includes(pair[0]) && pair[0] > previous,
      'Procfs malformed reason changed.')
    assert.ok(Number.isSafeInteger(pair[1]) && pair[1] > 0, 'Procfs malformed reason count changed.')
    previous = pair[0]
    malformedReasonCounts.set(pair[0], pair[1])
    reasonCount += pair[1]
  }
  assert.equal(reasonCount, observation.structuralDefectCount, 'Procfs structural count changed.')
  assert.equal(observation.recordSlotCount,
    observation.wellFormedRecordCount + observation.malformedRecordCount, 'Procfs slot count changed.')
  if (observation.byteLength === null) assert.equal(observation.sha256, null, 'Procfs absent-buffer hash changed.')
  else {
    assert.ok(Number.isSafeInteger(observation.byteLength) && observation.byteLength >= 0
      && observation.byteLength <= PROCFS_LIMIT + 1, 'Procfs byte length changed.')
    assert.match(observation.sha256, /^[a-f0-9]{64}$/, 'Procfs buffer hash changed.')
  }
  assert.ok(observation.readErrorCode === null || typeof observation.readErrorCode === 'string', 'Procfs read error changed.')
  assert.ok(observation.terminalNul === null || typeof observation.terminalNul === 'boolean', 'Procfs terminal-NUL evidence changed.')
  const allowedClassificationReasons = ['CLEAN_INCOMPLETE_SUBSET', 'DUPLICATE_NAME', 'EMPTY_OBSERVATION',
    'EXACT_ALL_ZERO_SEALED_11_LENGTH', 'EXACT_FULL_LIVE_13', 'EXACT_SEALED_11', 'INVALID_VALUE_UTF8', 'OVERFLOW',
    'STRUCTURAL_INCOMPLETE', 'STRUCTURAL_NOISE_WITH_COMPLETE_CONTRACT', 'UNAVAILABLE_ALLOWED',
    'UNKNOWN_NAME', 'UNSUPPORTED_READ_ERROR', 'VALUE_MISMATCH']
  assert.ok(observation.classificationReasons.length > 0
    && observation.classificationReasons.every((reason) => allowedClassificationReasons.includes(reason)),
  'Procfs classification reason changed.')
  const contradictions = observation.unknownRecordCount + observation.duplicateRecordCount
    + observation.valueMismatchRecordCount + observation.invalidValueRecordCount
  const knownRecordTotal = Object.values(knownRecordCounts).reduce((total, count) => total + count, 0)
  const knownDuplicateRecordCount = Object.values(knownRecordCounts)
    .reduce((total, count) => total + Math.max(0, count - 1), 0)
  const derivedContradictedKnownNames = liveNames.filter((name) => knownRecordCounts[name] > 1
    || (knownRecordCounts[name] === 1 && !observation.knownMatchingNames.includes(name)))
  assert.deepEqual(observation.contradictedKnownNames, derivedContradictedKnownNames,
    'Procfs contradicted known-name evidence changed.')
  assert.ok(observation.knownMatchingNames.every((name) => knownRecordCounts[name] > 0),
    'Procfs matching known-record evidence changed.')
  assert.equal(knownRecordTotal + observation.unknownRecordCount,
    observation.wellFormedRecordCount + observation.invalidValueRecordCount,
  'Procfs valid-name record relation changed.')
  assert.ok(observation.duplicateRecordCount >= knownDuplicateRecordCount,
    'Procfs known duplicate-record relation changed.')
  assert.ok(observation.duplicateRecordCount - knownDuplicateRecordCount
    <= Math.max(0, observation.unknownRecordCount - 1),
  'Procfs unknown duplicate-record relation changed.')
  assert.ok(observation.knownMatchingCount <= observation.wellFormedRecordCount,
    'Procfs matching/well-formed count changed.')
  assert.ok(observation.valueMismatchRecordCount <= observation.wellFormedRecordCount,
    'Procfs mismatch/well-formed count changed.')
  assert.ok(observation.invalidValueRecordCount <= observation.malformedRecordCount,
    'Procfs invalid-value/malformed count changed.')
  assert.ok(observation.unknownRecordCount
    <= observation.wellFormedRecordCount + observation.invalidValueRecordCount,
  'Procfs unknown record count changed.')
  assert.ok(observation.wellFormedRecordCount >= observation.knownMatchingCount
    + observation.valueMismatchRecordCount
    + Math.max(0, observation.unknownRecordCount - observation.invalidValueRecordCount),
  'Procfs well-formed lower bound changed.')
  assert.ok(observation.wellFormedRecordCount <= observation.knownMatchingCount
    + observation.valueMismatchRecordCount + observation.unknownRecordCount + observation.duplicateRecordCount,
  'Procfs well-formed upper bound changed.')
  assert.ok(observation.duplicateRecordCount <= observation.recordSlotCount,
    'Procfs duplicate record count changed.')
  assert.ok(observation.valueMismatchRecordCount <= knownRecordTotal - observation.knownMatchingCount,
    'Procfs mismatch known-record relation changed.')
  assert.ok(observation.invalidValueRecordCount <= observation.unknownRecordCount
    + knownRecordTotal - observation.knownMatchingCount,
  'Procfs invalid-value record relation changed.')
  assert.ok((malformedReasonCounts.get('INVALID_UTF8') ?? 0) >= observation.invalidValueRecordCount,
    'Procfs invalid UTF-8 count changed.')
  if (observation.byteLength !== null && observation.byteLength > 0 && observation.byteLength <= PROCFS_LIMIT) {
    assert.equal(observation.readErrorCode, null, 'Procfs buffer/read-error relation changed.')
    assert.equal(typeof observation.terminalNul, 'boolean', 'Procfs buffer terminal-NUL relation changed.')
    assert.ok(observation.recordSlotCount > 0 && observation.recordSlotCount <= observation.byteLength,
      'Procfs byte/slot count changed.')
    const missingTerminalNulCount = malformedReasonCounts.get('MISSING_TERMINAL_NUL') ?? 0
    assert.equal(missingTerminalNulCount, observation.terminalNul ? 0 : 1,
      'Procfs terminal-NUL reason changed.')
    assert.equal(observation.malformedRecordCount,
      observation.structuralDefectCount - missingTerminalNulCount,
    'Procfs malformed/structural count changed.')
  }
  const assertNullCorroboration = () => {
    assert.equal(observation.corroboratedContract, null)
    assert.equal(observation.corroboratedContractSha256, null)
  }
  const assertBufferObservation = () => {
    assert.equal(observation.readErrorCode, null, 'Procfs buffer read-error changed.')
    assert.ok(observation.byteLength > 0 && observation.byteLength <= PROCFS_LIMIT,
      'Procfs bounded buffer length changed.')
  }
  const assertNoRecords = () => {
    assert.equal(observation.recordSlotCount + observation.wellFormedRecordCount
      + observation.malformedRecordCount + observation.structuralDefectCount + contradictions, 0,
    'Procfs absent record evidence changed.')
    assert.deepEqual(observation.malformedReasons, [], 'Procfs absent malformed reasons changed.')
    assert.deepEqual(observation.knownMatchingNames, [], 'Procfs absent matching names changed.')
    assert.deepEqual(observation.contradictedKnownNames, [], 'Procfs absent contradicted names changed.')
  }
  const assertCleanKnownRecords = () => {
    assert.equal(observation.malformedRecordCount + observation.structuralDefectCount + contradictions, 0,
      'Procfs clean-record evidence changed.')
    assert.deepEqual(observation.malformedReasons, [], 'Procfs clean malformed reasons changed.')
    assert.deepEqual(observation.contradictedKnownNames, [], 'Procfs clean contradicted names changed.')
    assert.equal(observation.recordSlotCount, observation.knownMatchingCount,
      'Procfs clean slot/matching count changed.')
    assert.equal(observation.wellFormedRecordCount, observation.knownMatchingCount,
      'Procfs clean well-formed/matching count changed.')
    assert.equal(observation.byteLength, exactRecordByteLength(observation.knownMatchingNames),
      'Procfs clean record byte length changed.')
  }
  if (observation.status === 'EMPTY_NON_AUTHORITATIVE') {
    assert.equal(observation.byteLength, 0); assert.equal(observation.sha256, sha256(Buffer.alloc(0)),
      'Procfs empty-buffer hash changed.')
    assert.equal(observation.readErrorCode, null); assert.equal(observation.terminalNul, false)
    assertNoRecords()
    assert.deepEqual(observation.classificationReasons, ['EMPTY_OBSERVATION']); assertNullCorroboration()
  } else if (observation.status === 'UNAVAILABLE_NON_AUTHORITATIVE') {
    assert.ok(['ENOENT', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(observation.readErrorCode))
    assert.equal(observation.byteLength, null); assert.equal(observation.terminalNul, null)
    assertNoRecords()
    assert.deepEqual(observation.classificationReasons, ['UNAVAILABLE_ALLOWED']); assertNullCorroboration()
  } else if (observation.status === 'ZERO_FILLED_NON_AUTHORITATIVE') {
    assertBufferObservation()
    assert.equal(observation.byteLength, sealedByteLength, 'Procfs zero-filled sealed length changed.')
    assert.equal(observation.sha256, sha256(Buffer.alloc(sealedByteLength)),
      'Procfs zero-filled sealed digest changed.')
    assert.equal(observation.readErrorCode, null)
    assert.equal(observation.terminalNul, true)
    assert.equal(observation.recordSlotCount, sealedByteLength)
    assert.equal(observation.wellFormedRecordCount, 0)
    assert.equal(observation.malformedRecordCount, sealedByteLength)
    assert.equal(observation.structuralDefectCount, sealedByteLength)
    assert.deepEqual(observation.malformedReasons, [['EMPTY_RECORD', sealedByteLength]])
    assert.deepEqual(observation.classificationReasons, ['EXACT_ALL_ZERO_SEALED_11_LENGTH'])
    assert.deepEqual(observation.knownRecordCounts, liveNames.map((name) => [name, 0]))
    assert.deepEqual(observation.knownMatchingNames, [])
    assert.equal(observation.knownMatchingCount, 0)
    assert.deepEqual(observation.missingLiveNames, liveNames)
    assert.equal(observation.missingLiveCount, liveNames.length)
    assert.deepEqual(observation.contradictedKnownNames, [])
    assert.equal(observation.unknownRecordCount + observation.duplicateRecordCount
      + observation.valueMismatchRecordCount + observation.invalidValueRecordCount, 0)
    assertNullCorroboration()
  } else if (observation.status === 'INCOMPLETE_NON_AUTHORITATIVE') {
    assertBufferObservation()
    assertCleanKnownRecords()
    assert.ok(observation.knownMatchingCount > 0 && observation.knownMatchingCount < liveNames.length)
    assert.notDeepEqual(observation.knownMatchingNames, baseNames)
    assert.equal(observation.terminalNul, true)
    assert.deepEqual(observation.classificationReasons, ['CLEAN_INCOMPLETE_SUBSET'])
    assert.equal(observation.corroboratedContract, 'LIVE_13_SUBSET')
    assert.equal(observation.corroboratedContractSha256, allowance.liveEnvironmentAdmissionSha256)
  } else if (observation.status === 'MALFORMED_NON_AUTHORITATIVE') {
    assertBufferObservation()
    assert.ok(observation.structuralDefectCount > 0)
    assert.equal(contradictions, 0)
    assert.deepEqual(observation.contradictedKnownNames, [])
    assert.deepEqual(observation.classificationReasons, ['STRUCTURAL_NOISE_WITH_COMPLETE_CONTRACT'])
    assert.ok(JSON.stringify(observation.knownMatchingNames) === JSON.stringify(baseNames)
      || JSON.stringify(observation.knownMatchingNames) === JSON.stringify(liveNames))
    assert.equal(observation.wellFormedRecordCount, observation.knownMatchingCount,
      'Procfs malformed well-formed/matching count changed.')
    assert.equal(observation.corroboratedContract,
      observation.knownMatchingNames.length === baseNames.length ? 'SEALED_11' : 'FULL_LIVE_13')
    assert.equal(observation.corroboratedContractSha256,
      observation.knownMatchingNames.length === baseNames.length ? baseContract.sha256 : allowance.liveEnvironmentAdmissionSha256)
  } else if (observation.status === 'SEALED_LAUNCH_CORROBORATION') {
    assertBufferObservation()
    assertCleanKnownRecords()
    assert.deepEqual(observation.knownMatchingNames, baseNames)
    assert.equal(observation.terminalNul, true)
    assert.deepEqual(observation.classificationReasons, ['EXACT_SEALED_11'])
    assert.equal(observation.corroboratedContract, 'SEALED_11')
    assert.equal(observation.corroboratedContractSha256, baseContract.sha256)
  } else if (observation.status === 'FULL_LIVE_CORROBORATION') {
    assertBufferObservation()
    assertCleanKnownRecords()
    assert.deepEqual(observation.knownMatchingNames, liveNames)
    assert.equal(observation.terminalNul, true)
    assert.deepEqual(observation.classificationReasons, ['EXACT_FULL_LIVE_13'])
    assert.equal(observation.corroboratedContract, 'FULL_LIVE_13')
    assert.equal(observation.corroboratedContractSha256, allowance.liveEnvironmentAdmissionSha256)
  } else {
    assert.equal(observation.status, 'FATAL', 'Procfs observation status changed.')
    assertNullCorroboration()
    if (observation.classificationReasons.includes('OVERFLOW')) {
      assert.deepEqual(observation.classificationReasons, ['OVERFLOW'])
      assert.equal(observation.byteLength, PROCFS_LIMIT + 1); assert.equal(observation.terminalNul, null)
      assert.equal(observation.readErrorCode, null)
      assertNoRecords()
    } else if (observation.classificationReasons.includes('UNSUPPORTED_READ_ERROR')) {
      assert.deepEqual(observation.classificationReasons, ['UNSUPPORTED_READ_ERROR'])
      assert.equal(observation.byteLength, null); assert.equal(observation.terminalNul, null)
      assert.ok(typeof observation.readErrorCode === 'string' && observation.readErrorCode.length > 0
        && !['ENOENT', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(observation.readErrorCode))
      assertNoRecords()
    } else {
      assertBufferObservation()
      if (contradictions > 0) {
        const expectedReasons = []
        if (observation.duplicateRecordCount) expectedReasons.push('DUPLICATE_NAME')
        if (observation.invalidValueRecordCount) expectedReasons.push('INVALID_VALUE_UTF8')
        if (observation.unknownRecordCount) expectedReasons.push('UNKNOWN_NAME')
        if (observation.valueMismatchRecordCount) expectedReasons.push('VALUE_MISMATCH')
        assert.deepEqual(observation.classificationReasons, expectedReasons.sort())
      } else {
        assert.ok(observation.structuralDefectCount > 0)
        assert.deepEqual(observation.contradictedKnownNames, [])
        assert.equal(observation.wellFormedRecordCount, observation.knownMatchingCount,
          'Procfs structural-incomplete well-formed/matching count changed.')
        assert.ok(JSON.stringify(observation.knownMatchingNames) !== JSON.stringify(baseNames)
          && JSON.stringify(observation.knownMatchingNames) !== JSON.stringify(liveNames),
        'Procfs structural-incomplete set changed.')
        assert.deepEqual(observation.classificationReasons, ['STRUCTURAL_INCOMPLETE'])
      }
    }
  }
  const { procfsObservationBindingSha256, ...projection } = observation
  assert.equal(procfsObservationBindingSha256,
    hashJson('modly.worlds-c3-procfs-observation-binding.v4', projection), 'Procfs observation binding changed.')
  return observation
}

function classifyProcEnvironment(input, expectedEnvironment, allowance, validatedLive, priorGates) {
  const baseContract = createEnvironmentContract(expectedEnvironment)
  validateRuntimeEnvironmentAllowance(baseContract, allowance)
  validateProcfsPriorGateProof(priorGates, validatedLive, baseContract, allowance)
  exactKeys(input, Object.hasOwn(input, 'bytes') ? ['bytes'] : Object.hasOwn(input, 'overflow')
    ? ['overflow'] : ['errorCode'], 'Procfs environment observation')
  const expectedValues = { ...expectedEnvironment,
    ...Object.fromEntries(allowance.entries.map((entry) => [entry.name, entry.value])) }
  const liveNames = Object.keys(expectedValues).sort()
  const common = { liveNames, knownRecordCounts: Object.fromEntries(liveNames.map((name) => [name, 0])),
    knownMatchingNames: [], contradictedKnownNames: [], malformedReasons: [],
    recordSlotCount: 0, wellFormedRecordCount: 0, malformedRecordCount: 0, structuralDefectCount: 0,
    unknownRecordCount: 0, duplicateRecordCount: 0, valueMismatchRecordCount: 0, invalidValueRecordCount: 0,
    corroboratedContract: null, corroboratedContractSha256: null }
  if (Object.hasOwn(input, 'overflow')) {
    exactKeys(input.overflow, ['byteLength', 'sha256'], 'Procfs overflow evidence')
    const result = createProcfsObservation({ ...common, status: 'FATAL', accepted: false,
      byteLength: input.overflow.byteLength, sha256: input.overflow.sha256, readErrorCode: null, terminalNul: null,
      classificationReasons: ['OVERFLOW'] }, priorGates, allowance.liveEnvironmentAdmissionSha256)
    return validateProcfsObservation(result, expectedEnvironment, allowance, validatedLive, priorGates)
  }
  if (Object.hasOwn(input, 'errorCode')) {
    const accepted = ['ENOENT', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(input.errorCode)
    const result = createProcfsObservation({ ...common, status: accepted ? 'UNAVAILABLE_NON_AUTHORITATIVE' : 'FATAL', accepted,
      byteLength: null, sha256: null, readErrorCode: input.errorCode, terminalNul: null,
      classificationReasons: [accepted ? 'UNAVAILABLE_ALLOWED' : 'UNSUPPORTED_READ_ERROR'] },
    priorGates, allowance.liveEnvironmentAdmissionSha256)
    return validateProcfsObservation(result, expectedEnvironment, allowance, validatedLive, priorGates)
  }
  assert.ok(Buffer.isBuffer(input.bytes) || input.bytes instanceof Uint8Array, 'Procfs environment bytes changed.')
  const bytes = Buffer.from(input.bytes)
  if (bytes.length > PROCFS_LIMIT) return classifyProcEnvironment({ overflow: { byteLength: Math.min(bytes.length, PROCFS_LIMIT + 1),
    sha256: sha256(bytes.subarray(0, PROCFS_LIMIT + 1)) } }, expectedEnvironment, allowance, validatedLive, priorGates)
  if (bytes.length === 0) {
    const result = createProcfsObservation({ ...common, status: 'EMPTY_NON_AUTHORITATIVE', accepted: true,
      byteLength: 0, sha256: sha256(bytes), readErrorCode: null, terminalNul: false,
      classificationReasons: ['EMPTY_OBSERVATION'] }, priorGates, allowance.liveEnvironmentAdmissionSha256)
    return validateProcfsObservation(result, expectedEnvironment, allowance, validatedLive, priorGates)
  }
  const sealedByteLength = deriveSealedEnvironmentByteLength(baseContract)
  let rawByteUnion = 0
  for (const byte of bytes) rawByteUnion |= byte
  if (bytes.length === sealedByteLength && rawByteUnion === 0) {
    const result = createProcfsObservation({ ...common, status: 'ZERO_FILLED_NON_AUTHORITATIVE', accepted: true,
      byteLength: bytes.length, sha256: sha256(bytes), readErrorCode: null, terminalNul: true,
      recordSlotCount: sealedByteLength, wellFormedRecordCount: 0, malformedRecordCount: sealedByteLength,
      structuralDefectCount: sealedByteLength, malformedReasons: [['EMPTY_RECORD', sealedByteLength]],
      classificationReasons: ['EXACT_ALL_ZERO_SEALED_11_LENGTH'] },
    priorGates, allowance.liveEnvironmentAdmissionSha256)
    return validateProcfsObservation(result, expectedEnvironment, allowance, validatedLive, priorGates)
  }
  const terminalNul = bytes.at(-1) === 0
  const slots = []
  let start = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) { slots.push(bytes.subarray(start, index)); start = index + 1 }
  }
  if (start < bytes.length) slots.push(bytes.subarray(start))
  const reasons = new Map()
  const addReason = (reason) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  if (!terminalNul) addReason('MISSING_TERMINAL_NUL')
  const seenNames = new Set()
  const knownMatchingNames = []
  const contradictedKnownNames = []
  let malformedRecordCount = 0
  let wellFormedRecordCount = 0
  let unknownRecordCount = 0
  let duplicateRecordCount = 0
  let valueMismatchRecordCount = 0
  let invalidValueRecordCount = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (const slot of slots) {
    if (slot.length === 0) { addReason('EMPTY_RECORD'); malformedRecordCount += 1; continue }
    const separator = slot.indexOf(0x3d)
    if (separator < 0) { addReason('MISSING_EQUALS'); malformedRecordCount += 1; continue }
    if (separator === 0) { addReason('EMPTY_NAME'); malformedRecordCount += 1; continue }
    let name
    try { name = decoder.decode(slot.subarray(0, separator)) } catch {
      addReason('INVALID_UTF8'); malformedRecordCount += 1; continue
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) { addReason('INVALID_NAME'); malformedRecordCount += 1; continue }
    const known = Object.hasOwn(expectedValues, name)
    const duplicate = seenNames.has(name)
    seenNames.add(name)
    if (!known) unknownRecordCount += 1
    else common.knownRecordCounts[name] += 1
    if (duplicate) { duplicateRecordCount += 1; if (known) contradictedKnownNames.push(name) }
    let value
    try { value = decoder.decode(slot.subarray(separator + 1)) } catch {
      addReason('INVALID_UTF8'); malformedRecordCount += 1; invalidValueRecordCount += 1
      if (known) contradictedKnownNames.push(name)
      continue
    }
    wellFormedRecordCount += 1
    if (!known) continue
    if (value !== expectedValues[name]) { valueMismatchRecordCount += 1; contradictedKnownNames.push(name); continue }
    if (!duplicate) knownMatchingNames.push(name)
  }
  knownMatchingNames.sort()
  const sealedNames = Object.keys(expectedEnvironment).sort()
  const matches = (expected) => expected.length === knownMatchingNames.length
    && expected.every((name, index) => name === knownMatchingNames[index])
  const malformedReasons = [...reasons].sort(([left], [right]) => left.localeCompare(right))
  const structuralDefectCount = malformedReasons.reduce((total, [, count]) => total + count, 0)
  const contradictionCounts = unknownRecordCount + duplicateRecordCount + valueMismatchRecordCount + invalidValueRecordCount
  let status = 'FATAL'
  let accepted = false
  let corroboratedContract = null
  let corroboratedContractSha256 = null
  const classificationReasons = []
  if (contradictionCounts > 0) {
    if (unknownRecordCount) classificationReasons.push('UNKNOWN_NAME')
    if (duplicateRecordCount) classificationReasons.push('DUPLICATE_NAME')
    if (valueMismatchRecordCount) classificationReasons.push('VALUE_MISMATCH')
    if (invalidValueRecordCount) classificationReasons.push('INVALID_VALUE_UTF8')
  } else if (structuralDefectCount > 0) {
    if (matches(sealedNames) || matches(liveNames)) {
      status = 'MALFORMED_NON_AUTHORITATIVE'; accepted = true
      corroboratedContract = matches(sealedNames) ? 'SEALED_11' : 'FULL_LIVE_13'
      corroboratedContractSha256 = matches(sealedNames) ? baseContract.sha256 : allowance.liveEnvironmentAdmissionSha256
      classificationReasons.push('STRUCTURAL_NOISE_WITH_COMPLETE_CONTRACT')
    } else classificationReasons.push('STRUCTURAL_INCOMPLETE')
  } else if (matches(sealedNames)) {
    status = 'SEALED_LAUNCH_CORROBORATION'; accepted = true; corroboratedContract = 'SEALED_11'
    corroboratedContractSha256 = baseContract.sha256; classificationReasons.push('EXACT_SEALED_11')
  } else if (matches(liveNames)) {
    status = 'FULL_LIVE_CORROBORATION'; accepted = true; corroboratedContract = 'FULL_LIVE_13'
    corroboratedContractSha256 = allowance.liveEnvironmentAdmissionSha256; classificationReasons.push('EXACT_FULL_LIVE_13')
  } else if (knownMatchingNames.length > 0) {
    status = 'INCOMPLETE_NON_AUTHORITATIVE'; accepted = true; corroboratedContract = 'LIVE_13_SUBSET'
    corroboratedContractSha256 = allowance.liveEnvironmentAdmissionSha256; classificationReasons.push('CLEAN_INCOMPLETE_SUBSET')
  } else classificationReasons.push('EMPTY_PARSEABLE_SET')
  const result = createProcfsObservation({ liveNames, knownRecordCounts: common.knownRecordCounts,
    status, accepted, byteLength: bytes.length, sha256: sha256(bytes),
    readErrorCode: null, terminalNul, recordSlotCount: slots.length, wellFormedRecordCount, malformedRecordCount,
    structuralDefectCount, malformedReasons, classificationReasons, knownMatchingNames, contradictedKnownNames,
    unknownRecordCount, duplicateRecordCount, valueMismatchRecordCount, invalidValueRecordCount,
    corroboratedContract, corroboratedContractSha256 }, priorGates, allowance.liveEnvironmentAdmissionSha256)
  return validateProcfsObservation(result, expectedEnvironment, allowance, validatedLive, priorGates)
}

function requireAcceptedProcfsObservation(observation) {
  if (!observation.accepted) throw new Error('Procfs environment classification failed.')
  return observation
}

function persistProcfsObservation(filename, observation, expectedUid, expectedEnvironment, allowance, validatedLive, priorGates) {
  validateProcfsObservation(observation, expectedEnvironment, allowance, validatedLive, priorGates)
  const expectedBytes = Buffer.from(`${JSON.stringify(observation)}\n`)
  fs.writeFileSync(filename, expectedBytes, { flag: 'wx', mode: 0o600 })
  const persistedBytes = secureReadPrivateFile(filename, expectedUid)
  assert.deepEqual(persistedBytes, expectedBytes, 'Procfs observation receipt bytes changed.')
  const persisted = JSON.parse(persistedBytes.toString('utf8'))
  validateProcfsObservation(persisted, expectedEnvironment, allowance, validatedLive, priorGates)
  assert.deepEqual(persisted, observation, 'Procfs observation receipt changed.')
  return { observation: persisted, fileSha256: sha256(persistedBytes) }
}

function privateFile(filename, expectedUid, expectedMode) {
  assert.equal(path.isAbsolute(filename), true, 'Private custody path must be absolute.')
  assert.ok(Number.isInteger(fs.constants.O_NOFOLLOW), 'O_NOFOLLOW is required for private custody.')
  let descriptor
  try { descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch (error) {
    throw new Error(`Private file symbolic-link or open custody failed: ${filename}`, { cause: error })
  }
  try {
    const info = fs.fstatSync(descriptor)
    assert.ok(info.isFile(), `Private file custody requires a regular file: ${filename}`)
    assert.equal(info.uid, expectedUid, `Private file owner custody failed: ${filename}`)
    assert.equal(info.mode & 0o777, expectedMode, `Private file mode custody failed: ${filename}`)
    assert.equal(info.nlink, 1, `Private file link custody failed: ${filename}`)
    assert.equal(fs.realpathSync(filename), filename, `Private file canonical custody failed: ${filename}`)
    return { bytes: fs.readFileSync(descriptor), info }
  } finally { fs.closeSync(descriptor) }
}

function secureReadPrivateFile(filename, expectedUid, expectedMode = 0o600) {
  return privateFile(filename, expectedUid, expectedMode).bytes
}

function validateFileReceipts(entries) {
  assert.ok(Array.isArray(entries), 'File receipts must be an array.')
  for (const expected of entries) {
    exactKeys(expected, ['path', 'bytes', 'sha256'], 'File receipt')
    assert.equal(path.isAbsolute(expected.path), true, 'File receipt path must be absolute.')
    assert.equal(fs.realpathSync(expected.path), expected.path, `Stale file receipt path: ${expected.path}`)
    const info = fs.lstatSync(expected.path)
    assert.ok(info.isFile() && !info.isSymbolicLink(), `Stale file receipt type: ${expected.path}`)
    const bytes = fs.readFileSync(expected.path)
    assert.equal(bytes.length, expected.bytes, `Stale file receipt byte count: ${expected.path}`)
    assert.equal(sha256(bytes), expected.sha256, `Stale file receipt hash: ${expected.path}`)
  }
}

function validateBuildReceipts(build, bundleDirectory, expectedUid) {
  validateFileReceipts(build.sourceInputs)
  for (const [relative, expected] of Object.entries(build.outputs)) {
    assert.match(relative, /^(?:(?:bootstrap|main|preload)\.cjs|renderer\/(?:index\.html|assets\/[A-Za-z0-9_.-]+\.(?:js|css)))$/)
    exactKeys(expected, ['bytes', 'sha256'], 'Output receipt')
    const bytes = secureReadPrivateFile(path.join(bundleDirectory, relative), expectedUid)
    assert.equal(bytes.length, expected.bytes, `Stale output receipt byte count: ${relative}`)
    assert.equal(sha256(bytes), expected.sha256, `Stale output receipt hash: ${relative}`)
  }
}

function readBoundProcfsObservationReceipt(stateRoot, expectedUid, observation, expectedEnvironment,
  allowance, validatedLive, priorGates) {
  assert.equal(path.isAbsolute(stateRoot), true, 'Procfs state root must be absolute.')
  assert.equal(path.resolve(stateRoot), stateRoot, 'Procfs state root must be canonical.')
  validateProcfsPriorGateProof(priorGates, validatedLive, expectedEnvironment, allowance)
  const filename = path.join(stateRoot, 'procfs-observation.v4.json')
  assert.ok(Number.isSafeInteger(expectedUid) && expectedUid >= 0, 'Procfs observation receipt UID changed.')
  const parentPath = path.dirname(filename)
  assert.equal(fs.realpathSync(parentPath), parentPath, 'Procfs observation parent custody changed.')
  const parent = fs.lstatSync(parentPath)
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), 'Procfs observation parent type changed.')
  assert.equal(parent.uid, expectedUid, 'Procfs observation parent owner changed.')
  assert.equal(parent.mode & 0o777, 0o700, 'Procfs observation parent mode changed.')
  const expectedBytes = Buffer.from(`${JSON.stringify(observation)}\n`)
  const persistedBytes = secureReadPrivateFile(filename, expectedUid)
  assert.deepEqual(persistedBytes, expectedBytes, 'Procfs persisted observation bytes changed.')
  const persisted = JSON.parse(persistedBytes.toString('utf8'))
  validateProcfsObservation(persisted, expectedEnvironment, allowance, validatedLive, priorGates)
  assert.deepEqual(persisted, observation, 'Procfs persisted observation changed.')
  return { path: filename, fileSha256: sha256(persistedBytes) }
}

function createEnvironmentAdmissionReceipt(fields) {
  exactKeys(fields, ['validated', 'allowance', 'manifestFileSha256', 'launchBindingSha256', 'supervisorReceiptSha256',
    'supervisorPid', 'bootstrapPid', 'priorGates', 'procfs', 'build', 'expectedUid'],
  'Environment admission fields')
  const baseContract = {
    schema: ENVIRONMENT_SCHEMA,
    entries: fields.validated.base.entries,
    sha256: fields.validated.base.sha256,
  }
  validateRuntimeEnvironmentAllowance(baseContract, fields.allowance)
  assert.deepEqual(fields.validated, expectedValidatedLive(baseContract, fields.allowance),
    'Environment admission validated-live evidence changed.')
  for (const name of ['manifestFileSha256', 'launchBindingSha256', 'supervisorReceiptSha256']) {
    assert.match(fields[name], /^[a-f0-9]{64}$/, `Environment admission hash changed: ${name}`)
  }
  for (const name of ['supervisorPid', 'bootstrapPid']) {
    assert.ok(Number.isSafeInteger(fields[name]) && fields[name] > 1, `Environment admission PID changed: ${name}`)
  }
  assert.equal(fields.build.launch.launchBindingSha256, fields.launchBindingSha256,
    'Environment admission manifest launch binding changed.')
  assert.equal(createLaunchBindingSha256(fields.build), fields.launchBindingSha256,
    'Environment admission canonical launch binding changed.')
  const stateRoot = fields.build.launch.paths.stateRoot
  validateProcfsPriorGateProof(fields.priorGates, fields.validated, baseContract, fields.allowance)
  for (const name of ['manifestFileSha256', 'launchBindingSha256', 'supervisorReceiptSha256',
    'supervisorPid', 'bootstrapPid']) {
    assert.equal(fields[name], fields.priorGates[name], `Environment admission prior-gate field changed: ${name}`)
  }
  validateProcfsObservation(fields.procfs, baseContract, fields.allowance, fields.validated, fields.priorGates)
  requireAcceptedProcfsObservation(fields.procfs)
  const persistedProcfs = readBoundProcfsObservationReceipt(stateRoot, fields.expectedUid,
    fields.procfs, baseContract, fields.allowance, fields.validated, fields.priorGates)
  const receipt = {
    schema: 'modly.worlds-c3-environment-admission.v5',
    status: 'PASS_EXACT_RUNTIME_BOUND_ENVIRONMENT',
    base: structuredClone(fields.validated.base),
    additions: structuredClone(fields.validated.additions),
    runtimeIdentity: structuredClone(fields.allowance.runtimeIdentity),
    runtimeIdentitySha256: fields.validated.runtimeIdentitySha256,
    liveEnvironmentAdmissionSha256: fields.validated.liveEnvironmentAdmissionSha256,
    manifestFileSha256: fields.manifestFileSha256,
    launchBindingSha256: fields.launchBindingSha256,
    supervisorReceiptSha256: fields.supervisorReceiptSha256,
    supervisorPid: fields.supervisorPid,
    bootstrapPid: fields.bootstrapPid,
    priorGateBindingSha256: fields.priorGates.priorGateBindingSha256,
    procfs: structuredClone(fields.procfs),
    procfsObservationSha256: fields.procfs.procfsObservationBindingSha256,
    procfsObservationPath: persistedProcfs.path,
    procfsObservationFileSha256: persistedProcfs.fileSha256,
  }
  receipt.environmentAdmissionBindingSha256 = hashJson('modly.worlds-c3-environment-admission-binding.v5', receipt)
  return receipt
}

function validateEnvironmentAdmissionReceipt(receipt, fields) {
  exactKeys(receipt, ['schema', 'status', 'base', 'additions', 'runtimeIdentity', 'runtimeIdentitySha256',
    'liveEnvironmentAdmissionSha256', 'manifestFileSha256', 'launchBindingSha256', 'supervisorReceiptSha256',
    'supervisorPid', 'bootstrapPid', 'priorGateBindingSha256', 'procfs', 'procfsObservationSha256',
    'procfsObservationPath', 'procfsObservationFileSha256', 'environmentAdmissionBindingSha256'],
  'Environment admission receipt')
  exactKeys(receipt.base, ['count', 'names', 'entries', 'sha256'], 'Environment admission base')
  exactKeys(receipt.additions, ['count', 'names', 'entries', 'runtimeEnvironmentAllowanceSha256'], 'Environment admission additions')
  assert.equal(receipt.schema, 'modly.worlds-c3-environment-admission.v5', 'Environment admission schema changed.')
  assert.equal(receipt.status, 'PASS_EXACT_RUNTIME_BOUND_ENVIRONMENT', 'Environment admission status changed.')
  validateProcfsObservation(receipt.procfs, {
    schema: ENVIRONMENT_SCHEMA, entries: receipt.base.entries, sha256: receipt.base.sha256,
  }, fields.allowance, fields.validated, fields.priorGates)
  assert.equal(receipt.priorGateBindingSha256, fields.priorGates.priorGateBindingSha256,
    'Environment admission prior-gate binding changed.')
  assert.equal(receipt.procfsObservationSha256, receipt.procfs.procfsObservationBindingSha256,
    'Procfs observation binding changed.')
  assert.equal(fields.build.launch.launchBindingSha256, fields.launchBindingSha256,
    'Environment admission manifest launch binding changed.')
  assert.equal(createLaunchBindingSha256(fields.build), fields.launchBindingSha256,
    'Environment admission canonical launch binding changed.')
  const expectedProcfsObservationPath = path.join(fields.build.launch.paths.stateRoot, 'procfs-observation.v4.json')
  assert.equal(receipt.procfsObservationPath, expectedProcfsObservationPath,
    'Procfs observation path binding changed.')
  const persistedProcfs = readBoundProcfsObservationReceipt(fields.build.launch.paths.stateRoot, fields.expectedUid,
    fields.procfs, { schema: ENVIRONMENT_SCHEMA, entries: receipt.base.entries, sha256: receipt.base.sha256 },
    fields.allowance, fields.validated, fields.priorGates)
  assert.equal(receipt.procfsObservationFileSha256, persistedProcfs.fileSha256,
    'Procfs persisted observation file binding changed.')
  const { environmentAdmissionBindingSha256, ...projection } = receipt
  assert.equal(environmentAdmissionBindingSha256,
    hashJson('modly.worlds-c3-environment-admission-binding.v5', projection), 'Environment admission binding changed.')
  assert.deepEqual(receipt, createEnvironmentAdmissionReceipt(fields), 'Environment admission receipt changed.')
  return receipt
}

function validateSupervisorReceipt(build, manifestBytes, receipt, parentPid) {
  exactKeys(receipt, [
    'schema', 'phase', 'manifestFileSha256', 'launchBindingSha256', 'environmentContractSha256',
    'environmentEntries', 'argvSha256', 'supervisorPid', 'supervisorUid', 'xvfbPid', 'display',
    'authorityPath', 'authority', 'authenticatedReady',
  ], 'Supervisor pre-exec receipt')
  exactKeys(receipt.authority, ['uid', 'mode', 'nlink'], 'Supervisor authority receipt')
  const environmentContract = createEnvironmentContract(build.launch.environment)
  assert.deepEqual(build.launch.environmentContract, environmentContract, 'Manifest environment binding changed.')
  validateRuntimeEnvironmentAllowance(environmentContract, build.launch.runtimeEnvironmentAllowance)
  assert.equal(build.launch.argvSha256, createArgvSha256(build.launch.argv), 'Manifest argv binding changed.')
  assert.equal(build.launch.launchBindingSha256, createLaunchBindingSha256(build), 'Manifest launch binding changed.')
  assert.equal(receipt.schema, PREEXEC_SCHEMA, 'Supervisor receipt schema changed.')
  assert.equal(receipt.phase, 'PRE_EXEC', 'Supervisor receipt phase changed.')
  assert.equal(receipt.manifestFileSha256, sha256(manifestBytes), 'Supervisor manifest binding changed.')
  assert.equal(receipt.launchBindingSha256, build.launch.launchBindingSha256, 'Supervisor launch binding changed.')
  assert.equal(receipt.environmentContractSha256, environmentContract.sha256, 'Supervisor environment binding changed.')
  assert.deepEqual(receipt.environmentEntries, environmentContract.entries, 'Supervisor environment entries changed.')
  assert.equal(receipt.argvSha256, build.launch.argvSha256, 'Supervisor argv binding changed.')
  assert.ok(Number.isSafeInteger(receipt.supervisorPid) && receipt.supervisorPid > 1, 'Supervisor PID is invalid.')
  assert.equal(receipt.supervisorPid, parentPid, 'Supervisor parent binding changed.')
  assert.equal(receipt.supervisorUid, build.launch.supervisor.expectedOwnerUid, 'Supervisor UID changed.')
  assert.ok(Number.isSafeInteger(receipt.xvfbPid) && receipt.xvfbPid > 1, 'Xvfb PID is invalid.')
  assert.equal(receipt.display, build.launch.display.name, 'Supervisor display changed.')
  assert.equal(receipt.authorityPath, build.launch.display.authorityPath, 'Supervisor authority path changed.')
  assert.deepEqual(receipt.authority, { uid: build.launch.supervisor.expectedOwnerUid, mode: '600', nlink: 1 }, 'Supervisor authority custody changed.')
  assert.equal(receipt.authenticatedReady, true, 'Supervisor readiness changed.')
}

module.exports = {
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
  validateFileReceipts,
  validateProcfsObservation,
  validateRuntimeEnvironment,
  validateRuntimeEnvironmentAllowance,
  validateRuntimeIdentity,
  validateSupervisorReceipt,
}

let app = null
let runtimeFailure = null
let failureDirectory = null
let failed = false

function fail(error) {
  if (runtimeFailure) { runtimeFailure(error); return }
  if (failed) return
  failed = true
  const message = String(error?.stack ?? error).slice(0, 8192)
  try {
    if (failureDirectory) fs.writeFileSync(path.join(failureDirectory, 'startup-failure.json'), `${JSON.stringify({ status: 'FAIL', error: message })}\n`, { flag: 'wx', mode: 0o600 })
    else process.stderr.write(`${message}\n`)
  } catch { /* Exit cannot depend on evidence writing. */ }
  if (app) app.exit(1)
  else process.exitCode = 1
}

function runBootstrap() {
  app = require('electron').app
  process.on('uncaughtException', fail)
  process.on('unhandledRejection', fail)
  try {
    const bundleDirectory = path.resolve(__dirname)
    assert.equal(path.dirname(bundleDirectory), '/tmp')
    assert.match(path.basename(bundleDirectory), /^modly-worlds-c3-native-[A-Za-z0-9_-]+$/)
    const directory = (filename) => {
      assert.equal(fs.realpathSync(filename), filename)
      const info = fs.lstatSync(filename)
      assert.ok(info.isDirectory() && !info.isSymbolicLink())
      assert.equal(info.uid, process.getuid())
      assert.equal(info.mode & 0o777, 0o700)
    }
    directory(bundleDirectory)
    const manifestPath = path.join(bundleDirectory, 'fixture-build.json')
    const manifestBytes = secureReadPrivateFile(manifestPath, process.getuid())
    const build = JSON.parse(manifestBytes.toString('utf8'))
    exactKeys(build, ['schema', 'scope', 'execution', 'nativeEvidence', 'outputDirectory', 'repositoryRoot', 'builtAt', 'versions',
      'outputs', 'outputInventory', 'sourceInputs', 'sourceAggregateSha256', 'sourceGraph', 'gitCustody', 'launch', 'nextCommand', 'limits'], 'Build manifest')
    assert.equal(build.schema, 'modly.worlds-codex-direct-edit-native-build.v1')
    assert.equal(build.execution, 'NOT_RUN')
    assert.equal(build.nativeEvidence, 'ABSENT')
    assert.equal(build.outputDirectory, bundleDirectory)
    assert.equal(build.versions.electron, process.versions.electron)
    const launch = build.launch
    exactKeys(launch, ['paths', 'display', 'supervisor', 'scenarios', 'argv', 'environment', 'preparedDirectories',
      'environmentContract', 'runtimeEnvironmentAllowance', 'argvSha256', 'launchBindingSha256'], 'Fixture launch')
    const expectedRuntimeIdentity = materializePinnedRuntimeIdentity(build.repositoryRoot)
    validateRuntimeIdentity(expectedRuntimeIdentity, launch.runtimeEnvironmentAllowance.runtimeIdentity)
    assert.equal(launch.argv[0], expectedRuntimeIdentity.executable.path, 'Runtime launch executable admission changed.')
    failureDirectory = launch.paths.stateRoot
    for (const entry of launch.preparedDirectories) {
      directory(entry.path)
      assert.equal(entry.uid, process.getuid())
      assert.equal(entry.mode, 0o700)
    }
    assert.equal(JSON.stringify(process.argv), JSON.stringify(launch.argv))
    assert.equal(__filename, launch.argv[1])
    const supervisorBytes = secureReadPrivateFile(launch.supervisor.evidencePath, process.getuid())
    const supervisorReceipt = JSON.parse(supervisorBytes.toString('utf8'))
    validateSupervisorReceipt(build, manifestBytes, supervisorReceipt, process.ppid)
    const actualRuntimeIdentity = {
      schema: RUNTIME_IDENTITY_SCHEMA,
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      executable: inspectRuntimeExecutable(process.execPath),
    }
    validateRuntimeIdentity(expectedRuntimeIdentity, actualRuntimeIdentity)
    const liveEnvironment = validateRuntimeEnvironment(
      launch.environment, launch.environmentContract, launch.runtimeEnvironmentAllowance, process.env, actualRuntimeIdentity)
    const assertLiveEnvironment = (environment) => validateRuntimeEnvironment(
      launch.environment, launch.environmentContract, launch.runtimeEnvironmentAllowance, environment, actualRuntimeIdentity)
    assert.equal(process.env.DISPLAY, launch.display.name)
    assert.equal(process.env.XAUTHORITY, launch.display.authorityPath)
    assert.equal(path.dirname(launch.display.authorityPath), launch.paths.x11)
    assert.ok(launch.display.authorityPath.startsWith(`${launch.paths.stateRoot}${path.sep}`))
    const authority = privateFile(launch.display.authorityPath, process.getuid(), 0o600)
    assert.deepEqual({ uid: authority.info.uid, mode: (authority.info.mode & 0o777).toString(8), nlink: authority.info.nlink }, supervisorReceipt.authority)
    assert.equal(fs.realpathSync(path.dirname(launch.display.authorityPath)), launch.paths.x11)
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SANDBOX', 'SESSION_MANAGER']) assert.equal(Object.hasOwn(process.env, name), false, name)
    assert.equal(app.commandLine.getSwitchValue('user-data-dir'), launch.paths.userData)
    const forbiddenSandboxSwitches = ['no-sandbox', 'no-zygote', 'disable-setuid-sandbox', 'disable-gpu-sandbox', 'disable-web-security']
    for (const flag of forbiddenSandboxSwitches) {
      assert.equal(app.commandLine.hasSwitch(flag), false, flag)
    }
    app.enableSandbox()
    validateBuildReceipts(build, bundleDirectory, process.getuid())
    const aggregate = sha256(Buffer.from(JSON.stringify(build.sourceInputs.map((entry) => [entry.path, entry.bytes, entry.sha256]))))
    assert.equal(aggregate, build.sourceAggregateSha256)
    const procfsPriorGates = createProcfsPriorGateProof({
      validatedLive: liveEnvironment,
      manifestFileSha256: sha256(manifestBytes),
      launchBindingSha256: launch.launchBindingSha256,
      supervisorReceiptSha256: sha256(supervisorBytes),
      supervisorPid: process.ppid,
      bootstrapPid: process.pid,
      sourceAggregateSha256: aggregate,
      outputReceiptsSha256: hashJson('modly.worlds-c3-output-receipts.v1', build.outputs),
      authorityGateSha256: hashJson('modly.worlds-c3-authority-gate.v1', {
        path: launch.display.authorityPath, uid: authority.info.uid,
        mode: (authority.info.mode & 0o777).toString(8), nlink: authority.info.nlink,
      }),
      sandboxGateSha256: hashJson('modly.worlds-c3-sandbox-gate.v1', {
        enabled: true, forbiddenSwitchesAbsent: forbiddenSandboxSwitches,
      }),
      buildReceiptGatesPassed: true,
    })
    let procObservation
    try { procObservation = readBoundedProcEnvironment() } catch (error) {
      if (!error?.code) throw error
      procObservation = { errorCode: error.code }
    }
    const procfs = classifyProcEnvironment(procObservation, launch.environment, launch.runtimeEnvironmentAllowance,
      liveEnvironment, procfsPriorGates)
    const procfsObservationPath = path.join(launch.paths.stateRoot, 'procfs-observation.v4.json')
    persistProcfsObservation(procfsObservationPath,
      procfs, process.getuid(), launch.environment, launch.runtimeEnvironmentAllowance, liveEnvironment, procfsPriorGates)
    requireAcceptedProcfsObservation(procfs)
    const admissionFields = {
      validated: liveEnvironment,
      allowance: launch.runtimeEnvironmentAllowance,
      manifestFileSha256: sha256(manifestBytes),
      launchBindingSha256: launch.launchBindingSha256,
      supervisorReceiptSha256: sha256(supervisorBytes),
      supervisorPid: process.ppid,
      bootstrapPid: process.pid,
      priorGates: procfsPriorGates,
      procfs,
      build,
      expectedUid: process.getuid(),
    }
    const admission = createEnvironmentAdmissionReceipt(admissionFields)
    const admissionPath = path.join(launch.paths.stateRoot, 'environment-admission.v5.json')
    fs.writeFileSync(admissionPath, `${JSON.stringify(admission)}\n`, { flag: 'wx', mode: 0o600 })
    const persistedAdmissionBytes = secureReadPrivateFile(admissionPath, process.getuid())
    assert.equal(persistedAdmissionBytes.toString('utf8'), `${JSON.stringify(admission)}\n`,
      'Environment admission bytes changed.')
    const persistedAdmission = JSON.parse(persistedAdmissionBytes.toString('utf8'))
    validateEnvironmentAdmissionReceipt(persistedAdmission, admissionFields)
    fs.writeFileSync(path.join(launch.paths.stateRoot, 'startup-attempt.json'), `${JSON.stringify({ pid: process.pid })}\n`, { flag: 'wx', mode: 0o600 })
    assert.equal(app.isReady(), false)
    app.setName('Worlds C3 native acceptance')
    for (const name of ['userData', 'sessionData', 'crashDumps']) app.setPath(name, launch.paths[name])
    const builtinFileAccess = app.commandLine.hasSwitch('allow-file-access-from-files')
    const runtime = require(path.join(bundleDirectory, 'main.cjs'))
    assert.equal(typeof runtime.startFixture, 'function')
    runtime.startFixture(Object.freeze({ bundleDirectory, build, launch, builtinFileAccess, assertLiveEnvironment,
      takeOwnership(handler) { assert.equal(runtimeFailure, null); runtimeFailure = handler } }))
    assert.equal(typeof runtimeFailure, 'function')
  } catch (error) { fail(error) }
}

if (process.versions.electron) runBootstrap()
