import assert from 'node:assert/strict'
import test from 'node:test'

import type { ArtifactRef } from '../../shared/types/artifacts.ts'
import type { ViewerAssetTarget } from './viewerAssetTarget.ts'
import { resolveViewerRigSourceWorkspacePath, resolveViewerTargetPresentation } from './viewerProvenance.ts'

const provenance: ArtifactRef['provenance'] = {
  workflowId: 'workflow-1',
  workflowNodeId: 'mesh-output',
  extensionId: 'mesh-exporter',
  extensionNodeId: 'mesh-output',
}

function finalTarget(patch: Partial<Extract<ViewerAssetTarget, { kind: 'final' }>> = {}): Extract<ViewerAssetTarget, { kind: 'final' }> {
  return {
    kind: 'final',
    modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/generated/avatar.glb',
    isCheckpointPreview: false,
    label: 'Final output',
    sourceLabel: 'Imported mesh',
    sourceKind: 'import',
    workspacePath: 'Workflows/generated/avatar.glb',
    provenance,
    ...patch,
  }
}

function checkpointTarget(patch: Partial<Extract<ViewerAssetTarget, { kind: 'workflow-checkpoint' }>> = {}): Extract<ViewerAssetTarget, { kind: 'workflow-checkpoint' }> {
  return {
    kind: 'workflow-checkpoint',
    modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/checkpoints/wait.glb',
    isCheckpointPreview: true,
    label: 'Temporary checkpoint — not final output',
    sourceLabel: 'Temporary checkpoint — not final output',
    sourceKind: 'workflow',
    workspacePath: 'Workflows/checkpoints/wait.glb',
    provenance,
    ...patch,
  }
}

test('resolveViewerTargetPresentation preserves source label and provenance for final targets', () => {
  assert.deepEqual(resolveViewerTargetPresentation(finalTarget()), {
    modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/generated/avatar.glb',
    checkpointLabel: null,
    sourceLabel: 'Imported mesh',
    provenance,
    canDeleteSelectedModel: true,
    selectedHint: 'Click mesh to select • Delete to remove',
    idleHint: 'Drag to rotate • Scroll to zoom',
  })
})

test('resolveViewerTargetPresentation keeps checkpoint-vs-final behavior distinct', () => {
  assert.deepEqual(resolveViewerTargetPresentation(checkpointTarget()), {
    modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/checkpoints/wait.glb',
    checkpointLabel: 'Temporary checkpoint — not final output',
    sourceLabel: 'Temporary checkpoint — not final output',
    provenance,
    canDeleteSelectedModel: false,
    selectedHint: 'Temporary checkpoint — not final output',
    idleHint: 'Drag to rotate • Scroll to zoom',
  })
})

test('resolveViewerRigSourceWorkspacePath prefers normalized target workspace paths', () => {
  assert.equal(
    resolveViewerRigSourceWorkspacePath(finalTarget({ workspacePath: 'Workflows/generated/avatar.glb', modelUrl: 'blob:http://local/avatar' })),
    'Workflows/generated/avatar.glb',
  )
})

test('resolveViewerRigSourceWorkspacePath derives workspace paths from viewer URLs when metadata is absent', () => {
  assert.equal(
    resolveViewerRigSourceWorkspacePath(finalTarget({ workspacePath: undefined, modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/generated/avatar.glb?cache=1' })),
    'Workflows/generated/avatar.glb',
  )

  assert.equal(
    resolveViewerRigSourceWorkspacePath(finalTarget({
      workspacePath: undefined,
      modelUrl: 'http://127.0.0.1:8000/optimize/serve-file?path=%2Fhome%2Fdrhepa%2FDocumentos%2FModly%2Fworkspace%2FWorkflows%2Fgenerated%2Favatar.glb',
    })),
    'Workflows/generated/avatar.glb',
  )
})

test('resolveViewerRigSourceWorkspacePath fails closed for traversal and absolute-path inputs', () => {
  const unsafeTargets: ViewerAssetTarget[] = [
    finalTarget({ workspacePath: '../outside/avatar.glb', modelUrl: 'http://127.0.0.1:8000/workspace/../outside/avatar.glb' }),
    finalTarget({ workspacePath: '/outside/avatar.glb', modelUrl: 'http://127.0.0.1:8000/workspace/../outside/avatar.glb' }),
    finalTarget({ workspacePath: 'C:/outside/avatar.glb', modelUrl: 'C:/outside/avatar.glb' }),
    finalTarget({ workspacePath: undefined, modelUrl: 'http://127.0.0.1:8000/workspace/../outside/avatar.glb' }),
  ]

  for (const target of unsafeTargets) {
    assert.equal(resolveViewerRigSourceWorkspacePath(target), undefined)
  }
})
