import type {
  NamedProcessInput,
  ProcessInput,
  WFEdge,
  WFNode,
} from '../../shared/types/electron.d'
import { getWorkflowExtension, type WorkflowExtension } from './mockExtensions.ts'
import { getProcessTargetPort, getPositionalInputTypes, hasNamedProcessInputs } from './processPorts.ts'
import { assignSlotFilePaths, type SlotInputType } from './slotInputs.ts'
import { resolveDataSource } from './nodeBehaviors.ts'

type NodeOutput = {
  filePath?: string
  text?: string
  outputType?: string
}

type BuildProcessExecutionInputArgs = {
  node: WFNode
  nodes: WFNode[]
  edges: WFEdge[]
  allExtensions: WorkflowExtension[]
  nodeOutputs: Map<string, NodeOutput>
  previousNodeOutput?: NodeOutput
}

function getNodeOutputType(node: WFNode | undefined, allExtensions: WorkflowExtension[]): NamedProcessInput['type'] | undefined {
  if (!node) return undefined
  if (node.type === 'imageNode') return 'image'
  if (node.type === 'textNode') return 'text'
  if (node.type === 'sceneNode') return 'scene'
  if (node.type === 'forEachNode') return String(node.data.params?.mode ?? 'image')
  if (node.type === 'meshNode' || node.type === 'outputNode') return 'mesh'

  if (node.type !== 'extensionNode') return undefined

  const extensionId = typeof node.data.extensionId === 'string' ? node.data.extensionId : ''
  return getWorkflowExtension(extensionId, allExtensions)?.output
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
  const hasNamedInputs = hasNamedProcessInputs(extension?.inputs)
  const nodeMap = new Map(nodes.map((source) => [source.id, source]))
  const resolveOutput = (sourceId: string) => {
    const realId = resolveDataSource(sourceId, edges, nodeMap)
    return realId ? nodeOutputs.get(realId) : undefined
  }

  if (!hasNamedInputs) {
    let filePath: string | undefined
    let text: string | undefined

    const inputTypes = extension && getPositionalInputTypes(extension)
    const texts: (string | undefined)[] = []
    if (inputTypes && inputTypes.length > 1) {
      const paths = new Array<string | undefined>(inputTypes.length).fill(undefined)
      for (const edge of incomingEdges) {
        const output = resolveOutput(edge.source)
        if (!output) continue
        const match = /^input-(\d+)$/.exec(edge.targetHandle ?? '')
        const slot = match ? Number(match[1]) : 0
        if (slot >= inputTypes.length) continue
        if (output.filePath !== undefined) paths[slot] = output.filePath
        if (output.text !== undefined && output.text.trim().length > 0) {
          text = output.text
          if (match) texts[slot] = output.text
        }
      }
      const slots = assignSlotFilePaths(inputTypes as SlotInputType[], paths)
      filePath = slots.nodeInputMeshPath ?? slots.nodeInputPath
    } else {
      for (const edge of incomingEdges) {
        const sourceOutput = resolveOutput(edge.source)
        if (sourceOutput?.filePath !== undefined) filePath = sourceOutput.filePath
        if (sourceOutput?.text !== undefined) text = sourceOutput.text
      }
    }

    if (filePath === undefined && text === undefined) {
      filePath = previousNodeOutput?.filePath
      text = previousNodeOutput?.text
    }

    return { filePath, text, nodeId, ...(texts.length ? { texts } : {}) }
  }

  const inputs: Record<string, NamedProcessInput> = {}

  for (const edge of incomingEdges) {
    const targetHandle = edge.targetHandle ?? null
    const targetPort = extension ? getProcessTargetPort(extension, targetHandle) : null
    if (!targetPort || targetPort.isLegacy) continue

    const sourceNodeId = resolveDataSource(edge.source, edges, nodeMap)
    const sourceOutput = sourceNodeId ? nodeOutputs.get(sourceNodeId) : undefined
    if (!sourceOutput || (sourceOutput.filePath === undefined && sourceOutput.text === undefined)) continue

    const sourceNode = nodes.find((candidate) => candidate.id === sourceNodeId)
    const type = sourceOutput.outputType ?? getNodeOutputType(sourceNode, allExtensions) ?? targetPort.type

    const portName = targetPort.name
    if (!portName) continue

    Object.defineProperty(inputs, portName, { enumerable: true, configurable: true, writable: true, value: {
      type,
      sourceNodeId: sourceNodeId!,
      ...(sourceOutput.filePath !== undefined ? { filePath: sourceOutput.filePath } : {}),
      ...(sourceOutput.text !== undefined ? { text: sourceOutput.text } : {}),
    } })
  }

  return {
    nodeId,
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
  }
}
