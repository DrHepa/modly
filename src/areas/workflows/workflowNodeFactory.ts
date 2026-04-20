import type { WFNode } from '@shared/types/electron.d'

import { getWorkflowExtension, type WorkflowExtension } from './mockExtensions.ts'
import { hydrateWorkflowNodeParams } from './workflowNodeParams.ts'

type ExtensionNodePosition = WFNode['position']

interface CreateHydratedExtensionWorkflowNodeOptions {
  id: string
  extensionId: string
  position: ExtensionNodePosition
  allExtensions: WorkflowExtension[]
}

export function createHydratedExtensionWorkflowNode({
  id,
  extensionId,
  position,
  allExtensions,
}: CreateHydratedExtensionWorkflowNodeOptions): WFNode {
  const ext = getWorkflowExtension(extensionId, allExtensions)

  return {
    id,
    type: 'extensionNode',
    position,
    data: {
      extensionId,
      enabled: true,
      params: hydrateWorkflowNodeParams(ext, {}),
    },
  }
}
