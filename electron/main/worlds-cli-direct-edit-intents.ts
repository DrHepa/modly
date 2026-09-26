import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'

/**
 * Main-only, in-memory custody for a future scoped direct-edit route. This module does
 * not expose a UDS operation or mutate a project. The host must supply a synchronously
 * invalidated, trusted editor lease; a cached UDS or renderer claim is not sufficient.
 */
export type WorldsCliDirectEditScope = Readonly<{
  sessionId: string
  generation: number
  sessionExpiresAt: number
  window: object
  contents: object
  frame: object
  documentUrl: string
  documentEpoch: number
  workspaceRoot: string
  canonicalWorkspace: string
  projectKey: string
  projectId: string
  sceneId: string
  editorEpoch: number
  revision: number
  mode: 'edit' | 'loading' | 'playing' | 'paused' | 'stopping'
}>

export type WorldsCliDirectEditProposal = Readonly<{
  proposalId: string
  transactionId: string
  digest: string
  beforeSnapshotSha256: string
  candidateSnapshotSha256: string
  expiresAt: number
  scope: WorldsCliDirectEditScope
}>

type FailureCode = 'STALE' | 'AMBIGUOUS' | 'BUSY' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'UNAVAILABLE'
type Failure = { ok: false; code: FailureCode }
type TerminalStatus = 'STALE' | 'AMBIGUOUS' | 'APPLIED'
type SettleResult = { ok: true; status: 'APPLIED' } | Extract<Failure, { ok: false }>

export type WorldsCliDirectEditClaim = Readonly<{
  transactionId: string
  proposal: Readonly<Omit<WorldsCliDirectEditProposal, 'scope' | 'expiresAt'>>
  beforeJournal(): { ok: true } | Failure
  abort(): Failure
  /** Main must call only after a journal receipt, reopened hash, and mounted editor adoption ACK. */
  applied(receipt: { transactionId: string; projectId: string; newRevision: number;
    snapshotSha256: string; editorAdopted: boolean }): SettleResult
}>

type Intent = {
  id: string
  transactionId: string
  proposal: WorldsCliDirectEditClaim['proposal']
  scope: WorldsCliDirectEditScope
  deadline: number
  terminalExpiresAt: number | null
  state: 'issued' | 'claimed' | 'journaled' | TerminalStatus
}

const MAX_TRANSACTIONS_PER_SESSION = 8
const INTENT_MS = 120_000
const TERMINAL_MS = 120_000
const HASH = /^[a-f0-9]{64}$/
const TRANSACTION_ID = /^[a-f0-9]{32}$/
const PROPOSAL_ID = /^proposal_[a-f0-9]{48}$/
const INTENT_ID = /^edit_[a-f0-9]{48}$/

function sameScope(current: WorldsCliDirectEditScope | null, bound: WorldsCliDirectEditScope, revision = bound.revision): boolean {
  return current !== null && current.sessionId === bound.sessionId && current.generation === bound.generation
    && current.sessionExpiresAt === bound.sessionExpiresAt && current.window === bound.window
    && current.contents === bound.contents && current.frame === bound.frame
    && current.documentUrl === bound.documentUrl && current.documentEpoch === bound.documentEpoch
    && current.workspaceRoot === bound.workspaceRoot && current.canonicalWorkspace === bound.canonicalWorkspace
    && current.projectKey === bound.projectKey && current.projectId === bound.projectId
    && current.sceneId === bound.sceneId && current.editorEpoch === bound.editorEpoch
    && current.revision === revision && current.mode === 'edit'
}

function copyScope(value: WorldsCliDirectEditScope | null | undefined): WorldsCliDirectEditScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    return Object.freeze({
      sessionId: value.sessionId, generation: value.generation, sessionExpiresAt: value.sessionExpiresAt,
      window: value.window, contents: value.contents, frame: value.frame,
      documentUrl: value.documentUrl, documentEpoch: value.documentEpoch,
      workspaceRoot: value.workspaceRoot, canonicalWorkspace: value.canonicalWorkspace,
      projectKey: value.projectKey, projectId: value.projectId, sceneId: value.sceneId,
      editorEpoch: value.editorEpoch, revision: value.revision, mode: value.mode,
    })
  } catch { return null }
}

function isIdentityObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false
  try { return !Array.isArray(value) } catch { return false }
}

function validScope(scope: WorldsCliDirectEditScope, now: number): boolean {
  return typeof scope.sessionId === 'string' && /^[a-f0-9-]{1,64}$/.test(scope.sessionId)
    && Number.isSafeInteger(scope.generation) && scope.generation >= 0
    && Number.isSafeInteger(scope.sessionExpiresAt) && scope.sessionExpiresAt > now
    && isIdentityObject(scope.window) && isIdentityObject(scope.contents) && isIdentityObject(scope.frame)
    && typeof scope.documentUrl === 'string' && scope.documentUrl.length > 0 && scope.documentUrl.length <= 2048
    && Number.isSafeInteger(scope.documentEpoch) && scope.documentEpoch >= 0
    && typeof scope.workspaceRoot === 'string' && isAbsolute(scope.workspaceRoot)
    && typeof scope.canonicalWorkspace === 'string' && isAbsolute(scope.canonicalWorkspace)
    && typeof scope.projectKey === 'string' && /^world-[a-f0-9]{32}$/.test(scope.projectKey)
    && typeof scope.projectId === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9:_-]{1,240}$/.test(scope.projectId)
    && typeof scope.sceneId === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9:_-]{1,240}$/.test(scope.sceneId)
    && Number.isSafeInteger(scope.editorEpoch) && scope.editorEpoch >= 0
    && Number.isSafeInteger(scope.revision) && scope.revision >= 0
    && scope.revision < Number.MAX_SAFE_INTEGER && scope.mode === 'edit'
}

export class WorldsCliDirectEditIntentLedger {
  private readonly intents = new Map<string, Intent>()
  private readonly proposalIds = new Set<string>()
  private readonly transactionIds = new Set<string>()
  private budgetSession: { id: string; generation: number } | null = null
  private closed = false
  private readonly options: { currentScope(): WorldsCliDirectEditScope | null; now?: () => number }

  constructor(options: { currentScope(): WorldsCliDirectEditScope | null; now?: () => number }) { this.options = options }

  private now(): number { return (this.options.now ?? Date.now)() }

  private liveScope(): WorldsCliDirectEditScope | null {
    try { return copyScope(this.options.currentScope()) } catch { return null }
  }

  private prune(now: number): void {
    for (const [id, intent] of this.intents) {
      if (intent.terminalExpiresAt !== null) {
        if (now >= intent.terminalExpiresAt) this.intents.delete(id)
      } else if (now >= intent.deadline) {
        this.settle(intent, intent.state === 'journaled' ? 'AMBIGUOUS' : 'STALE')
        if (intent.terminalExpiresAt !== null && now >= intent.terminalExpiresAt) this.intents.delete(id)
      }
    }
  }

  /** Trusted Main only: the passed proposal is copied, not retained by reference. */
  issue(source: WorldsCliDirectEditProposal): { ok: true; intentId: string; expiresAt: number } | Failure {
    if (this.closed) return { ok: false, code: 'UNAVAILABLE' }
    const now = this.now()
    this.prune(now)
    let scope: WorldsCliDirectEditScope | null
    let proposal: WorldsCliDirectEditClaim['proposal']
    let sourceExpiresAt: number
    try {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return { ok: false, code: 'INVALID_REQUEST' }
      scope = copyScope(source.scope)
      proposal = Object.freeze({ proposalId: source.proposalId, transactionId: source.transactionId, digest: source.digest,
        beforeSnapshotSha256: source.beforeSnapshotSha256, candidateSnapshotSha256: source.candidateSnapshotSha256 })
      sourceExpiresAt = source.expiresAt
    } catch { return { ok: false, code: 'INVALID_REQUEST' } }
    if (!scope || !validScope(scope, now) || typeof proposal.proposalId !== 'string' || !PROPOSAL_ID.test(proposal.proposalId)
      || typeof proposal.transactionId !== 'string' || !TRANSACTION_ID.test(proposal.transactionId)
      || typeof proposal.digest !== 'string' || !HASH.test(proposal.digest)
      || typeof proposal.beforeSnapshotSha256 !== 'string' || !HASH.test(proposal.beforeSnapshotSha256)
      || typeof proposal.candidateSnapshotSha256 !== 'string' || !HASH.test(proposal.candidateSnapshotSha256)
      || !Number.isSafeInteger(sourceExpiresAt) || sourceExpiresAt <= now) return { ok: false, code: 'INVALID_REQUEST' }
    if (!sameScope(this.liveScope(), scope)) return { ok: false, code: 'STALE' }
    if (!this.budgetSession || this.budgetSession.id !== scope.sessionId || this.budgetSession.generation !== scope.generation) {
      this.intents.clear()
      this.proposalIds.clear()
      this.transactionIds.clear()
      this.budgetSession = { id: scope.sessionId, generation: scope.generation }
    }
    if (this.proposalIds.has(proposal.proposalId) || this.transactionIds.has(proposal.transactionId)) {
      return { ok: false, code: 'STALE' }
    }
    if (this.proposalIds.size >= MAX_TRANSACTIONS_PER_SESSION) return { ok: false, code: 'BUSY' }
    const expiresAt = Math.min(now + INTENT_MS, sourceExpiresAt, scope.sessionExpiresAt)
    const id = `edit_${randomBytes(24).toString('hex')}`
    this.intents.set(id, { id, transactionId: proposal.transactionId,
      proposal, scope, deadline: expiresAt, terminalExpiresAt: null, state: 'issued' })
    this.proposalIds.add(proposal.proposalId)
    this.transactionIds.add(proposal.transactionId)
    return { ok: true, intentId: id, expiresAt }
  }

  /** Claim is single-use, including when the caller loses its response. */
  claim(intentId: string): { ok: true; claim: WorldsCliDirectEditClaim } | Failure {
    if (this.closed) return { ok: false, code: 'UNAVAILABLE' }
    if (typeof intentId !== 'string' || !INTENT_ID.test(intentId)) return { ok: false, code: 'INVALID_REQUEST' }
    const now = this.now()
    const intent = this.intents.get(intentId)
    if (!intent) return { ok: false, code: 'NOT_FOUND' }
    if (intent.state !== 'issued') return { ok: false,
      code: intent.state === 'journaled' || intent.state === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'STALE' }
    if (now >= intent.deadline || !sameScope(this.liveScope(), intent.scope)) {
      this.settle(intent, 'STALE')
      return { ok: false, code: 'STALE' }
    }
    intent.state = 'claimed'
    return { ok: true, claim: Object.freeze({
      transactionId: intent.transactionId,
      proposal: intent.proposal,
      beforeJournal: () => this.beforeJournal(intent),
      abort: () => this.abort(intent),
      applied: (receipt: Parameters<WorldsCliDirectEditClaim['applied']>[0]) => this.applied(intent, receipt),
    }) }
  }

  private active(intent: Intent): boolean {
    return !this.closed && this.intents.get(intent.id) === intent && this.now() < intent.deadline
  }

  private settle(intent: Intent, status: TerminalStatus): void {
    if (this.intents.get(intent.id) !== intent || intent.terminalExpiresAt !== null) return
    intent.state = status
    intent.terminalExpiresAt = Math.min(this.now() + TERMINAL_MS, intent.scope.sessionExpiresAt)
  }

  private beforeJournal(intent: Intent): { ok: true } | Failure {
    if (!this.active(intent) || intent.state !== 'claimed' || !sameScope(this.liveScope(), intent.scope)) {
      const code = intent.state === 'journaled' ? 'AMBIGUOUS' : 'STALE'
      this.settle(intent, code)
      return { ok: false, code }
    }
    intent.state = 'journaled'
    return { ok: true }
  }

  private abort(intent: Intent): Failure {
    if (intent.state === 'APPLIED') return { ok: false, code: 'STALE' }
    const code = intent.state === 'journaled' || intent.state === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'STALE'
    this.settle(intent, code)
    return { ok: false, code }
  }

  private applied(intent: Intent, receipt: Parameters<WorldsCliDirectEditClaim['applied']>[0]): SettleResult {
    if (!this.active(intent) || intent.state !== 'journaled') {
      const code = intent.state === 'journaled' ? 'AMBIGUOUS' : 'STALE'
      this.settle(intent, code)
      return { ok: false, code }
    }
    if (!receipt || receipt.transactionId !== intent.transactionId || receipt.projectId !== intent.scope.projectId
      || receipt.newRevision !== intent.scope.revision + 1 || receipt.snapshotSha256 !== intent.proposal.candidateSnapshotSha256
      || receipt.editorAdopted !== true || !sameScope(this.liveScope(), intent.scope, receipt.newRevision)) {
      this.settle(intent, 'AMBIGUOUS')
      return { ok: false, code: 'AMBIGUOUS' }
    }
    this.settle(intent, 'APPLIED')
    return { ok: true, status: 'APPLIED' }
  }

  /** Read-only, redacted terminal result; foreign sessions and documents see NOT_FOUND. */
  lookup(intentId: string): { ok: true; status: TerminalStatus } | Failure {
    if (this.closed || typeof intentId !== 'string' || !INTENT_ID.test(intentId)) return { ok: false, code: 'NOT_FOUND' }
    const now = this.now()
    this.prune(now)
    const intent = this.intents.get(intentId)
    if (!intent) return { ok: false, code: 'NOT_FOUND' }
    const scope = this.liveScope()
    if (!scope || now >= scope.sessionExpiresAt || !sameScope(scope, intent.scope, scope.revision)) return { ok: false, code: 'NOT_FOUND' }
    if (intent.state === 'issued' || intent.state === 'claimed' || intent.state === 'journaled') return { ok: false, code: 'BUSY' }
    return { ok: true, status: intent.state }
  }

  shutdown(): void {
    this.closed = true
    this.intents.clear()
    this.proposalIds.clear()
    this.transactionIds.clear()
    this.budgetSession = null
  }
}
