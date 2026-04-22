import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKFLOW_BUILTIN_PANEL_NODES,
  WORKFLOW_BUILTIN_PALETTE_NODES,
  WORKFLOW_BUILTIN_NODE_TYPES,
  createBuiltinWorkflowNode,
} from './workflowBuiltinNodeCatalog.tsx'
import { PREVIEW_IMAGE_NODE_TYPE, PREVIEW_VIEWS_NODE_TYPE } from './nodes/previewNodeShared.ts'

test('workflow catalog includes both legacy preview views and single-image preview node types', () => {
  assert.deepEqual(
    WORKFLOW_BUILTIN_NODE_TYPES.filter((type) => type === PREVIEW_VIEWS_NODE_TYPE || type === PREVIEW_IMAGE_NODE_TYPE),
    [PREVIEW_IMAGE_NODE_TYPE, PREVIEW_VIEWS_NODE_TYPE],
  )
})

test('createBuiltinWorkflowNode initializes preview nodes with workflow-safe defaults', () => {
  const node = createBuiltinWorkflowNode(PREVIEW_IMAGE_NODE_TYPE, { x: 24, y: 48 })

  assert.equal(node.type, PREVIEW_IMAGE_NODE_TYPE)
  assert.deepEqual(node.position, { x: 24, y: 48 })
  assert.deepEqual(node.data, { extensionId: undefined, enabled: true, params: {} })
})

test('workflow built-in drag panel exposes both preview nodes with distinct labels', () => {
  const previewEntries = WORKFLOW_BUILTIN_PANEL_NODES.filter((node) => node.type === PREVIEW_VIEWS_NODE_TYPE || node.type === PREVIEW_IMAGE_NODE_TYPE)

  assert.deepEqual(
    previewEntries.map((node) => [node.type, node.label]),
    [
      [PREVIEW_IMAGE_NODE_TYPE, 'Preview Image'],
      [PREVIEW_VIEWS_NODE_TYPE, 'Preview Views'],
    ],
  )
})

test('workflow palette copy clarifies single-image versus multi-view previews', () => {
  const previewPaletteEntries = WORKFLOW_BUILTIN_PALETTE_NODES.filter((node) => node.type === PREVIEW_VIEWS_NODE_TYPE || node.type === PREVIEW_IMAGE_NODE_TYPE)

  assert.deepEqual(
    previewPaletteEntries.map((node) => [node.label, node.description]),
    [
      ['Preview Image', 'Displays a single upstream image output'],
      ['Preview Views', 'Displays multi-view image strips in a 2×3 grid'],
    ],
  )
})
