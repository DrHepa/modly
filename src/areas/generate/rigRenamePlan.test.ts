import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRigRenameSidecarV1,
  createRigRenameSidecarWorkspacePath,
  createRigRenamePlan,
  hydrateRigRenamePlanFromSidecar,
  reduceRigRenamePlan,
  validateRigRenamePlan,
  type RigRenameSidecarV1,
  type RigRenamePlanAction,
} from './rigRenamePlan.ts'
import type { RigSkeletonSummary } from './rigSkeleton.ts'

const rigSummary: RigSkeletonSummary = {
  hasRig: true,
  sourceWorkspacePath: 'Workflows/generated/hero.glb',
  skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
  skinnedMeshContexts: ['rig:Hero_Mesh|skeleton:0'],
  rootBoneIds: ['bone:hips'],
  stats: { skinnedMeshCount: 1, boneCount: 4 },
  warnings: [],
  bones: [
    {
      boneId: 'bone:hips',
      label: 'Hips',
      originalName: 'Hips',
      path: ['Hips'],
      siblingIndex: 0,
      childIds: ['bone:left-leg', 'bone:right-leg'],
      warnings: [],
    },
    {
      boneId: 'bone:left-leg',
      label: 'Leg',
      originalName: 'Leg',
      path: ['Hips', 'Leg'],
      siblingIndex: 0,
      parentId: 'bone:hips',
      childIds: [],
      warnings: ['duplicate-name'],
    },
    {
      boneId: 'bone:right-leg',
      label: 'Leg',
      originalName: 'Leg',
      path: ['Hips', 'Leg'],
      siblingIndex: 1,
      parentId: 'bone:hips',
      childIds: ['bone:unnamed-hand'],
      warnings: ['duplicate-name'],
    },
    {
      boneId: 'bone:unnamed-hand',
      label: 'Bone 4',
      originalName: '   ',
      path: ['Hips', 'Leg', 'Bone 4'],
      siblingIndex: 0,
      parentId: 'bone:right-leg',
      childIds: [],
      warnings: ['empty-name'],
    },
  ],
}

test('reduceRigRenamePlan sets aliases by stable boneId, trims input, cancels one alias, reverts all aliases and treats original-label aliases as no-op', () => {
  const emptyPlan = createRigRenamePlan(rigSummary)

  const withLeftLegAlias = reduceRigRenamePlan(rigSummary, emptyPlan, {
    type: 'set-alias',
    boneId: 'bone:left-leg',
    alias: '  Left Upper Leg  ',
  })

  assert.deepEqual(withLeftLegAlias, {
    skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
    aliases: {
      'bone:left-leg': { oldLabel: 'Leg', alias: 'Left Upper Leg' },
    },
  })

  const withRightLegAlias = reduceRigRenamePlan(rigSummary, withLeftLegAlias, {
    type: 'set-alias',
    boneId: 'bone:right-leg',
    alias: 'Right Upper Leg',
  })
  assert.deepEqual(Object.keys(withRightLegAlias.aliases), ['bone:left-leg', 'bone:right-leg'])
  assert.deepEqual(withRightLegAlias.aliases['bone:right-leg'], { oldLabel: 'Leg', alias: 'Right Upper Leg' })

  const noOpBackToOriginal = reduceRigRenamePlan(rigSummary, withRightLegAlias, {
    type: 'set-alias',
    boneId: 'bone:left-leg',
    alias: 'Leg',
  })
  assert.deepEqual(noOpBackToOriginal.aliases, {
    'bone:right-leg': { oldLabel: 'Leg', alias: 'Right Upper Leg' },
  })

  const cancelled = reduceRigRenamePlan(rigSummary, withRightLegAlias, { type: 'cancel-alias', boneId: 'bone:right-leg' })
  assert.deepEqual(cancelled.aliases, {
    'bone:left-leg': { oldLabel: 'Leg', alias: 'Left Upper Leg' },
  })

  const reverted = reduceRigRenamePlan(rigSummary, withRightLegAlias, { type: 'revert-all' })
  assert.deepEqual(reverted, createRigRenamePlan(rigSummary))
})

test('validateRigRenamePlan blocks empty aliases and duplicate effective names within the skeleton scope while preserving duplicate original labels by boneId', () => {
  const emptyAliasPlan = reduceRigRenamePlan(rigSummary, createRigRenamePlan(rigSummary), {
    type: 'set-alias',
    boneId: 'bone:unnamed-hand',
    alias: '   ',
  })
  assert.deepEqual(validateRigRenamePlan(rigSummary, emptyAliasPlan), {
    valid: false,
    errors: [
      {
        boneId: 'bone:unnamed-hand',
        code: 'empty-alias',
        message: 'Alias for "Bone 4" cannot be empty.',
      },
    ],
  })

  const duplicateExistingNamePlan = reduceRigRenamePlan(rigSummary, createRigRenamePlan(rigSummary), {
    type: 'set-alias',
    boneId: 'bone:unnamed-hand',
    alias: 'Hips',
  })
  assert.deepEqual(validateRigRenamePlan(rigSummary, duplicateExistingNamePlan), {
    valid: false,
    errors: [
      {
        boneId: 'bone:unnamed-hand',
        code: 'duplicate-alias',
        message: 'Alias "Hips" for "Bone 4" collides with "Hips" in this skeleton.',
      },
    ],
  })

  const duplicatePlannedAlias = reduceRigRenamePlan(
    rigSummary,
    reduceRigRenamePlan(rigSummary, createRigRenamePlan(rigSummary), {
      type: 'set-alias',
      boneId: 'bone:left-leg',
      alias: 'Upper Leg',
    }),
    { type: 'set-alias', boneId: 'bone:right-leg', alias: 'Upper Leg' },
  )
  assert.deepEqual(validateRigRenamePlan(rigSummary, duplicatePlannedAlias), {
    valid: false,
    errors: [
      {
        boneId: 'bone:left-leg',
        code: 'duplicate-alias',
        message: 'Alias "Upper Leg" for "Leg" collides with "Leg" in this skeleton.',
      },
      {
        boneId: 'bone:right-leg',
        code: 'duplicate-alias',
        message: 'Alias "Upper Leg" for "Leg" collides with "Leg" in this skeleton.',
      },
    ],
  })

  const validDisambiguation = reduceRigRenamePlan(
    rigSummary,
    reduceRigRenamePlan(rigSummary, createRigRenamePlan(rigSummary), {
      type: 'set-alias',
      boneId: 'bone:left-leg',
      alias: 'Left Upper Leg',
    }),
    { type: 'set-alias', boneId: 'bone:right-leg', alias: 'Right Upper Leg' },
  )
  assert.deepEqual(validateRigRenamePlan(rigSummary, validDisambiguation), { valid: true, errors: [] })
})

test('buildRigRenameSidecarV1 creates schema v1 metadata with source, timestamp, skeleton context and aliases without mutating bone names', () => {
  const originalLabels = rigSummary.bones.map((bone) => bone.label)
  const plan = reduceRigRenamePlan(
    rigSummary,
    reduceRigRenamePlan(rigSummary, createRigRenamePlan(rigSummary), {
      type: 'set-alias',
      boneId: 'bone:left-leg',
      alias: 'Left Upper Leg',
    }),
    { type: 'set-alias', boneId: 'bone:unnamed-hand', alias: 'Palm Control' },
  )

  const sidecar = buildRigRenameSidecarV1({
    summary: rigSummary,
    plan,
    createdAt: '2026-05-18T21:55:00.000Z',
    source: {
      workspacePath: 'Workflows/generated/hero.glb',
      artifactId: 'artifact-123',
      versionId: 'version-456',
    },
  })

  assert.deepEqual(sidecar, {
    schema: 'modly.rig.rename-plan',
    version: 1,
    createdAt: '2026-05-18T21:55:00.000Z',
    source: {
      workspacePath: 'Workflows/generated/hero.glb',
      artifactId: 'artifact-123',
      versionId: 'version-456',
    },
    skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
    skeleton: {
      rootBoneIds: ['bone:hips'],
      boneCount: 4,
      bones: [
        { boneId: 'bone:left-leg', oldLabel: 'Leg', originalName: 'Leg', path: ['Hips', 'Leg'] },
        { boneId: 'bone:unnamed-hand', oldLabel: 'Bone 4', originalName: '   ', path: ['Hips', 'Leg', 'Bone 4'] },
      ],
    },
    aliases: {
      'bone:left-leg': { oldLabel: 'Leg', alias: 'Left Upper Leg' },
      'bone:unnamed-hand': { oldLabel: 'Bone 4', alias: 'Palm Control' },
    },
  })
  assert.deepEqual(rigSummary.bones.map((bone) => bone.label), originalLabels)
})

test('createRigRenameSidecarWorkspacePath derives one deterministic active sidecar path per source rig regardless of save time', () => {
  assert.equal(
    createRigRenameSidecarWorkspacePath('Workflows/generated/unirig-rig-aliases.glb'),
    'Workflows/rig-edits/unirig-rig-aliases-rig-aliases.rig.v1.json',
  )
  assert.equal(
    createRigRenameSidecarWorkspacePath('Workflows/generated/nested/hero character.gltf'),
    'Workflows/rig-edits/hero-character-rig-aliases.rig.v1.json',
  )
  assert.equal(
    createRigRenameSidecarWorkspacePath('Workflows/generated/unirig-rig-aliases.glb'),
    createRigRenameSidecarWorkspacePath('Workflows/generated/unirig-rig-aliases.glb'),
  )
})

test('reduceRigRenamePlan ignores actions for unknown boneIds and keeps the plan scoped to the selected skeleton', () => {
  const emptyPlan = createRigRenamePlan(rigSummary)
  const unknownActions: RigRenamePlanAction[] = [
    { type: 'set-alias', boneId: 'missing-bone', alias: 'Ghost' },
    { type: 'cancel-alias', boneId: 'missing-bone' },
  ]

  const afterUnknownActions = unknownActions.reduce(
    (plan, action) => reduceRigRenamePlan(rigSummary, plan, action),
    emptyPlan,
  )

  assert.deepEqual(afterUnknownActions, {
    skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
    aliases: {},
  })
})

test('hydrateRigRenamePlanFromSidecar hydrates compatible aliases by stable boneId using current skeleton labels without mutating inputs', () => {
  const sidecar = buildRigRenameSidecarV1({
    summary: rigSummary,
    plan: reduceRigRenamePlan(
      rigSummary,
      reduceRigRenamePlan(rigSummary, createRigRenamePlan(rigSummary), {
        type: 'set-alias',
        boneId: 'bone:left-leg',
        alias: 'Left Upper Leg',
      }),
      { type: 'set-alias', boneId: 'bone:unnamed-hand', alias: 'Palm Control' },
    ),
    createdAt: '2026-05-19T18:00:00.000Z',
  })
  const sidecarBefore = structuredClone(sidecar)
  const summaryBefore = structuredClone(rigSummary)
  const relabeledSummary: RigSkeletonSummary = {
    ...rigSummary,
    bones: rigSummary.bones.map((bone) => bone.boneId === 'bone:left-leg' ? { ...bone, label: 'Left Leg Current' } : { ...bone }),
  }

  const result = hydrateRigRenamePlanFromSidecar(relabeledSummary, sidecar, {
    sourceWorkspacePath: 'Workflows/generated/hero.glb',
  })

  assert.deepEqual(result, {
    valid: true,
    warnings: [],
    ignoredBoneIds: [],
    plan: {
      skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
      aliases: {
        'bone:left-leg': { oldLabel: 'Left Leg Current', alias: 'Left Upper Leg' },
        'bone:unnamed-hand': { oldLabel: 'Bone 4', alias: 'Palm Control' },
      },
    },
  })
  assert.deepEqual(sidecar, sidecarBefore)
  assert.deepEqual(rigSummary, summaryBefore)
})

test('hydrateRigRenamePlanFromSidecar rejects source mismatch as invalid with an empty plan and warning', () => {
  const sidecar = buildRigRenameSidecarV1({
    summary: rigSummary,
    plan: reduceRigRenamePlan(rigSummary, createRigRenamePlan(rigSummary), {
      type: 'set-alias',
      boneId: 'bone:left-leg',
      alias: 'Left Upper Leg',
    }),
    createdAt: '2026-05-19T18:01:00.000Z',
  })

  const result = hydrateRigRenamePlanFromSidecar(rigSummary, sidecar, {
    sourceWorkspacePath: 'Workflows/generated/other.glb',
  })

  assert.equal(result.valid, false)
  assert.deepEqual(result.plan, createRigRenamePlan(rigSummary))
  assert.deepEqual(result.ignoredBoneIds, [])
  assert.match(result.warnings.join('\n'), /source mismatch/i)
  assert.equal(result.plan.aliases['bone:left-leg'], undefined)
})

test('hydrateRigRenamePlanFromSidecar ignores unknown boneIds with warnings while preserving matching aliases for partial sidecars', () => {
  const partialSidecar: RigRenameSidecarV1 = {
    schema: 'modly.rig.rename-plan',
    version: 1,
    createdAt: '2026-05-19T18:02:00.000Z',
    source: { workspacePath: 'Workflows/generated/hero.glb' },
    skeletonContextId: 'legacy-context-id',
    skeleton: {
      rootBoneIds: ['bone:hips'],
      boneCount: 2,
      bones: [
        { boneId: 'bone:right-leg', oldLabel: 'Old Right Leg', originalName: 'Leg', path: ['Legacy', 'Right Leg'] },
        { boneId: 'bone:missing-tail', oldLabel: 'Tail', originalName: 'Tail', path: ['Legacy', 'Tail'] },
      ],
    },
    aliases: {
      'bone:right-leg': { oldLabel: 'Old Right Leg', alias: 'Right Upper Leg' },
      'bone:missing-tail': { oldLabel: 'Tail', alias: 'Tail Control' },
    },
  }

  const result = hydrateRigRenamePlanFromSidecar(rigSummary, partialSidecar, {
    sourceWorkspacePath: 'Workflows/generated/hero.glb',
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.plan, {
    skeletonContextId: 'rig:Hero_Mesh|skeleton:0',
    aliases: {
      'bone:right-leg': { oldLabel: 'Leg', alias: 'Right Upper Leg' },
    },
  })
  assert.deepEqual(result.ignoredBoneIds, ['bone:missing-tail'])
  assert.match(result.warnings.join('\n'), /unknown boneId "bone:missing-tail"/i)
})

test('hydrateRigRenamePlanFromSidecar returns invalid with warnings for invalid schema, version or kind', () => {
  const validSidecar = buildRigRenameSidecarV1({
    summary: rigSummary,
    plan: reduceRigRenamePlan(rigSummary, createRigRenamePlan(rigSummary), {
      type: 'set-alias',
      boneId: 'bone:left-leg',
      alias: 'Left Upper Leg',
    }),
    createdAt: '2026-05-19T18:03:00.000Z',
  })

  const invalidSidecars = [
    { ...validSidecar, schema: 'modly.rig.rename-plan.invalid' },
    { ...validSidecar, version: 2 },
    { ...validSidecar, kind: 'modly.rig.rename-plan.invalid' },
    { ...validSidecar, aliases: [] },
  ]

  for (const invalidSidecar of invalidSidecars) {
    const result = hydrateRigRenamePlanFromSidecar(rigSummary, invalidSidecar, {
      sourceWorkspacePath: 'Workflows/generated/hero.glb',
    })
    assert.equal(result.valid, false)
    assert.deepEqual(result.plan, createRigRenamePlan(rigSummary))
    assert.equal(Object.keys(result.plan.aliases).length, 0)
    assert.notEqual(result.warnings.length, 0)
  }
})
