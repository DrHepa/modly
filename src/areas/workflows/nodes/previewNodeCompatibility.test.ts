import assert from 'node:assert/strict'
import test from 'node:test'
import { useWorkflowsStore, NODE_TYPES_WITHOUT_SOURCE, NODE_TYPES_WITHOUT_TARGET } from '../../../shared/stores/workflowsStore.ts'
import { isPassthrough, resolveDataSource } from '../nodeBehaviors.ts'
import { validateWorkflowPreflight } from '../preflight.ts'
import type { WFNode, WFEdge, Workflow } from '../../../shared/types/electron.d'

import { WORKFLOW_BUILTIN_NODE_TYPES } from '../workflowBuiltinNodeCatalog.tsx'
import {
  PREVIEW_VIEWS_EMPTY_COPY,
  PREVIEW_VIEWS_NODE_TYPE,
  PREVIEW_VIEWS_TITLE,
} from './previewNodeShared.ts'
import { resolvePreviewImageNodeUrl } from './PreviewImageNode.tsx'
import { resolvePreviewViewsNodeUrl } from './PreviewViewsNode.tsx'

test('legacy previewNode workflows remain registered under the existing node type', () => {
  assert.equal(WORKFLOW_BUILTIN_NODE_TYPES.includes(PREVIEW_VIEWS_NODE_TYPE), true)
})

test('legacy previewNode copy remains focused on multi-view strips', () => {
  assert.equal(PREVIEW_VIEWS_TITLE, 'Preview Views')
  assert.equal(PREVIEW_VIEWS_EMPTY_COPY, 'Connect a multi-view image to preview.')
})

const node = (id: string, type: string): WFNode => ({ id, type, position: { x: 0, y: 0 }, data: { enabled: true, params: {} } })
const workflow = (nodes: WFNode[], edges: WFEdge[]): Workflow => ({ id: 'preview-test', name: '', description: '', createdAt: '', updatedAt: '', nodes, edges })

test('terminal preview metadata matches its sole target handle without changing the upstream passthrough', () => {
  for (const type of ['previewNode', 'previewImageNode']) {
    assert.equal(NODE_TYPES_WITHOUT_SOURCE.has(type), true)
    assert.equal(NODE_TYPES_WITHOUT_TARGET.has(type), false)
    assert.equal(isPassthrough(type), false)
  }
  assert.equal(NODE_TYPES_WITHOUT_SOURCE.has('imagePreviewNode'), false)
  assert.equal(isPassthrough('imagePreviewNode'), true)
  const nodes = [node('image', 'imageNode'), node('wait', 'waitNode'), node('pass', 'imagePreviewNode')]
  assert.equal(resolveDataSource('pass', [{ id: 'a', source: 'image', target: 'wait' }, { id: 'b', source: 'wait', target: 'pass' }], new Map(nodes.map((n) => [n.id, n]))), 'image')
})

test('preflight does not advertise terminal preview outputs or accept scene artifacts as images', () => {
  for (const type of ['previewNode', 'previewImageNode']) {
    const sink = node('sink', type)
    const scene = node('scene', 'sceneNode')
    scene.data.params.manifestPath = 'scene/manifest.json'
    const bad = validateWorkflowPreflight(workflow([scene, sink, node('other', 'previewImageNode')], [{ id: 'in', source: 'scene', target: 'sink' }, { id: 'out', source: 'sink', target: 'other' }]), [])
    assert.ok(bad.some((issue) => /expects.*image.*scene/i.test(issue.message)))
    assert.ok(bad.some((issue) => /no output handle/i.test(issue.message)))
    assert.deepEqual(validateWorkflowPreflight(workflow([node('image', 'imageNode'), sink], [{ id: 'in', source: 'image', target: 'sink' }]), []), [])
  }
})

test('loading saved workflows preserves all preview IDs and removes only impossible terminal outgoing edges', async () => {
  const saved = workflow([node('image', 'imageNode'), node('pass', 'imagePreviewNode'), node('single', 'previewImageNode'), node('views', 'previewNode')], [
    { id: 'image-pass', source: 'image', target: 'pass' },
    { id: 'pass-single', source: 'pass', target: 'single' },
    { id: 'pass-views', source: 'pass', target: 'views' },
    { id: 'invalid-single', source: 'single', target: 'views' },
    { id: 'invalid-views', source: 'views', target: 'single' },
  ])
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electron: { workflows: { list: async () => [saved] } } } })
  try {
    await useWorkflowsStore.getState().load()
    const loaded = useWorkflowsStore.getState().workflows[0]
    assert.deepEqual(loaded.nodes.map((node) => node.type), saved.nodes.map((node) => node.type))
    assert.deepEqual(loaded.edges.map((edge) => edge.id), ['image-pass', 'pass-single', 'pass-views'])
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('preflight follows Wait and upstream preview sources without making terminal sinks passthrough', () => {
  for (const sourceType of ['imageNode', 'textNode']) {
    const nodes = [node('source', sourceType), node('wait', 'waitNode'), node('pass', 'imagePreviewNode'), node('sink', 'previewImageNode')]
    const edges = [{ id: 'a', source: 'source', target: 'wait' }, { id: 'b', source: 'wait', target: 'pass' }, { id: 'c', source: 'pass', target: 'sink' }]
    const issues = validateWorkflowPreflight(workflow(nodes, edges), [])
    if (sourceType === 'imageNode') assert.deepEqual(issues, [])
    else assert.ok(issues.some((issue) => /expects an image.*text/.test(issue.message)))
  }
})

test('both preview node types normalize workspace outputs through the same shared seam', () => {
  const sharedArgs = {
    apiUrl: 'http://127.0.0.1:8000',
    edges: [{ source: 'source-a', target: 'preview-node' }],
    nodeImageOutputs: { 'source-a': '/workspace/preview.png' },
  }

  assert.equal(
    resolvePreviewImageNodeUrl({ ...sharedArgs, nodeId: 'preview-node' }),
    'http://127.0.0.1:8000/workspace/preview.png',
  )
  assert.equal(
    resolvePreviewViewsNodeUrl({ ...sharedArgs, nodeId: 'preview-node' }),
    'http://127.0.0.1:8000/workspace/preview.png',
  )
})

test('both preview node types preserve non-workspace upstream values as fallback behavior', () => {
  const sharedArgs = {
    apiUrl: '',
    edges: [{ source: 'source-a', target: 'preview-node' }],
    nodeImageOutputs: { 'source-a': 'http://cdn.example.com/preview.png' },
  }

  assert.equal(resolvePreviewImageNodeUrl({ ...sharedArgs, nodeId: 'preview-node' }), 'http://cdn.example.com/preview.png')
  assert.equal(resolvePreviewViewsNodeUrl({ ...sharedArgs, nodeId: 'preview-node' }), 'http://cdn.example.com/preview.png')
})
