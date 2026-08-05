import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentSessionsStore } from './agentSessionsStore.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

test('renderer session state survives component unmount and switching does not issue a mutation', async () => {
  const calls: string[] = []
  const sessions = [
    { id: 's1', title: 'One', revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-08T00:00:00.000Z', messages: [], attachments: [] },
    { id: 's2', title: 'Two', revision: 1, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', expiresAt: '2026-08-09T00:00:00.000Z', messages: [], attachments: [] },
  ]
  const api = {
    async list() { calls.push('list'); return { sessions, activeSessionId: 's1', readOnly: false } },
    async read({ sessionId }: { sessionId: string }) { calls.push('read'); return sessions.find((s) => s.id === sessionId)! },
    async activate() { calls.push('activate'); return { sessions, activeSessionId: 's2', readOnly: false } },
  }
  const store = createAgentSessionsStore(api as never)
  await store.getState().initialize()
  await store.getState().switchSession('s2')
  assert.equal(store.getState().activeSession?.id, 's2')
  assert.deepEqual(calls, ['list', 'read', 'activate', 'read'])
})

test('out-of-order session reads cannot let an older switch overwrite the latest activation', async () => {
  const session = (id: string) => ({
    id, title: id, revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-08T00:00:00.000Z', messages: [], attachments: [],
  })
  const sessions = [session('s1'), session('s2'), session('s3')]
  const reads = { s2: deferred<(typeof sessions)[number]>(), s3: deferred<(typeof sessions)[number]>() }
  const readStarted = { s2: deferred<void>(), s3: deferred<void>() }
  const api = {
    async list() { return { sessions, activeSessionId: 's1', readOnly: false } },
    async activate({ sessionId }: { sessionId: string }) {
      return { sessions, activeSessionId: sessionId, readOnly: false }
    },
    async read({ sessionId }: { sessionId: string }) {
      if (sessionId === 's1') return sessions[0]
      const id = sessionId as 's2' | 's3'
      readStarted[id].resolve()
      return reads[id].promise
    },
  }
  const store = createAgentSessionsStore(api as never)
  await store.getState().initialize()

  const olderSwitch = store.getState().switchSession('s2')
  await readStarted.s2.promise
  const newerSwitch = store.getState().switchSession('s3')
  await readStarted.s3.promise
  reads.s3.resolve(sessions[2])
  await newerSwitch
  reads.s2.resolve(sessions[1])
  await olderSwitch

  assert.equal(store.getState().activeSession?.id, 's3')
})

test('clicking the current UI session cancels a pending switch and restores the durable active session', async () => {
  const session = (id: string) => ({
    id, title: id, revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-08T00:00:00.000Z', messages: [], attachments: [],
  })
  const sessions = [session('s1'), session('s2')]
  const delayedRead = deferred<(typeof sessions)[number]>()
  const delayedReadStarted = deferred<void>()
  const activateCalls: string[] = []
  let durableActiveSessionId = 's1'
  const api = {
    async list() { return { sessions, activeSessionId: durableActiveSessionId, readOnly: false } },
    async activate({ sessionId }: { sessionId: string }) {
      activateCalls.push(sessionId)
      durableActiveSessionId = sessionId
      return { sessions, activeSessionId: sessionId, readOnly: false }
    },
    async read({ sessionId }: { sessionId: string }) {
      if (sessionId === 's2') {
        delayedReadStarted.resolve()
        return delayedRead.promise
      }
      return sessions[0]
    },
  }
  const store = createAgentSessionsStore(api as never)
  await store.getState().initialize()

  const pendingSwitch = store.getState().switchSession('s2')
  await delayedReadStarted.promise
  const cancellation = store.getState().switchSession('s1')
  await cancellation
  const durableAfterCancellation = durableActiveSessionId
  delayedRead.resolve(sessions[1])
  await pendingSwitch

  assert.deepEqual(activateCalls, ['s2', 's1'])
  assert.equal(durableAfterCancellation, 's1')
  assert.equal(durableActiveSessionId, 's1')
  assert.equal(store.getState().activeSession?.id, 's1')
})

test('creating a session supersedes a delayed switch in both renderer and durable state', async () => {
  const session = (id: string, title = id) => ({
    id, title, revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-08T00:00:00.000Z', messages: [], attachments: [],
  })
  const records = new Map([['s1', session('s1')], ['s2', session('s2')]])
  const delayedRead = deferred<ReturnType<typeof session>>()
  const delayedReadStarted = deferred<void>()
  let durableActiveSessionId = 's1'
  const api = {
    async list() { return { sessions: [...records.values()], activeSessionId: durableActiveSessionId, readOnly: false } },
    async activate({ sessionId }: { sessionId: string }) {
      durableActiveSessionId = sessionId
      return this.list()
    },
    async read({ sessionId }: { sessionId: string }) {
      if (sessionId === 's2') {
        delayedReadStarted.resolve()
        return delayedRead.promise
      }
      return records.get(sessionId)!
    },
    async create({ title }: { title?: string }) {
      const created = session('s3', title)
      records.set(created.id, created)
      durableActiveSessionId = created.id
      return created
    },
  }
  const store = createAgentSessionsStore(api as never)
  await store.getState().initialize()

  const pendingSwitch = store.getState().switchSession('s2')
  await delayedReadStarted.promise
  await store.getState().createSession('Three')
  delayedRead.resolve(records.get('s2')!)
  await pendingSwitch

  assert.equal(durableActiveSessionId, 's3')
  assert.equal(store.getState().activeSession?.id, 's3')
})

test('deleting a pending durable target applies its fallback after the stale switch', async () => {
  const session = (id: string) => ({
    id, title: id, revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-08T00:00:00.000Z', messages: [], attachments: [],
  })
  const staleS2 = session('s2')
  const records = new Map([['s1', session('s1')], ['s2', staleS2]])
  const delayedRead = deferred<typeof staleS2>()
  const delayedReadStarted = deferred<void>()
  let durableActiveSessionId = 's1'
  const api = {
    async list() { return { sessions: [...records.values()], activeSessionId: durableActiveSessionId, readOnly: false } },
    async activate({ sessionId }: { sessionId: string }) {
      durableActiveSessionId = sessionId
      return this.list()
    },
    async read({ sessionId }: { sessionId: string }) {
      if (sessionId === 's2') {
        delayedReadStarted.resolve()
        return delayedRead.promise
      }
      return records.get(sessionId)!
    },
    async delete({ sessionId }: { sessionId: string }) {
      records.delete(sessionId)
      if (durableActiveSessionId === sessionId) durableActiveSessionId = 's1'
      return this.list()
    },
  }
  const store = createAgentSessionsStore(api as never)
  await store.getState().initialize()

  const pendingSwitch = store.getState().switchSession('s2')
  await delayedReadStarted.promise
  await store.getState().deleteSession('s2')
  delayedRead.resolve(staleS2)
  await pendingSwitch

  assert.equal(durableActiveSessionId, 's1')
  assert.equal(store.getState().activeSession?.id, 's1')
  assert.deepEqual(store.getState().sessions.map((item) => item.id), ['s1'])
})

test('writes target the immutable originating session even after history switches', async () => {
  const calls: Array<{ sessionId: string, content: string }> = []
  const session = (id: string, revision = 1) => ({
    id, title: id, revision, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-08T00:00:00.000Z', messages: [], attachments: [],
  })
  const records = new Map([['s1', session('s1')], ['s2', session('s2')]])
  let activeSessionId = 's1'
  const api = {
    async list() { return { sessions: [...records.values()], activeSessionId, readOnly: false } },
    async read({ sessionId }: { sessionId: string }) { return records.get(sessionId)! },
    async activate({ sessionId }: { sessionId: string }) { activeSessionId = sessionId; return this.list() },
    async appendMessage(request: { sessionId: string, expectedRevision: number, message: { content: string } }) {
      calls.push({ sessionId: request.sessionId, content: request.message.content })
      const current = records.get(request.sessionId)!
      const updated = { ...current, revision: current.revision + 1 }
      records.set(request.sessionId, updated)
      return updated
    },
  }
  const store = createAgentSessionsStore(api as never)
  await store.getState().initialize()
  await store.getState().switchSession('s2')
  await store.getState().appendMessage('s1', { id: 'reply', role: 'assistant', content: 'Origin reply' })
  assert.deepEqual(calls, [{ sessionId: 's1', content: 'Origin reply' }])
  assert.equal(store.getState().activeSession?.id, 's2')
})

test('same-session writes serialize and recover once from an optimistic revision conflict', async () => {
  const base = {
    id: 's1', title: 'One', revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-08T00:00:00.000Z', messages: [] as Array<{ id: string }>, attachments: [],
  }
  let current = base
  let attempts = 0
  let injectConflict = true
  const api = {
    async list() { return { sessions: [current], activeSessionId: 's1', readOnly: false } },
    async read() { return current },
    async appendMessage(request: { expectedRevision: number, message: { id: string } }) {
      attempts += 1
      if (injectConflict) {
        injectConflict = false
        current = { ...current, revision: current.revision + 1 }
        throw new Error('Agent session revision conflict.')
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (request.expectedRevision !== current.revision) throw new Error('Agent session revision conflict.')
      current = { ...current, revision: current.revision + 1, messages: [...current.messages, request.message] }
      return current
    },
  }
  const store = createAgentSessionsStore(api as never)
  await store.getState().initialize()
  await Promise.all([
    store.getState().appendMessage('s1', { id: 'one', role: 'user', content: 'One' }),
    store.getState().appendMessage('s1', { id: 'two', role: 'user', content: 'Two' }),
  ])
  assert.deepEqual(current.messages.map((message) => message.id), ['one', 'two'])
  assert.equal(attempts, 3)
})

test('repeated optimistic conflicts surface a recoverable user-facing error', async () => {
  const session = {
    id: 's1', title: 'One', revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-08T00:00:00.000Z', messages: [], attachments: [],
  }
  const api = {
    async list() { return { sessions: [session], activeSessionId: 's1', readOnly: false } },
    async read() { return session },
    async appendMessage() { throw new Error('Agent session revision conflict.') },
  }
  const store = createAgentSessionsStore(api as never)
  await store.getState().initialize()
  await assert.rejects(
    store.getState().appendMessage('s1', { id: 'one', role: 'user', content: 'One' }),
    /please retry your message/i,
  )
})

test('rename targets the session captured when editing began, not the later active session', async () => {
  const session = (id: string) => ({
    id, title: id, revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-08T00:00:00.000Z', messages: [], attachments: [],
  })
  const records = new Map([['s1', session('s1')], ['s2', session('s2')]])
  let activeSessionId = 's1'
  const renamed: string[] = []
  const api = {
    async list() { return { sessions: [...records.values()], activeSessionId, readOnly: false } },
    async read({ sessionId }: { sessionId: string }) { return records.get(sessionId)! },
    async activate({ sessionId }: { sessionId: string }) { activeSessionId = sessionId; return this.list() },
    async rename(request: { sessionId: string, title: string }) {
      renamed.push(request.sessionId)
      const updated = { ...records.get(request.sessionId)!, title: request.title, revision: 2 }
      records.set(request.sessionId, updated)
      return updated
    },
  }
  const store = createAgentSessionsStore(api as never)
  await store.getState().initialize()
  const editingSessionId = 's1'
  await store.getState().switchSession('s2')
  await store.getState().renameSession(editingSessionId, 'Renamed first')
  assert.deepEqual(renamed, ['s1'])
  assert.equal(store.getState().activeSession?.id, 's2')
  assert.equal(records.get('s1')?.title, 'Renamed first')
})
