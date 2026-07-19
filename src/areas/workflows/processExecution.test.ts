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
