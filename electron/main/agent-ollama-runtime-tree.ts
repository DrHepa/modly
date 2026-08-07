import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 512,
  maxLogicalBytes: 8 * 1024 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxMetadataBytes: 1024 * 1024,
  maxDepth: 8,
  maxRelativePathBytes: 1024,
  maxSymlinkTargetBytes: 1024,
})
const HARD_LIMITS = Object.freeze({
  maxEntries: 4_096,
  maxLogicalBytes: 16 * 1024 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024 * 1024,
  maxMetadataBytes: 4 * 1024 * 1024,
  maxDepth: 32,
  maxRelativePathBytes: 4_096,
  maxSymlinkTargetBytes: 4_096,
})

export interface AgentOllamaRuntimeTreeLimits {
  maxEntries?: number
  maxLogicalBytes?: number
  maxFileBytes?: number
  maxMetadataBytes?: number
  maxDepth?: number
  maxRelativePathBytes?: number
  maxSymlinkTargetBytes?: number
}

interface NormalizedLimits {
  maxEntries: number
  maxLogicalBytes: number
  maxFileBytes: number
  maxMetadataBytes: number
  maxDepth: number
  maxRelativePathBytes: number
  maxSymlinkTargetBytes: number
}

export interface AgentOllamaRuntimeTreeEntryIdentity {
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
  symlinkTarget?: string
  resolvedTarget?: string
}

export interface AgentOllamaRuntimeTreeIdentity {
  ownerUid: number
  entryCount: number
  logicalBytes: number
  metadataBytes: number
  metadataDigest: string
  entries: readonly Readonly<AgentOllamaRuntimeTreeEntryIdentity>[]
}

export interface OpenAgentOllamaRuntimeTree {
  readonly path: string
  readonly handle: FileHandle
  readonly identity: Readonly<AgentOllamaRuntimeTreeIdentity>
  revalidate(): Promise<void>
  close(): Promise<void>
}

export class AgentOllamaRuntimeTreeError extends Error {
  readonly code: 'runtime_unavailable' | 'runtime_stale'

  constructor(code: AgentOllamaRuntimeTreeError['code']) {
    super(code)
    this.name = 'AgentOllamaRuntimeTreeError'
    this.code = code
  }
}

function normalizeLimits(value: AgentOllamaRuntimeTreeLimits | undefined): NormalizedLimits {
  if (value && (typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !Object.hasOwn(DEFAULT_LIMITS, key)))) {
    throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
  }
  const result = { ...DEFAULT_LIMITS }
  const mutable = result as Record<keyof NormalizedLimits, number>
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof NormalizedLimits>) {
    const candidate = value?.[key]
    if (candidate === undefined) continue
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > HARD_LIMITS[key]) {
      throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
    }
    mutable[key] = candidate
  }
  return result
}

function safeNumber(value: bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
  return result
}

function identity(
  relativePath: string,
  kind: AgentOllamaRuntimeTreeEntryIdentity['kind'],
  info: BigIntStats,
): AgentOllamaRuntimeTreeEntryIdentity {
  return {
    relativePath,
    kind,
    device: info.dev.toString(),
    inode: info.ino.toString(),
    uid: safeNumber(info.uid),
    gid: safeNumber(info.gid),
    mode: Number(info.mode & 0o7777n),
    size: safeNumber(info.size),
    nlink: safeNumber(info.nlink),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
  }
}

function statMatches(info: BigIntStats, expected: AgentOllamaRuntimeTreeEntryIdentity): boolean {
  const kindMatches = expected.kind === 'directory' ? info.isDirectory() && !info.isSymbolicLink()
    : expected.kind === 'file' ? info.isFile() && !info.isSymbolicLink()
      : info.isSymbolicLink()
  return kindMatches
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

function outside(root: string, candidate: string): boolean {
  const local = relative(root, candidate)
  return isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)
}

function metadataDigest(entries: readonly AgentOllamaRuntimeTreeEntryIdentity[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

async function scanRuntimeTree(
  root: string,
  limits: NormalizedLimits,
  expectedOwnerUid?: number,
): Promise<AgentOllamaRuntimeTreeIdentity> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
  const rootInfo = await lstat(root, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o022n) !== 0n) {
    throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
  }
  const ownerUid = safeNumber(rootInfo.uid)
  if (ownerUid !== 0 && ownerUid !== uid || expectedOwnerUid !== undefined && ownerUid !== expectedOwnerUid) {
    throw new AgentOllamaRuntimeTreeError(expectedOwnerUid === undefined ? 'runtime_unavailable' : 'runtime_stale')
  }
  const rootDevice = rootInfo.dev.toString()
  const entries: AgentOllamaRuntimeTreeEntryIdentity[] = []
  let logicalBytes = 0
  let metadataBytes = 0

  const visit = async (absolutePath: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth || Buffer.byteLength(relativePath, 'utf8') > limits.maxRelativePathBytes
      || entries.length >= limits.maxEntries) {
      throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
    }
    const before = await lstat(absolutePath, { bigint: true })
    let kind: AgentOllamaRuntimeTreeEntryIdentity['kind']
    if (before.isDirectory() && !before.isSymbolicLink()) kind = 'directory'
    else if (before.isFile() && !before.isSymbolicLink()) kind = 'file'
    else if (before.isSymbolicLink()) kind = 'symlink'
    else throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
    const entry = identity(relativePath, kind, before)
    if (entry.device !== rootDevice || entry.uid !== ownerUid
      || kind !== 'symlink' && (entry.mode & 0o022) !== 0) {
      throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
    }

    if (kind === 'file') {
      if (entry.nlink !== 1 || entry.size > limits.maxFileBytes) {
        throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
      }
      logicalBytes += entry.size
      if (!Number.isSafeInteger(logicalBytes) || logicalBytes > limits.maxLogicalBytes
        || typeof constants.O_NOFOLLOW !== 'number') {
        throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
      }
      const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await handle.stat({ bigint: true })
        if (!statMatches(opened, entry)) throw new AgentOllamaRuntimeTreeError('runtime_stale')
      } finally {
        await handle.close().catch(() => undefined)
      }
    } else if (kind === 'symlink') {
      const target = await readlink(absolutePath)
      if (isAbsolute(target) || Buffer.byteLength(target, 'utf8') < 1
        || Buffer.byteLength(target, 'utf8') > limits.maxSymlinkTargetBytes) {
        throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
      }
      const lexicalTarget = resolve(dirname(absolutePath), target)
      if (outside(root, lexicalTarget)) throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
      const resolved = await realpath(absolutePath)
      if (outside(root, resolved)) throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
      const resolvedInfo = await lstat(resolved, { bigint: true })
      if (!resolvedInfo.isFile() || resolvedInfo.isSymbolicLink() || resolvedInfo.dev.toString() !== rootDevice
        || Number(resolvedInfo.uid) !== ownerUid || (resolvedInfo.mode & 0o022n) !== 0n) {
        throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
      }
      entry.symlinkTarget = target
      entry.resolvedTarget = relative(root, resolved).split(sep).join('/')
    }

    const after = await lstat(absolutePath, { bigint: true })
    if (!statMatches(after, entry)) throw new AgentOllamaRuntimeTreeError('runtime_stale')
    entries.push(entry)
    metadataBytes += Buffer.byteLength(JSON.stringify(entry), 'utf8')
    if (!Number.isSafeInteger(metadataBytes) || metadataBytes > limits.maxMetadataBytes) {
      throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
    }
    if (kind === 'directory') {
      const children = (await readdir(absolutePath)).sort((left, right) => left.localeCompare(right))
      for (const child of children) {
        await visit(join(absolutePath, child), relativePath === '.' ? child : `${relativePath}/${child}`, depth + 1)
      }
      const directoryAfter = await lstat(absolutePath, { bigint: true })
      if (!statMatches(directoryAfter, entry)) throw new AgentOllamaRuntimeTreeError('runtime_stale')
    }
  }

  await visit(root, '.', 0)
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const runner = entries.find((entry) => entry.relativePath === 'llama-server')
  if (!runner || runner.kind !== 'file' || (runner.mode & 0o111) === 0) {
    throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
  }
  return Object.freeze({
    ownerUid,
    entryCount: entries.length,
    logicalBytes,
    metadataBytes,
    metadataDigest: metadataDigest(entries),
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
  })
}

function sameIdentity(left: AgentOllamaRuntimeTreeIdentity, right: AgentOllamaRuntimeTreeIdentity): boolean {
  return left.ownerUid === right.ownerUid && left.entryCount === right.entryCount
    && left.logicalBytes === right.logicalBytes && left.metadataBytes === right.metadataBytes
    && left.metadataDigest === right.metadataDigest
}

export async function openAgentOllamaRuntimeTree(
  path: string,
  options: { limits?: AgentOllamaRuntimeTreeLimits } = {},
): Promise<OpenAgentOllamaRuntimeTree> {
  if (process.platform !== 'linux' || typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
    || typeof constants.O_DIRECTORY !== 'number' || typeof constants.O_NOFOLLOW !== 'number') {
    throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
  }
  const limits = normalizeLimits(options.limits)
  let handle: FileHandle | undefined
  try {
    if (await realpath(path) !== path) throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const tree = await scanRuntimeTree(path, limits)
    const rootEntry = tree.entries.find((entry) => entry.relativePath === '.')
    if (!rootEntry || !statMatches(await handle.stat({ bigint: true }), rootEntry)) {
      throw new AgentOllamaRuntimeTreeError('runtime_stale')
    }
    let closePromise: Promise<void> | undefined
    const opened: OpenAgentOllamaRuntimeTree = {
      path,
      handle,
      identity: tree,
      revalidate: async () => {
        if (closePromise) throw new AgentOllamaRuntimeTreeError('runtime_stale')
        try {
          if (await realpath(path) !== path) throw new AgentOllamaRuntimeTreeError('runtime_stale')
          const [byHandle, byPath, current] = await Promise.all([
            handle!.stat({ bigint: true }),
            lstat(path, { bigint: true }),
            scanRuntimeTree(path, limits, tree.ownerUid),
          ])
          if (!statMatches(byHandle, rootEntry) || !statMatches(byPath, rootEntry) || !sameIdentity(tree, current)) {
            throw new AgentOllamaRuntimeTreeError('runtime_stale')
          }
        } catch {
          throw new AgentOllamaRuntimeTreeError('runtime_stale')
        }
      },
      close: () => {
        closePromise ??= handle!.close().catch(() => undefined)
        return closePromise
      },
    }
    return Object.freeze(opened)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (error instanceof AgentOllamaRuntimeTreeError) throw error
    throw new AgentOllamaRuntimeTreeError('runtime_unavailable')
  }
}
