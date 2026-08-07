import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { registerAgentActionsIpcHandlers } from './agent-actions-ipc.ts'
import { AgentActionsServiceError, type AgentActionsServiceLike } from './agent-actions-service.ts'

test('Agent action IPC mints opaque session leases and validates every request before dispatch', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const calls: Array<{ operation: string, request: unknown }> = []
  const summary = { id: 'action-1', status: 'proposed' }
  const service: AgentActionsServiceLike = {
    async propose(request) { calls.push({ operation: 'propose', request }); return summary as never },
    async get(request) { calls.push({ operation: 'get', request }); return summary as never },
    async list(request) { calls.push({ operation: 'list', request }); return [summary] as never },
    async decide(request) { calls.push({ operation: 'decide', request }); return summary as never },
    async execute(request) { calls.push({ operation: 'execute', request }); throw new AgentActionsServiceError('executor_unavailable', new Error('/private/runner')) },
    async cancel(request) { calls.push({ operation: 'cancel', request }); return summary as never },
  }
  const resolvedModel = {
    provider: 'ollama' as const,
    endpoint: 'http://localhost:11434',
    model: 'qwen3.6:latest',
    digest: `sha256:${'a'.repeat(64)}`,
  }
  const modelSelections: unknown[] = []
  let now = Date.parse('2026-08-06T12:00:00.000Z')
  let currentDigest = resolvedModel.digest
  let nextLease = 0
  registerAgentActionsIpcHandlers({
    handle(channel, handler) { handlers.set(channel, handler) },
  }, service, {
    async resolveSelectedModel(selection) {
      modelSelections.push(selection)
      return { ...resolvedModel, digest: currentDigest }
    },
    now: () => new Date(now),
    createModelLeaseId: () => `model-lease-${++nextLease}`,
    modelLeaseTtlMs: 1_000,
    maxProposalsPerModelLease: 2,
  })

  assert.deepEqual([...handlers.keys()].sort(), [
    'agentActions:cancel',
    'agentActions:decide',
    'agentActions:execute',
    'agentActions:get',
    'agentActions:leaseModel',
    'agentActions:list',
    'agentActions:propose',
  ])
  assert.equal(handlers.has('extensions:runProcess'), false)

  const model = { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'qwen3.6:latest' }
  const leased = await handlers.get('agentActions:leaseModel')?.({}, {
    originSessionId: 'session-a', model,
  })
  assert.deepEqual(leased, {
    ok: true,
    lease: { id: 'model-lease-1', expiresAt: '2026-08-06T12:00:01.000Z' },
  })
  assert.equal(JSON.stringify(leased).includes('digest'), false)
  assert.equal(JSON.stringify(leased).includes('endpoint'), false)
  assert.deepEqual(await handlers.get('agentActions:leaseModel')?.({}, {
    originSessionId: 'session-a',
    model: { ...model, digest: resolvedModel.digest },
  }), { ok: false, error: { code: 'invalid_request' } })

  const proposal = {
    originSessionId: 'session-a',
    capabilityId: 'cad-tools/generate',
    capabilityHash: 'b'.repeat(64),
    arguments: { input: 'chair', params: {} },
    modelLeaseId: 'model-lease-1',
  }
  assert.deepEqual(await handlers.get('agentActions:propose')?.({}, proposal), { ok: true, action: summary })
  assert.deepEqual(modelSelections, [model])
  assert.deepEqual(calls[0], {
    operation: 'propose',
    request: {
      originSessionId: proposal.originSessionId,
      capabilityId: proposal.capabilityId,
      capabilityHash: proposal.capabilityHash,
      arguments: proposal.arguments,
      model: resolvedModel,
    },
  })
  assert.deepEqual(await handlers.get('agentActions:get')?.({}, { actionId: 'action-1', originSessionId: 'session-a' }), { ok: true, action: summary })
  assert.deepEqual(await handlers.get('agentActions:list')?.({}, { originSessionId: 'session-a' }), { ok: true, actions: [summary] })
  assert.deepEqual(await handlers.get('agentActions:decide')?.({}, { actionId: 'action-1', originSessionId: 'session-a', decision: 'approve' }), { ok: true, action: summary })
  const failed = await handlers.get('agentActions:execute')?.({}, { actionId: 'action-1', originSessionId: 'session-a' })
  assert.deepEqual(failed, { ok: false, error: { code: 'executor_unavailable' } })
  assert.equal(JSON.stringify(failed).includes('/private/runner'), false)
  assert.deepEqual(await handlers.get('agentActions:cancel')?.({}, { actionId: 'action-1', originSessionId: 'session-a' }), { ok: true, action: summary })
  assert.deepEqual(calls.map(({ operation }) => operation), ['propose', 'get', 'list', 'decide', 'execute', 'cancel'])

  for (const [channel, invalid] of [
    ['agentActions:get', { actionId: 'action-1' }],
    ['agentActions:decide', { actionId: 'action-1', decision: 'reject' }],
    ['agentActions:execute', { actionId: 'action-1', originSessionId: 'session-a', extra: true }],
    ['agentActions:cancel', { actionId: 'action-1' }],
  ] as const) {
    assert.deepEqual(await handlers.get(channel)?.({}, invalid), { ok: false, error: { code: 'invalid_request' } })
  }
  assert.equal(calls.length, 6)

  assert.deepEqual(await handlers.get('agentActions:propose')?.({}, {
    ...proposal, originSessionId: 'session-b',
  }), { ok: false, error: { code: 'model_stale' } })
  assert.equal(calls.length, 6)
  assert.deepEqual(await handlers.get('agentActions:propose')?.({}, {
    ...proposal, model,
  }), { ok: false, error: { code: 'invalid_request' } })
  assert.equal(calls.length, 6)

  assert.deepEqual(await handlers.get('agentActions:propose')?.({}, {
    ...proposal, arguments: { input: 'table', params: {} },
  }), { ok: true, action: summary })
  assert.deepEqual(await handlers.get('agentActions:propose')?.({}, proposal), {
    ok: false, error: { code: 'capacity_exceeded' },
  })

  const expiring = await handlers.get('agentActions:leaseModel')?.({}, { originSessionId: 'session-a', model }) as { lease: { id: string } }
  now += 1_001
  assert.deepEqual(await handlers.get('agentActions:propose')?.({}, {
    ...proposal, modelLeaseId: expiring.lease.id,
  }), { ok: false, error: { code: 'model_stale' } })

  const drifting = await handlers.get('agentActions:leaseModel')?.({}, { originSessionId: 'session-a', model }) as { lease: { id: string } }
  currentDigest = `sha256:${'c'.repeat(64)}`
  assert.deepEqual(await handlers.get('agentActions:propose')?.({}, {
    ...proposal, modelLeaseId: drifting.lease.id,
  }), { ok: true, action: summary })
  assert.equal((calls.at(-1)?.request as { model: { digest: string } }).model.digest, resolvedModel.digest)
  assert.deepEqual(modelSelections, [model, model, model])
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

test('authoritative Ollama model lookup refuses redirects at the HTTP client boundary', async () => {
  const source = await readFile(new URL('./ipc-handlers.ts', import.meta.url), 'utf8')
  assert.match(source, /axios\.get\([^)]*\/api\/tags[^}]*maxRedirects:\s*0/s)
})
