import type { WorldEditorSession } from '../../src/areas/worlds/core/worldSessions.ts'
import type { WorldAudioAuthority } from '../../src/areas/worlds/runtime/worldAudioRuntime.ts'
import type { WorldRuntimeInputFrame } from '../../src/areas/worlds/runtime/worldInputRuntime.ts'
import type { WorldPhysicsRuntimeHandlers } from '../../src/areas/worlds/runtime/worldPhysicsRuntime.ts'
import { createBrowserWorldAudioAuthority } from '../../src/areas/worlds/runtime/worldAudioRuntime.ts'
import { createBrowserWorldPhysicsRuntime } from '../../src/areas/worlds/runtime/worldPhysicsRuntime.ts'
import { createWorldPlayController, type WorldPhysicsRuntimePort, type WorldPlayControllerResult } from '../../src/areas/worlds/runtime/worldPlayController.ts'
import { WorldFixedStepClock } from '../../src/areas/worlds/runtime/worldRuntimeClock.ts'
import { PhysicsAcceptanceObservation } from './observation.ts'
import { PHYSICS_ACCEPTANCE_LIMITS, PHYSICS_ACCEPTANCE_PROFILES, type PhysicsAcceptancePhase } from './worker-contract.ts'

export interface PhysicsAcceptancePlayPorts {
  now?(): number
  createPhysics?(generationId: number, handlers: WorldPhysicsRuntimeHandlers, diagnostics: true): WorldPhysicsRuntimePort
  createAudio?(): WorldAudioAuthority
}

type Lifecycle = 'idle' | 'starting' | 'playing' | 'paused' | 'stopping' | 'stopped' | 'failed'
type Ownership = { generationId: number; created: number; disposed: number; audioStarted: number; audioCompleted: number; audioStop: Promise<void> | null }
type Advance = { scheduledMs: number; advanceMs: number; steps: number; droppedMs: number; posted: boolean;
  acknowledgement: Promise<void>; resolve(): void; reject(error: Error): void }

/** Manual calls only: no pump, renderer, window entry, native admission or editable Play store.
 * Pause/resume require an acknowledged boundary; Stop preempts start/advance and awaits audio.
 * Browser defaults are invoked lazily. The audio default resolves same-origin workspace URLs.
 */
export function createPhysicsAcceptancePlayAdapter(phase: PhysicsAcceptancePhase, entityIds: readonly string[], ports: PhysicsAcceptancePlayPorts = {}) {
  const ids = Object.freeze([...entityIds]), model = new PhysicsAcceptanceObservation(phase, ids), clock = new WorldFixedStepClock()
  const now = ports.now ?? (() => performance.now())
  let lifecycle: Lifecycle = 'idle', firstError: string | null = null, lastMs = -1, successfulCycles = 0, physicsBodyPoseCount = 0, settled = false
  let ownership: Ownership | null = null, operation: Advance | null = null
  let startExecution: Promise<WorldPlayControllerResult> | null = null, advanceExecution: Promise<WorldPlayControllerResult> | null = null
  let controlExecution: Promise<WorldPlayControllerResult> | null = null, stopPromise: Promise<ReturnType<typeof status>> | null = null
  const fail = (error: unknown): Error => {
    firstError ??= error instanceof Error ? error.message : String(error)
    if (lifecycle !== 'stopping') lifecycle = 'failed'
    const failure = new Error(firstError); operation?.reject(failure); return failure
  }
  const requireState = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
  const readNow = (): number => {
    const value = now()
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || value < lastMs) throw fail('Acceptance clock moved backwards or is invalid.')
    lastMs = value; return value
  }
  const admitted = (owned: Ownership): boolean => ownership === owned && owned.disposed === 0 && !firstError && lifecycle !== 'stopping' && lifecycle !== 'stopped'
  const checked = (result: WorldPlayControllerResult): void => { if (!result.success) throw new Error(result.issues[0]?.message ?? 'Acceptance Play operation failed.') }
  const play = createWorldPlayController({
    createPhysics(generationId, handlers) {
      const owned = ownership
      requireState(owned && owned.created === 0 && !firstError && lifecycle === 'starting', 'Acceptance requires exactly one actual Play physics generation.')
      if (!owned) throw new Error('Acceptance cycle ownership is unavailable.')
      owned.generationId = generationId
      const runtime = (ports.createPhysics ?? createBrowserWorldPhysicsRuntime)(generationId, {
        onSnapshot(snapshot) {
          if (!admitted(owned)) return
          try {
            model.received(snapshot, readNow())
            handlers.onSnapshot(snapshot) // Production poses and audio update before our acknowledgement.
            physicsBodyPoseCount = snapshot.entityIds.length
            operation?.resolve()
          } catch (error) { fail(error) }
        },
        onTriggerEvents(events) { if (admitted(owned)) handlers.onTriggerEvents(events) },
        onError(issue) { if (ownership !== owned || owned.disposed) return; fail(new Error(issue.message)); handlers.onError?.(issue) },
      }, true)
      owned.created += 1
      try { model.beginCycle(model.status().cycle + 1, generationId) } catch (error) { runtime.dispose(); owned.disposed += 1; throw error }
      return {
        initialize(scene) {
          try {
            requireState(scene.bodies.length === 504 && scene.bodies.every((body, index) => body.entityId === ids[index]), 'Acceptance initialized body IDs differ from the canonical manifest.')
            return runtime.initialize(scene)
          } catch (error) { return Promise.reject(fail(error)) }
        },
        step(request) {
          const pending = operation
          try {
            requireState(admitted(owned) && lifecycle === 'playing' && pending && !pending.posted, 'Acceptance step has no admitted manual advance.')
            if (!pending) throw new Error('Acceptance advance is unavailable.')
            requireState(request.steps.length === pending.steps && pending.steps >= 1 && pending.steps <= 4, 'Actual Play steps differ from the mirrored fixed-step clock.')
            model.posted(generationId, request, { scheduledMs: pending.scheduledMs, advanceMs: pending.advanceMs,
              sentMs: readNow(), lagMs: Math.max(0, pending.advanceMs - pending.scheduledMs), droppedMs: pending.droppedMs })
            pending.posted = true
            runtime.step(request) // Record BEFORE the actual transport; a synchronous reply remains safe.
          } catch (error) { throw fail(error) }
        },
        pause: () => runtime.pause(), resume: () => runtime.resume(),
        dispose() { if (owned.disposed) return; owned.disposed += 1; runtime.dispose() },
      }
    },
    createAudio() {
      const owned = ownership
      if (!owned) throw new Error('Acceptance audio ownership is unavailable.')
      const audio = (ports.createAudio ?? (() => createBrowserWorldAudioAuthority('')))()
      return {
        prepareScene: (snapshot, sceneId) => audio.prepareScene(snapshot, sceneId), activate: () => audio.activate(),
        play: componentId => audio.play(componentId), stopSource: componentId => audio.stopSource(componentId),
        update: poses => audio.update(poses), pause: () => audio.pause(), resume: () => audio.resume(),
        stop() {
          if (!owned.audioStop) {
            owned.audioStarted += 1
            owned.audioStop = Promise.resolve().then(() => audio.stop()).then(() => { owned.audioCompleted += 1 }, error => { throw fail(error) })
            void owned.audioStop.catch(() => undefined)
          }
          return owned.audioStop
        },
      }
    },
  })
  function status() {
    const value = model.status(), state = play.getState()
    return Object.freeze({ ...value, modelError: value.error, error: firstError ?? value.error, adapterLifecycle: lifecycle,
      playLifecycle: state.lifecycle, runtimePoseCount: state.bodyPoses.length,
      physicsBodyPoseCount: state.runtimeSnapshot === null ? 0 : physicsBodyPoseCount, runtimePresent: state.runtimeSnapshot !== null,
      created: ownership?.created ?? 0, disposed: ownership?.disposed ?? 0, audioStarted: ownership?.audioStarted ?? 0,
      audioCompleted: ownership?.audioCompleted ?? 0, successfulCycles, settled })
  }
  function stop(): Promise<ReturnType<typeof status>> {
    if (stopPromise) return stopPromise
    if (!ownership && !startExecution) return Promise.reject(new Error('Acceptance has no started cycle to Stop.'))
    if (operation || lifecycle === 'starting') fail('Acceptance Stop cancelled a pending advance or start.')
    lifecycle = 'stopping'; settled = false; clock.pause()
    const work = (async () => {
      // A pending pause/resume must finish before actual Stop, avoiding its late lifecycle write.
      if (controlExecution) await controlExecution.catch(error => { fail(error) })
      if (play.getState().lifecycle !== 'edit') { try { checked(await play.stop()) } catch (error) { fail(error) } }
      await Promise.allSettled([startExecution, advanceExecution].filter(value => value !== null))
      if (ownership?.audioStop) await ownership.audioStop.catch(error => { fail(error) })
      const state = play.getState(), owned = ownership
      if (owned && model.status().active) {
        try {
          model.stop(owned.generationId, { lifecycle: state.lifecycle, runtimeSnapshot: state.runtimeSnapshot,
            bodyPoseCount: state.bodyPoses.length, pendingCount: operation ? 1 : 0,
            created: owned.created, disposed: owned.disposed, audioStarted: owned.audioStarted, audioCompleted: owned.audioCompleted })
        } catch (error) { fail(error) }
      }
      settled = true; lifecycle = firstError ? 'failed' : 'stopped'
      if (firstError) throw new Error(firstError)
      successfulCycles += 1; return status()
    })()
    stopPromise = bounded(work, PHYSICS_ACCEPTANCE_LIMITS.stopMs, () => fail('Acceptance Stop settlement timed out.'))
    return stopPromise
  }
  async function startCycle(editor: WorldEditorSession, sceneId: string): Promise<ReturnType<typeof status>> {
    requireState(!firstError && !operation && !controlExecution && (lifecycle === 'idle' || lifecycle === 'stopped')
      && (lifecycle === 'idle' || settled), 'Acceptance start requires a successfully settled Stop boundary.')
    requireState(model.status().cycle + 1 < PHYSICS_ACCEPTANCE_PROFILES[phase].cycles, 'Acceptance fixed cycle profile is exhausted.')
    lifecycle = 'starting'; settled = false; physicsBodyPoseCount = 0; stopPromise = null; clock.reset()
    ownership = { generationId: 0, created: 0, disposed: 0, audioStarted: 0, audioCompleted: 0, audioStop: null }
    startExecution = play.start(editor, sceneId)
    try {
      checked(await bounded(startExecution, PHYSICS_ACCEPTANCE_LIMITS.startMs, () => fail('Acceptance start timed out.')))
      if (firstError || lifecycle !== 'starting') throw new Error(firstError ?? 'Acceptance start was cancelled.')
      requireState(ownership.created === 1 && play.getState().generationId === ownership.generationId, 'Actual Play generation did not match acceptance ownership.')
      clock.reset(); lifecycle = 'playing'; return status()
    } catch (error) { const failure = fail(error); void stop().catch(() => undefined); throw failure }
  }
  async function advance(scheduledMs: number, input: WorldRuntimeInputFrame): Promise<ReturnType<typeof status>> {
    requireState(!firstError && lifecycle === 'playing' && !operation && !controlExecution, 'Acceptance advance requires started playing state with no pending flight or control.')
    requireState(model.status().stage !== 'complete', 'Acceptance cycle quota is complete; Stop is required.')
    if (!Number.isFinite(scheduledMs) || scheduledMs < 0 || scheduledMs > Number.MAX_SAFE_INTEGER) throw fail('Acceptance scheduled clock is invalid.')
    const advanceMs = readNow(), mirrored = clock.advance(advanceMs)
    let resolve!: () => void, reject!: (error: Error) => void
    const acknowledgement = new Promise<void>((done, failed) => { resolve = done; reject = failed })
    void acknowledgement.catch(() => undefined)
    const pending: Advance = { scheduledMs, advanceMs, steps: mirrored.steps, droppedMs: mirrored.droppedSeconds * 1000,
      posted: false, acknowledgement, resolve, reject }
    operation = pending
    try {
      advanceExecution = play.advance(advanceMs, input)
      checked(await advanceExecution)
      if (firstError || lifecycle !== 'playing') throw new Error(firstError ?? 'Acceptance advance was cancelled.')
      if (mirrored.steps === 0) {
        requireState(!pending.posted, 'Actual Play posted during a zero-step prime.')
        model.idleFrame(ownership!.generationId, { scheduledMs, advanceMs, sentMs: readNow(),
          lagMs: Math.max(0, advanceMs - scheduledMs), droppedMs: pending.droppedMs })
      } else {
        requireState(pending.posted, 'Actual Play failed to post its mirrored fixed steps.')
        await acknowledgement
      }
      return status()
    } catch (error) { throw fail(error) } finally { if (operation === pending) operation = null }
  }
  async function control(kind: 'pause' | 'resume'): Promise<ReturnType<typeof status>> {
    requireState(!firstError && !operation && !controlExecution && lifecycle === (kind === 'pause' ? 'playing' : 'paused'), 'Acceptance control requires an acknowledged non-busy boundary.')
    try {
      controlExecution = play[kind]()
      checked(await controlExecution)
      if (lifecycle === 'stopping' || firstError) throw new Error(firstError ?? 'Acceptance control was stopped.')
      clock[kind](); lifecycle = kind === 'pause' ? 'paused' : 'playing'; return status()
    } catch (error) { throw fail(error) } finally { controlExecution = null }
  }
  function exportTerminal() {
    const state = play.getState()
    requireState(settled && !operation && !controlExecution && !model.status().active
      && state.lifecycle === 'edit' && state.runtimeSnapshot === null && state.bodyPoses.length === 0, 'Acceptance export requires terminal Stop and fully settled operations.')
    const value = model.view()
    requireState(value.scalarBytes <= PHYSICS_ACCEPTANCE_LIMITS.scalarBytes && value.poses.length <= PHYSICS_ACCEPTANCE_LIMITS.poseSnapshots, 'Acceptance terminal evidence exceeded model bounds.')
    // Keep the model export intact. Its quota/ownership count alone is never an adapter or native PASS.
    return { model: value, scalarJsonl: value.scalarJsonl, completedCycles: value.completedCycles, pendingCount: value.pendingCount,
      cancelledRequests: value.cancelledRequests, successfulCycles, error: firstError,
      adapterSuccessful: firstError === null && successfulCycles === value.completedCycles }
  }
  return Object.freeze({ startCycle, advance, pause: () => control('pause'), resume: () => control('resume'), stop,
    cancel: () => { fail('Acceptance cycle was explicitly cancelled.'); return stop() }, status, exportTerminal })
}

/** One fixed, non-extendable deadline per invocation; no scheduler or timeout port. */
function bounded<T>(work: Promise<T>, milliseconds: number, timeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeout()), milliseconds)
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
