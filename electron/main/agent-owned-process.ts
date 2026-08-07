import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readFile, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const DEFAULT_STDERR_BYTES = 64 * 1024
const DEFAULT_TERMINATION_GRACE_MS = 500
const DEFAULT_REAP_TIMEOUT_MS = 5_000
const MAX_ARGUMENTS = 4_096
const MAX_ARGUMENT_BYTES = 1024 * 1024
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export type AgentOwnedProcessExit = Readonly<{
  code: number | null
  signal: NodeJS.Signals | null
}>

export interface AgentPinnedExecutableIdentity {
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

export interface PinnedAgentExecutable {
  readonly path: string
  readonly handle: FileHandle
  readonly identity: Readonly<AgentPinnedExecutableIdentity>
  revalidate(): Promise<void>
  close(): Promise<void>
}

export interface AgentOwnedProcess {
  readonly pid: number
  readonly stderr: string
  readonly exited: Promise<AgentOwnedProcessExit>
  revalidate(): Promise<void>
  close(): Promise<void>
}

export interface StartAgentOwnedProcessOptions {
  executable: PinnedAgentExecutable
  args: readonly string[]
  env: Readonly<Record<string, string>>
  cwd: string
  inheritedHandles?: readonly FileHandle[]
  signal?: AbortSignal
  stderrBytes?: number
  terminationGraceMs?: number
  reapTimeoutMs?: number
  onGroupSignal?: (signal: NodeJS.Signals) => void
  /** Internal deterministic-test seam; production callers use /proc identity validation. */
  processIdentityMatches?: (
    pid: number,
    expected: Readonly<{ processGroup: number, session: number, startTime: string }>,
  ) => Promise<boolean>
}

export class AgentOwnedProcessError extends Error {
  readonly code: 'invalid_executable' | 'invalid_launch' | 'process_unavailable' | 'process_reap_timeout'

  constructor(code: AgentOwnedProcessError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AgentOwnedProcessError'
    this.code = code
  }
}

function boundedInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AgentOwnedProcessError('invalid_launch', `${label} is invalid`)
  }
  return value
}

function safeNumber(value: bigint, label: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AgentOwnedProcessError('invalid_executable', `${label} is outside supported bounds`)
  }
  return result
}

function identity(path: string, info: BigIntStats, sha256: string): AgentPinnedExecutableIdentity {
  return {
    path,
    device: info.dev.toString(),
    inode: info.ino.toString(),
    uid: safeNumber(info.uid, 'Executable uid'),
    gid: safeNumber(info.gid, 'Executable gid'),
    mode: Number(info.mode & 0o7777n),
    size: safeNumber(info.size, 'Executable size'),
    nlink: safeNumber(info.nlink, 'Executable link count'),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
    sha256,
  }
}

function statMatches(info: BigIntStats, expected: AgentPinnedExecutableIdentity): boolean {
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

async function hashHandle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  const stream = handle.createReadStream({ autoClose: false, start: 0 })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export async function openPinnedAgentExecutable(path: string, label = 'Agent executable'): Promise<PinnedAgentExecutable> {
  if (process.platform !== 'linux' || typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new AgentOwnedProcessError('invalid_executable', `${label} path must be canonical and absolute`)
  }
  let handle: FileHandle | undefined
  try {
    const canonical = await realpath(path)
    const pathInfo = await lstat(path, { bigint: true })
    if (canonical !== path || pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
      throw new AgentOwnedProcessError('invalid_executable', `${label} path must name one regular file without symlinks`)
    }
    const uid = process.getuid?.()
    if (uid === undefined || (Number(pathInfo.uid) !== 0 && Number(pathInfo.uid) !== uid)
      || (pathInfo.mode & 0o022n) !== 0n || (pathInfo.mode & 0o111n) === 0n) {
      throw new AgentOwnedProcessError('invalid_executable', `${label} ownership or mode is unsafe`)
    }
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    handle = await open(path, constants.O_RDONLY | noFollow)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino
      || (Number(before.uid) !== 0 && Number(before.uid) !== uid)
      || (before.mode & 0o022n) !== 0n || (before.mode & 0o111n) === 0n) {
      throw new AgentOwnedProcessError('invalid_executable', `${label} identity changed while opening`)
    }
    const sha256 = await hashHandle(handle)
    const after = await handle.stat({ bigint: true })
    const pinned = identity(path, before, sha256)
    if (!statMatches(after, pinned)) {
      throw new AgentOwnedProcessError('invalid_executable', `${label} changed while hashing`)
    }
    let closePromise: Promise<void> | undefined
    const executable: PinnedAgentExecutable = {
      path,
      handle,
      identity: Object.freeze(pinned),
      revalidate: async () => {
        if (closePromise) throw new AgentOwnedProcessError('invalid_executable', `${label} is closed`)
        const [currentHandle, currentPath] = await Promise.all([
          handle!.stat({ bigint: true }),
          lstat(path, { bigint: true }),
        ])
        if (currentPath.isSymbolicLink() || !statMatches(currentHandle, pinned) || !statMatches(currentPath, pinned)) {
          throw new AgentOwnedProcessError('invalid_executable', `${label} identity changed`)
        }
      },
      close: () => {
        closePromise ??= handle!.close().catch(() => undefined)
        return closePromise
      },
    }
    return Object.freeze(executable)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (error instanceof AgentOwnedProcessError) throw error
    throw new AgentOwnedProcessError('invalid_executable', `${label} is unavailable`, error)
  }
}

interface LinuxProcessIdentity {
  processGroup: number
  session: number
  startTime: string
}

async function linuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity> {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
  const close = raw.lastIndexOf(')')
  if (close < 2) throw new Error('Malformed process identity')
  const fields = raw.slice(close + 1).trim().split(/\s+/)
  const processGroup = Number(fields[2])
  const session = Number(fields[3])
  const startTime = fields[19]
  if (!Number.isSafeInteger(processGroup) || !Number.isSafeInteger(session) || !/^\d+$/.test(startTime ?? '')) {
    throw new Error('Malformed process identity')
  }
  return { processGroup, session, startTime }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, ms)
    timer.unref()
  })
}

function sendGroupSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH') throw error
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') return true
    throw error
  }
}

async function waitForProcessGroupExit(pid: number, maximumMs: number): Promise<boolean> {
  const deadline = Date.now() + maximumMs
  while (processGroupExists(pid) && Date.now() < deadline) await wait(10)
  return !processGroupExists(pid)
}

async function awaitSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onSpawn = () => { child.off('error', onError); resolveSpawn() }
    const onError = (error: Error) => { child.off('spawn', onSpawn); rejectSpawn(error) }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

export async function startAgentOwnedProcess(options: StartAgentOwnedProcessOptions): Promise<AgentOwnedProcess> {
  if (process.platform !== 'linux' || !Array.isArray(options.args) || options.args.length > MAX_ARGUMENTS
    || options.args.some((entry) => typeof entry !== 'string' || entry.includes('\0'))
    || Buffer.byteLength(options.args.join('\0')) > MAX_ARGUMENT_BYTES
    || !isAbsolute(options.cwd) || resolve(options.cwd) !== options.cwd
    || Object.entries(options.env).some(([key, value]) => !ENV_NAME.test(key) || typeof value !== 'string' || value.includes('\0'))) {
    throw new AgentOwnedProcessError('invalid_launch', 'Owned process launch is invalid')
  }
  const stderrBytes = boundedInteger(options.stderrBytes, DEFAULT_STDERR_BYTES, 1024 * 1024, 'stderr bound')
  const terminationGraceMs = boundedInteger(options.terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, 30_000, 'termination grace')
  const reapTimeoutMs = boundedInteger(options.reapTimeoutMs, DEFAULT_REAP_TIMEOUT_MS, 60_000, 'reap timeout')
  if (options.signal?.aborted) throw new AgentOwnedProcessError('process_unavailable', 'Owned process was aborted')
  await options.executable.revalidate()

  let child: ChildProcess
  let settled: AgentOwnedProcessExit | undefined
  let resolveExited!: (value: AgentOwnedProcessExit) => void
  const exited = new Promise<AgentOwnedProcessExit>((resolveExit) => { resolveExited = resolveExit })
  try {
    child = spawn('/proc/self/fd/3', [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: [
        'ignore',
        'ignore',
        'pipe',
        options.executable.handle.fd,
        ...(options.inheritedHandles ?? []).map((handle) => handle.fd),
      ],
    })
    child.once('exit', (code, signal) => {
      settled = Object.freeze({ code, signal })
      resolveExited(settled)
    })
    await awaitSpawn(child)
  } catch (error) {
    throw new AgentOwnedProcessError('process_unavailable', 'Owned process could not be launched', error)
  }
  const pid = child.pid
  if (!Number.isSafeInteger(pid) || !pid || pid < 2) {
    child.kill('SIGKILL')
    throw new AgentOwnedProcessError('process_unavailable', 'Owned process did not expose a valid pid')
  }

  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (Buffer.byteLength(stderr, 'utf8') >= stderrBytes) return
    const remaining = stderrBytes - Buffer.byteLength(stderr, 'utf8')
    stderr += Buffer.from(chunk).subarray(0, remaining).toString('utf8')
  })
  let processIdentity: LinuxProcessIdentity | undefined
  try {
    processIdentity = await linuxProcessIdentity(pid)
    if (processIdentity.processGroup !== pid || processIdentity.session !== pid) {
      throw new Error('Owned process is not its detached process-group and session leader')
    }
  } catch (error) {
    if (!settled) {
      sendGroupSignal(pid, 'SIGKILL')
      await Promise.race([exited, wait(reapTimeoutMs)])
      throw new AgentOwnedProcessError('process_unavailable', 'Owned process identity could not be established', error)
    }
  }

  let closePromise: Promise<void> | undefined
  const abort = () => { void close().catch(() => undefined) }
  const signalTargetMatches = async (): Promise<boolean> => {
    if (!processIdentity) return false
    if (options.processIdentityMatches) return options.processIdentityMatches(pid, processIdentity)
    let current: LinuxProcessIdentity
    try {
      current = await linuxProcessIdentity(pid)
    } catch (error) {
      if (settled && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        // Linux retains the numeric process-group identity while descendants
        // remain, even after its original leader has been reaped.
        return true
      }
      throw new AgentOwnedProcessError('process_unavailable', 'Owned process identity could not be revalidated', error)
    }
    return current.processGroup === processIdentity.processGroup
      && current.session === processIdentity.session
      && current.startTime === processIdentity.startTime
  }
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      options.signal?.removeEventListener('abort', abort)
      if (!processGroupExists(pid)) {
        if (!settled) await Promise.race([exited.then(() => undefined), wait(reapTimeoutMs)])
        return
      }
      if (!await signalTargetMatches()) return
      try { options.onGroupSignal?.('SIGTERM') } catch { /* test/telemetry hooks cannot block cleanup */ }
      sendGroupSignal(pid, 'SIGTERM')
      if (!await waitForProcessGroupExit(pid, terminationGraceMs)) {
        if (!await signalTargetMatches()) return
        try { options.onGroupSignal?.('SIGKILL') } catch { /* test/telemetry hooks cannot block cleanup */ }
        sendGroupSignal(pid, 'SIGKILL')
        if (!await waitForProcessGroupExit(pid, reapTimeoutMs)) {
          throw new AgentOwnedProcessError('process_reap_timeout', 'Owned process group did not exit')
        }
      }
      if (!settled) await Promise.race([exited.then(() => undefined), wait(reapTimeoutMs)])
    })()
    return closePromise
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) await close()

  return Object.freeze({
    pid,
    get stderr() { return stderr },
    exited,
    revalidate: async () => {
      if (settled || closePromise || !processIdentity) {
        throw new AgentOwnedProcessError('process_unavailable', 'Owned process is unavailable')
      }
      const current = await linuxProcessIdentity(pid).catch((error) => {
        throw new AgentOwnedProcessError('process_unavailable', 'Owned process is unavailable', error)
      })
      if (current.processGroup !== processIdentity.processGroup || current.session !== processIdentity.session
        || current.startTime !== processIdentity.startTime) {
        throw new AgentOwnedProcessError('process_unavailable', 'Owned process identity changed')
      }
      await options.executable.revalidate()
    },
    close,
  })
}
