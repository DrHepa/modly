import { Worker }      from 'worker_threads'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync }  from 'fs'
import { join }        from 'path'
import { app }         from 'electron'

// ─── Worker code for JS process extensions ────────────────────────────────────

const WORKER_CODE = /* js */ `
const { workerData, parentPort } = require('worker_threads')
const path = require('path')
const Module = require('module')

// Resolve modules from the extension's own node_modules
const require_ext = Module.createRequire(path.join(workerData.extDir, '_'))

let processor
try {
  processor = require_ext(path.join(workerData.extDir, workerData.entry))
  if (typeof processor !== 'function') {
    throw new Error('processor.js must export a function as module.exports')
  }
} catch (err) {
  parentPort.postMessage({ type: 'error', message: 'Failed to load processor: ' + String(err) })
  process.exit(1)
}

parentPort.postMessage({ type: 'ready' })

parentPort.on('message', async (msg) => {
  if (msg.action !== 'run') return
  try {
    const context = {
      workspaceDir: workerData.workspaceDir,
      tempDir:      workerData.tempDir,
      nodeId:       msg.input?.nodeId ?? '',
      log:      (m)         => parentPort.postMessage({ type: 'log',      message: String(m) }),
      progress: (pct, label) => parentPort.postMessage({ type: 'progress', percent: pct, label }),
    }
    const result = await processor(msg.input, msg.params, context)
    parentPort.postMessage({ type: 'done', result })
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String(err) })
  }
})
`

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProcessInput {
  filePath?: string
  text?:     string
  /** Per-slot texts for multi-text-input nodes (index = target handle slot). */
  texts?:    (string | undefined)[]
  nodeId?:   string
}

export interface ProcessResult {
  filePath?: string
  text?:     string
}

export interface IProcessRunner {
  run(
    input:       ProcessInput,
    params:      Record<string, unknown>,
    onProgress?: (percent: number, label: string) => void,
    onLog?:      (message: string) => void,
  ): Promise<ProcessResult>
  terminate(): void
}

export type CreateRunScopedProcessRunnerOptions = {
  extDir: string
  entry: string
  workspaceDir: string
  tempDir: string
  pythonExe?: string
}

type QueuedProcessRun = {
  execute: () => Promise<ProcessResult>
  resolve: (result: ProcessResult) => void
  reject: (error: unknown) => void
}

// ─── JS ProcessRunner (Worker thread) ────────────────────────────────────────

export class ProcessRunner implements IProcessRunner {
  private worker:   Worker | null = null
  private ready:    boolean       = false
  private extDir:   string
  private entry:    string
  private workspaceDir: string
  private tempDir:  string
  private activeReject: ((error: Error) => void) | null = null
  private readonly queuedRuns: QueuedProcessRun[] = []
  private executing = false

  constructor(extDir: string, entry: string, workspaceDir: string, tempDir: string) {
    this.extDir       = extDir
    this.entry        = entry
    this.workspaceDir = workspaceDir
    this.tempDir      = tempDir
  }

  private async ensureReady(): Promise<void> {
    if (this.ready && this.worker) return

    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_CODE, {
        eval: true,
        workerData: {
          extDir:       this.extDir,
          entry:        this.entry,
          workspaceDir: this.workspaceDir,
          tempDir:      this.tempDir,
        },
      })

      // Keep ownership while loading too: cancellation may arrive before ready.
      this.worker = worker
      const settleStartup = () => {
        worker.off('message', onMessage)
        if (this.activeReject === rejectStartup) this.activeReject = null
      }
      const rejectStartup = (error: Error) => {
        settleStartup()
        this.discardWorker(worker)
        reject(error)
      }
      this.activeReject = rejectStartup
      const onMessage = (msg: { type: string; message?: string }) => {
        if (this.worker !== worker) return
        if (msg.type === 'ready') {
          settleStartup()
          this.ready  = true
          resolve()
        } else if (msg.type === 'error') {
          rejectStartup(new Error(msg.message))
          void worker.terminate()
        }
      }
      worker.on('message', onMessage)

      // Retain an error listener after ready for failures while idle.
      worker.once('error', rejectStartup)

      // A worker can also die between runs (e.g. a timer the processor left
      // behind throws after it returned). Forget it whenever it exits, so the
      // next run starts a fresh one instead of posting into a dead thread.
      worker.once('exit', (code) => {
        rejectStartup(new Error(`Process extension worker exited with code ${code}`))
      })
    })
  }

  run(
    input: ProcessInput,
    params: Record<string, unknown>,
    onProgress?: (percent: number, label: string) => void,
    onLog?: (message: string) => void,
  ): Promise<ProcessResult> {
    // Worker messages are untagged. Serialize whole invocations, including
    // startup, so each call owns its result, callbacks and cancellation target.
    return new Promise((resolve, reject) => {
      this.queuedRuns.push({ execute: () => this.runOne(input, params, onProgress, onLog), resolve, reject })
      this.startNextRun()
    })
  }

  private startNextRun(): void {
    if (this.executing) return
    const next = this.queuedRuns.shift()
    if (!next) return
    this.executing = true
    void next.execute().then(
      (result) => {
        this.executing = false
        next.resolve(result)
        this.startNextRun()
      },
      (error: unknown) => {
        this.executing = false
        next.reject(error)
        this.startNextRun()
      },
    )
  }

  private async runOne(
    input:  ProcessInput,
    params: Record<string, unknown>,
    onProgress?: (percent: number, label: string) => void,
    onLog?:      (message: string) => void,
  ): Promise<ProcessResult> {
    await this.ensureReady()
    const worker = this.worker
    if (!worker) throw new Error('Process run terminated.')

    return new Promise((resolve, reject) => {
      const settle = () => {
        worker.off('message', handler)
        worker.off('error', onError)
        worker.off('exit', onExit)
        if (this.activeReject === rejectRun) this.activeReject = null
      }
      const rejectRun = (error: unknown) => {
        settle()
        reject(error)
      }
      this.activeReject = rejectRun
      const handler = (msg: { type: string; result?: ProcessResult; message?: string; percent?: number; label?: string }) => {
        if (msg.type === 'progress') {
          onProgress?.(msg.percent ?? 0, msg.label ?? '')
        } else if (msg.type === 'log') {
          onLog?.(msg.message ?? '')
        } else if (msg.type === 'done') {
          settle()
          resolve(msg.result ?? {})
        } else if (msg.type === 'error') {
          settle()
          reject(new Error(msg.message))
        }
      }
      // A worker that dies mid-run (an uncaught error, out of memory,
      // process.exit) never posts 'done' or 'error'. Settle the run instead of
      // waiting forever, and drop the dead worker so the next run starts a
      // fresh one rather than posting into it.
      const onError = (err: Error) => {
        settle()
        this.discardWorker(worker)
        reject(err)
      }
      const onExit = (code: number) => {
        settle()
        this.discardWorker(worker)
        reject(new Error(`Process extension worker exited with code ${code}`))
      }

      worker.on('message', handler)
      worker.on('error', onError)
      worker.on('exit', onExit)
      try {
        worker.postMessage({ action: 'run', input, params })
      } catch (error) {
        // A structured-clone failure rejects the submission, not the healthy
        // thread. Retain ownership for the next queued run or terminate().
        rejectRun(error)
      }
    })
  }

  private discardWorker(worker: Worker): void {
    if (this.worker !== worker) return
    this.worker = null
    this.ready  = false
  }

  terminate(): void {
    const error = new Error('Process run terminated.')
    for (const pending of this.queuedRuns.splice(0)) pending.reject(error)
    const worker = this.worker
    this.activeReject?.(error)
    this.activeReject = null
    void worker?.terminate()
    this.worker = null
    this.ready  = false
  }
}

// ─── Python ProcessRunner (subprocess, one process per run) ───────────────────
//
// Protocol — stdin:  one JSON line  { input, params, workspaceDir, tempDir }
// Protocol — stdout: JSON lines     { type: 'progress'|'log'|'done'|'error', ... }

export class PythonProcessRunner implements IProcessRunner {
  private pythonExe:    string
  private extDir:       string
  private scriptPath:   string
  private workspaceDir: string
  private tempDir:      string
  private currentProc: ChildProcessWithoutNullStreams | null = null
  private activeReject: ((error: Error) => void) | null = null

  constructor(pythonExe: string, extDir: string, entry: string, workspaceDir: string, tempDir: string) {
    this.pythonExe    = pythonExe
    this.extDir       = extDir
    this.scriptPath   = join(extDir, entry)
    this.workspaceDir = workspaceDir
    this.tempDir      = tempDir
  }

  async run(
    input:  ProcessInput,
    params: Record<string, unknown>,
    onProgress?: (percent: number, label: string) => void,
    onLog?:      (message: string) => void,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonExe, [this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Force UTF-8 stdio so Unicode prints from process extensions do not
          // crash under legacy Windows codepages (cp1252/cp932).
          PYTHONUTF8: '1',
          // Built-in process nodes may import shared services from the backend.
          MODLY_API_DIR: app.isPackaged
            ? join(process.resourcesPath, 'api')
            : join(app.getAppPath(), 'api'),
          // Electron is also the packaged Node runtime. meshopt_runner.cjs uses
          // ELECTRON_RUN_AS_NODE when it launches this executable.
          MODLY_NODE_EXECUTABLE: process.execPath,
          EXTENSION_DIR: this.extDir,
          WORKSPACE_DIR: this.workspaceDir,
          TEMP_DIR: this.tempDir,
        },
      })
      this.currentProc = proc
      let resolved = false
      const settle = (error?: Error, result: ProcessResult = {}) => {
        if (resolved) return
        resolved = true
        if (this.activeReject === cancel) this.activeReject = null
        if (error) reject(error)
        else resolve(result)
      }
      const cancel = (error: Error) => settle(error)
      this.activeReject = cancel
      // Keep currentProc until close so run-scoped cleanup can terminate a
      // child that emits done but still owns timers or other resources.
      proc.stdin.on('error', (error) => settle(error))

      // Send input as a single JSON line on stdin
      proc.stdin.write(JSON.stringify({
        input,
        params,
        nodeId:       input.nodeId ?? '',
        workspaceDir: this.workspaceDir,
        tempDir:      this.tempDir,
      }) + '\n')
      proc.stdin.end()

      let stdoutBuf = ''

      proc.stdout.on('data', (chunk: Buffer) => {
        if (resolved) return
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() ?? ''

        for (const line of lines) {
          if (resolved) break
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const msg = JSON.parse(trimmed) as { type: string; percent?: number; label?: string; message?: string; result?: ProcessResult }
            if (msg.type === 'progress') {
              onProgress?.(msg.percent ?? 0, msg.label ?? '')
            } else if (msg.type === 'log') {
              onLog?.(msg.message ?? '')
            } else if (msg.type === 'done') {
              settle(undefined, msg.result ?? {})
            } else if (msg.type === 'error') {
              settle(new Error(msg.message ?? 'Unknown error'))
            }
          } catch {
            // Non-JSON stdout line — treat as a log message
            onLog?.(trimmed)
          }
        }
      })

      let stderrBuf = ''
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString()
      })

      proc.on('close', (code) => {
        // A previous child may close after the next run has already started.
        if (this.currentProc === proc) this.currentProc = null
        settle(code === 0 ? undefined : new Error(stderrBuf.trim() || `Python process exited with code ${code}`))
      })

      proc.on('error', (err) => {
        if (this.currentProc === proc) this.currentProc = null
        settle(err)
      })
    })
  }

  terminate(): void {
    this.activeReject?.(new Error('Process run terminated.'))
    this.activeReject = null
    this.currentProc?.kill('SIGTERM')
    this.currentProc = null
  }
}

export function createRunScopedProcessRunner(options: CreateRunScopedProcessRunnerOptions): IProcessRunner {
  if (options.entry.endsWith('.py')) {
    if (!options.pythonExe) {
      throw new Error(`Python executable is required for process entry '${options.entry}'.`)
    }

    return new PythonProcessRunner(
      options.pythonExe,
      options.extDir,
      options.entry,
      options.workspaceDir,
      options.tempDir,
    )
  }

  return new ProcessRunner(
    options.extDir,
    options.entry,
    options.workspaceDir,
    options.tempDir,
  )
}

// ─── Helper: find Python executable for an extension ─────────────────────────

export function getExtPythonExe(extDir: string): string | null {
  const candidates = process.platform === 'win32'
    ? [join(extDir, 'venv', 'Scripts', 'python.exe')]
    : [join(extDir, 'venv', 'bin', 'python'), join(extDir, 'venv', 'bin', 'python3')]

  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

// ─── Registry (one runner per extension id, reused across calls) ──────────────

const registry = new Map<string, IProcessRunner>()
// The arguments each cached runner was built with. A runner bakes them in at
// construction, so a call with different ones — e.g. after the workspace is
// moved in Settings, which updates paths without a restart — must not get the
// old runner back, or node output keeps landing in the previous folder.
const registryArgs = new Map<string, string>()

function canReuseRunner(extensionId: string, args: string[]): boolean {
  const key = JSON.stringify(args)
  if (registry.has(extensionId) && registryArgs.get(extensionId) === key) return true
  terminateProcessRunner(extensionId)
  registryArgs.set(extensionId, key)
  return false
}

export function getProcessRunner(
  extensionId:  string,
  extDir:       string,
  entry:        string,
  workspaceDir: string,
  tempDir:      string,
): ProcessRunner {
  if (!canReuseRunner(extensionId, [extDir, entry, workspaceDir, tempDir])) {
    registry.set(extensionId, new ProcessRunner(extDir, entry, workspaceDir, tempDir))
  }
  return registry.get(extensionId)! as ProcessRunner
}

export function getPythonProcessRunner(
  extensionId:  string,
  pythonExe:    string,
  extDir:       string,
  entry:        string,
  workspaceDir: string,
  tempDir:      string,
): PythonProcessRunner {
  if (!canReuseRunner(extensionId, [pythonExe, extDir, entry, workspaceDir, tempDir])) {
    registry.set(extensionId, new PythonProcessRunner(pythonExe, extDir, entry, workspaceDir, tempDir))
  }
  return registry.get(extensionId)! as PythonProcessRunner
}

export function terminateProcessRunner(extensionId: string): void {
  registry.get(extensionId)?.terminate()
  registry.delete(extensionId)
}

export function terminateAllProcessRunners(): void {
  for (const runner of registry.values()) runner.terminate()
  registry.clear()
}
