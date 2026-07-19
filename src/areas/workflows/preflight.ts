import { getPositionalInputTypes, hasNamedProcessInputs } from './processPorts'
import { hydrateWorkflowNodeParams, resolveWorkflowPrompt } from './workflowNodeParams'
import { validateWorkflowProcessRun } from './processConnectionRules'
import type { Workflow, WFNode } from '@shared/types/electron.d'
import { getWorkflowExtension, type WorkflowExtension } from './mockExtensions'
import { hasUnsupportedSceneShape } from './sceneShape'
import { isPassthrough, isBranchConsumer, resolveDataSource, nearestUpstreamWaits } from './nodeBehaviors'
import { previewNodeTargetArtifactKind } from './nodes/previewNodeShared.ts'

type DataType = string

function asDataType(value: string | undefined): DataType | undefined {
  // Extension ports are open strings; "none" declares an inputless source.
  return typeof value === 'string' && value.length > 0 && value !== 'none'
    ? value
    : undefined
}

export interface WorkflowPreflightIssue {
  key: string
  message: string
  nodeId?: string
}

function nodeLabel(node: WFNode, allExtensions: WorkflowExtension[]): string {
  if (node.type === 'imageNode') return 'Image'
  if (node.type === 'textNode') return 'Text'
  if (node.type === 'meshNode') return 'Load 3D Mesh'
  if (node.type === 'sceneNode') return 'Load Scene'
  if (node.type === 'outputNode') return 'Add to Scene'
  if (node.type === 'previewNode') return 'Preview Views'
  if (node.type === 'previewImageNode') return 'Preview Image'
  if (node.type === 'imagePreviewNode') return 'Preview Image'
  if (node.type === 'forEachNode') {
    const mode = (node.data.params?.mode as string) ?? 'image'
    return mode === 'text' ? 'For Each Text' : mode === 'mesh' ? 'For Each Mesh' : 'For Each Image'
  }
  if (node.type === 'extensionNode') {
    return getWorkflowExtension(node.data.extensionId ?? '', allExtensions)?.name ?? 'Extension'
  }
  return 'Node'
}

function formatType(type: DataType): string {
  return type
}

function formatRequiredTypes(types: DataType[]): string {
  if (types.length === 1) return formatType(types[0])
  if (types.length === 2) return `${formatType(types[0])} and ${formatType(types[1])}`
  return `${types.slice(0, -1).map(formatType).join(', ')}, and ${formatType(types[types.length - 1])}`
}

function getNodeOutputType(node: WFNode, allExtensions: WorkflowExtension[]): DataType | undefined {
  if (node.type === 'imageNode') return 'image'
  if (node.type === 'textNode') return 'text'
  if (node.type === 'meshNode' || node.type === 'outputNode' || node.type === 'addToWorldsNode') return 'mesh'
  if (node.type === 'sceneNode') return 'scene'
  if (node.type === 'imagePreviewNode') return 'image'
  if (node.type === 'forEachNode') {
    const mode = asDataType(typeof node.data.params?.mode === 'string' ? node.data.params.mode : undefined) ?? 'image'
    return mode === 'text' || mode === 'mesh' ? mode : 'image'
  }
  if (node.type === 'extensionNode') {
    return getWorkflowExtension(node.data.extensionId ?? '', allExtensions)?.output
  }
  return undefined
}

function pushIssue(issues: WorkflowPreflightIssue[], issue: WorkflowPreflightIssue): void {
  if (!issues.some((existing) => existing.key === issue.key)) issues.push(issue)
}

export function validateWorkflowPreflight(
  workflow: Workflow,
  allExtensions: WorkflowExtension[],
  options?: { currentMeshUrl?: string | null },
): WorkflowPreflightIssue[] {
  const issues: WorkflowPreflightIssue[] = []
  const nodeMap = new Map(workflow.nodes.map((node) => [node.id, node]))

  const outputTypes = new Map<string, DataType | undefined>()
  for (const node of workflow.nodes) {
    outputTypes.set(node.id, getNodeOutputType(node, allExtensions))
  }
  // Passthrough nodes inherit their resolved upstream source's type.
  for (const node of workflow.nodes) {
    if (!isPassthrough(node.type)) continue
    const realSourceId = resolveDataSource(node.id, workflow.edges, nodeMap)
    if (realSourceId && realSourceId !== node.id) outputTypes.set(node.id, outputTypes.get(realSourceId))
  }

  for (const node of workflow.nodes) {
    const previewType = previewNodeTargetArtifactKind(node.type)
    if (previewType) {
      for (const edge of workflow.edges) {
        if (edge.source === node.id) {
          pushIssue(issues, {
            key: `${node.id}:no-output:${edge.id}`, nodeId: node.id,
            message: `${nodeLabel(node, allExtensions)} has no output handle. Use the passthrough Preview Image node to forward an image.`,
          })
        }
        const sourceType = outputTypes.get(edge.source)
        if (edge.target === node.id && sourceType && sourceType !== previewType) {
          pushIssue(issues, {
            key: `${node.id}:type:${edge.id}`, nodeId: node.id,
            message: `${nodeLabel(node, allExtensions)} expects ${previewType === 'image' ? 'an' : 'a'} ${formatType(previewType)}, but received ${formatType(sourceType)}.`,
          })
        }
      }
    }
    if (node.type === 'meshNode' && node.data.params?.source === 'current' && !options?.currentMeshUrl) {
      pushIssue(issues, {
        key: `${node.id}:current-mesh`,
        nodeId: node.id,
        message: `${nodeLabel(node, allExtensions)} is set to Current Scene, but no mesh is loaded.`,
      })
    }

    if (node.type === 'forEachNode' && !((node.data.params?.dir as string | undefined)?.trim())) {
      pushIssue(issues, {
        key: `${node.id}:foreach-no-folder`,
        nodeId: node.id,
        message: `${nodeLabel(node, allExtensions)} needs a folder selected.`,
      })
    }

    if (node.type === 'sceneNode' && !((node.data.params?.manifestPath as string | undefined)?.trim())) {
      pushIssue(issues, {
        key: `${node.id}:scene-invalid`, nodeId: node.id,
        message: 'Load Scene needs a validated scene directory.',
      })
    }

    // A node fed by two different Wait branches can't be scheduled into a single
    // branch — it would run before either branch produces its mesh.
    if (
      isBranchConsumer(node.type) &&
      nearestUpstreamWaits(node.id, workflow.edges, nodeMap).size > 1
    ) {
      pushIssue(issues, {
        key: `${node.id}:wait-merge`,
        nodeId: node.id,
        message: `${nodeLabel(node, allExtensions)} merges two Wait branches, which isn't supported. Route it through a single Wait.`,
      })
    }

    if (node.type !== 'extensionNode') continue

    const ext = getWorkflowExtension(node.data.extensionId ?? '', allExtensions)
    if (!ext) {
      pushIssue(issues, {
        key: `${node.id}:missing-extension`,
        nodeId: node.id,
        message: `${nodeLabel(node, allExtensions)} is unavailable. Reload extensions or remove the node.`,
      })
      continue
    }

    if (hasUnsupportedSceneShape(ext)) {
      pushIssue(issues, {
        key: `${node.id}:unsupported-scene-shape`,
        nodeId: node.id,
        message: `${ext.name} uses an unsupported scene input or output declaration.`,
      })
      continue
    }

    if (ext.type === 'process' && (hasNamedProcessInputs(ext.inputs) || ext.input === 'scene' || getPositionalInputTypes(ext)?.includes('scene'))) {
      const issue = validateWorkflowProcessRun({ nodes: workflow.nodes, edges: workflow.edges, allExtensions, targetNodeId: node.id })
      if (issue) pushIssue(issues, { key: `${node.id}:${issue.code}:${issue.portName}`, nodeId: node.id, message: issue.message })
      continue
    }

    const incomingEdges = workflow.edges.filter((edge) => edge.target === node.id)
    const requiredTypes = [...new Set((ext.inputs ?? [ext.input])
      .map((input) => asDataType(typeof input === 'string' ? input : input?.type))
      .filter((input): input is DataType => input !== undefined))]
    // A main text prompt can replace one text input, not multiple required ports
    // or a text auxiliary on an image/mesh model. Keep all other wiring checks.
    const positional = getPositionalInputTypes(ext)
    const singleTextModel = ext.type === 'model' && !hasNamedProcessInputs(ext.inputs)
      && (positional?.length ? positional.length === 1 && positional[0] === 'text' : ext.input === 'text')
    const hasPrompt = singleTextModel && resolveWorkflowPrompt(hydrateWorkflowNodeParams(ext, node.data.params)).trim().length > 0

    for (const requiredType of requiredTypes) {
      if (requiredType === 'text' && hasPrompt) continue
      const hasMatchingInput = incomingEdges.some((edge) => outputTypes.get(edge.source) === requiredType)
      if (!hasMatchingInput) {
        pushIssue(issues, {
          key: `${node.id}:missing:${requiredType}`,
          nodeId: node.id,
          message: `${ext.name} needs an incoming ${formatType(requiredType)} connection.`,
        })
      }
    }

    for (const edge of incomingEdges) {
      const sourceNode = nodeMap.get(edge.source)
      const sourceType = outputTypes.get(edge.source)
      if (!sourceNode || !sourceType || requiredTypes.length === 0 || requiredTypes.includes(sourceType)) continue
      pushIssue(issues, {
        key: `${node.id}:type:${edge.id}`,
        nodeId: node.id,
        message: `${ext.name} expects ${formatRequiredTypes(requiredTypes)}, but ${nodeLabel(sourceNode, allExtensions)} outputs ${formatType(sourceType)}.`,
      })
    }
  }

  return issues
}
