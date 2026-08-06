import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { registerAgentActionsIpcHandlers } from './agent-actions-ipc.ts'
import { AgentActionsServiceError, type AgentActionsServiceLike } from './agent-actions-service.ts'

test('Agent action IPC registers only narrow action-id operations and maps internal failures to stable codes', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const calls: Array<{ operation: string, request: unknown }> = []
  const summary = { id: 'action-1', status: 'proposed' }
  const service: AgentActionsServiceLike = {
    async propose(request) { calls.push({ operation: 'propose', request }); return summary as never },
    async get(request) { calls.push({ operation: 'get', request }); return summary as never },
    async list() { calls.push({ operation: 'list', request: undefined }); return [summary] as never },
    async decide(request) { calls.push({ operation: 'decide', request }); return summary as never },
    async execute(request) { calls.push({ operation: 'execute', request }); throw new AgentActionsServiceError('executor_unavailable', new Error('/private/runner')) },
    async cancel(request) { calls.push({ operation: 'cancel', request }); return summary as never },
  }
  registerAgentActionsIpcHandlers({
    handle(channel, handler) { handlers.set(channel, handler) },
  }, service)

  assert.deepEqual([...handlers.keys()].sort(), [
    'agentActions:cancel',
    'agentActions:decide',
    'agentActions:execute',
    'agentActions:get',
    'agentActions:list',
    'agentActions:propose',
  ])
  assert.equal(handlers.has('extensions:runProcess'), false)

  const proposal = { capabilityId: 'cad-tools/generate', arguments: { input: 'chair', params: {} }, model: {} }
  assert.deepEqual(await handlers.get('agentActions:propose')?.({}, proposal), { ok: true, action: summary })
  assert.deepEqual(await handlers.get('agentActions:decide')?.({}, { actionId: 'action-1', decision: 'approve' }), { ok: true, action: summary })
  const failed = await handlers.get('agentActions:execute')?.({}, { actionId: 'action-1' })
  assert.deepEqual(failed, { ok: false, error: { code: 'executor_unavailable' } })
  assert.equal(JSON.stringify(failed).includes('/private/runner'), false)
  assert.deepEqual(calls.map(({ operation }) => operation), ['propose', 'decide', 'execute'])
})

test('governed Agent action modules are statically isolated from the legacy user-driven process runner', async () => {
  const sources = await Promise.all([
    readFile(new URL('./agent-actions-service.ts', import.meta.url), 'utf8'),
    readFile(new URL('./agent-actions-ipc.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/areas/generate/components/ChatPanel.tsx', import.meta.url), 'utf8'),
  ])
  for (const source of sources) {
    assert.doesNotMatch(source, /extensions:runProcess|invokeExtensionsRunProcess|runProcessExtensionWithDeps/)
  }
})
