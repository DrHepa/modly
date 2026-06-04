import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { AnimationClip, AnimationMixer, Bone, LoopOnce, QuaternionKeyframeTrack, Skeleton } from 'three'

import {
  buildPoseClipSidecarV1,
  clampPoseClipTime,
  createPoseClipCaptureKeyframeId,
  deriveKimodoPoseClipCompanionV1,
  createPoseClipDuplicateKeyframeId,
  createLegacyPoseClipSidecarWorkspacePath,
  createPoseClipPlan,
  createPoseClipSidecarWorkspacePath,
  hydratePoseClipPlanFromSidecar,
  reducePoseClipPlan,
  resolveKimodoTargetTracksForManualMappings,
  validatePoseClipSidecarWorkspacePath,
  type PoseClipPlan,
  type PoseClipPlanAction,
  type PoseClipSidecarV1,
} from './poseClipPlan.ts'
import { normalizeKimodoMotionArtifact, type KimodoMotionArtifact, type KimodoMotionRetargetTargetTrack } from './kimodoMotionAdapter.ts'
import { collectRigSkeletonBinding, type RigSkeletonSummary } from './rigSkeleton.ts'
import { createPoseClipPreviewSession, evaluatePoseClipPreviewSession, restorePoseClipPreviewSession } from './poseClipPreview.ts'

const rigSummary: RigSkeletonSummary = {
  hasRig: true,
  sourceWorkspacePath: 'Workflows/generated/hero character.glb',
  skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
  skinnedMeshContexts: ['rig:Hero_Mesh|skeleton:0'],
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
      originalName: 'Arm',
      path: ['Hips', 'Arm'],
      siblingIndex: 0,
      parentId: 'bone:hips',
      childIds: [],
      warnings: ['duplicate-name'],
    },
    {
      boneId: 'bone:right-arm',
      label: 'Arm',
      originalName: 'Arm',
      path: ['Hips', 'Arm'],
      siblingIndex: 1,
      parentId: 'bone:hips',
      childIds: [],
      warnings: ['duplicate-name'],
    },
  ],
}

test('reducePoseClipPlan initializes, selects by stable RigBoneId, captures quaternion keyframes, updates one keyframe and deletes without mutating inputs', () => {
  const emptyPlan = createPoseClipPlan(rigSummary, { clipId: 'clip-hero-idle', name: 'Hero Idle', durationSeconds: 2, fps: 24 })
  const emptyBefore = structuredClone(emptyPlan)

  const selected = reducePoseClipPlan(rigSummary, emptyPlan, {
    type: 'select-bone',
    boneId: 'bone:left-arm',
  })

  const captured = reducePoseClipPlan(rigSummary, selected, {
    type: 'capture-keyframe',
    keyframeId: 'kf-left-0',
    timeSeconds: 0.5,
    rotation: { x: 0, y: 0.25, z: 0, w: 0.9682458 },
  })

  assert.deepEqual(emptyPlan, emptyBefore)
  assert.equal(captured.selectedBoneId, 'bone:left-arm')
  assert.deepEqual(captured.keyframes, [
    {
      id: 'kf-left-0',
      timeSeconds: 0.5,
      boneId: 'bone:left-arm',
      rotation: { x: 0, y: 0.25, z: 0, w: 0.9682458 },
    },
  ])

  const updated = reducePoseClipPlan(rigSummary, captured, {
    type: 'update-keyframe',
    keyframeId: 'kf-left-0',
    timeSeconds: 1.25,
    rotation: { x: 0, y: 0.5, z: 0, w: 0.8660254 },
  })
  assert.deepEqual(updated.keyframes, [
    {
      id: 'kf-left-0',
      timeSeconds: 1.25,
      boneId: 'bone:left-arm',
      rotation: { x: 0, y: 0.5, z: 0, w: 0.8660254 },
    },
  ])

  const deleted = reducePoseClipPlan(rigSummary, updated, { type: 'delete-keyframe', keyframeId: 'kf-left-0' })
  assert.deepEqual(deleted.keyframes, [])
  assert.equal(deleted.selectedBoneId, 'bone:left-arm')
})

test('reducePoseClipPlan ignores unknown bone selections and captures, clamps timeline values, resets to a fresh plan and preserves stable ids despite duplicate labels', () => {
  const plan = createPoseClipPlan(rigSummary, { clipId: 'clip-hero-wave', name: 'Hero Wave', durationSeconds: 1, fps: 12 })
  const unknownActions: PoseClipPlanAction[] = [
    { type: 'select-bone', boneId: 'bone:missing' },
    {
      type: 'capture-keyframe',
      keyframeId: 'kf-missing',
      timeSeconds: 0,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
  ]

  const afterUnknownActions = unknownActions.reduce((current, action) => reducePoseClipPlan(rigSummary, current, action), plan)
  assert.deepEqual(afterUnknownActions.keyframes, [])
  assert.equal(afterUnknownActions.selectedBoneId, undefined)

  const withRightArm = reducePoseClipPlan(rigSummary, plan, { type: 'select-bone', boneId: 'bone:right-arm' })
  const captured = reducePoseClipPlan(rigSummary, withRightArm, {
    type: 'capture-keyframe',
    keyframeId: 'kf-right-overrun',
    timeSeconds: 3,
    rotation: { x: 0.1, y: 0.2, z: 0.3, w: 0.9 },
    translation: { x: 1, y: 2, z: 3 },
    scale: { x: 1, y: 1, z: 1 },
  })
  assert.deepEqual(captured.keyframes, [
    {
      id: 'kf-right-overrun',
      timeSeconds: 1,
      boneId: 'bone:right-arm',
      rotation: { x: 0.1, y: 0.2, z: 0.3, w: 0.9 },
      translation: { x: 1, y: 2, z: 3 },
      scale: { x: 1, y: 1, z: 1 },
    },
  ])

  const reset = reducePoseClipPlan(rigSummary, captured, { type: 'reset' })
  assert.deepEqual(reset, createPoseClipPlan(rigSummary, { clipId: 'clip-hero-wave', name: 'Hero Wave', durationSeconds: 1, fps: 12 }))
})

test('buildPoseClipSidecarV1 creates sidecar-first schema metadata and deterministic safe workspace path without mutating source summary or plan', () => {
  const plan = reducePoseClipPlan(
    rigSummary,
    reducePoseClipPlan(rigSummary, createPoseClipPlan(rigSummary, { clipId: 'clip-hero-wave', name: 'Hero Wave', durationSeconds: 2, fps: 24 }), {
      type: 'select-bone',
      boneId: 'bone:right-arm',
    }),
    {
      type: 'capture-keyframe',
      keyframeId: 'kf-right-1',
      timeSeconds: 1,
      rotation: { x: 0, y: 0, z: 0.7071068, w: 0.7071068 },
    },
  )
  const planBefore = structuredClone(plan)
  const summaryBefore = structuredClone(rigSummary)

  const sidecar = buildPoseClipSidecarV1({
    summary: rigSummary,
    plan,
    createdAt: '2026-05-19T22:10:00.000Z',
    source: { workspacePath: 'Workflows/generated/hero character.glb', artifactId: 'artifact-1', versionId: 'version-1' },
  })

  assert.deepEqual(sidecar, {
    schema: 'modly.pose-clip',
    version: 1,
    createdAt: '2026-05-19T22:10:00.000Z',
    source: { workspacePath: 'Workflows/generated/hero character.glb', artifactId: 'artifact-1', versionId: 'version-1' },
    skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
    clip: { id: 'clip-hero-wave', name: 'Hero Wave', durationSeconds: 2, fps: 24 },
    skeleton: {
      rootBoneIds: ['bone:hips'],
      boneCount: 3,
      bones: [
        { boneId: 'bone:hips', label: 'Hips', originalName: 'Hips', path: ['Hips'] },
        { boneId: 'bone:left-arm', label: 'Arm', originalName: 'Arm', path: ['Hips', 'Arm'] },
        { boneId: 'bone:right-arm', label: 'Arm', originalName: 'Arm', path: ['Hips', 'Arm'] },
      ],
    },
    keyframes: [
      {
        id: 'kf-right-1',
        timeSeconds: 1,
        boneId: 'bone:right-arm',
        rotation: { x: 0, y: 0, z: 0.7071068, w: 0.7071068 },
      },
    ],
  })
  assert.equal(
    createPoseClipSidecarWorkspacePath('Workflows/generated/nested/hero character.glb'),
    'Workflows/pose-clips/hero-character--src-017862172bbbcc46.pose-clip.v1.json',
  )
  assert.deepEqual(plan, planBefore)
  assert.deepEqual(rigSummary, summaryBefore)
})

test('createPoseClipSidecarWorkspacePath should derive distinct sidecars for same-basename workflow sources', () => {
  const sourceA = 'Workflows/run-a/animated.glb'
  const sourceB = 'Workflows/run-b/animated.glb'

  const sidecarA = createPoseClipSidecarWorkspacePath(sourceA)
  const sidecarB = createPoseClipSidecarWorkspacePath(sourceB)

  assert.equal(sidecarA, 'Workflows/pose-clips/animated--src-9d243f14d9c41ea6.pose-clip.v1.json')
  assert.equal(sidecarB, 'Workflows/pose-clips/animated--src-47c514e2ff697745.pose-clip.v1.json')
  assert.notEqual(
    sidecarA,
    sidecarB,
    'Pose/Clip sidecar paths must include collision-resistant source identity, not only the source basename.',
  )
})

test('createPoseClipSidecarWorkspacePath is deterministic, readable and rejects unsafe source paths with null', () => {
  const source = 'Workflows/generated/hero character.glb'

  assert.equal(
    createPoseClipSidecarWorkspacePath(source),
    createPoseClipSidecarWorkspacePath(source),
  )
  assert.match(
    createPoseClipSidecarWorkspacePath(source) ?? '',
    /^Workflows\/pose-clips\/hero-character--src-[0-9a-f]{16}\.pose-clip\.v1\.json$/,
  )

  for (const unsafeSource of [
    '',
    '/Workflows/generated/hero.glb',
    'C:\\Workflows\\generated\\hero.glb',
    'Workflows\\generated\\hero.glb',
    'Workflows/generated/../hero.glb',
  ]) {
    assert.equal(createPoseClipSidecarWorkspacePath(unsafeSource), null, unsafeSource)
  }
})

test('createLegacyPoseClipSidecarWorkspacePath derives only backward-compatible basename sidecars and rejects unsafe source paths', () => {
  assert.equal(
    createLegacyPoseClipSidecarWorkspacePath('Workflows/run-a/animated.glb'),
    'Workflows/pose-clips/animated.pose-clip.v1.json',
  )
  assert.equal(
    createLegacyPoseClipSidecarWorkspacePath('Workflows/run-b/animated.glb'),
    'Workflows/pose-clips/animated.pose-clip.v1.json',
  )

  for (const unsafeSource of [
    '',
    '/Workflows/generated/hero.glb',
    'C:\\Workflows\\generated\\hero.glb',
    'Workflows\\generated\\hero.glb',
    'Workflows/generated/../hero.glb',
  ]) {
    assert.equal(createLegacyPoseClipSidecarWorkspacePath(unsafeSource), null, unsafeSource)
  }
})

test('buildPoseClipSidecarV1 preserves the v1 sidecar schema without persisting timeline UI state or embedded export metadata', () => {
  const plan = {
    ...createPoseClipPlan(rigSummary, { clipId: 'clip-v1-regression', name: 'V1 Regression', durationSeconds: 1, fps: 10 }),
    selectedBoneId: 'bone:left-arm',
    keyframes: [
      { id: 'kf-left-0', timeSeconds: 0, boneId: 'bone:left-arm', rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { id: 'kf-left-1', timeSeconds: 0.1, boneId: 'bone:left-arm', rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 } },
    ],
  }

  const sidecar = buildPoseClipSidecarV1({
    summary: rigSummary,
    plan,
    createdAt: '2026-05-20T12:00:00.000Z',
    source: { workspacePath: 'Workflows/generated/hero character.glb', artifactId: 'artifact-v1', versionId: 'version-v1' },
  })

  assert.deepEqual(Object.keys(sidecar), ['schema', 'version', 'createdAt', 'source', 'skeletonContextId', 'clip', 'skeleton', 'keyframes'])
  assert.deepEqual(Object.keys(sidecar.clip), ['id', 'name', 'durationSeconds', 'fps'])
  assert.deepEqual(sidecar.keyframes.map((keyframe) => keyframe.timeSeconds), [0, 0.1])
  assert.equal(sidecar.schema, 'modly.pose-clip')
  assert.equal(sidecar.version, 1)
  assert.equal('currentTimeSeconds' in sidecar, false)
  assert.equal('selectedKeyframeId' in sidecar, false)
  assert.equal('selectedBoneId' in sidecar, false)
  assert.equal('playhead' in sidecar, false)
  assert.equal('embeddedGlb' in sidecar, false)
  assert.equal('export' in sidecar, false)
})

test('buildPoseClipSidecarV1 keeps display and effective labels out of persisted v1 sidecars', () => {
  const planWithUiOnlyFields = {
    ...createPoseClipPlan(rigSummary, { clipId: 'clip-label-regression', name: 'Label Regression', durationSeconds: 1, fps: 10 }),
    selectedBoneId: 'bone:left-arm',
    currentTimeSeconds: 0.75,
    selectedKeyframeId: 'kf-left-0',
    rigDisplayNames: {
      byBoneId: {
        'bone:left-arm': { boneId: 'bone:left-arm', label: 'Manual Left Arm', rawLabel: 'Arm', provenance: 'manual' },
        'bone:right-arm': { boneId: 'bone:right-arm', label: 'UniRig Right Arm', rawLabel: 'Arm', provenance: 'unirig' },
      },
      ordered: [],
    },
    effectiveNamingByBoneId: {
      'bone:left-arm': { label: 'Manual Left Arm', source: 'manual' },
      'bone:right-arm': { label: 'UniRig Right Arm', source: 'humanoid_contract' },
    },
    keyframes: [
      { id: 'kf-left-0', timeSeconds: 0.5, boneId: 'bone:left-arm', rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 } },
    ],
  } as PoseClipPlan & Record<string, unknown>

  const sidecar = buildPoseClipSidecarV1({
    summary: rigSummary,
    plan: planWithUiOnlyFields,
    createdAt: '2026-05-20T12:30:00.000Z',
    source: { workspacePath: 'Workflows/generated/hero character.glb' },
  })
  const serialized = JSON.stringify(sidecar)

  assert.deepEqual(Object.keys(sidecar), ['schema', 'version', 'createdAt', 'source', 'skeletonContextId', 'clip', 'skeleton', 'keyframes'])
  assert.deepEqual(sidecar.keyframes, [
    { id: 'kf-left-0', timeSeconds: 0.5, boneId: 'bone:left-arm', rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 } },
  ])
  assert.equal(serialized.includes('Manual Left Arm'), false)
  assert.equal(serialized.includes('UniRig Right Arm'), false)
  assert.equal(serialized.includes('effectiveNaming'), false)
  assert.equal(serialized.includes('rigDisplayNames'), false)
  assert.equal(serialized.includes('currentTimeSeconds'), false)
  assert.equal(serialized.includes('selectedKeyframeId'), false)
  assert.equal(serialized.includes('selectedBoneId'), false)
})

test('hydratePoseClipPlanFromSidecar hydrates compatible keyframes by stable RigBoneId and ignores unknown ids instead of rebinding by duplicate label or index', () => {
  const sidecar: PoseClipSidecarV1 = {
    schema: 'modly.pose-clip',
    version: 1,
    createdAt: '2026-05-19T22:11:00.000Z',
    source: { workspacePath: 'Workflows/generated/hero character.glb' },
    skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
    clip: { id: 'clip-loaded', name: 'Loaded Clip', durationSeconds: 3, fps: 30 },
    skeleton: {
      rootBoneIds: ['bone:hips'],
      boneCount: 4,
      bones: [
        { boneId: 'bone:left-arm', label: 'Legacy Arm', originalName: 'Arm', path: ['Legacy', 'Arm'] },
        { boneId: 'bone:missing-arm', label: 'Arm', originalName: 'Arm', path: ['Legacy', 'Arm'] },
      ],
    },
    keyframes: [
      { id: 'kf-left', timeSeconds: 0.25, boneId: 'bone:left-arm', rotation: { x: 0, y: 0.1, z: 0, w: 0.995 } },
      { id: 'kf-missing', timeSeconds: 0.5, boneId: 'bone:missing-arm', rotation: { x: 0, y: 0.2, z: 0, w: 0.98 } },
    ],
  }

  const result = hydratePoseClipPlanFromSidecar(rigSummary, sidecar, {
    sourceWorkspacePath: 'Workflows/generated/hero character.glb',
    skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.ignoredBoneIds, ['bone:missing-arm'])
  assert.match(result.warnings.join('\n'), /unknown boneId "bone:missing-arm"/i)
  assert.deepEqual(result.plan.keyframes, [
    { id: 'kf-left', timeSeconds: 0.25, boneId: 'bone:left-arm', rotation: { x: 0, y: 0.1, z: 0, w: 0.995 } },
  ])
})

test('hydratePoseClipPlanFromSidecar rejects incompatible source, skeleton context and invalid schema with empty editable plans and warnings', () => {
  const validSidecar = buildPoseClipSidecarV1({
    summary: rigSummary,
    plan: createPoseClipPlan(rigSummary, { clipId: 'clip-invalid-test', name: 'Invalid Test', durationSeconds: 2, fps: 24 }),
    createdAt: '2026-05-19T22:12:00.000Z',
  })

  const sourceMismatch = hydratePoseClipPlanFromSidecar(rigSummary, validSidecar, {
    sourceWorkspacePath: 'Workflows/generated/other.glb',
    skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
  })
  assert.equal(sourceMismatch.valid, false)
  assert.deepEqual(sourceMismatch.plan.keyframes, [])
  assert.match(sourceMismatch.warnings.join('\n'), /source mismatch/i)

  const skeletonMismatch = hydratePoseClipPlanFromSidecar(rigSummary, validSidecar, {
    sourceWorkspacePath: 'Workflows/generated/hero character.glb',
    skeletonContextId: 'rig:Other|skeleton:0',
  })
  assert.equal(skeletonMismatch.valid, false)
  assert.deepEqual(skeletonMismatch.plan.keyframes, [])
  assert.match(skeletonMismatch.warnings.join('\n'), /skeletonContextId mismatch/i)

  for (const invalidSidecar of [
    { ...validSidecar, schema: 'modly.pose-clip.invalid' },
    { ...validSidecar, version: 2 },
    { ...validSidecar, keyframes: [{ id: 'bad', timeSeconds: 0, boneId: 'bone:hips' }] },
  ]) {
    const result = hydratePoseClipPlanFromSidecar(rigSummary, invalidSidecar, {
      sourceWorkspacePath: 'Workflows/generated/hero character.glb',
      skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
    })
    assert.equal(result.valid, false)
    assert.deepEqual(result.plan.keyframes, [])
    assert.notEqual(result.warnings.length, 0)
  }
})

test('validatePoseClipSidecarWorkspacePath rejects absolute paths, traversal, wrong prefix or suffix, and source overwrite risk', () => {
  assert.deepEqual(
    validatePoseClipSidecarWorkspacePath({
      sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json',
      sourceWorkspacePath: 'Workflows/generated/hero.glb',
    }),
    { valid: true, warnings: [] },
  )

  const invalidPaths = [
    '/Workflows/pose-clips/hero.pose-clip.v1.json',
    'Workflows/pose-clips/../generated/hero.pose-clip.v1.json',
    'Workflows/generated/hero.pose-clip.v1.json',
    'Workflows/pose-clips/hero.json',
    'Workflows/generated/hero.glb',
  ]

  for (const invalidPath of invalidPaths) {
    const result = validatePoseClipSidecarWorkspacePath({
      sidecarWorkspacePath: invalidPath,
      sourceWorkspacePath: 'Workflows/generated/hero.glb',
    })
    assert.equal(result.valid, false, invalidPath)
    assert.notEqual(result.warnings.length, 0, invalidPath)
  }
})

test('clampPoseClipTime clamps current-time authoring inputs to clip duration bounds', () => {
  assert.equal(clampPoseClipTime(-1, 2), 0)
  assert.equal(clampPoseClipTime(3, 2), 2)
  assert.equal(clampPoseClipTime(0.75, 2), 0.75)
  assert.equal(clampPoseClipTime(Number.NaN, 2), 0)
})

test('reducePoseClipPlan updates duration and FPS metadata with safe clamps without mutating the input plan', () => {
  const plan = reducePoseClipPlan(
    rigSummary,
    reducePoseClipPlan(rigSummary, createPoseClipPlan(rigSummary, { clipId: 'clip-meta', durationSeconds: 2, fps: 24 }), {
      type: 'select-bone',
      boneId: 'bone:left-arm',
    }),
    {
      type: 'capture-keyframe',
      keyframeId: 'kf-left-late',
      timeSeconds: 1.5,
      rotation: { x: 0, y: 0.2, z: 0, w: 0.98 },
    },
  )
  const before = structuredClone(plan)

  const updated = reducePoseClipPlan(rigSummary, plan, {
    type: 'set-clip-metadata',
    durationSeconds: -5,
    fps: 0,
  })

  assert.equal(updated.clip.durationSeconds, 0.001)
  assert.equal(updated.clip.fps, 1)
  assert.deepEqual(updated.keyframes, [
    {
      id: 'kf-left-late',
      timeSeconds: 0.001,
      boneId: 'bone:left-arm',
      rotation: { x: 0, y: 0.2, z: 0, w: 0.98 },
    },
  ])
  assert.deepEqual(plan, before)
})

test('reducing duration clamps keyframe times and preserves stable ordering by time, bone and id', () => {
  const plan = {
    ...createPoseClipPlan(rigSummary, { clipId: 'clip-order', durationSeconds: 3, fps: 10 }),
    keyframes: [
      { id: 'z-late', timeSeconds: 2.8, boneId: 'bone:right-arm', rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { id: 'a-late', timeSeconds: 2.5, boneId: 'bone:left-arm', rotation: { x: 0, y: 0.1, z: 0, w: 0.99 } },
      { id: 'a-early', timeSeconds: 0.2, boneId: 'bone:hips', rotation: { x: 0, y: 0.2, z: 0, w: 0.98 } },
      { id: 'a-right', timeSeconds: 2.7, boneId: 'bone:right-arm', rotation: { x: 0, y: 0.3, z: 0, w: 0.95 } },
    ],
  }
  const before = structuredClone(plan)

  const updated = reducePoseClipPlan(rigSummary, plan, { type: 'set-clip-metadata', durationSeconds: 1 })

  assert.deepEqual(updated.keyframes.map((keyframe) => [keyframe.id, keyframe.timeSeconds, keyframe.boneId]), [
    ['a-early', 0.2, 'bone:hips'],
    ['a-late', 1, 'bone:left-arm'],
    ['a-right', 1, 'bone:right-arm'],
    ['z-late', 1, 'bone:right-arm'],
  ])
  assert.deepEqual(plan, before)
})

test('reducePoseClipPlan moves and shifts keyframe times with duration clamps and stable ordering', () => {
  const plan = {
    ...createPoseClipPlan(rigSummary, { clipId: 'clip-move', durationSeconds: 1, fps: 10 }),
    keyframes: [
      { id: 'kf-right', timeSeconds: 0.4, boneId: 'bone:right-arm', rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { id: 'kf-left', timeSeconds: 0.6, boneId: 'bone:left-arm', rotation: { x: 0, y: 0.2, z: 0, w: 0.98 } },
    ],
  }
  const before = structuredClone(plan)

  const moved = reducePoseClipPlan(rigSummary, plan, { type: 'move-keyframe', keyframeId: 'kf-right', timeSeconds: 2 })
  const shifted = reducePoseClipPlan(rigSummary, moved, { type: 'shift-keyframe', keyframeId: 'kf-left', deltaSeconds: -2 })

  assert.deepEqual(moved.keyframes.map((keyframe) => [keyframe.id, keyframe.timeSeconds]), [
    ['kf-left', 0.6],
    ['kf-right', 1],
  ])
  assert.deepEqual(shifted.keyframes.map((keyframe) => [keyframe.id, keyframe.timeSeconds]), [
    ['kf-left', 0],
    ['kf-right', 1],
  ])
  assert.deepEqual(plan, before)
})

test('createPoseClipDuplicateKeyframeId and duplicate action use the lowest free positive copy suffix deterministically', () => {
  const plan = {
    ...createPoseClipPlan(rigSummary, { clipId: 'clip-duplicate', durationSeconds: 1, fps: 10 }),
    keyframes: [
      { id: 'kf1', timeSeconds: 0.5, boneId: 'bone:left-arm', rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { id: 'kf1__copy-1', timeSeconds: 0.6, boneId: 'bone:left-arm', rotation: { x: 0, y: 0.1, z: 0, w: 0.99 } },
      { id: 'kf1__copy-3', timeSeconds: 0.7, boneId: 'bone:left-arm', rotation: { x: 0, y: 0.2, z: 0, w: 0.98 } },
    ],
  }
  const before = structuredClone(plan)

  assert.equal(createPoseClipDuplicateKeyframeId(plan, 'kf1'), 'kf1__copy-2')
  const duplicated = reducePoseClipPlan(rigSummary, plan, { type: 'duplicate-keyframe', keyframeId: 'kf1' })

  assert.deepEqual(duplicated.keyframes.map((keyframe) => keyframe.id), ['kf1', 'kf1__copy-1', 'kf1__copy-2', 'kf1__copy-3'])
  assert.deepEqual(duplicated.keyframes.find((keyframe) => keyframe.id === 'kf1__copy-2'), {
    id: 'kf1__copy-2',
    timeSeconds: 0.6,
    boneId: 'bone:left-arm',
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  })
  assert.deepEqual(plan, before)
})

test('createPoseClipCaptureKeyframeId is deterministic from bone, time and frame with the lowest free suffix', () => {
  const plan = {
    ...createPoseClipPlan(rigSummary, { clipId: 'clip-capture-id', durationSeconds: 2, fps: 24 }),
    keyframes: [
      { id: 'kf-bone-left-arm-t0p500-f12-1', timeSeconds: 0.5, boneId: 'bone:left-arm', rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { id: 'kf-bone-left-arm-t0p500-f12-3', timeSeconds: 0.5, boneId: 'bone:left-arm', rotation: { x: 0, y: 0.1, z: 0, w: 0.99 } },
    ],
  }
  const before = structuredClone(plan)

  assert.equal(createPoseClipCaptureKeyframeId(plan, 'bone:left-arm', 0.5), 'kf-bone-left-arm-t0p500-f12-2')
  assert.equal(createPoseClipCaptureKeyframeId(plan, 'bone:right-arm', 0.5), 'kf-bone-right-arm-t0p500-f12-1')
  assert.deepEqual(plan, before)
})

test('pose hydration rejects non-finite payloads, invalid quaternions and duplicate key IDs', () => {
  const plan = { ...createPoseClipPlan(rigSummary), keyframes: [{ id: 'key', boneId: 'bone:hips', timeSeconds: 0, rotation: { x: 0, y: 0, z: 0, w: 1 } }] }
  const valid = buildPoseClipSidecarV1({ summary: rigSummary, plan })
  const variants = [
    { ...valid, clip: { ...valid.clip, durationSeconds: NaN } },
    { ...valid, clip: { ...valid.clip, fps: Infinity } },
    { ...valid, clip: { ...valid.clip, fps: 0 } },
    { ...valid, keyframes: [valid.keyframes[0], valid.keyframes[0]] },
    ...[NaN, Infinity].map((timeSeconds) => ({ ...valid, keyframes: [{ ...valid.keyframes[0], timeSeconds }] })),
    ...[{ x: 0, y: 0, z: 0, w: 0 }, { x: 0, y: Infinity, z: 0, w: 1 }].map((rotation) => ({ ...valid, keyframes: [{ ...valid.keyframes[0], rotation }] })),
    { ...valid, keyframes: [{ ...valid.keyframes[0], translation: { x: NaN, y: 0, z: 0 } }] },
  ]
  for (const sidecar of variants) {
    const result = hydratePoseClipPlanFromSidecar(rigSummary, sidecar, { sourceWorkspacePath: rigSummary.sourceWorkspacePath!, skeletonContextId: rigSummary.skeletonContextId })
    assert.equal(result.valid, false)
    assert.deepEqual(result.plan.keyframes, [])
  }
})

test('pose reducer rejects invalid rotations and reused capture IDs, preserves metadata and scopes context', () => {
  const selected = { ...createPoseClipPlan(rigSummary), selectedBoneId: 'bone:hips' }
  const capture = { type: 'capture-keyframe', keyframeId: 'key', timeSeconds: 0, rotation: { x: 0, y: 0, z: 0, w: 1 }, translation: { x: 1, y: 2, z: 3 }, scale: { x: 2, y: 2, z: 2 } } as const
  const plan = reducePoseClipPlan(rigSummary, selected, capture)
  assert.equal(reducePoseClipPlan(rigSummary, plan, capture).keyframes.length, 1)
  assert.deepEqual(reducePoseClipPlan(rigSummary, plan, { type: 'update-keyframe', keyframeId: 'key', rotation: { x: 0, y: 0, z: 0, w: NaN } }), plan)
  assert.deepEqual(reducePoseClipPlan(rigSummary, plan, { type: 'move-keyframe', keyframeId: 'key', timeSeconds: NaN }), plan)
  assert.equal(reducePoseClipPlan({ ...rigSummary, skeletonContextId: 'other' }, plan, { type: 'select-bone', boneId: 'bone:hips' }).keyframes.length, 0)
  const sidecar = buildPoseClipSidecarV1({ summary: rigSummary, plan })
  assert.deepEqual(sidecar.keyframes[0].translation, capture.translation)
  assert.deepEqual(sidecar.keyframes[0].scale, capture.scale)
  assert.throws(() => buildPoseClipSidecarV1({ summary: rigSummary, plan: { ...plan, skeletonContextId: 'other' } }), /context/i)
})


test('Pose/Clip routing normalizes supported relative forms but does not decode names or accept encoded escapes', () => {
  const source = 'Workflows/generated/hero%20character.glb'
  for (const variant of [source, ` ./Workflows//generated/./hero%20character.glb `]) {
    assert.equal(createPoseClipSidecarWorkspacePath(variant), createPoseClipSidecarWorkspacePath(source))
    assert.equal(createLegacyPoseClipSidecarWorkspacePath(variant), createLegacyPoseClipSidecarWorkspacePath(source))
  }
  assert.notEqual(createPoseClipSidecarWorkspacePath(source), createPoseClipSidecarWorkspacePath('Workflows/generated/hero character.glb'))
  for (const unsafe of ['Workflows/a%2fb.glb', 'Workflows/a%5Cb.glb', 'Workflows/%2e%2e/a.glb', 'Workflows/a\0.glb']) {
    assert.equal(createPoseClipSidecarWorkspacePath(unsafe), null, unsafe)
    assert.equal(createLegacyPoseClipSidecarWorkspacePath(unsafe), null, unsafe)
  }
})


test('Pose/Clip renderer routing matches main boundary fixtures for supported names', () => {
  const fixtures = [
    ['Workflows/run-b/hero character.glb', 'Workflows/pose-clips/hero-character--src-dac34d68cd2b28e7.pose-clip.v1.json', 'Workflows/pose-clips/hero-character.pose-clip.v1.json'],
    ['Workflows/run-b/hero%20character.glb', 'Workflows/pose-clips/hero-20character--src-1061d109a060e674.pose-clip.v1.json', 'Workflows/pose-clips/hero-20character.pose-clip.v1.json'],
    ['Workflows/run-b/骨骼.glb', 'Workflows/pose-clips/pose-clip--src-bc40ad4fa6793064.pose-clip.v1.json', 'Workflows/pose-clips/pose-clip.pose-clip.v1.json'],
    ['Workflows/run-b/---.glb', 'Workflows/pose-clips/pose-clip--src-8c69b281d6a56feb.pose-clip.v1.json', 'Workflows/pose-clips/pose-clip.pose-clip.v1.json'],
    ['Workflows/a/hero%20character.glb', 'Workflows/pose-clips/hero-20character--src-7d36eb3879a390db.pose-clip.v1.json', 'Workflows/pose-clips/hero-20character.pose-clip.v1.json'],
    ['Workflows/b/hero%20character.glb', 'Workflows/pose-clips/hero-20character--src-5f7c443a52d681cc.pose-clip.v1.json', 'Workflows/pose-clips/hero-20character.pose-clip.v1.json'],
    ['Workflows/hero.glb', 'Workflows/pose-clips/hero--src-8a3ec10a74f65eaf.pose-clip.v1.json', 'Workflows/pose-clips/hero.pose-clip.v1.json'],
    ['Workflows/hero character.glb', 'Workflows/pose-clips/hero-character--src-33c09f294e20c9a4.pose-clip.v1.json', 'Workflows/pose-clips/hero-character.pose-clip.v1.json'],
  ]
  for (const [source, hashed, legacy] of fixtures) {
    assert.equal(createPoseClipSidecarWorkspacePath(source), hashed)
    assert.equal(createLegacyPoseClipSidecarWorkspacePath(source), legacy)
  }
})

function createKimodoArtifactForCompanion(raw: Record<string, unknown>): KimodoMotionArtifact {
  return {
    extensionId: 'kimodo-soma-rp',
    nodeId: 'animate-rigged-mesh',
    sourceMeshWorkspacePath: rigSummary.sourceWorkspacePath,
    previewGlbWorkspacePath: 'Workflows/kimodo/run-1/preview.glb',
    animatedGlbWorkspacePath: 'Workflows/kimodo/run-1/animated.glb',
    bundleWorkspacePath: 'Workflows/kimodo/run-1',
    metadataWorkspacePath: 'Workflows/kimodo/run-1/metadata.json',
    diagnostics: {
      runtimeStatus: 'success',
      retargetStatus: 'success',
      solverStatus: null,
      basisStatus: null,
      rootMotionStatus: null,
      animationMappingStatus: 'trusted_contract',
      stabilizationStatus: 'not_evaluated',
      visualQualityStatus: 'warning',
      sourceKind: 'load_mesh_existing',
      mappingConfidence: 'compatible',
      retargetErrorCode: null,
      retargetErrorAliases: [],
      retargetErrorMessage: null,
      warnings: [],
      raw,
    },
  }
}

test('deriveKimodoPoseClipCompanionV1 builds an additive v1 sidecar only from compatible RigBoneId quaternion payloads', () => {
  const result = deriveKimodoPoseClipCompanionV1({
    summary: { ...rigSummary, bones: rigSummary.bones.map(bone => bone.boneId === 'bone:left-arm' ? { ...bone, role: 'left_arm' } : bone) },
    artifact: {
      ...createKimodoArtifactForCompanion({ clip_name: 'Kimodo Walk Forward' }),
      motionRetarget: {
        status: 'parsed',
        diagnostics: [],
        clipName: 'Kimodo Walk Forward',
        sourceContract: { schema: 'modly.humanoid.v1', trusted: true },
        mappingStatus: 'trusted_manual',
        mappingConfidence: 'compatible',
        fps: 30,
        durationSeconds: 1.5,
        timeSemantics: 'seconds',
        sourceBones: [{ sourceBoneId: 'src:hips', label: 'Source Hips', rawLabel: 'Hips' }],
        targetTracks: [
          {
            targetNodeName: 'Hips',
            targetNodeIndex: 0,
            rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }],
          },
          {
            targetNodeName: 'Arm',
            targetNodeIndex: 1,
            targetRole: 'left_arm',
            rotations: [{ timeSeconds: 0.5, x: 0, y: 0.3826834, z: 0, w: 0.9238795 }],
          },
        ],
      },
    },
    createdAt: '2026-05-21T18:00:00.000Z',
  })

  assert.equal(result.available, true)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.sidecarWorkspacePath, createPoseClipSidecarWorkspacePath(rigSummary.sourceWorkspacePath!)!.replace('.pose-clip.v1.json', '.kimodo-walk-forward.kimodo-companion.pose-clip.v1.json'))
  assert.notEqual(result.sidecarWorkspacePath, createPoseClipSidecarWorkspacePath(rigSummary.sourceWorkspacePath!))
  assert.deepEqual(result.sidecar, {
    schema: 'modly.pose-clip',
    version: 1,
    createdAt: '2026-05-21T18:00:00.000Z',
    source: { workspacePath: 'Workflows/generated/hero character.glb', artifactId: undefined, versionId: undefined },
    skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
    clip: { id: 'kimodo-walk-forward', name: 'Kimodo Walk Forward', durationSeconds: 1.5, fps: 30 },
    skeleton: {
      rootBoneIds: ['bone:hips'],
      boneCount: 3,
      bones: [
        { boneId: 'bone:hips', label: 'Hips', originalName: 'Hips', path: ['Hips'] },
        { boneId: 'bone:left-arm', label: 'Arm', originalName: 'Arm', path: ['Hips', 'Arm'] },
        { boneId: 'bone:right-arm', label: 'Arm', originalName: 'Arm', path: ['Hips', 'Arm'] },
      ],
    },
    keyframes: [
      {
        id: 'kimodo-bone-hips-f0',
        timeSeconds: 0,
        boneId: 'bone:hips',
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
      {
        id: 'kimodo-bone-left-arm-f15',
        timeSeconds: 0.5,
        boneId: 'bone:left-arm',
        rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
      },
    ],
  })
})

test('deriveKimodoPoseClipCompanionV1 keeps existing Pose/Clip v1 readability by exporting rotation-only keyframes and ignoring source-mutation metadata', () => {
  const artifact: KimodoMotionArtifact = {
    ...createKimodoArtifactForCompanion({
      clip_name: 'Kimodo Safe',
      pose_clip_companion: { bind_pose: { should_not: 'persist' }, weights: { should_not: 'persist' } },
    }),
    motionRetarget: {
      status: 'parsed',
      diagnostics: [],
      clipName: 'Kimodo Safe',
      sourceContract: { schema: 'modly.humanoid.v1', trusted: true },
      mappingStatus: 'trusted_manual',
      mappingConfidence: 'compatible',
      fps: 24,
      durationSeconds: 1,
      timeSemantics: 'seconds',
      sourceBones: [],
      targetTracks: [
        {
          targetNodeName: 'Hips',
          targetNodeIndex: 0,
          rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }],
        },
      ],
    },
  }
  const artifactBefore = structuredClone(artifact)

  const result = deriveKimodoPoseClipCompanionV1({
    summary: rigSummary,
    artifact,
    createdAt: '2026-05-21T18:30:00.000Z',
  })

  assert.equal(result.available, true)
  assert.deepEqual(result.sidecar?.keyframes, [
    {
      id: 'kimodo-bone-hips-f0',
      timeSeconds: 0,
      boneId: 'bone:hips',
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
  ])
  assert.equal(JSON.stringify(result.sidecar).includes('translation'), false)
  assert.equal(JSON.stringify(result.sidecar).includes('scale'), false)
  assert.equal(JSON.stringify(result.sidecar).includes('bind_pose'), false)
  assert.equal(JSON.stringify(result.sidecar).includes('weights'), false)
  assert.equal(JSON.stringify(result.sidecar).includes('materials'), false)
  assert.equal(JSON.stringify(result.sidecar).includes('source_transform'), false)
  assert.deepEqual(artifact, artifactBefore)
})

test('deriveKimodoPoseClipCompanionV1 fails closed with a clear warning when compatible RigBoneId quaternion data is missing or malformed', () => {
  const missingQuaternion = deriveKimodoPoseClipCompanionV1({
    summary: rigSummary,
    artifact: createKimodoArtifactForCompanion({}),
  })

  assert.equal(missingQuaternion.available, false)
  assert.equal(missingQuaternion.sidecar, undefined)
  assert.equal(missingQuaternion.sidecarWorkspacePath, undefined)
  assert.match(missingQuaternion.warnings.join('\n'), /translated quaternion payload/i)

  const unknownBone = deriveKimodoPoseClipCompanionV1({
    summary: rigSummary,
    artifact: {
      ...createKimodoArtifactForCompanion({ clip_name: 'Kimodo Invalid Bone' }),
      motionRetarget: {
        status: 'parsed',
        diagnostics: [],
        clipName: 'Kimodo Invalid Bone',
        sourceContract: { schema: 'modly.humanoid.v1', trusted: true },
        mappingStatus: 'trusted_manual',
        mappingConfidence: 'compatible',
        fps: 24,
        durationSeconds: 1,
        timeSemantics: 'seconds',
        sourceBones: [],
        targetTracks: [
          {
            targetNodeName: 'Arm',
            targetNodeIndex: 99,
            targetRole: 'right_arm',
            rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }],
          },
        ],
      },
    },
  })

  assert.equal(unknownBone.available, false)
  assert.match(unknownBone.warnings.join('\n'), /role mismatch/i)
})

test('deriveKimodoPoseClipCompanionV1 exports partial rotation-only tracks with explicit unresolved-track warnings', () => {
  const result = deriveKimodoPoseClipCompanionV1({
    summary: {
      ...rigSummary,
      bones: rigSummary.bones.map((bone, index) => ({
        ...bone,
        nodeIndex: 50 + index,
        role: bone.boneId === 'bone:hips' ? 'hips' : bone.boneId === 'bone:left-arm' ? 'left_arm' : 'right_arm',
      })),
    },
    artifact: {
      ...createKimodoArtifactForCompanion({ clip_name: 'Kimodo Partial Walk' }),
      motionRetarget: {
        status: 'parsed',
        diagnostics: [],
        clipName: 'Kimodo Partial Walk',
        sourceContract: { schema: 'modly.humanoid-promotion.v1', trusted: false, status: 'manual_confirmed', sidecarPayloadSha256: 'hash', sidecarWorkspacePath: 'Workflows/kimodo/run-1/manual.json' },
        mappingStatus: 'manual_confirmed',
        mappingConfidence: 'compatible',
        fps: 24,
        durationSeconds: 1,
        timeSemantics: 'seconds',
        sourceBones: [],
        targetTracks: [
          { targetNodeName: 'Hips', targetNodeIndex: 0, targetRole: 'hips', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
          { targetNodeName: 'missing_finger', targetNodeIndex: 999, targetRole: 'left_index_1', rotations: [{ timeSeconds: 0, x: 0, y: 0.1, z: 0, w: 0.99 }] },
        ],
      },
    },
    createdAt: '2026-05-24T10:00:00.000Z',
  })

  assert.equal(result.available, true)
  assert.deepEqual(result.sidecar?.keyframes.map((keyframe) => keyframe.boneId), ['bone:hips'])
  assert.match(result.warnings.join('\n'), /missing local target/i)
  assert.equal(JSON.stringify(result.sidecar).includes('translation'), false)
})

function companionTrack(overrides: Partial<KimodoMotionRetargetTargetTrack> = {}): KimodoMotionRetargetTargetTrack {
  return { targetNodeName: 'Hips', targetNodeIndex: 87, rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }], ...overrides }
}

function companionArtifact(targetTracks = [companionTrack()]): KimodoMotionArtifact {
  return {
    ...createKimodoArtifactForCompanion({}),
    motionRetarget: { status: 'parsed', diagnostics: [], clipName: 'Companion', fps: 24, durationSeconds: 1, sourceBones: [], targetTracks },
  }
}

test('companion explicit manual stable targets survive duplicate names and reversed skeleton order', () => {
  for (const bones of [rigSummary.bones, [...rigSummary.bones].reverse()]) {
    const summary = { ...rigSummary, bones }
    const artifact = companionArtifact([companionTrack({ targetNodeName: 'producer arm', targetRole: 'left_arm' })])
    const sourceBones = [{ sourceBoneId: 'source:arm', role: 'left_arm' }]
    const mappings = { 'source:arm': { targetBoneId: 'bone:right-arm' } }
    const before = structuredClone({ summary, artifact, sourceBones, mappings })
    const result = deriveKimodoPoseClipCompanionV1({ summary, artifact, sourceBones, mappings })
    assert.equal(result.available, true)
    assert.deepEqual(result.sidecar?.keyframes.map(key => key.boneId), ['bone:right-arm'])
    assert.deepEqual({ summary, artifact, sourceBones, mappings }, before)
  }
})

test('companion ignores inherited mappings while preserving own prototype-name source IDs', () => {
  for (const sourceBoneId of ['__proto__', 'constructor', 'toString']) {
    const sourceBones = [{ sourceBoneId, role: 'hips' }]
    const artifact = companionArtifact([companionTrack({ targetRole: 'hips' })])
    const inherited = Object.create({ [sourceBoneId]: { targetBoneId: 'bone:right-arm' } })
    const result = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact, sourceBones, mappings: inherited })
    assert.equal(result.available, true)
    assert.deepEqual(result.sidecar?.keyframes.map(key => key.boneId), ['bone:hips'])
    const own = { [sourceBoneId]: { targetBoneId: 'bone:right-arm' } }
    const mapped = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact, sourceBones, mappings: own })
    assert.equal(mapped.available, true)
    assert.deepEqual(mapped.sidecar?.keyframes.map(key => key.boneId), ['bone:right-arm'])
    assert.equal(Object.getPrototypeOf(own), Object.prototype)
  }
})

for (const entry of [{}, { targetBoneId: 'bone:missing' }]) {
  test(`companion explicit ${entry.targetBoneId ?? 'unset'} mapping cannot fall back to producer identity`, () => {
    const result = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact: companionArtifact([companionTrack({ targetRole: 'hips' })]), sourceBones: [{ sourceBoneId: 'source:hips', role: 'hips' }], mappings: { 'source:hips': entry } })
    assert.equal(result.available, false)
    assert.equal(result.sidecar, undefined)
    assert.match(result.warnings.join('\n'), /unset|missing|unknown/i)
  })
}

test('companion diagnoses ambiguous manual source roles instead of silently taking the first mapping', () => {
  const result = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact: companionArtifact([companionTrack({ targetRole: 'hips' })]), sourceBones: [{ sourceBoneId: 'source:a', role: 'hips' }, { sourceBoneId: 'source:b', role: 'hips' }], mappings: { 'source:a': { targetBoneId: 'bone:hips' }, 'source:b': { targetBoneId: 'bone:left-arm' } } })
  assert.equal(result.available, false)
  assert.match(result.warnings.join('\n'), /ambiguous|collid/i)
})

test('companion preserves close samples and slug-colliding stable Bone IDs without duplicate key IDs', () => {
  const summary: RigSkeletonSummary = { ...rigSummary, bones: [
    { ...rigSummary.bones[0], boneId: 'bone:A', originalName: 'First' },
    { ...rigSummary.bones[1], boneId: 'bone-a', originalName: 'Second' },
  ], rootBoneIds: ['bone:A'], stats: { skinnedMeshCount: 1, boneCount: 2 } }
  const rotations = [0, 0.001, 0.002].map(timeSeconds => ({ timeSeconds, x: 0, y: timeSeconds, z: 0, w: 1 }))
  const artifact = companionArtifact([companionTrack({ targetNodeName: 'First', rotations }), companionTrack({ targetNodeName: 'Second', rotations })])
  const result = deriveKimodoPoseClipCompanionV1({ summary, artifact, createdAt: '2026-10-07T00:00:00.000Z' })
  assert.equal(result.available, true)
  assert.equal(result.sidecar?.keyframes.length, 6)
  assert.equal(new Set(result.sidecar?.keyframes.map(key => key.id)).size, 6)
  for (const bone of summary.bones) assert.deepEqual(result.sidecar?.keyframes.filter(key => key.boneId === bone.boneId).map(key => key.timeSeconds), [0, 0.001, 0.002])
  assert.deepEqual(deriveKimodoPoseClipCompanionV1({ summary, artifact, createdAt: '2026-10-07T00:00:00.000Z' }), result)
  assert.equal(hydratePoseClipPlanFromSidecar(summary, result.sidecar, { sourceWorkspacePath: summary.sourceWorkspacePath!, skeletonContextId: summary.skeletonContextId }).valid, true)
})

test('companion routes same-basename sources separately without changing authored Pose paths', () => {
  const paths = ['Workflows/run-a/animated.glb', 'Workflows/run-b/animated.glb']
  const results = paths.map(sourceWorkspacePath => deriveKimodoPoseClipCompanionV1({ summary: { ...rigSummary, sourceWorkspacePath }, artifact: { ...companionArtifact(), sourceMeshWorkspacePath: sourceWorkspacePath } }))
  assert.ok(results.every(result => result.available))
  assert.notEqual(results[0].sidecarWorkspacePath, results[1].sidecarWorkspacePath)
  results.forEach((result, index) => {
    assert.notEqual(result.sidecarWorkspacePath, createPoseClipSidecarWorkspacePath(paths[index]))
    assert.notEqual(result.sidecarWorkspacePath, createLegacyPoseClipSidecarWorkspacePath(paths[index]))
  })
})

for (const where of ['artifact', 'contract'] as const) {
  test(`companion rejects explicit ${where} source contradictions`, () => {
    const artifact = companionArtifact()
    if (where === 'artifact') artifact.sourceMeshWorkspacePath = 'Workflows/other/hero.glb'
    else artifact.motionRetarget!.sourceContract = { schema: 'modly.humanoid.v1', trusted: true, sourceMeshWorkspacePath: 'Workflows/other/hero.glb' }
    const result = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact })
    assert.equal(result.available, false)
    assert.equal(result.sidecar, undefined)
    assert.match(result.warnings.join('\n'), /source.*(mismatch|disagree|contradict)/i)
  })
}

test('companion optional source evidence and useful one-track availability do not certify playback or solver trust', () => {
  for (const withSummarySource of [false, true]) for (const withArtifactSource of [false, true]) {
    if (!withSummarySource && !withArtifactSource) continue
    const summary = { ...rigSummary, sourceWorkspacePath: withSummarySource ? rigSummary.sourceWorkspacePath : undefined }
    const artifact = { ...companionArtifact(), sourceMeshWorkspacePath: withArtifactSource ? rigSummary.sourceWorkspacePath : undefined }
    artifact.motionRetarget!.sourceContract = { schema: 'custom-compatible-schema', trusted: false }
    artifact.motionRetarget!.mappingStatus = 'custom-review-state'
    artifact.diagnostics.solverStatus = 'not_evaluated'
    const before = structuredClone(artifact)
    const result = deriveKimodoPoseClipCompanionV1({ summary, artifact })
    assert.equal(result.available, true)
    assert.equal(result.sidecar?.keyframes.length, 1)
    assert.equal(result.sidecar?.source.workspacePath, rigSummary.sourceWorkspacePath)
    assert.deepEqual(artifact, before)
  }
})

test('companion empty translated output is unavailable with a diagnostic', () => {
  const result = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact: companionArtifact([]) })
  assert.equal(result.available, false)
  assert.equal(result.sidecar, undefined)
  assert.match(result.warnings.join('\n'), /empty|no .*track|no .*quaternion/i)
})

for (const [field, value] of [['clipName', '  '], ['durationSeconds', 0], ['durationSeconds', Infinity], ['fps', NaN], ['fps', -1]] as const) {
  test(`companion malformed ${field}=${value} returns unavailable instead of throwing`, () => {
    const artifact = companionArtifact()
    Object.assign(artifact.motionRetarget!, { [field]: value })
    const result = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact })
    assert.equal(result.available, false)
    assert.equal(result.sidecar, undefined)
    assert.match(result.warnings.join('\n'), /clip.*metadata/i)
  })
}

test('companion malformed track preserves useful partial motion and parsed diagnostics', () => {
  const artifact = companionArtifact([companionTrack(), companionTrack({ targetNodeName: 'Arm', targetNodeIndex: 1, rotations: [] })])
  artifact.motionRetarget!.diagnostics = ['Optional finger coverage is incomplete.']
  const result = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact })
  assert.equal(result.available, true)
  assert.deepEqual(result.sidecar?.keyframes.map(key => key.boneId), ['bone:hips'])
  assert.match(result.warnings.join('\n'), /partial|missing quaternion/i)
  assert.ok(result.warnings.includes('Optional finger coverage is incomplete.'))
})

test('manual companion helper retains explicit stable identity, producer evidence and detached samples', () => {
  const targetTracks = [companionTrack({ targetRole: 'left_arm' })]
  const sourceBones = [{ sourceBoneId: 'source:arm', role: 'left_upper_arm' }]
  const mapped = resolveKimodoTargetTracksForManualMappings({ summary: rigSummary, targetTracks, sourceBones, mappings: { 'source:arm': { targetBoneId: 'bone:right-arm' } } })
  assert.equal(mapped[0].targetBoneId, 'bone:right-arm')
  assert.equal(mapped[0].targetNodeIndex, 87, 'Local array ordinals must never replace producer evidence.')
  mapped[0].rotations[0].x = 9
  assert.equal(targetTracks[0].rotations[0].x, 0)
  const forged = { ...targetTracks[0], targetBoneId: 'bone:right-arm' }
  assert.equal(resolveKimodoTargetTracksForManualMappings({ summary: rigSummary, targetTracks: [forged] })[0].targetBoneId, undefined)
})

test('manual companion colliding targets are all omitted while an independent useful track survives', () => {
  const artifact = companionArtifact([
    companionTrack({ targetRole: 'hips' }),
    companionTrack({ targetRole: 'spine' }),
    companionTrack({ targetRole: 'left_arm' }),
  ])
  const sourceBones = [{ sourceBoneId: 'a', role: 'hips' }, { sourceBoneId: 'b', role: 'spine' }, { sourceBoneId: 'c', role: 'left_arm' }]
  const mappings = { a: { targetBoneId: 'bone:hips' }, b: { targetBoneId: 'bone:hips' }, c: { targetBoneId: 'bone:left-arm' } }
  const result = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact, sourceBones, mappings })
  assert.equal(result.available, true)
  assert.deepEqual(result.sidecar?.keyframes.map(key => key.boneId), ['bone:left-arm'])
  assert.match(result.warnings.join('\n'), /colliding tracks.*omitted/i)
})

test('explicit manual companion targets can have empty original names without label or ordinal fallback', () => {
  const summary = { ...rigSummary, bones: rigSummary.bones.map(bone => ({ ...bone, originalName: '', label: 'Presentation only' })) }
  const result = deriveKimodoPoseClipCompanionV1({ summary, artifact: companionArtifact([companionTrack({ targetRole: 'hips' })]), sourceBones: [{ sourceBoneId: 'a', role: 'hips' }], mappings: { a: { targetBoneId: 'bone:right-arm' } } })
  assert.equal(result.available, true)
  assert.deepEqual(result.sidecar?.keyframes.map(key => key.boneId), ['bone:right-arm'])
})

test('manual companion normalized source role collisions remain ambiguous and absent overrides preserve producer tracks', () => {
  const artifact = companionArtifact([companionTrack({ targetRole: 'left_upper_arm' })])
  const sourceBones = [{ sourceBoneId: 'a', role: 'left_arm' }, { sourceBoneId: 'b', role: 'left_upper_arm' }]
  const blocked = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact, sourceBones, mappings: { a: { targetBoneId: 'bone:right-arm' } } })
  assert.equal(blocked.available, false)
  assert.match(blocked.warnings.join('\n'), /ambiguous source/i)
  const absent = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact, sourceBones, mappings: {} })
  assert.equal(absent.available, true)
  assert.deepEqual(absent.sidecar?.keyframes.map(key => key.boneId), ['bone:hips'])
})

test('companion validates timing without clamping malformed tracks into otherwise useful motion', () => {
  for (const rotations of [
    [{ timeSeconds: 2, x: 0, y: 0, z: 0, w: 1 }],
    [{ timeSeconds: 0, x: 0, y: NaN, z: 0, w: 1 }],
    [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 0 }],
    [{ timeSeconds: 0.5, x: 0, y: 0, z: 0, w: 1 }, { timeSeconds: 0.2, x: 0, y: 0, z: 0, w: 1 }],
  ]) {
    const result = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact: companionArtifact([companionTrack({ rotations })]) })
    assert.equal(result.available, false)
    assert.ok(result.warnings.length > 0)
  }
})

test('companion source routing uses safe normalized full paths without requiring absent optional ownership', () => {
  for (const unsafe of ['', '/Workflows/hero.glb', '../hero.glb', 'Workflows/../hero.glb', 'Workflows/a%2f.glb', 'Workflows/a\0.glb']) {
    const result = deriveKimodoPoseClipCompanionV1({ summary: { ...rigSummary, sourceWorkspacePath: unsafe }, artifact: { ...companionArtifact(), sourceMeshWorkspacePath: undefined } })
    assert.equal(result.available, false, unsafe)
    assert.equal(result.sidecarWorkspacePath, undefined)
  }
  const result = deriveKimodoPoseClipCompanionV1({ summary: { ...rigSummary, sourceWorkspacePath: ' ./Workflows//generated/./hero character.glb ' }, artifact: companionArtifact() })
  const normal = deriveKimodoPoseClipCompanionV1({ summary: rigSummary, artifact: companionArtifact() })
  assert.equal(result.available, true)
  assert.equal(result.sidecarWorkspacePath, normal.sidecarWorkspacePath)
  assert.equal(result.sidecar?.source.workspacePath, rigSummary.sourceWorkspacePath)
})

test('real adapter companion binds all local Skeleton orders, scrubs actual Three bones and drives an actual mixer', () => {
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const metadata = JSON.parse(readFileSync(new URL('./fixtures/cross_repo_trusted_kimodo_metadata.json', import.meta.url), 'utf8'))
    const normalized = normalizeKimodoMotionArtifact({
      artifact: { id: 'companion-test', versionId: 'v1', kind: 'mesh', uri: 'Workflows/companion/run/animated.glb', provenance: { extensionId: 'kimodo-soma-rp', extensionNodeId: 'animate-rigged-mesh' } },
      bundleWorkspacePath: 'Workflows/companion/run', metadataWorkspacePath: 'Workflows/companion/run/metadata.json', metadata,
      sourceMeshWorkspacePath: rigSummary.sourceWorkspacePath,
    })
    if (!normalized.ok) throw new Error(normalized.errors.join('; '))
    assert.equal(normalized.ok, true)
    assert.equal(normalized.artifact.motionRetarget?.status, 'parsed')
    const beforeArtifact = structuredClone(normalized.artifact)
    const bones = ['hips', 'spine', 'left_upper_arm'].map(name => { const bone = new Bone(); bone.name = name; return bone })
    bones[0].add(bones[1]); bones[1].add(bones[2])
    const skeleton = new Skeleton(order.map(index => bones[index]))
    const binding = collectRigSkeletonBinding({ sourceWorkspacePath: rigSummary.sourceWorkspacePath, skinnedMeshes: [{ name: 'CompanionRig', skeleton }] })
    const result = deriveKimodoPoseClipCompanionV1({ summary: binding.summary, artifact: normalized.artifact })
    assert.equal(result.available, true)
    assert.equal(result.sidecar?.keyframes.length, 6)
    const hydrated = hydratePoseClipPlanFromSidecar(binding.summary, JSON.parse(JSON.stringify(result.sidecar)), { sourceWorkspacePath: rigSummary.sourceWorkspacePath!, skeletonContextId: binding.summary.skeletonContextId })
    assert.equal(hydrated.valid, true)
    const source = { scene: bones[0], sourceWorkspacePath: rigSummary.sourceWorkspacePath!, skeletonContextId: binding.summary.skeletonContextId }
    const session = createPoseClipPreviewSession(source, binding.bonesById)
    assert.equal(evaluatePoseClipPreviewSession(session, source, hydrated.plan, 0.0333333).appliedBoneIds.length, 3)
    assert.ok(Math.abs(bones[0].quaternion.y - 0.1305262) < 1e-6)
    assert.ok(Math.abs(bones[2].quaternion.x - 0.1305262) < 1e-6)
    restorePoseClipPreviewSession(session)
    assert.deepEqual(bones.map(bone => bone.quaternion.toArray()), [[0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1]])
    const replacement = { ...source, scene: new Bone() }
    assert.equal(evaluatePoseClipPreviewSession(session, replacement, hydrated.plan, 0.0333333).appliedBoneIds.length, 0)
    const tracks = [...binding.bonesById].map(([boneId, bone]) => {
      const keys = hydrated.plan.keyframes.filter(key => key.boneId === boneId)
      return new QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, keys.map(key => key.timeSeconds), keys.flatMap(key => [key.rotation.x, key.rotation.y, key.rotation.z, key.rotation.w]))
    })
    const mixer = new AnimationMixer(bones[0])
    mixer.clipAction(new AnimationClip('Companion', hydrated.plan.clip.durationSeconds, tracks)).setLoop(LoopOnce, 1).play()
    mixer.setTime(0.0333333)
    assert.ok(Math.abs(bones[0].quaternion.y - 0.1305262) < 1e-6)
    assert.ok(Math.abs(bones[2].quaternion.x - 0.1305262) < 1e-6)
    mixer.stopAllAction(); mixer.uncacheRoot(bones[0]); skeleton.dispose()
    assert.deepEqual(normalized.artifact, beforeArtifact)
  }
})

test('real adapter explicit manual mapping addresses the selected duplicate Bone object, not producer or local index', () => {
  const metadata = JSON.parse(readFileSync(new URL('./fixtures/cross_repo_trusted_kimodo_metadata.json', import.meta.url), 'utf8'))
  metadata.kimodo_motion_retarget.source_bones[2].role = 'left_arm'
  const normalized = normalizeKimodoMotionArtifact({ artifact: { id: 'manual', versionId: 'v1', kind: 'mesh', uri: 'Workflows/companion/run/animated.glb', provenance: { extensionId: 'kimodo-soma-rp', extensionNodeId: 'animate-rigged-mesh' } }, bundleWorkspacePath: 'Workflows/companion/run', metadataWorkspacePath: 'Workflows/companion/run/metadata.json', metadata })
  if (!normalized.ok) throw new Error(normalized.errors.join('; '))
  assert.equal(normalized.ok, true)
  const hips = new Bone(); hips.name = 'hips'
  const first = new Bone(); first.name = 'Arm'
  const selected = new Bone(); selected.name = 'Arm'
  hips.add(first, selected)
  const skeleton = new Skeleton([selected, hips, first])
  const binding = collectRigSkeletonBinding({ sourceWorkspacePath: rigSummary.sourceWorkspacePath, skinnedMeshes: [{ name: 'ManualRig', skeleton }] })
  const targetBoneId = [...binding.bonesById].find(([, bone]) => bone === selected)![0]
  const artifactBefore = structuredClone(normalized.artifact)
  const result = deriveKimodoPoseClipCompanionV1({ summary: binding.summary, artifact: normalized.artifact, sourceBones: normalized.artifact.motionRetarget!.sourceBones, mappings: { LeftUpperArm: { targetBoneId } } })
  assert.equal(result.available, true)
  assert.match(result.warnings.join('\n'), /missing local target/i)
  const hydrated = hydratePoseClipPlanFromSidecar(binding.summary, result.sidecar, { sourceWorkspacePath: rigSummary.sourceWorkspacePath!, skeletonContextId: binding.summary.skeletonContextId })
  assert.equal(hydrated.valid, true)
  const source = { scene: hips, sourceWorkspacePath: rigSummary.sourceWorkspacePath!, skeletonContextId: binding.summary.skeletonContextId }
  const session = createPoseClipPreviewSession(source, binding.bonesById)
  evaluatePoseClipPreviewSession(session, source, hydrated.plan, 0.0333333)
  assert.ok(Math.abs(selected.quaternion.x - 0.1305262) < 1e-6)
  assert.deepEqual(first.quaternion.toArray(), [0, 0, 0, 1])
  restorePoseClipPreviewSession(session); skeleton.dispose()
  assert.deepEqual(normalized.artifact, artifactBefore)
})
