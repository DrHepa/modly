import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import { applyWorldsPoseClipAtTime, createWorldsPoseClipBoneMap, takeWorldsPoseClipSnapshot } from './worldsPoseClipPlayback.ts'
import type { PoseClipSidecarV1 } from '../../shared/types/electron.d.ts'

function sidecar(): PoseClipSidecarV1 {
  return {
    schema: 'modly.pose-clip',
    version: 1,
    createdAt: '2026-06-21T00:00:00.000Z',
    source: { workspacePath: 'Workflows/hero.glb' },
    skeletonContextId: 'rig:hero|skeleton:0',
    clip: { id: 'turn', name: 'Turn', durationSeconds: 2, fps: 30 },
    skeleton: {
      rootBoneIds: ['rig:hero|skeleton:0|bone:Hips#0'],
      boneCount: 1,
      bones: [{ boneId: 'rig:hero|skeleton:0|bone:Hips#0', label: 'Hips', originalName: 'Hips', path: ['Hips'] }],
    },
    keyframes: [
      { id: 'a', timeSeconds: 0, boneId: 'rig:hero|skeleton:0|bone:Hips#0', rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { id: 'b', timeSeconds: 2, boneId: 'rig:hero|skeleton:0|bone:Hips#0', rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)) },
    ],
  }
}

test('Worlds pose clip playback maps sidecar bone paths and samples global time with slerp', () => {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  root.add(hips)
  const clip = sidecar()
  const bonesById = createWorldsPoseClipBoneMap(root, clip)
  const snapshot = takeWorldsPoseClipSnapshot(bonesById)

  const result = applyWorldsPoseClipAtTime({ sidecar: clip, bonesById, snapshot, timeSeconds: 1 })

  assert.deepEqual(result.appliedBoneIds, ['rig:hero|skeleton:0|bone:Hips#0'])
  const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
  assert.equal(Math.abs(hips.quaternion.angleTo(expected)) < 0.0001, true)
})

function quaternionValue(quaternion: THREE.Quaternion): { x: number; y: number; z: number; w: number } {
  const normalized = quaternion.clone().normalize()
  return { x: normalized.x, y: normalized.y, z: normalized.z, w: normalized.w }
}
