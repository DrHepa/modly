import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/
const MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DEFAULT_MAX_MANIFEST_BYTES = 1024 * 1024
const DEFAULT_MAX_ENTRIES = 128
const DEFAULT_MAX_LOGICAL_BYTES = 256 * 1024 * 1024 * 1024
const DEFAULT_MAX_BLOB_BYTES = 128 * 1024 * 1024 * 1024
const MAX_SAFE_BOUND = Number.MAX_SAFE_INTEGER
const ALLOWED_MANIFEST_MEDIA_TYPES = new Set([
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
])
const ALLOWED_CONFIG_MEDIA_TYPES = new Set([
  'application/vnd.docker.container.image.v1+json',
  'application/vnd.ollama.image.config',
])
const ALLOWED_LAYER_MEDIA_TYPES = /^application\/vnd\.ollama\.image\.(?:model|adapter|projector|template|system|prompt|params|license|messages)$/

export interface OllamaModelNameParts {
  registry: 'registry.ollama.ai'
  namespace: readonly string[]
  name: string
  tag: string
}

export interface AgentOllamaFileIdentity {
  path: string
  device: string
  inode: string
  uid: number
  gid: number
  mode: number
  size: number
  nlink: number
  mtimeNs: string
  ctimeNs: string
  sha256: string
}

export interface OpenOllamaManifestFile {
  path: string
  bytes: Buffer
  identity: Readonly<AgentOllamaFileIdentity>
  handle: FileHandle
}

export interface OpenOllamaBlobFile {
  digest: `sha256:${string}`
  mediaType: string
  size: number
  path: string
  identity: Readonly<AgentOllamaFileIdentity>
  handle: FileHandle
}

export interface OpenVerifiedOllamaModel {
  readonly model: string
  readonly digest: `sha256:${string}`
  readonly modelsDir: string
  readonly manifest: OpenOllamaManifestFile
  readonly blobs: readonly OpenOllamaBlobFile[]
  revalidate(): Promise<void>
  close(): Promise<void>
}

export interface OllamaModelStoreLimits {
  maxManifestBytes: number
  maxEntries: number
  maxLogicalBytes: number
  maxBlobBytes: number
}

export interface OpenVerifiedOllamaModelOptions {
  modelsDir: string
  model: string
  digest: string
  signal?: AbortSignal
  limits?: Partial<OllamaModelStoreLimits>
  afterHash?: (input: Readonly<{ kind: 'manifest' | 'blob', path: string }>) => void | Promise<void>
}

export class AgentOllamaModelStoreError extends Error {
  readonly code: 'invalid_store' | 'invalid_model' | 'invalid_manifest' | 'digest_mismatch' | 'model_too_large' | 'model_stale' | 'aborted'

  constructor(code: AgentOllamaModelStoreError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AgentOllamaModelStoreError'
    this.code = code
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AgentOllamaModelStoreError('aborted', 'Ollama model verification was aborted')
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw new AgentOllamaModelStoreError('invalid_manifest', `${label} contains an unsupported field`)
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AgentOllamaModelStoreError('invalid_manifest', `${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function bound(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AgentOllamaModelStoreError('invalid_store', `${label} is invalid`)
  }
  return value
}

function normalizeLimits(value: OpenVerifiedOllamaModelOptions['limits']): Readonly<OllamaModelStoreLimits> {
  return Object.freeze({
    maxManifestBytes: bound(value?.maxManifestBytes, DEFAULT_MAX_MANIFEST_BYTES, 8 * 1024 * 1024, 'Manifest byte bound'),
    maxEntries: bound(value?.maxEntries, DEFAULT_MAX_ENTRIES, 1024, 'Graph entry bound'),
    maxLogicalBytes: bound(value?.maxLogicalBytes, DEFAULT_MAX_LOGICAL_BYTES, MAX_SAFE_BOUND, 'Graph byte bound'),
    maxBlobBytes: bound(value?.maxBlobBytes, DEFAULT_MAX_BLOB_BYTES, MAX_SAFE_BOUND, 'Blob byte bound'),
  })
}

export function parseOllamaModelName(value: unknown): Readonly<OllamaModelNameParts> {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.trim() !== value
    || value.includes('\0') || value.includes('\\') || value.includes('@')) {
    throw new AgentOllamaModelStoreError('invalid_model', 'Ollama model name is invalid')
  }
  const colon = value.lastIndexOf(':')
  const repository = colon < 0 ? value : value.slice(0, colon)
  const tag = colon < 0 ? 'latest' : value.slice(colon + 1)
  const segments = repository.split('/')
  if (segments.length < 1 || segments.length > 3 || !MODEL_SEGMENT.test(tag)
    || segments.some((segment) => !MODEL_SEGMENT.test(segment))
    || segments[0].includes('.') && segments.length > 1) {
    throw new AgentOllamaModelStoreError('invalid_model', 'Ollama model name is invalid')
  }
  const name = segments.at(-1)!
  const namespace = segments.length === 1 ? ['library'] : segments.slice(0, -1)
  return Object.freeze({ registry: 'registry.ollama.ai' as const, namespace: Object.freeze(namespace), name, tag })
}

function safeNumber(value: bigint, label: string, code: AgentOllamaModelStoreError['code'] = 'invalid_store'): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new AgentOllamaModelStoreError(code, `${label} is outside supported bounds`)
  return number
}

async function canonicalStoreDirectory(path: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new AgentOllamaModelStoreError('invalid_store', 'Ollama model store must be a canonical absolute path')
  }
  try {
    const [canonical, info] = await Promise.all([realpath(path), lstat(path, { bigint: true })])
    if (canonical !== path || info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o022n) !== 0n) {
      throw new AgentOllamaModelStoreError('invalid_store', 'Ollama model store identity or mode is unsafe')
    }
    return canonical
  } catch (error) {
    if (error instanceof AgentOllamaModelStoreError) throw error
    throw new AgentOllamaModelStoreError('invalid_store', 'Ollama model store is unavailable', error)
  }
}

async function assertDirectoryChain(root: string, segments: readonly string[]): Promise<void> {
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    let info: BigIntStats
    try { info = await lstat(current, { bigint: true }) } catch (error) {
      throw new AgentOllamaModelStoreError('invalid_store', 'Ollama model store graph is incomplete', error)
    }
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o022n) !== 0n) {
      throw new AgentOllamaModelStoreError('invalid_store', 'Ollama model store directory is unsafe')
    }
    const canonical = await realpath(current)
    if (canonical !== current) throw new AgentOllamaModelStoreError('invalid_store', 'Ollama model store directory is not canonical')
  }
}

async function hashFileHandle(
  handle: FileHandle,
  maximum: number,
  signal?: AbortSignal,
): Promise<{ sha256: string, bytes: Buffer | undefined }> {
  assertNotAborted(signal)
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let size = 0
  const retain = maximum <= 8 * 1024 * 1024
  const stream = handle.createReadStream({ autoClose: false, start: 0 })
  for await (const raw of stream) {
    assertNotAborted(signal)
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.length
    if (size > maximum) {
      stream.destroy()
      throw new AgentOllamaModelStoreError('model_too_large', 'Ollama model file exceeds its byte bound')
    }
    hash.update(chunk)
    if (retain) chunks.push(chunk)
  }
  return { sha256: hash.digest('hex'), bytes: retain ? Buffer.concat(chunks, size) : undefined }
}

function fileIdentity(path: string, info: BigIntStats, sha256: string): AgentOllamaFileIdentity {
  return {
    path,
    device: info.dev.toString(),
    inode: info.ino.toString(),
    uid: safeNumber(info.uid, 'Ollama file uid'),
    gid: safeNumber(info.gid, 'Ollama file gid'),
    mode: Number(info.mode & 0o7777n),
    size: safeNumber(info.size, 'Ollama file size', 'model_too_large'),
    nlink: safeNumber(info.nlink, 'Ollama file link count'),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
    sha256,
  }
}

function statMatches(info: BigIntStats, expected: AgentOllamaFileIdentity): boolean {
  return info.isFile()
    && info.dev.toString() === expected.device
    && info.ino.toString() === expected.inode
    && Number(info.uid) === expected.uid
    && Number(info.gid) === expected.gid
    && Number(info.mode & 0o7777n) === expected.mode
    && Number(info.size) === expected.size
    && Number(info.nlink) === expected.nlink
    && info.mtimeNs.toString() === expected.mtimeNs
    && info.ctimeNs.toString() === expected.ctimeNs
}

async function openHashedFile(input: {
  path: string
  maximum: number
  expectedSize?: number
  expectedDigest?: string
  kind: 'manifest' | 'blob'
  afterHash?: OpenVerifiedOllamaModelOptions['afterHash']
  signal?: AbortSignal
}): Promise<{ handle: FileHandle, identity: Readonly<AgentOllamaFileIdentity>, bytes: Buffer | undefined }> {
  let handle: FileHandle | undefined
  try {
    const pathInfo = await lstat(input.path, { bigint: true })
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || (pathInfo.mode & 0o022n) !== 0n) {
      throw new AgentOllamaModelStoreError('invalid_store', 'Ollama model file is unsafe')
    }
    const pathSize = safeNumber(pathInfo.size, 'Ollama file size', 'model_too_large')
    if (pathSize > input.maximum || (input.expectedSize !== undefined && pathSize !== input.expectedSize)) {
      throw new AgentOllamaModelStoreError('model_too_large', 'Ollama model file size does not match its bounded descriptor')
    }
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(input.path, constants.O_RDONLY | noFollow)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino
      || (before.mode & 0o022n) !== 0n) {
      throw new AgentOllamaModelStoreError('model_stale', 'Ollama model file changed while opening')
    }
    const hashed = await hashFileHandle(handle, input.maximum, input.signal)
    await input.afterHash?.({ kind: input.kind, path: input.path })
    assertNotAborted(input.signal)
    const expected = input.expectedDigest?.slice('sha256:'.length)
    if (expected !== undefined && hashed.sha256 !== expected) {
      throw new AgentOllamaModelStoreError('digest_mismatch', 'Ollama model file digest does not match its descriptor')
    }
    const pinned = Object.freeze(fileIdentity(input.path, before, hashed.sha256))
    const [after, currentPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(input.path, { bigint: true }),
    ])
    if (currentPath.isSymbolicLink() || !statMatches(after, pinned) || !statMatches(currentPath, pinned)) {
      throw new AgentOllamaModelStoreError('model_stale', 'Ollama model file changed while hashing')
    }
    return { handle, identity: pinned, bytes: hashed.bytes }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (error instanceof AgentOllamaModelStoreError) throw error
    throw new AgentOllamaModelStoreError('invalid_store', 'Ollama model file is unavailable', error)
  }
}

interface Descriptor {
  mediaType: string
  digest: `sha256:${string}`
  size: number
}

function descriptor(value: unknown, kind: 'config' | 'layer', limits: OllamaModelStoreLimits): Descriptor {
  const entry = record(value, `Ollama ${kind} descriptor`)
  exactKeys(entry, ['mediaType', 'digest', 'size'], `Ollama ${kind} descriptor`)
  const mediaTypeValid = kind === 'config'
    ? typeof entry.mediaType === 'string' && ALLOWED_CONFIG_MEDIA_TYPES.has(entry.mediaType)
    : typeof entry.mediaType === 'string' && ALLOWED_LAYER_MEDIA_TYPES.test(entry.mediaType)
  if (!mediaTypeValid || typeof entry.digest !== 'string' || !SHA256_DIGEST.test(entry.digest)
    || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxBlobBytes) {
    throw new AgentOllamaModelStoreError('invalid_manifest', `Ollama ${kind} descriptor is invalid`)
  }
  return { mediaType: entry.mediaType as string, digest: entry.digest as `sha256:${string}`, size: entry.size }
}

function parseManifest(bytes: Buffer, limits: OllamaModelStoreLimits): readonly Descriptor[] {
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch (error) {
    throw new AgentOllamaModelStoreError('invalid_manifest', 'Ollama manifest is not valid JSON', error)
  }
  const manifest = record(parsed, 'Ollama manifest')
  exactKeys(manifest, ['schemaVersion', 'mediaType', 'config', 'layers'], 'Ollama manifest')
  if (manifest.schemaVersion !== 2 || typeof manifest.mediaType !== 'string'
    || !ALLOWED_MANIFEST_MEDIA_TYPES.has(manifest.mediaType) || !Array.isArray(manifest.layers)) {
    throw new AgentOllamaModelStoreError('invalid_manifest', 'Ollama manifest schema is unsupported')
  }
  if (manifest.layers.length + 2 > limits.maxEntries) {
    throw new AgentOllamaModelStoreError('model_too_large', 'Ollama model graph has too many entries')
  }
  const descriptors = [descriptor(manifest.config, 'config', limits), ...manifest.layers.map((entry) => descriptor(entry, 'layer', limits))]
  let logicalBytes = 0
  for (const entry of descriptors) {
    logicalBytes += entry.size
    if (!Number.isSafeInteger(logicalBytes) || logicalBytes > limits.maxLogicalBytes) {
      throw new AgentOllamaModelStoreError('model_too_large', 'Ollama model graph exceeds its logical byte bound')
    }
  }
  return Object.freeze(descriptors)
}

function uniqueDescriptors(descriptors: readonly Descriptor[]): readonly Descriptor[] {
  const seen = new Map<string, Descriptor>()
  const unique: Descriptor[] = []
  for (const entry of descriptors) {
    const previous = seen.get(entry.digest)
    if (previous) {
      if (previous.size !== entry.size || previous.mediaType !== entry.mediaType) {
        throw new AgentOllamaModelStoreError('invalid_manifest', 'Ollama manifest reuses a digest inconsistently')
      }
      continue
    }
    seen.set(entry.digest, entry)
    unique.push(entry)
  }
  return Object.freeze(unique)
}

async function probeBlobMetadata(path: string, descriptor: Descriptor): Promise<void> {
  let handle: FileHandle | undefined
  try {
    const pathInfo = await lstat(path, { bigint: true })
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || (pathInfo.mode & 0o022n) !== 0n
      || safeNumber(pathInfo.size, 'Ollama file size', 'model_too_large') !== descriptor.size) {
      throw new AgentOllamaModelStoreError('invalid_store', 'Ollama model file metadata is unsafe')
    }
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(path, constants.O_RDONLY | noFollow)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino
      || (before.mode & 0o022n) !== 0n) {
      throw new AgentOllamaModelStoreError('model_stale', 'Ollama model file metadata changed while opening')
    }
    const pinned = fileIdentity(path, before, '')
    const currentPath = await lstat(path, { bigint: true })
    if (!statMatches(before, pinned) || currentPath.isSymbolicLink() || !statMatches(currentPath, pinned)
      || pinned.size !== descriptor.size) {
      throw new AgentOllamaModelStoreError('model_stale', 'Ollama model file metadata changed while probing')
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function probeManifestGraph(root: string, manifestPath: string): Promise<boolean> {
  let manifest: Awaited<ReturnType<typeof openHashedFile>> | undefined
  try {
    const limits = normalizeLimits(undefined)
    manifest = await openHashedFile({
      path: manifestPath,
      maximum: limits.maxManifestBytes,
      kind: 'manifest',
    })
    if (!manifest.bytes) return false
    const descriptors = uniqueDescriptors(parseManifest(manifest.bytes, limits))
    for (const entry of descriptors) {
      await probeBlobMetadata(join(root, 'blobs', entry.digest.replace(':', '-')), entry)
    }
    return true
  } catch {
    return false
  } finally {
    await manifest?.handle.close().catch(() => undefined)
  }
}

async function revalidateFile(handle: FileHandle, expected: AgentOllamaFileIdentity): Promise<void> {
  const [currentHandle, currentPath] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(expected.path, { bigint: true }),
  ])
  if (currentPath.isSymbolicLink() || !statMatches(currentHandle, expected) || !statMatches(currentPath, expected)) {
    throw new AgentOllamaModelStoreError('model_stale', 'Ollama model authority changed')
  }
}

export async function openVerifiedOllamaModel(options: OpenVerifiedOllamaModelOptions): Promise<OpenVerifiedOllamaModel> {
  assertNotAborted(options.signal)
  if (process.platform !== 'linux' || typeof options.digest !== 'string' || !SHA256_DIGEST.test(options.digest)) {
    throw new AgentOllamaModelStoreError('invalid_model', 'Ollama model binding is invalid')
  }
  const limits = normalizeLimits(options.limits)
  const parts = parseOllamaModelName(options.model)
  const modelsDir = await canonicalStoreDirectory(options.modelsDir)
  const manifestSegments = ['manifests', parts.registry, ...parts.namespace, parts.name]
  await assertDirectoryChain(modelsDir, manifestSegments)
  await assertDirectoryChain(modelsDir, ['blobs'])
  const manifestPath = join(modelsDir, ...manifestSegments, parts.tag)
  const openFiles: FileHandle[] = []
  try {
    const manifestFile = await openHashedFile({
      path: manifestPath,
      maximum: limits.maxManifestBytes,
      expectedDigest: options.digest,
      kind: 'manifest',
      afterHash: options.afterHash,
      signal: options.signal,
    })
    openFiles.push(manifestFile.handle)
    if (!manifestFile.bytes) throw new AgentOllamaModelStoreError('invalid_manifest', 'Ollama manifest could not be retained')
    const descriptors = uniqueDescriptors(parseManifest(manifestFile.bytes, limits))
    const blobs: OpenOllamaBlobFile[] = []
    for (const entry of descriptors) {
      assertNotAborted(options.signal)
      const blobPath = join(modelsDir, 'blobs', entry.digest.replace(':', '-'))
      const opened = await openHashedFile({
        path: blobPath,
        maximum: Math.min(limits.maxBlobBytes, limits.maxLogicalBytes),
        expectedSize: entry.size,
        expectedDigest: entry.digest,
        kind: 'blob',
        afterHash: options.afterHash,
        signal: options.signal,
      })
      openFiles.push(opened.handle)
      const blob = Object.freeze({
        ...entry,
        path: blobPath,
        identity: opened.identity,
        handle: opened.handle,
      })
      blobs.push(blob)
    }
    let closePromise: Promise<void> | undefined
    const model: OpenVerifiedOllamaModel = {
      model: options.model,
      digest: options.digest as `sha256:${string}`,
      modelsDir,
      manifest: Object.freeze({
        path: manifestPath,
        bytes: Buffer.from(manifestFile.bytes),
        identity: manifestFile.identity,
        handle: manifestFile.handle,
      }),
      blobs: Object.freeze(blobs),
      revalidate: async () => {
        if (closePromise) throw new AgentOllamaModelStoreError('model_stale', 'Ollama model authority is closed')
        try {
          await canonicalStoreDirectory(modelsDir)
          await assertDirectoryChain(modelsDir, manifestSegments)
          await assertDirectoryChain(modelsDir, ['blobs'])
        } catch (error) {
          throw new AgentOllamaModelStoreError('model_stale', 'Ollama model store authority changed', error)
        }
        await revalidateFile(manifestFile.handle, manifestFile.identity)
        for (const blob of blobs) await revalidateFile(blob.handle, blob.identity)
      },
      close: () => {
        closePromise ??= Promise.all(openFiles.map((handle) => handle.close().catch(() => undefined))).then(() => undefined)
        return closePromise
      },
    }
    return Object.freeze(model)
  } catch (error) {
    await Promise.all(openFiles.map((handle) => handle.close().catch(() => undefined)))
    if (error instanceof AgentOllamaModelStoreError) throw error
    throw new AgentOllamaModelStoreError('invalid_store', 'Ollama model graph could not be verified', error)
  }
}

export async function probeOllamaModelStore(modelsDir: string): Promise<boolean> {
  try {
    const root = await canonicalStoreDirectory(modelsDir)
    await assertDirectoryChain(root, ['manifests', 'registry.ollama.ai'])
    await assertDirectoryChain(root, ['blobs'])
    const registryRoot = join(root, 'manifests', 'registry.ollama.ai')
    const pending: Array<{ path: string, depth: number }> = [{ path: registryRoot, depth: 0 }]
    let inspected = 0
    const manifests: string[] = []
    while (pending.length > 0 && inspected < 512) {
      const current = pending.shift()!
      const entries = await readdir(current.path, { withFileTypes: true })
      for (const entry of entries) {
        inspected += 1
        if (inspected > 512 || entry.isSymbolicLink()) return false
        const path = join(current.path, entry.name)
        if (entry.isDirectory()) {
          if (current.depth >= 3 || !MODEL_SEGMENT.test(entry.name)) return false
          pending.push({ path, depth: current.depth + 1 })
        } else if (entry.isFile() && current.depth >= 2 && current.depth <= 3 && MODEL_SEGMENT.test(entry.name)) {
          manifests.push(path)
        } else {
          return false
        }
      }
    }
    if (pending.length > 0 || manifests.length === 0) return false
    const blobEntries = await readdir(join(root, 'blobs'), { withFileTypes: true })
    if (blobEntries.length === 0 || blobEntries.length > 512
      || !blobEntries.every((entry) => entry.isFile() && /^sha256-[a-f0-9]{64}$/.test(entry.name))) return false
    for (const manifest of manifests) {
      if (await probeManifestGraph(root, manifest)) return true
    }
    return false
  } catch {
    return false
  }
}
