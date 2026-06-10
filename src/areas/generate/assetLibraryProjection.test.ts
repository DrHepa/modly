import assert from 'node:assert/strict'
import test from 'node:test'

import type { AssetLibraryEntry } from '../../shared/types/assetLibrary.ts'
import {
  projectAssetLibraryEntry,
  projectAssetLibraryListResult,
  projectAssetLibraryReadResult,
} from './assetLibraryProjection.ts'

function assetEntry(patch: Partial<AssetLibraryEntry> = {}): AssetLibraryEntry {
  return {
    id: 'asset-1',
    workspacePath: 'Characters/hero.glb',
    displayName: 'Hero mesh',
    sourceScope: 'workflows',
    capability: 'mesh',
    state: 'ready',
    artifactId: 'artifact-1',
    versionId: 'version-1',
    provenance: {
      workflowId: 'workflow-1',
      workflowNodeId: 'node-1',
    },
    previewKind: '3d-model',
    warnings: [],
    ...patch,
  }
}

test('projectAssetLibraryEntry keeps ready mesh entries openable through their own workspace path', () => {
  assert.deepEqual(
    projectAssetLibraryEntry(assetEntry({ warnings: ['duplicate warning', 'duplicate warning'] })),
    {
      id: 'asset-1',
      workspacePath: 'Characters/hero.glb',
      displayName: 'Hero mesh',
      sourceScope: 'workflows',
      capability: 'mesh',
      state: 'ready',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      provenance: {
        workflowId: 'workflow-1',
        workflowNodeId: 'node-1',
      },
      previewKind: '3d-model',
      warnings: ['duplicate warning'],
      openTarget: {
        kind: 'self',
        workspacePath: 'Characters/hero.glb',
      },
    },
  )
})

test('projectAssetLibraryEntry keeps linked-source sidecars openable while degrading unsafe source links', () => {
  const openableSidecar = projectAssetLibraryEntry(assetEntry({
    id: 'landmark-1',
    workspacePath: 'Workflows/landmarks/run-1/node-1.landmarks.v1.json',
    displayName: 'Shoulder landmarks',
    capability: 'landmarks-sidecar',
    previewKind: 'text',
    source: {
      relation: 'sidecar-source',
      workspacePath: 'Characters/source.glb',
      assetId: 'source-asset-1',
      versionId: 'source-version-1',
    },
  }))

  assert.deepEqual(openableSidecar.openTarget, {
    kind: 'linked-source',
    workspacePath: 'Characters/source.glb',
    relation: 'sidecar-source',
  })
  assert.deepEqual(openableSidecar.source, {
    relation: 'sidecar-source',
    workspacePath: 'Characters/source.glb',
    assetId: 'source-asset-1',
    versionId: 'source-version-1',
  })

  const degradedSidecar = projectAssetLibraryEntry(assetEntry({
    id: 'landmark-2',
    workspacePath: 'Workflows/landmarks/run-1/node-2.landmarks.v1.json',
    displayName: 'Degraded landmarks',
    capability: 'landmarks-sidecar',
    previewKind: 'text',
    source: {
      relation: 'sidecar-source',
      workspacePath: '../outside/source.glb',
      assetId: 'source-asset-2',
    },
  }))

  assert.deepEqual(degradedSidecar.source, {
    relation: 'sidecar-source',
    assetId: 'source-asset-2',
    degraded: true,
  })
  assert.deepEqual(degradedSidecar.openTarget, {
    kind: 'unavailable',
    reason: 'missing-source-link',
  })
  assert.equal(degradedSidecar.warnings.at(-1), 'Renderer rejected unsafe asset-library source workspace path.')
})

test('projectAssetLibraryEntry preserves rigged meshes and manifest capabilities without coercing them into mesh semantics', () => {
  const riggedMesh = projectAssetLibraryEntry(assetEntry({
    id: 'rigged-1',
    workspacePath: 'Characters/hero-rigged.glb',
    displayName: 'Rigged hero',
    capability: 'rigged-mesh',
  }))

  assert.deepEqual(riggedMesh.openTarget, {
    kind: 'self',
    workspacePath: 'Characters/hero-rigged.glb',
  })

  for (const workspacePath of ['Characters/hero.obj', 'Characters/hero.stl', 'Characters/hero.ply']) {
    assert.deepEqual(
      projectAssetLibraryEntry(assetEntry({
        id: workspacePath,
        workspacePath,
        displayName: workspacePath.split('/').at(-1) ?? workspacePath,
        capability: 'mesh',
        previewKind: 'binary',
      })).openTarget,
      {
        kind: 'unavailable',
        reason: 'capability-not-viewable',
      },
      `${workspacePath} should stay classified as mesh without pretending Generate can open it directly yet`,
    )
  }

  const manifestEntries = projectAssetLibraryListResult({
    success: true,
    entries: [
      assetEntry({
        id: 'world-1',
        workspacePath: 'Worlds/generated-world.json',
        displayName: 'Generated world',
        sourceScope: 'workflows',
        capability: 'generated-world',
        previewKind: 'text',
        manifest: {
          capability: 'generated-world',
          workspacePath: 'Worlds/generated-world.json',
          schema: 'modly.generated-world.v1',
          title: 'Generated world',
        },
      }),
      assetEntry({
        id: 'scene-1',
        workspacePath: 'Scenes/scene-manifest.json',
        displayName: 'Scene manifest',
        sourceScope: 'exports',
        capability: 'scene-manifest',
        previewKind: 'text',
        manifest: {
          capability: 'scene-manifest',
          workspacePath: 'Scenes/scene-manifest.json',
          schema: 'modly.scene-manifest.v1',
          title: 'Scene manifest',
        },
      }),
    ],
  })

  assert.equal(manifestEntries.success, true)
  if (manifestEntries.success !== true) return

    assert.deepEqual(
      manifestEntries.entries.map((entry) => ({
        capability: entry.capability,
        sourceScope: entry.sourceScope,
        manifest: entry.manifest,
        openTarget: entry.openTarget,
      })),
    [
      {
        capability: 'generated-world',
        sourceScope: 'workflows',
        manifest: {
          capability: 'generated-world',
          workspacePath: 'Worlds/generated-world.json',
          schema: 'modly.generated-world.v1',
          title: 'Generated world',
        },
        openTarget: {
          kind: 'unavailable',
          reason: 'capability-not-viewable',
        },
      },
      {
        capability: 'scene-manifest',
        sourceScope: 'exports',
        manifest: {
          capability: 'scene-manifest',
          workspacePath: 'Scenes/scene-manifest.json',
          schema: 'modly.scene-manifest.v1',
          title: 'Scene manifest',
        },
        openTarget: {
          kind: 'unavailable',
          reason: 'capability-not-viewable',
        },
      },
    ],
  )
})

test('projectAssetLibraryEntry opens animation-motion entries through their own safe glb or gltf workspace path', () => {
  for (const workspacePath of ['Animations/walk-cycle.glb', 'Animations/walk-cycle.gltf']) {
    assert.deepEqual(
      projectAssetLibraryEntry(assetEntry({
        id: workspacePath,
        workspacePath,
        displayName: workspacePath.split('/').at(-1) ?? workspacePath,
        capability: 'animation-motion',
        source: undefined,
      })).openTarget,
      {
        kind: 'self',
        workspacePath,
      },
      `${workspacePath} should open directly when the animation entry itself is a safe glb/gltf`,
    )
  }

  assert.deepEqual(
    projectAssetLibraryEntry(assetEntry({
      id: 'Animations/walk-cycle.bvh',
      workspacePath: 'Animations/walk-cycle.bvh',
      displayName: 'walk-cycle.bvh',
      capability: 'animation-motion',
      previewKind: 'binary',
      source: undefined,
    })).openTarget,
    {
      kind: 'unavailable',
      reason: 'missing-source-link',
    },
    'BVH motion assets must stay non-openable unless they have a safe source link',
  )
})

test('projectAssetLibraryReadResult fails closed when the main-process payload includes an unsafe entry path', () => {
  const result = projectAssetLibraryReadResult({
    success: true,
    entry: assetEntry({
      workspacePath: '../outside/escape.glb',
      displayName: '   ',
    }),
    preview: {
      kind: '3d-model',
      viewerKind: 'glb',
    },
  })

  assert.equal(result.success, true)
  if (result.success !== true) return

  assert.deepEqual(result.entry.openTarget, {
    kind: 'unavailable',
    reason: 'unsafe-entry',
  })
  assert.equal(result.entry.state, 'unsafe')
  assert.equal(result.entry.displayName, 'escape.glb')
  assert.match(result.entry.warnings.join('\n'), /unsafe asset-library entry workspace path/i)
})

test('projectAssetLibraryEntry preserves source scope while deriving openability independently', () => {
  const workflowMesh = projectAssetLibraryEntry(assetEntry({
    id: 'workflow-mesh',
    workspacePath: 'Workflows/generated/hero.glb',
    sourceScope: 'workflows',
    displayName: 'Workflow hero',
    capability: 'mesh',
  }))

  const exportMotion = projectAssetLibraryEntry(assetEntry({
    id: 'export-motion',
    workspacePath: 'Exports/motions/walk.npz',
    sourceScope: 'exports',
    displayName: 'Export walk',
    capability: 'animation-motion',
    previewKind: 'binary',
    source: {
      relation: 'sidecar-source',
      workspacePath: 'Exports/rigged/hero.glb',
    },
  }))

  assert.equal(workflowMesh.sourceScope, 'workflows')
  assert.deepEqual(workflowMesh.openTarget, {
    kind: 'self',
    workspacePath: 'Workflows/generated/hero.glb',
  })

  assert.equal(exportMotion.sourceScope, 'exports')
  assert.deepEqual(exportMotion.openTarget, {
    kind: 'linked-source',
    workspacePath: 'Exports/rigged/hero.glb',
    relation: 'sidecar-source',
  })
})
