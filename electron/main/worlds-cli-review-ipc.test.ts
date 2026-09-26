import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getMainWindowDocumentEpoch, installMainWindowNavigationGuard } from './worlds-cli-window-trust.ts'
import { confirmWorldsCliApply, registerWorldsCliIpcHandlers, registerWorldsCliEditorContextBroker,
  confirmWorldsCliEditLease, displayWorldsCliCode } from './worlds-cli-ipc.ts'
import { EventEmitter } from 'node:events'

const DOCUMENT = 'http://127.0.0.1:5173/'

test('invisible editor context broker accepts only a nonce-correlated exact document and revokes on leave', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const contents = new EventEmitter() as EventEmitter & { mainFrame: { url: string; origin: string }; getURL(): string; send(channel: string, ...args: unknown[]): void }
  const frame = { url: DOCUMENT, origin: new URL(DOCUMENT).origin }
  contents.mainFrame = frame; contents.getURL = () => DOCUMENT
  installMainWindowNavigationGuard(contents, DOCUMENT)
  const window = { isDestroyed: () => false, webContents: contents }
  const event = { sender: contents, senderFrame: frame }
  const sent: string[] = []
  contents.send = (_channel, nonce) => sent.push(nonce as string)
  const broker = registerWorldsCliEditorContextBroker({ handle: (channel, handler) => handlers.set(channel, handler) },
    { getWindow: () => window, trustedRendererUrl: DOCUMENT })
  let left = 0
  broker.onLeave(() => { left++ })
  const response = handlers.get('workspace:worlds:cli:contextResponse')!
  const context = { projectKey: `world-${'a'.repeat(32)}`, projectId: 'project:one', sceneId: 'scene:one',
    revision: 3, editorEpoch: 2, mode: 'edit' }
  const first = broker.request()
  assert.equal(sent.length, 1)
  assert.deepEqual(await response({ ...event, senderFrame: { ...frame } }, { nonce: sent[0], ...context }), { ok: false })
  assert.deepEqual(await response(event, { nonce: 'a'.repeat(48), ...context }), { ok: false })
  assert.deepEqual(await response(event, { nonce: sent[0], ...context, workspaceRoot: '/private' }), { ok: false })
  assert.deepEqual(await response(event, { nonce: sent[0], ...context }), { ok: true })
  assert.deepEqual(await first, context)
  const stale = broker.request()
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.deepEqual(await response(event, { nonce: sent[1], ...context }), { ok: false })
  broker.shutdown()
  assert.equal(await stale, null)
  assert.deepEqual(await handlers.get('workspace:worlds:cli:editorLeft')!(event, 'extra'), { ok: false })
  assert.deepEqual(await handlers.get('workspace:worlds:cli:editorLeft')!(event), { ok: true })
  assert.equal(left, 0, 'shutdown must not retain a revocation callback')
})

test('native short lease and one-time code are cancel-default and do not assert Codex identity', async () => {
  const dialogs: Array<{ type: string; detail: string; message: string; cancelId: number; defaultId: number }> = []
  const native = { async showMessageBox(_window: unknown, options: typeof dialogs[number]) {
    dialogs.push(options); return { response: 0 }
  } }
  const scope = { projectKey: `world-${'a'.repeat(32)}`, projectId: 'project:one', sceneId: 'scene:one',
    revision: 3, editorEpoch: 2, mode: 'edit' as const }
  assert.equal(await confirmWorldsCliEditLease({} as never, native, scope), false)
  assert.equal(await displayWorldsCliCode({} as never, native, 'a'.repeat(32)), false)
  assert.equal(dialogs.length, 2)
  assert.ok(dialogs[0].detail.includes('5 minutes') && dialogs[0].detail.includes('8 admitted edits')
    && dialogs[0].detail.includes('automatically') && dialogs[0].detail.includes('not verified as Codex'))
  assert.ok(dialogs[1].message.includes('a'.repeat(32)))
  assert.ok(dialogs.every((item) => item.defaultId === 0 && item.cancelId === 0))
})

test('review IPC checks exact trust, payload shape and same-URL navigation; Apply is Main-only', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const contents = new EventEmitter() as EventEmitter & { mainFrame: { url: string; origin: string }; getURL(): string }
  const frame = { url: DOCUMENT, origin: new URL(DOCUMENT).origin }
  contents.mainFrame = frame
  contents.getURL = () => DOCUMENT
  installMainWindowNavigationGuard(contents, DOCUMENT)
  const window = { isDestroyed: () => false, webContents: contents }
  const event = { sender: contents, senderFrame: frame }
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const calls: string[] = []
  const controls = registerWorldsCliIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getStatus: () => ({ running: true, paired: true, expired: false, pairingPending: false, pairingId: null, sessionExpiresAt: 100 }),
    async revoke() {},
    async listPending() { calls.push('list'); await gate; return { ok: true, proposals: [] } },
    async getReview() { calls.push('review'); return { ok: true, reviewId: 'review' } },
    async reject() { calls.push('reject'); return { ok: true, status: 'rejected' } },
  }, { getWindow: () => window, trustedRendererUrl: DOCUMENT,
    dialog: { async showMessageBox() { return { response: 0 } } } })
  const list = handlers.get('workspace:worlds:cli:listPending')!
  const review = handlers.get('workspace:worlds:cli:getReview')!
  const reject = handlers.get('workspace:worlds:cli:reject')!
  assert.equal(handlers.has('workspace:worlds:cli:apply'), true)
  assert.deepEqual(await handlers.get('workspace:worlds:cli:apply')!(event, { proposalId: 'proposal_' + 'a'.repeat(48), reviewId: 'review_' + 'b'.repeat(48), attemptId: 'attempt_' + 'c'.repeat(48) }), { ok: false, code: 'UNAVAILABLE' })
  assert.deepEqual(await review({ ...event, senderFrame: { ...frame } }, { proposalId: 'proposal_' + 'a'.repeat(48) }), { ok: false, code: 'UNAUTHORIZED' })
  assert.deepEqual(await review(event, { proposalId: 'proposal_' + 'a'.repeat(48), batch: {} }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await review(event, { proposalId: 'proposal_' + 'a'.repeat(49) }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await reject(event, { proposalId: 'proposal_' + 'a'.repeat(48) }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(calls, [])
  const pending = list(event)
  for (let i = 0; i < 10 && calls.length === 0; i++) await Promise.resolve()
  assert.deepEqual(calls, ['list'])
  const before = getMainWindowDocumentEpoch(contents)
  contents.emit('did-start-navigation', { url: DOCUMENT, isMainFrame: true, isSameDocument: false })
  assert.equal(getMainWindowDocumentEpoch(contents), before + 1)
  release()
  assert.deepEqual(await pending, { ok: false, code: 'UNAUTHORIZED' })
  await controls.shutdown()
})

test('native reviewed Apply is cancel-default and displays every bounded change without truncation', async () => {
  const changes = Array.from({ length: 4 }, (_, index) => ({ field: `change-${index}`, before: `before-${index}`, after: `after-${index}` }))
  let displayed = ''
  const window = {} as never
  const accepted = await confirmWorldsCliApply(window, { async showMessageBox(_window, options) {
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0)
    displayed = options.detail
    return { response: 0 }
  } }, { complete: true, changes, warnings: ['warning-one', 'warning-two'] }, { projectId: 'project:one', sceneId: 'scene:one', revision: 4 })
  assert.equal(accepted, false)
  for (const change of changes) for (const value of Object.values(change)) assert.ok(displayed.includes(value), value)
  assert.ok(displayed.includes('warning-one') && displayed.includes('warning-two'))
  assert.ok(displayed.includes('Project: project:one') && displayed.includes('Base revision: 4'))
  assert.throws(() => confirmWorldsCliApply(window, { async showMessageBox() { throw new Error('Must not show') } },
    { complete: true, changes: Array.from({ length: 49 }, () => changes[0]), warnings: [] },
    { projectId: 'project:one', sceneId: 'scene:one', revision: 4 }))
})

test('trusted Main Apply IPC accepts only proposal/review IDs and gates native confirmation on document epoch', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const contents = new EventEmitter() as EventEmitter & { mainFrame: { url: string; origin: string }; getURL(): string }
  const frame = { url: DOCUMENT, origin: new URL(DOCUMENT).origin }
  contents.mainFrame = frame; contents.getURL = () => DOCUMENT
  installMainWindowNavigationGuard(contents, DOCUMENT)
  const window = { isDestroyed: () => false, webContents: contents }
  const event = { sender: contents, senderFrame: frame }
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let dialogCalls = 0; let repositoryCalls = 0
  registerWorldsCliIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getStatus: () => ({ running: true, paired: true, expired: false, pairingPending: false, pairingId: null, sessionExpiresAt: 100 }),
    async revoke() {},
    async apply(_request, confirm) {
      repositoryCalls++
      const accepted = await confirm({ complete: true, changes: [{ field: 'project.name', before: '"Before"', after: '"After"' }], warnings: [] },
        { projectId: 'project:one', sceneId: 'scene:one', revision: 4 })
      return accepted ? { ok: true, transactionId: 'tx:one', projectId: 'project:one', baseRevision: 4,
        newRevision: 5, snapshotSha256: 'a'.repeat(64) } : { ok: false, code: 'USER_DECLINED' }
    },
  }, { getWindow: () => window, trustedRendererUrl: DOCUMENT,
    dialog: { async showMessageBox(_window, options) { dialogCalls++; assert.equal(options.cancelId, 0); await gate; return { response: 1 } } } })
  const apply = handlers.get('workspace:worlds:cli:apply')!
  const payload = { proposalId: 'proposal_' + 'a'.repeat(48), reviewId: 'review_' + 'b'.repeat(48), attemptId: 'attempt_' + 'c'.repeat(48) }
  assert.deepEqual(await apply(event, { ...payload, batch: {} }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await apply({ ...event, senderFrame: { ...frame } }, payload), { ok: false, code: 'UNAUTHORIZED' })
  assert.equal(repositoryCalls, 0)
  const pending = apply(event, payload)
  for (let i = 0; i < 20 && !dialogCalls; i++) await Promise.resolve()
  assert.equal(dialogCalls, 1)
  contents.emit('did-start-navigation', { url: DOCUMENT, isMainFrame: true, isSameDocument: false })
  release()
  assert.deepEqual(await pending, { ok: false, code: 'AMBIGUOUS' })
  assert.equal(repositoryCalls, 1)
})

test('Apply intent cancellation is trusted, tombstones early delivery and serializes dialogs', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const contents = new EventEmitter() as EventEmitter & { mainFrame: { url: string; origin: string }; getURL(): string }
  const frame = { url: DOCUMENT, origin: new URL(DOCUMENT).origin }
  contents.mainFrame = frame; contents.getURL = () => DOCUMENT
  installMainWindowNavigationGuard(contents, DOCUMENT)
  const window = { isDestroyed: () => false, webContents: contents }
  const event = { sender: contents, senderFrame: frame }
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let dialogs = 0; let applies = 0
  registerWorldsCliIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getStatus: () => ({ running: true, paired: true, expired: false, pairingPending: false, pairingId: null, sessionExpiresAt: 100 }),
    async revoke() {},
    async apply(_request, confirm, assertIntentLive) {
      applies++
      try {
        assertIntentLive()
        const approved = await confirm({ complete: true, changes: [{ field: 'name', before: 'a', after: 'b' }], warnings: [] },
          { projectId: 'project:one', sceneId: 'scene:one', revision: 4 })
        assertIntentLive()
        return approved ? { ok: true } : { ok: false, code: 'USER_DECLINED' }
      } catch { return { ok: false, code: 'STALE' } }
    },
  }, { getWindow: () => window, trustedRendererUrl: DOCUMENT,
    dialog: { async showMessageBox() { dialogs++; await gate; return { response: 1 } } } })
  const apply = handlers.get('workspace:worlds:cli:apply')!
  const cancel = handlers.get('workspace:worlds:cli:cancelApplyIntent')!
  const ids = { proposalId: 'proposal_' + 'a'.repeat(48), reviewId: 'review_' + 'b'.repeat(48) }
  const early = 'attempt_' + '1'.repeat(48)
  assert.deepEqual(await cancel({ ...event, senderFrame: { ...frame } }, { attemptId: early }), { ok: false, code: 'UNAUTHORIZED' })
  assert.deepEqual(await cancel(event, { attemptId: early, extra: true }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await cancel(event, { attemptId: early }), { ok: true })
  assert.deepEqual(await apply(event, { ...ids, attemptId: early }), { ok: false, code: 'STALE' })
  assert.equal(applies, 0)
  const pending = apply(event, { ...ids, attemptId: 'attempt_' + '2'.repeat(48) })
  for (let i = 0; i < 20 && dialogs === 0; i++) await Promise.resolve()
  assert.equal(dialogs, 1)
  assert.deepEqual(await apply(event, { ...ids, attemptId: 'attempt_' + '3'.repeat(48) }), { ok: false, code: 'BUSY' })
  assert.deepEqual(await cancel(event, { attemptId: 'attempt_' + '2'.repeat(48) }), { ok: true })
  release()
  assert.deepEqual(await pending, { ok: false, code: 'STALE' })
  assert.equal(dialogs, 1)
})
