import {
  buildWorldCollisionBoxFromLocalBounds,
  type WorldsCollisionBounds,
  type WorldsCollisionBox,
  type WorldsCollisionEulerTransformInput,
} from './worldsCollisionMath.ts'
import {
  closestPointOnWorldCollisionSurface,
  projectWorldPointToCollisionSurfaceUv,
  signedDistanceToWorldCollisionSurfacePlane,
  worldCollisionSurfaceAabbsIntersect,
  type WorldsResolvedCollisionSurface,
  type WorldsSurfaceAabb,
  type WorldsSurfaceVector3Like,
} from './worldsSurfaceMath.ts'

export type WorldsSurfacePlacementMode = 'translate' | 'rotate' | 'scale'
export type WorldsSurfacePlacementReason = 'free' | 'snapped' | 'blocked' | 'invalid-candidate'

export interface WorldsSurfacePlacementTransform {
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
}

export interface WorldsSurfacePlacementItemDescriptor {
  id: string
  localBounds: WorldsCollisionBounds | null | undefined
  startTransform: WorldsSurfacePlacementTransform
}

export interface WorldsSurfacePlacementItemTransformUpdate {
  id: string
  transform: WorldsSurfacePlacementTransform
}

export interface ResolveWorldsSurfacePlacementInput {
  mode: WorldsSurfacePlacementMode
  items: readonly WorldsSurfacePlacementItemDescriptor[]
  desiredTransforms: readonly WorldsSurfacePlacementItemTransformUpdate[]
  surfaces: readonly WorldsResolvedCollisionSurface[]
  options?: WorldsSurfacePlacementOptions
}

export interface WorldsSurfacePlacementOptions {
  skin?: number
  snapDistance?: number
  edgeEpsilon?: number
  maxSlideIterations?: number
}

export interface WorldsSurfacePlacementResolvedTransform {
  id: string
  transform: WorldsSurfacePlacementTransform
}

export interface WorldsSurfacePlacementResult {
  resolvedTransforms: WorldsSurfacePlacementResolvedTransform[]
  valid: boolean
  acceptedTranslationDelta: [number, number, number] | null
  blockedSurfaceIds: string[]
  snappedSurfaceId: string | null
  snappedSurfaceNormal: [number, number, number] | null
  snappedSurfacePoint: [number, number, number] | null
  reason: WorldsSurfacePlacementReason
}

interface NormalizedPlacementItem {
  id: string
  localBounds: WorldsCollisionBounds
  startTransform: WorldsSurfacePlacementTransform
  desiredTransform: WorldsSurfacePlacementTransform
}

interface PlacementObb {
  itemId: string
  transform: WorldsSurfacePlacementTransform
  collisionBox: WorldsCollisionBox
  worldCorners: WorldsSurfaceVector3Like[]
}

interface SurfaceSweepHit {
  itemId: string
  surfaceId: string
  fraction: number
  normal: WorldsSurfaceVector3Like
}

interface SnapCandidate {
  itemId: string
  surface: WorldsResolvedCollisionSurface
  translation: WorldsSurfaceVector3Like
  reportNormal: WorldsSurfaceVector3Like
  correctionMagnitude: number
  point: WorldsSurfaceVector3Like
}

const DEFAULT_SKIN = 1e-4
const DEFAULT_EDGE_EPSILON = 1e-6
const DEFAULT_SNAP_DISTANCE = 0.25
const DEFAULT_MAX_SLIDE_ITERATIONS = 3
const EPSILON = 1e-8

export function resolveWorldsSurfacePlacement({
  mode,
  items,
  desiredTransforms,
  surfaces,
  options = {},
}: ResolveWorldsSurfacePlacementInput): WorldsSurfacePlacementResult {
  const normalized = normalizePlacementItems(items, desiredTransforms)
  if (!normalized) {
    return {
      resolvedTransforms: buildFallbackTransforms(items, desiredTransforms),
      valid: false,
      acceptedTranslationDelta: null,
      blockedSurfaceIds: [],
      snappedSurfaceId: null,
      snappedSurfaceNormal: null,
      snappedSurfacePoint: null,
      reason: 'invalid-candidate',
    }
  }

  const resolvedSurfaces = normalizeSurfaces(surfaces)
  const skin = normalizePositiveNumber(options.skin, DEFAULT_SKIN)
  const edgeEpsilon = normalizePositiveNumber(options.edgeEpsilon, DEFAULT_EDGE_EPSILON)
  const snapDistance = normalizePositiveNumber(options.snapDistance, DEFAULT_SNAP_DISTANCE)
  const maxSlideIterations = Math.max(1, Math.floor(normalizePositiveNumber(options.maxSlideIterations, DEFAULT_MAX_SLIDE_ITERATIONS)))

  if (mode === 'translate') {
    return resolveTranslatePlacement(normalized, resolvedSurfaces, {
      skin,
      edgeEpsilon,
      snapDistance,
      maxSlideIterations,
    })
  }

  return resolveStaticPlacement(mode, normalized, resolvedSurfaces, { skin, edgeEpsilon })
}

function resolveTranslatePlacement(
  items: readonly NormalizedPlacementItem[],
  surfaces: readonly WorldsResolvedCollisionSurface[],
  options: Required<Pick<WorldsSurfacePlacementOptions, 'skin' | 'edgeEpsilon' | 'snapDistance' | 'maxSlideIterations'>>,
): WorldsSurfacePlacementResult {
  const requestedDelta = getCommonTranslationDelta(items)
  if (!requestedDelta) {
    return invalidCandidateResult(items)
  }

  const startObbs = buildPlacementObbs(items, 'startTransform')
  if (!startObbs) return invalidCandidateResult(items)

  const startViolations = collectIntersectingSurfaceIds(startObbs, surfaces, options.skin, options.edgeEpsilon)
  if (startViolations.length > 0) {
    return {
      resolvedTransforms: items.map((item) => ({ id: item.id, transform: cloneTransform(item.startTransform) })),
      valid: false,
      acceptedTranslationDelta: [0, 0, 0],
      blockedSurfaceIds: startViolations,
      snappedSurfaceId: null,
      snappedSurfaceNormal: null,
      snappedSurfacePoint: null,
      reason: 'blocked',
    }
  }

  if (surfaces.length === 0) {
    return {
      resolvedTransforms: items.map((item) => ({ id: item.id, transform: cloneTransform(item.desiredTransform) })),
      valid: true,
      acceptedTranslationDelta: vectorToTuple(requestedDelta),
      blockedSurfaceIds: [],
      snappedSurfaceId: null,
      snappedSurfaceNormal: null,
      snappedSurfacePoint: null,
      reason: 'free',
    }
  }

  let acceptedDelta = { x: 0, y: 0, z: 0 }
  let remainingDelta = copyVector(requestedDelta)
  const collidedSurfaceIds = new Set<string>()

  for (let iteration = 0; iteration < options.maxSlideIterations; iteration += 1) {
    if (isNearZeroVector(remainingDelta)) break
    const hit = findEarliestPlacementHit(startObbs, acceptedDelta, remainingDelta, surfaces, options.skin, options.edgeEpsilon)
    if (!hit) {
      acceptedDelta = addVectors(acceptedDelta, remainingDelta)
      remainingDelta = zeroVector()
      break
    }

    collidedSurfaceIds.add(hit.surfaceId)
    const safeDelta = scaleVector(remainingDelta, clamp(hit.fraction, 0, 1))
    acceptedDelta = addVectors(acceptedDelta, safeDelta)

    const unresolved = scaleVector(remainingDelta, 1 - clamp(hit.fraction, 0, 1))
    const inward = dot(unresolved, hit.normal)
    remainingDelta = inward < -EPSILON
      ? subtractVectors(unresolved, scaleVector(hit.normal, inward))
      : unresolved

    if (hit.fraction <= EPSILON && isNearZeroVector(remainingDelta)) break
  }

  let resolvedTransforms = applyCommonDelta(items, acceptedDelta)
  let resolvedObbs = buildPlacementObbsFromTransforms(items, resolvedTransforms)
  if (!resolvedObbs) return invalidCandidateResult(items)

  const snap = options.snapDistance > 0 && collidedSurfaceIds.size === 0
    ? resolveBestSnap(resolvedObbs, surfaces, options.skin, options.edgeEpsilon, options.snapDistance)
    : null
  if (snap) {
    resolvedTransforms = applyDeltaToResolvedTransforms(resolvedTransforms, snap.translation)
    resolvedObbs = buildPlacementObbsFromTransforms(items, resolvedTransforms)
    if (!resolvedObbs) return invalidCandidateResult(items)
    acceptedDelta = addVectors(acceptedDelta, snap.translation)
  }

  const finalViolations = collectIntersectingSurfaceIds(resolvedObbs, surfaces, options.skin, options.edgeEpsilon)
  if (finalViolations.length > 0) {
    return {
      resolvedTransforms,
      valid: false,
      acceptedTranslationDelta: vectorToTuple(acceptedDelta),
      blockedSurfaceIds: finalViolations,
      snappedSurfaceId: snap?.surface.id ?? null,
      snappedSurfaceNormal: snap ? normalizedTuple(snap.reportNormal) : null,
      snappedSurfacePoint: snap ? vectorToTuple(snap.point) : null,
      reason: 'blocked',
    }
  }

  const isBlocked = collidedSurfaceIds.size > 0 || !vectorsClose(acceptedDelta, requestedDelta)
  return {
    resolvedTransforms,
    valid: true,
    acceptedTranslationDelta: vectorToTuple(acceptedDelta),
    blockedSurfaceIds: [...collidedSurfaceIds].sort(),
    snappedSurfaceId: snap?.surface.id ?? null,
    snappedSurfaceNormal: snap ? normalizedTuple(snap.reportNormal) : null,
    snappedSurfacePoint: snap ? vectorToTuple(snap.point) : null,
    reason: snap ? 'snapped' : isBlocked ? 'blocked' : 'free',
  }
}

function resolveStaticPlacement(
  mode: Exclude<WorldsSurfacePlacementMode, 'translate'>,
  items: readonly NormalizedPlacementItem[],
  surfaces: readonly WorldsResolvedCollisionSurface[],
  options: Required<Pick<WorldsSurfacePlacementOptions, 'skin' | 'edgeEpsilon'>>,
): WorldsSurfacePlacementResult {
  const desiredObbs = buildPlacementObbs(items, 'desiredTransform')
  if (!desiredObbs) return invalidCandidateResult(items)
  const violations = collectIntersectingSurfaceIds(desiredObbs, surfaces, options.skin, options.edgeEpsilon)

  return {
    resolvedTransforms: items.map((item) => ({
      id: item.id,
      transform: cloneTransform(violations.length === 0 ? item.desiredTransform : item.startTransform),
    })),
    valid: violations.length === 0,
    acceptedTranslationDelta: null,
    blockedSurfaceIds: violations,
    snappedSurfaceId: null,
    snappedSurfaceNormal: null,
    snappedSurfacePoint: null,
    reason: violations.length === 0 ? 'free' : 'blocked',
  }
}

function resolveBestSnap(
  obbs: readonly PlacementObb[],
  surfaces: readonly WorldsResolvedCollisionSurface[],
  skin: number,
  edgeEpsilon: number,
  snapDistance: number,
): SnapCandidate | null {
  const candidates: SnapCandidate[] = []

  for (const obb of obbs) {
    for (const surface of surfaces) {
      if (!obbCanReachSurfaceForSnap(obb, surface, snapDistance)) continue
      if (!doesObbFootprintOverlapSurface(obb, surface, edgeEpsilon)) continue
      for (const candidate of getSnapCandidatesForObb(obb, surface, skin, snapDistance)) {
        candidates.push(candidate)
      }
    }
  }

  candidates.sort(compareSnapCandidate)
  for (const candidate of candidates) {
    const correctedObbs = offsetPlacementObbs(obbs, candidate.translation)
    if (collectIntersectingSurfaceIds(correctedObbs, surfaces, skin, edgeEpsilon).length === 0) {
      return candidate
    }
  }

  return null
}

function getSnapCandidatesForObb(
  obb: PlacementObb,
  surface: WorldsResolvedCollisionSurface,
  skin: number,
  snapDistance: number,
): SnapCandidate[] {
  const distance = signedDistanceToWorldCollisionSurfacePlane(obb.collisionBox.transform.position, surface)
  const radius = projectedObbRadius(obb.collisionBox, surface.normal)
  const limit = radius + skin
  const candidates: SnapCandidate[] = []

  const frontCorrection = limit - distance
  if (Math.abs(frontCorrection) > EPSILON && Math.abs(frontCorrection) <= snapDistance + EPSILON && distance >= limit - snapDistance - EPSILON) {
    const translation = scaleVector(surface.normal, frontCorrection)
    const finalCenter = addVectors(obb.collisionBox.transform.position, translation)
    const point = subtractVectors(finalCenter, scaleVector(surface.normal, limit))
    candidates.push({
      itemId: obb.itemId,
      surface,
      translation,
      reportNormal: copyVector(surface.normal),
      correctionMagnitude: Math.abs(frontCorrection),
      point,
    })
  }

  if (surface.sidedness === 'double') {
    const backCorrection = -limit - distance
    if (Math.abs(backCorrection) > EPSILON && Math.abs(backCorrection) <= snapDistance + EPSILON && distance <= -limit + snapDistance + EPSILON) {
      const translation = scaleVector(surface.normal, backCorrection)
      const finalCenter = addVectors(obb.collisionBox.transform.position, translation)
      const backNormal = negateVector(surface.normal)
      const point = subtractVectors(finalCenter, scaleVector(backNormal, limit))
      candidates.push({
        itemId: obb.itemId,
        surface,
        translation,
        reportNormal: backNormal,
        correctionMagnitude: Math.abs(backCorrection),
        point,
      })
    }
  }

  return candidates
}

function collectIntersectingSurfaceIds(
  obbs: readonly PlacementObb[],
  surfaces: readonly WorldsResolvedCollisionSurface[],
  skin: number,
  edgeEpsilon: number,
): string[] {
  const ids = new Set<string>()
  for (const obb of obbs) {
    for (const surface of surfaces) {
      if (doesObbIntersectFiniteSurface(obb, surface, skin, edgeEpsilon)) {
        ids.add(surface.id)
      }
    }
  }
  return [...ids].sort()
}

function findEarliestPlacementHit(
  startObbs: readonly PlacementObb[],
  appliedDelta: WorldsSurfaceVector3Like,
  delta: WorldsSurfaceVector3Like,
  surfaces: readonly WorldsResolvedCollisionSurface[],
  skin: number,
  edgeEpsilon: number,
): SurfaceSweepHit | null {
  let best: SurfaceSweepHit | null = null

  for (const startObb of startObbs) {
    const currentObb = offsetPlacementObb(startObb, appliedDelta)
    for (const surface of surfaces) {
      const hit = sweepObbAgainstSurface(currentObb, delta, surface, skin, edgeEpsilon)
      if (!hit) continue
      if (
        !best
        || hit.fraction < best.fraction - EPSILON
        || (
          Math.abs(hit.fraction - best.fraction) <= EPSILON
          && (hit.surfaceId < best.surfaceId || (hit.surfaceId === best.surfaceId && hit.itemId < best.itemId))
        )
      ) {
        best = hit
      }
    }
  }

  return best
}

function sweepObbAgainstSurface(
  obb: PlacementObb,
  delta: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
  skin: number,
  edgeEpsilon: number,
): SurfaceSweepHit | null {
  if (isNearZeroVector(delta)) return null
  if (!sweptObbCanReachSurface(obb, delta, surface, skin)) return null

  const sweep = getSweepCandidate(obb.collisionBox, delta, surface, skin)
  if (!sweep) return null

  const contactObb = offsetPlacementObb(obb, scaleVector(delta, sweep.fraction))
  if (!doesObbFootprintOverlapSurface(contactObb, surface, edgeEpsilon)) return null

  return {
    itemId: obb.itemId,
    surfaceId: surface.id,
    fraction: sweep.fraction,
    normal: sweep.normal,
  }
}

function doesObbIntersectFiniteSurface(
  obb: PlacementObb,
  surface: WorldsResolvedCollisionSurface,
  skin: number,
  edgeEpsilon: number,
): boolean {
  if (!worldCollisionSurfaceAabbsIntersect(obb.collisionBox.worldAabb, expandAabb(surface.worldAabb, skin))) return false
  if (!doesObbFootprintOverlapSurface(obb, surface, edgeEpsilon)) return false

  let minDistance = signedDistanceToWorldCollisionSurfacePlane(obb.worldCorners[0]!, surface)
  let maxDistance = minDistance
  for (const corner of obb.worldCorners.slice(1)) {
    const distance = signedDistanceToWorldCollisionSurfacePlane(corner, surface)
    minDistance = Math.min(minDistance, distance)
    maxDistance = Math.max(maxDistance, distance)
  }

  const centerDistance = signedDistanceToWorldCollisionSurfacePlane(obb.collisionBox.transform.position, surface)
  const radius = projectedObbRadius(obb.collisionBox, surface.normal)
  return Math.abs(centerDistance) < radius - skin + EPSILON
}

function doesObbFootprintOverlapSurface(
  obb: PlacementObb,
  surface: WorldsResolvedCollisionSurface,
  edgeEpsilon: number,
): boolean {
  const polygon = obb.worldCorners.map((corner) => projectWorldPointToCollisionSurfaceUv(corner, surface))
  const hull = buildConvexHull(polygon, edgeEpsilon)
  if (hull.length < 3) return false
  return convexPolygonsOverlap(hull, getSurfacePolygon(surface), edgeEpsilon)
}

function sweptObbCanReachSurface(
  obb: PlacementObb,
  delta: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
  skin: number,
): boolean {
  const endObb = offsetPlacementObb(obb, delta)
  const sweptAabb = {
    min: {
      x: Math.min(obb.collisionBox.worldAabb.min.x, endObb.collisionBox.worldAabb.min.x),
      y: Math.min(obb.collisionBox.worldAabb.min.y, endObb.collisionBox.worldAabb.min.y),
      z: Math.min(obb.collisionBox.worldAabb.min.z, endObb.collisionBox.worldAabb.min.z),
    },
    max: {
      x: Math.max(obb.collisionBox.worldAabb.max.x, endObb.collisionBox.worldAabb.max.x),
      y: Math.max(obb.collisionBox.worldAabb.max.y, endObb.collisionBox.worldAabb.max.y),
      z: Math.max(obb.collisionBox.worldAabb.max.z, endObb.collisionBox.worldAabb.max.z),
    },
  }
  return worldCollisionSurfaceAabbsIntersect(sweptAabb, expandAabb(surface.worldAabb, skin))
}

function obbCanReachSurfaceForSnap(
  obb: PlacementObb,
  surface: WorldsResolvedCollisionSurface,
  snapDistance: number,
): boolean {
  return worldCollisionSurfaceAabbsIntersect(obb.collisionBox.worldAabb, expandAabb(surface.worldAabb, snapDistance))
}

function getSweepCandidate(
  box: WorldsCollisionBox,
  delta: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
  skin: number,
): { fraction: number; normal: WorldsSurfaceVector3Like } | null {
  const distance = signedDistanceToWorldCollisionSurfacePlane(box.transform.position, surface)
  const planeVelocity = dot(delta, surface.normal)
  const radius = projectedObbRadius(box, surface.normal)
  const limit = radius + skin

  if (surface.sidedness === 'front') {
    if (planeVelocity >= -EPSILON) return null
    if (distance > limit + EPSILON) {
      const fraction = (distance - limit) / -planeVelocity
      return isFractionInRange(fraction) ? { fraction, normal: surface.normal } : null
    }
    if (Math.abs(distance - limit) <= skin) return { fraction: 0, normal: surface.normal }
    return null
  }

  if (planeVelocity < -EPSILON) {
    if (distance > limit + EPSILON) {
      const fraction = (distance - limit) / -planeVelocity
      return isFractionInRange(fraction) ? { fraction, normal: surface.normal } : null
    }
    if (Math.abs(distance - limit) <= skin) return { fraction: 0, normal: surface.normal }
  }

  if (planeVelocity > EPSILON) {
    if (distance < -(limit + EPSILON)) {
      const fraction = (-limit - distance) / planeVelocity
      return isFractionInRange(fraction) ? { fraction, normal: negateVector(surface.normal) } : null
    }
    if (Math.abs(distance + limit) <= skin) return { fraction: 0, normal: negateVector(surface.normal) }
  }

  return null
}

function projectedObbRadius(box: WorldsCollisionBox, axis: WorldsSurfaceVector3Like): number {
  return (
    box.halfExtents.x * Math.abs(dot(axis, box.transform.axes[0]))
    + box.halfExtents.y * Math.abs(dot(axis, box.transform.axes[1]))
    + box.halfExtents.z * Math.abs(dot(axis, box.transform.axes[2]))
  )
}

function buildPlacementObbs(
  items: readonly NormalizedPlacementItem[],
  key: 'startTransform' | 'desiredTransform',
): PlacementObb[] | null {
  const obbs: PlacementObb[] = []
  for (const item of items) {
    const obb = buildPlacementObb(item.id, item.localBounds, item[key])
    if (!obb) return null
    obbs.push(obb)
  }
  return obbs
}

function buildPlacementObbsFromTransforms(
  items: readonly NormalizedPlacementItem[],
  transforms: readonly WorldsSurfacePlacementResolvedTransform[],
): PlacementObb[] | null {
  const transformsById = new Map(transforms.map((entry) => [entry.id, entry.transform]))
  const obbs: PlacementObb[] = []
  for (const item of items) {
    const transform = transformsById.get(item.id)
    if (!transform) return null
    const obb = buildPlacementObb(item.id, item.localBounds, transform)
    if (!obb) return null
    obbs.push(obb)
  }
  return obbs
}

function buildPlacementObb(
  itemId: string,
  localBounds: WorldsCollisionBounds,
  transform: WorldsSurfacePlacementTransform,
): PlacementObb | null {
  const collisionBox = buildWorldCollisionBoxFromLocalBounds(itemId, localBounds, toEulerTransform(transform))
  if (!collisionBox) return null
  const worldCorners = getObbWorldCorners(collisionBox)
  return {
    itemId,
    transform: cloneTransform(transform),
    collisionBox,
    worldCorners,
  }
}

function getObbWorldCorners(box: WorldsCollisionBox): WorldsSurfaceVector3Like[] {
  const corners: WorldsSurfaceVector3Like[] = []
  for (const sx of [-1, 1] as const) {
    for (const sy of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        corners.push(addVectors(
          box.transform.position,
          addVectors(
            scaleVector(box.transform.axes[0], sx * box.halfExtents.x),
            addVectors(
              scaleVector(box.transform.axes[1], sy * box.halfExtents.y),
              scaleVector(box.transform.axes[2], sz * box.halfExtents.z),
            ),
          ),
        ))
      }
    }
  }
  return corners
}

function getSurfacePolygon(surface: WorldsResolvedCollisionSurface): [number, number][] {
  if (surface.shape === 'rect') {
    return [
      [-surface.localRect.halfWidth, -surface.localRect.halfHeight],
      [-surface.localRect.halfWidth, surface.localRect.halfHeight],
      [surface.localRect.halfWidth, surface.localRect.halfHeight],
      [surface.localRect.halfWidth, -surface.localRect.halfHeight],
    ]
  }
  return surface.localTriangle.vertices.map((vertex) => [vertex[0], vertex[1]])
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
    if (length <= EPSILON) continue
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

function normalizePlacementItems(
  items: readonly WorldsSurfacePlacementItemDescriptor[],
  desiredTransforms: readonly WorldsSurfacePlacementItemTransformUpdate[],
): NormalizedPlacementItem[] | null {
  const sortedItems = [...items].sort((left, right) => left.id.localeCompare(right.id))
  const desiredById = new Map(desiredTransforms.map((entry) => [entry.id, entry.transform]))
  if (sortedItems.length === 0) return []

  const normalized: NormalizedPlacementItem[] = []
  for (const item of sortedItems) {
    const desiredTransform = desiredById.get(item.id)
    if (!desiredTransform || !isFiniteBounds(item.localBounds) || !isFiniteTransform(item.startTransform) || !isFiniteTransform(desiredTransform)) {
      return null
    }
    normalized.push({
      id: item.id,
      localBounds: cloneBounds(item.localBounds!),
      startTransform: cloneTransform(item.startTransform),
      desiredTransform: cloneTransform(desiredTransform),
    })
  }

  if (desiredById.size !== normalized.length) return null
  return normalized
}

function normalizeSurfaces(surfaces: readonly WorldsResolvedCollisionSurface[]): WorldsResolvedCollisionSurface[] {
  return [...surfaces].sort((left, right) => left.id.localeCompare(right.id))
}

function getCommonTranslationDelta(items: readonly NormalizedPlacementItem[]): WorldsSurfaceVector3Like | null {
  let common: WorldsSurfaceVector3Like | null = null
  for (const item of items) {
    if (!tuplesClose(item.startTransform.rotation, item.desiredTransform.rotation)) return null
    if (!tuplesClose(item.startTransform.scale, item.desiredTransform.scale)) return null
    const delta = subtractVectors(tupleToVector(item.desiredTransform.position), tupleToVector(item.startTransform.position))
    if (!common) {
      common = delta
      continue
    }
    if (!vectorsClose(common, delta)) return null
  }
  return common ?? zeroVector()
}

function applyCommonDelta(
  items: readonly NormalizedPlacementItem[],
  delta: WorldsSurfaceVector3Like,
): WorldsSurfacePlacementResolvedTransform[] {
  return items.map((item) => ({
    id: item.id,
    transform: {
      position: [
        item.startTransform.position[0] + delta.x,
        item.startTransform.position[1] + delta.y,
        item.startTransform.position[2] + delta.z,
      ],
      rotation: [...item.startTransform.rotation],
      scale: [...item.startTransform.scale],
    },
  }))
}

function applyDeltaToResolvedTransforms(
  transforms: readonly WorldsSurfacePlacementResolvedTransform[],
  delta: WorldsSurfaceVector3Like,
): WorldsSurfacePlacementResolvedTransform[] {
  return transforms.map((entry) => ({
    id: entry.id,
    transform: {
      position: [
        entry.transform.position[0] + delta.x,
        entry.transform.position[1] + delta.y,
        entry.transform.position[2] + delta.z,
      ],
      rotation: [...entry.transform.rotation],
      scale: [...entry.transform.scale],
    },
  }))
}

function offsetPlacementObbs(obbs: readonly PlacementObb[], delta: WorldsSurfaceVector3Like): PlacementObb[] {
  return obbs.map((obb) => offsetPlacementObb(obb, delta))
}

function offsetPlacementObb(obb: PlacementObb, delta: WorldsSurfaceVector3Like): PlacementObb {
  return {
    itemId: obb.itemId,
    transform: {
      position: [
        obb.transform.position[0] + delta.x,
        obb.transform.position[1] + delta.y,
        obb.transform.position[2] + delta.z,
      ],
      rotation: [...obb.transform.rotation],
      scale: [...obb.transform.scale],
    },
    collisionBox: {
      zoneId: obb.collisionBox.zoneId,
      halfExtents: { ...obb.collisionBox.halfExtents },
      transform: {
        position: addVectors(obb.collisionBox.transform.position, delta),
        axes: obb.collisionBox.transform.axes,
      },
      worldAabb: {
        min: addVectors(obb.collisionBox.worldAabb.min, delta),
        max: addVectors(obb.collisionBox.worldAabb.max, delta),
      },
    },
    worldCorners: obb.worldCorners.map((corner) => addVectors(corner, delta)),
  }
}

function invalidCandidateResult(items: readonly NormalizedPlacementItem[]): WorldsSurfacePlacementResult {
  return {
    resolvedTransforms: items.map((item) => ({ id: item.id, transform: cloneTransform(item.startTransform) })),
    valid: false,
    acceptedTranslationDelta: null,
    blockedSurfaceIds: [],
    snappedSurfaceId: null,
    snappedSurfaceNormal: null,
    snappedSurfacePoint: null,
    reason: 'invalid-candidate',
  }
}

function buildFallbackTransforms(
  items: readonly WorldsSurfacePlacementItemDescriptor[],
  desiredTransforms: readonly WorldsSurfacePlacementItemTransformUpdate[],
): WorldsSurfacePlacementResolvedTransform[] {
  const desiredById = new Map(desiredTransforms.map((entry) => [entry.id, entry.transform]))
  return [...items]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      id: item.id,
      transform: cloneTransform(desiredById.get(item.id) ?? item.startTransform),
    }))
}

function compareSnapCandidate(left: SnapCandidate, right: SnapCandidate): number {
  if (Math.abs(left.correctionMagnitude - right.correctionMagnitude) > EPSILON) {
    return left.correctionMagnitude - right.correctionMagnitude
  }
  if (left.surface.id !== right.surface.id) return left.surface.id.localeCompare(right.surface.id)
  if (left.itemId !== right.itemId) return left.itemId.localeCompare(right.itemId)
  return vectorLength(left.translation) - vectorLength(right.translation)
}

function cloneTransform(transform: WorldsSurfacePlacementTransform): WorldsSurfacePlacementTransform {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
}

function cloneBounds(bounds: WorldsCollisionBounds): WorldsCollisionBounds {
  return {
    min: { ...bounds.min },
    max: { ...bounds.max },
  }
}

function expandAabb(aabb: WorldsSurfaceAabb, extra: number): WorldsSurfaceAabb {
  return {
    min: { x: aabb.min.x - extra, y: aabb.min.y - extra, z: aabb.min.z - extra },
    max: { x: aabb.max.x + extra, y: aabb.max.y + extra, z: aabb.max.z + extra },
  }
}

function toEulerTransform(transform: WorldsSurfacePlacementTransform): WorldsCollisionEulerTransformInput {
  return {
    position: tupleToVector(transform.position),
    rotation: tupleToVector(transform.rotation),
    scale: tupleToVector(transform.scale),
  }
}

function tupleToVector([x, y, z]: [number, number, number]): WorldsSurfaceVector3Like {
  return { x, y, z }
}

function vectorToTuple(vector: WorldsSurfaceVector3Like): [number, number, number] {
  return [vector.x, vector.y, vector.z]
}

function normalizedTuple(vector: WorldsSurfaceVector3Like): [number, number, number] {
  return [normalizeSignedZero(vector.x), normalizeSignedZero(vector.y), normalizeSignedZero(vector.z)]
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

function zeroVector(): WorldsSurfaceVector3Like {
  return { x: 0, y: 0, z: 0 }
}

function dot(left: WorldsSurfaceVector3Like, right: WorldsSurfaceVector3Like): number {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isFractionInRange(value: number): boolean {
  return value >= -EPSILON && value <= 1 + EPSILON
}

function vectorsClose(left: WorldsSurfaceVector3Like, right: WorldsSurfaceVector3Like): boolean {
  return (
    Math.abs(left.x - right.x) <= 1e-6
    && Math.abs(left.y - right.y) <= 1e-6
    && Math.abs(left.z - right.z) <= 1e-6
  )
}

function tuplesClose(left: [number, number, number], right: [number, number, number]): boolean {
  return (
    Math.abs(left[0] - right[0]) <= 1e-6
    && Math.abs(left[1] - right[1]) <= 1e-6
    && Math.abs(left[2] - right[2]) <= 1e-6
  )
}

function isNearZeroVector(vector: WorldsSurfaceVector3Like): boolean {
  return Math.hypot(vector.x, vector.y, vector.z) <= EPSILON
}

function vectorLength(vector: WorldsSurfaceVector3Like): number {
  return Math.hypot(vector.x, vector.y, vector.z)
}

function isFiniteBounds(bounds: WorldsCollisionBounds | null | undefined): bounds is WorldsCollisionBounds {
  return !!bounds
    && isFiniteVector(bounds.min)
    && isFiniteVector(bounds.max)
    && bounds.min.x < bounds.max.x
    && bounds.min.y < bounds.max.y
    && bounds.min.z < bounds.max.z
}

function isFiniteTransform(transform: WorldsSurfacePlacementTransform): boolean {
  return isFiniteTuple(transform.position) && isFiniteTuple(transform.rotation) && isFiniteTuple(transform.scale)
    && transform.scale[0] > 0
    && transform.scale[1] > 0
    && transform.scale[2] > 0
}

function isFiniteTuple(tuple: [number, number, number]): boolean {
  return Number.isFinite(tuple[0]) && Number.isFinite(tuple[1]) && Number.isFinite(tuple[2])
}

function isFiniteVector(vector: WorldsSurfaceVector3Like): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z)
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return value
}

function normalizeSignedZero(value: number): number {
  return Math.abs(value) <= 1e-12 ? 0 : value
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

export function getWorldsSurfacePlacementSnapPoint(
  point: WorldsSurfaceVector3Like,
  surface: WorldsResolvedCollisionSurface,
): [number, number, number] {
  return vectorToTuple(closestPointOnWorldCollisionSurface(point, surface))
}
