import assert from 'node:assert/strict'
import test from 'node:test'

import type { ArtifactRef } from '../../shared/types/artifacts.ts'
import type { GenerationJob } from '../../shared/stores/appStore.ts'
import { resolveViewerAssetTarget } from './viewerAssetTarget.ts'

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

test('resolveViewerAssetTarget prefers workflow artifact metadata while preserving currentJob visible URL', () => {
  assert.deepEqual(
    resolveViewerAssetTarget({
      currentJob: generationJob({ status: 'done', outputUrl: '/workspace/current/visible.glb?cache=today' }),
      apiUrl: API_URL,
      workflowArtifact: workflowArtifact(),
      sourceKind: 'add-to-scene',
    }),
    {
      kind: 'final',
      modelUrl: 'http://127.0.0.1:8000/workspace/current/visible.glb?cache=today',
      isCheckpointPreview: false,
      label: 'Final output',
      sourceLabel: 'Final output',
      sourceKind: 'add-to-scene',
      workspacePath: 'Workflows/generated/from-artifact.glb',
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
