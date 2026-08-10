import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  AgentWorkflowAuthority,
  atomicWriteAgentWorkflow,
  validateAgentWorkspaceSource,
  type AgentWorkflowAuthorityDependencies,
} from './agent-workflow-authority.ts'
import type { ListedExtension } from './automation-capabilities.ts'
import {
  AGENT_WORKFLOW_GRAPH_SCHEMA,
  AGENT_WORKFLOW_GRAPH_VERSION,
  type AgentWorkflowCreateRequest,
  type AgentWorkflowGraphV1,
} from '../../src/shared/types/agentWorkflows.ts'

const SESSION_ID = 'session-a'

function extension(
  id: string,
  nodeId: string,
  options: {
    input?: string
    output?: string
    inputs?: Array<{
      name: string
      type: string
      required?: boolean
      multiple?: true
      min_items?: number
      max_items?: number
      ordered?: true
    }>
    paramsSchema?: unknown[]
  } = {},
): ListedExtension {
  return {
    type: 'process',
    id,
    name: id,
    trusted: true,
    builtin: false,
    entry: 'processor.py',
    nodes: [{
      id: nodeId,
      name: nodeId,
      input: (options.input ?? 'mesh') as never,
      output: (options.output ?? 'mesh') as never,
      ...(options.inputs ? { inputs: options.inputs as never } : {}),
      paramsSchema: options.paramsSchema ?? [],
    }],
  }
}

const BASE_EXTENSIONS: ListedExtension[] = [
  extension('mesh-repair', 'repair'),
  extension('pymeshlab', 'pymeshlab'),
  extension('image-process', 'convert', { input: 'image', output: 'mesh' }),
  extension('video-process', 'convert', { input: 'video', output: 'mesh' }),
  extension('scene-process', 'convert', { input: 'scene', output: 'mesh' }),
  extension('text-process', 'convert', { input: 'text', output: 'mesh' }),
  extension('named-process', 'combine', {
    inputs: [
      { name: 'primary', type: 'mesh', required: true },
      { name: 'reference', type: 'image', required: false },
    ],
  }),
  extension('multi-process', 'merge', {
    inputs: [{
      name: 'items',
      type: 'mesh',
      required: false,
      multiple: true,
      min_items: 0,
      max_items: 128,
      ordered: true,
    }],
  }),
  extension('limited-process', 'merge', {
    inputs: [{
      name: 'items',
      type: 'mesh',
      required: true,
      multiple: true,
      min_items: 2,
      max_items: 2,
      ordered: true,
    }],
  }),
  extension('param-process', 'configured', {
    paramsSchema: [
      { id: 'passes', label: 'Passes', type: 'int', default: 2, min: 1, max: 8 },
      { id: 'ratio', label: 'Ratio', type: 'float', default: 0.5, min: 0, max: 1 },
      { id: 'mode', label: 'Mode', type: 'select', default: 'safe', options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }] },
      { id: 'label', label: 'Label', type: 'string', default: 'mesh' },
      { id: 'preserve', label: 'Preserve', type: 'boolean', default: true },
    ],
  }),
]

function node(
  key: string,
  kind: 'builtin' | 'extension',
  type: string,
  params: Record<string, boolean | number | string> = {},
  position?: { x: number, y: number },
): AgentWorkflowGraphV1['nodes'][number] {
  return {
    key,
    kind,
    type,
    enabled: true,
    showInGenerate: false,
    params,
    ...(position ? { position } : {}),
  } as AgentWorkflowGraphV1['nodes'][number]
}

function edge(source: string, target: string, targetHandle?: string, sourceHandle?: string) {
  return {
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
    ...(targetHandle ? { targetHandle } : {}),
  }
}

function graph(
  nodes: AgentWorkflowGraphV1['nodes'],
  edges: AgentWorkflowGraphV1['edges'],
  overrides: Partial<AgentWorkflowGraphV1> = {},
): AgentWorkflowGraphV1 {
  return {
    schema: AGENT_WORKFLOW_GRAPH_SCHEMA,
    version: AGENT_WORKFLOW_GRAPH_VERSION,
    name: 'Agent workflow',
    description: 'Created by the private Agent authority.',
    nodes,
    edges,
    ...overrides,
  }
}

function request(value: AgentWorkflowGraphV1, actionId = 'action-a'): AgentWorkflowCreateRequest {
  return { actionId, originSessionId: SESSION_ID, graph: value }
}

function validBranchGraph(): AgentWorkflowGraphV1 {
  return graph([
    node('source', 'builtin', 'meshNode', { source: 'current' }, { x: 10, y: 20 }),
    node('repair-a', 'extension', 'mesh-repair/repair'),
    node('repair-b', 'extension', 'mesh-repair/repair'),
    node('sink-a', 'builtin', 'outputNode'),
    node('sink-b', 'builtin', 'addToWorldsNode'),
  ], [
    edge('source', 'repair-a'),
    edge('source', 'repair-b'),
    edge('repair-a', 'sink-a'),
    edge('repair-b', 'sink-b'),
  ])
}

function createHarness(options: {
  active?: boolean
  extensions?: ListedExtension[]
  errors?: unknown[]
  persist?: AgentWorkflowAuthorityDependencies['persistWorkflow']
  validateWorkspaceSource?: AgentWorkflowAuthorityDependencies['validateWorkspaceSource']
  actionClock?: () => number
  maxActionRecords?: number
  actionRecordTtlMs?: number
} = {}) {
  const writes: Array<{ dir: string, workflow: unknown }> = []
  let discoveries = 0
  let id = 0
  const authority = new AgentWorkflowAuthority({
    async commitIfOriginSessionActive(originSessionId, operation) {
      if (!(options.active ?? true) || originSessionId !== SESSION_ID) return 'inactive'
      try {
        await operation()
        return 'committed'
      } catch {
        return 'commit_failed'
      }
    },
    async discoverExtensions() {
      discoveries += 1
      return { extensions: options.extensions ?? BASE_EXTENSIONS, errors: options.errors ?? [] }
    },
    getWorkflowsDir: () => '/workflows',
    now: () => new Date('2026-08-09T12:00:00.000Z'),
    createId: () => `generated-${++id}`,
    validateWorkspaceSource: options.validateWorkspaceSource ?? (async () => true),
    actionClock: options.actionClock,
    maxActionRecords: options.maxActionRecords,
    actionRecordTtlMs: options.actionRecordTtlMs,
    persistWorkflow: options.persist ?? (async (dir, workflow) => {
      writes.push({ dir, workflow })
    }),
  })
  return { authority, writes, get discoveries() { return discoveries } }
}

test('Agent workflow authority accepts a branch graph, preserves bounded positions, and emits only a workflow result', async () => {
  const { authority, writes } = createHarness()
  const result = await authority.create(request(validBranchGraph()))

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.workflow.id, 'generated-1')
  assert.equal(result.workflow.createdAt, '2026-08-09T12:00:00.000Z')
  assert.equal(result.workflow.updatedAt, result.workflow.createdAt)
  assert.equal(result.workflow.nodes.length, 5)
  assert.equal(result.workflow.edges.length, 4)
  assert.deepEqual(result.workflow.nodes.find((item) => item.data.extensionId === undefined && item.type === 'meshNode')?.position, { x: 10, y: 20 })
  assert.equal(JSON.stringify(result).includes('source'), true)
  assert.equal(Object.keys(result).sort().join(','), 'ok,workflow')
  assert.equal(writes.length, 1)
})

test('Agent workflow authority accepts twelve repeated repair/pymeshlab pairs on each of two branches', async () => {
  const nodes: AgentWorkflowGraphV1['nodes'] = [node('source', 'builtin', 'meshNode', { source: 'current' })]
  const edges: AgentWorkflowGraphV1['edges'] = []
  for (const branch of ['a', 'b']) {
    let previous = 'source'
    for (let index = 0; index < 12; index += 1) {
      const repair = `${branch}-repair-${index}`
      const pymeshlab = `${branch}-pymeshlab-${index}`
      nodes.push(node(repair, 'extension', 'mesh-repair/repair'))
      nodes.push(node(pymeshlab, 'extension', 'pymeshlab/pymeshlab'))
      edges.push(edge(previous, repair), edge(repair, pymeshlab))
      previous = pymeshlab
    }
    const sink = `${branch}-sink`
    nodes.push(node(sink, 'builtin', branch === 'a' ? 'outputNode' : 'addToWorldsNode'))
    edges.push(edge(previous, sink))
  }

  const { authority, writes } = createHarness()
  const result = await authority.create(request(graph(nodes, edges)))
  assert.equal(result.ok, true)
  assert.equal(writes.length, 1)
  if (result.ok) {
    assert.equal(result.workflow.nodes.filter((item) => item.data.extensionId === 'mesh-repair/repair').length, 24)
    assert.equal(result.workflow.nodes.filter((item) => item.data.extensionId === 'pymeshlab/pymeshlab').length, 24)
  }
})

test('Agent workflow authority enforces the exact 64-node boundary and parses 128 edges before semantic rejection', async () => {
  const nodes: AgentWorkflowGraphV1['nodes'] = [node('source', 'builtin', 'meshNode', { source: 'current' })]
  for (let index = 0; index < 62; index += 1) nodes.push(node(`process-${index}`, 'extension', 'mesh-repair/repair'))
  nodes.push(node('sink', 'builtin', 'outputNode'))
  const edges: AgentWorkflowGraphV1['edges'] = []
  for (let index = 0; index < 62; index += 1) {
    edges.push(edge(index === 0 ? 'source' : `process-${index - 1}`, `process-${index}`))
  }
  edges.push(edge('process-61', 'sink'))
  assert.equal(nodes.length, 64)

  const accepted = createHarness()
  assert.equal((await accepted.authority.create(request(graph(nodes, edges)))).ok, true)
  assert.equal(accepted.writes.length, 1)

  const tooManyNodes = createHarness()
  assert.deepEqual(await tooManyNodes.authority.create(request(graph([...nodes, node('overflow', 'builtin', 'outputNode')], edges))), {
    ok: false, error: { code: 'invalid_request' },
  })
  assert.equal(tooManyNodes.writes.length, 0)

  let discoveriesAtBoundary = 0
  const exactEdgeBoundary = new AgentWorkflowAuthority({
    async commitIfOriginSessionActive(_originSessionId, operation) { await operation(); return 'committed' },
    async discoverExtensions() { discoveriesAtBoundary += 1; return { extensions: BASE_EXTENSIONS, errors: [] } },
    getWorkflowsDir: () => '/workflows',
    validateWorkspaceSource: async () => true,
    persistWorkflow: async () => undefined,
  })
  const repeatedEdges = Array.from({ length: 128 }, () => edge('source', 'sink'))
  assert.deepEqual(await exactEdgeBoundary.create(request(graph([
    node('source', 'builtin', 'meshNode', { source: 'current' }),
    node('sink', 'builtin', 'outputNode'),
  ], repeatedEdges), 'edge-boundary')), {
    ok: false, error: { code: 'graph_invalid' },
  })
  assert.equal(discoveriesAtBoundary, 1)

  const tooManyEdges = createHarness()
  assert.deepEqual(await tooManyEdges.authority.create(request(graph(nodes, Array.from({ length: 129 }, () => edge('source', 'sink'))))), {
    ok: false, error: { code: 'invalid_request' },
  })
  assert.equal(tooManyEdges.writes.length, 0)
})

test('Agent workflow authority rejects unknown, ambiguous, duplicate-key, and invalid parameter graphs without writes', async (t) => {
  const cases: Array<{ name: string, value: AgentWorkflowGraphV1, extensions?: ListedExtension[], code?: string }> = [
    {
      name: 'unknown extension node',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('unknown', 'extension', 'missing/node'), node('sink', 'builtin', 'outputNode')], [edge('source', 'unknown'), edge('unknown', 'sink')]),
    },
    {
      name: 'unknown builtin node',
      value: graph([node('source', 'builtin', 'not-a-node'), node('sink', 'builtin', 'outputNode')], [edge('source', 'sink')]),
    },
    {
      name: 'ambiguous extension node',
      value: validBranchGraph(),
      extensions: [...BASE_EXTENSIONS, extension('mesh-repair', 'repair')],
      code: 'inventory_unavailable',
    },
    {
      name: 'duplicate logical key',
      value: graph([node('same', 'builtin', 'meshNode', { source: 'current' }), node('same', 'builtin', 'outputNode')], [edge('same', 'same')]),
    },
    {
      name: 'unknown parameter',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('configured', 'extension', 'param-process/configured', { extra: true }), node('sink', 'builtin', 'outputNode')], [edge('source', 'configured'), edge('configured', 'sink')]),
    },
    {
      name: 'integer range',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('configured', 'extension', 'param-process/configured', { passes: 9 }), node('sink', 'builtin', 'outputNode')], [edge('source', 'configured'), edge('configured', 'sink')]),
    },
    {
      name: 'float finite',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('configured', 'extension', 'param-process/configured', { ratio: Number.POSITIVE_INFINITY }), node('sink', 'builtin', 'outputNode')], [edge('source', 'configured'), edge('configured', 'sink')]),
      code: 'invalid_request',
    },
    {
      name: 'select option',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('configured', 'extension', 'param-process/configured', { mode: 'unsafe' }), node('sink', 'builtin', 'outputNode')], [edge('source', 'configured'), edge('configured', 'sink')]),
    },
    {
      name: 'builtin select option',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'invalid' }), node('sink', 'builtin', 'outputNode')], [edge('source', 'sink')]),
    },
  ]

  for (const item of cases) await t.test(item.name, async () => {
    const harness = createHarness({ extensions: item.extensions })
    assert.deepEqual(await harness.authority.create(request(item.value)), {
      ok: false,
      error: { code: item.code ?? 'graph_invalid' },
    })
    assert.equal(harness.writes.length, 0)
  })
})

test('Agent workflow authority excludes untrusted extensions from workflow creation inventory', async () => {
  const untrusted = extension('untrusted-process', 'convert')
  untrusted.trusted = false
  const harness = createHarness({ extensions: [...BASE_EXTENSIONS, untrusted] })
  const value = graph([
    node('source', 'builtin', 'meshNode', { source: 'current' }),
    node('convert', 'extension', 'untrusted-process/convert'),
    node('sink', 'builtin', 'outputNode'),
  ], [edge('source', 'convert'), edge('convert', 'sink')])

  assert.deepEqual(await harness.authority.create(request(value, 'untrusted-extension')), {
    ok: false,
    error: { code: 'graph_invalid' },
  })
  assert.equal(harness.discoveries, 1)
  assert.equal(harness.writes.length, 0)
})

test('Agent workflow authority enforces builtin required, conditional, and runtime-compatible source contracts', async (t) => {
  const videoGraph = (params: Record<string, boolean | number | string>) => graph([
    node('source', 'builtin', 'videoNode', params),
    node('convert', 'extension', 'video-process/convert'),
    node('sink', 'builtin', 'outputNode'),
  ], [edge('source', 'convert'), edge('convert', 'sink')])

  await t.test('video uses the runtime videoPath key and a validated workspace reference', async () => {
    const validated: unknown[] = []
    const harness = createHarness({
      validateWorkspaceSource: async (source) => {
        validated.push(source)
        return true
      },
    })
    const result = await harness.authority.create(request(videoGraph({
      videoPath: 'Workflows/Inputs/Videos/turntable.mp4',
      displayName: 'Turntable',
    }), 'video-source'))
    assert.equal(result.ok, true)
    assert.deepEqual(validated, [{ kind: 'video', workspacePath: 'Workflows/Inputs/Videos/turntable.mp4' }])
    if (!result.ok) return
    const source = result.workflow.nodes.find((item) => item.type === 'videoNode')
    assert.deepEqual(source?.data.params, {
      displayName: 'Turntable',
      videoPath: 'Workflows/Inputs/Videos/turntable.mp4',
    })
    assert.equal(Object.hasOwn(source?.data.params ?? {}, 'workspacePath'), false)
  })

  const rejected: Array<{ name: string, value: AgentWorkflowGraphV1 }> = [
    { name: 'video missing videoPath', value: videoGraph({}) },
    { name: 'video legacy workspacePath key', value: videoGraph({ workspacePath: 'Workflows/Inputs/Videos/source.mp4' }) },
    {
      name: 'mesh file missing conditional filePath',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'file' }), node('sink', 'builtin', 'outputNode')], [edge('source', 'sink')]),
    },
    {
      name: 'mesh current forbids stale file fields',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'current', filePath: 'Workflows/Meshes/source.glb' }), node('sink', 'builtin', 'outputNode')], [edge('source', 'sink')]),
    },
    {
      name: 'mesh file fails closed even for a relative reference because runtime consumes a raw path',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'file', filePath: 'Workflows/Meshes/source.glb' }), node('sink', 'builtin', 'outputNode')], [edge('source', 'sink')]),
    },
    {
      name: 'image fails closed because runtime reads its path outside a workspace resolver',
      value: graph([node('source', 'builtin', 'imageNode', { filePath: 'Workflows/Images/source.png' }), node('convert', 'extension', 'image-process/convert'), node('sink', 'builtin', 'outputNode')], [edge('source', 'convert'), edge('convert', 'sink')]),
    },
    {
      name: 'text source requires non-empty inline content',
      value: graph([node('source', 'builtin', 'textNode', { text: '' }), node('convert', 'extension', 'text-process/convert'), node('sink', 'builtin', 'outputNode')], [edge('source', 'convert'), edge('convert', 'sink')]),
    },
    {
      name: 'scene source requires path',
      value: graph([node('source', 'builtin', 'sceneNode'), node('convert', 'extension', 'scene-process/convert'), node('sink', 'builtin', 'outputNode')], [edge('source', 'convert'), edge('convert', 'sink')]),
    },
  ]
  for (const item of rejected) await t.test(item.name, async () => {
    const harness = createHarness()
    assert.deepEqual(await harness.authority.create(request(item.value, `reject-${item.name.replaceAll(' ', '-')}`)), {
      ok: false,
      error: { code: 'graph_invalid' },
    })
    assert.equal(harness.writes.length, 0)
  })
})

test('Agent workflow authority rejects unsafe workspace source references before validation or persistence', async (t) => {
  const cases = [
    '/home/user/source.mp4',
    '../source.mp4',
    'Workflows/../source.mp4',
    String.raw`Workflows\source.mp4`,
    'https://host.test/source.mp4',
    'file:///home/user/source.mp4',
    'C:/Users/Alice/source.mp4',
    '//server/share/source.mp4',
    'Workflows/%2e%2e/source.mp4',
    'Workflows/source.mp4\nignored',
  ]
  for (const [index, videoPath] of cases.entries()) await t.test(videoPath, async () => {
    let validations = 0
    const harness = createHarness({ validateWorkspaceSource: async () => { validations += 1; return true } })
    const value = graph([
      node('source', 'builtin', 'videoNode', { videoPath }),
      node('convert', 'extension', 'video-process/convert'),
      node('sink', 'builtin', 'outputNode'),
    ], [edge('source', 'convert'), edge('convert', 'sink')])
    assert.deepEqual(await harness.authority.create(request(value, `unsafe-path-${index}`)), {
      ok: false,
      error: { code: 'graph_invalid' },
    })
    assert.equal(validations, 0)
    assert.equal(harness.writes.length, 0)
  })
})

test('Agent workflow authority requires workspace-backed video and scene sources to exist', async () => {
  const harness = createHarness({ validateWorkspaceSource: async () => false })
  const value = graph([
    node('source', 'builtin', 'sceneNode', { path: 'Scenes/missing' }),
    node('convert', 'extension', 'scene-process/convert'),
    node('sink', 'builtin', 'outputNode'),
  ], [edge('source', 'convert'), edge('convert', 'sink')])
  assert.deepEqual(await harness.authority.create(request(value, 'missing-scene')), {
    ok: false,
    error: { code: 'graph_invalid' },
  })
  assert.equal(harness.writes.length, 0)
})

test('workspace source validation resolves only real contained video files and scene manifests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-agent-workspace-'))
  try {
    await mkdir(path.join(root, 'Workflows', 'Inputs', 'Videos'), { recursive: true })
    await writeFile(path.join(root, 'Workflows', 'Inputs', 'Videos', 'source.mp4'), Uint8Array.from([1]))
    await mkdir(path.join(root, 'Scenes', 'castle'), { recursive: true })
    await writeFile(path.join(root, 'Scenes', 'castle', 'scene-manifest.json'), '{"schema":"modly.scene-manifest.v1","sceneRoot":".","assets":[]}')
    await mkdir(path.join(root, 'Scenes', 'invalid'), { recursive: true })
    await writeFile(path.join(root, 'Scenes', 'invalid', 'scene-manifest.json'), '{"schema":"wrong","sceneRoot":".","assets":[]}')

    assert.equal(await validateAgentWorkspaceSource(root, {
      kind: 'video',
      workspacePath: 'Workflows/Inputs/Videos/source.mp4',
    }), true)
    assert.equal(await validateAgentWorkspaceSource(root, {
      kind: 'scene',
      workspacePath: 'Scenes/castle',
    }), true)
    assert.equal(await validateAgentWorkspaceSource(root, {
      kind: 'scene',
      workspacePath: 'Scenes/castle/scene-manifest.json',
    }), true)
    assert.equal(await validateAgentWorkspaceSource(root, {
      kind: 'video',
      workspacePath: 'Workflows/Inputs/Videos/missing.mp4',
    }), false)
    assert.equal(await validateAgentWorkspaceSource(root, {
      kind: 'scene',
      workspacePath: 'Scenes/invalid',
    }), false)
    assert.equal(await validateAgentWorkspaceSource(root, {
      kind: 'video',
      workspacePath: '../outside.mp4',
    }), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Agent workflow authority rejects port, handle, type, unsupported multiple, and required-input violations without writes', async (t) => {
  const cases: Array<{ name: string, value: AgentWorkflowGraphV1 }> = [
    {
      name: 'missing named handle',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('target', 'extension', 'named-process/combine'), node('sink', 'builtin', 'outputNode')], [edge('source', 'target'), edge('target', 'sink')]),
    },
    {
      name: 'unknown named handle',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('target', 'extension', 'named-process/combine'), node('sink', 'builtin', 'outputNode')], [edge('source', 'target', 'missing'), edge('target', 'sink')]),
    },
    {
      name: 'source handle on unnamed output',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('sink', 'builtin', 'outputNode')], [edge('source', 'sink', undefined, 'output')]),
    },
    {
      name: 'type mismatch',
      value: graph([node('source', 'builtin', 'imageNode'), node('target', 'extension', 'mesh-repair/repair'), node('sink', 'builtin', 'outputNode')], [edge('source', 'target'), edge('target', 'sink')]),
    },
    {
      name: 'non-multiple input',
      value: graph([node('source-a', 'builtin', 'meshNode', { source: 'current' }), node('source-b', 'builtin', 'meshNode', { source: 'current' }), node('target', 'extension', 'mesh-repair/repair'), node('sink', 'builtin', 'outputNode')], [edge('source-a', 'target'), edge('source-b', 'target'), edge('target', 'sink')]),
    },
    {
      name: 'missing required input',
      value: graph([node('target', 'extension', 'named-process/combine'), node('sink', 'builtin', 'outputNode')], [edge('target', 'sink')]),
    },
    {
      name: 'declared optional multiple input is unsupported in v1',
      value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('target', 'extension', 'limited-process/merge'), node('sink', 'builtin', 'outputNode')], [edge('source', 'target', 'items'), edge('target', 'sink')]),
    },
    {
      name: 'declared multiple input is rejected even within its cardinality',
      value: graph([node('source-a', 'builtin', 'meshNode', { source: 'current' }), node('source-b', 'builtin', 'meshNode', { source: 'current' }), node('source-c', 'builtin', 'meshNode', { source: 'current' }), node('target', 'extension', 'limited-process/merge'), node('sink', 'builtin', 'outputNode')], [edge('source-a', 'target', 'items'), edge('source-b', 'target', 'items'), edge('source-c', 'target', 'items'), edge('target', 'sink')]),
    },
  ]

  for (const item of cases) await t.test(item.name, async () => {
    const harness = createHarness()
    assert.deepEqual(await harness.authority.create(request(item.value)), { ok: false, error: { code: 'graph_invalid' } })
    assert.equal(harness.writes.length, 0)
  })
})

test('Agent workflow authority enforces exact keys, safe logical ids, bounded strings, depth, and positions before discovery or writes', async (t) => {
  const base = request(validBranchGraph())
  const cases: Array<{ name: string, value: unknown }> = [
    { name: 'extra request key', value: { ...base, extra: true } },
    { name: 'extra graph key', value: { ...base, graph: { ...base.graph, extra: true } } },
    { name: 'extra node key', value: { ...base, graph: { ...base.graph, nodes: [{ ...base.graph.nodes[0], extra: true }, ...base.graph.nodes.slice(1)] } } },
    { name: 'unsafe action id', value: { ...base, actionId: '../action' } },
    { name: 'unsafe logical key', value: { ...base, graph: { ...base.graph, nodes: [{ ...base.graph.nodes[0], key: '../source' }, ...base.graph.nodes.slice(1)] } } },
    { name: 'overlong name', value: { ...base, graph: { ...base.graph, name: 'x'.repeat(121) } } },
    { name: 'non-finite position', value: { ...base, graph: { ...base.graph, nodes: [{ ...base.graph.nodes[0], position: { x: Number.NaN, y: 0 } }, ...base.graph.nodes.slice(1)] } } },
    { name: 'out-of-bounds position', value: { ...base, graph: { ...base.graph, nodes: [{ ...base.graph.nodes[0], position: { x: 1_000_001, y: 0 } }, ...base.graph.nodes.slice(1)] } } },
    { name: 'nested parameter value', value: { ...base, graph: { ...base.graph, nodes: [{ ...base.graph.nodes[0], params: { source: { nested: true } } }, ...base.graph.nodes.slice(1)] } } },
    { name: 'excessive JSON depth', value: { ...base, graph: { ...base.graph, nodes: [{ ...base.graph.nodes[0], params: { source: [[[[[[[[['current']]]]]]]]] } }, ...base.graph.nodes.slice(1)] } } },
  ]
  for (const item of cases) await t.test(item.name, async () => {
    let discoveries = 0
    let writes = 0
    const authority = new AgentWorkflowAuthority({
      async commitIfOriginSessionActive(_originSessionId, operation) { await operation(); return 'committed' },
      async discoverExtensions() { discoveries += 1; return { extensions: BASE_EXTENSIONS, errors: [] } },
      getWorkflowsDir: () => '/workflows',
      validateWorkspaceSource: async () => true,
      persistWorkflow: async () => { writes += 1 },
    })
    assert.deepEqual(await authority.create(item.value), { ok: false, error: { code: 'invalid_request' } })
    assert.equal(discoveries, 0)
    assert.equal(writes, 0)
  })
})

test('Agent workflow authority rejects dangling, self, duplicate, cycle, orphan, source-less, and sink-less graphs without writes', async (t) => {
  const cases: Array<{ name: string, value: AgentWorkflowGraphV1 }> = [
    { name: 'dangling', value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('sink', 'builtin', 'outputNode')], [edge('source', 'missing')]) },
    { name: 'self edge', value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('sink', 'builtin', 'outputNode')], [edge('source', 'source'), edge('source', 'sink')]) },
    { name: 'duplicate edge', value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('sink', 'builtin', 'outputNode')], [edge('source', 'sink'), edge('source', 'sink')]) },
    { name: 'cycle', value: graph([node('a', 'extension', 'multi-process/merge'), node('b', 'extension', 'multi-process/merge')], [edge('a', 'b', 'items'), edge('b', 'a', 'items')]) },
    { name: 'orphan component', value: graph([node('source-a', 'builtin', 'meshNode', { source: 'current' }), node('sink-a', 'builtin', 'outputNode'), node('source-b', 'builtin', 'meshNode', { source: 'current' }), node('sink-b', 'builtin', 'addToWorldsNode')], [edge('source-a', 'sink-a'), edge('source-b', 'sink-b')]) },
    { name: 'no declared source', value: graph([node('process', 'extension', 'mesh-repair/repair'), node('sink', 'builtin', 'outputNode')], [edge('process', 'sink')]) },
    { name: 'no declared sink', value: graph([node('source', 'builtin', 'meshNode', { source: 'current' }), node('process', 'extension', 'mesh-repair/repair')], [edge('source', 'process')]) },
  ]

  for (const item of cases) await t.test(item.name, async () => {
    const harness = createHarness()
    assert.deepEqual(await harness.authority.create(request(item.value)), { ok: false, error: { code: 'graph_invalid' } })
    assert.equal(harness.writes.length, 0)
  })
})

test('Agent workflow authority uses deterministic topological layout, generated ids, hydrated defaults, and stable serialization', async () => {
  const value = graph([
    node('sink', 'builtin', 'outputNode'),
    node('configured', 'extension', 'param-process/configured', { mode: 'fast' }),
    node('source', 'builtin', 'meshNode', { source: 'current' }),
  ], [edge('configured', 'sink'), edge('source', 'configured')])
  const first = createHarness()
  const second = createHarness()
  const resultA = await first.authority.create(request(value))
  const resultB = await second.authority.create(request(value))
  assert.deepEqual(resultA, resultB)
  assert.equal(JSON.stringify(first.writes[0]?.workflow), JSON.stringify(second.writes[0]?.workflow))
  if (!resultA.ok) return
  assert.deepEqual(resultA.workflow.nodes.map((item) => [item.id, item.position]), [
    ['generated-2', { x: 0, y: 0 }],
    ['generated-3', { x: 320, y: 0 }],
    ['generated-4', { x: 640, y: 0 }],
  ])
  assert.deepEqual(resultA.workflow.nodes[1]?.data.params, {
    label: 'mesh',
    mode: 'fast',
    passes: 2,
    preserve: true,
    ratio: 0.5,
  })
})

test('Agent workflow authority rejects selected multiple ports because runtime cannot represent their arrays', async () => {
  const value = graph([
    node('source-a', 'builtin', 'meshNode', { source: 'current' }),
    node('source-b', 'builtin', 'meshNode', { source: 'current' }),
    node('target', 'extension', 'limited-process/merge'),
    node('sink', 'builtin', 'outputNode'),
  ], [
    edge('source-b', 'target', 'items'),
    edge('source-a', 'target', 'items'),
    edge('target', 'sink'),
  ])
  const { authority, writes } = createHarness()
  const result = await authority.create(request(value))
  assert.deepEqual(result, { ok: false, error: { code: 'graph_invalid' } })
  assert.equal(writes.length, 0)
})

test('Agent workflow authority is origin-bound and fails closed on inventory errors', async () => {
  const inactive = createHarness({ active: false })
  assert.deepEqual(await inactive.authority.create(request(validBranchGraph())), { ok: false, error: { code: 'origin_inactive' } })
  assert.equal(inactive.writes.length, 0)

  const unavailable = createHarness({ errors: [{ code: 'MANIFEST_INVALID', privatePath: '/private/manifest' }] })
  assert.deepEqual(await unavailable.authority.create(request(validBranchGraph())), { ok: false, error: { code: 'inventory_unavailable' } })
  assert.equal(unavailable.writes.length, 0)
})

test('Agent workflow authority deduplicates identical concurrent and replayed action ids, and rejects conflicting reuse', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let writes = 0
  const harness = createHarness({
    persist: async () => {
      writes += 1
      await gate
    },
  })
  const first = harness.authority.create(request(validBranchGraph(), 'same-action'))
  const concurrent = harness.authority.create(request(validBranchGraph(), 'same-action'))
  const conflicting = await harness.authority.create(request(graph([
    node('source', 'builtin', 'meshNode', { source: 'current' }),
    node('sink', 'builtin', 'outputNode'),
  ], [edge('source', 'sink')]), 'same-action'))
  assert.deepEqual(conflicting, { ok: false, error: { code: 'invalid_request' } })
  release()
  const [firstResult, concurrentResult] = await Promise.all([first, concurrent])
  assert.deepEqual(firstResult, concurrentResult)
  assert.equal(writes, 1)
  assert.deepEqual(await harness.authority.create(request(validBranchGraph(), 'same-action')), firstResult)
  assert.equal(writes, 1)
})

test('Agent workflow authority expires settled idempotency records exactly at TTL while preserving the window', async () => {
  const clock = { now: 0 }
  let writes = 0
  const harness = createHarness({
    actionClock: () => clock.now,
    maxActionRecords: 2,
    actionRecordTtlMs: 100,
    persist: async () => { writes += 1 },
  })
  const original = await harness.authority.create(request(validBranchGraph(), 'ttl-action'))
  assert.equal(original.ok, true)
  assert.equal(writes, 1)

  clock.now = 99
  assert.deepEqual(await harness.authority.create(request(validBranchGraph(), 'ttl-action')), original)
  assert.equal(writes, 1)
  assert.deepEqual(await harness.authority.create(request(graph([
    node('source', 'builtin', 'meshNode', { source: 'current' }),
    node('sink', 'builtin', 'outputNode'),
  ], [edge('source', 'sink')]), 'ttl-action')), { ok: false, error: { code: 'invalid_request' } })

  clock.now = 100
  const afterTtl = await harness.authority.create(request(graph([
    node('source', 'builtin', 'meshNode', { source: 'current' }),
    node('sink', 'builtin', 'outputNode'),
  ], [edge('source', 'sink')]), 'ttl-action'))
  assert.equal(afterTtl.ok, true)
  assert.equal(writes, 2)
})

test('Agent workflow authority uses settled-record LRU and never evicts an in-flight action', async () => {
  const clock = { now: 0 }
  let writes = 0
  const settled = createHarness({
    actionClock: () => clock.now,
    maxActionRecords: 2,
    actionRecordTtlMs: 1_000,
    persist: async () => { writes += 1 },
  })
  await settled.authority.create(request(validBranchGraph(), 'lru-a'))
  clock.now = 1
  await settled.authority.create(request(validBranchGraph(), 'lru-b'))
  clock.now = 2
  await settled.authority.create(request(validBranchGraph(), 'lru-a'))
  clock.now = 3
  await settled.authority.create(request(validBranchGraph(), 'lru-c'))
  assert.equal(writes, 3)
  clock.now = 4
  await settled.authority.create(request(validBranchGraph(), 'lru-a'))
  assert.equal(writes, 3)
  await settled.authority.create(request(validBranchGraph(), 'lru-b'))
  assert.equal(writes, 4)

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let inFlightWrites = 0
  const inFlight = createHarness({
    maxActionRecords: 1,
    actionRecordTtlMs: 1_000,
    persist: async () => { inFlightWrites += 1; await gate },
  })
  const first = inFlight.authority.create(request(validBranchGraph(), 'in-flight'))
  assert.deepEqual(await inFlight.authority.create(request(validBranchGraph(), 'second-action')), {
    ok: false,
    error: { code: 'invalid_request' },
  })
  const duplicate = inFlight.authority.create(request(validBranchGraph(), 'in-flight'))
  release()
  assert.deepEqual(await duplicate, await first)
  assert.equal(inFlightWrites, 1)
})

test('Agent workflow authority validates the active origin inside the commit transaction', async () => {
  let activeSession = SESSION_ID
  let releaseDiscovery!: () => void
  let discoveryStarted!: () => void
  const started = new Promise<void>((resolve) => { discoveryStarted = resolve })
  const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve })
  let writes = 0
  const authority = new AgentWorkflowAuthority({
    async commitIfOriginSessionActive(originSessionId, operation) {
      if (originSessionId !== activeSession) return 'inactive'
      await operation()
      return 'committed'
    },
    async discoverExtensions() {
      discoveryStarted()
      await discoveryGate
      return { extensions: BASE_EXTENSIONS, errors: [] }
    },
    getWorkflowsDir: () => '/workflows',
    validateWorkspaceSource: async () => true,
    persistWorkflow: async () => { writes += 1 },
  })
  const pending = authority.create(request(validBranchGraph(), 'origin-race'))
  await started
  activeSession = 'session-b'
  releaseDiscovery()
  assert.deepEqual(await pending, { ok: false, error: { code: 'origin_inactive' } })
  assert.equal(writes, 0)
})

test('atomic Agent workflow persistence publishes without clobber and removes failed temp files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modly-agent-workflow-'))
  try {
    const accepted = createHarness()
    const created = await accepted.authority.create(request(validBranchGraph()))
    assert.equal(created.ok, true)
    if (!created.ok) return
    await atomicWriteAgentWorkflow(root, created.workflow, { createTempId: () => 'temp-success' })
    const file = path.join(root, `${created.workflow.id}.json`)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), created.workflow)
    assert.deepEqual((await readdir(root)).sort(), [`${created.workflow.id}.json`])

    await assert.rejects(() => atomicWriteAgentWorkflow(root, { ...created.workflow, id: 'failed-workflow' }, {
      createTempId: () => 'temp-failure',
      link: async () => { throw new Error('publish failed at /private/path') },
    }), /publish failed/)
    assert.deepEqual((await readdir(root)).sort(), [`${created.workflow.id}.json`])

    await writeFile(file, 'sentinel-do-not-overwrite')
    await assert.rejects(
      () => atomicWriteAgentWorkflow(root, created.workflow, { createTempId: () => 'temp-collision' }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
    )
    assert.equal(await readFile(file, 'utf8'), 'sentinel-do-not-overwrite')
    assert.deepEqual((await readdir(root)).sort(), [`${created.workflow.id}.json`])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('atomic Agent workflow persistence reconciles post-publication cleanup and directory sync failures', async (t) => {
  const accepted = createHarness()
  const created = await accepted.authority.create(request(validBranchGraph(), 'post-publication-fixture'))
  assert.equal(created.ok, true)
  if (!created.ok) return

  await t.test('persistent owned-temp removal failure remains a reported bounded cleanup issue and caches success', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'modly-agent-workflow-rm-'))
    try {
      let persistenceCalls = 0
      let removeAttempts = 0
      const issues: string[] = []
      const harness = createHarness({
        persist: async (_dir, workflow) => {
          persistenceCalls += 1
          await atomicWriteAgentWorkflow(root, workflow, {
            createTempId: () => 'temp-rm-failure',
            remove: async () => {
              removeAttempts += 1
              throw Object.assign(new Error('simulated remove failure'), { code: 'EPERM' })
            },
            onPostPublishIssue: (issue: { code: string }) => { issues.push(issue.code) },
          })
        },
      })

      const first = await harness.authority.create(request(validBranchGraph(), 'published-rm-action'))
      assert.equal(first.ok, true)
      assert.deepEqual(await harness.authority.create(request(validBranchGraph(), 'published-rm-action')), first)
      assert.equal(persistenceCalls, 1)
      assert.equal(removeAttempts, 3)
      assert.deepEqual(issues, ['temp_cleanup_failed'])
      assert.deepEqual(JSON.parse(await readFile(path.join(root, 'generated-1.json'), 'utf8')), first.ok ? first.workflow : undefined)
      assert.deepEqual((await readdir(root)).sort(), ['.generated-1.temp-rm-failure.tmp', 'generated-1.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  await t.test('unsupported directory fsync reports durability degradation without changing the published result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'modly-agent-workflow-fsync-'))
    try {
      const issues: string[] = []
      await atomicWriteAgentWorkflow(root, { ...created.workflow, id: 'fsync-published' }, {
        createTempId: () => 'temp-fsync-failure',
        syncDirectory: async () => {
          throw Object.assign(new Error('directory fsync unsupported'), { code: 'EINVAL' })
        },
        onPostPublishIssue: (issue: { code: string }) => { issues.push(issue.code) },
      })
      assert.deepEqual(issues, ['directory_sync_failed'])
      assert.deepEqual(
        JSON.parse(await readFile(path.join(root, 'fsync-published.json'), 'utf8')),
        { ...created.workflow, id: 'fsync-published' },
      )
      assert.deepEqual((await readdir(root)).sort(), ['fsync-published.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('Agent workflow request bounds reject oversized shallow containers before reading their contents', async () => {
  const base = request(validBranchGraph()) as unknown as Record<string, unknown>
  let nodeRead = false
  const nodes = new Array(65)
  Object.defineProperty(nodes, 0, { enumerable: true, get() { nodeRead = true; throw new Error('must not read node') } })
  const oversizedNodes = {
    ...base,
    graph: { ...(base.graph as Record<string, unknown>), nodes },
  }
  const first = createHarness()
  assert.deepEqual(await first.authority.create(oversizedNodes), { ok: false, error: { code: 'invalid_request' } })
  assert.equal(nodeRead, false)

  let paramRead = false
  const params: Record<string, unknown> = {}
  for (let index = 0; index < 65; index += 1) {
    Object.defineProperty(params, `key${index}`, {
      enumerable: true,
      get() { paramRead = true; throw new Error('must not read param') },
    })
  }
  const graphValue = validBranchGraph()
  const oversizedParams = request({
    ...graphValue,
    nodes: [{ ...graphValue.nodes[0], params }, ...graphValue.nodes.slice(1)],
  } as AgentWorkflowGraphV1, 'oversized-params')
  const second = createHarness()
  assert.deepEqual(await second.authority.create(oversizedParams), { ok: false, error: { code: 'invalid_request' } })
  assert.equal(paramRead, false)

  let extraRead = false
  const withExtra = Object.defineProperty({ ...base }, 'extra', {
    enumerable: true,
    get() { extraRead = true; throw new Error('must not read extra') },
  })
  const third = createHarness()
  assert.deepEqual(await third.authority.create(withExtra), { ok: false, error: { code: 'invalid_request' } })
  assert.equal(extraRead, false)

  const hiddenExtra = Object.defineProperty({ ...base }, 'hidden', { enumerable: false, value: true })
  const fourth = createHarness()
  assert.deepEqual(await fourth.authority.create(hiddenExtra), { ok: false, error: { code: 'invalid_request' } })
})

test('Agent workflow request parsing rejects sparse node and edge arrays before inventory discovery', async (t) => {
  await t.test('sparse nodes', async () => {
    const value = validBranchGraph()
    const sparseNodes = new Array<AgentWorkflowGraphV1['nodes'][number]>(value.nodes.length)
    for (let index = 0; index < value.nodes.length; index += 1) {
      if (index !== 1) sparseNodes[index] = value.nodes[index]!
    }
    const harness = createHarness()
    assert.deepEqual(await harness.authority.create(request({ ...value, nodes: sparseNodes }, 'sparse-nodes')), {
      ok: false,
      error: { code: 'invalid_request' },
    })
    assert.equal(harness.discoveries, 0)
    assert.equal(harness.writes.length, 0)
  })

  await t.test('sparse edges', async () => {
    const value = validBranchGraph()
    const sparseEdges = new Array<AgentWorkflowGraphV1['edges'][number]>(value.edges.length)
    for (let index = 0; index < value.edges.length; index += 1) {
      if (index !== 1) sparseEdges[index] = value.edges[index]!
    }
    const harness = createHarness()
    assert.deepEqual(await harness.authority.create(request({ ...value, edges: sparseEdges }, 'sparse-edges')), {
      ok: false,
      error: { code: 'invalid_request' },
    })
    assert.equal(harness.discoveries, 0)
    assert.equal(harness.writes.length, 0)
  })
})

test('Agent workflow authority sanitizes persistence failures and never returns a partially trusted workflow', async () => {
  const harness = createHarness({ persist: async () => { throw new Error('disk failed at /private/workflows') } })
  const result = await harness.authority.create(request(validBranchGraph()))
  assert.deepEqual(result, { ok: false, error: { code: 'write_failed' } })
  assert.equal(JSON.stringify(result).includes('/private'), false)
})
