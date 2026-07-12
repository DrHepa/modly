import type { ProcessPort } from '../../shared/types/electron.d'

type ProcessPortOwner = {
  input?: string
  inputs?: string[] | ProcessPort[]
}

export type ResolvedProcessTargetPort = {
  name: string | null
  label?: string
  type: string
  required: boolean
  isLegacy: boolean
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
  if (owner.input === 'none') return []
  if (hasNamedProcessInputs(owner.inputs)) {
    return owner.inputs.map((port) => ({
      name: port.name,
      ...(typeof port.label === 'string' && port.label.trim() ? { label: port.label.trim() } : {}),
      type: port.type,
      required: port.required ?? true,
      isLegacy: false,
    }))
  }
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

export function resolveProcessTargetColor(owner: ProcessPortOwner, targetHandle?: string | null): string {
  const port = getProcessTargetPort(owner, targetHandle)
  return (port && PROCESS_PORT_HANDLE_COLOR[port.type]) || '#52525b'
}
