import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { constants, fstatSync, lstatSync, readdirSync, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import trustedManifestKeySource from './world-render-ffmpeg-trusted-keys.json' with { type: 'json' }

declare const __WORLD_FFMPEG_BUILD_TRUST__: unknown

export const WORLD_FFMPEG_RUNTIME_SCHEMA = 'modly.ffmpeg-runtime.v1' as const
export const WORLD_FFMPEG_VERSION = '7.1.1' as const

export const WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS = Object.freeze({
  manifestBytes: 256 * 1024,
  manifestSignatureBytes: 64,
  licenseBytes: 2 * 1024 * 1024,
  executableBytes: 256 * 1024 * 1024,
  sharedLibraryBytes: 128 * 1024 * 1024,
  sharedLibraryTotalBytes: 768 * 1024 * 1024,
  sharedLibraryCount: 128,
} as const)

const MANIFEST_MAX_BYTES = WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.manifestBytes
const MANIFEST_SIGNATURE_BYTES = WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.manifestSignatureBytes
const LICENSE_MAX_BYTES = WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.licenseBytes
const EXECUTABLE_MAX_BYTES = WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.executableBytes
const SHARED_LIBRARY_MAX_BYTES = WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.sharedLibraryBytes
const SHARED_LIBRARY_TOTAL_MAX_BYTES = WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.sharedLibraryTotalBytes
const SHARED_LIBRARY_MAX_COUNT = WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.sharedLibraryCount
const POSIX_DIRECTORY_MODE = 0o755
const POSIX_METADATA_MODE = 0o644
const POSIX_EXECUTABLE_MODE = 0o755
const POSIX_LIBRARY_MODE = 0o644
const ROOT_ENTRIES = Object.freeze(['LICENSE.txt', 'bin', 'manifest.json', 'manifest.sig'])
// FFmpeg 7.1.1 --enable-ffmpeg selects additional filters beyond the seven
// explicit configure flags; this is the exact effective signed closure.
const WORLD_FFMPEG_EFFECTIVE_FILTERS = Object.freeze([
  'aformat', 'anull', 'aresample', 'atrim', 'crop', 'format', 'hflip', 'interleave',
  'null', 'rotate', 'scale', 'setpts', 'settb', 'transpose', 'trim', 'vflip',
  'abuffer', 'buffer', 'abuffersink', 'buffersink',
] as const)

export type WorldFfmpegRuntimeTarget = 'win32-x64' | 'darwin-arm64' | 'linux-arm64' | 'linux-x64'
export type WorldFfmpegTrustedManifestKeys = Readonly<Record<string, string | Buffer>>

// The checked-in map remains the vendor release authority. A recipient or CI
// build may inject exactly one independently generated Ed25519 public key at
// compile time; it trusts only the runtime signed during that same build and
// does not weaken an already-built vendor application.
const compiledBuildTrust = parseCompiledManifestKeys(
  typeof __WORLD_FFMPEG_BUILD_TRUST__ === 'undefined' ? {} : __WORLD_FFMPEG_BUILD_TRUST__,
)
const checkedInTrust = parseCompiledManifestKeys(trustedManifestKeySource)
if (Object.keys(compiledBuildTrust).some((keyId) => Object.prototype.hasOwnProperty.call(checkedInTrust, keyId))) {
  throw new Error('World FFmpeg compiled trust collides with a checked-in release key.')
}
export const WORLD_FFMPEG_TRUSTED_MANIFEST_KEYS: WorldFfmpegTrustedManifestKeys = Object.freeze({
  ...checkedInTrust,
  ...compiledBuildTrust,
})

export interface VerifiedWorldFfmpegRuntime {
  readonly target: WorldFfmpegRuntimeTarget
  readonly rootPath: string
  readonly executablePath: string
  readonly sharedLibraryPaths: readonly string[]
  readonly ffmpegVersion: typeof WORLD_FFMPEG_VERSION
  readonly signingKeyId: string
  readonly manifestSha256: string
}

export interface WorldFfmpegExecutionLease {
  readonly runtime: VerifiedWorldFfmpegRuntime
  spawn<T, TArguments, TOptions>(
    spawnProcess: (executablePath: string, args: TArguments, options: TOptions) => T,
    args: TArguments,
    options: TOptions,
  ): T
  release(): Promise<void>
}

export type WorldFfmpegRuntimeResolution =
  | { readonly ok: true; readonly runtime: VerifiedWorldFfmpegRuntime }
  | { readonly ok: false; readonly code: 'unsupported-target' | 'bundle-missing' | 'bundle-invalid' }

export interface WorldFfmpegRuntimeSnapshotFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly mode: number | null
}

export interface WorldFfmpegRuntimeSnapshot {
  readonly manifestBytes: Uint8Array
  readonly signatureBytes: Uint8Array
  readonly ffmpegRootMode: number | null
  readonly rootMode: number | null
  readonly binMode: number | null
  readonly manifestMode: number | null
  readonly signatureMode: number | null
  readonly rootEntries: readonly string[]
  readonly binEntries: readonly string[]
  readonly files: readonly WorldFfmpegRuntimeSnapshotFile[]
}

export interface WorldFfmpegRuntimeSnapshotPlanFile {
  readonly path: string
  readonly maximumBytes: number
}

interface RuntimeDirectoryManifest {
  readonly path: '.' | 'bin'
  readonly mode: number | null
}

interface RuntimeFileManifest {
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly mode: number | null
}

interface RuntimeManifest {
  readonly schema: typeof WORLD_FFMPEG_RUNTIME_SCHEMA
  readonly target: WorldFfmpegRuntimeTarget
  readonly ffmpegVersion: typeof WORLD_FFMPEG_VERSION
  readonly signingKeyId: string
  readonly build: {
    readonly license: 'LGPL-2.1-or-later'
    readonly linkage: 'shared'
    readonly gpl: false
    readonly nonfree: false
    readonly version3: false
    readonly videoEncoders: readonly ['libvpx-vp9']
    readonly audioEncoders: readonly ['libopus']
    readonly decoders: readonly ['pcm_s16le', 'png']
    readonly demuxers: readonly ['image2pipe', 's16le']
    readonly filters: typeof WORLD_FFMPEG_EFFECTIVE_FILTERS
    readonly muxers: readonly ['webm']
    readonly parsers: readonly ['png']
    readonly protocols: readonly ['fd', 'pipe']
  }
  readonly directories: readonly [RuntimeDirectoryManifest, RuntimeDirectoryManifest]
  readonly license: RuntimeFileManifest
  readonly executable: RuntimeFileManifest
  readonly sharedLibraries: readonly RuntimeFileManifest[]
}

interface FileObservation {
  readonly dev: number
  readonly ino: number
  readonly mode: number
  readonly nlink: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

interface OpenFileBinding {
  readonly path: string
  readonly handle: FileHandle
  readonly observation: FileObservation
}

interface DirectoryBinding {
  readonly path: string
  readonly observation: FileObservation
  readonly expectedMode: number | null
}

interface VerifiedBundle {
  readonly runtime: VerifiedWorldFfmpegRuntime
  readonly fileBindings: readonly OpenFileBinding[]
  readonly directoryBindings: readonly DirectoryBinding[]
  readonly binEntries: readonly string[]
}

export async function resolvePackagedWorldFfmpegRuntime(input: {
  readonly resourcesPath: string
  readonly platform: string
  readonly arch: string
  readonly trustedManifestKeys?: WorldFfmpegTrustedManifestKeys
  readonly snapshot?: WorldFfmpegRuntimeSnapshot
}): Promise<WorldFfmpegRuntimeResolution> {
  const target = supportedTarget(input.platform, input.arch)
  if (!target) return { ok: false, code: 'unsupported-target' }
  if (!input.resourcesPath || input.resourcesPath.includes('\0')) return { ok: false, code: 'bundle-invalid' }

  const resourcesPath = resolve(input.resourcesPath)
  const ffmpegRoot = join(resourcesPath, 'ffmpeg')
  const bundleRoot = join(ffmpegRoot, target)
  if (input.snapshot !== undefined) {
    try {
      return {
        ok: true,
        runtime: verifyRuntimeSnapshot({
          bundleRoot,
          target,
          trustedManifestKeys: input.trustedManifestKeys ?? WORLD_FFMPEG_TRUSTED_MANIFEST_KEYS,
          snapshot: input.snapshot,
        }),
      }
    } catch {
      return { ok: false, code: 'bundle-invalid' }
    }
  }
  try {
    await assertOrdinaryDirectory(ffmpegRoot, target === 'win32-x64' ? null : POSIX_DIRECTORY_MODE)
    await assertOrdinaryDirectory(bundleRoot, target === 'win32-x64' ? null : POSIX_DIRECTORY_MODE)
  } catch (error) {
    return nodeErrorCode(error) === 'ENOENT'
      ? { ok: false, code: 'bundle-missing' }
      : { ok: false, code: 'bundle-invalid' }
  }

  let verified: VerifiedBundle | null = null
  try {
    verified = await verifyRuntimeBundle({
      resourcesPath,
      bundleRoot,
      target,
      trustedManifestKeys: input.trustedManifestKeys ?? WORLD_FFMPEG_TRUSTED_MANIFEST_KEYS,
    })
    return { ok: true, runtime: verified.runtime }
  } catch {
    return { ok: false, code: 'bundle-invalid' }
  } finally {
    if (verified) await closeBindings(verified.fileBindings).catch(() => undefined)
  }
}

export function planPackagedWorldFfmpegRuntimeSnapshot(
  value: Uint8Array,
  target: string,
): readonly WorldFfmpegRuntimeSnapshotPlanFile[] {
  if (!isSupportedRuntimeTarget(target)) {
    throw new Error('Packaged FFmpeg runtime snapshot target is unsupported.')
  }
  const manifestBytes = snapshotBytes(value, MANIFEST_MAX_BYTES)
  let parsedValue: unknown
  try { parsedValue = JSON.parse(manifestBytes.toString('utf8')) } catch {
    throw new Error('Packaged FFmpeg runtime snapshot manifest is invalid.')
  }
  const parsed = parseRuntimeManifest(parsedValue, target)
  if (!parsed || !manifestBytes.equals(Buffer.from(`${JSON.stringify(parsedValue)}\n`))) {
    throw new Error('Packaged FFmpeg runtime snapshot manifest is invalid.')
  }
  return runtimeSnapshotPlanFromManifest(parsed, target)
}

function runtimeSnapshotPlanFromManifest(
  parsed: RuntimeManifest,
  target: WorldFfmpegRuntimeTarget,
): readonly WorldFfmpegRuntimeSnapshotPlanFile[] {
  const expectedDirectoryMode = target === 'win32-x64' ? null : POSIX_DIRECTORY_MODE
  const expectedMetadataMode = target === 'win32-x64' ? null : POSIX_METADATA_MODE
  const expectedExecutableMode = target === 'win32-x64' ? null : POSIX_EXECUTABLE_MODE
  const expectedLibraryMode = target === 'win32-x64' ? null : POSIX_LIBRARY_MODE
  if (parsed.directories[0].path !== '.' || parsed.directories[0].mode !== expectedDirectoryMode
    || parsed.directories[1].path !== 'bin' || parsed.directories[1].mode !== expectedDirectoryMode
    || parsed.license.path !== 'LICENSE.txt' || parsed.license.mode !== expectedMetadataMode
    || parsed.license.size > LICENSE_MAX_BYTES
    || parsed.executable.path !== (target === 'win32-x64' ? 'bin/ffmpeg.exe' : 'bin/ffmpeg')
    || parsed.executable.mode !== expectedExecutableMode
    || parsed.executable.size > EXECUTABLE_MAX_BYTES) {
    throw new Error('Packaged FFmpeg runtime snapshot manifest layout is invalid.')
  }
  let libraryBytes = 0
  for (const library of parsed.sharedLibraries) {
    libraryBytes += library.size
    if (library.mode !== expectedLibraryMode || !isSharedLibraryName(library.path, target)
      || library.size > SHARED_LIBRARY_MAX_BYTES || libraryBytes > SHARED_LIBRARY_TOTAL_MAX_BYTES) {
      throw new Error('Packaged FFmpeg runtime snapshot manifest library layout is invalid.')
    }
  }
  return Object.freeze([
    Object.freeze({ path: parsed.license.path, maximumBytes: LICENSE_MAX_BYTES }),
    Object.freeze({ path: parsed.executable.path, maximumBytes: EXECUTABLE_MAX_BYTES }),
    ...parsed.sharedLibraries.map((library) => Object.freeze({
      path: library.path,
      maximumBytes: SHARED_LIBRARY_MAX_BYTES,
    })),
  ])
}

function verifyRuntimeSnapshot(input: {
  readonly bundleRoot: string
  readonly target: WorldFfmpegRuntimeTarget
  readonly trustedManifestKeys: WorldFfmpegTrustedManifestKeys
  readonly snapshot: WorldFfmpegRuntimeSnapshot
}): VerifiedWorldFfmpegRuntime {
  const record = exactRecord(input.snapshot, [
    'manifestBytes', 'signatureBytes', 'ffmpegRootMode', 'rootMode', 'binMode',
    'manifestMode', 'signatureMode',
    'rootEntries', 'binEntries', 'files',
  ])
  if (!record) throw new Error('Packaged FFmpeg runtime snapshot is invalid.')
  const manifestBytes = snapshotBytes(record.manifestBytes, MANIFEST_MAX_BYTES)
  const signatureBytes = snapshotBytes(record.signatureBytes, MANIFEST_SIGNATURE_BYTES)
  if (signatureBytes.byteLength !== MANIFEST_SIGNATURE_BYTES) {
    throw new Error('Packaged FFmpeg runtime snapshot signature is invalid.')
  }
  let parsedValue: unknown
  try { parsedValue = JSON.parse(manifestBytes.toString('utf8')) } catch {
    throw new Error('Packaged FFmpeg runtime snapshot manifest is invalid.')
  }
  const parsed = parseRuntimeManifest(parsedValue, input.target)
  if (!parsed || !manifestBytes.equals(Buffer.from(`${JSON.stringify(parsedValue)}\n`))) {
    throw new Error('Packaged FFmpeg runtime snapshot manifest is invalid.')
  }
  const trustedKey = ownManifestKey(input.trustedManifestKeys, parsed.signingKeyId)
  if (!trustedKey || !verifySignature(null, manifestBytes, trustedKey, signatureBytes)) {
    throw new Error('Packaged FFmpeg runtime snapshot signature is not trusted.')
  }
  const expectedDirectoryMode = input.target === 'win32-x64' ? null : POSIX_DIRECTORY_MODE
  const expectedMetadataMode = input.target === 'win32-x64' ? null : POSIX_METADATA_MODE
  const expectedExecutableMode = input.target === 'win32-x64' ? null : POSIX_EXECUTABLE_MODE
  const expectedLibraryMode = input.target === 'win32-x64' ? null : POSIX_LIBRARY_MODE
  runtimeSnapshotPlanFromManifest(parsed, input.target)
  if (parsed.directories[0].path !== '.' || parsed.directories[0].mode !== expectedDirectoryMode
    || parsed.directories[1].path !== 'bin' || parsed.directories[1].mode !== expectedDirectoryMode
    || record.ffmpegRootMode !== expectedDirectoryMode
    || record.rootMode !== expectedDirectoryMode || record.binMode !== expectedDirectoryMode
    || record.manifestMode !== expectedMetadataMode || record.signatureMode !== expectedMetadataMode
    || parsed.license.path !== 'LICENSE.txt' || parsed.license.mode !== expectedMetadataMode
    || parsed.executable.path !== (input.target === 'win32-x64' ? 'bin/ffmpeg.exe' : 'bin/ffmpeg')
    || parsed.executable.mode !== expectedExecutableMode) {
    throw new Error('Packaged FFmpeg runtime snapshot modes or paths are invalid.')
  }
  if (!exactStringTuple(record.rootEntries, ROOT_ENTRIES)) {
    throw new Error('Packaged FFmpeg runtime snapshot root closure is invalid.')
  }
  const expectedBinEntries = [
    basename(parsed.executable.path),
    ...parsed.sharedLibraries.map((entry) => basename(entry.path)),
  ].sort(codeUnitCompare)
  if (!exactStringTuple(record.binEntries, expectedBinEntries)
    || !Array.isArray(record.files)
    || record.files.length !== parsed.sharedLibraries.length + 2) {
    throw new Error('Packaged FFmpeg runtime snapshot file closure is invalid.')
  }
  const files = new Map<string, WorldFfmpegRuntimeSnapshotFile>()
  for (const raw of record.files) {
    const file = parseRuntimeSnapshotFile(raw)
    if (!file || files.has(file.path)) {
      throw new Error('Packaged FFmpeg runtime snapshot file receipt is invalid.')
    }
    files.set(file.path, file)
  }
  requireRuntimeSnapshotFile(files, parsed.license, LICENSE_MAX_BYTES, expectedMetadataMode)
  requireRuntimeSnapshotFile(files, parsed.executable, EXECUTABLE_MAX_BYTES, expectedExecutableMode)
  let totalLibraryBytes = 0
  for (const library of parsed.sharedLibraries) {
    if (!isSharedLibraryName(library.path, input.target) || library.mode !== expectedLibraryMode) {
      throw new Error('Packaged FFmpeg runtime snapshot library is invalid.')
    }
    totalLibraryBytes += library.size
    if (totalLibraryBytes > SHARED_LIBRARY_TOTAL_MAX_BYTES) {
      throw new Error('Packaged FFmpeg runtime snapshot libraries exceed their bound.')
    }
    requireRuntimeSnapshotFile(files, library, SHARED_LIBRARY_MAX_BYTES, expectedLibraryMode)
  }
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  return Object.freeze({
    target: input.target,
    rootPath: input.bundleRoot,
    executablePath: join(input.bundleRoot, parsed.executable.path),
    sharedLibraryPaths: Object.freeze(parsed.sharedLibraries.map((entry) => join(input.bundleRoot, entry.path))),
    ffmpegVersion: parsed.ffmpegVersion,
    signingKeyId: parsed.signingKeyId,
    manifestSha256,
  })
}

function snapshotBytes(value: unknown, maximumBytes: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximumBytes) {
    throw new Error('Packaged FFmpeg runtime snapshot bytes are invalid.')
  }
  return Buffer.from(value)
}

function parseRuntimeSnapshotFile(value: unknown): WorldFfmpegRuntimeSnapshotFile | null {
  const record = exactRecord(value, ['path', 'size', 'sha256', 'mode'])
  if (!record || typeof record.path !== 'string' || !isSafeBundleFilePath(record.path)
    || !Number.isSafeInteger(record.size) || Number(record.size) < 1
    || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)
    || (record.mode !== null && (!Number.isSafeInteger(record.mode)
      || Number(record.mode) < 0 || Number(record.mode) > 0o7777))) return null
  return Object.freeze({
    path: record.path,
    size: Number(record.size),
    sha256: record.sha256,
    mode: record.mode === null ? null : Number(record.mode),
  })
}

function requireRuntimeSnapshotFile(
  files: ReadonlyMap<string, WorldFfmpegRuntimeSnapshotFile>,
  expected: RuntimeFileManifest,
  maximumBytes: number,
  expectedMode: number | null,
): void {
  const actual = files.get(expected.path)
  if (!actual || expected.size > maximumBytes || actual.size !== expected.size
    || actual.sha256 !== expected.sha256 || actual.mode !== expectedMode
    || expected.mode !== expectedMode) {
    throw new Error('Packaged FFmpeg runtime snapshot file does not match its manifest.')
  }
}

export async function acquireWorldFfmpegExecutionLease(input: {
  readonly runtime: VerifiedWorldFfmpegRuntime
  readonly trustedManifestKeys?: WorldFfmpegTrustedManifestKeys
}): Promise<WorldFfmpegExecutionLease> {
  const { runtime } = input
  if (!isSupportedRuntimeTarget(runtime.target)) {
    throw new Error('Packaged FFmpeg runtime has an unsupported target.')
  }
  if (basename(runtime.rootPath) !== runtime.target || basename(dirname(runtime.rootPath)) !== 'ffmpeg') {
    throw new Error('Packaged FFmpeg runtime identity is invalid.')
  }
  const ffmpegRoot = dirname(runtime.rootPath)
  const resourcesPath = dirname(ffmpegRoot)
  const verified = await verifyRuntimeBundle({
    resourcesPath,
    bundleRoot: runtime.rootPath,
    target: runtime.target,
    trustedManifestKeys: input.trustedManifestKeys ?? WORLD_FFMPEG_TRUSTED_MANIFEST_KEYS,
  })
  if (!sameRuntimeIdentity(runtime, verified.runtime)) {
    await closeBindings(verified.fileBindings).catch(() => undefined)
    throw new Error('Packaged FFmpeg runtime changed before execution.')
  }
  return createExecutionLease(verified)
}

async function verifyRuntimeBundle(input: {
  readonly resourcesPath: string
  readonly bundleRoot: string
  readonly target: WorldFfmpegRuntimeTarget
  readonly trustedManifestKeys: WorldFfmpegTrustedManifestKeys
}): Promise<VerifiedBundle> {
  const { target } = input
  const resourcesPath = resolve(input.resourcesPath)
  const ffmpegRoot = join(resourcesPath, 'ffmpeg')
  const bundleRoot = resolve(input.bundleRoot)
  if (bundleRoot !== join(ffmpegRoot, target)) throw new Error('Packaged FFmpeg target path is invalid.')
  const directoryMode = target === 'win32-x64' ? null : POSIX_DIRECTORY_MODE
  const metadataMode = target === 'win32-x64' ? null : POSIX_METADATA_MODE
  const fileBindings: OpenFileBinding[] = []
  try {
    const realResourcesPath = await realpath(resourcesPath)
    const realFfmpegRoot = await realpath(ffmpegRoot)
    const realBundleRoot = await realpath(bundleRoot)
    assertContained(realResourcesPath, realFfmpegRoot)
    assertContained(realFfmpegRoot, realBundleRoot)

    const ffmpegObservation = await observeOrdinaryDirectory(ffmpegRoot, directoryMode)
    const bundleObservation = await observeOrdinaryDirectory(bundleRoot, directoryMode)
    const manifest = await openVerifiedFile(join(bundleRoot, 'manifest.json'), MANIFEST_MAX_BYTES, metadataMode, true)
    fileBindings.push(manifest.binding)
    const parsedValue: unknown = JSON.parse(manifest.bytes.toString('utf8'))
    const parsed = parseRuntimeManifest(parsedValue, target)
    if (!parsed || !manifest.bytes.equals(Buffer.from(`${JSON.stringify(parsedValue)}\n`))) {
      throw new Error('Packaged FFmpeg manifest is not exact canonical JSON.')
    }
    const manifestSha256 = createHash('sha256').update(manifest.bytes).digest('hex')
    const signature = await openVerifiedFile(
      join(bundleRoot, 'manifest.sig'),
      MANIFEST_SIGNATURE_BYTES,
      metadataMode,
      true,
    )
    fileBindings.push(signature.binding)
    if (signature.bytes.byteLength !== MANIFEST_SIGNATURE_BYTES) {
      throw new Error('Packaged FFmpeg manifest signature has an invalid size.')
    }
    const trustedKey = ownManifestKey(input.trustedManifestKeys, parsed.signingKeyId)
    if (!trustedKey || !verifySignature(null, manifest.bytes, trustedKey, signature.bytes)) {
      throw new Error('Packaged FFmpeg manifest signature is not trusted.')
    }

    const expectedDirectoryMode = target === 'win32-x64' ? null : POSIX_DIRECTORY_MODE
    if (parsed.directories[0].path !== '.' || parsed.directories[0].mode !== expectedDirectoryMode
      || parsed.directories[1].path !== 'bin' || parsed.directories[1].mode !== expectedDirectoryMode) {
      throw new Error('Packaged FFmpeg directory closure is invalid.')
    }
    const binPath = join(bundleRoot, 'bin')
    const binObservation = await observeOrdinaryDirectory(binPath, directoryMode)

    const expectedExecutablePath = target === 'win32-x64' ? 'bin/ffmpeg.exe' : 'bin/ffmpeg'
    if (parsed.executable.path !== expectedExecutablePath) throw new Error('Packaged FFmpeg executable path is invalid.')
    const expectedExecutableMode = target === 'win32-x64' ? null : POSIX_EXECUTABLE_MODE
    if (parsed.executable.mode !== expectedExecutableMode) throw new Error('Packaged FFmpeg executable mode is invalid.')
    if (parsed.license.path !== 'LICENSE.txt' || parsed.license.mode !== metadataMode) {
      throw new Error('Packaged FFmpeg license identity is invalid.')
    }

    const binEntries = [
      basename(parsed.executable.path),
      ...parsed.sharedLibraries.map((entry) => basename(entry.path)),
    ].sort(codeUnitCompare)
    await assertExactDirectoryEntries(bundleRoot, ROOT_ENTRIES)
    await assertExactDirectoryEntries(binPath, binEntries)

    const license = await verifyManifestFile(bundleRoot, realBundleRoot, parsed.license, LICENSE_MAX_BYTES, target, 'license')
    fileBindings.push(license.binding)
    const executable = await verifyManifestFile(
      bundleRoot,
      realBundleRoot,
      parsed.executable,
      EXECUTABLE_MAX_BYTES,
      target,
      'executable',
    )
    fileBindings.push(executable.binding)
    let totalLibraryBytes = 0
    const sharedLibraryPaths: string[] = []
    for (const entry of parsed.sharedLibraries) {
      totalLibraryBytes += entry.size
      if (totalLibraryBytes > SHARED_LIBRARY_TOTAL_MAX_BYTES) throw new Error('Packaged FFmpeg libraries exceed their bound.')
      const library = await verifyManifestFile(
        bundleRoot,
        realBundleRoot,
        entry,
        SHARED_LIBRARY_MAX_BYTES,
        target,
        'library',
      )
      fileBindings.push(library.binding)
      sharedLibraryPaths.push(library.binding.path)
    }

    const runtime: VerifiedWorldFfmpegRuntime = Object.freeze({
      target,
      rootPath: bundleRoot,
      executablePath: executable.binding.path,
      sharedLibraryPaths: Object.freeze(sharedLibraryPaths),
      ffmpegVersion: parsed.ffmpegVersion,
      signingKeyId: parsed.signingKeyId,
      manifestSha256,
    })
    return {
      runtime,
      fileBindings: Object.freeze(fileBindings),
      directoryBindings: Object.freeze([
        { path: ffmpegRoot, observation: ffmpegObservation, expectedMode: directoryMode },
        { path: bundleRoot, observation: bundleObservation, expectedMode: directoryMode },
        { path: binPath, observation: binObservation, expectedMode: directoryMode },
      ]),
      binEntries: Object.freeze(binEntries),
    }
  } catch (error) {
    await closeBindings(fileBindings).catch(() => undefined)
    throw error
  }
}

function createExecutionLease(verified: VerifiedBundle): WorldFfmpegExecutionLease {
  let released = false
  let used = false
  return {
    runtime: verified.runtime,
    spawn<T, TArguments, TOptions>(
      spawnProcess: (executablePath: string, args: TArguments, options: TOptions) => T,
      args: TArguments,
      options: TOptions,
    ): T {
      if (released || used) throw new Error('Packaged FFmpeg execution lease is unavailable.')
      used = true
      try {
        assertExactDirectoryEntriesSync(verified.runtime.rootPath, ROOT_ENTRIES)
        assertExactDirectoryEntriesSync(join(verified.runtime.rootPath, 'bin'), verified.binEntries)
        for (const binding of verified.directoryBindings) assertDirectoryBindingSync(binding)
        for (const binding of verified.fileBindings) assertFileBindingSync(binding)
      } catch {
        throw new Error('Packaged FFmpeg runtime changed before spawn.')
      }
      // No await or application callback is permitted between final custody
      // validation and the injected direct spawn. Same-user mutation after this
      // linearization point remains an operating-system/package custody limit.
      return spawnProcess(verified.runtime.executablePath, args, options)
    },
    async release(): Promise<void> {
      if (released) return
      released = true
      await closeBindings(verified.fileBindings)
    },
  }
}

function supportedTarget(platform: string, arch: string): WorldFfmpegRuntimeTarget | null {
  const candidate = `${platform}-${arch}`
  return isSupportedRuntimeTarget(candidate) ? candidate : null
}

function isSupportedRuntimeTarget(value: string): value is WorldFfmpegRuntimeTarget {
  return value === 'win32-x64' || value === 'darwin-arm64' || value === 'linux-arm64' || value === 'linux-x64'
}

function parseRuntimeManifest(value: unknown, target: WorldFfmpegRuntimeTarget): RuntimeManifest | null {
  const record = exactRecord(value, [
    'schema', 'target', 'ffmpegVersion', 'signingKeyId', 'build', 'directories',
    'license', 'executable', 'sharedLibraries',
  ])
  if (!record || record.schema !== WORLD_FFMPEG_RUNTIME_SCHEMA || record.target !== target
    || record.ffmpegVersion !== WORLD_FFMPEG_VERSION
    || typeof record.signingKeyId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(record.signingKeyId)) return null
  const build = exactRecord(record.build, [
    'license', 'linkage', 'gpl', 'nonfree', 'version3', 'videoEncoders', 'audioEncoders',
    'decoders', 'demuxers', 'filters', 'muxers', 'parsers', 'protocols',
  ])
  if (!build || build.license !== 'LGPL-2.1-or-later' || build.linkage !== 'shared'
    || build.gpl !== false || build.nonfree !== false || build.version3 !== false
    || !exactStringTuple(build.videoEncoders, ['libvpx-vp9'])
    || !exactStringTuple(build.audioEncoders, ['libopus'])
    || !exactStringTuple(build.decoders, ['pcm_s16le', 'png'])
    || !exactStringTuple(build.demuxers, ['image2pipe', 's16le'])
    || !exactStringTuple(build.filters, WORLD_FFMPEG_EFFECTIVE_FILTERS)
    || !exactStringTuple(build.muxers, ['webm'])
    || !exactStringTuple(build.parsers, ['png'])
    || !exactStringTuple(build.protocols, ['fd', 'pipe'])) return null
  const directories = parseDirectoryManifest(record.directories)
  const license = parseFileManifest(record.license)
  const executable = parseFileManifest(record.executable)
  if (!directories || !license || !executable || !Array.isArray(record.sharedLibraries)
    || record.sharedLibraries.length < 1 || record.sharedLibraries.length > SHARED_LIBRARY_MAX_COUNT) return null
  const sharedLibraries: RuntimeFileManifest[] = []
  let previousPath = ''
  for (const entryValue of record.sharedLibraries) {
    const entry = parseFileManifest(entryValue)
    if (!entry || entry.path <= previousPath || entry.path === executable.path || entry.path === license.path) return null
    previousPath = entry.path
    sharedLibraries.push(entry)
  }
  return {
    schema: WORLD_FFMPEG_RUNTIME_SCHEMA,
    target,
    ffmpegVersion: record.ffmpegVersion,
    signingKeyId: record.signingKeyId,
    build: {
      license: 'LGPL-2.1-or-later', linkage: 'shared', gpl: false, nonfree: false, version3: false,
      videoEncoders: ['libvpx-vp9'], audioEncoders: ['libopus'],
      decoders: ['pcm_s16le', 'png'], demuxers: ['image2pipe', 's16le'],
      filters: WORLD_FFMPEG_EFFECTIVE_FILTERS,
      muxers: ['webm'], parsers: ['png'], protocols: ['fd', 'pipe'],
    },
    directories,
    license,
    executable,
    sharedLibraries,
  }
}

function parseDirectoryManifest(value: unknown): RuntimeManifest['directories'] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const entries: RuntimeDirectoryManifest[] = []
  let previousPath = ''
  for (const raw of value) {
    const record = exactRecord(raw, ['path', 'mode'])
    if (!record || (record.path !== '.' && record.path !== 'bin') || String(record.path) <= previousPath
      || (record.mode !== null && (!Number.isSafeInteger(record.mode) || Number(record.mode) < 0 || Number(record.mode) > 0o7777))) return null
    previousPath = String(record.path)
    entries.push({ path: record.path, mode: record.mode === null ? null : Number(record.mode) })
  }
  return entries as unknown as RuntimeManifest['directories']
}

function parseFileManifest(value: unknown): RuntimeFileManifest | null {
  const record = exactRecord(value, ['path', 'size', 'sha256', 'mode'])
  if (!record || typeof record.path !== 'string' || !isSafeBundleFilePath(record.path)
    || !Number.isSafeInteger(record.size) || Number(record.size) < 1
    || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)
    || (record.mode !== null && (!Number.isSafeInteger(record.mode) || Number(record.mode) < 0 || Number(record.mode) > 0o7777))) return null
  return {
    path: record.path,
    size: Number(record.size),
    sha256: record.sha256,
    mode: record.mode === null ? null : Number(record.mode),
  }
}

async function verifyManifestFile(
  bundleRoot: string,
  realBundleRoot: string,
  entry: RuntimeFileManifest,
  maximumBytes: number,
  target: WorldFfmpegRuntimeTarget,
  role: 'license' | 'executable' | 'library',
): Promise<{ binding: OpenFileBinding }> {
  if (entry.size > maximumBytes) throw new Error('Packaged FFmpeg file exceeds its bound.')
  if (role === 'library') {
    if (entry.mode !== (target === 'win32-x64' ? null : POSIX_LIBRARY_MODE)
      || !isSharedLibraryName(entry.path, target)) throw new Error('Packaged FFmpeg shared library manifest is invalid.')
  }
  const path = resolve(bundleRoot, entry.path)
  assertContained(bundleRoot, path)
  await assertNoSymlinkDescendants(bundleRoot, entry.path)
  const realPath = await realpath(path)
  assertContained(realBundleRoot, realPath)
  const inspected = await openVerifiedFile(path, maximumBytes, entry.mode, false)
  if (inspected.binding.observation.size !== entry.size || inspected.sha256 !== entry.sha256) {
    await inspected.binding.handle.close().catch(() => undefined)
    throw new Error('Packaged FFmpeg file identity does not match its manifest.')
  }
  return { binding: inspected.binding }
}

async function openVerifiedFile(
  path: string,
  maximumBytes: number,
  expectedMode: number | null,
  retainBytes: boolean,
): Promise<{ binding: OpenFileBinding; bytes: Buffer; sha256: string }> {
  const pathInfo = await lstat(path)
  assertOrdinaryFileStats(pathInfo, maximumBytes, expectedMode)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    assertOrdinaryFileStats(before, maximumBytes, expectedMode)
    if (!sameFileIdentity(observeStats(pathInfo), observeStats(before), false)) {
      throw new Error('Packaged FFmpeg file changed before verification.')
    }
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      const bytes = Buffer.from(chunk as Buffer)
      size += bytes.byteLength
      if (size > maximumBytes) throw new Error('Packaged FFmpeg file grew beyond its bound.')
      hash.update(bytes)
      if (retainBytes) chunks.push(bytes)
    }
    const after = await handle.stat()
    assertOrdinaryFileStats(after, maximumBytes, expectedMode)
    const observation = observeStats(after)
    if (size !== before.size || !sameFileIdentity(observeStats(before), observation, true)) {
      throw new Error('Packaged FFmpeg file changed while verifying it.')
    }
    return {
      binding: { path, handle, observation },
      bytes: retainBytes ? Buffer.concat(chunks, size) : Buffer.alloc(0),
      sha256: hash.digest('hex'),
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function assertNoSymlinkDescendants(root: string, manifestPath: string): Promise<void> {
  const segments = manifestPath.split('/')
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error('Packaged FFmpeg runtime contains a symbolic link.')
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error('Packaged FFmpeg runtime parent is not a directory.')
    }
  }
}

async function assertOrdinaryDirectory(path: string, expectedMode: number | null): Promise<void> {
  await observeOrdinaryDirectory(path, expectedMode)
}

async function observeOrdinaryDirectory(path: string, expectedMode: number | null): Promise<FileObservation> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Packaged FFmpeg directory is not ordinary.')
  assertExactMode(info, expectedMode)
  return observeStats(info)
}

async function assertExactDirectoryEntries(path: string, expected: readonly string[]): Promise<void> {
  const entries = (await readdir(path)).sort(codeUnitCompare)
  if (!exactStringTuple(entries, [...expected].sort(codeUnitCompare))) {
    throw new Error('Packaged FFmpeg runtime tree contains undeclared entries.')
  }
}

function assertExactDirectoryEntriesSync(path: string, expected: readonly string[]): void {
  const entries = readdirSync(path).sort(codeUnitCompare)
  if (!exactStringTuple(entries, [...expected].sort(codeUnitCompare))) {
    throw new Error('Packaged FFmpeg runtime tree changed before spawn.')
  }
}

function assertDirectoryBindingSync(binding: DirectoryBinding): void {
  const info = lstatSync(binding.path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Packaged FFmpeg directory changed before spawn.')
  assertExactMode(info, binding.expectedMode)
  if (!sameFileIdentity(binding.observation, observeStats(info), true)) {
    throw new Error('Packaged FFmpeg directory changed before spawn.')
  }
}

function assertFileBindingSync(binding: OpenFileBinding): void {
  const descriptorInfo = fstatSync(binding.handle.fd)
  const pathInfo = lstatSync(binding.path)
  assertOrdinaryFileStats(descriptorInfo, binding.observation.size, modeBits(binding.observation))
  assertOrdinaryFileStats(pathInfo, binding.observation.size, modeBits(binding.observation))
  const descriptorObservation = observeStats(descriptorInfo)
  const pathObservation = observeStats(pathInfo)
  if (!sameFileIdentity(binding.observation, descriptorObservation, true)
    || !sameFileIdentity(descriptorObservation, pathObservation, true)) {
    throw new Error('Packaged FFmpeg file changed before spawn.')
  }
}

function assertOrdinaryFileStats(info: Stats, maximumBytes: number, expectedMode: number | null): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximumBytes) {
    throw new Error('Packaged FFmpeg file is not ordinary or bounded.')
  }
  assertExactMode(info, expectedMode)
}

function assertExactMode(info: Stats, expectedMode: number | null): void {
  if (expectedMode !== null && (info.mode & 0o7777) !== expectedMode) {
    throw new Error('Packaged FFmpeg entry mode does not match its manifest.')
  }
}

function modeBits(observation: FileObservation): number {
  return observation.mode & 0o7777
}

function observeStats(info: Stats): FileObservation {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  }
}

function sameFileIdentity(left: FileObservation, right: FileObservation, includeMutationTimes: boolean): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && (!includeMutationTimes || (left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs))
}

function sameRuntimeIdentity(left: VerifiedWorldFfmpegRuntime, right: VerifiedWorldFfmpegRuntime): boolean {
  return left.target === right.target && left.rootPath === right.rootPath
    && left.executablePath === right.executablePath && left.ffmpegVersion === right.ffmpegVersion
    && left.signingKeyId === right.signingKeyId && left.manifestSha256 === right.manifestSha256
    && exactStringTuple(left.sharedLibraryPaths, right.sharedLibraryPaths)
}

async function closeBindings(bindings: readonly OpenFileBinding[]): Promise<void> {
  const results = await Promise.allSettled(bindings.map((binding) => binding.handle.close()))
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('Packaged FFmpeg execution lease could not be released.')
  }
}

function ownManifestKey(keys: WorldFfmpegTrustedManifestKeys, keyId: string): string | Buffer | null {
  return Object.prototype.hasOwnProperty.call(keys, keyId) ? keys[keyId] ?? null : null
}

function parseCompiledManifestKeys(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('World FFmpeg compiled trust is invalid.')
  }
  const keys = Object.keys(value).sort(codeUnitCompare)
  const parsed: Record<string, string> = {}
  for (const keyId of keys) {
    const pem = (value as Record<string, unknown>)[keyId]
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(keyId)
      || typeof pem !== 'string' || pem.length < 32 || pem.length > 16 * 1024) {
      throw new Error('World FFmpeg compiled trust is invalid.')
    }
    let key
    try { key = createPublicKey(pem) } catch { throw new Error('World FFmpeg compiled trust is invalid.') }
    if (key.asymmetricKeyType !== 'ed25519'
      || key.export({ type: 'spki', format: 'pem' }).toString() !== pem) {
      throw new Error('World FFmpeg compiled trust is invalid.')
    }
    parsed[keyId] = pem
  }
  return Object.freeze(parsed)
}

function isSafeBundleFilePath(value: string): boolean {
  return !isAbsolute(value) && !value.includes('\\') && !value.includes('\0')
    && /^(?:LICENSE\.txt|bin\/[A-Za-z0-9][A-Za-z0-9._+-]{0,127})$/.test(value)
}

function isSharedLibraryName(path: string, target: WorldFfmpegRuntimeTarget): boolean {
  const name = path.slice('bin/'.length)
  if (target === 'win32-x64') return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.dll$/i.test(name)
  if (target === 'darwin-arm64') return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.dylib$/.test(name)
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.so(?:\.\d{1,4})*$/.test(name)
}

function assertContained(root: string, candidate: string): void {
  const suffix = relative(root, candidate)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    if (candidate === root) return
    throw new Error('Packaged FFmpeg runtime path escaped its root.')
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Object.keys(descriptors).sort(codeUnitCompare)
  const expected = [...keys].sort(codeUnitCompare)
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null
  for (const key of actual) {
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !('value' in descriptor)) return null
  }
  return value as Record<string, unknown>
}

function exactStringTuple(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index])
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function nodeErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}
