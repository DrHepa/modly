import { createWorldEditorController } from '../../src/areas/worlds/editor/worldEditorController.ts'
import { createWorldProjectService } from '../../src/areas/worlds/worldProjectService.ts'
import { createWorldPlayController, type WorldPlayControllerResult } from '../../src/areas/worlds/runtime/worldPlayController.ts'
import { createBrowserWorldPhysicsRuntime } from '../../src/areas/worlds/runtime/worldPhysicsRuntime.ts'
import { createBrowserWorldAudioAuthority } from '../../src/areas/worlds/runtime/worldAudioRuntime.ts'
import { WorldInputSampler } from '../../src/areas/worlds/runtime/worldInputRuntime.ts'
import { PhysicsObservation } from './observation.ts'
import {
  assertWorker, authorWorkerFixtureCourse, parseWorkerFixtureCommand, sampleWorkerControls, workerFrameTimestamp,
  type WorkerFixtureApi, type WorkerFixtureView, type WorkerFrameEvidence,
} from './worker-contract.ts'
import { createPhysicsAcceptancePump } from './worker-acceptance-pump.ts'
import { boundedFixtureAcceptanceOperation as boundedEntryOperation } from './shared.ts'
import { projectWorldRuntimeScene } from '../../src/areas/worlds/runtime/worldRuntimeProjection.ts'
import type { PhysicsAcceptanceFacade } from './shared.ts'
import type { PhysicsAcceptancePhase } from './worker-contract.ts'
import type { FixtureEnvironment } from '../worlds-character-electron-fixture/shared.ts'

const editor = createWorldEditorController(createWorldProjectService())
const observation = new PhysicsObservation()
let acceptanceSelected = false
let ready = false
let error: string | null = null
let sampler: WorldInputSampler | null = null
let busy = false
let lastTick = -1
let needsPrime = true
let postedSteps = 0
let postedRequests = 0
let lastFrame: WorkerFrameEvidence | null = null
let audioClose: Promise<void> | null = null

function fail(cause: unknown): void {
  error ??= (cause instanceof Error ? cause.message : String(cause)).slice(0, 4096)
  publish()
}
function publish(): void {
  const output = document.getElementById('worker-fixture-status')
  if (output) output.textContent = error ?? `Worker-only: ${ready ? play.getState().lifecycle : 'authoring'}; acknowledged ${observation.view().acknowledgedSequence}`
}
const play = createWorldPlayController({
  createPhysics: (generationId, handlers) => {
    observation.created(generationId)
    const real = createBrowserWorldPhysicsRuntime(generationId, {
      onSnapshot: (snapshot) => { observation.received(snapshot); handlers.onSnapshot(snapshot); publish() },
      onTriggerEvents: (events) => handlers.onTriggerEvents(events),
      onError: (issue) => { observation.fail(`${issue.code}: ${issue.message}`); handlers.onError?.(issue); publish() },
    })
    return {
      initialize: (scene) => { observation.initialized(generationId, scene); return real.initialize(scene) },
      step: (request) => {
        observation.posted(generationId, request)
        postedSteps += request.steps.length
        postedRequests += 1
        real.step(request)
      },
      pause: () => real.pause(), resume: () => real.resume(),
      dispose: () => { real.dispose(); observation.disposed() },
    }
  },
  createAudio: () => {
    const real = createBrowserWorldAudioAuthority('')
    let closing: Promise<void> | null = null
    return {
      prepareScene: (snapshot, sceneId) => real.prepareScene(snapshot, sceneId),
      activate: () => real.activate(), play: (id) => real.play(id), stopSource: (id) => real.stopSource(id),
      update: (poses) => real.update(poses), pause: () => real.pause(), resume: () => real.resume(),
      stop: () => {
        if (!closing) {
          observation.audioClosing()
          closing = real.stop().then(() => observation.audioClosed(), (cause: unknown) => { fail(cause); throw cause })
          audioClose = closing
        }
        return closing
      },
    }
  },
})

function read(): WorkerFixtureView {
  const state = editor.getState()
  return structuredClone({
    lane: 'worker-only', ready, environment: Reflect.get(window, 'worldsFixtureEnvironment') as FixtureEnvironment,
    requireType: typeof Reflect.get(window, 'require'), processType: typeof Reflect.get(window, 'process'),
    canvasCount: document.querySelectorAll('canvas').length, editorSession: state.session, savedRevision: state.savedRevision,
    play: play.getState(), physics: observation.view(), lastFrame,
    error: error ?? observation.view().error ?? play.getState().failure?.message ?? state.error?.message ?? null,
  })
}
async function successful(operation: Promise<WorldPlayControllerResult>): Promise<void> {
  const result = await operation
  assertWorker(result.success, `Production Play rejected the operation: ${JSON.stringify(result)}`)
}
async function settledAudioClose(): Promise<void> {
  const closing = audioClose
  assertWorker(closing, 'Production audio stop did not provide a close-settlement promise.')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([closing, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Real audio close exceeded 3 seconds.')), 3000) })])
  } finally { clearTimeout(timer) }
}

const api: WorkerFixtureApi = Object.freeze({
  read,
  async command(value: unknown): Promise<WorkerFixtureView> {
    assertWorker(!acceptanceSelected, 'Legacy commands cannot run during acceptance admission.')
    const command = parseWorkerFixtureCommand(value)
    // Stop is allowed to cancel a pending real initialization; it never waits behind it.
    assertWorker(!busy || command.type === 'stop', 'A Worker fixture operation is already pending.')
    assertWorker(ready && sampler, 'The authored Worker fixture is not ready.')
    busy = true
    try {
      if (command.type === 'start') {
        const session = editor.getState().session
        assertWorker(session, 'The canonical editor session is missing.')
        await successful(play.start(session, session.snapshot.project.startSceneId))
        needsPrime = true
      } else if (command.type === 'pause') await successful(play.pause())
      else if (command.type === 'resume') { await successful(play.resume()); needsPrime = true }
      else if (command.type === 'stop') {
        sampler.clear()
        if (play.getState().lifecycle !== 'edit') await successful(play.stop())
        await settledAudioClose()
      } else {
        assertWorker(command.tick === lastTick + 1, 'Worker fixture ticks must be consecutive, without clock jumps.')
        lastTick = command.tick
        const timestampMs = workerFrameTimestamp(command.tick)
        const input = sampleWorkerControls(sampler, command.controls)
        const playing = play.getState().lifecycle === 'playing'
        const expectedSteps = playing && !needsPrime ? 1 : 0
        const before = observation.view()
        assertWorker(before.pendingCount === 0, 'Previous Worker request has not been acknowledged.')
        postedSteps = 0; postedRequests = 0
        await successful(play.advance(timestampMs, input))
        await observation.waitForLatestAcknowledgement()
        const after = observation.view()
        assertWorker(postedSteps === expectedSteps && postedRequests === expectedSteps, 'Production advance did not produce exactly the expected fixed-step count.')
        assertWorker(after.generationId === before.generationId && after.acknowledgedSequence === before.acknowledgedSequence + expectedSteps
          && after.postedSequence === after.acknowledgedSequence && after.pendingCount === 0, 'Worker generation/sequence acknowledgement differs from the requested frame.')
        if (playing) needsPrime = false
        lastFrame = { tick: command.tick, timestampMs, expectedSteps, postedSteps, input, generationId: after.generationId, acknowledgedSequence: after.acknowledgedSequence }
      }
      return read()
    } catch (cause) { fail(cause); throw cause }
    finally { busy = false; publish() }
  },
})

// This facade exists only in the explicitly selected programmatic fixture, never in the application or native lane.
Object.defineProperty(window, 'worldsPhysicsWorkerFixture', { value: api, configurable: false, writable: false })
window.addEventListener('error', (event) => fail(event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => fail(event.reason))
window.addEventListener('beforeunload', () => { sampler?.dispose(); if (play.getState().lifecycle !== 'edit') void play.stop() })
export async function runPhysicsAcceptanceEntry(context: { phase: PhysicsAcceptancePhase; authorMs: number }, facade: PhysicsAcceptanceFacade): Promise<void> {
  acceptanceSelected = true
  let pump: ReturnType<typeof createPhysicsAcceptancePump> | null = null, cancelled = false
  let coarse: ReturnType<typeof setInterval> | undefined, reporting: Promise<unknown> | null = null
  const offCancel = facade.onCancel(() => { cancelled = true; if (pump) void pump.cancel().catch(fail) })
  try {
    assertWorker(document.querySelectorAll('canvas').length === 0, 'Acceptance requires a Canvas-free renderer.')
    const session = await boundedEntryOperation(authorWorkerFixtureCourse(editor, 'acceptance-500'), context.authorMs, 'Acceptance authoring')
    assertWorker(!cancelled, 'Acceptance cancelled during authoring.')
    await facade.baseline({ session: { snapshot: session.snapshot,
      undoStack: (session.undoStack ?? []).map(entry => ({ transactionId: entry.transactionId, beforeRevision: entry.before.project.revision, afterRevision: entry.after.project.revision })),
      redoStack: session.redoStack ?? [], receipts: session.receipts ?? [] }, canvasCount: document.querySelectorAll('canvas').length,
      environment: Reflect.get(window, 'worldsFixtureEnvironment') ?? null, requireType: typeof Reflect.get(window, 'require'), processType: typeof Reflect.get(window, 'process') })
    assertWorker(!cancelled, 'Acceptance cancelled before Play.')
    const projection = projectWorldRuntimeScene(session.snapshot, session.snapshot.project.startSceneId)
    assertWorker(projection.success, 'Canonical acceptance physics projection failed.')
    assertWorker(projection.value.physics.bodies.length === 504, 'Acceptance requires exactly504 canonical bodies.')
    // No facade factories: the accepted pump lazily invokes the actual browser Worker/audio defaults.
    pump = createPhysicsAcceptancePump(context.phase, projection.value.physics.bodies.map(body => body.entityId))
    const activePump = pump
    coarse = setInterval(() => {
      if (reporting) return
      const status = activePump.status() // Scalar only, a separate coarse task; never inside an advance/timed tick.
      reporting = facade.progress({ cycle: status.quietCycles, state: status.pumpState }).catch(cause => {
        fail(cause); cancelled = true; void activePump.cancel().catch(fail)
      }).finally(() => { reporting = null })
    }, 1000)
    const status = await activePump.runPhase(session, session.snapshot.project.startSceneId)
    clearInterval(coarse); await reporting
    const evidence = activePump.exportPhase() // Exactly one full export, only after settled terminal/partial cleanup.
    await facade.terminal({ phase: context.phase, result: status.phaseCompleted && !cancelled ? 'completed' : 'partial',
      nativeAccepted: false, status, evidence })
  } catch (cause) {
    clearInterval(coarse); await reporting
    fail(cause)
    let status: unknown = { phaseCompleted: false, settled: false }, evidence: unknown = null
    if (pump) { try { status = await boundedEntryOperation(pump.cancel(), 3000, 'Acceptance cancellation'); evidence = pump.exportPhase() } catch (cleanup) { fail(cleanup) } }
    await facade.terminal({ phase: context.phase, result: 'partial', nativeAccepted: false, status, evidence,
      error: cause instanceof Error ? cause.message.slice(0, 4096) : String(cause).slice(0, 4096) })
  } finally { clearInterval(coarse); offCancel() }
}
const acceptanceFacade = Reflect.get(window, 'worldsPhysicsAcceptance') as PhysicsAcceptanceFacade | undefined
void (async () => {
  const context = await acceptanceFacade?.context()
  if (context && acceptanceFacade) await runPhysicsAcceptanceEntry(context, acceptanceFacade)
  else {
    const session = await authorWorkerFixtureCourse(editor)
    sampler = new WorldInputSampler(session.snapshot.project.inputActions)
    ready = true; publish()
  }
})().catch(fail)
