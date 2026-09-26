import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { WorldsCliTransport } from './worlds-cli-transport.ts'
import { canonicalWorldProjectSnapshotPayload } from '../../src/areas/worlds/core/worldSnapshotDigest.ts'

const proposalId = `proposal_${'a'.repeat(48)}`
const projectKey = `world-${'b'.repeat(32)}`

function fixture(workspaceRoot = '/tmp', canonicalWorkspace = '/tmp') {
  let now = 1000
  let revision = 4
  let epoch = 1
  let frame: object = {}
  let sessionId = 'session-one'
  let openGate: Promise<void> | null = null
  let discardGate: Promise<void> | null = null
  const discarded: unknown[] = []
  const applied: unknown[] = []
  const candidateSnapshot = { project: { projectId: 'project:one', revision: 5 }, scenes: [] }
  const candidateSnapshotSha256 = createHash('sha256').update(canonicalWorldProjectSnapshotPayload(candidateSnapshot)).digest('hex')
  let applyImplementation: ((request: { assertLive(): void; onJournalStart(): void }) => Promise<unknown>) | null = null
  const repository = {
    async list() { return { ok: true, value: { projects: [], issues: [] } } },
    async open() { if (openGate) await openGate; return { ok: true, value: { status: 'ready', snapshot: { project: { projectId: 'project:one', revision } } } } },
    async queryAi() { throw new Error('unused') },
    async discardAi(value: unknown) { discarded.push(value); if (discardGate) await discardGate; return { ok: true, value: { discarded: true } } },
    async applyReviewedCliAi(request: { assertLive(): void; onJournalStart(): void }) {
      applied.push(request)
      return applyImplementation ? await applyImplementation(request) : { ok: false, error: { code: 'invalid_request' } }
    },
  }
  let window: object = {}
  const contents = {}
  const captureTrust = () => ({ window, contents, frame, documentUrl: 'file:///app/index.html', documentEpoch: epoch, workspaceRoot })
  const transport = new WorldsCliTransport({ repository: repository as never, runtimeDir: '/tmp/unused-worlds-cli', now: () => now, captureTrust })
  Object.assign(transport, { session: 'c'.repeat(64), sessionId, sessionExpiresAt: now + 20_000 })
  const entry = {
    id: proposalId, planId: 'plan-one', context: { schema: 'modly.world-ai-context.v1', projectKey, projectId: 'project:one', baseRevision: 4,
      activeSceneId: 'scene:one', editorEpoch: 0, originSessionId: sessionId, requestId: 'request-one' },
    sessionId, generation: 0, trust: captureTrust(), canonicalWorkspace, expiresAt: now + 10_000,
    digest: 'd'.repeat(64), batch: { commands: [{ secret: '/private/batch' }] }, snapshot: { secret: '/private/snapshot' },
    review: { complete: true, changes: [{ field: 'scenes[0].name', before: '"Before"', after: '"After"' }], warnings: ['Check lighting'] },
    authority: 'private-authority', candidateSnapshotSha256, state: 'pending', revoked: false,
  }
  ;(transport as unknown as { proposals: Map<string, unknown> }).proposals.set(proposalId, entry)
  return { transport, discarded, applied, entry, candidateSnapshot, setApply: (implementation: typeof applyImplementation) => { applyImplementation = implementation },
    setRevision: (value: number) => { revision = value }, advance: (ms: number) => { now += ms },
    navigate: () => { epoch++ }, replaceFrame: () => { frame = {} }, destroyWindow: () => { window = {} },
    swapSession: () => { sessionId = 'session-two'; Object.assign(transport, { sessionId }) },
    holdOpen: (gate: Promise<void>) => { openGate = gate }, holdDiscard: (gate: Promise<void>) => { discardGate = gate } }
}

test('Apply reserves one nonce during native dialog; duplicate Apply/getReview/Reject cannot rotate or race it', async () => {
  const h = fixture()
  const review = await h.transport.getReview({ proposalId })
  assert.ok(review.ok)
  let release!: (value: boolean) => void
  const decision = new Promise<boolean>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const applying = h.transport.apply({ proposalId, reviewId: review.reviewId }, async () => { entered(); return decision })
  await started
  assert.deepEqual(await h.transport.apply({ proposalId, reviewId: review.reviewId }, async () => true), { ok: false, code: 'BUSY' })
  assert.deepEqual(await h.transport.getReview({ proposalId }), { ok: false, code: 'BUSY' })
  assert.deepEqual(await h.transport.reject({ proposalId, reviewId: review.reviewId }), { ok: false, code: 'BUSY' })
  release(false)
  assert.deepEqual(await applying, { ok: false, code: 'USER_DECLINED' })
  assert.equal(h.applied.length, 0)
  assert.equal(h.discarded.length, 1)
})

test('Apply rechecks navigation, frame, session, revision and expiry after dialog; none invokes repository', async () => {
  for (const invalidate of ['navigate', 'replaceFrame', 'destroyWindow', 'swapSession', 'revision', 'expiry', 'revoke'] as const) {
    const h = fixture()
    const review = await h.transport.getReview({ proposalId })
    assert.ok(review.ok)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const applying = h.transport.apply({ proposalId, reviewId: review.reviewId }, async () => { entered(); await gate; return true })
    await started
    if (invalidate === 'revision') h.setRevision(5)
    else if (invalidate === 'expiry') h.advance(11_000)
    else if (invalidate === 'revoke') await h.transport.revoke()
    else h[invalidate]()
    release()
    assert.deepEqual(await applying, { ok: false, code: 'STALE' }, invalidate)
    assert.equal(h.applied.length, 0, invalidate)
  }
})

test('revocation before journal blocks commit; after journal failures remain ambiguous without retry', async () => {
  const before = fixture()
  const first = await before.transport.getReview({ proposalId })
  assert.ok(first.ok)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  before.setApply(async (request) => { request.assertLive(); entered(); await gate; request.assertLive(); request.onJournalStart(); throw new Error('Unreachable') })
  const applying = before.transport.apply({ proposalId, reviewId: first.reviewId }, async () => true)
  await started
  await before.transport.revoke()
  release()
  assert.deepEqual(await applying, { ok: false, code: 'UNAVAILABLE' })
  assert.equal(before.applied.length, 1)

  const after = fixture()
  const second = await after.transport.getReview({ proposalId })
  assert.ok(second.ok)
  after.setApply(async (request) => { request.assertLive(); request.onJournalStart(); throw new Error('Injected post-journal failure') })
  assert.deepEqual(await after.transport.apply({ proposalId, reviewId: second.reviewId }, async () => true), { ok: false, code: 'AMBIGUOUS' })
  assert.equal(after.applied.length, 1)
  assert.deepEqual(await after.transport.apply({ proposalId, reviewId: second.reviewId }, async () => true), { ok: false, code: 'NOT_FOUND' })

  const revokedAfterStart = fixture()
  const third = await revokedAfterStart.transport.getReview({ proposalId })
  assert.ok(third.ok)
  revokedAfterStart.setApply(async (request) => { request.assertLive(); request.onJournalStart();
    await revokedAfterStart.transport.revoke(); return { ok: true, value: {} } })
  assert.deepEqual(await revokedAfterStart.transport.apply({ proposalId, reviewId: third.reviewId }, async () => true),
    { ok: false, code: 'AMBIGUOUS' })
  assert.equal(revokedAfterStart.applied.length, 1)
  assert.deepEqual(await revokedAfterStart.transport.apply({ proposalId, reviewId: third.reviewId }, async () => true),
    { ok: false, code: 'NOT_FOUND' })
})

test('Main intent cancellation during dialog or repository preparation is STALE before journal, AMBIGUOUS after it', async () => {
  const duringDialog = fixture()
  const review = await duringDialog.transport.getReview({ proposalId })
  assert.ok(review.ok)
  let live = true
  let releaseDialog!: () => void
  let dialogEntered!: () => void
  const dialogGate = new Promise<void>((resolve) => { releaseDialog = resolve })
  const dialogStarted = new Promise<void>((resolve) => { dialogEntered = resolve })
  const first = duringDialog.transport.apply({ proposalId, reviewId: review.reviewId }, async () => {
    dialogEntered(); await dialogGate; return true
  }, () => { if (!live) throw new Error('Intent cancelled') })
  await dialogStarted
  live = false
  releaseDialog()
  assert.deepEqual(await first, { ok: false, code: 'STALE' })
  assert.equal(duringDialog.applied.length, 0)

  const beforeJournal = fixture()
  const beforeReview = await beforeJournal.transport.getReview({ proposalId })
  assert.ok(beforeReview.ok)
  let preLive = true; let preBoundary = 0
  let releasePreparation!: () => void
  let preparationEntered!: () => void
  const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve })
  const preparationStarted = new Promise<void>((resolve) => { preparationEntered = resolve })
  beforeJournal.setApply(async (request) => {
    request.assertLive(); preparationEntered(); await preparationGate
    request.assertLive(); request.onJournalStart(); preBoundary++
    return { ok: false }
  })
  const second = beforeJournal.transport.apply({ proposalId, reviewId: beforeReview.reviewId }, async () => true,
    () => { if (!preLive) throw new Error('Intent cancelled') })
  await preparationStarted
  preLive = false
  releasePreparation()
  assert.deepEqual(await second, { ok: false, code: 'STALE' })
  assert.equal(preBoundary, 0)

  const afterJournal = fixture()
  const afterReview = await afterJournal.transport.getReview({ proposalId })
  assert.ok(afterReview.ok)
  let postLive = true; let postBoundary = 0
  afterJournal.setApply(async (request) => {
    request.assertLive(); request.onJournalStart(); postBoundary++
    postLive = false
    return { ok: false }
  })
  assert.deepEqual(await afterJournal.transport.apply({ proposalId, reviewId: afterReview.reviewId }, async () => true,
    () => { if (!postLive) throw new Error('Intent cancelled') }), { ok: false, code: 'AMBIGUOUS' })
  assert.equal(postBoundary, 1)
  assert.deepEqual(await afterJournal.transport.apply({ proposalId, reviewId: afterReview.reviewId }, async () => true),
    { ok: false, code: 'NOT_FOUND' })
})

test('successful reviewed Apply returns only exact path-free transaction/project/revision/snapshot digest', async () => {
  const h = fixture()
  const review = await h.transport.getReview({ proposalId })
  assert.ok(review.ok)
  h.setApply(async (request) => { request.assertLive(); request.onJournalStart(); return { ok: true, value: {
    projectKey, snapshot: h.candidateSnapshot, newRevision: 5, receipt: { transactionId: 'tx:one', resultSha256: 'f'.repeat(64) },
  } } })
  ;(h.entry.batch as { transactionId?: string }).transactionId = 'tx:one'
  const result = await h.transport.apply({ proposalId, reviewId: review.reviewId }, async () => true)
  assert.deepEqual(result, { ok: true, transactionId: 'tx:one', projectId: 'project:one', baseRevision: 4, newRevision: 5,
    beforeSnapshotSha256: createHash('sha256').update(canonicalWorldProjectSnapshotPayload(h.entry.snapshot)).digest('hex'),
    snapshotSha256: h.entry.candidateSnapshotSha256 })
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(h.applied.length, 1)
})

test('trusted pending listing and complete review expose only bounded path-free projection and nonce', async () => {
  const h = fixture()
  const list = await h.transport.listPending()
  assert.equal(list.ok, true)
  assert.equal(list.proposals.length, 1)
  const review = await h.transport.getReview({ proposalId })
  assert.ok(review.ok)
  assert.equal(review.review.complete, true)
  assert.deepEqual(review.review.changes, h.entry.review.changes)
  assert.deepEqual(review.review.warnings, h.entry.review.warnings)
  assert.match(review.reviewId, /^review_[a-f0-9]{48}$/)
  for (const value of [list, review]) {
    const text = JSON.stringify(value)
    for (const secret of ['/private/', 'private-authority', 'snapshot', 'batch', 'workspaceRoot', 'documentPath']) assert.equal(text.includes(secret), false, secret)
  }
})

test('oversize complete semantic review is rejected rather than truncated for native approval', async () => {
  const h = fixture()
  h.entry.review.changes = Array.from({ length: 49 }, (_, index) => ({ field: `field-${index}`, before: 'before', after: 'after' }))
  assert.deepEqual(await h.transport.getReview({ proposalId }), { ok: false, code: 'STALE' })
  assert.equal(h.discarded.length, 1)
  assert.equal(h.applied.length, 0)
})

test('review nonce is invalid across same-URL navigation, frame replacement, session swap and expiry', async () => {
  for (const invalidate of ['navigate', 'replaceFrame', 'swapSession', 'expire'] as const) {
    const h = fixture()
    const review = await h.transport.getReview({ proposalId })
    assert.ok(review.ok)
    if (invalidate === 'expire') h.advance(11_000)
    else h[invalidate]()
    const result = await h.transport.reject({ proposalId, reviewId: review.reviewId })
    assert.deepEqual(result, { ok: false, code: 'STALE' }, invalidate)
    assert.equal(h.discarded.length, 1, invalidate)
  }
})

test('reject is one-entry idempotent, revision-stale aware and never applies commands', async () => {
  const h = fixture()
  const review = await h.transport.getReview({ proposalId })
  assert.ok(review.ok)
  assert.deepEqual(await h.transport.reject({ proposalId, reviewId: 'review_' + 'f'.repeat(48) }), { ok: false, code: 'STALE' })
  assert.deepEqual(await h.transport.reject({ proposalId, reviewId: review.reviewId }), { ok: true, status: 'rejected' })
  assert.deepEqual(await h.transport.reject({ proposalId, reviewId: review.reviewId }), { ok: true, status: 'absent' })
  assert.equal(h.discarded.length, 1)
  const stale = fixture()
  stale.setRevision(5)
  assert.deepEqual(await stale.transport.getReview({ proposalId }), { ok: false, code: 'STALE' })
  assert.equal(stale.discarded.length, 1)
})

test('a newly issued review invalidates the old nonce; concurrent reject discards once', async () => {
  const h = fixture()
  const first = await h.transport.getReview({ proposalId })
  const second = await h.transport.getReview({ proposalId })
  assert.ok(first.ok && second.ok)
  assert.notEqual(first.reviewId, second.reviewId)
  assert.deepEqual(await h.transport.reject({ proposalId, reviewId: first.reviewId }), { ok: false, code: 'STALE' })
  let release!: () => void
  h.holdOpen(new Promise<void>((resolve) => { release = resolve }))
  const a = h.transport.reject({ proposalId, reviewId: second.reviewId })
  const b = h.transport.reject({ proposalId, reviewId: second.reviewId })
  release()
  const results = await Promise.all([a, b])
  assert.equal(results.filter((result) => result.ok && result.status === 'rejected').length, 1)
  assert.equal(h.discarded.length, 1)
})

test('reject does not report success before authority discard settles', async () => {
  const h = fixture()
  const review = await h.transport.getReview({ proposalId })
  assert.ok(review.ok)
  let release!: () => void
  h.holdDiscard(new Promise<void>((resolve) => { release = resolve }))
  let settled = false
  const rejecting = h.transport.reject({ proposalId, reviewId: review.reviewId }).then((result) => { settled = true; return result })
  for (let i = 0; i < 20 && !h.discarded.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.discarded.length, 1)
  assert.equal(settled, false)
  release()
  assert.deepEqual(await rejecting, { ok: true, status: 'rejected' })
})

test('workspace symlink retarget makes the existing review stale before reject', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-review-swap-'))
  try {
    await mkdir(join(root, 'before'))
    await mkdir(join(root, 'after'))
    const link = join(root, 'workspace')
    await symlink(join(root, 'before'), link)
    const h = fixture(link, await realpath(link))
    const review = await h.transport.getReview({ proposalId })
    assert.ok(review.ok)
    await unlink(link)
    await symlink(join(root, 'after'), link)
    assert.deepEqual(await h.transport.reject({ proposalId, reviewId: review.reviewId }), { ok: false, code: 'STALE' })
    assert.equal(h.discarded.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace symlink retarget during Apply dialog cannot reach repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-apply-root-swap-'))
  try {
    await mkdir(join(root, 'before')); await mkdir(join(root, 'after'))
    const link = join(root, 'workspace')
    await symlink(join(root, 'before'), link)
    const h = fixture(link, await realpath(link))
    const review = await h.transport.getReview({ proposalId })
    assert.ok(review.ok)
    let release!: () => void; let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const applying = h.transport.apply({ proposalId, reviewId: review.reviewId }, async () => { entered(); await gate; return true })
    await started
    await unlink(link); await symlink(join(root, 'after'), link)
    release()
    assert.deepEqual(await applying, { ok: false, code: 'STALE' })
    assert.equal(h.applied.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace symlink retarget while repository awaits is rejected before journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-apply-commit-root-swap-'))
  try {
    await mkdir(join(root, 'before')); await mkdir(join(root, 'after'))
    const link = join(root, 'workspace')
    await symlink(join(root, 'before'), link)
    const h = fixture(link, await realpath(link))
    const review = await h.transport.getReview({ proposalId })
    assert.ok(review.ok)
    let release!: () => void; let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    h.setApply(async (request) => { request.assertLive(); entered(); await gate; request.assertLive(); request.onJournalStart();
      throw new Error('Unreachable') })
    const applying = h.transport.apply({ proposalId, reviewId: review.reviewId }, async () => true)
    await started
    await unlink(link); await symlink(join(root, 'after'), link)
    release()
    assert.deepEqual(await applying, { ok: false, code: 'UNAVAILABLE' })
    assert.equal(h.applied.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
