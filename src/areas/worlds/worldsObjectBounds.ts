import * as THREE from 'three'

import type { WorldsCollisionBounds } from './worldsCollisionMath.ts'

const worldsRootInverseMatrix = new THREE.Matrix4()
const worldsLocalMatrix = new THREE.Matrix4()
const worldsCorner = new THREE.Vector3()
const worldsLocalBounds = new THREE.Box3()

export function calculateWorldsObjectLocalBounds(target: THREE.Object3D): WorldsCollisionBounds | null {
  target.updateWorldMatrix(true, true)
  worldsRootInverseMatrix.copy(target.matrixWorld).invert()
  worldsLocalBounds.makeEmpty()
  let hasBounds = false

  target.traverse((object) => {
    if (object === target || object.userData.worldsSelectionHitbox === true || object.userData.worldsSelectionSilhouette === true || object.userData.worldsCollisionZone === true) return

    const customBounds = object.userData.worldsObjectBounds
    if (customBounds instanceof THREE.Box3 && !customBounds.isEmpty()) {
      worldsLocalMatrix.multiplyMatrices(worldsRootInverseMatrix, object.matrixWorld)
      unionBoundsBoxCorners(worldsLocalBounds, customBounds, worldsLocalMatrix)
      hasBounds = true
    }

    const geometry = (object as THREE.Mesh | THREE.Points).geometry
    if (!geometry) return
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    if (!geometry.boundingBox || !Number.isFinite(geometry.boundingBox.min.x) || !Number.isFinite(geometry.boundingBox.max.x)) return

    worldsLocalMatrix.multiplyMatrices(worldsRootInverseMatrix, object.matrixWorld)
    unionBoundsBoxCorners(worldsLocalBounds, geometry.boundingBox, worldsLocalMatrix)
    hasBounds = true
  })

  if (!hasBounds || worldsLocalBounds.isEmpty()) return null

  return {
    min: {
      x: worldsLocalBounds.min.x,
      y: worldsLocalBounds.min.y,
      z: worldsLocalBounds.min.z,
    },
    max: {
      x: worldsLocalBounds.max.x,
      y: worldsLocalBounds.max.y,
      z: worldsLocalBounds.max.z,
    },
  }
}

function unionBoundsBoxCorners(target: THREE.Box3, bounds: THREE.Box3, matrix: THREE.Matrix4): void {
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        worldsCorner.set(x, y, z).applyMatrix4(matrix)
        target.expandByPoint(worldsCorner)
      }
    }
  }
}
