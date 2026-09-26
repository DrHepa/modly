import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import type { WorldProjectsApi } from '../../shared/types/worldProjects.ts'
import { createWorldProjectService } from './worldProjectService.ts'
import { createValidWorldSnapshot } from './core/_testFixtures.ts'
import { compileWorldAiProposal } from './core/worldAiCreationCompiler.ts'
import { describeWorldAiCandidate, parseWorldAiContext } from './core/worldAiContract.ts'
import { applyWorldCommandBatch } from './core/worldCommands.ts'

const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const OTHER_PROJECT_KEY = 'world-fedcba9876543210fedcba9876543210'

test('AI service forwards exact proposal and discard, rejects forged bindings and private review text', async () => {
  const snapshot = createServiceSnapshot()
  const context = parseWorldAiContext({ schema: 'modly.world-ai-context.v1', projectKey: PROJECT_KEY, projectId: snapshot.project.projectId,
    baseRevision: 4, activeSceneId: 'scene:one', editorEpoch: 1, originSessionId: 'session-service', requestId: 'tx:service-ai' })
  const compiled = compileWorldAiProposal(snapshot, { type: 'world_command_proposal', context, commands: [{ type: 'create-entity', kind: 'group',
    localRef: 'group', sceneRef: { kind: 'existing', id: 'scene:one' }, name: 'Group' }] }, { resources: new Map(), assertObserved() {} })
  const applied = applyWorldCommandBatch(snapshot, compiled.batch); assert.ok(applied.success)
  const response = { ok: true, value: { batch: compiled.batch, authority: `apply_${'a'.repeat(48)}`,
    details: describeWorldAiCandidate(snapshot, compiled.candidate, compiled.batch.commands), result: { projectKey: PROJECT_KEY, snapshot: applied.snapshot,
      newRevision: 5, inverse: applied.inverse, changes: applied.changes, warnings: applied.warnings, idempotent: false,
      receipt: { transactionId: context.requestId, payloadSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), appliedRevision: 5 } } } }
  const calls: unknown[] = []
  let output: unknown = response
  const api = { previewAi: async (request: unknown) => { calls.push(request); return output },
    discardAi: async (request: unknown) => { calls.push(request); return { ok: true, value: { discarded: true } } } } as unknown as WorldProjectsApi
  const service = createWorldProjectService(api)
  const request = { proposal: compiled.proposal }
  assert.ok((await service.previewAi!(request)).ok)
  const discard = { context, authority: response.value.authority }; assert.ok((await service.discardAi!(discard)).ok)
  assert.deepEqual(calls, [request, discard])
  for (const hostile of [
    { ...response.value, authority: '/home/private' },
    { ...response.value, batch: { ...compiled.batch, baseRevision: 3 } },
    { ...response.value, details: [{ ...response.value.details[0], after: '/home/private' }] },
    { ...response.value, result: { ...response.value.result, newRevision: 6 } },
  ]) {
    output = { ok: true, value: hostile }
    const rejected = await service.previewAi!(request); assert.equal(rejected.ok, false)
    assert.doesNotMatch(JSON.stringify(rejected), /private|[\\/]/)
  }
})

function createServiceSnapshot(projectKey = PROJECT_KEY) {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.scenes[0].documentPath = `Worlds/${projectKey}/scenes/scene-00000000000000000000000000000001.world-scene.json`
  snapshot.project.scenes[1].documentPath = `Worlds/${projectKey}/scenes/scene-00000000000000000000000000000002.world-scene.json`
  return snapshot
}

test('renderer service is the sole narrow adapter and forwards typed requests', async () => {
  const calls: string[] = []
  const snapshot = createServiceSnapshot()
  const api: WorldProjectsApi = {
    create: async () => { calls.push('create'); return { ok: true, value: { projectKey: PROJECT_KEY, snapshot, durabilityWarnings: [] } } },
    list: async () => { calls.push('list'); return { ok: true, value: { projects: [], issues: [] } } },
    open: async () => { calls.push('open'); return { ok: true, value: { status: 'ready', projectKey: PROJECT_KEY, snapshot, durabilityWarnings: [] } } },
    previewCommands: async () => { calls.push('previewCommands'); return { ok: false, error: { code: 'revision_conflict', message: 'World project revision changed.', retryable: true } } },
    applyCommands: async () => { calls.push('applyCommands'); return { ok: false, error: { code: 'revision_conflict', message: 'World project revision changed.', retryable: true } } },
    delete: async () => { calls.push('delete'); return { ok: true, value: { projectKey: PROJECT_KEY, transactionId: 'tx:delete', idempotent: false } } },
  }
  const service = createWorldProjectService(api)
  assert.equal((await service.create({ name: 'World', initialSceneName: 'Scene' })).ok, true)
  assert.equal((await service.list()).ok, true)
  assert.equal((await service.open({ projectKey: PROJECT_KEY })).ok, true)
  assert.equal((await service.previewCommands({} as never)).ok, false)
  assert.equal((await service.applyCommands({} as never)).ok, false)
  assert.equal((await service.delete({ projectKey: PROJECT_KEY, expectedRevision: 0, transactionId: 'tx:delete' })).ok, true)
  assert.deepEqual(calls, ['create', 'list', 'open', 'previewCommands', 'applyCommands', 'delete'])
})

test('external CLI Apply service forwards only opaque IDs and accepts only a path-free exact receipt', async () => {
  const request = { proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`, attemptId: `attempt_${'c'.repeat(48)}` }
  const calls: unknown[] = []
  let response: unknown = { ok: true, transactionId: 'tx:external', projectId: 'project:demo', baseRevision: 4,
    newRevision: 5, beforeSnapshotSha256: 'a'.repeat(64), snapshotSha256: 'b'.repeat(64) }
  const service = createWorldProjectService({} as WorldProjectsApi, {
    apply: async (value) => { calls.push(value); return response as never },
    cancelApplyIntent: async (value) => { calls.push(value); return { ok: true } },
  })
  assert.deepEqual(await service.applyExternalCli!(request), response)
  assert.equal(await service.cancelExternalCliIntent!(request.attemptId), true)
  assert.deepEqual(calls, [request, { attemptId: request.attemptId }])
  response = { ...(response as object), path: '/private/world' }
  assert.deepEqual(await service.applyExternalCli!(request), { ok: false, code: 'AMBIGUOUS' })
  response = { ok: true, transactionId: 'tx:external', projectId: 'project:demo', baseRevision: 4,
    newRevision: 5, beforeSnapshotSha256: 'not-a-hash', snapshotSha256: 'b'.repeat(64) }
  assert.deepEqual(await service.applyExternalCli!(request), { ok: false, code: 'AMBIGUOUS' })
})

test('direct CLI service wrappers clone exact correlations and normalize every reply without leaking private data', async () => {
  const correlation = { nonce: 'a'.repeat(48), editIntent: `edit_${'b'.repeat(48)}` }
  const receipt = { transactionId: 'c'.repeat(32), projectId: 'project:demo', newRevision: 5, snapshotSha256: 'd'.repeat(64) }
  const calls: Array<{ operation: string; value?: unknown }> = []
  let commitReply: unknown = { ok: true, receipt }
  let cancelReply: unknown = { ok: true, status: 'STALE' }
  let adoptReply: unknown = { ok: true, status: 'APPLIED' }
  let leaveReply: unknown = { ok: true }
  const service = createWorldProjectService({} as WorldProjectsApi, {
    apply: async () => ({ ok: false, code: 'UNAVAILABLE' }),
    commitDirectEdit: async (value) => { calls.push({ operation: 'commit', value }); return commitReply as never },
    cancelDirectEdit: async (value) => { calls.push({ operation: 'cancel', value }); return cancelReply as never },
    adoptDirectEdit: async (value) => { calls.push({ operation: 'adopt', value }); return adoptReply as never },
    editorLeft: async () => { calls.push({ operation: 'leave' }); return leaveReply as never },
  })

  assert.deepEqual(await service.commitExternalCliDirectIntent!(correlation), { ok: true, receipt })
  assert.deepEqual(await service.cancelExternalCliDirectIntent!(correlation), { ok: true, status: 'STALE' })
  const adoption = { ...correlation, transactionId: receipt.transactionId,
    newRevision: receipt.newRevision, snapshotSha256: receipt.snapshotSha256 }
  assert.deepEqual(await service.adoptExternalCliDirectIntent!(adoption), { ok: true, status: 'APPLIED' })
  assert.deepEqual(await service.leaveExternalCliEditor!(), { ok: true })
  assert.notEqual(calls[0]?.value, correlation)
  assert.deepEqual(calls, [
    { operation: 'commit', value: correlation },
    { operation: 'cancel', value: correlation },
    { operation: 'adopt', value: adoption },
    { operation: 'leave' },
  ])

  const beforeInvalid = calls.length
  assert.deepEqual(await service.commitExternalCliDirectIntent!({ ...correlation, path: '/private' } as never), { ok: false, code: 'UNAVAILABLE' })
  assert.equal(calls.length, beforeInvalid)

  commitReply = { ok: true, receipt: { ...receipt, path: '/private/world' } }
  assert.deepEqual(await service.commitExternalCliDirectIntent!(correlation), { ok: false, code: 'AMBIGUOUS' })
  commitReply = { ok: false, code: '/private/raw-error' }
  assert.deepEqual(await service.commitExternalCliDirectIntent!(correlation), { ok: false, code: 'AMBIGUOUS' })
  commitReply = { ok: true, receipt: { ...receipt, projectId: 'scene:not-a-project' } }
  assert.deepEqual(await service.commitExternalCliDirectIntent!(correlation), { ok: false, code: 'AMBIGUOUS' })

  cancelReply = { ok: false, code: 'NOT_FOUND', detail: '/private' }
  assert.deepEqual(await service.cancelExternalCliDirectIntent!(correlation), { ok: false, code: 'UNAVAILABLE' })
  adoptReply = { ok: true, status: 'APPLIED', detail: '/private' }
  assert.deepEqual(await service.adoptExternalCliDirectIntent!(adoption), { ok: false, code: 'AMBIGUOUS' })
  leaveReply = { ok: false, code: '/private' }
  assert.deepEqual(await service.leaveExternalCliEditor!(), { ok: false, code: 'UNAVAILABLE' })
  assert.doesNotMatch(JSON.stringify([
    await service.commitExternalCliDirectIntent!(correlation),
    await service.cancelExternalCliDirectIntent!(correlation),
    await service.adoptExternalCliDirectIntent!(adoption),
    await service.leaveExternalCliEditor!(),
  ]), /private|[\\/]/)
})

test('direct CLI wrappers reject accessor/proxy-like payloads from a detached data-only boundary without rereads', async () => {
  const correlation = { nonce: 'a'.repeat(48), editIntent: `edit_${'b'.repeat(48)}` }
  const receipt = { transactionId: 'c'.repeat(32), projectId: 'project:demo', newRevision: 5, snapshotSha256: 'd'.repeat(64) }
  const operations: string[] = []
  let commitReply: unknown = { ok: true, receipt }
  let cancelReply: unknown = { ok: true, status: 'STALE' }
  let adoptReply: unknown = { ok: true, status: 'APPLIED' }
  const service = createWorldProjectService({} as WorldProjectsApi, {
    apply: async () => ({ ok: false, code: 'UNAVAILABLE' }),
    commitDirectEdit: async () => { operations.push('commit'); return commitReply as never },
    cancelDirectEdit: async () => { operations.push('cancel'); return cancelReply as never },
    adoptDirectEdit: async () => { operations.push('adopt'); return adoptReply as never },
    editorLeft: async () => ({ ok: true }),
  })
  let requestReads = 0
  const hostileCorrelation = Object.defineProperty({ editIntent: correlation.editIntent }, 'nonce', {
    enumerable: true,
    get() { requestReads += 1; return requestReads === 1 ? correlation.nonce : '/private' },
  })
  assert.deepEqual(await service.commitExternalCliDirectIntent!(hostileCorrelation as never), { ok: false, code: 'UNAVAILABLE' })
  assert.deepEqual(await service.cancelExternalCliDirectIntent!(hostileCorrelation as never), { ok: false, code: 'UNAVAILABLE' })
  const hostileAdoption = Object.defineProperty({ editIntent: correlation.editIntent, transactionId: receipt.transactionId,
    newRevision: receipt.newRevision, snapshotSha256: receipt.snapshotSha256 }, 'nonce', {
    enumerable: true,
    get() { requestReads += 1; return requestReads === 1 ? correlation.nonce : '/private' },
  })
  assert.deepEqual(await service.adoptExternalCliDirectIntent!(hostileAdoption as never), { ok: false, code: 'UNAVAILABLE' })
  assert.equal(requestReads, 0)
  assert.deepEqual(operations, [])

  let responseReads = 0
  commitReply = Object.defineProperty({ ok: true }, 'receipt', {
    enumerable: true,
    get() { responseReads += 1; return responseReads === 1 ? receipt : { ...receipt, snapshotSha256: '/private' } },
  })
  assert.deepEqual(await service.commitExternalCliDirectIntent!(correlation), { ok: false, code: 'AMBIGUOUS' })
  cancelReply = Object.defineProperty({ ok: true }, 'status', {
    enumerable: true,
    get() { responseReads += 1; return responseReads === 1 ? 'STALE' : '/private' },
  })
  assert.deepEqual(await service.cancelExternalCliDirectIntent!(correlation), { ok: false, code: 'UNAVAILABLE' })
  adoptReply = Object.defineProperty({ ok: true }, 'status', {
    enumerable: true,
    get() { responseReads += 1; return responseReads === 1 ? 'APPLIED' : '/private' },
  })
  assert.deepEqual(await service.adoptExternalCliDirectIntent!({ ...correlation, transactionId: receipt.transactionId,
    newRevision: receipt.newRevision, snapshotSha256: receipt.snapshotSha256 }), { ok: false, code: 'AMBIGUOUS' })
  assert.equal(responseReads, 0)
  assert.doesNotMatch(JSON.stringify([
    await service.commitExternalCliDirectIntent!(correlation),
    await service.cancelExternalCliDirectIntent!(correlation),
  ]), /private|[\\/]/)
})

test('direct CLI service wrappers preserve only bounded terminal codes and convert throws by operation risk', async () => {
  const correlation = { nonce: 'a'.repeat(48), editIntent: `edit_${'b'.repeat(48)}` }
  const service = createWorldProjectService({} as WorldProjectsApi, {
    apply: async () => ({ ok: false, code: 'UNAVAILABLE' }),
    commitDirectEdit: async () => { throw new Error('/private/commit') },
    cancelDirectEdit: async () => ({ ok: false, code: 'AMBIGUOUS' }),
    adoptDirectEdit: async () => { throw new Error('/private/adopt') },
    editorLeft: async () => { throw new Error('/private/leave') },
  })
  assert.deepEqual(await service.commitExternalCliDirectIntent!(correlation), { ok: false, code: 'AMBIGUOUS' })
  assert.deepEqual(await service.cancelExternalCliDirectIntent!(correlation), { ok: false, code: 'AMBIGUOUS' })
  assert.deepEqual(await service.adoptExternalCliDirectIntent!({ ...correlation,
    transactionId: 'c'.repeat(32), newRevision: 5, snapshotSha256: 'd'.repeat(64) }), { ok: false, code: 'UNAVAILABLE' })
  assert.deepEqual(await service.leaveExternalCliEditor!(), { ok: false, code: 'UNAVAILABLE' })
})

test('renderer service rejects non-boolean retryability, unsafe schemas, and cross-project scene paths', async () => {
  const malformedFailure = {
    create: async () => ({ ok: false, error: { code: 'revision_conflict', message: 'hostile', retryable: 'yes' } }),
  } as unknown as WorldProjectsApi
  assert.deepEqual(await createWorldProjectService(malformedFailure).create({ name: 'World', initialSceneName: 'Scene' }), {
    ok: false,
    error: { code: 'invalid_document', message: 'World project response is invalid.', retryable: false },
  })

  const unsafeSchema = {
    open: async () => ({ ok: true, value: { status: 'unsupported', projectKey: PROJECT_KEY, schema: 'file:///private/schema', readOnly: true } }),
  } as unknown as WorldProjectsApi
  assert.equal((await createWorldProjectService(unsafeSchema).open({ projectKey: PROJECT_KEY })).ok, false)

  const escapedSnapshot = createServiceSnapshot()
  escapedSnapshot.project.scenes[0].documentPath = 'Worlds/world-ffffffffffffffffffffffffffffffff/scenes/scene-00000000000000000000000000000001.world-scene.json'
  const crossProject = {
    create: async () => ({ ok: true, value: { projectKey: PROJECT_KEY, snapshot: escapedSnapshot, durabilityWarnings: [] } }),
  } as unknown as WorldProjectsApi
  assert.equal((await createWorldProjectService(crossProject).create({ name: 'World', initialSceneName: 'Scene' })).ok, false)
})

test('renderer service narrows hostile or malformed responses to a stable sanitized failure', async () => {
  const hostile = {
    list: async () => ({ ok: true, value: { projects: [{ projectKey: '../escape', status: 'ready', absolutePath: '/private' }], issues: [] } }),
  } as unknown as WorldProjectsApi
  const result = await createWorldProjectService(hostile).list()
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'invalid_document', message: 'World project response is invalid.', retryable: false },
  })
  assert.equal(JSON.stringify(result).includes('/private'), false)
})

test('renderer service accepts the exact key-only recovery-required discovery shape', async () => {
  const api = {
    list: async () => ({
      ok: true,
      value: {
        projects: [{ projectKey: PROJECT_KEY, status: 'needs-recovery' }],
        issues: [{ projectKey: PROJECT_KEY, status: 'needs-recovery', code: 'recovery_required' }],
      },
    }),
  } as unknown as WorldProjectsApi
  assert.deepEqual(await createWorldProjectService(api).list(), {
    ok: true,
    value: {
      projects: [{ projectKey: PROJECT_KEY, status: 'needs-recovery' }],
      issues: [{ projectKey: PROJECT_KEY, status: 'needs-recovery', code: 'recovery_required' }],
    },
  })
})

test('renderer service binds open, command, delete, and explicit create identities to each request', async () => {
  const otherSnapshot = createServiceSnapshot(OTHER_PROJECT_KEY)
  const wrongOpen = {
    open: async () => ({
      ok: true,
      value: { status: 'ready', projectKey: OTHER_PROJECT_KEY, snapshot: otherSnapshot, durabilityWarnings: [] },
    }),
  } as unknown as WorldProjectsApi
  assert.equal((await createWorldProjectService(wrongOpen).open({ projectKey: PROJECT_KEY })).ok, false)

  const inverseSnapshot = structuredClone(otherSnapshot)
  inverseSnapshot.project.revision -= 1
  const wrongCommand = {
    applyCommands: async () => ({
      ok: true,
      value: {
        projectKey: OTHER_PROJECT_KEY,
        snapshot: otherSnapshot,
        newRevision: otherSnapshot.project.revision,
        idempotent: false,
        changes: [],
        warnings: [],
        inverse: { kind: 'world-snapshot', snapshot: inverseSnapshot },
        receipt: {
          transactionId: 'tx:request',
          payloadSha256: 'a'.repeat(64),
          resultSha256: 'b'.repeat(64),
          appliedRevision: otherSnapshot.project.revision,
        },
      },
    }),
  } as unknown as WorldProjectsApi
  const batch = {
    schema: 'modly.world-command-batch.v1' as const,
    transactionId: 'tx:request',
    projectId: otherSnapshot.project.projectId,
    baseRevision: otherSnapshot.project.revision - 1,
    origin: 'ui' as const,
    commands: [{ type: 'rename-project' as const, name: 'Requested name' }],
  }
  assert.equal((await createWorldProjectService(wrongCommand).applyCommands({ projectKey: PROJECT_KEY, batch })).ok, false)

  const wrongDelete = {
    delete: async () => ({
      ok: true,
      value: { projectKey: OTHER_PROJECT_KEY, transactionId: 'tx:delete-request', idempotent: false },
    }),
  } as unknown as WorldProjectsApi
  assert.equal((await createWorldProjectService(wrongDelete).delete({
    projectKey: PROJECT_KEY,
    expectedRevision: 4,
    transactionId: 'tx:delete-request',
  })).ok, false)

  const wrongCreate = {
    create: async () => ({
      ok: true,
      value: { projectKey: PROJECT_KEY, snapshot: createServiceSnapshot(), durabilityWarnings: [] },
    }),
  } as unknown as WorldProjectsApi
  assert.equal((await createWorldProjectService(wrongCreate).create({
    name: 'World',
    initialSceneName: 'Scene',
    projectId: 'project:requested',
  })).ok, false)
})

test('renderer service has no filesystem, Electron-main, or Zustand authority imports', async () => {
  const source = await readFile(new URL('./worldProjectService.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /(?:node:fs|from ['"]fs|electron\/main|zustand)/)
})
