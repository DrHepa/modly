import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const chatPanelEntry = path.join(projectRoot, 'src/areas/generate/components/ChatPanel.tsx')

function aliasPlugin(): Plugin {
  const resolvePath = (basePath: string): string => {
    if (existsSync(basePath) && statSync(basePath).isFile()) return basePath
    for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
      const candidate = `${basePath}${extension}`
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    return basePath
  }

  return {
    name: 'modly-aliases',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src/shared', args.path.slice('@shared/'.length))),
      }))
      buildApi.onResolve({ filter: /^@areas\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src/areas', args.path.slice('@areas/'.length))),
      }))
    },
  }
}

function localStorageMock(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear() { values.clear() },
    getItem(key) { return values.get(key) ?? null },
    key(index) { return [...values.keys()][index] ?? null },
    removeItem(key) { values.delete(key) },
    setItem(key, value) { values.set(key, value) },
  }
}

async function loadChatPanelModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-chat-panel-'))
  const outfile = path.join(tempDir, 'ChatPanel.bundle.mjs')
  const previousLocalStorage = globalThis.localStorage
  globalThis.localStorage = localStorageMock()

  try {
    await build({
      entryPoints: [chatPanelEntry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [aliasPlugin()],
    })
    const module = await import(pathToFileURL(outfile).href)
    return {
      module,
      async cleanup() {
        if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
        else globalThis.localStorage = previousLocalStorage
        await rm(tempDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else globalThis.localStorage = previousLocalStorage
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

test('structured agent failures expose safe copy and completed actions', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const partialAction = {
      tool: 'smooth_mesh',
      result: 'Smoothed mesh.',
      payload: {
        type: 'mesh_operation',
        actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        operation: 'smooth',
        assetRef: '/workspace/smoothed.glb',
        iterations: 1,
      },
    }
    const response = {
      ok: false,
      status: 504,
      json: async () => ({
        detail: {
          code: 'ollama_timeout',
          message: 'Ollama stopped sending data. Try again.',
          retryable: true,
          round: 2,
          actions: [partialAction],
        },
      }),
    }

    await assert.rejects(module.parseAgentChatResponse(response), (error: unknown) => {
      assert.ok(error instanceof module.AgentApiError)
      const agentError = error as Error & { actions: unknown[] }
      assert.equal(agentError.message, 'Ollama stopped sending data. Try again.')
      assert.deepEqual(agentError.actions, [partialAction])
      return true
    })
  } finally {
    await cleanup()
  }
})

test('action application attempts every returned action exactly once after a handler rejection', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const actions = [
      { tool: 'list_models', result: 'first', payload: null },
      { tool: 'smooth_mesh', result: 'second', payload: { type: 'mesh_update', url: '/second.glb' } },
      { tool: 'list_processes', result: 'third', payload: null },
    ]
    const attempts = new Map<string, number>()
    const failures = await module.applyAgentActions(actions, async (action: { tool: string }) => {
      attempts.set(action.tool, (attempts.get(action.tool) ?? 0) + 1)
      if (action.tool === 'smooth_mesh') throw new Error('local reflection failed')
    })

    assert.deepEqual(Object.fromEntries(attempts), {
      list_models: 1,
      smooth_mesh: 1,
      list_processes: 1,
    })
    assert.equal(failures.length, 1)
    assert.equal(failures[0].action.tool, 'smooth_mesh')
    assert.equal(
      module.withActionFailureSummary('Original server error.', failures.length),
      'Original server error. 1 action could not be applied locally.',
    )
  } finally {
    await cleanup()
  }
})

test('legacy Agent mutation payloads fail closed at the response boundary', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const actions = [
      { tool: 'smooth_mesh', result: 'mesh', payload: { type: 'mesh_update', url: '/workspace/mesh.glb' } },
      { tool: 'run_workflow', result: 'run', payload: { type: 'run_workflow', workflow_id: 'wf-1', workflow_name: 'Workflow' } },
      {
        tool: 'create_workflow',
        result: 'create',
        payload: {
          type: 'create_workflow',
          workflow: { name: 'Draft', description: 'Draft workflow', nodes: [], edges: [] },
        },
      },
    ]

    for (const action of actions) {
      await assert.rejects(module.parseAgentChatResponse({
        ok: true,
        status: 200,
        json: async () => ({ message: 'Unsafe legacy action.', actions: [action] }),
      }), /invalid agent response/i)
    }
  } finally {
    await cleanup()
  }
})

test('ChatPanel captures immutable request origin and routes success/error actions through one runtime once-registry', async () => {
  const source = await readFile(chatPanelEntry, 'utf8')
  assert.match(source, /const uiToken = originUiGateRef\.current\.begin\(originatingSessionId\)/)
  assert.match(source, /applyCompletedActions\(data\.actions, originatingSessionId, uiToken, msgs\)/)
  assert.match(source, /applyCompletedActions\(e\.actions, originatingSessionId, uiToken, msgs\)/)
  assert.match(source, /appliedIds: appliedDirectActionIdsRef\.current/)
  assert.equal(source.match(/applyAgentResponseActions\(/g)?.length, 1)
  assert.equal(source.match(/appliedIds: appliedDirectActionIdsRef\.current/g)?.length, 1)
  assert.match(source, /createWorkflow: \(request\) => window\.electron\.agentWorkflows\.create\(request\)/)

  const actionAdapter = source.slice(
    source.indexOf('async function applyCompletedActions'),
    source.indexOf('async function callAgent'),
  )
  assert.doesNotMatch(actionAdapter, /callAgent\(/)
})

test('ChatPanel wires capability discovery and governed proposals without automatic execution', async () => {
  const source = await readFile(chatPanelEntry, 'utf8')
  assert.match(source, /window\.electron\.agentCapabilities\.list\(\)/)
  assert.match(source, /proposeGovernedAgentActions\(\{[\s\S]*\n\s*proposals,/)
  assert.match(source, /JSON\.stringify\(\{[\s\S]*capabilities[\s\S]*\}\)/)
  assert.match(source, /<GovernedActionCard/)
  assert.equal(source.includes('approveAndExecute'), false)
})

test('chat response parses bounded governed proposals separately from completed read actions', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const response = await module.parseAgentChatResponse({
      ok: true,
      status: 200,
      json: async () => ({
        message: 'Approval is required.',
        actions: [{ tool: 'list_models', result: '{}', payload: null }],
        proposals: [{
          type: 'action_proposal',
          capabilityId: 'text-to-cad/generate',
          capabilityHash: 'a'.repeat(64),
          modelLeaseId: 'lease-1',
          arguments: { input: 'chair', params: { quality: 'balanced' } },
        }],
      }),
    })
    assert.equal(response.actions.length, 1)
    assert.deepEqual(response.proposals, [{
      type: 'action_proposal',
      capabilityId: 'text-to-cad/generate',
      capabilityHash: 'a'.repeat(64),
      modelLeaseId: 'lease-1',
      arguments: { input: 'chair', params: { quality: 'balanced' } },
    }])

    await assert.rejects(module.parseAgentChatResponse({
      ok: true,
      status: 200,
      json: async () => ({
        message: 'bad', actions: [],
        proposals: [{
          type: 'action_proposal', capabilityId: '__proto__/run', capabilityHash: 'a'.repeat(64),
          modelLeaseId: 'lease-1', arguments: {},
        }],
      }),
    }), /invalid agent response/i)
  } finally {
    await cleanup()
  }
})

test('capability prompt inventory is deterministic, bounded, and contains only safe hints', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const snapshot = {
      schema: 'modly.agent-capability.v1', version: 1,
      id: 'text-to-cad/generate', displayName: 'Text to CAD', description: 'Generate CAD.',
      extension: { id: 'text-to-cad', name: 'Text to CAD' },
      node: {
        id: 'generate', input: 'text', output: 'mesh',
        paramsSchema: [{ id: 'quality', label: 'Quality', type: 'select', default: 'balanced', options: [{ value: 'balanced', label: 'Balanced' }] }],
      },
      approval: { required: true, scope: 'single_action' },
      hash: 'a'.repeat(64),
    }
    assert.deepEqual(module.buildAgentCapabilityPromptInventory({ capabilities: [snapshot], errors: [] }), [{
      id: 'text-to-cad/generate', hash: 'a'.repeat(64), name: 'Text to CAD', description: 'Generate CAD.',
      inputHints: [
        { path: 'input', type: 'text', required: true, description: 'Text input' },
        { path: 'params.quality', type: 'select', required: false, description: 'Quality', options: ['balanced'] },
      ],
    }])
    assert.throws(() => module.buildAgentCapabilityPromptInventory({ capabilities: [snapshot, snapshot], errors: [] }), /collision/i)
  } finally {
    await cleanup()
  }
})

test('proposal handoff sends only the immutable session, capability hash, raw args, and opaque model lease', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const calls: unknown[] = []
    const result = await module.proposeGovernedAgentActions({
      proposals: [{
        type: 'action_proposal', capabilityId: 'text-to-cad/generate', capabilityHash: 'a'.repeat(64),
        modelLeaseId: 'lease-1', arguments: { input: 'chair', params: {} },
      }],
      originSessionId: 'session-a',
      modelLeaseId: 'lease-1',
      isCurrent: () => true,
      propose: async (request: unknown) => {
        calls.push(request)
        return { ok: true, action: { id: 'action-1', status: 'proposed' } }
      },
    })
    assert.deepEqual(calls, [{
      originSessionId: 'session-a', capabilityId: 'text-to-cad/generate',
      capabilityHash: 'a'.repeat(64), modelLeaseId: 'lease-1',
      arguments: { input: 'chair', params: {} },
    }])
    for (const forbidden of ['digest', 'endpoint', 'qwen3.6']) {
      assert.equal(JSON.stringify(calls).includes(forbidden), false, forbidden)
    }
    assert.equal(result.actions.length, 1)
    assert.deepEqual(result.errors, [])

    const stale = await module.proposeGovernedAgentActions({
      proposals: [{
        type: 'action_proposal', capabilityId: 'text-to-cad/generate', capabilityHash: 'a'.repeat(64),
        modelLeaseId: 'lease-1', arguments: {},
      }],
      originSessionId: 'session-a',
      modelLeaseId: 'lease-1',
      isCurrent: () => true,
      propose: async () => ({ ok: false, error: { code: 'model_stale' } }),
    })
    assert.deepEqual(stale.errors, [{ code: 'model_stale', message: 'The selected Ollama model changed or its digest is unavailable. Select the model again.' }])

    const mismatchedLease = await module.proposeGovernedAgentActions({
      proposals: [{
        type: 'action_proposal', capabilityId: 'text-to-cad/generate', capabilityHash: 'a'.repeat(64),
        modelLeaseId: 'lease-other', arguments: {},
      }],
      originSessionId: 'session-a',
      modelLeaseId: 'lease-1',
      isCurrent: () => true,
      propose: async () => { throw new Error('must not run') },
    })
    assert.equal(mismatchedLease.actions.length, 0)
    assert.equal(mismatchedLease.errors[0].code, 'model_stale')
  } finally {
    await cleanup()
  }
})

test('a deferred proposal is compensated exactly once after its origin session switches', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const tracker = module.createGovernedProposalTracker()
    let resolveProposal!: (result: unknown) => void
    const compensationIds: string[] = []
    const acceptedIds: string[] = []
    let current = true
    const pending = module.proposeGovernedAgentActions({
      proposals: [{
        type: 'action_proposal', capabilityId: 'text-to-cad/generate', capabilityHash: 'a'.repeat(64),
        modelLeaseId: 'lease-1', arguments: { input: 'chair' },
      }],
      originSessionId: 'session-a',
      modelLeaseId: 'lease-1',
      isCurrent: () => current,
      tracker,
      acceptAction: (action: { id: string }) => { acceptedIds.push(action.id); return true },
      compensate: async (action: { id: string }) => { compensationIds.push(action.id); return null },
      propose: () => new Promise((resolve) => { resolveProposal = resolve }),
    })

    current = false
    tracker.invalidateOrigin('session-a')
    resolveProposal({ ok: true, action: { id: 'late-action', status: 'proposed' } })
    const result = await pending
    assert.deepEqual(acceptedIds, [])
    assert.deepEqual(result.actions, [])
    assert.deepEqual(compensationIds, ['late-action'])
  } finally {
    await cleanup()
  }
})

test('unmount invalidation compensates a late proposal and tracker resolution is idempotent', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const tracker = module.createGovernedProposalTracker()
    const lease = tracker.track('session-a', () => true)
    tracker.invalidateAll()
    let compensations = 0
    const action = { id: 'late-unmount-action', status: 'proposed' }
    const first = await lease.resolve(action, () => true, async () => { compensations += 1; return null })
    const second = await lease.resolve(action, () => true, async () => { compensations += 1; return null })
    assert.equal(first.kind, 'compensated')
    assert.equal(second.kind, 'ignored')
    assert.equal(compensations, 1)
    assert.equal(tracker.size(), 0)
  } finally {
    await cleanup()
  }
})

test('late proposal compensation skips persistence after origin deletion and can reject a still-proposed action', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const persisted: string[] = []
    const decisions: unknown[] = []
    const cancellations: unknown[] = []
    const result = await module.compensateLateGovernedProposal({
      action: { id: 'deleted-origin-action', status: 'proposed' },
      originSessionId: 'deleted-session',
      sessionExists: () => false,
      isOriginActive: () => false,
      cancel: async (request: unknown) => {
        cancellations.push(request)
        return { ok: false, error: { code: 'invalid_state' } }
      },
      get: async () => ({ ok: true, action: { id: 'deleted-origin-action', status: 'proposed' } }),
      list: async () => { throw new Error('terminal rejection must not poll') },
      reject: async (request: unknown) => {
        decisions.push(request)
        return { ok: true, action: { id: 'deleted-origin-action', status: 'rejected' } }
      },
      persistTerminal: async (action: { id: string }) => { persisted.push(action.id) },
      reportError: () => { throw new Error('deleted origin must not receive UI errors') },
    })
    assert.equal(result.kind, 'terminal')
    assert.deepEqual(cancellations, [{ actionId: 'deleted-origin-action', originSessionId: 'deleted-session' }])
    assert.deepEqual(decisions, [{
      actionId: 'deleted-origin-action', originSessionId: 'deleted-session', decision: 'reject',
    }])
    assert.deepEqual(persisted, [])
  } finally {
    await cleanup()
  }
})

test('pending compensation keeps no UI authority, persists no terminal state, and reports only to an active origin', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const persisted: string[] = []
    const errors: string[] = []
    let originActive = false
    let reconcileNowMs = 0
    const input = {
      action: { id: 'pending-action', status: 'proposed' },
      originSessionId: 'session-a',
      sessionExists: () => true,
      isOriginActive: () => originActive,
      cancel: async () => ({ ok: false, error: { code: 'cancellation_pending' } }),
      get: async () => ({ ok: true, action: { id: 'pending-action', status: 'executing' } }),
      list: async () => ({ ok: true, actions: [{ id: 'pending-action', status: 'executing' }] }),
      reject: async () => { throw new Error('executing actions cannot be rejected') },
      reconcileWait: async (milliseconds: number) => { reconcileNowMs += milliseconds },
      reconcileNow: () => reconcileNowMs,
      reconcileHardTimeoutMs: 1,
      persistTerminal: async (action: { id: string }) => { persisted.push(action.id) },
      reportError: (message: string) => { errors.push(message) },
    }
    assert.equal((await module.compensateLateGovernedProposal(input)).kind, 'pending')
    assert.deepEqual(persisted, [])
    assert.deepEqual(errors, [])

    originActive = true
    assert.equal((await module.compensateLateGovernedProposal(input)).kind, 'pending')
    assert.equal(errors.length, 1)
    assert.match(errors[0], /hidden.*expire/i)
  } finally {
    await cleanup()
  }
})

test('cancellation_pending reconciles through the session-filtered list even when the direct refresh fails', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const persisted: string[] = []
    const listRequests: unknown[] = []
    const result = await module.compensateLateGovernedProposal({
      action: { id: 'pending-action', status: 'executing' },
      originSessionId: 'session-a',
      sessionExists: () => true,
      isOriginActive: () => false,
      cancel: async () => ({ ok: false, error: { code: 'cancellation_pending' } }),
      get: async () => ({ ok: false, error: { code: 'internal_error' } }),
      list: async (request: unknown) => {
        listRequests.push(request)
        return { ok: true, actions: [{ id: 'pending-action', status: 'cancelled' }] }
      },
      reject: async () => { throw new Error('must not reject executing actions') },
      persistTerminal: async (action: { id: string }) => { persisted.push(action.id) },
      reportError: () => { throw new Error('inactive origin must not receive UI errors') },
    })
    assert.equal(result.kind, 'terminal')
    assert.deepEqual(listRequests, [{ originSessionId: 'session-a' }])
    assert.deepEqual(persisted, ['pending-action'])
  } finally {
    await cleanup()
  }
})

test('governed commands keep approve and run separate, gate sessions, and serialize double clicks', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const calls: Array<{ operation: string, request: unknown }> = []
    const api = {
      get: async (request: unknown) => { calls.push({ operation: 'get', request }); return { ok: true, action: { id: 'action-1', status: 'expired' } } },
      decide: async (request: unknown) => { calls.push({ operation: 'decide', request }); return { ok: true, action: { id: 'action-1', status: 'approved' } } },
      execute: async (request: unknown) => { calls.push({ operation: 'execute', request }); return { ok: true, action: { id: 'action-1', status: 'completed' } } },
      cancel: async (request: unknown) => { calls.push({ operation: 'cancel', request }); return { ok: true, action: { id: 'action-1', status: 'cancelled' } } },
    }
    await module.invokeGovernedActionCommand('approve', 'action-1', 'session-a', () => 'session-a', api)
    await module.invokeGovernedActionCommand('run', 'action-1', 'session-a', () => 'session-a', api)
    await module.invokeGovernedActionCommand('reject', 'action-1', 'session-a', () => 'session-a', api)
    await module.invokeGovernedActionCommand('cancel', 'action-1', 'session-a', () => 'session-a', api)
    await module.invokeGovernedActionCommand('refresh', 'action-1', 'session-a', () => 'session-a', api)
    assert.deepEqual(calls, [
      { operation: 'decide', request: { actionId: 'action-1', originSessionId: 'session-a', decision: 'approve' } },
      { operation: 'execute', request: { actionId: 'action-1', originSessionId: 'session-a' } },
      { operation: 'decide', request: { actionId: 'action-1', originSessionId: 'session-a', decision: 'reject' } },
      { operation: 'cancel', request: { actionId: 'action-1', originSessionId: 'session-a' } },
      { operation: 'get', request: { actionId: 'action-1', originSessionId: 'session-a' } },
    ])
    await assert.rejects(
      module.invokeGovernedActionCommand('run', 'action-1', 'session-a', () => 'session-b', api),
      /originating Agent session is no longer active/i,
    )
    assert.equal(calls.length, 5)

    const gate = module.createKeyedOperationGate()
    let release!: () => void
    const first = gate.run('action-1', () => new Promise<void>((resolve) => { release = resolve }))
    assert.equal(await gate.run('action-1', async () => { throw new Error('must not run') }), undefined)
    release()
    await first
  } finally {
    await cleanup()
  }
})

test('approval expiry is fail-closed and the approved card exposes separate Run and Cancel controls', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const proposed = {
      status: 'proposed',
      approval: { expiresAt: '2026-08-06T10:05:00.000Z' },
    }
    assert.equal(module.isGovernedApprovalExpired(proposed, Date.parse('2026-08-06T10:04:59.999Z')), false)
    assert.equal(module.isGovernedApprovalExpired(proposed, Date.parse('2026-08-06T10:05:00.000Z')), true)
    assert.equal(module.isGovernedApprovalExpired({
      status: 'proposed', approval: { expiresAt: 'not-a-date' },
    }, Date.now()), true)
    assert.equal(module.isGovernedApprovalExpired({
      status: 'executing', approval: { expiresAt: '2026-08-06T10:05:00.000Z' },
    }, Date.parse('2026-08-06T10:06:00.000Z')), false)

    const source = await readFile(chatPanelEntry, 'utf8')
    const approvedControls = source.match(/action\.status === 'approved'[\s\S]*?action\.status === 'executing'/)?.[0] ?? ''
    assert.match(approvedControls, /onCommand\(entry, 'run'\)/)
    assert.match(approvedControls, /onCommand\(entry, 'cancel'\)/)
    assert.match(source, /onExpire/)
  } finally {
    await cleanup()
  }
})

test('cancellation reconciliation polls only the immutable origin session until a terminal action appears', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const requests: unknown[] = []
    const responses = [
      { ok: true, actions: [{ id: 'action-1', status: 'executing' }] },
      { ok: true, actions: [{ id: 'action-1', status: 'cancelled' }] },
    ]
    const terminal = await module.reconcileGovernedActionUntilTerminal({
      actionId: 'action-1',
      originSessionId: 'session-a',
      list: async (request: unknown) => {
        requests.push(request)
        return responses.shift() ?? { ok: true, actions: [] }
      },
      wait: async () => {},
    })
    assert.deepEqual(terminal, { id: 'action-1', status: 'cancelled' })
    assert.deepEqual(requests, [
      { originSessionId: 'session-a' },
      { originSessionId: 'session-a' },
    ])
  } finally {
    await cleanup()
  }
})

test('cancellation reconciliation waits without busy-looping until authoritative approval expiry', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    let nowMs = Date.parse('2026-08-06T10:00:00.000Z')
    const expiresAt = new Date(nowMs + 750).toISOString()
    const waits: number[] = []
    let polls = 0
    const terminal = await module.reconcileGovernedActionUntilTerminal({
      actionId: 'action-expiring',
      originSessionId: 'session-a',
      list: async () => {
        polls += 1
        return {
          ok: true,
          actions: [{
            id: 'action-expiring', status: 'proposed', approval: { expiresAt },
          }],
        }
      },
      now: () => nowMs,
      hardTimeoutMs: 5_000,
      wait: async (milliseconds: number) => {
        assert.ok(milliseconds > 0)
        waits.push(milliseconds)
        nowMs += milliseconds
      },
    })
    assert.equal(terminal, null)
    assert.equal(polls, 4)
    assert.deepEqual(waits, [250, 250, 250])

    let hardNowMs = 0
    const hardWaits: number[] = []
    let hardPolls = 0
    assert.equal(await module.reconcileGovernedActionUntilTerminal({
      actionId: 'action-executing',
      originSessionId: 'session-a',
      list: async () => {
        hardPolls += 1
        return { ok: true, actions: [{ id: 'action-executing', status: 'executing' }] }
      },
      now: () => hardNowMs,
      hardTimeoutMs: 600,
      wait: async (milliseconds: number) => {
        assert.ok(milliseconds > 0)
        hardWaits.push(milliseconds)
        hardNowMs += milliseconds
      },
    }), null)
    assert.equal(hardPolls, 4)
    assert.deepEqual(hardWaits, [250, 250, 100])
  } finally {
    await cleanup()
  }
})

test('chat mints a main-process model lease before FastAPI and sends only the opaque lease into proposal handoff', async () => {
  const source = await readFile(chatPanelEntry, 'utf8')
  assert.match(source, /window\.electron\.agentActions\.leaseModel\(\{[\s\S]*originSessionId:[\s\S]*model: selectedModel/)
  assert.match(source, /body: JSON\.stringify\(\{[\s\S]*modelLeaseId/)
  assert.match(source, /handoffGovernedProposals\([\s\S]*modelLeaseId/)
})

test('only terminal governed actions produce minimal durable summaries', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const action = {
      schema: 'modly.agent-action-summary.v1', version: 1,
      id: 'action-private-id', status: 'proposed',
      createdAt: '2026-08-06T10:00:00.000Z', updatedAt: '2026-08-06T10:00:00.000Z',
      capability: {
        id: 'text-to-cad/generate', displayName: 'Text to CAD', description: 'Generate CAD.',
        hash: 'a'.repeat(64), risk: 'mutating',
      },
      model: { provider: 'ollama', model: 'qwen3.6:latest', digest: `sha256:${'b'.repeat(64)}` },
      approval: { scope: 'single_action', expiresAt: '2026-08-06T10:05:00.000Z' },
      preview: [{ label: 'Input', value: 'chair' }], inputs: [],
      outputs: [{ id: 'artifact-private-id', kind: 'mesh', mediaType: 'model/gltf-binary', sha256: 'c'.repeat(64), sizeBytes: 42 }],
    }

    for (const status of ['proposed', 'approved', 'executing']) {
      assert.equal(module.buildGovernedTerminalSummary({ ...action, status }), null)
    }

    const summary = module.buildGovernedTerminalSummary({ ...action, status: 'completed' })
    assert.deepEqual(summary, {
      kind: 'governed-action',
      label: 'Text to CAD completed',
      governedAction: {
        status: 'completed', capability: 'Text to CAD', model: 'qwen3.6:latest',
        outputs: [{ kind: 'mesh', sha256: 'c'.repeat(64), sizeBytes: 42 }],
      },
    })
    const serialized = JSON.stringify(summary)
    for (const privateValue of ['action-private-id', 'artifact-private-id', 'digest', 'preview', 'arguments', 'endpoint']) {
      assert.equal(serialized.includes(privateValue), false, privateValue)
    }
  } finally {
    await cleanup()
  }
})

test('session switches hide and cancel only non-terminal actions from the prior session', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const entries = [
      { originSessionId: 'session-a', action: { id: 'proposed', status: 'proposed' } },
      { originSessionId: 'session-a', action: { id: 'executing', status: 'executing' } },
      { originSessionId: 'session-a', action: { id: 'completed', status: 'completed' } },
      { originSessionId: 'session-b', action: { id: 'other', status: 'approved' } },
    ]
    assert.deepEqual(module.planGovernedSessionSwitch(entries, 'session-a', 'session-b'), {
      cancelActionIds: ['proposed', 'executing'],
      retained: [{ originSessionId: 'session-b', action: { id: 'other', status: 'approved' } }],
    })
  } finally {
    await cleanup()
  }
})

test('Ollama model discovery accepts only bounded model names from authoritative objects', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    assert.deepEqual(module.parseOllamaModelNames({
      models: [
        { name: 'qwen3.6:latest', digest: `sha256:${'a'.repeat(64)}` },
        { name: 'devstral:latest', digest: `sha256:${'b'.repeat(64)}` },
        { name: 'qwen3.6:latest', digest: `sha256:${'c'.repeat(64)}` },
        { name: '', digest: 'bad' },
        'legacy-untrusted-string',
      ],
    }), ['devstral:latest', 'qwen3.6:latest'])
    assert.deepEqual(module.parseOllamaModelNames({ models: 'not-an-array' }), [])
  } finally {
    await cleanup()
  }
})

test('response guards reject malformed or duplicate success batches and discard invalid error batches atomically', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    await assert.rejects(
      module.parseAgentChatResponse({
        ok: true,
        status: 200,
        json: async () => ({
          message: 'Unsafe payload',
          actions: [{ tool: 'smooth_mesh', result: 'bad', payload: { type: 'mesh_update', url: 42 } }],
        }),
      }),
      /invalid agent response/i,
    )

    await assert.rejects(
      module.parseAgentChatResponse({
        ok: true,
        status: 200,
        json: async () => ({
          message: 'Duplicate direct actions',
          actions: [
            { tool: 'unload_models', result: 'first', payload: { type: 'models_unloaded', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
            { tool: 'unload_models', result: 'second', payload: { type: 'models_unloaded', actionId: 'direct-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } },
          ],
        }),
      }),
      /invalid agent response/i,
    )

    await assert.rejects(
      module.parseAgentChatResponse({
        ok: false,
        status: 504,
        json: async () => ({
          detail: {
            message: 'Original structured error.',
            actions: [
              { tool: 'list_models', result: '{}', payload: null },
              { tool: 'run_workflow', result: 'bad', payload: { type: 'run_workflow', workflow_id: 7 } },
            ],
          },
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof module.AgentApiError)
        const agentError = error as Error & { actions: Array<{ tool: string }> }
        assert.equal(agentError.message, 'Original structured error.')
        assert.deepEqual(agentError.actions, [])
        return true
      },
    )

    for (const actions of [
      [
        { tool: 'unload_models', result: 'first', payload: { type: 'models_unloaded', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
        { tool: 'smooth_mesh', result: 'second', payload: { type: 'mesh_operation', actionId: 'direct-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', operation: 'smooth', assetRef: '/workspace/a.glb', iterations: 1 } },
      ],
      [{ tool: 'list_models', result: 'x'.repeat(512 * 1024), payload: null }],
    ]) {
      await assert.rejects(
        module.parseAgentChatResponse({
          ok: false,
          status: 504,
          json: async () => ({ detail: { message: 'Sanitized terminal error.', actions } }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof module.AgentApiError)
          const agentError = error as Error & { actions: unknown[] }
          assert.equal(agentError.message, 'Sanitized terminal error.')
          assert.deepEqual(agentError.actions, [])
          return true
        },
      )
    }
  } finally {
    await cleanup()
  }
})

test('submitted messages remain in history and loading clears after request failure', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const original = [{ id: 'a', content: 'Earlier message' }]
    const submitted = { id: 'u', content: 'Retry this request' }
    const next = module.appendSubmittedMessage(original, submitted)
    assert.deepEqual(next, [...original, submitted])
    assert.deepEqual(original, [{ id: 'a', content: 'Earlier message' }])

    const loadingStates: boolean[] = []
    await assert.rejects(
      module.withAgentLoading(
        (loading: boolean) => loadingStates.push(loading),
        async () => { throw new Error('request failed') },
      ),
      /request failed/,
    )
    assert.deepEqual(loadingStates, [true, false])
  } finally {
    await cleanup()
  }
})

test('request history is captured once so turn two is exactly user one, assistant one, user two', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const liveHistory = [
      { id: 'u1', role: 'user', content: 'First question' },
      { id: 'a1', role: 'assistant', content: 'First answer' },
    ]
    const snapshot = module.captureAgentHistorySnapshot(liveHistory)
    liveHistory.splice(0, liveHistory.length)
    const request = module.appendSubmittedMessage(snapshot, {
      id: 'u2', role: 'user', content: 'Follow-up question',
    })
    assert.deepEqual(request.map((message: { id: string }) => message.id), ['u1', 'a1', 'u2'])
  } finally {
    await cleanup()
  }
})

test('send readiness requires hydration of the exact active session', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    assert.equal(module.isAgentSessionReady(false, 's1', 's1'), false)
    assert.equal(module.isAgentSessionReady(true, null, 's1'), false)
    assert.equal(module.isAgentSessionReady(true, 's2', 's1'), false)
    assert.equal(module.isAgentSessionReady(true, 's1', 's1'), true)
    assert.equal(module.isAgentSessionReady(true, null, null), false)
  } finally {
    await cleanup()
  }
})

test('restoring history retains safe summaries and degrades only a failed attachment', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const restored = await module.restorePersistedMessage(
      {
        id: 'm1', role: 'assistant', content: 'Completed.',
        attachmentIds: ['good', 'missing'],
        summaries: [{ kind: 'action', label: 'Ran workflow' }],
      },
      [
        { id: 'good', name: 'good.png', mimeType: 'image/png', sizeBytes: 12 },
        { id: 'missing', name: 'missing.png', mimeType: 'image/png', sizeBytes: 12 },
      ],
      async (attachmentId: string) => {
        if (attachmentId === 'missing') throw new Error('blob unavailable')
        return Uint8Array.from([137, 80, 78, 71])
      },
    )
    assert.deepEqual(restored.summaries, [{ kind: 'action', label: 'Ran workflow' }])
    assert.equal(restored.imageDataUrls.length, 1)
    assert.equal(Object.hasOwn(restored, 'actions'), false)

    const refreshed = await module.restorePersistedMessage(
      {
        id: 'm1', role: 'assistant', content: 'Completed.',
        attachmentIds: ['good'], summaries: [{ kind: 'action', label: 'Ran workflow' }],
      },
      [{ id: 'good', name: 'good.png', mimeType: 'image/png', sizeBytes: 12 }],
      async () => { throw new Error('transient read failure') },
      { ...restored, thinking: 'keep', actions: [{ tool: 'list_models', result: 'done' }] },
    )
    assert.deepEqual(refreshed.imageDataUrls, restored.imageDataUrls)
    assert.equal(refreshed.thinking, 'keep')
    assert.deepEqual(refreshed.actions, [{ tool: 'list_models', result: 'done' }])
  } finally {
    await cleanup()
  }
})

test('submission gate rejects rapid duplicate sends and recovers after completion', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const gate = module.createSubmissionGate()
    let release!: () => void
    const pending = gate.run(() => new Promise<void>((resolve) => { release = resolve }))
    assert.equal(await gate.run(async () => { throw new Error('must not run') }), undefined)
    release()
    await pending
    assert.equal(await gate.run(async () => 'next'), 'next')
  } finally {
    await cleanup()
  }
})

test('same-session revision hydration merges by id without clearing transient state', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    let current: Array<{
      id: string
      role: string
      content: string
      thinking?: string
      actions?: Array<{ tool: string, result: string }>
      imageDataUrls?: string[]
      summaries?: Array<{ kind: string, label: string }>
    }> = []
    const views: string[][] = []
    const coordinator = module.createSessionRestoreCoordinator(
      (messages: typeof current) => { current = messages; views.push(messages.map((message) => message.id)) },
      (restored: typeof current) => module.mergeRestoredMessages(current, restored),
    )
    await coordinator.restore('same', async () => [{ id: 'm1', role: 'assistant', content: 'Persisted answer' }])
    current = [{
      id: 'm1', role: 'assistant', content: 'Live answer', thinking: 'live reasoning',
      actions: [{ tool: 'list_models', result: 'done' }], imageDataUrls: ['data:image/png;base64,live'],
    }]
    views.length = 0
    let releaseRefresh!: (messages: typeof current) => void
    const refresh = coordinator.restore('same', () => new Promise((resolve) => { releaseRefresh = resolve }))
    assert.deepEqual(views, [])
    releaseRefresh([{
      id: 'm1', role: 'assistant', content: 'Persisted answer',
      summaries: [{ kind: 'action', label: 'Listed models' }],
    }])
    assert.equal(await refresh, true)
    assert.deepEqual(views, [['m1']])
    assert.deepEqual(current[0], {
      id: 'm1', role: 'assistant', content: 'Persisted answer',
      summaries: [{ kind: 'action', label: 'Listed models' }],
      thinking: 'live reasoning', actions: [{ tool: 'list_models', result: 'done' }],
      imageDataUrls: ['data:image/png;base64,live'],
    })
  } finally {
    await cleanup()
  }
})

test('session switching clears immediately and stale hydration cannot re-inject prior messages', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const views: string[][] = []
    const coordinator = module.createSessionRestoreCoordinator((messages: Array<{ id: string }>) => {
      views.push(messages.map((message) => message.id))
    })
    let releaseOld!: (messages: Array<{ id: string }>) => void
    const oldRestore = coordinator.restore('old', () => new Promise((resolve) => { releaseOld = resolve }))
    const newRestore = coordinator.restore('new', async () => [{ id: 'new-message' }])
    await newRestore
    releaseOld([{ id: 'old-message' }])
    await oldRestore
    assert.deepEqual(views, [[], [], ['new-message']])

    await coordinator.restore(null, async () => [{ id: 'must-not-render' }])
    assert.deepEqual(views.at(-1), [])
  } finally {
    await cleanup()
  }
})

test('origin-bound UI tokens suppress late errors and finally updates after a session switch', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    let activeSessionId: string | null = 's1'
    const updates: string[] = []
    const gate = module.createOriginBoundUiGate(() => activeSessionId)
    const oldRequest = gate.begin('s1')
    oldRequest.run(() => updates.push('s1-loading'))

    activeSessionId = 's2'
    gate.invalidate()
    const currentRequest = gate.begin('s2')
    oldRequest.run(() => updates.push('s1-error'))
    currentRequest.run(() => updates.push('s2-loading'))
    oldRequest.run(() => updates.push('s1-finally'))
    currentRequest.run(() => updates.push('s2-error'))

    assert.deepEqual(updates, ['s1-loading', 's2-loading', 's2-error'])
  } finally {
    await cleanup()
  }
})

test('failed-send attachment rollback surfaces cleanup failure as recoverable', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    let rollbackAttempts = 0
    await assert.rejects(
      module.rollbackFailedSendAttachments(['attachment-1'], async () => {
        rollbackAttempts += 1
        throw new Error('injected remove failure')
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.name, 'AgentAttachmentRollbackError')
        assert.equal((error as Error & { recoverable?: boolean }).recoverable, true)
        assert.match(error.message, /staged attachments could not be removed/i)
        return true
      },
    )
    assert.equal(rollbackAttempts, 1)
  } finally {
    await cleanup()
  }
})
