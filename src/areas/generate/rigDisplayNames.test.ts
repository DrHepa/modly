import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveRigDisplayName,
  resolveRigDisplayNames,
  resolveRigDisplayNameById,
} from './rigDisplayNames.ts'
import type { RigBoneId, RigSkeletonSummary } from './rigSkeleton.ts'

function createRigSummary(): RigSkeletonSummary {
  const hipsId = 'rig:hero|skeleton:0|bone:bone_0#0' satisfies RigBoneId
  const spineId = 'rig:hero|skeleton:0|bone:bone_0#0/bone_1#0' satisfies RigBoneId
  const handId = 'rig:hero|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0' satisfies RigBoneId

  return {
    hasRig: true,
    sourceWorkspacePath: 'Workflows/generated/hero.glb',
    skeletonContextId: 'rig:hero|skeleton:0',
    skinnedMeshContexts: ['rig:hero|skeleton:0'],
    rootBoneIds: [hipsId],
    stats: { skinnedMeshCount: 1, boneCount: 3 },
    warnings: [],
    bones: [
      { boneId: hipsId, label: 'bone_0', originalName: 'bone_0', path: ['bone_0'], siblingIndex: 0, childIds: [spineId], warnings: [] },
      { boneId: spineId, label: 'bone_1', originalName: 'bone_1', path: ['bone_0', 'bone_1'], siblingIndex: 0, parentId: hipsId, childIds: [handId], warnings: [] },
      { boneId: handId, label: 'bone_2', originalName: 'bone_2', path: ['bone_0', 'bone_1', 'bone_2'], siblingIndex: 0, parentId: spineId, childIds: [], warnings: [] },
    ],
  }
}

test('resolveRigDisplayNames applies manual alias before UniRig labels and raw GLB names', () => {
  const summary = createRigSummary()
  const displayNames = resolveRigDisplayNames({
    summary,
    renamePlan: {
      skeletonContextId: summary.skeletonContextId,
      aliases: {
        [summary.bones[1].boneId]: { oldLabel: 'bone_1', alias: 'Manual Chest' },
      },
    },
    rigMetaNamingByBoneId: {
      [summary.bones[0].boneId]: { label: 'UniRig Pelvis', source: 'humanoid_contract' },
      [summary.bones[1].boneId]: { label: 'UniRig Spine', source: 'semantic_candidates' },
    },
  })

  assert.deepEqual(displayNames.ordered, [
    { boneId: summary.bones[0].boneId, label: 'UniRig Pelvis', rawLabel: 'bone_0', provenance: 'unirig' },
    { boneId: summary.bones[1].boneId, label: 'Manual Chest', rawLabel: 'bone_1', provenance: 'manual' },
    { boneId: summary.bones[2].boneId, label: 'bone_2', rawLabel: 'bone_2', provenance: 'raw' },
  ])
})

test('resolveRigDisplayNameById returns display labels without changing stable RigBoneId identity', () => {
  const summary = createRigSummary()
  const displayNames = resolveRigDisplayNames({
    summary,
    rigMetaNamingByBoneId: {
      [summary.bones[2].boneId]: { label: 'UniRig Left Hand', source: 'semantic_candidates' },
    },
  })

  assert.deepEqual(resolveRigDisplayNameById(summary, summary.bones[2].boneId, displayNames), {
    boneId: summary.bones[2].boneId,
    label: 'UniRig Left Hand',
    rawLabel: 'bone_2',
    provenance: 'unirig',
  })
  assert.deepEqual(resolveRigDisplayName(summary.bones[0], displayNames), {
    boneId: summary.bones[0].boneId,
    label: 'bone_0',
    rawLabel: 'bone_0',
    provenance: 'raw',
  })
  assert.equal(resolveRigDisplayNameById(summary, 'rig:missing|bone:ghost#0' satisfies RigBoneId, displayNames), undefined)
})
