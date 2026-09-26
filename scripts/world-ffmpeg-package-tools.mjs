import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { syncWorldFfmpegDirectory } from './world-ffmpeg-durability.mjs'
import {
  quarantineAndReclaimWorldFfmpegDirectory,
  quarantineAndReclaimWorldFfmpegFile,
  recoverWorldFfmpegOwnedGarbage,
  WORLD_FFMPEG_PACKAGE_OUTPUT_GARBAGE_MAXIMUM_BYTES,
} from './world-ffmpeg-owned-garbage.mjs'
import {
  runWorldFfmpegOutputCustody,
  sameWorldFfmpegOutputDirectoryIdentity,
  sameWorldFfmpegOutputFileReceipt,
} from './world-ffmpeg-output-custody.mjs'
import { spawnWorldFfmpegPackageProcess } from './world-ffmpeg-process-custody.mjs'
import {
  assertWorldFfmpegPackagedElectronExecutable,
  validateWorldFfmpegExtractorContract,
  validateWorldFfmpegExtractorProof,
} from './world-ffmpeg-artifact-inspector.mjs'

const require = createRequire(import.meta.url)
const { verifyPackagedRuntime } = require('./world-ffmpeg-before-pack.cjs')
const {
  createWorldFfmpegBuilderEnvironment,
  requireCanonicalWindowsSystemRoot,
} = require('./world-ffmpeg-package-environment.cjs')
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const DEFAULT_LOCK_PATH = join(REPOSITORY_ROOT, 'resources', 'packaging', 'electron-builder-tool-cache.v1.json')
const ELECTRON_BUILDER_RUNNER = join(REPOSITORY_ROOT, 'scripts', 'world-ffmpeg-electron-builder-runner.cjs')
const DENY_NETWORK_PRELOAD = join(REPOSITORY_ROOT, 'scripts', 'world-ffmpeg-deny-network.cjs')
const EXPECTED_TARGETS = Object.freeze(['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'])
const VERIFIED_TOOL_LOCK_TARGETS = Object.freeze(['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'])
const PACKAGE_TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({
    requestArguments: Object.freeze(['--mac', '--arm64', '--publish', 'never']),
    platform: 'darwin', arch: 'arm64',
    resourceSegments: Object.freeze(['mac-arm64', 'Modly.app', 'Contents', 'Resources']),
  }),
  'linux-arm64': Object.freeze({
    requestArguments: Object.freeze(['--linux', '--arm64', '--publish', 'never']),
    platform: 'linux', arch: 'arm64',
    resourceSegments: Object.freeze(['linux-arm64-unpacked', 'resources']),
  }),
  'linux-x64': Object.freeze({
    requestArguments: Object.freeze(['--linux', '--publish', 'never']),
    platform: 'linux', arch: 'x64',
    resourceSegments: Object.freeze(['linux-unpacked', 'resources']),
  }),
  'win32-x64': Object.freeze({
    requestArguments: Object.freeze(['--win', '--publish', 'never']),
    platform: 'win32', arch: 'x64',
    resourceSegments: Object.freeze(['win-unpacked', 'resources']),
  }),
})
const MAX_LOCK_BYTES = 256 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MUTABLE_CACHE_LEASE_SCHEMA = 'modly.electron-builder-mutable-cache-lease.v1'
const RUNNER_TERMINAL_SCHEMA = 'modly.electron-builder-package-runner-terminal.v1'
const OUTER_HEARTBEAT_SCHEMA = 'modly.electron-builder-package-outer-heartbeat.v1'
const RUNNER_HEARTBEAT_SCHEMA = 'modly.electron-builder-package-runner-heartbeat.v1'
const PACKAGE_RESULT_SCHEMA = 'modly.electron-builder-package-result.v1'
const PACKAGE_RESULT_RECEIPT_SCHEMA = 'modly.electron-builder-package-result-receipt.v1'
const ARTIFACT_INSPECTION_SCHEMA = 'modly.world-ffmpeg-artifact-inspection.v1'
const MUTABLE_CACHE_TOKEN_PATTERN = /^[a-f0-9]{32}$/
const MUTABLE_CACHE_LEASE_PATTERN = /^lease-([a-f0-9]{32})\.json$/
const MUTABLE_CACHE_CLEANUP_PATTERN = /^cleanup-([a-f0-9]{32})$/
const MUTABLE_CACHE_OUTER_HEARTBEAT_PATTERN = /^outer-([a-f0-9]{32})\.heartbeat$/
const MUTABLE_CACHE_RUNNER_HEARTBEAT_PATTERN = /^runner-([a-f0-9]{32})\.heartbeat$/
const MUTABLE_CACHE_RUNNER_TERMINAL_PATTERN = /^terminal-([a-f0-9]{32})\.json$/
const MAX_MUTABLE_CACHE_LEASE_BYTES = 4 * 1024
const MAX_MUTABLE_CACHE_HEARTBEAT_BYTES = 4 * 1024
const MAX_RUNNER_TERMINAL_BYTES = 64 * 1024
const MAX_PACKAGE_RESULT_BYTES = 128 * 1024
const MAX_PACKAGE_ARTIFACTS = 64
const MAX_PACKAGE_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024
const MAX_PACKAGE_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024 * 1024
const MIN_MUTABLE_CACHE_CLEANUP_MS = 30_000
const MAX_MUTABLE_CACHE_CLEANUP_MS = 10 * 60_000
const MUTABLE_CACHE_CLEANUP_BYTES_PER_SECOND = 32 * 1024 * 1024
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000
const DEFAULT_HEARTBEAT_FRESH_MS = 15_000
const MAX_HEARTBEAT_FRESH_MS = 60_000
const mutableCacheCleanupPromises = new WeakMap()
const publishedPackageResultReceipts = new WeakMap()

export async function loadWorldFfmpegPackageToolLock(path = DEFAULT_LOCK_PATH) {
  const absolutePath = requireAbsolute(path, 'package-tool lock')
  const info = await lstat(absolutePath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size < 2 || info.size > MAX_LOCK_BYTES) {
    throw new Error('World FFmpeg package-tool lock is not an ordinary bounded file.')
  }
  const bytes = await readFile(absolutePath)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('World FFmpeg package-tool lock is not valid JSON.') }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`)) || !validateToolLock(value)) {
    throw new Error('World FFmpeg package-tool lock is invalid or noncanonical.')
  }
  return deepFreeze(value)
}

export async function verifyWorldFfmpegPackageToolCache(input) {
  const target = requireTarget(input?.target)
  const cacheDirectory = requireAbsolute(input?.cacheDirectory, 'package-tool cache')
  const contract = input?.contract ?? await loadWorldFfmpegPackageToolLock()
  if (!validateToolLock(contract)) throw new Error('World FFmpeg package-tool lock is invalid.')
  if (!contract.targets[target] || !contract.extractors[target]) {
    return { ok: false, code: 'tool-cache-missing', entry: '7zip-linux-arm64.tar.gz' }
  }
  try {
    const rootInfo = await lstat(cacheDirectory)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      return { ok: false, code: 'tool-cache-invalid', entry: null }
    }
    const entries = contract.targets[target]
    const releases = [...new Set(entries.map((entry) => entry.release))].sort(codeUnitCompare)
    const rootEntries = (await readdir(cacheDirectory)).sort(codeUnitCompare)
    if (!sameArray(rootEntries, releases)) {
      return { ok: false, code: rootEntries.length === 0 ? 'tool-cache-missing' : 'tool-cache-invalid', entry: null }
    }
    for (const release of releases) {
      const directory = join(cacheDirectory, release)
      const directoryInfo = await lstat(directory)
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        return { ok: false, code: 'tool-cache-invalid', entry: release }
      }
      const expectedNames = entries.filter((entry) => entry.release === release).map((entry) => entry.filename).sort(codeUnitCompare)
      if (!sameArray((await readdir(directory)).sort(codeUnitCompare), expectedNames)) {
        return { ok: false, code: 'tool-cache-invalid', entry: release }
      }
      for (const entry of entries.filter((candidate) => candidate.release === release)) {
        const path = resolve(directory, entry.filename)
        if (!isContained(directory, path)
          || await verifyBoundedFile(path, entry.maximumBytes, entry.sha256) !== true) {
          return { ok: false, code: 'tool-cache-invalid', entry: `${entry.release}/${entry.filename}` }
        }
      }
    }
    return { ok: true }
  } catch (error) {
    return nodeErrorCode(error) === 'ENOENT'
      ? { ok: false, code: 'tool-cache-missing', entry: null }
      : { ok: false, code: 'tool-cache-invalid', entry: null }
  }
}

export async function runWorldFfmpegOfflinePackage(input) {
  const target = requireTarget(input?.target)
  const attemptToken = input?.attemptToken ?? randomBytes(16).toString('hex')
  if (!MUTABLE_CACHE_TOKEN_PATTERN.test(attemptToken)) {
    throw new Error('World FFmpeg package attempt token is invalid.')
  }
  const archiveDirectory = requireAbsolute(input?.cacheDirectory, 'package-tool archive store')
  const contract = input?.contract ?? await loadWorldFfmpegPackageToolLock()
  const verified = await verifyWorldFfmpegPackageToolCache({ target, cacheDirectory: archiveDirectory, contract })
  if (!verified.ok) {
    throw new Error(`World FFmpeg package tool cache ${verified.code === 'tool-cache-missing' ? 'is missing' : 'is invalid'}${verified.entry ? `: ${verified.entry}` : ''}.`)
  }
  requirePackageArguments(input?.argv, target)
  const spawnProcess = input?.spawnProcess ?? spawnWorldFfmpegPackageProcess
  const verifyPackage = input?.verifyPackage ?? verifyPackagedRuntime
  const inspectArtifacts = input?.inspectArtifacts ?? (async (request) => (
    (await import('./world-ffmpeg-artifact-inspector.mjs')).inspectWorldFfmpegPackageArtifacts(request)
  ))
  if (typeof spawnProcess !== 'function' || typeof verifyPackage !== 'function'
    || typeof inspectArtifacts !== 'function') {
    throw new Error('World FFmpeg offline package dependencies are invalid.')
  }
  const sourceEnvironment = input?.environment ?? process.env
  if (!sourceEnvironment || typeof sourceEnvironment !== 'object') {
    throw new Error('World FFmpeg offline package environment is invalid.')
  }
  const buildTrustFile = requireAbsolute(
    input?.buildTrustFile ?? sourceEnvironment.WORLD_FFMPEG_BUILD_TRUST_FILE,
    'build-trust file',
  )
  const bootstrapExecutable = input?.bootstrapExecutable
    ?? sourceEnvironment.WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE
    ?? process.execPath
  const outputCustody = requireOutputCustody(input?.outputCustody, sourceEnvironment)
  const cacheLifecycle = requireMutableCacheLifecycle(
    input?.cacheLifecycle, contract.targets[target], archiveDirectory, outputCustody,
  )
  const processLifecycle = requirePackageProcessLifecycle(
    input?.processLifecycle,
    PACKAGE_TARGETS[target].platform,
  )
  await recoverWorldFfmpegMutablePackageCacheGenerations({
    target,
    archiveDirectory,
    contract,
    cacheLifecycle,
    outputCustody,
  })
  const cacheLease = await createWorldFfmpegMutablePackageCacheGeneration({
    target,
    archiveDirectory,
    contract,
    cacheLifecycle,
    outputCustody,
    attemptToken,
  })
  let operationError
  let custodyUnsettled = false
  let releaseLateCleanup
  const lateCleanupReady = new Promise((resolvePromise) => { releaseLateCleanup = resolvePromise })
  try {
    const env = packageEnvironment({
      target,
      cacheDirectory: cacheLease.cacheDirectory,
      attemptId: cacheLease.record.token,
      outputDirectory: cacheLease.outputDirectory,
      runnerHeartbeatPath: cacheLease.runnerHeartbeatPath,
      runnerTerminalPath: cacheLease.runnerTerminalPath,
      cacheIdentity: cacheLease.cacheIdentity,
      outputIdentity: cacheLease.outputIdentity,
      buildTrustFile,
      bootstrapExecutable,
      sourceEnvironment,
    })
    const packageTarget = PACKAGE_TARGETS[target]
    const result = await spawnProcess(process.execPath, [
      `--require=${DENY_NETWORK_PRELOAD}`,
      ELECTRON_BUILDER_RUNNER,
      `--world-ffmpeg-attempt=${cacheLease.record.token}`,
    ], Object.freeze({
      cwd: REPOSITORY_ROOT,
      env,
      shell: false,
      detached: packageTarget.platform !== 'win32' && processLifecycle.processGroupId === undefined,
      windowsHide: true,
      stdio: Object.freeze(['ignore', 'inherit', 'inherit']),
    }), Object.freeze({
      ...processLifecycle,
      platform: packageTarget.platform,
      onLateClose: async () => {
        await lateCleanupReady
        await cleanupWorldFfmpegMutablePackageCacheGeneration(cacheLease, cacheLifecycle)
      },
    }))
    if (!result || typeof result !== 'object'
      || !Object.hasOwn(result, 'code') || !Object.hasOwn(result, 'signal')) {
      throw new Error('Offline electron-builder returned an invalid process result.')
    }
    if (result.code !== 0 || result.signal !== null) return result
    const runnerTerminal = await loadRunnerTerminal(cacheLease)

    // This is deliberately independent of electron-builder's beforePack and
    // afterPack hooks. A successful packaging subprocess is not authoritative
    // until the emitted application resources pass the same resolver, runtime,
    // notice, license, and bound build-report verifier used by packaging hooks.
    const resourcesPath = join(cacheLease.outputDirectory, ...packageTarget.resourceSegments)
    if (target === 'linux-arm64') {
      await assertWorldFfmpegPackagedElectronExecutable(resourcesPath, target)
    }
    const emittedReport = await outputCustody({
      operation: 'read',
      directory: cacheLease.outputDirectory,
      expectedDirectoryIdentity: cacheLease.outputIdentity,
      segments: [...packageTarget.resourceSegments, 'world-ffmpeg-build-reports'],
      name: `${target}.json`,
      maximumBytes: 1024 * 1024,
    })
    const buildReportName = worldFfmpegBuildReportEvidenceName(target)
    const buildReportSnapshot = await outputCustody({
      operation: 'write',
      directory: cacheLease.outputDirectory,
      expectedDirectoryIdentity: cacheLease.outputIdentity,
      name: buildReportName,
      maximumBytes: 1024 * 1024,
      bytes: Buffer.from(emittedReport.bytesBase64, 'base64'),
    })
    const resourcesDirectory = await outputCustody({
      operation: 'directory',
      directory: cacheLease.outputDirectory,
      expectedDirectoryIdentity: cacheLease.outputIdentity,
      segments: [...packageTarget.resourceSegments],
    })
    const verification = await verifyPackage({
      platform: packageTarget.platform,
      arch: packageTarget.arch,
      trustFile: buildTrustFile,
      resourcesPath,
      resourcesIdentity: resourcesDirectory.directoryIdentity,
      buildReportDirectory: cacheLease.outputDirectory,
      buildReportDirectoryIdentity: cacheLease.outputIdentity,
      buildReportName,
      buildReportReceipt: buildReportSnapshot.file,
    })
    if (!verification || verification.ok !== true) {
      throw new Error(`World FFmpeg post-package verification failed: ${verification?.code ?? 'verification-error'}.`)
    }
    if (!sameWorldFfmpegOutputFileReceipt(
      verification.buildReportReceipt,
      buildReportSnapshot.file,
    )) {
      throw new Error('World FFmpeg verifier returned no exact snapshot receipt.')
    }
    if (!SHA256_PATTERN.test(verification.runtimeManifestSha256 ?? '')) {
      throw new Error('World FFmpeg verifier returned no exact runtime-manifest digest.')
    }
    const artifactInspection = await inspectArtifacts(Object.freeze({
      target,
      platform: packageTarget.platform,
      arch: packageTarget.arch,
      artifacts: runnerTerminal.artifacts,
      outputDirectory: cacheLease.outputDirectory,
      outputIdentity: cacheLease.outputIdentity,
      cacheDirectory: cacheLease.cacheDirectory,
      cacheIdentity: cacheLease.cacheIdentity,
      buildTrustFile,
      buildReportDirectory: cacheLease.outputDirectory,
      buildReportDirectoryIdentity: cacheLease.outputIdentity,
      buildReportName,
      buildReportReceipt: buildReportSnapshot.file,
      expectedRuntimeManifestSha256: verification.runtimeManifestSha256,
      extractor: contract.extractors[target],
      verifyPackage,
      outputCustody,
      environment: env,
    }))
    const packageResult = await publishWorldFfmpegPackageResult(
      cacheLease,
      target,
      runnerTerminal,
      buildReportSnapshot,
      verification.buildReportReceipt,
      artifactInspection,
      contract.extractors[target],
      outputCustody,
    )
    publishedPackageResultReceipts.set(cacheLease, packageResult.receipt)
    return Object.freeze({
      code: result.code,
      signal: result.signal,
      attemptId: cacheLease.record.token,
      outputDirectory: cacheLease.outputDirectory,
      resultManifestPath: packageResult.path,
      resultReceipt: packageResult.receipt,
    })
  } catch (error) {
    operationError = error
    custodyUnsettled = error && typeof error === 'object' && error.custodyUnsettled === true
    throw error
  } finally {
    let finalizationError
    try {
      await cacheLease.outerHeartbeat.stop()
    } catch (error) {
      finalizationError = error
    }
    releaseLateCleanup()
    try {
      const archiveVerification = await verifyWorldFfmpegPackageToolCache({
        target, cacheDirectory: archiveDirectory, contract,
      })
      if (!archiveVerification.ok) {
        const error = new Error('World FFmpeg immutable package-tool archive store changed during packaging.')
        finalizationError = finalizationError === undefined
          ? error
          : new AggregateError([finalizationError, error], 'World FFmpeg package finalization failed.')
      }
    } catch {
      const error = new Error('World FFmpeg immutable package-tool archive store changed during packaging.')
      finalizationError = finalizationError === undefined
        ? error
        : new AggregateError([finalizationError, error], 'World FFmpeg package finalization failed.')
    }
    if (!custodyUnsettled) {
      try {
        await cleanupWorldFfmpegMutablePackageCacheGeneration(cacheLease, cacheLifecycle)
      } catch (error) {
        finalizationError = finalizationError === undefined
          ? error
          : new AggregateError([finalizationError, error], 'World FFmpeg mutable package cache finalization failed.')
      }
    }
    if (finalizationError !== undefined) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, finalizationError],
          `World FFmpeg package operation and cache finalization failed: ${errorMessage(operationError)}; ${errorMessage(finalizationError)}`,
        )
      }
      throw finalizationError
    }
  }
}

export function worldFfmpegMutablePackageCacheRootFor(archiveDirectory) {
  const root = requireAbsolute(archiveDirectory, 'package-tool archive store')
  const identity = createHash('sha256').update(root).digest('hex').slice(0, 24)
  return join(dirname(root), `.modly-world-ffmpeg-package-cache-${identity}`)
}

export function worldFfmpegPackageOutputRootFor(archiveDirectory) {
  const root = requireAbsolute(archiveDirectory, 'package-tool archive store')
  const identity = createHash('sha256').update(root).digest('hex').slice(0, 24)
  return join(dirname(root), `.modly-world-ffmpeg-package-output-${identity}`)
}

async function createWorldFfmpegMutablePackageCacheGeneration(input) {
  const rootDirectory = worldFfmpegMutablePackageCacheRootFor(input.archiveDirectory)
  const outputRootDirectory = worldFfmpegPackageOutputRootFor(input.archiveDirectory)
  await ensureMutableCacheRoot(rootDirectory, input.cacheLifecycle.durability)
  await ensureMutableCacheRoot(outputRootDirectory, input.cacheLifecycle.durability)
  for (const parentDirectory of [rootDirectory, outputRootDirectory]) {
    const garbage = await recoverWorldFfmpegOwnedGarbage({
      parentDirectory,
      nowMs: input.cacheLifecycle.now(),
      minimumAgeMs: input.cacheLifecycle.heartbeatFreshMs,
      maximumBytes: WORLD_FFMPEG_PACKAGE_OUTPUT_GARBAGE_MAXIMUM_BYTES,
      durability: input.cacheLifecycle.durability,
    })
    if (garbage.pending > 0 || garbage.unclaimed.length > 0 || garbage.failures.length > 0) {
      throw new Error(`World FFmpeg package cleanup has a concurrent or unclaimed quarantine generation: ${JSON.stringify(garbage)}.`)
    }
  }
  const archiveIdentity = mutableCacheArchiveIdentity(input.target, input.archiveDirectory, input.contract)
  const token = input.attemptToken
  if (!MUTABLE_CACHE_TOKEN_PATTERN.test(token)) {
    throw new Error('World FFmpeg package generation attempt token is invalid.')
  }
  const ownerStartIdentity = await input.cacheLifecycle.processStartIdentity(process.pid, token)
  if (!validConcreteProcessStartIdentity(ownerStartIdentity)) {
    throw new Error('World FFmpeg package owner process identity authority is unavailable.')
  }
  for (let attempt = 0; attempt < 1; attempt += 1) {
    const ownerIdentity = randomBytes(16).toString('hex')
    const cacheName = `cache-${token}`
    const outputName = `output-${token}`
    const leasePath = join(rootDirectory, `lease-${token}.json`)
    const cacheDirectory = join(rootDirectory, cacheName)
    const outputDirectory = join(outputRootDirectory, outputName)
    let cacheIdentity
    let outputIdentity
    try {
      await mkdir(cacheDirectory, { mode: 0o700 })
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') continue
      throw error
    }
    try {
      cacheIdentity = (await input.outputCustody({
        operation: 'directory', directory: cacheDirectory, segments: [],
      })).rootIdentity
      await mkdir(outputDirectory, { mode: 0o700 })
      outputIdentity = (await input.outputCustody({
        operation: 'directory', directory: outputDirectory, segments: [],
      })).rootIdentity
      await Promise.all([
        syncWorldFfmpegDirectory(rootDirectory, input.cacheLifecycle.durability),
        syncWorldFfmpegDirectory(outputRootDirectory, input.cacheLifecycle.durability),
      ])
    } catch (error) {
      const cleanupErrors = []
      if (outputIdentity) {
        await removeExactOwnedDirectory(
          outputDirectory, outputIdentity, input.cacheLifecycle, input.outputCustody, 'output generation',
        ).catch((cleanupError) => cleanupErrors.push(cleanupError))
      }
      if (cacheIdentity) {
        await removeExactOwnedDirectory(
          cacheDirectory, cacheIdentity, input.cacheLifecycle, input.outputCustody, 'cache generation',
        ).catch((cleanupError) => cleanupErrors.push(cleanupError))
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'World FFmpeg package generation allocation cleanup failed.')
      }
      throw error
    }
    const record = Object.freeze({
      schema: MUTABLE_CACHE_LEASE_SCHEMA,
      token,
      target: input.target,
      archiveIdentity,
      ownerPid: process.pid,
      ownerIdentity,
      ownerStartIdentity,
      createdAtMs: input.cacheLifecycle.now(),
      state: 'active',
      cacheName,
      cacheIdentity,
      outputName,
      outputIdentity,
    })
    try {
      await writeCanonicalFileExclusive(leasePath, record, rootDirectory, input.cacheLifecycle.durability)
    } catch (error) {
      const cleanupErrors = []
      await removeExactOwnedDirectory(
        outputDirectory, outputIdentity, input.cacheLifecycle, input.outputCustody, 'output generation',
      ).catch((cleanupError) => cleanupErrors.push(cleanupError))
      await removeExactOwnedDirectory(
        cacheDirectory, cacheIdentity, input.cacheLifecycle, input.outputCustody, 'cache generation',
      ).catch((cleanupError) => cleanupErrors.push(cleanupError))
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'World FFmpeg package lease allocation cleanup failed.')
      }
      if (nodeErrorCode(error) === 'EEXIST') continue
      throw error
    }
    const lease = {
      rootDirectory,
      outputRootDirectory,
      cacheDirectory,
      cacheIdentity,
      outputDirectory,
      outputIdentity,
      leasePath,
      cleanupPath: join(rootDirectory, `cleanup-${token}`),
      runnerHeartbeatPath: join(rootDirectory, `runner-${token}.heartbeat`),
      runnerTerminalPath: join(rootDirectory, `terminal-${token}.json`),
      outerHeartbeatPath: join(rootDirectory, `outer-${token}.heartbeat`),
      outerHeartbeat: undefined,
      record,
    }
    try {
      lease.outerHeartbeat = await startOuterHeartbeat(lease, input.cacheLifecycle)
      await populateMutablePackageCacheGeneration(lease, input)
      return Object.freeze(lease)
    } catch (error) {
      try {
        await lease.outerHeartbeat?.stop()
        await cleanupWorldFfmpegMutablePackageCacheGeneration(lease, input.cacheLifecycle)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'World FFmpeg mutable package cache creation and cleanup failed.')
      }
      throw error
    }
  }
  throw new Error('World FFmpeg mutable package cache attempt token already exists.')
}

async function populateMutablePackageCacheGeneration(lease, input) {
  const created = new Set()
  for (const entry of input.contract.targets[input.target]) {
    const releaseDirectory = join(lease.cacheDirectory, entry.release)
    if (!created.has(releaseDirectory)) {
      await mkdir(releaseDirectory, { mode: 0o700 })
      created.add(releaseDirectory)
    }
    await copyVerifiedArchive(
      join(input.archiveDirectory, entry.release, entry.filename),
      join(releaseDirectory, entry.filename),
      entry,
    )
  }
  for (const directory of created) {
    await syncWorldFfmpegDirectory(directory, input.cacheLifecycle.durability)
  }
  await syncWorldFfmpegDirectory(lease.cacheDirectory, input.cacheLifecycle.durability)
}

async function copyVerifiedArchive(sourcePath, destinationPath, entry) {
  let source
  let destination
  try {
    const sourceInfo = await lstat(sourcePath)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1
      || sourceInfo.size < 1 || sourceInfo.size > entry.maximumBytes) {
      throw new Error(`World FFmpeg immutable package-tool archive is invalid: ${entry.release}/${entry.filename}.`)
    }
    source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await source.stat()
    if (!sameFileIdentity(sourceInfo, before)) {
      throw new Error('World FFmpeg immutable package-tool archive identity changed before copy.')
    }
    destination = await open(destinationPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      size += chunk.byteLength
      if (size > entry.maximumBytes) throw new Error('World FFmpeg immutable package-tool archive exceeded its copy bound.')
      hash.update(chunk)
      await writeAll(destination, chunk)
    }
    await destination.sync()
    const [sourceAfter, destinationInfo] = await Promise.all([source.stat(), destination.stat()])
    if (size !== before.size || hash.digest('hex') !== entry.sha256
      || !sameStableFile(before, sourceAfter)
      || !destinationInfo.isFile() || destinationInfo.nlink !== 1 || destinationInfo.size !== size
      || (sourceAfter.dev === destinationInfo.dev && sourceAfter.ino === destinationInfo.ino)) {
      throw new Error('World FFmpeg mutable package-tool archive copy failed exact verification.')
    }
  } finally {
    if (destination) await destination.close().catch(() => undefined)
    if (source) await source.close().catch(() => undefined)
  }
}

async function writeAll(handle, bytes) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (bytesWritten < 1) throw new Error('World FFmpeg mutable package cache write made no progress.')
    offset += bytesWritten
  }
}

async function startOuterHeartbeat(lease, lifecycle) {
  const record = Object.freeze({
    schema: OUTER_HEARTBEAT_SCHEMA,
    attemptId: lease.record.token,
    target: lease.record.target,
    ownerIdentity: lease.record.ownerIdentity,
    ownerPid: lease.record.ownerPid,
    processStartIdentity: lease.record.ownerStartIdentity,
  })
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
  let handle
  try {
    handle = await open(lease.outerHeartbeatPath, constants.O_CREAT | constants.O_EXCL
      | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
    await writeAll(handle, bytes)
    await handle.sync()
    await syncWorldFfmpegDirectory(lease.rootDirectory, lifecycle.durability)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    throw error
  }
  let refreshError
  let refreshOperation = Promise.resolve()
  let stopPromise
  const timer = setInterval(() => {
    refreshOperation = refreshOperation.then(async () => {
      if (refreshError !== undefined) return
      const now = new Date(lifecycle.now())
      try { await handle.utimes(now, now) } catch (error) { refreshError = error }
    })
  }, lifecycle.heartbeatIntervalMs)
  timer.unref?.()
  return Object.freeze({
    stop() {
      stopPromise ??= (async () => {
        clearInterval(timer)
        await refreshOperation
        try {
          await quarantineOwnedAuthorityFile(lease.outerHeartbeatPath, 'outer heartbeat', {
            retainedHandle: handle,
            durability: lifecycle.durability,
            afterQuarantine: lifecycle.afterAuthorityQuarantine,
            beforeRetirement: lifecycle.beforeAuthorityRetirement,
          })
        } finally {
          await handle.close()
          handle = undefined
        }
        if (refreshError !== undefined) throw refreshError
      })()
      return stopPromise
    },
  })
}

async function loadRunnerTerminal(lease) {
  const value = await readCanonicalBoundedFile(lease.runnerTerminalPath, MAX_RUNNER_TERMINAL_BYTES)
  if (!validateRunnerTerminalRecord(value, lease.record, true)
    || !sameWorldFfmpegOutputDirectoryIdentity(value.outputIdentity, lease.outputIdentity)
    || !sameWorldFfmpegOutputDirectoryIdentity(value.cacheIdentity, lease.cacheIdentity)) {
    throw new Error('World FFmpeg electron-builder runner terminal receipt is invalid.')
  }
  return deepFreeze(value)
}

function validateRunnerTerminalRecord(value, lease, requireSucceeded) {
  if (!exactRecord(value, [
    'schema', 'attemptId', 'target', 'runnerIdentity', 'runnerPid',
    'processStartIdentity', 'cacheIdentity', 'outputIdentity', 'status', 'artifacts',
  ])
    || value.schema !== RUNNER_TERMINAL_SCHEMA
    || value.attemptId !== lease.token
    || value.target !== lease.target
    || !MUTABLE_CACHE_TOKEN_PATTERN.test(value.runnerIdentity)
    || !Number.isSafeInteger(value.runnerPid) || value.runnerPid < 1 || value.runnerPid > 0xffff_ffff
    || !validProcessStartIdentity(value.processStartIdentity)
    || !validateDirectoryIdentity(value.cacheIdentity)
    || !validateDirectoryIdentity(value.outputIdentity)
    || !['succeeded', 'failed'].includes(value.status)) return false
  if (requireSucceeded && value.status !== 'succeeded') return false
  return value.status === 'succeeded'
    ? validateRelativeArtifactPaths(value.artifacts)
    : Array.isArray(value.artifacts) && value.artifacts.length === 0
}

async function publishWorldFfmpegPackageResult(
  lease,
  target,
  runnerTerminal,
  buildReportSnapshot,
  verificationReceipt,
  artifactInspection,
  extractorContract,
  outputCustody,
) {
  const outputIdentity = lease.outputIdentity
  const artifacts = []
  let totalSize = 0
  for (const relativePath of runnerTerminal.artifacts) {
    const receipt = await outputCustody({
      operation: 'hash',
      directory: lease.outputDirectory,
      expectedDirectoryIdentity: outputIdentity,
      name: relativePath,
      maximumBytes: MAX_PACKAGE_ARTIFACT_BYTES,
    })
    totalSize += receipt.file.size
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_PACKAGE_ARTIFACT_TOTAL_BYTES) {
      throw new Error('World FFmpeg package artifact set exceeds its byte bound.')
    }
    artifacts.push(Object.freeze(packageResultFileDescriptor(relativePath, receipt.file)))
  }
  if (!sameWorldFfmpegOutputFileReceipt(buildReportSnapshot.file, verificationReceipt)) {
    throw new Error('World FFmpeg verified build-report snapshot receipt changed.')
  }
  const finalReport = await outputCustody({
    operation: 'hash',
    directory: lease.outputDirectory,
    expectedDirectoryIdentity: outputIdentity,
    name: buildReportSnapshot.file.name,
    maximumBytes: 1024 * 1024,
  })
  if (!sameWorldFfmpegOutputFileReceipt(finalReport.file, verificationReceipt)) {
    throw new Error('World FFmpeg verified build-report snapshot changed before RESULT publication.')
  }
  const buildReport = Object.freeze(packageResultFileDescriptor(
    buildReportSnapshot.file.name,
    verificationReceipt,
  ))
  const inspection = requireArtifactInspection(
    artifactInspection,
    target,
    artifacts,
    verificationReceipt,
    extractorContract,
  )
  const publicationToken = randomBytes(16).toString('hex')
  const manifest = Object.freeze({
    schema: PACKAGE_RESULT_SCHEMA,
    attemptId: lease.record.token,
    target,
    publicationToken,
    outputIdentity,
    artifacts: Object.freeze(artifacts),
    buildReport,
    inspection,
  })
  const resultName = worldFfmpegPackageResultEvidenceName(target)
  const path = join(lease.outputDirectory, resultName)
  const written = await outputCustody({
    operation: 'write',
    directory: lease.outputDirectory,
    expectedDirectoryIdentity: outputIdentity,
    name: resultName,
    maximumBytes: MAX_PACKAGE_RESULT_BYTES,
    bytes: Buffer.from(`${JSON.stringify(manifest)}\n`),
  })
  const receipt = deepFreeze({
    schema: PACKAGE_RESULT_RECEIPT_SCHEMA,
    attemptId: lease.record.token,
    target,
    publicationToken,
    manifestPath: path,
    outputIdentity,
    manifestFile: written.file,
  })
  await loadWorldFfmpegPackageResult(path, {
    outputCustody,
    resultReceipt: receipt,
    extractorContract,
  })
  return Object.freeze({ path, manifest, receipt })
}

function packageResultFileDescriptor(path, receipt) {
  return {
    path,
    dev: receipt.dev,
    ino: receipt.ino,
    size: receipt.size,
    sha256: receipt.sha256,
  }
}

export async function loadWorldFfmpegPackageResult(manifestPath, dependencies = {}) {
  const path = requireAbsolute(manifestPath, 'package-result manifest')
  const outputDirectory = dirname(path)
  const outputName = basename(outputDirectory)
  const match = /^output-([a-f0-9]{32})$/.exec(outputName)
  if (!match) throw new Error('World FFmpeg package-result output identity is invalid.')
  const resultReceipt = requireWorldFfmpegPackageResultReceipt(dependencies.resultReceipt, path)
  const outputCustody = requireOutputCustody(dependencies.outputCustody, dependencies.environment ?? process.env)
  const manifestReceipt = await outputCustody({
    operation: 'read',
    directory: outputDirectory,
    expectedDirectoryIdentity: resultReceipt.outputIdentity,
    name: basename(path),
    maximumBytes: MAX_PACKAGE_RESULT_BYTES,
  })
  if (!sameWorldFfmpegOutputFileReceipt(manifestReceipt.file, resultReceipt.manifestFile)) {
    throw new Error('World FFmpeg package-result manifest receipt changed before its first read.')
  }
  let value
  const manifestBytes = Buffer.from(manifestReceipt.bytesBase64, 'base64')
  try { value = JSON.parse(manifestBytes.toString('utf8')) } catch {
    throw new Error('World FFmpeg package-result manifest is not valid JSON.')
  }
  if (!manifestBytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) {
    throw new Error('World FFmpeg package-result manifest is not canonical.')
  }
  const extractorContract = dependencies.extractorContract
    ?? (await loadWorldFfmpegPackageToolLock()).extractors[value?.target]
  value = requireWorldFfmpegPackageResultManifest(value, resultReceipt, extractorContract)
  if (value.attemptId !== match[1]) throw new Error('World FFmpeg package-result manifest is invalid.')
  if (!validateDirectoryIdentity(value.outputIdentity)
    || !sameWorldFfmpegOutputDirectoryIdentity(value.outputIdentity, manifestReceipt.rootIdentity)
    || !sameWorldFfmpegOutputDirectoryIdentity(value.outputIdentity, resultReceipt.outputIdentity)) {
    throw new Error('World FFmpeg package-result output root identity changed.')
  }
  for (const artifact of value.artifacts) {
    const receipt = await outputCustody({
      operation: 'hash',
      directory: outputDirectory,
      expectedDirectoryIdentity: value.outputIdentity,
      name: artifact.path,
      maximumBytes: MAX_PACKAGE_ARTIFACT_BYTES,
    })
    if (!packageResultDescriptorMatchesReceipt(artifact, receipt.file)) {
      throw new Error('World FFmpeg package-result artifact changed after publication.')
    }
  }
  const report = value.buildReport
  const reportReceipt = await outputCustody({
    operation: 'hash',
    directory: outputDirectory,
    expectedDirectoryIdentity: value.outputIdentity,
    name: report.path,
    maximumBytes: 1024 * 1024,
  })
  if (!packageResultDescriptorMatchesReceipt(report, reportReceipt.file)) {
    throw new Error('World FFmpeg package-result build report changed after publication.')
  }
  const finalRoot = await outputCustody({
    operation: 'directory',
    directory: outputDirectory,
    expectedDirectoryIdentity: value.outputIdentity,
    segments: [],
  })
  if (!sameWorldFfmpegOutputDirectoryIdentity(finalRoot.rootIdentity, value.outputIdentity)) {
    throw new Error('World FFmpeg package-result output root identity changed.')
  }
  return deepFreeze(value)
}

export function requireWorldFfmpegPackageResultManifest(value, resultReceipt, extractorContract) {
  const receipt = requireWorldFfmpegPackageResultReceipt(resultReceipt)
  if (!exactRecord(value, [
    'schema', 'attemptId', 'target', 'publicationToken', 'outputIdentity',
    'artifacts', 'buildReport', 'inspection',
  ])
    || value.schema !== PACKAGE_RESULT_SCHEMA
    || value.attemptId !== receipt.attemptId
    || value.target !== receipt.target
    || value.publicationToken !== receipt.publicationToken
    || !MUTABLE_CACHE_TOKEN_PATTERN.test(value.publicationToken)
    || !EXPECTED_TARGETS.includes(value.target)
    || !validateDirectoryIdentity(value.outputIdentity)
    || !sameWorldFfmpegOutputDirectoryIdentity(value.outputIdentity, receipt.outputIdentity)
    || !Array.isArray(value.artifacts) || value.artifacts.length < 1
    || value.artifacts.length > MAX_PACKAGE_ARTIFACTS) {
    throw new Error('World FFmpeg package-result manifest is invalid.')
  }
  let previous = ''
  let totalSize = 0
  for (const artifact of value.artifacts) {
    if (!exactRecord(artifact, ['path', 'dev', 'ino', 'size', 'sha256'])
      || !validPortableRelativePath(artifact.path)
      || artifact.path <= previous
      || !validFilesystemIdentity(artifact.dev) || !validFilesystemIdentity(artifact.ino, false)
      || !Number.isSafeInteger(artifact.size) || artifact.size < 1
      || artifact.size > MAX_PACKAGE_ARTIFACT_BYTES
      || !SHA256_PATTERN.test(artifact.sha256)) {
      throw new Error('World FFmpeg package-result artifact descriptor is invalid.')
    }
    previous = artifact.path
    totalSize += artifact.size
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_PACKAGE_ARTIFACT_TOTAL_BYTES) {
      throw new Error('World FFmpeg package-result artifact set exceeds its byte bound.')
    }
  }
  const report = value.buildReport
  if (!exactRecord(report, ['path', 'dev', 'ino', 'size', 'sha256'])
    || report.path !== worldFfmpegBuildReportEvidenceName(value.target)
    || !validFilesystemIdentity(report.dev) || !validFilesystemIdentity(report.ino, false)
    || !Number.isSafeInteger(report.size) || report.size < 2 || report.size > 1024 * 1024
    || !SHA256_PATTERN.test(report.sha256)) {
    throw new Error('World FFmpeg package-result build report descriptor is invalid.')
  }
  requireArtifactInspection(value.inspection, value.target, value.artifacts, report, extractorContract)
  return deepFreeze(value)
}

export function requireWorldFfmpegPackageResultReceipt(value, expectedManifestPath = undefined) {
  if (!exactRecord(value, [
    'schema', 'attemptId', 'target', 'publicationToken', 'manifestPath',
    'outputIdentity', 'manifestFile',
  ]) || value.schema !== PACKAGE_RESULT_RECEIPT_SCHEMA
    || !MUTABLE_CACHE_TOKEN_PATTERN.test(value.attemptId)
    || !EXPECTED_TARGETS.includes(value.target)
    || !MUTABLE_CACHE_TOKEN_PATTERN.test(value.publicationToken)
    || typeof value.manifestPath !== 'string' || !isAbsolute(value.manifestPath)
    || value.manifestPath.includes('\0') || /[\r\n]/.test(value.manifestPath)
    || basename(value.manifestPath) !== worldFfmpegPackageResultEvidenceName(value.target)
    || basename(dirname(value.manifestPath)) !== `output-${value.attemptId}`
    || !validateDirectoryIdentity(value.outputIdentity)
    || !sameWorldFfmpegOutputFileReceipt(value.manifestFile, value.manifestFile)
    || value.manifestFile.name !== basename(value.manifestPath)
    || (expectedManifestPath !== undefined
      && resolve(value.manifestPath) !== requireAbsolute(expectedManifestPath, 'package-result manifest'))) {
    throw new Error('World FFmpeg package-result trusted receipt is invalid.')
  }
  return deepFreeze(value)
}

function requireArtifactInspection(value, target, artifacts, buildReport, extractorContract) {
  const expectedSuffix = target === 'linux-arm64' || target === 'linux-x64'
    ? '.AppImage' : target === 'darwin-arm64' ? '.dmg' : '.zip'
  const deployables = artifacts.filter((artifact) => artifact.path.endsWith(expectedSuffix))
  if (!exactRecord(value, [
    'schema', 'target', 'artifact', 'runtimeManifestSha256', 'buildReportSha256', 'extractor',
  ]) || value.schema !== ARTIFACT_INSPECTION_SCHEMA || value.target !== target
    || deployables.length !== 1
    || !exactRecord(value.artifact, ['path', 'dev', 'ino', 'size', 'sha256'])
    || !packageResultDescriptorMatchesReceipt(value.artifact, {
      name: value.artifact.path,
      dev: deployables[0].dev,
      ino: deployables[0].ino,
      size: deployables[0].size,
      sha256: deployables[0].sha256,
    })
    || !SHA256_PATTERN.test(value.runtimeManifestSha256)
    || value.buildReportSha256 !== buildReport.sha256
    || !validateWorldFfmpegExtractorContract(extractorContract, target)
    || !validateWorldFfmpegExtractorProof(value.extractor, extractorContract)) {
    throw new Error('World FFmpeg deployable artifact inspection receipt is invalid.')
  }
  return deepFreeze(value)
}

export function worldFfmpegBuildReportEvidenceName(target) {
  return `WORLD_FFMPEG_BUILD_REPORT.${requireTarget(target)}.v1.json`
}

export function worldFfmpegPackageResultEvidenceName(target) {
  return `RESULT.${requireTarget(target)}.v1.json`
}

function packageResultDescriptorMatchesReceipt(descriptor, receipt) {
  return descriptor.path === receipt.name
    && descriptor.dev === receipt.dev && descriptor.ino === receipt.ino
    && descriptor.size === receipt.size && descriptor.sha256 === receipt.sha256
}

async function readCanonicalBoundedFile(path, maximumBytes) {
  let handle
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || info.size < 2 || info.size > maximumBytes) {
      throw new Error('World FFmpeg bounded authority file is invalid.')
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat()
    if (!sameFileIdentity(info, before)) throw new Error('World FFmpeg authority file identity changed.')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (!sameStableFile(before, after)) throw new Error('World FFmpeg authority file changed while read.')
    let value
    try { value = JSON.parse(bytes.toString('utf8')) } catch {
      throw new Error('World FFmpeg authority file is not valid JSON.')
    }
    if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) {
      throw new Error('World FFmpeg authority file is not canonical.')
    }
    return value
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function validateRelativeArtifactPaths(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PACKAGE_ARTIFACTS) return false
  let previous = ''
  for (const path of value) {
    if (!validPortableRelativePath(path) || path <= previous) return false
    previous = path
  }
  return true
}

function validPortableRelativePath(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(value)
}

function validateDirectoryIdentity(value) {
  return exactRecord(value, ['dev', 'ino'])
    && typeof value.dev === 'string' && /^[0-9]{1,40}$/.test(value.dev)
    && typeof value.ino === 'string' && /^[1-9][0-9]{0,39}$/.test(value.ino)
}

function directoryIdentityFromStats(info) {
  return Object.freeze({ dev: String(info.dev), ino: String(info.ino) })
}

function validFilesystemIdentity(value, allowZero = true) {
  return typeof value === 'string'
    && (allowZero ? /^[0-9]{1,40}$/ : /^[1-9][0-9]{0,39}$/).test(value)
}

function validProcessStartIdentity(value) {
  return value === 'unavailable' || validConcreteProcessStartIdentity(value)
}

function validConcreteProcessStartIdentity(value) {
  return typeof value === 'string' && (
    /^linux-proc-start:[0-9]{1,32}$/.test(value)
    || /^darwin-ps-start-command:[a-f0-9]{64}$/.test(value)
    || /^win32-process-start:[0-9]{1,32}$/.test(value)
  )
}

async function recoverWorldFfmpegMutablePackageCacheGenerations(input) {
  const rootDirectory = worldFfmpegMutablePackageCacheRootFor(input.archiveDirectory)
  const outputRootDirectory = worldFfmpegPackageOutputRootFor(input.archiveDirectory)
  await ensureMutableCacheRoot(rootDirectory, input.cacheLifecycle.durability)
  await ensureMutableCacheRoot(outputRootDirectory, input.cacheLifecycle.durability)
  const archiveIdentity = mutableCacheArchiveIdentity(input.target, input.archiveDirectory, input.contract)
  const names = (await readdir(rootDirectory)).sort(codeUnitCompare)
  const recovered = new Set()
  for (const name of names) {
    const match = MUTABLE_CACHE_CLEANUP_PATTERN.exec(name)
    if (!match) continue
    const cleanupDirectory = join(rootDirectory, name)
    const cleanupInfo = await lstat(cleanupDirectory).catch(() => null)
    if (!cleanupInfo?.isDirectory() || cleanupInfo.isSymbolicLink()
      || (await readdir(cleanupDirectory).catch(() => ['invalid'])).length !== 0) {
      throw new Error('World FFmpeg mutable package cache cleanup authority is invalid.')
    }
    const record = await readMutableCacheRecord(
      join(rootDirectory, `lease-${match[1]}.json`), match[1], 'active',
    )
    if (!record) throw new Error('World FFmpeg mutable package cache cleanup lease is invalid.')
    if (record.target !== input.target || record.archiveIdentity !== archiveIdentity) continue
    await boundedMutableCacheCleanup(
      removeOwnedMutableCacheGeneration(
        rootDirectory,
        record,
        input.cacheLifecycle,
        undefined,
        directoryIdentityFromStats(cleanupInfo),
      ),
      input.cacheLifecycle.cleanupTimeoutMs,
    )
    recovered.add(record.token)
  }
  for (const name of names) {
    const match = MUTABLE_CACHE_LEASE_PATTERN.exec(name)
    if (!match || recovered.has(match[1])) continue
    const record = await readMutableCacheRecord(join(rootDirectory, name), match[1], 'active')
    if (!record) throw new Error('World FFmpeg mutable package cache lease is invalid.')
    if (record.target !== input.target || record.archiveIdentity !== archiveIdentity) continue
    if (await packageAttemptHasLiveCustody(rootDirectory, record, input.cacheLifecycle)) continue
    const cleanupIdentity = await ensureMutableCacheCleanupRecord(
      rootDirectory,
      record,
      input.cacheLifecycle.durability,
    )
    await boundedMutableCacheCleanup(
      removeOwnedMutableCacheGeneration(
        rootDirectory,
        record,
        input.cacheLifecycle,
        undefined,
        cleanupIdentity,
      ),
      input.cacheLifecycle.cleanupTimeoutMs,
    )
    recovered.add(record.token)
  }
  const orphanRecovered = await recoverOrphanMutablePackageGenerations({
    ...input, rootDirectory, outputRootDirectory,
  })
  return Object.freeze({ recovered: recovered.size + orphanRecovered })
}

async function recoverOrphanMutablePackageGenerations(input) {
  const cacheNames = await readdir(input.rootDirectory)
  const outputNames = await readdir(input.outputRootDirectory)
  const leased = new Set(cacheNames.flatMap((name) => MUTABLE_CACHE_LEASE_PATTERN.exec(name)?.[1] ?? []))
  const tokens = new Set()
  for (const name of cacheNames) {
    for (const pattern of [
      /^cache-([a-f0-9]{32})$/,
      MUTABLE_CACHE_OUTER_HEARTBEAT_PATTERN,
      MUTABLE_CACHE_RUNNER_HEARTBEAT_PATTERN,
      MUTABLE_CACHE_RUNNER_TERMINAL_PATTERN,
    ]) {
      const token = pattern.exec(name)?.[1]
      if (token && !leased.has(token)) tokens.add(token)
    }
  }
  for (const name of outputNames) {
    const token = /^output-([a-f0-9]{32})$/.exec(name)?.[1]
    if (token && !leased.has(token)) tokens.add(token)
  }
  let recovered = 0
  for (const token of [...tokens].sort(codeUnitCompare)) {
    if (await recoverOrphanMutablePackageGeneration(input, token)) recovered += 1
  }
  return recovered
}

async function recoverOrphanMutablePackageGeneration(input, token) {
  const paths = {
    cache: join(input.rootDirectory, `cache-${token}`),
    output: join(input.outputRootDirectory, `output-${token}`),
    outer: join(input.rootDirectory, `outer-${token}.heartbeat`),
    runner: join(input.rootDirectory, `runner-${token}.heartbeat`),
    terminal: join(input.rootDirectory, `terminal-${token}.json`),
    cleanup: join(input.rootDirectory, `cleanup-${token}`),
  }
  const entries = new Map()
  for (const [role, path] of Object.entries(paths)) {
    const info = await lstat(path).catch((error) => {
      if (nodeErrorCode(error) === 'ENOENT') return null
      throw error
    })
    if (info) entries.set(role, info)
  }
  if (entries.has('cleanup') || entries.has('outer')) return false
  for (const [role, info] of entries) {
    const expected = role === 'cache' || role === 'output' ? info.isDirectory() : info.isFile()
    if (!expected || info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) return false
  }
  if (entries.has('output')) {
    const published = await ordinaryFileExists(join(
      paths.output,
      worldFfmpegPackageResultEvidenceName(input.target),
    ))
    if (published) return false
  }
  const lease = Object.freeze({ token, target: input.target })
  if (entries.has('runner')) {
    const runner = await readPackageHeartbeat(paths.runner, lease, 'runner', input.cacheLifecycle)
      .catch(() => null)
    if (!runner || runner.fresh || runner.live === true) return false
    if (runner.live === null) {
      throw new Error('World FFmpeg package runner recovery identity authority is unavailable.')
    }
  }
  let terminal = null
  if (entries.has('terminal')) {
    terminal = await readRunnerTerminalForRecovery(paths.terminal, lease).catch(() => null)
    if (!terminal) return false
  }
  if (!terminal) return false
  const terminalProcessIdentity = await input.cacheLifecycle.processStartIdentity(terminal.runnerPid, terminal.attemptId)
  if (terminal.processStartIdentity === 'unavailable'
    || terminalProcessIdentity === 'unavailable') {
    throw new Error('World FFmpeg orphan runner recovery identity authority is unavailable.')
  }
  if (terminalProcessIdentity === terminal.processStartIdentity) return false
  if (entries.has('cache') && !sameWorldFfmpegOutputDirectoryIdentity(
    terminal.cacheIdentity,
    directoryIdentityFromStats(entries.get('cache')),
  )) return false
  if (entries.has('output') && !sameWorldFfmpegOutputDirectoryIdentity(
    terminal.outputIdentity,
    directoryIdentityFromStats(entries.get('output')),
  )) return false
  const newestMtime = Math.max(...[...entries.values()].map((info) => info.mtimeMs))
  if (input.cacheLifecycle.now() - newestMtime <= input.cacheLifecycle.heartbeatFreshMs) return false
  if (entries.has('cache')) await removeExactOwnedDirectory(
    paths.cache, terminal.cacheIdentity, input.cacheLifecycle, input.outputCustody, 'orphan cache generation',
  )
  if (entries.has('output')) await removeExactOwnedDirectory(
    paths.output, terminal.outputIdentity, input.cacheLifecycle, input.outputCustody, 'orphan output generation',
  )
  for (const role of ['runner', 'terminal']) {
    if (!entries.has(role)) continue
    await removeOwnedMutableCacheAuthority(
      paths[role],
      role === 'runner' ? 'orphan runner heartbeat' : 'orphan runner terminal receipt',
      (candidatePath) => role === 'runner'
        ? readPackageHeartbeat(candidatePath, lease, 'runner', input.cacheLifecycle)
        : readRunnerTerminalForRecovery(candidatePath, lease),
      { durability: input.cacheLifecycle.durability },
    )
  }
  await Promise.all([
    syncWorldFfmpegDirectory(input.rootDirectory, input.cacheLifecycle.durability),
    syncWorldFfmpegDirectory(input.outputRootDirectory, input.cacheLifecycle.durability),
  ])
  return true
}

async function packageAttemptHasLiveCustody(rootDirectory, record, lifecycle) {
  const terminal = await readRunnerTerminalForRecovery(
    join(rootDirectory, `terminal-${record.token}.json`), record,
  )
  const outer = await readPackageHeartbeat(
    join(rootDirectory, `outer-${record.token}.heartbeat`), record, 'outer', lifecycle,
  )
  if (outer?.fresh === true) return true
  if (outer?.live === true) return true
  if (outer?.live === null) {
    throw new Error('World FFmpeg package outer recovery identity authority is unavailable.')
  }
  const runner = await readPackageHeartbeat(
    join(rootDirectory, `runner-${record.token}.heartbeat`), record, 'runner', lifecycle,
  )
  if (runner?.fresh === true) return true
  if (runner?.live === true) return true
  if (runner?.live === null) {
    throw new Error('World FFmpeg package runner recovery identity authority is unavailable.')
  }
  if (terminal !== null) return false
  if (outer === null) {
    if (!validConcreteProcessStartIdentity(record.ownerStartIdentity)) {
      throw new Error('World FFmpeg package owner recovery identity authority is unavailable.')
    }
    const ownerIdentity = await lifecycle.processStartIdentity(record.ownerPid, record.token)
    if (ownerIdentity === 'unavailable') {
      throw new Error('World FFmpeg package owner recovery identity authority is unavailable.')
    }
    if (ownerIdentity === record.ownerStartIdentity) return true
  }
  return outer === null && runner === null
    && lifecycle.now() - record.createdAtMs <= lifecycle.heartbeatFreshMs
}

async function readPackageHeartbeat(path, lease, role, lifecycle) {
  let info
  try { info = await lstat(path) } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return null
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size < 2 || info.size > MAX_MUTABLE_CACHE_HEARTBEAT_BYTES) {
    throw new Error(`World FFmpeg package ${role} heartbeat identity is invalid.`)
  }
  const value = await readCanonicalBoundedFile(path, MAX_MUTABLE_CACHE_HEARTBEAT_BYTES)
  const pidKey = role === 'outer' ? 'ownerPid' : 'runnerPid'
  const commonValid = value.attemptId === lease.token
    && value.target === lease.target
    && Number.isSafeInteger(value[pidKey])
    && value[pidKey] >= 1 && value[pidKey] <= 0xffff_ffff
    && validProcessStartIdentity(value.processStartIdentity)
  const identityValid = role === 'outer'
    ? exactRecord(value, [
      'schema', 'attemptId', 'target', 'ownerIdentity', 'ownerPid', 'processStartIdentity',
    ]) && value.schema === OUTER_HEARTBEAT_SCHEMA
      && value.ownerIdentity === lease.ownerIdentity && value.ownerPid === lease.ownerPid
      && value.processStartIdentity === lease.ownerStartIdentity
    : exactRecord(value, [
      'schema', 'attemptId', 'target', 'runnerIdentity', 'runnerPid', 'processStartIdentity',
    ]) && value.schema === RUNNER_HEARTBEAT_SCHEMA
      && MUTABLE_CACHE_TOKEN_PATTERN.test(value.runnerIdentity)
  if (!commonValid || !identityValid) {
    throw new Error(`World FFmpeg package ${role} heartbeat is malformed or not attempt-bound.`)
  }
  const currentIdentity = await lifecycle.processStartIdentity(value[pidKey], value.attemptId)
  const live = value.processStartIdentity === 'unavailable'
    ? null
    : currentIdentity === value.processStartIdentity
  const processMatches = live === null
    ? currentIdentity === 'unavailable'
    : live
  const now = lifecycle.now()
  const age = now - info.mtimeMs
  return Object.freeze({
    value,
    live,
    fresh: processMatches && age >= -2_000 && age <= lifecycle.heartbeatFreshMs,
  })
}

async function readRunnerTerminalForRecovery(path, lease) {
  try {
    const value = await readCanonicalBoundedFile(path, MAX_RUNNER_TERMINAL_BYTES)
    if (!validateRunnerTerminalRecord(value, lease, false)) {
      throw new Error('World FFmpeg electron-builder runner terminal receipt is invalid.')
    }
    return value
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return null
    throw error
  }
}

function cleanupWorldFfmpegMutablePackageCacheGeneration(lease, cacheLifecycle) {
  const existing = mutableCacheCleanupPromises.get(lease)
  if (existing) return existing
  const operation = Promise.resolve()
    .then(() => ensureMutableCacheCleanupRecord(
      lease.rootDirectory,
      lease.record,
      cacheLifecycle.durability,
    ))
    .then((cleanupIdentity) => removeOwnedMutableCacheGeneration(
      lease.rootDirectory,
      { ...lease.record, state: 'cleanup-pending' },
      cacheLifecycle,
      publishedPackageResultReceipts.get(lease),
      cleanupIdentity,
    ))
  const bounded = boundedMutableCacheCleanup(operation, cacheLifecycle.cleanupTimeoutMs)
  mutableCacheCleanupPromises.set(lease, bounded)
  return bounded
}

async function ensureMutableCacheCleanupRecord(rootDirectory, activeRecord, durability) {
  const cleanupPath = join(rootDirectory, `cleanup-${activeRecord.token}`)
  try {
    await mkdir(cleanupPath, { mode: 0o700 })
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error
    const info = await lstat(cleanupPath)
    if (!info.isDirectory() || info.isSymbolicLink()
      || (await readdir(cleanupPath)).length !== 0) {
      throw new Error('World FFmpeg mutable package cache cleanup authority conflicts.')
    }
  }
  await syncWorldFfmpegDirectory(rootDirectory, durability)
  const info = await lstat(cleanupPath, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(cleanupPath)).length !== 0) {
    throw new Error('World FFmpeg mutable package cache cleanup authority conflicts.')
  }
  return directoryIdentityFromStats(info)
}

async function removeOwnedMutableCacheGeneration(
  rootDirectory,
  record,
  cacheLifecycle,
  resultReceipt = undefined,
  cleanupIdentity = undefined,
) {
  const cacheDirectory = join(rootDirectory, record.cacheName)
  const outputRootDirectory = worldFfmpegPackageOutputRootFor(cacheLifecycle.archiveDirectory)
  const outputDirectory = join(outputRootDirectory, record.outputName)
  await removeExactOwnedDirectory(
    cacheDirectory,
    record.cacheIdentity,
    cacheLifecycle,
    cacheLifecycle.outputCustody,
    'cache generation',
  )
  const resultPath = join(outputDirectory, worldFfmpegPackageResultEvidenceName(record.target))
  const publishedResult = resultReceipt
    ? await loadWorldFfmpegPackageResult(resultPath, {
      outputCustody: cacheLifecycle.outputCustody,
      resultReceipt,
    }).then(() => true, () => false)
    : await ordinaryFileExists(resultPath)
  if (!publishedResult) {
    await removeExactOwnedDirectory(
      outputDirectory,
      record.outputIdentity,
      cacheLifecycle,
      cacheLifecycle.outputCustody,
      'output generation',
    )
    await syncWorldFfmpegDirectory(outputRootDirectory, cacheLifecycle.durability)
  }
  for (const [name, label, role] of [
    [`outer-${record.token}.heartbeat`, 'outer heartbeat', 'outer'],
    [`runner-${record.token}.heartbeat`, 'runner heartbeat', 'runner'],
    [`terminal-${record.token}.json`, 'runner terminal receipt', 'terminal'],
  ]) {
    const authorityPath = join(rootDirectory, name)
    await removeOwnedMutableCacheAuthority(authorityPath, label, (candidatePath) => role === 'terminal'
      ? readRunnerTerminalForRecovery(candidatePath, record)
      : readPackageHeartbeat(candidatePath, record, role, cacheLifecycle))
  }
  await removeExactOwnedDirectory(
    join(rootDirectory, `cleanup-${record.token}`),
    cleanupIdentity,
    cacheLifecycle,
    cacheLifecycle.outputCustody,
    'cleanup authority',
  )
  await syncWorldFfmpegDirectory(rootDirectory, cacheLifecycle.durability)
  const leasePath = join(rootDirectory, `lease-${record.token}.json`)
  await removeOwnedMutableCacheAuthority(leasePath, 'lease', async (candidatePath) => {
    const owned = await readMutableCacheRecord(candidatePath, record.token, 'active')
    if (!owned || !sameMutableCacheRecordAuthority(owned, record)) {
      throw new Error('World FFmpeg mutable package cache lease changed before cleanup.')
    }
    return owned
  }, { durability: cacheLifecycle.durability })
  await syncWorldFfmpegDirectory(rootDirectory, cacheLifecycle.durability)
}

function sameMutableCacheRecordAuthority(left, right) {
  return left.token === right.token && left.target === right.target
    && left.archiveIdentity === right.archiveIdentity
    && left.ownerPid === right.ownerPid && left.ownerIdentity === right.ownerIdentity
    && left.ownerStartIdentity === right.ownerStartIdentity && left.createdAtMs === right.createdAtMs
    && left.cacheName === right.cacheName && left.outputName === right.outputName
    && sameWorldFfmpegOutputDirectoryIdentity(left.cacheIdentity, right.cacheIdentity)
    && sameWorldFfmpegOutputDirectoryIdentity(left.outputIdentity, right.outputIdentity)
}

async function removeExactOwnedDirectory(path, expectedIdentity, lifecycle, outputCustody, label) {
  if (!validateDirectoryIdentity(expectedIdentity) || typeof outputCustody !== 'function') {
    throw new Error(`World FFmpeg mutable package ${label} has no exact cleanup identity.`)
  }
  let ownedInfo
  try {
    ownedInfo = await lstat(path, { bigint: true })
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return
    throw error
  }
  if (!ownedInfo.isDirectory() || ownedInfo.isSymbolicLink()
    || !sameWorldFfmpegOutputDirectoryIdentity(directoryIdentityFromStats(ownedInfo), expectedIdentity)) {
    throw new Error(`World FFmpeg mutable package ${label} identity changed before cleanup.`)
  }
  await lifecycle.beforeDirectoryQuarantine?.({ path, expectedIdentity, label })
  await quarantineAndReclaimWorldFfmpegDirectory({
    path,
    expectedIdentity,
    label: `package-${label}`,
    maximumBytes: WORLD_FFMPEG_PACKAGE_OUTPUT_GARBAGE_MAXIMUM_BYTES,
    durability: lifecycle.durability,
    afterQuarantine: lifecycle.beforeDirectoryRetirement,
    beforeFileReclaim: lifecycle.beforeDirectoryFileReclaim,
  })
}

async function ordinaryFileExists(path) {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function removeOwnedMutableCacheAuthority(path, label, validate, dependencies = {}) {
  try {
    await quarantineOwnedAuthorityFile(path, label, {
      validate,
      durability: dependencies.durability,
      afterQuarantine: dependencies.afterQuarantine,
      beforeRetirement: dependencies.beforeRetirement,
    })
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error
  }
}

async function quarantineOwnedAuthorityFile(path, label, dependencies = {}) {
  await quarantineAndReclaimWorldFfmpegFile({
    path,
    label: `package-${label}`,
    retainedHandle: dependencies.retainedHandle,
    durability: dependencies.durability,
    validate: dependencies.validate,
    afterQuarantine: dependencies.afterQuarantine,
    beforeRetirement: dependencies.beforeRetirement,
  })
}

async function ensureMutableCacheRoot(rootDirectory, durability) {
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 })
  const info = await lstat(rootDirectory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('World FFmpeg mutable package cache root is invalid.')
  }
  await syncWorldFfmpegDirectory(dirname(rootDirectory), durability)
}

async function writeCanonicalFileExclusive(path, value, parentDirectory, durability) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  let handle
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await writeAll(handle, bytes)
    await handle.sync()
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
  await syncWorldFfmpegDirectory(parentDirectory, durability)
}

async function readMutableCacheRecord(path, token, expectedState) {
  let handle
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || info.size < 2 || info.size > MAX_MUTABLE_CACHE_LEASE_BYTES) return null
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat()
    if (!sameFileIdentity(info, before)) return null
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (!sameStableFile(before, after)) return null
    let value
    try { value = JSON.parse(bytes.toString('utf8')) } catch { return null }
    if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))
      || !exactRecord(value, [
        'schema', 'token', 'target', 'archiveIdentity', 'ownerPid', 'ownerIdentity',
        'ownerStartIdentity', 'createdAtMs', 'state', 'cacheName', 'cacheIdentity',
        'outputName', 'outputIdentity',
      ])
      || value.schema !== MUTABLE_CACHE_LEASE_SCHEMA
      || value.token !== token || !MUTABLE_CACHE_TOKEN_PATTERN.test(value.token)
      || value.state !== expectedState
      || value.cacheName !== `cache-${token}`
      || !validateDirectoryIdentity(value.cacheIdentity)
      || value.outputName !== `output-${token}`
      || !validateDirectoryIdentity(value.outputIdentity)
      || !EXPECTED_TARGETS.includes(value.target)
      || !SHA256_PATTERN.test(value.archiveIdentity)
      || !Number.isSafeInteger(value.ownerPid) || value.ownerPid < 1 || value.ownerPid > 0xffff_ffff
      || !MUTABLE_CACHE_TOKEN_PATTERN.test(value.ownerIdentity)
      || !validProcessStartIdentity(value.ownerStartIdentity)
      || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0) return null
    return value
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function mutableCacheArchiveIdentity(target, archiveDirectory, contract) {
  return createHash('sha256').update(JSON.stringify({
    schema: MUTABLE_CACHE_LEASE_SCHEMA,
    target,
    archiveDirectory,
    entries: contract.targets[target],
    extractor: contract.extractors[target],
  })).digest('hex')
}

function requireMutableCacheLifecycle(value, entries, archiveDirectory, outputCustody) {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('World FFmpeg mutable package cache lifecycle is invalid.')
  }
  const maximumBytes = entries.reduce((total, entry) => total + entry.maximumBytes, 0)
  const derivedCleanupMs = Math.min(
    MAX_MUTABLE_CACHE_CLEANUP_MS,
    MIN_MUTABLE_CACHE_CLEANUP_MS
      + Math.ceil((maximumBytes * 8) / MUTABLE_CACHE_CLEANUP_BYTES_PER_SECOND) * 1_000,
  )
  const cleanupTimeoutMs = value?.cleanupTimeoutMs ?? derivedCleanupMs
  const heartbeatIntervalMs = value?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const heartbeatFreshMs = value?.heartbeatFreshMs ?? DEFAULT_HEARTBEAT_FRESH_MS
  const processPlatform = value?.processPlatform ?? process.platform
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1
    || cleanupTimeoutMs > MAX_MUTABLE_CACHE_CLEANUP_MS
    || !Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1
    || heartbeatIntervalMs > MAX_HEARTBEAT_FRESH_MS
    || !Number.isSafeInteger(heartbeatFreshMs) || heartbeatFreshMs < heartbeatIntervalMs * 2
    || heartbeatFreshMs > MAX_HEARTBEAT_FRESH_MS
    || value?.removeTree !== undefined
    || (value?.beforeDirectoryQuarantine !== undefined && typeof value.beforeDirectoryQuarantine !== 'function')
    || (value?.beforeDirectoryRetirement !== undefined && typeof value.beforeDirectoryRetirement !== 'function')
    || (value?.afterAuthorityQuarantine !== undefined && typeof value.afterAuthorityQuarantine !== 'function')
    || (value?.beforeAuthorityRetirement !== undefined && typeof value.beforeAuthorityRetirement !== 'function')
    || (value?.processStartIdentity !== undefined && typeof value.processStartIdentity !== 'function')
    || (value?.spawnIdentityProbe !== undefined && typeof value.spawnIdentityProbe !== 'function')
    || !['linux', 'darwin', 'win32'].includes(processPlatform)
    || (value?.now !== undefined && typeof value.now !== 'function')) {
    throw new Error('World FFmpeg mutable package cache lifecycle is invalid.')
  }
  return Object.freeze({
    archiveDirectory,
    outputCustody,
    cleanupTimeoutMs,
    heartbeatIntervalMs,
    heartbeatFreshMs,
    beforeDirectoryQuarantine: value?.beforeDirectoryQuarantine,
    beforeDirectoryRetirement: value?.beforeDirectoryRetirement,
    afterAuthorityQuarantine: value?.afterAuthorityQuarantine,
    beforeAuthorityRetirement: value?.beforeAuthorityRetirement,
    processStartIdentity: value?.processStartIdentity ?? ((pid, attemptToken) => readProcessStartIdentity(pid, {
      platform: processPlatform,
      attemptToken,
      environment: value?.processEnvironment ?? process.env,
      spawnProcess: value?.spawnIdentityProbe ?? spawn,
    })),
    now: value?.now ?? Date.now,
    durability: value?.durability,
  })
}

function boundedMutableCacheCleanup(operation, milliseconds) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      rejectPromise(new Error('World FFmpeg mutable package cache cleanup timed out.'))
    }, milliseconds)
    operation.then((value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }, (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
  })
}

async function readProcessStartIdentity(pid, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffff_ffff) return 'unavailable'
  if (platform === 'linux') {
    try {
      const value = await readFile(`/proc/${pid}/stat`, 'utf8')
      const close = value.lastIndexOf(')')
      const fields = value.slice(close + 2).trim().split(/\s+/)
      return /^[0-9]+$/.test(fields[19] ?? '') ? `linux-proc-start:${fields[19]}` : 'unavailable'
    } catch (error) {
      return nodeErrorCode(error) === 'ENOENT' ? null : 'unavailable'
    }
  }
  if (platform === 'darwin') {
    const attemptToken = dependencies.attemptToken
    if (!MUTABLE_CACHE_TOKEN_PATTERN.test(attemptToken)) return 'unavailable'
    const result = await runProcessIdentityProbe('/bin/ps', [
      '-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command=',
    ], Object.freeze({ LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC' }), dependencies)
    if (result.code === 1 && result.stdout.length === 0) return null
    const value = result.stdout.trim().replace(/\s+/g, ' ')
    const match = /^((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}) (.+)$/.exec(value)
    if (result.code !== 0 || result.signal !== null
      || !match
      || !match[2].split(/\s+/).includes(`--world-ffmpeg-attempt=${attemptToken}`)) {
      return 'unavailable'
    }
    return `darwin-ps-start-command:${createHash('sha256').update(`${match[1]}\0${match[2]}`).digest('hex')}`
  }
  if (platform === 'win32') {
    let systemRoot
    try { systemRoot = requireCanonicalWindowsSystemRoot(dependencies.environment ?? process.env) } catch { return 'unavailable' }
    const executable = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const command = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null -eq $p){exit 3};[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`
    const environment = Object.freeze({
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: `${systemRoot}\\System32;${systemRoot}`,
      COMSPEC: `${systemRoot}\\System32\\cmd.exe`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    })
    const result = await runProcessIdentityProbe(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], environment, dependencies)
    if (result.code === 3 && result.stdout.length === 0) return null
    const value = result.stdout.trim()
    return result.code === 0 && result.signal === null && /^[0-9]{1,32}$/.test(value)
      ? `win32-process-start:${value}`
      : 'unavailable'
  }
  return 'unavailable'
}

async function runProcessIdentityProbe(file, args, environment, dependencies) {
  const spawnProcess = dependencies.spawnProcess ?? spawn
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawnProcess(file, args, Object.freeze({
        cwd: platformIdentityProbeCwd(file),
        env: environment,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: Object.freeze(['ignore', 'pipe', 'ignore']),
      }))
    } catch {
      resolvePromise({ code: null, signal: null, stdout: '' })
      return
    }
    let stdout = ''
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise(value)
    }
    child.stdout?.on('data', (chunk) => {
      if (stdout.length + chunk.length > 4096) {
        child.kill?.('SIGKILL')
        finish({ code: null, signal: null, stdout: '' })
      } else stdout += String(chunk)
    })
    child.once('error', () => finish({ code: null, signal: null, stdout: '' }))
    child.once('close', (code, signal) => finish({ code, signal, stdout }))
    timer = setTimeout(() => {
      child.kill?.('SIGKILL')
      finish({ code: null, signal: null, stdout: '' })
    }, 5_000)
  })
}

function platformIdentityProbeCwd(file) {
  return dirname(file)
}

export const _testOnlyReadProcessStartIdentity = readProcessStartIdentity

function packageEnvironment(input) {
  return createWorldFfmpegBuilderEnvironment(input)
}

function requirePackageProcessLifecycle(value, platform) {
  if (value === undefined) return Object.freeze({})
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.signalSource !== undefined
      && (typeof value.signalSource.on !== 'function' || typeof value.signalSource.off !== 'function'))
    || (value.spawnNative !== undefined && typeof value.spawnNative !== 'function')
    || (value.spawnTreeKiller !== undefined && typeof value.spawnTreeKiller !== 'function')
    || (value.killProcessGroup !== undefined && typeof value.killProcessGroup !== 'function')
    || (value.onLateCloseError !== undefined && typeof value.onLateCloseError !== 'function')
    || (value.processGroupId !== undefined
      && (platform === 'win32' || value.processGroupId !== process.pid))) {
    throw new Error('World FFmpeg package process lifecycle is invalid.')
  }
  return Object.freeze({
    signalSource: value.signalSource,
    spawnNative: value.spawnNative,
    spawnTreeKiller: value.spawnTreeKiller,
    killProcessGroup: value.killProcessGroup,
    onLateCloseError: value.onLateCloseError,
    processGroupId: value.processGroupId,
    executionTimeoutMs: value.executionTimeoutMs,
    terminationGraceMs: value.terminationGraceMs,
    closeWaitMs: value.closeWaitMs,
  })
}

function requireOutputCustody(value, environment) {
  if (value !== undefined && typeof value !== 'function') {
    throw new Error('World FFmpeg output custody authority is invalid.')
  }
  return value ?? ((request) => runWorldFfmpegOutputCustody(request, { environment }))
}

function requirePackageArguments(value, target) {
  const authority = PACKAGE_TARGETS[target]
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string' || entry.includes('\0'))
    || !sameArray(value, authority.requestArguments)) {
    throw new Error('World FFmpeg offline package invocation has invalid or unsupported package arguments.')
  }
}

function validateToolLock(value) {
  if (!exactRecord(value, ['schema', 'electronBuilderVersion', 'provenance', 'extractors', 'targets'])
    || value.schema !== 'modly.electron-builder-tool-cache.v1'
    || value.electronBuilderVersion !== '26.15.3'
    || value.provenance !== 'electron-builder-26.15.3-locked-toolset-checksums'
    || !exactRecord(value.extractors, VERIFIED_TOOL_LOCK_TARGETS)
    || !exactRecord(value.targets, VERIFIED_TOOL_LOCK_TARGETS)) return false
  for (const target of VERIFIED_TOOL_LOCK_TARGETS) {
    const entries = value.targets[target]
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16) return false
    let previous = ''
    for (const entry of entries) {
      if (!exactRecord(entry, ['release', 'filename', 'url', 'sha256', 'maximumBytes'])
        || !/^[A-Za-z0-9][A-Za-z0-9@._-]{0,63}$/.test(entry.release)
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.filename)
        || entry.url !== `https://github.com/electron-userland/electron-builder-binaries/releases/download/${entry.release}/${entry.filename}`
        || !SHA256_PATTERN.test(entry.sha256)
        || !Number.isSafeInteger(entry.maximumBytes) || entry.maximumBytes < 1 || entry.maximumBytes > 256 * 1024 * 1024) return false
      const identity = `${entry.release}/${entry.filename}`
      if (identity <= previous) return false
      previous = identity
    }
    const extractor = value.extractors[target]
    const sourceArchive = entries.find((entry) => (
      entry.release === extractor?.source?.release
      && entry.filename === extractor?.source?.filename
    ))
    if (!validateWorldFfmpegExtractorContract(extractor, target)
      || (target !== 'win32-x64' && sourceArchive === undefined)
      || (target === 'win32-x64' && sourceArchive !== undefined)) return false
  }
  return true
}

async function verifyBoundedFile(path, maximumBytes, expectedSha256) {
  let handle
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || info.size < 1 || info.size > maximumBytes) return false
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size !== info.size
      || before.dev !== info.dev || before.ino !== info.ino) return false
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.byteLength
      if (size > maximumBytes) return false
      hash.update(chunk)
    }
    const after = await handle.stat()
    return size === before.size && after.dev === before.dev && after.ino === before.ino
      && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
      && hash.digest('hex') === expectedSha256
  } catch {
    return false
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function sameFileIdentity(left, right) {
  return left.isFile() && right.isFile() && left.nlink === 1 && right.nlink === 1
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function sameStableFile(left, right) {
  return sameFileIdentity(left, right)
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  return sameArray(Object.keys(value).sort(codeUnitCompare), [...keys].sort(codeUnitCompare))
}

function isContained(root, candidate) {
  const suffix = relative(root, candidate)
  return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function requireTarget(value) {
  if (!EXPECTED_TARGETS.includes(value)) throw new Error('World FFmpeg package target is unsupported.')
  return value
}

function sameArray(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function nodeErrorCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : null
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export const WORLD_FFMPEG_PACKAGE_TOOL_LOCK_PATH = DEFAULT_LOCK_PATH
export const WORLD_FFMPEG_OFFLINE_PACKAGE_PRELOAD = DENY_NETWORK_PRELOAD
export function worldFfmpegPackageArguments(target) {
  return [...PACKAGE_TARGETS[requireTarget(target)].requestArguments]
}
export const _testOnlySpawnPackageProcess = spawnWorldFfmpegPackageProcess
export const _testOnlyStartOuterHeartbeat = startOuterHeartbeat
export const _testOnlyRemoveOwnedMutableCacheAuthority = removeOwnedMutableCacheAuthority
export function _testOnlyRetireOwnedPackageDirectory(input, dependencies = {}) {
  return removeExactOwnedDirectory(
    input?.path,
    input?.expectedIdentity,
    {
      durability: dependencies.durability,
      beforeDirectoryQuarantine: dependencies.beforeQuarantine,
      beforeDirectoryRetirement: dependencies.beforeRetirement,
    },
    dependencies.outputCustody ?? runWorldFfmpegOutputCustody,
    input?.label ?? 'test directory',
  )
}
