import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSceneSourceManifest } from './workflowSceneSource.ts'

function manifestBase64(manifest: unknown): string {
  return Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64')
}

test('resolveSceneSourceManifest accepts workspace-relative scene directories and resolves scene manifests', async () => {
  const result = await resolveSceneSourceManifest({
    scenePath: 'Scenes/castle',
    workspaceDir: '/workspace',
    readFileBase64: async (filePath) => {
      assert.equal(filePath, '/workspace/Scenes/castle/scene-manifest.json')
      return manifestBase64({
        schema: 'modly.scene-manifest.v1',
        sceneRoot: '.',
        assets: [],
      })
    },
  })

  assert.deepEqual(result, {
    ok: true,
    sourceKind: 'directory',
    inputWorkspacePath: 'Scenes/castle',
    manifestWorkspacePath: 'Scenes/castle/scene-manifest.json',
    manifestAbsolutePath: '/workspace/Scenes/castle/scene-manifest.json',
    sceneRoot: '.',
    manifest: {
      schema: 'modly.scene-manifest.v1',
      sceneRoot: '.',
      assets: [],
    },
  })
})

test('resolveSceneSourceManifest rejects unsafe or invalid scene manifests', async () => {
  const invalidPath = await resolveSceneSourceManifest({
    scenePath: '../outside',
    workspaceDir: '/workspace',
    readFileBase64: async () => manifestBase64({}),
  })
  const invalidSchema = await resolveSceneSourceManifest({
    scenePath: 'Scenes/castle/scene-manifest.json',
    workspaceDir: '/workspace',
    readFileBase64: async () => manifestBase64({ schema: 'wrong', sceneRoot: '.', assets: [] }),
  })
  const invalidSceneRoot = await resolveSceneSourceManifest({
    scenePath: 'Scenes/castle/scene-manifest.json',
    workspaceDir: '/workspace',
    readFileBase64: async () => manifestBase64({ schema: 'modly.scene-manifest.v1', sceneRoot: '../escape', assets: [] }),
  })

  assert.deepEqual(invalidPath, {
    ok: false,
    error: 'Load Scene requires a safe workspace-relative scene path.',
  })
  assert.deepEqual(invalidSchema, {
    ok: false,
    error: 'Scene manifest schema must be modly.scene-manifest.v1.',
  })
  assert.deepEqual(invalidSceneRoot, {
    ok: false,
    error: 'Scene manifest sceneRoot must be a safe relative path.',
  })
})

for (const scenePath of ['Scenes/castle/scene-manifest.json', '/workspace/Scenes/castle/scene-manifest.json', '/actual/workspace/Scenes/castle/scene-manifest.json']) {
  test(`scene manifest picker paths normalize without losing opaque metadata: ${scenePath}`, async () => {
    const manifest = { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [{ path: 'mesh.glb', vendor: { opaque: true } }], preview: { image: 'preview.png' }, initialView: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0] }, vendor: { opaque: ['kept'] } }
    const result = await resolveSceneSourceManifest({ scenePath, workspaceDir: '/actual/workspace', readFileBase64: async (p) => { assert.equal(p, '/actual/workspace/Scenes/castle/scene-manifest.json'); return manifestBase64(manifest) } })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.sourceKind, 'manifest')
      assert.deepEqual(result.manifest, manifest)
    }
  })
}

test('unsafe picker paths are rejected before reading; unsafe manifest references and views fail closed', async () => {
  for (const scenePath of ['../escape', '/elsewhere/scene-manifest.json', 'Scenes//castle', 'Scenes/./castle', 'Scenes/%2e%2e/escape', 'Scenes/%252e%252e/escape', 'Scenes/a%00b', 'Scenes/other.json', 'Scenes/castle ']) {
    let reads = 0
    const result = await resolveSceneSourceManifest({ scenePath, workspaceDir: '/workspace', readFileBase64: async () => { reads++; return manifestBase64({}) } })
    assert.equal(result.ok, false, scenePath)
    assert.equal(reads, 0, scenePath)
  }
  for (const patch of [{ assets: [{ path: '../escape' }] }, { preview: { image: '/outside.png' } }, { initialView: { position: [0, 0, 0], target: [0, 0, 0] } }, { initialView: { position: [1, 0, 0], target: [0, 0, 0], up: [0, 0, 0] } }]) {
    const result = await resolveSceneSourceManifest({ scenePath: 'Scenes/castle', workspaceDir: '/workspace', readFileBase64: async () => manifestBase64({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [], ...patch }) })
    assert.equal(result.ok, false, JSON.stringify(patch))
  }
})
