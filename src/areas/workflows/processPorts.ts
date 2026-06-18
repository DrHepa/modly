import type { ProcessPort } from '../../shared/types/electron.d'
import type { ArtifactKind } from '../../shared/types/artifacts.ts'

type ArtifactType = ArtifactKind

type ProcessPortOwner = {
  input?: ArtifactType
  inputs?: ProcessPort[]
}

export type ResolvedProcessTargetPort = {
  name: string | null
  label?: string
  type: ArtifactType
  required: boolean
  isLegacy: boolean
}

export const PROCESS_PORT_HANDLE_COLOR: Record<ArtifactType, string> = {
  image: '#38bdf8',
  mesh: '#a78bfa',
  scene: '#34d399',
  text: '#fbbf24',
}

export function getProcessTargetPorts(owner: ProcessPortOwner): ResolvedProcessTargetPort[] {
  if (Array.isArray(owner.inputs) && owner.inputs.length > 0) {
    return owner.inputs.map((port) => ({
      name: port.name,
      ...(port.label ? { label: port.label } : {}),
      type: port.type,
      required: port.required ?? true,
      isLegacy: false,
    }))
  }

  if (!owner.input) return []

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

export function resolveProcessTargetColor(owner: ProcessPortOwner, targetHandle?: string | null): string {
  const port = getProcessTargetPort(owner, targetHandle)
  return port ? PROCESS_PORT_HANDLE_COLOR[port.type] : '#52525b'
}
