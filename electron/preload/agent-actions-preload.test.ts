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
  const modelLease = {
    originSessionId: 'session-a',
    model: { provider: 'ollama' as const, endpoint: 'http://localhost:11434', model: 'qwen3.6' },
  }
  const proposal = {
    originSessionId: 'session-a',
    capabilityId: 'cad-tools/generate',
    capabilityHash: 'a'.repeat(64),
    arguments: { input: 'chair', params: {} },
    modelLeaseId: 'lease-1',
  }
  await api.agentActions.leaseModel(modelLease)
  await api.agentActions.propose(proposal)
  await api.agentActions.get({ actionId: 'action-1', originSessionId: 'session-a' })
  await api.agentActions.list({ originSessionId: 'session-a' })
  await api.agentActions.decide({ actionId: 'action-1', originSessionId: 'session-a', decision: 'approve' })
  await api.agentActions.execute({ actionId: 'action-1', originSessionId: 'session-a' })
  await api.agentActions.cancel({ actionId: 'action-1', originSessionId: 'session-a' })

  assert.deepEqual(calls.map(({ channel }) => channel), [
    'agentActions:leaseModel',
    'agentActions:propose',
    'agentActions:get',
    'agentActions:list',
    'agentActions:decide',
    'agentActions:execute',
    'agentActions:cancel',
  ])
  assert.deepEqual(calls[0].args, [modelLease])
  assert.deepEqual(calls[1].args, [proposal])
  assert.deepEqual(calls[2].args, [{ actionId: 'action-1', originSessionId: 'session-a' }])
  assert.deepEqual(calls[3].args, [{ originSessionId: 'session-a' }])
  assert.deepEqual(calls[4].args, [{ actionId: 'action-1', originSessionId: 'session-a', decision: 'approve' }])
  assert.deepEqual(calls[5].args, [{ actionId: 'action-1', originSessionId: 'session-a' }])
  assert.deepEqual(calls[6].args, [{ actionId: 'action-1', originSessionId: 'session-a' }])
  assert.deepEqual(Object.keys(api.agentActions).sort(), ['cancel', 'decide', 'execute', 'get', 'leaseModel', 'list', 'propose'])
  assert.equal('runProcess' in api.agentActions, false)
  assert.equal('approveAndExecute' in api.agentActions, false)
})
