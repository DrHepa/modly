import assert from 'node:assert/strict'
import test from 'node:test'

import { PREVIEW_IMAGE_NODE_TYPE, PREVIEW_VIEWS_NODE_TYPE, isPreviewNodeType, resolvePreviewImageUrl } from './previewNodeShared.ts'

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
})
