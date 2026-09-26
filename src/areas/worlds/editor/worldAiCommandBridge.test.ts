import assert from 'node:assert/strict'
import test from 'node:test'

import { applyWorldCommandBatch } from '../core/worldCommands.ts'
import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import type { WorldProjectsApi, WorldProjectCommandRequest } from '../../../shared/types/worldProjects.ts'
import { createWorldEditorController } from './worldEditorController.ts'
import { createWorldEditorCommandPort } from './worldEditorCommandPort.ts'
import { createWorldAiCommandBridge } from './worldAiCommandBridge.ts'
import type { WorldEditorProposalGuard } from './worldEditorController.ts'

const projectKey = `world-${'c'.repeat(32)}`

function createAuthority(initial = createValidWorldSnapshot()) {
  let snapshot = structuredClone(initial)
  let previews = 0
  let writes = 0
  const api: WorldProjectsApi = {
    async create() { throw new Error('unused') },
    async list() { return { ok: true, value: { projects: [], issues: [] } } },
    async open() { return { ok: true, value: { status: 'ready', projectKey, snapshot: structuredClone(snapshot), durabilityWarnings: [] } } },
    async previewCommands(request) { previews += 1; return result(request, false) },
    async applyCommands(request) { return result(request, true) },
    async delete() { throw new Error('unused') },
  }
  function result(request: WorldProjectCommandRequest, persist: boolean) {
    const applied = applyWorldCommandBatch(snapshot, request.batch)
    if (!applied.success) return { ok: false as const, error: { code: 'revision_conflict' as const, message: 'conflict', retryable: false } }
    if (persist) { snapshot = structuredClone(applied.snapshot); writes += 1 }
    return { ok: true as const, value: {
      projectKey, snapshot: structuredClone(applied.snapshot), newRevision: applied.snapshot.project.revision, idempotent: false,
      changes: applied.changes, warnings: applied.warnings, inverse: structuredClone(applied.inverse),
      receipt: { transactionId: request.batch.transactionId, payloadSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), appliedRevision: applied.snapshot.project.revision },
    } }
  }
  const controller = createWorldEditorController(api)
  const port = createWorldEditorCommandPort(controller)
  const guard = (requestId: string): WorldEditorProposalGuard => {
    const active = port.getActiveContext()
    assert.ok(active)
    return { context: { schema: 'modly.world-ai-context.v1', projectKey, projectId: active.projectId,
      baseRevision: active.baseRevision, activeSceneId: active.activeSceneId, editorEpoch: controller.getState().editorEpoch,
      originSessionId: 'session-review', requestId }, isCurrent: () => true }
  }
  return { controller, guard, previews: () => previews, writes: () => writes,
    bridge: createWorldAiCommandBridge(port, { maxProposals: 2, maxPageSize: 2 }) }
}

test('AI queries are bounded, paginated, deterministic and omit paths, URLs and mutable authority', async () => {
  const { controller, bridge } = createAuthority()
  await controller.openProject(projectKey)
  const scenes = bridge.query({ kind: 'scenes', pageSize: 99 })
  assert.equal(scenes.ok, true)
  if (!scenes.ok) return
  assert.equal(scenes.value.items.length, 2)
  const serialized = JSON.stringify(scenes.value)
  assert.doesNotMatch(serialized, /workspacePath|computedUrl|Object3D|setState|setSnapshot|filesystem/i)
  const entities = bridge.query({ kind: 'entities', sceneId: 'scene:one', pageSize: 1 })
  assert.equal(entities.ok, true)
  if (entities.ok) assert.equal(entities.value.items.length, 1)
  assert.equal(Object.isFrozen(scenes.value), true)
  assert.equal(Reflect.set(scenes.value.items[0] as object, 'name', 'Mutated'), false)
})

test('finite creation cannot fall back to a renderer batch when host preview authority is unavailable', async () => {
  const f = createAuthority()
  await f.controller.openProject(projectKey)
  const guard = f.guard('tx:host-required')
  const proposal = { type: 'world_command_proposal' as const, context: guard.context, commands: [{ type: 'create-entity' as const,
    kind: 'group' as const, localRef: 'group', sceneRef: { kind: 'existing' as const, id: 'scene:one' }, name: 'Group' }] }
  const before = structuredClone(f.controller.getState().session!.snapshot)
  const result = await f.bridge.propose({ transactionId: guard.context.requestId, commands: [], proposal, guard })
  assert.ok(!result.ok && result.error.code === 'invalid_command')
  assert.equal(f.previews(), 0); assert.equal(f.writes(), 0)
  assert.deepEqual(f.controller.getState().session!.snapshot, before)
})

test('AI propose dry-runs without mutation, applies exact batch, supports reject and undo', async () => {
  const { controller, bridge } = createAuthority()
  await controller.openProject(projectKey)
  const before = controller.getState().session?.snapshot.project.revision
  const proposed = await bridge.propose({ transactionId: 'tx:ai-one', commands: [{ type: 'rename-project', name: 'AI' }] })
  assert.equal(proposed.ok, true)
  assert.equal(controller.getState().session?.snapshot.project.revision, before)
  if (!proposed.ok) return
  assert.match(proposed.value.fingerprint, /^fnv1a32:/)
  assert.equal(Object.isFrozen(proposed.value), true)
  const applied = await bridge.apply(proposed.value.handle)
  assert.equal(applied.ok, true)
  assert.equal(controller.getState().session?.snapshot.project.name, 'AI')
  assert.equal((await bridge.undo()).ok, true)
  assert.equal(controller.getState().session?.snapshot.project.name, 'Demo world')

  const rejected = await bridge.propose({ transactionId: 'tx:ai-reject', commands: [{ type: 'rename-project', name: 'Rejected' }] })
  assert.equal(rejected.ok, true)
  if (rejected.ok) {
    assert.equal(bridge.reject(rejected.value.handle).ok, true)
    assert.equal((await bridge.apply(rejected.value.handle)).ok, false)
  }
})

test('AI stale proposals reject and bounded ledger evicts the oldest proposal', async () => {
  const { controller, bridge } = createAuthority()
  await controller.openProject(projectKey)
  const first = await bridge.propose({ transactionId: 'tx:ai-first', commands: [{ type: 'rename-project', name: 'First' }] })
  const second = await bridge.propose({ transactionId: 'tx:ai-second', commands: [{ type: 'rename-project', name: 'Second' }] })
  const third = await bridge.propose({ transactionId: 'tx:ai-third', commands: [{ type: 'rename-project', name: 'Third' }] })
  assert.equal(first.ok && second.ok && third.ok, true)
  if (!first.ok || !second.ok || !third.ok) return
  assert.equal((await bridge.apply(first.value.handle)).ok, false)
  await controller.dispatchCommands({ transactionId: 'tx:human-after-preview', origin: 'ui', commands: [{ type: 'rename-project', name: 'Human' }] })
  const stale = await bridge.apply(third.value.handle)
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'revision_conflict')
})

test('guarded review rejects a name change reverted by the same canonical batch before remote preview', async () => {
  const f = createAuthority()
  await f.controller.openProject(projectKey)
  const before = f.controller.getState().session?.snapshot
  const guard = f.guard('tx:name-revert')
  const proposed = await f.bridge.propose({ transactionId: guard.context.requestId, guard,
    commands: ['Renamed', 'Hero'].map((name) => ({ type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { name } })) })
  assert.equal(proposed.ok, false, 'A net no-op must not create an actionable human preview')
  if (!proposed.ok) assert.equal(proposed.error.code, 'invalid_command')
  assert.equal(f.previews(), 0)
  assert.equal(f.writes(), 0)
  assert.deepEqual(f.controller.getState().session?.snapshot, before)
})

test('guarded review shows only final canonical transform values across sequential full replacements', async () => {
  const f = createAuthority()
  await f.controller.openProject(projectKey)
  const guard = f.guard('tx:transform-overwrite')
  const proposed = await f.bridge.propose({ transactionId: guard.context.requestId, guard, commands: [
    { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { transform: { position: [7, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } } },
    { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { transform: { position: [0, 0, 0], rotation: [0, 1, 0], scale: [2, 2, 2] } } },
  ] })
  assert.equal(proposed.ok, true)
  if (!proposed.ok) return
  assert.deepEqual(proposed.value.details.map(({ property, before, after }) => ({ property, before, after })), [
    { property: 'rotation', before: '[0,0,0]', after: '[0,1,0]' },
    { property: 'scale', before: '[1,1,1]', after: '[2,2,2]' },
  ])
  assert.equal(f.writes(), 0)
  assert.equal((await f.bridge.apply(proposed.value.handle)).ok, true)
  assert.deepEqual(f.controller.getState().session?.snapshot.scenes[0].entities[0].transform,
    { position: [0, 0, 0], rotation: [0, 1, 0], scale: [2, 2, 2] })
})

test('guarded review matches final full light replacement and preserves every unrelated light field', async () => {
  const snapshot = createValidWorldSnapshot()
  const light = { id: 'light:key', type: 'light' as const, lightKind: 'spot' as const, enabled: true,
    color: '#ffffff' as const, intensity: 1, range: 13, angle: 0.7, castShadow: true }
  snapshot.scenes[0].entities[0].components.push(light)
  const f = createAuthority(snapshot)
  await f.controller.openProject(projectKey)
  const guard = f.guard('tx:light-overwrite')
  const proposed = await f.bridge.propose({ transactionId: guard.context.requestId, guard,
    commands: [{ ...light, color: '#ff0000' as const }, { ...light, intensity: 3 }].map((component) => ({
      type: 'replace-component', sceneId: 'scene:one', entityId: 'entity:hero', componentId: light.id, component,
    })) })
  assert.equal(proposed.ok, true)
  if (!proposed.ok) return
  assert.deepEqual(proposed.value.details.map(({ property, before, after }) => ({ property, before, after })),
    [{ property: 'light:key.intensity', before: '1', after: '3' }])
  assert.equal(f.writes(), 0)
  assert.equal((await f.bridge.apply(proposed.value.handle)).ok, true)
  assert.deepEqual(f.controller.getState().session?.snapshot.scenes[0].entities[0].components.find((component) => component.id === light.id), { ...light, intensity: 3 })
})
