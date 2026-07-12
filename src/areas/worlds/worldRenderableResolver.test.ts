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

test('resolver keeps spz unsupported but opens known Gaussian PLY as a native Worlds item', () => {
  assert.deepEqual(resolveWorldRenderable({ workspacePath: 'Workflows/run/point_cloud_1499.spz' }), {
    openable: false,
    reason: 'unsupported-spz',
  })

  const gaussian = resolveWorldRenderable({ workspacePath: 'Workflows/run/point_cloud_1499.ply', plyKind: 'gaussian' })
  assert.deepEqual(gaussian, {
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

test('binds encoded workspace URLs to exact Unicode/spaced names without weakening remote URLs', () => {
  const workspacePath = 'Workflows/世界/una escena.ply'
  const result = resolveWorldRenderable({ workspacePath, apiUrl: 'http://127.0.0.1:8000/', header: STANDARD_MESH_HEADER })
  assert.ok(result.openable)
  const url = new URL(result.item.url)
  assert.equal(url.pathname, '/workspace/Workflows/%E4%B8%96%E7%95%8C/una%20escena.ply')
  assert.equal(decodeURIComponent(url.pathname.slice('/workspace/'.length)), workspacePath)
  assert.equal(url.search, '')
  assert.equal(url.hash, '')
  for (const unsafe of ['Workflows/a#b.glb', 'Workflows/a?b.glb', 'Workflows/a%20b.glb', 'Workflows/./a.glb', 'C:a.glb', 'Workflows/a\nb.glb', ' Workflows/a.glb', 'Workflows\\a.glb']) {
    assert.equal(resolveWorldRenderable({ workspacePath: unsafe }).openable, false, unsafe)
  }
  for (const remote of ['https://assets.example/world.ply?signature=a%2Fb#view', 'http://assets.example/world.ply', 'blob:https://example.com/world-id']) {
    const candidate = resolveWorldRenderable({ workspacePath: 'Workflows/world.ply', url: remote })
    assert.ok(candidate.openable)
    assert.equal(candidate.item.url, remote)
  }
  assert.equal(resolveWorldRenderable({ workspacePath: 'Workflows/a.glb', apiUrl: 'http://localhost:8000', url: '/workspace/Workflows/other.glb' }).openable, false)
})

test('refuses explicitly malformed PLY headers instead of guessing standard topology', () => {
  assert.equal(resolveWorldRenderable({ workspacePath: 'Workflows/a.ply', header: 'not a header' }).openable, false)
})

test('resolver fails closed for explicitly unknown PLY classification', () => {
  assert.deepEqual(resolveWorldRenderable({ workspacePath: 'Workflows/run/broken.ply', plyKind: 'unknown' }), {
    openable: false,
    reason: 'unavailable',
  })
})
