import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorldCollisionSurfacePreset, normalizeWorldCollisionSurface } from './worldsCollisionSurfaces.ts'
import {
  classifyWorldPointAgainstCollisionSurfaceSide,
  closestPointOnWorldCollisionSurface,
  isPointInCollisionSurfaceRect,
  isPointInCollisionSurfaceTriangle,
  isWorldPointInCollisionSurface,
  projectWorldPointToCollisionSurfaceUv,
  resolveWorldCollisionSurface,
  signedDistanceToWorldCollisionSurfacePlane,
  worldCollisionSurfaceAabbsIntersect,
} from './worldsSurfaceMath.ts'

const EPSILON = 1e-6

test('resolveWorldCollisionSurface keeps floor normal at +Y and wall/ramp deterministic', () => {
  const floor = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('floor', { id: 'floor-1' })!)
  const wall = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('wall', { id: 'wall-1' })!)
  const ramp = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('ramp', { id: 'ramp-1' })!)

  assertVectorClose(floor?.normal, { x: 0, y: 1, z: 0 })
  assertVectorClose(wall?.normal, { x: 0, y: 0, z: -1 })
  assert.ok(ramp)
  assert.ok(ramp!.normal.y > 0.8)
  assert.ok(ramp!.tangentV.y > 0.49)
})

test('resolveWorldCollisionSurface computes identity rect corners and finite AABB', () => {
  const resolved = resolveWorldCollisionSurface(normalizeWorldCollisionSurface({
    id: 'rect-1',
    shape: 'rect',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 9, 4] },
    geometry: { halfWidth: 1, halfHeight: 0.5 },
  })!)

  assert.ok(resolved)
  assert.equal(resolved?.shape, 'rect')
  assert.deepEqual(resolved?.worldCorners, [
    { x: -2, y: 0, z: -2 },
    { x: -2, y: 0, z: 2 },
    { x: 2, y: 0, z: 2 },
    { x: 2, y: 0, z: -2 },
  ])
  assert.deepEqual(resolved?.worldAabb, {
    min: { x: -2, y: 0, z: -2 },
    max: { x: 2, y: 0, z: 2 },
  })
  assert.deepEqual(resolved?.scale, { u: 2, v: 4 })
})

test('resolveWorldCollisionSurface computes rotated and translated rect corners', () => {
  const resolved = resolveWorldCollisionSurface(normalizeWorldCollisionSurface({
    id: 'rect-2',
    shape: 'rect',
    transform: { position: [10, 1, 0], rotation: [0, Math.PI / 2, 0], scale: [2, 1, 4] },
    geometry: { halfWidth: 1, halfHeight: 0.5 },
  })!)

  assert.ok(resolved)
  assert.equal(resolved?.shape, 'rect')
  assert.deepEqual(resolved?.worldCorners, [
    { x: 8, y: 1, z: 1.9999999999999998 },
    { x: 12, y: 1, z: 2 },
    { x: 12, y: 1, z: -1.9999999999999998 },
    { x: 8, y: 1, z: -2 },
  ])
  assert.deepEqual(resolved?.worldAabb, {
    min: { x: 8, y: 1, z: -2 },
    max: { x: 12, y: 1, z: 2 },
  })
})

test('resolveWorldCollisionSurface computes triangle world vertices with positive normal winding', () => {
  const resolved = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('triangle', {
    id: 'tri-1',
    transform: { position: [1, 0, 1], rotation: [0, 0, 0], scale: [2, 1, 2] },
  })!)

  assert.ok(resolved)
  assert.equal(resolved?.shape, 'tri')
  assert.deepEqual(resolved?.worldVertices, [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 2 },
    { x: 2, y: 0, z: 0 },
  ])
  assertVectorClose(resolved?.normal, { x: 0, y: 1, z: 0 })
})

test('signedDistanceToWorldCollisionSurfacePlane and side classification are stable', () => {
  const surface = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('floor', { id: 'floor-2' })!)
  assert.ok(surface)

  assertClose(signedDistanceToWorldCollisionSurfacePlane({ x: 0, y: 2, z: 0 }, surface!), 2)
  assert.equal(classifyWorldPointAgainstCollisionSurfaceSide({ x: 0, y: 2, z: 0 }, surface!), 'front')
  assert.equal(classifyWorldPointAgainstCollisionSurfaceSide({ x: 0, y: -2, z: 0 }, surface!), 'back')
  assert.equal(classifyWorldPointAgainstCollisionSurfaceSide({ x: 0, y: 1e-7, z: 0 }, surface!), 'coplanar')
})

test('projectWorldPointToCollisionSurfaceUv and rect inclusion respect edge epsilon', () => {
  const surface = resolveWorldCollisionSurface(normalizeWorldCollisionSurface({
    id: 'rect-3',
    shape: 'rect',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 4] },
    geometry: { halfWidth: 1, halfHeight: 0.5 },
  })!)
  assert.ok(surface)
  assert.equal(surface?.shape, 'rect')

  const uv = projectWorldPointToCollisionSurfaceUv({ x: 1.9999995, y: 0, z: 1.999999 }, surface!)
  assertClose(uv[0], 0.99999975)
  assertClose(uv[1], 0.49999975)
  assert.equal(isPointInCollisionSurfaceRect(uv, surface as Extract<typeof surface, { shape: 'rect' }>), true)
  assert.equal(isPointInCollisionSurfaceRect([1.00001, 0], surface as Extract<typeof surface, { shape: 'rect' }>, 1e-6), false)
})

test('triangle barycentric inclusion respects edge epsilon', () => {
  const surface = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('triangle', { id: 'tri-2' })!)
  assert.ok(surface)
  assert.equal(surface?.shape, 'tri')

  assert.equal(isPointInCollisionSurfaceTriangle([-0.5, 0], surface as Extract<typeof surface, { shape: 'tri' }>), true)
  assert.equal(isPointInCollisionSurfaceTriangle([0.1, 0.1], surface as Extract<typeof surface, { shape: 'tri' }>), false)
  assert.equal(isPointInCollisionSurfaceTriangle([-0.5000005, 0], surface as Extract<typeof surface, { shape: 'tri' }>, 1e-3), true)
})

test('isWorldPointInCollisionSurface respects plane distance and finite face bounds', () => {
  const rect = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('square', { id: 'sq-1' })!)
  const tri = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('triangle', { id: 'tri-3' })!)

  assert.equal(isWorldPointInCollisionSurface({ x: 0.49, y: 0, z: -0.49 }, rect!), true)
  assert.equal(isWorldPointInCollisionSurface({ x: 0.51, y: 0, z: 0 }, rect!), false)
  assert.equal(isWorldPointInCollisionSurface({ x: -0.25, y: 0, z: -0.25 }, tri!), true)
  assert.equal(isWorldPointInCollisionSurface({ x: -0.25, y: 0.01, z: -0.25 }, tri!), false)
})

test('closestPointOnWorldCollisionSurface clamps to finite rects and triangle edges', () => {
  const rect = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('square', { id: 'sq-2' })!)
  const tri = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('triangle', { id: 'tri-4' })!)

  assert.deepEqual(closestPointOnWorldCollisionSurface({ x: 2, y: 3, z: 0.1 }, rect!), { x: 0.5, y: 0, z: 0.1 })
  const closestTri = closestPointOnWorldCollisionSurface({ x: 0.25, y: 1, z: 0.25 }, tri!)
  assertVectorClose(closestTri, { x: 0, y: 0, z: 0 })
})

test('worldCollisionSurfaceAabbsIntersect provides broad-phase overlap checks', () => {
  const left = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('square', { id: 'left' })!)
  const right = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('square', {
    id: 'right',
    transform: { position: [0.75, 0, 0] },
  })!)
  const far = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('square', {
    id: 'far',
    transform: { position: [3, 0, 0] },
  })!)

  assert.equal(worldCollisionSurfaceAabbsIntersect(left!.worldAabb, right!.worldAabb), true)
  assert.equal(worldCollisionSurfaceAabbsIntersect(left!.worldAabb, far!.worldAabb), false)
})

function assertVectorClose(actual: { x: number; y: number; z: number } | undefined, expected: { x: number; y: number; z: number }, tolerance = EPSILON): void {
  assert.ok(actual)
  assertClose(actual!.x, expected.x, tolerance)
  assertClose(actual!.y, expected.y, tolerance)
  assertClose(actual!.z, expected.z, tolerance)
}

function assertClose(actual: number, expected: number, tolerance = EPSILON): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`)
}
