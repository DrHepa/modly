import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider } from '@xyflow/react'

import PreviewImageNode, { PreviewImageContent } from './PreviewImageNode.tsx'
import PreviewViewsNode, { PreviewViewsContent } from './PreviewViewsNode.tsx'
import ImagePreviewNode from './ImagePreviewNode.tsx'
import { WORKFLOW_NODE_TYPES } from '../workflowNodeTypes.tsx'
import { WORKFLOW_BUILTIN_NODE_TYPES } from '../workflowBuiltinNodeCatalog.tsx'

test('PreviewImageContent renders a single upstream image preview', () => {
  const markup = renderToStaticMarkup(React.createElement(PreviewImageContent, { imageUrl: '/workspace/preview.png' }))

  assert.match(markup, /<img[^>]+src="\/workspace\/preview\.png"/)
  assert.match(markup, /Workflow preview output/)
})

test('PreviewImageContent renders empty guidance when no image is connected', () => {
  const markup = renderToStaticMarkup(React.createElement(PreviewImageContent, { imageUrl: undefined }))

  assert.match(markup, /Connect an image to preview\./)
})

test('PreviewViewsContent preserves the six-tile multi-view strip preview', () => {
  const markup = renderToStaticMarkup(React.createElement(PreviewViewsContent, { imageUrl: '/workspace/views.png' }))

  assert.equal((markup.match(/background-image:url\(\/workspace\/views\.png\)/g) ?? []).length, 6)
})

test('PreviewViewsContent keeps the legacy empty multi-view guidance', () => {
  const markup = renderToStaticMarkup(React.createElement(PreviewViewsContent, { imageUrl: undefined }))

  assert.match(markup, /Connect a multi-view image to preview\./)
})

test('persisted preview IDs resolve to three distinct components and every catalog entry is registered', () => {
  assert.equal(WORKFLOW_NODE_TYPES.previewNode, PreviewViewsNode)
  assert.equal(WORKFLOW_NODE_TYPES.previewImageNode, PreviewImageNode)
  assert.equal(WORKFLOW_NODE_TYPES.imagePreviewNode, ImagePreviewNode)
  for (const type of WORKFLOW_BUILTIN_NODE_TYPES) assert.equal(typeof WORKFLOW_NODE_TYPES[type], 'function')
})

test('terminal component markup exposes only the target while upstream passthrough retains both handles', () => {
  // SSR verifies the rendered handle contract, not visual layout or interaction.
  for (const [Component, sourceHandles] of [[PreviewImageNode, 0], [PreviewViewsNode, 0], [ImagePreviewNode, 1]] as const) {
    const markup = renderToStaticMarkup(React.createElement(ReactFlowProvider, { children: React.createElement(Component, { id: 'preview' }) }))
    assert.equal((markup.match(/react-flow__handle[^\"]*target/g) ?? []).length, 1)
    assert.equal((markup.match(/react-flow__handle[^\"]*source/g) ?? []).length, sourceHandles)
  }
})
