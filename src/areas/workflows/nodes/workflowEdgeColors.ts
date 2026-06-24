import { PROCESS_PORT_HANDLE_COLOR, resolveProcessTargetColor } from '../processPorts'
import type { ArtifactKind } from '../../../shared/types/artifacts.ts'

import { isPreviewNodeType } from './previewNodeShared'

type WorkflowEdgeTargetColorArgs = {
  targetNodeType?: string
  targetExtension?: {
    input?: ArtifactKind
    inputs?: Array<{ name: string; type: ArtifactKind; required?: boolean }>
  }
  targetHandle?: string | null
}

export function resolveWorkflowEdgeTargetColor({ targetNodeType, targetExtension = {}, targetHandle }: WorkflowEdgeTargetColorArgs): string {
  if (targetNodeType === 'outputNode' || targetNodeType === 'addToWorldsNode') return PROCESS_PORT_HANDLE_COLOR.mesh
  if (isPreviewNodeType(targetNodeType)) return PROCESS_PORT_HANDLE_COLOR.image

  return resolveProcessTargetColor(targetExtension, targetHandle)
}
