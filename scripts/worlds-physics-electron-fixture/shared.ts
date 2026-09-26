import type { WorldEditorSession, WorldPlayState } from '../../src/areas/worlds/core/worldSessions.ts'
import type { WorldPhysicsTriggerEvent } from '../../src/areas/worlds/runtime/worldPhysicsProtocol.ts'
import type { FixtureEnvironment } from '../worlds-character-electron-fixture/shared.ts'

export { assertSandboxLaunch, SANDBOX_DISABLING_SWITCHES } from '../worlds-character-electron-fixture/shared.ts'
export const PROJECT_KEY = `world-${'3'.repeat(32)}`
export const SCENE_KEY = `scene-${'4'.repeat(32)}`
export const ENTITY_NAMES = { ground: 'Physics ground', character: 'Physics character', sensor: 'Physics sensor', platform: 'Physics platform' } as const
export const CHECK_NAMES = [
  'sandbox-and-original-document', 'native-enter-play', 'exact-body-ids', 'ground-settle',
  'native-movement-and-release', 'pause-and-resume', 'sensor-traversal', 'fixed-sensor-enter-exit',
  'platform-blocks-walking', 'jump-and-platform-landing', 'walk-off-and-ground-landing',
  'stop-restores-editor-and-closes-audio', 'independent-repository-unchanged',
] as const
export type CheckName = typeof CHECK_NAMES[number]
export interface PhysicsCheck { name: CheckName; status: 'PASS' | 'FAIL' | 'UNREACHED'; reason?: string; evidence?: unknown }
export interface NativeTrace {
  sequence: number
  type: string
  trusted: boolean
  key: string | null
  code: string | null
  target: string
  defaultPrevented: boolean
}
export interface PhysicsSample {
  generationId: number
  sequence: number
  entityIds: string[]
  transforms: number[]
  triggerEvents: WorldPhysicsTriggerEvent[]
}
export interface PhysicsEvidence {
  generationId: number
  expectedEntityIds: string[]
  postedSequence: number
  acknowledgedSequence: number
  receivedCount: number
  pendingCount: number
  cancelledRequests: number
  disposedCount: number
  audioCloseStarted: number
  audioCloseCompleted: number
  samples: PhysicsSample[]
  triggerEvents: WorldPhysicsTriggerEvent[]
  error: string | null
}
export interface PhysicsFixtureView {
  bootId: string
  environment: FixtureEnvironment
  requireType: string
  processType: string
  initializing: boolean
  editorLifecycle: string
  playLifecycle: WorldPlayState
  projectKey: string | null
  sceneId: string | null
  savedRevision: number | null
  editorSession: WorldEditorSession | null
  playEditorSession: WorldEditorSession | null
  runtimeSnapshotPresent: boolean
  bodyPoseCount: number
  error: string | null
  physics: PhysicsEvidence
  trace: NativeTrace[]
  untrustedInputs: number
}

// Fixture-private authority; the reused production project bridge remains unchanged.
export const ACCEPTANCE_CHANNELS = Object.freeze({ context: 'worlds-physics-acceptance:context', request: 'worlds-physics-acceptance:request',
  receipt: 'worlds-physics-acceptance:receipt', cancel: 'worlds-physics-acceptance:cancel' })
export interface PhysicsAcceptanceFacade {
  context(): Promise<import('./acceptance-entry.ts').AcceptanceDeclaration | null>
  baseline(payload: unknown): Promise<unknown>
  progress(payload: { cycle: number; state: string }): Promise<unknown>
  terminal(payload: unknown): Promise<{ persisted: boolean }>
  onCancel(callback: () => void): () => void
}

export function boundedFixtureAcceptanceOperation<T>(work: Promise<T>, milliseconds: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} exceeded its fixed deadline.`)), milliseconds)
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
