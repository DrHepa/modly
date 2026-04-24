import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PreviewImageContent, resolvePreviewImageNodeUrl } from './PreviewImageNode.tsx'
import { PreviewViewsContent, resolvePreviewViewsNodeUrl } from './PreviewViewsNode.tsx'

test('resolvePreviewImageNodeUrl forwards apiUrl through the shared resolver', () => {
  const imageUrl = resolvePreviewImageNodeUrl({
    nodeId: 'preview-image',
    apiUrl: 'http://127.0.0.1:8000',
    getEdges: () => [{ source: 'source-a', target: 'preview-image' }],
    nodeImageOutputs: { 'source-a': '/workspace/preview.png' },
  })

  assert.equal(imageUrl, 'http://127.0.0.1:8000/workspace/preview.png')
})

test('resolvePreviewViewsNodeUrl shares the same workspace fallback behavior', () => {
  const imageUrl = resolvePreviewViewsNodeUrl({
    nodeId: 'preview-views',
    apiUrl: '',
    getEdges: () => [{ source: 'source-a', target: 'preview-views' }],
    nodeImageOutputs: { 'source-a': '/workspace/views.png' },
  })

  assert.equal(imageUrl, undefined)
})

test('PreviewImageContent renders a single upstream image preview', () => {
  const markup = renderToStaticMarkup(React.createElement(PreviewImageContent, { imageUrl: '/workspace/preview.png' }))

  assert.match(markup, /<img[^>]+src="\/workspace\/preview\.png"/)
  assert.match(markup, /Workflow preview output/)
})

test('PreviewImageContent lets the generated image fill the resizable node body without fixed height', () => {
  const markup = renderToStaticMarkup(React.createElement(PreviewImageContent, { imageUrl: '/workspace/preview.png' }))

  assert.match(markup, /<div class="[^"]*h-full[^"]*flex[^"]*"/)
  assert.match(markup, /<img[^>]+class="[^"]*h-full[^"]*w-full[^"]*object-contain[^"]*"/)
  assert.doesNotMatch(markup, /h-40/)
})

test('PreviewImageContent keeps empty guidance free from image layout wrappers', () => {
  const markup = renderToStaticMarkup(React.createElement(PreviewImageContent, { imageUrl: undefined }))

  assert.match(markup, /Connect an image to preview\./)
  assert.doesNotMatch(markup, /<img/)
  assert.doesNotMatch(markup, /h-full/)
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
