import assert from 'node:assert/strict'
import test from 'node:test'

import { PROCESS_PORT_HANDLE_COLOR } from '../processPorts.ts'
import { resolveWorkflowEdgeTargetColor } from './workflowEdgeColors.ts'

test('resolveWorkflowEdgeTargetColor treats both preview node variants as image sinks', () => {
  assert.equal(resolveWorkflowEdgeTargetColor({ targetNodeType: 'previewImageNode' }), PROCESS_PORT_HANDLE_COLOR.image)
  assert.equal(resolveWorkflowEdgeTargetColor({ targetNodeType: 'previewNode' }), PROCESS_PORT_HANDLE_COLOR.image)
})

test('resolveWorkflowEdgeTargetColor falls back to process target ports for extension nodes', () => {
  const color = resolveWorkflowEdgeTargetColor({
    targetNodeType: 'extensionNode',
    targetExtension: {
      inputs: [{ name: 'image', type: 'image', required: true }],
    },
    targetHandle: 'image',
  })

  assert.equal(color, PROCESS_PORT_HANDLE_COLOR.image)
})

test('resolveWorkflowEdgeTargetColor uses the scene color for scene extension targets', () => {
  const color = resolveWorkflowEdgeTargetColor({
    targetNodeType: 'extensionNode',
    targetExtension: {
      inputs: [{ name: 'scene', type: 'scene', required: true }],
    },
    targetHandle: 'scene',
  })

  assert.equal(color, PROCESS_PORT_HANDLE_COLOR.scene)
})

test('resolveWorkflowEdgeTargetColor keeps mesh outputs targeting scene nodes purple', () => {
  assert.equal(resolveWorkflowEdgeTargetColor({ targetNodeType: 'outputNode' }), PROCESS_PORT_HANDLE_COLOR.mesh)
})

test('upstream passthrough and both terminal previews have image target colors', () => {
  assert.equal(resolveWorkflowEdgeTargetColor({ targetNodeType: 'imagePreviewNode' }), PROCESS_PORT_HANDLE_COLOR.image)
})

test('target colors preserve positional, named, audio and custom port dialects', () => {
  assert.equal(resolveWorkflowEdgeTargetColor({ targetExtension: { inputs: ['image', 'audio'] }, targetHandle: 'input-1' }), PROCESS_PORT_HANDLE_COLOR.audio)
  assert.equal(resolveWorkflowEdgeTargetColor({ targetExtension: { inputs: ['image', 'audio'] } }), PROCESS_PORT_HANDLE_COLOR.image)
  assert.equal(resolveWorkflowEdgeTargetColor({ targetExtension: { inputs: [{ name: 'sound', type: 'audio' }] }, targetHandle: 'sound' }), PROCESS_PORT_HANDLE_COLOR.audio)
  assert.equal(resolveWorkflowEdgeTargetColor({ targetExtension: { inputs: [{ name: 'custom', type: 'landmarks' }] }, targetHandle: 'custom' }), '#52525b')
  assert.equal(resolveWorkflowEdgeTargetColor({ targetExtension: { input: 'audio' } }), PROCESS_PORT_HANDLE_COLOR.audio)
  assert.equal(resolveWorkflowEdgeTargetColor({ targetExtension: { inputs: ['image'] }, targetHandle: 'input-9' }), '#52525b')
})
