import type { WorldCollisionZone } from './worldsCollisionZones.ts'

export interface WorldsCollisionVector3Like {
  x: number
  y: number
  z: number
}

export interface WorldsCollisionAabb {
  min: WorldsCollisionVector3Like
  max: WorldsCollisionVector3Like
}

export interface WorldsCollisionBounds {
  min: WorldsCollisionVector3Like
  max: WorldsCollisionVector3Like
}

export interface WorldsCollisionProbe {
  position: WorldsCollisionVector3Like
  halfExtents: WorldsCollisionVector3Like
}

export interface WorldsCollisionTransform {
  position: WorldsCollisionVector3Like
  axes: readonly [WorldsCollisionVector3Like, WorldsCollisionVector3Like, WorldsCollisionVector3Like]
}

export interface WorldsCollisionEulerTransformInput {
  position: WorldsCollisionVector3Like
  rotation: WorldsCollisionVector3Like
  scale: WorldsCollisionVector3Like
}

export interface WorldsCollisionBox {
  zoneId: string
  halfExtents: WorldsCollisionVector3Like
  transform: WorldsCollisionTransform
  worldAabb: WorldsCollisionAabb
}

export interface WorldsCollisionDepenetrationResult {
  position: WorldsCollisionVector3Like
  intersectingZoneIds: string[]
  iterations: number
  resolved: boolean
}

export interface WorldsCollisionResolutionResult {
  position: WorldsCollisionVector3Like
  appliedDelta: WorldsCollisionVector3Like
  collidedZoneIds: string[]
  depenetration: WorldsCollisionDepenetrationResult
}

export interface ResolveWorldCollisionProbeTranslationInput {
  position: WorldsCollisionVector3Like
  delta: WorldsCollisionVector3Like
  probeHalfExtents: WorldsCollisionVector3Like
  collisionBoxes: readonly WorldsCollisionBox[]
  skinEpsilon?: number
  maxDepenetrationIterations?: number
  maxSubstepDistance?: number
}

const WORLD_AXES = [
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 },
] as const satisfies readonly [WorldsCollisionVector3Like, WorldsCollisionVector3Like, WorldsCollisionVector3Like]

const ZERO_VECTOR: WorldsCollisionVector3Like = { x: 0, y: 0, z: 0 }
const DEFAULT_SKIN_EPSILON = 1e-4
const DEFAULT_DEPENETRATION_ITERATIONS = 8
const DEFAULT_SUBSTEP_DISTANCE = 0.25
const SWEEP_BINARY_SEARCH_STEPS = 12
const SAT_EPSILON = 1e-8

export function buildWorldCollisionBoxes(zones: readonly WorldCollisionZone[]): WorldsCollisionBox[] {
  const boxes: WorldsCollisionBox[] = []

  for (const zone of zones) {
    const box = buildWorldCollisionBox(zone)
    if (box) boxes.push(box)
  }

  return boxes.sort((left, right) => left.zoneId.localeCompare(right.zoneId))
}

export function buildWorldCollisionBox(zone: WorldCollisionZone): WorldsCollisionBox | null {
  if (zone.shape !== 'box') return null
  return buildWorldCollisionBoxFromLocalBounds(zone.id, {
    min: { x: -0.5, y: -0.5, z: -0.5 },
    max: { x: 0.5, y: 0.5, z: 0.5 },
  }, {
    position: vectorFromTuple(zone.transform.position),
    rotation: vectorFromTuple(zone.transform.rotation),
    scale: vectorFromTuple(zone.transform.scale),
  })
}

export function buildWorldCollisionBoxFromLocalBounds(
  zoneId: string,
  localBounds: WorldsCollisionBounds,
  transform: WorldsCollisionEulerTransformInput,
): WorldsCollisionBox | null {
  if (typeof zoneId !== 'string' || zoneId.trim().length === 0) return null
  if (!isFiniteBounds(localBounds)) return null
  if (!isFiniteVector(transform.position)) return null
  if (!isFiniteVector(transform.rotation)) return null
  if (!isFiniteVector(transform.scale)) return null

  const scaledMin = {
    x: localBounds.min.x * Math.abs(transform.scale.x),
    y: localBounds.min.y * Math.abs(transform.scale.y),
    z: localBounds.min.z * Math.abs(transform.scale.z),
  }
  const scaledMax = {
    x: localBounds.max.x * Math.abs(transform.scale.x),
    y: localBounds.max.y * Math.abs(transform.scale.y),
    z: localBounds.max.z * Math.abs(transform.scale.z),
  }
  const halfExtents = {
    x: (scaledMax.x - scaledMin.x) * 0.5,
    y: (scaledMax.y - scaledMin.y) * 0.5,
    z: (scaledMax.z - scaledMin.z) * 0.5,
  }
  if (halfExtents.x <= 0 || halfExtents.y <= 0 || halfExtents.z <= 0) return null

  const localCenter = {
    x: (scaledMin.x + scaledMax.x) * 0.5,
    y: (scaledMin.y + scaledMax.y) * 0.5,
    z: (scaledMin.z + scaledMax.z) * 0.5,
  }
  const axes = rotationAxesFromEulerXYZ(transform.rotation.x, transform.rotation.y, transform.rotation.z)
  const position = addVectors(
    copyVector(transform.position),
    addVectors(
      scaleVector(axes[0], localCenter.x),
      addVectors(scaleVector(axes[1], localCenter.y), scaleVector(axes[2], localCenter.z)),
    ),
  )
  const worldExtents = worldAabbExtentsForObb(axes, halfExtents)

  return {
    zoneId,
    halfExtents,
    transform: { position, axes },
    worldAabb: {
      min: {
        x: position.x - worldExtents.x,
        y: position.y - worldExtents.y,
        z: position.z - worldExtents.z,
      },
      max: {
        x: position.x + worldExtents.x,
        y: position.y + worldExtents.y,
        z: position.z + worldExtents.z,
      },
    },
  }
}

export function createWorldCollisionProbe(
  position: WorldsCollisionVector3Like,
  halfExtents: WorldsCollisionVector3Like,
): WorldsCollisionProbe {
  return {
    position: copyVector(position),
    halfExtents: {
      x: Math.abs(halfExtents.x),
      y: Math.abs(halfExtents.y),
      z: Math.abs(halfExtents.z),
    },
  }
}

export function getWorldCollisionProbeAabb(probe: WorldsCollisionProbe): WorldsCollisionAabb {
  return {
    min: {
      x: probe.position.x - probe.halfExtents.x,
      y: probe.position.y - probe.halfExtents.y,
      z: probe.position.z - probe.halfExtents.z,
    },
    max: {
      x: probe.position.x + probe.halfExtents.x,
      y: probe.position.y + probe.halfExtents.y,
      z: probe.position.z + probe.halfExtents.z,
    },
  }
}

export function intersectsWorldCollisionBox(probe: WorldsCollisionProbe, box: WorldsCollisionBox): boolean {
  if (!aabbsIntersect(getWorldCollisionProbeAabb(probe), box.worldAabb)) return false
  return testObbIntersection(probeAsObb(probe), collisionBoxAsObb(box)).intersects
}

export function intersectsWorldCollisionBoxes(left: WorldsCollisionBox, right: WorldsCollisionBox): boolean {
  if (!aabbsIntersect(left.worldAabb, right.worldAabb)) return false
  return testObbIntersection(collisionBoxAsObb(left), collisionBoxAsObb(right)).intersects
}

export function findWorldCollisionIntersections(
  probe: WorldsCollisionProbe,
  collisionBoxes: readonly WorldsCollisionBox[],
): WorldsCollisionBox[] {
  const probeAabb = getWorldCollisionProbeAabb(probe)
  const intersections: WorldsCollisionBox[] = []

  for (const collisionBox of collisionBoxes) {
    if (!aabbsIntersect(probeAabb, collisionBox.worldAabb)) continue
    if (testObbIntersection(probeAsObb(probe), collisionBoxAsObb(collisionBox)).intersects) {
      intersections.push(collisionBox)
    }
  }

  return intersections.sort((left, right) => left.zoneId.localeCompare(right.zoneId))
}

export function depenetrateWorldCollisionProbe(
  probe: WorldsCollisionProbe,
  collisionBoxes: readonly WorldsCollisionBox[],
  options: {
    skinEpsilon?: number
    maxIterations?: number
  } = {},
): WorldsCollisionDepenetrationResult {
  const skinEpsilon = normalizePositiveNumber(options.skinEpsilon, DEFAULT_SKIN_EPSILON)
  const maxIterations = Math.max(1, Math.floor(normalizePositiveNumber(options.maxIterations, DEFAULT_DEPENETRATION_ITERATIONS)))
  const position = copyVector(probe.position)
  let iterations = 0

  for (; iterations < maxIterations; iterations += 1) {
    const currentProbe = createWorldCollisionProbe(position, probe.halfExtents)
    const intersections = findWorldCollisionIntersections(currentProbe, collisionBoxes)
    if (intersections.length === 0) {
      return {
        position,
        intersectingZoneIds: [],
        iterations,
        resolved: true,
      }
    }

    let best: {
      overlap: number
      axisPriority: number
      zoneId: string
      offset: WorldsCollisionVector3Like
    } | null = null

    for (const collisionBox of intersections) {
      const penetration = getProbePenetrationOffset(currentProbe, collisionBox, skinEpsilon)
      if (!penetration) continue
      if (
        !best
        || penetration.overlap < best.overlap - SAT_EPSILON
        || (
          Math.abs(penetration.overlap - best.overlap) <= SAT_EPSILON
          && (collisionBox.zoneId < best.zoneId || (collisionBox.zoneId === best.zoneId && penetration.axisPriority < best.axisPriority))
        )
      ) {
        best = {
          overlap: penetration.overlap,
          axisPriority: penetration.axisPriority,
          zoneId: collisionBox.zoneId,
          offset: penetration.offset,
        }
      }
    }

    if (!best) break
    position.x += best.offset.x
    position.y += best.offset.y
    position.z += best.offset.z
  }

  const remaining = findWorldCollisionIntersections(createWorldCollisionProbe(position, probe.halfExtents), collisionBoxes)
  return {
    position,
    intersectingZoneIds: remaining.map((box) => box.zoneId),
    iterations,
    resolved: remaining.length === 0,
  }
}

export function resolveWorldCollisionProbeTranslation({
  position,
  delta,
  probeHalfExtents,
  collisionBoxes,
  skinEpsilon = DEFAULT_SKIN_EPSILON,
  maxDepenetrationIterations = DEFAULT_DEPENETRATION_ITERATIONS,
  maxSubstepDistance,
}: ResolveWorldCollisionProbeTranslationInput): WorldsCollisionResolutionResult {
  const probe = createWorldCollisionProbe(position, probeHalfExtents)
  const depenetration = depenetrateWorldCollisionProbe(probe, collisionBoxes, {
    skinEpsilon,
    maxIterations: maxDepenetrationIterations,
  })
  const currentPosition = copyVector(depenetration.position)
  const appliedDelta = { x: 0, y: 0, z: 0 }
  if (collisionBoxes.length === 0) {
    applyDelta(currentPosition, appliedDelta, delta)
    return {
      position: currentPosition,
      appliedDelta,
      collidedZoneIds: [],
      depenetration,
    }
  }
  if (isZeroVector(delta)) {
    return {
      position: currentPosition,
      appliedDelta,
      collidedZoneIds: [],
      depenetration,
    }
  }

  const stepDistance = normalizePositiveNumber(maxSubstepDistance, defaultSubstepDistanceForProbe(probeHalfExtents))
  const steps = Math.max(1, Math.ceil(maxAbsComponent(delta) / stepDistance))
  const collidedZoneIds = new Set<string>()

  for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
    const stepDelta = {
      x: delta.x / steps,
      y: delta.y / steps,
      z: delta.z / steps,
    }
    const stepFraction = sweepProbeFraction(currentPosition, stepDelta, probeHalfExtents, collisionBoxes)
    if (stepFraction >= 1) {
      applyDelta(currentPosition, appliedDelta, stepDelta)
      continue
    }

    if (stepFraction > 0) {
      const partial = scaleVector(stepDelta, stepFraction)
      applyDelta(currentPosition, appliedDelta, partial)
    }

    const blockedProbe = createWorldCollisionProbe(addVectors(currentPosition, stepDelta), probeHalfExtents)
    for (const collision of findWorldCollisionIntersections(blockedProbe, collisionBoxes)) {
      collidedZoneIds.add(collision.zoneId)
    }

    const remaining = scaleVector(stepDelta, 1 - stepFraction)
    for (const axis of ['x', 'y', 'z'] as const) {
      const axisDelta = { x: 0, y: 0, z: 0 }
      axisDelta[axis] = remaining[axis]
      if (axisDelta[axis] === 0) continue
      const axisFraction = sweepProbeFraction(currentPosition, axisDelta, probeHalfExtents, collisionBoxes)
      if (axisFraction <= 0) {
        const axisBlockedProbe = createWorldCollisionProbe(addVectors(currentPosition, axisDelta), probeHalfExtents)
        for (const collision of findWorldCollisionIntersections(axisBlockedProbe, collisionBoxes)) {
          collidedZoneIds.add(collision.zoneId)
        }
        continue
      }
      const allowedAxisDelta = scaleVector(axisDelta, axisFraction)
      applyDelta(currentPosition, appliedDelta, allowedAxisDelta)
    }
  }

  return {
    position: currentPosition,
    appliedDelta,
    collidedZoneIds: [...collidedZoneIds].sort(),
    depenetration,
  }
}

interface WorldsInternalObb {
  center: WorldsCollisionVector3Like
  halfExtents: WorldsCollisionVector3Like
  axes: readonly [WorldsCollisionVector3Like, WorldsCollisionVector3Like, WorldsCollisionVector3Like]
}

function collisionBoxAsObb(box: WorldsCollisionBox): WorldsInternalObb {
  return {
    center: box.transform.position,
    halfExtents: box.halfExtents,
    axes: box.transform.axes,
  }
}

function probeAsObb(probe: WorldsCollisionProbe): WorldsInternalObb {
  return {
    center: probe.position,
    halfExtents: probe.halfExtents,
    axes: WORLD_AXES,
  }
}

function getProbePenetrationOffset(
  probe: WorldsCollisionProbe,
  box: WorldsCollisionBox,
  skinEpsilon: number,
): { overlap: number; axisPriority: number; offset: WorldsCollisionVector3Like } | null {
  const probeObb = probeAsObb(probe)
  if (!testObbIntersection(probeObb, collisionBoxAsObb(box)).intersects) return null

  const centerDelta = subtractVectors(box.transform.position, probe.position)
  const candidates = [
    { axis: WORLD_AXES[0], priority: 0, overlap: overlapOnAxis(probeObb, box, WORLD_AXES[0]) },
    { axis: WORLD_AXES[1], priority: 1, overlap: overlapOnAxis(probeObb, box, WORLD_AXES[1]) },
    { axis: WORLD_AXES[2], priority: 2, overlap: overlapOnAxis(probeObb, box, WORLD_AXES[2]) },
    { axis: box.transform.axes[0], priority: 3, overlap: overlapOnAxis(probeObb, box, box.transform.axes[0]) },
    { axis: box.transform.axes[1], priority: 4, overlap: overlapOnAxis(probeObb, box, box.transform.axes[1]) },
    { axis: box.transform.axes[2], priority: 5, overlap: overlapOnAxis(probeObb, box, box.transform.axes[2]) },
  ]

  let best = candidates[0]
  for (const candidate of candidates.slice(1)) {
    if (
      candidate.overlap < best.overlap - SAT_EPSILON
      || (Math.abs(candidate.overlap - best.overlap) <= SAT_EPSILON && candidate.priority < best.priority)
    ) {
      best = candidate
    }
  }

  const direction = dot(centerDelta, best.axis) >= 0 ? -1 : 1
  return {
    overlap: best.overlap,
    axisPriority: best.priority,
    offset: scaleVector(best.axis, direction * (best.overlap + skinEpsilon)),
  }
}

function sweepProbeFraction(
  start: WorldsCollisionVector3Like,
  delta: WorldsCollisionVector3Like,
  probeHalfExtents: WorldsCollisionVector3Like,
  collisionBoxes: readonly WorldsCollisionBox[],
): number {
  if (isZeroVector(delta)) return 1
  const targetProbe = createWorldCollisionProbe(addVectors(start, delta), probeHalfExtents)
  if (findWorldCollisionIntersections(targetProbe, collisionBoxes).length === 0) return 1

  let low = 0
  let high = 1
  for (let iteration = 0; iteration < SWEEP_BINARY_SEARCH_STEPS; iteration += 1) {
    const mid = (low + high) * 0.5
    const probe = createWorldCollisionProbe({
      x: start.x + delta.x * mid,
      y: start.y + delta.y * mid,
      z: start.z + delta.z * mid,
    }, probeHalfExtents)
    if (findWorldCollisionIntersections(probe, collisionBoxes).length === 0) {
      low = mid
    } else {
      high = mid
    }
  }

  return low
}

function testObbIntersection(left: WorldsInternalObb, right: WorldsInternalObb): { intersects: boolean } {
  const leftAxes = left.axes
  const rightAxes = right.axes
  const leftHalfExtents = [left.halfExtents.x, left.halfExtents.y, left.halfExtents.z] as const
  const rightHalfExtents = [right.halfExtents.x, right.halfExtents.y, right.halfExtents.z] as const
  const translation = subtractVectors(right.center, left.center)
  const translationInLeft = [
    dot(translation, leftAxes[0]),
    dot(translation, leftAxes[1]),
    dot(translation, leftAxes[2]),
  ] as const
  const rotation: number[][] = [[], [], []]
  const absRotation: number[][] = [[], [], []]

  for (let leftAxisIndex = 0; leftAxisIndex < 3; leftAxisIndex += 1) {
    for (let rightAxisIndex = 0; rightAxisIndex < 3; rightAxisIndex += 1) {
      const value = dot(leftAxes[leftAxisIndex], rightAxes[rightAxisIndex])
      rotation[leftAxisIndex]![rightAxisIndex] = value
      absRotation[leftAxisIndex]![rightAxisIndex] = Math.abs(value) + SAT_EPSILON
    }
  }

  for (let leftAxisIndex = 0; leftAxisIndex < 3; leftAxisIndex += 1) {
    const radiusLeft = leftHalfExtents[leftAxisIndex]
    const radiusRight = (
      rightHalfExtents[0] * absRotation[leftAxisIndex]![0]!
      + rightHalfExtents[1] * absRotation[leftAxisIndex]![1]!
      + rightHalfExtents[2] * absRotation[leftAxisIndex]![2]!
    )
    if (Math.abs(translationInLeft[leftAxisIndex]) > radiusLeft + radiusRight) return { intersects: false }
  }

  for (let rightAxisIndex = 0; rightAxisIndex < 3; rightAxisIndex += 1) {
    const radiusLeft = (
      leftHalfExtents[0] * absRotation[0]![rightAxisIndex]!
      + leftHalfExtents[1] * absRotation[1]![rightAxisIndex]!
      + leftHalfExtents[2] * absRotation[2]![rightAxisIndex]!
    )
    const radiusRight = rightHalfExtents[rightAxisIndex]
    const translationInRight = (
      translationInLeft[0] * rotation[0]![rightAxisIndex]!
      + translationInLeft[1] * rotation[1]![rightAxisIndex]!
      + translationInLeft[2] * rotation[2]![rightAxisIndex]!
    )
    if (Math.abs(translationInRight) > radiusLeft + radiusRight) return { intersects: false }
  }

  for (let leftAxisIndex = 0; leftAxisIndex < 3; leftAxisIndex += 1) {
    for (let rightAxisIndex = 0; rightAxisIndex < 3; rightAxisIndex += 1) {
      const radiusLeft = (
        leftHalfExtents[(leftAxisIndex + 1) % 3] * absRotation[(leftAxisIndex + 2) % 3]![rightAxisIndex]!
        + leftHalfExtents[(leftAxisIndex + 2) % 3] * absRotation[(leftAxisIndex + 1) % 3]![rightAxisIndex]!
      )
      const radiusRight = (
        rightHalfExtents[(rightAxisIndex + 1) % 3] * absRotation[leftAxisIndex]![(rightAxisIndex + 2) % 3]!
        + rightHalfExtents[(rightAxisIndex + 2) % 3] * absRotation[leftAxisIndex]![(rightAxisIndex + 1) % 3]!
      )
      const separation = Math.abs(
        translationInLeft[(leftAxisIndex + 2) % 3] * rotation[(leftAxisIndex + 1) % 3]![rightAxisIndex]!
        - translationInLeft[(leftAxisIndex + 1) % 3] * rotation[(leftAxisIndex + 2) % 3]![rightAxisIndex]!
      )
      if (separation > radiusLeft + radiusRight) return { intersects: false }
    }
  }

  return { intersects: true }
}

function overlapOnAxis(left: WorldsInternalObb, right: WorldsCollisionBox, axis: WorldsCollisionVector3Like): number {
  const leftRadius = projectedRadius(left.halfExtents, left.axes, axis)
  const rightRadius = projectedRadius(right.halfExtents, right.transform.axes, axis)
  const distance = Math.abs(dot(subtractVectors(right.transform.position, left.center), axis))
  return leftRadius + rightRadius - distance
}

function projectedRadius(
  halfExtents: WorldsCollisionVector3Like,
  axes: readonly [WorldsCollisionVector3Like, WorldsCollisionVector3Like, WorldsCollisionVector3Like],
  axis: WorldsCollisionVector3Like,
): number {
  return (
    halfExtents.x * Math.abs(dot(axis, axes[0]))
    + halfExtents.y * Math.abs(dot(axis, axes[1]))
    + halfExtents.z * Math.abs(dot(axis, axes[2]))
  )
}

function worldAabbExtentsForObb(
  axes: readonly [WorldsCollisionVector3Like, WorldsCollisionVector3Like, WorldsCollisionVector3Like],
  halfExtents: WorldsCollisionVector3Like,
): WorldsCollisionVector3Like {
  return {
    x: Math.abs(axes[0].x) * halfExtents.x + Math.abs(axes[1].x) * halfExtents.y + Math.abs(axes[2].x) * halfExtents.z,
    y: Math.abs(axes[0].y) * halfExtents.x + Math.abs(axes[1].y) * halfExtents.y + Math.abs(axes[2].y) * halfExtents.z,
    z: Math.abs(axes[0].z) * halfExtents.x + Math.abs(axes[1].z) * halfExtents.y + Math.abs(axes[2].z) * halfExtents.z,
  }
}

function rotationAxesFromEulerXYZ(
  rotationX: number,
  rotationY: number,
  rotationZ: number,
): readonly [WorldsCollisionVector3Like, WorldsCollisionVector3Like, WorldsCollisionVector3Like] {
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

function aabbsIntersect(left: WorldsCollisionAabb, right: WorldsCollisionAabb): boolean {
  return (
    left.min.x <= right.max.x
    && left.max.x >= right.min.x
    && left.min.y <= right.max.y
    && left.max.y >= right.min.y
    && left.min.z <= right.max.z
    && left.max.z >= right.min.z
  )
}

function applyDelta(
  position: WorldsCollisionVector3Like,
  appliedDelta: WorldsCollisionVector3Like,
  delta: WorldsCollisionVector3Like,
): void {
  position.x += delta.x
  position.y += delta.y
  position.z += delta.z
  appliedDelta.x += delta.x
  appliedDelta.y += delta.y
  appliedDelta.z += delta.z
}

function addVectors(left: WorldsCollisionVector3Like, right: WorldsCollisionVector3Like): WorldsCollisionVector3Like {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  }
}

function subtractVectors(left: WorldsCollisionVector3Like, right: WorldsCollisionVector3Like): WorldsCollisionVector3Like {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  }
}

function scaleVector(vector: WorldsCollisionVector3Like, scalar: number): WorldsCollisionVector3Like {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
    z: vector.z * scalar,
  }
}

function copyVector(vector: WorldsCollisionVector3Like): WorldsCollisionVector3Like {
  return { x: vector.x, y: vector.y, z: vector.z }
}

function dot(left: WorldsCollisionVector3Like, right: WorldsCollisionVector3Like): number {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

function vectorFromTuple(vector: [number, number, number]): WorldsCollisionVector3Like {
  return { x: vector[0], y: vector[1], z: vector[2] }
}

function isFiniteVector(vector: WorldsCollisionVector3Like): boolean {
  return isFiniteVector3(vector.x, vector.y, vector.z)
}

function isFiniteBounds(bounds: WorldsCollisionBounds): boolean {
  return (
    isFiniteVector(bounds.min)
    && isFiniteVector(bounds.max)
    && bounds.min.x < bounds.max.x
    && bounds.min.y < bounds.max.y
    && bounds.min.z < bounds.max.z
  )
}

function isFiniteVector3(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
}

function defaultSubstepDistanceForProbe(halfExtents: WorldsCollisionVector3Like): number {
  return Math.max(DEFAULT_SUBSTEP_DISTANCE, Math.min(halfExtents.x, halfExtents.y, halfExtents.z))
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback
  return value
}

function maxAbsComponent(vector: WorldsCollisionVector3Like): number {
  return Math.max(Math.abs(vector.x), Math.abs(vector.y), Math.abs(vector.z))
}

function isZeroVector(vector: WorldsCollisionVector3Like): boolean {
  return vector.x === 0 && vector.y === 0 && vector.z === 0
}
