import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntimeWorldSnapshot } from '../runtime/_testFixtures.ts'
import { planWorldEditorRunCollision } from './worldEditorRunCollision.ts'
import { parseWorldPhysicsMainMessage, parseWorldPhysicsWorkerMessage } from '../runtime/worldPhysicsProtocol.ts'
import type { WorldColliderComponent } from '../core/worldComponentRegistry.ts'

test('Run plans frozen enabled authored solids without Play camera, gameplay or canonical mutation', () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.scenes[0].entities[0].components = []
  const hero = snapshot.scenes[0].entities[1]
  hero.components = hero.components.filter(item => item.type !== 'character-controller')
  const collider = hero.components.find(item => item.type === 'collider')!
  if (collider.type === 'collider') collider.purpose = 'editor-navigation'
  const before = structuredClone(snapshot)
  const result = planWorldEditorRunCollision(snapshot, 'scene:one')
  assert.equal(result.success, true)
  if (!result.success) return
  assert.deepEqual(result.plan.physics.bodies.map(item => item.entityId), ['entity:hero', 'entity:crate', 'entity:ground'])
  for (const body of result.plan.physics.bodies) {
    assert.equal(body.bodyType, 'fixed')
    assert.equal(body.controller, undefined)
    assert.ok(body.colliders.every(item => !item.sensor && item.triggerComponentIds.length === 0))
  }
  assert.deepEqual(snapshot, before)
})

test('Run excludes ancestor-disabled, invisible, sensor and group-ineligible solids', () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.scenes[0].entities[0].enabled = false
  snapshot.scenes[0].entities[0].components = []
  snapshot.scenes[0].entities[2].parentId = 'entity:camera'
  const hero = snapshot.scenes[0].entities[1].components.find(item => item.type === 'renderable')!
  if (hero.type === 'renderable') hero.visible = false
  const floor = snapshot.scenes[0].entities[3].components[0]
  if (floor.type === 'collider') floor.collisionMask = 2
  const result = planWorldEditorRunCollision(snapshot, 'scene:one')
  assert.equal(result.success, true)
  if (result.success) assert.equal(result.plan.physics.bodies.length, 0)
})

test('navigation protocol admits only frozen scenes and bounded camera-only requests/replies', () => {
  const navigation = { position: [0, 2, 0], frontSurfaces: [] }
  const base = { version: 1, kind: 'init', generationId: 1, scene: { sceneId: 'scene:one', gravity: [0, -9.81, 0], bodies: [] }, navigation }
  assert.equal(parseWorldPhysicsMainMessage(base).success, true)
  for (const position of [[NaN, 0, 0], [1e10, 0, 0]]) assert.equal(parseWorldPhysicsMainMessage({ ...base, navigation: { ...navigation, position } }).success, false)
  const step = { version: 1, kind: 'navigation-step', generationId: 1, sequence: 1, steps: [{ move: [0, -1], jumpPressed: false, boost: false }] }
  assert.equal(parseWorldPhysicsMainMessage(step).success, true)
  assert.equal(parseWorldPhysicsMainMessage({ ...step, steps: Array(5).fill(step.steps[0]) }).success, false)
  assert.equal(parseWorldPhysicsMainMessage({ ...step, steps: [{ ...step.steps[0], move: [2, 0] }] }).success, false)
  assert.equal(parseWorldPhysicsWorkerMessage({ version: 1, kind: 'navigation-pose', generationId: 1, sequence: 1, position: [0, 2, 0], grounded: true, recovered: false }).success, true)
})

test('Run admits every canonical shape and preserves transformed rect/tri geometry and front side', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const shapes: WorldColliderComponent[] = [
    { shape: 'box', halfExtents: [1, 2, 3] }, { shape: 'sphere', radius: 1 }, { shape: 'capsule', radius: .3, halfHeight: .6 },
    { shape: 'convex', resourceId: 'resource:hero' }, { shape: 'mesh', resourceId: 'resource:hero' },
    { shape: 'rect-surface', halfExtents: [2, 3], sidedness: 'front' }, { shape: 'tri-surface', vertices: [[0, 0], [0, 2], [2, 0]], sidedness: 'double' },
  ].map((shape, i) => ({ ...shape, type: 'collider', id: `collider:${i}`, enabled: true, sensor: false, friction: .5, restitution: 0, purpose: shape.shape === 'mesh' ? 'simulation' : 'editor-navigation' }) as WorldColliderComponent)
  snapshot.scenes[0].entities = shapes.map((shape, i) => ({
    id: `entity:${i}`, name: 'Solid', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [4, 2, 3], rotation: [Math.PI / 2, 0, 0], scale: [2, 1, 3] }, components: [shape],
  }))
  const result = planWorldEditorRunCollision(snapshot, 'scene:one')
  assert.equal(result.success, true, JSON.stringify(result))
  if (!result.success) return
  assert.deepEqual(result.plan.physics.bodies.map(body => body.colliders[0].shape.kind), ['box', 'sphere', 'capsule', 'convexHullSource', 'trimeshSource', 'trimesh', 'trimesh'])
  const rect = result.plan.physics.bodies[5].colliders[0].shape
  assert.equal(rect.kind, 'trimesh')
  if (rect.kind === 'trimesh') assert.deepEqual(Array.from(rect.vertices), [-4, 0, -9, -4, 0, 9, 4, 0, 9, 4, 0, -9])
  assert.equal(result.frontSurfaces.length, 1)
  assert.deepEqual(result.frontSurfaces[0].point, [4, 2, 3])
  assert.ok(Math.abs(result.frontSurfaces[0].normal[2] - 1) < 1e-6)
})

test('Run preserves explicit navigation on hidden renderables but omits hidden or disabled simulation visuals', () => {
  for (const disabled of [false, true]) {
    const snapshot = createRuntimeWorldSnapshot()
    const hero = snapshot.scenes[0].entities[1]
    hero.components = hero.components.filter(component => component.type !== 'character-controller')
    const renderable = hero.components.find(component => component.type === 'renderable')!
    if (renderable.type === 'renderable') { renderable.visible = disabled; renderable.enabled = !disabled }
    let result = planWorldEditorRunCollision(snapshot, 'scene:one')
    assert.equal(result.success, true)
    if (result.success) assert.equal(result.plan.physics.bodies.some(body => body.entityId === hero.id), false)
    const collider = hero.components.find(component => component.type === 'collider')!
    if (collider.type === 'collider') collider.purpose = 'editor-navigation'
    result = planWorldEditorRunCollision(snapshot, 'scene:one')
    assert.equal(result.success, true)
    if (result.success) assert.equal(result.plan.physics.bodies.some(body => body.entityId === hero.id), true)
  }
})
