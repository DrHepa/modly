import type { ArtifactRef } from '../../shared/types/artifacts.ts'
import {
  isSafeViewerWorkspaceRelativePath,
  resolveViewerAssetWorkspacePathFromUrl,
  type ViewerAssetTarget,
} from './viewerAssetTarget.ts'

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

export function resolveViewerTargetPresentation(target: ViewerAssetTarget): ViewerTargetPresentation {
  const checkpointLabel = target.kind === 'workflow-checkpoint' ? target.label : null

  return {
    modelUrl: target.modelUrl,
    checkpointLabel,
    sourceLabel: target.kind === 'none' ? null : target.sourceLabel,
    ...(target.kind !== 'none' && target.provenance ? { provenance: target.provenance } : {}),
    canDeleteSelectedModel: target.kind === 'final',
    selectedHint: checkpointLabel ?? DEFAULT_SELECTED_HINT,
    idleHint: DEFAULT_IDLE_HINT,
  }
}

export function resolveViewerRigSourceWorkspacePath(target: Pick<ViewerAssetTarget, 'workspacePath' | 'modelUrl'>): string | undefined {
  return normalizeViewerRigWorkspacePath(target.workspacePath) ?? resolveViewerAssetWorkspacePathFromUrl(target.modelUrl)
}

function normalizeViewerRigWorkspacePath(workspacePath: string | undefined): string | undefined {
  if (typeof workspacePath !== 'string') return undefined
  const normalized = workspacePath.replace(/\\/g, '/').trim().replace(/^\/workspace\//, '')
  return isSafeViewerWorkspaceRelativePath(normalized, { meshOnly: true }) ? normalized : undefined
}
