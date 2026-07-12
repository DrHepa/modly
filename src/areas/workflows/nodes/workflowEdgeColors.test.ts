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


test('video preview node uses the video handle color as target color', () => {
  assert.equal(resolveWorkflowEdgeTargetColor({ targetNodeType: 'previewVideoNode' }), PROCESS_PORT_HANDLE_COLOR.video)
})


test('resolveWorkflowEdgeTargetColor gives inputless model targets the neutral no-port color', () => {
  const color = resolveWorkflowEdgeTargetColor({
    targetNodeType: 'extensionNode',
    targetExtension: { input: 'none' },
    targetHandle: null,
  })

  assert.equal(color, '#52525b')
  assert.notEqual(color, PROCESS_PORT_HANDLE_COLOR.image)
  assert.notEqual(color, PROCESS_PORT_HANDLE_COLOR.mesh)
  assert.notEqual(color, PROCESS_PORT_HANDLE_COLOR.scene)
})
