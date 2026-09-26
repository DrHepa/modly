import { isWorldComponentPropertyWritableFor, type WorldComponent } from '../core/worldComponentRegistry.ts'
import {
  startWorldPlaySession,
  transitionWorldPlaySession,
  type WorldEditorSession,
  type WorldPlaySession,
  type WorldPlayState,
} from '../core/worldSessions.ts'
import { cloneWorldProjectSnapshot } from '../core/worldDocuments.ts'
import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import {
  createWorldBehaviorRuntime,
  validateWorldStartTransitionGraph,
  type WorldBehaviorEvaluation,
  type WorldBehaviorIssue,
  type WorldBehaviorRuntime,
} from './worldBehaviorRuntime.ts'
import type { WorldAudioAuthority, WorldAudioPose } from './worldAudioRuntime.ts'
import type { WorldRuntimeInputFrame, WorldRuntimeInputActionState } from './worldInputRuntime.ts'
import {
  type WorldPhysicsCharacterInput,
  type WorldPhysicsFixedStep,
  type WorldPhysicsImpulse,
  type WorldPhysicsSceneDto,
  type WorldPhysicsStepRequest,
  type WorldPhysicsTriggerEvent,
} from './worldPhysicsProtocol.ts'
import type { WorldPhysicsRuntimeHandlers, WorldPhysicsSnapshot } from './worldPhysicsRuntime.ts'
import { WORLD_FIXED_STEP_SECONDS, WorldFixedStepClock } from './worldRuntimeClock.ts'
import { planWorldRuntimeScene, projectWorldRuntimeScene, type WorldRuntimeProjectionIssue, type WorldRuntimeScenePlan, type WorldRuntimeSceneProjection } from './worldRuntimeProjection.ts'
import { prepareWorldRuntimeGeometry, type WorldGeometryPreparationDependencies, type PrepareWorldRuntimeGeometryResult } from './worldGeometryPreparation.ts'
import { resolveWorldRuntimeEntityPoses } from './worldRuntimeEntityGraph.ts'

export interface WorldPhysicsRuntimePort {
  initialize(scene: WorldPhysicsSceneDto): Promise<void>
  step(request: WorldPhysicsStepRequest): void
  pause(): void
  resume(): void
  dispose(): void
}

export type WorldRuntimeBodyPose = WorldAudioPose

export interface WorldRuntimeAnimationRequest {
  entityId: string
  componentId: string
  token: number
}

export interface WorldPlayControllerState {
  lifecycle: WorldPlayState
  generationId: number
  sceneId: string | null
  editor: WorldEditorSession | null
  runtimeSnapshot: WorldProjectSnapshotV1 | null
  bodyPoses: readonly WorldRuntimeBodyPose[]
  animationRequests: readonly WorldRuntimeAnimationRequest[]
  diagnostics: readonly WorldBehaviorIssue[]
  failure: WorldRuntimeProjectionIssue | WorldBehaviorIssue | null
}

export interface WorldPlayControllerDependencies {
  createPhysics(generationId: number, handlers: WorldPhysicsRuntimeHandlers): WorldPhysicsRuntimePort
  createAudio(): WorldAudioAuthority
  geometry?: WorldGeometryPreparationDependencies
}

type WorldPlayControllerFailure = {
  success: false
  issues: Array<WorldRuntimeProjectionIssue | WorldBehaviorIssue>
}

export type WorldPlayControllerResult = { success: true } | WorldPlayControllerFailure

interface ActiveRuntimeScene {
  generationId: number
  plan: WorldRuntimeScenePlan
  projection: WorldRuntimeSceneProjection
  physics: WorldPhysicsRuntimePort
  audio: WorldAudioAuthority
  behavior: WorldBehaviorRuntime
}

interface PreparedRuntimeScene extends ActiveRuntimeScene {
  sceneId: string
  markPublished(): void
}

interface PreparedStartScene {
  runtime: PreparedRuntimeScene
  snapshot: WorldProjectSnapshotV1
  startEvaluation: WorldBehaviorEvaluation
  dispatchedStart: DispatchedBehaviorEffects
  startSequence: number
}

interface PlannedStartScene {
  sceneId: string
  snapshot: WorldProjectSnapshotV1
  plan: WorldRuntimeScenePlan
  projection: WorldRuntimeSceneProjection
  behavior: WorldBehaviorRuntime
  startEvaluation: WorldBehaviorEvaluation
  preparedBehavior: PreparedBehaviorEvaluation
}

type PlanStartSceneChainResult =
  | { success: true; scenes: PlannedStartScene[] }
  | { success: false; issues: Array<WorldRuntimeProjectionIssue | WorldBehaviorIssue> }

type PrepareStartSceneResult =
  | { success: true; scene: PreparedStartScene }
  | { success: false; issues: Array<WorldRuntimeProjectionIssue | WorldBehaviorIssue> }

type PrepareStartSceneChainResult =
  | { success: true; scenes: PreparedStartScene[] }
  | { success: false; issues: Array<WorldRuntimeProjectionIssue | WorldBehaviorIssue> }

interface PendingSceneLoad {
  abortController: AbortController
  geometryGenerationId: number
  runtimes: Set<PreparedRuntimeScene>
  retiring: ActiveRuntimeScene | null
  failure: Promise<never>
  cancelled: boolean
  fail(error: Error, cancelled: boolean): void
}

type WorldBehaviorEffect = WorldBehaviorEvaluation['effects'][number]

interface PreparedBehaviorEvaluation {
  snapshot: WorldProjectSnapshotV1
  projection: WorldRuntimeSceneProjection | null
  externalEffects: WorldBehaviorEffect[]
}

type PrepareBehaviorEvaluationResult =
  | { success: true; plan: PreparedBehaviorEvaluation }
  | { success: false; issue: WorldBehaviorIssue }

interface DispatchedBehaviorEffects {
  animations: Array<{ entityId: string; componentId: string }>
  impulses: WorldPhysicsImpulse[]
}

export class WorldPlayController {
  private readonly dependencies: WorldPlayControllerDependencies
  private readonly listeners = new Set<() => void>()
  private readonly clock = new WorldFixedStepClock()
  private state: WorldPlayControllerState = sealState({
    lifecycle: 'edit', generationId: 0, sceneId: null, editor: null, runtimeSnapshot: null,
    bodyPoses: [], animationRequests: [], diagnostics: [], failure: null,
  })
  private session: WorldPlaySession | null = null
  private active: ActiveRuntimeScene | null = null
  private pending: PreparedRuntimeScene | null = null
  private pendingLoad: PendingSceneLoad | null = null
  private generationCounter = 0
  private activeGenerationId = 0
  private sequence = 0
  private animationToken = 0
  private triggerEvents: WorldPhysicsTriggerEvent[] = []
  private readonly bufferedPressed = new Set<string>()
  private readonly bufferedReleased = new Set<string>()
  private switching = false
  private sceneChangeOwner: symbol | null = null
  private readonly audioStops = new Map<WorldAudioAuthority, Promise<void>>()

  constructor(dependencies: WorldPlayControllerDependencies) {
    this.dependencies = dependencies
  }

  getState(): WorldPlayControllerState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(editor: WorldEditorSession, sceneId = editor.snapshot.project.startSceneId): Promise<WorldPlayControllerResult> {
    if (this.state.lifecycle !== 'edit') return controllerFailure('play-state', 'Play is already active.')
    const startingSession = startWorldPlaySession(editor)
    this.session = startingSession
    this.sceneChangeOwner = null
    this.clock.reset()
    this.sequence = 0
    this.triggerEvents = []
    this.bufferedPressed.clear()
    this.bufferedReleased.clear()
    this.updateState({ lifecycle: 'loading', editor, runtimeSnapshot: this.session.runtimeSnapshot, sceneId: null, diagnostics: [], failure: null })
    const loaded = await this.loadScene(sceneId, true)
    if (!loaded.success && this.session === startingSession) await this.abortStart(loaded.issues[0] ?? null)
    return loaded
  }

  async pause(): Promise<WorldPlayControllerResult> {
    if (!this.session) return controllerFailure('play-state', 'Play is not active.')
    const transitioned = transitionWorldPlaySession(this.session, 'pause')
    if (!transitioned.success) return { success: false, issues: transitioned.issues }
    this.session = transitioned.session
    const pausingSession = this.session
    const active = this.active
    this.clock.pause()
    active?.physics.pause()
    await active?.audio.pause()
    if (this.session !== pausingSession || this.active !== active) return controllerFailure('play-state', 'Play changed while pausing.')
    this.updateState({ lifecycle: 'paused' })
    return { success: true }
  }

  async resume(): Promise<WorldPlayControllerResult> {
    if (!this.session) return controllerFailure('play-state', 'Play is not active.')
    const transitioned = transitionWorldPlaySession(this.session, 'resume')
    if (!transitioned.success) return { success: false, issues: transitioned.issues }
    this.session = transitioned.session
    const resumingSession = this.session
    const active = this.active
    this.clock.resume()
    active?.physics.resume()
    await active?.audio.resume()
    if (this.session !== resumingSession || this.active !== active) return controllerFailure('play-state', 'Play changed while resuming.')
    this.updateState({ lifecycle: 'playing' })
    return { success: true }
  }

  async stop(): Promise<WorldPlayControllerResult> {
    if (!this.session || this.state.lifecycle === 'edit') return controllerFailure('play-state', 'Play is not active.')
    if (this.state.lifecycle === 'stopping') return controllerFailure('play-state', 'Play is already stopping.')
    const transitioned = transitionWorldPlaySession(this.session, 'stop')
    if (!transitioned.success) return { success: false, issues: transitioned.issues }
    const stoppingSession = transitioned.session
    this.session = stoppingSession
    this.generationCounter += 1
    this.switching = false
    this.sceneChangeOwner = null
    this.clock.pause()
    const pendingLoad = this.pendingLoad
    pendingLoad?.fail(new Error('Runtime scene load was superseded.'), true)
    const prepared = [...(pendingLoad?.runtimes ?? [])]
    const retiring = pendingLoad?.retiring ?? null
    const active = this.active
    pendingLoad?.runtimes.clear()
    if (pendingLoad) pendingLoad.retiring = null
    this.pendingLoad = null
    this.pending = null
    this.active = null
    const owned = new Set<ActiveRuntimeScene>(prepared)
    if (active) owned.add(active)
    if (retiring) owned.add(retiring)
    this.activeGenerationId = 0
    this.triggerEvents = []
    this.bufferedPressed.clear()
    this.bufferedReleased.clear()
    this.updateState({
      lifecycle: 'stopping', generationId: this.generationCounter, sceneId: null,
      runtimeSnapshot: null, bodyPoses: [], animationRequests: [],
    })
    for (const runtime of owned) runtime.physics.dispose()
    for (const runtime of owned) this.initiateAudioStop(runtime.audio)
    const settlements = await Promise.allSettled(this.audioStops.values())
    const issues: WorldBehaviorIssue[] = settlements.flatMap((settlement) => settlement.status === 'rejected' ? [{
      code: 'runtime-audio-stop-failed', path: 'play.audio',
      message: settlement.reason instanceof Error ? settlement.reason.message : 'World audio shutdown failed.',
    }] : [])
    this.audioStops.clear()
    if (this.session !== stoppingSession) return controllerFailure('play-state', 'Play changed while stopping.')
    const stopped = transitionWorldPlaySession(stoppingSession, 'stopped')
    if (!stopped.success) return { success: false, issues: stopped.issues }
    this.session = stopped.session
    const editor = stopped.session.editor
    this.updateState({
      lifecycle: 'edit', generationId: this.generationCounter, sceneId: null, editor,
      runtimeSnapshot: null, bodyPoses: [], animationRequests: [], diagnostics: issues, failure: issues[0] ?? null,
    })
    return issues.length > 0 ? { success: false, issues } : { success: true }
  }

  private initiateAudioStop(audio: WorldAudioAuthority): void {
    if (this.audioStops.has(audio)) return
    // Keep the first close tail: an already-stopped authority may return early on a second stop.
    let resolveStop = () => {}
    let rejectStop = (_reason: unknown) => {}
    const shutdown = new Promise<void>((resolve, reject) => { resolveStop = resolve; rejectStop = reject })
    this.audioStops.set(audio, shutdown)
    void shutdown.then(
      () => { if (this.audioStops.get(audio) === shutdown) this.audioStops.delete(audio) },
      () => { /* Retain failed shutdown for the final Stop result, without an unhandled rejection. */ },
    )
    void stopWorldAudioAuthority(audio).then(resolveStop, rejectStop)
  }

  async advance(timestampMs: number, input: WorldRuntimeInputFrame): Promise<WorldPlayControllerResult> {
    if (this.state.lifecycle !== 'playing' || !this.active || !this.state.runtimeSnapshot) return { success: true }
    const active = this.active
    for (const [actionId, action] of Object.entries(input.actions)) {
      if (action.pressed) this.bufferedPressed.add(actionId)
      if (action.released) this.bufferedReleased.add(actionId)
    }
    const advance = this.clock.advance(timestampMs)
    if (advance.steps === 0) return { success: true }
    const steppedInput = withBufferedInputEdges(input, this.bufferedPressed, this.bufferedReleased)
    this.bufferedPressed.clear()
    this.bufferedReleased.clear()
    const steps: WorldPhysicsFixedStep[] = []
    const queuedTriggers = this.triggerEvents
    this.triggerEvents = []
    for (let step = 0; step < advance.steps; step += 1) {
      const inputForStep = step === 0 ? steppedInput : withoutInputEdges(steppedInput)
      const behaviorCheckpoint = this.active.behavior.createCheckpoint()
      const evaluatedBehavior = this.active.behavior
      const evaluation = this.active.behavior.step(
        WORLD_FIXED_STEP_SECONDS,
        inputForStep,
        step === 0 ? queuedTriggers : [],
      )
      const impulses: WorldPhysicsImpulse[] = []
      const applied = await this.applyBehaviorEvaluation(evaluation, impulses)
      if (this.active !== active || this.state.lifecycle !== 'playing') return controllerFailure('play-state', 'Play changed while advancing.')
      if (!applied.success) {
        this.active.behavior.restoreCheckpoint(behaviorCheckpoint)
        return applied
      }
      if (evaluation.sceneTransition) {
        const transitioned = await this.requestSceneChange(evaluation.sceneTransition.sceneId)
        if (!transitioned.success) evaluatedBehavior.restoreCheckpoint(behaviorCheckpoint)
        return transitioned
      }
      steps.push({ characters: projectCharacterInputs(this.active.projection.physics, inputForStep), impulses })
    }
    this.sequence += 1
    this.active.physics.step({ sequence: this.sequence, steps })
    return { success: true }
  }

  async requestSceneChange(sceneId: string): Promise<WorldPlayControllerResult> {
    if (!this.session || !this.state.runtimeSnapshot || !this.active || this.switching) {
      return controllerFailure('scene-transition-busy', 'A scene transition is already in progress.')
    }
    this.switching = true
    // Pause/resume replace the session within the same Play, not the scene-change owner.
    const changingOwner = Symbol('world-scene-change')
    this.sceneChangeOwner = changingOwner
    const previousLifecycle = this.state.lifecycle
    this.updateState({ lifecycle: 'loading' })
    const result = await this.loadScene(sceneId, false)
    if (this.sceneChangeOwner !== changingOwner) return result
    this.sceneChangeOwner = null
    this.switching = false
    if (!result.success && this.session?.state !== 'stopping' && this.state.lifecycle !== 'edit') {
      this.updateState({ lifecycle: previousLifecycle === 'paused' ? 'paused' : 'playing' })
    }
    return result
  }

  private async loadScene(sceneId: string, initial: boolean): Promise<WorldPlayControllerResult> {
    if (!this.session || !this.state.runtimeSnapshot) return controllerFailure('play-state', 'Runtime snapshot is unavailable.')
    if (this.pendingLoad) return controllerFailure('scene-transition-busy', 'A scene transition is already in progress.')
    const planned = this.planValidatedStartSceneChain(this.state.runtimeSnapshot, sceneId)
    if (!planned.success) return planned
    const load = createPendingSceneLoad(this.generationCounter + 1)
    this.pendingLoad = load
    const geometry = await this.prepareStartSceneGeometries(planned.scenes, load)
    if (!geometry.success) {
      await this.disposePendingSceneLoad(load)
      return geometry
    }
    const chain = await this.prepareStartSceneAuthorities(geometry.scenes, load)
    if (!chain.success) {
      await this.disposePendingSceneLoad(load)
      return chain
    }
    const finalScene = chain.scenes.at(-1)
    if (!finalScene) {
      await this.disposePendingSceneLoad(load)
      return controllerFailure('runtime-load-failed', 'Runtime scene preparation did not complete.')
    }

    const intermediateRuntimes = chain.scenes.slice(0, -1).map((scene) => scene.runtime)
    for (const runtime of intermediateRuntimes) {
      runtime.physics.dispose()
      load.runtimes.delete(runtime)
      this.initiateAudioStop(runtime.audio)
    }
    if (this.isPendingSceneLoadCancelled(load)) {
      await this.disposePendingSceneLoad(load)
      return controllerFailure('runtime-load-cancelled', 'Runtime scene load was superseded.')
    }

    if (initial) {
      const transitioned = transitionWorldPlaySession(this.session, 'loaded')
      if (!transitioned.success) {
        await this.disposePendingSceneLoad(load)
        return { success: false, issues: transitioned.issues }
      }
      this.session = transitioned.session
    }

    const prepared = finalScene.runtime
    const previous = this.active
    this.active = prepared
    this.pending = null
    load.runtimes.delete(prepared)
    this.activeGenerationId = prepared.generationId
    prepared.markPublished()
    this.clock.reset()
    this.sequence = finalScene.startSequence
    this.triggerEvents = []
    this.bufferedPressed.clear()
    this.bufferedReleased.clear()
    const animationRequests = this.createAnimationRequests([], finalScene.dispatchedStart.animations)
    const diagnostics = chain.scenes.flatMap((scene) => scene.startEvaluation.diagnostics)
    load.retiring = previous
    this.updateState({
      lifecycle: 'playing', generationId: prepared.generationId, sceneId: prepared.sceneId,
      runtimeSnapshot: finalScene.snapshot, bodyPoses: prepared.projection.worldPoses, animationRequests,
      diagnostics: [...this.state.diagnostics, ...diagnostics].slice(-128), failure: null,
    })
    if (this.isPendingSceneLoadCancelled(load)) {
      if (this.pendingLoad === load) this.pendingLoad = null
      return controllerFailure('runtime-load-cancelled', 'Runtime scene load was superseded.')
    }

    if (previous) {
      previous.physics.dispose()
      this.initiateAudioStop(previous.audio)
      load.retiring = null
    }
    if (this.isPendingSceneLoadCancelled(load)) {
      if (this.pendingLoad === load) this.pendingLoad = null
      return controllerFailure('runtime-load-cancelled', 'Runtime scene load was superseded.')
    }
    if (this.pendingLoad === load) this.pendingLoad = null
    return { success: true }
  }

  private planValidatedStartSceneChain(runtimeSnapshot: WorldProjectSnapshotV1, sceneId: string): PlanStartSceneChainResult {
    const graph = validateWorldStartTransitionGraph(runtimeSnapshot, [sceneId])
    if (!graph.success) return graph
    const sceneIds = graph.chains[0]?.sceneIds
    if (!sceneIds) return prepareStartSceneChainFailure('runtime-load-failed', `Start scene ${sceneId} could not be planned.`)
    return this.planStartSceneChain(runtimeSnapshot, sceneIds)
  }

  private planStartSceneChain(
    runtimeSnapshot: WorldProjectSnapshotV1,
    sceneIds: readonly string[],
  ): PlanStartSceneChainResult {
    const [sceneId, ...remainingSceneIds] = sceneIds
    if (!sceneId) return prepareStartSceneChainFailure('runtime-load-failed', 'Start scene chain is empty.')
    const projection = planWorldRuntimeScene(runtimeSnapshot, sceneId)
    if (!projection.success) return { success: false, issues: projection.issues }
    const behavior = createWorldBehaviorRuntime(runtimeSnapshot, sceneId)
    if (!behavior.success) return { success: false, issues: behavior.issues }
    const startEvaluation = behavior.runtime.start()
    const preparedStart = this.prepareBehaviorEvaluation(runtimeSnapshot, sceneId, startEvaluation)
    if (!preparedStart.success) return { success: false, issues: [preparedStart.issue] }
    const preparedPlan = preparedStart.plan.snapshot === runtimeSnapshot ? projection : planWorldRuntimeScene(preparedStart.plan.snapshot, sceneId)
    if (!preparedPlan.success) return { success: false, issues: preparedPlan.issues }
    const preparedProjection = preparedStart.plan.projection ?? projection.value as unknown as WorldRuntimeSceneProjection
    const current: PlannedStartScene = {
      sceneId,
      snapshot: preparedStart.plan.snapshot,
      plan: preparedPlan.value,
      projection: preparedProjection,
      behavior: behavior.runtime,
      startEvaluation,
      preparedBehavior: preparedStart.plan,
    }
    const transition = startEvaluation.sceneTransition
    if (remainingSceneIds.length === 0) {
      if (transition) return prepareStartSceneChainFailure('runtime-start-transition-changed', `Start transition graph changed while planning ${sceneId}.`)
      return { success: true, scenes: [current] }
    }
    if (!transition || transition.sceneId !== remainingSceneIds[0]) {
      return prepareStartSceneChainFailure('runtime-start-transition-changed', `Start transition graph changed while planning ${sceneId}.`)
    }
    const tail = this.planStartSceneChain(preparedStart.plan.snapshot, remainingSceneIds)
    if (!tail.success) return tail
    return { success: true, scenes: [current, ...tail.scenes] }
  }

  private async prepareStartSceneGeometries(
    plans: readonly PlannedStartScene[],
    load: PendingSceneLoad,
  ): Promise<{ success: true; scenes: PlannedStartScene[] } | WorldPlayControllerFailure> {
    const scenes: PlannedStartScene[] = []
    for (const plan of plans) {
      if (this.isPendingSceneLoadCancelled(load)) return prepareStartSceneChainFailure('runtime-load-cancelled', 'Runtime scene load was superseded.')
      const prepared = await this.preparePlanGeometry(plan.plan, load)
      if (!prepared.success) return { success: false, issues: prepared.issues }
      scenes.push({ ...plan, projection: prepared.projection })
    }
    return { success: true, scenes }
  }

  private async preparePlanGeometry(
    plan: WorldRuntimeScenePlan,
    load: PendingSceneLoad,
  ): Promise<PrepareWorldRuntimeGeometryResult> {
    if (!scenePlanNeedsGeometry(plan)) {
      return prepareWorldRuntimeGeometry(plan, { apiUrl: '', async loadModelGeometry() { throw new Error('Geometry loader was not expected for primitive scene.') } }, load.abortController.signal, load.geometryGenerationId)
    }
    const geometry = this.dependencies.geometry
    if (!geometry) {
      return { success: false, issues: [{ code: 'runtime-geometry-loader-missing', path: 'play.geometry', message: 'Play physics mesh colliders require the trusted geometry loader.' }] }
    }
    return prepareWorldRuntimeGeometry(plan, geometry, load.abortController.signal, load.geometryGenerationId)
  }

  private async prepareStartSceneAuthorities(
    plans: readonly PlannedStartScene[],
    load: PendingSceneLoad,
  ): Promise<PrepareStartSceneChainResult> {
    const scenes: PreparedStartScene[] = []
    for (const plan of plans) {
      const prepared = await this.prepareStartSceneAuthority(plan, load)
      if (!prepared.success) return prepared
      scenes.push(prepared.scene)
    }
    return { success: true, scenes }
  }

  private async prepareStartSceneAuthority(
    plan: PlannedStartScene,
    load: PendingSceneLoad,
  ): Promise<PrepareStartSceneResult> {
    if (this.isPendingSceneLoadCancelled(load)) {
      return prepareStartSceneChainFailure('runtime-load-cancelled', 'Runtime scene load was superseded.')
    }
    const generationId = ++this.generationCounter
    let physics: WorldPhysicsRuntimePort | null = null
    let audio: WorldAudioAuthority | null = null
    let prepared: PreparedRuntimeScene | null = null
    let published = false
    try {
      physics = this.dependencies.createPhysics(generationId, {
        onSnapshot: (snapshot) => this.acceptSnapshot(generationId, snapshot),
        onTriggerEvents: (events) => this.acceptTriggerEvents(generationId, events),
        onError: (issue) => {
          if (!published) {
            load.fail(new Error(issue.message), false)
            return
          }
          void this.acceptPhysicsError(generationId, issue)
        },
      })
      audio = this.dependencies.createAudio()
      prepared = {
        generationId,
        sceneId: plan.sceneId,
        plan: plan.plan,
        projection: plan.projection,
        physics,
        audio,
        behavior: plan.behavior,
        markPublished: () => { published = true },
      }
      load.runtimes.add(prepared)
      this.pending = prepared
      await waitForPendingSceneLoad(load, Promise.all([
        physics.initialize(plan.projection.physics),
        audio.prepareScene(plan.snapshot, plan.sceneId),
      ]))
      if (this.isPendingSceneLoadCancelled(load)) throw new Error('Runtime scene load was superseded.')
      audio.update(plan.projection.worldPoses)
      await waitForPendingSceneLoad(load, audio.activate())
      if (this.isPendingSceneLoadCancelled(load)) throw new Error('Runtime scene load was superseded.')
    } catch (error) {
      if (!prepared) {
        physics?.dispose()
        if (audio) this.initiateAudioStop(audio)
      }
      return this.pendingStartSceneChainFailure(load, 'runtime-load-failed', error)
    }
    if (!prepared) return prepareStartSceneChainFailure('runtime-load-failed', 'Runtime scene preparation did not complete.')

    let dispatchedStart: DispatchedBehaviorEffects
    let startSequence = 0
    try {
      dispatchedStart = await waitForPendingSceneLoad(
        load,
        this.dispatchBehaviorExternalEffects(plan.preparedBehavior.externalEffects, prepared.audio),
      )
      if (dispatchedStart.impulses.length > 0) {
        startSequence = 1
        prepared.physics.step({
          sequence: startSequence,
          steps: [{ characters: [], impulses: dispatchedStart.impulses }],
        })
        await waitForPendingSceneLoad(load, Promise.resolve())
      }
      if (this.isPendingSceneLoadCancelled(load)) throw new Error('Runtime scene load was superseded.')
    } catch (error) {
      return this.pendingStartSceneChainFailure(load, 'runtime-start-failed', error)
    }

    return { success: true, scene: {
      runtime: prepared,
      snapshot: plan.snapshot,
      startEvaluation: plan.startEvaluation,
      dispatchedStart,
      startSequence,
    } }
  }

  private isPendingSceneLoadCancelled(load: PendingSceneLoad): boolean {
    return load.cancelled || this.pendingLoad !== load
      || this.state.lifecycle === 'stopping' || this.state.lifecycle === 'edit'
  }

  private pendingStartSceneChainFailure(
    load: PendingSceneLoad,
    code: 'runtime-load-failed' | 'runtime-start-failed',
    error: unknown,
  ): WorldPlayControllerFailure {
    return this.pendingSceneLoadFailure(load, code, error)
  }

  private pendingSceneLoadFailure(
    load: PendingSceneLoad,
    code: 'runtime-load-failed' | 'runtime-start-failed',
    error: unknown,
  ): WorldPlayControllerFailure {
    const cancelled = this.isPendingSceneLoadCancelled(load)
    return controllerFailure(
      cancelled ? 'runtime-load-cancelled' : code,
      cancelled ? 'Runtime scene load was superseded.' : error instanceof Error ? error.message : 'Runtime scene failed to load.',
    )
  }

  private async disposePendingSceneLoad(load: PendingSceneLoad): Promise<void> {
    const runtimes = [...load.runtimes]
    load.runtimes.clear()
    for (const runtime of runtimes) runtime.physics.dispose()
    for (const runtime of runtimes) this.initiateAudioStop(runtime.audio)
    if (this.pendingLoad === load) this.pendingLoad = null
    if (this.pending && runtimes.includes(this.pending)) this.pending = null
  }

  private async applyBehaviorEvaluation(evaluation: WorldBehaviorEvaluation, impulses: WorldPhysicsImpulse[]): Promise<WorldPlayControllerResult> {
    const currentSnapshot = this.state.runtimeSnapshot
    const active = this.active
    const sceneId = this.state.sceneId ?? this.pending?.sceneId
    if (!currentSnapshot || !sceneId) return controllerFailure('play-state', 'Runtime scene is unavailable.')
    const prepared = this.prepareBehaviorEvaluation(currentSnapshot, sceneId, evaluation)
    if (!prepared.success) return this.rejectBehaviorTransaction(evaluation, prepared.issue)
    const transitionSceneId = evaluation.sceneTransition?.sceneId
    if (transitionSceneId) {
      const plannedTransition = this.planValidatedStartSceneChain(prepared.plan.snapshot, transitionSceneId)
      if (!plannedTransition.success) {
        const cause = plannedTransition.issues[0]
          ?? { code: 'runtime-scene-invalid', path: `scenes.${transitionSceneId}`, message: 'The resulting runtime scene is invalid.' }
        const issue = cause.code === 'runtime-behavior-state-invalid'
          ? cause
          : behaviorCandidateIssue(cause)
        return this.rejectBehaviorTransaction(evaluation, issue)
      }
    }
    let dispatched: DispatchedBehaviorEffects
    try {
      if (!active) return controllerFailure('play-state', 'Runtime scene is unavailable.')
      dispatched = await this.dispatchBehaviorExternalEffects(prepared.plan.externalEffects, active.audio)
    } catch (error) {
      if (this.active !== active) return controllerFailure('play-state', 'Play changed while applying behavior.')
      return this.rejectBehaviorTransaction(evaluation, {
        code: 'runtime-behavior-effect-failed',
        path: 'behaviors.effects',
        message: error instanceof Error ? error.message : 'A runtime behavior effect failed.',
      })
    }
    if (this.active !== active) return controllerFailure('play-state', 'Play changed while applying behavior.')
    if (prepared.plan.projection && this.active?.projection.sceneId === sceneId) this.active.projection = prepared.plan.projection
    const animationRequests = this.createAnimationRequests(this.state.animationRequests, dispatched.animations)
    if (prepared.plan.snapshot !== currentSnapshot || evaluation.diagnostics.length > 0 || dispatched.animations.length > 0) {
      this.updateState({
        runtimeSnapshot: prepared.plan.snapshot,
        diagnostics: [...this.state.diagnostics, ...evaluation.diagnostics].slice(-128),
        animationRequests,
      })
    }
    impulses.push(...dispatched.impulses)
    return { success: true }
  }

  private prepareBehaviorEvaluation(
    currentSnapshot: WorldProjectSnapshotV1,
    sceneId: string,
    evaluation: WorldBehaviorEvaluation,
  ): PrepareBehaviorEvaluationResult {
    let snapshot = currentSnapshot
    const currentScene = currentSnapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
    if (!currentScene) {
      return { success: false, issue: { code: 'scene-missing', path: `scenes.${sceneId}`, message: `Scene ${sceneId} is unavailable.` } }
    }
    let mutableScene = currentScene
    let snapshotMutated = false
    const externalEffects: WorldBehaviorEffect[] = []
    const ensureMutableScene = () => {
      if (!snapshotMutated) {
        snapshot = cloneWorldProjectSnapshot(snapshot)
        mutableScene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)!
        snapshotMutated = true
      }
      return mutableScene
    }
    for (const effect of evaluation.effects) {
      const action = effect.action
      if (action.type === 'change-scene') continue
      if (action.type === 'set-visibility') {
        const entity = currentScene.entities.find((candidate) => candidate.id === action.entityId)
        const renderable = entity?.components.find((component) => component.type === 'renderable')
        if (renderable?.type !== 'renderable') {
          return {
            success: false,
            issue: {
              code: 'runtime-visibility-rejected',
              path: `entities.${action.entityId}`,
              message: `Behavior transaction was rejected: entity ${action.entityId} has no renderable visibility authority.`,
            },
          }
        }
        const mutableEntity = ensureMutableScene().entities.find((candidate) => candidate.id === action.entityId)!
        const mutableRenderable = mutableEntity.components.find((component) => component.id === renderable.id)
        if (mutableRenderable?.type === 'renderable') mutableRenderable.visible = action.visible
      } else if (action.type === 'set-component-property') {
        const entity = currentScene.entities.find((candidate) => candidate.id === action.entityId)
        const component = entity?.components.find((candidate) => candidate.id === action.componentId && candidate.type === action.componentType)
        if (!component || !isWorldComponentPropertyWritableFor(component, action.property, action.value)) {
          return {
            success: false,
            issue: {
              code: 'runtime-property-rejected',
              path: `components.${action.componentId}.${action.property}`,
              message: `Behavior transaction was rejected: ${action.componentId}.${action.property} is not writable.`,
            },
          }
        }
        const mutableEntity = ensureMutableScene().entities.find((candidate) => candidate.id === action.entityId)!
        const mutableComponent = mutableEntity.components.find((candidate) => candidate.id === action.componentId)!
        setComponentProperty(mutableComponent, action.property, action.value)
      } else if (action.type === 'play-animation' || action.type === 'play-audio' || action.type === 'stop-audio' || action.type === 'apply-impulse') {
        externalEffects.push(effect)
      } else {
        return {
          success: false,
          issue: {
            code: 'unsupported-behavior-action',
            path: `behaviors.${effect.componentId}.${effect.bindingId}`,
            message: `Behavior action ${(action as { type?: unknown }).type ?? 'unknown'} is unsupported.`,
          },
        }
      }
    }

    let projection: WorldRuntimeSceneProjection | null = null
    if (snapshotMutated) {
      const currentCandidate = preflightBehaviorCandidate(snapshot, sceneId, this.active?.projection)
      if (!currentCandidate.success) return { success: false, issue: behaviorCandidateIssue(currentCandidate.issue) }
      projection = currentCandidate.projection
    }
    const transitionSceneId = evaluation.sceneTransition?.sceneId
    if (transitionSceneId && transitionSceneId !== sceneId) {
      const transitionCandidate = preflightBehaviorCandidate(snapshot, transitionSceneId, transitionSceneId === this.active?.projection.sceneId ? this.active.projection : undefined)
      if (!transitionCandidate.success) return { success: false, issue: behaviorCandidateIssue(transitionCandidate.issue) }
    }
    return { success: true, plan: { snapshot, projection, externalEffects } }
  }

  private async dispatchBehaviorExternalEffects(
    effects: readonly WorldBehaviorEffect[],
    audio: WorldAudioAuthority,
  ): Promise<DispatchedBehaviorEffects> {
    const animations: DispatchedBehaviorEffects['animations'] = []
    const impulses: WorldPhysicsImpulse[] = []
    for (const effect of effects) {
      const action = effect.action
      if (action.type === 'play-animation') {
        animations.push({ entityId: action.entityId, componentId: action.componentId })
      } else if (action.type === 'play-audio') {
        await audio.play(action.componentId)
      } else if (action.type === 'stop-audio') {
        await audio.stopSource(action.componentId)
      } else if (action.type === 'apply-impulse') {
        impulses.push({ entityId: action.entityId, impulse: [...action.impulse] })
      }
    }
    return { animations, impulses }
  }

  private createAnimationRequests(
    current: readonly WorldRuntimeAnimationRequest[],
    animations: readonly { entityId: string; componentId: string }[],
  ): WorldRuntimeAnimationRequest[] {
    const requests = [...current]
    for (const animation of animations) {
      this.animationToken += 1
      requests.push({ ...animation, token: this.animationToken })
    }
    return requests.slice(-128)
  }

  private rejectBehaviorTransaction(evaluation: WorldBehaviorEvaluation, issue: WorldBehaviorIssue): WorldPlayControllerResult {
    this.updateState({
      diagnostics: [...this.state.diagnostics, ...evaluation.diagnostics, issue].slice(-128),
    })
    return { success: false, issues: [issue] }
  }

  private acceptSnapshot(generationId: number, snapshot: WorldPhysicsSnapshot): void {
    if (!this.active || generationId !== this.activeGenerationId || snapshot.generationId !== generationId) return
    const bodyPoses: WorldRuntimeBodyPose[] = snapshot.entityIds.map((entityId, index) => {
      const offset = index * 7
      return {
        entityId,
        position: [snapshot.transforms[offset]!, snapshot.transforms[offset + 1]!, snapshot.transforms[offset + 2]!],
        rotation: [snapshot.transforms[offset + 3]!, snapshot.transforms[offset + 4]!, snapshot.transforms[offset + 5]!, snapshot.transforms[offset + 6]!],
      }
    })
    const scene = this.state.runtimeSnapshot?.scenes.find((candidate) => candidate.sceneId === this.active?.projection.sceneId)
    const poses = scene ? resolveWorldRuntimeEntityPoses(scene.entities, bodyPoses) : bodyPoses
    this.active.audio.update(poses)
    this.updateState({ bodyPoses: poses })
  }

  private acceptTriggerEvents(generationId: number, events: WorldPhysicsTriggerEvent[]): void {
    if (!this.active || generationId !== this.activeGenerationId) return
    this.triggerEvents.push(...structuredClone(events))
  }

  private async acceptPhysicsError(generationId: number, issue: { code: string; message: string }): Promise<void> {
    if (!this.active || generationId !== this.activeGenerationId || this.active.generationId !== generationId) return
    this.generationCounter += 1
    this.switching = false
    this.sceneChangeOwner = null
    const failure: WorldBehaviorIssue = { code: issue.code, path: 'physics.worker', message: issue.message }
    const pendingLoad = this.pendingLoad
    pendingLoad?.fail(new Error(issue.message), true)
    const prepared = [...(pendingLoad?.runtimes ?? [])]
    const retiring = pendingLoad?.retiring ?? null
    const active = this.active
    pendingLoad?.runtimes.clear()
    if (pendingLoad) pendingLoad.retiring = null
    this.pendingLoad = null
    this.pending = null
    this.active = null
    this.activeGenerationId = 0
    this.clock.pause()
    this.updateState({ lifecycle: 'stopping', failure, diagnostics: [...this.state.diagnostics, failure].slice(-128) })
    const owned = new Set<ActiveRuntimeScene>(prepared)
    owned.add(active)
    for (const runtime of owned) runtime.physics.dispose()
    retiring?.physics.dispose()
    if (retiring) this.initiateAudioStop(retiring.audio)
    for (const runtime of owned) this.initiateAudioStop(runtime.audio)
    const session = this.session
    if (!session) {
      this.updateState({ lifecycle: 'edit', sceneId: null, runtimeSnapshot: null, bodyPoses: [], animationRequests: [], failure })
      return
    }
    const stopping = transitionWorldPlaySession(session, 'stop')
    if (!stopping.success) {
      this.updateState({ lifecycle: 'edit', sceneId: null, runtimeSnapshot: null, bodyPoses: [], animationRequests: [], failure })
      return
    }
    const stopped = transitionWorldPlaySession(stopping.session, 'stopped')
    if (!stopped.success) {
      this.updateState({ lifecycle: 'edit', sceneId: null, runtimeSnapshot: null, bodyPoses: [], animationRequests: [], failure })
      return
    }
    this.session = stopped.session
    this.updateState({
      lifecycle: 'edit', generationId: this.generationCounter, sceneId: null, editor: stopped.session.editor,
      runtimeSnapshot: null, bodyPoses: [], animationRequests: [], failure,
    })
  }

  private async abortStart(failure: WorldPlayControllerState['failure']): Promise<void> {
    if (!this.session || this.state.lifecycle === 'stopping' || this.state.lifecycle === 'edit') return
    this.sceneChangeOwner = null
    const pendingLoad = this.pendingLoad
    pendingLoad?.fail(new Error('Runtime scene load was superseded.'), true)
    const prepared = [...(pendingLoad?.runtimes ?? [])]
    const retiring = pendingLoad?.retiring ?? null
    const active = this.active
    pendingLoad?.runtimes.clear()
    if (pendingLoad) pendingLoad.retiring = null
    this.pendingLoad = null
    this.pending = null
    this.active = null
    this.activeGenerationId = 0
    const owned = new Set<ActiveRuntimeScene>(prepared)
    if (active) owned.add(active)
    for (const runtime of owned) runtime.physics.dispose()
    retiring?.physics.dispose()
    if (retiring) this.initiateAudioStop(retiring.audio)
    for (const runtime of owned) this.initiateAudioStop(runtime.audio)
    const stopping = transitionWorldPlaySession(this.session, 'stop')
    if (!stopping.success) return
    const stopped = transitionWorldPlaySession(stopping.session, 'stopped')
    if (!stopped.success) return
    this.session = stopped.session
    this.updateState({
      lifecycle: 'edit', sceneId: null, runtimeSnapshot: null, editor: stopped.session.editor,
      bodyPoses: [], animationRequests: [], failure,
    })
  }

  private updateState(patch: Partial<WorldPlayControllerState>): void {
    this.state = sealState({ ...this.state, ...patch })
    for (const listener of this.listeners) listener()
  }
}

export function createWorldPlayController(dependencies: WorldPlayControllerDependencies): WorldPlayController {
  return new WorldPlayController(dependencies)
}

function preflightBehaviorCandidate(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  currentProjection?: WorldRuntimeSceneProjection,
): { success: true; projection: WorldRuntimeSceneProjection } | { success: false; issue: WorldBehaviorIssue | WorldRuntimeProjectionIssue } {
  const plan = planWorldRuntimeScene(snapshot, sceneId)
  if (!plan.success) {
    return {
      success: false,
      issue: plan.issues.find((issue) => issue.code !== 'missing-scene-document')
        ?? plan.issues[0]
        ?? { code: 'runtime-scene-invalid', path: `scenes.${sceneId}`, message: 'The resulting runtime scene is invalid.' },
    }
  }
  const behavior = createWorldBehaviorRuntime(snapshot, sceneId)
  if (!behavior.success) {
    return {
      success: false,
      issue: behavior.issues[0]
        ?? { code: 'runtime-behavior-invalid', path: `scenes.${sceneId}`, message: 'The resulting Play behavior is invalid.' },
    }
  }
  if (scenePlanNeedsGeometry(plan.value)) {
    if (currentProjection?.sceneId === sceneId) return { success: true, projection: { ...currentProjection, worldPoses: plan.value.worldPoses } }
    return { success: true, projection: { ...plan.value, physics: { ...plan.value.physics, bodies: [] } } }
  }
  const projection = projectWorldRuntimeScene(snapshot, sceneId)
  if (!projection.success) {
    return { success: false, issue: projection.issues[0] ?? { code: 'runtime-scene-invalid', path: `scenes.${sceneId}`, message: 'The resulting runtime scene is invalid.' } }
  }
  return { success: true, projection: projection.value }
}

function scenePlanNeedsGeometry(plan: WorldRuntimeScenePlan): boolean {
  return plan.physics.bodies.some((body) => body.colliders.some((collider) => collider.shape.kind === 'convexHullSource' || collider.shape.kind === 'trimeshSource'))
}

function behaviorCandidateIssue(cause: WorldBehaviorIssue | WorldRuntimeProjectionIssue): WorldBehaviorIssue {
  return {
    code: 'runtime-behavior-state-invalid',
    path: cause.path,
    message: `Behavior transaction was rejected: ${cause.message}`,
  }
}

function projectCharacterInputs(scene: WorldPhysicsSceneDto, input: WorldRuntimeInputFrame): WorldPhysicsCharacterInput[] {
  return scene.bodies.flatMap((body): WorldPhysicsCharacterInput[] => {
    if (!body.controller) return []
    const moveState = input.actions[body.controller.moveActionId]
    const move: [number, number] = Array.isArray(moveState?.value) ? [...moveState.value] : [0, 0]
    const jump = body.controller.jumpActionId ? input.actions[body.controller.jumpActionId] : undefined
    return [{ entityId: body.entityId, move, jumpPressed: jump?.pressed ?? false }]
  })
}

function withoutInputEdges(input: WorldRuntimeInputFrame): WorldRuntimeInputFrame {
  const actions: Record<string, WorldRuntimeInputActionState> = Object.create(null)
  for (const [id, state] of Object.entries(input.actions)) actions[id] = { ...state, pressed: false, released: false }
  return { sequence: input.sequence, actions }
}

function withBufferedInputEdges(input: WorldRuntimeInputFrame, pressed: ReadonlySet<string>, released: ReadonlySet<string>): WorldRuntimeInputFrame {
  const actions: Record<string, WorldRuntimeInputActionState> = Object.create(null)
  for (const [id, state] of Object.entries(input.actions)) {
    actions[id] = { ...state, pressed: state.pressed || pressed.has(id), released: state.released || released.has(id) }
  }
  return { sequence: input.sequence, actions }
}

function setComponentProperty(component: WorldComponent, property: string, value: unknown): void {
  if (property.startsWith('material.') && component.type === 'renderable') {
    const key = property.slice('material.'.length)
    ;(component.material as unknown as Record<string, unknown>)[key] = structuredClone(value)
    return
  }
  ;(component as unknown as Record<string, unknown>)[property] = structuredClone(value)
}

function sealState(state: WorldPlayControllerState): WorldPlayControllerState {
  return Object.freeze({
    ...state,
    bodyPoses: Object.freeze(state.bodyPoses.map((pose) => Object.freeze(structuredClone(pose)))),
    animationRequests: Object.freeze(state.animationRequests.map((request) => Object.freeze({ ...request }))),
    diagnostics: Object.freeze(state.diagnostics.map((issue) => Object.freeze({ ...issue }))),
    failure: state.failure ? Object.freeze({ ...state.failure }) : null,
  })
}

function createPendingSceneLoad(geometryGenerationId: number): PendingSceneLoad {
  let rejectFailure: ((error: Error) => void) | null = null
  let failed = false
  const load: PendingSceneLoad = {
    abortController: new AbortController(),
    geometryGenerationId,
    runtimes: new Set(),
    retiring: null,
    failure: new Promise<never>((_resolve, reject) => { rejectFailure = reject }),
    cancelled: false,
    fail(error, cancelled) {
      if (cancelled) {
        load.cancelled = true
        load.abortController.abort()
      }
      if (failed) return
      failed = true
      rejectFailure?.(error)
      rejectFailure = null
    },
  }
  void load.failure.catch(() => undefined)
  return load
}

function waitForPendingSceneLoad<T>(load: PendingSceneLoad, work: Promise<T>): Promise<T> {
  return Promise.race([load.failure, work])
}

function prepareStartSceneChainFailure(code: string, message: string): WorldPlayControllerFailure {
  return { success: false, issues: [{ code, path: 'play', message }] }
}

async function stopWorldAudioAuthority(audio: WorldAudioAuthority): Promise<void> {
  await audio.stop()
}

function controllerFailure(code: string, message: string): WorldPlayControllerFailure {
  return { success: false, issues: [{ code, path: 'play', message }] }
}
