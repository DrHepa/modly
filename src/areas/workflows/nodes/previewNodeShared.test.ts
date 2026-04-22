import assert from 'node:assert/strict'
import test from 'node:test'

import type { WFNode } from '../../../shared/types/electron.d'
import {
  PREVIEW_IMAGE_NODE_TYPE,
  PREVIEW_VIEWS_NODE_TYPE,
  isPreviewNodeType,
  normalizePreviewImageUrl,
  resolvePreviewImageUrl,
} from './previewNodeShared.ts'

test('normalizePreviewImageUrl prefixes workspace-relative outputs with apiUrl', () => {
  const imageUrl = normalizePreviewImageUrl({ imageUrl: '/workspace/preview.png', apiUrl: 'http://127.0.0.1:8000' })

  assert.equal(imageUrl, 'http://127.0.0.1:8000/workspace/preview.png')
})

test('normalizePreviewImageUrl preserves already absolute and unrelated values', () => {
  assert.equal(
    normalizePreviewImageUrl({ imageUrl: 'http://cdn.example.com/image.png', apiUrl: 'http://127.0.0.1:8000' }),
    'http://cdn.example.com/image.png',
  )
  assert.equal(
    normalizePreviewImageUrl({ imageUrl: 'blob:http://localhost/preview-id', apiUrl: 'http://127.0.0.1:8000' }),
    'blob:http://localhost/preview-id',
  )
  assert.equal(
    normalizePreviewImageUrl({ imageUrl: '/tmp/preview.png', apiUrl: 'http://127.0.0.1:8000' }),
    '/tmp/preview.png',
  )
})

test('normalizePreviewImageUrl hides workspace-relative outputs until apiUrl is available', () => {
  assert.equal(normalizePreviewImageUrl({ imageUrl: '/workspace/preview.png', apiUrl: '' }), undefined)
  assert.equal(normalizePreviewImageUrl({ imageUrl: '/workspace/preview.png', apiUrl: undefined }), undefined)
})

test('normalization preserves data URLs, exact non-workspace paths and empty outputs', () => {
  for (const imageUrl of ['data:image/png;base64,AA==', '/workspaceish/image.png', '/optimize/serve-file?path=image.png']) {
    assert.equal(normalizePreviewImageUrl({ imageUrl, apiUrl: '' }), imageUrl)
    assert.equal(normalizePreviewImageUrl({ imageUrl, apiUrl: 'http://127.0.0.1:8765' }), imageUrl)
  }
  assert.equal(normalizePreviewImageUrl({ imageUrl: undefined, apiUrl: 'http://127.0.0.1:8765' }), undefined)
  assert.equal(normalizePreviewImageUrl({ imageUrl: '', apiUrl: 'http://127.0.0.1:8765' }), undefined)
})

test('resolvePreviewImageUrl returns the upstream image output for the first incoming edge', () => {
  const imageUrl = resolvePreviewImageUrl({
    nodeId: 'preview-image',
    apiUrl: 'http://127.0.0.1:8000',
    edges: [
      { source: 'source-a', target: 'preview-image' },
      { source: 'source-b', target: 'preview-image' },
    ],
    nodeImageOutputs: {
      'source-a': '/workspace/first.png',
      'source-b': '/workspace/second.png',
    },
  })

  assert.equal(imageUrl, 'http://127.0.0.1:8000/workspace/first.png')
})

test('resolvePreviewImageUrl preserves non-workspace upstream outputs without apiUrl', () => {
  const imageUrl = resolvePreviewImageUrl({
    nodeId: 'preview-image',
    apiUrl: '',
    edges: [{ source: 'source-a', target: 'preview-image' }],
    nodeImageOutputs: {
      'source-a': 'http://cdn.example.com/preview.png',
    },
  })

  assert.equal(imageUrl, 'http://cdn.example.com/preview.png')
})

test('resolvePreviewImageUrl returns undefined for workspace outputs while apiUrl is unavailable', () => {
  const imageUrl = resolvePreviewImageUrl({
    nodeId: 'preview-image',
    apiUrl: '',
    edges: [{ source: 'source-a', target: 'preview-image' }],
    nodeImageOutputs: {
      'source-a': '/workspace/first.png',
    },
  })

  assert.equal(imageUrl, undefined)
})

test('resolvePreviewImageUrl returns undefined when no incoming image output is available', () => {
  const imageUrl = resolvePreviewImageUrl({
    nodeId: 'preview-image',
    apiUrl: 'http://127.0.0.1:8000',
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
  assert.equal(resolvePreviewImageUrl({ nodeId: '3', apiUrl: 'http://127.0.0.1:8000', nodes, edges, nodeImageOutputs: { '0': '/workspace/image.png' } }), 'http://127.0.0.1:8000/workspace/image.png')
  assert.equal(resolvePreviewImageUrl({ nodeId: '3', apiUrl: 'http://127.0.0.1:8000', nodes, edges: [], nodeImageOutputs: { '0': '/workspace/image.png' } }), undefined)
})

test('current API changes, rewiring and disconnection retain the authoritative upstream source', () => {
  const nodes: WFNode[] = ['imageNode', 'waitNode', 'imagePreviewNode', 'previewImageNode', 'imageNode'].map((type, i) => ({ id: String(i), type, position: { x: 0, y: 0 }, data: { enabled: true, params: {} } }))
  const edges = [{ source: '0', target: '1' }, { source: '1', target: '2' }, { source: '2', target: '3' }]
  const args = { nodeId: '3', nodes, edges, nodeImageOutputs: { '0': '/workspace/first.png', '4': '/workspace/second.png' } }
  for (const apiUrl of ['http://127.0.0.1:8000', 'http://127.0.0.1:9000']) {
    assert.equal(resolvePreviewImageUrl({ ...args, apiUrl }), `${apiUrl}/workspace/first.png`)
    assert.equal(resolvePreviewImageUrl({ ...args, apiUrl, edges: [{ source: '4', target: '3' }] }), `${apiUrl}/workspace/second.png`)
  }
  assert.equal(resolvePreviewImageUrl({ ...args, apiUrl: '' }), undefined)
  assert.equal(resolvePreviewImageUrl({ ...args, apiUrl: 'http://127.0.0.1:9000', edges: [] }), undefined)
  assert.equal(resolvePreviewImageUrl({ ...args, apiUrl: 'http://127.0.0.1:9000', nodeImageOutputs: {} }), undefined)
})
