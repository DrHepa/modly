import type {
  BooleanParamSchema,
  ParamSchema,
  StringParamSchema,
  WorkflowPickerIntent,
} from '../../../shared/types/electron.d.ts'

export type WorkflowParamValue = boolean | number | string

export type StringParamEditorMode = 'compact' | 'multiline'

export type StringParamEditorState = {
  mode: StringParamEditorMode
  value: string
}

export type ControlDragEvent = {
  stopPropagation: () => void
  preventDefault?: () => void
}

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

export function isPromptLikeStringParam(param: ParamSchema): param is StringParamSchema {
  return param.type === 'string' && (param.id === 'prompt' || /prompt/i.test(param.label))
}

export function resolveStringParamEditorState(
  param: StringParamSchema,
  value: WorkflowParamValue,
  expanded: boolean,
): StringParamEditorState {
  return {
    mode: isPromptLikeStringParam(param) || expanded ? 'multiline' : 'compact',
    value: typeof value === 'string' ? value : String(value ?? ''),
  }
}

export function stopControlDragPropagation(event: ControlDragEvent): void {
  event.stopPropagation()
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
