import type { WFNode } from '../../shared/types/electron.d'
import { getWorkflowExtension } from './mockExtensions.ts'
import type { WorkflowExtension } from './mockExtensions.ts'

export type WorkflowDispatchMode = 'model' | 'process'

export function resolveWorkflowDispatch(
  node: WFNode,
  allExtensions: WorkflowExtension[],
): { ext: WorkflowExtension; mode: WorkflowDispatchMode } {
  const extensionId = node.data.extensionId ?? ''
  const ext = getWorkflowExtension(extensionId, allExtensions)

  if (!ext) {
    throw new Error(`Unresolved workflow extension: ${extensionId}`)
  }

  return {
    ext,
    mode: ext.type === 'model' ? 'model' : 'process',
  }
}
