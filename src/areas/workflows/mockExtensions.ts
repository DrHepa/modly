import type { ModelExtension, ProcessExtension } from '@shared/stores/extensionsStore'
export type { ParamSchema } from '@shared/types/electron.d'
import type { ExtensionWorkflowNode, ModelInputKind, ParamSchema, ProcessPort } from '@shared/types/electron.d'
import type { ArtifactKind } from '@shared/types/artifacts.ts'
import { normalizeWorkflowParams } from './workflowParamSchema.ts'
import { PREVIEW_VIDEO_NODE_TYPE } from './nodes/previewNodeShared.ts'

interface WorkflowExtensionBase {
  id:              string   // "ext_id/node_id"
  extensionId:     string   // "ext_id" (for IPC calls)
  extensionName:   string   // display name of the parent extension
  extensionAuthor: string   // author of the parent extension
  nodeId:          string   // "node_id"
  name:            string
  description:     string
  output:          ArtifactKind
  inputs?:         ProcessPort[]
  params:          ParamSchema[]
  builtin:         boolean
  workflowNodeType?: string
  component?:       ExtensionWorkflowNode['component']
  capabilityId?:    string
  singleton?:       boolean
}

type ModelWorkflowExtension = WorkflowExtensionBase & {
  type: 'model'
  input: ModelInputKind
}

type ProcessWorkflowExtension = WorkflowExtensionBase & {
  type: 'process'
  input: ArtifactKind
}

type UtilityWorkflowExtension = WorkflowExtensionBase & {
  type: 'utility'
  input: ArtifactKind
}

export type WorkflowExtension =
  | ModelWorkflowExtension
  | ProcessWorkflowExtension
  | UtilityWorkflowExtension

const WORKFLOW_UTILITY_NODE_COMPONENT_TYPES: Record<ExtensionWorkflowNode['component'], string> = {
  'video-preview': PREVIEW_VIDEO_NODE_TYPE,
}

export function resolveWorkflowUtilityNodeType(extension: WorkflowExtension): string | undefined {
  return extension.type === 'utility' ? extension.workflowNodeType : undefined
}

function appendWorkflowUtilityNodes(
  result: WorkflowExtension[],
  extension: ModelExtension | ProcessExtension,
  seenSingletonCapabilities: Set<string>,
): void {
  for (const node of extension.workflowNodes ?? []) {
    const workflowNodeType = WORKFLOW_UTILITY_NODE_COMPONENT_TYPES[node.component]
    if (!workflowNodeType) continue

    if (node.singleton && seenSingletonCapabilities.has(node.capabilityId)) continue
    if (node.singleton) seenSingletonCapabilities.add(node.capabilityId)

    result.push({
      id:              `${extension.id}/${node.id}`,
      extensionId:     extension.id,
      extensionName:   extension.name,
      extensionAuthor: extension.author ?? '',
      nodeId:          node.id,
      name:            node.name,
      description:     node.description ?? extension.description ?? '',
      input:           node.input,
      output:          node.output,
      params:          [],
      builtin:         extension.builtin,
      type:            'utility',
      workflowNodeType,
      component:       node.component,
      capabilityId:    node.capabilityId,
      singleton:       node.singleton,
    })
  }
}

export function normalizeWorkflowProcessInputs(inputs?: ProcessPort[]): ProcessPort[] | undefined {
  if (!Array.isArray(inputs) || inputs.length === 0) return undefined

  return inputs.map((input) => ({
    name: input.name,
    ...(input.label ? { label: input.label } : {}),
    type: input.type,
    required: input.required ?? true,
  }))
}

export function buildAllWorkflowExtensions(
  modelExtensions:   ModelExtension[],
  processExtensions: ProcessExtension[],
): WorkflowExtension[] {
  const result: WorkflowExtension[] = []
  const seenSingletonCapabilities = new Set<string>()

  for (const ext of processExtensions) {
    for (const node of ext.nodes) {
      const normalizedInputs = normalizeWorkflowProcessInputs(node.inputs)

      result.push({
        id:              `${ext.id}/${node.id}`,
        extensionId:     ext.id,
        extensionName:   ext.name,
        extensionAuthor: ext.author ?? '',
        nodeId:          node.id,
        name:            node.name,
        description:     ext.description ?? '',
        input:           node.input,
        output:          node.output,
        ...(normalizedInputs ? { inputs: normalizedInputs } : {}),
        params:          normalizeWorkflowParams(node.paramsSchema),
        builtin:         ext.builtin,
        type:            'process',
      })
    }
    appendWorkflowUtilityNodes(result, ext, seenSingletonCapabilities)
  }

  for (const ext of modelExtensions) {
    for (const node of ext.nodes) {
      result.push({
        // Workflow/runtime identity stays on ext.id/node.id for ALL model nodes,
        // including bundled image models. Owner metadata is install-state only
        // and must never leak into saved workflow identifiers.
        id:              `${ext.id}/${node.id}`,
        extensionId:     ext.id,
        extensionName:   ext.name,
        extensionAuthor: ext.author ?? '',
        nodeId:          node.id,
        name:            node.name,
        description:     ext.description ?? '',
        input:           node.input,
        output:          node.output,
        ...(node.inputs ? { inputs: node.inputs } : {}),
        params:          normalizeWorkflowParams(node.paramsSchema),
        builtin:         ext.builtin,
        type:            'model',
      })
    }
    appendWorkflowUtilityNodes(result, ext, seenSingletonCapabilities)
  }

  return result
}

export function getWorkflowExtension(id: string, all: WorkflowExtension[]): WorkflowExtension | undefined {
  return all.find((e) => e.id === id)
}
