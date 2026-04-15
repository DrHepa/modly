import type {
  ParamSchema,
  RawParamSchema,
  UnsupportedParamSchema,
  WorkflowParamFilter,
  WorkflowParamOption,
  WorkflowPickerIntent,
} from '../../shared/types/electron.d.ts'

export type SupportedWorkflowParam = Exclude<ParamSchema, UnsupportedParamSchema>

const PICKER_INTENTS = new Set<WorkflowPickerIntent>(['folder', 'image', 'mesh', 'text', 'directory', 'save-path', 'generic-file'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    if (typeof optionValue !== 'string' && typeof optionValue !== 'number') return []
    const label = readString(option.label) ?? String(optionValue)

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

function readVisibility(value: unknown): ParamSchema['show_if'] {
  if (!isRecord(value)) return undefined
  const isValue = (item: unknown): item is boolean | number | string =>
    typeof item === 'boolean' || typeof item === 'string' || readNumber(item) !== undefined
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean | number | string | (boolean | number | string)[]] =>
    isValue(entry[1]) || (Array.isArray(entry[1]) && entry[1].every(isValue)),
  ))
}

function unsupportedParam(raw: Record<string, unknown>, index: number, reason: string): ParamSchema {
  const id = readString(raw.id) ?? `unsupported_${index}`
  const label = readString(raw.label) ?? id
  const rawType = readString(raw.type)

  return {
    id,
    label,
    type: 'unsupported',
    // Display falls back to a reason label, not a replacement runtime value.
    default: raw.default,
    reason,
    ...(rawType ? { rawType } : {}),
    ...(readVisibility(raw.show_if) ? { show_if: readVisibility(raw.show_if) } : {}),
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
  const show_if = readVisibility(raw.show_if)

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
      ...(show_if ? { show_if } : {}),
      ...(options ? { options } : {}),
    }
  }

  if (type === 'string') {
    if (typeof raw.default !== 'string') {
      return unsupportedParam(raw, index, 'String params require a string default')
    }

    // camelCase keeps U's precedence even if a newer/unknown value is supplied.
    const picker_intent = readPickerIntent(raw.picker_intent)
    const pickerIntent = readPickerIntent(raw.pickerIntent)
      ?? (raw.pickerIntent != null && picker_intent ? 'folder' : undefined)
    const filters = (pickerIntent ?? picker_intent) ? normalizeFilters(raw.filters) : undefined

    return {
      id,
      label,
      type,
      default: raw.default,
      ...(tooltip ? { tooltip } : {}),
      ...(show_if ? { show_if } : {}),
      ...(pickerIntent ? { pickerIntent } : {}),
      ...(picker_intent ? { picker_intent } : {}),
      ...(filters ? { filters } : {}),
    }
  }

  if (type === 'file-select') {
    if (typeof raw.default !== 'string') {
      return unsupportedParam(raw, index, 'File-select params require a string default')
    }
    const dir_from = readString(raw.dir_from)
    const extensions = Array.isArray(raw.extensions)
      ? raw.extensions.filter((extension): extension is string => typeof extension === 'string')
      : undefined
    return {
      id, label, type, default: raw.default,
      ...(tooltip ? { tooltip } : {}),
      ...(show_if ? { show_if } : {}),
      ...(dir_from !== undefined ? { dir_from } : {}),
      ...(extensions ? { extensions } : {}),
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
      ...(show_if ? { show_if } : {}),
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
      ...(show_if ? { show_if } : {}),
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
