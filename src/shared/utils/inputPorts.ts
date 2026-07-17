import type { ExtensionInputPortDescriptor } from '@shared/types/electron.d'

export type InputPortType = 'image' | 'text' | 'mesh' | 'audio'

export interface RawInputPortHost {
  input?: string
  inputs?: unknown
  inputLabels?: unknown
  io_contract?: unknown
  input_ports?: unknown
}

export interface NormalizedInputPort {
  name: string
  type: InputPortType
  label: string
  required: boolean
  handle: string
  index: number
  primary: boolean
}

export interface NormalizedInputPorts {
  mode: 'legacy' | 'named-v1'
  ports: NormalizedInputPort[]
  primary?: NormalizedInputPort
  issues: string[]
}

const SUPPORTED_TYPES = new Set<InputPortType>(['image', 'text', 'mesh', 'audio'])
const NAMED_PORT_RE = /^[a-z][a-z0-9_]*$/
const NAMED_V1_ALLOWED_KEYS = new Set(['name', 'type', 'label', 'required'])

function safeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

function normalizeType(value: unknown, fallback: InputPortType = 'image'): InputPortType {
  return SUPPORTED_TYPES.has(value as InputPortType) ? value as InputPortType : fallback
}

export function normalizeExtensionInputPorts(raw: RawInputPortHost | undefined): NormalizedInputPorts {
  if (raw?.io_contract !== 'named-v1') {
    const rawInputs = Array.isArray(raw?.inputs) && raw.inputs.length > 0 ? raw.inputs : undefined
    const rawLabels = Array.isArray(raw?.inputLabels) ? raw.inputLabels : []
    const types = rawInputs ?? [raw?.input]
    const ports = types.map((type, index) => {
      const normalizedType = normalizeType(type)
      const name = `input-${index}`
      return {
        name,
        type: normalizedType,
        label: safeString(rawLabels[index], normalizedType),
        required: true,
        handle: name,
        index,
        primary: index === 0,
      }
    })
    return { mode: 'legacy', ports, primary: ports[0], issues: [] }
  }

  const issues: string[] = []
  const rawPorts = raw.input_ports
  if (!Array.isArray(rawPorts) || rawPorts.length === 0) {
    return {
      mode: 'named-v1',
      ports: [],
      issues: ['named-v1 nodes must declare a non-empty input_ports list.'],
    }
  }

  const seen = new Set<string>()
  const ports: NormalizedInputPort[] = []

  rawPorts.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      issues.push(`input_ports[${index}] must be an object.`)
      return
    }
    const port = candidate as Partial<ExtensionInputPortDescriptor>
    const extraKeys = Object.keys(port).filter((key) => !NAMED_V1_ALLOWED_KEYS.has(key))
    if (extraKeys.length > 0) {
      issues.push(`input_ports[${index}] contains unsupported field(s): ${extraKeys.sort().join(', ')}.`)
      return
    }
    if (typeof port.name !== 'string' || port.name.length === 0) {
      issues.push(`input_ports[${index}].name must be a non-empty string.`)
      return
    }
    if (!NAMED_PORT_RE.test(port.name)) {
      issues.push(`Input port "${port.name}" must be lowercase-safe: letters, numbers, underscore, starting with a letter.`)
    }
    if (seen.has(port.name)) {
      issues.push(`Duplicate input port name "${port.name}".`)
    }
    seen.add(port.name)

    if (!SUPPORTED_TYPES.has(port.type as InputPortType)) {
      issues.push(`Input port "${port.name}" has unsupported type "${String(port.type)}".`)
      return
    }
    if (port.type !== 'image') {
      issues.push(`Input port "${port.name}" has unsupported named-v1 type "${port.type}"; named-v1 currently supports image inputs only.`)
      return
    }
    if (!('required' in port) || typeof port.required !== 'boolean') {
      issues.push(`Input port "${port.name}" required must be present and boolean.`)
      return
    }
    if ('label' in port && typeof port.label !== 'string') {
      issues.push(`Input port "${port.name}" label must be a string.`)
      return
    }

    ports.push({
      name: port.name,
      type: port.type as InputPortType,
      label: safeString(port.label, port.name),
      required: port.required,
      handle: port.name,
      index,
      primary: false,
    })
  })

  const primaryIndex = ports.findIndex((port) => port.required)
  const selectedPrimary = primaryIndex >= 0 ? primaryIndex : 0
  const withPrimary = ports.map((port, index) => ({ ...port, primary: index === selectedPrimary }))

  return {
    mode: 'named-v1',
    ports: withPrimary,
    primary: withPrimary[selectedPrimary],
    issues,
  }
}

export function getInputPortByHandle(
  raw: RawInputPortHost | undefined,
  handle: string | null | undefined,
): NormalizedInputPort | undefined {
  const normalized = normalizeExtensionInputPorts(raw)
  if (normalized.mode === 'legacy') {
    const legacyHandle = handle ?? 'input-0'
    return normalized.ports.find((port) => port.handle === legacyHandle) ?? normalized.primary
  }
  return normalized.ports.find((port) => port.handle === handle)
}

export function getPrimaryInputHandle(raw: RawInputPortHost | undefined): string {
  return normalizeExtensionInputPorts(raw).primary?.handle ?? 'input-0'
}
