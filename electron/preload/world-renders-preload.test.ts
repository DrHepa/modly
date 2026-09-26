import assert from 'node:assert/strict'
import test from 'node:test'

import { WORLD_RENDER_CHANNELS } from '../../src/shared/types/worldRenders.ts'
import { createElectronApi } from './electron-api.ts'

const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const JOB_ID = 'render-0123456789abcdef0123456789abcdef'

test('preload exposes only five path-free render methods on the restricted Worlds surface', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    ipcRenderer: {
      invoke: async (channel, ...args) => { calls.push({ channel, args }); return { ok: false } },
      send: () => undefined,
      on: () => undefined,
      removeAllListeners: () => { throw new Error('render API must not use global listener cleanup') },
    },
    webFrame: { setZoomFactor: () => undefined },
  })
  const renders = api.workspace.worlds.renders
  assert.deepEqual(Object.keys(renders).sort(), ['cancel', 'create', 'delete', 'get', 'list'])
  const request = {
    projectKey: PROJECT_KEY,
    expectedRevision: 4,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
    preset: { width: 1920, height: 1080, fps: 30 as const },
  }
  await renders.create(request)
  await renders.list()
  await renders.get({ jobId: JOB_ID })
  await renders.cancel({ jobId: JOB_ID })
  await renders.delete({ jobId: JOB_ID })
  assert.deepEqual(calls, [
    { channel: WORLD_RENDER_CHANNELS.create, args: [request] },
    { channel: WORLD_RENDER_CHANNELS.list, args: [] },
    { channel: WORLD_RENDER_CHANNELS.get, args: [{ jobId: JOB_ID }] },
    { channel: WORLD_RENDER_CHANNELS.cancel, args: [{ jobId: JOB_ID }] },
    { channel: WORLD_RENDER_CHANNELS.delete, args: [{ jobId: JOB_ID }] },
  ])
  assert.equal(JSON.stringify(calls).includes('outputPath'), false)
  assert.equal(JSON.stringify(calls).includes('/tmp'), false)
})
