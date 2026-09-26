import axios from 'axios'
import { join, resolve as resolvePath } from 'path'
import { readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { SCENE_IMPORT_MESH_ALLOWED_EXTENSIONS } from './scene-import-service.ts'
import { ARTIFACT_KINDS, type ArtifactKind } from '../../src/shared/types/artifacts.ts'
import { normalizeHfDownloads, type HfDownloadDescriptor } from './hf-download-manifest.ts'
import {
  normalizeModelSources,
  normalizeWeightGroupReferences,
  normalizeWeightGroups,
  validateModelNodeIds,
  type ModelSource,
} from './model-sources.ts'
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
  type BoundAgentSkillSetV1,
  normalizeAgentSkillsDeclaration,
} from './agent-skills-manifest.ts'
import { parseStrictJson } from './strict-json.ts'

const MAX_EXTENSION_MANIFEST_BYTES = 512 * 1_024
const MAX_EXTENSION_MANIFEST_DEPTH = 64
const MAX_EXTENSION_MANIFEST_PROPERTIES = 10_000
const MAX_EXTENSION_MANIFEST_ARRAY = 5_000

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
      substitution: { supported: true, artifactKinds: ['image', 'text', 'mesh', 'scene', 'capture', 'audio', 'video'], boundary: 'ui_only', headless: false },
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
  mcp?: unknown
  weight_groups?: unknown
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
    model_sources?: unknown
    download_check?: string
    hf_skip_prefixes?: string[]
    hf_include_prefixes?: string[]
    weight_owner_id?: string
    weight_groups?: unknown
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
  hasModelSources?: boolean
  modelSources?: ModelSource[]
  downloadCheck?: string
  hfSkipPrefixes?: string[]
  hfIncludePrefixes?: string[]
  capabilityId?: string
  bundleId?: string
  weightOwnerId?: string
  processOwnerId?: string
  sharedOwner?: boolean
  legacyPaths?: string[]
  automation?: CapabilityAutomationMetadata
  agent?: AgentCapabilityDeclarationV1
  agentError?: AgentCapabilityDeclarationError
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

const LEGACY_PROCESS_ARTIFACT_KINDS = [
  'image', 'text', 'mesh', 'scene', 'capture', 'audio', 'video',
] as const satisfies readonly ArtifactKind[]
const CAPABILITY_ARTIFACT_KINDS = new Set<ArtifactKind>(LEGACY_PROCESS_ARTIFACT_KINDS)
const GOVERNED_AGENT_ARTIFACT_KINDS = new Set<ArtifactKind>(ARTIFACT_KINDS)
const AGENT_ONLY_ARTIFACT_KINDS = new Set<ArtifactKind>(
  ARTIFACT_KINDS.filter((kind) => !CAPABILITY_ARTIFACT_KINDS.has(kind)),
)
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

export function projectAgentOnlyNodesForLegacy(manifest: ParsedManifest): ParsedManifest {
  if (!Array.isArray(manifest.nodes)) return manifest
  const nodes = manifest.nodes.filter((node) => {
    if (!isPlainOwnRecord(node) || !Object.hasOwn(node, 'agent')) return true
    return !AGENT_ONLY_ARTIFACT_KINDS.has(node.input as ArtifactKind)
      && !AGENT_ONLY_ARTIFACT_KINDS.has(node.output as ArtifactKind)
  })
  return nodes.length === manifest.nodes.length ? manifest : { ...manifest, nodes }
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

function isProcessPortType(value: unknown, governedAgentKinds = false): value is ProcessPortType {
  const kinds = governedAgentKinds ? GOVERNED_AGENT_ARTIFACT_KINDS : CAPABILITY_ARTIFACT_KINDS
  return typeof value === 'string' && kinds.has(value as ArtifactKind)
}

function normalizeLegacyArtifactKind(value: unknown): unknown {
  return value
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

function normalizeInputContract(
  inputContract: LegacyProcessPortContract[] | undefined,
  context: string,
): LegacyProcessPortContract[] | undefined {
  if (inputContract === undefined) return undefined
  if (!Array.isArray(inputContract)) {
    throw new Error(`${context}.input_contract must be an array`)
  }

  return inputContract.map((contract, index) => {
    if (!isPlainOwnRecord(contract)) {
      throw new Error(`${context}.input_contract[${index}] must be an object`)
    }

    const record = contract as LegacyProcessPortContract
    if (record.name !== undefined && (typeof record.name !== 'string' || !record.name.trim())) {
      throw new Error(`${context}.input_contract[${index}].name must be a non-empty string`)
    }
    if (record.id !== undefined && (typeof record.id !== 'string' || !record.id.trim())) {
      throw new Error(`${context}.input_contract[${index}].id must be a non-empty string`)
    }
    if (record.label !== undefined && typeof record.label !== 'string') {
      throw new Error(`${context}.input_contract[${index}].label must be a string`)
    }
    if (record.type !== undefined && (typeof record.type !== 'string' || !record.type.trim())) {
      throw new Error(`${context}.input_contract[${index}].type must be a non-empty string`)
    }
    if (record.required !== undefined && typeof record.required !== 'boolean') {
      throw new Error(`${context}.input_contract[${index}].required must be a boolean`)
    }
    return record
  })
}

function suppliedPortName(
  input: Record<string, unknown>,
  context: string,
  index: number,
): string {
  const name = input.name !== undefined ? input.name : input.id
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`${context}[${index}].name must be a non-empty string`)
  }
  return name.trim()
}

function contractPortName(contract: LegacyProcessPortContract | undefined): string | undefined {
  const name = contract?.name ?? contract?.id
  return name === undefined ? undefined : name.trim()
}

function allocateLegacyPortName(baseName: string, usedNames: Set<string>): string {
  // Legacy strings retain their type name when it is available. Repeated or
  // explicitly-colliding names receive _2, _3, ... in declaration order so
  // positional slot identity is retained without renaming supplied names.
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName)
    return baseName
  }

  let suffix = 2
  let candidate = `${baseName}_${suffix}`
  while (usedNames.has(candidate)) {
    suffix += 1
    candidate = `${baseName}_${suffix}`
  }
  usedNames.add(candidate)
  return candidate
}

function normalizeLegacyProcessPort(
  inputType: ProcessPortType,
  contract: LegacyProcessPortContract | undefined,
  name: string,
): ProcessPort {
  const normalizedContractType = normalizeLegacyArtifactKind(contract?.type)
  const contractType = typeof normalizedContractType === 'string' && normalizedContractType.trim().length > 0
    ? normalizedContractType
    : undefined
  const type = contractType ?? inputType
  const fallbackLabel = contract?.label?.trim()

  return {
    name,
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

  const normalizedContract = normalizeInputContract(inputContract, context)
  const explicitNames: Array<{ name: string }> = []
  for (const [index, input] of inputs.entries()) {
    if (typeof input === 'string') {
      const contractName = contractPortName(normalizedContract?.[index])
      if (contractName !== undefined) explicitNames.push({ name: contractName })
      continue
    }
    if (!isPlainOwnRecord(input)) {
      throw new Error(`${context}[${index}] must be a string or object`)
    }
    explicitNames.push({ name: suppliedPortName(input, context, index) })
  }
  assertUniquePortNames(explicitNames, `${context}.explicit`)
  const usedNames = new Set(explicitNames.map((port) => port.name))

  const ports = inputs
    .map((input, index) => {
      if (typeof input === 'string') {
        const normalizedInput = normalizeLegacyArtifactKind(input)
        if (typeof normalizedInput !== 'string' || normalizedInput.trim().length === 0) {
          throw new Error(`${context}[${index}] must be a non-empty string`)
        }
        const contract = normalizedContract?.[index]
        const name = contractPortName(contract)
          ?? allocateLegacyPortName(String(normalizedInput), usedNames)
        return normalizeLegacyProcessPort(normalizedInput, contract, name)
      }

      if (!isPlainOwnRecord(input)) {
        throw new Error(`${context}[${index}] must be a string or object`)
      }

      const normalizedType = normalizeLegacyArtifactKind(input.type)
      if (typeof normalizedType !== 'string' || normalizedType.trim().length === 0) {
        throw new Error(`${context}[${index}].type must be a non-empty string`)
      }
      if (input.label !== undefined && typeof input.label !== 'string') {
        throw new Error(`${context}[${index}].label must be a string`)
      }
      if (input.required !== undefined && typeof input.required !== 'boolean') {
        throw new Error(`${context}[${index}].required must be a boolean`)
      }

      const base = {
        name: suppliedPortName(input, context, index),
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
  governedAgentKinds = false,
): ModelInputKind {
  const normalizedValue = normalizeLegacyArtifactKind(value)

  if (normalizedValue !== undefined
    && normalizedValue !== 'none'
    && !isProcessPortType(normalizedValue, governedAgentKinds)) {
    throw new Error(
      `${context} must be one of: ${[
        ...(governedAgentKinds ? ARTIFACT_KINDS : LEGACY_PROCESS_ARTIFACT_KINDS),
        'none',
      ].join(', ')}`,
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
  options: { governedAgentKinds?: boolean } = {},
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
  const weightGroups = normalizeWeightGroups(parsed)
  if (weightGroups || (parsed.nodes ?? []).some((node) => node.model_sources !== undefined || node.weight_groups !== undefined)) {
    validateModelNodeIds(parsed.nodes ?? [])
  }

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
    const governedAgentKinds = options.governedAgentKinds === true
    const declaredOutput = isProcessPortType(normalizeLegacyArtifactKind(node.output), governedAgentKinds)
      ? normalizeLegacyArtifactKind(node.output) as ArtifactKind
      : 'mesh' as const
    const normalizedInputs = normalizeProcessPorts(
      node.inputs,
      node.input_contract,
      `${capabilityId}.inputs`,
      extensionType === 'process',
    )
    const legacyPaths = [...(legacyPathsByOwner.get(weightOwnerId) ?? [capabilityId])]
    const modelSources = normalizeModelSources(node)
    const groupRefs = normalizeWeightGroupReferences(
      node,
      weightGroups,
      `nodes[${node.id}].weight_groups`,
    ) ?? []
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
      modelSources
      || groupRefs.length > 0
      || httpsDownloads
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
    const agentResult = extensionType === 'process'
      && isProcessPortType(node.input, true)
      && isProcessPortType(node.output, true)
      ? normalizeAgentCapabilityDeclarationResult(node.agent, capabilityId, parsed.entry ?? 'processor.js')
      : {}

    return {
      id: node.id,
      name: node.name ?? node.id,
      input: normalizeExtensionNodeInput(
        node.input,
        extensionType,
        capabilityId + '.input',
        governedAgentKinds,
      ),
      output: declaredOutput,
      ...(normalizedInputs ? { inputs: normalizedInputs } : {}),
      ...(processOwnerId ? { processOwnerId } : {}),
      paramsSchema: node.params_schema ?? [],
      hfRepo: node.hf_repo,
      ...(hfDownloads ? { hfDownloads } : {}),
      ...(httpsDownloads ? { httpsDownloads } : {}),
      ...(modelSources || groupRefs.length > 0 ? { hasModelSources: true, modelSources: modelSources ?? [] } : {}),
      downloadCheck: node.download_check,
      hfSkipPrefixes: node.hf_skip_prefixes,
      ...(node.hf_include_prefixes ? { hfIncludePrefixes: node.hf_include_prefixes } : {}),
      ...automationMetadata,
      ...(agentResult.declaration ? { agent: agentResult.declaration } : {}),
      ...(agentResult.error ? { agentError: agentResult.error } : {}),
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

async function readExtensionManifestDetailed(
  dir: string,
  extensionDirName: string,
  validateAgentJson = false,
): Promise<{ manifest: ParsedManifest | null; manifestFile: string | null; errors: AutomationCapabilityError[] }> {
  const errors: AutomationCapabilityError[] = []

  for (const manifestFile of ['manifest.json', 'package.json']) {
    const manifestPath = join(dir, extensionDirName, manifestFile)
    if (!existsSync(manifestPath)) continue

    try {
      const bytes = await readFile(manifestPath)
      const manifest = JSON.parse(bytes.toString('utf-8')) as ParsedManifest
      if (!validateAgentJson) return { manifest, manifestFile, errors }
      try {
        validateStrictAgentManifest(bytes)
        return { manifest, manifestFile, errors }
      } catch (error) {
        return {
          manifest: stripAgentDeclarations(manifest),
          manifestFile,
          errors: [...errors, buildAgentManifestInvalidError(extensionDirName, manifestFile, error)],
        }
      }
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
          return parseExtensionManifest(
            projectAgentOnlyNodesForLegacy(manifest), entry.name, trustedRepos, isBuiltin,
          )
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
            extension: parseExtensionManifest(
              projectAgentOnlyNodesForLegacy(manifest), entry.name, trustedRepos, isBuiltin,
            ),
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
  validateAgentJson = false,
): Promise<{ extensions: ResolvedListedExtension[]; errors: AutomationCapabilityError[] }> {
  if (!existsSync(dir)) return { extensions: [], errors: [] }

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory())
    const results = await Promise.all(
      directories.map(async (entry) => {
        const fallback = normalizeListedExtensionFallback(entry.name, isBuiltin)

        const { manifest, manifestFile, errors } = await readExtensionManifestDetailed(
          dir,
          entry.name,
          validateAgentJson,
        )
        let extension: ListedExtension = fallback
        let resolvedManifest: ParsedManifest | null = manifest

        if (manifest) {
          try {
            const listingManifest = validateAgentJson ? manifest : projectAgentOnlyNodesForLegacy(manifest)
            extension = parseExtensionManifest(listingManifest, entry.name, trustedRepos, isBuiltin, {
              governedAgentKinds: validateAgentJson,
            })
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

async function buildAgentCapabilitySnapshot(
  extension: ListedProcessExtension,
  node: ListedExtensionNode<ArtifactKind>,
  extensionDir: string,
  processPythonExecutable?: string,
  skillFileLimitExceeded = false,
): Promise<{
  capability?: AgentCapabilitySnapshotV1
  skillBinding?: BoundAgentSkillSetV1
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
    const inputs = node.inputs?.map((input) => ({ ...input }))
    const execution = await bindAgentProcessExecution(
      extensionDir, extension.entry, node.agent.process, processPythonExecutable,
    )
    if (!execution.artifacts.allowed.some((artifact) => artifact.kind === node.output)) {
      throw new AgentProcessManifestError(
        'invalid_metadata',
        'Agent process primary node output must be declared in its allowed artifact kinds',
      )
    }
    const outputKinds = [
      node.output,
      ...execution.artifacts.allowed.flatMap((artifact) => (
        artifact.kind === node.output ? [] : [artifact.kind]
      )),
    ]
    const skillBinding = node.agent.skills
      ? await bindAgentSkillSet(extensionDir, node.agent.skills)
      : undefined
    const skills = skillBinding?.publicSnapshot
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
        outputs: outputKinds,
        ...(inputs ? { inputs } : {}),
        paramsSchema,
      },
      execution,
      ...(skills ? { skills } : {}),
      approval: { ...node.agent.approval },
    }
    return {
      capability: assertAgentCapabilitySnapshotV1({ ...unsigned, hash: sha256Canonical(unsigned) }),
      ...(skillBinding ? { skillBinding } : {}),
    }
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
  skillBinding?: BoundAgentSkillSetV1
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
    const skillBinding = candidate.tool.skills
      ? await bindAgentSkillSet(candidate.extensionDir, candidate.tool.skills)
      : undefined
    const skills = skillBinding?.publicSnapshot
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
    return {
      capability: assertAgentCapabilitySnapshotV1({ ...unsigned, hash: sha256Canonical(unsigned) }),
      ...(skillBinding ? { skillBinding } : {}),
    }
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
  skillBindingSink?: (binding: Readonly<{
    capability: AgentCapabilitySnapshotV1
    extensionDir: string
    bound: BoundAgentSkillSetV1
  }>) => void
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
    return extension.nodes.map(async (node) => ({
      ...await buildAgentCapabilitySnapshot(
        extension, node, resolved.extDir, processPythonExecutable,
        overflowSkillExtensionDirs.has(resolved.extDir),
      ),
      extensionDir: resolved.extDir,
    }))
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
  const mcpResults = await Promise.all(readyMcpTools.map(async (candidate) => ({
    ...await buildMcpAgentCapabilitySnapshot(
      candidate,
      overflowSkillExtensionDirs.has(candidate.extensionDir),
    ),
    extensionDir: candidate.extensionDir,
  })))
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
  if (options.skillBindingSink) {
    const finalHashes = new Map(capabilities.map((capability) => [capability.id, capability.hash]))
    for (const result of [...processResults, ...mcpResults]
      .filter((candidate) => candidate.capability && candidate.skillBinding)
      .sort((left, right) => (left.capability!.id < right.capability!.id ? -1 : left.capability!.id > right.capability!.id ? 1 : 0))) {
      if (finalHashes.get(result.capability!.id) !== result.capability!.hash) continue
      options.skillBindingSink({
        capability: result.capability!,
        extensionDir: result.extensionDir,
        bound: result.skillBinding!,
      })
    }
  }
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
