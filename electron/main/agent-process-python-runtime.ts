import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import type {
  AgentProcessPythonBaseInterpreterIdentityV1,
  AgentProcessPythonRuntimeBindingV1,
  AgentProcessPythonRuntimeDeclarationV1,
} from '../../src/shared/types/agentActions.ts'
import { normalizeAgentHostRuntimeRelativePath } from './agent-host-runtime.ts'
import { canonicalJson, sha256Canonical } from './agent-trust-contracts.ts'

const MAX_TREE_ENTRIES = 32_768
const MAX_TREE_LOGICAL_BYTES = 4 * 1024 * 1024 * 1024
const MAX_TREE_DEPTH = 64
const MAX_RELATIVE_PATH_BYTES = 4_096
const MAX_CACHE_ENTRIES_PER_SWEEP = 128
const MAX_COMPLETED_SNAPSHOTS = 8
const SHA256 = /^[a-f0-9]{64}$/
const SNAPSHOT_MODE_DIRECTORY = 0o500
const SNAPSHOT_MODE_FILE = 0o400
const SNAPSHOT_MODE_EXECUTABLE = 0o500
const FIXED_HOST_ENV = Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })

type RuntimeEntryKind = 'directory' | 'file' | 'symlink'

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

interface RuntimeTreeEntry {
  relativePath: string
  kind: RuntimeEntryKind
  device: string
  inode: string
  uid: number
  gid: number
  mode: number
  size: number
  nlink: number
  mtimeNs: string
  ctimeNs: string
  snapshotMode: number
  sha256?: string
  linkTarget?: string
  materializeBase?: boolean
}

interface RuntimeTreeScan {
  rootPath: string
  entryCount: number
  logicalBytes: number
  treeDigest: string
  sourceIdentityHash: string
  entries: RuntimeTreeEntry[]
}

export interface PreparedExtensionPythonRuntime {
  binding: AgentProcessPythonRuntimeBindingV1
  rootPath: string
  interpreterPath: string
  release: () => void
}

export interface ExtensionPythonSandboxLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: '/'
  shell: false
}

export interface OpenTrustedProcessExecutable {
  handle: FileHandle
  device: string
  inode: string
  mode: number
  size: number
  mtimeNs: string
  ctimeNs: string
  sha256: string
}

interface OpenTrustedBaseInterpreter extends OpenTrustedProcessExecutable {
  canonicalPath: string
  uid: number
  gid: number
  nlink: number
}

const activeSnapshotLeases = new Map<string, number>()
const preparedSnapshotLeases = new Map<string, number>()
const snapshotPreparationTails = new Map<string, Promise<void>>()

export class AgentProcessPythonRuntimeError extends Error {
  readonly code: 'runtime_unavailable' | 'runtime_stale'

  constructor(code: AgentProcessPythonRuntimeError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AgentProcessPythonRuntimeError'
    this.code = code
  }
}

function outside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)
}

function safeInteger(value: bigint, label: string): number {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', `${label} is outside bounds`)
  }
  return normalized
}

function normalizeInterpreter(value: unknown): 'bin/python' {
  let normalized: string
  try { normalized = normalizeAgentHostRuntimeRelativePath(value, 'Extension Python interpreter') } catch (error) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python interpreter is unsafe', error)
  }
  if (normalized !== 'bin/python') {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python interpreter must be bin/python')
  }
  return 'bin/python'
}

function statMatches(info: BigIntStats, entry: RuntimeTreeEntry): boolean {
  const kindMatches = entry.kind === 'directory' ? info.isDirectory() && !info.isSymbolicLink()
    : entry.kind === 'file' ? info.isFile() && !info.isSymbolicLink()
      : info.isSymbolicLink()
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

async function hashHandle(handle: FileHandle, maximumBytes: number): Promise<string> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
    bytes += (chunk as Buffer).byteLength
    if (bytes > maximumBytes) {
      throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime exceeds its byte bound')
    }
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function portableEntry(entry: RuntimeTreeEntry) {
  if (entry.materializeBase) throw new Error('Base materialization requires an explicit identity')
  return {
    relativePath: entry.relativePath,
    kind: entry.kind,
    ...(entry.kind === 'symlink' ? { target: entry.linkTarget } : { mode: entry.snapshotMode }),
    size: entry.kind === 'file' ? entry.size : 0,
    ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
  }
}

async function scanRuntimeTree(rootValue: string, snapshot: boolean): Promise<RuntimeTreeScan> {
  if (!isAbsolute(rootValue) || typeof constants.O_NOFOLLOW !== 'number') {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime root is invalid')
  }
  const rootPath = await realpath(rootValue).catch((error) => {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime is missing', error)
  })
  if (rootPath !== resolve(rootValue)) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime root must not be a link')
  }
  const rootInfo = await lstat(rootPath, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime root is invalid')
  }
  const ownerUid = safeInteger(rootInfo.uid, 'Runtime owner uid')
  const ownerGid = safeInteger(rootInfo.gid, 'Runtime owner gid')
  const entries: RuntimeTreeEntry[] = []
  let logicalBytes = 0
  const visit = async (absolutePath: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH || Buffer.byteLength(relativePath) > MAX_RELATIVE_PATH_BYTES
      || entries.length >= MAX_TREE_ENTRIES) {
      throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime tree exceeds its bounds')
    }
    const before = await lstat(absolutePath, { bigint: true })
    const kind: RuntimeEntryKind = before.isSymbolicLink() ? 'symlink'
      : before.isDirectory() ? 'directory' : before.isFile() ? 'file' : (() => {
      throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime contains a special file')
    })()
    const mode = Number(before.mode & 0o7777n)
    const entry: RuntimeTreeEntry = {
      relativePath, kind,
      device: before.dev.toString(), inode: before.ino.toString(),
      uid: safeInteger(before.uid, 'Runtime uid'), gid: safeInteger(before.gid, 'Runtime gid'),
      mode, size: safeInteger(before.size, 'Runtime size'), nlink: safeInteger(before.nlink, 'Runtime link count'),
      mtimeNs: before.mtimeNs.toString(), ctimeNs: before.ctimeNs.toString(),
      snapshotMode: kind === 'directory' ? SNAPSHOT_MODE_DIRECTORY
        : kind === 'file' && (mode & 0o111) !== 0 ? SNAPSHOT_MODE_EXECUTABLE : SNAPSHOT_MODE_FILE,
    }
    if (entry.uid !== ownerUid || entry.gid !== ownerGid
      || (kind !== 'symlink' && ((mode & 0o002) !== 0 || (mode & 0o7000) !== 0))
      || ((kind === 'file' || kind === 'symlink') && entry.nlink !== 1)) {
      throw new AgentProcessPythonRuntimeError(
        'runtime_unavailable',
        'Extension Python runtime must use one cooperative owner/group, reject world-write and special bits, and be free of hardlinks',
      )
    }
    if (snapshot && kind !== 'symlink' && mode !== entry.snapshotMode) {
      throw new AgentProcessPythonRuntimeError('runtime_stale', 'Private Python runtime snapshot permissions changed')
    }
    if (kind === 'symlink') {
      const target = await readlink(absolutePath)
      if (!target || target.includes('\0') || Buffer.byteLength(target) > MAX_RELATIVE_PATH_BYTES) {
        throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime link target is invalid')
      }
      entry.linkTarget = target
    } else if (kind === 'file') {
      logicalBytes += entry.size
      if (!Number.isSafeInteger(logicalBytes) || logicalBytes > MAX_TREE_LOGICAL_BYTES) {
        throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime exceeds its byte bound')
      }
      const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await handle.stat({ bigint: true })
        if (!statMatches(opened, entry)) throw new AgentProcessPythonRuntimeError('runtime_stale', 'Runtime changed while opening')
        entry.sha256 = await hashHandle(handle, entry.size)
        if (!statMatches(await handle.stat({ bigint: true }), entry)) {
          throw new AgentProcessPythonRuntimeError('runtime_stale', 'Runtime changed while hashing')
        }
      } finally {
        await handle.close().catch(() => undefined)
      }
    }
    entries.push(entry)
    if (kind === 'directory') {
      const children = (await readdir(absolutePath)).sort(compareText)
      for (const child of children) {
        await visit(join(absolutePath, child), relativePath === '.' ? child : `${relativePath}/${child}`, depth + 1)
      }
    }
    if (!statMatches(await lstat(absolutePath, { bigint: true }), entry)
      || (kind === 'symlink' && await readlink(absolutePath) !== entry.linkTarget)) {
      throw new AgentProcessPythonRuntimeError('runtime_stale', 'Runtime changed during inspection')
    }
  }
  await visit(rootPath, '.', 0)
  entries.sort((left, right) => compareText(left.relativePath, right.relativePath))
  const portable = entries.map(portableEntry)
  return {
    rootPath,
    entryCount: entries.length,
    logicalBytes,
    treeDigest: sha256Canonical({ schema: 'modly.extension-python-runtime-tree.v1', entries: portable }),
    sourceIdentityHash: sha256Canonical({ schema: 'modly.extension-python-runtime-source.v1', entries }),
    entries,
  }
}

function internalLinkTarget(entry: RuntimeTreeEntry): string | undefined {
  if (entry.kind !== 'symlink' || !entry.linkTarget || posix.isAbsolute(entry.linkTarget)) return undefined
  const target = posix.normalize(posix.join(posix.dirname(entry.relativePath), entry.linkTarget))
  return target === '..' || target.startsWith('../') || posix.isAbsolute(target) ? undefined : target
}

function assertInternalLinks(entries: RuntimeTreeEntry[]): void {
  const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]))
  for (const origin of entries) {
    if (origin.kind !== 'symlink') continue
    const seen = new Set<string>()
    let current = origin
    while (current.kind === 'symlink' && !current.materializeBase) {
      if (seen.has(current.relativePath)) {
        throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime contains a link cycle')
      }
      seen.add(current.relativePath)
      const target = internalLinkTarget(current)
      const next = target ? byPath.get(target) : undefined
      if (!next) {
        throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime link escapes or is dangling')
      }
      current = next
    }
  }
}

async function finalizeSourceScan(
  scan: RuntimeTreeScan,
  interpreter: string,
  base: OpenTrustedBaseInterpreter,
): Promise<RuntimeTreeScan> {
  const byPath = new Map(scan.entries.map((entry) => [entry.relativePath, entry]))
  const seen = new Set<string>()
  let current = byPath.get(interpreter)
  if (!current) throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python interpreter is missing')
  while (current.kind === 'symlink') {
    if (seen.has(current.relativePath)) {
      throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python interpreter link contains a cycle')
    }
    seen.add(current.relativePath)
    const target = internalLinkTarget(current)
    if (target) {
      current = byPath.get(target)
      if (!current) throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python interpreter link is dangling')
      continue
    }
    const resolved = await realpath(join(scan.rootPath, ...current.relativePath.split('/'))).catch(() => undefined)
    if (resolved !== base.canonicalPath) {
      throw new AgentProcessPythonRuntimeError(
        'runtime_unavailable',
        'Extension Python interpreter does not resolve to the selected trusted base',
      )
    }
    current.materializeBase = true
    break
  }
  if (!current.materializeBase) {
    throw new AgentProcessPythonRuntimeError(
      'runtime_unavailable',
      'Extension Python interpreter must terminate at the selected trusted base',
    )
  }
  assertInternalLinks(scan.entries)
  const logicalBytes = scan.logicalBytes + base.size
  if (!Number.isSafeInteger(logicalBytes) || logicalBytes > MAX_TREE_LOGICAL_BYTES) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime exceeds its byte bound')
  }
  const portable = scan.entries.map((entry) => entry.materializeBase ? {
    relativePath: entry.relativePath,
    kind: 'file',
    mode: SNAPSHOT_MODE_EXECUTABLE,
    size: base.size,
    sha256: base.sha256,
  } : portableEntry(entry))
  return {
    ...scan,
    logicalBytes,
    treeDigest: sha256Canonical({ schema: 'modly.extension-python-runtime-tree.v1', entries: portable }),
    sourceIdentityHash: sha256Canonical({ schema: 'modly.extension-python-runtime-source.v1', entries: scan.entries }),
  }
}

async function scanSource(
  extensionDirValue: string,
  interpreter: string,
  base: OpenTrustedBaseInterpreter,
): Promise<RuntimeTreeScan> {
  const extensionDir = await realpath(extensionDirValue).catch((error) => {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension root is unavailable', error)
  })
  if (extensionDir !== resolve(extensionDirValue)) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension root must not be a link')
  }
  const extensionInfo = await lstat(extensionDir, { bigint: true })
  if (!extensionInfo.isDirectory() || extensionInfo.isSymbolicLink()
    || (typeof process.getuid === 'function' && Number(extensionInfo.uid) !== process.getuid())) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension root ownership is unsafe')
  }
  const runtimeRoot = join(extensionDir, 'venv')
  if (outside(extensionDir, runtimeRoot)) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime escaped its extension')
  }
  const scan = await scanRuntimeTree(runtimeRoot, false)
  if (scan.entries[0]?.uid !== Number(extensionInfo.uid) || scan.entries[0]?.gid !== Number(extensionInfo.gid)) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime owner differs from its extension')
  }
  return finalizeSourceScan(scan, interpreter, base)
}

export async function bindExtensionPythonRuntime(
  extensionDir: string,
  declaration: AgentProcessPythonRuntimeDeclarationV1,
  baseInterpreterPath: string,
): Promise<AgentProcessPythonRuntimeBindingV1> {
  if (!declaration || declaration.kind !== 'extension-python-venv-v1') {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime kind is unsupported')
  }
  const interpreter = normalizeInterpreter(declaration.interpreter)
  const base = await openTrustedBaseInterpreter(baseInterpreterPath)
  try {
    const source = await scanSource(extensionDir, interpreter, base)
    const unsigned = {
      kind: declaration.kind,
      interpreter,
      baseInterpreter: baseInterpreterIdentity(base),
      treeDigest: source.treeDigest,
      sourceIdentityHash: source.sourceIdentityHash,
      entryCount: source.entryCount,
      logicalBytes: source.logicalBytes,
    }
    return { ...unsigned, bindingHash: sha256Canonical({ schema: 'modly.extension-python-runtime-binding.v1', ...unsigned }) }
  } finally {
    await base.handle.close().catch(() => undefined)
  }
}

async function assertSourceBinding(
  extensionDir: string,
  binding: AgentProcessPythonRuntimeBindingV1,
  base: OpenTrustedBaseInterpreter,
): Promise<RuntimeTreeScan> {
  assertExtensionPythonRuntimeBinding(binding)
  assertBaseInterpreterIdentity(base, binding.baseInterpreter)
  const source = await scanSource(extensionDir, normalizeInterpreter(binding.interpreter), base)
  if (source.treeDigest !== binding.treeDigest || source.sourceIdentityHash !== binding.sourceIdentityHash
    || source.entryCount !== binding.entryCount || source.logicalBytes !== binding.logicalBytes) {
    throw new AgentProcessPythonRuntimeError('runtime_stale', 'Extension Python runtime changed after approval')
  }
  return source
}

async function ensureCacheRoot(cacheRootValue: string): Promise<string> {
  if (!isAbsolute(cacheRootValue)) throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Snapshot root must be absolute')
  await mkdir(cacheRootValue, { recursive: true, mode: 0o700 })
  await chmod(cacheRootValue, 0o700)
  const cacheRoot = await realpath(cacheRootValue)
  const info = await lstat(cacheRoot, { bigint: true })
  if (cacheRoot !== resolve(cacheRootValue) || !info.isDirectory() || info.isSymbolicLink()
    || Number(info.mode & 0o777n) !== 0o700
    || (typeof process.getuid === 'function' && Number(info.uid) !== process.getuid())) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Snapshot root is not private')
  }
  return cacheRoot
}

async function makeTreeRemovable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => undefined)
  if (!info) return
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await rm(root, { force: true })
    return
  }
  await chmod(root, 0o700).catch(() => undefined)
  for (const child of await readdir(root)) await makeTreeRemovable(join(root, child))
}

async function removePrivateTree(cacheRoot: string, target: string): Promise<void> {
  if (outside(cacheRoot, target) || dirname(target) !== cacheRoot) return
  await makeTreeRemovable(target)
  await rm(target, { recursive: true, force: true })
}

function snapshotKey(cacheRoot: string, digest: string): string {
  return `${cacheRoot}\0${digest}`
}

function acquireSnapshotLease(cacheRoot: string, digest: string): () => void {
  const key = snapshotKey(cacheRoot, digest)
  activeSnapshotLeases.set(key, (activeSnapshotLeases.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = activeSnapshotLeases.get(key) ?? 0
    if (count <= 1) activeSnapshotLeases.delete(key)
    else activeSnapshotLeases.set(key, count - 1)
  }
}

function snapshotIsActive(cacheRoot: string, digest: string): boolean {
  return (activeSnapshotLeases.get(snapshotKey(cacheRoot, digest)) ?? 0) > 0
}

function markSnapshotPrepared(cacheRoot: string, digest: string, releaseLease: () => void): () => void {
  const key = snapshotKey(cacheRoot, digest)
  preparedSnapshotLeases.set(key, (preparedSnapshotLeases.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = preparedSnapshotLeases.get(key) ?? 0
    if (count <= 1) preparedSnapshotLeases.delete(key)
    else preparedSnapshotLeases.set(key, count - 1)
    releaseLease()
  }
}

async function acquireSnapshotPreparation(cacheRoot: string, digest: string): Promise<() => void> {
  const key = snapshotKey(cacheRoot, digest)
  const previous = snapshotPreparationTails.get(key)
  let resolveCurrent!: () => void
  const current = new Promise<void>((resolveCurrentPromise) => { resolveCurrent = resolveCurrentPromise })
  snapshotPreparationTails.set(key, current)
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    if (snapshotPreparationTails.get(key) === current) snapshotPreparationTails.delete(key)
    resolveCurrent()
  }
}

async function sweepCache(cacheRoot: string, retainDigest: string): Promise<void> {
  const names = (await readdir(cacheRoot)).slice(0, MAX_CACHE_ENTRIES_PER_SWEEP)
  const completed: Array<{ name: string, mtimeMs: number }> = []
  for (const name of names) {
    const target = join(cacheRoot, name)
    const info = await lstat(target).catch(() => undefined)
    if (!info) continue
    const partialDigest = name.includes('.partial-') ? name.slice(0, name.indexOf('.partial-')) : undefined
    if (partialDigest && SHA256.test(partialDigest)) {
      if (partialDigest !== retainDigest && snapshotIsActive(cacheRoot, partialDigest)) continue
      await removePrivateTree(cacheRoot, target)
    } else if (SHA256.test(name) && name !== retainDigest && !snapshotIsActive(cacheRoot, name)
      && info.isDirectory() && !info.isSymbolicLink()) {
      completed.push({ name, mtimeMs: info.mtimeMs })
    }
  }
  completed.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const stale of completed.slice(MAX_COMPLETED_SNAPSHOTS - 1)) {
    await removePrivateTree(cacheRoot, join(cacheRoot, stale.name))
  }
}

async function copySourceFile(sourcePath: string, entry: RuntimeTreeEntry, destination: string): Promise<void> {
  const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!statMatches(before, entry)) throw new AgentProcessPythonRuntimeError('runtime_stale', 'Runtime changed before snapshot copy')
    const procPath = `/proc/self/fd/${handle.fd}`
    try {
      await copyFile(procPath, destination, constants.COPYFILE_FICLONE_FORCE)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'EXDEV']).has(code ?? '')) throw error
      await rm(destination, { force: true })
      await copyFile(procPath, destination, constants.COPYFILE_EXCL)
    }
    if (await hashHandle(handle, entry.size) !== entry.sha256
      || !statMatches(await handle.stat({ bigint: true }), entry)) {
      throw new AgentProcessPythonRuntimeError('runtime_stale', 'Runtime changed during snapshot copy')
    }
    await chmod(destination, entry.snapshotMode)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function copyBaseInterpreter(
  base: OpenTrustedBaseInterpreter,
  destination: string,
  expected: AgentProcessPythonBaseInterpreterIdentityV1,
): Promise<void> {
  assertBaseInterpreterIdentity(base, expected)
  const procPath = `/proc/self/fd/${base.handle.fd}`
  try {
    await copyFile(procPath, destination, constants.COPYFILE_FICLONE_FORCE)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'EXDEV']).has(code ?? '')) throw error
    await rm(destination, { force: true })
    await copyFile(procPath, destination, constants.COPYFILE_EXCL)
  }
  await revalidateTrustedProcessExecutable(base)
  await chmod(destination, SNAPSHOT_MODE_EXECUTABLE)
}

async function copySourceLink(
  sourcePath: string,
  entry: RuntimeTreeEntry,
  destination: string,
  base: OpenTrustedBaseInterpreter,
  expectedBase: AgentProcessPythonBaseInterpreterIdentityV1,
): Promise<void> {
  const before = await lstat(sourcePath, { bigint: true })
  const target = await readlink(sourcePath)
  if (!statMatches(before, entry) || target !== entry.linkTarget) {
    throw new AgentProcessPythonRuntimeError('runtime_stale', 'Runtime link changed before snapshot copy')
  }
  if (entry.materializeBase) await copyBaseInterpreter(base, destination, expectedBase)
  else await symlink(target, destination)
  const after = await lstat(sourcePath, { bigint: true })
  if (!statMatches(after, entry) || await readlink(sourcePath) !== target) {
    throw new AgentProcessPythonRuntimeError('runtime_stale', 'Runtime link changed during snapshot copy')
  }
}

function assertSnapshotInterpreter(scan: RuntimeTreeScan, interpreter: string): void {
  assertInternalLinks(scan.entries)
  const byPath = new Map(scan.entries.map((entry) => [entry.relativePath, entry]))
  const seen = new Set<string>()
  let current = byPath.get(interpreter)
  while (current?.kind === 'symlink') {
    if (seen.has(current.relativePath)) {
      throw new AgentProcessPythonRuntimeError('runtime_stale', 'Private Python interpreter link contains a cycle')
    }
    seen.add(current.relativePath)
    const target = internalLinkTarget(current)
    current = target ? byPath.get(target) : undefined
  }
  if (!current || current.kind !== 'file' || (current.mode & 0o111) === 0 || !current.sha256) {
    throw new AgentProcessPythonRuntimeError('runtime_stale', 'Private Python interpreter is missing or not executable')
  }
}

async function verifySnapshot(rootPath: string, binding: AgentProcessPythonRuntimeBindingV1): Promise<void> {
  const snapshot = await scanRuntimeTree(rootPath, true)
  assertSnapshotInterpreter(snapshot, binding.interpreter)
  if (snapshot.treeDigest !== binding.treeDigest || snapshot.entryCount !== binding.entryCount
    || snapshot.logicalBytes !== binding.logicalBytes) {
    throw new AgentProcessPythonRuntimeError('runtime_stale', 'Private Python runtime snapshot does not match its binding')
  }
}

export async function prepareExtensionPythonRuntimeSnapshot(
  extensionDir: string,
  binding: AgentProcessPythonRuntimeBindingV1,
  cacheRootValue: string,
  baseInterpreterPath: string,
): Promise<PreparedExtensionPythonRuntime> {
  const cacheRoot = await ensureCacheRoot(cacheRootValue)
  const releaseLease = acquireSnapshotLease(cacheRoot, binding.treeDigest)
  const releasePreparation = await acquireSnapshotPreparation(cacheRoot, binding.treeDigest)
  let base: OpenTrustedBaseInterpreter | undefined
  try {
    base = await openTrustedBaseInterpreter(baseInterpreterPath)
    const source = await assertSourceBinding(extensionDir, binding, base)
    await sweepCache(cacheRoot, binding.treeDigest)
    const finalRoot = join(cacheRoot, binding.treeDigest)
    try {
      await verifySnapshot(finalRoot, binding)
      return Object.freeze({
        binding,
        rootPath: finalRoot,
        interpreterPath: join(finalRoot, ...binding.interpreter.split('/')),
        release: markSnapshotPrepared(cacheRoot, binding.treeDigest, releaseLease),
      })
    } catch {
      if ((preparedSnapshotLeases.get(snapshotKey(cacheRoot, binding.treeDigest)) ?? 0) > 0) {
        throw new AgentProcessPythonRuntimeError('runtime_stale', 'An active Python runtime snapshot failed verification')
      }
      await removePrivateTree(cacheRoot, finalRoot)
    }
    const partialRoot = join(cacheRoot, `${binding.treeDigest}.partial-${process.pid}-${randomBytes(8).toString('hex')}`)
    await mkdir(partialRoot, { mode: 0o700 })
    try {
      for (const entry of source.entries) {
        if (entry.relativePath === '.') continue
        const sourcePath = join(source.rootPath, ...entry.relativePath.split('/'))
        const destination = join(partialRoot, ...entry.relativePath.split('/'))
        if (outside(source.rootPath, sourcePath) || outside(partialRoot, destination)) {
          throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Runtime snapshot path escaped its root')
        }
        if (entry.kind === 'directory') await mkdir(destination, { mode: 0o700 })
        else if (entry.kind === 'symlink') {
          await copySourceLink(sourcePath, entry, destination, base, binding.baseInterpreter)
        } else await copySourceFile(sourcePath, entry, destination)
      }
      for (const entry of [...source.entries].sort((left, right) => right.relativePath.length - left.relativePath.length)) {
        if (entry.kind !== 'directory') continue
        const target = entry.relativePath === '.' ? partialRoot : join(partialRoot, ...entry.relativePath.split('/'))
        await chmod(target, entry.snapshotMode)
      }
      await assertSourceBinding(extensionDir, binding, base)
      await verifySnapshot(partialRoot, binding)
      try {
        await rename(partialRoot, finalRoot)
      } catch {
        await verifySnapshot(finalRoot, binding)
        await removePrivateTree(cacheRoot, partialRoot)
      }
      await verifySnapshot(finalRoot, binding)
      return Object.freeze({
        binding,
        rootPath: finalRoot,
        interpreterPath: join(finalRoot, ...binding.interpreter.split('/')),
        release: markSnapshotPrepared(cacheRoot, binding.treeDigest, releaseLease),
      })
    } catch (error) {
      await removePrivateTree(cacheRoot, partialRoot).catch(() => undefined)
      if (error instanceof AgentProcessPythonRuntimeError) throw error
      throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Unable to materialize private Python runtime snapshot', error)
    }
  } catch (error) {
    releaseLease()
    if (error instanceof AgentProcessPythonRuntimeError) throw error
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Unable to materialize private Python runtime snapshot', error)
  } finally {
    releasePreparation()
    await base?.handle.close().catch(() => undefined)
  }
}

export async function revalidatePreparedExtensionPythonRuntime(
  extensionDir: string,
  prepared: PreparedExtensionPythonRuntime,
  baseInterpreterPath: string,
): Promise<void> {
  const base = await openTrustedBaseInterpreter(baseInterpreterPath)
  try {
    await assertSourceBinding(extensionDir, prepared.binding, base)
    await verifySnapshot(prepared.rootPath, prepared.binding)
    if (prepared.interpreterPath !== join(prepared.rootPath, ...prepared.binding.interpreter.split('/'))) {
      throw new AgentProcessPythonRuntimeError('runtime_stale', 'Private Python interpreter binding changed')
    }
  } finally {
    await base.handle.close().catch(() => undefined)
  }
}

export async function openTrustedProcessExecutable(pathValue: string): Promise<OpenTrustedProcessExecutable> {
  if (!isAbsolute(pathValue) || typeof constants.O_NOFOLLOW !== 'number') {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Trusted executable path is invalid')
  }
  const pathInfo = await lstat(pathValue)
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || (pathInfo.mode & 0o002) !== 0 || (pathInfo.mode & 0o111) === 0) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Trusted executable identity is unsafe')
  }
  const handle = await open(pathValue, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    const size = safeInteger(before.size, 'Trusted executable size')
    const sha256 = await hashHandle(handle, size)
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new AgentProcessPythonRuntimeError('runtime_stale', 'Trusted executable changed during verification')
    }
    return {
      handle,
      device: before.dev.toString(),
      inode: before.ino.toString(),
      mode: Number(before.mode & 0o7777n),
      size,
      mtimeNs: before.mtimeNs.toString(),
      ctimeNs: before.ctimeNs.toString(),
      sha256,
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function baseInterpreterIdentity(base: OpenTrustedBaseInterpreter): AgentProcessPythonBaseInterpreterIdentityV1 {
  return {
    device: base.device,
    inode: base.inode,
    uid: base.uid,
    gid: base.gid,
    mode: base.mode,
    size: base.size,
    nlink: base.nlink,
    mtimeNs: base.mtimeNs,
    ctimeNs: base.ctimeNs,
    sha256: base.sha256,
  }
}

function assertBaseInterpreterIdentity(
  base: OpenTrustedBaseInterpreter,
  expected: AgentProcessPythonBaseInterpreterIdentityV1,
): void {
  if (canonicalJson(baseInterpreterIdentity(base)) !== canonicalJson(expected)) {
    throw new AgentProcessPythonRuntimeError('runtime_stale', 'Trusted base interpreter changed after approval')
  }
}

async function openTrustedBaseInterpreter(pathValue: string): Promise<OpenTrustedBaseInterpreter> {
  if (!isAbsolute(pathValue) || typeof constants.O_NOFOLLOW !== 'number') {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Trusted base interpreter path is invalid')
  }
  const canonicalPath = await realpath(pathValue).catch((error) => {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Trusted base interpreter is unavailable', error)
  })
  const pathInfo = await lstat(canonicalPath)
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || (pathInfo.mode & 0o022) !== 0
    || (pathInfo.mode & 0o111) === 0 || pathInfo.nlink !== 1) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Trusted base interpreter identity is unsafe')
  }
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    const size = safeInteger(before.size, 'Trusted base interpreter size')
    const sha256 = await hashHandle(handle, size)
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
      || before.size !== after.size || before.nlink !== after.nlink
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new AgentProcessPythonRuntimeError('runtime_stale', 'Trusted base interpreter changed during verification')
    }
    return {
      handle,
      canonicalPath,
      device: before.dev.toString(),
      inode: before.ino.toString(),
      uid: safeInteger(before.uid, 'Trusted base interpreter uid'),
      gid: safeInteger(before.gid, 'Trusted base interpreter gid'),
      mode: Number(before.mode & 0o7777n),
      size,
      nlink: safeInteger(before.nlink, 'Trusted base interpreter link count'),
      mtimeNs: before.mtimeNs.toString(),
      ctimeNs: before.ctimeNs.toString(),
      sha256,
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export async function revalidateTrustedProcessExecutable(executable: OpenTrustedProcessExecutable): Promise<void> {
  const before = await executable.handle.stat({ bigint: true })
  if (!before.isFile() || before.dev.toString() !== executable.device || before.ino.toString() !== executable.inode
    || Number(before.mode & 0o7777n) !== executable.mode || Number(before.size) !== executable.size
    || before.mtimeNs.toString() !== executable.mtimeNs || before.ctimeNs.toString() !== executable.ctimeNs
    || await hashHandle(executable.handle, executable.size) !== executable.sha256) {
    throw new AgentProcessPythonRuntimeError('runtime_stale', 'Trusted executable changed after verification')
  }
  const after = await executable.handle.stat({ bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new AgentProcessPythonRuntimeError('runtime_stale', 'Trusted executable changed during revalidation')
  }
}

export function buildExtensionPythonSandboxLaunch(input: {
  platform: NodeJS.Platform
  bwrapFd: number
  snapshotRootFd: number
  interpreter: string
  entryFd: number
  resourceFds: readonly number[]
  inputFds: readonly number[]
  outputDirFd: number
  systemPaths: readonly string[]
}): ExtensionPythonSandboxLaunch {
  const interpreter = normalizeInterpreter(input.interpreter)
  const fds = [
    input.bwrapFd, input.entryFd, ...input.resourceFds, ...input.inputFds,
    input.snapshotRootFd, input.outputDirFd,
  ]
  if (input.platform !== 'linux' || fds.some((fd) => !Number.isSafeInteger(fd) || fd < 3)
    || new Set(fds).size !== fds.length) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Python sandbox launch is invalid')
  }
  const args = [
    '--die-with-parent', '--unshare-all', '--unshare-user', '--disable-userns',
    '--proc', '/proc', '--dev', '/dev',
    '--size', String(64 * 1024 * 1024), '--tmpfs', '/tmp',
    '--size', String(64 * 1024 * 1024), '--tmpfs', '/home', '--dir', '/home/modly',
    '--dir', '/app', '--dir', '/resources', '--dir', '/input', '--dir', '/runtime', '--dir', '/output',
  ]
  for (const path of input.systemPaths) {
    if (!isAbsolute(path)) throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Python sandbox system path is invalid')
    args.push('--ro-bind', path, path)
  }
  args.push('--ro-bind-fd', String(input.entryFd), '/app/process.pyz')
  input.resourceFds.forEach((fd, index) => args.push('--ro-bind-fd', String(fd), `/resources/${index}`))
  input.inputFds.forEach((fd, index) => args.push('--ro-bind-fd', String(fd), `/input/${index}`))
  args.push(
    '--ro-bind', `/proc/self/fd/${input.snapshotRootFd}`, '/runtime',
    '--bind', `/proc/self/fd/${input.outputDirFd}`, '/output',
    '--chdir', '/output',
    '--clearenv',
    '--setenv', 'HOME', '/home/modly',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'LC_ALL', 'C.UTF-8',
    '--setenv', 'PYTHONNOUSERSITE', '1',
    '--setenv', 'PYTHONDONTWRITEBYTECODE', '1',
    '--setenv', 'VIRTUAL_ENV', '/runtime',
    '--', `/runtime/${interpreter}`, '/app/process.pyz',
  )
  return { command: `/proc/self/fd/${input.bwrapFd}`, args, env: { ...FIXED_HOST_ENV }, cwd: '/', shell: false }
}

export function assertExtensionPythonRuntimeBinding(value: AgentProcessPythonRuntimeBindingV1): void {
  const interpreter = normalizeInterpreter(value.interpreter)
  const base = value.baseInterpreter
  if (value.kind !== 'extension-python-venv-v1' || !SHA256.test(value.treeDigest)
    || !SHA256.test(value.sourceIdentityHash) || !SHA256.test(value.bindingHash)
    || !base || Object.keys(base).sort().join(',') !== 'ctimeNs,device,gid,inode,mode,mtimeNs,nlink,sha256,size,uid'
    || !SHA256.test(base.sha256) || !/^\d+$/.test(base.device) || !/^\d+$/.test(base.inode)
    || !/^\d+$/.test(base.mtimeNs) || !/^\d+$/.test(base.ctimeNs)
    || !Number.isSafeInteger(base.uid) || base.uid < 0 || !Number.isSafeInteger(base.gid) || base.gid < 0
    || !Number.isSafeInteger(base.mode) || base.mode < 0 || base.mode > 0o7777 || (base.mode & 0o111) === 0
    || (base.mode & 0o022) !== 0 || !Number.isSafeInteger(base.size) || base.size < 1
    || !Number.isSafeInteger(base.nlink) || base.nlink !== 1
    || !Number.isSafeInteger(value.entryCount) || value.entryCount < 2 || value.entryCount > MAX_TREE_ENTRIES
    || !Number.isSafeInteger(value.logicalBytes) || value.logicalBytes < 1 || value.logicalBytes > MAX_TREE_LOGICAL_BYTES) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime binding is invalid')
  }
  const expected = sha256Canonical({
    schema: 'modly.extension-python-runtime-binding.v1',
    kind: value.kind,
    interpreter,
    baseInterpreter: base,
    treeDigest: value.treeDigest,
    sourceIdentityHash: value.sourceIdentityHash,
    entryCount: value.entryCount,
    logicalBytes: value.logicalBytes,
  })
  if (expected !== value.bindingHash || Buffer.byteLength(canonicalJson(value)) > 2_048) {
    throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Extension Python runtime binding hash is invalid')
  }
}
