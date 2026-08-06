import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants, type BigIntStats } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ArtifactKind } from '../../src/shared/types/artifacts.ts'
import type {
  AgentCapabilitySnapshotV1,
  AgentOllamaModelSnapshotV1,
  AgentProcessExecutionV1,
  ArtifactRefV1,
  JsonValue,
} from '../../src/shared/types/agentActions.ts'
import type { AgentActionExecutorRequest } from './agent-actions-service.ts'
import type { GovernedAgentProcessTarget } from './automation-capabilities.ts'
import {
  AgentProcessManifestError,
  hashAgentProcessFileHandle,
  normalizeAgentProcessRelativePath,
  openBoundAgentProcessRuntime,
  revalidateOpenAgentProcessRuntime,
  type OpenAgentProcessRuntimeFile,
} from './agent-process-manifest.ts'
import {
  assertAgentCapabilitySnapshotV1,
  assertAgentOllamaModelSnapshotV1,
  assertArtifactRefV1,
  sha256Canonical,
} from './agent-trust-contracts.ts'
import {
  AgentProcessPythonRuntimeError,
  buildExtensionPythonSandboxLaunch,
  openTrustedProcessExecutable,
  prepareExtensionPythonRuntimeSnapshot,
  revalidatePreparedExtensionPythonRuntime,
  revalidateTrustedProcessExecutable,
  type OpenTrustedProcessExecutable,
  type PreparedExtensionPythonRuntime,
} from './agent-process-python-runtime.ts'

const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const RESERVED_ARGUMENT_KEYS = new Set([
  'trustedContext', 'actionId', 'originSessionId', 'model', 'inputArtifacts',
  'resources', 'fdPath', 'dirs', 'capabilityHash', 'runtimeHash',
])
const MAX_INPUT_ARTIFACTS = 100
const MAX_INPUT_BYTES = 512 * 1024 * 1024
const PROCESS_TERMINAL_ERROR_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){0,7}$/
const MAX_TERMINAL_ERROR_CODE_LENGTH = 64
const MAX_TERMINAL_ERROR_MESSAGE_LENGTH = 500
const MAX_TERMINAL_ERROR_MESSAGE_BYTES = 1_024
const MAX_TERMINAL_ERROR_DETAILS_BYTES = 8 * 1_024
const MAX_TERMINAL_ERROR_DETAILS_DEPTH = 8
const MAX_TERMINAL_ERROR_DETAILS_NODES = 128
const MAX_TERMINAL_ERROR_COLLECTION = 32
const MAX_TERMINAL_ERROR_DETAIL_STRING = 1_024
const MAX_TERMINAL_ERROR_FRAME_BYTES = 16 * 1_024
const ESM_FD_LAUNCHER = "import { readFileSync } from 'node:fs'; const code = readFileSync(3); await import('data:text/javascript;base64,' + code.toString('base64'))"

const DEFAULT_LIMITS = Object.freeze({
  startupMs: 5_000,
  idleMs: 30_000,
  totalMs: 5 * 60_000,
  terminationGraceMs: 1_000,
  maxLineBytes: 256 * 1024,
  maxMessages: 2_048,
  maxLogBytes: 256 * 1024,
  maxResultBytes: 512 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
})

export type AgentProcessExecutorErrorCode =
  | 'unsupported_capability'
  | 'capability_stale'
  | 'model_stale'
  | 'invalid_arguments'
  | 'invalid_artifact'
  | 'artifact_too_large'
  | 'protocol_error'
  | 'timeout'
  | 'aborted'
  | 'runtime_unavailable'
  | 'execution_failed'

export class AgentProcessExecutorError extends Error {
  readonly code: AgentProcessExecutorErrorCode

  constructor(code: AgentProcessExecutorErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'AgentProcessExecutorError'
    this.code = code
  }
}

export interface AgentProcessTerminalFailure {
  code: string
  message: string
  details?: JsonValue
}

export class AgentProcessTerminalError extends AgentProcessExecutorError {
  readonly terminal: Readonly<AgentProcessTerminalFailure>

  constructor(terminal: AgentProcessTerminalFailure) {
    super('execution_failed')
    this.name = 'AgentProcessTerminalError'
    this.terminal = Object.freeze({ ...terminal })
  }
}

export interface AgentProcessExecutorLimits {
  startupMs: number
  idleMs: number
  totalMs: number
  terminationGraceMs: number
  maxLineBytes: number
  maxMessages: number
  maxLogBytes: number
  maxResultBytes: number
  maxRequestBytes: number
}

export interface AgentProcessExecutorOptions {
  getWorkspaceRoot: () => string | Promise<string>
  getPrivateTempRoot: (workspaceRoot: string) => string | Promise<string>
  resolveTarget: (capabilityId: string) => Promise<GovernedAgentProcessTarget>
  resolveCurrentModel: (expected: AgentOllamaModelSnapshotV1) => Promise<unknown>
  resolvePythonExecutable?: (extensionDir: string) => string | null | Promise<string | null>
  getRuntimeSnapshotRoot?: () => string | Promise<string>
  pythonSandboxReadiness?: () => boolean | Promise<boolean>
  bwrapPath?: string
  systemPaths?: readonly string[]
  limits?: Partial<AgentProcessExecutorLimits>
  platform?: NodeJS.Platform
}

export interface AgentProcessExecutorResult {
  artifacts: ArtifactRefV1[]
  rollback: () => Promise<void>
}

interface ProcessDescriptor {
  path: string
  kind: ArtifactKind
  mediaType: string
  sizeBytes: number
  sha256: string
}

interface OpenInput {
  ref: ArtifactRefV1
  handle: FileHandle
  identity: BigIntStats
}

interface LinuxProcessIdentity {
  pid: number
  ppid: number
  pgrp: number
  startTime: string
}

interface OwnedProcessGroup {
  pgrp: number
  leaderStartTime: string
  members: Map<number, string>
}

interface DirectoryIdentity {
  path: string
  dev: number | bigint
  ino: number | bigint
}

interface OpenPinnedDirectory {
  path: string
  handle: FileHandle
  identity: BigIntStats
}

interface PreparedPythonSandbox {
  runtime: PreparedExtensionPythonRuntime
  snapshotDirectory: OpenPinnedDirectory
  bwrap: OpenTrustedProcessExecutable
  systemPaths: string[]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function outside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

function assertActionId(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_ID.test(value)) throw new AgentProcessExecutorError('invalid_arguments')
  return value
}

function assertNoReservedArgumentKeys(value: JsonValue, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) throw new AgentProcessExecutorError('invalid_arguments')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (const child of value) assertNoReservedArgumentKeys(child, seen)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (RESERVED_ARGUMENT_KEYS.has(key)) throw new AgentProcessExecutorError('invalid_arguments')
      assertNoReservedArgumentKeys(child, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function normalizeLimits(overrides: Partial<AgentProcessExecutorLimits> = {}): AgentProcessExecutorLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Agent process limit ${name} must be positive`)
  }
  if (limits.maxResultBytes > limits.maxLineBytes) limits.maxLineBytes = limits.maxResultBytes
  return limits
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new AgentProcessExecutorError('runtime_unavailable')
  try {
    const canonical = await realpath(path)
    const info = await lstat(canonical)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a directory`)
    return canonical
  } catch (error) {
    throw new AgentProcessExecutorError('runtime_unavailable', error)
  }
}

async function ensureChildDirectory(parent: string, name: string, mode?: number): Promise<string> {
  const path = join(parent, name)
  await mkdir(path, { recursive: false, ...(mode === undefined ? {} : { mode }) }).catch((error: unknown) => {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
  })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new AgentProcessExecutorError('runtime_unavailable')
  }
  if (mode !== undefined) await chmod(path, mode)
  return path
}

async function ensurePublicationRoot(workspaceRoot: string): Promise<string> {
  const workflows = await ensureChildDirectory(workspaceRoot, 'Workflows')
  return ensureChildDirectory(workflows, 'agent-actions')
}

async function ensurePrivateTempRoot(pathValue: string, workspaceRoot: string, publicationRoot: string): Promise<string> {
  if (!isAbsolute(pathValue)) throw new AgentProcessExecutorError('runtime_unavailable')
  const absolute = resolve(pathValue)
  if (!outside(workspaceRoot, absolute) || !outside(absolute, workspaceRoot)) {
    throw new AgentProcessExecutorError('runtime_unavailable')
  }
  try {
    await mkdir(absolute, { recursive: true, mode: 0o700 })
    const info = await lstat(absolute)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error('unsafe private temp root')
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('private temp root has another owner')
    await chmod(absolute, 0o700)
    const [privateInfo, publicationInfo] = await Promise.all([stat(absolute), stat(publicationRoot)])
    if (privateInfo.dev !== publicationInfo.dev) throw new Error('private temp and publication roots must share a filesystem')
    return absolute
  } catch (error) {
    if (error instanceof AgentProcessExecutorError) throw error
    throw new AgentProcessExecutorError('runtime_unavailable', error)
  }
}

function statIdentityMatches(
  left: { dev: number | bigint, ino: number | bigint, size: number | bigint, mtimeMs: number },
  right: { dev: number | bigint, ino: number | bigint, size: number | bigint, mtimeMs: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}

async function hashAndCopyHandle(
  handle: FileHandle,
  destination: FileHandle,
  signal: AbortSignal,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<{ sha256: string, sizeBytes: number }> {
  const hash = createHash('sha256')
  let sizeBytes = 0
  const stream = handle.createReadStream({ autoClose: false, start: 0 })
  for await (const raw of stream) {
    if (signal.aborted) throw new AgentProcessExecutorError('aborted')
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    sizeBytes += chunk.length
    if (sizeBytes > maxBytes) throw new AgentProcessExecutorError('artifact_too_large')
    hash.update(chunk)
    await destination.write(chunk)
  }
  await destination.sync()
  return { sha256: hash.digest('hex'), sizeBytes }
}

async function captureDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new AgentProcessExecutorError('runtime_unavailable')
  }
  return { path, dev: info.dev, ino: info.ino }
}

async function revalidateDirectoryIdentities(identities: readonly DirectoryIdentity[]): Promise<void> {
  for (const identity of identities) {
    const current = await captureDirectoryIdentity(identity.path)
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new AgentProcessExecutorError('invalid_artifact')
    }
  }
}

async function openPinnedDirectory(
  pathValue: string,
  errorCode: AgentProcessExecutorErrorCode,
): Promise<OpenPinnedDirectory> {
  if (!isAbsolute(pathValue) || typeof constants.O_NOFOLLOW !== 'number'
    || typeof constants.O_DIRECTORY !== 'number') {
    throw new AgentProcessExecutorError(errorCode)
  }
  const handle = await open(pathValue, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch((error) => { throw new AgentProcessExecutorError(errorCode, error) })
  try {
    const identity = await handle.stat({ bigint: true })
    const pathInfo = await lstat(pathValue, { bigint: true })
    if (!identity.isDirectory() || !pathInfo.isDirectory() || pathInfo.isSymbolicLink()
      || identity.dev !== pathInfo.dev || identity.ino !== pathInfo.ino || await realpath(pathValue) !== pathValue) {
      throw new AgentProcessExecutorError(errorCode)
    }
    return { path: pathValue, handle, identity }
  } catch (error) {
    await handle.close().catch(() => undefined)
    if (error instanceof AgentProcessExecutorError) throw error
    throw new AgentProcessExecutorError(errorCode, error)
  }
}

async function revalidatePinnedDirectory(
  directory: OpenPinnedDirectory,
  errorCode: AgentProcessExecutorErrorCode,
): Promise<void> {
  try {
    const handleInfo = await directory.handle.stat({ bigint: true })
    const pathInfo = await lstat(directory.path, { bigint: true })
    const matches = (info: BigIntStats): boolean => info.isDirectory() && !info.isSymbolicLink()
      && info.dev === directory.identity.dev && info.ino === directory.identity.ino
      && info.uid === directory.identity.uid && info.gid === directory.identity.gid
      && info.mode === directory.identity.mode
    if (!matches(handleInfo) || !matches(pathInfo) || await realpath(directory.path) !== directory.path) {
      throw new AgentProcessExecutorError(errorCode)
    }
  } catch (error) {
    if (error instanceof AgentProcessExecutorError) throw error
    throw new AgentProcessExecutorError(errorCode, error)
  }
}

async function existingSystemPaths(paths: readonly string[]): Promise<string[]> {
  const result: string[] = []
  for (const path of paths) {
    if (!isAbsolute(path)) throw new AgentProcessExecutorError('runtime_unavailable')
    try {
      const info = await stat(path)
      if (!info.isDirectory() && !info.isFile()) throw new AgentProcessExecutorError('runtime_unavailable')
      result.push(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof AgentProcessExecutorError) throw error
        throw new AgentProcessExecutorError('runtime_unavailable', error)
      }
    }
  }
  if (!result.includes('/usr')) throw new AgentProcessExecutorError('runtime_unavailable')
  return result
}

function mapPythonRuntimeError(error: unknown): AgentProcessExecutorError {
  if (error instanceof AgentProcessExecutorError) return error
  if (error instanceof AgentProcessPythonRuntimeError) {
    return new AgentProcessExecutorError(
      error.code === 'runtime_stale' ? 'capability_stale' : 'runtime_unavailable',
      error,
    )
  }
  return new AgentProcessExecutorError('runtime_unavailable', error)
}

async function assertNoSymlinkArtifactPath(root: string, workspacePath: string): Promise<string> {
  try {
    const segments = workspacePath.split('/')
    let cursor = root
    for (const [index, segment] of segments.entries()) {
      cursor = join(cursor, segment)
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new AgentProcessExecutorError('invalid_artifact')
      if (index < segments.length - 1 && !info.isDirectory()) throw new AgentProcessExecutorError('invalid_artifact')
      if (index === segments.length - 1 && !info.isFile()) throw new AgentProcessExecutorError('invalid_artifact')
    }
    if (outside(root, cursor) || await realpath(cursor) !== cursor) throw new AgentProcessExecutorError('invalid_artifact')
    return cursor
  } catch (error) {
    if (error instanceof AgentProcessExecutorError) throw error
    throw new AgentProcessExecutorError('invalid_artifact', error)
  }
}

function bigintStatIdentityMatches(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
}

async function openInputs(
  workspaceRoot: string,
  refs: readonly ArtifactRefV1[],
  signal: AbortSignal,
): Promise<OpenInput[]> {
  if (refs.length > MAX_INPUT_ARTIFACTS
    || refs.reduce((total, ref) => total + ref.sizeBytes, 0) > MAX_INPUT_BYTES) {
    throw new AgentProcessExecutorError('artifact_too_large')
  }
  const inputs: OpenInput[] = []
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  try {
    for (const rawRef of refs) {
      if (signal.aborted) throw new AgentProcessExecutorError('aborted')
      const ref = assertArtifactRefV1(rawRef)
      const source = await assertNoSymlinkArtifactPath(workspaceRoot, ref.workspacePath)
      const handle = await open(source, constants.O_RDONLY | noFollow)
      const before = await handle.stat({ bigint: true })
      inputs.push({ ref, handle, identity: before })
      if (!before.isFile() || before.size !== BigInt(ref.sizeBytes)) {
        throw new AgentProcessExecutorError('invalid_artifact')
      }
      const sha256 = await hashAgentProcessFileHandle(handle)
      const after = await handle.stat({ bigint: true })
      if (!bigintStatIdentityMatches(before, after) || sha256 !== ref.sha256) {
        throw new AgentProcessExecutorError('invalid_artifact')
      }
    }
    return inputs
  } catch (error) {
    await Promise.all(inputs.map(({ handle }) => handle.close().catch(() => undefined)))
    if (error instanceof AgentProcessExecutorError) throw error
    throw new AgentProcessExecutorError('invalid_artifact', error)
  }
}

async function revalidateInputs(inputs: readonly OpenInput[]): Promise<void> {
  for (const input of inputs) {
    const before = await input.handle.stat({ bigint: true })
    if (!bigintStatIdentityMatches(before, input.identity) || await hashAgentProcessFileHandle(input.handle) !== input.ref.sha256) {
      throw new AgentProcessExecutorError('invalid_artifact')
    }
    const after = await input.handle.stat({ bigint: true })
    if (!bigintStatIdentityMatches(before, after)) throw new AgentProcessExecutorError('invalid_artifact')
  }
}

async function resolveLaunch(
  target: GovernedAgentProcessTarget,
  entryFdPath: string,
  options: AgentProcessExecutorOptions,
): Promise<{ command: string, args: string[], extraEnv: Record<string, string> }> {
  const entry = normalizeAgentProcessRelativePath(target.entry, 'Agent process entry')
  if (/\.(?:js|mjs)$/i.test(entry)) {
    return {
      command: process.execPath,
      args: ['--input-type=module', '--eval', ESM_FD_LAUNCHER, '--', entryFdPath],
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  if (/\.pyz$/i.test(entry)) {
    if (target.capability.execution?.kind === 'process' && target.capability.execution.runtime) {
      // A declared extension venv must never fall back to Modly's host Python.
      // The sandboxed snapshot launch path is a separate, mandatory readiness boundary.
      throw new AgentProcessExecutorError('runtime_unavailable')
    }
    const configured = await options.resolvePythonExecutable?.(target.extensionDir)
    if (!configured || !isAbsolute(configured)) throw new AgentProcessExecutorError('runtime_unavailable')
    try {
      const executable = await realpath(configured)
      const info = await stat(executable)
      if (!info.isFile()) throw new Error('not a file')
      await access(executable, constants.X_OK)
      return { command: executable, args: [entryFdPath], extraEnv: { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' } }
    } catch (error) {
      throw new AgentProcessExecutorError('runtime_unavailable', error)
    }
  }
  throw new AgentProcessExecutorError('runtime_unavailable')
}

async function preparePythonSandbox(
  target: GovernedAgentProcessTarget,
  execution: AgentProcessExecutionV1,
  workspaceRoot: string,
  options: AgentProcessExecutorOptions,
): Promise<PreparedPythonSandbox | undefined> {
  if (!execution.runtime) return undefined
  if (!/\.pyz$/i.test(target.entry) || !options.getRuntimeSnapshotRoot || !options.pythonSandboxReadiness) {
    throw new AgentProcessExecutorError('runtime_unavailable')
  }
  let ready = false
  try { ready = await options.pythonSandboxReadiness() === true } catch { ready = false }
  if (!ready) throw new AgentProcessExecutorError('runtime_unavailable')
  const cacheRootValue = await options.getRuntimeSnapshotRoot()
  if (!isAbsolute(cacheRootValue)) throw new AgentProcessExecutorError('runtime_unavailable')
  const cacheRoot = resolve(cacheRootValue)
  if (!outside(workspaceRoot, cacheRoot) || !outside(cacheRoot, workspaceRoot)) {
    throw new AgentProcessExecutorError('runtime_unavailable')
  }
  let runtime: PreparedExtensionPythonRuntime | undefined
  let snapshotDirectory: OpenPinnedDirectory | undefined
  let bwrap: OpenTrustedProcessExecutable | undefined
  try {
    const baseInterpreter = await options.resolvePythonExecutable?.(target.extensionDir)
    if (!baseInterpreter || !isAbsolute(baseInterpreter)) throw new AgentProcessExecutorError('runtime_unavailable')
    runtime = await prepareExtensionPythonRuntimeSnapshot(
      target.extensionDir, execution.runtime, cacheRoot, baseInterpreter,
    )
    snapshotDirectory = await openPinnedDirectory(runtime.rootPath, 'capability_stale')
    bwrap = await openTrustedProcessExecutable(options.bwrapPath ?? '/usr/bin/bwrap')
    const systemPaths = await existingSystemPaths(options.systemPaths ?? ['/usr', '/lib', '/lib64'])
    await revalidatePreparedExtensionPythonRuntime(target.extensionDir, runtime, baseInterpreter)
    await revalidatePinnedDirectory(snapshotDirectory, 'capability_stale')
    await revalidateTrustedProcessExecutable(bwrap)
    return { runtime, snapshotDirectory, bwrap, systemPaths }
  } catch (error) {
    await snapshotDirectory?.handle.close().catch(() => undefined)
    await bwrap?.handle.close().catch(() => undefined)
    runtime?.release()
    throw mapPythonRuntimeError(error)
  }
}

async function revalidatePythonSandbox(
  target: GovernedAgentProcessTarget,
  sandbox: PreparedPythonSandbox,
  options: AgentProcessExecutorOptions,
): Promise<void> {
  try {
    const baseInterpreter = await options.resolvePythonExecutable?.(target.extensionDir)
    if (!baseInterpreter || !isAbsolute(baseInterpreter)) throw new AgentProcessExecutorError('runtime_unavailable')
    await revalidatePreparedExtensionPythonRuntime(target.extensionDir, sandbox.runtime, baseInterpreter)
    await revalidatePinnedDirectory(sandbox.snapshotDirectory, 'capability_stale')
    await revalidateTrustedProcessExecutable(sandbox.bwrap)
  } catch (error) {
    throw mapPythonRuntimeError(error)
  }
}

async function closePythonSandbox(sandbox: PreparedPythonSandbox | undefined): Promise<void> {
  await Promise.all([
    sandbox?.snapshotDirectory.handle.close().catch(() => undefined),
    sandbox?.bwrap.handle.close().catch(() => undefined),
  ])
  sandbox?.runtime.release()
}

async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | undefined> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, 'utf8')
    const end = contents.lastIndexOf(')')
    const fields = contents.slice(end + 2).trim().split(/\s+/)
    const ppid = Number(fields[1])
    const pgrp = Number(fields[2])
    const startTime = fields[19]
    if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgrp) || !startTime) return undefined
    return { pid, ppid, pgrp, startTime }
  } catch {
    return undefined
  }
}

async function listLinuxProcessGroup(pgrp: number): Promise<LinuxProcessIdentity[]> {
  const entries = await readdir('/proc', { withFileTypes: true })
  const identities: LinuxProcessIdentity[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const identity = await readLinuxProcessIdentity(Number(entry.name))
    if (identity?.pgrp === pgrp) identities.push(identity)
  }
  return identities.sort((left, right) => left.pid - right.pid)
}

async function initializeOwnedProcessGroup(pid: number): Promise<OwnedProcessGroup> {
  const leader = await readLinuxProcessIdentity(pid)
  if (!leader || leader.pgrp !== pid) throw new AgentProcessExecutorError('execution_failed')
  const group: OwnedProcessGroup = { pgrp: pid, leaderStartTime: leader.startTime, members: new Map([[pid, leader.startTime]]) }
  await refreshOwnedProcessGroup(group)
  return group
}

async function refreshOwnedProcessGroup(group: OwnedProcessGroup): Promise<LinuxProcessIdentity[]> {
  const current = await listLinuxProcessGroup(group.pgrp)
  const leader = current.find((identity) => identity.pid === group.pgrp)
  if (leader && leader.startTime !== group.leaderStartTime) return []
  for (const identity of current) {
    const knownStart = group.members.get(identity.pid)
    if (knownStart === undefined) group.members.set(identity.pid, identity.startTime)
  }
  return current.filter((identity) => group.members.get(identity.pid) === identity.startTime)
}

async function signalOwnedGroup(group: OwnedProcessGroup | undefined, signal: NodeJS.Signals): Promise<void> {
  if (!group) return
  for (const identity of await refreshOwnedProcessGroup(group)) {
    try { process.kill(identity.pid, signal) } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH') throw error
    }
  }
}

async function waitForOwnedGroupExit(group: OwnedProcessGroup | undefined, timeoutMs: number): Promise<boolean> {
  if (!group) return true
  const deadline = Date.now() + timeoutMs
  do {
    if ((await refreshOwnedProcessGroup(group)).length === 0) return true
    await delay(Math.min(20, Math.max(1, deadline - Date.now())))
  } while (Date.now() < deadline)
  return (await refreshOwnedProcessGroup(group)).length === 0
}

function parseDescriptor(value: unknown): ProcessDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentProcessExecutorError('protocol_error')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).sort().join(',') !== 'kind,mediaType,path,sha256,sizeBytes') throw new AgentProcessExecutorError('protocol_error')
  let path: string
  try { path = normalizeAgentProcessRelativePath(raw.path, 'Result artifact path') } catch (error) {
    throw new AgentProcessExecutorError('invalid_artifact', error)
  }
  if (typeof raw.kind !== 'string' || typeof raw.mediaType !== 'string' || !MEDIA_TYPE.test(raw.mediaType)
    || typeof raw.sizeBytes !== 'number' || !Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 0
    || typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
    throw new AgentProcessExecutorError('protocol_error')
  }
  return { path, kind: raw.kind as ArtifactKind, mediaType: raw.mediaType.toLowerCase(), sizeBytes: raw.sizeBytes, sha256: raw.sha256 }
}

function hasUnsafeUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return true
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true
  }
  return false
}

function normalizeTerminalDetail(
  value: unknown,
  depth: number,
  state: { nodes: number },
): JsonValue {
  state.nodes += 1
  if (depth > MAX_TERMINAL_ERROR_DETAILS_DEPTH || state.nodes > MAX_TERMINAL_ERROR_DETAILS_NODES) {
    throw new AgentProcessExecutorError('protocol_error')
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AgentProcessExecutorError('protocol_error')
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === 'string') {
    if (value.length > MAX_TERMINAL_ERROR_DETAIL_STRING || hasUnsafeUnicode(value)) {
      throw new AgentProcessExecutorError('protocol_error')
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_TERMINAL_ERROR_COLLECTION) throw new AgentProcessExecutorError('protocol_error')
    return Object.freeze(value.map((entry) => normalizeTerminalDetail(entry, depth + 1, state))) as JsonValue
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AgentProcessExecutorError('protocol_error')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_TERMINAL_ERROR_COLLECTION) throw new AgentProcessExecutorError('protocol_error')
  const normalized: Record<string, JsonValue> = {}
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || key === 'constructor' || key === 'prototype') {
      throw new AgentProcessExecutorError('protocol_error')
    }
    normalized[key] = normalizeTerminalDetail(entry, depth + 1, state)
  }
  return Object.freeze(normalized)
}

function parseTerminalError(raw: Record<string, unknown>, lineBytes: number): AgentProcessTerminalError {
  const keys = Object.keys(raw).sort().join(',')
  if ((keys !== 'code,message,type' && keys !== 'code,details,message,type')
    || lineBytes > MAX_TERMINAL_ERROR_FRAME_BYTES
    || typeof raw.code !== 'string' || raw.code.length > MAX_TERMINAL_ERROR_CODE_LENGTH
    || !PROCESS_TERMINAL_ERROR_CODE.test(raw.code)
    || typeof raw.message !== 'string' || raw.message.length < 1
    || raw.message.length > MAX_TERMINAL_ERROR_MESSAGE_LENGTH
    || Buffer.byteLength(raw.message) > MAX_TERMINAL_ERROR_MESSAGE_BYTES
    || raw.message.trim() !== raw.message || hasUnsafeUnicode(raw.message)) {
    throw new AgentProcessExecutorError('protocol_error')
  }
  let details: JsonValue | undefined
  if (Object.hasOwn(raw, 'details')) {
    details = normalizeTerminalDetail(raw.details, 0, { nodes: 0 })
    if (Buffer.byteLength(JSON.stringify(details)) > MAX_TERMINAL_ERROR_DETAILS_BYTES) {
      throw new AgentProcessExecutorError('protocol_error')
    }
  }
  return new AgentProcessTerminalError({ code: raw.code, message: raw.message, ...(details === undefined ? {} : { details }) })
}

function runProtocol(
  launch: { command: string, args: string[], extraEnv: Record<string, string>, inheritedFds: number[] },
  context: Record<string, unknown>,
  cwd: string,
  homeDir: string,
  tempDir: string,
  limits: AgentProcessExecutorLimits,
  signal: AbortSignal,
): Promise<ProcessDescriptor[]> {
  return new Promise((resolveResult, rejectResult) => {
    let child: ChildProcess
    try {
      child = spawn(launch.command, launch.args, {
        cwd,
        env: {
          HOME: homeDir,
          USERPROFILE: homeDir,
          TMPDIR: tempDir,
          TMP: tempDir,
          TEMP: tempDir,
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          NO_PROXY: '*',
          ...launch.extraEnv,
        },
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe', ...launch.inheritedFds],
      })
    } catch (error) {
      rejectResult(new AgentProcessExecutorError('execution_failed', error))
      return
    }

    let settled = false
    let buffer = Buffer.alloc(0)
    let messages = 0
    let logBytes = 0
    let descriptors: ProcessDescriptor[] | undefined
    let terminalError: AgentProcessTerminalError | undefined
    let group: OwnedProcessGroup | undefined
    let groupPromise: Promise<OwnedProcessGroup> | undefined
    const timers: { startup?: NodeJS.Timeout, idle?: NodeJS.Timeout, total?: NodeJS.Timeout, group?: NodeJS.Timeout } = {}
    const exitPromise = new Promise<void>((resolveExit) => child.once('close', () => resolveExit()))

    const ensureGroup = async (): Promise<OwnedProcessGroup> => {
      if (group) return group
      if (!child.pid) throw new AgentProcessExecutorError('execution_failed')
      groupPromise ??= initializeOwnedProcessGroup(child.pid)
      group = await groupPromise
      return group
    }

    const clearTimers = (): void => {
      clearTimeout(timers.startup)
      clearTimeout(timers.idle)
      clearTimeout(timers.total)
      clearInterval(timers.group)
    }
    const terminate = async (): Promise<void> => {
      child.stdin?.destroy()
      const ownedGroup = await ensureGroup().catch(() => undefined)
      await signalOwnedGroup(ownedGroup, 'SIGTERM').catch(() => undefined)
      if (!await waitForOwnedGroupExit(ownedGroup, limits.terminationGraceMs).catch(() => false)) {
        await signalOwnedGroup(ownedGroup, 'SIGKILL').catch(() => undefined)
      }
      await waitForOwnedGroupExit(ownedGroup, limits.terminationGraceMs).catch(() => false)
      await Promise.race([exitPromise, delay(limits.terminationGraceMs)]).catch(() => undefined)
    }
    const fail = (error: AgentProcessExecutorError): void => {
      if (settled) return
      settled = true
      clearTimers()
      signal.removeEventListener('abort', onAbort)
      void terminate().finally(() => rejectResult(error))
    }
    const resetIdle = (): void => {
      clearTimeout(timers.idle)
      timers.idle = setTimeout(() => fail(new AgentProcessExecutorError('timeout')), limits.idleMs)
    }
    const parseLine = (line: Buffer): void => {
      if (descriptors !== undefined || terminalError !== undefined) return fail(new AgentProcessExecutorError('protocol_error'))
      if (line.length === 0) return
      if (++messages > limits.maxMessages || line.length > limits.maxLineBytes) return fail(new AgentProcessExecutorError('protocol_error'))
      clearTimeout(timers.startup)
      resetIdle()
      let message: unknown
      try { message = JSON.parse(line.toString('utf8')) } catch (error) { return fail(new AgentProcessExecutorError('protocol_error', error)) }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail(new AgentProcessExecutorError('protocol_error'))
      const raw = message as Record<string, unknown>
      if (raw.type === 'log') {
        if (Object.keys(raw).sort().join(',') !== 'message,type' || typeof raw.message !== 'string') return fail(new AgentProcessExecutorError('protocol_error'))
        logBytes += Buffer.byteLength(raw.message)
        if (logBytes > limits.maxLogBytes) fail(new AgentProcessExecutorError('protocol_error'))
        return
      }
      if (raw.type === 'progress') {
        if (Object.keys(raw).sort().join(',') !== 'type,value' || typeof raw.value !== 'number' || !Number.isFinite(raw.value) || raw.value < 0 || raw.value > 1) {
          fail(new AgentProcessExecutorError('protocol_error'))
        }
        return
      }
      if (raw.type === 'error') {
        try { terminalError = parseTerminalError(raw, line.length) } catch (error) {
          fail(error instanceof AgentProcessExecutorError ? error : new AgentProcessExecutorError('protocol_error', error))
        }
        return
      }
      if (raw.type !== 'result' || raw.schema !== 'modly.agent-process-result.v1'
        || Object.keys(raw).sort().join(',') !== 'artifacts,schema,type' || descriptors !== undefined
        || line.length > limits.maxResultBytes || !Array.isArray(raw.artifacts)) {
        return fail(new AgentProcessExecutorError('protocol_error'))
      }
      try { descriptors = raw.artifacts.map(parseDescriptor) } catch (error) {
        fail(error instanceof AgentProcessExecutorError ? error : new AgentProcessExecutorError('protocol_error', error))
      }
    }

    const onAbort = (): void => fail(new AgentProcessExecutorError('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) return onAbort()
    timers.startup = setTimeout(() => fail(new AgentProcessExecutorError('timeout')), limits.startupMs)
    timers.idle = setTimeout(() => fail(new AgentProcessExecutorError('timeout')), limits.idleMs)
    timers.total = setTimeout(() => fail(new AgentProcessExecutorError('timeout')), limits.totalMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      if ((descriptors !== undefined || terminalError !== undefined) && chunk.length > 0) {
        return fail(new AgentProcessExecutorError('protocol_error'))
      }
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > limits.maxLineBytes) return fail(new AgentProcessExecutorError('protocol_error'))
      let newline = buffer.indexOf(0x0a)
      while (newline >= 0 && !settled) {
        let line = buffer.subarray(0, newline)
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
        buffer = buffer.subarray(newline + 1)
        parseLine(line)
        newline = buffer.indexOf(0x0a)
      }
      if (!settled && (descriptors !== undefined || terminalError !== undefined) && buffer.length > 0) {
        fail(new AgentProcessExecutorError('protocol_error'))
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if ((descriptors !== undefined || terminalError !== undefined) && Buffer.byteLength(chunk) > 0) {
        return fail(new AgentProcessExecutorError('protocol_error'))
      }
      logBytes += Buffer.byteLength(chunk)
      resetIdle()
      if (logBytes > limits.maxLogBytes) fail(new AgentProcessExecutorError('protocol_error'))
    })
    child.once('error', (error) => fail(new AgentProcessExecutorError('execution_failed', error)))
    child.once('spawn', () => {
      void ensureGroup().then((identity) => {
        if (settled) return
        timers.group = setInterval(() => { void refreshOwnedProcessGroup(identity).catch(() => undefined) }, 100)
        timers.group.unref()
        const serialized = `${JSON.stringify(context)}\n`
        if (Buffer.byteLength(serialized) > limits.maxRequestBytes) return fail(new AgentProcessExecutorError('invalid_arguments'))
        child.stdin?.end(serialized)
      }, (error) => fail(new AgentProcessExecutorError('execution_failed', error)))
    })
    child.once('close', (code, closeSignal) => {
      void (async () => {
        if (settled) return
        const liveMembers = group ? await refreshOwnedProcessGroup(group).catch(() => []) : []
        if (liveMembers.some((identity) => identity.pid !== child.pid)) {
          fail(new AgentProcessExecutorError('protocol_error'))
          return
        }
        settled = true
        clearTimers()
        signal.removeEventListener('abort', onAbort)
        if (buffer.toString('utf8').trim().length > 0 || code !== 0 || closeSignal !== null
          || (descriptors === undefined && terminalError === undefined)) {
          rejectResult(new AgentProcessExecutorError('protocol_error'))
          return
        }
        if (terminalError) {
          rejectResult(terminalError)
          return
        }
        if (!descriptors) {
          rejectResult(new AgentProcessExecutorError('protocol_error'))
          return
        }
        resolveResult(descriptors)
      })().catch((error) => fail(new AgentProcessExecutorError('execution_failed', error)))
    })
  })
}

async function verifyAndPublish(
  descriptors: readonly ProcessDescriptor[],
  execution: AgentProcessExecutionV1,
  outputDir: string,
  publishDir: string,
  finalDir: string,
  workspaceRoot: string,
  actionId: string,
  signal: AbortSignal,
): Promise<ArtifactRefV1[]> {
  if (descriptors.length < 1 || descriptors.length > execution.artifacts.maxCount) throw new AgentProcessExecutorError('invalid_artifact')
  const paths = new Set<string>()
  let totalBytes = 0
  const artifacts: ArtifactRefV1[] = []
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  for (const [index, descriptor] of descriptors.entries()) {
    if (signal.aborted) throw new AgentProcessExecutorError('aborted')
    if (paths.has(descriptor.path)) throw new AgentProcessExecutorError('invalid_artifact')
    paths.add(descriptor.path)
    const policy = execution.artifacts.allowed.find((candidate) => candidate.kind === descriptor.kind)
    if (!policy || !policy.mediaTypes.includes(descriptor.mediaType)) throw new AgentProcessExecutorError('invalid_artifact')
    if (descriptor.sizeBytes > policy.maxBytes) throw new AgentProcessExecutorError('artifact_too_large')
    totalBytes += descriptor.sizeBytes
    if (totalBytes > execution.artifacts.maxTotalBytes) throw new AgentProcessExecutorError('artifact_too_large')

    const source = await assertNoSymlinkArtifactPath(outputDir, descriptor.path)
    const sourceHandle = await open(source, constants.O_RDONLY | noFollow)
    try {
      const before = await sourceHandle.stat()
      if (!before.isFile()) throw new AgentProcessExecutorError('invalid_artifact')
      const segments = descriptor.path.split('/')
      let parent = publishDir
      for (const segment of segments.slice(0, -1)) parent = await ensureChildDirectory(parent, segment)
      const destination = await open(join(parent, segments.at(-1)!), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400)
      try {
        const measured = await hashAndCopyHandle(sourceHandle, destination, signal)
        const after = await sourceHandle.stat()
        if (!statIdentityMatches(before, after) || measured.sizeBytes !== descriptor.sizeBytes || measured.sha256 !== descriptor.sha256) {
          throw new AgentProcessExecutorError('invalid_artifact')
        }
      } finally {
        await destination.close().catch(() => undefined)
      }
    } finally {
      await sourceHandle.close().catch(() => undefined)
    }
    artifacts.push({
      schema: 'modly.artifact-ref.v1', version: 1,
      id: `${actionId}-${index + 1}`,
      kind: descriptor.kind,
      mediaType: descriptor.mediaType,
      workspacePath: `Workflows/agent-actions/${actionId}/${descriptor.path}`,
      sha256: descriptor.sha256,
      sizeBytes: descriptor.sizeBytes,
    })
  }
  if (signal.aborted) throw new AgentProcessExecutorError('aborted')
  await rename(publishDir, finalDir)
  if (outside(workspaceRoot, finalDir)) throw new AgentProcessExecutorError('invalid_artifact')
  return artifacts
}

export function createAgentProcessExecutor(options: AgentProcessExecutorOptions): {
  ensureReady: (capability: AgentCapabilitySnapshotV1) => Promise<void>
  execute: (request: AgentActionExecutorRequest) => Promise<AgentProcessExecutorResult>
} {
  const limits = normalizeLimits(options.limits)

  const resolveBoundTarget = async (capabilityValue: AgentCapabilitySnapshotV1): Promise<GovernedAgentProcessTarget> => {
    let capability: AgentCapabilitySnapshotV1
    try { capability = assertAgentCapabilitySnapshotV1(capabilityValue) } catch (error) { throw new AgentProcessExecutorError('unsupported_capability', error) }
    if (capability.execution?.kind !== 'process') throw new AgentProcessExecutorError('unsupported_capability')
    let target: GovernedAgentProcessTarget
    try { target = await options.resolveTarget(capability.id) } catch (error) { throw new AgentProcessExecutorError('capability_stale', error) }
    if (target.capability.hash !== capability.hash || target.entry !== capability.execution.entry
      || target.capability.execution?.kind !== 'process'
      || target.capability.execution.runtimeHash !== capability.execution.runtimeHash
      || target.capability.execution.bindingHash !== capability.execution.bindingHash) {
      throw new AgentProcessExecutorError('capability_stale')
    }
    return target
  }

  const ensureReady = async (capability: AgentCapabilitySnapshotV1): Promise<void> => {
    if ((options.platform ?? process.platform) !== 'linux') throw new AgentProcessExecutorError('runtime_unavailable')
    const target = await resolveBoundTarget(capability)
    if (target.capability.execution?.kind !== 'process') throw new AgentProcessExecutorError('unsupported_capability')
    const workspaceRoot = await canonicalDirectory(await options.getWorkspaceRoot(), 'Workspace')
    const publicationRoot = await ensurePublicationRoot(workspaceRoot)
    await ensurePrivateTempRoot(await options.getPrivateTempRoot(workspaceRoot), workspaceRoot, publicationRoot)
    const runtime = await openBoundAgentProcessRuntime(target.extensionDir, target.capability.execution)
      .catch((error) => { throw new AgentProcessExecutorError('capability_stale', error) })
    let pythonSandbox: PreparedPythonSandbox | undefined
    try {
      if (runtime.filter((file) => file.role === 'bundle').length !== 1) throw new AgentProcessExecutorError('capability_stale')
      if (target.capability.execution.runtime) {
        pythonSandbox = await preparePythonSandbox(target, target.capability.execution, workspaceRoot, options)
        if (!pythonSandbox) throw new AgentProcessExecutorError('runtime_unavailable')
        await revalidateOpenAgentProcessRuntime(runtime)
        await revalidatePythonSandbox(target, pythonSandbox, options)
      } else {
        await resolveLaunch(target, '/proc/self/fd/3', options)
      }
    } finally {
      await Promise.all(runtime.map(({ handle }) => handle.close().catch(() => undefined)))
      await closePythonSandbox(pythonSandbox)
    }
  }

  const execute = async (request: AgentActionExecutorRequest): Promise<AgentProcessExecutorResult> => {
    if ((options.platform ?? process.platform) !== 'linux') throw new AgentProcessExecutorError('runtime_unavailable')
    const actionId = assertActionId(request.actionId)
    assertActionId(request.originSessionId)
    assertNoReservedArgumentKeys(request.arguments)
    if (request.signal.aborted) throw new AgentProcessExecutorError('aborted')
    const target = await resolveBoundTarget(request.capability)
    const execution = target.capability.execution
    if (execution?.kind !== 'process') throw new AgentProcessExecutorError('unsupported_capability')
    let currentModel: AgentOllamaModelSnapshotV1
    try { currentModel = assertAgentOllamaModelSnapshotV1(await options.resolveCurrentModel(request.model)) } catch (error) {
      throw new AgentProcessExecutorError('model_stale', error)
    }
    if (sha256Canonical(currentModel) !== sha256Canonical(assertAgentOllamaModelSnapshotV1(request.model))) {
      throw new AgentProcessExecutorError('model_stale')
    }

    const workspaceRoot = await canonicalDirectory(await options.getWorkspaceRoot(), 'Workspace')
    const publicationRoot = await ensurePublicationRoot(workspaceRoot)
    const privateTempRoot = await ensurePrivateTempRoot(
      await options.getPrivateTempRoot(workspaceRoot), workspaceRoot, publicationRoot,
    )
    const finalDir = join(publicationRoot, actionId)
    try { await lstat(finalDir); throw new AgentProcessExecutorError('invalid_artifact') } catch (error) {
      if (error instanceof AgentProcessExecutorError) throw error
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw new AgentProcessExecutorError('invalid_artifact', error)
    }
    let stageDir = ''
    let outputDir = ''
    let publishDir = ''
    let directoryIdentities: DirectoryIdentity[] = []
    let runtime: OpenAgentProcessRuntimeFile[] = []
    let inputs: OpenInput[] = []
    let outputDirectory: OpenPinnedDirectory | undefined
    let pythonSandbox: PreparedPythonSandbox | undefined
    let published = false
    try {
      stageDir = await mkdtemp(join(privateTempRoot, `${actionId}-`))
      await chmod(stageDir, 0o700)
      outputDir = await ensureChildDirectory(stageDir, 'output', 0o700)
      publishDir = await ensureChildDirectory(stageDir, 'publish', 0o700)
      directoryIdentities = await Promise.all([
        privateTempRoot, publicationRoot, stageDir, outputDir, publishDir,
      ].map(captureDirectoryIdentity))
      inputs = await openInputs(workspaceRoot, request.inputArtifacts, request.signal)
      runtime = await openBoundAgentProcessRuntime(target.extensionDir, execution)
      const bundles = runtime.filter((file) => file.role === 'bundle')
      const resources = runtime.filter((file) => file.role === 'resource')
      if (bundles.length !== 1) throw new AgentProcessExecutorError('capability_stale')
      const entryFd = 3
      const resourceFdBase = entryFd + 1
      const inputFdBase = resourceFdBase + resources.length
      let launch: { command: string, args: string[], extraEnv: Record<string, string>, inheritedFds: number[] }
      if (execution.runtime) {
        pythonSandbox = await preparePythonSandbox(target, execution, workspaceRoot, options)
        if (!pythonSandbox) throw new AgentProcessExecutorError('runtime_unavailable')
        outputDirectory = await openPinnedDirectory(outputDir, 'invalid_artifact')
        const snapshotRootFd = inputFdBase + inputs.length
        const outputDirFd = snapshotRootFd + 1
        const bwrapFd = outputDirFd + 1
        const sandboxLaunch = buildExtensionPythonSandboxLaunch({
          platform: options.platform ?? process.platform,
          bwrapFd,
          snapshotRootFd,
          interpreter: execution.runtime.interpreter,
          entryFd,
          resourceFds: resources.map((_, index) => resourceFdBase + index),
          inputFds: inputs.map((_, index) => inputFdBase + index),
          outputDirFd,
          systemPaths: pythonSandbox.systemPaths,
        })
        launch = {
          command: sandboxLaunch.command,
          args: sandboxLaunch.args,
          extraEnv: sandboxLaunch.env,
          inheritedFds: [
            bundles[0].handle.fd,
            ...resources.map((file) => file.handle.fd),
            ...inputs.map((input) => input.handle.fd),
            pythonSandbox.snapshotDirectory.handle.fd,
            outputDirectory.handle.fd,
            pythonSandbox.bwrap.handle.fd,
          ],
        }
      } else {
        launch = {
          ...await resolveLaunch(target, `/proc/self/fd/${entryFd}`, options),
          inheritedFds: [bundles[0].handle.fd, ...resources.map((file) => file.handle.fd), ...inputs.map((input) => input.handle.fd)],
        }
      }

      const currentTarget = await resolveBoundTarget(request.capability)
      if (currentTarget.extensionDir !== target.extensionDir || currentTarget.entry !== target.entry) throw new AgentProcessExecutorError('capability_stale')
      let finalModel: AgentOllamaModelSnapshotV1
      try { finalModel = assertAgentOllamaModelSnapshotV1(await options.resolveCurrentModel(request.model)) } catch (error) {
        throw new AgentProcessExecutorError('model_stale', error)
      }
      if (sha256Canonical(finalModel) !== sha256Canonical(request.model)) throw new AgentProcessExecutorError('model_stale')
      await revalidateInputs(inputs)
      await revalidateOpenAgentProcessRuntime(runtime)
      if (pythonSandbox) {
        await revalidatePythonSandbox(target, pythonSandbox, options)
        await revalidatePinnedDirectory(outputDirectory!, 'invalid_artifact')
      }

      const trustedContext = Object.freeze({
        actionId,
        originSessionId: request.originSessionId,
        model: Object.freeze({ ...request.model }),
        inputArtifacts: Object.freeze(inputs.map((input, index) => Object.freeze({
          artifact: Object.freeze({ ...input.ref }),
          fdPath: pythonSandbox ? `/input/${index}` : `/proc/self/fd/${inputFdBase + index}`,
        }))),
        resources: Object.freeze(resources.map((resource, index) => Object.freeze({
          path: resource.identity.path,
          fdPath: pythonSandbox ? `/resources/${index}` : `/proc/self/fd/${resourceFdBase + index}`,
        }))),
        dirs: Object.freeze({ output: pythonSandbox ? '/output' : outputDir }),
        capabilityHash: request.capability.hash,
        runtimeHash: execution.runtimeHash,
      })
      const descriptors = await runProtocol(
        launch,
        { schema: 'modly.agent-process-request.v1', arguments: request.arguments, trustedContext },
        outputDir,
        outputDir,
        outputDir,
        limits,
        request.signal,
      )
      await revalidateInputs(inputs)
      await revalidateOpenAgentProcessRuntime(runtime)
      if (pythonSandbox) {
        await revalidatePythonSandbox(target, pythonSandbox, options)
        await revalidatePinnedDirectory(outputDirectory!, 'invalid_artifact')
      }
      await revalidateDirectoryIdentities(directoryIdentities)
      const artifacts = await verifyAndPublish(
        descriptors, execution, outputDir, publishDir, finalDir, workspaceRoot, actionId, request.signal,
      )
      published = true
      if (request.signal.aborted) throw new AgentProcessExecutorError('aborted')
      let rollbackPromise: Promise<void> | undefined
      return {
        artifacts,
        rollback: () => {
          rollbackPromise ??= rm(finalDir, { recursive: true, force: true })
          return rollbackPromise
        },
      }
    } catch (error) {
      if (published) await rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof AgentProcessExecutorError) throw error
      if (error instanceof AgentProcessPythonRuntimeError) throw mapPythonRuntimeError(error)
      if (error instanceof AgentProcessManifestError) throw new AgentProcessExecutorError('capability_stale', error)
      throw new AgentProcessExecutorError('execution_failed', error)
    } finally {
      await Promise.all(runtime.map(({ handle }) => handle.close().catch(() => undefined)))
      await Promise.all(inputs.map(({ handle }) => handle.close().catch(() => undefined)))
      await outputDirectory?.handle.close().catch(() => undefined)
      await closePythonSandbox(pythonSandbox)
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return { ensureReady, execute }
}
