import type {
  BooleanParamSchema,
  ParamSchema,
  StringParamSchema,
} from '../../../shared/types/electron.d.ts'
import { openParamPicker, type ParamPickerApi } from '../../../shared/utils/paramPicker.ts'

export type WorkflowParamValue = boolean | number | string

export type WorkflowPickerFsApi = ParamPickerApi & {
  savePath: (args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }) => Promise<string | null>
}

/** UI resolution only: retain unknown supplied values for controls and execution. */
export function resolveWorkflowParamValues(params: ParamSchema[], supplied: Record<string, unknown>): Record<string, unknown> {
  return { ...supplied, ...Object.fromEntries(params.map((param) => [param.id, (Object.hasOwn(supplied, param.id) ? supplied[param.id] : undefined) ?? param.default])) }
}

export function isWorkflowParamVisible(param: ParamSchema, values: Record<string, unknown>): boolean {
  return !param.show_if || Object.entries(param.show_if).every(([key, expected]) =>
    Array.isArray(expected) ? expected.includes(values[key] as WorkflowParamValue) : values[key] === expected,
  )
}

export function resolveBooleanParamValue(param: BooleanParamSchema, value: WorkflowParamValue): boolean {
  return typeof value === 'boolean' ? value : param.default
}

export function toggleBooleanParamValue(param: BooleanParamSchema, value: WorkflowParamValue): boolean {
  return !resolveBooleanParamValue(param, value)
}

export function isPickerEnabled(param: ParamSchema): param is StringParamSchema {
  return param.type === 'string'
}

export async function selectWorkflowParamPath(
  fs: WorkflowPickerFsApi,
  param: StringParamSchema,
  currentValue: string,
): Promise<string | null> {
  const intent = param.pickerIntent ?? param.picker_intent
  if (intent === 'generic-file') return null // No generic-file IPC exists in this host.
  if (intent === 'directory') return fs.selectDirectory()
  if (intent === 'save-path') {
    return fs.savePath({
      filters: param.filters ?? [],
      ...(currentValue ? { defaultPath: currentValue } : {}),
    })
  }
  return openParamPicker(param, fs)
}
