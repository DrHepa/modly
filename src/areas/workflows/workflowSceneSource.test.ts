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
