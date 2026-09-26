import assert from 'node:assert/strict'
import test from 'node:test'
import { createValidWorldSnapshot } from './_testFixtures.ts'
import { compileWorldAiProposal, type WorldAiCreationObservations } from './worldAiCreationCompiler.ts'
import { describeWorldAiCandidate, parseWorldAiProposal } from './worldAiContract.ts'
import { canonicalWorldCommandBatchPayload } from './worldCommands.ts'

const context = { schema: 'modly.world-ai-context.v1', projectKey: `world-${'a'.repeat(32)}`, projectId: 'project:demo',
  baseRevision: 4, activeSceneId: 'scene:one', editorEpoch: 1, originSessionId: 'session-test', requestId: 'tx:creation' }
const handle = `asset_${'a'.repeat(32)}`
const local = (localRef: string) => ({ kind: 'local', localRef })
const existing = (id: string) => ({ kind: 'existing', id })
const wire = (commands: unknown[], requestId = context.requestId) => JSON.parse(JSON.stringify({ type: 'world_command_proposal', context: { ...context, requestId }, commands }))
const observed: WorldAiCreationObservations = { resources: new Map([[handle, { workspacePath: 'Workflows/triangle.glb', format: 'glb' }]]), assertObserved() {} }
const sceneRef = local('stage')
const entityRef = local('hero')
const recipes = () => [
  { type: 'create-scene', localRef: 'stage', name: 'Stage' },
  { type: 'create-entity', kind: 'group', localRef: 'actors', sceneRef, name: 'Actors', transform: { position: [1, 2, 3], rotation: [0, 0.2, 0], scale: [2, 2, 2] } },
  { type: 'create-entity', kind: 'observed-model', localRef: 'hero', sceneRef, parentRef: local('actors'), name: 'Hero', resourceHandle: handle,
    transform: { position: [2, 4, 6], rotation: [0.1, 0.2, 0.3], scale: [0.5, 1, 2] },
    material: { baseColor: '#123456', metallic: 0.2, roughness: 0.5, opacity: 1 } },
  { type: 'create-entity', kind: 'camera', localRef: 'shot', sceneRef, name: 'Shot', camera: { projection: 'orthographic', orthographicSize: 8 } },
  { type: 'create-entity', kind: 'light', localRef: 'key', sceneRef, name: 'Key', light: { lightKind: 'point', intensity: 3, range: 20 } },
  { type: 'configure-collider', sceneRef, entityRef, localRef: 'hull', collider: { shape: 'capsule', radius: 0.4, halfHeight: 0.8 } },
  { type: 'configure-body', sceneRef, entityRef, localRef: 'body', body: { bodyType: 'dynamic' } },
]

test('compiler creates real canonical contents deterministically without publishing or changing the initial scene', () => {
  const before = createValidWorldSnapshot()
  const original = structuredClone(before)
  const first = compileWorldAiProposal(before, wire(recipes()), observed)
  const second = compileWorldAiProposal(before, wire(recipes()), observed)
  assert.deepEqual(first.batch, second.batch)
  assert.deepEqual(before, original)
  assert.equal(first.candidate.project.revision, 5)
  assert.equal(first.candidate.project.startSceneId, before.project.startSceneId)
  assert.equal(first.candidate.scenes.length, 3)
  assert.deepEqual(first.candidate.scenes.slice(0, 2), before.scenes)
  const stage = first.candidate.scenes[2]
  assert.equal(stage.entities.length, 4)
  const hero = stage.entities.find((entity) => entity.name === 'Hero')!
  assert.equal(hero.parentId, stage.entities.find((entity) => entity.name === 'Actors')!.id)
  assert.deepEqual(hero.components.map((component) => component.type), ['renderable', 'collider', 'rigid-body'])
  assert.deepEqual(hero.components[0], { id: hero.components[0].id, type: 'renderable', enabled: true, resourceId: hero.components[0].type === 'renderable' && hero.components[0].resourceId,
    visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#123456', metallic: 0.2, roughness: 0.5, opacity: 1 } })
  assert.deepEqual(hero.components[1], { id: hero.components[1].id, type: 'collider', enabled: true, purpose: 'simulation', shape: 'capsule', radius: 0.4, halfHeight: 0.8,
    sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 65535 })
  assert.deepEqual(hero.components[2], { id: hero.components[2].id, type: 'rigid-body', enabled: true, bodyType: 'dynamic', gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: true })
  const camera = stage.entities.find((entity) => entity.name === 'Shot')!.components[0]
  assert.deepEqual(camera, { id: camera.id, type: 'camera', enabled: true, primary: true, projection: 'orthographic', orthographicSize: 8, near: 0.1, far: 1000 })
  const resource = first.candidate.project.resources.find((entry) => entry.type === 'model' && entry.workspacePath === 'Workflows/triangle.glb')!
  assert.equal(resource.type === 'model' && resource.workspacePath, 'Workflows/triangle.glb')
  const details = describeWorldAiCandidate(before, first.candidate, first.batch.commands)
  assert.ok(details.some((diff) => diff.property === 'scene' && diff.entityName === 'Stage' && diff.after === 'Created'))
  assert.ok(details.some((diff) => diff.property.endsWith('.intensity') && diff.after === '3'))
  assert.ok(details.some((diff) => diff.property.endsWith('.bodyType') && diff.after === 'dynamic'))
  assert.doesNotMatch(JSON.stringify(details), /workspacePath|Workflows|Object3D|[\\/]/)
  assert.ok(new TextEncoder().encode(canonicalWorldCommandBatchPayload(first.batch)).length <= 16 * 1024)
})

test('compiler skips every existing identity and scene document key, including generated component IDs', () => {
  const initial = createValidWorldSnapshot()
  const compiled = compileWorldAiProposal(initial, wire(recipes()), observed)
  const collision = structuredClone(initial)
  const stage = compiled.candidate.scenes[2]
  collision.project.scenes.push(structuredClone(compiled.candidate.project.scenes[2]))
  collision.scenes.push(structuredClone(stage))
  collision.project.resources = structuredClone(compiled.candidate.project.resources)
  const next = compileWorldAiProposal(collision, wire(recipes()), observed)
  const ids = next.candidate.scenes.flatMap((scene) => [scene.sceneId, ...scene.entities.flatMap((entity) => [entity.id, ...entity.components.map((component) => component.id)])])
  assert.equal(new Set(ids).size, ids.length)
  const paths = next.candidate.project.scenes.map((reference) => reference.documentPath)
  assert.equal(new Set(paths).size, paths.length)
})

test('compiler rejects forward, duplicate, cross-scene, unqueried, wrong-kind, cycle, owner and lock violations atomically', () => {
  const snapshot = createValidWorldSnapshot()
  const create = { type: 'create-entity', kind: 'group', localRef: 'group', sceneRef: existing('scene:one'), name: 'Group' }
  const bad = [
    [{ ...create, parentRef: local('future') }],
    [create, create],
    [{ ...create, sceneRef: existing('scene:two') }],
    [{ ...create, sceneRef: existing('scene:one'), parentRef: existing('entity:missing') }],
    [{ type: 'create-scene', name: 'Stage', localRef: 'stage' }, { ...create, parentRef: local('stage') }],
    [create, { type: 'reparent', sceneRef: existing('scene:one'), entityRef: local('group'), parentRef: local('group') }],
    [{ type: 'configure-body', sceneRef: existing('scene:one'), entityRef: existing('entity:hero'), componentRef: existing('component:hero-renderable'), body: { bodyType: 'fixed' } }],
  ]
  for (const commands of bad) assert.throws(() => compileWorldAiProposal(snapshot, wire(commands), observed))
  assert.throws(() => compileWorldAiProposal(snapshot, wire([{ ...create, parentRef: existing('entity:hero') }]), { ...observed, assertObserved() { throw new Error('Not queried') } }))
  snapshot.scenes[0].entities[0].locked = true
  const before = structuredClone(snapshot)
  assert.throws(() => compileWorldAiProposal(snapshot, wire([{ ...create, parentRef: existing('entity:hero') }]), observed))
  assert.deepEqual(snapshot, before)
})

test('compiler preserves full local transforms through reparent and replaces prior same-owner primitive components', () => {
  const commands = recipes()
  commands.push({ type: 'reparent', sceneRef, entityRef, parentRef: null } as never)
  commands.push({ type: 'configure-collider', sceneRef, entityRef, componentRef: local('hull'), collider: { shape: 'sphere', radius: 2 } } as never)
  const compiled = compileWorldAiProposal(createValidWorldSnapshot(), wire(commands), observed)
  const actors = compiled.candidate.scenes[2].entities.find((entity) => entity.name === 'Actors')!
  assert.deepEqual(actors.transform, { position: [1, 2, 3], rotation: [0, 0.2, 0], scale: [2, 2, 2] })
  const hero = compiled.candidate.scenes[2].entities.find((entity) => entity.name === 'Hero')!
  assert.equal(hero.parentId, null)
  assert.deepEqual(hero.transform, { position: [2, 4, 6], rotation: [0.1, 0.2, 0.3], scale: [0.5, 1, 2] }, 'Reparent preserves nonidentity local transform, not world-space transform')
  const collider = hero.components.find((component) => component.type === 'collider')!
  assert.equal(collider.shape, 'sphere')
  assert.equal(collider.shape === 'sphere' && collider.radius, 2)
  const details = describeWorldAiCandidate(createValidWorldSnapshot(), compiled.candidate, compiled.batch.commands)
  assert.equal(details.filter((diff) => diff.entityId === hero.id && diff.property === 'parentId').length, 0, 'Net review must not show a removed intermediate parent')
})

test('compiler bounds expanded commands and private path/default payloads, rejects absent resources and stale contexts', () => {
  const sceneRef = existing('scene:one')
  const commands = Array.from({ length: 16 }, (_, index) => ({ type: 'create-entity', kind: 'observed-model', localRef: `model${index}`, sceneRef, name: 'Model', resourceHandle: handle }))
  assert.throws(() => compileWorldAiProposal(createValidWorldSnapshot(), wire(commands), observed), /expanded/)
  assert.throws(() => compileWorldAiProposal(createValidWorldSnapshot(), wire(recipes()), { ...observed, resources: new Map() }))
  const deep = Array.from({ length: 50 }, () => 'x'.repeat(200)).join('/')
  assert.throws(() => compileWorldAiProposal(createValidWorldSnapshot(), wire(commands.slice(0, 2)), { ...observed, resources: new Map([[handle, { workspacePath: `Workflows/${deep}.glb`, format: 'glb' }]]) }))
  const stale = wire(recipes()); stale.context.baseRevision = 3
  assert.throws(() => compileWorldAiProposal(createValidWorldSnapshot(), stale, observed))
})

test('finite recipe DTO rejects null, unknown, coercion, shadow physics, wrong variants and placeholder resources', () => {
  const camera = { type: 'create-entity', kind: 'camera', localRef: 'camera', sceneRef: existing('scene:one'), name: 'Camera' }
  const bad = [
    { ...camera, camera: null }, { ...camera, camera: { projection: null } }, { ...camera, camera: { primary: true } },
    { ...camera, camera: { projection: 'orthographic', fieldOfView: 60 } }, { ...camera, camera: { near: '1' } },
    { ...camera, kind: 'light', light: { lightKind: 'ambient', castShadow: true } },
    { ...camera, kind: 'observed-model', resourceHandle: 'resource:model' },
    { type: 'configure-body', sceneRef: existing('scene:one'), entityRef: existing('entity:hero'), body: { bodyType: 'dynamic', castShadow: true } },
    { type: 'configure-collider', sceneRef: existing('scene:one'), entityRef: existing('entity:hero'), collider: { shape: 'sphere', halfExtents: [1, 1, 1] } },
  ]
  for (const command of bad) assert.throws(() => parseWorldAiProposal(wire([command])))
})

test('canonical byte bound uses valid distinct resources with positive control, independent of recipe and path bounds', () => {
  const sources = Array.from({ length: 4 }, (_, index) => ({ handle: `asset_${index.toString(16).padStart(32, '0')}`,
    path: `Workflows/${Array.from({ length: 17 }, () => 'x'.repeat(200)).join('/')}/triangle${index}.glb` }))
  for (const source of sources) assert.ok(source.path.length <= 4096)
  const observed = { resources: new Map(sources.map((source) => [source.handle, { workspacePath: source.path, format: 'glb' as const }])), assertObserved() {} }
  const commands = sources.map((source, index) => ({ type: 'create-entity', kind: 'observed-model', localRef: `triangle${index}`,
    sceneRef: existing('scene:one'), name: 'Triangle', resourceHandle: source.handle }))
  const positive = compileWorldAiProposal(createValidWorldSnapshot(), wire(commands.slice(0, 3)), observed)
  assert.equal(positive.batch.commands.length, 6)
  assert.ok(new TextEncoder().encode(canonicalWorldCommandBatchPayload(positive.batch)).length < 16 * 1024)
  assert.throws(() => compileWorldAiProposal(createValidWorldSnapshot(), wire(commands), observed), /expanded canonical batch exceeds its command or byte limits/)
})

test('same registered path and format needs sixteen entities, while a new source needs seventeen expanded commands', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources[0].workspacePath = 'Workflows/triangle.glb'
  const commands = Array.from({ length: 16 }, (_, index) => ({ type: 'create-entity', kind: 'observed-model', localRef: `model${index}`,
    sceneRef: existing('scene:one'), name: 'Model', resourceHandle: handle }))
  const reused = compileWorldAiProposal(snapshot, wire(commands), observed)
  assert.equal(reused.batch.commands.length, 16)
  assert.equal(reused.candidate.project.resources.length, 1)
  assert.throws(() => compileWorldAiProposal(createValidWorldSnapshot(), wire(commands), observed), /expanded/)
})

test('explicit nullable creation parent compiles to a local-transform root in existing and prior new scenes', () => {
  const transform = { position: [2, 4, 6], rotation: [0.1, 0.2, 0.3], scale: [0.5, 1, 2] }
  for (const createNewScene of [false, true]) {
    const commands = [
      ...(createNewScene ? [{ type: 'create-scene', localRef: 'stage', name: 'Stage' }] : []),
      { type: 'create-entity', kind: 'group', localRef: 'root', sceneRef: createNewScene ? local('stage') : existing('scene:one'),
        parentRef: null, name: 'Root', transform },
    ]
    const parsed = parseWorldAiProposal(wire(commands))
    assert.deepEqual(parsed.commands, commands)
    const snapshot = createValidWorldSnapshot()
    const compiled = compileWorldAiProposal(snapshot, parsed, observed)
    const scene = createNewScene ? compiled.candidate.scenes.at(-1)! : compiled.candidate.scenes[0]
    const root = scene.entities.find((entity) => entity.name === 'Root')!
    assert.equal(root.parentId, null)
    assert.deepEqual(root.transform, transform)
    assert.equal(compiled.candidate.project.startSceneId, snapshot.project.startSceneId)
  }
})

test('active-scene environment recipe compiles to one canonical command at the captured revision', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].environment.fog = { color: '#20242b', near: 1, far: 20 }
  const recipe = { type: 'set-active-scene-environment', environment: { backgroundColor: '#123abc', ambientIntensity: 2.5 } }
  const result = compileWorldAiProposal(snapshot, wire([recipe]), observed)
  assert.deepEqual(result.batch.commands, [{ type: 'set-scene-environment', sceneId: 'scene:one', environment: { ...recipe.environment, fog: snapshot.scenes[0].environment.fog } }])
  assert.equal(result.batch.baseRevision, 4)
  assert.equal(result.candidate.project.revision, 5)
  assert.deepEqual(result.candidate.scenes[0].environment, { ...recipe.environment, fog: snapshot.scenes[0].environment.fog })
  assert.deepEqual(result.candidate.scenes[1], snapshot.scenes[1])
})

test('active-scene environment recipe rejects extra, path, resource, nonfinite, out-of-range and stale context', () => {
  const base = { type: 'set-active-scene-environment', environment: { backgroundColor: '#123abc', ambientIntensity: 1 } }
  const invalid = [
    { ...base, sceneId: 'scene:two' },
    { ...base, workspacePath: '/tmp/private' },
    { ...base, environment: { ...base.environment, environmentResourceId: 'resource:hero' } },
    { ...base, environment: { ...base.environment, backgroundColor: '/tmp/private' } },
    { ...base, environment: { ...base.environment, ambientIntensity: Infinity } },
    { ...base, environment: { ...base.environment, ambientIntensity: -0.1 } },
    { ...base, environment: { ...base.environment, ambientIntensity: 10.1 } },
  ]
  for (const recipe of invalid) assert.throws(() => compileWorldAiProposal(createValidWorldSnapshot(), { type: 'world_command_proposal', context, commands: [recipe] }, observed))
  const stale = wire([base]); stale.context.baseRevision = 3
  assert.throws(() => compileWorldAiProposal(createValidWorldSnapshot(), stale, observed))
  const foreign = wire([base]); foreign.context.activeSceneId = 'scene:foreign'
  assert.throws(() => compileWorldAiProposal(createValidWorldSnapshot(), foreign, observed))
})
