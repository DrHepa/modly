import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { registerWorldsCliReadinessBroker } from './worlds-cli-readiness-broker.ts'
import { installMainWindowNavigationGuard } from './worlds-cli-window-trust.ts'

const DOCUMENT = 'http://127.0.0.1:5173/'
const SCOPE = {
  projectKey: `world-${'a'.repeat(32)}`,
  projectId: 'project:one',
  sceneId: 'scene:one',
  revision: 7,
  editorEpoch: 3,
}

function harness(timeoutMs = 1_200) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  const contents = new EventEmitter() as EventEmitter & {
    mainFrame: { url: string; origin: string }
    getURL(): string
    send(channel: string, payload: Record<string, unknown>): void
  }
  const frame = { url: DOCUMENT, origin: new URL(DOCUMENT).origin }
  contents.mainFrame = frame
  contents.getURL = () => DOCUMENT
  contents.send = (channel, payload) => { sent.push({ channel, payload }) }
  installMainWindowNavigationGuard(contents, DOCUMENT)
  const window = new EventEmitter() as EventEmitter & { isDestroyed(): boolean; webContents: typeof contents }
  window.isDestroyed = () => false
  window.webContents = contents
  const broker = registerWorldsCliReadinessBroker(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    { getWindow: () => window, trustedRendererUrl: DOCUMENT, timeoutMs },
  )
  return { broker, contents, frame, handlers, sent, window, event: { sender: contents, senderFrame: frame } }
}

test('readiness broker rejects forged frame and changed document epoch without authorizing work', async () => {
  const h = harness(100)
  const pending = h.broker.request(SCOPE)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].channel, 'workspace:worlds:cli:directEditReadinessRequest')
  assert.deepEqual(Object.keys(h.sent[0].payload).sort(), [
    'baseRevision', 'editorEpoch', 'expiresAt', 'intentId', 'nonce', 'projectId', 'projectKey', 'sceneId',
  ])
  const response = h.handlers.get('workspace:worlds:cli:directEditReadinessResponse')!
  const correlation = { nonce: h.sent[0].payload.nonce, intentId: h.sent[0].payload.intentId }
  assert.deepEqual(await response({ ...h.event, senderFrame: { ...h.frame } }, { ...correlation, status: 'READY' }), { ok: false })
  assert.equal(h.contents.listenerCount('did-start-navigation'), 2, 'guard plus per-request listener')
  h.contents.emit('did-start-navigation',
    { isMainFrame: true, isSameDocument: false }, DOCUMENT, false, true, 123, 456)
  const immediate = await Promise.race([
    pending,
    new Promise<'STILL_PENDING'>((resolve) => setTimeout(() => resolve('STILL_PENDING'), 20)),
  ])
  if (immediate === 'STILL_PENDING') h.broker.shutdown()
  assert.deepEqual(immediate, { status: 'REFUSED', reason: 'navigation' })
  assert.equal(h.contents.listenerCount('did-start-navigation'), 1, 'settlement removes the per-request listener')
  h.contents.emit('did-start-navigation',
    { isMainFrame: true, isSameDocument: false }, DOCUMENT, false, true, 123, 456)
  assert.deepEqual(await response(h.event, { ...correlation, status: 'READY' }), { ok: false })
})

test('readiness cancellation rejects a same-URL replacement main frame', async () => {
  const h = harness()
  const pending = h.broker.request(SCOPE)
  const correlation = { nonce: h.sent[0].payload.nonce, intentId: h.sent[0].payload.intentId }
  const replacement = { url: DOCUMENT, origin: new URL(DOCUMENT).origin }
  h.contents.mainFrame = replacement
  const result = await h.handlers.get('workspace:worlds:cli:directEditReadinessCancel')!(
    { sender: h.contents, senderFrame: replacement }, correlation,
  )
  h.broker.shutdown()
  assert.deepEqual(result, { ok: false })
  assert.deepEqual(await pending, { status: 'REFUSED', reason: 'navigation' })
})

test('readiness responses and cancellation are exact, one-shot and cannot settle a newer request', async () => {
  const h = harness()
  const response = h.handlers.get('workspace:worlds:cli:directEditReadinessResponse')!
  const cancel = h.handlers.get('workspace:worlds:cli:directEditReadinessCancel')!
  const first = h.broker.request(SCOPE)
  const old = h.sent[0].payload
  assert.deepEqual(await response(h.event, { nonce: old.nonce, intentId: old.intentId, status: 'READY' }), { ok: true })
  assert.deepEqual(await first, { status: 'READY' })
  assert.deepEqual(await response(h.event, { nonce: old.nonce, intentId: old.intentId, status: 'READY' }), { ok: false })

  const second = h.broker.request({ ...SCOPE, revision: 8 })
  const current = h.sent[1].payload
  assert.notEqual(current.intentId, old.intentId)
  assert.deepEqual(await cancel(h.event, { nonce: old.nonce, intentId: old.intentId }), { ok: false })
  assert.deepEqual(await response(h.event, { nonce: current.nonce, intentId: current.intentId, status: 'REFUSED', reason: 'scope_mismatch' }), { ok: true })
  assert.deepEqual(await second, { status: 'REFUSED', reason: 'scope_mismatch' })
})

test('timeout, navigation, renderer loss, window close and shutdown settle pending readiness once', async () => {
  const timeout = harness(5)
  assert.deepEqual(await timeout.broker.request(SCOPE), { status: 'REFUSED', reason: 'timeout' })

  for (const [eventTarget, eventName, reason] of [
    ['contents', 'render-process-gone', 'renderer_gone'],
    ['window', 'close', 'window_closed'],
  ] as const) {
    const h = harness()
    const pending = h.broker.request(SCOPE)
    h[eventTarget].emit(eventName)
    h[eventTarget].emit(eventName)
    assert.deepEqual(await pending, { status: 'REFUSED', reason })
  }

  const shutdown = harness()
  const pending = shutdown.broker.request(SCOPE)
  shutdown.broker.shutdown()
  shutdown.broker.shutdown()
  assert.deepEqual(await pending, { status: 'REFUSED', reason: 'shutdown' })
  assert.deepEqual(await shutdown.broker.request(SCOPE), { status: 'REFUSED', reason: 'shutdown' })
})

test('inert readiness channel inventory excludes commit, adoption and any mutation route', async () => {
  const h = harness()
  assert.deepEqual([...h.handlers.keys()].sort(), [
    'workspace:worlds:cli:directEditReadinessCancel',
    'workspace:worlds:cli:directEditReadinessResponse',
  ])
  for (const forbidden of ['commitIntent', 'editorAdopted', 'edit', 'edit-status']) {
    assert.equal([...h.handlers.keys()].some((channel) => channel.includes(forbidden)), false)
  }
  assert.deepEqual(await h.broker.request({ ...SCOPE, revision: Number.MAX_SAFE_INTEGER + 1 }),
    { status: 'REFUSED', reason: 'invalid_scope' })
  assert.equal(h.sent.length, 0, 'invalid scope must not synthesize an editor request')
  h.broker.shutdown()
})
