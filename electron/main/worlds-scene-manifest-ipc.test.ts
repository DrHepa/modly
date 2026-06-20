import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  isSceneManifestRecord,
  resolveSafeWorkspaceJsonPath,
} from './worlds-scene-manifest-path.ts'

test('resolveSafeWorkspaceJsonPath accepts only safe workspace-relative JSON destinations', () => {
  const workspaceDir = path.resolve('/tmp/modly-workspace')
  assert.deepEqual(resolveSafeWorkspaceJsonPath(workspaceDir, 'Exports/Worlds/scene-manifest.json'), {
    workspacePath: 'Exports/Worlds/scene-manifest.json',
    absolutePath: path.resolve(workspaceDir, 'Exports/Worlds/scene-manifest.json'),
  })

  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, '../escape.json'), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, '/tmp/modly-workspace/Exports/scene-manifest.json'), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, 'Exports/Worlds/scene-manifest.txt'), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, 'Exports//scene-manifest.json'), null)
})

test('isSceneManifestRecord verifies only the shared scene manifest contract surface', () => {
  assert.equal(isSceneManifestRecord({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [] }), true)
  assert.equal(isSceneManifestRecord({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: {} }), false)
  assert.equal(isSceneManifestRecord({ schema: 'wrong', sceneRoot: '.', assets: [] }), false)
  assert.equal(isSceneManifestRecord(null), false)
})
