#!/usr/bin/env node
'use strict'

const { createHash, randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

const {
  WORLD_FFMPEG_DENY_NETWORK_PRELOAD: DENY_NETWORK_PRELOAD,
  requireClosedWorldFfmpegBuilderEnvironment,
} = require('./world-ffmpeg-package-environment.cjs')
const garbageProtocol = require('./world-ffmpeg-owned-garbage-protocol.cjs')

const CONFIG_PATH = join(__dirname, 'world-ffmpeg-electron-builder-config.json')
const RUNNER_HEARTBEAT_SCHEMA = 'modly.electron-builder-package-runner-heartbeat.v1'
const RUNNER_TERMINAL_SCHEMA = 'modly.electron-builder-package-runner-terminal.v1'
const ATTEMPT_PATTERN = /^[a-f0-9]{32}$/
const HEARTBEAT_INTERVAL_MS = 1_000
const OWNED_GARBAGE_RECEIPT_SCHEMA = 'modly.world-ffmpeg-owned-garbage-receipt.v1'
const OWNED_GARBAGE_MAXIMUM_BYTES = 64 * 1024 * 1024 * 1024 + 1024 * 1024 + 128 * 1024
const OWNED_GARBAGE_CLAIM_MAXIMUM_BYTES = 16 * 1024
const OWNED_GARBAGE_INTENT_MAXIMUM_BYTES = 64 * 1024 * 1024
const OWNED_GARBAGE_TOMBSTONE_MAXIMUM_BYTES = 32 * 1024
const OWNED_GARBAGE_PUBLICATION_TEMPORARY_LIMIT = 64
const TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({ platformName: 'MAC', arch: 'arm64' }),
  'linux-arm64': Object.freeze({ platformName: 'LINUX', arch: 'arm64' }),
  'linux-x64': Object.freeze({ platformName: 'LINUX', arch: 'x64' }),
  'win32-x64': Object.freeze({ platformName: 'WINDOWS', arch: 'x64' }),
})

async function runTrustedWorldFfmpegElectronBuilder() {
  return runTrustedWorldFfmpegElectronBuilderWith({
    environment: process.env,
    execArgv: process.execArgv,
    projectDirectory: process.cwd(),
    loadBuilder: loadProgrammaticBuilder,
    runtime: {
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
      electronVersion: process.versions.electron,
    },
  })
}

async function runTrustedWorldFfmpegElectronBuilderWith(dependencies) {
  if (!dependencies || typeof dependencies !== 'object'
    || (dependencies.loadBuilder !== undefined && typeof dependencies.loadBuilder !== 'function')
    || (dependencies.createWindowsPortableZip !== undefined && typeof dependencies.createWindowsPortableZip !== 'function')
    || (dependencies.outputCustody !== undefined && typeof dependencies.outputCustody !== 'function')
    || (dependencies.spawnIdentityProbeSync !== undefined && typeof dependencies.spawnIdentityProbeSync !== 'function')
    || typeof dependencies.projectDirectory !== 'string') {
    throw new Error('Audited electron-builder runner dependencies are invalid.')
  }
  const environment = dependencies.environment
  const outputCustody = dependencies.outputCustody
    ?? (await import('./world-ffmpeg-output-custody.mjs')).runWorldFfmpegOutputCustody
  requireExactExecArgv(dependencies.execArgv)
  const target = requireClosedWorldFfmpegBuilderEnvironment(environment, dependencies.runtime)
  const projectDir = resolve(dependencies.projectDirectory)
  const attempt = requireAttemptAuthority(environment, target)
  const builder = (dependencies.loadBuilder ?? loadProgrammaticBuilder)()
  requireExactExecArgv(dependencies.execArgv)
  requireClosedWorldFfmpegBuilderEnvironment(environment, dependencies.runtime)
  requireBuilderApi(builder)
  const authority = TARGETS[target]
  const platform = builder.Platform[authority.platformName]
  if (platform == null) throw new Error('Trusted electron-builder platform authority is unavailable.')
  const targets = builder.createTargets([platform], null, authority.arch)
  const runnerIdentity = randomBytes(16).toString('hex')
  const processStartIdentity = readProcessStartIdentity(process.pid, {
    platform: dependencies.runtime.platform,
    attemptToken: attempt.attemptId,
    environment,
    spawnSync: dependencies.spawnIdentityProbeSync,
  })
  if (!validConcreteProcessStartIdentity(processStartIdentity)) {
    throw new Error('Trusted electron-builder runner process identity authority is unavailable.')
  }
  const cacheRoot = await outputCustody({
    operation: 'directory',
    directory: attempt.cacheDirectory,
    expectedDirectoryIdentity: attempt.cacheIdentity,
    segments: [],
    environment,
  })
  const outputRoot = await outputCustody({
    operation: 'directory',
    directory: attempt.outputDirectory,
    expectedDirectoryIdentity: attempt.outputIdentity,
    segments: [],
    environment,
  })
  const outputRootIdentity = outputRoot.rootIdentity
  if (!sameDirectoryIdentity(cacheRoot.rootIdentity, attempt.cacheIdentity)
    || !sameDirectoryIdentity(outputRootIdentity, attempt.outputIdentity)) {
    throw new Error('Trusted electron-builder attempt directory identity changed.')
  }
  const heartbeat = startRunnerHeartbeat(attempt, runnerIdentity, processStartIdentity)
  let buildError
  try {
    const builderResult = await builder.build(Object.freeze({
      projectDir,
      config: loadAttemptConfig(attempt.outputDirectory, target),
      publish: 'never',
      targets,
    }))
    const result = target === 'win32-x64'
      ? [await createWindowsPortableArtifact({
        projectDir,
        attempt,
        outputRootIdentity,
        createPortableZip: dependencies.createWindowsPortableZip,
      })]
      : builderResult
    const artifacts = await requireContainedArtifacts(
      result,
      attempt.outputDirectory,
      outputRootIdentity,
      outputCustody,
      environment,
    )
    heartbeat.assertHealthy()
    writeRunnerTerminal(attempt, {
      runnerIdentity,
      processStartIdentity,
      cacheIdentity: attempt.cacheIdentity,
      outputIdentity: outputRootIdentity,
      status: 'succeeded',
      artifacts,
    })
    return result
  } catch (error) {
    buildError = error
    try {
      writeRunnerTerminal(attempt, {
        runnerIdentity,
        processStartIdentity,
        cacheIdentity: attempt.cacheIdentity,
        outputIdentity: outputRootIdentity,
        status: 'failed',
        artifacts: [],
      })
    } catch (terminalError) {
      throw new AggregateError([error, terminalError], 'Trusted electron-builder and terminal publication failed.')
    }
    throw error
  } finally {
    try {
      heartbeat.stop()
    } catch (heartbeatError) {
      if (buildError === undefined) throw heartbeatError
      throw new AggregateError(
        [buildError, heartbeatError],
        'Trusted electron-builder operation and heartbeat finalization failed.',
      )
    }
  }
}

async function createWindowsPortableArtifact(input) {
  const metadataPath = join(input.projectDir, 'package.json')
  let metadata
  try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) } catch {
    throw new Error('Trusted Windows portable package metadata is invalid.')
  }
  if (metadata?.productName !== 'Modly' && metadata?.build?.productName !== 'Modly') {
    throw new Error('Trusted Windows portable package product authority is invalid.')
  }
  if (typeof metadata.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version)) {
    throw new Error('Trusted Windows portable package version is invalid.')
  }
  const createPortableZip = input.createPortableZip
    ?? (await import('./world-ffmpeg-portable-zip.mjs')).createWorldFfmpegPortableZip
  const receipt = await createPortableZip(Object.freeze({
    sourceDirectory: join(input.attempt.outputDirectory, 'win-unpacked'),
    outputDirectory: input.attempt.outputDirectory,
    outputIdentity: input.outputRootIdentity,
    artifactName: `Modly-${metadata.version}-win32-x64.zip`,
    rootName: 'Modly-win32-x64',
  }))
  const expectedPath = join(input.attempt.outputDirectory, `Modly-${metadata.version}-win32-x64.zip`)
  if (!receipt || receipt.path !== expectedPath || receipt.name !== `Modly-${metadata.version}-win32-x64.zip`
    || !Number.isSafeInteger(receipt.size) || receipt.size < 22
    || !/^[a-f0-9]{64}$/.test(receipt.sha256)) {
    throw new Error('Trusted Windows portable package receipt is invalid.')
  }
  return expectedPath
}

function requireAttemptAuthority(environment, target) {
  const attemptId = environment.WORLD_FFMPEG_PACKAGE_ATTEMPT_ID
  const outputDirectory = environment.WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY
  const cacheDirectory = environment.ELECTRON_BUILDER_CACHE
  const cacheIdentity = decodeDirectoryIdentity(environment.WORLD_FFMPEG_PACKAGE_CACHE_IDENTITY)
  const outputIdentity = decodeDirectoryIdentity(environment.WORLD_FFMPEG_PACKAGE_OUTPUT_IDENTITY)
  const heartbeatPath = environment.WORLD_FFMPEG_PACKAGE_RUNNER_HEARTBEAT
  const terminalPath = environment.WORLD_FFMPEG_PACKAGE_RUNNER_TERMINAL
  if (!ATTEMPT_PATTERN.test(attemptId)
    || typeof cacheDirectory !== 'string' || !isAbsolute(cacheDirectory)
    || typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory)
    || typeof heartbeatPath !== 'string' || !isAbsolute(heartbeatPath)
    || typeof terminalPath !== 'string' || !isAbsolute(terminalPath)) {
    throw new Error('Trusted electron-builder attempt authority is invalid.')
  }
  return Object.freeze({
    attemptId, target, cacheDirectory: resolve(cacheDirectory), cacheIdentity,
    outputDirectory, outputIdentity, heartbeatPath, terminalPath,
  })
}

function loadAttemptConfig(outputDirectory, target) {
  const bytes = fs.readFileSync(CONFIG_PATH)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error('Trusted electron-builder config snapshot is invalid.')
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))
    || !value || typeof value !== 'object' || Array.isArray(value)
    || !value.directories || typeof value.directories !== 'object'
    || value.directories.output !== 'dist') {
    throw new Error('Trusted electron-builder config snapshot is noncanonical or unexpected.')
  }
  if (target === 'linux-arm64' || target === 'linux-x64') {
    const resources = value.linux?.extraResources
    if (!Array.isArray(resources) || JSON.stringify(resources) !== JSON.stringify([
        { from: 'resources/python-embed', to: 'python-embed' },
        { from: 'resources/ffmpeg/linux-${arch}', to: 'ffmpeg/linux-${arch}' },
        { from: 'resources/world-ffmpeg-build-reports/linux-${arch}.json', to: 'world-ffmpeg-build-reports/linux-${arch}.json' },
      ])) {
      throw new Error('Trusted electron-builder Linux FFmpeg resource tuple is invalid.')
    }
  }
  value.directories = { ...value.directories, output: outputDirectory }
  return deepFreeze(value)
}

function startRunnerHeartbeat(attempt, runnerIdentity, processStartIdentity, dependencies = {}) {
  const record = Object.freeze({
    schema: RUNNER_HEARTBEAT_SCHEMA,
    attemptId: attempt.attemptId,
    target: attempt.target,
    runnerIdentity,
    runnerPid: process.pid,
    processStartIdentity,
  })
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
  let descriptor
  try {
    descriptor = fs.openSync(attempt.heartbeatPath, fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0), 0o600)
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    syncDirectory(dirname(attempt.heartbeatPath))
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch { /* cleanup only */ }
    throw error
  }
  const intervalMs = dependencies.intervalMs ?? HEARTBEAT_INTERVAL_MS
  const futimesSync = dependencies.futimesSync ?? fs.futimesSync
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000
    || typeof futimesSync !== 'function') {
    throw new Error('Trusted electron-builder heartbeat dependencies are invalid.')
  }
  let stopped = false
  let refreshError
  const refresh = () => {
    if (stopped || refreshError !== undefined) return
    try {
      const now = new Date()
      futimesSync(descriptor, now, now)
    } catch (error) {
      refreshError = error
    }
  }
  const timer = setInterval(refresh, intervalMs)
  timer.unref?.()
  const assertHealthy = () => {
    if (refreshError !== undefined) {
      throw new Error('Trusted electron-builder runner heartbeat refresh failed.', { cause: refreshError })
    }
  }
  return Object.freeze({
    assertHealthy,
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      try {
        quarantineOwnedAuthorityFileSync(attempt.heartbeatPath, descriptor, {
          afterClaimDurable: dependencies.afterClaimDurable,
          afterIntentDurable: dependencies.afterIntentDurable,
          afterQuarantine: dependencies.afterQuarantine,
          beforeRetirement: dependencies.beforeRetirement,
          afterFileReclaim: dependencies.afterFileReclaim,
          afterReceiptDurable: dependencies.afterReceiptDurable,
          afterCompletionTempWrite: dependencies.afterCompletionTempWrite,
          afterCompletionTempSync: dependencies.afterCompletionTempSync,
          afterCompletionRename: dependencies.afterCompletionRename,
          afterCompletionDirectorySync: dependencies.afterCompletionDirectorySync,
        })
      } finally {
        fs.closeSync(descriptor)
        descriptor = undefined
      }
      assertHealthy()
    },
  })
}

function quarantineOwnedAuthorityFileSync(path, descriptor, dependencies = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || /[\r\n]/.test(path)
    || !Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error('Trusted electron-builder runner cleanup authority is invalid.')
  }
  const parent = dirname(path)
  const sourceName = basename(path)
  const descriptorInfo = fs.fstatSync(descriptor, { bigint: true })
  if (!ordinarySingleLinkFileBigInt(descriptorInfo)) {
    throw new Error('Trusted electron-builder runner heartbeat identity changed: the retained inode is no longer single-linked.')
  }
  const publicInfo = optionalLstatBigInt(path)
  if (publicInfo && !sameStableFileBigInt(publicInfo, descriptorInfo)) {
    throw new Error('Trusted electron-builder runner heartbeat identity changed.')
  }
  const sourceAuthority = garbageProtocol.sourceAuthorityFromStat(descriptorInfo)
  const sourceIdentity = fileIdentityBigInt(descriptorInfo)
  const maximumBytes = dependencies.maximumBytes ?? OWNED_GARBAGE_MAXIMUM_BYTES
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    || maximumBytes > garbageProtocol.MAXIMUM_SUPPORTED_BYTES) {
    throw new Error('Trusted electron-builder runner cleanup byte bound is invalid.')
  }
  const claim = createOrOpenGarbageClaimSync({
    parent,
    sourceName,
    label: 'runner-heartbeat',
    sourceIdentity,
    sourceAuthority,
    maximumBytes,
    allowCreate: publicInfo !== null,
    afterClaimTempSync: dependencies.afterClaimTempSync,
  })
  let intent
  let primaryError
  try {
    dependencies.afterClaimDurable?.(garbageClaimAuthoritySync(claim, path))
    intent = createOrOpenGarbageIntentSync(claim, maximumBytes)
    if (intent.created) dependencies.afterIntentDurable?.(garbageIntentAuthoritySync(intent, path))
    dependencies.afterQuarantineParentDurable?.(garbageIntentAuthoritySync(intent, path))
    return executeGarbageFileIntentSync(intent, path, descriptor, dependencies)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const closeErrors = []
    if (intent?.quarantineParentDescriptor !== undefined) {
      try { fs.closeSync(intent.quarantineParentDescriptor) } catch (error) { closeErrors.push(error) }
    }
    if (intent) try { fs.closeSync(intent.descriptor) } catch (error) { closeErrors.push(error) }
    try { fs.closeSync(claim.descriptor) } catch (error) { closeErrors.push(error) }
    if (closeErrors.length > 0) {
      throw new AggregateError(
        primaryError ? [primaryError, ...closeErrors] : closeErrors,
        'Trusted electron-builder runner cleanup transaction descriptor release failed.',
      )
    }
  }
}

function createOrOpenGarbageClaimSync(input) {
  const claimName = garbageProtocol.claimNameFor('file', input.sourceName, input.sourceAuthority)
  const claimPath = join(input.parent, claimName)
  const recoveredPublication = recoverBoundGarbagePublicationTemporariesSync({
    finalPath: claimPath,
    maximumBytes: OWNED_GARBAGE_CLAIM_MAXIMUM_BYTES,
    label: 'cleanup claim',
    validate(candidate) {
      garbageProtocol.requireClaim(candidate, claimName)
      requireGarbageClaimMatchesSync(candidate, input)
    },
    acceptExisting: true,
    equivalent: garbageProtocol.sameClaimTransaction,
  })
  try {
    const claim = openGarbageClaimSync(claimPath, true)
    requireGarbageClaimMatchesSync(claim.value, input)
    return { ...claim, created: recoveredPublication.created }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!input.allowCreate) {
    throw new Error('Trusted electron-builder runner cleanup claim is unavailable for the retained authority.')
  }
  const value = garbageProtocol.buildClaim({
    token: randomBytes(16).toString('hex'),
    ownerPid: process.pid,
    ownerToken: randomBytes(16).toString('hex'),
    kind: 'file',
    label: input.label,
    sourceName: input.sourceName,
    sourceIdentity: input.sourceIdentity,
    sourceAuthority: input.sourceAuthority,
    createdAtMs: Date.now(),
    maximumEntries: garbageProtocol.MAXIMUM_SUPPORTED_ENTRIES,
    maximumBytes: garbageProtocol.MAXIMUM_SUPPORTED_BYTES,
  })
  const bytes = garbageProtocol.canonicalBytes(value)
  const published = publishCanonicalGarbageAuthoritySync({
    finalPath: claimPath,
    bytes,
    maximumBytes: OWNED_GARBAGE_CLAIM_MAXIMUM_BYTES,
    label: 'cleanup claim',
    validate(candidate) {
      garbageProtocol.requireClaim(candidate, claimName)
      requireGarbageClaimMatchesSync(candidate, input)
    },
    acceptExisting: true,
    equivalent: garbageProtocol.sameClaimTransaction,
    afterTempSync(authority) {
      input.afterClaimTempSync?.({
        ...authority,
        claimPath,
        sourcePath: join(input.parent, input.sourceName),
        token: value.token,
      })
    },
  })
  const claim = openGarbageClaimSync(claimPath, true)
  requireGarbageClaimMatchesSync(claim.value, input)
  return { ...claim, created: published.created }
}

function openGarbageClaimSync(claimPath, retryPublication = false) {
  const opened = openCanonicalGarbageAuthoritySync(
    claimPath,
    OWNED_GARBAGE_CLAIM_MAXIMUM_BYTES,
    'cleanup claim',
    retryPublication,
  )
  try {
    garbageProtocol.requireClaim(opened.value, basename(claimPath))
    return { parent: dirname(claimPath), claimPath, ...opened, created: false }
  } catch (error) {
    fs.closeSync(opened.descriptor)
    throw error
  }
}

function requireGarbageClaimMatchesSync(value, input) {
  if (value.kind !== 'file' || value.sourceName !== input.sourceName
    || !garbageProtocol.sameStableSourceAuthority(value.sourceAuthority, input.sourceAuthority)
    || value.sourceIdentity.dev !== input.sourceIdentity.dev
    || value.sourceIdentity.ino !== input.sourceIdentity.ino
    || value.sourceIdentity.mode !== input.sourceIdentity.mode
    || (input.sourceIdentity.size !== value.sourceIdentity.size && input.sourceIdentity.size !== 0)) {
    throw new Error('Trusted electron-builder runner cleanup claim conflicts with the exact source generation.')
  }
}

function createOrOpenGarbageIntentSync(claim, maximumBytes) {
  const intentPath = join(claim.parent, claim.value.intentName)
  recoverBoundGarbagePublicationTemporariesSync({
    finalPath: intentPath,
    maximumBytes: OWNED_GARBAGE_INTENT_MAXIMUM_BYTES,
    label: 'cleanup intent',
    validate(value) { garbageProtocol.requireIntentBinding(value, claim.value) },
  })
  try {
    const opened = openGarbageIntentSync(intentPath, claim, true)
    requireGarbageIntentWithinCallerBoundSync(opened.value, maximumBytes)
    return opened
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!claim.created) {
    return waitForGarbageIntentSync(intentPath, claim, maximumBytes)
  }
  let quarantineParent
  try {
    quarantineParent = createGarbageQuarantineParentSync(claim)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return waitForGarbageIntentSync(intentPath, claim, maximumBytes, error)
  }
  const value = garbageProtocol.buildIntent(claim.value, {
    entries: Object.freeze([]),
    plannedBytes: claim.value.sourceIdentity.size,
  }, quarantineParent.authority)
  const bytes = garbageProtocol.canonicalBytes(value)
  if (bytes.byteLength > OWNED_GARBAGE_INTENT_MAXIMUM_BYTES) {
    throw new Error('Trusted electron-builder runner cleanup intent exceeded its byte bound.')
  }
  try {
    const published = publishCanonicalGarbageAuthoritySync({
      finalPath: intentPath,
      bytes,
      maximumBytes: OWNED_GARBAGE_INTENT_MAXIMUM_BYTES,
      label: 'cleanup intent',
    })
    fs.closeSync(quarantineParent.descriptor)
    const opened = openGarbageIntentSync(intentPath, claim, true)
    requireGarbageIntentWithinCallerBoundSync(opened.value, maximumBytes)
    return { ...opened, created: published.created }
  } catch (error) {
    try { fs.closeSync(quarantineParent.descriptor) } catch { /* preserve primary error */ }
    throw error
  }
}

function waitForGarbageIntentSync(intentPath, claim, maximumBytes, timeoutError) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    sleepSync(10)
    try {
      const opened = openGarbageIntentSync(intentPath, claim, true)
      requireGarbageIntentWithinCallerBoundSync(opened.value, maximumBytes)
      return opened
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (timeoutError) throw timeoutError
  throw new Error('Trusted electron-builder runner cleanup owner did not publish its intent within the custody deadline.')
}

function createGarbageQuarantineParentSync(claim) {
  const path = join(claim.parent, claim.value.quarantineDirectoryName)
  try {
    fs.mkdirSync(path, { mode: 0o700 })
    syncDirectory(claim.parent)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const occupied = new Error('Trusted electron-builder runner private cleanup quarantine was occupied before creation.')
      occupied.code = 'EEXIST'
      throw occupied
    }
    throw error
  }
  const pathInfo = fs.lstatSync(path, { bigint: true })
  const descriptor = fs.openSync(
    path,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  )
  const identity = fs.fstatSync(descriptor, { bigint: true })
  if (!samePrivateDirectoryBigInt(pathInfo, identity)) {
    fs.closeSync(descriptor)
    throw new Error('Trusted electron-builder runner private cleanup quarantine changed before open.')
  }
  return {
    path,
    descriptor,
    identity,
    authority: garbageProtocol.quarantineAuthorityFromStat(identity),
  }
}

function openGarbageIntentSync(intentPath, claim, retryPublication = false) {
  const opened = openCanonicalGarbageAuthoritySync(
    intentPath,
    OWNED_GARBAGE_INTENT_MAXIMUM_BYTES,
    'cleanup intent',
    retryPublication,
  )
  try {
    garbageProtocol.requireIntentBinding(opened.value, claim.value)
    const expected = garbageProtocol.buildIntent(claim.value, {
      entries: Object.freeze([]),
      plannedBytes: claim.value.sourceIdentity.size,
    }, opened.value.quarantineAuthority)
    if (!garbageProtocol.canonicalBytes(opened.value).equals(garbageProtocol.canonicalBytes(expected))) {
      throw new Error('Trusted electron-builder runner cleanup intent is invalid or noncanonical.')
    }
    return garbageIntentControlSync(
      claim, intentPath, opened.descriptor, opened.identity, opened.value, false,
    )
  } catch (error) {
    fs.closeSync(opened.descriptor)
    throw error
  }
}

function garbageIntentControlSync(claim, intentPath, descriptor, identity, value, created) {
  const quarantineParentPath = join(claim.parent, value.quarantineDirectoryName)
  const quarantineParentPathInfo = fs.lstatSync(quarantineParentPath, { bigint: true })
  const quarantineParentDescriptor = fs.openSync(
    quarantineParentPath,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  )
  const quarantineParentIdentity = fs.fstatSync(quarantineParentDescriptor, { bigint: true })
  if (!samePrivateDirectoryBigInt(quarantineParentPathInfo, quarantineParentIdentity)
    || !sameGarbageQuarantineAuthorityBigInt(quarantineParentIdentity, value.quarantineAuthority)) {
    fs.closeSync(quarantineParentDescriptor)
    throw new Error('Trusted electron-builder runner private cleanup quarantine conflicts with its intent.')
  }
  return {
    parent: claim.parent,
    claim,
    intentPath,
    quarantineParentPath,
    quarantineParentDescriptor,
    quarantineParentIdentity,
    quarantinePath: join(quarantineParentPath, value.quarantineName),
    completionPath: join(claim.parent, value.completionName),
    descriptor,
    identity,
    value,
    created,
  }
}

function requireGarbageIntentWithinCallerBoundSync(intent, maximumBytes) {
  if (intent.plannedEntries > 1 || intent.plannedBytes > maximumBytes) {
    throw new Error('Trusted electron-builder runner cleanup intent exceeds the current caller policy bound.')
  }
}

function executeGarbageFileIntentSync(control, sourcePath, retainedDescriptor, dependencies) {
  const intent = control.value
  requireRetainedGarbageQuarantineParentSync(control)
  recoverBoundGarbagePublicationTemporariesSync({
    finalPath: control.completionPath,
    maximumBytes: OWNED_GARBAGE_TOMBSTONE_MAXIMUM_BYTES,
    label: 'cleanup tombstone',
    validate(value) {
      garbageProtocol.requireTombstoneBinding(value, control.claim.value, control.value)
    },
  })
  const existingCompletion = readGarbageCompletionSync(control)
  if (existingCompletion) return completedGarbageFileIntentSync(control, retainedDescriptor)
  let renamed = false
  const quarantineInfo = optionalLstatBigInt(control.quarantinePath)
  if (quarantineInfo) {
    if (!sameGarbageSourceBigInt(quarantineInfo, intent, true, false)) {
      throw new Error('Trusted electron-builder runner cleanup found a foreign quarantine replacement.')
    }
  } else {
    const sourceInfo = optionalLstatBigInt(sourcePath)
    if (!sourceInfo || !sameGarbageSourceBigInt(sourceInfo, intent, false, true)) {
      if (readGarbageCompletionSync(control)) {
        return completedGarbageFileIntentSync(control, retainedDescriptor)
      }
      throw new Error('Trusted electron-builder runner cleanup cannot prove the pending source generation.')
    }
    dependencies.beforeQuarantineMove?.(garbageIntentAuthoritySync(control, sourcePath))
    requireRetainedGarbageQuarantineParentSync(control)
    const sourceBeforeRename = optionalLstatBigInt(sourcePath)
    const destinationBeforeRename = optionalLstatBigInt(control.quarantinePath)
    if (destinationBeforeRename) {
      const sourceAfterDestination = optionalLstatBigInt(sourcePath)
      if (!sameGarbageSourceBigInt(destinationBeforeRename, intent, true, false)
        || sourceAfterDestination) {
        throw new Error('Trusted electron-builder runner private cleanup quarantine destination is occupied.')
      }
    } else if (!sourceBeforeRename || !sameGarbageSourceBigInt(sourceBeforeRename, intent, false, true)) {
      throw new Error('Trusted electron-builder runner cleanup source generation was replaced before quarantine move.')
    }
    if (!destinationBeforeRename) try {
      fs.renameSync(sourcePath, control.quarantinePath)
      renamed = true
      syncDirectory(control.quarantineParentPath)
      syncDirectory(control.parent)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const raced = optionalLstatBigInt(control.quarantinePath)
      if (!raced || !sameGarbageSourceBigInt(raced, intent, true, false)) throw error
    }
  }
  requireRetainedGarbageQuarantineParentSync(control)
  if (renamed) dependencies.afterQuarantine?.(garbageIntentAuthoritySync(control, sourcePath))
  const retainedBefore = fs.fstatSync(retainedDescriptor, { bigint: true })
  const publicBefore = fs.lstatSync(control.quarantinePath, { bigint: true })
  if (!sameGarbageSourceBigInt(retainedBefore, intent, true, false)
    || !sameGarbageSourceBigInt(publicBefore, intent, true, false)
    || retainedBefore.dev !== publicBefore.dev || retainedBefore.ino !== publicBefore.ino) {
    throw new Error('Trusted electron-builder runner heartbeat changed in cleanup quarantine.')
  }
  dependencies.beforeRetirement?.(garbageIntentAuthoritySync(control, sourcePath))
  const currentRetained = fs.fstatSync(retainedDescriptor, { bigint: true })
  if (!sameGarbageSourceBigInt(currentRetained, intent, true, false)
    || currentRetained.dev !== retainedBefore.dev || currentRetained.ino !== retainedBefore.ino) {
    throw new Error('Trusted electron-builder runner heartbeat gained a hard link or changed before retirement reclaim.')
  }
  if (currentRetained.size !== 0n) {
    fs.ftruncateSync(retainedDescriptor, 0)
    fs.fsyncSync(retainedDescriptor)
  }
  dependencies.afterFileReclaim?.(garbageIntentAuthoritySync(control, sourcePath))
  const reclaimedInfo = fs.fstatSync(retainedDescriptor, { bigint: true })
  const publicAfter = fs.lstatSync(control.quarantinePath, { bigint: true })
  if (!sameGarbageSourceBigInt(reclaimedInfo, intent, true, false) || reclaimedInfo.size !== 0n
    || !sameGarbageSourceBigInt(publicAfter, intent, true, false)
    || reclaimedInfo.dev !== publicAfter.dev || reclaimedInfo.ino !== publicAfter.ino) {
    throw new Error('Trusted electron-builder runner heartbeat identity changed during retirement reclaim.')
  }
  if (optionalLstatBigInt(sourcePath)) {
    throw new Error('Trusted electron-builder runner heartbeat was replaced during retirement; the foreign inode was preserved.')
  }
  const receipt = garbageProtocol.buildReceipt(intent, OWNED_GARBAGE_RECEIPT_SCHEMA)
  const receiptPath = `${control.quarantinePath}.GC.v1.json`
  writeOrVerifyGarbageAuthoritySync(receiptPath, garbageProtocol.canonicalBytes(receipt), control.parent)
  dependencies.afterReceiptDurable?.(garbageIntentAuthoritySync(control, sourcePath))
  if (!existingCompletion) publishGarbageCompletionSync(control, receipt, sourcePath, dependencies)
  else garbageProtocol.requireTombstoneBinding(existingCompletion, control.claim.value, intent)
  return Object.freeze({
    ...receipt,
    quarantinePath: control.quarantinePath,
    receiptPath,
    claimPath: control.claim.claimPath,
    intentPath: control.intentPath,
    completionPath: control.completionPath,
  })
}

function requireRetainedGarbageQuarantineParentSync(control) {
  const retained = fs.fstatSync(control.quarantineParentDescriptor, { bigint: true })
  const current = fs.lstatSync(control.quarantineParentPath, { bigint: true })
  if (!samePrivateDirectoryBigInt(control.quarantineParentIdentity, retained)
    || !samePrivateDirectoryBigInt(retained, current)
    || !sameGarbageQuarantineAuthorityBigInt(retained, control.value.quarantineAuthority)) {
    throw new Error('Trusted electron-builder runner private cleanup quarantine changed during custody.')
  }
}

function completedGarbageFileIntentSync(control, retainedDescriptor) {
  requireRetainedGarbageQuarantineParentSync(control)
  const receipt = garbageProtocol.buildReceipt(control.value, OWNED_GARBAGE_RECEIPT_SCHEMA)
  const receiptPath = `${control.quarantinePath}.GC.v1.json`
  const receiptBytes = readExactGarbageBytesSync(receiptPath, 16 * 1024, true)
  if (!receiptBytes.equals(garbageProtocol.canonicalBytes(receipt))) {
    throw new Error('Trusted electron-builder runner cleanup receipt conflicts with its completed transaction.')
  }
  const quarantineInfo = fs.lstatSync(control.quarantinePath, { bigint: true })
  const retainedInfo = fs.fstatSync(retainedDescriptor, { bigint: true })
  if (!sameGarbageSourceBigInt(quarantineInfo, control.value, true, false)
    || !sameGarbageSourceBigInt(retainedInfo, control.value, true, false)
    || retainedInfo.dev !== quarantineInfo.dev || retainedInfo.ino !== quarantineInfo.ino) {
    throw new Error('Trusted electron-builder runner completed cleanup quarantine conflicts with its intent.')
  }
  return Object.freeze({
    ...receipt,
    quarantinePath: control.quarantinePath,
    receiptPath,
    claimPath: control.claim.claimPath,
    intentPath: control.intentPath,
    completionPath: control.completionPath,
  })
}

function publishGarbageCompletionSync(control, receipt, sourcePath, dependencies) {
  const retainedIntent = fs.fstatSync(control.descriptor, { bigint: true })
  const publicIntent = fs.lstatSync(control.intentPath, { bigint: true })
  if (!sameStableFileBigInt(control.identity, retainedIntent)
    || !sameStableFileBigInt(retainedIntent, publicIntent)) {
    throw new Error('Trusted electron-builder runner cleanup intent was replaced before completion.')
  }
  const tombstone = garbageProtocol.buildTombstone(
    control.claim.value,
    control.value,
    receipt.schema,
  )
  const bytes = garbageProtocol.canonicalBytes(tombstone)
  const authority = () => garbageIntentAuthoritySync(control, sourcePath)
  publishCanonicalGarbageAuthoritySync({
    finalPath: control.completionPath,
    bytes,
    maximumBytes: OWNED_GARBAGE_TOMBSTONE_MAXIMUM_BYTES,
    label: 'cleanup tombstone',
    splitWrite: true,
    afterPartialWrite(details) { dependencies.afterCompletionTempWrite?.({ ...authority(), ...details }) },
    afterTempSync(details) { dependencies.afterCompletionTempSync?.({ ...authority(), ...details }) },
    afterPublish(details) {
      dependencies.afterCompletionRename?.({ ...authority(), ...details })
      dependencies.afterCompletionPublish?.({ ...authority(), ...details })
    },
    afterDirectorySync(details) {
      dependencies.afterCompletionDirectorySync?.({ ...authority(), ...details })
    },
  })
  const published = readGarbageCompletionSync(control)
  if (!published) throw new Error('Trusted electron-builder runner cleanup completion is unavailable.')
  garbageProtocol.requireTombstoneBinding(published, control.claim.value, control.value)
}

function readGarbageCompletionSync(control) {
  try {
    const opened = readStableGarbagePublicationSync(
      control.completionPath,
      OWNED_GARBAGE_TOMBSTONE_MAXIMUM_BYTES,
      'cleanup tombstone',
    )
    try {
      garbageProtocol.requireTombstoneBinding(opened.value, control.claim.value, control.value)
      return opened.value
    } finally { fs.closeSync(opened.descriptor) }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function writeOrVerifyGarbageAuthoritySync(path, bytes, parent) {
  recoverBoundGarbagePublicationTemporariesSync({
    finalPath: path, maximumBytes: 16 * 1024, label: 'cleanup receipt',
  })
  publishCanonicalGarbageAuthoritySync({
    finalPath: path, bytes, maximumBytes: 16 * 1024, label: 'cleanup receipt',
  })
}

function publishCanonicalGarbageAuthoritySync(input) {
  if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength < 2
    || input.bytes.byteLength > input.maximumBytes) {
    throw new Error(`Trusted electron-builder runner ${input.label} publication bytes are invalid.`)
  }
  const temporaryPath = `${input.finalPath}.tmp-${randomBytes(16).toString('hex')}`
  const descriptor = fs.openSync(
    temporaryPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  )
  let linked = false
  let adoptedOwnInode = false
  try {
    if (input.splitWrite) {
      const firstLength = Math.max(1, Math.floor(input.bytes.byteLength / 2))
      writeAllRangeSync(descriptor, input.bytes, 0, firstLength)
      input.afterPartialWrite?.({ temporaryPath, finalPath: input.finalPath })
      writeAllRangeSync(descriptor, input.bytes, firstLength, input.bytes.byteLength)
    } else {
      writeAllSync(descriptor, input.bytes)
    }
    fs.fsyncSync(descriptor)
    const identity = fs.fstatSync(descriptor, { bigint: true })
    if (!ordinaryGarbagePublicationFile(identity) || identity.size !== BigInt(input.bytes.byteLength)) {
      throw new Error(`Trusted electron-builder runner ${input.label} temporary authority is invalid.`)
    }
    if (identity.nlink === 2n) {
      const racedFinal = optionalLstatBigInt(input.finalPath)
      if (!racedFinal || !sameGarbagePublicationInode(identity, racedFinal)) {
        throw new Error(`Trusted electron-builder runner ${input.label} temporary gained a foreign hard link.`)
      }
    }
    input.afterTempSync?.({
      temporaryPath, finalPath: input.finalPath, identity: fileIdentityBigInt(identity),
    })
    const readyIdentity = fs.fstatSync(descriptor, { bigint: true })
    const readyFinal = optionalLstatBigInt(input.finalPath)
    const readyBytes = ordinaryGarbagePublicationFile(readyIdentity)
      && readyIdentity.size === BigInt(input.bytes.byteLength)
      ? readExactDescriptorSync(descriptor, input.bytes.byteLength)
      : null
    if (!sameGarbagePublicationInode(identity, readyIdentity)
      || readyIdentity.size !== BigInt(input.bytes.byteLength)
      || !readyBytes?.equals(input.bytes)
      || (readyIdentity.nlink !== 1n
        && (!readyFinal || !sameGarbagePublicationInode(readyIdentity, readyFinal)))) {
      throw new Error(`Trusted electron-builder runner ${input.label} temporary gained a foreign hard link alias or changed before publication.`)
    }
    try {
      fs.linkSync(temporaryPath, input.finalPath)
      linked = true
    } catch (error) {
      if (!['EEXIST', 'ENOENT'].includes(error?.code)) throw error
      let existing
      try {
        existing = readStableGarbagePublicationSync(
          input.finalPath, input.maximumBytes, input.label,
        )
      } catch (readError) {
        throw new Error(
          `Trusted electron-builder runner ${input.label} conflicts with a foreign final authority.`,
          { cause: readError },
        )
      }
      try {
        input.validate?.(existing.value)
        adoptedOwnInode = sameGarbagePublicationInode(identity, existing.identity)
        const equivalent = existing.bytes.equals(input.bytes)
          || (typeof input.equivalent === 'function'
            && input.equivalent(JSON.parse(input.bytes.toString('utf8')), existing.value))
        if (!equivalent && input.acceptExisting) {
          throw new Error(`Trusted electron-builder runner ${input.label} conflicts with a foreign final authority.`)
        }
        if (!existing.bytes.equals(input.bytes) && !input.acceptExisting) {
          throw new Error(`Trusted electron-builder runner ${input.label} conflicts with a foreign final authority.`)
        }
      } finally { fs.closeSync(existing.descriptor) }
    }
    if (linked) {
      const published = fs.lstatSync(input.finalPath, { bigint: true })
      if (!sameGarbagePublicationInode(identity, published)
        || published.size !== BigInt(input.bytes.byteLength)) {
        throw new Error(`Trusted electron-builder runner ${input.label} changed during no-replace publication.`)
      }
      input.afterPublish?.({ temporaryPath, finalPath: input.finalPath })
      syncDirectory(dirname(input.finalPath))
      input.afterDirectorySync?.({ temporaryPath, finalPath: input.finalPath })
    }
    const beforeUnlink = optionalLstatBigInt(temporaryPath)
    if (beforeUnlink) {
      const finalBeforeTemporaryRetirement = optionalLstatBigInt(input.finalPath)
      if (!sameGarbagePublicationInode(identity, beforeUnlink)
        || beforeUnlink.size !== BigInt(input.bytes.byteLength)
        || (beforeUnlink.nlink !== 1n
          && (!finalBeforeTemporaryRetirement
            || beforeUnlink.nlink !== 2n
            || !sameGarbagePublicationInode(beforeUnlink, finalBeforeTemporaryRetirement)))) {
        throw new Error(`Trusted electron-builder runner ${input.label} temporary changed before retirement.`)
      }
      try { fs.unlinkSync(temporaryPath) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        const final = fs.lstatSync(input.finalPath, { bigint: true })
        if (!sameGarbagePublicationInode(identity, final)) throw error
      }
      syncDirectory(dirname(input.finalPath))
    }
    return Object.freeze({ created: linked || adoptedOwnInode, finalPath: input.finalPath })
  } finally {
    fs.closeSync(descriptor)
  }
}

function recoverBoundGarbagePublicationTemporariesSync(input) {
  const parent = dirname(input.finalPath)
  const prefix = `${basename(input.finalPath)}.tmp-`
  const names = fs.readdirSync(parent).filter((name) => name.startsWith(prefix)).sort(codeUnitCompare)
  if (names.length > OWNED_GARBAGE_PUBLICATION_TEMPORARY_LIMIT) {
    throw new Error(`Trusted electron-builder runner ${input.label} publication temporary count exceeds its recovery bound.`)
  }
  let created = false
  const failures = []
  for (const name of names) {
    if (!/^(.*\.v1\.json)\.tmp-[a-f0-9]{32}$/.test(name)) {
      failures.push(new Error(`Trusted electron-builder runner ${input.label} has a malformed publication temporary.`))
      continue
    }
    const temporaryPath = join(parent, name)
    let temporary
    try {
      temporary = readStableGarbagePublicationWithRetrySync(
        temporaryPath, input.maximumBytes, input.label,
      )
      if (!temporary) continue
      input.validate?.(temporary.value)
    } catch (error) {
      if (temporary) fs.closeSync(temporary.descriptor)
      failures.push(error)
      continue
    }
    try {
      const finalInfo = optionalLstatBigInt(input.finalPath)
      if (temporary.identity.nlink !== 1n
        && (!finalInfo || !sameGarbagePublicationInode(temporary.identity, finalInfo))) {
        throw new Error(`Trusted electron-builder runner ${input.label} temporary has a foreign hard link alias.`)
      }
      if (!finalInfo) {
        try {
          fs.linkSync(temporaryPath, input.finalPath)
          created = true
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
        syncDirectory(parent)
      }
      const final = readStableGarbagePublicationSync(input.finalPath, input.maximumBytes, input.label)
      try {
        input.validate?.(final.value)
        if (!final.bytes.equals(temporary.bytes)
          && !(typeof input.equivalent === 'function'
            && input.equivalent(temporary.value, final.value))) {
          throw new Error(`Trusted electron-builder runner ${input.label} temporary conflicts with a foreign final authority.`)
        }
      } finally { fs.closeSync(final.descriptor) }
      const beforeUnlink = optionalLstatBigInt(temporaryPath)
      if (beforeUnlink) {
        const finalBeforeTemporaryRetirement = optionalLstatBigInt(input.finalPath)
        if (!sameGarbagePublicationInode(temporary.identity, beforeUnlink)
          || beforeUnlink.size !== temporary.identity.size
          || (beforeUnlink.nlink !== 1n
            && (!finalBeforeTemporaryRetirement
              || beforeUnlink.nlink !== 2n
              || !sameGarbagePublicationInode(beforeUnlink, finalBeforeTemporaryRetirement)))) {
          throw new Error(`Trusted electron-builder runner ${input.label} temporary changed before recovery retirement.`)
        }
        try { fs.unlinkSync(temporaryPath) } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        syncDirectory(parent)
      }
    } catch (error) {
      failures.push(error)
    } finally { fs.closeSync(temporary.descriptor) }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Trusted electron-builder runner ${input.label} publication temporary recovery failed: ${failures.map((error) => error?.message ?? 'unknown failure').join('; ')}`,
    )
  }
  return Object.freeze({ created })
}

function readStableGarbagePublicationWithRetrySync(path, maximumBytes, label) {
  let lastError
  for (let attempt = 0; attempt < 101; attempt += 1) {
    try { return readStableGarbagePublicationSync(path, maximumBytes, label) } catch (error) {
      if (error?.code === 'ENOENT') return null
      lastError = error
      if (attempt < 100) sleepSync(2)
    }
  }
  throw lastError
}

function readStableGarbagePublicationSync(path, maximumBytes, label) {
  const pathInfo = fs.lstatSync(path, { bigint: true })
  if (!ordinaryGarbagePublicationFile(pathInfo) || pathInfo.size < 2n
    || pathInfo.size > BigInt(maximumBytes)) {
    throw new Error(`Trusted electron-builder runner ${label} is not an ordinary bounded publication file.`)
  }
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true })
    if (!sameGarbagePublicationInode(pathInfo, identity) || pathInfo.size !== identity.size) {
      throw new Error(`Trusted electron-builder runner ${label} changed before publication open.`)
    }
    const bytes = readExactDescriptorSync(descriptor, Number(identity.size))
    let value
    try { value = JSON.parse(bytes.toString('utf8')) } catch {
      throw new Error(`Trusted electron-builder runner ${label} JSON is invalid.`)
    }
    if (!garbageProtocol.canonicalBytes(value).equals(bytes)) {
      throw new Error(`Trusted electron-builder runner ${label} is noncanonical.`)
    }
    return { descriptor, identity, bytes, value }
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

function ordinaryGarbagePublicationFile(info) {
  return info?.isFile?.() && !info.isSymbolicLink?.() && (info.nlink === 1n || info.nlink === 2n)
}

function sameGarbagePublicationInode(left, right) {
  return ordinaryGarbagePublicationFile(left) && ordinaryGarbagePublicationFile(right)
    && left.dev === right.dev && left.ino === right.ino
    && (left.mode & 0o7777n) === (right.mode & 0o7777n)
}

function openCanonicalGarbageAuthoritySync(path, maximumBytes, label, retryPublication = false) {
  let lastError
  const attempts = retryPublication ? 101 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let descriptor
    try {
      const pathInfo = fs.lstatSync(path, { bigint: true })
      if (!ordinarySingleLinkFileBigInt(pathInfo) || pathInfo.size < 2n
        || pathInfo.size > BigInt(maximumBytes)) {
        throw new Error(`Trusted electron-builder runner ${label} is not an ordinary bounded file.`)
      }
      descriptor = fs.openSync(path, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0))
      const identity = fs.fstatSync(descriptor, { bigint: true })
      if (!sameStableFileBigInt(pathInfo, identity)) {
        throw new Error(`Trusted electron-builder runner ${label} changed before open.`)
      }
      const bytes = readExactDescriptorSync(descriptor, Number(identity.size))
      let value
      try { value = JSON.parse(bytes.toString('utf8')) } catch {
        throw new Error(`Trusted electron-builder runner ${label} JSON is invalid.`)
      }
      if (!garbageProtocol.canonicalBytes(value).equals(bytes)) {
        throw new Error(`Trusted electron-builder runner ${label} is noncanonical.`)
      }
      return { descriptor, identity, value }
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch { /* retry primary */ }
      if (error?.code === 'ENOENT') throw error
      lastError = error
      if (attempt + 1 >= attempts) break
      sleepSync(2)
    }
  }
  throw lastError
}

function readExactGarbageBytesSync(path, maximumBytes, retryPublication = false) {
  const opened = openCanonicalGarbageAuthoritySync(path, maximumBytes, 'cleanup receipt', retryPublication)
  try { return garbageProtocol.canonicalBytes(opened.value) } finally { fs.closeSync(opened.descriptor) }
}

function readExactDescriptorSync(descriptor, size) {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset)
    if (count < 1) throw new Error('Trusted electron-builder runner cleanup authority ended before its retained size.')
    offset += count
  }
  return bytes
}

function writeAllSync(descriptor, bytes) {
  writeAllRangeSync(descriptor, bytes, 0, bytes.byteLength)
}

function writeAllRangeSync(descriptor, bytes, start, end) {
  let offset = start
  while (offset < end) {
    const written = fs.writeSync(descriptor, bytes, offset, end - offset, offset)
    if (written < 1) throw new Error('Trusted electron-builder runner cleanup authority write made no progress.')
    offset += written
  }
}

function garbageClaimAuthoritySync(claim, sourcePath) {
  const quarantineParentPath = join(claim.parent, claim.value.quarantineDirectoryName)
  return Object.freeze({
    path: sourcePath,
    sourcePath,
    claimPath: claim.claimPath,
    intentPath: join(claim.parent, claim.value.intentName),
    quarantineParentPath,
    quarantinePath: join(quarantineParentPath, claim.value.quarantineName),
    completionPath: join(claim.parent, claim.value.completionName),
    token: claim.value.token,
    expectedIdentity: claim.value.sourceIdentity,
    identity: claim.value.sourceIdentity,
  })
}

function garbageIntentAuthoritySync(control, sourcePath) {
  return Object.freeze({
    ...garbageClaimAuthoritySync(control.claim, sourcePath),
    label: control.value.label,
  })
}

function optionalLstatBigInt(path) {
  try { return fs.lstatSync(path, { bigint: true }) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function fileIdentityBigInt(info) {
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    size: Number(info.size),
    mode: Number(info.mode & 0o7777n),
  })
}

function sameGarbageSourceBigInt(info, intent, allowReclaimed, requireOriginalMetadata) {
  if (!ordinarySingleLinkFileBigInt(info)) return false
  let authority
  try { authority = garbageProtocol.sourceAuthorityFromStat(info) } catch { return false }
  return garbageProtocol.sameStableSourceAuthority(authority, intent.sourceAuthority)
    && String(info.dev) === intent.sourceIdentity.dev
    && String(info.ino) === intent.sourceIdentity.ino
    && Number(info.mode & 0o7777n) === intent.sourceIdentity.mode
    && (Number(info.size) === intent.sourceIdentity.size || (allowReclaimed && info.size === 0n))
    && (!requireOriginalMetadata || String(info.ctimeNs) === intent.sourceAuthority.ctimeNs)
}

function ordinarySingleLinkFileBigInt(info) {
  return info?.isFile?.() && !info.isSymbolicLink?.() && info.nlink === 1n
}

function samePrivateDirectoryBigInt(left, right) {
  return left?.isDirectory?.() && !left.isSymbolicLink?.()
    && right?.isDirectory?.() && !right.isSymbolicLink?.()
    && left.dev === right.dev && left.ino === right.ino
    && (left.mode & 0o7777n) === (right.mode & 0o7777n)
}

function sameGarbageQuarantineAuthorityBigInt(info, expected) {
  return info?.isDirectory?.() && !info.isSymbolicLink?.()
    && String(info.dev) === expected?.dev && String(info.ino) === expected?.ino
    && String(info.birthtimeNs) === expected?.birthtimeNs
    && Number(info.mode & 0o7777n) === expected?.mode
}

function sameStableFileBigInt(left, right) {
  return ordinarySingleLinkFileBigInt(left) && ordinarySingleLinkFileBigInt(right)
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && (left.mode & 0o7777n) === (right.mode & 0o7777n)
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function writeRunnerTerminal(attempt, input) {
  const record = Object.freeze({
    schema: RUNNER_TERMINAL_SCHEMA,
    attemptId: attempt.attemptId,
    target: attempt.target,
    runnerIdentity: input.runnerIdentity,
    runnerPid: process.pid,
    processStartIdentity: input.processStartIdentity,
    cacheIdentity: input.cacheIdentity,
    outputIdentity: input.outputIdentity,
    status: input.status,
    artifacts: input.artifacts,
  })
  const descriptor = fs.openSync(attempt.terminalPath, fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  syncDirectory(dirname(attempt.terminalPath))
}

async function requireContainedArtifacts(
  value,
  outputDirectory,
  expectedRootIdentity,
  outputCustody = undefined,
  environment = process.env,
) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error('Trusted electron-builder returned an invalid artifact set.')
  }
  const custody = outputCustody
    ?? (await import('./world-ffmpeg-output-custody.mjs')).runWorldFfmpegOutputCustody
  if (!expectedRootIdentity || typeof expectedRootIdentity !== 'object') {
    const root = await custody({
      operation: 'directory', directory: outputDirectory, segments: [], environment,
    })
    expectedRootIdentity = root.rootIdentity
  }
  const artifacts = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !isAbsolute(candidate) || candidate.includes('\0')) {
      throw new Error('Trusted electron-builder returned an invalid artifact path.')
    }
    const absolute = resolve(candidate)
    const suffix = relative(outputDirectory, absolute)
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      throw new Error('Trusted electron-builder returned an artifact outside its attempt output.')
    }
    if (suffix.includes(sep) || suffix.includes('/') || suffix.includes('\\')) {
      throw new Error('Trusted electron-builder artifact must be a direct child of its attempt output.')
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(suffix)) {
      throw new Error('Trusted electron-builder artifact name is not workflow-safe.')
    }
    await custody({
      operation: 'hash',
      directory: outputDirectory,
      expectedDirectoryIdentity: expectedRootIdentity,
      name: suffix,
      maximumBytes: 16 * 1024 * 1024 * 1024,
      environment,
    })
    artifacts.push(suffix)
  }
  artifacts.sort(codeUnitCompare)
  if (new Set(artifacts).size !== artifacts.length) {
    throw new Error('Trusted electron-builder returned duplicate artifact paths.')
  }
  return Object.freeze(artifacts)
}

function readProcessStartIdentity(pid, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffff_ffff) return 'unavailable'
  if (platform === 'linux') {
    try {
      const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const close = value.lastIndexOf(')')
      const fields = value.slice(close + 2).trim().split(/\s+/)
      return /^[0-9]+$/.test(fields[19] ?? '') ? `linux-proc-start:${fields[19]}` : 'unavailable'
    } catch { return 'unavailable' }
  }
  const probe = dependencies.spawnSync ?? spawnSync
  if (platform === 'darwin') {
    const attemptToken = dependencies.attemptToken
    if (!ATTEMPT_PATTERN.test(attemptToken)) return 'unavailable'
    const result = probe('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      cwd: '/bin', env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC' },
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 4096,
    })
    const value = typeof result?.stdout === 'string' ? result.stdout.trim().replace(/\s+/g, ' ') : ''
    const match = /^((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}) (.+)$/.exec(value)
    return result?.status === 0 && result?.signal == null && match
      && match[2].split(/\s+/).includes(`--world-ffmpeg-attempt=${attemptToken}`)
      ? `darwin-ps-start-command:${createHash('sha256').update(`${match[1]}\0${match[2]}`).digest('hex')}`
      : 'unavailable'
  }
  if (platform === 'win32') {
    const systemRoot = environmentSystemRoot(dependencies.environment)
    if (!systemRoot) return 'unavailable'
    const file = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const command = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null -eq $p){exit 3};[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`
    const result = probe(file, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], {
      cwd: `${systemRoot}\\System32`,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: `${systemRoot}\\System32;${systemRoot}`, COMSPEC: `${systemRoot}\\System32\\cmd.exe`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 5_000, maxBuffer: 4096,
    })
    const value = typeof result?.stdout === 'string' ? result.stdout.trim() : ''
    return result?.status === 0 && /^[0-9]{1,32}$/.test(value)
      ? `win32-process-start:${value}` : 'unavailable'
  }
  return 'unavailable'
}

function environmentSystemRoot(environment) {
  if (!environment || typeof environment !== 'object') return null
  const entries = Object.entries(environment).filter(([key]) => key.toLowerCase() === 'systemroot')
  if (entries.length !== 1 || typeof entries[0][1] !== 'string'
    || !/^[A-Za-z]:\\Windows$/i.test(entries[0][1])) return null
  return entries[0][1]
}

function validConcreteProcessStartIdentity(value) {
  return typeof value === 'string' && (
    /^linux-proc-start:[0-9]{1,32}$/.test(value)
    || /^darwin-ps-start-command:[a-f0-9]{64}$/.test(value)
    || /^win32-process-start:[0-9]{1,32}$/.test(value)
  )
}

function decodeDirectoryIdentity(value) {
  try {
    if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error()
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') !== value) throw new Error()
    const identity = JSON.parse(bytes.toString('utf8'))
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || Object.keys(identity).sort().join(',') !== 'dev,ino'
      || !/^[0-9]{1,40}$/.test(identity.dev) || !/^[1-9][0-9]{0,39}$/.test(identity.ino)) throw new Error()
    return Object.freeze(identity)
  } catch { throw new Error('Trusted electron-builder directory identity authority is invalid.') }
}

function sameDirectoryIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
}

function syncDirectory(path) {
  if (process.platform === 'win32') return
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0))
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function requireExactExecArgv(execArgv) {
  if (!Array.isArray(execArgv)
    || !sameArray(execArgv, [`--require=${DENY_NETWORK_PRELOAD}`])) {
    throw new Error('Audited electron-builder runner has invalid execArgv authority.')
  }
}

function loadProgrammaticBuilder() {
  // The only dotenv loader in pinned electron-builder 26.15.3 is the CLI
  // wrapper. Guard its exported authority as a fail-closed regression barrier,
  // then load the programmatic API directly without evaluating the CLI.
  const configLoader = require('app-builder-lib/out/util/config/load')
  configLoader.loadEnv = async () => {
    throw new Error('electron-builder environment-file loading is forbidden during audited packaging.')
  }
  return require('electron-builder')
}

function requireBuilderApi(value) {
  if (!value || typeof value !== 'object'
    || typeof value.build !== 'function'
    || typeof value.createTargets !== 'function'
    || !value.Platform || typeof value.Platform !== 'object') {
    throw new Error('Trusted electron-builder programmatic API is unavailable.')
  }
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function main() {
  if (process.argv.length !== 3
    || process.argv[2] !== `--world-ffmpeg-attempt=${process.env.WORLD_FFMPEG_PACKAGE_ATTEMPT_ID}`) {
    throw new Error('Trusted electron-builder runner requires its exact attempt authority argument.')
  }
  await runTrustedWorldFfmpegElectronBuilder()
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Trusted electron-builder failed.'}\n`)
    process.exitCode = 1
  })
}

// This dependency boundary exists solely so tests can instrument the pinned
// programmatic API without adding a second preload to the production runner.
// The supported packaging entry above always binds real process authority.
module.exports._testOnlyRunTrustedWorldFfmpegElectronBuilderWith = runTrustedWorldFfmpegElectronBuilderWith
module.exports._testOnlyCreateWindowsPortableArtifact = createWindowsPortableArtifact
module.exports._testOnlyStartRunnerHeartbeat = startRunnerHeartbeat
module.exports._testOnlyQuarantineOwnedAuthorityFileSync = quarantineOwnedAuthorityFileSync
module.exports._testOnlyRequireContainedArtifacts = requireContainedArtifacts
module.exports._testOnlyReadProcessStartIdentity = readProcessStartIdentity
