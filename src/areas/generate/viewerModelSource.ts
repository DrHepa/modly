import type { GenerationJob } from '../../shared/stores/appStore'
import type { SceneEditArtifactDescriptor, SceneEditEligibilityResult } from './sceneEdit.types'
import { isSafeViewerWorkspaceRelativePath, resolveViewerAssetTarget, type ViewerAssetTarget } from './viewerAssetTarget.ts'

export type ViewerModelSource =
  | { kind: 'none'; modelUrl: null; isCheckpointPreview: false }
  | { kind: 'final'; modelUrl: string; isCheckpointPreview: false; label: 'Final output' }
  | {
      kind: 'workflow-checkpoint'
      modelUrl: string
      isCheckpointPreview: true
      label: 'Temporary checkpoint — not final output'
    }

export function resolveViewerModelSource(target: ViewerAssetTarget): ViewerModelSource
export function resolveViewerModelSource(currentJob: GenerationJob | null, apiUrl: string): ViewerModelSource
export function resolveViewerModelSource(
  currentJobOrTarget: GenerationJob | ViewerAssetTarget | null,
  apiUrl?: string,
): ViewerModelSource {
  const target = isViewerAssetTarget(currentJobOrTarget)
    ? currentJobOrTarget
    : resolveViewerAssetTarget({ currentJob: currentJobOrTarget, apiUrl: apiUrl ?? '' })

  if (target.kind === 'none') {
    return {
      kind: 'none',
      modelUrl: null,
      isCheckpointPreview: false,
    }
  }

  return {
    kind: target.kind,
    modelUrl: target.modelUrl,
    isCheckpointPreview: target.isCheckpointPreview,
    label: target.label,
  }
}

function isViewerAssetTarget(value: GenerationJob | ViewerAssetTarget | null): value is ViewerAssetTarget {
  return Boolean(value && typeof value === 'object' && 'kind' in value && 'isCheckpointPreview' in value && 'modelUrl' in value)
}

export interface CheckpointEditEligibilityInput {
  modelSource: ViewerModelSource
  artifact: SceneEditArtifactDescriptor
}

export function resolveCheckpointEditEligibility(input: CheckpointEditEligibilityInput): SceneEditEligibilityResult {
  if (input.modelSource.kind !== 'workflow-checkpoint' || !input.modelSource.isCheckpointPreview) {
    return { eligible: false, reason: 'not-checkpoint-preview' }
  }

  if (input.artifact.type !== 'mesh') {
    return { eligible: false, reason: 'not-mesh-artifact' }
  }

  if (!isSafeViewerWorkspaceRelativePath(input.artifact.workspacePath, { meshOnly: true })) {
    return { eligible: false, reason: 'unsafe-workspace-path' }
  }

  return { eligible: true }
}
