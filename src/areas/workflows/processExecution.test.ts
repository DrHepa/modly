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
