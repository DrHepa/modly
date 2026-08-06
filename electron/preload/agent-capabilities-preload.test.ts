import assert from 'node:assert/strict'
import test from 'node:test'

import { createElectronApi } from './electron-api.ts'

test('preload exposes only narrow Agent capability inventory discovery', async () => {
  const calls: Array<{ channel: string, args: unknown[] }> = []
  const expected = { capabilities: [], errors: [] }
  const api = createElectronApi({
    webFrame: { setZoomFactor() {} },
    ipcRenderer: {
      send() {}, on() {}, removeAllListeners() {},
      async invoke(channel: string, ...args: unknown[]) {
        calls.push({ channel, args })
        return expected
      },
    },
  })

  assert.deepEqual(await api.agentCapabilities.list(), expected)
  assert.deepEqual(calls, [{ channel: 'agentCapabilities:list', args: [] }])
  assert.equal('run' in api.agentCapabilities, false)
  assert.equal('execute' in api.agentCapabilities, false)
})
