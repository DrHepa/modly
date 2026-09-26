import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsPromises, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalWorldProjectSnapshotPayload } from '../../src/areas/worlds/core/worldSnapshotDigest.ts'
import { WorldProjectRepository } from './world-project-repository.ts'

const projectKey = `world-${'a'.repeat(32)}`
const digest = (snapshot: unknown) => createHash('sha256').update(canonicalWorldProjectSnapshotPayload(snapshot)).digest('hex')

test('canonical snapshot digest ignores object insertion order but not content', () => {
  assert.equal(digest({ project: { revision: 1, name: 'A' }, scenes: [] }), digest({ scenes: [], project: { name: 'A', revision: 1 } }))
  assert.notEqual(digest({ project: { revision: 1, name: 'A' }, scenes: [] }), digest({ project: { revision: 1, name: 'B' }, scenes: [] }))
})

test('scoped CLI Apply uses the same guarded authority path and returns the exact non-idempotent receipt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-cli-scoped-apply-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => root, createProjectKey: () => projectKey })
  const created = await repository.create({ name: 'Before', initialSceneName: 'Scene' })
  assert.ok(created.ok)
  const before = created.value.snapshot
  const context = { schema: 'modly.world-ai-context.v1' as const, projectKey, projectId: before.project.projectId,
    baseRevision: before.project.revision, activeSceneId: before.project.startSceneId, editorEpoch: 0,
    originSessionId: 'session-scoped', requestId: 'a'.repeat(32) }
  assert.ok((await repository.queryAi({ context, query: { kind: 'project' } })).ok)
  const preview = await repository.previewCliAi({ type: 'world_command_proposal', context, commands: [{ type: 'create-entity', kind: 'group',
    localRef: 'group', sceneRef: { kind: 'existing', id: context.activeSceneId }, name: 'Group' }] })
  assert.ok(preview.ok)
  let journal = 0
  const applied = await repository.applyScopedCliAi({ projectKey, batch: preview.value.batch,
    aiAuthority: { context, token: preview.value.authority }, beforeSnapshotSha256: digest(before),
    candidateSnapshotSha256: preview.value.candidateSnapshotSha256,
    assertLive: () => {}, onJournalStart: () => { journal++ } })
  assert.ok(applied.ok, applied.ok ? undefined : JSON.stringify(applied.error))
  assert.equal(journal, 1)
  assert.equal(applied.value.idempotent, false)
  assert.equal(applied.value.receipt.transactionId, preview.value.batch.transactionId)
  assert.equal(applied.value.receipt.appliedRevision, before.project.revision + 1)
  assert.equal(applied.value.newRevision, applied.value.receipt.appliedRevision)
  assert.equal(digest(applied.value.snapshot), preview.value.candidateSnapshotSha256)
  const replay = await repository.applyScopedCliAi({ projectKey, batch: preview.value.batch,
    aiAuthority: { context, token: preview.value.authority }, beforeSnapshotSha256: digest(before),
    candidateSnapshotSha256: preview.value.candidateSnapshotSha256, assertLive: () => {}, onJournalStart: () => {} })
  assert.equal(replay.ok, false)
})

test('scoped CLI synchronous tombstone at journal admission prevents publication', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-cli-scoped-tombstone-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => root, createProjectKey: () => projectKey })
  const created = await repository.create({ name: 'Before', initialSceneName: 'Scene' })
  assert.ok(created.ok)
  const before = created.value.snapshot
  const context = { schema: 'modly.world-ai-context.v1' as const, projectKey, projectId: before.project.projectId,
    baseRevision: before.project.revision, activeSceneId: before.project.startSceneId, editorEpoch: 0,
    originSessionId: 'session-scoped-tombstone', requestId: 'b'.repeat(32) }
  assert.ok((await repository.queryAi({ context, query: { kind: 'project' } })).ok)
  const preview = await repository.previewCliAi({ type: 'world_command_proposal', context, commands: [{ type: 'create-entity', kind: 'group',
    localRef: 'group', sceneRef: { kind: 'existing', id: context.activeSceneId }, name: 'Group' }] })
  assert.ok(preview.ok)
  let boundary = 0
  const result = await repository.applyScopedCliAi({ projectKey, batch: preview.value.batch,
    aiAuthority: { context, token: preview.value.authority }, beforeSnapshotSha256: digest(before),
    candidateSnapshotSha256: preview.value.candidateSnapshotSha256, assertLive: () => {},
    onJournalStart: () => { boundary++; throw new Error('Synchronous tombstone') } })
  assert.equal(result.ok, false)
  assert.equal(boundary, 1)
  const opened = await repository.open({ projectKey })
  assert.ok(opened.ok && opened.value.status === 'ready')
  assert.deepEqual(opened.value.snapshot, before)
  const modly = await readdir(join(root, 'Worlds', projectKey, '.modly'))
  assert.equal(modly.some((name) => name === 'journal.v1.json' || name.startsWith('.journal.v1.json.tmp-')), false)
})

test('Main reviewed Apply refuses same-revision pre-snapshot substitution and commits only the reviewed candidate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-cli-reviewed-apply-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => root, createProjectKey: () => projectKey })
  const created = await repository.create({ name: 'Before', initialSceneName: 'Scene' })
  assert.ok(created.ok)
  const before = created.value.snapshot
  const context = { schema: 'modly.world-ai-context.v1' as const, projectKey, projectId: before.project.projectId,
    baseRevision: before.project.revision, activeSceneId: before.project.startSceneId, editorEpoch: 0,
    originSessionId: 'session-reviewed', requestId: 'tx:reviewed' }
  const proposal = { type: 'world_command_proposal' as const, context, commands: [{ type: 'create-entity' as const,
    kind: 'group' as const, localRef: 'group', sceneRef: { kind: 'existing' as const, id: context.activeSceneId }, name: 'Group' }] }
  assert.ok((await repository.queryAi({ context, query: { kind: 'project' } })).ok)
  const stale = await repository.previewCliAi(proposal)
  assert.ok(stale.ok, stale.ok ? undefined : stale.error.code)
  const substituted = structuredClone(before)
  substituted.project.name = 'Same revision, different bytes'
  assert.equal(substituted.project.revision, before.project.revision)
  const denied = await repository.applyReviewedCliAi({ projectKey, batch: stale.value.batch,
    aiAuthority: { context, token: stale.value.authority }, beforeSnapshotSha256: digest(substituted),
    candidateSnapshotSha256: stale.value.candidateSnapshotSha256, assertLive: () => {}, onJournalStart: () => {} })
  assert.equal(denied.ok, false)
  const opened = await repository.open({ projectKey })
  assert.ok(opened.ok && opened.value.status === 'ready')
  assert.deepEqual(opened.value.snapshot, before)

  const wrongContext = { ...context, requestId: 'tx:wrong-candidate' }
  assert.ok((await repository.queryAi({ context: wrongContext, query: { kind: 'project' } })).ok)
  const wrong = await repository.previewCliAi({ ...proposal, context: wrongContext })
  assert.ok(wrong.ok)
  let wrongBoundary = 0
  const deniedCandidate = await repository.applyReviewedCliAi({ projectKey, batch: wrong.value.batch,
    aiAuthority: { context: wrongContext, token: wrong.value.authority }, beforeSnapshotSha256: digest(before),
    candidateSnapshotSha256: 'f'.repeat(64), assertLive: () => {}, onJournalStart: () => { wrongBoundary++ } })
  assert.equal(deniedCandidate.ok, false)
  assert.equal(wrongBoundary, 0)
  const afterDeniedCandidate = await repository.open({ projectKey })
  assert.ok(afterDeniedCandidate.ok && afterDeniedCandidate.value.status === 'ready')
  assert.deepEqual(afterDeniedCandidate.value.snapshot, before)

  const freshContext = { ...context, requestId: 'tx:fresh-reviewed' }
  assert.ok((await repository.queryAi({ context: freshContext, query: { kind: 'project' } })).ok)
  const fresh = await repository.previewCliAi({ ...proposal, context: freshContext })
  assert.ok(fresh.ok)
  let boundary = 0
  const applied = await repository.applyReviewedCliAi({ projectKey, batch: fresh.value.batch,
    aiAuthority: { context: { ...context, requestId: 'tx:fresh-reviewed' }, token: fresh.value.authority },
    beforeSnapshotSha256: digest(before), candidateSnapshotSha256: fresh.value.candidateSnapshotSha256,
    assertLive: () => {}, onJournalStart: () => { boundary++ } })
  assert.ok(applied.ok, applied.ok ? undefined : JSON.stringify(applied.error))
  assert.equal(boundary, 1)
  assert.equal(applied.value.newRevision, before.project.revision + 1)
  assert.equal(digest(applied.value.snapshot), fresh.value.candidateSnapshotSha256)
  assert.notEqual(applied.value.receipt.resultSha256, fresh.value.candidateSnapshotSha256)
})

test('same-revision disk substitution at the acquired root lock fails before journal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-cli-locked-substitution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let substitute = false
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => root, createProjectKey: () => projectKey,
    async failureCheckpoint(stage) {
      if (!substitute || stage !== 'root-lock-directory-created') return
      substitute = false
      const projectPath = join(root, 'Worlds', projectKey, 'project.world-project.json')
      const statePath = join(root, 'Worlds', projectKey, '.modly/state.v1.json')
      const project = JSON.parse(await readFile(projectPath, 'utf8'))
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      project.name = 'Substituted under lock'
      const bytes = `${JSON.stringify(project)}\n`
      state.project.sha256 = createHash('sha256').update(bytes).digest('hex')
      await writeFile(projectPath, bytes)
      await writeFile(statePath, `${JSON.stringify(state)}\n`)
    } })
  const created = await repository.create({ name: 'Original', initialSceneName: 'Scene' })
  assert.ok(created.ok)
  const before = created.value.snapshot
  const context = { schema: 'modly.world-ai-context.v1' as const, projectKey, projectId: before.project.projectId,
    baseRevision: 0, activeSceneId: before.project.startSceneId, editorEpoch: 0, originSessionId: 'session-substitution', requestId: 'tx:substitution' }
  assert.ok((await repository.queryAi({ context, query: { kind: 'project' } })).ok)
  const preview = await repository.previewCliAi({ type: 'world_command_proposal', context, commands: [{ type: 'create-entity', kind: 'group',
    localRef: 'group', sceneRef: { kind: 'existing', id: context.activeSceneId }, name: 'Group' }] })
  assert.ok(preview.ok)
  let journal = 0
  substitute = true
  const result = await repository.applyReviewedCliAi({ projectKey, batch: preview.value.batch,
    aiAuthority: { context, token: preview.value.authority }, beforeSnapshotSha256: digest(before),
    candidateSnapshotSha256: preview.value.candidateSnapshotSha256, assertLive: () => {}, onJournalStart: () => { journal++ } })
  assert.equal(result.ok, false)
  assert.equal(journal, 0)
  const opened = await repository.open({ projectKey })
  assert.ok(opened.ok && opened.value.status === 'ready')
  assert.equal(opened.value.snapshot.project.revision, before.project.revision)
  assert.equal(opened.value.snapshot.project.name, 'Substituted under lock')
})

test('reviewed Apply remains revocable through the synchronous before-journal boundary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-cli-before-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let armed = false; let release!: () => void; let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => root, createProjectKey: () => projectKey,
    async failureCheckpoint(stage) { if (armed && stage === 'backup-created') { entered(); await gate } } })
  const created = await repository.create({ name: 'Before', initialSceneName: 'Scene' })
  assert.ok(created.ok)
  const before = created.value.snapshot
  const context = { schema: 'modly.world-ai-context.v1' as const, projectKey, projectId: before.project.projectId,
    baseRevision: 0, activeSceneId: before.project.startSceneId, editorEpoch: 0, originSessionId: 'session-revoke', requestId: 'tx:revoke' }
  assert.ok((await repository.queryAi({ context, query: { kind: 'project' } })).ok)
  const preview = await repository.previewCliAi({ type: 'world_command_proposal', context, commands: [{ type: 'create-entity', kind: 'group',
    localRef: 'group', sceneRef: { kind: 'existing', id: context.activeSceneId }, name: 'Group' }] })
  assert.ok(preview.ok)
  let live = true; let journal = 0
  armed = true
  const pending = repository.applyReviewedCliAi({ projectKey, batch: preview.value.batch,
    aiAuthority: { context, token: preview.value.authority }, beforeSnapshotSha256: digest(before),
    candidateSnapshotSha256: preview.value.candidateSnapshotSha256,
    assertLive: () => { if (!live) throw new Error('Revoked') }, onJournalStart: () => { journal++ } })
  try {
    await started
    live = false
    assert.ok((await repository.discardAi({ context, authority: preview.value.authority })).ok)
    release()
    assert.equal((await pending).ok, false)
    assert.equal(journal, 0)
    const opened = await repository.open({ projectKey })
    assert.ok(opened.ok && opened.value.status === 'ready')
    assert.deepEqual(opened.value.snapshot, before)
  } finally { release() }
})

test('revocation during journal temporary-file sync cancels before publishing the journal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-cli-journal-temp-revoke-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => root, createProjectKey: () => projectKey })
  const created = await repository.create({ name: 'Before', initialSceneName: 'Scene' })
  assert.ok(created.ok)
  const before = created.value.snapshot
  const context = { schema: 'modly.world-ai-context.v1' as const, projectKey, projectId: before.project.projectId,
    baseRevision: 0, activeSceneId: before.project.startSceneId, editorEpoch: 0, originSessionId: 'session-temp-revoke', requestId: 'tx:temp-revoke' }
  assert.ok((await repository.queryAi({ context, query: { kind: 'project' } })).ok)
  const preview = await repository.previewCliAi({ type: 'world_command_proposal', context, commands: [{ type: 'create-entity', kind: 'group',
    localRef: 'group', sceneRef: { kind: 'existing', id: context.activeSceneId }, name: 'Group' }] })
  assert.ok(preview.ok)
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const originalOpen = fsPromises.open
  fsPromises.open = (async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode)
    if (flags !== 'wx' || !String(path).includes('.journal.v1.json.tmp-')) return handle
    return new Proxy(handle, { get(target, property) {
      if (property === 'sync') return async () => { entered(); await gate; return target.sync() }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as typeof handle
  }) as typeof fsPromises.open
  syncBuiltinESMExports()
  let live = true; let boundary = 0
  const applying = repository.applyReviewedCliAi({ projectKey, batch: preview.value.batch,
    aiAuthority: { context, token: preview.value.authority }, beforeSnapshotSha256: digest(before),
    candidateSnapshotSha256: preview.value.candidateSnapshotSha256,
    assertLive: () => { if (!live) throw new Error('Revoked during journal preparation') }, onJournalStart: () => { boundary++ } })
  try {
    await started
    assert.equal(boundary, 0, 'The irreversible latch must not precede temporary-file preparation')
    live = false
    assert.ok((await repository.discardAi({ context, authority: preview.value.authority })).ok)
    release()
    assert.equal((await applying).ok, false)
    assert.equal(boundary, 0)
    const opened = await repository.open({ projectKey })
    assert.ok(opened.ok && opened.value.status === 'ready')
    assert.deepEqual(opened.value.snapshot, before)
    const modly = await readdir(join(root, 'Worlds', projectKey, '.modly'))
    assert.equal(modly.some((name) => name === 'journal.v1.json' || name.startsWith('.journal.v1.json.tmp-')), false)
  } finally {
    release()
    fsPromises.open = originalOpen
    syncBuiltinESMExports()
  }
})

test('failure after journal is not represented as no-commit or retried by reviewed Apply', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-cli-after-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let armed = false; let faults = 0
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => root, createProjectKey: () => projectKey,
    failureCheckpoint(stage) { if (armed && stage === 'journal-published') { faults++; throw new Error('Injected post-journal failure') } } })
  const created = await repository.create({ name: 'Before', initialSceneName: 'Scene' })
  assert.ok(created.ok)
  const before = created.value.snapshot
  const context = { schema: 'modly.world-ai-context.v1' as const, projectKey, projectId: before.project.projectId,
    baseRevision: 0, activeSceneId: before.project.startSceneId, editorEpoch: 0, originSessionId: 'session-ambiguous', requestId: 'tx:ambiguous' }
  assert.ok((await repository.queryAi({ context, query: { kind: 'project' } })).ok)
  const preview = await repository.previewCliAi({ type: 'world_command_proposal', context, commands: [{ type: 'create-entity', kind: 'group',
    localRef: 'group', sceneRef: { kind: 'existing', id: context.activeSceneId }, name: 'Group' }] })
  assert.ok(preview.ok)
  let journal = 0
  armed = true
  const result = await repository.applyReviewedCliAi({ projectKey, batch: preview.value.batch,
    aiAuthority: { context, token: preview.value.authority }, beforeSnapshotSha256: digest(before),
    candidateSnapshotSha256: preview.value.candidateSnapshotSha256, assertLive: () => {}, onJournalStart: () => { journal++ } })
  assert.equal(result.ok, false)
  assert.equal(journal, 1)
  assert.equal(faults, 1)
  assert.ok((await readFile(join(root, 'Worlds', projectKey, '.modly/journal.v1.json'))).length > 0)
  const restarted = new WorldProjectRepository({ getWorkspaceRoot: () => root })
  const inspected = await restarted.open({ projectKey })
  assert.ok(inspected.ok && inspected.value.status === 'ready', JSON.stringify(inspected))
  assert.equal(inspected.value.snapshot.project.revision, 1, 'Restart can complete the durable journal after ambiguous reply')
  assert.equal(digest(inspected.value.snapshot), preview.value.candidateSnapshotSha256)
  const state = JSON.parse(await readFile(join(root, 'Worlds', projectKey, '.modly/state.v1.json'), 'utf8'))
  assert.equal(state.transactions.length, 1, 'Journal recovery does not replay the command as a second transaction')
  assert.equal(faults, 1)
})
