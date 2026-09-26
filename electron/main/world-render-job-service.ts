import { cloneWorldProjectSnapshot } from '../../src/areas/worlds/core/worldDocuments.ts'
import { preflightWorldSequence } from '../../src/areas/worlds/cinematic/worldSequencePreflight.ts'
import {
  compareWorldRationalTime,
  enumerateWorldFrames,
  type WorldFrameTime,
} from '../../src/areas/worlds/cinematic/worldRationalTime.ts'
import type { WorldProjectOpenResult } from '../../src/shared/types/worldProjects.ts'
import {
  WORLD_RENDER_MAX_DURATION_SECONDS,
  WORLD_RENDER_MAX_FRAME_COUNT,
  parseWorldRenderCancelRequest,
  parseWorldRenderCreateRequest,
  parseWorldRenderDeleteRequest,
  parseWorldRenderJobKeyRequest,
  type WorldRenderCancelResult,
  type WorldRenderCreateResult,
  type WorldRenderDeleteResult,
  type WorldRenderGetResult,
  type WorldRenderJobDetail,
  type WorldRenderListResult,
  type WorldRenderProgressPhase,
  type WorldRenderPublicError,
  type WorldRenderPublicErrorCode,
} from '../../src/shared/types/worldRenders.ts'
import {
  WorldRenderOutputRepository,
  type WorldRenderArtifactInput,
  type WorldRenderExecutionPackage,
} from './world-render-output-repository.ts'

const MAX_CONCURRENT_EXECUTORS = 4
const DEFAULT_CANCELLATION_WAIT_MS = 35_000
const DEFAULT_IDLE_WAIT_MS = 35_000
const DEFAULT_SHUTDOWN_WAIT_MS = 45_000
const MIN_CANCELLATION_WAIT_MS = 5
const MAX_CANCELLATION_WAIT_MS = 120_000

export interface WorldRenderProjectReader {
  open(request: { projectKey: string }): Promise<WorldProjectOpenResult>
}

export interface WorldRenderExecutorProgress {
  phase: Exclude<WorldRenderProgressPhase, 'queued' | 'complete'>
  completedFrames: number
}

export interface WorldRenderExecutorContext extends WorldRenderExecutionPackage {
  jobId: string
  signal: AbortSignal
  reportProgress(progress: WorldRenderExecutorProgress): Promise<void>
  writeFrame(index: number, data: WorldRenderArtifactInput): Promise<void>
  writeAudio(data: WorldRenderArtifactInput): Promise<void>
  writeWebm(data: WorldRenderArtifactInput): Promise<void>
}

/** No default executor exists: production must inject a real rendering implementation. */
export interface WorldRenderExecutor {
  execute(context: WorldRenderExecutorContext): Promise<void>
}

/** A renderer adapter may expose a bounded, path-free failure to durable job state. */
export class WorldRenderExecutorError extends Error {
  readonly publicError: WorldRenderPublicError

  constructor(error: WorldRenderPublicError) {
    super(error.code)
    this.name = 'WorldRenderExecutorError'
    this.publicError = structuredClone(error)
  }
}

export interface WorldRenderJobServiceOptions {
  projectReader: WorldRenderProjectReader
  outputRepository: WorldRenderOutputRepository
  executor?: WorldRenderExecutor
  maxConcurrentJobs?: number
  /** Independent caller/process boundary around repository cancellation. */
  cancellationWaitMs?: number
  /** Finite truthful wait for process-local executor quiescence. */
  idleWaitMs?: number
  /** Finite caller boundary; late shutdown authority remains owned. */
  shutdownWaitMs?: number
}

interface ActiveExecution {
  controller: AbortController
  promise: Promise<void>
}

class ExecutionBoundaryError extends Error {
  readonly publicError: WorldRenderPublicError

  constructor(error: WorldRenderPublicError) {
    super(error.code)
    this.publicError = error
  }
}

/**
 * Process-local job authority. Durable truth belongs to the output repository;
 * this service owns bounded scheduling, executor lifetime, and cancellation.
 */
export class WorldRenderJobService {
  private readonly options: WorldRenderJobServiceOptions
  private readonly maximumConcurrentJobs: number
  private readonly cancellationWaitMs: number
  private readonly idleWaitMs: number
  private readonly shutdownWaitMs: number
  private initialization: Promise<void> | null = null
  private readonly admissions = new Set<Promise<WorldRenderCreateResult>>()
  private readonly queued: string[] = []
  private readonly active = new Map<string, ActiveExecution>()
  private readonly ownedExecutorOperations = new Set<Promise<void>>()
  private readonly stoppedAdmissionCancellations = new Set<Promise<void>>()
  private readonly cancellationPublications = new Map<string, Promise<WorldRenderCancelResult>>()
  private readonly lateCancellationFinalizations = new Map<string, Promise<void>>()
  private idleWaiters: Array<{
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private idleFailure: ExecutionBoundaryError | null = null
  private stopping = false
  private shutdownPromise: Promise<void> | null = null
  private shutdownAuthority: Promise<void> | null = null

  constructor(options: WorldRenderJobServiceOptions) {
    this.options = options
    const maximum = options.maxConcurrentJobs ?? 1
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_CONCURRENT_EXECUTORS) {
      throw new TypeError(`World render concurrency must be between 1 and ${MAX_CONCURRENT_EXECUTORS}.`)
    }
    this.maximumConcurrentJobs = maximum
    const cancellationWaitMs = options.cancellationWaitMs ?? DEFAULT_CANCELLATION_WAIT_MS
    if (!Number.isSafeInteger(cancellationWaitMs)
      || cancellationWaitMs < MIN_CANCELLATION_WAIT_MS
      || cancellationWaitMs > MAX_CANCELLATION_WAIT_MS) {
      throw new TypeError(
        `World render cancellation wait must be between ${MIN_CANCELLATION_WAIT_MS} and ${MAX_CANCELLATION_WAIT_MS}.`,
      )
    }
    this.cancellationWaitMs = cancellationWaitMs
    this.idleWaitMs = boundedServiceWait(
      options.idleWaitMs ?? DEFAULT_IDLE_WAIT_MS,
      'idle',
    )
    this.shutdownWaitMs = boundedServiceWait(
      options.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS,
      'shutdown',
    )
  }

  async initialize(): Promise<void> {
    this.initialization ??= this.options.outputRepository.recoverJobs().then(() => undefined)
    await this.initialization
  }

  create(requestValue: unknown): Promise<WorldRenderCreateResult> {
    if (this.stopping || !this.options.executor) return Promise.resolve(failure('executor_unavailable'))
    const admission = this.createAdmission(requestValue)
    this.admissions.add(admission)
    const release = () => {
      this.admissions.delete(admission)
      this.notifyIdleIfNeeded()
    }
    void admission.then(release, release)
    return admission
  }

  private async createAdmission(requestValue: unknown): Promise<WorldRenderCreateResult> {
    const parsed = parseWorldRenderCreateRequest(requestValue)
    if (!parsed.success) return failure('invalid_request', false, parsed.issues)
    try { await this.initialize() } catch { return failure('recovery_failed', true) }
    if (this.stopping) return failure('executor_unavailable')

    let opened: WorldProjectOpenResult
    try { opened = await this.options.projectReader.open({ projectKey: parsed.value.projectKey }) }
    catch { return failure('project_not_found') }
    if (this.stopping) return failure('executor_unavailable')
    if (!opened.ok) return mapProjectOpenError(opened.error.code)
    if (opened.value.status !== 'ready') return failure('project_not_found')
    if (opened.value.projectKey !== parsed.value.projectKey) return failure('project_not_found')

    const snapshot = cloneWorldProjectSnapshot(opened.value.snapshot)
    if (snapshot.project.revision !== parsed.value.expectedRevision) return failure('revision_conflict', true)
    const scene = snapshot.scenes.find((candidate) => candidate.sceneId === parsed.value.sceneId)
    if (!scene) return failure('scene_not_found')
    const sequence = scene.sequences.find((candidate) => candidate.id === parsed.value.sequenceId)
    if (!sequence) return failure('sequence_not_found')
    if (compareWorldRationalTime(sequence.duration, { numerator: 0, denominator: 1 }) <= 0
      || compareWorldRationalTime(sequence.duration, { numerator: WORLD_RENDER_MAX_DURATION_SECONDS, denominator: 1 }) > 0) {
      return failure('sequence_invalid')
    }
    const preflight = preflightWorldSequence({ scene, sequence })
    if (!preflight.success) return failure('sequence_invalid', false, preflight.issues)

    let framePlan: readonly WorldFrameTime[]
    try {
      framePlan = enumerateWorldFrames(sequence.duration, parsed.value.preset.fps, WORLD_RENDER_MAX_FRAME_COUNT)
    } catch {
      return failure('sequence_invalid')
    }
    const stored = await this.options.outputRepository.createJob({
      request: parsed.value,
      snapshot,
      framePlan,
    })
    if (!stored.ok) return stored
    if (this.stopping) {
      this.ownStoppedAdmissionCancellation(stored.value.jobId)
      return stored
    }
    this.queued.push(stored.value.jobId)
    this.pump()
    return stored
  }

  async list(): Promise<WorldRenderListResult> {
    try { await this.initialize() } catch { return failure('recovery_failed', true) }
    return this.options.outputRepository.list()
  }

  async get(requestValue: unknown): Promise<WorldRenderGetResult> {
    const parsed = parseWorldRenderJobKeyRequest(requestValue)
    if (!parsed.success) return failure('invalid_request')
    try { await this.initialize() } catch { return failure('recovery_failed', true) }
    return this.options.outputRepository.get(parsed.value)
  }

  async cancel(requestValue: unknown): Promise<WorldRenderCancelResult> {
    const parsed = parseWorldRenderCancelRequest(requestValue)
    if (!parsed.success) return failure('invalid_request')
    try { await this.initialize() } catch { return failure('recovery_failed', true) }
    const jobId = parsed.value.jobId
    // Signal first. In particular, do not wait behind the same durable queue
    // that a large snapshot preflight used to retain.
    this.active.get(jobId)?.controller.abort()
    let publication = this.cancellationPublications.get(jobId)
    if (!publication) {
      publication = this.publishCancellation(jobId)
      this.cancellationPublications.set(jobId, publication)
    }
    const boundedResult = await waitForServiceOperation(publication, this.cancellationWaitMs)
    const timeoutResult = failure('write_failed', true)
    if (!boundedResult) {
      this.idleFailure ??= new ExecutionBoundaryError(timeoutResult.error)
      this.ownLateCancellationFinalization(jobId, publication)
      this.notifyIdleIfNeeded()
    }
    const result = boundedResult ?? timeoutResult
    // A queued job can become active while the durable request is awaiting its
    // turn. Recheck so that transition cannot escape the cancellation signal.
    this.active.get(jobId)?.controller.abort()
    if (!this.active.has(jobId) && !this.queued.includes(jobId)
      && this.cancellationPublications.get(jobId) === publication) {
      this.cancellationPublications.delete(jobId)
    }
    return result
  }

  async delete(requestValue: unknown): Promise<WorldRenderDeleteResult> {
    const parsed = parseWorldRenderDeleteRequest(requestValue)
    if (!parsed.success) return failure('invalid_request')
    try { await this.initialize() } catch { return failure('recovery_failed', true) }
    return this.options.outputRepository.delete(parsed.value)
  }

  /** Resolves only after every queued/running executor has durably settled. */
  async whenIdle(): Promise<void> {
    if (!this.hasUnsettledExecution()) {
      const failure = this.takeIdleFailure()
      if (failure) throw failure
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.idleWaiters.indexOf(waiter)
          if (index < 0) return
          this.idleWaiters.splice(index, 1)
          reject(new ExecutionBoundaryError(publicError('write_failed', true)))
        }, this.idleWaitMs),
      }
      waiter.timer.unref?.()
      this.idleWaiters.push(waiter)
    })
  }

  /** Stops admission, durably cancels queued/running work, and waits for executors to release resources. */
  async shutdown(): Promise<void> {
    this.stopping = true
    for (const execution of this.active.values()) execution.controller.abort()
    if (!this.shutdownPromise) {
      this.shutdownAuthority = this.performShutdown()
      void this.shutdownAuthority.catch(() => {
        this.idleFailure ??= new ExecutionBoundaryError(publicError('write_failed', true))
      })
      this.shutdownPromise = waitForServiceOperation(this.shutdownAuthority, this.shutdownWaitMs)
        .then(() => undefined)
    }
    await this.shutdownPromise
  }

  private async performShutdown(): Promise<void> {
    const initialJobIds = [...new Set([...this.queued, ...this.active.keys()])]
    const initialCancellations = initialJobIds.map((jobId) => this.cancel({ jobId }))
    await Promise.allSettled([
      this.initialize(),
      ...initialCancellations,
      ...this.admissions,
    ])
    const jobIds = [...new Set([...this.queued, ...this.active.keys()])]
    await Promise.allSettled(jobIds.map((jobId) => this.cancel({ jobId })))
    await Promise.allSettled([...this.stoppedAdmissionCancellations])
    // A failed durable cancellation must not start fresh work while the process
    // is closing. Recovery will truthfully mark any remaining active state.
    this.queued.length = 0
    this.notifyIdleIfNeeded()
    await Promise.allSettled([...this.active.values()].map((execution) => execution.promise))
  }

  private pump(): void {
    if (this.stopping || !this.options.executor) return
    while (this.active.size < this.maximumConcurrentJobs && this.queued.length) {
      const jobId = this.queued.shift()!
      const controller = new AbortController()
      const promise = this.executeJob(jobId, controller, this.options.executor)
        .catch((error) => {
          this.idleFailure ??= error instanceof ExecutionBoundaryError
            ? error
            : new ExecutionBoundaryError(publicError('internal_error', true))
        })
        .finally(() => {
          this.active.delete(jobId)
          this.cancellationPublications.delete(jobId)
          this.pump()
          this.notifyIdleIfNeeded()
        })
      this.active.set(jobId, { controller, promise })
    }
  }

  private async executeJob(
    jobId: string,
    controller: AbortController,
    executor: WorldRenderExecutor,
  ): Promise<void> {
    let executorError: WorldRenderPublicError | null = null
    let executorOperation: Promise<void> | null = null
    try {
      const execution = await this.options.outputRepository.openExecutionPackage(jobId, controller.signal)
      throwIfServiceAborted(controller.signal)
      const context: WorldRenderExecutorContext = {
        ...execution,
        jobId,
        signal: controller.signal,
        reportProgress: async (progress) => {
          throwIfServiceAborted(controller.signal)
          const result = await this.options.outputRepository.updateProgress(jobId, progress)
          unwrapExecutionResult(result)
          throwIfServiceAborted(controller.signal)
        },
        writeFrame: async (index, data) => {
          throwIfServiceAborted(controller.signal)
          const result = await this.options.outputRepository.recordFrame(jobId, index, data)
          unwrapExecutionResult(result)
          throwIfServiceAborted(controller.signal)
        },
        writeAudio: async (data) => {
          throwIfServiceAborted(controller.signal)
          const result = await this.options.outputRepository.recordAudio(jobId, data)
          unwrapExecutionResult(result)
          throwIfServiceAborted(controller.signal)
        },
        writeWebm: async (data) => {
          throwIfServiceAborted(controller.signal)
          const result = await this.options.outputRepository.recordWebm(jobId, data)
          unwrapExecutionResult(result)
          throwIfServiceAborted(controller.signal)
        },
      }
      const operation = Promise.resolve().then(async () => {
        throwIfServiceAborted(controller.signal)
        await executor.execute(context)
      })
      executorOperation = operation
      this.ownedExecutorOperations.add(operation)
      void operation.then(
        () => {
          this.ownedExecutorOperations.delete(operation)
          this.notifyIdleIfNeeded()
        },
        () => {
          this.ownedExecutorOperations.delete(operation)
          this.notifyIdleIfNeeded()
        },
      )
      const outcome = await settleExecutorOperation(operation, controller.signal)
      if (outcome.status === 'rejected') throw outcome.error
    } catch (error) {
      if (error instanceof ExecutionBoundaryError || error instanceof WorldRenderExecutorError) executorError = error.publicError
      else if (!isAbortError(error) && !controller.signal.aborted) executorError = publicError('internal_error', true)
    }

    if (controller.signal.aborted) {
      const publication = this.cancellationPublications.get(jobId)
      const requested = publication
        ? await waitForServiceOperation(publication, this.cancellationWaitMs) ?? failure('write_failed', true)
        : await this.options.outputRepository.requestCancel(jobId)
      unwrapExecutionResult(requested)
      // Cancellation becomes terminal only after the exact executor authority
      // physically settles. A noncooperative executor therefore remains an
      // owned late operation while public idle/shutdown callers use their
      // independent finite boundaries.
      if (executorOperation) await executorOperation.catch(() => undefined)
      unwrapExecutionResult(await this.finishCancellationWithinBoundary(jobId))
      return
    }
    unwrapExecutionResult(await this.options.outputRepository.settle(jobId, { executorError }, controller.signal))
    if (controller.signal.aborted) {
      const publication = this.cancellationPublications.get(jobId)
      const requested = publication
        ? await waitForServiceOperation(publication, this.cancellationWaitMs) ?? failure('write_failed', true)
        : await this.options.outputRepository.requestCancel(jobId)
      unwrapExecutionResult(requested)
      unwrapExecutionResult(await this.finishCancellationWithinBoundary(jobId))
    }
  }

  private async finishCancellationWithinBoundary(jobId: string): Promise<WorldRenderCancelResult> {
    const finalization = this.options.outputRepository.finishCancelled(jobId)
    const bounded = await waitForServiceOperation(finalization, this.cancellationWaitMs)
    if (bounded?.ok) return bounded
    const result = bounded ?? failure('write_failed', true)
    this.idleFailure ??= new ExecutionBoundaryError(result.error)
    // Retain the exact pending promise when the caller deadline wins. A
    // repository-declared failure instead gets one owned retry so its internal
    // cleanup tombstone can still complete without keeping idle/shutdown open.
    this.ownLateCancellationFinalization(jobId, undefined, bounded ? undefined : finalization)
    this.notifyIdleIfNeeded()
    return result
  }

  private notifyIdleIfNeeded(): void {
    if (this.hasUnsettledExecution()) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    if (!waiters.length) return
    const failure = this.takeIdleFailure()
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      if (failure) waiter.reject(failure)
      else waiter.resolve()
    }
  }

  private hasUnsettledExecution(): boolean {
    return Boolean(
      this.admissions.size
      || this.queued.length
      || this.active.size
      || this.ownedExecutorOperations.size
      || this.stoppedAdmissionCancellations.size,
    )
  }

  private async publishCancellation(jobId: string): Promise<WorldRenderCancelResult> {
    // Remove queued work before awaiting durability. A bounded public failure
    // must never allow the cancelled admission to start while its exact late
    // repository authority is still completing.
    const queuedIndex = this.queued.indexOf(jobId)
    const wasQueued = queuedIndex >= 0
    if (wasQueued) this.queued.splice(queuedIndex, 1)
    const requested = await this.options.outputRepository.requestCancel(jobId)
    if (!requested.ok) {
      this.idleFailure ??= new ExecutionBoundaryError(requested.error)
      this.ownLateCancellationFinalization(jobId)
      this.notifyIdleIfNeeded()
      return requested
    }
    if (isTerminal(requested.value) || !wasQueued) return requested
    const cancelled = await this.options.outputRepository.finishCancelled(jobId)
    if (!cancelled.ok) {
      this.idleFailure ??= new ExecutionBoundaryError(cancelled.error)
      this.ownLateCancellationFinalization(jobId)
    }
    this.notifyIdleIfNeeded()
    return cancelled
  }

  private ownLateCancellationFinalization(
    jobId: string,
    prerequisite?: Promise<WorldRenderCancelResult>,
    finalization?: Promise<WorldRenderCancelResult>,
  ): void {
    if (this.lateCancellationFinalizations.has(jobId)) return
    const operation = Promise.resolve()
      .then(async () => {
        await prerequisite?.catch(() => undefined)
        const result = await (finalization ?? this.options.outputRepository.finishCancelled(jobId))
        if (!result.ok) this.idleFailure ??= new ExecutionBoundaryError(result.error)
      })
      .catch(() => {
        this.idleFailure ??= new ExecutionBoundaryError(publicError('write_failed', true))
      })
      .finally(() => { this.lateCancellationFinalizations.delete(jobId) })
    this.lateCancellationFinalizations.set(jobId, operation)
    void operation.catch(() => undefined)
  }

  private ownStoppedAdmissionCancellation(jobId: string): void {
    const operation = Promise.resolve().then(async () => {
      const requested = await this.options.outputRepository.requestCancel(jobId)
      if (!requested.ok) throw new ExecutionBoundaryError(requested.error)
      if (isTerminal(requested.value)) return
      const cancelled = await this.options.outputRepository.finishCancelled(jobId)
      if (!cancelled.ok) throw new ExecutionBoundaryError(cancelled.error)
    })
    this.stoppedAdmissionCancellations.add(operation)
    void operation.then(
      () => {
        this.stoppedAdmissionCancellations.delete(operation)
        this.notifyIdleIfNeeded()
      },
      (error: unknown) => {
        this.stoppedAdmissionCancellations.delete(operation)
        this.idleFailure ??= error instanceof ExecutionBoundaryError
          ? error
          : new ExecutionBoundaryError(publicError('write_failed', true))
        this.notifyIdleIfNeeded()
      },
    )
  }

  private takeIdleFailure(): ExecutionBoundaryError | null {
    const failure = this.idleFailure
    this.idleFailure = null
    return failure
  }
}

function unwrapExecutionResult(result: { ok: true } | { ok: false; error: WorldRenderPublicError }): void {
  if (!result.ok) throw new ExecutionBoundaryError(result.error)
}

function isTerminal(job: WorldRenderJobDetail): boolean {
  return ['cancelled', 'interrupted', 'failed', 'partial', 'succeeded', 'recovery_failed'].includes(job.status)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function throwIfServiceAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error('World render execution was cancelled.')
  error.name = 'AbortError'
  throw error
}

type ExecutorOperationOutcome =
  | { readonly status: 'fulfilled' }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'aborted' }

function settleExecutorOperation(
  operation: Promise<void>,
  signal: AbortSignal,
): Promise<ExecutorOperationOutcome> {
  return new Promise((resolvePromise) => {
    let waiting = true
    const finish = (outcome: ExecutorOperationOutcome): void => {
      if (!waiting) return
      waiting = false
      signal.removeEventListener('abort', onAbort)
      resolvePromise(outcome)
    }
    const onAbort = (): void => finish({ status: 'aborted' })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    void operation.then(
      () => finish({ status: 'fulfilled' }),
      (error: unknown) => finish({ status: 'rejected', error }),
    )
  })
}

function boundedServiceWait(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < MIN_CANCELLATION_WAIT_MS
    || value > MAX_CANCELLATION_WAIT_MS) {
    throw new TypeError(
      `World render ${name} wait must be between ${MIN_CANCELLATION_WAIT_MS} and ${MAX_CANCELLATION_WAIT_MS}.`,
    )
  }
  return value
}

function waitForServiceOperation<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    void operation.then((value) => finish(value), () => finish(null))
  })
}

function mapProjectOpenError(code: string): { ok: false; error: WorldRenderPublicError } {
  if (code === 'project_not_found') return failure('project_not_found')
  if (code === 'unsafe_workspace') return failure('unsafe_workspace')
  if (code === 'recovery_failed') return failure('recovery_failed', true)
  return failure('project_not_found')
}

function failure(
  code: WorldRenderPublicErrorCode,
  retryable?: boolean,
  issues?: readonly { code: string; path: string; message: string }[],
): { ok: false; error: WorldRenderPublicError } {
  const error = publicError(code, retryable)
  if (issues?.length) error.issues = issues.slice(0, 64).map((issue) => ({ ...issue }))
  return { ok: false, error }
}

function publicError(code: WorldRenderPublicErrorCode, retryable?: boolean): WorldRenderPublicError {
  const definitions: Record<WorldRenderPublicErrorCode, { message: string; retryable: boolean }> = {
    invalid_request: { message: 'World render request is invalid.', retryable: false },
    unauthorized: { message: 'World render request is unauthorized.', retryable: false },
    job_not_found: { message: 'World render job was not found.', retryable: false },
    project_not_found: { message: 'World project was not found.', retryable: false },
    revision_conflict: { message: 'World project revision changed.', retryable: true },
    scene_not_found: { message: 'World scene was not found.', retryable: false },
    sequence_not_found: { message: 'World sequence was not found.', retryable: false },
    sequence_invalid: { message: 'World sequence cannot be rendered.', retryable: false },
    executor_unavailable: { message: 'World render executor is unavailable.', retryable: true },
    job_busy: { message: 'World render job is busy.', retryable: true },
    unsafe_workspace: { message: 'World render workspace is unsafe.', retryable: false },
    output_invalid: { message: 'World render output is incomplete or invalid.', retryable: false },
    recovery_failed: { message: 'World render recovery failed.', retryable: true },
    write_failed: { message: 'World render output could not be saved.', retryable: true },
    internal_error: { message: 'World render operation failed.', retryable: true },
  }
  return { code, message: definitions[code].message, retryable: retryable ?? definitions[code].retryable }
}
