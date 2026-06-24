import { PROCESS_PORT_HANDLE_COLOR, resolveProcessTargetColor } from '../processPorts'

import { isPreviewNodeType } from './previewNodeShared'

type WorkflowEdgeTargetColorArgs = {
  targetNodeType?: string
  targetExtension?: Parameters<typeof resolveProcessTargetColor>[0]
  targetHandle?: string | null
}

export function resolveWorkflowEdgeTargetColor({ targetNodeType, targetExtension = {}, targetHandle }: WorkflowEdgeTargetColorArgs): string {
  if ((targetNodeType === 'outputNode' || targetNodeType === 'addToWorldsNode')) return PROCESS_PORT_HANDLE_COLOR.mesh
  if (isPreviewNodeType(targetNodeType) || targetNodeType === 'imagePreviewNode') return PROCESS_PORT_HANDLE_COLOR.image

  return resolveProcessTargetColor(targetExtension, targetHandle)
}
