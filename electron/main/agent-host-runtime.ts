import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { canonicalJson, sha256Canonical } from './agent-trust-contracts.ts'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const MAX_TREE_ENTRIES = 8_192
const MAX_TREE_LOGICAL_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TREE_METADATA_BYTES = 8 * 1024 * 1024
const MAX_TREE_DEPTH = 32
const MAX_RELATIVE_PATH_BYTES = 4_096
const MAX_SYMLINK_TARGET_BYTES = 4_096

export interface AgentHostRuntimeDefinition {
  id: string
  rootPath: string
  ownerPolicy?: 'trusted-non-current'
}

export interface AgentHostRuntimeRegistry {
  readonly definitions: ReadonlyMap<string, Readonly<AgentHostRuntimeDefinition>>
}

export interface AgentHostRuntimeDeclaration {
  id: string
  executable: string
}

export interface AgentHostRuntimeTreeEntryIdentity {
  relativePath: string
  kind: 'directory' | 'file' | 'symlink'
  device: string
  inode: string
  uid: number
  gid: number
  mode: number
  size: number
  nlink: number
  mtimeNs: string
  ctimeNs: string
  sha256?: string
  symlinkTarget?: string
  resolvedTarget?: string
}

export interface AgentHostRuntimeTreeIdentity {
  ownerUid: number
  entryCount: number
  logicalBytes: number
  metadataBytes: number
  metadataDigest: string
  treeDigest: string
  entries: readonly Readonly<AgentHostRuntimeTreeEntryIdentity>[]
}

export interface AgentHostRuntimeFileIdentity {
  relativePath: string
  realPath: string
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

export interface AgentHostRuntimeRootIdentity {
  realPath: string
  device: string
  inode: string
  uid: number
  gid: number
  mode: number
  size: number
  nlink: number
  mtimeNs: string
  ctimeNs: string
}

export interface BoundAgentHostRuntime {
  id: string
  root: AgentHostRuntimeRootIdentity
  executable: AgentHostRuntimeFileIdentity
  tree: AgentHostRuntimeTreeIdentity
  bindingHash: string
}

export interface OpenAgentHostRuntime {
  binding: BoundAgentHostRuntime
  rootHandle: FileHandle
  executableHandle: FileHandle
}

export class AgentHostRuntimeError extends Error {
  readonly code: 'invalid_registry' | 'runtime_unavailable' | 'runtime_stale'

  constructor(code: AgentHostRuntimeError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AgentHostRuntimeError'
    this.code = code
  }
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new AgentHostRuntimeError('invalid_registry', `${label} is invalid`)
  }
  return value
}

export function normalizeAgentHostRuntimeRelativePath(value: unknown, label = 'Host runtime executable'): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.trim() !== value
    || isAbsolute(value) || value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value)
    || /[\0\r\n\\*?<>:"|]/.test(value)) {
    throw new AgentHostRuntimeError('invalid_registry', `${label} must be a safe runtime-relative path`)
  }
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
    || WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment))) {
    throw new AgentHostRuntimeError('invalid_registry', `${label} contains an unsafe segment`)
  }
  return segments.join('/')
}

export function createAgentHostRuntimeRegistry(
  definitions: readonly AgentHostRuntimeDefinition[],
): AgentHostRuntimeRegistry {
  const map = new Map<string, Readonly<AgentHostRuntimeDefinition>>()
  for (const raw of definitions) {
    if (!raw || typeof raw !== 'object' || Object.keys(raw).some((key) => !['id', 'rootPath', 'ownerPolicy'].includes(key))) {
      throw new AgentHostRuntimeError('invalid_registry', 'Host runtime definition contains an unknown field')
    }
    const id = safeId(raw.id, 'Host runtime id')
    if (!isAbsolute(raw.rootPath) || resolve(raw.rootPath) !== raw.rootPath) {
      throw new AgentHostRuntimeError('invalid_registry', 'Host runtime root must be a canonical absolute configured path')
    }
    if (raw.ownerPolicy !== undefined && raw.ownerPolicy !== 'trusted-non-current') {
      throw new AgentHostRuntimeError('invalid_registry', 'Host runtime owner policy is invalid')
    }
    if (map.has(id)) throw new AgentHostRuntimeError('invalid_registry', 'Host runtime id is duplicated')
    map.set(id, Object.freeze({ id, rootPath: raw.rootPath, ownerPolicy: 'trusted-non-current' as const }))
  }
  return Object.freeze({ definitions: map })
}

export function createDefaultAgentHostRuntimeRegistry(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): AgentHostRuntimeRegistry {
  if (platform !== 'linux' || arch !== 'arm64') return createAgentHostRuntimeRegistry([])
  return createAgentHostRuntimeRegistry([{
    id: 'blender-5.2',
    rootPath: '/opt/blender-5.2.0-aarch64',
    ownerPolicy: 'trusted-non-current',
  }])
}

function outside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)
}

function safeInteger(value: bigint, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new AgentHostRuntimeError('runtime_unavailable', `${label} is outside bounds`)
  }
  return number
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
    throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime ownership cannot be established')
  }
  return uid
}

function identityFromStat(relativePath: string, kind: AgentHostRuntimeTreeEntryIdentity['kind'], info: BigIntStats) {
  return {
    relativePath,
    kind,
    device: info.dev.toString(),
    inode: info.ino.toString(),
    uid: safeInteger(info.uid, 'Host runtime uid'),
    gid: safeInteger(info.gid, 'Host runtime gid'),
    mode: Number(info.mode & 0o7777n),
    size: safeInteger(info.size, 'Host runtime entry size'),
    nlink: safeInteger(info.nlink, 'Host runtime link count'),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
  }
}

function metadataEntry(entry: AgentHostRuntimeTreeEntryIdentity): Omit<AgentHostRuntimeTreeEntryIdentity, 'sha256'> {
  const { sha256: _sha256, ...metadata } = entry
  return metadata
}

function statMatchesEntry(info: BigIntStats, entry: AgentHostRuntimeTreeEntryIdentity): boolean {
  const kindMatches = entry.kind === 'file' ? info.isFile() : entry.kind === 'directory' ? info.isDirectory() : info.isSymbolicLink()
  return kindMatches
    && info.dev.toString() === entry.device
    && info.ino.toString() === entry.inode
    && Number(info.uid) === entry.uid
    && Number(info.gid) === entry.gid
    && Number(info.mode & 0o7777n) === entry.mode
    && Number(info.size) === entry.size
    && Number(info.nlink) === entry.nlink
    && info.mtimeNs.toString() === entry.mtimeNs
    && info.ctimeNs.toString() === entry.ctimeNs
}

function rootIdentity(path: string, entry: AgentHostRuntimeTreeEntryIdentity): AgentHostRuntimeRootIdentity {
  return {
    realPath: path,
    device: entry.device,
    inode: entry.inode,
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode,
    size: entry.size,
    nlink: entry.nlink,
    mtimeNs: entry.mtimeNs,
    ctimeNs: entry.ctimeNs,
  }
}

function rootStatMatches(info: BigIntStats, identity: AgentHostRuntimeRootIdentity): boolean {
  return info.isDirectory()
    && info.dev.toString() === identity.device
    && info.ino.toString() === identity.inode
    && Number(info.uid) === identity.uid
    && Number(info.gid) === identity.gid
    && Number(info.mode & 0o7777n) === identity.mode
    && Number(info.size) === identity.size
    && Number(info.nlink) === identity.nlink
    && info.mtimeNs.toString() === identity.mtimeNs
    && info.ctimeNs.toString() === identity.ctimeNs
}

function fileStatMatches(info: BigIntStats, identity: AgentHostRuntimeFileIdentity): boolean {
  return info.isFile()
    && info.dev.toString() === identity.device
    && info.ino.toString() === identity.inode
    && Number(info.uid) === identity.uid
    && Number(info.gid) === identity.gid
    && Number(info.mode & 0o7777n) === identity.mode
    && Number(info.size) === identity.size
    && Number(info.nlink) === identity.nlink
    && info.mtimeNs.toString() === identity.mtimeNs
    && info.ctimeNs.toString() === identity.ctimeNs
}

async function hashHandle(handle: FileHandle, maximumBytes = MAX_TREE_LOGICAL_BYTES): Promise<string> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
    bytes += (chunk as Buffer).byteLength
    if (bytes > maximumBytes) throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime file exceeds its bound')
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function assertTrustedAncestors(rootPath: string, processUid: number): Promise<void> {
  const ancestors: string[] = []
  let cursor = rootPath
  for (;;) {
    ancestors.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  for (const path of ancestors.reverse()) {
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || Number(info.uid) === processUid
      || (Number(info.mode) & 0o022) !== 0) {
      throw new AgentHostRuntimeError(
        'runtime_unavailable',
        'Host runtime ancestors must be non-current-owned and not group/world writable',
      )
    }
  }
}

async function scanAgentHostRuntimeTree(
  rootPath: string,
  options: { currentUid: number, expectedOwnerUid?: number, hashContents: boolean },
): Promise<AgentHostRuntimeTreeIdentity> {
  const rootInfo = await lstat(rootPath, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime root must be a non-symlink directory')
  }
  const ownerUid = safeInteger(rootInfo.uid, 'Host runtime owner uid')
  if (ownerUid === options.currentUid) {
    throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime must not be owned by the current process user')
  }
  if (options.expectedOwnerUid !== undefined && ownerUid !== options.expectedOwnerUid) {
    throw new AgentHostRuntimeError('runtime_stale', 'Host runtime owner changed')
  }

  const entries: AgentHostRuntimeTreeEntryIdentity[] = []
  let logicalBytes = 0
  let metadataBytes = 0
  const visit = async (absolutePath: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH || Buffer.byteLength(relativePath, 'utf8') > MAX_RELATIVE_PATH_BYTES) {
      throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime tree exceeds its depth or path bound')
    }
    if (entries.length >= MAX_TREE_ENTRIES) {
      throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime tree has too many entries')
    }
    const before = await lstat(absolutePath, { bigint: true })
    let kind: AgentHostRuntimeTreeEntryIdentity['kind']
    if (before.isDirectory() && !before.isSymbolicLink()) kind = 'directory'
    else if (before.isFile() && !before.isSymbolicLink()) kind = 'file'
    else if (before.isSymbolicLink()) kind = 'symlink'
    else throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime tree contains a special file')

    const identity: AgentHostRuntimeTreeEntryIdentity = identityFromStat(relativePath, kind, before)
    if (identity.uid !== ownerUid) {
      throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime tree has mixed ownership')
    }
    if (kind !== 'symlink' && (identity.mode & 0o022) !== 0) {
      throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime tree contains a group/world-writable entry')
    }
    if (kind === 'file') {
      logicalBytes += identity.size
      if (!Number.isSafeInteger(logicalBytes) || logicalBytes > MAX_TREE_LOGICAL_BYTES) {
        throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime tree exceeds its logical byte bound')
      }
      if (options.hashContents) {
        if (typeof constants.O_NOFOLLOW !== 'number') {
          throw new AgentHostRuntimeError('runtime_unavailable', 'No-follow file opening is unavailable')
        }
        const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const openedBefore = await handle.stat({ bigint: true })
          if (!statMatchesEntry(openedBefore, identity)) {
            throw new AgentHostRuntimeError('runtime_stale', 'Host runtime entry changed while opening')
          }
          identity.sha256 = await hashHandle(handle, identity.size)
          const openedAfter = await handle.stat({ bigint: true })
          if (!statMatchesEntry(openedAfter, identity)) {
            throw new AgentHostRuntimeError('runtime_stale', 'Host runtime entry changed while hashing')
          }
        } finally {
          await handle.close().catch(() => undefined)
        }
      }
    } else if (kind === 'symlink') {
      const target = await readlink(absolutePath)
      if (Buffer.byteLength(target, 'utf8') > MAX_SYMLINK_TARGET_BYTES || isAbsolute(target)) {
        throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime symlink target is unsafe')
      }
      const lexicalTarget = resolve(dirname(absolutePath), target)
      if (outside(rootPath, lexicalTarget)) {
        throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime symlink escapes its root')
      }
      const resolved = await realpath(absolutePath)
      if (outside(rootPath, resolved)) {
        throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime symlink resolves outside its root')
      }
      identity.symlinkTarget = target
      identity.resolvedTarget = relative(rootPath, resolved).split(sep).join('/') || '.'
    }

    const after = await lstat(absolutePath, { bigint: true })
    if (!statMatchesEntry(after, identity)) {
      throw new AgentHostRuntimeError('runtime_stale', 'Host runtime entry changed during inspection')
    }
    entries.push(identity)
    const encodedBytes = Buffer.byteLength(canonicalJson(metadataEntry(identity)), 'utf8')
    metadataBytes += encodedBytes
    if (!Number.isSafeInteger(metadataBytes) || metadataBytes > MAX_TREE_METADATA_BYTES) {
      throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime metadata exceeds its bound')
    }

    if (kind === 'directory') {
      const children = (await readdir(absolutePath)).sort((left, right) => left.localeCompare(right))
      for (const child of children) {
        const childRelative = relativePath === '.' ? child : `${relativePath}/${child}`
        await visit(join(absolutePath, child), childRelative, depth + 1)
      }
    }
  }

  await visit(rootPath, '.', 0)
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const metadata = entries.map(metadataEntry)
  return {
    ownerUid,
    entryCount: entries.length,
    logicalBytes,
    metadataBytes,
    metadataDigest: sha256Canonical({ schema: 'modly.host-runtime-metadata.v1', entries: metadata }),
    treeDigest: sha256Canonical({ schema: 'modly.host-runtime-tree.v1', entries }),
    entries,
  }
}

export async function inspectAgentHostRuntimeTree(
  rootPathValue: string,
  options: { currentUid: number },
): Promise<AgentHostRuntimeTreeIdentity> {
  if (!isAbsolute(rootPathValue) || !Number.isSafeInteger(options.currentUid) || options.currentUid < 0) {
    throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime inspection arguments are invalid')
  }
  const rootPath = await realpath(rootPathValue)
  if (rootPath !== rootPathValue) throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime root is not canonical')
  return scanAgentHostRuntimeTree(rootPath, { currentUid: options.currentUid, hashContents: true })
}

function sameTreeMetadata(left: AgentHostRuntimeTreeIdentity, right: AgentHostRuntimeTreeIdentity): boolean {
  return left.ownerUid === right.ownerUid
    && left.entryCount === right.entryCount
    && left.logicalBytes === right.logicalBytes
    && left.metadataBytes === right.metadataBytes
    && left.metadataDigest === right.metadataDigest
}

export async function bindAgentHostRuntime(
  registry: AgentHostRuntimeRegistry | undefined,
  declaration: AgentHostRuntimeDeclaration,
): Promise<BoundAgentHostRuntime> {
  const id = safeId(declaration.id, 'Host runtime id')
  const executable = normalizeAgentHostRuntimeRelativePath(declaration.executable)
  const definition = registry?.definitions.get(id)
  if (!definition) throw new AgentHostRuntimeError('runtime_unavailable', 'Named host runtime is not configured')
  try {
    const canonicalRoot = await realpath(definition.rootPath)
    if (canonicalRoot !== definition.rootPath) throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime root is not canonical')
    const processUid = currentUid()
    await assertTrustedAncestors(canonicalRoot, processUid)
    const tree = await scanAgentHostRuntimeTree(canonicalRoot, { currentUid: processUid, hashContents: true })
    const rootEntry = tree.entries.find((entry) => entry.relativePath === '.')
    const executableEntry = tree.entries.find((entry) => entry.relativePath === executable)
    if (!rootEntry || rootEntry.kind !== 'directory' || !executableEntry || executableEntry.kind !== 'file'
      || !executableEntry.sha256 || (executableEntry.mode & 0o111) === 0) {
      throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime executable is missing or unsafe')
    }
    const executablePath = join(canonicalRoot, ...executable.split('/'))
    if (outside(canonicalRoot, executablePath) || await realpath(executablePath) !== executablePath
      || typeof constants.O_NOFOLLOW !== 'number') {
      throw new AgentHostRuntimeError('runtime_unavailable', 'Host runtime executable path is unsafe')
    }
    const handle = await open(executablePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat({ bigint: true })
      if (!statMatchesEntry(before, executableEntry)
        || await hashHandle(handle, executableEntry.size) !== executableEntry.sha256) {
        throw new AgentHostRuntimeError('runtime_stale', 'Host runtime executable identity changed')
      }
      const after = await handle.stat({ bigint: true })
      if (!statMatchesEntry(after, executableEntry)) {
        throw new AgentHostRuntimeError('runtime_stale', 'Host runtime executable changed during verification')
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
    const metadataCheck = await scanAgentHostRuntimeTree(canonicalRoot, {
      currentUid: processUid,
      expectedOwnerUid: tree.ownerUid,
      hashContents: false,
    })
    if (!sameTreeMetadata(tree, metadataCheck)) {
      throw new AgentHostRuntimeError('runtime_stale', 'Host runtime tree changed while its identity was bound')
    }
    const root = rootIdentity(canonicalRoot, rootEntry)
    const file: AgentHostRuntimeFileIdentity = {
      relativePath: executable,
      realPath: executablePath,
      device: executableEntry.device,
      inode: executableEntry.inode,
      uid: executableEntry.uid,
      gid: executableEntry.gid,
      mode: executableEntry.mode,
      size: executableEntry.size,
      nlink: executableEntry.nlink,
      mtimeNs: executableEntry.mtimeNs,
      ctimeNs: executableEntry.ctimeNs,
      sha256: executableEntry.sha256,
    }
    const publicIdentity = {
      schema: 'modly.host-runtime-binding.v1',
      id,
      root: {
        device: root.device, inode: root.inode, uid: root.uid, gid: root.gid, mode: root.mode,
        size: root.size, nlink: root.nlink, mtimeNs: root.mtimeNs, ctimeNs: root.ctimeNs,
      },
      executable: {
        relativePath: file.relativePath, device: file.device, inode: file.inode,
        uid: file.uid, gid: file.gid, mode: file.mode, size: file.size, nlink: file.nlink,
        mtimeNs: file.mtimeNs, ctimeNs: file.ctimeNs, sha256: file.sha256,
      },
      tree: {
        ownerUid: tree.ownerUid,
        entryCount: tree.entryCount,
        logicalBytes: tree.logicalBytes,
        metadataBytes: tree.metadataBytes,
        metadataDigest: tree.metadataDigest,
        treeDigest: tree.treeDigest,
      },
    }
    return { id, root, executable: file, tree, bindingHash: sha256Canonical(publicIdentity) }
  } catch (error) {
    if (error instanceof AgentHostRuntimeError) throw error
    throw new AgentHostRuntimeError('runtime_unavailable', 'Named host runtime could not be bound', error)
  }
}

export async function openBoundAgentHostRuntime(binding: BoundAgentHostRuntime): Promise<OpenAgentHostRuntime> {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') {
    throw new AgentHostRuntimeError('runtime_unavailable', 'No-follow directory opening is unavailable')
  }
  const handles: FileHandle[] = []
  try {
    const rootHandle = await open(binding.root.realPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.push(rootHandle)
    const executableHandle = await open(binding.executable.realPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    handles.push(executableHandle)
    const opened = { binding, rootHandle, executableHandle }
    await revalidateOpenAgentHostRuntime(opened)
    return opened
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)))
    if (error instanceof AgentHostRuntimeError) throw error
    throw new AgentHostRuntimeError('runtime_stale', 'Named host runtime could not be opened', error)
  }
}

export async function revalidateOpenAgentHostRuntime(opened: OpenAgentHostRuntime): Promise<void> {
  try {
    const processUid = currentUid()
    await assertTrustedAncestors(opened.binding.root.realPath, processUid)
    const root = await opened.rootHandle.stat({ bigint: true })
    const before = await opened.executableHandle.stat({ bigint: true })
    if (!rootStatMatches(root, opened.binding.root) || !fileStatMatches(before, opened.binding.executable)
      || await hashHandle(opened.executableHandle, opened.binding.executable.size) !== opened.binding.executable.sha256) {
      throw new AgentHostRuntimeError('runtime_stale', 'Named host runtime identity changed')
    }
    const metadata = await scanAgentHostRuntimeTree(opened.binding.root.realPath, {
      currentUid: processUid,
      expectedOwnerUid: opened.binding.tree.ownerUid,
      hashContents: false,
    })
    if (!sameTreeMetadata(opened.binding.tree, metadata)) {
      throw new AgentHostRuntimeError('runtime_stale', 'Named host runtime tree identity changed')
    }
    const after = await opened.executableHandle.stat({ bigint: true })
    if (!fileStatMatches(after, opened.binding.executable)) {
      throw new AgentHostRuntimeError('runtime_stale', 'Named host runtime changed during verification')
    }
  } catch (error) {
    if (error instanceof AgentHostRuntimeError) throw error
    throw new AgentHostRuntimeError('runtime_stale', 'Named host runtime could not be revalidated', error)
  }
}

export async function closeOpenAgentHostRuntime(opened: OpenAgentHostRuntime | undefined): Promise<void> {
  if (!opened) return
  await Promise.all([
    opened.rootHandle.close().catch(() => undefined),
    opened.executableHandle.close().catch(() => undefined),
  ])
}
