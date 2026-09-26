import type { WorldPhysicsSceneDto, WorldPhysicsStepRequest } from '../../src/areas/worlds/runtime/worldPhysicsProtocol.ts'
import type { WorldPhysicsSnapshot } from '../../src/areas/worlds/runtime/worldPhysicsRuntime.ts'
import type { NativeTrace, PhysicsEvidence } from './shared.ts'
import { parseWorldPhysicsMainMessage, parseWorldPhysicsWorkerMessage, WORLD_PHYSICS_PROTOCOL_VERSION } from '../../src/areas/worlds/runtime/worldPhysicsProtocol.ts'
import { isWorldCanonicalId } from '../../src/areas/worlds/core/worldValidationLimits.ts'
import { PHYSICS_ACCEPTANCE_LIMITS, PHYSICS_ACCEPTANCE_PROFILES, type PhysicsAcceptancePhase, type PhysicsAcceptanceStage,
  type PhysicsAcceptanceStopObservation, type PhysicsDerivedClockFrame, type PhysicsAcceptanceStatus } from './worker-contract.ts'

/** Unwired fixture model. Supplied clock/Stop observations are not native timing or heap-release proof. */
export class PhysicsAcceptanceObservation {
  private readonly phase: PhysicsAcceptancePhase
  private readonly profile: (typeof PHYSICS_ACCEPTANCE_PROFILES)[PhysicsAcceptancePhase]
  private readonly ids: readonly string[]
  private cycle = -1
  private generationId = 0
  private active = false
  private stage: PhysicsAcceptanceStage | 'complete' = 'complete'
  private stageSteps = 0
  private ordinal = 0
  private measuredWindow: Readonly<{ startOrdinal: number; endOrdinal: number }> | null = null
  private lastSequence = -1
  private acknowledgedSequence = -1
  private lastTime = -1
  private pending: { sequence: number; count: number; sentMs: number } | null = null
  private poses: Array<Pick<WorldPhysicsSnapshot, 'generationId' | 'sequence' | 'entityIds' | 'transforms'>> = []
  private readonly lines: string[] = []
  private scalarBytes = 0
  private cancelledRequests = 0
  private completedCycles = 0
  private error: string | null = null
  constructor(phase: PhysicsAcceptancePhase, entityIds: readonly string[]) {
    this.check(phase === 'timing' || phase === 'ownership', 'Invalid acceptance phase.')
    this.denseIds(entityIds)
    this.check(new Set(entityIds).size === 504, 'Acceptance requires exactly 504 unique canonical body IDs.')
    this.phase = phase; this.profile = PHYSICS_ACCEPTANCE_PROFILES[phase]; this.ids = Object.freeze([...entityIds])
    this.append([{ type: 'header', profile: this.profile, entityIds: this.ids, wired: false }])
  }
  view() {
    return { phase: this.phase, cycle: this.cycle, generationId: this.generationId, active: this.active, stage: this.stage,
      pendingCount: this.pending ? 1 : 0, completedCycles: this.completedCycles, cancelledRequests: this.cancelledRequests,
      ordinal: this.ordinal, measuredWindow: this.measuredWindow && { ...this.measuredWindow },
      scalarBytes: this.scalarBytes, scalarJsonl: this.lines.join(''), poses: structuredClone(this.poses), error: this.error }
  }
  /** Constant-size polling only; retained rows and poses are exported separately through view(). */
  status(): PhysicsAcceptanceStatus {
    return Object.freeze<PhysicsAcceptanceStatus>({
      phase: this.phase, cycle: this.cycle, generationId: this.generationId, active: this.active, stage: this.stage, ordinal: this.ordinal,
      postedSequence: this.lastSequence, acknowledgedSequence: this.acknowledgedSequence,
      pendingSequence: this.pending?.sequence ?? null, pendingCount: this.pending ? 1 : 0, pendingSteps: this.pending?.count ?? 0,
      completedCycles: this.completedCycles, cancelledRequests: this.cancelledRequests, scalarBytes: this.scalarBytes, error: this.error,
      measuredStartOrdinal: this.measuredWindow?.startOrdinal ?? null, measuredEndOrdinal: this.measuredWindow?.endOrdinal ?? null,
    })
  }
  beginCycle(cycle: number, generationId: number): void {
    this.check(!this.error && !this.active && cycle === this.cycle + 1 && cycle < this.profile.cycles, 'Invalid acceptance cycle ownership.')
    this.check(Number.isSafeInteger(generationId) && generationId > this.generationId, 'Invalid acceptance generation.')
    this.cycle = cycle; this.generationId = generationId; this.active = true
    this.stage = this.phase === 'timing' ? 'warmup' : 'ownership'
    this.stageSteps = 0; this.ordinal = 0; this.lastSequence = -1; this.pending = null; this.measuredWindow = null
    this.acknowledgedSequence = -1
    this.append([{ type: 'begin' }])
  }
  idleFrame(generationId: number, frame: PhysicsDerivedClockFrame): void {
    this.admit(generationId); this.clock(frame)
    this.check(frame.droppedMs === 0, 'Idle frame cannot discard fixed steps.')
    this.append([{ type: 'idle', clockSource: 'derived-fixture-clock', steps: 0, ...frame }])
    this.lastTime = frame.sentMs
  }
  posted(generationId: number, request: WorldPhysicsStepRequest, frame: PhysicsDerivedClockFrame): void {
    this.admit(generationId); this.clock(frame)
    const parsed = parseWorldPhysicsMainMessage({ ...request, version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'step', generationId })
    this.check(parsed.success && parsed.value.kind === 'step', 'Invalid acceptance step request.')
    const value = parsed.value
    this.check(value.sequence > this.lastSequence && Array.from(value.steps).every(Boolean), 'Invalid acceptance request sequence or sparse steps.')
    this.check(this.stage === 'recovery' ? value.steps.length === 4 && frame.droppedMs > 0 : frame.droppedMs === 0, 'Invalid acceptance recovery/drop accounting.')
    const entries: Array<Record<string, unknown>> = [{ type: 'request', sequence: value.sequence, count: value.steps.length, clockSource: 'derived-fixture-clock', ...frame }]
    let window = this.measuredWindow
    if (this.stage === 'warmup' && this.stageSteps + value.steps.length >= this.profile.warmupSteps) {
      this.check(window === null, 'Acceptance measured window was already declared.')
      const startOrdinal = this.ordinal + value.steps.length + this.profile.recoverySteps
      window = Object.freeze({ startOrdinal, endOrdinal: startOrdinal + this.profile.measuredSteps })
      entries.push({ type: 'measured-window', sequence: value.sequence, declaredAt: 'terminal-warmup-post', ...window })
    }
    this.append(entries) // The indivisible packet's measured interval is declared before its timing reply exists.
    this.measuredWindow = window
    this.pending = { sequence: value.sequence, count: value.steps.length, sentMs: frame.sentMs }
    this.lastSequence = value.sequence; this.lastTime = frame.sentMs
  }
  received(snapshot: WorldPhysicsSnapshot, receivedMs: number): void {
    try {
      this.check(!this.error && this.active && this.pending !== null, 'Snapshot has no pending acceptance request.')
      const pending = this.pending
      this.denseIds(snapshot?.entityIds, this.ids)
      const transforms = snapshot.transforms
      this.check(transforms instanceof Float32Array && transforms.length === 3528 && transforms.byteLength === 14112
        && this.finite(receivedMs) && receivedMs >= this.lastTime, 'Invalid acceptance pose shape/receipt clock.')
      for (let index = 0; index < 3528; index += 1) this.check(Number.isFinite(transforms[index]), 'Invalid acceptance nonfinite pose.')
      const entityIds = [...this.ids]
      const parsed = parseWorldPhysicsWorkerMessage({ ...snapshot, version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'snapshot', entityIds, transforms: transforms.slice().buffer })
      this.check(parsed.success && parsed.value.kind === 'snapshot', 'Invalid acceptance snapshot timing/transform envelope.')
      const value = parsed.value
      this.check(value.generationId === this.generationId && value.sequence === pending.sequence && value.stepTimings?.length === pending.count,
        'Acceptance timing rows mismatch generation, sequence or count.')
      const entries: Array<Record<string, unknown>> = [{ type: 'receipt', sequence: value.sequence, receivedMs, transportWallMs: receivedMs - pending.sentMs }]
      for (const [index, timing] of value.stepTimings!.entries()) {
        const ordinal = this.ordinal + index, category = this.category(ordinal)
        this.check(category === this.stage || this.stage === 'warmup' && category === 'warmup-padding'
          || (this.stage === 'measured' || this.stage === 'ownership') && category === 'padding', 'Acceptance category contradicts the declared interval.')
        entries.push({ type: 'step', sequence: value.sequence, ordinal, category, stage: this.stage, ...timing })
      }
      for (const event of value.triggerEvents) entries.push({ type: 'trigger', sequence: value.sequence, event })
      const poses = [...this.poses.slice(1 - PHYSICS_ACCEPTANCE_LIMITS.poseSnapshots), { generationId: value.generationId,
        sequence: value.sequence, entityIds, transforms: new Float32Array(new Float32Array(value.transforms)) }]
      const complete = this.stageSteps + pending.count >= this.quota()
      this.append(entries) // All validation/copy/serialization/capacity checks precede successful accounting mutation.
      this.acknowledgedSequence = value.sequence
      this.pending = null; this.lastTime = receivedMs; this.ordinal += pending.count; this.poses = poses
      this.stageSteps = complete ? 0 : this.stageSteps + pending.count
      if (complete) this.stage = this.stage === 'warmup' ? 'recovery' : this.stage === 'recovery' ? 'measured' : 'complete'
    } catch {
      this.error ??= 'Acceptance receipt validation/copy/serialization failed.'
      throw new Error(this.error)
    }
  }
  stop(generationId: number, proof: PhysicsAcceptanceStopObservation): void {
    try {
      this.check(this.active && generationId === this.generationId, 'Stop generation/cycle mismatch.')
      this.check(proof?.lifecycle === 'edit' && proof.runtimeSnapshot === null && proof.bodyPoseCount === 0 && proof.pendingCount === 0
        && [proof.created, proof.disposed, proof.audioStarted, proof.audioCompleted].every(count => count === 1), 'Stop ownership observations are incomplete.')
      this.check(!this.error && !this.pending && this.stage === 'complete', 'Stop has pending requests or an incomplete acceptance cycle.')
      this.append([{ type: 'stop', ownershipOnly: true }]); this.completedCycles += 1
    } finally {
      if (this.pending) this.cancelledRequests += 1
      this.pending = null; this.poses = []; this.active = false; this.measuredWindow = null
    }
  }
  private quota(): number {
    return this.stage === 'complete' ? 0 : this.profile[`${this.stage}Steps`]
  }
  private denseIds(value: unknown, expected?: readonly string[]): asserts value is string[] {
    this.check(Array.isArray(value) && value.length === 504, 'Acceptance requires exactly 504 body IDs.')
    for (let index = 0; index < 504; index += 1) this.check(Object.hasOwn(value, index) && isWorldCanonicalId(value[index])
      && (!expected || value[index] === expected[index]), 'Acceptance body IDs must be dense own indices in exact order.')
  }
  private category(ordinal: number): PhysicsAcceptanceStage | 'warmup-padding' | 'padding' {
    const profile = PHYSICS_ACCEPTANCE_PROFILES.timing, policy = profile.packetBoundaryPolicy
    if (this.phase === 'ownership') {
      this.check(ordinal < this.profile.ownershipSteps + policy.finalPaddingMax, 'Acceptance ownership padding limit exceeded.')
      return ordinal < this.profile.ownershipSteps ? 'ownership' : 'padding'
    }
    if (ordinal < profile.warmupSteps) return 'warmup'
    const window = this.measuredWindow
    this.check(window && window.startOrdinal >= profile.warmupSteps + profile.recoverySteps
      && window.startOrdinal <= profile.warmupSteps + profile.recoverySteps + policy.warmupPaddingMax
      && window.endOrdinal === window.startOrdinal + profile.measuredSteps, 'Acceptance measured interval is missing or invalid.')
    if (ordinal < window.startOrdinal - profile.recoverySteps) return 'warmup-padding'
    if (ordinal < window.startOrdinal) return 'recovery'
    if (ordinal < window.endOrdinal) return 'measured'
    this.check(ordinal < window.endOrdinal + policy.finalPaddingMax, 'Acceptance final padding limit exceeded.')
    return 'padding'
  }
  private admit(generationId: number): void {
    this.check(!this.error && this.active && generationId === this.generationId && !this.pending && this.stage !== 'complete', 'Invalid acceptance generation/single-flight/stage admission.')
  }
  private finite(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER }
  private clock(frame: PhysicsDerivedClockFrame): void {
    try {
      this.check(frame !== null && typeof frame === 'object' && !Array.isArray(frame), 'Invalid derived fixture clock values.')
      const keys = Reflect.ownKeys(frame), paired = keys.length === 5
      const expected = paired ? ['sentMs', 'lagMs', 'droppedMs', 'scheduledMs', 'advanceMs'] : ['sentMs', 'lagMs', 'droppedMs']
      this.check(keys.length === expected.length && expected.every(key => {
        const property = Object.getOwnPropertyDescriptor(frame, key)
        return property?.enumerable && 'value' in property && this.finite(property.value)
      }), 'Invalid derived fixture clock shape.')
      this.check(frame.sentMs >= this.lastTime, 'Invalid derived fixture clock values.')
      if (paired) this.check(typeof frame.scheduledMs === 'number' && typeof frame.advanceMs === 'number'
        && frame.sentMs >= frame.advanceMs && frame.advanceMs >= this.lastTime
        && frame.lagMs === Math.max(0, frame.advanceMs - frame.scheduledMs), 'Invalid derived fixture cadence.')
    } catch {
      this.error ??= 'Invalid derived fixture clock values.'
      throw new Error(this.error)
    }
  }
  private append(entries: Array<Record<string, unknown>>): void {
    const lines = entries.map(entry => `${JSON.stringify({ phase: this.phase, ...(this.cycle >= 0 ? { cycle: this.cycle, generationId: this.generationId } : {}), ...entry })}\n`)
    const bytes = lines.reduce((sum, line) => sum + new TextEncoder().encode(line).length, 0)
    this.check(this.scalarBytes + bytes <= PHYSICS_ACCEPTANCE_LIMITS.scalarBytes, 'Acceptance scalar byte limit exceeded.')
    this.lines.push(...lines); this.scalarBytes += bytes
  }
  private check(condition: unknown, message: string): asserts condition {
    if (!condition) { this.error ??= message; throw new Error(this.error) }
  }
}

/** Bounded observer only: all inputs and snapshots still go through production unchanged. */
export class PhysicsObservation {
  private state: PhysicsEvidence = {
    generationId: 0, expectedEntityIds: [], postedSequence: 0, acknowledgedSequence: 0, receivedCount: 0,
    pendingCount: 0, cancelledRequests: 0, disposedCount: 0, audioCloseStarted: 0, audioCloseCompleted: 0,
    samples: [], triggerEvents: [], error: null,
  }
  private readonly pending = new Set<number>()
  private readonly waiters = new Set<{ sequence: number; finish(error?: Error): void }>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getRevision = () => this.revision
  view(): PhysicsEvidence { return structuredClone({ ...this.state, pendingCount: this.pending.size }) }
  private publish(): void { this.revision += 1; for (const listener of this.listeners) listener() }
  fail(message: string): void {
    this.state.error ??= message
    for (const waiter of [...this.waiters]) waiter.finish(new Error(this.state.error))
    this.publish()
  }
  created(generationId: number): void {
    if (this.state.generationId !== 0) this.fail('Phase 1 must create exactly one physics generation.')
    this.state.generationId = generationId
    this.publish()
  }
  initialized(generationId: number, scene: Pick<WorldPhysicsSceneDto, 'sceneId' | 'gravity'> & { bodies: Array<{ entityId: string }> }): void {
    if (generationId !== this.state.generationId) this.fail('Physics initialize generation mismatch.')
    this.state.expectedEntityIds = scene.bodies.map((body) => body.entityId)
    this.publish()
  }
  posted(generationId: number, request: WorldPhysicsStepRequest): void {
    if (generationId !== this.state.generationId || this.state.disposedCount) this.fail('Physics post used a stale generation.')
    if (request.sequence <= this.state.postedSequence || this.pending.size >= 1) this.fail('Physics request sequence is duplicate or exceeded the single-flight bound.')
    if (request.sequence > 4096) this.fail('Physics fixture exceeded its 4096-request safety bound.')
    this.state.postedSequence = request.sequence
    this.pending.add(request.sequence)
    this.publish()
  }
  received(snapshot: WorldPhysicsSnapshot): void {
    if (snapshot.generationId !== this.state.generationId || this.state.disposedCount) { this.fail('Physics snapshot used a stale generation.'); return }
    if (!this.pending.has(snapshot.sequence) || snapshot.sequence <= this.state.acknowledgedSequence) { this.fail('Physics snapshot sequence is duplicate or has no pending request.'); return }
    if (JSON.stringify(snapshot.entityIds) !== JSON.stringify(this.state.expectedEntityIds)
      || snapshot.transforms.length !== snapshot.entityIds.length * 7 || !snapshot.transforms.every(Number.isFinite)) {
      this.fail('Physics snapshot entity IDs or body transforms differ from the initialized scene.'); return
    }
    this.pending.delete(snapshot.sequence)
    this.state.acknowledgedSequence = snapshot.sequence
    this.state.receivedCount += 1
    this.state.samples.push({ ...snapshot, entityIds: [...snapshot.entityIds], transforms: [...snapshot.transforms], triggerEvents: structuredClone(snapshot.triggerEvents) })
    this.state.samples = this.state.samples.slice(-180)
    this.state.triggerEvents.push(...structuredClone(snapshot.triggerEvents))
    if (this.state.triggerEvents.length > 128) { this.state.triggerEvents = this.state.triggerEvents.slice(-128); this.fail('Physics trigger evidence exceeded its 128-event bound.') }
    for (const waiter of [...this.waiters]) if (waiter.sequence === snapshot.sequence) waiter.finish()
    this.publish()
  }
  waitForLatestAcknowledgement(milliseconds = 3_000): Promise<void> {
    if (this.state.error) return Promise.reject(new Error(this.state.error))
    const sequence = this.state.postedSequence
    if (!this.pending.has(sequence)) return Promise.resolve()
    if (this.waiters.size >= 4) return Promise.reject(new Error('Physics acknowledgement waiter limit exceeded.'))
    return new Promise((resolve, reject) => {
      const waiter = { sequence, finish: (error?: Error) => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        if (error) reject(error); else resolve()
      } }
      const timer = setTimeout(() => waiter.finish(new Error(`Physics acknowledgement timed out: generation ${this.state.generationId}, sequence ${sequence}.`)), milliseconds)
      this.waiters.add(waiter)
    })
  }
  disposed(): void {
    this.state.disposedCount += 1
    this.state.cancelledRequests += this.pending.size
    this.pending.clear()
    // Normal Stop cancels the pending frame, not fabricates a received snapshot.
    for (const waiter of [...this.waiters]) waiter.finish()
    this.publish()
  }
  audioClosing(): void { this.state.audioCloseStarted += 1; this.publish() }
  audioClosed(): void { this.state.audioCloseCompleted += 1; this.publish() }
}

/** Never publish React observer state inside document capture: preserve native default actions. */
export function createDeferredNativeRecorder(publish: (entries: NativeTrace[]) => void) {
  let pending: Array<{ entry: NativeTrace; event: Pick<Event, 'defaultPrevented'> }> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    record(entry: NativeTrace, event: Pick<Event, 'defaultPrevented'>): void {
      pending = [...pending.slice(-199), { entry, event }]
      if (timer === null) timer = setTimeout(() => {
        const entries = pending.map(({ entry, event }) => ({ ...entry, defaultPrevented: event.defaultPrevented }))
        pending = []
        timer = null
        publish(entries)
      }, 0)
    },
    dispose(): void { if (timer !== null) clearTimeout(timer); timer = null; pending = [] },
  }
}
