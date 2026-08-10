import type { ArtifactKind } from '../../src/shared/types/artifacts.ts'
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
import { normalizeHfDownloads, type HfDownloadDescriptor } from './hf-download-manifest.ts'
import {
  normalizeHttpsDownloads,
  type HttpsDownloadAsset,
} from './https-download-manifest.ts'
import { assertSafeExtensionId, assertSafeOwnershipSegment } from './extension-path-guard.ts'
import { assertAgentCapabilitySnapshotV1, canonicalJson, normalizeAgentParamsSchema, sha256Canonical } from './agent-trust-contracts.ts'
import type {
  AgentCapabilityDeclarationV1,
  AgentCapabilityInventoryResult,
  AgentCapabilitySnapshotV1,
  AgentMcpArtifactOutputContractV1,
  AgentProcessModelAccessDeclarationV1,
  AgentSkillsDeclarationV1,
} from '../../src/shared/types/agentActions.ts'
import { discoverGovernedMcpTools, type DiscoveredMcpTool } from './agent-mcp-manifest.ts'
import {
  AgentProcessManifestError,
  bindAgentProcessExecution,
  normalizeAgentProcessDeclaration,
} from './agent-process-manifest.ts'
import type { AgentHostRuntimeRegistry } from './agent-host-runtime.ts'
import {
  AgentSkillsManifestError,
  bindAgentSkillSet,
  normalizeAgentSkillsDeclaration,
} from './agent-skills-manifest.ts'
import { parseStrictJson } from './strict-json.ts'

const MAX_EXTENSION_MANIFEST_BYTES = 512 * 1_024
const MAX_EXTENSION_MANIFEST_DEPTH = 64
const MAX_EXTENSION_MANIFEST_PROPERTIES = 10_000
const MAX_EXTENSION_MANIFEST_ARRAY = 5_000

export type ModelInputKind = string
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
  input?: string
  inputs?: string[] | ProcessPort[]
  input_labels?: string[]
  output?: string
  param_defaults?: Record<string, unknown>
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
  type?: string
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
  mcp?: unknown
  nodes?: {
    id:                string
    name?:             string
    input?:            string
    inputs?:           string[] | ProcessPort[]
    input_contract?:   LegacyProcessPortContract[]
    input_labels?:     string[]
    output?:           string
    params_schema?:    unknown[]
    param_defaults?:   Record<string, unknown>
    hf_repo?:          string
    hf_downloads?:     unknown
    https_downloads?:  unknown
    download_check?:   string
    hf_skip_prefixes?: string[]
    hf_include_prefixes?: string[]
    model_sources?: unknown
    weight_groups?: unknown
    weight_variants?: unknown
    weight_owner_id?: string
    process_owner_id?: string
    automation?: PartialCapabilityAutomationMetadata
    agent?: unknown
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

type ParsedManifestNode = NonNullable<ParsedManifest['nodes']>[number]

type AgentCapabilityDeclarationError = Readonly<{
  code: 'AGENT_SKILL_INVALID'
}>

export type ListedExtensionNode<TInput extends ModelInputKind = ModelInputKind> =
  ReturnType<typeof parseExtensionManifest>['nodes'][number] & { input: TInput }

function normalizeProcessPorts(
  inputs: string[] | ProcessPort[] | undefined,
  inputContract: LegacyProcessPortContract[] | undefined,
): string[] | ProcessPort[] | undefined {
  if (!Array.isArray(inputs) || inputs.length === 0) return inputs
  if (inputs.every((input): input is string => typeof input === 'string')) {
    const normalizedInputs = inputs.map((input) => normalizeLegacyArtifactKind(input))
    // Naming changes routing authority: opt in only when every slot is unambiguous.
    if (!Array.isArray(inputContract) || inputContract.length !== inputs.length) return [...normalizedInputs]
    const names = new Set<string>()
    const ports: ProcessPort[] = []
    for (const [index, type] of normalizedInputs.entries()) {
      const contract = inputContract[index]
      if (!contract || typeof contract !== 'object' || Array.isArray(contract)
        || typeof contract.name !== 'string'
        || (contract.required != null && typeof contract.required !== 'boolean')) return [...normalizedInputs]
      const name = contract.name.trim()
      if (!name || names.has(name)) return [...normalizedInputs]
      names.add(name)
      const label = typeof contract.label === 'string' ? contract.label.trim() : ''
      ports.push({ name, ...(label ? { label } : {}), type, required: contract.required ?? true })
    }
    return ports
  }
  return (inputs as ProcessPort[]).map((input) => {
    const { id, ...port } = input as ProcessPort & { id?: string }
    return { ...(input.name ? input : port), name: input.name || id || input.name, type: normalizeLegacyArtifactKind(input.type), required: input.required ?? true }
  })
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
const AGENT_DECLARATION_KEYS = new Set(['schema', 'capability_id', 'display_name', 'description', 'approval', 'process', 'skills'])
const AGENT_APPROVAL_KEYS = new Set(['required', 'scope'])

function isPlainOwnRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isSafeDisplayText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !hasControlCharacter(value)
    && !hasLoneSurrogate(value)
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function normalizeAgentCapabilityDeclarationResult(
  input: unknown,
  expectedCapabilityId: string,
  entry = 'processor.js',
): Readonly<{
  declaration?: AgentCapabilityDeclarationV1
  error?: AgentCapabilityDeclarationError
}> {
  if (!isPlainOwnRecord(input) || !hasOnlyKeys(input, AGENT_DECLARATION_KEYS)) return {}
  if (input.schema !== 'modly.agent-capability-declaration.v1') return {}
  if (input.capability_id !== expectedCapabilityId) return {}
  const [extensionId, nodeId, ...extraSegments] = expectedCapabilityId.split('/')
  if (!extensionId || !nodeId || extraSegments.length > 0) return {}
  try {
    assertSafeExtensionId(extensionId)
    assertSafeOwnershipSegment(nodeId, 'Agent capability node id')
  } catch {
    return {}
  }
  if (!isSafeDisplayText(input.display_name, 80) || !isSafeDisplayText(input.description, 500)) return {}
  if (!isPlainOwnRecord(input.approval) || !hasOnlyKeys(input.approval, AGENT_APPROVAL_KEYS)) return {}
  if (input.approval.required !== true || input.approval.scope !== 'single_action') return {}

  let skills: AgentSkillsDeclarationV1 | undefined
  if (Object.prototype.hasOwnProperty.call(input, 'skills') && input.skills !== undefined) {
    try {
      skills = normalizeAgentSkillsDeclaration(input.skills)
    } catch {
      return { error: { code: 'AGENT_SKILL_INVALID' } }
    }
  }

  let process: AgentCapabilityDeclarationV1['process']
  try {
    process = normalizeAgentProcessDeclaration(input.process, entry)
    canonicalJson(input)
  } catch {
    return {}
  }
  return {
    declaration: {
      schema: 'modly.agent-capability-declaration.v1',
      capability_id: expectedCapabilityId,
      display_name: input.display_name,
      description: input.description,
      approval: { required: true, scope: 'single_action' },
      process,
      ...(skills ? { skills } : {}),
    },
  }
}

export function normalizeAgentCapabilityDeclaration(
  input: unknown,
  expectedCapabilityId: string,
  entry = 'processor.js',
): AgentCapabilityDeclarationV1 | undefined {
  return normalizeAgentCapabilityDeclarationResult(input, expectedCapabilityId, entry).declaration
}

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

function normalizeLegacyArtifactKind(value: string): string
function normalizeLegacyArtifactKind(value: unknown): unknown
function normalizeLegacyArtifactKind(value: unknown): unknown {
  return value
}

function isModelInputKind(value: unknown): value is ModelInputKind {
  return typeof value === 'string' && value.trim().length > 0
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

function buildAgentManifestInvalidError(
  extensionDirName: string,
  manifestFile: string,
  error: unknown,
): AutomationCapabilityError {
  return {
    source: 'electron-manifest',
    code: 'AGENT_MANIFEST_INVALID',
    message: `Agent declarations in ${manifestFile} for extension '${extensionDirName}' failed strict validation.`,
    retryable: false,
    context: {
      extension_id: extensionDirName,
      manifest_file: manifestFile,
      error: error instanceof Error ? error.message : String(error),
    },
  }
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

function normalizeExtensionNodeInput(
  value: string | undefined,
  extensionType: 'model' | 'process',
  context: string,
): ModelInputKind {
  const normalizedValue = normalizeLegacyArtifactKind(value)

  if (normalizedValue !== undefined && !isModelInputKind(normalizedValue)) {
    throw new Error(
      context + " must be a non-empty string",
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
) {
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
    id:          parsed.id          ?? fallbackId,
    name:        parsed.displayName ?? parsed.name ?? fallbackId,
    version:     parsed.version,
    description: parsed.description,
    author:      typeof parsed.author === 'string' ? parsed.author : parsed.author?.name,
    trusted:     builtin || isTrustedSource(parsed.source, trustedRepos),
    source:      parsed.source,
    builtin,
    ...(workflowNodes.length > 0 ? { workflowNodes } : {}),
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
  const ownership = describeModelOwnership(common.id, parsed.nodes ?? [])
  const nodes = (parsed.nodes ?? []).map((n, index) => {
    const normalizedInputs = normalizeProcessPorts(n.inputs, n.input_contract)
    const processOwnerId = n.process_owner_id ? `${extensionId}/${n.process_owner_id}` : undefined
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
    const capabilityId = `${extensionId}/${n.id}`
    const hfDownloads = normalizeHfDownloads(n.hf_downloads, `${capabilityId}.hf_downloads`)
    const httpsDownloads = normalizeHttpsDownloads(n.https_downloads, `${capabilityId}.https_downloads`)
    if (httpsDownloads && ownership[index].sharedOwner) {
      throw new Error(
        capabilityId + '.https_downloads requires a dedicated weight owner; structured HTTPS plans cannot share an owner',
      )
    }
    const hasModelAssets = Boolean(httpsDownloads || hfDownloads || n.hf_repo || n.download_check || n.weight_owner_id)
    const agentResult = extensionType === 'process'
      && isProcessPortType(n.input)
      && isProcessPortType(n.output)
      ? normalizeAgentCapabilityDeclarationResult(n.agent, capabilityId, parsed.entry ?? 'processor.js')
      : {}

    return {
      ...(parsed.type !== 'process' || hasModelAssets ? ownership[index] : {}),
      ...(parsed.type === 'process' || n.automation
        ? { automation: normalizeCapabilityAutomationMetadata(n.automation) }
        : {}),
      id:             nodeId,
      name:           n.name ?? n.id,
      input:          normalizeExtensionNodeInput(n.input, extensionType, `${capabilityId}.input`),
      inputs:         normalizedInputs,
      ...(processOwnerId ? { processOwnerId } : {}),
      inputLabels:    n.input_labels,
      output:         normalizeLegacyArtifactKind(n.output ?? 'mesh'),
      paramsSchema:   n.params_schema ?? parsed.params_schema ?? [],
      paramDefaults:  { ...(parsed.param_defaults ?? {}), ...(n.param_defaults ?? {}) },
      hfRepo:         n.hf_repo,
      ...(hfDownloads ? { hfDownloads } : {}),
      ...(httpsDownloads ? { httpsDownloads } : {}),
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
      ...(agentResult.declaration ? { agent: agentResult.declaration } : {}),
      ...(agentResult.error ? { agentError: agentResult.error } : {}),
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

function validateStrictAgentManifest(bytes: Buffer): void {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_EXTENSION_MANIFEST_BYTES) {
    throw new Error('Agent manifest validation requires a non-empty bounded manifest')
  }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  parseStrictJson(raw, {
    maxBytes: MAX_EXTENSION_MANIFEST_BYTES,
    maxDepth: MAX_EXTENSION_MANIFEST_DEPTH,
    maxProperties: MAX_EXTENSION_MANIFEST_PROPERTIES,
    maxArrayLength: MAX_EXTENSION_MANIFEST_ARRAY,
  })
}

function stripAgentDeclarations(manifest: ParsedManifest): ParsedManifest {
  if (!Array.isArray(manifest.nodes)) return manifest
  return {
    ...manifest,
    nodes: manifest.nodes.map((node) => {
      if (!isPlainOwnRecord(node) || !Object.hasOwn(node, 'agent')) return node
      const { agent: _agent, ...ordinaryNode } = node
      return ordinaryNode as ParsedManifestNode
    }),
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

export async function readExtensionsFromDirDetailed(
  dir: string,
  isBuiltin: boolean,
  trustedRepos: Set<string>,
): Promise<ListedExtensionsResult> {
  const result = await readResolvedExtensionsFromDirDetailed(dir, isBuiltin, trustedRepos)
  return { extensions: result.extensions.map((resolved) => resolved.extension), errors: result.errors }
}

export async function listVisibleExtensions(options: ExtensionDiscoveryOptions): Promise<ListedExtension[]> {
  return (await listVisibleExtensionsDetailed(options)).extensions
}

export async function listVisibleExtensionsDetailed(options: ExtensionDiscoveryOptions): Promise<ListedExtensionsResult> {
  const result = await listVisibleResolvedExtensionsDetailed(options)
  return { extensions: result.extensions.map((resolved) => resolved.extension), errors: result.errors }
}

export async function readResolvedExtensionsFromDirDetailed(
  dir: string,
  isBuiltin: boolean,
  trustedRepos: Set<string>,
  validateAgentJson = false,
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
          const bytes = await readFile(manifestPath)
          let manifest = JSON.parse(bytes.toString('utf-8')) as ParsedManifest
          if (validateAgentJson) {
            try {
              validateStrictAgentManifest(bytes)
            } catch (error) {
              manifest = stripAgentDeclarations(manifest)
              errors.push(buildAgentManifestInvalidError(entry.name, manifestFile, error))
            }
          }
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
}, validateAgentJson = false): Promise<{ extensions: ResolvedListedExtension[]; errors: AutomationCapabilityError[] }> {
  const [builtinResult, userResult] = await Promise.all([
    readResolvedExtensionsFromDirDetailed(options.builtinDir, true, options.trustedRepos, validateAgentJson),
    readResolvedExtensionsFromDirDetailed(options.userExtensionsDir, false, options.trustedRepos, validateAgentJson),
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
      ...(node.input !== undefined ? { input: node.input } : {}),
      ...(node.inputs ? { inputs: node.inputs } : {}),
      ...(node.inputLabels ? { input_labels: node.inputLabels } : {}),
      ...(Object.keys(node.paramDefaults).length ? { param_defaults: node.paramDefaults } : {}),
      output: node.output,
      params_schema: node.paramsSchema,
      automation: node.automation,
      ready: null,
    }))
  })

  return { processes, errors }
}

async function buildAgentCapabilitySnapshot(
  extension: ListedProcessExtension,
  node: ListedExtensionNode,
  extensionDir: string,
  processPythonExecutable?: string,
  skillFileLimitExceeded = false,
): Promise<{
  capability?: AgentCapabilitySnapshotV1
  error?: { code: string, message: string, capabilityId: string }
}> {
  if (node.agentError) {
    return {
      error: {
        code: node.agentError.code,
        message: 'A PROCESS Agent skill declaration is invalid.',
        capabilityId: `${extension.id}/${node.id}`,
      },
    }
  }
  if (!node.agent) return {}
  if (node.agent.skills && skillFileLimitExceeded) {
    return {
      error: {
        code: 'AGENT_SKILLS_FILE_LIMIT_EXCEEDED',
        message: 'An extension declared more than four unique Agent skill files.',
        capabilityId: node.agent.capability_id,
      },
    }
  }
  try {
    const paramsSchema = normalizeAgentParamsSchema(node.paramsSchema)
    const inputs = node.inputs?.map((input) => typeof input === 'string' ? input : { ...input })
    const execution = await bindAgentProcessExecution(
      extensionDir, extension.entry, node.agent.process, processPythonExecutable,
    )
    const skills = node.agent.skills
      ? (await bindAgentSkillSet(extensionDir, node.agent.skills)).publicSnapshot
      : undefined
    const unsigned = {
      schema: 'modly.agent-capability.v1' as const,
      version: 1 as const,
      id: node.agent.capability_id,
      displayName: node.agent.display_name,
      description: node.agent.description,
      extension: {
        id: extension.id,
        name: extension.name,
        ...(extension.version ? { version: extension.version } : {}),
      },
      node: {
        id: node.id,
        input: node.input,
        output: node.output,
        ...(inputs ? { inputs } : {}),
        paramsSchema,
      },
      execution,
      ...(skills ? { skills } : {}),
      approval: { ...node.agent.approval },
    }
    return { capability: assertAgentCapabilitySnapshotV1({ ...unsigned, hash: sha256Canonical(unsigned) }) }
  } catch (error) {
    if (error instanceof AgentSkillsManifestError) {
      return {
        error: {
          code: 'AGENT_SKILL_INVALID',
          message: 'A declared Agent skill file is invalid or changed during discovery.',
          capabilityId: node.agent.capability_id,
        },
      }
    }
    const runtimeRequired = node.agent.process.runtime?.kind === 'extension-python-venv-v1'
    const stale = error instanceof AgentProcessManifestError && error.code === 'runtime_stale'
    const unavailable = error instanceof AgentProcessManifestError && error.code === 'unsafe_runtime'
    const code = runtimeRequired
      ? stale ? 'PROCESS_PYTHON_RUNTIME_STALE' : unavailable ? 'PROCESS_PYTHON_RUNTIME_UNAVAILABLE' : 'PROCESS_AGENT_METADATA_INVALID'
      : stale ? 'PROCESS_RUNTIME_STALE' : unavailable ? 'PROCESS_RUNTIME_UNAVAILABLE' : 'PROCESS_AGENT_METADATA_INVALID'
    return {
      error: {
        code,
        message: runtimeRequired
          ? stale
            ? 'An extension Python runtime changed during discovery and was excluded.'
            : unavailable
              ? 'An extension Python runtime is missing or unsafe and was excluded.'
              : 'An Agent process declaration is invalid and was excluded.'
          : stale
            ? 'An Agent process runtime changed during discovery and was excluded.'
            : unavailable
              ? 'An Agent process runtime is missing or unsafe and was excluded.'
              : 'An Agent process declaration is invalid and was excluded.',
        capabilityId: node.agent.capability_id,
      },
    }
  }
}

async function buildMcpAgentCapabilitySnapshot(
  candidate: DiscoveredMcpTool,
  skillFileLimitExceeded = false,
): Promise<{
  capability?: AgentCapabilitySnapshotV1
  error?: { code: string, message: string, capabilityId: string }
}> {
  if (candidate.tool.skillsInvalid) {
    return {
      error: {
        code: 'AGENT_SKILL_INVALID',
        message: 'An MCP tool Agent skill declaration is invalid.',
        capabilityId: candidate.tool.capabilityId,
      },
    }
  }
  if (candidate.tool.skills && skillFileLimitExceeded) {
    return {
      error: {
        code: 'AGENT_SKILLS_FILE_LIMIT_EXCEEDED',
        message: 'An extension declared more than four unique Agent skill files.',
        capabilityId: candidate.tool.capabilityId,
      },
    }
  }
  try {
    const nodeId = candidate.tool.capabilityId.split('/')[1]
    const primaryArtifact = candidate.tool.artifact.allowed[0]
    if (!primaryArtifact) return {}
    const outputKinds = candidate.tool.artifact.allowed.reduce<ArtifactKind[]>((kinds, artifact) => (
      kinds.includes(artifact.kind) ? kinds : [...kinds, artifact.kind]
    ), [])
    const skills = candidate.tool.skills
      ? (await bindAgentSkillSet(candidate.extensionDir, candidate.tool.skills)).publicSnapshot
      : undefined
    const unsigned = {
      schema: 'modly.agent-capability.v1' as const,
      version: 1 as const,
      id: candidate.tool.capabilityId,
      displayName: candidate.tool.displayName,
      description: candidate.tool.description,
      extension: candidate.extension,
      node: {
        id: nodeId,
        input: 'text' as const,
        output: primaryArtifact.kind,
        outputs: outputKinds,
        paramsSchema: [],
      },
      execution: {
        kind: 'mcp_tool' as const,
        inputSchema: candidate.tool.inputSchema,
        inputSchemaHash: candidate.tool.inputSchemaHash,
        ...(candidate.tool.outputSchemaHash ? { outputSchemaHash: candidate.tool.outputSchemaHash } : {}),
        ...(candidate.tool.inputArtifacts.length ? { inputArtifacts: candidate.tool.inputArtifacts } : {}),
        artifacts: candidate.tool.artifact,
        activation: {
          platform: 'linux' as const,
          sandbox: 'bubblewrap' as const,
          ...(candidate.server.hostRuntime ? {
            hostRuntime: {
              id: candidate.server.hostRuntime.id,
              bindingHash: candidate.server.hostRuntime.bindingHash,
            },
          } : {}),
        },
        limits: {
          initializeTimeoutMs: 10_000,
          listToolsTimeoutMs: 10_000,
          callTimeoutMs: 5 * 60 * 1_000,
          terminationGraceMs: 250,
          maxTransportBytes: 4 * 1024 * 1024,
          maxMessageBytes: 2 * 1024 * 1024,
          maxTextContentBytes: 64 * 1024,
        },
        mutating: candidate.tool.mutating,
        bindingHash: candidate.tool.capabilityBindingHash,
      },
      ...(skills ? { skills } : {}),
      approval: candidate.tool.approval,
    }
    return { capability: assertAgentCapabilitySnapshotV1({ ...unsigned, hash: sha256Canonical(unsigned) }) }
  } catch (error) {
    return {
      error: {
        code: error instanceof AgentSkillsManifestError ? 'AGENT_SKILL_INVALID' : 'MCP_AGENT_METADATA_INVALID',
        message: error instanceof AgentSkillsManifestError
          ? 'A declared MCP Agent skill file is invalid or changed during discovery.'
          : 'An MCP Agent capability snapshot is invalid and was excluded.',
        capabilityId: candidate.tool.capabilityId,
      },
    }
  }
}

export async function listAgentCapabilities(options: {
  builtinDir: string
  userExtensionsDir: string
  trustedRepos: Set<string>
  hostRuntimes?: AgentHostRuntimeRegistry
  mcpSandboxReady?: boolean | Readonly<Record<AgentMcpArtifactOutputContractV1['profile'], boolean>>
  mcpSandboxReadiness?: (profile: AgentMcpArtifactOutputContractV1['profile']) => Promise<boolean>
  processPythonSandboxReadiness?: () => Promise<boolean>
  processModelAccessReadiness?: (declaration: AgentProcessModelAccessDeclarationV1) => Promise<boolean>
  processPythonExecutable?: () => string | null | Promise<string | null>
}): Promise<AgentCapabilityInventoryResult> {
  const [result, mcpResult] = await Promise.all([
    listVisibleResolvedExtensionsDetailed(options, true),
    discoverGovernedMcpTools(options),
  ])
  const processPythonExecutable = options.processPythonExecutable
    ? await Promise.resolve(options.processPythonExecutable()).catch(() => null) ?? undefined
    : undefined
  const skillPathsByExtensionDir = new Map<string, Set<string>>()
  const recordSkillPath = (extensionDir: string, declaration: AgentSkillsDeclarationV1 | undefined): void => {
    if (!declaration) return
    const paths = skillPathsByExtensionDir.get(extensionDir) ?? new Set<string>()
    paths.add(declaration.file)
    skillPathsByExtensionDir.set(extensionDir, paths)
  }
  for (const resolved of result.extensions) {
    if (resolved.extension.type !== 'process') continue
    for (const node of resolved.extension.nodes) recordSkillPath(resolved.extDir, node.agent?.skills)
  }
  for (const candidate of mcpResult.tools) recordSkillPath(candidate.extensionDir, candidate.tool.skills)
  const overflowSkillExtensionDirs = new Set([...skillPathsByExtensionDir.entries()]
    .filter(([, paths]) => [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0).length > 4)
    .map(([extensionDir]) => extensionDir))
  const processResults = await Promise.all(result.extensions.flatMap((resolved) => {
    const extension = resolved.extension
    if (extension.type !== 'process') return []
    return extension.nodes.map(async (node) => buildAgentCapabilitySnapshot(
      extension, node, resolved.extDir, processPythonExecutable,
      overflowSkillExtensionDirs.has(resolved.extDir),
    ))
  }))
  const processFailures = processResults.flatMap((result) => result.error ? [result.error] : [])
  const discoveredProcessCandidates = processResults.flatMap((result) => result.capability ? [result.capability] : [])
  const hasPythonRuntime = discoveredProcessCandidates.some((candidate) => (
    candidate.execution?.kind === 'process' && candidate.execution.runtime !== undefined
  ))
  let pythonSandboxReady = !hasPythonRuntime
  if (hasPythonRuntime && options.processPythonSandboxReadiness) {
    pythonSandboxReady = await options.processPythonSandboxReadiness().then((ready) => ready === true).catch(() => false)
  }
  const modelAccessDeclaration = discoveredProcessCandidates.find((candidate) => (
    candidate.execution?.kind === 'process' && candidate.execution.modelAccess !== undefined
  ))?.execution
  const modelAccess = modelAccessDeclaration?.kind === 'process' ? modelAccessDeclaration.modelAccess : undefined
  let modelAccessReady = modelAccess === undefined
  if (modelAccess && options.processModelAccessReadiness) {
    modelAccessReady = await options.processModelAccessReadiness(modelAccess)
      .then((ready) => ready === true)
      .catch(() => false)
  }
  const processCandidates = discoveredProcessCandidates.filter((candidate) => (
    candidate.execution?.kind !== 'process'
      || ((candidate.execution.runtime === undefined || pythonSandboxReady)
        && (candidate.execution.modelAccess === undefined || modelAccessReady))
  ))
  const unavailablePythonCapabilities = pythonSandboxReady ? [] : discoveredProcessCandidates.flatMap((candidate) => (
    candidate.execution?.kind === 'process' && candidate.execution.runtime !== undefined ? [candidate.id] : []
  ))
  const unavailableModelAccessCapabilities = modelAccessReady ? [] : discoveredProcessCandidates.flatMap((candidate) => (
    candidate.execution?.kind === 'process' && candidate.execution.modelAccess !== undefined ? [candidate.id] : []
  ))
  const profileReadiness = new Map<AgentMcpArtifactOutputContractV1['profile'], boolean>()
  const readinessProbe = options.mcpSandboxReadiness
  if (readinessProbe) {
    const profiles = [...new Set(mcpResult.tools.map((candidate) => candidate.server.artifactOutput.profile))]
    await Promise.all(profiles.map(async (profile) => {
      const ready = await readinessProbe(profile).catch(() => false)
      profileReadiness.set(profile, ready === true)
    }))
  }
  const isMcpReady = (candidate: DiscoveredMcpTool): boolean => {
    if (readinessProbe) return profileReadiness.get(candidate.server.artifactOutput.profile) === true
    if (typeof options.mcpSandboxReady === 'object') {
      return options.mcpSandboxReady[candidate.server.artifactOutput.profile] === true
    }
    return options.mcpSandboxReady !== false
  }
  const readyMcpTools = mcpResult.tools.filter(isMcpReady)
  const mcpResults = await Promise.all(readyMcpTools.map(async (candidate) => (
    buildMcpAgentCapabilitySnapshot(
      candidate,
      overflowSkillExtensionDirs.has(candidate.extensionDir),
    )
  )))
  const mcpFailures = mcpResults.flatMap((result) => result.error ? [result.error] : [])
  const mcpCandidates = mcpResults.flatMap((result) => result.capability ? [result.capability] : [])
  const candidates = [...processCandidates, ...mcpCandidates]
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  const counts = new Map<string, number>()
  for (const resolved of result.extensions) {
    const extension = resolved.extension
    if (extension.type !== 'process') continue
    for (const node of extension.nodes) {
      const id = `${extension.id}/${node.id}`
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  for (const candidate of readyMcpTools) {
    counts.set(candidate.tool.capabilityId, (counts.get(candidate.tool.capabilityId) ?? 0) + 1)
  }
  const collisionIds = [...counts.entries()]
    .filter(([id, count]) => count > 1 && candidateIds.has(id))
    .map(([id]) => id)
    .sort()
  const collisionIdSet = new Set(collisionIds)
  const capabilities = candidates
    .filter((candidate) => !collisionIdSet.has(candidate.id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  return {
    capabilities,
    errors: [
      ...result.errors.map(({ code }) => ({
        code,
        message: code === 'AGENT_MANIFEST_INVALID'
          ? 'An extension manifest failed strict Agent validation; only its Agent declarations were excluded.'
          : code === 'PROCESS_DISCOVERY_MANIFEST_INVALID'
          ? 'An extension manifest is invalid and was excluded from Agent discovery.'
          : 'Agent capability discovery could not inspect one or more extensions.',
      })),
      ...processFailures,
      ...mcpFailures,
      ...unavailablePythonCapabilities.map((capabilityId) => ({
        code: 'PROCESS_PYTHON_SANDBOX_UNAVAILABLE',
        message: 'An extension Python Agent capability is unavailable because its production sandbox readiness probe failed.',
        capabilityId,
      })),
      ...unavailableModelAccessCapabilities.map((capabilityId) => ({
        code: 'PROCESS_MODEL_ACCESS_UNAVAILABLE',
        message: 'An Agent process model-access capability is unavailable because its production provider readiness probe failed.',
        capabilityId,
      })),
      ...mcpResult.errors.map((error) => ({
        code: error.code,
        message: error.message,
        ...(error.capabilityId ? { capabilityId: error.capabilityId } : {}),
      })),
      ...(readyMcpTools.length < mcpResult.tools.length ? [{
        code: 'MCP_SANDBOX_UNAVAILABLE',
        message: 'MCP Agent capabilities are unavailable because the production sandbox readiness probe failed.',
      }] : []),
      ...collisionIds.map((capabilityId) => ({
        code: 'AGENT_CAPABILITY_ID_COLLISION',
        message: 'An ambiguous Agent capability identifier was excluded from discovery.',
        capabilityId,
      })),
    ],
  }
}

export type GovernedAgentProcessTarget = Readonly<{
  capability: AgentCapabilitySnapshotV1
  extensionDir: string
  entry: string
}>

export async function resolveGovernedAgentProcessTarget(
  options: {
    builtinDir: string
    userExtensionsDir: string
    trustedRepos: Set<string>
    processPythonExecutable?: () => string | null | Promise<string | null>
  },
  capabilityId: string,
): Promise<GovernedAgentProcessTarget> {
  const result = await listVisibleResolvedExtensionsDetailed(options, true)
  const matches: GovernedAgentProcessTarget[] = []
  const processPythonExecutable = options.processPythonExecutable
    ? await Promise.resolve(options.processPythonExecutable()).catch(() => null) ?? undefined
    : undefined
  for (const resolved of result.extensions) {
    if (resolved.extension.type !== 'process') continue
    for (const node of resolved.extension.nodes) {
      if (`${resolved.extension.id}/${node.id}` !== capabilityId) continue
      const capability = await buildAgentCapabilitySnapshot(
        resolved.extension, node, resolved.extDir, processPythonExecutable,
      )
      if (capability.capability?.execution?.kind === 'process') {
        matches.push({ capability: capability.capability, extensionDir: resolved.extDir, entry: resolved.extension.entry })
      }
    }
  }
  if (matches.length !== 1) {
    throw new AgentProcessManifestError('runtime_stale', 'Governed process capability is missing or ambiguous')
  }
  return matches[0]
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
