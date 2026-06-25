import assert from 'node:assert/strict'
import test from 'node:test'

import { attachWorldSceneItemAnimation, resolveWorldSceneItemForPoseClip } from './worldsScenePlacement.ts'
import type { WorldSceneItem } from './worldRenderableResolver.ts'

function item(id: string, workspacePath = 'Workflows/hero.glb'): WorldSceneItem {
  return {
    id,
    workspacePath,
    url: `/workspace/${workspacePath}`,
    kind: workspacePath.endsWith('.gltf') ? 'gltf' : 'glb',
    role: 'asset',
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }
}

test('resolveWorldSceneItemForPoseClip prefers the selected matching linked source, otherwise first match', () => {
  const items = [item('first'), item('selected'), item('other', 'Workflows/other.glb')]

  assert.equal(resolveWorldSceneItemForPoseClip(items, 'Workflows/hero.glb', 'selected')?.id, 'selected')
  assert.equal(resolveWorldSceneItemForPoseClip(items, 'Workflows/hero.glb', null)?.id, 'first')
  assert.equal(resolveWorldSceneItemForPoseClip(items, 'Workflows/missing.glb', 'selected'), null)
})

test('attachWorldSceneItemAnimation attaches serializable pose-clip binding without mutating source items', () => {
  const original = item('hero')
  const animation = { kind: 'pose-clip' as const, sidecarWorkspacePath: 'Motions/walk.json', sourceWorkspacePath: 'Workflows/hero.glb' }
  const result = attachWorldSceneItemAnimation([original], 'hero', animation)

  assert.equal(original.animation, undefined)
  assert.deepEqual(result[0].animation, animation)
})
