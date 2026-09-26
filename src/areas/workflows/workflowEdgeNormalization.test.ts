import assert from 'node:assert/strict'
import test from 'node:test'
import type { WFEdge, WFNode } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions.ts'

const { normalizeWorkflowEdges } = await import(new URL('./workflowEdgeNormalization.ts', import.meta.url).href)
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
    id: 'ext/process',
    extensionId: 'ext',
    extensionName: 'Process',
    extensionAuthor: 'Tests',
    nodeId: 'process',
    name: 'Process',
    description: '',
    input: 'image',
    output: 'mesh',
    ...(inputs ? { inputs } : {}),
    params: [],
    builtin: false,
    type: 'process',
  }
}

function createModelExtension(args: {
  id?: string
  input?: WorkflowExtension['input']
  inputs?: WorkflowExtension['inputs']
} = {}): WorkflowExtension {
  return {
    id: args.id ?? 'ext/model',
    extensionId: 'ext',
    extensionName: 'Model',
    extensionAuthor: 'Tests',
    nodeId: 'model',
    name: 'Model',
    description: '',
    input: args.input ?? 'image',
    output: 'image',
    ...(args.inputs ? { inputs: args.inputs } : {}),
    params: [],
    builtin: false,
    type: 'model',
  }
}

test('normalizes legacy extension handles back to null', () => {
  const source = createNode('source', 'extensionNode', { extensionId: 'ext/model', enabled: true, params: {} })
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/process', enabled: true, params: {} })
  const edge: WFEdge = { id: 'edge', source: source.id, sourceHandle: 'output', target: target.id, targetHandle: 'input-0' }

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [edge],
    allExtensions: [createModelExtension(), createProcessExtension()],
  })

  assert.equal(result.changed, true)
  assert.deepEqual(result.edges, [{ id: 'edge', source: 'source', sourceHandle: null, target: 'target', targetHandle: null }])
})

test('upgrades missing and stale single named target handles to the declared port name', () => {
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/process', enabled: true, params: {} })
  const source = createNode('source', 'imageNode')
  const extension = createProcessExtension([{ name: 'reference_image', type: 'image' }])

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [
      { id: 'missing', source: source.id, target: target.id, targetHandle: null },
      { id: 'alias', source: source.id, target: target.id, targetHandle: 'input-0' },
    ],
    allExtensions: [extension],
  })

  assert.deepEqual(result.edges.map((edge: WFEdge) => edge.targetHandle), ['reference_image', 'reference_image'])
})

test('collapses stale model source aliases back to the legacy null handle', () => {
  const source = createNode('source', 'extensionNode', { extensionId: 'ext/model', enabled: true, params: {} })
  const target = createNode('target', 'outputNode')
  const extension = createModelExtension()

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [
      { id: 'missing', source: source.id, target: target.id, sourceHandle: null },
      { id: 'alias', source: source.id, target: target.id, sourceHandle: 'output' },
    ],
    allExtensions: [extension],
  })

  assert.deepEqual(result.edges.map((edge: WFEdge) => edge.sourceHandle), [null, null])
})

test('preserves valid named model target handles', () => {
  const source = createNode('source', 'imageNode')
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/model', enabled: true, params: {} })

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [{ id: 'edge', source: source.id, target: target.id, targetHandle: 'left' }],
    allExtensions: [createModelExtension({
      inputs: [
        { name: 'front', type: 'image' },
        { name: 'left', type: 'image', required: false },
      ],
    })],
  })

  assert.equal(result.changed, false)
  assert.equal(result.edges[0].targetHandle, 'left')
})

test('collapses stale named model source handles while preserving named process target handles', () => {
  const source = createNode('source', 'extensionNode', { extensionId: 'ext/model', enabled: true, params: {} })
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/process', enabled: true, params: {} })

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [{ id: 'edge', source: source.id, sourceHandle: 'caption', target: target.id, targetHandle: 'prompt' }],
    allExtensions: [
      createModelExtension(),
      createProcessExtension([{ name: 'prompt', type: 'text' }]),
    ],
  })

  assert.equal(result.changed, true)
  assert.deepEqual(result.edges[0], { id: 'edge', source: 'source', sourceHandle: null, target: 'target', targetHandle: 'prompt' })
})

test('maps legacy input-0 targets to the first declared multi-input process port', () => {
  const source = createNode('source', 'imageNode')
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/process', enabled: true, params: {} })

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [{ id: 'edge', source: source.id, target: target.id, targetHandle: 'input-0' }],
    allExtensions: [createProcessExtension([
      { name: 'front', type: 'image' },
      { name: 'left', type: 'image' },
    ])],
  })

  assert.equal(result.changed, true)
  assert.equal(result.edges[0].targetHandle, 'front')
})

test('maps missing model target handles to the first declared named input port', () => {
  const source = createNode('source', 'imageNode')
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/model', enabled: true, params: {} })

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [
      { id: 'missing', source: source.id, target: target.id, targetHandle: null },
      { id: 'alias', source: source.id, target: target.id, targetHandle: 'input-0' },
    ],
    allExtensions: [createModelExtension({
      inputs: [
        { name: 'front', type: 'image' },
        { name: 'left', type: 'image', required: false },
      ],
    })],
  })

  assert.deepEqual(result.edges.map((edge: WFEdge) => edge.targetHandle), ['front', 'front'])
})

test('maps positional model target handles by declared input order', () => {
  const source = createNode('source', 'imageNode')
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/model', enabled: true, params: {} })

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [
      { id: 'front', source: source.id, target: target.id, targetHandle: 'input-0' },
      { id: 'left', source: source.id, target: target.id, targetHandle: 'input-1' },
      { id: 'right', source: source.id, target: target.id, targetHandle: 'input-2' },
    ],
    allExtensions: [createModelExtension({
      inputs: [
        { name: 'image', type: 'image' },
        { name: 'image_2', type: 'image', required: false },
        { name: 'image_3', type: 'image', required: false },
      ],
    })],
  })

  assert.equal(result.changed, true)
  assert.deepEqual(result.edges.map((edge: WFEdge) => edge.targetHandle), ['image', 'image_2', 'image_3'])
})

test('falls back out-of-range positional model target handles to the first declared input', () => {
  const source = createNode('source', 'imageNode')
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/model', enabled: true, params: {} })

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [{ id: 'edge', source: source.id, target: target.id, targetHandle: 'input-3' }],
    allExtensions: [createModelExtension({
      inputs: [
        { name: 'image', type: 'image' },
        { name: 'image_2', type: 'image', required: false },
        { name: 'image_3', type: 'image', required: false },
      ],
    })],
  })

  assert.equal(result.changed, true)
  assert.equal(result.edges[0].targetHandle, 'image')
})

test('falls back unknown model target handles to the first declared input', () => {
  const source = createNode('source', 'imageNode')
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/model', enabled: true, params: {} })

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [{ id: 'edge', source: source.id, target: target.id, targetHandle: 'obsolete-view' }],
    allExtensions: [createModelExtension({
      inputs: [
        { name: 'front', type: 'image' },
        { name: 'left', type: 'image', required: false },
      ],
    })],
  })

  assert.equal(result.changed, true)
  assert.equal(result.edges[0].targetHandle, 'front')
})

test('preserves unknown non-null process target handles to avoid rerouting declared process ports', () => {
  const source = createNode('source', 'imageNode')
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/process', enabled: true, params: {} })

  const result = normalizeWorkflowEdges({
    nodes: [source, target],
    edges: [{ id: 'edge', source: source.id, target: target.id, targetHandle: 'obsolete-process-port' }],
    allExtensions: [createProcessExtension([
      { name: 'front', type: 'image' },
      { name: 'left', type: 'image' },
    ])],
  })

  assert.equal(result.changed, false)
  assert.equal(result.edges[0].targetHandle, 'obsolete-process-port')
})

test('normalization becomes effective after metadata arrives', () => {
  const source = createNode('source', 'extensionNode', { extensionId: 'ext/model', enabled: true, params: {} })
  const target = createNode('target', 'extensionNode', { extensionId: 'ext/process', enabled: true, params: {} })
  const edges: WFEdge[] = [{ id: 'edge', source: source.id, sourceHandle: 'output', target: target.id, targetHandle: 'input-0' }]

  const before = normalizeWorkflowEdges({ nodes: [source, target], edges, allExtensions: [] })
  const after = normalizeWorkflowEdges({
    nodes: [source, target],
    edges,
    allExtensions: [
      createModelExtension(),
      createProcessExtension([{ name: 'reference_image', type: 'image' }]),
    ],
  })

  assert.equal(before.changed, false)
  assert.equal(before.edges[0].sourceHandle, 'output')
  assert.equal(before.edges[0].targetHandle, 'input-0')
  assert.equal(after.edges[0].sourceHandle, null)
  assert.equal(after.edges[0].targetHandle, 'reference_image')
})

test('normalizes each switched workflow independently', () => {
  const modelExtension = createModelExtension()
  const processExtension = createProcessExtension([{ name: 'reference_image', type: 'image' }])
  const workflowA = {
    nodes: [
      createNode('source-a', 'extensionNode', { extensionId: modelExtension.id, enabled: true, params: {} }),
      createNode('target-a', 'extensionNode', { extensionId: processExtension.id, enabled: true, params: {} }),
    ],
    edges: [{ id: 'edge-a', source: 'source-a', sourceHandle: null, target: 'target-a', targetHandle: null }],
  }
  const workflowB = {
    nodes: [
      createNode('source-b', 'extensionNode', { extensionId: modelExtension.id, enabled: true, params: {} }),
      createNode('target-b', 'extensionNode', { extensionId: processExtension.id, enabled: true, params: {} }),
    ],
    edges: [{ id: 'edge-b', source: 'source-b', sourceHandle: 'output', target: 'target-b', targetHandle: 'input-0' }],
  }

  const normalizedA = normalizeWorkflowEdges({
    nodes: workflowA.nodes,
    edges: workflowA.edges,
    allExtensions: [modelExtension, processExtension],
  })
  const normalizedB = normalizeWorkflowEdges({
    nodes: workflowB.nodes,
    edges: workflowB.edges,
    allExtensions: [modelExtension, processExtension],
  })

  assert.deepEqual(normalizedA.edges[0], {
    id: 'edge-a', source: 'source-a', sourceHandle: null, target: 'target-a', targetHandle: 'reference_image',
  })
  assert.deepEqual(normalizedB.edges[0], {
    id: 'edge-b', source: 'source-b', sourceHandle: null, target: 'target-b', targetHandle: 'reference_image',
  })
})

for (const type of ['model', 'process'] as const) {
  function positionalExtension(inputs: string[]): WorkflowExtension {
    return type === 'model' ? createModelExtension({ inputs }) : createProcessExtension(inputs)
  }

  test(`${type} normalization preserves input-2 mesh ownership across an empty physical slot into actual execution`, () => {
    const extension = positionalExtension(['image', '', 'mesh'])
    const source = createNode('mesh-source', 'meshNode')
    const target = createNode('positional-target', 'extensionNode', { extensionId: extension.id, enabled: true, params: {} })
    const edge: WFEdge = { id: 'mesh-edge', source: source.id, target: target.id, targetHandle: 'input-2' }
    const args = { nodes: [source, target], edges: [edge], allExtensions: [extension] }
    const normalized = normalizeWorkflowEdges(args)

    assert.equal(normalized.changed, false)
    assert.equal(normalized.edges[0], edge)
    assert.equal(normalized.edges[0].targetHandle, 'input-2')
    assert.equal(normalizeWorkflowEdges({ ...args, edges: normalized.edges }).changed, false)
    assert.deepEqual(buildProcessExecutionInput({
      ...args, node: target, edges: normalized.edges,
      nodeOutputs: new Map([[source.id, { filePath: '/tmp/slot-two.glb', outputType: 'mesh' }]]),
    }), { filePath: '/tmp/slot-two.glb', text: undefined, nodeId: extension.nodeId })
  })

  for (const handle of [null, undefined]) {
    test(`${type} normalization maps a missing singleton positional handle (${String(handle)}) to its first physical port`, () => {
      const extension = positionalExtension(['image'])
      const source = createNode('image-source', 'imageNode')
      const target = createNode('singleton-target', 'extensionNode', { extensionId: extension.id, enabled: true, params: {} })
      const edge: WFEdge = { id: 'image-edge', source: source.id, target: target.id, targetHandle: handle }
      const args = { nodes: [source, target], edges: [edge], allExtensions: [extension] }
      const normalized = normalizeWorkflowEdges(args)

      assert.equal(normalized.changed, true)
      assert.deepEqual(normalized.edges, [{ ...edge, targetHandle: 'input-0' }])
      assert.equal(edge.targetHandle, handle)
      assert.equal(normalizeWorkflowEdges({ ...args, edges: normalized.edges }).changed, false)
      assert.deepEqual(buildProcessExecutionInput({
        ...args, node: target, edges: normalized.edges,
        nodeOutputs: new Map([[source.id, { filePath: '/tmp/first-slot.png', outputType: 'image' }]]),
      }), { filePath: '/tmp/first-slot.png', text: undefined, nodeId: extension.nodeId })
    })
  }

  test(`${type} normalization retains indexed prompt and mesh descriptors without compacting slots`, () => {
    const extension = positionalExtension(['image', 'text', 'mesh'])
    const text = createNode('text-source', 'textNode')
    const mesh = createNode('mesh-source', 'meshNode')
    const target = createNode('mixed-target', 'extensionNode', { extensionId: extension.id, enabled: true, params: {} })
    const args = { nodes: [text, mesh, target], allExtensions: [extension], edges: [
      { id: 'text-edge', source: text.id, target: target.id, targetHandle: 'input-1' },
      { id: 'mesh-edge', source: mesh.id, target: target.id, targetHandle: 'input-2' },
    ] }
    const normalized = normalizeWorkflowEdges(args)
    assert.equal(normalized.changed, false)
    assert.deepEqual(normalized.edges.map((edge) => edge.targetHandle), ['input-1', 'input-2'])
    const result = buildProcessExecutionInput({
      ...args, node: target, edges: normalized.edges, nodeOutputs: new Map([
        [text.id, { text: 'Keep the physical prompt', outputType: 'text' }],
        [mesh.id, { filePath: '/tmp/slot-two.glb', outputType: 'mesh' }],
      ]),
    })
    const indexedTexts = new Array<string | undefined>(2)
    indexedTexts[1] = 'Keep the physical prompt'
    assert.deepEqual(result, {
      filePath: '/tmp/slot-two.glb', text: 'Keep the physical prompt',
      nodeId: extension.nodeId, texts: indexedTexts,
    })
    assert.equal(Object.hasOwn(result.texts!, 0), false)
    assert.equal(result.texts![1], 'Keep the physical prompt')
  })
}
