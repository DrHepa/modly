import * as THREE from 'three'

import {
  deriveWorldsPlacementSurfaceTangents,
  type WorldsPlacementSurfaceHit,
  type WorldsPlacementSurfacePolygon,
} from './worldsBaseScenePlacementSurface.ts'

export interface WorldsBaseScenePlacementRay {
  origin: [number, number, number]
  direction: [number, number, number]
  maxDistance?: number
}

export interface WorldsBaseScenePlacementRoot {
  sourceId: string
  root: THREE.Object3D | null | undefined
}

export type WorldsBaseSceneRaycastVisibilityPolicy = 'visible-only' | 'include-hidden-meshes'

export interface RaycastWorldsBaseScenePlacementSurfaceInput {
  ray: WorldsBaseScenePlacementRay
  roots: readonly WorldsBaseScenePlacementRoot[]
  ignoredItemIds?: readonly string[]
  visibilityPolicy?: WorldsBaseSceneRaycastVisibilityPolicy
}

interface BaseSceneHitCandidate {
  sourceId: string
  distance: number
  point: [number, number, number]
  normal: [number, number, number]
  polygon: WorldsPlacementSurfacePolygon
  tangentU: [number, number, number] | null
  tangentV: [number, number, number] | null
}

type Vector3Like = Pick<THREE.Vector3, 'x' | 'y' | 'z'>

const EPSILON = 1e-8

export function raycastWorldsBaseScenePlacementSurface({
  ray,
  roots,
  ignoredItemIds = [],
  visibilityPolicy = 'visible-only',
}: RaycastWorldsBaseScenePlacementSurfaceInput): WorldsPlacementSurfaceHit | null {
  const origin = tupleToVector3(ray.origin)
  const direction = tupleToVector3(ray.direction)
  if (!origin || !direction) return null

  const normalizedDirection = direction.normalize()
  const maxDistance = Number.isFinite(ray.maxDistance) && ray.maxDistance! > 0 ? ray.maxDistance! : Number.POSITIVE_INFINITY
  const raycaster = new THREE.Raycaster(origin, normalizedDirection, 0, maxDistance)
  const ignored = new Set(ignoredItemIds.filter((itemId) => typeof itemId === 'string' && itemId.length > 0))
  let best: BaseSceneHitCandidate | null = null

  for (const entry of roots) {
    if (!entry?.root) continue
    if (typeof entry.sourceId !== 'string' || entry.sourceId.length === 0) continue
    if (ignored.has(entry.sourceId)) continue
    if (entry.root.visible === false) continue

    entry.root.updateWorldMatrix(true, true)
    entry.root.traverse((object) => {
      if (!isMeshLike(object)) return
      if (visibilityPolicy === 'visible-only' && !isObjectVisibleInHierarchy(object, entry.root)) return
      if (object.userData.worldsSelectionHitbox === true) return
      if (object.userData.worldsSelectionSilhouette === true) return
      if (object.userData.worldsCollisionSurface === true) return
      if (!isBufferGeometryLike(object.geometry)) return
      if (!object.geometry.getAttribute('position')) return

      const intersections = raycaster.intersectObject(object, false)
      for (const intersection of intersections) {
        const candidate = buildHitCandidate(entry.sourceId, object, intersection, normalizedDirection)
        if (!candidate) continue
        if (
          !best
          || candidate.distance < best.distance - EPSILON
          || (Math.abs(candidate.distance - best.distance) <= EPSILON && candidate.sourceId < best.sourceId)
        ) {
          best = candidate
        }
      }
    })
  }

  if (!best) return null
  return {
    source: 'base-scene',
    sourceId: best.sourceId,
    point: best.point,
    normal: best.normal,
    distance: best.distance,
    polygon: best.polygon,
    ...(best.tangentU ? { tangentU: best.tangentU } : {}),
    ...(best.tangentV ? { tangentV: best.tangentV } : {}),
  }
}

function buildHitCandidate(
  sourceId: string,
  mesh: THREE.Mesh,
  intersection: THREE.Intersection<THREE.Object3D>,
  rayDirection: THREE.Vector3,
): BaseSceneHitCandidate | null {
  if (!Number.isFinite(intersection.distance) || intersection.distance < 0) return null
  if (!isBufferGeometryLike(mesh.geometry)) return null
  if (!isVector3Like(intersection.point)) return null
  const polygon = extractTriangleWorldPolygon(mesh.geometry, mesh.matrixWorld, intersection)
  if (!polygon) return null

  const worldNormal = resolveWorldNormal(mesh, intersection.face?.normal ?? null, polygon, rayDirection)
  if (!worldNormal) return null

  const tangents = deriveWorldsPlacementSurfaceTangents({ polygon, normal: vector3ToTuple(worldNormal) })
  return {
    sourceId,
    distance: intersection.distance,
    point: vector3ToTuple(intersection.point),
    normal: vector3ToTuple(worldNormal),
    polygon,
    tangentU: tangents.tangentU,
    tangentV: tangents.tangentV,
  }
}

function extractTriangleWorldPolygon(
  geometry: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4,
  intersection: THREE.Intersection<THREE.Object3D>,
): WorldsPlacementSurfacePolygon | null {
  const indices = resolveTriangleVertexIndices(geometry, intersection)
  if (!indices) return null
  const position = geometry.getAttribute('position')
  if (!isBufferAttributeLike(position)) return null

  const vertices: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  for (let index = 0; index < indices.length; index += 1) {
    const vertexIndex = indices[index]!
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= position.count) return null
    vertices[index]!.fromBufferAttribute(position, vertexIndex).applyMatrix4(matrixWorld)
  }

  const edgeA = vertices[1]!.clone().sub(vertices[0]!)
  const edgeB = vertices[2]!.clone().sub(vertices[0]!)
  if (edgeA.cross(edgeB).lengthSq() <= EPSILON) return null
  return vertices.map(vector3ToTuple) as WorldsPlacementSurfacePolygon
}

function resolveTriangleVertexIndices(
  geometry: THREE.BufferGeometry,
  intersection: THREE.Intersection<THREE.Object3D>,
): [number, number, number] | null {
  const face = intersection.face
  if (face && Number.isInteger(face.a) && Number.isInteger(face.b) && Number.isInteger(face.c)) {
    return [face.a, face.b, face.c]
  }

  if (!Number.isInteger(intersection.faceIndex)) return null
  const faceIndex = intersection.faceIndex!
  const index = geometry.getIndex()
  if (index) {
    const offset = faceIndex * 3
    if (offset + 2 >= index.count) return null
    return [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)]
  }

  const offset = faceIndex * 3
  const position = geometry.getAttribute('position')
  if (!position || offset + 2 >= position.count) return null
  return [offset, offset + 1, offset + 2]
}

function resolveWorldNormal(
  mesh: THREE.Mesh,
  faceNormal: Vector3Like | null,
  polygon: WorldsPlacementSurfacePolygon,
  rayDirection: THREE.Vector3,
): THREE.Vector3 | null {
  let worldNormal: THREE.Vector3 | null = null
  if (isVector3Like(faceNormal)) {
    worldNormal = new THREE.Vector3(faceNormal.x, faceNormal.y, faceNormal.z).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize()
  } else {
    const a = tupleToVector3(polygon[0])
    const b = tupleToVector3(polygon[1])
    const c = tupleToVector3(polygon[2])
    if (!a || !b || !c) return null
    worldNormal = b.sub(a).cross(c.sub(a)).normalize()
  }

  if (!Number.isFinite(worldNormal.x) || !Number.isFinite(worldNormal.y) || !Number.isFinite(worldNormal.z) || worldNormal.lengthSq() <= EPSILON) {
    return null
  }
  if (worldNormal.dot(rayDirection) > 0) worldNormal.multiplyScalar(-1)
  return worldNormal
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

function isMeshLike(object: THREE.Object3D): object is THREE.Mesh {
  return (object as { isMesh?: unknown }).isMesh === true && 'geometry' in object
}

function isBufferGeometryLike(geometry: unknown): geometry is THREE.BufferGeometry {
  return !!geometry
    && typeof geometry === 'object'
    && typeof (geometry as { getAttribute?: unknown }).getAttribute === 'function'
}

function isBufferAttributeLike(attribute: unknown): attribute is THREE.BufferAttribute | THREE.InterleavedBufferAttribute {
  return !!attribute
    && typeof attribute === 'object'
    && Number.isFinite((attribute as { count?: unknown }).count)
    && typeof (attribute as { getX?: unknown }).getX === 'function'
}

function isVector3Like(value: unknown): value is Vector3Like {
  return !!value
    && typeof value === 'object'
    && Number.isFinite((value as { x?: unknown }).x)
    && Number.isFinite((value as { y?: unknown }).y)
    && Number.isFinite((value as { z?: unknown }).z)
}

function tupleToVector3(tuple: [number, number, number]): THREE.Vector3 | null {
  if (!Number.isFinite(tuple[0]) || !Number.isFinite(tuple[1]) || !Number.isFinite(tuple[2])) return null
  return new THREE.Vector3(tuple[0], tuple[1], tuple[2])
}

function vector3ToTuple(vector: Vector3Like): [number, number, number] {
  return [normalizeSignedZero(vector.x), normalizeSignedZero(vector.y), normalizeSignedZero(vector.z)]
}

function normalizeSignedZero(value: number): number {
  return Math.abs(value) <= 1e-12 ? 0 : value
}
