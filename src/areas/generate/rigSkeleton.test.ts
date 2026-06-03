import assert from 'node:assert/strict'
import test from 'node:test'
import { Bone } from 'three'

import { buildRigSelectionOverlay, collectRigSkeletonBinding, collectRigSkeletonSummary, type RigBoneNode } from './rigSkeleton.ts'
import { CANONICAL_SEMANTIC_ROLE_IDS, normalizeSemanticRoleId, type SemanticRoleId } from './semanticRoles.ts'

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

test('summary IDs disambiguate normalized sibling names and repeated parentless roots', () => {
  const root = namedBone('Root')
  const children = ['a b', 'a_b', 'a/b'].map(namedBone)
  root.add(...children)
  const secondRoot = namedBone('Root')
  const summary = collectRigSkeletonSummary({ skinnedMeshes: [{ name: 'Body', skeleton: { bones: [...children, secondRoot, root] } }] })
  assert.equal(new Set(summary.bones.map((bone) => bone.boneId)).size, 5)
  for (const node of summary.bones) {
    if (node.parentId) assert.ok(node.boneId.startsWith(`${node.parentId}/`))
  }
  assert.deepEqual(children.map((bone) => bone.name), ['a b', 'a_b', 'a/b'])
})

test('binding and summary share traversal, not skeleton-array order, with shared skeletons and duplicate mesh contexts', async () => {
  const { collectRigSkeletonBinding } = await import('./rigSkeleton.ts')
  const root = namedBone('Root'); const child = namedBone('Child'); root.add(child)
  const skeleton = { bones: [child, root] }
  const other = namedBone('Root')
  const input = { sourceWorkspacePath: 'A/hero.glb', skinnedMeshes: [
    { name: 'a b', skeleton }, { name: 'Clothing', skeleton },
    { name: 'a_b', skeleton: { bones: [other] } },
  ] }
  const binding = collectRigSkeletonBinding(input)
  assert.deepEqual(binding.summary, collectRigSkeletonSummary(input))
  assert.equal(binding.summary.stats.boneCount, 3)
  assert.equal(binding.summary.stats.skinnedMeshCount, 3)
  assert.equal(binding.bonesById.size, 3)
  assert.equal(new Set(binding.bonesById.values()).size, 3)
  const rootId = binding.summary.rootBoneIds[0]
  assert.equal(binding.bonesById.get(rootId), root)
  assert.equal(binding.bonesById.get(binding.summary.bones.find((node) => node.parentId === rootId)!.boneId), child)
  const reordered = collectRigSkeletonBinding({ ...input, skinnedMeshes: [{ name: 'a b', skeleton: { bones: [root, child] } }, ...input.skinnedMeshes.slice(1)] })
  assert.deepEqual([...reordered.bonesById], [...binding.bonesById])
})

test('repeated roots under different non-bone parents cannot collide', async () => {
  const { Group } = await import('three')
  const { collectRigSkeletonBinding } = await import('./rigSkeleton.ts')
  const firstParent = new Group(); const secondParent = new Group()
  const first = namedBone('Root'); const second = namedBone('Root')
  firstParent.add(first); secondParent.add(second)
  const binding = collectRigSkeletonBinding({ skinnedMeshes: [{ name: 'Body', skeleton: { bones: [first, second] } }] })
  assert.equal(binding.bonesById.size, 2)
  assert.equal(new Set(binding.summary.rootBoneIds).size, 2)
})

test('unnamed bone IDs and non-bone-parent root ordering survive skeleton-array reordering', async () => {
  const { Group, AnimationMixer, AnimationClip, QuaternionKeyframeTrack } = await import('three')
  const { collectRigSkeletonBinding } = await import('./rigSkeleton.ts')
  const scene = new Group(); const firstGroup = new Group(); const secondGroup = new Group(); scene.add(firstGroup, secondGroup)
  const first = namedBone('Root'); const second = namedBone('Root'); const unnamed = namedBone(''); const child = namedBone('Tracked')
  firstGroup.add(first); secondGroup.add(second); first.add(unnamed, child)
  const bind = (bones: Bone[]) => collectRigSkeletonBinding({ skinnedMeshes: [{ name: 'Body', skeleton: { bones } }] })
  const original = bind([first, unnamed, child, second]); const shuffled = bind([child, second, unnamed, first])
  // Source-array indices can change; all stable summary identity must remain unchanged.
  const withoutSourceIndices = (summary: typeof original.summary) => ({
    ...summary,
    bones: summary.bones.map(({ nodeIndex: _nodeIndex, ...node }) => node),
  })
  assert.deepEqual(withoutSourceIndices(shuffled.summary), withoutSourceIndices(original.summary))
  assert.deepEqual(original.summary.bones.map(node => node.nodeIndex), [0, 1, 2, 3])
  assert.deepEqual(shuffled.summary.bones.map(node => node.nodeIndex), [3, 2, 0, 1])
  assert.deepEqual([...shuffled.bonesById], [...original.bonesById])
  const mixer = new AnimationMixer(scene)
  const track = new QuaternionKeyframeTrack('Tracked.quaternion', [0, 1], [0, 0, 0, 1, 0, 1, 0, 0])
  mixer.clipAction(new AnimationClip('Original', 1, [track])).play(); mixer.setTime(0.5)
  assert.ok(child.quaternion.y > 0.5)
  assert.equal(child.name, 'Tracked'); assert.equal(track.name, 'Tracked.quaternion')
  assert.equal(unnamed.name, '')
  mixer.stopAllAction(); mixer.uncacheRoot(scene)
})


test('bone metadata retains source-array indices with shared bones and independent contexts', () => {
  const root = namedBone('Root'); const unnamed = namedBone(''); const named = namedBone(' Named ')
  root.add(unnamed, named)
  const otherRoot = namedBone('Root'); const otherChild = namedBone('Child'); otherRoot.add(otherChild)
  const input = { skinnedMeshes: [
    { name: 'a b', skeleton: { bones: [named, root, unnamed, named] } },
    { name: 'Clothing', skeleton: { bones: [unnamed, named, root] } },
    { name: 'a_b', skeleton: { bones: [otherChild, otherRoot] } },
  ] }
  const binding = collectRigSkeletonBinding(input)
  assert.deepEqual(binding.summary, collectRigSkeletonSummary(input))
  assert.equal(binding.summary.stats.skinnedMeshCount, 3)
  assert.equal(binding.summary.bones.length, 5)
  assert.equal(binding.bonesById.size, 5)
  assert.equal(new Set(binding.summary.skinnedMeshContexts).size, 2)
  const expected = new Map([[root, 1], [unnamed, 2], [named, 0], [otherRoot, 1], [otherChild, 0]])
  for (const node of binding.summary.bones) {
    const bone = binding.bonesById.get(node.boneId)!
    assert.equal(node.nodeIndex, expected.get(bone), node.boneId)
    assert.equal(node.originalName, bone.name)
    assert.equal(node.role, undefined, 'collection must not infer semantic roles from names')
  }
  const unnamedNode = binding.summary.bones.find(node => binding.bonesById.get(node.boneId) === unnamed)!
  assert.equal(unnamedNode.label, 'Bone 2')
  assert.equal(unnamedNode.originalName, '')
  assert.deepEqual([root.name, unnamed.name, named.name], ['Root', '', ' Named '])

  // Metadata is optional for existing consumers, and roles are not restricted at this boundary.
  const { nodeIndex: _nodeIndex, ...legacyNode }: RigBoneNode = unnamedNode
  const enrichedNode: RigBoneNode = { ...legacyNode, nodeIndex: 2, role: 'provider_specific_role' }
  assert.equal(enrichedNode.role, 'provider_specific_role')
})

test('semantic role contract uses canonical ids and aliases only at ingestion boundaries', () => {
  assert.deepEqual(CANONICAL_SEMANTIC_ROLE_IDS, [
    'hips', 'spine', 'chest', 'neck', 'head',
    'left_upper_arm', 'left_lower_arm', 'left_hand',
    'right_upper_arm', 'right_lower_arm', 'right_hand',
    'left_upper_leg', 'left_lower_leg', 'left_foot',
    'right_upper_leg', 'right_lower_leg', 'right_foot',
    'left_fingers', 'right_fingers', 'left_toes', 'right_toes',
  ] satisfies SemanticRoleId[])
  for (const role of CANONICAL_SEMANTIC_ROLE_IDS) {
    assert.equal(normalizeSemanticRoleId(role), role)
  }
  const aliases: [string, SemanticRoleId][] = [
    ['hip', 'hips'], ['pelvis', 'hips'], ['root', 'hips'],
    ['spine1', 'spine'], ['spine2', 'chest'], ['spine3', 'chest'], ['upper chest', 'chest'],
    ['left_arm', 'left_upper_arm'], ['lupperarm', 'left_upper_arm'], ['L upper arm', 'left_upper_arm'],
    ['left_forearm', 'left_lower_arm'], ['leftelbow', 'left_lower_arm'],
    ['right_arm', 'right_upper_arm'], ['rupperarm', 'right_upper_arm'],
    ['right_forearm', 'right_lower_arm'], ['right_elbow', 'right_lower_arm'],
    ['left_leg', 'left_upper_leg'], ['leftthigh', 'left_upper_leg'], ['left_shin', 'left_lower_leg'],
    ['right_leg', 'right_upper_leg'], ['right_thigh', 'right_upper_leg'], ['right_shin', 'right_lower_leg'],
    ['left_toe_base', 'left_toes'], ['righttoebase', 'right_toes'],
    ['  LEFT--LOWER ARM  ', 'left_lower_arm'], [' Right ForeArm ', 'right_lower_arm'],
  ]
  for (const [alias, expected] of aliases) assert.equal(normalizeSemanticRoleId(alias), expected, alias)
  for (const unknown of [undefined, '', '   ', 'bone_4', 'unknown_role', 'constructor', ' CONSTRUCTOR ', 'c_o_n_s_t_r_u_c_t_o_r', '__proto__', 'toString']) {
    assert.equal(normalizeSemanticRoleId(unknown), undefined, String(unknown))
  }
})
