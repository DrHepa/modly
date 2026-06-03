import assert from 'node:assert/strict'
import test from 'node:test'
import { Bone } from 'three'

import { buildRigSelectionOverlay, collectRigSkeletonSummary } from './rigSkeleton.ts'
import { CANONICAL_SEMANTIC_ROLE_IDS, normalizeSemanticRoleId } from './semanticRoles.ts'

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

test('semantic role contract uses canonical ids and aliases only at ingestion boundaries', () => {
  assert.ok(CANONICAL_SEMANTIC_ROLE_IDS.includes('left_lower_arm'))
  assert.ok(CANONICAL_SEMANTIC_ROLE_IDS.includes('right_lower_leg'))
  assert.equal(normalizeSemanticRoleId('left_forearm'), 'left_lower_arm')
  assert.equal(normalizeSemanticRoleId('right_shin'), 'right_lower_leg')
  assert.equal(normalizeSemanticRoleId('left_arm'), 'left_upper_arm')
  assert.equal(normalizeSemanticRoleId('bone_4'), undefined)
})
