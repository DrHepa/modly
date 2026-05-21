import assert from 'node:assert/strict'
import test from 'node:test'
import type { RigMetaSidecarReadResult } from '../../shared/types/electron.d.ts'

import {
  createRigMetaWorkspacePath,
  normalizeRigMetaNaming,
  type RigMetaNamingMap,
} from './rigMetaNaming.ts'

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
