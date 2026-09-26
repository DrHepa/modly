import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import ts from 'typescript'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const chatPanelEntry = path.join(projectRoot, 'src/areas/generate/components/ChatPanel.tsx')
const require = createRequire(import.meta.url)

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

async function loadChatPanelModule(options: { agentSettings?: Record<string, unknown> } = {}) {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-chat-panel-'))
  const entry = path.join(tempDir, 'entry.ts')
  const outfile = path.join(tempDir, 'ChatPanel.bundle.mjs')
  const previousLocalStorage = globalThis.localStorage
  globalThis.localStorage = localStorageMock()
  if (options.agentSettings) {
    globalThis.localStorage.setItem('modly-agent-settings', JSON.stringify({ state: options.agentSettings, version: 0 }))
  }

  try {
    await writeFile(entry, `export { default } from ${JSON.stringify(chatPanelEntry)}\nexport * from ${JSON.stringify(chatPanelEntry)}\nexport { useAgentStore } from '@shared/stores/agentStore'\nexport { useAgentSessionsStore } from '@shared/stores/agentSessionsStore'\n`)
    await build({
      entryPoints: [entry],
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

test('turn error recovery surfaces proposal handoff and direct-action reflection failures together', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    assert.equal(module.agentTurnFailureMessage({
      error: new Error('The agent response was received.'),
      actionFailureCount: 1,
      partialSummaryError: null,
      proposalErrors: [{
        code: 'model_stale',
        message: 'This protected action could not be proposed because proposal authority is unavailable.',
      }],
    }), 'The agent response was received. 1 action could not be applied locally. '
      + 'This protected action could not be proposed because proposal authority is unavailable.')
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
  assert.match(source, /window\.electron\.agentCapabilities\.resolveSkillContexts\(/)
  assert.match(source, /apiMessages\.push\(\{ role: 'system', content: extraContext\.workflowCompletion/)
  assert.match(source, /proposeGovernedAgentActions\(\{[\s\S]*\n\s*proposals,/)
  assert.match(source, /const request: AgentChatRequest = \{[\s\S]*originSessionId[\s\S]*resolutionHash[\s\S]*completedArtifacts[\s\S]*skillContexts[\s\S]*\}/)
  assert.match(source, /body: JSON\.stringify\(request\)/)
  assert.match(source, /<GovernedActionCard/)
  assert.equal(source.includes('approveAndExecute'), false)
})

test('skill context request uses only public refs and discards a late origin result', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const skilled = {
      schema: 'modly.agent-capability.v1', version: 1,
      id: 'cad/plan', displayName: 'CAD Planner', description: 'Plan CAD geometry.',
      extension: { id: 'cad', name: 'CAD' },
      node: { id: 'plan', input: 'text', output: 'mesh', paramsSchema: [] },
      skills: {
        schema: 'modly.agent-skills.v1', version: 1, hash: 'b'.repeat(64), count: 1,
        items: [{ name: 'modly-cad-plan-v1', version: 1, hash: 'c'.repeat(64) }],
      },
      approval: { required: true, scope: 'single_action' }, hash: 'a'.repeat(64),
    }
    assert.deepEqual(module.buildAgentSkillContextRefs({ capabilities: [skilled], errors: [] }), [{
      id: 'cad/plan', hash: 'a'.repeat(64), skillsHash: 'b'.repeat(64),
    }])
    const promptView = module.buildAgentCapabilityPromptInventory({ capabilities: [skilled], errors: [] })[0]
    assert.deepEqual(promptView.skills, skilled.skills)
    assert.equal(JSON.stringify(promptView).includes('instructions'), false)
    assert.equal(JSON.stringify(promptView).includes('.md'), false)

    let current = true
    let release!: (value: unknown) => void
    const requests: unknown[] = []
    const pending = module.resolveAgentSkillContextsForTurn({
      originSessionId: 'session-a',
      userText: 'Create CAD geometry',
      capabilityRefs: module.buildAgentSkillContextRefs({ capabilities: [skilled], errors: [] }),
      isCurrent: () => current,
      resolve: (request: unknown) => new Promise((resolve) => {
        requests.push(request)
        release = resolve
      }),
    })
    assert.deepEqual(requests, [{
      originSessionId: 'session-a', userText: 'Create CAD geometry',
      capabilities: [{ id: 'cad/plan', hash: 'a'.repeat(64), skillsHash: 'b'.repeat(64) }],
    }])
    assert.equal(JSON.stringify(requests).includes('instructions'), false)
    current = false
    release({ resolutionHash: 'd'.repeat(64), contexts: [{ private: 'must be discarded' }] })
    assert.equal(await pending, null)

    current = true
    assert.deepEqual(await module.resolveAgentSkillContextsForTurn({
      originSessionId: 'session-a',
      userText: 'Create CAD geometry',
      capabilityRefs: module.buildAgentSkillContextRefs({ capabilities: [skilled], errors: [] }),
      isCurrent: () => current,
      resolve: async () => ({ resolutionHash: 'd'.repeat(64), contexts: [] }),
    }), { resolutionHash: 'd'.repeat(64), contexts: [] })
  } finally {
    await cleanup()
  }
})

test('MCP artifact prompt hints expose bounded kind and media guidance without private bindings', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const inputSchema = {
      type: 'object', additionalProperties: false,
      properties: {
        sceneArtifact: { type: 'string', description: 'Approved Blender scene artifact.' },
      },
      required: ['sceneArtifact'],
    }
    const capability = {
      schema: 'modly.agent-capability.v1', version: 1,
      id: 'blender/inspect', displayName: 'Inspect scene', description: 'Inspect a governed Blender scene.',
      extension: { id: 'blender', name: 'Blender' },
      node: { id: 'inspect', input: 'blend', output: 'text', paramsSchema: [] },
      execution: {
        kind: 'mcp_tool', inputSchema, inputSchemaHash: 'b'.repeat(64),
        inputArtifacts: [{
          argument: 'sceneArtifact', kind: 'blend', mediaTypes: ['application/x-blender'], sandboxPath: '/input/0',
        }],
        mutating: false, bindingHash: 'c'.repeat(64),
      },
      approval: { required: true, scope: 'single_action' }, hash: 'a'.repeat(64),
    }
    const view = module.buildAgentCapabilityPromptInventory({ capabilities: [capability], errors: [] })[0]
    assert.deepEqual(view.inputHints, [{
      path: 'arguments.sceneArtifact',
      type: 'string',
      required: true,
      description: 'Approved Blender scene artifact.',
      artifact: { kind: 'blend', mediaTypes: ['application/x-blender'] },
    }])
    const serialized = JSON.stringify(view)
    assert.equal(serialized.includes('/input/0'), false)
    assert.equal(serialized.includes('sandboxPath'), false)
  } finally {
    await cleanup()
  }
})

test('completed artifact context is path-free, deterministic, newest-bounded, and excludes unsuccessful actions', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const actions = Array.from({ length: 40 }, (_, index) => ({
      schema: 'modly.agent-action-summary.v1', version: 1,
      id: `action-${String(index).padStart(2, '0')}`,
      status: 'completed',
      createdAt: new Date(Date.UTC(2026, 7, 10, 12, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 7, 10, 12, 1, index)).toISOString(),
      capability: {
        id: 'text-to-cad-agent/plan-cad', displayName: 'Plan CAD',
        description: `private-description-${index}`, hash: 'a'.repeat(64), risk: 'mutating',
      },
      model: { provider: 'ollama', model: 'private-model', digest: `sha256:${'b'.repeat(64)}` },
      approval: { scope: 'single_action', expiresAt: '2026-08-10T13:00:00.000Z' },
      preview: [], inputs: [],
      outputs: [{
        id: `artifact-${String(index).padStart(2, '0')}`, kind: 'plan',
        mediaType: 'application/vnd.modly.cad-plan+json', sha256: index.toString(16).padStart(64, '0'),
        sizeBytes: index + 1, workspacePath: `/private/artifact-${index}.json`,
      }],
    }))
    actions.push({
      ...actions[0], id: 'failed-action', status: 'failed',
      outputs: [{ ...actions[0].outputs[0], id: 'failed-artifact' }],
    })
    const context = module.buildCompletedArtifactContext(actions)
    assert.equal(context.length, 32)
    assert.deepEqual(context.map((item: { actionId: string }) => item.actionId),
      Array.from({ length: 32 }, (_, index) => `action-${String(index + 8).padStart(2, '0')}`))
    assert.ok(new TextEncoder().encode(JSON.stringify(context)).byteLength <= 32 * 1024)
    const encoded = JSON.stringify(context)
    for (const forbidden of ['workspacePath', '/private/', 'private-description', 'private-model', 'failed-artifact']) {
      assert.equal(encoded.includes(forbidden), false, forbidden)
    }
    assert.deepEqual(Object.keys(context[0]), [
      'id', 'kind', 'mediaType', 'sha256', 'sizeBytes', 'actionId', 'capabilityId', 'capabilityName',
    ])

    const byteHeavyActions = Array.from({ length: 40 }, (_, index) => ({
      ...actions[index],
      id: `y${String(index).padStart(3, '0')}${'x'.repeat(124)}`,
      capability: {
        ...actions[index].capability,
        id: `${'c'.repeat(128)}/${'d'.repeat(128)}`,
        displayName: '界'.repeat(80),
      },
      outputs: [{
        ...actions[index].outputs[0],
        id: `z${String(index).padStart(3, '0')}${'x'.repeat(124)}`,
        mediaType: `a/${'b'.repeat(126)}`,
      }],
    }))
    const byteBounded = module.buildCompletedArtifactContext(byteHeavyActions)
    assert.ok(byteBounded.length > 0 && byteBounded.length < 32)
    assert.ok(new TextEncoder().encode(JSON.stringify(byteBounded)).byteLength <= 32 * 1024)

    const unicodeBoundary = [{
      ...actions[0],
      capability: { ...actions[0].capability, displayName: '🙂'.repeat(40) },
    }]
    assert.equal(module.buildCompletedArtifactContext(unicodeBoundary)[0].capabilityName, '🙂'.repeat(40))
    assert.throws(() => module.buildCompletedArtifactContext([{
      ...actions[0], capability: { ...actions[0].capability, displayName: '🙂'.repeat(41) },
    }]), /invalid completed Agent artifacts/i)
    assert.throws(() => module.buildCompletedArtifactContext([{
      ...actions[0], capability: { ...actions[0].capability, displayName: 'Unsafe\u007fName' },
    }]), /invalid completed Agent artifacts/i)
  } finally {
    await cleanup()
  }
})

test('completed artifact lookup is origin-bound, abortable, excludes ambiguous ids, and is never persisted', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    let activeSessionId: string | null = 'session-a'
    const gate = module.createOriginBoundUiGate(() => activeSessionId)
    const token = gate.begin('session-a')
    assert.equal(token.signal.aborted, false)
    let release!: (value: unknown) => void
    const requests: unknown[] = []
    const pending = module.resolveCompletedArtifactsForTurn({
      originSessionId: 'session-a',
      isCurrent: token.isCurrent,
      signal: token.signal,
      list: (request: unknown) => new Promise((resolve) => {
        requests.push(request)
        release = resolve
      }),
    })
    activeSessionId = 'session-b'
    gate.invalidate()
    assert.equal(token.signal.aborted, true)
    release({ ok: true, actions: [] })
    assert.equal(await pending, null)
    assert.deepEqual(requests, [{ originSessionId: 'session-a' }])

    const duplicate = {
      schema: 'modly.agent-action-summary.v1', version: 1, status: 'completed',
      createdAt: '2026-08-10T12:00:00.000Z', updatedAt: '2026-08-10T12:01:00.000Z',
      capability: {
        id: 'cad/plan', displayName: 'Plan', description: 'Plan.', hash: 'a'.repeat(64), risk: 'mutating',
      },
      model: { provider: 'ollama', model: 'model', digest: `sha256:${'b'.repeat(64)}` },
      approval: { scope: 'single_action', expiresAt: '2026-08-10T13:00:00.000Z' },
      preview: [], inputs: [],
      outputs: [{
        id: 'ambiguous-artifact', kind: 'plan', mediaType: 'application/json', sha256: 'c'.repeat(64), sizeBytes: 1,
      }],
    }
    assert.deepEqual(module.buildCompletedArtifactContext([
      { ...duplicate, id: 'action-a' }, { ...duplicate, id: 'action-b' },
    ]), [])

    const source = await readFile(chatPanelEntry, 'utf8')
    assert.match(source, /resolveCompletedArtifactsForTurn\(\{[\s\S]*originSessionId: originatingSessionId/)
    assert.match(source, /completedArtifacts,/)
    const sourceFile = ts.createSourceFile(chatPanelEntry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const persistenceCalls: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'appendPersistedMessage') {
        persistenceCalls.push(node.getText(sourceFile))
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    assert.ok(persistenceCalls.length >= 3, 'expected real appendPersistedMessage call sites')
    for (const call of persistenceCalls) assert.doesNotMatch(call, /completedArtifacts/)
  } finally {
    await cleanup()
  }
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

test('normal chat still sends and accepts assistant text when proposal authority cannot be leased', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    for (const code of ['invalid_request', 'internal_error']) {
      const sentLeaseIds: Array<string | null> = []
      const persisted: string[] = []
      const rendered: string[] = []
      const response = await module.runAgentChatWithOptionalProposalAuthority({
        leaseModel: async () => ({ ok: false, error: { code } }),
        send: async (modelLeaseId: string | null) => {
          sentLeaseIds.push(modelLeaseId)
          return { message: `Assistant reply after ${code}.`, actions: [], proposals: [] }
        },
        accept: async (data: { message: string }) => {
          persisted.push(data.message)
          rendered.push(data.message)
        },
      })

      assert.deepEqual(sentLeaseIds, [null])
      assert.deepEqual(persisted, [`Assistant reply after ${code}.`])
      assert.deepEqual(rendered, persisted)
      assert.equal(response.modelLeaseId, null)
      assert.doesNotMatch(rendered.join(' '), /could not create this governed action proposal/i)
    }
  } finally {
    await cleanup()
  }
})

test('normal chat preserves an available proposal lease through send and acceptance', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const observed: Array<string | null> = []
    const result = await module.runAgentChatWithOptionalProposalAuthority({
      now: () => Date.parse('2026-08-15T10:00:00.000Z'),
      leaseModel: async () => ({
        ok: true,
        lease: { id: 'model-lease-1', expiresAt: '2026-08-15T10:05:00.000Z' },
      }),
      send: async (modelLeaseId: string | null) => {
        observed.push(modelLeaseId)
        return { message: 'Bound reply.', actions: [], proposals: [] }
      },
      accept: async (_data: unknown, modelLeaseId: string | null) => { observed.push(modelLeaseId) },
    })

    assert.deepEqual(observed, ['model-lease-1', 'model-lease-1'])
    assert.equal(result.modelLeaseId, 'model-lease-1')
  } finally {
    await cleanup()
  }
})

test('turn seam degrades malformed and thrown leases while recovering partial actions without authority', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    for (const leaseModel of [
      async () => { throw new Error('lease IPC failed') },
      async () => ({ ok: true, lease: { id: '', expiresAt: 'not-a-date' } }),
    ]) {
      const accepted: string[] = []
      const recovered: Array<{ actions: unknown[], lease: string | null }> = []
      const partialAction = { tool: 'list_models', result: 'listed', payload: null }
      await assert.rejects(module.runAgentChatWithOptionalProposalAuthority({
        leaseModel,
        send: async (modelLeaseId: string | null) => {
          assert.equal(modelLeaseId, null)
          throw new module.AgentApiError('Ollama timed out.', [partialAction])
        },
        accept: async () => { accepted.push('accepted') },
        recover: async (error: unknown, modelLeaseId: string | null) => {
          assert.ok(error instanceof module.AgentApiError)
          recovered.push({ actions: (error as { actions: unknown[] }).actions, lease: modelLeaseId })
        },
      }), /Ollama timed out/)
      assert.deepEqual(accepted, [])
      assert.deepEqual(recovered, [{ actions: [partialAction], lease: null }])
    }
  } finally {
    await cleanup()
  }
})

test('protected turn context failures degrade to empty context and no proposal authority without swallowing size validation', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const base = {
      originSessionId: 'session-a',
      userText: 'Explain my local models',
      isCurrent: () => true,
      signal: new AbortController().signal,
      listCapabilities: async () => ({ capabilities: [], errors: [] }),
      listCompletedArtifacts: async () => [],
      resolveSkillContexts: async () => ({ resolutionHash: 'a'.repeat(64), contexts: [] }),
    }
    for (const failed of ['capabilities', 'artifacts', 'skills'] as const) {
      const result = await module.resolveOptionalAgentProtectedContext({
        ...base,
        ...(failed === 'capabilities' ? { listCapabilities: async () => { throw new Error('inventory failed') } } : {}),
        ...(failed === 'artifacts' ? { listCompletedArtifacts: async () => { throw new Error('artifact lookup failed') } } : {}),
        ...(failed === 'skills' ? { resolveSkillContexts: async () => { throw new Error('skill lookup failed') } } : {}),
      })
      assert.deepEqual(result, {
        capabilities: [], completedArtifacts: [], skillContexts: [],
        resolutionHash: null, proposalAuthorityAvailable: false,
      })
    }
    let leaseCalls = 0
    await module.runAgentChatWithOptionalProposalAuthority({
      proposalAuthorityAvailable: false,
      leaseModel: async () => {
        leaseCalls += 1
        throw new Error('must not lease without protected context')
      },
      send: async (modelLeaseId: string | null) => {
        assert.equal(modelLeaseId, null)
        return { message: 'Ordinary chat.' }
      },
      accept: async () => {},
    })
    assert.equal(leaseCalls, 0)
    await assert.rejects(module.resolveOptionalAgentProtectedContext({
      ...base,
      userText: 'x'.repeat(4_097),
    }), /too long/i)
  } finally {
    await cleanup()
  }
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

test('worlds_openai_selector_is_remote_labeled_and_generic_chat_stays_ollama_only', async () => {
  const [{ createElement }, { renderToStaticMarkup }] = await Promise.all([
    import('react'),
    import('react-dom/server'),
  ])
  const { module: worldsModule, cleanup: cleanupWorlds } = await loadChatPanelModule({
    agentSettings: { worldsProvider: 'openai', worldsOpenAiModel: 'gpt-5.1' },
  })
  try {
    worldsModule.useAgentStore.setState({ worldsProvider: 'openai', worldsOpenAiModel: 'gpt-5.1' })
    const noop = () => undefined
    const worlds = {
      begin: () => { throw new Error('server render must not begin a request') },
      accept: async () => undefined,
      fail: noop,
      apply: async () => undefined,
      reject: noop,
      undo: async () => undefined,
      cancel: noop,
      getState: () => ({ status: 'idle', message: '' }),
      subscribe: () => noop,
      dispose: noop,
    }
    const html = renderToStaticMarkup(createElement(worldsModule.default, { worlds }))
    assert.match(html, /aria-label="Select AI model, Ollama/)
    assert.match(html, /placeholder="Ask about this scene…"[^>]*placeholder-zinc-300|placeholder-zinc-300[^>]*placeholder="Ask about this scene…"/)
    assert.match(html, /text-zinc-300[^>]*>Ask about this scene<br\/>or change it directly/)
    assert.match(html, /text-zinc-300[^>]*>Shift\+Enter for new line/)
    assert.doesNotMatch(html, /aria-label="Worlds AI provider"/)
  } finally {
    await cleanupWorlds()
  }

  const { module: genericModule, cleanup: cleanupGeneric } = await loadChatPanelModule()
  try {
    const html = renderToStaticMarkup(createElement(genericModule.default))
    assert.doesNotMatch(html, /OpenAI ·/)
    assert.doesNotMatch(html, /OpenAI sends this scene request to a remote provider/)
    assert.doesNotMatch(html, /Ask OpenAI \(remote\)/)
    assert.match(html, /placeholder-zinc-600/)
  } finally {
    await cleanupGeneric()
  }
})

test('Worlds uses only the existing compact model picker, not a separate provider box', async () => {
  const source = await readFile(chatPanelEntry, 'utf8')
  assert.doesNotMatch(source, /aria-label="Worlds AI provider"/)
  assert.doesNotMatch(source, /OpenAI sends this scene request to a remote provider/)
  assert.match(source, /Select AI model,/)
  assert.match(source, /Ollama ·/)
  assert.match(source, /OpenAI ·/)
  assert.match(source, /max-h-\[min\(320px,calc\(100dvh-96px\)\)\]/)
  assert.match(source, /overflow-y-auto overscroll-contain/)
  assert.match(source, /aria-label=\{worlds \? 'Send Worlds AI request' : 'Send message'\}/)
  assert.match(source, /aria-label=\{`Remove \$\{attachment\.file\.name\}`\}/)
  assert.match(source, /focus-visible:opacity-100/)
  for (const contrast of [contrastRatio('#d4d4d8', '#18181b'), contrastRatio('#a1a1aa', '#18181b')]) assert.ok(contrast >= 4.5)
  assert.match(source, /min-h-6[^"`]*text-zinc-300/)
  assert.match(source, /className="px-3 py-2\.5 text-\[11px\] text-zinc-300" role="status">\{ollamaInventoryStatus === 'unavailable'/)
  assert.match(source, /className="px-3 py-2\.5 text-\[11px\] text-zinc-300">No Ollama models installed/)
  assert.match(source, /className="block text-\[10px\] text-zinc-300">OpenAI model ID/)
  assert.match(source, /aria-label="Attach image"[\s\S]*?className="text-zinc-400/)
  assert.match(source, /Thinking: \$\{thinkingMode\}[\s\S]*?text-zinc-400/)
})

test('Worlds chat text and controls use AA contrast without changing generic Generate palette', async () => {
  const chat = await readFile(chatPanelEntry, 'utf8')
  const history = await readFile(path.join(projectRoot, 'src/areas/generate/components/AgentSessionHistory.tsx'), 'utf8')
  const normalTextRatio = contrastRatio('#d4d4d8', '#18181b')
  const controlRatio = contrastRatio('#a1a1aa', '#18181b')
  const accentTextRatio = contrastRatio('#a78bfa', '#18181b')
  assert.ok(normalTextRatio >= 4.5)
  assert.ok(controlRatio >= 3)
  assert.ok(Math.abs(accentTextRatio - 6.510) < 0.01 && accentTextRatio >= 4.5)
  assert.ok(contrastRatio('#7c3aed', '#18181b') < 4.5)
  assert.match(chat, /<AgentSessionHistory worlds=\{Boolean\(worlds\)\} \/>/)
  assert.match(chat, /<FeedbackRow content=\{msg\.content\} worlds=\{Boolean\(worlds\)\} \/>/)
  assert.match(chat, /<ThinkingBlock content=\{msg\.thinking\} worlds=\{Boolean\(worlds\)\} \/>/)
  assert.match(chat, /<PersistedSummaries summaries=\{msg\.summaries\} worlds=\{Boolean\(worlds\)\} \/>/)
  assert.match(chat, /worlds \? 'text-zinc-300' : 'text-zinc-500'/)
  assert.match(chat, /worlds \? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'/)
  assert.match(chat, /worlds \? 'text-zinc-300' : 'text-zinc-700'/)
  assert.match(chat, /worlds \? 'placeholder-zinc-300' : 'placeholder-zinc-600'/)
  assert.match(chat, /worlds \? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-600 hover:text-zinc-400'/)
  for (const label of ['Copy', 'Good response', 'Bad response']) {
    assert.match(chat, new RegExp(`title="${label}"[\\s\\S]*?className=\\{iconClass\\}`))
  }
  assert.match(history, /worlds \? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'/)
  assert.match(history, /worlds \? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-600 hover:text-zinc-300'/)
  assert.match(history, /worlds \? 'text-zinc-300 hover:text-red-300' : 'text-zinc-600 hover:text-red-400'/)
  assert.match(history, /worlds \? 'text-zinc-300' : 'text-zinc-500'/)
  assert.match(history, /worlds \? 'text-accent-light' : 'text-accent'/)
})

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map((value) => parseInt(value, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test('Worlds proposed edits display host outcome, never an unverified model success claim', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    assert.equal(module.worldAiVisibleReply({ message: 'I changed it.', worldProposals: [{}] },
      { status: 'stale', message: 'This request is stale.' }), 'This request is stale.')
    assert.equal(module.worldAiVisibleReply({ message: 'I changed it.', worldProposals: [{}] },
      { status: 'applied', message: 'Changes applied. Undo is available.' }), 'Changes applied. Undo is available.')
    assert.equal(module.worldAiVisibleReply({ message: 'The scene has two lights.', worldProposals: [] },
      { status: 'idle', message: 'Scene unchanged.' }), 'Scene unchanged.\n\nModel reply (not an edit): The scene has two lights.')
    assert.equal(module.worldAiVisibleReply({ message: 'Done, renamed Hero.', worldProposals: [] },
      { status: 'idle', message: 'Scene unchanged.' }), 'Scene unchanged.\n\nModel reply (not an edit): Done, renamed Hero.')
  } finally { await cleanup() }
})

test('Ollama discovery distinguishes loading, successful-empty, HTTP failure and transport failure', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const digest = `sha256:${'a'.repeat(64)}`
    assert.deepEqual(await module.loadOllamaModelInventory(async () => new Response(JSON.stringify({ models: [{ name: 'gemma4:e4b', digest }] }), { status: 200 })),
      { status: 'ready', models: ['gemma4:e4b'] })
    assert.deepEqual(await module.loadOllamaModelInventory(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })),
      { status: 'ready', models: [] })
    assert.deepEqual(await module.loadOllamaModelInventory(async () => new Response('unavailable', { status: 503 })),
      { status: 'unavailable', models: [] })
    assert.deepEqual(await module.loadOllamaModelInventory(async () => new Response(JSON.stringify({ error: 'bad schema' }), { status: 200 })),
      { status: 'unavailable', models: [] })
    assert.deepEqual(await module.loadOllamaModelInventory(async () => { throw new Error('offline') }),
      { status: 'unavailable', models: [] })
  } finally { await cleanup() }
})

test('mounted Worlds compact picker lists discovered Ollama models and configured OpenAI within one menu', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  const listeners = new Map<string, (event: unknown) => void>()
  globalThis.window = globalThis as Window & typeof globalThis
  globalThis.document = { addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type) } as unknown as Document
  globalThis.fetch = (async () => new Response(JSON.stringify({ models: [
    { name: 'gemma4:e4b', digest: `sha256:${'a'.repeat(64)}` },
    { name: 'qwen3:8b', digest: `sha256:${'b'.repeat(64)}` },
  ] }), { status: 200 })) as typeof fetch
  const { module, cleanup } = await loadChatPanelModule()
  const React = require('react') as typeof import('react')
  const Reconciler = require('react-reconciler')
  type Host = { type: string; props: Record<string, any>; children: Host[]; focus(): void; scrollIntoView(): void; contains(node: Host): boolean }
  const append = (parent: Host, child: Host) => { parent.children.push(child) }
  const remove = (parent: Host, child: Host) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const createHost = (type: string, props: Host['props']): Host => ({ type, props, children: [], focus() {}, scrollIntoView() {},
    contains(node: Host) { return this === node || this.children.some((child) => child.contains(node)) } })
  const reconciler = Reconciler({ now: performance.now.bind(performance), supportsMutation: true, isPrimaryRenderer: true,
    getRootHostContext: () => null, getChildHostContext: () => null, getPublicInstance: (node: Host) => node,
    prepareForCommit: () => null, resetAfterCommit() {}, shouldSetTextContent: () => false,
    createInstance: createHost, createTextInstance: (value: string) => createHost('#text', { value }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, clearContainer: (node: Host) => { node.children = [] },
    insertBefore: append, insertInContainerBefore: append, finalizeInitialChildren: () => false,
    prepareUpdate: () => true, commitUpdate: (node: Host, _payload: unknown, _type: unknown, _old: unknown, props: Host['props']) => { node.props = props },
    commitTextUpdate: (node: Host, _old: unknown, value: string) => { node.props.value = value },
    hideInstance: () => {}, unhideInstance: () => {}, hideTextInstance: () => {}, unhideTextInstance: () => {},
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1,
    detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  })
  const rootHost = createHost('root', {})
  const root = reconciler.createContainer(rootHost, 0, null, false, null, '', () => {}, null)
  const render = (element: React.ReactNode) => { reconciler.flushSync(() => reconciler.updateContainer(element, root, null, null)); reconciler.flushPassiveEffects() }
  const find = (node: Host, predicate: (item: Host) => boolean): Host | undefined => {
    if (predicate(node)) return node
    for (const child of node.children) { const result = find(child, predicate); if (result) return result }
  }
  const nodeText = (node: Host): string => node.type === '#text' ? node.props.value : node.children.map(nodeText).join('')
  const worlds = { begin() { throw new Error('not sent') }, accept: async () => undefined, fail() {}, apply: async () => undefined,
    reject() {}, undo: async () => undefined, cancel() {}, getState: () => ({ status: 'idle', message: '' }), subscribe: () => () => {}, dispose() {} }
  try {
    module.useAgentSessionsStore.setState({ initialized: true, activeSession: null, sessions: [], initialize: async () => undefined })
    render(React.createElement(module.default, { worlds }))
    assert.match(String(find(rootHost, (node) => node.type === 'p' && nodeText(node).includes('Ask about this scene'))?.props.className), /text-zinc-300/)
    assert.match(String(find(rootHost, (node) => node.type === 'p' && nodeText(node).includes('Shift+Enter for new line'))?.props.className), /text-zinc-300/)
    assert.match(String(find(rootHost, (node) => node.type === 'button' && nodeText(node) === 'New chat')?.props.className), /text-accent-light/)
    const picker = find(rootHost, (node) => node.type === 'button' && String(node.props['aria-label']).startsWith('Select AI model'))!
    assert.ok(picker)
    assert.match(String(picker.props.className), /text-zinc-300/)
    assert.match(String(find(rootHost, (node) => node.props['aria-label'] === 'Attach image')?.props.className), /text-zinc-400/)
    assert.match(String(find(rootHost, (node) => String(node.props['aria-label']).startsWith('Thinking:'))?.props.className), /text-zinc-400/)
    assert.match(String(picker.props['aria-label']), /Not checked/)
    assert.ok(find(rootHost, (node) => node.type === 'button' && node.props['aria-label'] === 'Send Worlds AI request'))
    assert.equal(picker.props['aria-expanded'], false)
    picker.props.onClick()
    render(React.createElement(module.default, { worlds }))
    for (let tick = 0; tick < 4; tick++) { await new Promise((resolve) => setTimeout(resolve, 0)); render(React.createElement(module.default, { worlds })) }
    assert.equal(picker.props['aria-expanded'], true)
    assert.match(String(find(rootHost, (node) => node.props.id === 'agent-model-picker')?.props.className), /overflow-y-auto/)
    assert.equal(find(rootHost, (node) => node.type === 'select' && node.props['aria-label'] === 'Worlds AI provider'), undefined)
    const ollama = find(rootHost, (node) => node.type === 'button' && nodeText(node).includes('Ollama · qwen3:8b'))!
    const openai = find(rootHost, (node) => node.type === 'button' && nodeText(node).includes('OpenAI · gpt-5.1 · Remote'))!
    assert.ok(ollama)
    assert.ok(openai)
    ollama.props.onClick()
    render(React.createElement(module.default, { worlds }))
    assert.match(String(picker.props['aria-label']), /Ollama qwen3:8b local/)
    picker.props.onClick()
    render(React.createElement(module.default, { worlds }))
    const remote = find(rootHost, (node) => node.type === 'button' && nodeText(node).includes('OpenAI · gpt-5.1 · Remote'))!
    remote.props.onClick()
    render(React.createElement(module.default, { worlds }))
    assert.match(String(picker.props['aria-label']), /OpenAI gpt-5.1 remote/)
    assert.equal(module.useAgentStore.getState().worldsProvider, 'openai')
    assert.equal(module.useAgentStore.getState().worldsOpenAiModel, 'gpt-5.1')
    picker.props.onClick()
    render(React.createElement(module.default, { worlds }))
    const config = find(rootHost, (node) => node.type === 'input' && node.props['aria-label'] === 'Configure OpenAI model')!
    config.props.onChange({ target: { value: 'sk-secret' } })
    render(React.createElement(module.default, { worlds }))
    const use = find(rootHost, (node) => node.type === 'button' && nodeText(node) === 'Use')!
    assert.equal(use.props.disabled, true)
    const menu = find(rootHost, (node) => node.props.id === 'agent-model-picker')!
    menu.props.onKeyDown({ key: 'Escape', stopPropagation() {} })
    render(React.createElement(module.default, { worlds }))
    assert.equal(picker.props['aria-expanded'], false)
    module.useAgentSessionsStore.setState({ activeSession: { id: 'session:active', title: 'Scene chat', revision: 1, messages: [], attachments: [] },
      sessions: [{ id: 'session:active', title: 'Scene chat' }, { id: 'session:earlier', title: 'Earlier chat' }] } as any)
    render(React.createElement(module.default, { worlds }))
    assert.match(String(find(rootHost, (node) => node.type === 'button' && nodeText(node) === 'Earlier chat')?.props.className), /text-zinc-300/)
    const rename = find(rootHost, (node) => node.type === 'button' && nodeText(node) === 'Rename')!
    assert.match(String(rename.props.className), /text-zinc-300/)
    assert.match(String(find(rootHost, (node) => node.type === 'button' && nodeText(node) === 'Delete')?.props.className), /text-zinc-300/)
    rename.props.onClick()
    render(React.createElement(module.default, { worlds }))
    assert.match(String(find(rootHost, (node) => node.type === 'button' && nodeText(node) === 'Save')?.props.className), /text-accent-light/)
    assert.match(String(find(rootHost, (node) => node.type === 'button' && nodeText(node) === 'Cancel')?.props.className), /text-zinc-300/)
    module.useAgentSessionsStore.setState({ activeSession: { id: 'session:active', title: 'Scene chat', revision: 2, attachments: [],
      messages: Array.from({ length: 5 }, (_, index) => ({ id: `message:${index}`, role: index % 2 ? 'assistant' : 'user',
        content: `Message ${index}`, attachmentIds: [], summaries: [] })) } } as any)
    for (let tick = 0; tick < 4; tick++) { await new Promise((resolve) => setTimeout(resolve, 0)); render(React.createElement(module.default, { worlds })) }
    assert.match(String(find(rootHost, (node) => node.type === 'button' && nodeText(node).includes('previous message'))?.props.className), /text-zinc-300/)
    for (const label of ['Copy', 'Good response', 'Bad response']) {
      assert.match(String(find(rootHost, (node) => node.type === 'button' && node.props.title === label)?.props.className), /text-zinc-400/)
    }
  } finally {
    render(null)
    await cleanup()
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
    else globalThis.window = previousWindow
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
    else globalThis.document = previousDocument
    globalThis.fetch = previousFetch
  }
})
