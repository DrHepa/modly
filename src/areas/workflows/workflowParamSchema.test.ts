import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAllWorkflowExtensions } from './mockExtensions.ts'
import { normalizeWorkflowParams, partitionAdvancedParams } from './workflowParamSchema.ts'

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

test('normalizes known advanced metadata without changing legacy defaults', () => {
  const [param] = normalizeWorkflowParams([
    {
      id: 'seed',
      label: 'Seed',
      type: 'int',
      default: 42,
      advanced: true,
      group: 'Sampling',
      ui: {
        control: 'slider',
        collapsed: true,
        order: 20,
        help: 'Use a fixed seed for reproducible output.',
      },
    },
  ])

  assert.deepEqual(param, {
    id: 'seed',
    label: 'Seed',
    type: 'int',
    default: 42,
    advanced: true,
    group: 'Sampling',
    ui: {
      control: 'slider',
      collapsed: true,
      order: 20,
      help: 'Use a fixed seed for reproducible output.',
    },
  })
})

test('ignores invalid advanced metadata while preserving supported schema fields', () => {
  const [param] = normalizeWorkflowParams([
    {
      id: 'prompt',
      label: 'Prompt',
      type: 'string',
      default: 'a mesh',
      tooltip: 'Legacy tooltip remains intact',
      advanced: 'yes',
      group: 123,
      ui: {
        control: 7,
        collapsed: 'true',
        order: Number.NaN,
        help: false,
      },
    },
  ])

  assert.deepEqual(param, {
    id: 'prompt',
    label: 'Prompt',
    type: 'string',
    default: 'a mesh',
    tooltip: 'Legacy tooltip remains intact',
  })
})

test('partitions basic and advanced params without changing their relative order', () => {
  const params = normalizeWorkflowParams([
    { id: 'prompt', label: 'Prompt', type: 'string', default: 'chair' },
    { id: 'seed', label: 'Seed', type: 'int', default: 42, advanced: true },
    { id: 'quality', label: 'Quality', type: 'select', default: 'high', options: [{ value: 'high', label: 'High' }] },
    { id: 'sampler', label: 'Sampler', type: 'string', default: 'ddim', advanced: true },
  ])

  const partitioned = partitionAdvancedParams(params)

  assert.deepEqual(partitioned.basic.map((param) => param.id), ['prompt', 'quality'])
  assert.deepEqual(partitioned.advanced.map((param) => param.id), ['seed', 'sampler'])
})

test('keeps legacy params in the basic section when no advanced metadata exists', () => {
  const params = normalizeWorkflowParams([
    { id: 'steps', label: 'Steps', type: 'int', default: 25 },
    { id: 'strength', label: 'Strength', type: 'float', default: 0.4 },
  ])

  const partitioned = partitionAdvancedParams(params)

  assert.deepEqual(partitioned.basic.map((param) => param.id), ['steps', 'strength'])
  assert.deepEqual(partitioned.advanced, [])
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
