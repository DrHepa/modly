import assert from 'node:assert/strict'
import test from 'node:test'

import type { GenerationJob } from '../../shared/stores/appStore.ts'
import type { ViewerAssetTarget } from './viewerAssetTarget.ts'
import { resolveViewerModelSource } from './viewerModelSource.ts'

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

test('resolveViewerModelSource returns no model when no job exists', () => {
  assert.deepEqual(resolveViewerModelSource(null, API_URL), {
    kind: 'none',
    modelUrl: null,
    isCheckpointPreview: false,
  })
})

test('resolveViewerModelSource returns no model when outputUrl is missing', () => {
  assert.deepEqual(resolveViewerModelSource(generationJob({ status: 'done', outputUrl: undefined }), API_URL), {
    kind: 'none',
    modelUrl: null,
    isCheckpointPreview: false,
  })
})

test('resolveViewerModelSource resolves done output as a final model source with apiUrl', () => {
  assert.deepEqual(resolveViewerModelSource(generationJob({ status: 'done', outputUrl: '/workspace/output/model.glb' }), API_URL), {
    kind: 'final',
    modelUrl: 'http://127.0.0.1:8000/workspace/output/model.glb',
    isCheckpointPreview: false,
    label: 'Final output',
  })
})

test('resolveViewerModelSource resolves explicit workflow checkpoint preview as temporary source', () => {
  assert.deepEqual(
    resolveViewerModelSource(
      generationJob({
        status: 'generating',
        outputUrl: '/workspace/checkpoints/wait.glb',
        previewKind: 'workflow-checkpoint',
      }),
      API_URL,
    ),
    {
      kind: 'workflow-checkpoint',
      modelUrl: 'http://127.0.0.1:8000/workspace/checkpoints/wait.glb',
      isCheckpointPreview: true,
      label: 'Temporary checkpoint — not final output',
    },
  )
})

test('resolveViewerModelSource ignores generating outputUrl without explicit previewKind', () => {
  assert.deepEqual(resolveViewerModelSource(generationJob({ outputUrl: '/workspace/checkpoints/wait.glb' }), API_URL), {
    kind: 'none',
    modelUrl: null,
    isCheckpointPreview: false,
  })
})

test('resolveViewerModelSource does not use checkpoint-like step text as functional state', () => {
  assert.deepEqual(
    resolveViewerModelSource(generationJob({ outputUrl: '/workspace/checkpoints/wait.glb', step: 'Workflow checkpoint' }), API_URL),
    {
      kind: 'none',
      modelUrl: null,
      isCheckpointPreview: false,
    },
  )
})

test('resolveViewerModelSource gives done output normal final precedence over preview metadata', () => {
  assert.deepEqual(
    resolveViewerModelSource(
      generationJob({
        status: 'done',
        outputUrl: '/workspace/final/model.glb',
        previewKind: 'workflow-checkpoint',
      }),
      API_URL,
    ),
    {
      kind: 'final',
      modelUrl: 'http://127.0.0.1:8000/workspace/final/model.glb',
      isCheckpointPreview: false,
      label: 'Final output',
    },
  )
})

test('resolveViewerModelSource bridges final viewer targets without changing the legacy output shape', () => {
  const target: ViewerAssetTarget = {
    kind: 'final',
    modelUrl: 'http://127.0.0.1:8000/workspace/final/bridge.glb',
    isCheckpointPreview: false,
    label: 'Final output',
    sourceLabel: 'Final output',
    sourceKind: 'workflow',
    workspacePath: 'final/bridge.glb',
    artifactId: 'artifact-1',
    versionId: 'v1',
  }

  assert.deepEqual(resolveViewerModelSource(target), {
    kind: 'final',
    modelUrl: 'http://127.0.0.1:8000/workspace/final/bridge.glb',
    isCheckpointPreview: false,
    label: 'Final output',
  })
})

test('resolveViewerModelSource bridges checkpoint viewer targets without changing scene-edit eligibility semantics', () => {
  const target: ViewerAssetTarget = {
    kind: 'workflow-checkpoint',
    modelUrl: 'http://127.0.0.1:8000/workspace/checkpoints/bridge.glb',
    isCheckpointPreview: true,
    label: 'Temporary checkpoint — not final output',
    sourceLabel: 'Temporary checkpoint — not final output',
    sourceKind: 'workflow',
    workspacePath: 'checkpoints/bridge.glb',
  }

  assert.deepEqual(resolveViewerModelSource(target), {
    kind: 'workflow-checkpoint',
    modelUrl: 'http://127.0.0.1:8000/workspace/checkpoints/bridge.glb',
    isCheckpointPreview: true,
    label: 'Temporary checkpoint — not final output',
  })
})
