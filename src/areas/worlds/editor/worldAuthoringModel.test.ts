import assert from 'node:assert/strict'
import test from 'node:test'

import { applyWorldCommandBatch, type WorldCommand } from '../core/worldCommands.ts'
import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import type { WorldComponent } from '../core/worldComponentRegistry.ts'
import { buildInspectorComponentReplacement } from './worldsWorkbenchModel.ts'
import { createDeterministicWorldEditorIdentityGenerator, WorldEditorCommandBuilderError } from './worldEditorCommandBuilders.ts'
import * as animationAuthoring from './worldAuthoringModel.ts'
import { applyWorldEditorCommandBatch, createWorldEditorSession, redoWorldEditorSession, undoWorldEditorSession } from '../core/worldSessions.ts'
import {
  buildAddButtonInputActionCommands,
  buildAddAdvancedColliderCommands,
  buildAddAxis2dInputActionCommands,
  buildAddEmptyEntityCommands,
  buildAddPrimitiveColliderCommands,
  buildAttachAudioSourceCommands,
  buildComponentPresetCommands,
  buildCharacterControllerPresetCommands,
  buildRemoveInputActionCommands,
  buildRemoveWorldComponentCommands,
  buildRenameInputActionCommands,
  buildSetPrimaryComponentCommands,
  buildUpdateButtonInputActionCommands,
  buildUpdateInputBindingCommands,
  createCompatibleWorldBehaviorAction,
  createCompatibleWorldBehaviorEvent,
  getCompatibleWorldBehaviorActionTypes,
  getCompatibleWorldBehaviorEventTypes,
  getEligibleWorldColliderSourceResources,
  isValidWorldKeyboardControl,
  replaceWorldColliderComponent,
  replaceWorldRigidBodyComponent,
  replaceWorldBehaviorComponent,
  resolveDefaultWorldColliderSourceResourceId,
} from './worldAuthoringModel.ts'

const projectKey = `world-${'a'.repeat(32)}`

function animationOwner(snapshot: WorldProjectSnapshotV1) {
  return animationAuthoring.captureWorldGltfAnimationOwner(context(snapshot, 'animation-owner'), 'entity:hero')
}
const discoveredClip = { clipIndex: 1, name: 'Walk', durationSeconds: 2, trackCount: 1, available: true }

test('glTF authoring copies only actual clip scalars and marks invalid timing unavailable', () => {
  const borrowed = [
    { name: 'Walk', duration: 0, tracks: [{}], validate: () => true, uuid: 'not-document-data' },
    { name: 'Walk', duration: 2, tracks: [{}, {}], validate: () => true },
    { name: 'Bad', duration: Number.NaN, tracks: [{}], validate: () => true },
    { name: 'Bad tracks', duration: 2, tracks: [{}], validate: () => false },
  ]
  const clips = animationAuthoring.describeWorldGltfAnimationClips(borrowed)
  assert.deepEqual(clips.slice(0, 2), [
    { clipIndex: 0, name: 'Walk', durationSeconds: 0, trackCount: 1, available: true },
    { clipIndex: 1, name: 'Walk', durationSeconds: 2, trackCount: 2, available: true },
  ])
  assert.equal(clips[2].available, false)
  assert.equal(clips[3].available, false)
  assert.equal(JSON.stringify(clips).includes('uuid'), false)
  borrowed[0].name = 'Changed later'
  assert.equal(clips[0].name, 'Walk')
  Reflect.set(borrowed[0], 'name', 42)
  const malformed = animationAuthoring.describeWorldGltfAnimationClips(borrowed)[0]
  assert.equal(malformed.name, '')
  assert.equal(malformed.available, false)
})

test('glTF Create plus Add is one validated canonical resource/player batch, with explicit nonfirst index', () => {
  const snapshot = createValidWorldSnapshot()
  const original = structuredClone(snapshot)
  const commands = animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'animation-add'), animationOwner(snapshot), { kind: 'clip', clip: discoveredClip }, 'add')
  assert.deepEqual(commands.map((command) => command.type), ['add-resource', 'add-component'])
  const result = apply(snapshot, commands, 'tx:animation-add')
  const resource = result.project.resources.find((candidate) => candidate.type === 'animation')
  assert.deepEqual(resource, { id: resource?.id, type: 'animation', name: 'Walk', workspacePath: 'Assets/hero.glb', format: 'gltf-clip', clipIndex: 1, clipName: 'Walk', durationSeconds: 2 })
  const player = result.scenes[0].entities[0].components.find((component) => component.type === 'animation-player')
  assert.deepEqual(player, { id: player?.id, type: 'animation-player', enabled: true, resourceId: resource?.id, autoplay: false, loop: true, speed: 1 })
  assert.deepEqual(snapshot, original)
})

test('glTF zero index and duration survive exact selection without fabricated metadata; incompatible names are omitted', () => {
  for (const name of [' Walk ', 'a'.repeat(257), 'line\nname', '']) {
    const snapshot = createValidWorldSnapshot()
    const commands = animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, `zero-${name.length}`), animationOwner(snapshot), { kind: 'clip', clip: { ...discoveredClip, clipIndex: 0, name, durationSeconds: 0 } }, 'create')
    const resource = apply(snapshot, commands, `tx:zero-${name.length}`).project.resources.at(-1)!
    assert.equal(resource.type, 'animation')
    if (resource.type === 'animation') {
      assert.equal(resource.clipIndex, 0)
      assert.equal(Object.hasOwn(resource, 'clipName'), false)
      assert.equal(Object.hasOwn(resource, 'durationSeconds'), false)
      assert.equal(Object.hasOwn(resource, 'clipId'), false)
    }
  }
  const snapshot = createValidWorldSnapshot()
  const resource = apply(snapshot, animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'long-duration'), animationOwner(snapshot), { kind: 'clip', clip: { ...discoveredClip, durationSeconds: 86401 } }, 'create'), 'tx:long-duration').project.resources.at(-1)!
  assert.equal(Object.hasOwn(resource, 'durationSeconds'), false)
})

test('existing compatible animation Add creates no resource, and ambiguous equivalent clips require explicit identity', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:walk', type: 'animation', name: 'Walk', workspacePath: 'Assets/hero.glb', format: 'gltf-clip', clipIndex: 1, clipName: 'Walk' })
  const commands = animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'existing-add'), animationOwner(snapshot), { kind: 'resource', resourceId: 'resource:walk' }, 'add')
  assert.deepEqual(commands.map((command) => command.type), ['add-component'])
  assert.equal(apply(snapshot, commands, 'tx:existing-add').project.resources.length, 2)
  snapshot.project.resources.push({ ...snapshot.project.resources[1], id: 'resource:walk-copy' })
  assert.throws(() => animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'ambiguous'), animationOwner(snapshot), { kind: 'clip', clip: discoveredClip }, 'add'), /Choose an existing animation/)
  const explicit = animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'explicit'), animationOwner(snapshot), { kind: 'clip', clip: discoveredClip, resourceId: 'resource:walk-copy' }, 'add')
  assert.equal(explicit[0].type === 'add-component' ? explicit[0].component.type === 'animation-player' && explicit[0].component.resourceId : null, 'resource:walk-copy')
})

test('whole-player Rebind preserves identity, signed settings, behavior references and shared resource; same binding is a no-op', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:idle', type: 'animation', name: 'Idle', workspacePath: 'Assets/hero.glb', format: 'gltf-clip', clipIndex: 0 })
  const player = { id: 'component:player', type: 'animation-player' as const, enabled: true, resourceId: 'resource:idle', autoplay: true, loop: false, speed: -2 }
  const behavior = { id: 'component:animation-behavior', type: 'behavior' as const, enabled: true, bindings: [{ id: 'binding:animation-start', event: { type: 'start' as const }, actions: [{ type: 'play-animation' as const, entityId: 'entity:hero', componentId: player.id }] }] }
  snapshot.scenes[0].entities[0].components.push(player, behavior)
  const original = structuredClone(snapshot)
  const commands = animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'rebind'), animationOwner(snapshot), { kind: 'clip', clip: discoveredClip }, 'rebind')
  const rebound = apply(snapshot, commands, 'tx:animation-rebind')
  const updated = rebound.scenes[0].entities[0].components.find((component) => component.id === player.id)
  assert.deepEqual(updated, { ...player, resourceId: rebound.project.resources.at(-1)!.id })
  assert.deepEqual(rebound.scenes[0].entities[0].components.at(-1), behavior)
  assert.deepEqual(rebound.project.resources[1], original.project.resources[1])
  assert.deepEqual(animationAuthoring.buildWorldGltfAnimationCommands(context(rebound, 'no-op'), animationOwner(rebound), { kind: 'resource', resourceId: rebound.project.resources.at(-1)!.id }, 'rebind'), [])
  snapshot.scenes[0].entities[0].components = snapshot.scenes[0].entities[0].components.filter((component) => component.type !== 'behavior')
  player.enabled = false
  const disabled = apply(snapshot, animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'disabled-player'), animationOwner(snapshot), { kind: 'clip', clip: discoveredClip }, 'rebind'), 'tx:disabled-player')
  assert.equal(disabled.scenes[0].entities[0].components.at(-1)?.enabled, false)
})

test('animation authority rejects stale revision, wrong project/scene/entity/model/path and inherited locks before creating resources', () => {
  const snapshot = createValidWorldSnapshot()
  const owner = animationOwner(snapshot)
  for (const patch of [{ baseRevision: owner.baseRevision - 1 }, { projectKey: 'other' }, { projectId: 'project:other' }, { sceneId: 'scene:two' }, { entityId: 'entity:other' }, { modelResourceId: 'resource:other' }, { modelWorkspacePath: 'Assets/other.glb' }]) {
    assert.throws(() => animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'stale'), { ...owner, ...patch }, { kind: 'clip', clip: discoveredClip }, 'add'))
  }
  const original = structuredClone(snapshot)
  snapshot.scenes[0].entities.push({ ...structuredClone(snapshot.scenes[0].entities[0]), id: 'entity:locked-parent', components: [], locked: true })
  snapshot.scenes[0].entities[0].parentId = 'entity:locked-parent'
  assert.throws(() => animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'locked'), owner, { kind: 'clip', clip: discoveredClip }, 'add'), /Locked/)
  assert.deepEqual(snapshot.project.resources, original.project.resources)
})

test('animation authoring rejects disabled/missing/wrong models, pose/unbound resources, invalid clips and duplicate players atomically', () => {
  for (const mutate of [
    (snapshot: WorldProjectSnapshotV1) => { snapshot.scenes[0].entities[0].enabled = false },
    (snapshot: WorldProjectSnapshotV1) => { snapshot.scenes[0].entities[0].components[0].enabled = false },
    (snapshot: WorldProjectSnapshotV1) => { snapshot.scenes[0].entities[0].components = [] },
    (snapshot: WorldProjectSnapshotV1) => { snapshot.project.resources = [] },
    (snapshot: WorldProjectSnapshotV1) => { snapshot.project.resources[0] = { ...snapshot.project.resources[0], type: 'audio', format: 'wav' } },
    (snapshot: WorldProjectSnapshotV1) => { snapshot.project.resources[0] = { ...snapshot.project.resources[0], type: 'model', format: 'ply-mesh' } },
  ]) {
    const snapshot = createValidWorldSnapshot()
    const owner = animationOwner(snapshot)
    mutate(snapshot)
    const original = structuredClone(snapshot)
    assert.throws(() => animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'invalid-model'), owner, { kind: 'clip', clip: discoveredClip }, 'add'))
    assert.deepEqual(snapshot, original)
  }
  const snapshot = createValidWorldSnapshot()
  for (const clip of [{ ...discoveredClip, available: false }, { ...discoveredClip, clipIndex: -1 }, { ...discoveredClip, durationSeconds: Infinity }, { ...discoveredClip, trackCount: 0 }]) {
    assert.throws(() => animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'bad-clip'), animationOwner(snapshot), { kind: 'clip', clip }, 'add'))
  }
  snapshot.project.resources.push({ id: 'resource:pose', type: 'animation', name: 'Pose', workspacePath: 'Assets/pose.json', format: 'pose-clip' }, { id: 'resource:unbound', type: 'animation', name: 'Other', workspacePath: 'Assets/other.glb', format: 'gltf-clip' })
  for (const resourceId of ['resource:pose', 'resource:unbound', 'resource:hero', 'resource:missing']) assert.throws(() => animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'bad-resource'), animationOwner(snapshot), { kind: 'resource', resourceId }, 'add'))
  const added = apply(snapshot, animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'one-player'), animationOwner(snapshot), { kind: 'clip', clip: discoveredClip }, 'add'), 'tx:one-player')
  assert.throws(() => animationAuthoring.buildWorldGltfAnimationCommands(context(added, 'duplicate-player'), animationOwner(added), { kind: 'clip', clip: { ...discoveredClip, clipIndex: 2 } }, 'add'), /already has/)
})

test('Create/Add/Rebind canonical Undo/Redo restores exact shared identities and complete components', () => {
  const snapshot = createValidWorldSnapshot()
  const commands = animationAuthoring.buildWorldGltfAnimationCommands(context(snapshot, 'history'), animationOwner(snapshot), { kind: 'clip', clip: discoveredClip }, 'add')
  const initial = createWorldEditorSession(snapshot)
  assert.equal(initial.success, true)
  if (!initial.success) throw new Error('Animation initial session rejected.')
  const applied = applyWorldEditorCommandBatch(initial.session, { schema: 'modly.world-command-batch.v1', transactionId: 'tx:animation-history', projectId: snapshot.project.projectId, baseRevision: snapshot.project.revision, origin: 'ui', commands })
  assert.equal(applied.success, true)
  if (!applied.success) throw new Error('Animation history batch rejected.')
  const undone = undoWorldEditorSession(applied.session)
  assert.equal(undone.success, true)
  if (!undone.success) throw new Error('Animation Undo rejected.')
  assert.deepEqual(undone.session.snapshot.project.resources, snapshot.project.resources)
  assert.deepEqual(undone.session.snapshot.scenes, snapshot.scenes)
  const redone = redoWorldEditorSession(undone.session)
  assert.equal(redone.success, true)
  if (!redone.success) throw new Error('Animation Redo rejected.')
  assert.deepEqual(redone.session.snapshot.project.resources, applied.session.snapshot.project.resources)
  assert.deepEqual(redone.session.snapshot.scenes, applied.session.snapshot.scenes)
})

test('character preset provisions real capsule, kinematic body and independent WASD/Space inputs atomically', () => {
  const snapshot = createValidWorldSnapshot()
  const original = structuredClone(snapshot)
  const commands = buildComponentPresetCommands(context(snapshot, 'character'), 'entity:hero', 'character')
  const result = apply(snapshot, commands, 'tx:character')
  const entity = result.scenes[0].entities[0]
  const character = entity.components.find((component) => component.type === 'character-controller')
  assert.ok(character, 'Character preset must author a controller, not a behavior')
  const collider = entity.components.find((component) => component.id === character.colliderComponentId)
  assert.ok(collider?.type === 'collider' && collider.shape === 'capsule')
  assert.equal(collider.radius, 0.35)
  assert.equal(collider.halfHeight, 0.55)
  assert.equal(collider.sensor, false)
  assert.equal(collider.purpose, 'simulation')
  assert.ok(entity.components.some((component) => component.type === 'rigid-body' && component.enabled && component.bodyType === 'kinematic-position'))
  assert.deepEqual([character.speed, character.jumpSpeed, character.maxSlopeDegrees], [4, 6, 45])
  const move = result.project.inputActions.find((action) => action.id === character.moveActionId)
  const jump = result.project.inputActions.find((action) => action.id === character.jumpActionId)
  assert.equal(move?.valueType, 'axis2d')
  assert.deepEqual(move?.bindings, [
    { kind: 'axis2d', device: 'keyboard', control: 'KeyA', targetAxis: 'x', scale: -1 },
    { kind: 'axis2d', device: 'keyboard', control: 'KeyD', targetAxis: 'x', scale: 1 },
    { kind: 'axis2d', device: 'keyboard', control: 'KeyW', targetAxis: 'y', scale: 1 },
    { kind: 'axis2d', device: 'keyboard', control: 'KeyS', targetAxis: 'y', scale: -1 },
  ])
  assert.deepEqual(jump?.bindings, [{ kind: 'button', device: 'keyboard', control: 'Space' }])
  assert.notEqual(jump?.id, 'input:jump', 'Same-name input must not be repurposed')
  assert.equal(jump?.name, 'Jump 2')
  assert.deepEqual(result.project.inputActions[0], original.project.inputActions[0])
  assert.equal(commands.filter((command) => command.type === 'replace-input-actions').length, 1)
  assert.equal(result.project.revision, snapshot.project.revision + 1)
  assert.deepEqual(snapshot, original)
})

test('button keyboard edits retain every other binding and edited binding metadata', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.inputActions[0].bindings = [
    { kind: 'button', device: 'mouse', control: '0' },
    { kind: 'button', device: 'keyboard', control: 'Space', scale: 0.5 },
    { kind: 'button', device: 'keyboard', control: 'KeyJ' },
  ]
  const original = structuredClone(snapshot)
  const result = apply(snapshot, buildUpdateButtonInputActionCommands(snapshot, 'input:jump', { name: 'Leap', control: 'KeyL' }), 'tx:edit-jump')
  assert.deepEqual(result.project.inputActions[0].bindings, [
    original.project.inputActions[0].bindings[0],
    { kind: 'button', device: 'keyboard', control: 'KeyL', scale: 0.5 },
    original.project.inputActions[0].bindings[2],
  ])
  assert.deepEqual(snapshot, original)
})

function apply(snapshot: WorldProjectSnapshotV1, commands: WorldCommand[], transactionId: string): WorldProjectSnapshotV1 {
  const result = applyWorldCommandBatch(snapshot, {
    schema: 'modly.world-command-batch.v1',
    transactionId,
    projectId: snapshot.project.projectId,
    baseRevision: snapshot.project.revision,
    origin: 'ui',
    commands,
  })
  assert.equal(result.success, true, result.success ? undefined : result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'))
  if (!result.success) throw new Error('Command batch failed.')
  return result.snapshot
}

function context(snapshot: WorldProjectSnapshotV1, seed: string) {
  return {
    snapshot,
    projectKey,
    activeSceneId: 'scene:one',
    identities: createDeterministicWorldEditorIdentityGenerator(seed),
  }
}

function capsule(id: string): Extract<WorldComponent, { type: 'collider' }> {
  return { id, type: 'collider', enabled: true, purpose: 'simulation', shape: 'capsule', radius: 0.4, halfHeight: 0.7, sensor: false, friction: 0.6, restitution: 0.1 }
}

function sphere(id: string): Extract<WorldComponent, { type: 'collider' }> {
  return { id, type: 'collider', enabled: true, purpose: 'simulation', shape: 'sphere', radius: 0.65, sensor: false, friction: 0.2, restitution: 0.4, collisionLayer: 3, collisionMask: 5 }
}

function body(bodyType: Extract<WorldComponent, { type: 'rigid-body' }>['bodyType'] = 'kinematic-position', enabled = true): Extract<WorldComponent, { type: 'rigid-body' }> {
  return { id: 'component:existing-body', type: 'rigid-body', enabled, bodyType, gravityScale: 0.5, linearDamping: 0.2, angularDamping: 0.3, canSleep: true }
}

function convex(id = 'component:convex', resourceId = 'resource:hero'): Extract<WorldComponent, { type: 'collider' }> {
  return { id, type: 'collider', enabled: true, purpose: 'simulation', shape: 'convex', resourceId, sensor: false, friction: 0.4, restitution: 0.1, collisionLayer: 1, collisionMask: 0xffff }
}

function staticMesh(id = 'component:mesh', resourceId = 'resource:hero', sensor = false): Extract<WorldComponent, { type: 'collider' }> {
  return { id, type: 'collider', enabled: true, purpose: 'simulation', shape: 'mesh', resourceId, sensor, friction: 0.4, restitution: 0.1, collisionLayer: 1, collisionMask: 0xffff }
}

test('advanced collider source helpers prefer selected entity renderable and filter only mesh model resources', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources = [
    { id: 'resource:first', type: 'model', name: 'First', workspacePath: 'Assets/first.glb', format: 'glb' },
    { id: 'resource:selected', type: 'model', name: 'Selected', workspacePath: 'Assets/selected.ply', format: 'ply-mesh' },
    { id: 'resource:points', type: 'model', name: 'Points', workspacePath: 'Assets/points.ply', format: 'ply-points' },
    { id: 'resource:splat', type: 'model', name: 'Splat', workspacePath: 'Assets/splat.ply', format: 'gaussian-ply' },
    { id: 'resource:audio', type: 'audio', name: 'Impact', workspacePath: 'Assets/impact.wav', format: 'wav' },
  ]
  const renderable = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'renderable')
  assert.ok(renderable?.type === 'renderable')
  renderable.resourceId = 'resource:selected'
  renderable.enabled = false
  renderable.visible = false
  assert.deepEqual(getEligibleWorldColliderSourceResources(snapshot).map((resource) => resource.id), ['resource:first', 'resource:selected'])
  assert.equal(resolveDefaultWorldColliderSourceResourceId(snapshot, 'scene:one', 'entity:hero'), 'resource:selected')

  const withoutRenderable = structuredClone(snapshot)
  withoutRenderable.scenes[0].entities[0].components = []
  assert.equal(resolveDefaultWorldColliderSourceResourceId(withoutRenderable, 'scene:one', 'entity:hero'), null)
  const missing = structuredClone(snapshot)
  if (renderable?.type === 'renderable') missing.scenes[0].entities[0].components[0] = { ...renderable, resourceId: 'resource:missing' }
  assert.equal(resolveDefaultWorldColliderSourceResourceId(missing, 'scene:one', 'entity:hero'), null)
})

test('advanced collider builders require explicit eligible sources and emit canonical resource ids only', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:mesh', type: 'model', name: 'Mesh', workspacePath: 'Assets/mesh.ply', format: 'ply-mesh' })
  const convexCommands = buildAddAdvancedColliderCommands(context(snapshot, 'add-convex'), 'entity:hero', { shape: 'convex', resourceId: 'resource:mesh' })
  const authored = convexCommands[0].component
  assert.equal(authored.type, 'collider')
  if (authored.type === 'collider') {
    assert.equal(authored.shape, 'convex')
    assert.equal(authored.resourceId, 'resource:mesh')
    assert.equal(Object.hasOwn(authored, 'workspacePath'), false)
    assert.equal(Object.hasOwn(authored, 'vertices'), false)
  }
  assert.throws(() => buildAddAdvancedColliderCommands(context(snapshot, 'points'), 'entity:hero', { shape: 'mesh', resourceId: 'resource:missing' }), /GLB, GLTF, or PLY mesh/)
  snapshot.project.resources.push({ id: 'resource:points', type: 'model', name: 'Points', workspacePath: 'Assets/points.ply', format: 'ply-points' })
  assert.throws(() => buildAddAdvancedColliderCommands(context(snapshot, 'bad-format'), 'entity:hero', { shape: 'convex', resourceId: 'resource:points' }), /GLB, GLTF, or PLY mesh/)
})

test('advanced collider replacement rebuilds clean variants and preserves common fields', () => {
  const snapshot = createValidWorldSnapshot()
  const original = sphere('component:source-sphere')
  snapshot.scenes[0].entities[0].components.push(original)
  const meshCommands = replaceWorldColliderComponent(snapshot, 'scene:one', 'entity:hero', original.id, { shape: 'mesh', resourceId: 'resource:hero' })
  const mesh = meshCommands[0].component
  assert.deepEqual(mesh, {
    id: original.id, type: 'collider', enabled: true, purpose: 'simulation', shape: 'mesh', resourceId: 'resource:hero',
    sensor: false, friction: 0.2, restitution: 0.4, collisionLayer: 3, collisionMask: 5,
  })
  assert.equal(Object.hasOwn(mesh, 'radius'), false)
  const backToBox = replaceWorldColliderComponent(apply(snapshot, meshCommands, 'tx:mesh'), 'scene:one', 'entity:hero', original.id, { shape: 'box' })[0].component
  assert.equal(backToBox.type, 'collider')
  if (backToBox.type !== 'collider') throw new Error('Expected collider replacement.')
  assert.equal(backToBox.shape, 'box')
  assert.equal(Object.hasOwn(backToBox, 'resourceId'), false)
  assert.throws(() => replaceWorldColliderComponent(snapshot, 'scene:one', 'entity:hero', original.id, { shape: 'convex' }), /mesh source/i)
})

test('static mesh authoring guards moving bodies, sensors, and enable toggles without auto-converting to hulls', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].components.push(body('dynamic', true))
  assert.throws(() => buildAddAdvancedColliderCommands(context(snapshot, 'dynamic-mesh'), 'entity:hero', { shape: 'mesh', resourceId: 'resource:hero' }), /fixed body/)
  assert.doesNotThrow(() => buildAddAdvancedColliderCommands(context(snapshot, 'dynamic-convex'), 'entity:hero', { shape: 'convex', resourceId: 'resource:hero' }))

  const disabledBody = createValidWorldSnapshot()
  disabledBody.scenes[0].entities[0].components.push(body('dynamic', false), staticMesh('component:disabled-body-mesh'))
  const existingBody = disabledBody.scenes[0].entities[0].components.find((component) => component.type === 'rigid-body')!
  assert.throws(() => replaceWorldRigidBodyComponent(disabledBody, 'scene:one', 'entity:hero', existingBody.id, { enabled: true }), /fixed body/)

  const disabledMesh = createValidWorldSnapshot()
  disabledMesh.scenes[0].entities[0].components.push(body('dynamic', true), { ...staticMesh('component:disabled-mesh'), enabled: false })
  assert.throws(() => replaceWorldColliderComponent(disabledMesh, 'scene:one', 'entity:hero', 'component:disabled-mesh', { enabled: true }), /fixed body/)

  const sensorMesh = createValidWorldSnapshot()
  sensorMesh.scenes[0].entities[0].components.push(body('dynamic', true), staticMesh('component:sensor-mesh', 'resource:hero', true))
  assert.throws(() => replaceWorldRigidBodyComponent(sensorMesh, 'scene:one', 'entity:hero', 'component:existing-body', { bodyType: 'kinematic-position' }), /fixed body/)

  const fixed = createValidWorldSnapshot()
  fixed.scenes[0].entities[0].components.push(body('fixed', true))
  assert.doesNotThrow(() => buildAddAdvancedColliderCommands(context(fixed, 'fixed-mesh'), 'entity:hero', { shape: 'mesh', resourceId: 'resource:hero' }))
  const noBody = createValidWorldSnapshot()
  assert.doesNotThrow(() => buildAddAdvancedColliderCommands(context(noBody, 'no-body-mesh'), 'entity:hero', { shape: 'mesh', resourceId: 'resource:hero' }))
})

test('body presets reuse compatible authored advanced colliders and reject moving static meshes', () => {
  const convexSnapshot = createValidWorldSnapshot()
  convexSnapshot.scenes[0].entities[0].components.push(convex())
  assert.deepEqual(buildComponentPresetCommands(context(convexSnapshot, 'convex-dynamic'), 'entity:hero', 'dynamic-body').map((command) => command.type), ['add-component'])
  const meshFixed = createValidWorldSnapshot()
  meshFixed.scenes[0].entities[0].components.push(staticMesh())
  assert.deepEqual(buildComponentPresetCommands(context(meshFixed, 'mesh-fixed'), 'entity:hero', 'fixed-body').map((command) => command.type), ['add-component'])
  assert.throws(() => buildComponentPresetCommands(context(meshFixed, 'mesh-dynamic'), 'entity:hero', 'dynamic-body'), /fixed body/)
})

test('character reuses explicitly selected typed inputs and compatible body/capsule unchanged', () => {
  let snapshot = createValidWorldSnapshot()
  snapshot = apply(snapshot, buildAddAxis2dInputActionCommands(snapshot, context(snapshot, 'move').identities, { name: 'Move' }), 'tx:move')
  snapshot.scenes[0].entities[0].components.push(capsule('component:existing-capsule'), body())
  const original = structuredClone(snapshot)
  const commands = buildCharacterControllerPresetCommands(context(snapshot, 'reuse'), 'entity:hero', {
    moveActionId: snapshot.project.inputActions.at(-1)!.id, jumpActionId: 'input:jump',
  })
  assert.equal(commands.length, 1)
  assert.equal(commands[0].type, 'add-component')
  const result = apply(snapshot, commands, 'tx:reuse')
  const controller = result.scenes[0].entities[0].components.at(-1)
  assert.ok(controller?.type === 'character-controller')
  assert.equal(controller.colliderComponentId, 'component:existing-capsule')
  assert.equal(controller.jumpActionId, 'input:jump')
  assert.deepEqual(result.project.inputActions, snapshot.project.inputActions)
  assert.deepEqual(result.scenes[0].entities[0].components.slice(0, -1), snapshot.scenes[0].entities[0].components)
  assert.deepEqual(snapshot, original)
})

for (const [bodyType, enabled] of [['fixed', true], ['dynamic', true], ['kinematic-velocity', true], ['kinematic-position', false]] as const) {
  test(`character refuses existing ${enabled ? 'enabled' : 'disabled'} ${bodyType} body without overwrite`, () => {
    const snapshot = createValidWorldSnapshot()
    snapshot.scenes[0].entities[0].components.push(body(bodyType, enabled))
    const before = structuredClone(snapshot)
    assert.throws(() => buildCharacterControllerPresetCommands(context(snapshot, 'body-refusal'), 'entity:hero'), /existing body.*Kinematic position/i)
    assert.deepEqual(snapshot, before)
  })
}

test('character preserves incompatible colliders and same-name inputs while adding dedicated companions', () => {
  let snapshot = createValidWorldSnapshot()
  snapshot = apply(snapshot, buildAddAxis2dInputActionCommands(snapshot, context(snapshot, 'existing-move').identities, { name: 'move' }), 'tx:existing-move')
  snapshot.scenes[0].entities[0].components.push(
    { ...capsule('component:disabled'), enabled: false },
    { ...capsule('component:sensor'), sensor: true },
    { ...capsule('component:navigation'), purpose: 'editor-navigation' },
  )
  const before = structuredClone(snapshot)
  const result = apply(snapshot, buildCharacterControllerPresetCommands(context(snapshot, 'dedicated'), 'entity:hero', { jumpActionId: null }), 'tx:dedicated')
  const added = result.scenes[0].entities[0].components.slice(before.scenes[0].entities[0].components.length)
  assert.deepEqual(added.map((component) => component.type), ['collider', 'rigid-body', 'character-controller'])
  const character = added.at(-1)
  assert.ok(character?.type === 'character-controller')
  assert.equal(Object.hasOwn(character, 'jumpActionId'), false)
  assert.equal(result.project.inputActions.at(-1)?.name, 'Move 2')
  assert.deepEqual(result.project.inputActions.slice(0, -1), before.project.inputActions)
  assert.deepEqual(result.scenes[0].entities[0].components.slice(0, -3), before.scenes[0].entities[0].components)
  assert.deepEqual(snapshot, before)
})

test('character rejects duplicate controllers, missing or locked owners and unavailable typed inputs', () => {
  const snapshot = createValidWorldSnapshot()
  assert.throws(() => buildCharacterControllerPresetCommands(context(snapshot, 'missing'), 'entity:missing'), /does not exist/)
  for (const inputs of [{ moveActionId: 'input:gone' }, { moveActionId: 'input:jump' }, { jumpActionId: 'input:gone' }]) {
    assert.throws(() => buildCharacterControllerPresetCommands(context(snapshot, 'invalid-input'), 'entity:hero', inputs), /existing.*action/i)
  }
  const withCharacter = apply(snapshot, buildCharacterControllerPresetCommands(context(snapshot, 'first'), 'entity:hero'), 'tx:first')
  assert.throws(() => buildCharacterControllerPresetCommands(context(withCharacter, 'duplicate'), 'entity:hero'), /already has a character/)
  const moveId = withCharacter.project.inputActions.find((action) => action.valueType === 'axis2d')!.id
  const wrongKindSnapshot = structuredClone(snapshot)
  wrongKindSnapshot.project.inputActions.push(structuredClone(withCharacter.project.inputActions.find((action) => action.id === moveId)!))
  assert.throws(() => buildCharacterControllerPresetCommands(context(wrongKindSnapshot, 'wrong-jump'), 'entity:hero', { jumpActionId: moveId }), /existing button/)
  const locked = structuredClone(snapshot)
  locked.scenes[0].entities[0].locked = true
  assert.throws(() => buildCharacterControllerPresetCommands(context(locked, 'locked'), 'entity:hero'), /locked/)
  locked.scenes[0].entities.push({ ...structuredClone(locked.scenes[0].entities[0]), id: 'entity:child', parentId: 'entity:hero', locked: false, components: [] })
  assert.throws(() => buildCharacterControllerPresetCommands(context(locked, 'ancestor'), 'entity:child'), /locked/)
})

test('character allocation skips existing global IDs', () => {
  const snapshot = createValidWorldSnapshot()
  const builderContext = context(snapshot, 'collision')
  const fallback = builderContext.identities
  let calls = 0
  builderContext.identities = { ...fallback, nextId: (namespace, hint) => ++calls === 1 ? 'input:jump' : fallback.nextId(namespace, hint) }
  const result = apply(snapshot, buildCharacterControllerPresetCommands(builderContext, 'entity:hero'), 'tx:collision')
  const ids = [...result.project.inputActions.map((action) => action.id), ...result.scenes[0].entities[0].components.map((component) => component.id)]
  assert.equal(ids.length, new Set(ids).size)
})

test('axis binding edits preserve other rows, action identity and non-keyboard data while rejecting invalid changes', () => {
  let snapshot = createValidWorldSnapshot()
  snapshot = apply(snapshot, buildAddAxis2dInputActionCommands(snapshot, context(snapshot, 'axis-edit').identities, { name: 'Move' }), 'tx:axis-add')
  const action = snapshot.project.inputActions.at(-1)!
  action.bindings.push({ kind: 'axis2d', device: 'gamepad', control: 'Axis0', targetAxis: 'x', scale: 0.5 })
  const before = structuredClone(snapshot)
  const replacement = { kind: 'axis2d' as const, device: 'keyboard' as const, control: 'ArrowLeft', targetAxis: 'x' as const, scale: -0.5 }
  const edited = apply(snapshot, buildUpdateInputBindingCommands(snapshot, action.id, 0, replacement), 'tx:axis-edit')
  assert.deepEqual(edited.project.inputActions.at(-1)?.bindings, [replacement, ...action.bindings.slice(1)])
  const renamed = apply(edited, buildRenameInputActionCommands(edited, action.id, 'Walk'), 'tx:axis-rename')
  assert.equal(renamed.project.inputActions.at(-1)?.id, action.id)
  assert.equal(renamed.project.inputActions.at(-1)?.valueType, 'axis2d')
  assert.deepEqual(renamed.project.inputActions.at(-1)?.bindings, edited.project.inputActions.at(-1)?.bindings)
  assert.throws(() => buildUpdateInputBindingCommands(snapshot, action.id, 0, { ...replacement, control: 'KeyD' }), /already bound/i)
  assert.throws(() => buildUpdateInputBindingCommands(snapshot, action.id, 99, replacement), /unavailable/)
  assert.throws(() => buildUpdateInputBindingCommands(snapshot, 'input:missing', 0, replacement), /does not exist/)
  assert.throws(() => buildUpdateInputBindingCommands(snapshot, action.id, 0, { kind: 'button', device: 'keyboard', control: 'KeyF' }), /kind|type/i)
  assert.throws(() => buildUpdateInputBindingCommands(snapshot, action.id, 0, { ...replacement, scale: NaN }), /finite|number/i)
  assert.throws(() => buildRenameInputActionCommands(snapshot, action.id, 'jump'), /already exists/)
  assert.deepEqual(snapshot, before)
})

test('character dependency removal and body mode changes remain validated after authoring', () => {
  let snapshot = createValidWorldSnapshot()
  snapshot = apply(snapshot, buildCharacterControllerPresetCommands(context(snapshot, 'dependencies'), 'entity:hero'), 'tx:dependencies')
  const entity = snapshot.scenes[0].entities[0]
  const character = entity.components.find((component) => component.type === 'character-controller')!
  const rigidBody = entity.components.find((component) => component.type === 'rigid-body')!
  assert.throws(() => buildRemoveInputActionCommands(snapshot, character.moveActionId), /reference/i)
  assert.throws(() => buildRemoveWorldComponentCommands(snapshot, 'scene:one', entity.id, character.colliderComponentId), /reference/i)
  const changeBody: WorldCommand = { type: 'replace-component', sceneId: 'scene:one', entityId: entity.id, componentId: rigidBody.id, component: { ...rigidBody, bodyType: 'dynamic' } }
  const reject = (source: WorldProjectSnapshotV1, commands: WorldCommand[]) => applyWorldCommandBatch(source, {
    schema: 'modly.world-command-batch.v1', transactionId: 'tx:reject', projectId: source.project.projectId, baseRevision: source.project.revision, origin: 'ui', commands,
  })
  assert.equal(reject(snapshot, [changeBody]).success, false)
  snapshot = apply(snapshot, [{ type: 'replace-component', sceneId: 'scene:one', entityId: entity.id, componentId: character.id, component: { ...character, enabled: false } }], 'tx:disable')
  snapshot = apply(snapshot, [changeBody], 'tx:body-mode')
  assert.equal(reject(snapshot, [{ type: 'replace-component', sceneId: 'scene:one', entityId: entity.id, componentId: character.id, component: { ...character, enabled: true } }]).success, false)
  assert.throws(() => buildRemoveInputActionCommands(snapshot, character.moveActionId), /reference/i)
  const cleared = buildInspectorComponentReplacement(character, 'jumpActionId', null)
  assert.equal(Object.hasOwn(cleared, 'jumpActionId'), false)
})

test('empty and physics presets produce valid atomic command plans with dedicated trigger sensors', () => {
  let snapshot = createValidWorldSnapshot()
  const empty = buildAddEmptyEntityCommands(context(snapshot, 'empty'), { name: 'Ground' })
  assert.deepEqual(empty.map((command) => command.type), ['add-entity'])
  snapshot = apply(snapshot, empty, 'tx:add-empty')
  const groundId = empty[0].entity.id

  const fixed = buildComponentPresetCommands(context(snapshot, 'fixed'), groundId, 'fixed-body')
  assert.deepEqual(fixed.map((command) => command.type), ['add-component', 'add-component'])
  snapshot = apply(snapshot, fixed, 'tx:add-fixed')
  const ground = snapshot.scenes[0].entities.find((entity) => entity.id === groundId)!
  assert.equal(ground.components.some((component) => component.type === 'collider' && component.shape === 'box' && !component.sensor), true)
  assert.equal(ground.components.some((component) => component.type === 'rigid-body' && component.bodyType === 'fixed'), true)

  const trigger = buildComponentPresetCommands(context(snapshot, 'trigger'), groundId, 'trigger')
  assert.deepEqual(trigger.map((command) => command.type), ['add-component', 'add-component'])
  snapshot = apply(snapshot, trigger, 'tx:add-trigger')
  const updated = snapshot.scenes[0].entities.find((entity) => entity.id === groundId)!
  const triggerComponent = updated.components.find((component) => component.type === 'trigger')
  const sensor = updated.components.find((component) => component.type === 'collider' && component.sensor)
  assert.equal(triggerComponent?.type, 'trigger')
  assert.equal(sensor?.type, 'collider')
  if (triggerComponent?.type === 'trigger' && sensor?.type === 'collider') assert.equal(triggerComponent.colliderComponentId, sensor.id)
})

test('body presets reuse authored enabled simulation primitive colliders without adding fallback boxes', () => {
  for (const [preset, collider] of [
    ['dynamic-body', sphere('component:author-sphere')],
    ['fixed-body', capsule('component:author-capsule')],
  ] as const) {
    const snapshot = createValidWorldSnapshot()
    snapshot.scenes[0].entities[0].components.push(collider)
    const before = structuredClone(snapshot)
    const commands = buildComponentPresetCommands(context(snapshot, `${preset}:${collider.shape}`), 'entity:hero', preset)
    assert.deepEqual(commands.map((command) => command.type), ['add-component'])
    const result = apply(snapshot, commands, `tx:${preset}:${collider.shape}`)
    assert.deepEqual(result.scenes[0].entities[0].components.slice(0, -1), before.scenes[0].entities[0].components)
    assert.equal(result.scenes[0].entities[0].components.some((component) => component.type === 'collider' && component.shape === 'box'), false)
    const rigidBody = result.scenes[0].entities[0].components.at(-1)
    assert.equal(rigidBody?.type, 'rigid-body')
    if (rigidBody?.type === 'rigid-body') assert.equal(rigidBody.bodyType, preset === 'dynamic-body' ? 'dynamic' : 'fixed')
    assert.deepEqual(snapshot, before)
  }
})

test('body presets ignore disabled, sensor and navigation colliders and preserve them when adding fallback box', () => {
  for (const [label, collider] of [
    ['disabled', { ...sphere('component:disabled-sphere'), enabled: false }],
    ['sensor', { ...capsule('component:sensor-capsule'), sensor: true }],
    ['navigation', { ...sphere('component:navigation-sphere'), purpose: 'editor-navigation' as const }],
  ] as const) {
    const snapshot = createValidWorldSnapshot()
    snapshot.scenes[0].entities[0].components.push(collider)
    const before = structuredClone(snapshot)
    const commands = buildComponentPresetCommands(context(snapshot, `fallback:${label}`), 'entity:hero', 'dynamic-body')
    assert.deepEqual(commands.map((command) => command.type), ['add-component', 'add-component'])
    const result = apply(snapshot, commands, `tx:fallback:${label}`)
    assert.deepEqual(result.scenes[0].entities[0].components.slice(0, before.scenes[0].entities[0].components.length), before.scenes[0].entities[0].components)
    const fallback = result.scenes[0].entities[0].components.at(-2)
    assert.equal(fallback?.type, 'collider')
    if (fallback?.type === 'collider') {
      assert.equal(fallback.enabled, true)
      assert.equal(fallback.purpose, 'simulation')
      assert.equal(fallback.sensor, false)
      assert.equal(fallback.shape, 'box')
    }
    assert.equal(result.scenes[0].entities[0].components.at(-1)?.type, 'rigid-body')
    assert.deepEqual(snapshot, before)
  }
})

test('body presets use an existing compatible primitive among multiple colliders without converting advanced geometry', () => {
  const snapshot = createValidWorldSnapshot()
  const disabledBox: Extract<WorldComponent, { type: 'collider' }> = {
    id: 'component:disabled-box',
    type: 'collider',
    enabled: false,
    purpose: 'simulation',
    shape: 'box',
    halfExtents: [1, 1, 1],
    sensor: false,
    friction: 0.8,
    restitution: 0.2,
  }
  const advanced: Extract<WorldComponent, { type: 'collider' }> = {
    id: 'component:convex',
    type: 'collider',
    enabled: true,
    purpose: 'simulation',
    shape: 'convex',
    resourceId: 'resource:hero',
    sensor: false,
    friction: 0.4,
    restitution: 0.1,
  }
  snapshot.scenes[0].entities[0].components.push(disabledBox, advanced, sphere('component:compatible-sphere'))
  const before = structuredClone(snapshot)
  const commands = buildComponentPresetCommands(context(snapshot, 'multi-compatible'), 'entity:hero', 'fixed-body')
  assert.deepEqual(commands.map((command) => command.type), ['add-component'])
  const result = apply(snapshot, commands, 'tx:multi-compatible')
  assert.deepEqual(result.scenes[0].entities[0].components.slice(0, -1), before.scenes[0].entities[0].components)
  assert.deepEqual(snapshot, before)
})

test('primitive collider authoring adds clean sphere and capsule command plans without mutating the source snapshot', () => {
  const snapshot = createValidWorldSnapshot()
  const before = structuredClone(snapshot)

  const sphereCommands = buildAddPrimitiveColliderCommands(context(snapshot, 'sphere'), 'entity:hero', { shape: 'sphere' })
  assert.deepEqual(sphereCommands.map((command) => command.type), ['add-component'])
  let applied = apply(snapshot, sphereCommands, 'tx:add-sphere')
  let collider = applied.scenes[0].entities[0].components.at(-1)
  assert.deepEqual(collider, {
    id: collider?.id,
    type: 'collider',
    enabled: true,
    purpose: 'simulation',
    shape: 'sphere',
    radius: 0.5,
    sensor: false,
    friction: 0.5,
    restitution: 0,
    collisionLayer: 1,
    collisionMask: 0xffff,
  })
  assert.equal(applied.project.revision, snapshot.project.revision + 1)

  const capsuleCommands = buildAddPrimitiveColliderCommands(context(applied, 'capsule'), 'entity:hero', { shape: 'capsule', sensor: true })
  applied = apply(applied, capsuleCommands, 'tx:add-capsule')
  collider = applied.scenes[0].entities[0].components.at(-1)
  assert.equal(collider?.type, 'collider')
  if (collider?.type === 'collider') {
    assert.equal(collider.shape, 'capsule')
    assert.equal(collider.radius, 0.35)
    assert.equal(collider.halfHeight, 0.55)
    assert.equal(collider.sensor, true)
  }
  assert.deepEqual(snapshot, before)
})

test('collider replacement rebuilds discriminated variants and preserves identity, common metadata and non-navigation purpose', () => {
  const snapshot = createValidWorldSnapshot()
  const original: Extract<WorldComponent, { type: 'collider' }> = {
    id: 'component:author-collider',
    type: 'collider',
    enabled: false,
    purpose: 'editor-navigation',
    shape: 'box',
    halfExtents: [0.2, 0.75, 0.4],
    sensor: true,
    friction: 0.25,
    restitution: 0.35,
    collisionLayer: 3,
    collisionMask: 7,
  }
  snapshot.scenes[0].entities[0].components.push(original)
  const before = structuredClone(snapshot)

  let commands = replaceWorldColliderComponent(snapshot, 'scene:one', 'entity:hero', original.id, { shape: 'sphere' })
  let replacement = commands[0].component
  assert.deepEqual(replacement, {
    id: original.id,
    type: 'collider',
    enabled: false,
    purpose: 'editor-navigation',
    shape: 'sphere',
    radius: 0.75,
    sensor: true,
    friction: 0.25,
    restitution: 0.35,
    collisionLayer: 3,
    collisionMask: 7,
  })
  assert.equal(Object.hasOwn(replacement, 'halfExtents'), false)

  commands = replaceWorldColliderComponent(snapshot, 'scene:one', 'entity:hero', original.id, { shape: 'capsule', radius: 0.3, halfHeight: 0.9 })
  replacement = commands[0].component as Extract<WorldComponent, { type: 'collider' }>
  assert.equal(replacement.shape, 'capsule')
  if (replacement.shape === 'capsule') assert.deepEqual([replacement.radius, replacement.halfHeight], [0.3, 0.9])
  assert.equal(Object.hasOwn(replacement, 'halfExtents'), false)
  assert.throws(() => replaceWorldColliderComponent(snapshot, 'scene:one', 'entity:hero', original.id, { shape: 'sphere', radius: 0 }), /positive|invalid/i)
  assert.deepEqual(snapshot, before)
})

test('primary camera and listener builders atomically unmark every prior primary', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].components.push({ id: 'component:camera-one', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 })
  snapshot.scenes[0].entities.push({
    id: 'entity:camera-two', name: 'Camera two', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: 'component:camera-two', type: 'camera', enabled: false, projection: 'perspective', primary: false, near: 0.1, far: 100, fieldOfView: 60 }],
  })
  const commands = buildSetPrimaryComponentCommands(snapshot, 'scene:one', 'entity:camera-two', 'component:camera-two')
  assert.equal(commands.length, 2)
  const applied = apply(snapshot, commands, 'tx:primary-camera')
  const cameras = applied.scenes[0].entities.flatMap((entity) => entity.components.filter((component) => component.type === 'camera'))
  assert.deepEqual(cameras.map((camera) => camera.type === 'camera' && camera.primary), [false, true])
  assert.deepEqual(cameras.map((camera) => camera.enabled), [true, true])

  const listenerSnapshot = structuredClone(applied)
  listenerSnapshot.scenes[0].entities[0].components.push({ id: 'component:listener-one', type: 'audio-listener', enabled: true, primary: true })
  listenerSnapshot.scenes[0].entities[1].components.push({ id: 'component:listener-two', type: 'audio-listener', enabled: false, primary: false })
  const listenerCommands = buildSetPrimaryComponentCommands(listenerSnapshot, 'scene:one', 'entity:camera-two', 'component:listener-two')
  assert.equal(listenerCommands.length, 2)
  const listenerApplied = apply(listenerSnapshot, listenerCommands, 'tx:primary-listener')
  const listeners = listenerApplied.scenes[0].entities.flatMap((entity) => entity.components.filter((component) => component.type === 'audio-listener'))
  assert.deepEqual(listeners.map((listener) => listener.type === 'audio-listener' && listener.primary), [false, true])
  assert.deepEqual(listeners.map((listener) => listener.enabled), [true, true])
})

test('audio attachment reuses a safe canonical resource and provisions one primary listener', () => {
  let snapshot = createValidWorldSnapshot()
  const commands = buildAttachAudioSourceCommands(context(snapshot, 'audio-one'), 'entity:hero', {
    workspacePath: 'Workflows/audio/impact.wav', format: 'wav', name: 'Impact',
  })
  assert.deepEqual(commands.map((command) => command.type), ['add-resource', 'add-component', 'add-component'])
  snapshot = apply(snapshot, commands, 'tx:attach-audio')
  assert.equal(snapshot.project.resources.filter((resource) => resource.type === 'audio').length, 1)
  assert.equal(snapshot.scenes[0].entities.flatMap((entity) => entity.components).filter((component) => component.type === 'audio-listener' && component.primary).length, 1)

  const second = buildAttachAudioSourceCommands(context(snapshot, 'audio-two'), 'entity:hero', {
    workspacePath: 'Workflows/audio/impact.wav', format: 'wav', name: 'Impact',
  })
  assert.deepEqual(second.map((command) => command.type), ['add-component'])
  snapshot = apply(snapshot, second, 'tx:attach-audio-again')
  assert.equal(snapshot.project.resources.filter((resource) => resource.type === 'audio').length, 1)
  assert.equal(snapshot.scenes[0].entities.flatMap((entity) => entity.components).filter((component) => component.type === 'audio-listener').length, 1)
})

test('named button input plans validate KeyboardEvent codes and refuse referenced removal', () => {
  let snapshot = createValidWorldSnapshot()
  assert.equal(isValidWorldKeyboardControl('Space'), true)
  assert.equal(isValidWorldKeyboardControl('KeyN'), true)
  assert.equal(isValidWorldKeyboardControl('../KeyN'), false)
  const add = buildAddButtonInputActionCommands(snapshot, createDeterministicWorldEditorIdentityGenerator('input'), { name: 'Interact', control: 'KeyN' })
  snapshot = apply(snapshot, add, 'tx:add-input')
  const actionId = snapshot.project.inputActions.at(-1)!.id
  assert.equal(snapshot.project.inputActions.at(-1)!.bindings[0].control, 'KeyN')
  const update = buildUpdateButtonInputActionCommands(snapshot, actionId, { name: 'Next', control: 'KeyN' })
  snapshot = apply(snapshot, update, 'tx:update-input')
  assert.equal(snapshot.project.inputActions.find((action) => action.id === actionId)?.name, 'Next')

  const behavior = buildComponentPresetCommands(context(snapshot, 'behavior'), 'entity:hero', 'behavior')[0]
  assert.equal(behavior.type, 'add-component')
  if (behavior.type !== 'add-component' || behavior.component.type !== 'behavior') return
  behavior.component.bindings = [{ id: 'binding:input', event: { type: 'input', actionId, phase: 'pressed' }, actions: [] }]
  snapshot = apply(snapshot, [behavior], 'tx:add-behavior')
  assert.throws(() => buildRemoveInputActionCommands(snapshot, actionId), /reference|invalid/i)

  const triggerCommands = buildComponentPresetCommands(context(snapshot, 'referenced-trigger'), 'entity:hero', 'trigger')
  snapshot = apply(snapshot, triggerCommands, 'tx:add-referenced-trigger')
  const sensor = triggerCommands.find((command) => command.type === 'add-component' && command.component.type === 'collider')
  assert.equal(sensor?.type, 'add-component')
  if (sensor?.type === 'add-component') {
    assert.throws(() => buildRemoveWorldComponentCommands(snapshot, 'scene:one', 'entity:hero', sensor.component.id), /referenced/i)
  }
})

test('behavior factories expose only compatible runtime events and actions, including stop audio but no sequence event', () => {
  let snapshot = createValidWorldSnapshot()
  snapshot = apply(snapshot, buildAddButtonInputActionCommands(snapshot, createDeterministicWorldEditorIdentityGenerator('behavior-input'), { name: 'Interact', control: 'KeyN' }), 'tx:behavior-input')
  snapshot = apply(snapshot, buildAttachAudioSourceCommands(context(snapshot, 'behavior-audio'), 'entity:hero', {
    workspacePath: 'Workflows/audio/impact.wav', format: 'wav', name: 'Impact',
  }), 'tx:behavior-audio')
  snapshot = apply(snapshot, buildComponentPresetCommands(context(snapshot, 'behavior-body'), 'entity:hero', 'dynamic-body'), 'tx:behavior-body')
  snapshot = apply(snapshot, buildComponentPresetCommands(context(snapshot, 'behavior-trigger'), 'entity:hero', 'trigger'), 'tx:behavior-trigger')

  const events = getCompatibleWorldBehaviorEventTypes(snapshot, 'scene:one')
  assert.deepEqual(events, ['start', 'input', 'trigger-enter', 'trigger-exit', 'timer'])
  assert.doesNotMatch(events.join(','), /sequence/)
  const actions = getCompatibleWorldBehaviorActionTypes(snapshot, 'scene:one')
  assert.equal(actions.includes('play-audio'), true)
  assert.equal(actions.includes('stop-audio'), true)
  assert.equal(actions.includes('apply-impulse'), true)
  assert.equal(actions.includes('set-component-property'), true)
  assert.equal(createCompatibleWorldBehaviorEvent(snapshot, 'scene:one', 'input').type, 'input')
  assert.equal(createCompatibleWorldBehaviorAction(snapshot, 'scene:one', 'stop-audio').type, 'stop-audio')
  assert.deepEqual(createCompatibleWorldBehaviorAction(snapshot, 'scene:one', 'change-scene'), { type: 'change-scene', sceneId: 'scene:two' })
})

test('behavior replacement rejects a Start change-scene self-cycle before returning commands', () => {
  const snapshot = createValidWorldSnapshot()
  const existing = { id: 'component:start-one', type: 'behavior' as const, enabled: true, bindings: [] }
  snapshot.scenes[0].entities[0].components.push(existing)
  const replacement = {
    ...structuredClone(existing),
    bindings: [{ id: 'binding:start-self', event: { type: 'start' as const }, actions: [{ type: 'change-scene' as const, sceneId: 'scene:one' }] }],
  }

  assert.throws(
    () => replaceWorldBehaviorComponent(snapshot, 'scene:one', 'entity:hero', existing.id, replacement),
    (error) => {
      assert.equal(error instanceof WorldEditorCommandBuilderError, true)
      if (!(error instanceof WorldEditorCommandBuilderError)) return false
      assert.equal(error.code, 'runtime-start-transition-cycle')
      assert.equal(error.message, 'Start behavior created a scene transition cycle at scene:one.')
      return true
    },
  )
})

test('behavior replacement rejects a multi-scene Start cycle but accepts an acyclic transition', () => {
  const snapshot = createValidWorldSnapshot()
  const behaviorOne = { id: 'component:start-one', type: 'behavior' as const, enabled: true, bindings: [] }
  const behaviorTwo = { id: 'component:start-two', type: 'behavior' as const, enabled: true, bindings: [] }
  snapshot.scenes[0].entities[0].components.push(behaviorOne)
  snapshot.scenes[1].entities.push({
    id: 'entity:scene-two-behavior', name: 'Scene two behavior', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [behaviorTwo],
  })
  const oneToTwo = {
    ...structuredClone(behaviorOne),
    bindings: [{ id: 'binding:one-to-two', event: { type: 'start' as const }, actions: [{ type: 'change-scene' as const, sceneId: 'scene:two' }] }],
  }
  const acyclic = replaceWorldBehaviorComponent(snapshot, 'scene:one', 'entity:hero', behaviorOne.id, oneToTwo)
  assert.equal(acyclic.length, 1)
  const withOneToTwo = apply(snapshot, acyclic, 'tx:one-to-two')
  const twoToOne = {
    ...structuredClone(behaviorTwo),
    bindings: [{ id: 'binding:two-to-one', event: { type: 'start' as const }, actions: [{ type: 'change-scene' as const, sceneId: 'scene:one' }] }],
  }

  assert.throws(
    () => replaceWorldBehaviorComponent(withOneToTwo, 'scene:two', 'entity:scene-two-behavior', behaviorTwo.id, twoToOne),
    (error) => {
      assert.equal(error instanceof WorldEditorCommandBuilderError, true)
      if (!(error instanceof WorldEditorCommandBuilderError)) return false
      assert.equal(error.code, 'runtime-start-transition-cycle')
      assert.equal(error.message, 'Start behavior created a scene transition cycle at scene:one.')
      return true
    },
  )
})
