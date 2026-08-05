import assert from 'node:assert/strict'
import test from 'node:test'

import { createElectronApi } from './electron-api.ts'

test('preload exposes narrow agent session methods without path-bearing attachment APIs', async () => {
  const calls: Array<{ channel: string, args: unknown[] }> = []
  const api = createElectronApi({
    webFrame: { setZoomFactor() {} },
    ipcRenderer: {
      send() {}, on() {}, removeAllListeners() {},
      async invoke(channel: string, ...args: unknown[]) { calls.push({ channel, args }); return { ok: true } },
    },
  })
  const request = { sessionId: 's1', attachmentId: 'a1' }
  await api.agentSessions.readAttachment(request)
  await api.agentSessions.removeAttachment({ ...request, expectedRevision: 3 })
  assert.deepEqual(calls, [
    { channel: 'agentSessions:readAttachment', args: [request] },
    { channel: 'agentSessions:removeAttachment', args: [{ ...request, expectedRevision: 3 }] },
  ])
  assert.equal('getAttachmentPath' in api.agentSessions, false)
})
