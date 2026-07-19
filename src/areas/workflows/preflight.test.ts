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
    createNode('scene-source', 'sceneNode', { enabled: true, params: { path: 'Scenes/castle' } }),
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
