import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyWorldAiRequestFailure, createWorldAiChatAdapter, parseWorldAiChatResponse, requestWorldAiChat, worldAiRequestFailureMessage } from './worldAiChatAdapter.ts'
import { createWorldEditorController } from './worldEditorController.ts'
import { createWorldEditorCommandPort } from './worldEditorCommandPort.ts'
import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import { applyWorldCommandBatch } from '../core/worldCommands.ts'
import type { WorldProjectsApi, WorldProjectCommandRequest, WorldProjectPublicErrorCode } from '../../../shared/types/worldProjects.ts'

const projectKey = `world-${'c'.repeat(32)}`

test('strict response decoder retains serialized required root-reparent null and rejects omission', () => {
  const context = { schema: 'modly.world-ai-context.v1', projectKey, projectId: 'project:demo', baseRevision: 4,
    activeSceneId: 'scene:one', editorEpoch: 1, originSessionId: 'session-a', requestId: 'tx:serialized-null' }
  const command = { type: 'reparent', sceneRef: { kind: 'existing', id: 'scene:one' }, entityRef: { kind: 'existing', id: 'entity:hero' }, parentRef: null }
  const response = JSON.parse(JSON.stringify({ message: 'Review the detach.', actions: [], proposals: [], worldProposals: [{ type: 'world_command_proposal', context, commands: [command] }] }))
  assert.deepEqual(parseWorldAiChatResponse(response).worldProposals[0].commands, [command])
  delete response.worldProposals[0].commands[0].parentRef
  assert.throws(() => parseWorldAiChatResponse(response))
})
async function fixture(options: { applyFailure?: WorldProjectPublicErrorCode; applyFailureOnce?: WorldProjectPublicErrorCode; autoApply?: boolean; delayedPreview?: boolean } = {}) {
  let snapshot = createValidWorldSnapshot()
  let writes = 0
  let applyAttempts = 0
  let editing = true
  const result = (request: WorldProjectCommandRequest, persist: boolean) => {
    const value = applyWorldCommandBatch(snapshot, request.batch)
    if (!value.success) throw new Error('Invalid fixture command')
    if (persist) { snapshot = structuredClone(value.snapshot); writes += 1 }
    return { ok: true as const, value: { projectKey, snapshot: structuredClone(value.snapshot), newRevision: value.snapshot.project.revision,
      idempotent: false, changes: value.changes, warnings: value.warnings, inverse: value.inverse,
      receipt: { transactionId: request.batch.transactionId, payloadSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), appliedRevision: value.snapshot.project.revision } } }
  }
  const api: WorldProjectsApi = {
    async create() { throw new Error('unused') }, async delete() { throw new Error('unused') },
    async list() { return { ok: true, value: { projects: [], issues: [] } } },
    async open() { return { ok: true, value: { status: 'ready', projectKey, snapshot: structuredClone(snapshot), durabilityWarnings: [] } } },
    async previewCommands(request) {
      if (options.delayedPreview) await new Promise((resolve) => setTimeout(resolve, 0))
      return result(request, false)
    },
    async applyCommands(request) {
      applyAttempts += 1
      if (options.applyFailure || (options.applyFailureOnce && applyAttempts === 1)) return { ok: false, error: { code: (options.applyFailure || options.applyFailureOnce)!, message: 'IO error /home/private/world/project.json C:\\private\\world', retryable: true } }
      return result(request, true)
    },
  }
  const controller = createWorldEditorController(api)
  await controller.openProject(projectKey)
  const adapter = createWorldAiChatAdapter(createWorldEditorCommandPort(controller), () => editing, { autoApply: options.autoApply })
  const begin = (isCurrent: () => boolean = () => true) => adapter.begin({ originSessionId: 'session-a', requestId: `tx:request-${++sequence}`, isCurrent })
  return { controller, adapter, begin, writes: () => writes, applyAttempts: () => applyAttempts, play: () => { editing = false } }
}
let sequence = 0
const proposal = (context: ReturnType<Awaited<ReturnType<typeof fixture>>['begin']>['context']) => ({ message: 'Review this change.', actions: [], proposals: [], worldProposals: [{
  type: 'world_command_proposal', context, commands: [{ type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { name: 'Renamed Hero' } }],
}] })

test('Worlds direct mode previews against the open scene, applies through the command bus and supports Undo', async () => {
  const f = await fixture({ autoApply: true })
  const unsubscribe = f.adapter.subscribe(() => undefined)
  let requestCurrent = true
  const turn = f.begin(() => requestCurrent)
  await f.adapter.accept(turn, proposal(turn.context))
  assert.equal(f.adapter.getState().status, 'applied')
  assert.equal(f.writes(), 1)
  assert.equal(f.controller.getState().session?.snapshot.scenes[0].entities[0].name, 'Renamed Hero')
  requestCurrent = false
  f.adapter.cancel() // Closing the chat should not remove the editor's Undo affordance.
  assert.equal(f.adapter.getState().status, 'applied')
  await f.adapter.undo()
  assert.equal(f.controller.getState().session?.snapshot.scenes[0].entities[0].name, 'Hero')
  assert.equal(f.adapter.getState().status, 'idle')
  assert.equal(f.adapter.getState().message, 'Last command undone.')
  unsubscribe()
  f.adapter.dispose()
})

test('scene switch queued with assistant Undo leaves no stale Undo authority', async () => {
  const f = await fixture({ autoApply: true })
  const unsubscribe = f.adapter.subscribe(() => undefined)
  const turn = f.begin()
  await f.adapter.accept(turn, proposal(turn.context))
  const undo = f.adapter.undo()
  assert.equal(f.adapter.getState().status, 'undoing')
  const switchScene = f.controller.setActiveScene('scene:two')
  await Promise.all([undo, switchScene])
  assert.equal(f.controller.getState().activeSceneId, 'scene:two')
  assert.notEqual(f.adapter.getState().status, 'applied')
  const writes = f.writes()
  await f.adapter.undo()
  assert.equal(f.writes(), writes)
  unsubscribe()
  f.adapter.dispose()
})

test('human edit queued ahead of assistant Undo keeps the human revision and rejects Undo', async () => {
  const f = await fixture({ autoApply: true })
  const unsubscribe = f.adapter.subscribe(() => undefined)
  const turn = f.begin()
  await f.adapter.accept(turn, proposal(turn.context))
  const human = f.controller.dispatchCommands({ transactionId: 'tx:human-before-undo-queue', origin: 'ui',
    commands: [{ type: 'rename-project', name: 'Human title' }] })
  const undo = f.adapter.undo()
  await Promise.all([human, undo])
  assert.equal(f.controller.getState().session?.snapshot.project.name, 'Human title')
  assert.equal(f.controller.getState().session?.snapshot.scenes[0].entities[0].name, 'Renamed Hero')
  assert.equal(f.adapter.getState().status, 'stale')
  assert.equal(f.writes(), 2)
  await f.adapter.undo()
  assert.equal(f.writes(), 2)
  unsubscribe()
  f.adapter.dispose()
})

test('Worlds direct mode refuses stale revisions and does not retry a failed write', async () => {
  const stale = await fixture({ autoApply: true })
  const turn = stale.begin()
  await stale.controller.dispatchCommands({ transactionId: 'tx:human-first', origin: 'ui', commands: [{ type: 'rename-project', name: 'Human' }] })
  await stale.adapter.accept(turn, proposal(turn.context))
  assert.equal(stale.writes(), 1)
  assert.equal(stale.controller.getState().session?.snapshot.scenes[0].entities[0].name, 'Hero')
  stale.adapter.dispose()

  const failed = await fixture({ autoApply: true, applyFailure: 'write_failed' })
  const failedTurn = failed.begin()
  await failed.adapter.accept(failedTurn, proposal(failedTurn.context))
  assert.equal(failed.adapter.getState().status, 'error')
  assert.doesNotMatch(failed.adapter.getState().message, /reviewed/i)
  assert.equal(failed.applyAttempts(), 1)
  assert.equal(failed.writes(), 0)
  failed.adapter.dispose()
})

test('duplicate concurrent accept for one turn cannot retry a failed direct Apply', async () => {
  const f = await fixture({ autoApply: true, delayedPreview: true, applyFailureOnce: 'write_failed' })
  const turn = f.begin()
  const answer = proposal(turn.context)
  await Promise.all([f.adapter.accept(turn, answer), f.adapter.accept(turn, answer)])
  assert.equal(f.applyAttempts(), 1)
  assert.equal(f.writes(), 0)
  assert.equal(f.adapter.getState().status, 'error')
  const failureMessage = f.adapter.getState().message
  await f.adapter.accept(turn, answer)
  f.adapter.fail(turn, 'transport')
  assert.equal(f.applyAttempts(), 1)
  assert.equal(f.adapter.getState().message, failureMessage)
  f.adapter.dispose()
})

test('proposal-less Worlds response retains query content but reports host-owned no edit', async () => {
  const f = await fixture({ autoApply: true })
  const turn = f.begin()
  await f.adapter.accept(turn, { message: 'Two lights are in the scene.', actions: [], proposals: [], worldProposals: [] })
  assert.equal(f.adapter.getState().status, 'idle')
  assert.equal(f.adapter.getState().message, 'Scene unchanged.')
  assert.equal(f.writes(), 0)
  f.adapter.dispose()
})

test('AI-specific Undo never undoes a later human edit', async () => {
  const f = await fixture({ autoApply: true })
  const unsubscribe = f.adapter.subscribe(() => undefined)
  const turn = f.begin()
  await f.adapter.accept(turn, proposal(turn.context))
  assert.equal(f.adapter.getState().status, 'applied')
  const edited = await f.controller.dispatchCommands({ transactionId: 'tx:after-ai-human', origin: 'ui',
    commands: [{ type: 'rename-project', name: 'Human title' }] })
  assert.equal(edited.ok, true)
  assert.equal(f.adapter.getState().status, 'stale')
  await f.adapter.undo()
  assert.equal(f.controller.getState().session?.snapshot.project.name, 'Human title')
  assert.equal(f.controller.getState().session?.snapshot.scenes[0].entities[0].name, 'Renamed Hero')
  unsubscribe()
  f.adapter.dispose()
})

test('adapter uses real preview, meaningful diff, explicit Apply, Reject and canonical Undo without model actions', async () => {
  const f = await fixture()
  const turn = f.begin()
  await f.adapter.accept(turn, proposal(turn.context))
  assert.equal(f.adapter.getState().status, 'ready')
  assert.equal(f.writes(), 0)
  assert.deepEqual(f.adapter.getState().preview?.details.map(({ property, before, after }) => ({ property, before, after })), [{ property: 'name', before: 'Hero', after: 'Renamed Hero' }])
  await f.adapter.apply()
  assert.equal(f.writes(), 1)
  assert.equal(f.adapter.getState().status, 'applied')
  assert.equal(turn.guard.isCurrent(), true, 'Successful Apply advances revision without revoking canonical Undo')
  assert.equal(turn.isRequestCurrent(), false, 'A completed model request cannot send again')
  assert.equal(f.adapter.getState().status, 'applied')
  await f.adapter.undo()
  assert.equal(turn.guard.isCurrent(), true)
  assert.equal(f.controller.getState().session?.snapshot.scenes[0].entities[0].name, 'Hero')
  const rejected = f.begin()
  await f.adapter.accept(rejected, proposal(rejected.context))
  f.adapter.reject()
  await f.adapter.apply()
  assert.equal(f.writes(), 2)
  f.adapter.dispose()
})

test('cancel, replacement request, close/reopen, and queued scene or Play changes deny preview or Apply', async () => {
  const f = await fixture()
  const canceled = f.begin(); f.adapter.cancel()
  await f.adapter.accept(canceled, proposal(canceled.context))
  assert.notEqual(f.adapter.getState().status, 'ready')
  const old = f.begin(); f.begin()
  await f.adapter.accept(old, proposal(old.context))
  assert.notEqual(f.adapter.getState().status, 'ready')
  const reopened = f.begin()
  await f.controller.closeProject(); await f.controller.openProject(projectKey)
  await f.adapter.accept(reopened, proposal(reopened.context))
  assert.notEqual(f.adapter.getState().status, 'ready')
  const scene = f.begin(); await f.adapter.accept(scene, proposal(scene.context))
  const queuedScene = f.controller.setActiveScene('scene:two')
  await f.adapter.apply(); await queuedScene
  assert.equal(f.writes(), 0)
  await f.controller.setActiveScene('scene:one')
  const playing = f.begin(); await f.adapter.accept(playing, proposal(playing.context))
  const apply = f.adapter.apply(); f.play(); await apply
  assert.equal(f.writes(), 0)
  assert.equal(f.adapter.getState().status, 'stale')
  f.adapter.dispose()
})

test('Worlds response rejects legacy and fabricated actions before any mutation', async () => {
  const f = await fixture(); const turn = f.begin()
  for (const unsafe of [{ actions: [{ tool: 'unload_models', result: 'done' }] }, { proposals: [{}] }, { apply: true }, { worldProposals: [proposal(turn.context).worldProposals[0], proposal(turn.context).worldProposals[0]] }]) {
    assert.throws(() => parseWorldAiChatResponse({ ...proposal(turn.context), ...unsafe }))
    await f.adapter.accept(turn, { ...proposal(turn.context), ...unsafe })
    assert.notEqual(f.adapter.getState().status, 'ready')
  }
  assert.equal(f.writes(), 0)
  f.adapter.dispose()
})

test('real ChatPanel request helper sends only this prompt and captured Worlds IDs to agent chat', async () => {
  const { requestWorldAiChat } = await import('./worldAiChatAdapter.ts')
  const f = await fixture(); const turn = f.begin()
  let body: Record<string, unknown> = {}
  await requestWorldAiChat({ apiUrl: 'http://backend.test', ollamaUrl: 'http://configured.test', model: 'configured-model', thinking: 'auto', turn,
    message: { role: 'user', content: 'Rename Hero' }, signal: new AbortController().signal,
    fetch: (async (url, init) => {
      assert.equal(url, 'http://backend.test/agent/chat')
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify(proposal(turn.context)), { status: 200 })
    }) as typeof fetch })
  assert.deepEqual(Object.keys(body).sort(), ['context', 'messages', 'model', 'ollama_url', 'originSessionId', 'thinking', 'worldContext'])
  assert.deepEqual(body.context, {})
  assert.deepEqual(body.worldContext, turn.context)
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Rename Hero' }])
  assert.equal(body.model, 'configured-model')
  f.adapter.dispose()
})

test('real ChatPanel request helper invokes injected fetch with native global receiver', async () => {
  const f = await fixture(); const turn = f.begin()
  try {
    const signal = new AbortController().signal
    let receivedUrl: unknown
    let receivedSignal: AbortSignal | undefined
    let body: Record<string, unknown> = {}
    const response = await requestWorldAiChat({ apiUrl: 'http://backend.test', ollamaUrl: 'http://configured.test', model: 'configured-model', thinking: 'auto', turn,
      message: { role: 'user', content: 'Rename Hero', images: ['image-a'] }, signal,
      fetch: (async function (this: unknown, url, init) {
        if (this !== globalThis) throw new TypeError('native fetch receiver mismatch')
        receivedUrl = url
        receivedSignal = init?.signal as AbortSignal | undefined
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(proposal(turn.context)), { status: 200 })
      }) as typeof fetch })
    assert.equal(receivedUrl, 'http://backend.test/agent/chat')
    assert.equal(receivedSignal, signal)
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Rename Hero', images: ['image-a'] }])
    assert.deepEqual(body.worldContext, turn.context)
    assert.deepEqual(response, parseWorldAiChatResponse(proposal(turn.context)))
  } finally {
    f.adapter.dispose()
  }
})

test('request helper classifies transport, HTTP and invalid Worlds failures without model reconfiguration copy', async () => {
  const f = await fixture(); const turn = f.begin()
  try {
    await assert.rejects(async () => requestWorldAiChat({ apiUrl: 'http://backend.test', ollamaUrl: 'http://configured.test', model: 'configured-model', thinking: 'auto', turn,
      message: { role: 'user', content: 'Rename Hero' }, signal: new AbortController().signal,
      fetch: (async () => { throw new TypeError('fetch failed: /private/token') }) as typeof fetch }), (error) => {
      assert.equal(classifyWorldAiRequestFailure(error), 'transport')
      assert.equal(error instanceof Error ? error.message : '', 'Cannot reach Modly API. Is the backend running?')
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), /configured model|private|token/i)
      return true
    })
    await assert.rejects(async () => requestWorldAiChat({ apiUrl: 'http://backend.test', ollamaUrl: 'http://configured.test', model: 'configured-model', thinking: 'auto', turn,
      message: { role: 'user', content: 'Rename Hero' }, signal: new AbortController().signal,
      fetch: (async () => new Response('provider_unknown /private/model', { status: 400 })) as typeof fetch }), (error) => {
      assert.equal(classifyWorldAiRequestFailure(error), 'http')
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), /configured model|provider_unknown|private/i)
      return true
    })
    await assert.rejects(async () => requestWorldAiChat({ apiUrl: 'http://backend.test', ollamaUrl: 'http://configured.test', model: 'configured-model', thinking: 'auto', turn,
      message: { role: 'user', content: 'Rename Hero' }, signal: new AbortController().signal,
      fetch: (async () => new Response(JSON.stringify({ message: 'bad', actions: [{ tool: 'unload_models' }], proposals: [], worldProposals: [] }), { status: 200 })) as typeof fetch }), (error) => {
      assert.equal(classifyWorldAiRequestFailure(error), 'invalid_response')
      assert.equal(error instanceof Error ? error.message : '', 'Worlds AI returned an invalid response. No changes were made.')
      return true
    })
  } finally {
    f.adapter.dispose()
  }
})

test('adapter failure reporting uses typed transport copy and stale isolation, not arbitrary backend text', async () => {
  const f = await fixture()
  const unsubscribe = f.adapter.subscribe(() => undefined)
  try {
    const transport = f.begin()
    f.adapter.fail(transport, 'transport')
    assert.equal(f.adapter.getState().message, worldAiRequestFailureMessage('transport'))
    assert.doesNotMatch(f.adapter.getState().message, /configured model/i)
    const http = f.begin()
    f.adapter.fail(http, 'http')
    assert.equal(f.adapter.getState().message, worldAiRequestFailureMessage('http'))
    assert.doesNotMatch(f.adapter.getState().message, /configured model|provider_unknown|[\\/]/i)
    const staleTurn = f.begin()
    await f.controller.dispatchCommands({ transactionId: 'tx:stale-before-fail', origin: 'ui', commands: [{ type: 'rename-project', name: 'Human' }] })
    assert.equal(f.adapter.getState().status, 'stale')
    f.adapter.fail(staleTurn, 'transport')
    assert.equal(f.adapter.getState().status, 'stale')
    assert.equal(f.adapter.getState().message, 'This request is stale. Ask again from the current scene.')
  } finally {
    unsubscribe()
    f.adapter.dispose()
  }
})

test('an applied request and its Undo control become stale when the editor scene scope changes', async () => {
  const f = await fixture()
  const unsubscribe = f.adapter.subscribe(() => undefined)
  const turn = f.begin(); await f.adapter.accept(turn, proposal(turn.context)); await f.adapter.apply()
  assert.equal(f.adapter.getState().status, 'applied')
  await f.controller.setActiveScene('scene:two')
  assert.equal(f.adapter.getState().status, 'stale')
  unsubscribe(); f.adapter.dispose()
})

test('idle cleanup and Play transitions do not invent a stale request before the first prompt', async () => {
  const f = await fixture()
  f.adapter.cancel()
  assert.equal(f.adapter.getState().status, 'idle')
  f.adapter.dispose()
})

for (const change of ['scene', 'revision', 'reopen'] as const) {
  test(`stale ${change} during attachment or message persistence revokes the turn before actual HTTP dispatch`, async (t) => {
    const f = await fixture()
    const unsubscribe = f.adapter.subscribe(() => undefined)
    t.after(() => { unsubscribe(); f.adapter.dispose() })
    const turn = f.begin()
    if (change === 'scene') await f.controller.setActiveScene('scene:two')
    if (change === 'revision') await f.controller.dispatchCommands({ transactionId: 'tx:human-change', origin: 'ui', commands: [{ type: 'rename-project', name: 'Changed project' }] })
    if (change === 'reopen') { await f.controller.closeProject(); await f.controller.openProject(projectKey) }
    assert.equal(f.adapter.getState().status, 'stale')
    let requests = 0
    const send = () => requestWorldAiChat({ apiUrl: 'http://backend.test', ollamaUrl: 'http://configured.test', model: 'configured-model', thinking: 'auto', turn,
      message: { role: 'user', content: 'Rename Hero' }, signal: new AbortController().signal,
      fetch: (async () => { requests += 1; return new Response(JSON.stringify(proposal(turn.context)), { status: 200 }) }) as typeof fetch })
    await assert.rejects(send, /no longer current/)
    assert.equal(requests, 0)
    assert.equal(turn.guard.isCurrent(), false)
    if (change === 'scene') await f.controller.setActiveScene('scene:one')
    if (change === 'revision') await f.controller.undo()
    await assert.rejects(send, /no longer current/, 'Returning to earlier content cannot resurrect a revoked request')
    assert.equal(turn.guard.isCurrent(), false)
    assert.equal(requests, 0)
  })
}

test('HTTP preflight checks original bound state even without a mounted UI subscription', async (t) => {
  const f = await fixture()
  t.after(() => f.adapter.dispose())
  const turn = f.begin()
  await f.controller.dispatchCommands({ transactionId: 'tx:before-send', origin: 'ui', commands: [{ type: 'rename-project', name: 'Human' }] })
  let requests = 0
  await assert.rejects(() => requestWorldAiChat({ apiUrl: 'http://backend.test', ollamaUrl: 'http://configured.test', model: 'configured-model', thinking: 'auto', turn,
    message: { role: 'user', content: 'Rename Hero' }, signal: new AbortController().signal,
    fetch: (async () => { requests += 1; return new Response(JSON.stringify(proposal(turn.context)), { status: 200 }) }) as typeof fetch }), /no longer current/)
  assert.equal(requests, 0)
  assert.equal(f.adapter.getState().status, 'stale')
  assert.equal(turn.guard.isCurrent(), false)
  f.adapter.fail(turn)
  assert.equal(f.adapter.getState().status, 'stale', 'Late transport failure must not overwrite revoked status')
})

for (const code of ['write_failed', 'project_busy', 'recovery_failed', 'internal_error', 'invalid_request'] as const) {
  test(`Apply ${code} remains a safe operation error, not a stale prompt or automatic retry`, async (t) => {
    const f = await fixture({ applyFailure: code })
    const unsubscribe = f.adapter.subscribe(() => undefined)
    t.after(() => { unsubscribe(); f.adapter.dispose() })
    const turn = f.begin()
    await f.adapter.accept(turn, proposal(turn.context))
    assert.equal(f.adapter.getState().status, 'ready')
    await f.adapter.apply()
    assert.equal(f.controller.getState().error?.code, code)
    assert.equal(f.controller.getState().session?.snapshot.project.revision, turn.context.baseRevision)
    assert.equal(f.adapter.getState().status, 'error')
    assert.equal(f.adapter.getState().errorCode, code)
    assert.doesNotMatch(f.adapter.getState().message, /stale|ask again|private|[\\/]/i)
    if (code === 'write_failed') assert.match(f.adapter.getState().message, /save|storage/i)
    assert.equal(f.writes(), 0)
    assert.equal(f.applyAttempts(), 1)
    await f.adapter.apply()
    assert.equal(f.applyAttempts(), 1, 'An operation failure must not silently retry a human approval')
  })
}

test('a typed revision conflict still invalidates a ready proposal without any write', async (t) => {
  const f = await fixture({ applyFailure: 'revision_conflict' })
  t.after(() => f.adapter.dispose())
  const turn = f.begin()
  await f.adapter.accept(turn, proposal(turn.context)); await f.adapter.apply()
  assert.equal(f.adapter.getState().status, 'stale')
  assert.equal(f.writes(), 0)
})

test('openai_response_still_passes_worlds_preview_parser_and_rejects_unsafe_shapes', async () => {
  const f = await fixture(); const turn = f.begin()
  let body: Record<string, unknown> = {}
  await requestWorldAiChat({ apiUrl: 'http://backend.test', ollamaUrl: 'http://configured.test', model: 'configured-model', thinking: 'auto',
    provider: 'openai', openaiModel: 'gpt-5.1', turn,
    message: { role: 'user', content: 'Rename Hero' }, signal: new AbortController().signal,
    fetch: (async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify(proposal(turn.context)), { status: 200 })
    }) as typeof fetch })
  assert.equal(body.provider, 'openai')
  assert.equal(body.openaiModel, 'gpt-5.1')
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'apiKey'), false)
  for (const unsafe of [{ actions: [{ tool: 'unload_models' }] }, { proposals: [{}] }, { unknown: true }, { worldProposals: [proposal(turn.context).worldProposals[0], proposal(turn.context).worldProposals[0]] }]) {
    assert.throws(() => parseWorldAiChatResponse({ ...proposal(turn.context), ...unsafe }))
  }
  f.adapter.dispose()
})
