import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { applyWorldCommandBatch } from '../core/worldCommands.ts'
import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import { canonicalWorldProjectSnapshotPayload } from '../core/worldSnapshotDigest.ts'
import type { WorldProjectCommandRequest, WorldProjectDeleteRequest } from '../../../shared/types/worldProjects.ts'
import { createWorldEditorController } from './worldEditorController.ts'
import type { WorldProjectService } from '../worldProjectService.ts'
import { buildAddSceneCommands, createDeterministicWorldEditorIdentityGenerator } from './worldEditorCommandBuilders.ts'
import { buildAddAxis2dInputActionCommands, buildUpdateButtonInputActionCommands } from './worldAuthoringModel.ts'

const projectKey = `world-${'a'.repeat(32)}`

function directRequest(overrides: Partial<{
  nonce: string
  editIntent: string
  projectKey: string
  projectId: string
  sceneId: string
  baseRevision: number
  editorEpoch: number
  expiresAt: number
}> = {}) {
  return {
    nonce: 'a'.repeat(48),
    editIntent: `edit_${'b'.repeat(48)}`,
    projectKey,
    projectId: 'project:demo',
    sceneId: 'scene:one',
    baseRevision: 4,
    editorEpoch: 1,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }
}

test('scoped direct intent admits one owner, shares strict Promise identity across 50 duplicates and commits once', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const before = gateway.getSnapshot()
  const applied = applyWorldCommandBatch(before, { schema: 'modly.world-command-batch.v1', transactionId: 'c'.repeat(32),
    projectId: before.project.projectId, baseRevision: before.project.revision, origin: 'ai', commands: [{ type: 'rename-project', name: 'Direct' }] })
  assert.equal(applied.success, true)
  if (!applied.success) return
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  let commits = 0
  let acknowledgements = 0
  gateway.api.commitExternalCliDirectIntent = async () => {
    commits += 1; entered(); await held; gateway.setSnapshot(applied.snapshot)
    return { ok: true, receipt: { transactionId: 'c'.repeat(32), projectId: before.project.projectId,
      newRevision: applied.snapshot.project.revision, snapshotSha256: createHash('sha256')
        .update(canonicalWorldProjectSnapshotPayload(applied.snapshot)).digest('hex') } }
  }
  gateway.api.cancelExternalCliDirectIntent = async () => ({ ok: true, status: 'STALE' })
  gateway.api.adoptExternalCliDirectIntent = async () => { acknowledgements += 1; return { ok: true, status: 'APPLIED' } }
  gateway.api.leaveExternalCliEditor = async () => ({ ok: true })
  const request = directRequest({ editorEpoch: controller.getState().editorEpoch })
  const deliveries = Array.from({ length: 50 }, () => controller.applyScopedCliIntent(request))
  for (const delivery of deliveries) assert.equal(delivery, deliveries[0])
  const altered = controller.applyScopedCliIntent({ ...request, sceneId: 'scene:two' })
  assert.equal(altered === deliveries[0], false)
  assert.deepEqual(await altered, { ok: true, value: { status: 'rejected', reason: 'busy' } })
  await started
  assert.equal(commits, 1)
  release()
  const results = await Promise.all(deliveries)
  assert.equal(results.every((result) => result.ok && result.value.status === 'applied'), true)
  assert.equal(commits, 1)
  assert.equal(acknowledgements, 1)
  assert.equal(controller.getState().session?.undoStack.length, 1)
  assert.equal(controller.getState().session?.undoStack.at(-1)?.transactionId, 'c'.repeat(32))
  assert.equal(controller.getState().session?.redoStack.length, 0)
  assert.equal(controller.getState().externalCliUndoTransactionId, 'c'.repeat(32))
})

test('scoped direct intent rejects malformed requests and cancels exact expired or stale scope without committing', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const cancelled: unknown[] = []
  let commits = 0
  gateway.api.commitExternalCliDirectIntent = async () => { commits += 1; return { ok: false, code: 'STALE' } }
  gateway.api.cancelExternalCliDirectIntent = async (value) => { cancelled.push(value); return { ok: true, status: 'STALE' } }
  gateway.api.adoptExternalCliDirectIntent = async () => ({ ok: false, code: 'UNAVAILABLE' })
  gateway.api.leaveExternalCliEditor = async () => ({ ok: true })
  const epoch = controller.getState().editorEpoch

  const malformed = await controller.applyScopedCliIntent({ ...directRequest({ editorEpoch: epoch }), path: '/private' } as never)
  assert.deepEqual(malformed, { ok: true, value: { status: 'rejected', reason: 'invalid_request' } })
  const expired = await controller.applyScopedCliIntent(directRequest({ editorEpoch: epoch, expiresAt: Date.now() }))
  assert.equal(expired.ok && expired.value.status, 'stale')
  const staleScope = await controller.applyScopedCliIntent(directRequest({ nonce: 'd'.repeat(48), editIntent: `edit_${'e'.repeat(48)}`,
    editorEpoch: epoch, baseRevision: 3 }))
  assert.equal(staleScope.ok && staleScope.value.status, 'stale')
  assert.equal(commits, 0)
  assert.equal(cancelled.length, 2)
})

test('scoped direct intent rejects changing accessors without reading or forwarding their private second value', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  let reads = 0
  let commits = 0
  let cancels = 0
  let acknowledgements = 0
  gateway.api.commitExternalCliDirectIntent = async () => { commits += 1; return { ok: false, code: 'STALE' } }
  gateway.api.cancelExternalCliDirectIntent = async () => { cancels += 1; return { ok: true, status: 'STALE' } }
  gateway.api.adoptExternalCliDirectIntent = async () => { acknowledgements += 1; return { ok: true, status: 'APPLIED' } }
  const request = directRequest({ editorEpoch: controller.getState().editorEpoch })
  const hostile = Object.defineProperty({ ...request, nonce: undefined }, 'nonce', {
    enumerable: true,
    get() { reads += 1; return reads === 1 ? request.nonce : '/private' },
  })
  const result = await controller.applyScopedCliIntent(hostile as never)
  assert.deepEqual(result, { ok: true, value: { status: 'rejected', reason: 'invalid_request' } })
  assert.equal(reads, 0)
  assert.deepEqual({ commits, cancels, acknowledgements }, { commits: 0, cancels: 0, acknowledgements: 0 })
})

test('scoped direct intent rejects accessor-based commit replies without invoking the accessor or adoption ACK', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  let reads = 0
  let acknowledgements = 0
  gateway.api.commitExternalCliDirectIntent = async () => Object.defineProperty({ ok: true }, 'receipt', {
    enumerable: true,
    get() {
      reads += 1
      return reads === 1 ? { transactionId: 'c'.repeat(32), projectId: 'project:demo', newRevision: 5,
        snapshotSha256: 'd'.repeat(64) } : { transactionId: 'c'.repeat(32), projectId: 'project:demo', newRevision: 5,
        snapshotSha256: '/private' }
    },
  }) as never
  gateway.api.cancelExternalCliDirectIntent = async () => ({ ok: true, status: 'AMBIGUOUS' })
  gateway.api.adoptExternalCliDirectIntent = async () => { acknowledgements += 1; return { ok: true, status: 'APPLIED' } }
  gateway.api.leaveExternalCliEditor = async () => ({ ok: true })
  const result = await controller.applyScopedCliIntent(directRequest({ editorEpoch: controller.getState().editorEpoch }))
  assert.equal(result.ok && result.value.status, 'unverified')
  assert.equal(reads, 0)
  assert.equal(acknowledgements, 0)
  assert.equal(controller.getState().externalCliUndoTransactionId, null)
})

test('scoped direct intent orders commit, independent reopen, exact local Undo adoption, ready publication and one ACK', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  await controller.dispatchCommands({ transactionId: 'tx:owned-before-direct', origin: 'ui', commands: [{ type: 'rename-project', name: 'Owned' }] })
  const beforeState = controller.getState()
  const before = gateway.getSnapshot()
  const priorHistory = beforeState.session?.undoStack[0]
  const applied = applyWorldCommandBatch(before, { schema: 'modly.world-command-batch.v1', transactionId: 'f'.repeat(32),
    projectId: before.project.projectId, baseRevision: before.project.revision, origin: 'ai', commands: [{ type: 'rename-project', name: 'Direct' }] })
  assert.equal(applied.success, true)
  if (!applied.success) return
  const events: string[] = []
  let loadingState = beforeState
  const open = gateway.api.open
  gateway.api.open = async (request) => { events.push('open'); return open(request) }
  gateway.api.commitExternalCliDirectIntent = async () => {
    events.push('commit'); gateway.setSnapshot(applied.snapshot)
    loadingState = controller.getState()
    assert.equal(controller.classifyExternalCliEditorLifecycle(beforeState, loadingState, 'edit', 'edit'), 'retain')
    assert.equal(controller.classifyExternalCliEditorLifecycle(beforeState, loadingState, 'edit', 'playing'), 'revoke')
    return { ok: true, receipt: { transactionId: 'f'.repeat(32), projectId: before.project.projectId,
      newRevision: applied.snapshot.project.revision, snapshotSha256: createHash('sha256')
        .update(canonicalWorldProjectSnapshotPayload(applied.snapshot)).digest('hex') } }
  }
  gateway.api.cancelExternalCliDirectIntent = async () => ({ ok: true, status: 'STALE' })
  gateway.api.adoptExternalCliDirectIntent = async () => {
    events.push('ack')
    assert.equal(controller.classifyExternalCliEditorLifecycle(loadingState, controller.getState(), 'edit', 'edit'), 'retain')
    assert.equal(controller.getState().lifecycle, 'ready')
    assert.equal(controller.getState().session?.undoStack[0], priorHistory)
    assert.equal(controller.getState().session?.undoStack.at(-1)?.transactionId, 'f'.repeat(32))
    assert.equal(controller.getState().session?.redoStack.length, 0)
    assert.equal(controller.getState().externalCliUndoTransactionId, 'f'.repeat(32))
    return { ok: true, status: 'APPLIED' }
  }
  gateway.api.leaveExternalCliEditor = async () => ({ ok: true })
  events.length = 0
  const result = await controller.applyScopedCliIntent(directRequest({ nonce: '1'.repeat(48), editIntent: `edit_${'2'.repeat(48)}`,
    baseRevision: before.project.revision, editorEpoch: beforeState.editorEpoch }))
  assert.deepEqual(result, { ok: true, value: { status: 'applied', transactionId: 'f'.repeat(32), revision: applied.snapshot.project.revision } })
  assert.deepEqual(events, ['commit', 'open', 'ack'])
})

test('scoped direct intent never ACKs commit loss, malformed receipt, reopen failure/mismatch, or local adoption failure', async () => {
  for (const mode of ['commit-loss', 'malformed-receipt', 'reopen-failure', 'reopen-mismatch', 'adoption-failure'] as const) {
    const gateway = createGateway()
    const controller = createWorldEditorController(gateway.api)
    await controller.openProject(projectKey)
    const transactionId = mode === 'adoption-failure' ? '3'.repeat(32) : '4'.repeat(32)
    if (mode === 'adoption-failure') {
      await controller.dispatchCommands({ transactionId, origin: 'ui', commands: [{ type: 'rename-project', name: 'Existing' }] })
    }
    const state = controller.getState()
    const before = gateway.getSnapshot()
    const applied = applyWorldCommandBatch(before, { schema: 'modly.world-command-batch.v1', transactionId,
      projectId: before.project.projectId, baseRevision: before.project.revision, origin: 'ai', commands: [{ type: 'rename-project', name: 'Direct' }] })
    assert.equal(applied.success, true)
    if (!applied.success) continue
    let acknowledgements = 0
    let commits = 0
    gateway.api.commitExternalCliDirectIntent = async () => {
      commits += 1
      if (mode === 'commit-loss') { gateway.setSnapshot(applied.snapshot); return { ok: false, code: 'AMBIGUOUS' } }
      gateway.setSnapshot(applied.snapshot)
      if (mode === 'malformed-receipt') return { ok: true, receipt: { transactionId, projectId: before.project.projectId,
        newRevision: applied.snapshot.project.revision, snapshotSha256: '/private/not-a-hash' } } as never
      return { ok: true, receipt: { transactionId, projectId: before.project.projectId,
        newRevision: applied.snapshot.project.revision, snapshotSha256: createHash('sha256')
          .update(canonicalWorldProjectSnapshotPayload(applied.snapshot)).digest('hex') } }
    }
    gateway.api.cancelExternalCliDirectIntent = async () => ({ ok: true, status: 'AMBIGUOUS' })
    gateway.api.adoptExternalCliDirectIntent = async () => { acknowledgements += 1; return { ok: true, status: 'APPLIED' } }
    gateway.api.leaveExternalCliEditor = async () => ({ ok: true })
    if (mode === 'reopen-failure') {
      gateway.api.open = async () => ({ ok: false, error: { code: 'recovery_failed', message: 'Injected', retryable: true } })
    } else if (mode === 'reopen-mismatch') {
      const open = gateway.api.open
      gateway.api.open = async (request) => {
        const result = await open(request)
        if (result.ok && result.value.status === 'ready') result.value.snapshot.project.name = 'Digest mismatch'
        return result
      }
    }
    const marker = ({ 'commit-loss': '4', 'malformed-receipt': '5', 'reopen-failure': '6',
      'reopen-mismatch': '7', 'adoption-failure': '8' } as const)[mode]
    const result = await controller.applyScopedCliIntent(directRequest({ nonce: marker.repeat(48),
      editIntent: `edit_${marker.repeat(48)}`,
      baseRevision: before.project.revision, editorEpoch: state.editorEpoch }))
    assert.equal(result.ok && result.value.status, 'unverified', mode)
    if (result.ok && result.value.status === 'unverified') assert.equal(result.value.localAdoption, 'none', mode)
    assert.equal(commits, 1, mode)
    assert.equal(acknowledgements, 0, mode)
    assert.equal(controller.getState().externalCliUndoTransactionId, null, mode)
  }
})

test('direct adoption ACK loss preserves only independently verified local Undo and leaves the external editor once', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const state = controller.getState()
  const before = gateway.getSnapshot()
  const applied = applyWorldCommandBatch(before, { schema: 'modly.world-command-batch.v1', transactionId: '8'.repeat(32),
    projectId: before.project.projectId, baseRevision: before.project.revision, origin: 'ai', commands: [{ type: 'rename-project', name: 'Direct' }] })
  assert.equal(applied.success, true)
  if (!applied.success) return
  let acknowledgements = 0
  let leaves = 0
  gateway.api.commitExternalCliDirectIntent = async () => { gateway.setSnapshot(applied.snapshot); return { ok: true, receipt: {
    transactionId: '8'.repeat(32), projectId: before.project.projectId, newRevision: applied.snapshot.project.revision,
    snapshotSha256: createHash('sha256').update(canonicalWorldProjectSnapshotPayload(applied.snapshot)).digest('hex') } } }
  gateway.api.cancelExternalCliDirectIntent = async () => ({ ok: true, status: 'AMBIGUOUS' })
  gateway.api.adoptExternalCliDirectIntent = async () => { acknowledgements += 1; return { ok: false, code: 'UNAVAILABLE' } }
  gateway.api.leaveExternalCliEditor = async () => { leaves += 1; return { ok: true } }
  const result = await controller.applyScopedCliIntent(directRequest({ nonce: '8'.repeat(48), editIntent: `edit_${'8'.repeat(48)}`,
    editorEpoch: state.editorEpoch }))
  assert.deepEqual(result, { ok: true, value: { status: 'unverified', reason: 'adoption_ack_unavailable', localAdoption: 'verified' } })
  assert.equal(acknowledgements, 1)
  assert.equal(leaves, 1)
  assert.equal(controller.getState().session?.snapshot.project.name, 'Direct')
  assert.equal(controller.getState().session?.undoStack.at(-1)?.transactionId, '8'.repeat(32))
  assert.equal(controller.getState().externalCliUndoTransactionId, '8'.repeat(32))
})

test('combined external CLI barrier starts direct tombstone synchronously, permits STALE and blocks AMBIGUOUS', async () => {
  for (const terminal of ['STALE', 'AMBIGUOUS'] as const) {
    const gateway = createGateway()
    const controller = createWorldEditorController(gateway.api)
    await controller.openProject(projectKey)
    let enter!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let cancels = 0
    gateway.api.commitExternalCliDirectIntent = async () => { enter(); await held; return { ok: false, code: terminal } }
    gateway.api.cancelExternalCliDirectIntent = async () => { cancels += 1; return { ok: true, status: terminal } }
    gateway.api.adoptExternalCliDirectIntent = async () => ({ ok: false, code: 'UNAVAILABLE' })
    gateway.api.leaveExternalCliEditor = async () => ({ ok: true })
    const state = controller.getState()
    const direct = controller.applyScopedCliIntent(directRequest({ nonce: terminal === 'STALE' ? '9'.repeat(48) : 'a'.repeat(48),
      editIntent: `edit_${terminal === 'STALE' ? '9'.repeat(48) : 'a'.repeat(48)}`, editorEpoch: state.editorEpoch }))
    await entered
    const edit = controller.dispatchCommands({ transactionId: `tx:after-${terminal}`, origin: 'ui', commands: [{ type: 'rename-project', name: terminal }] })
    assert.equal(cancels, 1, 'cancellation starts before the ordinary operation joins the queue')
    assert.equal(gateway.requests.length, 0)
    release()
    const directResult = await direct
    assert.equal(directResult.ok && directResult.value.status, terminal === 'STALE' ? 'stale' : 'unverified')
    const editResult = await edit
    assert.equal(editResult.ok, terminal === 'STALE')
    assert.equal(gateway.requests.length, terminal === 'STALE' ? 1 : 0)
    const barrier = await controller.cancelExternalCliIntents()
    assert.deepEqual(barrier, { ok: true })
  }
})

test('C3c wires one nonvisual Workbench listener and Main dispatcher without UDS/Python edit route or visible CLI surface', async () => {
  const [workbench, ipcHandlers, transport, cli, drawer] = await Promise.all([
    readFile(new URL('../components/WorldsWorkbench.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../../../electron/main/ipc-handlers.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../../electron/main/worlds-cli-transport.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../../tools/modly-cli/agent.py', import.meta.url), 'utf8'),
    readFile(new URL('../components/WorldsAiDrawer.tsx', import.meta.url), 'utf8'),
  ])
  assert.equal((workbench.match(/onDirectEditRequest/g) ?? []).length, 2, 'one capability check and one listener registration')
  assert.match(workbench, /controller\.applyScopedCliIntent\(request\)/)
  assert.match(workbench, /const barrier = await controller\.cancelExternalCliIntents\(\)/)
  assert.doesNotMatch(workbench, /cancelExternalCliApplyIntent/)
  assert.match(ipcHandlers, /createWorldsCliDirectEditDispatch\(\(\) => worldsCliTransport, directEditBroker\)/)
  assert.doesNotMatch(transport, /case\s+['"](?:edit|edit-status)['"]|op\s*===\s*['"](?:edit|edit-status)['"]/)
  assert.doesNotMatch(cli, /def\s+(?:edit|edit_status)\b|['"]edit-status['"]/)
  assert.doesNotMatch(drawer, /Local CLI|External CLI|Start CLI pairing|Review/)
})

test('external CLI Apply stays in the controller queue, adopts the exact Main commit and preserves earlier Undo', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  await controller.dispatchCommands({ transactionId: 'tx:earlier', origin: 'ui', commands: [{ type: 'rename-project', name: 'Earlier' }] })
  const earlier = controller.getState().session?.undoStack[0]
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const before = gateway.getSnapshot()
  const applied = applyWorldCommandBatch(before, { schema: 'modly.world-command-batch.v1', transactionId: 'tx:external', projectId: before.project.projectId, baseRevision: before.project.revision, origin: 'ai', commands: [{ type: 'rename-project', name: 'External' }] })
  assert.equal(applied.success, true)
  if (!applied.success) return
  let calls = 0
  gateway.api.applyExternalCli = async () => {
    calls++
    started()
    await barrier
    gateway.setSnapshot(applied.snapshot)
    return { ok: true, transactionId: 'tx:external', projectId: before.project.projectId, baseRevision: before.project.revision,
      newRevision: applied.snapshot.project.revision,
      beforeSnapshotSha256: createHash('sha256').update(canonicalWorldProjectSnapshotPayload(before)).digest('hex'),
      snapshotSha256: createHash('sha256').update(canonicalWorldProjectSnapshotPayload(applied.snapshot)).digest('hex') }
  }
  const scope = { projectKey, projectId: before.project.projectId, baseRevision: before.project.revision, activeSceneId: 'scene:one' }
  const promise = controller.applyExternalCliProposal({ proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`, scope,
    editorEpoch: controller.getState().editorEpoch, isCurrent: () => true })
  await entered
  assert.equal(calls, 1)
  assert.equal(gateway.requests.length, 1)
  release()
  const result = await promise
  assert.equal(result.ok && result.value.status, 'applied')
  assert.equal(controller.getState().session?.undoStack[0], earlier)
  assert.equal(controller.getState().session?.undoStack[1]?.transactionId, 'tx:external')
  assert.equal(controller.getState().session?.undoStack[1]?.before.project.name, 'Earlier')
  assert.equal(controller.getState().session?.undoStack[1]?.after.project.name, 'External')
  assert.equal(controller.getState().externalCliUndoTransactionId, 'tx:external')
})

test('direct queued scene transition cancels Main Apply intent before it can leave the controller queue', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const prior = controller.getState().session
  const cancelled: string[] = []
  let applyCalls = 0
  gateway.api.cancelExternalCliIntent = async (attemptId) => { cancelled.push(attemptId); return true }
  gateway.api.applyExternalCli = async () => { applyCalls++; return { ok: false, code: 'USER_DECLINED' } }
  const before = controller.getState()
  const apply = controller.applyExternalCliProposal({ proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`,
    scope: { projectKey, projectId: before.session!.snapshot.project.projectId, baseRevision: before.session!.snapshot.project.revision,
      activeSceneId: before.activeSceneId! }, editorEpoch: before.editorEpoch, isCurrent: () => true })
  const scene = controller.setActiveScene('scene:two')
  assert.equal((await apply).ok, false)
  assert.equal((await scene).ok, true)
  assert.equal(applyCalls, 0)
  assert.equal(cancelled.length, 1)
  assert.match(cancelled[0], /^attempt_[a-f0-9]{48}$/)
  assert.equal(controller.getState().session, prior)
})

test('direct queued open, close and refresh each acknowledge cancellation before proceeding', async () => {
  for (const transition of ['open', 'close', 'refresh'] as const) {
    const gateway = createGateway()
    const controller = createWorldEditorController(gateway.api)
    await controller.openProject(projectKey)
    const before = controller.getState()
    const cancelled: string[] = []
    let applyCalls = 0
    gateway.api.cancelExternalCliIntent = async (id) => { cancelled.push(id); return true }
    gateway.api.applyExternalCli = async () => { applyCalls++; return { ok: false, code: 'USER_DECLINED' } }
    const applying = controller.applyExternalCliProposal({ proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`,
      scope: { projectKey, projectId: before.session!.snapshot.project.projectId, baseRevision: before.session!.snapshot.project.revision,
        activeSceneId: before.activeSceneId! }, editorEpoch: before.editorEpoch, isCurrent: () => true })
    const changing = transition === 'open' ? controller.openProject(projectKey)
      : transition === 'close' ? controller.closeProject() : controller.refresh()
    assert.equal((await applying).ok, false, transition)
    assert.equal((await changing).ok, true, transition)
    assert.equal(applyCalls, 0, transition)
    assert.equal(cancelled.length, 1, transition)
  }
})

test('missing cancellation ACK blocks direct edit and preserves prior history', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  await controller.dispatchCommands({ transactionId: 'tx:prior', origin: 'ui', commands: [{ type: 'rename-project', name: 'Prior' }] })
  const prior = controller.getState().session
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  gateway.api.applyExternalCli = async () => { entered(); await gate; return { ok: false, code: 'USER_DECLINED' } }
  gateway.api.cancelExternalCliIntent = async () => false
  const before = controller.getState()
  const apply = controller.applyExternalCliProposal({ proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`,
    scope: { projectKey, projectId: before.session!.snapshot.project.projectId, baseRevision: before.session!.snapshot.project.revision,
      activeSceneId: before.activeSceneId! }, editorEpoch: before.editorEpoch, isCurrent: () => true })
  await started
  const edit = controller.dispatchCommands({ transactionId: 'tx:blocked', origin: 'ui', commands: [{ type: 'rename-project', name: 'Blocked' }] })
  release()
  await apply
  assert.equal((await edit).ok, false)
  assert.equal(gateway.requests.some((item) => item.batch.transactionId === 'tx:blocked'), false)
  assert.equal(controller.getState().session, prior)
  assert.equal(controller.getState().canUndo, true)
})

test('external CLI named Undo persists through ordinary repository Undo only while its transaction is top', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const before = gateway.getSnapshot()
  const applied = applyWorldCommandBatch(before, { schema: 'modly.world-command-batch.v1', transactionId: 'tx:external-undo', projectId: before.project.projectId, baseRevision: before.project.revision, origin: 'ai', commands: [{ type: 'rename-project', name: 'External' }] })
  assert.equal(applied.success, true)
  if (!applied.success) return
  gateway.api.applyExternalCli = async () => { gateway.setSnapshot(applied.snapshot); return { ok: true, transactionId: 'tx:external-undo', projectId: before.project.projectId,
    baseRevision: before.project.revision, newRevision: applied.snapshot.project.revision,
    beforeSnapshotSha256: createHash('sha256').update(canonicalWorldProjectSnapshotPayload(before)).digest('hex'),
    snapshotSha256: createHash('sha256').update(canonicalWorldProjectSnapshotPayload(applied.snapshot)).digest('hex') } }
  const result = await controller.applyExternalCliProposal({ proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`,
    scope: { projectKey, projectId: before.project.projectId, baseRevision: before.project.revision, activeSceneId: 'scene:one' },
    editorEpoch: controller.getState().editorEpoch, isCurrent: () => true })
  assert.equal(result.ok && result.value.status, 'applied')
  assert.equal(controller.getState().externalCliUndoTransactionId, 'tx:external-undo')
  assert.equal((await controller.undoExternalCli('tx:external-undo')).ok, true)
  assert.equal(gateway.requests.at(-1)?.batch.origin, 'undo')
  assert.equal(controller.getState().session?.snapshot.project.name, 'Demo world')
  assert.equal(controller.getState().externalCliUndoTransactionId, null)
  await controller.closeProject()
  await controller.openProject(projectKey)
  assert.equal(controller.getState().externalCliUndoTransactionId, null)
})

test('cancel preserves history; ambiguous or mismatched before/after digest and revision refresh without named Undo', async () => {
  for (const mode of ['cancel', 'ambiguous', 'before', 'digest', 'revision'] as const) {
    const gateway = createGateway()
    const controller = createWorldEditorController(gateway.api)
    await controller.openProject(projectKey)
    await controller.dispatchCommands({ transactionId: `tx:earlier-${mode}`, origin: 'ui', commands: [{ type: 'rename-project', name: 'Earlier' }] })
    const before = gateway.getSnapshot()
    const beforeSession = controller.getState().session
    const applied = applyWorldCommandBatch(before, { schema: 'modly.world-command-batch.v1', transactionId: `tx:cli-${mode}`,
      projectId: before.project.projectId, baseRevision: before.project.revision, origin: 'ai', commands: [{ type: 'rename-project', name: 'CLI' }] })
    assert.equal(applied.success, true)
    if (!applied.success) return
    gateway.api.applyExternalCli = async () => {
      if (mode === 'cancel') return { ok: false, code: 'USER_DECLINED' }
      gateway.setSnapshot(applied.snapshot)
      if (mode === 'ambiguous') return { ok: false, code: 'AMBIGUOUS' }
      return { ok: true, transactionId: `tx:cli-${mode}`, projectId: before.project.projectId,
        baseRevision: before.project.revision, newRevision: applied.snapshot.project.revision + (mode === 'revision' ? 1 : 0),
        beforeSnapshotSha256: mode === 'before' ? 'e'.repeat(64) : createHash('sha256').update(canonicalWorldProjectSnapshotPayload(before)).digest('hex'),
        snapshotSha256: mode === 'digest' ? 'f'.repeat(64)
          : createHash('sha256').update(canonicalWorldProjectSnapshotPayload(applied.snapshot)).digest('hex') }
    }
    const result = await controller.applyExternalCliProposal({ proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`,
      scope: { projectKey, projectId: before.project.projectId, baseRevision: before.project.revision, activeSceneId: 'scene:one' },
      editorEpoch: controller.getState().editorEpoch, isCurrent: () => true })
    assert.equal(result.ok, true)
    if (!result.ok) continue
    assert.equal(result.value.status, mode === 'cancel' ? 'cancelled' : 'unverified')
    assert.equal(controller.getState().externalCliUndoTransactionId, null)
    assert.equal(controller.getState().session?.undoStack.length, mode === 'cancel' ? 1 : 0)
    if (mode === 'cancel') assert.equal(controller.getState().session, beforeSession)
    else assert.equal(controller.getState().session?.snapshot.project.name, 'CLI')
  }
})

test('Main no-write STALE preserves sealed Undo or Redo only after identical authoritative reopen', async () => {
  for (const history of ['undo', 'redo'] as const) {
    const gateway = createGateway()
    const controller = createWorldEditorController(gateway.api)
    await controller.openProject(projectKey)
    await controller.dispatchCommands({ transactionId: `tx:stale-${history}`, origin: 'ui', commands: [{ type: 'rename-project', name: 'Earlier' }] })
    if (history === 'redo') assert.equal((await controller.undo()).ok, true)
    const before = controller.getState()
    assert.ok(before.session)
    const authoritativeOpen = gateway.api.open
    let reopened = 0
    gateway.api.open = async (request) => { reopened++; return authoritativeOpen(request) }
    gateway.api.applyExternalCli = async () => ({ ok: false, code: 'STALE' })
    const result = await controller.applyExternalCliProposal({ proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`,
      scope: { projectKey, projectId: before.session.snapshot.project.projectId,
        baseRevision: before.session.snapshot.project.revision, activeSceneId: 'scene:one' },
      editorEpoch: before.editorEpoch, isCurrent: () => true })
    assert.equal(result.ok && result.value.status, 'stale')
    assert.equal(reopened, 1, 'Main STALE must be checked against an authoritative reopen')
    assert.equal(controller.getState().session, before.session, 'identical reopen preserves owned history authority')
    assert.equal(controller.getState().session?.undoStack, before.session.undoStack)
    assert.equal(controller.getState().session?.redoStack, before.session.redoStack)
    assert.equal(controller.getState().canUndo, before.canUndo)
    assert.equal(controller.getState().canRedo, before.canRedo)
    assert.equal(controller.getState().editorEpoch, before.editorEpoch)
  }
})

test('Main STALE with same-revision disk replacement or failed reopen drops history and CLI Undo', async () => {
  for (const mode of ['changed', 'open-failed'] as const) {
    const gateway = createGateway()
    const controller = createWorldEditorController(gateway.api)
    await controller.openProject(projectKey)
    await controller.dispatchCommands({ transactionId: `tx:before-${mode}`, origin: 'ui', commands: [{ type: 'rename-project', name: 'Earlier' }] })
    const before = controller.getState()
    assert.ok(before.session)
    gateway.api.applyExternalCli = async () => {
      if (mode === 'changed') {
        const changed = gateway.getSnapshot()
        changed.project.name = 'Same revision replacement'
        gateway.setSnapshot(changed)
      } else gateway.api.open = async () => ({ ok: false, error: { code: 'recovery_failed', message: 'Injected', retryable: true } })
      return { ok: false, code: 'STALE' }
    }
    const result = await controller.applyExternalCliProposal({ proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`,
      scope: { projectKey, projectId: before.session.snapshot.project.projectId,
        baseRevision: before.session.snapshot.project.revision, activeSceneId: 'scene:one' },
      editorEpoch: before.editorEpoch, isCurrent: () => true })
    assert.equal(result.ok && result.value.status, 'unverified')
    assert.equal(controller.getState().externalCliUndoTransactionId, null)
    assert.equal(controller.getState().session?.undoStack.length ?? 0, 0)
    if (mode === 'changed') assert.equal(controller.getState().session?.snapshot.project.name, 'Same revision replacement')
    else assert.equal(controller.getState().session, null)
  }
})

test('queued scene switch or prior edit invalidates external Apply before Main call', async () => {
  for (const mode of ['scene', 'edit'] as const) {
    const gateway = createGateway()
    const controller = createWorldEditorController(gateway.api)
    await controller.openProject(projectKey)
    const before = controller.getState()
    let calls = 0
    gateway.api.applyExternalCli = async () => { calls++; return { ok: false, code: 'USER_DECLINED' } }
    const queued = mode === 'scene' ? controller.setActiveScene('scene:two')
      : controller.dispatchCommands({ transactionId: 'tx:intervening', origin: 'ui', commands: [{ type: 'rename-project', name: 'Intervening' }] })
    const result = controller.applyExternalCliProposal({ proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`,
      scope: { projectKey, projectId: 'project:demo', baseRevision: 4, activeSceneId: 'scene:one' },
      editorEpoch: before.editorEpoch, isCurrent: () => true })
    assert.equal((await queued).ok, true)
    assert.equal((await result).ok, false)
    assert.equal(calls, 0)
  }
})

test('post-commit authoritative reopen failure leaves no stale editable session or CLI Undo', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const before = gateway.getSnapshot()
  const applied = applyWorldCommandBatch(before, { schema: 'modly.world-command-batch.v1', transactionId: 'tx:cli-open-fail',
    projectId: before.project.projectId, baseRevision: before.project.revision, origin: 'ai', commands: [{ type: 'rename-project', name: 'CLI' }] })
  assert.equal(applied.success, true)
  if (!applied.success) return
  gateway.api.applyExternalCli = async () => { gateway.setSnapshot(applied.snapshot); gateway.api.open = async () => ({ ok: false,
    error: { code: 'recovery_failed', message: 'Injected reopen failure', retryable: true } })
    return { ok: true, transactionId: 'tx:cli-open-fail', projectId: before.project.projectId,
      baseRevision: before.project.revision, newRevision: applied.snapshot.project.revision,
      beforeSnapshotSha256: createHash('sha256').update(canonicalWorldProjectSnapshotPayload(before)).digest('hex'),
      snapshotSha256: createHash('sha256').update(canonicalWorldProjectSnapshotPayload(applied.snapshot)).digest('hex') } }
  const result = await controller.applyExternalCliProposal({ proposalId: `proposal_${'a'.repeat(48)}`, reviewId: `review_${'b'.repeat(48)}`,
    scope: { projectKey, projectId: before.project.projectId, baseRevision: before.project.revision, activeSceneId: 'scene:one' },
    editorEpoch: controller.getState().editorEpoch, isCurrent: () => true })
  assert.equal(result.ok && result.value.status, 'unverified')
  assert.equal(controller.getState().session, null)
  assert.equal(controller.getState().externalCliUndoTransactionId, null)
})

test('AI queued preview and Apply bind the original editor epoch, scene, revision and request liveness', async () => {
  const gateway = createGateway({ delay: 5 })
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  let current = true
  const state = controller.getState()
  const guard = { context: { schema: 'modly.world-ai-context.v1' as const, projectKey, projectId: 'project:demo', baseRevision: 4, activeSceneId: 'scene:one', editorEpoch: state.editorEpoch, originSessionId: 'session-a', requestId: 'tx:ai-queued' }, isCurrent: () => current }
  const request = { transactionId: 'tx:ai-queued', origin: 'ai' as const, commands: [{ type: 'patch-entity' as const, sceneId: 'scene:one', entityId: 'entity:hero', patch: { name: 'Proposed' } }] }
  const before = controller.getState().session
  const pending = controller.previewProposal(request, guard)
  current = false
  assert.equal((await pending).ok, false)
  assert.equal(controller.getState().session, before)
  current = true
  const preview = await controller.previewProposal(request, guard)
  assert.equal(preview.ok, true)
  if (!preview.ok) return
  const switchScene = controller.setActiveScene('scene:two')
  const lateApply = controller.applyProposalExact(preview.value.batch, guard)
  await switchScene
  assert.equal((await lateApply).ok, false)
  assert.equal(gateway.requests.length, 0)
  await controller.setActiveScene('scene:one')
  assert.equal((await controller.previewProposal(request, guard)).ok, false)
  await controller.closeProject()
  await controller.openProject(projectKey)
  assert.equal((await controller.previewProposal(request, guard)).ok, false)
  const fresh = { ...guard, context: { ...guard.context, editorEpoch: controller.getState().editorEpoch } }
  const human = controller.dispatchCommands({ transactionId: 'tx:human-first', origin: 'ui', commands: [{ type: 'rename-project', name: 'Human' }] })
  const latePreview = controller.previewProposal(request, fresh)
  await human
  assert.equal((await latePreview).ok, false)
  assert.equal(controller.getState().session?.snapshot.project.revision, 5)
})

test('rendered Inspector authority rejects stale input replacement without losing newly authored actions', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const rendered = controller.getState()
  assert.ok(rendered.session && rendered.activeSceneId)
  const snapshot = rendered.session.snapshot
  const expectedAuthority = { projectKey, projectId: snapshot.project.projectId, baseRevision: snapshot.project.revision, activeSceneId: rendered.activeSceneId }
  const staleCommands = buildUpdateButtonInputActionCommands(snapshot, 'input:jump', { name: 'Leap', control: 'KeyJ' })
  const newInput = buildAddAxis2dInputActionCommands(snapshot, createDeterministicWorldEditorIdentityGenerator('new-input'), { name: 'Walk' })
  assert.equal((await controller.dispatchCommands({ transactionId: 'tx:new-input', origin: 'ui', commands: newInput })).ok, true)
  const current = controller.getState().session
  const rejected = await controller.dispatchCommands({ transactionId: 'tx:stale-inspector', origin: 'ui', commands: staleCommands }, expectedAuthority)
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.equal(rejected.error.code, 'revision_conflict')
  assert.equal(controller.getState().session, current)
  assert.equal(gateway.requests.length, 1)
  assert.deepEqual(controller.getState().session?.snapshot.project.inputActions.map((action) => action.name), ['Jump', 'Walk'])
})

function createGateway(options: { failApply?: boolean; mismatch?: boolean; delay?: number; singleScene?: boolean } = {}) {
  let snapshot = createValidWorldSnapshot()
  if (options.singleScene) {
    snapshot.project.scenes = snapshot.project.scenes.slice(0, 1)
    snapshot.scenes = snapshot.scenes.slice(0, 1)
  }
  const requests: WorldProjectCommandRequest[] = []
  const deleteRequests: WorldProjectDeleteRequest[] = []
  const appliedTransactionIds = new Set<string>()
  const api: WorldProjectService = {
    async create() { return { ok: true, value: { projectKey, snapshot: structuredClone(snapshot), durabilityWarnings: [] } } },
    async list() { return { ok: true, value: { projects: [{ projectKey, status: 'ready', projectId: snapshot.project.projectId, name: snapshot.project.name, revision: snapshot.project.revision }], issues: [] } } },
    async open() { return { ok: true, value: { status: 'ready', projectKey, snapshot: structuredClone(snapshot), durabilityWarnings: [] } } },
    async previewCommands(request) { return commandResult(request, false) },
    async applyCommands(request) {
      requests.push(structuredClone(request))
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay))
      if (options.failApply) return { ok: false, error: { code: 'write_failed', message: 'failed', retryable: true } }
      if (appliedTransactionIds.has(request.batch.transactionId)) {
        return { ok: false, error: { code: 'transaction_reuse' as const, message: 'transaction reused', retryable: false } }
      }
      const result = commandResult(request, true)
      if (result.ok) appliedTransactionIds.add(request.batch.transactionId)
      if (result.ok && options.mismatch) result.value.snapshot.project.name = 'Repository mismatch'
      return result
    },
    async delete(request) {
      deleteRequests.push(structuredClone(request))
      return { ok: true, value: { projectKey, transactionId: request.transactionId, idempotent: false } }
    },
  }
  function commandResult(request: WorldProjectCommandRequest, persist: boolean) {
    const applied = applyWorldCommandBatch(snapshot, request.batch)
    if (!applied.success) return { ok: false as const, error: { code: applied.issues[0]?.code === 'revision-conflict' ? 'revision_conflict' as const : 'invalid_request' as const, message: 'rejected', retryable: false } }
    if (persist) snapshot = structuredClone(applied.snapshot)
    return {
      ok: true as const,
      value: {
        projectKey,
        snapshot: structuredClone(applied.snapshot),
        newRevision: applied.snapshot.project.revision,
        idempotent: false,
        changes: applied.changes,
        warnings: applied.warnings,
        inverse: structuredClone(applied.inverse),
        receipt: { transactionId: request.batch.transactionId, payloadSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), appliedRevision: applied.snapshot.project.revision },
      },
    }
  }
  return { api, requests, deleteRequests, getSnapshot: () => structuredClone(snapshot), setSnapshot: (value: ReturnType<typeof createValidWorldSnapshot>) => { snapshot = structuredClone(value) } }
}

test('create/open, add a second scene and switch scenes without revising the document', async () => {
  const gateway = createGateway({ singleScene: true })
  const controller = createWorldEditorController(gateway.api)
  const created = await controller.createProject({ name: 'Demo', initialSceneName: 'First' })
  assert.equal(created.ok, true)
  const current = controller.getState()
  assert.ok(current.session)
  const commands = buildAddSceneCommands({
    snapshot: current.session.snapshot,
    projectKey,
    identities: createDeterministicWorldEditorIdentityGenerator('test:add-second-scene'),
  }, { name: 'Second scene' })
  assert.equal((await controller.dispatchCommands({ transactionId: 'tx:add-second-scene', origin: 'ui', commands })).ok, true)
  const afterAdd = controller.getState().session?.snapshot.project.revision
  assert.equal(afterAdd, 5)
  assert.equal((await controller.setActiveScene(commands[0].scene.sceneId)).ok, true)
  assert.equal(controller.getState().activeSceneId, commands[0].scene.sceneId)
  assert.equal(controller.getState().session?.snapshot.project.revision, afterAdd)
  await controller.closeProject()
  assert.equal(controller.getState().session, null)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  assert.equal(controller.getState().session?.undoStack.length, 0)
})

test('list is immutable and delete is revision checked against the open authority', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  const listed = await controller.listProjects()
  assert.equal(listed.ok, true)
  if (listed.ok) {
    assert.equal(Object.isFrozen(listed.value), true)
    assert.equal(listed.value[0]?.projectKey, projectKey)
  }
  await controller.openProject(projectKey)
  await controller.dispatchCommands({ transactionId: 'tx:before-delete', origin: 'ui', commands: [{ type: 'rename-project', name: 'Delete me' }] })
  assert.equal((await controller.deleteProject('tx:delete')).ok, true)
  assert.deepEqual(gateway.deleteRequests, [{ projectKey, expectedRevision: 5, transactionId: 'tx:delete' }])
  assert.equal(controller.getState().lifecycle, 'closed')
  assert.equal(controller.getState().session, null)
})

test('dispatch stamps authority, serializes overlaps and retries idempotently without duplicate history', async () => {
  const gateway = createGateway({ delay: 5 })
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const first = controller.dispatchCommands({ transactionId: 'tx:first', origin: 'ui', commands: [{ type: 'rename-project', name: 'First' }] })
  const second = controller.dispatchCommands({ transactionId: 'tx:second', origin: 'ui', commands: [{ type: 'rename-project', name: 'Second' }] })
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, true)
  assert.deepEqual(gateway.requests.map((request) => request.batch.baseRevision), [4, 5])
  assert.deepEqual(gateway.requests.map((request) => request.batch.projectId), ['project:demo', 'project:demo'])
  assert.equal(controller.getState().session?.snapshot.project.name, 'Second')
  assert.equal(controller.getState().session?.undoStack.length, 2)
  const retried = await controller.dispatchCommands({ transactionId: 'tx:second', origin: 'ui', commands: [{ type: 'rename-project', name: 'Second' }] })
  assert.equal(retried.ok && retried.value.idempotent, true)
  assert.equal(gateway.requests.length, 2)
  assert.equal(controller.getState().session?.undoStack.length, 2)
})

test('authoritative adoption preserves owned history and receipt identities while detaching returned results', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const firstResult = await controller.dispatchCommands({ transactionId: 'tx:identity-one', origin: 'ui', commands: [{ type: 'rename-project', name: 'First' }] })
  assert.equal(firstResult.ok, true)
  if (!firstResult.ok) return
  const afterFirst = controller.getState().session
  assert.ok(afterFirst)
  const secondResult = await controller.dispatchCommands({ transactionId: 'tx:identity-two', origin: 'ui', commands: [{ type: 'rename-project', name: 'Second' }] })
  assert.equal(secondResult.ok, true)
  if (!secondResult.ok) return
  const afterSecond = controller.getState().session
  assert.ok(afterSecond)

  assert.equal(afterSecond.undoStack[0], afterFirst.undoStack[0])
  assert.equal(afterSecond.undoStack[0].before, afterFirst.undoStack[0].before)
  assert.equal(afterSecond.undoStack[0].after, afterFirst.undoStack[0].after)
  assert.equal(afterSecond.receipts[0], afterFirst.receipts[0])
  assert.notEqual(secondResult.value.receipt, gateway.requests.at(-1))

  assert.equal(Reflect.set(secondResult.value.receipt, 'transactionId', 'tx:mutated-return'), false)
  assert.equal(afterSecond.receipts[1].transactionId, 'tx:identity-two')
  const retry = await controller.dispatchCommands({ transactionId: 'tx:identity-two', origin: 'ui', commands: [{ type: 'rename-project', name: 'Second' }] })
  assert.equal(retry.ok && retry.value.idempotent, true)
  assert.equal(controller.getState().session, afterSecond)
})

test('dispatch authority expectation rejects commands prepared before a serialized concurrent edit', async () => {
  const gateway = createGateway({ delay: 5 })
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const expected = { projectKey, projectId: 'project:demo', baseRevision: 4, activeSceneId: 'scene:one' }
  const human = controller.dispatchCommands({ transactionId: 'tx:concurrent', origin: 'ui', commands: [{ type: 'rename-project', name: 'Concurrent' }] })
  const stale = controller.dispatchCommands(
    { transactionId: 'tx:prepared-before', origin: 'workflow', commands: [{ type: 'rename-project', name: 'Stale' }] },
    expected,
  )
  assert.equal((await human).ok, true)
  const staleResult = await stale
  assert.equal(staleResult.ok, false)
  if (!staleResult.ok) assert.equal(staleResult.error.code, 'revision_conflict')
  assert.equal(gateway.requests.length, 1)
  assert.equal(controller.getState().session?.snapshot.project.name, 'Concurrent')
})

test('gateway failure or mismatched result never changes the local canonical session', async () => {
  for (const gateway of [createGateway({ failApply: true }), createGateway({ mismatch: true })]) {
    const controller = createWorldEditorController(gateway.api)
    await controller.openProject(projectKey)
    const before = controller.getState().session
    const result = await controller.dispatchCommands({ transactionId: 'tx:failure', origin: 'ui', commands: [{ type: 'rename-project', name: 'Never' }] })
    assert.equal(result.ok, false)
    assert.equal(controller.getState().session, before)
    assert.equal(controller.getState().session?.snapshot.project.revision, 4)
  }
})

test('undo and redo persist through repository commands, revisions stay monotonic and new edits clear redo', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  await controller.dispatchCommands({ transactionId: 'tx:edit', origin: 'ui', commands: [{ type: 'rename-project', name: 'Edited' }] })
  assert.equal((await controller.undo()).ok, true)
  assert.equal(controller.getState().session?.snapshot.project.name, 'Demo world')
  assert.equal(controller.getState().session?.snapshot.project.revision, 6)
  assert.equal(gateway.requests.at(-1)?.batch.origin, 'undo')
  assert.equal((await controller.redo()).ok, true)
  assert.equal(controller.getState().session?.snapshot.project.name, 'Edited')
  assert.equal(controller.getState().session?.snapshot.project.revision, 7)
  await controller.undo()
  await controller.dispatchCommands({ transactionId: 'tx:new-branch', origin: 'ui', commands: [{ type: 'rename-project', name: 'Branch' }] })
  assert.equal(controller.getState().canRedo, false)
  assert.equal((await controller.refresh()).ok, true)
  assert.equal(controller.getState().session?.undoStack.length, 0)
})

test('replaying an identical dispatch after undo reaches repository authority instead of returning a stale success', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  const request = { transactionId: 'tx:replay-after-undo', origin: 'ui' as const, commands: [{ type: 'rename-project' as const, name: 'Edited' }] }
  await controller.openProject(projectKey)
  assert.equal((await controller.dispatchCommands(request)).ok, true)
  assert.equal((await controller.undo()).ok, true)

  const replay = await controller.dispatchCommands(request)

  assert.equal(replay.ok, false)
  if (!replay.ok) assert.equal(replay.error.code, 'transaction_reuse')
  assert.equal(gateway.requests.length, 2)
  assert.equal(gateway.requests.at(-1)?.batch.origin, 'undo')
  assert.equal(controller.getState().session?.snapshot.project.revision, 6)
  assert.equal(controller.getState().session?.snapshot.project.name, 'Demo world')
})

test('replaying after redo and a queued revision race cannot return the original receipt', async () => {
  const gateway = createGateway({ delay: 5 })
  const controller = createWorldEditorController(gateway.api)
  const replayed = { transactionId: 'tx:replay-after-redo', origin: 'ui' as const, commands: [{ type: 'rename-project' as const, name: 'Edited' }] }
  await controller.openProject(projectKey)
  assert.equal((await controller.dispatchCommands(replayed)).ok, true)
  assert.equal((await controller.undo()).ok, true)
  assert.equal((await controller.redo()).ok, true)

  const advancing = controller.dispatchCommands({ transactionId: 'tx:advance-before-replay', origin: 'ui', commands: [{ type: 'rename-project', name: 'Advanced' }] })
  const replay = controller.dispatchCommands(replayed)

  assert.equal((await advancing).ok, true)
  const replayResult = await replay
  assert.equal(replayResult.ok, false)
  if (!replayResult.ok) assert.equal(replayResult.error.code, 'transaction_reuse')
  assert.equal(gateway.requests.length, 4)
  assert.equal(gateway.requests.at(-1)?.batch.transactionId, 'tx:advance-before-replay')
  assert.equal(gateway.requests.at(-1)?.batch.baseRevision, 7)
  assert.equal(controller.getState().session?.snapshot.project.revision, 8)
  assert.equal(controller.getState().session?.snapshot.project.name, 'Advanced')
})

test('project-only undo preserves unchanged locked entities', async () => {
  const gateway = createGateway()
  const locked = gateway.getSnapshot()
  locked.scenes[0].entities[0].locked = true
  gateway.setSnapshot(locked)
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  assert.equal((await controller.dispatchCommands({ transactionId: 'tx:locked-edit', origin: 'ui', commands: [{ type: 'rename-project', name: 'Locked edit' }] })).ok, true)
  assert.equal((await controller.undo()).ok, true)
  assert.equal(controller.getState().session?.snapshot.project.name, 'Demo world')
  assert.equal(controller.getState().session?.snapshot.scenes[0].entities[0].locked, true)
  assert.deepEqual(gateway.requests.at(-1)?.batch.commands, [{ type: 'rename-project', name: 'Demo world' }])
})

test('proposal preview is non-mutating and exact apply rejects stale batches', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const preview = await controller.previewProposal({ transactionId: 'tx:proposal', origin: 'ai', commands: [{ type: 'rename-project', name: 'AI name' }] })
  assert.equal(preview.ok, true)
  assert.equal(controller.getState().session?.snapshot.project.name, 'Demo world')
  if (!preview.ok) return
  await controller.dispatchCommands({ transactionId: 'tx:human', origin: 'ui', commands: [{ type: 'rename-project', name: 'Human' }] })
  const stale = await controller.applyProposalExact(preview.value.batch)
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'revision_conflict')
})

test('state boundaries are frozen and listener failures cannot corrupt dispatch', async () => {
  const gateway = createGateway()
  const controller = createWorldEditorController(gateway.api)
  let safeListenerCalls = 0
  controller.subscribe(() => { throw new Error('hostile listener') })
  controller.subscribe(() => { safeListenerCalls += 1 })
  await controller.openProject(projectKey)
  const state = controller.getState()
  assert.equal(Object.isFrozen(state), true)
  assert.equal(Object.isFrozen(state.session?.snapshot), true)
  assert.equal(Reflect.set(state.session!.snapshot.project, 'name', 'Mutated'), false)
  assert.equal((await controller.dispatchCommands({ transactionId: 'tx:safe', origin: 'ui', commands: [{ type: 'rename-project', name: 'Safe' }] })).ok, true)
  assert.ok(safeListenerCalls > 0)
})

test('AI cancellation during repository preview keeps the canonical document unchanged and cannot return an actionable batch', async () => {
  const gateway = createGateway()
  const preview = gateway.api.previewCommands
  let enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  gateway.api.previewCommands = async (request) => { enter(); await held; return preview(request) }
  const controller = createWorldEditorController(gateway.api)
  await controller.openProject(projectKey)
  const before = controller.getState().session
  let current = true
  const context = { schema: 'modly.world-ai-context.v1' as const, projectKey, projectId: 'project:demo', baseRevision: 4,
    activeSceneId: 'scene:one', editorEpoch: controller.getState().editorEpoch, originSessionId: 'session-a', requestId: 'tx:held-preview' }
  const pending = controller.previewProposal({ transactionId: context.requestId, origin: 'ai', commands: [{ type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { enabled: false } }] }, { context, isCurrent: () => current })
  await entered; current = false; release()
  assert.equal((await pending).ok, false)
  assert.equal(controller.getState().session, before)
  assert.equal(gateway.requests.length, 0)
  assert.notEqual(controller.getState().lifecycle, 'loading')
})
