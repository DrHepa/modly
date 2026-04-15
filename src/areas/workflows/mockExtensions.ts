import type { ModelExtension, ProcessExtension } from '@shared/stores/extensionsStore'
export type { ParamSchema } from '@shared/types/electron.d'
import type { ParamSchema, ProcessPort } from '@shared/types/electron.d'

export interface WorkflowExtension {
  id:              string   // "ext_id/node_id"
  extensionId:     string   // "ext_id" (for IPC calls)
  extensionName:   string   // display name of the parent extension
  extensionAuthor: string   // author of the parent extension
  nodeId:          string   // "node_id"
  name:            string
  description:     string
  input:           'image' | 'text' | 'mesh'
  inputs?:         ('image' | 'text' | 'mesh')[]   // multi-input; overrides input when set
  output:          'image' | 'text' | 'mesh'
  inputs?:         ProcessPort[]
  params:          ParamSchema[]
  builtin:         boolean
  type:            'model' | 'process'
}

export function normalizeWorkflowProcessInputs(inputs?: ProcessPort[]): ProcessPort[] | undefined {
  if (!Array.isArray(inputs) || inputs.length === 0) return undefined

  return inputs.map((input) => ({
    name: input.name,
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
        inputs:          node.inputs,
        inputLabels:     node.inputLabels,
        output:          node.output,
        ...(normalizedInputs ? { inputs: normalizedInputs } : {}),
        params:          node.paramsSchema as ParamSchema[],
        builtin:         ext.builtin,
        type:            'process',
      })
    }
  }

  for (const ext of modelExtensions) {
    for (const node of ext.nodes) {
      result.push({
        id:              `${ext.id}/${node.id}`,
        extensionId:     ext.id,
        extensionName:   ext.name,
        extensionAuthor: ext.author ?? '',
        nodeId:          node.id,
        name:            node.name,
        description:     ext.description ?? '',
        input:           node.input,
        inputs:          node.inputs,
        inputLabels:     node.inputLabels,
        output:          node.output,
        params:          applyParamDefaults(node.paramsSchema as ParamSchema[], node.paramDefaults),
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
