import assert from 'node:assert/strict'
import test from 'node:test'

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

test('both preview node types normalize workspace outputs through the same shared seam', () => {
  const sharedArgs = {
    apiUrl: 'http://127.0.0.1:8000',
    getEdges: () => [{ source: 'source-a', target: 'preview-node' }],
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
    getEdges: () => [{ source: 'source-a', target: 'preview-node' }],
    nodeImageOutputs: { 'source-a': 'http://cdn.example.com/preview.png' },
  }

  assert.equal(resolvePreviewImageNodeUrl({ ...sharedArgs, nodeId: 'preview-node' }), 'http://cdn.example.com/preview.png')
  assert.equal(resolvePreviewViewsNodeUrl({ ...sharedArgs, nodeId: 'preview-node' }), 'http://cdn.example.com/preview.png')
})
