import type { WorldEditorSession } from '../../src/areas/worlds/core/worldSessions.ts'
import type { WorldEditorController } from '../../src/areas/worlds/editor/worldEditorController.ts'
import type { WorldPlayControllerState } from '../../src/areas/worlds/runtime/worldPlayController.ts'
import type { WorldInputSampler, WorldRuntimeInputFrame } from '../../src/areas/worlds/runtime/worldInputRuntime.ts'
import { WORLD_FIXED_STEP_SECONDS } from '../../src/areas/worlds/runtime/worldRuntimeClock.ts'
import { createPhysicsFixtureBatches } from './scene.ts'
import { PROJECT_KEY, type PhysicsEvidence } from './shared.ts'
import type { FixtureEnvironment } from '../worlds-character-electron-fixture/shared.ts'

export const WORKER_BUILD_SCHEMA = 'modly.worlds-physics-worker-build.v1'
export const WORKER_RUN_SCHEMA = 'modly.worlds-physics-worker-run.v1'
export const WORKER_SCOPE = 'programmatic-worker-play-phase1'
/** Fixed model data only; no renderer/native wiring or execution authority. */
export const PHYSICS_ACCEPTANCE_PROFILES = Object.freeze({
  timing: Object.freeze({ cycles: 3, warmupSteps: 120, recoverySteps: 4, measuredSteps: 600, ownershipSteps: 0,
    // Explicit policy amendment: supersedes only the old plan's final-padding-only assumption.
    packetBoundaryPolicy: Object.freeze({ declaration: 'terminal-warmup-post', warmupPaddingMax: 3,
      finalPaddingMax: 3, totalPaddingMax: 6, supersedes: 'final-padding-only-assumption' }),
    mainDeadlineMs: 180_000, driverDeadlineMs: 165_000, outerDeadlineMs: 190_000 }),
  ownership: Object.freeze({ cycles: 50, warmupSteps: 0, recoverySteps: 0, measuredSteps: 0, ownershipSteps: 60,
    mainDeadlineMs: 900_000, driverDeadlineMs: 880_000, outerDeadlineMs: 910_000 }),
})
export type PhysicsAcceptancePhase = keyof typeof PHYSICS_ACCEPTANCE_PROFILES
export type PhysicsAcceptanceStage = 'warmup' | 'recovery' | 'measured' | 'ownership'
export const PHYSICS_ACCEPTANCE_LIMITS = Object.freeze({ scalarBytes: 4 * 1024 * 1024, poseSnapshots: 2,
  startMs: 12_000, stopMs: 3_000, quietMs: 150, authorMs: 45_000, reopenMs: 15_000, killGraceMs: 5_000 })
export type PhysicsDerivedClockFrame = { sentMs: number; lagMs: number; droppedMs: number } & (
  | { scheduledMs?: never; advanceMs?: never }
  | { scheduledMs: number; advanceMs: number }
)
export type PhysicsAcceptanceStatus = Readonly<{
  phase: PhysicsAcceptancePhase; cycle: number; generationId: number; active: boolean
  stage: PhysicsAcceptanceStage | 'complete'; ordinal: number
  postedSequence: number; acknowledgedSequence: number; pendingSequence: number | null
  pendingCount: 0 | 1; pendingSteps: number; completedCycles: number; cancelledRequests: number
  scalarBytes: number; error: string | null
  measuredStartOrdinal: number | null; measuredEndOrdinal: number | null
}>
export interface PhysicsAcceptanceStopObservation {
  lifecycle: string; runtimeSnapshot: unknown; bodyPoseCount: number; pendingCount: number
  created: number; disposed: number; audioStarted: number; audioCompleted: number
}
export const WORKER_CHECK_NAMES = [
  'sandbox-and-authored-history', 'programmatic-play-ready', 'exact-body-ids', 'ground-settle',
  'programmatic-movement-and-release', 'pause-and-resume', 'sensor-traversal', 'fixed-sensor-enter-exit',
  'platform-blocks-walking', 'jump-and-platform-landing', 'walk-off-and-ground-landing',
  'stop-and-audio-settlement', 'editor-history-receipts-unchanged', 'independent-durable-reopen',
] as const
export type WorkerCheckName = typeof WORKER_CHECK_NAMES[number]
export interface WorkerCheck { name: WorkerCheckName; status: 'PASS' | 'FAIL' | 'UNREACHED'; reason?: string; evidence?: unknown }
export interface WorkerControls { moveRight: boolean; jump: boolean }
export type WorkerFixtureCommand =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'advance'; tick: number; controls: WorkerControls }
export interface WorkerFrameEvidence {
  tick: number
  timestampMs: number
  expectedSteps: number
  postedSteps: number
  input: WorldRuntimeInputFrame
  generationId: number
  acknowledgedSequence: number
}
export interface WorkerFixtureView {
  lane: 'worker-only'
  ready: boolean
  environment: FixtureEnvironment
  requireType: string
  processType: string
  canvasCount: number
  editorSession: WorldEditorSession | null
  savedRevision: number | null
  play: WorldPlayControllerState
  physics: PhysicsEvidence
  lastFrame: WorkerFrameEvidence | null
  error: string | null
}
export interface WorkerFixtureApi {
  read(): WorkerFixtureView
  command(value: unknown): Promise<WorkerFixtureView>
}

export function assertWorker(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Same course as the native lane, but author through the real editor so history is not empty. */
export async function authorWorkerFixtureCourse(editor: WorldEditorController, scenario?: 'acceptance-500'): Promise<WorldEditorSession> {
  const opened = await editor.openProject(PROJECT_KEY)
  assertWorker(opened.ok, 'Worker fixture could not open its canonical project.')
  const initial = editor.getState().session
  assertWorker(initial && initial.snapshot.project.revision === 0, 'Worker fixture requires a fresh, empty project.')
  for (const { transactionId, origin, commands } of createPhysicsFixtureBatches(initial.snapshot, PROJECT_KEY, scenario)) {
    const applied = await editor.dispatchCommands({ transactionId, origin, commands })
    assertWorker(applied.ok, `Worker fixture authoring failed at ${transactionId}: ${JSON.stringify(applied)}`)
  }
  const session = editor.getState().session
  const revision = scenario === 'acceptance-500' ? 23 : 13
  assertWorker(session && session.snapshot.project.revision === revision && session.undoStack.length === revision
    && session.receipts.length === revision && session.redoStack.length === 0, scenario === 'acceptance-500'
      ? 'Acceptance fixture must retain revision 23 and all history entries and receipts.' : 'Worker fixture must retain revision 13 and all thirteen history entries and receipts.')
  return session
}

/** Ordinal simulation input, never a measured wall-clock or physics-step duration. */
export function workerFrameTimestamp(tick: number): number {
  assertWorker(Number.isSafeInteger(tick) && tick >= 0 && tick <= 4096, 'Worker fixture tick is outside its 4096-frame bound.')
  return tick * WORLD_FIXED_STEP_SECONDS * 1000
}

export function sampleWorkerControls(sampler: WorldInputSampler, controls: WorkerControls): WorldRuntimeInputFrame {
  sampler.setControl('keyboard', 'KeyD', controls.moveRight ? 1 : 0)
  sampler.setControl('keyboard', 'Space', controls.jump ? 1 : 0)
  return sampler.sample()
}

export function parseWorkerFixtureCommand(value: unknown): WorkerFixtureCommand {
  assertWorker(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid Worker fixture command.')
  assertWorker('type' in value, 'Worker fixture command type is missing.')
  if (value.type === 'start' || value.type === 'pause' || value.type === 'resume' || value.type === 'stop') {
    assertWorker(Object.keys(value).length === 1, 'Worker fixture command contains unexpected fields.')
    return { type: value.type }
  }
  assertWorker(value.type === 'advance' && Object.keys(value).length === 3 && 'tick' in value && 'controls' in value, 'Invalid Worker fixture command.')
  assertWorker(typeof value.tick === 'number', 'Worker fixture command tick must be numeric.')
  workerFrameTimestamp(value.tick)
  const controls = value.controls
  assertWorker(controls !== null && typeof controls === 'object' && !Array.isArray(controls)
    && Object.keys(controls).length === 2 && 'moveRight' in controls && typeof controls.moveRight === 'boolean'
    && 'jump' in controls && typeof controls.jump === 'boolean', 'Invalid Worker fixture controls.')
  return { type: 'advance', tick: value.tick, controls: { moveRight: controls.moveRight, jump: controls.jump } }
}
