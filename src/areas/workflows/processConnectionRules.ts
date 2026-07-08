import type { Connection } from '@xyflow/react'
import type { WFEdge, WFNode } from '../../shared/types/electron.d'
import type { ArtifactKind } from '../../shared/types/artifacts.ts'
import type { WorkflowExtension } from './mockExtensions'
import { getProcessTargetPort, getProcessTargetPorts } from './processPorts.ts'
import { previewNodeTargetArtifactKind } from './nodes/previewNodeShared.ts'

type ArtifactType = ArtifactKind

type ProcessRulePhase = 'connect' | 'run'
type ProcessRuleCode = 'type-mismatch' | 'duplicate-port' | 'missing-required-port'

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

function resolveNodeOutputType(node: WFNode | undefined, allExtensions: WorkflowExtension[]): ArtifactType | undefined {
  if (!node) return undefined
  if (node.type === 'imageNode') return 'image'
  if (node.type === 'textNode') return 'text'
  if (node.type === 'sceneNode') return 'scene'
  if (node.type === 'meshNode' || node.type === 'outputNode' || node.type === 'addToWorldsNode') return 'mesh'

  return getExtensionForNode(node, allExtensions)?.output
}

function getPortAwareTargetExtension(node: WFNode | undefined, allExtensions: WorkflowExtension[]): WorkflowExtension | undefined {
  const extension = getExtensionForNode(node, allExtensions)
  if (!extension || extension.type !== 'process') return undefined
  if (!Array.isArray(extension.inputs) || extension.inputs.length === 0) return undefined
  return extension
}

function createIssue(issue: Omit<ProcessConnectionRuleIssue, 'message'>): ProcessConnectionRuleIssue {
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

  return {
    ...issue,
    message: issue.phase === 'connect'
      ? `Port "${issue.portName}" already has a connection.`
      : `Port "${issue.portName}" has multiple incoming connections.`,
  }
}

export function validateProcessConnection({ connection, nodes, edges, allExtensions }: ConnectionValidationContext): ProcessConnectionRuleIssue | null {
  const targetNode = getNodeById(nodes, connection.target)
  if (!targetNode) return null

  const previewTargetKind = previewNodeTargetArtifactKind(targetNode.type)
  if (previewTargetKind) {
    const actualType = resolveNodeOutputType(getNodeById(nodes, connection.source), allExtensions)
    if (actualType && actualType !== previewTargetKind) {
      return createIssue({
        phase: 'connect',
        code: 'type-mismatch',
        targetNodeId: targetNode.id,
        targetHandle: connection.targetHandle ?? null,
        portName: previewTargetKind,
        expectedType: previewTargetKind,
        actualType,
        sourceNodeId: connection.source ?? undefined,
      })
    }
    return null
  }

  const targetExtension = getPortAwareTargetExtension(targetNode, allExtensions)
  if (!targetExtension) return null

  const targetPort = getProcessTargetPort(targetExtension, connection.targetHandle)
  if (!targetPort) return null

  const duplicateEdges = edges.filter((edge) => edge.target === targetNode.id && edge.targetHandle === targetPort.name)
  if (duplicateEdges.length > 0) {
    return createIssue({
      phase: 'connect',
      code: 'duplicate-port',
      targetNodeId: targetNode.id,
      targetHandle: targetPort.name,
      portName: targetPort.name,
      edgeIds: duplicateEdges.map((edge) => edge.id),
    })
  }

  const actualType = resolveNodeOutputType(getNodeById(nodes, connection.source), allExtensions)
  if (actualType && actualType !== targetPort.type) {
    return createIssue({
      phase: 'connect',
      code: 'type-mismatch',
      targetNodeId: targetNode.id,
      targetHandle: targetPort.name,
      portName: targetPort.name,
      expectedType: targetPort.type,
      actualType,
      sourceNodeId: connection.source ?? undefined,
    })
  }

  return null
}

export function validateWorkflowProcessRun({ nodes, edges, allExtensions }: ValidationContext): ProcessConnectionRuleIssue | null {
  for (const node of nodes) {
    const previewTargetKind = previewNodeTargetArtifactKind(node.type)
    if (previewTargetKind) {
      const previewEdge = edges.find((edge) => edge.target === node.id)
      const actualType = resolveNodeOutputType(getNodeById(nodes, previewEdge?.source), allExtensions)
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

    const extension = getPortAwareTargetExtension(node, allExtensions)
    if (!extension) continue

    const targetEdges = edges.filter((edge) => edge.target === node.id)

    for (const port of getProcessTargetPorts(extension)) {
      const portEdges = targetEdges.filter((edge) => edge.targetHandle === port.name)
      if (portEdges.length > 1) {
        return createIssue({
          phase: 'run',
          code: 'duplicate-port',
          targetNodeId: node.id,
          targetHandle: port.name,
          portName: port.name,
          edgeIds: portEdges.map((edge) => edge.id),
        })
      }

      if (port.required && portEdges.length === 0) {
        return createIssue({
          phase: 'run',
          code: 'missing-required-port',
          targetNodeId: node.id,
          targetHandle: port.name,
          portName: port.name,
          expectedType: port.type,
        })
      }

      if (portEdges.length === 1) {
        const sourceNode = getNodeById(nodes, portEdges[0].source)
        const actualType = resolveNodeOutputType(sourceNode, allExtensions)
        if (actualType && actualType !== port.type) {
          return createIssue({
            phase: 'run',
            code: 'type-mismatch',
            targetNodeId: node.id,
            targetHandle: port.name,
            portName: port.name,
            expectedType: port.type,
            actualType,
            sourceNodeId: sourceNode?.id,
          })
        }
      }
    }
  }

  return null
}
