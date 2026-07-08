import { PROCESS_PORT_HANDLE_COLOR, resolveProcessTargetColor } from '../processPorts'

import { previewNodeTargetArtifactKind } from './previewNodeShared.ts'

type WorkflowEdgeTargetColorArgs = {
  targetNodeType?: string
  targetExtension?: Parameters<typeof resolveProcessTargetColor>[0]
  targetHandle?: string | null
}

export function resolveWorkflowEdgeTargetColor({ targetNodeType, targetExtension = {}, targetHandle }: WorkflowEdgeTargetColorArgs): string {
  if (targetNodeType === 'outputNode' || targetNodeType === 'addToWorldsNode') return PROCESS_PORT_HANDLE_COLOR.mesh
  const previewTargetKind = previewNodeTargetArtifactKind(targetNodeType)
  if (previewTargetKind) return PROCESS_PORT_HANDLE_COLOR[previewTargetKind]
  if (targetNodeType === 'imagePreviewNode') return PROCESS_PORT_HANDLE_COLOR.image

  return resolveProcessTargetColor(targetExtension, targetHandle)
}
