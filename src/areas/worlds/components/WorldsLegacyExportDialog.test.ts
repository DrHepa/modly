import assert from 'node:assert/strict'
import test from 'node:test'

import type { LegacyWorldsExportAnalysis } from '../core/legacySceneManifestAdapter.ts'
import {
  createLegacyExportPlan,
  groupLegacyExportLosses,
} from './worldsLegacyExportModel.ts'

const analysis: LegacyWorldsExportAnalysis = {
  valid: true,
  sceneId: 'scene:one',
  issues: [],
  losses: [
    { id: 'loss:a', code: 'light', path: 'scenes[0].entities[0]', message: 'Light is omitted.' },
    { id: 'loss:b', code: 'audio', path: 'scenes[0].entities[1]', message: 'Audio is omitted.' },
    { id: 'loss:c', code: 'light', path: 'scenes[0].entities[2]', message: 'Second light is omitted.' },
  ],
}

test('legacy export groups exact losses and remains disabled until every displayed loss id is accepted', () => {
  assert.deepEqual(groupLegacyExportLosses(analysis.losses).map((group) => [group.code, group.losses.map((loss) => loss.id)]), [
    ['light', ['loss:a', 'loss:c']],
    ['audio', ['loss:b']],
  ])
  assert.equal(createLegacyExportPlan(analysis, new Set(['loss:a', 'loss:b'])), null)
  assert.deepEqual(createLegacyExportPlan(analysis, new Set(['loss:a', 'loss:b', 'loss:c'])), {
    sceneId: 'scene:one', acceptedLosses: ['loss:a', 'loss:b', 'loss:c'],
  })
})

test('legacy export reject produces no write plan', () => {
  assert.equal(createLegacyExportPlan(analysis, new Set(), { rejected: true }), null)
})
