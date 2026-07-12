import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cloneWorldCollisionSurface,
  createWorldCollisionSurfacePreset,
  getWorldCollisionSurfacePresetDefinition,
  normalizeWorldCollisionSurface,
} from './worldsCollisionSurfaces.ts'

test('preset definitions keep floor, wall, and ramp deterministic', () => {
  const floor = getWorldCollisionSurfacePresetDefinition('floor')
  const wall = getWorldCollisionSurfacePresetDefinition('wall')
  const ramp = getWorldCollisionSurfacePresetDefinition('ramp')

  assert.deepEqual(floor.transform.rotation, [0, 0, 0])
  assert.deepEqual(wall.transform.rotation, [-Math.PI / 2, 0, 0])
  assert.deepEqual(ramp.transform.rotation, [-Math.PI / 6, 0, 0])
})

test('square preset is represented as a rect with equal extents', () => {
  const square = createWorldCollisionSurfacePreset('square', { id: 'square-1' })

  assert.ok(square)
  assert.equal(square?.shape, 'rect')
  assert.deepEqual(square?.geometry, { halfWidth: 0.5, halfHeight: 0.5 })
})

test('triangle preset uses canonical positive-y winding', () => {
  const triangle = createWorldCollisionSurfacePreset('triangle', { id: 'tri-1' })

  assert.ok(triangle)
  assert.equal(triangle?.shape, 'tri')
  assert.deepEqual(triangle?.geometry.vertices, [
    [-0.5, -0.5],
    [-0.5, 0.5],
    [0.5, -0.5],
  ])
})

test('normalizeWorldCollisionSurface rejects NaN, zero, and negative planar data', () => {
  assert.equal(normalizeWorldCollisionSurface({
    id: 'bad-scale',
    shape: 'rect',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [0, 1, 1] },
    geometry: { halfWidth: 1, halfHeight: 1 },
  }), null)

  assert.equal(normalizeWorldCollisionSurface({
    id: 'bad-geo',
    shape: 'rect',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    geometry: { halfWidth: -1, halfHeight: 1 },
  }), null)

  assert.equal(normalizeWorldCollisionSurface({
    id: 'bad-tri',
    shape: 'tri',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    geometry: { vertices: [[0, 0], [1, 1], [2, 2]] },
  }), null)

  assert.equal(normalizeWorldCollisionSurface({
    id: 'bad-number',
    shape: 'rect',
    transform: { position: [Number.NaN, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    geometry: { halfWidth: 1, halfHeight: 1 },
  }), null)
})

test('normalizeWorldCollisionSurface canonicalizes scale.y and triangle winding', () => {
  const normalized = normalizeWorldCollisionSurface({
    id: 'tri-2',
    sidedness: 'front',
    shape: 'tri',
    transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 5, 3] },
    geometry: { vertices: [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5]] },
  })

  assert.ok(normalized)
  assert.deepEqual(normalized?.transform.scale, [2, 1, 3])
  assert.equal(normalized?.sidedness, 'front')
  assert.deepEqual(normalized?.geometry.vertices, [
    [-0.5, -0.5],
    [-0.5, 0.5],
    [0.5, -0.5],
  ])
})

test('cloneWorldCollisionSurface returns deep copies', () => {
  const source = createWorldCollisionSurfacePreset('triangle', {
    id: 'clone-me',
    transform: { position: [1, 2, 3], rotation: [0, 0.5, 0], scale: [2, 1, 3] },
  })
  assert.ok(source)

  const clone = cloneWorldCollisionSurface(source!)
  clone.transform.position[0] = 99
  if (clone.shape === 'tri') clone.geometry.vertices[0][0] = 42

  assert.equal(source?.transform.position[0], 1)
  assert.equal(source?.shape, 'tri')
  assert.equal(source?.geometry.vertices[0][0], -0.5)
})
