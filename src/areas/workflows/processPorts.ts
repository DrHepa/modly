import type {
  ExtensionOutputPort,
  ModelInputKind,
  ProcessPort,
} from '../../shared/types/electron.d'
import type { ArtifactKind } from '../../shared/types/artifacts.ts'

type ArtifactType = ProcessPort['type']

type ProcessPortOwner = {
  input?: ModelInputKind
  inputs?: ProcessPort[]
}

type ExtensionOutputOwner = {
  output?: ArtifactKind
  outputs?: ExtensionOutputPort[]
}

export type ResolvedProcessTargetPort = {
  name: string | null
  label?: string
  type: ArtifactType
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
  type: ArtifactType
  isLegacy: boolean
  primary: boolean
}

export const PROCESS_PORT_HANDLE_COLOR: Record<string, string> = {
  image: '#38bdf8',
  mesh: '#a78bfa',
  scene: '#34d399',
  text: '#fbbf24',
  audio: '#f472b6',
  video: '#fb7185',
}

export function getProcessTargetPorts(owner: ProcessPortOwner): ResolvedProcessTargetPort[] {
  if (Array.isArray(owner.inputs) && owner.inputs.length > 0) {
    return owner.inputs.map((port) => ({
      name: port.name,
      ...(port.label ? { label: port.label } : {}),
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

  if (!owner.input || owner.input === 'none') return []

  return [{
    name: null,
    type: owner.input,
    required: true,
    isLegacy: true,
  }]
}

export function getProcessTargetPort(owner: ProcessPortOwner, targetHandle?: string | null): ResolvedProcessTargetPort | undefined {
  const ports = getProcessTargetPorts(owner)
  if (ports.length === 0) return undefined

  const hasNamedPorts = ports.some((port) => !port.isLegacy)
  if (!hasNamedPorts) return ports[0]
  if (!targetHandle) return undefined

  return ports.find((port) => port.name === targetHandle)
}

export function getExtensionSourcePorts(owner: ExtensionOutputOwner): ResolvedExtensionSourcePort[] {
  if (Array.isArray(owner.outputs) && owner.outputs.length > 0) {
    return owner.outputs.map((port, index) => ({
      name: port.name,
      ...(port.label ? { label: port.label } : {}),
      type: port.type,
      isLegacy: false,
      primary: index === 0,
    }))
  }

  if (!owner.output) return []
  return [{ name: null, type: owner.output, isLegacy: true, primary: true }]
}

export function getExtensionSourcePort(owner: ExtensionOutputOwner, sourceHandle?: string | null): ResolvedExtensionSourcePort | undefined {
  const ports = getExtensionSourcePorts(owner)
  if (ports.length === 0) return undefined
  if (!sourceHandle) return ports.find((port) => port.primary)
  return ports.find((port) => port.name === sourceHandle)
}

export function resolveProcessTargetColor(owner: ProcessPortOwner, targetHandle?: string | null): string {
  const port = getProcessTargetPort(owner, targetHandle)
  return port ? (PROCESS_PORT_HANDLE_COLOR[port.type] ?? '#52525b') : '#52525b'
}
