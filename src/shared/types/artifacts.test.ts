import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ARTIFACT_KINDS,
  ARTIFACT_REPLACEMENT_REASONS,
  ARTIFACT_REPLACEMENT_STATUSES,
  ARTIFACT_SUBSTITUTION_STATUSES,
  ARTIFACT_VERSION_ROLES,
} from './artifacts.ts'
import type {
  ArtifactRef,
  ArtifactReplacementResult,
  WorkflowContinueOptions,
} from './artifacts.ts'

test('declares the artifact kinds supported by workflow artifact refs', () => {
  assert.deepEqual(ARTIFACT_KINDS, ['image', 'text', 'mesh', 'scene'])
})

test('scene artifacts are manifest-file backed legacy outputs', () => {
  const sceneArtifact = {
    id: 'scene-asset',
    kind: 'scene',
    uri: '/workspace/Worlds/hero.scene.json',
    versionId: 'scene-asset-v1',
    legacy: { filePath: '/workspace/Worlds/hero.scene.json', outputType: 'scene' },
  } satisfies ArtifactRef

  assert.equal(sceneArtifact.kind, 'scene')
  assert.equal(sceneArtifact.uri, '/workspace/Worlds/hero.scene.json')
  assert.deepEqual(sceneArtifact.legacy, {
    filePath: '/workspace/Worlds/hero.scene.json',
    outputType: 'scene',
  })
})

test('declares version roles and substitution statuses for lineage contracts', () => {
  assert.deepEqual(ARTIFACT_VERSION_ROLES, ['original', 'current', 'edited'])
  assert.deepEqual(ARTIFACT_SUBSTITUTION_STATUSES, ['declared', 'applied', 'rejected'])
})

test('declares replacement statuses and observable rejection reasons', () => {
  assert.deepEqual(ARTIFACT_REPLACEMENT_STATUSES, ['accepted', 'rejected', 'noop'])
  assert.deepEqual(ARTIFACT_REPLACEMENT_REASONS, [
    'no_replacement',
    'kind_not_allowed',
    'legacy_unavailable',
    'stale_checkpoint',
  ])
})

test('WorkflowContinueOptions and ArtifactReplacementResult stay discriminated and unknown-safe', () => {
  const replacementArtifact: ArtifactRef = {
    id: 'mesh-asset',
    kind: 'mesh',
    uri: '/workspace/mesh.glb',
    versionId: 'mesh-asset-v1',
    legacy: { filePath: '/workspace/mesh.glb', outputType: 'mesh' },
  }
  const options = { replacementArtifact } satisfies WorkflowContinueOptions
  const accepted = {
    status: 'accepted',
    artifact: replacementArtifact,
    legacy: { filePath: '/workspace/mesh.glb', outputType: 'mesh' },
  } satisfies ArtifactReplacementResult
  const rejected = {
    status: 'rejected',
    reason: 'kind_not_allowed',
  } satisfies ArtifactReplacementResult
  const noop = {
    status: 'noop',
    reason: 'no_replacement',
  } satisfies ArtifactReplacementResult

  assert.equal(options.replacementArtifact.id, 'mesh-asset')
  assert.equal(accepted.status, 'accepted')
  assert.equal(rejected.reason, 'kind_not_allowed')
  assert.equal(noop.reason, 'no_replacement')
})
