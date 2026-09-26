import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { WorldProjectRepository } from '../../../../electron/main/world-project-repository.ts'
import type { WorldCommandBatchV1 } from '../core/worldCommands.ts'
import {
  buildAddModelEntityCommands,
  buildAddSceneCommands,
  createDeterministicWorldEditorIdentityGenerator,
} from './worldEditorCommandBuilders.ts'
import { createWorldEditorController } from './worldEditorController.ts'
import type { WorldAssetLibraryRenderable } from '../worldAssetLibraryService.ts'
import { createWorldProjectService } from '../worldProjectService.ts'
import { buildAddEmptyEntityCommands, buildCharacterControllerPresetCommands } from './worldAuthoringModel.ts'
import { createWorldAiChatAdapter } from './worldAiChatAdapter.ts'
import { createWorldEditorCommandPort } from './worldEditorCommandPort.ts'
import type { WorldProjectsApi } from '../../../shared/types/worldProjects.ts'

test('real repository preserves authored scene order while controller adds and reopens a workspace GLB idempotently', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'modly-world-controller-integration-'))
  const projectKey = `world-${'a'.repeat(32)}`
  const initialSceneKey = `scene-${'f'.repeat(32)}`
  const repository = new WorldProjectRepository({
    getWorkspaceRoot: () => workspaceRoot,
    createProjectKey: () => projectKey,
    createSceneKey: () => initialSceneKey,
    now: () => new Date('2026-09-02T08:00:00.000Z'),
    syncDirectory: () => true,
  })

  try {
    const service = createWorldProjectService(repository)
    const controller = createWorldEditorController(service)
    assert.equal((await controller.createProject({ name: 'Runtime QA', initialSceneName: 'Scene 1' })).ok, true)
    let state = controller.getState()
    assert.ok(state.session)

    const addSceneCommands = buildAddSceneCommands({
      snapshot: state.session.snapshot,
      projectKey,
      identities: createDeterministicWorldEditorIdentityGenerator('runtime-scene-two'),
    }, { name: 'Scene 2' })
    const initialDocumentPath = state.session.snapshot.project.scenes[0]?.documentPath ?? ''
    assert.ok(addSceneCommands[0].reference.documentPath < initialDocumentPath, 'fixture must expose repository path sorting')
    assert.equal((await controller.dispatchCommands({ transactionId: 'tx:runtime-scene-two', origin: 'ui', commands: addSceneCommands })).ok, true)
    assert.equal((await controller.setActiveScene(addSceneCommands[0].scene.sceneId)).ok, true)

    state = controller.getState()
    assert.ok(state.session && state.activeSceneId)
    const asset: Extract<WorldAssetLibraryRenderable, { openable: true }> = {
      id: 'workflows:1780066552-pixal3d',
      name: '1780066552_9fb6e87d_pixal3d.glb',
      displayName: '1780066552_9fb6e87d_pixal3d.glb',
      type: 'GLB model',
      sourceScope: 'workflows',
      capability: 'mesh',
      state: 'ready',
      previewKind: '3d-model',
      warnings: [],
      openable: true,
      workspacePath: 'Workflows/1780066552_9fb6e87d_pixal3d.glb',
      item: {
        id: 'world:Workflows/1780066552_9fb6e87d_pixal3d.glb',
        workspacePath: 'Workflows/1780066552_9fb6e87d_pixal3d.glb',
        url: 'modly-workspace://asset/Workflows/1780066552_9fb6e87d_pixal3d.glb',
        kind: 'glb',
        role: 'asset',
        visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    }
    const addModelCommands = buildAddModelEntityCommands({
      snapshot: state.session.snapshot,
      projectKey,
      activeSceneId: state.activeSceneId,
      identities: createDeterministicWorldEditorIdentityGenerator('runtime-asset'),
    }, {
      workspacePath: asset.item.workspacePath,
      format: asset.item.kind,
      name: asset.displayName,
      role: asset.item.role,
      transform: asset.item.transform,
    })
    const batch: WorldCommandBatchV1 = {
      schema: 'modly.world-command-batch.v1',
      transactionId: 'tx:runtime-asset',
      projectId: state.session.snapshot.project.projectId,
      baseRevision: state.session.snapshot.project.revision,
      origin: 'ui',
      commands: addModelCommands,
    }

    const added = await controller.dispatchCommands({ transactionId: batch.transactionId, origin: batch.origin, commands: batch.commands })
    assert.equal(added.ok, true)
    assert.equal(controller.getState().session?.snapshot.project.resources.length, 1)
    assert.equal(controller.getState().session?.snapshot.scenes.find((scene) => scene.sceneId === state.activeSceneId)?.entities.length, 1)
    assert.deepEqual(
      controller.getState().session?.snapshot.scenes.map((scene) => scene.sceneId),
      controller.getState().session?.snapshot.project.scenes.map((reference) => reference.id),
    )

    const durableRetry = await repository.applyCommands({ projectKey, batch })
    assert.equal(durableRetry.ok && durableRetry.value.idempotent, true)
    assert.deepEqual(durableRetry.ok ? durableRetry.value.snapshot : null, controller.getState().session?.snapshot)

    const reopenedController = createWorldEditorController(createWorldProjectService(repository))
    assert.equal((await reopenedController.openProject(projectKey)).ok, true)
    assert.deepEqual(reopenedController.getState().session?.snapshot, controller.getState().session?.snapshot)
    assert.equal(reopenedController.getState().session?.snapshot.project.resources.length, 1)
    assert.equal(reopenedController.getState().session?.snapshot.scenes.find((scene) => scene.sceneId === state.activeSceneId)?.entities.length, 1)
    assert.deepEqual(
      reopenedController.getState().session?.snapshot.scenes.map((scene) => scene.sceneId),
      reopenedController.getState().session?.snapshot.project.scenes.map((reference) => reference.id),
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('fresh repository composition shares opaque observations through human AI creation Apply Undo Redo and durable multiscene reopen', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'modly-world-ai-creation-integration-'))
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }))
  await mkdir(path.join(workspaceRoot, 'Workflows'))
  const positions = Buffer.alloc(36); positions.writeFloatLE(1, 12); positions.writeFloatLE(1, 28)
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] }))
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)])
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + 36, 8)
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  const bin = Buffer.alloc(8); bin.writeUInt32LE(36); bin.writeUInt32LE(0x004e4942, 4)
  await writeFile(path.join(workspaceRoot, 'Workflows/triangle.glb'), Buffer.concat([header, padded, bin, positions]))
  const projectKey = `world-${'d'.repeat(32)}`
  let repositories = 0; let compilations = 0; let disposal: Promise<unknown> | null = null
  const fresh = () => { repositories += 1; return new WorldProjectRepository({ getWorkspaceRoot: () => workspaceRoot, createProjectKey: () => projectKey, syncDirectory: () => true }) }
  const api: WorldProjectsApi = {
    create: (request) => fresh().create(request), list: () => fresh().list(), open: (request) => fresh().open(request),
    previewCommands: (request) => fresh().previewCommands(request), applyCommands: (request) => fresh().applyCommands(request), delete: (request) => fresh().delete(request),
    previewAi: (request) => { compilations += 1; return fresh().previewAi(request) },
    discardAi: (request) => { const result = fresh().discardAi(request); disposal = result; return result },
  }
  const controller = createWorldEditorController(createWorldProjectService(api))
  assert.ok((await controller.createProject({ name: 'AI creation', initialSceneName: 'First' })).ok)
  const before = structuredClone(controller.getState().session!.snapshot)
  const adapter = createWorldAiChatAdapter(createWorldEditorCommandPort(controller), () => true)
  t.after(() => adapter.dispose())
  const turn = adapter.begin({ originSessionId: 'session-real-creation', requestId: 'tx:real-creation', isCurrent: () => true })
  const observed = await fresh().queryAi({ context: turn.context, query: { kind: 'resources', source: 'workflows' } })
  assert.ok(observed.ok && observed.value.items[0].kind === 'resource')
  assert.doesNotMatch(JSON.stringify(observed.value), /Workflows|workspacePath|modly-workspace|Object3D|[\\/]/)
  const sceneRef = { kind: 'local', localRef: 'stage' }; const entityRef = { kind: 'local', localRef: 'triangle' }
  const commands = [
    { type: 'create-scene', localRef: 'stage', name: 'Stage' },
    { type: 'create-entity', kind: 'group', sceneRef, localRef: 'actors', name: 'Actors' },
    { type: 'create-entity', kind: 'observed-model', sceneRef, localRef: 'triangle', name: 'Triangle', resourceHandle: observed.value.items[0].id, parentRef: { kind: 'local', localRef: 'actors' }, transform: { position: [2, 3, 4], rotation: [0, 0.2, 0], scale: [1, 2, 1] } },
    { type: 'create-entity', kind: 'camera', sceneRef, localRef: 'shot', name: 'Shot' },
    { type: 'create-entity', kind: 'light', sceneRef, localRef: 'key', name: 'Key', light: { lightKind: 'directional', intensity: 2 } },
    { type: 'configure-collider', sceneRef, entityRef, collider: { shape: 'box' } },
    { type: 'configure-body', sceneRef, entityRef, body: { bodyType: 'dynamic' } },
    { type: 'reparent', sceneRef, entityRef, parentRef: null },
  ]
  await adapter.accept(turn, JSON.parse(JSON.stringify({ message: 'Review Stage', actions: [], proposals: [], worldProposals: [{ type: 'world_command_proposal', context: turn.context, commands }] })))
  assert.equal(adapter.getState().status, 'ready')
  const exact = structuredClone(adapter.getState().preview!.batch)
  assert.deepEqual(controller.getState().session!.snapshot, before)
  assert.equal(compilations, 1)
  await adapter.apply()
  assert.equal(adapter.getState().status, 'applied')
  assert.equal(compilations, 1, 'Human Apply must not compile or allocate IDs again')
  const after = structuredClone(controller.getState().session!.snapshot)
  assert.equal(after.project.revision, 1); assert.equal(after.scenes.length, 2)
  assert.equal(controller.getState().activeSceneId, before.project.startSceneId)
  assert.equal(after.project.startSceneId, before.project.startSceneId)
  const reopened = await fresh().open({ projectKey })
  assert.ok(reopened.ok && reopened.value.status === 'ready'); assert.deepEqual(reopened.value.snapshot, after)
  const state = JSON.parse(await readFile(path.join(workspaceRoot, 'Worlds', projectKey, '.modly/state.v1.json'), 'utf8'))
  assert.equal(state.transactions[0].canonicalPayload, JSON.stringify(JSON.parse(state.transactions[0].canonicalPayload)))
  assert.deepEqual(JSON.parse(state.transactions[0].canonicalPayload), exact)
  await adapter.undo(); assert.equal(controller.getState().session!.snapshot.scenes.length, 1)
  assert.ok((await controller.redo()).ok)
  const redone = structuredClone(controller.getState().session!.snapshot)
  assert.deepEqual({ ...redone.project, revision: after.project.revision }, after.project)
  assert.deepEqual(redone.scenes, after.scenes)
  const durable = await fresh().open({ projectKey }); assert.ok(durable.ok && durable.value.status === 'ready'); assert.deepEqual(durable.value.snapshot, redone)
  const reject = adapter.begin({ originSessionId: 'session-real-creation', requestId: 'tx:real-reject', isCurrent: () => true })
  await fresh().queryAi({ context: reject.context, query: { kind: 'entities' } })
  await adapter.accept(reject, { message: 'Review', actions: [], proposals: [], worldProposals: [{ type: 'world_command_proposal', context: reject.context,
    commands: [{ type: 'create-entity', kind: 'group', localRef: 'unused', sceneRef: { kind: 'existing', id: reject.context.activeSceneId }, name: 'Unused' }] }] })
  assert.equal(adapter.getState().status, 'ready'); adapter.reject(); await disposal
  assert.deepEqual(controller.getState().session!.snapshot, redone)
  assert.ok(repositories >= 8, 'Separate real repositories must share only context-qualified source authority')
})

test('closing AI after journal irreversibility reports the completed edit and keeps canonical Undo', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'modly-ai-after-journal-'))
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }))
  const projectKey = `world-${'e'.repeat(32)}`
  let armed = false; let release!: () => void; let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve }); const started = new Promise<void>((resolve) => { entered = resolve })
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspaceRoot, createProjectKey: () => projectKey, syncDirectory: () => true,
    failureCheckpoint: async (stage) => { if (armed && stage === 'journal-published') { entered(); await gate } } })
  const controller = createWorldEditorController(createWorldProjectService(repository))
  assert.ok((await controller.createProject({ name: 'Irreversibility', initialSceneName: 'First' })).ok)
  const adapter = createWorldAiChatAdapter(createWorldEditorCommandPort(controller), () => true); t.after(() => adapter.dispose())
  const turn = adapter.begin({ originSessionId: 'session-after-journal', requestId: 'tx:after-journal', isCurrent: () => true })
  assert.ok((await repository.queryAi({ context: turn.context, query: { kind: 'project' } })).ok)
  await adapter.accept(turn, { message: 'Review', actions: [], proposals: [], worldProposals: [{ type: 'world_command_proposal', context: turn.context,
    commands: [{ type: 'create-entity', kind: 'group', localRef: 'group', sceneRef: { kind: 'existing', id: turn.context.activeSceneId }, name: 'Group' }] }] })
  assert.equal(adapter.getState().status, 'ready')
  armed = true; const pending = adapter.apply()
  try {
    await Promise.race([started, pending.then(() => { throw new Error('Apply ended before journal checkpoint') })])
    adapter.cancel(); release(); await pending
    assert.equal(controller.getState().session!.snapshot.project.revision, 1)
    assert.equal(adapter.getState().status, 'applied', 'After irreversibility, closing the drawer must not hide the completed edit as a cancelled request')
    armed = false
    await adapter.undo()
    assert.equal(controller.getState().session!.snapshot.scenes[0].entities.length, 0)
  } finally { release(); armed = false }
})

test('real repository applies character companions in one revision and Undo/Redo/reopen preserve the full document', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'modly-world-character-integration-'))
  const projectKey = `world-${'b'.repeat(32)}`
  const repository = new WorldProjectRepository({
    getWorkspaceRoot: () => workspaceRoot, createProjectKey: () => projectKey,
    createSceneKey: () => `scene-${'c'.repeat(32)}`,
    now: () => new Date('2026-09-06T12:00:00.000Z'), syncDirectory: () => true,
  })
  try {
    const controller = createWorldEditorController(createWorldProjectService(repository))
    assert.equal((await controller.createProject({ name: 'Character QA', initialSceneName: 'Scene 1' })).ok, true)
    const builderContext = () => {
      const state = controller.getState()
      assert.ok(state.session && state.activeSceneId)
      return { snapshot: state.session.snapshot, activeSceneId: state.activeSceneId, projectKey, identities: createDeterministicWorldEditorIdentityGenerator('character-repository') }
    }
    const empty = buildAddEmptyEntityCommands(builderContext(), { name: 'Player' })
    assert.equal((await controller.dispatchCommands({ transactionId: 'tx:player', origin: 'ui', commands: empty })).ok, true)
    const before = structuredClone(builderContext().snapshot)
    const historyBefore = controller.getState().session!.undoStack.length
    const commands = buildCharacterControllerPresetCommands(builderContext(), empty[0].entity.id)
    const batch: WorldCommandBatchV1 = {
      schema: 'modly.world-command-batch.v1', transactionId: 'tx:character', origin: 'ui',
      projectId: before.project.projectId, baseRevision: before.project.revision, commands,
    }
    assert.equal((await controller.dispatchCommands({ transactionId: batch.transactionId, origin: 'ui', commands })).ok, true)
    const authored = structuredClone(builderContext().snapshot)
    assert.equal(authored.project.revision, before.project.revision + 1)
    assert.equal(controller.getState().session!.undoStack.length, historyBefore + 1)
    assert.equal(authored.project.inputActions.length, before.project.inputActions.length + 2)
    assert.equal(authored.scenes[0].entities[0].components.length, 3)
    const retry = await repository.applyCommands({ projectKey, batch })
    assert.equal(retry.ok && retry.value.idempotent, true)
    assert.deepEqual(retry.ok ? retry.value.snapshot : null, authored)

    const assertReopened = async () => {
      const reopened = createWorldEditorController(createWorldProjectService(repository))
      assert.equal((await reopened.openProject(projectKey)).ok, true)
      assert.deepEqual(reopened.getState().session?.snapshot, builderContext().snapshot)
      await reopened.closeProject()
    }
    await assertReopened()
    assert.equal((await controller.undo()).ok, true)
    const undone = builderContext().snapshot
    assert.deepEqual(undone, { ...before, project: { ...before.project, revision: authored.project.revision + 1 } })
    await assertReopened()
    assert.equal((await controller.redo()).ok, true)
    assert.deepEqual(builderContext().snapshot, { ...authored, project: { ...authored.project, revision: authored.project.revision + 2 } })
    await assertReopened()
    await controller.closeProject()
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
