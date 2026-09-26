import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AssetLibraryListRequest,
  AssetLibraryOpenRequest,
  AssetLibraryReadRequest,
} from '../../shared/types/assetLibrary.ts'
import {
  listWorldAssetLibraryRenderables,
  openWorldAssetLibraryRenderable,
  projectWorldAssetLibraryListResult,
  projectWorldAssetLibraryOpenResult,
  readWorldAssetLibraryAudio,
} from './worldAssetLibraryService.ts'

const API_URL = 'http://127.0.0.1:8000'
const originalWindow = globalThis.window

function installLibraryWindow(stubs: {
  listCalls?: AssetLibraryListRequest[]
  openCalls?: AssetLibraryOpenRequest[]
  readCalls?: AssetLibraryReadRequest[]
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
                    plyKind: 'mesh',
                    previewKind: 'binary',
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
                    plyKind: 'mesh',
                    previewKind: '3d-model',
                    warnings: [],
                  },
                  {
                    id: 'gaussian',
                    workspacePath: 'Workflows/worldmirror/result/point_cloud_1499.ply',
                    displayName: 'Gaussian splat',
                    sourceScope: 'workflows',
                    state: 'unknown-metadata',
                    plyKind: 'gaussian',
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
                  {
                    id: 'impact-audio',
                    workspacePath: 'Workflows/Audio/impact.wav',
                    displayName: 'Impact',
                    sourceScope: 'workflows',
                    state: 'unknown-metadata',
                    previewKind: 'audio',
                    warnings: [],
                  },
                ],
              }
            },
            read: async (request: AssetLibraryReadRequest) => {
              stubs.readCalls?.push(request)
              return {
                success: true,
                entry: {
                  id: 'impact-audio', workspacePath: request.workspacePath, displayName: 'Impact',
                  sourceScope: 'workflows', state: 'unknown-metadata', previewKind: 'audio', warnings: [],
                },
                preview: { kind: 'audio', audioKind: 'wav', byteLength: 42, sourceUrl: 'workspace://impact.wav' },
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
                  ...(request.workspacePath.endsWith('.ply') ? { plyKind: 'mesh' as const, previewKind: 'binary' as const } : { previewKind: '3d-model' as const }),
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

  assert.equal(result.assets.length, 7)
  assert.deepEqual(result.assets.map((asset) => ({ id: asset.id, sourceScope: asset.sourceScope, capability: asset.capability, displayName: asset.displayName, openable: asset.openable })), [
    { id: 'world-mesh', sourceScope: 'workflows', capability: 'generated-world', displayName: 'Fuse simplified', openable: true },
    { id: 'export-mesh', sourceScope: 'exports', capability: 'mesh', displayName: 'Hero export', openable: true },
    { id: 'gaussian', sourceScope: 'workflows', capability: undefined, displayName: 'Gaussian splat', openable: false },
    { id: 'saved-scene', sourceScope: 'exports', capability: 'scene-manifest', displayName: 'Saved scene', openable: true },
    { id: 'walk-motion', sourceScope: 'workflows', capability: 'animation-motion', displayName: 'Walk motion', openable: true },
    { id: 'unsafe', sourceScope: 'workflows', capability: 'mesh', displayName: '../outside/hero.glb', openable: false },
    { id: 'impact-audio', sourceScope: 'workflows', capability: undefined, displayName: 'Impact', openable: true },
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
  const gaussian = result.assets[2]
  assert.equal(gaussian.openable, false)
  assert.equal(gaussian.workspacePath, 'Workflows/worldmirror/result/point_cloud_1499.ply')
  assert.equal(gaussian.plyKind, 'gaussian')
  if (gaussian.openable === false) {
    assert.equal(gaussian.type, 'Unsupported')
    assert.equal(gaussian.reason, 'unsupported-gaussian-ply')
  }
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

test('world asset library reads safe audio through preview authority without opening it as a model', async () => {
  const readCalls: AssetLibraryReadRequest[] = []
  installLibraryWindow({ readCalls })
  const result = await readWorldAssetLibraryAudio({ workspacePath: 'Workflows/Audio/impact.wav' })
  assert.deepEqual(readCalls, [{ workspacePath: 'Workflows/Audio/impact.wav' }])
  assert.deepEqual(result, {
    success: true,
    audio: { workspacePath: 'Workflows/Audio/impact.wav', format: 'wav', name: 'Impact' },
  })
  await assert.rejects(() => readWorldAssetLibraryAudio({ workspacePath: '../impact.wav' }), /safe workspace-relative path/i)
  await assert.rejects(() => readWorldAssetLibraryAudio({ workspacePath: 'Workflows/./Audio/impact.wav' }), /safe workspace-relative path/i)
  await assert.rejects(() => readWorldAssetLibraryAudio({ workspacePath: './Workflows/Audio/impact.wav' }), /safe workspace-relative path/i)
  const literal = await readWorldAssetLibraryAudio({ workspacePath: 'Workflows/Audio/impact sound – café.wav' })
  assert.deepEqual(literal, {
    success: true,
    audio: { workspacePath: 'Workflows/Audio/impact sound – café.wav', format: 'wav', name: 'Impact' },
  })
  for (const workspacePath of [
    'Workflows/Audio/impact%20sound.wav',
    'Workflows/Audio/%69mpact.wav',
    'Workflows/Audio/%2e/impact.wav',
    'Workflows/Audio%2Fimpact.wav',
    'Workflows/Audio%5Cimpact.wav',
    'Workflows/Audio/impact%00.wav',
    'Workflows/Audio/impact%0A.wav',
    'Workflows/Audio/%252e%252e%252Fimpact.wav',
    'Workflows/Audio/impact%2520sound.wav',
  ]) {
    await assert.rejects(() => readWorldAssetLibraryAudio({ workspacePath }), /safe workspace-relative path/i, workspacePath)
  }
  assert.deepEqual(readCalls, [
    { workspacePath: 'Workflows/Audio/impact.wav' },
    { workspacePath: 'Workflows/Audio/impact sound – café.wav' },
  ])
})

test('world asset library service fails safely when IPC success payload omits entries', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electron: {
        workspace: {
          library: {
            list: async () => ({ success: true }),
          },
        },
      },
    },
  })

  const result = await listWorldAssetLibraryRenderables(API_URL)
  assert.deepEqual(result, {
    success: false,
    error: 'Workspace asset-library returned an invalid entries payload.',
  })
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

test('world asset library projects bare WorldSculpt workflow GLBs as ready addable models', () => {
  const entry = {
    id: 'Workflows/worldsculpt-5a9cc08eaf924e988e527f75137ea8c4/scene.glb',
    workspacePath: 'Workflows/worldsculpt-5a9cc08eaf924e988e527f75137ea8c4/scene.glb',
    displayName: 'scene.glb',
    sourceScope: 'workflows' as const,
    capability: 'mesh' as const,
    state: 'ready' as const,
    previewKind: '3d-model' as const,
    warnings: [],
  }

  const listed = projectWorldAssetLibraryListResult({ success: true, entries: [entry] }, API_URL)
  const opened = projectWorldAssetLibraryOpenResult({ success: true, entry }, API_URL)

  assert.equal(listed.success, true)
  assert.equal(opened.success, true)
  if (listed.success !== true || opened.success !== true) return

  for (const asset of [listed.assets[0], opened.asset]) {
    assert.equal(asset.sourceScope, 'workflows')
    assert.equal(asset.capability, 'mesh')
    assert.equal(asset.openable, true)
    assert.equal(asset.type, 'GLB model')
    assert.equal(asset.state, 'ready')
    assert.equal(asset.openable === true && 'item' in asset ? asset.item.kind : 'missing', 'glb')
    assert.equal(
      asset.openable === true && 'item' in asset ? asset.item.workspacePath : 'missing',
      'Workflows/worldsculpt-5a9cc08eaf924e988e527f75137ea8c4/scene.glb',
    )
    assert.equal(
      asset.openable === true && 'item' in asset ? asset.item.url : 'missing',
      'http://127.0.0.1:8000/workspace/Workflows/worldsculpt-5a9cc08eaf924e988e527f75137ea8c4/scene.glb',
    )
  }
})

test('animation capability GLB remains a model unless it is an actual pose-clip sidecar', () => {
  const animatedGlb = {
    id: 'source-driven-baseline',
    workspacePath: 'Workflows/kimodo-20260530-114549-2332457a/.source_driven_fkik_baseline.glb',
    displayName: '.source_driven_fkik_baseline.glb',
    sourceScope: 'workflows' as const,
    capability: 'animation-motion' as const,
    state: 'ready' as const,
    previewKind: '3d-model' as const,
    warnings: [],
  }
  const listed = projectWorldAssetLibraryListResult({ success: true, entries: [animatedGlb] }, API_URL)
  const opened = projectWorldAssetLibraryOpenResult({ success: true, entry: animatedGlb }, API_URL)

  assert.equal(listed.success, true)
  assert.equal(opened.success, true)
  if (listed.success !== true || opened.success !== true) return
  for (const asset of [listed.assets[0], opened.asset]) {
    assert.equal(asset.openable, true)
    assert.equal(asset.type, 'GLB model')
    assert.equal(asset.openable === true && 'item' in asset ? asset.item.kind : 'missing', 'glb')
    assert.equal(asset.openable === true && 'poseClip' in asset, false)
  }

  const poseClip = projectWorldAssetLibraryOpenResult({
    success: true,
    entry: {
      ...animatedGlb,
      id: 'walk-motion',
      workspacePath: 'Workflows/Motions/walk.pose-clip.v1.json',
      displayName: 'Walk motion',
      previewKind: 'text',
      source: { relation: 'sidecar-source', workspacePath: 'Workflows/Characters/hero.glb' },
    },
  }, API_URL)
  assert.equal(poseClip.success, true)
  if (poseClip.success === true) {
    assert.equal(poseClip.asset.openable, true)
    assert.equal(poseClip.asset.type, 'Pose clip')
    assert.equal(poseClip.asset.openable === true && 'poseClip' in poseClip.asset, true)
  }
})
