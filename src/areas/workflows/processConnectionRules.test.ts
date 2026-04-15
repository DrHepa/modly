import assert from 'node:assert/strict'
import test from 'node:test'
import type { Connection } from '@xyflow/react'
import type { WFEdge, WFNode } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions'
const {
  validateProcessConnection,
  validateWorkflowProcessRun,
} = await import(new URL('./processConnectionRules.ts', import.meta.url).href)

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

function createConnection(overrides: Partial<Connection>): Connection {
  return {
    source: 'source-node',
    target: 'target-node',
    sourceHandle: null,
    targetHandle: null,
    ...overrides,
  }
}

test('rejects connect-time type mismatches with port metadata', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const source = createNode('source-node', 'meshNode')

  const issue = validateProcessConnection({
    connection: createConnection({ targetHandle: 'reference_image' }),
    nodes: [source, target],
    edges: [],
    allExtensions: [createProcessExtension([
      { name: 'reference_image', type: 'image' },
      { name: 'coarse_mesh', type: 'mesh' },
    ])],
  })

  assert.deepEqual(issue, {
    phase: 'connect',
    code: 'type-mismatch',
    message: 'Port "reference_image" expects image but received mesh.',
    targetNodeId: 'target-node',
    targetHandle: 'reference_image',
    portName: 'reference_image',
    expectedType: 'image',
    actualType: 'mesh',
    sourceNodeId: 'source-node',
  })
})

test('rejects duplicate connections to the same named port', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const sourceA = createNode('source-a', 'meshNode')
  const sourceB = createNode('source-b', 'meshNode')
  const existingEdge: WFEdge = {
    id: 'edge-1',
    source: 'source-a',
    target: 'target-node',
    targetHandle: 'coarse_mesh',
  }

  const issue = validateProcessConnection({
    connection: createConnection({ source: 'source-b', targetHandle: 'coarse_mesh' }),
    nodes: [sourceA, sourceB, target],
    edges: [existingEdge],
    allExtensions: [createProcessExtension([
      { name: 'reference_image', type: 'image' },
      { name: 'coarse_mesh', type: 'mesh' },
    ])],
  })

  assert.deepEqual(issue, {
    phase: 'connect',
    code: 'duplicate-port',
    message: 'Port "coarse_mesh" already has a connection.',
    targetNodeId: 'target-node',
    targetHandle: 'coarse_mesh',
    portName: 'coarse_mesh',
    edgeIds: ['edge-1'],
  })
})

test('detects missing required ports before run with clear metadata', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const image = createNode('image-source', 'imageNode')
  const issue = validateWorkflowProcessRun({
    nodes: [image, target],
    edges: [
      { id: 'edge-image', source: 'image-source', target: 'target-node', targetHandle: 'reference_image' },
    ],
    allExtensions: [createProcessExtension([
      { name: 'reference_image', type: 'image' },
      { name: 'coarse_mesh', type: 'mesh' },
    ])],
  })

  assert.deepEqual(issue, {
    phase: 'run',
    code: 'missing-required-port',
    message: 'Required port "coarse_mesh" is missing.',
    targetNodeId: 'target-node',
    targetHandle: 'coarse_mesh',
    portName: 'coarse_mesh',
    expectedType: 'mesh',
  })
})

test('detects persisted duplicate-port edges before run', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const meshA = createNode('mesh-a', 'meshNode')
  const meshB = createNode('mesh-b', 'meshNode')
  const image = createNode('image-source', 'imageNode')

  const issue = validateWorkflowProcessRun({
    nodes: [meshA, meshB, image, target],
    edges: [
      { id: 'edge-image', source: 'image-source', target: 'target-node', targetHandle: 'reference_image' },
      { id: 'edge-mesh-a', source: 'mesh-a', target: 'target-node', targetHandle: 'coarse_mesh' },
      { id: 'edge-mesh-b', source: 'mesh-b', target: 'target-node', targetHandle: 'coarse_mesh' },
    ],
    allExtensions: [createProcessExtension([
      { name: 'reference_image', type: 'image' },
      { name: 'coarse_mesh', type: 'mesh' },
    ])],
  })

  assert.deepEqual(issue, {
    phase: 'run',
    code: 'duplicate-port',
    message: 'Port "coarse_mesh" has multiple incoming connections.',
    targetNodeId: 'target-node',
    targetHandle: 'coarse_mesh',
    portName: 'coarse_mesh',
    edgeIds: ['edge-mesh-a', 'edge-mesh-b'],
  })
})

test('preserves legacy single-input behavior for nodes without inputs[]', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const image = createNode('image-source', 'imageNode')
  const mesh = createNode('mesh-source', 'meshNode')

  assert.equal(validateProcessConnection({
    connection: createConnection({ source: 'mesh-source' }),
    nodes: [image, mesh, target],
    edges: [{ id: 'legacy-edge', source: 'image-source', target: 'target-node' }],
    allExtensions: [createProcessExtension()],
  }), null)

  assert.equal(validateWorkflowProcessRun({
    nodes: [image, mesh, target],
    edges: [
      { id: 'legacy-edge-a', source: 'image-source', target: 'target-node' },
      { id: 'legacy-edge-b', source: 'mesh-source', target: 'target-node' },
    ],
    allExtensions: [createProcessExtension()],
  }), null)
})
