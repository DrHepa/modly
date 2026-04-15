import type { ModelExtension, ProcessExtension } from '@shared/stores/extensionsStore'
export type { ParamSchema } from '@shared/types/electron.d'
import { normalizeWorkflowParams } from './workflowParamSchema.ts'
import type { ParamSchema, RawParamSchema, WeightVariantsInfo, ProcessPort } from '@shared/types/electron.d'

export interface WorkflowExtension {
  id:              string   // "ext_id/node_id"
  extensionId:     string   // "ext_id" (for IPC calls)
  extensionName:   string   // display name of the parent extension
  extensionAuthor: string   // author of the parent extension
  nodeId:          string   // "node_id"
  name:            string
  description:     string
  input:           string
  inputs?:         string[] | ProcessPort[]   // positional slots or explicit named ports
  inputLabels?:    string[]                                  // display labels per input slot
  output:          string
  params:          ParamSchema[]
  builtin:         boolean
  type:            'model' | 'process'
  weightVariants?: WeightVariantsInfo
}

function applyParamDefaults(
  schema: RawParamSchema[],
  defaults: Record<string, boolean | number | string> | undefined,
): ParamSchema[] {
  // Apply root/node overrides before narrowing the display schema. Display
  // normalization must never be used to filter the supplied runtime params.
  if (!Array.isArray(schema)) return normalizeWorkflowParams(schema)
  return normalizeWorkflowParams(schema.map((param) =>
    param && typeof param === 'object' && typeof param.id === 'string' && defaults && Object.prototype.hasOwnProperty.call(defaults, param.id)
      ? { ...param, default: defaults[param.id] }
      : param,
  ))
}

export function normalizeWorkflowProcessInputs(inputs?: string[] | ProcessPort[]): string[] | ProcessPort[] | undefined {
  if (!Array.isArray(inputs) || inputs.length === 0) return inputs
  if (inputs.every((input): input is string => typeof input === 'string')) return [...inputs]
  return (inputs as ProcessPort[]).map((input) => ({ ...input, required: input.required ?? true }))
}

export function buildAllWorkflowExtensions(
  modelExtensions:   ModelExtension[],
  processExtensions: ProcessExtension[],
): WorkflowExtension[] {
  const result: WorkflowExtension[] = []

  for (const ext of processExtensions) {
    if (ext.corrupted) continue
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
        inputs:          normalizeWorkflowProcessInputs(node.inputs),
        inputLabels:     node.inputLabels,
        output:          node.output,
        params:          applyParamDefaults(node.paramsSchema, node.paramDefaults),
        builtin:         ext.builtin,
        type:            'process',
      })
    }
  }

  for (const ext of modelExtensions) {
    if (ext.corrupted) continue
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
        params:          applyParamDefaults(node.paramsSchema, node.paramDefaults),
        builtin:         ext.builtin,
        type:            'model',
        weightVariants:  node.weightVariants,
      })
    }
  }

  return result
}

export function getWorkflowExtension(id: string, all: WorkflowExtension[]): WorkflowExtension | undefined {
  return all.find((e) => e.id === id)
}
