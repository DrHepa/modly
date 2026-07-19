import type { Connection } from '@xyflow/react'
import type { WFEdge, WFNode } from '../../shared/types/electron.d'
import type { ArtifactKind } from '../../shared/types/artifacts.ts'
import type { WorkflowExtension } from './mockExtensions'
import { getExtensionSourcePort, getProcessTargetPort, getProcessTargetPorts } from './processPorts.ts'
import { previewNodeTargetArtifactKind } from './nodes/previewNodeShared.ts'
import { deriveActiveWorkflowGraph } from './workflowActiveGraph.ts'

type ArtifactType = ArtifactKind

const ARTIFACT_KIND_SET = new Set<ArtifactKind>(['image', 'text', 'mesh', 'scene', 'audio', 'video'])

function asArtifactKind(value: string | undefined): ArtifactKind | undefined {
  return typeof value === 'string' && ARTIFACT_KIND_SET.has(value as ArtifactKind)
    ? value as ArtifactKind
    : undefined
}

type ProcessRulePhase = 'connect' | 'run'
type ProcessRuleCode = 'type-mismatch' | 'duplicate-port' | 'missing-required-port' | 'inputless-target' | 'min-items' | 'max-items'

export type ProcessConnectionRuleIssue = {
  phase: ProcessRulePhase
  code: ProcessRuleCode
  message: string
  targetNodeId: string
  targetHandle: string | null
  portName: string | null
  expectedType?: ArtifactType
  actualType?: ArtifactType
  sourceNodeId?: string
  edgeIds?: string[]
  minItems?: number
  maxItems?: number
}

type ValidationContext = {
  nodes: WFNode[]
  edges: WFEdge[]
  allExtensions: WorkflowExtension[]
}

type ConnectionValidationContext = ValidationContext & {
  connection: Connection
}

function getNodeById(nodes: WFNode[], id?: string | null): WFNode | undefined {
  if (!id) return undefined
  return nodes.find((node) => node.id === id)
}

function getExtensionForNode(node: WFNode | undefined, allExtensions: WorkflowExtension[]): WorkflowExtension | undefined {
  if (!node || node.type !== 'extensionNode') return undefined
  const extensionId = typeof node.data.extensionId === 'string' ? node.data.extensionId : ''
  return allExtensions.find((extension) => extension.id === extensionId)
}

export function resolveEffectiveWorkflowIoContract(
  node: WFNode | undefined,
  extension: WorkflowExtension | undefined,
): WFNode['data']['ioContract'] {
  return node?.data.ioContract ?? extension?.ioContract
}

function resolveNodeOutputType(
  node: WFNode | undefined,
  allExtensions: WorkflowExtension[],
  sourceHandle?: string | null,
): ArtifactType | undefined {
  if (!node) return undefined
  if (node.type === 'imageNode') return 'image'
  if (node.type === 'textNode') return 'text'
  if (node.type === 'sceneNode') return 'scene'
  if (node.type === 'meshNode' || node.type === 'outputNode' || node.type === 'addToWorldsNode') return 'mesh'

  const extension = getExtensionForNode(node, allExtensions)
  if (!extension) return undefined
  if (extension.type !== 'model') return extension.output
  if (resolveEffectiveWorkflowIoContract(node, extension) !== 'named-v1') return extension.output
  return asArtifactKind(getExtensionSourcePort(extension, sourceHandle)?.type)
}

function getPortAwareTargetExtension(node: WFNode | undefined, allExtensions: WorkflowExtension[]): WorkflowExtension | undefined {
  const extension = getExtensionForNode(node, allExtensions)
  if (!extension) return undefined
  if (extension.type === 'model' && resolveEffectiveWorkflowIoContract(node, extension) !== 'named-v1') return undefined
  if (!Array.isArray(extension.inputs) || extension.inputs.length === 0) return undefined
  return extension
}

function createIssue(issue: Omit<ProcessConnectionRuleIssue, 'message'>): ProcessConnectionRuleIssue {
  if (issue.code === 'inputless-target') {
    return {
      ...issue,
      message: 'This node declares input "none" and cannot accept incoming edges. Remove the connection and run it as a source node.',
    }
  }

  if (issue.code === 'type-mismatch') {
    return {
      ...issue,
      message: `Port "${issue.portName}" expects ${issue.expectedType} but received ${issue.actualType}.`,
    }
  }

  if (issue.code === 'missing-required-port') {
    return {
      ...issue,
      message: `Required port "${issue.portName}" is missing.`,
    }
  }

  if (issue.code === 'min-items') {
    return {
      ...issue,
      message: `Port "${issue.portName}" requires at least ${issue.minItems} connections.`,
    }
  }

  if (issue.code === 'max-items') {
    return {
      ...issue,
      message: `Port "${issue.portName}" accepts at most ${issue.maxItems} connections.`,
    }
  }

  return {
    ...issue,
    message: issue.phase === 'connect'
      ? `Port "${issue.portName}" already has a connection.`
      : `Port "${issue.portName}" has multiple incoming connections.`,
  }
}

export function validateProcessConnection({ connection, nodes, edges, allExtensions }: ConnectionValidationContext): ProcessConnectionRuleIssue | null {
  void connection
  void nodes
  void edges
  void allExtensions
  return null
}

export function validateWorkflowProcessRun({ nodes, edges, allExtensions }: ValidationContext): ProcessConnectionRuleIssue | null {
  const activeGraph = deriveActiveWorkflowGraph(nodes, edges)

  for (const node of activeGraph.nodes) {
    const previewTargetKind = previewNodeTargetArtifactKind(node.type)
    if (previewTargetKind) {
      const previewEdge = activeGraph.edges.find((edge) => edge.target === node.id)
      const actualType = resolveNodeOutputType(getNodeById(activeGraph.nodes, previewEdge?.source), allExtensions, previewEdge?.sourceHandle)
      if (actualType && actualType !== previewTargetKind) {
        return createIssue({
          phase: 'run',
          code: 'type-mismatch',
          targetNodeId: node.id,
          targetHandle: previewEdge?.targetHandle ?? null,
          portName: previewTargetKind,
          expectedType: previewTargetKind,
          actualType,
          sourceNodeId: previewEdge?.source,
        })
      }
      continue
    }

    const targetExtension = getExtensionForNode(node, allExtensions)
    if (targetExtension?.input === 'none') {
      const illegalEdges = activeGraph.edges.filter((edge) => edge.target === node.id)
      if (illegalEdges.length > 0) {
        return createIssue({
          phase: 'run',
          code: 'inputless-target',
          targetNodeId: node.id,
          targetHandle: illegalEdges[0]?.targetHandle ?? null,
          portName: null,
          sourceNodeId: illegalEdges[0]?.source,
          edgeIds: illegalEdges.map((edge) => edge.id),
        })
      }
    }

    const extension = getPortAwareTargetExtension(node, allExtensions)
    if (!extension) continue

    const targetEdges = activeGraph.edges.filter((edge) => edge.target === node.id)

    for (const port of getProcessTargetPorts(extension)) {
      const portEdges = targetEdges.filter((edge) => edge.targetHandle === port.name)
      if (!port.multiple && portEdges.length > 1) {
        return createIssue({
          phase: 'run',
          code: 'duplicate-port',
          targetNodeId: node.id,
          targetHandle: port.name,
          portName: port.name,
          edgeIds: portEdges.map((edge) => edge.id),
        })
      }

      if (port.multiple && portEdges.length > (port.maxItems ?? 1)) {
        return createIssue({
          phase: 'run',
          code: 'max-items',
          targetNodeId: node.id,
          targetHandle: port.name,
          portName: port.name,
          maxItems: port.maxItems ?? 1,
          edgeIds: portEdges.map((edge) => edge.id),
        })
      }

      if (port.multiple && portEdges.length < (port.minItems ?? 1)) {
        const expectedType = asArtifactKind(port.type)
        return createIssue({
          phase: 'run',
          code: 'min-items',
          targetNodeId: node.id,
          targetHandle: port.name,
          portName: port.name,
          minItems: port.minItems ?? 1,
          ...(expectedType ? { expectedType } : {}),
          edgeIds: portEdges.map((edge) => edge.id),
        })
      }

      if (!port.multiple && port.required && portEdges.length === 0) {
        const expectedType = asArtifactKind(port.type)
        return createIssue({
          phase: 'run',
          code: 'missing-required-port',
          targetNodeId: node.id,
          targetHandle: port.name,
          portName: port.name,
          ...(expectedType ? { expectedType } : {}),
        })
      }

      for (const edge of portEdges) {
        const sourceNode = getNodeById(activeGraph.nodes, edge.source)
        const actualType = resolveNodeOutputType(sourceNode, allExtensions, edge.sourceHandle)
        if (actualType && actualType !== port.type) {
          const expectedType = asArtifactKind(port.type)
          return createIssue({
            phase: 'run',
            code: 'type-mismatch',
            targetNodeId: node.id,
            targetHandle: port.name,
            portName: port.name,
            ...(expectedType ? { expectedType } : {}),
            actualType,
            sourceNodeId: sourceNode?.id,
          })
        }
      }
    }
  }

  return null
}
