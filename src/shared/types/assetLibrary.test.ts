import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ARTIFACT_KINDS,
} from './artifacts.ts'
import {
  ASSET_CAPABILITIES,
  ASSET_ENTRY_STATES,
  ASSET_LIBRARY_SOURCE_SCOPES,
  ASSET_LIBRARY_MANIFEST_CAPABILITIES,
  ASSET_LIBRARY_PREVIEW_KINDS,
} from './assetLibrary.ts'
import type {
  AssetLibraryEntry,
  AssetLibraryPreviewPayload,
  AssetLibraryReadResult,
} from './assetLibrary.ts'

test('declares the capability-first asset library taxonomy and entry states', () => {
  assert.deepEqual(ASSET_CAPABILITIES, [
    'mesh',
    'rigged-mesh',
    'animation-motion',
    'landmarks-sidecar',
    'generated-world',
    'scene-manifest',
  ])
  assert.deepEqual(ASSET_ENTRY_STATES, ['ready', 'unknown-metadata', 'unsupported', 'unsafe'])
  assert.deepEqual(ASSET_LIBRARY_SOURCE_SCOPES, ['workflows', 'exports'])
  assert.deepEqual(ASSET_LIBRARY_PREVIEW_KINDS, ['3d-model', 'text', 'audio', 'binary', 'none'])
  assert.deepEqual(ASSET_LIBRARY_MANIFEST_CAPABILITIES, ['generated-world', 'scene-manifest'])
})

test('keeps scene-manifest as a manifest capability while scene is an artifact kind', () => {
  assert.ok(ARTIFACT_KINDS.includes('scene'))
  assert.ok(!(ASSET_CAPABILITIES as readonly string[]).includes('scene'))
  assert.ok(ASSET_CAPABILITIES.includes('scene-manifest'))
  assert.ok(ASSET_LIBRARY_MANIFEST_CAPABILITIES.includes('scene-manifest'))
})

test('AssetLibraryEntry contracts keep manifest and source-link metadata explicit', () => {
  const preview = {
    kind: '3d-model',
    viewerKind: 'glb',
  } satisfies AssetLibraryPreviewPayload

  const readyEntry = {
    id: 'asset:hero-world',
    workspacePath: 'Workflows/worlds/hero.world.json',
    displayName: 'hero.world.json',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:05:00.000Z',
    sourceScope: 'workflows',
    capability: 'generated-world',
    state: 'ready',
    artifactId: 'artifact-hero-world',
    versionId: 'artifact-hero-world-v1',
    provenance: {
      workflowId: 'workflow-1',
      workflowNodeId: 'node-1',
    },
    manifest: {
      capability: 'generated-world',
      workspacePath: 'Workflows/worlds/hero.world.json',
      schema: 'modly.generated-world.v1',
      title: 'Hero World',
    },
    source: {
      relation: 'manifest-source',
      workspacePath: 'Workflows/checkpoints/hero.glb',
      assetId: 'artifact-hero-mesh',
    },
    previewKind: '3d-model',
    warnings: [],
  } satisfies AssetLibraryEntry

  const degradedResult = {
    success: true,
    entry: {
      id: 'asset:landmarks',
      workspacePath: 'Workflows/landmarks/run-1/node-1.landmarks.v1.json',
      displayName: 'node-1.landmarks.v1.json',
      sourceScope: 'workflows',
      capability: 'landmarks-sidecar',
      state: 'ready',
      source: {
        relation: 'sidecar-source',
        workspacePath: 'Workflows/checkpoints/source.glb',
        degraded: true,
      },
      previewKind: 'text',
      warnings: ['Missing source artifact identity; using workspace-path fallback only.'],
    },
    preview,
  } satisfies AssetLibraryReadResult

  assert.equal(readyEntry.source?.relation, 'manifest-source')
  assert.equal(readyEntry.sourceScope, 'workflows')
  assert.equal(readyEntry.createdAt, '2026-06-10T00:00:00.000Z')
  assert.equal(readyEntry.updatedAt, '2026-06-10T00:05:00.000Z')
  assert.equal(degradedResult.entry.source?.degraded, true)
  assert.equal(degradedResult.preview.kind, '3d-model')
})
