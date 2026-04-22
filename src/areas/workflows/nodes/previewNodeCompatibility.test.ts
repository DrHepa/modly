import assert from 'node:assert/strict'
import test from 'node:test'

import { WORKFLOW_BUILTIN_NODE_TYPES } from '../workflowBuiltinNodeCatalog.tsx'
import {
  PREVIEW_VIEWS_EMPTY_COPY,
  PREVIEW_VIEWS_NODE_TYPE,
  PREVIEW_VIEWS_TITLE,
} from './previewNodeShared.ts'

test('legacy previewNode workflows remain registered under the existing node type', () => {
  assert.equal(WORKFLOW_BUILTIN_NODE_TYPES.includes(PREVIEW_VIEWS_NODE_TYPE), true)
})

test('legacy previewNode copy remains focused on multi-view strips', () => {
  assert.equal(PREVIEW_VIEWS_TITLE, 'Preview Views')
  assert.equal(PREVIEW_VIEWS_EMPTY_COPY, 'Connect a multi-view image to preview.')
})
