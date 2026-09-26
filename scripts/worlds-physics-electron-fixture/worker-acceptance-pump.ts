import type { WorldEditorSession } from '../../src/areas/worlds/core/worldSessions.ts'
import type { WorldRuntimeInputFrame } from '../../src/areas/worlds/runtime/worldInputRuntime.ts'
import { WORLD_FIXED_STEP_SECONDS } from '../../src/areas/worlds/runtime/worldRuntimeClock.ts'
import { createPhysicsAcceptancePlayAdapter, type PhysicsAcceptancePlayPorts } from './worker-acceptance.ts'
import { PHYSICS_ACCEPTANCE_LIMITS, PHYSICS_ACCEPTANCE_PROFILES, type PhysicsAcceptancePhase } from './worker-contract.ts'

export interface PhysicsAcceptancePumpPorts extends PhysicsAcceptancePlayPorts {
  /** Absolute monotonic clock target; early wakeups are checked again, never clipped. */
  waitUntil?(targetMs: number, signal: AbortSignal): Promise<void>
}
const ACCEPTANCE_NEUTRAL_INPUT: WorldRuntimeInputFrame = Object.freeze({ sequence: 0, actions: Object.freeze({}) })
type PumpState = 'idle' | 'running' | 'quiet' | 'completed' | 'partial'

/** Round the origin before adding, so addition cannot shorten the required duration. */
function minimumDurationTarget(startMs: number, durationMs: number): number {
  if (!Number.isFinite(startMs) || startMs < 0 || startMs > Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new Error('Acceptance duration origin or integer duration is invalid.')
  }
  const targetMs = Math.ceil(startMs) + durationMs
  if (!Number.isSafeInteger(targetMs) || targetMs < 0) throw new Error('Acceptance duration target exceeds the clock range.')
  return targetMs
}

/** Explicit one-shot fixed phase, not renderer/CLI/native admission or a character-course test.
 * Only scheduling slots are skipped after ACK: the actual Play simulation clock is untouched.
 */
export function createPhysicsAcceptancePump(phase: PhysicsAcceptancePhase, entityIds: readonly string[], ports: PhysicsAcceptancePumpPorts = {}) {
  const profile = PHYSICS_ACCEPTANCE_PROFILES[phase], intervalMs = WORLD_FIXED_STEP_SECONDS * 1000
  const now = ports.now ?? (() => performance.now()), abort = new AbortController()
  let pumpState: PumpState = 'idle', used = false, exported = false, firstError: string | null = null, cleanupError: string | null = null
  let deadlineMs: number | null = null, lastClockMs = -1, originMs = 0, scheduledMs = 0, lastAdvanceMs = 0, slot = 0, quietCycles = 0
  let captureAdvance = false, cleanup: Promise<unknown> | null = null, phasePromise: Promise<ReturnType<typeof status>> | null = null
  let interrupt!: (error: Error) => void
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject }); void interrupted.catch(() => undefined)
  const fail = (error: unknown): Error => {
    firstError ??= error instanceof Error ? error.message : String(error)
    const failure = new Error(firstError); abort.abort(failure); interrupt(failure)
    const current = adapter.status()
    // Do not poison an already stopped cycle (especially cancellation during final quiet).
    if (!cleanup && (current.active || current.adapterLifecycle === 'starting' || current.adapterLifecycle === 'stopping')) {
      cleanup = adapter.cancel().catch(cause => { cleanupError ??= cause instanceof Error ? cause.message : String(cause) })
    }
    return failure
  }
  const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
  const readClock = (): number => {
    const value = now()
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || value < lastClockMs) throw fail('Acceptance pump clock is invalid or moved backwards.')
    lastClockMs = value
    if (deadlineMs !== null && value >= deadlineMs && pumpState !== 'completed' && pumpState !== 'partial') throw fail('Acceptance phase deadline exceeded.')
    return value
  }
  const adapter = createPhysicsAcceptancePlayAdapter(phase, entityIds, { ...ports, now: () => {
    const value = readClock()
    if (captureAdvance) { lastAdvanceMs = value; captureAdvance = false }
    return value
  } })
  const waitUntil = ports.waitUntil ?? ((target, signal) => abortableWait(target, signal, readClock))
  const guarded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, interrupted])
  async function waitAbsolute(target: number): Promise<void> {
    while (readClock() < target) { check(!firstError, firstError ?? 'Acceptance phase was interrupted.'); await guarded(waitUntil(target, abort.signal)) }
  }
  async function advance(target: number): Promise<void> {
    check(!firstError, firstError ?? 'Acceptance phase was interrupted.')
    readClock(); scheduledMs = target; captureAdvance = true
    const work = adapter.advance(target, ACCEPTANCE_NEUTRAL_INPUT)
    captureAdvance = false; await guarded(work)
  }
  function status() {
    return Object.freeze({ ...adapter.status(), pumpState, phaseCompleted: pumpState === 'completed' && firstError === null,
      phaseError: firstError, cleanupError, deadlineMs, originMs, scheduledMs, lastAdvanceMs, slot, quietCycles })
  }
  function runPhase(editor: WorldEditorSession, sceneId: string): Promise<ReturnType<typeof status>> {
    if (used || firstError || abort.signal.aborted) return Promise.reject(new Error('Acceptance pump is one-shot and has already been used or cancelled.'))
    used = true; pumpState = 'running'
    phasePromise = (async () => {
      try {
        const startedMs = readClock(); deadlineMs = startedMs + profile.driverDeadlineMs
        check(Number.isSafeInteger(Math.ceil(deadlineMs)), 'Acceptance phase deadline exceeds the clock range.')
        // One non-extendable watchdog uses the same absolute clock and abortable wait port.
        void waitAbsolute(deadlineMs).then(() => { fail('Acceptance phase deadline exceeded.') }, error => { if (!abort.signal.aborted) fail(error) })
        const authored = JSON.stringify(editor) // Outside measurement/ticks; complete document/history invariant.
        for (let cycle = 0; cycle < profile.cycles; cycle += 1) {
          readClock(); await guarded(adapter.startCycle(editor, sceneId))
          await advance(readClock()); originMs = lastAdvanceMs; slot = 0
          while (adapter.status().stage !== 'complete') {
            if (phase === 'timing' && adapter.status().stage === 'recovery') {
              // Predeclare from the actual advance clock-port read, never from ACK/post time.
              const recoveryTarget = minimumDurationTarget(lastAdvanceMs, 200)
              await waitAbsolute(recoveryTarget); await advance(recoveryTarget)
            } else {
              const observed = readClock()
              slot = Math.max(slot + 1, Math.floor((observed - originMs) / intervalMs) + 1)
              scheduledMs = originMs + slot * intervalMs
              while (scheduledMs <= observed) { slot += 1; scheduledMs = originMs + slot * intervalMs }
              await waitAbsolute(scheduledMs); await advance(scheduledMs)
            }
          }
          await guarded(adapter.stop()); pumpState = 'quiet'
          const quietTarget = minimumDurationTarget(readClock(), PHYSICS_ACCEPTANCE_LIMITS.quietMs)
          await waitAbsolute(quietTarget)
          const stopped = adapter.status()
          check(stopped.settled && !stopped.active && stopped.pendingCount === 0 && !stopped.runtimePresent
            && stopped.runtimePoseCount === 0 && stopped.physicsBodyPoseCount === 0 && stopped.error === null,
          'Acceptance quiet observations are not terminal and quiescent.')
          check(JSON.stringify(editor) === authored, 'Acceptance authored document/revision/history changed.')
          check(stopped.successfulCycles === cycle + 1, 'Acceptance successful cycle count differs from its fixed profile.')
          quietCycles += 1; pumpState = 'running'
        }
        readClock(); check(!firstError && quietCycles === profile.cycles && adapter.status().successfulCycles === profile.cycles,
          'Acceptance fixed phase did not complete all cycles and quiet observations.')
        pumpState = 'completed'
      } catch (error) { fail(error) }
      finally {
        abort.abort(); if (cleanup) await cleanup
        if (firstError) pumpState = 'partial'
      }
      return status()
    })()
    return phasePromise
  }
  function cancel(): Promise<ReturnType<typeof status>> {
    if (pumpState === 'completed' || pumpState === 'partial') return phasePromise ?? Promise.resolve(status())
    fail('Acceptance phase was explicitly cancelled.'); return phasePromise ?? Promise.resolve(status())
  }
  function exportPhase() {
    check(pumpState === 'completed' || pumpState === 'partial', 'Acceptance phase export requires terminal completion/cleanup.')
    check(!exported, 'Acceptance phase evidence may be exported only once.'); exported = true
    let evidence: ReturnType<typeof adapter.exportTerminal> | null = null, exportError: string | null = null
    try { evidence = adapter.exportTerminal() } catch (error) { exportError = error instanceof Error ? error.message : String(error) }
    check(evidence === null || evidence.model.scalarBytes <= PHYSICS_ACCEPTANCE_LIMITS.scalarBytes, 'Acceptance phase scalar evidence exceeded its bound.')
    return { phase, result: pumpState === 'completed' ? 'completed' : 'partial', phaseError: firstError, cleanupError,
      exportError, adapter: evidence, quietCycles, nativeAccepted: false as const }
  }
  return Object.freeze({ runPhase, status, cancel, exportPhase })
}

/** Default wait owns exactly one timer/listener; every success, cancellation or error releases both. */
function abortableWait(targetMs: number, signal: AbortSignal, now: () => number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error('Acceptance wait aborted.')); return }
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => { if (timer !== null) clearTimeout(timer); signal.removeEventListener('abort', aborted) }
    const aborted = () => { cleanup(); reject(signal.reason ?? new Error('Acceptance wait aborted.')) }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      const delay = Math.max(0, targetMs - now())
      if (signal.aborted) { cleanup(); reject(signal.reason ?? new Error('Acceptance wait aborted.')); return }
      timer = setTimeout(() => { cleanup(); resolve() }, delay)
    }
    catch (error) { cleanup(); reject(error) }
  })
}
