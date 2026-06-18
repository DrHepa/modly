import type { ModelExtension, ProcessExtension } from '@shared/stores/extensionsStore'
export type { ParamSchema } from '@shared/types/electron.d'
import type { ParamSchema, ProcessPort } from '@shared/types/electron.d'
import type { ArtifactKind } from '@shared/types/artifacts.ts'
import { normalizeWorkflowParams } from './workflowParamSchema.ts'

export interface WorkflowExtension {
  id:              string   // "ext_id/node_id"
  extensionId:     string   // "ext_id" (for IPC calls)
  extensionName:   string   // display name of the parent extension
  extensionAuthor: string   // author of the parent extension
  nodeId:          string   // "node_id"
  name:            string
  description:     string
  input:           ArtifactKind
  output:          ArtifactKind
  inputs?:         ProcessPort[]
  params:          ParamSchema[]
  builtin:         boolean
  type:            'model' | 'process'
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
  }

  return result
}

export function getWorkflowExtension(id: string, all: WorkflowExtension[]): WorkflowExtension | undefined {
  return all.find((e) => e.id === id)
}
