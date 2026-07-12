import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorldCollisionZone } from './worldsCollisionZones.ts'
import {
  buildWorldCollisionBoxes,
  buildWorldCollisionBoxFromLocalBounds,
  createWorldCollisionProbe,
  depenetrateWorldCollisionProbe,
  findWorldCollisionIntersections,
  getWorldCollisionProbeAabb,
  intersectsWorldCollisionBox,
  intersectsWorldCollisionBoxes,
  resolveWorldCollisionProbeTranslation,
} from './worldsCollisionMath.ts'

const EPSILON = 1e-6
const DEFAULT_PROBE_HALF_EXTENTS = { x: 0.2, y: 0.35, z: 0.2 }

test('buildWorldCollisionBoxes creates stable world-space boxes with broad-phase AABBs', () => {
  const collisions = buildWorldCollisionBoxes([{
    id: 'zone-1',
    shape: 'box',
    transform: { position: [10, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [4, 2, 2] },
  }])

  assert.equal(collisions.length, 1)
  assert.equal(collisions[0]?.zoneId, 'zone-1')
  assert.deepEqual(collisions[0]?.halfExtents, { x: 2, y: 1, z: 1 })
  assertVectorClose(collisions[0]?.worldAabb.min, { x: 9, y: -1, z: -2 })
  assertVectorClose(collisions[0]?.worldAabb.max, { x: 11, y: 1, z: 2 })
})

test('buildWorldCollisionBoxFromLocalBounds supports offset local bounds and box-box intersection tests', () => {
  const left = buildWorldCollisionBoxFromLocalBounds('left', {
    min: { x: 0, y: -0.5, z: -0.5 },
    max: { x: 2, y: 0.5, z: 0.5 },
  }, {
    position: { x: 1, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  })
  const right = buildWorldCollisionBoxFromLocalBounds('right', {
    min: { x: -0.5, y: -0.5, z: -0.5 },
    max: { x: 0.5, y: 0.5, z: 0.5 },
  }, {
    position: { x: 3.6, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  })

  assert.ok(left)
  assert.ok(right)
  assertVectorClose(left?.transform.position, { x: 2, y: 0, z: 0 })
  assert.equal(intersectsWorldCollisionBoxes(left!, right!), false)
})

test('axis-aligned wall blocks direct movement', () => {
  const result = resolveWorldCollisionProbeTranslation({
    position: { x: -1, y: 0, z: 0 },
    delta: { x: 1, y: 0, z: 0 },
    probeHalfExtents: DEFAULT_PROBE_HALF_EXTENTS,
    collisionBoxes: buildWorldCollisionBoxes([
      boxZone('wall', [0, 0, 0], [0, 0, 0], [1, 1, 1]),
    ]),
  })

  assert.ok(result.appliedDelta.x > 0)
  assert.ok(result.appliedDelta.x < 0.31)
  assertClose(result.position.x, -0.7, 2e-3)
  assert.deepEqual(result.collidedZoneIds, ['wall'])
})

test('rotated narrow phase avoids broad-AABB-only over-blocking', () => {
  const box = buildWorldCollisionBoxes([
    boxZone('rotated', [0, 0, 0], [0, Math.PI / 4, 0], [4, 2, 0.5]),
  ])[0]
  assert.ok(box)

  const probe = createWorldCollisionProbe({ x: 1.7, y: 0, z: 1.7 }, DEFAULT_PROBE_HALF_EXTENTS)
  assert.ok(probe)
  assert.equal(intersectsWorldCollisionBox(probe, box!), false)
  assert.equal(findWorldCollisionIntersections(probe, [box!]).length, 0)
  assert.equal(
    probeAabbIntersectsBoxAabb(probe, box!),
    true,
  )
})

test('diagonal movement slides along the unblocked axis', () => {
  const result = resolveWorldCollisionProbeTranslation({
    position: { x: -1, y: 0, z: -0.7 },
    delta: { x: 1, y: 0, z: 1 },
    probeHalfExtents: DEFAULT_PROBE_HALF_EXTENTS,
    collisionBoxes: buildWorldCollisionBoxes([
      boxZone('wall', [0, 0, 0], [0, 0, 0], [1, 1, 1]),
    ]),
  })

  assert.ok(result.appliedDelta.x > 0)
  assert.ok(result.appliedDelta.x < 0.31)
  assertClose(result.appliedDelta.z, 1, 2e-3)
  assertClose(result.position.z, 0.3, 2e-3)
  assert.deepEqual(result.collidedZoneIds, ['wall'])
})

test('substepped sweep prevents tunneling through thin blockers', () => {
  const result = resolveWorldCollisionProbeTranslation({
    position: { x: -3, y: 0, z: 0 },
    delta: { x: 6, y: 0, z: 0 },
    probeHalfExtents: DEFAULT_PROBE_HALF_EXTENTS,
    collisionBoxes: buildWorldCollisionBoxes([
      boxZone('thin-wall', [0, 0, 0], [0, 0, 0], [0.2, 4, 4]),
    ]),
    maxSubstepDistance: 0.25,
  })

  assert.ok(result.position.x < -0.29)
  assert.ok(result.position.x > -0.31)
  assert.deepEqual(result.collidedZoneIds, ['thin-wall'])
})

test('depenetration resolves a probe starting inside one zone', () => {
  const collisionBoxes = buildWorldCollisionBoxes([
    boxZone('blocker', [0, 0, 0], [0, 0, 0], [1, 1, 1]),
  ])
  const result = depenetrateWorldCollisionProbe(
    createWorldCollisionProbe({ x: 0, y: 0, z: 0 }, DEFAULT_PROBE_HALF_EXTENTS),
    collisionBoxes,
  )

  assert.equal(result.resolved, true)
  assert.equal(result.intersectingZoneIds.length, 0)
  assertClose(result.position.x, -0.7001, 2e-3)
})

test('overlapping depenetration uses deterministic zone-id tie breaks', () => {
  const collisionBoxes = buildWorldCollisionBoxes([
    boxZone('zone-b', [0, 0, 0], [0, 0, 0], [1, 1, 1]),
    boxZone('zone-a', [0, 0, 0], [0, 0, 0], [1, 1, 1]),
  ])
  const result = depenetrateWorldCollisionProbe(
    createWorldCollisionProbe({ x: 0, y: 0, z: 0 }, DEFAULT_PROBE_HALF_EXTENTS),
    collisionBoxes,
    { maxIterations: 12 },
  )

  assert.equal(result.resolved, true)
  assert.equal(result.intersectingZoneIds.length, 0)
  assert.ok(result.position.x < -0.69)
})

test('movement without collisions stays unchanged', () => {
  const result = resolveWorldCollisionProbeTranslation({
    position: { x: 1, y: 2, z: 3 },
    delta: { x: -0.5, y: 0.25, z: 1.5 },
    probeHalfExtents: DEFAULT_PROBE_HALF_EXTENTS,
    collisionBoxes: [],
  })

  assert.deepEqual(result.position, { x: 0.5, y: 2.25, z: 4.5 })
  assert.deepEqual(result.appliedDelta, { x: -0.5, y: 0.25, z: 1.5 })
  assert.deepEqual(result.collidedZoneIds, [])
})

test('invalid zones are ignored consistently', () => {
  const invalidZones = [
    {
      id: 'bad-shape',
      shape: 'sphere',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      id: 'bad-scale',
      shape: 'box',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [0, 1, 1] },
    },
    {
      id: 'bad-number',
      shape: 'box',
      transform: { position: [Number.NaN, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  ] as unknown as WorldCollisionZone[]

  const collisions = buildWorldCollisionBoxes(invalidZones)
  assert.deepEqual(collisions, [])
  const result = resolveWorldCollisionProbeTranslation({
    position: { x: 0, y: 0, z: 0 },
    delta: { x: 1, y: 0, z: 0 },
    probeHalfExtents: DEFAULT_PROBE_HALF_EXTENTS,
    collisionBoxes: collisions,
  })

  assert.deepEqual(result.position, { x: 1, y: 0, z: 0 })
  assert.deepEqual(result.appliedDelta, { x: 1, y: 0, z: 0 })
})

test('probe AABB helper stays consistent with probe dimensions', () => {
  const aabb = getWorldCollisionProbeAabb(createWorldCollisionProbe({ x: 2, y: -1, z: 3 }, DEFAULT_PROBE_HALF_EXTENTS))

  assertVectorClose(aabb.min, { x: 1.8, y: -1.35, z: 2.8 })
  assertVectorClose(aabb.max, { x: 2.2, y: -0.65, z: 3.2 })
})

function boxZone(
  id: string,
  position: [number, number, number],
  rotation: [number, number, number],
  scale: [number, number, number],
): WorldCollisionZone {
  return {
    id,
    shape: 'box',
    transform: { position, rotation, scale },
  }
}

function probeAabbIntersectsBoxAabb(probe: ReturnType<typeof createWorldCollisionProbe>, box: NonNullable<ReturnType<typeof buildWorldCollisionBoxes>[number]>): boolean {
  const aabb = getWorldCollisionProbeAabb(probe)
  return (
    aabb.min.x <= box.worldAabb.max.x
    && aabb.max.x >= box.worldAabb.min.x
    && aabb.min.y <= box.worldAabb.max.y
    && aabb.max.y >= box.worldAabb.min.y
    && aabb.min.z <= box.worldAabb.max.z
    && aabb.max.z >= box.worldAabb.min.z
  )
}

function assertVectorClose(actual: { x: number; y: number; z: number } | undefined, expected: { x: number; y: number; z: number }, tolerance = EPSILON): void {
  assert.ok(actual)
  assertClose(actual!.x, expected.x, tolerance)
  assertClose(actual!.y, expected.y, tolerance)
  assertClose(actual!.z, expected.z, tolerance)
}

function assertClose(actual: number, expected: number, tolerance = EPSILON): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`)
}
