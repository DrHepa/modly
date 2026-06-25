import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AssetLibraryListRequest,
  AssetLibraryOpenRequest,
} from '../../shared/types/assetLibrary.ts'
import {
  listWorldAssetLibraryRenderables,
  openWorldAssetLibraryRenderable,
} from './worldAssetLibraryService.ts'

const API_URL = 'http://127.0.0.1:8000'
const originalWindow = globalThis.window

function installLibraryWindow(stubs: {
  listCalls?: AssetLibraryListRequest[]
  openCalls?: AssetLibraryOpenRequest[]
}) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electron: {
        workspace: {
          library: {
            list: async () => {
              stubs.listCalls?.push({})
              return {
                success: true,
                entries: [
                  {
                    id: 'world-mesh',
                    workspacePath: 'Workflows/worldmirror/result/ply/fuse_simplified.ply',
                    displayName: 'Fuse simplified',
                    sourceScope: 'workflows',
                    capability: 'generated-world',
                    state: 'ready',
                    previewKind: '3d-model',
                    warnings: [],
                    provenance: { graphId: 'hidden' },
                  },
                  {
                    id: 'export-mesh',
                    workspacePath: 'Exports/hero.glb',
                    displayName: 'Hero export',
                    sourceScope: 'exports',
                    capability: 'mesh',
                    state: 'ready',
                    previewKind: '3d-model',
                    warnings: [],
                  },
                  {
                    id: 'gaussian',
                    workspacePath: 'Workflows/worldmirror/result/point_cloud_1499.spz',
                    displayName: 'Gaussian splat',
                    sourceScope: 'workflows',
                    capability: 'generated-world',
                    state: 'ready',
                    previewKind: 'binary',
                    warnings: ['hidden detail'],
                  },
                  {
                    id: 'saved-scene',
                    workspacePath: 'Exports/Worlds/scene-manifest.json',
                    displayName: 'Saved scene',
                    sourceScope: 'exports',
                    capability: 'scene-manifest',
                    state: 'ready',
                    previewKind: 'text',
                    warnings: [],
                  },
                  {
                    id: 'walk-motion',
                    workspacePath: 'Workflows/Motions/walk.pose-clip.v1.json',
                    displayName: 'Walk motion',
                    sourceScope: 'workflows',
                    capability: 'animation-motion',
                    state: 'ready',
                    previewKind: 'text',
                    warnings: [],
                    source: { relation: 'sidecar-source', workspacePath: 'Workflows/Characters/hero.glb' },
                  },
                  {
                    id: 'unsafe',
                    workspacePath: '../outside/hero.glb',
                    displayName: '',
                    sourceScope: 'workflows',
                    capability: 'mesh',
                    state: 'ready',
                    previewKind: '3d-model',
                    warnings: [],
                  },
                ],
              }
            },
            open: async (request: AssetLibraryOpenRequest) => {
              stubs.openCalls?.push(request)
              return {
                success: true,
                entry: {
                  id: 'opened-world',
                  workspacePath: request.workspacePath,
                  displayName: 'Opened world',
                  sourceScope: 'workflows',
                  capability: 'generated-world',
                  state: 'ready',
                  previewKind: '3d-model',
                  warnings: [],
                  provenance: { graphId: 'hidden' },
                },
              }
            },
          },
        },
      },
    },
  })
}

test.afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  })
})

test('world asset library service lists shared-contract workspace renderables across scopes', async () => {
  const listCalls: AssetLibraryListRequest[] = []
  installLibraryWindow({ listCalls })

  const result = await listWorldAssetLibraryRenderables(API_URL)

  assert.deepEqual(listCalls, [{}])
  assert.equal(result.success, true)
  if (result.success !== true) return

  assert.equal(result.assets.length, 6)
  assert.deepEqual(result.assets.map((asset) => ({ id: asset.id, sourceScope: asset.sourceScope, capability: asset.capability, displayName: asset.displayName, openable: asset.openable })), [
    { id: 'world-mesh', sourceScope: 'workflows', capability: 'generated-world', displayName: 'Fuse simplified', openable: true },
    { id: 'export-mesh', sourceScope: 'exports', capability: 'mesh', displayName: 'Hero export', openable: true },
    { id: 'gaussian', sourceScope: 'workflows', capability: 'generated-world', displayName: 'Gaussian splat', openable: false },
    { id: 'saved-scene', sourceScope: 'exports', capability: 'scene-manifest', displayName: 'Saved scene', openable: true },
    { id: 'walk-motion', sourceScope: 'workflows', capability: 'animation-motion', displayName: 'Walk motion', openable: true },
    { id: 'unsafe', sourceScope: 'workflows', capability: 'mesh', displayName: '../outside/hero.glb', openable: false },
  ])

  const worldMesh = result.assets[0]
  assert.equal(worldMesh.openable, true)
  if (worldMesh.openable === true && 'item' in worldMesh) {
    assert.deepEqual(worldMesh.item, {
      id: 'world:Workflows/worldmirror/result/ply/fuse_simplified.ply',
      workspacePath: 'Workflows/worldmirror/result/ply/fuse_simplified.ply',
      url: 'http://127.0.0.1:8000/workspace/Workflows/worldmirror/result/ply/fuse_simplified.ply',
      kind: 'ply-mesh',
      role: 'asset',
      visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    })
  }
  assert.equal(result.assets[2].openable, false)
  if (result.assets[2].openable === false) assert.equal(result.assets[2].reason, 'unsupported-spz')
  assert.equal(result.assets[3].openable, true)
  if (result.assets[3].openable === true) assert.equal('sceneManifest' in result.assets[3], true)
  assert.equal(result.assets[4].openable, true)
  if (result.assets[4].openable === true && 'poseClip' in result.assets[4]) {
    assert.equal(result.assets[4].type, 'Pose clip')
    assert.deepEqual(result.assets[4].animation, {
      kind: 'pose-clip',
      sidecarWorkspacePath: 'Workflows/Motions/walk.pose-clip.v1.json',
      sourceWorkspacePath: 'Workflows/Characters/hero.glb',
    })
    assert.equal(result.assets[4].linkedItem?.workspacePath, 'Workflows/Characters/hero.glb')
  }
  assert.deepEqual(result.assets[0].warnings, [])
  assert.deepEqual(result.assets[2].warnings, ['hidden detail'])
})

test('world asset library service opens safe Workflows renderables and rejects unsafe requests before preload', async () => {
  const openCalls: AssetLibraryOpenRequest[] = []
  installLibraryWindow({ openCalls })

  const opened = await openWorldAssetLibraryRenderable({ workspacePath: 'Workflows/worldmirror/result/ply/fuse_post.ply' }, API_URL)

  assert.deepEqual(openCalls, [{ workspacePath: 'Workflows/worldmirror/result/ply/fuse_post.ply' }])
  assert.equal(opened.success, true)
  if (opened.success === true) {
    assert.equal(opened.asset.openable, true)
    assert.equal(opened.asset.openable === true && 'item' in opened.asset ? opened.asset.item.kind : 'missing', 'ply-mesh')
    assert.equal(
      opened.asset.openable === true && 'item' in opened.asset ? opened.asset.item.url : 'missing',
      'http://127.0.0.1:8000/workspace/Workflows/worldmirror/result/ply/fuse_post.ply',
    )
  }

  await assert.rejects(
    () => openWorldAssetLibraryRenderable({ workspacePath: '/outside/fuse_post.ply' }, API_URL),
    /safe workspace-relative path/i,
  )
  assert.deepEqual(openCalls, [{ workspacePath: 'Workflows/worldmirror/result/ply/fuse_post.ply' }])
})
