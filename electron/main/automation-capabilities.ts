import axios from 'axios'
import { describeModelOwnership } from './model-ownership'
import { join, resolve as resolvePath } from 'path'
import { readFile, readdir } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { SCENE_IMPORT_MESH_ALLOWED_EXTENSIONS } from './scene-import-service.ts'
import {
  normalizeModelSources, normalizeWeightGroupReferences, normalizeWeightGroups,
  normalizeWeightVariants, safeModelSourceId, validateModelNodeIds,
} from './model-sources'
import { assertSupportedSceneNodeShape, markExtensionInstallationInterrupted } from './extension-install-utils'
import { EXT_INCOMPLETE_MARKER, EXT_REGISTRATION_PENDING_MARKER, isInternalExtensionDirName } from './extension-path-guard'
import { parseExtensionRegistrationPendingName } from './extension-install-recovery'

// Shared with the installer so every discovery surface hides in-flight replacements.
export const activeExtensionInstalls = new Set<string>()

type AutomationCapabilityError = {
  source: 'backend-runtime' | 'electron-manifest'
  code: string
  message: string
  retryable: boolean
  context?: Record<string, unknown>
}

type AutomationModelCapability = {
  kind: 'model'
  source: 'backend-runtime'
  id: string
  name: string
  description?: string
  version?: string
  hf_repo?: string
  tags?: string[]
  downloaded?: boolean
  loaded?: boolean
  active?: boolean
  vram_gb?: number
  params_schema: unknown
}

type AutomationProcessCapability = {
  kind: 'process'
  source: 'electron-manifest'
  id: string
  extension_id: string
  node_id: string
  name: string
  extension_name: string
  description?: string
  version?: string
  builtin: boolean
  trusted: boolean
  entry: string
  input?: string
  inputs?: string[] | ProcessPort[]
  input_labels?: string[]
  output?: string
  param_defaults?: Record<string, unknown>
  params_schema?: unknown
  ready?: null
}

export type ProcessPort = {
  name: string
  type: string
  required?: boolean
}

type AutomationUiOnlyCapability = {
  kind: 'ui_only'
  source: 'ui-only'
  id: string
  type: string
  label: string
  reason: string
}

export type AutomationCapabilitiesResponse = {
  backend_ready: boolean
  models: AutomationModelCapability[]
  processes: AutomationProcessCapability[]
  scene: {
    import_mesh: {
      supported: true
      route: '/scene/import-mesh'
      allowed_extensions: string[]
      extensions: string[]
    }
  }
  excluded: {
    ui_only_nodes: AutomationUiOnlyCapability[]
  }
  errors?: AutomationCapabilityError[]
}

type BackendModelStatus = {
  id: string
  name: string
  description?: string
  version?: string
  hf_repo?: string
  tags?: string[]
  downloaded?: boolean
  loaded?: boolean
  active?: boolean
  vram_gb?: number
}

type ListedExtensionsResult = {
  extensions: ListedExtension[]
  errors: AutomationCapabilityError[]
}

const BACKEND_TIMEOUT_MS = 2_000
const AUTOMATION_CAPABILITIES_API_BASE_URL = 'http://127.0.0.1:8765'

const UI_ONLY_NODE_ALLOWLIST: AutomationUiOnlyCapability[] = [
  {
    kind: 'ui_only',
    source: 'ui-only',
    id: 'imageNode',
    type: 'imageNode',
    label: 'Image',
    reason: 'Canvas input node from WorkflowsPage; it is a composition/UI source, not a manifest-backed executable process.',
  },
  {
    kind: 'ui_only',
    source: 'ui-only',
    id: 'textNode',
    type: 'textNode',
    label: 'Text',
    reason: 'Canvas input node from WorkflowsPage; it only captures UI text input and has no Electron manifest entry.',
  },
  {
    kind: 'ui_only',
    source: 'ui-only',
    id: 'meshNode',
    type: 'meshNode',
    label: 'Load 3D Mesh',
    reason: 'Canvas helper node from WorkflowsPage; it loads an existing mesh for composition and is not a runnable manifest process.',
  },
  {
    kind: 'ui_only',
    source: 'ui-only',
    id: 'outputNode',
    type: 'outputNode',
    label: 'Add to Scene',
    reason: 'Canvas output node from WorkflowsPage; it targets desktop scene composition only and is intentionally excluded from automation discovery.',
  },
]

export type ParsedManifest = {
  id?: string; name?: string; displayName?: string; version?: string
  description?: string; author?: string | { name?: string }
  source?: string; generator_class?: string
  // extension type
  type?:  'model' | 'process'
  entry?: string
  model_sources?: unknown
  weight_groups?: unknown
  // Optional top-level fallbacks — applied to each node if not set on the node
  params_schema?:  unknown[]
  param_defaults?: Record<string, unknown>
  nodes?: {
    id:                string
    name?:             string
    input?:            string
    inputs?:           string[] | ProcessPort[]
    input_labels?:     string[]
    output?:           string
    params_schema?:    unknown[]
    param_defaults?:   Record<string, unknown>
    hf_repo?:          string
    download_check?:   string
    hf_skip_prefixes?: string[]
    hf_include_prefixes?: string[]
    model_sources?: unknown
    weight_groups?: unknown
    weight_variants?: unknown
    weight_owner_id?: string
  }[]
}

export type ListedExtensionNode = ReturnType<typeof parseExtensionManifest>['nodes'][number]

function normalizeProcessPorts(inputs: string[] | ProcessPort[] | undefined): string[] | ProcessPort[] | undefined {
  if (!Array.isArray(inputs) || inputs.length === 0) return inputs
  if (inputs.every((input): input is string => typeof input === 'string')) return [...inputs]
  return (inputs as ProcessPort[]).map((input) => ({ ...input, required: input.required ?? true }))
}

type InstallationState = {
  corrupted?: boolean
  manifestError?: 'missing' | 'invalid' | 'incomplete'
}

type ParsedModelExtension = Extract<ReturnType<typeof parseExtensionManifest>, { type: 'model' }>
export type ListedModelExtension = Pick<ParsedModelExtension, 'type' | 'id' | 'name' | 'trusted' | 'builtin' | 'nodes'>
  & Partial<ParsedModelExtension> & InstallationState
export type ListedProcessExtension = Extract<ReturnType<typeof parseExtensionManifest>, { type: 'process' }> & InstallationState
export type ListedExtension = ListedModelExtension | ListedProcessExtension

type ResolvedListedExtension = {
  extension: ListedExtension
  extDir: string
  manifest: ParsedManifest | null
}

export type ResolveCanonicalProcessTargetOptions = {
  processId: string
  builtinDir: string
  userExtensionsDir: string
  trustedRepos: Set<string>
}

export type CanonicalProcessTarget = {
  processId: string
  extensionId: string
  nodeId: string
  manifest: ParsedManifest
  extension: ListedProcessExtension
  node: ListedExtensionNode
  entry: string
  extDir: string
}

export class ResolveCanonicalProcessTargetError extends Error {
  readonly code: 'PROCESS_NOT_FOUND' | 'PROCESS_UNSUPPORTED'
  readonly processId: string

  constructor(code: 'PROCESS_NOT_FOUND' | 'PROCESS_UNSUPPORTED', processId: string, message: string) {
    super(message)
    this.name = 'ResolveCanonicalProcessTargetError'
    this.code = code
    this.processId = processId
  }
}

function isTrustedSource(source: string | undefined, trustedRepos: Set<string>): boolean {
  if (!source) return false
  return trustedRepos.has(source.toLowerCase().replace(/\/$/, ''))
}

export function parseExtensionManifest(parsed: ParsedManifest, fallbackId: string, trustedRepos: Set<string>, builtin = false) {
  const common = {
    id:          parsed.id          ?? fallbackId,
    name:        parsed.displayName ?? parsed.name ?? fallbackId,
    version:     parsed.version,
    description: parsed.description,
    author:      typeof parsed.author === 'string' ? parsed.author : parsed.author?.name,
    trusted:     builtin || isTrustedSource(parsed.source, trustedRepos),
    source:      parsed.source,
    builtin,
  }

  if (parsed.model_sources !== undefined) {
    throw new Error('manifest.json: model_sources must be declared on a model node')
  }
  if (parsed.type === 'process' && parsed.weight_groups !== undefined) {
    throw new Error('manifest.json: weight_groups is supported only for model extensions')
  }
  const weightGroups = normalizeWeightGroups(parsed)
  if (weightGroups || parsed.nodes?.some((node) => node.model_sources !== undefined || node.weight_groups !== undefined)) {
    validateModelNodeIds(parsed.nodes ?? [])
  }
  const ownership = parsed.type === 'process' ? [] : describeModelOwnership(common.id, parsed.nodes ?? [])
  const nodes = (parsed.nodes ?? []).map((n, index) => {
    const declaredInputs = Array.isArray(n.inputs) ? n.inputs : [n.input ?? 'image']
    const output = n.output ?? 'mesh'
    assertSupportedSceneNodeShape(parsed.type === 'process' ? 'process' : 'model', n, declaredInputs, output)
    const usesManagedWeights = weightGroups !== undefined
      || n.model_sources !== undefined
      || n.weight_groups !== undefined
    if (weightGroups !== undefined && typeof n.id === 'string' && n.id.toLowerCase() === '_shared') {
      throw new Error('manifest.json: model node id "_shared" is reserved')
    }
    const nodeId = usesManagedWeights ? safeModelSourceId(n.id, 'model node id') : n.id
    if (parsed.type === 'process' && (n.model_sources !== undefined || n.weight_groups !== undefined)) {
      throw new Error('manifest.json: model_sources and weight_groups are supported only for model nodes')
    }
    if (parsed.type === 'process' && n.weight_variants !== undefined) {
      throw new Error('manifest.json: weight_variants is supported only for model nodes')
    }
    const modelSources = normalizeModelSources(n)
    const weightVariants = normalizeWeightVariants(n, n.params_schema ?? parsed.params_schema)
    const groupRefs = normalizeWeightGroupReferences(
      n,
      weightGroups,
      `nodes[${n.id}].weight_groups`,
    )
    if (groupRefs && n.hf_repo !== undefined) {
      throw new Error(
        `manifest.json: model node "${nodeId}" must use model_sources for private weights when weight_groups are declared`,
      )
    }
    return {
      ...ownership[index],
      id:             nodeId,
      name:           n.name ?? n.id,
      input:          n.input  ?? 'image' as const,
      inputs:         normalizeProcessPorts(n.inputs),
      inputLabels:    n.input_labels,
      output:         n.output ?? 'mesh'  as const,
      paramsSchema:   n.params_schema ?? parsed.params_schema ?? [],
      paramDefaults:  { ...(parsed.param_defaults ?? {}), ...(n.param_defaults ?? {}) },
      hfRepo:         n.hf_repo,
      downloadCheck:  n.download_check,
      hfSkipPrefixes: n.hf_skip_prefixes,
      hfIncludePrefixes: n.hf_include_prefixes,
      hasModelSources: modelSources !== undefined,
      weightGroups: groupRefs,
      weightVariants: weightVariants && {
        param:   weightVariants.param,
        default: weightVariants.default,
        options: weightVariants.options.map((option) => ({
          id:     option.id,
          label:  option.label,
          sizeGb: option.size_gb,
          vramGb: option.vram_gb,
        })),
      },
    }
  })

  if (parsed.type === 'process') {
    return { ...common, type: 'process' as const, entry: parsed.entry ?? 'processor.js', nodes }
  }

  return {
    ...common,
    type: 'model' as const,
    nodes,
    weightGroups: (weightGroups ?? []).map((group) => ({
      id: group.id,
      dependentNodeIds: nodes
        .filter((node) => node.weightGroups?.includes(group.id))
        .map((node) => node.id),
    })),
  }
}

export type ExtensionDiscoveryOptions = {
  builtinDir: string
  userExtensionsDir: string
  trustedRepos: Set<string>
}

export async function readExtensionsFromDir(
  dir: string,
  isBuiltin: boolean,
  trustedRepos: Set<string>,
): Promise<ListedExtension[]> {
  const result = await readResolvedExtensionsFromDirDetailed(dir, isBuiltin, trustedRepos)
  return result.extensions.map((resolved) => resolved.extension)
}

export async function listVisibleExtensions(options: ExtensionDiscoveryOptions): Promise<ListedExtension[]> {
  return (await listVisibleExtensionsDetailed(options)).extensions
}

export async function listVisibleExtensionsDetailed(options: ExtensionDiscoveryOptions): Promise<ListedExtensionsResult> {
  const result = await listVisibleResolvedExtensionsDetailed(options)
  return { extensions: result.extensions.map((resolved) => resolved.extension), errors: result.errors }
}

async function readResolvedExtensionsFromDirDetailed(
  dir: string,
  isBuiltin: boolean,
  trustedRepos: Set<string>,
): Promise<{ extensions: ResolvedListedExtension[]; errors: AutomationCapabilityError[] }> {
  if (!existsSync(dir)) return { extensions: [], errors: [] }

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const pendingRegistrationIds = new Set(
      isBuiltin ? [] : entries
        .map((entry) => parseExtensionRegistrationPendingName(entry.name)?.extensionId)
        .filter((extensionId): extensionId is string => Boolean(extensionId)),
    )
    // Follow local symlinks/junctions, but never expose staging or backup folders.
    const directories = entries.filter((entry) => {
      if (isInternalExtensionDirName(entry.name)) return false
      if (entry.isDirectory()) return true
      if (entry.isSymbolicLink()) {
        try { return statSync(join(dir, entry.name)).isDirectory() } catch { return false }
      }
      return false
    })
    const results = await Promise.all(directories.map(async (entry) => {
      const entryPath = join(dir, entry.name)
      const skeleton: ListedModelExtension = {
        type: 'model', id: entry.name, name: entry.name, trusted: isBuiltin,
        builtin: isBuiltin, nodes: [], corrupted: true,
      }
      const installInterrupted = existsSync(join(entryPath, EXT_INCOMPLETE_MARKER))
        || existsSync(join(entryPath, EXT_REGISTRATION_PENDING_MARKER))
        || pendingRegistrationIds.has(entry.name)
      if (installInterrupted && activeExtensionInstalls.has(entry.name)) return null

      let localSourcePath: string | undefined
      if (!isBuiltin) {
        const sentinelPath = join(entryPath, '.modly-local')
        if (existsSync(sentinelPath)) {
          try { localSourcePath = (await readFile(sentinelPath, 'utf-8')).trim() } catch { /* ignore */ }
        }
      }

      const errors: AutomationCapabilityError[] = []
      let manifestError: 'missing' | 'invalid' = 'missing'
      for (const manifestFile of ['manifest.json', 'package.json']) {
        const manifestPath = join(entryPath, manifestFile)
        if (!existsSync(manifestPath)) continue
        try {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as ParsedManifest
          if (localSourcePath) manifest.source = `local://${localSourcePath}`
          const extension = parseExtensionManifest(manifest, entry.name, trustedRepos, isBuiltin)
          return {
            resolved: { extension: markExtensionInstallationInterrupted(extension, installInterrupted), extDir: resolvePath(entryPath), manifest },
            errors,
          }
        } catch (error) {
          manifestError = 'invalid'
          errors.push({
            source: 'electron-manifest', code: 'PROCESS_DISCOVERY_MANIFEST_INVALID',
            message: `Failed to parse ${manifestFile} for extension '${entry.name}'.`,
            retryable: false,
            context: { extension_id: entry.name, manifest_file: manifestFile, error: error instanceof Error ? error.message : String(error) },
          })
        }
      }
      return {
        resolved: {
          extension: installInterrupted ? markExtensionInstallationInterrupted(skeleton, true) : { ...skeleton, manifestError },
          extDir: resolvePath(entryPath), manifest: null,
        },
        errors,
      }
    }))
    return {
      extensions: results.flatMap((result) => result ? [result.resolved] : []),
      errors: results.flatMap((result) => result?.errors ?? []),
    }
  } catch (error) {
    return {
      extensions: [],
      errors: [{
        source: 'electron-manifest', code: 'PROCESS_DISCOVERY_FAILED',
        message: `Failed to read extensions directory '${dir}'.`, retryable: true,
        context: { directory: dir, error: error instanceof Error ? error.message : String(error) },
      }],
    }
  }
}

async function listVisibleResolvedExtensionsDetailed(options: {
  builtinDir: string
  userExtensionsDir: string
  trustedRepos: Set<string>
}): Promise<{ extensions: ResolvedListedExtension[]; errors: AutomationCapabilityError[] }> {
  const [builtinResult, userResult] = await Promise.all([
    readResolvedExtensionsFromDirDetailed(options.builtinDir, true, options.trustedRepos),
    readResolvedExtensionsFromDirDetailed(options.userExtensionsDir, false, options.trustedRepos),
  ])

  return {
    extensions: [...builtinResult.extensions, ...userResult.extensions],
    errors: [...builtinResult.errors, ...userResult.errors],
  }
}

export async function resolveCanonicalProcessTarget(
  options: ResolveCanonicalProcessTargetOptions,
): Promise<CanonicalProcessTarget> {
  const segments = options.processId.split('/')
  if (segments.length !== 2 || segments.some((segment) => segment.trim().length === 0)) {
    throw new ResolveCanonicalProcessTargetError(
      'PROCESS_NOT_FOUND',
      options.processId,
      `Process '${options.processId}' was not found; expected canonical id '{extension_id}/{node_id}'.`,
    )
  }

  const [extensionId, nodeId] = segments
  const { extensions } = await listVisibleResolvedExtensionsDetailed(options)
  const resolvedExtension = extensions.find((candidate) => candidate.extension.id === extensionId)

  if (!resolvedExtension || resolvedExtension.extension.type !== 'process' || resolvedExtension.extension.corrupted || !resolvedExtension.manifest) {
    throw new ResolveCanonicalProcessTargetError(
      'PROCESS_NOT_FOUND',
      options.processId,
      `Process '${options.processId}' was not found in manifest discovery.`,
    )
  }

  const node = resolvedExtension.extension.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) {
    throw new ResolveCanonicalProcessTargetError(
      'PROCESS_NOT_FOUND',
      options.processId,
      `Process '${options.processId}' was not found in manifest discovery.`,
    )
  }

  if (node.input !== 'mesh' || node.output !== 'mesh') {
    throw new ResolveCanonicalProcessTargetError(
      'PROCESS_UNSUPPORTED',
      options.processId,
      `Process '${options.processId}' is not supported by the mesh-only process-runs surface.`,
    )
  }

  return {
    processId: options.processId,
    extensionId,
    nodeId,
    manifest: resolvedExtension.manifest,
    extension: resolvedExtension.extension,
    node,
    entry: resolvedExtension.extension.entry,
    extDir: resolvedExtension.extDir,
  }
}

export async function getBackendModels(): Promise<{
  backend_ready: boolean
  models: AutomationModelCapability[]
  errors: AutomationCapabilityError[]
}> {
  try {
    await axios.get(`${AUTOMATION_CAPABILITIES_API_BASE_URL}/health`, { timeout: BACKEND_TIMEOUT_MS })
  } catch (error) {
    return {
      backend_ready: false,
      models: [],
      errors: [
        {
          source: 'backend-runtime',
          code: 'BACKEND_NOT_READY',
          message: 'Backend runtime is not ready; model discovery skipped because GET /health failed.',
          retryable: true,
          context: {
            endpoint: '/health',
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ],
    }
  }

  let statuses: BackendModelStatus[]
  try {
      const response = await axios.get<BackendModelStatus[]>(`${AUTOMATION_CAPABILITIES_API_BASE_URL}/model/all`, {
      timeout: BACKEND_TIMEOUT_MS,
    })
    statuses = Array.isArray(response.data) ? response.data : []
  } catch (error) {
    return {
      backend_ready: true,
      models: [],
      errors: [
        {
          source: 'backend-runtime',
          code: 'BACKEND_MODELS_FAILED',
          message: 'Backend runtime is healthy, but GET /model/all failed during model discovery.',
          retryable: true,
          context: {
            endpoint: '/model/all',
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ],
    }
  }

  const results = await Promise.all(
    statuses.map(async (status) => {
      try {
         const response = await axios.get<unknown>(`${AUTOMATION_CAPABILITIES_API_BASE_URL}/model/params`, {
          params: { model_id: status.id },
          timeout: BACKEND_TIMEOUT_MS,
        })

        const model: AutomationModelCapability = {
          kind: 'model',
          source: 'backend-runtime',
          id: status.id,
          name: status.name,
          description: status.description,
          version: status.version,
          hf_repo: status.hf_repo,
          tags: status.tags,
          downloaded: status.downloaded,
          loaded: status.loaded,
          active: status.active,
          vram_gb: status.vram_gb,
          params_schema: response.data,
        }

        return { model, error: null as AutomationCapabilityError | null }
      } catch (error) {
        return {
          model: null,
          error: {
            source: 'backend-runtime',
            code: 'MODEL_PARAMS_FAILED',
            message: `Failed to resolve runtime params for model '${status.id}'.`,
            retryable: true,
            context: {
              endpoint: '/model/params',
              model_id: status.id,
              error: error instanceof Error ? error.message : String(error),
            },
          } satisfies AutomationCapabilityError,
        }
      }
    }),
  )

  return {
    backend_ready: true,
    models: results.flatMap((result) => (result.model ? [result.model] : [])),
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
  }
}

export async function getManifestProcesses(options: {
  builtinDir: string
  userExtensionsDir: string
  trustedRepos: Set<string>
}): Promise<{
  processes: AutomationProcessCapability[]
  errors: AutomationCapabilityError[]
}> {
  const { extensions, errors } = await listVisibleExtensionsDetailed(options)

  const processes = extensions.flatMap((extension) => {
    if (extension.type !== 'process' || extension.corrupted) return []

    return extension.nodes.map<AutomationProcessCapability>((node) => ({
      kind: 'process',
      source: 'electron-manifest',
      id: `${extension.id}/${node.id}`,
      extension_id: extension.id,
      node_id: node.id,
      name: node.name,
      extension_name: extension.name,
      description: extension.description,
      version: extension.version,
      builtin: extension.builtin,
      trusted: extension.trusted,
      entry: extension.entry,
      input: node.input,
      ...(node.inputs ? { inputs: node.inputs } : {}),
      ...(node.inputLabels ? { input_labels: node.inputLabels } : {}),
      ...(Object.keys(node.paramDefaults).length ? { param_defaults: node.paramDefaults } : {}),
      output: node.output,
      params_schema: node.paramsSchema,
      ready: null,
    }))
  })

  return { processes, errors }
}

export function getUiOnlyNodes(): AutomationUiOnlyCapability[] {
  return UI_ONLY_NODE_ALLOWLIST.map((node) => ({ ...node }))
}

export async function buildAutomationCapabilities(options: {
  builtinDir: string
  userExtensionsDir: string
  trustedRepos: Set<string>
}): Promise<AutomationCapabilitiesResponse> {
  const [backendResult, processResult] = await Promise.all([
    getBackendModels(),
    getManifestProcesses(options),
  ])

  const errors = [...backendResult.errors, ...processResult.errors]

  return {
    backend_ready: backendResult.backend_ready,
    models: backendResult.models,
    processes: processResult.processes,
    scene: {
      import_mesh: {
        supported: true,
        route: '/scene/import-mesh',
        allowed_extensions: [...SCENE_IMPORT_MESH_ALLOWED_EXTENSIONS],
        extensions: [...SCENE_IMPORT_MESH_ALLOWED_EXTENSIONS],
      },
    },
    excluded: {
      ui_only_nodes: getUiOnlyNodes(),
    },
    ...(errors.length > 0 ? { errors } : {}),
  }
}
