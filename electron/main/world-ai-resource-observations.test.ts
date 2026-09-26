import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createValidWorldSnapshot } from '../../src/areas/worlds/core/_testFixtures.ts'
import { compileWorldAiProposal } from '../../src/areas/worlds/core/worldAiCreationCompiler.ts'
import { parseWorldAiContext } from '../../src/areas/worlds/core/worldAiContract.ts'
import { observeWorldAiSource, revalidateWorldAiSource, worldAiObservationAuthority as authority } from './world-ai-resource-observations.ts'
import { WorldProjectRepository } from './world-project-repository.ts'

const context = (requestId: string) => parseWorldAiContext({ schema: 'modly.world-ai-context.v1', projectKey: `world-${'a'.repeat(32)}`,
  projectId: 'project:demo', baseRevision: 4, activeSceneId: 'scene:one', editorEpoch: 1, originSessionId: 'session-source', requestId })
function triangleGlb() {
  const binary = Buffer.alloc(36)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => binary.writeFloatLE(value, index * 4))
  const document = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] }
  const json = Buffer.from(JSON.stringify(document)); const padding = Buffer.alloc((4 - json.length % 4) % 4, 32)
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + json.length + padding.length + binary.length, 8)
  header.writeUInt32LE(json.length + padding.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  const chunk = Buffer.alloc(8); chunk.writeUInt32LE(binary.length); chunk.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, json, padding, chunk, binary])
}
async function fixture(requestId: string, t: { after(fn: () => Promise<void>): void }) {
  const workspace = await mkdtemp(join(tmpdir(), 'modly-ai-source-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'Workflows')); await writeFile(join(workspace, 'Workflows/triangle.glb'), triangleGlb())
  const snapshot = createValidWorldSnapshot(); snapshot.project.resources = []
  snapshot.scenes[0].entities = []
  const ctx = context(requestId); const scope = await authority.scope(workspace, ctx, true)
  const inventory = await authority.discover(scope, snapshot)
  authority.record(scope, { context: ctx, kind: 'resources', total: inventory.resources.length, items: inventory.resources, nextCursor: null })
  const handle = inventory.resources[0].id
  const observed = await authority.resolve(scope, [handle])
  const proposal = { type: 'world_command_proposal', context: ctx, commands: [{ type: 'create-entity', kind: 'observed-model',
    localRef: 'triangle', sceneRef: { kind: 'existing', id: ctx.activeSceneId }, name: 'Triangle', resourceHandle: handle }] }
  const compiled = compileWorldAiProposal(snapshot, proposal, observed)
  return { workspace, snapshot, ctx, scope, handle, compiled, cleanup: () => rm(workspace, { recursive: true, force: true }) }
}

test('claimed Apply remains cancellable while actual source validation is pending', async (t) => {
  const f = await fixture('tx:cancel-source', t)
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const resolveSources = authority.resolve.bind(authority)
  t.mock.method(authority, 'resolve', async (...args: Parameters<typeof authority.resolve>) => {
    const result = await resolveSources(...args); entered(); await gate; return result
  })
  try {
    const token = authority.issue(f.scope, f.compiled.batch, [f.handle])
    const pending = authority.redeem(f.workspace, f.ctx, token, f.compiled.batch)
    await Promise.race([started, pending.then(() => { throw new Error('Apply ended before source validation gate') })])
    await authority.discard(f.workspace, f.ctx, token)
    release()
    await assert.rejects(pending, /invalid|expired|cancel|revok/i, 'Cancellation before locked publication must revoke the claimed capability')
    await assert.rejects(authority.redeem(f.workspace, f.ctx, token, f.compiled.batch))
  } finally { release(); await f.cleanup() }
})

test('claimed Apply cannot outlive its request during actual source IO', async (t) => {
  const f = await fixture('tx:expired-source', t); const now = Date.now()
  const resolveSources = authority.resolve.bind(authority)
  t.mock.method(authority, 'resolve', async (...args: Parameters<typeof authority.resolve>) => {
    const result = await resolveSources(...args)
    t.mock.method(Date, 'now', () => now + 5 * 60_000 + 1)
    return result
  })
  try {
    const token = authority.issue(f.scope, f.compiled.batch, [f.handle])
    await assert.rejects(authority.redeem(f.workspace, f.ctx, token, f.compiled.batch), /expired|invalid/i)
  } finally { t.mock.restoreAll(); await f.cleanup() }
})

test('real locked journal publication rejects cancellation after source validation and staging', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'modly-ai-journal-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'Workflows')); await writeFile(join(workspace, 'Workflows/triangle.glb'), triangleGlb())
  let armed = false; let release!: () => void; let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const projectKey = `world-${'b'.repeat(32)}`
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => projectKey,
    syncDirectory: () => true, failureCheckpoint: async (stage) => { if (armed && stage === 'backup-created') { entered(); await gate } } })
  const created = await repository.create({ name: 'Journal boundary', initialSceneName: 'First' })
  assert.ok(created.ok)
  const ctx = parseWorldAiContext({ ...context('tx:journal-cancel'), projectKey, projectId: created.value.snapshot.project.projectId,
    baseRevision: 0, activeSceneId: created.value.snapshot.project.startSceneId })
  const query = await repository.queryAi({ context: ctx, query: { kind: 'resources' } })
  assert.ok(query.ok && query.value.items[0].kind === 'resource')
  const preview = await repository.previewAi({ proposal: { type: 'world_command_proposal', context: ctx, commands: [{ type: 'create-entity',
    kind: 'observed-model', sceneRef: { kind: 'existing', id: ctx.activeSceneId }, localRef: 'triangle', name: 'Triangle', resourceHandle: query.value.items[0].id }] } })
  assert.ok(preview.ok)
  const statePath = join(workspace, 'Worlds', projectKey, '.modly/state.v1.json')
  const before = await readFile(statePath)
  armed = true
  const pending = repository.applyCommands({ projectKey, batch: preview.value.batch, aiAuthority: { context: ctx, token: preview.value.authority } })
  try {
    await Promise.race([started, pending.then(() => { throw new Error('Apply ended before the admitted staging checkpoint') })])
    assert.ok((await new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).discardAi({ context: ctx, authority: preview.value.authority })).ok)
    release()
    const applied = await pending
    assert.equal(applied.ok, false, 'Cancellation before journal irreversibility must not publish the staged revision')
    assert.deepEqual(await readFile(statePath), before, 'Committed revision and transaction history must remain byte-identical')
    const reopened = await repository.open({ projectKey })
    assert.ok(reopened.ok && reopened.value.status === 'ready')
    assert.deepEqual(reopened.value.snapshot, created.value.snapshot)
  } finally { release(); armed = false }
})

test('PLY header terminator is not vertex payload', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'modly-ai-ply-header-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'empty.ply'), 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n')
  await assert.rejects(observeWorldAiSource(workspace, 'empty.ply'), /payload/, 'The line ending after end_header cannot prove a vertex exists')
})

test('actual GLB and glTF dependency closures are hashed and changed or removed bytes fail freshness', async (t) => {
  const f = await fixture('tx:source-closure', t)
  const glb = await observeWorldAiSource(f.workspace, 'Workflows/triangle.glb')
  assert.equal(glb.format, 'glb'); assert.equal(glb.files.length, 1)
  assert.equal(glb.files[0].byteLength, triangleGlb().length); assert.match(glb.fingerprint, /^[a-f0-9]{64}$/)
  await revalidateWorldAiSource(f.workspace, glb)
  const binary = Buffer.alloc(36); binary.writeFloatLE(1, 12)
  await writeFile(join(f.workspace, 'Workflows/positions.bin'), binary)
  await writeFile(join(f.workspace, 'Workflows/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=', 'base64'))
  await writeFile(join(f.workspace, 'Workflows/triangle.gltf'), JSON.stringify({ asset: { version: '2.0' },
    buffers: [{ uri: 'positions.bin', byteLength: 36 }], images: [{ uri: 'pixel.png' }] }))
  const proof = await observeWorldAiSource(f.workspace, 'Workflows/triangle.gltf')
  assert.equal(proof.format, 'gltf')
  assert.deepEqual(proof.files.map((file) => file.path), ['Workflows/triangle.gltf', 'Workflows/positions.bin', 'Workflows/pixel.png'])
  await revalidateWorldAiSource(f.workspace, proof)
  binary.writeFloatLE(2, 12); await writeFile(join(f.workspace, 'Workflows/positions.bin'), binary)
  await assert.rejects(revalidateWorldAiSource(f.workspace, proof), /changed/)
  const changed = await observeWorldAiSource(f.workspace, 'Workflows/triangle.gltf')
  await rm(join(f.workspace, 'Workflows/pixel.png'))
  await assert.rejects(revalidateWorldAiSource(f.workspace, changed))
  await writeFile(join(f.workspace, 'Workflows/triangle.glb'), Buffer.from('ply\nformat ascii 1.0\nend_header\n0'))
  await assert.rejects(revalidateWorldAiSource(f.workspace, glb), /GLB/)
  await rm(join(f.workspace, 'Workflows/triangle.glb'))
  await assert.rejects(revalidateWorldAiSource(f.workspace, glb))
})

test('actual PLY mesh, point and gaussian header capabilities remain distinct and type changes fail', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'modly-ai-ply-capability-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const vertex = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n'
  const payload = '0 0 0\n1 0 0\n0 1 0\n'
  await writeFile(join(workspace, 'points.ply'), `${vertex}end_header\n${payload}`)
  const points = await observeWorldAiSource(workspace, 'points.ply'); assert.equal(points.format, 'ply-points')
  const mesh = `${vertex}element face 1\nproperty list uchar int vertex_indices\nend_header\n${payload}3 0 1 2\n`
  await writeFile(join(workspace, 'mesh.ply'), mesh)
  assert.equal((await observeWorldAiSource(workspace, 'mesh.ply')).format, 'ply-mesh')
  await writeFile(join(workspace, 'gaussian.ply'), 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float scale_0\nproperty float rot_0\nend_header\n0 0 0 0 0 1\n')
  assert.equal((await observeWorldAiSource(workspace, 'gaussian.ply')).format, 'gaussian-ply')
  await writeFile(join(workspace, 'points.ply'), mesh)
  await assert.rejects(revalidateWorldAiSource(workspace, points), /changed/)
})

test('source observation rejects path escapes, symlinks, network and unknown dependency locators', async (t) => {
  const f = await fixture('tx:confined-source', t)
  await symlink(join(f.workspace, 'Workflows/triangle.glb'), join(f.workspace, 'linked.glb'))
  await symlink(join(f.workspace, 'Workflows'), join(f.workspace, 'linked-directory'))
  for (const path of ['../triangle.glb', '/triangle.glb', 'file:triangle.glb', 'https://example.test/triangle.glb', 'linked.glb', 'linked-directory/triangle.glb']) {
    await assert.rejects(observeWorldAiSource(f.workspace, path))
  }
  for (const uri of ['https://example.test/positions.bin', '../positions.bin', '%2e%2e/positions.bin', 'file:positions.bin', 'positions.bin?secret=1']) {
    await writeFile(join(f.workspace, 'Workflows/unsafe.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri, byteLength: 36 }] }))
    await assert.rejects(observeWorldAiSource(f.workspace, 'Workflows/unsafe.gltf'), /Unsafe/)
  }
  await writeFile(join(f.workspace, 'Workflows/unsafe.gltf'), JSON.stringify({ asset: { version: '2.0' }, extensions: { unknown: { uri: 'positions.bin' } } }))
  await assert.rejects(observeWorldAiSource(f.workspace, 'Workflows/unsafe.gltf'), /Unknown/)
})

test('only actually returned observations authorize existing owners and opaque resources in the complete context', async (t) => {
  const f = await fixture('tx:queried-owners', t)
  const otherContext = context('tx:unqueried-owners')
  const scope = await authority.scope(f.workspace, otherContext, true)
  const inventory = await authority.discover(scope, f.snapshot)
  await assert.rejects(authority.resolve(scope, [inventory.resources[0].id]), /not queried/)
  const observed = await authority.resolve(f.scope, [f.handle])
  assert.throws(() => observed.assertObserved('entity', 'entity:hero'), /not queried/)
  assert.throws(() => observed.assertObserved('component', 'component:hero-renderable', 'entity:hero'), /not queried/)
  authority.record(f.scope, { context: f.ctx, kind: 'entities', total: 1, nextCursor: null, items: [{ kind: 'entity', id: 'entity:hero', name: 'Hero',
    parentId: null, enabled: true, locked: false, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, componentCount: 1 }] })
  authority.record(f.scope, { context: f.ctx, kind: 'components', total: 1, nextCursor: null, items: [{ kind: 'component', entityId: 'entity:hero', id: 'component:hero-renderable', type: 'renderable', enabled: true }] })
  observed.assertObserved('entity', 'entity:hero'); observed.assertObserved('component', 'component:hero-renderable', 'entity:hero')
  assert.throws(() => observed.assertObserved('component', 'component:hero-renderable', 'entity:other'), /not queried/)
  for (const changed of [{ ...f.ctx, activeSceneId: 'scene:two' }, { ...f.ctx, requestId: 'tx:unknown' }, { ...f.ctx, editorEpoch: 2 }, { ...f.ctx, baseRevision: 5 }]) {
    await assert.rejects(authority.scope(f.workspace, changed))
  }
  const elsewhere = await mkdtemp(join(tmpdir(), 'modly-ai-other-root-')); t.after(() => rm(elsewhere, { recursive: true, force: true }))
  await assert.rejects(authority.scope(elsewhere, f.ctx))
  const token = authority.issue(f.scope, f.compiled.batch, [f.handle])
  const forged = structuredClone(f.compiled.batch); const entity = forged.commands.find((command) => command.type === 'add-entity')!
  entity.entity.name = 'Forged'
  await assert.rejects(authority.redeem(f.workspace, f.ctx, token, forged), /invalid/)
  await assert.rejects(authority.redeem(f.workspace, otherContext, token, f.compiled.batch), /invalid/)
  await authority.discard(f.workspace, f.ctx, token)
  await assert.rejects(authority.redeem(f.workspace, f.ctx, token, f.compiled.batch))
})

test('scope TTL and finite eviction invalidate held observations and capabilities; failed claims cannot retry', async (t) => {
  const f = await fixture('tx:finite-scope', t)
  const token = authority.issue(f.scope, f.compiled.batch, [f.handle])
  for (let index = 0; index < 64; index += 1) await authority.scope(f.workspace, context(`tx:eviction-${index}`), true)
  await assert.rejects(authority.resolve(f.scope, [f.handle]), /expired/)
  await assert.rejects(authority.redeem(f.workspace, f.ctx, token, f.compiled.batch))
  const fresh = await fixture('tx:failed-claim', t)
  const failed = authority.issue(fresh.scope, fresh.compiled.batch, [fresh.handle])
  await rm(join(fresh.workspace, 'Workflows/triangle.glb'))
  await assert.rejects(authority.redeem(fresh.workspace, fresh.ctx, failed, fresh.compiled.batch))
  await writeFile(join(fresh.workspace, 'Workflows/triangle.glb'), triangleGlb())
  await assert.rejects(authority.redeem(fresh.workspace, fresh.ctx, failed, fresh.compiled.batch), /invalid/)
  t.mock.method(Date, 'now', () => Date.parse('2200-01-01T00:00:00Z'))
  await assert.rejects(authority.scope(fresh.workspace, fresh.ctx), /expired/)
  t.mock.restoreAll()
})

test('actual registered project and shared catalog rows use distinct opaque handles but canonical source reuse', async (t) => {
  const f = await fixture('tx:catalog-dual-fixture', t)
  const snapshot = structuredClone(f.snapshot)
  snapshot.project.resources = [{ type: 'model', id: 'resource:triangle', name: 'Triangle', workspacePath: 'Workflows/triangle.glb', format: 'glb' }]
  const ctx = context('tx:catalog-dual'); const scope = await authority.scope(f.workspace, ctx, true)
  const inventory = await authority.discover(scope, snapshot)
  assert.deepEqual(inventory.resources.map((row) => row.source), ['project', 'workflows'])
  assert.notEqual(inventory.resources[0].id, inventory.resources[1].id)
  assert.equal(inventory.resources[0].fingerprint, inventory.resources[1].fingerprint)
  const catalog = inventory.resources[1]
  authority.record(scope, { context: ctx, kind: 'resources', items: [catalog], total: 1, nextCursor: null })
  await assert.rejects(authority.resolve(scope, [inventory.resources[0].id]), /not queried/)
  const observations = await authority.resolve(scope, [catalog.id])
  const commands = Array.from({ length: 16 }, (_, index) => ({ type: 'create-entity', kind: 'observed-model', localRef: `model${index}`,
    sceneRef: { kind: 'existing', id: ctx.activeSceneId }, name: 'Model', resourceHandle: catalog.id }))
  const compiled = compileWorldAiProposal(snapshot, JSON.parse(JSON.stringify({ type: 'world_command_proposal', context: ctx, commands })), observations)
  assert.equal(compiled.batch.commands.length, 16)
  assert.equal(compiled.candidate.project.resources.length, 1)
})

test('real host source changes reject exact reviewed Apply without changing committed document or history', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'modly-ai-host-source-change-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'Workflows')); await writeFile(join(workspace, 'Workflows/triangle.glb'), triangleGlb())
  const projectKey = `world-${'c'.repeat(32)}`
  const fresh = () => new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => projectKey, syncDirectory: () => true })
  const created = await fresh().create({ name: 'Source change', initialSceneName: 'First' }); assert.ok(created.ok)
  const ctx = parseWorldAiContext({ ...context('tx:changed-host-source'), projectKey, projectId: created.value.snapshot.project.projectId,
    activeSceneId: created.value.snapshot.project.startSceneId, baseRevision: 0 })
  const page = await fresh().queryAi({ context: ctx, query: { kind: 'resources' } }); assert.ok(page.ok && page.value.items[0].kind === 'resource')
  const preview = await fresh().previewAi({ proposal: { type: 'world_command_proposal', context: ctx, commands: [{ type: 'create-entity',
    kind: 'observed-model', localRef: 'model', sceneRef: { kind: 'existing', id: ctx.activeSceneId }, name: 'Model', resourceHandle: page.value.items[0].id }] } }); assert.ok(preview.ok)
  const before = await readFile(join(workspace, 'Worlds', projectKey, '.modly/state.v1.json'))
  const modified = triangleGlb(); modified.writeFloatLE(2, modified.length - 24)
  await writeFile(join(workspace, 'Workflows/triangle.glb'), modified)
  const result = await fresh().applyCommands({ projectKey, batch: preview.value.batch, aiAuthority: { context: ctx, token: preview.value.authority } })
  assert.ok(!result.ok && result.error.code === 'invalid_request')
  assert.deepEqual(await readFile(join(workspace, 'Worlds', projectKey, '.modly/state.v1.json')), before)
  const reopened = await fresh().open({ projectKey }); assert.ok(reopened.ok && reopened.value.status === 'ready'); assert.deepEqual(reopened.value.snapshot, created.value.snapshot)
  assert.doesNotMatch(JSON.stringify(result), /Workflows|workspacePath|[\\/]/)
})
