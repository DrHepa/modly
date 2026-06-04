import assert from 'node:assert/strict'
import test from 'node:test'
import { Bone } from 'three'

import { buildRigSelectionOverlay, collectRigSkeletonSummary, translateKimodoTargetTracks } from './rigSkeleton.ts'
import { CANONICAL_SEMANTIC_ROLE_IDS, normalizeSemanticRoleId } from './semanticRoles.ts'
import type { RigSkeletonSummary } from './rigSkeleton.ts'

function namedBone(name: string): Bone {
  const bone = new Bone()
  bone.name = name
  return bone
}

test('collectRigSkeletonSummary builds hierarchy, contextual stable IDs, stats, and warnings from skeleton bones', () => {
  const hips = namedBone('Hips')
  const leftLeg = namedBone('Leg')
  const rightLeg = namedBone('Leg')
  const unnamedHand = namedBone('   ')
  hips.add(leftLeg, rightLeg)
  rightLeg.add(unnamedHand)

  const originalNames = [hips.name, leftLeg.name, rightLeg.name, unnamedHand.name]
  const summary = collectRigSkeletonSummary({
    sourceWorkspacePath: 'Workflows/checkpoints/rigged-character.glb',
    skinnedMeshes: [
      {
        name: 'Character Body',
        path: ['Scene', 'Armature', 'Character Body'],
        skeletonIndex: 0,
        skeleton: { bones: [hips, leftLeg, rightLeg, unnamedHand] },
      },
    ],
  })

  assert.equal(summary.hasRig, true)
  assert.equal(summary.sourceWorkspacePath, 'Workflows/checkpoints/rigged-character.glb')
  assert.equal(summary.skeletonContextId, 'rig:Scene_Armature_Character_Body|skeleton:0')
  assert.deepEqual(summary.skinnedMeshContexts, ['rig:Scene_Armature_Character_Body|skeleton:0'])
  assert.deepEqual(summary.stats, { skinnedMeshCount: 1, boneCount: 4 })
  assert.deepEqual(summary.rootBoneIds, ['rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0'])
  assert.deepEqual(
    summary.bones.map((bone) => ({
      boneId: bone.boneId,
      label: bone.label,
      originalName: bone.originalName,
      path: bone.path,
      siblingIndex: bone.siblingIndex,
      parentId: bone.parentId,
      childIds: bone.childIds,
      warnings: bone.warnings,
    })),
    [
      {
        boneId: 'rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0',
        label: 'Hips',
        originalName: 'Hips',
        path: ['Hips'],
        siblingIndex: 0,
        parentId: undefined,
        childIds: [
          'rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0/Leg#0',
          'rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0/Leg#1',
        ],
        warnings: [],
      },
      {
        boneId: 'rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0/Leg#0',
        label: 'Leg',
        originalName: 'Leg',
        path: ['Hips', 'Leg'],
        siblingIndex: 0,
        parentId: 'rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0',
        childIds: [],
        warnings: ['duplicate-name'],
      },
      {
        boneId: 'rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0/Leg#1',
        label: 'Leg',
        originalName: 'Leg',
        path: ['Hips', 'Leg'],
        siblingIndex: 1,
        parentId: 'rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0',
        childIds: ['rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0/Leg#1/Bone_4#0'],
        warnings: ['duplicate-name'],
      },
      {
        boneId: 'rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0/Leg#1/Bone_4#0',
        label: 'Bone 4',
        originalName: '   ',
        path: ['Hips', 'Leg', 'Bone 4'],
        siblingIndex: 0,
        parentId: 'rig:Scene_Armature_Character_Body|skeleton:0|bone:Hips#0/Leg#1',
        childIds: [],
        warnings: ['empty-name'],
      },
    ],
  )
  assert.deepEqual(summary.warnings, [
    'Duplicate bone name "Leg" appears 2 times in rig:Scene_Armature_Character_Body|skeleton:0.',
    'Bone at index 3 has an empty name; using fallback label "Bone 4".',
  ])
  assert.deepEqual([hips.name, leftLeg.name, rightLeg.name, unnamedHand.name], originalNames)
})

test('collectRigSkeletonSummary returns no-rig summary for empty skeleton input', () => {
  const summary = collectRigSkeletonSummary({
    skinnedMeshes: [{ name: 'Static Body', skeletonIndex: 0, skeleton: { bones: [] } }],
  })

  assert.deepEqual(summary, {
    hasRig: false,
    sourceWorkspacePath: undefined,
    skeletonContextId: 'rig:Static_Body|skeleton:0',
    skinnedMeshContexts: ['rig:Static_Body|skeleton:0'],
    bones: [],
    rootBoneIds: [],
    stats: { skinnedMeshCount: 1, boneCount: 0 },
    warnings: ['No skeleton bones were found.'],
  })
})

test('buildRigSelectionOverlay exposes selected bone, parent connection, and children connections only', () => {
  const root = namedBone('Root')
  const spine = namedBone('Spine')
  const head = namedBone('Head')
  const arm = namedBone('Arm')
  const finger = namedBone('Finger')
  root.add(spine)
  spine.add(head, arm)
  arm.add(finger)

  const summary = collectRigSkeletonSummary({
    skinnedMeshes: [
      {
        name: 'Hero Mesh',
        path: ['Hero Mesh'],
        skeletonIndex: 2,
        skeleton: { bones: [root, spine, head, arm, finger] },
      },
    ],
  })
  const selectedBoneId = 'rig:Hero_Mesh|skeleton:2|bone:Root#0/Spine#0'

  const overlay = buildRigSelectionOverlay(summary, selectedBoneId)

  assert.deepEqual(overlay, {
    selectedBoneId,
    selectedLabel: 'Spine',
    parentBoneId: 'rig:Hero_Mesh|skeleton:2|bone:Root#0',
    childBoneIds: [
      'rig:Hero_Mesh|skeleton:2|bone:Root#0/Spine#0/Head#0',
      'rig:Hero_Mesh|skeleton:2|bone:Root#0/Spine#0/Arm#0',
    ],
    highlightedBoneIds: [
      selectedBoneId,
      'rig:Hero_Mesh|skeleton:2|bone:Root#0',
      'rig:Hero_Mesh|skeleton:2|bone:Root#0/Spine#0/Head#0',
      'rig:Hero_Mesh|skeleton:2|bone:Root#0/Spine#0/Arm#0',
    ],
    connections: [
      { fromBoneId: 'rig:Hero_Mesh|skeleton:2|bone:Root#0', toBoneId: selectedBoneId, relation: 'parent' },
      { fromBoneId: selectedBoneId, toBoneId: 'rig:Hero_Mesh|skeleton:2|bone:Root#0/Spine#0/Head#0', relation: 'child' },
      { fromBoneId: selectedBoneId, toBoneId: 'rig:Hero_Mesh|skeleton:2|bone:Root#0/Spine#0/Arm#0', relation: 'child' },
    ],
  })
})

test('buildRigSelectionOverlay returns null for unknown selected bone IDs', () => {
  const root = namedBone('Root')
  const summary = collectRigSkeletonSummary({
    skinnedMeshes: [{ name: 'Hero Mesh', skeletonIndex: 0, skeleton: { bones: [root] } }],
  })

  assert.equal(buildRigSelectionOverlay(summary, 'missing-bone'), null)
})

test('translateKimodoTargetTracks resolves exact node index + name matches and honors optional target roles', () => {
  const summary = {
    hasRig: true,
    skeletonContextId: 'rig:Hero|skeleton:0',
    skinnedMeshContexts: ['rig:Hero|skeleton:0'],
    rootBoneIds: ['bone:hips'],
    stats: { skinnedMeshCount: 1, boneCount: 3 },
    warnings: [],
    bones: [
      { boneId: 'bone:hips', label: 'Hips', originalName: 'Hips', path: ['Hips'], siblingIndex: 0, childIds: ['bone:left-arm', 'bone:right-arm'], warnings: [], nodeIndex: 0 },
      { boneId: 'bone:left-arm', label: 'Arm', originalName: 'Arm', path: ['Hips', 'Arm'], siblingIndex: 0, parentId: 'bone:hips', childIds: [], warnings: ['duplicate-name'], nodeIndex: 1, role: 'left_arm' },
      { boneId: 'bone:right-arm', label: 'Arm', originalName: 'Arm', path: ['Hips', 'Arm'], siblingIndex: 1, parentId: 'bone:hips', childIds: [], warnings: ['duplicate-name'], nodeIndex: 2, role: 'right_arm' },
    ],
  } satisfies RigSkeletonSummary

  const translated = translateKimodoTargetTracks(summary, [
    {
      targetNodeName: 'Hips',
      targetNodeIndex: 0,
      rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }],
    },
    {
      targetNodeName: 'Arm',
      targetNodeIndex: 1,
      targetRole: 'left_upper_arm',
      rotations: [{ timeSeconds: 0.5, x: 0, y: 0.3826834, z: 0, w: 0.9238795 }],
    },
  ])

  assert.equal(translated.ok, true)
  assert.deepEqual(translated.tracks, [
    {
      boneId: 'bone:hips',
      targetNodeName: 'Hips',
      targetNodeIndex: 0,
      rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }],
    },
    {
      boneId: 'bone:left-arm',
      targetNodeName: 'Arm',
      targetNodeIndex: 1,
      targetRole: 'left_upper_arm',
      rotations: [{ timeSeconds: 0.5, x: 0, y: 0.3826834, z: 0, w: 0.9238795 }],
    },
  ])
})

test('translateKimodoTargetTracks fails closed for missing targets, ambiguous duplicates, and role mismatches', () => {
  const ambiguousSummary = {
    hasRig: true,
    skeletonContextId: 'rig:Ambiguous|skeleton:0',
    skinnedMeshContexts: ['rig:Ambiguous|skeleton:0'],
    rootBoneIds: ['bone:root'],
    stats: { skinnedMeshCount: 1, boneCount: 3 },
    warnings: [],
    bones: [
      { boneId: 'bone:root', label: 'Root', originalName: 'Root', path: ['Root'], siblingIndex: 0, childIds: ['bone:arm-a', 'bone:arm-b'], warnings: [], nodeIndex: 0 },
      { boneId: 'bone:arm-a', label: 'Arm', originalName: 'Arm', path: ['Root', 'Arm'], siblingIndex: 0, parentId: 'bone:root', childIds: [], warnings: ['duplicate-name'], nodeIndex: 1, role: 'left_arm' },
      { boneId: 'bone:arm-b', label: 'Arm', originalName: 'Arm', path: ['Root', 'Arm'], siblingIndex: 1, parentId: 'bone:root', childIds: [], warnings: ['duplicate-name'], nodeIndex: 1, role: 'left_arm' },
    ],
  } satisfies RigSkeletonSummary

  const missing = translateKimodoTargetTracks(ambiguousSummary, [
    { targetNodeName: 'Leg', targetNodeIndex: 99, rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
  ])
  assert.equal(missing.ok, false)
  assert.match(missing.diagnostics.join('\n'), /missing local target/i)

  const ambiguous = translateKimodoTargetTracks(ambiguousSummary, [
    { targetNodeName: 'Arm', targetNodeIndex: 1, rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
  ])
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.diagnostics.join('\n'), /ambiguous local target/i)

  const roleMismatch = translateKimodoTargetTracks(ambiguousSummary, [
    { targetNodeName: 'Arm', targetNodeIndex: 99, targetRole: 'right_arm', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
  ])
  assert.equal(roleMismatch.ok, false)
  assert.match(roleMismatch.diagnostics.join('\n'), /role mismatch/i)
})

test('translateKimodoTargetTracks falls back to stable role and original name when exported node indices diverge', () => {
  const summary = {
    hasRig: true,
    skeletonContextId: 'rig:LocalViewer|skeleton:0',
    skinnedMeshContexts: ['rig:LocalViewer|skeleton:0'],
    rootBoneIds: ['bone:hips'],
    stats: { skinnedMeshCount: 1, boneCount: 3 },
    warnings: [],
    bones: [
      { boneId: 'bone:hips', label: 'Hips', originalName: 'Hips', path: ['Hips'], siblingIndex: 0, childIds: ['bone:left-leg'], warnings: [], nodeIndex: 42, role: 'hips' },
      { boneId: 'bone:left-leg', label: 'Left Upper Leg', originalName: 'bone_5', path: ['Hips', 'Left Upper Leg'], siblingIndex: 0, parentId: 'bone:hips', childIds: ['bone:right-leg'], warnings: [], nodeIndex: 77, role: 'left_upper_leg' },
      { boneId: 'bone:right-leg', label: 'Right Upper Leg', originalName: 'bone_6', path: ['Hips', 'Right Upper Leg'], siblingIndex: 1, parentId: 'bone:hips', childIds: [], warnings: [], nodeIndex: 78, role: 'right_upper_leg' },
    ],
  } satisfies RigSkeletonSummary

  const translated = translateKimodoTargetTracks(summary, [
    {
      targetNodeName: 'bone_5',
      targetNodeIndex: 0,
      targetRole: 'left_upper_leg',
      rotations: [{ timeSeconds: 0.25, x: 0.1, y: 0.2, z: 0.3, w: 0.9 }],
    },
    {
      targetNodeName: 'bone_6',
      targetNodeIndex: 1,
      targetRole: 'right_upper_leg',
      rotations: [{ timeSeconds: 0.25, x: -0.1, y: -0.2, z: -0.3, w: 0.9 }],
    },
  ])

  assert.equal(translated.ok, true)
  assert.deepEqual(translated.tracks.map((track) => track.boneId), ['bone:left-leg', 'bone:right-leg'])
})

test('semantic role contract uses canonical ids and aliases only at ingestion boundaries', () => {
  assert.ok(CANONICAL_SEMANTIC_ROLE_IDS.includes('left_lower_arm'))
  assert.ok(CANONICAL_SEMANTIC_ROLE_IDS.includes('right_lower_leg'))
  assert.equal(normalizeSemanticRoleId('left_forearm'), 'left_lower_arm')
  assert.equal(normalizeSemanticRoleId('right_shin'), 'right_lower_leg')
  assert.equal(normalizeSemanticRoleId('left_arm'), 'left_upper_arm')
  assert.equal(normalizeSemanticRoleId('bone_4'), undefined)
})

test('translateKimodoTargetTracks resolves UniRig bone_* targets by canonical semantic role without mutating names or indices', () => {
  const summary = {
    hasRig: true,
    skeletonContextId: 'rig:UniRig|skeleton:0',
    skinnedMeshContexts: ['rig:UniRig|skeleton:0'],
    rootBoneIds: ['bone:5'],
    stats: { skinnedMeshCount: 1, boneCount: 3 },
    warnings: [],
    bones: [
      { boneId: 'bone:5', label: 'bone_5', originalName: 'bone_5', path: ['bone_5'], siblingIndex: 0, childIds: ['bone:4'], warnings: [], nodeIndex: 5, role: 'hips' },
      { boneId: 'bone:4', label: 'bone_4', originalName: 'bone_4', path: ['bone_5', 'bone_4'], siblingIndex: 0, parentId: 'bone:5', childIds: ['bone:3'], warnings: [], nodeIndex: 4, role: 'spine' },
      { boneId: 'bone:3', label: 'bone_3', originalName: 'bone_3', path: ['bone_5', 'bone_4', 'bone_3'], siblingIndex: 0, parentId: 'bone:4', childIds: [], warnings: [], nodeIndex: 3, role: 'left_lower_arm' },
    ],
  } satisfies RigSkeletonSummary
  const originalNames = summary.bones.map((bone) => bone.originalName)
  const originalIndices = summary.bones.map((bone) => bone.nodeIndex)

  const translated = translateKimodoTargetTracks(summary, [
    { targetNodeName: 'LeftForeArm', targetNodeIndex: 41, targetRole: 'left_forearm', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
  ])

  assert.equal(translated.ok, true)
  assert.deepEqual(translated.tracks, [
    { boneId: 'bone:3', targetNodeName: 'LeftForeArm', targetNodeIndex: 41, targetRole: 'left_lower_arm', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
  ])
  assert.deepEqual(summary.bones.map((bone) => bone.originalName), originalNames)
  assert.deepEqual(summary.bones.map((bone) => bone.nodeIndex), originalIndices)
})

test('translateKimodoTargetTracks accepts exact identity matches when local role metadata is absent or stale', () => {
  const summary = {
    hasRig: true,
    skeletonContextId: 'rig:ExactIdentity|skeleton:0',
    skinnedMeshContexts: ['rig:ExactIdentity|skeleton:0'],
    rootBoneIds: ['bone:hips'],
    stats: { skinnedMeshCount: 1, boneCount: 2 },
    warnings: [],
    bones: [
      { boneId: 'bone:hips', label: 'Bone 5', originalName: 'bone_5', path: ['Bone 5'], siblingIndex: 0, childIds: ['bone:spine'], warnings: [], nodeIndex: 0 },
      { boneId: 'bone:spine', label: 'Bone 4', originalName: 'bone_4', path: ['Bone 5', 'Bone 4'], siblingIndex: 0, parentId: 'bone:hips', childIds: [], warnings: [], nodeIndex: 1, role: 'neck' },
    ],
  } satisfies RigSkeletonSummary

  const translated = translateKimodoTargetTracks(summary, [
    { targetNodeName: 'bone_5', targetNodeIndex: 0, targetRole: 'hips', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
    { targetNodeName: 'bone_4', targetNodeIndex: 1, targetRole: 'spine', rotations: [{ timeSeconds: 0, x: 0, y: 0.2, z: 0, w: 0.98 }] },
  ])

  assert.equal(translated.ok, true)
  assert.deepEqual(translated.tracks.map((track) => track.boneId), ['bone:hips', 'bone:spine'])
  assert.match(translated.diagnostics.join('\n'), /role metadata is missing/i)
  assert.match(translated.diagnostics.join('\n'), /role metadata "neck" differs from Kimodo role "spine"/i)
  assert.doesNotMatch(translated.diagnostics.join('\n'), /failed role mismatch/i)
})

test('translateKimodoTargetTracks accepts unique originalName matches when exported node indices diverge and role metadata is stale', () => {
  const summary = {
    hasRig: true,
    skeletonContextId: 'rig:UniqueOriginalName|skeleton:0',
    skinnedMeshContexts: ['rig:UniqueOriginalName|skeleton:0'],
    rootBoneIds: ['bone:hips'],
    stats: { skinnedMeshCount: 1, boneCount: 3 },
    warnings: [],
    bones: [
      { boneId: 'bone:hips', label: 'Bone 5', originalName: 'bone_5', path: ['Bone 5'], siblingIndex: 0, childIds: ['bone:spine'], warnings: [], nodeIndex: 42 },
      { boneId: 'bone:spine', label: 'Bone 4', originalName: 'bone_4', path: ['Bone 5', 'Bone 4'], siblingIndex: 0, parentId: 'bone:hips', childIds: ['bone:foot'], warnings: [], nodeIndex: 43, role: 'neck' },
      { boneId: 'bone:foot', label: 'Bone 9', originalName: 'bone_9', path: ['Bone 5', 'Bone 4', 'Bone 9'], siblingIndex: 0, parentId: 'bone:spine', childIds: [], warnings: [], nodeIndex: 44, role: 'left_hand' },
    ],
  } satisfies RigSkeletonSummary

  const translated = translateKimodoTargetTracks(summary, [
    { targetNodeName: 'bone_5', targetNodeIndex: 0, targetRole: 'hips', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
    { targetNodeName: 'bone_4', targetNodeIndex: 1, targetRole: 'spine', rotations: [{ timeSeconds: 0, x: 0, y: 0.2, z: 0, w: 0.98 }] },
    { targetNodeName: 'bone_9', targetNodeIndex: 2, targetRole: 'right_foot', rotations: [{ timeSeconds: 0, x: 0.1, y: 0, z: 0, w: 0.99 }] },
  ])

  assert.equal(translated.ok, true)
  assert.deepEqual(translated.tracks.map((track) => track.boneId), ['bone:hips', 'bone:spine', 'bone:foot'])
  assert.match(translated.diagnostics.join('\n'), /role metadata is missing/i)
  assert.match(translated.diagnostics.join('\n'), /role metadata "neck" differs from Kimodo role "spine"/i)
  assert.match(translated.diagnostics.join('\n'), /role metadata "left_hand" differs from Kimodo role "right_foot"/i)
  assert.doesNotMatch(translated.diagnostics.join('\n'), /failed role mismatch/i)
})

test('translateKimodoTargetTracks returns partial safe translations with diagnostics instead of hard failing every valid track', () => {
  const summary = {
    hasRig: true,
    skeletonContextId: 'rig:Partial|skeleton:0',
    skinnedMeshContexts: ['rig:Partial|skeleton:0'],
    rootBoneIds: ['bone:hips'],
    stats: { skinnedMeshCount: 1, boneCount: 2 },
    warnings: [],
    bones: [
      { boneId: 'bone:hips', label: 'Hips', originalName: 'Hips', path: ['Hips'], siblingIndex: 0, childIds: ['bone:spine'], warnings: [], nodeIndex: 0, role: 'hips' },
      { boneId: 'bone:spine', label: 'Spine', originalName: 'Spine', path: ['Hips', 'Spine'], siblingIndex: 0, parentId: 'bone:hips', childIds: [], warnings: [], nodeIndex: 1, role: 'spine' },
    ],
  } satisfies RigSkeletonSummary

  const translated = translateKimodoTargetTracks(summary, [
    { targetNodeName: 'Hips', targetNodeIndex: 0, targetRole: 'hips', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
    { targetNodeName: 'missing_finger', targetNodeIndex: 99, targetRole: 'left_index_1', rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] },
  ])

  assert.equal(translated.ok, true)
  assert.deepEqual(translated.tracks.map((track) => track.boneId), ['bone:hips'])
  assert.match(translated.diagnostics.join('\n'), /missing local target/i)
})
