import type { ProcessPort } from '../../shared/types/electron.d'

type ProcessPortOwner = {
  input?: string
  inputs?: string[] | ProcessPort[]
}

type ExtensionOutputOwner = {
  output?: string
}

export type ResolvedProcessTargetPort = {
  name: string | null
  label?: string
  type: string
  required: boolean
  isLegacy: boolean
  multiple?: true
  minItems?: number
  maxItems?: number
  ordered?: true
}

export type ResolvedExtensionSourcePort = {
  name: string | null
  label?: string
  type: string
  isLegacy: boolean
  primary: boolean
}

export const PROCESS_PORT_HANDLE_COLOR: Record<string, string> = {
  audio: '#34d399',
  image: '#38bdf8',
  mesh: '#a78bfa',
  scene: '#f472b6',
  text: '#fbbf24',
  video: '#fb7185',
}

export function hasNamedProcessInputs(inputs: ProcessPortOwner['inputs']): inputs is ProcessPort[] {
  return Array.isArray(inputs) && inputs.length > 0 && inputs.every((port) => typeof port === 'object' && port !== null)
}

/** Preserve the positional dialect rather than converting strings into named ports. */
export function getPositionalInputTypes(owner: ProcessPortOwner): string[] | undefined {
  return owner.inputs && !hasNamedProcessInputs(owner.inputs) ? owner.inputs as string[] : undefined
}

export function getProcessTargetPorts(owner: ProcessPortOwner): ResolvedProcessTargetPort[] {
  if (hasNamedProcessInputs(owner.inputs)) {
    return owner.inputs.map((port) => ({
      name: port.name,
      ...(typeof port.label === 'string' && port.label.trim() ? { label: port.label.trim() } : {}),
      type: port.type,
      required: port.required ?? true,
      isLegacy: false,
      ...(port.multiple === true ? {
        multiple: true as const,
        minItems: port.min_items ?? 1,
        maxItems: port.max_items ?? 10,
        ordered: true as const,
      } : {}),
    }))
  }
  if (owner.input === 'none') return []
  if (owner.inputs?.length) {
    return (owner.inputs as string[]).map((type, i) => ({
      name: `input-${i}`, type, required: true, isLegacy: true,
    }))
  }
  if (!owner.input) return []
  return [{ name: null, type: owner.input, required: true, isLegacy: true }]
}

export function getProcessTargetPort(owner: ProcessPortOwner, targetHandle?: string | null): ResolvedProcessTargetPort | undefined {
  const ports = getProcessTargetPorts(owner)
  if (ports.length === 0) return undefined
  if (hasNamedProcessInputs(owner.inputs)) return ports.find((port) => port.name === targetHandle)
  if (!owner.inputs?.length) return ports[0]
  // Old saved graphs omit the first slot handle. A secondary gap must not shift.
  return ports.find((port) => port.name === (targetHandle || 'input-0'))
}

export function getExtensionSourcePorts(owner: ExtensionOutputOwner): ResolvedExtensionSourcePort[] {
  if (!owner.output) return []
  return [{ name: null, type: owner.output, isLegacy: true, primary: true }]
}

export function getExtensionSourcePort(owner: ExtensionOutputOwner, sourceHandle?: string | null): ResolvedExtensionSourcePort | undefined {
  const ports = getExtensionSourcePorts(owner)
  if (ports.length === 0) return undefined
  if (!sourceHandle) return ports.find((port) => port.primary)
  const namedPort = ports.find((port) => port.name === sourceHandle)
  if (namedPort) return namedPort
  // Current saved graphs used "output" before named output handles existed.
  // An explicitly declared output of that name always takes precedence.
  return sourceHandle === 'output' ? ports.find((port) => port.primary) : undefined
}

export function resolveProcessTargetColor(owner: ProcessPortOwner, targetHandle?: string | null): string {
  const port = getProcessTargetPort(owner, targetHandle)
  return port ? (PROCESS_PORT_HANDLE_COLOR[port.type] ?? '#52525b') : '#52525b'
}
