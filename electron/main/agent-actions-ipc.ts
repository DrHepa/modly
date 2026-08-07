import { randomBytes } from 'node:crypto'

import type {
  AgentActionDecisionRequest,
  AgentActionSessionGetRequest,
  AgentActionSessionRequest,
  AgentActionListResult,
  AgentActionMutationResult,
  AgentActionPublicErrorCode,
  AgentActionProposeRequest,
  AgentModelLeaseRequest,
  AgentModelLeaseResult,
  AgentOllamaModelSelectionV1,
  AgentOllamaModelSnapshotV1,
} from '../../src/shared/types/agentActions.ts'
import {
  AgentActionsServiceError,
  type AgentActionsServiceLike,
} from './agent-actions-service.ts'
import { assertAgentOllamaModelSnapshotV1 } from './agent-trust-contracts.ts'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

export interface AgentActionsIpcMainLike {
  handle(channel: string, handler: InvokeHandler): void
}

export interface AgentActionsIpcOptions {
  resolveSelectedModel(selection: AgentOllamaModelSelectionV1): Promise<unknown>
  now?: () => Date
  createModelLeaseId?: () => string
  modelLeaseTtlMs?: number
  maxModelLeases?: number
  maxProposalsPerModelLease?: number
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const DEFAULT_MODEL_LEASE_TTL_MS = 30 * 60 * 1_000
const MAX_MODEL_LEASE_TTL_MS = 30 * 60 * 1_000
const DEFAULT_MAX_MODEL_LEASES = 128
const DEFAULT_MAX_PROPOSALS_PER_MODEL_LEASE = 4

interface PrivateModelLease {
  id: string
  originSessionId: string
  model: AgentOllamaModelSnapshotV1
  expiresAt: string
  proposals: number
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new AgentActionsServiceError('invalid_request')
  const allowed = new Set(keys)
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new AgentActionsServiceError('invalid_request')
  }
  return value
}

function selectedModel(value: unknown): AgentOllamaModelSelectionV1 {
  const record = exactRecord(value, ['provider', 'endpoint', 'model'])
  if (record.provider !== 'ollama' || typeof record.endpoint !== 'string' || typeof record.model !== 'string') {
    throw new AgentActionsServiceError('invalid_request')
  }
  let endpoint: URL
  try { endpoint = new URL(record.endpoint) } catch { throw new AgentActionsServiceError('invalid_request') }
  if (
    endpoint.protocol !== 'http:'
    || !new Set(['127.0.0.1', 'localhost', '[::1]']).has(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.pathname !== '/' && endpoint.pathname !== '')
    || record.model.length < 1 || record.model.length > 200 || record.model.trim() !== record.model
  ) throw new AgentActionsServiceError('invalid_request')
  return { provider: 'ollama', endpoint: endpoint.origin, model: record.model }
}

function rendererProposal(value: unknown): AgentActionProposeRequest {
  const record = exactRecord(value, ['originSessionId', 'capabilityId', 'capabilityHash', 'arguments', 'modelLeaseId'])
  if (
    typeof record.originSessionId !== 'string' || !SAFE_ID.test(record.originSessionId)
    || typeof record.capabilityId !== 'string' || !CAPABILITY_ID.test(record.capabilityId)
    || typeof record.capabilityHash !== 'string' || !SHA256.test(record.capabilityHash)
    || typeof record.modelLeaseId !== 'string' || !SAFE_ID.test(record.modelLeaseId)
  ) {
    throw new AgentActionsServiceError('invalid_request')
  }
  return {
    originSessionId: record.originSessionId,
    capabilityId: record.capabilityId,
    capabilityHash: record.capabilityHash,
    arguments: record.arguments as never,
    modelLeaseId: record.modelLeaseId,
  }
}

function session(value: unknown): AgentActionSessionRequest {
  const record = exactRecord(value, ['originSessionId'])
  if (typeof record.originSessionId !== 'string' || !SAFE_ID.test(record.originSessionId)) {
    throw new AgentActionsServiceError('invalid_request')
  }
  return { originSessionId: record.originSessionId }
}

function sessionAction(value: unknown): AgentActionSessionGetRequest {
  const record = exactRecord(value, ['actionId', 'originSessionId'])
  if (
    typeof record.actionId !== 'string' || !SAFE_ID.test(record.actionId)
    || typeof record.originSessionId !== 'string' || !SAFE_ID.test(record.originSessionId)
  ) throw new AgentActionsServiceError('invalid_request')
  return { actionId: record.actionId, originSessionId: record.originSessionId }
}

function decision(value: unknown): AgentActionDecisionRequest {
  const record = exactRecord(value, ['actionId', 'originSessionId', 'decision'])
  const action = sessionAction({ actionId: record.actionId, originSessionId: record.originSessionId })
  if (record.decision !== 'approve' && record.decision !== 'reject') {
    throw new AgentActionsServiceError('invalid_request')
  }
  return { ...action, decision: record.decision }
}

function modelLeaseRequest(value: unknown): AgentModelLeaseRequest {
  const record = exactRecord(value, ['originSessionId', 'model'])
  const origin = session({ originSessionId: record.originSessionId })
  return { ...origin, model: selectedModel(record.model) }
}

function publicError(error: unknown): { code: AgentActionPublicErrorCode } {
  return {
    code: error instanceof AgentActionsServiceError ? error.code : 'internal_error',
  }
}

async function mutate(operation: () => ReturnType<AgentActionsServiceLike['propose']>): Promise<AgentActionMutationResult> {
  try {
    return { ok: true, action: await operation() }
  } catch (error) {
    return { ok: false, error: publicError(error) }
  }
}

export function registerAgentActionsIpcHandlers(
  ipcMain: AgentActionsIpcMainLike,
  service: AgentActionsServiceLike,
  options: AgentActionsIpcOptions,
): void {
  const now = options.now ?? (() => new Date())
  const createModelLeaseId = options.createModelLeaseId ?? (() => randomBytes(24).toString('base64url'))
  const modelLeaseTtlMs = options.modelLeaseTtlMs ?? DEFAULT_MODEL_LEASE_TTL_MS
  const maxModelLeases = options.maxModelLeases ?? DEFAULT_MAX_MODEL_LEASES
  const maxProposalsPerModelLease = options.maxProposalsPerModelLease ?? DEFAULT_MAX_PROPOSALS_PER_MODEL_LEASE
  if (!Number.isSafeInteger(modelLeaseTtlMs) || modelLeaseTtlMs <= 0 || modelLeaseTtlMs > MAX_MODEL_LEASE_TTL_MS) {
    throw new TypeError('modelLeaseTtlMs must be a positive safe integer no greater than 30 minutes')
  }
  if (!Number.isSafeInteger(maxModelLeases) || maxModelLeases <= 0 || maxModelLeases > 1_024) {
    throw new TypeError('maxModelLeases must be a bounded positive safe integer')
  }
  if (!Number.isSafeInteger(maxProposalsPerModelLease) || maxProposalsPerModelLease <= 0 || maxProposalsPerModelLease > 16) {
    throw new TypeError('maxProposalsPerModelLease must be a bounded positive safe integer')
  }
  const modelLeases = new Map<string, PrivateModelLease>()
  const nowMilliseconds = (): number => {
    const milliseconds = now().getTime()
    if (!Number.isFinite(milliseconds)) throw new AgentActionsServiceError('internal_error')
    return milliseconds
  }
  const pruneModelLeases = (milliseconds: number): void => {
    for (const [id, lease] of modelLeases) {
      if (milliseconds >= Date.parse(lease.expiresAt)) modelLeases.delete(id)
    }
  }

  ipcMain.handle('agentActions:leaseModel', async (_event, request): Promise<AgentModelLeaseResult> => {
    try {
      const selected = modelLeaseRequest(request)
      let model: AgentOllamaModelSnapshotV1
      try {
        model = assertAgentOllamaModelSnapshotV1(await options.resolveSelectedModel(selected.model))
      } catch (error) {
        if (error instanceof AgentActionsServiceError) throw error
        throw new AgentActionsServiceError('model_stale', error)
      }
      if (model.endpoint !== selected.model.endpoint || model.model !== selected.model.model) {
        throw new AgentActionsServiceError('model_stale')
      }
      const milliseconds = nowMilliseconds()
      pruneModelLeases(milliseconds)
      if (modelLeases.size >= maxModelLeases) throw new AgentActionsServiceError('capacity_exceeded')
      const id = createModelLeaseId()
      if (typeof id !== 'string' || !SAFE_ID.test(id) || modelLeases.has(id)) {
        throw new AgentActionsServiceError('internal_error')
      }
      const expiresAt = new Date(milliseconds + modelLeaseTtlMs).toISOString()
      modelLeases.set(id, {
        id,
        originSessionId: selected.originSessionId,
        model: Object.freeze({ ...model }),
        expiresAt,
        proposals: 0,
      })
      return { ok: true, lease: { id, expiresAt } }
    } catch (error) {
      return { ok: false, error: publicError(error) }
    }
  })

  ipcMain.handle('agentActions:propose', (_event, request) => mutate(async () => {
    const proposal = rendererProposal(request)
    const milliseconds = nowMilliseconds()
    pruneModelLeases(milliseconds)
    const lease = modelLeases.get(proposal.modelLeaseId)
    if (!lease || lease.originSessionId !== proposal.originSessionId) {
      throw new AgentActionsServiceError('model_stale')
    }
    if (lease.proposals >= maxProposalsPerModelLease) {
      throw new AgentActionsServiceError('capacity_exceeded')
    }
    // Reserve before dispatch so concurrent proposals cannot oversubscribe a
    // lease. The stored snapshot was minted by main; AgentActionsService owns
    // the central capability-specific live-model revalidation policy.
    lease.proposals += 1
    return service.propose({
      originSessionId: proposal.originSessionId,
      capabilityId: proposal.capabilityId,
      capabilityHash: proposal.capabilityHash,
      arguments: proposal.arguments,
      model: { ...lease.model },
    })
  }))
  ipcMain.handle('agentActions:get', (_event, request) => mutate(() => service.get(sessionAction(request))))
  ipcMain.handle('agentActions:list', async (_event, request): Promise<AgentActionListResult> => {
    try {
      return { ok: true, actions: await service.list(session(request)) }
    } catch (error) {
      return { ok: false, error: publicError(error) }
    }
  })
  ipcMain.handle('agentActions:decide', (_event, request) => mutate(() => service.decide(decision(request))))
  ipcMain.handle('agentActions:execute', (_event, request) => mutate(() => service.execute(sessionAction(request))))
  ipcMain.handle('agentActions:cancel', (_event, request) => mutate(() => service.cancel(sessionAction(request))))
}
