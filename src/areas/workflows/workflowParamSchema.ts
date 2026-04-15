import type {
  ParamSchema,
  RawParamSchema,
  UnsupportedParamSchema,
  WorkflowParamFilter,
  WorkflowParamOption,
  WorkflowPickerIntent,
} from '../../shared/types/electron.d.ts'

export type SupportedWorkflowParam = Exclude<ParamSchema, UnsupportedParamSchema>

const PICKER_INTENTS = new Set<WorkflowPickerIntent>(['image', 'mesh', 'directory', 'save-path', 'generic-file'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readPickerIntent(value: unknown): WorkflowPickerIntent | undefined {
  return typeof value === 'string' && PICKER_INTENTS.has(value as WorkflowPickerIntent)
    ? value as WorkflowPickerIntent
    : undefined
}

function normalizeOptions(value: unknown): WorkflowParamOption[] | undefined {
  if (!Array.isArray(value)) return undefined

  const options = value.flatMap((option) => {
    if (!isRecord(option)) return []

    const optionValue = option.value
    const label = readString(option.label)
    if ((typeof optionValue !== 'string' && typeof optionValue !== 'number') || !label) return []

    return [{ value: optionValue, label }]
  })

  return options.length > 0 ? options : undefined
}

function normalizeFilters(value: unknown): WorkflowParamFilter[] | undefined {
  if (!Array.isArray(value)) return undefined

  const filters = value.flatMap((filter) => {
    if (!isRecord(filter)) return []

    const name = readString(filter.name)
    const extensions = Array.isArray(filter.extensions)
      ? filter.extensions.filter((extension): extension is string => typeof extension === 'string')
      : []

    if (!name || extensions.length === 0) return []
    return [{ name, extensions }]
  })

  return filters.length > 0 ? filters : undefined
}

function unsupportedParam(raw: Record<string, unknown>, index: number, reason: string): ParamSchema {
  const id = readString(raw.id) ?? `unsupported_${index}`
  const label = readString(raw.label) ?? id
  const rawType = readString(raw.type)

  return {
    id,
    label,
    type: 'unsupported',
    default: '',
    reason,
    ...(rawType ? { rawType } : {}),
  }
}

export function normalizeWorkflowParam(raw: RawParamSchema | unknown, index = 0): ParamSchema {
  if (!isRecord(raw)) {
    return {
      id: `unsupported_${index}`,
      label: `unsupported_${index}`,
      type: 'unsupported',
      default: '',
      reason: 'Param descriptor must be an object',
    }
  }

  const type = readString(raw.type)
  const id = readString(raw.id)
  const label = readString(raw.label)
  const tooltip = readString(raw.tooltip)

  if (!id || !label || !type) {
    return unsupportedParam(raw, index, 'Param descriptor is missing id, label, or type')
  }

  if (type === 'select') {
    const defaultValue = raw.default
    if (typeof defaultValue !== 'string' && typeof defaultValue !== 'number') {
      return unsupportedParam(raw, index, 'Select params require a string or number default')
    }

    const options = normalizeOptions(raw.options)

    return {
      id,
      label,
      type,
      default: defaultValue,
      ...(tooltip ? { tooltip } : {}),
      ...(options ? { options } : {}),
    }
  }

  if (type === 'string') {
    if (typeof raw.default !== 'string') {
      return unsupportedParam(raw, index, 'String params require a string default')
    }

    const pickerIntent = readPickerIntent(raw.pickerIntent)
    const filters = pickerIntent ? normalizeFilters(raw.filters) : undefined

    return {
      id,
      label,
      type,
      default: raw.default,
      ...(tooltip ? { tooltip } : {}),
      ...(pickerIntent ? { pickerIntent } : {}),
      ...(filters ? { filters } : {}),
    }
  }

  if (type === 'int' || type === 'float') {
    const defaultValue = readNumber(raw.default)
    if (defaultValue === undefined) {
      return unsupportedParam(raw, index, `${type} params require a numeric default`)
    }

    const min = readNumber(raw.min)
    const max = readNumber(raw.max)
    const step = readNumber(raw.step)

    return {
      id,
      label,
      type,
      default: defaultValue,
      ...(tooltip ? { tooltip } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(step !== undefined ? { step } : {}),
    }
  }

  if (type === 'boolean') {
    if (typeof raw.default !== 'boolean') {
      return unsupportedParam(raw, index, 'Boolean params require a boolean default')
    }

    return {
      id,
      label,
      type,
      default: raw.default,
      ...(tooltip ? { tooltip } : {}),
    }
  }

  return unsupportedParam(raw, index, `Unsupported param descriptor type: ${type}`)
}

export function normalizeWorkflowParams(raw: unknown): ParamSchema[] {
  if (!Array.isArray(raw)) return []
  return raw.map((param, index) => normalizeWorkflowParam(param, index))
}

export function isSupportedWorkflowParam(param: ParamSchema): param is SupportedWorkflowParam {
  return param.type !== 'unsupported'
}
