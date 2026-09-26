import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retainWorldsCliPairing, WorldsCliStatusOrder, WorldsCliReviewRequestOrder, retainLiveWorldsCliReview, isCompleteCurrentWorldsCliReview, retainWorldsCliActionOutcome } from './worldsCliUiState.ts'
import type { WorldsCliStatus } from '../../../shared/types/worldProjects.ts'

const pairing = { code: 'private-code', expiresAt: 10, pairingId: 'first' }
const pending: WorldsCliStatus = { running: true, paired: false, expired: false, pairingPending: true, pairingId: 'first', sessionExpiresAt: null }

test('off, replaced, and consumed status clear a prior displayed challenge', () => {
  assert.equal(retainWorldsCliPairing(pairing, pending), pairing)
  assert.equal(retainWorldsCliPairing(pairing, { ...pending, running: false, pairingPending: false, pairingId: null }), null)
  assert.equal(retainWorldsCliPairing(pairing, { ...pending, pairingId: 'second' }), null)
  assert.equal(retainWorldsCliPairing(pairing, { ...pending, pairingPending: false, paired: true }), null)
})

test('late out-of-order polls cannot restore stale code or enabled status after a newer poll or local action', () => {
  const order = new WorldsCliStatusOrder()
  const old = order.beginPoll()
  const newer = order.beginPoll()
  assert.equal(order.accept(newer), true)
  assert.equal(order.accept(old), false)
  order.invalidate()
  assert.equal(order.accept(newer), false)
  const afterAction = order.beginPoll()
  assert.equal(order.accept(afterAction), true)
})

test('deferred review or reject cannot leave busy stuck or overwrite a newer generation after close or scene switch', async () => {
  for (const operation of ['getReview', 'reject'] as const) {
    for (const transition of ['drawer close', 'scene switch'] as const) {
      const order = new WorldsCliReviewRequestOrder()
      let busy = false
      let message = ''
      const setBusy = (value: boolean) => { busy = value }
      let resolveOld!: () => void
      const oldResponse = new Promise<void>((resolve) => { resolveOld = resolve })
      const oldTicket = order.begin(setBusy)
      assert.equal(busy, true, `${operation} ${transition}`)
      const oldCompletion = oldResponse.then(() => { if (order.isCurrent(oldTicket)) message = 'stale response' })
        .finally(() => order.finish(oldTicket, setBusy))
      order.invalidate(setBusy)
      assert.equal(busy, false, `${operation} ${transition} must clear busy immediately`)
      const newTicket = order.begin(setBusy)
      assert.equal(busy, true)
      resolveOld()
      await oldCompletion
      assert.equal(busy, true, 'old finalizer must not clear a new request')
      assert.equal(message, '', 'old response must not overwrite the new generation')
      order.finish(newTicket, setBusy)
      assert.equal(busy, false)
    }
  }
})

test('complete external review is retained only while matching pending ID, revision, digest and expiry remain live', () => {
  const review = { proposalId: 'proposal-one', revision: 4, digest: 'digest-one', expiresAt: 2000 }
  const pendingReview = { ...review, changeCount: 1 }
  assert.equal(retainLiveWorldsCliReview(review, [pendingReview], 1000), review)
  assert.equal(retainLiveWorldsCliReview(review, [], 1000), null)
  assert.equal(retainLiveWorldsCliReview(review, [{ ...pendingReview, revision: 5 }], 1000), null)
  assert.equal(retainLiveWorldsCliReview(review, [{ ...pendingReview, digest: 'digest-two' }], 1000), null)
  assert.equal(retainLiveWorldsCliReview(review, [pendingReview], 2000), null)
})

test('external Apply requires a complete current review and exact selected scope', () => {
  const scope = { projectKey: 'world-key', projectId: 'project:one', sceneId: 'scene:one', revision: 4 }
  const review = { ...scope, proposalId: 'proposal-one', reviewId: 'review-one', digest: 'digest-one', expiresAt: 2000,
    commandCount: 1, changeCount: 1, warningCount: 0,
    review: { complete: true as const, changes: [{ field: 'name', before: 'One', after: 'Two' }], warnings: [] } }
  assert.equal(isCompleteCurrentWorldsCliReview(review, [review], scope, 1000), true)
  assert.equal(isCompleteCurrentWorldsCliReview(review, [review], { ...scope, sceneId: 'scene:two' }, 1000), false)
  assert.equal(isCompleteCurrentWorldsCliReview(review, [{ ...review, digest: 'different' }], scope, 1000), false)
  assert.equal(isCompleteCurrentWorldsCliReview({ ...review, changeCount: 2 }, [review], scope, 1000), false)
  assert.equal(isCompleteCurrentWorldsCliReview(review, [review], scope, 2000), false)
})

test('transaction-scoped Apply/Undo success survives its revision advance until acknowledged or a later edit', () => {
  const outcome = { transactionId: 'tx:external', projectKey: 'world-key', projectId: 'project:one', sceneId: 'scene:one',
    baseRevision: 4, resultingRevision: 5, message: 'Applied and saved.' }
  const scope = { projectKey: 'world-key', projectId: 'project:one', sceneId: 'scene:one', revision: 4 }
  assert.equal(retainWorldsCliActionOutcome(outcome, scope), outcome)
  assert.equal(retainWorldsCliActionOutcome(outcome, { ...scope, revision: 5 }), outcome)
  assert.equal(retainWorldsCliActionOutcome(outcome, { ...scope, revision: 6 }), null)
  assert.equal(retainWorldsCliActionOutcome(outcome, { ...scope, sceneId: 'scene:two' }), null)
  assert.equal(retainWorldsCliActionOutcome(null, scope), null)
  const order = new WorldsCliReviewRequestOrder()
  let busy = false
  const ticket = order.begin((value) => { busy = value })
  assert.equal(retainWorldsCliActionOutcome(outcome, { ...scope, revision: 5 }) !== null, true)
  assert.equal(order.currentGeneration(), ticket.generation)
  assert.equal(order.isCurrent(ticket), true, 'expected revision advance must not retire the in-flight Apply/Undo completion')
  order.finish(ticket, (value) => { busy = value })
  assert.equal(busy, false)
  order.invalidate()
  assert.equal(order.isCurrent(ticket), false)
})
