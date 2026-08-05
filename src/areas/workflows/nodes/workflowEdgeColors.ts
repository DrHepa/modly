import { PROCESS_PORT_HANDLE_COLOR, resolveProcessTargetColor } from '../processPorts'

import { previewNodeTargetArtifactKind } from './previewNodeShared.ts'

type WorkflowEdgeTargetColorArgs = {
  targetNodeType?: string
  targetExtension?: Parameters<typeof resolveProcessTargetColor>[0]
  targetHandle?: string | null
}

type WorkflowEdgeSourceColorArgs = {
  sourceNodeType?: string
  extensionOutput?: string
}

export function resolveWorkflowEdgeSourceColor({ sourceNodeType, extensionOutput }: WorkflowEdgeSourceColorArgs): string {
  if (sourceNodeType === 'imageNode') return PROCESS_PORT_HANDLE_COLOR.image
  if (sourceNodeType === 'videoNode') return PROCESS_PORT_HANDLE_COLOR.video
  if (sourceNodeType === 'textNode') return PROCESS_PORT_HANDLE_COLOR.text
  if (sourceNodeType === 'meshNode') return PROCESS_PORT_HANDLE_COLOR.mesh
  if (sourceNodeType === 'sceneNode') return PROCESS_PORT_HANDLE_COLOR.scene
  return (extensionOutput ? PROCESS_PORT_HANDLE_COLOR[extensionOutput] : undefined) ?? '#52525b'
}

export function resolveWorkflowEdgeTargetColor({ targetNodeType, targetExtension = {}, targetHandle }: WorkflowEdgeTargetColorArgs): string {
  if (targetNodeType === 'outputNode' || targetNodeType === 'addToWorldsNode') return PROCESS_PORT_HANDLE_COLOR.mesh
  const previewTargetKind = previewNodeTargetArtifactKind(targetNodeType)
  if (previewTargetKind) return PROCESS_PORT_HANDLE_COLOR[previewTargetKind]
  if (targetNodeType === 'imagePreviewNode') return PROCESS_PORT_HANDLE_COLOR.image

  return resolveProcessTargetColor(targetExtension, targetHandle)
}
