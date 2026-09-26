import assert from 'node:assert/strict'
import test from 'node:test'

import { createLegacyWorldsCommandBridge } from './legacyWorldsCommandBridge.ts'

test('legacy compatibility bridge owns append/replace mutation and marks legacy results', async () => {
  const calls: unknown[] = []
  const bridge = createLegacyWorldsCommandBridge({
    getState: () => ({ sceneItems: [], collisionSurfaces: [], sceneItemAnchors: {}, selectedSceneItemId: null }),
    setScene: (value) => { calls.push(value) },
  })
  const appended = await bridge.appendRenderable({
    id: 'world:asset', workspacePath: 'Assets/a.glb', url: '/workspace/Assets/a.glb', kind: 'glb', role: 'asset', visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  })
  assert.deepEqual(appended, { accepted: true, mode: 'legacy' })
  assert.equal(calls.length, 1)
  const replaced = await bridge.replaceScene({
    sceneItems: [], collisionSurfaces: [], initialView: null,
  })
  assert.deepEqual(replaced, { accepted: true, mode: 'legacy' })
  assert.equal(calls.length, 2)
})
