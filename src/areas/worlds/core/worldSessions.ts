import {
  applyWorldCommandBatch,
  canonicalWorldCommandBatchPayload,
  fingerprintWorldCommandBatch,
  parseWorldCommandBatch,
  type ApplyWorldCommandBatchResult,
  type WorldCommandBatchV1,
  type WorldCommandIssue,
} from './worldCommands.ts'
import { cloneWorldProjectSnapshot, validateWorldProjectSnapshot } from './worldDocuments.ts'
import type { WorldProjectSnapshotV1 } from './worldModel.ts'

export interface WorldTransactionReceipt {
  transactionId: string
  fingerprint: string
  /** Exact canonical payload used for collision-safe transaction reuse checks. */
  canonicalPayload: string
  appliedRevision: number
}

export interface WorldEditorHistoryEntry {
  transactionId: string
  before: WorldProjectSnapshotV1
  after: WorldProjectSnapshotV1
}

export interface WorldEditorSession {
  snapshot: WorldProjectSnapshotV1
  undoStack: WorldEditorHistoryEntry[]
  redoStack: WorldEditorHistoryEntry[]
  receipts: readonly WorldTransactionReceipt[]
}

export type CreateWorldEditorSessionResult =
  | { success: true; session: WorldEditorSession }
  | { success: false; issues: WorldCommandIssue[] }

export type WorldEditorApplyResult =
  | {
      success: true
      session: WorldEditorSession
      idempotent: boolean
      changes: string[]
      warnings: string[]
      receipt: WorldTransactionReceipt
    }
  | { success: false; issues: WorldCommandIssue[] }

export type WorldEditorHistoryResult =
  | { success: true; session: WorldEditorSession }
  | { success: false; issues: WorldCommandIssue[] }

export type WorldPlayState = 'loading' | 'playing' | 'paused' | 'stopping' | 'edit'
export type WorldPlayEvent = 'loaded' | 'pause' | 'resume' | 'stop' | 'stopped'

export interface WorldActivePlaySession {
  state: Exclude<WorldPlayState, 'edit'>
  editor: WorldEditorSession
  sourceRevision: number
  runtimeSnapshot: WorldProjectSnapshotV1
}

export interface WorldStoppedPlaySession {
  state: 'edit'
  editor: WorldEditorSession
  sourceRevision: number
  runtimeSnapshot: null
}

export type WorldPlaySession = WorldActivePlaySession | WorldStoppedPlaySession

export type WorldPlayTransitionResult =
  | { success: true; session: WorldPlaySession }
  | { success: false; issues: WorldCommandIssue[] }

const ownedSessions = new WeakSet<object>()
const ownedFrozenData = new WeakSet<object>()

export function createWorldEditorSession(snapshotValue: unknown): CreateWorldEditorSessionResult {
  const validated = validateWorldProjectSnapshot(snapshotValue)
  if (!validated.success) return { success: false, issues: validated.issues }
  return {
    success: true,
    session: sealOwnedEditorSession({
      snapshot: cloneWorldProjectSnapshot(validated.value),
      undoStack: [],
      redoStack: [],
      receipts: [],
    }),
  }
}

export function previewWorldCommandBatch(session: WorldEditorSession, batchValue: unknown): ApplyWorldCommandBatchResult {
  return applyWorldCommandBatch(session.snapshot, batchValue)
}

export function applyWorldEditorCommandBatch(session: WorldEditorSession, batchValue: unknown): WorldEditorApplyResult {
  const normalized = ensureOwnedEditorSession(session)
  if (!normalized.success) return normalized
  session = normalized.session
  const parsed = parseWorldCommandBatch(batchValue)
  if (!parsed.success) return parsed
  const canonicalPayload = canonicalWorldCommandBatchPayload(parsed.value)
  const fingerprint = fingerprintWorldCommandBatch(parsed.value)
  const existing = session.receipts.find((receipt) => receipt.transactionId === parsed.value.transactionId)
  if (existing) {
    if (existing.canonicalPayload !== canonicalPayload) {
      return failure('transaction-reuse', 'batch.transactionId', `Transaction ${parsed.value.transactionId} was already used with different content.`)
    }
    return {
      success: true,
      session,
      idempotent: true,
      changes: [],
      warnings: ['transaction-idempotent'],
      receipt: cloneReceipt(existing),
    }
  }

  const applied = applyWorldCommandBatch(session.snapshot, parsed.value)
  if (!applied.success) return applied
  const receipt: WorldTransactionReceipt = {
    transactionId: parsed.value.transactionId,
    fingerprint,
    canonicalPayload,
    appliedRevision: applied.snapshot.project.revision,
  }
  const history: WorldEditorHistoryEntry = {
    transactionId: parsed.value.transactionId,
    before: session.snapshot,
    after: cloneWorldProjectSnapshot(applied.snapshot),
  }
  return {
    success: true,
    session: sealOwnedEditorSession({
      snapshot: history.after,
      undoStack: [...session.undoStack, history],
      redoStack: [],
      receipts: [...session.receipts, receipt],
    }),
    idempotent: false,
    changes: [...applied.changes],
    warnings: [...applied.warnings],
    receipt: cloneReceipt(receipt),
  }
}

export function undoWorldEditorSession(session: WorldEditorSession): WorldEditorHistoryResult {
  const normalized = ensureOwnedEditorSession(session)
  if (!normalized.success) return normalized
  session = normalized.session
  const entry = session.undoStack.at(-1)
  if (!entry) return failure('undo-empty', 'session.undoStack', 'There is no command to undo.')
  const restored = restoreWithNextRevision(entry.before, session.snapshot.project.revision)
  if (!restored.success) return restored
  return {
    success: true,
    session: sealOwnedEditorSession({
      snapshot: restored.snapshot,
      undoStack: session.undoStack.slice(0, -1),
      redoStack: [...session.redoStack, entry],
      receipts: session.receipts,
    }),
  }
}

export function redoWorldEditorSession(session: WorldEditorSession): WorldEditorHistoryResult {
  const normalized = ensureOwnedEditorSession(session)
  if (!normalized.success) return normalized
  session = normalized.session
  const entry = session.redoStack.at(-1)
  if (!entry) return failure('redo-empty', 'session.redoStack', 'There is no command to redo.')
  const restored = restoreWithNextRevision(entry.after, session.snapshot.project.revision)
  if (!restored.success) return restored
  return {
    success: true,
    session: sealOwnedEditorSession({
      snapshot: restored.snapshot,
      undoStack: [...session.undoStack, entry],
      redoStack: session.redoStack.slice(0, -1),
      receipts: session.receipts,
    }),
  }
}

export function startWorldPlaySession(editor: WorldEditorSession): WorldActivePlaySession {
  const normalized = ensureOwnedEditorSession(editor)
  if (!normalized.success) throw new TypeError(normalized.issues[0]?.message ?? 'World editor session is invalid.')
  editor = normalized.session
  return Object.freeze({
    state: 'loading',
    editor,
    sourceRevision: editor.snapshot.project.revision,
    runtimeSnapshot: cloneWorldProjectSnapshot(editor.snapshot),
  })
}

export function adoptWorldEditorAuthoritativeSnapshot(
  template: WorldEditorSession,
  snapshotValue: unknown,
): WorldEditorHistoryResult {
  const normalized = ensureOwnedEditorSession(template)
  if (!normalized.success) return normalized
  const validated = validateWorldProjectSnapshot(snapshotValue)
  if (!validated.success) return { success: false, issues: validated.issues }
  if (validated.value.project.projectId !== normalized.session.snapshot.project.projectId) {
    return failure('project-mismatch', 'snapshot.project.projectId', 'Authoritative snapshot project does not match the editor session.')
  }
  if (validated.value.project.revision !== normalized.session.snapshot.project.revision) {
    return failure('revision-mismatch', 'snapshot.project.revision', 'Authoritative snapshot revision does not match the editor session.')
  }
  return {
    success: true,
    session: sealOwnedEditorSession({
      snapshot: cloneWorldProjectSnapshot(validated.value),
      undoStack: normalized.session.undoStack,
      redoStack: normalized.session.redoStack,
      receipts: normalized.session.receipts,
    }),
  }
}

/** Append one independently verified Main transaction without replaying a renderer-supplied batch. */
export function adoptWorldEditorExternalTransaction(
  template: WorldEditorSession,
  transactionId: string,
  snapshotValue: unknown,
): WorldEditorHistoryResult {
  const normalized = ensureOwnedEditorSession(template)
  if (!normalized.success) return normalized
  const validated = validateWorldProjectSnapshot(snapshotValue)
  if (!validated.success) return { success: false, issues: validated.issues }
  const before = normalized.session.snapshot
  if (validated.value.project.projectId !== before.project.projectId) {
    return failure('project-mismatch', 'snapshot.project.projectId', 'External transaction changed project identity.')
  }
  if (validated.value.project.revision !== before.project.revision + 1) {
    return failure('revision-mismatch', 'snapshot.project.revision', 'External transaction revision is not next.')
  }
  if (!transactionId || normalized.session.undoStack.some((entry) => entry.transactionId === transactionId)) {
    return failure('transaction-reuse', 'transactionId', 'External transaction already exists in editor history.')
  }
  const after = cloneWorldProjectSnapshot(validated.value)
  return { success: true, session: sealOwnedEditorSession({
    snapshot: after,
    undoStack: [...normalized.session.undoStack, { transactionId, before, after }],
    redoStack: [],
    receipts: normalized.session.receipts,
  }) }
}

export function transitionWorldPlaySession(session: WorldPlaySession, event: WorldPlayEvent): WorldPlayTransitionResult {
  if (session.state === 'loading' && event === 'loaded') return activeTransition(session, 'playing')
  if (session.state === 'loading' && event === 'stop') return activeTransition(session, 'stopping')
  if (session.state === 'playing' && event === 'pause') return activeTransition(session, 'paused')
  if (session.state === 'playing' && event === 'stop') return activeTransition(session, 'stopping')
  if (session.state === 'paused' && event === 'resume') return activeTransition(session, 'playing')
  if (session.state === 'paused' && event === 'stop') return activeTransition(session, 'stopping')
  if (session.state === 'stopping' && event === 'stopped') {
    return {
      success: true,
      session: Object.freeze({
        state: 'edit',
        editor: session.editor,
        sourceRevision: session.sourceRevision,
        runtimeSnapshot: null,
      }),
    }
  }
  return failure('play-transition', 'play.state', `Event ${event} is invalid while Play is ${session.state}.`)
}

function activeTransition(session: WorldActivePlaySession, state: WorldActivePlaySession['state']): WorldPlayTransitionResult {
  return { success: true, session: Object.freeze({ ...session, state }) }
}

function restoreWithNextRevision(snapshot: WorldProjectSnapshotV1, currentRevision: number): { success: true; snapshot: WorldProjectSnapshotV1 } | { success: false; issues: WorldCommandIssue[] } {
  if (currentRevision >= Number.MAX_SAFE_INTEGER) return failure('revision-overflow', 'project.revision', 'Project revision cannot be advanced safely.')
  const restored = cloneWorldProjectSnapshot(snapshot)
  restored.project.revision = currentRevision + 1
  const validated = validateWorldProjectSnapshot(restored)
  return validated.success ? { success: true, snapshot: validated.value } : { success: false, issues: validated.issues }
}

function cloneReceipt(receipt: WorldTransactionReceipt): WorldTransactionReceipt {
  return {
    transactionId: receipt.transactionId,
    fingerprint: receipt.fingerprint,
    canonicalPayload: receipt.canonicalPayload,
    appliedRevision: receipt.appliedRevision,
  }
}

function sealOwnedEditorSession(session: WorldEditorSession): WorldEditorSession {
  deepFreezeData(session.snapshot, new WeakSet<object>())
  deepFreezeData(session.undoStack, new WeakSet<object>())
  deepFreezeData(session.redoStack, new WeakSet<object>())
  deepFreezeData(session.receipts, new WeakSet<object>())
  Object.freeze(session)
  ownedSessions.add(session)
  return session
}

function ensureOwnedEditorSession(value: unknown): WorldEditorHistoryResult {
  if (typeof value === 'object' && value !== null && ownedSessions.has(value)) return { success: true, session: value as WorldEditorSession }
  return normalizeEditorSession(value)
}

function normalizeEditorSession(value: unknown): WorldEditorHistoryResult {
  const sessionRecord = readRecord(value, 'session', ['snapshot', 'undoStack', 'redoStack', 'receipts'])
  if (!sessionRecord.success) return sessionRecord
  const snapshot = validateClonedSnapshot(sessionRecord.value.snapshot)
  if (!snapshot.success) return snapshot
  const undoStack = validateEmptyAuthorityArray(sessionRecord.value.undoStack, 'session.undoStack', 'Unowned editor sessions cannot carry history authority.')
  if (!undoStack.success) return undoStack
  const redoStack = validateEmptyAuthorityArray(sessionRecord.value.redoStack, 'session.redoStack', 'Unowned editor sessions cannot carry history authority.')
  if (!redoStack.success) return redoStack
  const receipts = validateEmptyAuthorityArray(sessionRecord.value.receipts, 'session.receipts', 'Unowned editor sessions cannot carry transaction receipt authority.')
  if (!receipts.success) return receipts
  return {
    success: true,
    session: sealOwnedEditorSession({
      snapshot: snapshot.snapshot,
      undoStack: [],
      redoStack: [],
      receipts: [],
    }),
  }
}

function validateClonedSnapshot(value: unknown): { success: true; snapshot: WorldProjectSnapshotV1 } | { success: false; issues: WorldCommandIssue[] } {
  const validated = validateWorldProjectSnapshot(value)
  return validated.success
    ? { success: true, snapshot: cloneWorldProjectSnapshot(validated.value) }
    : { success: false, issues: validated.issues }
}

function readRecord(value: unknown, path: string, allowedKeys: readonly string[]): { success: true; value: Record<string, unknown> } | { success: false; issues: WorldCommandIssue[] } {
  if (!isPlainRecord(value)) return failure('invalid-session', path, 'World editor session data must be an ordinary object.')
  if (Object.getOwnPropertySymbols(value).length > 0) return failure('invalid-session', path, 'World editor session data cannot contain symbols.')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(descriptors)) {
    if (!allowed.has(key)) return failure('invalid-session', `${path}.${key}`, 'World editor session data contains an unsupported key.')
    if (!('value' in descriptors[key])) return failure('invalid-session', `${path}.${key}`, 'World editor session data cannot contain accessors.')
  }
  const output: Record<string, unknown> = {}
  for (const key of allowedKeys) {
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor)) return failure('invalid-session', `${path}.${key}`, 'World editor session data is missing required data.')
    output[key] = descriptor.value
  }
  return { success: true, value: output }
}

function validateEmptyAuthorityArray(value: unknown, path: string, nonemptyMessage: string): { success: true } | { success: false; issues: WorldCommandIssue[] } {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return failure('invalid-session', path, 'World editor session data must be an array.')
  if (Object.getOwnPropertySymbols(value).length > 0) return failure('invalid-session', path, 'World editor session arrays cannot contain symbols.')
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const rawLength: unknown = lengthDescriptor?.value
  if (typeof rawLength !== 'number' || !Number.isSafeInteger(rawLength) || rawLength < 0) {
    return failure('invalid-session', `${path}.length`, 'World editor session array length is invalid.')
  }
  if (rawLength !== 0) return failure('invalid-session', path, nonemptyMessage)
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value)
  for (const key of Object.keys(descriptors)) {
    if (key !== 'length') return failure('invalid-session', `${path}.${key}`, 'World editor session array contains an unsupported key.')
    if (!('value' in descriptors[key])) return failure('invalid-session', `${path}.${key}`, 'World editor session array cannot contain accessors.')
  }
  return { success: true }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function deepFreezeData<T>(value: T, seen: WeakSet<object>): T {
  if (typeof value !== 'object' || value === null || seen.has(value) || ownedFrozenData.has(value)) return value
  seen.add(value)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreezeData(descriptor.value, seen)
  }
  if (!Object.isFrozen(value)) Object.freeze(value)
  ownedFrozenData.add(value)
  return value
}

function failure(code: string, path: string, message: string): { success: false; issues: WorldCommandIssue[] } {
  return { success: false, issues: [{ code, path, message }] }
}

export function canonicalizeWorldCommandBatch(batch: WorldCommandBatchV1): WorldCommandBatchV1 {
  return structuredClone(batch)
}
