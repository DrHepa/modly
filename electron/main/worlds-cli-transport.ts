import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, lstat, chmod, unlink, realpath, open } from 'node:fs/promises'
import { realpathSync, constants as fsConstants } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join, dirname, isAbsolute } from 'node:path'
import { isWorldProjectKey, WORLD_PROJECT_PUBLIC_ERROR_CODES, type WorldProjectListResult, type WorldProjectOpenResult, type WorldProjectResult,
  type WorldsCliCompleteReview, type WorldsCliPendingSummary, type WorldsCliReply } from '../../src/shared/types/worldProjects.ts'
import { parseWorldAiQueryRequest, safeWorldAiText, worldAiQueryScope, WORLD_AI_CONTEXT_SCHEMA,
  type WorldAiQueryPage } from '../../src/areas/worlds/core/worldAiContract.ts'
import { isWorldCanonicalId } from '../../src/areas/worlds/core/worldValidationLimits.ts'
import { canonicalWorldCommandBatchPayload, parseWorldCommandBatch, type WorldCommandBatchV1 } from '../../src/areas/worlds/core/worldCommands.ts'
import { parseStrictWorldsCliJson, parseWorldsCliRecipeJson } from './worlds-cli-recipe-json.ts'
import type { WorldAiContext, WorldAiProposal } from '../../src/areas/worlds/core/worldAiContract.ts'
import type { WorldAiSemanticReview } from '../../src/areas/worlds/core/worldAiSemanticReview.ts'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { canonicalWorldProjectSnapshotPayload } from '../../src/areas/worlds/core/worldSnapshotDigest.ts'

const MAX_REQUEST_BYTES = 8192
const MAX_RESPONSE_BYTES = 36 * 1024
const PAIRING_MS = 2 * 60_000
const SESSION_MS = 15 * 60_000
const EDIT_LEASE_MS = 5 * 60_000
const PAIR_REQUEST_MS = 90_000
const PAIR_RATE_WINDOW_MS = 10 * 60_000
const PAIR_RATE_FILE = 'pair-rate.json'
const PAIR_RATE_BYTES = 256
const CONNECTION_MS = 3000
const FRAME_DEADLINE_MS = 3000
const ALLOWED_KINDS = new Set(['project', 'scenes', 'entities', 'components', 'resources'])
const PLAN_MS = 2 * 60_000
const PROPOSAL_MS = 2 * 60_000
const MAX_PLANS = 8
const MAX_PROPOSALS = 8
export const WORLD_CLI_DIRECT_EDIT_LIMIT = 8
type PublicResponse = Record<string, unknown>
type Trust = { window: object; contents: object; frame: object; documentUrl: string; documentEpoch: number; workspaceRoot: string }
export type WorldsCliEditorScope = { projectKey: string; projectId: string; sceneId: string; revision: number; editorEpoch: number; trust: Trust; canonicalWorkspace: string }
type Plan = { id: string; context: WorldAiContext; sessionId: string; generation: number; trust: Trust;
  canonicalWorkspace: string; expiresAt: number; proposing: boolean; querying: boolean;
  pendingDelivery: { id: string; page: WorldAiQueryPage; claimed: boolean } | null;
  cursors: Map<string, { scope: string; canonical: string }> }
type ReadCursor = { scope: string; canonical: string; sessionId: string; generation: number;
  projectKey: string; revision: number; sceneId: string; expiresAt: number }
type DirectEditCapture = Readonly<{ planId: string; context: WorldAiContext; batch: WorldCommandBatchV1;
  snapshot: WorldProjectSnapshotV1; trust: Trust; trustSnapshot: Trust; authority: string; sessionId: string; generation: number;
  sessionExpiresAt: number; editorEpoch: number; canonicalWorkspace: string; expiresAt: number; candidateSnapshotSha256: string }>
type PendingProposal = { id: string; planId: string; context: WorldAiContext; sessionId: string; generation: number;
  trust: Trust; canonicalWorkspace: string; expiresAt: number; digest: string; batch: WorldCommandBatchV1;
  snapshot: WorldProjectSnapshotV1; candidateSnapshotSha256: string; review: Extract<WorldAiSemanticReview, { complete: true }>; authority: string;
  state: 'pending' | 'confirming' | 'committing' | 'direct-edit' | 'settled'; revoked: boolean; discardRequested?: boolean;
  directEditCapture?: DirectEditCapture;
  issuedReview?: { id: string; digest: string; sessionId: string; generation: number; trust: Trust; expiresAt: number } }
export type WorldsCliDirectEditCommitReceipt = Readonly<{
  transactionId: string; projectId: string; newRevision: number; snapshotSha256: string
}>
export type WorldsCliDirectEditReservationSource = Readonly<{
  proposalId: string; transactionId: string; digest: string; beforeSnapshotSha256: string;
  candidateSnapshotSha256: string; expiresAt: number;
  scope: Readonly<{ sessionId: string; generation: number; sessionExpiresAt: number; projectKey: string;
    projectId: string; sceneId: string; editorEpoch: number; revision: number; mode: 'edit' }>
}>
export type WorldsCliDirectEditReservation = Readonly<{
  source: WorldsCliDirectEditReservationSource
  commit(callbacks: { assertLive(): void; onJournalStart(): void }): Promise<WorldsCliReply<{ receipt: WorldsCliDirectEditCommitReceipt }>>
  verifyDisk(receipt: WorldsCliDirectEditCommitReceipt): Promise<WorldsCliReply<Record<never, never>>>
  advanceScope(receipt: WorldsCliDirectEditCommitReceipt): WorldsCliReply<{ revision: number }>
  finish(): Promise<WorldsCliReply<Record<never, never>>>
}>
type Repository = {
  list(): Promise<WorldProjectListResult>
  open(request: { projectKey: string }): Promise<WorldProjectOpenResult>
  queryAi(request: unknown): Promise<WorldProjectResult<WorldAiQueryPage>>
  queryAiForCli?(request: unknown): Promise<WorldProjectResult<WorldAiQueryPage>>
  recordCliAiObservation?(context: WorldAiContext, page: WorldAiQueryPage): Promise<void>
  previewCliAi?(proposal: WorldAiProposal): Promise<WorldProjectResult<{ batch: WorldCommandBatchV1; snapshot: WorldProjectSnapshotV1;
    review: Extract<WorldAiSemanticReview, { complete: true }>; authority: string; candidateSnapshotSha256: string }>>
  discardAi?(request: { context: WorldAiContext; authority: string }): Promise<WorldProjectResult<{ discarded: true }>>
  applyReviewedCliAi?(request: { projectKey: string; batch: WorldCommandBatchV1; aiAuthority: { context: WorldAiContext; token: string };
    beforeSnapshotSha256: string; candidateSnapshotSha256: string; assertLive(): void; onJournalStart(): void }): Promise<WorldProjectResult<{
      projectKey: string; snapshot: WorldProjectSnapshotV1; newRevision: number; receipt: { transactionId: string; resultSha256: string } }>>
  applyScopedCliAi?(request: { projectKey: string; batch: WorldCommandBatchV1; aiAuthority: { context: WorldAiContext; token: string };
    beforeSnapshotSha256: string; candidateSnapshotSha256: string; assertLive(): void; onJournalStart(): void }): Promise<WorldProjectResult<{
      projectKey: string; snapshot: WorldProjectSnapshotV1; newRevision: number; idempotent: boolean;
      receipt: { transactionId: string; resultSha256: string; appliedRevision: number } }>>
}

/** Linux-only first vertical. No fallback to a public temp directory or the HTTP bridge. */
export function worldsCliRuntimeDir(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'linux' || !environment.XDG_RUNTIME_DIR) throw new Error('Worlds CLI requires a private Linux runtime directory')
  return join(environment.XDG_RUNTIME_DIR, 'modly-worlds-cli')
}

export class WorldsCliTransport {
  readonly socketPath: string
  private server: Server | null = null
  private sockets = new Set<Socket>()
  private pairingCode: string | null = null
  private pairingId: string | null = null
  private pairingExpiresAt = 0
  private session: string | null = null
  private sessionId: string | null = null
  private sessionExpiresAt = 0
  private pairingScope: WorldsCliEditorScope | null = null
  private grantedScope: WorldsCliEditorScope | null = null
  private pairRequestPending = false
  private socketIdentity: { dev: number; ino: number } | null = null
  private startInFlight: Promise<void> | null = null
  private revokeInFlight: Promise<void> | null = null
  private stopped = false
  private generation = 0
  private readonly plans = new Map<string, Plan>()
  private readonly proposals = new Map<string, PendingProposal>()
  private directEditEntry: PendingProposal | null = null
  private directEditBudget: { sessionId: string; generation: number; admitted: number } | null = null
  private readonly readCursors = new Map<string, ReadCursor>()
  private readonly captureTrust?: () => Trust | null
  private readonly activeEditorScope?: () => Promise<WorldsCliEditorScope | null>
  private readonly onPairRequest?: (isLive: () => boolean) => Promise<{ ok: boolean }>
  private readonly dispatchDirectEditProposal?: (proposalId: string) => Promise<WorldsCliReply<{ editIntent: string; expiresAt: number }>>
  private readonly now: () => number
  private readonly repository: Repository
  private readonly runtimeDir: string
  private readonly frameDeadlineMs: number
  private readonly pairRequestMs: number
  private readonly listenServer: (server: Server, path: string) => Promise<void>

  constructor(options: { repository: Repository; runtimeDir: string; now?: () => number; frameDeadlineMs?: number;
    pairRequestMs?: number;
    listenServer?: (server: Server, path: string) => Promise<void>; captureTrust?: () => Trust | null;
    activeEditorScope?: () => Promise<WorldsCliEditorScope | null>; onPairRequest?: (isLive: () => boolean) => Promise<{ ok: boolean }>;
    dispatchDirectEditProposal?: (proposalId: string) => Promise<WorldsCliReply<{ editIntent: string; expiresAt: number }>> }) {
    this.repository = options.repository
    this.runtimeDir = options.runtimeDir
    this.socketPath = join(options.runtimeDir, 'worlds.sock')
    this.now = options.now ?? Date.now
    this.frameDeadlineMs = options.frameDeadlineMs ?? FRAME_DEADLINE_MS
    this.pairRequestMs = options.pairRequestMs ?? PAIR_REQUEST_MS
    this.listenServer = options.listenServer ?? ((server, path) => new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => { server.off('error', reject); resolve() })
    }))
    this.captureTrust = options.captureTrust
    this.activeEditorScope = options.activeEditorScope
    this.onPairRequest = options.onPairRequest
    this.dispatchDirectEditProposal = options.dispatchDirectEditProposal
  }

  // Never report off while a bind or close still owns a live listener.
  get running(): boolean { return this.server !== null || this.startInFlight !== null || this.revokeInFlight !== null }

  getStatus(): { running: boolean; paired: boolean; expired: boolean; pairingPending: boolean; pairingId: string | null; sessionExpiresAt: number | null } {
    if (this.session !== null && this.now() >= this.sessionExpiresAt) this.directEditBudget = null
    const paired = this.running && this.session !== null && this.now() < this.sessionExpiresAt
    return { running: this.running, paired,
      expired: this.running && this.session !== null && this.now() >= this.sessionExpiresAt,
      pairingPending: this.running && this.pairingCode !== null && this.now() < this.pairingExpiresAt,
      pairingId: this.running ? this.pairingId : null,
      sessionExpiresAt: paired ? this.sessionExpiresAt : null }
  }

  /** Trusted Main IPC only. This deliberately is not routed through UDS dispatch. */
  async listPending(): Promise<WorldsCliReply<{ proposals: WorldsCliPendingSummary[] }>> {
    this.prune()
    const proposals = []
    for (const entry of [...this.proposals.values()]) {
      if (entry.state !== 'pending') continue
      if (!await this.proposalLive(entry)) { await this.dropProposal(entry); continue }
      proposals.push(this.pendingSummary(entry))
    }
    // A navigation/revoke during the final awaited check must not release even earlier entries.
    return { ok: true, proposals: proposals.filter((item) => {
      const entry = this.proposals.get(item.proposalId)
      return !!entry && entry.state === 'pending' && this.proposalIdentityLive(entry)
    }) }
  }

  async getReview(request: { proposalId: string }): Promise<WorldsCliReply<WorldsCliPendingSummary & { reviewId: string; review: WorldsCliCompleteReview }>> {
    if (!request || !/^proposal_[a-f0-9]{48}$/.test(request.proposalId)) return { ok: false, code: 'INVALID_REQUEST' }
    const entry = this.proposals.get(request.proposalId)
    if (!entry) return { ok: false, code: 'NOT_FOUND' }
    if (entry.state !== 'pending') return { ok: false, code: 'BUSY' }
    if (!await this.proposalLive(entry)) { await this.dropProposal(entry); return { ok: false, code: 'STALE' } }
    if (entry.state !== 'pending') return { ok: false, code: 'BUSY' }
    const review = this.projectReview(entry.review)
    if (!review) { await this.dropProposal(entry); return { ok: false, code: 'STALE' } }
    const issuedReview = { id: `review_${randomBytes(24).toString('hex')}`, digest: entry.digest, sessionId: entry.sessionId,
      generation: entry.generation, trust: entry.trust, expiresAt: entry.expiresAt }
    if (!this.proposalIdentityLive(entry)) { await this.dropProposal(entry); return { ok: false, code: 'STALE' } }
    entry.issuedReview = issuedReview
    return { ok: true, ...this.pendingSummary(entry), reviewId: issuedReview.id, review }
  }

  async reject(request: { proposalId: string; reviewId: string }): Promise<WorldsCliReply<{ status: 'rejected' | 'absent' }>> {
    if (!request || !/^proposal_[a-f0-9]{48}$/.test(request.proposalId) || !/^review_[a-f0-9]{48}$/.test(request.reviewId)) return { ok: false, code: 'INVALID_REQUEST' }
    const entry = this.proposals.get(request.proposalId)
    if (!entry) return { ok: true, status: 'absent' }
    if (entry.state !== 'pending') return { ok: false, code: 'BUSY' }
    if (!await this.proposalLive(entry)) { await this.dropProposal(entry); return { ok: false, code: 'STALE' } }
    if (entry.state !== 'pending') return { ok: false, code: 'BUSY' }
    const review = entry.issuedReview
    if (!review || review.id !== request.reviewId || review.digest !== entry.digest || review.sessionId !== entry.sessionId
      || review.generation !== entry.generation || review.expiresAt !== entry.expiresAt || !sameTrust(review.trust, entry.trust)) return { ok: false, code: 'STALE' }
    if (!this.proposalIdentityLive(entry)) { await this.dropProposal(entry); return { ok: false, code: 'STALE' } }
    return await this.dropProposal(entry) ? { ok: true, status: 'rejected' } : { ok: false, code: 'UNAVAILABLE' }
  }

  /** Trusted Main only. The native confirmation callback receives the entire bounded safe review. */
  async apply(request: { proposalId: string; reviewId: string }, confirm: (review: WorldsCliCompleteReview,
    scope: { projectId: string; sceneId: string; revision: number }) => Promise<boolean>, assertIntentLive: () => void = () => {}): Promise<WorldsCliReply<{
    transactionId: string; projectId: string; baseRevision: number; newRevision: number; beforeSnapshotSha256: string; snapshotSha256: string
  }>> {
    if (!request || !/^proposal_[a-f0-9]{48}$/.test(request.proposalId) || !/^review_[a-f0-9]{48}$/.test(request.reviewId)) return { ok: false, code: 'INVALID_REQUEST' }
    const entry = this.proposals.get(request.proposalId)
    if (!entry) return { ok: false, code: 'NOT_FOUND' }
    if (entry.state !== 'pending') return { ok: false, code: 'BUSY' }
    const review = entry.issuedReview
    if (!review || review.id !== request.reviewId || review.digest !== entry.digest || review.sessionId !== entry.sessionId
      || review.generation !== entry.generation || review.expiresAt !== entry.expiresAt || !sameTrust(review.trust, entry.trust)) return { ok: false, code: 'STALE' }
    const projected = this.projectReview(entry.review)
    if (!projected || !this.repository.applyReviewedCliAi) return { ok: false, code: 'UNAVAILABLE' }
    entry.state = 'confirming'
    let journalStarted = false
    let intentStale = false
    const assertLiveIntent = (): void => {
      try { assertIntentLive() } catch (error) { intentStale = true; throw error }
    }
    try {
      assertLiveIntent()
      const initiallyLive = await this.proposalLive(entry, assertLiveIntent)
      assertLiveIntent()
      if (!initiallyLive) return { ok: false, code: 'STALE' }
      const approved = await confirm(projected, { projectId: entry.context.projectId, sceneId: entry.context.activeSceneId,
        revision: entry.context.baseRevision })
      assertLiveIntent()
      if (!approved) return { ok: false, code: 'USER_DECLINED' }
      const stillLive = await this.proposalLive(entry, assertLiveIntent)
      assertLiveIntent()
      if (!stillLive) return { ok: false, code: 'STALE' }
      entry.state = 'committing'
      const beforeSnapshotSha256 = createHash('sha256').update(canonicalWorldProjectSnapshotPayload(entry.snapshot)).digest('hex')
      const assertLive = () => {
        assertLiveIntent()
        if (!this.proposalIdentityLive(entry) || entry.revoked || entry.state !== 'committing') throw new Error('Reviewed Apply is stale')
        if (realpathSync(entry.trust.workspaceRoot) !== entry.canonicalWorkspace) throw new Error('Reviewed Apply root changed')
      }
      const result = await this.repository.applyReviewedCliAi({ projectKey: entry.context.projectKey, batch: entry.batch,
        aiAuthority: { context: entry.context, token: entry.authority },
        beforeSnapshotSha256,
        candidateSnapshotSha256: entry.candidateSnapshotSha256, assertLive,
        onJournalStart: () => { assertLive(); journalStarted = true } })
      assertLiveIntent()
      if (!result.ok) return { ok: false, code: journalStarted ? 'AMBIGUOUS' : 'UNAVAILABLE' }
      const scopeLive = await this.proposalScopeLive(entry, assertLiveIntent)
      assertLiveIntent()
      if (!scopeLive) return { ok: false, code: 'AMBIGUOUS' }
      if (result.value.receipt.transactionId !== entry.batch.transactionId || result.value.projectKey !== entry.context.projectKey
        || result.value.newRevision !== entry.context.baseRevision + 1
        || result.value.snapshot.project.projectId !== entry.context.projectId
        || result.value.snapshot.project.revision !== result.value.newRevision
        || createHash('sha256').update(canonicalWorldProjectSnapshotPayload(result.value.snapshot)).digest('hex') !== entry.candidateSnapshotSha256) return { ok: false, code: 'AMBIGUOUS' }
      return { ok: true, transactionId: result.value.receipt.transactionId, projectId: entry.context.projectId,
        baseRevision: entry.context.baseRevision, newRevision: result.value.newRevision, beforeSnapshotSha256,
        snapshotSha256: entry.candidateSnapshotSha256 }
    } catch {
      try { assertLiveIntent() } catch { /* Capture cancellation thrown inside the native callback. */ }
      return { ok: false, code: journalStarted ? 'AMBIGUOUS' : intentStale ? 'STALE' : 'UNAVAILABLE' }
    }
    finally { entry.state = 'settled'; await this.dropProposal(entry) }
  }

  /** Trusted Main only. This custody object is intentionally unreachable from UDS and renderer IPC. */
  async reserveDirectEdit(proposalId: string): Promise<WorldsCliReply<{ reservation: WorldsCliDirectEditReservation }>> {
    if (typeof proposalId !== 'string' || !/^proposal_[a-f0-9]{48}$/.test(proposalId)) return { ok: false, code: 'INVALID_REQUEST' }
    this.prune()
    if (this.session !== null && this.now() >= this.sessionExpiresAt) this.directEditBudget = null
    if (this.directEditEntry) return { ok: false, code: 'BUSY' }
    const entry = this.proposals.get(proposalId)
    if (!entry) return { ok: false, code: 'NOT_FOUND' }
    if (entry.state !== 'pending' || entry.issuedReview) return { ok: false, code: 'BUSY' }
    const grantedScope = this.grantedScope
    if (!grantedScope || !this.activeEditorScope || !this.captureTrust || !this.repository.applyScopedCliAi || !this.repository.discardAi
      || !this.sessionId || !this.session || !/^[a-f0-9]{32}$/.test(this.sessionId)
      || !Number.isSafeInteger(this.sessionExpiresAt) || this.sessionExpiresAt <= this.now()
      || !isWorldProjectKey(grantedScope.projectKey) || !isWorldCanonicalId(grantedScope.projectId)
      || !isWorldCanonicalId(grantedScope.sceneId) || !Number.isSafeInteger(grantedScope.revision) || grantedScope.revision < 0
      || !Number.isSafeInteger(grantedScope.editorEpoch) || grantedScope.editorEpoch < 0
      || !Number.isSafeInteger(grantedScope.trust.documentEpoch) || grantedScope.trust.documentEpoch < 0
      || typeof grantedScope.trust.documentUrl !== 'string' || !grantedScope.trust.documentUrl
      || !isAbsolute(grantedScope.trust.workspaceRoot) || !isAbsolute(grantedScope.canonicalWorkspace)) return { ok: false, code: 'STALE' }
    const trustSnapshot: Trust = Object.freeze({ window: entry.trust.window, contents: entry.trust.contents, frame: entry.trust.frame,
      documentUrl: entry.trust.documentUrl, documentEpoch: entry.trust.documentEpoch, workspaceRoot: entry.trust.workspaceRoot })
    const capture: DirectEditCapture = Object.freeze({ planId: entry.planId, context: entry.context, batch: entry.batch,
      snapshot: entry.snapshot, trust: entry.trust, trustSnapshot, authority: entry.authority, sessionId: entry.sessionId,
      generation: entry.generation, sessionExpiresAt: this.sessionExpiresAt, editorEpoch: grantedScope.editorEpoch,
      canonicalWorkspace: entry.canonicalWorkspace, expiresAt: entry.expiresAt,
      candidateSnapshotSha256: entry.candidateSnapshotSha256 })
    let source: WorldsCliDirectEditReservationSource
    try {
      const beforeSnapshotSha256 = createHash('sha256').update(canonicalWorldProjectSnapshotPayload(entry.snapshot)).digest('hex')
      const scope = Object.freeze({ sessionId: entry.sessionId, generation: entry.generation, sessionExpiresAt: this.sessionExpiresAt,
        projectKey: entry.context.projectKey, projectId: entry.context.projectId, sceneId: entry.context.activeSceneId,
        editorEpoch: grantedScope.editorEpoch, revision: entry.context.baseRevision, mode: 'edit' as const })
      source = Object.freeze({ proposalId: entry.id, transactionId: entry.batch.transactionId, digest: entry.digest,
        beforeSnapshotSha256, candidateSnapshotSha256: entry.candidateSnapshotSha256, expiresAt: entry.expiresAt, scope })
    } catch { await this.dropProposal(entry); return { ok: false, code: 'STALE' } }
    const budget = this.directEditBudget
    if (!budget || budget.sessionId !== this.sessionId || budget.generation !== this.generation
      || budget.admitted >= WORLD_CLI_DIRECT_EDIT_LIMIT) {
      await this.dropProposal(entry)
      return { ok: false, code: budget?.admitted === WORLD_CLI_DIRECT_EDIT_LIMIT ? 'BUSY' : 'STALE' }
    }
    budget.admitted++
    entry.directEditCapture = capture
    entry.state = 'direct-edit'
    this.directEditEntry = entry
    if (!this.directEditIdentityLive(entry, source, grantedScope, capture)
      || !await this.verifyScope(grantedScope) || !await this.proposalLive(entry)
      || !this.directEditIdentityLive(entry, source, grantedScope, capture)) {
      entry.state = 'settled'
      await this.dropProposal(entry)
      return { ok: false, code: 'STALE' }
    }

    let commitUsed = false
    let verifyUsed = false
    let advanceUsed = false
    let finishUsed = false
    let diskVerified = false
    let committedReceipt: WorldsCliDirectEditCommitReceipt | null = null
    const commit: WorldsCliDirectEditReservation['commit'] = async (callbacks) => {
      if (commitUsed || finishUsed) return { ok: false, code: 'BUSY' }
      commitUsed = true
      if (!callbacks || typeof callbacks.assertLive !== 'function' || typeof callbacks.onJournalStart !== 'function') return { ok: false, code: 'INVALID_REQUEST' }
      if (!this.directEditIdentityLive(entry, source, grantedScope, capture)) return { ok: false, code: 'STALE' }
      try {
        if (!await this.proposalLive(entry) || !this.directEditIdentityLive(entry, source, grantedScope, capture)) return { ok: false, code: 'STALE' }
        const assertLive = () => {
          callbacks.assertLive()
          if (!this.directEditIdentityLive(entry, source, grantedScope, capture)) throw new Error('Direct-edit custody is stale')
        }
        assertLive()
        const result = await this.repository.applyScopedCliAi!({ projectKey: entry.context.projectKey, batch: entry.batch,
          aiAuthority: { context: entry.context, token: entry.authority }, beforeSnapshotSha256: source.beforeSnapshotSha256,
          candidateSnapshotSha256: source.candidateSnapshotSha256, assertLive,
          onJournalStart: () => { assertLive(); callbacks.onJournalStart() } })
        assertLive()
        if (!result.ok || result.value.idempotent !== false || result.value.projectKey !== entry.context.projectKey
          || result.value.receipt.transactionId !== source.transactionId || result.value.receipt.appliedRevision !== entry.context.baseRevision + 1
          || result.value.newRevision !== result.value.receipt.appliedRevision
          || result.value.snapshot.project.projectId !== entry.context.projectId
          || result.value.snapshot.project.revision !== result.value.newRevision
          || createHash('sha256').update(canonicalWorldProjectSnapshotPayload(result.value.snapshot)).digest('hex') !== source.candidateSnapshotSha256) {
          return { ok: false, code: 'AMBIGUOUS' }
        }
        committedReceipt = Object.freeze({ transactionId: source.transactionId, projectId: entry.context.projectId,
          newRevision: result.value.newRevision, snapshotSha256: source.candidateSnapshotSha256 })
        return { ok: true, receipt: committedReceipt }
      } catch { return { ok: false, code: 'UNAVAILABLE' } }
    }
    const verifyDisk: WorldsCliDirectEditReservation['verifyDisk'] = async (receipt) => {
      if (verifyUsed || finishUsed || !committedReceipt) return { ok: false, code: 'BUSY' }
      verifyUsed = true
      if (receipt !== committedReceipt || !this.directEditIdentityLive(entry, source, grantedScope, capture)) return { ok: false, code: 'AMBIGUOUS' }
      try {
        const opened = await this.repository.open({ projectKey: entry.context.projectKey })
        if (!this.directEditIdentityLive(entry, source, grantedScope, capture) || !opened.ok || opened.value.status !== 'ready'
          || opened.value.snapshot.project.projectId !== receipt.projectId
          || opened.value.snapshot.project.revision !== receipt.newRevision
          || createHash('sha256').update(canonicalWorldProjectSnapshotPayload(opened.value.snapshot)).digest('hex') !== receipt.snapshotSha256) {
          return { ok: false, code: 'AMBIGUOUS' }
        }
        diskVerified = true
        return { ok: true }
      } catch { return { ok: false, code: 'AMBIGUOUS' } }
    }
    const advanceScope: WorldsCliDirectEditReservation['advanceScope'] = (receipt) => {
      if (advanceUsed || finishUsed || !diskVerified || !committedReceipt) return { ok: false, code: 'BUSY' }
      advanceUsed = true
      if (receipt !== committedReceipt || !this.directEditIdentityLive(entry, source, grantedScope, capture)) return { ok: false, code: 'AMBIGUOUS' }
      this.grantedScope = Object.freeze({ ...grantedScope, revision: receipt.newRevision })
      return { ok: true, revision: receipt.newRevision }
    }
    const finish: WorldsCliDirectEditReservation['finish'] = async () => {
      if (finishUsed) return { ok: false, code: 'STALE' }
      finishUsed = true
      const exactReserved = this.proposals.get(entry.id) === entry && this.directEditEntry === entry
        && entry.state === 'direct-edit' && entry.directEditCapture === capture
      if (exactReserved) this.proposals.delete(entry.id)
      entry.state = 'settled'
      await this.dropProposal(entry, false)
      return { ok: true }
    }
    return { ok: true, reservation: Object.freeze({ source, commit, verifyDisk, advanceScope, finish }) }
  }

  private pendingSummary(entry: PendingProposal): WorldsCliPendingSummary {
    return { proposalId: entry.id, projectKey: entry.context.projectKey, projectId: safeWorldAiText(entry.context.projectId),
      sceneId: safeWorldAiText(entry.context.activeSceneId), revision: entry.context.baseRevision,
      digest: entry.digest, expiresAt: entry.expiresAt, commandCount: entry.batch.commands.length,
      changeCount: entry.review.changes.length, warningCount: entry.review.warnings.length }
  }

  private projectReview(review: PendingProposal['review']): WorldsCliCompleteReview | null {
    if (review.changes.length < 1 || review.changes.length > 48 || review.warnings.length > 2) return null
    const textSafe = (value: string) => value.length <= 120 && !/[\\/]/.test(value)
      && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
      && !/\b[A-Za-z][A-Za-z0-9+.-]{0,31}:[^\s]/u.test(value.replace(/\b(?:asset|camera|collider|component|entity|environment|event|graphics|input|light|model|project|renderable|resource|rigid-body|scene|sequence|track|transaction|trigger|tx|world):[A-Za-z0-9:_-]+\b/g, ''))
    if (review.changes.some((change) => change.field.length > 80 || !textSafe(change.field) || change.before !== null && !textSafe(change.before)
      || change.after !== null && !textSafe(change.after)) || review.warnings.some((warning) => !textSafe(warning))) return null
    const projected = { complete: true as const, changes: review.changes.map(({ field, before, after }) => ({ field, before, after })),
      warnings: [...review.warnings] }
    return new TextEncoder().encode(JSON.stringify(projected)).byteLength <= 4000 ? projected : null
  }

  private proposalIdentityLive(entry: PendingProposal): boolean {
    return !entry.revoked && this.proposals.get(entry.id) === entry && this.sessionId === entry.sessionId && this.generation === entry.generation
      && this.session !== null && this.now() < Math.min(entry.expiresAt, this.sessionExpiresAt)
      && sameTrust(this.captureTrust?.(), entry.trust)
  }

  private async proposalLive(entry: PendingProposal, assertIntentLive?: () => void): Promise<boolean> {
    if (!this.proposalIdentityLive(entry)) return false
    try {
      const firstRoot = await realpath(entry.trust.workspaceRoot)
      assertIntentLive?.()
      if (firstRoot !== entry.canonicalWorkspace || !this.proposalIdentityLive(entry)) return false
      const opened = await this.repository.open({ projectKey: entry.context.projectKey })
      assertIntentLive?.()
      if (!this.proposalIdentityLive(entry) || !opened.ok || opened.value.status !== 'ready'
        || opened.value.snapshot.project.revision !== entry.context.baseRevision
        || opened.value.snapshot.project.projectId !== entry.context.projectId) return false
      const finalRoot = await realpath(entry.trust.workspaceRoot)
      assertIntentLive?.()
      return this.proposalIdentityLive(entry) && finalRoot === entry.canonicalWorkspace
        && opened.ok && opened.value.status === 'ready'
        && opened.value.snapshot.project.revision === entry.context.baseRevision
        && opened.value.snapshot.project.projectId === entry.context.projectId
    } catch { return false }
  }

  private async proposalScopeLive(entry: PendingProposal, assertIntentLive?: () => void): Promise<boolean> {
    if (!this.proposalIdentityLive(entry)) return false
    try {
      const root = await realpath(entry.trust.workspaceRoot)
      assertIntentLive?.()
      return root === entry.canonicalWorkspace && this.proposalIdentityLive(entry)
    }
    catch { return false }
  }

  private directEditIdentityLive(entry: PendingProposal, source: WorldsCliDirectEditReservationSource,
    grantedScope: WorldsCliEditorScope, capture: DirectEditCapture): boolean {
    try {
      const parsed = parseWorldCommandBatch(entry.batch)
      const currentTrust = this.captureTrust?.()
      return parsed.success && this.directEditEntry === entry && this.proposals.get(entry.id) === entry
        && entry.state === 'direct-edit' && !entry.revoked && entry.directEditCapture === capture && this.grantedScope === grantedScope
        && entry.planId === capture.planId && entry.context === capture.context && entry.batch === capture.batch
        && entry.snapshot === capture.snapshot && entry.trust === capture.trust && entry.authority === capture.authority
        && entry.sessionId === capture.sessionId && entry.generation === capture.generation
        && entry.canonicalWorkspace === capture.canonicalWorkspace && entry.expiresAt === capture.expiresAt
        && entry.candidateSnapshotSha256 === capture.candidateSnapshotSha256
        && sameTrust(entry.trust, capture.trustSnapshot)
        && this.session !== null && this.sessionId === entry.sessionId && this.generation === entry.generation
        && source.scope.sessionId === entry.sessionId && source.scope.generation === entry.generation
        && this.sessionExpiresAt === capture.sessionExpiresAt && source.scope.sessionExpiresAt === capture.sessionExpiresAt
        && source.expiresAt === entry.expiresAt
        && this.now() < Math.min(source.expiresAt, this.sessionExpiresAt) && source.scope.mode === 'edit'
        && entry.id === source.proposalId && entry.digest === source.digest
        && entry.context.requestId === source.transactionId && entry.batch.transactionId === source.transactionId
        && entry.context.projectKey === source.scope.projectKey && entry.context.projectId === source.scope.projectId
        && entry.context.activeSceneId === source.scope.sceneId && entry.context.baseRevision === source.scope.revision
        && parsed.value.origin === 'ai' && parsed.value.transactionId === source.transactionId
        && parsed.value.projectId === source.scope.projectId && parsed.value.baseRevision === source.scope.revision
        && canonicalWorldCommandBatchPayload(entry.batch) === canonicalWorldCommandBatchPayload(parsed.value)
        && createHash('sha256').update(canonicalWorldCommandBatchPayload(parsed.value)).digest('hex') === source.digest
        && createHash('sha256').update(canonicalWorldProjectSnapshotPayload(entry.snapshot)).digest('hex') === source.beforeSnapshotSha256
        && entry.candidateSnapshotSha256 === source.candidateSnapshotSha256
        && grantedScope.projectKey === source.scope.projectKey && grantedScope.projectId === source.scope.projectId
        && grantedScope.sceneId === source.scope.sceneId && grantedScope.revision === source.scope.revision
        && grantedScope.editorEpoch === capture.editorEpoch && source.scope.editorEpoch === capture.editorEpoch
        && grantedScope.canonicalWorkspace === capture.canonicalWorkspace
        && sameTrust(grantedScope.trust, capture.trustSnapshot) && sameTrust(currentTrust, capture.trustSnapshot)
        && entry.canonicalWorkspace === capture.canonicalWorkspace
        && realpathSync(capture.trustSnapshot.workspaceRoot) === capture.canonicalWorkspace
    } catch { return false }
  }

  private async dropProposal(entry: PendingProposal, deleteCurrent = true): Promise<boolean> {
    if (deleteCurrent && this.proposals.get(entry.id) === entry) this.proposals.delete(entry.id)
    if (this.directEditEntry === entry) this.directEditEntry = null
    entry.revoked = true
    if (entry.discardRequested) return true
    entry.discardRequested = true
    const context = entry.directEditCapture?.context ?? entry.context
    const authority = entry.directEditCapture?.authority ?? entry.authority
    try { return (await this.repository.discardAi?.({ context, authority }))?.ok === true }
    catch { return false }
  }

  async startListening(): Promise<void> {
    if (this.revokeInFlight || this.stopped) throw new Error('Worlds CLI is stopping')
    if (this.server) return
    if (!this.startInFlight) {
      const starting = this.start()
      this.startInFlight = starting
      const clear = () => { if (this.startInFlight === starting) this.startInFlight = null }
      void starting.then(clear, clear)
    }
    await this.startInFlight
  }

  async beginPairing(scope?: WorldsCliEditorScope, isLive: () => boolean = () => true): Promise<{ code: string; expiresAt: number; pairingId: string }> {
    if (!isLive()) throw new Error('Worlds pairing intent expired')
    if (this.onPairRequest && (!scope || !await this.verifyScope(scope))) throw new Error('Worlds editor scope is stale')
    if (this.revokeInFlight) throw new Error('Worlds CLI is revoking')
    const generation = this.generation
    await this.startListening()
    if (!isLive() || this.generation !== generation || this.revokeInFlight || !this.server) throw new Error('Worlds CLI pairing was revoked')
    // New pairing revokes every previous CLI session. The code is only returned to trusted UI IPC.
    this.session = null
    this.sessionId = null
    this.sessionExpiresAt = 0
    this.directEditBudget = null
    this.grantedScope = null
    this.clearPlansAndProposals()
    this.pairingScope = scope ?? null
    this.pairingCode = randomBytes(16).toString('hex')
    this.pairingId = randomBytes(8).toString('hex')
    this.pairingExpiresAt = this.now() + PAIRING_MS
    return { code: this.pairingCode, expiresAt: this.pairingExpiresAt, pairingId: this.pairingId }
  }

  /** Leave the pre-consent listener active while revoking credentials and pending work. */
  revokeSession(): void {
    this.generation++
    this.pairingCode = null
    this.pairingScope = null
    this.grantedScope = null
    this.pairingId = null
    this.session = null
    this.sessionId = null
    this.pairingExpiresAt = 0
    this.sessionExpiresAt = 0
    this.directEditBudget = null
    this.clearPlansAndProposals()
  }

  private async verifyScope(scope: WorldsCliEditorScope): Promise<boolean> {
    if (!this.activeEditorScope || !this.captureTrust || !sameTrust(this.captureTrust(), scope.trust)) return false
    try {
      const current = await this.activeEditorScope()
      return !!current && current.projectKey === scope.projectKey && current.projectId === scope.projectId
        && current.sceneId === scope.sceneId && current.revision === scope.revision && current.editorEpoch === scope.editorEpoch
        && current.canonicalWorkspace === scope.canonicalWorkspace && sameTrust(current.trust, scope.trust)
        && await realpath(scope.trust.workspaceRoot) === scope.canonicalWorkspace
    } catch { return false }
  }

  private async grantedScopeLive(): Promise<boolean> {
    if (!this.onPairRequest) return true // Isolated legacy transport harnesses have no activation broker.
    const scope = this.grantedScope
    if (!scope || this.now() >= this.sessionExpiresAt || !await this.verifyScope(scope)) { this.revokeSession(); return false }
    return true
  }

  revoke(): Promise<void> {
    if (this.revokeInFlight) return this.revokeInFlight
    this.stopped = true
    this.revokeSession()
    const revoking = this.stopAfterPendingStart()
    this.revokeInFlight = revoking
    const clear = () => { if (this.revokeInFlight === revoking) this.revokeInFlight = null }
    void revoking.then(clear, clear)
    return revoking
  }

  private async stopAfterPendingStart(): Promise<void> {
    if (this.startInFlight) {
      try { await this.startInFlight } catch { /* Failed starts clean up their own server. */ }
    }
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (this.socketIdentity) {
      try {
        const current = await lstat(this.socketPath)
        if (current.isSocket() && current.dev === this.socketIdentity.dev && current.ino === this.socketIdentity.ino) await unlink(this.socketPath)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      this.socketIdentity = null
    }
  }

  private async start(): Promise<void> {
    if (process.platform !== 'linux') throw new Error('Worlds CLI private socket is supported on Linux only')
    const parent = await lstat(dirname(this.runtimeDir))
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid!() || (parent.mode & 0o077) !== 0) throw new Error('Unsafe Worlds CLI runtime parent')
    try { await mkdir(this.runtimeDir, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const directory = await lstat(this.runtimeDir)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() || (directory.mode & 0o777) !== 0o700) throw new Error('Unsafe Worlds CLI runtime directory')
    try { await lstat(this.socketPath); throw new Error('Worlds CLI socket already exists') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const server = createServer((socket) => this.accept(socket))
    server.maxConnections = 8
    try {
      await this.listenServer(server, this.socketPath)
      await chmod(this.socketPath, 0o600)
      const identity = await lstat(this.socketPath)
      if (!identity.isSocket() || identity.uid !== process.getuid!() || (identity.mode & 0o777) !== 0o600) throw new Error('Unsafe Worlds CLI socket')
      this.socketIdentity = { dev: identity.dev, ino: identity.ino }
      this.server = server
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw error
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.setTimeout(CONNECTION_MS, () => socket.destroy())
    // Idle timeout alone can be kept alive indefinitely by a byte-at-a-time peer.
    const frameDeadline = setTimeout(() => socket.destroy(), this.frameDeadlineMs)
    let chunks: Buffer[] = []
    let bytes = 0
    let expected = -1
    let done = false
    socket.on('close', () => { clearTimeout(frameDeadline); this.sockets.delete(socket) })
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: Buffer) => {
      if (done) { socket.destroy(); return }
      bytes += chunk.length
      if (bytes > MAX_REQUEST_BYTES + 4) { done = true; this.send(socket, { ok: false, code: 'INVALID_REQUEST' }); return }
      chunks.push(chunk)
      const data = Buffer.concat(chunks)
      if (expected < 0 && data.length >= 4) {
        expected = data.readUInt32BE(0)
        if (expected < 1 || expected > MAX_REQUEST_BYTES) { done = true; this.send(socket, { ok: false, code: 'INVALID_REQUEST' }); return }
      }
      if (expected >= 0 && data.length >= expected + 4) {
        done = true
        clearTimeout(frameDeadline)
        if (data.length !== expected + 4) { this.send(socket, { ok: false, code: 'INVALID_REQUEST' }); return }
        void this.dispatchFrame(socket, data.subarray(4))
        chunks = []
      }
    })
    socket.on('end', () => { if (!done) socket.destroy() })
  }

  private async dispatchFrame(socket: Socket, body: Buffer): Promise<void> {
    let request: unknown
    try { request = parseStrictWorldsCliJson(new TextDecoder('utf-8', { fatal: true }).decode(body)); if (!isBoundedRecord(request)) throw new Error('invalid') }
    catch { this.send(socket, { ok: false, code: 'INVALID_REQUEST' }); return }
    if (request.operation === 'pair.request') socket.setTimeout(this.pairRequestMs + 5000, () => socket.destroy())
    const sessionId = this.sessionId
    const generation = this.generation
    const stillAuthorized = () => request.operation === 'pair' || request.operation === 'pair.request'
      || (sessionId !== null && this.sessionLive(request.session, { sessionId, generation }))
    try {
      const response = await this.dispatch(request, socket)
      const live = response.ok === true && request.operation !== 'pair' && request.operation !== 'pair.request'
        ? response.status === 'direct-edit-dispatched' || await this.grantedScopeLive() : true
      this.send(socket, stillAuthorized() && live ? response : error('UNAUTHORIZED'))
    } catch { this.send(socket, stillAuthorized() ? error('INTERNAL_ERROR') : error('UNAUTHORIZED')) }
  }

  private async consumePairRequest(): Promise<boolean> {
    if ((fsConstants.O_NOFOLLOW ?? 0) === 0) throw new Error('No safe no-follow file opening')
    const path = join(this.runtimeDir, PAIR_RATE_FILE)
    let created = false
    let handle
    try {
      handle = await open(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      handle = await open(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW)
    }
    try {
      const identity = await handle.stat()
      const named = await lstat(path)
      if (!identity.isFile() || !named.isFile() || named.isSymbolicLink() || identity.uid !== process.getuid!()
        || identity.nlink !== 1 || (identity.mode & 0o777) !== 0o600 || identity.size > PAIR_RATE_BYTES
        || identity.dev !== named.dev || identity.ino !== named.ino) throw new Error('Unsafe rate file')
      const buffer = Buffer.alloc(PAIR_RATE_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead !== identity.size) throw new Error('Changed rate file')
      let attempts: number[] = []
      if (!created) {
        const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || Object.keys(parsed).sort().join(',') !== 'attempts,version' || (parsed as { version?: unknown }).version !== 1
          || !Array.isArray((parsed as { attempts?: unknown }).attempts)
          || (parsed as { attempts: unknown[] }).attempts.length > 3
          || !(parsed as { attempts: unknown[] }).attempts.every((value) => Number.isSafeInteger(value) && (value as number) >= 0)) throw new Error('Corrupt rate file')
        attempts = (parsed as { attempts: number[] }).attempts
      }
      const now = this.now()
      attempts = attempts.filter((timestamp) => timestamp > now || now - timestamp < PAIR_RATE_WINDOW_MS)
      if (attempts.length >= 3) return false
      attempts.push(now)
      const value = Buffer.from(JSON.stringify({ version: 1, attempts }))
      if (value.length > PAIR_RATE_BYTES) throw new Error('Rate file bound exceeded')
      const stillNamed = await lstat(path)
      if (stillNamed.dev !== identity.dev || stillNamed.ino !== identity.ino || stillNamed.isSymbolicLink()) throw new Error('Rate file replaced')
      await handle.truncate(0)
      await handle.writeFile(value)
      await handle.sync()
      return true
    } finally { await handle.close() }
  }

  private async dispatch(request: Record<string, unknown>, socket?: Socket): Promise<PublicResponse> {
    if (request.operation === 'pair.request') {
      if (!exact(request, ['operation'])) return error('INVALID_REQUEST')
      if (!this.onPairRequest) return error('UNAVAILABLE')
      if (this.session && this.now() < this.sessionExpiresAt) return error('BUSY')
      if (this.pairRequestPending || this.pairingCode && this.now() < this.pairingExpiresAt) return error('BUSY')
      this.pairRequestPending = true
      const attemptGeneration = this.generation
      let active = true
      let timer: ReturnType<typeof setTimeout> | null = null
      let requestSettled = false
      let flowSettled = false
      let resolveDisconnect: ((value: { ok: false }) => void) | null = null
      const onDisconnect = () => { if (!active) return; active = false; this.revokeSession(); resolveDisconnect?.({ ok: false }) }
      try {
        if (!await this.consumePairRequest()) return error('BUSY')
        if (socket?.destroyed) return error('USER_DECLINED')
        socket?.once('close', onDisconnect)
        socket?.once('end', onDisconnect)
        const isLive = () => active && !this.stopped && !socket?.destroyed
          && this.pairRequestPending && this.generation === attemptGeneration
        const flow = Promise.resolve().then(() => this.onPairRequest!(isLive)).then((result) => {
          flowSettled = true
          if (requestSettled) this.pairRequestPending = false
          return result
        }, () => {
          flowSettled = true
          if (requestSettled) this.pairRequestPending = false
          return { ok: false }
        })
        const result = await Promise.race([flow,
          new Promise<{ ok: false }>((resolve) => { timer = setTimeout(() => { active = false; this.revokeSession(); resolve({ ok: false }) }, this.pairRequestMs) }),
          new Promise<{ ok: false }>((resolve) => { resolveDisconnect = resolve })])
        if (!active || !result.ok || !this.pairingCode || !this.pairingScope || !await this.verifyScope(this.pairingScope)) {
          this.revokeSession(); return error('USER_DECLINED')
        }
        return { ok: true, expiresAt: this.pairingExpiresAt }
      } catch { this.revokeSession(); return error('UNAVAILABLE') }
      finally {
        active = false
        requestSettled = true
        if (flowSettled || !timer) this.pairRequestPending = false
        if (timer) clearTimeout(timer)
        socket?.off('close', onDisconnect)
        socket?.off('end', onDisconnect)
      }
    }
    if (request.operation === 'pair') {
      if (!exact(request, ['operation', 'code']) || typeof request.code !== 'string' || !this.pairingCode
        || this.now() >= this.pairingExpiresAt || !secureEqual(request.code, this.pairingCode)) return error('UNAUTHORIZED')
      if (this.onPairRequest && (!this.pairingScope || !await this.verifyScope(this.pairingScope))) {
        this.revokeSession(); return error('UNAUTHORIZED')
      }
      this.pairingCode = null
      this.grantedScope = this.pairingScope
      this.pairingScope = null
      this.session = randomBytes(32).toString('hex')
      this.sessionId = randomBytes(16).toString('hex')
      this.sessionExpiresAt = this.now() + (this.onPairRequest ? EDIT_LEASE_MS : SESSION_MS)
      this.generation++
      this.clearPlansAndProposals()
      this.directEditBudget = { sessionId: this.sessionId, generation: this.generation, admitted: 0 }
      return { ok: true, session: this.session, expiresAt: this.sessionExpiresAt, scope: 'worlds:read', proposalScope: 'worlds:auto-apply' }
    }
    if (!this.session || !this.sessionId || this.now() >= this.sessionExpiresAt
      || typeof request.session !== 'string' || !secureEqual(request.session, this.session)) {
      if (this.session && this.now() >= this.sessionExpiresAt) this.directEditBudget = null
      return error('UNAUTHORIZED')
    }
    if (this.directEditEntry) return error('BUSY')
    if (!await this.grantedScopeLive()) return error('UNAUTHORIZED')
    const readSession = { sessionId: this.sessionId, generation: this.generation }
    const operation = request.operation
    const scope = this.grantedScope
    if (operation === 'list') {
      if (!exact(request, ['operation', 'session'])) return error('INVALID_REQUEST')
      if (scope) {
        const current = await this.repository.open({ projectKey: scope.projectKey })
        if (!this.sessionLive(request.session, readSession) || !await this.grantedScopeLive()) return error('UNAUTHORIZED')
        if (!current.ok || current.value.status !== 'ready' || current.value.snapshot.project.revision !== scope.revision
          || current.value.snapshot.project.projectId !== scope.projectId) return error('STALE')
        return { ok: true, projects: [{ projectKey: scope.projectKey, projectId: safeWorldAiText(scope.projectId),
          name: safeWorldAiText(current.value.snapshot.project.name), revision: scope.revision, status: 'ready' }], total: 1, truncated: false }
      }
      const result = await this.repository.list()
      if (!this.sessionLive(request.session, readSession)) return error('UNAUTHORIZED')
      if (!result.ok) return error(result.error.code)
      return { ok: true, projects: result.value.projects.slice(0, 100).map((project) => ({
        projectKey: project.projectKey, status: project.status,
        ...('projectId' in project ? { projectId: safeWorldAiText(project.projectId), name: safeWorldAiText(project.name), revision: project.revision } : {}),
      })), total: result.value.projects.length, truncated: result.value.projects.length > 100 }
    }
    if (operation === 'open') {
      if (!exact(request, ['operation', 'session', 'projectKey']) || !isWorldProjectKey(request.projectKey)) return error('INVALID_REQUEST')
      if (scope && request.projectKey !== scope.projectKey) return error('UNAUTHORIZED')
      const result = await this.repository.open({ projectKey: request.projectKey })
      if (!this.sessionLive(request.session, readSession)) return error('UNAUTHORIZED')
      if (!result.ok) return error(result.error.code)
      if (result.value.status !== 'ready') return { ok: true, project: { projectKey: request.projectKey, status: 'unsupported' } }
      const project = result.value.snapshot.project
      if (scope && (project.revision !== scope.revision || project.projectId !== scope.projectId)) return error('STALE')
      return { ok: true, project: { projectKey: request.projectKey, status: 'ready', projectId: safeWorldAiText(project.projectId),
        name: safeWorldAiText(project.name), revision: project.revision,
        ...(!scope || project.startSceneId === scope.sceneId ? { startSceneId: safeWorldAiText(project.startSceneId) } : {}),
        sceneIds: scope ? [safeWorldAiText(scope.sceneId)] : project.scenes.slice(0, 100).map((scene) => safeWorldAiText(scene.id)), sceneCount: scope ? 1 : project.scenes.length } }
    }
    if (scope && (request.projectKey !== scope.projectKey || request.sceneId !== scope.sceneId) && operation === 'plan') return error('UNAUTHORIZED')
    if (operation === 'plan') return this.plan(request)
    if (scope && operation === 'query' && (request.kind === 'scenes' || request.kind === 'resources' || request.kind === 'project'
      || request.projectKey !== scope.projectKey || request.revision !== scope.revision
      || request.sceneId !== undefined && request.sceneId !== scope.sceneId)) return error('UNAUTHORIZED')
    if (operation === 'query') return this.query(request, readSession)
    if (operation === 'ack') return this.acknowledge(request)
    if (operation === 'propose') return this.propose(request)
    return error('UNSUPPORTED')
  }

  private sessionLive(token: unknown, expected: { sessionId: string; generation: number }): boolean {
    return typeof token === 'string' && this.session !== null && this.sessionId === expected.sessionId
      && this.generation === expected.generation && this.now() < this.sessionExpiresAt && secureEqual(token, this.session)
  }

  private async query(request: Record<string, unknown>, readSession: { sessionId: string; generation: number }): Promise<PublicResponse> {
    if (!exact(request, ['operation', 'session', 'projectKey', 'revision', 'kind'], ['sceneId', 'entityId', 'source', 'format', 'cursor', 'pageSize', 'planId'])
      || !isWorldProjectKey(request.projectKey) || !Number.isSafeInteger(request.revision) || (request.revision as number) < 0
      || !ALLOWED_KINDS.has(String(request.kind))) return error('INVALID_REQUEST')
    if (request.sceneId !== undefined && !isWorldCanonicalId(request.sceneId)) return error('INVALID_REQUEST')
    const plan = request.planId === undefined ? null : this.plans.get(String(request.planId))
    if (request.planId !== undefined && !plan) return error('INVALID_REQUEST')
    if (plan?.querying || plan?.pendingDelivery || plan?.proposing) return error('BUSY')
    if (plan) plan.querying = true
    try {
    if (request.planId !== undefined && (!plan || !await this.planLive(plan)
      || plan.context.projectKey !== request.projectKey || plan.context.baseRevision !== request.revision
      || (request.sceneId !== undefined && plan.context.activeSceneId !== request.sceneId))) return error('INVALID_REQUEST')
    if (!this.sessionLive(request.session, readSession)) return error('UNAUTHORIZED')
    const cursorScope = JSON.stringify([request.kind, request.entityId ?? null, request.source ?? null, request.format ?? null])
    this.prune()
    const cursor = request.cursor === undefined ? null : plan
      ? plan.cursors.get(String(request.cursor)) : this.readCursors.get(String(request.cursor))
    if (request.cursor !== undefined && (!cursor || cursor.scope !== cursorScope)) return error('INVALID_REQUEST')
    if (!plan && cursor && (cursor as ReadCursor).sessionId !== readSession.sessionId) return error('INVALID_REQUEST')
    if (!plan && cursor && (cursor as ReadCursor).generation !== readSession.generation) return error('INVALID_REQUEST')
    const query = { kind: request.kind, ...(request.entityId !== undefined ? { entityId: request.entityId } : {}),
      ...(request.source !== undefined ? { source: request.source } : {}), ...(request.format !== undefined ? { format: request.format } : {}),
      ...(request.cursor !== undefined ? { cursor: cursor?.canonical ?? request.cursor } : {}), ...(request.pageSize !== undefined ? { pageSize: request.pageSize } : {}) }
    try { parseWorldAiQueryRequest({ context: { schema: WORLD_AI_CONTEXT_SCHEMA, projectKey: request.projectKey,
      projectId: 'project:validation', baseRevision: request.revision, activeSceneId: 'scene:validation', editorEpoch: 0,
      originSessionId: 'validation', requestId: 'validation' }, query }) } catch { return error('INVALID_REQUEST') }
    const opened = await this.repository.open({ projectKey: request.projectKey })
    if (!this.sessionLive(request.session, readSession)) return error('UNAUTHORIZED')
    if (plan && !await this.planLive(plan)) return error('INVALID_REQUEST')
    if (!this.sessionLive(request.session, readSession)) return error('UNAUTHORIZED')
    if (!opened.ok) return error(opened.error.code)
    if (opened.value.status !== 'ready') return error('INVALID_REQUEST')
    const project = opened.value.snapshot.project
    if (project.revision !== request.revision) return error('INVALID_REQUEST')
    const sceneId = this.grantedScope?.sceneId ?? plan?.context.activeSceneId ?? request.sceneId ?? project.startSceneId
    if (typeof sceneId !== 'string' || !project.scenes.some((scene) => scene.id === sceneId)) return error('INVALID_REQUEST')
    if (!plan && cursor && ((cursor as ReadCursor).projectKey !== request.projectKey
      || (cursor as ReadCursor).revision !== request.revision || (cursor as ReadCursor).sceneId !== sceneId)) return error('INVALID_REQUEST')
    const filters = [request.projectKey, request.revision, sceneId, request.kind, request.entityId ?? null, request.source ?? null, request.format ?? null]
    const context = plan?.context ?? { schema: WORLD_AI_CONTEXT_SCHEMA, projectKey: request.projectKey, projectId: project.projectId,
      baseRevision: project.revision, activeSceneId: sceneId, editorEpoch: 0, originSessionId: this.sessionId!,
      requestId: createHash('sha256').update(JSON.stringify([this.sessionId, filters])).digest('hex').slice(0, 32) }
    try { parseWorldAiQueryRequest({ context, query }) } catch { return error('INVALID_REQUEST') }
    if (query.cursor !== undefined) {
      let cursor: unknown
      try { cursor = JSON.parse(query.cursor as string) } catch { return error('INVALID_REQUEST') }
      if (!Array.isArray(cursor) || cursor.length !== 2 || cursor[0] !== worldAiQueryScope(context, query as Parameters<typeof worldAiQueryScope>[1])
        || !Number.isSafeInteger(cursor[1]) || cursor[1] < 1) return error('INVALID_REQUEST')
    }
    const result = await (plan ? this.repository.queryAiForCli!({ context, query }) : this.repository.queryAi({ context, query }))
    if (!this.sessionLive(request.session, readSession)) return error('UNAUTHORIZED')
    if (plan && !await this.planLive(plan)) return error('INVALID_REQUEST')
    if (!this.sessionLive(request.session, readSession)) return error('UNAUTHORIZED')
    if (!result.ok) return error(result.error.code)
    if (result.value.kind !== request.kind || !Array.isArray(result.value.items) || result.value.items.length > 50
      || !Number.isSafeInteger(result.value.total) || result.value.total < 0) return error('INTERNAL_ERROR')
    if (result.value.nextCursor !== null) {
      let next: unknown
      try { next = JSON.parse(result.value.nextCursor) } catch { return error('INTERNAL_ERROR') }
      if (typeof result.value.nextCursor !== 'string' || result.value.nextCursor.length > 2048
        || !Array.isArray(next) || next.length !== 2 || next[0] !== worldAiQueryScope(context, query as Parameters<typeof worldAiQueryScope>[1])
        || !Number.isSafeInteger(next[1]) || next[1] < 1 || next[1] >= result.value.total) return error('INTERNAL_ERROR')
    }
    let publicCursor = result.value.nextCursor
    if (publicCursor !== null) {
      if ((plan ? plan.cursors : this.readCursors).size >= 256) return error('BUSY')
      const opaque = `cursor_${randomBytes(24).toString('hex')}`
      if (plan) plan.cursors.set(opaque, { scope: cursorScope, canonical: publicCursor })
      else this.readCursors.set(opaque, { scope: cursorScope, canonical: publicCursor,
        sessionId: readSession.sessionId, generation: readSession.generation, projectKey: request.projectKey,
        revision: request.revision as number, sceneId, expiresAt: Math.min(this.now() + PLAN_MS, this.sessionExpiresAt) })
      publicCursor = opaque
    }
    const response = { ok: true, page: { projectKey: request.projectKey, projectId: safeWorldAiText(project.projectId), revision: project.revision,
      kind: result.value.kind, items: result.value.items.map((item) => {
        const publicItem = projectItem(item)
        if (this.grantedScope && item.kind === 'project' && item.startSceneId !== this.grantedScope.sceneId) delete publicItem.startSceneId
        return publicItem
      }), total: result.value.total,
      nextCursor: publicCursor } }
    if (plan) {
      const deliveryId = `delivery_${randomBytes(24).toString('hex')}`
      plan.pendingDelivery = { id: deliveryId, page: result.value, claimed: false }
      return { ...response, deliveryId }
    }
    return response
    } finally { if (plan) plan.querying = false }
  }

  private send(socket: Socket, response: PublicResponse): void {
    let payload = Buffer.from(JSON.stringify(response))
    if (payload.length > MAX_RESPONSE_BYTES) payload = Buffer.from(JSON.stringify(error('INTERNAL_ERROR')))
    const length = Buffer.alloc(4); length.writeUInt32BE(payload.length)
    socket.end(Buffer.concat([length, payload]))
  }

  private async acknowledge(request: Record<string, unknown>): Promise<PublicResponse> {
    if (!exact(request, ['operation', 'session', 'projectKey', 'planId', 'deliveryId'])
      || !isWorldProjectKey(request.projectKey) || typeof request.planId !== 'string' || typeof request.deliveryId !== 'string') return error('INVALID_REQUEST')
    const plan = this.plans.get(request.planId)
    if (!plan || plan.context.projectKey !== request.projectKey || !await this.planLive(plan)) return error('INVALID_REQUEST')
    const pending = plan.pendingDelivery
    if (!pending || pending.id !== request.deliveryId || pending.claimed) return error('INVALID_REQUEST')
    pending.claimed = true
    try {
      await this.repository.recordCliAiObservation!(plan.context, pending.page)
      if (!await this.planLive(plan) || plan.pendingDelivery !== pending) return error('INVALID_REQUEST')
      plan.pendingDelivery = null
      return { ok: true }
    } catch { this.plans.delete(plan.id); return error('INVALID_REQUEST') }
  }

  private clearPlansAndProposals(): void {
    this.plans.clear()
    this.readCursors.clear()
    for (const proposal of [...this.proposals.values()]) void this.dropProposal(proposal)
    this.proposals.clear()
    this.directEditEntry = null
  }

  private prune(): void {
    for (const [id, cursor] of this.readCursors) if (this.now() >= cursor.expiresAt) this.readCursors.delete(id)
    for (const [id, plan] of this.plans) if (this.now() >= plan.expiresAt) this.plans.delete(id)
    for (const [, proposal] of this.proposals) if (this.now() >= proposal.expiresAt) {
      void this.dropProposal(proposal)
    }
  }

  private async planLive(plan: Plan): Promise<boolean> {
    this.prune()
    const trust = this.captureTrust?.()
    if (!trust || !sameTrust(trust, plan.trust) || !this.sessionId || this.sessionId !== plan.sessionId
      || this.generation !== plan.generation || this.now() >= this.sessionExpiresAt || this.plans.get(plan.id) !== plan) return false
    if (!await this.grantedScopeLive()) return false
    try {
      const canonical = await realpath(trust.workspaceRoot)
      const current = this.captureTrust?.()
      return canonical === plan.canonicalWorkspace && this.plans.get(plan.id) === plan && this.generation === plan.generation
        && this.sessionId === plan.sessionId && this.now() < Math.min(plan.expiresAt, this.sessionExpiresAt)
        && sameTrust(current, plan.trust)
    }
    catch { return false }
  }

  private async plan(request: Record<string, unknown>): Promise<PublicResponse> {
    if (!exact(request, ['operation', 'session', 'projectKey', 'sceneId']) || !isWorldProjectKey(request.projectKey)
      || !isWorldCanonicalId(request.sceneId) || !this.captureTrust || !this.sessionId) return error('INVALID_REQUEST')
    this.prune()
    if (this.plans.size >= MAX_PLANS) return error('BUSY')
    const trust = this.captureTrust()
    if (!trust) return error('UNAUTHORIZED')
    const generation = this.generation
    let canonicalWorkspace: string
    try { canonicalWorkspace = await realpath(trust.workspaceRoot) } catch { return error('INVALID_REQUEST') }
    if (generation !== this.generation || !sameTrust(this.captureTrust?.(), trust)) return error('INVALID_REQUEST')
    const opened = await this.repository.open({ projectKey: request.projectKey })
    if (generation !== this.generation || !sameTrust(this.captureTrust?.(), trust) || !this.sessionId || this.now() >= this.sessionExpiresAt
      || await realpath(trust.workspaceRoot).catch(() => null) !== canonicalWorkspace) return error('INVALID_REQUEST')
    if (!opened.ok) return error(opened.error.code)
    if (opened.value.status !== 'ready' || !opened.value.snapshot.project.scenes.some((scene) => scene.id === request.sceneId)) return error('INVALID_REQUEST')
    const project = opened.value.snapshot.project
    const id = `plan_${randomBytes(24).toString('hex')}`
    const context: WorldAiContext = { schema: WORLD_AI_CONTEXT_SCHEMA, projectKey: request.projectKey,
      projectId: project.projectId, baseRevision: project.revision, activeSceneId: request.sceneId,
      editorEpoch: 0, originSessionId: this.sessionId, requestId: randomBytes(16).toString('hex') }
    const entry: Plan = { id, context, sessionId: this.sessionId, generation, trust, canonicalWorkspace,
      expiresAt: Math.min(this.now() + PLAN_MS, this.sessionExpiresAt), proposing: false, querying: false, pendingDelivery: null, cursors: new Map() }
    this.prune()
    if (this.plans.size >= MAX_PLANS) return error('BUSY')
    this.plans.set(id, entry)
    return { ok: true, planId: id, projectKey: request.projectKey, revision: project.revision, sceneId: request.sceneId, expiresAt: entry.expiresAt }
  }

  private async propose(request: Record<string, unknown>): Promise<PublicResponse> {
    if (!exact(request, ['operation', 'session', 'projectKey', 'planId', 'json']) || !isWorldProjectKey(request.projectKey)
      || typeof request.planId !== 'string' || !this.repository.previewCliAi || !this.repository.discardAi) return error('INVALID_REQUEST')
    const plan = this.plans.get(request.planId)
    if (!plan || plan.proposing || plan.querying || plan.context.projectKey !== request.projectKey) return error('INVALID_REQUEST')
    plan.proposing = true
    try {
      if (!await this.planLive(plan) || plan.pendingDelivery) return error('INVALID_REQUEST')
      this.prune()
      if (this.proposals.size >= MAX_PROPOSALS) return error('BUSY')
      let proposal: WorldAiProposal
      try { proposal = parseWorldsCliRecipeJson(request.json, plan.context) } catch { return error('INVALID_REQUEST') }
      if (this.grantedScope && proposal.commands.some((command) => command.type === 'create-scene')) return error('UNAUTHORIZED')
      const opened = await this.repository.open({ projectKey: request.projectKey })
      if (!await this.planLive(plan)) return error('INVALID_REQUEST')
      if (!opened.ok || opened.value.status !== 'ready' || opened.value.snapshot.project.revision !== plan.context.baseRevision
        || opened.value.snapshot.project.projectId !== plan.context.projectId) return error('INVALID_REQUEST')
      const preview = await this.repository.previewCliAi(proposal)
      if (!await this.planLive(plan)) {
        if (preview.ok) void this.repository.discardAi({ context: plan.context, authority: preview.value.authority }).catch(() => {})
        return error('INVALID_REQUEST')
      }
      if (!preview.ok) return error('INVALID_REQUEST')
      const discardPreview = () => {
        void this.repository.discardAi!({ context: plan.context, authority: preview.value.authority }).catch(() => {})
      }
      let batch: WorldCommandBatchV1 | null = null
      try {
        const previewBatch = preview.value.batch
        const parsed = parseWorldCommandBatch(previewBatch)
        if (parsed.success
          && parsed.value.transactionId === plan.context.requestId
          && parsed.value.projectId === plan.context.projectId
          && parsed.value.baseRevision === plan.context.baseRevision
          && parsed.value.origin === 'ai'
          && canonicalWorldCommandBatchPayload(previewBatch) === canonicalWorldCommandBatchPayload(parsed.value)) {
          batch = freezeDeep(structuredClone(parsed.value))
        }
      } catch { /* Treat hostile or non-cloneable repository output as an invalid preview. */ }
      if (!batch || !preview.value.review.complete) {
        discardPreview()
        return error('INVALID_REQUEST')
      }
      if (!this.projectReview(preview.value.review) || !/^[a-f0-9]{64}$/.test(preview.value.candidateSnapshotSha256)) {
        discardPreview()
        return error('INVALID_REQUEST')
      }
      const verified = await this.repository.open({ projectKey: request.projectKey })
      if (!await this.planLive(plan) || !verified.ok || verified.value.status !== 'ready'
        || verified.value.snapshot.project.revision !== plan.context.baseRevision
        || verified.value.snapshot.project.projectId !== plan.context.projectId) {
        discardPreview()
        return error('INVALID_REQUEST')
      }
      this.prune()
      if (this.proposals.size >= MAX_PROPOSALS) {
        discardPreview()
        return error('BUSY')
      }
      const digest = createHash('sha256').update(canonicalWorldCommandBatchPayload(batch)).digest('hex')
      const id = `proposal_${randomBytes(24).toString('hex')}`
      const expiresAt = Math.min(this.now() + PROPOSAL_MS, plan.expiresAt, this.sessionExpiresAt)
      const context = freezeDeep(structuredClone(plan.context))
      const entry: PendingProposal = { id, planId: plan.id, context, sessionId: plan.sessionId,
        generation: plan.generation, trust: plan.trust, canonicalWorkspace: plan.canonicalWorkspace, expiresAt,
        digest, batch, snapshot: freezeDeep(structuredClone(preview.value.snapshot)),
        candidateSnapshotSha256: preview.value.candidateSnapshotSha256,
        review: freezeDeep(structuredClone(preview.value.review)), authority: preview.value.authority, state: 'pending', revoked: false }
      this.proposals.set(id, entry)
      this.plans.delete(plan.id)
      const receipt = Object.freeze({ ok: true as const, proposalId: id, projectKey: plan.context.projectKey,
        revision: plan.context.baseRevision, digest, expiresAt, commandCount: batch.commands.length,
        changeCount: entry.review.changes.length })
      if (!this.dispatchDirectEditProposal) return { ...receipt, status: 'pending-human-review' }
      if (this.proposals.get(id) !== entry || entry.state !== 'pending' || entry.revoked
        || entry.context !== context || entry.batch !== batch || entry.planId !== plan.id) {
        await this.dropProposal(entry)
        return error('STALE')
      }
      let dispatched: WorldsCliReply<{ editIntent: string; expiresAt: number }>
      try { dispatched = await this.dispatchDirectEditProposal(id) }
      catch { dispatched = { ok: false, code: 'UNAVAILABLE' } }
      if (!dispatched.ok || typeof dispatched.editIntent !== 'string' || !/^edit_[a-f0-9]{48}$/.test(dispatched.editIntent)
        || !Number.isSafeInteger(dispatched.expiresAt) || dispatched.expiresAt <= 0) {
        await this.dropProposal(entry)
        return error(dispatched.ok ? 'UNAVAILABLE' : dispatched.code)
      }
      return { ...receipt, status: 'direct-edit-dispatched' }
    } finally { plan.proposing = false }
  }
}

function error(code: string): PublicResponse {
  const safe = /^(?:UNAUTHORIZED|INVALID_REQUEST|UNSUPPORTED|INTERNAL_ERROR|UNAVAILABLE|USER_DECLINED|BUSY|STALE|NOT_FOUND)$/.test(code)
    || (WORLD_PROJECT_PUBLIC_ERROR_CODES as readonly string[]).includes(code)
  return { ok: false, code: safe ? code : 'INTERNAL_ERROR' }
}
function exact(record: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => allowed.has(key))
}
function secureEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{1,64}$/.test(left) || left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left), Buffer.from(right))
}
function isBoundedRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const pending: Array<[unknown, number]> = [[value, 0]]
  let count = 0
  while (pending.length) {
    const [current, depth] = pending.pop()!
    if (++count > 1024 || depth > 16) return false
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false
        pending.push([child, depth + 1])
      }
    }
  }
  return true
}
function projectItem(item: WorldAiQueryPage['items'][number]): Record<string, unknown> {
  switch (item.kind) {
    case 'project': return { kind: item.kind, id: safeWorldAiText(item.id), name: safeWorldAiText(item.name), revision: item.revision,
      startSceneId: safeWorldAiText(item.startSceneId), sceneCount: item.sceneCount, resourceCount: item.resourceCount }
    case 'scene': return { kind: item.kind, id: safeWorldAiText(item.id), name: safeWorldAiText(item.name), isActive: item.isActive,
      isStart: item.isStart, entityCount: item.entityCount }
    case 'entity': return { kind: item.kind, id: safeWorldAiText(item.id), name: safeWorldAiText(item.name), parentId: item.parentId === null ? null : safeWorldAiText(item.parentId),
      enabled: item.enabled, locked: item.locked, transform: safeValue(item.transform), componentCount: item.componentCount }
    case 'component': return { kind: item.kind, id: safeWorldAiText(item.id), entityId: safeWorldAiText(item.entityId), type: item.type, enabled: item.enabled,
      ...(item.current ? { current: safeValue(item.current) } : {}) }
    case 'resource': return { kind: item.kind, id: safeWorldAiText(item.id), name: safeWorldAiText(item.name), source: item.source,
      format: item.format, capability: item.capability, fingerprint: item.fingerprint, dependencyCount: item.dependencyCount }
  }
}
function safeValue(value: unknown): unknown {
  if (typeof value === 'string') return safeWorldAiText(value)
  if (Array.isArray(value)) return value.map(safeValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/(path|snapshot|document|url|uri|resourceId)/i.test(key))
    .map(([key, child]) => [key, safeValue(child)]))
  return value
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}
function sameTrust(left: Trust | null | undefined, right: Trust): boolean {
  return !!left && left.window === right.window && left.contents === right.contents && left.frame === right.frame
    && left.documentUrl === right.documentUrl && left.documentEpoch === right.documentEpoch && left.workspaceRoot === right.workspaceRoot
}
