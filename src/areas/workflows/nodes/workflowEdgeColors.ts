import { PROCESS_PORT_HANDLE_COLOR, resolveProcessTargetColor } from '../processPorts'

import { isPreviewNodeType } from './previewNodeShared'

type WorkflowEdgeTargetColorArgs = {
  targetNodeType?: string
  targetExtension?: {
    input?: 'image' | 'text' | 'mesh'
    inputs?: Array<{ name: string; type: 'image' | 'text' | 'mesh'; required?: boolean }>
  }
  targetHandle?: string | null
}

export function resolveWorkflowEdgeTargetColor({ targetNodeType, targetExtension = {}, targetHandle }: WorkflowEdgeTargetColorArgs): string {
  if (targetNodeType === 'outputNode') return PROCESS_PORT_HANDLE_COLOR.mesh
  if (isPreviewNodeType(targetNodeType)) return PROCESS_PORT_HANDLE_COLOR.image

  return resolveProcessTargetColor(targetExtension, targetHandle)
}
