import { describeWorldAiCandidate, sameWorldAiContext, parseWorldAiContext, parseWorldAiProposal, validateWorldAiCommands, type WorldAiLegacyCommand, type WorldAiProposal, type WorldAiContext, type WorldAiPropertyDiff } from '../core/worldAiContract.ts'
import {
  applyWorldCommandBatch,
  fingerprintWorldCommandBatch,
  parseWorldCommandBatch,
  type WorldCommand,
  type WorldCommandBatchV1,
  type WorldCommandIssue,
  type WorldCommandOrigin,
} from '../core/worldCommands.ts'
import { WORLD_COMMAND_BATCH_SCHEMA, type WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import {
  adoptWorldEditorAuthoritativeSnapshot,
  adoptWorldEditorExternalTransaction,
  applyWorldEditorCommandBatch,
  createWorldEditorSession,
  previewWorldCommandBatch,
  redoWorldEditorSession,
  undoWorldEditorSession,
  type WorldEditorSession,
} from '../core/worldSessions.ts'
import { buildWorldSnapshotTransitionCommands } from './worldEditorCommandBuilders.ts'
import { worldProjectService, type WorldProjectService } from '../worldProjectService.ts'
import { canonicalWorldProjectSnapshotPayload } from '../core/worldSnapshotDigest.ts'
import type {
  WorldProjectCommandSuccess,
  WorldProjectCommandRequest,
  WorldProjectCreateRequest,
  WorldProjectPublicErrorCode,
  WorldProjectSummary,
  WorldProjectTransactionReceipt,
  WorldsCliDirectEditCommitReceipt,
  WorldsCliDirectEditRequest,
} from '../../../shared/types/worldProjects.ts'

const MAX_CONTROLLER_RECEIPTS = 256

export type WorldEditorControllerLifecycle = 'closed' | 'loading' | 'ready' | 'error'

export type WorldEditorControllerErrorCode =
  | WorldProjectPublicErrorCode
  | 'project_closed'
  | 'scene_missing'
  | 'unsupported_project'
  | 'invalid_response'
  | 'invalid_command'
  | 'undo_empty'
  | 'redo_empty'

export interface WorldEditorControllerError {
  code: WorldEditorControllerErrorCode
  message: string
  retryable: boolean
  issues?: WorldCommandIssue[]
}

export type WorldEditorControllerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorldEditorControllerError }

export interface WorldEditorControllerState {
  editorEpoch: number
  lifecycle: WorldEditorControllerLifecycle
  error: WorldEditorControllerError | null
  projects: readonly WorldProjectSummary[]
  projectKey: string | null
  session: WorldEditorSession | null
  activeSceneId: string | null
  savedRevision: number | null
  canUndo: boolean
  canRedo: boolean
  externalCliUndoTransactionId: string | null
}

export interface WorldEditorExternalCliApplyRequest {
  proposalId: string
  reviewId: string
  scope: WorldEditorDispatchAuthority
  editorEpoch: number
  /** UI intent guard only; Main independently authorizes and confirms the write. */
  isCurrent(): boolean
}
export type WorldEditorExternalCliApplyOutcome =
  | { status: 'applied'; transactionId: string; revision: number }
  | { status: 'cancelled' }
  | { status: 'stale'; reason: string }
  | { status: 'unverified'; reason: string }

export type WorldEditorScopedCliIntentOutcome =
  | { status: 'applied'; transactionId: string; revision: number }
  | { status: 'stale'; reason: string }
  | { status: 'rejected'; reason: 'invalid_request' | 'busy' }
  | { status: 'unverified'; reason: string; localAdoption: 'none' | 'verified' }

export type WorldEditorExternalCliBarrierResult =
  | { ok: true }
  | { ok: false; code: 'reviewed_unacknowledged' | 'direct_ambiguous' | 'direct_unavailable' }

export interface WorldEditorDispatchRequest {
  transactionId: string
  origin: WorldCommandOrigin
  commands: WorldCommand[]
}

/** Optimistic assertion only. It never supplies batch authority. */
export interface WorldEditorDispatchAuthority {
  projectKey: string
  projectId: string
  baseRevision: number
  activeSceneId: string
}

export interface WorldEditorDispatchSuccess {
  transactionId: string
  revision: number
  idempotent: boolean
  changes: readonly string[]
  warnings: readonly string[]
  receipt: WorldProjectTransactionReceipt
}

export interface WorldEditorProposalGuard {
  context: WorldAiContext
  isCurrent(): boolean
}

export interface WorldEditorProposalPreview {
  aiAuthority?: string
  details: readonly WorldAiPropertyDiff[]
  batch: WorldCommandBatchV1
  fingerprint: string
  changes: readonly string[]
  warnings: readonly string[]
}

export interface WorldEditorController {
  previewAiProposal(proposal: WorldAiProposal, guard: WorldEditorProposalGuard): Promise<WorldEditorControllerResult<WorldEditorProposalPreview>>
  discardAiProposal(authority: string, context: WorldAiContext): Promise<void>
  getState(): WorldEditorControllerState
  subscribe(listener: (state: WorldEditorControllerState) => void): () => void
  createProject(request: WorldProjectCreateRequest): Promise<WorldEditorControllerResult<WorldEditorControllerState>>
  listProjects(): Promise<WorldEditorControllerResult<readonly WorldProjectSummary[]>>
  openProject(projectKey: string): Promise<WorldEditorControllerResult<WorldEditorControllerState>>
  closeProject(): Promise<WorldEditorControllerResult<void>>
  setActiveScene(sceneId: string): Promise<WorldEditorControllerResult<WorldEditorControllerState>>
  dispatchCommands(request: WorldEditorDispatchRequest, expectedAuthority?: WorldEditorDispatchAuthority): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
  previewProposal(request: WorldEditorDispatchRequest, guard?: WorldEditorProposalGuard): Promise<WorldEditorControllerResult<WorldEditorProposalPreview>>
  applyProposalExact(batch: WorldCommandBatchV1, guard?: WorldEditorProposalGuard, aiAuthority?: string): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
  undo(guard?: WorldEditorProposalGuard): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
  applyExternalCliProposal(request: WorldEditorExternalCliApplyRequest): Promise<WorldEditorControllerResult<WorldEditorExternalCliApplyOutcome>>
  cancelExternalCliApplyIntent(): Promise<boolean>
  applyScopedCliIntent(request: WorldsCliDirectEditRequest): Promise<WorldEditorControllerResult<WorldEditorScopedCliIntentOutcome>>
  cancelExternalCliIntents(): Promise<WorldEditorExternalCliBarrierResult>
  classifyExternalCliEditorLifecycle(
    previous: WorldEditorControllerState,
    current: WorldEditorControllerState,
    previousPlayLifecycle: string,
    currentPlayLifecycle: string,
  ): 'retain' | 'revoke'
  undoExternalCli(transactionId: string): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
  redo(): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
  refresh(): Promise<WorldEditorControllerResult<WorldEditorControllerState>>
  deleteProject(transactionId: string): Promise<WorldEditorControllerResult<void>>
}

interface CachedDispatch {
  logicalPayload: string
  projectKey: string
  projectId: string
  result: WorldEditorDispatchSuccess
}

type DirectIntentPhase = 'queued' | 'commit_inflight' | 'reopen_verify' | 'adopted_local'
  | 'ack_inflight' | 'applied' | 'reconciling' | 'unverified'

interface ActiveScopedCliIntent {
  request: Readonly<WorldsCliDirectEditRequest>
  beforeState: WorldEditorControllerState
  capturedSession: WorldEditorSession
  expectedRevision: number
  phase: DirectIntentPhase
  commitInvoked: boolean
  adoptionAckInvoked: boolean
  leaveInvoked: boolean
  cancelRequested: boolean
  receipt: WorldsCliDirectEditCommitReceipt | null
  cancellationPromise: ReturnType<NonNullable<WorldProjectService['cancelExternalCliDirectIntent']>> | null
  resultPromise: Promise<WorldEditorControllerResult<WorldEditorScopedCliIntentOutcome>>
}

export function createWorldEditorController(gateway: WorldProjectService = worldProjectService): WorldEditorController {
  return new DefaultWorldEditorController(gateway)
}

class DefaultWorldEditorController implements WorldEditorController {
  readonly #gateway: WorldProjectService
  readonly #listeners = new Set<(state: WorldEditorControllerState) => void>()
  readonly #dispatches = new Map<string, CachedDispatch>()
  #editorEpoch = 0
  #state: WorldEditorControllerState = freezeState({
    editorEpoch: 0,
    lifecycle: 'closed',
    error: null,
    projects: [],
    projectKey: null,
    session: null,
    activeSceneId: null,
    savedRevision: null,
    canUndo: false,
    canRedo: false,
    externalCliUndoTransactionId: null,
  })
  #queue: Promise<void> = Promise.resolve()
  #externalCliUndo: { transactionId: string; projectKey: string; revision: number } | null = null
  #activeApplyIntent: { id: string; cancelRequested: boolean; acknowledgement: Promise<boolean> | null } | null = null
  #activeScopedCliIntent: ActiveScopedCliIntent | null = null

  constructor(gateway: WorldProjectService) {
    this.#gateway = gateway
  }

  getState(): WorldEditorControllerState {
    return this.#state
  }

  subscribe(listener: (state: WorldEditorControllerState) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  createProject(request: WorldProjectCreateRequest): Promise<WorldEditorControllerResult<WorldEditorControllerState>> {
    return this.#enqueue(async () => {
      this.#editorEpoch += 1
      const preserved = this.#state
      this.#loading()
      const result = await this.#gateway.create(structuredClone(request))
      if (!result.ok) return this.#gatewayFailure(result.error, preserved)
      const session = createWorldEditorSession(result.value.snapshot)
      if (!session.success) return this.#localFailure('invalid_response', 'Created project snapshot is invalid.', session.issues, preserved)
      this.#externalCliUndo = null
      this.#dispatches.clear()
      this.#publishReady(result.value.projectKey, session.session, session.session.snapshot.project.startSceneId)
      return ok(this.#state)
    })
  }

  listProjects(): Promise<WorldEditorControllerResult<readonly WorldProjectSummary[]>> {
    return this.#enqueue(async () => {
      const preserved = this.#state
      this.#loading()
      const result = await this.#gateway.list()
      if (!result.ok) return this.#gatewayFailure(result.error, preserved)
      const projects = deepFreezeData(structuredClone(result.value.projects))
      this.#publish({
        ...preserved,
        lifecycle: preserved.session ? 'ready' : 'closed',
        error: null,
        projects,
      })
      return ok(projects)
    })
  }

  openProject(projectKey: string): Promise<WorldEditorControllerResult<WorldEditorControllerState>> {
    return this.#enqueue(async () => this.#openProject(projectKey, this.#state))
  }

  closeProject(): Promise<WorldEditorControllerResult<void>> {
    return this.#enqueue(async () => {
      this.#editorEpoch += 1
      this.#externalCliUndo = null
      this.#dispatches.clear()
      this.#publish({
        ...this.#state,
        lifecycle: 'closed',
        error: null,
        projectKey: null,
        session: null,
        activeSceneId: null,
        savedRevision: null,
        canUndo: false,
        canRedo: false,
        externalCliUndoTransactionId: null,
      })
      return ok(undefined)
    })
  }

  setActiveScene(sceneId: string): Promise<WorldEditorControllerResult<WorldEditorControllerState>> {
    return this.#enqueue(async () => {
      const session = this.#state.session
      if (!session) return this.#localFailure('project_closed', 'Open a World project before selecting a scene.')
      if (!session.snapshot.scenes.some((scene) => scene.sceneId === sceneId)) {
        return this.#localFailure('scene_missing', `Scene ${sceneId} does not exist.`)
      }
      if (this.#state.activeSceneId !== sceneId) this.#editorEpoch += 1
      if (this.#state.activeSceneId !== sceneId || this.#state.lifecycle !== 'ready' || this.#state.error) {
        this.#publish({ ...this.#state, lifecycle: 'ready', error: null, activeSceneId: sceneId })
      }
      return ok(this.#state)
    }, sceneId !== this.#state.activeSceneId)
  }

  dispatchCommands(request: WorldEditorDispatchRequest, expectedAuthority?: WorldEditorDispatchAuthority): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>> {
    return this.#enqueue(async () => {
      const logicalPayload = stableSerialize({ transactionId: request.transactionId, origin: request.origin, commands: request.commands })
      const authority = this.#requireAuthority()
      if (!authority.ok) {
        return expectedAuthority
          ? this.#localFailure('revision_conflict', 'World editor authority changed while commands were prepared.')
          : authority
      }
      const cached = this.#resolveCachedDispatch(request.transactionId, logicalPayload, authority.value)
      if (cached) return cached
      if (expectedAuthority && (
        expectedAuthority.projectKey !== authority.value.projectKey
        || expectedAuthority.projectId !== authority.value.session.snapshot.project.projectId
        || expectedAuthority.baseRevision !== authority.value.session.snapshot.project.revision
        || expectedAuthority.activeSceneId !== this.#state.activeSceneId
      )) {
        return this.#localFailure('revision_conflict', 'World editor authority changed while commands were prepared.')
      }
      const batch: WorldCommandBatchV1 = {
        schema: WORLD_COMMAND_BATCH_SCHEMA,
        transactionId: request.transactionId,
        projectId: authority.value.session.snapshot.project.projectId,
        baseRevision: authority.value.session.snapshot.project.revision,
        origin: request.origin,
        commands: structuredClone(request.commands),
      }
      const result = await this.#applyExactBatch(batch, authority.value, logicalPayload)
      return result
    })
  }

  previewProposal(request: WorldEditorDispatchRequest, guard?: WorldEditorProposalGuard): Promise<WorldEditorControllerResult<WorldEditorProposalPreview>> {
    const capturedGuard = guard ? { context: parseWorldAiContext(guard.context), isCurrent: guard.isCurrent } : undefined
    request = structuredClone(request)
    return this.#enqueue(async () => {
      const preserved = this.#state
      if (capturedGuard && !this.#proposalIsCurrent(capturedGuard)) return this.#staleProposal()
      const authority = this.#requireAuthority()
      if (!authority.ok) return authority
      let aiCommands: WorldAiLegacyCommand[] | undefined
      if (capturedGuard) {
        try { aiCommands = validateWorldAiCommands(authority.value.session.snapshot, capturedGuard.context, request.commands) }
        catch { return this.#localFailure('invalid_command', 'The Worlds proposal changes an unsupported or stale target.') }
      }
      if (request.origin !== 'ai') return this.#localFailure('invalid_command', 'AI proposals must use origin ai.')
      const batch: WorldCommandBatchV1 = {
        schema: WORLD_COMMAND_BATCH_SCHEMA,
        transactionId: request.transactionId,
        projectId: authority.value.session.snapshot.project.projectId,
        baseRevision: authority.value.session.snapshot.project.revision,
        origin: 'ai',
        commands: structuredClone(request.commands),
      }
      const local = previewWorldCommandBatch(authority.value.session, batch)
      if (!local.success) return this.#localFailure('invalid_command', 'World command proposal is invalid.', local.issues)
      let details: WorldAiPropertyDiff[] = []
      if (aiCommands) {
        try { details = describeWorldAiCandidate(authority.value.session.snapshot, local.snapshot, aiCommands) }
        catch { return this.#localFailure('invalid_command', 'The proposal does not change any supported property.') }
      }
      this.#loading()
      const remote = await this.#gateway.previewCommands({ projectKey: authority.value.projectKey, batch: structuredClone(batch) })
      if (!remote.ok) return this.#gatewayFailure(remote.error, preserved)
      if (capturedGuard && !this.#proposalIsCurrent(capturedGuard)) return this.#staleProposal()
      const mismatch = verifyCommandResult(authority.value.projectKey, batch, local, remote.value)
      if (mismatch) return this.#localFailure('invalid_response', mismatch, undefined, preserved)
      this.#publish({ ...preserved, lifecycle: 'ready', error: null })
      return ok(deepFreezeData({
        details,
        batch: structuredClone(batch),
        fingerprint: fingerprintWorldCommandBatch(batch),
        changes: [...remote.value.changes],
        warnings: [...remote.value.warnings],
      }))
    })
  }

  previewAiProposal(value: WorldAiProposal, guard: WorldEditorProposalGuard): Promise<WorldEditorControllerResult<WorldEditorProposalPreview>> {
    const proposal = parseWorldAiProposal(value)
    const capturedGuard = { context: parseWorldAiContext(guard.context), isCurrent: guard.isCurrent }
    return this.#enqueue(async () => {
      const preserved = this.#state
      if (!sameWorldAiContext(proposal.context, capturedGuard.context) || !this.#proposalIsCurrent(capturedGuard)) return this.#staleProposal()
      const authority = this.#requireAuthority()
      if (!authority.ok) return authority
      if (!this.#gateway.previewAi) return this.#localFailure('invalid_command', 'Host AI creation preview is unavailable.')
      this.#loading()
      const remote = await this.#gateway.previewAi({ proposal })
      if (!remote.ok) return this.#gatewayFailure(remote.error, preserved)
      const discard = () => { void this.discardAiProposal(remote.value.authority, capturedGuard.context) }
      if (!this.#proposalIsCurrent(capturedGuard)) { discard(); return this.#staleProposal() }
      if (remote.value.batch.transactionId !== proposal.context.requestId || remote.value.batch.projectId !== proposal.context.projectId
        || remote.value.batch.baseRevision !== proposal.context.baseRevision || remote.value.batch.origin !== 'ai') {
        discard(); return this.#localFailure('invalid_response', 'The host proposal lost its request binding.', undefined, preserved)
      }
      const local = previewWorldCommandBatch(authority.value.session, remote.value.batch)
      if (!local.success) { discard(); return this.#localFailure('invalid_response', 'The host creation batch is invalid.', local.issues, preserved) }
      const mismatch = verifyCommandResult(authority.value.projectKey, remote.value.batch, local, remote.value.result)
      let details: WorldAiPropertyDiff[]
      try { details = describeWorldAiCandidate(authority.value.session.snapshot, local.snapshot, remote.value.batch.commands) }
      catch { discard(); return this.#localFailure('invalid_response', 'The host preview has no supported changes.', undefined, preserved) }
      if (mismatch || !sameData(details, remote.value.details)) { discard(); return this.#localFailure('invalid_response', 'The host creation candidate changed during preview.', undefined, preserved) }
      this.#publish({ ...preserved, lifecycle: 'ready', error: null })
      return ok(deepFreezeData({ aiAuthority: remote.value.authority, details, batch: structuredClone(remote.value.batch), fingerprint: fingerprintWorldCommandBatch(remote.value.batch), changes: [...remote.value.result.changes], warnings: [...remote.value.result.warnings] }))
    })
  }

  async discardAiProposal(authority: string, context: WorldAiContext): Promise<void> {
    try { await this.#gateway.discardAi?.({ authority, context }) } catch { /* Expired capabilities also retire through the bounded host TTL. */ }
  }

  applyProposalExact(batchValue: WorldCommandBatchV1, guard?: WorldEditorProposalGuard, aiAuthority?: string): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>> {
    const capturedGuard = guard ? { context: parseWorldAiContext(guard.context), isCurrent: guard.isCurrent } : undefined
    batchValue = structuredClone(batchValue)
    return this.#enqueue(async () => {
      if (capturedGuard && !this.#proposalIsCurrent(capturedGuard)) return this.#staleProposal()
      const authority = this.#requireAuthority()
      if (!authority.ok) return authority
      const parsed = parseWorldCommandBatch(batchValue)
      if (!parsed.success) return this.#localFailure('invalid_command', 'AI proposal batch is invalid.', parsed.issues)
      const batch = parsed.value
      if (batch.origin !== 'ai') return this.#localFailure('invalid_command', 'AI proposal batch must use origin ai.')
      if (batch.projectId !== authority.value.session.snapshot.project.projectId) {
        return this.#localFailure('revision_conflict', 'AI proposal targets another project.')
      }
      if (batch.baseRevision !== authority.value.session.snapshot.project.revision) {
        return this.#localFailure('revision_conflict', 'AI proposal is stale.')
      }
      const logicalPayload = stableSerialize({ transactionId: batch.transactionId, origin: batch.origin, commands: batch.commands })
      return this.#applyExactBatch(batch, authority.value, logicalPayload, aiAuthority && capturedGuard ? { token: aiAuthority, context: capturedGuard.context } : undefined)
    })
  }

  undo(guard?: WorldEditorProposalGuard): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>> {
    const capturedGuard = guard ? { context: parseWorldAiContext(guard.context), isCurrent: guard.isCurrent } : undefined
    return this.#enqueue(async () => {
      if (capturedGuard && !this.#proposalIsCurrent(capturedGuard)) return this.#staleProposal()
      return this.#persistHistoryTransition('undo')
    })
  }

  applyExternalCliProposal(request: WorldEditorExternalCliApplyRequest): Promise<WorldEditorControllerResult<WorldEditorExternalCliApplyOutcome>> {
    const { proposalId, reviewId, scope, editorEpoch, isCurrent } = request
    if (this.#activeApplyIntent) return Promise.resolve(this.#staleProposal())
    const intent = { id: `attempt_${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
      cancelRequested: false, acknowledgement: null as Promise<boolean> | null }
    this.#activeApplyIntent = intent
    const run = this.#enqueue(async (): Promise<WorldEditorControllerResult<WorldEditorExternalCliApplyOutcome>> => {
      if (intent.cancelRequested) return this.#staleProposal()
      const beforeState = this.#state
      const before = beforeState.session
      if (!before || !this.#gateway.applyExternalCli || beforeState.lifecycle !== 'ready'
        || beforeState.projectKey !== scope.projectKey || before.snapshot.project.projectId !== scope.projectId
        || before.snapshot.project.revision !== scope.baseRevision || beforeState.activeSceneId !== scope.activeSceneId
        || editorEpoch !== this.#editorEpoch || !safeCurrent(isCurrent)) return this.#staleProposal()
      this.#loading()
      let beforeDigest: string
      try { beforeDigest = await snapshotSha256(before.snapshot) }
      catch { return this.#localFailure('invalid_response', 'Editor snapshot could not be hashed before Apply.', undefined, beforeState) }
      if (!safeCurrent(isCurrent) || editorEpoch !== this.#editorEpoch) return this.#staleProposal()
      let receipt: Awaited<ReturnType<NonNullable<WorldProjectService['applyExternalCli']>>>
      try { receipt = await this.#gateway.applyExternalCli({ proposalId, reviewId, attemptId: intent.id }) }
      catch { return this.#refreshUnverifiedExternal(scope.projectKey, 'Main Apply response was unavailable.') }
      if (!receipt.ok) {
        if (receipt.code === 'USER_DECLINED') {
          this.#publish({ ...beforeState, lifecycle: 'ready', error: null })
          return ok({ status: 'cancelled' })
        }
        if (receipt.code === 'STALE') return this.#reconcileStaleExternal(scope.projectKey, beforeState, beforeDigest)
        return this.#refreshUnverifiedExternal(scope.projectKey, receipt.code === 'AMBIGUOUS'
          ? 'Main Apply may have committed. World was refreshed; no named Undo is available.'
          : 'External proposal is stale or unavailable. World was refreshed; no named Undo is available.')
      }
      if (!safeCurrent(isCurrent) || editorEpoch !== this.#editorEpoch
        || this.#state.projectKey !== scope.projectKey || this.#state.activeSceneId !== scope.activeSceneId
        || receipt.projectId !== scope.projectId || receipt.baseRevision !== scope.baseRevision
        || receipt.newRevision !== scope.baseRevision + 1 || !receipt.transactionId
        || receipt.beforeSnapshotSha256 !== beforeDigest || !/^[a-f0-9]{64}$/.test(receipt.snapshotSha256)) {
        return this.#refreshUnverifiedExternal(scope.projectKey, 'Main Apply receipt or editor scope changed; no named Undo is available.')
      }
      let opened: Awaited<ReturnType<WorldProjectService['open']>>
      try { opened = await this.#gateway.open({ projectKey: scope.projectKey }) }
      catch { return this.#refreshUnverifiedExternal(scope.projectKey, 'Authoritative World reopen failed; no named Undo is available.') }
      if (!opened.ok || opened.value.status !== 'ready' || opened.value.projectKey !== scope.projectKey
        || opened.value.snapshot.project.projectId !== scope.projectId
        || opened.value.snapshot.project.revision !== receipt.newRevision
        || !safeCurrent(isCurrent) || editorEpoch !== this.#editorEpoch) {
        return this.#refreshUnverifiedExternal(scope.projectKey, 'Authoritative World did not match the Main Apply receipt; no named Undo is available.')
      }
      try {
        const digest = await snapshotSha256(opened.value.snapshot)
        if (digest !== receipt.snapshotSha256 || !safeCurrent(isCurrent) || editorEpoch !== this.#editorEpoch) {
          return this.#refreshUnverifiedExternal(scope.projectKey, 'Authoritative World digest or editor intent changed; no named Undo is available.')
        }
      } catch { return this.#refreshUnverifiedExternal(scope.projectKey, 'World digest could not be verified; no named Undo is available.') }
      const adopted = adoptWorldEditorExternalTransaction(before, receipt.transactionId, opened.value.snapshot)
      if (!adopted.success) return this.#refreshUnverifiedExternal(scope.projectKey, 'World history could not verify the external transaction; no named Undo is available.')
      this.#externalCliUndo = { transactionId: receipt.transactionId, projectKey: scope.projectKey, revision: receipt.newRevision }
      this.#publishReady(scope.projectKey, adopted.session, scope.activeSceneId)
      return ok({ status: 'applied', transactionId: receipt.transactionId, revision: receipt.newRevision })
    }, false)
    void run.then(() => { if (this.#activeApplyIntent === intent) this.#activeApplyIntent = null },
      () => { if (this.#activeApplyIntent === intent) this.#activeApplyIntent = null })
    return run
  }

  cancelExternalCliApplyIntent(): Promise<boolean> {
    const intent = this.#activeApplyIntent
    if (!intent) return Promise.resolve(true)
    if (intent.acknowledgement) return intent.acknowledgement
    intent.cancelRequested = true
    let ack: Promise<boolean>
    try { ack = this.#gateway.cancelExternalCliIntent?.(intent.id) ?? Promise.resolve(false) }
    catch { ack = Promise.resolve(false) }
    let timeout: ReturnType<typeof setTimeout>
    intent.acknowledgement = Promise.race([
      ack.catch(() => false),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 5000) }),
    ]).then((accepted) => {
      clearTimeout(timeout)
      // A late ACK for an older attempt cannot authorize a transition over a newer one.
      return accepted && (!this.#activeApplyIntent || this.#activeApplyIntent === intent)
    })
    return intent.acknowledgement
  }

  applyScopedCliIntent(value: WorldsCliDirectEditRequest): Promise<WorldEditorControllerResult<WorldEditorScopedCliIntentOutcome>> {
    const request = parseScopedCliIntent(value)
    if (!request) return Promise.resolve(ok({ status: 'rejected', reason: 'invalid_request' }))
    const active = this.#activeScopedCliIntent
    if (active) {
      return sameData(active.request, request)
        ? active.resultPromise
        : Promise.resolve(ok({ status: 'rejected', reason: 'busy' }))
    }
    if (this.#activeApplyIntent) return Promise.resolve(ok({ status: 'rejected', reason: 'busy' }))
    const state = this.#state
    if (Date.now() >= request.expiresAt) return this.#rejectScopedCliIntent(request, 'expired')
    if (!this.#matchesDirectBaseScope(request, state) || !state.session) {
      return this.#rejectScopedCliIntent(request, 'scope_changed')
    }
    const tag: ActiveScopedCliIntent = {
      request,
      beforeState: state,
      capturedSession: state.session,
      expectedRevision: request.baseRevision + 1,
      phase: 'queued',
      commitInvoked: false,
      adoptionAckInvoked: false,
      leaveInvoked: false,
      cancelRequested: false,
      receipt: null,
      cancellationPromise: null,
      resultPromise: null as never,
    }
    this.#activeScopedCliIntent = tag
    const result = this.#enqueue(() => this.#runScopedCliIntent(tag), false)
    tag.resultPromise = result
    void result.then(() => {
      if (this.#activeScopedCliIntent === tag) this.#activeScopedCliIntent = null
    }, () => {
      if (this.#activeScopedCliIntent === tag) this.#activeScopedCliIntent = null
    })
    return result
  }

  cancelExternalCliIntents(): Promise<WorldEditorExternalCliBarrierResult> {
    const reviewed = this.cancelExternalCliApplyIntent()
    const direct = this.#activeScopedCliIntent
    const cancellation = direct ? this.#cancelScopedCliIntent(direct) : Promise.resolve(null)
    return Promise.all([reviewed, cancellation]).then(async ([reviewedAcknowledged, directResult]) => {
      if (direct) {
        try { await direct.resultPromise } catch { /* The barrier still uses the bounded cancellation result. */ }
      }
      if (!reviewedAcknowledged) return { ok: false, code: 'reviewed_unacknowledged' }
      if (!direct || !directResult || directCancellationIsStale(directResult)
        || (!direct.commitInvoked && directCancellationIsNotFound(directResult))) return { ok: true }
      return directCancellationIsUnavailable(directResult)
        ? { ok: false, code: 'direct_unavailable' }
        : { ok: false, code: 'direct_ambiguous' }
    })
  }

  classifyExternalCliEditorLifecycle(
    previous: WorldEditorControllerState,
    current: WorldEditorControllerState,
    previousPlayLifecycle: string,
    currentPlayLifecycle: string,
  ): 'retain' | 'revoke' {
    if (previousPlayLifecycle !== 'edit' || currentPlayLifecycle !== 'edit') return 'revoke'
    if (sameEditorAuthorityView(previous, current)) return 'retain'
    const tag = this.#activeScopedCliIntent
    if (!tag) return 'revoke'
    if (sameEditorAuthorityView(previous, tag.beforeState) && this.#matchesDirectLoadingScope(tag)
      && sameEditorAuthorityView(current, this.#state)) return 'retain'
    if (tag.receipt && this.#matchesDirectSuccessorScope(tag)
      && sameEditorAuthorityView(current, this.#state)) return 'retain'
    return 'revoke'
  }

  undoExternalCli(transactionId: string): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>> {
    return this.#enqueue(async () => {
      if (this.#state.externalCliUndoTransactionId !== transactionId) {
        return this.#localFailure('undo_empty', 'This external transaction no longer owns the latest World revision.')
      }
      const result = await this.#persistHistoryTransition('undo')
      this.#externalCliUndo = null
      if (!result.ok && this.#state.projectKey) {
        await this.#refreshUnverifiedExternal(this.#state.projectKey, 'Named Undo outcome could not be verified.')
      }
      return result
    })
  }

  redo(): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>> {
    return this.#enqueue(async () => this.#persistHistoryTransition('redo'))
  }

  refresh(): Promise<WorldEditorControllerResult<WorldEditorControllerState>> {
    return this.#enqueue(async () => {
      if (!this.#state.projectKey) return this.#localFailure('project_closed', 'Open a World project before refreshing it.')
      return this.#openProject(this.#state.projectKey, this.#state)
    })
  }

  deleteProject(transactionId: string): Promise<WorldEditorControllerResult<void>> {
    return this.#enqueue(async () => {
      const preserved = this.#state
      const authority = this.#requireAuthority()
      if (!authority.ok) return authority
      this.#loading()
      const result = await this.#gateway.delete({
        projectKey: authority.value.projectKey,
        expectedRevision: authority.value.session.snapshot.project.revision,
        transactionId,
      })
      if (!result.ok) return this.#gatewayFailure(result.error, preserved)
      this.#dispatches.clear()
      this.#editorEpoch += 1
      this.#externalCliUndo = null
      this.#publish({
        ...preserved,
        lifecycle: 'closed',
        error: null,
        projectKey: null,
        session: null,
        activeSceneId: null,
        savedRevision: null,
        canUndo: false,
        canRedo: false,
      })
      return ok(undefined)
    })
  }

  async #openProject(projectKey: string, preserved: WorldEditorControllerState): Promise<WorldEditorControllerResult<WorldEditorControllerState>> {
    this.#editorEpoch += 1
    this.#externalCliUndo = null
    this.#loading()
    const result = await this.#gateway.open({ projectKey })
    if (!result.ok) return this.#gatewayFailure(result.error, preserved)
    if (result.value.status !== 'ready') return this.#localFailure('unsupported_project', 'World project schema is unsupported.', undefined, preserved)
    const session = createWorldEditorSession(result.value.snapshot)
    if (!session.success) return this.#localFailure('invalid_response', 'Opened project snapshot is invalid.', session.issues, preserved)
    this.#dispatches.clear()
    this.#publishReady(projectKey, session.session, session.session.snapshot.project.startSceneId)
    return ok(this.#state)
  }

  async #applyExactBatch(
    batch: WorldCommandBatchV1,
    authority: { projectKey: string; session: WorldEditorSession },
    logicalPayload: string,
    aiAuthority?: WorldProjectCommandRequest['aiAuthority'],
  ): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>> {
    const cached = this.#resolveCachedDispatch(batch.transactionId, logicalPayload, authority)
    if (cached) return cached
    const local = applyWorldEditorCommandBatch(authority.session, batch)
    if (!local.success) {
      const transactionReuse = local.issues.find((issue) => issue.code === 'transaction-reuse')
      return this.#localFailure(
        transactionReuse ? 'transaction_reuse' : 'invalid_command',
        transactionReuse?.message ?? 'World command batch is invalid.',
        local.issues,
      )
    }
    const preserved = this.#state
    this.#loading()
    const remote = await this.#gateway.applyCommands({ projectKey: authority.projectKey, batch: structuredClone(batch), ...(aiAuthority ? { aiAuthority } : {}) })
    if (!remote.ok) return this.#gatewayFailure(remote.error, preserved)
    const expected = applyWorldCommandBatch(authority.session.snapshot, batch)
    if (!expected.success) return this.#localFailure('invalid_command', 'World command batch could not be replayed.', expected.issues, preserved)
    const mismatch = verifyCommandResult(authority.projectKey, batch, expected, remote.value)
    if (mismatch) return this.#localFailure('invalid_response', mismatch, undefined, preserved)
    const adopted = adoptWorldEditorAuthoritativeSnapshot(local.session, remote.value.snapshot)
    if (!adopted.success) return this.#localFailure('invalid_response', 'Repository command snapshot is invalid.', adopted.issues, preserved)
    const session = adopted.session
    const result = deepFreezeData<WorldEditorDispatchSuccess>({
      transactionId: batch.transactionId,
      revision: remote.value.newRevision,
      idempotent: remote.value.idempotent,
      changes: [...remote.value.changes],
      warnings: [...remote.value.warnings],
      receipt: structuredClone(remote.value.receipt),
    })
    this.#rememberDispatch(batch.transactionId, logicalPayload, authority, result)
    const activeSceneId = preserved.activeSceneId && session.snapshot.scenes.some((scene) => scene.sceneId === preserved.activeSceneId)
      ? preserved.activeSceneId
      : session.snapshot.project.startSceneId
    this.#publishReady(authority.projectKey, session, activeSceneId)
    return ok(result)
  }

  async #persistHistoryTransition(kind: 'undo' | 'redo'): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>> {
    const authority = this.#requireAuthority()
    if (!authority.ok) return authority
    const transition = kind === 'undo' ? undoWorldEditorSession(authority.value.session) : redoWorldEditorSession(authority.value.session)
    if (!transition.success) return this.#localFailure(kind === 'undo' ? 'undo_empty' : 'redo_empty', transition.issues[0]?.message ?? `${kind} is unavailable.`, transition.issues)
    let commands: WorldCommand[]
    try {
      commands = buildWorldSnapshotTransitionCommands(authority.value.session.snapshot, transition.session.snapshot)
    } catch (error) {
      return this.#localFailure('invalid_command', error instanceof Error ? error.message : `Unable to build ${kind} transition.`)
    }
    const sourceEntry = kind === 'undo' ? authority.value.session.undoStack.at(-1) : authority.value.session.redoStack.at(-1)
    const transactionId = `tx:${kind}:${digest32(`${sourceEntry?.transactionId ?? 'history'}:${authority.value.session.snapshot.project.revision}`)}`
    const batch: WorldCommandBatchV1 = {
      schema: WORLD_COMMAND_BATCH_SCHEMA,
      transactionId,
      projectId: authority.value.session.snapshot.project.projectId,
      baseRevision: authority.value.session.snapshot.project.revision,
      origin: kind,
      commands,
    }
    const expected = applyWorldCommandBatch(authority.value.session.snapshot, batch)
    if (!expected.success || !sameData(expected.snapshot, transition.session.snapshot)) {
      return this.#localFailure('invalid_command', `${kind} transition does not reproduce the target snapshot.`, expected.success ? undefined : expected.issues)
    }
    const preserved = this.#state
    this.#loading()
    const remote = await this.#gateway.applyCommands({ projectKey: authority.value.projectKey, batch: structuredClone(batch) })
    if (!remote.ok) return this.#gatewayFailure(remote.error, preserved)
    const mismatch = verifyCommandResult(authority.value.projectKey, batch, expected, remote.value)
    if (mismatch) return this.#localFailure('invalid_response', mismatch, undefined, preserved)
    const adopted = adoptWorldEditorAuthoritativeSnapshot(transition.session, remote.value.snapshot)
    if (!adopted.success) return this.#localFailure('invalid_response', 'Repository command snapshot is invalid.', adopted.issues, preserved)
    const session = adopted.session
    const result = deepFreezeData<WorldEditorDispatchSuccess>({
      transactionId,
      revision: remote.value.newRevision,
      idempotent: remote.value.idempotent,
      changes: [...remote.value.changes],
      warnings: [...remote.value.warnings],
      receipt: structuredClone(remote.value.receipt),
    })
    this.#publishReady(authority.value.projectKey, session, preserved.activeSceneId ?? session.snapshot.project.startSceneId)
    return ok(result)
  }

  #proposalIsCurrent(guard: WorldEditorProposalGuard): boolean {
    const state = this.#state
    const expected = guard.context
    try {
      return guard.isCurrent() && expected.editorEpoch === this.#editorEpoch
        && expected.projectKey === state.projectKey && expected.activeSceneId === state.activeSceneId
        && expected.projectId === state.session?.snapshot.project.projectId
        && expected.baseRevision === state.session.snapshot.project.revision
    } catch { return false }
  }

  #staleProposal(): WorldEditorControllerResult<never> {
    return this.#localFailure('revision_conflict', 'The World or originating request changed. Ask again before applying.')
  }

  #requireAuthority(): WorldEditorControllerResult<{ projectKey: string; session: WorldEditorSession }> {
    if (!this.#state.projectKey || !this.#state.session) return error('project_closed', 'Open a World project before editing it.', false)
    return ok({ projectKey: this.#state.projectKey, session: this.#state.session })
  }

  #resolveCachedDispatch(
    transactionId: string,
    logicalPayload: string,
    authority: { projectKey: string; session: WorldEditorSession },
  ): WorldEditorControllerResult<WorldEditorDispatchSuccess> | null {
    const cached = this.#dispatches.get(transactionId)
    if (!cached) return null
    if (cached.logicalPayload !== logicalPayload) {
      return this.#localFailure('transaction_reuse', `Transaction ${transactionId} was already used with different content.`)
    }
    const currentProject = authority.session.snapshot.project
    if (
      cached.projectKey !== authority.projectKey
      || cached.projectId !== currentProject.projectId
      || cached.result.revision !== currentProject.revision
    ) return null
    return ok(deepFreezeData({ ...structuredClone(cached.result), idempotent: true }))
  }

  #rememberDispatch(
    transactionId: string,
    logicalPayload: string,
    authority: { projectKey: string; session: WorldEditorSession },
    result: WorldEditorDispatchSuccess,
  ): void {
    this.#dispatches.set(transactionId, {
      logicalPayload,
      projectKey: authority.projectKey,
      projectId: authority.session.snapshot.project.projectId,
      result,
    })
    while (this.#dispatches.size > MAX_CONTROLLER_RECEIPTS) {
      const oldest = this.#dispatches.keys().next().value as string | undefined
      if (!oldest) break
      this.#dispatches.delete(oldest)
    }
  }

  #loading(): void {
    this.#publish({ ...this.#state, lifecycle: 'loading', error: null })
  }

  #publishReady(projectKey: string, session: WorldEditorSession, activeSceneId: string): void {
    this.#publish({
      ...this.#state,
      lifecycle: 'ready',
      error: null,
      projectKey,
      session,
      activeSceneId,
      savedRevision: session.snapshot.project.revision,
      canUndo: session.undoStack.length > 0,
      canRedo: session.redoStack.length > 0,
      externalCliUndoTransactionId: this.#externalCliUndo?.projectKey === projectKey
        && this.#externalCliUndo.revision === session.snapshot.project.revision
        && session.undoStack.at(-1)?.transactionId === this.#externalCliUndo.transactionId
        ? this.#externalCliUndo.transactionId : null,
    })
  }

  async #runScopedCliIntent(tag: ActiveScopedCliIntent): Promise<WorldEditorControllerResult<WorldEditorScopedCliIntentOutcome>> {
    const request = tag.request
    let beforeDigest: string
    try { beforeDigest = await snapshotSha256(tag.capturedSession.snapshot) }
    catch { return this.#directUnverifiedWithoutReopen(tag, 'precommit_hash_unavailable') }

    if (tag.cancelRequested) {
      const cancelled = await this.#cancelScopedCliIntent(tag)
      return directCancellationIsStale(cancelled) || (!tag.commitInvoked && directCancellationIsNotFound(cancelled))
        ? this.#restoreDirectStale(tag, 'cancelled')
        : this.#reconcileScopedCliUnverified(tag, beforeDigest, 'cancellation_unverified', cancelled)
    }
    if (Date.now() >= request.expiresAt || !this.#matchesDirectBaseScope(request, this.#state)
      || this.#state.session !== tag.capturedSession) {
      const cancelled = await this.#cancelScopedCliIntent(tag)
      return directCancellationIsStale(cancelled) || (!tag.commitInvoked && directCancellationIsNotFound(cancelled))
        ? this.#restoreDirectStale(tag, Date.now() >= request.expiresAt ? 'expired' : 'scope_changed')
        : this.#reconcileScopedCliUnverified(tag, beforeDigest, 'stale_cancellation_unverified', cancelled)
    }

    this.#loading()
    if (tag.cancelRequested || Date.now() >= request.expiresAt || !this.#matchesDirectLoadingScope(tag)) {
      const cancelled = await this.#cancelScopedCliIntent(tag)
      return directCancellationIsStale(cancelled) || (!tag.commitInvoked && directCancellationIsNotFound(cancelled))
        ? this.#restoreDirectStale(tag, Date.now() >= request.expiresAt ? 'expired' : 'scope_changed')
        : this.#reconcileScopedCliUnverified(tag, beforeDigest, 'stale_cancellation_unverified', cancelled)
    }

    tag.phase = 'commit_inflight'
    tag.commitInvoked = true
    let committed: ReturnType<typeof normalizeControllerDirectCommit>
    try {
      committed = normalizeControllerDirectCommit(await this.#gateway.commitExternalCliDirectIntent?.({
        nonce: request.nonce,
        editIntent: request.editIntent,
      }))
    } catch { committed = { ok: false, code: 'AMBIGUOUS' } }

    if (!committed.ok) {
      const cancelled = await this.#cancelScopedCliIntent(tag)
      if (committed.code === 'STALE' && (directCancellationAcknowledged(cancelled) || directCancellationIsUnavailable(cancelled))) {
        return this.#reconcileScopedCliStale(tag, beforeDigest, 'commit_stale')
      }
      tag.phase = 'reconciling'
      return this.#reconcileScopedCliUnverified(tag, beforeDigest, `commit_${committed.code.toLowerCase()}`, cancelled)
    }

    const receipt = committed.receipt
    tag.receipt = receipt
    if (receipt.projectId !== request.projectId || receipt.newRevision !== tag.expectedRevision) {
      const cancelled = await this.#cancelScopedCliIntent(tag)
      tag.phase = 'reconciling'
      return this.#reconcileScopedCliUnverified(tag, beforeDigest, 'commit_receipt_mismatch', cancelled)
    }

    tag.phase = 'reopen_verify'
    let opened: Awaited<ReturnType<WorldProjectService['open']>>
    try { opened = await this.#gateway.open({ projectKey: request.projectKey }) }
    catch {
      const cancelled = await this.#cancelScopedCliIntent(tag)
      return this.#reconcileScopedCliUnverified(tag, beforeDigest, 'reopen_unavailable', cancelled)
    }
    if (!opened.ok || opened.value.status !== 'ready' || opened.value.projectKey !== request.projectKey
      || opened.value.snapshot.project.projectId !== request.projectId
      || opened.value.snapshot.project.revision !== tag.expectedRevision
      || !opened.value.snapshot.scenes.some((scene) => scene.sceneId === request.sceneId)) {
      const cancelled = await this.#cancelScopedCliIntent(tag)
      return this.#reconcileScopedCliUnverified(tag, beforeDigest, 'reopen_mismatch', cancelled)
    }
    let openedDigest: string
    try { openedDigest = await snapshotSha256(opened.value.snapshot) }
    catch {
      const cancelled = await this.#cancelScopedCliIntent(tag)
      return this.#reconcileScopedCliUnverified(tag, beforeDigest, 'reopen_hash_unavailable', cancelled)
    }
    if (openedDigest !== receipt.snapshotSha256 || tag.cancelRequested) {
      const cancelled = await this.#cancelScopedCliIntent(tag)
      return this.#reconcileScopedCliUnverified(tag, beforeDigest,
        openedDigest !== receipt.snapshotSha256 ? 'reopen_hash_mismatch' : 'cancelled_after_commit', cancelled)
    }

    const adopted = adoptWorldEditorExternalTransaction(tag.capturedSession, receipt.transactionId, opened.value.snapshot)
    if (!adopted.success || !directHistoryWasAdoptedExactly(tag.capturedSession, adopted.session, receipt.transactionId)) {
      const cancelled = await this.#cancelScopedCliIntent(tag)
      return this.#reconcileScopedCliUnverified(tag, beforeDigest, 'local_adoption_failed', cancelled)
    }
    tag.phase = 'adopted_local'
    this.#externalCliUndo = { transactionId: receipt.transactionId, projectKey: request.projectKey, revision: receipt.newRevision }
    this.#publishReady(request.projectKey, adopted.session, request.sceneId)
    if (!this.#matchesDirectSuccessorScope(tag)) {
      await this.#leaveScopedCliEditor(tag)
      tag.phase = 'unverified'
      return ok({ status: 'unverified', reason: 'local_adoption_mismatch', localAdoption: 'verified' })
    }

    if (Date.now() >= request.expiresAt || tag.cancelRequested) {
      await this.#leaveScopedCliEditor(tag)
      tag.phase = 'unverified'
      return ok({ status: 'unverified', reason: Date.now() >= request.expiresAt ? 'adoption_ack_expired' : 'adoption_ack_cancelled', localAdoption: 'verified' })
    }
    tag.phase = 'ack_inflight'
    tag.adoptionAckInvoked = true
    let acknowledgement: ReturnType<typeof normalizeControllerDirectAdoption>
    try {
      acknowledgement = normalizeControllerDirectAdoption(await this.#gateway.adoptExternalCliDirectIntent?.({
        nonce: request.nonce,
        editIntent: request.editIntent,
        transactionId: receipt.transactionId,
        newRevision: receipt.newRevision,
        snapshotSha256: receipt.snapshotSha256,
      }))
    } catch { acknowledgement = { ok: false, code: 'UNAVAILABLE' } }
    if (!acknowledgement.ok) {
      await this.#leaveScopedCliEditor(tag)
      tag.phase = 'unverified'
      return ok({ status: 'unverified', reason: `adoption_ack_${acknowledgement.code.toLowerCase()}`, localAdoption: 'verified' })
    }
    tag.phase = 'applied'
    return ok({ status: 'applied', transactionId: receipt.transactionId, revision: receipt.newRevision })
  }

  #matchesDirectBaseScope(request: WorldsCliDirectEditRequest, state: WorldEditorControllerState): boolean {
    return state.lifecycle === 'ready' && state.projectKey === request.projectKey
      && state.session?.snapshot.project.projectId === request.projectId
      && state.session.snapshot.project.revision === request.baseRevision
      && state.activeSceneId === request.sceneId && state.editorEpoch === request.editorEpoch
  }

  #matchesDirectLoadingScope(tag: ActiveScopedCliIntent): boolean {
    const state = this.#state
    const request = tag.request
    return state.lifecycle === 'loading' && state.projectKey === request.projectKey
      && state.session === tag.capturedSession && state.session.snapshot.project.projectId === request.projectId
      && state.session.snapshot.project.revision === request.baseRevision
      && state.activeSceneId === request.sceneId && state.editorEpoch === request.editorEpoch
  }

  #matchesDirectSuccessorScope(tag: ActiveScopedCliIntent): boolean {
    const state = this.#state
    const receipt = tag.receipt
    return !!receipt && state.lifecycle === 'ready' && state.projectKey === tag.request.projectKey
      && state.session?.snapshot.project.projectId === tag.request.projectId
      && state.session.snapshot.project.revision === tag.expectedRevision
      && state.activeSceneId === tag.request.sceneId && state.editorEpoch === tag.request.editorEpoch
      && state.session.undoStack.at(-1)?.transactionId === receipt.transactionId
      && state.externalCliUndoTransactionId === receipt.transactionId && state.session.redoStack.length === 0
  }

  #rejectScopedCliIntent(
    request: WorldsCliDirectEditRequest,
    reason: string,
  ): Promise<WorldEditorControllerResult<WorldEditorScopedCliIntentOutcome>> {
    const operation = this.#gateway.cancelExternalCliDirectIntent
    if (!operation) return Promise.resolve(ok({ status: 'unverified', reason: 'cancellation_unavailable', localAdoption: 'none' }))
    let cancelled: ReturnType<NonNullable<WorldProjectService['cancelExternalCliDirectIntent']>>
    try { cancelled = operation({ nonce: request.nonce, editIntent: request.editIntent }) }
    catch { cancelled = Promise.resolve({ ok: false, code: 'UNAVAILABLE' }) }
    return cancelled.then((value) => {
      const normalized = normalizeControllerDirectCancellation(value)
      return directCancellationIsStale(normalized) || directCancellationIsNotFound(normalized)
        ? ok({ status: 'stale', reason })
        : ok({ status: 'unverified', reason: 'cancellation_unverified', localAdoption: 'none' })
    }, () => ok({ status: 'unverified', reason: 'cancellation_unavailable', localAdoption: 'none' }))
  }

  #cancelScopedCliIntent(tag: ActiveScopedCliIntent): ReturnType<NonNullable<WorldProjectService['cancelExternalCliDirectIntent']>> {
    tag.cancelRequested = true
    if (tag.cancellationPromise) return tag.cancellationPromise
    const operation = this.#gateway.cancelExternalCliDirectIntent
    if (!operation) {
      tag.cancellationPromise = Promise.resolve({ ok: false, code: 'UNAVAILABLE' })
      return tag.cancellationPromise
    }
    try {
      tag.cancellationPromise = Promise.resolve(operation({ nonce: tag.request.nonce, editIntent: tag.request.editIntent }))
        .then(normalizeControllerDirectCancellation, () => ({ ok: false, code: 'UNAVAILABLE' }))
    } catch { tag.cancellationPromise = Promise.resolve({ ok: false, code: 'UNAVAILABLE' }) }
    return tag.cancellationPromise
  }

  #restoreDirectStale(tag: ActiveScopedCliIntent, reason: string): WorldEditorControllerResult<WorldEditorScopedCliIntentOutcome> {
    tag.phase = 'unverified'
    this.#publish({ ...tag.beforeState, lifecycle: 'ready', error: null })
    return ok({ status: 'stale', reason })
  }

  async #reconcileScopedCliStale(
    tag: ActiveScopedCliIntent,
    beforeDigest: string,
    reason: string,
  ): Promise<WorldEditorControllerResult<WorldEditorScopedCliIntentOutcome>> {
    let opened: Awaited<ReturnType<WorldProjectService['open']>>
    try { opened = await this.#gateway.open({ projectKey: tag.request.projectKey }) }
    catch { return this.#directUnverifiedWithoutReopen(tag, 'stale_reopen_unavailable') }
    if (opened.ok && opened.value.status === 'ready' && opened.value.projectKey === tag.request.projectKey
      && opened.value.snapshot.project.projectId === tag.request.projectId
      && opened.value.snapshot.project.revision === tag.request.baseRevision
      && opened.value.snapshot.scenes.some((scene) => scene.sceneId === tag.request.sceneId)) {
      try {
        if (await snapshotSha256(opened.value.snapshot) === beforeDigest) return this.#restoreDirectStale(tag, reason)
      } catch { /* Fall through to the conservative unverified adoption. */ }
    }
    return this.#adoptFreshDirectSnapshot(tag, opened, 'stale_disk_changed')
  }

  async #reconcileScopedCliUnverified(
    tag: ActiveScopedCliIntent,
    beforeDigest: string,
    reason: string,
    cancellation: ReturnType<typeof normalizeControllerDirectCancellation>,
  ): Promise<WorldEditorControllerResult<WorldEditorScopedCliIntentOutcome>> {
    tag.phase = 'reconciling'
    if (!directCancellationAcknowledged(cancellation)) return this.#directUnverifiedWithoutReopen(tag,
      directCancellationIsUnavailable(cancellation) ? 'cancellation_unavailable' : 'cancellation_not_found')
    let opened: Awaited<ReturnType<WorldProjectService['open']>>
    try { opened = await this.#gateway.open({ projectKey: tag.request.projectKey }) }
    catch { return this.#directUnverifiedWithoutReopen(tag, `${reason}_reopen_unavailable`) }
    if (opened.ok && opened.value.status === 'ready' && opened.value.projectKey === tag.request.projectKey
      && opened.value.snapshot.project.projectId === tag.request.projectId
      && opened.value.snapshot.project.revision === tag.request.baseRevision
      && opened.value.snapshot.scenes.some((scene) => scene.sceneId === tag.request.sceneId)) {
      try {
        if (await snapshotSha256(opened.value.snapshot) === beforeDigest) {
          this.#externalCliUndo = null
          this.#publish({ ...tag.beforeState, lifecycle: 'ready', error: null, externalCliUndoTransactionId: null })
          tag.phase = 'unverified'
          return ok({ status: 'unverified', reason, localAdoption: 'none' })
        }
      } catch { /* Fall through to a fresh unowned session. */ }
    }
    return this.#adoptFreshDirectSnapshot(tag, opened, reason)
  }

  #adoptFreshDirectSnapshot(
    tag: ActiveScopedCliIntent,
    opened: Awaited<ReturnType<WorldProjectService['open']>>,
    reason: string,
  ): WorldEditorControllerResult<WorldEditorScopedCliIntentOutcome> {
    if (!opened.ok || opened.value.status !== 'ready' || opened.value.projectKey !== tag.request.projectKey
      || opened.value.snapshot.project.projectId !== tag.request.projectId
      || (opened.value.snapshot.project.revision !== tag.request.baseRevision
        && opened.value.snapshot.project.revision !== tag.expectedRevision)
      || !opened.value.snapshot.scenes.some((scene) => scene.sceneId === tag.request.sceneId)) {
      return this.#directUnverifiedWithoutReopen(tag, `${reason}_unstable_disk`)
    }
    const fresh = createWorldEditorSession(opened.value.snapshot)
    if (!fresh.success) return this.#directUnverifiedWithoutReopen(tag, `${reason}_invalid_snapshot`)
    this.#externalCliUndo = null
    this.#dispatches.clear()
    this.#editorEpoch += 1
    this.#publishReady(tag.request.projectKey, fresh.session, tag.request.sceneId)
    tag.phase = 'unverified'
    return ok({ status: 'unverified', reason, localAdoption: 'none' })
  }

  #directUnverifiedWithoutReopen(
    tag: ActiveScopedCliIntent,
    reason: string,
  ): WorldEditorControllerResult<WorldEditorScopedCliIntentOutcome> {
    this.#externalCliUndo = null
    this.#dispatches.clear()
    this.#editorEpoch += 1
    tag.phase = 'unverified'
    this.#publish({ ...this.#state, lifecycle: 'error', error: {
      code: 'invalid_response', message: 'External edit could not be verified. Reopen the World before editing.', retryable: false,
    }, projectKey: null, session: null, activeSceneId: null, savedRevision: null, canUndo: false, canRedo: false,
    externalCliUndoTransactionId: null })
    return ok({ status: 'unverified', reason, localAdoption: 'none' })
  }

  async #leaveScopedCliEditor(tag: ActiveScopedCliIntent): Promise<void> {
    if (tag.leaveInvoked) return
    tag.leaveInvoked = true
    try { await this.#gateway.leaveExternalCliEditor?.() } catch { /* Lease revocation is best effort after local proof. */ }
  }

  async #reconcileStaleExternal(
    projectKey: string,
    beforeState: WorldEditorControllerState,
    beforeDigest: string,
  ): Promise<WorldEditorControllerResult<WorldEditorExternalCliApplyOutcome>> {
    const before = beforeState.session
    if (before) {
      try {
        const opened = await this.#gateway.open({ projectKey })
        if (opened.ok && opened.value.status === 'ready' && opened.value.projectKey === projectKey
          && opened.value.snapshot.project.projectId === before.snapshot.project.projectId
          && opened.value.snapshot.project.revision === before.snapshot.project.revision
          && await snapshotSha256(opened.value.snapshot) === beforeDigest) {
          this.#publish({ ...beforeState, lifecycle: 'ready', error: null })
          return ok({ status: 'stale', reason: 'External proposal is stale. The World is unchanged; editor history was retained.' })
        }
      } catch { /* Without an authoritative identity and digest, history cannot be kept. */ }
    }
    return this.#refreshUnverifiedExternal(projectKey, 'External proposal is stale but the World could not be proven unchanged; no named Undo is available.')
  }

  async #refreshUnverifiedExternal(projectKey: string, reason: string): Promise<WorldEditorControllerResult<WorldEditorExternalCliApplyOutcome>> {
    this.#externalCliUndo = null
    this.#dispatches.clear()
    this.#editorEpoch += 1
    try {
      const opened = await this.#gateway.open({ projectKey })
      if (opened.ok && opened.value.status === 'ready' && opened.value.projectKey === projectKey) {
        const session = createWorldEditorSession(opened.value.snapshot)
        if (session.success) {
          const sceneId = this.#state.activeSceneId && session.session.snapshot.scenes.some((scene) => scene.sceneId === this.#state.activeSceneId)
            ? this.#state.activeSceneId : session.session.snapshot.project.startSceneId
          this.#publishReady(projectKey, session.session, sceneId)
          return ok({ status: 'unverified', reason })
        }
      }
    } catch { /* No stale editor snapshot may remain actionable after unknown commit. */ }
    this.#publish({ ...this.#state, lifecycle: 'error', error: { code: 'invalid_response', message: `${reason} Reopen the World before editing.`, retryable: false },
      projectKey: null, session: null, activeSceneId: null, savedRevision: null, canUndo: false, canRedo: false, externalCliUndoTransactionId: null })
    return ok({ status: 'unverified', reason: `${reason} Reopen the World before editing.` })
  }

  #gatewayFailure<T>(
    failure: { code: WorldProjectPublicErrorCode; message: string; retryable: boolean },
    preserved: WorldEditorControllerState = this.#state,
  ): WorldEditorControllerResult<T> {
    const publicError = deepFreezeData<WorldEditorControllerError>({ ...failure })
    this.#publish({ ...preserved, lifecycle: 'error', error: publicError })
    return { ok: false, error: publicError }
  }

  #localFailure<T>(
    code: WorldEditorControllerErrorCode,
    message: string,
    issues?: readonly WorldCommandIssue[],
    preserved: WorldEditorControllerState = this.#state,
  ): WorldEditorControllerResult<T> {
    const localError = deepFreezeData<WorldEditorControllerError>({
      code,
      message,
      retryable: false,
      ...(issues?.length ? { issues: [...issues].map((issue) => ({ ...issue })) } : {}),
    })
    this.#publish({ ...preserved, lifecycle: preserved.session ? 'error' : 'closed', error: localError })
    return { ok: false, error: localError }
  }

  #publish(next: WorldEditorControllerState): void {
    this.#state = freezeState({ ...next, editorEpoch: this.#editorEpoch })
    for (const listener of [...this.#listeners]) {
      try { listener(this.#state) } catch { /* Listener isolation is an authority boundary. */ }
    }
  }

  #enqueue<T>(operation: () => Promise<T>, cancelExternalIntents = true): Promise<T> {
    // Begin both Main tombstones before joining the serial queue. Otherwise a reviewed
    // dialog or direct edit could journal before a queued scene/project/edit is observed.
    const acknowledgement = cancelExternalIntents ? this.cancelExternalCliIntents() : Promise.resolve({ ok: true } as const)
    const guarded = async (): Promise<T> => {
      const barrier = await acknowledgement
      if (!barrier.ok) return this.#localFailure('invalid_response', 'External edit cancellation was not acknowledged; transition blocked.') as T
      return operation()
    }
    const result = this.#queue.then(guarded, guarded)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }
}

export const worldEditorController: WorldEditorController = createWorldEditorController()

function parseScopedCliIntent(value: unknown): Readonly<WorldsCliDirectEditRequest> | null {
  try {
    const record = controllerExactRecord(value, [
      'nonce', 'editIntent', 'projectKey', 'projectId', 'sceneId', 'baseRevision', 'editorEpoch', 'expiresAt',
    ])
    if (Object.keys(record).length !== 8
      || typeof record.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(record.nonce)
      || typeof record.editIntent !== 'string' || !/^edit_[a-f0-9]{48}$/.test(record.editIntent)
      || typeof record.projectKey !== 'string' || !/^world-[a-f0-9]{32}$/.test(record.projectKey)
      || typeof record.projectId !== 'string' || !/^project:[A-Za-z0-9:_-]{1,128}$/.test(record.projectId)
      || typeof record.sceneId !== 'string' || !/^scene:[A-Za-z0-9:_-]{1,128}$/.test(record.sceneId)
      || !Number.isSafeInteger(record.baseRevision) || (record.baseRevision as number) < 0
      || !Number.isSafeInteger(record.editorEpoch) || (record.editorEpoch as number) < 0
      || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) <= 0) return null
    return Object.freeze({
      nonce: record.nonce,
      editIntent: record.editIntent,
      projectKey: record.projectKey,
      projectId: record.projectId,
      sceneId: record.sceneId,
      baseRevision: record.baseRevision as number,
      editorEpoch: record.editorEpoch as number,
      expiresAt: record.expiresAt as number,
    })
  } catch { return null }
}

function normalizeControllerDirectCommit(value: unknown):
  | { ok: true; receipt: WorldsCliDirectEditCommitReceipt }
  | { ok: false; code: 'STALE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'UNAVAILABLE' } {
  try {
    const outer = controllerExactRecord(value, ['ok', 'code', 'receipt'])
    if (outer.ok === false && Object.keys(outer).length === 2) {
      return { ok: false, code: directFailureCodeValue(outer.code, 'AMBIGUOUS') }
    }
    if (outer.ok !== true || Object.keys(outer).length !== 2) return { ok: false, code: 'AMBIGUOUS' }
    const receipt = controllerExactRecord(outer.receipt, ['transactionId', 'projectId', 'newRevision', 'snapshotSha256'])
    if (Object.keys(receipt).length !== 4
      || typeof receipt.transactionId !== 'string' || !/^[a-f0-9]{32}$/.test(receipt.transactionId)
      || typeof receipt.projectId !== 'string' || !/^project:[A-Za-z0-9:_-]{1,128}$/.test(receipt.projectId)
      || !Number.isSafeInteger(receipt.newRevision) || (receipt.newRevision as number) < 1
      || typeof receipt.snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.snapshotSha256)) {
      return { ok: false, code: 'AMBIGUOUS' }
    }
    return { ok: true, receipt: { transactionId: receipt.transactionId, projectId: receipt.projectId,
      newRevision: receipt.newRevision as number, snapshotSha256: receipt.snapshotSha256 } }
  } catch { return value === undefined ? { ok: false, code: 'UNAVAILABLE' } : { ok: false, code: 'AMBIGUOUS' } }
}

function normalizeControllerDirectCancellation(value: unknown):
  | { ok: true; status: 'STALE' | 'AMBIGUOUS' }
  | { ok: false; code: 'STALE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'UNAVAILABLE' } {
  try {
    const outer = controllerExactRecord(value, ['ok', 'code', 'status'])
    if (outer.ok === true && Object.keys(outer).length === 2 && (outer.status === 'STALE' || outer.status === 'AMBIGUOUS')) {
      return { ok: true, status: outer.status }
    }
    if (outer.ok === false && Object.keys(outer).length === 2) {
      return { ok: false, code: directFailureCodeValue(outer.code, 'UNAVAILABLE') }
    }
  } catch { /* Normalize below. */ }
  return { ok: false, code: 'UNAVAILABLE' }
}

function normalizeControllerDirectAdoption(value: unknown):
  | { ok: true; status: 'APPLIED' }
  | { ok: false; code: 'STALE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'UNAVAILABLE' } {
  try {
    const outer = controllerExactRecord(value, ['ok', 'code', 'status'])
    if (outer.ok === true && Object.keys(outer).length === 2 && outer.status === 'APPLIED') return { ok: true, status: 'APPLIED' }
    if (outer.ok === false && Object.keys(outer).length === 2) {
      return { ok: false, code: directFailureCodeValue(outer.code, 'UNAVAILABLE') }
    }
    if (outer.ok === true) return { ok: false, code: 'AMBIGUOUS' }
  } catch { /* Normalize below. */ }
  return { ok: false, code: 'UNAVAILABLE' }
}

function directFailureCodeValue(
  value: unknown,
  fallback: 'STALE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'UNAVAILABLE',
): 'STALE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'UNAVAILABLE' {
  return value === 'STALE' || value === 'AMBIGUOUS' || value === 'NOT_FOUND' || value === 'UNAVAILABLE' ? value : fallback
}

function directCancellationIsStale(value: ReturnType<typeof normalizeControllerDirectCancellation>): boolean {
  return value.ok ? value.status === 'STALE' : value.code === 'STALE'
}

function directCancellationIsNotFound(value: ReturnType<typeof normalizeControllerDirectCancellation>): boolean {
  return !value.ok && value.code === 'NOT_FOUND'
}

function directCancellationIsUnavailable(value: ReturnType<typeof normalizeControllerDirectCancellation>): boolean {
  return !value.ok && value.code === 'UNAVAILABLE'
}

function directCancellationAcknowledged(value: ReturnType<typeof normalizeControllerDirectCancellation>): boolean {
  return value.ok || (!value.ok && (value.code === 'STALE' || value.code === 'AMBIGUOUS'))
}

function directHistoryWasAdoptedExactly(before: WorldEditorSession, after: WorldEditorSession, transactionId: string): boolean {
  return after.undoStack.length === before.undoStack.length + 1
    && before.undoStack.every((entry, index) => after.undoStack[index] === entry)
    && after.undoStack.at(-1)?.transactionId === transactionId
    && after.redoStack.length === 0
}

function sameEditorAuthorityView(left: WorldEditorControllerState, right: WorldEditorControllerState): boolean {
  return left.lifecycle === right.lifecycle
    && left.projectKey === right.projectKey
    && left.session === right.session
    && left.session?.snapshot.project.projectId === right.session?.snapshot.project.projectId
    && left.session?.snapshot.project.revision === right.session?.snapshot.project.revision
    && left.activeSceneId === right.activeSceneId
    && left.editorEpoch === right.editorEpoch
}

function controllerExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const allowed = new Set(keys)
  const record: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error()
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor)) throw new Error()
    Object.defineProperty(record, key, { value: descriptor.value, enumerable: true })
  }
  return record
}

function verifyCommandResult(
  projectKey: string,
  batch: WorldCommandBatchV1,
  expected: { snapshot: WorldProjectSnapshotV1; changes: string[]; warnings: string[]; inverse: { kind: 'world-snapshot'; snapshot: WorldProjectSnapshotV1 } },
  actual: WorldProjectCommandSuccess,
): string | null {
  if (actual.projectKey !== projectKey) return 'Repository command result changed project key.'
  if (actual.snapshot.project.projectId !== batch.projectId) return 'Repository command result changed project identity.'
  if (actual.newRevision !== batch.baseRevision + 1 || actual.snapshot.project.revision !== actual.newRevision) return 'Repository command result has an unexpected revision.'
  if (actual.receipt.transactionId !== batch.transactionId || actual.receipt.appliedRevision !== actual.newRevision) return 'Repository command receipt does not match the request.'
  if (!sameData(actual.snapshot, expected.snapshot)) return 'Repository command snapshot does not match local validation.'
  if (!sameData(actual.inverse, expected.inverse)) return 'Repository command inverse does not match local validation.'
  if (!sameData(actual.changes, expected.changes) || !sameData(actual.warnings, expected.warnings)) return 'Repository command diagnostics do not match local validation.'
  return null
}

function freezeState(state: WorldEditorControllerState): WorldEditorControllerState {
  const errorValue: WorldEditorControllerError | null = state.error ? deepFreezeData({
    code: state.error.code,
    message: state.error.message,
    retryable: state.error.retryable,
    ...(state.error.issues ? { issues: [...state.error.issues].map((issue) => ({ ...issue })) } : {}),
  }) : null
  return Object.freeze({
    ...state,
    error: errorValue,
    projects: deepFreezeData(structuredClone(state.projects)),
  })
}

function ok<T>(value: T): WorldEditorControllerResult<T> {
  return { ok: true, value }
}

function error<T>(code: WorldEditorControllerErrorCode, message: string, retryable: boolean): WorldEditorControllerResult<T> {
  return { ok: false, error: deepFreezeData({ code, message, retryable }) }
}

function sameData(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right)
}

function safeCurrent(check: () => boolean): boolean {
  try { return check() } catch { return false }
}

async function snapshotSha256(snapshot: WorldProjectSnapshotV1): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalWorldProjectSnapshotPayload(snapshot))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((part) => part.toString(16).padStart(2, '0')).join('')
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.entries(value).sort(([left], [right]) => codeUnitCompare(left, right)).map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`
}

function digest32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function deepFreezeData<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreezeData(descriptor.value)
  }
  Object.freeze(value)
  return value
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
