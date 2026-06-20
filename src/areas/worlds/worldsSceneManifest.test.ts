import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWorldsSceneManifest,
  parseWorldsSceneManifest,
  workspaceRelativePathFromAbsolute,
  normalizeWorldsWorkspacePath,
} from './worldsSceneManifest.ts'
import type { WorldSceneItem } from './worldRenderableResolver.ts'

function sceneItem(overrides: Partial<WorldSceneItem> = {}): WorldSceneItem {
  return {
    id: 'world:Workflows/hero.glb',
    workspacePath: 'Workflows/hero.glb',
    url: '/workspace/Workflows/hero.glb',
    kind: 'glb',
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
  const manifest = buildWorldsSceneManifest([sceneItem()], { now: new Date('2026-06-20T12:00:00.000Z') })

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
  assert.deepEqual(result.sceneItems.map((item) => ({ id: item.id, workspacePath: item.workspacePath, url: item.url, kind: item.kind, visible: item.visible, transform: item.transform })), [
    {
      id: 'base',
      workspacePath: 'Workflows/world/base.gltf',
      url: 'http://127.0.0.1:8000/workspace/Workflows/world/base.gltf',
      kind: 'gltf',
      visible: false,
      transform: { position: [0, 0, 0], rotation: [0, 0.5, 0], scale: [1, 1, 1] },
    },
    {
      id: 'base#2',
      workspacePath: 'Exports/prop.ply',
      url: 'http://127.0.0.1:8000/workspace/Exports/prop.ply',
      kind: 'ply-mesh',
      visible: true,
      transform: { position: [4, 5, 6], rotation: [0, 0, 0], scale: [0.5, 0.5, 0.5] },
    },
  ])
  assert.equal(result.manifest.assets[0].role, 'base-scene')
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

test('workspace path helpers require safe workspace-relative destinations', () => {
  assert.equal(normalizeWorldsWorkspacePath('Workflows/hero.glb'), 'Workflows/hero.glb')
  assert.equal(normalizeWorldsWorkspacePath('/outside/hero.glb'), null)
  assert.equal(normalizeWorldsWorkspacePath('Workflows/../hero.glb'), null)
  assert.equal(workspaceRelativePathFromAbsolute('/home/user/Modly/workspace/Exports/Worlds/scene-manifest.json', '/home/user/Modly/workspace'), 'Exports/Worlds/scene-manifest.json')
  assert.equal(workspaceRelativePathFromAbsolute('/home/user/Modly/outside/scene-manifest.json', '/home/user/Modly/workspace'), null)
})
