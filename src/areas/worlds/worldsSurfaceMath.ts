import type {
  WorldCollisionRectSurface,
  WorldCollisionSurface,
  WorldCollisionSurfaceSidedness,
  WorldCollisionTriSurface,
} from './worldsCollisionSurfaces.ts'
import { normalizeWorldCollisionSurface } from './worldsCollisionSurfaces.ts'

export interface WorldsSurfaceVector3Like {
  x: number
  y: number
  z: number
}

export interface WorldsSurfaceAabb {
  min: WorldsSurfaceVector3Like
  max: WorldsSurfaceVector3Like
}

export type WorldsSurfaceSide = 'front' | 'back' | 'coplanar'

export interface WorldsResolvedCollisionSurfaceBase {
  id: string
  shape: WorldCollisionSurface['shape']
  preset?: WorldCollisionSurface['preset']
  sidedness: WorldCollisionSurfaceSidedness
  origin: WorldsSurfaceVector3Like
  normal: WorldsSurfaceVector3Like
  tangentU: WorldsSurfaceVector3Like
  tangentV: WorldsSurfaceVector3Like
  scale: {
    u: number
    v: number
  }
  worldAabb: WorldsSurfaceAabb
}

export interface WorldsResolvedRectCollisionSurface extends WorldsResolvedCollisionSurfaceBase {
  shape: 'rect'
  localRect: {
    halfWidth: number
    halfHeight: number
  }
  worldCorners: [WorldsSurfaceVector3Like, WorldsSurfaceVector3Like, WorldsSurfaceVector3Like, WorldsSurfaceVector3Like]
}

export interface WorldsResolvedTriCollisionSurface extends WorldsResolvedCollisionSurfaceBase {
  shape: 'tri'
  localTriangle: {
    vertices: [[number, number], [number, number], [number, number]]
  }
  worldVertices: [WorldsSurfaceVector3Like, WorldsSurfaceVector3Like, WorldsSurfaceVector3Like]
}

export type WorldsResolvedCollisionSurface = WorldsResolvedRectCollisionSurface | WorldsResolvedTriCollisionSurface

const DEFAULT_EPSILON = 1e-6

export function resolveWorldCollisionSurface(surface: WorldCollisionSurface): WorldsResolvedCollisionSurface | null {
  const normalized = normalizeWorldCollisionSurface(surface)
  if (!normalized) return null

  const [tangentU, normal, tangentV] = rotationAxesFromEulerXYZ(
    normalized.transform.rotation[0],
    normalized.transform.rotation[1],
    normalized.transform.rotation[2],
  )
  const origin = vectorFromTuple(normalized.transform.position)
  const scale = {
    u: normalized.transform.scale[0],
    v: normalized.transform.scale[2],
  }

  if (normalized.shape === 'rect') {
    const worldCorners: WorldsResolvedRectCollisionSurface['worldCorners'] = [
      surfacePointToWorld(origin, tangentU, tangentV, scale, -normalized.geometry.halfWidth, -normalized.geometry.halfHeight),
      surfacePointToWorld(origin, tangentU, tangentV, scale, -normalized.geometry.halfWidth, normalized.geometry.halfHeight),
      surfacePointToWorld(origin, tangentU, tangentV, scale, normalized.geometry.halfWidth, normalized.geometry.halfHeight),
      surfacePointToWorld(origin, tangentU, tangentV, scale, normalized.geometry.halfWidth, -normalized.geometry.halfHeight),
    ]

    return {
      id: normalized.id,
      shape: 'rect',
      ...(normalized.preset ? { preset: normalized.preset } : {}),
      sidedness: normalized.sidedness ?? 'double',
      origin,
      normal,
      tangentU,
      tangentV,
      scale,
      localRect: {
        halfWidth: normalized.geometry.halfWidth,
        halfHeight: normalized.geometry.halfHeight,
      },
      worldCorners,
      worldAabb: buildWorldAabb(worldCorners),
    }
  }

  const worldVertices: WorldsResolvedTriCollisionSurface['worldVertices'] = normalized.geometry.vertices.map((vertex) => (
    surfacePointToWorld(origin, tangentU, tangentV, scale, vertex[0], vertex[1])
  )) as WorldsResolvedTriCollisionSurface['worldVertices']

  return {
    id: normalized.id,
    shape: 'tri',
    ...(normalized.preset ? { preset: normalized.preset } : {}),
    sidedness: normalized.sidedness ?? 'double',
    origin,
    normal,
    tangentU,
    tangentV,
    scale,
    localTriangle: {
      vertices: normalized.geometry.vertices.map((vertex) => [...vertex]) as WorldsResolvedTriCollisionSurface['localTriangle']['vertices'],
    },
    worldVertices,
    worldAabb: buildWorldAabb(worldVertices),
  }
}

export function signedDistanceToWorldCollisionSurfacePlane(
  point: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
): number {
  return dot(subtractVectors(point, surface.origin), surface.normal)
}

export function projectWorldPointToCollisionSurfaceUv(
  point: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
): [number, number] {
  const delta = subtractVectors(point, surface.origin)
  return [
    dot(delta, surface.tangentU) / surface.scale.u,
    dot(delta, surface.tangentV) / surface.scale.v,
  ]
}

export function classifyWorldPointAgainstCollisionSurfaceSide(
  point: WorldsSurfaceVector3Like,
  surface: Pick<WorldsResolvedCollisionSurface, 'origin' | 'normal'>,
  epsilon = DEFAULT_EPSILON,
): WorldsSurfaceSide {
  const signedDistance = dot(subtractVectors(point, surface.origin), surface.normal)
  if (signedDistance > epsilon) return 'front'
  if (signedDistance < -epsilon) return 'back'
  return 'coplanar'
}

export function isPointInCollisionSurfaceRect(
  uv: [number, number],
  surface: Pick<WorldsResolvedRectCollisionSurface, 'localRect'>,
  epsilon = DEFAULT_EPSILON,
): boolean {
  return Math.abs(uv[0]) <= surface.localRect.halfWidth + epsilon && Math.abs(uv[1]) <= surface.localRect.halfHeight + epsilon
}

export function isPointInCollisionSurfaceTriangle(
  uv: [number, number],
  surface: Pick<WorldsResolvedTriCollisionSurface, 'localTriangle'>,
  epsilon = DEFAULT_EPSILON,
): boolean {
  const [a, b, c] = surface.localTriangle.vertices
  const denominator = ((b[1] - c[1]) * (a[0] - c[0])) + ((c[0] - b[0]) * (a[1] - c[1]))
  if (Math.abs(denominator) <= 1e-8) return false

  const alpha = (((b[1] - c[1]) * (uv[0] - c[0])) + ((c[0] - b[0]) * (uv[1] - c[1]))) / denominator
  const beta = (((c[1] - a[1]) * (uv[0] - c[0])) + ((a[0] - c[0]) * (uv[1] - c[1]))) / denominator
  const gamma = 1 - alpha - beta
  return alpha >= -epsilon && beta >= -epsilon && gamma >= -epsilon
}

export function isWorldPointInCollisionSurface(
  point: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
  epsilon = DEFAULT_EPSILON,
): boolean {
  if (Math.abs(signedDistanceToWorldCollisionSurfacePlane(point, surface)) > epsilon) return false
  const uv = projectWorldPointToCollisionSurfaceUv(point, surface)
  return surface.shape === 'rect'
    ? isPointInCollisionSurfaceRect(uv, surface, epsilon)
    : isPointInCollisionSurfaceTriangle(uv, surface, epsilon)
}

export function closestPointOnWorldCollisionSurface(
  point: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
): WorldsSurfaceVector3Like {
  const projected = projectWorldPointToCollisionSurfacePlane(point, surface)
  if (surface.shape === 'rect') {
    const uv = projectWorldPointToCollisionSurfaceUv(projected, surface)
    return surfacePointToWorld(
      surface.origin,
      surface.tangentU,
      surface.tangentV,
      surface.scale,
      clamp(uv[0], -surface.localRect.halfWidth, surface.localRect.halfWidth),
      clamp(uv[1], -surface.localRect.halfHeight, surface.localRect.halfHeight),
    )
  }

  if (isWorldPointInCollisionSurface(projected, surface)) return projected

  const [a, b, c] = surface.worldVertices
  const closestOnAb = closestPointOnSegment(projected, a, b)
  const closestOnBc = closestPointOnSegment(projected, b, c)
  const closestOnCa = closestPointOnSegment(projected, c, a)
  return nearestPoint(projected, [closestOnAb, closestOnBc, closestOnCa])
}

export function worldCollisionSurfaceAabbsIntersect(left: WorldsSurfaceAabb, right: WorldsSurfaceAabb): boolean {
  return (
    left.min.x <= right.max.x
    && left.max.x >= right.min.x
    && left.min.y <= right.max.y
    && left.max.y >= right.min.y
    && left.min.z <= right.max.z
    && left.max.z >= right.min.z
  )
}

function projectWorldPointToCollisionSurfacePlane(
  point: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
): WorldsSurfaceVector3Like {
  const signedDistance = signedDistanceToWorldCollisionSurfacePlane(point, surface)
  return subtractVectors(point, scaleVector(surface.normal, signedDistance))
}

function surfacePointToWorld(
  origin: WorldsSurfaceVector3Like,
  tangentU: WorldsSurfaceVector3Like,
  tangentV: WorldsSurfaceVector3Like,
  scale: { u: number; v: number },
  localU: number,
  localV: number,
): WorldsSurfaceVector3Like {
  return addVectors(
    origin,
    addVectors(scaleVector(tangentU, localU * scale.u), scaleVector(tangentV, localV * scale.v)),
  )
}

function buildWorldAabb(points: readonly WorldsSurfaceVector3Like[]): WorldsSurfaceAabb {
  const min = { ...points[0]! }
  const max = { ...points[0]! }

  for (const point of points.slice(1)) {
    min.x = Math.min(min.x, point.x)
    min.y = Math.min(min.y, point.y)
    min.z = Math.min(min.z, point.z)
    max.x = Math.max(max.x, point.x)
    max.y = Math.max(max.y, point.y)
    max.z = Math.max(max.z, point.z)
  }

  return { min, max }
}

function nearestPoint(origin: WorldsSurfaceVector3Like, points: readonly WorldsSurfaceVector3Like[]): WorldsSurfaceVector3Like {
  let best = points[0]!
  let bestDistanceSquared = distanceSquared(origin, best)

  for (const point of points.slice(1)) {
    const candidateDistanceSquared = distanceSquared(origin, point)
    if (candidateDistanceSquared < bestDistanceSquared) {
      best = point
      bestDistanceSquared = candidateDistanceSquared
    }
  }

  return best
}

function closestPointOnSegment(
  point: WorldsSurfaceVector3Like,
  start: WorldsSurfaceVector3Like,
  end: WorldsSurfaceVector3Like,
): WorldsSurfaceVector3Like {
  const segment = subtractVectors(end, start)
  const segmentLengthSquared = dot(segment, segment)
  if (segmentLengthSquared <= 1e-8) return { ...start }

  const t = clamp(dot(subtractVectors(point, start), segment) / segmentLengthSquared, 0, 1)
  return addVectors(start, scaleVector(segment, t))
}

function rotationAxesFromEulerXYZ(
  rotationX: number,
  rotationY: number,
  rotationZ: number,
): [WorldsSurfaceVector3Like, WorldsSurfaceVector3Like, WorldsSurfaceVector3Like] {
  const cosX = Math.cos(rotationX)
  const sinX = Math.sin(rotationX)
  const cosY = Math.cos(rotationY)
  const sinY = Math.sin(rotationY)
  const cosZ = Math.cos(rotationZ)
  const sinZ = Math.sin(rotationZ)

  const m11 = cosY * cosZ
  const m12 = -cosY * sinZ
  const m13 = sinY
  const m21 = cosZ * sinX * sinY + cosX * sinZ
  const m22 = cosX * cosZ - sinX * sinY * sinZ
  const m23 = -cosY * sinX
  const m31 = -cosX * cosZ * sinY + sinX * sinZ
  const m32 = cosZ * sinX + cosX * sinY * sinZ
  const m33 = cosX * cosY

  return [
    { x: m11, y: m21, z: m31 },
    { x: m12, y: m22, z: m32 },
    { x: m13, y: m23, z: m33 },
  ]
}

function vectorFromTuple([x, y, z]: [number, number, number]): WorldsSurfaceVector3Like {
  return { x, y, z }
}

function addVectors(left: WorldsSurfaceVector3Like, right: WorldsSurfaceVector3Like): WorldsSurfaceVector3Like {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z }
}

function subtractVectors(left: WorldsSurfaceVector3Like, right: WorldsSurfaceVector3Like): WorldsSurfaceVector3Like {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z }
}

function scaleVector(vector: WorldsSurfaceVector3Like, scalar: number): WorldsSurfaceVector3Like {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar }
}

function dot(left: WorldsSurfaceVector3Like, right: WorldsSurfaceVector3Like): number {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

function distanceSquared(left: WorldsSurfaceVector3Like, right: WorldsSurfaceVector3Like): number {
  const dx = left.x - right.x
  const dy = left.y - right.y
  const dz = left.z - right.z
  return (dx * dx) + (dy * dy) + (dz * dz)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
