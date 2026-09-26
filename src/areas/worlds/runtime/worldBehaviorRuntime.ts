import {
  getWorldComponentPropertyRuntimeAuthority,
  isWorldComponentPropertyLiveInPlay,
  type WorldBehaviorAction,
  type WorldBehaviorBinding,
  type WorldBehaviorComponent,
  type WorldComponent,
  type WorldLivePropertyContext,
  type WorldTriggerComponent,
} from '../core/worldComponentRegistry.ts'
import type { WorldEntity, WorldProjectSnapshotV1, WorldResource } from '../core/worldModel.ts'
import type { WorldRuntimeInputFrame } from './worldInputRuntime.ts'
import type { WorldPhysicsTriggerEvent } from './worldPhysicsProtocol.ts'
import { resolveWorldRuntimeEffectiveEnabled } from './worldRuntimeEntityGraph.ts'

export interface WorldBehaviorIssue {
  code: string
  path: string
  message: string
}

export interface WorldBehaviorEffect {
  ownerEntityId: string
  componentId: string
  bindingId: string
  action: WorldBehaviorAction
}

type WorldSceneTransitionEffect = WorldBehaviorEffect & {
  action: Extract<WorldBehaviorAction, { type: 'change-scene' }>
}

export interface WorldBehaviorEvaluation {
  effects: WorldBehaviorEffect[]
  sceneTransition: {
    sceneId: string
    effect: WorldSceneTransitionEffect
  } | null
  diagnostics: WorldBehaviorIssue[]
}

interface RuntimeBinding {
  ownerEntityId: string
  componentId: string
  binding: WorldBehaviorBinding
}

export interface WorldBehaviorRuntimeCheckpoint {
  timerElapsed: readonly (readonly [string, number])[]
  completedTimers: readonly string[]
  completedTriggers: readonly string[]
  activeTriggerOverlaps: readonly string[]
}

export class WorldBehaviorRuntime {
  private readonly bindings: readonly RuntimeBinding[]
  private readonly triggers: ReadonlyMap<string, WorldTriggerComponent>
  private readonly timerElapsed = new Map<string, number>()
  private readonly completedTimers = new Set<string>()
  private readonly completedTriggers = new Set<string>()
  private readonly activeTriggerOverlaps = new Set<string>()

  constructor(bindings: readonly RuntimeBinding[], triggers: ReadonlyMap<string, WorldTriggerComponent>) {
    this.bindings = bindings
    this.triggers = triggers
  }

  createCheckpoint(): WorldBehaviorRuntimeCheckpoint {
    return {
      timerElapsed: [...this.timerElapsed.entries()].map(([key, elapsed]) => [key, elapsed] as const),
      completedTimers: [...this.completedTimers],
      completedTriggers: [...this.completedTriggers],
      activeTriggerOverlaps: [...this.activeTriggerOverlaps],
    }
  }

  restoreCheckpoint(checkpoint: WorldBehaviorRuntimeCheckpoint): void {
    this.timerElapsed.clear()
    this.completedTimers.clear()
    this.completedTriggers.clear()
    this.activeTriggerOverlaps.clear()
    for (const [key, elapsed] of checkpoint.timerElapsed) this.timerElapsed.set(key, elapsed)
    for (const key of checkpoint.completedTimers) this.completedTimers.add(key)
    for (const key of checkpoint.completedTriggers) this.completedTriggers.add(key)
    for (const key of checkpoint.activeTriggerOverlaps) this.activeTriggerOverlaps.add(key)
  }

  start(): WorldBehaviorEvaluation {
    return this.evaluate(this.bindings.filter(({ binding }) => binding.event.type === 'start'))
  }

  step(deltaSeconds: number, input: WorldRuntimeInputFrame, triggerEvents: readonly WorldPhysicsTriggerEvent[]): WorldBehaviorEvaluation {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new TypeError('Behavior delta must be a finite non-negative number.')
    const ready: RuntimeBinding[] = []
    for (const event of triggerEvents) {
      if (event.type !== 'exit') continue
      const suffix = triggerOverlapSuffix(event.triggerComponentId, event.otherEntityId)
      for (const key of this.activeTriggerOverlaps) {
        if (key.endsWith(suffix)) this.activeTriggerOverlaps.delete(key)
      }
    }
    for (const runtimeBinding of this.bindings) {
      const event = runtimeBinding.binding.event
      if (event.type === 'input') {
        const state = input.actions[event.actionId]
        if (state && state[event.phase]) ready.push(runtimeBinding)
      } else if (event.type === 'timer') {
        const key = bindingKey(runtimeBinding)
        if (this.completedTimers.has(key)) continue
        const elapsed = (this.timerElapsed.get(key) ?? 0) + deltaSeconds
        if (elapsed + 1e-12 < event.delaySeconds) {
          this.timerElapsed.set(key, elapsed)
          continue
        }
        ready.push(runtimeBinding)
        if (event.repeat) this.timerElapsed.set(key, elapsed % event.delaySeconds)
        else {
          this.timerElapsed.delete(key)
          this.completedTimers.add(key)
        }
      } else if (event.type === 'trigger-enter' || event.type === 'trigger-exit') {
        const trigger = this.triggers.get(event.triggerComponentId)
        if (!trigger) continue
        const key = bindingKey(runtimeBinding)
        if (trigger.once && this.completedTriggers.has(key)) continue
        const expectedType = event.type === 'trigger-enter' ? 'enter' : 'exit'
        const matched = triggerEvents.find((candidate) => candidate.type === expectedType
          && candidate.triggerComponentId === event.triggerComponentId
          && trigger.targetTags.every((tag) => candidate.otherTags.includes(tag)))
        if (!matched) continue
        const overlapKey = triggerOverlapKey(runtimeBinding, event.triggerComponentId, matched.otherEntityId)
        if (event.type === 'trigger-enter') {
          if (this.activeTriggerOverlaps.has(overlapKey)) continue
          this.activeTriggerOverlaps.add(overlapKey)
        } else {
          this.activeTriggerOverlaps.delete(overlapKey)
        }
        ready.push(runtimeBinding)
        if (trigger.once) this.completedTriggers.add(key)
      }
    }
    return this.evaluate(ready)
  }

  private evaluate(ready: readonly RuntimeBinding[]): WorldBehaviorEvaluation {
    const effects: WorldBehaviorEffect[] = []
    const diagnostics: WorldBehaviorIssue[] = []
    let sceneTransition: WorldBehaviorEvaluation['sceneTransition'] = null
    for (const runtimeBinding of ready) {
      for (const action of runtimeBinding.binding.actions) {
        const effect: WorldBehaviorEffect = {
          ownerEntityId: runtimeBinding.ownerEntityId,
          componentId: runtimeBinding.componentId,
          bindingId: runtimeBinding.binding.id,
          action: structuredClone(action),
        }
        if (action.type === 'change-scene') {
          if (sceneTransition) {
            diagnostics.push({
              code: 'scene-transition-superseded',
              path: `behaviors.${runtimeBinding.componentId}.${runtimeBinding.binding.id}`,
              message: `Scene transition to ${action.sceneId} was superseded by the first transition in this step.`,
            })
            continue
          }
          sceneTransition = {
            sceneId: action.sceneId,
            effect: effect as WorldSceneTransitionEffect,
          }
        }
        effects.push(effect)
      }
    }
    return { effects, sceneTransition, diagnostics }
  }
}

export type CreateWorldBehaviorRuntimeResult =
  | { success: true; runtime: WorldBehaviorRuntime }
  | { success: false; issues: WorldBehaviorIssue[] }

export interface WorldStartTransitionChain {
  entrySceneId: string
  sceneIds: readonly string[]
}

export type ValidateWorldStartTransitionGraphResult =
  | { success: true; chains: readonly WorldStartTransitionChain[] }
  | { success: false; issues: WorldBehaviorIssue[] }

export function validateWorldStartTransitionGraph(
  snapshot: WorldProjectSnapshotV1,
  entrySceneIds: readonly string[],
): ValidateWorldStartTransitionGraphResult {
  const chains: WorldStartTransitionChain[] = []
  for (const entrySceneId of entrySceneIds) {
    const sceneIds: string[] = []
    let sceneId = entrySceneId
    while (true) {
      const behavior = createWorldBehaviorRuntime(snapshot, sceneId)
      if (!behavior.success) return behavior
      sceneIds.push(sceneId)
      const transition = behavior.runtime.start().sceneTransition
      if (!transition) break
      if (sceneIds.includes(transition.sceneId)) {
        return {
          success: false,
          issues: [{
            code: 'runtime-start-transition-cycle',
            path: `scenes.${sceneId}.behaviors.${transition.effect.componentId}.${transition.effect.bindingId}.actions`,
            message: `Start behavior created a scene transition cycle at ${transition.sceneId}.`,
          }],
        }
      }
      sceneId = transition.sceneId
    }
    chains.push({ entrySceneId, sceneIds })
  }
  return { success: true, chains }
}

export function createWorldBehaviorRuntime(snapshot: WorldProjectSnapshotV1, sceneId: string): CreateWorldBehaviorRuntimeResult {
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  if (!scene) return failure('scene-missing', 'sceneId', `Scene ${sceneId} does not exist.`)
  const bindings: RuntimeBinding[] = []
  const triggers = new Map<string, WorldTriggerComponent>()
  const issues: WorldBehaviorIssue[] = []
  const effectiveEnabled = resolveWorldRuntimeEffectiveEnabled(scene.entities)
  const resourcesById = new Map(snapshot.project.resources.map((resource) => [resource.id, resource]))
  const inputActionsById = new Map(snapshot.project.inputActions.map((action) => [action.id, action]))
  const sceneIds = new Set(snapshot.project.scenes.map((scene) => scene.id))
  for (const [entityIndex, entity] of scene.entities.entries()) {
    const entityIsActive = effectiveEnabled.get(entity.id) === true
    for (const [componentIndex, component] of entity.components.entries()) {
      if (component.type === 'trigger' && entityIsActive && component.enabled) {
        triggers.set(component.id, structuredClone(component))
      }
      if (component.type !== 'behavior') continue
      collectBehaviorBindings(
        component,
        entity.id,
        entityIndex,
        componentIndex,
        scene.entities,
        resourcesById,
        inputActionsById,
        sceneIds,
        entityIsActive && component.enabled ? bindings : null,
        issues,
      )
    }
  }
  return issues.length > 0 ? { success: false, issues } : { success: true, runtime: new WorldBehaviorRuntime(bindings, triggers) }
}

function collectBehaviorBindings(
  component: WorldBehaviorComponent,
  ownerEntityId: string,
  entityIndex: number,
  componentIndex: number,
  entities: readonly WorldEntity[],
  resourcesById: ReadonlyMap<string, WorldResource>,
  inputActionsById: ReadonlyMap<string, WorldProjectSnapshotV1['project']['inputActions'][number]>,
  sceneIds: ReadonlySet<string>,
  output: RuntimeBinding[] | null,
  issues: WorldBehaviorIssue[],
): void {
  for (const [bindingIndex, binding] of component.bindings.entries()) {
    const path = `scenes.entities[${entityIndex}].components[${componentIndex}].bindings[${bindingIndex}]`
    if (binding.event.type === 'sequence-event') {
      issues.push({ code: 'unsupported-behavior-event', path: `${path}.event`, message: 'Sequence events are not supported by the Play runtime yet.' })
      continue
    }
    let rejected = false
    if (binding.event.type === 'input') {
      const inputAction = inputActionsById.get(binding.event.actionId)
      if (!inputAction || inputAction.valueType !== 'button') {
        issues.push({ code: 'runtime-input-action-missing', path: `${path}.event.actionId`, message: `Input action ${binding.event.actionId} is unavailable for Play.` })
        rejected = true
      }
    }
    for (const [actionIndex, candidate] of (binding.actions as readonly unknown[]).entries()) {
      const actionPath = `${path}.actions[${actionIndex}]`
      if (!isSupportedAction(candidate)) {
        issues.push({ code: 'unsupported-behavior-action', path: actionPath, message: 'Behavior contains an unsupported Play action.' })
        rejected = true
        continue
      }
      if (candidate.type === 'change-scene') {
        if (!sceneIds.has(candidate.sceneId)) {
          issues.push({
            code: 'runtime-scene-target-missing',
            path: `${actionPath}.sceneId`,
            message: `Scene target ${candidate.sceneId} is unavailable for Play.`,
          })
          rejected = true
        }
        continue
      }
      if (candidate.type === 'play-audio' || candidate.type === 'stop-audio') {
        const audioEntity = entities.find((entity) => entity.id === candidate.entityId)
        const audioComponent = audioEntity?.components.find((component) => component.id === candidate.componentId)
        if (!audioEntity || audioComponent?.type !== 'audio-source' || !audioEntity.enabled || !audioComponent.enabled) {
          issues.push({
            code: 'runtime-audio-source-missing',
            path: `${actionPath}.componentId`,
            message: `Audio source ${candidate.entityId}/${candidate.componentId} is unavailable for Play.`,
          })
          rejected = true
        }
        continue
      }
      if (candidate.type !== 'set-component-property') continue
      const targetEntity = entities.find((entity) => entity.id === candidate.entityId)
      const targetComponent = targetEntity?.components.find((component) => component.id === candidate.componentId)
      if (!targetEntity || !targetComponent || targetComponent.type !== candidate.componentType) {
        issues.push({
          code: 'runtime-property-target-invalid',
          path: `${actionPath}.componentId`,
          message: `Play property target ${candidate.entityId}/${candidate.componentId}.${candidate.property} is unavailable.`,
        })
        rejected = true
        continue
      }
      const authority = getWorldComponentPropertyRuntimeAuthority(targetComponent, candidate.property, candidate.value)
      if (!authority) {
        issues.push({
          code: 'runtime-property-invalid',
          path: `${actionPath}.property`,
          message: `Play property ${candidate.entityId}/${candidate.componentId}.${candidate.property} is not canonically writable.`,
        })
        rejected = true
        continue
      }
      if (authority !== 'presentation') {
        issues.push({
          code: 'runtime-property-authority-unsupported',
          path: `${actionPath}.property`,
          message: `Play cannot update ${candidate.entityId}/${candidate.componentId}.${candidate.property} live because ${candidate.componentType} is owned by the ${authority} runtime.`,
        })
        rejected = true
        continue
      }
      const liveContext = resolveLivePropertyContext(targetEntity, targetComponent, resourcesById)
      if (!isWorldComponentPropertyLiveInPlay(targetComponent, candidate.property, candidate.value, liveContext)) {
        const formats = [
          ...(liveContext.modelFormat ? [`model format ${liveContext.modelFormat}`] : []),
          ...(liveContext.animationFormat ? [`animation format ${liveContext.animationFormat}`] : []),
        ]
        issues.push({
          code: 'runtime-property-presentation-unsupported',
          path: `${actionPath}.property`,
          message: `Play cannot update ${candidate.entityId}/${candidate.componentId}.${candidate.property} live${formats.length > 0 ? ` for ${formats.join(' and ')}` : ' in this release'}.`,
        })
        rejected = true
      }
    }
    if (rejected) continue
    output?.push({ ownerEntityId, componentId: component.id, binding: structuredClone(binding) })
  }
}

function resolveLivePropertyContext(
  entity: WorldEntity,
  component: WorldComponent,
  resourcesById: ReadonlyMap<string, WorldResource>,
): WorldLivePropertyContext {
  if (component.type === 'renderable') {
    const resource = resourcesById.get(component.resourceId)
    return resource?.type === 'model' ? { modelFormat: resource.format } : {}
  }
  if (component.type === 'animation-player') {
    const renderable = entity.components.find((candidate) => candidate.type === 'renderable')
    const modelResource = renderable?.type === 'renderable' ? resourcesById.get(renderable.resourceId) : undefined
    const animationResource = resourcesById.get(component.resourceId)
    return {
      ...(modelResource?.type === 'model' ? { modelFormat: modelResource.format } : {}),
      ...(animationResource?.type === 'animation' ? { animationFormat: animationResource.format } : {}),
    }
  }
  return {}
}

function isSupportedAction(value: unknown): value is WorldBehaviorAction {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const type = (value as { type?: unknown }).type
  return type === 'set-visibility' || type === 'set-component-property' || type === 'play-animation'
    || type === 'play-audio' || type === 'stop-audio' || type === 'apply-impulse' || type === 'change-scene'
}

function bindingKey(binding: RuntimeBinding): string {
  return `${binding.componentId}\0${binding.binding.id}`
}

function triggerOverlapKey(binding: RuntimeBinding, triggerComponentId: string, otherEntityId: string): string {
  return `${bindingKey(binding)}${triggerOverlapSuffix(triggerComponentId, otherEntityId)}`
}

function triggerOverlapSuffix(triggerComponentId: string, otherEntityId: string): string {
  return `\0${triggerComponentId}\0${otherEntityId}`
}

function failure(code: string, path: string, message: string): CreateWorldBehaviorRuntimeResult {
  return { success: false, issues: [{ code, path, message }] }
}
