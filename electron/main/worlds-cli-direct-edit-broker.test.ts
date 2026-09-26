import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalWorldProjectSnapshotPayload } from '../../src/areas/worlds/core/worldSnapshotDigest.ts'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { registerWorldsCliDirectEditBroker } from './worlds-cli-direct-edit-broker.ts'
import type { WorldsCliDirectEditReservation } from './worlds-cli-transport.ts'
import { installMainWindowNavigationGuard } from './worlds-cli-window-trust.ts'

const DOCUMENT = 'http://127.0.0.1:5173/'
const PROJECT_KEY = `world-${'a'.repeat(32)}`
const PROJECT_ID = 'project:one'
const SCENE_ID = 'scene:one'

type Handler = (event: unknown, value: unknown) => Promise<unknown>

function snapshot(revision: number, marker = 'candidate'): WorldProjectSnapshotV1 {
  return {
    project: {
      schema: 'modly.world-project.v1', projectId: PROJECT_ID, name: marker, revision,
      resources: [], scenes: [{ id: SCENE_ID, name: 'Scene', documentPath: 'scenes/one.json' }],
      startSceneId: SCENE_ID, inputActions: [],
      graphicsProfiles: [{ id: 'balanced', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'fxaa' }],
      activeGraphicsProfileId: 'balanced',
    },
    scenes: [{
      schema: 'modly.world-scene.v1', projectId: PROJECT_ID, sceneId: SCENE_ID, name: 'Scene',
      environment: { backgroundColor: '#17191d', ambientIntensity: 0.3 }, entities: [], sequences: [],
    }],
  }
}

function hash(value: WorldProjectSnapshotV1): string {
  return createHash('sha256').update(canonicalWorldProjectSnapshotPayload(value)).digest('hex')
}

async function harness(options: {
  timeoutMs?: number
  readiness?: 'READY' | 'REFUSED'
  commit?: 'success' | 'pre-error' | 'post-error' | 'post-ambiguous' | 'hold-after-journal'
  firstDisk?: 'success' | 'mismatch'
  secondDisk?: 'success' | 'mismatch'
  terminalLimit?: number
  holdFinish?: boolean
} = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'modly-worlds-direct-edit-c2-'))
  const handlers = new Map<string, Handler>()
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  let currentWindow: typeof window | null
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
  currentWindow = window
  let now = 1_000
  let releaseCommit: (() => void) | null = null
  let releaseFinish: (() => void) | null = null
  let journalReachedResolve: (() => void) | null = null
  const journalReached = new Promise<void>((resolve) => { journalReachedResolve = resolve })
  const candidate = snapshot(4)
  const mismatch = snapshot(4, 'mismatch')
  const candidateSha256 = hash(candidate)
  const calls = { commit: 0, verifyDisk: 0, advanceScope: 0, finish: 0, open: 0, readiness: 0 }
  let sessionIndex = 1

  const makeReservation = (): WorldsCliDirectEditReservation => {
    const sessionId = 'a'.repeat(32)
    const proposalId = `proposal_${sessionIndex.toString(16).repeat(48)}`
    const transactionId = sessionIndex.toString(16).repeat(32)
    sessionIndex += 1
    const receipt = Object.freeze({ transactionId, projectId: PROJECT_ID, newRevision: 4, snapshotSha256: candidateSha256 })
    const reservation: WorldsCliDirectEditReservation = {
      source: Object.freeze({
        proposalId, transactionId, digest: 'b'.repeat(64), beforeSnapshotSha256: 'c'.repeat(64),
        candidateSnapshotSha256: candidateSha256, expiresAt: 60_000,
        scope: Object.freeze({ sessionId, generation: 4, sessionExpiresAt: 120_000,
          projectKey: PROJECT_KEY, projectId: PROJECT_ID, sceneId: SCENE_ID, editorEpoch: 7, revision: 3, mode: 'edit' as const }),
      }),
      commit: async (callbacks: Parameters<WorldsCliDirectEditReservation['commit']>[0]) => {
        calls.commit += 1
        if (options.commit === 'pre-error') return { ok: false, code: 'UNAVAILABLE' }
        callbacks.assertLive()
        callbacks.onJournalStart()
        journalReachedResolve?.()
        if (options.commit === 'hold-after-journal') await new Promise<void>((resolve) => { releaseCommit = resolve })
        callbacks.assertLive()
        if (options.commit === 'post-error') return { ok: false, code: 'UNAVAILABLE' }
        if (options.commit === 'post-ambiguous') return { ok: false, code: 'AMBIGUOUS' }
        return { ok: true, receipt }
      },
      verifyDisk: async () => {
        calls.verifyDisk += 1
        return options.firstDisk === 'mismatch' ? { ok: false, code: 'AMBIGUOUS' } : { ok: true }
      },
      advanceScope: (candidateReceipt: Parameters<WorldsCliDirectEditReservation['advanceScope']>[0]) => {
        calls.advanceScope += 1
        return candidateReceipt.transactionId === transactionId
          ? { ok: true, revision: candidateReceipt.newRevision }
          : { ok: false, code: 'AMBIGUOUS' }
      },
      finish: async () => {
        calls.finish += 1
        if (options.holdFinish) await new Promise<void>((resolve) => { releaseFinish = resolve })
        return { ok: true }
      },
    }
    return Object.freeze(reservation)
  }

  const broker = registerWorldsCliDirectEditBroker(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      getWindow: () => currentWindow,
      trustedRendererUrl: DOCUMENT,
      getWorkspaceRoot: () => workspaceRoot,
      readiness: { request: async () => { calls.readiness += 1; return options.readiness === 'REFUSED'
        ? { status: 'REFUSED' as const, reason: 'editor_not_ready' as const }
        : { status: 'READY' as const } } },
      repository: { open: async () => {
        calls.open += 1
        const value = options.secondDisk === 'mismatch' ? mismatch : candidate
        return { ok: true as const, value: { status: 'ready' as const, projectKey: PROJECT_KEY,
          snapshot: value, durabilityWarnings: [] } }
      } },
      now: () => now,
      timeoutMs: options.timeoutMs ?? 5_000,
      terminalLimit: options.terminalLimit,
    },
  )
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame })
  const execute = async (reservation = makeReservation()) => {
    const result = await broker.execute(reservation)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('execute failed')
    const request = sent.at(-1)?.payload
    assert.ok(request)
    return { ...result, request: request!, reservation }
  }
  const cleanup = async () => { await broker.shutdown(); await rm(workspaceRoot, { recursive: true, force: true }) }
  return { broker, calls, cleanup, contents, event, execute, frame, handlers, journalReached, makeReservation,
    get now() { return now }, set now(value: number) { now = value },
    releaseCommit: () => releaseCommit?.(), sent, window,
    releaseFinish: () => releaseFinish?.(),
    replaceWindow(value: typeof window | null) { currentWindow = value },
  }
}

test('readiness and edit namespaces stay distinct and direct request/IPC payloads are exact and path-free', async (t) => {
  const h = await harness()
  t.after(h.cleanup)
  const active = await h.execute()
  assert.match(String(active.request.editIntent), /^edit_[a-f0-9]{48}$/)
  assert.equal(String(active.request.editIntent).startsWith('intent_'), false)
  assert.deepEqual(Object.keys(active.request).sort(), [
    'baseRevision', 'editIntent', 'editorEpoch', 'expiresAt', 'nonce', 'projectId', 'projectKey', 'sceneId',
  ])
  const serialized = JSON.stringify(active.request)
  for (const forbidden of [h.makeReservation().source.proposalId, 'commands', 'authority', 'workspaceRoot', '/tmp/', 'intentId']) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }
  const commit = h.handlers.get('workspace:worlds:cli:directEditCommit')!
  assert.deepEqual(await commit(h.event(), { nonce: active.request.nonce, editIntent: active.request.editIntent, extra: true }),
    { ok: false, code: 'INVALID_REQUEST' })
  const result = await commit(h.event(), { nonce: active.request.nonce, editIntent: active.request.editIntent })
  assert.deepEqual(result, { ok: true, receipt: { transactionId: active.reservation.source.transactionId,
    projectId: PROJECT_ID, newRevision: 4, snapshotSha256: active.reservation.source.candidateSnapshotSha256 } })
  assert.deepEqual(Object.keys((result as { receipt: object }).receipt).sort(),
    ['newRevision', 'projectId', 'snapshotSha256', 'transactionId'])
})

test('forged frame, same-URL replacement frame, navigation, window loss, and renderer loss settle once', async () => {
  for (const mode of ['forged', 'replacement', 'navigation', 'window', 'renderer'] as const) {
    const h = await harness()
    const active = await h.execute()
    if (mode === 'forged') {
      await h.handlers.get('workspace:worlds:cli:directEditCommit')!(
        { sender: h.contents, senderFrame: { ...h.frame } }, { nonce: active.request.nonce, editIntent: active.request.editIntent })
    } else if (mode === 'replacement') {
      h.contents.mainFrame = { ...h.frame }
      await h.handlers.get('workspace:worlds:cli:directEditCommit')!(h.event(),
        { nonce: active.request.nonce, editIntent: active.request.editIntent })
      h.contents.mainFrame = h.frame
    } else if (mode === 'navigation') {
      h.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    } else if (mode === 'window') {
      h.window.emit('close')
    } else {
      h.contents.emit('render-process-gone')
    }
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.calls.commit, 0, mode)
    assert.equal(h.calls.finish, 1, mode)
    assert.deepEqual(h.broker.lookup(String(active.request.editIntent)), mode === 'navigation'
      ? { ok: false, code: 'NOT_FOUND' }
      : { ok: true, status: 'STALE' }, mode)
    await h.broker.shutdown()
    assert.equal(h.calls.finish, 1, `${mode}: one-shot cleanup`)
    await h.cleanup()
  }
  assert.ok(true)
})

test('a lost commit reply cannot retry the repository commit', async (t) => {
  const h = await harness()
  t.after(h.cleanup)
  const active = await h.execute()
  const commit = h.handlers.get('workspace:worlds:cli:directEditCommit')!
  const correlation = { nonce: active.request.nonce, editIntent: active.request.editIntent }
  await commit(h.event(), correlation)
  assert.equal(h.calls.commit, 1)
  assert.deepEqual(await commit(h.event(), correlation), { ok: false, code: 'AMBIGUOUS' })
  assert.equal(h.calls.commit, 1)
})

test('cancellation/error/timeout are STALE before journal and AMBIGUOUS after journal with tombstone before ACK', async () => {
  const pre = await harness({ commit: 'pre-error' })
  const preActive = await pre.execute()
  assert.deepEqual(await pre.handlers.get('workspace:worlds:cli:directEditCancel')!(pre.event(),
    { nonce: preActive.request.nonce, editIntent: preActive.request.editIntent }), { ok: true, status: 'STALE' })
  assert.deepEqual(pre.broker.lookup(String(preActive.request.editIntent)), { ok: true, status: 'STALE' })
  await pre.cleanup()

  for (const mode of ['cancel', 'error', 'timeout'] as const) {
    const h = await harness({ commit: mode === 'error' ? 'post-error' : 'hold-after-journal', timeoutMs: mode === 'timeout' ? 15 : 5_000 })
    const active = await h.execute()
    const commitPromise = h.handlers.get('workspace:worlds:cli:directEditCommit')!(h.event(),
      { nonce: active.request.nonce, editIntent: active.request.editIntent })
    await h.journalReached
    if (mode === 'cancel') {
      const ack = await h.handlers.get('workspace:worlds:cli:directEditCancel')!(h.event(),
        { nonce: active.request.nonce, editIntent: active.request.editIntent })
      assert.deepEqual(ack, { ok: true, status: 'AMBIGUOUS' })
      assert.equal(h.calls.finish, 1, 'tombstone cleanup starts before cancel ACK')
    } else if (mode === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    h.releaseCommit()
    await commitPromise
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(h.broker.lookup(String(active.request.editIntent)), { ok: true, status: 'AMBIGUOUS' }, mode)
    assert.equal(h.calls.finish, 1, mode)
    await h.cleanup()
  }
  assert.ok(true)
})

test('post-journal navigation, window, renderer, and adoption-ACK loss remain AMBIGUOUS', async () => {
  for (const mode of ['navigation', 'window', 'renderer'] as const) {
    const h = await harness({ commit: 'hold-after-journal' })
    const active = await h.execute()
    const commitPromise = h.handlers.get('workspace:worlds:cli:directEditCommit')!(h.event(),
      { nonce: active.request.nonce, editIntent: active.request.editIntent })
    await h.journalReached
    if (mode === 'navigation') h.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    else if (mode === 'window') h.window.emit('close')
    else h.contents.emit('render-process-gone')
    h.releaseCommit()
    assert.deepEqual(await commitPromise, { ok: false, code: 'AMBIGUOUS' }, mode)
    assert.equal(h.calls.finish, 1, mode)
    await h.cleanup()
  }

  const ackLoss = await harness({ timeoutMs: 10 })
  const active = await ackLoss.execute()
  assert.equal((await ackLoss.handlers.get('workspace:worlds:cli:directEditCommit')!(ackLoss.event(),
    { nonce: active.request.nonce, editIntent: active.request.editIntent }) as { ok: boolean }).ok, true)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(ackLoss.broker.lookup(String(active.request.editIntent)), { ok: true, status: 'AMBIGUOUS' })
  assert.equal(ackLoss.calls.finish, 1)
  await ackLoss.cleanup()
})

test('first and independent second disk mismatches both block APPLIED and scope advancement', async () => {
  const first = await harness({ firstDisk: 'mismatch' })
  const firstActive = await first.execute()
  const firstCommit = await first.handlers.get('workspace:worlds:cli:directEditCommit')!(first.event(),
    { nonce: firstActive.request.nonce, editIntent: firstActive.request.editIntent })
  assert.deepEqual(firstCommit, { ok: false, code: 'AMBIGUOUS' })
  assert.equal(first.calls.verifyDisk, 1)
  assert.equal(first.calls.open, 0)
  assert.equal(first.calls.advanceScope, 0)
  await first.cleanup()

  const second = await harness({ secondDisk: 'mismatch' })
  const secondActive = await second.execute()
  await second.handlers.get('workspace:worlds:cli:directEditCommit')!(second.event(),
    { nonce: secondActive.request.nonce, editIntent: secondActive.request.editIntent })
  const receipt = { transactionId: secondActive.reservation.source.transactionId, newRevision: 4,
    snapshotSha256: secondActive.reservation.source.candidateSnapshotSha256 }
  assert.deepEqual(await second.handlers.get('workspace:worlds:cli:directEditAdopt')!(second.event(),
    { nonce: secondActive.request.nonce, editIntent: secondActive.request.editIntent, ...receipt }),
  { ok: false, code: 'AMBIGUOUS' })
  assert.equal(second.calls.verifyDisk, 1)
  assert.equal(second.calls.open, 1)
  assert.equal(second.calls.advanceScope, 0)
  assert.deepEqual(second.broker.lookup(String(secondActive.request.editIntent)), { ok: true, status: 'AMBIGUOUS' })
  await second.cleanup()
  assert.ok(true)
})

test('only exact adoption after both disk proofs can synthetically settle the C2 protocol APPLIED', async (t) => {
  for (const wrong of ['nonce', 'transactionId', 'newRevision', 'snapshotSha256'] as const) {
    const h = await harness()
    const active = await h.execute()
    await h.handlers.get('workspace:worlds:cli:directEditCommit')!(h.event(),
      { nonce: active.request.nonce, editIntent: active.request.editIntent })
    const adopt = { nonce: active.request.nonce, editIntent: active.request.editIntent,
      transactionId: active.reservation.source.transactionId, newRevision: 4,
      snapshotSha256: active.reservation.source.candidateSnapshotSha256 }
    if (wrong === 'nonce') adopt.nonce = 'f'.repeat(48)
    else if (wrong === 'transactionId') adopt.transactionId = 'f'.repeat(32)
    else if (wrong === 'newRevision') adopt.newRevision = 9
    else adopt.snapshotSha256 = 'f'.repeat(64)
    assert.deepEqual(await h.handlers.get('workspace:worlds:cli:directEditAdopt')!(h.event(), adopt),
      { ok: false, code: 'AMBIGUOUS' }, wrong)
    assert.equal(h.calls.advanceScope, 0, wrong)
    await h.cleanup()
  }

  const h = await harness()
  t.after(h.cleanup)
  const active = await h.execute()
  await h.handlers.get('workspace:worlds:cli:directEditCommit')!(h.event(),
    { nonce: active.request.nonce, editIntent: active.request.editIntent })
  assert.deepEqual(h.broker.lookup(String(active.request.editIntent)), { ok: false, code: 'BUSY' })
  const adopted = await h.handlers.get('workspace:worlds:cli:directEditAdopt')!(h.event(), {
    nonce: active.request.nonce, editIntent: active.request.editIntent,
    transactionId: active.reservation.source.transactionId, newRevision: 4,
    snapshotSha256: active.reservation.source.candidateSnapshotSha256,
  })
  assert.deepEqual(adopted, { ok: true, status: 'APPLIED' })
  assert.equal(h.calls.verifyDisk, 1)
  assert.equal(h.calls.open, 1)
  assert.equal(h.calls.advanceScope, 1)
  assert.deepEqual(h.broker.lookup(String(active.request.editIntent)), { ok: true, status: 'APPLIED' })
})

test('terminal lookup is redacted, bounded, foreign-scope hidden, and side-effect free', async (t) => {
  const h = await harness({ terminalLimit: 2 })
  t.after(h.cleanup)
  const ids: string[] = []
  const correlations: Array<{ nonce: unknown; editIntent: unknown }> = []
  for (let index = 0; index < 3; index += 1) {
    const active = await h.execute()
    ids.push(String(active.request.editIntent))
    correlations.push({ nonce: active.request.nonce, editIntent: active.request.editIntent })
    await h.handlers.get('workspace:worlds:cli:directEditCancel')!(h.event(),
      { nonce: active.request.nonce, editIntent: active.request.editIntent })
    await new Promise((resolve) => setImmediate(resolve))
  }
  const before = { ...h.calls }
  assert.deepEqual(h.broker.lookup(ids[0]), { ok: false, code: 'NOT_FOUND' })
  const result = h.broker.lookup(ids[2])
  assert.deepEqual(result, { ok: true, status: 'STALE' })
  assert.equal(JSON.stringify(result).includes(PROJECT_KEY), false)
  assert.deepEqual(h.calls, before)

  const terminalCalls = async (event: unknown, correlation: { nonce: unknown; editIntent: unknown }) => Promise.all([
    h.handlers.get('workspace:worlds:cli:directEditCommit')!(event, correlation),
    h.handlers.get('workspace:worlds:cli:directEditCancel')!(event, correlation),
    h.handlers.get('workspace:worlds:cli:directEditAdopt')!(event, { ...correlation,
      transactionId: 'f'.repeat(32), newRevision: 4, snapshotSha256: 'e'.repeat(64) }),
  ])
  assert.deepEqual(await terminalCalls(h.event(), { ...correlations[2], nonce: '9'.repeat(48) }), [
    { ok: false, code: 'NOT_FOUND' }, { ok: false, code: 'NOT_FOUND' }, { ok: false, code: 'NOT_FOUND' },
  ], 'wrong nonce cannot use terminal IPC as a status oracle')
  assert.deepEqual(await terminalCalls(h.event(), correlations[2]), [
    { ok: false, code: 'STALE' }, { ok: false, code: 'STALE' }, { ok: false, code: 'STALE' },
  ], 'the exact captured caller may receive the bounded terminal result')
  assert.deepEqual(h.calls, before, 'terminal callbacks are read-only and cannot retry')

  h.contents.mainFrame = { ...h.frame }
  assert.deepEqual(await terminalCalls(h.event(), correlations[2]), [
    { ok: false, code: 'NOT_FOUND' }, { ok: false, code: 'NOT_FOUND' }, { ok: false, code: 'NOT_FOUND' },
  ], 'same-URL replacement frame cannot recover terminal status')
  assert.deepEqual(h.broker.lookup(ids[2]), { ok: false, code: 'NOT_FOUND' })
  h.contents.mainFrame = h.frame

  h.replaceWindow(null)
  assert.deepEqual(h.broker.lookup(ids[2]), { ok: false, code: 'NOT_FOUND' })
  assert.deepEqual(await terminalCalls(h.event(), correlations[2]), [
    { ok: false, code: 'NOT_FOUND' }, { ok: false, code: 'NOT_FOUND' }, { ok: false, code: 'NOT_FOUND' },
  ], 'lost window trust has the same hiding behavior as lookup')
  assert.deepEqual(h.calls, before)

  const pending = await harness({ holdFinish: true })
  const active = await pending.execute()
  const cancellation = pending.handlers.get('workspace:worlds:cli:directEditCancel')!(pending.event(),
    { nonce: active.request.nonce, editIntent: active.request.editIntent })
  assert.deepEqual(pending.broker.lookup(String(active.request.editIntent)), { ok: false, code: 'BUSY' },
    'the active slot remains BUSY until one-shot finish settles')
  pending.releaseFinish()
  await cancellation
  assert.deepEqual(pending.broker.lookup(String(active.request.editIntent)), { ok: true, status: 'STALE' })
  await pending.cleanup()
})

test('editor leave, revoke, navigation, close, renderer-gone, timeout, and shutdown settle and finish exactly once', async () => {
  for (const reason of ['editor_left', 'revoke', 'navigation', 'close', 'renderer_gone', 'timeout', 'shutdown'] as const) {
    const h = await harness({ timeoutMs: reason === 'timeout' ? 10 : 5_000 })
    const active = await h.execute()
    if (reason === 'navigation') h.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    else if (reason === 'close') h.window.emit('closed')
    else if (reason === 'renderer_gone') h.contents.emit('destroyed')
    else if (reason === 'timeout') await new Promise((resolve) => setTimeout(resolve, 20))
    else if (reason === 'shutdown') await h.broker.shutdown()
    else h.broker.cancelActive(reason)
    h.broker.cancelActive(reason)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.calls.finish, 1, reason)
    if (reason !== 'shutdown') {
      assert.deepEqual(h.broker.lookup(String(active.request.editIntent)),
        reason === 'editor_left' || reason === 'revoke' || reason === 'navigation'
        ? { ok: false, code: 'NOT_FOUND' }
        : { ok: true, status: 'STALE' }, reason)
      if (reason === 'editor_left' || reason === 'revoke') {
        const correlation = { nonce: active.request.nonce, editIntent: active.request.editIntent }
        assert.deepEqual(await h.handlers.get('workspace:worlds:cli:directEditCommit')!(h.event(), correlation),
          { ok: false, code: 'NOT_FOUND' }, reason)
        assert.deepEqual(await h.handlers.get('workspace:worlds:cli:directEditCancel')!(h.event(), correlation),
          { ok: false, code: 'NOT_FOUND' }, reason)
        assert.deepEqual(await h.handlers.get('workspace:worlds:cli:directEditAdopt')!(h.event(), { ...correlation,
          transactionId: active.reservation.source.transactionId, newRevision: 4,
          snapshotSha256: active.reservation.source.candidateSnapshotSha256 }),
        { ok: false, code: 'NOT_FOUND' }, reason)
        assert.equal(h.calls.commit, 0, `${reason}: terminal callbacks cannot retry`)
      }
    }
    await h.cleanup()
  }

  for (const terminalStatus of ['STALE', 'AMBIGUOUS', 'APPLIED'] as const) {
    for (const reason of ['editor_left', 'revoke', 'shutdown'] as const) {
      const h = await harness({ firstDisk: terminalStatus === 'AMBIGUOUS' ? 'mismatch' : 'success' })
      const active = await h.execute()
      const correlation = { nonce: active.request.nonce, editIntent: active.request.editIntent }
      const adopt = { ...correlation, transactionId: active.reservation.source.transactionId, newRevision: 4,
        snapshotSha256: active.reservation.source.candidateSnapshotSha256 }
      if (terminalStatus === 'STALE') {
        await h.handlers.get('workspace:worlds:cli:directEditCancel')!(h.event(), correlation)
      } else {
        await h.handlers.get('workspace:worlds:cli:directEditCommit')!(h.event(), correlation)
        if (terminalStatus === 'APPLIED') {
          await h.handlers.get('workspace:worlds:cli:directEditAdopt')!(h.event(), adopt)
        }
      }
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(h.broker.lookup(String(active.request.editIntent)), { ok: true, status: terminalStatus },
        `${terminalStatus}/${reason}: exact caller can observe retained terminal state before lifecycle revocation`)
      assert.deepEqual(await h.handlers.get('workspace:worlds:cli:directEditCommit')!(h.event(), correlation),
        { ok: false, code: terminalStatus === 'APPLIED' ? 'AMBIGUOUS' : terminalStatus },
        `${terminalStatus}/${reason}: exact terminal commit before revoke`)
      const before = { ...h.calls }

      if (reason === 'shutdown') await h.broker.shutdown()
      else assert.equal(h.broker.cancelActive(reason), null, `${terminalStatus}/${reason}: edit already inactive`)

      assert.deepEqual(h.broker.lookup(String(active.request.editIntent)), { ok: false, code: 'NOT_FOUND' },
        `${terminalStatus}/${reason}: lookup hidden after inactive lifecycle revocation`)
      assert.deepEqual(await h.handlers.get('workspace:worlds:cli:directEditCommit')!(h.event(), correlation),
        { ok: false, code: 'NOT_FOUND' }, `${terminalStatus}/${reason}: terminal commit hidden`)
      assert.deepEqual(await h.handlers.get('workspace:worlds:cli:directEditCancel')!(h.event(), correlation),
        { ok: false, code: 'NOT_FOUND' }, `${terminalStatus}/${reason}: terminal cancel hidden`)
      assert.deepEqual(await h.handlers.get('workspace:worlds:cli:directEditAdopt')!(h.event(), adopt),
        { ok: false, code: 'NOT_FOUND' }, `${terminalStatus}/${reason}: terminal adopt hidden`)
      assert.deepEqual(h.calls, before, `${terminalStatus}/${reason}: lifecycle visibility change is side-effect free`)
      await h.cleanup()
    }
  }
  assert.ok(true)
})

test('production composition uses the bounded dispatcher and mounted listener without UDS/Python mutation ops; reviewed Apply remains separate', async () => {
  const [ipc, transport, python, controller, workbench] = await Promise.all([
    readFile(new URL('./ipc-handlers.ts', import.meta.url), 'utf8'),
    readFile(new URL('./worlds-cli-transport.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../tools/modly-cli/agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../../src/areas/worlds/editor/worldEditorController.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/areas/worlds/components/WorldsWorkbench.tsx', import.meta.url), 'utf8'),
  ])
  assert.equal(/directEditBroker\s*\.\s*execute\s*\(/.test(ipc), false)
  assert.match(ipc, /createWorldsCliDirectEditDispatch\(\(\) => worldsCliTransport, directEditBroker\)/)
  assert.equal(/['"](?:edit|edit-status)['"]/.test(transport.match(/ALLOWED_[\s\S]{0,300}/)?.[0] ?? ''), false)
  assert.equal(/\b(?:edit|edit-status)\b/.test(python.match(/SUPPORTED_[\s\S]{0,500}/)?.[0] ?? ''), false)
  assert.equal(controller.includes('commitDirectEdit'), false)
  assert.equal(workbench.includes('onDirectEditRequest'), true)
  assert.match(workbench, /controller\.applyScopedCliIntent\(request\)/)
  assert.match(ipc, /worldsCliTransport\?\.apply\(request, confirm, assertIntentLive\)/)
})

test('direct-edit broker suite is explicitly governed by both runner inventories', async () => {
  const [runner, contract] = await Promise.all([
    readFile(new URL('../../scripts/run-node-tests.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/test-runner-contract.test.mjs', import.meta.url), 'utf8'),
  ])
  const file = 'electron/main/worlds-cli-direct-edit-broker.test.ts'
  assert.equal(runner.split(file).length - 1, 1)
  assert.equal(contract.split(file).length - 1, 1)
})
