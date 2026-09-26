import assert from 'node:assert/strict'
import test from 'node:test'

import { WORLD_PROJECT_CHANNELS } from '../../src/shared/types/worldProjects.ts'
import { createElectronApi } from './electron-api.ts'

test('preload exposes only the exact Worlds project methods and invokes exact channels', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    ipcRenderer: {
      invoke: async (channel, ...args) => { calls.push({ channel, args }); return { ok: true, value: {} } },
      send: () => undefined,
      on: () => undefined,
      removeAllListeners: () => undefined,
    },
    webFrame: { setZoomFactor: () => undefined },
  })
  const projects = api.workspace.worlds.projects
  assert.deepEqual(Object.keys(projects).sort(), [
    'applyCommands', 'create', 'delete', 'discardAi', 'list', 'open', 'previewAi', 'previewCommands',
  ])
  assert.equal('readFile' in projects, false)
  assert.equal('writeFile' in projects, false)
  assert.equal('saveSnapshot' in projects, false)

  const create = { name: 'World', initialSceneName: 'Scene' }
  const open = { projectKey: 'world-0123456789abcdef0123456789abcdef' }
  const command = { projectKey: open.projectKey, batch: { arbitrary: 'preload forwards typed request' } } as never
  const remove = { ...open, expectedRevision: 0, transactionId: 'tx:delete' }
  await projects.create(create)
  await projects.list()
  await projects.open(open)
  await projects.previewCommands(command)
  await projects.applyCommands(command)
  await projects.delete(remove)

  const previewAi = { proposal: { type: 'world_command_proposal' } } as never
  const discardAi = { context: { requestId: 'tx:review' }, authority: `apply_${'a'.repeat(48)}` } as never
  await projects.previewAi!(previewAi)
  await projects.discardAi!(discardAi)

  assert.deepEqual(calls, [
    { channel: WORLD_PROJECT_CHANNELS.create, args: [create] },
    { channel: WORLD_PROJECT_CHANNELS.list, args: [] },
    { channel: WORLD_PROJECT_CHANNELS.open, args: [open] },
    { channel: WORLD_PROJECT_CHANNELS.previewCommands, args: [command] },
    { channel: WORLD_PROJECT_CHANNELS.applyCommands, args: [command] },
    { channel: WORLD_PROJECT_CHANNELS.delete, args: [remove] },
    { channel: WORLD_PROJECT_CHANNELS.previewAi, args: [previewAi] },
    { channel: WORLD_PROJECT_CHANNELS.discardAi, args: [discardAi] },
  ])
  assert.equal('executeAi' in projects, false)
  assert.equal('queryAi' in projects, false)
})

test('preload exposes trusted CLI review, reject and narrow Main Apply request', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    ipcRenderer: { invoke: async (channel, ...args) => { calls.push({ channel, args }); return { ok: true } },
      send: () => undefined, on: () => undefined, removeAllListeners: () => undefined },
    webFrame: { setZoomFactor: () => undefined },
  })
  const cli = api.workspace.worlds.cli
  assert.deepEqual(Object.keys(cli).sort(), ['adoptDirectEdit', 'apply', 'cancelApplyIntent', 'cancelDirectEdit', 'cancelDirectEditReadiness',
    'commitDirectEdit', 'editorLeft', 'getReview', 'listPending', 'onContextRequest', 'onDirectEditReadinessRequest',
    'onDirectEditRequest', 'reject', 'respondContext', 'respondDirectEditReadiness', 'revoke', 'status'])
  const proposalId = `proposal_${'a'.repeat(48)}`
  const reviewId = `review_${'b'.repeat(48)}`
  const attemptId = `attempt_${'c'.repeat(48)}`
  await cli.listPending()
  await cli.getReview({ proposalId })
  await cli.reject({ proposalId, reviewId })
  await cli.apply({ proposalId, reviewId, attemptId })
  await cli.cancelApplyIntent({ attemptId })
  await cli.respondContext({ nonce: 'a'.repeat(48), projectKey: `world-${'b'.repeat(32)}`,
    projectId: 'project:one', sceneId: 'scene:one', revision: 3, editorEpoch: 2, mode: 'edit' })
  await cli.editorLeft()
  const readiness = { nonce: 'd'.repeat(48), intentId: `intent_${'e'.repeat(48)}` } as const
  await cli.respondDirectEditReadiness({ ...readiness, status: 'READY' })
  await cli.cancelDirectEditReadiness(readiness)
  const direct = { nonce: 'f'.repeat(48), editIntent: `edit_${'1'.repeat(48)}` } as const
  await cli.commitDirectEdit(direct)
  await cli.cancelDirectEdit(direct)
  await cli.adoptDirectEdit({ ...direct, transactionId: '2'.repeat(32), newRevision: 4, snapshotSha256: '3'.repeat(64) })
  assert.deepEqual(calls, [
    { channel: 'workspace:worlds:cli:listPending', args: [] },
    { channel: 'workspace:worlds:cli:getReview', args: [{ proposalId }] },
    { channel: 'workspace:worlds:cli:reject', args: [{ proposalId, reviewId }] },
    { channel: 'workspace:worlds:cli:apply', args: [{ proposalId, reviewId, attemptId }] },
    { channel: 'workspace:worlds:cli:cancelApplyIntent', args: [{ attemptId }] },
    { channel: 'workspace:worlds:cli:contextResponse', args: [{ nonce: 'a'.repeat(48), projectKey: `world-${'b'.repeat(32)}`,
      projectId: 'project:one', sceneId: 'scene:one', revision: 3, editorEpoch: 2, mode: 'edit' }] },
    { channel: 'workspace:worlds:cli:editorLeft', args: [] },
    { channel: 'workspace:worlds:cli:directEditReadinessResponse', args: [{ ...readiness, status: 'READY' }] },
    { channel: 'workspace:worlds:cli:directEditReadinessCancel', args: [readiness] },
    { channel: 'workspace:worlds:cli:directEditCommit', args: [direct] },
    { channel: 'workspace:worlds:cli:directEditCancel', args: [direct] },
    { channel: 'workspace:worlds:cli:directEditAdopt', args: [{ ...direct, transactionId: '2'.repeat(32),
      newRevision: 4, snapshotSha256: '3'.repeat(64) }] },
  ])
  for (const forbidden of [
    'workspace:worlds:cli:commitIntent', 'workspace:worlds:cli:editorAdopted',
    'workspace:worlds:cli:edit', 'workspace:worlds:cli:edit-status',
  ]) assert.equal(calls.some(({ channel }) => channel === forbidden), false)
})

test('preload validates direct-edit request and each outbound payload independently with exact keys', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const listeners = new Map<string, (_event: unknown, value: unknown) => void>()
  const api = createElectronApi({
    ipcRenderer: {
      invoke: async (channel, ...args) => { calls.push({ channel, args }); return { ok: true } },
      send: () => undefined,
      on: (channel, listener) => { listeners.set(channel, listener) },
      removeAllListeners: (channel) => { listeners.delete(channel) },
    },
    webFrame: { setZoomFactor: () => undefined },
  })
  const received: unknown[] = []
  api.workspace.worlds.cli.onDirectEditRequest((request) => received.push(request))
  const request = { nonce: 'a'.repeat(48), editIntent: `edit_${'b'.repeat(48)}`, projectKey: `world-${'c'.repeat(32)}`,
    projectId: 'project:one', sceneId: 'scene:one', baseRevision: 3, editorEpoch: 7, expiresAt: 99_000 }
  listeners.get('workspace:worlds:cli:directEditRequest')?.({}, request)
  listeners.get('workspace:worlds:cli:directEditRequest')?.({}, { ...request, workspaceRoot: '/tmp/leak' })
  assert.deepEqual(received, [request])

  const correlation = { nonce: request.nonce, editIntent: request.editIntent }
  await api.workspace.worlds.cli.commitDirectEdit({ ...correlation, extra: true } as never)
  await api.workspace.worlds.cli.cancelDirectEdit({ nonce: ['bad'], editIntent: request.editIntent } as never)
  await api.workspace.worlds.cli.adoptDirectEdit({ ...correlation, transactionId: 'd'.repeat(32), newRevision: 4,
    snapshotSha256: 'e'.repeat(64), extra: true } as never)
  assert.deepEqual(calls, [], 'invalid preload payloads never cross the context bridge')
})
