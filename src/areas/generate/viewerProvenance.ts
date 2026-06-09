import type { ArtifactRef } from '../../shared/types/artifacts.ts'
import type { ViewerModelSource } from './viewerModelSource.ts'
import { resolveViewerAssetWorkspacePathFromUrl, type ViewerAssetTarget, type ViewerWorkspaceContext } from './viewerAssetTarget.ts'

export interface ViewerTargetPresentation {
  modelUrl: string | null
  checkpointLabel: string | null
  sourceLabel: string | null
  provenance?: ArtifactRef['provenance']
  canDeleteSelectedModel: boolean
  selectedHint: string
  idleHint: string
}

const DEFAULT_SELECTED_HINT = 'Click mesh to select • Delete to remove'
const DEFAULT_IDLE_HINT = 'Drag to rotate • Scroll to zoom'

export function resolveViewerTargetPresentation(target: ViewerAssetTarget | ViewerModelSource): ViewerTargetPresentation {
  const checkpointLabel = target.kind === 'workflow-checkpoint' ? target.label : null
  return {
    modelUrl: target.modelUrl,
    checkpointLabel,
    sourceLabel: target.kind === 'none' ? null : 'sourceLabel' in target ? target.sourceLabel : target.label,
    ...('provenance' in target && target.provenance ? { provenance: target.provenance } : {}),
    canDeleteSelectedModel: target.kind === 'final',
    selectedHint: checkpointLabel ?? DEFAULT_SELECTED_HINT,
    idleHint: DEFAULT_IDLE_HINT,
  }
}

export function resolveViewerRigSourceWorkspacePath(target: { modelUrl: string | null; workspacePath?: string }, context: ViewerWorkspaceContext = {}): string | undefined {
  const visible = resolveViewerAssetWorkspacePathFromUrl(target.modelUrl, context)
  // Optional metadata corroborates the displayed asset; it cannot authorize a blob/foreign rig.
  return target.workspacePath === undefined || target.workspacePath === visible ? visible : undefined
}
