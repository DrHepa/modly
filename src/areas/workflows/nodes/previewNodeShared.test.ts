import assert from 'node:assert/strict'
import test from 'node:test'

import { PREVIEW_IMAGE_NODE_TYPE, PREVIEW_VIEWS_NODE_TYPE, isPreviewNodeType, resolvePreviewImageUrl } from './previewNodeShared.ts'
import type { WFNode } from '../../../shared/types/electron.d'

test('resolvePreviewImageUrl returns the upstream image output for the first incoming edge', () => {
  const imageUrl = resolvePreviewImageUrl({
    nodeId: 'preview-image',
    edges: [
      { source: 'source-a', target: 'preview-image' },
      { source: 'source-b', target: 'preview-image' },
    ],
    nodeImageOutputs: {
      'source-a': '/workspace/first.png',
      'source-b': '/workspace/second.png',
    },
  })

  assert.equal(imageUrl, '/workspace/first.png')
})

test('resolvePreviewImageUrl returns undefined when no incoming image output is available', () => {
  const imageUrl = resolvePreviewImageUrl({
    nodeId: 'preview-image',
    edges: [{ source: 'source-a', target: 'other-node' }],
    nodeImageOutputs: {},
  })

  assert.equal(imageUrl, undefined)
})

test('isPreviewNodeType recognizes both legacy and single-image preview node types', () => {
  assert.equal(isPreviewNodeType(PREVIEW_IMAGE_NODE_TYPE), true)
  assert.equal(isPreviewNodeType(PREVIEW_VIEWS_NODE_TYPE), true)
  assert.equal(isPreviewNodeType('imageNode'), false)
  assert.equal(isPreviewNodeType('imagePreviewNode'), false, 'the upstream passthrough is not a terminal preview')
})

test('terminal preview follows current Wait and image passthrough source traversal', () => {
  const nodes: WFNode[] = ['imageNode', 'waitNode', 'imagePreviewNode', 'previewImageNode'].map((type, i) => ({ id: String(i), type, position: { x: 0, y: 0 }, data: { enabled: true, params: {} } }))
  const edges = [{ source: '0', target: '1' }, { source: '1', target: '2' }, { source: '2', target: '3' }]
  assert.equal(resolvePreviewImageUrl({ nodeId: '3', nodes, edges, nodeImageOutputs: { '0': '/workspace/image.png' } }), '/workspace/image.png')
  assert.equal(resolvePreviewImageUrl({ nodeId: '3', nodes, edges: [], nodeImageOutputs: { '0': '/workspace/image.png' } }), undefined)
})
