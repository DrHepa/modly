import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorldCollisionSurface } from './worldsCollisionSurfaces.ts'
import { createWorldCollisionSurfacePreset, normalizeWorldCollisionSurface } from './worldsCollisionSurfaces.ts'
import { resolveWorldCollisionSurface } from './worldsSurfaceMath.ts'
import {
  depenetrateWorldSurfaceProbe,
  findEarliestWorldSurfaceHit,
  resolveWorldSurfaceProbeTranslation,
  sweepWorldProbeAgainstSurface,
} from './worldsSurfaceNavigation.ts'

const EPSILON = 1e-6
const PROBE_HALF_EXTENTS = { x: 0.2, y: 0.2, z: 0.2 }

test('rect wall blocks direct crossing', () => {
  const wall = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const hit = sweepWorldProbeAgainstSurface({
    position: { x: 0, y: 0, z: -1 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: 2 },
    surface: wall,
  })

  assert.ok(hit)
  assert.equal(hit?.surfaceId, 'wall')
  assertClose(hit?.fraction ?? 0, 0.39995, 2e-4)

  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: 0, y: 0, z: -1 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: 2 },
    surfaces: [wall],
  })

  assertClose(result.position.z, -0.2001, 3e-4)
  assert.deepEqual(result.collidedSurfaceIds, ['wall'])
})

test('rect wall allows movement outside finite bounds', () => {
  const wall = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: 1.6, y: 0, z: -1 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: 2 },
    surfaces: [wall],
  })

  assert.deepEqual(result.position, { x: 1.6, y: 0, z: 1 })
  assert.deepEqual(result.collidedSurfaceIds, [])
})

test('triangle blocks through interior', () => {
  const tri = resolvedSurface(createWorldCollisionSurfacePreset('triangle', { id: 'tri' })!)
  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: -0.25, y: 1, z: -0.25 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: -2, z: 0 },
    surfaces: [tri],
  })

  assert.ok(result.position.y > 0.19)
  assert.ok(result.position.y < 0.21)
  assert.deepEqual(result.collidedSurfaceIds, ['tri'])
})

test('triangle edge miss passes', () => {
  const tri = resolvedSurface(createWorldCollisionSurfacePreset('triangle', { id: 'tri' })!)
  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: 0.35, y: 1, z: 0.35 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: -2, z: 0 },
    surfaces: [tri],
  })

  assert.deepEqual(result.position, { x: 0.35, y: -1, z: 0.35 })
  assert.deepEqual(result.collidedSurfaceIds, [])
})

test('large delta cannot tunnel', () => {
  const wall = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: 0, y: 0, z: -5 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: 10 },
    surfaces: [wall],
  })

  assertClose(result.position.z, -0.2001, 3e-4)
  assert.deepEqual(result.collidedSurfaceIds, ['wall'])
})

test('diagonal movement slides along wall', () => {
  const wall = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: -0.8, y: 0, z: -1 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 1, y: 0, z: 1 },
    surfaces: [wall],
  })

  assertClose(result.position.z, -0.2001, 3e-4)
  assertClose(result.position.x, 0.2, 3e-4)
  assert.deepEqual(result.collidedSurfaceIds, ['wall'])
})

test('tangential movement on wall remains unchanged', () => {
  const wall = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: 0, y: 0, z: -0.2001 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0.5, y: 0, z: 0 },
    surfaces: [wall],
  })

  assert.deepEqual(result.position, { x: 0.5, y: 0, z: -0.2001 })
  assert.deepEqual(result.collidedSurfaceIds, [])
})

test('double-sided blocks both directions', () => {
  const wall = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: 0, y: 0, z: 1 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: -2 },
    surfaces: [wall],
  })

  assertClose(result.position.z, 0.2001, 3e-4)
  assert.deepEqual(result.collidedSurfaceIds, ['wall'])
})

test('front-sided blocks front-to-back and allows back-to-front', () => {
  const frontWall = resolvedSurface(createWorldCollisionSurfacePreset('wall', {
    id: 'front-wall',
    sidedness: 'front',
  })!)

  const blocked = resolveWorldSurfaceProbeTranslation({
    position: { x: 0, y: 0, z: -1 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: 2 },
    surfaces: [frontWall],
  })
  assertClose(blocked.position.z, -0.2001, 3e-4)
  assert.deepEqual(blocked.collidedSurfaceIds, ['front-wall'])

  const allowed = resolveWorldSurfaceProbeTranslation({
    position: { x: 0, y: 0, z: 1 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: -2 },
    surfaces: [frontWall],
  })
  assert.deepEqual(allowed.position, { x: 0, y: 0, z: -1 })
  assert.deepEqual(allowed.collidedSurfaceIds, [])
})

test('starting penetrating rect depenetrates', () => {
  const wall = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = depenetrateWorldSurfaceProbe({
    position: { x: 0, y: 0, z: -0.05 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    surfaces: [wall],
  })

  assert.equal(result.depenetrated, true)
  assert.equal(result.resolved, true)
  assert.equal(result.intersectingSurfaceIds.length, 0)
  assertClose(result.position.z, -0.2001, 3e-4)
})

test('starting overlapping multiple surfaces deterministic', () => {
  const wallA = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall-a' })!)
  const wallB = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall-b' })!)
  const result = depenetrateWorldSurfaceProbe({
    position: { x: 0, y: 0, z: 0 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    surfaces: [wallB, wallA],
    maxIterations: 8,
  })

  assert.equal(result.resolved, true)
  assertClose(result.position.z, -0.2001, 3e-4)
})

test('rotated inclined surface blocks deterministically', () => {
  const ramp = resolvedSurface(createWorldCollisionSurfacePreset('ramp', { id: 'ramp' })!)
  const hit = findEarliestWorldSurfaceHit({
    position: { x: 0, y: 1, z: 0 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: -2, z: 0 },
    surfaces: [ramp],
  })

  assert.ok(hit)
  assert.equal(hit?.surfaceId, 'ramp')
  assert.ok(Math.abs(hit!.normal.y) > 0.8)

  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: 0, y: 1, z: 0 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: -2, z: 0 },
    surfaces: [ramp],
  })

  assert.deepEqual(result.collidedSurfaceIds, ['ramp'])
  assert.ok(result.position.y < 0)
  assert.ok(result.position.z < -0.5)
  assert.ok(result.acceptedDelta.z < 0)
})

test('corner and edge epsilon behavior stays deterministic', () => {
  const wall = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const inside = findEarliestWorldSurfaceHit({
    position: { x: 1.3999995, y: 0, z: -1 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: 2 },
    surfaces: [wall],
    edgeEpsilon: 1e-6,
  })
  const outside = findEarliestWorldSurfaceHit({
    position: { x: 1.40002, y: 0, z: -1 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: 2 },
    surfaces: [wall],
    edgeEpsilon: 1e-6,
  })

  assert.ok(inside)
  assert.equal(outside, null)
})

test('zero delta stable', () => {
  const wall = resolvedSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: 0, y: 0, z: -0.2001 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: 0 },
    surfaces: [wall],
  })

  assert.deepEqual(result.position, { x: 0, y: 0, z: -0.2001 })
  assert.deepEqual(result.acceptedDelta, { x: 0, y: 0, z: 0 })
  assert.equal(result.earliestHit, null)
})

test('invalid surfaces are ignored according to existing normalization', () => {
  const invalid = resolveWorldCollisionSurface({
    id: 'invalid',
    shape: 'rect',
    sidedness: 'double',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [0, 1, 1] },
    geometry: { halfWidth: 1, halfHeight: 1 },
  } as WorldCollisionSurface)

  assert.equal(invalid, null)
  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: 0, y: 0, z: -1 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: 0, y: 0, z: 2 },
    surfaces: [invalid],
  })

  assert.deepEqual(result.position, { x: 0, y: 0, z: 1 })
  assert.deepEqual(result.collidedSurfaceIds, [])
})

test('no-collision unchanged', () => {
  const result = resolveWorldSurfaceProbeTranslation({
    position: { x: 1, y: 2, z: 3 },
    probeHalfExtents: PROBE_HALF_EXTENTS,
    delta: { x: -0.25, y: 0.5, z: 1.5 },
    surfaces: [],
  })

  assert.deepEqual(result.position, { x: 0.75, y: 2.5, z: 4.5 })
  assert.deepEqual(result.acceptedDelta, { x: -0.25, y: 0.5, z: 1.5 })
  assert.deepEqual(result.collidedSurfaceIds, [])
})

function resolvedSurface(surface: WorldCollisionSurface) {
  const resolved = resolveWorldCollisionSurface(surface)
  assert.ok(resolved)
  return resolved!
}

function assertClose(actual: number, expected: number, tolerance = EPSILON): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`)
}
