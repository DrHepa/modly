import assert from 'node:assert/strict'
import test from 'node:test'
import type { Connection } from '@xyflow/react'
import type { WFEdge, WFNode } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions'
const {
  resolveEffectiveWorkflowIoContract,
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

type ProcessWorkflowExtension = Extract<WorkflowExtension, { type: 'process' }>
type ModelWorkflowExtension = Extract<WorkflowExtension, { type: 'model' }>
type ProcessWorkflowExtensionOverrides = Partial<Omit<ProcessWorkflowExtension, 'type'>>

function createProcessExtension(inputs?: ProcessWorkflowExtension['inputs']): ProcessWorkflowExtension {
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

function createModelExtension(overrides: Partial<Omit<ModelWorkflowExtension, 'type'>> = {}): ModelWorkflowExtension {
  return {
    id: 'gaussiangpt/generate',
    extensionId: 'gaussiangpt',
    extensionName: 'GaussianGPT',
    extensionAuthor: 'Tests',
    nodeId: 'generate',
    name: 'GaussianGPT',
    description: 'Generates without external inputs',
    input: 'none',
    output: 'scene',
    params: [],
    builtin: false,
    type: 'model',
    ...overrides,
  }
}


function createVideoProcessExtension(): ProcessWorkflowExtension {
  return {
    ...createProcessExtension(),
    id: 'ext/video-producer',
    extensionId: 'ext',
    nodeId: 'video-producer',
    name: 'Video Producer',
    input: 'image',
    output: 'video',
  }
}

function createSceneProcessExtension(overrides: ProcessWorkflowExtensionOverrides = {}): ProcessWorkflowExtension {
  return {
    ...createProcessExtension([{ name: 'input_scene', type: 'scene' }]),
    id: 'ext/scene-consumer',
    nodeId: 'scene-consumer',
    name: 'Scene Consumer',
    input: 'scene',
    output: 'scene',
    ...overrides,
  }
}

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    source: 'source-node',
    target: 'target-node',
    sourceHandle: null,
    targetHandle: null,
    ...overrides,
  }
}

test('resolves persisted ioContract before installed metadata and falls back only when absent', () => {
  const installedNamed = createModelExtension({ ioContract: 'named-v1' })
  const installedLegacy = createModelExtension({ ioContract: undefined })
  const persistedNamed = createNode('persisted', 'extensionNode', {
    extensionId: installedLegacy.id,
    ioContract: 'named-v1',
    enabled: true,
    params: {},
  })
  const upgradedSavedNode = createNode('upgraded', 'extensionNode', {
    extensionId: installedNamed.id,
    enabled: true,
    params: {},
  })
  const exactLegacyNode = createNode('legacy', 'extensionNode', {
    extensionId: installedLegacy.id,
    enabled: true,
    params: {},
  })

  assert.equal(resolveEffectiveWorkflowIoContract(persistedNamed, installedLegacy), 'named-v1')
  assert.equal(resolveEffectiveWorkflowIoContract(upgradedSavedNode, installedNamed), 'named-v1')
  assert.equal(resolveEffectiveWorkflowIoContract(exactLegacyNode, installedLegacy), undefined)
})

test('allows upgraded saved model nodes with installed named-v1 ports to connect permissively', () => {
  const source = createNode('source-node', 'meshNode')
  const target = createNode('target-node', 'extensionNode', {
    extensionId: 'named/model',
    enabled: true,
    params: {},
  })
  const extension = createModelExtension({
    id: 'named/model',
    extensionId: 'named',
    nodeId: 'model',
    input: 'image',
    ioContract: 'named-v1',
    inputs: [{ name: 'front', type: 'image' }],
  })

  const issue = validateProcessConnection({
    connection: createConnection({ targetHandle: 'front' }),
    nodes: [source, target],
    edges: [],
    allExtensions: [extension],
  })

  assert.equal(issue, null)
})

test('keeps exact no-marker model nodes on legacy connection validation', () => {
  const source = createNode('source-node', 'meshNode')
  const target = createNode('target-node', 'extensionNode', {
    extensionId: 'legacy/model',
    enabled: true,
    params: {},
  })
  const extension = createModelExtension({
    id: 'legacy/model',
    extensionId: 'legacy',
    nodeId: 'model',
    input: 'image',
    inputs: [{ name: 'front', type: 'image' }],
  })

  assert.equal(validateProcessConnection({
    connection: createConnection({ targetHandle: 'front' }),
    nodes: [source, target],
    edges: [],
    allExtensions: [extension],
  }), null)
})

test('allows connect-time type mismatches with port metadata', () => {
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

  assert.equal(issue, null)
})

test('allows incoming edges into inputless model nodes at connect time', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'gaussiangpt/generate', enabled: true, params: {} })
  const source = createNode('source-node', 'imageNode')

  const issue = validateProcessConnection({
    connection: createConnection(),
    nodes: [source, target],
    edges: [],
    allExtensions: [createModelExtension()],
  })

  assert.equal(issue, null)
})

test('allows duplicate connections to the same named port at connect time', () => {
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

  assert.equal(issue, null)
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

test('detects persisted stale incoming edges into inputless model nodes before run', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'gaussiangpt/generate', enabled: true, params: {} })
  const source = createNode('source-node', 'imageNode')

  const issue = validateWorkflowProcessRun({
    nodes: [source, target],
    edges: [{ id: 'edge-stale', source: 'source-node', target: 'target-node' }],
    allExtensions: [createModelExtension()],
  })

  assert.deepEqual(issue, {
    phase: 'run',
    code: 'inputless-target',
    message: 'This node declares input "none" and cannot accept incoming edges. Remove the connection and run it as a source node.',
    targetNodeId: 'target-node',
    targetHandle: null,
    portName: null,
    sourceNodeId: 'source-node',
    edgeIds: ['edge-stale'],
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

test('accepts valid multi-input workflows before run', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const image = createNode('image-source', 'imageNode')
  const mesh = createNode('mesh-source', 'meshNode')

  const issue = validateWorkflowProcessRun({
    nodes: [image, mesh, target],
    edges: [
      { id: 'edge-image', source: 'image-source', target: 'target-node', targetHandle: 'reference_image' },
      { id: 'edge-mesh', source: 'mesh-source', target: 'target-node', targetHandle: 'coarse_mesh' },
    ],
    allExtensions: [createProcessExtension([
      { name: 'reference_image', type: 'image' },
      { name: 'coarse_mesh', type: 'mesh' },
    ])],
  })

  assert.equal(issue, null)
})

test('reuses the shared validator issue message for real invalid workflows', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const wrongMesh = createNode('wrong-source', 'meshNode')

  const issue = validateWorkflowProcessRun({
    nodes: [wrongMesh, target],
    edges: [
      { id: 'edge-wrong', source: 'wrong-source', target: 'target-node', targetHandle: 'reference_image' },
    ],
    allExtensions: [createProcessExtension([
      { name: 'reference_image', type: 'image' },
      { name: 'coarse_mesh', type: 'mesh', required: false },
    ])],
  })

  assert.deepEqual(issue, {
    phase: 'run',
    code: 'type-mismatch',
    message: 'Port "reference_image" expects image but received mesh.',
    targetNodeId: 'target-node',
    targetHandle: 'reference_image',
    portName: 'reference_image',
    expectedType: 'image',
    actualType: 'mesh',
    sourceNodeId: 'wrong-source',
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

test('keeps legacy single-input linear workflows runnable under the shared validator', () => {
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })
  const image = createNode('image-source', 'imageNode')

  const issue = validateWorkflowProcessRun({
    nodes: [image, target],
    edges: [
      { id: 'legacy-edge', source: 'image-source', target: 'target-node' },
    ],
    allExtensions: [createProcessExtension()],
  })

  assert.equal(issue, null)
})

test('accepts scene-to-scene connections for named scene process ports', () => {
  const source = createNode('source-node', 'sceneNode', { enabled: true, params: { path: 'Scenes/castle' } })
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/scene-consumer', enabled: true, params: {} })

  const issue = validateProcessConnection({
    connection: createConnection({ targetHandle: 'input_scene' }),
    nodes: [source, target],
    edges: [],
    allExtensions: [
      createSceneProcessExtension(),
    ],
  })

  assert.equal(issue, null)
})

test('allows scene outputs wired into non-scene process ports at connect time', () => {
  const source = createNode('source-node', 'sceneNode', { enabled: true, params: { path: 'Scenes/castle' } })
  const target = createNode('target-node', 'extensionNode', { extensionId: 'ext/refiner', enabled: true, params: {} })

  const issue = validateProcessConnection({
    connection: createConnection({ targetHandle: 'reference_image' }),
    nodes: [source, target],
    edges: [],
    allExtensions: [
      createProcessExtension([{ name: 'reference_image', type: 'image' }]),
    ],
  })

  assert.equal(issue, null)
})

test('ignores disabled executable nodes and their incident edges during run diagnostics', () => {
  const source = createNode('image-source', 'imageNode')
  const disabledTarget = createNode('disabled-target', 'extensionNode', {
    extensionId: 'ext/refiner',
    enabled: false,
    params: {},
  })

  const issue = validateWorkflowProcessRun({
    nodes: [source, disabledTarget],
    edges: [
      { id: 'edge-image', source: 'image-source', target: 'disabled-target', targetHandle: 'reference_image' },
    ],
    allExtensions: [createProcessExtension([
      { name: 'reference_image', type: 'image' },
      { name: 'coarse_mesh', type: 'mesh' },
    ])],
  })

  assert.equal(issue, null)
})

test('allows non-video sources connected to Preview Video nodes at connect time', () => {
  const source = createNode('source-node', 'imageNode')
  const target = createNode('target-node', 'previewVideoNode')

  const issue = validateProcessConnection({
    connection: createConnection({}),
    nodes: [source, target],
    edges: [],
    allExtensions: [],
  })

  assert.equal(issue, null)
})

test('accepts video extension outputs connected to Preview Video nodes', () => {
  const source = createNode('source-node', 'extensionNode', { extensionId: 'ext/video-producer', enabled: true, params: {} })
  const target = createNode('target-node', 'previewVideoNode')

  const issue = validateProcessConnection({
    connection: createConnection({}),
    nodes: [source, target],
    edges: [],
    allExtensions: [createVideoProcessExtension()],
  })

  assert.equal(issue, null)
})

test('rejects persisted video outputs wired into image preview nodes before run', () => {
  const source = createNode('video-source', 'extensionNode', { extensionId: 'ext/video-producer', enabled: true, params: {} })
  const target = createNode('preview-image', 'previewImageNode')

  const issue = validateWorkflowProcessRun({
    nodes: [source, target],
    edges: [{ id: 'edge-video-preview', source: 'video-source', target: 'preview-image' }],
    allExtensions: [createVideoProcessExtension()],
  })

  assert.deepEqual(issue, {
    phase: 'run',
    code: 'type-mismatch',
    message: 'Port "image" expects image but received video.',
    targetNodeId: 'preview-image',
    targetHandle: null,
    portName: 'image',
    expectedType: 'image',
    actualType: 'video',
    sourceNodeId: 'video-source',
  })
})
