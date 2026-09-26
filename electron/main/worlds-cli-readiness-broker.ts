import { randomBytes } from 'node:crypto'

import { getMainWindowDocumentEpoch, isTrustedWorldsCliSender, type WorldsCliWindowLike } from './worlds-cli-window-trust.ts'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

export type WorldsCliReadinessScope = Readonly<{
  projectKey: string
  projectId: string
  sceneId: string
  revision: number
  editorEpoch: number
}>

export type WorldsCliReadinessResult =
  | { status: 'READY' }
  | { status: 'REFUSED'; reason: WorldsCliReadinessRefusal }

export type WorldsCliReadinessRefusal =
  | 'unmounted'
  | 'play_active'
  | 'editor_not_ready'
  | 'scope_mismatch'
  | 'busy'
  | 'expired'
  | 'renderer_cancelled'
  | 'timeout'
  | 'navigation'
  | 'window_closed'
  | 'renderer_gone'
  | 'editor_left'
  | 'shutdown'
  | 'invalid_scope'

type EventTargetLike = {
  on?(name: string, listener: (...args: unknown[]) => void): void
  off?(name: string, listener: (...args: unknown[]) => void): void
}

type PendingReadiness = {
  nonce: string
  intentId: string
  window: WorldsCliWindowLike
  contents: WorldsCliWindowLike['webContents']
  frame: object
  documentUrl: string
  documentEpoch: number
  scope: WorldsCliReadinessScope
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
  resolve(value: WorldsCliReadinessResult): void
  cleanup(): void
}

const RENDERER_REFUSALS = new Set<WorldsCliReadinessRefusal>([
  'unmounted', 'play_active', 'editor_not_ready', 'scope_mismatch', 'busy', 'expired',
])

/**
 * Inert time-of-check broker. READY is an observation only: it neither creates
 * write custody nor authorizes a later commit.
 */
export function registerWorldsCliReadinessBroker(
  ipc: { handle(channel: string, handler: Handler): void },
  options: { getWindow(): WorldsCliWindowLike | null; trustedRendererUrl: string; timeoutMs?: number },
): {
  request(scope: WorldsCliReadinessScope): Promise<WorldsCliReadinessResult>
  editorLeft(): void
  shutdown(): void
} {
  const timeoutMs = options.timeoutMs ?? 1_200
  let pending: PendingReadiness | null = null
  let shuttingDown = false

  const settle = (entry: PendingReadiness, result: WorldsCliReadinessResult): boolean => {
    if (pending !== entry) return false
    pending = null
    clearTimeout(entry.timer)
    entry.cleanup()
    entry.resolve(result)
    return true
  }

  const validateCapturedTrust = (entry: PendingReadiness, event: unknown,
    correlation: { nonce: string; intentId: string }): 'live' | 'wrong_correlation' | 'stale_document' | 'untrusted' | 'expired' => {
    if (correlation.nonce !== entry.nonce || correlation.intentId !== entry.intentId) return 'wrong_correlation'
    const currentWindow = options.getWindow()
    if (currentWindow !== entry.window || currentWindow?.webContents !== entry.contents
      || entry.contents.mainFrame !== entry.frame
      || entry.contents.getURL() !== entry.documentUrl
      || getMainWindowDocumentEpoch(entry.contents) !== entry.documentEpoch) return 'stale_document'
    if (!isTrustedWorldsCliSender(event, entry.window, entry.documentUrl)) return 'untrusted'
    return Date.now() >= entry.expiresAt ? 'expired' : 'live'
  }

  const requireCapturedTrust = (entry: PendingReadiness, event: unknown,
    correlation: { nonce: string; intentId: string }): boolean => {
    const validity = validateCapturedTrust(entry, event, correlation)
    if (validity === 'stale_document') settle(entry, { status: 'REFUSED', reason: 'navigation' })
    else if (validity === 'expired') settle(entry, { status: 'REFUSED', reason: 'timeout' })
    return validity === 'live'
  }

  ipc.handle('workspace:worlds:cli:directEditReadinessResponse', async (event, value: unknown) => {
    const entry = pending
    if (!entry || !isResponse(value)) return { ok: false }
    if (!requireCapturedTrust(entry, event, value)) return { ok: false }
    const result: WorldsCliReadinessResult = value.status === 'READY'
      ? { status: 'READY' }
      : { status: 'REFUSED', reason: value.reason }
    return { ok: settle(entry, result) }
  })

  ipc.handle('workspace:worlds:cli:directEditReadinessCancel', async (event, value: unknown) => {
    const entry = pending
    if (!entry || !isCorrelation(value)) return { ok: false }
    if (!requireCapturedTrust(entry, event, value)) return { ok: false }
    return { ok: settle(entry, { status: 'REFUSED', reason: 'renderer_cancelled' }) }
  })

  return {
    request(scope) {
      if (shuttingDown) return Promise.resolve({ status: 'REFUSED', reason: 'shutdown' })
      if (pending) return Promise.resolve({ status: 'REFUSED', reason: 'busy' })
      const capturedScope = captureScope(scope)
      if (!capturedScope) return Promise.resolve({ status: 'REFUSED', reason: 'invalid_scope' })
      const window = options.getWindow()
      if (!isTrustedWorldsCliSender(window && { sender: window.webContents, senderFrame: window.webContents.mainFrame }, window, options.trustedRendererUrl))
        return Promise.resolve({ status: 'REFUSED', reason: 'unmounted' })
      const contents = window!.webContents
      const frame = contents.mainFrame
      const documentEpoch = getMainWindowDocumentEpoch(contents)
      const nonce = randomBytes(24).toString('hex')
      const intentId = `intent_${randomBytes(24).toString('hex')}`
      const expiresAt = Date.now() + timeoutMs
      return new Promise((resolve) => {
        const contentsEvents = contents as typeof contents & EventTargetLike
        const windowEvents = window as typeof window & EventTargetLike
        const onNavigation = (details: unknown, ..._deprecated: unknown[]) => {
          const detail = (details ?? {}) as { isMainFrame?: boolean; isSameDocument?: boolean }
          if (detail.isMainFrame && !detail.isSameDocument) settle(entry, { status: 'REFUSED', reason: 'navigation' })
        }
        const onRendererGone = () => { settle(entry, { status: 'REFUSED', reason: 'renderer_gone' }) }
        const onWindowClosed = () => { settle(entry, { status: 'REFUSED', reason: 'window_closed' }) }
        const cleanup = () => {
          contentsEvents.off?.('did-start-navigation', onNavigation)
          contentsEvents.off?.('destroyed', onRendererGone)
          contentsEvents.off?.('render-process-gone', onRendererGone)
          windowEvents.off?.('close', onWindowClosed)
          windowEvents.off?.('closed', onWindowClosed)
        }
        const entry: PendingReadiness = {
          nonce, intentId, window: window!, contents, frame, documentUrl: options.trustedRendererUrl,
          documentEpoch, scope: capturedScope, expiresAt,
          timer: setTimeout(() => { settle(entry, { status: 'REFUSED', reason: 'timeout' }) }, timeoutMs),
          resolve, cleanup,
        }
        pending = entry
        contentsEvents.on?.('did-start-navigation', onNavigation)
        contentsEvents.on?.('destroyed', onRendererGone)
        contentsEvents.on?.('render-process-gone', onRendererGone)
        windowEvents.on?.('close', onWindowClosed)
        windowEvents.on?.('closed', onWindowClosed)
        const sender = contents as typeof contents & { send(channel: string, payload: unknown): void }
        try {
          sender.send('workspace:worlds:cli:directEditReadinessRequest', {
            nonce, intentId, projectKey: capturedScope.projectKey, projectId: capturedScope.projectId, sceneId: capturedScope.sceneId,
            baseRevision: capturedScope.revision, editorEpoch: capturedScope.editorEpoch, expiresAt,
          })
        } catch { settle(entry, { status: 'REFUSED', reason: 'renderer_gone' }) }
      })
    },
    editorLeft() {
      if (pending) settle(pending, { status: 'REFUSED', reason: 'editor_left' })
    },
    shutdown() {
      shuttingDown = true
      if (pending) settle(pending, { status: 'REFUSED', reason: 'shutdown' })
    },
  }
}

function captureScope(scope: WorldsCliReadinessScope): WorldsCliReadinessScope | null {
  try {
    if (!scope || typeof scope !== 'object') return null
    const captured = { projectKey: scope.projectKey, projectId: scope.projectId, sceneId: scope.sceneId,
      revision: scope.revision, editorEpoch: scope.editorEpoch }
    if (typeof captured.projectKey !== 'string' || !/^world-[a-f0-9]{32}$/.test(captured.projectKey)
      || typeof captured.projectId !== 'string' || !/^project:[A-Za-z0-9:_-]{1,128}$/.test(captured.projectId)
      || typeof captured.sceneId !== 'string' || !/^scene:[A-Za-z0-9:_-]{1,128}$/.test(captured.sceneId)
      || !Number.isSafeInteger(captured.revision) || captured.revision < 0
      || !Number.isSafeInteger(captured.editorEpoch) || captured.editorEpoch < 0) return null
    return Object.freeze(captured)
  } catch { return null }
}

function isCorrelation(value: unknown): value is { nonce: string; intentId: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'intentId,nonce'
    && typeof (value as { nonce?: unknown }).nonce === 'string' && /^[a-f0-9]{48}$/.test((value as { nonce: string }).nonce)
    && typeof (value as { intentId?: unknown }).intentId === 'string' && /^intent_[a-f0-9]{48}$/.test((value as { intentId: string }).intentId)
}

function isResponse(value: unknown): value is
  | { nonce: string; intentId: string; status: 'READY' }
  | { nonce: string; intentId: string; status: 'REFUSED'; reason: Extract<WorldsCliReadinessRefusal, 'unmounted' | 'play_active' | 'editor_not_ready' | 'scope_mismatch' | 'busy' | 'expired'> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.status === 'READY') return Object.keys(record).sort().join(',') === 'intentId,nonce,status'
    && isCorrelation({ nonce: record.nonce, intentId: record.intentId })
  return record.status === 'REFUSED' && Object.keys(record).sort().join(',') === 'intentId,nonce,reason,status'
    && isCorrelation({ nonce: record.nonce, intentId: record.intentId })
    && typeof record.reason === 'string' && RENDERER_REFUSALS.has(record.reason as WorldsCliReadinessRefusal)
}
