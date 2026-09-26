import { ChildProcess, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { createServer } from 'net'
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { readFile, readdir } from 'fs/promises'
import axios from 'axios'
import { getSettings } from './settings-store'
import { logger } from './logger'
import { cleanPythonEnv, getVenvPythonExe } from './python-setup'

const API_PORT = 8765
const API_HOST = '127.0.0.1'
export const API_BASE_URL = `http://${API_HOST}:${API_PORT}`

async function assertApiPortAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error: NodeJS.ErrnoException) => {
      const reason = error.code === 'EADDRINUSE' ? 'occupied' : `unavailable (${error.code ?? error.message})`
      reject(new Error(`FastAPI port ${API_PORT} is ${reason}; stop the other listener or free the port and retry. Modly will not terminate it.`))
    })
    probe.listen(API_PORT, API_HOST, () => {
      probe.close((error) => error ? reject(error) : resolve())
    })
  })
}

interface LinuxProcessIdentity {
  pid: number
  processGroup: number
  session: number
  startTime: string
  state: string
}

interface OwnedLinuxGroup {
  leaderPid: number
  leaderStartTime: string
  launchId: string
}

async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)
    const processGroup = Number(fields[2])
    const session = Number(fields[3])
    const startTime = fields[19]
    if (!Number.isSafeInteger(processGroup) || !Number.isSafeInteger(session)
      || !/^\d+$/.test(startTime ?? '') || !fields[0]) return null
    return { pid, processGroup, session, startTime, state: fields[0] }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error
      && ['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code))) return null
    throw error
  }
}

async function assertLinuxProcAvailable(): Promise<void> {
  if (process.platform !== 'linux') return
  try {
    const [self, entries] = await Promise.all([
      readLinuxProcessIdentity(process.pid),
      readdir('/proc'),
    ])
    if (self && entries.length > 0) return
  } catch {
    // A restricted /proc is unsupported for owned Linux group cleanup.
  }
  throw new Error('Linux process identity metadata is unavailable; FastAPI was not launched')
}

function childIsRunning(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!childIsRunning(child)) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(!childIsRunning(child))
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function terminateDirectChildHandle(child: ChildProcess): Promise<void> {
  if (!childIsRunning(child)) return
  child.kill('SIGTERM')
  if (await waitForChildExit(child, 1_500)) return
  child.kill('SIGKILL')
  if (!await waitForChildExit(child, 1_500)) throw new Error('FastAPI direct child did not exit after bounded shutdown')
}

function processGroupExists(group: OwnedLinuxGroup): boolean {
  try {
    process.kill(-group.leaderPid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ESRCH') return false
      if (error.code === 'EPERM') return true
    }
    throw error
  }
}

async function groupMembers(group: OwnedLinuxGroup): Promise<LinuxProcessIdentity[]> {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch (error) {
    throw new Error('Unable to verify owned FastAPI process-group metadata; refusing group signal', { cause: error })
  }
  const members: LinuxProcessIdentity[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const identity = await readLinuxProcessIdentity(Number(entry))
    if (identity?.processGroup === group.leaderPid && identity.session === group.leaderPid) members.push(identity)
  }
  return members
}

async function liveGroupMembers(group: OwnedLinuxGroup): Promise<LinuxProcessIdentity[]> {
  const members = await groupMembers(group)
  if (members.length === 0 && processGroupExists(group)) {
    throw new Error('Unable to verify owned FastAPI process-group members; refusing group signal')
  }
  return members.filter((member) => member.state !== 'Z' && member.state !== 'X')
}

async function validateOwnedGroup(group: OwnedLinuxGroup): Promise<LinuxProcessIdentity[]> {
  const members = await liveGroupMembers(group)
  if (members.length === 0) return members
  const leader = await readLinuxProcessIdentity(group.leaderPid)
  if (leader && (leader.startTime !== group.leaderStartTime
    || leader.processGroup !== group.leaderPid || leader.session !== group.leaderPid)) {
    throw new Error('Refusing to signal FastAPI group: leader identity changed')
  }
  if (leader && leader.state !== 'Z' && leader.state !== 'X') return members

  // After the leader exits, Linux retains its group/session number while an
  // inherited member lives. Require the launch marker on one live member so
  // a recycled numeric group cannot be mistaken for this launch.
  const marker = Buffer.from(`MODLY_BRIDGE_LAUNCH_ID=${group.launchId}\0`)
  for (const member of members) {
    try {
      if (BigInt(member.startTime) >= BigInt(group.leaderStartTime)
        && (await readFile(`/proc/${member.pid}/environ`)).includes(marker)) return members
    } catch { /* A vanished or unreadable member cannot establish ownership. */ }
  }
  throw new Error('Refusing to signal FastAPI group: no owned live member could be verified')
}

function signalOwnedGroup(group: OwnedLinuxGroup, signal: NodeJS.Signals): void {
  try {
    process.kill(-group.leaderPid, signal)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return
    throw error
  }
}

async function waitForOwnedGroupExit(group: OwnedLinuxGroup, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await liveGroupMembers(group)).length === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return (await liveGroupMembers(group)).length === 0
}

async function terminateOwnedGroup(group: OwnedLinuxGroup, child: ChildProcess | null): Promise<void> {
  try {
    if ((await validateOwnedGroup(group)).length === 0) {
      if (child) await terminateDirectChildHandle(child)
      return
    }
    signalOwnedGroup(group, 'SIGTERM')
    if (!await waitForOwnedGroupExit(group, 1_500)) {
      if ((await validateOwnedGroup(group)).length > 0) {
        signalOwnedGroup(group, 'SIGKILL')
        if (!await waitForOwnedGroupExit(group, 1_500)) {
          throw new Error('Owned FastAPI process group did not exit after bounded shutdown')
        }
      }
    }
    if (child && childIsRunning(child) && !await waitForChildExit(child, 1_500)) {
      throw new Error('Owned FastAPI group stopped but its direct child was not reaped')
    }
  } catch (error) {
    // The ChildProcess handle is still ours even if /proc cannot validate a
    // negative group PID. Reap that direct child but never guess at the group.
    if (child && childIsRunning(child)) await terminateDirectChildHandle(child)
    throw error
  }
}

export class PythonBridge {
  private process: ChildProcess | null = null
  private ready = false
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private startAbort: AbortController | null = null
  private ownedGroup: OwnedLinuxGroup | null = null
  private getWindow: (() => BrowserWindow | null) | null = null
  private intentionalStop = false

  setWindowGetter(fn: () => BrowserWindow | null): void {
    this.getWindow = fn
  }

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise
    if (this.ready) return
    if (this.startPromise) return this.startPromise
    if (this.ownedGroup) await this.stop()
    this.startAbort = new AbortController()
    this.startPromise = this._start(this.startAbort.signal)
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
      this.startAbort = null
    }
  }

  private async _start(signal: AbortSignal): Promise<void> {
    if (this.process) {
      throw new Error('FastAPI direct child is still running; stop it before retrying')
    }

    // Keep the established fixed-port contract; never evict a foreign listener.
    await assertApiPortAvailable()
    await assertLinuxProcAvailable()
    if (signal.aborted) throw new Error('FastAPI startup cancelled by shutdown')

    const pythonExecutable = this.resolvePythonExecutable()
    const apiDir = this.resolveApiDir()
    const launchId = randomUUID()

    console.log('[PythonBridge] Starting FastAPI at', apiDir)
    console.log('[PythonBridge] Python executable:', pythonExecutable)

    const child = spawn(pythonExecutable, ['-m', 'uvicorn', 'main:app', '--host', API_HOST, '--port', String(API_PORT)], {
      cwd: apiDir,
      env: {
        ...cleanPythonEnv(),
        PYTHONUNBUFFERED:       '1',
        MODLY_BRIDGE_LAUNCH_ID: launchId,
        // No PYTHONPATH needed - the venv's Python has its own isolated site-packages
        MODELS_DIR:             this.resolveModelsDir(),
        WORKSPACE_DIR:          this.resolveWorkspaceDir(),
        EXTENSIONS_DIR:         this.resolveExtensionsDir(),
        SELECTED_MODEL_ID:      process.env['SELECTED_MODEL_ID'] ?? '',
        // Server-side only: renderer/settings/preload never receive the OpenAI key.
        OPENAI_API_KEY:         process.env['OPENAI_API_KEY'] ?? '',
        HUGGING_FACE_HUB_TOKEN: this.resolveHfToken(),
        HF_TOKEN:               this.resolveHfToken(),
      },
      // Unix launches a dedicated session/group; ExtensionProcess.Popen does
      // not detach, so its runner inherits this exact group.
      detached: process.platform === 'linux',
    })
    this.process = child
    let spawnError: Error | null = null
    child.on('error', (error) => { spawnError = error })

    child.stdout?.on('data', (data) => {
      const msg = data.toString().trim()
      console.log('[FastAPI]', msg)
      logger.python(msg)
      this.emitTqdmLog(msg)
    })

    child.stderr?.on('data', (data) => {
      const msg = data.toString().trim()
      console.error('[FastAPI]', msg)
      logger.python(`[stderr] ${msg}`)
      this.emitTqdmLog(msg)
    })

    child.on('exit', (code) => {
      const wasReady = this.ready
      console.log('[PythonBridge] Process exited with code', code)
      if (this.process === child) {
        this.ready = false
        this.process = null
        if (wasReady && !this.intentionalStop) {
          this.getWindow?.()?.webContents.send('python:crashed', { code })
        }
      }
    })

    let group: OwnedLinuxGroup | null = null
    if (process.platform === 'linux' && child.pid !== undefined) {
      let identity: LinuxProcessIdentity | null
      try {
        identity = await readLinuxProcessIdentity(child.pid)
      } catch (error) {
        await terminateDirectChildHandle(child)
        throw new Error('Owned FastAPI process-group identity could not be read', { cause: error })
      }
      if (!identity || identity.processGroup !== child.pid || identity.session !== child.pid) {
        await terminateDirectChildHandle(child)
        throw new Error('Owned FastAPI process-group identity could not be established')
      }
      group = { leaderPid: child.pid, leaderStartTime: identity.startTime, launchId }
      this.ownedGroup = group
    }

    try {
      await this.waitUntilReady(child, group, signal, launchId, () => spawnError)
    } catch (error) {
      if (group) await terminateOwnedGroup(group, child)
      else await terminateDirectChildHandle(child)
      if (this.process === child) {
        this.process = null
      }
      if (this.ownedGroup === group) this.ownedGroup = null
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this._stop()
    try { await this.stopPromise } finally { this.stopPromise = null }
  }

  private async _stop(): Promise<void> {
    this.intentionalStop = true
    this.startAbort?.abort()
    try {
      try { await this.startPromise } catch { /* Startup cancellation is expected. */ }
      const child = this.process
      const group = this.ownedGroup
      if (group) {
        await terminateOwnedGroup(group, child)
        if (this.ownedGroup === group) this.ownedGroup = null
      } else if (child) {
        await terminateDirectChildHandle(child)
      }
      if (child) {
        if (this.process === child) {
          this.process = null
        }
      }
      this.ready = false
      console.log('[PythonBridge] Stopped')
    } finally {
      this.intentionalStop = false
    }
  }

  async restart(): Promise<void> {
    console.log('[PythonBridge] Restarting to free memory…')
    await this.stop()
    await this.start()
  }

  private emitTqdmLog(raw: string): void {
    if (/INFO/.test(raw)) return
    if (!raw.trim()) return
    this.getWindow?.()?.webContents.send('python:log', raw.trim())
  }

  isReady(): boolean { return this.ready }
  getPort(): number { return API_PORT }

  private async waitUntilReady(
    child: ChildProcess,
    group: OwnedLinuxGroup | null,
    signal: AbortSignal,
    launchId: string,
    spawnError?: () => Error | null,
    maxRetries = 180,
    delayMs = 500,
  ): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      if (signal.aborted) throw new Error('FastAPI startup cancelled by shutdown')
      if (spawnError?.()) throw new Error(`FastAPI failed to launch: ${spawnError()!.message}`)
      if (this.process !== child || !childIsRunning(child)) throw new Error('FastAPI process exited unexpectedly during startup')
      if (process.platform === 'linux' && (!group || (await readLinuxProcessIdentity(child.pid!))?.startTime !== group.leaderStartTime)) {
        throw new Error('FastAPI process identity changed during startup')
      }
      try {
        const response = await axios.get(`${API_BASE_URL}/health`, { timeout: 2000 })
        if (response.data?.bridge_instance !== launchId) {
          throw new Error(`FastAPI port ${API_PORT} is occupied by a different service; Modly will not use or terminate it.`)
        }
        if (signal.aborted || this.process !== child || !childIsRunning(child)) {
          throw new Error('FastAPI startup cancelled by shutdown')
        }
        this.ready = true
        console.log('[PythonBridge] FastAPI is ready')
        return
      } catch (error) {
        if (error instanceof Error && error.message.includes('occupied by a different service')) throw error
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    throw new Error('FastAPI did not start in time')
  }

  private resolvePythonExecutable(): string {
    const userData = app.getPath('userData')
    const apiDir = this.resolveApiDir()

    // Primary: venv created during setup (bundled Python → isolated venv)
    const venvPython = getVenvPythonExe(userData)
    if (existsSync(venvPython)) return venvPython

    // Dev fallback: local .venv in the api directory
    const devCandidates = [
      join(apiDir, '.venv', 'Scripts', 'python.exe'),
      join(apiDir, '.venv', 'bin', 'python'),
    ]
    for (const c of devCandidates) {
      if (existsSync(c)) return c
    }

    // Never fall back to bare 'python' on Windows — it would be the user's system Python
    if (process.platform === 'win32') {
      throw new Error('Python venv not found. Please restart the application to re-run setup.')
    }
    return 'python3'
  }

  private resolveApiDir(): string {
    if (app.isPackaged) return join(process.resourcesPath, 'api')
    return join(app.getAppPath(), 'api')
  }

  private resolveModelsDir(): string {
    const s = getSettings(app.getPath('userData'))
    mkdirSync(s.modelsDir, { recursive: true })
    return s.modelsDir
  }

  private resolveWorkspaceDir(): string {
    const s = getSettings(app.getPath('userData'))
    mkdirSync(s.workspaceDir, { recursive: true })
    return s.workspaceDir
  }

  private resolveExtensionsDir(): string {
    const s = getSettings(app.getPath('userData'))
    mkdirSync(s.extensionsDir, { recursive: true })
    return s.extensionsDir
  }

  private resolveHfToken(): string {
    return getSettings(app.getPath('userData')).hfToken ?? ''
  }
}
