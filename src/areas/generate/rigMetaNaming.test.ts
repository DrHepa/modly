import assert from 'node:assert/strict'
import test from 'node:test'
import type { RigMetaSidecarReadResult } from '../../shared/types/electron.d.ts'

import {
  createRigMetaWorkspacePath,
  createRigMetaNamingFromHumanoidAssignments,
  translateHumanoidAssignmentsToRigMetaNaming,
  normalizeRigMetaNaming,
  type RigMetaNamingMap,
} from './rigMetaNaming.ts'
import type { RigSkeletonSummary } from './rigSkeleton.ts'

test('createRigMetaWorkspacePath derives an adjacent rigmeta path for GLB and GLTF workspace paths', () => {
  assert.equal(
    createRigMetaWorkspacePath('Workflows/foo_unirig.glb'),
    'Workflows/foo_unirig.rigmeta.json',
  )
  assert.equal(
    createRigMetaWorkspacePath('Workflows/generated/nested/Hero Character.gltf'),
    'Workflows/generated/nested/Hero Character.rigmeta.json',
  )
})

test('createRigMetaWorkspacePath rejects non-mesh and unsafe workspace paths without traversal', () => {
  assert.equal(createRigMetaWorkspacePath('Workflows/foo.png'), null)
  assert.equal(createRigMetaWorkspacePath('../Workflows/foo.glb'), null)
  assert.equal(createRigMetaWorkspacePath('/tmp/foo.glb'), null)
  assert.equal(createRigMetaWorkspacePath('Workflows/../foo.glb'), null)
})

test('normalizeRigMetaNaming extracts plausible labels from semantic candidates and humanoid contracts defensively', () => {
  const result = normalizeRigMetaNaming({
    semantic_candidates: {
      'bone:hips': { label: 'Pelvis', score: 0.98, raw_json_that_should_not_leak: 'x'.repeat(4000) },
      'bone:left-arm': { display_name: 'Left Arm' },
      'bone:invalid': { label: '   ' },
    },
    humanoid_contract: {
      bones: {
        'bone:head': { name: 'Head Control' },
        'bone:right-arm': 'Right Arm',
      },
    },
    unknown_large_blob: { payload: 'y'.repeat(4000) },
  })

  const expectedMap: RigMetaNamingMap = {
    'bone:hips': { label: 'Pelvis', source: 'semantic_candidates' },
    'bone:left-arm': { label: 'Left Arm', source: 'semantic_candidates' },
    'bone:head': { label: 'Head Control', source: 'humanoid_contract' },
    'bone:right-arm': { label: 'Right Arm', source: 'humanoid_contract' },
  }
  assert.deepEqual(result.namingByBoneId, expectedMap)
  assert.equal(result.valid, true)
  assert.equal(result.warnings.some((warning) => warning.includes('raw_json_that_should_not_leak')), false)
  assert.equal(result.warnings.some((warning) => warning.includes('unknown_large_blob')), false)
})

test('normalizeRigMetaNaming returns partial warnings for invalid, unsupported, and mismatched rigmeta without throwing', () => {
  const invalidResult = normalizeRigMetaNaming(null)
  assert.equal(invalidResult.valid, false)
  assert.deepEqual(invalidResult.namingByBoneId, {})
  assert.match(invalidResult.warnings.join('\n'), /object/i)

  const partialResult = normalizeRigMetaNaming(
    {
      source: { workspacePath: 'Workflows/other.glb' },
      schema: 'unsupported.schema',
      semantic_candidates: {
        'bone:spine': { semantic_label: 'Spine' },
        'bone:empty': { semantic_label: '' },
      },
    },
    { expectedSourceWorkspacePath: 'Workflows/foo_unirig.glb' },
  )

  assert.deepEqual(partialResult.namingByBoneId, {})
  assert.equal(partialResult.valid, false)
  assert.match(partialResult.warnings.join('\n'), /unsupported/i)
  assert.match(partialResult.warnings.join('\n'), /source mismatch/i)
  const formatOnly = normalizeRigMetaNaming({ semantic_candidates: { valid: 'Label', invalid: {} } })
  assert.equal(formatOnly.valid, true)
  assert.match(formatOnly.warnings.join('\n'), /partial/i)
})

test('contextual rigmeta normalization rejects explicit source and skeleton contradictions', () => {
  const valid = { source: { workspacePath: 'A/hero.glb' }, skeletonContextId: 'rig:A', semantic_candidates: { target: 'Hand' } }
  const options = { expectedSourceWorkspacePath: 'A/hero.glb', expectedSkeletonContextId: 'rig:A' }
  assert.equal(normalizeRigMetaNaming(valid, options).valid, true)
  for (const wrong of [
    { ...valid, source: { workspacePath: 'B/hero.glb' } },
    { ...valid, skeletonContextId: 'rig:B' },
    { ...valid, source: { workspacePath: null } }, { ...valid, skeletonContextId: null },
  ]) {
    const result = normalizeRigMetaNaming(wrong, options)
    assert.equal(result.valid, false)
    assert.deepEqual(result.namingByBoneId, {})
  }
})


test('trusted original42 adjacent rigmeta survives real main read, normalization and current-summary label filtering', async () => {
  const fs = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Bone } = await import('three')
  // Runtime URL keeps this cross-project integration from changing web's TS file list.
  const { readRigMetaSidecar }: {
    readRigMetaSidecar: (request: { workspaceDir: string; sourceWorkspacePath: string }) => Promise<RigMetaSidecarReadResult>
  } = await import(new URL('../../../electron/main/artifact-registry-service.ts', import.meta.url).href)
  const { collectRigSkeletonSummary } = await import('./rigSkeleton.ts')
  const { resolveRigDisplayNames } = await import('./rigDisplayNames.ts')
  const workspaceDir = await fs.mkdtemp(join(tmpdir(), 'modly-rigmeta-compat-'))
  try {
    const sourceWorkspacePath = 'Workflows/foo_unirig.glb'
    await fs.mkdir(join(workspaceDir, 'Workflows'))
    await fs.writeFile(join(workspaceDir, sourceWorkspacePath), 'original source bytes')
    const hips = new Bone(); hips.name = 'Hips'
    const spine = new Bone(); spine.name = 'Spine'
    const head = new Bone(); head.name = 'Head'; hips.add(spine, head)
    const summary = collectRigSkeletonSummary({ sourceWorkspacePath, skinnedMeshes: [{ name: 'Body', skeleton: { bones: [head, hips, spine] } }] })
    // The original42 adjacent producer does not emit source or skeletonContextId.
    const original42 = {
      schema: 'modly.unirig.rigmeta', output_mesh: 'foo_unirig.glb',
      semantic_candidates: {
        'rig:Body|skeleton:0|bone:Hips#0': { label: 'Pelvis' },
        'rig:Body|skeleton:0|bone:Hips#0/Spine#0': { display_name: 'Spine Control' },
      },
      humanoid_contract: { bones: { 'rig:Body|skeleton:0|bone:Hips#0/Head#0': { name: 'Head' } } },
    }
    for (const ownership of [{}, { source: { workspacePath: sourceWorkspacePath } }, { skeletonContextId: summary.skeletonContextId }, { source: { workspacePath: sourceWorkspacePath }, skeletonContextId: summary.skeletonContextId }]) {
      const metadata = { ...original42, ...ownership }
      const bytes = JSON.stringify(metadata)
      await fs.writeFile(join(workspaceDir, 'Workflows/foo_unirig.rigmeta.json'), bytes)
      const read = await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath })
      assert.equal(read.success && read.status, 'found')
      assert.ok(read.success && read.status === 'found')
      const options = { expectedSourceWorkspacePath: sourceWorkspacePath, expectedSkeletonContextId: summary.skeletonContextId }
      const normalized = normalizeRigMetaNaming(read.rigMeta, options)
      assert.equal(normalized.valid, true)
      assert.deepEqual(normalized.namingByBoneId, read.namingByBoneId)
      const display = resolveRigDisplayNames({ summary, rigMetaNamingByBoneId: { ...normalized.namingByBoneId, 'foreign-bone': { label: 'Foreign', source: 'semantic_candidates' } } })
      assert.deepEqual(display.ordered.map((entry) => entry.label), ['Pelvis', 'Spine Control', 'Head'])
      assert.deepEqual(display.ordered.map((entry) => entry.provenance), ['unirig', 'unirig', 'unirig'])
      assert.equal(display.byBoneId['foreign-bone'], undefined)
      assert.equal(normalizeRigMetaNaming(read.rigMeta, { expectedSourceWorkspacePath: sourceWorkspacePath }).valid, true)
      assert.equal(await fs.readFile(join(workspaceDir, 'Workflows/foo_unirig.rigmeta.json'), 'utf8'), bytes)
    }
    await fs.writeFile(join(workspaceDir, 'Workflows/foo_unirig.rigmeta.json'), JSON.stringify({ ...original42, source: { workspacePath: 'Workflows/other.glb' } }))
    assert.equal((await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath })).success, false)
    const contradictory = normalizeRigMetaNaming({ ...original42, skeletonContextId: 'foreign' }, { expectedSourceWorkspacePath: sourceWorkspacePath, expectedSkeletonContextId: summary.skeletonContextId })
    assert.equal(contradictory.valid, false); assert.deepEqual(contradictory.namingByBoneId, {})
    assert.deepEqual([hips.name, spine.name, head.name], ['Hips', 'Spine', 'Head'])
    assert.equal(await fs.readFile(join(workspaceDir, sourceWorkspacePath), 'utf8'), 'original source bytes')
  } finally { await fs.rm(workspaceDir, { recursive: true, force: true }) }
})

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

test('humanoid assignment resolution never rebinds through display labels or fallback positions', () => {
  const summary = createContextualRigSummary()
  summary.bones[0]!.label = 'Display Hips'
  summary.bones[1]!.originalName = ''
  summary.bones[1]!.label = 'Bone 2'
  const result = translateHumanoidAssignmentsToRigMetaNaming({ summary, sources: [{ source: 'humanoid_draft', roleMap: {
    hips: 'Display Hips', spine: 'Bone 2', head: { boneId: summary.bones[5]!.boneId, label: 'Head Control' },
  } }] })
  assert.deepEqual(result.namingByBoneId, { [summary.bones[5]!.boneId]: { label: 'Head Control', source: 'humanoid_draft' } })
  assert.equal(result.diagnostics.length, 2)
})

test('humanoid role collisions do not pick the last assignment or erase unrelated valid labels', () => {
  const summary = createContextualRigSummary()
  for (const roles of [
    { hips: 'bone_0', spine: { boneId: summary.bones[0]!.boneId }, head: 'bone_5' },
    { spine: { boneId: summary.bones[0]!.boneId }, hips: 'bone_0', head: 'bone_5' },
  ]) {
    const result = translateHumanoidAssignmentsToRigMetaNaming({ summary, sources: [{ source: 'humanoid_contract', roleMap: { roles } }] })
    assert.deepEqual(result.namingByBoneId, { [summary.bones[5]!.boneId]: { label: 'Head', source: 'humanoid_contract' } })
    assert.match(result.diagnostics.join('\n'), /multiple.*roles|roles.*same/i)
  }
  assert.deepEqual(createRigMetaNamingFromHumanoidAssignments({ hips: 'exact', spine: { boneId: 'exact' } }), {})
})

test('humanoid malformed assignments are diagnosed while supported string and object identifiers remain available', () => {
  const summary = createContextualRigSummary()
  const result = translateHumanoidAssignmentsToRigMetaNaming({ summary, sources: [{ source: 'humanoid_draft', roleMap: { roles: {
    hips: 'bone_0', head: { boneId: 'bone_5', label: 'Look Control' }, malformed: null, empty: {}, numeric: 0, array: ['bone_1'],
  } } }] })
  assert.deepEqual(result.namingByBoneId, {
    [summary.bones[0]!.boneId]: { label: 'Hips', source: 'humanoid_draft' },
    [summary.bones[5]!.boneId]: { label: 'Look Control', source: 'humanoid_draft' },
  })
  assert.equal(result.diagnostics.length, 4)
})

test('trusted contract naming takes precedence over a draft without requiring optional adjacent ownership fields', () => {
  const summary = createContextualRigSummary()
  const result = normalizeRigMetaNaming({
    humanoid_contract: createTrustedHumanoidContract({ hips: 'bone_0' }),
    humanoid_draft: { assignments: { roles: { draft_pelvis: 'bone_0', head: { boneId: 'bone_5', label: 'Look Control' } } } },
  }, { summary, expectedSourceWorkspacePath: summary.sourceWorkspacePath, expectedSkeletonContextId: summary.skeletonContextId })
  assert.equal(result.valid, true)
  assert.deepEqual(result.namingByBoneId, {
    [summary.bones[0]!.boneId]: { label: 'Hips', source: 'humanoid_contract' },
    [summary.bones[5]!.boneId]: { label: 'Look Control', source: 'humanoid_draft' },
  })
})
