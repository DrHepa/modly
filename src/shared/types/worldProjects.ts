import type { WorldCommandBatchV1, WorldCommandInverse } from '../../areas/worlds/core/worldCommands.ts'
import type { WorldProjectSnapshotV1 } from '../../areas/worlds/core/worldModel.ts'
import type { WorldAiContext, WorldAiProposal, WorldAiPropertyDiff } from '../../areas/worlds/core/worldAiContract.ts'

export const WORLD_PROJECT_CHANNELS = Object.freeze({
  create: 'workspace:worlds:projects:create',
  list: 'workspace:worlds:projects:list',
  open: 'workspace:worlds:projects:open',
  previewCommands: 'workspace:worlds:projects:previewCommands',
  applyCommands: 'workspace:worlds:projects:applyCommands',
  previewAi: 'workspace:worlds:projects:previewAi',
  discardAi: 'workspace:worlds:projects:discardAi',
  delete: 'workspace:worlds:projects:delete',
} as const)

export const WORLD_PROJECT_PUBLIC_ERROR_CODES = Object.freeze([
  'invalid_request',
  'project_not_found',
  'revision_conflict',
  'transaction_reuse',
  'unsafe_workspace',
  'invalid_document',
  'unsupported_schema',
  'project_busy',
  'recovery_failed',
  'write_failed',
  'unauthorized',
  'internal_error',
] as const)

export type WorldProjectPublicErrorCode = typeof WORLD_PROJECT_PUBLIC_ERROR_CODES[number]

export interface WorldProjectPublicIssue {
  code: string
  path: string
  message: string
}

export interface WorldProjectPublicError {
  code: WorldProjectPublicErrorCode
  message: string
  retryable: boolean
  issues?: WorldProjectPublicIssue[]
}

export type WorldProjectResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorldProjectPublicError }

export interface WorldProjectCreateRequest {
  name: string
  initialSceneName: string
  projectId?: string
  initialSceneId?: string
}

export interface WorldProjectKeyRequest {
  projectKey: string
}

export interface WorldProjectCommandRequest extends WorldProjectKeyRequest {
  batch: WorldCommandBatchV1
  aiAuthority?: { token: string; context: WorldAiContext }
}

export interface WorldProjectAiPreviewRequest { proposal: WorldAiProposal }
export interface WorldProjectAiPreviewSuccess {
  batch: WorldCommandBatchV1
  result: WorldProjectCommandSuccess
  details: WorldAiPropertyDiff[]
  authority: string
}
export interface WorldProjectAiDiscardRequest { context: WorldAiContext; authority: string }
export type WorldProjectAiPreviewResult = WorldProjectResult<WorldProjectAiPreviewSuccess>

export interface WorldProjectDeleteRequest extends WorldProjectKeyRequest {
  expectedRevision: number
  transactionId: string
}

export interface WorldProjectCreateSuccess {
  projectKey: string
  snapshot: WorldProjectSnapshotV1
  durabilityWarnings: string[]
}

export type WorldProjectCreateResult = WorldProjectResult<WorldProjectCreateSuccess>

export type WorldProjectDiscoveryStatus =
  | 'ready'
  | 'unsupported'
  | 'corrupt'
  | 'needs-recovery'
  | 'duplicate-project-id'

export interface WorldProjectReadySummary {
  projectKey: string
  status: 'ready' | 'duplicate-project-id'
  projectId: string
  name: string
  revision: number
}

export interface WorldProjectUnsupportedSummary {
  projectKey: string
  status: 'unsupported'
  schema: string
}

export interface WorldProjectCorruptSummary {
  projectKey: string
  status: 'corrupt'
}

export interface WorldProjectRecoverySummary {
  projectKey: string
  status: 'needs-recovery'
}

export type WorldProjectSummary =
  | WorldProjectReadySummary
  | WorldProjectUnsupportedSummary
  | WorldProjectCorruptSummary
  | WorldProjectRecoverySummary

export type WorldProjectDiscoveryIssue = {
  projectKey: string
  status: 'unsupported'
  code: 'unsupported_schema'
} | {
  projectKey: string
  status: 'corrupt'
  code: 'corrupt_project'
} | {
  projectKey: string
  status: 'duplicate-project-id'
  code: 'duplicate_project_id'
} | {
  projectKey: string
  status: 'needs-recovery'
  code: 'recovery_required'
}

export interface WorldProjectListSuccess {
  projects: WorldProjectSummary[]
  issues: WorldProjectDiscoveryIssue[]
}

export type WorldProjectListResult = WorldProjectResult<WorldProjectListSuccess>

export interface WorldProjectOpenSuccess {
  status: 'ready'
  projectKey: string
  snapshot: WorldProjectSnapshotV1
  durabilityWarnings: string[]
}

export interface WorldProjectUnsupportedOpenSuccess {
  status: 'unsupported'
  projectKey: string
  schema: string
  readOnly: true
}

export type WorldProjectOpenResult = WorldProjectResult<
  WorldProjectOpenSuccess | WorldProjectUnsupportedOpenSuccess
>

export interface WorldProjectTransactionReceipt {
  transactionId: string
  payloadSha256: string
  resultSha256: string
  appliedRevision: number
}

export interface WorldProjectCommandSuccess {
  projectKey: string
  snapshot: WorldProjectSnapshotV1
  newRevision: number
  idempotent: boolean
  changes: string[]
  warnings: string[]
  inverse: WorldCommandInverse
  receipt: WorldProjectTransactionReceipt
}

export type WorldProjectCommandResult = WorldProjectResult<WorldProjectCommandSuccess>

export interface WorldProjectDeleteSuccess {
  projectKey: string
  transactionId: string
  idempotent: boolean
}

export type WorldProjectDeleteResult = WorldProjectResult<WorldProjectDeleteSuccess>

export interface WorldProjectsApi {
  previewAi?(request: WorldProjectAiPreviewRequest): Promise<WorldProjectAiPreviewResult>
  discardAi?(request: WorldProjectAiDiscardRequest): Promise<WorldProjectResult<{ discarded: true }>>
  create(request: WorldProjectCreateRequest): Promise<WorldProjectCreateResult>
  list(): Promise<WorldProjectListResult>
  open(request: WorldProjectKeyRequest): Promise<WorldProjectOpenResult>
  previewCommands(request: WorldProjectCommandRequest): Promise<WorldProjectCommandResult>
  applyCommands(request: WorldProjectCommandRequest): Promise<WorldProjectCommandResult>
  delete(request: WorldProjectDeleteRequest): Promise<WorldProjectDeleteResult>
}

export type WorldsCliControlResult = { ok: true } | { ok: false; code: 'UNAUTHORIZED' | 'INVALID_REQUEST' | 'UNAVAILABLE' }
export interface WorldsCliStatus {
  running: boolean
  paired: boolean
  expired: boolean
  pairingPending: boolean
  pairingId: string | null
  sessionExpiresAt: number | null
}
export interface WorldsCliPendingSummary {
  proposalId: string
  projectKey: string
  projectId: string
  sceneId: string
  revision: number
  digest: string
  expiresAt: number
  commandCount: number
  changeCount: number
  warningCount: number
}
export interface WorldsCliCompleteReview { complete: true; changes: Array<{ field: string; before: string | null; after: string | null }>; warnings: string[] }
export type WorldsCliReply<T> = ({ ok: true } & T) | { ok: false; code: string }
export interface WorldsCliApplyReceipt {
  transactionId: string
  projectId: string
  baseRevision: number
  newRevision: number
  beforeSnapshotSha256: string
  snapshotSha256: string
}
export interface WorldsCliApplyRequest { proposalId: string; reviewId: string; attemptId: string }
export interface WorldsCliDirectEditReadinessRequest {
  nonce: string
  intentId: string
  projectKey: string
  projectId: string
  sceneId: string
  baseRevision: number
  editorEpoch: number
  expiresAt: number
}
export type WorldsCliDirectEditReadinessResponse =
  | { nonce: string; intentId: string; status: 'READY' }
  | { nonce: string; intentId: string; status: 'REFUSED'; reason: 'unmounted' | 'play_active' | 'editor_not_ready' | 'scope_mismatch' | 'busy' | 'expired' }
export interface WorldsCliDirectEditRequest {
  nonce: string
  editIntent: string
  projectKey: string
  projectId: string
  sceneId: string
  baseRevision: number
  editorEpoch: number
  expiresAt: number
}
export interface WorldsCliDirectEditCorrelation { nonce: string; editIntent: string }
export interface WorldsCliDirectEditAdoption extends WorldsCliDirectEditCorrelation {
  transactionId: string
  newRevision: number
  snapshotSha256: string
}
export interface WorldsCliDirectEditCommitReceipt {
  transactionId: string
  projectId: string
  newRevision: number
  snapshotSha256: string
}
export interface WorldsCliApi {
  /** Private nonvisual broker; never renders pairing or CLI controls. */
  onContextRequest(callback: (nonce: string) => void): () => void
  respondContext(value: { nonce: string; projectKey: string; projectId: string; sceneId: string; revision: number; editorEpoch: number; mode: 'edit' }): Promise<{ ok: boolean }>
  editorLeft(): Promise<{ ok: boolean }>
  /** Inert mounted-editor observation; it grants no command or write authority. */
  onDirectEditReadinessRequest(callback: (request: WorldsCliDirectEditReadinessRequest) => void): () => void
  respondDirectEditReadiness(value: WorldsCliDirectEditReadinessResponse): Promise<{ ok: boolean }>
  cancelDirectEditReadiness(value: { nonce: string; intentId: string }): Promise<{ ok: boolean }>
  /** Private direct-edit protocol; mounted editor adoption owns local Undo truth. */
  onDirectEditRequest(callback: (request: WorldsCliDirectEditRequest) => void): () => void
  commitDirectEdit(value: WorldsCliDirectEditCorrelation): Promise<WorldsCliReply<{ receipt: WorldsCliDirectEditCommitReceipt }>>
  cancelDirectEdit(value: WorldsCliDirectEditCorrelation): Promise<WorldsCliReply<{ status: 'STALE' | 'AMBIGUOUS' }>>
  adoptDirectEdit(value: WorldsCliDirectEditAdoption): Promise<WorldsCliReply<{ status: 'APPLIED' }>>
  status(): Promise<({ ok: true } & WorldsCliStatus) | { ok: false; code: string }>
  revoke(): Promise<WorldsCliControlResult>
  listPending(): Promise<WorldsCliReply<{ proposals: WorldsCliPendingSummary[] }>>
  getReview(request: { proposalId: string }): Promise<WorldsCliReply<WorldsCliPendingSummary & { reviewId: string; review: WorldsCliCompleteReview }>>
  reject(request: { proposalId: string; reviewId: string }): Promise<WorldsCliReply<{ status: 'rejected' | 'absent' }>>
  /** Main confirms the complete review natively. No renderer batch or authority token is accepted. */
  apply(request: WorldsCliApplyRequest): Promise<WorldsCliReply<WorldsCliApplyReceipt>>
  /** Acknowledgment follows Main's synchronous cancellation/tombstone mutation. */
  cancelApplyIntent(request: { attemptId: string }): Promise<WorldsCliControlResult>
}

const PROJECT_KEY_PATTERN = /^world-[a-f0-9]{32}$/

export function isWorldProjectKey(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_KEY_PATTERN.test(value)
}
