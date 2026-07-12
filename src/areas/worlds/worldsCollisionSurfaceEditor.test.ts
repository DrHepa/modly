import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorldCollisionSurfacePreset } from './worldsCollisionSurfaces.ts'
import {
  addWorldCollisionSurface,
  createWorldCollisionSurfaceId,
  duplicateWorldCollisionSurface,
  getWorldCollisionSurfaceDuplicateOffset,
  removeWorldCollisionSurface,
  updateWorldCollisionSurfaceRectGeometry,
  updateWorldCollisionSurfaceTransform,
  updateWorldCollisionSurfaceTriangleGeometry,
} from './worldsCollisionSurfaceEditor.ts'

test('collision surface editor uses deterministic ids', () => {
  assert.equal(createWorldCollisionSurfaceId([]), 'collision-surface-1')
  assert.equal(createWorldCollisionSurfaceId([{ id: 'collision-surface-1' } as never, { id: 'custom' } as never, { id: 'collision-surface-4' } as never]), 'collision-surface-5')
})

test('collision surface editor adds each preset with optional anchor transform', () => {
  const rectangle = addWorldCollisionSurface([], 'rectangle', {
    anchorTransform: { position: [1, 2, 3], scale: [2, 5, 4] },
  })
  const square = addWorldCollisionSurface(rectangle.surfaces, 'square')
  const triangle = addWorldCollisionSurface(square.surfaces, 'triangle')
  const wall = addWorldCollisionSurface(triangle.surfaces, 'wall')
  const floor = addWorldCollisionSurface(wall.surfaces, 'floor')
  const ramp = addWorldCollisionSurface(floor.surfaces, 'ramp')

  assert.equal(rectangle.selectedSurfaceId, 'collision-surface-1')
  assert.deepEqual(rectangle.surfaces[0]?.transform, {
    position: [1, 2, 3],
    rotation: [0, 0, 0],
    scale: [2, 1, 4],
  })
  assert.deepEqual(ramp.surfaces.map((surface) => surface.preset), ['rectangle', 'square', 'triangle', 'wall', 'floor', 'ramp'])
})

test('collision surface editor updates transform and geometry immutably', () => {
  const rect = createWorldCollisionSurfacePreset('rectangle', { id: 'surface-1' })!
  const tri = createWorldCollisionSurfacePreset('triangle', { id: 'surface-2' })!
  const surfaces = [rect, tri]

  const nextTransform = updateWorldCollisionSurfaceTransform(surfaces, 'surface-1', {
    position: [5, 6, 7],
    rotation: [0.1, 0.2, 0.3],
    scale: [9, 4, 8],
  })
  assert.notEqual(nextTransform, surfaces)
  assert.notEqual(nextTransform[0], rect)
  assert.equal(nextTransform[1], tri)
  assert.deepEqual(nextTransform[0]?.transform, {
    position: [5, 6, 7],
    rotation: [0.1, 0.2, 0.3],
    scale: [9, 1, 8],
  })

  const nextRectGeometry = updateWorldCollisionSurfaceRectGeometry(nextTransform, 'surface-1', { halfWidth: 3, halfHeight: 2 })
  assert.equal(nextRectGeometry[1], tri)
  assert.equal(nextRectGeometry[0]?.shape, 'rect')
  if (nextRectGeometry[0]?.shape === 'rect') {
    assert.deepEqual(nextRectGeometry[0].geometry, { halfWidth: 3, halfHeight: 2 })
  }

  const nextTriGeometry = updateWorldCollisionSurfaceTriangleGeometry(nextRectGeometry, 'surface-2', [[-1, -1], [1, -1], [-1, 1]])
  assert.equal(nextTriGeometry[0], nextRectGeometry[0])
  assert.equal(nextTriGeometry[1]?.shape, 'tri')
  if (nextTriGeometry[1]?.shape === 'tri') {
    assert.deepEqual(nextTriGeometry[1].geometry.vertices, [[-1, -1], [-1, 1], [1, -1]])
  }
})

test('collision surface editor removes independently of selection order', () => {
  const one = createWorldCollisionSurfacePreset('rectangle', { id: 'surface-1' })!
  const two = createWorldCollisionSurfacePreset('square', { id: 'surface-2' })!
  const three = createWorldCollisionSurfacePreset('triangle', { id: 'surface-3' })!

  assert.deepEqual(removeWorldCollisionSurface([one, two, three], 'surface-2'), {
    surfaces: [one, three],
    selectedSurfaceId: 'surface-3',
  })
})

test('collision surface editor duplicates with deterministic offset and unique id', () => {
  const source = createWorldCollisionSurfacePreset('wall', {
    id: 'collision-surface-7',
    label: 'Wall 7',
    transform: { position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 1, 4] },
  })!
  const duplicate = duplicateWorldCollisionSurface([source], 'collision-surface-7')

  assert.equal(duplicate.selectedSurfaceId, 'collision-surface-8')
  assert.equal(duplicate.surfaces.length, 2)
  assert.equal(duplicate.surfaces[1]?.id, 'collision-surface-8')
  assert.equal(duplicate.surfaces[1]?.label, 'Wall 7 Copy')
  assert.deepEqual(duplicate.surfaces[1]?.transform.position, [
    1 + getWorldCollisionSurfaceDuplicateOffset()[0],
    2 + getWorldCollisionSurfaceDuplicateOffset()[1],
    3 + getWorldCollisionSurfaceDuplicateOffset()[2],
  ])
})

test('collision surface editor invalid updates fail safely', () => {
  const rect = createWorldCollisionSurfacePreset('rectangle', { id: 'surface-1' })!
  const tri = createWorldCollisionSurfacePreset('triangle', { id: 'surface-2' })!
  const surfaces = [rect, tri]

  assert.equal(updateWorldCollisionSurfaceTransform(surfaces, 'missing', rect.transform), surfaces)
  assert.equal(updateWorldCollisionSurfaceTransform(surfaces, 'surface-1', {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [0, 1, 1],
  }), surfaces)
  assert.equal(updateWorldCollisionSurfaceRectGeometry(surfaces, 'surface-2', { halfWidth: 1, halfHeight: 1 }), surfaces)
  assert.equal(updateWorldCollisionSurfaceRectGeometry(surfaces, 'surface-1', { halfWidth: 0, halfHeight: 1 }), surfaces)
  assert.equal(updateWorldCollisionSurfaceTriangleGeometry(surfaces, 'surface-1', [[0, 0], [0, 1], [1, 0]]), surfaces)
  assert.equal(updateWorldCollisionSurfaceTriangleGeometry(surfaces, 'surface-2', [[0, 0], [1, 1], [2, 2]]), surfaces)
})
