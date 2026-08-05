import assert from 'node:assert/strict'
import test from 'node:test'

import type { Workflow, WFNode } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions'

const { validateWorkflowPreflight } = await import(new URL('./preflight.ts', import.meta.url).href)

function createNode(id: string, type: WFNode['type'], data: WFNode['data'] = { enabled: true, params: {} }): WFNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
  }
}

function createWorkflow(nodes: WFNode[]): Workflow {
  return {
    id: 'workflow-1',
    name: 'Workflow',
    description: 'Workflow fixture for preflight validation tests.',
    nodes,
    edges: nodes.length > 1
      ? [{ id: 'edge-1', source: nodes[0].id, target: nodes[1].id }]
      : [],
    createdAt: '2026-07-19T19:07:27.000Z',
    updatedAt: '2026-07-19T19:07:27.000Z',
  }
}

function createProcessExtension(overrides: Partial<Extract<WorkflowExtension, { type: 'process' }>> = {}): Extract<WorkflowExtension, { type: 'process' }> {
  return {
    id: 'ext/consumer',
    extensionId: 'ext',
    extensionName: 'Tests',
    extensionAuthor: 'Tests',
    nodeId: 'consumer',
    name: 'Consumer',
    description: 'Consumes artifacts',
    input: 'image',
    output: 'image',
    params: [],
    builtin: false,
    type: 'process',
    ...overrides,
  }
}

function createModelExtension(overrides: Partial<Extract<WorkflowExtension, { type: 'model' }>> = {}): Extract<WorkflowExtension, { type: 'model' }> {
  return {
    id: 'ext/producer',
    extensionId: 'ext',
    extensionName: 'Tests',
    extensionAuthor: 'Tests',
    nodeId: 'producer',
    name: 'Producer',
    description: 'Produces artifacts',
    input: 'none',
    output: 'image',
    params: [],
    builtin: false,
    type: 'model',
    ...overrides,
  }
}

test('preflight accepts scene outputs for scene workflow consumers', () => {
  const workflow = createWorkflow([
    createNode('scene-source', 'sceneNode', { enabled: true, params: { path: 'Scenes/castle', manifestPath: 'Scenes/castle/scene-manifest.json' } }),
    createNode('scene-consumer', 'extensionNode', { extensionId: 'ext/scene-consumer', enabled: true, params: {} }),
  ])

  const issues = validateWorkflowPreflight(workflow, [createProcessExtension({
    id: 'ext/scene-consumer',
    nodeId: 'scene-consumer',
    name: 'Scene Consumer',
    input: 'scene',
    output: 'scene',
  })])

  assert.deepEqual(issues, [])
})

test('preflight accepts video outputs for video workflow consumers', () => {
  const workflow = createWorkflow([
    createNode('video-source', 'extensionNode', { extensionId: 'ext/video-producer', enabled: true, params: {} }),
    createNode('video-consumer', 'extensionNode', { extensionId: 'ext/video-consumer', enabled: true, params: {} }),
  ])

  const issues = validateWorkflowPreflight(workflow, [
    createModelExtension({
      id: 'ext/video-producer',
      nodeId: 'video-producer',
      name: 'Video Producer',
      input: 'none',
      output: 'video',
    }),
    createProcessExtension({
      id: 'ext/video-consumer',
      nodeId: 'video-consumer',
      name: 'Video Consumer',
      input: 'video',
      output: 'video',
    }),
  ])

  assert.deepEqual(issues, [])
})

for (const type of ['model', 'process'] as const) {
  for (const inputs of [undefined, ['none']]) {
    test(`preflight keeps ${type}:none advisory with ${inputs ? "positional ['none']" : 'absent inputs'} and a retained incoming image edge`, () => {
      const createExtension = type === 'model' ? createModelExtension : createProcessExtension
      const extension = createExtension({
        id: 'ext/inputless',
        input: 'none',
        ...(inputs ? { inputs } : {}),
      })
      const workflow = createWorkflow([
        createNode('image-source', 'imageNode'),
        createNode('inputless-target', 'extensionNode', { extensionId: extension.id, enabled: true, params: {} }),
      ])

      assert.equal(Object.hasOwn(extension, 'inputs'), inputs !== undefined)
      assert.deepEqual(validateWorkflowPreflight(workflow, [extension]), [])
    })
  }
}

for (const structured of [false, true]) {
  test(`preflight preserves custom kinds in ${structured ? 'structured' : 'string'} generic input declarations`, () => {
    const kind = 'custom-artifact'
    const producer = createModelExtension({ id: 'ext/custom-producer', output: kind })
    const consumer = createModelExtension({
      id: 'ext/custom-consumer',
      name: 'Custom Consumer',
      input: kind,
      inputs: structured ? [{ name: 'artifact', type: kind }] : [kind],
      ...(structured ? { ioContract: 'named-v1' as const } : {}),
    })
    const workflow = createWorkflow([
      createNode('custom-source', 'extensionNode', { extensionId: producer.id, enabled: true, params: {} }),
      createNode('custom-target', 'extensionNode', { extensionId: consumer.id, enabled: true, params: {} }),
    ])
    if (structured) workflow.edges[0].targetHandle = 'artifact'

    assert.deepEqual(validateWorkflowPreflight(workflow, [producer, consumer]), [])
    assert.deepEqual(validateWorkflowPreflight({ ...workflow, edges: [] }, [producer, consumer]), [{
      key: 'custom-target:missing:custom-artifact',
      nodeId: 'custom-target',
      message: 'Custom Consumer needs an incoming custom-artifact connection.',
    }])
  })
}

test('preflight accepts a Video source connected to a video-to-mesh model', () => {
  const workflow = createWorkflow([
    createNode('video-source', 'videoNode', {
      enabled: true,
      params: { videoPath: 'Workflows/Inputs/Videos/turntable.mp4' },
    }),
    createNode('video-model', 'extensionNode', {
      extensionId: 'lingbot-map/reconstruct',
      enabled: true,
      params: {},
    }),
  ])

  const issues = validateWorkflowPreflight(workflow, [createModelExtension({
    id: 'lingbot-map/reconstruct',
    input: 'video',
    output: 'mesh',
  })])

  assert.deepEqual(issues, [])
})
