import type { WorkflowExtension } from './mockExtensions.ts'

export type WorkflowNodeParamValue = string | number | boolean

type WorkflowNodeParams = Record<string, unknown>
type WorkflowExtensionLike = Pick<WorkflowExtension, 'params'>

export function getWorkflowParamDefaults(ext?: WorkflowExtensionLike): Record<string, unknown> {
  if (!ext) return {}

  return ext.params.reduce<Record<string, unknown>>((defaults, param) => {
    // Display support is not a runtime allowlist: custom defaults remain intact.
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

/** Connected text wins; an explicit empty prompt never falls back to an alias. */
export function resolveWorkflowPrompt(params: WorkflowNodeParams, inputText?: string): string {
  return inputText ?? (typeof params.prompt === 'string' ? params.prompt : typeof params.text === 'string' ? params.text : '')
}
