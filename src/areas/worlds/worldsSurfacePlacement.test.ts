import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorldCollisionSurfacePreset } from './worldsCollisionSurfaces.ts'
import { resolveWorldCollisionSurface } from './worldsSurfaceMath.ts'
import {
  resolveWorldsSurfacePlacement,
  type WorldsSurfacePlacementItemDescriptor,
  type WorldsSurfacePlacementTransform,
} from './worldsSurfacePlacement.ts'

const EPSILON = 1e-6

test('single asset crossing rect blocked', () => {
  const wall = surface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const item = boxItem('item', [0, 0, -1])
  const result = place({
    mode: 'translate',
    items: [item],
    desiredTransforms: [{ id: 'item', transform: transform([0, 0, 1]) }],
    surfaces: [wall],
  })

  assert.equal(result.valid, true)
  assert.equal(result.reason, 'blocked')
  assert.deepEqual(result.blockedSurfaceIds, ['wall'])
  assertClose(result.resolvedTransforms[0]!.transform.position[2], -0.5001, 3e-4)
})

test('crossing tri blocked', () => {
  const tri = surface(createWorldCollisionSurfacePreset('triangle', { id: 'tri' })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('item', [-0.25, 1, -0.25])],
    desiredTransforms: [{ id: 'item', transform: transform([-0.25, -1, -0.25]) }],
    surfaces: [tri],
  })

  assert.equal(result.reason, 'blocked')
  assert.deepEqual(result.blockedSurfaceIds, ['tri'])
  assert.ok(result.resolvedTransforms[0]!.transform.position[1] > 0.49)
})

test('outside finite face passes', () => {
  const wall = surface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('item', [2.1, 0, -1])],
    desiredTransforms: [{ id: 'item', transform: transform([2.1, 0, 1]) }],
    surfaces: [wall],
  })

  assert.equal(result.reason, 'free')
  assert.deepEqual(result.resolvedTransforms[0]!.transform.position, [2.1, 0, 1])
})

test('large delta no tunneling', () => {
  const wall = surface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('item', [0, 0, -5])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 0, 5]) }],
    surfaces: [wall],
  })

  assert.equal(result.reason, 'blocked')
  assert.ok(result.resolvedTransforms[0]!.transform.position[2] < 0)
  assert.ok(result.resolvedTransforms[0]!.transform.position[2] > -0.51)
})

test('diagonal translate slides', () => {
  const wall = surface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('item', [-0.8, 0, -1])],
    desiredTransforms: [{ id: 'item', transform: transform([0.2, 0, 0]) }],
    surfaces: [wall],
  })

  assert.equal(result.reason, 'blocked')
  assertClose(result.resolvedTransforms[0]!.transform.position[0], 0.2, 3e-4)
  assertClose(result.resolvedTransforms[0]!.transform.position[2], -0.5001, 3e-4)
})

test('tangential touching move unchanged', () => {
  const wall = surface(createWorldCollisionSurfacePreset('wall', { id: 'wall' })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('item', [0, 0, -0.5001])],
    desiredTransforms: [{ id: 'item', transform: transform([0.5, 0, -0.5001]) }],
    surfaces: [wall],
  })

  assert.equal(result.reason, 'free')
  assert.deepEqual(result.resolvedTransforms[0]!.transform.position, [0.5, 0, -0.5001])
})

test('floor-like horizontal surface snap supports bottom', () => {
  const floor = surface(createWorldCollisionSurfacePreset('floor', {
    id: 'floor',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('item', [0, 0.7, 0])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 0.7, 0]) }],
    surfaces: [floor],
    options: { snapDistance: 0.25 },
  })

  assert.equal(result.reason, 'snapped')
  assert.equal(result.snappedSurfaceId, 'floor')
  assert.deepEqual(result.snappedSurfaceNormal, [0, 1, 0])
  assertClose(result.resolvedTransforms[0]!.transform.position[1], 0.5001, 3e-4)
})

test('vertical wall-like surface snap', () => {
  const wall = surface(createWorldCollisionSurfacePreset('wall', {
    id: 'wall',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('item', [0, 0, -0.75])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 0, -0.75]) }],
    surfaces: [wall],
    options: { snapDistance: 0.3 },
  })

  assert.equal(result.reason, 'snapped')
  assert.equal(result.snappedSurfaceId, 'wall')
  assert.deepEqual(result.snappedSurfaceNormal, [0, 0, -1])
  assertClose(result.resolvedTransforms[0]!.transform.position[2], -0.5001, 3e-4)
})

test('inclined ramp snap along normal without rotation', () => {
  const ramp = surface(createWorldCollisionSurfacePreset('ramp', {
    id: 'ramp',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)
  const start = transform([0, 1, 0])
  const result = place({
    mode: 'translate',
    items: [{ ...boxItem('item', [0, 0.75, 0]), startTransform: start }],
    desiredTransforms: [{ id: 'item', transform: start }],
    surfaces: [ramp],
    options: { snapDistance: 0.35 },
  })

  assert.equal(result.reason, 'snapped')
  assert.deepEqual(result.resolvedTransforms[0]!.transform.rotation, [0, 0, 0])
  assert.ok(Math.abs(result.acceptedTranslationDelta![2]) > 0.05)
  assert.ok(Math.abs(result.acceptedTranslationDelta![1]) > 0.05)
})

test('front and double sided behavior', () => {
  const frontWall = surface(createWorldCollisionSurfacePreset('wall', {
    id: 'front-wall',
    sidedness: 'front',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)
  const doubleWall = surface(createWorldCollisionSurfacePreset('wall', {
    id: 'double-wall',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)

  const frontBlocked = place({
    mode: 'translate',
    items: [boxItem('item', [0, 0, -1])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 0, 1]) }],
    surfaces: [frontWall],
  })
  const frontAllowed = place({
    mode: 'translate',
    items: [boxItem('item', [0, 0, 1])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 0, -1]) }],
    surfaces: [frontWall],
  })
  const doubleBlocked = place({
    mode: 'translate',
    items: [boxItem('item', [0, 0, 1])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 0, -1]) }],
    surfaces: [doubleWall],
  })

  assert.equal(frontBlocked.reason, 'blocked')
  assert.equal(frontAllowed.reason, 'free')
  assert.equal(doubleBlocked.reason, 'blocked')
})

test('rotate final pose crossing rejected', () => {
  const wall = surface(createWorldCollisionSurfacePreset('wall', {
    id: 'wall',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)
  const item = boxItem('item', [0, 0, -0.35], [0, 0, 0], [1, 1, 0.2])
  const result = place({
    mode: 'rotate',
    items: [item],
    desiredTransforms: [{ id: 'item', transform: transform([0, 0, -0.35], [0, Math.PI / 4, 0], [1, 1, 0.2]) }],
    surfaces: [wall],
  })

  assert.equal(result.valid, false)
  assert.equal(result.reason, 'blocked')
  assert.deepEqual(result.resolvedTransforms[0]!.transform.rotation, item.startTransform.rotation)
})

test('scale final pose crossing rejected', () => {
  const wall = surface(createWorldCollisionSurfacePreset('wall', {
    id: 'wall',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)
  const item = boxItem('item', [0, 0, -0.4], [0, 0, 0], [1, 1, 0.2])
  const result = place({
    mode: 'scale',
    items: [item],
    desiredTransforms: [{ id: 'item', transform: transform([0, 0, -0.4], [0, 0, 0], [1, 1, 1]) }],
    surfaces: [wall],
  })

  assert.equal(result.valid, false)
  assert.equal(result.reason, 'blocked')
  assert.deepEqual(result.resolvedTransforms[0]!.transform.scale, item.startTransform.scale)
})

test('multi-item group one delta preserves offsets', () => {
  const result = place({
    mode: 'translate',
    items: [boxItem('a', [0, 0, -1]), boxItem('b', [1.5, 0.25, -1], [0, 0.3, 0])],
    desiredTransforms: [
      { id: 'a', transform: transform([0.5, 0, 0]) },
      { id: 'b', transform: transform([2, 0.25, 0], [0, 0.3, 0]) },
    ],
    surfaces: [surface(createWorldCollisionSurfacePreset('wall', { id: 'wall', rectGeometry: { halfWidth: 4, halfHeight: 4 } })!)],
  })

  assert.equal(result.reason, 'blocked')
  assertVectorClose(offset(result.resolvedTransforms[1]!.transform.position, result.resolvedTransforms[0]!.transform.position), [1.5, 0.25, 0])
})

test('earliest member limits group', () => {
  const wall = surface(createWorldCollisionSurfacePreset('wall', { id: 'wall', rectGeometry: { halfWidth: 4, halfHeight: 4 } })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('near', [0, 0, -1]), boxItem('far', [0, 0, -3])],
    desiredTransforms: [
      { id: 'near', transform: transform([0, 0, 1]) },
      { id: 'far', transform: transform([0, 0, -1]) },
    ],
    surfaces: [wall],
  })

  assert.equal(result.reason, 'blocked')
  assertClose(result.resolvedTransforms.find((entry) => entry.id === 'near')!.transform.position[2], -0.5001, 3e-4)
  assertClose(result.resolvedTransforms.find((entry) => entry.id === 'far')!.transform.position[2], -2.5001, 3e-4)
})

test('snap one member shifts whole group', () => {
  const floor = surface(createWorldCollisionSurfacePreset('floor', {
    id: 'floor',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('a', [0, 0.68, 0]), boxItem('b', [1.5, 1.1, 0], [0, 0.4, 0])],
    desiredTransforms: [
      { id: 'a', transform: transform([0, 0.68, 0]) },
      { id: 'b', transform: transform([1.5, 1.1, 0], [0, 0.4, 0]) },
    ],
    surfaces: [floor],
    options: { snapDistance: 0.25 },
  })

  assert.equal(result.reason, 'snapped')
  const deltaA = offset(result.resolvedTransforms.find((entry) => entry.id === 'a')!.transform.position, [0, 0.68, 0])
  const deltaB = offset(result.resolvedTransforms.find((entry) => entry.id === 'b')!.transform.position, [1.5, 1.1, 0])
  assertVectorClose(deltaA, deltaB)
})

test('no snap beyond threshold', () => {
  const floor = surface(createWorldCollisionSurfacePreset('floor', {
    id: 'floor',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('item', [0, 1.2, 0])],
    desiredTransforms: [{ id: 'item', transform: transform([0, 1.2, 0]) }],
    surfaces: [floor],
    options: { snapDistance: 0.1 },
  })

  assert.equal(result.reason, 'free')
  assert.equal(result.snappedSurfaceId, null)
})

test('deterministic tie chooses smallest correction then surface id then item id', () => {
  const leftFloor = surface(createWorldCollisionSurfacePreset('floor', {
    id: 'a-floor',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)
  const rightFloor = surface(createWorldCollisionSurfacePreset('floor', {
    id: 'b-floor',
    rectGeometry: { halfWidth: 4, halfHeight: 4 },
  })!)
  const result = place({
    mode: 'translate',
    items: [boxItem('b-item', [0, 0.68, 0]), boxItem('a-item', [2, 0.68, 0])],
    desiredTransforms: [
      { id: 'b-item', transform: transform([0, 0.68, 0]) },
      { id: 'a-item', transform: transform([2, 0.68, 0]) },
    ],
    surfaces: [rightFloor, leftFloor],
    options: { snapDistance: 0.25 },
  })

  assert.equal(result.reason, 'snapped')
  assert.equal(result.snappedSurfaceId, 'a-floor')
})

test('invalid or missing bounds fail safely', () => {
  const result = place({
    mode: 'translate',
    items: [{
      id: 'bad',
      localBounds: null,
      startTransform: transform([0, 0, 0]),
    }],
    desiredTransforms: [{ id: 'bad', transform: transform([1, 0, 0]) }],
    surfaces: [],
  })

  assert.equal(result.valid, false)
  assert.equal(result.reason, 'invalid-candidate')
})

test('no surfaces unchanged', () => {
  const result = place({
    mode: 'translate',
    items: [boxItem('item', [1, 2, 3])],
    desiredTransforms: [{ id: 'item', transform: transform([2, 2.5, 4]) }],
    surfaces: [],
  })

  assert.equal(result.valid, true)
  assert.equal(result.reason, 'free')
  assert.deepEqual(result.resolvedTransforms[0]!.transform.position, [2, 2.5, 4])
  assert.deepEqual(result.acceptedTranslationDelta, [1, 0.5, 1])
})

function boxItem(
  id: string,
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): WorldsSurfacePlacementItemDescriptor {
  return {
    id,
    localBounds: {
      min: { x: -0.5, y: -0.5, z: -0.5 },
      max: { x: 0.5, y: 0.5, z: 0.5 },
    },
    startTransform: transform(position, rotation, scale),
  }
}

function transform(
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): WorldsSurfacePlacementTransform {
  return { position: [...position], rotation: [...rotation], scale: [...scale] }
}

function surface(input: Parameters<typeof resolveWorldCollisionSurface>[0]) {
  const resolved = resolveWorldCollisionSurface(input)
  assert.ok(resolved)
  return resolved!
}

function place(input: Parameters<typeof resolveWorldsSurfacePlacement>[0]) {
  return resolveWorldsSurfacePlacement(input)
}

function offset(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

function assertVectorClose(actual: [number, number, number], expected: [number, number, number], tolerance = EPSILON): void {
  assertClose(actual[0], expected[0], tolerance)
  assertClose(actual[1], expected[1], tolerance)
  assertClose(actual[2], expected[2], tolerance)
}

function assertClose(actual: number, expected: number, tolerance = EPSILON): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`)
}
