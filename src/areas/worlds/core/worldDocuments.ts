import {
  collectWorldComponentReferences,
  getWorldComponentDefinition,
  isWorldComponentPropertyWritableFor,
  parseWorldComponent,
  type WorldComponent,
  type WorldComponentReference,
} from './worldComponentRegistry.ts'
import {
  WORLD_PROJECT_SCHEMA,
  WORLD_SCENE_SCHEMA,
  type WorldAnimationResource,
  type WorldAudioResource,
  type WorldColor,
  type WorldEntity,
  type WorldEnvironmentResource,
  type WorldGraphicsProfile,
  type WorldInputAction,
  type WorldInputBinding,
  type WorldModelResource,
  type WorldProjectDocumentV1,
  type WorldProjectSnapshotV1,
  type WorldRationalTime,
  type WorldResource,
  type WorldSceneDocumentV1,
  type WorldSceneEditorMetadata,
  type WorldSceneEnvironment,
  type WorldSceneInitialView,
  type WorldSceneReference,
  type WorldSequence,
  type WorldSequenceTrack,
  type WorldTransform,
  type WorldVector3,
} from './worldModel.ts'
import {
  canContinueWorldSemanticValidation,
  isWorldCanonicalId,
  isWorldCanonicalPropertyName,
  WORLD_MAX_COLLECTION_ITEMS,
  WORLD_MAX_RECORD_KEYS,
  WORLD_MAX_SEMANTIC_ISSUES,
} from './worldValidationLimits.ts'
import { isSafeWorldWireRecord, normalizeWorldWireValue } from './worldWireValidation.ts'
import { validateWorldSequenceTrackTargets } from './worldSequenceValidation.ts'

export interface WorldDocumentIssue {
  code: string
  path: string
  message: string
}

export type WorldDocumentResult<T> =
  | { success: true; value: T }
  | { success: false; issues: WorldDocumentIssue[] }

export function normalizeWorldWorkspacePath(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 4_096) return null
  let candidate = value
  for (let round = 0; round < 4; round += 1) {
    if (!isSafeDecodedWorkspacePath(candidate)) return null
    if (!candidate.includes('%')) return candidate
    if (/%(?:2f|5c)/i.test(candidate)) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(candidate)
    } catch {
      return null
    }
    if (decoded === candidate || decoded.length > 4_096) return null
    candidate = decoded
  }
  if (candidate.includes('%')) return null
  if (!isSafeDecodedWorkspacePath(candidate)) return null
  return candidate
}

export function parseWorldProjectDocument(value: unknown): WorldDocumentResult<WorldProjectDocumentV1> {
  const normalized = normalizeDocumentWire(value, 'project')
  if (!normalized.success) return normalized
  return parseNormalizedWorldProjectDocument(normalized.value)
}

// Private semantic parser: callers must normalize and isolate the wire in this invocation.
function parseNormalizedWorldProjectDocument(value: unknown): WorldDocumentResult<WorldProjectDocumentV1> {
  const issues: WorldDocumentIssue[] = []
  if (!isRecord(value)) return invalid('project', 'type', 'World project must be an object.')
  rejectUnknownKeys(value, ['schema', 'projectId', 'name', 'revision', 'resources', 'scenes', 'startSceneId', 'inputActions', 'graphicsProfiles', 'activeGraphicsProfileId'], 'project', issues)
  if (value.schema !== WORLD_PROJECT_SCHEMA) addIssue(issues, 'schema', 'project.schema', `Schema must be ${WORLD_PROJECT_SCHEMA}.`)
  const projectId = parseIdentifier(value.projectId, 'project.projectId', issues)
  const name = parseName(value.name, 'project.name', issues)
  const revision = parseRevision(value.revision, 'project.revision', issues)
  const resources = parseArray(value.resources, 'project.resources', issues, parseWorldResource)
  const scenes = parseArray(value.scenes, 'project.scenes', issues, parseWorldSceneReference)
  const inputActions = parseArray(value.inputActions, 'project.inputActions', issues, parseWorldInputAction)
  const graphicsProfiles = parseArray(value.graphicsProfiles, 'project.graphicsProfiles', issues, parseWorldGraphicsProfile)
  const startSceneId = parseIdentifier(value.startSceneId, 'project.startSceneId', issues)
  const activeGraphicsProfileId = parseIdentifier(value.activeGraphicsProfileId, 'project.activeGraphicsProfileId', issues)
  collectDuplicateIds(resources, 'project.resources', issues)
  collectDuplicateIds(scenes, 'project.scenes', issues)
  collectDuplicateIds(inputActions, 'project.inputActions', issues)
  collectDuplicateIds(graphicsProfiles, 'project.graphicsProfiles', issues)
  if (startSceneId && !scenes.some((scene) => scene.id === startSceneId)) addIssue(issues, 'start-scene', 'project.startSceneId', 'Start scene does not exist in project scenes.')
  if (activeGraphicsProfileId && !graphicsProfiles.some((profile) => profile.id === activeGraphicsProfileId)) addIssue(issues, 'graphics-profile', 'project.activeGraphicsProfileId', 'Active graphics profile does not exist.')
  if (issues.length || !projectId || !name || revision === null || !startSceneId || !activeGraphicsProfileId) return failed(issues)
  return valid({ schema: WORLD_PROJECT_SCHEMA, projectId, name, revision, resources, scenes, startSceneId, inputActions, graphicsProfiles, activeGraphicsProfileId })
}

export function parseWorldSceneDocument(value: unknown): WorldDocumentResult<WorldSceneDocumentV1> {
  const normalized = normalizeDocumentWire(value, 'scene')
  if (!normalized.success) return normalized
  return parseNormalizedWorldSceneDocument(normalized.value)
}

// Private semantic parser: callers must normalize and isolate the wire in this invocation.
function parseNormalizedWorldSceneDocument(value: unknown): WorldDocumentResult<WorldSceneDocumentV1> {
  const issues: WorldDocumentIssue[] = []
  if (!isRecord(value)) return invalid('scene', 'type', 'World scene must be an object.')
  rejectUnknownKeys(value, ['schema', 'projectId', 'sceneId', 'name', 'environment', 'editor', 'entities', 'sequences'], 'scene', issues)
  if (value.schema !== WORLD_SCENE_SCHEMA) addIssue(issues, 'schema', 'scene.schema', `Schema must be ${WORLD_SCENE_SCHEMA}.`)
  const projectId = parseIdentifier(value.projectId, 'scene.projectId', issues)
  const sceneId = parseIdentifier(value.sceneId, 'scene.sceneId', issues)
  const name = parseName(value.name, 'scene.name', issues)
  const environment = parseWorldSceneEnvironment(value.environment, 'scene.environment', issues)
  const editor = value.editor === undefined ? undefined : parseWorldSceneEditor(value.editor, 'scene.editor', issues)
  const entities = parseArray(value.entities, 'scene.entities', issues, parseWorldEntity)
  const sequences = parseArray(value.sequences, 'scene.sequences', issues, parseWorldSequence)
  collectDuplicateIds(entities, 'scene.entities', issues)
  collectDuplicateIds(sequences, 'scene.sequences', issues)
  if (issues.length || !projectId || !sceneId || !name || !environment || (value.editor !== undefined && !editor)) return failed(issues)
  return valid({ schema: WORLD_SCENE_SCHEMA, projectId, sceneId, name, environment, ...(editor ? { editor } : {}), entities, sequences })
}

export function validateWorldProjectSnapshot(value: unknown): WorldDocumentResult<WorldProjectSnapshotV1> {
  const normalized = normalizeDocumentWire(value, 'snapshot')
  if (!normalized.success) return normalized
  value = normalized.value
  if (!isRecord(value)) return invalid('snapshot', 'type', 'World project snapshot must be an object.')
  const issues: WorldDocumentIssue[] = []
  rejectUnknownKeys(value, ['project', 'scenes'], 'snapshot', issues)
  // An omitted project was not visited by snapshot normalization; preserve its wire issue.
  const parsedProject = value.project === undefined
    ? parseWorldProjectDocument(value.project)
    : parseNormalizedWorldProjectDocument(value.project)
  appendResultIssues(parsedProject, issues)
  if (!Array.isArray(value.scenes)) addIssue(issues, 'type', 'snapshot.scenes', 'Snapshot scenes must be an array.')
  const scenes: WorldSceneDocumentV1[] = []
  if (Array.isArray(value.scenes)) {
    if (value.scenes.length > WORLD_MAX_COLLECTION_ITEMS) addIssue(issues, 'collection-limit', 'snapshot.scenes', `Snapshot cannot contain more than ${WORLD_MAX_COLLECTION_ITEMS} scenes.`)
    else for (const [index, scene] of value.scenes.entries()) {
      if (!canContinueWorldSemanticValidation(issues)) break
      const parsed = parseNormalizedWorldSceneDocument(scene)
      if (parsed.success) scenes.push(parsed.value)
      else for (const issue of parsed.issues) {
        if (!canContinueWorldSemanticValidation(issues)) break
        addIssue(issues, issue.code, `snapshot.scenes[${index}]${stripRoot(issue.path, 'scene')}`, issue.message)
      }
    }
  }
  if (!parsedProject.success) return failed(issues)
  const project = parsedProject.value
  validateSceneBijection(project, scenes, issues)
  validateGlobalIdentifiers(project, scenes, issues)
  validateReferences(project, scenes, issues)
  for (const [index, scene] of scenes.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) break
    validateSceneGraph(scene, `snapshot.scenes[${index}]`, issues)
  }
  return issues.length ? failed(issues) : valid({ project, scenes })
}

export function cloneWorldProjectSnapshot(snapshot: WorldProjectSnapshotV1): WorldProjectSnapshotV1 {
  return structuredClone(snapshot)
}

export function parseWorldResourceDocument(value: unknown): WorldDocumentResult<WorldResource> {
  const normalized = normalizeDocumentWire(value, 'resource')
  if (!normalized.success) return normalized
  value = normalized.value
  const issues: WorldDocumentIssue[] = []
  const resource = parseWorldResource(value, 'resource', issues)
  return resource && !issues.length ? valid(resource) : failed(issues)
}

export function parseWorldEntityDocument(value: unknown): WorldDocumentResult<WorldEntity> {
  const normalized = normalizeDocumentWire(value, 'entity')
  if (!normalized.success) return normalized
  value = normalized.value
  const issues: WorldDocumentIssue[] = []
  const entity = parseWorldEntity(value, 'entity', issues)
  return entity && !issues.length ? valid(entity) : failed(issues)
}

export function parseWorldSequenceDocument(value: unknown): WorldDocumentResult<WorldSequence> {
  const normalized = normalizeDocumentWire(value, 'sequence')
  if (!normalized.success) return normalized
  value = normalized.value
  const issues: WorldDocumentIssue[] = []
  const sequence = parseWorldSequence(value, 'sequence', issues)
  return sequence && !issues.length ? valid(sequence) : failed(issues)
}

export function parseWorldInputActionsDocument(value: unknown): WorldDocumentResult<WorldInputAction[]> {
  const normalized = normalizeDocumentWire(value, 'inputActions')
  if (!normalized.success) return normalized
  value = normalized.value
  const issues: WorldDocumentIssue[] = []
  const actions = parseArray(value, 'inputActions', issues, parseWorldInputAction)
  collectDuplicateIds(actions, 'inputActions', issues)
  return issues.length ? failed(issues) : valid(actions)
}

export function parseWorldGraphicsProfilesDocument(value: unknown): WorldDocumentResult<WorldGraphicsProfile[]> {
  const normalized = normalizeDocumentWire(value, 'graphicsProfiles')
  if (!normalized.success) return normalized
  value = normalized.value
  const issues: WorldDocumentIssue[] = []
  const profiles = parseArray(value, 'graphicsProfiles', issues, parseWorldGraphicsProfile)
  collectDuplicateIds(profiles, 'graphicsProfiles', issues)
  return issues.length ? failed(issues) : valid(profiles)
}

export function parseWorldTransformDocument(value: unknown): WorldDocumentResult<WorldTransform> {
  const normalized = normalizeDocumentWire(value, 'transform')
  if (!normalized.success) return normalized
  value = normalized.value
  const issues: WorldDocumentIssue[] = []
  const transform = parseWorldTransform(value, 'transform', issues)
  return transform && !issues.length ? valid(transform) : failed(issues)
}

export function parseWorldSceneEnvironmentDocument(value: unknown): WorldDocumentResult<WorldSceneEnvironment> {
  const normalized = normalizeDocumentWire(value, 'environment')
  if (!normalized.success) return normalized
  value = normalized.value
  const issues: WorldDocumentIssue[] = []
  const environment = parseWorldSceneEnvironment(value, 'environment', issues)
  return environment && !issues.length ? valid(environment) : failed(issues)
}

function parseWorldResource(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldResource | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Resource must be an object.')
    return null
  }
  const id = parseIdentifier(value.id, `${path}.id`, issues)
  const name = parseName(value.name, `${path}.name`, issues)
  const workspacePath = normalizeWorldWorkspacePath(value.workspacePath)
  if (!workspacePath) addIssue(issues, 'workspace-path', `${path}.workspacePath`, 'Resource path must be canonical and workspace-relative.')
  if (!id || !name || !workspacePath) return null
  if (value.type === 'model') {
    rejectUnknownKeys(value, ['id', 'type', 'name', 'workspacePath', 'format'], path, issues)
    if (value.format !== 'glb' && value.format !== 'gltf' && value.format !== 'ply-mesh' && value.format !== 'ply-points' && value.format !== 'gaussian-ply') {
      addIssue(issues, 'resource-format', `${path}.format`, 'Model format is invalid.')
      return null
    }
    return { id, type: 'model', name, workspacePath, format: value.format } satisfies WorldModelResource
  }
  if (value.type === 'animation') {
    rejectUnknownKeys(value, ['id', 'type', 'name', 'workspacePath', 'format', 'sourceWorkspacePath', 'legacyWorkspacePath', 'clipId', 'clipName', 'clipIndex', 'durationSeconds'], path, issues)
    if (value.format !== 'pose-clip' && value.format !== 'gltf-clip') {
      addIssue(issues, 'resource-format', `${path}.format`, 'Animation format is invalid.')
      return null
    }
    const sourceWorkspacePath = optionalWorkspacePath(value.sourceWorkspacePath, `${path}.sourceWorkspacePath`, issues)
    const legacyWorkspacePath = optionalWorkspacePath(value.legacyWorkspacePath, `${path}.legacyWorkspacePath`, issues)
    const clipId = optionalIdentifier(value.clipId, `${path}.clipId`, issues)
    const clipName = optionalName(value.clipName, `${path}.clipName`, issues)
    let clipIndex: number | undefined
    if (value.clipIndex !== undefined) {
      if (value.format !== 'gltf-clip' || typeof value.clipIndex !== 'number'
        || !Number.isSafeInteger(value.clipIndex) || value.clipIndex < 0) {
        addIssue(issues, 'animation-clip-index', `${path}.clipIndex`, 'Clip index requires a gltf-clip and a non-negative safe integer.')
      } else clipIndex = value.clipIndex
    }
    let durationSeconds: number | undefined
    if (value.durationSeconds !== undefined) {
      const parsedDuration = positiveNumber(value.durationSeconds, `${path}.durationSeconds`, issues)
      if (parsedDuration !== null) durationSeconds = parsedDuration
    }
    if (issues.some((issue) => issue.path.startsWith(path))) return null
    return { id, type: 'animation', name, workspacePath, format: value.format, ...(sourceWorkspacePath ? { sourceWorkspacePath } : {}), ...(legacyWorkspacePath ? { legacyWorkspacePath } : {}), ...(clipId ? { clipId } : {}), ...(clipName ? { clipName } : {}), ...(clipIndex === undefined ? {} : { clipIndex }), ...(durationSeconds === undefined ? {} : { durationSeconds }) } satisfies WorldAnimationResource
  }
  if (value.type === 'audio') {
    rejectUnknownKeys(value, ['id', 'type', 'name', 'workspacePath', 'format'], path, issues)
    if (value.format !== 'wav' && value.format !== 'mp3' && value.format !== 'ogg' && value.format !== 'flac') {
      addIssue(issues, 'resource-format', `${path}.format`, 'Audio format is invalid.')
      return null
    }
    return { id, type: 'audio', name, workspacePath, format: value.format } satisfies WorldAudioResource
  }
  if (value.type === 'environment') {
    rejectUnknownKeys(value, ['id', 'type', 'name', 'workspacePath', 'format'], path, issues)
    if (value.format !== 'hdr' && value.format !== 'exr' && value.format !== 'image') {
      addIssue(issues, 'resource-format', `${path}.format`, 'Environment format is invalid.')
      return null
    }
    return { id, type: 'environment', name, workspacePath, format: value.format } satisfies WorldEnvironmentResource
  }
  addIssue(issues, 'resource-type', `${path}.type`, 'Resource type is invalid.')
  return null
}

function parseWorldSceneReference(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldSceneReference | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Scene reference must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['id', 'name', 'documentPath'], path, issues)
  const id = parseIdentifier(value.id, `${path}.id`, issues)
  const name = parseName(value.name, `${path}.name`, issues)
  const documentPath = normalizeWorldWorkspacePath(value.documentPath)
  if (!documentPath) addIssue(issues, 'workspace-path', `${path}.documentPath`, 'Scene document path must be canonical and workspace-relative.')
  return id && name && documentPath ? { id, name, documentPath } : null
}

function parseWorldInputAction(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldInputAction | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Input action must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['id', 'name', 'valueType', 'bindings'], path, issues)
  const id = parseIdentifier(value.id, `${path}.id`, issues)
  const name = parseName(value.name, `${path}.name`, issues)
  const valueType = value.valueType === 'button' || value.valueType === 'axis1d' || value.valueType === 'axis2d' ? value.valueType : null
  if (!valueType) addIssue(issues, 'input-value-type', `${path}.valueType`, 'Input value type is invalid.')
  const bindings = valueType
    ? parseArray(value.bindings, `${path}.bindings`, issues, (candidate, bindingPath, bindingIssues) => parseWorldInputBinding(candidate, bindingPath, bindingIssues, valueType))
    : []
  const usedSources = new Map<string, number>()
  for (const [index, binding] of bindings.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) break
    const source = `${binding.device}\0${binding.control}`
    const previous = usedSources.get(source)
    if (previous !== undefined) addIssue(issues, 'input-binding-conflict', `${path}.bindings[${index}]`, `Input source is already bound at ${path}.bindings[${previous}].`)
    else usedSources.set(source, index)
  }
  return id && name && valueType ? { id, name, valueType, bindings } : null
}

function parseWorldInputBinding(value: unknown, path: string, issues: WorldDocumentIssue[], actionValueType: WorldInputAction['valueType']): WorldInputBinding | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Input binding must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['kind', 'device', 'control', 'scale', 'targetAxis'], path, issues)
  if (value.device !== 'keyboard' && value.device !== 'mouse' && value.device !== 'gamepad') addIssue(issues, 'input-device', `${path}.device`, 'Input device is invalid.')
  const control = parseIdentifier(value.control, `${path}.control`, issues)
  let kind: WorldInputBinding['kind'] | null = null
  if (value.kind === undefined) {
    if (actionValueType === 'axis2d') addIssue(issues, 'input-binding-ambiguous', `${path}.kind`, 'Legacy axis2d bindings are ambiguous; declare kind axis2d and targetAxis x or y.')
    else kind = actionValueType
  } else if (value.kind === 'button' || value.kind === 'axis1d' || value.kind === 'axis2d') kind = value.kind
  else addIssue(issues, 'input-binding-kind', `${path}.kind`, 'Input binding kind is invalid.')
  if (kind && kind !== actionValueType) addIssue(issues, 'input-binding-kind', `${path}.kind`, `Input binding kind ${kind} is incompatible with ${actionValueType} action.`)
  let scale: number | undefined
  if (value.scale !== undefined) {
    const parsedScale = finiteNumber(value.scale, `${path}.scale`, issues)
    if (parsedScale !== null) scale = parsedScale
  }
  const device = value.device === 'keyboard' || value.device === 'mouse' || value.device === 'gamepad' ? value.device : null
  if (kind === 'axis2d') {
    if (value.targetAxis !== 'x' && value.targetAxis !== 'y') addIssue(issues, 'input-binding-axis', `${path}.targetAxis`, 'Axis2d bindings require targetAxis x or y.')
    return control && device && kind === actionValueType && (value.scale === undefined || scale !== undefined) && (value.targetAxis === 'x' || value.targetAxis === 'y')
      ? { kind, device, control, targetAxis: value.targetAxis, ...(scale === undefined ? {} : { scale }) }
      : null
  }
  if (value.targetAxis !== undefined) addIssue(issues, 'input-binding-axis', `${path}.targetAxis`, 'Only axis2d bindings may declare targetAxis.')
  return control && device && kind && kind === actionValueType && (value.scale === undefined || scale !== undefined) && value.targetAxis === undefined
    ? { kind, device, control, ...(scale === undefined ? {} : { scale }) }
    : null
}

function parseWorldGraphicsProfile(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldGraphicsProfile | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Graphics profile must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['id', 'name', 'renderScale', 'shadowQuality', 'antialiasing'], path, issues)
  const id = parseIdentifier(value.id, `${path}.id`, issues)
  const name = parseName(value.name, `${path}.name`, issues)
  const renderScale = rangedNumber(value.renderScale, 0.25, 2, `${path}.renderScale`, issues)
  if (value.shadowQuality !== 'off' && value.shadowQuality !== 'low' && value.shadowQuality !== 'medium' && value.shadowQuality !== 'high') addIssue(issues, 'shadow-quality', `${path}.shadowQuality`, 'Shadow quality is invalid.')
  if (value.antialiasing !== 'off' && value.antialiasing !== 'fxaa' && value.antialiasing !== 'msaa') addIssue(issues, 'antialiasing', `${path}.antialiasing`, 'Antialiasing mode is invalid.')
  return id && name && renderScale !== null && (value.shadowQuality === 'off' || value.shadowQuality === 'low' || value.shadowQuality === 'medium' || value.shadowQuality === 'high') && (value.antialiasing === 'off' || value.antialiasing === 'fxaa' || value.antialiasing === 'msaa')
    ? { id, name, renderScale, shadowQuality: value.shadowQuality, antialiasing: value.antialiasing }
    : null
}

function parseWorldSceneEnvironment(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldSceneEnvironment | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Scene environment must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['backgroundColor', 'ambientIntensity', 'environmentResourceId', 'fog'], path, issues)
  const backgroundColor = parseColor(value.backgroundColor, `${path}.backgroundColor`, issues)
  const ambientIntensity = nonNegativeNumber(value.ambientIntensity, `${path}.ambientIntensity`, issues)
  const environmentResourceId = optionalIdentifier(value.environmentResourceId, `${path}.environmentResourceId`, issues)
  let fog: WorldSceneEnvironment['fog']
  if (value.fog !== undefined) {
    if (!isRecord(value.fog)) addIssue(issues, 'type', `${path}.fog`, 'Fog must be an object.')
    else {
      rejectUnknownKeys(value.fog, ['color', 'near', 'far'], `${path}.fog`, issues)
      const color = parseColor(value.fog.color, `${path}.fog.color`, issues)
      const near = nonNegativeNumber(value.fog.near, `${path}.fog.near`, issues)
      const far = positiveNumber(value.fog.far, `${path}.fog.far`, issues)
      if (color && near !== null && far !== null && far > near) fog = { color, near, far }
      else addIssue(issues, 'fog-range', `${path}.fog`, 'Fog range is invalid.')
    }
  }
  if (!backgroundColor || ambientIntensity === null || (value.environmentResourceId !== undefined && !environmentResourceId) || (value.fog !== undefined && !fog)) return null
  return { backgroundColor, ambientIntensity, ...(environmentResourceId ? { environmentResourceId } : {}), ...(fog ? { fog } : {}) }
}

function parseWorldSceneEditor(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldSceneEditorMetadata | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Scene editor metadata must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['initialView'], path, issues)
  if (value.initialView === undefined) return {}
  const initialView = parseWorldSceneInitialView(value.initialView, `${path}.initialView`, issues)
  return initialView ? { initialView } : null
}

function parseWorldSceneInitialView(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldSceneInitialView | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Initial view must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['position', 'target', 'up'], path, issues)
  const position = parseVector3(value.position, `${path}.position`, issues)
  const target = parseVector3(value.target, `${path}.target`, issues)
  const up = value.up === undefined ? undefined : parseVector3(value.up, `${path}.up`, issues)
  if (!position || !target || (value.up !== undefined && !up)) return null
  if (position.every((component, index) => component === target[index])) {
    addIssue(issues, 'initial-view-direction', path, 'Initial view position and target must differ.')
    return null
  }
  if (up?.every((component) => component === 0)) {
    addIssue(issues, 'initial-view-up', `${path}.up`, 'Initial view up vector must be non-zero.')
    return null
  }
  return { position, target, ...(up ? { up } : {}) }
}

function parseWorldEntity(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldEntity | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Entity must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['id', 'name', 'parentId', 'enabled', 'locked', 'tags', 'transform', 'components'], path, issues)
  const id = parseIdentifier(value.id, `${path}.id`, issues)
  const name = parseName(value.name, `${path}.name`, issues)
  const parentId = value.parentId === null ? null : parseIdentifier(value.parentId, `${path}.parentId`, issues)
  if (typeof value.enabled !== 'boolean') addIssue(issues, 'type', `${path}.enabled`, 'Entity enabled must be boolean.')
  if (typeof value.locked !== 'boolean') addIssue(issues, 'type', `${path}.locked`, 'Entity locked must be boolean.')
  const tags = parseStringSet(value.tags, `${path}.tags`, issues)
  const transform = parseWorldTransform(value.transform, `${path}.transform`, issues)
  const components: WorldComponent[] = []
  if (!Array.isArray(value.components)) addIssue(issues, 'type', `${path}.components`, 'Entity components must be an array.')
  else if (value.components.length > WORLD_MAX_COLLECTION_ITEMS) addIssue(issues, 'collection-limit', `${path}.components`, `Entity cannot contain more than ${WORLD_MAX_COLLECTION_ITEMS} components.`)
  else {
    for (const [index, component] of value.components.entries()) {
      if (!canContinueWorldSemanticValidation(issues)) break
      const parsed = parseWorldComponent(component, `${path}.components[${index}]`)
      if (parsed.success) components.push(parsed.value)
      else for (const issue of parsed.issues) {
        if (!canContinueWorldSemanticValidation(issues)) break
        addIssue(issues, issue.code, issue.path, issue.message)
      }
    }
  }
  collectDuplicateIds(components, `${path}.components`, issues)
  validateComponentCardinality(components, path, issues)
  if (!id || !name || (value.parentId !== null && !parentId) || typeof value.enabled !== 'boolean' || typeof value.locked !== 'boolean' || !tags || !transform) return null
  return { id, name, parentId, enabled: value.enabled, locked: value.locked, tags, transform, components }
}

function parseWorldTransform(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldTransform | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Transform must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['position', 'rotation', 'scale'], path, issues)
  const position = parseVector3(value.position, `${path}.position`, issues)
  const rotation = parseVector3(value.rotation, `${path}.rotation`, issues)
  const scale = parseVector3(value.scale, `${path}.scale`, issues)
  return position && rotation && scale ? { position, rotation, scale } : null
}

function parseWorldSequence(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldSequence | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Sequence must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['id', 'name', 'duration', 'tracks'], path, issues)
  const id = parseIdentifier(value.id, `${path}.id`, issues)
  const name = parseName(value.name, `${path}.name`, issues)
  const duration = parseRationalTime(value.duration, `${path}.duration`, issues)
  const tracks = parseArray(value.tracks, `${path}.tracks`, issues, parseWorldSequenceTrack)
  collectDuplicateIds(tracks, `${path}.tracks`, issues)
  if (duration) {
    for (const [trackIndex, track] of tracks.entries()) {
      if (!canContinueWorldSemanticValidation(issues)) break
      let previousTime: WorldRationalTime | undefined
      for (const [keyframeIndex, keyframe] of track.keyframes.entries()) {
        if (!canContinueWorldSemanticValidation(issues)) break
        if (previousTime && compareRationalTime(keyframe.time, previousTime) <= 0) {
          addIssue(issues, 'keyframe-order', `${path}.tracks[${trackIndex}].keyframes[${keyframeIndex}].time`, 'Keyframe times must be strictly increasing in authored track order.')
        }
        if (compareRationalTime(keyframe.time, duration) > 0) {
          addIssue(issues, 'keyframe-time', `${path}.tracks[${trackIndex}].keyframes[${keyframeIndex}].time`, 'Keyframe time must be inside the sequence duration.')
        }
        previousTime = keyframe.time
      }
    }
  }
  return id && name && duration ? { id, name, duration, tracks } : null
}

function parseWorldSequenceTrack(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldSequenceTrack | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Sequence track must be an object.')
    return null
  }
  const id = parseIdentifier(value.id, `${path}.id`, issues)
  if (!id || typeof value.type !== 'string') {
    addIssue(issues, 'track-type', `${path}.type`, 'Track type is invalid.')
    return null
  }
  if (value.type === 'event') {
    rejectUnknownKeys(value, ['id', 'type', 'keyframes'], path, issues)
    const keyframes = parseArray(value.keyframes, `${path}.keyframes`, issues, parseEventKeyframe)
    collectDuplicateIds(keyframes, `${path}.keyframes`, issues)
    return { id, type: 'event', keyframes }
  }
  const entityId = parseIdentifier(value.entityId, `${path}.entityId`, issues)
  if (!entityId) return null
  if (value.type === 'transform') {
    rejectUnknownKeys(value, ['id', 'type', 'entityId', 'keyframes'], path, issues)
    const keyframes = parseArray(value.keyframes, `${path}.keyframes`, issues, parseTransformKeyframe)
    collectDuplicateIds(keyframes, `${path}.keyframes`, issues)
    return { id, type: 'transform', entityId, keyframes }
  }
  if (value.type === 'camera') {
    rejectUnknownKeys(value, ['id', 'type', 'entityId', 'keyframes'], path, issues)
    const keyframes = parseArray(value.keyframes, `${path}.keyframes`, issues, parseBooleanKeyframe)
    collectDuplicateIds(keyframes, `${path}.keyframes`, issues)
    return { id, type: 'camera', entityId, keyframes }
  }
  if (value.type === 'animation' || value.type === 'audio') {
    rejectUnknownKeys(value, ['id', 'type', 'entityId', 'componentId', 'keyframes'], path, issues)
    const componentId = parseIdentifier(value.componentId, `${path}.componentId`, issues)
    const keyframes = parseArray(value.keyframes, `${path}.keyframes`, issues, parseBooleanKeyframe)
    collectDuplicateIds(keyframes, `${path}.keyframes`, issues)
    return componentId ? { id, type: value.type, entityId, componentId, keyframes } : null
  }
  if (value.type === 'light') {
    rejectUnknownKeys(value, ['id', 'type', 'entityId', 'componentId', 'property', 'keyframes'], path, issues)
    const componentId = parseIdentifier(value.componentId, `${path}.componentId`, issues)
    if (value.property !== 'intensity') addIssue(issues, 'track-property', `${path}.property`, 'Light track property is invalid.')
    const keyframes = parseArray(value.keyframes, `${path}.keyframes`, issues, parseNumberKeyframe)
    collectDuplicateIds(keyframes, `${path}.keyframes`, issues)
    return componentId && value.property === 'intensity' ? { id, type: 'light', entityId, componentId, property: 'intensity', keyframes } : null
  }
  if (value.type === 'property') {
    rejectUnknownKeys(value, ['id', 'type', 'entityId', 'componentId', 'property', 'keyframes'], path, issues)
    const componentId = parseIdentifier(value.componentId, `${path}.componentId`, issues)
    const property = parsePropertyName(value.property, `${path}.property`, issues)
    const keyframes = parseArray(value.keyframes, `${path}.keyframes`, issues, parsePropertyKeyframe)
    collectDuplicateIds(keyframes, `${path}.keyframes`, issues)
    return componentId && property ? { id, type: 'property', entityId, componentId, property, keyframes } : null
  }
  addIssue(issues, 'track-type', `${path}.type`, 'Track type is invalid.')
  return null
}

function parseTransformKeyframe(value: unknown, path: string, issues: WorldDocumentIssue[]): Extract<WorldSequenceTrack, { type: 'transform' }>['keyframes'][number] | null {
  const base = parseKeyframeBase(value, path, issues)
  if (!base || !isRecord(value)) return null
  if (!isRecord(value.value)) {
    addIssue(issues, 'keyframe-value', `${path}.value`, 'Transform keyframe value must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['id', 'time', 'interpolation', 'value'], path, issues)
  rejectUnknownKeys(value.value, ['position', 'rotation', 'scale'], `${path}.value`, issues)
  const position = value.value.position === undefined ? undefined : parseVector3(value.value.position, `${path}.value.position`, issues)
  const rotation = value.value.rotation === undefined ? undefined : parseVector3(value.value.rotation, `${path}.value.rotation`, issues)
  const scale = value.value.scale === undefined ? undefined : parseVector3(value.value.scale, `${path}.value.scale`, issues)
  if (!position && !rotation && !scale) {
    addIssue(issues, 'keyframe-value', `${path}.value`, 'Transform keyframe must set at least one transform field.')
    return null
  }
  return { ...base, value: { ...(position ? { position } : {}), ...(rotation ? { rotation } : {}), ...(scale ? { scale } : {}) } }
}

function parseBooleanKeyframe(value: unknown, path: string, issues: WorldDocumentIssue[]): Extract<WorldSequenceTrack, { type: 'camera' }>['keyframes'][number] | null {
  const base = parseKeyframeBase(value, path, issues)
  if (!base || !isRecord(value) || typeof value.value !== 'boolean') {
    addIssue(issues, 'keyframe-value', `${path}.value`, 'Boolean keyframe value is invalid.')
    return null
  }
  rejectUnknownKeys(value, ['id', 'time', 'interpolation', 'value'], path, issues)
  if (base.interpolation !== undefined && base.interpolation !== 'step') {
    addIssue(issues, 'discrete-interpolation', `${path}.interpolation`, 'Boolean tracks support only step interpolation.')
    return null
  }
  return { id: base.id, time: base.time, ...(base.interpolation === 'step' ? { interpolation: 'step' as const } : {}), value: value.value }
}

function parseNumberKeyframe(value: unknown, path: string, issues: WorldDocumentIssue[]): Extract<WorldSequenceTrack, { type: 'light' }>['keyframes'][number] | null {
  const base = parseKeyframeBase(value, path, issues)
  if (!base || !isRecord(value)) return null
  rejectUnknownKeys(value, ['id', 'time', 'interpolation', 'value'], path, issues)
  const number = finiteNumber(value.value, `${path}.value`, issues)
  return number === null ? null : { ...base, value: number }
}

function parsePropertyKeyframe(value: unknown, path: string, issues: WorldDocumentIssue[]): Extract<WorldSequenceTrack, { type: 'property' }>['keyframes'][number] | null {
  const base = parseKeyframeBase(value, path, issues)
  if (!base || !isRecord(value)) return null
  rejectUnknownKeys(value, ['id', 'time', 'interpolation', 'value'], path, issues)
  if (typeof value.value === 'string' || typeof value.value === 'boolean') {
    if (base.interpolation !== undefined && base.interpolation !== 'step') {
      addIssue(issues, 'discrete-interpolation', `${path}.interpolation`, 'String and boolean properties support only step interpolation.')
      return null
    }
    return { id: base.id, time: base.time, ...(base.interpolation === 'step' ? { interpolation: 'step' as const } : {}), value: value.value }
  }
  if (typeof value.value === 'number') {
    const parsed = finiteNumber(value.value, `${path}.value`, issues)
    return parsed === null ? null : { ...base, value: parsed }
  }
  const vector = parseVector3(value.value, `${path}.value`, issues)
  return vector ? { ...base, value: vector } : null
}

function parseEventKeyframe(value: unknown, path: string, issues: WorldDocumentIssue[]): Extract<WorldSequenceTrack, { type: 'event' }>['keyframes'][number] | null {
  const base = parseKeyframeBase(value, path, issues)
  if (!base || !isRecord(value)) return null
  rejectUnknownKeys(value, ['id', 'time', 'interpolation', 'eventId'], path, issues)
  if (base.interpolation !== undefined && base.interpolation !== 'step') {
    addIssue(issues, 'event-interpolation', `${path}.interpolation`, 'Event keyframes support only step interpolation.')
    return null
  }
  const eventId = parseIdentifier(value.eventId, `${path}.eventId`, issues)
  return eventId ? { id: base.id, time: base.time, ...(base.interpolation === 'step' ? { interpolation: 'step' as const } : {}), eventId } : null
}

function parseKeyframeBase(value: unknown, path: string, issues: WorldDocumentIssue[]): { id: string; time: WorldRationalTime; interpolation?: 'step' | 'linear' | 'cubic' } | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Keyframe must be an object.')
    return null
  }
  const id = parseIdentifier(value.id, `${path}.id`, issues)
  const time = parseRationalTime(value.time, `${path}.time`, issues)
  if (value.interpolation !== undefined && value.interpolation !== 'step' && value.interpolation !== 'linear' && value.interpolation !== 'cubic') addIssue(issues, 'interpolation', `${path}.interpolation`, 'Keyframe interpolation is invalid.')
  return id && time && (value.interpolation === undefined || value.interpolation === 'step' || value.interpolation === 'linear' || value.interpolation === 'cubic')
    ? { id, time, ...(value.interpolation ? { interpolation: value.interpolation } : {}) }
    : null
}

function parseRationalTime(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldRationalTime | null {
  if (!isRecord(value)) {
    addIssue(issues, 'type', path, 'Rational time must be an object.')
    return null
  }
  rejectUnknownKeys(value, ['numerator', 'denominator'], path, issues)
  if (!Number.isSafeInteger(value.numerator) || typeof value.numerator !== 'number' || value.numerator < 0 || !Number.isSafeInteger(value.denominator) || typeof value.denominator !== 'number' || value.denominator <= 0) {
    addIssue(issues, 'rational-time', path, 'Rational time requires safe-integer non-negative numerator and positive denominator values.')
    return null
  }
  return { numerator: value.numerator, denominator: value.denominator }
}

function compareRationalTime(left: WorldRationalTime, right: WorldRationalTime): number {
  const leftValue = BigInt(left.numerator) * BigInt(right.denominator)
  const rightValue = BigInt(right.numerator) * BigInt(left.denominator)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function validateSceneBijection(project: WorldProjectDocumentV1, scenes: WorldSceneDocumentV1[], issues: WorldDocumentIssue[]): void {
  const documents = new Map<string, WorldSceneDocumentV1>()
  const documentIndexes = new Map<string, number>()
  for (const [index, scene] of scenes.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) return
    if (documents.has(scene.sceneId)) addIssue(issues, 'duplicate-id', `snapshot.scenes[${index}].sceneId`, `Duplicate scene document id ${scene.sceneId}.`)
    documents.set(scene.sceneId, scene)
    documentIndexes.set(scene.sceneId, index)
    if (scene.projectId !== project.projectId) addIssue(issues, 'project-mismatch', `snapshot.scenes[${index}].projectId`, 'Scene projectId does not match project.')
  }
  for (const [index, reference] of project.scenes.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) return
    const scene = documents.get(reference.id)
    if (!scene) addIssue(issues, 'missing-scene-document', `project.scenes[${index}].id`, `Scene ${reference.id} has no document.`)
    else if (scene.name !== reference.name) addIssue(issues, 'scene-name-mismatch', `snapshot.scenes[${documentIndexes.get(scene.sceneId) ?? 0}].name`, 'Scene name does not match its project reference.')
  }
  const referenceIds = new Set(project.scenes.map((reference) => reference.id))
  for (const [index, scene] of scenes.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) return
    if (!referenceIds.has(scene.sceneId)) addIssue(issues, 'missing-scene-reference', `snapshot.scenes[${index}].sceneId`, `Scene ${scene.sceneId} has no project reference.`)
  }
}

function validateGlobalIdentifiers(project: WorldProjectDocumentV1, scenes: WorldSceneDocumentV1[], issues: WorldDocumentIssue[]): void {
  const identifiers = new Map<string, string>()
  const register = (id: string, path: string) => {
    if (!canContinueWorldSemanticValidation(issues)) return
    const previous = identifiers.get(id)
    if (previous) addIssue(issues, 'duplicate-id', path, `Identifier ${id} already exists at ${previous}.`)
    else identifiers.set(id, path)
  }
  register(project.projectId, 'project.projectId')
  for (const [index, item] of project.resources.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) return
    register(item.id, `project.resources[${index}].id`)
  }
  for (const [index, item] of project.inputActions.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) return
    register(item.id, `project.inputActions[${index}].id`)
  }
  for (const [index, item] of project.graphicsProfiles.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) return
    register(item.id, `project.graphicsProfiles[${index}].id`)
  }
  for (const [index, item] of project.scenes.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) return
    register(item.id, `project.scenes[${index}].id`)
  }
  for (const [sceneIndex, scene] of scenes.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) return
    for (const [entityIndex, entity] of scene.entities.entries()) {
      if (!canContinueWorldSemanticValidation(issues)) return
      register(entity.id, `snapshot.scenes[${sceneIndex}].entities[${entityIndex}].id`)
      for (const [componentIndex, component] of entity.components.entries()) {
        if (!canContinueWorldSemanticValidation(issues)) return
        const componentPath = `snapshot.scenes[${sceneIndex}].entities[${entityIndex}].components[${componentIndex}]`
        register(component.id, `${componentPath}.id`)
        if (component.type === 'behavior') {
          for (const [bindingIndex, binding] of component.bindings.entries()) {
            if (!canContinueWorldSemanticValidation(issues)) return
            register(binding.id, `${componentPath}.bindings[${bindingIndex}].id`)
          }
        }
      }
    }
    for (const [sequenceIndex, sequence] of scene.sequences.entries()) {
      if (!canContinueWorldSemanticValidation(issues)) return
      register(sequence.id, `snapshot.scenes[${sceneIndex}].sequences[${sequenceIndex}].id`)
      for (const [trackIndex, track] of sequence.tracks.entries()) {
        if (!canContinueWorldSemanticValidation(issues)) return
        register(track.id, `snapshot.scenes[${sceneIndex}].sequences[${sequenceIndex}].tracks[${trackIndex}].id`)
        for (const [keyframeIndex, keyframe] of track.keyframes.entries()) {
          if (!canContinueWorldSemanticValidation(issues)) return
          register(keyframe.id, `snapshot.scenes[${sceneIndex}].sequences[${sequenceIndex}].tracks[${trackIndex}].keyframes[${keyframeIndex}].id`)
        }
      }
    }
  }
}

function validateSceneGraph(scene: WorldSceneDocumentV1, path: string, issues: WorldDocumentIssue[]): void {
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]))
  for (const [index, entity] of scene.entities.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) return
    if (entity.parentId && !entities.has(entity.parentId)) addIssue(issues, 'parent-missing', `${path}.entities[${index}].parentId`, 'Entity parent does not exist in this scene.')
    if (entity.parentId === entity.id) addIssue(issues, 'hierarchy-cycle', `${path}.entities[${index}].parentId`, 'Entity cannot parent itself.')
    const visited = new Set<string>([entity.id])
    let parentId = entity.parentId
    while (parentId) {
      if (visited.has(parentId)) {
        addIssue(issues, 'hierarchy-cycle', `${path}.entities[${index}].parentId`, 'Entity hierarchy contains a cycle.')
        break
      }
      visited.add(parentId)
      parentId = entities.get(parentId)?.parentId ?? null
    }
  }
  const primaryCameras = scene.entities.flatMap((entity) => entity.enabled ? entity.components.filter((component) => component.type === 'camera' && component.enabled && component.primary) : [])
  const primaryListeners = scene.entities.flatMap((entity) => entity.enabled ? entity.components.filter((component) => component.type === 'audio-listener' && component.enabled && component.primary) : [])
  if (primaryCameras.length > 1) addIssue(issues, 'primary-camera', `${path}.entities`, 'Scene can have at most one enabled primary camera.')
  if (primaryListeners.length > 1) addIssue(issues, 'primary-listener', `${path}.entities`, 'Scene can have at most one enabled primary audio listener.')
}

function validateReferences(project: WorldProjectDocumentV1, scenes: WorldSceneDocumentV1[], issues: WorldDocumentIssue[]): void {
  const resources = new Map(project.resources.map((resource) => [resource.id, resource]))
  const sceneIds = new Set(project.scenes.map((scene) => scene.id))
  const inputActions = new Map(project.inputActions.map((action) => [action.id, action]))
  for (const [sceneIndex, scene] of scenes.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) break
    const entities = new Map(scene.entities.map((entity) => [entity.id, entity]))
    const components = new Map(scene.entities.flatMap((entity) => entity.components.map((component) => [component.id, component] as const)))
    const componentOwners = new Map(scene.entities.flatMap((entity) => entity.components.map((component) => [component.id, entity.id] as const)))
    const sequences = new Map(scene.sequences.map((sequence) => [sequence.id, sequence]))
    if (scene.environment.environmentResourceId) {
      const resource = resources.get(scene.environment.environmentResourceId)
      if (resource?.type !== 'environment') addIssue(issues, 'resource-reference', `snapshot.scenes[${sceneIndex}].environment.environmentResourceId`, 'Environment reference must target an environment resource.')
    }
    for (const [entityIndex, entity] of scene.entities.entries()) {
      if (!canContinueWorldSemanticValidation(issues)) break
      for (const [componentIndex, component] of entity.components.entries()) {
        if (!canContinueWorldSemanticValidation(issues)) break
        const componentPath = `snapshot.scenes[${sceneIndex}].entities[${entityIndex}].components[${componentIndex}]`
        for (const reference of collectWorldComponentReferences(component)) {
          if (!canContinueWorldSemanticValidation(issues)) break
          validateComponentReference(reference, resources, entities, components, sceneIds, inputActions, sequences, componentPath, issues)
        }
        validateTypedComponentReferences(component, entity, entities, components, componentOwners, inputActions, sequences, componentPath, issues)
      }
    }
    for (const [sequenceIndex, sequence] of scene.sequences.entries()) {
      if (!canContinueWorldSemanticValidation(issues)) break
      const sequencePath = `snapshot.scenes[${sceneIndex}].sequences[${sequenceIndex}]`
      const targetValidation = validateWorldSequenceTrackTargets(scene, sequence, sequencePath)
      if (!targetValidation.success) {
        for (const issue of targetValidation.issues) {
          if (!canContinueWorldSemanticValidation(issues)) break
          addIssue(issues, issue.code, issue.path, issue.message)
        }
      }
    }
  }
}

function validateTypedComponentReferences(component: WorldComponent, owner: WorldEntity, entities: Map<string, WorldEntity>, components: Map<string, WorldComponent>, componentOwners: Map<string, string>, inputActions: Map<string, WorldInputAction>, sequences: Map<string, WorldSequence>, path: string, issues: WorldDocumentIssue[]): void {
  if (component.type === 'character-controller' || component.type === 'trigger') {
    const target = components.get(component.colliderComponentId)
    if (target && target.type !== 'collider') addIssue(issues, 'component-kind', `${path}.colliderComponentId`, 'Collider reference must target a collider component.')
    else if (target && componentOwners.get(target.id) !== owner.id) addIssue(issues, 'component-owner', `${path}.colliderComponentId`, 'Collider reference must target a collider on the same entity.')
    else if (component.enabled && component.type === 'character-controller' && target?.type === 'collider' && (!target.enabled || target.purpose !== 'simulation' || target.sensor)) {
      addIssue(issues, 'controller-capability', `${path}.colliderComponentId`, 'Enabled character controllers require an enabled simulation non-sensor collider.')
    } else if (component.enabled && component.type === 'trigger' && target?.type === 'collider' && (!target.enabled || target.purpose !== 'simulation' || !target.sensor)) {
      addIssue(issues, 'trigger-capability', `${path}.colliderComponentId`, 'Enabled triggers require an enabled simulation sensor collider.')
    }
  }
  if (component.type === 'character-controller') {
    const moveAction = inputActions.get(component.moveActionId)
    if (moveAction && moveAction.valueType !== 'axis2d') addIssue(issues, 'input-action-kind', `${path}.moveActionId`, 'Character controller movement requires an axis2d input action.')
    const jumpAction = component.jumpActionId ? inputActions.get(component.jumpActionId) : undefined
    if (jumpAction && jumpAction.valueType !== 'button') addIssue(issues, 'input-action-kind', `${path}.jumpActionId`, 'Character controller jump requires a button input action.')
    if (component.enabled) {
      const body = owner.components.find((candidate) => candidate.type === 'rigid-body')
      if (body?.type !== 'rigid-body' || !body.enabled || body.bodyType !== 'kinematic-position') {
        addIssue(issues, 'controller-capability', `${path}.enabled`, 'Enabled character controllers require an enabled kinematic-position rigid body on the same entity.')
      }
    }
  }
  if (component.type !== 'behavior') return
  for (const [bindingIndex, binding] of component.bindings.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) break
    const bindingPath = `${path}.bindings[${bindingIndex}]`
    if (binding.event.type === 'trigger-enter' || binding.event.type === 'trigger-exit') {
      const trigger = components.get(binding.event.triggerComponentId)
      if (trigger && trigger.type !== 'trigger') addIssue(issues, 'component-kind', `${bindingPath}.event.triggerComponentId`, 'Trigger event must reference a trigger component.')
      else if (trigger) {
        const triggerOwner = entities.get(componentOwners.get(trigger.id) ?? '')
        const collider = components.get(trigger.colliderComponentId)
        if (!trigger.enabled || !triggerOwner?.enabled || collider?.type !== 'collider' || !collider.enabled || !collider.sensor || collider.purpose !== 'simulation') {
          addIssue(issues, 'behavior-capability', `${bindingPath}.event.triggerComponentId`, 'Trigger events require an enabled trigger on an enabled entity with an enabled simulation sensor collider.')
        }
      }
    }
    if (binding.event.type === 'sequence-event') {
      const event = binding.event
      const sequence = sequences.get(event.sequenceId)
      if (sequence && !sequence.tracks.some((track) => track.type === 'event' && track.keyframes.some((keyframe) => keyframe.eventId === event.eventId))) {
        addIssue(issues, 'sequence-event-reference', `${bindingPath}.event.eventId`, 'Sequence event must reference an event keyframe in the same scene sequence.')
      }
    }
    for (const [actionIndex, action] of binding.actions.entries()) {
      if (!canContinueWorldSemanticValidation(issues)) break
      const actionPath = `${bindingPath}.actions[${actionIndex}]`
      const targetEntity = 'entityId' in action ? entities.get(action.entityId) : undefined
      if ('entityId' in action && !targetEntity) continue
      if (action.type === 'set-visibility' && !targetEntity?.components.some((candidate) => candidate.type === 'renderable')) {
        addIssue(issues, 'behavior-capability', `${actionPath}.entityId`, 'Visibility actions require a target entity with a renderable component.')
      }
      if (action.type === 'set-component-property') {
        const target = components.get(action.componentId)
        if (target && target.type !== action.componentType) addIssue(issues, 'component-kind', `${actionPath}.componentId`, 'Property action component type does not match its target.')
        else if (target && componentOwners.get(target.id) !== action.entityId) addIssue(issues, 'component-owner', `${actionPath}.componentId`, 'Property action component must belong to its target entity.')
        else if (target && !isWorldComponentPropertyWritableFor(target, action.property, action.value)) addIssue(issues, 'behavior-capability', `${actionPath}.property`, `Property ${action.property} is incompatible with the target component.`)
      }
      if (action.type === 'play-animation' || action.type === 'play-audio' || action.type === 'stop-audio') {
        const target = components.get(action.componentId)
        const required = action.type === 'play-animation' ? 'animation-player' : 'audio-source'
        if (target && target.type !== required) addIssue(issues, 'component-kind', `${actionPath}.componentId`, `${action.type} must target ${required}.`)
        else if (target && componentOwners.get(target.id) !== action.entityId) addIssue(issues, 'component-owner', `${actionPath}.componentId`, 'Playback component must belong to its target entity.')
        else if (target && (!target.enabled || !targetEntity?.enabled)) addIssue(issues, 'behavior-capability', `${actionPath}.componentId`, 'Audio and animation actions require an enabled component on an enabled entity.')
      }
      if (action.type === 'apply-impulse' && targetEntity) {
        const body = targetEntity.components.find((candidate) => candidate.type === 'rigid-body')
        if (!targetEntity.enabled || body?.type !== 'rigid-body' || !body.enabled || body.bodyType !== 'dynamic') {
          addIssue(issues, 'behavior-capability', `${actionPath}.entityId`, 'Impulse actions require an enabled dynamic rigid body on an enabled entity.')
        }
      }
    }
  }
}

function validateComponentReference(reference: WorldComponentReference, resources: Map<string, WorldResource>, entities: Map<string, WorldEntity>, components: Map<string, WorldComponent>, sceneIds: Set<string>, inputActions: Map<string, WorldInputAction>, sequences: Map<string, WorldSequence>, componentPath: string, issues: WorldDocumentIssue[]): void {
  let validReference = false
  if (reference.kind === 'resource') validReference = resources.get(reference.id)?.type === reference.resourceType
  if (reference.kind === 'entity') validReference = entities.has(reference.id)
  if (reference.kind === 'component') validReference = components.has(reference.id)
  if (reference.kind === 'scene') validReference = sceneIds.has(reference.id)
  if (reference.kind === 'input-action') validReference = inputActions.has(reference.id)
  if (reference.kind === 'sequence') validReference = sequences.has(reference.id)
  if (!validReference) addIssue(issues, `${reference.kind}-reference`, `${componentPath}.${reference.path}`, `${reference.kind} reference ${reference.id} is missing or has the wrong kind.`)
}

function validateComponentCardinality(components: WorldComponent[], path: string, issues: WorldDocumentIssue[]): void {
  const counts = new Map<string, number>()
  for (const component of components) {
    if (!canContinueWorldSemanticValidation(issues)) return
    const definition = getWorldComponentDefinition(component.type)
    if (!definition?.entityAllowed) addIssue(issues, 'component-scope', `${path}.components`, `${component.type} is scene-scoped and cannot be attached to an entity.`)
    counts.set(component.type, (counts.get(component.type) ?? 0) + 1)
  }
  for (const [type, count] of counts) {
    if (!canContinueWorldSemanticValidation(issues)) return
    if (count > 1 && getWorldComponentDefinition(type)?.cardinality === 'one') addIssue(issues, 'component-cardinality', `${path}.components`, `Entity can contain at most one ${type} component.`)
  }
}

function parseArray<T>(value: unknown, path: string, issues: WorldDocumentIssue[], parser: (value: unknown, path: string, issues: WorldDocumentIssue[]) => T | null): T[] {
  if (!Array.isArray(value)) {
    addIssue(issues, 'type', path, `${path} must be an array.`)
    return []
  }
  if (value.length > WORLD_MAX_COLLECTION_ITEMS) {
    addIssue(issues, 'collection-limit', path, `${path} cannot contain more than ${WORLD_MAX_COLLECTION_ITEMS} entries.`)
    return []
  }
  const result: T[] = []
  for (const [index, item] of value.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) break
    const parsed = parser(item, `${path}[${index}]`, issues)
    if (parsed !== null) result.push(parsed)
  }
  return result
}

function collectDuplicateIds(items: readonly { id: string }[], path: string, issues: WorldDocumentIssue[]): void {
  const seen = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) break
    if (seen.has(item.id)) addIssue(issues, 'duplicate-id', `${path}[${index}].id`, `Duplicate id ${item.id}.`)
    seen.add(item.id)
  }
}

function parseStringSet(value: unknown, path: string, issues: WorldDocumentIssue[]): string[] | null {
  if (!Array.isArray(value)) {
    addIssue(issues, 'type', path, 'Tags must be an array.')
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
    const parsed = parseIdentifier(item, `${path}[${index}]`, issues)
    if (parsed && seen.has(parsed)) addIssue(issues, 'duplicate-value', `${path}[${index}]`, `Duplicate value ${parsed}.`)
    else if (parsed) {
      seen.add(parsed)
      result.push(parsed)
    }
  }
  return result
}

function parseIdentifier(value: unknown, path: string, issues: WorldDocumentIssue[]): string | null {
  if (!isWorldCanonicalId(value)) {
    addIssue(issues, 'identifier', path, 'Identifier must be a non-empty canonical string of at most 256 characters.')
    return null
  }
  return value
}

function parsePropertyName(value: unknown, path: string, issues: WorldDocumentIssue[]): string | null {
  if (!isWorldCanonicalPropertyName(value)) {
    addIssue(issues, 'property-name', path, 'Property name must be a canonical string of at most 256 characters.')
    return null
  }
  return value
}

function optionalIdentifier(value: unknown, path: string, issues: WorldDocumentIssue[]): string | undefined {
  return value === undefined ? undefined : parseIdentifier(value, path, issues) ?? undefined
}

function parseName(value: unknown, path: string, issues: WorldDocumentIssue[]): string | null {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 512) {
    addIssue(issues, 'name', path, 'Name must be a non-empty string.')
    return null
  }
  return value.trim()
}

function optionalName(value: unknown, path: string, issues: WorldDocumentIssue[]): string | undefined {
  return value === undefined ? undefined : parseName(value, path, issues) ?? undefined
}

function parseRevision(value: unknown, path: string, issues: WorldDocumentIssue[]): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    addIssue(issues, 'revision', path, 'Revision must be a non-negative safe integer.')
    return null
  }
  return value
}

function finiteNumber(value: unknown, path: string, issues: WorldDocumentIssue[]): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addIssue(issues, 'finite-number', path, 'Value must be a finite number.')
    return null
  }
  return value
}

function positiveNumber(value: unknown, path: string, issues: WorldDocumentIssue[]): number | null {
  const parsed = finiteNumber(value, path, issues)
  if (parsed !== null && parsed <= 0) {
    addIssue(issues, 'positive-number', path, 'Value must be greater than zero.')
    return null
  }
  return parsed
}

function nonNegativeNumber(value: unknown, path: string, issues: WorldDocumentIssue[]): number | null {
  const parsed = finiteNumber(value, path, issues)
  if (parsed !== null && parsed < 0) {
    addIssue(issues, 'non-negative-number', path, 'Value must be non-negative.')
    return null
  }
  return parsed
}

function rangedNumber(value: unknown, minimum: number, maximum: number, path: string, issues: WorldDocumentIssue[]): number | null {
  const parsed = finiteNumber(value, path, issues)
  if (parsed !== null && (parsed < minimum || parsed > maximum)) {
    addIssue(issues, 'number-range', path, `Value must be between ${minimum} and ${maximum}.`)
    return null
  }
  return parsed
}

function parseVector3(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldVector3 | null {
  if (!Array.isArray(value) || value.length !== 3) {
    addIssue(issues, 'vector3', path, 'Value must be a numeric triple.')
    return null
  }
  const x = finiteNumber(value[0], `${path}[0]`, issues)
  const y = finiteNumber(value[1], `${path}[1]`, issues)
  const z = finiteNumber(value[2], `${path}[2]`, issues)
  return x === null || y === null || z === null ? null : [x, y, z]
}

function parseColor(value: unknown, path: string, issues: WorldDocumentIssue[]): WorldColor | null {
  if (!isWorldColor(value)) {
    addIssue(issues, 'color', path, 'Color must be a six- or eight-digit hexadecimal value.')
    return null
  }
  return value
}

function isWorldColor(value: unknown): value is WorldColor {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)
}

function optionalWorkspacePath(value: unknown, path: string, issues: WorldDocumentIssue[]): string | undefined {
  if (value === undefined) return undefined
  const parsed = normalizeWorldWorkspacePath(value)
  if (!parsed) addIssue(issues, 'workspace-path', path, 'Path must be canonical and workspace-relative.')
  return parsed ?? undefined
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: WorldDocumentIssue[]): void {
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

function addIssue(issues: WorldDocumentIssue[], code: string, path: string, message: string): void {
  if (issues.length >= WORLD_MAX_SEMANTIC_ISSUES) return
  issues.push({ code, path, message })
}

function appendResultIssues<T>(result: WorldDocumentResult<T>, issues: WorldDocumentIssue[]): void {
  if (!result.success) {
    for (const issue of result.issues) {
      if (!canContinueWorldSemanticValidation(issues)) break
      addIssue(issues, issue.code, issue.path, issue.message)
    }
  }
}

function stripRoot(path: string, root: string): string {
  return path === root ? '' : path.startsWith(`${root}.`) || path.startsWith(`${root}[`) ? path.slice(root.length) : `.${path}`
}

function isSafeDecodedWorkspacePath(value: string): boolean {
  if (!value || value.length > 4_096 || value.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.includes('\\') || containsAsciiControl(value)) return false
  const segments = value.split('/')
  return !segments.some((segment) => !segment
    || segment === '.'
    || segment === '..'
    || /[<>:"|?*]/.test(segment)
    || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:[. ]|$)/i.test(segment))
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function normalizeDocumentWire(value: unknown, rootPath: string): WorldDocumentResult<unknown> {
  const normalized = normalizeWorldWireValue(value, rootPath)
  if (normalized.success) return valid(normalized.value)
  return failed(normalized.issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message })))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isSafeWorldWireRecord(value)
}

function valid<T>(value: T): WorldDocumentResult<T> {
  return { success: true, value }
}

function invalid<T>(path: string, code: string, message: string): WorldDocumentResult<T> {
  return { success: false, issues: [{ path, code, message }] }
}

function failed<T>(issues: WorldDocumentIssue[]): WorldDocumentResult<T> {
  return { success: false, issues: [...issues].sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code) || left.message.localeCompare(right.message)) }
}
