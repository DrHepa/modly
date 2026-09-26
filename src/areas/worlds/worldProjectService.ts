import { validateWorldProjectSnapshot } from './core/worldDocuments.ts'
import type { WorldProjectSnapshotV1 } from './core/worldModel.ts'
import { canonicalWorldCommandBatchPayload, parseWorldCommandBatch } from './core/worldCommands.ts'
import { parseWorldAiProposal, safeWorldAiText, WORLD_AI_COMMAND_BYTES } from './core/worldAiContract.ts'
import type {
  WorldProjectAiPreviewRequest,
  WorldProjectAiPreviewResult,
  WorldProjectAiDiscardRequest,
  WorldProjectResult,
  WorldsCliApi,
  WorldsCliApplyRequest,
  WorldsCliApplyReceipt,
  WorldsCliDirectEditAdoption,
  WorldsCliDirectEditCommitReceipt,
  WorldsCliDirectEditCorrelation,
  WorldsCliReply,
} from '../../shared/types/worldProjects.ts'
import { isWorldCanonicalId } from './core/worldValidationLimits.ts'
import {
  WORLD_PROJECT_PUBLIC_ERROR_CODES,
  isWorldProjectKey,
  type WorldProjectCommandRequest,
  type WorldProjectCommandResult,
  type WorldProjectCreateRequest,
  type WorldProjectCreateResult,
  type WorldProjectDeleteRequest,
  type WorldProjectDeleteResult,
  type WorldProjectKeyRequest,
  type WorldProjectListResult,
  type WorldProjectOpenResult,
  type WorldProjectPublicErrorCode,
  type WorldProjectsApi,
} from '../../shared/types/worldProjects.ts'

const SCENE_FILE_PATTERN = /^scene-[a-f0-9]{32}\.world-scene\.json$/
const SAFE_UNSUPPORTED_SCHEMA_PATTERN = /^modly\.world-project(?:-state)?\.v(?:[2-9]|[1-9][0-9]{1,8})$/
const SAFE_PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/

export type WorldProjectService = WorldProjectsApi & {
  applyExternalCli?(request: WorldsCliApplyRequest): Promise<WorldsCliReply<WorldsCliApplyReceipt>>
  cancelExternalCliIntent?(attemptId: string): Promise<boolean>
  commitExternalCliDirectIntent?(correlation: WorldsCliDirectEditCorrelation): Promise<WorldProjectDirectCommitResult>
  cancelExternalCliDirectIntent?(correlation: WorldsCliDirectEditCorrelation): Promise<WorldProjectDirectCancelResult>
  adoptExternalCliDirectIntent?(adoption: WorldsCliDirectEditAdoption): Promise<WorldProjectDirectAdoptResult>
  leaveExternalCliEditor?(): Promise<WorldProjectDirectLeaveResult>
}

export type WorldProjectDirectFailureCode = 'STALE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'UNAVAILABLE'
export type WorldProjectDirectCommitResult =
  | { ok: true; receipt: WorldsCliDirectEditCommitReceipt }
  | { ok: false; code: WorldProjectDirectFailureCode }
export type WorldProjectDirectCancelResult =
  | { ok: true; status: 'STALE' | 'AMBIGUOUS' }
  | { ok: false; code: WorldProjectDirectFailureCode }
export type WorldProjectDirectAdoptResult =
  | { ok: true; status: 'APPLIED' }
  | { ok: false; code: WorldProjectDirectFailureCode }
export type WorldProjectDirectLeaveResult = { ok: true } | { ok: false; code: 'UNAVAILABLE' }

type WorldProjectCliAdapter = Pick<WorldsCliApi, 'apply'> & Partial<Pick<WorldsCliApi,
  'cancelApplyIntent' | 'commitDirectEdit' | 'cancelDirectEdit' | 'adoptDirectEdit' | 'editorLeft'>>

export function createWorldProjectService(providedApi?: WorldProjectsApi, providedCliApi?: WorldProjectCliAdapter): WorldProjectService {
  const api = providedApi ?? resolveWorldProjectsApi()
  const cli = () => providedCliApi ?? window.electron.workspace.worlds.cli
  return {
    previewAi: async (request) => normalizeAiPreview(await safeCall(() => api.previewAi ? api.previewAi(request) : Promise.resolve(internalFailure())), request),
    discardAi: async (request) => {
      const value = await safeCall(() => api.discardAi ? api.discardAi(request) : Promise.resolve(internalFailure()))
      const failure = normalizeFailure(value)
      if (failure) return failure
      try { const record = exactRecord(successValue(value), ['discarded']); if (record.discarded !== true) throw new Error(); return { ok: true, value: { discarded: true } } } catch { return invalidResponse() }
    },
    create: async (request) => normalizeCreate(await safeCall(() => api.create(request)), request),
    list: async () => normalizeList(await safeCall(() => api.list())),
    open: async (request) => normalizeOpen(await safeCall(() => api.open(request)), request),
    previewCommands: async (request) => normalizeCommand(await safeCall(() => api.previewCommands(request)), request),
    applyCommands: async (request) => normalizeCommand(await safeCall(() => api.applyCommands(request)), request),
    applyExternalCli: async (request) => normalizeExternalCliApply(await safeCall(() => cli().apply(request))),
    cancelExternalCliIntent: async (attemptId) => {
      try {
        const result = await cli().cancelApplyIntent?.({ attemptId })
        return result !== undefined && result.ok === true && Object.keys(result).length === 1
      } catch { return false }
    },
    commitExternalCliDirectIntent: async (value) => {
      const correlation = directCorrelationValue(value)
      if (!correlation) return directFailure('UNAVAILABLE')
      const operation = cli().commitDirectEdit
      if (!operation) return directFailure('UNAVAILABLE')
      try { return normalizeDirectCommit(await operation(correlation)) }
      catch { return directFailure('AMBIGUOUS') }
    },
    cancelExternalCliDirectIntent: async (value) => {
      const correlation = directCorrelationValue(value)
      if (!correlation) return directFailure('UNAVAILABLE')
      const operation = cli().cancelDirectEdit
      if (!operation) return directFailure('UNAVAILABLE')
      try { return normalizeDirectCancel(await operation(correlation)) }
      catch { return directFailure('UNAVAILABLE') }
    },
    adoptExternalCliDirectIntent: async (value) => {
      const adoption = directAdoptionValue(value)
      if (!adoption) return directFailure('UNAVAILABLE')
      const operation = cli().adoptDirectEdit
      if (!operation) return directFailure('UNAVAILABLE')
      try { return normalizeDirectAdoption(await operation(adoption)) }
      catch { return directFailure('UNAVAILABLE') }
    },
    leaveExternalCliEditor: async () => {
      const operation = cli().editorLeft
      if (!operation) return directFailure('UNAVAILABLE')
      try {
        const value = exactRecord(await operation(), ['ok'])
        return value.ok === true && Object.keys(value).length === 1 ? { ok: true } : directFailure('UNAVAILABLE')
      } catch { return directFailure('UNAVAILABLE') }
    },
    delete: async (request) => normalizeDelete(await safeCall(() => api.delete(request)), request),
  }
}

export const worldProjectService: WorldProjectService = {
  previewAi: (request: WorldProjectAiPreviewRequest) => createWorldProjectService().previewAi!(request),
  discardAi: (request: WorldProjectAiDiscardRequest): Promise<WorldProjectResult<{ discarded: true }>> => createWorldProjectService().discardAi!(request),
  create: (request: WorldProjectCreateRequest) => createWorldProjectService().create(request),
  list: () => createWorldProjectService().list(),
  open: (request: WorldProjectKeyRequest) => createWorldProjectService().open(request),
  previewCommands: (request: WorldProjectCommandRequest) => createWorldProjectService().previewCommands(request),
  applyCommands: (request: WorldProjectCommandRequest) => createWorldProjectService().applyCommands(request),
  applyExternalCli: (request: WorldsCliApplyRequest) => createWorldProjectService().applyExternalCli!(request),
  cancelExternalCliIntent: (attemptId: string) => createWorldProjectService().cancelExternalCliIntent!(attemptId),
  commitExternalCliDirectIntent: (correlation: WorldsCliDirectEditCorrelation) => createWorldProjectService().commitExternalCliDirectIntent!(correlation),
  cancelExternalCliDirectIntent: (correlation: WorldsCliDirectEditCorrelation) => createWorldProjectService().cancelExternalCliDirectIntent!(correlation),
  adoptExternalCliDirectIntent: (adoption: WorldsCliDirectEditAdoption) => createWorldProjectService().adoptExternalCliDirectIntent!(adoption),
  leaveExternalCliEditor: () => createWorldProjectService().leaveExternalCliEditor!(),
  delete: (request: WorldProjectDeleteRequest) => createWorldProjectService().delete(request),
}

function directCorrelationValue(value: unknown): WorldsCliDirectEditCorrelation | null {
  try {
    const record = exactRecord(value, ['nonce', 'editIntent'])
    if (Object.keys(record).length !== 2 || typeof record.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(record.nonce)
      || typeof record.editIntent !== 'string' || !/^edit_[a-f0-9]{48}$/.test(record.editIntent)) return null
    return { nonce: record.nonce, editIntent: record.editIntent }
  } catch { return null }
}

function directAdoptionValue(value: unknown): WorldsCliDirectEditAdoption | null {
  try {
    const record = exactRecord(value, ['nonce', 'editIntent', 'transactionId', 'newRevision', 'snapshotSha256'])
    if (Object.keys(record).length !== 5 || !directCorrelationValue({ nonce: record.nonce, editIntent: record.editIntent })
      || typeof record.transactionId !== 'string' || !/^[a-f0-9]{32}$/.test(record.transactionId)
      || !Number.isSafeInteger(record.newRevision) || (record.newRevision as number) < 1
      || typeof record.snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.snapshotSha256)) return null
    return { nonce: record.nonce as string, editIntent: record.editIntent as string,
      transactionId: record.transactionId, newRevision: record.newRevision as number, snapshotSha256: record.snapshotSha256 }
  } catch { return null }
}

function normalizeDirectCommit(value: unknown): WorldProjectDirectCommitResult {
  try {
    const outer = exactRecord(value, ['ok', 'code', 'receipt'])
    if (outer.ok === false && Object.keys(outer).length === 2) return directFailure(directFailureCode(outer.code, 'AMBIGUOUS'))
    if (outer.ok !== true || Object.keys(outer).length !== 2) return directFailure('AMBIGUOUS')
    const receipt = exactRecord(outer.receipt, ['transactionId', 'projectId', 'newRevision', 'snapshotSha256'])
    if (Object.keys(receipt).length !== 4 || typeof receipt.transactionId !== 'string' || !/^[a-f0-9]{32}$/.test(receipt.transactionId)
      || typeof receipt.projectId !== 'string' || !/^project:[A-Za-z0-9:_-]{1,128}$/.test(receipt.projectId)
      || !Number.isSafeInteger(receipt.newRevision) || (receipt.newRevision as number) < 1
      || typeof receipt.snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.snapshotSha256)) return directFailure('AMBIGUOUS')
    return { ok: true, receipt: { transactionId: receipt.transactionId, projectId: receipt.projectId,
      newRevision: receipt.newRevision as number, snapshotSha256: receipt.snapshotSha256 } }
  } catch { return directFailure('AMBIGUOUS') }
}

function normalizeDirectCancel(value: unknown): WorldProjectDirectCancelResult {
  try {
    const outer = exactRecord(value, ['ok', 'code', 'status'])
    if (outer.ok === false && Object.keys(outer).length === 2) return directFailure(directFailureCode(outer.code, 'UNAVAILABLE'))
    if (outer.ok === true && Object.keys(outer).length === 2 && (outer.status === 'STALE' || outer.status === 'AMBIGUOUS')) {
      return { ok: true, status: outer.status }
    }
  } catch { /* Normalize below. */ }
  return directFailure('UNAVAILABLE')
}

function normalizeDirectAdoption(value: unknown): WorldProjectDirectAdoptResult {
  try {
    const outer = exactRecord(value, ['ok', 'code', 'status'])
    if (outer.ok === false && Object.keys(outer).length === 2) return directFailure(directFailureCode(outer.code, 'UNAVAILABLE'))
    if (outer.ok === true && Object.keys(outer).length === 2 && outer.status === 'APPLIED') return { ok: true, status: 'APPLIED' }
    if (outer.ok === true) return directFailure('AMBIGUOUS')
  } catch { /* An invoked adoption with a malformed reply has unknown terminal state. */ }
  return directFailure('AMBIGUOUS')
}

function directFailureCode(value: unknown, fallback: WorldProjectDirectFailureCode): WorldProjectDirectFailureCode {
  return value === 'STALE' || value === 'AMBIGUOUS' || value === 'NOT_FOUND' || value === 'UNAVAILABLE' ? value : fallback
}

function directFailure<T extends WorldProjectDirectFailureCode>(code: T): { ok: false; code: T } {
  return { ok: false, code }
}

function normalizeExternalCliApply(value: unknown): WorldsCliReply<WorldsCliApplyReceipt> {
  try {
    const outer = exactRecord(value, ['ok', 'code', 'transactionId', 'projectId', 'baseRevision', 'newRevision', 'beforeSnapshotSha256', 'snapshotSha256'])
    if (outer.ok === false && typeof outer.code === 'string' && /^[A-Z_]{1,32}$/.test(outer.code)
      && Object.keys(outer).length === 2) return { ok: false, code: outer.code }
    if (outer.ok !== true || Object.keys(outer).length !== 7 || typeof outer.transactionId !== 'string'
      || !SAFE_PUBLIC_TOKEN_PATTERN.test(outer.transactionId) || !isWorldCanonicalId(outer.projectId)
      || !Number.isSafeInteger(outer.baseRevision) || (outer.baseRevision as number) < 0
      || !Number.isSafeInteger(outer.newRevision) || (outer.newRevision as number) !== (outer.baseRevision as number) + 1
      || typeof outer.snapshotSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(outer.snapshotSha256) || typeof outer.beforeSnapshotSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(outer.beforeSnapshotSha256)) throw new Error()
    return { ok: true, transactionId: outer.transactionId, projectId: outer.projectId,
      baseRevision: outer.baseRevision as number, newRevision: outer.newRevision as number,
      beforeSnapshotSha256: outer.beforeSnapshotSha256, snapshotSha256: outer.snapshotSha256 }
  } catch { return { ok: false, code: 'AMBIGUOUS' } }
}

function normalizeAiPreview(value: unknown, request: WorldProjectAiPreviewRequest): WorldProjectAiPreviewResult {
  const failure = normalizeFailure(value)
  if (failure) return failure
  try {
    const context = parseWorldAiProposal(request.proposal).context
    const record = exactRecord(successValue(value), ['batch', 'result', 'details', 'authority'])
    const parsed = parseWorldCommandBatch(record.batch)
    if (!parsed.success || parsed.value.transactionId !== context.requestId || parsed.value.projectId !== context.projectId
      || parsed.value.baseRevision !== context.baseRevision || parsed.value.origin !== 'ai' || parsed.value.commands.length > 16
      || new TextEncoder().encode(canonicalWorldCommandBatchPayload(parsed.value)).length > WORLD_AI_COMMAND_BYTES
      || typeof record.authority !== 'string' || !/^apply_[a-f0-9]{48}$/.test(record.authority)) throw new Error()
    const result = normalizeCommand({ ok: true, value: record.result }, { projectKey: context.projectKey, batch: parsed.value })
    if (!result.ok || result.value.idempotent || !Array.isArray(record.details) || !record.details.length || record.details.length > 512) throw new Error()
    const details = record.details.map((value) => {
      const diff = exactRecord(value, ['entityId', 'entityName', 'property', 'before', 'after'])
      if (['entityId', 'entityName', 'property', 'before', 'after'].some((key) => typeof diff[key] !== 'string' || safeWorldAiText(diff[key] as string) !== diff[key])) throw new Error()
      return { entityId: diff.entityId as string, entityName: diff.entityName as string, property: diff.property as string, before: diff.before as string, after: diff.after as string }
    })
    return { ok: true, value: { batch: parsed.value, result: result.value, details, authority: record.authority } }
  } catch { return invalidResponse() }
}

async function safeCall(operation: () => Promise<unknown>): Promise<unknown> {
  try { return await operation() } catch { return internalFailure() }
}

function normalizeCreate(value: unknown, request: WorldProjectCreateRequest): WorldProjectCreateResult {
  const failure = normalizeFailure(value)
  if (failure) return failure
  try {
    const result = successValue(value)
    const projectKey = projectKeyValue(result.projectKey)
    const snapshot = snapshotValue(result.snapshot, projectKey)
    if (request.projectId !== undefined && snapshot.project.projectId !== request.projectId) throw new Error()
    if (request.initialSceneId !== undefined
      && (snapshot.project.startSceneId !== request.initialSceneId
        || !snapshot.scenes.some((scene) => scene.sceneId === request.initialSceneId))) throw new Error()
    return { ok: true, value: { projectKey, snapshot, durabilityWarnings: publicTokenArray(result.durabilityWarnings) } }
  } catch { return invalidResponse() }
}

function normalizeList(value: unknown): WorldProjectListResult {
  const failure = normalizeFailure(value)
  if (failure) return failure
  try {
    const result = successValue(value)
    if (!Array.isArray(result.projects) || !Array.isArray(result.issues)) throw new Error()
    const projects = result.projects.map((item) => {
      const record = exactRecord(item, ['projectKey', 'status', 'projectId', 'name', 'revision', 'schema'])
      const projectKey = projectKeyValue(record.projectKey)
      if (record.status === 'ready' || record.status === 'duplicate-project-id') {
        if (!isWorldCanonicalId(record.projectId) || typeof record.name !== 'string'
          || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0
          || hasOwn(record, 'schema')) throw new Error()
        return {
          projectKey,
          status: record.status as 'ready' | 'duplicate-project-id',
          projectId: record.projectId,
          name: record.name,
          revision: record.revision,
        }
      }
      if (record.status === 'unsupported') {
        if (!isSafeUnsupportedSchema(record.schema)
          || hasOwn(record, 'projectId') || hasOwn(record, 'name') || hasOwn(record, 'revision')) throw new Error()
        return { projectKey, status: 'unsupported' as const, schema: record.schema }
      }
      if (record.status === 'needs-recovery') {
        if (hasOwn(record, 'projectId') || hasOwn(record, 'name')
          || hasOwn(record, 'revision') || hasOwn(record, 'schema')) throw new Error()
        return { projectKey, status: 'needs-recovery' as const }
      }
      if (record.status !== 'corrupt'
        || hasOwn(record, 'projectId') || hasOwn(record, 'name') || hasOwn(record, 'revision') || hasOwn(record, 'schema')) throw new Error()
      return { projectKey, status: 'corrupt' as const }
    })
    const issues = result.issues.map((item) => {
      const record = exactRecord(item, ['projectKey', 'status', 'code'])
      const projectKey = projectKeyValue(record.projectKey)
      if (record.status === 'unsupported' && record.code === 'unsupported_schema') {
        return { projectKey, status: 'unsupported' as const, code: 'unsupported_schema' as const }
      }
      if (record.status === 'corrupt' && record.code === 'corrupt_project') {
        return { projectKey, status: 'corrupt' as const, code: 'corrupt_project' as const }
      }
      if (record.status === 'duplicate-project-id' && record.code === 'duplicate_project_id') {
        return { projectKey, status: 'duplicate-project-id' as const, code: 'duplicate_project_id' as const }
      }
      if (record.status === 'needs-recovery' && record.code === 'recovery_required') {
        return { projectKey, status: 'needs-recovery' as const, code: 'recovery_required' as const }
      }
      throw new Error()
    })
    return { ok: true, value: { projects, issues } }
  } catch { return invalidResponse() }
}

function normalizeOpen(value: unknown, request: WorldProjectKeyRequest): WorldProjectOpenResult {
  const failure = normalizeFailure(value)
  if (failure) return failure
  try {
    const result = successValue(value)
    if (result.status === 'unsupported') {
      const record = exactRecord(result, ['status', 'projectKey', 'schema', 'readOnly'])
      if (record.readOnly !== true || !isSafeUnsupportedSchema(record.schema)) throw new Error()
      const projectKey = projectKeyValue(record.projectKey)
      if (projectKey !== request.projectKey) throw new Error()
      return { ok: true, value: { status: 'unsupported', projectKey, schema: record.schema, readOnly: true } }
    }
    const record = exactRecord(result, ['status', 'projectKey', 'snapshot', 'durabilityWarnings'])
    if (record.status !== 'ready') throw new Error()
    const projectKey = projectKeyValue(record.projectKey)
    if (projectKey !== request.projectKey) throw new Error()
    return {
      ok: true,
      value: {
        status: 'ready',
        projectKey,
        snapshot: snapshotValue(record.snapshot, projectKey),
        durabilityWarnings: publicTokenArray(record.durabilityWarnings),
      },
    }
  } catch { return invalidResponse() }
}

function normalizeCommand(value: unknown, request: WorldProjectCommandRequest): WorldProjectCommandResult {
  const failure = normalizeFailure(value)
  if (failure) return failure
  try {
    const result = successValue(value)
    const record = exactRecord(result, [
      'projectKey', 'snapshot', 'newRevision', 'idempotent', 'changes', 'warnings', 'inverse', 'receipt',
    ])
    const projectKey = projectKeyValue(record.projectKey)
    if (projectKey !== request.projectKey) throw new Error()
    const snapshot = snapshotValue(record.snapshot, projectKey)
    if (typeof record.newRevision !== 'number' || !Number.isSafeInteger(record.newRevision)
      || record.newRevision < 0 || snapshot.project.revision !== record.newRevision
      || snapshot.project.projectId !== request.batch.projectId
      || typeof record.idempotent !== 'boolean') throw new Error()
    const inverseRecord = exactRecord(record.inverse, ['kind', 'snapshot'])
    if (inverseRecord.kind !== 'world-snapshot') throw new Error()
    const receipt = exactRecord(record.receipt, ['transactionId', 'payloadSha256', 'resultSha256', 'appliedRevision'])
    if (
      !isWorldCanonicalId(receipt.transactionId)
      || receipt.transactionId !== request.batch.transactionId
      || typeof receipt.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.payloadSha256)
      || typeof receipt.resultSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.resultSha256)
      || receipt.appliedRevision !== record.newRevision
    ) throw new Error()
    return {
      ok: true,
      value: {
        projectKey,
        snapshot,
        newRevision: record.newRevision,
        idempotent: record.idempotent,
        changes: publicTokenArray(record.changes, true),
        warnings: publicTokenArray(record.warnings, true),
        inverse: {
          kind: 'world-snapshot',
          snapshot: inverseSnapshotValue(inverseRecord.snapshot, projectKey, snapshot.project.projectId, record.newRevision),
        },
        receipt: {
          transactionId: receipt.transactionId,
          payloadSha256: receipt.payloadSha256,
          resultSha256: receipt.resultSha256,
          appliedRevision: receipt.appliedRevision as number,
        },
      },
    }
  } catch { return invalidResponse() }
}

function normalizeDelete(value: unknown, request: WorldProjectDeleteRequest): WorldProjectDeleteResult {
  const failure = normalizeFailure(value)
  if (failure) return failure
  try {
    const result = successValue(value)
    const record = exactRecord(result, ['projectKey', 'transactionId', 'idempotent'])
    const projectKey = projectKeyValue(record.projectKey)
    if (projectKey !== request.projectKey || !isWorldCanonicalId(record.transactionId)
      || record.transactionId !== request.transactionId || typeof record.idempotent !== 'boolean') throw new Error()
    return { ok: true, value: { projectKey, transactionId: record.transactionId, idempotent: record.idempotent } }
  } catch { return invalidResponse() }
}

function normalizeFailure(value: unknown): { ok: false; error: { code: WorldProjectPublicErrorCode; message: string; retryable: boolean } } | null {
  try {
    const envelope = exactRecord(value, ['ok', 'error', 'value'])
    if (envelope.ok !== false) return null
    if (hasOwn(envelope, 'value')) throw new Error()
    const error = exactRecord(envelope.error, ['code', 'message', 'retryable', 'issues'])
    if (typeof error.code !== 'string' || !WORLD_PROJECT_PUBLIC_ERROR_CODES.includes(error.code as WorldProjectPublicErrorCode)
      || typeof error.message !== 'string' || typeof error.retryable !== 'boolean') throw new Error()
    const code = error.code as WorldProjectPublicErrorCode
    return { ok: false, error: { code, message: publicMessage(code), retryable: error.retryable } }
  } catch { return invalidResponse() }
}

function successValue(value: unknown): Record<string, unknown> {
  const envelope = exactRecord(value, ['ok', 'value'])
  if (envelope.ok !== true) throw new Error()
  return exactRecord(envelope.value)
}

function snapshotValue(value: unknown, projectKey: string): WorldProjectSnapshotV1 {
  const parsed = validateWorldProjectSnapshot(value)
  if (!parsed.success) throw new Error()
  assertSnapshotConfinement(projectKey, parsed.value)
  return parsed.value
}

function inverseSnapshotValue(
  value: unknown,
  projectKey: string,
  projectId: string,
  newRevision: unknown,
): WorldProjectSnapshotV1 {
  const snapshot = snapshotValue(value, projectKey)
  if (snapshot.project.projectId !== projectId || typeof newRevision !== 'number'
    || snapshot.project.revision + 1 !== newRevision) throw new Error()
  return snapshot
}

function assertSnapshotConfinement(projectKey: string, snapshot: WorldProjectSnapshotV1): void {
  const prefix = `Worlds/${projectKey}/scenes/`
  const paths = new Set<string>()
  for (const reference of snapshot.project.scenes) {
    if (!reference.documentPath.startsWith(prefix)) throw new Error()
    const filename = reference.documentPath.slice(prefix.length)
    if (!SCENE_FILE_PATTERN.test(filename) || reference.documentPath !== `${prefix}${filename}` || paths.has(reference.documentPath)) {
      throw new Error()
    }
    paths.add(reference.documentPath)
  }
  if (paths.size !== snapshot.scenes.length) throw new Error()
}

function projectKeyValue(value: unknown): string {
  if (!isWorldProjectKey(value)) throw new Error()
  return value
}

function publicTokenArray(value: unknown, deterministic = false): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'
    || item.length > 512 || !SAFE_PUBLIC_TOKEN_PATTERN.test(item))) throw new Error()
  const result = [...value]
  if (deterministic) {
    const normalized = [...new Set(result)].sort(codeUnitCompare)
    if (normalized.length !== result.length || normalized.some((entry, index) => entry !== result[index])) throw new Error()
  }
  return result
}

function isSafeUnsupportedSchema(value: unknown): value is string {
  return typeof value === 'string' && SAFE_UNSUPPORTED_SCHEMA_PATTERN.test(value)
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactRecord(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const allowed = keys ? new Set(keys) : null
  const record: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || (allowed && !allowed.has(key))) throw new Error()
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor)) throw new Error()
    Object.defineProperty(record, key, { value: descriptor.value, enumerable: true })
  }
  return record
}

function invalidResponse() {
  return { ok: false, error: { code: 'invalid_document', message: 'World project response is invalid.', retryable: false } } as const
}

function internalFailure() {
  return { ok: false, error: { code: 'internal_error', message: 'World project operation failed.', retryable: true } } as const
}

function publicMessage(code: WorldProjectPublicErrorCode): string {
  return {
    invalid_request: 'World project request is invalid.',
    project_not_found: 'World project was not found.',
    revision_conflict: 'World project revision changed.',
    transaction_reuse: 'World project transaction id was already used.',
    unsafe_workspace: 'World project workspace is unsafe.',
    invalid_document: 'World project document is invalid.',
    unsupported_schema: 'World project schema is unsupported.',
    project_busy: 'World project repository is busy.',
    recovery_failed: 'World project recovery failed.',
    write_failed: 'World project write failed.',
    unauthorized: 'World project request is unauthorized.',
    internal_error: 'World project operation failed.',
  }[code]
}

function resolveWorldProjectsApi(): WorldProjectsApi {
  const api = window.electron?.workspace?.worlds?.projects
  if (!api) throw new Error('World project APIs are unavailable.')
  return api
}
