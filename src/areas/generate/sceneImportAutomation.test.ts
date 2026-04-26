import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationJob } from '@shared/stores/appStore'
import { buildSceneImportGenerationJob } from './sceneImportAutomation.ts'

test('buildSceneImportGenerationJob creates a done job and preserves display payload', () => {
  const now = 1777161040844
  const job = buildSceneImportGenerationJob({
    meshPath: 'Default/imported.glb',
    url: '/workspace/Default/imported.glb',
    displayName: 'imported.glb',
  }, now)

  assert.deepEqual(job satisfies GenerationJob, {
    id: 'import-1777161040844',
    imageFile: '',
    status: 'done',
    progress: 100,
    outputUrl: '/workspace/Default/imported.glb',
    originalOutputUrl: '/workspace/Default/imported.glb',
    createdAt: now,
  })
})
