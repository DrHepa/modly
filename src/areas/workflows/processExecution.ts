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
  outputType?: string
}

const ARTIFACT_KIND_SET = new Set<ArtifactKind>(['image', 'text', 'mesh', 'scene', 'capture', 'audio', 'video'])

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
  if (node.type === 'videoNode') return 'video'
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

function processVideoError(): Error {
  return new Error('Process extensions do not support video inputs or outputs')
}

function assertNoProcessVideoShape(extension: WorkflowExtension | undefined): void {
  if (!extension || extension.type === 'model') return
  if (
    extension.input === 'video'
    || extension.output === 'video'
    || (extension.inputs ?? []).some((port) => port.type === 'video')
  ) {
    throw processVideoError()
  }
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
  assertNoProcessVideoShape(extension)
  const incomingEdges = edges.filter((edge) => edge.target === node.id)
  const targetPorts = extension ? getProcessTargetPorts(extension) : []
  const hasNamedInputs = targetPorts.some((port) => !port.isLegacy)

  if (!hasNamedInputs) {
    let filePath: string | undefined
    let text: string | undefined

    for (const edge of incomingEdges) {
      const sourceNode = nodes.find((candidate) => candidate.id === edge.source)
      const sourceExtensionId = typeof sourceNode?.data.extensionId === 'string' ? sourceNode.data.extensionId : ''
      void sourceExtensionId
      const sourceOutput = resolveWorkflowEdgeOutput(edge, nodeOutputs)
      const sourceType = getNodeOutputType(sourceNode, allExtensions) ?? sourceOutput?.outputType
      if (sourceType === 'video') throw processVideoError()
      if (sourceOutput?.filePath !== undefined) filePath = sourceOutput.filePath
      if (sourceOutput?.text !== undefined) text = sourceOutput.text
    }

    if (filePath === undefined && text === undefined) {
      if (previousNodeOutput?.outputType === 'video') throw processVideoError()
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
    void sourceExtensionId
    const sourceOutput = resolveWorkflowEdgeOutput(edge, nodeOutputs)
    if (!sourceOutput || (sourceOutput.filePath === undefined && sourceOutput.text === undefined)) continue

    const type = getNodeOutputType(sourceNode, allExtensions)
      ?? asArtifactKind(sourceOutput.outputType)
      ?? asArtifactKind(targetPort.type)
    if (!type) continue
    if (type === 'video') throw processVideoError()

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
