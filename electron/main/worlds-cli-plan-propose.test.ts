import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { WORLD_CLI_DIRECT_EDIT_LIMIT, WorldsCliTransport, type WorldsCliDirectEditReservation } from './worlds-cli-transport.ts'
import { WorldProjectRepository } from './world-project-repository.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStrictWorldsCliJson } from './worlds-cli-recipe-json.ts'
import { confirmWorldsCliApply } from './worlds-cli-ipc.ts'
import { createWorldsCliDirectEditDispatch } from './worlds-cli-direct-edit-dispatch.ts'
import { canonicalWorldCommandBatchPayload, type WorldCommandBatchV1 } from '../../src/areas/worlds/core/worldCommands.ts'
import { canonicalWorldProjectSnapshotPayload } from '../../src/areas/worlds/core/worldSnapshotDigest.ts'

const projectKey = `world-${'a'.repeat(32)}`
const session = 'b'.repeat(64)
const sceneId = 'scene:one'

test('outer UDS JSON rejects duplicate keys and overflow before dispatch', () => {
  assert.throws(() => parseStrictWorldsCliJson('{"operation":"list","operation":"propose"}'))
  assert.throws(() => parseStrictWorldsCliJson('{"revision":1e999}'))
  assert.throws(() => parseStrictWorldsCliJson('['.repeat(20) + '0' + ']'.repeat(20)))
})

function harness(dispatchDirectEditProposal?: ConstructorParameters<typeof WorldsCliTransport>[0]['dispatchDirectEditProposal']) {
  let now = 10_000
  let revision = 3
  let window = { id: 'trusted-window' }
  let contents = { id: 'trusted-contents' }
  let frame = { id: 'trusted-frame' }
  let workspaceRoot = '/tmp'
  const queried: unknown[] = []
  const delivered: unknown[] = []
  const previewed: unknown[] = []
  const discarded: unknown[] = []
  let previewGate: Promise<void> | null = null
  let previewBatchTransform: (batch: WorldCommandBatchV1) => unknown = (batch) => batch
  const repository = {
    async list() { return { ok: true, value: { projects: [], issues: [] } } },
    async open() { return { ok: true, value: { status: 'ready', snapshot: { project: {
      projectId: 'project:one', name: 'Example', revision, startSceneId: sceneId,
      scenes: [{ id: sceneId, name: 'One' }, { id: 'scene:two', name: 'Two' }], resources: [],
    }, scenes: [] } } } },
    async queryAiForCli(value: unknown) { queried.push(value); const request = value as { context: unknown; query: { kind: string; cursor?: string } }
      return { ok: true, value: { context: request.context, kind: request.query.kind, items: request.query.kind === 'entities'
        ? [{ kind: 'entity', id: 'entity:one', name: 'One', parentId: null, enabled: true, locked: false,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, componentCount: 0 }]
        : [{ kind: 'scene', id: request.query.cursor ? 'scene:two' : sceneId, name: 'One', isActive: true, isStart: true, entityCount: 1 }],
        total: request.query.kind === 'scenes' ? 2 : 1,
        nextCursor: request.query.kind === 'scenes' && !request.query.cursor
          ? JSON.stringify([JSON.stringify([request.context, 'scenes', null]), 1]) : null } } },
    async queryAi(value: unknown) { return this.queryAiForCli(value) },
    async recordCliAiObservation(context: unknown, page: unknown) { delivered.push({ context, page }) },
    async previewCliAi(value: unknown) { previewed.push(value); if (previewGate) await previewGate; const proposal = value as { context: { projectId: string; baseRevision: number; requestId: string } }
      const batch: WorldCommandBatchV1 = { schema: 'modly.world-command-batch.v1', transactionId: proposal.context.requestId,
        projectId: proposal.context.projectId, baseRevision: proposal.context.baseRevision, origin: 'ai',
        commands: [{ type: 'rename-project', name: 'Renamed' }] }
      return { ok: true, value: { batch: previewBatchTransform(batch), snapshot: { project: { revision } },
      review: { complete: true, changes: [{ field: 'project.scenes.length', before: '1', after: '2' }], warnings: [] }, authority: 'apply_secret', candidateSnapshotSha256: 'a'.repeat(64) } } },
    async discardAi(value: unknown) { discarded.push(value); return { ok: true, value: { discarded: true } } },
  }
  const transport = new WorldsCliTransport({ repository: repository as never, runtimeDir: '/tmp/worlds-cli-unused', now: () => now,
    captureTrust: () => ({ window, contents, frame, documentUrl: 'file:///trusted/index.html', documentEpoch: 0, workspaceRoot }),
    dispatchDirectEditProposal } as never)
  Object.assign(transport, { session, sessionId: 'c'.repeat(32), sessionExpiresAt: now + 300_000 })
  const deliveredCallbacks: Array<() => void> = []
  const dispatch = (request: Record<string, unknown>) => (transport as unknown as {
    dispatch(request: Record<string, unknown>, onDelivery: (callback: () => void) => void): Promise<Record<string, unknown>>
  }).dispatch({ session, ...request }, (callback) => { deliveredCallbacks.push(callback) })
  return { transport, repository, queried, delivered, previewed, discarded, dispatch, deliveredCallbacks,
    trust: () => ({ window, contents, frame, documentUrl: 'file:///trusted/index.html', documentEpoch: 0, workspaceRoot }),
    advance(ms: number) { now += ms }, changeRevision(value: number) { revision = value }, swapWindow() { window = { id: 'foreign-window' } },
    swapFrame() { frame = { id: 'foreign-frame' }; contents = { id: 'foreign-contents' } },
    changeWorkspace(value: string) { workspaceRoot = value }, holdPreview(gate: Promise<void>) { previewGate = gate },
    transformPreviewBatch(transform: (batch: WorldCommandBatchV1) => unknown) { previewBatchTransform = transform },
    swapSession() { Object.assign(transport, { session: 'd'.repeat(64), sessionId: 'd'.repeat(32), generation: 1 }) } }
}

function directEditHarness() {
  let now = 20_000
  let diskRevision = 3
  let corruptDisk = false
  const window = { id: 'direct-window' }
  const contents = { id: 'direct-contents' }
  const frame = { id: 'direct-frame' }
  const trust = { window, contents, frame, documentUrl: 'file:///trusted/index.html', documentEpoch: 2, workspaceRoot: '/tmp' }
  const sessionId = 'c'.repeat(32)
  const transactionId = '1'.repeat(32)
  const proposalId = `proposal_${'2'.repeat(48)}`
  const beforeSnapshot = { project: { projectId: 'project:one', name: 'Before', revision: 3, startSceneId: sceneId,
    scenes: [{ id: sceneId, name: 'One' }], resources: [] }, scenes: [] }
  const candidateSnapshot = { project: { ...beforeSnapshot.project, name: 'Renamed', revision: 4 }, scenes: [] }
  const batch: WorldCommandBatchV1 = { schema: 'modly.world-command-batch.v1', transactionId, projectId: 'project:one',
    baseRevision: 3, origin: 'ai', commands: [{ type: 'rename-project', name: 'Renamed' }] }
  const digest = createHash('sha256').update(canonicalWorldCommandBatchPayload(batch)).digest('hex')
  const candidateSnapshotSha256 = createHash('sha256').update(canonicalWorldProjectSnapshotPayload(candidateSnapshot)).digest('hex')
  const discarded: unknown[] = []
  const scopedApplied: unknown[] = []
  const repository = {
    async list() { return { ok: true, value: { projects: [], issues: [] } } },
    async open() { const snapshot = diskRevision === 3 ? beforeSnapshot : corruptDisk
      ? { ...candidateSnapshot, project: { ...candidateSnapshot.project, name: 'Substituted' } } : candidateSnapshot
      return { ok: true, value: { status: 'ready', snapshot: structuredClone(snapshot) } } },
    async queryAi() { throw new Error('unused') },
    async discardAi(value: unknown) { discarded.push(value); return { ok: true, value: { discarded: true } } },
    async applyScopedCliAi(request: { assertLive(): void; onJournalStart(): void }) {
      scopedApplied.push(request)
      request.assertLive()
      request.onJournalStart()
      diskRevision = 4
      return { ok: true, value: { projectKey, snapshot: structuredClone(candidateSnapshot), newRevision: 4, idempotent: false,
        changes: ['project.name'], warnings: [], inverse: { kind: 'world-snapshot', snapshot: structuredClone(beforeSnapshot) },
        receipt: { transactionId, appliedRevision: 4, payloadSha256: '3'.repeat(64), resultSha256: '4'.repeat(64) } } }
    },
  }
  const captureTrust = () => trust
  const grantedScope = { projectKey, projectId: 'project:one', sceneId, revision: 3, editorEpoch: 7,
    trust, canonicalWorkspace: '/tmp' }
  const transport = new WorldsCliTransport({ repository: repository as never, runtimeDir: '/tmp/worlds-cli-unused', now: () => now,
    captureTrust, activeEditorScope: async () => grantedScope, onPairRequest: async () => ({ ok: true }) })
  Object.assign(transport, { session, sessionId, sessionExpiresAt: now + 20_000, grantedScope,
    directEditBudget: { sessionId, generation: 0, admitted: 0 } })
  const context = Object.freeze({ schema: 'modly.world-ai-context.v1', projectKey, projectId: 'project:one', baseRevision: 3,
    activeSceneId: sceneId, editorEpoch: 0, originSessionId: sessionId, requestId: transactionId })
  const entry = { id: proposalId, planId: 'plan-direct', context, sessionId, generation: 0, trust, canonicalWorkspace: '/tmp',
    expiresAt: now + 10_000, digest, batch: Object.freeze(structuredClone(batch)), snapshot: Object.freeze(structuredClone(beforeSnapshot)),
    candidateSnapshotSha256, review: { complete: true, changes: [{ field: 'project.name', before: 'Before', after: 'Renamed' }], warnings: [] },
    authority: `apply_${'5'.repeat(48)}`, state: 'pending', revoked: false, discardRequested: false }
  const proposals = (transport as unknown as { proposals: Map<string, typeof entry> }).proposals
  proposals.set(proposalId, entry)
  const dispatch = (request: Record<string, unknown>) => (transport as unknown as {
    dispatch(request: Record<string, unknown>): Promise<Record<string, unknown>>
  }).dispatch({ session, ...request })
  return { transport, repository, entry, proposals, proposalId, transactionId, digest, candidateSnapshotSha256,
    discarded, scopedApplied, dispatch, advance(ms: number) { now += ms }, corruptDisk() { corruptDisk = true },
    grantedScope: () => (transport as unknown as { grantedScope: typeof grantedScope }).grantedScope }
}

test('revocation or session replacement during every read await suppresses the result', async () => {
  const cases = [
    { held: 'list', request: { operation: 'list' }, invalidate: 'revoke' },
    { held: 'open', request: { operation: 'open', projectKey }, invalidate: 'swap' },
    { held: 'open', request: { operation: 'query', projectKey, revision: 3, kind: 'scenes' }, invalidate: 'revoke' },
    { held: 'queryAi', request: { operation: 'query', projectKey, revision: 3, kind: 'scenes' }, invalidate: 'swap' },
  ] as const
  for (const scenario of cases) {
    const h = harness()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const repository = h.repository as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const original = repository[scenario.held].bind(h.repository)
    repository[scenario.held] = async (...args: unknown[]) => { entered(); await gate; return original(...args) }
    const pending = h.dispatch(scenario.request as Record<string, unknown>)
    await started
    if (scenario.invalidate === 'revoke') await h.transport.revoke()
    else h.swapSession()
    release()
    assert.deepEqual(await pending, { ok: false, code: 'UNAUTHORIZED' }, scenario.held)
  }
})

test('the final UDS send gate suppresses a read when revoke lands between dispatch completion and serialization', async () => {
  const h = harness()
  const internals = h.transport as unknown as {
    dispatch(request: Record<string, unknown>): Promise<Record<string, unknown>>
    dispatchFrame(socket: object, body: Buffer): Promise<void>
    send(socket: object, response: Record<string, unknown>): void
  }
  const dispatch = internals.dispatch.bind(h.transport)
  internals.dispatch = async (request) => {
    const result = await dispatch(request)
    queueMicrotask(() => { void h.transport.revoke() })
    return result
  }
  let sent: Record<string, unknown> | null = null
  internals.send = (_socket, response) => { sent = response }
  await internals.dispatchFrame({}, Buffer.from(JSON.stringify({ operation: 'list', session })))
  assert.deepEqual(sent, { ok: false, code: 'UNAUTHORIZED' })
})

test('planless query returns only session-bound opaque cursors, not canonical host context', async () => {
  const h = harness()
  const first = await h.dispatch({ operation: 'query', projectKey, revision: 3, kind: 'scenes', pageSize: 1 })
  assert.equal(first.ok, true)
  const cursor = (first.page as { nextCursor: string }).nextCursor
  assert.match(cursor, /^cursor_[a-f0-9]{48}$/)
  assert.equal(JSON.stringify(first).includes('originSessionId'), false)
  assert.deepEqual(await h.dispatch({ operation: 'query', projectKey, revision: 3, kind: 'entities', cursor }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await h.dispatch({ operation: 'query', projectKey, revision: 4, kind: 'scenes', cursor }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await h.dispatch({ operation: 'query', projectKey: `world-${'d'.repeat(32)}`, revision: 3,
    kind: 'scenes', cursor }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await h.dispatch({ operation: 'query', projectKey, revision: 3, sceneId: 'scene:two',
    kind: 'scenes', cursor }), { ok: false, code: 'INVALID_REQUEST' })
  const second = await h.dispatch({ operation: 'query', projectKey, revision: 3, kind: 'scenes', cursor, pageSize: 1 })
  assert.equal(second.ok, true)
  assert.equal((second.page as { nextCursor: unknown }).nextCursor, null)
  h.swapSession()
  const swapped = await (h.transport as unknown as { dispatch(request: Record<string, unknown>): Promise<Record<string, unknown>> }).dispatch({
    operation: 'query', session: 'd'.repeat(64), projectKey, revision: 3, kind: 'scenes', cursor,
  })
  assert.deepEqual(swapped, { ok: false, code: 'INVALID_REQUEST' })
})

test('one Main plan carries the same context through distinct delivered query filters and one typed proposal', async () => {
  const h = harness()
  const plan = await h.dispatch({ operation: 'plan', projectKey, sceneId })
  assert.equal(plan.ok, true)
  const planId = plan.planId as string
  const scenes = await h.dispatch({ operation: 'query', projectKey, revision: 3, sceneId, kind: 'scenes', planId })
  assert.equal(scenes.ok, true)
  const cursor = (scenes.page as Record<string, unknown>).nextCursor as string
  assert.match(cursor, /^cursor_[a-f0-9]+$/)
  assert.equal(cursor.includes('originSessionId'), false)
  assert.equal(h.delivered.length, 0, 'observation must await delivery')
  assert.deepEqual(await h.dispatch({ operation: 'ack', projectKey, planId, deliveryId: scenes.deliveryId }), { ok: true })
  const next = await h.dispatch({ operation: 'query', projectKey, revision: 3, sceneId, kind: 'scenes', cursor, planId })
  assert.equal(next.ok, true)
  assert.deepEqual(await h.dispatch({ operation: 'ack', projectKey, planId, deliveryId: next.deliveryId }), { ok: true })
  const entities = await h.dispatch({ operation: 'query', projectKey, revision: 3, sceneId, kind: 'entities', planId })
  assert.equal(entities.ok, true)
  assert.deepEqual(await h.dispatch({ operation: 'ack', projectKey, planId, deliveryId: entities.deliveryId }), { ok: true })
  assert.deepEqual((h.queried[0] as { context: unknown }).context, (h.queried[1] as { context: unknown }).context)
  const proposed = await h.dispatch({ operation: 'propose', projectKey, planId,
    json: JSON.stringify({ commands: [{ type: 'create-scene', localRef: 'next', name: 'Next' }] }) })
  assert.equal(proposed.ok, true)
  assert.equal(h.delivered.length, 3)
  assert.match(proposed.proposalId as string, /^proposal_[a-f0-9]+$/)
  assert.match(proposed.digest as string, /^[a-f0-9]{64}$/)
  const publicData = JSON.stringify(proposed)
  for (const secret of ['batch', 'snapshot', 'inverse', 'apply_secret', 'authority', 'transactionId', 'requestId', 'changes', 'warnings', '/tmp']) {
    assert.equal(publicData.includes(secret), false)
  }
  const pending = [...(h.transport as unknown as { proposals: Map<string, {
    context: { requestId: string }; batch: WorldCommandBatchV1; digest: string
  }> }).proposals.values()]
  assert.equal(pending.length, 1)
  assert.equal(pending[0].context.requestId, pending[0].batch.transactionId)
  const expectedDigest = createHash('sha256').update(canonicalWorldCommandBatchPayload(pending[0].batch)).digest('hex')
  assert.equal(pending[0].digest, expectedDigest)
  assert.equal(proposed.digest, expectedDigest)
  assert.equal(Object.isFrozen(pending[0].context), true)
  assert.equal(Object.isFrozen(pending[0].batch), true)
  assert.equal(h.previewed.length, 1)
  assert.deepEqual(await h.dispatch({ operation: 'propose', projectKey, planId, json: '{"commands":[]}' }), { ok: false, code: 'INVALID_REQUEST' })
  for (const operation of ['apply', 'reject', 'undo']) assert.deepEqual(await h.dispatch({ operation }), { ok: false, code: 'UNSUPPORTED' })
})

test('production propose dispatches exactly once, returns only the immutable dispatch receipt, and never reports APPLIED', async () => {
  const calls: string[] = []
  const h = harness(async (proposalId) => {
    calls.push(proposalId)
    return { ok: true, editIntent: `edit_${'e'.repeat(48)}`, expiresAt: 99_999, status: 'APPLIED' } as never
  })
  const plan = await h.dispatch({ operation: 'plan', projectKey, sceneId })
  const response = await h.dispatch({ operation: 'propose', projectKey, planId: plan.planId,
    json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0], response.proposalId)
  assert.deepEqual(Object.keys(response).sort(), [
    'changeCount', 'commandCount', 'digest', 'expiresAt', 'ok', 'projectKey', 'proposalId', 'revision', 'status',
  ])
  assert.equal(response.status, 'direct-edit-dispatched')
  assert.equal(JSON.stringify(response).includes('APPLIED'), false)
  assert.equal(JSON.stringify(response).includes('edit_'), false)
})

test('production propose consumes a failed dispatch once and never retries its proposal capability', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return { ok: false, code: 'STALE' } })
  const plan = await h.dispatch({ operation: 'plan', projectKey, sceneId })
  const request = { operation: 'propose', projectKey, planId: plan.planId,
    json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' }
  assert.deepEqual(await h.dispatch(request), { ok: false, code: 'STALE' })
  assert.equal(calls, 1)
  assert.equal((h.transport as unknown as { proposals: Map<string, unknown> }).proposals.size, 0)
  assert.equal(h.discarded.length, 1)
  assert.deepEqual(await h.dispatch(request), { ok: false, code: 'INVALID_REQUEST' })
  assert.equal(calls, 1)
})

test('real production composition stores one pending ID, reserves it through the late-bound helper, dispatches, and cleans custody', async () => {
  const h = harness((proposalId) => dispatch(proposalId))
  const trust = h.trust()
  const scope = { projectKey, projectId: 'project:one', sceneId, revision: 3, editorEpoch: 0,
    trust, canonicalWorkspace: '/tmp' }
  Object.assign(h.repository, { applyScopedCliAi: async () => ({ ok: false, error: { code: 'write_failed' } }) })
  Object.assign(h.transport, { activeEditorScope: async () => scope, onPairRequest: async () => ({ ok: true }),
    grantedScope: scope, directEditBudget: { sessionId: 'c'.repeat(32), generation: 0, admitted: 0 } })
  const reservations: unknown[] = []
  const dispatch = createWorldsCliDirectEditDispatch(() => h.transport, { async execute(reservation: WorldsCliDirectEditReservation) {
    reservations.push(reservation)
    await reservation.finish()
    return { ok: true, editIntent: `edit_${'f'.repeat(48)}`, expiresAt: 99_999 }
  } })
  const plan = await h.dispatch({ operation: 'plan', projectKey, sceneId })
  const response = await h.dispatch({ operation: 'propose', projectKey, planId: plan.planId,
    json: `{"commands":[{"type":"create-entity","kind":"group","localRef":"group","sceneRef":{"kind":"existing","id":"${sceneId}"},"name":"Group"}]}` })
  assert.equal(response.status, 'direct-edit-dispatched')
  assert.equal(reservations.length, 1)
  assert.equal((h.transport as unknown as { proposals: Map<string, unknown> }).proposals.size, 0)
  assert.equal(h.discarded.length, 1)
})

test('preview publication rejects identity drift, malformed or noncanonical batches and malicious wire values', async () => {
  const maliciousBatch = Object.defineProperty({
    schema: 'modly.world-command-batch.v1', transactionId: 'a'.repeat(32), projectId: 'project:one',
    baseRevision: 3, origin: 'ai',
  }, 'commands', { enumerable: true, get() { throw new Error('must not invoke preview accessors') } })
  const cases: Array<[string, (batch: WorldCommandBatchV1) => unknown]> = [
    ['transaction', (batch) => ({ ...batch, transactionId: 'd'.repeat(32) })],
    ['project', (batch) => ({ ...batch, projectId: 'project:other' })],
    ['revision', (batch) => ({ ...batch, baseRevision: batch.baseRevision + 1 })],
    ['origin', (batch) => ({ ...batch, origin: 'ui' })],
    ['noncanonical', (batch) => ({ ...batch, commands: [{ type: 'rename-project', name: ' Renamed ' }] })],
    ['unknown field', (batch) => ({ ...batch, unexpected: true })],
    ['malicious accessor', () => maliciousBatch],
  ]
  for (const [label, transform] of cases) {
    const h = harness()
    const plan = await h.dispatch({ operation: 'plan', projectKey, sceneId })
    assert.equal(plan.ok, true, label)
    h.transformPreviewBatch(transform)
    const result = await h.dispatch({ operation: 'propose', projectKey, planId: plan.planId,
      json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' })
    assert.deepEqual(result, { ok: false, code: 'INVALID_REQUEST' }, label)
    assert.equal(h.discarded.length, 1, `${label}: authority discarded`)
    assert.equal((h.transport as unknown as { proposals: Map<string, unknown> }).proposals.size, 0, `${label}: no proposal retained`)
  }
})

test('internal direct-edit reservation is opaque, one-use, disk-verified and advances only the granted revision', async () => {
  const h = directEditHarness()
  assert.deepEqual(await h.dispatch({ operation: 'edit', proposalId: h.proposalId }), { ok: false, code: 'UNSUPPORTED' })
  const reserved = await h.transport.reserveDirectEdit(h.proposalId)
  assert.ok(reserved.ok)
  const { reservation } = reserved
  assert.equal(Object.isFrozen(reservation), true)
  assert.equal(Object.isFrozen(reservation.source), true)
  assert.equal(Object.isFrozen(reservation.source.scope), true)
  assert.deepEqual(Object.keys(reservation).sort(), ['advanceScope', 'commit', 'finish', 'source', 'verifyDisk'])
  assert.deepEqual(Object.keys(reservation.source).sort(), [
    'beforeSnapshotSha256', 'candidateSnapshotSha256', 'digest', 'expiresAt', 'proposalId', 'scope', 'transactionId',
  ])
  assert.deepEqual(Object.keys(reservation.source.scope).sort(), [
    'editorEpoch', 'generation', 'mode', 'projectId', 'projectKey', 'revision', 'sceneId', 'sessionExpiresAt', 'sessionId',
  ])
  assert.equal(reservation.source.proposalId, h.proposalId)
  assert.equal(reservation.source.transactionId, h.transactionId)
  assert.equal(reservation.source.digest, h.digest)
  const serialized = JSON.stringify(reservation)
  for (const secret of ['batch', 'commands', 'authority', `apply_${'5'.repeat(48)}`]) assert.equal(serialized.includes(secret), false)
  for (const privateIdentity of ['documentUrl', 'workspaceRoot', 'canonicalWorkspace', 'window', 'contents', 'frame', 'file:', '/tmp']) {
    assert.equal(serialized.includes(privateIdentity), false, `reservation leaks ${privateIdentity}`)
  }
  assert.deepEqual(await h.dispatch({ operation: 'list' }), { ok: false, code: 'BUSY' })
  assert.deepEqual(await h.transport.getReview({ proposalId: h.proposalId }), { ok: false, code: 'BUSY' })
  assert.deepEqual(await h.transport.reserveDirectEdit(h.proposalId), { ok: false, code: 'BUSY' })
  let journal = 0
  const committed = await reservation.commit({ assertLive: () => {}, onJournalStart: () => { journal++ } })
  assert.ok(committed.ok)
  assert.equal(journal, 1)
  assert.deepEqual(committed.receipt, { transactionId: h.transactionId, projectId: 'project:one', newRevision: 4,
    snapshotSha256: h.candidateSnapshotSha256 })
  assert.deepEqual(await reservation.commit({ assertLive: () => {}, onJournalStart: () => {} }), { ok: false, code: 'BUSY' })
  assert.deepEqual(await reservation.verifyDisk(committed.receipt), { ok: true })
  assert.deepEqual(await reservation.verifyDisk(committed.receipt), { ok: false, code: 'BUSY' })
  const beforeAdvance = h.grantedScope()
  assert.deepEqual(reservation.advanceScope(committed.receipt), { ok: true, revision: 4 })
  const afterAdvance = h.grantedScope()
  assert.deepEqual(afterAdvance, { ...beforeAdvance, revision: 4 })
  assert.deepEqual(reservation.advanceScope(committed.receipt), { ok: false, code: 'BUSY' })
  assert.deepEqual(await reservation.finish(), { ok: true })
  assert.deepEqual(await reservation.finish(), { ok: false, code: 'STALE' })
  assert.equal(h.proposals.size, 0)
  assert.equal(h.discarded.length, 1)
})

test('direct-edit admission budget consumes attempts 1 through 8, denies 9, and never refunds finish failures', async () => {
  const h = directEditHarness()
  const makeEntry = (index: number) => {
    const id = `proposal_${index.toString(16).padStart(48, '0')}`
    const entry = { ...h.entry, id, state: 'pending' as const, revoked: false, discardRequested: false }
    h.proposals.set(id, entry)
    return id
  }
  h.proposals.clear()
  for (let index = 1; index <= WORLD_CLI_DIRECT_EDIT_LIMIT; index++) {
    const result = await h.transport.reserveDirectEdit(makeEntry(index))
    assert.ok(result.ok, `admission ${index}`)
    assert.deepEqual(await result.reservation.finish(), { ok: true })
  }
  const ninth = makeEntry(WORLD_CLI_DIRECT_EDIT_LIMIT + 1)
  assert.deepEqual(await h.transport.reserveDirectEdit(ninth), { ok: false, code: 'BUSY' })
  assert.equal(h.proposals.has(ninth), false)
  assert.equal(h.discarded.length, WORLD_CLI_DIRECT_EDIT_LIMIT + 1)
})

test('direct-edit reservation rejects reviewed races, malformed or expired scope and never creates a UDS edit operation', async () => {
  const reviewed = directEditHarness()
  const review = await reviewed.transport.getReview({ proposalId: reviewed.proposalId })
  assert.ok(review.ok)
  assert.deepEqual(await reviewed.transport.reserveDirectEdit(reviewed.proposalId), { ok: false, code: 'BUSY' })

  const reserved = directEditHarness()
  const result = await reserved.transport.reserveDirectEdit(reserved.proposalId)
  assert.ok(result.ok)
  assert.deepEqual(await reserved.transport.apply({ proposalId: reserved.proposalId, reviewId: `review_${'6'.repeat(48)}` }, async () => true),
    { ok: false, code: 'BUSY' })
  assert.deepEqual(await reserved.dispatch({ operation: 'edit', proposalId: reserved.proposalId }), { ok: false, code: 'BUSY' })
  await result.reservation.finish()

  const malformed = directEditHarness()
  Object.assign(malformed.grantedScope(), { sceneId: '' })
  assert.deepEqual(await malformed.transport.reserveDirectEdit(malformed.proposalId), { ok: false, code: 'STALE' })
  const expired = directEditHarness()
  expired.advance(10_001)
  assert.deepEqual(await expired.transport.reserveDirectEdit(expired.proposalId), { ok: false, code: 'NOT_FOUND' })
})

test('direct-edit commit rejects entry substitution and identity drift before repository mutation', async () => {
  const mutations: Array<[string, (h: ReturnType<typeof directEditHarness>) => unknown]> = [
    ['entry substitution', (h) => { const replacement = { ...h.entry }; h.proposals.set(h.proposalId, replacement); return replacement }],
    ['digest drift', (h) => { h.entry.digest = 'f'.repeat(64) }],
    ['transaction drift', (h) => { h.entry.batch = { ...h.entry.batch, transactionId: '9'.repeat(32) } }],
    ['authority drift', (h) => { h.entry.authority = `apply_${'7'.repeat(48)}` }],
    ['context drift', (h) => { (h.entry as unknown as { context: Record<string, unknown> }).context = {
      ...h.entry.context, projectId: 'project:other',
    } }],
  ]
  for (const [label, mutate] of mutations) {
    const h = directEditHarness()
    const originalContext = h.entry.context
    const originalAuthority = h.entry.authority
    const reserved = await h.transport.reserveDirectEdit(h.proposalId)
    assert.ok(reserved.ok, label)
    const replacement = mutate(h)
    assert.deepEqual(await reserved.reservation.commit({ assertLive: () => {}, onJournalStart: () => {} }),
      { ok: false, code: 'STALE' }, label)
    assert.equal(h.scopedApplied.length, 0, label)
    assert.deepEqual(await reserved.reservation.finish(), { ok: true }, label)
    assert.equal(h.discarded.length, 1, label)
    assert.deepEqual(h.discarded[0], { context: originalContext, authority: originalAuthority }, `${label}: original authority discarded`)
    if (replacement) {
      assert.equal(h.proposals.get(h.proposalId), replacement, `${label}: replacement remains mapped`)
      assert.deepEqual(await h.transport.reserveDirectEdit(h.proposalId), { ok: false, code: 'BUSY' },
        `${label}: old reservation cannot claim replacement`)
      assert.deepEqual(await reserved.reservation.finish(), { ok: false, code: 'STALE' }, `${label}: old reservation is tombstoned`)
      assert.equal(h.proposals.get(h.proposalId), replacement, `${label}: tombstoned reservation leaves replacement mapped`)
    }
  }
})

test('direct-edit synchronous tombstone blocks commit and fresh disk mismatch never verifies', async () => {
  const tombstoned = directEditHarness()
  const first = await tombstoned.transport.reserveDirectEdit(tombstoned.proposalId)
  assert.ok(first.ok)
  const blocked = await first.reservation.commit({ assertLive: () => {}, onJournalStart: () => { throw new Error('tombstoned') } })
  assert.deepEqual(blocked, { ok: false, code: 'UNAVAILABLE' })
  assert.equal(tombstoned.scopedApplied.length, 1)
  assert.deepEqual(await first.reservation.finish(), { ok: true })

  const mismatched = directEditHarness()
  const second = await mismatched.transport.reserveDirectEdit(mismatched.proposalId)
  assert.ok(second.ok)
  const committed = await second.reservation.commit({ assertLive: () => {}, onJournalStart: () => {} })
  assert.ok(committed.ok)
  mismatched.corruptDisk()
  assert.deepEqual(await second.reservation.verifyDisk(committed.receipt), { ok: false, code: 'AMBIGUOUS' })
  assert.deepEqual(second.reservation.advanceScope(committed.receipt), { ok: false, code: 'BUSY' })
  assert.deepEqual(await second.reservation.finish(), { ok: true })
})

test('plans reject foreign scene, project, revision, window, workspace, expiry and malformed recipes', async () => {
  const h = harness()
  const plan = await h.dispatch({ operation: 'plan', projectKey, sceneId })
  const planId = plan.planId as string
  assert.deepEqual(await h.dispatch({ operation: 'query', projectKey, revision: 3, sceneId: 'scene:two', kind: 'scenes', planId }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await h.dispatch({ operation: 'query', projectKey: `world-${'d'.repeat(32)}`, revision: 3, sceneId, kind: 'scenes', planId }), { ok: false, code: 'INVALID_REQUEST' })
  assert.deepEqual(await h.dispatch({ operation: 'query', projectKey, revision: 4, sceneId, kind: 'scenes', planId }), { ok: false, code: 'INVALID_REQUEST' })
  for (const json of ['{"commands":[],"commands":[]}', '{"commands":[{"type":"create-scene","localRef":"x","name":"/tmp/leak"}]}',
    '{"commands":[{"type":"create-scene","localRef":"x","name":"X","path":"secret"}]}',
    '{"commands":[{"type":"create-entity","kind":"observed-model","localRef":"x","name":"X","sceneRef":{"kind":"existing","id":"scene:one"},"resourceHandle":"asset_' + 'a'.repeat(32) + '"}]}',
    '{"commands":[{"type":"create-scene","localRef":"x","name":"X","origin":"ai"}]}',
    '{"context":{},"commands":[{"type":"create-scene","localRef":"x","name":"X"}]}',
    '{"batch":{},"commands":[{"type":"create-scene","localRef":"x","name":"X"}]}',
    '{"transactionId":"tx:fake","commands":[{"type":"create-scene","localRef":"x","name":"X"}]}',
    '{"commands":[{"type":"create-scene","localRef":"x","name":"X","intensity":1e999}]}',
    '{"commands":' + '['.repeat(20) + ']'.repeat(20) + '}',
    '{"commands":[{"type":"create-scene","localRef":"x","name":"' + 'X'.repeat(8192) + '"}]}']) {
    assert.deepEqual(await h.dispatch({ operation: 'propose', projectKey, planId, json }), { ok: false, code: 'INVALID_REQUEST' })
  }
  h.changeWorkspace('/')
  assert.deepEqual(await h.dispatch({ operation: 'query', projectKey, revision: 3, sceneId, kind: 'scenes', planId }), { ok: false, code: 'INVALID_REQUEST' })
  h.changeWorkspace('/tmp')
  h.swapWindow()
  assert.deepEqual(await h.dispatch({ operation: 'query', projectKey, revision: 3, sceneId, kind: 'scenes', planId }), { ok: false, code: 'INVALID_REQUEST' })
  const navigated = harness()
  const navigationPlan = await navigated.dispatch({ operation: 'plan', projectKey, sceneId })
  navigated.swapFrame()
  assert.deepEqual(await navigated.dispatch({ operation: 'propose', projectKey, planId: navigationPlan.planId,
    json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' }), { ok: false, code: 'INVALID_REQUEST' })
  h.advance(400_000)
  assert.deepEqual(await h.dispatch({ operation: 'query', projectKey, revision: 3, sceneId, kind: 'scenes', planId }), { ok: false, code: 'UNAUTHORIZED' })
  const expired = harness()
  const shortPlan = await expired.dispatch({ operation: 'plan', projectKey, sceneId })
  expired.advance(121_000)
  assert.deepEqual(await expired.dispatch({ operation: 'propose', projectKey, planId: shortPlan.planId,
    json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' }), { ok: false, code: 'INVALID_REQUEST' })
})

test('stale revision, session replacement and revoke during preview cannot enqueue a pending receipt', async () => {
  const h = harness()
  const plan = await h.dispatch({ operation: 'plan', projectKey, sceneId })
  const planId = plan.planId as string
  h.changeRevision(4)
  assert.deepEqual(await h.dispatch({ operation: 'propose', projectKey, planId,
    json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' }), { ok: false, code: 'INVALID_REQUEST' })
  assert.equal(h.previewed.length, 0)
  h.changeRevision(3)
  let release!: () => void
  h.holdPreview(new Promise<void>((resolve) => { release = resolve }))
  const pending = h.dispatch({ operation: 'propose', projectKey, planId,
    json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' })
  for (let i = 0; i < 30 && !h.previewed.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.previewed.length, 1)
  await h.transport.revoke()
  release()
  assert.deepEqual(await pending, { ok: false, code: 'INVALID_REQUEST' })
  assert.equal(h.discarded.length, 1)
  assert.equal((h.transport as unknown as { proposals: Map<string, unknown> }).proposals.size, 0)
  const another = harness()
  const newPlan = await another.dispatch({ operation: 'plan', projectKey, sceneId })
  another.swapSession()
  const response = await (another.transport as unknown as { dispatch(request: Record<string, unknown>): Promise<Record<string, unknown>> }).dispatch({
    operation: 'propose', session: 'd'.repeat(64), projectKey, planId: newPlan.planId,
    json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' })
  assert.deepEqual(response, { ok: false, code: 'INVALID_REQUEST' })
})

test('concurrent proposals cannot both claim one plan before its first await', async () => {
  const h = harness()
  const planned = await h.dispatch({ operation: 'plan', projectKey, sceneId })
  const request = { operation: 'propose', projectKey, planId: planned.planId,
    json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' }
  const [first, second] = await Promise.all([h.dispatch(request), h.dispatch(request)])
  assert.equal([first, second].filter((result) => result.ok).length, 1)
  assert.equal(h.previewed.length, 1)
})

test('concurrent plan queries cannot overwrite an unacknowledged delivery', async () => {
  const h = harness()
  const planned = await h.dispatch({ operation: 'plan', projectKey, sceneId })
  const request = { operation: 'query', projectKey, revision: 3, sceneId, kind: 'scenes', planId: planned.planId }
  const [first, second] = await Promise.all([h.dispatch(request), h.dispatch(request)])
  assert.equal([first, second].filter((result) => result.ok).length, 1)
  assert.equal([first, second].filter((result) => result.code === 'BUSY').length, 1)
})

test('bounded plan and proposal queues reject overflow without evicting live entries', async () => {
  const h = harness()
  const ids: string[] = []
  for (let i = 0; i < 8; i++) {
    const result = await h.dispatch({ operation: 'plan', projectKey, sceneId })
    assert.equal(result.ok, true)
    ids.push(result.planId as string)
  }
  assert.deepEqual(await h.dispatch({ operation: 'plan', projectKey, sceneId }), { ok: false, code: 'BUSY' })
  for (const planId of ids) {
    const result = await h.dispatch({ operation: 'propose', projectKey, planId,
      json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' })
    assert.equal(result.ok, true)
  }
  const next = await h.dispatch({ operation: 'plan', projectKey, sceneId })
  assert.equal(next.ok, true)
  assert.deepEqual(await h.dispatch({ operation: 'propose', projectKey, planId: next.planId,
    json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' }), { ok: false, code: 'BUSY' })
  assert.equal(h.previewed.length, 8)
})

test('real Main repository compiles a complete create-scene review without mutating the project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-cli-plan-repository-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => root })
  const created = await repository.create({ name: 'CLI plan source', initialSceneName: 'Start' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const { projectKey, snapshot } = created.value
  const trustedWindow = { id: 'real-repository-window', contents: {}, frame: {} }
  const transport = new WorldsCliTransport({ repository, runtimeDir: join(root, 'unused'),
    captureTrust: () => ({ window: trustedWindow, contents: trustedWindow.contents, frame: trustedWindow.frame,
      documentUrl: 'file:///trusted/index.html', documentEpoch: 0, workspaceRoot: root }) })
  Object.assign(transport, { session, sessionId: 'e'.repeat(32), sessionExpiresAt: Date.now() + 100_000 })
  const dispatch = (request: Record<string, unknown>) => (transport as unknown as {
    dispatch(request: Record<string, unknown>): Promise<Record<string, unknown>>
  }).dispatch({ session, ...request })
  const planned = await dispatch({ operation: 'plan', projectKey, sceneId: snapshot.project.startSceneId })
  assert.equal(planned.ok, true)
  const planId = planned.planId as string
  const queried = await dispatch({ operation: 'query', projectKey, revision: 0, kind: 'project', planId })
  assert.equal(queried.ok, true)
  assert.deepEqual(await dispatch({ operation: 'ack', projectKey, planId, deliveryId: queried.deliveryId }), { ok: true })
  const receipt = await dispatch({ operation: 'propose', projectKey, planId,
    json: '{"commands":[{"type":"create-scene","localRef":"next","name":"Next"}]}' })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.status, 'pending-human-review')
  const createdReview = await transport.getReview({ proposalId: receipt.proposalId as string })
  assert.ok(createdReview.ok)
  assert.deepEqual(await transport.reject({ proposalId: receipt.proposalId as string, reviewId: createdReview.reviewId }),
    { ok: true, status: 'rejected' })
  const environmentPlan = await dispatch({ operation: 'plan', projectKey, sceneId: snapshot.project.startSceneId })
  assert.equal(environmentPlan.ok, true)
  const environmentQuery = await dispatch({ operation: 'query', projectKey, revision: 0, kind: 'project', planId: environmentPlan.planId })
  assert.equal(environmentQuery.ok, true)
  assert.deepEqual(await dispatch({ operation: 'ack', projectKey, planId: environmentPlan.planId, deliveryId: environmentQuery.deliveryId }), { ok: true })
  const environmentReceipt = await dispatch({ operation: 'propose', projectKey, planId: environmentPlan.planId,
    json: '{"commands":[{"type":"set-active-scene-environment","environment":{"backgroundColor":"#123456","ambientIntensity":2}}]}' })
  assert.equal(environmentReceipt.ok, true, JSON.stringify(environmentReceipt))
  const groupsPlan = await dispatch({ operation: 'plan', projectKey, sceneId: snapshot.project.startSceneId })
  assert.equal(groupsPlan.ok, true)
  const groupsQuery = await dispatch({ operation: 'query', projectKey, revision: 0, kind: 'project', planId: groupsPlan.planId })
  assert.equal(groupsQuery.ok, true)
  assert.deepEqual(await dispatch({ operation: 'ack', projectKey, planId: groupsPlan.planId, deliveryId: groupsQuery.deliveryId }), { ok: true })
  const groupsReceipt = await dispatch({ operation: 'propose', projectKey, planId: groupsPlan.planId,
    json: '{"commands":[{"type":"create-entity","kind":"group","localRef":"one","sceneRef":{"kind":"existing","id":"' + snapshot.project.startSceneId + '"},"name":"One"},{"type":"create-entity","kind":"group","localRef":"two","sceneRef":{"kind":"existing","id":"' + snapshot.project.startSceneId + '"},"name":"Two"}]}' })
  assert.equal(groupsReceipt.ok, true, JSON.stringify(groupsReceipt))
  const groupsReview = await transport.getReview({ proposalId: groupsReceipt.proposalId as string })
  assert.ok(groupsReview.ok)
  assert.ok(groupsReview.review.changes.length >= 40)
  let displayed = ''
  assert.equal(await confirmWorldsCliApply({} as never, { async showMessageBox(_window, options) {
    displayed = options.detail; return { response: 0 }
  } }, groupsReview.review, { projectId: snapshot.project.projectId, sceneId: snapshot.project.startSceneId, revision: 0 }), false)
  for (const change of groupsReview.review.changes) {
    assert.ok(displayed.includes(change.field), change.field)
    if (change.before !== null) assert.ok(displayed.includes(change.before), change.field)
    if (change.after !== null) assert.ok(displayed.includes(change.after), change.field)
  }
  const opened = await repository.open({ projectKey })
  assert.equal(opened.ok, true)
  if (opened.ok && opened.value.status === 'ready') assert.deepEqual(opened.value.snapshot, snapshot)
  const applyReview = await transport.getReview({ proposalId: environmentReceipt.proposalId as string })
  assert.ok(applyReview.ok)
  const applied = await transport.apply({ proposalId: environmentReceipt.proposalId as string, reviewId: applyReview.reviewId }, async () => true)
  assert.ok(applied.ok, JSON.stringify(applied))
  assert.deepEqual(Object.keys(applied).sort(), ['baseRevision', 'beforeSnapshotSha256', 'newRevision', 'ok', 'projectId', 'snapshotSha256', 'transactionId'])
  assert.match(applied.beforeSnapshotSha256 as string, /^[a-f0-9]{64}$/)
  assert.equal(applied.baseRevision, 0)
  assert.equal(applied.newRevision, 1)
  const committed = await repository.open({ projectKey })
  assert.ok(committed.ok && committed.value.status === 'ready')
  assert.equal(committed.value.snapshot.project.revision, 1)
})

test('existing-entity edits require an actually delivered observation on the same plan', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-cli-observed-edit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => root })
  const created = await repository.create({ name: 'Observed edit', initialSceneName: 'Start' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const { projectKey, snapshot } = created.value
  const sceneId = snapshot.project.startSceneId
  const added = await repository.applyCommands({ projectKey, batch: {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:add-observed-light', projectId: snapshot.project.projectId,
    baseRevision: 0, origin: 'ui', commands: [{ type: 'add-entity', sceneId, entity: {
      id: 'entity:observed-light', name: 'Observed light', parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ id: 'component:observed-light', type: 'light', enabled: true, lightKind: 'point',
        color: '#ffffff', intensity: 2, range: 15, castShadow: false }],
    } }] } })
  assert.equal(added.ok, true)
  if (!added.ok) return
  const trustedWindow = { id: 'observed-edit-window', contents: {}, frame: {} }
  const transport = new WorldsCliTransport({ repository, runtimeDir: join(root, 'unused'),
    captureTrust: () => ({ window: trustedWindow, contents: trustedWindow.contents, frame: trustedWindow.frame,
      documentUrl: 'file:///trusted/index.html', documentEpoch: 0, workspaceRoot: root }) })
  Object.assign(transport, { session, sessionId: 'f'.repeat(32), sessionExpiresAt: Date.now() + 100_000 })
  const dispatch = (request: Record<string, unknown>) => (transport as unknown as {
    dispatch(request: Record<string, unknown>): Promise<Record<string, unknown>>
  }).dispatch({ session, ...request })
  const planned = await dispatch({ operation: 'plan', projectKey, sceneId })
  assert.equal(planned.ok, true)
  const planId = planned.planId as string
  const queried = await dispatch({ operation: 'query', projectKey, revision: 1, kind: 'entities', planId })
  assert.equal(queried.ok, true)
  const json = '{"commands":[{"type":"patch-entity","sceneId":"' + sceneId + '","entityId":"entity:observed-light","patch":{"name":"Renamed"}}]}'
  assert.deepEqual(await dispatch({ operation: 'propose', projectKey, planId, json }), { ok: false, code: 'INVALID_REQUEST' })
  const nextPlan = await dispatch({ operation: 'plan', projectKey, sceneId })
  assert.equal(nextPlan.ok, true)
  const observedPlanId = nextPlan.planId as string
  const observedQuery = await dispatch({ operation: 'query', projectKey, revision: 1, kind: 'entities', planId: observedPlanId })
  assert.equal(observedQuery.ok, true)
  assert.deepEqual(await dispatch({ operation: 'ack', projectKey, planId: observedPlanId, deliveryId: observedQuery.deliveryId }), { ok: true })
  const receipt = await dispatch({ operation: 'propose', projectKey, planId: observedPlanId, json })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  const opened = await repository.open({ projectKey })
  assert.equal(opened.ok, true)
  if (opened.ok && opened.value.status === 'ready') assert.deepEqual(opened.value.snapshot, added.value.snapshot)
})
