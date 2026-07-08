import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWorldsSceneManifest,
  createDefaultWorldsSceneManifestPath,
  parseWorldsSceneManifest,
  workspaceRelativePathFromAbsolute,
  normalizeWorldsWorkspacePath,
} from './worldsSceneManifest.ts'
import type { WorldSceneItem } from './worldRenderableResolver.ts'
import type { WorldCollisionZone } from './worldsCollisionZones.ts'

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
  assert.deepEqual(manifest.collisionZones, [])
})

test('buildWorldsSceneManifest persists selected base-scene roles', () => {
  const manifest = buildWorldsSceneManifest([sceneItem({ role: 'base-scene' })], [], { now: new Date('2026-06-20T12:00:00.000Z') })

  assert.equal(manifest.assets[0].role, 'base-scene')
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

test('buildWorldsSceneManifest persists scene-level collision zones separately from assets', () => {
  const collisionZones: WorldCollisionZone[] = [{
    id: 'zone-1',
    label: 'Door',
    shape: 'box',
    preset: 'blocker',
    transform: {
      position: [1, 2, 3],
      rotation: [0, 0.5, 0],
      scale: [4, 5, 6],
    },
  }]
  const manifest = buildWorldsSceneManifest([sceneItem()], collisionZones)

  assert.equal(manifest.assets[0].collision, undefined)
  assert.deepEqual(manifest.collisionZones, [
    {
      id: 'zone-1',
      label: 'Door',
      shape: 'box',
      preset: 'blocker',
      transform: {
        position: [1, 2, 3],
        rotation: [0, 0.5, 0],
        scale: [4, 5, 6],
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

test('parseWorldsSceneManifest restores scene-level collision zones and rejects invalid transforms', () => {
  const result = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    collisionZones: [{
      id: 'zone-1',
      shape: 'box',
      transform: { position: [1, 0, -1], rotation: [0, 0.25, 0], scale: [2, 3, 4] },
    }],
    assets: [{
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }],
  })

  assert.equal(result.success, true)
  if (result.success === true) {
    assert.equal(result.sceneItems[0].collision, undefined)
    assert.deepEqual(result.collisionZones, [{
      id: 'zone-1',
      shape: 'box',
      transform: { position: [1, 0, -1], rotation: [0, 0.25, 0], scale: [2, 3, 4] },
    }])
  }

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

  assert.deepEqual(invalid, { success: false, error: 'Worlds scene collision zone 1 has an invalid transform.' })
})

test('parseWorldsSceneManifest migrates legacy attached asset collisions into world collision zones for compatibility', () => {
  const result = parseWorldsSceneManifest({
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    assets: [{
      id: 'hero',
      workspacePath: 'Workflows/hero.glb',
      kind: 'glb',
      transform: { position: [10, 0, 2], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
      collision: {
        enabled: true,
        zones: [{ id: 'zone-1', shape: 'box', offset: [1, 0, -1], size: [2, 3, 4] }],
      },
    }],
  })

  assert.equal(result.success, true)
  if (result.success !== true) return
  assert.equal(result.sceneItems[0].collision, undefined)
  assert.deepEqual(result.collisionZones, [{
    id: 'hero:legacy:zone-1',
    shape: 'box',
    transform: {
      position: [11, 0, 1],
      rotation: [0, Math.PI / 2, 0],
      scale: [2, 3, 4],
    },
  }])
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
