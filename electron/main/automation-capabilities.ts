import axios from 'axios'
import { join, resolve as resolvePath } from 'path'
import { readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { SCENE_IMPORT_MESH_ALLOWED_EXTENSIONS } from './scene-import-service.ts'
import type { ArtifactKind } from '../../src/shared/types/artifacts.ts'
import { normalizeHfDownloads, type HfDownloadDescriptor } from './hf-download-manifest.ts'
import {
  normalizeHttpsDownloads,
  type HttpsDownloadAsset,
} from './https-download-manifest.ts'
import { assertSafeExtensionId, assertSafeOwnershipSegment } from './extension-path-guard.ts'

export type ModelInputKind = ArtifactKind | string | 'none'
export type ExtensionPortKind = ArtifactKind | string

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
  input?: ModelInputKind
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
  input?: ArtifactKind
  output?: ArtifactKind
  inputs?: ProcessPort[]
  params_schema?: unknown
  automation?: CapabilityAutomationMetadata
  ready?: null
}

type CapabilityPauseMetadata = {
  supported: boolean
  checkpoint?: 'interactive'
}

type CapabilitySubstitutionMetadata = {
  supported: boolean
  artifactKinds?: ArtifactKind[]
  boundary?: 'ui_only' | 'electron'
  headless?: boolean
}

type CapabilityAutomationMetadata = {
  boundary: 'electron' | 'ui_only'
  headless: boolean
  pause: CapabilityPauseMetadata
  substitution: CapabilitySubstitutionMetadata
}

export type ProcessPort = {
  name: string
  label?: string
  type: ExtensionPortKind
  required?: boolean
  multiple?: true
  min_items?: number
  max_items?: number
  ordered?: true
}

type ProcessPortType = ProcessPort['type']
type WorkflowNodeComponent = 'video-preview'

type LegacyProcessPortContract = {
  name?: string
  id?: string
  label?: string
  type?: ProcessPortType
  required?: boolean
}

type AutomationUiOnlyCapability = {
  kind: 'ui_only'
  source: 'ui-only'
  id: string
  type: string
  label: string
  reason: string
  automation?: CapabilityAutomationMetadata
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
  input?: ModelInputKind
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
  {
    kind: 'ui_only',
    source: 'ui-only',
    id: 'artifact-substitution',
    type: 'artifactSubstitution',
    label: 'Artifact substitution',
    reason: 'Pause/edit/continue is declarative only in automation; artifact editing and replacement remain Electron/UI-owned and are not executable headlessly.',
    automation: {
      boundary: 'ui_only',
      headless: false,
      pause: { supported: true, checkpoint: 'interactive' },
      substitution: { supported: true, artifactKinds: ['image', 'text', 'mesh', 'scene', 'audio', 'video'], boundary: 'ui_only', headless: false },
    },
  },
]

export type ParsedManifest = {
  id?: string
  name?: string
  displayName?: string
  version?: string
  description?: string
  author?: string | { name?: string }
  source?: string
  generator_class?: string
  type?: 'model' | 'process'
  entry?: string
  nodes?: {
    id: string
    name?: string
    input?: ModelInputKind
    output?: ArtifactKind
    inputs?: Array<ProcessPort | ProcessPortType>
    input_contract?: LegacyProcessPortContract[]
    params_schema?: unknown[]
    hf_repo?: string
    hf_downloads?: unknown
    https_downloads?: unknown
    download_check?: string
    hf_skip_prefixes?: string[]
    weight_owner_id?: string
    process_owner_id?: string
    automation?: PartialCapabilityAutomationMetadata
  }[]
  workflow_nodes?: {
    id: string
    name?: string
    description?: string
    component?: unknown
    capability_id?: string
    input?: ArtifactKind
    output?: ArtifactKind
    singleton?: boolean
  }[]
}

export type ListedExtensionNode<
  TInput extends ModelInputKind = ModelInputKind,
> = {
  id: string
  name: string
  input: TInput
  output: ArtifactKind
  inputs?: ProcessPort[]
  paramsSchema: unknown[]
  hfRepo?: string
  hfDownloads?: HfDownloadDescriptor[]
  httpsDownloads?: HttpsDownloadAsset[]
  downloadCheck?: string
  hfSkipPrefixes?: string[]
  capabilityId?: string
  bundleId?: string
  weightOwnerId?: string
  processOwnerId?: string
  sharedOwner?: boolean
  legacyPaths?: string[]
  automation?: CapabilityAutomationMetadata
}

export type ListedWorkflowNode = {
  id: string
  name: string
  description?: string
  component: WorkflowNodeComponent
  capabilityId: string
  input: ArtifactKind
  output: ArtifactKind
  singleton: boolean
}

type PartialCapabilityPauseMetadata = {
  supported?: unknown
  checkpoint?: unknown
}

type PartialCapabilitySubstitutionMetadata = {
  supported?: unknown
  artifactKinds?: unknown
  boundary?: unknown
}

type PartialCapabilityAutomationMetadata = {
  pause?: PartialCapabilityPauseMetadata
  substitution?: PartialCapabilitySubstitutionMetadata
}

const CAPABILITY_ARTIFACT_KINDS = new Set<ArtifactKind>(['image', 'text', 'mesh', 'scene', 'audio', 'video'])
const WORKFLOW_NODE_COMPONENTS = new Set<WorkflowNodeComponent>(['video-preview'])

function normalizeCapabilityAutomationMetadata(input: PartialCapabilityAutomationMetadata | undefined): CapabilityAutomationMetadata {
  const pauseSupported = input?.pause?.supported === true
  const checkpoint = input?.pause?.checkpoint === 'interactive' ? 'interactive' : undefined
  const rawArtifactKinds = Array.isArray(input?.substitution?.artifactKinds)
    ? input.substitution.artifactKinds.filter((kind): kind is ArtifactKind => typeof kind === 'string' && CAPABILITY_ARTIFACT_KINDS.has(kind as ArtifactKind))
    : undefined
  const substitutionSupported = input?.substitution?.supported === true
  const substitutionBoundary = input?.substitution?.boundary === 'ui_only' ? 'ui_only' : undefined

  return {
    boundary: 'electron',
    headless: true,
    pause: {
      supported: pauseSupported,
      ...(checkpoint ? { checkpoint } : {}),
    },
    substitution: {
      supported: substitutionSupported,
      ...(rawArtifactKinds && rawArtifactKinds.length > 0 ? { artifactKinds: rawArtifactKinds } : {}),
      ...(substitutionBoundary ? { boundary: substitutionBoundary, headless: false } : {}),
    },
  }
}

function isProcessPortType(value: unknown): value is ProcessPortType {
  return value === 'image' || value === 'text' || value === 'mesh' || value === 'scene' || value === 'audio' || value === 'video'
}

function normalizeLegacyArtifactKind(value: unknown): unknown {
  return value
}

function isModelInputKind(value: unknown): value is ModelInputKind {
  return value === 'none' || isProcessPortType(value)
}

function isWorkflowNodeComponent(value: unknown): value is WorkflowNodeComponent {
  return typeof value === 'string' && WORKFLOW_NODE_COMPONENTS.has(value as WorkflowNodeComponent)
}

function normalizeWorkflowNodes(
  nodes: ParsedManifest['workflow_nodes'],
  extensionId: string,
): ListedWorkflowNode[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return []

  return nodes
    .map((node) => {
      if (!node?.id || !isWorkflowNodeComponent(node.component)) return undefined
      const input: ArtifactKind = node.component === 'video-preview'
        ? 'video'
        : isProcessPortType(node.input) ? node.input : 'image'
      const output: ArtifactKind = node.component === 'video-preview'
        ? 'video'
        : isProcessPortType(node.output) ? node.output : input

      return {
        id: node.id,
        name: node.name ?? node.id,
        ...(node.description ? { description: node.description } : {}),
        component: node.component,
        capabilityId: node.capability_id ?? `${extensionId}/${node.id}`,
        input,
        output,
        singleton: node.singleton === true,
      }
    })
    .filter((node): node is ListedWorkflowNode => Boolean(node))
}

function normalizeLegacyProcessPort(
  inputType: ProcessPortType,
  contract: LegacyProcessPortContract | undefined,
): ProcessPort {
  const normalizedContractType = normalizeLegacyArtifactKind(contract?.type)
  const contractType = typeof normalizedContractType === 'string' && normalizedContractType.trim().length > 0
    ? normalizedContractType
    : undefined
  const type = contractType ?? inputType
  const fallbackName = contract?.name?.trim() || contract?.id?.trim() || String(type)
  const fallbackLabel = contract?.label?.trim()

  return {
    name: fallbackName,
    ...(fallbackLabel ? { label: fallbackLabel } : {}),
    type,
    required: contract?.required ?? true,
  }
}

function assertUniquePortNames(ports: Array<{ name: string }>, context: string): void {
  const seen = new Set<string>()
  for (const [index, port] of ports.entries()) {
    if (typeof port.name !== 'string' || !port.name.trim()) {
      throw new Error(`${context}[${index}].name must be a non-empty string`)
    }
    if (seen.has(port.name)) {
      throw new Error(`${context} contains duplicate port name "${port.name}"`)
    }
    seen.add(port.name)
  }
}

function normalizeProcessPorts(
  inputs: Array<ProcessPort | ProcessPortType> | undefined,
  inputContract: LegacyProcessPortContract[] | undefined,
  context: string,
  allowRepeatable: boolean,
): ProcessPort[] | undefined {
  if (!Array.isArray(inputs) || inputs.length === 0) return undefined

  const ports = inputs
    .map((input, index) => {
      if (typeof input === 'string') {
        const normalizedInput = normalizeLegacyArtifactKind(input)
        if (typeof normalizedInput !== 'string' || normalizedInput.trim().length === 0) {
          return undefined
        }
        return normalizeLegacyProcessPort(normalizedInput, inputContract?.[index])
      }

      const normalizedType = normalizeLegacyArtifactKind(input.type)
      if (typeof normalizedType !== 'string' || normalizedType.trim().length === 0) {
        return undefined
      }

      const base = {
        name: input.name || (input as { id?: string }).id,
        ...(input.label ? { label: input.label } : {}),
        type: normalizedType,
        required: input.required ?? true,
      }
      if (input.multiple !== true) return base
      if (!allowRepeatable) {
        return base
      }
      return {
        ...base,
        multiple: true as const,
        min_items: input.min_items ?? 1,
        max_items: input.max_items ?? 10,
        ordered: true as const,
      }
    })
    .filter((input): input is ProcessPort => Boolean(input))

  assertUniquePortNames(ports, context)
  return ports
}

function normalizeListedExtensionFallback(extensionDirName: string, isBuiltin: boolean): ListedModelExtension {
  return {
    type: 'model',
    id: extensionDirName,
    name: extensionDirName,
    trusted: isBuiltin,
    builtin: isBuiltin,
    nodes: [],
  }
}

function buildManifestInvalidError(
  extensionDirName: string,
  manifestFile: string,
  error: unknown,
): AutomationCapabilityError {
  return {
    source: 'electron-manifest',
    code: 'PROCESS_DISCOVERY_MANIFEST_INVALID',
    message: `Failed to parse ${manifestFile} for extension '${extensionDirName}'.`,
    retryable: false,
    context: {
      extension_id: extensionDirName,
      manifest_file: manifestFile,
      error: error instanceof Error ? error.message : String(error),
    },
  }
}

type ListedExtensionCommon<
  TInput extends ModelInputKind,
> = {
  id: string
  name: string
  version?: string
  description?: string
  author?: string
  trusted: boolean
  builtin: boolean
  source?: string
  nodes: ListedExtensionNode<TInput>[]
  workflowNodes?: ListedWorkflowNode[]
}

export type ListedModelExtension = ListedExtensionCommon<ModelInputKind> & {
  type: 'model'
}

export type ListedProcessExtension = ListedExtensionCommon<ArtifactKind> & {
  type: 'process'
  entry: string
}

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
  node: ListedExtensionNode<ArtifactKind>
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

function normalizeExtensionNodeInput(
  value: ModelInputKind | undefined,
  extensionType: 'model' | 'process',
  context: string,
): ModelInputKind {
  const normalizedValue = normalizeLegacyArtifactKind(value)

  if (normalizedValue !== undefined && !isModelInputKind(normalizedValue)) {
    throw new Error(
      context + " must be one of: image, text, mesh, scene, audio, video, none",
    )
  }

  if (normalizedValue === 'none') {
    if (extensionType === 'process') {
      throw new Error(
        context + " may use 'none' only for model extension nodes",
      )
    }
    return 'none'
  }

  return normalizedValue ?? 'image'
}

export function parseExtensionManifest(
  parsed: ParsedManifest,
  fallbackId: string,
  trustedRepos: Set<string>,
  builtin = false,
): ListedExtension {
  const extensionId = assertSafeExtensionId(parsed.id ?? fallbackId)
  const extensionType = parsed.type === 'process' ? 'process' : 'model'
  for (const node of parsed.nodes ?? []) {
    assertSafeOwnershipSegment(node.id, 'Manifest node id')
    if (node.weight_owner_id !== undefined) {
      assertSafeOwnershipSegment(node.weight_owner_id, 'Manifest weight_owner_id')
    }
    if (node.process_owner_id !== undefined) {
      assertSafeOwnershipSegment(node.process_owner_id, 'Manifest process_owner_id')
    }
  }
  const workflowNodes = normalizeWorkflowNodes(parsed.workflow_nodes, extensionId)

  const common = {
    id: extensionId,
    name: parsed.displayName ?? parsed.name ?? fallbackId,
    version: parsed.version,
    description: parsed.description,
    author: typeof parsed.author === 'string' ? parsed.author : parsed.author?.name,
    trusted: builtin || isTrustedSource(parsed.source, trustedRepos),
    source: parsed.source,
    builtin,
    ...(workflowNodes.length > 0 ? { workflowNodes } : {}),
  }

  const legacyPathsByOwner = new Map<string, string[]>()
  for (const node of parsed.nodes ?? []) {
    const capabilityId = `${extensionId}/${node.id}`
    const ownerId = node.weight_owner_id ?? node.id
    const weightOwnerId = `${extensionId}/${ownerId}`
    const existingLegacyPaths = legacyPathsByOwner.get(weightOwnerId)

    if (existingLegacyPaths) existingLegacyPaths.push(capabilityId)
    else legacyPathsByOwner.set(weightOwnerId, [capabilityId])
  }

  const nodes = (parsed.nodes ?? []).map((node) => {
    const capabilityId = `${extensionId}/${node.id}`
    const ownerId = node.weight_owner_id ?? node.id
    const weightOwnerId = `${extensionId}/${ownerId}`
    const processOwnerId = node.process_owner_id ? `${extensionId}/${node.process_owner_id}` : undefined
    const declaredOutput = isProcessPortType(normalizeLegacyArtifactKind(node.output))
      ? normalizeLegacyArtifactKind(node.output) as ArtifactKind
      : 'mesh' as const
    const normalizedInputs = normalizeProcessPorts(
      node.inputs,
      node.input_contract,
      `${capabilityId}.inputs`,
      extensionType === 'process',
    )
    const legacyPaths = [...(legacyPathsByOwner.get(weightOwnerId) ?? [capabilityId])]
    const hfDownloads = normalizeHfDownloads(node.hf_downloads, `${capabilityId}.hf_downloads`)
    const httpsDownloads = normalizeHttpsDownloads(
      node.https_downloads,
      capabilityId + '.https_downloads',
    )
    if (httpsDownloads && legacyPaths.length > 1) {
      throw new Error(
        capabilityId
        + '.https_downloads requires a dedicated weight owner; structured HTTPS plans cannot share an owner',
      )
    }
    const hasModelAssets = Boolean(
      httpsDownloads
      || hfDownloads
      || node.hf_repo
      || node.download_check
      || node.weight_owner_id
    )
    const modelOwnership = parsed.type !== 'process' || hasModelAssets
      ? {
          capabilityId,
          bundleId: extensionId,
          weightOwnerId,
          sharedOwner: legacyPaths.length > 1,
          legacyPaths,
        }
      : {}

    const automationMetadata = parsed.type === 'process' || node.automation
      ? { automation: normalizeCapabilityAutomationMetadata(node.automation) }
      : {}

    return {
      id: node.id,
      name: node.name ?? node.id,
      input: normalizeExtensionNodeInput(
        node.input,
        extensionType,
        capabilityId + '.input',
      ),
      output: declaredOutput,
      ...(normalizedInputs ? { inputs: normalizedInputs } : {}),
      ...(processOwnerId ? { processOwnerId } : {}),
      paramsSchema: node.params_schema ?? [],
      hfRepo: node.hf_repo,
      ...(hfDownloads ? { hfDownloads } : {}),
      ...(httpsDownloads ? { httpsDownloads } : {}),
      downloadCheck: node.download_check,
      hfSkipPrefixes: node.hf_skip_prefixes,
      ...automationMetadata,
      ...modelOwnership,
    }
  })

  if (parsed.type === 'process') {
    return {
      ...common,
      type: 'process',
      entry: parsed.entry ?? 'processor.js',
      nodes: nodes as ListedExtensionNode<ArtifactKind>[],
    }
  }

  return {
    ...common,
    type: 'model',
    nodes: nodes as ListedExtensionNode<ModelInputKind>[],
  }
}

async function readExtensionManifest(dir: string, extensionDirName: string): Promise<ParsedManifest | null> {
  for (const manifestFile of ['manifest.json', 'package.json']) {
    const manifestPath = join(dir, extensionDirName, manifestFile)
    if (!existsSync(manifestPath)) continue

    try {
      const raw = await readFile(manifestPath, 'utf-8')
      return JSON.parse(raw) as ParsedManifest
    } catch {
      // Ignore malformed manifests here to preserve extensions:list fallback behavior.
    }
  }

  return null
}

async function readExtensionManifestDetailed(
  dir: string,
  extensionDirName: string,
): Promise<{ manifest: ParsedManifest | null; manifestFile: string | null; errors: AutomationCapabilityError[] }> {
  const errors: AutomationCapabilityError[] = []

  for (const manifestFile of ['manifest.json', 'package.json']) {
    const manifestPath = join(dir, extensionDirName, manifestFile)
    if (!existsSync(manifestPath)) continue

    try {
      const raw = await readFile(manifestPath, 'utf-8')
      return { manifest: JSON.parse(raw) as ParsedManifest, manifestFile, errors }
    } catch (error) {
      errors.push(buildManifestInvalidError(extensionDirName, manifestFile, error))
    }
  }

  return { manifest: null, manifestFile: null, errors }
}

export async function readExtensionsFromDir(
  dir: string,
  isBuiltin: boolean,
  trustedRepos: Set<string>,
): Promise<ListedExtension[]> {
  if (!existsSync(dir)) return []

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory())

    return Promise.all(
      directories.map(async (entry) => {
        const fallback = normalizeListedExtensionFallback(entry.name, isBuiltin)

        const manifest = await readExtensionManifest(dir, entry.name)
        if (!manifest) return fallback

        try {
          return parseExtensionManifest(manifest, entry.name, trustedRepos, isBuiltin)
        } catch {
          return fallback
        }
      }),
    )
  } catch {
    return []
  }
}

export async function listVisibleExtensions(options: {
  builtinDir: string
  userExtensionsDir: string
  trustedRepos: Set<string>
}): Promise<ListedExtension[]> {
  const [userExtensions, builtinExtensions] = await Promise.all([
    readExtensionsFromDir(options.userExtensionsDir, false, options.trustedRepos),
    readExtensionsFromDir(options.builtinDir, true, options.trustedRepos),
  ])

  return [...builtinExtensions, ...userExtensions]
}

export async function listVisibleExtensionsDetailed(options: {
  builtinDir: string
  userExtensionsDir: string
  trustedRepos: Set<string>
}): Promise<ListedExtensionsResult> {
  const [builtinResult, userResult] = await Promise.all([
    readExtensionsFromDirDetailed(options.builtinDir, true, options.trustedRepos),
    readExtensionsFromDirDetailed(options.userExtensionsDir, false, options.trustedRepos),
  ])

  return {
    extensions: [...builtinResult.extensions, ...userResult.extensions],
    errors: [...builtinResult.errors, ...userResult.errors],
  }
}

export async function readExtensionsFromDirDetailed(
  dir: string,
  isBuiltin: boolean,
  trustedRepos: Set<string>,
): Promise<ListedExtensionsResult> {
  if (!existsSync(dir)) return { extensions: [], errors: [] }

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory())
    const results = await Promise.all(
      directories.map(async (entry) => {
        const fallback = normalizeListedExtensionFallback(entry.name, isBuiltin)

        const { manifest, manifestFile, errors } = await readExtensionManifestDetailed(dir, entry.name)
        if (!manifest) {
          return { extension: fallback as ListedExtension, errors }
        }

        try {
          return {
            extension: parseExtensionManifest(manifest, entry.name, trustedRepos, isBuiltin),
            errors,
          }
        } catch (error) {
          return {
            extension: fallback as ListedExtension,
            errors: [...errors, buildManifestInvalidError(entry.name, manifestFile ?? 'manifest.json', error)],
          }
        }

      }),
    )

    return {
      extensions: results.map((result) => result.extension),
      errors: results.flatMap((result) => result.errors),
    }
  } catch (error) {
    return {
      extensions: [],
      errors: [
        {
          source: 'electron-manifest',
          code: 'PROCESS_DISCOVERY_FAILED',
          message: `Failed to read extensions directory '${dir}'.`,
          retryable: true,
          context: {
            directory: dir,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ],
    }
  }
}

export async function readResolvedExtensionsFromDirDetailed(
  dir: string,
  isBuiltin: boolean,
  trustedRepos: Set<string>,
): Promise<{ extensions: ResolvedListedExtension[]; errors: AutomationCapabilityError[] }> {
  if (!existsSync(dir)) return { extensions: [], errors: [] }

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory())
    const results = await Promise.all(
      directories.map(async (entry) => {
        const fallback = normalizeListedExtensionFallback(entry.name, isBuiltin)

        const { manifest, manifestFile, errors } = await readExtensionManifestDetailed(dir, entry.name)
        let extension: ListedExtension = fallback
        let resolvedManifest: ParsedManifest | null = manifest

        if (manifest) {
          try {
            extension = parseExtensionManifest(manifest, entry.name, trustedRepos, isBuiltin)
          } catch (error) {
            resolvedManifest = null
            return {
              resolved: {
                extension: fallback,
                extDir: resolvePath(dir, entry.name),
                manifest: null,
              } satisfies ResolvedListedExtension,
              errors: [...errors, buildManifestInvalidError(entry.name, manifestFile ?? 'manifest.json', error)],
            }
          }
        }

        return {
          resolved: {
            extension,
            extDir: resolvePath(dir, entry.name),
            manifest: resolvedManifest,
          } satisfies ResolvedListedExtension,
          errors,
        }
      }),
    )

    return {
      extensions: results.map((result) => result.resolved),
      errors: results.flatMap((result) => result.errors),
    }
  } catch (error) {
    return {
      extensions: [],
      errors: [
        {
          source: 'electron-manifest',
          code: 'PROCESS_DISCOVERY_FAILED',
          message: `Failed to read extensions directory '${dir}'.`,
          retryable: true,
          context: {
            directory: dir,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ],
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

  if (!resolvedExtension || resolvedExtension.extension.type !== 'process' || !resolvedExtension.manifest) {
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
          ...(status.input !== undefined ? { input: status.input } : {}),
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
    if (extension.type !== 'process') return []

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
      ...(node.input !== undefined ? { input: node.input } : {}),
      output: node.output,
      ...(node.inputs ? { inputs: node.inputs } : {}),
      params_schema: node.paramsSchema,
      automation: node.automation,
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
