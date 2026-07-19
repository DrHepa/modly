import { PROCESS_PORT_HANDLE_COLOR, resolveProcessTargetColor } from '../processPorts.ts'
import type { ModelInputKind } from '../../../shared/types/electron.d.ts'

import { previewNodeTargetArtifactKind } from './previewNodeShared.ts'

type WorkflowEdgeTargetColorArgs = {
  targetNodeType?: string
  targetExtension?: {
    input?: ModelInputKind
    inputs?: Array<{ name: string; type: string; required?: boolean }>
  }
  targetHandle?: string | null
}

export function resolveWorkflowEdgeTargetColor({ targetNodeType, targetExtension = {}, targetHandle }: WorkflowEdgeTargetColorArgs): string {
  if (targetNodeType === 'outputNode' || targetNodeType === 'addToWorldsNode') return PROCESS_PORT_HANDLE_COLOR.mesh
  const previewTargetKind = previewNodeTargetArtifactKind(targetNodeType)
  if (previewTargetKind) return PROCESS_PORT_HANDLE_COLOR[previewTargetKind]

  return resolveProcessTargetColor(targetExtension, targetHandle)
}
