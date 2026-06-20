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
const PLY_MESH_HEADER = 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n'
const PLY_POINTS_HEADER = PLY_MESH_HEADER.replace('element face 1\nproperty list uchar int vertex_indices\n', '')

function installLibraryWindow(stubs: {
  listCalls?: AssetLibraryListRequest[]
  openCalls?: AssetLibraryOpenRequest[]
  readCalls?: AssetLibraryOpenRequest[]
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
                    previewKind: 'binary',
                    plyHeader: { status: 'complete', content: PLY_MESH_HEADER },
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
            read: async (request: AssetLibraryOpenRequest) => {
              stubs.readCalls?.push(request)
              return {
                success: true,
                preview: { kind: 'binary', binaryKind: 'ply', byteLength: 1024, message: 'Binary preview' },
                entry: {
                  id: 'opened-world',
                  workspacePath: request.workspacePath,
                  displayName: 'Opened world',
                  sourceScope: 'workflows',
                  capability: 'generated-world',
                  state: 'ready',
                  previewKind: 'binary',
                  plyHeader: { status: 'complete', content: PLY_MESH_HEADER },
                  warnings: [],
                  provenance: { graphId: 'hidden' },
                },
              }
            },
            open: async (request: AssetLibraryOpenRequest) => {
              stubs.openCalls?.push(request)
              return { success: false, error: 'PLY must use the authorised library read operation.' }
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

  assert.equal(result.assets.length, 4)
  assert.deepEqual(result.assets.map((asset) => ({ id: asset.id, sourceScope: asset.sourceScope, capability: asset.capability, displayName: asset.displayName, openable: asset.openable })), [
    { id: 'world-mesh', sourceScope: 'workflows', capability: 'generated-world', displayName: 'Fuse simplified', openable: true },
    { id: 'export-mesh', sourceScope: 'exports', capability: 'mesh', displayName: 'Hero export', openable: true },
    { id: 'gaussian', sourceScope: 'workflows', capability: 'generated-world', displayName: 'Gaussian splat', openable: false },
    { id: 'unsafe', sourceScope: 'workflows', capability: 'mesh', displayName: '../outside/hero.glb', openable: false },
  ])

  const worldMesh = result.assets[0]
  assert.equal(worldMesh.openable, true)
  if (worldMesh.openable === true) {
    assert.deepEqual(worldMesh.item, {
      id: 'world:Workflows/worldmirror/result/ply/fuse_simplified.ply',
      workspacePath: 'Workflows/worldmirror/result/ply/fuse_simplified.ply',
      url: 'http://127.0.0.1:8000/workspace/Workflows/worldmirror/result/ply/fuse_simplified.ply',
      kind: 'ply-mesh',
      visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    })
  }
  assert.equal(result.assets[2].openable, false)
  if (result.assets[2].openable === false) assert.equal(result.assets[2].reason, 'unsupported-spz')
  assert.deepEqual(result.assets[0].warnings, [])
  assert.deepEqual(result.assets[2].warnings, ['hidden detail'])
})

test('world asset library service opens safe Workflows renderables and rejects unsafe requests before preload', async () => {
  const openCalls: AssetLibraryOpenRequest[] = []
  const readCalls: AssetLibraryOpenRequest[] = []
  installLibraryWindow({ openCalls, readCalls })

  const opened = await openWorldAssetLibraryRenderable({ workspacePath: 'Workflows/worldmirror/result/ply/fuse_post.ply' }, API_URL)

  assert.deepEqual(readCalls, [{ workspacePath: 'Workflows/worldmirror/result/ply/fuse_post.ply' }])
  assert.deepEqual(openCalls, [])
  assert.equal(opened.success, true)
  if (opened.success === true) {
    assert.equal(opened.asset.openable, true)
    assert.equal(opened.asset.openable === true ? opened.asset.item.kind : 'missing', 'ply-mesh')
    assert.equal(
      opened.asset.openable === true ? opened.asset.item.url : 'missing',
      'http://127.0.0.1:8000/workspace/Workflows/worldmirror/result/ply/fuse_post.ply',
    )
  }

  await assert.rejects(
    () => openWorldAssetLibraryRenderable({ workspacePath: '/outside/fuse_post.ply' }, API_URL),
    /safe workspace-relative path/i,
  )
  assert.deepEqual(readCalls, [{ workspacePath: 'Workflows/worldmirror/result/ply/fuse_post.ply' }])
  assert.deepEqual(openCalls, [])
})

test('Worlds validates entry state, identities and raw envelopes before projection', async () => {
  installLibraryWindow({})
  const api = window.electron.workspace.library
  const entry = { id: 'library:Workflows/a.glb', workspacePath: 'Workflows/a.glb', displayName: 'A', sourceScope: 'workflows', capability: 'mesh', state: 'ready', previewKind: '3d-model', warnings: [] }
  for (const state of ['unknown-metadata', 'unsupported', 'unsafe']) {
    api.list = async () => ({ success: true, entries: [{ ...entry, state }] }) as never
    const result = await listWorldAssetLibraryRenderables(API_URL)
    assert.ok(result.success)
    assert.equal(result.assets[0].openable, false, state)
  }
  for (const response of [{ success: 'yes' }, { success: true }, { success: false, error: 2 }, { success: true, entries: [entry, entry] }]) {
    api.list = async () => response as never
    await assert.rejects(() => listWorldAssetLibraryRenderables(API_URL), /Invalid asset library/)
  }
  api.open = async () => ({ success: true, entry: { ...entry, workspacePath: 'Workflows/other.glb' } }) as never
  await assert.rejects(() => openWorldAssetLibraryRenderable({ workspacePath: entry.workspacePath }, API_URL), /entry response/)
  api.list = undefined as never
  await assert.rejects(() => listWorldAssetLibraryRenderables(API_URL), /unavailable/i)
})

test('Worlds qualifies PLY from complete fresh evidence, not extension or cached labels', async () => {
  installLibraryWindow({})
  const api = window.electron.workspace.library
  const entry = { id: 'library:Workflows/a.ply', workspacePath: 'Workflows/a.ply', displayName: 'A', sourceScope: 'workflows', capability: 'mesh', state: 'ready', previewKind: 'binary', warnings: [] }
  const gaussian = PLY_POINTS_HEADER.replace('end_header', 'property float f_dc_0\nproperty float scale_0\nproperty float rot_0\nend_header')
  for (const [plyHeader, expected] of [
    [{ status: 'complete', content: PLY_POINTS_HEADER }, 'PLY points'],
    [{ status: 'complete', content: PLY_MESH_HEADER }, 'PLY mesh'],
    [{ status: 'complete', content: gaussian }, 'Unsupported'],
    [{ status: 'complete', content: 'not a PLY header' }, 'Unavailable'],
    [{ status: 'unavailable', reason: 'header-too-large' }, 'Unavailable'],
    [undefined, 'Unavailable'],
  ] as const) {
    api.list = async () => ({ success: true, entries: [{ ...entry, plyHeader }] }) as never
    api.read = async () => ({ success: true, entry: { ...entry, plyHeader }, preview: { kind: 'binary', binaryKind: 'ply', byteLength: 300, message: '' } }) as never
    const listed = await listWorldAssetLibraryRenderables(API_URL)
    const opened = await openWorldAssetLibraryRenderable({ workspacePath: entry.workspacePath }, API_URL)
    assert.ok(listed.success && opened.success)
    assert.equal(listed.assets[0].type, expected)
    assert.equal(opened.asset.type, expected)
    assert.equal(opened.asset.openable, expected === 'PLY mesh' || expected === 'PLY points')
  }
  for (const plyHeader of [{ status: 'complete', content: 1 }, { status: 'complete', content: 'x'.repeat(65537) }, { status: 'unavailable', reason: 'invented' }]) {
    api.list = async () => ({ success: true, entries: [{ ...entry, plyHeader }] }) as never
    await assert.rejects(() => listWorldAssetLibraryRenderables(API_URL), /PLY header/i)
  }
  api.read = async () => ({ success: true, entry: { ...entry, workspacePath: 'Workflows/other.ply' }, preview: { kind: 'binary', binaryKind: 'ply', byteLength: 1, message: '' } }) as never
  await assert.rejects(() => openWorldAssetLibraryRenderable({ workspacePath: entry.workspacePath }, API_URL), /entry response/)
})

test('Worlds retains GLB open authority and rejects malformed source paths before IPC', async () => {
  installLibraryWindow({})
  const api = window.electron.workspace.library
  let calls = 0
  const entry = { id: 'library:Workflows/a.glb', workspacePath: 'Workflows/a.glb', displayName: 'A', sourceScope: 'workflows', capability: 'mesh', state: 'ready', previewKind: '3d-model', warnings: [] }
  api.open = async () => { calls++; return { success: true, entry } as never }
  assert.equal((await openWorldAssetLibraryRenderable({ workspacePath: entry.workspacePath }, API_URL)).success, true)
  for (const sourceWorkspacePath of ['', null, false, 'Workflows/../a.glb']) {
    await assert.rejects(() => openWorldAssetLibraryRenderable({ workspacePath: entry.workspacePath, sourceWorkspacePath } as AssetLibraryOpenRequest, API_URL), /safe workspace-relative/i)
  }
  assert.equal(calls, 1)
  api.list = async () => ({ success: true, entries: [{ ...entry, capability: 'generated-world' }] }) as never
  const listed = await listWorldAssetLibraryRenderables(API_URL)
  assert.ok(listed.success)
  assert.equal(listed.assets[0].openable, false, 'GLB eligibility must agree with main open capability policy')
})
