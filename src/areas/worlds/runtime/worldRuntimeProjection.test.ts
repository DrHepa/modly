import assert from 'node:assert/strict'
import test from 'node:test'

import { validateWorldProjectSnapshot } from '../core/worldDocuments.ts'
import { createRuntimeWorldSnapshot } from './_testFixtures.ts'
import { planWorldRuntimeScene, projectWorldRuntimeScene } from './worldRuntimeProjection.ts'
import { resolveWorldRuntimeTransforms } from './worldRuntimeEntityGraph.ts'

test('runtime projection produces numeric primitive physics DTOs without paths or URLs', () => {
  const snapshot = createRuntimeWorldSnapshot()
  assert.equal(validateWorldProjectSnapshot(snapshot).success, true)
  const result = projectWorldRuntimeScene(snapshot, 'scene:one')
  assert.equal(result.success, true)
  if (!result.success) return
  assert.equal(result.value.primaryCameraEntityId, 'entity:camera')
  assert.equal(result.value.primaryListenerEntityId, 'entity:camera')
  assert.deepEqual(result.value.physics.bodies.map((body) => body.entityId), ['entity:hero', 'entity:crate', 'entity:ground', 'entity:zone'])
  assert.deepEqual(result.value.physics.bodies.flatMap((body) => body.colliders.map((collider) => collider.shape.kind)), ['capsule', 'box', 'box', 'sphere'])
  assert.equal(result.value.physics.bodies[0]?.colliders[0]?.collisionLayer, 2)
  assert.equal(result.value.physics.bodies[0]?.colliders[0]?.collisionMask, 0xffff)
  assert.doesNotMatch(JSON.stringify(result.value.physics), /workspacePath|documentPath|url|Object3D/)
})

test('runtime projection explicitly rejects convex and mesh simulation colliders', () => {
  for (const shape of ['convex', 'mesh'] as const) {
    const snapshot = createRuntimeWorldSnapshot()
    const ground = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:ground')!
    ground.components[0] = {
      id: 'component:ground-collider', type: 'collider', enabled: true, purpose: 'simulation',
      shape, resourceId: 'resource:hero', sensor: false, friction: 0.8, restitution: 0,
      collisionLayer: 1, collisionMask: 0xffff,
    }
    const result = projectWorldRuntimeScene(snapshot, 'scene:one')
    assert.equal(result.success, false)
    if (!result.success) assert.equal(result.issues[0]?.code, 'unsupported-physics-shape')
  }
})

test('runtime scene plan accepts canonical convex and fixed mesh collider resource sources', () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:mesh-collider', type: 'model', name: 'Collider mesh', workspacePath: 'Assets/collider.glb', format: 'glb' })
  const ground = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:ground')!
  ground.transform.scale = [-2, 3, 0.5]
  ground.components[0] = {
    id: 'component:ground-collider', type: 'collider', enabled: true, purpose: 'simulation',
    shape: 'mesh', resourceId: 'resource:mesh-collider', sensor: false, friction: 0.8, restitution: 0,
    collisionLayer: 1, collisionMask: 0xffff,
  }
  const crate = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:crate')!
  crate.components[0] = {
    id: 'component:crate-collider', type: 'collider', enabled: true, purpose: 'simulation',
    shape: 'convex', resourceId: 'resource:hero', sensor: false, friction: 0.5, restitution: 0.1,
    collisionLayer: 4, collisionMask: 0xffff,
  }
  const plan = planWorldRuntimeScene(snapshot, 'scene:one')
  assert.equal(plan.success, true)
  if (!plan.success) return
  const groundShape = plan.value.physics.bodies.find((body) => body.entityId === 'entity:ground')?.colliders[0]?.shape
  assert.deepEqual(groundShape, {
    kind: 'trimeshSource', resourceId: 'resource:mesh-collider', resourceWorkspacePath: 'Assets/collider.glb', resourceFormat: 'glb', entityScale: [-2, 3, 0.5],
  })
  const crateShape = plan.value.physics.bodies.find((body) => body.entityId === 'entity:crate')?.colliders[0]?.shape
  assert.equal(crateShape?.kind, 'convexHullSource')
  const legacy = projectWorldRuntimeScene(snapshot, 'scene:one')
  assert.equal(legacy.success, false)
  if (!legacy.success) assert.equal(legacy.issues[0]?.code, 'unsupported-physics-shape')
})

test('runtime scene plan rejects static mesh colliders on moving bodies before geometry preparation', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const crate = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:crate')!
  crate.components[0] = {
    id: 'component:crate-collider', type: 'collider', enabled: true, purpose: 'simulation',
    shape: 'mesh', resourceId: 'resource:hero', sensor: false, friction: 0.5, restitution: 0.1,
    collisionLayer: 4, collisionMask: 0xffff,
  }
  const plan = planWorldRuntimeScene(snapshot, 'scene:one')
  assert.equal(plan.success, false)
  if (!plan.success) assert.equal(plan.issues[0]?.code, 'unsupported-physics-static-mesh-body')
})

test('runtime projection preserves authored sphere dimensions with effective scale', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const zone = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:zone')!
  zone.transform.scale = [1, 2, 3]
  const sphere = zone.components.find((component) => component.type === 'collider')
  assert.equal(sphere?.type, 'collider')
  if (sphere?.type === 'collider' && sphere.shape === 'sphere') sphere.radius = 0.75
  const result = projectWorldRuntimeScene(snapshot, 'scene:one')
  assert.equal(result.success, true)
  if (!result.success) return
  const body = result.value.physics.bodies.find((candidate) => candidate.entityId === 'entity:zone')
  assert.equal(body?.colliders[0]?.shape.kind, 'sphere')
  if (body?.colliders[0]?.shape.kind === 'sphere') assert.equal(body.colliders[0].shape.radius, 2.25)
})

test('runtime projection rejects a glTF animation resource that is not bound to its renderable model', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const animation = snapshot.project.resources.find((resource) => resource.id === 'resource:walk')
  if (animation?.type !== 'animation') throw new Error('Runtime animation fixture is unavailable.')
  animation.workspacePath = 'Assets/unrelated.glb'
  delete animation.sourceWorkspacePath
  assert.equal(validateWorldProjectSnapshot(snapshot).success, true)
  const result = projectWorldRuntimeScene(snapshot, 'scene:one')
  assert.equal(result.success, false)
  if (!result.success) {
    assert.equal(result.issues[0]?.code, 'unsupported-runtime-animation')
    assert.match(result.issues[0]?.message ?? '', /bound to the rendered model/i)
  }
})

test('dynamic parent poses propagate through render and camera-listener children', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const scene = snapshot.scenes[0]
  const crate = scene.entities.find((entity) => entity.id === 'entity:crate')!
  crate.transform.scale = [2, 1, 1]
  const camera = scene.entities.find((entity) => entity.id === 'entity:camera')!
  camera.parentId = 'entity:crate'
  camera.transform = { position: [0, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1] }
  scene.entities.push({
    id: 'entity:crate-child', name: 'Crate child', parentId: 'entity:crate', enabled: true, locked: false, tags: [],
    transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [0.5, 0.5, 0.5] },
    components: [{
      id: 'component:crate-child-renderable', type: 'renderable', enabled: true, resourceId: 'resource:hero', visible: true,
      castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
    }],
  })
  scene.entities.push({
    id: 'entity:crate-light', name: 'Crate light', parentId: 'entity:crate', enabled: true, locked: false, tags: [],
    transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: 'component:crate-light', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 1, range: 10, castShadow: false }],
  })
  assert.equal(validateWorldProjectSnapshot(snapshot).success, true)
  const transforms = resolveWorldRuntimeTransforms(scene.entities, [{
    entityId: 'entity:crate', position: [20, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  }])
  assertVectorClose(transforms.get('entity:crate-child')?.position, [20, 0, -2])
  assertVectorClose(transforms.get('entity:crate-child')?.scale, [1, 0.5, 0.5])
  assertVectorClose(transforms.get('entity:crate-light')?.position, [20, 1, 0])
  assertVectorClose(transforms.get('entity:camera')?.position, [23, 0, 0])
})

function assertVectorClose(actual: readonly number[] | undefined, expected: readonly number[]): void {
  assert.equal(actual?.length, expected.length)
  expected.forEach((value, index) => assert.ok(Math.abs(actual![index]! - value) < 1e-6, `${String(actual)} != ${String(expected)}`))
}
