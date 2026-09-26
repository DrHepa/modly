import type { SceneArtifactManifestV1 } from '../../../shared/types/artifacts.ts'
import type { WorldSceneItemAnimationBinding } from '../worldRenderableResolver.ts'
import {
  parseWorldsSceneManifest,
  type WorldsSceneManifestAssetV1,
  type WorldsSceneManifestV1,
} from '../worldsSceneManifest.ts'
import type { WorldCollisionSurface } from '../worldsCollisionSurfaces.ts'
import { buildWorldsCollisionSurfaceManifest } from '../worldsCollisionSurfaceManifest.ts'
import type { WorldColliderComponent, WorldRenderableComponent } from './worldComponentRegistry.ts'
import { cloneWorldProjectSnapshot, validateWorldProjectSnapshot } from './worldDocuments.ts'
import {
  WORLD_PROJECT_SCHEMA,
  WORLD_SCENE_SCHEMA,
  type WorldAnimationResource,
  type WorldEntity,
  type WorldModelResource,
  type WorldProjectSnapshotV1,
  type WorldResource,
  type WorldSceneDocumentV1,
} from './worldModel.ts'
import { isWorldCanonicalId, WORLD_ID_MAX_LENGTH } from './worldValidationLimits.ts'
import { isSafeWorldWireRecord, normalizeWorldWireValue } from './worldWireValidation.ts'

const LEGACY_IMPORT_GRAPHICS_PROFILE_ID = 'graphics:legacy-balanced'
const LEGACY_DEFAULT_ENVIRONMENT = { backgroundColor: '#20242b' as const, ambientIntensity: 0.35 }
const LEGACY_MIN_TRIANGLE_AREA_TWICE = 1e-8
const LEGACY_GENERATED_ID_MAX_LENGTH = 228

export interface LegacyWorldsImportOptions {
  projectId?: string
  projectName?: string
  sceneId?: string
  sceneName?: string
  sceneDocumentPath?: string
}

export interface LegacyWorldsAdapterWarning {
  code: string
  path: string
  message: string
}

export type ImportLegacyWorldsSceneManifestResult =
  | { success: true; snapshot: WorldProjectSnapshotV1; warnings: LegacyWorldsAdapterWarning[] }
  | { success: false; issues: LegacyWorldsAdapterWarning[] }

export type LegacyWorldsLossCode =
  | 'extra-scenes'
  | 'hierarchy'
  | 'camera'
  | 'light'
  | 'environment'
  | 'simulation-physics'
  | 'audio'
  | 'behavior'
  | 'triggers'
  | 'unsupported-animation'
  | 'sequences'
  | 'input-actions'
  | 'graphics-profiles'
  | 'tags-locks'
  | 'unsupported-resources'
  | 'unsupported-entity'
  | 'entity-state'
  | 'renderable-state'
  | 'renderable-shadow'
  | 'renderable-material'
  | 'collider-grouping'
  | 'collider-transform'
  | 'collider-geometry'
  | 'collider-state'
  | 'collider-sensor'
  | 'collider-material'
  | 'collider-layers'
  | 'identity-remap'
  | 'project-metadata'
  | 'scene-metadata'

export interface LegacyWorldsExportLoss {
  id: string
  code: LegacyWorldsLossCode
  path: string
  message: string
}

export interface LegacyWorldsExportAnalysis {
  valid: boolean
  sceneId: string | null
  losses: LegacyWorldsExportLoss[]
  issues: LegacyWorldsAdapterWarning[]
}

export interface ExportLegacyWorldsSceneOptions {
  sceneId?: string
  acceptedLosses: string[]
  now?: Date
}

export type ExportLegacyWorldsSceneManifestResult =
  | { success: true; manifest: WorldsSceneManifestV1; losses: LegacyWorldsExportLoss[] }
  | { success: false; issues: LegacyWorldsAdapterWarning[]; unacceptedLosses: LegacyWorldsExportLoss[] }

export function importLegacyWorldsSceneManifest(manifestValue: unknown, options: LegacyWorldsImportOptions = {}): ImportLegacyWorldsSceneManifestResult {
  const wire = normalizeWorldWireValue(manifestValue, 'manifest')
  if (!wire.success) return { success: false, issues: wire.issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message })) }
  manifestValue = wire.value
  const parsed = parseWorldsSceneManifest(manifestValue)
  if (!parsed.success) return { success: false, issues: [{ code: 'legacy-manifest', path: 'manifest', message: parsed.error }] }
  const publicManifest: SceneArtifactManifestV1 = parsed.manifest
  const projectId = options.projectId ?? 'project:legacy-import'
  const projectName = options.projectName ?? 'Imported world'
  const sceneId = options.sceneId ?? 'scene:legacy-import'
  const sceneName = options.sceneName ?? 'Imported scene'
  const sceneDocumentPath = options.sceneDocumentPath ?? 'Worlds/imported/scenes/legacy.world-scene.json'
  const warnings = collectDuplicateIdWarnings(manifestValue, parsed.manifest)
  const usedIds = new Set<string>([projectId, sceneId, LEGACY_IMPORT_GRAPHICS_PROFILE_ID])
  const resources: WorldResource[] = []
  const entities: WorldEntity[] = []

  for (const [index, asset] of parsed.manifest.assets.entries()) {
    const entityId = allocateId(`entity:${asset.id ?? `legacy-asset-${index + 1}`}`, usedIds)
    const modelResourceId = allocateId(`resource:model:${entityId}`, usedIds)
    const renderableComponentId = allocateId(`component:renderable:${entityId}`, usedIds)
    const modelResource: WorldModelResource = {
      id: modelResourceId,
      type: 'model',
      name: asset.name ?? basename(asset.workspacePath),
      workspacePath: asset.workspacePath,
      format: asset.kind,
    }
    resources.push(modelResource)
    const renderable: WorldRenderableComponent = {
      id: renderableComponentId,
      type: 'renderable',
      enabled: true,
      resourceId: modelResourceId,
      visible: asset.visible !== false,
      castShadow: true,
      receiveShadow: true,
      material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
    }
    const entity: WorldEntity = {
      id: entityId,
      name: asset.name ?? basename(asset.workspacePath),
      parentId: null,
      enabled: true,
      locked: false,
      tags: asset.role === 'base-scene' ? ['modly:base-scene'] : [],
      transform: structuredClone(asset.transform),
      components: [renderable],
    }
    if (asset.animation) addLegacyPoseClip(asset.animation, entity, resources, usedIds)
    entities.push(entity)
  }

  for (const [index, surface] of parsed.collisionSurfaces.entries()) {
    const entityId = allocateId(`entity:${surface.id || `legacy-surface-${index + 1}`}`, usedIds)
    const componentId = allocateId(`component:collider:${entityId}`, usedIds)
    const collider: WorldColliderComponent = surface.shape === 'rect'
      ? {
          id: componentId,
          type: 'collider',
          enabled: true,
          purpose: 'editor-navigation',
          shape: 'rect-surface',
          halfExtents: [surface.geometry.halfWidth, surface.geometry.halfHeight],
          sidedness: surface.sidedness ?? 'double',
          sensor: false,
          friction: 0,
          restitution: 0,
          ...(surface.preset && surface.preset !== 'triangle' ? { legacyPreset: surface.preset } : {}),
        }
      : {
          id: componentId,
          type: 'collider',
          enabled: true,
          purpose: 'editor-navigation',
          shape: 'tri-surface',
          vertices: structuredClone(surface.geometry.vertices),
          sidedness: surface.sidedness ?? 'double',
          sensor: false,
          friction: 0,
          restitution: 0,
          ...(surface.preset === 'triangle' ? { legacyPreset: surface.preset } : {}),
        }
    entities.push({
      id: entityId,
      name: surface.label ?? surface.id,
      parentId: null,
      enabled: true,
      locked: false,
      tags: ['modly:editor-navigation'],
      transform: structuredClone(surface.transform),
      components: [collider],
    })
  }

  const scene: WorldSceneDocumentV1 = {
    schema: WORLD_SCENE_SCHEMA,
    projectId,
    sceneId,
    name: sceneName,
    environment: { ...LEGACY_DEFAULT_ENVIRONMENT },
    ...(publicManifest.initialView ? { editor: { initialView: structuredClone(publicManifest.initialView) } } : {}),
    entities,
    sequences: [],
  }
  const snapshot: WorldProjectSnapshotV1 = {
    project: {
      schema: WORLD_PROJECT_SCHEMA,
      projectId,
      name: projectName,
      revision: 0,
      resources,
      scenes: [{ id: sceneId, name: sceneName, documentPath: sceneDocumentPath }],
      startSceneId: sceneId,
      inputActions: [],
      graphicsProfiles: [{ id: LEGACY_IMPORT_GRAPHICS_PROFILE_ID, name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'msaa' }],
      activeGraphicsProfileId: LEGACY_IMPORT_GRAPHICS_PROFILE_ID,
    },
    scenes: [scene],
  }
  const validated = validateWorldProjectSnapshot(snapshot)
  if (!validated.success) return { success: false, issues: validated.issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message })) }
  return { success: true, snapshot: validated.value, warnings: warnings.sort(compareWarning) }
}

export function analyzeLegacyWorldsSceneExport(snapshotValue: unknown, options: { sceneId?: string } = {}): LegacyWorldsExportAnalysis {
  const validated = validateWorldProjectSnapshot(snapshotValue)
  if (!validated.success) {
    return { valid: false, sceneId: null, losses: [], issues: validated.issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message })) }
  }
  const snapshot = validated.value
  const sceneId = options.sceneId ?? snapshot.project.startSceneId
  const sceneIndex = snapshot.scenes.findIndex((candidate) => candidate.sceneId === sceneId)
  if (sceneIndex < 0) return { valid: false, sceneId, losses: [], issues: [{ code: 'scene-missing', path: 'sceneId', message: `Scene ${sceneId} does not exist.` }] }
  const scene = snapshot.scenes[sceneIndex]
  const losses: LegacyWorldsExportLoss[] = []
  const lossIds = new Set<string>()
  const add = (code: LegacyWorldsLossCode, path: string, message: string) => addLoss(losses, lossIds, code, path, message)
  const selectedReferenceIndex = snapshot.project.scenes.findIndex((reference) => reference.id === sceneId)

  add('project-metadata', 'project.projectId', 'Legacy format does not store the canonical project id.')
  add('project-metadata', 'project.name', 'Legacy format does not store the canonical project name.')
  add('project-metadata', 'project.revision', 'Legacy format does not store the canonical project revision.')
  if (selectedReferenceIndex >= 0) {
    add('scene-metadata', `project.scenes[${selectedReferenceIndex}].id`, 'Legacy format does not store the selected canonical scene id.')
    add('scene-metadata', `project.scenes[${selectedReferenceIndex}].name`, 'Legacy format does not store the selected canonical scene name.')
    add('scene-metadata', `project.scenes[${selectedReferenceIndex}].documentPath`, 'Legacy format does not store the selected canonical scene document path.')
  }

  if (snapshot.scenes.length > 1) add('extra-scenes', 'project.scenes', 'Legacy format exports one scene and omits the remaining scenes.')
  if (snapshot.project.inputActions.length) add('input-actions', 'project.inputActions', 'Legacy format does not preserve named input actions.')
  if (snapshot.project.graphicsProfiles.length) add('graphics-profiles', 'project.graphicsProfiles', 'Legacy format does not preserve graphics profiles.')
  if (!isLegacyDefaultEnvironment(scene)) add('environment', `scenes[${sceneIndex}].environment`, 'Legacy format does not preserve scene environment settings.')
  if (scene.sequences.length) add('sequences', `scenes[${sceneIndex}].sequences`, 'Legacy format does not preserve sequences or tracks.')

  const referencedResources = new Set<string>()
  const resourceReferenceCounts = new Map<string, number>()
  const resourceEntries = new Map(snapshot.project.resources.map((resource, index) => [resource.id, { resource, index }]))
  const projectedIds = projectLegacyIds(scene)
  const trackResource = (resourceId: string) => {
    referencedResources.add(resourceId)
    resourceReferenceCounts.set(resourceId, (resourceReferenceCounts.get(resourceId) ?? 0) + 1)
  }
  for (const [entityIndex, entity] of scene.entities.entries()) {
    const entityPath = `scenes[${sceneIndex}].entities[${entityIndex}]`
    if (entity.parentId) add('hierarchy', `${entityPath}.parentId`, 'Legacy format flattens entity hierarchy.')
    if (!entity.enabled) add('entity-state', `${entityPath}.enabled`, 'Legacy format cannot preserve the entity enabled flag independently from renderable visibility and omits disabled navigation surfaces.')
    if (entity.locked) add('tags-locks', `${entityPath}.locked`, 'Legacy format omits entity locks.')
    const renderableCount = entity.components.filter((component) => component.type === 'renderable').length
    const navigationColliders = entity.components.filter((component): component is WorldColliderComponent => component.type === 'collider' && component.purpose === 'editor-navigation' && (component.shape === 'rect-surface' || component.shape === 'tri-surface'))
    const navigationColliderCount = navigationColliders.length
    const projectedAssetId = projectedIds.assetIdsByEntityIndex.get(entityIndex) ?? null
    const projectedAssetEntityId = projectedAssetId ? `entity:${projectedAssetId}` : null
    for (const [tagIndex, tag] of entity.tags.entries()) {
      const supportedRoleTag = (tag === 'modly:base-scene' && renderableCount > 0)
        || (tag === 'modly:editor-navigation' && navigationColliderCount > 0)
      if (!supportedRoleTag) add('tags-locks', `${entityPath}.tags[${tagIndex}]`, `Legacy format cannot preserve entity tag ${tag} on this content.`)
    }
    if (navigationColliderCount > 0 && !entity.tags.includes('modly:editor-navigation')) add('tags-locks', `${entityPath}.tags`, 'Legacy navigation surface import adds the modly:editor-navigation tag.')
    if (navigationColliderCount > 1 || (navigationColliderCount > 0 && renderableCount > 0)) {
      add('collider-grouping', `${entityPath}.components`, 'Legacy import creates a separate entity for every collision surface and cannot preserve this component grouping.')
    }
    if (navigationColliderCount > 0 && (entity.transform.scale.some((value) => value <= 0) || entity.transform.scale[1] !== 1)) {
      add('collider-transform', `${entityPath}.transform.scale`, 'Legacy navigation surfaces require positive scale and normalize the vertical scale to 1; non-positive surfaces are omitted.')
    }
    let supportedComponent = false
    for (const [componentIndex, component] of entity.components.entries()) {
      const componentPath = `${entityPath}.components[${componentIndex}]`
      if (component.type === 'renderable') {
        supportedComponent = true
        trackResource(component.resourceId)
        const modelEntry = resourceEntries.get(component.resourceId)
        if (projectedAssetEntityId && entity.id !== projectedAssetEntityId) add('identity-remap', `${entityPath}.id`, 'Legacy asset serialization cannot preserve this canonical entity id; re-import derives it from the asset id.')
        if (projectedAssetEntityId && component.id !== `component:renderable:${projectedAssetEntityId}`) add('identity-remap', `${componentPath}.id`, 'Legacy assets do not store renderable component ids; re-import derives a new id.')
        if (projectedAssetEntityId && modelEntry?.resource.type === 'model' && component.resourceId !== `resource:model:${projectedAssetEntityId}`) add('identity-remap', `project.resources[${modelEntry.index}].id`, 'Legacy assets do not store model resource ids; re-import derives a new id.')
        if (modelEntry?.resource.type === 'model' && modelEntry.resource.name !== entity.name) {
          add('unsupported-resources', `project.resources[${modelEntry.index}].name`, 'Legacy assets use the entity name and cannot preserve a distinct model resource name.')
        }
        if (!component.enabled) add('renderable-state', `${componentPath}.enabled`, 'Legacy visibility cannot preserve the renderable enabled flag independently.')
        if (!component.castShadow) add('renderable-shadow', `${componentPath}.castShadow`, 'Legacy format does not preserve the cast-shadow flag.')
        if (!component.receiveShadow) add('renderable-shadow', `${componentPath}.receiveShadow`, 'Legacy format does not preserve the receive-shadow flag.')
        if (component.material.baseColor.toLowerCase() !== '#ffffff') add('renderable-material', `${componentPath}.material.baseColor`, 'Legacy format does not preserve PBR base color.')
        if (component.material.metallic !== 0) add('renderable-material', `${componentPath}.material.metallic`, 'Legacy format does not preserve PBR metallic.')
        if (component.material.roughness !== 1) add('renderable-material', `${componentPath}.material.roughness`, 'Legacy format does not preserve PBR roughness.')
        if (component.material.opacity !== 1) add('renderable-material', `${componentPath}.material.opacity`, 'Legacy format does not preserve PBR opacity independently from visibility.')
      } else if (component.type === 'collider' && component.purpose === 'editor-navigation' && (component.shape === 'rect-surface' || component.shape === 'tri-surface')) {
        supportedComponent = true
        const projectedSurfaceId = projectedIds.surfaceIdsByComponentId.get(component.id)
        const projectedColliderEntityId = projectedSurfaceId ? `entity:${projectedSurfaceId}` : undefined
        if (projectedColliderEntityId && entity.id !== projectedColliderEntityId) add('identity-remap', `${entityPath}.id`, 'Legacy collision serialization cannot preserve this canonical entity id; re-import derives it from the surface id.')
        if (projectedColliderEntityId && component.id !== `component:collider:${projectedColliderEntityId}`) add('identity-remap', `${componentPath}.id`, 'Legacy collision surfaces do not store collider component ids; re-import derives a new id.')
        if (component.shape === 'tri-surface') {
          const areaTwice = legacySignedTriangleAreaTwice(component.vertices)
          if (Math.abs(areaTwice) <= LEGACY_MIN_TRIANGLE_AREA_TWICE) add('collider-geometry', `${componentPath}.vertices`, 'Legacy collision serialization rejects triangles at or below its minimum area; this surface is omitted.')
          else if (areaTwice < 0) add('collider-geometry', `${componentPath}.vertices`, 'Legacy collision serialization canonicalizes triangle winding and cannot preserve this authored vertex order.')
        }
        if (!component.enabled) add('collider-state', `${componentPath}.enabled`, 'Legacy navigation surfaces do not preserve disabled collider state and the surface is omitted.')
        if (component.sensor) add('collider-sensor', `${componentPath}.sensor`, 'Legacy navigation surfaces do not preserve sensor semantics.')
        if (component.friction !== 0) add('collider-material', `${componentPath}.friction`, 'Legacy navigation surfaces do not preserve collider friction.')
        if (component.restitution !== 0) add('collider-material', `${componentPath}.restitution`, 'Legacy navigation surfaces do not preserve collider restitution.')
        if (component.collisionLayer !== undefined) add('collider-layers', `${componentPath}.collisionLayer`, 'Legacy navigation surfaces do not preserve collision layers.')
        if (component.collisionMask !== undefined) add('collider-layers', `${componentPath}.collisionMask`, 'Legacy navigation surfaces do not preserve collision masks.')
      } else if (component.type === 'animation-player') {
        trackResource(component.resourceId)
        const animationEntry = resourceEntries.get(component.resourceId)
        const resource = animationEntry?.resource
        if (projectedAssetEntityId && component.id !== `component:animation:${projectedAssetEntityId}`) add('identity-remap', `${componentPath}.id`, 'Legacy animation bindings do not store animation-player component ids; re-import derives a new id.')
        if (projectedAssetEntityId && animationEntry?.resource.type === 'animation' && component.resourceId !== `resource:animation:${projectedAssetEntityId}`) add('identity-remap', `project.resources[${animationEntry.index}].id`, 'Legacy animation bindings do not store animation resource ids; re-import derives a new id.')
        if (!entity.components.some((candidate) => candidate.type === 'renderable')) add('unsupported-animation', componentPath, 'Legacy animation bindings require a renderable on the same entity.')
        if (resource?.type !== 'animation' || resource.format !== 'pose-clip' || !resource.sourceWorkspacePath) add('unsupported-animation', `${componentPath}.resourceId`, 'Legacy animation binding requires a pose-clip resource with a source workspace path.')
        if (resource?.type === 'animation' && resource.format === 'pose-clip' && animationEntry) {
          const importedName = resource.clipName ?? resource.clipId ?? `${entity.name} animation`
          if (resource.name !== importedName) add('unsupported-animation', `project.resources[${animationEntry.index}].name`, 'Legacy animation import derives the resource name from clip metadata or the entity name.')
        }
        if (!component.enabled) add('unsupported-animation', `${componentPath}.enabled`, 'Legacy animation binding does not preserve disabled animation players.')
        if (component.autoplay) add('unsupported-animation', `${componentPath}.autoplay`, 'Legacy animation binding does not preserve autoplay.')
        if (!component.loop) add('unsupported-animation', `${componentPath}.loop`, 'Legacy animation binding always imports as looping.')
        if (component.speed !== 1) add('unsupported-animation', `${componentPath}.speed`, 'Legacy animation binding does not preserve playback speed.')
      } else if (component.type === 'camera') add('camera', componentPath, 'Legacy format does not preserve gameplay cameras.')
      else if (component.type === 'light') add('light', componentPath, 'Legacy format does not preserve lights.')
      else if (component.type === 'environment') add('environment', componentPath, 'Legacy format does not preserve environment components.')
      else if (component.type === 'collider' || component.type === 'rigid-body' || component.type === 'character-controller') add('simulation-physics', componentPath, 'Legacy format does not preserve simulation physics or unsupported colliders.')
      else if (component.type === 'audio-source' || component.type === 'audio-listener') {
        add('audio', componentPath, 'Legacy format does not preserve audio components.')
        if (component.type === 'audio-source') trackResource(component.resourceId)
      } else if (component.type === 'behavior') add('behavior', componentPath, 'Legacy format does not preserve visual behaviors.')
      else if (component.type === 'trigger') add('triggers', componentPath, 'Legacy format does not preserve triggers.')
    }
    if (!supportedComponent) add('unsupported-entity', entityPath, 'Legacy format cannot represent this entity.')
  }

  for (const [resourceIndex, resource] of snapshot.project.resources.entries()) {
    const path = `project.resources[${resourceIndex}]`
    if (resource.type === 'audio') add('audio', path, 'Legacy format does not preserve audio resources.')
    else if (resource.type === 'environment') add('unsupported-resources', path, 'Legacy format does not preserve environment resources.')
    else if (resource.type === 'animation' && resource.format !== 'pose-clip') add('unsupported-animation', path, 'Legacy format supports only pose-clip animation resources.')
    else if (!referencedResources.has(resource.id)) add('unsupported-resources', path, 'Legacy export would omit this unreferenced resource.')
    else if ((resource.type === 'model' || resource.type === 'animation') && (resourceReferenceCounts.get(resource.id) ?? 0) > 1) add('unsupported-resources', `${path}.id`, 'Legacy import creates one resource per asset and cannot preserve shared resource identity.')
  }
  return { valid: true, sceneId, losses: losses.sort(compareLoss), issues: [] }
}

export function exportLegacyWorldsSceneManifest(snapshotValue: unknown, options: ExportLegacyWorldsSceneOptions): ExportLegacyWorldsSceneManifestResult {
  const analysis = analyzeLegacyWorldsSceneExport(snapshotValue, { sceneId: options.sceneId })
  if (!analysis.valid || !analysis.sceneId) return { success: false, issues: analysis.issues, unacceptedLosses: analysis.losses }
  const accepted = new Set(options.acceptedLosses)
  const unacceptedLosses = analysis.losses.filter((loss) => !accepted.has(loss.id))
  if (unacceptedLosses.length) return { success: false, issues: [{ code: 'loss-acceptance-required', path: 'acceptedLosses', message: 'Every legacy export loss must be accepted explicitly.' }], unacceptedLosses }
  const validated = validateWorldProjectSnapshot(snapshotValue)
  if (!validated.success) return { success: false, issues: validated.issues, unacceptedLosses: [] }
  const snapshot = cloneWorldProjectSnapshot(validated.value)
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === analysis.sceneId)
  if (!scene) return { success: false, issues: [{ code: 'scene-missing', path: 'sceneId', message: `Scene ${analysis.sceneId} does not exist.` }], unacceptedLosses: [] }
  const resources = new Map(snapshot.project.resources.map((resource) => [resource.id, resource]))
  const assets: WorldsSceneManifestAssetV1[] = []
  const surfaces: WorldCollisionSurface[] = []
  const projectedIds = projectLegacyIds(scene)
  for (const [entityIndex, entity] of scene.entities.entries()) {
    const renderable = entity.components.find((component): component is WorldRenderableComponent => component.type === 'renderable')
    if (renderable) {
      const resource = resources.get(renderable.resourceId)
      if (resource?.type === 'model') {
        const assetId = projectedIds.assetIdsByEntityIndex.get(entityIndex)
        if (!assetId) continue
        assets.push(exportLegacyAsset(assetId, entity, renderable, resource, resources))
      }
    }
    const navigationColliders = entity.components.filter((component): component is WorldColliderComponent => component.type === 'collider' && component.purpose === 'editor-navigation' && (component.shape === 'rect-surface' || component.shape === 'tri-surface'))
    for (const component of navigationColliders) {
      if (!entity.enabled || !component.enabled || entity.transform.scale.some((value) => value <= 0)) continue
      if (component.shape === 'tri-surface' && Math.abs(legacySignedTriangleAreaTwice(component.vertices)) <= LEGACY_MIN_TRIANGLE_AREA_TWICE) continue
      const surfaceId = projectedIds.surfaceIdsByComponentId.get(component.id)
      if (!surfaceId) continue
      const surface = exportLegacySurface(surfaceId, entity, component)
      if (surface) surfaces.push(surface)
    }
  }
  let createdAt: string
  try {
    createdAt = (options.now ?? new Date()).toISOString()
  } catch {
    return { success: false, issues: [{ code: 'legacy-export-date', path: 'now', message: 'Legacy export date must be valid.' }], unacceptedLosses: [] }
  }
  let collisionSurfaces: ReturnType<typeof buildWorldsCollisionSurfaceManifest> | undefined
  try {
    collisionSurfaces = surfaces.length ? buildWorldsCollisionSurfaceManifest(surfaces) : undefined
  } catch (error) {
    return { success: false, issues: [{ code: 'legacy-export-surface', path: 'manifest.collisionSurfaces', message: error instanceof Error ? error.message : 'Legacy collision surfaces are invalid.' }], unacceptedLosses: [] }
  }
  const manifest: WorldsSceneManifestV1 = {
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    generator: 'modly.worlds',
    version: 1,
    createdAt,
    ...(scene.editor?.initialView ? { initialView: structuredClone(scene.editor.initialView) } : {}),
    assets,
    ...(collisionSurfaces ? { collisionSurfaces } : {}),
  }
  const reparsed = parseWorldsSceneManifest(manifest)
  if (!reparsed.success) {
    return { success: false, issues: [{ code: 'legacy-export-validation', path: 'manifest', message: reparsed.error }], unacceptedLosses: [] }
  }
  const selfImported = importLegacyWorldsSceneManifest(reparsed.manifest)
  if (!selfImported.success) {
    return { success: false, issues: [{ code: 'legacy-export-self-import', path: 'manifest', message: 'Legacy export could not be imported back into the canonical Worlds model.' }, ...selfImported.issues], unacceptedLosses: [] }
  }
  return { success: true, manifest: reparsed.manifest, losses: analysis.losses }
}

function addLegacyPoseClip(binding: WorldSceneItemAnimationBinding, entity: WorldEntity, resources: WorldResource[], usedIds: Set<string>): void {
  const resourceId = allocateId(`resource:animation:${entity.id}`, usedIds)
  const componentId = allocateId(`component:animation:${entity.id}`, usedIds)
  const resource: WorldAnimationResource = {
    id: resourceId,
    type: 'animation',
    name: binding.clipName ?? binding.clipId ?? `${entity.name} animation`,
    workspacePath: binding.sidecarWorkspacePath,
    format: 'pose-clip',
    sourceWorkspacePath: binding.sourceWorkspacePath,
    ...(binding.legacySidecarWorkspacePath ? { legacyWorkspacePath: binding.legacySidecarWorkspacePath } : {}),
    ...(binding.clipId ? { clipId: binding.clipId } : {}),
    ...(binding.clipName ? { clipName: binding.clipName } : {}),
    ...(binding.durationSeconds ? { durationSeconds: binding.durationSeconds } : {}),
  }
  resources.push(resource)
  entity.components.push({ id: componentId, type: 'animation-player', enabled: true, resourceId, autoplay: false, loop: true, speed: 1 })
}

function exportLegacyAsset(id: string, entity: WorldEntity, renderable: WorldRenderableComponent, resource: WorldModelResource, resources: Map<string, WorldResource>): WorldsSceneManifestAssetV1 {
  const animationPlayer = entity.components.find((component) => component.type === 'animation-player')
  let animation: WorldSceneItemAnimationBinding | undefined
  if (animationPlayer?.type === 'animation-player') {
    const animationResource = resources.get(animationPlayer.resourceId)
    if (animationResource?.type === 'animation' && animationResource.format === 'pose-clip' && animationResource.sourceWorkspacePath) {
      animation = {
        kind: 'pose-clip',
        sidecarWorkspacePath: animationResource.workspacePath,
        sourceWorkspacePath: animationResource.sourceWorkspacePath,
        ...(animationResource.legacyWorkspacePath ? { legacySidecarWorkspacePath: animationResource.legacyWorkspacePath } : {}),
        ...(animationResource.clipId ? { clipId: animationResource.clipId } : {}),
        ...(animationResource.clipName ? { clipName: animationResource.clipName } : {}),
        ...(animationResource.durationSeconds ? { durationSeconds: animationResource.durationSeconds } : {}),
      }
    }
  }
  return {
    id,
    name: entity.name,
    role: entity.tags.includes('modly:base-scene') ? 'base-scene' : 'asset',
    workspacePath: resource.workspacePath,
    kind: resource.format,
    visible: entity.enabled && renderable.enabled && renderable.visible,
    ...(animation ? { animation } : {}),
    transform: structuredClone(entity.transform),
  }
}

function exportLegacySurface(id: string, entity: WorldEntity, collider: WorldColliderComponent): WorldCollisionSurface | null {
  if (collider.shape !== 'rect-surface' && collider.shape !== 'tri-surface') return null
  const common = {
    id,
    label: entity.name,
    ...(collider.legacyPreset ? { preset: collider.legacyPreset } : {}),
    sidedness: collider.sidedness,
    transform: structuredClone(entity.transform),
  }
  if (collider.shape === 'rect-surface') return { ...common, shape: 'rect', geometry: { halfWidth: collider.halfExtents[0], halfHeight: collider.halfExtents[1] } }
  if (collider.shape === 'tri-surface') return { ...common, shape: 'tri', geometry: { vertices: structuredClone(collider.vertices) } }
  return null
}

function collectDuplicateIdWarnings(value: unknown, normalized: WorldsSceneManifestV1): LegacyWorldsAdapterWarning[] {
  if (!isRecord(value) || !Array.isArray(value.assets)) return []
  const seen = new Set<string>()
  const warnings: LegacyWorldsAdapterWarning[] = []
  for (const [index, asset] of value.assets.entries()) {
    if (!isRecord(asset) || typeof asset.id !== 'string' || !asset.id.trim()) continue
    const requested = asset.id.trim()
    if (seen.has(requested)) warnings.push({ code: 'duplicate-id-normalized', path: `manifest.assets[${index}].id`, message: `Duplicate id ${requested} was normalized to ${normalized.assets[index]?.id ?? requested}.` })
    seen.add(requested)
  }
  const normalizedAssetIds = new Set(normalized.assets.flatMap((asset) => asset.id ? [asset.id] : []))
  const collisionSurfaces = normalized.collisionSurfaces?.surfaces ?? []
  for (const [index, surface] of collisionSurfaces.entries()) {
    if (normalizedAssetIds.has(surface.id)) {
      warnings.push({
        code: 'cross-domain-id-normalized',
        path: `manifest.collisionSurfaces.surfaces[${index}].id`,
        message: `Collision surface id ${surface.id} overlaps an asset id and was remapped to a distinct canonical entity id.`,
      })
    }
  }
  return warnings
}

function isLegacyDefaultEnvironment(scene: WorldSceneDocumentV1): boolean {
  return scene.environment.backgroundColor.toLowerCase() === LEGACY_DEFAULT_ENVIRONMENT.backgroundColor
    && scene.environment.ambientIntensity === LEGACY_DEFAULT_ENVIRONMENT.ambientIntensity
    && scene.environment.environmentResourceId === undefined
    && scene.environment.fog === undefined
}

function addLoss(losses: LegacyWorldsExportLoss[], lossIds: Set<string>, code: LegacyWorldsLossCode, path: string, message: string): void {
  const id = `${code}:${path}`
  if (lossIds.has(id)) return
  lossIds.add(id)
  losses.push({ id, code, path, message })
}

function projectLegacyIds(scene: WorldSceneDocumentV1): {
  assetIdsByEntityIndex: Map<number, string>
  surfaceIdsByComponentId: Map<string, string>
} {
  const usedIds = new Set<string>()
  const assetIdsByEntityIndex = new Map<number, string>()
  const surfaceIdsByComponentId = new Map<string, string>()
  for (const [entityIndex, entity] of scene.entities.entries()) {
    if (entity.components.some((component) => component.type === 'renderable')) {
      assetIdsByEntityIndex.set(entityIndex, allocateLegacyId(nonEmptyLegacyId(stripEntityPrefix(entity.id), `asset-${entityIndex + 1}`), usedIds))
    }
  }
  for (const [entityIndex, entity] of scene.entities.entries()) {
    const colliders = entity.components.filter((component): component is WorldColliderComponent => component.type === 'collider'
      && component.purpose === 'editor-navigation'
      && (component.shape === 'rect-surface' || component.shape === 'tri-surface'))
    for (const [colliderIndex, collider] of colliders.entries()) {
      if (!entity.enabled || !collider.enabled || entity.transform.scale.some((value) => value <= 0)) continue
      if (collider.shape === 'tri-surface' && Math.abs(legacySignedTriangleAreaTwice(collider.vertices)) <= LEGACY_MIN_TRIANGLE_AREA_TWICE) continue
      const entityBase = nonEmptyLegacyId(stripEntityPrefix(entity.id), `surface-${entityIndex + 1}`)
      const componentBase = nonEmptyLegacyId(stripComponentPrefix(collider.id), `collider-${colliderIndex + 1}`)
      const requestedId = colliders.length === 1 ? entityBase : `${entityBase}:${componentBase}`
      surfaceIdsByComponentId.set(collider.id, allocateLegacyId(requestedId, usedIds))
    }
  }
  return { assetIdsByEntityIndex, surfaceIdsByComponentId }
}

function allocateId(base: string, usedIds: Set<string>): string {
  return allocateBoundedId(base, usedIds, WORLD_ID_MAX_LENGTH)
}

function allocateLegacyId(base: string, usedIds: Set<string>): string {
  return allocateBoundedId(base, usedIds, LEGACY_GENERATED_ID_MAX_LENGTH)
}

function allocateBoundedId(base: string, usedIds: Set<string>, maximumLength: number): string {
  const canonicalBase = base.trim().replaceAll('\0', '') || 'generated'
  let ordinal = 1
  while (true) {
    const suffix = ordinal === 1 ? '' : `#${ordinal}`
    const candidate = shortenIdWithSuffix(canonicalBase, suffix, maximumLength)
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate)
      return candidate
    }
    ordinal += 1
  }
}

function shortenIdWithSuffix(base: string, suffix: string, maximumLength: number): string {
  const direct = `${base}${suffix}`
  if (direct.length <= maximumLength && (maximumLength !== WORLD_ID_MAX_LENGTH || isWorldCanonicalId(direct))) return direct
  const digest = `~${fnv1a32(base)}`
  const prefixLength = Math.max(1, maximumLength - digest.length - suffix.length)
  return `${base.slice(0, prefixLength)}${digest}${suffix}`
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function stripEntityPrefix(id: string): string {
  return id.startsWith('entity:') ? id.slice('entity:'.length) : id
}

function stripComponentPrefix(id: string): string {
  return id.startsWith('component:') ? id.slice('component:'.length) : id
}

function nonEmptyLegacyId(value: string, fallback: string): string {
  return value.trim() || fallback
}

function legacySignedTriangleAreaTwice(vertices: readonly [readonly [number, number], readonly [number, number], readonly [number, number]]): number {
  const [a, b, c] = vertices
  return ((b[1] - a[1]) * (c[0] - a[0])) - ((b[0] - a[0]) * (c[1] - a[1]))
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isSafeWorldWireRecord(value)
}

function compareWarning(left: LegacyWorldsAdapterWarning, right: LegacyWorldsAdapterWarning): number {
  return left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
}

function compareLoss(left: LegacyWorldsExportLoss, right: LegacyWorldsExportLoss): number {
  return left.id.localeCompare(right.id)
}
