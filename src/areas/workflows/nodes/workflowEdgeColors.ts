import { PROCESS_PORT_HANDLE_COLOR, resolveProcessTargetColor } from '../processPorts.ts'
import type { ModelInputKind } from '../../../shared/types/electron.d.ts'
import type { ArtifactKind } from '../../../shared/types/artifacts.ts'

import { previewNodeTargetArtifactKind } from './previewNodeShared.ts'

type WorkflowEdgeTargetColorArgs = {
  targetNodeType?: string
  targetExtension?: {
    input?: ModelInputKind
    inputs?: Array<{ name: string; type: string; required?: boolean }>
  }
  targetHandle?: string | null
}

type WorkflowEdgeSourceColorArgs = {
  sourceNodeType?: string
  extensionOutput?: ArtifactKind
}

export function resolveWorkflowEdgeSourceColor({ sourceNodeType, extensionOutput }: WorkflowEdgeSourceColorArgs): string {
  if (sourceNodeType === 'imageNode') return PROCESS_PORT_HANDLE_COLOR.image
  if (sourceNodeType === 'videoNode') return PROCESS_PORT_HANDLE_COLOR.video
  if (sourceNodeType === 'textNode') return PROCESS_PORT_HANDLE_COLOR.text
  if (sourceNodeType === 'meshNode') return PROCESS_PORT_HANDLE_COLOR.mesh
  if (sourceNodeType === 'sceneNode') return PROCESS_PORT_HANDLE_COLOR.scene
  return extensionOutput ? PROCESS_PORT_HANDLE_COLOR[extensionOutput] : '#52525b'
}

export function resolveWorkflowEdgeTargetColor({ targetNodeType, targetExtension = {}, targetHandle }: WorkflowEdgeTargetColorArgs): string {
  if (targetNodeType === 'outputNode' || targetNodeType === 'addToWorldsNode') return PROCESS_PORT_HANDLE_COLOR.mesh
  const previewTargetKind = previewNodeTargetArtifactKind(targetNodeType)
  if (previewTargetKind) return PROCESS_PORT_HANDLE_COLOR[previewTargetKind]

  return resolveProcessTargetColor(targetExtension, targetHandle)
}
