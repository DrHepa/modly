import type { ArtifactKind } from './artifacts.ts'

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const AGENT_ACTION_STATUSES = [
  'proposed',
  'approved',
  'rejected',
  'expired',
  'executing',
  'completed',
  'failed',
  'cancelled',
] as const

export type AgentActionStatus = typeof AGENT_ACTION_STATUSES[number]
export type AgentApprovalScope = 'single_action'

export interface AgentApprovalPolicyV1 {
  required: true
  scope: AgentApprovalScope
}

export interface AgentCapabilityDeclarationV1 {
  schema: 'modly.agent-capability-declaration.v1'
  capability_id: string
  display_name: string
  description: string
  approval: AgentApprovalPolicyV1
  process: AgentProcessDeclarationV1
}

export interface AgentProcessArtifactPolicyV1 {
  kind: ArtifactKind
  mediaTypes: string[]
  maxBytes: number
}

export interface AgentProcessArtifactContractV1 {
  maxCount: number
  maxTotalBytes: number
  allowed: AgentProcessArtifactPolicyV1[]
}

export interface AgentProcessPythonRuntimeDeclarationV1 {
  kind: 'extension-python-venv-v1'
  interpreter: 'bin/python'
}

export interface AgentProcessPythonBaseInterpreterIdentityV1 {
  device: string
  inode: string
  uid: number
  gid: number
  mode: number
  size: number
  nlink: number
  mtimeNs: string
  ctimeNs: string
  sha256: string
}

export interface AgentProcessPythonRuntimeBindingV1 extends AgentProcessPythonRuntimeDeclarationV1 {
  baseInterpreter: AgentProcessPythonBaseInterpreterIdentityV1
  treeDigest: string
  sourceIdentityHash: string
  entryCount: number
  logicalBytes: number
  bindingHash: string
}

export interface AgentProcessDeclarationV1 {
  schema: 'modly.agent-process.v1'
  runtimeFiles: string[]
  resourceFiles: string[]
  runtime?: AgentProcessPythonRuntimeDeclarationV1
  artifacts: AgentProcessArtifactContractV1
}

export interface AgentProcessRuntimeFileIdentityV1 {
  path: string
  device: string
  inode: string
  uid: number
  gid: number
  mode: number
  size: number
  mtimeNs: string
  sha256: string
}

export interface AgentProcessExecutionV1 {
  kind: 'process'
  schema: 'modly.agent-process-execution.v1'
  entry: string
  runtimeFiles: AgentProcessRuntimeFileIdentityV1[]
  resourceFiles: AgentProcessRuntimeFileIdentityV1[]
  runtime?: AgentProcessPythonRuntimeBindingV1
  runtimeHash: string
  artifacts: AgentProcessArtifactContractV1
  bindingHash: string
}

export interface AgentMcpToolExecutionV1 {
  kind: 'mcp_tool'
  inputSchema: JsonValue
  inputSchemaHash: string
  outputSchemaHash?: string
  inputArtifacts?: AgentMcpInputArtifactBindingV1[]
  artifacts?: AgentMcpArtifactOutputContractV1
  activation?: AgentMcpActivationContractV1
  limits?: AgentMcpResourceLimitsV1
  mutating: boolean
  bindingHash: string
}

export interface AgentMcpInputArtifactBindingV1 {
  argument: string
  kind: ArtifactKind
  mediaTypes: string[]
  sandboxPath: `/input/${number}`
}

export interface AgentMcpArtifactPolicyV1 {
  path?: string
  kind: ArtifactKind
  mediaTypes: string[]
  maxBytes: number
  required?: true
}

export interface AgentMcpArtifactOutputContractV1 {
  profile: 'artifact-v1' | 'relative-files-v1'
  maxCount: number
  maxArtifactBytes: number
  maxTotalBytes: number
  allowed: AgentMcpArtifactPolicyV1[]
}

export interface AgentMcpActivationContractV1 {
  platform: 'linux'
  sandbox: 'bubblewrap'
  hostRuntime?: { id: string, bindingHash: string }
}

export interface AgentMcpResourceLimitsV1 {
  initializeTimeoutMs: number
  listToolsTimeoutMs: number
  callTimeoutMs: number
  terminationGraceMs: number
  maxTransportBytes: number
  maxMessageBytes: number
  maxTextContentBytes: number
}

export interface AgentCapabilitySnapshotV1 {
  schema: 'modly.agent-capability.v1'
  version: 1
  id: string
  displayName: string
  description: string
  extension: {
    id: string
    name: string
    version?: string
  }
  node: {
    id: string
    input: ArtifactKind
    output: ArtifactKind
    outputs?: ArtifactKind[]
    inputs?: Array<{
      name: string
      label?: string
      type: ArtifactKind
      required?: boolean
      multiple?: true
      min_items?: number
      max_items?: number
      ordered?: true
    }>
    paramsSchema: JsonValue[]
  }
  execution?: AgentMcpToolExecutionV1 | AgentProcessExecutionV1
  approval: AgentApprovalPolicyV1
  hash: string
}

export interface ArtifactRefV1 {
  schema: 'modly.artifact-ref.v1'
  version: 1
  id: string
  kind: ArtifactKind
  mediaType: string
  workspacePath: string
  sha256: string
  sizeBytes: number
}

export interface AgentOllamaModelSnapshotV1 {
  provider: 'ollama'
  endpoint: string
  model: string
  digest: string
}

export interface AgentOllamaModelSelectionV1 {
  provider: 'ollama'
  endpoint: string
  model: string
}

export interface AgentActionApprovalV1 {
  scope: AgentApprovalScope
  expiresAt: string
}

export interface AgentActionEventV1 {
  sequence: number
  status: AgentActionStatus
  at: string
  previousStateHash: string | null
  outputArtifactsHash: string
  errorSummaryHash: string
  stateHash: string
}

export interface AgentActionV1 {
  schema: 'modly.agent-action.v1'
  version: 1
  id: string
  status: AgentActionStatus
  createdAt: string
  updatedAt: string
  capability: AgentCapabilitySnapshotV1
  arguments: JsonValue
  argumentsHash: string
  model: AgentOllamaModelSnapshotV1
  modelHash: string
  inputArtifacts: ArtifactRefV1[]
  outputArtifacts: ArtifactRefV1[]
  approval: AgentActionApprovalV1
  proposalHash: string
  stateHash: string
  history: AgentActionEventV1[]
  errorSummary?: string
}

export interface AgentActionPublicSummaryV1 {
  schema: 'modly.agent-action-summary.v1'
  version: 1
  id: string
  status: AgentActionStatus
  createdAt: string
  updatedAt: string
  capability: Pick<AgentCapabilitySnapshotV1, 'id' | 'displayName' | 'description' | 'hash'> & {
    risk: 'read_only' | 'mutating'
  }
  model: Pick<AgentOllamaModelSnapshotV1, 'provider' | 'model' | 'digest'>
  approval: AgentActionApprovalV1
  preview: Array<{ label: string, value: string }>
  inputs: Array<Pick<ArtifactRefV1, 'id' | 'kind' | 'mediaType' | 'sha256' | 'sizeBytes'>>
  outputs: Array<Pick<ArtifactRefV1, 'id' | 'kind' | 'mediaType' | 'sha256' | 'sizeBytes'>>
}

export interface AgentCapabilityInventoryError {
  code: string
  message: string
  capabilityId?: string
}

export interface AgentCapabilityInventoryResult {
  capabilities: AgentCapabilitySnapshotV1[]
  errors: AgentCapabilityInventoryError[]
}

export interface AgentCapabilitiesApi {
  list(): Promise<AgentCapabilityInventoryResult>
}

export type AgentActionDecision = 'approve' | 'reject'

export type AgentActionPublicErrorCode =
  | 'invalid_request'
  | 'invalid_arguments'
  | 'action_not_found'
  | 'capability_not_found'
  | 'capability_stale'
  | 'model_stale'
  | 'artifact_not_found'
  | 'approval_expired'
  | 'invalid_state'
  | 'executor_unavailable'
  | 'sandbox_unavailable'
  | 'execution_failed'
  | 'artifact_too_large'
  | 'cancellation_pending'
  | 'invalid_artifact'
  | 'capacity_exceeded'
  | 'internal_error'

export interface AgentActionProposeRequest {
  originSessionId: string
  capabilityId: string
  capabilityHash: string
  arguments: JsonValue
  modelLeaseId: string
}

export interface AgentActionResolvedProposeRequest {
  originSessionId: string
  capabilityId: string
  capabilityHash: string
  arguments: JsonValue
  model: AgentOllamaModelSnapshotV1
}

export interface AgentModelLeaseRequest {
  originSessionId: string
  model: AgentOllamaModelSelectionV1
}

export interface AgentModelLeaseV1 {
  id: string
  expiresAt: string
}

export interface AgentActionIdRequest {
  actionId: string
}

export interface AgentActionSessionRequest {
  originSessionId: string
}

export interface AgentActionSessionGetRequest extends AgentActionIdRequest, AgentActionSessionRequest {}

export interface AgentActionDecisionRequest extends AgentActionSessionGetRequest {
  decision: AgentActionDecision
}

export type AgentActionMutationResult =
  | { ok: true, action: AgentActionPublicSummaryV1 }
  | { ok: false, error: { code: AgentActionPublicErrorCode } }

export type AgentActionListResult =
  | { ok: true, actions: AgentActionPublicSummaryV1[] }
  | { ok: false, error: { code: AgentActionPublicErrorCode } }

export type AgentModelLeaseResult =
  | { ok: true, lease: AgentModelLeaseV1 }
  | { ok: false, error: { code: AgentActionPublicErrorCode } }

export interface AgentActionsApi {
  leaseModel(request: AgentModelLeaseRequest): Promise<AgentModelLeaseResult>
  propose(request: AgentActionProposeRequest): Promise<AgentActionMutationResult>
  get(request: AgentActionSessionGetRequest): Promise<AgentActionMutationResult>
  list(request: AgentActionSessionRequest): Promise<AgentActionListResult>
  decide(request: AgentActionDecisionRequest): Promise<AgentActionMutationResult>
  execute(request: AgentActionSessionGetRequest): Promise<AgentActionMutationResult>
  cancel(request: AgentActionSessionGetRequest): Promise<AgentActionMutationResult>
}
