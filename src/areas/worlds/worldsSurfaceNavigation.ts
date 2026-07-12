import {
  projectWorldPointToCollisionSurfaceUv,
  signedDistanceToWorldCollisionSurfacePlane,
  worldCollisionSurfaceAabbsIntersect,
} from './worldsSurfaceMath.ts'
import type {
  WorldsResolvedCollisionSurface,
  WorldsResolvedRectCollisionSurface,
  WorldsResolvedTriCollisionSurface,
  WorldsSurfaceAabb,
  WorldsSurfaceVector3Like,
} from './worldsSurfaceMath.ts'

export interface WorldsSurfaceProbe {
  position: WorldsSurfaceVector3Like
  halfExtents: WorldsSurfaceVector3Like
}

export interface WorldsSurfaceNavigationOptions {
  skinEpsilon?: number
  edgeEpsilon?: number
  maxSlideIterations?: number
  maxDepenetrationIterations?: number
}

export interface WorldsSurfaceSweepHit {
  surfaceId: string
  fraction: number
  point: WorldsSurfaceVector3Like
  normal: WorldsSurfaceVector3Like
  distance: number
}

export interface WorldsSurfaceDepenetrationResult {
  position: WorldsSurfaceVector3Like
  depenetrated: boolean
  intersectingSurfaceIds: string[]
  iterations: number
  resolved: boolean
}

export interface WorldsSurfaceNavigationResult {
  position: WorldsSurfaceVector3Like
  acceptedDelta: WorldsSurfaceVector3Like
  collidedSurfaceIds: string[]
  depenetrated: boolean
  depenetration: WorldsSurfaceDepenetrationResult
  earliestHit: WorldsSurfaceSweepHit | null
}

export interface SweepWorldProbeAgainstSurfaceInput {
  position: WorldsSurfaceVector3Like
  probeHalfExtents: WorldsSurfaceVector3Like
  delta: WorldsSurfaceVector3Like
  surface: WorldsResolvedCollisionSurface
  skinEpsilon?: number
  edgeEpsilon?: number
}

export interface FindEarliestWorldSurfaceHitInput {
  position: WorldsSurfaceVector3Like
  probeHalfExtents: WorldsSurfaceVector3Like
  delta: WorldsSurfaceVector3Like
  surfaces: readonly (WorldsResolvedCollisionSurface | null | undefined)[]
  skinEpsilon?: number
  edgeEpsilon?: number
}

export interface DepenetrateWorldSurfaceProbeInput {
  position: WorldsSurfaceVector3Like
  probeHalfExtents: WorldsSurfaceVector3Like
  surfaces: readonly (WorldsResolvedCollisionSurface | null | undefined)[]
  skinEpsilon?: number
  edgeEpsilon?: number
  maxIterations?: number
}

export interface ResolveWorldSurfaceProbeTranslationInput {
  position: WorldsSurfaceVector3Like
  probeHalfExtents: WorldsSurfaceVector3Like
  delta: WorldsSurfaceVector3Like
  surfaces: readonly (WorldsResolvedCollisionSurface | null | undefined)[]
  skinEpsilon?: number
  edgeEpsilon?: number
  maxSlideIterations?: number
  maxDepenetrationIterations?: number
}

const DEFAULT_SKIN_EPSILON = 1e-4
const DEFAULT_EDGE_EPSILON = 1e-6
const DEFAULT_MAX_SLIDE_ITERATIONS = 3
const DEFAULT_MAX_DEPENETRATION_ITERATIONS = 8
const DISTANCE_EPSILON = 1e-8

export function sweepWorldProbeAgainstSurface({
  position,
  probeHalfExtents,
  delta,
  surface,
  skinEpsilon = DEFAULT_SKIN_EPSILON,
  edgeEpsilon = DEFAULT_EDGE_EPSILON,
}: SweepWorldProbeAgainstSurfaceInput): WorldsSurfaceSweepHit | null {
  if (isZeroVector(delta)) return null
  if (!sweptProbeCanReachSurface(position, probeHalfExtents, delta, surface, skinEpsilon)) return null

  const oriented = getSweepCandidate(position, delta, probeHalfExtents, surface, skinEpsilon)
  if (!oriented) return null

  const contactCenter = addVectors(position, scaleVector(delta, oriented.fraction))
  if (!doesProbeFootprintOverlapSurface(contactCenter, probeHalfExtents, surface, edgeEpsilon)) return null

  return {
    surfaceId: surface.id,
    fraction: oriented.fraction,
    point: subtractVectors(contactCenter, scaleVector(oriented.normal, oriented.radius + skinEpsilon)),
    normal: oriented.normal,
    distance: vectorLength(scaleVector(delta, oriented.fraction)),
  }
}

export function findEarliestWorldSurfaceHit({
  position,
  probeHalfExtents,
  delta,
  surfaces,
  skinEpsilon = DEFAULT_SKIN_EPSILON,
  edgeEpsilon = DEFAULT_EDGE_EPSILON,
}: FindEarliestWorldSurfaceHitInput): WorldsSurfaceSweepHit | null {
  let best: WorldsSurfaceSweepHit | null = null

  for (const surface of surfaces) {
    if (!surface) continue
    const hit = sweepWorldProbeAgainstSurface({
      position,
      probeHalfExtents,
      delta,
      surface,
      skinEpsilon,
      edgeEpsilon,
    })
    if (!hit) continue
    if (
      !best
      || hit.fraction < best.fraction - DISTANCE_EPSILON
      || (Math.abs(hit.fraction - best.fraction) <= DISTANCE_EPSILON && hit.surfaceId < best.surfaceId)
    ) {
      best = hit
    }
  }

  return best
}

export function depenetrateWorldSurfaceProbe({
  position,
  probeHalfExtents,
  surfaces,
  skinEpsilon = DEFAULT_SKIN_EPSILON,
  edgeEpsilon = DEFAULT_EDGE_EPSILON,
  maxIterations = DEFAULT_MAX_DEPENETRATION_ITERATIONS,
}: DepenetrateWorldSurfaceProbeInput): WorldsSurfaceDepenetrationResult {
  const currentPosition = copyVector(position)
  let iterations = 0

  for (; iterations < Math.max(1, Math.floor(maxIterations)); iterations += 1) {
    const overlaps = getSurfacePenetrationCandidates(currentPosition, probeHalfExtents, surfaces, skinEpsilon, edgeEpsilon)
    if (overlaps.length === 0) {
      return {
        position: currentPosition,
        depenetrated: !vectorsEqual(position, currentPosition),
        intersectingSurfaceIds: [],
        iterations,
        resolved: true,
      }
    }

    overlaps.sort(comparePenetrationCandidate)
    const best = overlaps[0]!
    currentPosition.x += best.offset.x
    currentPosition.y += best.offset.y
    currentPosition.z += best.offset.z
  }

  const remaining = getSurfacePenetrationCandidates(currentPosition, probeHalfExtents, surfaces, skinEpsilon, edgeEpsilon)
  return {
    position: currentPosition,
    depenetrated: !vectorsEqual(position, currentPosition),
    intersectingSurfaceIds: [...new Set(remaining.map((candidate) => candidate.surface.id))].sort(),
    iterations,
    resolved: remaining.length === 0,
  }
}

export function resolveWorldSurfaceProbeTranslation({
  position,
  probeHalfExtents,
  delta,
  surfaces,
  skinEpsilon = DEFAULT_SKIN_EPSILON,
  edgeEpsilon = DEFAULT_EDGE_EPSILON,
  maxSlideIterations = DEFAULT_MAX_SLIDE_ITERATIONS,
  maxDepenetrationIterations = DEFAULT_MAX_DEPENETRATION_ITERATIONS,
}: ResolveWorldSurfaceProbeTranslationInput): WorldsSurfaceNavigationResult {
  const depenetration = depenetrateWorldSurfaceProbe({
    position,
    probeHalfExtents,
    surfaces,
    skinEpsilon,
    edgeEpsilon,
    maxIterations: maxDepenetrationIterations,
  })
  const resolvedPosition = copyVector(depenetration.position)
  const acceptedDelta = { x: 0, y: 0, z: 0 }
  const collidedSurfaceIds = new Set<string>()
  let remainingDelta = copyVector(delta)
  let earliestHit: WorldsSurfaceSweepHit | null = null

  for (let iteration = 0; iteration < Math.max(1, Math.floor(maxSlideIterations)); iteration += 1) {
    if (isNearZeroVector(remainingDelta)) break
    const hit = findEarliestWorldSurfaceHit({
      position: resolvedPosition,
      probeHalfExtents,
      delta: remainingDelta,
      surfaces,
      skinEpsilon,
      edgeEpsilon,
    })
    if (!hit) {
      applyDelta(resolvedPosition, acceptedDelta, remainingDelta)
      remainingDelta = { x: 0, y: 0, z: 0 }
      break
    }

    if (!earliestHit) earliestHit = hit
    collidedSurfaceIds.add(hit.surfaceId)

    const safeDelta = scaleVector(remainingDelta, clamp(hit.fraction, 0, 1))
    if (!isNearZeroVector(safeDelta)) {
      applyDelta(resolvedPosition, acceptedDelta, safeDelta)
    }

    const unresolved = scaleVector(remainingDelta, 1 - clamp(hit.fraction, 0, 1))
    const inward = dot(unresolved, hit.normal)
    remainingDelta = inward < -DISTANCE_EPSILON
      ? subtractVectors(unresolved, scaleVector(hit.normal, inward))
      : unresolved

    if (hit.fraction <= DISTANCE_EPSILON && isNearZeroVector(remainingDelta)) break
  }

  return {
    position: resolvedPosition,
    acceptedDelta,
    collidedSurfaceIds: [...collidedSurfaceIds].sort(),
    depenetrated: depenetration.depenetrated,
    depenetration,
    earliestHit,
  }
}

interface SweepCandidate {
  fraction: number
  normal: WorldsSurfaceVector3Like
  radius: number
}

interface SurfacePenetrationCandidate {
  surface: WorldsResolvedCollisionSurface
  overlap: number
  directionPriority: number
  offset: WorldsSurfaceVector3Like
}

function getSweepCandidate(
  position: WorldsSurfaceVector3Like,
  delta: WorldsSurfaceVector3Like,
  probeHalfExtents: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
  skinEpsilon: number,
): SweepCandidate | null {
  const distance = signedDistanceToWorldCollisionSurfacePlane(position, surface)
  const planeVelocity = dot(delta, surface.normal)
  const radius = projectedProbeRadius(probeHalfExtents, surface.normal)
  const limit = radius + skinEpsilon

  if (surface.sidedness === 'front') {
    if (planeVelocity >= -DISTANCE_EPSILON) return null
    if (distance > limit + DISTANCE_EPSILON) {
      const fraction = (distance - limit) / -planeVelocity
      return isFractionInRange(fraction) ? { fraction, normal: surface.normal, radius } : null
    }
    if (Math.abs(distance - limit) <= skinEpsilon) {
      return { fraction: 0, normal: surface.normal, radius }
    }
    return null
  }

  if (planeVelocity < -DISTANCE_EPSILON) {
    if (distance > limit + DISTANCE_EPSILON) {
      const fraction = (distance - limit) / -planeVelocity
      return isFractionInRange(fraction) ? { fraction, normal: surface.normal, radius } : null
    }
    if (Math.abs(distance - limit) <= skinEpsilon) {
      return { fraction: 0, normal: surface.normal, radius }
    }
  }

  if (planeVelocity > DISTANCE_EPSILON) {
    if (distance < -(limit + DISTANCE_EPSILON)) {
      const fraction = (-limit - distance) / planeVelocity
      return isFractionInRange(fraction) ? { fraction, normal: negateVector(surface.normal), radius } : null
    }
    if (Math.abs(distance + limit) <= skinEpsilon) {
      return { fraction: 0, normal: negateVector(surface.normal), radius }
    }
  }

  return null
}

function getSurfacePenetrationCandidates(
  position: WorldsSurfaceVector3Like,
  probeHalfExtents: WorldsSurfaceVector3Like,
  surfaces: readonly (WorldsResolvedCollisionSurface | null | undefined)[],
  skinEpsilon: number,
  edgeEpsilon: number,
): SurfacePenetrationCandidate[] {
  const candidates: SurfacePenetrationCandidate[] = []

  for (const surface of surfaces) {
    if (!surface) continue
    if (!overlapsExpandedSurfaceAabb(position, probeHalfExtents, surface, skinEpsilon)) continue
    if (!doesProbeFootprintOverlapSurface(position, probeHalfExtents, surface, edgeEpsilon)) continue

    const distance = signedDistanceToWorldCollisionSurfacePlane(position, surface)
    const radius = projectedProbeRadius(probeHalfExtents, surface.normal)
    const limit = radius + skinEpsilon

    if (surface.sidedness === 'front') {
      if (distance >= limit - DISTANCE_EPSILON) continue
      const overlap = limit - distance
      candidates.push({
        surface,
        overlap,
        directionPriority: 0,
        offset: scaleVector(surface.normal, overlap),
      })
      continue
    }

    if (distance >= 0) {
      if (distance >= limit - DISTANCE_EPSILON) continue
      const overlap = limit - distance
      candidates.push({
        surface,
        overlap,
        directionPriority: 0,
        offset: scaleVector(surface.normal, overlap),
      })
      continue
    }

    if (distance <= -limit + DISTANCE_EPSILON) continue
    const overlap = limit + distance
    candidates.push({
      surface,
      overlap,
      directionPriority: 1,
      offset: scaleVector(surface.normal, -overlap),
    })
  }

  return candidates
}

function comparePenetrationCandidate(left: SurfacePenetrationCandidate, right: SurfacePenetrationCandidate): number {
  if (Math.abs(left.overlap - right.overlap) > DISTANCE_EPSILON) return left.overlap - right.overlap
  if (left.surface.id !== right.surface.id) return left.surface.id.localeCompare(right.surface.id)
  return left.directionPriority - right.directionPriority
}

function sweptProbeCanReachSurface(
  position: WorldsSurfaceVector3Like,
  probeHalfExtents: WorldsSurfaceVector3Like,
  delta: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
  skinEpsilon: number,
): boolean {
  const startAabb = buildProbeAabb(position, probeHalfExtents)
  const endAabb = buildProbeAabb(addVectors(position, delta), probeHalfExtents)
  const sweptAabb = {
    min: {
      x: Math.min(startAabb.min.x, endAabb.min.x),
      y: Math.min(startAabb.min.y, endAabb.min.y),
      z: Math.min(startAabb.min.z, endAabb.min.z),
    },
    max: {
      x: Math.max(startAabb.max.x, endAabb.max.x),
      y: Math.max(startAabb.max.y, endAabb.max.y),
      z: Math.max(startAabb.max.z, endAabb.max.z),
    },
  }
  return worldCollisionSurfaceAabbsIntersect(sweptAabb, expandAabb(surface.worldAabb, probeHalfExtents, skinEpsilon))
}

function overlapsExpandedSurfaceAabb(
  position: WorldsSurfaceVector3Like,
  probeHalfExtents: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
  skinEpsilon: number,
): boolean {
  return worldCollisionSurfaceAabbsIntersect(
    buildProbeAabb(position, probeHalfExtents),
    expandAabb(surface.worldAabb, { x: skinEpsilon, y: skinEpsilon, z: skinEpsilon }, 0),
  )
}

function doesProbeFootprintOverlapSurface(
  position: WorldsSurfaceVector3Like,
  probeHalfExtents: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
  edgeEpsilon: number,
): boolean {
  const projectedCorners = getProjectedProbeCorners(position, probeHalfExtents, surface)
  const hull = buildConvexHull(projectedCorners, edgeEpsilon)
  if (hull.length < 3) return false
  return convexPolygonsOverlap(hull, getSurfacePolygon(surface), edgeEpsilon)
}

function getSurfacePolygon(surface: WorldsResolvedCollisionSurface): [number, number][] {
  if (surface.shape === 'rect') {
    return getRectPolygon(surface)
  }
  return surface.localTriangle.vertices.map((vertex) => [vertex[0], vertex[1]])
}

function getRectPolygon(surface: WorldsResolvedRectCollisionSurface): [number, number][] {
  return [
    [-surface.localRect.halfWidth, -surface.localRect.halfHeight],
    [-surface.localRect.halfWidth, surface.localRect.halfHeight],
    [surface.localRect.halfWidth, surface.localRect.halfHeight],
    [surface.localRect.halfWidth, -surface.localRect.halfHeight],
  ]
}

function getProjectedProbeCorners(
  position: WorldsSurfaceVector3Like,
  probeHalfExtents: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
): [number, number][] {
  const xs = [position.x - probeHalfExtents.x, position.x + probeHalfExtents.x]
  const ys = [position.y - probeHalfExtents.y, position.y + probeHalfExtents.y]
  const zs = [position.z - probeHalfExtents.z, position.z + probeHalfExtents.z]
  const projected: [number, number][] = []

  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        projected.push(projectWorldPointToCollisionSurfaceUv({ x, y, z }, surface))
      }
    }
  }

  return projected
}

function buildConvexHull(points: readonly [number, number][], epsilon: number): [number, number][] {
  const sorted = [...points].sort((left, right) => {
    if (Math.abs(left[0] - right[0]) > epsilon) return left[0] - right[0]
    return left[1] - right[1]
  })
  const unique: [number, number][] = []

  for (const point of sorted) {
    const last = unique[unique.length - 1]
    if (!last || Math.abs(last[0] - point[0]) > epsilon || Math.abs(last[1] - point[1]) > epsilon) {
      unique.push([point[0], point[1]])
    }
  }

  if (unique.length <= 2) return unique

  const lower: [number, number][] = []
  for (const point of unique) {
    while (lower.length >= 2 && cross2(subtract2(lower[lower.length - 1]!, lower[lower.length - 2]!), subtract2(point, lower[lower.length - 1]!)) <= epsilon) {
      lower.pop()
    }
    lower.push(point)
  }

  const upper: [number, number][] = []
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index]!
    while (upper.length >= 2 && cross2(subtract2(upper[upper.length - 1]!, upper[upper.length - 2]!), subtract2(point, upper[upper.length - 1]!)) <= epsilon) {
      upper.pop()
    }
    upper.push(point)
  }

  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

function convexPolygonsOverlap(left: readonly [number, number][], right: readonly [number, number][], epsilon: number): boolean {
  const axes = [...getPolygonAxes(left), ...getPolygonAxes(right)]
  for (const axis of axes) {
    const leftProjection = projectPolygonOntoAxis(left, axis)
    const rightProjection = projectPolygonOntoAxis(right, axis)
    if (leftProjection.max < rightProjection.min - epsilon || rightProjection.max < leftProjection.min - epsilon) {
      return false
    }
  }
  return true
}

function getPolygonAxes(points: readonly [number, number][]): [number, number][] {
  const axes: [number, number][] = []
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!
    const end = points[(index + 1) % points.length]!
    const edge = subtract2(end, start)
    const axis: [number, number] = [-edge[1], edge[0]]
    const length = Math.hypot(axis[0], axis[1])
    if (length <= DISTANCE_EPSILON) continue
    axes.push([axis[0] / length, axis[1] / length])
  }
  return axes
}

function projectPolygonOntoAxis(points: readonly [number, number][], axis: [number, number]): { min: number; max: number } {
  let min = dot2(points[0]!, axis)
  let max = min
  for (const point of points.slice(1)) {
    const value = dot2(point, axis)
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  return { min, max }
}

function projectedProbeRadius(probeHalfExtents: WorldsSurfaceVector3Like, normal: WorldsSurfaceVector3Like): number {
  return (
    probeHalfExtents.x * Math.abs(normal.x)
    + probeHalfExtents.y * Math.abs(normal.y)
    + probeHalfExtents.z * Math.abs(normal.z)
  )
}

function buildProbeAabb(position: WorldsSurfaceVector3Like, halfExtents: WorldsSurfaceVector3Like): WorldsSurfaceAabb {
  return {
    min: {
      x: position.x - halfExtents.x,
      y: position.y - halfExtents.y,
      z: position.z - halfExtents.z,
    },
    max: {
      x: position.x + halfExtents.x,
      y: position.y + halfExtents.y,
      z: position.z + halfExtents.z,
    },
  }
}

function expandAabb(aabb: WorldsSurfaceAabb, amount: WorldsSurfaceVector3Like, extra: number): WorldsSurfaceAabb {
  return {
    min: {
      x: aabb.min.x - amount.x - extra,
      y: aabb.min.y - amount.y - extra,
      z: aabb.min.z - amount.z - extra,
    },
    max: {
      x: aabb.max.x + amount.x + extra,
      y: aabb.max.y + amount.y + extra,
      z: aabb.max.z + amount.z + extra,
    },
  }
}

function isFractionInRange(value: number): boolean {
  return value >= -DISTANCE_EPSILON && value <= 1 + DISTANCE_EPSILON
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function applyDelta(
  position: WorldsSurfaceVector3Like,
  appliedDelta: WorldsSurfaceVector3Like,
  delta: WorldsSurfaceVector3Like,
): void {
  position.x += delta.x
  position.y += delta.y
  position.z += delta.z
  appliedDelta.x += delta.x
  appliedDelta.y += delta.y
  appliedDelta.z += delta.z
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

function negateVector(vector: WorldsSurfaceVector3Like): WorldsSurfaceVector3Like {
  return { x: -vector.x, y: -vector.y, z: -vector.z }
}

function copyVector(vector: WorldsSurfaceVector3Like): WorldsSurfaceVector3Like {
  return { x: vector.x, y: vector.y, z: vector.z }
}

function dot(left: WorldsSurfaceVector3Like, right: WorldsSurfaceVector3Like): number {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

function vectorLength(vector: WorldsSurfaceVector3Like): number {
  return Math.hypot(vector.x, vector.y, vector.z)
}

function vectorsEqual(left: WorldsSurfaceVector3Like, right: WorldsSurfaceVector3Like): boolean {
  return (
    Math.abs(left.x - right.x) <= DISTANCE_EPSILON
    && Math.abs(left.y - right.y) <= DISTANCE_EPSILON
    && Math.abs(left.z - right.z) <= DISTANCE_EPSILON
  )
}

function isZeroVector(vector: WorldsSurfaceVector3Like): boolean {
  return vector.x === 0 && vector.y === 0 && vector.z === 0
}

function isNearZeroVector(vector: WorldsSurfaceVector3Like): boolean {
  return vectorLength(vector) <= DISTANCE_EPSILON
}

function subtract2(left: [number, number], right: [number, number]): [number, number] {
  return [left[0] - right[0], left[1] - right[1]]
}

function cross2(left: [number, number], right: [number, number]): number {
  return (left[0] * right[1]) - (left[1] * right[0])
}

function dot2(left: [number, number], right: [number, number]): number {
  return (left[0] * right[0]) + (left[1] * right[1])
}
