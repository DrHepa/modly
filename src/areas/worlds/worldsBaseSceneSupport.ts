import * as THREE from 'three'

import type { WorldSceneItem } from './worldRenderableResolver.ts'
import type { WorldsCollisionBounds } from './worldsCollisionMath.ts'
import { raycastWorldsBaseScenePlacementSurface } from './worldsBaseSceneRaycast.ts'
import { resolveWorldsPlacementSurfaceSupport } from './worldsBaseScenePlacementSurface.ts'
import type {
  WorldsSurfacePlacementItemDescriptor,
  WorldsSurfacePlacementItemTransformUpdate,
} from './worldsSurfacePlacement.ts'

export const WORLDS_BASE_SCENE_RAYCAST_MARGIN = 2
export const WORLDS_INITIAL_BASE_SUPPORT_MAX_CORRECTION = 100
export const WORLDS_DRAG_BASE_SUPPORT_MAX_CORRECTION = 0.2

export interface ResolveWorldsBaseSceneSupportPlacementInput {
  anchorItemId: string
  items: readonly WorldsSurfacePlacementItemDescriptor[]
  desiredTransforms: readonly WorldsSurfacePlacementItemTransformUpdate[]
  sceneItems: readonly WorldSceneItem[]
  sceneObjects: ReadonlyMap<string, THREE.Object3D>
  ignoredItemIds?: readonly string[]
  maxCorrection: number
}

export type WorldsBaseSceneSupportPlacementResult =
  | {
    status: 'applied'
    updates: WorldsSurfacePlacementItemTransformUpdate[]
    correctionDelta: [number, number, number]
    sourceId: string
  }
  | {
    status: 'wait' | 'no-base' | 'no-hit' | 'unsupported'
    updates: null
    correctionDelta: null
    sourceId: null
  }

export interface ResolveWorldsPendingSurfacePlacementDecisionInput {
  pendingItemId: string
  sceneItems: readonly WorldSceneItem[]
  sceneObjects: ReadonlyMap<string, THREE.Object3D>
  localBoundsByItemId: ReadonlyMap<string, WorldsCollisionBounds | null | undefined>
  selectedItemIds?: readonly string[]
}

export type WorldsPendingSurfacePlacementDecision =
  | { status: 'wait'; transform: null; reason: 'wait' }
  | { status: 'clear'; transform: null; reason: 'missing-item' | 'no-base' | 'no-hit' | 'unsupported' }
  | { status: 'commit'; transform: WorldSceneItem['transform']; reason: 'applied' }

export function resolveWorldsPendingSurfacePlacementDecision({
  pendingItemId,
  sceneItems,
  sceneObjects,
  localBoundsByItemId,
  selectedItemIds = [],
}: ResolveWorldsPendingSurfacePlacementDecisionInput): WorldsPendingSurfacePlacementDecision {
  const pendingItem = sceneItems.find((item) => item.id === pendingItemId)
  if (!pendingItem) return { status: 'clear', transform: null, reason: 'missing-item' }

  if (!sceneObjects.has(pendingItemId)) return { status: 'wait', transform: null, reason: 'wait' }
  const localBounds = localBoundsByItemId.get(pendingItemId) ?? null
  if (!localBounds) return { status: 'wait', transform: null, reason: 'wait' }
  const result = resolveWorldsBaseSceneSupportPlacement({
    anchorItemId: pendingItemId,
    items: [{
      id: pendingItemId,
      localBounds,
      startTransform: cloneWorldSceneTransform(pendingItem.transform),
    }],
    desiredTransforms: [{
      id: pendingItemId,
      transform: cloneWorldSceneTransform(pendingItem.transform),
    }],
    sceneItems,
    sceneObjects,
    ignoredItemIds: [pendingItemId, ...selectedItemIds],
    maxCorrection: WORLDS_INITIAL_BASE_SUPPORT_MAX_CORRECTION,
  })

  if (result.status === 'wait') return { status: 'wait', transform: null, reason: 'wait' }
  if (result.status !== 'applied') return { status: 'clear', transform: null, reason: result.status }
  return {
    status: 'commit',
    transform: cloneWorldSceneTransform(result.updates[0]!.transform),
    reason: 'applied',
  }
}

export function resolveWorldsBaseSceneSupportPlacement({
  anchorItemId,
  items,
  desiredTransforms,
  sceneItems,
  sceneObjects,
  ignoredItemIds = [],
  maxCorrection,
}: ResolveWorldsBaseSceneSupportPlacementInput): WorldsBaseSceneSupportPlacementResult {
  const desiredById = new Map(desiredTransforms.map((entry) => [entry.id, entry.transform]))
  const anchorItem = items.find((item) => item.id === anchorItemId)
  const anchorTransform = desiredById.get(anchorItemId)
  if (!anchorItem?.localBounds || !anchorTransform) {
    return { status: 'unsupported', updates: null, correctionDelta: null, sourceId: null }
  }

  const ignored = new Set(ignoredItemIds.filter((itemId) => typeof itemId === 'string' && itemId.length > 0))
  const candidateBaseItems = sceneItems.filter((item) => item.visible && item.role === 'base-scene' && !ignored.has(item.id))
  if (candidateBaseItems.length === 0) {
    return { status: 'no-base', updates: null, correctionDelta: null, sourceId: null }
  }

  const roots: Array<{ sourceId: string; root: THREE.Object3D }> = []
  const combinedBounds = new THREE.Box3()
  let hasCombinedBounds = false

  for (const item of candidateBaseItems) {
    const root = sceneObjects.get(item.id)
    if (!root) {
      return { status: 'wait', updates: null, correctionDelta: null, sourceId: null }
    }
    const bounds = measureWorldsBaseSceneMeshBounds(root)
    if (!bounds && root.children.length === 0) {
      return { status: 'wait', updates: null, correctionDelta: null, sourceId: null }
    }
    if (!bounds) continue
    roots.push({ sourceId: item.id, root })
    if (!hasCombinedBounds) {
      combinedBounds.copy(bounds)
      hasCombinedBounds = true
    } else {
      combinedBounds.union(bounds)
    }
  }

  if (!hasCombinedBounds || roots.length === 0) {
    return { status: 'no-base', updates: null, correctionDelta: null, sourceId: null }
  }

  const anchor = resolveWorldsPlacementAnchor(anchorItem.localBounds, anchorTransform)
  const originY = combinedBounds.max.y + WORLDS_BASE_SCENE_RAYCAST_MARGIN
  const hit = raycastWorldsBaseScenePlacementSurface({
    ray: {
      origin: [anchor[0], originY, anchor[2]],
      direction: [0, -1, 0],
      maxDistance: Math.max(originY - combinedBounds.min.y + WORLDS_BASE_SCENE_RAYCAST_MARGIN, WORLDS_BASE_SCENE_RAYCAST_MARGIN),
    },
    roots,
    ignoredItemIds,
  })
  if (!hit) {
    return { status: 'no-hit', updates: null, correctionDelta: null, sourceId: null }
  }

  const support = resolveWorldsPlacementSurfaceSupport({
    placementHit: hit,
    items,
    desiredTransforms,
    options: { maxCorrection },
  })
  if (!support.valid) {
    return { status: 'unsupported', updates: null, correctionDelta: null, sourceId: null }
  }

  return {
    status: 'applied',
    updates: support.resolvedTransforms.map((entry) => ({
      itemId: entry.id,
      transform: cloneWorldSceneTransform(entry.transform),
    })),
    correctionDelta: [...support.correctionDelta],
    sourceId: hit.sourceId,
  }
}

export function resolveWorldsPlacementAnchor(
  localBounds: WorldsCollisionBounds,
  transform: WorldSceneItem['transform'],
): [number, number, number] {
  const center = new THREE.Vector3(
    (localBounds.min.x + localBounds.max.x) * 0.5,
    (localBounds.min.y + localBounds.max.y) * 0.5,
    (localBounds.min.z + localBounds.max.z) * 0.5,
  )
  center.multiply(new THREE.Vector3(transform.scale[0], transform.scale[1], transform.scale[2]))
  center.applyEuler(new THREE.Euler(transform.rotation[0], transform.rotation[1], transform.rotation[2], 'XYZ'))
  center.add(new THREE.Vector3(transform.position[0], transform.position[1], transform.position[2]))
  return [normalizeSignedZero(center.x), normalizeSignedZero(center.y), normalizeSignedZero(center.z)]
}

function measureWorldsBaseSceneMeshBounds(root: THREE.Object3D): THREE.Box3 | null {
  root.updateWorldMatrix(true, true)
  const bounds = new THREE.Box3()
  const childBounds = new THREE.Box3()
  let hasBounds = false

  root.traverse((object) => {
    if (!isMeshLike(object)) return
    if (!isObjectVisibleInHierarchy(object, root)) return
    if (object.userData.worldsSelectionHitbox === true) return
    if (object.userData.worldsSelectionSilhouette === true) return
    if (object.userData.worldsCollisionSurface === true) return
    if (!isBufferGeometryLike(object.geometry)) return
    if (!object.geometry.getAttribute('position')) return
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox()
    if (!object.geometry.boundingBox) return
    childBounds.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld)
    if (!hasBounds) {
      bounds.copy(childBounds)
      hasBounds = true
      return
    }
    bounds.union(childBounds)
  })

  return hasBounds ? bounds : null
}

function isObjectVisibleInHierarchy(object: THREE.Object3D, stopRoot: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object
  while (current) {
    if (current.visible === false) return false
    if (current === stopRoot) break
    current = current.parent
  }
  return true
}

function isMeshLike(object: THREE.Object3D): object is THREE.Object3D & { geometry: THREE.BufferGeometry; isMesh: true } {
  return (object as { isMesh?: unknown }).isMesh === true && 'geometry' in object
}

function isBufferGeometryLike(geometry: unknown): geometry is THREE.BufferGeometry {
  return !!geometry
    && typeof geometry === 'object'
    && typeof (geometry as { getAttribute?: unknown }).getAttribute === 'function'
    && typeof (geometry as { computeBoundingBox?: unknown }).computeBoundingBox === 'function'
}

function cloneWorldSceneTransform(transform: WorldSceneItem['transform']): WorldSceneItem['transform'] {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
}

function normalizeSignedZero(value: number): number {
  return Math.abs(value) <= 1e-12 ? 0 : value
}
