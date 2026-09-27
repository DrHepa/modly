import type { WorldVector3 } from '../core/worldModel.ts'
import type { WorldsNavigationKeyState } from '../worldCameraNavigation.ts'
import { loadWorldGeometrySource, prepareWorldRuntimeGeometry, type WorldGeometryPreparationDependencies } from '../runtime/worldGeometryPreparation.ts'
import { createBrowserWorldPhysicsRuntime, type WorldPhysicsRuntimeHandlers, type WorldPhysicsWorkerRuntime } from '../runtime/worldPhysicsRuntime.ts'
import type { WorldPhysicsNavigationPose, WorldPhysicsNavigationStep } from '../runtime/worldPhysicsProtocol.ts'
import { WorldFixedStepClock, WORLD_MAX_RECOVERY_STEPS } from '../runtime/worldRuntimeClock.ts'
import { planWorldEditorRunCollision, type WorldEditorRunCollisionInput } from './worldEditorRunCollision.ts'

export type WorldEditorRunStatus = 'preparing' | 'ready' | 'empty' | 'failed' | 'disposed'
type NavigationPhysics = Pick<WorldPhysicsWorkerRuntime, 'initialize' | 'stepNavigation' | 'dispose'>
export interface WorldEditorRunDependencies {
  loadModelGeometry: WorldGeometryPreparationDependencies['loadModelGeometry']
  createPhysics(generation: number, handlers: WorldPhysicsRuntimeHandlers): NavigationPhysics
  scheduleTimeout(callback: () => void, milliseconds: number): () => void
}
const browserDependencies: WorldEditorRunDependencies = {
  loadModelGeometry: loadWorldGeometrySource,
  createPhysics: createBrowserWorldPhysicsRuntime,
  scheduleTimeout: (callback, milliseconds) => { const timeout = setTimeout(callback, milliseconds); return () => clearTimeout(timeout) },
}
let nextGeneration = 0

/** One pointer-capture lifetime. No scene commands, Play controller or renderer objects. */
export class WorldEditorRunSession {
  status: WorldEditorRunStatus = 'preparing'
  private readonly input: WorldEditorRunCollisionInput
  private readonly dependencies: WorldEditorRunDependencies
  private readonly abort = new AbortController()
  private readonly clock = new WorldFixedStepClock()
  private physics: NavigationPhysics | null = null
  private cancelPreparation: (() => void) | null = null
  private timestamp = 0
  private pendingSteps = 0
  private sequence = 0
  private inFlight = false
  private jumpHeld = false
  private jumpPending = false
  private pose: WorldPhysicsNavigationPose | null = null

  constructor(input: WorldEditorRunCollisionInput, position: WorldVector3, dependencies = browserDependencies) {
    this.input = input
    this.dependencies = dependencies
    this.cancelPreparation = dependencies.scheduleTimeout(() => this.fail(), 10_000)
    void this.prepare([...position])
  }

  private current(): boolean {
    if (this.status === 'disposed') return false
    if (!this.input.isCurrent()) { this.dispose(); return false }
    return true
  }

  private async prepare(position: WorldVector3): Promise<void> {
    const generation = ++nextGeneration
    try {
      if (!this.current()) return
      const planned = planWorldEditorRunCollision(this.input.snapshot, this.input.sceneId)
      if (!planned.success) { this.fail(); return }
      if (!planned.plan.physics.bodies.length) { this.status = 'empty'; this.cancelPreparation?.(); return }
      const prepared = await prepareWorldRuntimeGeometry(planned.plan, { apiUrl: this.input.apiUrl, loadModelGeometry: this.dependencies.loadModelGeometry }, this.abort.signal, generation)
      if (!this.current() || this.abort.signal.aborted) return
      if (!prepared.success) { this.fail(); return }
      const physics = this.dependencies.createPhysics(generation, {
        onSnapshot: () => this.fail(), onTriggerEvents: () => this.fail(), onError: () => this.fail(),
        onNavigationPose: pose => {
          if (!this.current() || this.status !== 'ready' || !this.inFlight || pose.sequence !== this.sequence) return
          this.inFlight = false
          this.pose = pose
        },
      })
      this.physics = physics
      await physics.initialize(prepared.projection.physics, { position, frontSurfaces: planned.frontSurfaces })
      if (!this.current() || this.abort.signal.aborted) { physics.dispose(); return }
      this.cancelPreparation?.()
      this.cancelPreparation = null
      this.status = 'ready'
      this.clock.advance(0)
    } catch { if (this.current()) this.fail() }
  }

  /** Fixed 60 Hz, at most four recovery ticks and one outstanding Worker request. */
  advance(deltaSeconds: number, yaw: number, keys: WorldsNavigationKeyState): WorldPhysicsNavigationPose | null {
    if (!this.current() || this.status !== 'ready') return null
    const pose = this.pose
    this.pose = null
    this.timestamp += Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0) * 1_000
    this.pendingSteps = Math.min(WORLD_MAX_RECOVERY_STEPS, this.pendingSteps + this.clock.advance(this.timestamp).steps)
    this.jumpPending ||= Boolean(keys.jump) && !this.jumpHeld
    this.jumpHeld = Boolean(keys.jump)
    if (!this.inFlight && this.pendingSteps > 0) {
      const forward = Number(Boolean(keys.forward)) - Number(Boolean(keys.backward))
      const right = Number(Boolean(keys.right)) - Number(Boolean(keys.left))
      const magnitude = Math.max(1, Math.hypot(forward, right))
      const move: WorldPhysicsNavigationStep['move'] = [
        (-Math.sin(yaw) * forward + Math.cos(yaw) * right) / magnitude,
        (-Math.cos(yaw) * forward - Math.sin(yaw) * right) / magnitude,
      ]
      const steps = Array.from({ length: this.pendingSteps }, (_, index) => ({ move, jumpPressed: index === 0 && this.jumpPending, boost: Boolean(keys.boost) }))
      this.inFlight = true
      this.sequence++
      if (!this.physics!.stepNavigation(this.sequence, steps)) this.fail()
      this.pendingSteps = 0
      this.jumpPending = false
    }
    return pose
  }

  dispose(): void {
    if (this.status === 'disposed') return
    this.status = 'disposed'
    this.stop()
  }

  private fail(): void {
    if (this.status === 'disposed' || this.status === 'failed') return
    this.status = 'failed'
    this.stop()
  }

  private stop(): void {
    this.abort.abort()
    this.cancelPreparation?.()
    this.cancelPreparation = null
    this.physics?.dispose()
    this.physics = null
    this.pose = null
    this.inFlight = false
    this.pendingSteps = 0
    this.clock.reset()
  }
}
