import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorkflowExtension } from './mockExtensions.ts'
import { hydrateWorkflowNodeParams } from './workflowNodeParams.ts'

type ModelWorkflowExtension = Extract<WorkflowExtension, { type: 'model' }>
type ProcessWorkflowExtension = Extract<WorkflowExtension, { type: 'process' }>

function createModelWorkflowExtension(overrides: Partial<ModelWorkflowExtension> = {}): ModelWorkflowExtension {
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

function createProcessWorkflowExtension(overrides: Partial<ProcessWorkflowExtension> = {}): ProcessWorkflowExtension {
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
    type: 'process',
    ...overrides,
  }
}

test('hydrates missing supported defaults for model nodes without mutating the input params', () => {
  const ext = createModelWorkflowExtension({
    params: [
      { id: 'prompt', label: 'Prompt', type: 'string', default: 'refine' },
      { id: 'steps', label: 'Steps', type: 'int', default: 30 },
      { id: 'enabled', label: 'Enabled', type: 'boolean', default: true },
    ],
  })
  const rawParams = { steps: 12 }

  const hydrated = hydrateWorkflowNodeParams(ext, rawParams)

  assert.deepEqual(hydrated, {
    prompt: 'refine',
    steps: 12,
    enabled: true,
  })
  assert.notEqual(hydrated, rawParams)
  assert.deepEqual(rawParams, { steps: 12 })
})

test('hydrates missing supported defaults for process nodes', () => {
  const ext = createProcessWorkflowExtension({
    id: 'ext/upscale',
    nodeId: 'upscale',
    params: [
      { id: 'scale', label: 'Scale', type: 'float', default: 1.5 },
      { id: 'mode', label: 'Mode', type: 'select', default: 'sharp', options: [{ value: 'sharp', label: 'Sharp' }] },
    ],
  })

  const hydrated = hydrateWorkflowNodeParams(ext, { scale: 2 })

  assert.deepEqual(hydrated, {
    scale: 2,
    mode: 'sharp',
  })
})

test('preserves explicit falsy overrides instead of replacing them with defaults', () => {
  const ext = createModelWorkflowExtension({
    params: [
      { id: 'enabled', label: 'Enabled', type: 'boolean', default: true },
      { id: 'seed', label: 'Seed', type: 'int', default: 99 },
      { id: 'prompt', label: 'Prompt', type: 'string', default: 'fallback' },
    ],
  })

  const hydrated = hydrateWorkflowNodeParams(ext, {
    enabled: false,
    seed: 0,
    prompt: '',
  })

  assert.deepEqual(hydrated, {
    enabled: false,
    seed: 0,
    prompt: '',
  })
})

test('ignores unsupported params when deriving defaults', () => {
  const ext = createModelWorkflowExtension({
    params: [
      { id: 'advanced', label: 'Advanced', type: 'unsupported', default: '', reason: 'Unsupported param descriptor type: json', rawType: 'json' },
      { id: 'quality', label: 'Quality', type: 'select', default: 'high', options: [{ value: 'high', label: 'High' }] },
    ],
  })

  const hydrated = hydrateWorkflowNodeParams(ext, {})

  assert.deepEqual(hydrated, { quality: 'high' })
})

test('returns a cloned params object when the workflow extension is missing', () => {
  const rawParams = { prompt: 'keep me' }

  const hydrated = hydrateWorkflowNodeParams(undefined, rawParams)

  assert.deepEqual(hydrated, rawParams)
  assert.notEqual(hydrated, rawParams)
})
