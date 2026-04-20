import assert from 'node:assert/strict'
import test from 'node:test'

import type { WFNode } from '@shared/types/electron.d'

import type { WorkflowExtension } from './mockExtensions.ts'
import { createHydratedExtensionWorkflowNode } from './workflowNodeFactory.ts'

function createWorkflowExtension(overrides: Partial<WorkflowExtension>): WorkflowExtension {
  return {
    id: 'ext/image-to-mesh',
    extensionId: 'ext',
    extensionName: 'Extension',
    extensionAuthor: 'Tests',
    nodeId: 'image-to-mesh',
    name: 'Image To Mesh',
    description: 'Test extension',
    input: 'image',
    output: 'mesh',
    params: [],
    builtin: false,
    type: 'model',
    ...overrides,
  }
}

test('creates process extension nodes with hydrated params for drag and drop flows', () => {
  const allExtensions = [
    createWorkflowExtension({
      id: 'ext/upscale',
      nodeId: 'upscale',
      type: 'process',
      params: [
        { id: 'scale', label: 'Scale', type: 'float', default: 1.5 },
        { id: 'mode', label: 'Mode', type: 'select', default: 'sharp', options: [{ value: 'sharp', label: 'Sharp' }] },
      ],
    }),
  ]

  const node = createHydratedExtensionWorkflowNode({
    id: 'node-process',
    extensionId: 'ext/upscale',
    position: { x: 40, y: 80 },
    allExtensions,
  }) satisfies WFNode

  assert.deepEqual(node, {
    id: 'node-process',
    type: 'extensionNode',
    position: { x: 40, y: 80 },
    data: {
      extensionId: 'ext/upscale',
      enabled: true,
      params: {
        scale: 1.5,
        mode: 'sharp',
      },
    },
  })
})

test('creates model extension nodes with hydrated params for palette flows', () => {
  const allExtensions = [
    createWorkflowExtension({
      id: 'ext/flux',
      nodeId: 'flux',
      type: 'model',
      params: [
        { id: 'prompt', label: 'Prompt', type: 'string', default: 'cinematic' },
        { id: 'seed', label: 'Seed', type: 'int', default: 7 },
      ],
    }),
  ]

  const node = createHydratedExtensionWorkflowNode({
    id: 'node-model',
    extensionId: 'ext/flux',
    position: { x: 120, y: 160 },
    allExtensions,
  }) satisfies WFNode

  assert.deepEqual(node.data, {
    extensionId: 'ext/flux',
    enabled: true,
    params: {
      prompt: 'cinematic',
      seed: 7,
    },
  })
  assert.notDeepEqual(node.data.params, {})
})
