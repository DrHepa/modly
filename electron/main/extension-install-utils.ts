import {
  normalizeModelSources,
  normalizeWeightGroupReferences,
  normalizeWeightGroups,
  safeModelSourceId,
  validateModelNodeIds,
  type ModelSourceNode,
} from './model-sources'

export interface InstallManifest {
  id?: string
  type?: 'model' | 'process'
  entry?: string
  generator_class?: string
  model_sources?: unknown
  weight_groups?: unknown
  nodes?: Array<{
    id?: string
    input?: unknown
    inputs?: unknown
    output?: unknown
    model_sources?: unknown
    weight_groups?: unknown
    hf_repo?: unknown
  } & ModelSourceNode>
}

function declaredInputKind(input: unknown): unknown {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object' && 'type' in input) return (input as { type?: unknown }).type
  return undefined
}

export function assertSupportedVideoNodeShape(
  kind: 'model' | 'process',
  node: { id?: string; input?: unknown; inputs?: unknown; output?: unknown },
): void {
  const scalarVideoInput = node.input === 'video'
  const declaredInputs = node.inputs === undefined ? [node.input ?? 'image'] : node.inputs
  const declaredInputKinds = Array.isArray(declaredInputs) ? declaredInputs.map(declaredInputKind) : []
  const usesVideoInput = scalarVideoInput || declaredInputKinds.includes('video')
  if (kind === 'process' && node.output === 'video') {
    throw new Error('manifest.json: video outputs are supported only for model nodes')
  }
  if (kind === 'process' && usesVideoInput) {
    throw new Error('manifest.json: video input is supported only for model nodes')
  }
  if (kind === 'model' && usesVideoInput && (node.inputs !== undefined || node.input !== 'video')) {
    throw new Error(`manifest.json: ${node.id ?? 'node'} must declare video as its single input field`)
  }
}

export interface ValidatedInstallManifest {
  id: string
  isProcess: boolean
  isPythonProcess: boolean
  entryFile: string
  hasNodes: boolean
}

export function validateInstallManifest(
  manifest: InstallManifest,
  opts: {
    hasEntryFile: (entryFile: string) => boolean
    hasGeneratorFile: () => boolean
  },
  sourceLabel: string,
): ValidatedInstallManifest {
  if (!manifest.id) throw new Error('manifest.json: required field "id" missing')

  const isProcess = manifest.type === 'process'
  const entryFile = manifest.entry ?? 'processor.js'
  const nodes = Array.isArray(manifest.nodes) ? manifest.nodes.filter((node) => node?.id) : []


  if (manifest.model_sources !== undefined) {
    throw new Error('manifest.json: model_sources must be declared on a model node')
  }
  if (isProcess && manifest.weight_groups !== undefined) {
    throw new Error('manifest.json: weight_groups is supported only for model extensions')
  }
  const weightGroups = normalizeWeightGroups(manifest)
  if (weightGroups || (manifest.nodes ?? []).some((node) => node.model_sources !== undefined || node.weight_groups !== undefined)) {
    validateModelNodeIds(manifest.nodes ?? [])
  }
  for (const node of Array.isArray(manifest.nodes) ? manifest.nodes : []) {
    assertSupportedVideoNodeShape(isProcess ? 'process' : 'model', node)
    if (isProcess && (node.model_sources !== undefined || node.weight_groups !== undefined)) {
      throw new Error('manifest.json: model_sources is supported only for model nodes')
    }
    safeModelSourceId(node.id, 'model node id')
    if (node.model_sources !== undefined) normalizeModelSources(node)
    const refs = normalizeWeightGroupReferences(node, weightGroups, `nodes[${node.id}].weight_groups`) ?? []
    if (refs.length > 0 && node.hf_repo !== undefined) {
      throw new Error(`manifest.json: model node "${node.id}" must use model_sources for private weights when weight_groups are declared`)
    }
  }

  if (isProcess) {
    if (!opts.hasEntryFile(entryFile)) {
      throw new Error(`manifest.json: entry file "${entryFile}" missing from ${sourceLabel}`)
    }
  } else {
    if (!opts.hasGeneratorFile()) throw new Error(`generator.py missing from ${sourceLabel}`)
    if (!manifest.generator_class) throw new Error('manifest.json: required field "generator_class" missing')
  }

  return {
    id: manifest.id,
    isProcess,
    isPythonProcess: isProcess && entryFile.endsWith('.py'),
    entryFile,
    hasNodes: nodes.length > 0,
  }
}

export function isSetupFailureFatal(kind: {
  isProcess: boolean
  isPythonProcess: boolean
}): boolean {
  return !kind.isProcess || kind.isPythonProcess
}
