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
    input: string
    output: ArtifactKind
    inputs?: Array<{
      name: string
      label?: string
      type: string
      required?: boolean
      multiple?: true
      min_items?: number
      max_items?: number
      ordered?: true
    }>
    paramsSchema: JsonValue[]
  }
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
  capability: Pick<AgentCapabilitySnapshotV1, 'id' | 'displayName' | 'description' | 'hash'>
  model: Pick<AgentOllamaModelSnapshotV1, 'provider' | 'model' | 'digest'>
  approval: AgentActionApprovalV1
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
