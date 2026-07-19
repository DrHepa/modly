import type { ModelExtension, ProcessExtension } from '@shared/stores/extensionsStore'
export type { ParamSchema } from '@shared/types/electron.d'
import { normalizeWorkflowParams } from './workflowParamSchema.ts'
import type { ExtensionOutputPort, ExtensionWorkflowNode, ModelInputKind, ParamSchema, RawParamSchema, WeightVariantsInfo, ProcessPort } from '@shared/types/electron.d'
import { PREVIEW_VIDEO_NODE_TYPE } from './nodes/previewNodeShared.ts'

interface WorkflowExtensionBase {
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
  outputs?:        ExtensionOutputPort[]
  ioContract?:      'named-v1'
  processOwnerId?: string
  params:          ParamSchema[]
  builtin:         boolean
  type:            'model' | 'process' | 'utility'
  weightVariants?: WeightVariantsInfo
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
  input: string
}

type UtilityWorkflowExtension = WorkflowExtensionBase & {
  type: 'utility'
  input: string
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
  return (inputs as ProcessPort[]).map((input) => ({
    ...input,
    required: input.required ?? true,
    ...(input.multiple === true ? {
      multiple: true as const,
      min_items: input.min_items ?? 1,
      max_items: input.max_items ?? 10,
      ordered: true as const,
    } : {}),
  }))
}

export function buildAllWorkflowExtensions(
  modelExtensions:   ModelExtension[],
  processExtensions: ProcessExtension[],
): WorkflowExtension[] {
  const result: WorkflowExtension[] = []
  const seenSingletonCapabilities = new Set<string>()

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
        ...(node.processOwnerId ? { processOwnerId: node.processOwnerId } : {}),
        params:          applyParamDefaults(node.paramsSchema, node.paramDefaults),
        builtin:         ext.builtin,
        type:            'process',
      })
    }
    appendWorkflowUtilityNodes(result, ext, seenSingletonCapabilities)
  }

  for (const ext of modelExtensions) {
    if (ext.corrupted) continue
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
        inputs:          normalizeWorkflowProcessInputs(node.inputs),
        inputLabels:     node.inputLabels,
        output:          node.output,
        ...(node.outputs ? { outputs: node.outputs } : {}),
        ...(node.ioContract ? { ioContract: node.ioContract } : {}),
        ...(node.processOwnerId ? { processOwnerId: node.processOwnerId } : {}),
        params:          applyParamDefaults(node.paramsSchema, node.paramDefaults),
        builtin:         ext.builtin,
        type:            'model',
        weightVariants:  node.weightVariants,
      })
    }
    appendWorkflowUtilityNodes(result, ext, seenSingletonCapabilities)
  }

  return result
}

export function getWorkflowExtension(id: string, all: WorkflowExtension[]): WorkflowExtension | undefined {
  return all.find((e) => e.id === id)
}
