import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyAgentResponseActions,
  canonicalWorkspaceAssetRef,
  createAppliedDirectActionIds,
  parseAgentResponseActions,
  type AgentDirectActionDependencies,
  type AgentResponseAction,
} from './agentDirectActions.ts'

const MAX_ACTION_BATCH_BYTES = 512 * 1024

function graph() {
  return {
    schema: 'modly.agent-workflow-graph' as const,
    version: 1 as const,
    name: 'Branch workflow',
    description: 'A two-branch workflow.',
    nodes: [
      { key: 'source', kind: 'builtin' as const, type: 'meshNode', enabled: true, showInGenerate: true, params: { source: 'current' } },
      { key: 'left', kind: 'extension' as const, type: 'mesh-repair/repair', enabled: true, showInGenerate: false, params: {} },
      { key: 'right', kind: 'extension' as const, type: 'mesh-repair/repair', enabled: true, showInGenerate: false, params: {} },
      { key: 'left-out', kind: 'builtin' as const, type: 'outputNode', enabled: true, showInGenerate: false, params: {} },
      { key: 'right-out', kind: 'builtin' as const, type: 'outputNode', enabled: true, showInGenerate: false, params: {} },
    ],
    edges: [
      { source: 'source', target: 'left' },
      { source: 'source', target: 'right' },
      { source: 'left', target: 'left-out' },
      { source: 'right', target: 'right-out' },
    ],
  }
}

function action(payload: Record<string, unknown>, tool = 'create_workflow'): unknown {
  return { tool, result: 'Recorded.', payload }
}

function deps(overrides: Partial<AgentDirectActionDependencies> = {}): AgentDirectActionDependencies {
  const workflow = {
    id: 'wf-1', name: 'Ready workflow', description: '', nodes: [], edges: [], createdAt: '', updatedAt: '',
  }
  return {
    originSessionId: 'session-1',
    isCurrent: () => true,
    appliedIds: createAppliedDirectActionIds(),
    createWorkflow: async () => ({ ok: true, workflow: { ...workflow } }),
    reloadWorkflows: async () => {},
    openWorkflow: () => {},
    getWorkflows: () => [workflow],
    isWorkflowBusy: () => false,
    loadExtensions: async () => {},
    getWorkflowExtensions: () => [],
    preflightWorkflow: () => [],
    startWorkflow: () => {},
    currentMeshRef: () => '/workspace/Workflows/source.glb',
    smoothMesh: async () => ({ url: '/workspace/Workflows/source_smooth1.glb' }),
    decimateMesh: async () => ({ url: '/workspace/Workflows/source_opt100.glb', faceCount: 100 }),
    updateMesh: () => {},
    unloadModels: async () => ({ success: true }),
    ...overrides,
  }
}

test('strict parser preserves full workflow DAG and enforces exact tool/payload correlation', () => {
  const exactActions = [
    action({ type: 'create_workflow', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', graph: graph() }),
    action({ type: 'run_workflow', actionId: 'direct-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', workflowId: 'wf-1', workflowName: 'Ready workflow' }, 'run_workflow'),
    action({ type: 'mesh_operation', actionId: 'direct-cccccccccccccccccccccccccccccccc', operation: 'smooth', assetRef: '/workspace/Workflows/source.glb', iterations: 20 }, 'smooth_mesh'),
    action({ type: 'mesh_operation', actionId: 'direct-dddddddddddddddddddddddddddddddd', operation: 'decimate', assetRef: '/workspace/Workflows/source.glb', targetFaces: 500000 }, 'decimate_mesh'),
    action({ type: 'models_unloaded', actionId: 'direct-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }, 'unload_models'),
  ]
  for (const exactAction of exactActions) {
    const parsed = parseAgentResponseActions([exactAction])
    assert.equal(parsed.valid, true)
    assert.equal(parsed.actions.length, 1)
    if (parsed.actions[0].payload?.type === 'create_workflow') {
      assert.deepEqual(parsed.actions[0].payload.graph, graph())
    }
  }

  for (const malformed of [
    action({ type: 'create_workflow', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', graph: graph(), extra: true }),
    action({ type: 'models_unloaded', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'smooth_mesh'),
    action({ type: 'mesh_operation', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', operation: 'smooth', assetRef: '/workspace/a.glb', iterations: 0 }, 'smooth_mesh'),
    action({ type: 'mesh_operation', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', operation: 'decimate', assetRef: '/workspace/a.glb', targetFaces: 500001 }, 'decimate_mesh'),
    action({ type: 'mesh_operation', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', operation: 'smooth', assetRef: '/workspace/%2e%2e/a.glb', iterations: 1 }, 'smooth_mesh'),
    { tool: 'smooth_mesh', result: 'old payload', payload: { type: 'mesh_update', url: '/workspace/a.glb' } },
    { kind: 'action', label: 'Restored summary' },
  ]) {
    assert.equal(parseAgentResponseActions([malformed]).valid, false)
  }
})

test('workflow graph edges reject prototype-pollution endpoints with backend parity', () => {
  for (const endpoint of ['constructor', 'prototype', '__proto__']) {
    for (const field of ['source', 'target'] as const) {
      const unsafeGraph = graph()
      unsafeGraph.edges = [{ source: 'source', target: 'left', [field]: endpoint }]
      const parsed = parseAgentResponseActions([
        action({
          type: 'create_workflow',
          actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          graph: unsafeGraph,
        }),
      ])
      assert.deepEqual(parsed, { actions: [], valid: false })
    }
  }
})

test('action batches are atomic, bounded, and contain at most one direct action', () => {
  const unloadA = action({ type: 'models_unloaded', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'unload_models')
  const unloadB = action({ type: 'models_unloaded', actionId: 'direct-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, 'unload_models')
  const createA = action({ type: 'create_workflow', actionId: 'direct-cccccccccccccccccccccccccccccccc', graph: graph() })
  const createB = action({ type: 'create_workflow', actionId: 'direct-dddddddddddddddddddddddddddddddd', graph: graph() })
  const run = action({ type: 'run_workflow', actionId: 'direct-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', workflowId: 'wf-1', workflowName: 'Ready workflow' }, 'run_workflow')

  for (const invalidBatch of [
    [unloadA, unloadB],
    [createA, createB],
    [createA, run],
    [unloadA, { tool: 'run_workflow', result: 'malformed', payload: { type: 'run_workflow', workflow_id: 7 } }],
    [{ tool: 'list_models', result: 'x'.repeat(MAX_ACTION_BATCH_BYTES), payload: null }],
  ]) {
    assert.deepEqual(parseAgentResponseActions(invalidBatch), { actions: [], valid: false })
  }

  const mixedValid = parseAgentResponseActions([
    { tool: 'list_models', result: '{}', payload: null },
    unloadA,
    { tool: 'list_processes', result: '{}', payload: null },
  ])
  assert.equal(mixedValid.valid, true)
  assert.equal(mixedValid.actions.length, 3)
})

test('canonical workspace references reject host, traversal, backslash, encoded, query and empty segments', () => {
  assert.equal(canonicalWorkspaceAssetRef('/workspace/Workflows/a.glb'), '/workspace/Workflows/a.glb')
  for (const value of [
    '/home/user/a.glb', '/workspace/../a.glb', '/workspace/%2e%2e/a.glb',
    '/workspace/a\\b.glb', '/workspace/a.glb?token=x', '/workspace/a//b.glb',
    '/workspace/a\nb.glb', '/workspace/a\u007fb.glb',
  ]) assert.equal(canonicalWorkspaceAssetRef(value), null)
})

test('action ids are reserved before invocation and never execute twice across success/error handling', async () => {
  let unloadCalls = 0
  const dependencies = deps({ unloadModels: async () => { unloadCalls += 1; return { success: true } } })
  const actions = parseAgentResponseActions([
    action({ type: 'models_unloaded', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'unload_models'),
  ]).actions

  const first = await applyAgentResponseActions(actions, dependencies)
  const replay = await applyAgentResponseActions(actions, dependencies)

  assert.equal(unloadCalls, 1)
  assert.equal(first.reflectedActions.length, 1)
  assert.equal(JSON.stringify(first.reflectedActions).includes('actionId'), false)
  assert.equal(replay.reflectedActions.length, 0)
  assert.equal(replay.failures.length, 1)
})

test('orchestrator rejects duplicate creates, repeated unloads, create plus run, and distinct ids atomically', async () => {
  const calls: string[] = []
  const dependencies = deps({
    createWorkflow: async () => { calls.push('create'); throw new Error('must not execute') },
    startWorkflow: async () => { calls.push('run') },
    unloadModels: async () => { calls.push('unload'); return { success: true } },
  })
  const createA = action({ type: 'create_workflow', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', graph: graph() }) as AgentResponseAction
  const createB = action({ type: 'create_workflow', actionId: 'direct-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', graph: graph() }) as AgentResponseAction
  const run = action({ type: 'run_workflow', actionId: 'direct-cccccccccccccccccccccccccccccccc', workflowId: 'wf-1', workflowName: 'Ready workflow' }, 'run_workflow') as AgentResponseAction
  const unloadA = action({ type: 'models_unloaded', actionId: 'direct-dddddddddddddddddddddddddddddddd' }, 'unload_models') as AgentResponseAction
  const unloadB = action({ type: 'models_unloaded', actionId: 'direct-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }, 'unload_models') as AgentResponseAction

  for (const batch of [[createA, createB], [unloadA, unloadB], [createA, run]]) {
    const result = await applyAgentResponseActions(batch, dependencies)
    assert.equal(result.reflectedActions.length, 0)
    assert.ok(result.failures.length > 0)
  }
  assert.deepEqual(calls, [])
})

test('a stale origin prevents every direct invocation and UI change', async () => {
  const calls: string[] = []
  const dependencies = deps({
    isCurrent: () => false,
    createWorkflow: async () => { calls.push('create'); throw new Error('unexpected') },
    reloadWorkflows: async () => { calls.push('reload') },
    openWorkflow: () => { calls.push('open') },
    startWorkflow: () => { calls.push('run') },
    smoothMesh: async () => { calls.push('smooth'); return { url: '/workspace/out.glb' } },
    decimateMesh: async () => { calls.push('decimate'); return { url: '/workspace/out.glb', faceCount: 100 } },
    updateMesh: () => { calls.push('update') },
    unloadModels: async () => { calls.push('unload'); return { success: true } },
  })
  const rawActions = [
    action({ type: 'create_workflow', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', graph: graph() }),
    action({ type: 'run_workflow', actionId: 'direct-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', workflowId: 'wf-1', workflowName: 'Ready workflow' }, 'run_workflow'),
    action({ type: 'mesh_operation', actionId: 'direct-cccccccccccccccccccccccccccccccc', operation: 'smooth', assetRef: '/workspace/Workflows/source.glb', iterations: 1 }, 'smooth_mesh'),
    action({ type: 'models_unloaded', actionId: 'direct-dddddddddddddddddddddddddddddddd' }, 'unload_models'),
  ]
  let failureCount = 0
  for (const rawAction of rawActions) {
    const parsed = parseAgentResponseActions([rawAction]).actions
    const result = await applyAgentResponseActions(parsed, dependencies)
    failureCount += result.failures.length
  }
  assert.deepEqual(calls, [])
  assert.equal(failureCount, 4)
})

test('create reloads and opens once without running; a switch after create prevents UI changes', async () => {
  const calls: string[] = []
  let current = true
  const dependencies = deps({
    createWorkflow: async () => { calls.push('create'); return { ok: true, workflow: { id: 'created', name: 'Branch workflow', description: '', nodes: [], edges: [], createdAt: '', updatedAt: '' } } },
    reloadWorkflows: async () => { calls.push('reload') },
    openWorkflow: (id) => { calls.push(`open:${id}`) },
    startWorkflow: () => { calls.push('run') },
  })
  const parsed = parseAgentResponseActions([
    action({ type: 'create_workflow', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', graph: graph() }),
  ]).actions
  const result = await applyAgentResponseActions(parsed, dependencies)
  assert.deepEqual(calls, ['create', 'reload', 'open:created'])
  assert.equal(result.reflectedActions[0].payload?.type, 'create_workflow')

  calls.length = 0
  const switched = deps({
    isCurrent: () => current,
    createWorkflow: async () => { calls.push('create'); current = false; return { ok: true, workflow: { id: 'created', name: 'Branch workflow', description: '', nodes: [], edges: [], createdAt: '', updatedAt: '' } } },
    reloadWorkflows: async () => { calls.push('reload') },
    openWorkflow: () => { calls.push('open') },
  })
  await applyAgentResponseActions(parsed, switched)
  assert.deepEqual(calls, ['create'])

  calls.length = 0
  current = true
  const switchedDuringReload = deps({
    isCurrent: () => current,
    createWorkflow: async () => { calls.push('create'); return { ok: true, workflow: { id: 'created', name: 'Branch workflow', description: '', nodes: [], edges: [], createdAt: '', updatedAt: '' } } },
    reloadWorkflows: async () => { calls.push('reload'); current = false },
    openWorkflow: () => { calls.push('open') },
  })
  await applyAgentResponseActions(parsed, switchedDuringReload)
  assert.deepEqual(calls, ['create', 'reload'])
})

test('run resolves exact workflow, rejects busy/missing/preflight, loads extensions, and starts once', async () => {
  const direct = parseAgentResponseActions([
    action({ type: 'run_workflow', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', workflowId: 'wf-1', workflowName: 'Ready workflow' }, 'run_workflow'),
  ]).actions
  const calls: string[] = []
  const valid = await applyAgentResponseActions(direct, deps({
    loadExtensions: async () => { calls.push('extensions') },
    preflightWorkflow: () => { calls.push('preflight'); return [] },
    startWorkflow: () => { calls.push('run') },
  }))
  assert.deepEqual(calls, ['extensions', 'preflight', 'run'])
  assert.equal(valid.failures.length, 0)

  let releaseStart!: () => void
  let markStartEntered!: () => void
  let busyAfterStart = false
  const startEntered = new Promise<void>((resolve) => { markStartEntered = resolve })
  const startRelease = new Promise<void>((resolve) => { releaseStart = resolve })
  const asyncDependencies = deps({
    isWorkflowBusy: () => busyAfterStart,
    startWorkflow: async () => {
      markStartEntered()
      await startRelease
      busyAfterStart = true
    },
  })
  let settled = false
  const pending = applyAgentResponseActions(direct, asyncDependencies).then((result) => {
    settled = true
    return result
  })
  await startEntered
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(asyncDependencies.appliedIds.has('direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true)
  assert.equal(settled, false)
  releaseStart()
  const asyncResult = await pending
  assert.equal(busyAfterStart, true)
  assert.equal(asyncResult.failures.length, 0)
  assert.equal(asyncResult.reflectedActions.length, 1)

  for (const dependencies of [
    deps({ isWorkflowBusy: () => true }),
    deps({ getWorkflows: () => [] }),
    deps({ preflightWorkflow: () => ['Missing input.'] }),
  ]) {
    const result = await applyAgentResponseActions(direct, dependencies)
    assert.equal(result.reflectedActions.length, 0)
    assert.equal(result.failures.length, 1)
  }
})

test('mesh actions require the current canonical asset and canonicalize output before UI mutation', async () => {
  const smooth = parseAgentResponseActions([
    action({ type: 'mesh_operation', actionId: 'direct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', operation: 'smooth', assetRef: '/workspace/Workflows/source.glb', iterations: 2 }, 'smooth_mesh'),
  ]).actions
  const decimate = parseAgentResponseActions([
    action({ type: 'mesh_operation', actionId: 'direct-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', operation: 'decimate', assetRef: '/workspace/Workflows/source.glb', targetFaces: 1234 }, 'decimate_mesh'),
  ]).actions
  const invocations: Array<{ operation: string, path: string, value: number }> = []
  const updates: Array<{ url: string, faceCount?: number }> = []
  const dependencies = deps({
    smoothMesh: async (path, iterations) => {
      invocations.push({ operation: 'smooth', path, value: iterations })
      return { url: '/workspace/Workflows/source_smooth1.glb' }
    },
    decimateMesh: async (path, targetFaces) => {
      invocations.push({ operation: 'decimate', path, value: targetFaces })
      return { url: '/workspace/Workflows/source_opt1234.glb', faceCount: 1234 }
    },
    updateMesh: (url, faceCount) => updates.push({ url, ...(faceCount === undefined ? {} : { faceCount }) }),
  })
  assert.equal((await applyAgentResponseActions(smooth, dependencies)).failures.length, 0)
  assert.equal((await applyAgentResponseActions(decimate, dependencies)).failures.length, 0)
  assert.deepEqual(invocations, [
    { operation: 'smooth', path: 'Workflows/source.glb', value: 2 },
    { operation: 'decimate', path: 'Workflows/source.glb', value: 1234 },
  ])
  assert.deepEqual(updates, [
    { url: '/workspace/Workflows/source_smooth1.glb' },
    { url: '/workspace/Workflows/source_opt1234.glb', faceCount: 1234 },
  ])

  const bad = await applyAgentResponseActions(smooth, deps({ smoothMesh: async () => ({ url: 'http://localhost/workspace/out.glb' }) }))
  assert.equal(bad.reflectedActions.length, 0)
  assert.equal(bad.failures.length, 1)

  let current = true
  let lateUpdates = 0
  const switched = await applyAgentResponseActions(smooth, deps({
    isCurrent: () => current,
    smoothMesh: async () => {
      current = false
      return { url: '/workspace/Workflows/source_smooth1.glb' }
    },
    updateMesh: () => { lateUpdates += 1 },
  }))
  assert.equal(switched.failures.length, 0)
  assert.equal(lateUpdates, 0)

  let currentRef = '/workspace/Workflows/source.glb'
  const replaced = await applyAgentResponseActions(smooth, deps({
    currentMeshRef: () => currentRef,
    smoothMesh: async () => {
      currentRef = '/workspace/Workflows/replacement.glb'
      return { url: '/workspace/Workflows/source_smooth1.glb' }
    },
    updateMesh: () => { lateUpdates += 1 },
  }))
  assert.equal(replaced.failures.length, 0)
  assert.equal(lateUpdates, 0)
})
