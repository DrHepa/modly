import assert from 'node:assert/strict'
import test from 'node:test'
import type { WFEdge, WFNode } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions'

const { buildProcessExecutionInput, getWorkflowNodeOutputKey } = await import(new URL('./processExecution.ts', import.meta.url).href)

function createNode(id: string, type: WFNode['type'], data: WFNode['data'] = { enabled: true, params: {} }): WFNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
  }
}

function createProcessExtension(inputs?: WorkflowExtension['inputs']): WorkflowExtension {
  return {
    id: 'ext/refiner',
    extensionId: 'ext',
    extensionName: 'Refiner',
    extensionAuthor: 'Tests',
    nodeId: 'refiner',
    name: 'Refiner',
    description: 'Refines inputs',
    input: 'image',
    output: 'mesh',
    ...(inputs ? { inputs } : {}),
    params: [],
    builtin: false,
    type: 'process',
  }
}

test('builds named inputs from target handles for multi-input process nodes', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const image = createNode('image-source', 'imageNode')
  const mesh = createNode('mesh-source', 'meshNode')
  const edges: WFEdge[] = [
    { id: 'edge-image', source: 'image-source', target: 'target-node', targetHandle: 'reference_image' },
    { id: 'edge-mesh', source: 'mesh-source', target: 'target-node', targetHandle: 'coarse_mesh' },
  ]

  const input = buildProcessExecutionInput({
    node: target,
    nodes: [image, mesh, target],
    edges,
    allExtensions: [createProcessExtension([
      { name: 'reference_image', type: 'image' },
      { name: 'coarse_mesh', type: 'mesh' },
    ])],
    nodeOutputs: new Map([
      ['image-source', { filePath: '/tmp/reference.png' }],
      ['mesh-source', { filePath: '/tmp/coarse.glb' }],
    ]),
  })

  assert.deepEqual(input, {
    nodeId: 'refiner',
    inputs: {
      reference_image: {
        type: 'image',
        filePath: '/tmp/reference.png',
        sourceNodeId: 'image-source',
      },
      coarse_mesh: {
        type: 'mesh',
        filePath: '/tmp/coarse.glb',
        sourceNodeId: 'mesh-source',
      },
    },
  })
})

test('preserves legacy payload fallback when inputs[] is absent', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })

  const input = buildProcessExecutionInput({
    node: target,
    nodes: [target],
    edges: [],
    allExtensions: [createProcessExtension()],
    nodeOutputs: new Map(),
    previousNodeOutput: { filePath: '/tmp/previous.glb', text: 'legacy text' },
  })

  assert.deepEqual(input, {
    filePath: '/tmp/previous.glb',
    text: 'legacy text',
    nodeId: 'refiner',
  })
})

test('omits missing named inputs without falling back to legacy top-level payload fields', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const image = createNode('image-source', 'imageNode')

  const input = buildProcessExecutionInput({
    node: target,
    nodes: [image, target],
    edges: [
      { id: 'edge-image', source: 'image-source', target: 'target-node', targetHandle: 'reference_image' },
    ],
    allExtensions: [createProcessExtension([
      { name: 'reference_image', type: 'image' },
      { name: 'coarse_mesh', type: 'mesh' },
    ])],
    nodeOutputs: new Map([
      ['image-source', { filePath: '/tmp/reference.png' }],
    ]),
    previousNodeOutput: { filePath: '/tmp/should-not-leak.glb' },
  })

  assert.deepEqual(input, {
    nodeId: 'refiner',
    inputs: {
      reference_image: {
        type: 'image',
        filePath: '/tmp/reference.png',
        sourceNodeId: 'image-source',
      },
    },
  })
  assert.equal('filePath' in input, false)
  assert.equal('text' in input, false)
})

test('preserves reordered positional text slots, secondary gaps, mesh precedence and audio inputs', () => {
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const types = ['image', 'text', 'image', 'mesh', 'text', 'audio']
  const nodes = [target, createNode('image', 'imageNode'), createNode('mesh', 'meshNode'), createNode('text', 'textNode')]
  const outputs = new Map([['image', { filePath: '/reference.png' }], ['mesh', { filePath: '/coarse.glb' }], ['text', { text: 'negative' }]])
  const edges = [
    { id: 't', source: 'text', target: 'target', targetHandle: 'input-4' },
    { id: 'm', source: 'mesh', target: 'target', targetHandle: 'input-3' },
    { id: 'i', source: 'image', target: 'target', targetHandle: 'input-2' },
  ]
  for (const orderedEdges of [edges, [...edges].reverse()]) {
    const input = buildProcessExecutionInput({ node: target, nodes, edges: orderedEdges, allExtensions: [createProcessExtension(types)], nodeOutputs: outputs })
    assert.equal(input.filePath, '/coarse.glb')
    assert.equal(input.text, 'negative')
    assert.equal(input.texts?.length, 5)
    assert.equal(input.texts?.[1], undefined)
    assert.equal(input.texts?.[4], 'negative')
    assert.equal(input.inputs, undefined)
  }
  const audio = buildProcessExecutionInput({ node: target, nodes, edges: [{ id: 'a', source: 'audio', target: 'target', targetHandle: 'input-5' }], allExtensions: [createProcessExtension(types)], nodeOutputs: new Map([['audio', { filePath: '/sound.wav' }]]) })
  assert.equal(audio.filePath, '/sound.wav')
})

test('named bindings resolve Wait sources and retain the actual artifact kind and source identity', () => {
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const source = createNode('source', 'forEachNode', { enabled: true, params: { mode: 'mesh' } })
  const wait = createNode('wait', 'waitNode')
  const input = buildProcessExecutionInput({ node: target, nodes: [source, wait, target], edges: [
    { id: 'a', source: 'source', target: 'wait' },
    { id: 'b', source: 'wait', target: 'target', targetHandle: 'coarse_mesh' },
  ], allExtensions: [createProcessExtension([{ name: 'coarse_mesh', type: 'mesh' }])], nodeOutputs: new Map([['source', { filePath: '/mesh.glb', outputType: 'mesh' }]]) })
  assert.deepEqual(input.inputs?.coarse_mesh, { type: 'mesh', sourceNodeId: 'source', filePath: '/mesh.glb' })
})

test('runtime process input stops at materialized checkpoints without changing structural sources', () => {
  const source = createNode('source', 'meshNode')
  const wait = createNode('wait', 'waitNode')
  const preview = createNode('preview', 'imagePreviewNode')
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const edges = [
    { id: 'a', source: 'source', target: 'wait' },
    { id: 'b', source: 'wait', target: 'preview' },
    { id: 'c', source: 'preview', target: 'target', targetHandle: 'coarse_mesh' },
  ]
  const outputs = new Map([['source', { filePath: '/source.glb', outputType: 'mesh' }], ['wait', { filePath: '/edited.glb', outputType: 'mesh' }]])
  const result = buildProcessExecutionInput({ node: target, nodes: [source, wait, preview, target], edges, allExtensions: [createProcessExtension([{ name: 'coarse_mesh', type: 'mesh' }])], nodeOutputs: outputs })
  assert.equal(result.inputs?.coarse_mesh.filePath, '/edited.glb')
  assert.equal(result.inputs?.coarse_mesh.sourceNodeId, 'wait')
  assert.equal(outputs.get('source')?.filePath, '/source.glb')
})

test('scene-bearing positional PROCESS keeps every original slot and resolved source in an additive map', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const scenes = [createNode('a', 'sceneNode'), createNode('b', 'sceneNode')]
  const text = createNode('prompt', 'textNode')
  const edges: WFEdge[] = [
    { id: 'b', source: 'b', target: target.id, targetHandle: 'input-2' },
    { id: 'p', source: 'prompt', target: target.id, targetHandle: 'input-1' },
    { id: 'a', source: 'a', target: target.id, targetHandle: 'input-0' },
  ]
  const args = { node: target, nodes: [...scenes, text, target], edges,
    allExtensions: [{ ...createProcessExtension(['scene', 'text', 'scene']), input: 'scene', output: 'scene' }],
    nodeOutputs: new Map([
      ['a', { filePath: '/workspace/a/scene-manifest.json', outputType: 'scene' }],
      ['b', { filePath: '/workspace/b/scene-manifest.json', outputType: 'scene' }],
      ['prompt', { text: 'combine', outputType: 'text' }],
    ]) }
  const payload = buildProcessExecutionInput(args)
  assert.deepEqual(payload, buildProcessExecutionInput({ ...args, edges: [...edges].reverse() }))
  assert.deepEqual(payload.inputs, {
    'input-0': { type: 'scene', filePath: '/workspace/a/scene-manifest.json', sourceNodeId: 'a' },
    'input-1': { type: 'text', text: 'combine', sourceNodeId: 'prompt' },
    'input-2': { type: 'scene', filePath: '/workspace/b/scene-manifest.json', sourceNodeId: 'b' },
  })
  assert.equal(payload.filePath, '/workspace/a/scene-manifest.json')
  assert.equal(payload.texts?.[1], 'combine')
})


test('selects a named model output by sourceHandle and keeps null-handle primary fallback', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const source = createNode('model-source', 'extensionNode', { extensionId: 'vision/analyze', enabled: true, params: {} })
  const sourceExtension: WorkflowExtension = {
    id: 'vision/analyze',
    extensionId: 'vision',
    extensionName: 'Vision',
    extensionAuthor: 'Tests',
    nodeId: 'analyze',
    name: 'Analyze',
    description: '',
    input: 'image',
    output: 'image',
    ioContract: 'named-v1',
    outputs: [
      { name: 'image', type: 'image' },
      { name: 'caption', type: 'text' },
    ],
    params: [],
    builtin: false,
    type: 'model',
  }
  const nodeOutputs = new Map([
    ['model-source', { filePath: '/tmp/primary.png' }],
    [getWorkflowNodeOutputKey('model-source', 'caption'), { text: 'named caption' }],
  ])

  const named = buildProcessExecutionInput({
    node: target,
    nodes: [source, target],
    edges: [{ id: 'named', source: source.id, sourceHandle: 'caption', target: target.id, targetHandle: 'prompt' }],
    allExtensions: [sourceExtension, createProcessExtension([{ name: 'prompt', type: 'text' }])],
    nodeOutputs,
  })
  assert.deepEqual(named.inputs?.prompt, {
    type: 'text',
    text: 'named caption',
    sourceNodeId: 'model-source',
  })

  const primary = buildProcessExecutionInput({
    node: target,
    nodes: [source, target],
    edges: [{ id: 'primary', source: source.id, target: target.id, targetHandle: 'reference_image' }],
    allExtensions: [sourceExtension, createProcessExtension([{ name: 'reference_image', type: 'image' }])],
    nodeOutputs,
  })
  assert.equal(primary.inputs?.reference_image.filePath, '/tmp/primary.png')
})


test('falls back to the primary output for stale or legacy source handles', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const source = createNode('source-node', 'extensionNode', { extensionId: 'vision/analyze', enabled: true, params: {} })
  const namedSource: WorkflowExtension = {
    id: 'vision/analyze', extensionId: 'vision', extensionName: 'Vision', extensionAuthor: 'Tests',
    nodeId: 'analyze', name: 'Analyze', description: '', input: 'image', output: 'image',
    ioContract: 'named-v1', outputs: [{ name: 'image', type: 'image' }],
    params: [], builtin: false, type: 'model',
  }
  const legacySource: WorkflowExtension = { ...namedSource, id: 'vision/legacy', nodeId: 'legacy', ioContract: undefined, outputs: undefined }
  const nodeOutputs = new Map([['source-node', { filePath: '/tmp/primary.png' }]])

  const named = buildProcessExecutionInput({
    node: target, nodes: [source, target],
    edges: [{ id: 'unknown', source: source.id, sourceHandle: 'missing', target: target.id, targetHandle: 'reference_image' }],
    allExtensions: [namedSource, createProcessExtension([{ name: 'reference_image', type: 'image' }])],
    nodeOutputs,
  })
  assert.equal(named.inputs?.reference_image.filePath, '/tmp/primary.png')

  source.data.extensionId = legacySource.id
  const legacy = buildProcessExecutionInput({
    node: target, nodes: [source, target],
    edges: [{ id: 'legacy', source: source.id, sourceHandle: 'old-source-handle', target: target.id, targetHandle: 'reference_image' }],
    allExtensions: [legacySource, createProcessExtension([{ name: 'reference_image', type: 'image' }])],
    nodeOutputs,
  })
  assert.equal(legacy.inputs?.reference_image.filePath, '/tmp/primary.png')
})


test('named outputs retain literal output handles, open types and materialized Wait ownership', () => {
  const source = createNode('source', 'extensionNode', { extensionId: 'vision/named', enabled: true, params: {} })
  const wait = createNode('wait', 'waitNode')
  const preview = createNode('preview', 'imagePreviewNode')
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const extension: WorkflowExtension = {
    ...createProcessExtension(), id: 'vision/named', type: 'model', ioContract: 'named-v1',
    outputs: [{ name: 'primary', type: 'image' }, { name: 'output', type: 'capture' }],
  }
  const primary = { filePath: '/primary.png', outputType: 'image' }
  const secondary = { filePath: '/secondary.capture', outputType: 'capture' }
  const outputs = new Map([
    ['source', primary], [getWorkflowNodeOutputKey('source', 'output'), secondary],
  ])
  const edges: WFEdge[] = [
    { id: 'source-wait', source: source.id, sourceHandle: 'output', target: wait.id },
    { id: 'wait-preview', source: wait.id, target: preview.id },
    { id: 'preview-target', source: preview.id, target: target.id, targetHandle: 'capture' },
  ]
  const args = { node: target, nodes: [source, wait, preview, target], edges,
    allExtensions: [extension, createProcessExtension([{ name: 'capture', type: 'capture' }])], nodeOutputs: outputs }
  const original = buildProcessExecutionInput(args)
  assert.deepEqual(original.inputs?.capture, { type: 'capture', sourceNodeId: 'source', filePath: '/secondary.capture' })
  outputs.set('wait', { filePath: '/edited.capture', outputType: 'capture' })
  const materialized = buildProcessExecutionInput(args)
  assert.deepEqual(materialized.inputs?.capture, { type: 'capture', sourceNodeId: 'wait', filePath: '/edited.capture' })
  assert.equal(outputs.get('source'), primary)
  assert.equal(outputs.get(getWorkflowNodeOutputKey('source', 'output')), secondary)
})
