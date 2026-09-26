import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorldsCliDirectEditIntentLedger, type WorldsCliDirectEditProposal, type WorldsCliDirectEditScope } from './worlds-cli-direct-edit-intents.ts'

const proposalId = `proposal_${'a'.repeat(48)}`
const transactionId = '1'.repeat(32)
const digest = 'b'.repeat(64)
const beforeSnapshotSha256 = 'c'.repeat(64)
const candidateSnapshotSha256 = 'd'.repeat(64)

function fixture() {
  let now = 1000
  const window = {}, contents = {}, frame = {}
  let scope: WorldsCliDirectEditScope | null = {
    sessionId: 'a'.repeat(32), generation: 4, sessionExpiresAt: 60_000,
    window, contents, frame, documentUrl: 'app://modly/', documentEpoch: 2,
    workspaceRoot: '/workspace', canonicalWorkspace: '/workspace',
    projectKey: `world-${'a'.repeat(32)}`, projectId: 'project:one', sceneId: 'scene:one',
    editorEpoch: 7, revision: 3, mode: 'edit',
  }
  const ledger = new WorldsCliDirectEditIntentLedger({ now: () => now, currentScope: () => scope })
  const proposal = () => ({ proposalId, transactionId, digest, beforeSnapshotSha256, candidateSnapshotSha256,
    expiresAt: 30_000, scope: scope! })
  return { ledger, proposal, get scope(): WorldsCliDirectEditScope { return scope! }, set scope(next: WorldsCliDirectEditScope | null) { scope = next },
    set now(next: number) { now = next } }
}

test('one-use claim returns the exact Main-issued transaction ID and rejects replay', () => {
  const f = fixture()
  const input = f.proposal()
  const issued = f.ledger.issue(input)
  assert.equal(issued.ok, true)
  if (!issued.ok) return
  input.digest = '0'.repeat(64)
  assert.match(issued.intentId, /^edit_[a-f0-9]{48}$/)
  const claimed = f.ledger.claim(issued.intentId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) return
  assert.equal(claimed.claim.transactionId, transactionId)
  assert.equal(claimed.claim.proposal.transactionId, transactionId)
  assert.equal(claimed.claim.proposal.digest, digest)
  assert.equal(claimed.claim.proposal.proposalId, proposalId)
  assert.deepEqual(f.ledger.claim(issued.intentId), { ok: false, code: 'STALE' })
  assert.deepEqual(f.ledger.lookup(issued.intentId), { ok: false, code: 'BUSY' })
})

test('expiry, unrelated revision, scene, Play, and window changes fail before journal', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.now = 30_000 },
    (f: ReturnType<typeof fixture>) => { f.scope = { ...f.scope, revision: 4 } },
    (f: ReturnType<typeof fixture>) => { f.scope = { ...f.scope, sceneId: 'scene:other' } },
    (f: ReturnType<typeof fixture>) => { f.scope = { ...f.scope, mode: 'playing' } },
    (f: ReturnType<typeof fixture>) => { f.scope = { ...f.scope, window: {} } },
  ]) {
    const f = fixture()
    const issued = f.ledger.issue(f.proposal())
    assert.equal(issued.ok, true)
    if (!issued.ok) continue
    change(f)
    assert.deepEqual(f.ledger.claim(issued.intentId), { ok: false, code: 'STALE' })
  }
})

test('scope drift after claim gives STALE before journal and AMBIGUOUS after journal', () => {
  const before = fixture()
  const first = before.ledger.issue(before.proposal())
  assert.equal(first.ok, true)
  if (!first.ok) return
  const claimOne = before.ledger.claim(first.intentId)
  assert.equal(claimOne.ok, true)
  if (!claimOne.ok) return
  before.scope = { ...before.scope, revision: 4 }
  assert.deepEqual(claimOne.claim.beforeJournal(), { ok: false, code: 'STALE' })
  assert.deepEqual(before.ledger.lookup(first.intentId), { ok: true, status: 'STALE' })
  before.scope = { ...before.scope, revision: 3 }
  assert.deepEqual(before.ledger.lookup(first.intentId), { ok: true, status: 'STALE' })

  const after = fixture()
  const second = after.ledger.issue(after.proposal())
  assert.equal(second.ok, true)
  if (!second.ok) return
  const claimTwo = after.ledger.claim(second.intentId)
  assert.equal(claimTwo.ok, true)
  if (!claimTwo.ok) return
  assert.deepEqual(claimTwo.claim.beforeJournal(), { ok: true })
  after.scope = { ...after.scope, mode: 'playing' }
  assert.deepEqual(after.ledger.claim(second.intentId), { ok: false, code: 'AMBIGUOUS' })
  assert.deepEqual(claimTwo.claim.abort(), { ok: false, code: 'AMBIGUOUS' })
  after.scope = { ...after.scope, mode: 'edit' }
  assert.deepEqual(after.ledger.lookup(second.intentId), { ok: true, status: 'AMBIGUOUS' })
})

test('only an exact journaled receipt plus live editor adoption can settle APPLIED', () => {
  const f = fixture()
  const issued = f.ledger.issue(f.proposal())
  assert.equal(issued.ok, true)
  if (!issued.ok) return
  const claimed = f.ledger.claim(issued.intentId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) return
  const claim = claimed.claim
  const receipt = { transactionId: claim.transactionId, projectId: f.scope.projectId,
    newRevision: 4, snapshotSha256: candidateSnapshotSha256, editorAdopted: true }
  assert.deepEqual(claim.applied(receipt), { ok: false, code: 'STALE' }, 'no journal boundary, no success')
  // A failed premature success is terminal and cannot be retried.
  assert.deepEqual(f.ledger.claim(issued.intentId), { ok: false, code: 'STALE' })

  const f2 = fixture()
  const second = f2.ledger.issue(f2.proposal())
  assert.equal(second.ok, true)
  if (!second.ok) return
  const secondClaim = f2.ledger.claim(second.intentId)
  assert.equal(secondClaim.ok, true)
  if (!secondClaim.ok) return
  assert.deepEqual(secondClaim.claim.beforeJournal(), { ok: true })
  const exact = { ...receipt, transactionId: secondClaim.claim.transactionId }
  assert.deepEqual(secondClaim.claim.applied({ ...exact, editorAdopted: false }), { ok: false, code: 'AMBIGUOUS' })
  assert.deepEqual(f2.ledger.lookup(second.intentId), { ok: true, status: 'AMBIGUOUS' })

  const f3 = fixture()
  const third = f3.ledger.issue(f3.proposal())
  assert.equal(third.ok, true)
  if (!third.ok) return
  const thirdClaim = f3.ledger.claim(third.intentId)
  assert.equal(thirdClaim.ok, true)
  if (!thirdClaim.ok) return
  assert.deepEqual(thirdClaim.claim.beforeJournal(), { ok: true })
  f3.scope = { ...f3.scope, revision: 4 }
  assert.deepEqual(thirdClaim.claim.applied({ ...receipt, transactionId: thirdClaim.claim.transactionId }), { ok: true, status: 'APPLIED' })
  assert.deepEqual(f3.ledger.lookup(third.intentId), { ok: true, status: 'APPLIED' })
  assert.deepEqual(f3.ledger.claim(third.intentId), { ok: false, code: 'STALE' })
  assert.deepEqual(thirdClaim.claim.abort(), { ok: false, code: 'STALE' })
  assert.deepEqual(f3.ledger.lookup(third.intentId), { ok: true, status: 'APPLIED' })
})

test('budget, scoped terminal lookup, redaction, retention, and shutdown are fail-closed', () => {
  const f = fixture()
  const issued = f.ledger.issue(f.proposal())
  assert.equal(issued.ok, true)
  if (!issued.ok) return
  const claimed = f.ledger.claim(issued.intentId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) return
  assert.deepEqual(claimed.claim.abort(), { ok: false, code: 'STALE' })
  assert.deepEqual(f.ledger.lookup(issued.intentId), { ok: true, status: 'STALE' })
  assert.equal(JSON.stringify(f.ledger.lookup(issued.intentId)).includes(proposalId), false)
  assert.equal(JSON.stringify(f.ledger.lookup(issued.intentId)).includes(digest), false)
  f.scope = { ...f.scope, sessionId: 'b'.repeat(32) }
  assert.deepEqual(f.ledger.lookup(issued.intentId), { ok: false, code: 'NOT_FOUND' })
  f.scope = { ...f.scope, sessionId: 'a'.repeat(32) }
  f.now = 60_001
  assert.deepEqual(f.ledger.lookup(issued.intentId), { ok: false, code: 'NOT_FOUND' })
  f.ledger.shutdown()
  assert.deepEqual(f.ledger.issue(f.proposal()), { ok: false, code: 'UNAVAILABLE' })
  assert.deepEqual(f.ledger.lookup(issued.intentId), { ok: false, code: 'NOT_FOUND' })
})

test('per-session transaction budget is bounded and resets only on new generation', () => {
  const f = fixture()
  const duplicate = f.ledger.issue(f.proposal())
  assert.equal(duplicate.ok, true)
  assert.deepEqual(f.ledger.issue(f.proposal()), { ok: false, code: 'STALE' })
  if (duplicate.ok) {
    const claim = f.ledger.claim(duplicate.intentId)
    if (claim.ok) claim.claim.abort()
  }
  for (let i = 0; i < 7; i++) {
    const issued = f.ledger.issue({ ...f.proposal(), proposalId: `proposal_${i.toString(16).repeat(48)}`,
      transactionId: (i + 2).toString(16).repeat(32) })
    assert.equal(issued.ok, true)
    if (!issued.ok) return
    const claimed = f.ledger.claim(issued.intentId)
    assert.equal(claimed.ok, true)
    if (!claimed.ok) return
    assert.deepEqual(claimed.claim.abort(), { ok: false, code: 'STALE' })
  }
  assert.deepEqual(f.ledger.issue({ ...f.proposal(), proposalId: `proposal_${'f'.repeat(48)}`,
    transactionId: 'f'.repeat(32) }), { ok: false, code: 'BUSY' })
  f.scope = { ...f.scope, generation: 5, sessionId: 'c'.repeat(32) }
  assert.equal(f.ledger.issue({ ...f.proposal(), scope: f.scope }).ok, true)
})

test('expired journal or lost adoption remains AMBIGUOUS, not a false stale-before-write', () => {
  const f = fixture()
  const issued = f.ledger.issue(f.proposal())
  assert.equal(issued.ok, true)
  if (!issued.ok) return
  const claimed = f.ledger.claim(issued.intentId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) return
  assert.deepEqual(claimed.claim.beforeJournal(), { ok: true })
  f.now = 30_001
  assert.deepEqual(f.ledger.lookup(issued.intentId), { ok: true, status: 'AMBIGUOUS' })
  assert.deepEqual(f.ledger.claim(issued.intentId), { ok: false, code: 'AMBIGUOUS' })
  assert.deepEqual(f.ledger.lookup(issued.intentId), { ok: true, status: 'AMBIGUOUS' })
})

test('expired session never reveals even a previously journaled terminal status', () => {
  const f = fixture()
  const issued = f.ledger.issue(f.proposal())
  assert.equal(issued.ok, true)
  if (!issued.ok) return
  const claimed = f.ledger.claim(issued.intentId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) return
  assert.deepEqual(claimed.claim.beforeJournal(), { ok: true })
  f.now = 60_001
  assert.deepEqual(f.ledger.lookup(issued.intentId), { ok: false, code: 'NOT_FOUND' })
})

test('array proposal identifiers cannot bypass textual duplicate identity or retain mutable hashes', () => {
  const f = fixture()
  const malformed = (id: string[]) => ({ ...f.proposal(), proposalId: id,
    digest: [digest], beforeSnapshotSha256: [beforeSnapshotSha256],
    candidateSnapshotSha256: [candidateSnapshotSha256] }) as unknown as WorldsCliDirectEditProposal
  const firstId = [proposalId]
  assert.deepEqual(f.ledger.issue(malformed(firstId)), { ok: false, code: 'INVALID_REQUEST' })
  firstId[0] = `proposal_${'e'.repeat(48)}`
  assert.deepEqual(f.ledger.issue(malformed([proposalId])), { ok: false, code: 'INVALID_REQUEST' })
  const valid = f.ledger.issue(f.proposal())
  assert.equal(valid.ok, true, 'invalid array identities cannot consume or bypass the textual ID')
  assert.deepEqual(f.ledger.issue(f.proposal()), { ok: false, code: 'STALE' })
})

test('every proposal digest and hash must be a primitive string', () => {
  for (const key of ['proposalId', 'digest', 'beforeSnapshotSha256', 'candidateSnapshotSha256'] as const) {
    const f = fixture()
    const source = { ...f.proposal(), [key]: [f.proposal()[key]] } as unknown as WorldsCliDirectEditProposal
    assert.deepEqual(f.ledger.issue(source), { ok: false, code: 'INVALID_REQUEST' }, key)
  }
})

test('malformed transaction IDs fail without consuming the session budget', () => {
  const f = fixture()
  const invalid = [[transactionId], { value: transactionId }, transactionId.slice(1),
    `${transactionId}0`, 'A'.repeat(32), `tx:${transactionId}`, 'g'.repeat(32)]
  for (const [index, value] of invalid.entries()) {
    const source = { ...f.proposal(), proposalId: `proposal_${index.toString(16).repeat(48)}`,
      transactionId: value } as unknown as WorldsCliDirectEditProposal
    assert.deepEqual(f.ledger.issue(source), { ok: false, code: 'INVALID_REQUEST' })
  }
  for (let index = 0; index < 8; index += 1) {
    const issued = f.ledger.issue({ ...f.proposal(), proposalId: `proposal_${index.toString(16).repeat(48)}`,
      transactionId: (index + 1).toString(16).repeat(32) })
    assert.equal(issued.ok, true, `valid transaction ${index + 1} remains in budget`)
  }
  assert.deepEqual(f.ledger.issue({ ...f.proposal(), proposalId: `proposal_${'f'.repeat(48)}`,
    transactionId: 'f'.repeat(32) }), { ok: false, code: 'BUSY' })
})

test('different proposal IDs cannot reuse one transaction ID until generation reset', () => {
  const f = fixture()
  assert.equal(f.ledger.issue({ ...f.proposal(), expiresAt: 1500 }).ok, true)
  f.now = 1500
  assert.deepEqual(f.ledger.issue({ ...f.proposal(), proposalId: `proposal_${'e'.repeat(48)}` }),
    { ok: false, code: 'STALE' })
  f.scope = { ...f.scope, generation: 5, sessionId: 'c'.repeat(32) }
  assert.equal(f.ledger.issue({ ...f.proposal(), proposalId: `proposal_${'e'.repeat(48)}`, scope: f.scope }).ok, true)
})

test('malformed path and scope identifiers return INVALID_REQUEST without throwing', () => {
  for (const key of ['workspaceRoot', 'canonicalWorkspace', 'sessionId', 'documentUrl',
    'projectKey', 'projectId', 'sceneId'] as const) {
    for (const invalid of [undefined, [fixture().scope[key]]]) {
      const f = fixture()
      const scope = { ...f.scope, [key]: invalid } as unknown as WorldsCliDirectEditScope
      assert.deepEqual(f.ledger.issue({ ...f.proposal(), scope }), { ok: false, code: 'INVALID_REQUEST' }, key)
    }
  }
  for (const key of ['window', 'contents', 'frame'] as const) {
    const f = fixture()
    const scope = { ...f.scope, [key]: 'not-an-object' } as unknown as WorldsCliDirectEditScope
    assert.deepEqual(f.ledger.issue({ ...f.proposal(), scope }), { ok: false, code: 'INVALID_REQUEST' }, key)
  }
  const f = fixture()
  const source = { ...f.proposal(), get scope(): WorldsCliDirectEditScope { throw Error('untrusted getter') } }
  assert.deepEqual(f.ledger.issue(source), { ok: false, code: 'INVALID_REQUEST' })
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  assert.deepEqual(f.ledger.issue({ ...f.proposal(), scope: { ...f.scope, window: revoked.proxy } }),
    { ok: false, code: 'INVALID_REQUEST' })
})

test('issued primitive identity is copied and cannot be mutated through the source', () => {
  const f = fixture()
  const input = f.proposal()
  const issued = f.ledger.issue(input)
  assert.equal(issued.ok, true)
  if (!issued.ok) return
  input.proposalId = `proposal_${'f'.repeat(48)}`
  input.transactionId = '2'.repeat(32)
  input.digest = '0'.repeat(64)
  input.beforeSnapshotSha256 = '1'.repeat(64)
  input.candidateSnapshotSha256 = '2'.repeat(64)
  const claimed = f.ledger.claim(issued.intentId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) return
  assert.equal(claimed.claim.transactionId, transactionId)
  assert.deepEqual(claimed.claim.proposal,
    { proposalId, transactionId, digest, beforeSnapshotSha256, candidateSnapshotSha256 })
})

test('revision must leave room for one safe monotonic increment', () => {
  const f = fixture()
  f.scope = { ...f.scope, revision: Number.MAX_SAFE_INTEGER }
  assert.deepEqual(f.ledger.issue(f.proposal()), { ok: false, code: 'INVALID_REQUEST' })
})
