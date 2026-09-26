import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorldsCliReadinessResponder, type WorldsCliReadinessView } from './worldsCliReadinessResponder.ts'

const REQUEST = {
  nonce: 'a'.repeat(48),
  intentId: `intent_${'b'.repeat(48)}`,
  projectKey: `world-${'c'.repeat(32)}`,
  projectId: 'project:one',
  sceneId: 'scene:one',
  baseRevision: 9,
  editorEpoch: 4,
  expiresAt: 10_000,
}

function readyView(): WorldsCliReadinessView {
  return { mounted: true, playLifecycle: 'edit', editorLifecycle: 'ready', projectKey: REQUEST.projectKey,
    projectId: REQUEST.projectId, sceneId: REQUEST.sceneId, revision: REQUEST.baseRevision, editorEpoch: REQUEST.editorEpoch }
}

test('mounted readiness responder refuses Play, unmounted, non-ready and wrong scene or revision', async () => {
  for (const [change, reason] of [
    [{ mounted: false }, 'unmounted'],
    [{ playLifecycle: 'playing' }, 'play_active'],
    [{ editorLifecycle: 'loading' }, 'editor_not_ready'],
    [{ sceneId: 'scene:other' }, 'scope_mismatch'],
    [{ revision: 10 }, 'scope_mismatch'],
  ] as const) {
    let callback!: (request: typeof REQUEST) => void
    const replies: unknown[] = []
    const responder = createWorldsCliReadinessResponder({
      cli: { onDirectEditReadinessRequest(cb) { callback = cb; return () => undefined },
        async respondDirectEditReadiness(value) { replies.push(value); return { ok: true } },
        async cancelDirectEditReadiness() { throw new Error('Nothing was ready') } },
      readView: () => ({ ...readyView(), ...change }) as WorldsCliReadinessView,
      subscribeEditor: () => () => undefined,
      subscribePlay: () => () => undefined,
      now: () => 1,
    })
    callback(REQUEST)
    await Promise.resolve()
    assert.deepEqual(replies, [{ nonce: REQUEST.nonce, intentId: REQUEST.intentId, status: 'REFUSED', reason }])
    responder.dispose()
  }
})

test('readiness is nonvisual and a state change cancels the exact in-flight correlation', async () => {
  let callback!: (request: typeof REQUEST) => void
  let editorChange: () => void = () => undefined
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const replies: unknown[] = []
  const cancellations: unknown[] = []
  let view = readyView()
  const responder = createWorldsCliReadinessResponder({
    cli: { onDirectEditReadinessRequest(cb) { callback = cb; return () => undefined },
      async respondDirectEditReadiness(value) { replies.push(value); await gate; return { ok: true } },
      async cancelDirectEditReadiness(value) { cancellations.push(value); return { ok: true } } },
    readView: () => view,
    subscribeEditor(listener) { editorChange = listener; return () => undefined },
    subscribePlay: () => () => undefined,
    now: () => 1,
  })
  callback(REQUEST)
  await Promise.resolve()
  assert.deepEqual(replies, [{ nonce: REQUEST.nonce, intentId: REQUEST.intentId, status: 'READY' }])
  view = { ...view, revision: 10 }
  editorChange()
  assert.deepEqual(cancellations, [{ nonce: REQUEST.nonce, intentId: REQUEST.intentId }])
  release()
  await Promise.resolve()
  responder.dispose()
})

test('expired and competing readiness requests are bounded refusals', async () => {
  let callback!: (request: typeof REQUEST) => void
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const replies: unknown[] = []
  const responder = createWorldsCliReadinessResponder({
    cli: { onDirectEditReadinessRequest(cb) { callback = cb; return () => undefined },
      async respondDirectEditReadiness(value) { replies.push(value); if ((value as { status: string }).status === 'READY') await gate; return { ok: true } },
      async cancelDirectEditReadiness() { return { ok: true } } },
    readView: readyView,
    subscribeEditor: () => () => undefined,
    subscribePlay: () => () => undefined,
    now: () => 20_000,
  })
  callback(REQUEST)
  callback({ ...REQUEST, nonce: 'd'.repeat(48), intentId: `intent_${'e'.repeat(48)}`, expiresAt: 30_000 })
  await Promise.resolve()
  assert.equal((replies[0] as { reason: string }).reason, 'expired')
  assert.equal((replies[1] as { status: string }).status, 'READY')
  callback({ ...REQUEST, nonce: 'f'.repeat(48), intentId: `intent_${'0'.repeat(48)}`, expiresAt: 30_000 })
  await Promise.resolve()
  assert.equal((replies[2] as { reason: string }).reason, 'busy')
  release()
  responder.dispose()
})
