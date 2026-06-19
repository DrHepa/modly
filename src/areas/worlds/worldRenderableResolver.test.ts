import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveWorldMirrorBundleRenderable,
  resolveWorldRenderable,
  toWorldSceneItems,
} from './worldRenderableResolver.ts'

const STANDARD_MESH_HEADER = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 1
property list uchar int vertex_indices
end_header
`

const GAUSSIAN_HEADER = `ply
format binary_little_endian 1.0
element vertex 4
property float x
property float y
property float z
property float f_dc_0
property float opacity
property float scale_0
property float rot_0
end_header
`

test('WorldMirror result bundles prioritize simplified mesh then post mesh before generic renderables', () => {
  const result = resolveWorldMirrorBundleRenderable({
    rootPath: 'Workflows/hy-world-2-runs/worldmirror/artifacts/worldmirror/result',
    files: [
      'ply/point_cloud_1499.spz',
      'model.glb',
      'ply/fuse_post.ply',
      'ply/fuse_simplified.ply',
    ],
    headersByPath: {
      'ply/fuse_simplified.ply': STANDARD_MESH_HEADER,
      'ply/fuse_post.ply': STANDARD_MESH_HEADER,
    },
  })

  assert.equal(result.openable, true)
  if (result.openable !== true) return
  assert.equal(result.item.workspacePath, 'Workflows/hy-world-2-runs/worldmirror/artifacts/worldmirror/result/ply/fuse_simplified.ply')
  assert.equal(result.item.kind, 'ply-mesh')
})

test('WorldMirror result bundle falls back to fuse_post when simplified mesh is absent', () => {
  const result = resolveWorldMirrorBundleRenderable({
    rootPath: 'Workflows/hy-world-2-runs/worldmirror/artifacts/worldmirror/result',
    files: ['ply/point_cloud_1499.ply', 'scene.gltf', 'ply/fuse_post.ply'],
    headersByPath: {
      'ply/fuse_post.ply': STANDARD_MESH_HEADER,
      'ply/point_cloud_1499.ply': GAUSSIAN_HEADER,
    },
  })

  assert.equal(result.openable, true)
  if (result.openable !== true) return
  assert.equal(result.item.workspacePath.endsWith('/ply/fuse_post.ply'), true)
  assert.equal(result.item.kind, 'ply-mesh')
})

test('resolver defers spz and Gaussian PLY instead of pretending they are standard renderables', () => {
  assert.deepEqual(resolveWorldRenderable({ workspacePath: 'Workflows/run/point_cloud_1499.spz' }), {
    openable: false,
    reason: 'unsupported-spz',
  })

  assert.deepEqual(resolveWorldRenderable({ workspacePath: 'Workflows/run/point_cloud_1499.ply', header: GAUSSIAN_HEADER }), {
    openable: false,
    reason: 'unsupported-gaussian-ply',
  })
})

test('resolver creates identity visible scene items for safe standard PLY and GLB assets only', () => {
  const apiUrl = 'http://127.0.0.1:8000'
  const renderables = [
    resolveWorldRenderable({ workspacePath: 'Workflows/run/ply/fuse_post.ply', header: STANDARD_MESH_HEADER, apiUrl }),
    resolveWorldRenderable({ workspacePath: 'Exports/hero.glb', apiUrl }),
    resolveWorldRenderable({ workspacePath: '../outside/hero.glb' }),
  ]

  const sceneItems = toWorldSceneItems(renderables)

  assert.deepEqual(sceneItems.map((item) => ({ workspacePath: item.workspacePath, kind: item.kind, visible: item.visible, transform: item.transform })), [
    {
      workspacePath: 'Workflows/run/ply/fuse_post.ply',
      kind: 'ply-mesh',
      visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      workspacePath: 'Exports/hero.glb',
      kind: 'glb',
      visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  ])
  assert.deepEqual(sceneItems.map((item) => ({ workspacePath: item.workspacePath, url: item.url })), [
    {
      workspacePath: 'Workflows/run/ply/fuse_post.ply',
      url: 'http://127.0.0.1:8000/workspace/Workflows/run/ply/fuse_post.ply',
    },
    {
      workspacePath: 'Exports/hero.glb',
      url: 'http://127.0.0.1:8000/workspace/Exports/hero.glb',
    },
  ])
})

test('resolver preserves explicit remote urls but resolves workspace paths through the API workspace route', () => {
  const apiUrl = 'http://127.0.0.1:8000'

  const workspaceResult = resolveWorldRenderable({ workspacePath: 'Workflows/foo.ply', apiUrl })
  const remoteResult = resolveWorldRenderable({
    workspacePath: 'Workflows/bar.glb',
    url: 'https://assets.example.test/bar.glb',
    apiUrl,
  })

  assert.equal(workspaceResult.openable, true)
  if (workspaceResult.openable === true) {
    assert.equal(workspaceResult.item.workspacePath, 'Workflows/foo.ply')
    assert.equal(workspaceResult.item.url, 'http://127.0.0.1:8000/workspace/Workflows/foo.ply')
  }
  assert.equal(remoteResult.openable, true)
  if (remoteResult.openable === true) {
    assert.equal(remoteResult.item.workspacePath, 'Workflows/bar.glb')
    assert.equal(remoteResult.item.url, 'https://assets.example.test/bar.glb')
  }

  assert.deepEqual(resolveWorldRenderable({ workspacePath: '%2e%2e/outside/foo.ply', apiUrl }), {
    openable: false,
    reason: 'unsafe',
  })
})
