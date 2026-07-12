import assert from 'node:assert/strict'
import test from 'node:test'

import * as THREE from 'three'

import { raycastWorldsBaseScenePlacementSurface } from './worldsBaseSceneRaycast.ts'

const EPSILON = 1e-6

test('horizontal mesh hit returns point normal and triangle', () => {
  const root = createRootWithMesh(createTriangleMesh([
    [0, 0, 0],
    [2, 0, 0],
    [0, 0, 2],
  ]))
  const hit = raycastWorldsBaseScenePlacementSurface({
    ray: { origin: [0.25, 2, 0.25], direction: [0, -1, 0], maxDistance: 10 },
    roots: [{ sourceId: 'floor', root }],
  })

  assert.ok(hit)
  assert.equal(hit!.sourceId, 'floor')
  assert.equal(hit!.source, 'base-scene')
  assertVectorClose(hit!.point, [0.25, 0, 0.25])
  assert.deepEqual(hit!.normal, [0, 1, 0])
  assert.deepEqual(hit!.polygon, [[0, 0, 0], [2, 0, 0], [0, 0, 2]])
})

test('inclined triangle normal is world oriented against the ray', () => {
  const root = createRootWithMesh(createTriangleMesh([
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 1],
  ]))
  const hit = raycastWorldsBaseScenePlacementSurface({
    ray: { origin: [0.1, 2, 0.2], direction: [0, -1, 0], maxDistance: 10 },
    roots: [{ sourceId: 'ramp', root }],
  })

  assert.ok(hit)
  assert.ok(hit!.normal[1] > 0)
  assertVectorClose(hit!.normal, normalize([0, 1, -1]))
})

test('nearest of multiple base roots wins', () => {
  const nearRoot = createRootWithMesh(createTriangleMesh([
    [0, 1, 0],
    [2, 1, 0],
    [0, 1, 2],
  ]))
  const farRoot = createRootWithMesh(createTriangleMesh([
    [0, 0, 0],
    [2, 0, 0],
    [0, 0, 2],
  ]))
  const hit = raycastWorldsBaseScenePlacementSurface({
    ray: { origin: [0.25, 3, 0.25], direction: [0, -1, 0], maxDistance: 10 },
    roots: [
      { sourceId: 'far', root: farRoot },
      { sourceId: 'near', root: nearRoot },
    ],
  })

  assert.ok(hit)
  assert.equal(hit!.sourceId, 'near')
})

test('hidden roots are excluded', () => {
  const hiddenRoot = createRootWithMesh(createTriangleMesh([
    [0, 0, 0],
    [2, 0, 0],
    [0, 0, 2],
  ]))
  hiddenRoot.visible = false
  const hit = raycastWorldsBaseScenePlacementSurface({
    ray: { origin: [0.25, 2, 0.25], direction: [0, -1, 0], maxDistance: 10 },
    roots: [{ sourceId: 'hidden', root: hiddenRoot }],
  })

  assert.equal(hit, null)
})

test('ignored moving item ids are excluded', () => {
  const root = createRootWithMesh(createTriangleMesh([
    [0, 0, 0],
    [2, 0, 0],
    [0, 0, 2],
  ]))
  const hit = raycastWorldsBaseScenePlacementSurface({
    ray: { origin: [0.25, 2, 0.25], direction: [0, -1, 0], maxDistance: 10 },
    roots: [{ sourceId: 'moving', root }],
    ignoredItemIds: ['moving'],
  })

  assert.equal(hit, null)
})

test('points and non-mesh objects are skipped', () => {
  const root = new THREE.Group()
  const pointsGeometry = new THREE.BufferGeometry()
  pointsGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3))
  root.add(new THREE.Points(pointsGeometry, new THREE.PointsMaterial()))

  const hit = raycastWorldsBaseScenePlacementSurface({
    ray: { origin: [0.25, 2, 0.25], direction: [0, -1, 0], maxDistance: 10 },
    roots: [{ sourceId: 'points', root }],
  })

  assert.equal(hit, null)
})

test('malformed custom mesh hits are skipped safely', () => {
  class FaceLessMesh extends THREE.Mesh {
    override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
      intersects.push({
        distance: 1,
        point: raycaster.ray.origin.clone().add(raycaster.ray.direction),
        object: this,
      })
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
  const root = createRootWithMesh(new FaceLessMesh(geometry, new THREE.MeshBasicMaterial()))
  const hit = raycastWorldsBaseScenePlacementSurface({
    ray: { origin: [0, 2, 0], direction: [0, -1, 0], maxDistance: 10 },
    roots: [{ sourceId: 'broken', root }],
  })

  assert.equal(hit, null)
})

test('deterministic ties pick the smallest source id', () => {
  const left = createRootWithMesh(createTriangleMesh([
    [0, 0, 0],
    [2, 0, 0],
    [0, 0, 2],
  ]))
  const right = createRootWithMesh(createTriangleMesh([
    [0, 0, 0],
    [2, 0, 0],
    [0, 0, 2],
  ]))
  const hit = raycastWorldsBaseScenePlacementSurface({
    ray: { origin: [0.25, 2, 0.25], direction: [0, -1, 0], maxDistance: 10 },
    roots: [
      { sourceId: 'z-floor', root: right },
      { sourceId: 'a-floor', root: left },
    ],
  })

  assert.ok(hit)
  assert.equal(hit!.sourceId, 'a-floor')
})

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

function normalize(vector: [number, number, number]): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2])
  return [vector[0] / length, vector[1] / length, vector[2] / length]
}

function assertVectorClose(actual: [number, number, number], expected: [number, number, number], tolerance = EPSILON): void {
  assert.ok(Math.abs(actual[0] - expected[0]) <= tolerance, `expected ${actual[0]} to be within ${tolerance} of ${expected[0]}`)
  assert.ok(Math.abs(actual[1] - expected[1]) <= tolerance, `expected ${actual[1]} to be within ${tolerance} of ${expected[1]}`)
  assert.ok(Math.abs(actual[2] - expected[2]) <= tolerance, `expected ${actual[2]} to be within ${tolerance} of ${expected[2]}`)
}
