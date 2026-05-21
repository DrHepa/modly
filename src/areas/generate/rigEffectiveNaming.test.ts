import assert from 'node:assert/strict'
import test from 'node:test'

import { createRigRenamePlan } from './rigRenamePlan.ts'
import { resolveRigEffectiveNaming } from './rigEffectiveNaming.ts'
import type { RigMetaNamingMap } from './rigMetaNaming.ts'
import type { RigRenamePlan } from './rigRenamePlan.ts'
import type { RigSkeletonSummary } from './rigSkeleton.ts'

const summary: RigSkeletonSummary = {
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
      label: 'Hips_raw',
      originalName: 'Hips_raw',
      path: ['Hips_raw'],
      siblingIndex: 0,
      childIds: ['bone:spine', 'bone:head'],
      warnings: [],
    },
    {
      boneId: 'bone:spine',
      label: 'Spine_raw',
      originalName: 'Spine_raw',
      path: ['Hips_raw', 'Spine_raw'],
      siblingIndex: 0,
      parentId: 'bone:hips',
      childIds: [],
      warnings: [],
    },
    {
      boneId: 'bone:head',
      label: 'Head_raw',
      originalName: 'Head_raw',
      path: ['Hips_raw', 'Head_raw'],
      siblingIndex: 1,
      parentId: 'bone:hips',
      childIds: [],
      warnings: [],
    },
  ],
}

test('resolveRigEffectiveNaming applies manual alias over UniRig label over raw GLB label with provenance', () => {
  const plan: RigRenamePlan = {
    ...createRigRenamePlan(summary),
    aliases: {
      'bone:spine': { oldLabel: 'Spine_raw', alias: 'Manual Spine' },
    },
  }
  const rigMeta: RigMetaNamingMap = {
    'bone:hips': { label: 'Pelvis', source: 'semantic_candidates' },
    'bone:spine': { label: 'UniRig Spine', source: 'humanoid_contract' },
  }

  const result = resolveRigEffectiveNaming(summary, plan, rigMeta)

  assert.deepEqual(result.byBoneId, {
    'bone:hips': { boneId: 'bone:hips', label: 'Pelvis', rawLabel: 'Hips_raw', provenance: 'unirig' },
    'bone:spine': { boneId: 'bone:spine', label: 'Manual Spine', rawLabel: 'Spine_raw', provenance: 'manual' },
    'bone:head': { boneId: 'bone:head', label: 'Head_raw', rawLabel: 'Head_raw', provenance: 'raw' },
  })
  assert.deepEqual(result.ordered.map((entry) => [entry.boneId, entry.label, entry.provenance]), [
    ['bone:hips', 'Pelvis', 'unirig'],
    ['bone:spine', 'Manual Spine', 'manual'],
    ['bone:head', 'Head_raw', 'raw'],
  ])
})

test('resolveRigEffectiveNaming falls back to raw or manual when UniRig map is missing and ignores unknown bone IDs safely', () => {
  const plan: RigRenamePlan = {
    ...createRigRenamePlan(summary),
    aliases: {
      'bone:head': { oldLabel: 'Head_raw', alias: 'Manual Head' },
      'bone:missing': { oldLabel: 'Missing', alias: 'Ghost' },
    },
  }
  const beforePlan = structuredClone(plan)
  const beforeSummary = structuredClone(summary)
  const rigMeta: RigMetaNamingMap = {
    'bone:missing': { label: 'Ghost Meta', source: 'semantic_candidates' },
  }
  const beforeRigMeta = structuredClone(rigMeta)

  const result = resolveRigEffectiveNaming(summary, plan, undefined)
  const ignoredResult = resolveRigEffectiveNaming(summary, plan, rigMeta)

  assert.deepEqual(result.ordered.map((entry) => [entry.boneId, entry.label, entry.provenance]), [
    ['bone:hips', 'Hips_raw', 'raw'],
    ['bone:spine', 'Spine_raw', 'raw'],
    ['bone:head', 'Manual Head', 'manual'],
  ])
  assert.equal(ignoredResult.byBoneId['bone:missing'], undefined)
  assert.deepEqual(plan, beforePlan)
  assert.deepEqual(summary, beforeSummary)
  assert.deepEqual(rigMeta, beforeRigMeta)
})
