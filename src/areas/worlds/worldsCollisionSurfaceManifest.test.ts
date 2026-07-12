import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorldCollisionSurfacePreset } from './worldsCollisionSurfaces.ts'
import {
  WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
  buildWorldsCollisionSurfaceManifest,
  createEmptyWorldsCollisionSurfaceManifest,
  parseWorldsCollisionSurfaceManifest,
  parseWorldsCollisionSurfaceManifestText,
  serializeWorldsCollisionSurfaceManifest,
} from './worldsCollisionSurfaceManifest.ts'

test('collision surface manifest provides a safe empty fragment', () => {
  assert.deepEqual(createEmptyWorldsCollisionSurfaceManifest(), {
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: [],
  })
})

test('collision surface manifest roundtrips empty and non-empty fragments', () => {
  const rect = createWorldCollisionSurfacePreset('square', {
    id: 'surface-1',
    transform: { position: [1, 2, 3], rotation: [0, 0.25, 0], scale: [2, 7, 4] },
  })
  const tri = createWorldCollisionSurfacePreset('triangle', {
    id: 'surface-2',
    sidedness: 'front',
    transform: { position: [4, 5, 6], rotation: [0.1, 0.2, 0.3], scale: [3, 9, 2] },
    triGeometry: { vertices: [[-1, -1], [1, -1], [-1, 1]] },
  })
  assert.ok(rect)
  assert.ok(tri)

  const empty = parseWorldsCollisionSurfaceManifest(createEmptyWorldsCollisionSurfaceManifest())
  assert.deepEqual(empty, {
    success: true,
    manifest: createEmptyWorldsCollisionSurfaceManifest(),
    surfaces: [],
  })

  const built = buildWorldsCollisionSurfaceManifest([rect!, tri!])
  const parsed = parseWorldsCollisionSurfaceManifestText(serializeWorldsCollisionSurfaceManifest([rect!, tri!]))
  assert.equal(parsed.success, true)
  assert.deepEqual(parsed, {
    success: true,
    manifest: built,
    surfaces: built.surfaces,
  })
})

test('collision surface manifest defaults sidedness to double during parse', () => {
  const parsed = parseWorldsCollisionSurfaceManifest({
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: [{
      id: 'surface-1',
      shape: 'rect',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 99, 4] },
      geometry: { halfWidth: 1, halfHeight: 2 },
    }],
  })

  assert.equal(parsed.success, true)
  if (parsed.success) {
    assert.equal(parsed.surfaces[0]?.sidedness, 'double')
    assert.deepEqual(parsed.surfaces[0]?.transform.scale, [2, 1, 4])
  }
})

test('collision surface manifest rejects duplicate ids and malformed structures', () => {
  assert.deepEqual(parseWorldsCollisionSurfaceManifest({
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: [
      {
        id: 'dup',
        shape: 'rect',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        geometry: { halfWidth: 1, halfHeight: 1 },
      },
      {
        id: 'dup',
        shape: 'tri',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        geometry: { vertices: [[0, 0], [0, 1], [1, 0]] },
      },
    ],
  }), {
    success: false,
    error: 'World collision surfaces must use unique ids; duplicate id "dup" was found.',
  })

  assert.deepEqual(parseWorldsCollisionSurfaceManifest({
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: [{
      id: 'bad-transform',
      shape: 'rect',
      transform: { position: [0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      geometry: { halfWidth: 1, halfHeight: 1 },
    }],
  }), {
    success: false,
    error: 'World collision surface 1 ("bad-transform") has an invalid transform.',
  })

  assert.deepEqual(parseWorldsCollisionSurfaceManifest({
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: [{
      id: 'bad-rect',
      shape: 'rect',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      geometry: { halfWidth: 0, halfHeight: 1 },
    }],
  }), {
    success: false,
    error: 'World collision surface 1 ("bad-rect") has invalid rect geometry.',
  })

  assert.deepEqual(parseWorldsCollisionSurfaceManifest({
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: [{
      id: 'bad-tri',
      shape: 'tri',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      geometry: { vertices: [[0, 0], [1, 1], [2, 2]] },
    }],
  }), {
    success: false,
    error: 'World collision surface 1 ("bad-tri") has a degenerate or non-finite triangle.',
  })
})

test('collision surface manifest canonicalizes triangle winding and rejects preset mismatches', () => {
  const parsed = parseWorldsCollisionSurfaceManifest({
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: [{
      id: 'tri-1',
      shape: 'tri',
      preset: 'triangle',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      geometry: { vertices: [[-1, -1], [1, -1], [-1, 1]] },
    }],
  })

  assert.equal(parsed.success, true)
  if (parsed.success) {
    assert.deepEqual(parsed.surfaces[0]?.geometry.vertices, [[-1, -1], [-1, 1], [1, -1]])
  }

  assert.deepEqual(parseWorldsCollisionSurfaceManifest({
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: [{
      id: 'tri-2',
      shape: 'tri',
      preset: 'square',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      geometry: { vertices: [[0, 0], [0, 1], [1, 0]] },
    }],
  }), {
    success: false,
    error: 'World collision surface 1 ("tri-2") uses preset "square" which is incompatible with shape tri.',
  })
})

test('collision surface manifest clones on input and output boundaries', () => {
  const source = createWorldCollisionSurfacePreset('triangle', {
    id: 'immutability-1',
    transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 8, 3] },
  })
  assert.ok(source)

  const manifest = buildWorldsCollisionSurfaceManifest([source!])
  source!.transform.position[0] = 99
  if (source!.shape === 'tri') source!.geometry.vertices[0][0] = 42
  assert.equal(manifest.surfaces[0]?.transform.position[0], 1)
  assert.equal(manifest.surfaces[0]?.shape, 'tri')
  assert.equal(manifest.surfaces[0]?.geometry.vertices[0][0], -0.5)

  const parsed = parseWorldsCollisionSurfaceManifest(manifest)
  assert.equal(parsed.success, true)
  if (parsed.success) {
    parsed.manifest.surfaces[0]!.transform.position[0] = -5
    parsed.surfaces[0]!.transform.position[0] = -10
    assert.equal(manifest.surfaces[0]?.transform.position[0], 1)
  }
})

test('collision surface manifest does not convert legacy box definitions automatically', () => {
  assert.deepEqual(parseWorldsCollisionSurfaceManifest({
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: [{
      id: 'legacy-box-1',
      shape: 'box',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }],
  }), {
    success: false,
    error: 'World collision surface 1 ("legacy-box-1") must use shape rect or tri.',
  })
})
