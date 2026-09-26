import { Euler, Matrix4, Quaternion, Vector3 } from 'three'

import type {
  WorldCameraComponent,
  WorldColliderComponent,
  WorldLightComponent,
  WorldRenderableComponent,
} from '../core/worldComponentRegistry.ts'
import { validateWorldProjectSnapshot } from '../core/worldDocuments.ts'
import type {
  WorldProjectSnapshotV1,
  WorldSceneEnvironment,
  WorldSceneInitialView,
  WorldTransform,
} from '../core/worldModel.ts'

export type WorkspaceAssetUrlResolver = (workspacePath: string) => string

export interface WorldProjectedHierarchyEntity {
  id: string
  name: string
  parentId: string | null
  childIds: string[]
  effectiveEnabled: boolean
  effectiveLocked: boolean
}

export interface WorldProjectedEntity extends WorldProjectedHierarchyEntity {
  tags: string[]
  localTransform: WorldTransform
  worldTransform: WorldTransform
}

export interface WorldProjectedViewerItem {
  id: string
  entityId: string
  componentId: string
  workspacePath: string
  url: string
  kind: 'glb' | 'gltf' | 'ply-mesh' | 'ply-points' | 'gaussian-ply'
  role: 'asset' | 'base-scene'
  visible: boolean
  transform: WorldTransform
  material: WorldRenderableComponent['material']
  castShadow: boolean
  receiveShadow: boolean
  animation?: {
    kind: 'pose-clip'
    sidecarWorkspacePath: string
    legacySidecarWorkspacePath?: string
    sourceWorkspacePath: string
    clipId?: string
    clipName?: string
    durationSeconds?: number
  }
}

export interface WorldProjectedCamera {
  entityId: string
  component: WorldCameraComponent
  worldTransform: WorldTransform
  effectiveEnabled: boolean
}

export interface WorldProjectedLight {
  entityId: string
  component: WorldLightComponent
  worldTransform: WorldTransform
  effectiveEnabled: boolean
}

export interface WorldProjectedNavigationSurface {
  entityId: string
  componentId: string
  effectiveEnabled: boolean
  worldTransform: WorldTransform
  surface: Extract<WorldColliderComponent, { shape: 'rect-surface' | 'tri-surface' }>
}

export interface WorldProjectedEnvironment extends WorldSceneEnvironment {
  environmentResourceUrl?: string
}

export interface WorldSceneProjection {
  sceneId: string
  hierarchy: { roots: WorldProjectedHierarchyEntity[] }
  entities: WorldProjectedEntity[]
  viewerItems: WorldProjectedViewerItem[]
  cameras: WorldProjectedCamera[]
  lights: WorldProjectedLight[]
  environment: WorldProjectedEnvironment
  editorNavigationSurfaces: WorldProjectedNavigationSurface[]
  initialView: WorldSceneInitialView | null
  warnings: string[]
}

export type ProjectWorldSceneResult =
  | { success: true; value: WorldSceneProjection }
  | { success: false; issues: { code: string; path: string; message: string }[] }

export function projectWorldScene(
  snapshotValue: WorldProjectSnapshotV1,
  sceneId: string,
  workspaceAssetUrlResolver: WorkspaceAssetUrlResolver,
): ProjectWorldSceneResult {
  const parsed = validateWorldProjectSnapshot(snapshotValue)
  if (!parsed.success) return { success: false, issues: parsed.issues.map((issue) => ({ ...issue })) }
  const snapshot = parsed.value
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  if (!scene) return { success: false, issues: [{ code: 'scene-missing', path: 'sceneId', message: `Scene ${sceneId} does not exist.` }] }
  const entityById = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const childrenByParent = new Map<string | null, string[]>()
  for (const entity of scene.entities) {
    const children = childrenByParent.get(entity.parentId) ?? []
    children.push(entity.id)
    childrenByParent.set(entity.parentId, children)
  }
  const worldMatrices = new Map<string, Matrix4>()
  const effectiveStates = new Map<string, { enabled: boolean; locked: boolean }>()
  const resolving = new Set<string>()
  const resolveEntity = (entityId: string): { matrix: Matrix4; enabled: boolean; locked: boolean } => {
    const cachedMatrix = worldMatrices.get(entityId)
    const cachedState = effectiveStates.get(entityId)
    if (cachedMatrix && cachedState) return { matrix: cachedMatrix, ...cachedState }
    const entity = entityById.get(entityId)
    if (!entity || resolving.has(entityId)) return { matrix: new Matrix4(), enabled: false, locked: true }
    resolving.add(entityId)
    const localMatrix = composeTransform(entity.transform)
    const parent = entity.parentId ? resolveEntity(entity.parentId) : null
    const matrix = parent ? parent.matrix.clone().multiply(localMatrix) : localMatrix
    const state = {
      enabled: entity.enabled && (parent?.enabled ?? true),
      locked: entity.locked || (parent?.locked ?? false),
    }
    resolving.delete(entityId)
    worldMatrices.set(entityId, matrix)
    effectiveStates.set(entityId, state)
    return { matrix, ...state }
  }

  const projectedEntities: WorldProjectedEntity[] = scene.entities.map((entity) => {
    const resolved = resolveEntity(entity.id)
    return {
      id: entity.id,
      name: entity.name,
      parentId: entity.parentId,
      childIds: [...(childrenByParent.get(entity.id) ?? [])],
      effectiveEnabled: resolved.enabled,
      effectiveLocked: resolved.locked,
      tags: [...entity.tags],
      localTransform: cloneTransform(entity.transform),
      worldTransform: decomposeTransform(resolved.matrix),
    }
  })
  const projectedById = new Map(projectedEntities.map((entity) => [entity.id, entity]))
  const warnings = new Set<string>()
  const resources = new Map(snapshot.project.resources.map((resource) => [resource.id, resource]))
  const resolveUrl = (resourceId: string, workspacePath: string): string | null => {
    try {
      const url = workspaceAssetUrlResolver(workspacePath)
      if (typeof url !== 'string' || !url.trim() || url.includes('\0')) throw new Error('invalid')
      return url.trim()
    } catch {
      warnings.add(`resource:${resourceId}:unavailable`)
      return null
    }
  }

  const viewerItems: WorldProjectedViewerItem[] = []
  const cameras: WorldProjectedCamera[] = []
  const lights: WorldProjectedLight[] = []
  const editorNavigationSurfaces: WorldProjectedNavigationSurface[] = []
  for (const entity of scene.entities) {
    const projectedEntity = projectedById.get(entity.id)
    if (!projectedEntity) continue
    for (const component of entity.components) {
      if (component.type === 'renderable') {
        const resource = resources.get(component.resourceId)
        if (!resource || resource.type !== 'model') {
          warnings.add(`resource:${component.resourceId}:missing-model`)
          continue
        }
        const url = resolveUrl(resource.id, resource.workspacePath)
        if (!url) continue
        const animationPlayer = entity.components.find((candidate) => candidate.type === 'animation-player')
        const animationResource = animationPlayer?.type === 'animation-player' ? resources.get(animationPlayer.resourceId) : undefined
        const animation = animationResource?.type === 'animation' && animationResource.format === 'pose-clip'
          ? {
              kind: 'pose-clip' as const,
              sidecarWorkspacePath: animationResource.workspacePath,
              ...(animationResource.legacyWorkspacePath ? { legacySidecarWorkspacePath: animationResource.legacyWorkspacePath } : {}),
              sourceWorkspacePath: animationResource.sourceWorkspacePath ?? resource.workspacePath,
              ...(animationResource.clipId ? { clipId: animationResource.clipId } : {}),
              ...(animationResource.clipName ? { clipName: animationResource.clipName } : {}),
              ...(animationResource.durationSeconds ? { durationSeconds: animationResource.durationSeconds } : {}),
            }
          : undefined
        viewerItems.push({
          id: entity.id,
          entityId: entity.id,
          componentId: component.id,
          workspacePath: resource.workspacePath,
          url,
          kind: resource.format,
          role: entity.tags.includes('modly:base-scene') ? 'base-scene' : 'asset',
          visible: projectedEntity.effectiveEnabled && component.enabled && component.visible,
          transform: cloneTransform(projectedEntity.worldTransform),
          material: structuredClone(component.material),
          castShadow: component.castShadow,
          receiveShadow: component.receiveShadow,
          ...(animation ? { animation } : {}),
        })
      } else if (component.type === 'camera') {
        cameras.push({
          entityId: entity.id,
          component: structuredClone(component),
          worldTransform: cloneTransform(projectedEntity.worldTransform),
          effectiveEnabled: projectedEntity.effectiveEnabled && component.enabled,
        })
      } else if (component.type === 'light') {
        lights.push({
          entityId: entity.id,
          component: structuredClone(component),
          worldTransform: cloneTransform(projectedEntity.worldTransform),
          effectiveEnabled: projectedEntity.effectiveEnabled && component.enabled,
        })
      } else if (component.type === 'collider'
        && component.purpose === 'editor-navigation'
        && (component.shape === 'rect-surface' || component.shape === 'tri-surface')) {
        editorNavigationSurfaces.push({
          entityId: entity.id,
          componentId: component.id,
          effectiveEnabled: projectedEntity.effectiveEnabled && component.enabled,
          worldTransform: cloneTransform(projectedEntity.worldTransform),
          surface: structuredClone(component),
        })
      }
    }
  }

  const environment: WorldProjectedEnvironment = structuredClone(scene.environment)
  if (scene.environment.environmentResourceId) {
    const resource = resources.get(scene.environment.environmentResourceId)
    if (!resource || resource.type !== 'environment') warnings.add(`resource:${scene.environment.environmentResourceId}:missing-environment`)
    else {
      const url = resolveUrl(resource.id, resource.workspacePath)
      if (url) environment.environmentResourceUrl = url
    }
  }
  const roots = projectedEntities
    .filter((entity) => entity.parentId === null)
    .map((entity) => toHierarchyEntity(entity))
  const result: WorldSceneProjection = {
    sceneId,
    hierarchy: { roots },
    entities: projectedEntities,
    viewerItems,
    cameras,
    lights,
    environment,
    editorNavigationSurfaces,
    initialView: scene.editor?.initialView ? structuredClone(scene.editor.initialView) : null,
    warnings: [...warnings].sort(codeUnitCompare),
  }
  return { success: true, value: deepFreezeData(result) }
}

function toHierarchyEntity(entity: WorldProjectedEntity): WorldProjectedHierarchyEntity {
  return {
    id: entity.id,
    name: entity.name,
    parentId: entity.parentId,
    childIds: [...entity.childIds],
    effectiveEnabled: entity.effectiveEnabled,
    effectiveLocked: entity.effectiveLocked,
  }
}

function composeTransform(transform: WorldTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation, 'XYZ')),
    new Vector3(...transform.scale),
  )
}

function decomposeTransform(matrix: Matrix4): WorldTransform {
  const position = new Vector3()
  const rotation = new Quaternion()
  const scale = new Vector3()
  matrix.decompose(position, rotation, scale)
  const euler = new Euler().setFromQuaternion(rotation, 'XYZ')
  return {
    position: [normalizeZero(position.x), normalizeZero(position.y), normalizeZero(position.z)],
    rotation: [normalizeZero(euler.x), normalizeZero(euler.y), normalizeZero(euler.z)],
    scale: [normalizeZero(scale.x), normalizeZero(scale.y), normalizeZero(scale.z)],
  }
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) || Math.abs(value) < 1e-15 ? 0 : value
}

function cloneTransform(transform: WorldTransform): WorldTransform {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
}

function deepFreezeData<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreezeData(descriptor.value)
  }
  Object.freeze(value)
  return value
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
