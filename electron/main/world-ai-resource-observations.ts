import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { normalizeWorldWorkspacePath } from '../../src/areas/worlds/core/worldDocuments.ts'
import { classifyPlyHeader } from '../../src/shared/ply/plyHeaderClassification.ts'
import {
  parseWorldAiContext, safeWorldAiText, WorldAiContractError,
  type WorldAiContext, type WorldAiQueryPage, type WorldAiResourceRow, type WorldAiQueryObservations,
} from '../../src/areas/worlds/core/worldAiContract.ts'
import type { WorldAiCreationObservations, WorldAiResolvedResource } from '../../src/areas/worlds/core/worldAiCreationCompiler.ts'
import type { WorldCommandBatchV1 } from '../../src/areas/worlds/core/worldCommands.ts'
import { canonicalWorldCommandBatchPayload } from '../../src/areas/worlds/core/worldCommands.ts'
import type { WorldModelResource, WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'

const TTL_MS = 5 * 60_000
const MAX_SCOPES = 64
const MAX_RESOURCES = 512
const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_QUERY_SOURCE_BYTES = 1024 * 1024 * 1024
const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_DEPENDENCIES = 64
const SOURCE_DEADLINE_MS = 8_000
interface SourceFile { path: string; sha256: string; byteLength: number; identity: string }
export interface WorldAiSourceProof { workspacePath: string; format: WorldModelResource['format']; fingerprint: string; files: SourceFile[] }
interface ObservedResource { row: WorldAiResourceRow; resolved: WorldAiResolvedResource; proof: WorldAiSourceProof; canonicalId?: string }
interface ObservationScope {
  workspace: string; context: WorldAiContext; expires: number
  entities: Set<string>; components: Set<string>; resources: Map<string, ObservedResource>
  discovery?: Promise<WorldAiQueryObservations>; discovered?: WorldAiQueryObservations
}
interface ApplyAuthority { scope: ObservationScope; batch: WorldCommandBatchV1; payload: string; resources: string[]; expires: number; claimed: boolean; revoked: boolean }

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** Composition-root authority shared by fresh repositories; every entry is qualified by the real workspace and complete request context. */
class WorldAiObservationAuthority {
  readonly #scopes = new Map<string, ObservationScope>()
  readonly #applies = new Map<string, ApplyAuthority>()
  #prune() {
    const now = Date.now()
    for (const [key, scope] of this.#scopes) if (scope.expires <= now) this.#scopes.delete(key)
    for (const [key, entry] of this.#applies) if (entry.expires <= now || entry.scope.expires <= now) { entry.revoked = true; this.#applies.delete(key) }
    while (this.#scopes.size > MAX_SCOPES) this.#scopes.delete(this.#scopes.keys().next().value!)
    while (this.#applies.size > MAX_SCOPES) {
      const key = this.#applies.keys().next().value!
      this.#applies.get(key)!.revoked = true; this.#applies.delete(key)
    }
  }
  #assertScope(scope: ObservationScope) {
    if (Date.now() >= scope.expires || this.#scopes.get(JSON.stringify([scope.workspace, scope.context])) !== scope) reject('The request observations are missing or expired.')
  }
  async scope(workspace: string, contextValue: WorldAiContext, create = false): Promise<ObservationScope> {
    const context = parseWorldAiContext(contextValue)
    const canonicalWorkspace = await realpath(workspace)
    if (canonicalWorkspace !== resolve(workspace)) reject('Unsafe workspace source root.')
    this.#prune()
    const key = JSON.stringify([canonicalWorkspace, context])
    let scope = this.#scopes.get(key)
    if (!scope && create) {
      scope = { workspace: canonicalWorkspace, context, expires: Date.now() + TTL_MS, entities: new Set(), components: new Set(), resources: new Map() }
      this.#scopes.set(key, scope)
      this.#prune()
    }
    if (!scope) reject('The request observations are missing or expired.')
    return scope
  }
  async discover(scope: ObservationScope, snapshot: WorldProjectSnapshotV1): Promise<WorldAiQueryObservations> {
    if (scope.discovered) return scope.discovered
    if (scope.discovery) return scope.discovery
    scope.discovery = (async () => {
      const deadline = Date.now() + SOURCE_DEADLINE_MS
      const catalog = await listBoundedSharedModels(scope.workspace, deadline)
      const candidates: Array<{ path: string; name: string; source: WorldAiResourceRow['source']; canonicalId?: string; expected?: WorldModelResource['format'] }> = snapshot.project.resources
        .filter((resource): resource is WorldModelResource => resource.type === 'model')
        .map((resource) => ({ path: resource.workspacePath, name: resource.name, source: 'project', canonicalId: resource.id, expected: resource.format }))
      for (const entry of catalog) candidates.push({ path: entry.path, name: entry.name, source: entry.source })
      if (candidates.length > MAX_RESOURCES) reject('Resource discovery exceeds its bounded inventory.')
      const resources: WorldAiResourceRow[] = []; const resourceHandles = new Map<string, string>()
      let bytes = 0
      for (const candidate of candidates) {
        if (Date.now() >= deadline) reject('Resource discovery exceeded its deadline.')
        const proof = await observeWorldAiSource(scope.workspace, candidate.path, deadline)
        if (candidate.expected && proof.format !== candidate.expected) reject('A project resource changed its actual format.')
        bytes += proof.files.reduce((sum, file) => sum + file.byteLength, 0)
        if (bytes > MAX_QUERY_SOURCE_BYTES) reject('Resource discovery exceeds its byte budget.')
        const id = `asset_${randomBytes(16).toString('hex')}`
        const row: WorldAiResourceRow = { kind: 'resource', id, name: safeWorldAiText(candidate.name), source: candidate.source,
          format: proof.format, capability: proof.format === 'gaussian-ply' ? 'gaussian' : proof.format === 'ply-points' ? 'points' : 'mesh',
          fingerprint: proof.fingerprint, dependencyCount: proof.files.length }
        scope.resources.set(id, { row, resolved: { workspacePath: proof.workspacePath, format: proof.format }, proof, ...(candidate.canonicalId ? { canonicalId: candidate.canonicalId } : {}) })
        resources.push(row)
        if (candidate.canonicalId) resourceHandles.set(candidate.canonicalId, id)
      }
      return { resources, resourceHandles }
    })()
    try { scope.discovered = await scope.discovery; return scope.discovered }
    catch (error) { scope.resources.clear(); throw error }
    finally { scope.discovery = undefined }
  }
  record(scope: ObservationScope, page: WorldAiQueryPage) {
    for (const item of page.items) {
      if (item.kind === 'entity') scope.entities.add(item.id)
      else if (item.kind === 'component') {
        scope.components.add(JSON.stringify([item.entityId, item.id]))
        if (item.current?.type === 'renderable') this.#observeHandle(scope, item.current.resourceHandle)
      } else if (item.kind === 'resource') this.#observeHandle(scope, item.id)
    }
  }
  #observeHandle(scope: ObservationScope, handle: string) {
    const resource = scope.resources.get(handle)
    if (!resource) reject('Unknown resource observation.')
    // Distinguish discovery inventory from rows actually returned to this request.
    scope.components.add(JSON.stringify(['resource', handle]))
  }
  async resolve(scope: ObservationScope, handles: readonly string[]): Promise<WorldAiCreationObservations> {
    this.#assertScope(scope)
    const resources = new Map<string, WorldAiResolvedResource>()
    for (const handle of handles) {
      const observed = scope.resources.get(handle)
      if (!observed || !scope.components.has(JSON.stringify(['resource', handle]))) reject('The resource was not queried in this request.')
      await revalidateWorldAiSource(scope.workspace, observed.proof)
      resources.set(handle, { ...observed.resolved })
    }
    this.#assertScope(scope)
    return { resources, assertObserved(kind, id, entityId) {
      if (Date.now() >= scope.expires || !(kind === 'entity' ? scope.entities.has(id) : scope.components.has(JSON.stringify([entityId, id])))) reject('The existing target was not queried in this request.')
    } }
  }
  issue(scope: ObservationScope, batch: WorldCommandBatchV1, resources: string[]): string {
    this.#assertScope(scope)
    this.#prune()
    const handle = `apply_${randomBytes(24).toString('hex')}`
    this.#applies.set(handle, { scope, batch: structuredClone(batch), payload: canonicalWorldCommandBatchPayload(batch), resources: [...resources], expires: scope.expires, claimed: false, revoked: false })
    this.#prune()
    return handle
  }
  async redeem(workspace: string, context: WorldAiContext, handle: string, batch: WorldCommandBatchV1): Promise<() => void> {
    const scope = await this.scope(workspace, context)
    const entry = this.#applies.get(handle)
    if (!entry || entry.scope !== scope || entry.claimed || entry.revoked || entry.payload !== canonicalWorldCommandBatchPayload(batch)) reject('The reviewed Apply authority is invalid or changed.')
    entry.claimed = true
    // Claim once, but remain reachable by discard until locked journal publication begins.
    const assertLive = () => {
      this.#assertScope(scope)
      if (entry.revoked || this.#applies.get(handle) !== entry || Date.now() >= entry.expires) reject('The reviewed Apply authority was revoked or expired.')
    }
    try { await this.resolve(scope, entry.resources); assertLive() }
    catch (error) { entry.revoked = true; this.#applies.delete(handle); throw error }
    // Synchronous irreversibility check: no await between this and starting the durable journal write.
    return () => { try { assertLive() } finally { entry.revoked = true; this.#applies.delete(handle) } }
  }
  async discard(workspace: string, context: WorldAiContext, handle: string): Promise<void> {
    const entry = this.#applies.get(handle)
    if (!entry) return
    if (entry.scope !== await this.scope(workspace, context)) reject('The proposal belongs to another request.')
    entry.revoked = true
    this.#applies.delete(handle)
  }
}
export const worldAiObservationAuthority = new WorldAiObservationAuthority()

/** Same Workflows/Exports catalog roots and internal-directory exclusions, with streaming bounded inventory rather than the UI catalog's unbounded Promise.all. */
async function listBoundedSharedModels(workspace: string, deadline: number): Promise<Array<{ path: string; name: string; source: 'workflows' | 'exports' }>> {
  const pending = ['Workflows', 'Exports']; const results: Array<{ path: string; name: string; source: 'workflows' | 'exports' }> = []
  let entries = 0
  while (pending.length) {
    if (Date.now() >= deadline) reject('Catalog inventory exceeded its deadline.')
    const path = pending.shift()!
    const absolute = resolve(workspace, path)
    let info
    try { info = await lstat(absolute) } catch (error) { if (record(error) && error.code === 'ENOENT') continue; throw error }
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(absolute) !== absolute) reject('Unsafe catalog directory.')
    const directory = await opendir(absolute, { bufferSize: 32 })
    for await (const entry of directory) {
      if (++entries > 4096 || Date.now() >= deadline) reject('Catalog inventory exceeds its bounds.')
      if (entry.name.startsWith('.') || ['tmp', 'temp', 'cache'].includes(entry.name.toLowerCase())) continue
      const child = `${path}/${entry.name}`
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile() && /\.(?:glb|gltf|ply)$/i.test(entry.name)) {
        results.push({ path: child, name: basename(child), source: child.startsWith('Exports/') ? 'exports' : 'workflows' })
        if (results.length > MAX_RESOURCES) reject('Catalog model inventory exceeds its bound.')
      }
    }
    if (identity(await lstat(absolute)) !== identity(info)) reject('Catalog directory changed during discovery.')
  }
  return results
}

/** Async bounded regular-file hashing plus actual format/dependency validation, never a renderer hash loop. */
export async function observeWorldAiSource(workspace: string, pathValue: string, deadline = Date.now() + SOURCE_DEADLINE_MS): Promise<WorldAiSourceProof> {
  const path = normalizeWorldWorkspacePath(pathValue)
  if (!path) reject('Unsafe asset source.')
  const primary = await readSource(workspace, path, deadline, true)
  const suffix = extname(path).toLowerCase()
  let format: WorldModelResource['format']; let json: unknown; let embeddedBytes = 0
  if (suffix === '.glb') {
    const header = primary.prefix
    if (header.length < 20 || header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== primary.file.byteLength) reject('Invalid GLB source bytes.')
    const length = header.readUInt32LE(12)
    if (length > MAX_JSON_BYTES || length % 4 || header.readUInt32LE(16) !== 0x4e4f534a || length + 20 > primary.file.byteLength) reject('Invalid GLB JSON chunk.')
    const bytes = await readSourceRange(workspace, path, 20, length, primary.file.identity, deadline)
    json = JSON.parse(bytes.toString('utf8').trim())
    let offset = 20 + length
    while (offset < primary.file.byteLength) {
      const chunk = await readSourceRange(workspace, path, offset, 8, primary.file.identity, deadline)
      const size = chunk.readUInt32LE(0); const type = chunk.readUInt32LE(4)
      if (type !== 0x004e4942 || size % 4 || offset + 8 + size > primary.file.byteLength || embeddedBytes) reject('Invalid GLB binary chunk.')
      embeddedBytes = size; offset += size + 8
    }
    format = 'glb'
  } else if (suffix === '.gltf') {
    if (primary.file.byteLength > MAX_JSON_BYTES) reject('glTF JSON exceeds its byte limit.')
    json = JSON.parse((await readSourceRange(workspace, path, 0, primary.file.byteLength, primary.file.identity, deadline)).toString('utf8'))
    format = 'gltf'
  } else if (suffix === '.ply') {
    const text = primary.prefix.toString('ascii'); const terminator = /(?:^|\n)end_header\r?\n/.exec(text)
    const end = terminator?.index ?? -1
    if (!text.startsWith('ply\n') && !text.startsWith('ply\r\n') || end < 0 || !/\bformat (?:ascii|binary_little_endian|binary_big_endian) 1\.0\b/.test(text.slice(0, end))) reject('Invalid PLY source header.')
    const count = /(?:^|\n)element vertex ([1-9][0-9]*)\r?\n/.exec(text.slice(0, end))
    if (!count || Number(count[1]) > 100_000_000 || primary.file.byteLength <= end + terminator![0].length) reject('Invalid PLY vertex payload.')
    const kind = classifyPlyHeader(text).plyKind
    format = kind === 'gaussian' ? 'gaussian-ply' : kind === 'mesh' ? 'ply-mesh' : 'ply-points'
  } else reject('Unsupported actual asset format.')
  const files = [primary.file]
  if (json !== undefined) {
    if (!record(json) || !record(json.asset) || json.asset.version !== '2.0') reject('Invalid glTF document.')
    const buffers = json.buffers ?? []; const images = json.images ?? []
    if (!Array.isArray(buffers) || !Array.isArray(images) || buffers.length + images.length > MAX_DEPENDENCIES) reject('glTF dependency closure exceeds its limit.')
    const allowedUris = new Set<object>([...buffers, ...images].filter(record))
    let nodes = 0
    const inspect = (value: unknown, depth = 0): void => {
      if (++nodes > 50_000 || depth > 32) reject('glTF metadata exceeds its limits.')
      if (!value || typeof value !== 'object') return
      if (record(value) && Object.hasOwn(value, 'uri') && !allowedUris.has(value)) reject('Unknown glTF URI-bearing extension.')
      for (const child of Object.values(value)) inspect(child, depth + 1)
    }
    inspect(json)
    for (const dependency of [...buffers, ...images]) {
      if (!record(dependency)) reject('Invalid glTF dependency.')
      if (buffers.includes(dependency) && (!Number.isSafeInteger(dependency.byteLength) || (dependency.byteLength as number) < 1 || (dependency.byteLength as number) > MAX_SOURCE_BYTES)) reject('Invalid glTF buffer size.')
      if (!Object.hasOwn(dependency, 'uri')) {
        if (buffers.includes(dependency) && (!embeddedBytes || (dependency.byteLength as number) > embeddedBytes)) reject('Missing glTF buffer bytes.')
        if (images.includes(dependency) && !Number.isSafeInteger(dependency.bufferView)) reject('Missing glTF image source.')
        continue
      }
      if (typeof dependency.uri !== 'string') reject('Invalid glTF URI.')
      if (dependency.uri.startsWith('data:')) {
        if (!/^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp));base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dependency.uri) || dependency.uri.length > MAX_JSON_BYTES) reject('Unsupported embedded glTF bytes.')
        const size = Buffer.from(dependency.uri.slice(dependency.uri.indexOf(',') + 1), 'base64').byteLength
        if (buffers.includes(dependency) && size < (dependency.byteLength as number)) reject('Truncated glTF embedded buffer.')
        continue
      }
      const decoded = decodeURIComponent(dependency.uri)
      if (!decoded || /[\\:?#]/.test(decoded) || hasControlCharacter(decoded) || decoded.startsWith('/') || decoded.split('/').some((part) => !part || part === '.' || part === '..') || /%2e|%2f|%5c/i.test(decoded)) reject('Unsafe glTF dependency URI.')
      const dependencyPath = relative(workspace, resolve(workspace, dirname(path), decoded)).split(sep).join('/')
      const dependencyFile = await readSource(workspace, dependencyPath, deadline, false)
      if (buffers.includes(dependency) && dependencyFile.file.byteLength < (dependency.byteLength as number)) reject('Truncated glTF external buffer.')
      if (!files.some((file) => file.path === dependencyPath)) files.push(dependencyFile.file)
    }
  }
  if (files.reduce((sum, file) => sum + file.byteLength, 0) > MAX_SOURCE_BYTES) reject('The complete asset exceeds its byte budget.')
  // A final fresh identity check makes concurrent replacement/change fail at the observed boundary.
  for (const file of files) if (identity(await safeStat(workspace, file.path)) !== file.identity) reject('Asset changed during source observation.')
  return { workspacePath: path, format, files, fingerprint: digest(JSON.stringify([format, files])) }
}
export async function revalidateWorldAiSource(workspace: string, proof: WorldAiSourceProof): Promise<void> {
  const fresh = await observeWorldAiSource(workspace, proof.workspacePath)
  if (fresh.format !== proof.format || fresh.fingerprint !== proof.fingerprint) reject('The observed asset bytes, type, or dependencies changed.')
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function identity(value: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string { return JSON.stringify([value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs]) }
async function safeStat(workspace: string, path: string) {
  const normalized = normalizeWorldWorkspacePath(path)
  if (!normalized) reject('Unsafe workspace-relative source.')
  let current = workspace
  const root = await lstat(workspace)
  if (!root.isDirectory() || root.isSymbolicLink()) reject('Unsafe source root.')
  const segments = normalized.split('/')
  for (const [index, part] of segments.entries()) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink() || (index === segments.length - 1 ? !info.isFile() : !info.isDirectory())) reject('Asset source is not a confined regular file.')
  }
  const actual = await realpath(current)
  if (relative(workspace, actual).startsWith(`..${sep}`) || actual === workspace || actual !== resolve(workspace, normalized)) reject('Asset source escaped its workspace.')
  return lstat(current)
}
async function readSource(workspace: string, path: string, deadline: number, prefix: boolean): Promise<{ file: SourceFile; prefix: Buffer }> {
  const before = await safeStat(workspace, path)
  if (before.size < 1 || before.size > MAX_SOURCE_BYTES || Date.now() >= deadline) reject('Asset source exceeds its read limits.')
  const handle = await open(resolve(workspace, path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const start = await handle.stat()
    if (identity(start) !== identity(before)) reject('Asset replaced before reading.')
    const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(256 * 1024); const chunks: Buffer[] = []
    let offset = 0
    while (offset < start.size) {
      if (Date.now() >= deadline) reject('Asset read exceeded its deadline.')
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, start.size - offset), offset)
      if (!bytesRead) reject('Truncated asset source.')
      hash.update(buffer.subarray(0, bytesRead))
      if (prefix && offset < 64 * 1024) chunks.push(Buffer.from(buffer.subarray(0, Math.min(bytesRead, 64 * 1024 - offset))))
      offset += bytesRead
    }
    if (identity(await handle.stat()) !== identity(start) || identity(await safeStat(workspace, path)) !== identity(start)) reject('Asset changed while reading.')
    return { file: { path, sha256: hash.digest('hex'), byteLength: offset, identity: identity(start) }, prefix: Buffer.concat(chunks) }
  } finally { await handle.close() }
}
async function readSourceRange(workspace: string, path: string, offset: number, length: number, expected: string, deadline: number): Promise<Buffer> {
  if (length > MAX_JSON_BYTES || Date.now() >= deadline) reject('Asset metadata read exceeds its limit.')
  const before = await safeStat(workspace, path)
  const handle = await open(resolve(workspace, path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (identity(before) !== expected || identity(await handle.stat()) !== expected || offset + length > before.size) reject('Asset changed before metadata read.')
    const bytes = Buffer.alloc(length); let read = 0
    while (read < length) {
      if (Date.now() >= deadline) reject('Metadata read exceeded its deadline.')
      const result = await handle.read(bytes, read, length - read, offset + read)
      if (!result.bytesRead) reject('Truncated asset metadata.'); read += result.bytesRead
    }
    if (identity(await handle.stat()) !== expected) reject('Asset changed during metadata read.')
    return bytes
  } finally { await handle.close() }
}
function reject(message: string): never { throw new WorldAiContractError('invalid_command', message) }
