import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PreviewImageContent } from './PreviewImageNode.tsx'
import { PreviewViewsContent } from './PreviewViewsNode.tsx'

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
