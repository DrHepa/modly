import assert from 'node:assert/strict'
import test from 'node:test'

import * as THREE from 'three'

import { calculateWorldsObjectLocalBounds } from './worldsObjectBounds.ts'

test('calculateWorldsObjectLocalBounds returns root-local bounds across descendant transforms', () => {
  const root = new THREE.Group()
  root.position.set(10, 4, -3)
  root.rotation.set(0, Math.PI / 2, 0)

  const child = new THREE.Group()
  child.position.set(2, 0, 0)
  child.rotation.set(0, 0, Math.PI / 2)
  root.add(child)

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6), new THREE.MeshBasicMaterial())
  mesh.position.set(0, 1, 0)
  child.add(mesh)

  const bounds = calculateWorldsObjectLocalBounds(root)
  assert.ok(bounds)
  assert.ok(Math.abs(bounds!.min.x + 1) < 1e-9)
  assert.ok(Math.abs(bounds!.min.y + 1) < 1e-9)
  assert.ok(Math.abs(bounds!.min.z + 3) < 1e-9)
  assert.ok(Math.abs(bounds!.max.x - 3) < 1e-9)
  assert.ok(Math.abs(bounds!.max.y - 1) < 1e-9)
  assert.ok(Math.abs(bounds!.max.z - 3) < 1e-9)
})

test('calculateWorldsObjectLocalBounds ignores helper objects and returns null when no real geometry remains', () => {
  const root = new THREE.Group()
  const hitbox = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial())
  hitbox.userData.worldsSelectionHitbox = true
  root.add(hitbox)

  assert.equal(calculateWorldsObjectLocalBounds(root), null)
})

test('calculateWorldsObjectLocalBounds unions custom object bounds for non-geometry scene objects', () => {
  const root = new THREE.Group()
  const child = new THREE.Group()
  child.position.set(2, 3, 4)
  child.userData.worldsObjectBounds = new THREE.Box3(
    new THREE.Vector3(-1, 0, -2),
    new THREE.Vector3(1, 5, 2),
  )
  root.add(child)

  const bounds = calculateWorldsObjectLocalBounds(root)
  assert.deepEqual(bounds, {
    min: { x: 1, y: 3, z: 2 },
    max: { x: 3, y: 8, z: 6 },
  })
})
