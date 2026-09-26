import {
  collectWorldComponentReferences,
  getWorldComponentDefinition,
  isWorldComponentPropertyLiveInPlay,
  parseWorldComponent,
  type WorldBehaviorAction,
  type WorldBehaviorEvent,
  type WorldComponent,
  type WorldComponentType,
  type WorldLivePropertyContext,
  type WorldWritableValue,
} from '../core/worldComponentRegistry.ts'
import { applyWorldCommandBatch, type WorldCommand } from '../core/worldCommands.ts'
import { normalizeWorldWorkspacePath } from '../core/worldDocuments.ts'
import {
  isWorldGltfAnimationResourceBoundToModel,
  type WorldAnimationResource,
  type WorldAudioResource,
  type WorldEntity,
  type WorldInputAction,
  type WorldInputBinding,
  type WorldModelResource,
  type WorldProjectSnapshotV1,
  type WorldSceneDocumentV1,
} from '../core/worldModel.ts'
import type { WorldEditorBuilderContext, WorldEditorIdentityGenerator } from './worldEditorCommandBuilders.ts'
import { WorldEditorCommandBuilderError } from './worldEditorCommandBuilders.ts'
import { validateWorldStartTransitionGraph } from '../runtime/worldBehaviorRuntime.ts'

export type WorldComponentPreset =
  | 'box-collider'
  | 'dynamic-body'
  | 'fixed-body'
  | 'character'
  | 'trigger'
  | 'audio-listener'
  | 'behavior'

export type WorldBehaviorAuthoringEventType = Exclude<WorldBehaviorEvent['type'], 'sequence-event'>
export type WorldBehaviorAuthoringActionType = WorldBehaviorAction['type']
export type WorldPrimitiveColliderShape = 'box' | 'sphere' | 'capsule'
export type WorldAdvancedColliderShape = 'convex' | 'mesh'
export type WorldAuthoredColliderShape = WorldPrimitiveColliderShape | WorldAdvancedColliderShape

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function replaceControlCharacters(value: string, replacement: string): string {
  let sanitized = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    sanitized += code <= 0x1f || code === 0x7f ? replacement : value[index]
  }
  return sanitized
}

export interface WorldLivePropertyTarget {
  entityId: string
  entityName: string
  componentId: string
  componentType: WorldComponentType
  componentLabel: string
  property: string
  value: WorldWritableValue
}

/** Transient scalar copies only; loaded Three objects and URLs never enter the document. */
export interface WorldGltfClipDescriptor {
  clipIndex: number
  name: string
  durationSeconds: number
  trackCount: number
  available: boolean
}

export interface WorldGltfAnimationOwner {
  projectKey: string
  projectId: string
  baseRevision: number
  sceneId: string
  entityId: string
  modelResourceId: string
  modelWorkspacePath: string
}

export type WorldGltfAnimationSelection =
  | { kind: 'clip'; clip: WorldGltfClipDescriptor; resourceId?: string }
  | { kind: 'resource'; resourceId: string }

export function describeWorldGltfAnimationClips(clips: readonly {
  readonly name: string
  readonly duration: number
  readonly tracks: readonly unknown[]
  validate(): boolean
}[]): WorldGltfClipDescriptor[] {
  return clips.map((clip, clipIndex) => {
    let valid = false
    try { valid = clip.validate() } catch { /* Invalid loaded tracks are unavailable, not repaired. */ }
    return {
      clipIndex, name: typeof clip.name === 'string' ? clip.name : '', durationSeconds: clip.duration, trackCount: clip.tracks.length,
      available: typeof clip.name === 'string' && valid && Number.isFinite(clip.duration) && clip.duration >= 0 && clip.tracks.length > 0,
    }
  })
}

export function getWorldGltfAnimationModel(snapshot: WorldProjectSnapshotV1, sceneId: string, entityId: string): WorldModelResource | null {
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  const entity = scene?.entities.find((candidate) => candidate.id === entityId)
  if (!scene || !entity) return null
  const visited = new Set<string>()
  let current: WorldEntity | undefined = entity
  while (current) {
    if (!current.enabled || visited.has(current.id)) return null
    visited.add(current.id)
    const parentId: string | null = current.parentId
    current = parentId ? scene.entities.find((candidate) => candidate.id === parentId) : undefined
  }
  const renderables = entity.components.filter((component) => component.type === 'renderable')
  if (renderables.length !== 1 || !renderables[0].enabled) return null
  const model = snapshot.project.resources.find((resource) => resource.id === renderables[0].resourceId)
  return model?.type === 'model' && (model.format === 'glb' || model.format === 'gltf')
    && normalizeWorldWorkspacePath(model.workspacePath) === model.workspacePath ? model : null
}

export function captureWorldGltfAnimationOwner(context: WorldEditorBuilderContext, entityId: string): WorldGltfAnimationOwner {
  const scene = requireActiveScene(context)
  requireEditableEntity(scene, entityId)
  const model = getWorldGltfAnimationModel(context.snapshot, scene.sceneId, entityId)
  if (!model) throw new WorldEditorCommandBuilderError('animation-model', 'Select an enabled GLB or GLTF model.')
  return {
    projectKey: context.projectKey, projectId: context.snapshot.project.projectId,
    baseRevision: context.snapshot.project.revision, sceneId: scene.sceneId, entityId,
    modelResourceId: model.id, modelWorkspacePath: model.workspacePath,
  }
}

export function getCompatibleWorldGltfAnimationResources(snapshot: WorldProjectSnapshotV1, sceneId: string, entityId: string): WorldAnimationResource[] {
  const model = getWorldGltfAnimationModel(snapshot, sceneId, entityId)
  return model ? snapshot.project.resources.filter((resource): resource is WorldAnimationResource => resource.type === 'animation' && isWorldGltfAnimationResourceBoundToModel(resource, model)) : []
}

/** Creates/reuses a shared resource, then optionally adds or replaces the whole player atomically. */
export function buildWorldGltfAnimationCommands(
  context: WorldEditorBuilderContext,
  owner: WorldGltfAnimationOwner,
  selection: WorldGltfAnimationSelection,
  operation: 'create' | 'add' | 'rebind',
): WorldCommand[] {
  const current = captureWorldGltfAnimationOwner(context, owner.entityId)
  if (Object.keys(current).some((key) => current[key as keyof WorldGltfAnimationOwner] !== owner[key as keyof WorldGltfAnimationOwner])) {
    throw new WorldEditorCommandBuilderError('animation-stale', 'Animation selection is no longer current.')
  }
  const scene = requireActiveScene(context)
  const entity = requireEditableEntity(scene, owner.entityId)
  const players = entity.components.filter((component) => component.type === 'animation-player')
  if (players.length > 1 || (operation === 'add' && players.length > 0)) throw new WorldEditorCommandBuilderError('component-cardinality', 'Entity already has an animation player.')
  if (operation === 'rebind' && players.length !== 1) throw new WorldEditorCommandBuilderError('component-missing', 'Add an animation player first.')
  const resources = getCompatibleWorldGltfAnimationResources(context.snapshot, scene.sceneId, entity.id)
  const used = collectIds(context.snapshot)
  const commands: WorldCommand[] = []
  let resource: WorldAnimationResource | undefined
  if (selection.kind === 'resource') {
    resource = resources.find((candidate) => candidate.id === selection.resourceId)
    if (!resource) throw new WorldEditorCommandBuilderError('animation-resource', 'Choose an animation bound to this model.')
  } else {
    const clip = selection.clip
    if (!clip.available || !Number.isSafeInteger(clip.clipIndex) || clip.clipIndex < 0 || typeof clip.name !== 'string'
      || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds < 0 || !Number.isSafeInteger(clip.trackCount) || clip.trackCount <= 0) {
      throw new WorldEditorCommandBuilderError('animation-clip', 'This animation clip is unavailable.')
    }
    const clipName = clip.name.length > 0 && clip.name.length <= 256 && clip.name.trim() === clip.name && !hasControlCharacter(clip.name) ? clip.name : undefined
    const equivalent = resources.filter((candidate) => candidate.clipIndex === clip.clipIndex && (candidate.clipName === undefined || candidate.clipName === clipName))
    if (selection.resourceId) {
      resource = equivalent.find((candidate) => candidate.id === selection.resourceId)
      if (!resource) throw new WorldEditorCommandBuilderError('animation-resource', 'Choose an existing animation for this exact clip.')
    } else {
      if (equivalent.length > 1) throw new WorldEditorCommandBuilderError('animation-ambiguous', 'Choose an existing animation explicitly.')
      resource = equivalent[0]
    }
    if (!resource) {
      const displayName = replaceControlCharacters(clip.name, ' ').trim().slice(0, 256) || `Clip ${clip.clipIndex + 1}`
      resource = {
        id: allocateId(context.identities, used, 'resource', `gltf-clip:${owner.modelResourceId}:${clip.clipIndex}`),
        type: 'animation', name: displayName, workspacePath: owner.modelWorkspacePath, format: 'gltf-clip', clipIndex: clip.clipIndex,
        ...(clipName === undefined ? {} : { clipName }),
        ...(clip.durationSeconds > 0 && clip.durationSeconds <= 86400 ? { durationSeconds: clip.durationSeconds } : {}),
      }
      commands.push({ type: 'add-resource', resource })
    }
  }
  if (operation === 'add') {
    commands.push({ type: 'add-component', sceneId: scene.sceneId, entityId: entity.id, component: {
      id: allocateId(context.identities, used, 'component', `animation-player:${entity.id}:${resource.id}`),
      type: 'animation-player', enabled: true, resourceId: resource.id, autoplay: false, loop: true, speed: 1,
    } })
  } else if (operation === 'rebind' && players[0].resourceId !== resource.id) {
    commands.push({ type: 'replace-component', sceneId: scene.sceneId, entityId: entity.id, componentId: players[0].id,
      component: { ...structuredClone(players[0]), resourceId: resource.id },
    })
  }
  if (commands.length > 0) validateCommandPlan(context.snapshot, commands)
  return commands
}

export function buildAddEmptyEntityCommands(
  context: WorldEditorBuilderContext,
  options: { name: string; parentId?: string | null },
): [Extract<WorldCommand, { type: 'add-entity' }>] {
  const scene = requireActiveScene(context)
  const parentId = options.parentId ?? null
  if (parentId && !scene.entities.some((entity) => entity.id === parentId)) {
    throw new WorldEditorCommandBuilderError('parent-missing', `Parent entity ${parentId} does not exist.`)
  }
  const name = requiredName(options.name)
  const used = collectIds(context.snapshot)
  const entityId = allocateId(context.identities, used, 'entity', `${scene.sceneId}:empty:${name}`)
  return [{
    type: 'add-entity',
    sceneId: scene.sceneId,
    entity: {
      id: entityId,
      name,
      parentId,
      enabled: true,
      locked: false,
      tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [],
    },
  }]
}

export function buildComponentPresetCommands(
  context: WorldEditorBuilderContext,
  entityId: string,
  preset: WorldComponentPreset,
): WorldCommand[] {
  if (preset === 'character') return buildCharacterControllerPresetCommands(context, entityId)
  const scene = requireActiveScene(context)
  const entity = requireEntity(scene, entityId)
  const used = collectIds(context.snapshot)
  const commands: WorldCommand[] = []
  const add = (component: WorldComponent) => commands.push({ type: 'add-component', sceneId: scene.sceneId, entityId, component })
  const nextComponentId = (hint: string) => allocateId(context.identities, used, 'component', `${scene.sceneId}:${entityId}:${hint}`)

  if (preset === 'box-collider') {
    add(createBoxCollider(nextComponentId('box-collider'), false))
  } else if (preset === 'dynamic-body' || preset === 'fixed-body') {
    if (entity.components.some((component) => component.type === 'rigid-body')) {
      throw new WorldEditorCommandBuilderError('component-cardinality', 'Entity already has a rigid body.')
    }
    assertRigidBodyAuthoringCompatible(entity, { enabled: true, bodyType: preset === 'dynamic-body' ? 'dynamic' : 'fixed' })
    const compatibleCollider = entity.components.find((component) => isReusableBodyPresetCollider(component, preset === 'dynamic-body' ? 'dynamic' : 'fixed'))
    if (!compatibleCollider) add(createBoxCollider(nextComponentId(`${preset}-collider`), false))
    add({
      id: nextComponentId(preset), type: 'rigid-body', enabled: true,
      bodyType: preset === 'dynamic-body' ? 'dynamic' : 'fixed',
      gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: true,
    })
  } else if (preset === 'trigger') {
    const colliderId = nextComponentId('trigger-sensor')
    add(createBoxCollider(colliderId, true))
    add({ id: nextComponentId('trigger'), type: 'trigger', enabled: true, colliderComponentId: colliderId, once: false, targetTags: [] })
  } else if (preset === 'audio-listener') {
    if (entity.components.some((component) => component.type === 'audio-listener')) {
      throw new WorldEditorCommandBuilderError('component-cardinality', 'Entity already has an audio listener.')
    }
    const hasPrimary = scene.entities.some((candidate) => candidate.enabled && candidate.components.some((component) => component.type === 'audio-listener' && component.enabled && component.primary))
    add({ id: nextComponentId('audio-listener'), type: 'audio-listener', enabled: true, primary: !hasPrimary })
  } else {
    add({ id: nextComponentId('behavior'), type: 'behavior', enabled: true, bindings: [] })
  }

  validateCommandPlan(context.snapshot, commands)
  return commands
}

export function buildAddPrimitiveColliderCommands(
  context: WorldEditorBuilderContext,
  entityId: string,
  options: { shape: WorldPrimitiveColliderShape; sensor?: boolean },
): [Extract<WorldCommand, { type: 'add-component' }>] {
  const scene = requireActiveScene(context)
  requireEditableEntity(scene, entityId)
  const used = collectIds(context.snapshot)
  const component = createPrimitiveCollider(
    allocateId(context.identities, used, 'component', `${scene.sceneId}:${entityId}:${options.shape}-collider`),
    options.shape,
    options.sensor ?? false,
  )
  const commands: [Extract<WorldCommand, { type: 'add-component' }>] = [{ type: 'add-component', sceneId: scene.sceneId, entityId, component }]
  validateCommandPlan(context.snapshot, commands)
  return commands
}

export function getEligibleWorldColliderSourceResources(snapshot: WorldProjectSnapshotV1): WorldModelResource[] {
  return snapshot.project.resources.filter((resource): resource is WorldModelResource => isEligibleWorldColliderSourceResource(resource))
}

export function resolveDefaultWorldColliderSourceResourceId(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityId: string,
): string | null {
  const scene = requireScene(snapshot, sceneId)
  const entity = requireEntity(scene, entityId)
  const renderable = entity.components.find((component) => component.type === 'renderable')
  if (!renderable) return null
  return isEligibleWorldColliderSourceResource(snapshot.project.resources.find((resource) => resource.id === renderable.resourceId))
    ? renderable.resourceId
    : null
}

export function buildAddAdvancedColliderCommands(
  context: WorldEditorBuilderContext,
  entityId: string,
  options: { shape: WorldAdvancedColliderShape; resourceId: string; sensor?: boolean },
): [Extract<WorldCommand, { type: 'add-component' }>] {
  const scene = requireActiveScene(context)
  const entity = requireEditableEntity(scene, entityId)
  assertEligibleWorldColliderSource(context.snapshot, options.resourceId)
  const used = collectIds(context.snapshot)
  const component = createAdvancedCollider(
    allocateId(context.identities, used, 'component', `${scene.sceneId}:${entityId}:${options.shape}-collider`),
    options.shape,
    options.resourceId,
    options.sensor ?? false,
  )
  assertColliderAuthoringCompatible(entity, component)
  const commands: [Extract<WorldCommand, { type: 'add-component' }>] = [{ type: 'add-component', sceneId: scene.sceneId, entityId, component }]
  validateCommandPlan(context.snapshot, commands)
  return commands
}

export function replaceWorldColliderComponent(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityId: string,
  componentId: string,
  patch: Partial<Pick<Extract<WorldComponent, { type: 'collider' }>, 'enabled' | 'purpose' | 'shape' | 'sensor' | 'friction' | 'restitution' | 'collisionLayer' | 'collisionMask'>> & {
    halfExtents?: [number, number, number]
    radius?: number
    halfHeight?: number
    resourceId?: string
  },
): [Extract<WorldCommand, { type: 'replace-component' }>] {
  const scene = requireScene(snapshot, sceneId)
  requireEditableEntity(scene, entityId)
  const entity = requireEntity(scene, entityId)
  const component = entity.components.find((candidate) => candidate.id === componentId)
  if (component?.type !== 'collider') throw new WorldEditorCommandBuilderError('component-missing', `Collider ${componentId} does not exist on ${entityId}.`)
  const shape = patch.shape ?? component.shape
  if (!isAuthoredWorldColliderShape(shape)) {
    throw new WorldEditorCommandBuilderError('collider-shape', 'Legacy navigation colliders are view only.')
  }
  const common = {
    id: component.id,
    type: 'collider' as const,
    enabled: patch.enabled ?? component.enabled,
    purpose: patch.purpose ?? component.purpose,
    sensor: patch.sensor ?? component.sensor,
    friction: patch.friction ?? component.friction,
    restitution: patch.restitution ?? component.restitution,
    ...(patch.collisionLayer !== undefined || component.collisionLayer !== undefined ? { collisionLayer: patch.collisionLayer ?? component.collisionLayer } : {}),
    ...(patch.collisionMask !== undefined || component.collisionMask !== undefined ? { collisionMask: patch.collisionMask ?? component.collisionMask } : {}),
  }
  let replacement: Extract<WorldComponent, { type: 'collider' }>
  if (shape === 'box') {
    replacement = { ...common, shape, halfExtents: patch.halfExtents ?? defaultBoxHalfExtents(component) }
  } else if (shape === 'sphere') {
    replacement = { ...common, shape, radius: patch.radius ?? defaultSphereRadius(component) }
  } else if (shape === 'capsule') {
    replacement = {
      ...common,
      shape,
      radius: patch.radius ?? defaultCapsuleRadius(component),
      halfHeight: patch.halfHeight ?? defaultCapsuleHalfHeight(component),
    }
  } else {
    const resourceId = patch.resourceId ?? (component.shape === 'convex' || component.shape === 'mesh' ? component.resourceId : undefined)
    if (!resourceId) throw new WorldEditorCommandBuilderError('collider-resource', 'Choose a mesh source for this collider.')
    assertEligibleWorldColliderSource(snapshot, resourceId)
    replacement = { ...common, shape, resourceId }
  }
  assertColliderAuthoringCompatible(entity, replacement, component.id)
  const parsed = parseWorldComponent(replacement)
  if (!parsed.success || parsed.value.type !== 'collider') {
    throw new WorldEditorCommandBuilderError(parsed.success ? 'collider' : (parsed.issues[0]?.code ?? 'collider'), parsed.success ? 'Collider is invalid.' : (parsed.issues[0]?.message ?? 'Collider is invalid.'))
  }
  const commands: [Extract<WorldCommand, { type: 'replace-component' }>] = [{ type: 'replace-component', sceneId, entityId, componentId, component: parsed.value }]
  validateCommandPlan(snapshot, commands)
  return commands
}

export function replaceWorldRigidBodyComponent(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityId: string,
  componentId: string,
  patch: Partial<Pick<Extract<WorldComponent, { type: 'rigid-body' }>, 'enabled' | 'bodyType' | 'gravityScale' | 'linearDamping' | 'angularDamping' | 'canSleep'>>,
): [Extract<WorldCommand, { type: 'replace-component' }>] {
  const scene = requireScene(snapshot, sceneId)
  requireEditableEntity(scene, entityId)
  const entity = requireEntity(scene, entityId)
  const component = entity.components.find((candidate) => candidate.id === componentId)
  if (component?.type !== 'rigid-body') throw new WorldEditorCommandBuilderError('component-missing', `Rigid body ${componentId} does not exist on ${entityId}.`)
  const replacement: Extract<WorldComponent, { type: 'rigid-body' }> = {
    ...structuredClone(component),
    ...patch,
  }
  assertRigidBodyAuthoringCompatible(entity, replacement)
  const parsed = parseWorldComponent(replacement)
  if (!parsed.success || parsed.value.type !== 'rigid-body') {
    throw new WorldEditorCommandBuilderError(parsed.success ? 'rigid-body' : (parsed.issues[0]?.code ?? 'rigid-body'), parsed.success ? 'Rigid body is invalid.' : (parsed.issues[0]?.message ?? 'Rigid body is invalid.'))
  }
  const commands: [Extract<WorldCommand, { type: 'replace-component' }>] = [{ type: 'replace-component', sceneId, entityId, componentId, component: parsed.value }]
  validateCommandPlan(snapshot, commands)
  return commands
}

export interface WorldCharacterPresetInputs {
  /** Omit to create a new WASD action; never infer authority from an action name. */
  moveActionId?: string
  /** Omit to create a new Space action; null explicitly disables jumping. */
  jumpActionId?: string | null
}

export function buildCharacterControllerPresetCommands(
  context: WorldEditorBuilderContext,
  entityId: string,
  inputs: WorldCharacterPresetInputs = {},
): WorldCommand[] {
  const scene = requireActiveScene(context)
  const entity = requireEntity(scene, entityId)
  if (entity.components.some((component) => component.type === 'character-controller')) {
    throw new WorldEditorCommandBuilderError('component-cardinality', 'Entity already has a character controller.')
  }
  const body = entity.components.find((component) => component.type === 'rigid-body')
  if (body && (!body.enabled || body.bodyType !== 'kinematic-position')) {
    throw new WorldEditorCommandBuilderError('controller-body', 'Enable the existing body and set its type to Kinematic position before adding Character.')
  }
  const used = collectIds(context.snapshot)
  const actions = structuredClone(context.snapshot.project.inputActions)
  const resolveInput = (id: string | undefined, valueType: 'axis2d' | 'button', name: string): string => {
    if (id !== undefined) {
      const action = actions.find((candidate) => candidate.id === id)
      if (!action || action.valueType !== valueType) {
        throw new WorldEditorCommandBuilderError('input-action-kind', `${name} input must reference an existing ${valueType} action.`)
      }
      return action.id
    }
    const action: WorldInputAction = {
      id: allocateId(context.identities, used, 'input', `${entityId}:${name}`),
      name: uniqueInputName(actions, name), valueType,
      bindings: valueType === 'axis2d' ? createWasdBindings() : [{ kind: 'button', device: 'keyboard', control: 'Space' }],
    }
    actions.push(action)
    return action.id
  }
  const moveActionId = resolveInput(inputs.moveActionId, 'axis2d', 'Move')
  const jumpActionId = inputs.jumpActionId === null ? null : resolveInput(inputs.jumpActionId, 'button', 'Jump')
  const commands: WorldCommand[] = []
  if (actions.length !== context.snapshot.project.inputActions.length) commands.push({ type: 'replace-input-actions', inputActions: actions })
  const nextId = (hint: string) => allocateId(context.identities, used, 'component', `${entityId}:${hint}`)
  const add = (component: WorldComponent) => commands.push({ type: 'add-component', sceneId: scene.sceneId, entityId, component })
  const capsule = entity.components.find((component) => component.type === 'collider' && component.shape === 'capsule'
    && component.enabled && component.purpose === 'simulation' && !component.sensor)
  const colliderComponentId = capsule?.id ?? nextId('character-capsule')
  if (!capsule) add({
    id: colliderComponentId, type: 'collider', enabled: true, purpose: 'simulation', shape: 'capsule', radius: 0.35, halfHeight: 0.55,
    sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff,
  })
  if (!body) add({
    id: nextId('character-body'), type: 'rigid-body', enabled: true, bodyType: 'kinematic-position',
    gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: false,
  })
  add({
    id: nextId('character'), type: 'character-controller', enabled: true, colliderComponentId, moveActionId,
    ...(jumpActionId === null ? {} : { jumpActionId }), speed: 4, jumpSpeed: 6, maxSlopeDegrees: 45,
  })
  validateCommandPlan(context.snapshot, commands)
  return commands
}

function uniqueInputName(actions: readonly WorldInputAction[], base: string): string {
  const names = new Set(actions.map((action) => action.name.toLocaleLowerCase()))
  let name = base
  for (let suffix = 2; names.has(name.toLocaleLowerCase()); suffix += 1) name = `${base} ${suffix}`
  return name
}

function createWasdBindings(): WorldInputBinding[] {
  return [
    { kind: 'axis2d', device: 'keyboard', control: 'KeyA', targetAxis: 'x', scale: -1 },
    { kind: 'axis2d', device: 'keyboard', control: 'KeyD', targetAxis: 'x', scale: 1 },
    { kind: 'axis2d', device: 'keyboard', control: 'KeyW', targetAxis: 'y', scale: 1 },
    { kind: 'axis2d', device: 'keyboard', control: 'KeyS', targetAxis: 'y', scale: -1 },
  ]
}

export function buildSetPrimaryComponentCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityId: string,
  componentId: string,
): Array<Extract<WorldCommand, { type: 'replace-component' }>> {
  const scene = requireScene(snapshot, sceneId)
  const owner = requireEntity(scene, entityId)
  const target = owner.components.find((component) => component.id === componentId)
  if (target?.type !== 'camera' && target?.type !== 'audio-listener') {
    throw new WorldEditorCommandBuilderError('primary-component', 'Primary target must be a camera or audio listener.')
  }
  const type = target.type
  const commands: Array<Extract<WorldCommand, { type: 'replace-component' }>> = []
  for (const candidate of scene.entities) {
    for (const component of candidate.components) {
      if (component.type !== type) continue
      const primary = component.id === target.id
      const enabled = primary ? true : component.enabled
      if (component.primary === primary && component.enabled === enabled) continue
      commands.push({
        type: 'replace-component', sceneId, entityId: candidate.id, componentId: component.id,
        component: { ...structuredClone(component), enabled, primary },
      })
    }
  }
  if (commands.length > 0) validateCommandPlan(snapshot, commands)
  return commands
}

export function buildRemoveWorldComponentCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityId: string,
  componentId: string,
): [Extract<WorldCommand, { type: 'remove-component' }>] {
  const scene = requireScene(snapshot, sceneId)
  const entity = requireEntity(scene, entityId)
  if (!entity.components.some((component) => component.id === componentId)) {
    throw new WorldEditorCommandBuilderError('component-missing', `Component ${componentId} does not exist on ${entityId}.`)
  }
  const directReference = scene.entities
    .flatMap((candidate) => candidate.components)
    .flatMap((component) => collectWorldComponentReferences(component).map((reference) => ({ component, reference })))
    .find(({ component, reference }) => component.id !== componentId && reference.kind === 'component' && reference.id === componentId)
  if (directReference) {
    throw new WorldEditorCommandBuilderError('component-referenced', `Component ${componentId} is referenced by ${directReference.component.id}.`)
  }
  const commands: [Extract<WorldCommand, { type: 'remove-component' }>] = [{ type: 'remove-component', sceneId, entityId, componentId }]
  validateCommandPlan(snapshot, commands)
  return commands
}

export function buildAttachAudioSourceCommands(
  context: WorldEditorBuilderContext,
  entityId: string,
  options: { workspacePath: string; format: WorldAudioResource['format']; name: string },
): WorldCommand[] {
  const scene = requireActiveScene(context)
  const entity = requireEntity(scene, entityId)
  const workspacePath = normalizeWorldWorkspacePath(options.workspacePath)
  if (!workspacePath) throw new WorldEditorCommandBuilderError('workspace-path', 'Audio workspace path must be canonical and workspace-relative.')
  const name = requiredName(options.name)
  const used = collectIds(context.snapshot)
  const existing = context.snapshot.project.resources.find((resource): resource is WorldAudioResource => (
    resource.type === 'audio' && resource.workspacePath === workspacePath && resource.format === options.format
  ))
  const resourceId = existing?.id ?? allocateId(context.identities, used, 'resource', `audio:${options.format}:${workspacePath}`)
  const commands: WorldCommand[] = []
  if (!existing) commands.push({ type: 'add-resource', resource: { id: resourceId, type: 'audio', name, workspacePath, format: options.format } })
  commands.push({
    type: 'add-component', sceneId: scene.sceneId, entityId,
    component: {
      id: allocateId(context.identities, used, 'component', `audio-source:${entityId}:${resourceId}`),
      type: 'audio-source', enabled: true, resourceId, autoplay: false, loop: false, volume: 1, spatial: true, maxDistance: 20,
    },
  })

  const hasPrimaryListener = scene.entities.some((candidate) => candidate.enabled && candidate.components.some((component) => component.type === 'audio-listener' && component.enabled && component.primary))
  if (!hasPrimaryListener) {
    const listener = entity.components.find((component) => component.type === 'audio-listener')
    if (listener?.type === 'audio-listener') {
      commands.push({
        type: 'replace-component', sceneId: scene.sceneId, entityId, componentId: listener.id,
        component: { ...structuredClone(listener), enabled: true, primary: true },
      })
    } else {
      commands.push({
        type: 'add-component', sceneId: scene.sceneId, entityId,
        component: { id: allocateId(context.identities, used, 'component', `audio-listener:${entityId}`), type: 'audio-listener', enabled: true, primary: true },
      })
    }
  }
  validateCommandPlan(context.snapshot, commands)
  return commands
}

export function isValidWorldKeyboardControl(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[A-Za-z][A-Za-z0-9]*$/.test(value)
}

export function buildAddButtonInputActionCommands(
  snapshot: WorldProjectSnapshotV1,
  identities: WorldEditorIdentityGenerator,
  options: { name: string; control: string },
): [Extract<WorldCommand, { type: 'replace-input-actions' }>] {
  const name = requiredName(options.name)
  assertKeyboardControl(options.control)
  if (snapshot.project.inputActions.some((action) => action.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new WorldEditorCommandBuilderError('input-name', `Input action ${name} already exists.`)
  }
  const used = collectIds(snapshot)
  const action: WorldInputAction = {
    id: allocateId(identities, used, 'input', name),
    name,
    valueType: 'button',
    bindings: [{ kind: 'button', device: 'keyboard', control: options.control }],
  }
  const commands: [Extract<WorldCommand, { type: 'replace-input-actions' }>] = [{
    type: 'replace-input-actions', inputActions: [...structuredClone(snapshot.project.inputActions), action],
  }]
  validateCommandPlan(snapshot, commands)
  return commands
}

export function buildUpdateButtonInputActionCommands(
  snapshot: WorldProjectSnapshotV1,
  actionId: string,
  options: { name: string; control: string },
): [Extract<WorldCommand, { type: 'replace-input-actions' }>] {
  const action = snapshot.project.inputActions.find((candidate) => candidate.id === actionId)
  if (!action || action.valueType !== 'button') throw new WorldEditorCommandBuilderError('input-missing', `Button input ${actionId} does not exist.`)
  const name = requiredName(options.name)
  assertKeyboardControl(options.control)
  if (snapshot.project.inputActions.some((candidate) => candidate.id !== actionId && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new WorldEditorCommandBuilderError('input-name', `Input action ${name} already exists.`)
  }
  const replacement = structuredClone(action)
  replacement.name = name
  const keyboard = replacement.bindings.find((binding) => binding.kind === 'button' && binding.device === 'keyboard')
  if (keyboard) keyboard.control = options.control
  else replacement.bindings.push({ kind: 'button', device: 'keyboard', control: options.control })
  const commands: [Extract<WorldCommand, { type: 'replace-input-actions' }>] = [{
    type: 'replace-input-actions',
    inputActions: snapshot.project.inputActions.map((candidate) => candidate.id === actionId ? replacement : structuredClone(candidate)),
  }]
  validateCommandPlan(snapshot, commands)
  return commands
}

export function buildAddAxis2dInputActionCommands(
  snapshot: WorldProjectSnapshotV1,
  identities: WorldEditorIdentityGenerator,
  options: { name: string },
): [Extract<WorldCommand, { type: 'replace-input-actions' }>] {
  const name = requiredName(options.name)
  assertInputNameAvailable(snapshot, name)
  const commands: [Extract<WorldCommand, { type: 'replace-input-actions' }>] = [{
    type: 'replace-input-actions', inputActions: [...structuredClone(snapshot.project.inputActions), {
      id: allocateId(identities, collectIds(snapshot), 'input', name), name, valueType: 'axis2d', bindings: createWasdBindings(),
    }],
  }]
  validateCommandPlan(snapshot, commands)
  return commands
}

export function buildRenameInputActionCommands(
  snapshot: WorldProjectSnapshotV1,
  actionId: string,
  name: string,
): [Extract<WorldCommand, { type: 'replace-input-actions' }>] {
  const replacement = requireInputAction(snapshot, actionId)
  replacement.name = requiredName(name)
  assertInputNameAvailable(snapshot, replacement.name, actionId)
  return replaceInputAction(snapshot, replacement)
}

export function buildUpdateInputBindingCommands(
  snapshot: WorldProjectSnapshotV1,
  actionId: string,
  index: number,
  binding: WorldInputBinding,
): [Extract<WorldCommand, { type: 'replace-input-actions' }>] {
  const replacement = requireInputAction(snapshot, actionId)
  if (!Number.isInteger(index) || !replacement.bindings[index]) {
    throw new WorldEditorCommandBuilderError('input-binding', 'Input binding is unavailable. Refresh the inspector.')
  }
  if (binding.device === 'keyboard') assertKeyboardControl(binding.control)
  replacement.bindings[index] = structuredClone(binding)
  return replaceInputAction(snapshot, replacement)
}

function requireInputAction(snapshot: WorldProjectSnapshotV1, actionId: string): WorldInputAction {
  const action = snapshot.project.inputActions.find((candidate) => candidate.id === actionId)
  if (!action) throw new WorldEditorCommandBuilderError('input-missing', `Input action ${actionId} does not exist.`)
  return structuredClone(action)
}

function assertInputNameAvailable(snapshot: WorldProjectSnapshotV1, name: string, actionId?: string): void {
  if (snapshot.project.inputActions.some((action) => action.id !== actionId && action.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new WorldEditorCommandBuilderError('input-name', `Input action ${name} already exists.`)
  }
}

function replaceInputAction(snapshot: WorldProjectSnapshotV1, action: WorldInputAction): [Extract<WorldCommand, { type: 'replace-input-actions' }>] {
  const commands: [Extract<WorldCommand, { type: 'replace-input-actions' }>] = [{
    type: 'replace-input-actions',
    inputActions: snapshot.project.inputActions.map((candidate) => candidate.id === action.id ? action : structuredClone(candidate)),
  }]
  validateCommandPlan(snapshot, commands)
  return commands
}

export function buildRemoveInputActionCommands(
  snapshot: WorldProjectSnapshotV1,
  actionId: string,
): [Extract<WorldCommand, { type: 'replace-input-actions' }>] {
  if (!snapshot.project.inputActions.some((action) => action.id === actionId)) throw new WorldEditorCommandBuilderError('input-missing', `Input action ${actionId} does not exist.`)
  const commands: [Extract<WorldCommand, { type: 'replace-input-actions' }>] = [{
    type: 'replace-input-actions', inputActions: snapshot.project.inputActions.filter((action) => action.id !== actionId).map((action) => structuredClone(action)),
  }]
  validateCommandPlan(snapshot, commands)
  return commands
}

export function getCompatibleWorldBehaviorEventTypes(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
): WorldBehaviorAuthoringEventType[] {
  const scene = requireScene(snapshot, sceneId)
  const types: WorldBehaviorAuthoringEventType[] = ['start']
  if (snapshot.project.inputActions.some((action) => action.valueType === 'button')) types.push('input')
  if (getCompatibleTriggers(scene).length > 0) types.push('trigger-enter', 'trigger-exit')
  types.push('timer')
  return types
}

export function getCompatibleWorldBehaviorActionTypes(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
): WorldBehaviorAuthoringActionType[] {
  const scene = requireScene(snapshot, sceneId)
  const types: WorldBehaviorAuthoringActionType[] = []
  if (scene.entities.some((entity) => entity.components.some((component) => component.type === 'renderable'))) types.push('set-visibility')
  if (getWorldLivePropertyTargets(snapshot, sceneId).length > 0) types.push('set-component-property')
  if (scene.entities.some((entity) => entity.enabled && entity.components.some((component) => component.type === 'animation-player' && component.enabled))) types.push('play-animation')
  if (getCompatibleAudioSources(scene).length > 0) types.push('play-audio', 'stop-audio')
  if (getCompatibleDynamicBodies(scene).length > 0) types.push('apply-impulse')
  if (snapshot.project.scenes.length > 0) types.push('change-scene')
  return types
}

export function createCompatibleWorldBehaviorEvent(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  type: WorldBehaviorAuthoringEventType,
): WorldBehaviorEvent {
  const scene = requireScene(snapshot, sceneId)
  if (!getCompatibleWorldBehaviorEventTypes(snapshot, sceneId).includes(type)) throw new WorldEditorCommandBuilderError('behavior-event', `${type} has no compatible target.`)
  if (type === 'start') return { type }
  if (type === 'input') return { type, actionId: snapshot.project.inputActions.find((action) => action.valueType === 'button')!.id, phase: 'pressed' }
  if (type === 'trigger-enter' || type === 'trigger-exit') return { type, triggerComponentId: getCompatibleTriggers(scene)[0]!.componentId }
  return { type: 'timer', delaySeconds: 1, repeat: false }
}

export function createCompatibleWorldBehaviorAction(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  type: WorldBehaviorAuthoringActionType,
): WorldBehaviorAction {
  const scene = requireScene(snapshot, sceneId)
  if (!getCompatibleWorldBehaviorActionTypes(snapshot, sceneId).includes(type)) throw new WorldEditorCommandBuilderError('behavior-action', `${type} has no compatible target.`)
  if (type === 'set-visibility') {
    const entity = scene.entities.find((candidate) => candidate.components.some((component) => component.type === 'renderable'))!
    const renderable = entity.components.find((component) => component.type === 'renderable')!
    return { type, entityId: entity.id, visible: renderable.type === 'renderable' ? !renderable.visible : true }
  }
  if (type === 'set-component-property') {
    const target = getWorldLivePropertyTargets(snapshot, sceneId)[0]!
    return { type, entityId: target.entityId, componentId: target.componentId, componentType: target.componentType, property: target.property, value: toggleWritableValue(target.value) }
  }
  if (type === 'play-animation') {
    const target = scene.entities.flatMap((entity) => entity.components.map((component) => ({ entity, component })))
      .find(({ entity, component }) => entity.enabled && component.type === 'animation-player' && component.enabled)!
    return { type, entityId: target.entity.id, componentId: target.component.id }
  }
  if (type === 'play-audio' || type === 'stop-audio') {
    const target = getCompatibleAudioSources(scene)[0]!
    return { type, entityId: target.entityId, componentId: target.componentId }
  }
  if (type === 'apply-impulse') return { type, entityId: getCompatibleDynamicBodies(scene)[0]!.entityId, impulse: [0, 5, 0] }
  const target = snapshot.project.scenes.find((candidate) => candidate.id !== sceneId) ?? snapshot.project.scenes[0]!
  return { type: 'change-scene', sceneId: target.id }
}

export function getWorldLivePropertyTargets(snapshot: WorldProjectSnapshotV1, sceneId: string): WorldLivePropertyTarget[] {
  const scene = requireScene(snapshot, sceneId)
  const resources = new Map(snapshot.project.resources.map((resource) => [resource.id, resource]))
  const targets: WorldLivePropertyTarget[] = []
  for (const entity of scene.entities) {
    for (const component of entity.components) {
      const definition = getWorldComponentDefinition(component.type)
      if (!definition || definition.runtimeAuthority !== 'presentation') continue
      const context = resolveLivePropertyContext(component, entity, resources)
      for (const capability of definition.livePropertyCapabilities) {
        const value = readProperty(component, capability.property)
        if (!isWritableValue(value) || !isWorldComponentPropertyLiveInPlay(component, capability.property, value, context)) continue
        targets.push({
          entityId: entity.id,
          entityName: entity.name,
          componentId: component.id,
          componentType: component.type,
          componentLabel: definition.label,
          property: capability.property,
          value: structuredClone(value),
        })
      }
    }
  }
  return targets
}

export function replaceWorldBehaviorComponent(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityId: string,
  componentId: string,
  replacement: WorldComponent,
): [Extract<WorldCommand, { type: 'replace-component' }>] {
  if (replacement.type !== 'behavior' || replacement.id !== componentId) throw new WorldEditorCommandBuilderError('behavior', 'Behavior replacement identity is invalid.')
  const parsed = parseWorldComponent(replacement)
  if (!parsed.success) throw new WorldEditorCommandBuilderError('behavior', parsed.issues[0]?.message ?? 'Behavior is invalid.')
  const commands: [Extract<WorldCommand, { type: 'replace-component' }>] = [{ type: 'replace-component', sceneId, entityId, componentId, component: parsed.value }]
  const candidate = validateCommandPlan(snapshot, commands)
  const graph = validateWorldStartTransitionGraph(candidate, candidate.project.scenes.map((scene) => scene.id))
  if (!graph.success) {
    const issue = graph.issues[0]
    throw new WorldEditorCommandBuilderError(issue?.code ?? 'runtime-start-transition-invalid', issue?.message ?? 'Start scene transitions are invalid.')
  }
  return commands
}

function createBoxCollider(id: string, sensor: boolean): Extract<WorldComponent, { type: 'collider' }> {
  return createPrimitiveCollider(id, 'box', sensor)
}

function isReusableBodyPresetCollider(component: WorldComponent, bodyType: Extract<WorldComponent, { type: 'rigid-body' }>['bodyType']): component is Extract<WorldComponent, { type: 'collider' }> {
  return component.type === 'collider'
    && component.enabled
    && component.purpose === 'simulation'
    && !component.sensor
    && (component.shape === 'box' || component.shape === 'sphere' || component.shape === 'capsule' || component.shape === 'convex' || (component.shape === 'mesh' && bodyType === 'fixed'))
}

function createPrimitiveCollider(id: string, shape: WorldPrimitiveColliderShape, sensor: boolean): Extract<WorldComponent, { type: 'collider' }> {
  const common = {
    id, type: 'collider' as const, enabled: true, purpose: 'simulation' as const, sensor,
    friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff,
  }
  if (shape === 'sphere') return { ...common, shape, radius: 0.5 }
  if (shape === 'capsule') return { ...common, shape, radius: 0.35, halfHeight: 0.55 }
  return {
    ...common, shape, halfExtents: [0.5, 0.5, 0.5],
  }
}

function createAdvancedCollider(id: string, shape: WorldAdvancedColliderShape, resourceId: string, sensor: boolean): Extract<WorldComponent, { type: 'collider' }> {
  return {
    id,
    type: 'collider',
    enabled: true,
    purpose: 'simulation',
    shape,
    resourceId,
    sensor,
    friction: 0.5,
    restitution: 0,
    collisionLayer: 1,
    collisionMask: 0xffff,
  }
}

function isEligibleWorldColliderSourceResource(resource: unknown): resource is WorldModelResource {
  return !!resource
    && typeof resource === 'object'
    && (resource as WorldModelResource).type === 'model'
    && ((resource as WorldModelResource).format === 'glb' || (resource as WorldModelResource).format === 'gltf' || (resource as WorldModelResource).format === 'ply-mesh')
}

function assertEligibleWorldColliderSource(snapshot: WorldProjectSnapshotV1, resourceId: string): void {
  if (!isEligibleWorldColliderSourceResource(snapshot.project.resources.find((resource) => resource.id === resourceId))) {
    throw new WorldEditorCommandBuilderError('collider-resource', 'Choose a GLB, GLTF, or PLY mesh source for this collider.')
  }
}

function isAuthoredWorldColliderShape(shape: string): shape is WorldAuthoredColliderShape {
  return shape === 'box' || shape === 'sphere' || shape === 'capsule' || shape === 'convex' || shape === 'mesh'
}

function assertColliderAuthoringCompatible(
  entity: WorldEntity,
  next: Extract<WorldComponent, { type: 'collider' }>,
  replacingComponentId?: string,
): void {
  const candidateColliders = entity.components
    .filter((component): component is Extract<WorldComponent, { type: 'collider' }> => component.type === 'collider' && component.id !== replacingComponentId)
    .concat(next)
  const body = entity.components.find((component): component is Extract<WorldComponent, { type: 'rigid-body' }> => component.type === 'rigid-body')
  assertStaticMeshBodyCompatibility(candidateColliders, body)
}

function assertRigidBodyAuthoringCompatible(
  entity: WorldEntity,
  nextBody: Pick<Extract<WorldComponent, { type: 'rigid-body' }>, 'enabled' | 'bodyType'>,
): void {
  assertStaticMeshBodyCompatibility(
    entity.components.filter((component): component is Extract<WorldComponent, { type: 'collider' }> => component.type === 'collider'),
    nextBody,
  )
}

function assertStaticMeshBodyCompatibility(
  colliders: readonly Extract<WorldComponent, { type: 'collider' }>[],
  body: Pick<Extract<WorldComponent, { type: 'rigid-body' }>, 'enabled' | 'bodyType'> | undefined,
): void {
  if (!body?.enabled || body.bodyType === 'fixed') return
  if (colliders.some((component) => component.enabled && component.purpose === 'simulation' && component.shape === 'mesh')) {
    throw new WorldEditorCommandBuilderError('static-mesh-body', 'Static Mesh colliders require a fixed body or no active body.')
  }
}

function defaultBoxHalfExtents(component: Extract<WorldComponent, { type: 'collider' }>): [number, number, number] {
  if (component.shape === 'box') return structuredClone(component.halfExtents)
  if (component.shape === 'sphere') return [component.radius, component.radius, component.radius]
  if (component.shape === 'capsule') return [component.radius, component.halfHeight, component.radius]
  return [0.5, 0.5, 0.5]
}

function defaultSphereRadius(component: Extract<WorldComponent, { type: 'collider' }>): number {
  if (component.shape === 'sphere') return component.radius
  if (component.shape === 'box') return Math.max(...component.halfExtents)
  if (component.shape === 'capsule') return component.radius
  return 0.5
}

function defaultCapsuleRadius(component: Extract<WorldComponent, { type: 'collider' }>): number {
  if (component.shape === 'capsule') return component.radius
  if (component.shape === 'sphere') return component.radius
  if (component.shape === 'box') return Math.max(component.halfExtents[0], component.halfExtents[2])
  return 0.35
}

function defaultCapsuleHalfHeight(component: Extract<WorldComponent, { type: 'collider' }>): number {
  if (component.shape === 'capsule') return component.halfHeight
  if (component.shape === 'box') return component.halfExtents[1]
  return 0.55
}

function validateCommandPlan(snapshot: WorldProjectSnapshotV1, commands: readonly WorldCommand[]): WorldProjectSnapshotV1 {
  const result = applyWorldCommandBatch(snapshot, {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:authoring-preview', projectId: snapshot.project.projectId,
    baseRevision: snapshot.project.revision, origin: 'ui', commands: structuredClone(commands),
  })
  if (result.success) return result.snapshot
  const issue = result.issues[0]
  throw new WorldEditorCommandBuilderError(issue?.code ?? 'invalid-plan', issue?.message ?? 'Authoring command plan is invalid.')
}

function requireActiveScene(context: WorldEditorBuilderContext): WorldSceneDocumentV1 {
  if (!context.activeSceneId) throw new WorldEditorCommandBuilderError('scene-required', 'An active scene is required.')
  return requireScene(context.snapshot, context.activeSceneId)
}

function requireScene(snapshot: WorldProjectSnapshotV1, sceneId: string): WorldSceneDocumentV1 {
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  if (!scene) throw new WorldEditorCommandBuilderError('scene-missing', `Scene ${sceneId} does not exist.`)
  return scene
}

function requireEntity(scene: WorldSceneDocumentV1, entityId: string): WorldEntity {
  const entity = scene.entities.find((candidate) => candidate.id === entityId)
  if (!entity) throw new WorldEditorCommandBuilderError('entity-missing', `Entity ${entityId} does not exist.`)
  return entity
}

function requireEditableEntity(scene: WorldSceneDocumentV1, entityId: string): WorldEntity {
  const entity = requireEntity(scene, entityId)
  if (isEntityEffectivelyLocked(scene.entities, entityId)) throw new WorldEditorCommandBuilderError('entity-locked', 'Locked entities cannot be edited.')
  return entity
}

function isEntityEffectivelyLocked(entities: readonly WorldEntity[], entityId: string): boolean {
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  const visited = new Set<string>()
  let current = byId.get(entityId)
  while (current) {
    if (visited.has(current.id)) return true
    visited.add(current.id)
    if (current.locked) return true
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return false
}

function collectIds(snapshot: WorldProjectSnapshotV1): Set<string> {
  return new Set([
    snapshot.project.projectId,
    ...snapshot.project.resources.map((resource) => resource.id),
    ...snapshot.project.scenes.map((scene) => scene.id),
    ...snapshot.project.inputActions.map((action) => action.id),
    ...snapshot.project.graphicsProfiles.map((profile) => profile.id),
    ...snapshot.scenes.flatMap((scene) => [
      scene.sceneId,
      ...scene.entities.flatMap((entity) => [entity.id, ...entity.components.flatMap((component) => [component.id, ...(component.type === 'behavior' ? component.bindings.map((binding) => binding.id) : [])])]),
      ...scene.sequences.flatMap((sequence) => [sequence.id, ...sequence.tracks.flatMap((track) => [track.id, ...track.keyframes.map((keyframe) => keyframe.id)])]),
    ]),
  ])
}

function allocateId(identities: WorldEditorIdentityGenerator, used: Set<string>, namespace: string, hint: string): string {
  for (let attempt = 0; attempt < 1_024; attempt += 1) {
    const id = identities.nextId(namespace, `${hint}:${attempt}`)
    if (!used.has(id)) {
      used.add(id)
      return id
    }
  }
  throw new WorldEditorCommandBuilderError('identity-exhausted', `Could not allocate ${namespace} identity.`)
}

function requiredName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 512 || name.includes('\0')) throw new WorldEditorCommandBuilderError('name', 'Name must be non-empty and at most 512 characters.')
  return name
}

function assertKeyboardControl(value: string): void {
  if (!isValidWorldKeyboardControl(value)) throw new WorldEditorCommandBuilderError('keyboard-control', 'Keyboard code must be a valid KeyboardEvent.code value.')
}

function getCompatibleTriggers(scene: WorldSceneDocumentV1): Array<{ entityId: string; entityName: string; componentId: string }> {
  return scene.entities.flatMap((entity) => entity.components.flatMap((component) => {
    if (!entity.enabled || component.type !== 'trigger' || !component.enabled) return []
    const collider = entity.components.find((candidate) => candidate.id === component.colliderComponentId)
    return collider?.type === 'collider' && collider.enabled && collider.purpose === 'simulation' && collider.sensor
      ? [{ entityId: entity.id, entityName: entity.name, componentId: component.id }]
      : []
  }))
}

function getCompatibleAudioSources(scene: WorldSceneDocumentV1): Array<{ entityId: string; entityName: string; componentId: string }> {
  return scene.entities.flatMap((entity) => entity.enabled
    ? entity.components.flatMap((component) => component.type === 'audio-source' && component.enabled
      ? [{ entityId: entity.id, entityName: entity.name, componentId: component.id }]
      : [])
    : [])
}

function getCompatibleDynamicBodies(scene: WorldSceneDocumentV1): Array<{ entityId: string; entityName: string }> {
  return scene.entities.flatMap((entity) => entity.enabled && entity.components.some((component) => component.type === 'rigid-body' && component.enabled && component.bodyType === 'dynamic')
    ? [{ entityId: entity.id, entityName: entity.name }]
    : [])
}

function resolveLivePropertyContext(
  component: WorldComponent,
  entity: WorldEntity,
  resources: ReadonlyMap<string, WorldProjectSnapshotV1['project']['resources'][number]>,
): WorldLivePropertyContext {
  if (component.type === 'renderable') {
    const resource = resources.get(component.resourceId)
    return resource?.type === 'model' ? { modelFormat: resource.format } : {}
  }
  if (component.type === 'animation-player') {
    const renderable = entity.components.find((candidate) => candidate.type === 'renderable')
    const model = renderable?.type === 'renderable' ? resources.get(renderable.resourceId) : undefined
    const animation = resources.get(component.resourceId)
    return {
      ...(model?.type === 'model' ? { modelFormat: model.format } : {}),
      ...(animation?.type === 'animation' ? { animationFormat: animation.format } : {}),
    }
  }
  return {}
}

function readProperty(component: WorldComponent, property: string): unknown {
  let current: unknown = component
  for (const segment of property.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function isWritableValue(value: unknown): value is WorldWritableValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    || (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && Number.isFinite(item)))
}

function toggleWritableValue(value: WorldWritableValue): WorldWritableValue {
  if (typeof value === 'boolean') return !value
  if (typeof value === 'number') return value === 0 ? 1 : value
  return structuredClone(value)
}
