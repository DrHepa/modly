import assert from 'node:assert/strict'
import test from 'node:test'

import { createElectronApi } from './electron-api.ts'

test('preload exposes only exact narrow Agent capability inventory and skill-context discovery', async () => {
  const calls: Array<{ channel: string, args: unknown[] }> = []
  const expected = { capabilities: [], errors: [] }
  const skillExpected = { resolutionHash: 'c'.repeat(64), contexts: [] }
  const api = createElectronApi({
    webFrame: { setZoomFactor() {} },
    ipcRenderer: {
      send() {}, on() {}, removeAllListeners() {},
      async invoke(channel: string, ...args: unknown[]) {
        calls.push({ channel, args })
        return channel === 'agentCapabilities:resolveSkillContexts' ? skillExpected : expected
      },
    },
  })

  assert.deepEqual(await api.agentCapabilities.list(), expected)
  const request = {
    originSessionId: 'session-a', userText: 'Create CAD geometry',
    capabilities: [{ id: 'cad/plan', hash: 'a'.repeat(64), skillsHash: 'b'.repeat(64) }],
  }
  assert.deepEqual(await api.agentCapabilities.resolveSkillContexts(request), skillExpected)
  assert.deepEqual(calls, [
    { channel: 'agentCapabilities:list', args: [] },
    { channel: 'agentCapabilities:resolveSkillContexts', args: [request] },
  ])
  assert.equal('run' in api.agentCapabilities, false)
  assert.equal('execute' in api.agentCapabilities, false)
})
