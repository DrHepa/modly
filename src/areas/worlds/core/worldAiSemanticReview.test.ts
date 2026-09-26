import assert from 'node:assert/strict'
import test from 'node:test'
import { createValidWorldSnapshot } from './_testFixtures.ts'
import { compileWorldAiProposal, type WorldAiCreationObservations } from './worldAiCreationCompiler.ts'
import { projectWorldAiSemanticReview } from './worldAiSemanticReview.ts'
import { applyWorldCommandBatch } from './worldCommands.ts'

const context = { schema: 'modly.world-ai-context.v1' as const, projectKey: `world-${'a'.repeat(32)}`, projectId: 'project:demo',
  baseRevision: 4, activeSceneId: 'scene:one', editorEpoch: 1, originSessionId: 'session-review', requestId: 'tx:review' }
const observed: WorldAiCreationObservations = { resources: new Map(), assertObserved() {} }
const existing = (id: string) => ({ kind: 'existing', id })
const local = (localRef: string) => ({ kind: 'local', localRef })
const proposal = (commands: unknown[]) => JSON.parse(JSON.stringify({ type: 'world_command_proposal', context, commands }))
const source = (compiled: ReturnType<typeof compileWorldAiProposal>, observations = observed) => ({ capturedContext: context, proposal: compiled.proposal, observations })

test('semantic review enumerates created scene defaults and resource-free entity, camera, light and physics fields without paths', () => {
  const before = createValidWorldSnapshot()
  const sceneRef = local('stage')
  const entityRef = local('actor')
  const compiled = compileWorldAiProposal(before, proposal([
    { type: 'create-scene', localRef: 'stage', name: 'Stage' },
    { type: 'create-entity', kind: 'group', localRef: 'actor', sceneRef, name: 'Actor' },
    { type: 'create-entity', kind: 'camera', localRef: 'shot', sceneRef, name: 'Shot' },
    { type: 'create-entity', kind: 'light', localRef: 'sun', sceneRef, name: 'Sun', light: { lightKind: 'directional' } },
    { type: 'configure-collider', sceneRef, entityRef, collider: { shape: 'box' } },
    { type: 'configure-body', sceneRef, entityRef, body: { bodyType: 'dynamic' } },
    { type: 'reparent', sceneRef, entityRef, parentRef: null },
  ]), observed)
  const review = projectWorldAiSemanticReview(before, compiled.candidate, compiled.batch, [], source(compiled))
  assert.equal(review.complete, true, JSON.stringify(review))
  if (!review.complete) return
  assert.deepEqual(review.warnings, [])
  const fields = review.changes.map((change) => change.field)
  assert.ok(fields.includes('scenes[2].environment.backgroundColor'))
  assert.ok(fields.includes('scenes[2].environment.ambientIntensity'))
  assert.ok(fields.includes('scenes[2].entities[0].locked'))
  assert.ok(fields.includes('scenes[2].entities[0].tags.length'))
  assert.ok(fields.some((field) => field.endsWith('.primary')))
  assert.ok(fields.some((field) => field.endsWith('.castShadow')))
  assert.ok(fields.some((field) => field.endsWith('.collisionMask')))
  assert.ok(fields.some((field) => field.endsWith('.gravityScale')))
  assert.ok(fields.includes('project.scenes.length'))
  assert.doesNotMatch(JSON.stringify(review), /documentPath|workspacePath|Workflows|Worlds\/|inverse|\/tmp\//)
})

test('semantic review enumerates active environment and legacy patch values, while preserving array order', () => {
  const before = createValidWorldSnapshot()
  const compiled = compileWorldAiProposal(before, proposal([
    { type: 'set-active-scene-environment', environment: { backgroundColor: '#abcdef', ambientIntensity: 1.25 } },
    { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { name: 'Hero New', enabled: false } },
    { type: 'create-entity', kind: 'group', localRef: 'a', sceneRef: existing('scene:one'), name: 'A' },
    { type: 'create-entity', kind: 'group', localRef: 'b', sceneRef: existing('scene:one'), name: 'B' },
  ]), observed)
  const review = projectWorldAiSemanticReview(before, compiled.candidate, compiled.batch, [], source(compiled))
  assert.equal(review.complete, true, JSON.stringify(review))
  if (!review.complete) return
  assert.ok(review.changes.some((change) => change.field === 'scenes[0].environment.backgroundColor' && change.after === '"#abcdef"'))
  assert.ok(review.changes.some((change) => change.field.endsWith('.name') && change.after === '"Hero New"'))
  assert.ok(review.changes.some((change) => change.field === 'scenes[0].entities[1].name' && change.after === '"A"'))
  assert.ok(review.changes.some((change) => change.field === 'scenes[0].entities[2].name' && change.after === '"B"'))
  const reordered = structuredClone(compiled.candidate)
  ;[reordered.scenes[0].entities[1], reordered.scenes[0].entities[2]] = [reordered.scenes[0].entities[2], reordered.scenes[0].entities[1]]
  assert.equal(projectWorldAiSemanticReview(before, reordered, compiled.batch, [], source(compiled)).complete, false)
})

test('review keeps an inherited environment resource without revealing its workspace path', () => {
  const before = createValidWorldSnapshot()
  before.project.resources.push({ id: 'resource:sky', type: 'environment', name: 'Sky', workspacePath: 'Assets/sky.hdr', format: 'hdr' })
  before.scenes[0].environment.environmentResourceId = 'resource:sky'
  const compiled = compileWorldAiProposal(before, proposal([{ type: 'set-active-scene-environment',
    environment: { backgroundColor: '#123456', ambientIntensity: 2 } }]), observed)
  const review = projectWorldAiSemanticReview(before, compiled.candidate, compiled.batch, [], source(compiled))
  assert.equal(review.complete, true, JSON.stringify(review))
  assert.doesNotMatch(JSON.stringify(review), /Assets|workspacePath|documentPath/)
  assert.equal(compiled.candidate.scenes[0].environment.environmentResourceId, 'resource:sky')
})

test('semantic review covers existing light edits, reparent and primitive collider/body replacements', () => {
  const before = createValidWorldSnapshot()
  const hero = before.scenes[0].entities[0]
  const light = { id: 'component:light', type: 'light' as const, enabled: true, lightKind: 'point' as const,
    color: '#abcdef' as const, intensity: 1, castShadow: true, range: 8 }
  hero.components.push(light)
  hero.components.push({ id: 'component:collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [1, 1, 1],
    sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 65535 })
  hero.components.push({ id: 'component:body', type: 'rigid-body', enabled: true, bodyType: 'fixed', gravityScale: 1,
    linearDamping: 0, angularDamping: 0, canSleep: true })
  const sceneRef = existing('scene:one')
  const entityRef = existing('entity:hero')
  const compiled = compileWorldAiProposal(before, proposal([
    { type: 'create-entity', kind: 'group', localRef: 'parent', sceneRef, name: 'Parent' },
    { type: 'reparent', sceneRef, entityRef, parentRef: local('parent') },
    { type: 'replace-component', sceneId: 'scene:one', entityId: 'entity:hero', componentId: light.id,
      component: { ...light, intensity: 4, color: '#fedcba' } },
    { type: 'configure-collider', sceneRef, entityRef, componentRef: existing('component:collider'), collider: { shape: 'sphere', radius: 2 } },
    { type: 'configure-body', sceneRef, entityRef, componentRef: existing('component:body'), body: { bodyType: 'dynamic' } },
  ]), observed)
  const review = projectWorldAiSemanticReview(before, compiled.candidate, compiled.batch, [], source(compiled))
  assert.equal(review.complete, true, JSON.stringify(review))
  if (!review.complete) return
  const fields = review.changes.map((change) => change.field)
  assert.ok(fields.some((field) => field.endsWith('.parentId')))
  assert.ok(fields.some((field) => field.endsWith('.intensity')))
  assert.ok(fields.some((field) => field.endsWith('.shape')))
  assert.ok(fields.some((field) => field.endsWith('.bodyType')))
  assert.doesNotMatch(JSON.stringify(review), /workspacePath|documentPath|Assets\//)
})

test('semantic review fails closed for omitted or unknown semantics, path sentinels, warnings and resource mutation', () => {
  const before = createValidWorldSnapshot()
  const compiled = compileWorldAiProposal(before, proposal([{ type: 'create-scene', localRef: 'stage', name: 'Stage' }]), observed)
  const unknown = structuredClone(compiled.candidate)
  Object.assign(unknown.scenes[2], { unreviewedSemanticField: true })
  assert.equal(projectWorldAiSemanticReview(before, unknown, compiled.batch, [], source(compiled)).complete, false)
  const omitted = structuredClone(compiled.candidate)
  omitted.scenes[2].environment.ambientIntensity = 9
  assert.equal(projectWorldAiSemanticReview(before, omitted, compiled.batch, [], source(compiled)).complete, false)
  const path = structuredClone(compiled.candidate)
  path.scenes[2].name = '/tmp/private'
  assert.equal(projectWorldAiSemanticReview(before, path, compiled.batch, [], source(compiled)).complete, false)
  assert.equal(projectWorldAiSemanticReview(before, compiled.candidate, compiled.batch, ['/tmp/private'], source(compiled)).complete, false)
  const changedPath = structuredClone(compiled.candidate)
  changedPath.project.scenes[0].documentPath = 'Worlds/foreign/scenes/one.world-scene.json'
  assert.equal(projectWorldAiSemanticReview(before, changedPath, compiled.batch, [], source(compiled)).complete, false)
  const handle = `asset_${'a'.repeat(32)}`
  const resourceObserved: WorldAiCreationObservations = { ...observed, resources: new Map([[handle, { workspacePath: 'Workflows/private.glb', format: 'glb' }]]) }
  const resourceCompiled = compileWorldAiProposal(before, proposal([{ type: 'create-entity', kind: 'observed-model', localRef: 'model',
    sceneRef: existing('scene:one'), name: 'Model', resourceHandle: handle }]), resourceObserved)
  assert.equal(projectWorldAiSemanticReview(before, resourceCompiled.candidate, resourceCompiled.batch, [], source(resourceCompiled, resourceObserved)).complete, false)
})

test('review rejects replay-valid foreign new-scene document path', () => {
  const before = createValidWorldSnapshot()
  const compiled = compileWorldAiProposal(before, proposal([{ type: 'create-scene', localRef: 'stage', name: 'Stage' }]), observed)
  const foreignBatch = structuredClone(compiled.batch)
  const addScene = foreignBatch.commands.find((command) => command.type === 'add-scene')
  assert.ok(addScene && addScene.type === 'add-scene')
  addScene.reference.documentPath = 'Worlds/foreign/scenes/scene-foreign.world-scene.json'
  const foreignReplay = applyWorldCommandBatch(before, foreignBatch)
  assert.equal(foreignReplay.success, true)
  if (!foreignReplay.success) return
  assert.equal(projectWorldAiSemanticReview(before, foreignReplay.snapshot, foreignBatch, [], source(compiled)).complete, false)

})

test('review rejects replay-valid environment change outside captured active scene', () => {
  const before = createValidWorldSnapshot()
  const envCompiled = compileWorldAiProposal(before, proposal([{ type: 'set-active-scene-environment',
    environment: { backgroundColor: '#abcdef', ambientIntensity: 1 } }]), observed)
  const foreignSceneBatch = structuredClone(envCompiled.batch)
  const environment = foreignSceneBatch.commands.find((command) => command.type === 'set-scene-environment')
  assert.ok(environment && environment.type === 'set-scene-environment')
  environment.sceneId = 'scene:two'
  const foreignSceneReplay = applyWorldCommandBatch(before, foreignSceneBatch)
  assert.equal(foreignSceneReplay.success, true)
  if (!foreignSceneReplay.success) return
  assert.equal(projectWorldAiSemanticReview(before, foreignSceneReplay.snapshot, foreignSceneBatch, [], source(envCompiled)).complete, false)
})

test('review rejects replay-valid raw light replacement that changes non-preserved properties', () => {
  const before = createValidWorldSnapshot()
  const light = { id: 'component:light', type: 'light' as const, enabled: true, lightKind: 'point' as const,
    color: '#abcdef' as const, intensity: 1, castShadow: true, range: 8 }
  before.scenes[0].entities[0].components.push(light)
  const compiled = compileWorldAiProposal(before, proposal([{ type: 'replace-component', sceneId: 'scene:one',
    entityId: 'entity:hero', componentId: light.id, component: { ...light, intensity: 2 } }]), observed)
  const rawBatch = structuredClone(compiled.batch)
  const edit = rawBatch.commands.find((command) => command.type === 'replace-component')
  assert.ok(edit && edit.type === 'replace-component' && edit.component.type === 'light' && edit.component.lightKind === 'point')
  edit.component.range = 20
  const replay = applyWorldCommandBatch(before, rawBatch)
  assert.equal(replay.success, true)
  if (!replay.success) return
  assert.equal(projectWorldAiSemanticReview(before, replay.snapshot, rawBatch, [], source(compiled)).complete, false)
})

test('review requires host-captured context and explicit provenance', () => {
  const before = createValidWorldSnapshot()
  const compiled = compileWorldAiProposal(before, proposal([{ type: 'create-scene', localRef: 'stage', name: 'Stage' }]), observed)
  assert.equal(projectWorldAiSemanticReview(before, compiled.candidate, compiled.batch, [], undefined as never).complete, false)
  assert.equal(projectWorldAiSemanticReview(before, compiled.candidate, compiled.batch, [],
    { ...source(compiled), capturedContext: { ...context, activeSceneId: 'scene:two' } }).complete, false)
})

test('review denies URI-like and bidi semantic text even when typed recipes compile', () => {
  const before = createValidWorldSnapshot()
  for (const name of ['ssh:private-host', 'C:secret.txt', 'hidden\u202Epath']) {
    const compiled = compileWorldAiProposal(before, proposal([{ type: 'create-scene', localRef: 'stage', name }]), observed)
    assert.equal(projectWorldAiSemanticReview(before, compiled.candidate, compiled.batch, [], source(compiled)).complete, false)
  }
})

for (const [label, warnings] of [
  ['arbitrary warning', ['arbitrary warning']],
  ['null warning', [null]],
  ['drive-like warning', ['C:secret.txt']],
  ['URI-like warning', ['ssh:private-host']],
  ['bidi warning', ['hidden\u202Epath']],
  ['control warning', ['hidden\npath']],
  ['over-count warnings', Array(17).fill('warning')],
  ['over-byte warnings', Array(9).fill('w'.repeat(1000))],
] as const) {
  test(`review rejects ${label} without throwing`, () => {
    const before = createValidWorldSnapshot()
    const compiled = compileWorldAiProposal(before, proposal([{ type: 'create-scene', localRef: 'stage', name: 'Stage' }]), observed)
    assert.doesNotThrow(() => projectWorldAiSemanticReview(before, compiled.candidate, compiled.batch, warnings as string[], source(compiled)))
    assert.equal(projectWorldAiSemanticReview(before, compiled.candidate, compiled.batch, warnings as string[], source(compiled)).complete, false)
  })
}
