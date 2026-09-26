import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'

import {
  WORLD_WEBM_AUDIO_CHANNELS,
  WORLD_WEBM_AUDIO_SAMPLE_RATE,
  WORLD_WEBM_MAX_AUDIO_CHUNK_SAMPLES,
  WORLD_WEBM_MAX_AUDIO_SAMPLES,
  WORLD_WEBM_MAX_FRAME_BYTES,
  WORLD_WEBM_MAX_FRAME_COUNT,
  WORLD_WEBM_MAX_OUTPUT_BYTES,
  WORLD_WEBM_MAX_WRITE_BYTES,
  type WorldWebmStartPayload,
} from '../../src/areas/worlds/render/worldWebmProtocol.ts'
import type { WorldRenderWebmAuthority } from './world-render-browser-executor.ts'
import type { WorldWebmFileOutputLease } from './world-render-output-repository.ts'
import {
  acquireWorldFfmpegExecutionLease,
  resolvePackagedWorldFfmpegRuntime,
  WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS,
  type VerifiedWorldFfmpegRuntime,
  type WorldFfmpegExecutionLease,
  type WorldFfmpegTrustedManifestKeys,
} from './world-render-ffmpeg-runtime.ts'

const MEBIBYTE = 1024 * 1024
const CONSERVATIVE_AUDIT_BYTES_PER_SECOND = 8 * MEBIBYTE
const REPOSITORY_PHASE_BASE_MS = 10_000
const PROCESS_DRAIN_BASE_MS = 10_000
const RUNTIME_FILE_CLOSE_MS = 250
const REPOSITORY_FILE_METADATA_MS = 5
const DEFAULT_KILL_GRACE_MS = 5_000
const DEFAULT_CLOSE_WAIT_MS = 10_000
const MIN_TIMEOUT_MS = 5
const MAX_HARD_TIMEOUT_MS = 30 * 60_000
const MAX_CUSTODY_AUDIT_BYTES = WORLD_WEBM_MAX_FRAME_COUNT * WORLD_WEBM_MAX_FRAME_BYTES
  + 44
  + WORLD_WEBM_MAX_AUDIO_SAMPLES * WORLD_WEBM_AUDIO_CHANNELS * 2
  + WORLD_WEBM_MAX_OUTPUT_BYTES * 3
const MAX_CUSTODY_TIMEOUT_MS = REPOSITORY_PHASE_BASE_MS
  + Math.ceil((MAX_CUSTODY_AUDIT_BYTES * 1_000) / CONSERVATIVE_AUDIT_BYTES_PER_SECOND)
  + (WORLD_WEBM_MAX_FRAME_COUNT + 1) * REPOSITORY_FILE_METADATA_MS
const MAX_TERMINATION_TIMEOUT_MS = 30_000
const MAX_PROGRESS_LINE_CHARS = 8 * 1024
const MAX_PROGRESS_RECORD_FIELDS = 32
const PROGRESS_TAIL_LINES = 8

export interface WorldFfmpegSpawnOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdio:
    | readonly ['pipe', 'pipe', 'pipe', 'pipe', number]
    | readonly ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', number]
  readonly shell: false
  readonly detached: false
  readonly windowsHide: true
}

export interface WorldFfmpegProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly stdio: readonly [Writable, Readable, Readable, ...(Writable | null)[]]
  kill: (signal?: number | NodeJS.Signals) => boolean
  unref: () => void
  on(event: 'error', listener: (error: Error) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  removeListener(event: 'error', listener: (error: Error) => void): this
  removeListener(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export type WorldFfmpegSpawn = (
  executablePath: string,
  args: readonly string[],
  options: WorldFfmpegSpawnOptions,
) => WorldFfmpegProcess

export type WorldFfmpegRuntimeLeaseAcquirer = (
  runtime: VerifiedWorldFfmpegRuntime,
) => Promise<WorldFfmpegExecutionLease>

export interface WorldFfmpegWebmAuthority extends WorldRenderWebmAuthority {
  acquireWebmFileOutputLease(
    jobId: string,
    generation: string,
    sinkId: string,
  ): WorldWebmFileOutputLease
}

export type WorldFfmpegAssemblyResult =
  | { readonly ok: true; readonly size: number; readonly sha256: string }
  | { readonly ok: false; readonly code: 'spawn-failed' | 'input-failed' | 'process-failed' | 'sink-failed' | 'timeout' }

export interface WorldFfmpegPhaseTimeouts {
  readonly inactivityMs: number
  readonly hardMs: number
  readonly sinkBeginMs: number
  readonly runtimeLeaseAcquireMs: number
  readonly runtimeLeaseReleaseMs: number
  readonly commitMs: number
  readonly confirmMs: number
  readonly abortMs: number
  readonly cancellationCleanupMs: number
  readonly taskDrainMs: number
}

interface RunnerTimeouts extends WorldFfmpegPhaseTimeouts {
  readonly killGraceMs: number
  readonly closeWaitMs: number
}

export type WorldFfmpegTimeoutOverrides = Partial<RunnerTimeouts> & {
  /** Test-only aggregate override retained for deterministic tiny deadlines. */
  readonly taskWaitMs?: number
}

class WorldFfmpegFailure extends Error {
  readonly code: Exclude<WorldFfmpegAssemblyResult, { ok: true }>['code']

  constructor(code: WorldFfmpegFailure['code'], message: string) {
    super(message)
    this.name = 'WorldFfmpegFailure'
    this.code = code
  }
}

// EventEmitter throws an emitted "error" with no listener. Keep this stateless
// terminal sink after close so a late ChildProcess error cannot crash main; it
// captures neither the child nor any runtime/output custody.
function consumeTerminalChildError(error: Error): void {
  void error
}

type OwnedPhaseOutcome<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'timeout' }
  | { readonly status: 'aborted' }

/**
 * Applies a caller-visible bound without abandoning the underlying authority
 * operation. Late fulfillment/rejection remains observed, and any late durable
 * effect is routed through the supplied compensating action.
 */
function settleOwnedPhase<T>(input: {
  readonly operation: () => Promise<T>
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly onLateFulfilled?: (value: T) => void | Promise<void>
  readonly onLateRejected?: (error: unknown) => void | Promise<void>
}): Promise<OwnedPhaseOutcome<T>> {
  return new Promise((resolvePromise) => {
    let waiting = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanupBoundary = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      input.signal?.removeEventListener('abort', onAbort)
    }
    const settleBoundary = (outcome: OwnedPhaseOutcome<T>): void => {
      if (!waiting) return
      waiting = false
      cleanupBoundary()
      resolvePromise(outcome)
    }
    const consumeLate = (operation: void | Promise<void>): void => {
      void Promise.resolve(operation).catch(() => undefined)
    }
    const onAbort = (): void => settleBoundary({ status: 'aborted' })
    const operation = Promise.resolve().then(input.operation)
    void operation.then(
      (value) => {
        if (waiting) settleBoundary({ status: 'fulfilled', value })
        else if (input.onLateFulfilled) {
          try { consumeLate(input.onLateFulfilled(value)) } catch { /* late compensation is fail-closed */ }
        }
      },
      (error: unknown) => {
        if (waiting) settleBoundary({ status: 'rejected', error })
        else if (input.onLateRejected) {
          try { consumeLate(input.onLateRejected(error)) } catch { /* late rejection stays consumed */ }
        }
      },
    )
    timer = setTimeout(() => settleBoundary({ status: 'timeout' }), input.timeoutMs)
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
  })
}

export function createWorldFfmpegArguments(plan: WorldWebmStartPayload): readonly string[] {
  const splitFinalFrame = plan.frameCount > 1
  const outputFd = splitFinalFrame ? 5 : 4
  const lastFrameDuration = plan.frameDurations[plan.frameCount - 1]
  if (!lastFrameDuration) throw new TypeError('World FFmpeg final frame duration is missing.')
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    '-nostats',
    '-progress', 'pipe:2',
    '-f', 'image2pipe',
    '-framerate', splitFinalFrame ? String(plan.fps) : formatReciprocalRate(lastFrameDuration),
    '-vcodec', 'png',
    '-i', 'pipe:0',
  ]
  if (splitFinalFrame) {
    args.push(
      '-f', 'image2pipe',
      '-framerate', formatReciprocalRate(lastFrameDuration),
      '-vcodec', 'png',
      '-i', 'pipe:3',
    )
  }
  const audioPipe = splitFinalFrame ? 'pipe:4' : 'pipe:3'
  const audioInputIndex = splitFinalFrame ? 2 : 1
  args.push(
    '-f', 's16le',
    '-ar', String(WORLD_WEBM_AUDIO_SAMPLE_RATE),
    '-ac', String(WORLD_WEBM_AUDIO_CHANNELS),
    '-i', audioPipe,
  )
  if (splitFinalFrame) {
    args.push(
      '-filter_complex',
      `[0:v:0]settb=AVTB[nominal];[1:v:0]settb=AVTB,setpts=PTS+${formatFfmpegRational(
        plan.frameCount - 1,
        plan.fps,
      )}/TB[final];`
        + '[nominal][final]interleave=nb_inputs=2:duration=longest[v]',
      '-map', '[v]',
    )
  } else {
    args.push('-map', '0:v:0')
  }
  args.push(
    '-map', `${audioInputIndex}:a:0`,
    '-c:v', 'libvpx-vp9',
    '-b:v', String(plan.videoBitrate),
    '-pix_fmt', 'yuv420p',
    '-fps_mode:v', 'passthrough',
    '-enc_time_base:v', 'filter',
    '-c:a', 'libopus',
    '-b:a', String(plan.audioBitrate),
    '-frames:v', String(plan.frameCount),
    '-fs', String(WORLD_WEBM_MAX_OUTPUT_BYTES),
    '-f', 'webm',
    '-fd', String(outputFd),
    '-blocksize', String(WORLD_WEBM_MAX_WRITE_BYTES),
    'fd:',
  )
  return Object.freeze(args)
}

export function createWorldFfmpegEnvironment(_source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }
}

export async function assembleWorldWebmWithFfmpeg(input: {
  readonly runtime: VerifiedWorldFfmpegRuntime
  readonly acquireRuntimeLease: WorldFfmpegRuntimeLeaseAcquirer
  readonly plan: WorldWebmStartPayload
  readonly jobId: string
  readonly generation: string
  readonly authority: WorldFfmpegWebmAuthority
  readonly spawnProcess: WorldFfmpegSpawn
  readonly signal: AbortSignal
  readonly environment?: NodeJS.ProcessEnv
  readonly timeouts?: WorldFfmpegTimeoutOverrides
}): Promise<WorldFfmpegAssemblyResult> {
  throwIfAborted(input.signal)
  const timeouts = resolveTimeouts(input.plan, input.timeouts)
  let sinkId: string | null = null
  let lease: WorldFfmpegExecutionLease | null = null
  let outputLease: WorldWebmFileOutputLease | null = null
  let assembledExtent = 0
  let result: WorldFfmpegAssemblyResult = { ok: false, code: 'sink-failed' }
  let cancellation: Error | null = null
  const leaseReleases = new WeakMap<WorldFfmpegExecutionLease, Promise<void>>()
  const outputLeaseReleases = new WeakMap<WorldWebmFileOutputLease, ReturnType<WorldWebmFileOutputLease['release']>>()
  const sinkAbortions = new Map<string, { raw: Promise<true>; observed: Promise<boolean> }>()

  const releaseLeaseOwned = (candidate: WorldFfmpegExecutionLease): Promise<void> => {
    const existing = leaseReleases.get(candidate)
    if (existing) return existing
    const operation = Promise.resolve().then(() => candidate.release())
    void operation.catch(() => undefined)
    leaseReleases.set(candidate, operation)
    return operation
  }
  const releaseOutputLeaseOwned = (
    candidate: WorldWebmFileOutputLease,
  ): ReturnType<WorldWebmFileOutputLease['release']> => {
    const existing = outputLeaseReleases.get(candidate)
    if (existing) return existing
    const operation = Promise.resolve().then(() => candidate.release())
    void operation.catch(() => undefined)
    outputLeaseReleases.set(candidate, operation)
    return operation
  }
  const startSinkAbort = (ownedSinkId: string): Promise<boolean> => {
    const existing = sinkAbortions.get(ownedSinkId)
    if (existing) return existing.observed
    let raw: Promise<true>
    try {
      raw = input.authority.abortWebmAssembly(input.jobId, input.generation, ownedSinkId)
    } catch (error) {
      raw = Promise.reject(error)
    }
    const observed = Promise.resolve(raw).then((acknowledgement) => acknowledgement === true, () => false)
    void observed.catch(() => undefined)
    sinkAbortions.set(ownedSinkId, { raw, observed })
    return observed
  }
  const awaitSinkAbort = async (ownedSinkId: string, timeoutMs: number): Promise<boolean> => {
    const cleanup = startSinkAbort(ownedSinkId)
    const outcome = await settleOwnedPhase({ operation: () => cleanup, timeoutMs })
    return outcome.status === 'fulfilled' && outcome.value
  }

  try {
    const beginOutcome = await settleOwnedPhase({
      operation: () => input.authority.beginWebmAssembly(
        input.jobId,
        input.generation,
        input.plan,
        input.signal,
      ),
      timeoutMs: timeouts.sinkBeginMs,
      signal: input.signal,
      onLateFulfilled: async (opened) => { await startSinkAbort(opened.sinkId) },
    })
    if (beginOutcome.status === 'aborted') throw abortError('World FFmpeg fallback was cancelled.')
    if (beginOutcome.status === 'timeout') {
      throw new WorldFfmpegFailure('sink-failed', 'FFmpeg WebM sink begin did not settle.')
    }
    if (beginOutcome.status === 'rejected') throw beginOutcome.error
    const opened = beginOutcome.value
    sinkId = opened.sinkId
    if (!/^sink-[a-f0-9]{32}$/.test(sinkId)) throw new WorldFfmpegFailure('sink-failed', 'FFmpeg WebM sink id is invalid.')
    throwIfAborted(input.signal)

    const leaseOutcome = await settleOwnedPhase({
      operation: () => input.acquireRuntimeLease(input.runtime),
      timeoutMs: timeouts.runtimeLeaseAcquireMs,
      signal: input.signal,
      onLateFulfilled: (lateLease) => releaseLeaseOwned(lateLease),
    })
    if (leaseOutcome.status === 'aborted') throw abortError('World FFmpeg fallback was cancelled.')
    if (leaseOutcome.status === 'timeout') {
      throw new WorldFfmpegFailure('timeout', 'FFmpeg runtime lease acquisition did not settle.')
    }
    if (leaseOutcome.status === 'rejected') {
      throw new WorldFfmpegFailure('spawn-failed', errorMessage(leaseOutcome.error))
    }
    lease = leaseOutcome.value
    throwIfAborted(input.signal)

    let child: WorldFfmpegProcess
    try {
      const args = createWorldFfmpegArguments(input.plan)
      outputLease = input.authority.acquireWebmFileOutputLease(input.jobId, input.generation, sinkId)
      const outputFd = outputLease.fd
      if (!Number.isSafeInteger(outputFd) || outputFd <= 2) {
        throw new WorldFfmpegFailure('sink-failed', 'FFmpeg WebM output descriptor is invalid.')
      }
      const options: WorldFfmpegSpawnOptions = {
        cwd: input.runtime.rootPath,
        env: createWorldFfmpegEnvironment(input.environment),
        stdio: input.plan.frameCount > 1
          ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', outputFd]
          : ['pipe', 'pipe', 'pipe', 'pipe', outputFd],
        shell: false,
        detached: false,
        windowsHide: true,
      }
      child = lease.spawn(input.spawnProcess, args, options)
    } catch (error) {
      const failure = error instanceof WorldFfmpegFailure
        ? error
        : new WorldFfmpegFailure(outputLease ? 'spawn-failed' : 'sink-failed', errorMessage(error))
      await Promise.all([
        settleOwnedPhase({
          operation: () => releaseLeaseOwned(lease as WorldFfmpegExecutionLease),
          timeoutMs: timeouts.runtimeLeaseReleaseMs,
        }),
        ...(outputLease
          ? [settleOwnedPhase({
              operation: () => releaseOutputLeaseOwned(outputLease as WorldWebmFileOutputLease),
              timeoutMs: timeouts.runtimeLeaseReleaseMs,
            })]
          : []),
      ])
      lease = null
      outputLease = null
      throw failure
    }

    const processLease = lease
    const processOutputLease = outputLease
    lease = null
    outputLease = null
    const processResult = await runFfmpegProcess({
      child,
      releaseRuntimeLease: () => releaseLeaseOwned(processLease),
      releaseOutputLease: () => releaseOutputLeaseOwned(processOutputLease),
      plan: input.plan,
      jobId: input.jobId,
      generation: input.generation,
      sinkId,
      authority: input.authority,
      signal: input.signal,
      timeouts,
    })
    throwIfAborted(input.signal)
    if (!processResult.ok) {
      result = processResult
    } else {
      assembledExtent = processResult.extent
      const outputTimeouts = resolveTimeouts(input.plan, input.timeouts, processResult.extent)
      const ownedSinkId = sinkId
      const commitOutcome = await settleOwnedPhase({
        operation: () => input.authority.commitWebmAssembly(
          input.jobId,
          input.generation,
          ownedSinkId,
          processResult.extent,
          input.signal,
        ),
        timeoutMs: outputTimeouts.commitMs,
        signal: input.signal,
        onLateFulfilled: async () => { await startSinkAbort(ownedSinkId) },
      })
      if (commitOutcome.status === 'aborted') throw abortError('World FFmpeg fallback was cancelled.')
      if (commitOutcome.status === 'timeout') {
        throw new WorldFfmpegFailure('sink-failed', 'FFmpeg WebM commit did not settle.')
      }
      if (commitOutcome.status === 'rejected') throw commitOutcome.error
      const committed = commitOutcome.value
      if (committed.size !== processResult.extent || !/^[a-f0-9]{64}$/.test(committed.sha256)) {
        throw new Error('FFmpeg WebM commit identity is invalid.')
      }
      throwIfAborted(input.signal)
      const confirmOutcome = await settleOwnedPhase({
        operation: () => input.authority.confirmWebmAssembly(input.jobId, input.generation, ownedSinkId),
        timeoutMs: outputTimeouts.confirmMs,
        signal: input.signal,
        onLateFulfilled: async () => { await startSinkAbort(ownedSinkId) },
      })
      if (confirmOutcome.status === 'aborted') throw abortError('World FFmpeg fallback was cancelled.')
      if (confirmOutcome.status === 'timeout') {
        throw new WorldFfmpegFailure('sink-failed', 'FFmpeg WebM confirmation did not settle.')
      }
      if (confirmOutcome.status === 'rejected') throw confirmOutcome.error
      if (confirmOutcome.value !== true) {
        throw new Error('FFmpeg WebM confirmation acknowledgement is invalid.')
      }
      throwIfAborted(input.signal)
      result = { ok: true, size: committed.size, sha256: committed.sha256 }
    }
  } catch (error) {
    if (isAbortError(error) || input.signal.aborted) {
      cancellation = abortError('World FFmpeg fallback was cancelled.')
    } else {
      result = { ok: false, code: error instanceof WorldFfmpegFailure ? error.code : 'sink-failed' }
    }
  } finally {
    if (outputLease) {
      const outputReleaseOutcome = await settleOwnedPhase({
        operation: () => releaseOutputLeaseOwned(outputLease as WorldWebmFileOutputLease),
        timeoutMs: timeouts.runtimeLeaseReleaseMs,
      })
      if (!cancellation && !input.signal.aborted && outputReleaseOutcome.status !== 'fulfilled') {
        result = { ok: false, code: outputReleaseOutcome.status === 'timeout' ? 'timeout' : 'sink-failed' }
      }
      outputLease = null
    }
    if (lease) {
      const releaseOutcome = await settleOwnedPhase({
        operation: () => releaseLeaseOwned(lease as WorldFfmpegExecutionLease),
        timeoutMs: timeouts.runtimeLeaseReleaseMs,
      })
      if (!cancellation && !input.signal.aborted && releaseOutcome.status !== 'fulfilled') {
        result = { ok: false, code: releaseOutcome.status === 'timeout' ? 'timeout' : 'process-failed' }
      }
      lease = null
    }
  }
  const needsCleanup = Boolean(sinkId) && (!result.ok || cancellation || input.signal.aborted)
  const cleanupTimeouts = resolveTimeouts(input.plan, input.timeouts, assembledExtent)
  const cleanupTimeout = cancellation || input.signal.aborted
    ? cleanupTimeouts.cancellationCleanupMs
    : cleanupTimeouts.abortMs
  const cleanupConfirmed = !needsCleanup || await awaitSinkAbort(sinkId as string, cleanupTimeout)
  if (cancellation || input.signal.aborted) throw cancellation ?? abortError('World FFmpeg fallback was cancelled.')
  return cleanupConfirmed ? result : { ok: false, code: 'sink-failed' }
}

export function createPackagedWorldFfmpegFallback(input: {
  readonly resourcesPath: string
  readonly platform: string
  readonly arch: string
  readonly trustedManifestKeys?: WorldFfmpegTrustedManifestKeys
  readonly authority: WorldFfmpegWebmAuthority
  readonly spawnProcess: WorldFfmpegSpawn
  readonly environment?: NodeJS.ProcessEnv
  /** Trusted main-process test dependencies only; never derived from IPC or render payloads. */
  readonly testDependencies?: {
    readonly resolveRuntime?: typeof resolvePackagedWorldFfmpegRuntime
    readonly runtimeResolutionTimeoutMs?: number
  }
}): (request: {
  readonly jobId: string
  readonly generation: string
  readonly plan: WorldWebmStartPayload
  readonly signal: AbortSignal
}) => Promise<boolean> {
  return async (request) => {
    throwIfAborted(request.signal)
    const timeouts = resolveTimeouts(request.plan, {
      runtimeLeaseAcquireMs: input.testDependencies?.runtimeResolutionTimeoutMs,
    })
    // Resolution precedes sink custody. Bound only its callback authority: the
    // observed audit still owns its handles and may finish after this boundary.
    const resolutionOutcome = await settleOwnedPhase({
      operation: () => (input.testDependencies?.resolveRuntime ?? resolvePackagedWorldFfmpegRuntime)({
        resourcesPath: input.resourcesPath,
        platform: input.platform,
        arch: input.arch,
        trustedManifestKeys: input.trustedManifestKeys,
      }),
      timeoutMs: timeouts.runtimeLeaseAcquireMs,
      signal: request.signal,
    })
    throwIfAborted(request.signal)
    if (resolutionOutcome.status === 'aborted') throw abortError('World FFmpeg fallback was cancelled.')
    if (resolutionOutcome.status !== 'fulfilled' || !resolutionOutcome.value.ok) return false
    const result = await assembleWorldWebmWithFfmpeg({
      ...request,
      runtime: resolutionOutcome.value.runtime,
      acquireRuntimeLease: (runtime) => acquireWorldFfmpegExecutionLease({
        runtime,
        trustedManifestKeys: input.trustedManifestKeys,
      }),
      authority: input.authority,
      spawnProcess: input.spawnProcess,
      environment: input.environment,
    })
    return result.ok
  }
}

async function runFfmpegProcess(input: {
  readonly child: WorldFfmpegProcess
  readonly releaseRuntimeLease: () => Promise<void>
  readonly releaseOutputLease: () => ReturnType<WorldWebmFileOutputLease['release']>
  readonly plan: WorldWebmStartPayload
  readonly jobId: string
  readonly generation: string
  readonly sinkId: string
  readonly authority: WorldFfmpegWebmAuthority
  readonly signal: AbortSignal
  readonly timeouts: RunnerTimeouts
}): Promise<
  | { readonly ok: true; readonly extent: number }
  | Extract<WorldFfmpegAssemblyResult, { ok: false }>
> {
  const { child } = input
  const operations = new AbortController()
  const lifecycle: { failure: WorldFfmpegFailure | null } = { failure: null }
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let stopping = false
  let closed = false
  let finished = false
  let terminalSettled = false
  let releasedOutputExtent: number | null = null
  let nativeCustodyRelease: Promise<void> | null = null
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null
  let closeWaitTimer: ReturnType<typeof setTimeout> | null = null
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null
  let hardTimer: ReturnType<typeof setTimeout> | null = null
  let resolveTerminal!: (value: { code: number | null; signal: NodeJS.Signals | null; observedClose: boolean }) => void

  const schedule = (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      callback()
    }, milliseconds)
    timers.add(timer)
    return timer
  }
  const clearManagedTimer = (timer: ReturnType<typeof setTimeout> | null): void => {
    if (!timer) return
    clearTimeout(timer)
    timers.delete(timer)
  }
  const destroyPipes = (): void => {
    for (const stream of [child.stdin, ...child.stdio.slice(3), child.stdout, child.stderr]) {
      if (!stream) continue
      try { if (!stream.destroyed) stream.destroy() } catch { /* bounded settlement remains authoritative */ }
    }
  }
  const terminalPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; observedClose: boolean }>((resolvePromise) => {
    resolveTerminal = resolvePromise
  })
  const releaseNativeCustody = (): Promise<void> => {
    if (nativeCustodyRelease) return nativeCustodyRelease
    child.on('error', consumeTerminalChildError)
    child.removeListener('error', onError)
    child.removeListener('close', onClose)
    nativeCustodyRelease = Promise.allSettled([
      Promise.resolve().then(input.releaseOutputLease),
      Promise.resolve().then(input.releaseRuntimeLease),
    ]).then(([output, runtime]) => {
      if (output.status === 'rejected') {
        throw new WorldFfmpegFailure('sink-failed', `FFmpeg output lease: ${errorMessage(output.reason)}`)
      }
      if (!output.value || !Number.isSafeInteger(output.value.extent)
        || output.value.extent < 0 || output.value.extent > WORLD_WEBM_MAX_OUTPUT_BYTES) {
        throw new WorldFfmpegFailure('sink-failed', 'FFmpeg output lease acknowledgement is invalid.')
      }
      releasedOutputExtent = output.value.extent
      if (runtime.status === 'rejected') {
        throw new WorldFfmpegFailure('process-failed', `FFmpeg runtime lease: ${errorMessage(runtime.reason)}`)
      }
    })
    void nativeCustodyRelease.catch(() => undefined)
    return nativeCustodyRelease
  }
  const settleTerminalWithoutClose = (): void => {
    if (closed || terminalSettled) return
    terminalSettled = true
    operations.abort()
    destroyPipes()
    try { child.unref() } catch { /* streams are destroyed and no timer remains */ }
    resolveTerminal({ code: null, signal: 'SIGKILL', observedClose: false })
  }
  const requestStop = (nextFailure: WorldFfmpegFailure): void => {
    if (finished) return
    lifecycle.failure ??= nextFailure
    operations.abort()
    destroyPipes()
    if (stopping || closed) return
    stopping = true
    try { child.kill('SIGTERM') } catch { /* force-kill timer remains authoritative */ }
    forceKillTimer = schedule(() => {
      if (closed || finished) return
      try { child.kill('SIGKILL') } catch { /* close deadline remains authoritative */ }
      closeWaitTimer = schedule(settleTerminalWithoutClose, input.timeouts.closeWaitMs)
    }, input.timeouts.killGraceMs)
  }
  const touch = (): void => {
    if (closed || stopping || finished) return
    clearManagedTimer(inactivityTimer)
    inactivityTimer = schedule(() => requestStop(
      new WorldFfmpegFailure('timeout', 'World FFmpeg fallback became inactive.'),
    ), input.timeouts.inactivityMs)
  }
  const onError = (error: Error): void => {
    // ChildProcess "error" also reports signal-delivery and IPC failures; it is
    // not proof that the process exited or closed its inherited descriptors.
    requestStop(new WorldFfmpegFailure('spawn-failed', error.message))
  }
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (closed) return
    closed = true
    clearManagedTimer(forceKillTimer)
    clearManagedTimer(closeWaitTimer)
    clearManagedTimer(inactivityTimer)
    clearManagedTimer(hardTimer)
    void releaseNativeCustody()
    if (!terminalSettled) {
      terminalSettled = true
      resolveTerminal({ code, signal, observedClose: true })
    }
  }
  child.on('error', onError)
  child.once('close', onClose)

  const onAbort = (): void => requestStop(new WorldFfmpegFailure('process-failed', 'World FFmpeg fallback was cancelled.'))
  input.signal.addEventListener('abort', onAbort, { once: true })
  hardTimer = schedule(() => requestStop(
    new WorldFfmpegFailure('timeout', 'World FFmpeg fallback exceeded its hard timeout.'),
  ), input.timeouts.hardMs)
  touch()

  const progress = new FfmpegProgressTracker()
  const operationInput = { ...input, signal: operations.signal }
  const splitFinalFrame = input.plan.frameCount > 1
  const finalVideoInput = splitFinalFrame ? child.stdio[3] : null
  const audioInput = splitFinalFrame ? child.stdio[4] : child.stdio[3]
  const rawTasks: Array<{ name: string; promise: Promise<void> }> = [
    {
      name: 'video-feed',
      promise: feedVideoRange(
        child.stdin,
        operationInput,
        0,
        splitFinalFrame ? input.plan.frameCount - 1 : input.plan.frameCount,
        touch,
      ),
    },
    ...(splitFinalFrame
      ? [{
          name: 'final-video-feed',
          promise: finalVideoInput
            ? feedVideoRange(
                finalVideoInput,
                operationInput,
                input.plan.frameCount - 1,
                input.plan.frameCount,
                touch,
              )
            : Promise.reject(new WorldFfmpegFailure('process-failed', 'FFmpeg final video pipe is missing.')),
        }]
      : []),
    {
      name: 'audio-feed',
      promise: audioInput
        ? feedAudio(audioInput, operationInput, touch)
        : Promise.reject(new WorldFfmpegFailure('process-failed', 'FFmpeg audio pipe is missing.')),
    },
    {
      name: 'webm-output',
      promise: (async () => {
        for await (const rawChunk of child.stdout) {
          throwIfAborted(operations.signal)
          const chunk = Buffer.from(rawChunk as Uint8Array)
          if (chunk.byteLength > 0) {
            throw new WorldFfmpegFailure('process-failed', 'FFmpeg wrote unexpected bytes to stdout.')
          }
        }
      })(),
    },
    {
      name: 'progress-output',
      promise: (async () => {
        for await (const rawChunk of child.stderr) {
          throwIfAborted(operations.signal)
          progress.push(Buffer.from(rawChunk as Uint8Array))
          touch()
        }
        progress.finish()
      })(),
    },
  ]

  const managedTask = ({
    name,
    promise,
    timeoutMs = input.timeouts.taskDrainMs,
  }: { name: string; promise: Promise<void>; timeoutMs?: number }) => {
    const settled = promise.then(
      () => ({ ok: true as const }),
      (error: unknown) => {
        const failure = error instanceof WorldFfmpegFailure
          ? error
          : new WorldFfmpegFailure('process-failed', `${name}: ${errorMessage(error)}`)
        requestStop(failure)
        return { ok: false as const }
      },
    )
    void settled.catch(() => undefined)
    return { name, settled, timeoutMs }
  }
  const tasks = rawTasks.map(managedTask)

  const terminal = await terminalPromise
  // Only an observed native close/error releases the audited descriptor lease.
  // A no-close public deadline keeps a listener-owned tombstone and the exact
  // lease alive after this method returns.
  if (terminal.observedClose) {
    tasks.push(managedTask({
      name: 'native-custody',
      promise: releaseNativeCustody(),
      timeoutMs: input.timeouts.runtimeLeaseReleaseMs,
    }))
  }
  const settleTask = async (task: typeof tasks[number]): Promise<void> => {
    await new Promise<void>((resolvePromise) => {
      let done = false
      const complete = (): void => {
        if (done) return
        done = true
        clearManagedTimer(timer)
        resolvePromise()
      }
      const timer = schedule(() => {
        requestStop(new WorldFfmpegFailure('timeout', `World FFmpeg ${task.name} did not settle.`))
        destroyPipes()
        complete()
      }, task.timeoutMs)
      void task.settled.then(complete, complete)
    })
  }
  await Promise.all(tasks.map(settleTask))
  finished = true
  operations.abort()
  destroyPipes()
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  input.signal.removeEventListener('abort', onAbort)
  if (terminal.observedClose) {
    child.removeListener('error', onError)
    child.removeListener('close', onClose)
  }

  if (input.signal.aborted) throw abortError('World FFmpeg fallback was cancelled.')
  if (!terminal.observedClose) lifecycle.failure ??= new WorldFfmpegFailure('timeout', 'World FFmpeg process did not close.')
  if (lifecycle.failure) return { ok: false, code: lifecycle.failure.code }
  const extent = progress.validatedExtent(input.plan)
  if (terminal.code !== 0 || terminal.signal !== null || extent === null || extent !== releasedOutputExtent) {
    return { ok: false, code: 'process-failed' }
  }
  return { ok: true, extent }
}

class FfmpegProgressTracker {
  private readonly decoder = new StringDecoder('utf8')
  private readonly record = new Map<string, string>()
  private readonly tail: string[] = []
  private partial = ''
  private lastFrame = -1
  private lastOutTimeMicroseconds = -1
  private lastTotalSize = -1
  private terminal: { frame: number; outTimeMicroseconds: number; totalSize: number } | null = null
  private invalid = false

  push(bytes: Uint8Array): void {
    if (this.invalid) return
    this.consume(this.decoder.write(Buffer.from(bytes)), false)
  }

  finish(): void {
    if (this.invalid) return
    this.consume(this.decoder.end(), true)
    if (this.partial) {
      this.processLine(this.partial)
      this.partial = ''
    }
    if (this.record.size > 0) this.invalid = true
  }

  validatedExtent(plan: WorldWebmStartPayload): number | null {
    if (this.invalid || !this.terminal || this.terminal.frame !== plan.frameCount
      || this.terminal.totalSize < 1 || this.terminal.totalSize > WORLD_WEBM_MAX_OUTPUT_BYTES) return null
    const expectedMicroseconds = roundedDurationMicroseconds(plan.duration)
    const tolerance = Math.ceil(1_000_000 / WORLD_WEBM_AUDIO_SAMPLE_RATE)
    return Math.abs(this.terminal.outTimeMicroseconds - expectedMicroseconds) <= tolerance
      ? this.terminal.totalSize
      : null
  }

  private consume(value: string, finishing: boolean): void {
    let start = 0
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) !== 10) continue
      this.appendPartial(value.slice(start, index))
      this.processLine(this.partial.endsWith('\r') ? this.partial.slice(0, -1) : this.partial)
      this.partial = ''
      start = index + 1
      if (this.invalid) return
    }
    this.appendPartial(value.slice(start))
    if (finishing && this.partial.length > MAX_PROGRESS_LINE_CHARS) this.invalid = true
  }

  private appendPartial(value: string): void {
    if (this.invalid || !value) return
    if (this.partial.length + value.length > MAX_PROGRESS_LINE_CHARS) {
      this.invalid = true
      return
    }
    this.partial += value
  }

  private processLine(line: string): void {
    if (this.invalid || !line) return
    this.tail.push(line)
    if (this.tail.length > PROGRESS_TAIL_LINES) this.tail.shift()
    if (this.terminal) { this.invalid = true; return }
    const separator = line.indexOf('=')
    if (separator < 1) { this.invalid = true; return }
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (!/^[a-z0-9_]{1,64}$/.test(key) || value.length > MAX_PROGRESS_LINE_CHARS
      || this.record.has(key) || this.record.size >= MAX_PROGRESS_RECORD_FIELDS) {
      this.invalid = true
      return
    }
    if (key !== 'progress') {
      this.record.set(key, value)
      return
    }
    if (value !== 'continue' && value !== 'end') { this.invalid = true; return }
    const frame = parseProgressInteger(this.record.get('frame'))
    const outTimeMicroseconds = parseProgressInteger(this.record.get('out_time_us'))
    const totalSize = parseProgressInteger(this.record.get('total_size'))
    if (frame === null || outTimeMicroseconds === null || totalSize === null
      || frame < this.lastFrame || outTimeMicroseconds < this.lastOutTimeMicroseconds
      || totalSize < this.lastTotalSize) {
      this.invalid = true
      return
    }
    this.lastFrame = frame
    this.lastOutTimeMicroseconds = outTimeMicroseconds
    this.lastTotalSize = totalSize
    this.record.clear()
    if (value === 'end') this.terminal = { frame, outTimeMicroseconds, totalSize }
  }
}

function roundedDurationMicroseconds(duration: WorldWebmStartPayload['duration']): number {
  if (!Number.isSafeInteger(duration.numerator) || duration.numerator <= 0
    || !Number.isSafeInteger(duration.denominator) || duration.denominator <= 0) {
    throw new TypeError('World FFmpeg duration is invalid.')
  }
  const numerator = BigInt(duration.numerator) * 1_000_000n
  const denominator = BigInt(duration.denominator)
  const rounded = (numerator + denominator / 2n) / denominator
  if (rounded < 1n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError('World FFmpeg duration is outside the microsecond bound.')
  }
  return Number(rounded)
}

function formatFfmpegRational(numerator: number, denominator: number): string {
  if (!Number.isSafeInteger(numerator) || numerator < 0
    || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new TypeError('World FFmpeg timestamp is invalid.')
  }
  const divisor = greatestCommonDivisor(numerator, denominator)
  return `${numerator / divisor}/${denominator / divisor}`
}

function formatReciprocalRate(duration: WorldWebmStartPayload['duration']): string {
  if (!Number.isSafeInteger(duration.numerator) || duration.numerator <= 0
    || !Number.isSafeInteger(duration.denominator) || duration.denominator <= 0) {
    throw new TypeError('World FFmpeg frame duration is invalid.')
  }
  const divisor = greatestCommonDivisor(duration.numerator, duration.denominator)
  return `${duration.denominator / divisor}/${duration.numerator / divisor}`
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left
  let b = right
  while (b !== 0) [a, b] = [b, a % b]
  return a
}

async function feedVideoRange(
  writable: Writable,
  input: {
    readonly plan: WorldWebmStartPayload
    readonly jobId: string
    readonly generation: string
    readonly sinkId: string
    readonly authority: WorldRenderWebmAuthority
    readonly signal: AbortSignal
  },
  startIndex: number,
  endIndex: number,
  touch: () => void,
): Promise<void> {
  for (let index = startIndex; index < endIndex; index += 1) {
    throwIfAborted(input.signal)
    let frame: Awaited<ReturnType<WorldRenderWebmAuthority['readWebmFrameMaster']>>
    try {
      frame = await input.authority.readWebmFrameMaster(
        input.jobId, input.generation, input.sinkId, index, input.signal,
      )
    } catch (error) {
      throw new WorldFfmpegFailure('input-failed', errorMessage(error))
    }
    if (frame.index !== index || frame.size !== frame.bytes.byteLength
      || frame.sha256 !== sha256Bytes(frame.bytes) || !isPng(frame.bytes)) {
      throw new WorldFfmpegFailure('input-failed', 'FFmpeg frame master identity is invalid.')
    }
    await writeWithBackpressure(writable, frame.bytes, input.signal)
    touch()
  }
  await endWritable(writable, input.signal)
}

async function feedAudio(
  writable: Writable,
  input: {
    readonly plan: WorldWebmStartPayload
    readonly jobId: string
    readonly generation: string
    readonly sinkId: string
    readonly authority: WorldRenderWebmAuthority
    readonly signal: AbortSignal
  },
  touch: () => void,
): Promise<void> {
  for (let sampleOffset = 0; sampleOffset < input.plan.audioSampleCount;) {
    throwIfAborted(input.signal)
    const sampleCount = Math.min(WORLD_WEBM_MAX_AUDIO_CHUNK_SAMPLES, input.plan.audioSampleCount - sampleOffset)
    let audio: Awaited<ReturnType<WorldRenderWebmAuthority['readWebmAudioMaster']>>
    try {
      audio = await input.authority.readWebmAudioMaster(
        input.jobId, input.generation, input.sinkId, sampleOffset, sampleCount, input.signal,
      )
    } catch (error) {
      throw new WorldFfmpegFailure('input-failed', errorMessage(error))
    }
    if (audio.sampleOffset !== sampleOffset || audio.sampleCount !== sampleCount
      || audio.bytes.byteLength !== sampleCount * WORLD_WEBM_AUDIO_CHANNELS * 2) {
      throw new WorldFfmpegFailure('input-failed', 'FFmpeg audio master identity is invalid.')
    }
    await writeWithBackpressure(writable, audio.bytes, input.signal)
    touch()
    sampleOffset += sampleCount
  }
  await endWritable(writable, input.signal)
}

async function writeWithBackpressure(writable: Writable, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let writeComplete = false
    let drained = true
    let settled = false
    const cleanup = (): void => {
      writable.removeListener('error', onError)
      writable.removeListener('drain', onDrain)
      signal.removeEventListener('abort', onAbort)
    }
    const resolveIfComplete = (): void => {
      if (settled || !writeComplete || !drained) return
      settled = true
      cleanup()
      resolvePromise()
    }
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(error)
    }
    const onError = (error: Error): void => rejectOnce(error)
    const onDrain = (): void => { drained = true; resolveIfComplete() }
    const onAbort = (): void => rejectOnce(abortError('World FFmpeg input was cancelled.'))
    writable.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    let accepted: boolean
    try {
      accepted = writable.write(Buffer.from(bytes), (error?: Error | null) => {
        if (error) { rejectOnce(error); return }
        writeComplete = true
        resolveIfComplete()
      })
    } catch (error) {
      rejectOnce(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (!accepted) {
      drained = false
      writable.once('drain', onDrain)
    }
  })
}

async function endWritable(writable: Writable, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false
    const cleanup = (): void => {
      writable.removeListener('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(error)
    }
    const onAbort = (): void => onError(abortError('World FFmpeg input was cancelled.'))
    writable.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      writable.end(() => {
        if (settled) return
        settled = true
        cleanup()
        resolvePromise()
      })
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function parseProgressInteger(value: string | undefined): number | null {
  if (!value || !/^\d{1,18}$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function auditDurationMs(bytes: number, passes = 1): number {
  return Math.ceil((bytes * passes * 1_000) / CONSERVATIVE_AUDIT_BYTES_PER_SECOND)
}

function boundedCustodyMs(milliseconds: number): number {
  return Math.min(MAX_CUSTODY_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.ceil(milliseconds)))
}

/**
 * Derives production custody bounds from the exact protocol workload and the
 * audited runtime closure. These are deadlines, not expected latencies: slow
 * but progressing repository work gets a conservative I/O floor while caller
 * cancellation still releases the visible operation immediately.
 */
export function calculateWorldFfmpegTimeouts(
  plan: WorldWebmStartPayload,
  outputBytes = 0,
): WorldFfmpegPhaseTimeouts {
  if (!Number.isSafeInteger(plan.frameCount) || plan.frameCount < 1
    || plan.frameCount > WORLD_WEBM_MAX_FRAME_COUNT
    || !Number.isSafeInteger(plan.audioSampleCount) || plan.audioSampleCount < 1
    || plan.audioSampleCount > WORLD_WEBM_MAX_AUDIO_SAMPLES) {
    throw new TypeError('World FFmpeg workload is outside the protocol bound.')
  }
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 0 || outputBytes > WORLD_WEBM_MAX_OUTPUT_BYTES) {
    throw new TypeError('World FFmpeg output byte bound is invalid.')
  }
  const durationSeconds = plan.duration.numerator / plan.duration.denominator
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new TypeError('World FFmpeg duration is invalid.')
  }

  const audioBytes = 44 + plan.audioSampleCount * WORLD_WEBM_AUDIO_CHANNELS * 2
  const masterBytes = plan.frameCount * WORLD_WEBM_MAX_FRAME_BYTES + audioBytes
  const masterFiles = plan.frameCount + 1
  const runtimeBytes = WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.manifestBytes
    + WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.manifestSignatureBytes
    + WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.licenseBytes
    + WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.executableBytes
    + WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.sharedLibraryTotalBytes
  const runtimeFiles = 4 + WORLD_FFMPEG_RUNTIME_AUDIT_LIMITS.sharedLibraryCount
  const runtimeLeaseReleaseMs = boundedCustodyMs(
    PROCESS_DRAIN_BASE_MS + runtimeFiles * RUNTIME_FILE_CLOSE_MS,
  )
  const largestStreamingUnitBytes = Math.max(WORLD_WEBM_MAX_FRAME_BYTES, WORLD_WEBM_MAX_WRITE_BYTES)
  const taskDrainMs = Math.max(
    runtimeLeaseReleaseMs,
    boundedCustodyMs(PROCESS_DRAIN_BASE_MS + auditDurationMs(largestStreamingUnitBytes)),
  )

  const abortMs = boundedCustodyMs(REPOSITORY_PHASE_BASE_MS + auditDurationMs(outputBytes))
  return {
    inactivityMs: boundedCustodyMs(PROCESS_DRAIN_BASE_MS + auditDurationMs(largestStreamingUnitBytes)),
    hardMs: Math.min(
      MAX_HARD_TIMEOUT_MS,
      Math.max(120_000, Math.ceil(durationSeconds * 4_000) + 120_000),
    ),
    sinkBeginMs: boundedCustodyMs(
      REPOSITORY_PHASE_BASE_MS
        + auditDurationMs(masterBytes)
        + masterFiles * REPOSITORY_FILE_METADATA_MS,
    ),
    runtimeLeaseAcquireMs: boundedCustodyMs(
      REPOSITORY_PHASE_BASE_MS
        + auditDurationMs(runtimeBytes)
        + runtimeFiles * REPOSITORY_FILE_METADATA_MS,
    ),
    runtimeLeaseReleaseMs,
    commitMs: boundedCustodyMs(
      REPOSITORY_PHASE_BASE_MS
        + auditDurationMs(masterBytes)
        + auditDurationMs(outputBytes, 3)
        + masterFiles * REPOSITORY_FILE_METADATA_MS,
    ),
    confirmMs: boundedCustodyMs(
      REPOSITORY_PHASE_BASE_MS
        + auditDurationMs(masterBytes)
        + auditDurationMs(outputBytes)
        + masterFiles * REPOSITORY_FILE_METADATA_MS,
    ),
    abortMs,
    cancellationCleanupMs: Math.min(abortMs, MAX_TERMINATION_TIMEOUT_MS),
    taskDrainMs,
  }
}

function resolveTimeouts(
  plan: WorldWebmStartPayload,
  overrides: WorldFfmpegTimeoutOverrides | undefined,
  outputBytes = 0,
): RunnerTimeouts {
  const calculated = calculateWorldFfmpegTimeouts(plan, outputBytes)
  const aggregate = overrides?.taskWaitMs
  const defaults: RunnerTimeouts = {
    ...calculated,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
    closeWaitMs: DEFAULT_CLOSE_WAIT_MS,
  }
  const phaseTimeout = <K extends keyof WorldFfmpegPhaseTimeouts>(key: K): number => (
    overrides?.[key] ?? aggregate ?? defaults[key]
  )
  const result: RunnerTimeouts = {
    inactivityMs: overrides?.inactivityMs ?? defaults.inactivityMs,
    hardMs: overrides?.hardMs ?? defaults.hardMs,
    killGraceMs: overrides?.killGraceMs ?? defaults.killGraceMs,
    closeWaitMs: overrides?.closeWaitMs ?? defaults.closeWaitMs,
    sinkBeginMs: phaseTimeout('sinkBeginMs'),
    runtimeLeaseAcquireMs: phaseTimeout('runtimeLeaseAcquireMs'),
    runtimeLeaseReleaseMs: phaseTimeout('runtimeLeaseReleaseMs'),
    commitMs: phaseTimeout('commitMs'),
    confirmMs: phaseTimeout('confirmMs'),
    abortMs: phaseTimeout('abortMs'),
    cancellationCleanupMs: phaseTimeout('cancellationCleanupMs'),
    taskDrainMs: phaseTimeout('taskDrainMs'),
  }
  if (!Number.isSafeInteger(result.hardMs) || result.hardMs < MIN_TIMEOUT_MS || result.hardMs > MAX_HARD_TIMEOUT_MS) {
    throw new TypeError('World FFmpeg hard timeout is outside the supported bound.')
  }
  if (
    !Number.isSafeInteger(result.inactivityMs) ||
    result.inactivityMs < MIN_TIMEOUT_MS ||
    result.inactivityMs > MAX_HARD_TIMEOUT_MS
  ) {
    throw new TypeError('World FFmpeg inactivity timeout is outside the supported bound.')
  }
  for (const value of [result.killGraceMs, result.closeWaitMs]) {
    if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TERMINATION_TIMEOUT_MS) {
      throw new TypeError('World FFmpeg termination timeout is outside the supported bound.')
    }
  }
  if (!Number.isSafeInteger(result.cancellationCleanupMs)
    || result.cancellationCleanupMs < MIN_TIMEOUT_MS
    || result.cancellationCleanupMs > MAX_TERMINATION_TIMEOUT_MS) {
    throw new TypeError('World FFmpeg cancellation cleanup timeout is outside the supported bound.')
  }
  for (const value of [
    result.sinkBeginMs,
    result.runtimeLeaseAcquireMs,
    result.runtimeLeaseReleaseMs,
    result.commitMs,
    result.confirmMs,
    result.abortMs,
    result.taskDrainMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_CUSTODY_TIMEOUT_MS) {
      throw new TypeError('World FFmpeg custody timeout is outside the supported bound.')
    }
  }
  return result
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 8
    && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
    && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError('World FFmpeg fallback was cancelled.')
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
