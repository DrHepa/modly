#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat, mkdir, mkdtemp, open, readlink, readdir,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  quarantineAndReclaimWorldFfmpegDirectory,
  recoverWorldFfmpegOwnedGarbage,
} from './world-ffmpeg-owned-garbage.mjs'
import {
  runWorldFfmpegOutputCustody,
  sameWorldFfmpegOutputDirectoryIdentity,
  sameWorldFfmpegOutputFileReceipt,
} from './world-ffmpeg-output-custody.mjs'

const require = createRequire(import.meta.url)
const INSPECTION_SCHEMA = 'modly.world-ffmpeg-artifact-inspection.v1'
const REQUEST_SCHEMA = 'modly.world-ffmpeg-artifact-inspection-request.v1'
const EXTRACTOR_REQUEST_SCHEMA = 'modly.world-ffmpeg-extractor-request.v1'
const DENY_NETWORK_PRELOAD = fileURLToPath(new URL('./world-ffmpeg-deny-network.cjs', import.meta.url))
const INSPECTOR_PATH = fileURLToPath(import.meta.url)
const PORTABLE_ZIP_PATH = fileURLToPath(new URL('./world-ffmpeg-portable-zip.mjs', import.meta.url))
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_EXTRACTED_ENTRIES = 200_000
const MAX_EXTRACTED_BYTES = 32 * 1024 * 1024 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const EXTRACTOR_EXECUTION = Object.freeze({
  linux: 'proc-self-fd',
  darwin: 'dev-fd',
  win32: 'in-process-portable-zip-v1',
})
const EXTRACTOR_ARCHIVE = Object.freeze({
  linux: '7zip-linux-x64.tar.gz',
  'linux-x64': '7zip-linux-x64.tar.gz',
  'linux-arm64': '7zip-linux-arm64.tar.gz',
  darwin: '7zip-darwin-arm64.tar.gz',
  'darwin-arm64': '7zip-darwin-arm64.tar.gz',
  win32: 'world-ffmpeg-portable-zip.mjs',
})
const TARGETS = Object.freeze({
  'linux-arm64': Object.freeze({ platform: 'linux', arch: 'arm64', suffix: '.AppImage' }),
  'linux-x64': Object.freeze({ platform: 'linux', arch: 'x64', suffix: '.AppImage' }),
  'darwin-arm64': Object.freeze({ platform: 'darwin', arch: 'arm64', suffix: '.dmg' }),
  'win32-x64': Object.freeze({ platform: 'win32', arch: 'x64', suffix: '.zip' }),
})

export async function inspectWorldFfmpegPackageArtifacts(input, dependencies = {}) {
  const request = requireInspectionRequest(input)
  const outputCustody = input.outputCustody ?? runWorldFfmpegOutputCustody
  const before = await outputCustody({
    operation: 'hash',
    directory: request.outputDirectory,
    expectedDirectoryIdentity: request.outputIdentity,
    name: request.artifactName,
    maximumBytes: MAX_ARTIFACT_BYTES,
  })
  const childRequest = deepFreeze({ ...request, artifactReceipt: before.file })
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const executable = dependencies.executable ?? process.execPath
  const environment = inspectorEnvironment(request, input.environment ?? process.env)
  const response = await runInspectorChild(
    spawnProcess,
    executable,
    childRequest,
    request.outputDirectory,
    environment,
  )
  if (!validateInspectionReceipt(response, childRequest)
    || !sameWorldFfmpegOutputFileReceipt(inspectionArtifactFileReceipt(response.artifact), before.file)) {
    throw new Error('World FFmpeg deployable artifact inspector returned an invalid receipt.')
  }
  const after = await outputCustody({
    operation: 'hash',
    directory: request.outputDirectory,
    expectedDirectoryIdentity: request.outputIdentity,
    name: request.artifactName,
    maximumBytes: MAX_ARTIFACT_BYTES,
  })
  if (!sameWorldFfmpegOutputFileReceipt(after.file, inspectionArtifactFileReceipt(response.artifact))) {
    throw new Error('World FFmpeg deployable artifact changed after inspection.')
  }
  return deepFreeze(response)
}

export async function _testOnlyRunPinnedWorldFfmpegExtractor(input, dependencies = {}) {
  const cacheDirectory = requireAbsolute(input?.cacheDirectory, 'extractor cache')
  const info = await lstat(cacheDirectory, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('World FFmpeg extractor cache root is invalid.')
  }
  const request = requireExtractorRequest({
    schema: EXTRACTOR_REQUEST_SCHEMA,
    cacheDirectory,
    cacheIdentity: directoryIdentity(info),
    target: input?.target ?? (input?.platform === 'linux' ? 'linux-x64'
      : input?.platform === 'darwin' ? 'darwin-arm64' : 'win32-x64'),
    platform: input?.platform,
    extractor: input?.extractor,
    arguments: input?.arguments,
  })
  const previousDirectory = process.cwd()
  process.chdir(cacheDirectory)
  try {
    return await executePinnedExtractorRequest(request, dependencies)
  } finally {
    process.chdir(previousDirectory)
  }
}

export async function _testOnlyOpenWorldFfmpegPortableZipAuthority(contract, dependencies = {}) {
  return openWorldFfmpegPortableZipAuthority(requireExtractorContract(contract, 'win32'), dependencies)
}

async function openWorldFfmpegPortableZipAuthority(contract, dependencies = {}) {
  const parserPath = resolve(dependencies.parserPath ?? PORTABLE_ZIP_PATH)
  const hostPlatform = dependencies.platform ?? process.platform
  if (hostPlatform !== 'win32' && hostPlatform !== 'linux' && hostPlatform !== 'darwin') {
    throw new Error('World FFmpeg portable parser host platform is invalid.')
  }
  const modeApplicable = hostPlatform !== 'win32'
  const pathInfo = await lstat(parserPath, { bigint: true })
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n
    || pathInfo.size !== BigInt(contract.size)
    || (modeApplicable && Number(pathInfo.mode & 0o7777n) !== contract.mode)) {
    throw new Error('World FFmpeg portable parser source identity, size, or mode is invalid.')
  }
  const handle = await open(parserPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let primaryError
  try {
    const before = await handle.stat({ bigint: true })
    if (!sameStableFile(pathInfo, before)) {
      throw new Error('World FFmpeg portable parser identity changed before open.')
    }
    const bytes = await readOpenedFile(handle, contract.size)
    if (createHash('sha256').update(bytes).digest('hex') !== contract.sha256) {
      throw new Error('World FFmpeg portable parser digest is invalid.')
    }
    const module = await import(`data:text/javascript;base64,${bytes.toString('base64')}`)
    if (typeof module.createWorldFfmpegPortableZip !== 'function'
      || typeof module.snapshotWorldFfmpegPortableZip !== 'function') {
      throw new Error('World FFmpeg portable parser module contract is invalid.')
    }
    let finalized = false
    return Object.freeze({
      module,
      async finalize() {
        if (finalized) throw new Error('World FFmpeg portable parser authority was finalized more than once.')
        finalized = true
        let finalizeError
        try {
          const [after, publicAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(parserPath, { bigint: true }),
          ])
          if (!sameStableFile(before, after) || !sameStableFile(after, publicAfter)) {
            throw new Error('World FFmpeg portable parser pathname was replaced or its identity changed.')
          }
          const postParse = fileParserIdentity(after, modeApplicable)
          return deepFreeze({
            source: contract.source,
            sha256: contract.sha256,
            size: contract.size,
            mode: modeApplicable ? contract.mode : null,
            modeAuthority: modeApplicable ? 'posix' : 'not-applicable-win32',
            execution: contract.execution,
            dev: String(before.dev),
            ino: String(before.ino),
            preParse: fileParserIdentity(before, modeApplicable),
            postParse,
          })
        } catch (error) {
          finalizeError = error
          throw error
        } finally {
          try { await handle.close() } catch (error) {
            throw new AggregateError(
              finalizeError ? [finalizeError, error] : [error],
              'World FFmpeg portable parser descriptor release failed.',
            )
          }
        }
      },
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (primaryError) {
      try { await handle.close() } catch (error) {
        throw new AggregateError(
          [primaryError, error],
          'World FFmpeg portable parser initialization and descriptor release failed.',
        )
      }
    }
  }
}

function inspectionArtifactFileReceipt(value) {
  return {
    name: value.path,
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    sha256: value.sha256,
  }
}

function requireInspectionRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Object.hasOwn(TARGETS, input.target)
    || input.platform !== TARGETS[input.target].platform
    || input.arch !== TARGETS[input.target].arch
    || !Array.isArray(input.artifacts) || input.artifacts.length < 1 || input.artifacts.length > 64
    || !validAbsolute(input.outputDirectory) || !validAbsolute(input.cacheDirectory)
    || !validAbsolute(input.buildTrustFile) || !validAbsolute(input.buildReportDirectory)
    || !validDirectoryIdentity(input.outputIdentity) || !validDirectoryIdentity(input.cacheIdentity)
    || !validDirectoryIdentity(input.buildReportDirectoryIdentity)
    || !validDirectName(input.buildReportName) || !validFileReceipt(input.buildReportReceipt)
    || input.buildReportReceipt.name !== input.buildReportName
    || !SHA256_PATTERN.test(input.expectedRuntimeManifestSha256 ?? '')) {
    throw new Error('World FFmpeg deployable artifact inspection authority is invalid.')
  }
  const deployables = input.artifacts.filter((name) => (
    validDirectName(name) && name.endsWith(TARGETS[input.target].suffix)
  ))
  if (deployables.length !== 1 || input.artifacts.some((name) => !validDirectName(name))) {
    throw new Error('World FFmpeg package must contain exactly one inspectable deployable artifact.')
  }
  return deepFreeze({
    schema: REQUEST_SCHEMA,
    target: input.target,
    platform: input.platform,
    arch: input.arch,
    artifactName: deployables[0],
    outputDirectory: resolve(input.outputDirectory),
    outputIdentity: input.outputIdentity,
    cacheDirectory: resolve(input.cacheDirectory),
    cacheIdentity: input.cacheIdentity,
    buildTrustFile: resolve(input.buildTrustFile),
    buildReportDirectory: resolve(input.buildReportDirectory),
    buildReportDirectoryIdentity: input.buildReportDirectoryIdentity,
    buildReportName: input.buildReportName,
    buildReportReceipt: input.buildReportReceipt,
    expectedRuntimeManifestSha256: input.expectedRuntimeManifestSha256,
    extractor: requireExtractorContract(input.extractor, input.target),
  })
}

async function runInspectorChild(spawnProcess, executable, request, cwd, environment) {
  if (typeof spawnProcess !== 'function' || !validAbsolute(executable)) {
    throw new Error('World FFmpeg deployable artifact inspector process authority is invalid.')
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawnProcess(executable, [
        `--require=${DENY_NETWORK_PRELOAD}`,
        '--no-warnings',
        '--experimental-strip-types',
        INSPECTOR_PATH,
        '--child',
      ], Object.freeze({
        cwd,
        env: environment,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: Object.freeze(['pipe', 'pipe', 'pipe']),
      }))
    } catch (error) { rejectPromise(error); return }
    let stdout = Buffer.alloc(0)
    let stderr = ''
    let settled = false
    let timer
    const finish = (operation) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      operation()
    }
    child.stdout.on('data', (chunk) => {
      if (stdout.byteLength + chunk.byteLength > MAX_RESPONSE_BYTES) {
        child.kill('SIGKILL')
        finish(() => rejectPromise(new Error('World FFmpeg artifact inspector response exceeded its byte bound.')))
      } else stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_RESPONSE_BYTES) stderr += String(chunk).slice(0, MAX_RESPONSE_BYTES - stderr.length)
    })
    child.once('error', (error) => finish(() => rejectPromise(error)))
    child.once('close', (code, signal) => finish(() => {
      if (code !== 0 || signal !== null) {
        rejectPromise(new Error(stderr.trim() || `World FFmpeg artifact inspector failed: ${signal ?? code ?? 'unknown'}.`))
        return
      }
      try {
        const value = JSON.parse(stdout.toString('utf8'))
        if (!stdout.equals(Buffer.from(`${JSON.stringify(value)}\n`))) throw new Error('noncanonical')
        resolvePromise(value)
      } catch { rejectPromise(new Error('World FFmpeg artifact inspector response is invalid.')) }
    }))
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => rejectPromise(new Error('World FFmpeg artifact inspector timed out.')))
    }, 10 * 60_000)
    child.stdin.end(Buffer.from(`${JSON.stringify(request)}\n`))
  })
}

async function executeInspection(request) {
  if (!validateSerializableRequest(request)) throw new Error('World FFmpeg artifact inspector request is invalid.')
  const cwdInfo = await lstat('.', { bigint: true })
  if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink()
    || !sameDirectoryIdentity(directoryIdentity(cwdInfo), request.outputIdentity)) {
    throw new Error('World FFmpeg artifact inspector output root identity changed.')
  }
  const cache = await runWorldFfmpegOutputCustody({
    operation: 'directory',
    directory: request.cacheDirectory,
    expectedDirectoryIdentity: request.cacheIdentity,
    segments: [],
    environment: process.env,
  })
  if (!sameWorldFfmpegOutputDirectoryIdentity(cache.rootIdentity, request.cacheIdentity)) {
    throw new Error('World FFmpeg artifact inspector cache root identity changed.')
  }
  const garbage = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: request.cacheDirectory,
    minimumAgeMs: 60_000,
    maximumBytes: MAX_EXTRACTED_BYTES,
  })
  if (garbage.pending > 0 || garbage.unclaimed.length > 0 || garbage.failures.length > 0) {
    throw new Error(`World FFmpeg artifact inspector has a concurrent or unclaimed cleanup generation: ${JSON.stringify(garbage)}.`)
  }
  const inspectionRoot = await mkdtemp(join(request.cacheDirectory, `.inspection-${request.target}-`))
  const inspectionInfo = await lstat(inspectionRoot, { bigint: true })
  const inspectionIdentity = directoryIdentity(inspectionInfo)
  let operationError
  let artifactAuthority
  let parserAuthority
  try {
    let extractedRoot
    let packageSnapshot
    let artifact
    let extractor
    if (request.platform === 'win32') {
      artifactAuthority = await openBoundArtifactAuthority(request.artifactName, request)
      parserAuthority = await openWorldFfmpegPortableZipAuthority(request.extractor)
      const portable = await parserAuthority.module.snapshotWorldFfmpegPortableZip({
        artifactHandle: artifactAuthority.handle,
        artifactSize: artifactAuthority.size,
        rootName: 'Modly-win32-x64',
        target: request.target,
      })
      packageSnapshot = portable.snapshot
      extractor = await parserAuthority.finalize()
      parserAuthority = undefined
    } else {
      extractedRoot = join(inspectionRoot, 'extracted-0')
      await mkdir(extractedRoot, { mode: 0o700 })
      const snapshotPath = join(inspectionRoot, 'deployable.artifact')
      artifact = await copyBoundArtifact(request.artifactName, snapshotPath, request)
      if (request.platform === 'linux') {
        await assertWorldFfmpegLinuxArtifactFile(snapshotPath, request.target)
      }
      extractor = await runPinnedExtractorChild(Object.freeze({
        schema: EXTRACTOR_REQUEST_SCHEMA,
        cacheDirectory: request.cacheDirectory,
        cacheIdentity: request.cacheIdentity,
        target: request.target,
        platform: request.platform,
        extractor: request.extractor,
        arguments: Object.freeze(['x', '-bd', '-bb0', '-y', snapshotPath, `-o${extractedRoot}`]),
      }), process.env)
    }
    const resourcesPath = packageSnapshot
      ? request.outputDirectory
      : await findUniqueResourcesRoot(extractedRoot, request.target)
    if (request.target === 'linux-arm64') {
      await assertWorldFfmpegPackagedElectronExecutable(resourcesPath, request.target)
    }
    const resources = packageSnapshot ? null : await runWorldFfmpegOutputCustody({
      operation: 'directory', directory: resourcesPath, segments: [], environment: process.env,
    })
    const { verifyWorldFfmpegPackage } = await import('./verify-world-ffmpeg-package.ts')
    const verification = await verifyWorldFfmpegPackage({
      platform: request.platform,
      arch: request.arch,
      trustFile: request.buildTrustFile,
      resourcesPath,
      ...(resources ? { resourcesIdentity: resources.rootIdentity } : {}),
      buildReportDirectory: request.buildReportDirectory,
      buildReportDirectoryIdentity: request.buildReportDirectoryIdentity,
      buildReportName: request.buildReportName,
      buildReportReceipt: request.buildReportReceipt,
    }, packageSnapshot ? { packageSnapshot } : {})
    if (!verification
      || !sameWorldFfmpegOutputFileReceipt(verification.buildReportReceipt, request.buildReportReceipt)
      || verification.runtimeManifestSha256 !== request.expectedRuntimeManifestSha256) {
      throw new Error('World FFmpeg extracted deployable did not match the verified runtime authority.')
    }
    if (artifactAuthority) {
      artifact = await artifactAuthority.finalize()
      artifactAuthority = undefined
    }
    return deepFreeze({
      schema: INSPECTION_SCHEMA,
      target: request.target,
      artifact: { path: artifact.name, dev: artifact.dev, ino: artifact.ino, size: artifact.size, sha256: artifact.sha256 },
      runtimeManifestSha256: verification.runtimeManifestSha256,
      buildReportSha256: request.buildReportReceipt.sha256,
      extractor,
    })
  } catch (error) {
    operationError = error
    throw error
  } finally {
    const cleanupErrors = []
    if (parserAuthority) {
      await parserAuthority.finalize().catch((error) => cleanupErrors.push(error))
    }
    if (artifactAuthority) {
      await artifactAuthority.finalize().catch((error) => cleanupErrors.push(error))
    }
    try {
      await retireWorldFfmpegInspectionDirectory(inspectionRoot, inspectionIdentity)
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
        'World FFmpeg artifact inspection retirement failed.',
      )
    }
  }
}

async function assertWorldFfmpegLinuxArtifactFile(path, target) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const header = Buffer.alloc(20)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead !== header.length) throw new Error('World FFmpeg AppImage ELF header is truncated.')
    assertWorldFfmpegLinuxArtifactElfHeader(header, target)
  } finally {
    await handle.close()
  }
}

export function assertWorldFfmpegLinuxArtifactElfHeader(header, target) {
  const expectedMachine = target === 'linux-arm64' ? 183 : target === 'linux-x64' ? 62 : null
  if (expectedMachine === null || !(header instanceof Uint8Array) || header.byteLength < 20
    || header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46
    || header[4] !== 2 || header[5] !== 1 || header[6] !== 1
    || (header[18] | (header[19] << 8)) !== expectedMachine) {
    throw new Error('World FFmpeg AppImage ELF architecture is invalid.')
  }
}

export async function assertWorldFfmpegPackagedElectronExecutable(resourcesPath, target) {
  if (target !== 'linux-arm64' || !isAbsolute(resourcesPath)) {
    throw new Error('World FFmpeg Electron executable authority is invalid.')
  }
  // electron-builder's LinuxPackager uses the lowercase sanitized product name
  // when executableName is unset in both pinned builder configs.
  const path = join(dirname(resolve(resourcesPath)), 'modly')
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || (before.mode & 0o111n) === 0n || before.size < 20n) {
    throw new Error('World FFmpeg packaged Electron executable is not an ordinary executable ELF file.')
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameStableFile(before, opened)) {
      throw new Error('World FFmpeg packaged Electron executable identity changed before inspection.')
    }
    const header = Buffer.alloc(20)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead !== header.length) throw new Error('World FFmpeg packaged Electron executable ELF header is truncated.')
    try { assertWorldFfmpegLinuxArtifactElfHeader(header, target) } catch {
      throw new Error('World FFmpeg packaged Electron executable ELF architecture is invalid.')
    }
    const [retained, publicAfter] = await Promise.all([
      handle.stat({ bigint: true }), lstat(path, { bigint: true }),
    ])
    if (!sameStableFile(opened, retained) || !sameStableFile(retained, publicAfter)) {
      throw new Error('World FFmpeg packaged Electron executable identity changed during inspection.')
    }
  } finally {
    await handle.close()
  }
}

async function openBoundArtifactAuthority(name, request) {
  const expected = requestArtifactReceipt(request)
  const pathInfo = await lstat(name, { bigint: true })
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n) {
    throw new Error('World FFmpeg deployable artifact is not an ordinary single-link file.')
  }
  const handle = await open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let primaryError
  try {
    const before = await handle.stat({ bigint: true })
    if (!sameStableFile(pathInfo, before) || before.size !== BigInt(expected.size)) {
      throw new Error('World FFmpeg deployable artifact identity changed before retained parsing.')
    }
    const digest = await hashOpenedFile(handle, expected.size)
    const afterHash = await handle.stat({ bigint: true })
    const receipt = { name, dev: String(before.dev), ino: String(before.ino), size: expected.size, sha256: digest }
    if (!sameStableFile(before, afterHash)
      || !sameWorldFfmpegOutputFileReceipt(receipt, expected)) {
      throw new Error('World FFmpeg deployable artifact digest changed before retained parsing.')
    }
    let finalized = false
    return Object.freeze({
      handle,
      size: expected.size,
      async finalize() {
        if (finalized) throw new Error('World FFmpeg deployable artifact authority was finalized more than once.')
        finalized = true
        let finalizeError
        try {
          const [retained, publicAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(name, { bigint: true }),
          ])
          if (!sameStableFile(before, retained) || !sameStableFile(retained, publicAfter)) {
            throw new Error('World FFmpeg deployable artifact pathname was replaced during retained parsing.')
          }
          return Object.freeze(receipt)
        } catch (error) {
          finalizeError = error
          throw error
        } finally {
          try { await handle.close() } catch (error) {
            throw new AggregateError(
              finalizeError ? [finalizeError, error] : [error],
              'World FFmpeg deployable artifact descriptor release failed.',
            )
          }
        }
      },
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (primaryError) {
      try { await handle.close() } catch (error) {
        throw new AggregateError(
          [primaryError, error],
          'World FFmpeg deployable artifact initialization and descriptor release failed.',
        )
      }
    }
  }
}

async function retireWorldFfmpegInspectionDirectory(path, expectedIdentity, dependencies = {}) {
  if (!validAbsolute(path) || !validDirectoryIdentity(expectedIdentity)
    || (dependencies.beforeRetirement !== undefined && typeof dependencies.beforeRetirement !== 'function')) {
    throw new Error('World FFmpeg artifact inspection retirement authority is invalid.')
  }
  return quarantineAndReclaimWorldFfmpegDirectory({
    path,
    expectedIdentity,
    label: 'artifact-inspection',
    maximumBytes: MAX_EXTRACTED_BYTES,
    afterQuarantine: dependencies.beforeRetirement,
    beforeFileReclaim: dependencies.beforeFileReclaim,
  })
}

export const _testOnlyRetireWorldFfmpegInspectionDirectory = retireWorldFfmpegInspectionDirectory

async function copyBoundArtifact(name, destination, request) {
  let source
  let target
  try {
    const pathInfo = await lstat(name, { bigint: true })
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n
      || pathInfo.size < 1n || pathInfo.size > BigInt(MAX_ARTIFACT_BYTES)) {
      throw new Error('World FFmpeg deployable artifact is not an ordinary bounded file.')
    }
    source = await open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await source.stat({ bigint: true })
    if (!sameStableFile(pathInfo, before)) throw new Error('World FFmpeg deployable artifact identity changed.')
    target = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      size += chunk.byteLength
      if (size > MAX_ARTIFACT_BYTES) throw new Error('World FFmpeg deployable artifact exceeded its byte bound.')
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        const written = await target.write(chunk, offset, chunk.byteLength - offset, null)
        if (written.bytesWritten < 1) throw new Error('World FFmpeg artifact snapshot write made no progress.')
        offset += written.bytesWritten
      }
    }
    await target.sync()
    const after = await source.stat({ bigint: true })
    const pathAfter = await lstat(name, { bigint: true })
    const sha256 = hash.digest('hex')
    const receipt = { name, dev: String(before.dev), ino: String(before.ino), size, sha256 }
    if (!sameStableFile(before, after) || !sameStableFile(before, pathAfter)
      || !sameWorldFfmpegOutputFileReceipt(receipt, requestArtifactReceipt(request))) {
      throw new Error('World FFmpeg deployable artifact changed before inspection snapshot.')
    }
    return receipt
  } finally {
    if (target) await target.close().catch(() => undefined)
    if (source) await source.close().catch(() => undefined)
  }
}

function requestArtifactReceipt(request) {
  return request.artifactReceipt
}

async function runPinnedExtractorChild(request, environment) {
  const required = requireExtractorRequest(request)
  const response = await runCanonicalChild({
    executable: process.execPath,
    arguments: [
      `--require=${DENY_NETWORK_PRELOAD}`,
      '--no-warnings',
      INSPECTOR_PATH,
      '--extractor-child',
    ],
    cwd: required.cacheDirectory,
    environment,
    request: required,
    timeoutMs: 5 * 60_000,
    timeoutMessage: 'Pinned 7zip extraction timed out.',
  })
  if (!validateWorldFfmpegExtractorProof(response, required.extractor)) {
    throw new Error('Pinned 7zip extractor returned an invalid identity receipt.')
  }
  return deepFreeze(response)
}

async function runCanonicalChild(input) {
  const bytes = Buffer.from(`${JSON.stringify(input.request)}\n`)
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(input.executable, input.arguments, {
        cwd: input.cwd,
        env: input.environment,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) { rejectPromise(error); return }
    let stdout = Buffer.alloc(0)
    let stderr = ''
    let settled = false
    let timer
    const finish = (operation) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      operation()
    }
    child.stdout.on('data', (chunk) => {
      if (stdout.byteLength + chunk.byteLength > MAX_RESPONSE_BYTES) {
        child.kill('SIGKILL')
        finish(() => rejectPromise(new Error('Pinned 7zip extractor response exceeded its byte bound.')))
      } else stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_RESPONSE_BYTES) stderr += String(chunk).slice(0, MAX_RESPONSE_BYTES - stderr.length)
    })
    child.once('error', (error) => finish(() => rejectPromise(error)))
    child.once('close', (code, signal) => finish(() => {
      if (code !== 0 || signal !== null) {
        rejectPromise(new Error(stderr.trim() || `Pinned 7zip extraction failed: ${signal ?? code ?? 'unknown'}.`))
        return
      }
      try {
        const value = JSON.parse(stdout.toString('utf8'))
        if (!stdout.equals(Buffer.from(`${JSON.stringify(value)}\n`))) throw new Error('noncanonical')
        resolvePromise(value)
      } catch { rejectPromise(new Error('Pinned 7zip extractor response is invalid.')) }
    }))
    child.stdin.once('error', (error) => finish(() => rejectPromise(error)))
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => rejectPromise(new Error(input.timeoutMessage)))
    }, input.timeoutMs)
    child.stdin.end(bytes)
  })
}

async function executePinnedExtractorRequest(request, dependencies = {}) {
  const required = requireExtractorRequest(request)
  const expectedExecution = EXTRACTOR_EXECUTION[required.platform]
  if (required.extractor.execution !== expectedExecution) {
    throw new Error('Pinned 7zip exact-handle execution is unavailable on this platform.')
  }
  if (required.platform === 'win32') {
    throw new Error('Windows deployable inspection requires the retained in-process portable ZIP parser.')
  }
  const rootInfo = await lstat('.', { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || !sameDirectoryIdentity(directoryIdentity(rootInfo), required.cacheIdentity)) {
    throw new Error('Pinned 7zip cache root identity changed.')
  }
  const resolveExtractor = dependencies.resolveExtractor ?? (async () => {
    const toolset = require('app-builder-lib/out/toolsets/7zip')
    return toolset.getPath7za()
  })
  const spawnProcess = dependencies.spawnProcess ?? spawn
  if (typeof resolveExtractor !== 'function' || typeof spawnProcess !== 'function'
    || (dependencies.beforeSpawn !== undefined && typeof dependencies.beforeSpawn !== 'function')) {
    throw new Error('Pinned 7zip extractor dependencies are invalid.')
  }
  const absolute = resolve(await resolveExtractor())
  const suffix = relative(required.cacheDirectory, absolute)
  const segments = suffix.split(sep)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)
    || segments.length < 2 || !segments.every(validDirectName)) {
    throw new Error('World FFmpeg artifact extractor escaped the owned package cache.')
  }
  const heldDirectories = []
  let extractorHandle
  let operationError
  try {
    for (const segment of segments.slice(0, -1)) {
      const observed = await lstat(segment, { bigint: true })
      if (!observed.isDirectory() || observed.isSymbolicLink()) {
        throw new Error('Pinned 7zip extractor ancestor is not an ordinary directory.')
      }
      const handle = await open(segment, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0))
      const opened = await handle.stat({ bigint: true })
      if (!opened.isDirectory() || !sameDirectoryIdentity(directoryIdentity(observed), directoryIdentity(opened))) {
        await handle.close().catch(() => undefined)
        throw new Error('Pinned 7zip extractor ancestor identity changed.')
      }
      process.chdir(segment)
      const entered = await lstat('.', { bigint: true })
      if (!sameDirectoryIdentity(directoryIdentity(opened), directoryIdentity(entered))) {
        await handle.close().catch(() => undefined)
        throw new Error('Pinned 7zip extractor ancestor changed while entered.')
      }
      heldDirectories.push(Object.freeze({ handle, identity: directoryIdentity(opened) }))
    }
    const name = segments.at(-1)
    const armAlias = required.target === 'linux-arm64' && name === '7za'
    const aliasInfo = armAlias ? await lstat(name, { bigint: true }) : null
    if (armAlias && (!aliasInfo.isSymbolicLink() || aliasInfo.nlink !== 1n
      || await readlink(name) !== '7zz')) {
      throw new Error('Pinned ARM 7zip extractor symlink is invalid.')
    }
    // Upstream's ARM bin/7za is exactly a local alias for bin/7zz. Never follow
    // the alias: retain and execute only the authenticated ordinary target inode.
    const executableName = armAlias ? '7zz' : name
    const pathInfo = armAlias ? await lstat(executableName, { bigint: true }) : await lstat(name, { bigint: true })
    extractorHandle = await open(executableName, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await extractorHandle.stat({ bigint: true })
    if (!sameStableFile(pathInfo, before)
      || Number(before.mode & 0o7777n) !== required.extractor.mode
      || before.size !== BigInt(required.extractor.size)) {
      throw new Error('Pinned 7zip extractor identity, size, or mode is invalid.')
    }
    if (armAlias) {
      const header = Buffer.alloc(20)
      if ((await extractorHandle.read(header, 0, header.byteLength, 0)).bytesRead !== header.byteLength) {
        throw new Error('Pinned ARM 7zip extractor ELF architecture is invalid.')
      }
      try { assertWorldFfmpegLinuxArtifactElfHeader(header, 'linux-arm64') } catch {
        throw new Error('Pinned ARM 7zip extractor ELF architecture is invalid.')
      }
    }
    const digest = await hashOpenedFile(extractorHandle, required.extractor.size)
    const hashed = await extractorHandle.stat({ bigint: true })
    if (!sameStableFile(before, hashed) || digest !== required.extractor.sha256) {
      throw new Error('Pinned 7zip extractor digest or identity changed.')
    }
    const executable = required.platform === 'linux' ? '/proc/self/fd/3' : '/dev/fd/3'
    const preSpawnInfo = await extractorHandle.stat({ bigint: true })
    const preSpawn = fileLaunchIdentity(preSpawnInfo)
    await dependencies.beforeSpawn?.({ executable, identity: preSpawn })
    if (armAlias) await assertPinnedArm7zipAlias(name, aliasInfo)
    await runRetainedExtractorProcess(
      spawnProcess,
      executable,
      required.arguments,
      extractorHandle.fd,
    )
    const postSpawnInfo = await extractorHandle.stat({ bigint: true })
    const postSpawn = fileLaunchIdentity(postSpawnInfo)
    if (!sameStableFile(preSpawnInfo, postSpawnInfo)) {
      throw new Error('Pinned 7zip execution identity changed during execution.')
    }
    const after = await extractorHandle.stat({ bigint: true })
    const pathAfter = await lstat(executableName, { bigint: true })
    if (!sameStableFile(before, after) || !sameStableFile(before, pathAfter)) {
      throw new Error('Pinned 7zip extractor changed during execution.')
    }
    if (armAlias) await assertPinnedArm7zipAlias(name, aliasInfo)
    return deepFreeze({
      source: required.extractor.source,
      sha256: digest,
      size: required.extractor.size,
      mode: required.extractor.mode,
      execution: required.extractor.execution,
      dev: String(before.dev),
      ino: String(before.ino),
      preSpawn,
      postSpawn,
    })
  } catch (error) {
    operationError = error
    throw error
  } finally {
    const cleanupErrors = []
    if (extractorHandle) await extractorHandle.close().catch((error) => cleanupErrors.push(error))
    for (const { handle } of heldDirectories.reverse()) {
      await handle.close().catch((error) => cleanupErrors.push(error))
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
        'Pinned 7zip extractor descriptor retirement failed.',
      )
    }
  }
}

async function hashOpenedFile(handle, expectedSize) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  while (position < expectedSize) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, expectedSize - position), position)
    if (bytesRead < 1) throw new Error('Pinned 7zip extractor ended before its locked size.')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  const extra = Buffer.allocUnsafe(1)
  if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0) {
    throw new Error('Pinned 7zip extractor exceeded its locked size.')
  }
  return hash.digest('hex')
}

async function readOpenedFile(handle, expectedSize) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 1024 * 1024) {
    throw new Error('World FFmpeg portable parser size exceeded its bound.')
  }
  const bytes = Buffer.allocUnsafe(expectedSize)
  let position = 0
  while (position < expectedSize) {
    const { bytesRead } = await handle.read(bytes, position, expectedSize - position, position)
    if (bytesRead < 1) throw new Error('World FFmpeg portable parser ended early.')
    position += bytesRead
  }
  const extra = Buffer.allocUnsafe(1)
  if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0) {
    throw new Error('World FFmpeg portable parser exceeded its locked size.')
  }
  return bytes
}

async function runRetainedExtractorProcess(spawnProcess, file, args, descriptor) {
  await new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawnProcess(file, args, {
        cwd: '.', env: process.env, shell: false, detached: false, windowsHide: true,
        stdio: descriptor === undefined
          ? ['ignore', 'ignore', 'pipe']
          : ['ignore', 'ignore', 'pipe', descriptor],
      })
    } catch (error) { rejectPromise(error); return }
    let stderr = ''
    let settled = false
    let timer
    const finish = (operation) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      operation()
    }
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_RESPONSE_BYTES) stderr += String(chunk).slice(0, MAX_RESPONSE_BYTES - stderr.length)
    })
    child.once('error', (error) => finish(() => rejectPromise(error)))
    child.once('close', (code, signal) => finish(() => (
      code === 0 && signal === null
        ? resolvePromise()
        : rejectPromise(new Error(stderr.trim() || `Pinned 7zip extraction failed: ${signal ?? code ?? 'unknown'}.`))
    )))
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => rejectPromise(new Error('Pinned 7zip extraction timed out.')))
    }, 5 * 60_000)
  })
}

async function findUniqueResourcesRoot(root, target) {
  const stack = [{ path: root, depth: 0 }]
  const matches = []
  let entriesSeen = 0
  let bytesSeen = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (current.depth > 20) throw new Error('Extracted deployable tree exceeds its depth bound.')
    const entries = await readdir(current.path, { withFileTypes: true })
    for (const entry of entries) {
      entriesSeen += 1
      if (entriesSeen > MAX_EXTRACTED_ENTRIES) throw new Error('Extracted deployable tree exceeds its entry bound.')
      const path = join(current.path, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('Extracted deployable tree contains a symbolic link.')
      if (info.isDirectory()) {
        stack.push({ path, depth: current.depth + 1 })
        if (entry.name === 'resources' && await hasRuntimeManifest(path, target)) matches.push(path)
      } else if (info.isFile() && info.nlink === 1) {
        bytesSeen += info.size
        if (!Number.isSafeInteger(bytesSeen) || bytesSeen > MAX_EXTRACTED_BYTES) {
          throw new Error('Extracted deployable tree exceeds its byte bound.')
        }
      } else throw new Error('Extracted deployable tree contains a nonordinary entry.')
    }
  }
  if (matches.length !== 1) throw new Error('Deployable artifact contains no unique packaged resources tree.')
  return matches[0]
}

async function hasRuntimeManifest(resources, target) {
  try {
    const info = await lstat(join(resources, 'ffmpeg', target, 'manifest.json'))
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1
  } catch { return false }
}

function inspectorEnvironment(request, source) {
  const environment = {
    ELECTRON_BUILDER_CACHE: request.cacheDirectory,
    ELECTRON_BUILDER_OFFLINE: 'true',
    ELECTRON_DOWNLOAD_CACHE_MODE: '1',
    ELECTRON_GET_USE_PROXY: 'false',
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC',
    NODE_OPTIONS: `--require=${DENY_NETWORK_PRELOAD}`,
    NPM_CONFIG_OFFLINE: 'true',
    WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE: source.WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE ?? process.execPath,
    WORLD_FFMPEG_PACKAGE_NETWORK: 'denied',
  }
  if (request.platform === 'win32') {
    const roots = Object.entries(source).filter(([key]) => key.toLowerCase() === 'systemroot')
    if (roots.length !== 1 || typeof roots[0][1] !== 'string' || !/^[A-Za-z]:\\Windows$/i.test(roots[0][1])) {
      throw new Error('World FFmpeg artifact inspector Windows authority is invalid.')
    }
    const root = roots[0][1]
    environment.SystemRoot = root
    environment.WINDIR = root
    environment.PATH = `${root}\\System32;${root}`
    environment.COMSPEC = `${root}\\System32\\cmd.exe`
    environment.PATHEXT = '.COM;.EXE;.BAT;.CMD'
  }
  return Object.freeze(environment)
}

function validateSerializableRequest(value) {
  return exactRecord(value, [
    'schema', 'target', 'platform', 'arch', 'artifactName', 'artifactReceipt',
    'outputDirectory', 'outputIdentity', 'cacheDirectory', 'cacheIdentity',
    'buildTrustFile', 'buildReportDirectory', 'buildReportDirectoryIdentity',
    'buildReportName', 'buildReportReceipt', 'expectedRuntimeManifestSha256', 'extractor',
  ]) && value.schema === REQUEST_SCHEMA && Object.hasOwn(TARGETS, value.target)
    && value.platform === TARGETS[value.target].platform && value.arch === TARGETS[value.target].arch
    && validDirectName(value.artifactName) && value.artifactName.endsWith(TARGETS[value.target].suffix)
    && validFileReceipt(value.artifactReceipt) && value.artifactReceipt.name === value.artifactName
    && validAbsolute(value.outputDirectory) && validDirectoryIdentity(value.outputIdentity)
    && validAbsolute(value.cacheDirectory) && validDirectoryIdentity(value.cacheIdentity)
    && validAbsolute(value.buildTrustFile) && validAbsolute(value.buildReportDirectory)
    && validDirectoryIdentity(value.buildReportDirectoryIdentity)
    && validDirectName(value.buildReportName) && validFileReceipt(value.buildReportReceipt)
    && value.buildReportReceipt.name === value.buildReportName
    && SHA256_PATTERN.test(value.expectedRuntimeManifestSha256)
    && validateWorldFfmpegExtractorContract(value.extractor, value.target)
}

function validateInspectionReceipt(value, request) {
  return exactRecord(value, [
    'schema', 'target', 'artifact', 'runtimeManifestSha256', 'buildReportSha256', 'extractor',
  ]) && value.schema === INSPECTION_SCHEMA && value.target === request.target
    && exactRecord(value.artifact, ['path', 'dev', 'ino', 'size', 'sha256'])
    && value.artifact.path === request.artifactName
    && validFileReceipt({
      name: value.artifact.path,
      dev: value.artifact.dev,
      ino: value.artifact.ino,
      size: value.artifact.size,
      sha256: value.artifact.sha256,
    })
    && value.runtimeManifestSha256 === request.expectedRuntimeManifestSha256
    && value.buildReportSha256 === request.buildReportReceipt.sha256
    && validateWorldFfmpegExtractorProof(value.extractor, request.extractor)
}

function requireExtractorRequest(value) {
  if (!exactRecord(value, [
    'schema', 'cacheDirectory', 'cacheIdentity', 'target', 'platform', 'extractor', 'arguments',
  ]) || value.schema !== EXTRACTOR_REQUEST_SCHEMA
    || !validAbsolute(value.cacheDirectory) || !validDirectoryIdentity(value.cacheIdentity)
    || !Object.hasOwn(TARGETS, value.target) || value.platform !== TARGETS[value.target].platform
    || !validateWorldFfmpegExtractorContract(value.extractor, value.target)
    || !Array.isArray(value.arguments) || value.arguments.length > 32
    || value.arguments.some((argument) => typeof argument !== 'string'
      || argument.length > 32 * 1024 || argument.includes('\0') || /[\r\n]/.test(argument))) {
    throw new Error('Pinned 7zip extractor request is invalid.')
  }
  return deepFreeze({
    ...value,
    cacheDirectory: resolve(value.cacheDirectory),
    arguments: Object.freeze([...value.arguments]),
    extractor: deepFreeze(structuredClone(value.extractor)),
  })
}

function requireExtractorContract(value, platform) {
  if (!validateWorldFfmpegExtractorContract(value, platform)) {
    throw new Error('Pinned 7zip extractor contract is invalid.')
  }
  return deepFreeze(structuredClone(value))
}

export function validateWorldFfmpegExtractorContract(value, target) {
  const platform = TARGETS[target]?.platform ?? target
  const expectedExecution = EXTRACTOR_EXECUTION[platform]
  if (platform === 'win32') {
    return exactRecord(value, ['source', 'sha256', 'size', 'mode', 'execution'])
      && exactRecord(value.source, ['release', 'filename', 'member'])
      && value.source.release === 'modly-world-ffmpeg-portable-zip@1'
      && value.source.filename === EXTRACTOR_ARCHIVE.win32
      && value.source.member === 'module'
      && SHA256_PATTERN.test(value.sha256)
      && Number.isSafeInteger(value.size) && value.size >= 1 && value.size <= 1024 * 1024
      && value.mode === 0o644
      && value.execution === expectedExecution
  }
  return exactRecord(value, ['source', 'sha256', 'size', 'mode', 'execution'])
    && exactRecord(value.source, ['release', 'filename', 'member'])
    && value.source.release === '7zip@1.0.0'
    && value.source.filename === EXTRACTOR_ARCHIVE[target]
    && value.source.member === 'bin/7za'
    && SHA256_PATTERN.test(value.sha256)
    && Number.isSafeInteger(value.size) && value.size >= 1 && value.size <= 16 * 1024 * 1024
    && value.mode === 0o755
    && value.execution === expectedExecution
}

export function validateWorldFfmpegExtractorProof(value, contract) {
  if (contract?.execution === EXTRACTOR_EXECUTION.win32) {
    return exactRecord(value, [
      'source', 'sha256', 'size', 'mode', 'modeAuthority', 'execution', 'dev', 'ino', 'preParse', 'postParse',
    ]) && exactRecord(value.source, ['release', 'filename', 'member'])
      && JSON.stringify(value.source) === JSON.stringify(contract.source)
      && value.sha256 === contract.sha256 && value.size === contract.size
      && (value.modeAuthority === 'posix'
        ? value.mode === contract.mode
        : value.modeAuthority === 'not-applicable-win32' && value.mode === null)
      && value.execution === contract.execution
      && /^[0-9]{1,40}$/.test(value.dev) && /^[1-9][0-9]{0,39}$/.test(value.ino)
      && validParserIdentity(value.preParse, contract, value.modeAuthority)
      && validParserIdentity(value.postParse, contract, value.modeAuthority)
      && JSON.stringify(value.preParse) === JSON.stringify(value.postParse)
  }
  return exactRecord(value, [
    'source', 'sha256', 'size', 'mode', 'execution', 'dev', 'ino', 'preSpawn', 'postSpawn',
  ]) && exactRecord(value.source, ['release', 'filename', 'member'])
    && JSON.stringify(value.source) === JSON.stringify(contract.source)
    && value.sha256 === contract.sha256 && value.size === contract.size
    && value.mode === contract.mode && value.execution === contract.execution
    && /^[0-9]{1,40}$/.test(value.dev) && /^[1-9][0-9]{0,39}$/.test(value.ino)
    && validLaunchIdentity(value.preSpawn, contract.size)
    && validLaunchIdentity(value.postSpawn, contract.size)
    && JSON.stringify(value.preSpawn) === JSON.stringify(value.postSpawn)
}

function validParserIdentity(value, contract, modeAuthority) {
  return exactRecord(value, ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'])
    && /^[0-9]{1,40}$/.test(value.dev) && /^[1-9][0-9]{0,39}$/.test(value.ino)
    && value.size === contract.size
    && (modeAuthority === 'posix'
      ? value.mode === contract.mode
      : modeAuthority === 'not-applicable-win32' && value.mode === null)
    && /^[0-9]{1,40}$/.test(value.mtimeNs) && /^[0-9]{1,40}$/.test(value.ctimeNs)
}

function validLaunchIdentity(value, expectedSize) {
  return exactRecord(value, ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'])
    && /^[0-9]{1,40}$/.test(value.dev) && /^[1-9][0-9]{0,39}$/.test(value.ino)
    && value.size === expectedSize
    && /^[0-9]{1,40}$/.test(value.mtimeNs) && /^[0-9]{1,40}$/.test(value.ctimeNs)
}

function validFileReceipt(value) {
  return exactRecord(value, ['name', 'dev', 'ino', 'size', 'sha256'])
    && validDirectName(value.name) && /^[0-9]{1,40}$/.test(value.dev)
    && /^[1-9][0-9]{0,39}$/.test(value.ino)
    && Number.isSafeInteger(value.size) && value.size >= 1 && value.size <= MAX_ARTIFACT_BYTES
    && SHA256_PATTERN.test(value.sha256)
}

function validDirectoryIdentity(value) {
  return exactRecord(value, ['dev', 'ino']) && /^[0-9]{1,40}$/.test(value.dev)
    && /^[1-9][0-9]{0,39}$/.test(value.ino)
}

function validAbsolute(value) {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0') && !/[\r\n]/.test(value)
}

function requireAbsolute(value, label) {
  if (!validAbsolute(value)) throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  return resolve(value)
}

function validDirectName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 255
    && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
    && !value.includes('\0') && !/[\r\n]/.test(value)
}

function directoryIdentity(info) {
  return Object.freeze({ dev: String(info.dev), ino: String(info.ino) })
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function sameStableFile(left, right) {
  return left.isFile() && right.isFile() && left.nlink === 1n && right.nlink === 1n
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function assertPinnedArm7zipAlias(name, before) {
  const after = await lstat(name, { bigint: true })
  if (!before.isSymbolicLink() || !after.isSymbolicLink()
    || before.nlink !== 1n || after.nlink !== 1n
    || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs || await readlink(name) !== '7zz') {
    throw new Error('Pinned ARM 7zip extractor symlink changed during execution.')
  }
}

function fileLaunchIdentity(info) {
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    size: Number(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  })
}

function fileParserIdentity(info, modeApplicable = true) {
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    size: Number(info.size),
    mode: modeApplicable ? Number(info.mode & 0o7777n) : null,
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  })
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

async function readStdin() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.byteLength
    if (size > MAX_RESPONSE_BYTES) throw new Error('World FFmpeg artifact inspector request exceeded its byte bound.')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks, size)
  const value = JSON.parse(bytes.toString('utf8'))
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) throw new Error('World FFmpeg artifact inspector request is noncanonical.')
  return value
}

if (process.argv[1] && resolve(process.argv[1]) === INSPECTOR_PATH
  && (process.argv[2] === '--child' || process.argv[2] === '--extractor-child')) {
  const operation = process.argv[2] === '--child' ? executeInspection : executePinnedExtractorRequest
  void readStdin().then(operation).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg artifact inspection failed.'}\n`)
    process.exitCode = 1
  })
}
