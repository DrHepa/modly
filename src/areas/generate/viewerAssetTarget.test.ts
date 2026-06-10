import assert from 'node:assert/strict'
import test from 'node:test'

import type { ArtifactRef } from '../../shared/types/artifacts.ts'
import type { GenerationJob } from '../../shared/stores/appStore.ts'
import { resolveViewerAssetTarget, resolveViewerAssetTargetFromLibraryEntry, resolveViewerAssetWorkspacePathFromUrl, resolveViewerArtifactWorkspacePath, resolveViewerWorkspacePathFromAbsoluteValue } from './viewerAssetTarget.ts'
import type { RendererAssetLibraryEntry } from './assetLibraryProjection.ts'

const API_URL = 'http://127.0.0.1:8000'

function generationJob(patch: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-1',
    imageFile: '/tmp/input.png',
    status: 'generating',
    progress: 50,
    createdAt: 1777161040844,
    ...patch,
  }
}

function workflowArtifact(patch: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    id: 'artifact-1',
    kind: 'mesh',
    uri: '/workspace/Workflows/generated/from-artifact.glb',
    versionId: 'v1',
    provenance: {
      workflowId: 'workflow-1',
      workflowNodeId: 'mesh-output',
      extensionId: 'mesh-exporter',
      extensionNodeId: 'mesh-output',
    },
    ...patch,
  }
}

test('resolveViewerAssetTarget returns no target when no job exists', () => {
  assert.deepEqual(resolveViewerAssetTarget({ currentJob: null, apiUrl: API_URL }), {
    kind: 'none',
    modelUrl: null,
    isCheckpointPreview: false,
  })
})

test('resolveViewerAssetTarget preserves final generation visible URL and label', () => {
  assert.deepEqual(
    resolveViewerAssetTarget({
      currentJob: generationJob({ status: 'done', outputUrl: '/workspace/output/model.glb' }),
      apiUrl: API_URL,
    }),
    {
      kind: 'final',
      modelUrl: 'http://127.0.0.1:8000/workspace/output/model.glb',
      isCheckpointPreview: false,
      label: 'Final output',
      sourceLabel: 'Final output',
      sourceKind: 'generation',
      workspacePath: 'output/model.glb',
    },
  )
})

test('resolveViewerAssetTarget preserves checkpoint preview visible URL and label', () => {
  assert.deepEqual(
    resolveViewerAssetTarget({
      currentJob: generationJob({
        status: 'generating',
        outputUrl: '/workspace/checkpoints/wait.glb',
        previewKind: 'workflow-checkpoint',
      }),
      apiUrl: API_URL,
    }),
    {
      kind: 'workflow-checkpoint',
      modelUrl: 'http://127.0.0.1:8000/workspace/checkpoints/wait.glb',
      isCheckpointPreview: true,
      label: 'Temporary checkpoint — not final output',
      sourceLabel: 'Temporary checkpoint — not final output',
      sourceKind: 'workflow',
      workspacePath: 'checkpoints/wait.glb',
    },
  )
})

test('resolveViewerAssetTarget keeps visible final URL and labels for import, chat, history, and AddToScene writers', () => {
  const cases = [
    {
      name: 'import',
      currentJob: generationJob({ id: 'import-1777161040844', status: 'done', outputUrl: '/workspace/Default/imported.glb' }),
      expectedSourceKind: 'import',
      expectedUrl: 'http://127.0.0.1:8000/workspace/Default/imported.glb',
      expectedWorkspacePath: 'Default/imported.glb',
    },
    {
      name: 'chat',
      currentJob: generationJob({ id: 'job-chat', status: 'done', outputUrl: 'blob:http://local/chat-mesh' }),
      sourceKind: 'chat' as const,
      expectedSourceKind: 'chat',
      expectedUrl: 'blob:http://local/chat-mesh',
      expectedWorkspacePath: undefined,
    },
    {
      name: 'history',
      currentJob: generationJob({ id: 'job-history', status: 'done', outputUrl: '/workspace/history/undo.glb' }),
      sourceKind: 'history' as const,
      expectedSourceKind: 'history',
      expectedUrl: 'http://127.0.0.1:8000/workspace/history/undo.glb',
      expectedWorkspacePath: 'history/undo.glb',
    },
    {
      name: 'add-to-scene',
      currentJob: generationJob({ id: 'workflow-output', status: 'done', outputUrl: '/workspace/workflows/final.glb' }),
      sourceKind: 'add-to-scene' as const,
      expectedSourceKind: 'add-to-scene',
      expectedUrl: 'http://127.0.0.1:8000/workspace/workflows/final.glb',
      expectedWorkspacePath: 'workflows/final.glb',
    },
  ]

  for (const testCase of cases) {
    assert.deepEqual(
      resolveViewerAssetTarget({
        currentJob: testCase.currentJob,
        apiUrl: API_URL,
        sourceKind: testCase.sourceKind,
      }),
      {
        kind: 'final',
        modelUrl: testCase.expectedUrl,
        isCheckpointPreview: false,
        label: 'Final output',
        sourceLabel: 'Final output',
        sourceKind: testCase.expectedSourceKind,
        ...(testCase.expectedWorkspacePath ? { workspacePath: testCase.expectedWorkspacePath } : {}),
      },
      testCase.name,
    )
  }
})

test('resolveViewerAssetTarget attaches equivalent workflow artifact metadata while preserving the visible URL query', () => {
  assert.deepEqual(
    resolveViewerAssetTarget({
      currentJob: generationJob({ status: 'done', outputUrl: '/workspace/current/visible.glb?cache=today' }),
      apiUrl: API_URL,
      workflowArtifact: workflowArtifact({ uri: '/workspace/current/visible.glb' }),
      sourceKind: 'add-to-scene',
    }),
    {
      kind: 'final',
      modelUrl: 'http://127.0.0.1:8000/workspace/current/visible.glb?cache=today',
      isCheckpointPreview: false,
      label: 'Final output',
      sourceLabel: 'Final output',
      sourceKind: 'add-to-scene',
      workspacePath: 'current/visible.glb',
      artifactId: 'artifact-1',
      versionId: 'v1',
      provenance: {
        workflowId: 'workflow-1',
        workflowNodeId: 'mesh-output',
        extensionId: 'mesh-exporter',
        extensionNodeId: 'mesh-output',
      },
    },
  )
})

test('viewer asset custody rejects foreign origins, malformed raw routes and unconfigured absolute roots', () => {
  const workspaceDir = '/project/workspace'
  const options = { apiUrl: API_URL, workspaceDir }
  const safe = `${API_URL}/workspace/models/hero.glb?cache=1`
  assert.equal(resolveViewerAssetWorkspacePathFromUrl(safe, options), 'models/hero.glb')
  assert.equal(resolveViewerAssetWorkspacePathFromUrl(`${API_URL}/optimize/serve-file?path=${encodeURIComponent(workspaceDir + '/models/hero.glb')}`, options), 'models/hero.glb')
  for (const url of [
    'https://evil.test/workspace/models/hero.glb', '//evil.test/workspace/models/hero.glb',
    `${API_URL}/workspace/a/../hero.glb`, `${API_URL}/workspace/a/./hero.glb`,
    `${API_URL}/workspace//hero.glb`, `${API_URL}/workspace/%252e/hero.glb`,
    `${API_URL}/workspace/%2fhero.glb`, `${API_URL}/workspace/%00hero.glb`,
    `${API_URL}/workspace/hero.glb#x`, `${API_URL}/workspace/hero.glb?bad=%`,
    'http://user@127.0.0.1:8000/workspace/hero.glb',
    `${API_URL}/optimize/serve-file?path=/other/workspace/models/hero.glb`,
    `${API_URL}/optimize/serve-file?path=/project/workspace/models/hero.glb&path=/project/workspace/models/other.glb`,
    `${API_URL}/a/../optimize/serve-file?path=/project/workspace/models/hero.glb`,
  ]) assert.equal(resolveViewerAssetWorkspacePathFromUrl(url, options), undefined, url)
  assert.equal(resolveViewerWorkspacePathFromAbsoluteValue('/other/workspace/models/hero.glb', { workspaceDir, meshOnly: true }), undefined)
  assert.equal(resolveViewerWorkspacePathFromAbsoluteValue('/project/workspace/models/hero.glb', { meshOnly: true }), undefined)
})

test('viewer metadata never follows an unrelated visible artifact or conflicting descriptors', () => {
  for (const sourceKind of ['generation', 'workflow', 'import', 'chat', 'add-to-scene', 'history'] as const) {
    const target = resolveViewerAssetTarget({ currentJob: generationJob({ status: 'done', outputUrl: '/workspace/current/visible.glb' }), apiUrl: API_URL, workflowArtifact: workflowArtifact(), sourceKind })
    assert.equal(target.kind, 'final')
    assert.equal(target.workspacePath, 'current/visible.glb')
    assert.equal(target.artifactId, undefined)
    assert.equal(target.provenance, undefined)
  }
  assert.equal(resolveViewerArtifactWorkspacePath(workflowArtifact({ legacy: { filePath: '/workspace/other.glb', outputType: 'mesh' } })), undefined)
  const target = resolveViewerAssetTarget({ currentJob: generationJob({ status: 'done', outputUrl: 'blob:preview' }), apiUrl: API_URL, workflowArtifact: workflowArtifact() })
  assert.equal(target.kind === 'final' && target.workspacePath, undefined)
})

function libraryEntry(patch: Partial<RendererAssetLibraryEntry> = {}): RendererAssetLibraryEntry {
  return {
    id: 'library-1',
    workspacePath: 'Workflows/Characters/hero.glb',
    displayName: 'Library hero',
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
    openTarget: {
      kind: 'self',
      workspacePath: 'Workflows/Characters/hero.glb',
    },
    ...patch,
  }
}

test('resolveViewerAssetTargetFromLibraryEntry opens ready mesh library entries without currentJob parsing', () => {
  assert.deepEqual(
    resolveViewerAssetTargetFromLibraryEntry(libraryEntry(), API_URL),
    {
      kind: 'final',
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/Characters/hero.glb',
      isCheckpointPreview: false,
      label: 'Final output',
      sourceLabel: 'Library hero',
      sourceKind: 'import',
      workspacePath: 'Workflows/Characters/hero.glb',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      provenance: {
        workflowId: 'workflow-1',
        workflowNodeId: 'node-1',
      },
    },
  )
})

test('resolveViewerAssetTargetFromLibraryEntry adapts linked sidecars through their source mesh metadata', () => {
  assert.deepEqual(
    resolveViewerAssetTargetFromLibraryEntry(libraryEntry({
      id: 'landmark-1',
      workspacePath: 'Workflows/landmarks/run-1/node-1.landmarks.v1.json',
      displayName: 'Shoulder landmarks',
      capability: 'landmarks-sidecar',
      previewKind: 'text',
      artifactId: 'sidecar-artifact-1',
      versionId: 'sidecar-version-1',
      provenance: undefined,
      source: {
        relation: 'sidecar-source',
        workspacePath: 'Workflows/Characters/source.glb',
        assetId: 'source-asset-1',
        versionId: 'source-version-1',
      },
      openTarget: {
        kind: 'linked-source',
        workspacePath: 'Workflows/Characters/source.glb',
        relation: 'sidecar-source',
      },
    }), API_URL),
    {
      kind: 'final',
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/Characters/source.glb',
      isCheckpointPreview: false,
      label: 'Final output',
      sourceLabel: 'Shoulder landmarks',
      sourceKind: 'import',
      workspacePath: 'Workflows/Characters/source.glb',
      artifactId: 'source-asset-1',
      versionId: 'source-version-1',
    },
  )
})

test('resolveViewerAssetTargetFromLibraryEntry opens animation-motion glb or gltf entries through their own viewer target seam', () => {
  for (const workspacePath of ['Workflows/Animations/walk-cycle.glb', 'Exports/Animations/walk-cycle.gltf']) {
    assert.deepEqual(
      resolveViewerAssetTargetFromLibraryEntry(libraryEntry({
        id: workspacePath,
        workspacePath,
        displayName: workspacePath.split('/').at(-1) ?? workspacePath,
        sourceScope: workspacePath.startsWith('Exports/') ? 'exports' : 'workflows',
        capability: 'animation-motion',
        previewKind: '3d-model',
        source: undefined,
        openTarget: {
          kind: 'self',
          workspacePath,
        },
      }), API_URL),
      {
        kind: 'final',
        modelUrl: `${API_URL}/workspace/${workspacePath}`,
        isCheckpointPreview: false,
        label: 'Final output',
        sourceLabel: workspacePath.split('/').at(-1) ?? workspacePath,
        sourceKind: 'import',
        workspacePath,
        artifactId: 'artifact-1',
        versionId: 'version-1',
        provenance: {
          workflowId: 'workflow-1',
          workflowNodeId: 'node-1',
        },
      },
      workspacePath,
    )
  }
})

test('resolveViewerAssetTargetFromLibraryEntry fails closed for entries that are not openable in Generate', () => {
  assert.deepEqual(
    resolveViewerAssetTargetFromLibraryEntry(libraryEntry({
      workspacePath: 'Worlds/generated-world.json',
      displayName: 'Generated world',
      capability: 'generated-world',
      previewKind: 'text',
      openTarget: {
        kind: 'unavailable',
        reason: 'capability-not-viewable',
      },
    }), API_URL),
    {
      kind: 'none',
      modelUrl: null,
      isCheckpointPreview: false,
    },
  )

  assert.deepEqual(
    resolveViewerAssetTargetFromLibraryEntry(libraryEntry({
      workspacePath: 'Characters/hero.obj',
      displayName: 'OBJ hero',
      capability: 'mesh',
      previewKind: 'binary',
      openTarget: {
        kind: 'unavailable',
        reason: 'capability-not-viewable',
      },
    }), API_URL),
    {
      kind: 'none',
      modelUrl: null,
      isCheckpointPreview: false,
    },
  )
})
