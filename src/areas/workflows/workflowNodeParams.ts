import type { WorkflowExtension } from './mockExtensions.ts'
import { isSupportedWorkflowParam } from './workflowParamSchema.ts'

export type WorkflowNodeParamValue = string | number | boolean

type WorkflowNodeParams = Record<string, unknown>
type WorkflowExtensionLike = Pick<WorkflowExtension, 'params'>

export function getWorkflowParamDefaults(ext?: WorkflowExtensionLike): Record<string, WorkflowNodeParamValue> {
  if (!ext) return {}

  return ext.params.reduce<Record<string, WorkflowNodeParamValue>>((defaults, param) => {
    if (!isSupportedWorkflowParam(param)) return defaults

    defaults[param.id] = param.default
    return defaults
  }, {})
}

export function hydrateWorkflowNodeParams(
  ext: WorkflowExtensionLike | undefined,
  rawParams?: WorkflowNodeParams,
): WorkflowNodeParams {
  const defaults = getWorkflowParamDefaults(ext)
  return { ...defaults, ...(rawParams ?? {}) }
}
