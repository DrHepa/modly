import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWorldCollisionSurface } from './worldsSurfaceMath.ts'
import {
  LEGACY_COLLISION_SURFACE_SLAB_THICKNESS_RATIO_THRESHOLD,
  convertLegacyCollisionZoneToSurface,
} from './worldsLegacyCollisionSurfaceConversion.ts'

test('legacy floor slab converts to one rect surface', () => {
  const result = convertLegacyCollisionZoneToSurface({
    id: 'floor-zone-1',
    label: 'Floor zone 1',
    shape: 'box',
    preset: 'floor-zone',
    transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1.8, 0.15, 2.4] },
  })

  assert.equal(result.success, true)
  if (result.success) {
    assert.equal(result.surface.id, 'floor-zone-1')
    assert.equal(result.surface.label, 'Floor zone 1')
    assert.equal(result.surface.preset, 'floor')
    assert.equal(result.surface.shape, 'rect')
    assert.deepEqual(result.surface.transform.scale, [1.8, 1, 2.4])
  }
})

test('legacy wall slab converts to one rect surface', () => {
  const result = convertLegacyCollisionZoneToSurface({
    id: 'wall-1',
    label: 'Wall 1',
    shape: 'box',
    preset: 'wall',
    transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [2.4, 2.1, 0.2] },
  })

  assert.equal(result.success, true)
  if (result.success) {
    assert.equal(result.surface.preset, 'wall')
    assert.deepEqual(result.surface.transform.scale, [2.4, 1, 2.1])
  }
})

test('legacy rotated slab preserves world plane orientation and extents', () => {
  const result = convertLegacyCollisionZoneToSurface({
    id: 'rotated-wall',
    shape: 'box',
    preset: 'wall',
    transform: { position: [4, 5, 6], rotation: [0.25, 0.5, -0.3], scale: [3.2, 2.4, 0.2] },
  })

  assert.equal(result.success, true)
  if (result.success) {
    const resolved = resolveWorldCollisionSurface(result.surface)
    assert.ok(resolved)
    assert.equal(resolved?.shape, 'rect')
    assertClose(vectorLength(resolved!.normal), 1)
    assertClose(distance(resolved!.worldCorners[0], resolved!.worldCorners[3]), 3.2)
    assertClose(distance(resolved!.worldCorners[0], resolved!.worldCorners[1]), 2.4)
  }
})

test('legacy blocker conversion is rejected for reauthoring', () => {
  const result = convertLegacyCollisionZoneToSurface({
    id: 'blocker-1',
    shape: 'box',
    preset: 'blocker',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1.2, 1.2, 1.2] },
  })

  assert.deepEqual(result, {
    success: false,
    reason: 'unsupported-preset',
    error: 'Legacy collision zone "blocker-1" uses blocker, which must be reauthored as explicit planar surfaces.',
    warnings: [],
  })
})

test('legacy thick wall and floor slabs are rejected when they exceed the deterministic ratio threshold', () => {
  const thickWall = convertLegacyCollisionZoneToSurface({
    id: 'wall-thick',
    shape: 'box',
    preset: 'wall',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 0.5] },
  })
  const thickFloor = convertLegacyCollisionZoneToSurface({
    id: 'floor-thick',
    shape: 'box',
    preset: 'floor-zone',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 0.5, 2] },
  })

  assert.equal(thickWall.success, false)
  assert.equal(thickWall.reason, 'not-slab-like')
  assert.equal(thickFloor.success, false)
  assert.equal(thickFloor.reason, 'not-slab-like')
  assert.ok(thickWall.error.includes(String(LEGACY_COLLISION_SURFACE_SLAB_THICKNESS_RATIO_THRESHOLD)))
})

function distance(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }): number {
  const dx = left.x - right.x
  const dy = left.y - right.y
  const dz = left.z - right.z
  return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz))
}

function vectorLength(vector: { x: number; y: number; z: number }): number {
  return Math.sqrt((vector.x * vector.x) + (vector.y * vector.y) + (vector.z * vector.z))
}

function assertClose(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`)
}
