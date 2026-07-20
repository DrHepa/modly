import type {
  NamedProcessInput,
  ProcessInput,
  WFEdge,
  WFNode,
} from '../../shared/types/electron.d'
import { getWorkflowExtension, type WorkflowExtension } from './mockExtensions.ts'
import { getProcessTargetPort, getProcessTargetPorts } from './processPorts.ts'
import type { ArtifactKind } from '../../shared/types/artifacts.ts'

type NodeOutput = {
  filePath?: string
  text?: string
}

const ARTIFACT_KIND_SET = new Set<ArtifactKind>(['image', 'text', 'mesh', 'scene', 'audio', 'video'])

function asArtifactKind(value: string | undefined): ArtifactKind | undefined {
  return typeof value === 'string' && ARTIFACT_KIND_SET.has(value as ArtifactKind)
    ? value as ArtifactKind
    : undefined
}

type BuildProcessExecutionInputArgs = {
  node: WFNode
  nodes: WFNode[]
  edges: WFEdge[]
  allExtensions: WorkflowExtension[]
  nodeOutputs: Map<string, NodeOutput>
  previousNodeOutput?: NodeOutput
}

function getNodeOutputType(
  node: WFNode | undefined,
  allExtensions: WorkflowExtension[],
): NamedProcessInput['type'] | undefined {
  if (!node) return undefined
  if (node.type === 'imageNode') return 'image'
  if (node.type === 'textNode') return 'text'
  if (node.type === 'sceneNode') return 'scene'
  if (node.type === 'meshNode' || node.type === 'outputNode' || node.type === 'addToWorldsNode') return 'mesh'

  if (node.type !== 'extensionNode') return undefined

  const extensionId = typeof node.data.extensionId === 'string' ? node.data.extensionId : ''
  const extension = getWorkflowExtension(extensionId, allExtensions)
  if (!extension) return undefined
  if (extension.type !== 'model') return extension.output
  return extension.output
}

export function resolveWorkflowEdgeOutput<T extends NodeOutput>(
  edge: Pick<WFEdge, 'source'>,
  nodeOutputs: Map<string, T>,
): T | undefined {
  return nodeOutputs.get(edge.source)
}

function getProcessNodeId(node: WFNode, extension: WorkflowExtension | undefined): string {
  if (extension?.nodeId) return extension.nodeId

  const extensionId = typeof node.data.extensionId === 'string' ? node.data.extensionId : ''
  return extensionId.split('/')[1] ?? ''
}

export function buildProcessExecutionInput({
  node,
  nodes,
  edges,
  allExtensions,
  nodeOutputs,
  previousNodeOutput,
}: BuildProcessExecutionInputArgs): ProcessInput {
  const extensionId = typeof node.data.extensionId === 'string' ? node.data.extensionId : ''
  const extension = getWorkflowExtension(extensionId, allExtensions)
  const nodeId = getProcessNodeId(node, extension)
  const incomingEdges = edges.filter((edge) => edge.target === node.id)
  const targetPorts = extension ? getProcessTargetPorts(extension) : []
  const hasNamedInputs = targetPorts.some((port) => !port.isLegacy)

  if (!hasNamedInputs) {
    let filePath: string | undefined
    let text: string | undefined

    for (const edge of incomingEdges) {
      const sourceNode = nodes.find((candidate) => candidate.id === edge.source)
      const sourceExtensionId = typeof sourceNode?.data.extensionId === 'string' ? sourceNode.data.extensionId : ''
      const sourceOutput = resolveWorkflowEdgeOutput(edge, nodeOutputs)
      if (sourceOutput?.filePath !== undefined) filePath = sourceOutput.filePath
      if (sourceOutput?.text !== undefined) text = sourceOutput.text
    }

    if (filePath === undefined && text === undefined) {
      filePath = previousNodeOutput?.filePath
      text = previousNodeOutput?.text
    }

    return { filePath, text, nodeId }
  }

  const inputs: Record<string, NamedProcessInput> = {}

  for (const edge of incomingEdges) {
    const targetHandle = edge.targetHandle ?? null
    const targetPort = extension ? getProcessTargetPort(extension, targetHandle) : null
    if (!targetPort || targetPort.isLegacy) continue

    const sourceNode = nodes.find((candidate) => candidate.id === edge.source)
    const sourceExtensionId = typeof sourceNode?.data.extensionId === 'string' ? sourceNode.data.extensionId : ''
    const sourceOutput = resolveWorkflowEdgeOutput(edge, nodeOutputs)
    if (!sourceOutput || (sourceOutput.filePath === undefined && sourceOutput.text === undefined)) continue

    const type = getNodeOutputType(sourceNode, allExtensions)
      ?? asArtifactKind(targetPort.type)
    if (!type) continue

    const portName = targetPort.name
    if (!portName) continue

    inputs[portName] = {
      type,
      sourceNodeId: edge.source,
      ...(sourceOutput.filePath !== undefined ? { filePath: sourceOutput.filePath } : {}),
      ...(sourceOutput.text !== undefined ? { text: sourceOutput.text } : {}),
    }
  }

  return {
    nodeId,
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
  }
}
