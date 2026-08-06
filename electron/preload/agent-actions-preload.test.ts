import assert from 'node:assert/strict'
import test from 'node:test'

import { createElectronApi } from './electron-api.ts'

test('preload exposes only the narrow governed Agent action surface', async () => {
  const calls: Array<{ channel: string, args: unknown[] }> = []
  const api = createElectronApi({
    webFrame: { setZoomFactor() {} },
    ipcRenderer: {
      send() {}, on() {}, removeAllListeners() {},
      async invoke(channel: string, ...args: unknown[]) {
        calls.push({ channel, args })
        return { ok: true }
      },
    },
  })
  const proposal = { capabilityId: 'cad-tools/generate', arguments: { input: 'chair', params: {} }, model: { provider: 'ollama' as const, endpoint: 'http://localhost:11434', model: 'qwen3.6', digest: `sha256:${'a'.repeat(64)}` } }
  await api.agentActions.propose(proposal)
  await api.agentActions.get({ actionId: 'action-1' })
  await api.agentActions.list()
  await api.agentActions.decide({ actionId: 'action-1', decision: 'approve' })
  await api.agentActions.execute({ actionId: 'action-1' })
  await api.agentActions.cancel({ actionId: 'action-1' })

  assert.deepEqual(calls.map(({ channel }) => channel), [
    'agentActions:propose',
    'agentActions:get',
    'agentActions:list',
    'agentActions:decide',
    'agentActions:execute',
    'agentActions:cancel',
  ])
  assert.deepEqual(Object.keys(api.agentActions).sort(), ['cancel', 'decide', 'execute', 'get', 'list', 'propose'])
  assert.equal('runProcess' in api.agentActions, false)
  assert.equal('approveAndExecute' in api.agentActions, false)
})
