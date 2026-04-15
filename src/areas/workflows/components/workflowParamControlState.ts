import type {
  BooleanParamSchema,
  ParamSchema,
  StringParamSchema,
  WorkflowPickerIntent,
} from '../../../shared/types/electron.d.ts'

export type WorkflowParamValue = boolean | number | string

export type WorkflowPickerFsApi = {
  selectImage: () => Promise<string | null>
  selectMeshFile: () => Promise<string | null>
  selectDirectory: () => Promise<string | null>
  savePath: (args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }) => Promise<string | null>
}

export function resolveBooleanParamValue(param: BooleanParamSchema, value: WorkflowParamValue): boolean {
  return typeof value === 'boolean' ? value : param.default
}

export function toggleBooleanParamValue(param: BooleanParamSchema, value: WorkflowParamValue): boolean {
  return !resolveBooleanParamValue(param, value)
}

export function isPickerEnabled(param: ParamSchema): param is StringParamSchema & { pickerIntent: WorkflowPickerIntent } {
  return param.type === 'string' && typeof param.pickerIntent === 'string'
}

export async function selectWorkflowParamPath(
  fs: WorkflowPickerFsApi,
  param: StringParamSchema,
  currentValue: string,
): Promise<string | null> {
  if (param.pickerIntent === 'image') return fs.selectImage()
  if (param.pickerIntent === 'mesh') return fs.selectMeshFile()
  if (param.pickerIntent === 'directory') return fs.selectDirectory()
  if (param.pickerIntent === 'save-path') {
    return fs.savePath({
      filters: param.filters ?? [],
      ...(currentValue ? { defaultPath: currentValue } : {}),
    })
  }
  return null
}
