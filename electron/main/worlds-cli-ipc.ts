import { WORLD_CLI_DIRECT_EDIT_LIMIT, type WorldsCliTransport } from './worlds-cli-transport.ts'
import { randomBytes } from 'node:crypto'
import type { WorldsCliCompleteReview } from '../../src/shared/types/worldProjects.ts'
import { getMainWindowDocumentEpoch, isTrustedWorldsCliSender, type WorldsCliWindowLike } from './worlds-cli-window-trust.ts'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
type DialogLike = { showMessageBox(window: WorldsCliWindowLike, options: {
  type: 'question' | 'info'; title: string; message: string; detail: string; buttons: string[];
  defaultId: number; cancelId: number; noLink: boolean
}): Promise<{ response: number }> }

/** This is an OS dialog decision over a complete, pre-bounded review, not proof a person read it. */
export function confirmWorldsCliApply(window: WorldsCliWindowLike, dialog: DialogLike, review: WorldsCliCompleteReview,
  scope: { projectId: string; sceneId: string; revision: number }): Promise<boolean> {
  if (!review.complete || review.changes.length < 1 || review.changes.length > 48 || review.warnings.length > 2) throw new Error('Review is too large')
  if (!/^project:[A-Za-z0-9:_-]{1,128}$/.test(scope.projectId) || !/^scene:[A-Za-z0-9:_-]{1,128}$/.test(scope.sceneId)
    || !Number.isSafeInteger(scope.revision) || scope.revision < 0) throw new Error('Review scope is invalid')
  const detail = [
    `Project: ${scope.projectId}`,
    `Scene: ${scope.sceneId}`,
    `Base revision: ${scope.revision}`,
    'Every proposed change:',
    ...review.changes.map((change, index) => `${index + 1}. ${change.field}: ${change.before === null ? '(not set)' : change.before} → ${change.after === null ? '(not set)' : change.after}`),
    ...(review.warnings.length ? ['Warnings:', ...review.warnings] : []),
  ].join('\n')
  if (new TextEncoder().encode(detail).byteLength > 4800 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(detail.replaceAll('\n', ''))) throw new Error('Review cannot fit native dialog')
  return dialog.showMessageBox(window, {
    type: 'question', title: 'Apply reviewed Worlds changes?', message: 'Apply ALL of these changes to this Worlds project?',
    detail, buttons: ['Cancel', 'Apply reviewed changes'], defaultId: 0, cancelId: 0, noLink: true,
  }).then((result) => result.response === 1)
}

export type WorldsCliEditorContext = { projectKey: string; projectId: string; sceneId: string; revision: number; editorEpoch: number; mode: 'edit' }

/** A nonce-correlated internal request: a renderer response is intent, never disk authority. */
export function registerWorldsCliEditorContextBroker(
  ipc: { handle(channel: string, handler: Handler): void },
  options: { getWindow(): WorldsCliWindowLike | null; trustedRendererUrl: string },
): { request(): Promise<WorldsCliEditorContext | null>; onLeave(callback: () => void): void; shutdown(): void } {
  const pending = new Map<string, { window: WorldsCliWindowLike; epoch: number; resolve(value: WorldsCliEditorContext | null): void }>()
  let leave: () => void = () => undefined
  ipc.handle('workspace:worlds:cli:contextResponse', async (event, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false }
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'editorEpoch,mode,nonce,projectId,projectKey,revision,sceneId'
      || typeof record.nonce !== 'string') return { ok: false }
    const entry = pending.get(record.nonce)
    if (!entry || !isTrustedWorldsCliSender(event, entry.window, options.trustedRendererUrl)
      || options.getWindow() !== entry.window || getMainWindowDocumentEpoch(entry.window.webContents) !== entry.epoch
      || !/^world-[a-f0-9]{32}$/.test(String(record.projectKey))
      || !/^project:[A-Za-z0-9:_-]{1,128}$/.test(String(record.projectId))
      || !/^scene:[A-Za-z0-9:_-]{1,128}$/.test(String(record.sceneId))
      || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
      || !Number.isSafeInteger(record.editorEpoch) || (record.editorEpoch as number) < 0 || record.mode !== 'edit') return { ok: false }
    pending.delete(record.nonce)
    entry.resolve({ projectKey: record.projectKey as string, projectId: record.projectId as string,
      sceneId: record.sceneId as string, revision: record.revision as number, editorEpoch: record.editorEpoch as number, mode: 'edit' })
    return { ok: true }
  })
  ipc.handle('workspace:worlds:cli:editorLeft', async (event, ...args) => {
    const window = options.getWindow()
    if (args.length || !isTrustedWorldsCliSender(event, window, options.trustedRendererUrl)) return { ok: false }
    leave()
    return { ok: true }
  })
  return {
    request: () => new Promise((resolve) => {
      const window = options.getWindow()
      if (!isTrustedWorldsCliSender(window && { sender: window.webContents, senderFrame: window.webContents.mainFrame }, window, options.trustedRendererUrl)) { resolve(null); return }
      const nonce = randomBytes(24).toString('hex')
      const entry = { window: window!, epoch: getMainWindowDocumentEpoch(window!.webContents), resolve }
      pending.set(nonce, entry)
      const timer = setTimeout(() => { if (pending.delete(nonce)) resolve(null) }, 1200)
      const original = entry.resolve
      entry.resolve = (context) => { clearTimeout(timer); original(context) }
      const contents = window!.webContents as WorldsCliWindowLike['webContents'] & { send(channel: string, ...args: unknown[]): void }
      contents.send('workspace:worlds:cli:contextRequest', nonce)
    }),
    onLeave(callback) { leave = callback },
    shutdown() { for (const entry of pending.values()) entry.resolve(null); pending.clear(); leave = () => undefined },
  }
}

export async function confirmWorldsCliEditLease(window: WorldsCliWindowLike, dialog: DialogLike,
  scope: WorldsCliEditorContext): Promise<boolean> {
  const result = await dialog.showMessageBox(window, { type: 'question', title: 'Allow local scene editing?',
    message: 'Allow a local process to edit the current Worlds scene?',
    detail: `Project: ${scope.projectId}\nScene: ${scope.sceneId}\nFor up to 5 minutes and at most ${WORLD_CLI_DIRECT_EDIT_LIMIT} admitted edits, valid proposals may apply automatically without another approval when editing becomes available. Only allow this when you initiated pairing. The process is not verified as Codex.`,
    buttons: ['Cancel', 'Allow temporary scene editing'], defaultId: 0, cancelId: 0, noLink: true })
  return result.response === 1
}

export async function displayWorldsCliCode(window: WorldsCliWindowLike, dialog: DialogLike, code: string): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(code)) return false
  const result = await dialog.showMessageBox(window, { type: 'info', title: 'Worlds pairing code',
    message: `Enter this one-time code in your terminal: ${code}`,
    detail: 'Do not copy the code into an agent prompt or command argument. Cancel to deny access.',
    buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, noLink: true })
  return result.response === 1
}

/** Trusted legacy review IPC remains private to Main and never exposes a CLI mutation route. */
export function registerWorldsCliIpcHandlers(
  ipc: { handle(channel: string, handler: Handler): void },
  transport: Pick<WorldsCliTransport, 'getStatus' | 'revoke'> & {
    listPending?(): Promise<unknown>
    getReview?(request: { proposalId: string }): Promise<unknown>
    reject?(request: { proposalId: string; reviewId: string }): Promise<unknown>
    apply?(request: { proposalId: string; reviewId: string }, confirm: (review: WorldsCliCompleteReview,
      scope: { projectId: string; sceneId: string; revision: number }) => Promise<boolean>, assertIntentLive: () => void): Promise<unknown>
  },
  options: { getWindow(): WorldsCliWindowLike | null; trustedRendererUrl: string; dialog: DialogLike },
): { shutdown(): Promise<void> } {
  const trusted = (event: unknown): WorldsCliWindowLike | null => {
    const window = options.getWindow()
    return isTrustedWorldsCliSender(event, window, options.trustedRendererUrl) ? window : null
  }
  const register = (channel: string, operation: (event: unknown, window: WorldsCliWindowLike) => Promise<unknown>) => {
    ipc.handle(channel, async (event, ...args) => {
      const window = trusted(event)
      if (!window) return { ok: false, code: 'UNAUTHORIZED' }
      if (args.length) return { ok: false, code: 'INVALID_REQUEST' }
      try { return await operation(event, window) }
      catch { return { ok: false, code: 'UNAVAILABLE' } }
    })
  }
  register('workspace:worlds:cli:status', async () => ({ ok: true, ...transport.getStatus() }))
  let shuttingDown = false
  type ApplyIntent = { id: string; proposalId: string; reviewId: string; window: WorldsCliWindowLike; frame: object; epoch: number; cancelled: boolean }
  let activeIntent: ApplyIntent | null = null
  const tombstones = new Map<string, number>()
  const tombstone = (id: string): void => {
    const now = Date.now()
    for (const [key, expiry] of tombstones) if (expiry <= now) tombstones.delete(key)
    tombstones.delete(id)
    tombstones.set(id, now + 60_000)
    while (tombstones.size > 256) tombstones.delete(tombstones.keys().next().value!)
  }
  const isTombstoned = (id: string): boolean => {
    const expiry = tombstones.get(id)
    if (expiry === undefined) return false
    if (expiry > Date.now()) return true
    tombstones.delete(id)
    return false
  }
  const revoke = async (): Promise<void> => { if (activeIntent) activeIntent.cancelled = true; await transport.revoke() }
  const reviewHandler = (channel: string, keys: readonly string[], operation: (request: Record<string, string>) => Promise<unknown>) => {
    ipc.handle(channel, async (event, ...args) => {
      const window = trusted(event)
      if (!window) return { ok: false, code: 'UNAUTHORIZED' }
      if (shuttingDown) return { ok: false, code: 'UNAVAILABLE' }
      if (keys.length === 0 ? args.length !== 0 : args.length !== 1 || !exactPayload(args[0], keys)) return { ok: false, code: 'INVALID_REQUEST' }
      const epoch = getMainWindowDocumentEpoch(window.webContents)
      const request = (args[0] ?? {}) as Record<string, string>
      try {
        const result = await operation(request)
        if (shuttingDown || trusted(event) !== window || getMainWindowDocumentEpoch(window.webContents) !== epoch) return { ok: false, code: 'UNAUTHORIZED' }
        return result
      } catch { return { ok: false, code: 'UNAVAILABLE' } }
    })
  }
  reviewHandler('workspace:worlds:cli:listPending', [], async () => transport.listPending?.() ?? { ok: false, code: 'UNAVAILABLE' })
  reviewHandler('workspace:worlds:cli:getReview', ['proposalId'], async (request) => transport.getReview?.({ proposalId: request.proposalId }) ?? { ok: false, code: 'UNAVAILABLE' })
  reviewHandler('workspace:worlds:cli:reject', ['proposalId', 'reviewId'], async (request) => transport.reject?.({ proposalId: request.proposalId, reviewId: request.reviewId }) ?? { ok: false, code: 'UNAVAILABLE' })
  ipc.handle('workspace:worlds:cli:cancelApplyIntent', async (event, ...args) => {
    if (!trusted(event)) return { ok: false, code: 'UNAUTHORIZED' }
    if (args.length !== 1 || !exactPayload(args[0], ['attemptId'])) return { ok: false, code: 'INVALID_REQUEST' }
    const { attemptId } = args[0] as { attemptId: string }
    // Mutation precedes the ACK and is scoped to this exact correlation ID.
    tombstone(attemptId)
    if (activeIntent?.id === attemptId) activeIntent.cancelled = true
    return { ok: true }
  })
  ipc.handle('workspace:worlds:cli:apply', async (event, ...args) => {
    const window = trusted(event)
    if (!window) return { ok: false, code: 'UNAUTHORIZED' }
    if (shuttingDown || !transport.apply) return { ok: false, code: 'UNAVAILABLE' }
    if (args.length !== 1 || !exactPayload(args[0], ['proposalId', 'reviewId', 'attemptId'])) return { ok: false, code: 'INVALID_REQUEST' }
    const { proposalId, reviewId, attemptId } = args[0] as { proposalId: string; reviewId: string; attemptId: string }
    if (isTombstoned(attemptId)) return { ok: false, code: 'STALE' }
    if (activeIntent) return { ok: false, code: 'BUSY' }
    const epoch = getMainWindowDocumentEpoch(window.webContents)
    const intent: ApplyIntent = { id: attemptId, proposalId, reviewId, window, frame: window.webContents.mainFrame, epoch, cancelled: false }
    activeIntent = intent
    const cancelOnNavigation = (_event: unknown, details?: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      const navigation = details ?? _event as { isMainFrame?: boolean; isSameDocument?: boolean }
      if (navigation?.isMainFrame && !navigation.isSameDocument) intent.cancelled = true
    }
    const cancelOnDestroy = () => { intent.cancelled = true }
    const contentsEvents = window.webContents as typeof window.webContents & {
      on?(name: string, listener: (...args: never[]) => void): void
      off?(name: string, listener: (...args: never[]) => void): void
    }
    const windowEvents = window as typeof window & {
      on?(name: string, listener: (...args: never[]) => void): void
      off?(name: string, listener: (...args: never[]) => void): void
    }
    contentsEvents.on?.('did-start-navigation', cancelOnNavigation)
    contentsEvents.on?.('destroyed', cancelOnDestroy)
    contentsEvents.on?.('render-process-gone', cancelOnDestroy)
    windowEvents.on?.('close', cancelOnDestroy)
    windowEvents.on?.('closed', cancelOnDestroy)
    const assertIntentLive = (): void => {
      if (intent.cancelled || shuttingDown || activeIntent !== intent || isTombstoned(attemptId)
        || trusted(event) !== window || window.webContents.mainFrame !== intent.frame
        || getMainWindowDocumentEpoch(window.webContents) !== epoch) throw new Error('Worlds Apply intent is stale')
    }
    try {
      const result = await transport.apply({ proposalId, reviewId }, async (review, scope) => {
        assertIntentLive()
        const approved = await confirmWorldsCliApply(window, options.dialog, review, scope)
        assertIntentLive()
        return approved
      }, assertIntentLive)
      if (intent.cancelled || shuttingDown || trusted(event) !== window || getMainWindowDocumentEpoch(window.webContents) !== epoch)
        return result && typeof result === 'object' && 'code' in result && result.code === 'STALE' ? result : { ok: false, code: 'AMBIGUOUS' }
      return result
    } catch { return { ok: false, code: 'AMBIGUOUS' } }
    finally {
      contentsEvents.off?.('did-start-navigation', cancelOnNavigation)
      contentsEvents.off?.('destroyed', cancelOnDestroy)
      contentsEvents.off?.('render-process-gone', cancelOnDestroy)
      windowEvents.off?.('close', cancelOnDestroy)
      windowEvents.off?.('closed', cancelOnDestroy)
      if (activeIntent === intent) activeIntent = null
      tombstone(attemptId)
    }
  })
  register('workspace:worlds:cli:revoke', async () => { await revoke(); return { ok: true } })
  return { shutdown: async () => { shuttingDown = true; if (activeIntent) activeIntent.cancelled = true; await revoke() } }
}

function exactPayload(value: unknown, keys: readonly string[]): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => {
      const field = (value as Record<string, unknown>)[key]
      const prefix = key === 'proposalId' ? 'proposal_' : key === 'reviewId' ? 'review_' : 'attempt_'
      return Object.hasOwn(value, key) && typeof field === 'string' && new RegExp(`^${prefix}[a-f0-9]{48}$`).test(field)
    })
}
