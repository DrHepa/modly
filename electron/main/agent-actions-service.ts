import { randomBytes, randomUUID } from 'node:crypto'

import type {
  AgentArtifactSelectionV1,
  AgentActionDecisionRequest,
  AgentActionResolvedProposeRequest,
  AgentActionSessionGetRequest,
  AgentActionSessionRequest,
  AgentActionPublicErrorCode,
  AgentActionPublicSummaryV1,
  AgentActionV1,
  AgentCapabilityInventoryResult,
  AgentCapabilitySnapshotV1,
  AgentOllamaModelSnapshotV1,
  ArtifactRefV1,
  JsonValue,
} from '../../src/shared/types/agentActions.ts'
import { ARTIFACT_KINDS } from '../../src/shared/types/artifacts.ts'
import {
  assertMcpApprovalArgumentsPreviewable,
  assertAgentActionV1,
  assertAgentCapabilitySnapshotV1,
  assertAgentOllamaModelSnapshotV1,
  assertArtifactRefV1,
  canonicalJson,
  createAgentActionProposal,
  normalizeJsonValue,
  requiresLiveProviderModelRevalidation,
  sha256Canonical,
  toAgentActionPublicSummary,
  transitionAgentAction,
} from './agent-trust-contracts.ts'
import type { AgentArtifactVerifier } from './agent-artifact-verifier.ts'
import { AgentMcpBrokerError, validateMcpProposalArguments } from './agent-mcp-broker.ts'

const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/
const ARTIFACT_KIND_SET = new Set<string>(ARTIFACT_KINDS)
const TERMINAL_STATUSES = new Set(['rejected', 'expired', 'completed', 'failed', 'cancelled'])
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1_000
const DEFAULT_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_TERMINAL_ACTIONS = 100
const DEFAULT_MAX_ACTIONS = 250
const DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS = 2_000
const MAX_ARGUMENT_BYTES = 1024 * 1024
const MAX_TEXT_LENGTH = 200_000
const MAX_OUTPUT_ARTIFACTS = 32

type PlainRecord = Record<string, unknown>

export type AgentActionExecutorRequest = Readonly<{
  actionId: string
  originSessionId: string
  proposalHash: string
  capability: AgentCapabilitySnapshotV1
  arguments: JsonValue
  model: AgentOllamaModelSnapshotV1
  inputArtifacts: readonly ArtifactRefV1[]
  signal: AbortSignal
}>

export type AgentActionExecutor = (request: AgentActionExecutorRequest) => Promise<unknown>

export interface AgentActionsServiceLike {
  propose(request: AgentActionResolvedProposeRequest): Promise<AgentActionPublicSummaryV1>
  get(request: AgentActionSessionGetRequest): Promise<AgentActionPublicSummaryV1>
  list(request: AgentActionSessionRequest): Promise<AgentActionPublicSummaryV1[]>
  decide(request: AgentActionDecisionRequest): Promise<AgentActionPublicSummaryV1>
  execute(request: AgentActionSessionGetRequest): Promise<AgentActionPublicSummaryV1>
  cancel(request: AgentActionSessionGetRequest): Promise<AgentActionPublicSummaryV1>
}

export interface AgentActionsServiceOptions {
  resolveCapabilities: () => Promise<AgentCapabilityInventoryResult>
  resolveCurrentModel: (expected: AgentOllamaModelSnapshotV1) => Promise<unknown>
  artifactVerifier?: AgentArtifactVerifier
  executor?: AgentActionExecutor
  isExecutorAvailable?: () => boolean
  ensureExecutorReady?: (capability: AgentCapabilitySnapshotV1) => Promise<void>
  now?: () => Date
  createActionId?: () => string
  createLease?: () => string
  approvalTtlMs?: number
  terminalRetentionMs?: number
  maxTerminalActions?: number
  maxActions?: number
  cancellationSettlementTimeoutMs?: number
}

interface PrivateActionRecord {
  action: AgentActionV1
  generation: number
  originSessionId: string
}

interface ApprovalLease {
  token: string
  actionId: string
  proposalHash: string
  capabilityHash: string
  model: string
  modelDigest: string
  endpointHash: string
  scope: 'single_action'
  expiresAt: string
  bindingHash: string
}

interface NormalizedArguments {
  arguments: JsonValue
  inputArtifacts: ArtifactRefV1[]
}

interface NormalizedExecutorResult {
  artifacts: ArtifactRefV1[]
  rollback?: () => Promise<void>
}

interface ExecutionSettlement {
  promise: Promise<void>
  resolve: () => void
  settled: boolean
  executorInvoked: boolean
  cancellationRequested: boolean
  rollback?: () => Promise<void>
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactRecord(value: unknown, keys: readonly string[], code: AgentActionPublicErrorCode): PlainRecord {
  if (!isPlainRecord(value)) throw new AgentActionsServiceError(code)
  const allowed = new Set(keys)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new AgentActionsServiceError(code)
  }
  return value
}

function assertSafeActionId(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_ID_PATTERN.test(value)) {
    throw new AgentActionsServiceError('invalid_request')
  }
  return value
}

function assertCapabilityId(value: unknown): string {
  if (typeof value !== 'string' || !CAPABILITY_ID_PATTERN.test(value)) {
    throw new AgentActionsServiceError('invalid_request')
  }
  return value
}

function assertCapabilityHash(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new AgentActionsServiceError('invalid_request')
  }
  return value
}

function assertArtifactSelection(value: unknown): AgentArtifactSelectionV1 {
  const selection = assertExactRecord(
    value,
    ['id', 'kind', 'mediaType', 'sha256', 'sizeBytes'],
    'invalid_arguments',
  )
  if (typeof selection.id !== 'string' || !ACTION_ID_PATTERN.test(selection.id)) {
    throw new AgentActionsServiceError('invalid_arguments')
  }
  if (typeof selection.kind !== 'string' || !ARTIFACT_KIND_SET.has(selection.kind)) {
    throw new AgentActionsServiceError('invalid_arguments')
  }
  if (typeof selection.mediaType !== 'string' || selection.mediaType.length > 128
    || selection.mediaType !== selection.mediaType.toLowerCase()
    || !MIME_TYPE_PATTERN.test(selection.mediaType)) {
    throw new AgentActionsServiceError('invalid_arguments')
  }
  if (typeof selection.sha256 !== 'string' || !SHA256_PATTERN.test(selection.sha256)) {
    throw new AgentActionsServiceError('invalid_arguments')
  }
  if (typeof selection.sizeBytes !== 'number' || !Number.isSafeInteger(selection.sizeBytes)
    || selection.sizeBytes < 0) {
    throw new AgentActionsServiceError('invalid_arguments')
  }
  return {
    id: selection.id,
    kind: selection.kind as ArtifactRefV1['kind'],
    mediaType: selection.mediaType,
    sha256: selection.sha256,
    sizeBytes: selection.sizeBytes,
  }
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
}

function stableAction(record: PrivateActionRecord): AgentActionV1 {
  deepFreeze(record.action)
  return record.action
}

function isTerminal(action: AgentActionV1): boolean {
  return TERMINAL_STATUSES.has(action.status)
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    throw new AgentActionsServiceError('invalid_arguments')
  }
  try {
    canonicalJson(value)
  } catch (error) {
    throw new AgentActionsServiceError('invalid_arguments', error)
  }
  return value
}

function normalizeParamValue(schema: PlainRecord, value: unknown): JsonValue {
  switch (schema.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new AgentActionsServiceError('invalid_arguments')
      return value
    case 'string':
      if (schema.pickerIntent !== undefined) throw new AgentActionsServiceError('invalid_arguments')
      return normalizeText(value)
    case 'int':
    case 'float': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new AgentActionsServiceError('invalid_arguments')
      if (schema.type === 'int' && !Number.isSafeInteger(value)) throw new AgentActionsServiceError('invalid_arguments')
      if (typeof schema.min === 'number' && value < schema.min) throw new AgentActionsServiceError('invalid_arguments')
      if (typeof schema.max === 'number' && value > schema.max) throw new AgentActionsServiceError('invalid_arguments')
      return Object.is(value, -0) ? 0 : value
    }
    case 'select': {
      if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new AgentActionsServiceError('invalid_arguments')
      }
      const normalized = Object.is(value, -0) ? 0 : value
      if (Array.isArray(schema.options)) {
        const matches = schema.options.some((option) => isPlainRecord(option) && Object.is(option.value, normalized))
        if (!matches) throw new AgentActionsServiceError('invalid_arguments')
      }
      return normalized
    }
    default:
      throw new AgentActionsServiceError('invalid_arguments')
  }
}

function approvalLeaseBinding(lease: Omit<ApprovalLease, 'token' | 'bindingHash'>): PlainRecord {
  return {
    schema: 'modly.agent-approval-lease.v1',
    actionId: lease.actionId,
    proposalHash: lease.proposalHash,
    capabilityHash: lease.capabilityHash,
    model: lease.model,
    modelDigest: lease.modelDigest,
    endpointHash: lease.endpointHash,
    scope: lease.scope,
    expiresAt: lease.expiresAt,
  }
}

export class AgentActionsServiceError extends Error {
  readonly code: AgentActionPublicErrorCode

  constructor(code: AgentActionPublicErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'AgentActionsServiceError'
    this.code = code
  }
}

export class AgentActionsService implements AgentActionsServiceLike {
  private readonly options: AgentActionsServiceOptions
  private readonly actions = new Map<string, PrivateActionRecord>()
  private readonly leases = new Map<string, ApprovalLease>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly executionSettlements = new Map<string, ExecutionSettlement>()
  private readonly actionLocks = new Map<string, Promise<void>>()
  private shuttingDown = false
  private nextMcpArtifactIdentity = 0
  private readonly now: () => Date
  private readonly createActionId: () => string
  private readonly createLease: () => string
  private readonly approvalTtlMs: number
  private readonly terminalRetentionMs: number
  private readonly maxTerminalActions: number
  private readonly maxActions: number
  private readonly cancellationSettlementTimeoutMs: number

  constructor(options: AgentActionsServiceOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.createActionId = options.createActionId ?? randomUUID
    this.createLease = options.createLease ?? (() => randomBytes(32).toString('base64url'))
    this.approvalTtlMs = this.assertPositiveInteger(options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS, 'approvalTtlMs')
    this.terminalRetentionMs = this.assertNonNegativeInteger(options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS, 'terminalRetentionMs')
    this.maxTerminalActions = this.assertNonNegativeInteger(options.maxTerminalActions ?? DEFAULT_MAX_TERMINAL_ACTIONS, 'maxTerminalActions')
    this.maxActions = this.assertPositiveInteger(options.maxActions ?? DEFAULT_MAX_ACTIONS, 'maxActions')
    this.cancellationSettlementTimeoutMs = this.assertPositiveInteger(
      options.cancellationSettlementTimeoutMs ?? DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
      'cancellationSettlementTimeoutMs',
    )
    if (this.maxTerminalActions > this.maxActions) throw new TypeError('maxTerminalActions must not exceed maxActions')
  }

  async propose(requestValue: AgentActionResolvedProposeRequest): Promise<AgentActionPublicSummaryV1> {
    this.assertRunning()
    this.prune()
    if (this.actions.size >= this.maxActions) throw new AgentActionsServiceError('capacity_exceeded')
    const request = assertExactRecord(requestValue, ['originSessionId', 'capabilityId', 'capabilityHash', 'arguments', 'model'], 'invalid_request')
    const originSessionId = assertSafeActionId(request.originSessionId)
    const capabilityId = assertCapabilityId(request.capabilityId)
    const capabilityHash = assertCapabilityHash(request.capabilityHash)
    const capability = await this.resolveCapability(capabilityId, 'capability_not_found')
    if (capability.hash !== capabilityHash) throw new AgentActionsServiceError('capability_stale')
    let proposedModel: AgentOllamaModelSnapshotV1
    try {
      proposedModel = assertAgentOllamaModelSnapshotV1(request.model)
    } catch (error) {
      throw new AgentActionsServiceError('invalid_request', error)
    }
    if (requiresLiveProviderModelRevalidation(capability)) {
      await this.assertCurrentModel(proposedModel)
    }
    const normalized = await this.normalizeArguments(capability, request.arguments, originSessionId)
    if (capability.execution?.kind === 'mcp_tool') {
      try {
        assertMcpApprovalArgumentsPreviewable(normalized.arguments)
      } catch (error) {
        throw new AgentActionsServiceError('invalid_arguments', error)
      }
    }
    const currentCapability = await this.resolveCapability(capabilityId, 'capability_stale')
    if (currentCapability.hash !== capabilityHash) throw new AgentActionsServiceError('capability_stale')

    this.assertRunning()
    this.prune()
    if (this.actions.size >= this.maxActions) throw new AgentActionsServiceError('capacity_exceeded')

    const createdAt = this.now().toISOString()
    const expiresAt = new Date(Date.parse(createdAt) + this.approvalTtlMs).toISOString()
    const id = assertSafeActionId(this.createActionId())
    if (this.actions.has(id)) throw new AgentActionsServiceError('internal_error')
    const action = createAgentActionProposal({
      id,
      capability: currentCapability,
      arguments: normalized.arguments,
      model: proposedModel,
      inputArtifacts: normalized.inputArtifacts,
      approval: { scope: 'single_action', expiresAt },
      createdAt,
    })
    const record = { action, generation: 0, originSessionId }
    stableAction(record)
    this.actions.set(id, record)
    return this.toPublic(record)
  }

  async get(requestValue: AgentActionSessionGetRequest): Promise<AgentActionPublicSummaryV1> {
    const request = assertExactRecord(requestValue, ['actionId', 'originSessionId'], 'invalid_request')
    const actionId = assertSafeActionId(request.actionId)
    const originSessionId = assertSafeActionId(request.originSessionId)
    return this.withActionLock(actionId, () => {
      this.prune()
      return this.toPublic(this.requireOwnedRecord(actionId, originSessionId))
    })
  }

  async list(requestValue: AgentActionSessionRequest): Promise<AgentActionPublicSummaryV1[]> {
    this.prune()
    const request = assertExactRecord(requestValue, ['originSessionId'], 'invalid_request')
    const originSessionId = assertSafeActionId(request.originSessionId)
    return [...this.actions.values()]
      .filter((record) => record.originSessionId === originSessionId)
      .sort((left, right) => left.action.createdAt.localeCompare(right.action.createdAt) || left.action.id.localeCompare(right.action.id))
      .map((record) => this.toPublic(record))
  }

  async decide(requestValue: AgentActionDecisionRequest): Promise<AgentActionPublicSummaryV1> {
    this.assertRunning()
    const request = assertExactRecord(requestValue, ['actionId', 'originSessionId', 'decision'], 'invalid_request')
    const actionId = assertSafeActionId(request.actionId)
    const originSessionId = assertSafeActionId(request.originSessionId)
    if (request.decision !== 'approve' && request.decision !== 'reject') {
      throw new AgentActionsServiceError('invalid_request')
    }
    if (request.decision === 'reject') {
      return this.withActionLock(actionId, () => {
        this.assertRunning()
        this.prune()
        const record = this.requireOwnedRecord(actionId, originSessionId)
        if (record.action.status === 'expired') throw new AgentActionsServiceError('approval_expired')
        if (record.action.status !== 'proposed') throw new AgentActionsServiceError('invalid_state')
        this.transition(record, 'rejected')
        this.prune()
        return this.toPublic(record)
      })
    }

    const snapshot = await this.withActionLock(actionId, () => {
      this.prune()
      const record = this.requireOwnedRecord(actionId, originSessionId)
      if (record.action.status === 'expired') throw new AgentActionsServiceError('approval_expired')
      if (record.action.status !== 'proposed') throw new AgentActionsServiceError('invalid_state')
      return { action: cloneCanonical(record.action), generation: record.generation }
    })
    let bindingFailure: AgentActionsServiceError | undefined
    try {
      await this.assertCurrentBindings(snapshot.action)
    } catch (error) {
      bindingFailure = this.asBindingError(error)
    }

    return this.withActionLock(actionId, () => {
      this.assertRunning()
      this.prune()
      const record = this.requireOwnedRecord(actionId, originSessionId)
      if (record.action.status === 'cancelled') return this.toPublic(record)
      if (record.action.status === 'expired') throw new AgentActionsServiceError('approval_expired')
      if (record.action.status !== 'proposed' || record.generation !== snapshot.generation) {
        throw new AgentActionsServiceError('invalid_state')
      }
      if (bindingFailure) {
        if (this.now().getTime() >= Date.parse(record.action.approval.expiresAt)) {
          this.transitionAt(record, 'expired', record.action.approval.expiresAt)
          throw new AgentActionsServiceError('approval_expired', bindingFailure)
        }
        this.transition(record, 'cancelled', bindingFailure.code)
        throw bindingFailure
      }
      if (this.now().getTime() >= Date.parse(record.action.approval.expiresAt)) {
        this.transitionAt(record, 'expired', record.action.approval.expiresAt)
        throw new AgentActionsServiceError('approval_expired')
      }

      const token = this.createLease()
      if (typeof token !== 'string' || token.length < 16) throw new AgentActionsServiceError('internal_error')
      const leaseWithoutSecrets = {
        actionId: record.action.id,
        proposalHash: record.action.proposalHash,
        capabilityHash: record.action.capability.hash,
        model: record.action.model.model,
        modelDigest: record.action.model.digest,
        endpointHash: sha256Canonical(record.action.model.endpoint),
        scope: record.action.approval.scope,
        expiresAt: record.action.approval.expiresAt,
      }
      const lease: ApprovalLease = {
        token,
        ...leaseWithoutSecrets,
        bindingHash: sha256Canonical(approvalLeaseBinding(leaseWithoutSecrets)),
      }
      this.transition(record, 'approved')
      this.leases.set(actionId, lease)
      return this.toPublic(record)
    })
  }

  async execute(requestValue: AgentActionSessionGetRequest): Promise<AgentActionPublicSummaryV1> {
    this.assertRunning()
    const request = assertExactRecord(requestValue, ['actionId', 'originSessionId'], 'invalid_request')
    const actionId = assertSafeActionId(request.actionId)
    const originSessionId = assertSafeActionId(request.originSessionId)
    const readinessSnapshot = await this.withActionLock(actionId, () => {
      this.prune()
      const record = this.requireOwnedRecord(actionId, originSessionId)
      if (record.action.status === 'expired') throw new AgentActionsServiceError('approval_expired')
      if (record.action.status !== 'approved') throw new AgentActionsServiceError('invalid_state')
      const lease = this.leases.get(actionId)
      if (!lease) throw new AgentActionsServiceError('invalid_state')
      this.assertLease(record.action, lease)
      return { capability: cloneCanonical(record.action.capability), generation: record.generation }
    })
    let readinessFailure: AgentActionsServiceError | undefined
    if (!this.options.executor || (this.options.isExecutorAvailable && !this.safeExecutorAvailability())) {
      readinessFailure = new AgentActionsServiceError('executor_unavailable')
    } else if (this.options.ensureExecutorReady) {
      try {
        deepFreeze(readinessSnapshot.capability)
        await this.options.ensureExecutorReady(readinessSnapshot.capability)
      } catch (error) {
        readinessFailure = error instanceof AgentActionsServiceError
          ? error
          : new AgentActionsServiceError('executor_unavailable', error)
      }
    }
    if (readinessFailure) {
      return this.withActionLock(actionId, () => {
        this.prune()
        const record = this.requireOwnedRecord(actionId, originSessionId)
        if (record.action.status === 'cancelled') return this.toPublic(record)
        if (record.action.status === 'expired') throw new AgentActionsServiceError('approval_expired', readinessFailure)
        if (record.action.status !== 'approved' || record.generation !== readinessSnapshot.generation) {
          throw new AgentActionsServiceError('invalid_state')
        }
        const lease = this.leases.get(actionId)
        if (!lease) throw new AgentActionsServiceError('invalid_state')
        this.assertLease(record.action, lease)
        throw readinessFailure
      })
    }
    const prepared = await this.withActionLock(actionId, () => {
      this.assertRunning()
      this.prune()
      const record = this.requireOwnedRecord(actionId, originSessionId)
      if (record.action.status === 'expired') throw new AgentActionsServiceError('approval_expired')
      if (record.action.status !== 'approved') throw new AgentActionsServiceError('invalid_state')
      const lease = this.leases.get(actionId)
      if (!lease) throw new AgentActionsServiceError('invalid_state')
      this.assertLease(record.action, lease)
      if (this.now().getTime() >= Date.parse(record.action.approval.expiresAt)) {
        this.leases.delete(actionId)
        this.transitionAt(record, 'expired', record.action.approval.expiresAt)
        throw new AgentActionsServiceError('approval_expired')
      }

      // Approval consumption and the executing transition are one atomic main-
      // process operation. No executor or verifier runs while this lock is held.
      this.leases.delete(actionId)
      const controller = new AbortController()
      this.controllers.set(actionId, controller)
      this.executionSettlements.set(actionId, this.createExecutionSettlement())
      this.transition(record, 'executing')
      const executorRequest: AgentActionExecutorRequest = {
        actionId,
        originSessionId,
        proposalHash: record.action.proposalHash,
        capability: cloneCanonical(record.action.capability),
        arguments: cloneCanonical(record.action.arguments),
        model: cloneCanonical(record.action.model),
        inputArtifacts: cloneCanonical(record.action.inputArtifacts),
        signal: controller.signal,
      }
      deepFreeze(executorRequest.capability)
      deepFreeze(executorRequest.arguments)
      deepFreeze(executorRequest.model)
      deepFreeze(executorRequest.inputArtifacts)
      return {
        action: cloneCanonical(record.action),
        controller,
        executionGeneration: record.generation,
        executorRequest,
      }
    })

    let preflightFailure: AgentActionsServiceError | undefined
    if (!this.options.artifactVerifier) {
      preflightFailure = new AgentActionsServiceError('invalid_artifact')
    } else {
      try {
        await this.assertCurrentBindings(prepared.action)
      } catch (error) {
        preflightFailure = this.asBindingError(error)
      }
      if (!preflightFailure) {
        try {
          await this.verifyArtifacts(
            prepared.action.inputArtifacts,
            undefined,
            prepared.controller.signal,
          )
        } catch (error) {
          preflightFailure = error instanceof AgentActionsServiceError
            ? error
            : new AgentActionsServiceError('invalid_artifact', error)
        }
      }
    }
    if (this.now().getTime() >= Date.parse(prepared.action.approval.expiresAt)) {
      preflightFailure = new AgentActionsServiceError('approval_expired', preflightFailure)
    }

    if (preflightFailure) {
      type PreflightResult =
        | { summary: AgentActionPublicSummaryV1 }
        | { failure: AgentActionsServiceError }
      const preflightResult = await this.withActionLock(actionId, (): PreflightResult => {
        const record = this.requireOwnedRecord(actionId, originSessionId)
        if (record.action.status === 'cancelled') return { summary: this.toPublic(record) }
        if (!this.isExecutionOwned(actionId, prepared.executionGeneration, prepared.controller)) {
          throw new AgentActionsServiceError('invalid_state')
        }
        const settlement = this.requireExecutionSettlement(actionId)
        if (settlement.cancellationRequested) {
          this.transition(record, 'cancelled', 'cancelled_by_user')
          this.deleteController(actionId, prepared.controller)
          this.settleExecution(actionId, settlement)
          this.prune()
          return { summary: this.toPublic(record) }
        }
        const terminalStatus = preflightFailure.code === 'capability_stale'
          || preflightFailure.code === 'model_stale'
          || preflightFailure.code === 'approval_expired'
          ? 'cancelled'
          : 'failed'
        this.transition(record, terminalStatus, preflightFailure.code)
        this.deleteController(actionId, prepared.controller)
        this.settleExecution(actionId, settlement)
        return { failure: preflightFailure }
      })
      if ('summary' in preflightResult) return preflightResult.summary
      throw preflightResult.failure
    }

    // No await is allowed between this authoritative ownership check, marking
    // the executor invoked, and invoking it. Cancellation therefore observes
    // either a known no-publication preflight or the shared settlement barrier.
    const settlement = this.executionSettlements.get(actionId)
    if (!this.isExecutionOwned(actionId, prepared.executionGeneration, prepared.controller)
      || !settlement || settlement.cancellationRequested || prepared.controller.signal.aborted) {
      return this.withActionLock(actionId, () => {
        const record = this.requireOwnedRecord(actionId, originSessionId)
        if (record.action.status === 'cancelled') return this.toPublic(record)
        if (!this.isExecutionOwned(actionId, prepared.executionGeneration, prepared.controller)) {
          throw new AgentActionsServiceError('invalid_state')
        }
        const currentSettlement = this.requireExecutionSettlement(actionId)
        this.transition(record, 'cancelled', 'cancelled_by_user')
        this.deleteController(actionId, prepared.controller)
        this.settleExecution(actionId, currentSettlement)
        this.prune()
        return this.toPublic(record)
      })
    }
    settlement.executorInvoked = true
    let result: unknown
    let failure: AgentActionsServiceError | undefined
    try {
      result = await this.options.executor?.(prepared.executorRequest)
    } catch (error) {
      failure = error instanceof AgentActionsServiceError
        ? error
        : new AgentActionsServiceError('execution_failed', error)
    }

    let artifacts: ArtifactRefV1[] | undefined
    let transaction: NormalizedExecutorResult | undefined
    if (!failure) {
      try {
        transaction = this.normalizeExecutorResult(result, prepared.action.capability, prepared.action.id)
        settlement.rollback = transaction.rollback
        if (!settlement.cancellationRequested && !prepared.controller.signal.aborted) {
          const verifiedArtifacts = await this.verifyArtifacts(
            transaction.artifacts,
            prepared.action.capability.execution === undefined
              ? prepared.action.capability.node.output
              : undefined,
            prepared.controller.signal,
          )
          if (prepared.action.capability.execution?.kind === 'process'
            && !verifiedArtifacts.some((artifact) => artifact.kind === prepared.action.capability.node.output)) {
            throw new AgentActionsServiceError('invalid_artifact')
          }
          artifacts = prepared.action.capability.execution?.kind === 'mcp_tool'
            ? this.assignMcpArtifactIdentities(verifiedArtifacts, prepared.action.id)
            : verifiedArtifacts
        }
      } catch (error) {
        failure = error instanceof AgentActionsServiceError
          ? error
          : new AgentActionsServiceError('invalid_artifact', error)
      }
    }
    if (!failure && !settlement.cancellationRequested && !prepared.controller.signal.aborted) {
      try {
        await this.assertCurrentBindings(prepared.action)
      } catch (error) {
        failure = this.asBindingError(error)
      }
    }

    const cancellationRequested = settlement.cancellationRequested || prepared.controller.signal.aborted
    let rollbackFailed = false
    if (transaction?.rollback && (failure !== undefined || cancellationRequested)) {
      try {
        await transaction.rollback()
      } catch (error) {
        failure = new AgentActionsServiceError('execution_failed', error)
        rollbackFailed = true
      }
    }

    type FinalizedResult =
      | { summary: AgentActionPublicSummaryV1 }
      | { failure: AgentActionsServiceError }
    const finalized = await this.withActionLock(actionId, (): FinalizedResult => {
      const record = this.requireOwnedRecord(actionId, originSessionId)
      if (record.action.status === 'cancelled') return { summary: this.toPublic(record) }
      if (!this.isExecutionOwned(actionId, prepared.executionGeneration, prepared.controller)) {
        throw new AgentActionsServiceError('invalid_state')
      }
      const currentSettlement = this.requireExecutionSettlement(actionId)
      const cancelled = currentSettlement.cancellationRequested || prepared.controller.signal.aborted
      if (cancelled && !rollbackFailed) {
        this.transition(record, 'cancelled', 'cancelled_by_user')
        this.deleteController(actionId, prepared.controller)
        this.settleExecution(actionId, currentSettlement)
        this.prune()
        return { summary: this.toPublic(record) }
      }
      if (failure) {
        this.transition(record, 'failed', failure.code)
        this.deleteController(actionId, prepared.controller)
        this.settleExecution(actionId, currentSettlement)
        return { failure }
      }
      this.transition(record, 'completed', undefined, artifacts)
      this.deleteController(actionId, prepared.controller)
      this.settleExecution(actionId, currentSettlement)
      this.prune()
      return { summary: this.toPublic(record) }
    })
    if ('summary' in finalized) return finalized.summary
    throw finalized.failure
  }

  async cancel(requestValue: AgentActionSessionGetRequest): Promise<AgentActionPublicSummaryV1> {
    const request = assertExactRecord(requestValue, ['actionId', 'originSessionId'], 'invalid_request')
    const actionId = assertSafeActionId(request.actionId)
    const originSessionId = assertSafeActionId(request.originSessionId)
    type CancellationStep =
      | { summary: AgentActionPublicSummaryV1 }
      | { settlement: Promise<void> }
    const step = await this.withActionLock(actionId, (): CancellationStep => {
      this.prune()
      const record = this.requireOwnedRecord(actionId, originSessionId)
      if (record.action.status === 'cancelled') return { summary: this.toPublic(record) }
      if (record.action.status !== 'proposed' && record.action.status !== 'approved' && record.action.status !== 'executing') {
        throw new AgentActionsServiceError('invalid_state')
      }
      this.leases.delete(actionId)
      const controller = this.controllers.get(actionId)
      if (record.action.status !== 'executing') {
        controller?.abort()
        this.transition(record, 'cancelled', 'cancelled_by_user')
        this.deleteController(actionId, controller)
        this.prune()
        return { summary: this.toPublic(record) }
      }
      const settlement = this.requireExecutionSettlement(actionId)
      settlement.cancellationRequested = true
      controller?.abort()
      if (!settlement.executorInvoked) {
        this.transition(record, 'cancelled', 'cancelled_by_user')
        this.deleteController(actionId, controller)
        this.settleExecution(actionId, settlement)
        this.prune()
        return { settlement: settlement.promise }
      }
      return { settlement: settlement.promise }
    })
    if ('summary' in step) return step.summary
    if (!await this.waitForExecutionSettlement(step.settlement)) {
      throw new AgentActionsServiceError('cancellation_pending')
    }
    return this.withActionLock(actionId, () => {
      const record = this.requireOwnedRecord(actionId, originSessionId)
      if (record.action.status === 'cancelled') return this.toPublic(record)
      if (record.action.status === 'failed') throw new AgentActionsServiceError('execution_failed')
      throw new AgentActionsServiceError('cancellation_pending')
    })
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const steps = await Promise.all([...this.actions.keys()].map((actionId) => (
      this.withActionLock(actionId, (): { settlement?: Promise<void> } => {
        const record = this.actions.get(actionId)
        if (!record) return {}
        this.leases.delete(actionId)
        if (record.action.status === 'proposed' || record.action.status === 'approved') {
          this.transition(record, 'cancelled', 'application_shutdown')
          return {}
        }
        if (record.action.status !== 'executing') return {}
        const controller = this.controllers.get(actionId)
        const settlement = this.executionSettlements.get(actionId)
        if (!settlement) {
          controller?.abort()
          return {}
        }
        settlement.cancellationRequested = true
        controller?.abort()
        return { settlement: settlement.promise }
      })
    )))
    const settlements = steps.flatMap((step) => step.settlement ? [step.settlement] : [])
    await Promise.all(settlements.map((settlement) => this.waitForExecutionSettlement(settlement)))
  }

  private assertPositiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
    return value
  }

  private assertNonNegativeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
    return value
  }

  private assertRunning(): void {
    if (this.shuttingDown) throw new AgentActionsServiceError('executor_unavailable')
  }

  private safeExecutorAvailability(): boolean {
    try {
      return this.options.isExecutorAvailable?.() === true
    } catch {
      return false
    }
  }

  private async normalizeArguments(
    capability: AgentCapabilitySnapshotV1,
    value: unknown,
    originSessionId: string,
  ): Promise<NormalizedArguments> {
    try {
      if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_ARGUMENT_BYTES) {
        throw new AgentActionsServiceError('invalid_arguments')
      }
    } catch (error) {
      if (error instanceof AgentActionsServiceError) throw error
      throw new AgentActionsServiceError('invalid_arguments', error)
    }
    if (capability.execution?.kind === 'mcp_tool') {
      try {
        if (!isPlainRecord(value)) throw new AgentActionsServiceError('invalid_arguments')
        const argumentsValue = validateMcpProposalArguments(capability.execution.inputSchema, value)
        if (Buffer.byteLength(canonicalJson(argumentsValue), 'utf8') > MAX_ARGUMENT_BYTES) {
          throw new AgentActionsServiceError('invalid_arguments')
        }
        const inputArtifacts: ArtifactRefV1[] = []
        const argumentRecord = argumentsValue as Record<string, JsonValue>
        for (const binding of capability.execution.inputArtifacts ?? []) {
          const rawArtifactId = argumentRecord[binding.argument]
          if (typeof rawArtifactId !== 'string' || !ACTION_ID_PATTERN.test(rawArtifactId)) {
            throw new AgentActionsServiceError('invalid_arguments')
          }
          const artifactId = rawArtifactId
          if (inputArtifacts.some((artifact) => artifact.id === artifactId)) {
            throw new AgentActionsServiceError('invalid_arguments')
          }
          const artifact = this.resolveCompletedArtifact(
            originSessionId,
            { id: artifactId },
            binding.kind,
            binding.mediaTypes,
          )
          inputArtifacts.push(artifact)
        }
        return { arguments: argumentsValue, inputArtifacts }
      } catch (error) {
        if (error instanceof AgentActionsServiceError) throw error
        if (error instanceof AgentMcpBrokerError) throw new AgentActionsServiceError('invalid_arguments', error)
        throw new AgentActionsServiceError('invalid_arguments', error)
      }
    }
    const raw = assertExactRecord(value, ['input', 'params'], 'invalid_arguments')
    if (!Object.prototype.hasOwnProperty.call(raw, 'input')) throw new AgentActionsServiceError('invalid_arguments')
    const inputArtifacts: ArtifactRefV1[] = []
    const input = capability.node.inputs
      ? await this.normalizeNamedInputs(capability.node.inputs, raw.input, inputArtifacts, originSessionId)
      : await this.normalizeInputValue(
        capability.node.input, false, undefined, undefined, raw.input, inputArtifacts, originSessionId,
      )
    const paramsRaw = raw.params === undefined
      ? {}
      : assertExactRecord(raw.params, capability.node.paramsSchema.map((param) => {
        if (!isPlainRecord(param) || typeof param.id !== 'string') throw new AgentActionsServiceError('invalid_arguments')
        return param.id
      }), 'invalid_arguments')
    const params: Record<string, JsonValue> = {}
    for (const paramValue of capability.node.paramsSchema) {
      if (!isPlainRecord(paramValue) || typeof paramValue.id !== 'string') throw new AgentActionsServiceError('invalid_arguments')
      const rawValue = Object.prototype.hasOwnProperty.call(paramsRaw, paramValue.id)
        ? paramsRaw[paramValue.id]
        : paramValue.default
      params[paramValue.id] = normalizeParamValue(paramValue, rawValue)
    }
    const normalized = normalizeJsonValue({ input, params })
    if (Buffer.byteLength(canonicalJson(normalized), 'utf8') > MAX_ARGUMENT_BYTES) {
      throw new AgentActionsServiceError('invalid_arguments')
    }
    return { arguments: normalized, inputArtifacts }
  }

  private async normalizeNamedInputs(
    schemas: NonNullable<AgentCapabilitySnapshotV1['node']['inputs']>,
    value: unknown,
    inputArtifacts: ArtifactRefV1[],
    originSessionId: string,
  ): Promise<JsonValue> {
    const record = assertExactRecord(value, schemas.map((schema) => schema.name), 'invalid_arguments')
    const normalized: Record<string, JsonValue> = {}
    for (const schema of schemas) {
      if (!Object.prototype.hasOwnProperty.call(record, schema.name)) {
        if (schema.required !== false) throw new AgentActionsServiceError('invalid_arguments')
        continue
      }
      normalized[schema.name] = await this.normalizeInputValue(
        schema.type,
        schema.multiple === true,
        schema.min_items,
        schema.max_items,
        record[schema.name],
        inputArtifacts,
        originSessionId,
      )
    }
    return normalizeJsonValue(normalized)
  }

  private async normalizeInputValue(
    kind: ArtifactRefV1['kind'],
    multiple: boolean,
    minItems: number | undefined,
    maxItems: number | undefined,
    value: unknown,
    inputArtifacts: ArtifactRefV1[],
    originSessionId: string,
  ): Promise<JsonValue> {
    if (multiple) {
      if (!Array.isArray(value)) throw new AgentActionsServiceError('invalid_arguments')
      if (value.length < (minItems ?? 0) || value.length > (maxItems ?? 100)) {
        throw new AgentActionsServiceError('invalid_arguments')
      }
      const normalized: JsonValue[] = []
      for (const entry of value) {
        normalized.push(await this.normalizeSingleInput(kind, entry, inputArtifacts, originSessionId))
      }
      return normalized
    }
    return this.normalizeSingleInput(kind, value, inputArtifacts, originSessionId)
  }

  private async normalizeSingleInput(
    kind: ArtifactRefV1['kind'],
    value: unknown,
    inputArtifacts: ArtifactRefV1[],
    originSessionId: string,
  ): Promise<JsonValue> {
    if (kind === 'text') return normalizeText(value)
    const selection = assertArtifactSelection(value)
    const artifact = this.resolveCompletedArtifact(originSessionId, selection, kind)
    inputArtifacts.push(artifact)
    return normalizeJsonValue(artifact)
  }

  private resolveCompletedArtifact(
    originSessionId: string,
    requested: Pick<AgentArtifactSelectionV1, 'id'> | AgentArtifactSelectionV1,
    expectedKind: ArtifactRefV1['kind'],
    allowedMediaTypes?: readonly string[],
  ): ArtifactRefV1 {
    this.prune()
    const candidates = [...this.actions.values()].flatMap((record) => (
      record.originSessionId === originSessionId && record.action.status === 'completed'
        ? record.action.outputArtifacts.filter((artifact) => artifact.id === requested.id)
        : []
    ))
    if (candidates.length !== 1) throw new AgentActionsServiceError('artifact_not_found')
    let artifact: ArtifactRefV1
    try {
      artifact = assertArtifactRefV1(candidates[0])
    } catch (error) {
      throw new AgentActionsServiceError('artifact_not_found', error)
    }
    if (artifact.kind !== expectedKind
      || (allowedMediaTypes && !allowedMediaTypes.includes(artifact.mediaType))) {
      throw new AgentActionsServiceError('artifact_not_found')
    }
    if ('kind' in requested && (
      artifact.id !== requested.id
      || artifact.kind !== requested.kind
      || artifact.mediaType !== requested.mediaType
      || artifact.sha256 !== requested.sha256
      || artifact.sizeBytes !== requested.sizeBytes
    )) {
      throw new AgentActionsServiceError('artifact_not_found')
    }
    return cloneCanonical(artifact)
  }

  private async resolveCapability(
    capabilityId: string,
    missingCode: 'capability_not_found' | 'capability_stale',
  ): Promise<AgentCapabilitySnapshotV1> {
    let inventory: AgentCapabilityInventoryResult
    try {
      inventory = await this.options.resolveCapabilities()
    } catch (error) {
      throw new AgentActionsServiceError(missingCode, error)
    }
    const matches = inventory.capabilities.filter((candidate) => candidate.id === capabilityId)
    if (matches.length !== 1) throw new AgentActionsServiceError(missingCode)
    try {
      return assertAgentCapabilitySnapshotV1(matches[0])
    } catch (error) {
      throw new AgentActionsServiceError(missingCode, error)
    }
  }

  private async assertCurrentModel(expected: AgentOllamaModelSnapshotV1): Promise<void> {
    let current: AgentOllamaModelSnapshotV1
    try {
      current = assertAgentOllamaModelSnapshotV1(await this.options.resolveCurrentModel(cloneCanonical(expected)))
    } catch (error) {
      throw new AgentActionsServiceError('model_stale', error)
    }
    if (sha256Canonical(current) !== sha256Canonical(expected)) throw new AgentActionsServiceError('model_stale')
  }

  private async assertCurrentBindings(action: AgentActionV1): Promise<void> {
    let normalized: AgentActionV1
    try {
      normalized = assertAgentActionV1(action, this.now().toISOString())
    } catch (error) {
      throw new AgentActionsServiceError('capability_stale', error)
    }
    const capability = await this.resolveCapability(normalized.capability.id, 'capability_stale')
    if (capability.hash !== normalized.capability.hash) throw new AgentActionsServiceError('capability_stale')
    if (requiresLiveProviderModelRevalidation(capability)) {
      await this.assertCurrentModel(normalized.model)
    }
  }

  private asBindingError(error: unknown): AgentActionsServiceError {
    if (error instanceof AgentActionsServiceError && (error.code === 'capability_stale' || error.code === 'model_stale')) {
      return error
    }
    return new AgentActionsServiceError('capability_stale', error)
  }

  private assertLease(action: AgentActionV1, lease: ApprovalLease): void {
    if (this.now().getTime() >= Date.parse(action.approval.expiresAt)) {
      throw new AgentActionsServiceError('approval_expired')
    }
    try {
      assertAgentActionV1(action, this.now().toISOString())
    } catch (error) {
      throw new AgentActionsServiceError('capability_stale', error)
    }
    const expected = {
      actionId: action.id,
      proposalHash: action.proposalHash,
      capabilityHash: action.capability.hash,
      model: action.model.model,
      modelDigest: action.model.digest,
      endpointHash: sha256Canonical(action.model.endpoint),
      scope: action.approval.scope,
      expiresAt: action.approval.expiresAt,
    }
    if (
      lease.actionId !== expected.actionId
      || lease.proposalHash !== expected.proposalHash
      || lease.capabilityHash !== expected.capabilityHash
      || lease.model !== expected.model
      || lease.modelDigest !== expected.modelDigest
      || lease.endpointHash !== expected.endpointHash
      || lease.scope !== expected.scope
      || lease.expiresAt !== expected.expiresAt
      || lease.bindingHash !== sha256Canonical(approvalLeaseBinding(expected))
      || typeof lease.token !== 'string'
      || lease.token.length < 16
    ) {
      throw new AgentActionsServiceError('capability_stale')
    }
  }

  private normalizeExecutorResult(
    value: unknown,
    capability: AgentCapabilitySnapshotV1,
    actionId: string,
  ): NormalizedExecutorResult {
    const result = assertExactRecord(value, ['artifacts', 'rollback'], 'invalid_artifact')
    if (!Array.isArray(result.artifacts) || result.artifacts.length < 1 || result.artifacts.length > MAX_OUTPUT_ARTIFACTS) {
      throw new AgentActionsServiceError('invalid_artifact')
    }
    if (result.rollback !== undefined && typeof result.rollback !== 'function') {
      throw new AgentActionsServiceError('invalid_artifact')
    }
    const ids = new Set<string>()
    const paths = new Set<string>()
    const artifacts = result.artifacts.map((rawArtifact) => {
      let artifact: ArtifactRefV1
      try {
        artifact = assertArtifactRefV1(rawArtifact)
      } catch (error) {
        throw new AgentActionsServiceError('invalid_artifact', error)
      }
      const mcpArtifacts = capability.execution?.kind === 'mcp_tool' ? capability.execution.artifacts : undefined
      const allowedByProcess = capability.execution?.kind === 'process'
        ? capability.execution.artifacts.allowed.some((policy) => policy.kind === artifact.kind
          && policy.mediaTypes.includes(artifact.mediaType)
          && artifact.sizeBytes <= policy.maxBytes)
        : mcpArtifacts
          ? mcpArtifacts.allowed.some((policy) => {
            const pathMatches = mcpArtifacts.profile !== 'relative-files-v1'
              || (typeof policy.path === 'string'
                && artifact.workspacePath === `Workflows/agent-actions/${actionId}/${policy.path}`)
            return pathMatches && policy.kind === artifact.kind
              && policy.mediaTypes.includes(artifact.mediaType)
              && artifact.sizeBytes <= policy.maxBytes
          })
          : artifact.kind === capability.node.output
      if (!allowedByProcess || ids.has(artifact.id) || paths.has(artifact.workspacePath)) {
        throw new AgentActionsServiceError('invalid_artifact')
      }
      ids.add(artifact.id)
      paths.add(artifact.workspacePath)
      return artifact
    })
    if (capability.execution?.kind === 'process') {
      if (artifacts.length > capability.execution.artifacts.maxCount
        || artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) > capability.execution.artifacts.maxTotalBytes) {
        throw new AgentActionsServiceError('invalid_artifact')
      }
    }
    if (capability.execution?.kind === 'mcp_tool' && capability.execution.artifacts) {
      if (artifacts.length > capability.execution.artifacts.maxCount
        || artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) > capability.execution.artifacts.maxTotalBytes) {
        throw new AgentActionsServiceError('invalid_artifact')
      }
      if (capability.execution.artifacts.profile === 'relative-files-v1'
        && capability.execution.artifacts.allowed.some((policy) => policy.required === true
          && (typeof policy.path !== 'string' || !artifacts.some((artifact) => (
            artifact.workspacePath === `Workflows/agent-actions/${actionId}/${policy.path}`
              && artifact.kind === policy.kind
              && policy.mediaTypes.includes(artifact.mediaType)
              && artifact.sizeBytes <= policy.maxBytes
          ))))) {
        throw new AgentActionsServiceError('invalid_artifact')
      }
    }
    if (result.rollback === undefined) return { artifacts }
    const rawRollback = result.rollback as () => unknown
    let rollbackPromise: Promise<void> | undefined
    return {
      artifacts,
      rollback: () => {
        rollbackPromise ??= Promise.resolve().then(async () => { await rawRollback() })
        return rollbackPromise
      },
    }
  }

  private assignMcpArtifactIdentities(
    artifacts: ArtifactRefV1[],
    actionId: string,
  ): ArtifactRefV1[] {
    return artifacts.map((artifact) => {
      if (this.nextMcpArtifactIdentity >= Number.MAX_SAFE_INTEGER) {
        throw new AgentActionsServiceError('invalid_artifact')
      }
      this.nextMcpArtifactIdentity += 1
      return {
        ...artifact,
        id: `mcp-${sha256Canonical({
          schema: 'modly.mcp-artifact-identity.v1',
          actionId,
          sequence: this.nextMcpArtifactIdentity,
        })}`,
      }
    })
  }

  private async verifyArtifacts(
    candidates: ArtifactRefV1[],
    expectedKind: ArtifactRefV1['kind'] | undefined,
    signal: AbortSignal,
  ): Promise<ArtifactRefV1[]> {
    const verifier = this.options.artifactVerifier
    if (!verifier) throw new AgentActionsServiceError('invalid_artifact')
    const verified: ArtifactRefV1[] = []
    for (const candidate of candidates) {
      let authoritative: ArtifactRefV1
      try {
        authoritative = assertArtifactRefV1(await verifier.verify(
          cloneCanonical(candidate),
          expectedKind ?? candidate.kind,
          signal,
        ))
      } catch (error) {
        throw new AgentActionsServiceError('invalid_artifact', error)
      }
      if (canonicalJson(authoritative) !== canonicalJson(candidate)) {
        throw new AgentActionsServiceError('invalid_artifact')
      }
      verified.push(authoritative)
    }
    return verified
  }

  private isExecutionOwned(
    actionId: string,
    generation: number,
    controller: AbortController,
  ): boolean {
    const record = this.actions.get(actionId)
    return record?.action.status === 'executing'
      && record.generation === generation
      && this.controllers.get(actionId) === controller
  }

  private createExecutionSettlement(): ExecutionSettlement {
    let resolve!: () => void
    const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise })
    return {
      promise,
      resolve,
      settled: false,
      executorInvoked: false,
      cancellationRequested: false,
    }
  }

  private requireExecutionSettlement(actionId: string): ExecutionSettlement {
    const settlement = this.executionSettlements.get(actionId)
    if (!settlement) throw new AgentActionsServiceError('internal_error')
    return settlement
  }

  private settleExecution(actionId: string, expected: ExecutionSettlement): void {
    if (expected.settled) return
    expected.settled = true
    if (this.executionSettlements.get(actionId) === expected) this.executionSettlements.delete(actionId)
    expected.resolve()
  }

  private waitForExecutionSettlement(settlement: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.cancellationSettlementTimeoutMs)
      void settlement.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private requireRecord(actionId: string): PrivateActionRecord {
    const record = this.actions.get(actionId)
    if (!record) throw new AgentActionsServiceError('action_not_found')
    return record
  }

  private requireOwnedRecord(actionId: string, originSessionId: string): PrivateActionRecord {
    const record = this.requireRecord(actionId)
    if (record.originSessionId !== originSessionId) throw new AgentActionsServiceError('action_not_found')
    return record
  }

  private toPublic(record: PrivateActionRecord): AgentActionPublicSummaryV1 {
    return toAgentActionPublicSummary(record.action, this.now().toISOString())
  }

  private transition(
    record: PrivateActionRecord,
    nextStatus: AgentActionV1['status'],
    errorSummary?: string,
    outputArtifacts?: ArtifactRefV1[],
  ): void {
    const at = this.monotonicTimestamp(record.action, this.now().getTime())
    record.action = transitionAgentAction(record.action, nextStatus, at, {
      ...(errorSummary ? { errorSummary } : {}),
      ...(outputArtifacts ? { outputArtifacts } : {}),
    })
    record.generation += 1
    stableAction(record)
  }

  private transitionAt(record: PrivateActionRecord, nextStatus: AgentActionV1['status'], at: string): void {
    record.action = transitionAgentAction(record.action, nextStatus, this.monotonicTimestamp(record.action, Date.parse(at)))
    record.generation += 1
    stableAction(record)
  }

  private monotonicTimestamp(action: AgentActionV1, candidateMilliseconds: number): string {
    return new Date(Math.max(candidateMilliseconds, Date.parse(action.updatedAt) + 1)).toISOString()
  }

  private prune(): void {
    const nowMilliseconds = this.now().getTime()
    for (const [actionId, record] of this.actions) {
      if ((record.action.status === 'proposed' || record.action.status === 'approved')
        && nowMilliseconds >= Date.parse(record.action.approval.expiresAt)) {
        this.leases.delete(actionId)
        this.transitionAt(record, 'expired', record.action.approval.expiresAt)
      }
    }

    const terminal = [...this.actions.entries()]
      .filter(([, record]) => isTerminal(record.action))
      .sort((left, right) => left[1].action.updatedAt.localeCompare(right[1].action.updatedAt) || left[0].localeCompare(right[0]))
    for (const [actionId, record] of terminal) {
      if (nowMilliseconds - Date.parse(record.action.updatedAt) >= this.terminalRetentionMs) {
        this.deleteAction(actionId)
      }
    }
    const retainedTerminal = [...this.actions.entries()]
      .filter(([, record]) => isTerminal(record.action))
      .sort((left, right) => left[1].action.updatedAt.localeCompare(right[1].action.updatedAt) || left[0].localeCompare(right[0]))
    while (retainedTerminal.length > this.maxTerminalActions) {
      const oldest = retainedTerminal.shift()
      if (oldest) this.deleteAction(oldest[0])
    }
  }

  private deleteAction(actionId: string): void {
    this.leases.delete(actionId)
    this.controllers.get(actionId)?.abort()
    this.controllers.delete(actionId)
    const settlement = this.executionSettlements.get(actionId)
    if (settlement) this.settleExecution(actionId, settlement)
    this.actions.delete(actionId)
  }

  private deleteController(actionId: string, expected: AbortController | undefined): void {
    if (expected && this.controllers.get(actionId) === expected) this.controllers.delete(actionId)
  }

  private withActionLock<T>(actionId: string, operation: () => T): Promise<T> {
    const previous = this.actionLocks.get(actionId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.actionLocks.set(actionId, tail)
    return result.finally(() => {
      if (this.actionLocks.get(actionId) === tail) this.actionLocks.delete(actionId)
    })
  }
}
