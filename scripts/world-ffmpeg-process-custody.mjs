import { spawn } from 'node:child_process'

// Packaging includes native archive extraction and signing on shared CI hosts.
// Two hours is the audited production ceiling; shorter test authorities may be
// injected, but no invocation may disable the watchdog.
export const WORLD_FFMPEG_PACKAGE_EXECUTION_TIMEOUT_MS = 2 * 60 * 60 * 1_000
const MAX_EXECUTION_TIMEOUT_MS = 4 * 60 * 60 * 1_000

export function spawnWorldFfmpegPackageProcess(file, args, options, authority = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const platform = authority.platform ?? process.platform
    const signalSource = authority.signalSource ?? process
    const spawnNative = authority.spawnNative ?? spawn
    const terminationGraceMs = requireBoundedMilliseconds(
      authority.terminationGraceMs, 5_000, 'termination grace',
    )
    const closeWaitMs = requireBoundedMilliseconds(authority.closeWaitMs, 10_000, 'close wait')
    const executionTimeoutMs = requireBoundedMilliseconds(
      authority.executionTimeoutMs,
      WORLD_FFMPEG_PACKAGE_EXECUTION_TIMEOUT_MS,
      'execution watchdog',
      MAX_EXECUTION_TIMEOUT_MS,
    )
    const processGroupId = requireProcessGroupId(authority.processGroupId, platform)
    const captureStdoutBytes = authority.captureStdoutBytes === undefined
      ? 0
      : requireBoundedCaptureBytes(authority.captureStdoutBytes)
    const child = spawnNative(file, args, options)
    let stdout = Buffer.alloc(0)
    let settled = false
    let spawned = false
    let processError
    let cancellationSignal
    let graceTimer
    let closeTimer
    let executionTimer
    let lateCloseOwned = false
    let lateCloseStarted = false
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
    const removeSignalListeners = () => {
      for (const signal of signals) signalSource.off(signal, onSignal)
    }
    const clearTerminationTimers = () => {
      if (graceTimer) clearTimeout(graceTimer)
      if (closeTimer) clearTimeout(closeTimer)
      if (executionTimer) clearTimeout(executionTimer)
      graceTimer = undefined
      closeTimer = undefined
      executionTimer = undefined
    }
    const finish = (operation) => {
      if (settled) return
      settled = true
      removeSignalListeners()
      clearTerminationTimers()
      operation()
    }
    const invokeTreeTermination = (force) => {
      if (!Number.isSafeInteger(child.pid) || child.pid < 1) return
      if (platform === 'win32') {
        spawnWindowsTreeKiller(child.pid, force, options, authority)
        return
      }
      const killProcessGroup = authority.killProcessGroup ?? process.kill.bind(process)
      const groupId = processGroupId ?? child.pid
      try { killProcessGroup(-groupId, force ? 'SIGKILL' : 'SIGTERM') } catch (error) {
        processError ??= error
      }
    }
    const beginCancellation = (reason, signal) => {
      if (cancellationSignal !== undefined) return
      cancellationSignal = signal ?? reason
      invokeTreeTermination(false)
      graceTimer = setTimeout(() => invokeTreeTermination(true), terminationGraceMs)
      closeTimer = setTimeout(() => {
        if (settled) return
        lateCloseOwned = true
        const error = new Error(reason === 'watchdog'
          ? 'World FFmpeg package runner watchdog termination timed out.'
          : 'World FFmpeg package runner termination timed out.')
        error.custodyUnsettled = true
        finish(() => rejectPromise(error))
      }, terminationGraceMs + closeWaitMs)
    }
    function onSignal(signal) {
      beginCancellation('signal', signal)
    }
    for (const signal of signals) signalSource.on(signal, onSignal)
    if (captureStdoutBytes > 0) {
      if (!child.stdout || typeof child.stdout.on !== 'function') {
        finish(() => rejectPromise(new Error('World FFmpeg package runner stdout capture is unavailable.')))
        return
      }
      child.stdout.on('data', (chunk) => {
        if (stdout.byteLength + chunk.byteLength > captureStdoutBytes) {
          processError ??= new Error('World FFmpeg package runner stdout exceeded its byte bound.')
          beginCancellation('stdout-bound')
          return
        }
        stdout = Buffer.concat([stdout, chunk])
      })
    }
    child.once('spawn', () => {
      spawned = true
      executionTimer = setTimeout(() => beginCancellation('watchdog'), executionTimeoutMs)
    })
    child.on('error', (error) => {
      if (!spawned) {
        finish(() => rejectPromise(error))
        return
      }
      processError ??= error
    })
    child.on('close', (code, signal) => {
      if (lateCloseOwned) {
        if (lateCloseStarted) return
        lateCloseStarted = true
        void superviseLateClose(authority, { code, signal, processError })
        return
      }
      finish(() => {
        if (processError !== undefined) rejectPromise(processError)
        else if (cancellationSignal === 'watchdog') {
          rejectPromise(new Error('World FFmpeg package runner exceeded its execution watchdog.'))
        } else if (cancellationSignal !== undefined) {
          rejectPromise(new Error(`World FFmpeg package runner cancelled by ${cancellationSignal}.`))
        } else resolvePromise({
          code,
          signal,
          ...(captureStdoutBytes > 0 ? { stdout } : {}),
        })
      })
    })
  })
}

function requireBoundedCaptureBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024) {
    throw new Error('World FFmpeg package runner stdout capture bound is invalid.')
  }
  return value
}

function requireProcessGroupId(value, platform) {
  if (value === undefined) return undefined
  if (platform === 'win32' || !Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new Error('World FFmpeg package runner process-group authority is invalid.')
  }
  return value
}

async function superviseLateClose(authority, result) {
  try {
    await authority.onLateClose?.(result)
  } catch (error) {
    try {
      if (typeof authority.onLateCloseError === 'function') {
        await authority.onLateCloseError(error)
      } else {
        process.stderr.write(`World FFmpeg late package cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    } catch (reportError) {
      process.stderr.write(`World FFmpeg late package cleanup reporting failed: ${reportError instanceof Error ? reportError.message : String(reportError)}\n`)
    }
  }
}

function spawnWindowsTreeKiller(pid, force, options, authority) {
  const environment = options?.env
  const systemRoot = environment?.SystemRoot
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/i.test(systemRoot)
    || typeof environment?.WINDIR !== 'string'
    || environment.WINDIR.toLowerCase() !== systemRoot.toLowerCase()) return
  const spawnTreeKiller = authority.spawnTreeKiller ?? spawn
  const taskkill = `${systemRoot}\\System32\\taskkill.exe`
  const args = ['/PID', String(pid), '/T']
  if (force) args.push('/F')
  try {
    const killer = spawnTreeKiller(taskkill, args, Object.freeze({
      cwd: `${systemRoot}\\System32`,
      env: Object.freeze({
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATH: `${systemRoot}\\System32;${systemRoot}`,
        COMSPEC: `${systemRoot}\\System32\\cmd.exe`,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      }),
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: Object.freeze(['ignore', 'ignore', 'ignore']),
    }))
    killer.on('error', () => undefined)
    killer.on('close', () => undefined)
  } catch { /* fail closed through bounded parent timeout */ }
}

function requireBoundedMilliseconds(value, fallback, label, maximum = 60_000) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`World FFmpeg package runner ${label} is invalid.`)
  }
  return result
}
