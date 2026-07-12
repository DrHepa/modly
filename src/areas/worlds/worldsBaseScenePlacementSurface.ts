import {
  buildWorldCollisionBoxFromLocalBounds,
  type WorldsCollisionBounds,
} from './worldsCollisionMath.ts'
import type {
  WorldsResolvedCollisionSurface,
  WorldsSurfaceVector3Like,
} from './worldsSurfaceMath.ts'
import type {
  WorldsSurfacePlacementItemDescriptor,
  WorldsSurfacePlacementItemTransformUpdate,
  WorldsSurfacePlacementResolvedTransform,
  WorldsSurfacePlacementTransform,
} from './worldsSurfacePlacement.ts'

export type WorldsPlacementSurfaceSource = 'base-scene' | 'authored-surface'
export type WorldsPlacementSurfacePolygon =
  | [[number, number, number], [number, number, number], [number, number, number]]
  | [[number, number, number], [number, number, number], [number, number, number], [number, number, number]]

export interface WorldsPlacementSurfaceHit {
  source: WorldsPlacementSurfaceSource
  sourceId: string
  point: [number, number, number]
  normal: [number, number, number]
  distance: number
  polygon: WorldsPlacementSurfacePolygon
  tangentU?: [number, number, number]
  tangentV?: [number, number, number]
}

export type WorldsPlacementSurfaceSupportReason =
  | 'aligned'
  | 'invalid-hit'
  | 'invalid-candidate'
  | 'underside-surface'
  | 'vertical-surface'
  | 'max-correction-exceeded'

export interface ResolveWorldsPlacementSurfaceSupportInput {
  placementHit: WorldsPlacementSurfaceHit | null | undefined
  items: readonly WorldsSurfacePlacementItemDescriptor[]
  desiredTransforms: readonly WorldsSurfacePlacementItemTransformUpdate[]
  options?: WorldsPlacementSurfaceSupportOptions
}

export interface WorldsPlacementSurfaceSupportOptions {
  skin?: number
  maxCorrection?: number
  allowWalls?: boolean
  minimumUpComponent?: number
}

export interface WorldsPlacementSurfaceSupportResult {
  resolvedTransforms: WorldsSurfacePlacementResolvedTransform[]
  correctionDelta: [number, number, number]
  correctionDistance: number
  supportPoint: [number, number, number] | null
  supportNormal: [number, number, number] | null
  valid: boolean
  reason: WorldsPlacementSurfaceSupportReason
}

interface NormalizedPlacementItem {
  id: string
  localBounds: WorldsCollisionBounds
  desiredTransform: WorldsSurfacePlacementTransform
}

const DEFAULT_SKIN = 1e-4
const DEFAULT_MIN_UP_COMPONENT = 0.5
const EPSILON = 1e-8

export function createWorldsPlacementSurfaceHitFromAuthoredSurface(
  surface: WorldsResolvedCollisionSurface,
  point: [number, number, number],
  options: { distance?: number } = {},
): WorldsPlacementSurfaceHit | null {
  if (!isFiniteTuple(point)) return null
  if (!isFiniteVector(surface.origin) || !isFiniteVector(surface.normal)) return null

  const normal = normalizeVector(tupleToVector(surface.normal ? [surface.normal.x, surface.normal.y, surface.normal.z] : [0, 0, 0]))
  if (!normal) return null

  const polygon = surface.shape === 'rect'
    ? surface.worldCorners.map(vectorToTuple) as WorldsPlacementSurfacePolygon
    : surface.worldVertices.map(vectorToTuple) as WorldsPlacementSurfacePolygon
  const tangentU = normalizeVector(surface.tangentU)
  const tangentV = normalizeVector(surface.tangentV)

  return {
    source: 'authored-surface',
    sourceId: surface.id,
    point: [...point],
    normal: vectorToTuple(normal),
    distance: Number.isFinite(options.distance) && options.distance! >= 0 ? options.distance! : 0,
    polygon,
    ...(tangentU ? { tangentU: vectorToTuple(tangentU) } : {}),
    ...(tangentV ? { tangentV: vectorToTuple(tangentV) } : {}),
  }
}

export function deriveWorldsPlacementSurfaceTangents(
  hit: Pick<WorldsPlacementSurfaceHit, 'polygon' | 'normal' | 'tangentU' | 'tangentV'>,
): {
  tangentU: [number, number, number] | null
  tangentV: [number, number, number] | null
} {
  const directU = hit.tangentU && isFiniteTuple(hit.tangentU) ? normalizeVector(tupleToVector(hit.tangentU)) : null
  const directV = hit.tangentV && isFiniteTuple(hit.tangentV) ? normalizeVector(tupleToVector(hit.tangentV)) : null
  if (directU && directV) {
    return { tangentU: vectorToTuple(directU), tangentV: vectorToTuple(directV) }
  }

  const normal = normalizeVector(tupleToVector(hit.normal))
  if (!normal) return { tangentU: null, tangentV: null }
  const derived = deriveTangentsFromPolygon(hit.polygon, normal)
  if (!derived) return { tangentU: directU ? vectorToTuple(directU) : null, tangentV: directV ? vectorToTuple(directV) : null }
  return derived
}

export function resolveWorldsPlacementSurfaceSupport({
  placementHit,
  items,
  desiredTransforms,
  options = {},
}: ResolveWorldsPlacementSurfaceSupportInput): WorldsPlacementSurfaceSupportResult {
  const normalized = normalizePlacementItems(items, desiredTransforms)
  if (!normalized) {
    return {
      resolvedTransforms: buildFallbackTransforms(items, desiredTransforms),
      correctionDelta: [0, 0, 0],
      correctionDistance: 0,
      supportPoint: null,
      supportNormal: null,
      valid: false,
      reason: 'invalid-candidate',
    }
  }

  const hit = normalizePlacementHit(placementHit)
  if (!hit) {
    return {
      resolvedTransforms: normalized.map((item) => ({ id: item.id, transform: cloneTransform(item.desiredTransform) })),
      correctionDelta: [0, 0, 0],
      correctionDistance: 0,
      supportPoint: null,
      supportNormal: null,
      valid: false,
      reason: 'invalid-hit',
    }
  }

  const minimumUpComponent = clamp(Math.abs(normalizeFiniteNumber(options.minimumUpComponent, DEFAULT_MIN_UP_COMPONENT)), 0, 1)
  if (hit.normal.y < -EPSILON) {
    return invalidSupportResult(normalized, hit, 'underside-surface')
  }
  if (options.allowWalls !== true && hit.normal.y < minimumUpComponent - EPSILON) {
    return invalidSupportResult(normalized, hit, 'vertical-surface')
  }

  const skin = normalizeFiniteNumber(options.skin, DEFAULT_SKIN)
  let lowestDistance = Number.POSITIVE_INFINITY

  for (const item of normalized) {
    const collisionBox = buildWorldCollisionBoxFromLocalBounds(item.id, item.localBounds, toEulerTransform(item.desiredTransform))
    if (!collisionBox) {
      return {
        resolvedTransforms: normalized.map((entry) => ({ id: entry.id, transform: cloneTransform(entry.desiredTransform) })),
        correctionDelta: [0, 0, 0],
        correctionDistance: 0,
        supportPoint: vectorToTuple(hit.point),
        supportNormal: vectorToTuple(hit.normal),
        valid: false,
        reason: 'invalid-candidate',
      }
    }

    const centerDistance = dot(subtractVectors(collisionBox.transform.position, hit.point), hit.normal)
    const supportRadius = projectedRadius(collisionBox.halfExtents, collisionBox.transform.axes, hit.normal)
    lowestDistance = Math.min(lowestDistance, centerDistance - supportRadius)
  }

  if (!Number.isFinite(lowestDistance)) {
    return invalidSupportResult(normalized, hit, 'invalid-candidate')
  }

  const correctionDistance = skin - lowestDistance
  const maxCorrection = options.maxCorrection
  if (Number.isFinite(maxCorrection) && Math.abs(correctionDistance) > Math.abs(maxCorrection!) + EPSILON) {
    return {
      resolvedTransforms: normalized.map((item) => ({ id: item.id, transform: cloneTransform(item.desiredTransform) })),
      correctionDelta: [0, 0, 0],
      correctionDistance,
      supportPoint: vectorToTuple(hit.point),
      supportNormal: vectorToTuple(hit.normal),
      valid: false,
      reason: 'max-correction-exceeded',
    }
  }

  const correctionDelta = scaleVector(hit.normal, Math.abs(correctionDistance) <= EPSILON ? 0 : correctionDistance)
  return {
    resolvedTransforms: normalized.map((item) => ({
      id: item.id,
      transform: {
        position: vectorToTuple(addVectors(tupleToVector(item.desiredTransform.position), correctionDelta)),
        rotation: [...item.desiredTransform.rotation],
        scale: [...item.desiredTransform.scale],
      },
    })),
    correctionDelta: vectorToTuple(correctionDelta),
    correctionDistance,
    supportPoint: vectorToTuple(hit.point),
    supportNormal: vectorToTuple(hit.normal),
    valid: true,
    reason: 'aligned',
  }
}

function normalizePlacementItems(
  items: readonly WorldsSurfacePlacementItemDescriptor[],
  desiredTransforms: readonly WorldsSurfacePlacementItemTransformUpdate[],
): NormalizedPlacementItem[] | null {
  if (items.length === 0 || items.length !== desiredTransforms.length) return null
  const desiredById = new Map(desiredTransforms.map((entry) => [entry.id, entry.transform]))
  const normalized: NormalizedPlacementItem[] = []

  for (const item of items) {
    if (!isFiniteBounds(item.localBounds)) return null
    const desiredTransform = desiredById.get(item.id)
    if (!desiredTransform || !isFiniteTransform(desiredTransform)) return null
    normalized.push({
      id: item.id,
      localBounds: cloneBounds(item.localBounds),
      desiredTransform: cloneTransform(desiredTransform),
    })
  }

  if (normalized.length !== desiredTransforms.length) return null
  return normalized.sort((left, right) => left.id.localeCompare(right.id))
}

function buildFallbackTransforms(
  items: readonly WorldsSurfacePlacementItemDescriptor[],
  desiredTransforms: readonly WorldsSurfacePlacementItemTransformUpdate[],
): WorldsSurfacePlacementResolvedTransform[] {
  const desiredById = new Map(desiredTransforms.map((entry) => [entry.id, entry.transform]))
  return items.map((item) => ({
    id: item.id,
    transform: cloneTransform(desiredById.get(item.id) ?? item.startTransform),
  })).sort((left, right) => left.id.localeCompare(right.id))
}

function invalidSupportResult(
  items: readonly NormalizedPlacementItem[],
  hit: { point: WorldsSurfaceVector3Like; normal: WorldsSurfaceVector3Like },
  reason: Exclude<WorldsPlacementSurfaceSupportReason, 'aligned' | 'invalid-hit' | 'max-correction-exceeded'>,
): WorldsPlacementSurfaceSupportResult {
  return {
    resolvedTransforms: items.map((item) => ({ id: item.id, transform: cloneTransform(item.desiredTransform) })),
    correctionDelta: [0, 0, 0],
    correctionDistance: 0,
    supportPoint: vectorToTuple(hit.point),
    supportNormal: vectorToTuple(hit.normal),
    valid: false,
    reason,
  }
}

function normalizePlacementHit(
  placementHit: WorldsPlacementSurfaceHit | null | undefined,
): { point: WorldsSurfaceVector3Like; normal: WorldsSurfaceVector3Like } | null {
  if (!placementHit) return null
  if (typeof placementHit.sourceId !== 'string' || placementHit.sourceId.length === 0) return null
  if (!Number.isFinite(placementHit.distance) || placementHit.distance < 0) return null
  if (!isFiniteTuple(placementHit.point) || !isFiniteTuple(placementHit.normal)) return null
  const point = tupleToVector(placementHit.point)
  const normal = normalizeVector(tupleToVector(placementHit.normal))
  if (!normal) return null
  if (!isValidPolygon(placementHit.polygon)) return null
  return { point, normal }
}

function deriveTangentsFromPolygon(
  polygon: WorldsPlacementSurfacePolygon,
  normal: WorldsSurfaceVector3Like,
): { tangentU: [number, number, number]; tangentV: [number, number, number] } | null {
  const a = tupleToVector(polygon[0])
  for (let index = 1; index < polygon.length; index += 1) {
    const edge = normalizeVector(subtractVectors(tupleToVector(polygon[index]!), a))
    if (!edge) continue
    const tangentV = normalizeVector(cross(normal, edge))
    if (!tangentV) continue
    const tangentU = normalizeVector(cross(tangentV, normal))
    if (!tangentU) continue
    return { tangentU: vectorToTuple(tangentU), tangentV: vectorToTuple(tangentV) }
  }
  return null
}

function projectedRadius(
  halfExtents: WorldsSurfaceVector3Like,
  axes: readonly [WorldsSurfaceVector3Like, WorldsSurfaceVector3Like, WorldsSurfaceVector3Like],
  normal: WorldsSurfaceVector3Like,
): number {
  return (
    halfExtents.x * Math.abs(dot(axes[0], normal))
    + halfExtents.y * Math.abs(dot(axes[1], normal))
    + halfExtents.z * Math.abs(dot(axes[2], normal))
  )
}

function toEulerTransform(transform: WorldsSurfacePlacementTransform) {
  return {
    position: tupleToVector(transform.position),
    rotation: tupleToVector(transform.rotation),
    scale: tupleToVector(transform.scale),
  }
}

function cloneBounds(bounds: WorldsCollisionBounds): WorldsCollisionBounds {
  return {
    min: { ...bounds.min },
    max: { ...bounds.max },
  }
}

function cloneTransform(transform: WorldsSurfacePlacementTransform): WorldsSurfacePlacementTransform {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
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
  return isFiniteTuple(transform.position)
    && isFiniteTuple(transform.rotation)
    && isFiniteTuple(transform.scale)
    && transform.scale[0] > 0
    && transform.scale[1] > 0
    && transform.scale[2] > 0
}

function isValidPolygon(polygon: WorldsPlacementSurfacePolygon): boolean {
  return (polygon.length === 3 || polygon.length === 4) && polygon.every((point) => isFiniteTuple(point))
}

function isFiniteVector(vector: WorldsSurfaceVector3Like): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z)
}

function isFiniteTuple(tuple: [number, number, number]): boolean {
  return Number.isFinite(tuple[0]) && Number.isFinite(tuple[1]) && Number.isFinite(tuple[2])
}

function tupleToVector([x, y, z]: [number, number, number]): WorldsSurfaceVector3Like {
  return { x, y, z }
}

function vectorToTuple(vector: WorldsSurfaceVector3Like): [number, number, number] {
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

function dot(left: WorldsSurfaceVector3Like, right: WorldsSurfaceVector3Like): number {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

function cross(left: WorldsSurfaceVector3Like, right: WorldsSurfaceVector3Like): WorldsSurfaceVector3Like {
  return {
    x: (left.y * right.z) - (left.z * right.y),
    y: (left.z * right.x) - (left.x * right.z),
    z: (left.x * right.y) - (left.y * right.x),
  }
}

function normalizeVector(vector: WorldsSurfaceVector3Like): WorldsSurfaceVector3Like | null {
  const length = Math.hypot(vector.x, vector.y, vector.z)
  if (!Number.isFinite(length) || length <= EPSILON) return null
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length }
}

function normalizeFiniteNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeSignedZero(value: number): number {
  return Math.abs(value) <= 1e-12 ? 0 : value
}
