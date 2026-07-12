import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorldCollisionSurfacePreset } from './worldsCollisionSurfaces.ts'
import { resolveWorldCollisionSurface } from './worldsSurfaceMath.ts'
import {
  createWorldsPlacementSurfaceHitFromAuthoredSurface,
  deriveWorldsPlacementSurfaceTangents,
  resolveWorldsPlacementSurfaceSupport,
  type WorldsPlacementSurfaceHit,
} from './worldsBaseScenePlacementSurface.ts'
import type { WorldsSurfacePlacementItemDescriptor, WorldsSurfacePlacementTransform } from './worldsSurfacePlacement.ts'

const EPSILON = 1e-6

test('single asset bottom aligns to horizontal surface with skin', () => {
  const hit = placementHit({ point: [0, 0, 0], normal: [0, 1, 0] })
  const result = resolveWorldsPlacementSurfaceSupport({
    placementHit: hit,
    items: [boxItem('item', [0, 2, 0])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 2, 0]) }],
    options: { skin: 0.1 },
  })

  assert.equal(result.valid, true)
  assert.equal(result.reason, 'aligned')
  assert.deepEqual(result.correctionDelta, [0, -1.4, 0])
  assertVectorClose(result.resolvedTransforms[0]!.transform.position, [0, 0.6, 0])
})

test('group receives one delta and preserves offsets', () => {
  const hit = placementHit({ point: [0, 0, 0], normal: [0, 1, 0] })
  const desiredTransforms = [
    { id: 'a', transform: transform([0, 2, 0]) },
    { id: 'b', transform: transform([2, 3, -1], [0, 0.25, 0]) },
  ]
  const result = resolveWorldsPlacementSurfaceSupport({
    placementHit: hit,
    items: [boxItem('a', [0, 2, 0]), boxItem('b', [2, 3, -1], [0, 0.25, 0])],
    desiredTransforms,
  })

  assert.equal(result.valid, true)
  assertVectorClose(offset(result.resolvedTransforms[1]!.transform.position, desiredTransforms[1]!.transform.position), result.correctionDelta)
  assertVectorClose(offset(result.resolvedTransforms[0]!.transform.position, desiredTransforms[0]!.transform.position), result.correctionDelta)
  assertVectorClose(offset(result.resolvedTransforms[1]!.transform.position, result.resolvedTransforms[0]!.transform.position), [2, 1, -1])
})

test('inclined surface correction follows hit normal without rotating', () => {
  const normal = normalize([0, 1, 1])
  const result = resolveWorldsPlacementSurfaceSupport({
    placementHit: placementHit({ point: [0, 0, 0], normal }),
    items: [boxItem('item', [0, 2, 0], [0.3, 0.4, 0.1])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 2, 0], [0.3, 0.4, 0.1]) }],
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.resolvedTransforms[0]!.transform.rotation, [0.3, 0.4, 0.1])
  assert.ok(Math.abs(result.correctionDelta[1]) > EPSILON)
  assert.ok(Math.abs(result.correctionDelta[2]) > EPSILON)
})

test('maxCorrection rejects distant hit', () => {
  const result = resolveWorldsPlacementSurfaceSupport({
    placementHit: placementHit({ point: [0, 0, 0], normal: [0, 1, 0] }),
    items: [boxItem('item', [0, 10, 0])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 10, 0]) }],
    options: { maxCorrection: 1 },
  })

  assert.equal(result.valid, false)
  assert.equal(result.reason, 'max-correction-exceeded')
  assert.deepEqual(result.resolvedTransforms[0]!.transform.position, [0, 10, 0])
})

test('missing bounds fail safely', () => {
  const result = resolveWorldsPlacementSurfaceSupport({
    placementHit: placementHit({ point: [0, 0, 0], normal: [0, 1, 0] }),
    items: [{ id: 'bad', localBounds: null, startTransform: transform([0, 0, 0]) }],
    desiredTransforms: [{ id: 'bad', transform: transform([1, 0, 0]) }],
  })

  assert.equal(result.valid, false)
  assert.equal(result.reason, 'invalid-candidate')
  assert.deepEqual(result.resolvedTransforms[0]!.transform.position, [1, 0, 0])
})

test('underside and vertical hits reject by default', () => {
  const underside = resolveWorldsPlacementSurfaceSupport({
    placementHit: placementHit({ point: [0, 0, 0], normal: [0, -1, 0] }),
    items: [boxItem('item', [0, 1, 0])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 1, 0]) }],
  })
  const wall = resolveWorldsPlacementSurfaceSupport({
    placementHit: placementHit({ point: [0, 0, 0], normal: [0, 0, 1] }),
    items: [boxItem('item', [0, 1, 0])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 1, 0]) }],
  })

  assert.equal(underside.valid, false)
  assert.equal(underside.reason, 'underside-surface')
  assert.equal(wall.valid, false)
  assert.equal(wall.reason, 'vertical-surface')
})

test('wall placements can be enabled explicitly', () => {
  const result = resolveWorldsPlacementSurfaceSupport({
    placementHit: placementHit({ point: [0, 0, 0], normal: [0, 0, 1] }),
    items: [boxItem('item', [0, 0, -2])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 0, -2]) }],
    options: { allowWalls: true },
  })

  assert.equal(result.valid, true)
  assert.equal(result.reason, 'aligned')
  assertVectorClose(result.resolvedTransforms[0]!.transform.position, [0, 0, 0.5001])
})

test('authored surface adapter normalizes to shared hit contract', () => {
  const surface = resolveWorldCollisionSurface(createWorldCollisionSurfacePreset('floor', { id: 'floor' })!)
  assert.ok(surface)
  const hit = createWorldsPlacementSurfaceHitFromAuthoredSurface(surface!, [0, 0, 0], { distance: 2 })

  assert.ok(hit)
  assert.equal(hit!.source, 'authored-surface')
  assert.equal(hit!.sourceId, 'floor')
  assert.deepEqual(hit!.normal, [0, 1, 0])
  assert.equal(hit!.polygon.length, 4)
})

test('tangent derivation falls back to polygon edges', () => {
  const tangents = deriveWorldsPlacementSurfaceTangents({
    polygon: [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
    normal: [0, 1, 0],
  })

  assert.deepEqual(tangents.tangentU, [1, 0, 0])
  assert.deepEqual(tangents.tangentV, [0, 0, -1])
})

function boxItem(
  id: string,
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): WorldsSurfacePlacementItemDescriptor {
  return {
    id,
    localBounds: {
      min: { x: -0.5, y: -0.5, z: -0.5 },
      max: { x: 0.5, y: 0.5, z: 0.5 },
    },
    startTransform: transform(position, rotation),
  }
}

function transform(
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): WorldsSurfacePlacementTransform {
  return { position: [...position], rotation: [...rotation], scale: [...scale] }
}

function placementHit(overrides: Partial<WorldsPlacementSurfaceHit> & Pick<WorldsPlacementSurfaceHit, 'point' | 'normal'>): WorldsPlacementSurfaceHit {
  return {
    source: 'base-scene',
    sourceId: 'base',
    point: [...overrides.point],
    normal: [...overrides.normal],
    distance: 1,
    polygon: [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
    ...overrides,
  }
}

function offset(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

function normalize(vector: [number, number, number]): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2])
  return [vector[0] / length, vector[1] / length, vector[2] / length]
}

function assertVectorClose(actual: [number, number, number], expected: [number, number, number], tolerance = EPSILON): void {
  assert.ok(Math.abs(actual[0] - expected[0]) <= tolerance, `expected ${actual[0]} to be within ${tolerance} of ${expected[0]}`)
  assert.ok(Math.abs(actual[1] - expected[1]) <= tolerance, `expected ${actual[1]} to be within ${tolerance} of ${expected[1]}`)
  assert.ok(Math.abs(actual[2] - expected[2]) <= tolerance, `expected ${actual[2]} to be within ${tolerance} of ${expected[2]}`)
}
