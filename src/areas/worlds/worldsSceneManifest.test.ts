import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWorldsSceneManifest,
  createDefaultWorldsSceneManifestPath,
  decodeBase64Utf8,
  parseWorldsSceneManifest,
  parseWorldsSceneManifestText,
  workspaceRelativePathFromAbsolute,
  normalizeWorldsWorkspacePath,
} from './worldsSceneManifest.ts'
import type { SceneArtifactManifestV1 } from '../../shared/types/artifacts.ts'
import type { WorldSceneItem } from './worldRenderableResolver.ts'
import { createWorldCollisionSurfacePreset } from './worldsCollisionSurfaces.ts'
import { WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA } from './worldsCollisionSurfaceManifest.ts'

function sceneItem(overrides: Partial<WorldSceneItem> = {}): WorldSceneItem {
  return {
    id: 'world:Workflows/hero.glb',
    workspacePath: 'Workflows/hero.glb',
    url: '/workspace/Workflows/hero.glb',
    kind: 'glb',
    role: 'asset',
    visible: true,
    transform: {
      position: [1, 2, 3],
      rotation: [0.1, 0.2, 0.3],
      scale: [2, 2, 2],
    },
    ...overrides,
  }
}

test('buildWorldsSceneManifest persists schema-compatible assets with numeric transforms', () => {
  const manifest = buildWorldsSceneManifest([sceneItem()], [], { now: new Date('2026-06-20T12:00:00.000Z') })

  assert.equal(manifest.schema, 'modly.scene-manifest.v1')
  assert.equal(manifest.sceneRoot, '.')
  assert.equal(manifest.generator, 'modly.worlds')
  assert.equal(manifest.createdAt, '2026-06-20T12:00:00.000Z')
  assert.deepEqual(manifest.assets, [
    {
      id: 'world:Workflows/hero.glb',
      name: 'hero.glb',
      role: 'asset',
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      visible: true,
      transform: {
        position: [1, 2, 3],
        rotation: [0.1, 0.2, 0.3],
        scale: [2, 2, 2],
      },
    },
  ])
  assert.equal(manifest.collisionSurfaces, undefined)
  assert.equal(manifest.initialView, undefined)
})

test('scene manifest type and parser preserve a valid optional initial view', () => {
  const typedManifest: SceneArtifactManifestV1 = {
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    initialView: {
      position: [8, 5, 12],
      target: [1, 2, 3],
      up: [0, 0, 1],
    },
    assets: [{
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }],
  }

  const parsed = parseWorldsSceneManifest(typedManifest)
  assert.equal(parsed.success, true)
  if (parsed.success !== true) return
  assert.deepEqual(parsed.manifest.initialView, {
    position: [8, 5, 12],
    target: [1, 2, 3],
    up: [0, 0, 1],
  })

  const withoutUp = parseWorldsSceneManifest({
    ...typedManifest,
    initialView: {
      position: [3, 2, 1],
      target: [0, 0, 0],
    },
  })
  assert.equal(withoutUp.success, true)
  if (withoutUp.success === true) {
    assert.deepEqual(withoutUp.manifest.initialView, {
      position: [3, 2, 1],
      target: [0, 0, 0],
    })
  }

  const built = buildWorldsSceneManifest([sceneItem()], [], {
    initialView: typedManifest.initialView,
  })
  assert.deepEqual(built.initialView, typedManifest.initialView)
  assert.notEqual(built.initialView, typedManifest.initialView)
})

test('parseWorldsSceneManifest rejects invalid initial view vectors', () => {
  const assetManifest = {
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    assets: [{
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }],
  }

  assert.deepEqual(parseWorldsSceneManifest({
    ...assetManifest,
    initialView: { position: [0, 1, Number.POSITIVE_INFINITY], target: [0, 0, 0] },
  }), {
    success: false,
    error: 'Worlds scene manifest initialView position and target must be finite numeric triples.',
  })
  assert.deepEqual(parseWorldsSceneManifest({
    ...assetManifest,
    initialView: { position: [1, 2, 3], target: [1, 2, 3] },
  }), {
    success: false,
    error: 'Worlds scene manifest initialView position and target must differ.',
  })
  assert.deepEqual(parseWorldsSceneManifest({
    ...assetManifest,
    initialView: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 0] },
  }), {
    success: false,
    error: 'Worlds scene manifest initialView up must be a non-zero finite numeric triple.',
  })
})

test('buildWorldsSceneManifest persists selected base-scene roles', () => {
  const manifest = buildWorldsSceneManifest([sceneItem({ role: 'base-scene' })], [], { now: new Date('2026-06-20T12:00:00.000Z') })

  assert.equal(manifest.assets[0].role, 'base-scene')
})

test('buildWorldsSceneManifest round-trips Gaussian PLY scene items', () => {
  const manifest = buildWorldsSceneManifest([sceneItem({
    id: 'world:Workflows/gaussian.ply',
    workspacePath: 'Workflows/gaussian.ply',
    url: '/workspace/Workflows/gaussian.ply',
    kind: 'gaussian-ply',
  })], [], { now: new Date('2026-06-20T12:00:00.000Z') })

  assert.equal(manifest.assets[0].kind, 'gaussian-ply')

  const parsed = parseWorldsSceneManifest(manifest, { apiUrl: 'http://127.0.0.1:8000' })
  assert.equal(parsed.success, true)
  if (parsed.success !== true) return
  assert.equal(parsed.sceneItems[0].kind, 'gaussian-ply')
  assert.equal(parsed.manifest.assets[0].kind, 'gaussian-ply')
})

test('buildWorldsSceneManifest persists pose-clip animation bindings', () => {
  const manifest = buildWorldsSceneManifest([sceneItem({
    animation: {
      kind: 'pose-clip',
      sidecarWorkspacePath: 'Workflows/Motions/walk.pose-clip.v1.json',
      legacySidecarWorkspacePath: 'Workflows/Motions/walk.legacy.json',
      sourceWorkspacePath: 'Workflows/hero.glb',
      clipId: 'walk',
      clipName: 'Walk',
      durationSeconds: 1.5,
    },
  })], [], { now: new Date('2026-06-20T12:00:00.000Z') })

  assert.deepEqual(manifest.assets[0].animation, {
    kind: 'pose-clip',
    sidecarWorkspacePath: 'Workflows/Motions/walk.pose-clip.v1.json',
    legacySidecarWorkspacePath: 'Workflows/Motions/walk.legacy.json',
    sourceWorkspacePath: 'Workflows/hero.glb',
    clipId: 'walk',
    clipName: 'Walk',
    durationSeconds: 1.5,
  })
})

test('buildWorldsSceneManifest writes an optional collision surface fragment with the surface schema', () => {
  const rect = createWorldCollisionSurfacePreset('rectangle', {
    id: 'surface-rect',
    transform: { position: [1, 2, 3], rotation: [0, 0.5, 0], scale: [4, 9, 6] },
  })
  const tri = createWorldCollisionSurfacePreset('triangle', {
    id: 'surface-tri',
    sidedness: 'front',
    transform: { position: [4, 5, 6], rotation: [0.1, 0.2, 0.3], scale: [2, 7, 3] },
  })
  assert.ok(rect)
  assert.ok(tri)

  const manifest = buildWorldsSceneManifest([sceneItem()], [rect!, tri!])

  assert.equal(manifest.assets[0].collision, undefined)
  assert.equal(manifest.collisionSurfaces?.schema, WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA)
  assert.deepEqual(manifest.collisionSurfaces?.surfaces, [
    {
      id: 'surface-rect',
      label: 'Rectangle',
      preset: 'rectangle',
      sidedness: 'double',
      shape: 'rect',
      transform: {
        position: [1, 2, 3],
        rotation: [0, 0.5, 0],
        scale: [4, 1, 6],
      },
      geometry: {
        halfWidth: 1,
        halfHeight: 0.5,
      },
    },
    {
      id: 'surface-tri',
      label: 'Triangle',
      preset: 'triangle',
      sidedness: 'front',
      shape: 'tri',
      transform: {
        position: [4, 5, 6],
        rotation: [0.1, 0.2, 0.3],
        scale: [2, 1, 3],
      },
      geometry: {
        vertices: [[-0.5, -0.5], [-0.5, 0.5], [0.5, -0.5]],
      },
    },
  ])
})

test('parseWorldsSceneManifest restores scene items and preserves future base-scene roles', () => {
  const result = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    assets: [
      {
        id: 'base',
        role: 'base-scene',
        workspacePath: 'Workflows/world/base.gltf',
        kind: 'gltf',
        visible: false,
        transform: { position: [0, 0, 0], rotation: [0, 0.5, 0], scale: [1, 1, 1] },
      },
      {
        id: 'base',
        workspacePath: 'Exports/prop.ply',
        kind: 'ply-mesh',
        transform: { position: [4, 5, 6], rotation: [0, 0, 0], scale: [0.5, 0.5, 0.5] },
      },
    ],
  }, { apiUrl: 'http://127.0.0.1:8000' })

  assert.equal(result.success, true)
  if (result.success !== true) return
  assert.deepEqual(result.sceneItems.map((item) => ({ id: item.id, workspacePath: item.workspacePath, url: item.url, kind: item.kind, role: item.role, visible: item.visible, transform: item.transform })), [
    {
      id: 'base',
      workspacePath: 'Workflows/world/base.gltf',
      url: 'http://127.0.0.1:8000/workspace/Workflows/world/base.gltf',
      kind: 'gltf',
      role: 'base-scene',
      visible: false,
      transform: { position: [0, 0, 0], rotation: [0, 0.5, 0], scale: [1, 1, 1] },
    },
    {
      id: 'base#2',
      workspacePath: 'Exports/prop.ply',
      url: 'http://127.0.0.1:8000/workspace/Exports/prop.ply',
      kind: 'ply-mesh',
      role: 'asset',
      visible: true,
      transform: { position: [4, 5, 6], rotation: [0, 0, 0], scale: [0.5, 0.5, 0.5] },
    },
  ])
  assert.equal(result.manifest.assets[0].role, 'base-scene')
})

test('parseWorldsSceneManifest restores pose-clip bindings and rejects unsafe animation paths', () => {
  const result = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    assets: [{
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      animation: {
        kind: 'pose-clip',
        sidecarWorkspacePath: 'Workflows/Motions/walk.pose-clip.v1.json',
        sourceWorkspacePath: 'Workflows/hero.glb',
        clipName: 'Walk',
        durationSeconds: 2,
      },
    }],
  })

  assert.equal(result.success, true)
  if (result.success === true) {
    assert.deepEqual(result.sceneItems[0].animation, {
      kind: 'pose-clip',
      sidecarWorkspacePath: 'Workflows/Motions/walk.pose-clip.v1.json',
      sourceWorkspacePath: 'Workflows/hero.glb',
      clipName: 'Walk',
      durationSeconds: 2,
    })
  }

  const unsafe = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    assets: [{
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      animation: { kind: 'pose-clip', sidecarWorkspacePath: '../escape.json', sourceWorkspacePath: 'Workflows/hero.glb' },
    }],
  })
  assert.deepEqual(unsafe, { success: false, error: 'Worlds scene asset 1 has an unsafe animation path.' })
})

test('parseWorldsSceneManifest rejects unsafe asset paths and invalid transforms', () => {
  const unsafe = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    assets: [{ workspacePath: '../escape.glb', kind: 'glb', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
  })
  assert.deepEqual(unsafe, { success: false, error: 'Worlds scene asset 1 has an unsafe workspacePath.' })

  const badTransform = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    assets: [{ workspacePath: 'Workflows/hero.glb', kind: 'glb', transform: { position: [0, 0, Number.NaN], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
  })
  assert.deepEqual(badTransform, { success: false, error: 'Worlds scene asset 1 has an invalid transform.' })
})

test('parseWorldsSceneManifest defaults missing collision surface fragments to an empty list', () => {
  const result = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    assets: [{
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }],
  })

  assert.equal(result.success, true)
  if (result.success === true) {
    assert.equal(result.sceneItems[0].collision, undefined)
    assert.deepEqual(result.collisionSurfaces, [])
    assert.equal(result.manifest.collisionSurfaces, undefined)
  }
})

test('parseWorldsSceneManifest rejects legacy top-level collisionZones with an actionable migration error', () => {
  const invalid = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    collisionZones: [{
      id: 'zone-1',
      shape: 'box',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 0, 1] },
    }],
    assets: [{
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }],
  })

  assert.deepEqual(invalid, {
    success: false,
    error: 'Worlds scene manifest uses legacy top-level collisionZones boxes. Convert or re-author them as collisionSurfaces before importing.',
  })
})

test('parseWorldsSceneManifest rejects legacy asset-attached collision boxes with an actionable migration error', () => {
  const result = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    assets: [{
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      collision: {
        enabled: true,
        zones: [{ id: 'zone-1', shape: 'box', offset: [1, 0, -1], size: [2, 3, 4] }],
      },
    }],
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Worlds scene asset 1 uses legacy asset collision boxes. Convert or re-author them as collisionSurfaces before importing.',
  })
})

test('parseWorldsSceneManifest roundtrips canonical rect and tri collision surfaces', () => {
  const result = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    collisionSurfaces: {
      schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
      surfaces: [
        {
          id: 'surface-rect',
          label: 'Floor',
          shape: 'rect',
          preset: 'floor',
          sidedness: 'double',
          transform: { position: [10, 0, 2], rotation: [0, Math.PI / 2, 0], scale: [3, 8, 4] },
          geometry: { halfWidth: 1.5, halfHeight: 2 },
        },
        {
          id: 'surface-tri',
          label: 'Ramp',
          shape: 'tri',
          preset: 'triangle',
          sidedness: 'front',
          transform: { position: [2, 1, 0], rotation: [0.2, 0.3, 0.4], scale: [2, 5, 3] },
          geometry: { vertices: [[-1, -1], [1, -1], [-1, 1]] },
        },
      ],
    },
    assets: [{
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }],
  })

  assert.equal(result.success, true)
  if (result.success !== true) return
  assert.equal(result.sceneItems[0].collision, undefined)
  assert.deepEqual(result.collisionSurfaces, [
    {
      id: 'surface-rect',
      label: 'Floor',
      shape: 'rect',
      preset: 'floor',
      sidedness: 'double',
      transform: { position: [10, 0, 2], rotation: [0, Math.PI / 2, 0], scale: [3, 1, 4] },
      geometry: { halfWidth: 1.5, halfHeight: 2 },
    },
    {
      id: 'surface-tri',
      label: 'Ramp',
      shape: 'tri',
      preset: 'triangle',
      sidedness: 'front',
      transform: { position: [2, 1, 0], rotation: [0.2, 0.3, 0.4], scale: [2, 1, 3] },
      geometry: { vertices: [[-1, -1], [-1, 1], [1, -1]] },
    },
  ])
  assert.equal(result.manifest.collisionSurfaces?.schema, WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA)
})

test('workspace path helpers require safe workspace-relative destinations', () => {
  assert.equal(normalizeWorldsWorkspacePath('Workflows/hero.glb'), 'Workflows/hero.glb')
  assert.equal(normalizeWorldsWorkspacePath('/outside/hero.glb'), null)
  assert.equal(normalizeWorldsWorkspacePath('Workflows/../hero.glb'), null)
  assert.equal(workspaceRelativePathFromAbsolute('/home/user/Modly/workspace/Exports/Worlds/scene-manifest.json', '/home/user/Modly/workspace'), 'Exports/Worlds/scene-manifest.json')
  assert.equal(workspaceRelativePathFromAbsolute('/home/user/Modly/outside/scene-manifest.json', '/home/user/Modly/workspace'), null)
})

test('createDefaultWorldsSceneManifestPath avoids fixed overwrite-prone scene manifest paths', () => {
  assert.equal(
    createDefaultWorldsSceneManifestPath(new Date(2026, 5, 20, 19, 35)),
    'Exports/Worlds/worlds-scene-2026-06-20-1935/scene-manifest.json',
  )
})
