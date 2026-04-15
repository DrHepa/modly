import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAllWorkflowExtensions } from './mockExtensions.ts'
import { normalizeWorkflowParams } from './workflowParamSchema.ts'

test('normalizes legacy select, string, int, and float descriptors without changing defaults', () => {
  const params = normalizeWorkflowParams([
    {
      id: 'quality',
      label: 'Quality',
      type: 'select',
      default: 'high',
      options: [
        { value: 'high', label: 'High' },
        { value: 'low', label: 'Low' },
      ],
    },
    {
      id: 'prompt',
      label: 'Prompt',
      type: 'string',
      default: 'hello',
      tooltip: 'Legacy string param',
    },
    {
      id: 'steps',
      label: 'Steps',
      type: 'int',
      default: 25,
      min: 1,
      max: 50,
      step: 1,
    },
    {
      id: 'strength',
      label: 'Strength',
      type: 'float',
      default: 0.35,
      min: 0,
      max: 1,
      step: 0.05,
    },
  ])

  assert.deepEqual(params, [
    {
      id: 'quality',
      label: 'Quality',
      type: 'select',
      default: 'high',
      options: [
        { value: 'high', label: 'High' },
        { value: 'low', label: 'Low' },
      ],
    },
    {
      id: 'prompt',
      label: 'Prompt',
      type: 'string',
      default: 'hello',
      tooltip: 'Legacy string param',
    },
    {
      id: 'steps',
      label: 'Steps',
      type: 'int',
      default: 25,
      min: 1,
      max: 50,
      step: 1,
    },
    {
      id: 'strength',
      label: 'Strength',
      type: 'float',
      default: 0.35,
      min: 0,
      max: 1,
      step: 0.05,
    },
  ])
})

test('normalizes boolean descriptors with boolean defaults intact', () => {
  const [param] = normalizeWorkflowParams([
    { id: 'preserve', label: 'Preserve UVs', type: 'boolean', default: true },
  ])

  assert.deepEqual(param, {
    id: 'preserve',
    label: 'Preserve UVs',
    type: 'boolean',
    default: true,
  })
})

test('normalizes explicit picker-intent metadata on string descriptors', () => {
  const [param] = normalizeWorkflowParams([
    {
      id: 'source_path',
      label: 'Source Path',
      type: 'string',
      default: '',
      pickerIntent: 'image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg'] }],
    },
  ])

  assert.deepEqual(param, {
    id: 'source_path',
    label: 'Source Path',
    type: 'string',
    default: '',
    pickerIntent: 'image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg'] }],
  })
})

test('keeps plain string params plain when no explicit picker intent is declared', () => {
  const [param] = normalizeWorkflowParams([
    {
      id: 'output_path',
      label: 'Output Path',
      type: 'string',
      default: '',
      tooltip: 'Workspace-relative export path',
      filters: [{ name: 'Meshes', extensions: ['glb'] }],
    },
  ])

  assert.deepEqual(param, {
    id: 'output_path',
    label: 'Output Path',
    type: 'string',
    default: '',
    tooltip: 'Workspace-relative export path',
  })
})

test('drops picker metadata when the picker intent cannot be resolved explicitly', () => {
  const [param] = normalizeWorkflowParams([
    {
      id: 'source_path',
      label: 'Source Path',
      type: 'string',
      default: '',
      pickerIntent: 'folderish',
      filters: [{ name: 'Images', extensions: ['png'] }],
    },
  ])

  assert.deepEqual(param, {
    id: 'source_path',
    label: 'Source Path',
    type: 'string',
    default: '',
  })
})

test('falls back to unsupported descriptors safely instead of mis-normalizing them', () => {
  const [param] = normalizeWorkflowParams([
    { id: 'advanced', label: 'Advanced', type: 'json', default: '{}' },
  ])

  assert.deepEqual(param, {
    id: 'advanced',
    label: 'Advanced',
    type: 'unsupported',
    default: '',
    reason: 'Unsupported param descriptor type: json',
    rawType: 'json',
  })
})

test('keeps unsupported descriptors visible as explicit fallback labels in workflow extensions', () => {
  const [extension] = buildAllWorkflowExtensions([], [
    {
      type: 'process',
      id: 'example-extension',
      name: 'Example Extension',
      trusted: true,
      builtin: true,
      entry: 'index.py',
      nodes: [
        {
          id: 'example-node',
          name: 'Example Node',
          input: 'image',
          output: 'mesh',
          paramsSchema: [
            { id: 'advanced', label: 'Advanced', type: 'json', default: '{}' },
          ],
        },
      ],
    },
  ])

  assert.deepEqual(extension.params, [
    {
      id: 'advanced',
      label: 'Advanced',
      type: 'unsupported',
      default: '',
      reason: 'Unsupported param descriptor type: json',
      rawType: 'json',
    },
  ])
})
