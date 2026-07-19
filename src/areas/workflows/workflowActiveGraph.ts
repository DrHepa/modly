import type { WFEdge, WFNode } from '../../shared/types/electron.d'

export type ActiveWorkflowGraph = {
  nodes: WFNode[]
  edges: WFEdge[]
}

export function isDisabledExecutableWorkflowNode(node: WFNode): boolean {
  return (node.type === 'extensionNode' || node.type === 'waitNode' || node.type === 'landmarksNode')
    && node.data.enabled === false
}

export function deriveActiveWorkflowGraph(nodes: WFNode[], edges: WFEdge[]): ActiveWorkflowGraph {
  const disabledNodeIds = new Set(
    nodes.filter(isDisabledExecutableWorkflowNode).map((node) => node.id),
  )

  if (disabledNodeIds.size === 0) return { nodes, edges }

  return {
    nodes: nodes.filter((node) => !disabledNodeIds.has(node.id)),
    edges: edges.filter((edge) => !disabledNodeIds.has(edge.source) && !disabledNodeIds.has(edge.target)),
  }
}

export function topoSortWorkflowNodes(nodes: WFNode[], edges: WFEdge[]): WFNode[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const inDegree = new Map(nodes.map((node) => [node.id, 0]))
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]))

  for (const edge of edges) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue
    adjacency.get(edge.source)!.push(edge.target)
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
  }

  const queue = nodes.filter((node) => (inDegree.get(node.id) ?? 0) === 0)
  const ordered: WFNode[] = []

  while (queue.length > 0) {
    const node = queue.shift()!
    ordered.push(node)
    for (const neighbor of adjacency.get(node.id) ?? []) {
      const nextDegree = (inDegree.get(neighbor) ?? 0) - 1
      inDegree.set(neighbor, nextDegree)
      if (nextDegree === 0) queue.push(nodeMap.get(neighbor)!)
    }
  }

  return ordered
}
