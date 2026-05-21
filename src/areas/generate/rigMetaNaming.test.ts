import assert from 'node:assert/strict'
import test from 'node:test'

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

  assert.deepEqual(partialResult.namingByBoneId, {
    'bone:spine': { label: 'Spine', source: 'semantic_candidates' },
  })
  assert.equal(partialResult.valid, true)
  assert.match(partialResult.warnings.join('\n'), /unsupported/i)
  assert.match(partialResult.warnings.join('\n'), /source mismatch/i)
  assert.match(partialResult.warnings.join('\n'), /partial/i)
})
