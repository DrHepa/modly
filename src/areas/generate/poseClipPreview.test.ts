import assert from 'node:assert/strict'
import test from 'node:test'

import * as THREE from 'three'

import {
  applyLocalPoseClipRotation,
  buildPoseClipBoneLookup,
  evaluatePoseClipPreview,
  readPoseClipBoneQuaternion,
  resetPoseClipPreview,
  resetPoseClipSelectedBone,
  restoreThenEvaluatePoseClipPreview,
  restorePoseClipQuaternionSnapshot,
  takePoseClipQuaternionSnapshot,
} from './poseClipPreview.ts'
import type { PoseClipPlan } from './poseClipPlan.ts'
import type { RigSkeletonSummary } from './rigSkeleton.ts'

const rigSummary: RigSkeletonSummary = {
  hasRig: true,
  sourceWorkspacePath: 'Workflows/generated/hero.glb',
  skeletonContextId: 'rig:Hero|skeleton:0',
  skinnedMeshContexts: ['rig:Hero|skeleton:0'],
  rootBoneIds: ['bone:hips'],
  stats: { skinnedMeshCount: 1, boneCount: 3 },
  warnings: [],
  bones: [
    {
      boneId: 'bone:hips',
      label: 'Hips',
      originalName: 'Hips',
      path: ['Hips'],
      siblingIndex: 0,
      childIds: ['bone:left-arm', 'bone:right-arm'],
      warnings: [],
    },
    {
      boneId: 'bone:left-arm',
      label: 'Arm',
      originalName: 'Arm.L',
      path: ['Hips', 'Arm.L'],
      siblingIndex: 0,
      parentId: 'bone:hips',
      childIds: [],
      warnings: ['duplicate-name'],
    },
    {
      boneId: 'bone:right-arm',
      label: 'Arm',
      originalName: 'Arm.R',
      path: ['Hips', 'Arm.R'],
      siblingIndex: 1,
      parentId: 'bone:hips',
      childIds: [],
      warnings: ['duplicate-name'],
    },
  ],
}

test('buildPoseClipBoneLookup binds stable RigBoneId values to the current THREE.Bone context and warns for missing ids without label or index rebinding', () => {
  const leftArm = new THREE.Bone()
  leftArm.name = 'Arm'
  const rightArm = new THREE.Bone()
  rightArm.name = 'Arm'

  const result = buildPoseClipBoneLookup(rigSummary, {
    'bone:left-arm': leftArm,
    'bone:missing-from-summary': new THREE.Bone(),
  })

  assert.equal(result.bonesById.get('bone:left-arm'), leftArm)
  assert.equal(result.bonesById.has('bone:right-arm'), false)
  assert.equal(result.bonesById.has('bone:missing-from-summary'), false)
  assert.deepEqual(result.missingBoneIds, ['bone:hips', 'bone:right-arm'])
  assert.match(result.warnings.join('\n'), /Missing THREE\.Bone for RigBoneId "bone:right-arm"/)
  assert.match(result.warnings.join('\n'), /Ignoring THREE\.Bone for unknown RigBoneId "bone:missing-from-summary"/)
})

test('snapshot and restore preserve original bone quaternions after preview mutations', () => {
  const hips = new THREE.Bone()
  const leftArm = new THREE.Bone()
  hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6)
  leftArm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 5)
  const lookup = buildPoseClipBoneLookup(rigSummary, { 'bone:hips': hips, 'bone:left-arm': leftArm, 'bone:right-arm': new THREE.Bone() })

  const snapshot = takePoseClipQuaternionSnapshot(lookup.bonesById)
  const originalHips = hips.quaternion.clone()
  const originalLeftArm = leftArm.quaternion.clone()

  hips.quaternion.set(0, 0, 0, 1)
  leftArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
  restorePoseClipQuaternionSnapshot(lookup.bonesById, snapshot)

  assertQuaternionClose(hips.quaternion, originalHips)
  assertQuaternionClose(leftArm.quaternion, originalLeftArm)
})

test('evaluatePoseClipPreview applies quaternion keyframes by RigBoneId at timeline time, interpolates within a bone track and never mutates the input plan', () => {
  const hips = new THREE.Bone()
  const leftArm = new THREE.Bone()
  const rightArm = new THREE.Bone()
  const lookup = buildPoseClipBoneLookup(rigSummary, { 'bone:hips': hips, 'bone:left-arm': leftArm, 'bone:right-arm': rightArm })
  const halfway = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
  const plan: PoseClipPlan = {
    skeletonContextId: 'rig:Hero|skeleton:0',
    clip: { id: 'clip-wave', name: 'Wave', durationSeconds: 2, fps: 24 },
    keyframes: [
      { id: 'kf-left-2', timeSeconds: 2, boneId: 'bone:left-arm', rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)) },
      { id: 'kf-right-1', timeSeconds: 1, boneId: 'bone:right-arm', rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 3)) },
      { id: 'kf-left-0', timeSeconds: 0, boneId: 'bone:left-arm', rotation: quaternionValue(new THREE.Quaternion()) },
      { id: 'kf-missing', timeSeconds: 1, boneId: 'bone:tail', rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)) },
    ],
  }
  const planBefore = structuredClone(plan)

  const result = evaluatePoseClipPreview({ plan, bonesById: lookup.bonesById, timeSeconds: 1 })

  assert.deepEqual(plan, planBefore)
  assert.deepEqual(result.appliedBoneIds, ['bone:left-arm', 'bone:right-arm'])
  assert.deepEqual(result.missingBoneIds, ['bone:tail'])
  assert.match(result.warnings.join('\n'), /Skipping pose preview keyframes for missing RigBoneId "bone:tail"/)
  assertQuaternionClose(leftArm.quaternion, halfway)
  assertQuaternionClose(rightArm.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 3))
  assertQuaternionClose(hips.quaternion, new THREE.Quaternion())
})

test('resetPoseClipPreview restores the snapshot and reports a reset timeline without mutating keyframes', () => {
  const leftArm = new THREE.Bone()
  const original = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 8)
  leftArm.quaternion.copy(original)
  const lookup = buildPoseClipBoneLookup(rigSummary, { 'bone:hips': new THREE.Bone(), 'bone:left-arm': leftArm, 'bone:right-arm': new THREE.Bone() })
  const snapshot = takePoseClipQuaternionSnapshot(lookup.bonesById)
  const plan: PoseClipPlan = {
    skeletonContextId: 'rig:Hero|skeleton:0',
    clip: { id: 'clip-reset', name: 'Reset', durationSeconds: 1, fps: 24 },
    keyframes: [{ id: 'kf-left', timeSeconds: 0, boneId: 'bone:left-arm', rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)) }],
  }
  const planBefore = structuredClone(plan)

  evaluatePoseClipPreview({ plan, bonesById: lookup.bonesById, timeSeconds: 0 })
  const result = resetPoseClipPreview({ bonesById: lookup.bonesById, snapshot })

  assert.deepEqual(plan, planBefore)
  assert.equal(result.timeSeconds, 0)
  assert.deepEqual(result.restoredBoneIds, ['bone:hips', 'bone:left-arm', 'bone:right-arm'])
  assertQuaternionClose(leftArm.quaternion, original)
})

test('restoreThenEvaluatePoseClipPreview restores the snapshot before scrub evaluation so unkeyed quaternion edits do not accumulate', () => {
  const hips = new THREE.Bone()
  const spine = new THREE.Bone()
  hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 9)
  spine.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 11)
  const originalHips = hips.quaternion.clone()
  const originalSpine = spine.quaternion.clone()
  const bonesById = new Map([
    ['bone:hips' satisfies RigSkeletonSummary['bones'][number]['boneId'], hips],
    ['bone:left-arm' satisfies RigSkeletonSummary['bones'][number]['boneId'], spine],
  ])
  const snapshot = takePoseClipQuaternionSnapshot(bonesById)
  const plan: PoseClipPlan = {
    skeletonContextId: 'rig:Hero|skeleton:0',
    clip: { id: 'clip-scrub', name: 'Scrub', durationSeconds: 1, fps: 24 },
    keyframes: [
      { id: 'kf-spine-0', timeSeconds: 0, boneId: 'bone:left-arm', rotation: quaternionValue(new THREE.Quaternion()) },
      { id: 'kf-spine-1', timeSeconds: 1, boneId: 'bone:left-arm', rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)) },
    ],
  }

  hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
  spine.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
  const result = restoreThenEvaluatePoseClipPreview({ plan, bonesById, snapshot, timeSeconds: 0.5 })

  assert.deepEqual(result.restoredBoneIds, ['bone:hips', 'bone:left-arm'])
  assert.deepEqual(result.preview.appliedBoneIds, ['bone:left-arm'])
  assertQuaternionClose(hips.quaternion, originalHips)
  assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
  assertQuaternionClose(originalSpine, snapshot.get('bone:left-arm')!)
})

test('snapshot-safe scrub, select, update and reset keep returning to the pre-preview pose instead of accumulating edits', () => {
  const hips = new THREE.Bone()
  const spine = new THREE.Bone()
  hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 9)
  spine.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 10)
  const originalHips = hips.quaternion.clone()
  const originalSpine = spine.quaternion.clone()
  const bonesById = new Map([
    ['bone:hips' satisfies RigSkeletonSummary['bones'][number]['boneId'], hips],
    ['bone:left-arm' satisfies RigSkeletonSummary['bones'][number]['boneId'], spine],
  ])
  const snapshot = takePoseClipQuaternionSnapshot(bonesById)
  const keyedTurnZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
  const scrubbedMidpointZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4)
  const quarterTurnY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4)
  const plan: PoseClipPlan = {
    skeletonContextId: 'rig:Hero|skeleton:0',
    clip: { id: 'clip-snapshot-regression', name: 'Snapshot Regression', durationSeconds: 1, fps: 24 },
    keyframes: [
      { id: 'kf-spine-0', timeSeconds: 0, boneId: 'bone:left-arm', rotation: quaternionValue(new THREE.Quaternion()) },
      { id: 'kf-spine-1', timeSeconds: 1, boneId: 'bone:left-arm', rotation: quaternionValue(keyedTurnZ) },
    ],
  }

  spine.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
  const firstScrub = restoreThenEvaluatePoseClipPreview({ plan, bonesById, snapshot, timeSeconds: 0.5 })
  assert.deepEqual(firstScrub.restoredBoneIds, ['bone:hips', 'bone:left-arm'])
  assert.deepEqual(firstScrub.preview.appliedBoneIds, ['bone:left-arm'])
  assertQuaternionClose(hips.quaternion, originalHips)
  assertQuaternionClose(spine.quaternion, scrubbedMidpointZ)

  spine.quaternion.multiply(quarterTurnY).normalize()
  const secondScrub = restoreThenEvaluatePoseClipPreview({ plan, bonesById, snapshot, timeSeconds: 0.5 })
  assert.deepEqual(secondScrub.restoredBoneIds, ['bone:hips', 'bone:left-arm'])
  assertQuaternionClose(hips.quaternion, originalHips)
  assertQuaternionClose(spine.quaternion, scrubbedMidpointZ)
  assertQuaternionClose(snapshot.get('bone:left-arm')!, originalSpine)

  const reset = resetPoseClipPreview({ bonesById, snapshot })
  assert.deepEqual(reset.restoredBoneIds, ['bone:hips', 'bone:left-arm'])
  assert.equal(reset.timeSeconds, 0)
  assertQuaternionClose(hips.quaternion, originalHips)
  assertQuaternionClose(spine.quaternion, originalSpine)
})

test('applyLocalPoseClipRotation applies normalized local quaternion nudges for X/Y/Z axes and exposes the modified quaternion for capture', () => {
  const leftArm = new THREE.Bone()
  const rightArm = new THREE.Bone()
  const bonesById = new Map([
    ['bone:left-arm' satisfies RigSkeletonSummary['bones'][number]['boneId'], leftArm],
    ['bone:right-arm' satisfies RigSkeletonSummary['bones'][number]['boneId'], rightArm],
  ])

  const xResult = applyLocalPoseClipRotation({ bonesById, boneId: 'bone:left-arm', axis: 'x', degreesDelta: 30 })
  const yResult = applyLocalPoseClipRotation({ bonesById, boneId: 'bone:left-arm', axis: 'y', degreesDelta: 45 })
  const zResult = applyLocalPoseClipRotation({ bonesById, boneId: 'bone:left-arm', axis: 'z', degreesDelta: -15 })
  const expected = new THREE.Quaternion()
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(30)))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(45)))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(-15)))
    .normalize()

  assert.equal(xResult.applied, true)
  assert.equal(yResult.applied, true)
  assert.equal(zResult.applied, true)
  assertQuaternionClose(leftArm.quaternion, expected)
  assertQuaternionClose(rightArm.quaternion, new THREE.Quaternion())
  assert.deepEqual(readPoseClipBoneQuaternion(bonesById, 'bone:left-arm'), quaternionValue(expected))
})

test('applyLocalPoseClipRotation keeps pose controls quaternion-safe for repeated local X/Y/Z authoring', () => {
  const leftArm = new THREE.Bone()
  const bonesById = new Map([
    ['bone:left-arm' satisfies RigSkeletonSummary['bones'][number]['boneId'], leftArm],
  ])

  applyLocalPoseClipRotation({ bonesById, boneId: 'bone:left-arm', axis: 'x', degreesDelta: 90 })
  applyLocalPoseClipRotation({ bonesById, boneId: 'bone:left-arm', axis: 'y', degreesDelta: 90 })
  applyLocalPoseClipRotation({ bonesById, boneId: 'bone:left-arm', axis: 'z', degreesDelta: 90 })

  const expected = new THREE.Quaternion()
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(90)))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(90)))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(90)))
    .normalize()

  assertQuaternionClose(leftArm.quaternion, expected)
  assert.ok(Math.abs(leftArm.quaternion.length() - 1) <= 0.000001, `expected normalized quaternion, got ${leftArm.quaternion.length()}`)
})

test('applyLocalPoseClipRotation skips missing targets and resetPoseClipSelectedBone restores only the selected bone snapshot', () => {
  const leftArm = new THREE.Bone()
  const rightArm = new THREE.Bone()
  leftArm.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 8)
  rightArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 7)
  const originalLeft = leftArm.quaternion.clone()
  const originalRight = rightArm.quaternion.clone()
  const bonesById = new Map([
    ['bone:left-arm' satisfies RigSkeletonSummary['bones'][number]['boneId'], leftArm],
    ['bone:right-arm' satisfies RigSkeletonSummary['bones'][number]['boneId'], rightArm],
  ])
  const snapshot = takePoseClipQuaternionSnapshot(bonesById)

  const missingResult = applyLocalPoseClipRotation({ bonesById, boneId: 'bone:tail', axis: 'x', degreesDelta: 10 })
  applyLocalPoseClipRotation({ bonesById, boneId: 'bone:left-arm', axis: 'z', degreesDelta: 90 })
  applyLocalPoseClipRotation({ bonesById, boneId: 'bone:right-arm', axis: 'x', degreesDelta: 90 })
  const resetResult = resetPoseClipSelectedBone({ bonesById, snapshot, boneId: 'bone:left-arm' })

  assert.equal(missingResult.applied, false)
  assert.match(missingResult.warning ?? '', /missing RigBoneId "bone:tail"/)
  assert.deepEqual(readPoseClipBoneQuaternion(bonesById, 'bone:tail'), null)
  assert.deepEqual(resetResult.restoredBoneIds, ['bone:left-arm'])
  assertQuaternionClose(leftArm.quaternion, originalLeft)
  assert.notDeepEqual(rightArm.quaternion.toArray(), originalRight.toArray())
})

function quaternionValue(quaternion: THREE.Quaternion) {
  return { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }
}

function assertQuaternionClose(actual: THREE.Quaternion, expected: THREE.Quaternion, epsilon = 0.000001) {
  assert.ok(Math.abs(actual.x - expected.x) <= epsilon, `x expected ${expected.x} got ${actual.x}`)
  assert.ok(Math.abs(actual.y - expected.y) <= epsilon, `y expected ${expected.y} got ${actual.y}`)
  assert.ok(Math.abs(actual.z - expected.z) <= epsilon, `z expected ${expected.z} got ${actual.z}`)
  assert.ok(Math.abs(actual.w - expected.w) <= epsilon, `w expected ${expected.w} got ${actual.w}`)
}
