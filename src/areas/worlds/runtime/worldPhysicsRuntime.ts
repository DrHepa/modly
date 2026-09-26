import {
  parseWorldPhysicsMainMessage,
  parseWorldPhysicsWorkerMessage,
  WORLD_PHYSICS_PROTOCOL_VERSION,
  type WorldPhysicsSceneDto,
  type WorldPhysicsStepRequest,
  type WorldPhysicsStepTiming,
  type WorldPhysicsTriggerEvent,
} from './worldPhysicsProtocol.ts'

export interface WorldPhysicsSnapshot {
  generationId: number
  sequence: number
  entityIds: string[]
  transforms: Float32Array
  triggerEvents: WorldPhysicsTriggerEvent[]
  stepTimings?: WorldPhysicsStepTiming[]
}

export interface WorldPhysicsRuntimeHandlers {
  onSnapshot(snapshot: WorldPhysicsSnapshot): void
  onTriggerEvents(events: WorldPhysicsTriggerEvent[]): void
  onError?(issue: { code: string; message: string }): void
}

export interface WorldPhysicsWorkerEventLike {
  data?: unknown
  message?: string
  error?: unknown
  preventDefault?(): void
}

export interface WorldPhysicsWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: WorldPhysicsWorkerEventLike) => void): void
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: WorldPhysicsWorkerEventLike) => void): void
  terminate(): void
}

export interface WorldPhysicsWorkerRuntimeOptions extends WorldPhysicsRuntimeHandlers {
  generationId: number
  worker: WorldPhysicsWorkerLike
  /** Opt-in only: increasing sequences, at most 64 outstanding requests, ordered matching replies. */
  diagnostics?: true
  initializationTimeoutMs?: number
  scheduleTimeout?(callback: () => void, milliseconds: number): () => void
}

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000

export class WorldPhysicsWorkerRuntime {
  private readonly generationId: number
  private readonly worker: WorldPhysicsWorkerLike
  private readonly handlers: WorldPhysicsRuntimeHandlers
  private initialized = false
  private initializationStarted = false
  private disposed = false
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private cancelInitializationTimeout: (() => void) | null = null
  private readonly initializationTimeoutMs: number
  private readonly scheduleTimeout: (callback: () => void, milliseconds: number) => () => void
  private readonly diagnostics: boolean
  private readonly pendingTimings = new Map<number, number>()
  private lastTimingSequence = -1
  private diagnosticPaused = false

  constructor(options: WorldPhysicsWorkerRuntimeOptions) {
    this.generationId = options.generationId
    this.worker = options.worker
    this.handlers = options
    if (options.diagnostics !== undefined && options.diagnostics !== true) throw new TypeError('Physics diagnostics must be omitted or true.')
    this.diagnostics = options.diagnostics === true
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS
    if (!Number.isFinite(this.initializationTimeoutMs) || this.initializationTimeoutMs <= 0) throw new TypeError('Physics initialization timeout must be positive and finite.')
    this.scheduleTimeout = options.scheduleTimeout ?? ((callback, milliseconds) => {
      const handle = globalThis.setTimeout(callback, milliseconds)
      return () => globalThis.clearTimeout(handle)
    })
    this.worker.addEventListener('message', this.handleMessage)
    this.worker.addEventListener('error', this.handleWorkerError)
    this.worker.addEventListener('messageerror', this.handleWorkerMessageError)
  }

  initialize(scene: WorldPhysicsSceneDto): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Physics runtime is disposed.'))
    if (this.initializationStarted) return Promise.reject(new Error('Physics runtime initialization already started.'))
    this.initializationStarted = true
    this.diagnosticPaused = false
    this.pendingTimings.clear()
    this.lastTimingSequence = -1
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.cancelInitializationTimeout = this.scheduleTimeout(() => {
      this.fail({ code: 'worker-initialization-timeout', message: `Physics Worker initialization timed out after ${this.initializationTimeoutMs} ms.` })
    }, this.initializationTimeoutMs)
    try {
      this.worker.postMessage({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'init', generationId: this.generationId, scene, ...(this.diagnostics ? { diagnostics: true } : {}) })
    } catch (error) {
      this.fail({ code: 'worker-post-failed', message: error instanceof Error ? error.message : 'Physics Worker initialization could not be posted.' }, error)
    }
    return ready
  }

  step(request: WorldPhysicsStepRequest): void {
    if (this.disposed || !this.initialized || (this.diagnostics && this.diagnosticPaused)) return
    const message = { version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'step', generationId: this.generationId, ...request }
    if (this.diagnostics) {
      const parsed = parseWorldPhysicsMainMessage(message)
      if (!parsed.success || parsed.value.kind !== 'step' || parsed.value.generationId !== this.generationId
        || parsed.value.sequence <= this.lastTimingSequence || this.pendingTimings.size >= 64) {
        this.fail({ code: 'invalid-diagnostic-request', message: 'Diagnostic requests require increasing safe sequences, one to four steps and at most 64 outstanding requests.' })
        return
      }
      this.pendingTimings.set(parsed.value.sequence, parsed.value.steps.length)
      this.lastTimingSequence = parsed.value.sequence
    }
    this.postRuntimeMessage(message)
  }

  pause(): void {
    if (this.disposed || (this.diagnostics && !this.initialized)) return
    if (this.diagnostics) this.diagnosticPaused = true
    this.postRuntimeMessage({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'pause', generationId: this.generationId })
  }

  resume(): void {
    if (this.disposed || (this.diagnostics && !this.initialized)) return
    if (this.diagnostics) this.diagnosticPaused = false
    this.postRuntimeMessage({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'resume', generationId: this.generationId })
  }

  dispose(): void {
    if (this.disposed) return
    try { this.worker.postMessage({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'dispose', generationId: this.generationId }) } catch { /* Worker may already have failed. */ }
    const reject = this.readyReject
    this.shutdown()
    reject?.(new Error('Physics runtime initialization was cancelled.'))
  }

  private readonly handleMessage = (event: WorldPhysicsWorkerEventLike): void => {
    if (this.disposed) return
    if (hasOtherGeneration(event.data, this.generationId)) return
    const parsed = parseWorldPhysicsWorkerMessage(event.data)
    if (!parsed.success) {
      this.fail({ code: 'invalid-worker-message', message: parsed.issue })
      return
    }
    const message = parsed.value
    if (message.generationId !== this.generationId) return
    if (message.kind === 'ready') {
      this.initialized = true
      this.cancelInitializationTimeout?.()
      this.cancelInitializationTimeout = null
      this.readyResolve?.()
      this.readyResolve = null
      this.readyReject = null
      return
    }
    if (message.kind === 'error') {
      this.fail({ code: message.code, message: message.message })
      return
    }
    if (!this.initialized) {
      this.fail({ code: 'worker-message-before-ready', message: 'Physics Worker emitted a snapshot before initialization completed.' })
      return
    }
    if (this.diagnostics ? !message.stepTimings || this.pendingTimings.keys().next().value !== message.sequence
      || this.pendingTimings.get(message.sequence) !== message.stepTimings.length : message.stepTimings !== undefined) {
      this.fail({ code: 'invalid-diagnostic-snapshot', message: 'Physics timing rows must match the next outstanding requested generation, sequence and step count.' })
      return
    }
    if (this.diagnostics) this.pendingTimings.delete(message.sequence)
    const snapshot: WorldPhysicsSnapshot = {
      generationId: message.generationId,
      sequence: message.sequence,
      entityIds: [...message.entityIds],
      transforms: new Float32Array(message.transforms),
      triggerEvents: structuredClone(message.triggerEvents),
      ...(message.stepTimings ? { stepTimings: structuredClone(message.stepTimings) } : {}),
    }
    this.handlers.onSnapshot(snapshot)
    if (snapshot.triggerEvents.length > 0) this.handlers.onTriggerEvents(structuredClone(snapshot.triggerEvents))
  }

  private readonly handleWorkerError = (event: WorldPhysicsWorkerEventLike): void => {
    if (this.disposed) return
    event.preventDefault?.()
    const message = event.message || (event.error instanceof Error ? event.error.message : 'Physics Worker crashed.')
    this.fail({ code: 'worker-error', message }, event.error)
  }

  private readonly handleWorkerMessageError = (): void => {
    if (!this.disposed) this.fail({ code: 'worker-message-error', message: 'Physics Worker message could not be decoded.' })
  }

  private postRuntimeMessage(message: unknown): void {
    try {
      this.worker.postMessage(message)
    } catch (error) {
      this.fail({ code: 'worker-post-failed', message: error instanceof Error ? error.message : 'Physics Worker message could not be posted.' }, error)
    }
  }

  private fail(issue: { code: string; message: string }, cause?: unknown): void {
    if (this.disposed) return
    const reject = this.readyReject
    this.shutdown()
    reject?.(cause instanceof Error ? cause : new Error(issue.message))
    this.handlers.onError?.(issue)
  }

  private shutdown(): void {
    if (this.disposed) return
    this.disposed = true
    this.diagnosticPaused = false
    this.pendingTimings.clear()
    this.lastTimingSequence = -1
    this.cancelInitializationTimeout?.()
    this.cancelInitializationTimeout = null
    this.readyResolve = null
    this.readyReject = null
    this.worker.removeEventListener('message', this.handleMessage)
    this.worker.removeEventListener('error', this.handleWorkerError)
    this.worker.removeEventListener('messageerror', this.handleWorkerMessageError)
    this.worker.terminate()
  }
}

export function createBrowserWorldPhysicsRuntime(generationId: number, handlers: WorldPhysicsRuntimeHandlers, diagnostics?: true): WorldPhysicsWorkerRuntime {
  if (diagnostics !== undefined && diagnostics !== true) throw new TypeError('Physics diagnostics must be omitted or true.')
  const worker = new Worker(new URL('./worldPhysics.worker.ts', import.meta.url), { type: 'module', name: 'modly-world-physics' })
  return new WorldPhysicsWorkerRuntime({ generationId, worker: worker as unknown as WorldPhysicsWorkerLike, ...handlers, diagnostics })
}

function hasOtherGeneration(value: unknown, generationId: number): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'generationId' in value && Number.isSafeInteger((value as { generationId?: unknown }).generationId)
    && (value as { generationId: number }).generationId !== generationId
}
