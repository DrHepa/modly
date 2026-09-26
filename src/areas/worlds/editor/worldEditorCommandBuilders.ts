import type {
  WorldBehaviorAction,
  WorldBehaviorBinding,
  WorldBehaviorEvent,
  WorldComponent,
  WorldLightComponent,
} from '../core/worldComponentRegistry.ts'
import type { WorldCommand } from '../core/worldCommands.ts'
import { normalizeWorldWorkspacePath } from '../core/worldDocuments.ts'
import {
  WORLD_SCENE_SCHEMA,
  type WorldEntity,
  type WorldModelResource,
  type WorldProjectSnapshotV1,
  type WorldResource,
  type WorldSceneDocumentV1,
  type WorldTransform,
} from '../core/worldModel.ts'
import {
  isWorldCanonicalId,
  WORLD_MAX_COLLECTION_ITEMS,
} from '../core/worldValidationLimits.ts'
import { isWorldProjectKey } from '../../../shared/types/worldProjects.ts'

export interface WorldEditorIdentityGenerator {
  nextId(namespace: string, hint: string): string
  nextSceneDocumentKey(hint: string): string
}

export interface WorldEditorBuilderContext {
  snapshot: WorldProjectSnapshotV1
  projectKey: string
  activeSceneId?: string
  identities: WorldEditorIdentityGenerator
}

export interface AddWorldModelEntityOptions {
  workspacePath: string
  format: WorldModelResource['format']
  name: string
  role?: 'asset' | 'base-scene'
  parentId?: string | null
  transform?: WorldTransform
}

export class WorldEditorCommandBuilderError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function createDeterministicWorldEditorIdentityGenerator(seed: string): WorldEditorIdentityGenerator {
  const counters = new Map<string, number>()
  const nextDigest = (scope: string, hint: string) => {
    const key = `${scope}\0${hint}`
    const counter = counters.get(key) ?? 0
    counters.set(key, counter + 1)
    return digest128(`${seed}\0${scope}\0${hint}\0${counter}`)
  }
  return Object.freeze({
    nextId(namespace: string, hint: string) {
      const canonicalNamespace = normalizeNamespace(namespace)
      return `${canonicalNamespace}:${nextDigest(canonicalNamespace, hint)}`
    },
    nextSceneDocumentKey(hint: string) {
      return nextDigest('scene-document', hint)
    },
  })
}

export function buildAddSceneCommands(
  context: Pick<WorldEditorBuilderContext, 'snapshot' | 'projectKey' | 'identities'>,
  options: { name: string },
): [Extract<WorldCommand, { type: 'add-scene' }>] {
  assertProjectKey(context.projectKey)
  const name = requiredName(options.name)
  const usedIds = collectSnapshotIds(context.snapshot)
  const sceneId = allocateGeneratedId(context.identities, usedIds, 'scene', name)
  const documentKey = context.identities.nextSceneDocumentKey(sceneId)
  if (!/^[a-f0-9]{32}$/.test(documentKey)) {
    throw new WorldEditorCommandBuilderError('scene-document-key', 'Scene document keys must contain exactly 32 lowercase hexadecimal characters.')
  }
  const reference = {
    id: sceneId,
    name,
    documentPath: `Worlds/${context.projectKey}/scenes/scene-${documentKey}.world-scene.json`,
  }
  const scene: WorldSceneDocumentV1 = {
    schema: WORLD_SCENE_SCHEMA,
    projectId: context.snapshot.project.projectId,
    sceneId,
    name,
    environment: { backgroundColor: '#20242b', ambientIntensity: 0.35 },
    entities: [],
    sequences: [],
  }
  return [{ type: 'add-scene', reference, scene }]
}

export function buildAddModelEntityCommands(
  context: WorldEditorBuilderContext,
  options: AddWorldModelEntityOptions,
): WorldCommand[] {
  assertProjectKey(context.projectKey)
  const scene = requireScene(context.snapshot, requireActiveSceneId(context))
  const workspacePath = normalizeWorldWorkspacePath(options.workspacePath)
  if (!workspacePath) throw new WorldEditorCommandBuilderError('workspace-path', 'Model workspace path must be canonical and workspace-relative.')
  const name = requiredName(options.name)
  const usedIds = collectSnapshotIds(context.snapshot)
  const existingResource = context.snapshot.project.resources.find((resource): resource is WorldModelResource => (
    resource.type === 'model' && resource.workspacePath === workspacePath && resource.format === options.format
  ))
  const resourceId = existingResource?.id ?? allocateGeneratedId(context.identities, usedIds, 'resource', `${options.format}:${workspacePath}`)
  const entityId = allocateGeneratedId(context.identities, usedIds, 'entity', `${scene.sceneId}:${workspacePath}:${name}`)
  const renderableId = allocateGeneratedId(context.identities, usedIds, 'component', `renderable:${entityId}`)
  const parentId = options.parentId ?? null
  if (parentId !== null && !scene.entities.some((entity) => entity.id === parentId)) {
    throw new WorldEditorCommandBuilderError('parent-missing', `Parent entity ${parentId} does not exist.`)
  }
  const commands: WorldCommand[] = []
  if (!existingResource) {
    commands.push({
      type: 'add-resource',
      resource: { id: resourceId, type: 'model', name, workspacePath, format: options.format },
    })
  }
  commands.push({
    type: 'add-entity',
    sceneId: scene.sceneId,
    entity: {
      id: entityId,
      name,
      parentId,
      enabled: true,
      locked: false,
      tags: options.role === 'base-scene' ? ['modly:base-scene'] : [],
      transform: cloneTransform(options.transform ?? identityTransform()),
      components: [{
        id: renderableId,
        type: 'renderable',
        enabled: true,
        resourceId,
        visible: true,
        castShadow: true,
        receiveShadow: true,
        material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
      }],
    },
  })
  assertCommandLimit(commands)
  return commands
}

export function buildAddCameraCommands(
  context: WorldEditorBuilderContext,
  options: { name: string; transform?: WorldTransform; projection?: 'perspective' | 'orthographic' },
): [Extract<WorldCommand, { type: 'add-entity' }>] {
  const scene = requireScene(context.snapshot, requireActiveSceneId(context))
  const usedIds = collectSnapshotIds(context.snapshot)
  const entityId = allocateGeneratedId(context.identities, usedIds, 'entity', `${scene.sceneId}:camera:${options.name}`)
  const componentId = allocateGeneratedId(context.identities, usedIds, 'component', `camera:${entityId}`)
  const primary = !scene.entities.some((entity) => entity.components.some((component) => component.type === 'camera' && component.primary))
  const projection = options.projection ?? 'perspective'
  return [{
    type: 'add-entity',
    sceneId: scene.sceneId,
    entity: {
      id: entityId,
      name: requiredName(options.name),
      parentId: null,
      enabled: true,
      locked: false,
      tags: [],
      transform: cloneTransform(options.transform ?? identityTransform()),
      components: [{
        id: componentId,
        type: 'camera',
        enabled: true,
        projection,
        primary,
        near: 0.1,
        far: 1_000,
        ...(projection === 'perspective' ? { fieldOfView: 60 } : { orthographicSize: 10 }),
      }],
    },
  }]
}

export function buildAddLightCommands(
  context: WorldEditorBuilderContext,
  options: { name: string; lightKind: WorldLightComponent['lightKind']; transform?: WorldTransform },
): [Extract<WorldCommand, { type: 'add-entity' }>] {
  const scene = requireScene(context.snapshot, requireActiveSceneId(context))
  const usedIds = collectSnapshotIds(context.snapshot)
  const entityId = allocateGeneratedId(context.identities, usedIds, 'entity', `${scene.sceneId}:light:${options.name}`)
  const componentId = allocateGeneratedId(context.identities, usedIds, 'component', `light:${entityId}`)
  const component: WorldLightComponent = options.lightKind === 'ambient'
    ? { id: componentId, type: 'light', enabled: true, lightKind: 'ambient', color: '#ffffff', intensity: 1 }
    : options.lightKind === 'directional'
      ? { id: componentId, type: 'light', enabled: true, lightKind: 'directional', color: '#ffffff', intensity: 1, castShadow: true }
      : options.lightKind === 'point'
        ? { id: componentId, type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 1, range: 10, castShadow: true }
        : { id: componentId, type: 'light', enabled: true, lightKind: 'spot', color: '#ffffff', intensity: 1, range: 10, angle: Math.PI / 4, castShadow: true }
  return [{
    type: 'add-entity',
    sceneId: scene.sceneId,
    entity: {
      id: entityId,
      name: requiredName(options.name),
      parentId: null,
      enabled: true,
      locked: false,
      tags: [],
      transform: cloneTransform(options.transform ?? identityTransform()),
      components: [component],
    },
  }]
}

export function buildImportLegacySceneCommands(
  context: WorldEditorBuilderContext,
  imported: WorldProjectSnapshotV1,
  mode: 'append' | 'replace',
): WorldCommand[] {
  const targetScene = requireScene(context.snapshot, requireActiveSceneId(context))
  const importedScene = imported.scenes[0]
  if (!importedScene || imported.scenes.length !== 1 || importedScene.sequences.length > 0) {
    throw new WorldEditorCommandBuilderError('legacy-scene', 'Legacy workflow import must contain exactly one scene without canonical sequences.')
  }
  const usedIds = collectSnapshotIds(context.snapshot)
  const resourceIds = new Map<string, string>()
  const commands: WorldCommand[] = []
  for (const resource of imported.project.resources) {
    const reusable = context.snapshot.project.resources.find((candidate) => sameReusableResource(candidate, resource))
    if (reusable) {
      resourceIds.set(resource.id, reusable.id)
      continue
    }
    const id = allocateGeneratedId(context.identities, usedIds, 'resource', `legacy:${resource.type}:${resource.workspacePath}`)
    resourceIds.set(resource.id, id)
    commands.push({ type: 'add-resource', resource: { ...structuredClone(resource), id } })
  }

  const entityIds = new Map<string, string>()
  const componentIds = new Map<string, string>()
  const bindingIds = new Map<string, string>()
  for (const entity of importedScene.entities) {
    entityIds.set(entity.id, allocateGeneratedId(context.identities, usedIds, 'entity', `legacy:${targetScene.sceneId}:${entity.id}`))
    for (const component of entity.components) {
      componentIds.set(component.id, allocateGeneratedId(context.identities, usedIds, 'component', `legacy:${targetScene.sceneId}:${component.id}`))
      if (component.type === 'behavior') {
        for (const binding of component.bindings) bindingIds.set(binding.id, allocateGeneratedId(context.identities, usedIds, 'binding', `legacy:${targetScene.sceneId}:${binding.id}`))
      }
    }
  }
  const importedEntitiesById = new Map(importedScene.entities.map((entity) => [entity.id, entity]))
  const remappedEntities = [...importedScene.entities]
    .sort((left, right) => entityDepth(left, importedEntitiesById) - entityDepth(right, importedEntitiesById) || codeUnitCompare(left.id, right.id))
    .map((entity): WorldEntity => ({
      ...structuredClone(entity),
      id: requiredMapping(entityIds, entity.id),
      parentId: entity.parentId ? requiredMapping(entityIds, entity.parentId) : null,
      locked: false,
      components: entity.components.map((component) => remapImportedComponent(
        component,
        componentIds,
        entityIds,
        bindingIds,
        resourceIds,
        importedScene.sceneId,
        targetScene.sceneId,
      )),
    }))

  if (mode === 'append') {
    for (const entity of remappedEntities) commands.push({ type: 'add-entity', sceneId: targetScene.sceneId, entity })
  } else {
    const reference = context.snapshot.project.scenes.find((candidate) => candidate.id === targetScene.sceneId)
    if (!reference) throw new WorldEditorCommandBuilderError('scene-missing', `Scene reference ${targetScene.sceneId} does not exist.`)
    commands.push({
      type: 'replace-scene',
      sceneId: targetScene.sceneId,
      reference: structuredClone(reference),
      scene: {
        ...structuredClone(importedScene),
        projectId: context.snapshot.project.projectId,
        sceneId: targetScene.sceneId,
        name: reference.name,
        entities: remappedEntities,
        sequences: [],
      },
    })
  }
  assertNonEmptyCommands(commands)
  assertCommandLimit(commands)
  return commands
}

export function buildPatchEntityTransformsCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  updates: readonly { entityId: string; transform: WorldTransform }[],
): Array<Extract<WorldCommand, { type: 'patch-entity' }>> {
  const scene = requireScene(snapshot, sceneId)
  const entities = new Set(scene.entities.map((entity) => entity.id))
  const seen = new Set<string>()
  const normalized = [...updates].sort((left, right) => codeUnitCompare(left.entityId, right.entityId))
  const commands: Array<Extract<WorldCommand, { type: 'patch-entity' }>> = []
  for (const update of normalized) {
    assertCanonicalId(update.entityId, 'entity')
    if (!entities.has(update.entityId)) throw new WorldEditorCommandBuilderError('entity-missing', `Entity ${update.entityId} does not exist.`)
    if (seen.has(update.entityId)) throw new WorldEditorCommandBuilderError('duplicate-entity', `Entity ${update.entityId} appears more than once.`)
    seen.add(update.entityId)
    commands.push({ type: 'patch-entity', sceneId, entityId: update.entityId, patch: { transform: cloneTransform(update.transform) } })
  }
  assertNonEmptyCommands(commands)
  assertCommandLimit(commands)
  return commands
}

export function buildDuplicateSubtreesCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  selectedEntityIds: readonly string[],
  identities: WorldEditorIdentityGenerator,
): Array<Extract<WorldCommand, { type: 'add-entity' }>> {
  const scene = requireScene(snapshot, sceneId)
  const entitiesById = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const selected = uniqueSortedIds(selectedEntityIds)
  for (const id of selected) if (!entitiesById.has(id)) throw new WorldEditorCommandBuilderError('entity-missing', `Entity ${id} does not exist.`)
  const selectedSet = new Set(selected)
  const roots = selected.filter((id) => !hasAncestorInSet(id, selectedSet, entitiesById))
  const closure = new Set<string>()
  for (const rootId of roots) collectDescendants(rootId, scene.entities, closure)
  const usedIds = collectSnapshotIds(snapshot)
  const entityIds = new Map<string, string>()
  const componentIds = new Map<string, string>()
  const bindingIds = new Map<string, string>()
  const ordered = scene.entities
    .filter((entity) => closure.has(entity.id))
    .sort((left, right) => entityDepth(left, entitiesById) - entityDepth(right, entitiesById) || codeUnitCompare(left.id, right.id))
  for (const entity of ordered) {
    entityIds.set(entity.id, allocateGeneratedId(identities, usedIds, 'entity', `duplicate:${sceneId}:${entity.id}`))
    for (const component of entity.components) {
      componentIds.set(component.id, allocateGeneratedId(identities, usedIds, 'component', `duplicate:${sceneId}:${component.id}`))
      if (component.type === 'behavior') {
        for (const binding of component.bindings) bindingIds.set(binding.id, allocateGeneratedId(identities, usedIds, 'binding', `duplicate:${sceneId}:${binding.id}`))
      }
    }
  }
  const commands = ordered.map((entity): Extract<WorldCommand, { type: 'add-entity' }> => {
    const duplicatedId = requiredMapping(entityIds, entity.id)
    const parentId = entity.parentId && closure.has(entity.parentId) ? requiredMapping(entityIds, entity.parentId) : entity.parentId
    return {
      type: 'add-entity',
      sceneId,
      entity: {
        ...structuredClone(entity),
        id: duplicatedId,
        name: `${entity.name} Copy`,
        parentId,
        locked: false,
        components: entity.components.map((component) => remapComponent(component, componentIds, entityIds, bindingIds)),
      },
    }
  })
  assertNonEmptyCommands(commands)
  assertCommandLimit(commands)
  return commands
}

export function buildReparentEntityCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityId: string,
  parentId: string | null,
): [Extract<WorldCommand, { type: 'reparent-entity' }>] {
  const scene = requireScene(snapshot, sceneId)
  requireEntity(scene, entityId)
  if (parentId !== null) requireEntity(scene, parentId)
  return [{ type: 'reparent-entity', sceneId, entityId, parentId }]
}

export function buildSetEntitiesEnabledCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityIds: readonly string[],
  enabled: boolean,
): Array<Extract<WorldCommand, { type: 'patch-entity' }>> {
  return buildBooleanEntityPatchCommands(snapshot, sceneId, entityIds, { enabled })
}

export function buildSetEntitiesLockedCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityIds: readonly string[],
  locked: boolean,
): Array<Extract<WorldCommand, { type: 'patch-entity' }>> {
  const scene = requireScene(snapshot, sceneId)
  const entitiesById = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const ordered = uniqueSortedIds(entityIds)
    .map((id) => requireEntity(scene, id))
    .sort((left, right) => {
      const depth = entityDepth(left, entitiesById) - entityDepth(right, entitiesById)
      return (locked ? -depth : depth) || codeUnitCompare(left.id, right.id)
    })
  const commands = ordered.map((entity) => ({ type: 'patch-entity' as const, sceneId, entityId: entity.id, patch: { locked } }))
  assertNonEmptyCommands(commands)
  return commands
}

export function buildSetRenderableVisibilityCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityIds: readonly string[],
  visible: boolean,
): Array<Extract<WorldCommand, { type: 'replace-component' }>> {
  const scene = requireScene(snapshot, sceneId)
  const commands: Array<Extract<WorldCommand, { type: 'replace-component' }>> = []
  for (const id of uniqueSortedIds(entityIds)) {
    const entity = requireEntity(scene, id)
    const renderable = entity.components.find((component) => component.type === 'renderable')
    if (!renderable || renderable.type !== 'renderable') throw new WorldEditorCommandBuilderError('renderable-missing', `Entity ${id} has no renderable component.`)
    commands.push({ type: 'replace-component', sceneId, entityId: id, componentId: renderable.id, component: { ...structuredClone(renderable), visible } })
  }
  assertNonEmptyCommands(commands)
  assertCommandLimit(commands)
  return commands
}

export function buildCascadeDeleteCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityIds: readonly string[],
): Array<Extract<WorldCommand, { type: 'remove-entity' }>> {
  const scene = requireScene(snapshot, sceneId)
  const entitiesById = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const selected = new Set(uniqueSortedIds(entityIds))
  for (const id of selected) requireEntity(scene, id)
  const roots = [...selected].filter((id) => !hasAncestorInSet(id, selected, entitiesById)).sort(codeUnitCompare)
  const commands = roots.map((entityId) => ({ type: 'remove-entity' as const, sceneId, entityId, cascade: true }))
  assertNonEmptyCommands(commands)
  return commands
}

/**
 * Builds an explicit command-only transition used to persist Undo/Redo. The
 * target revision must already be current+1; the command bus remains the only
 * authority that advances it.
 */
export function buildWorldSnapshotTransitionCommands(
  current: WorldProjectSnapshotV1,
  target: WorldProjectSnapshotV1,
): WorldCommand[] {
  if (current.project.projectId !== target.project.projectId) throw new WorldEditorCommandBuilderError('project-conflict', 'Snapshot transition cannot change project identity.')
  if (target.project.revision !== current.project.revision + 1) throw new WorldEditorCommandBuilderError('revision-conflict', 'Snapshot transition target must be exactly one revision ahead.')
  const commands: WorldCommand[] = []
  const sceneCommands: WorldCommand[] = []
  appendSceneTransition(sceneCommands, current, target)
  const scenesRequiringUnlock = new Set(sceneCommands.flatMap((command) => (
    command.type === 'replace-scene' || command.type === 'remove-scene' ? [command.sceneId] : []
  )))
  for (const scene of current.scenes) {
    if (!scenesRequiringUnlock.has(scene.sceneId)) continue
    const entitiesById = new Map(scene.entities.map((entity) => [entity.id, entity]))
    for (const entity of [...scene.entities].sort((left, right) => entityDepth(left, entitiesById) - entityDepth(right, entitiesById) || codeUnitCompare(left.id, right.id))) {
      if (entity.locked) commands.push({ type: 'patch-entity', sceneId: scene.sceneId, entityId: entity.id, patch: { locked: false } })
    }
  }
  if (current.project.name !== target.project.name) commands.push({ type: 'rename-project', name: target.project.name })
  if (!sameData(current.project.inputActions, target.project.inputActions)) commands.push({ type: 'replace-input-actions', inputActions: structuredClone(target.project.inputActions) })
  if (!sameData(current.project.graphicsProfiles, target.project.graphicsProfiles)
    || current.project.activeGraphicsProfileId !== target.project.activeGraphicsProfileId) {
    commands.push({
      type: 'replace-graphics-profiles',
      graphicsProfiles: structuredClone(target.project.graphicsProfiles),
      activeGraphicsProfileId: target.project.activeGraphicsProfileId,
    })
  }

  appendResourceTransition(commands, current, target)
  commands.push(...sceneCommands)
  if (current.project.startSceneId !== target.project.startSceneId) commands.push({ type: 'set-start-scene', sceneId: target.project.startSceneId })
  assertNonEmptyCommands(commands)
  assertCommandLimit(commands)
  return commands
}

function appendResourceTransition(commands: WorldCommand[], current: WorldProjectSnapshotV1, target: WorldProjectSnapshotV1): void {
  const currentById = new Map(current.project.resources.map((resource) => [resource.id, resource]))
  const targetById = new Map(target.project.resources.map((resource) => [resource.id, resource]))
  const naturalOrder = current.project.resources.filter((resource) => targetById.has(resource.id)).map((resource) => resource.id)
    .concat(target.project.resources.filter((resource) => !currentById.has(resource.id)).map((resource) => resource.id))
  const targetOrder = target.project.resources.map((resource) => resource.id)
  if (!sameData(naturalOrder, targetOrder)) {
    for (const resource of current.project.resources) commands.push({ type: 'remove-resource', resourceId: resource.id })
    for (const resource of target.project.resources) commands.push({ type: 'add-resource', resource: structuredClone(resource) })
    return
  }
  for (const resource of target.project.resources) {
    const existing = currentById.get(resource.id)
    if (!existing) commands.push({ type: 'add-resource', resource: structuredClone(resource) })
    else if (!sameData(existing, resource)) commands.push({ type: 'replace-resource', resourceId: resource.id, resource: structuredClone(resource) })
  }
  for (const resource of current.project.resources) if (!targetById.has(resource.id)) commands.push({ type: 'remove-resource', resourceId: resource.id })
}

function appendSceneTransition(commands: WorldCommand[], current: WorldProjectSnapshotV1, target: WorldProjectSnapshotV1): void {
  const currentReferences = new Map(current.project.scenes.map((reference) => [reference.id, reference]))
  const targetReferences = new Map(target.project.scenes.map((reference) => [reference.id, reference]))
  const currentScenes = new Map(current.scenes.map((scene) => [scene.sceneId, scene]))
  const targetScenes = new Map(target.scenes.map((scene) => [scene.sceneId, scene]))
  const naturalOrder = current.project.scenes.filter((reference) => targetReferences.has(reference.id)).map((reference) => reference.id)
    .concat(target.project.scenes.filter((reference) => !currentReferences.has(reference.id)).map((reference) => reference.id))
  const targetOrder = target.project.scenes.map((reference) => reference.id)
  if (!sameData(naturalOrder, targetOrder)) {
    for (const reference of current.project.scenes) commands.push({ type: 'remove-scene', sceneId: reference.id })
    for (const reference of target.project.scenes) {
      const scene = targetScenes.get(reference.id)
      if (!scene) throw new WorldEditorCommandBuilderError('scene-missing', `Target scene ${reference.id} is missing.`)
      commands.push({ type: 'add-scene', reference: structuredClone(reference), scene: structuredClone(scene) })
    }
    return
  }
  for (const reference of target.project.scenes) {
    const scene = targetScenes.get(reference.id)
    if (!scene) throw new WorldEditorCommandBuilderError('scene-missing', `Target scene ${reference.id} is missing.`)
    const existingReference = currentReferences.get(reference.id)
    const existingScene = currentScenes.get(reference.id)
    if (!existingReference || !existingScene) commands.push({ type: 'add-scene', reference: structuredClone(reference), scene: structuredClone(scene) })
    else if (!sameData(existingReference, reference) || !sameData(existingScene, scene)) {
      commands.push({ type: 'replace-scene', sceneId: reference.id, reference: structuredClone(reference), scene: structuredClone(scene) })
    }
  }
  for (const reference of current.project.scenes) if (!targetReferences.has(reference.id)) commands.push({ type: 'remove-scene', sceneId: reference.id })
}

function remapComponent(
  component: WorldComponent,
  componentIds: ReadonlyMap<string, string>,
  entityIds: ReadonlyMap<string, string>,
  bindingIds: ReadonlyMap<string, string>,
): WorldComponent {
  const clone = structuredClone(component)
  clone.id = requiredMapping(componentIds, component.id)
  if (clone.type === 'camera' || clone.type === 'audio-listener') clone.primary = false
  if (clone.type === 'character-controller') clone.colliderComponentId = componentIds.get(clone.colliderComponentId) ?? clone.colliderComponentId
  if (clone.type === 'trigger') clone.colliderComponentId = componentIds.get(clone.colliderComponentId) ?? clone.colliderComponentId
  if (clone.type === 'behavior') {
    clone.bindings = clone.bindings.map((binding) => remapBehaviorBinding(binding, componentIds, entityIds, bindingIds))
  }
  return clone
}

function remapImportedComponent(
  component: WorldComponent,
  componentIds: ReadonlyMap<string, string>,
  entityIds: ReadonlyMap<string, string>,
  bindingIds: ReadonlyMap<string, string>,
  resourceIds: ReadonlyMap<string, string>,
  importedSceneId: string,
  targetSceneId: string,
): WorldComponent {
  const clone = remapComponent(component, componentIds, entityIds, bindingIds)
  if (clone.type === 'renderable' || clone.type === 'animation-player' || clone.type === 'audio-source') {
    clone.resourceId = resourceIds.get(clone.resourceId) ?? clone.resourceId
  } else if (clone.type === 'collider' && (clone.shape === 'convex' || clone.shape === 'mesh')) {
    clone.resourceId = resourceIds.get(clone.resourceId) ?? clone.resourceId
  } else if (clone.type === 'environment' && clone.resourceId) {
    clone.resourceId = resourceIds.get(clone.resourceId) ?? clone.resourceId
  } else if (clone.type === 'behavior') {
    clone.bindings = clone.bindings.map((binding) => ({
      ...binding,
      actions: binding.actions.map((action) => action.type === 'change-scene' && action.sceneId === importedSceneId
        ? { ...action, sceneId: targetSceneId }
        : action),
    }))
  }
  return clone
}

function sameReusableResource(left: WorldResource, right: WorldResource): boolean {
  if (left.type !== right.type || left.workspacePath !== right.workspacePath) return false
  const leftValue = structuredClone(left) as unknown as Record<string, unknown>
  const rightValue = structuredClone(right) as unknown as Record<string, unknown>
  delete leftValue.id
  delete leftValue.name
  delete rightValue.id
  delete rightValue.name
  return sameData(leftValue, rightValue)
}

function remapBehaviorBinding(
  binding: WorldBehaviorBinding,
  componentIds: ReadonlyMap<string, string>,
  entityIds: ReadonlyMap<string, string>,
  bindingIds: ReadonlyMap<string, string>,
): WorldBehaviorBinding {
  return {
    ...structuredClone(binding),
    id: requiredMapping(bindingIds, binding.id),
    event: remapBehaviorEvent(binding.event, componentIds),
    actions: binding.actions.map((action) => remapBehaviorAction(action, componentIds, entityIds)),
  }
}

function remapBehaviorEvent(event: WorldBehaviorEvent, componentIds: ReadonlyMap<string, string>): WorldBehaviorEvent {
  const clone = structuredClone(event)
  if (clone.type === 'trigger-enter' || clone.type === 'trigger-exit') clone.triggerComponentId = componentIds.get(clone.triggerComponentId) ?? clone.triggerComponentId
  return clone
}

function remapBehaviorAction(
  action: WorldBehaviorAction,
  componentIds: ReadonlyMap<string, string>,
  entityIds: ReadonlyMap<string, string>,
): WorldBehaviorAction {
  const clone = structuredClone(action)
  if ('entityId' in clone) clone.entityId = entityIds.get(clone.entityId) ?? clone.entityId
  if ('componentId' in clone) clone.componentId = componentIds.get(clone.componentId) ?? clone.componentId
  return clone
}

function buildBooleanEntityPatchCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  entityIds: readonly string[],
  patch: { enabled: boolean } | { locked: boolean },
): Array<Extract<WorldCommand, { type: 'patch-entity' }>> {
  const scene = requireScene(snapshot, sceneId)
  const commands = uniqueSortedIds(entityIds).map((id) => {
    requireEntity(scene, id)
    return { type: 'patch-entity' as const, sceneId, entityId: id, patch: { ...patch } }
  })
  assertNonEmptyCommands(commands)
  assertCommandLimit(commands)
  return commands
}

function collectSnapshotIds(snapshot: WorldProjectSnapshotV1): Set<string> {
  const ids = new Set<string>([
    snapshot.project.projectId,
    snapshot.project.startSceneId,
    snapshot.project.activeGraphicsProfileId,
  ])
  for (const resource of snapshot.project.resources) ids.add(resource.id)
  for (const scene of snapshot.scenes) {
    ids.add(scene.sceneId)
    for (const entity of scene.entities) {
      ids.add(entity.id)
      for (const component of entity.components) {
        ids.add(component.id)
        if (component.type === 'behavior') for (const binding of component.bindings) ids.add(binding.id)
      }
    }
    for (const sequence of scene.sequences) {
      ids.add(sequence.id)
      for (const track of sequence.tracks) {
        ids.add(track.id)
        for (const keyframe of track.keyframes) ids.add(keyframe.id)
      }
    }
  }
  for (const action of snapshot.project.inputActions) ids.add(action.id)
  for (const profile of snapshot.project.graphicsProfiles) ids.add(profile.id)
  return ids
}

function allocateGeneratedId(generator: WorldEditorIdentityGenerator, used: Set<string>, namespace: string, hint: string): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = generator.nextId(namespace, `${hint}:${attempt}`)
    assertCanonicalId(id, namespace)
    if (!used.has(id)) {
      used.add(id)
      return id
    }
  }
  throw new WorldEditorCommandBuilderError('id-collision', `Unable to allocate a unique ${namespace} id.`)
}

function normalizeNamespace(namespace: string): string {
  const normalized = namespace.trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) throw new WorldEditorCommandBuilderError('id-namespace', 'Identity namespace is invalid.')
  return normalized
}

function requireScene(snapshot: WorldProjectSnapshotV1, sceneId: string): WorldSceneDocumentV1 {
  assertCanonicalId(sceneId, 'scene')
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  if (!scene) throw new WorldEditorCommandBuilderError('scene-missing', `Scene ${sceneId} does not exist.`)
  return scene
}

function requireEntity(scene: WorldSceneDocumentV1, entityId: string): WorldEntity {
  assertCanonicalId(entityId, 'entity')
  const entity = scene.entities.find((candidate) => candidate.id === entityId)
  if (!entity) throw new WorldEditorCommandBuilderError('entity-missing', `Entity ${entityId} does not exist.`)
  return entity
}

function requireActiveSceneId(context: WorldEditorBuilderContext): string {
  if (!context.activeSceneId) throw new WorldEditorCommandBuilderError('scene-required', 'An active scene is required.')
  return context.activeSceneId
}

function assertProjectKey(projectKey: string): void {
  if (!isWorldProjectKey(projectKey)) throw new WorldEditorCommandBuilderError('project-key', 'Project key is invalid.')
}

function assertCanonicalId(id: string, label: string): void {
  if (!isWorldCanonicalId(id)) throw new WorldEditorCommandBuilderError('identifier', `${label} id is not canonical.`)
}

function requiredName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 512 || name.includes('\0')) throw new WorldEditorCommandBuilderError('name', 'Name must be non-empty and at most 512 characters.')
  return name
}

function identityTransform(): WorldTransform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
}

function cloneTransform(transform: WorldTransform): WorldTransform {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
}

function uniqueSortedIds(ids: readonly string[]): string[] {
  const result = [...new Set(ids)].sort(codeUnitCompare)
  if (result.length !== ids.length) throw new WorldEditorCommandBuilderError('duplicate-entity', 'Selection contains duplicate entity ids.')
  if (!result.length) throw new WorldEditorCommandBuilderError('empty-selection', 'Selection cannot be empty.')
  return result
}

function hasAncestorInSet(id: string, selected: ReadonlySet<string>, entities: ReadonlyMap<string, WorldEntity>): boolean {
  const visited = new Set<string>([id])
  let parentId = entities.get(id)?.parentId ?? null
  while (parentId && !visited.has(parentId)) {
    if (selected.has(parentId)) return true
    visited.add(parentId)
    parentId = entities.get(parentId)?.parentId ?? null
  }
  return false
}

function collectDescendants(rootId: string, entities: readonly WorldEntity[], output: Set<string>): void {
  output.add(rootId)
  let changed = true
  while (changed) {
    changed = false
    for (const entity of entities) {
      if (entity.parentId && output.has(entity.parentId) && !output.has(entity.id)) {
        output.add(entity.id)
        changed = true
      }
    }
  }
}

function entityDepth(entity: WorldEntity, entities: ReadonlyMap<string, WorldEntity>): number {
  let depth = 0
  const visited = new Set<string>([entity.id])
  let parentId = entity.parentId
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    depth += 1
    parentId = entities.get(parentId)?.parentId ?? null
  }
  return depth
}

function requiredMapping(map: ReadonlyMap<string, string>, id: string): string {
  const value = map.get(id)
  if (!value) throw new WorldEditorCommandBuilderError('identity-map', `Missing remapped identity for ${id}.`)
  return value
}

function assertNonEmptyCommands(commands: readonly WorldCommand[]): void {
  if (!commands.length) throw new WorldEditorCommandBuilderError('commands-empty', 'Builder must emit at least one command.')
}

function assertCommandLimit(commands: readonly WorldCommand[]): void {
  if (commands.length > WORLD_MAX_COLLECTION_ITEMS) throw new WorldEditorCommandBuilderError('command-limit', `Builder cannot emit more than ${WORLD_MAX_COLLECTION_ITEMS} commands.`)
}

function sameData(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right)
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.entries(value).sort(([left], [right]) => codeUnitCompare(left, right)).map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`
}

function digest128(value: string): string {
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed, lane) => fnv1a32(`${lane}:${value}`, seed).toString(16).padStart(8, '0'))
    .join('')
}

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
