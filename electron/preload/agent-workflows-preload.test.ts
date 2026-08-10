import assert from 'node:assert/strict'
import test from 'node:test'

import { createElectronApi } from './electron-api.ts'
import type { AgentWorkflowCreateRequest } from '../../src/shared/types/agentWorkflows.ts'

test('preload exposes only the narrow Agent workflow create IPC with the exact channel and argument', async () => {
  const invocations: Array<{ channel: string, args: unknown[] }> = []
  const response = { ok: false, error: { code: 'origin_inactive' } } as const
  const api = createElectronApi({
    ipcRenderer: {
      send() {}, on() {}, removeAllListeners() {},
      async invoke(channel, ...args) {
        invocations.push({ channel, args })
        return response
      },
    },
    webFrame: { setZoomFactor() {} },
  })
  const request = {
    actionId: 'action-a',
    originSessionId: 'session-a',
    graph: {
      schema: 'modly.agent-workflow-graph',
      version: 1,
      name: 'Workflow',
      description: '',
      nodes: [],
      edges: [],
    },
  } satisfies AgentWorkflowCreateRequest

  assert.equal(await api.agentWorkflows.create(request), response)
  assert.deepEqual(invocations, [{ channel: 'agentWorkflows:create', args: [request] }])
  assert.deepEqual(Object.keys(api.agentWorkflows), ['create'])
  assert.equal('save' in api.agentWorkflows, false)
})
