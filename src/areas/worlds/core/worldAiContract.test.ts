import assert from 'node:assert/strict'
import test from 'node:test'
import { createValidWorldSnapshot } from './_testFixtures.ts'
import { describeWorldAiCandidate, parseWorldAiContext, parseWorldAiProposal, projectWorldAiQuery, validateWorldAiCommands, type WorldAiResourceRow } from './worldAiContract.ts'
import { applyWorldCommandBatch } from './worldCommands.ts'

const context = {
  schema: 'modly.world-ai-context.v1' as const, projectKey: `world-${'a'.repeat(32)}`,
  projectId: 'project:demo', baseRevision: 4, activeSceneId: 'scene:one', editorEpoch: 1,
  originSessionId: 'session-a', requestId: 'tx:world-ai-one',
}

test('World AI DTO rejects unknown authority, paths, coercion, oversized and unsupported commands', () => {
  assert.deepEqual(parseWorldAiContext(context), context)
  for (const bad of [{ ...context, extra: true }, { ...context, projectId: '/tmp/private' }, { ...context, baseRevision: '4' }]) {
    assert.throws(() => parseWorldAiContext(bad))
  }
  const command = { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { name: 'Hero two' } }
  const proposal = { type: 'world_command_proposal', context, commands: [command] }
  assert.deepEqual(parseWorldAiProposal(proposal).commands, [command])
  for (const commands of [[], Array(17).fill(command), [{ ...command, patch: { locked: false } }], [{ ...command, sceneId: 'scene:two' }], [{ type: 'rename-project', name: 'No' }]]) {
    assert.throws(() => parseWorldAiProposal({ ...proposal, commands }))
  }
  assert.throws(() => parseWorldAiProposal({ ...proposal, apply: true }))
})

test('AI creation C1 accepts finite same-batch scene, group, model, camera, light and physics recipes', () => {
  const sceneRef = { kind: 'local', localRef: 'stage' }
  const entityRef = { kind: 'local', localRef: 'hero' }
  const commands = [
    { type: 'create-scene', localRef: 'stage', name: 'Stage' },
    { type: 'create-entity', kind: 'group', localRef: 'group', sceneRef, name: 'Actors' },
    { type: 'create-entity', kind: 'observed-model', localRef: 'hero', sceneRef, parentRef: { kind: 'local', localRef: 'group' }, name: 'Hero', resourceHandle: 'asset_0123456789abcdef0123456789abcdef', material: { baseColor: '#224466', metallic: 0.2, roughness: 0.6, opacity: 1 } },
    { type: 'create-entity', kind: 'camera', localRef: 'camera', sceneRef, name: 'Shot', camera: { projection: 'perspective', near: 0.1, far: 500, fieldOfView: 50 } },
    { type: 'create-entity', kind: 'light', localRef: 'key', sceneRef, name: 'Key', light: { lightKind: 'spot', range: 20, angle: 0.4, intensity: 2, color: '#ffffff', castShadow: true } },
    { type: 'configure-collider', sceneRef, entityRef, localRef: 'hull', collider: { shape: 'capsule', radius: 0.4, halfHeight: 0.8, sensor: false } },
    { type: 'configure-body', sceneRef, entityRef, body: { bodyType: 'dynamic', linearDamping: 0.2 } },
    { type: 'reparent', sceneRef, entityRef, parentRef: null },
  ]
  const creationRecipeProposal = { type: 'world_command_proposal', context, commands }
  assert.doesNotThrow(() => assert.deepEqual(parseWorldAiProposal(JSON.parse(JSON.stringify(creationRecipeProposal))).commands, commands))
})

test('AI creation C2 projects opaque observed resource pages and rejects unsafe canonical prompt identity', () => {
  const snapshot = createValidWorldSnapshot()
  const rows = [{ kind: 'resource', id: 'asset_0123456789abcdef0123456789abcdef', name: 'Hero', source: 'project', format: 'glb', capability: 'mesh', fingerprint: 'a'.repeat(64), dependencyCount: 1 }] satisfies WorldAiResourceRow[]
  assert.doesNotThrow(() => {
    const page = projectWorldAiQuery(snapshot, { context, query: { kind: 'resources', source: 'project', pageSize: 1 } }, { resources: rows })
    assert.deepEqual(page.items, rows)
    assert.doesNotMatch(JSON.stringify(page), /Assets|workspacePath|resource:hero|modly-workspace/)
  })
  snapshot.scenes[0].entities[0].id = 'entity:unsafe\u0001'
  assert.throws(() => projectWorldAiQuery(snapshot, { context, query: { kind: 'entities' } }))
})

test('World AI two-page query is deterministic, context-bound, typed and path-free', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.name = '/home/private/project'
  snapshot.scenes[0].entities.push({ ...structuredClone(snapshot.scenes[0].entities[0]), id: 'entity:aaa', name: 'C:\\private\\mesh.glb', components: [] })
  const first = projectWorldAiQuery(snapshot, { context, query: { kind: 'entities', pageSize: 1 } })
  assert.equal(first.items.length, 1)
  assert.equal(first.total, 2)
  assert.ok(first.nextCursor)
  const second = projectWorldAiQuery(snapshot, { context, query: { kind: 'entities', pageSize: 1, cursor: first.nextCursor } })
  assert.equal(second.nextCursor, null)
  assert.deepEqual([...first.items, ...second.items].map((row) => row.id), ['entity:aaa', 'entity:hero'])
  assert.doesNotMatch(JSON.stringify([first, second, projectWorldAiQuery(snapshot, { context, query: { kind: 'project' } })]), /private|workspacePath|documentPath|Object3D/)
  assert.throws(() => projectWorldAiQuery(snapshot, { context, query: { kind: 'scenes', cursor: first.nextCursor } }))
  assert.throws(() => projectWorldAiQuery(snapshot, { context: { ...context, requestId: 'tx:other' }, query: { kind: 'entities', cursor: first.nextCursor } }))
  for (const pageSize of [0, 51, 1.5, '1']) assert.throws(() => projectWorldAiQuery(snapshot, { context, query: { kind: 'entities', pageSize } }))
  snapshot.project.revision++
  assert.throws(() => projectWorldAiQuery(snapshot, { context, query: { kind: 'entities' } }))
})

test('World AI light edits expose current values and preserve all unrelated properties', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].name = '/home/private/light-owner'
  const light = { id: 'light:key', type: 'light' as const, lightKind: 'spot' as const, enabled: true, color: '#123456' as const, intensity: 2, range: 13, angle: 0.7, castShadow: true }
  snapshot.scenes[0].entities[0].components.push(light)
  const page = projectWorldAiQuery(snapshot, { context, query: { kind: 'components', entityId: 'entity:hero' } })
  const row = page.items.find((row) => row.id === light.id)
  assert.deepEqual(row?.kind === 'component' ? row.current : null, light)
  const command = { type: 'replace-component' as const, sceneId: 'scene:one', entityId: 'entity:hero', componentId: light.id, component: { ...light, intensity: 4 } }
  const before = structuredClone(snapshot)
  const commands = validateWorldAiCommands(snapshot, context, [command])
  const candidate = applyWorldCommandBatch(snapshot, { schema: 'modly.world-command-batch.v1', transactionId: context.requestId,
    projectId: context.projectId, baseRevision: context.baseRevision, origin: 'ai', commands })
  assert.equal(candidate.success, true)
  if (!candidate.success) return
  const diffs = describeWorldAiCandidate(snapshot, candidate.snapshot, commands)
  assert.equal(diffs[0].property, 'light:key.intensity')
  assert.equal(diffs[0].before, '2')
  assert.equal(diffs[0].after, '4')
  assert.equal(diffs[0].entityName, '[redacted]')
  assert.doesNotMatch(JSON.stringify(diffs), /private|[\\/]/)
  assert.deepEqual(snapshot, before, 'Candidate projection must not mutate the original snapshot')
  assert.throws(() => validateWorldAiCommands(snapshot, context, [{ ...command, component: { ...command.component, range: 9 } }]))
  assert.equal(light.range, 13)
})

test('World AI encoded byte limits bound queries, proposals and each paginated response envelope', () => {
  const snapshot = createValidWorldSnapshot()
  assert.throws(() => projectWorldAiQuery(snapshot, { context, query: { kind: 'entities', cursor: 'x'.repeat(8192) } }))
  const expandedContext = { ...context, activeSceneId: `scene:${'s'.repeat(240)}` }
  const largeCommand = { type: 'patch-entity', sceneId: expandedContext.activeSceneId, entityId: `entity:${'e'.repeat(240)}`,
    patch: { name: 'n'.repeat(256), enabled: true, transform: { position: [1.2345678901234567e+200, 1.2345678901234567e+200, 1.2345678901234567e+200], rotation: [1.2345678901234567e+200, 1.2345678901234567e+200, 1.2345678901234567e+200], scale: [1.2345678901234567e+200, 1.2345678901234567e+200, 1.2345678901234567e+200] } } }
  const commands = Array.from({ length: 16 }, () => largeCommand)
  assert.ok(new TextEncoder().encode(JSON.stringify({ commands })).length > 16 * 1024)
  assert.throws(() => parseWorldAiProposal({ type: 'world_command_proposal', context: expandedContext, commands }))
  const template = snapshot.scenes[0].entities[0]
  snapshot.scenes[0].entities = Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(template), id: `entity:${String(index).padStart(3, '0')}${'x'.repeat(230)}`, name: 'n'.repeat(256), components: [] }))
  let cursor: string | undefined
  const ids: string[] = []
  do {
    const page = projectWorldAiQuery(snapshot, { context, query: { kind: 'entities', ...(cursor ? { cursor } : {}) } })
    assert.equal(page.total, 100)
    assert.ok(page.items.length <= 50)
    assert.ok(new TextEncoder().encode(JSON.stringify({ ok: true, value: page })).length <= 32 * 1024)
    ids.push(...page.items.map((item) => item.id))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(new Set(ids).size, 100)
  assert.equal(ids.length, 100)
})
