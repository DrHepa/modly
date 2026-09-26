import assert from 'node:assert/strict'
import test from 'node:test'

import { WORLD_COMMAND_BATCH_SCHEMA } from '../../src/areas/worlds/core/worldModel.ts'
import { WORLD_PROJECT_CHANNELS, type WorldProjectsApi } from '../../src/shared/types/worldProjects.ts'
import { registerWorldProjectsIpcHandlers, type WorldProjectsRepositoryLike } from './world-projects-ipc.ts'

test('registers the exact eight handlers once and rejects untrusted senders', async () => {
  const handlers = new Map<string, (event: unknown, request?: unknown) => unknown>()
  const repository = stubRepository()
  registerWorldProjectsIpcHandlers({
    handle: (channel, handler) => {
      assert.equal(handlers.has(channel), false)
      handlers.set(channel, handler)
    },
  }, repository, { isTrustedSender: (event) => event === 'trusted' })

  assert.deepEqual([...handlers.keys()].sort(), Object.values(WORLD_PROJECT_CHANNELS).sort())
  const denied = await handlers.get(WORLD_PROJECT_CHANNELS.list)?.('untrusted')
  assert.deepEqual(denied, {
    ok: false,
    error: { code: 'unauthorized', message: 'World project request is unauthorized.', retryable: false },
  })
  assert.equal(repository.calls.length, 0)
})

test('validates exact request shapes before repository path use', async () => {
  const handlers = new Map<string, (event: unknown, request?: unknown) => unknown>()
  const repository = stubRepository()
  registerWorldProjectsIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, repository, {
    isTrustedSender: () => true,
  })
  const invalidRequests: Array<[string, unknown]> = [
    [WORLD_PROJECT_CHANNELS.create, { name: 'World', initialSceneName: 'Scene', extra: '../escape' }],
    [WORLD_PROJECT_CHANNELS.open, { projectKey: '../escape' }],
    [WORLD_PROJECT_CHANNELS.previewCommands, { projectKey: 'world-0123456789abcdef0123456789abcdef' }],
    [WORLD_PROJECT_CHANNELS.applyCommands, { projectKey: 'C:\\escape', batch: {} }],
    [WORLD_PROJECT_CHANNELS.delete, { projectKey: 'world-0123456789abcdef0123456789abcdef', expectedRevision: -1, transactionId: 'tx:delete' }],
  ]
  for (const [channel, request] of invalidRequests) {
    const result = await handlers.get(channel)?.('trusted', request)
    assert.deepEqual(result, {
      ok: false,
      error: { code: 'invalid_request', message: 'World project request is invalid.', retryable: false },
    })
  }
  assert.equal(repository.calls.length, 0)

  await handlers.get(WORLD_PROJECT_CHANNELS.list)?.('trusted')
  await handlers.get(WORLD_PROJECT_CHANNELS.create)?.('trusted', { name: 'World', initialSceneName: 'Scene' })
  await handlers.get(WORLD_PROJECT_CHANNELS.open)?.('trusted', { projectKey: 'world-0123456789abcdef0123456789abcdef' })
  const batch = {
    schema: WORLD_COMMAND_BATCH_SCHEMA,
    transactionId: 'tx:rename',
    projectId: 'project:one',
    baseRevision: 0,
    origin: 'ui',
    commands: [{ type: 'rename-project', name: 'Renamed' }],
  }
  await handlers.get(WORLD_PROJECT_CHANNELS.previewCommands)?.('trusted', { projectKey: 'world-0123456789abcdef0123456789abcdef', batch })
  await handlers.get(WORLD_PROJECT_CHANNELS.applyCommands)?.('trusted', { projectKey: 'world-0123456789abcdef0123456789abcdef', batch })
  await handlers.get(WORLD_PROJECT_CHANNELS.delete)?.('trusted', {
    projectKey: 'world-0123456789abcdef0123456789abcdef', expectedRevision: 0, transactionId: 'tx:delete',
  })
  assert.deepEqual(repository.calls.map((call) => call.method), [
    'list', 'create', 'open', 'previewCommands', 'applyCommands', 'delete',
  ])
})

test('sanitizes repository exceptions and never returns raw paths or error strings', async () => {
  const handlers = new Map<string, (event: unknown, request?: unknown) => unknown>()
  const repository = stubRepository()
  repository.list = async () => { throw new Error('private /home/user/workspace failure') }
  registerWorldProjectsIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, repository, {
    isTrustedSender: () => true,
  })
  const result = await handlers.get(WORLD_PROJECT_CHANNELS.list)?.('trusted')
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'internal_error', message: 'World project operation failed.', retryable: true },
  })
  assert.equal(JSON.stringify(result).includes('/home/user'), false)
})

test('AI preview and discard validate typed boundaries and cannot invoke fabricated channels', async () => {
  const handlers = new Map<string, (event: unknown, request?: unknown) => unknown>()
  const repository = stubRepository()
  const calls: unknown[] = []
  repository.previewAi = async (request) => { calls.push(request); return { ok: true, value: {} } as never }
  repository.discardAi = async (request) => { calls.push(request); return { ok: true, value: { discarded: true } } }
  registerWorldProjectsIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, repository, { isTrustedSender: () => true })
  const context = { schema: 'modly.world-ai-context.v1', projectKey: `world-${'a'.repeat(32)}`, projectId: 'project:demo', baseRevision: 4,
    activeSceneId: 'scene:one', editorEpoch: 1, originSessionId: 'session-ipc', requestId: 'tx:ipc-ai' }
  const proposal = { type: 'world_command_proposal', context, commands: [{ type: 'create-entity', kind: 'group', sceneRef: { kind: 'existing', id: 'scene:one' }, name: 'Group', localRef: 'group' }] }
  const discard = { context, authority: `apply_${'a'.repeat(48)}` }
  await handlers.get(WORLD_PROJECT_CHANNELS.previewAi)!('trusted', { proposal })
  await handlers.get(WORLD_PROJECT_CHANNELS.discardAi)!('trusted', discard)
  assert.deepEqual(calls, [{ proposal }, discard])
  const count = calls.length
  for (const invalid of [{ proposal: { ...proposal, commands: [{ ...proposal.commands[0], execute: true }] } }, { proposal: { ...proposal, context: { ...context, baseRevision: '4' } } }]) {
    const result = await handlers.get(WORLD_PROJECT_CHANNELS.previewAi)!('trusted', invalid)
    assert.equal((result as { error: { code: string } }).error.code, 'invalid_request', 'Invalid AI DTO must be classified as a client request, not a host exception')
  }
  assert.equal(calls.length, count)
  assert.equal(handlers.has('workspace:worlds:projects:executeAi'), false)
  assert.equal(handlers.has('workspace:worlds:projects:saveSnapshot'), false)
})

function stubRepository(): WorldProjectsRepositoryLike & { calls: Array<{ method: keyof WorldProjectsApi; request?: unknown }> } {
  const calls: Array<{ method: keyof WorldProjectsApi; request?: unknown }> = []
  const ok = { ok: true, value: {} } as never
  return {
    calls,
    create: async (request) => { calls.push({ method: 'create', request }); return ok },
    list: async () => { calls.push({ method: 'list' }); return ok },
    open: async (request) => { calls.push({ method: 'open', request }); return ok },
    previewCommands: async (request) => { calls.push({ method: 'previewCommands', request }); return ok },
    applyCommands: async (request) => { calls.push({ method: 'applyCommands', request }); return ok },
    delete: async (request) => { calls.push({ method: 'delete', request }); return ok },
  }
}
