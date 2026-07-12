import assert from 'node:assert/strict'
import test from 'node:test'

import * as THREE from 'three'

import type { WorldSceneItem } from './worldRenderableResolver.ts'
import {
  resolveWorldsBaseSceneSupportPlacement,
  resolveWorldsPendingSurfacePlacementDecision,
} from './worldsBaseSceneSupport.ts'

const EPSILON = 1e-4

test('pending placement commits onto horizontal base geometry when mesh support is available', () => {
  const pending = sceneItem('pending', 'asset', [0.25, 0.62, 0.25])
  const base = sceneItem('base', 'base-scene', [0, 0, 0])
  const decision = resolveWorldsPendingSurfacePlacementDecision({
    pendingItemId: pending.id,
    sceneItems: [pending, base],
    sceneObjects: new Map([
      [pending.id, new THREE.Group()],
      [base.id, createRootWithMesh(createTriangleMesh([
        [0, 0, 0],
        [2, 0, 0],
        [0, 0, 2],
      ]))],
    ]),
    localBoundsByItemId: new Map([[pending.id, boxBounds()]]),
  })

  assert.equal(decision.status, 'commit')
  assert.ok(decision.transform)
  assertClose(decision.transform!.position[1], 0.5001)
})

test('pending placement clears deterministically when downward query misses base geometry', () => {
  const pending = sceneItem('pending', 'asset', [4, 0.62, 4])
  const base = sceneItem('base', 'base-scene', [0, 0, 0])
  const decision = resolveWorldsPendingSurfacePlacementDecision({
    pendingItemId: pending.id,
    sceneItems: [pending, base],
    sceneObjects: new Map([
      [pending.id, new THREE.Group()],
      [base.id, createRootWithMesh(createTriangleMesh([
        [0, 0, 0],
        [2, 0, 0],
        [0, 0, 2],
      ]))],
    ]),
    localBoundsByItemId: new Map([[pending.id, boxBounds()]]),
  })

  assert.deepEqual(decision, { status: 'clear', transform: null, reason: 'no-hit' })
})

test('base support uses the nearest downward hit and preserves authored rotation on inclined terrain', () => {
  const pending = sceneItem('pending', 'asset', [0.1, 1.15, 0.2], [0.3, 0.4, 0.1])
  const nearBase = sceneItem('near-base', 'base-scene', [0, 1, 0])
  const farBase = sceneItem('far-base', 'base-scene', [0, 0, 0])
  const result = resolveWorldsBaseSceneSupportPlacement({
    anchorItemId: pending.id,
    items: [{ id: pending.id, localBounds: boxBounds(), startTransform: cloneTransform(pending.transform) }],
    desiredTransforms: [{ id: pending.id, transform: cloneTransform(pending.transform) }],
    sceneItems: [pending, nearBase, farBase],
    sceneObjects: new Map([
      [nearBase.id, createRootWithMesh(createTriangleMesh([
        [0, 1, 0],
        [1, 1, 0],
        [0, 2, 1],
      ]))],
      [farBase.id, createRootWithMesh(createTriangleMesh([
        [0, 0, 0],
        [2, 0, 0],
        [0, 0, 2],
      ]))],
    ]),
    maxCorrection: 100,
  })

  assert.equal(result.status, 'applied')
  assert.equal(result.sourceId, nearBase.id)
  assert.deepEqual(result.updates[0]!.transform.rotation, [0.3, 0.4, 0.1])
  assert.ok(Math.abs(result.correctionDelta[1]) > EPSILON)
  assert.ok(Math.abs(result.correctionDelta[2]) > EPSILON)
})

function sceneItem(
  id: string,
  role: WorldSceneItem['role'],
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): WorldSceneItem {
  return {
    id,
    workspacePath: `${id}.glb`,
    url: `/workspace/${id}.glb`,
    kind: 'glb',
    role,
    visible: true,
    transform: { position: [...position], rotation: [...rotation], scale: [1, 1, 1] },
  }
}

function boxBounds() {
  return {
    min: { x: -0.5, y: -0.5, z: -0.5 },
    max: { x: 0.5, y: 0.5, z: 0.5 },
  }
}

function cloneTransform(transform: WorldSceneItem['transform']): WorldSceneItem['transform'] {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
}

function createRootWithMesh(mesh: THREE.Object3D): THREE.Group {
  const root = new THREE.Group()
  root.add(mesh)
  root.updateWorldMatrix(true, true)
  return root
}

function createTriangleMesh(vertices: [[number, number, number], [number, number, number], [number, number, number]]): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3))
  geometry.computeVertexNormals()
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
}

function assertClose(actual: number, expected: number, tolerance = EPSILON): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`)
}
