import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRigMetaNamingFromHumanoidAssignments,
  normalizeRigMetaNaming,
  translateHumanoidAssignmentsToRigMetaNaming,
} from './rigMetaNaming.ts'
import type { RigSkeletonSummary } from './rigSkeleton.ts'

function createContextualRigSummary(): RigSkeletonSummary {
  const hipsId = 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0'
  const spineId = `${hipsId}/bone_1#0`
  const leftArmId = `${spineId}/bone_2#0`
  const chestId = `${leftArmId}/bone_3#0`
  const neckId = `${chestId}/bone_4#0`
  const headId = `${neckId}/bone_5#0`

  return {
    hasRig: true,
    sourceWorkspacePath: 'Workflows/1779522315_382fd9a5_unirig.glb',
    skeletonContextId: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0',
    skinnedMeshContexts: ['rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0'],
    rootBoneIds: [hipsId],
    stats: { skinnedMeshCount: 1, boneCount: 6 },
    warnings: [],
    bones: [
      { boneId: hipsId, label: 'bone_0', originalName: 'bone_0', path: ['bone_0'], siblingIndex: 0, childIds: [spineId], warnings: [] },
      { boneId: spineId, label: 'bone_1', originalName: 'bone_1', path: ['bone_0', 'bone_1'], siblingIndex: 0, parentId: hipsId, childIds: [leftArmId], warnings: [] },
      { boneId: leftArmId, label: 'bone_2', originalName: 'bone_2', path: ['bone_0', 'bone_1', 'bone_2'], siblingIndex: 0, parentId: spineId, childIds: [chestId], warnings: [] },
      { boneId: chestId, label: 'bone_3', originalName: 'bone_3', path: ['bone_0', 'bone_1', 'bone_2', 'bone_3'], siblingIndex: 0, parentId: leftArmId, childIds: [neckId], warnings: [] },
      { boneId: neckId, label: 'bone_4', originalName: 'bone_4', path: ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4'], siblingIndex: 0, parentId: chestId, childIds: [headId], warnings: [] },
      { boneId: headId, label: 'bone_5', originalName: 'bone_5', path: ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4', 'bone_5'], siblingIndex: 0, parentId: neckId, childIds: [], warnings: [] },
    ],
  }
}

function createAmbiguousContextualRigSummary(): RigSkeletonSummary {
  const summary = createContextualRigSummary()
  return {
    ...summary,
    stats: { ...summary.stats, boneCount: summary.bones.length + 1 },
    warnings: ['Duplicate bone name "bone_0" appears 2 times in rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0.'],
    bones: [
      ...summary.bones,
      {
        boneId: `${summary.bones[5]!.boneId}/bone_0#1`,
        label: 'bone_0',
        originalName: 'bone_0',
        path: [...summary.bones[5]!.path, 'bone_0'],
        siblingIndex: 1,
        parentId: summary.bones[5]!.boneId,
        childIds: [],
        warnings: ['duplicate-name'],
      },
    ],
  }
}

function createHumanoidRoles() {
  return {
    roles: {
      hips: 'bone_0',
      spine: 'bone_1',
      chest: 'bone_3',
      neck: 'bone_4',
      head: 'bone_5',
    },
    chains: {
      spine: ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4', 'bone_5'],
    },
  }
}

function createTrustedHumanoidContract(requiredRoles: Record<string, string>) {
  return {
    schema: 'modly.humanoid.v1',
    humanoid_contract_status: 'trusted',
    required_roles: requiredRoles,
    validation: { status: 'validated' },
    provenance: {
      trust_scope: {
        trusted: ['required_roles', 'role_chains'],
      },
    },
  }
}

test('translateHumanoidAssignmentsToRigMetaNaming prefers exact runtime ids and humanizes roles', () => {
  const summary = createContextualRigSummary()
  const exactHipsId = summary.bones[0]!.boneId

  const translation = translateHumanoidAssignmentsToRigMetaNaming({
    summary,
    sources: [{
      source: 'humanoid_promotion',
      roleMap: {
        roles: {
          hips: exactHipsId,
          spine: 'bone_1',
        },
      },
    }],
  })

  assert.deepEqual(translation.namingByBoneId, {
    [exactHipsId]: { label: 'Hips', source: 'humanoid_promotion' },
    [summary.bones[1]!.boneId]: { label: 'Spine', source: 'humanoid_promotion' },
  })
  assert.deepEqual(translation.diagnostics, [])
})

test('translateHumanoidAssignmentsToRigMetaNaming resolves legacy raw assignment ids against contextual runtime RigBoneId values', () => {
  const summary = createContextualRigSummary()

  const translation = translateHumanoidAssignmentsToRigMetaNaming({
    summary,
    sources: [{ source: 'humanoid_draft', roleMap: createHumanoidRoles() }],
  })

  assert.deepEqual(translation.namingByBoneId, {
    [summary.bones[0]!.boneId]: { label: 'Hips', source: 'humanoid_draft' },
    [summary.bones[1]!.boneId]: { label: 'Spine', source: 'humanoid_draft' },
    [summary.bones[3]!.boneId]: { label: 'Chest', source: 'humanoid_draft' },
    [summary.bones[4]!.boneId]: { label: 'Neck', source: 'humanoid_draft' },
    [summary.bones[5]!.boneId]: { label: 'Head', source: 'humanoid_draft' },
  })
  assert.deepEqual(translation.diagnostics, [])
})

test('translateHumanoidAssignmentsToRigMetaNaming fails closed for ambiguous and missing raw-name matches', () => {
  const summary = createAmbiguousContextualRigSummary()

  const translation = translateHumanoidAssignmentsToRigMetaNaming({
    summary,
    sources: [{
      source: 'embedded_rigmeta',
      roleMap: {
        roles: {
          hips: 'bone_0',
          left_hand: 'bone_999',
        },
      },
    }],
  })

  assert.deepEqual(translation.namingByBoneId, {})
  assert.deepEqual(translation.diagnostics, [
    'embedded_rigmeta assignment "hips" with identifier "bone_0" is ambiguous across 2 runtime bones.',
    'embedded_rigmeta assignment "left_hand" with identifier "bone_999" could not be resolved to a runtime rig bone.',
  ])
})

test('createRigMetaNamingFromHumanoidAssignments preserves direct runtime-id inversion for already-translated maps', () => {
  const summary = createContextualRigSummary()

  const naming = createRigMetaNamingFromHumanoidAssignments({
    hips: summary.bones[0]!.boneId,
    spine: summary.bones[1]!.boneId,
  }, 'humanoid_promotion')

  assert.deepEqual(naming, {
    [summary.bones[0]!.boneId]: { label: 'Hips', source: 'humanoid_promotion' },
    [summary.bones[1]!.boneId]: { label: 'Spine', source: 'humanoid_promotion' },
  })
})

test('normalizeRigMetaNaming maps trusted humanoid_contract.required_roles through contextual runtime bone ids', () => {
  const summary = createContextualRigSummary()

  const result = normalizeRigMetaNaming({
    humanoid_contract: createTrustedHumanoidContract({
      hips: 'bone_0',
      left_upper_leg: 'bone_2',
    }),
  }, { summary })

  assert.equal(result.valid, true)
  assert.deepEqual(result.namingByBoneId, {
    [summary.bones[0]!.boneId]: { label: 'Hips', source: 'humanoid_contract' },
    [summary.bones[2]!.boneId]: { label: 'Left Upper Leg', source: 'humanoid_contract' },
  })
  assert.deepEqual(result.warnings, [])
})

test('normalizeRigMetaNaming does not emit trusted labels for draft or blocked humanoid contracts', () => {
  const summary = createContextualRigSummary()

  for (const status of ['draft', 'blocked']) {
    const result = normalizeRigMetaNaming({
      humanoid_contract: {
        ...createTrustedHumanoidContract({ hips: 'bone_0' }),
        humanoid_contract_status: status,
      },
    }, { summary })

    assert.deepEqual(result.namingByBoneId, {})
    assert.deepEqual(result.warnings, ['Rigmeta did not contain supported naming entries.'])
  }
})

test('normalizeRigMetaNaming fails closed with diagnostics for ambiguous and missing trusted contract raw bones', () => {
  const summary = createAmbiguousContextualRigSummary()

  const result = normalizeRigMetaNaming({
    humanoid_contract: createTrustedHumanoidContract({
      hips: 'bone_0',
      left_hand: 'bone_999',
    }),
  }, { summary })

  assert.deepEqual(result.namingByBoneId, {})
  assert.deepEqual(result.warnings, [
    'humanoid_contract assignment "hips" with identifier "bone_0" is ambiguous across 2 runtime bones.',
    'humanoid_contract assignment "left_hand" with identifier "bone_999" could not be resolved to a runtime rig bone.',
    'Rigmeta did not contain supported naming entries.',
  ])
})

test('normalizeRigMetaNaming preserves legacy naming shapes and humanoid draft support', () => {
  const summary = createContextualRigSummary()

  assert.deepEqual(normalizeRigMetaNaming({
    semantic_candidates: {
      [summary.bones[0]!.boneId]: { label: 'Pelvis' },
    },
  }).namingByBoneId, {
    [summary.bones[0]!.boneId]: { label: 'Pelvis', source: 'semantic_candidates' },
  })

  assert.deepEqual(normalizeRigMetaNaming({
    humanoid_contract: {
      bones: {
        [summary.bones[1]!.boneId]: { display_name: 'Backbone' },
      },
    },
  }).namingByBoneId, {
    [summary.bones[1]!.boneId]: { label: 'Backbone', source: 'humanoid_contract' },
  })

  assert.deepEqual(normalizeRigMetaNaming({
    humanoid_contract: {
      [summary.bones[2]!.boneId]: 'Legacy Arm',
    },
  }).namingByBoneId, {
    [summary.bones[2]!.boneId]: { label: 'Legacy Arm', source: 'humanoid_contract' },
  })

  assert.deepEqual(normalizeRigMetaNaming({
    humanoid_draft: {
      assignments: { roles: { hips: 'bone_0' } },
    },
  }, { summary }).namingByBoneId, {
    [summary.bones[0]!.boneId]: { label: 'Hips', source: 'humanoid_draft' },
  })
})
