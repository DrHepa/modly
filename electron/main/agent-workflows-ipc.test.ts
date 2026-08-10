import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { registerAgentWorkflowsIpcHandlers } from './agent-workflows-ipc.ts'

test('Agent workflow IPC registers only its dedicated create channel and forwards the exact argument', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const calls: unknown[] = []
  const expected = { ok: true, workflow: { id: 'workflow-id' } }
  registerAgentWorkflowsIpcHandlers({
    handle(channel, handler) { handlers.set(channel, handler) },
  }, {
    async create(value) {
      calls.push(value)
      return expected as never
    },
  })

  assert.deepEqual([...handlers.keys()], ['agentWorkflows:create'])
  assert.equal(handlers.has('workflows:save'), false)
  const request = { actionId: 'action-a', originSessionId: 'session-a', graph: { schema: 'modly.agent-workflow-graph', version: 1 } }
  assert.equal(await handlers.get('agentWorkflows:create')?.({ sender: 'not-forwarded' }, request), expected)
  assert.deepEqual(calls, [request])
})

test('Agent workflow IPC sanitizes unexpected authority failures', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerAgentWorkflowsIpcHandlers({
    handle(channel, handler) { handlers.set(channel, handler) },
  }, {
    async create() { throw new Error('private failure /home/user/workflows') },
  })

  const result = await handlers.get('agentWorkflows:create')?.({}, {})
  assert.deepEqual(result, { ok: false, error: { code: 'write_failed' } })
  assert.equal(JSON.stringify(result).includes('/home/user'), false)
})

test('main setup wires the dedicated Agent workflow authority without replacing generic workflow IPC', async () => {
  const source = await readFile(new URL('./ipc-handlers.ts', import.meta.url), 'utf8')
  assert.match(source, /new AgentWorkflowAuthority\(\{/)
  assert.match(source, /commitIfOriginSessionActive:[\s\S]*agentSessionStore\.commitIfActive/)
  assert.match(source, /validateWorkspaceSource:[\s\S]*validateAgentWorkspaceSource/)
  assert.doesNotMatch(source, /isOriginSessionActive:/)
  assert.match(source, /registerAgentWorkflowsIpcHandlers\(ipcMain, agentWorkflowAuthority\)/)
  assert.match(source, /ipcMain\.handle\('workflows:save'/)
})
