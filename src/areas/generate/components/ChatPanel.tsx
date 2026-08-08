import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useAgentStore } from '@shared/stores/agentStore'
import { useWorkflowsStore } from '@shared/stores/workflowsStore'
import { useAgentSessionsStore } from '@shared/stores/agentSessionsStore'
import { parseOllamaModelNames } from '@shared/utils/agentModels'
import AgentSessionHistory from './AgentSessionHistory'

export { parseOllamaModelNames }

// ─── Types ────────────────────────────────────────────────────────────────────

import type { ThinkingMode } from '@shared/stores/agentStore'
import type { Workflow } from '@shared/types/electron.d'
import type {
  AgentAttachmentRef,
  AgentGovernedActionTerminalSummary,
  AgentGovernedTerminalStatus,
  AgentSessionMessage,
  AgentSessionSummary,
} from '@shared/types/agentSessions'
import type {
  AgentActionMutationResult,
  AgentActionProposeRequest,
  AgentActionPublicErrorCode,
  AgentActionPublicSummaryV1,
  AgentActionStatus,
  AgentActionsApi,
  AgentCapabilityInventoryResult,
  AgentCapabilitySnapshotV1,
  AgentOllamaModelSelectionV1,
  JsonValue,
} from '@shared/types/agentActions'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  imageDataUrls?: string[]
  actions?: ActionDone[]
  summaries?: AgentSessionSummary[]
}

interface PendingAttachment {
  file: File
  dataUrl: string
}

export interface SessionGovernedAction {
  originSessionId: string
  action: AgentActionPublicSummaryV1
  busyCommand?: GovernedActionCommand
  error?: string
}

type WorkflowDraft = Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>

type ActionPayload =
  | { type: 'mesh_update'; url: string; face_count?: number }
  | { type: 'run_workflow'; workflow_id: string; workflow_name: string }
  | { type: 'create_workflow'; workflow: WorkflowDraft }

export interface ActionDone {
  tool: string
  result: string
  payload?: ActionPayload | null
}

interface AgentChatData {
  message: string
  actions: ActionDone[]
  proposals: AgentActionProposal[]
  thinking?: string
}

export interface AgentActionProposal {
  type: 'action_proposal'
  capabilityId: string
  capabilityHash: string
  modelLeaseId: string
  arguments: Record<string, JsonValue>
}

export interface AgentCapabilityPromptInputHint {
  path: string
  type: string
  required: boolean
  description: string
  options?: Array<string | number>
}

export interface AgentCapabilityPromptView {
  id: string
  hash: string
  name: string
  description: string
  inputHints: AgentCapabilityPromptInputHint[]
}

const MAX_AGENT_PROPOSALS = 4
const MAX_AGENT_CAPABILITIES = 32
const MAX_AGENT_CAPABILITY_BYTES = 32 * 1024
const MAX_AGENT_JSON_BYTES = 16 * 1024
const UNSAFE_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const GOVERNED_TERMINAL_STATUSES = new Set<AgentActionStatus>([
  'rejected', 'expired', 'completed', 'failed', 'cancelled',
])

function isGovernedTerminalStatus(status: AgentActionStatus): status is AgentGovernedTerminalStatus {
  return GOVERNED_TERMINAL_STATUSES.has(status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 4) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((entry) => isBoundedJson(entry, depth + 1))
  if (!isRecord(value)) return false
  return Reflect.ownKeys(value).every((key) => (
    typeof key === 'string'
    && key.length > 0
    && key.length <= 128
    && !UNSAFE_JSON_KEYS.has(key)
    && isBoundedJson(value[key], depth + 1)
  ))
}

function boundedJsonObject(value: unknown): Record<string, JsonValue> | null {
  if (!isRecord(value) || !isBoundedJson(value)) return null
  try {
    const encoded = JSON.stringify(value)
    if (new TextEncoder().encode(encoded).byteLength > MAX_AGENT_JSON_BYTES) return null
    return JSON.parse(encoded) as Record<string, JsonValue>
  } catch {
    return null
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.has(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isWorkflowDraft(value: unknown): value is WorkflowDraft {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && Array.isArray(value.nodes)
    && Array.isArray(value.edges)
}

function parseAction(value: unknown): ActionDone | null {
  if (!isRecord(value) || typeof value.tool !== 'string' || !value.tool.trim() || typeof value.result !== 'string') {
    return null
  }

  if (value.payload === undefined) return { tool: value.tool, result: value.result }
  if (value.payload === null) return { tool: value.tool, result: value.result, payload: null }
  if (!isRecord(value.payload) || typeof value.payload.type !== 'string') return null

  const payload = value.payload
  if (payload.type === 'mesh_update') {
    if (
      typeof payload.url !== 'string'
      || !payload.url.trim()
      || (payload.face_count !== undefined && (typeof payload.face_count !== 'number' || !Number.isFinite(payload.face_count)))
    ) return null
    return {
      tool: value.tool,
      result: value.result,
      payload: {
        type: 'mesh_update',
        url: payload.url,
        ...(typeof payload.face_count === 'number' ? { face_count: payload.face_count } : {}),
      },
    }
  }
  if (payload.type === 'run_workflow') {
    if (
      typeof payload.workflow_id !== 'string'
      || !payload.workflow_id.trim()
      || typeof payload.workflow_name !== 'string'
      || !payload.workflow_name.trim()
    ) return null
    return {
      tool: value.tool,
      result: value.result,
      payload: {
        type: 'run_workflow',
        workflow_id: payload.workflow_id,
        workflow_name: payload.workflow_name,
      },
    }
  }
  if (payload.type === 'create_workflow' && isWorkflowDraft(payload.workflow)) {
    return {
      tool: value.tool,
      result: value.result,
      payload: { type: 'create_workflow', workflow: payload.workflow },
    }
  }
  return null
}

function parseActions(value: unknown): { actions: ActionDone[]; valid: boolean } {
  if (value === undefined) return { actions: [], valid: true }
  if (!Array.isArray(value)) return { actions: [], valid: false }

  const actions: ActionDone[] = []
  let valid = true
  for (const valueAction of value) {
    const action = parseAction(valueAction)
    if (action) actions.push(action)
    else valid = false
  }
  return { actions, valid }
}

function parseProposal(value: unknown): AgentActionProposal | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'type', 'capabilityId', 'capabilityHash', 'modelLeaseId', 'arguments',
  ])) return null
  if (
    value.type !== 'action_proposal'
    || typeof value.capabilityId !== 'string'
    || !CAPABILITY_ID_PATTERN.test(value.capabilityId)
    || value.capabilityId.split('/').some((segment) => UNSAFE_JSON_KEYS.has(segment))
    || typeof value.capabilityHash !== 'string'
    || !HASH_PATTERN.test(value.capabilityHash)
    || typeof value.modelLeaseId !== 'string'
    || !OPAQUE_ID_PATTERN.test(value.modelLeaseId)
  ) return null
  const argumentsValue = boundedJsonObject(value.arguments)
  return argumentsValue ? {
    type: 'action_proposal',
    capabilityId: value.capabilityId,
    capabilityHash: value.capabilityHash,
    modelLeaseId: value.modelLeaseId,
    arguments: argumentsValue,
  } : null
}

function parseProposals(value: unknown): { proposals: AgentActionProposal[]; valid: boolean } {
  if (value === undefined) return { proposals: [], valid: true }
  if (!Array.isArray(value) || value.length > MAX_AGENT_PROPOSALS) return { proposals: [], valid: false }
  const proposals = value.map(parseProposal)
  if (proposals.some((proposal) => proposal === null)) return { proposals: [], valid: false }
  return { proposals: proposals as AgentActionProposal[], valid: true }
}

export class AgentApiError extends Error {
  readonly actions: ActionDone[]
  readonly proposals: AgentActionProposal[]

  constructor(message: string, actions: ActionDone[], proposals: AgentActionProposal[] = []) {
    super(message)
    this.name = 'AgentApiError'
    this.actions = actions
    this.proposals = proposals
  }
}

export class AgentAttachmentRollbackError extends Error {
  readonly code = 'agent_attachment_rollback_failed'
  readonly recoverable = true

  constructor(cause: unknown) {
    super('The message was not saved, and its staged attachments could not be removed. Please retry cleanup before sending again.', { cause })
    this.name = 'AgentAttachmentRollbackError'
  }
}

export async function rollbackFailedSendAttachments(
  attachmentIds: string[],
  removeAttachments: (attachmentIds: string[]) => Promise<void>,
): Promise<void> {
  if (attachmentIds.length === 0) return
  try {
    await removeAttachments(attachmentIds)
  } catch (error) {
    throw new AgentAttachmentRollbackError(error)
  }
}

export async function parseAgentChatResponse(
  response: Pick<Response, 'ok' | 'status' | 'json'>,
): Promise<AgentChatData> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (!response.ok) {
      throw new AgentApiError('Modly could not complete the request. Please try again.', [])
    }
    throw new Error('Modly returned an invalid agent response.')
  }

  if (!response.ok) {
    const detail = isRecord(body) && isRecord(body.detail) ? body.detail : null
    const safeMessage = detail && typeof detail.message === 'string' && detail.message.trim()
      ? detail.message.trim().slice(0, 500)
      : 'Modly could not complete the request. Please try again.'
    throw new AgentApiError(
      safeMessage,
      parseActions(detail?.actions).actions,
      parseProposals(detail?.proposals).proposals,
    )
  }

  if (!isRecord(body) || typeof body.message !== 'string') {
    throw new Error('Modly returned an invalid agent response.')
  }
  if (body.thinking !== undefined && body.thinking !== null && typeof body.thinking !== 'string') {
    throw new Error('Modly returned an invalid agent response.')
  }
  const parsedActions = parseActions(body.actions)
  const parsedProposals = parseProposals(body.proposals)
  if (!parsedActions.valid || !parsedProposals.valid) throw new Error('Modly returned an invalid agent response.')

  return {
    message: body.message,
    actions: parsedActions.actions,
    proposals: parsedProposals.proposals,
    ...(typeof body.thinking === 'string' ? { thinking: body.thinking } : {}),
  }
}

export interface AgentActionFailure {
  action: ActionDone
  error: unknown
}

export async function applyAgentActions(
  actions: ActionDone[],
  applyAction: (action: ActionDone) => void | Promise<void>,
): Promise<AgentActionFailure[]> {
  const failures: AgentActionFailure[] = []
  for (const action of actions) {
    try {
      await applyAction(action)
    } catch (error) {
      failures.push({ action, error })
    }
  }
  return failures
}

export const GOVERNED_ACTION_REQUIRED_CODE = 'governed_action_required'
export const GOVERNED_ACTION_REQUIRED_MESSAGE = 'This action requires approval before Modly can apply it.'

export class GovernedActionRequiredError extends Error {
  readonly code = GOVERNED_ACTION_REQUIRED_CODE
  readonly recoverable = true

  constructor() {
    super(GOVERNED_ACTION_REQUIRED_MESSAGE)
    this.name = 'GovernedActionRequiredError'
  }
}

export function rejectUngovernedAgentAction(action: ActionDone): void {
  if (action.payload) throw new GovernedActionRequiredError()
}

function governedActionFailure(failures: AgentActionFailure[]): GovernedActionRequiredError | null {
  const failure = failures.find(({ error }) => (
    error instanceof GovernedActionRequiredError
    || (isRecord(error) && error.code === GOVERNED_ACTION_REQUIRED_CODE)
  ))
  return failure ? new GovernedActionRequiredError() : null
}

export function withActionFailureSummary(message: string, failureCount: number): string {
  if (failureCount <= 0) return message
  return `${message} ${failureCount} completed action${failureCount === 1 ? '' : 's'} could not be reflected locally.`
}

function displayText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maxLength) return null
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  }) ? null : value
}

function parameterHint(param: JsonValue): AgentCapabilityPromptInputHint | null {
  if (!isRecord(param)) return null
  const id = displayText(param.id, 128)
  const type = displayText(param.type, 32)
  if (!id || !type || UNSAFE_JSON_KEYS.has(id) || !['select', 'int', 'float', 'string', 'boolean'].includes(type)) return null
  const label = displayText(param.label, 120) ?? id.replace(/[._-]+/g, ' ')
  const description = displayText(param.tooltip, 300) ?? label.replace(/^./, (value) => value.toUpperCase())
  const options = type === 'select' && Array.isArray(param.options)
    ? param.options.flatMap((option) => {
        if (!isRecord(option)) return []
        const value = option.value
        return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? [value] : []
      }).slice(0, 32)
    : undefined
  return {
    path: `params.${id}`,
    type,
    required: false,
    description,
    ...(options?.length ? { options } : {}),
  }
}

function mcpInputHints(capability: AgentCapabilitySnapshotV1): AgentCapabilityPromptInputHint[] {
  if (capability.execution?.kind !== 'mcp_tool') return []
  const schema = capability.execution.inputSchema
  if (!isRecord(schema) || !isRecord(schema.properties)) return []
  const properties = schema.properties
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [])
  return Object.keys(properties).sort().flatMap((id) => {
    if (UNSAFE_JSON_KEYS.has(id) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return []
    const property = properties[id]
    if (!isRecord(property)) return []
    const rawType = property.type
    const type = rawType === 'integer' ? 'int' : rawType === 'number' ? 'float' : rawType
    if (typeof type !== 'string' || !['string', 'int', 'float', 'boolean'].includes(type)) return []
    const description = displayText(property.description, 300)
      ?? displayText(property.title, 120)
      ?? id.replace(/[._-]+/g, ' ').replace(/^./, (value) => value.toUpperCase())
    const options = Array.isArray(property.enum)
      ? property.enum.filter((value): value is string | number => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))).slice(0, 32)
      : undefined
    return [{
      path: `arguments.${id}`,
      type,
      required: required.has(id),
      description,
      ...(options?.length ? { options } : {}),
    }]
  }).slice(0, 32)
}

export function buildAgentCapabilityPromptInventory(inventory: AgentCapabilityInventoryResult): AgentCapabilityPromptView[] {
  if (!inventory || !Array.isArray(inventory.capabilities) || inventory.capabilities.length > MAX_AGENT_CAPABILITIES) {
    throw new Error('Agent capability inventory exceeds its safe bounds.')
  }
  const views = inventory.capabilities.map((capability): AgentCapabilityPromptView => {
    const id = displayText(capability.id, 257)
    const name = displayText(capability.displayName, 80)
    const description = displayText(capability.description, 500)
    if (
      !id || !CAPABILITY_ID_PATTERN.test(id) || id.split('/').some((segment) => UNSAFE_JSON_KEYS.has(segment))
      || !HASH_PATTERN.test(capability.hash) || !name || !description
    ) throw new Error('Agent capability inventory contains an invalid entry.')
    const inputHints = capability.execution?.kind === 'mcp_tool'
      ? mcpInputHints(capability)
      : [
          ...(capability.node.inputs?.map((input) => ({
            path: `input.${input.name}`,
            type: input.type,
            required: input.required !== false,
            description: displayText(input.label, 120) ?? `${input.type.replace(/^./, (value) => value.toUpperCase())} input`,
          })) ?? [{
            path: 'input',
            type: capability.node.input,
            required: true,
            description: `${capability.node.input.replace(/^./, (value) => value.toUpperCase())} input`,
          }]),
          ...capability.node.paramsSchema.flatMap((param) => {
            const hint = parameterHint(param)
            return hint ? [hint] : []
          }),
        ].slice(0, 32)
    return { id, hash: capability.hash, name, description, inputHints }
  }).sort((left, right) => left.id.localeCompare(right.id))
  if (new Set(views.map((view) => view.id)).size !== views.length || new Set(views.map((view) => view.hash)).size !== views.length) {
    throw new Error('Agent capability inventory contains a collision.')
  }
  if (new TextEncoder().encode(JSON.stringify(views)).byteLength > MAX_AGENT_CAPABILITY_BYTES) {
    throw new Error('Agent capability inventory exceeds its safe bounds.')
  }
  return views
}

export function normalizeLocalOllamaEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256) return null
  try {
    const endpoint = new URL(value)
    if (
      endpoint.protocol !== 'http:'
      || !new Set(['127.0.0.1', 'localhost', '[::1]']).has(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.pathname !== '/' && endpoint.pathname !== '')
    ) return null
    return endpoint.origin
  } catch {
    return null
  }
}

export interface GovernedActionHandoffError {
  code: string
  message: string
}

export interface GovernedProposalResolution {
  kind: 'accepted' | 'compensated' | 'ignored'
  error?: GovernedActionHandoffError
}

export interface GovernedProposalLease {
  resolve(
    action: AgentActionPublicSummaryV1,
    accept: (action: AgentActionPublicSummaryV1) => boolean,
    compensate: (action: AgentActionPublicSummaryV1) => Promise<GovernedActionHandoffError | null>,
  ): Promise<GovernedProposalResolution>
  reject(): void
}

export interface GovernedProposalTracker {
  track(originSessionId: string, isCurrent: () => boolean): GovernedProposalLease
  invalidateOrigin(originSessionId: string): void
  invalidateAll(): void
  size(): number
}

export function createGovernedProposalTracker(): GovernedProposalTracker {
  interface Entry {
    originSessionId: string
    isCurrent: () => boolean
    invalidated: boolean
    settled: boolean
  }
  const entries = new Set<Entry>()
  return {
    track(originSessionId, isCurrent) {
      const entry: Entry = { originSessionId, isCurrent, invalidated: false, settled: false }
      entries.add(entry)
      const finish = () => {
        if (entry.settled) return false
        entry.settled = true
        entries.delete(entry)
        return true
      }
      return {
        async resolve(action, accept, compensate) {
          if (!finish()) return { kind: 'ignored' }
          let accepted = false
          if (!entry.invalidated && entry.isCurrent()) {
            try { accepted = accept(action) } catch { accepted = false }
          }
          if (accepted) return { kind: 'accepted' }
          try {
            const error = await compensate(action)
            return { kind: 'compensated', ...(error ? { error } : {}) }
          } catch {
            return {
              kind: 'compensated',
              error: { code: 'internal_error', message: 'A late governed proposal remains hidden and will expire automatically.' },
            }
          }
        },
        reject() { finish() },
      }
    },
    invalidateOrigin(originSessionId) {
      for (const entry of entries) {
        if (entry.originSessionId === originSessionId) entry.invalidated = true
      }
    },
    invalidateAll() {
      for (const entry of entries) entry.invalidated = true
    },
    size() { return entries.size },
  }
}

const GOVERNED_RECONCILE_INTERVAL_MS = 250
const GOVERNED_RECONCILE_HARD_TIMEOUT_MS = 10 * 60 * 1_000

export async function reconcileGovernedActionUntilTerminal(input: {
  actionId: string
  originSessionId: string
  list: AgentActionsApi['list']
  wait?: (milliseconds: number) => Promise<void>
  now?: () => number
  shouldContinue?: () => boolean
  hardTimeoutMs?: number
}): Promise<AgentActionPublicSummaryV1 | null> {
  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, milliseconds)
  }))
  const now = input.now ?? Date.now
  const startedAt = now()
  if (!Number.isFinite(startedAt)) return null
  const requestedHardTimeout = input.hardTimeoutMs
  const hardTimeoutMs = Number.isSafeInteger(requestedHardTimeout) && (requestedHardTimeout ?? 0) > 0
    ? Math.min(requestedHardTimeout as number, GOVERNED_RECONCILE_HARD_TIMEOUT_MS)
    : GOVERNED_RECONCILE_HARD_TIMEOUT_MS
  const hardDeadline = startedAt + hardTimeoutMs
  let actionDeadline = hardDeadline
  while (true) {
    if (input.shouldContinue && !input.shouldContinue()) return null
    const beforePoll = now()
    if (!Number.isFinite(beforePoll) || beforePoll > hardDeadline) return null
    try {
      const result = await input.list({ originSessionId: input.originSessionId })
      if (result.ok) {
        const action = result.actions.find((candidate) => candidate.id === input.actionId)
        if (!action) return null
        if (isGovernedTerminalStatus(action.status)) return action
        if (action.status === 'proposed' || action.status === 'approved') {
          const expiresAt = Date.parse(action.approval.expiresAt)
          if (!Number.isFinite(expiresAt)) return null
          actionDeadline = Math.min(hardDeadline, expiresAt)
        } else {
          actionDeadline = hardDeadline
        }
      } else if (result.error.code === 'action_not_found') {
        return null
      }
    } catch {
      // A transient IPC failure is retried within the bounded reconciliation window.
    }
    const afterPoll = now()
    if (!Number.isFinite(afterPoll) || afterPoll >= actionDeadline) return null
    const delayMs = Math.min(GOVERNED_RECONCILE_INTERVAL_MS, actionDeadline - afterPoll)
    if (delayMs <= 0) return null
    await wait(delayMs)
  }
}

export async function compensateLateGovernedProposal(input: {
  action: AgentActionPublicSummaryV1
  originSessionId: string
  sessionExists: () => boolean
  isOriginActive: () => boolean
  cancel: AgentActionsApi['cancel']
  get: AgentActionsApi['get']
  list: AgentActionsApi['list']
  reject: AgentActionsApi['decide']
  reconcileWait?: (milliseconds: number) => Promise<void>
  reconcileNow?: () => number
  reconcileHardTimeoutMs?: number
  persistTerminal: (action: AgentActionPublicSummaryV1) => Promise<void>
  reportError: (message: string) => void
}): Promise<{ kind: 'terminal' | 'pending' }> {
  const actionId = input.action.id
  let latest: AgentActionPublicSummaryV1 | null = null
  try {
    const cancelled = await input.cancel({ actionId, originSessionId: input.originSessionId })
    if (cancelled.ok && cancelled.action.id === actionId) latest = cancelled.action
  } catch {
    // Resolve authoritative state below; never recover by exposing the proposal.
  }

  if (!latest) {
    try {
      const refreshed = await input.get({ actionId, originSessionId: input.originSessionId })
      if (refreshed.ok && refreshed.action.id === actionId) latest = refreshed.action
    } catch {
      // Main expiry remains the final fallback when the state cannot be resolved.
    }
  }

  if (latest?.status === 'proposed') {
    try {
      const rejected = await input.reject({
        actionId,
        originSessionId: input.originSessionId,
        decision: 'reject',
      })
      if (rejected.ok && rejected.action.id === actionId) latest = rejected.action
    } catch {
      // Keep the proposal hidden and rely on its bounded main-process expiry.
    }
  }

  if (!latest || !isGovernedTerminalStatus(latest.status)) {
    const reconciled = await reconcileGovernedActionUntilTerminal({
      actionId,
      originSessionId: input.originSessionId,
      list: input.list,
      shouldContinue: input.sessionExists,
      wait: input.reconcileWait,
      now: input.reconcileNow,
      hardTimeoutMs: input.reconcileHardTimeoutMs,
    })
    if (reconciled) latest = reconciled
  }

  if (latest && isGovernedTerminalStatus(latest.status)) {
    if (input.sessionExists()) {
      try {
        await input.persistTerminal(latest)
      } catch {
        if (input.isOriginActive()) {
          input.reportError('A late governed action finished, but its terminal summary could not be saved.')
        }
      }
    }
    return { kind: 'terminal' }
  }

  if (input.isOriginActive()) {
    input.reportError('A late governed proposal remains hidden and will expire automatically because cancellation is still pending.')
  }
  return { kind: 'pending' }
}

function governedActionErrorMessage(code: string): string {
  if (code === 'model_stale') return 'The selected Ollama model changed or its digest is unavailable. Select the model again.'
  if (code === 'capability_stale' || code === 'capability_not_found') return 'This capability changed or is no longer available. Refresh and try again.'
  if (code === 'invalid_arguments') return 'The proposed arguments are not valid for this capability.'
  if (code === 'capacity_exceeded') return 'Too many governed actions are pending. Finish or reject one before proposing another.'
  return 'Modly could not create this governed action proposal.'
}

function governedActionCommandErrorMessage(code: AgentActionPublicErrorCode): string {
  if (code === 'action_not_found') return 'This governed action is no longer available.'
  if (code === 'approval_expired') return 'This approval expired. Ask the Agent to propose the action again.'
  if (code === 'invalid_state') return 'This governed action is no longer in the expected state.'
  if (code === 'execution_failed') return 'The governed action failed. No unverified output was accepted.'
  if (code === 'cancellation_pending') return 'Cancellation is still being settled. You can retry in a moment.'
  if (code === 'executor_unavailable' || code === 'sandbox_unavailable') return 'The governed executor is unavailable.'
  if (code === 'capability_stale' || code === 'capability_not_found') return governedActionErrorMessage(code)
  if (code === 'model_stale') return governedActionErrorMessage(code)
  return 'Modly could not update this governed action.'
}

export async function proposeGovernedAgentActions(input: {
  proposals: AgentActionProposal[]
  originSessionId: string
  modelLeaseId: string
  isCurrent: () => boolean
  propose: (request: AgentActionProposeRequest) => Promise<AgentActionMutationResult>
  tracker?: GovernedProposalTracker
  acceptAction?: (action: AgentActionPublicSummaryV1) => boolean
  compensate?: (action: AgentActionPublicSummaryV1) => Promise<GovernedActionHandoffError | null>
}): Promise<{ actions: AgentActionPublicSummaryV1[], errors: GovernedActionHandoffError[] }> {
  const actions: AgentActionPublicSummaryV1[] = []
  const errors: GovernedActionHandoffError[] = []
  const tracker = input.tracker ?? createGovernedProposalTracker()
  if (!OPAQUE_ID_PATTERN.test(input.modelLeaseId)) {
    return { actions, errors: [{ code: 'model_stale', message: governedActionErrorMessage('model_stale') }] }
  }
  for (const proposal of input.proposals.slice(0, MAX_AGENT_PROPOSALS)) {
    if (!input.isCurrent()) break
    if (proposal.modelLeaseId !== input.modelLeaseId) {
      errors.push({ code: 'model_stale', message: governedActionErrorMessage('model_stale') })
      continue
    }
    const lease = tracker.track(input.originSessionId, input.isCurrent)
    try {
      const result = await input.propose({
        originSessionId: input.originSessionId,
        capabilityId: proposal.capabilityId,
        capabilityHash: proposal.capabilityHash,
        arguments: proposal.arguments,
        modelLeaseId: proposal.modelLeaseId,
      })
      if (result.ok) {
        const resolution = await lease.resolve(
          result.action,
          (action) => {
            if (!input.isCurrent()) return false
            return input.acceptAction ? input.acceptAction(action) : true
          },
          input.compensate ?? (async () => ({
            code: 'internal_error',
            message: 'A late governed proposal remains hidden and will expire automatically.',
          })),
        )
        if (resolution.kind === 'accepted') actions.push(result.action)
        if (resolution.error) errors.push(resolution.error)
      } else {
        lease.reject()
        if (input.isCurrent()) errors.push({ code: result.error.code, message: governedActionErrorMessage(result.error.code) })
      }
    } catch {
      lease.reject()
      if (input.isCurrent()) errors.push({ code: 'internal_error', message: governedActionErrorMessage('internal_error') })
    }
  }
  return { actions, errors }
}

export type GovernedActionCommand = 'approve' | 'reject' | 'run' | 'cancel' | 'refresh'

export async function invokeGovernedActionCommand(
  command: GovernedActionCommand,
  actionId: string,
  originSessionId: string,
  getActiveSessionId: () => string | null,
  api: Pick<AgentActionsApi, 'get' | 'decide' | 'execute' | 'cancel'>,
): Promise<AgentActionMutationResult> {
  if (getActiveSessionId() !== originSessionId) throw new Error('The originating Agent session is no longer active.')
  if (command === 'refresh') return api.get({ actionId, originSessionId })
  if (command === 'approve' || command === 'reject') {
    return api.decide({ actionId, originSessionId, decision: command === 'approve' ? 'approve' : 'reject' })
  }
  if (command === 'run') return api.execute({ actionId, originSessionId })
  return api.cancel({ actionId, originSessionId })
}

export function createKeyedOperationGate() {
  const pending = new Set<string>()
  return {
    async run<T>(key: string, operation: () => Promise<T>): Promise<T | undefined> {
      if (pending.has(key)) return undefined
      pending.add(key)
      try { return await operation() }
      finally { pending.delete(key) }
    },
  }
}

export function buildGovernedTerminalSummary(
  action: AgentActionPublicSummaryV1,
): AgentGovernedActionTerminalSummary | null {
  if (!isGovernedTerminalStatus(action.status)) return null
  return {
    kind: 'governed-action',
    label: `${action.capability.displayName} ${action.status}`,
    governedAction: {
      status: action.status,
      capability: action.capability.displayName,
      model: action.model.model,
      outputs: action.outputs.map((output) => ({
        kind: output.kind,
        sha256: output.sha256,
        sizeBytes: output.sizeBytes,
      })),
    },
  }
}

export function planGovernedSessionSwitch<T extends {
  originSessionId: string
  action: { id: string, status: AgentActionStatus }
}>(entries: readonly T[], previousSessionId: string | null, nextSessionId: string | null): {
  cancelActionIds: string[]
  retained: T[]
} {
  return {
    cancelActionIds: previousSessionId === null
      ? []
      : entries
          .filter((entry) => entry.originSessionId === previousSessionId && !isGovernedTerminalStatus(entry.action.status))
          .map((entry) => entry.action.id),
    retained: nextSessionId === null ? [] : entries.filter((entry) => entry.originSessionId === nextSessionId),
  }
}

export function createSubmissionGate() {
  let busy = false
  return {
    async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined
      busy = true
      try { return await operation() }
      finally { busy = false }
    },
  }
}

export interface OriginBoundUiToken {
  isCurrent(): boolean
  run(update: () => void): void
}

export function createOriginBoundUiGate(getActiveSessionId: () => string | null) {
  let generation = 0
  return {
    begin(sessionId: string): OriginBoundUiToken {
      const originGeneration = generation
      const isCurrent = () => generation === originGeneration && getActiveSessionId() === sessionId
      return {
        isCurrent,
        run(update: () => void): void {
          if (isCurrent()) update()
        },
      }
    },
    invalidate(): void {
      generation += 1
    },
  }
}

export function createSessionRestoreCoordinator<T>(update: (messages: T[]) => void) {
  let generation = 0
  return {
    async restore(sessionId: string | null, hydrate: () => Promise<T[]>): Promise<void> {
      const restoreGeneration = ++generation
      update([])
      if (!sessionId) return
      const restored = await hydrate()
      if (restoreGeneration === generation) update(restored)
    },
    cancel(): void {
      generation += 1
      update([])
    },
  }
}

export async function restorePersistedMessage(
  persisted: AgentSessionMessage,
  attachments: AgentAttachmentRef[],
  readAttachment: (attachmentId: string) => Promise<Uint8Array>,
  existing?: Message,
): Promise<Message> {
  const imageDataUrls = (await Promise.all(persisted.attachmentIds.map(async (attachmentId) => {
    const ref = attachments.find((attachment) => attachment.id === attachmentId)
    if (!ref) return null
    try {
      const bytes = await readAttachment(attachmentId)
      const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
      return `data:${ref.mimeType};base64,${btoa(binary)}`
    } catch {
      return null
    }
  }))).filter((value): value is string => Boolean(value))
  return {
    id: persisted.id,
    role: persisted.role,
    content: persisted.content,
    ...(imageDataUrls.length ? { imageDataUrls } : {}),
    ...(persisted.summaries.length ? { summaries: persisted.summaries } : {}),
    ...(existing?.thinking ? { thinking: existing.thinking } : {}),
    ...(existing?.actions ? { actions: existing.actions } : {}),
  }
}

export function appendSubmittedMessage<T>(messages: readonly T[], message: T): T[] {
  return [...messages, message]
}

export async function withAgentLoading<T>(
  setLoading: (loading: boolean) => void,
  operation: () => Promise<T>,
): Promise<T> {
  setLoading(true)
  try {
    return await operation()
  } finally {
    setLoading(false)
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COLLAPSE_AFTER = 4

// ─── Prose renderer — basic markdown-like ────────────────────────────────────

function ProseMessage({ content }: { content: string }): JSX.Element {
  const blocks = content.split(/\n\n+/)
  return (
    <div className="flex flex-col gap-2.5 text-[12.5px] leading-relaxed text-zinc-200">
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        const isList = lines.every((l) => /^[-•*]\s/.test(l.trim()) || l.trim() === '')
        if (isList) {
          return (
            <ul key={i} className="flex flex-col gap-1 pl-3">
              {lines.filter(Boolean).map((l, j) => (
                <li key={j} className="flex gap-2">
                  <span className="text-zinc-500 shrink-0 mt-px">•</span>
                  <span>{l.replace(/^[-•*]\s/, '')}</span>
                </li>
              ))}
            </ul>
          )
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {block}
          </p>
        )
      })}
    </div>
  )
}

// ─── Actions card ─────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  decimate_mesh:        'Decimated mesh',
  smooth_mesh:          'Smoothed mesh',
  list_models:          'Listed models',
  list_processes:       'Listed processes',
  unload_models:        'Unloaded models',
  get_mesh_info:        'Inspected mesh',
  get_generation_status:'Checked generation',
  list_workflows:       'Listed workflows',
  run_workflow:         'Ran workflow',
  create_workflow:      'Created workflow',
}

function completedActionSummary(action: ActionDone, messageId: string, index: number): AgentSessionSummary {
  const label = TOOL_LABELS[action.tool] ?? 'Completed action'
  if (action.payload?.type === 'mesh_update' && action.payload.url.startsWith('/workspace/')) {
    const workspacePath = action.payload.url.slice('/workspace/'.length)
    const segments = workspacePath.split('/')
    if (workspacePath && !workspacePath.includes('\\') && segments.every((segment) => segment && segment !== '.' && segment !== '..')) {
      const refId = `${messageId}-artifact-${index}`
      return {
        kind: 'artifact',
        label,
        artifact: { id: refId, kind: 'mesh', versionId: refId, workspacePath },
      }
    }
  }
  return { kind: 'action', label }
}

function ActionsCard({ actions, onUndo }: { actions: ActionDone[]; onUndo?: () => void }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const meshActions = actions.filter((a) => a.payload?.type === 'mesh_update')
  const canUndo = meshActions.length > 0 && !!onUndo

  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/40 overflow-hidden text-[11px]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700/40">
        <span className="text-zinc-300 font-medium">
          {actions.length} action{actions.length > 1 ? 's' : ''} performed
        </span>
        <div className="flex items-center gap-2">
          {canUndo && (
            <button
              onClick={onUndo}
              className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 7v6h6" /><path d="M3 13a9 9 0 1 0 2.28-5.93" />
              </svg>
              Undo
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      {/* Rows */}
      {expanded && (
        <div className="flex flex-col divide-y divide-zinc-700/30">
          {actions.map((a, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-1.5">
              <span className="text-zinc-400">{TOOL_LABELS[a.tool] ?? a.tool.replace(/_/g, ' ')}</span>
              {a.payload?.type === 'mesh_update' && a.payload.face_count && (
                <span className="text-emerald-400 font-mono">{a.payload.face_count.toLocaleString()} faces</span>
              )}
              {a.payload?.type === 'run_workflow' && (
                <span className="text-violet-400">{a.payload.workflow_name}</span>
              )}
              {a.payload?.type === 'create_workflow' && a.payload.workflow && (
                <span className="text-violet-400">{a.payload.workflow.name}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function governedStatusLabel(status: AgentActionStatus): string {
  return status.replace(/^./, (value) => value.toUpperCase())
}

function formatByteCount(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`
}

export function isGovernedApprovalExpired(
  action: Pick<AgentActionPublicSummaryV1, 'status' | 'approval'>,
  nowMs = Date.now(),
): boolean {
  if (action.status !== 'proposed' && action.status !== 'approved') return false
  const expiresAtMs = Date.parse(action.approval.expiresAt)
  return !Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs
}

function GovernedActionCard({
  entry,
  onCommand,
  onExpire,
}: {
  entry: SessionGovernedAction
  onCommand: (entry: SessionGovernedAction, command: GovernedActionCommand) => void
  onExpire: (entry: SessionGovernedAction) => void
}): JSX.Element {
  const { action } = entry
  const statusLabel = governedStatusLabel(action.status)
  const buttonClass = 'rounded-md border border-zinc-600 px-2.5 py-1 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40'
  const [approvalExpired, setApprovalExpired] = useState(() => isGovernedApprovalExpired(action))
  const entryRef = useRef(entry)
  const onExpireRef = useRef(onExpire)
  entryRef.current = entry
  onExpireRef.current = onExpire

  useEffect(() => {
    if (action.status !== 'proposed' && action.status !== 'approved') {
      setApprovalExpired(false)
      return
    }
    const expiresAtMs = Date.parse(action.approval.expiresAt)
    const remainingMs = expiresAtMs - Date.now()
    if (!Number.isFinite(expiresAtMs) || remainingMs <= 0) {
      setApprovalExpired(true)
      onExpireRef.current(entryRef.current)
      return
    }
    setApprovalExpired(false)
    const timer = globalThis.setTimeout(() => {
      setApprovalExpired(true)
      onExpireRef.current(entryRef.current)
    }, remainingMs)
    return () => globalThis.clearTimeout(timer)
  }, [action.approval.expiresAt, action.id, action.status])

  return (
    <section
      aria-label={`Governed action: ${action.capability.displayName}`}
      className="rounded-xl border border-amber-700/40 bg-amber-950/20 p-3 text-[11px]"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-zinc-100">{action.capability.displayName}</p>
          <p className="mt-0.5 text-zinc-400">{action.capability.description}</p>
        </div>
        <span className="shrink-0 rounded-full border border-amber-700/40 px-2 py-0.5 text-[10px] text-amber-300">
          {action.capability.risk === 'mutating' ? 'Changes data' : 'Read only'}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-zinc-400">
        <dt>Status</dt><dd aria-live="polite" className="text-zinc-200">{statusLabel}</dd>
        <dt>Model</dt><dd className="truncate text-zinc-300">{action.model.model}</dd>
        {action.preview.map((item, index) => (
          <div key={`${item.label}-${index}`} className="contents">
            <dt>{item.label}</dt><dd className="break-words text-zinc-300">{item.value}</dd>
          </div>
        ))}
      </dl>

      {action.outputs.length > 0 && (
        <div className="mt-2 border-t border-zinc-700/50 pt-2 text-zinc-400">
          <p className="mb-1 text-zinc-300">Verified outputs</p>
          {action.outputs.map((output) => (
            <p key={`${output.sha256}-${output.id}`} className="font-mono text-[10px]">
              {output.kind} · {output.sha256.slice(0, 12)}… · {formatByteCount(output.sizeBytes)}
            </p>
          ))}
        </div>
      )}

      {entry.error && <p role="alert" className="mt-2 text-red-400">{entry.error}</p>}

      <div className="mt-3 flex gap-2">
        {action.status === 'proposed' && (
          <>
            <button
              type="button"
              aria-label={`Approve ${action.capability.displayName}`}
              disabled={approvalExpired || entry.busyCommand !== undefined}
              onClick={() => onCommand(entry, 'approve')}
              className={`${buttonClass} border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/40`}
            >Approve</button>
            <button
              type="button"
              aria-label={`Reject ${action.capability.displayName}`}
              disabled={approvalExpired || entry.busyCommand !== undefined}
              onClick={() => onCommand(entry, 'reject')}
              className={buttonClass}
            >Reject</button>
          </>
        )}
        {action.status === 'approved' && (
          <>
            <button
              type="button"
              aria-label={`Run ${action.capability.displayName}`}
              disabled={approvalExpired || entry.busyCommand !== undefined}
              onClick={() => onCommand(entry, 'run')}
              className={`${buttonClass} border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/40`}
            >Run</button>
            <button
              type="button"
              aria-label={`Cancel ${action.capability.displayName}`}
              disabled={entry.busyCommand !== undefined}
              onClick={() => onCommand(entry, 'cancel')}
              className={buttonClass}
            >Cancel</button>
          </>
        )}
        {action.status === 'executing' && (
          <button
            type="button"
            aria-label={`Cancel ${action.capability.displayName}`}
            disabled={entry.busyCommand !== undefined}
            onClick={() => onCommand(entry, 'cancel')}
            className={buttonClass}
          >Cancel</button>
        )}
      </div>
    </section>
  )
}

function PersistedSummaries({ summaries }: { summaries: AgentSessionSummary[] }): JSX.Element {
  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/40 px-3 py-2 text-[11px] text-zinc-400">
      {summaries.map((summary, index) => summary.kind === 'governed-action' ? (
        <div key={`${summary.kind}-${index}`}>
          <p>{summary.label}</p>
          <p className="text-zinc-500">Model: {summary.governedAction.model}</p>
          {summary.governedAction.outputs.map((output) => (
            <p key={`${output.sha256}-${output.kind}`} className="font-mono text-[10px] text-zinc-500">
              {output.kind} · {output.sha256.slice(0, 12)}… · {formatByteCount(output.sizeBytes)}
            </p>
          ))}
        </div>
      ) : (
        <p key={`${summary.kind}-${index}`}>
          {summary.label}{summary.artifact ? ` — ${summary.artifact.workspacePath}` : ''}
        </p>
      ))}
    </div>
  )
}

// ─── Feedback row ─────────────────────────────────────────────────────────────

function FeedbackRow({ content }: { content: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center gap-2 pt-0.5">
      <button
        onClick={handleCopy}
        title="Copy"
        className="text-zinc-600 hover:text-zinc-400 transition-colors"
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      <button title="Good response" className="text-zinc-600 hover:text-zinc-400 transition-colors">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z" />
          <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
        </svg>
      </button>
      <button title="Bad response" className="text-zinc-600 hover:text-zinc-400 transition-colors">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z" />
          <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
        </svg>
      </button>
    </div>
  )
}

// ─── Thinking block ───────────────────────────────────────────────────────────

function ThinkingBlock({ content }: { content: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[11px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-400 transition-colors"
      >
        {/* brain icon */}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
        </svg>
        <span>Reasoning</span>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="mt-2 pl-3 border-l-2 border-zinc-700">
          <p className="text-zinc-500 italic leading-relaxed whitespace-pre-wrap">{content}</p>
        </div>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function ChatPanel(): JSX.Element {
  const { ollamaUrl, defaultModel, defaultThinking } = useAgentStore()

  const [messages, setMessages]               = useState<Message[]>([])
  const [input, setInput]                     = useState('')
  const [isLoading, setIsLoading]             = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [showAll, setShowAll]                 = useState(false)
  const [model, setModel]                     = useState(defaultModel)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [ollamaModels, setOllamaModels]       = useState<string[]>([])
  const [attachments, setAttachments]         = useState<PendingAttachment[]>([])
  const [isDragging, setIsDragging]           = useState(false)
  const [thinkingMode, setThinkingMode]       = useState<ThinkingMode>(defaultThinking)
  const [governedActions, setGovernedActions] = useState<SessionGovernedAction[]>([])
  const endRef                                = useRef<HTMLDivElement>(null)
  const textareaRef                           = useRef<HTMLTextAreaElement>(null)
  const modelPickerRef                        = useRef<HTMLDivElement>(null)
  const fileInputRef                          = useRef<HTMLInputElement>(null)
  const messagesRef                           = useRef<Message[]>([])
  const governedActionsRef                    = useRef<SessionGovernedAction[]>([])
  const submissionGateRef                     = useRef(createSubmissionGate())
  const actionOperationGateRef                = useRef(createKeyedOperationGate())
  const proposalTrackerRef                    = useRef(createGovernedProposalTracker())
  const persistedActionIdsRef                 = useRef(new Set<string>())
  const terminalMessageCounterRef             = useRef(0)
  const mountedRef                            = useRef(true)
  const originUiGateRef                       = useRef(createOriginBoundUiGate(
    () => useAgentSessionsStore.getState().activeSession?.id ?? null,
  ))
  const sessionRestoreRef                     = useRef(createSessionRestoreCoordinator<Message>((nextMessages) => {
    messagesRef.current = nextMessages
    setMessages(nextMessages)
  }))
  const transientSessionIdRef                 = useRef<string | null>(null)
  messagesRef.current = messages
  governedActionsRef.current = governedActions

  const activeSession = useAgentSessionsStore((state) => state.activeSession)
  const initializedSessions = useAgentSessionsStore((state) => state.initialized)
  const initializeSessions = useAgentSessionsStore((state) => state.initialize)
  const appendPersistedMessage = useAgentSessionsStore((state) => state.appendMessage)
  const addPersistedAttachment = useAgentSessionsStore((state) => state.addAttachment)
  const removePersistedAttachments = useAgentSessionsStore((state) => state.removeAttachments)

  useEffect(() => { void initializeSessions() }, [initializeSessions])

  useLayoutEffect(() => {
    const nextSessionId = activeSession?.id ?? null
    if (transientSessionIdRef.current === nextSessionId) return
    const previousSessionId = transientSessionIdRef.current
    originUiGateRef.current.invalidate()
    if (previousSessionId) proposalTrackerRef.current.invalidateOrigin(previousSessionId)
    const switchPlan = planGovernedSessionSwitch(governedActionsRef.current, previousSessionId, nextSessionId)
    if (previousSessionId) void cancelGovernedActionIds(previousSessionId, switchPlan.cancelActionIds)
    governedActionsRef.current = switchPlan.retained
    setGovernedActions(switchPlan.retained)
    transientSessionIdRef.current = nextSessionId
    setInput('')
    setAttachments([])
    setError(null)
    setShowAll(false)
    setIsDragging(false)
    setIsLoading(false)
  }, [activeSession?.id])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      originUiGateRef.current.invalidate()
      proposalTrackerRef.current.invalidateAll()
      const originSessionId = transientSessionIdRef.current
      if (!originSessionId) return
      const switchPlan = planGovernedSessionSwitch(governedActionsRef.current, originSessionId, null)
      void cancelGovernedActionIds(originSessionId, switchPlan.cancelActionIds)
    }
  }, [])

  useLayoutEffect(() => {
    const session = activeSession
    void sessionRestoreRef.current.restore(session?.id ?? null, async () => {
      if (!session) return []
      return Promise.all(session.messages.map((persisted) => restorePersistedMessage(
        persisted,
        session.attachments,
        (attachmentId) => window.electron.agentSessions.readAttachment({ sessionId: session.id, attachmentId }),
        messagesRef.current.find((message) => message.id === persisted.id),
      )))
    })
    return () => sessionRestoreRef.current.cancel()
  }, [activeSession?.id, activeSession?.revision])

  const apiUrl           = useAppStore((s) => s.apiUrl)
  const currentJob       = useAppStore((s) => s.currentJob)
  const meshStats        = useAppStore((s) => s.meshStats)
  const undoMesh         = useAppStore((s) => s.undoMesh)

  const workflows = useWorkflowsStore((s) => s.workflows)

  useEffect(() => {
    setModel(defaultModel)
  }, [defaultModel])

  useEffect(() => {
    setThinkingMode(defaultThinking)
  }, [defaultThinking])

  // Close model picker on outside click
  useEffect(() => {
    if (!showModelPicker) return
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node))
        setShowModelPicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showModelPicker])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, governedActions, isLoading])

  function buildContext(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {}
    if (currentJob?.outputUrl) ctx.currentMeshPath = currentJob.outputUrl.replace('/workspace/', '')
    if (meshStats?.triangles)  ctx.meshTriangles   = meshStats.triangles
    if (workflows.length > 0)  ctx.workflows       = workflows.map((w) => ({ id: w.id, name: w.name }))
    return ctx
  }

  function updateGovernedActions(
    update: (current: SessionGovernedAction[]) => SessionGovernedAction[],
  ): void {
    const next = update(governedActionsRef.current)
    governedActionsRef.current = next
    if (mountedRef.current) setGovernedActions(next)
  }

  function upsertGovernedActions(
    originSessionId: string,
    actions: AgentActionPublicSummaryV1[],
  ): void {
    if (actions.length === 0) return
    updateGovernedActions((current) => {
      const replacements = new Map(actions.map((action) => [action.id, action]))
      const next = current.map((entry) => {
        const action = entry.originSessionId === originSessionId ? replacements.get(entry.action.id) : undefined
        if (!action) return entry
        replacements.delete(entry.action.id)
        return { originSessionId, action }
      })
      for (const action of replacements.values()) next.push({ originSessionId, action })
      return next
    })
  }

  async function persistGovernedTerminalAction(
    originSessionId: string,
    action: AgentActionPublicSummaryV1,
  ): Promise<void> {
    const summary = buildGovernedTerminalSummary(action)
    if (!summary) return
    if (persistedActionIdsRef.current.has(action.id)) {
      updateGovernedActions((current) => current.filter((entry) => entry.action.id !== action.id))
      return
    }
    persistedActionIdsRef.current.add(action.id)
    const messageId = `governed-${Date.now()}-${++terminalMessageCounterRef.current}`
    try {
      await appendPersistedMessage(originSessionId, {
        id: messageId,
        role: 'assistant',
        content: `${summary.label}.`,
        summaries: [summary],
      })
      updateGovernedActions((current) => current.filter((entry) => entry.action.id !== action.id))
    } catch {
      persistedActionIdsRef.current.delete(action.id)
      if (mountedRef.current && useAgentSessionsStore.getState().activeSession?.id === originSessionId) {
        setError('The action finished, but its terminal summary could not be saved.')
      }
    }
  }

  async function acceptGovernedActionUpdate(
    originSessionId: string,
    action: AgentActionPublicSummaryV1,
  ): Promise<void> {
    if (useAgentSessionsStore.getState().activeSession?.id === originSessionId) {
      upsertGovernedActions(originSessionId, [action])
    }
    await persistGovernedTerminalAction(originSessionId, action)
  }

  async function cancelGovernedActionIds(originSessionId: string, actionIds: string[]): Promise<void> {
    for (const actionId of actionIds) {
      try {
        let latest: AgentActionPublicSummaryV1 | null = null
        const result = await window.electron.agentActions.cancel({ actionId, originSessionId })
        if (result.ok && result.action.id === actionId) {
          latest = result.action
        }
        if (!latest) {
          const refreshed = await window.electron.agentActions.get({ actionId, originSessionId })
          if (refreshed.ok && refreshed.action.id === actionId) latest = refreshed.action
        }
        if (!latest || !isGovernedTerminalStatus(latest.status)) {
          const reconciled = await reconcileGovernedActionUntilTerminal({
            actionId,
            originSessionId,
            list: window.electron.agentActions.list,
            shouldContinue: () => {
              const state = useAgentSessionsStore.getState()
              return state.activeSession?.id === originSessionId
                || state.sessions.some((session) => session.id === originSessionId)
            },
          })
          if (reconciled) latest = reconciled
        }
        if (latest) await persistGovernedTerminalAction(originSessionId, latest)
      } catch {
        // The prior session is already hidden. A later service cleanup still expires the lease.
      }
    }
  }

  async function handoffGovernedProposals(
    proposals: AgentActionProposal[],
    originSessionId: string,
    modelLeaseId: string,
    uiToken: OriginBoundUiToken,
  ): Promise<GovernedActionHandoffError[]> {
    if (proposals.length === 0) return []
    const handoff = await proposeGovernedAgentActions({
      proposals,
      originSessionId,
      modelLeaseId,
      isCurrent: uiToken.isCurrent,
      propose: (request) => window.electron.agentActions.propose(request),
      tracker: proposalTrackerRef.current,
      acceptAction: (action) => {
        let accepted = false
        uiToken.run(() => {
          upsertGovernedActions(originSessionId, [action])
          accepted = true
        })
        return accepted
      },
      compensate: async (action) => {
        const outcome = await compensateLateGovernedProposal({
          action,
          originSessionId,
          sessionExists: () => {
            const state = useAgentSessionsStore.getState()
            return state.activeSession?.id === originSessionId
              || state.sessions.some((session) => session.id === originSessionId)
          },
          isOriginActive: () => mountedRef.current
            && useAgentSessionsStore.getState().activeSession?.id === originSessionId,
          cancel: (request) => window.electron.agentActions.cancel(request),
          get: (request) => window.electron.agentActions.get(request),
          list: (request) => window.electron.agentActions.list(request),
          reject: (request) => window.electron.agentActions.decide(request),
          persistTerminal: (terminalAction) => persistGovernedTerminalAction(originSessionId, terminalAction),
          reportError: (message) => { if (mountedRef.current) setError(message) },
        })
        return outcome.kind === 'pending'
          ? { code: 'cancellation_pending', message: 'A late governed proposal remains hidden and will expire automatically.' }
          : null
      },
    })
    return handoff.errors
  }

  function handleGovernedActionCommand(
    entry: SessionGovernedAction,
    command: GovernedActionCommand,
  ): void {
    void actionOperationGateRef.current.run(entry.action.id, async () => {
      if (useAgentSessionsStore.getState().activeSession?.id !== entry.originSessionId) return
      updateGovernedActions((current) => current.map((candidate) => candidate.action.id === entry.action.id
        ? {
            ...candidate,
            action: command === 'run' ? { ...candidate.action, status: 'executing' } : candidate.action,
            busyCommand: command,
            error: undefined,
          }
        : candidate))

      let visibleError: string | null = null
      try {
        const result = await invokeGovernedActionCommand(
          command,
          entry.action.id,
          entry.originSessionId,
          () => useAgentSessionsStore.getState().activeSession?.id ?? null,
          window.electron.agentActions,
        )
        if (result.ok) {
          if (result.action.id !== entry.action.id) throw new Error('Governed action identity changed.')
          await acceptGovernedActionUpdate(entry.originSessionId, result.action)
        } else {
          visibleError = governedActionCommandErrorMessage(result.error.code)
          if (result.error.code === 'cancellation_pending') {
            const reconciled = await reconcileGovernedActionUntilTerminal({
              actionId: entry.action.id,
              originSessionId: entry.originSessionId,
              list: window.electron.agentActions.list,
              shouldContinue: () => mountedRef.current
                && useAgentSessionsStore.getState().activeSession?.id === entry.originSessionId,
            })
            if (reconciled) {
              visibleError = null
              await acceptGovernedActionUpdate(entry.originSessionId, reconciled)
            }
          }
          if (!visibleError) return
          const refreshed = await window.electron.agentActions.get({
            actionId: entry.action.id,
            originSessionId: entry.originSessionId,
          })
          if (refreshed.ok && refreshed.action.id === entry.action.id) {
            await acceptGovernedActionUpdate(entry.originSessionId, refreshed.action)
          }
        }
      } catch {
        visibleError = useAgentSessionsStore.getState().activeSession?.id === entry.originSessionId
          ? 'Modly could not update this governed action.'
          : null
      } finally {
        if (useAgentSessionsStore.getState().activeSession?.id === entry.originSessionId) {
          updateGovernedActions((current) => current.map((candidate) => candidate.action.id === entry.action.id
            ? {
                ...candidate,
                busyCommand: undefined,
                ...(visibleError ? { error: visibleError } : {}),
              }
            : candidate))
          if (visibleError) setError(visibleError)
        }
      }
    })
  }

  async function applyCompletedActions(
    actions: ActionDone[],
  ): Promise<AgentActionFailure[]> {
    return applyAgentActions(actions, rejectUngovernedAgentAction)
  }

  async function callAgent(
    originatingSessionId: string,
    msgs: Message[],
    extraContext: Record<string, unknown> = {},
    uiToken = originUiGateRef.current.begin(originatingSessionId),
  ) {
    const selectedModel: AgentOllamaModelSelectionV1 = {
      provider: 'ollama',
      endpoint: ollamaUrl,
      model,
    }
    const selectedThinkingMode = thinkingMode
    let modelLeaseId: string | null = null
    uiToken.run(() => {
      setIsLoading(true)
      setError(null)
    })
    try {
      const [capabilityInventory, modelLeaseResult] = await Promise.all([
        window.electron.agentCapabilities.list(),
        window.electron.agentActions.leaseModel({
          originSessionId: originatingSessionId,
          model: selectedModel,
        }),
      ])
      if (!modelLeaseResult.ok) throw new Error(governedActionErrorMessage(modelLeaseResult.error.code))
      const leaseExpiresAt = Date.parse(modelLeaseResult.lease.expiresAt)
      if (
        !OPAQUE_ID_PATTERN.test(modelLeaseResult.lease.id)
        || !Number.isFinite(leaseExpiresAt)
        || leaseExpiresAt <= Date.now()
      ) throw new Error(governedActionErrorMessage('model_stale'))
      modelLeaseId = modelLeaseResult.lease.id
      const capabilities = buildAgentCapabilityPromptInventory(capabilityInventory)
      const context = { ...buildContext(), ...extraContext }

      // Inject workflow completion as a system hint if present
      const apiMessages = msgs.map((m) => {
        const entry: { role: string; content: string; images?: string[] } = {
          role: m.role,
          content: m.content,
        }
        if (m.imageDataUrls?.length) {
          entry.images = m.imageDataUrls.map((url) => url.split(',')[1])
        }
        return entry
      })
      if (extraContext.workflowCompletion) {
        apiMessages.push({ role: 'user', content: `[System] ${extraContext.workflowCompletion}` })
        delete context.workflowCompletion
      }

      const res = await fetch(`${apiUrl}/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          ollama_url: selectedModel.endpoint,
          model: selectedModel.model,
          modelLeaseId,
          context,
          thinking: selectedThinkingMode,
          capabilities,
        }),
      })
      const data = await parseAgentChatResponse(res)
      const proposalErrors = await handoffGovernedProposals(
        data.proposals,
        originatingSessionId,
        modelLeaseId,
        uiToken,
      )

      const actionFailures = await applyCompletedActions(data.actions)
      const failedActions = new Set(actionFailures.map((failure) => failure.action))
      const reflectedActions = data.actions.filter((action) => !failedActions.has(action))
      const assistantMessage: Message = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: data.message,
        thinking: data.thinking ?? undefined,
        actions: reflectedActions.length ? reflectedActions : undefined,
      }
      await appendPersistedMessage(originatingSessionId, {
        id: assistantMessage.id,
        role: assistantMessage.role,
        content: assistantMessage.content,
        summaries: reflectedActions
          .map((action, index) => completedActionSummary(action, assistantMessage.id, index)),
      })
      uiToken.run(() => {
        setMessages((prev) => [...prev, assistantMessage])
        if (proposalErrors.length > 0) setError(proposalErrors.map((failure) => failure.message).join(' '))
      })

      if (actionFailures.length > 0) {
        const approvalRequired = governedActionFailure(actionFailures)
        if (approvalRequired) throw approvalRequired
        throw new Error(withActionFailureSummary('The agent response was received.', actionFailures.length))
      }
    } catch (e: unknown) {
      let actionFailureCount = 0
      let approvalRequired: GovernedActionRequiredError | null = null
      let proposalErrors: GovernedActionHandoffError[] = []
      if (e instanceof AgentApiError && modelLeaseId) {
        proposalErrors = await handoffGovernedProposals(
          e.proposals,
          originatingSessionId,
          modelLeaseId,
          uiToken,
        )
        if (e.actions.length > 0) {
          const actionFailures = await applyCompletedActions(e.actions)
          actionFailureCount = actionFailures.length
          approvalRequired = governedActionFailure(actionFailures)
        }
      }
      const msg = e instanceof Error ? e.message : String(e)
      const safeMessage = msg.includes('fetch') ? 'Cannot reach Modly API. Is the backend running?' : msg
      const primaryMessage = approvalRequired?.message
        ?? (e instanceof GovernedActionRequiredError ? e.message : withActionFailureSummary(safeMessage, actionFailureCount))
      uiToken.run(() => setError(
        [primaryMessage, ...proposalErrors.map((failure) => failure.message)].join(' '),
      ))
    } finally {
      uiToken.run(() => setIsLoading(false))
    }
  }

  async function fetchOllamaModels() {
    try {
      const res = await fetch(`${apiUrl}/agent/models?ollama_url=${encodeURIComponent(ollamaUrl)}`)
      const data = await res.json()
      setOllamaModels(parseOllamaModelNames(data))
    } catch {
      setOllamaModels([])
    }
  }

  function handleFiles(files: File[]) {
    const originatingSessionId = activeSession?.id
    if (!originatingSessionId) return
    const uiToken = originUiGateRef.current.begin(originatingSessionId)
    files.slice(0, 8 - attachments.length).forEach((file) => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) return
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string
        uiToken.run(() => setAttachments((prev) => [...prev, { file, dataUrl }]))
      }
      reader.readAsDataURL(file)
    })
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(Array.from(e.dataTransfer.files))
  }

  function adjustHeight() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  async function handleSend() {
    await submissionGateRef.current.run(async () => {
      const text = input.trim()
      const originatingSessionId = activeSession?.id
      if (!text || isLoading || !initializedSessions || !originatingSessionId) return
      const uiToken = originUiGateRef.current.begin(originatingSessionId)

      const attachmentIds: string[] = []
      let userPersisted = false
      try {
        for (const attachment of attachments) {
          const updated = await addPersistedAttachment(originatingSessionId, {
            name: attachment.file.name,
            mimeType: attachment.file.type,
            bytes: new Uint8Array(await attachment.file.arrayBuffer()),
          })
          attachmentIds.push(updated.attachments.at(-1)!.id)
        }

        const userMsg: Message = {
          id: `u-${Date.now()}`,
          role: 'user',
          content: text,
          ...(attachments.length ? { imageDataUrls: attachments.map((attachment) => attachment.dataUrl) } : {}),
        }
        await appendPersistedMessage(originatingSessionId, {
          id: userMsg.id,
          role: userMsg.role,
          content: userMsg.content,
          attachmentIds,
        })
        userPersisted = true
        const nextMessages = appendSubmittedMessage(messagesRef.current, userMsg)
        uiToken.run(() => {
          setMessages(nextMessages)
          setInput('')
          setAttachments([])
          if (textareaRef.current) textareaRef.current.style.height = 'auto'
        })
        await callAgent(originatingSessionId, nextMessages, {}, uiToken)
      } catch (failure) {
        let visibleFailure = failure
        if (!userPersisted && attachmentIds.length > 0) {
          try {
            await rollbackFailedSendAttachments(
              attachmentIds,
              (ids) => removePersistedAttachments(originatingSessionId, ids),
            )
          } catch (rollbackFailure) {
            visibleFailure = rollbackFailure
          }
        }
        uiToken.run(() => {
          setError(visibleFailure instanceof Error ? visibleFailure.message : 'The message could not be saved. Please try again.')
        })
      }
    })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  // Collapsed history
  const collapsed = !showAll && messages.length > COLLAPSE_AFTER
  const hidden    = collapsed ? messages.length - COLLAPSE_AFTER : 0
  const visible   = collapsed ? messages.slice(-COLLAPSE_AFTER) : messages
  const visibleGovernedActions = governedActions.filter((entry) => entry.originSessionId === activeSession?.id)

  return (
    <div
      className="flex flex-col flex-1 min-h-0 relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <AgentSessionHistory />
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/60 bg-accent/5 pointer-events-none">
          <p className="text-[12px] text-accent font-medium">Drop image here</p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">

        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-5 py-10">
            <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <circle cx="12" cy="5" r="2" /><path d="M12 7v4" />
              </svg>
            </div>
            <p className="text-[11px] text-zinc-500 text-center leading-relaxed">
              Ask me to inspect Modly<br />or propose a governed action.
            </p>
          </div>
        )}

        {/* Previous messages pill */}
        {collapsed && (
          <button
            onClick={() => setShowAll(true)}
            className="mx-4 mt-4 mb-1 flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors self-start"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            {hidden} previous message{hidden > 1 ? 's' : ''}
          </button>
        )}

        {/* Message list */}
        <div className="flex flex-col px-4 py-3 gap-5">
          {visible.map((msg) => (
            <div key={msg.id}>
              {msg.role === 'user' ? (
                /* User message */
                <div className="flex flex-col items-end gap-1.5">
                  {msg.imageDataUrls && msg.imageDataUrls.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 justify-end max-w-[80%]">
                      {msg.imageDataUrls.map((url, i) => (
                        <img key={i} src={url} alt="" className="max-h-36 max-w-full rounded-xl object-cover border border-zinc-700/50" />
                      ))}
                    </div>
                  )}
                  <div className="max-w-[80%] px-3 py-2 rounded-2xl rounded-br-sm bg-zinc-800 border border-zinc-700/50 text-[12px] text-zinc-200 leading-relaxed">
                    {msg.content}
                  </div>
                </div>
              ) : (
                /* Assistant message */
                <div className="flex flex-col gap-3">
                  {msg.thinking && <ThinkingBlock content={msg.thinking} />}
                  <ProseMessage content={msg.content} />
                  {msg.actions && msg.actions.length > 0 && (
                    <ActionsCard actions={msg.actions} onUndo={undoMesh} />
                  )}
                  {!msg.actions?.length && msg.summaries && msg.summaries.length > 0 && (
                    <PersistedSummaries summaries={msg.summaries} />
                  )}
                  <FeedbackRow content={msg.content} />
                </div>
              )}
            </div>
          ))}

          {visibleGovernedActions.map((entry) => (
            <GovernedActionCard
              key={entry.action.id}
              entry={entry}
              onCommand={handleGovernedActionCommand}
              onExpire={(candidate) => handleGovernedActionCommand(candidate, 'refresh')}
            />
          ))}

          {/* Loading indicator */}
          {isLoading && (
            <div className="flex gap-1 items-center py-1">
              {[0, 1, 2].map((i) => (
                <span key={i}
                  className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce"
                  style={{ animationDelay: `${i * 130}ms` }}
                />
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-950/40 border border-red-800/40">
              <p className="text-[11px] text-red-400">{error}</p>
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      {/* Input bar */}
      <div className="shrink-0 px-3 pb-3 pt-2 border-t border-zinc-800">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) handleFiles(Array.from(e.target.files)); e.target.value = '' }}
        />
        <div className="flex flex-col gap-1.5 bg-zinc-900 border border-zinc-700/60 rounded-2xl px-3 py-2.5">
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((attachment, i) => (
                <div key={i} className="relative group">
                  <img src={attachment.dataUrl} alt="" className="h-14 w-14 object-cover rounded-lg border border-zinc-700/50" />
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-700 border border-zinc-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); adjustHeight() }}
            onKeyDown={handleKeyDown}
            placeholder="Ask Modly…"
            rows={1}
            spellCheck={false}
            className="w-full bg-transparent text-[12.5px] text-zinc-200 placeholder-zinc-600 focus:outline-none resize-none leading-relaxed overflow-hidden"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
            {/* Attach image button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              title="Attach image"
              className="text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </button>
            {/* Thinking toggle */}
            <button
              onClick={() => setThinkingMode((m) => m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto')}
              title={`Thinking: ${thinkingMode}`}
              className={`transition-colors ${thinkingMode === 'on' ? 'text-accent' : thinkingMode === 'off' ? 'text-zinc-700' : 'text-zinc-600 hover:text-zinc-400'}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
                <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
                {thinkingMode === 'off' && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="2" />}
              </svg>
            </button>
            {/* Model selector */}
            <div className="relative" ref={modelPickerRef}>
              <button
                onClick={() => { setShowModelPicker((v) => !v); if (!showModelPicker) fetchOllamaModels() }}
                className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {model}
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showModelPicker && (
                <div className="absolute bottom-full mb-2 left-0 z-50 bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-xl overflow-hidden min-w-[180px]">
                  {ollamaModels.length === 0 ? (
                    <p className="px-3 py-2.5 text-[11px] text-zinc-500">No models found — is Ollama running?</p>
                  ) : (
                    ollamaModels.map((m) => (
                      <button
                        key={m}
                        onClick={() => { setModel(m); setShowModelPicker(false) }}
                        className={`w-full px-3 py-2 text-left text-[11px] hover:bg-zinc-800 transition-colors flex items-center justify-between gap-3 ${m === model ? 'text-zinc-100' : 'text-zinc-400'}`}
                      >
                        <span className="truncate">{m}</span>
                        {m === model && (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-accent">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            </div>

            <button
              onClick={handleSend}
              disabled={!input.trim() || isLoading || !initializedSessions}
              className="w-6 h-6 rounded-full bg-accent hover:bg-accent-dark disabled:opacity-30 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors shrink-0"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[10px] text-zinc-700 text-center">Shift+Enter for new line</p>
      </div>

    </div>
  )
}
