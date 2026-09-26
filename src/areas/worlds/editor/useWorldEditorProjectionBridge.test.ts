import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import type { WorldProjectsApi, WorldProjectCommandRequest } from '../../../shared/types/worldProjects.ts'
import { applyWorldCommandBatch } from '../core/worldCommands.ts'
import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import { createRuntimeWorldSnapshot } from '../runtime/_testFixtures.ts'
import { createWorldPlayController } from '../runtime/worldPlayController.ts'
import type { WorldPhysicsRuntimeHandlers } from '../runtime/worldPhysicsRuntime.ts'
import {
  createWorldEditorViewportCommitAuthority,
  createWorldWorkspaceUrl,
  commitWorldProjectionTransforms,
  projectWorldEditorViewport,
  runWorldEditorViewportCommit,
  shouldSynchronizeLegacyWorldProjection,
} from './useWorldEditorProjectionBridge.ts'
import { createWorldEditorController } from './worldEditorController.ts'
import { createWorldEditorTransformAdmission } from './worldEditorTransformAdmission.ts'

const projectKey = `world-${'b'.repeat(32)}`

test('workspace URL leaf preserves base trimming and trailing slash removal', async () => {
  const leaf = await import('../worldWorkspaceUrl.ts')
  for (const [base, expected] of [
    ['  https://api.example.test/// \n', 'https://api.example.test/workspace/Assets/mesh.glb'],
    ['\t../api//  ', '../api/workspace/Assets/mesh.glb'],
    ['https://host.test/path?query=yes#fragment/', 'https://host.test/path?query=yes#fragment/workspace/Assets/mesh.glb'],
    ['///', '/workspace/Assets/mesh.glb'],
  ]) assert.equal(leaf.createWorldWorkspaceUrl(base, 'Assets/mesh.glb'), expected)
})

test('workspace URL leaf preserves Unicode reserved characters and percent double encoding', async () => {
  const leaf = await import('../worldWorkspaceUrl.ts')
  for (const [path, encoded] of [
    ['Assets/café/雪😀.glb', 'Assets/caf%C3%A9/%E9%9B%AA%F0%9F%98%80.glb'],
    ['a b?#[]@:$&+,;=.glb', 'a%20b%3F%23%5B%5D%40%3A%24%26%2B%2C%3B%3D.glb'],
    ["!'()*", "!'()*"],
    ['a%20b/%2F/%', 'a%2520b/%252F/%25'],
    ['a\\b\t\n', 'a%5Cb%09%0A'],
  ]) assert.equal(leaf.createWorldWorkspaceUrl('', path), `/workspace/${encoded}`)
})

test('workspace URL leaf preserves empty repeated leading and dot path segments', async () => {
  const leaf = await import('../worldWorkspaceUrl.ts')
  for (const [path, expected] of [
    ['', '/workspace/'],
    ['/', '/workspace//'],
    ['/absolute', '/workspace//absolute'],
    ['//Assets///mesh.glb//', '/workspace///Assets///mesh.glb//'],
    ['a/.././b', '/workspace/a/.././b'],
    [' ./../file ', '/workspace/%20./../file%20'],
  ]) assert.equal(leaf.createWorldWorkspaceUrl('', path), expected)
})

test('workspace URL leaf preserves native malformed surrogate behavior', async () => {
  const leaf = await import('../worldWorkspaceUrl.ts')
  for (const path of ['\uD800', '\uDC00', 'Assets/\uD800.glb']) {
    assert.throws(() => leaf.createWorldWorkspaceUrl('', path), URIError)
  }
  assert.equal(leaf.createWorldWorkspaceUrl('\uD800/', 'a'), '\uD800/workspace/a')
})

test('workspace URL leaf has no runtime dependencies', async () => {
  const source = await readFile(new URL('../worldWorkspaceUrl.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(?:import|require)\b|\bexport\s+(?:\*|\{)/)
  const leaf = await import('../worldWorkspaceUrl.ts')
  assert.deepEqual(Object.keys(leaf), ['createWorldWorkspaceUrl'])
})

test('runtime geometry imports workspace URLs directly from the pure leaf', async () => {
  const source = await readFile(new URL('../runtime/worldGeometryPreparation.ts', import.meta.url), 'utf8')
  assert.match(source, /^import \{ createWorldWorkspaceUrl \} from '\.\.\/worldWorkspaceUrl\.ts'$/m)
  assert.doesNotMatch(source, /useWorldEditorProjectionBridge/)
})

test('editor projection bridge re-exports the identical workspace URL leaf binding', async () => {
  const leaf = await import('../worldWorkspaceUrl.ts')
  assert.strictEqual(createWorldWorkspaceUrl, leaf.createWorldWorkspaceUrl)
  const source = await readFile(new URL('./useWorldEditorProjectionBridge.ts', import.meta.url), 'utf8')
  assert.match(source, /^import \{ createWorldWorkspaceUrl \} from '\.\.\/worldWorkspaceUrl\.ts'$/m)
  assert.match(source, /^export \{ createWorldWorkspaceUrl \} from '\.\.\/worldWorkspaceUrl\.ts'$/m)
})

function snapshot(): WorldProjectSnapshotV1 {
  return {
    project: {
      schema: 'modly.world-project.v1', projectId: 'project:bridge', name: 'Bridge', revision: 2,
      resources: [{ id: 'resource:model', type: 'model', name: 'Ship', workspacePath: 'Exports/ship.glb', format: 'glb' }],
      scenes: [{ id: 'scene:bridge', name: 'Bridge', documentPath: 'Worlds/world-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/scenes/scene-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.world-scene.json' }],
      startSceneId: 'scene:bridge', inputActions: [],
      graphicsProfiles: [{ id: 'graphics:one', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'msaa' }], activeGraphicsProfileId: 'graphics:one',
    },
    scenes: [{
      schema: 'modly.world-scene.v1', projectId: 'project:bridge', sceneId: 'scene:bridge', name: 'Bridge',
      environment: { backgroundColor: '#123456', ambientIntensity: 0.8 }, sequences: [],
      entities: [{
        id: 'entity:ship', name: 'Ship', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{
          id: 'component:renderable', type: 'renderable', enabled: true, resourceId: 'resource:model', visible: true,
          castShadow: false, receiveShadow: true, material: { baseColor: '#abcdef', metallic: 0.6, roughness: 0.25, opacity: 0.75 },
        }],
      }, {
        id: 'entity:light', name: 'Key', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [4, 5, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ id: 'component:light', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 3, range: 12, castShadow: true }],
      }],
    }],
  }
}

function createProjectionEditorController(initialSnapshot: WorldProjectSnapshotV1 = snapshot()) {
  let persisted = structuredClone(initialSnapshot)
  const requests: WorldProjectCommandRequest[] = []
  const api: WorldProjectsApi = {
    async create() {
      return { ok: true, value: { projectKey, snapshot: structuredClone(persisted), durabilityWarnings: [] } }
    },
    async list() {
      return {
        ok: true,
        value: {
          projects: [{
            projectKey,
            status: 'ready',
            projectId: persisted.project.projectId,
            name: persisted.project.name,
            revision: persisted.project.revision,
          }],
          issues: [],
        },
      }
    },
    async open() {
      return { ok: true, value: { status: 'ready', projectKey, snapshot: structuredClone(persisted), durabilityWarnings: [] } }
    },
    async previewCommands(request) {
      return applyRequest(request, false)
    },
    async applyCommands(request) {
      requests.push(structuredClone(request))
      return applyRequest(request, true)
    },
    async delete(request) {
      return { ok: true, value: { projectKey, transactionId: request.transactionId, idempotent: false } }
    },
  }
  function applyRequest(request: WorldProjectCommandRequest, persist: boolean) {
    const applied = applyWorldCommandBatch(persisted, request.batch)
    if (!applied.success) {
      return { ok: false as const, error: { code: 'invalid_request' as const, message: 'rejected', retryable: false } }
    }
    if (persist) persisted = structuredClone(applied.snapshot)
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
        receipt: {
          transactionId: request.batch.transactionId,
          payloadSha256: 'a'.repeat(64),
          resultSha256: 'b'.repeat(64),
          appliedRevision: applied.snapshot.project.revision,
        },
      },
    }
  }
  return { controller: createWorldEditorController(api), requests }
}

test('projection carries renderer-only URL, authored environment, PBR, shadows and authored lights', () => {
  const result = projectWorldEditorViewport(snapshot(), 'scene:bridge', 'http://127.0.0.1:8000')
  assert.equal(result.success, true)
  if (!result.success) return
  assert.equal(result.value.items[0]?.url, 'http://127.0.0.1:8000/workspace/Exports/ship.glb')
  assert.deepEqual(result.value.items[0]?.material, { baseColor: '#abcdef', metallic: 0.6, roughness: 0.25, opacity: 0.75 })
  assert.equal(result.value.items[0]?.castShadow, false)
  assert.equal(result.value.environment.backgroundColor, '#123456')
  assert.equal(result.value.lights.length, 1)
  assert.equal(result.value.useStudioLights, false)

  const noLights = structuredClone(snapshot())
  noLights.scenes[0].entities = noLights.scenes[0].entities.filter((entity) => entity.id !== 'entity:light')
  const fallback = projectWorldEditorViewport(noLights, 'scene:bridge', '')
  assert.equal(fallback.success && fallback.value.useStudioLights, true)
})

test('transform projection commit dispatches exactly one atomic batch and rolls projection back on failure', async () => {
  let dispatches = 0
  let rollbacks = 0
  const context = {
    snapshot: snapshot(), projectKey: 'world-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', projectId: 'project:bridge', baseRevision: 2, activeSceneId: 'scene:bridge',
  }
  const failed = await commitWorldProjectionTransforms({
    context,
    updates: [{ entityId: 'entity:ship', transform: { position: [9, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
    transactionId: 'tx:bridge-fail',
    dispatch: async (request, authority) => {
      dispatches += 1
      assert.equal(request.commands.length, 1)
      assert.equal(authority.baseRevision, 2)
      return { ok: false as const, error: { code: 'revision_conflict' as const, message: 'Conflict', retryable: false } }
    },
    rollback: () => { rollbacks += 1 },
  })
  assert.equal(failed.ok, false)
  assert.equal(dispatches, 1)
  assert.equal(rollbacks, 1)

  const passed = await commitWorldProjectionTransforms({
    context,
    updates: [{ entityId: 'entity:ship', transform: { position: [8, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
    transactionId: 'tx:bridge-pass',
    dispatch: async () => {
      dispatches += 1
      return { ok: true as const, value: { transactionId: 'tx:bridge-pass', revision: 3, idempotent: false, changes: [], warnings: [], receipt: { transactionId: 'tx:bridge-pass', payloadSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), appliedRevision: 3 } } }
    },
    rollback: () => { rollbacks += 1 },
  })
  assert.equal(passed.ok, true)
  assert.equal(dispatches, 2)
  assert.equal(rollbacks, 1)
})

test('a closed canonical session never clears a preserved legacy scene projection', () => {
  assert.equal(shouldSynchronizeLegacyWorldProjection(null), false)
  const projected = projectWorldEditorViewport(snapshot(), 'scene:bridge', '')
  assert.equal(projected.success && shouldSynchronizeLegacyWorldProjection(projected.value), true)
})

test('Play intent revokes stale viewport transform callbacks before click without changing the authored snapshot', async () => {
  const authority = createWorldEditorViewportCommitAuthority()
  const editLease = authority.issue()
  const gateway = createProjectionEditorController(createRuntimeWorldSnapshot())
  assert.equal((await gateway.controller.openProject(projectKey)).ok, true)
  const initialState = gateway.controller.getState()
  const initialSession = initialState.session
  assert.ok(initialSession)
  const authoredSnapshot = initialSession.snapshot
  const authoredIdentity = authoredSnapshot
  const authoredContent = structuredClone(authoredSnapshot)
  const authoredRevision = authoredSnapshot.project.revision
  const physics = { handlers: null as WorldPhysicsRuntimeHandlers | null }
  const playController = createWorldPlayController({
    createPhysics(_generationId, handlers) {
      physics.handlers = handlers
      return {
        async initialize() {},
        step() {},
        pause() {},
        resume() {},
        dispose() {},
      }
    },
    createAudio() {
      return {
        async prepareScene() {},
        async activate() {},
        async play() {},
        async stopSource() {},
        update() {},
        async pause() {},
        async resume() {},
        async stop() {},
      }
    },
  })

  const callbackCapturedByEditorViewport = (positionY: number) => runWorldEditorViewportCommit(
    authority,
    editLease,
    () => commitWorldProjectionTransforms({
      context: {
        snapshot: authoredSnapshot,
        projectKey,
        projectId: authoredSnapshot.project.projectId,
        baseRevision: authoredRevision,
        activeSceneId: 'scene:one',
      },
      updates: [{
        entityId: 'entity:crate',
        transform: { position: [2, positionY, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }],
      transactionId: 'tx:stale-editor-viewport',
      dispatch: (request, expectedAuthority) => gateway.controller.dispatchCommands(request, expectedAuthority),
      rollback: () => undefined,
    }),
  )

  // Play pointer-down precedes the global mouse-up that can reach a stale TransformControls callback.
  authority.revoke()
  assert.equal((await playController.start(initialSession, 'scene:one')).success, true)
  assert.equal(playController.getState().lifecycle, 'playing')
  assert.notStrictEqual(playController.getState().runtimeSnapshot, authoredSnapshot)
  const physicsHandlers = physics.handlers
  assert.ok(physicsHandlers)
  physicsHandlers.onSnapshot({
    generationId: playController.getState().generationId,
    sequence: 1,
    entityIds: ['entity:crate'],
    transforms: new Float32Array([2, 0.5200240187626927, 0, 0, 0, 0, 1]),
    triggerEvents: [],
  })
  assert.equal(
    playController.getState().bodyPoses.find((pose) => pose.entityId === 'entity:crate')?.position[1],
    Math.fround(0.5200240187626927),
  )
  const beforePlayClick = await callbackCapturedByEditorViewport(0.5200240187626927)
  assert.equal(beforePlayClick, undefined)
  assert.equal(gateway.requests.length, 0)
  assert.strictEqual(gateway.controller.getState(), initialState)
  assert.strictEqual(gateway.controller.getState().session, initialSession)
  assert.strictEqual(authoredSnapshot, authoredIdentity)
  assert.equal(authoredSnapshot.project.revision, authoredRevision)
  assert.deepEqual(authoredSnapshot, authoredContent)
  assert.equal(gateway.controller.getState().session?.undoStack.length, 0)

  assert.equal((await playController.pause()).success, true)
  assert.equal(playController.getState().lifecycle, 'paused')
  assert.equal((await playController.resume()).success, true)
  assert.equal(playController.getState().lifecycle, 'playing')
  assert.equal((await playController.stop()).success, true)
  assert.equal(playController.getState().lifecycle, 'edit')
  assert.strictEqual(playController.getState().editor, initialSession)

  // Stop must not re-authorize the unmounted viewport callback.
  const afterStop = await callbackCapturedByEditorViewport(0.5200240187626927)
  assert.equal(afterStop, undefined)
  assert.equal(gateway.requests.length, 0)
  assert.strictEqual(gateway.controller.getState(), initialState)
  assert.strictEqual(gateway.controller.getState().session, initialSession)
  assert.strictEqual(authoredSnapshot, authoredIdentity)
  assert.equal(authoredSnapshot.project.revision, authoredRevision)
  assert.deepEqual(authoredSnapshot, authoredContent)
  assert.equal(gateway.controller.getState().session?.undoStack.length, 0)

  const remountedEditLease = authority.issue()
  const callbackCapturedByRemountedViewport = (positionY: number) => runWorldEditorViewportCommit(
    authority,
    remountedEditLease,
    () => commitWorldProjectionTransforms({
      context: {
        snapshot: authoredSnapshot,
        projectKey,
        projectId: authoredSnapshot.project.projectId,
        baseRevision: authoredRevision,
        activeSceneId: 'scene:one',
      },
      updates: [{
        entityId: 'entity:crate',
        transform: { position: [2, positionY, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }],
      transactionId: 'tx:current-editor-viewport',
      dispatch: (request, expectedAuthority) => gateway.controller.dispatchCommands(request, expectedAuthority),
      rollback: () => undefined,
    }),
  )
  const currentEditCommit = await callbackCapturedByRemountedViewport(4)
  assert.equal(currentEditCommit?.ok, true)
  assert.equal(gateway.requests.length, 1)
  assert.equal(gateway.requests[0]?.batch.commands.length, 1)
  assert.equal(gateway.controller.getState().session?.snapshot.project.revision, authoredRevision + 1)
  assert.equal(
    gateway.controller.getState().session?.snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:crate')?.transform.position[1],
    4,
  )
  assert.equal(gateway.controller.getState().session?.undoStack.length, 1)
})

test('transform admission owner rejects shared overlap, preserves pending until finish and invalidates only active gestures', async () => {
  const lease = Object.freeze({ generation: 1 })
  const errors: string[] = []
  const pendingStates: boolean[] = []
  const admission = createWorldEditorTransformAdmission({
    getContext: () => ({ projectKey, activeSceneId: 'scene:bridge', snapshot: snapshot() }),
    getViewportLease: () => lease,
    isViewportCurrent: (candidate) => candidate === lease,
    onError: (message) => errors.push(message),
    onPendingChange: (pending) => pendingStates.push(pending),
  })

  const inspector = admission.begin('inspector', ['entity:ship'])
  assert.ok(inspector)
  assert.equal(admission.begin('viewport', ['entity:ship']), null)
  assert.deepEqual(errors, ['Wait for the current transform to finish.'])
  admission.invalidateActive()
  const viewport = admission.begin('viewport', ['entity:ship'])
  assert.ok(viewport)
  assert.equal(admission.release(viewport), true)
  admission.invalidateActive()
  assert.equal(admission.begin('inspector', ['entity:ship']), null)
  assert.equal(admission.pending, true)
  admission.finish(viewport)
  assert.equal(admission.pending, false)
  assert.deepEqual(pendingStates, [true, false])
  assert.notEqual(admission.begin('inspector', ['entity:ship']), null)
})
