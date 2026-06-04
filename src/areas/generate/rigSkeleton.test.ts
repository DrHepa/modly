import assert from 'node:assert/strict'
import test from 'node:test'
import { Bone } from 'three'

import { buildRigSelectionOverlay, collectRigSkeletonBinding, collectRigSkeletonSummary, translateKimodoTargetTracks, type RigSkeletonSummary, type RigBoneNode } from './rigSkeleton.ts'
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

test('translateKimodoTargetTracks resolves unique original names and uses roles to disambiguate duplicates', () => {
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

test('Kimodo translation does not confuse exported indices with local skeleton array positions', () => {
  const root = namedBone('Root'); const a = namedBone('Arm'); const b = namedBone('Arm')
  root.add(a, b)
  for (const bones of [[root, a, b], [b, root, a]]) {
    const binding = collectRigSkeletonBinding({ skinnedMeshes: [{ name: 'Body', skeleton: { bones } }] })
    const track = { targetNodeName: 'Arm', targetNodeIndex: bones.indexOf(a), rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] }
    const ambiguous = translateKimodoTargetTracks(binding.summary, [track])
    assert.equal(ambiguous.ok, false)
    assert.match(ambiguous.diagnostics.join('\n'), /ambiguous|index domain/i)
    binding.summary.bones.find(node => binding.bonesById.get(node.boneId) === b)!.role = 'left_arm'
    const resolved = translateKimodoTargetTracks(binding.summary, [{ ...track, targetRole: 'left_upper_arm' }])
    assert.equal(resolved.ok, true)
    assert.equal(binding.bonesById.get(resolved.tracks[0].boneId), b)
  }
})

test('Kimodo translation preserves exact raw names before case folding and never uses display aliases', () => {
  const a = namedBone('Arm'); const b = namedBone('arm'); const c = namedBone(' Arm ')
  const binding = collectRigSkeletonBinding({ skinnedMeshes: [{ skeleton: { bones: [a, b, c] } }] })
  binding.summary.bones.forEach(node => { node.label = 'Hand' })
  const make = (targetNodeName: string) => ({ targetNodeName, targetNodeIndex: 2, rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] })
  for (const bone of [a, b, c]) {
    const result = translateKimodoTargetTracks(binding.summary, [make(bone.name)])
    assert.equal(result.ok, true)
    assert.equal(binding.bonesById.get(result.tracks[0].boneId), bone)
  }
  assert.equal(translateKimodoTargetTracks(binding.summary, [make('ARM')]).ok, false)
  assert.equal(translateKimodoTargetTracks(binding.summary, [make('Hand')]).ok, false)
})

test('Kimodo translation removes all tracks colliding on a target but preserves unrelated valid tracks', () => {
  const hips = namedBone('Hips'); const foot = namedBone('Foot')
  const binding = collectRigSkeletonBinding({ skinnedMeshes: [{ skeleton: { bones: [hips, foot] } }] })
  binding.summary.bones[0].role = 'hips'
  const make = (targetNodeName: string, targetRole?: string) => ({ targetNodeName, targetNodeIndex: 99, targetRole, rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] })
  const result = translateKimodoTargetTracks(binding.summary, [make('Hips'), make('Pelvis', 'hips'), make('Foot')])
  assert.equal(result.ok, true)
  assert.deepEqual(result.tracks.map(track => binding.bonesById.get(track.boneId)), [foot])
  assert.match(result.diagnostics.join('\n'), /duplicate|multiple|collision/i)
})

test('Kimodo translation validates direct-call rotations without sacrificing other valid targets', () => {
  const binding = collectRigSkeletonBinding({ skinnedMeshes: [{ skeleton: { bones: [namedBone('Hips')] } }] })
  const valid = { targetNodeName: 'Hips', targetNodeIndex: 0, rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }] }
  for (const rotation of [{ timeSeconds: -1, x: 0, y: 0, z: 0, w: 1 }, { timeSeconds: NaN, x: 0, y: 0, z: 0, w: 1 }, { timeSeconds: 0, x: 0, y: 0, z: 0, w: 0 }, { timeSeconds: 0, x: Infinity, y: 0, z: 0, w: 1 }]) {
    assert.equal(translateKimodoTargetTracks(binding.summary, [{ ...valid, rotations: [rotation] }]).ok, false)
  }
  assert.equal(translateKimodoTargetTracks(binding.summary, [{ ...valid, rotations: [{ ...valid.rotations[0], timeSeconds: 1 }, valid.rotations[0]] }]).ok, false)
  assert.equal(translateKimodoTargetTracks(binding.summary, [{ ...valid, targetNodeIndex: -1 }]).ok, false)
})

test('Kimodo translated IDs bind real reversed and shared Three bones without modifying names or arrays', async () => {
  const { Scene, Skeleton, SkinnedMesh, AnimationMixer, AnimationClip, QuaternionKeyframeTrack } = await import('three')
  const scene = new Scene(); const hips = namedBone('Hips'); const foot = namedBone('Foot'); hips.add(foot)
  const mesh = new SkinnedMesh(); mesh.add(hips); mesh.bind(new Skeleton([foot, hips])); scene.add(mesh)
  const shared = new SkinnedMesh(); shared.bind(new Skeleton([hips, foot])); scene.add(shared)
  const binding = collectRigSkeletonBinding({ skinnedMeshes: [{ name: 'Body', skeleton: mesh.skeleton }, { name: 'Clothes', skeleton: shared.skeleton }] })
  const input = [{ targetNodeName: 'Foot', targetNodeIndex: 42, rotations: [{ timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 }, { timeSeconds: 1, x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }] }]
  const before = structuredClone(input)
  const result = translateKimodoTargetTracks(binding.summary, input)
  assert.equal(result.ok, true)
  assert.equal(binding.bonesById.get(result.tracks[0].boneId), foot)
  const track = result.tracks[0]
  const target = binding.bonesById.get(track.boneId)!
  const clip = new AnimationClip('Translated', 1, [new QuaternionKeyframeTrack(`${target.uuid}.quaternion`, track.rotations.map(r => r.timeSeconds), track.rotations.flatMap(r => [r.x, r.y, r.z, r.w]))])
  const mixer = new AnimationMixer(scene); mixer.clipAction(clip).play(); mixer.setTime(0.5)
  assert.ok(Math.abs(foot.quaternion.y - Math.sin(Math.PI / 8)) < 1e-6)
  assert.equal(hips.quaternion.y, 0)
  assert.deepEqual(mesh.skeleton.bones, [foot, hips]); assert.deepEqual(shared.skeleton.bones, [hips, foot])
  assert.deepEqual([hips.name, foot.name], ['Hips', 'Foot']); assert.deepEqual(input, before)
  track.rotations[0].x = 0.5; assert.deepEqual(input, before)
  mixer.stopAllAction(); mixer.uncacheRoot(scene)
})
