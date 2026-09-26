import assert from 'node:assert/strict'
import test from 'node:test'

import { applyWorldCommandBatch, applyWorldCommandInverse, parseWorldCommandBatch, type ApplyWorldCommandBatchResult } from './worldCommands.ts'
import { createValidWorldSnapshot } from './_testFixtures.ts'
import type { WorldEntity, WorldSceneDocumentV1, WorldSequence } from './worldModel.ts'

test('applies cross-dependent commands atomically and increments revision exactly once', () => {
  const result = applyWorldCommandBatch(createValidWorldSnapshot(), {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:dependent', projectId: 'project:demo', baseRevision: 4, origin: 'ai',
    commands: [
      { type: 'add-resource', resource: { id: 'resource:tree', type: 'model', name: 'Tree', workspacePath: 'Assets/tree.glb', format: 'glb' } },
      { type: 'add-entity', sceneId: 'scene:two', entity: { id: 'entity:tree', name: 'Tree', parentId: null, enabled: true, locked: false, tags: [], transform: { position: [3, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] } },
      { type: 'add-component', sceneId: 'scene:two', entityId: 'entity:tree', component: { id: 'component:tree', type: 'renderable', enabled: true, resourceId: 'resource:tree', visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } } },
    ],
  })
  assert.equal(result.success, true, JSON.stringify(result))
  if (result.success !== true) return
  assert.equal(result.snapshot.project.revision, 5)
  assert.equal(result.snapshot.scenes[1].entities[0].components[0].type, 'renderable')
  assert.deepEqual(result.changes, [...result.changes].sort())
  assert.equal(result.inverse.kind, 'world-snapshot')
})

test('rejects stale revisions and malformed batches before mutation', () => {
  const snapshot = createValidWorldSnapshot()
  assert.equal(parseWorldCommandBatch({ commands: [] }).success, false)
  const result = applyWorldCommandBatch(snapshot, {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:stale', projectId: 'project:demo', baseRevision: 3, origin: 'ui',
    commands: [{ type: 'rename-project', name: 'Stale name' }],
  })
  assert.equal(result.success, false)
  assert.equal(snapshot.project.name, 'Demo world')
  assert.equal(snapshot.project.revision, 4)
})

test('command parser rejects inherited fields, accessors, and class instances while accepting null-prototype batches', () => {
  const batch = {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:wire', projectId: 'project:demo', baseRevision: 4, origin: 'ui',
    commands: [{ type: 'rename-project', name: 'Wire safe' }],
  }
  assert.equal(parseWorldCommandBatch(Object.create(batch)).success, false)

  let getterCalls = 0
  const accessor = { ...batch }
  Object.defineProperty(accessor, 'transactionId', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'tx:accessor'
    },
  })
  assert.equal(parseWorldCommandBatch(accessor).success, false)
  assert.equal(getterCalls, 0)

  class BatchRecord {}
  assert.equal(parseWorldCommandBatch(Object.assign(new BatchRecord(), batch)).success, false)
  assert.equal(parseWorldCommandBatch(Object.assign(Object.create(null), batch)).success, true)
})

test('rolls back the whole batch when a later command leaves a dangling resource', () => {
  const snapshot = createValidWorldSnapshot()
  const before = structuredClone(snapshot)
  const result = applyWorldCommandBatch(snapshot, {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:rollback', projectId: 'project:demo', baseRevision: 4, origin: 'workflow',
    commands: [{ type: 'rename-project', name: 'Must roll back' }, { type: 'remove-resource', resourceId: 'resource:hero' }],
  })
  assert.equal(result.success, false)
  assert.deepEqual(snapshot, before)
})

test('rejects hierarchy cycles and removal of resources that remain referenced', () => {
  const withChild = createValidWorldSnapshot()
  withChild.scenes[0].entities.push({ id: 'entity:child', name: 'Child', parentId: 'entity:hero', enabled: true, locked: false, tags: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] })
  const cycle = applyWorldCommandBatch(withChild, {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:cycle', projectId: 'project:demo', baseRevision: 4, origin: 'ui',
    commands: [{ type: 'reparent-entity', sceneId: 'scene:one', entityId: 'entity:hero', parentId: 'entity:child' }],
  })
  assert.equal(cycle.success, false)

  const referenced = applyWorldCommandBatch(createValidWorldSnapshot(), {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:resource', projectId: 'project:demo', baseRevision: 4, origin: 'ui',
    commands: [{ type: 'remove-resource', resourceId: 'resource:hero' }],
  })
  assert.equal(referenced.success, false)
})

test('requires cascade when removing an entity with children', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities.push({ id: 'entity:child', name: 'Child', parentId: 'entity:hero', enabled: true, locked: false, tags: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] })
  const base = { schema: 'modly.world-command-batch.v1' as const, projectId: 'project:demo', baseRevision: 4, origin: 'ui' as const }
  const denied = applyWorldCommandBatch(snapshot, { ...base, transactionId: 'tx:no-cascade', commands: [{ type: 'remove-entity', sceneId: 'scene:one', entityId: 'entity:hero', cascade: false }] })
  assert.equal(denied.success, false)
  const allowed = applyWorldCommandBatch(snapshot, { ...base, transactionId: 'tx:cascade', commands: [{ type: 'remove-entity', sceneId: 'scene:one', entityId: 'entity:hero', cascade: true }] })
  assert.equal(allowed.success, true)
  if (allowed.success === true) assert.equal(allowed.snapshot.scenes[0].entities.length, 0)
})

test('command authority rejects every mutation against effectively locked entities with precise paths', () => {
  const base = { schema: 'modly.world-command-batch.v1' as const, projectId: 'project:demo', baseRevision: 4, origin: 'ui' as const }
  const replacement = { id: 'component:hero-renderable', type: 'renderable', enabled: true, resourceId: 'resource:hero', visible: false, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } }
  const cases = [
    { command: { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { name: 'Blocked' } }, path: 'batch.commands[0].entityId' },
    { command: { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { locked: false, name: 'Not an exact unlock' } }, path: 'batch.commands[0].entityId' },
    { command: { type: 'reparent-entity', sceneId: 'scene:one', entityId: 'entity:hero', parentId: null }, path: 'batch.commands[0].entityId' },
    { command: { type: 'remove-entity', sceneId: 'scene:one', entityId: 'entity:hero', cascade: false }, path: 'batch.commands[0].entityId' },
    { command: { type: 'add-component', sceneId: 'scene:one', entityId: 'entity:hero', component: { id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: false, near: 0.1, far: 100, fieldOfView: 60 } }, path: 'batch.commands[0].entityId' },
    { command: { type: 'replace-component', sceneId: 'scene:one', entityId: 'entity:hero', componentId: 'component:hero-renderable', component: replacement }, path: 'batch.commands[0].entityId' },
    { command: { type: 'remove-component', sceneId: 'scene:one', entityId: 'entity:hero', componentId: 'component:hero-renderable' }, path: 'batch.commands[0].entityId' },
  ]

  for (const [index, entry] of cases.entries()) {
    const snapshot = createValidWorldSnapshot()
    snapshot.scenes[0].entities[0].locked = true
    const before = structuredClone(snapshot)
    const result = applyWorldCommandBatch(snapshot, { ...base, transactionId: `tx:locked:${index}`, commands: [entry.command] })
    assert.equal(result.success, false, JSON.stringify(result))
    assert.deepEqual(snapshot, before)
    if (result.success === false) assert.deepEqual(result.issues, [{ code: 'entity-locked', path: entry.path, message: 'Entity entity:hero is locked by itself or an ancestor.' }])
  }
})

test('whole-scene replacement and removal cannot bypass locked entity authority', () => {
  const base = { schema: 'modly.world-command-batch.v1' as const, projectId: 'project:demo', baseRevision: 4, origin: 'ui' as const }

  const replaceSnapshot = createValidWorldSnapshot()
  replaceSnapshot.scenes[0].entities[0].locked = true
  const replaceBefore = structuredClone(replaceSnapshot)
  const replacement = structuredClone(replaceSnapshot.scenes[0])
  replacement.entities[0].name = 'Bypassed replacement'
  replacement.entities[0].locked = false
  const replaced = applyWorldCommandBatch(replaceSnapshot, {
    ...base,
    transactionId: 'tx:locked-scene-replace',
    commands: [{
      type: 'replace-scene',
      sceneId: 'scene:one',
      reference: structuredClone(replaceSnapshot.project.scenes[0]),
      scene: replacement,
    }],
  })
  assert.equal(replaced.success, false, JSON.stringify(replaced))
  assert.deepEqual(replaceSnapshot, replaceBefore)
  if (replaced.success === false) assert.deepEqual(replaced.issues, [{
    code: 'entity-locked',
    path: 'batch.commands[0].sceneId',
    message: 'Scene scene:one contains effectively locked entity entity:hero.',
  }])

  const removeSnapshot = createValidWorldSnapshot()
  removeSnapshot.project.startSceneId = 'scene:two'
  removeSnapshot.scenes[0].entities[0].locked = true
  const removeBefore = structuredClone(removeSnapshot)
  const removed = applyWorldCommandBatch(removeSnapshot, {
    ...base,
    transactionId: 'tx:locked-scene-remove',
    commands: [{ type: 'remove-scene', sceneId: 'scene:one' }],
  })
  assert.equal(removed.success, false, JSON.stringify(removed))
  assert.deepEqual(removeSnapshot, removeBefore)
  if (removed.success === false) assert.deepEqual(removed.issues, [{
    code: 'entity-locked',
    path: 'batch.commands[0].sceneId',
    message: 'Scene scene:one contains effectively locked entity entity:hero.',
  }])
})

test('locking applies to ancestors, destinations, cascades, and authoritative batch order', () => {
  const base = { schema: 'modly.world-command-batch.v1' as const, projectId: 'project:demo', baseRevision: 4, origin: 'ui' as const }
  const child: WorldEntity = { id: 'entity:child', name: 'Child', parentId: 'entity:hero', enabled: true, locked: false, tags: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] }
  const free: WorldEntity = { ...structuredClone(child), id: 'entity:free', name: 'Free', parentId: null }

  const ancestorLocked = createValidWorldSnapshot()
  ancestorLocked.scenes[0].entities[0].locked = true
  ancestorLocked.scenes[0].entities.push(child, free)
  for (const [index, expectedPath, command] of [
    [0, 'batch.commands[0].entityId', { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:child', patch: { locked: false } }],
    [1, 'batch.commands[0].entity.parentId', { type: 'add-entity', sceneId: 'scene:one', entity: { ...structuredClone(free), id: 'entity:added', parentId: 'entity:hero' } }],
    [2, 'batch.commands[0].parentId', { type: 'reparent-entity', sceneId: 'scene:one', entityId: 'entity:free', parentId: 'entity:hero' }],
  ] as const) {
    const result = applyWorldCommandBatch(ancestorLocked, { ...base, transactionId: `tx:ancestor:${index}`, commands: [command] })
    assert.equal(result.success, false, JSON.stringify(result))
    if (result.success === false) {
      assert.equal(result.issues[0]?.code, 'entity-locked')
      assert.equal(result.issues[0]?.path, expectedPath)
    }
  }

  const lockedDescendant = createValidWorldSnapshot()
  lockedDescendant.scenes[0].entities.push({ ...child, locked: true })
  const cascade = applyWorldCommandBatch(lockedDescendant, { ...base, transactionId: 'tx:locked-descendant', commands: [{ type: 'remove-entity', sceneId: 'scene:one', entityId: 'entity:hero', cascade: true }] })
  assert.equal(cascade.success, false)
  if (cascade.success === false) {
    assert.equal(cascade.issues[0]?.code, 'entity-locked')
    assert.equal(cascade.issues[0]?.path, 'batch.commands[0].entityId')
  }

  const unlockThenEdit = createValidWorldSnapshot()
  unlockThenEdit.scenes[0].entities[0].locked = true
  const unlocked = applyWorldCommandBatch(unlockThenEdit, {
    ...base,
    transactionId: 'tx:unlock-then-edit',
    commands: [
      { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { locked: false } },
      { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { name: 'Editable again' } },
    ],
  })
  assert.equal(unlocked.success, true, JSON.stringify(unlocked))
  if (unlocked.success === true) {
    assert.equal(unlocked.snapshot.scenes[0].entities[0].locked, false)
    assert.equal(unlocked.snapshot.scenes[0].entities[0].name, 'Editable again')
  }

  const lockThenEdit = createValidWorldSnapshot()
  const before = structuredClone(lockThenEdit)
  const rejected = applyWorldCommandBatch(lockThenEdit, {
    ...base,
    transactionId: 'tx:lock-then-edit',
    commands: [
      { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { locked: true } },
      { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { name: 'Must roll back' } },
    ],
  })
  assert.equal(rejected.success, false)
  assert.deepEqual(lockThenEdit, before)
  if (rejected.success === false) assert.equal(rejected.issues[0]?.path, 'batch.commands[1].entityId')
})

test('executes every canonical command variant through the atomic command authority', () => {
  const sequence: WorldSequence = { id: 'sequence:test', name: 'Test', duration: { numerator: 1, denominator: 1 }, tracks: [] }
  const emptyEntity: WorldEntity = { id: 'entity:new', name: 'New', parentId: null, enabled: true, locked: false, tags: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] }
  const sceneThree: WorldSceneDocumentV1 = { schema: 'modly.world-scene.v1', projectId: 'project:demo', sceneId: 'scene:three', name: 'Third scene', environment: { backgroundColor: '#000000', ambientIntensity: 0 }, entities: [], sequences: [] }
  type SuccessResult = Extract<ApplyWorldCommandBatchResult, { success: true }>
  type VariantCase = {
    variant: string
    prepare?: (snapshot: ReturnType<typeof createValidWorldSnapshot>) => void
    command: Record<string, unknown>
    assertDelta?: (result: SuccessResult) => void
    failureCode?: string
  }
  const cases: VariantCase[] = [
    { variant: 'rename-project', command: { type: 'rename-project', name: 'Renamed' }, assertDelta: (result) => assert.equal(result.snapshot.project.name, 'Renamed') },
    { variant: 'set-start-scene', command: { type: 'set-start-scene', sceneId: 'scene:two' }, assertDelta: (result) => assert.equal(result.snapshot.project.startSceneId, 'scene:two') },
    { variant: 'replace-input-actions', command: { type: 'replace-input-actions', inputActions: [] }, assertDelta: (result) => assert.deepEqual(result.snapshot.project.inputActions, []) },
    { variant: 'replace-graphics-profiles', command: { type: 'replace-graphics-profiles', graphicsProfiles: [{ id: 'graphics:new', name: 'New', renderScale: 0.75, shadowQuality: 'low', antialiasing: 'fxaa' }], activeGraphicsProfileId: 'graphics:new' }, assertDelta: (result) => assert.deepEqual(result.snapshot.project.graphicsProfiles.map((profile) => profile.id), ['graphics:new']) },
    { variant: 'add-resource', command: { type: 'add-resource', resource: { id: 'resource:new', type: 'audio', name: 'New', workspacePath: 'Audio/new.wav', format: 'wav' } }, assertDelta: (result) => assert.equal(result.snapshot.project.resources.at(-1)?.id, 'resource:new') },
    { variant: 'replace-resource', command: { type: 'replace-resource', resourceId: 'resource:hero', resource: { id: 'resource:hero', type: 'model', name: 'Hero v2', workspacePath: 'Assets/hero-v2.glb', format: 'glb' } }, assertDelta: (result) => assert.deepEqual(result.snapshot.project.resources[0], { id: 'resource:hero', type: 'model', name: 'Hero v2', workspacePath: 'Assets/hero-v2.glb', format: 'glb' }) },
    { variant: 'remove-resource', prepare: (snapshot) => snapshot.project.resources.push({ id: 'resource:unused', type: 'audio', name: 'Unused', workspacePath: 'Audio/unused.wav', format: 'wav' }), command: { type: 'remove-resource', resourceId: 'resource:unused' }, assertDelta: (result) => assert.equal(result.snapshot.project.resources.some((resource) => resource.id === 'resource:unused'), false) },
    { variant: 'add-scene', command: { type: 'add-scene', reference: { id: 'scene:three', name: 'Third scene', documentPath: 'Worlds/demo/scenes/three.world-scene.json' }, scene: sceneThree }, assertDelta: (result) => { assert.equal(result.snapshot.project.scenes.at(-1)?.id, 'scene:three'); assert.equal(result.snapshot.scenes.at(-1)?.sceneId, 'scene:three') } },
    { variant: 'replace-scene', command: { type: 'replace-scene', sceneId: 'scene:two', reference: { id: 'scene:two', name: 'Second renamed', documentPath: 'Worlds/demo/scenes/two.world-scene.json' }, scene: { ...structuredClone(sceneThree), sceneId: 'scene:two', name: 'Second renamed' } }, assertDelta: (result) => { assert.equal(result.snapshot.project.scenes[1].name, 'Second renamed'); assert.equal(result.snapshot.scenes[1].name, 'Second renamed') } },
    { variant: 'remove-scene', command: { type: 'remove-scene', sceneId: 'scene:two' }, assertDelta: (result) => { assert.deepEqual(result.snapshot.project.scenes.map((scene) => scene.id), ['scene:one']); assert.deepEqual(result.snapshot.scenes.map((scene) => scene.sceneId), ['scene:one']) } },
    { variant: 'set-scene-environment', command: { type: 'set-scene-environment', sceneId: 'scene:one', environment: { backgroundColor: '#123456', ambientIntensity: 0.5 } }, assertDelta: (result) => assert.deepEqual(result.snapshot.scenes[0].environment, { backgroundColor: '#123456', ambientIntensity: 0.5 }) },
    { variant: 'add-sequence', command: { type: 'add-sequence', sceneId: 'scene:one', sequence }, assertDelta: (result) => assert.equal(result.snapshot.scenes[0].sequences[0].id, 'sequence:test') },
    { variant: 'replace-sequence', prepare: (snapshot) => snapshot.scenes[0].sequences.push(structuredClone(sequence)), command: { type: 'replace-sequence', sceneId: 'scene:one', sequenceId: 'sequence:test', sequence: { ...sequence, name: 'Replaced' } }, assertDelta: (result) => assert.equal(result.snapshot.scenes[0].sequences[0].name, 'Replaced') },
    { variant: 'remove-sequence', prepare: (snapshot) => snapshot.scenes[0].sequences.push(structuredClone(sequence)), command: { type: 'remove-sequence', sceneId: 'scene:one', sequenceId: 'sequence:test' }, assertDelta: (result) => assert.deepEqual(result.snapshot.scenes[0].sequences, []) },
    { variant: 'add-entity', command: { type: 'add-entity', sceneId: 'scene:two', entity: emptyEntity }, assertDelta: (result) => assert.equal(result.snapshot.scenes[1].entities[0].id, 'entity:new') },
    { variant: 'patch-entity', command: { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { name: 'Patched' } }, assertDelta: (result) => assert.equal(result.snapshot.scenes[0].entities[0].name, 'Patched') },
    { variant: 'reparent-entity', prepare: (snapshot) => snapshot.scenes[0].entities.push(structuredClone(emptyEntity)), command: { type: 'reparent-entity', sceneId: 'scene:one', entityId: 'entity:new', parentId: 'entity:hero' }, assertDelta: (result) => assert.equal(result.snapshot.scenes[0].entities[1].parentId, 'entity:hero') },
    { variant: 'remove-entity', command: { type: 'remove-entity', sceneId: 'scene:one', entityId: 'entity:hero', cascade: false }, assertDelta: (result) => assert.deepEqual(result.snapshot.scenes[0].entities, []) },
    { variant: 'add-component', command: { type: 'add-component', sceneId: 'scene:one', entityId: 'entity:hero', component: { id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: false, near: 0.1, far: 100, fieldOfView: 60 } }, assertDelta: (result) => assert.equal(result.snapshot.scenes[0].entities[0].components[1].id, 'component:camera') },
    { variant: 'replace-component', command: { type: 'replace-component', sceneId: 'scene:one', entityId: 'entity:hero', componentId: 'component:hero-renderable', component: { id: 'component:hero-renderable', type: 'renderable', enabled: true, resourceId: 'resource:hero', visible: false, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } } }, assertDelta: (result) => assert.equal(result.snapshot.scenes[0].entities[0].components[0].type === 'renderable' && result.snapshot.scenes[0].entities[0].components[0].visible, false) },
    { variant: 'remove-component', command: { type: 'remove-component', sceneId: 'scene:one', entityId: 'entity:hero', componentId: 'component:hero-renderable' }, assertDelta: (result) => assert.deepEqual(result.snapshot.scenes[0].entities[0].components, []) },
  ]
  assert.equal(new Set(cases.map((entry) => entry.variant)).size, 21)
  for (const [index, entry] of cases.entries()) {
    const snapshot = createValidWorldSnapshot()
    entry.prepare?.(snapshot)
    const before = structuredClone(snapshot)
    const result = applyWorldCommandBatch(snapshot, {
      schema: 'modly.world-command-batch.v1', transactionId: `tx:variant:${index}`, projectId: 'project:demo', baseRevision: 4, origin: 'ui', commands: [entry.command],
    })
    assert.deepEqual(snapshot, before, `${entry.variant} mutated its input`)
    if (entry.failureCode) {
      assert.equal(result.success, false, `${entry.variant}: ${JSON.stringify(result)}`)
      if (result.success === false) assert.ok(result.issues.some((issue) => issue.code === entry.failureCode), `${entry.variant}: ${JSON.stringify(result)}`)
      continue
    }
    assert.equal(result.success, true, `${entry.variant}: ${JSON.stringify(result)}`)
    if (result.success !== true) continue
    assert.equal(result.snapshot.project.revision, 5, entry.variant)
    assert.notDeepEqual(result.snapshot, before, `${entry.variant} produced no state delta`)
    assert.ok(result.changes.length > 0, `${entry.variant} produced no change receipt`)
    entry.assertDelta?.(result)
  }
})

test('command wire boundary rejects transparent and throwing wrappers without throwing', () => {
  const batch = {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:wrapped', projectId: 'project:demo', baseRevision: 4, origin: 'ui',
    commands: [{ type: 'rename-project', name: 'Wrapped' }],
  }
  let reads = 0
  const transparent = new Proxy(batch, {
    get(target, property, receiver) {
      reads += 1
      return Reflect.get(target, property, receiver)
    },
  })
  assert.equal(parseWorldCommandBatch(transparent).success, false)
  assert.equal(reads, 0)

  const throwing = new Proxy(batch, {
    getPrototypeOf() {
      throw new Error('wrapper trap')
    },
  })
  assert.doesNotThrow(() => parseWorldCommandBatch(throwing))
  assert.equal(parseWorldCommandBatch(throwing).success, false)
})

test('one batch can create maximum-length ids and target them immediately', () => {
  const entityId = 'e'.repeat(256)
  const componentId = 'c'.repeat(256)
  const result = applyWorldCommandBatch(createValidWorldSnapshot(), {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:max-id', projectId: 'project:demo', baseRevision: 4, origin: 'ai',
    commands: [
      { type: 'add-entity', sceneId: 'scene:two', entity: { id: entityId, name: 'Max id', parentId: null, enabled: true, locked: false, tags: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] } },
      { type: 'add-component', sceneId: 'scene:two', entityId, component: { id: componentId, type: 'renderable', enabled: true, resourceId: 'resource:hero', visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } } },
    ],
  })
  assert.equal(result.success, true, JSON.stringify(result))
  if (result.success === true) assert.equal(result.snapshot.scenes[1].entities[0].components[0].id, componentId)

  const tooLong = structuredClone(result.success === true ? result.snapshot : createValidWorldSnapshot())
  const rejected = applyWorldCommandBatch(tooLong, {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:too-long', projectId: 'project:demo', baseRevision: tooLong.project.revision, origin: 'ui',
    commands: [{ type: 'remove-component', sceneId: 'scene:two', entityId, componentId: 'x'.repeat(257) }],
  })
  assert.equal(rejected.success, false)
})

test('identity-changing replacements report deterministic old removal and new addition identities', () => {
  const resourceResult = applyWorldCommandBatch(createValidWorldSnapshot(), {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:replace-resource-id', projectId: 'project:demo', baseRevision: 4, origin: 'ui',
    commands: [
      { type: 'replace-resource', resourceId: 'resource:hero', resource: { id: 'resource:hero-v2', type: 'model', name: 'Hero v2', workspacePath: 'Assets/hero-v2.glb', format: 'glb' } },
      { type: 'replace-component', sceneId: 'scene:one', entityId: 'entity:hero', componentId: 'component:hero-renderable', component: { id: 'component:hero-renderable', type: 'renderable', enabled: true, resourceId: 'resource:hero-v2', visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } } },
    ],
  })
  assert.equal(resourceResult.success, true, JSON.stringify(resourceResult))
  if (resourceResult.success === true) {
    assert.ok(resourceResult.changes.includes('resource:resource:hero:removed'))
    assert.ok(resourceResult.changes.includes('resource:resource:hero-v2:added'))
  }

  const sceneResult = applyWorldCommandBatch(createValidWorldSnapshot(), {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:replace-scene-id', projectId: 'project:demo', baseRevision: 4, origin: 'ui',
    commands: [{ type: 'replace-scene', sceneId: 'scene:two', reference: { id: 'scene:renamed', name: 'Renamed scene', documentPath: 'Worlds/demo/scenes/renamed.world-scene.json' }, scene: { schema: 'modly.world-scene.v1', projectId: 'project:demo', sceneId: 'scene:renamed', name: 'Renamed scene', environment: { backgroundColor: '#000000', ambientIntensity: 0 }, entities: [], sequences: [] } }],
  })
  assert.equal(sceneResult.success, true, JSON.stringify(sceneResult))
  if (sceneResult.success === true) assert.deepEqual(sceneResult.changes, ['scene:scene:renamed:added', 'scene:scene:two:removed'])

  const sequenceSnapshot = createValidWorldSnapshot()
  sequenceSnapshot.scenes[0].sequences.push({ id: 'sequence:old', name: 'Old', duration: { numerator: 1, denominator: 1 }, tracks: [] })
  const sequenceResult = applyWorldCommandBatch(sequenceSnapshot, {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:replace-sequence-id', projectId: 'project:demo', baseRevision: 4, origin: 'ui',
    commands: [{ type: 'replace-sequence', sceneId: 'scene:one', sequenceId: 'sequence:old', sequence: { id: 'sequence:new', name: 'New', duration: { numerator: 1, denominator: 1 }, tracks: [] } }],
  })
  assert.equal(sequenceResult.success, true, JSON.stringify(sequenceResult))
  if (sequenceResult.success === true) assert.deepEqual(sequenceResult.changes, ['scene:scene:one:sequence:sequence:new:added', 'scene:scene:one:sequence:sequence:old:removed'])

  const componentResult = applyWorldCommandBatch(createValidWorldSnapshot(), {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:replace-component-id', projectId: 'project:demo', baseRevision: 4, origin: 'ui',
    commands: [{ type: 'replace-component', sceneId: 'scene:one', entityId: 'entity:hero', componentId: 'component:hero-renderable', component: { id: 'component:hero-renderable-v2', type: 'renderable', enabled: true, resourceId: 'resource:hero', visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } } }],
  })
  assert.equal(componentResult.success, true, JSON.stringify(componentResult))
  if (componentResult.success === true) assert.deepEqual(componentResult.changes, [
    'scene:scene:one:entity:entity:hero:component:component:hero-renderable-v2:added',
    'scene:scene:one:entity:entity:hero:component:component:hero-renderable:removed',
  ])
})

test('inverse application restores exact content with a monotonic revision and no output aliases', () => {
  const input = createValidWorldSnapshot()
  const before = structuredClone(input)
  const applied = applyWorldCommandBatch(input, {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:inverse', projectId: 'project:demo', baseRevision: 4, origin: 'ui',
    commands: [{ type: 'rename-project', name: 'Changed' }],
  })
  assert.equal(applied.success, true, JSON.stringify(applied))
  if (applied.success !== true) return
  assert.notEqual(applied.snapshot, input)
  assert.notEqual(applied.inverse.snapshot, input)
  assert.notEqual(applied.snapshot, applied.inverse.snapshot)
  const restored = applyWorldCommandInverse(applied.snapshot, applied.inverse)
  assert.equal(restored.success, true, JSON.stringify(restored))
  if (restored.success !== true) return
  assert.equal(restored.snapshot.project.revision, 6)
  const restoredContent = structuredClone(restored.snapshot)
  restoredContent.project.revision = before.project.revision
  assert.deepEqual(restoredContent, before)
  assert.notEqual(restored.snapshot, applied.inverse.snapshot)
  restored.snapshot.project.name = 'Caller mutation'
  assert.equal(applied.inverse.snapshot.project.name, before.project.name)
})

test('command authority rejects conflicting sequence writers from workflow and AI batches', () => {
  const duplicateOpacity: WorldSequence = {
    id: 'sequence:duplicate-opacity', name: 'Duplicate opacity', duration: { numerator: 1, denominator: 1 }, tracks: [
      { id: 'track:opacity-a', type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity', keyframes: [] },
      { id: 'track:opacity-b', type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity', keyframes: [] },
    ],
  }
  const workflowSnapshot = createValidWorldSnapshot()
  const workflowResult = applyWorldCommandBatch(workflowSnapshot, {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:workflow-conflicting-sequence', projectId: 'project:demo', baseRevision: 4, origin: 'workflow',
    commands: [{ type: 'add-sequence', sceneId: 'scene:one', sequence: duplicateOpacity }],
  })
  assert.equal(workflowResult.success, false, JSON.stringify(workflowResult))
  if (!workflowResult.success) assert.ok(workflowResult.issues.some((issue) => issue.code === 'track-conflict'), JSON.stringify(workflowResult))
  assert.deepEqual(workflowSnapshot.scenes[0].sequences, [])

  const aiSnapshot = createValidWorldSnapshot()
  aiSnapshot.scenes[0].sequences.push({ id: 'sequence:replace-target', name: 'Replace target', duration: { numerator: 1, denominator: 1 }, tracks: [] })
  const conflictingTransform: WorldSequence = {
    id: 'sequence:replace-target', name: 'Replace target', duration: { numerator: 1, denominator: 1 }, tracks: [
      { id: 'track:position-a', type: 'transform', entityId: 'entity:hero', keyframes: [{ id: 'key:position-a', time: { numerator: 0, denominator: 1 }, value: { position: [0, 0, 0] } }] },
      { id: 'track:position-b', type: 'transform', entityId: 'entity:hero', keyframes: [{ id: 'key:position-b', time: { numerator: 1, denominator: 1 }, value: { position: [1, 0, 0] } }] },
    ],
  }
  const aiResult = applyWorldCommandBatch(aiSnapshot, {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:ai-conflicting-sequence', projectId: 'project:demo', baseRevision: 4, origin: 'ai',
    commands: [{ type: 'replace-sequence', sceneId: 'scene:one', sequenceId: 'sequence:replace-target', sequence: conflictingTransform }],
  })
  assert.equal(aiResult.success, false, JSON.stringify(aiResult))
  if (!aiResult.success) assert.ok(aiResult.issues.some((issue) => issue.code === 'track-conflict'), JSON.stringify(aiResult))
  assert.deepEqual(aiSnapshot.scenes[0].sequences[0].tracks, [])
})

import { Session } from 'node:inspector/promises'
import { validateWorldProjectSnapshot, normalizeWorldWorkspacePath } from './worldDocuments.ts'
import { normalizeWorldWireValue } from './worldWireValidation.ts'
import type { WorldProjectSnapshotV1 } from './worldModel.ts'
import type { WorldCommandBatchV1 } from './worldCommands.ts'

function createNestedInverseSnapshot(): WorldProjectSnapshotV1 {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.name = ' Demo world '
  snapshot.project.resources.push({
    id: 'resource:walk', type: 'animation', name: ' Walk ', workspacePath: 'Animations/walk.pose.json', format: 'pose-clip',
    sourceWorkspacePath: 'Assets/hero.glb', legacyWorkspacePath: 'Animations/legacy.json', clipId: 'walk', clipName: ' Walk ', durationSeconds: 2,
  })
  const scene = snapshot.scenes[0]
  scene.environment.fog = { color: '#445566', near: 2, far: 100 }
  const hero = scene.entities[0]
  hero.tags = ['hero', 'player']
  hero.components.push(
    { id: 'component:body', type: 'rigid-body', enabled: true, bodyType: 'dynamic', gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: true },
    { id: 'component:animation', type: 'animation-player', enabled: true, resourceId: 'resource:walk', autoplay: false, loop: true, speed: 1 },
    { id: 'component:behavior', type: 'behavior', enabled: true, bindings: [{
      id: 'binding:jump', event: { type: 'input', actionId: 'input:jump', phase: 'pressed' }, actions: [
        { type: 'apply-impulse', entityId: 'entity:hero', impulse: [0, 2, 0] },
        { type: 'set-visibility', entityId: 'entity:hero', visible: true },
      ],
    }] },
  )
  scene.sequences.push({ id: 'sequence:move', name: 'Move', duration: { numerator: 2, denominator: 1 }, tracks: [
    { id: 'track:move', type: 'transform', entityId: 'entity:hero', keyframes: [
      { id: 'key:start', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { id: 'key:end', time: { numerator: 2, denominator: 1 }, value: { position: [2, 0, 0] } },
    ] },
  ] })
  return snapshot
}

function inverseTransformBatch(snapshot: WorldProjectSnapshotV1, transactionId: string): WorldCommandBatchV1 {
  return {
    schema: 'modly.world-command-batch.v1' as const, transactionId, projectId: snapshot.project.projectId,
    baseRevision: snapshot.project.revision, origin: 'ui' as const,
    commands: [{ type: 'patch-entity' as const, sceneId: 'scene:one', entityId: 'entity:hero', patch: {
      transform: { position: [3, 2, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
    } }],
  }
}

function inverseGraphObjects(value: unknown, objects = new Set<object>()): Set<object> {
  if (typeof value !== 'object' || value === null || objects.has(value)) return objects
  objects.add(value)
  for (const child of Object.values(value)) inverseGraphObjects(child, objects)
  return objects
}

function assertInverseGraphsDetached(...graphs: unknown[]) {
  const objects = graphs.map((graph) => inverseGraphObjects(graph))
  for (let left = 0; left < objects.length; left += 1) {
    for (let right = left + 1; right < objects.length; right += 1) {
      for (const object of objects[left]) assert.equal(objects[right].has(object), false, `Graphs ${left}/${right} share nested data`)
    }
  }
}

function mutateInverseGraph(value: unknown) {
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'object' && child !== null) mutateInverseGraph(child)
    else if (typeof child === 'string') Reflect.set(value, key, `${child}:mutated`)
    else if (typeof child === 'number') Reflect.set(value, key, child + 1)
    else if (typeof child === 'boolean') Reflect.set(value, key, !child)
  }
}

function freezeInverseGraph<T>(value: T): T {
  for (const object of inverseGraphObjects(value)) Object.freeze(object)
  return value
}

test('ordinary transform keeps both real validations and clones only the mutable snapshot', async (t) => {
  const snapshot = createValidWorldSnapshot()
  const batch = inverseTransformBatch(snapshot, 'tx:inverse-copy-count')
  const inspector = new Session()
  inspector.connect()
  try {
    await inspector.post('Profiler.enable')
    await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    await inspector.post('Profiler.takePreciseCoverage')
    const result = applyWorldCommandBatch(snapshot, batch)
    const coverage = await inspector.post('Profiler.takePreciseCoverage')
    assert.equal(result.success, true, JSON.stringify(result))
    const scripts = coverage.result.filter((entry) => entry.url === new URL('./worldDocuments.ts', import.meta.url).href)
    assert.equal(scripts.length, 1, 'Actual document module must appear unambiguously')
    const count = (name: string) => {
      const functions = scripts[0].functions.filter((entry) => entry.functionName === name)
      assert.equal(functions.length, 1, `Actual synchronous function ${name} must appear unambiguously`)
      return functions[0].ranges[0].count
    }
    const counts = { validations: count('validateWorldProjectSnapshot'), clones: count('cloneWorldProjectSnapshot') }
    t.diagnostic(`Actual calls, not latency: ${JSON.stringify(counts)}`)
    assert.equal(counts.validations, 2, 'Input and result semantic validations must both remain')
    assert.equal(counts.clones, 1, 'Only the independent mutable draft needs an explicit clone')
  } finally {
    try { await inspector.post('Profiler.stopPreciseCoverage') } finally { inspector.disconnect() }
  }
})

test('command inverse and output detach every normalized nested object from callers and frozen inputs', () => {
  const input = createNestedInverseSnapshot()
  const batch = inverseTransformBatch(input, 'tx:inverse-nested')
  const inputBytes = JSON.stringify(input)
  const batchBytes = JSON.stringify(batch)
  const normalized = validateWorldProjectSnapshot(input)
  assert.equal(normalized.success, true, JSON.stringify(normalized))
  if (!normalized.success) return
  const result = applyWorldCommandBatch(input, batch)
  assert.equal(result.success, true, JSON.stringify(result))
  if (!result.success) return
  assert.deepEqual(result.inverse.snapshot, normalized.value)
  assert.equal(result.inverse.snapshot.project.name, 'Demo world')
  assert.equal(JSON.stringify(input), inputBytes)
  assert.equal(JSON.stringify(batch), batchBytes)
  assertInverseGraphsDetached(input, batch, normalized.value, result.inverse.snapshot, result.snapshot)
  const graphs = [input, result.inverse.snapshot, result.snapshot]
  for (let index = 0; index < graphs.length; index += 1) {
    const otherBytes = graphs.map((graph) => JSON.stringify(graph))
    mutateInverseGraph(graphs[index])
    assert.notEqual(JSON.stringify(graphs[index]), otherBytes[index])
    graphs.forEach((graph, other) => { if (other !== index) assert.equal(JSON.stringify(graph), otherBytes[other]) })
    assert.equal(JSON.stringify(batch), batchBytes)
  }

  const frozen = freezeInverseGraph(createNestedInverseSnapshot())
  const frozenBytes = JSON.stringify(frozen)
  const frozenBatch = freezeInverseGraph(inverseTransformBatch(frozen, 'tx:inverse-frozen'))
  const frozenBatchBytes = JSON.stringify(frozenBatch)
  const frozenResult = applyWorldCommandBatch(frozen, frozenBatch)
  assert.equal(frozenResult.success, true, JSON.stringify(frozenResult))
  if (!frozenResult.success) return
  assertInverseGraphsDetached(frozen, frozenBatch, frozenResult.inverse.snapshot, frozenResult.snapshot)
  mutateInverseGraph(frozenResult.inverse.snapshot)
  mutateInverseGraph(frozenResult.snapshot)
  assert.equal(JSON.stringify(frozen), frozenBytes)
  assert.equal(JSON.stringify(frozenBatch), frozenBatchBytes)
  for (const object of inverseGraphObjects(frozen)) assert.equal(Object.isFrozen(object), true)
})

test('failed later commands and revision guards preserve caller bytes and retained independent inverses', () => {
  const input = createNestedInverseSnapshot()
  const first = applyWorldCommandBatch(input, inverseTransformBatch(input, 'tx:inverse-retained-first'))
  assert.equal(first.success, true, JSON.stringify(first))
  if (!first.success) return
  const second = applyWorldCommandBatch(first.snapshot, inverseTransformBatch(first.snapshot, 'tx:inverse-retained-second'))
  assert.equal(second.success, true, JSON.stringify(second))
  if (!second.success) return
  assertInverseGraphsDetached(input, first.snapshot, first.inverse.snapshot, second.snapshot, second.inverse.snapshot)
  const retained = [input, first.snapshot, first.inverse.snapshot, second.snapshot, second.inverse.snapshot]
  const retainedBytes = retained.map((graph) => JSON.stringify(graph))
  const base = { schema: 'modly.world-command-batch.v1' as const, projectId: 'project:demo', baseRevision: 4, origin: 'ui' as const }
  const cases = [
    { suffix: 'missing', commands: [{ type: 'rename-project', name: 'Must roll back' }, { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:missing', patch: { name: 'Missing' } }], code: 'entity-missing', path: 'batch.commands[1]' },
    { suffix: 'locked', commands: [{ type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { locked: true } }, { type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { name: 'Blocked' } }], code: 'entity-locked', path: 'batch.commands[1].entityId' },
    { suffix: 'revision', commands: [{ type: 'rename-project', name: 'Stale' }], code: 'revision-conflict', path: 'batch.baseRevision' },
  ]
  for (const entry of cases) {
    const batch = { ...base, transactionId: `tx:inverse-failed-${entry.suffix}`, baseRevision: entry.suffix === 'revision' ? 3 : 4, commands: entry.commands }
    const batchBytes = JSON.stringify(batch)
    const failed = applyWorldCommandBatch(input, batch)
    assert.equal(failed.success, false, JSON.stringify(failed))
    if (!failed.success) assert.deepEqual(failed.issues.map(({ code, path }) => ({ code, path })), [{ code: entry.code, path: entry.path }])
    retained.forEach((graph, index) => assert.equal(JSON.stringify(graph), retainedBytes[index]))
    assert.equal(JSON.stringify(batch), batchBytes)
  }
  const earlierBytes = JSON.stringify(first)
  mutateInverseGraph(second.inverse.snapshot)
  mutateInverseGraph(second.snapshot)
  assert.equal(JSON.stringify(first), earlierBytes)
})

test('decoded leading-space resource paths retain the second semantic rejection before command success', () => {
  for (const encoded of ['%20Assets/hero.glb', '%2520Assets/hero.glb']) {
    const input = createValidWorldSnapshot()
    input.project.resources[0].workspacePath = encoded
    const inputBytes = JSON.stringify(input)
    assert.equal(normalizeWorldWorkspacePath(encoded), ' Assets/hero.glb')
    const first = validateWorldProjectSnapshot(input)
    assert.equal(first.success, true, JSON.stringify(first))
    if (!first.success) continue
    assert.equal(first.value.project.resources[0].workspacePath, ' Assets/hero.glb')
    const wire = normalizeWorldWireValue(first.value, 'snapshot')
    assert.equal(wire.success, true, JSON.stringify(wire))
    if (!wire.success) continue
    const second = validateWorldProjectSnapshot(wire.value)
    assert.equal(second.success, false, JSON.stringify(second))
    const batch = { schema: 'modly.world-command-batch.v1', transactionId: 'tx:inverse-encoded', projectId: 'project:demo', baseRevision: 4, origin: 'ui', commands: [{ type: 'rename-project', name: 'Must reject' }] }
    const result = applyWorldCommandBatch(input, batch)
    assert.equal(result.success, false, JSON.stringify(result))
    if (!result.success) assert.deepEqual(result.issues.map(({ code, path }) => ({ code, path })), [{ code: 'workspace-path', path: 'project.resources[0].workspacePath' }])
    assert.equal(JSON.stringify(input), inputBytes)
  }
})
