import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimeWorldSnapshot } from './_testFixtures.ts'
import { projectWorldRuntimeScene } from './worldRuntimeProjection.ts'
import {
  parseWorldPhysicsMainMessage,
  parseWorldPhysicsWorkerMessage,
  WORLD_PHYSICS_PROTOCOL_VERSION,
} from './worldPhysicsProtocol.ts'
import type { WorldPhysicsBodyDto, WorldPhysicsSceneDto } from './worldPhysicsProtocol.ts'

function body(
  shape: WorldPhysicsBodyDto['colliders'][number]['shape'],
  bodyType: WorldPhysicsBodyDto['bodyType'] = 'fixed',
): WorldPhysicsBodyDto {
  return {
    entityId: `entity:${bodyType}`,
    bodyType,
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    gravityScale: 1,
    linearDamping: 0,
    angularDamping: 0,
    canSleep: false,
    tags: [],
    colliders: [{
      componentId: `collider:${bodyType}`,
      shape,
      sensor: false,
      friction: 0.5,
      restitution: 0,
      collisionLayer: 1,
      collisionMask: 0xffff,
      triggerComponentIds: [],
    }],
  }
}

function init(scene: WorldPhysicsSceneDto) {
  return { version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'init' as const, generationId: 5, scene }
}

function sceneWithBodies(bodies: WorldPhysicsBodyDto[]): WorldPhysicsSceneDto {
  return { sceneId: 'scene:advanced-geometry', gravity: [0, -9.81, 0], bodies }
}

const tetrahedronVertices = () => new Float32Array([
  0, 0, 0,
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
])

const floorVertices = () => new Float32Array([
  -1, 0, -1,
  1, 0, -1,
  1, 0, 1,
  -1, 0, 1,
])

const floorIndices = () => new Uint32Array([0, 1, 2, 0, 2, 3])

test('physics timing diagnostics protocol validates opt-in and bounded ordered rows', () => {
  const message = init(sceneWithBodies([]))
  assert.equal(parseWorldPhysicsMainMessage({ ...message, diagnostics: true }).success, true)
  for (const diagnostics of [false, null, undefined, 'true', {}]) {
    assert.equal(parseWorldPhysicsMainMessage({ ...message, diagnostics }).success, false)
  }
  const snapshot = { version: 1, kind: 'snapshot', generationId: 5, sequence: 0, entityIds: [], transforms: new ArrayBuffer(0), triggerEvents: [] }
  const row = { substep: 0, solverMs: 1, physicsStepMs: 3 }
  assert.equal(parseWorldPhysicsWorkerMessage(snapshot).success, true)
  for (const length of [1, 4]) {
    assert.equal(parseWorldPhysicsWorkerMessage({ ...snapshot, stepTimings: Array.from({ length }, (_, substep) => ({ ...row, substep })) }).success, true)
  }
  const invalid = [[], new Array(1), undefined, [row, row], [{ ...row, substep: 1 }],
    Array.from({ length: 5 }, (_, substep) => ({ ...row, substep })), [{ ...row, extra: 0 }],
    ...[NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1].map(solverMs => [{ ...row, solverMs }]),
    ...[NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, 0.5].map(physicsStepMs => [{ ...row, physicsStepMs }])]
  for (const stepTimings of invalid) assert.equal(parseWorldPhysicsWorkerMessage({ ...snapshot, stepTimings }).success, false)
})

test('physics protocol accepts exact init/step envelopes and rejects excess recovery steps', () => {
  const projection = projectWorldRuntimeScene(createRuntimeWorldSnapshot(), 'scene:one')
  assert.equal(projection.success, true)
  if (!projection.success) return
  const init = { version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'init' as const, generationId: 3, scene: projection.value.physics }
  assert.deepEqual(parseWorldPhysicsMainMessage(init), { success: true, value: init })
  const step = {
    version: WORLD_PHYSICS_PROTOCOL_VERSION,
    kind: 'step' as const,
    generationId: 3,
    sequence: 9,
    steps: Array.from({ length: 4 }, () => ({ characters: [], impulses: [] })),
  }
  assert.deepEqual(parseWorldPhysicsMainMessage(step), { success: true, value: step })
  assert.equal(parseWorldPhysicsMainMessage({ ...step, steps: [...step.steps, { characters: [], impulses: [] }] }).success, false)
  assert.equal(parseWorldPhysicsMainMessage({ ...step, steps: [] }).success, false)
  assert.equal(parseWorldPhysicsMainMessage({ ...step, stepCount: 4, characters: [], impulses: [] }).success, false)
  assert.equal(parseWorldPhysicsMainMessage({ ...step, workspacePath: '/tmp/leak' }).success, false)
})

test('worker snapshot requires exactly seven finite floats per body', () => {
  const buffer = new Float32Array([0, 1, 2, 0, 0, 0, 1]).buffer
  const message = { version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'snapshot' as const, generationId: 2, sequence: 1, entityIds: ['entity:hero'], transforms: buffer, triggerEvents: [] }
  const parsed = parseWorldPhysicsWorkerMessage(message)
  assert.equal(parsed.success, true)
  assert.equal(parseWorldPhysicsWorkerMessage({ ...message, transforms: new Float32Array(6).buffer }).success, false)
})

test('physics protocol accepts bounded numeric convex hull and fixed trimesh DTOs without mutating typed arrays', () => {
  const hullVertices = tetrahedronVertices()
  const meshVertices = floorVertices()
  const meshIndices = floorIndices()
  const before = {
    hull: Array.from(hullVertices),
    mesh: Array.from(meshVertices),
    indices: Array.from(meshIndices),
  }
  const message = init(sceneWithBodies([
    body({ kind: 'convexHull', vertices: hullVertices }, 'dynamic'),
    body({ kind: 'trimesh', vertices: meshVertices, indices: meshIndices }, 'fixed'),
    body({ kind: 'box', halfExtents: [1, 1, 1] }, 'fixed'),
    body({ kind: 'sphere', radius: 0.5 }, 'dynamic'),
    body({ kind: 'capsule', radius: 0.25, halfHeight: 0.75 }, 'kinematic-position'),
  ]))

  const parsed = parseWorldPhysicsMainMessage(message)
  assert.equal(parsed.success, true)
  assert.deepEqual(Array.from(hullVertices), before.hull)
  assert.deepEqual(Array.from(meshVertices), before.mesh)
  assert.deepEqual(Array.from(meshIndices), before.indices)
  if (!parsed.success) return
  assert.equal(parsed.value.kind, 'init')
  if (parsed.value.kind !== 'init') return
  assert.equal(parsed.value.scene.bodies[0].colliders[0].shape, message.scene.bodies[0].colliders[0].shape)
})

test('physics protocol rejects malformed advanced geometry before accepting an init scene', () => {
  const validHull = { kind: 'convexHull' as const, vertices: tetrahedronVertices() }
  const validMesh = { kind: 'trimesh' as const, vertices: floorVertices(), indices: floorIndices() }
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body(validHull)]))).success, true)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body(validMesh)]))).success, true)

  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } as never)]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: new Float32Array([0, 0, 0, 1, 0]) })]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, Number.NaN, 0, 0, 0, 1]) })]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]) })]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]) })]))).success, false)

  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'trimesh', vertices: floorVertices(), indices: [0, 1, 2] } as never)]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'trimesh', vertices: floorVertices(), indices: new Uint32Array([0, 1]) })]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'trimesh', vertices: floorVertices(), indices: new Uint32Array([0, 1, 4]) })]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'trimesh', vertices: floorVertices(), indices: new Uint32Array([0, 0, 0]) })]))).success, false)
})

test('physics protocol enforces advanced geometry backing custody and explicit limits', () => {
  const sharedVertices = new Float32Array(new SharedArrayBuffer(4 * 3 * 4))
  const ResizableArrayBuffer = ArrayBuffer as unknown as { new(byteLength: number, options: { maxByteLength: number }): ArrayBuffer }
  const resizableVertices = new Float32Array(new ResizableArrayBuffer(4 * 3 * 4, { maxByteLength: 8 * 3 * 4 }))
  const detachedVertices = new Float32Array(4 * 3)
  structuredClone(detachedVertices.buffer, { transfer: [detachedVertices.buffer] })
  const hugeBacking = new Float32Array(new ArrayBuffer((8 * 1024 * 1024) + 4), 0, 12)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: sharedVertices })]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: resizableVertices })]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: detachedVertices })]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: hugeBacking })]))).success, false)

  const boundaryVertices = new Float32Array(16_384 * 3)
  for (let index = 0; index < boundaryVertices.length; index += 3) {
    boundaryVertices[index] = index / 3
    boundaryVertices[index + 1] = (index / 3) % 127
    boundaryVertices[index + 2] = (index / 3) % 31
  }
  boundaryVertices[0] = 0
  boundaryVertices[1] = 0
  boundaryVertices[2] = 0
  boundaryVertices[3] = 1
  boundaryVertices[4] = 0
  boundaryVertices[5] = 0
  boundaryVertices[6] = 0
  boundaryVertices[7] = 1
  boundaryVertices[8] = 0
  boundaryVertices[9] = 0
  boundaryVertices[10] = 0
  boundaryVertices[11] = 1
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: boundaryVertices })]))).success, true)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'convexHull', vertices: new Float32Array(16_385 * 3) })]))).success, false)

  const maxTriangleIndices = new Uint32Array(32_768 * 3)
  for (let index = 0; index < maxTriangleIndices.length; index += 3) {
    maxTriangleIndices[index] = 0
    maxTriangleIndices[index + 1] = 1
    maxTriangleIndices[index + 2] = 2
  }
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'trimesh', vertices: floorVertices(), indices: maxTriangleIndices })]))).success, true)
  const tooManyTriangleIndices = new Uint32Array((32_768 + 1) * 3)
  for (let index = 0; index < tooManyTriangleIndices.length; index += 3) {
    tooManyTriangleIndices[index] = 0
    tooManyTriangleIndices[index + 1] = 1
    tooManyTriangleIndices[index + 2] = 2
  }
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body({ kind: 'trimesh', vertices: floorVertices(), indices: tooManyTriangleIndices })]))).success, false)

  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies(Array.from({ length: 42 }, (_, index) => ({
    ...body({ kind: 'convexHull', vertices: new Float32Array(boundaryVertices) }),
    entityId: `entity:hull:${index}`,
  }))))).success, true)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies(Array.from({ length: 43 }, (_, index) => ({
    ...body({ kind: 'convexHull', vertices: new Float32Array(boundaryVertices) }),
    entityId: `entity:hull:${index}`,
  }))))).success, false)
})

test('physics protocol rejects static mesh on every moving body at the boundary', () => {
  const mesh = { kind: 'trimesh' as const, vertices: floorVertices(), indices: floorIndices() }
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body(mesh, 'fixed')]))).success, true)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body(mesh, 'dynamic')]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body(mesh, 'kinematic-position')]))).success, false)
  assert.equal(parseWorldPhysicsMainMessage(init(sceneWithBodies([body(mesh, 'kinematic-velocity')]))).success, false)
})
