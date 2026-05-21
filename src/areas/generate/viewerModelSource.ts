import type { GenerationJob } from '../../shared/stores/appStore'
import type { SceneEditArtifactDescriptor, SceneEditEligibilityResult } from './sceneEdit.types'

export type ViewerModelSource =
  | { kind: 'none'; modelUrl: null; isCheckpointPreview: false }
  | { kind: 'final'; modelUrl: string; isCheckpointPreview: false; label: 'Final output' }
  | {
      kind: 'workflow-checkpoint'
      modelUrl: string
      isCheckpointPreview: true
      label: 'Temporary checkpoint — not final output'
    }

function resolveModelUrl(outputUrl: string, apiUrl: string): string {
  if (outputUrl.startsWith('http://') || outputUrl.startsWith('https://') || outputUrl.startsWith('blob:')) {
    return outputUrl
  }

  return outputUrl.startsWith('/') ? `${apiUrl}${outputUrl}` : outputUrl
}

export function resolveViewerModelSource(currentJob: GenerationJob | null, apiUrl: string): ViewerModelSource {
  if (!currentJob?.outputUrl) {
    return {
      kind: 'none',
      modelUrl: null,
      isCheckpointPreview: false,
    }
  }

  if (currentJob.status === 'done') {
    return {
      kind: 'final',
      modelUrl: resolveModelUrl(currentJob.outputUrl, apiUrl),
      isCheckpointPreview: false,
      label: 'Final output',
    }
  }

  if (currentJob.status === 'generating' && currentJob.previewKind === 'workflow-checkpoint') {
    return {
      kind: 'workflow-checkpoint',
      modelUrl: resolveModelUrl(currentJob.outputUrl, apiUrl),
      isCheckpointPreview: true,
      label: 'Temporary checkpoint — not final output',
    }
  }

  return {
    kind: 'none',
    modelUrl: null,
    isCheckpointPreview: false,
  }
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

  if (!isSafeWorkspaceRelativePath(input.artifact.workspacePath)) {
    return { eligible: false, reason: 'unsafe-workspace-path' }
  }

  return { eligible: true }
}

function isSafeWorkspaceRelativePath(workspacePath: string): boolean {
  const normalized = workspacePath.replace(/\\/g, '/')

  return (
    normalized.trim().length > 0 &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split('/').some((segment) => segment === '..')
  )
}
