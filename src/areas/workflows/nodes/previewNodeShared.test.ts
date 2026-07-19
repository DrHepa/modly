import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PREVIEW_IMAGE_NODE_TYPE,
  PREVIEW_VIEWS_NODE_TYPE,
  isPreviewNodeType,
  normalizePreviewImageUrl,
  normalizePreviewVideoUrl,
  resolvePreviewImageUrl,
  resolvePreviewVideoUrl,
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

test('resolvePreviewImageUrl routes a named secondary output by sourceHandle', () => {
  const imageUrl = resolvePreviewImageUrl({
    nodeId: 'preview-image',
    apiUrl: 'http://127.0.0.1:8000',
    edges: [{ source: 'model-node', sourceHandle: 'depth', target: 'preview-image' }],
    nodeImageOutputs: {
      'model-node': '/workspace/primary.png',
      'model-node::output::depth': '/workspace/depth.png',
    },
  })

  assert.equal(imageUrl, 'http://127.0.0.1:8000/workspace/depth.png')
})

test('resolvePreviewImageUrl does not fall back to the anonymous primary for a named output', () => {
  const imageUrl = resolvePreviewImageUrl({
    nodeId: 'preview-image',
    apiUrl: 'http://127.0.0.1:8000',
    edges: [{ source: 'model-node', sourceHandle: 'depth', target: 'preview-image' }],
    nodeImageOutputs: {
      'model-node': '/workspace/primary.png',
    },
  })

  assert.equal(imageUrl, undefined)
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
})


test('normalizePreviewVideoUrl prefixes workspace-relative outputs with apiUrl', () => {
  const videoUrl = normalizePreviewVideoUrl({ videoUrl: '/workspace/video/generated.mp4', apiUrl: 'http://127.0.0.1:8000' })

  assert.equal(videoUrl, 'http://127.0.0.1:8000/workspace/video/generated.mp4')
})

test('resolvePreviewVideoUrl returns the upstream video output for the first incoming edge', () => {
  const videoUrl = resolvePreviewVideoUrl({
    nodeId: 'preview-video',
    apiUrl: 'http://127.0.0.1:8000',
    edges: [{ source: 'source-a', target: 'preview-video' }],
    nodeVideoOutputs: {
      'source-a': '/workspace/video/generated.mp4',
    },
  })

  assert.equal(videoUrl, 'http://127.0.0.1:8000/workspace/video/generated.mp4')
})

test('resolvePreviewVideoUrl routes a named secondary output by sourceHandle', () => {
  const videoUrl = resolvePreviewVideoUrl({
    nodeId: 'preview-video',
    apiUrl: 'http://127.0.0.1:8000',
    edges: [{ source: 'model-node', sourceHandle: 'preview_clip', target: 'preview-video' }],
    nodeVideoOutputs: {
      'model-node': '/workspace/video/primary.mp4',
      'model-node::output::preview_clip': '/workspace/video/preview-clip.mp4',
    },
  })

  assert.equal(videoUrl, 'http://127.0.0.1:8000/workspace/video/preview-clip.mp4')
})
