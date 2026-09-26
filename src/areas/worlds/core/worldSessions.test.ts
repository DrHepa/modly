import assert from 'node:assert/strict'
import test from 'node:test'

import {
  adoptWorldEditorAuthoritativeSnapshot,
  applyWorldEditorCommandBatch,
  createWorldEditorSession,
  previewWorldCommandBatch,
  redoWorldEditorSession,
  startWorldPlaySession,
  transitionWorldPlaySession,
  undoWorldEditorSession,
} from './worldSessions.ts'
import { canonicalWorldCommandBatchPayload, fingerprintWorldCommandBatch } from './worldCommands.ts'
import { validateWorldProjectSnapshot } from './worldDocuments.ts'
import { createValidWorldSnapshot } from './_testFixtures.ts'

function renameBatch(transactionId: string, name: string, baseRevision = 4) {
  return { schema: 'modly.world-command-batch.v1' as const, transactionId, projectId: 'project:demo', baseRevision, origin: 'ui' as const, commands: [{ type: 'rename-project' as const, name }] }
}

test('preview is non-mutating and apply records a canonical transaction receipt', () => {
  const created = createWorldEditorSession(createValidWorldSnapshot())
  assert.equal(created.success, true)
  if (created.success !== true) return
  const preview = previewWorldCommandBatch(created.session, renameBatch('tx:preview', 'Previewed'))
  assert.equal(preview.success, true)
  assert.equal(created.session.snapshot.project.name, 'Demo world')
  const applied = applyWorldEditorCommandBatch(created.session, renameBatch('tx:one', 'Applied'))
  assert.equal(applied.success, true)
  if (applied.success !== true) return
  assert.equal(applied.session.snapshot.project.name, 'Applied')
  assert.equal(applied.session.receipts[0].transactionId, 'tx:one')
  assert.match(applied.session.receipts[0].fingerprint, /^fnv1a32:/)
})

test('owned apply shares prior immutable history entries and receipts without aliasing returned receipts', () => {
  const created = createWorldEditorSession(createValidWorldSnapshot())
  assert.equal(created.success, true)
  if (created.success !== true) return
  const first = applyWorldEditorCommandBatch(created.session, renameBatch('tx:share-one', 'One'))
  assert.equal(first.success, true)
  if (first.success !== true) return
  const second = applyWorldEditorCommandBatch(first.session, renameBatch('tx:share-two', 'Two', 5))
  assert.equal(second.success, true)
  if (second.success !== true) return

  assert.equal(second.session.undoStack[0], first.session.undoStack[0])
  assert.equal(second.session.undoStack[0].before, first.session.undoStack[0].before)
  assert.equal(second.session.undoStack[0].after, first.session.undoStack[0].after)
  assert.equal(second.session.receipts[0], first.session.receipts[0])
  assert.notEqual(second.receipt, second.session.receipts[1])

  second.receipt.transactionId = 'tx:mutated-returned'
  second.receipt.canonicalPayload = canonicalWorldCommandBatchPayload(renameBatch('tx:share-two', 'Mutated', 5))
  assert.equal(second.session.receipts[1].transactionId, 'tx:share-two')
  assert.equal(applyWorldEditorCommandBatch(second.session, renameBatch('tx:share-two', 'Two', 5)).success, true)
  const changedPayload = applyWorldEditorCommandBatch(second.session, renameBatch('tx:share-two', 'Different', 6))
  assert.equal(changedPayload.success, false)
  if (changedPayload.success === false) assert.equal(changedPayload.issues[0].code, 'transaction-reuse')
})

test('same transaction and payload retries idempotently before revision conflict', () => {
  const created = createWorldEditorSession(createValidWorldSnapshot())
  assert.equal(created.success, true)
  if (created.success !== true) return
  const batch = renameBatch('tx:idempotent', 'Once')
  const first = applyWorldEditorCommandBatch(created.session, batch)
  assert.equal(first.success, true)
  if (first.success !== true) return
  const retried = applyWorldEditorCommandBatch(first.session, batch)
  assert.equal(retried.success, true)
  if (retried.success !== true) return
  assert.equal(retried.idempotent, true)
  assert.equal(retried.session.snapshot.project.revision, 5)
  assert.equal(applyWorldEditorCommandBatch(first.session, renameBatch('tx:idempotent', 'Different')).success, false)
})

test('transaction reuse compares canonical payload bytes even when display digests collide', () => {
  const created = createWorldEditorSession(createValidWorldSnapshot())
  assert.equal(created.success, true)
  if (created.success !== true) return
  const firstBatch = renameBatch('tx:fnv-collision', 'Nzwwyh4-mkg')
  const collidingBatch = renameBatch('tx:fnv-collision', 'N1x5xy2d-t18')
  assert.equal(fingerprintWorldCommandBatch(firstBatch), fingerprintWorldCommandBatch(collidingBatch))

  const first = applyWorldEditorCommandBatch(created.session, firstBatch)
  assert.equal(first.success, true)
  if (first.success !== true) return
  const reused = applyWorldEditorCommandBatch(first.session, collidingBatch)
  assert.equal(reused.success, false)
  if (reused.success === false) assert.equal(reused.issues[0].code, 'transaction-reuse')
})

test('returned receipts cannot alias or rewrite the stored transaction identity', () => {
  const created = createWorldEditorSession(createValidWorldSnapshot())
  assert.equal(created.success, true)
  if (created.success !== true) return
  const first = applyWorldEditorCommandBatch(created.session, renameBatch('tx:receipt-alias', 'First'))
  assert.equal(first.success, true)
  if (first.success !== true) return

  assert.notEqual(first.receipt, first.session.receipts[0])
  assert.equal(Object.isFrozen(first.session), true)
  assert.equal(Object.isFrozen(first.session.snapshot), true)
  assert.equal(Object.isFrozen(first.session.undoStack[0].before), true)
  assert.equal(Reflect.set(first.session, 'receipts', []), false)
  assert.equal(Reflect.set(first.session.snapshot.project, 'name', 'Mutated session'), false)
  assert.equal(Reflect.set(first.session.undoStack[0].before.project, 'name', 'Mutated history'), false)
  const different = renameBatch('tx:receipt-alias', 'Different')
  first.receipt.canonicalPayload = canonicalWorldCommandBatchPayload(different)
  first.receipt.fingerprint = fingerprintWorldCommandBatch(different)
  first.receipt.transactionId = 'tx:mutated-return-value'

  assert.equal(first.session.receipts[0].transactionId, 'tx:receipt-alias')
  const reused = applyWorldEditorCommandBatch(first.session, different)
  assert.equal(reused.success, false)
  if (reused.success === false) assert.equal(reused.issues[0].code, 'transaction-reuse')
})

test('undo and redo restore content while revisions remain monotonic', () => {
  const created = createWorldEditorSession(createValidWorldSnapshot())
  assert.equal(created.success, true)
  if (created.success !== true) return
  const edited = applyWorldEditorCommandBatch(created.session, renameBatch('tx:edit', 'Edited'))
  assert.equal(edited.success, true)
  if (edited.success !== true) return
  const undone = undoWorldEditorSession(edited.session)
  assert.equal(undone.success, true)
  if (undone.success !== true) return
  assert.equal(undone.session.snapshot.project.name, 'Demo world')
  assert.equal(undone.session.snapshot.project.revision, 6)
  assert.equal(undone.session.redoStack[0], edited.session.undoStack[0])
  assert.notEqual(undone.session.snapshot, edited.session.undoStack[0].before)
  const redone = redoWorldEditorSession(undone.session)
  assert.equal(redone.success, true)
  if (redone.success !== true) return
  assert.equal(redone.session.snapshot.project.name, 'Edited')
  assert.equal(redone.session.snapshot.project.revision, 7)
  assert.equal(redone.session.undoStack[0], undone.session.redoStack[0])
  const newEdit = applyWorldEditorCommandBatch(undone.session, renameBatch('tx:new', 'New branch', 6))
  assert.equal(newEdit.success, true)
  if (newEdit.success === true) assert.equal(newEdit.session.redoStack.length, 0)
})

test('unowned forged receipts cannot make a never-applied transaction idempotent', () => {
  const base = createValidWorldSnapshot()
  const batch = renameBatch('tx:forged-idempotent', 'Should apply')
  const forged = Object.freeze({
    snapshot: base,
    undoStack: Object.freeze([]),
    redoStack: Object.freeze([]),
    receipts: Object.freeze([Object.freeze({
      transactionId: batch.transactionId,
      fingerprint: 'fnv1a32:00000000',
      canonicalPayload: canonicalWorldCommandBatchPayload(batch),
      appliedRevision: 5,
    })]),
  })

  const result = applyWorldEditorCommandBatch(forged as unknown as Parameters<typeof applyWorldEditorCommandBatch>[0], batch)

  assert.equal(result.success, false, 'forged unowned receipt must not bypass command application')
  if (result.success === false) assert.equal(result.issues[0].code, 'invalid-session')
})

test('unowned sessions with nonempty forged history fail closed instead of laundering authority', () => {
  const base = createValidWorldSnapshot()
  const before = structuredClone(base)
  const after = structuredClone(base)
  after.project.name = 'Forged prior'
  after.project.revision = 5
  const forgedEntry = Object.freeze({ transactionId: 'tx:forged', before, after })
  const forgedReceipt = Object.freeze({
    transactionId: 'tx:forged',
    fingerprint: 'fnv1a32:00000000',
    canonicalPayload: canonicalWorldCommandBatchPayload(renameBatch('tx:forged', 'Forged prior')),
    appliedRevision: 5,
  })
  const forged = Object.freeze({
    snapshot: after,
    undoStack: Object.freeze([forgedEntry]),
    redoStack: Object.freeze([]),
    receipts: Object.freeze([forgedReceipt]),
  })

  const applied = applyWorldEditorCommandBatch(forged as unknown as Parameters<typeof applyWorldEditorCommandBatch>[0], renameBatch('tx:after-forged', 'After forged', 5))
  assert.equal(applied.success, false)
  if (applied.success === false) assert.equal(applied.issues[0].code, 'invalid-session')
})

test('shallow-frozen empty unowned sessions clone and detach nested snapshot aliases', () => {
  const input = createValidWorldSnapshot()
  const forged = Object.freeze({
    snapshot: input,
    undoStack: Object.freeze([]),
    redoStack: Object.freeze([]),
    receipts: Object.freeze([]),
  })

  const applied = applyWorldEditorCommandBatch(forged as unknown as Parameters<typeof applyWorldEditorCommandBatch>[0], renameBatch('tx:empty-forged', 'After empty forged'))
  assert.equal(applied.success, true)
  if (applied.success !== true) return
  assert.notEqual(applied.session.undoStack[0].before, input)
  input.project.name = 'Mutated empty forged'
  assert.equal(applied.session.undoStack[0].before.project.name, 'Demo world')
})

test('authoritative adoption rejects valid cross-project and wrong-revision snapshots', () => {
  const created = createWorldEditorSession(createValidWorldSnapshot())
  assert.equal(created.success, true)
  if (created.success !== true) return
  const edited = applyWorldEditorCommandBatch(created.session, renameBatch('tx:adopt-template', 'Template'))
  assert.equal(edited.success, true)
  if (edited.success !== true) return

  const otherProject = createSnapshotForProject('project:other')
  assert.equal(validateWorldProjectSnapshot(otherProject).success, true)
  const crossProject = adoptWorldEditorAuthoritativeSnapshot(edited.session, otherProject)
  assert.equal(crossProject.success, false)
  if (crossProject.success === false) assert.equal(crossProject.issues[0].code, 'project-mismatch')

  const wrongRevision = structuredClone(edited.session.snapshot)
  wrongRevision.project.revision += 1
  assert.equal(validateWorldProjectSnapshot(wrongRevision).success, true)
  const adoptedWrongRevision = adoptWorldEditorAuthoritativeSnapshot(edited.session, wrongRevision)
  assert.equal(adoptedWrongRevision.success, false)
  if (adoptedWrongRevision.success === false) assert.equal(adoptedWrongRevision.issues[0].code, 'revision-mismatch')
})

test('owned history reuse does not re-traverse old owned history graphs', () => {
  const created = createWorldEditorSession(createValidWorldSnapshot())
  assert.equal(created.success, true)
  if (created.success !== true) return
  const first = applyWorldEditorCommandBatch(created.session, renameBatch('tx:traverse-one', 'One'))
  assert.equal(first.success, true)
  if (first.success !== true) return

  const oldIdentities = new WeakSet<object>([
    first.session.undoStack[0],
    first.session.undoStack[0].before,
    first.session.receipts[0],
  ])
  const original = Object.getOwnPropertyDescriptors
  let traversedOldOwned = 0
  Object.getOwnPropertyDescriptors = function getOwnPropertyDescriptorsSpy<T>(value: T): { [P in keyof T]: TypedPropertyDescriptor<T[P]> } & { [property: string]: PropertyDescriptor } {
    if (typeof value === 'object' && value !== null && oldIdentities.has(value)) traversedOldOwned += 1
    return original(value)
  }
  try {
    const second = applyWorldEditorCommandBatch(first.session, renameBatch('tx:traverse-two', 'Two', 5))
    assert.equal(second.success, true)
    assert.equal(traversedOldOwned, 0, 'apply must not traverse old owned history graph')
    if (second.success !== true) return

    const adopted = adoptWorldEditorAuthoritativeSnapshot(second.session, second.session.snapshot)
    assert.equal(adopted.success, true)
    assert.equal(traversedOldOwned, 0, 'adoption must not traverse old owned history graph')
    if (adopted.success !== true) return

    const undone = undoWorldEditorSession(adopted.session)
    assert.equal(undone.success, true)
    assert.equal(traversedOldOwned, 0, 'undo must not traverse old owned history graph')
    if (undone.success !== true) return

    const redone = redoWorldEditorSession(undone.session)
    assert.equal(redone.success, true)
    assert.equal(traversedOldOwned, 0, 'redo must not traverse old owned history graph')
  } finally {
    Object.getOwnPropertyDescriptors = original
  }
})

test('unowned session and snapshot wire rejection does not execute accessors', () => {
  let sessionGetterExecuted = false
  const accessorSession = Object.create(null)
  Object.defineProperty(accessorSession, 'snapshot', { enumerable: true, get() { sessionGetterExecuted = true; return createValidWorldSnapshot() } })
  Object.defineProperty(accessorSession, 'undoStack', { enumerable: true, value: [] })
  Object.defineProperty(accessorSession, 'redoStack', { enumerable: true, value: [] })
  Object.defineProperty(accessorSession, 'receipts', { enumerable: true, value: [] })
  assert.equal(applyWorldEditorCommandBatch(accessorSession, renameBatch('tx:accessor-session', 'Nope')).success, false)
  assert.equal(sessionGetterExecuted, false)

  let snapshotGetterExecuted = false
  const accessorSnapshot = createValidWorldSnapshot()
  Object.defineProperty(accessorSnapshot.project, 'name', { enumerable: true, get() { snapshotGetterExecuted = true; return 'Nope' } })
  assert.equal(createWorldEditorSession(accessorSnapshot).success, false)
  assert.equal(snapshotGetterExecuted, false)

  const prototypeSnapshot = createValidWorldSnapshot()
  Object.setPrototypeOf(prototypeSnapshot.project, { forged: true })
  assert.equal(createWorldEditorSession(prototypeSnapshot).success, false)

  const typedArraySnapshot = createValidWorldSnapshot()
  typedArraySnapshot.scenes = new Uint8Array([1]) as never
  assert.equal(createWorldEditorSession(typedArraySnapshot).success, false)
})

test('unowned nonempty authority arrays fail before constructing attacker-length index sets', () => {
  for (const field of ['undoStack', 'redoStack', 'receipts'] as const) {
    const nativeSet = globalThis.Set
    let numericAllowedIndexAdds = 0
    class CountingSet<T = unknown> extends nativeSet<T> {
      override add(value: T): this {
        if (typeof value === 'string' && /^\d+$/.test(value)) {
          numericAllowedIndexAdds += 1
          if (numericAllowedIndexAdds > 8) throw new Error(`sentinel: ${field} constructed allowed indices from attacker-controlled array length`)
        }
        return super.add(value)
      }
    }
    const hostile: unknown[] = []
    hostile.length = 16
    const forged = Object.freeze({
      snapshot: createValidWorldSnapshot(),
      undoStack: field === 'undoStack' ? hostile : Object.freeze([]),
      redoStack: field === 'redoStack' ? hostile : Object.freeze([]),
      receipts: field === 'receipts' ? hostile : Object.freeze([]),
    })

    try {
      globalThis.Set = CountingSet as typeof Set
      const result = applyWorldEditorCommandBatch(forged as unknown as Parameters<typeof applyWorldEditorCommandBatch>[0], renameBatch(`tx:${field}:fast-fail`, 'Should not matter'))
      assert.equal(result.success, false)
      assert.equal(numericAllowedIndexAdds, 0, `${field} should reject from own length descriptor before numeric index Set construction`)
    } finally {
      globalThis.Set = nativeSet
    }
  }
})

test('Play follows exact transitions and discards isolated runtime mutation on Stop', () => {
  const created = createWorldEditorSession(createValidWorldSnapshot())
  assert.equal(created.success, true)
  if (created.success !== true) return
  const started = startWorldPlaySession(created.session)
  assert.equal(started.state, 'loading')
  assert.equal(started.editor, created.session)
  assert.equal(Object.isFrozen(started), true)
  assert.equal(Reflect.set(started, 'editor', { ...created.session, snapshot: createValidWorldSnapshot() }), false)
  assert.equal(Reflect.set(started, 'sourceRevision', 999), false)
  assert.equal(started.editor, created.session)
  assert.equal(started.sourceRevision, 4)
  started.runtimeSnapshot.project.name = 'Runtime mutation'
  const playing = transitionWorldPlaySession(started, 'loaded')
  assert.equal(playing.success, true)
  if (playing.success !== true) return
  assert.equal(Object.isFrozen(playing.session), true)
  const paused = transitionWorldPlaySession(playing.session, 'pause')
  assert.equal(paused.success, true)
  if (paused.success !== true) return
  assert.equal(Object.isFrozen(paused.session), true)
  const resumed = transitionWorldPlaySession(paused.session, 'resume')
  assert.equal(resumed.success, true)
  if (resumed.success !== true) return
  assert.equal(Object.isFrozen(resumed.session), true)
  const stopping = transitionWorldPlaySession(resumed.session, 'stop')
  assert.equal(stopping.success, true)
  if (stopping.success !== true) return
  assert.equal(Object.isFrozen(stopping.session), true)
  const stopped = transitionWorldPlaySession(stopping.session, 'stopped')
  assert.equal(stopped.success, true)
  if (stopped.success !== true) return
  assert.equal(stopped.session.state, 'edit')
  assert.equal(Object.isFrozen(stopped.session), true)
  assert.equal(stopped.session.runtimeSnapshot, null)
  assert.equal(stopped.session.editor, created.session)
  assert.equal(stopped.session.editor.snapshot.project.name, 'Demo world')
  assert.equal(transitionWorldPlaySession(stopped.session, 'pause').success, false)
})

function createSnapshotForProject(projectId: string) {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.projectId = projectId
  for (const scene of snapshot.scenes) scene.projectId = projectId
  return snapshot
}
