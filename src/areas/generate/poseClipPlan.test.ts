import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPoseClipSidecarV1,
  clampPoseClipTime,
  createPoseClipCaptureKeyframeId,
  createLegacyPoseClipSidecarWorkspacePath,
  createPoseClipDuplicateKeyframeId,
  createPoseClipPlan,
  createPoseClipSidecarWorkspacePath,
  hydratePoseClipPlanFromSidecar,
  reducePoseClipPlan,
  validatePoseClipSidecarWorkspacePath,
  type PoseClipPlan,
  type PoseClipPlanAction,
  type PoseClipSidecarV1,
} from './poseClipPlan.ts'
import type { RigSkeletonSummary } from './rigSkeleton.ts'

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
