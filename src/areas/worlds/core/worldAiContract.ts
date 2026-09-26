import { parseWorldTransformDocument } from './worldDocuments.ts'
import { parseWorldCommandBatch, type WorldCommand } from './worldCommands.ts'
import { parseWorldComponent, type WorldComponent, type WorldLightComponent, type WorldCameraComponent, type WorldColliderComponent, type WorldRigidBodyComponent, type WorldRenderableComponent, type WorldComponentType } from './worldComponentRegistry.ts'
import type { WorldProjectSnapshotV1, WorldTransform, WorldModelResource, WorldSceneEnvironment } from './worldModel.ts'
import { isWorldCanonicalId } from './worldValidationLimits.ts'
import { normalizeWorldWireValue, isSafeWorldWireRecord } from './worldWireValidation.ts'
import { isWorldProjectKey } from '../../../shared/types/worldProjects.ts'

export const WORLD_AI_QUERY_BYTES = 8 * 1024
export const WORLD_AI_PAGE_BYTES = 32 * 1024
export const WORLD_AI_COMMAND_BYTES = 16 * 1024
export const WORLD_AI_CONTEXT_SCHEMA = 'modly.world-ai-context.v1' as const

/** Correlation and optimistic assertions, never a filesystem or execution capability. */
export interface WorldAiContext {
  schema: typeof WORLD_AI_CONTEXT_SCHEMA
  projectKey: string
  projectId: string
  baseRevision: number
  activeSceneId: string
  editorEpoch: number
  originSessionId: string
  requestId: string
}
export interface WorldAiQuery {
  kind: 'project' | 'scenes' | 'entities' | 'components' | 'resources'
  entityId?: string
  source?: 'project' | 'workflows' | 'exports'
  format?: WorldModelResource['format']
  cursor?: string
  pageSize?: number
}
export interface WorldAiQueryRequest { context: WorldAiContext; query: WorldAiQuery }
export type WorldAiQueryItem =
  | { kind: 'project'; id: string; name: string; revision: number; startSceneId: string; sceneCount: number; resourceCount: number; capabilities?: readonly string[] }
  | { kind: 'scene'; id: string; name: string; isActive: boolean; isStart: boolean; entityCount: number }
  | { kind: 'entity'; id: string; name: string; parentId: string | null; enabled: boolean; locked: boolean; transform: WorldTransform; componentCount: number }
  | { kind: 'component'; id: string; entityId: string; type: WorldComponentType; enabled: boolean; current?: WorldAiCurrentComponent }
  | WorldAiResourceRow
export interface WorldAiQueryPage { context: WorldAiContext; kind: WorldAiQuery['kind']; items: WorldAiQueryItem[]; total: number; nextCursor: string | null }
export type WorldAiLegacyCommand =
  | { type: 'patch-entity'; sceneId: string; entityId: string; patch: { name?: string; enabled?: boolean; transform?: WorldTransform } }
  | { type: 'replace-component'; sceneId: string; entityId: string; componentId: string; component: WorldLightComponent }
export type WorldAiReference = { kind: 'existing'; id: string } | { kind: 'local'; localRef: string }
export type WorldAiCameraOptions = Partial<Omit<WorldCameraComponent, 'id' | 'type' | 'enabled' | 'primary'>>
export type WorldAiLightOptions =
  | { lightKind: 'ambient'; color?: string; intensity?: number }
  | { lightKind: 'directional'; color?: string; intensity?: number; castShadow?: boolean }
  | { lightKind: 'point'; color?: string; intensity?: number; range?: number; castShadow?: boolean }
  | { lightKind: 'spot'; color?: string; intensity?: number; range?: number; angle?: number; castShadow?: boolean }
export type WorldAiColliderOptions = { sensor?: boolean; friction?: number; restitution?: number; collisionLayer?: number; collisionMask?: number } & (
  { shape: 'box'; halfExtents?: [number, number, number] } | { shape: 'sphere'; radius?: number } | { shape: 'capsule'; radius?: number; halfHeight?: number })
export type WorldAiBodyOptions = Partial<Omit<WorldRigidBodyComponent, 'id' | 'type' | 'enabled'>> & { bodyType: WorldRigidBodyComponent['bodyType'] }
interface WorldAiEntityRecipeBase { type: 'create-entity'; localRef: string; sceneRef: WorldAiReference; parentRef?: WorldAiReference | null; name: string; transform?: WorldTransform }
export type WorldAiCreateEntity = WorldAiEntityRecipeBase & (
  { kind: 'group' } | { kind: 'observed-model'; resourceHandle: string; material?: WorldRenderableComponent['material'] }
  | { kind: 'camera'; camera?: WorldAiCameraOptions } | { kind: 'light'; light: WorldAiLightOptions })
export type WorldAiRecipe =
  | { type: 'create-scene'; localRef: string; name: string }
  | { type: 'set-active-scene-environment'; environment: Pick<WorldSceneEnvironment, 'backgroundColor' | 'ambientIntensity'> }
  | WorldAiCreateEntity
  | { type: 'configure-collider'; sceneRef: WorldAiReference; entityRef: WorldAiReference; componentRef?: WorldAiReference; localRef?: string; collider: WorldAiColliderOptions }
  | { type: 'configure-body'; sceneRef: WorldAiReference; entityRef: WorldAiReference; componentRef?: WorldAiReference; localRef?: string; body: WorldAiBodyOptions }
  | { type: 'reparent'; sceneRef: WorldAiReference; entityRef: WorldAiReference; parentRef: WorldAiReference | null }
export type WorldAiCommand = WorldAiLegacyCommand | WorldAiRecipe
export interface WorldAiResourceRow { kind: 'resource'; id: string; name: string; source: 'project' | 'workflows' | 'exports'; format: WorldModelResource['format']; capability: 'mesh' | 'points' | 'gaussian'; fingerprint: string; dependencyCount: number }
export type WorldAiCurrentComponent = WorldLightComponent | WorldCameraComponent | WorldColliderComponent | WorldRigidBodyComponent
  | (Omit<WorldRenderableComponent, 'resourceId'> & { resourceHandle: string })
export interface WorldAiQueryObservations { resources: WorldAiResourceRow[]; resourceHandles?: ReadonlyMap<string, string> }
export const WORLD_AI_CAPABILITIES = Object.freeze(['patch-entity', 'edit-light', 'create-scene', 'set-active-scene-environment', 'create-group', 'create-observed-model', 'create-camera', 'create-light', 'configure-primitive-collider', 'configure-body', 'reparent'])
export const WORLD_AI_MODEL_FORMATS = Object.freeze(['glb', 'gltf', 'ply-mesh', 'ply-points', 'gaussian-ply'] as const)
export function isWorldAiResourceHandle(value: unknown): value is string { return typeof value === 'string' && /^asset_[a-f0-9]{32}$/.test(value) }
export function isWorldAiPromptId(value: unknown): value is string { return isWorldCanonicalId(value) && safeWorldAiText(value) === value }
export function hasWorldAiRecipes(commands: readonly WorldAiCommand[]): boolean { return commands.some((command) => command.type !== 'patch-entity' && command.type !== 'replace-component') }

export interface WorldAiProposal { type: 'world_command_proposal'; context: WorldAiContext; commands: WorldAiCommand[] }
export interface WorldAiPropertyDiff { entityId: string; entityName: string; property: string; before: string; after: string }

export class WorldAiContractError extends Error {
  readonly code: 'invalid_query' | 'revision_conflict' | 'invalid_command'
  constructor(code: WorldAiContractError['code'], message: string) { super(message); this.code = code }
}

export function parseWorldAiContext(value: unknown): WorldAiContext {
  const record = exact(value, ['schema', 'projectKey', 'projectId', 'baseRevision', 'activeSceneId', 'editorEpoch', 'originSessionId', 'requestId'])
  if (record.schema !== WORLD_AI_CONTEXT_SCHEMA || !isWorldProjectKey(record.projectKey)
    || !isWorldAiPromptId(record.projectId) || !isWorldAiPromptId(record.activeSceneId)
    || !safeInteger(record.baseRevision) || !safeInteger(record.editorEpoch)
    || !safeToken(record.originSessionId) || !safeToken(record.requestId)) invalid('Invalid Worlds request context.')
  return { schema: WORLD_AI_CONTEXT_SCHEMA, projectKey: record.projectKey, projectId: record.projectId, baseRevision: record.baseRevision,
    activeSceneId: record.activeSceneId, editorEpoch: record.editorEpoch, originSessionId: record.originSessionId, requestId: record.requestId }
}

export function sameWorldAiContext(left: WorldAiContext, right: WorldAiContext): boolean {
  return Object.keys(left).length === Object.keys(right).length
    && (Object.keys(left) as Array<keyof WorldAiContext>).every((key) => left[key] === right[key])
}

export function parseWorldAiQueryRequest(value: unknown): WorldAiQueryRequest {
  bounded(value, WORLD_AI_QUERY_BYTES)
  const record = exact(value, ['context', 'query'])
  const context = parseWorldAiContext(record.context)
  const query = exact(record.query, ['kind', 'entityId', 'source', 'format', 'cursor', 'pageSize'], ['kind'])
  if (query.kind !== 'project' && query.kind !== 'scenes' && query.kind !== 'entities' && query.kind !== 'components' && query.kind !== 'resources') invalid('Invalid Worlds query kind.')
  if (query.entityId !== undefined && ((query.kind !== 'entities' && query.kind !== 'components') || !isWorldAiPromptId(query.entityId))) invalid('Invalid entity filter.')
  if (query.source !== undefined && (query.kind !== 'resources' || !['project', 'workflows', 'exports'].includes(String(query.source)))) invalid('Invalid resource source filter.')
  if (query.format !== undefined && (query.kind !== 'resources' || !WORLD_AI_MODEL_FORMATS.includes(query.format as WorldModelResource['format']))) invalid('Invalid resource format filter.')
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 2048 || !query.cursor)) invalid('Invalid query cursor.')
  if (query.pageSize !== undefined && (!safeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 50)) invalid('Page size must be an integer from 1 to 50.')
  return { context, query: { kind: query.kind, ...(query.source !== undefined ? { source: query.source as WorldAiQuery['source'] } : {}), ...(query.format !== undefined ? { format: query.format as WorldAiQuery['format'] } : {}), ...(query.entityId !== undefined ? { entityId: query.entityId as string } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor as string } : {}), ...(query.pageSize !== undefined ? { pageSize: query.pageSize as number } : {}) } }
}

export function parseWorldAiProposal(value: unknown): WorldAiProposal {
  bounded(value, WORLD_AI_COMMAND_BYTES + WORLD_AI_QUERY_BYTES)
  const record = exact(value, ['type', 'context', 'commands'])
  if (record.type !== 'world_command_proposal') invalid('Invalid Worlds proposal.')
  const context = parseWorldAiContext(record.context)
  bounded({ commands: record.commands }, WORLD_AI_COMMAND_BYTES)
  if (!Array.isArray(record.commands) || record.commands.length < 1 || record.commands.length > 16) invalid('A Worlds proposal requires 1–16 commands.')
  const commands = record.commands.map((value): WorldAiCommand => {
    const command = exact(value, ['type', 'sceneId', 'entityId', 'patch', 'componentId', 'component', 'localRef', 'name', 'kind', 'sceneRef', 'entityRef', 'parentRef', 'transform', 'resourceHandle', 'material', 'camera', 'light', 'componentRef', 'collider', 'body', 'environment'], ['type'])
    if (command.type !== 'patch-entity' && command.type !== 'replace-component') return parseWorldAiRecipe(command)
    const parsed = parseWorldCommandBatch({ schema: 'modly.world-command-batch.v1', transactionId: context.requestId,
      projectId: context.projectId, baseRevision: context.baseRevision, origin: 'ai', commands: [value] })
    if (!parsed.success) invalid('Worlds proposal contains invalid commands.')
    const legacy = parsed.value.commands[0]
    if (!('sceneId' in legacy) || legacy.sceneId !== context.activeSceneId) invalid('Commands must target the captured active scene.')
    if (!('entityId' in legacy) || !isWorldAiPromptId(legacy.entityId)) invalid('Invalid prompt target identity.')
    if (legacy.type === 'patch-entity') {
      if (Object.keys(legacy.patch).some((key) => !['name', 'enabled', 'transform'].includes(key))) invalid('This entity property is not available to AI.')
      if (legacy.patch.name !== undefined) recipeName(legacy.patch.name)
      return legacy
    }
    if (legacy.type === 'replace-component' && legacy.component.type === 'light' && legacy.componentId === legacy.component.id
      && isWorldAiPromptId(legacy.componentId)) return { ...legacy, component: legacy.component }
    invalid('Only existing entity properties and light color/intensity may be proposed.')
  })
  return { type: 'world_command_proposal', context, commands }
}

export function assertWorldAiSnapshot(snapshot: WorldProjectSnapshotV1, context: WorldAiContext): void {
  if (snapshot.project.projectId !== context.projectId || snapshot.project.revision !== context.baseRevision
    || !snapshot.scenes.some((scene) => scene.sceneId === context.activeSceneId)) {
    throw new WorldAiContractError('revision_conflict', 'The World changed. Ask again from the current scene.')
  }
}

/** Pure allowlisted projection: paths, resource documents and runtime objects never enter the result. */
export function projectWorldAiQuery(snapshot: WorldProjectSnapshotV1, value: unknown, observations?: WorldAiQueryObservations): WorldAiQueryPage {
  const { context, query } = parseWorldAiQueryRequest(value)
  assertWorldAiSnapshot(snapshot, context)
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === context.activeSceneId)!
  if (query.entityId && !scene.entities.some((entity) => entity.id === query.entityId)) invalid('The entity does not exist in this scene.')
  let items: WorldAiQueryItem[]
  switch (query.kind) {
    case 'project': items = [{ kind: 'project', id: context.projectId, name: safeWorldAiText(snapshot.project.name), revision: context.baseRevision,
      startSceneId: snapshot.project.startSceneId, sceneCount: snapshot.project.scenes.length, resourceCount: snapshot.project.resources.length, capabilities: WORLD_AI_CAPABILITIES }]; break
    case 'scenes': items = snapshot.project.scenes.map((ref) => ({ kind: 'scene', id: ref.id, name: safeWorldAiText(ref.name), isActive: ref.id === context.activeSceneId,
      isStart: ref.id === snapshot.project.startSceneId, entityCount: snapshot.scenes.find((candidate) => candidate.sceneId === ref.id)?.entities.length ?? 0 })); break
    case 'entities': items = scene.entities.filter((entity) => !query.entityId || entity.id === query.entityId).map((entity) => ({ kind: 'entity', id: entity.id,
      name: safeWorldAiText(entity.name), parentId: entity.parentId, enabled: entity.enabled, locked: entity.locked,
      transform: structuredClone(entity.transform), componentCount: entity.components.length })); break
    case 'components': items = scene.entities.filter((entity) => !query.entityId || entity.id === query.entityId).flatMap((entity) => entity.components.map((component): WorldAiQueryItem => ({
      kind: 'component', id: component.id, entityId: entity.id, type: component.type, enabled: component.enabled,
      ...projectWorldAiCurrentComponent(component, observations?.resourceHandles),
    }))); break
    case 'resources':
      if (!observations) invalid('Resource discovery requires host source observations.')
      items = observations.resources.filter((row) => (!query.source || row.source === query.source) && (!query.format || row.format === query.format)).map((row) => structuredClone(row)); break
  }
  for (const item of items) {
    if (item.kind === 'resource') { if (!isWorldAiResourceHandle(item.id) || safeWorldAiText(item.name) !== item.name || !/^[a-f0-9]{64}$/.test(item.fingerprint)) invalid('Unsafe resource observation.') }
    else if (!isWorldAiPromptId(item.id) || (item.kind === 'entity' && item.parentId !== null && !isWorldAiPromptId(item.parentId))
      || (item.kind === 'component' && !isWorldAiPromptId(item.entityId)) || (item.kind === 'project' && !isWorldAiPromptId(item.startSceneId))) invalid('Unsafe canonical prompt identity.')
  }
  items.sort((a, b) => compare(a.kind === 'component' ? a.entityId : '', b.kind === 'component' ? b.entityId : '') || compare(a.id, b.id))
  const scope = worldAiQueryScope(context, query)
  let offset = 0
  if (query.cursor !== undefined) {
    let cursor: unknown
    try { cursor = JSON.parse(query.cursor) } catch { invalid('Invalid query cursor.') }
    if (!Array.isArray(cursor) || cursor.length !== 2 || cursor[0] !== scope || !safeInteger(cursor[1]) || cursor[1] < 1 || cursor[1] >= items.length) invalid('The cursor belongs to another query or revision.')
    offset = cursor[1]
  }
  const pageItems: WorldAiQueryItem[] = []
  const result: WorldAiQueryPage = { context, kind: query.kind, items: pageItems, total: items.length, nextCursor: null }
  for (const item of items.slice(offset, offset + (query.pageSize ?? 50))) {
    pageItems.push(item)
    result.nextCursor = offset + pageItems.length < items.length ? JSON.stringify([scope, offset + pageItems.length]) : null
    if (byteLength(result) > WORLD_AI_PAGE_BYTES - 32) {
      pageItems.pop()
      if (!pageItems.length) invalid('A query item exceeds its byte limit.')
      result.nextCursor = JSON.stringify([scope, offset + pageItems.length])
      break
    }
  }
  bounded(result, WORLD_AI_PAGE_BYTES - 32)
  return result
}

/** Validate against current canonical values, not model-supplied defaults. */
export function validateWorldAiCommands(snapshot: WorldProjectSnapshotV1, context: WorldAiContext, values: unknown): WorldAiLegacyCommand[] {
  const { commands } = parseWorldAiProposal({ type: 'world_command_proposal', context, commands: values })
  assertWorldAiSnapshot(snapshot, context)
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === context.activeSceneId)!
  if (hasWorldAiRecipes(commands)) invalid('Creation recipes require the host compiler.')
  const legacyCommands = commands as WorldAiLegacyCommand[]
  for (const command of legacyCommands) {
    const entity = scene.entities.find((candidate) => candidate.id === command.entityId)
    if (!entity) invalid('The target entity no longer exists.')
    if (command.type === 'replace-component') {
      const current = entity.components.find((candidate) => candidate.id === command.componentId)
      if (!current || current.type !== 'light') invalid('The target must be an existing light.')
      const preserved = (light: WorldLightComponent) => JSON.stringify(Object.keys(light).sort().filter((key) => key !== 'color' && key !== 'intensity').map((key) => [key, Reflect.get(light, key)]))
      if (preserved(current) !== preserved(command.component)) invalid('Light edits must preserve every property except color and intensity.')
    }
  }
  return legacyCommands
}

/** Project the existing canonical preview candidate; never simulate command execution here. */
export function describeWorldAiCandidate(snapshot: WorldProjectSnapshotV1, candidate: WorldProjectSnapshotV1, _commands: readonly (WorldAiCommand | WorldCommand)[]): WorldAiPropertyDiff[] {
  const diffs: WorldAiPropertyDiff[] = []
  const add = (id: string, name: string, property: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return
    const text = (value: unknown) => safeWorldAiText(typeof value === 'string' ? value : JSON.stringify(value) ?? 'None')
    diffs.push({ entityId: id, entityName: safeWorldAiText(name), property: safeWorldAiText(property), before: text(before), after: text(after) })
  }
  const ids = <T>(left: readonly T[], right: readonly T[], id: (value: T) => string) => [...new Set([...left, ...right].map(id))].sort(compare)
  for (const id of ids(snapshot.project.resources, candidate.project.resources, (resource) => resource.id)) {
    const before = snapshot.project.resources.find((resource) => resource.id === id)
    const after = candidate.project.resources.find((resource) => resource.id === id)
    if (!before || !after) add(id, (after ?? before)!.name, 'resource', before ? 'Present' : 'None', after ? 'Created' : 'Removed')
    else for (const key of ['name', 'type'] as const) add(id, before.name, `resource.${key}`, before[key], after[key])
  }
  for (const id of ids(snapshot.scenes, candidate.scenes, (scene) => scene.sceneId)) {
    const before = snapshot.scenes.find((scene) => scene.sceneId === id)
    const after = candidate.scenes.find((scene) => scene.sceneId === id)
    if (!before || !after) add(id, (after ?? before)!.name, 'scene', before ? 'Present' : 'None', after ? 'Created' : 'Removed')
    else add(id, before.name, 'scene.name', before.name, after.name)
    for (const entityId of ids(before?.entities ?? [], after?.entities ?? [], (entity) => entity.id)) {
      const entity = before?.entities.find((entry) => entry.id === entityId)
      const next = after?.entities.find((entry) => entry.id === entityId)
      const name = (entity ?? next)!.name
      if (!entity || !next) add(entityId, name, 'entity', entity ? 'Present' : 'None', next ? 'Created' : 'Removed')
      for (const key of ['name', 'enabled', 'parentId'] as const) add(entityId, name, key, entity?.[key] ?? null, next?.[key] ?? null)
      for (const key of ['position', 'rotation', 'scale'] as const) add(entityId, name, key, entity?.transform[key] ?? null, next?.transform[key] ?? null)
      for (const componentId of ids(entity?.components ?? [], next?.components ?? [], (component) => component.id)) {
        const component = entity?.components.find((entry) => entry.id === componentId)
        const replacement = next?.components.find((entry) => entry.id === componentId)
        if (!component || !replacement) add(entityId, name, `${componentId}.component`, component ? component.type : 'None', replacement ? `${replacement.type} created` : 'Removed')
        const safe = (entry: WorldComponent | undefined, world: WorldProjectSnapshotV1): Record<string, unknown> => {
          if (!entry) return {}
          if (entry.type === 'renderable') return { enabled: entry.enabled, visible: entry.visible, castShadow: entry.castShadow, receiveShadow: entry.receiveShadow,
            model: safeWorldAiText(world.project.resources.find((resource) => resource.id === entry.resourceId)?.name ?? 'Observed model'),
            ...Object.fromEntries(Object.entries(entry.material).map(([key, value]) => [`material.${key}`, value])) }
          const current = projectWorldAiCurrentComponent(entry).current
          return current ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'id' && key !== 'type')) : {}
        }
        const left = safe(component, snapshot); const right = safe(replacement, candidate)
        for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compare)) add(entityId, name, `${componentId}.${key}`, left[key] ?? null, right[key] ?? null)
      }
    }
  }
  if (!diffs.length) invalid('The proposal does not change any supported property.')
  return diffs
}

export function worldAiQueryScope(context: WorldAiContext, query: WorldAiQuery): string {
  return JSON.stringify(query.kind === 'resources' ? [context, query.kind, null, query.source ?? null, query.format ?? null] : [context, query.kind, query.entityId ?? null])
}

export function projectWorldAiCurrentComponent(component: WorldComponent, handles?: ReadonlyMap<string, string>): { current?: WorldAiCurrentComponent } {
  if (component.type === 'light' || component.type === 'camera' || component.type === 'rigid-body'
    || (component.type === 'collider' && ['box', 'sphere', 'capsule'].includes(component.shape))) return { current: structuredClone(component) }
  if (component.type === 'renderable') {
    const resourceHandle = handles?.get(component.resourceId)
    if (resourceHandle) { const { resourceId: _privateId, ...value } = component; return { current: { ...structuredClone(value), resourceHandle } } }
  }
  return {}
}

function parseWorldAiRecipe(value: Record<string, unknown>): WorldAiRecipe {
  const ref = (value: unknown): WorldAiReference => {
    if (!isSafeWorldWireRecord(value)) invalid('Invalid recipe reference.')
    if (value.kind === 'existing') { exact(value, ['kind', 'id']); if (!isWorldAiPromptId(value.id)) invalid('Invalid existing reference.') }
    else if (value.kind === 'local') { exact(value, ['kind', 'localRef']); if (!safeToken(value.localRef)) invalid('Invalid local reference.') }
    else invalid('Invalid recipe reference kind.')
    return value as unknown as WorldAiReference
  }
  if (value.type === 'create-scene') { exact(value, ['type', 'localRef', 'name']); recipeName(value.name); if (!safeToken(value.localRef)) invalid('Invalid local name.'); return value as unknown as WorldAiRecipe }
  if (value.type === 'set-active-scene-environment') {
    exact(value, ['type', 'environment'])
    const environment = exact(value.environment, ['backgroundColor', 'ambientIntensity'])
    if (typeof environment.backgroundColor !== 'string' || !/^#[a-f0-9]{6}$/i.test(environment.backgroundColor)
      || typeof environment.ambientIntensity !== 'number' || !Number.isFinite(environment.ambientIntensity)
      || environment.ambientIntensity < 0 || environment.ambientIntensity > 10) invalid('Invalid bounded active-scene environment.')
    return value as unknown as WorldAiRecipe
  }
  const entityRecipe = value.type === 'create-entity'
  const configure = value.type === 'configure-collider' || value.type === 'configure-body'
  if (!entityRecipe && !configure && value.type !== 'reparent') invalid('Unsupported creation recipe.')
  ref(value.sceneRef)
  if (entityRecipe) {
    const common = ['type', 'kind', 'localRef', 'sceneRef', 'parentRef', 'name', 'transform']
    const extra = value.kind === 'group' ? [] : value.kind === 'observed-model' ? ['resourceHandle', 'material'] : value.kind === 'camera' ? ['camera'] : value.kind === 'light' ? ['light'] : null
    if (!extra) invalid('Unsupported entity kind.')
    exact(value, [...common, ...extra], ['type', 'kind', 'localRef', 'sceneRef', 'name', ...(value.kind === 'observed-model' ? ['resourceHandle'] : value.kind === 'light' ? ['light'] : [])])
    if (!safeToken(value.localRef)) invalid('Invalid local name.'); recipeName(value.name)
    if (Object.hasOwn(value, 'transform') && !parseWorldTransformDocument(value.transform).success) invalid('Invalid full local transform.')
    if (Object.hasOwn(value, 'parentRef') && value.parentRef !== null) ref(value.parentRef)
    if (value.kind === 'observed-model') {
      if (!isWorldAiResourceHandle(value.resourceHandle)) invalid('Invalid observed resource handle.')
      if (Object.hasOwn(value, 'material')) {
        const material = exact(value.material, ['baseColor', 'metallic', 'roughness', 'opacity'])
        if (typeof material.baseColor !== 'string' || !/^#[a-f0-9]{6}$/i.test(material.baseColor)
          || ['metallic', 'roughness', 'opacity'].some((key) => typeof material[key] !== 'number' || !Number.isFinite(material[key]) || (material[key] as number) < 0 || (material[key] as number) > 1)) invalid('Invalid PBR material.')
      }
    } else if (value.kind === 'camera') { if (Object.hasOwn(value, 'camera')) worldAiCameraComponent('component:ai-options', value.camera) }
    else if (value.kind === 'light') worldAiLightComponent('component:ai-options', value.light)
  } else {
    exact(value, configure ? ['type', 'sceneRef', 'entityRef', 'componentRef', 'localRef', value.type === 'configure-collider' ? 'collider' : 'body'] : ['type', 'sceneRef', 'entityRef', 'parentRef'], ['type', 'sceneRef', 'entityRef', configure ? value.type === 'configure-collider' ? 'collider' : 'body' : 'parentRef'])
    ref(value.entityRef)
    if (configure) {
      if (Object.hasOwn(value, 'componentRef')) ref(value.componentRef)
      if (Object.hasOwn(value, 'localRef') && !safeToken(value.localRef)) invalid('Invalid local name.')
      if (value.type === 'configure-collider') worldAiColliderComponent('component:ai-options', value.collider)
      else worldAiBodyComponent('component:ai-options', value.body)
    } else if (value.parentRef !== null) ref(value.parentRef)
  }
  return value as unknown as WorldAiRecipe
}

export function worldAiCameraComponent(id: string, value: unknown = {}): WorldCameraComponent {
  const options = exact(value, ['projection', 'near', 'far', 'fieldOfView', 'orthographicSize'], [])
  if (Object.hasOwn(options, 'projection') && options.projection !== 'perspective' && options.projection !== 'orthographic') invalid('Invalid camera projection.')
  const projection = options.projection ?? 'perspective'
  return typedComponent({ id, type: 'camera', enabled: true, primary: false, near: 0.1, far: 1000,
    ...(projection === 'orthographic' ? { orthographicSize: 10 } : { fieldOfView: 60 }), ...options, projection }, 'camera')
}
export function worldAiLightComponent(id: string, value: unknown): WorldLightComponent {
  const options = exact(value, ['lightKind', 'color', 'intensity', 'castShadow', 'range', 'angle'], ['lightKind'])
  const kind = options.lightKind
  const keys = kind === 'ambient' ? ['lightKind', 'color', 'intensity'] : kind === 'directional' ? ['lightKind', 'color', 'intensity', 'castShadow'] : kind === 'point' ? ['lightKind', 'color', 'intensity', 'castShadow', 'range'] : ['lightKind', 'color', 'intensity', 'castShadow', 'range', 'angle']
  exact(options, keys, ['lightKind'])
  return typedComponent({ id, type: 'light', enabled: true, color: '#ffffff', intensity: 1,
    ...(kind !== 'ambient' ? { castShadow: true } : {}), ...(kind === 'point' || kind === 'spot' ? { range: 10 } : {}), ...(kind === 'spot' ? { angle: Math.PI / 4 } : {}), ...options }, 'light')
}
export function worldAiColliderComponent(id: string, value: unknown): WorldColliderComponent {
  const options = exact(value, ['shape', 'sensor', 'friction', 'restitution', 'collisionLayer', 'collisionMask', 'halfExtents', 'radius', 'halfHeight'], ['shape'])
  const shape = options.shape
  if (shape !== 'box' && shape !== 'sphere' && shape !== 'capsule') invalid('Only primitive simulation colliders are available.')
  return typedComponent({ id, type: 'collider', enabled: true, purpose: 'simulation', sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 65535,
    ...(shape === 'box' ? { halfExtents: [0.5, 0.5, 0.5] } : shape === 'sphere' ? { radius: 0.5 } : { radius: 0.5, halfHeight: 0.5 }), ...options }, 'collider')
}
export function worldAiBodyComponent(id: string, value: unknown): WorldRigidBodyComponent {
  const options = exact(value, ['bodyType', 'gravityScale', 'linearDamping', 'angularDamping', 'canSleep'], ['bodyType'])
  return typedComponent({ id, type: 'rigid-body', enabled: true, gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: true, ...options }, 'rigid-body')
}
function typedComponent<T extends WorldComponent['type']>(value: unknown, type: T): Extract<WorldComponent, { type: T }> {
  const parsed = parseWorldComponent(value)
  if (!parsed.success || parsed.value.type !== type) invalid('Invalid finite component options.')
  return parsed.value as Extract<WorldComponent, { type: T }>
}
function recipeName(value: unknown): asserts value is string { if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256 || safeWorldAiText(value) !== value) invalid('Invalid safe authoring name.') }

export function safeWorldAiText(value: string): string {
  if (value.includes('/') || value.includes('\\') || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || /\b(?:file|https?|data):/i.test(value)) return '[redacted]'
  return value.slice(0, 512)
}

function bounded(value: unknown, limit: number): void {
  const normalized = normalizeWorldWireValue(value, 'worldAi')
  if (!normalized.success || byteLength(normalized.value) > limit) invalid('Worlds request exceeds its safe data bounds.')
}
function byteLength(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength }
function exact(value: unknown, keys: string[], required = keys): Record<string, unknown> {
  if (!isSafeWorldWireRecord(value) || Object.keys(value).some((key) => !keys.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) invalid('Worlds data contains missing or unknown fields.')
  return value
}
function safeToken(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value) }
function safeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function invalid(message: string): never { throw new WorldAiContractError('invalid_query', message) }

// Compile-time confirmation that the exposed command subset uses the canonical bus.
export function worldAiCanonicalCommands(commands: WorldAiLegacyCommand[]): WorldCommand[] { return commands }
