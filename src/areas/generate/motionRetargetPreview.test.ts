import assert from 'node:assert/strict'
import test from 'node:test'

import * as THREE from 'three'

import {
  applyMotionRetargetPreviewCorrections,
  evaluateMotionRetargetPreview,
  resolveMotionRetargetPreviewClip,
  resetMotionRetargetPreview,
  restoreThenEvaluateMotionRetargetPreview,
  takeMotionRetargetPreviewSnapshot,
} from './motionRetargetPreview.ts'
import type { KimodoMotionArtifact } from './kimodoMotionAdapter.ts'
import type { RigSkeletonSummary } from './rigSkeleton.ts'

const rigSummary: RigSkeletonSummary = {
  hasRig: true,
  sourceWorkspacePath: 'Workflows/outputs/hero.glb',
  skeletonContextId: 'rig:hero|skeleton:0',
  skinnedMeshContexts: ['rig:hero|skeleton:0'],
  rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'],
  stats: { skinnedMeshCount: 1, boneCount: 2 },
  warnings: [],
  bones: [
    {
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      label: 'Hips',
      originalName: 'Hips',
      role: 'hips',
      path: ['Hips'],
      siblingIndex: 0,
      childIds: ['rig:hero|skeleton:0|bone:hips#0/spine#0'],
      warnings: [],
    },
    {
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      label: 'Spine',
      originalName: 'Spine',
      role: 'spine',
      path: ['Hips', 'Spine'],
      siblingIndex: 0,
      parentId: 'rig:hero|skeleton:0|bone:hips#0',
      childIds: [],
      warnings: [],
    },
  ],
}

const compatibleArtifact: KimodoMotionArtifact = {
  extensionId: 'kimodo-soma-rp',
  nodeId: 'animate-rigged-mesh',
  bundleWorkspacePath: 'Workflows/kimodo/run-1',
  metadataWorkspacePath: 'Workflows/kimodo/run-1/metadata.json',
  sourceMeshWorkspacePath: 'Workflows/outputs/hero.glb',
  diagnostics: {
    runtimeStatus: 'completed',
    retargetStatus: 'completed',
    animationMappingStatus: 'completed',
    stabilizationStatus: 'completed',
    visualQualityStatus: 'preview-only',
    sourceKind: 'kimodo-motion-json',
    mappingConfidence: 'manual',
    retargetErrorCode: null,
    retargetErrorAliases: [],
    retargetErrorMessage: null,
    warnings: ['Root-motion correctness is deferred.'],
    raw: { clip_name: 'Kimodo Walk' },
  },
  motionRetarget: {
    status: 'parsed',
    diagnostics: [],
    clipName: 'Kimodo Walk',
    sourceContract: { schema: 'modly.humanoid.v1', trusted: true },
    mappingStatus: 'trusted_manual',
    mappingConfidence: 'compatible',
    fps: 10,
    durationSeconds: 1,
    timeSemantics: 'seconds',
    sourceBones: [],
    targetTracks: [
      {
        targetNodeName: 'Hips',
        targetNodeIndex: 0,
        targetRole: 'hips',
        rotations: [
          { timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 },
          { timeSeconds: 1, ...quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)) },
        ],
      },
      {
        targetNodeName: 'Spine',
        targetNodeIndex: 1,
        targetRole: 'spine',
        rotations: [
          { timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 },
          { timeSeconds: 1, ...quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)) },
        ],
      },
    ],
  },
}

test('resolveMotionRetargetPreviewClip fails closed for diagnostics-only artifacts and does not fabricate keyframes', () => {
  const result = resolveMotionRetargetPreviewClip({
    summary: rigSummary,
    artifact: {
      ...compatibleArtifact,
      diagnostics: { ...compatibleArtifact.diagnostics, raw: {} },
      motionRetarget: undefined,
    },
  })

  assert.equal(result.available, false)
  assert.match(result.warnings.join('\n'), /translated quaternion payload/i)
  assert.equal(result.plan, undefined)
})

test('resolveMotionRetargetPreviewClip disables rotation-only playback when basis rest-pose evidence is omitted', () => {
  const result = resolveMotionRetargetPreviewClip({
    summary: rigSummary,
    artifact: {
      ...compatibleArtifact,
      motionRetarget: {
        ...compatibleArtifact.motionRetarget!,
        omittedChannels: [
          { targetNodeName: '*', channel: 'basis_rest_pose', reason: 'basis/rest-pose evidence not emitted by solver export' },
        ],
      },
    },
  })

  assert.equal(result.available, false)
  assert.equal(result.plan, undefined)
  assert.deepEqual(result.warnings, [
    'Local rotation preview disabled because Kimodo omitted basis/rest-pose evidence; use animated GLB playback or export sidecar for rerun.',
  ])
})

test('resolveMotionRetargetPreviewClip disables rotation-only playback for invalid Kimodo basis safety contract', () => {
  const result = resolveMotionRetargetPreviewClip({
    summary: rigSummary,
    artifact: {
      ...compatibleArtifact,
      diagnostics: {
        ...compatibleArtifact.diagnostics,
        solverStatus: 'preview',
        basisStatus: 'invalid',
        rootMotionStatus: 'preserve_root_motion',
        visualQualityStatus: 'warning',
        warnings: ['basis_corrected_rotation_channels_skipped_invalid_basis'],
      },
    },
  })

  assert.equal(result.available, false)
  assert.equal(result.plan, undefined)
  assert.deepEqual(result.warnings, [
    'Local rotation preview disabled because Kimodo marked the retarget basis invalid; use animated GLB playback or export sidecar for rerun.',
  ])
})

test('evaluateMotionRetargetPreview scrubs compatible explicit quaternion data onto target bones and ignores translation or scale metadata', () => {
  const preview = resolveMotionRetargetPreviewClip({ summary: rigSummary, artifact: compatibleArtifact })
  assert.equal(preview.available, true)

  const hips = new THREE.Bone()
  const spine = new THREE.Bone()
  hips.position.set(7, 8, 9)
  spine.scale.set(4, 5, 6)
  const beforePosition = hips.position.clone()
  const beforeScale = spine.scale.clone()
  const bonesById = new Map([
    ['rig:hero|skeleton:0|bone:hips#0', hips],
    ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
  ])

  const result = evaluateMotionRetargetPreview({
    plan: preview.plan!,
    bonesById,
    timeSeconds: 0.5,
  })

  assert.deepEqual(result.appliedBoneIds, [
    'rig:hero|skeleton:0|bone:hips#0',
    'rig:hero|skeleton:0|bone:hips#0/spine#0',
  ])
  assertQuaternionClose(hips.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2))
  assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
  assert.deepEqual(hips.position.toArray(), beforePosition.toArray())
  assert.deepEqual(spine.scale.toArray(), beforeScale.toArray())
  assert.equal(JSON.stringify(preview.plan).includes('translation'), false)
  assert.equal(JSON.stringify(preview.plan).includes('scale'), false)
 })

test('resolveMotionRetargetPreviewClip applies manual source-role mappings to preview target bones without mutating metadata', () => {
  const remappedArtifact = structuredClone(compatibleArtifact)
  const preview = resolveMotionRetargetPreviewClip({
    summary: rigSummary,
    artifact: remappedArtifact,
    sourceBones: [
      { sourceBoneId: 'src:hips', label: 'Source Hips', rawLabel: 'Source Hips', role: 'hips', path: ['Source Hips'] },
      { sourceBoneId: 'src:spine', label: 'Source Spine', rawLabel: 'Source Spine', role: 'spine', path: ['Source Hips', 'Source Spine'], parentSourceBoneId: 'src:hips' },
    ],
    mappings: {
      'src:hips': { sourceBoneId: 'src:hips', targetBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0' },
      'src:spine': { sourceBoneId: 'src:spine', targetBoneId: 'rig:hero|skeleton:0|bone:hips#0' },
    },
  })

  assert.equal(preview.available, true)
  assert.deepEqual(preview.plan?.keyframes.map((keyframe) => ({ timeSeconds: keyframe.timeSeconds, boneId: keyframe.boneId, rotation: keyframe.rotation })), [
    { timeSeconds: 0, boneId: 'rig:hero|skeleton:0|bone:hips#0', rotation: { x: 0, y: 0, z: 0, w: 1 } },
    { timeSeconds: 0, boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', rotation: { x: 0, y: 0, z: 0, w: 1 } },
    { timeSeconds: 1, boneId: 'rig:hero|skeleton:0|bone:hips#0', rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)) },
    { timeSeconds: 1, boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)) },
  ])
  assert.deepEqual(remappedArtifact, compatibleArtifact)
})

test('restoreThenEvaluateMotionRetargetPreview and resetMotionRetargetPreview restore the pre-preview pose without mutating the explicit clip data', () => {
  const preview = resolveMotionRetargetPreviewClip({ summary: rigSummary, artifact: compatibleArtifact })
  assert.equal(preview.available, true)

  const hips = new THREE.Bone()
  const spine = new THREE.Bone()
  hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 7)
  spine.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 9)
  const originalHips = hips.quaternion.clone()
  const originalSpine = spine.quaternion.clone()
  const bonesById = new Map([
    ['rig:hero|skeleton:0|bone:hips#0', hips],
    ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
  ])
  const snapshot = takeMotionRetargetPreviewSnapshot(bonesById)
  const planBefore = structuredClone(preview.plan)

  hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 3)
  spine.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 4)

  const scrubbed = restoreThenEvaluateMotionRetargetPreview({
    plan: preview.plan!,
    bonesById,
    snapshot,
    timeSeconds: 0.5,
  })

  assert.deepEqual(scrubbed.restoredBoneIds, [
    'rig:hero|skeleton:0|bone:hips#0',
    'rig:hero|skeleton:0|bone:hips#0/spine#0',
  ])
  assertQuaternionClose(hips.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2))
  assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
  assert.deepEqual(preview.plan, planBefore)

  const reset = resetMotionRetargetPreview({ bonesById, snapshot })
  assert.equal(reset.timeSeconds, 0)
  assertQuaternionClose(hips.quaternion, originalHips)
  assertQuaternionClose(spine.quaternion, originalSpine)
})

test('applyMotionRetargetPreviewCorrections changes root preview position only and leaves metadata untouched', () => {
  const hips = new THREE.Bone()
  const spine = new THREE.Bone()
  hips.position.set(2, 3, 4)
  spine.position.set(9, 9, 9)
  const bonesById = new Map([
    ['rig:hero|skeleton:0|bone:hips#0', hips],
    ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
  ])
  const snapshot = takeMotionRetargetPreviewSnapshot(bonesById)
  const plan = structuredClone(resolveMotionRetargetPreviewClip({ summary: rigSummary, artifact: compatibleArtifact }).plan!)
  const planBefore = structuredClone(plan)

  const result = applyMotionRetargetPreviewCorrections({
    summary: rigSummary,
    bonesById,
    snapshot,
    corrections: {
      rootTranslationPolicy: 'preserve_scaled_npz',
      rootMotionScale: 1.5,
      rootOffset: { x: 0.25, y: -0.5, z: 2 },
      previewMode: 'after',
    },
  })

  assert.deepEqual(result.appliedRootBoneIds, ['rig:hero|skeleton:0|bone:hips#0'])
  assert.deepEqual(hips.position.toArray(), [3.25, 4, 8])
  assert.deepEqual(spine.position.toArray(), [9, 9, 9])
  assert.deepEqual(plan, planBefore)
})

test('applyMotionRetargetPreviewCorrections supports before/reset framing without mutating saved snapshots', () => {
  const hips = new THREE.Bone()
  hips.position.set(1, 2, 3)
  const bonesById = new Map([['rig:hero|skeleton:0|bone:hips#0', hips]])
  const snapshot = takeMotionRetargetPreviewSnapshot(bonesById)
  const snapshotBefore = snapshot.get('rig:hero|skeleton:0|bone:hips#0')!.position.clone()

  applyMotionRetargetPreviewCorrections({
    summary: rigSummary,
    bonesById,
    snapshot,
    corrections: {
      rootTranslationPolicy: 'in_place',
      rootMotionScale: 3,
      rootOffset: { x: 10, y: 10, z: 10 },
      previewMode: 'before',
    },
  })

  assert.deepEqual(hips.position.toArray(), [1, 2, 3])
  assert.deepEqual(snapshot.get('rig:hero|skeleton:0|bone:hips#0')!.position.toArray(), snapshotBefore.toArray())
})

test('takeMotionRetargetPreviewSnapshot captures position, quaternion, and scale for each preview bone', () => {
  const hips = new THREE.Bone()
  const spine = new THREE.Bone()
  hips.position.set(1, 2, 3)
  hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 5)
  hips.scale.set(2, 3, 4)
  spine.position.set(-1, -2, -3)
  spine.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6)
  spine.scale.set(0.5, 0.75, 1.25)

  const snapshot = takeMotionRetargetPreviewSnapshot(new Map([
    ['rig:hero|skeleton:0|bone:hips#0', hips],
    ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
  ]))

  const hipsSnapshot = snapshot.get('rig:hero|skeleton:0|bone:hips#0')!
  const spineSnapshot = snapshot.get('rig:hero|skeleton:0|bone:hips#0/spine#0')!
  assert.deepEqual(hipsSnapshot.position.toArray(), [1, 2, 3])
  assertQuaternionClose(hipsSnapshot.quaternion, hips.quaternion)
  assert.deepEqual(hipsSnapshot.scale.toArray(), [2, 3, 4])
  assert.deepEqual(spineSnapshot.position.toArray(), [-1, -2, -3])
  assertQuaternionClose(spineSnapshot.quaternion, spine.quaternion)
  assert.deepEqual(spineSnapshot.scale.toArray(), [0.5, 0.75, 1.25])
})

test('resetMotionRetargetPreview restores position, quaternion, and scale and repeated Reset is a safe no-op', () => {
  const hips = new THREE.Bone()
  hips.position.set(3, 4, 5)
  hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 8)
  hips.scale.set(1.1, 1.2, 1.3)
  const bonesById = new Map([['rig:hero|skeleton:0|bone:hips#0', hips]])
  const snapshot = takeMotionRetargetPreviewSnapshot(bonesById)
  const original = snapshot.get('rig:hero|skeleton:0|bone:hips#0')!

  hips.position.set(30, 40, 50)
  hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
  hips.scale.set(9, 8, 7)

  const firstReset = resetMotionRetargetPreview({ bonesById, snapshot })
  const secondReset = resetMotionRetargetPreview({ bonesById, snapshot })

  assert.deepEqual(firstReset, { restoredBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], timeSeconds: 0 })
  assert.deepEqual(secondReset, { restoredBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], timeSeconds: 0 })
  assert.deepEqual(hips.position.toArray(), original.position.toArray())
  assertQuaternionClose(hips.quaternion, original.quaternion)
  assert.deepEqual(hips.scale.toArray(), original.scale.toArray())
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
