import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'

import type { WorldProjectOpenResult } from '../../src/shared/types/worldProjects.ts'
import { canonicalWorldProjectSnapshotPayload } from '../../src/areas/worlds/core/worldSnapshotDigest.ts'
import {
  WorldsCliDirectEditIntentLedger,
  type WorldsCliDirectEditClaim,
  type WorldsCliDirectEditScope,
} from './worlds-cli-direct-edit-intents.ts'
import type { WorldsCliDirectEditCommitReceipt, WorldsCliDirectEditReservation } from './worlds-cli-transport.ts'
import {
  getMainWindowDocumentEpoch,
  isTrustedWorldsCliSender,
  type WorldsCliWindowLike,
} from './worlds-cli-window-trust.ts'
import type { WorldsCliReadinessRefusal, WorldsCliReadinessResult } from './worlds-cli-readiness-broker.ts'

type Handler = (event: unknown, value: unknown) => Promise<unknown>
type FailureCode = 'STALE' | 'AMBIGUOUS' | 'BUSY' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'UNAVAILABLE'
type Failure = { ok: false; code: FailureCode }
type TerminalStatus = 'STALE' | 'AMBIGUOUS' | 'APPLIED'
type BrokerPhase = 'preflight' | 'awaiting_readiness' | 'awaiting_commit' | 'committing' | 'awaiting_adoption' | 'terminal'

type EventTargetLike = {
  on?(name: string, listener: (...args: unknown[]) => void): void
  off?(name: string, listener: (...args: unknown[]) => void): void
}

type BrokerWindow = WorldsCliWindowLike & EventTargetLike & {
  webContents: WorldsCliWindowLike['webContents'] & EventTargetLike & {
    send(channel: string, payload: unknown): void
  }
}

type DirectEditRequest = Readonly<{
  nonce: string
  editIntent: string
  projectKey: string
  projectId: string
  sceneId: string
  baseRevision: number
  editorEpoch: number
  expiresAt: number
}>

type TerminalRecord = Readonly<{
  editIntent: string
  nonce: string
  status: TerminalStatus
  scope: WorldsCliDirectEditScope
  expiresAt: number
}>

type ActiveRecord = {
  reservation: WorldsCliDirectEditReservation
  claim: WorldsCliDirectEditClaim | null
  editIntent: string
  nonce: string
  window: BrokerWindow
  contents: BrokerWindow['webContents']
  frame: object
  documentUrl: string
  documentEpoch: number
  deadline: number
  phase: BrokerPhase
  journaled: boolean
  tombstoned: boolean
  adoptionStarted: boolean
  localScope: WorldsCliDirectEditScope
  receipt: WorldsCliDirectEditCommitReceipt | null
  timer: ReturnType<typeof setTimeout> | null
  cleanupListeners(): void
  cleanupPromise: Promise<void> | null
  terminalStatus: TerminalStatus | null
}

export type WorldsCliDirectEditBroker = Readonly<{
  execute(reservation: WorldsCliDirectEditReservation): Promise<
    { ok: true; editIntent: string; expiresAt: number } | Failure>
  cancelActive(reason: string): TerminalStatus | null
  lookup(editIntent: string): { ok: true; status: TerminalStatus } | Failure
  shutdown(): Promise<void>
}>

type BrokerOptions = {
  getWindow(): BrokerWindow | null
  trustedRendererUrl: string
  getWorkspaceRoot(): string
  readiness: { request(scope: { projectKey: string; projectId: string; sceneId: string; revision: number; editorEpoch: number }): Promise<WorldsCliReadinessResult> }
  repository: { open(request: { projectKey: string }): Promise<WorldProjectOpenResult> }
  now?: () => number
  timeoutMs?: number
  terminalLimit?: number
}

const HASH = /^[a-f0-9]{64}$/
const NONCE = /^[a-f0-9]{48}$/
const EDIT_INTENT = /^edit_[a-f0-9]{48}$/
const TRANSACTION_ID = /^[a-f0-9]{32}$/
const TERMINAL_MS = 120_000
const DEFAULT_TERMINAL_LIMIT = 32

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  try { return Object.keys(record).sort().join(',') === [...expected].sort().join(',') } catch { return false }
}

function isCommitPayload(value: unknown): value is { nonce: string; editIntent: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    return exactKeys(record, ['nonce', 'editIntent'])
      && typeof record.nonce === 'string' && NONCE.test(record.nonce)
      && typeof record.editIntent === 'string' && EDIT_INTENT.test(record.editIntent)
  } catch { return false }
}

function isCancelPayload(value: unknown): value is { nonce: string; editIntent: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    return exactKeys(record, ['nonce', 'editIntent'])
      && typeof record.nonce === 'string' && NONCE.test(record.nonce)
      && typeof record.editIntent === 'string' && EDIT_INTENT.test(record.editIntent)
  } catch { return false }
}

function isAdoptPayload(value: unknown): value is {
  nonce: string; editIntent: string; transactionId: string; newRevision: number; snapshotSha256: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    return exactKeys(record, ['nonce', 'editIntent', 'transactionId', 'newRevision', 'snapshotSha256'])
      && typeof record.nonce === 'string' && NONCE.test(record.nonce)
      && typeof record.editIntent === 'string' && EDIT_INTENT.test(record.editIntent)
      && typeof record.transactionId === 'string' && TRANSACTION_ID.test(record.transactionId)
      && Number.isSafeInteger(record.newRevision) && (record.newRevision as number) >= 1
      && typeof record.snapshotSha256 === 'string' && HASH.test(record.snapshotSha256)
  } catch { return false }
}

function responseCode(status: TerminalStatus): 'STALE' | 'AMBIGUOUS' {
  return status === 'STALE' ? 'STALE' : 'AMBIGUOUS'
}

/**
 * Main-only direct-edit protocol broker. execute() accepts custody from the
 * paired proposal dispatcher; renderer completion remains independently verified.
 */
export function registerWorldsCliDirectEditBroker(
  ipc: { handle(channel: string, handler: Handler): void },
  options: BrokerOptions,
): WorldsCliDirectEditBroker {
  const now = options.now ?? Date.now
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? options.timeoutMs! : 120_000
  const terminalLimit = Number.isSafeInteger(options.terminalLimit) && (options.terminalLimit ?? 0) > 0
    ? Math.min(options.terminalLimit!, 64) : DEFAULT_TERMINAL_LIMIT
  let active: ActiveRecord | null = null
  let lastScope: WorldsCliDirectEditScope | null = null
  let lookupAllowed = true
  let closed = false
  const terminal = new Map<string, TerminalRecord>()
  const ledger = new WorldsCliDirectEditIntentLedger({
    now,
    currentScope: () => active?.localScope ?? lastScope,
  })

  const scopeVisible = (scope: WorldsCliDirectEditScope): boolean => {
    if (now() >= scope.sessionExpiresAt) return false
    const window = options.getWindow()
    if (window !== scope.window || window?.webContents !== scope.contents
      || window.webContents.mainFrame !== scope.frame || window.webContents.getURL() !== scope.documentUrl
      || getMainWindowDocumentEpoch(window.webContents) !== scope.documentEpoch
      || !isTrustedWorldsCliSender({ sender: scope.contents, senderFrame: scope.frame }, window, scope.documentUrl)) return false
    try {
      return options.getWorkspaceRoot() === scope.workspaceRoot
        && realpathSync(scope.workspaceRoot) === scope.canonicalWorkspace
    } catch { return false }
  }

  const liveEnvironment = (entry: ActiveRecord, revision = entry.localScope.revision): boolean => {
    if (closed || active !== entry || entry.tombstoned || now() >= entry.deadline
      || !scopeVisible(entry.localScope)) return false
    try {
      return entry.localScope.sessionId === entry.reservation.source.scope.sessionId
        && entry.localScope.generation === entry.reservation.source.scope.generation
        && entry.localScope.sessionExpiresAt === entry.reservation.source.scope.sessionExpiresAt
        && entry.localScope.projectKey === entry.reservation.source.scope.projectKey
        && entry.localScope.projectId === entry.reservation.source.scope.projectId
        && entry.localScope.sceneId === entry.reservation.source.scope.sceneId
        && entry.localScope.editorEpoch === entry.reservation.source.scope.editorEpoch
        && entry.localScope.revision === revision && entry.localScope.mode === 'edit'
    } catch { return false }
  }

  const pruneTerminal = (): void => {
    const time = now()
    for (const [id, record] of terminal) if (time >= record.expiresAt) terminal.delete(id)
    while (terminal.size > terminalLimit) terminal.delete(terminal.keys().next().value as string)
  }

  const retainTerminal = (entry: ActiveRecord): void => {
    if (!entry.terminalStatus || !entry.editIntent) return
    terminal.set(entry.editIntent, Object.freeze({
      editIntent: entry.editIntent,
      nonce: entry.nonce,
      status: entry.terminalStatus,
      scope: entry.localScope,
      expiresAt: Math.min(now() + TERMINAL_MS, entry.localScope.sessionExpiresAt),
    }))
    pruneTerminal()
  }

  const startCleanup = (entry: ActiveRecord): Promise<void> => {
    if (entry.cleanupPromise) return entry.cleanupPromise
    entry.cleanupPromise = (async () => {
      try { await entry.reservation.finish() } catch { /* Custody is already tombstoned. */ }
      finally {
        if (active === entry) active = null
        retainTerminal(entry)
      }
    })()
    return entry.cleanupPromise
  }

  const tombstone = (entry: ActiveRecord, requested: 'STALE' | 'AMBIGUOUS'): TerminalStatus => {
    if (entry.tombstoned) return entry.terminalStatus ?? requested
    entry.tombstoned = true
    entry.phase = 'terminal'
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    entry.cleanupListeners()
    let settled: ReturnType<WorldsCliDirectEditClaim['abort']> | null = null
    try { settled = entry.claim?.abort() ?? null } catch { settled = null }
    entry.terminalStatus = requested === 'AMBIGUOUS' || entry.journaled || settled?.code === 'AMBIGUOUS'
      ? 'AMBIGUOUS' : 'STALE'
    void startCleanup(entry)
    return entry.terminalStatus
  }

  const settleApplied = (entry: ActiveRecord): void => {
    entry.tombstoned = true
    entry.phase = 'terminal'
    entry.terminalStatus = 'APPLIED'
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    entry.cleanupListeners()
    void startCleanup(entry)
  }

  const assertLive = (entry: ActiveRecord, phases: readonly BrokerPhase[]): void => {
    if (!phases.includes(entry.phase) || !liveEnvironment(entry)) {
      tombstone(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE')
      throw new Error('Direct-edit scope is stale')
    }
  }

  const trustedEvent = (entry: ActiveRecord, event: unknown): boolean => {
    return liveEnvironment(entry)
      && isTrustedWorldsCliSender(event, entry.window, entry.documentUrl)
      && (event as { sender?: unknown; senderFrame?: unknown }).sender === entry.contents
      && (event as { sender?: unknown; senderFrame?: unknown }).senderFrame === entry.frame
  }

  const terminalFailure = async (entry: ActiveRecord, requested: 'STALE' | 'AMBIGUOUS'): Promise<Failure> => {
    const status = tombstone(entry, requested)
    await startCleanup(entry)
    return { ok: false, code: responseCode(status) }
  }

  const activeFor = (editIntent: string): ActiveRecord | null => (
    active && active.editIntent === editIntent ? active : null
  )

  const terminalScopeVisible = (record: TerminalRecord): boolean => {
    return lookupAllowed && !closed && !!lastScope && now() < record.expiresAt
      && record.scope.sessionId === lastScope.sessionId && record.scope.generation === lastScope.generation
      && record.scope.window === lastScope.window && record.scope.contents === lastScope.contents
      && record.scope.frame === lastScope.frame && record.scope.documentEpoch === lastScope.documentEpoch
      && record.scope.workspaceRoot === lastScope.workspaceRoot
      && record.scope.canonicalWorkspace === lastScope.canonicalWorkspace
      && record.scope.projectKey === lastScope.projectKey && record.scope.projectId === lastScope.projectId
      && record.scope.sceneId === lastScope.sceneId && record.scope.editorEpoch === lastScope.editorEpoch
      && scopeVisible(record.scope)
  }

  const terminalForIpc = (editIntent: string, nonce: string, event: unknown): TerminalRecord | null => {
    pruneTerminal()
    const record = terminal.get(editIntent)
    if (!record || record.nonce !== nonce || !terminalScopeVisible(record)) return null
    return isTrustedWorldsCliSender(event, record.scope.window as BrokerWindow, record.scope.documentUrl)
      && (event as { sender?: unknown; senderFrame?: unknown }).sender === record.scope.contents
      && (event as { sender?: unknown; senderFrame?: unknown }).senderFrame === record.scope.frame
      ? record : null
  }

  ipc.handle('workspace:worlds:cli:directEditCommit', async (event, value) => {
    if (!isCommitPayload(value)) return { ok: false, code: 'INVALID_REQUEST' }
    const entry = activeFor(value.editIntent)
    if (!entry) {
      const known = terminalForIpc(value.editIntent, value.nonce, event)
      return known ? { ok: false, code: responseCode(known.status) } : { ok: false, code: 'NOT_FOUND' }
    }
    if (value.nonce !== entry.nonce || !trustedEvent(entry, event)) {
      return terminalFailure(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE')
    }
    if (entry.phase !== 'awaiting_commit') return terminalFailure(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE')
    entry.phase = 'committing'
    let committed: Awaited<ReturnType<WorldsCliDirectEditReservation['commit']>>
    try {
      committed = await entry.reservation.commit({
        assertLive: () => assertLive(entry, ['committing']),
        onJournalStart: () => {
          assertLive(entry, ['committing'])
          if (entry.journaled || !entry.claim) throw new Error('Journal boundary already consumed')
          const result = entry.claim.beforeJournal()
          if (!result.ok) {
            tombstone(entry, result.code === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'STALE')
            throw new Error('Ledger journal boundary rejected')
          }
          entry.journaled = true
        },
      })
    } catch {
      return terminalFailure(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE')
    }
    if (entry.tombstoned) return { ok: false, code: responseCode(entry.terminalStatus ?? (entry.journaled ? 'AMBIGUOUS' : 'STALE')) }
    if (!committed.ok) return terminalFailure(entry,
      entry.journaled || committed.code === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'STALE')
    const receipt = committed.receipt
    const source = entry.reservation.source
    if (receipt.transactionId !== source.transactionId || receipt.projectId !== source.scope.projectId
      || receipt.newRevision !== source.scope.revision + 1 || receipt.snapshotSha256 !== source.candidateSnapshotSha256) {
      return terminalFailure(entry, 'AMBIGUOUS')
    }
    try {
      assertLive(entry, ['committing'])
      const verified = await entry.reservation.verifyDisk(receipt)
      if (entry.tombstoned) return { ok: false, code: responseCode(entry.terminalStatus ?? 'AMBIGUOUS') }
      assertLive(entry, ['committing'])
      if (!verified.ok) return terminalFailure(entry, 'AMBIGUOUS')
    } catch { return terminalFailure(entry, 'AMBIGUOUS') }
    entry.receipt = receipt
    entry.phase = 'awaiting_adoption'
    return { ok: true, receipt: {
      transactionId: receipt.transactionId,
      projectId: receipt.projectId,
      newRevision: receipt.newRevision,
      snapshotSha256: receipt.snapshotSha256,
    } }
  })

  ipc.handle('workspace:worlds:cli:directEditCancel', async (event, value) => {
    if (!isCancelPayload(value)) return { ok: false, code: 'INVALID_REQUEST' }
    const entry = activeFor(value.editIntent)
    if (!entry) {
      const known = terminalForIpc(value.editIntent, value.nonce, event)
      return known ? { ok: false, code: responseCode(known.status) } : { ok: false, code: 'NOT_FOUND' }
    }
    if (value.nonce !== entry.nonce || !trustedEvent(entry, event)) {
      return terminalFailure(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE')
    }
    const status = tombstone(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE')
    await startCleanup(entry)
    return { ok: true, status }
  })

  ipc.handle('workspace:worlds:cli:directEditAdopt', async (event, value) => {
    if (!isAdoptPayload(value)) return { ok: false, code: 'INVALID_REQUEST' }
    const entry = activeFor(value.editIntent)
    if (!entry) {
      const known = terminalForIpc(value.editIntent, value.nonce, event)
      return known ? { ok: false, code: responseCode(known.status) } : { ok: false, code: 'NOT_FOUND' }
    }
    if (value.nonce !== entry.nonce || !trustedEvent(entry, event) || entry.phase !== 'awaiting_adoption'
      || entry.adoptionStarted || !entry.journaled || !entry.receipt) return terminalFailure(entry, 'AMBIGUOUS')
    const receipt = entry.receipt
    if (value.transactionId !== receipt.transactionId || value.newRevision !== receipt.newRevision
      || value.snapshotSha256 !== receipt.snapshotSha256) return terminalFailure(entry, 'AMBIGUOUS')
    entry.adoptionStarted = true
    try {
      const opened = await options.repository.open({ projectKey: entry.localScope.projectKey })
      assertLive(entry, ['awaiting_adoption'])
      if (!opened.ok || opened.value.status !== 'ready'
        || opened.value.projectKey !== entry.localScope.projectKey
        || opened.value.snapshot.project.projectId !== receipt.projectId
        || opened.value.snapshot.project.revision !== receipt.newRevision
        || createHash('sha256').update(canonicalWorldProjectSnapshotPayload(opened.value.snapshot)).digest('hex') !== receipt.snapshotSha256) {
        return terminalFailure(entry, 'AMBIGUOUS')
      }
      const advanced = entry.reservation.advanceScope(receipt)
      if (!advanced.ok || advanced.revision !== receipt.newRevision) return terminalFailure(entry, 'AMBIGUOUS')
      entry.localScope = Object.freeze({ ...entry.localScope, revision: receipt.newRevision })
      lastScope = entry.localScope
      const applied = entry.claim?.applied({ ...receipt, editorAdopted: true })
      if (!applied?.ok || applied.status !== 'APPLIED') return terminalFailure(entry, 'AMBIGUOUS')
      settleApplied(entry)
      await startCleanup(entry)
      return { ok: true, status: 'APPLIED' }
    } catch { return terminalFailure(entry, 'AMBIGUOUS') }
  })

  const execute: WorldsCliDirectEditBroker['execute'] = async (reservation) => {
    if (closed) return { ok: false, code: 'UNAVAILABLE' }
    if (active) return { ok: false, code: 'BUSY' }
    let source: WorldsCliDirectEditReservation['source']
    let window: BrokerWindow | null
    let workspaceRoot: string
    let canonicalWorkspace: string
    try {
      source = reservation.source
      window = options.getWindow()
      workspaceRoot = options.getWorkspaceRoot()
      canonicalWorkspace = realpathSync(workspaceRoot)
    } catch { return { ok: false, code: 'STALE' } }
    if (!window || !isTrustedWorldsCliSender({ sender: window.webContents, senderFrame: window.webContents.mainFrame },
      window, options.trustedRendererUrl)) return { ok: false, code: 'STALE' }
    const contents = window.webContents
    const frame = contents.mainFrame
    const localScope: WorldsCliDirectEditScope = Object.freeze({
      sessionId: source.scope.sessionId,
      generation: source.scope.generation,
      sessionExpiresAt: source.scope.sessionExpiresAt,
      window,
      contents,
      frame,
      documentUrl: options.trustedRendererUrl,
      documentEpoch: getMainWindowDocumentEpoch(contents),
      workspaceRoot,
      canonicalWorkspace,
      projectKey: source.scope.projectKey,
      projectId: source.scope.projectId,
      sceneId: source.scope.sceneId,
      editorEpoch: source.scope.editorEpoch,
      revision: source.scope.revision,
      mode: 'edit',
    })
    let cleanupListeners = () => undefined
    const entry: ActiveRecord = {
      reservation, claim: null, editIntent: '', nonce: randomBytes(24).toString('hex'),
      window, contents, frame, documentUrl: options.trustedRendererUrl,
      documentEpoch: localScope.documentEpoch, deadline: 0, phase: 'preflight', journaled: false,
      tombstoned: false, adoptionStarted: false, localScope, receipt: null, timer: null,
      cleanupListeners: () => cleanupListeners(), cleanupPromise: null, terminalStatus: null,
    }
    active = entry
    lastScope = localScope
    lookupAllowed = true
    const issued = ledger.issue({ ...source, scope: localScope })
    if (!issued.ok) {
      entry.deadline = now()
      await terminalFailure(entry, issued.code === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'STALE')
      return issued
    }
    entry.editIntent = issued.intentId
    entry.deadline = Math.min(issued.expiresAt, source.expiresAt, source.scope.sessionExpiresAt, now() + timeoutMs)
    const claimed = ledger.claim(entry.editIntent)
    if (!claimed.ok) {
      await terminalFailure(entry, claimed.code === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'STALE')
      return claimed
    }
    entry.claim = claimed.claim
    entry.phase = 'awaiting_readiness'

    const onNavigation = (details: unknown) => {
      const detail = (details ?? {}) as { isMainFrame?: boolean; isSameDocument?: boolean }
      if (detail.isMainFrame && !detail.isSameDocument) tombstone(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE')
    }
    const onRendererGone = () => { tombstone(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE') }
    const onWindowClosed = () => { tombstone(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE') }
    cleanupListeners = () => {
      contents.off?.('did-start-navigation', onNavigation)
      contents.off?.('destroyed', onRendererGone)
      contents.off?.('render-process-gone', onRendererGone)
      window?.off?.('close', onWindowClosed)
      window?.off?.('closed', onWindowClosed)
    }
    contents.on?.('did-start-navigation', onNavigation)
    contents.on?.('destroyed', onRendererGone)
    contents.on?.('render-process-gone', onRendererGone)
    window.on?.('close', onWindowClosed)
    window.on?.('closed', onWindowClosed)
    entry.timer = setTimeout(() => { tombstone(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE') },
      Math.max(0, entry.deadline - now()))

    let readiness: WorldsCliReadinessResult
    try {
      readiness = await options.readiness.request({ projectKey: localScope.projectKey, projectId: localScope.projectId,
        sceneId: localScope.sceneId, revision: localScope.revision, editorEpoch: localScope.editorEpoch })
    } catch { readiness = { status: 'REFUSED', reason: 'editor_not_ready' } }
    if (entry.tombstoned) {
      await startCleanup(entry)
      return { ok: false, code: responseCode(entry.terminalStatus ?? 'STALE') }
    }
    if (readiness.status !== 'READY') {
      await terminalFailure(entry, 'STALE')
      return { ok: false, code: readinessFailureCode(readiness.reason) }
    }
    try {
      assertLive(entry, ['awaiting_readiness'])
      const ledgerStatus = ledger.lookup(entry.editIntent)
      if (ledgerStatus.ok || ledgerStatus.code !== 'BUSY') throw new Error('Direct-edit claim is no longer live')
      const request: DirectEditRequest = Object.freeze({
        nonce: entry.nonce,
        editIntent: entry.editIntent,
        projectKey: localScope.projectKey,
        projectId: localScope.projectId,
        sceneId: localScope.sceneId,
        baseRevision: localScope.revision,
        editorEpoch: localScope.editorEpoch,
        expiresAt: entry.deadline,
      })
      entry.phase = 'awaiting_commit'
      contents.send('workspace:worlds:cli:directEditRequest', request)
      return { ok: true, editIntent: entry.editIntent, expiresAt: entry.deadline }
    } catch {
      await terminalFailure(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE')
      return { ok: false, code: entry.journaled ? 'AMBIGUOUS' : 'STALE' }
    }
  }

  const cancelActive: WorldsCliDirectEditBroker['cancelActive'] = (reason) => {
    if (reason === 'revoke' || reason === 'editor_left' || reason === 'shutdown') lookupAllowed = false
    const entry = active
    if (!entry) return null
    return tombstone(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE')
  }

  const lookup: WorldsCliDirectEditBroker['lookup'] = (editIntent) => {
    if (closed || !lookupAllowed || typeof editIntent !== 'string' || !EDIT_INTENT.test(editIntent)) {
      return { ok: false, code: 'NOT_FOUND' }
    }
    pruneTerminal()
    if (active?.editIntent === editIntent) {
      if (!scopeVisible(active.localScope)) return { ok: false, code: 'NOT_FOUND' }
      return { ok: false, code: 'BUSY' }
    }
    const record = terminal.get(editIntent)
    if (!record || !terminalScopeVisible(record)) return { ok: false, code: 'NOT_FOUND' }
    return { ok: true, status: record.status }
  }

  const shutdown: WorldsCliDirectEditBroker['shutdown'] = async () => {
    if (closed) return
    const entry = active
    if (entry) {
      lookupAllowed = false
      tombstone(entry, entry.journaled ? 'AMBIGUOUS' : 'STALE')
      await startCleanup(entry)
    }
    closed = true
    ledger.shutdown()
    terminal.clear()
    lastScope = null
  }

  return Object.freeze({ execute, cancelActive, lookup, shutdown })
}

function readinessFailureCode(_reason: WorldsCliReadinessRefusal): 'STALE' {
  return 'STALE'
}
