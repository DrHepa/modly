import assert from 'node:assert/strict'
import test from 'node:test'
import type { WFEdge, WFNode } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions'

const { buildProcessExecutionInput } = await import(new URL('./processExecution.ts', import.meta.url).href)

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
