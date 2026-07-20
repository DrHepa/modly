import type { WFEdge, WFNode } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions.ts'
import { getProcessTargetPorts } from './processPorts.ts'

type NormalizeWorkflowEdgesArgs = {
  nodes: WFNode[]
  edges: WFEdge[]
  allExtensions: WorkflowExtension[]
}

type NormalizeHandleResult = {
  handle: string | null | undefined
  changed: boolean
}

export type NormalizeWorkflowEdgesResult = {
  edges: WFEdge[]
  changed: boolean
}

const LEGACY_TARGET_ALIAS = 'input-0'
const LEGACY_SOURCE_ALIAS = 'output'

function getExtensionForNode(node: WFNode | undefined, allExtensions: WorkflowExtension[]): WorkflowExtension | undefined {
  if (!node || node.type !== 'extensionNode') return undefined
  const extensionId = typeof node.data.extensionId === 'string' ? node.data.extensionId : ''
  return allExtensions.find((extension) => extension.id === extensionId)
}

function normalizeLegacyHandle(handle: string | null | undefined): NormalizeHandleResult {
  return handle === null ? { handle: null, changed: false } : { handle: null, changed: true }
}

function getDeclaredTargetPorts(extension: WorkflowExtension) {
  return getProcessTargetPorts(extension).filter((port): port is typeof port & { name: string } => !port.isLegacy && typeof port.name === 'string')
}

function normalizeTargetHandle(node: WFNode | undefined, allExtensions: WorkflowExtension[], handle: string | null | undefined): NormalizeHandleResult {
  const extension = getExtensionForNode(node, allExtensions)
  if (!extension) return { handle, changed: false }

  const namedPorts = getDeclaredTargetPorts(extension)
  if (namedPorts.length === 0) return normalizeLegacyHandle(handle)

  if (typeof handle === 'string' && namedPorts.some((port) => port.name === handle)) return { handle, changed: false }

  const primaryPort = namedPorts[0]?.name
  if (!primaryPort) return normalizeLegacyHandle(handle)

  if (handle == null || handle === LEGACY_TARGET_ALIAS) {
    return { handle: primaryPort, changed: primaryPort !== handle }
  }

  if (extension.type === 'model') return { handle: primaryPort, changed: primaryPort !== handle }

  return { handle, changed: false }
}

function normalizeSourceHandle(node: WFNode | undefined, allExtensions: WorkflowExtension[], handle: string | null | undefined): NormalizeHandleResult {
  const extension = getExtensionForNode(node, allExtensions)
  if (!extension) return { handle, changed: false }

  if (handle == null) return { handle, changed: false }

  if (handle === LEGACY_SOURCE_ALIAS || extension.type === 'model' || extension.type === 'process') {
    return { handle: null, changed: true }
  }

  return { handle, changed: false }
}

export function normalizeWorkflowEdges({ nodes, edges, allExtensions }: NormalizeWorkflowEdgesArgs): NormalizeWorkflowEdgesResult {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  let changed = false

  const normalizedEdges = edges.map((edge) => {
    const target = normalizeTargetHandle(nodeById.get(edge.target), allExtensions, edge.targetHandle)
    const source = normalizeSourceHandle(nodeById.get(edge.source), allExtensions, edge.sourceHandle)
    if (!target.changed && !source.changed) return edge
    changed = true
    return {
      ...edge,
      ...(target.handle === undefined ? {} : { targetHandle: target.handle }),
      ...(source.handle === undefined ? {} : { sourceHandle: source.handle }),
    }
  })

  return { edges: normalizedEdges, changed }
}
