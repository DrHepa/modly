import { parseWorldComponent, type WorldComponent } from './worldComponentRegistry.ts'
import {
  cloneWorldProjectSnapshot,
  normalizeWorldWorkspacePath,
  parseWorldEntityDocument,
  parseWorldGraphicsProfilesDocument,
  parseWorldInputActionsDocument,
  parseWorldResourceDocument,
  parseWorldSceneDocument,
  parseWorldSceneEnvironmentDocument,
  parseWorldSequenceDocument,
  parseWorldTransformDocument,
  validateWorldProjectSnapshot,
  type WorldDocumentIssue,
} from './worldDocuments.ts'
import {
  WORLD_COMMAND_BATCH_SCHEMA,
  type WorldEntity,
  type WorldGraphicsProfile,
  type WorldInputAction,
  type WorldProjectSnapshotV1,
  type WorldResource,
  type WorldSceneDocumentV1,
  type WorldSceneEnvironment,
  type WorldSceneReference,
  type WorldSequence,
  type WorldTransform,
} from './worldModel.ts'
import {
  canContinueWorldSemanticValidation,
  isWorldCanonicalId,
  WORLD_MAX_COLLECTION_ITEMS,
  WORLD_MAX_RECORD_KEYS,
  WORLD_MAX_SEMANTIC_ISSUES,
} from './worldValidationLimits.ts'
import { isSafeWorldWireRecord, normalizeWorldWireValue } from './worldWireValidation.ts'

export type WorldCommandOrigin = 'ui' | 'workflow' | 'ai' | 'migration' | 'undo' | 'redo'

export interface WorldEntityPatch {
  name?: string
  enabled?: boolean
  locked?: boolean
  tags?: string[]
  transform?: WorldTransform
}

export type WorldCommand =
  | { type: 'rename-project'; name: string }
  | { type: 'set-start-scene'; sceneId: string }
  | { type: 'replace-input-actions'; inputActions: WorldInputAction[] }
  | { type: 'replace-graphics-profiles'; graphicsProfiles: WorldGraphicsProfile[]; activeGraphicsProfileId: string }
  | { type: 'add-resource'; resource: WorldResource }
  | { type: 'replace-resource'; resourceId: string; resource: WorldResource }
  | { type: 'remove-resource'; resourceId: string }
  | { type: 'add-scene'; reference: WorldSceneReference; scene: WorldSceneDocumentV1 }
  | { type: 'replace-scene'; sceneId: string; reference: WorldSceneReference; scene: WorldSceneDocumentV1 }
  | { type: 'remove-scene'; sceneId: string }
  | { type: 'set-scene-environment'; sceneId: string; environment: WorldSceneEnvironment }
  | { type: 'add-sequence'; sceneId: string; sequence: WorldSequence }
  | { type: 'replace-sequence'; sceneId: string; sequenceId: string; sequence: WorldSequence }
  | { type: 'remove-sequence'; sceneId: string; sequenceId: string }
  | { type: 'add-entity'; sceneId: string; entity: WorldEntity }
  | { type: 'patch-entity'; sceneId: string; entityId: string; patch: WorldEntityPatch }
  | { type: 'reparent-entity'; sceneId: string; entityId: string; parentId: string | null }
  | { type: 'remove-entity'; sceneId: string; entityId: string; cascade: boolean }
  | { type: 'add-component'; sceneId: string; entityId: string; component: WorldComponent }
  | { type: 'replace-component'; sceneId: string; entityId: string; componentId: string; component: WorldComponent }
  | { type: 'remove-component'; sceneId: string; entityId: string; componentId: string }

export interface WorldCommandBatchV1 {
  schema: typeof WORLD_COMMAND_BATCH_SCHEMA
  transactionId: string
  projectId: string
  baseRevision: number
  origin: WorldCommandOrigin
  commands: WorldCommand[]
}

export interface WorldCommandIssue {
  code: string
  path: string
  message: string
}

export interface WorldCommandInverse {
  readonly kind: 'world-snapshot'
  readonly snapshot: WorldProjectSnapshotV1
}

export type ParseWorldCommandBatchResult =
  | { success: true; value: WorldCommandBatchV1 }
  | { success: false; issues: WorldCommandIssue[] }

export type ApplyWorldCommandBatchResult =
  | {
      success: true
      snapshot: WorldProjectSnapshotV1
      changes: string[]
      warnings: string[]
      inverse: WorldCommandInverse
      receipt: { transactionId: string; appliedRevision: number }
    }
  | { success: false; issues: WorldCommandIssue[] }

export type ApplyWorldCommandInverseResult =
  | { success: true; snapshot: WorldProjectSnapshotV1; inverse: WorldCommandInverse }
  | { success: false; issues: WorldCommandIssue[] }

export function parseWorldCommandBatch(value: unknown): ParseWorldCommandBatchResult {
  const wire = normalizeWorldWireValue(value, 'batch')
  if (!wire.success) return failed(wire.issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message })))
  value = wire.value
  const issues: WorldCommandIssue[] = []
  if (!isRecord(value)) return failed([{ code: 'type', path: 'batch', message: 'Command batch must be an object.' }])
  rejectUnknownKeys(value, ['schema', 'transactionId', 'projectId', 'baseRevision', 'origin', 'commands'], 'batch', issues)
  if (value.schema !== WORLD_COMMAND_BATCH_SCHEMA) addIssue(issues, 'schema', 'batch.schema', `Schema must be ${WORLD_COMMAND_BATCH_SCHEMA}.`)
  const transactionId = identifier(value.transactionId, 'batch.transactionId', issues)
  const projectId = identifier(value.projectId, 'batch.projectId', issues)
  const baseRevision = revision(value.baseRevision, 'batch.baseRevision', issues)
  if (value.origin !== 'ui' && value.origin !== 'workflow' && value.origin !== 'ai' && value.origin !== 'migration' && value.origin !== 'undo' && value.origin !== 'redo') addIssue(issues, 'origin', 'batch.origin', 'Command batch origin is invalid.')
  const commands: WorldCommand[] = []
  if (!Array.isArray(value.commands) || value.commands.length === 0) addIssue(issues, 'commands', 'batch.commands', 'Command batch must contain at least one command.')
  else if (value.commands.length > WORLD_MAX_COLLECTION_ITEMS) addIssue(issues, 'collection-limit', 'batch.commands', `Command batch cannot contain more than ${WORLD_MAX_COLLECTION_ITEMS} commands.`)
  else {
    for (const [index, command] of value.commands.entries()) {
      if (!canContinueWorldSemanticValidation(issues)) break
      const parsed = parseWorldCommand(command, `batch.commands[${index}]`, issues)
      if (parsed) commands.push(parsed)
    }
  }
  if (issues.length || !transactionId || !projectId || baseRevision === null || (value.origin !== 'ui' && value.origin !== 'workflow' && value.origin !== 'ai' && value.origin !== 'migration' && value.origin !== 'undo' && value.origin !== 'redo')) return failed(issues)
  return { success: true, value: { schema: WORLD_COMMAND_BATCH_SCHEMA, transactionId, projectId, baseRevision, origin: value.origin, commands } }
}

export function applyWorldCommandBatch(snapshot: WorldProjectSnapshotV1, batchValue: unknown): ApplyWorldCommandBatchResult {
  const parsedSnapshot = validateWorldProjectSnapshot(snapshot)
  if (!parsedSnapshot.success) return failed(parsedSnapshot.issues.map(toCommandIssue))
  const parsedBatch = parseWorldCommandBatch(batchValue)
  if (!parsedBatch.success) return parsedBatch
  const batch = parsedBatch.value
  if (batch.projectId !== parsedSnapshot.value.project.projectId) return failed([{ code: 'project-conflict', path: 'batch.projectId', message: 'Command batch targets a different project.' }])
  if (batch.baseRevision !== parsedSnapshot.value.project.revision) return failed([{ code: 'revision-conflict', path: 'batch.baseRevision', message: `Expected revision ${parsedSnapshot.value.project.revision}, received ${batch.baseRevision}.` }])
  if (parsedSnapshot.value.project.revision >= Number.MAX_SAFE_INTEGER) return failed([{ code: 'revision-overflow', path: 'project.revision', message: 'Project revision cannot be advanced safely.' }])

  // Validation owns an isolated graph; only the independent draft is mutated.
  const before = parsedSnapshot.value
  const draft = cloneWorldProjectSnapshot(parsedSnapshot.value)
  const changes = new Set<string>()
  const warnings = new Set<string>()
  for (const [index, command] of batch.commands.entries()) {
    try {
      applyCommand(draft, command, changes, warnings)
    } catch (error) {
      const message = error instanceof WorldCommandApplicationError ? error.message : 'Command could not be applied.'
      const code = error instanceof WorldCommandApplicationError ? error.code : 'command-application'
      const pathSuffix = error instanceof WorldCommandApplicationError ? error.pathSuffix : ''
      return failed([{ code, path: `batch.commands[${index}]${pathSuffix}`, message }])
    }
  }
  draft.project.revision += 1
  const validated = validateWorldProjectSnapshot(draft)
  if (!validated.success) return failed(validated.issues.map(toCommandIssue))
  return {
    success: true,
    snapshot: validated.value,
    changes: [...changes].sort(codeUnitCompare),
    warnings: [...warnings].sort(codeUnitCompare),
    inverse: { kind: 'world-snapshot', snapshot: before },
    receipt: { transactionId: batch.transactionId, appliedRevision: validated.value.project.revision },
  }
}

export function applyWorldCommandInverse(snapshotValue: unknown, inverseValue: unknown): ApplyWorldCommandInverseResult {
  const current = validateWorldProjectSnapshot(snapshotValue)
  if (!current.success) return failed(current.issues.map(toCommandIssue))
  const normalized = normalizeWorldWireValue(inverseValue, 'inverse')
  if (!normalized.success) return failed(normalized.issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message })))
  if (!isRecord(normalized.value)) return failed([{ code: 'inverse', path: 'inverse', message: 'Inverse must be a world snapshot envelope.' }])
  const inverseIssues: WorldCommandIssue[] = []
  rejectUnknownKeys(normalized.value, ['kind', 'snapshot'], 'inverse', inverseIssues)
  if (normalized.value.kind !== 'world-snapshot') addIssue(inverseIssues, 'inverse', 'inverse.kind', 'Inverse kind must be world-snapshot.')
  const previous = validateWorldProjectSnapshot(normalized.value.snapshot)
  if (!previous.success) {
    for (const issue of previous.issues) {
      if (!canContinueWorldSemanticValidation(inverseIssues)) break
      addIssue(inverseIssues, issue.code, `inverse.snapshot${issue.path.startsWith('snapshot') ? issue.path.slice('snapshot'.length) : `.${issue.path}`}`, issue.message)
    }
  }
  if (inverseIssues.length || !previous.success) return failed(inverseIssues)
  if (previous.value.project.projectId !== current.value.project.projectId) return failed([{ code: 'project-conflict', path: 'inverse.snapshot.project.projectId', message: 'Inverse targets a different project.' }])
  if (current.value.project.revision >= Number.MAX_SAFE_INTEGER) return failed([{ code: 'revision-overflow', path: 'project.revision', message: 'Project revision cannot be advanced safely.' }])
  const restored = cloneWorldProjectSnapshot(previous.value)
  restored.project.revision = current.value.project.revision + 1
  const validated = validateWorldProjectSnapshot(restored)
  if (!validated.success) return failed(validated.issues.map(toCommandIssue))
  return {
    success: true,
    snapshot: cloneWorldProjectSnapshot(validated.value),
    inverse: { kind: 'world-snapshot', snapshot: cloneWorldProjectSnapshot(current.value) },
  }
}

export function fingerprintWorldCommandBatch(batch: WorldCommandBatchV1): string {
  const canonical = canonicalWorldCommandBatchPayload(batch)
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`
}

export function canonicalWorldCommandBatchPayload(batch: WorldCommandBatchV1): string {
  return stableSerialize(batch)
}

function parseWorldCommand(value: unknown, path: string, issues: WorldCommandIssue[]): WorldCommand | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    addIssue(issues, 'command-type', path, 'Command must be an object with a type.')
    return null
  }
  if (value.type === 'rename-project') {
    rejectUnknownKeys(value, ['type', 'name'], path, issues)
    const name = nameValue(value.name, `${path}.name`, issues)
    return name ? { type: 'rename-project', name } : null
  }
  if (value.type === 'set-start-scene') {
    rejectUnknownKeys(value, ['type', 'sceneId'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    return sceneId ? { type: 'set-start-scene', sceneId } : null
  }
  if (value.type === 'replace-input-actions') {
    rejectUnknownKeys(value, ['type', 'inputActions'], path, issues)
    const parsed = parseWorldInputActionsDocument(value.inputActions)
    appendDocumentIssues(parsed, path, 'inputActions', issues)
    return parsed.success ? { type: 'replace-input-actions', inputActions: parsed.value } : null
  }
  if (value.type === 'replace-graphics-profiles') {
    rejectUnknownKeys(value, ['type', 'graphicsProfiles', 'activeGraphicsProfileId'], path, issues)
    const parsed = parseWorldGraphicsProfilesDocument(value.graphicsProfiles)
    appendDocumentIssues(parsed, path, 'graphicsProfiles', issues)
    const activeGraphicsProfileId = identifier(value.activeGraphicsProfileId, `${path}.activeGraphicsProfileId`, issues)
    return parsed.success && activeGraphicsProfileId ? { type: 'replace-graphics-profiles', graphicsProfiles: parsed.value, activeGraphicsProfileId } : null
  }
  if (value.type === 'add-resource' || value.type === 'replace-resource') {
    const replacing = value.type === 'replace-resource'
    rejectUnknownKeys(value, replacing ? ['type', 'resourceId', 'resource'] : ['type', 'resource'], path, issues)
    const parsed = parseWorldResourceDocument(value.resource)
    appendDocumentIssues(parsed, path, 'resource', issues)
    if (!parsed.success) return null
    if (!replacing) return { type: 'add-resource', resource: parsed.value }
    const resourceId = identifier(value.resourceId, `${path}.resourceId`, issues)
    return resourceId ? { type: 'replace-resource', resourceId, resource: parsed.value } : null
  }
  if (value.type === 'remove-resource') {
    rejectUnknownKeys(value, ['type', 'resourceId'], path, issues)
    const resourceId = identifier(value.resourceId, `${path}.resourceId`, issues)
    return resourceId ? { type: 'remove-resource', resourceId } : null
  }
  if (value.type === 'add-scene' || value.type === 'replace-scene') {
    const replacing = value.type === 'replace-scene'
    rejectUnknownKeys(value, replacing ? ['type', 'sceneId', 'reference', 'scene'] : ['type', 'reference', 'scene'], path, issues)
    const reference = parseSceneReference(value.reference, `${path}.reference`, issues)
    const scene = parseWorldSceneDocument(value.scene)
    appendDocumentIssues(scene, path, 'scene', issues)
    if (!reference || !scene.success) return null
    if (!replacing) return { type: 'add-scene', reference, scene: scene.value }
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    return sceneId ? { type: 'replace-scene', sceneId, reference, scene: scene.value } : null
  }
  if (value.type === 'remove-scene') {
    rejectUnknownKeys(value, ['type', 'sceneId'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    return sceneId ? { type: 'remove-scene', sceneId } : null
  }
  if (value.type === 'set-scene-environment') {
    rejectUnknownKeys(value, ['type', 'sceneId', 'environment'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    const environment = parseWorldSceneEnvironmentDocument(value.environment)
    appendDocumentIssues(environment, path, 'environment', issues)
    return sceneId && environment.success ? { type: 'set-scene-environment', sceneId, environment: environment.value } : null
  }
  if (value.type === 'add-sequence' || value.type === 'replace-sequence') {
    const replacing = value.type === 'replace-sequence'
    rejectUnknownKeys(value, replacing ? ['type', 'sceneId', 'sequenceId', 'sequence'] : ['type', 'sceneId', 'sequence'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    const sequence = parseWorldSequenceDocument(value.sequence)
    appendDocumentIssues(sequence, path, 'sequence', issues)
    if (!sceneId || !sequence.success) return null
    if (!replacing) return { type: 'add-sequence', sceneId, sequence: sequence.value }
    const sequenceId = identifier(value.sequenceId, `${path}.sequenceId`, issues)
    return sequenceId ? { type: 'replace-sequence', sceneId, sequenceId, sequence: sequence.value } : null
  }
  if (value.type === 'remove-sequence') {
    rejectUnknownKeys(value, ['type', 'sceneId', 'sequenceId'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    const sequenceId = identifier(value.sequenceId, `${path}.sequenceId`, issues)
    return sceneId && sequenceId ? { type: 'remove-sequence', sceneId, sequenceId } : null
  }
  if (value.type === 'add-entity') {
    rejectUnknownKeys(value, ['type', 'sceneId', 'entity'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    const entity = parseWorldEntityDocument(value.entity)
    appendDocumentIssues(entity, path, 'entity', issues)
    return sceneId && entity.success ? { type: 'add-entity', sceneId, entity: entity.value } : null
  }
  if (value.type === 'patch-entity') {
    rejectUnknownKeys(value, ['type', 'sceneId', 'entityId', 'patch'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    const entityId = identifier(value.entityId, `${path}.entityId`, issues)
    const patch = parseEntityPatch(value.patch, `${path}.patch`, issues)
    return sceneId && entityId && patch ? { type: 'patch-entity', sceneId, entityId, patch } : null
  }
  if (value.type === 'reparent-entity') {
    rejectUnknownKeys(value, ['type', 'sceneId', 'entityId', 'parentId'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    const entityId = identifier(value.entityId, `${path}.entityId`, issues)
    const parentId = value.parentId === null ? null : identifier(value.parentId, `${path}.parentId`, issues)
    return sceneId && entityId && (value.parentId === null || parentId) ? { type: 'reparent-entity', sceneId, entityId, parentId } : null
  }
  if (value.type === 'remove-entity') {
    rejectUnknownKeys(value, ['type', 'sceneId', 'entityId', 'cascade'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    const entityId = identifier(value.entityId, `${path}.entityId`, issues)
    if (typeof value.cascade !== 'boolean') addIssue(issues, 'cascade', `${path}.cascade`, 'Cascade must be boolean.')
    return sceneId && entityId && typeof value.cascade === 'boolean' ? { type: 'remove-entity', sceneId, entityId, cascade: value.cascade } : null
  }
  if (value.type === 'add-component' || value.type === 'replace-component') {
    const replacing = value.type === 'replace-component'
    rejectUnknownKeys(value, replacing ? ['type', 'sceneId', 'entityId', 'componentId', 'component'] : ['type', 'sceneId', 'entityId', 'component'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    const entityId = identifier(value.entityId, `${path}.entityId`, issues)
    const component = parseWorldComponent(value.component, `${path}.component`)
    if (!component.success) {
      for (const issue of component.issues) {
        if (!canContinueWorldSemanticValidation(issues)) break
        addIssue(issues, issue.code, issue.path, issue.message)
      }
    }
    if (!sceneId || !entityId || !component.success) return null
    if (!replacing) return { type: 'add-component', sceneId, entityId, component: component.value }
    const componentId = identifier(value.componentId, `${path}.componentId`, issues)
    return componentId ? { type: 'replace-component', sceneId, entityId, componentId, component: component.value } : null
  }
  if (value.type === 'remove-component') {
    rejectUnknownKeys(value, ['type', 'sceneId', 'entityId', 'componentId'], path, issues)
    const sceneId = identifier(value.sceneId, `${path}.sceneId`, issues)
    const entityId = identifier(value.entityId, `${path}.entityId`, issues)
    const componentId = identifier(value.componentId, `${path}.componentId`, issues)
    return sceneId && entityId && componentId ? { type: 'remove-component', sceneId, entityId, componentId } : null
  }
  addIssue(issues, 'command-type', `${path}.type`, `Unsupported command type ${value.type}.`)
  return null
}

function applyCommand(snapshot: WorldProjectSnapshotV1, command: WorldCommand, changes: Set<string>, warnings: Set<string>): void {
  switch (command.type) {
    case 'rename-project': snapshot.project.name = command.name; changes.add('project.name'); return
    case 'set-start-scene': snapshot.project.startSceneId = command.sceneId; changes.add('project.startSceneId'); return
    case 'replace-input-actions': snapshot.project.inputActions = structuredClone(command.inputActions); changes.add('project.inputActions'); return
    case 'replace-graphics-profiles': snapshot.project.graphicsProfiles = structuredClone(command.graphicsProfiles); snapshot.project.activeGraphicsProfileId = command.activeGraphicsProfileId; changes.add('project.activeGraphicsProfileId'); changes.add('project.graphicsProfiles'); return
    case 'add-resource': ensureAbsent(snapshot.project.resources, command.resource.id, 'resource'); snapshot.project.resources.push(structuredClone(command.resource)); changes.add(`resource:${command.resource.id}`); return
    case 'replace-resource': replaceById(snapshot.project.resources, command.resourceId, command.resource, 'resource'); addReplacementChanges(changes, `resource:${command.resourceId}`, `resource:${command.resource.id}`); return
    case 'remove-resource': removeById(snapshot.project.resources, command.resourceId, 'resource'); changes.add(`resource:${command.resourceId}`); return
    case 'add-scene':
      ensureAbsent(snapshot.project.scenes, command.reference.id, 'scene reference')
      ensureAbsent(snapshot.scenes.map((scene) => ({ id: scene.sceneId })), command.scene.sceneId, 'scene document')
      snapshot.project.scenes.push(structuredClone(command.reference)); snapshot.scenes.push(structuredClone(command.scene)); changes.add(`scene:${command.reference.id}`); return
    case 'replace-scene':
      assertSceneHasNoLockedEntities(snapshot, command.sceneId, '.sceneId')
      replaceById(snapshot.project.scenes, command.sceneId, command.reference, 'scene reference')
      replaceSceneDocument(snapshot.scenes, command.sceneId, command.scene)
      addReplacementChanges(changes, `scene:${command.sceneId}`, `scene:${command.reference.id}`); return
    case 'remove-scene': assertSceneHasNoLockedEntities(snapshot, command.sceneId, '.sceneId'); removeById(snapshot.project.scenes, command.sceneId, 'scene reference'); removeSceneDocument(snapshot.scenes, command.sceneId); changes.add(`scene:${command.sceneId}`); return
    case 'set-scene-environment': findScene(snapshot, command.sceneId).environment = structuredClone(command.environment); changes.add(`scene:${command.sceneId}:environment`); return
    case 'add-sequence': {
      const scene = findScene(snapshot, command.sceneId); ensureAbsent(scene.sequences, command.sequence.id, 'sequence'); scene.sequences.push(structuredClone(command.sequence)); changes.add(`scene:${command.sceneId}:sequence:${command.sequence.id}`); return
    }
    case 'replace-sequence': replaceById(findScene(snapshot, command.sceneId).sequences, command.sequenceId, command.sequence, 'sequence'); addReplacementChanges(changes, `scene:${command.sceneId}:sequence:${command.sequenceId}`, `scene:${command.sceneId}:sequence:${command.sequence.id}`); return
    case 'remove-sequence': removeById(findScene(snapshot, command.sceneId).sequences, command.sequenceId, 'sequence'); changes.add(`scene:${command.sceneId}:sequence:${command.sequenceId}`); return
    case 'add-entity': {
      const scene = findScene(snapshot, command.sceneId)
      if (command.entity.parentId && scene.entities.some((entity) => entity.id === command.entity.parentId)) assertEntityUnlocked(snapshot, command.sceneId, command.entity.parentId, '.entity.parentId')
      ensureAbsent(scene.entities, command.entity.id, 'entity'); scene.entities.push(structuredClone(command.entity)); changes.add(`scene:${command.sceneId}:entity:${command.entity.id}`); return
    }
    case 'patch-entity': {
      const entity = findEntity(snapshot, command.sceneId, command.entityId)
      if (findEffectiveLockOwner(findScene(snapshot, command.sceneId), entity)) {
        const exactUnlock = entity.locked && !hasLockedAncestor(findScene(snapshot, command.sceneId), entity) && isExactUnlockPatch(command.patch)
        if (!exactUnlock) throw lockedEntityError(command.entityId, '.entityId')
      }
      Object.assign(entity, structuredClone(command.patch)); changes.add(`scene:${command.sceneId}:entity:${command.entityId}`); return
    }
    case 'reparent-entity': {
      assertEntityUnlocked(snapshot, command.sceneId, command.entityId, '.entityId')
      const scene = findScene(snapshot, command.sceneId)
      if (command.parentId && scene.entities.some((entity) => entity.id === command.parentId)) assertEntityUnlocked(snapshot, command.sceneId, command.parentId, '.parentId')
      findEntity(snapshot, command.sceneId, command.entityId).parentId = command.parentId; changes.add(`scene:${command.sceneId}:entity:${command.entityId}:parentId`); return
    }
    case 'remove-entity': removeEntity(snapshot, command, changes); return
    case 'add-component': {
      assertEntityUnlocked(snapshot, command.sceneId, command.entityId, '.entityId')
      const entity = findEntity(snapshot, command.sceneId, command.entityId); ensureAbsent(entity.components, command.component.id, 'component'); entity.components.push(structuredClone(command.component)); changes.add(`scene:${command.sceneId}:entity:${command.entityId}:component:${command.component.id}`); return
    }
    case 'replace-component': assertEntityUnlocked(snapshot, command.sceneId, command.entityId, '.entityId'); replaceById(findEntity(snapshot, command.sceneId, command.entityId).components, command.componentId, command.component, 'component'); addReplacementChanges(changes, `scene:${command.sceneId}:entity:${command.entityId}:component:${command.componentId}`, `scene:${command.sceneId}:entity:${command.entityId}:component:${command.component.id}`); return
    case 'remove-component': assertEntityUnlocked(snapshot, command.sceneId, command.entityId, '.entityId'); removeById(findEntity(snapshot, command.sceneId, command.entityId).components, command.componentId, 'component'); changes.add(`scene:${command.sceneId}:entity:${command.entityId}:component:${command.componentId}`); return
  }
  void warnings
}

function addReplacementChanges(changes: Set<string>, oldIdentity: string, newIdentity: string): void {
  if (oldIdentity === newIdentity) {
    changes.add(oldIdentity)
    return
  }
  changes.add(`${oldIdentity}:removed`)
  changes.add(`${newIdentity}:added`)
}

function removeEntity(snapshot: WorldProjectSnapshotV1, command: Extract<WorldCommand, { type: 'remove-entity' }>, changes: Set<string>): void {
  const scene = findScene(snapshot, command.sceneId)
  const rootIndex = scene.entities.findIndex((entity) => entity.id === command.entityId)
  if (rootIndex < 0) throw new WorldCommandApplicationError('entity-missing', `Entity ${command.entityId} does not exist.`)
  const descendants = new Set<string>([command.entityId])
  let changed = true
  while (changed) {
    changed = false
    for (const entity of scene.entities) if (entity.parentId && descendants.has(entity.parentId) && !descendants.has(entity.id)) { descendants.add(entity.id); changed = true }
  }
  for (const entity of scene.entities) {
    if (descendants.has(entity.id) && findEffectiveLockOwner(scene, entity)) throw lockedEntityError(entity.id, '.entityId')
  }
  if (descendants.size > 1 && !command.cascade) throw new WorldCommandApplicationError('cascade-required', `Entity ${command.entityId} has children; cascade is required.`)
  scene.entities = scene.entities.filter((entity) => !descendants.has(entity.id))
  for (const id of descendants) changes.add(`scene:${command.sceneId}:entity:${id}`)
}

function parseEntityPatch(value: unknown, path: string, issues: WorldCommandIssue[]): WorldEntityPatch | null {
  if (!isRecord(value)) {
    addIssue(issues, 'patch', path, 'Entity patch must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['name', 'enabled', 'locked', 'tags', 'transform'], path, issues)
  if (!Object.keys(value).length) {
    addIssue(issues, 'patch', path, 'Entity patch cannot be empty.')
    return null
  }
  const result: WorldEntityPatch = {}
  if (value.name !== undefined) {
    const name = nameValue(value.name, `${path}.name`, issues)
    if (name) result.name = name
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') addIssue(issues, 'patch', `${path}.enabled`, 'Enabled must be boolean.')
    else result.enabled = value.enabled
  }
  if (value.locked !== undefined) {
    if (typeof value.locked !== 'boolean') addIssue(issues, 'patch', `${path}.locked`, 'Locked must be boolean.')
    else result.locked = value.locked
  }
  if (value.tags !== undefined) {
    const tags = stringSet(value.tags, `${path}.tags`, issues)
    if (tags) result.tags = tags
  }
  if (value.transform !== undefined) {
    const transform = parseWorldTransformDocument(value.transform)
    appendDocumentIssues(transform, path, 'transform', issues)
    if (transform.success) result.transform = transform.value
  }
  return issues.some((issue) => issue.path === path || issue.path.startsWith(`${path}.`)) ? null : result
}

function parseSceneReference(value: unknown, path: string, issues: WorldCommandIssue[]): WorldSceneReference | null {
  if (!isRecord(value)) {
    addIssue(issues, 'scene-reference', path, 'Scene reference must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['id', 'name', 'documentPath'], path, issues)
  const id = identifier(value.id, `${path}.id`, issues)
  const name = nameValue(value.name, `${path}.name`, issues)
  const documentPath = normalizeWorldWorkspacePath(value.documentPath)
  if (!documentPath) addIssue(issues, 'workspace-path', `${path}.documentPath`, 'Scene document path must be canonical and workspace-relative.')
  return id && name && documentPath ? { id, name, documentPath } : null
}

function findScene(snapshot: WorldProjectSnapshotV1, sceneId: string): WorldSceneDocumentV1 {
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  if (!scene) throw new WorldCommandApplicationError('scene-missing', `Scene ${sceneId} does not exist.`)
  return scene
}

function findEntity(snapshot: WorldProjectSnapshotV1, sceneId: string, entityId: string): WorldEntity {
  const entity = findScene(snapshot, sceneId).entities.find((candidate) => candidate.id === entityId)
  if (!entity) throw new WorldCommandApplicationError('entity-missing', `Entity ${entityId} does not exist in scene ${sceneId}.`)
  return entity
}

function assertEntityUnlocked(snapshot: WorldProjectSnapshotV1, sceneId: string, entityId: string, pathSuffix: string): void {
  const scene = findScene(snapshot, sceneId)
  const entity = findEntity(snapshot, sceneId, entityId)
  if (findEffectiveLockOwner(scene, entity)) throw lockedEntityError(entityId, pathSuffix)
}

function assertSceneHasNoLockedEntities(snapshot: WorldProjectSnapshotV1, sceneId: string, pathSuffix: string): void {
  const scene = findScene(snapshot, sceneId)
  const lockedEntity = scene.entities.find((entity) => entity.locked)
  if (lockedEntity) {
    throw new WorldCommandApplicationError(
      'entity-locked',
      `Scene ${sceneId} contains effectively locked entity ${lockedEntity.id}.`,
      pathSuffix,
    )
  }
}

function findEffectiveLockOwner(scene: WorldSceneDocumentV1, entity: WorldEntity): WorldEntity | null {
  const entities = new Map(scene.entities.map((candidate) => [candidate.id, candidate]))
  const visited = new Set<string>()
  let current: WorldEntity | undefined = entity
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    if (current.locked) return current
    current = current.parentId ? entities.get(current.parentId) : undefined
  }
  return null
}

function hasLockedAncestor(scene: WorldSceneDocumentV1, entity: WorldEntity): boolean {
  const entities = new Map(scene.entities.map((candidate) => [candidate.id, candidate]))
  const visited = new Set<string>([entity.id])
  let parent = entity.parentId ? entities.get(entity.parentId) : undefined
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id)
    if (parent.locked) return true
    parent = parent.parentId ? entities.get(parent.parentId) : undefined
  }
  return false
}

function isExactUnlockPatch(patch: WorldEntityPatch): boolean {
  const keys = Object.keys(patch)
  return keys.length === 1 && keys[0] === 'locked' && patch.locked === false
}

function lockedEntityError(entityId: string, pathSuffix: string): WorldCommandApplicationError {
  return new WorldCommandApplicationError('entity-locked', `Entity ${entityId} is locked by itself or an ancestor.`, pathSuffix)
}

function ensureAbsent(items: readonly { id: string }[], id: string, label: string): void {
  if (items.some((item) => item.id === id)) throw new WorldCommandApplicationError('duplicate-id', `${label} ${id} already exists.`)
}

function replaceById<T extends { id: string }>(items: T[], id: string, replacement: T, label: string): void {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) throw new WorldCommandApplicationError('item-missing', `${label} ${id} does not exist.`)
  if (replacement.id !== id && items.some((item) => item.id === replacement.id)) throw new WorldCommandApplicationError('duplicate-id', `${label} ${replacement.id} already exists.`)
  items[index] = structuredClone(replacement)
}

function removeById<T extends { id: string }>(items: T[], id: string, label: string): void {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) throw new WorldCommandApplicationError('item-missing', `${label} ${id} does not exist.`)
  items.splice(index, 1)
}

function replaceSceneDocument(scenes: WorldSceneDocumentV1[], sceneId: string, scene: WorldSceneDocumentV1): void {
  const index = scenes.findIndex((candidate) => candidate.sceneId === sceneId)
  if (index < 0) throw new WorldCommandApplicationError('scene-missing', `Scene document ${sceneId} does not exist.`)
  if (scene.sceneId !== sceneId && scenes.some((candidate) => candidate.sceneId === scene.sceneId)) throw new WorldCommandApplicationError('duplicate-id', `Scene document ${scene.sceneId} already exists.`)
  scenes[index] = structuredClone(scene)
}

function removeSceneDocument(scenes: WorldSceneDocumentV1[], sceneId: string): void {
  const index = scenes.findIndex((candidate) => candidate.sceneId === sceneId)
  if (index < 0) throw new WorldCommandApplicationError('scene-missing', `Scene document ${sceneId} does not exist.`)
  scenes.splice(index, 1)
}

function appendDocumentIssues<T>(result: { success: true; value: T } | { success: false; issues: WorldDocumentIssue[] }, commandPath: string, documentRoot: string, issues: WorldCommandIssue[]): void {
  if (result.success) return
  for (const issue of result.issues) {
    if (!canContinueWorldSemanticValidation(issues)) break
    const suffix = issue.path === documentRoot ? '' : issue.path.startsWith(`${documentRoot}.`) || issue.path.startsWith(`${documentRoot}[`) ? issue.path.slice(documentRoot.length) : `.${issue.path}`
    addIssue(issues, issue.code, `${commandPath}.${documentRoot}${suffix}`, issue.message)
  }
}

function stringSet(value: unknown, path: string, issues: WorldCommandIssue[]): string[] | null {
  if (!Array.isArray(value)) {
    addIssue(issues, 'tags', path, 'Tags must be an array.')
    return null
  }
  if (value.length > WORLD_MAX_COLLECTION_ITEMS) {
    addIssue(issues, 'collection-limit', path, `Tags cannot contain more than ${WORLD_MAX_COLLECTION_ITEMS} entries.`)
    return null
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) break
    const parsed = identifier(item, `${path}[${index}]`, issues)
    if (parsed && seen.has(parsed)) addIssue(issues, 'duplicate-value', `${path}[${index}]`, `Duplicate value ${parsed}.`)
    else if (parsed) {
      seen.add(parsed)
      result.push(parsed)
    }
  }
  return result
}

function identifier(value: unknown, path: string, issues: WorldCommandIssue[]): string | null {
  if (!isWorldCanonicalId(value)) {
    addIssue(issues, 'identifier', path, 'Identifier must be a non-empty canonical string of at most 256 characters.')
    return null
  }
  return value
}

function nameValue(value: unknown, path: string, issues: WorldCommandIssue[]): string | null {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 512) {
    addIssue(issues, 'name', path, 'Name must be a non-empty string.')
    return null
  }
  return value.trim()
}

function revision(value: unknown, path: string, issues: WorldCommandIssue[]): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    addIssue(issues, 'revision', path, 'Revision must be a non-negative safe integer.')
    return null
  }
  return value
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: WorldCommandIssue[]): void {
  const ownKeys = Object.keys(value)
  if (ownKeys.length > WORLD_MAX_RECORD_KEYS) {
    addIssue(issues, 'collection-limit', path, `Object cannot contain more than ${WORLD_MAX_RECORD_KEYS} properties.`)
    return
  }
  const keys = new Set(allowed)
  for (const key of ownKeys) {
    if (!canContinueWorldSemanticValidation(issues)) break
    if (!keys.has(key)) addIssue(issues, 'unknown-property', `${path}.${key}`, `Unknown property ${key}.`)
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const entries = Object.entries(value).sort(([left], [right]) => codeUnitCompare(left, right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isSafeWorldWireRecord(value)
}

function toCommandIssue(issue: WorldDocumentIssue): WorldCommandIssue {
  return { code: issue.code, path: issue.path, message: issue.message }
}

function addIssue(issues: WorldCommandIssue[], code: string, path: string, message: string): void {
  if (issues.length >= WORLD_MAX_SEMANTIC_ISSUES) return
  issues.push({ code, path, message })
}

function failed(issues: WorldCommandIssue[]): { success: false; issues: WorldCommandIssue[] } {
  return { success: false, issues: [...issues].sort((left, right) => codeUnitCompare(left.path, right.path) || codeUnitCompare(left.code, right.code) || codeUnitCompare(left.message, right.message)) }
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

class WorldCommandApplicationError extends Error {
  readonly code: string
  readonly pathSuffix: string

  constructor(code: string, message: string, pathSuffix = '') {
    super(message)
    this.code = code
    this.pathSuffix = pathSuffix
  }
}
