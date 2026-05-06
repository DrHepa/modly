import assert from 'node:assert/strict'
import test from 'node:test'

import type { BooleanParamSchema, ParamSchema, StringParamSchema } from '../../../shared/types/electron.d.ts'
import {
  isPromptLikeStringParam,
  resolveStringParamEditorState,
  selectWorkflowParamPath,
  stopControlDragPropagation,
  toggleBooleanParamValue,
} from './workflowParamControlState.ts'

test('toggles boolean params as real booleans through the shared control seam', () => {
  const param: BooleanParamSchema = {
    id: 'preserve',
    label: 'Preserve UVs',
    type: 'boolean',
    default: true,
  }

  const toggledFromStoredValue = toggleBooleanParamValue(param, true)
  const toggledFromDefaultValue = toggleBooleanParamValue(param, 'unexpected')

  assert.equal(toggledFromStoredValue, false)
  assert.equal(typeof toggledFromStoredValue, 'boolean')
  assert.equal(toggledFromDefaultValue, false)
  assert.equal(typeof toggledFromDefaultValue, 'boolean')
})

test('dispatches explicit image picker intents and persists the selected string path', async () => {
  const param: StringParamSchema = {
    id: 'source_path',
    label: 'Source Path',
    type: 'string',
    default: '',
    pickerIntent: 'image',
    filters: [{ name: 'Images', extensions: ['png'] }],
  }

  let called = ''
  const selectedPath = await selectWorkflowParamPath({
    selectImage: async () => {
      called = 'selectImage'
      return '/tmp/source.png'
    },
    selectMeshFile: async () => {
      throw new Error('mesh picker should not run')
    },
    selectDirectory: async () => {
      throw new Error('directory picker should not run')
    },
    savePath: async () => {
      throw new Error('save-path picker should not run')
    },
  }, param, '')

  assert.equal(called, 'selectImage')
  assert.equal(selectedPath, '/tmp/source.png')
  assert.equal(typeof selectedPath, 'string')
})

test('dispatches explicit save-path picker intents with the current value and persists the selected string path', async () => {
  const param: StringParamSchema = {
    id: 'output_path',
    label: 'Output Path',
    type: 'string',
    default: '',
    pickerIntent: 'save-path',
    filters: [{ name: 'Meshes', extensions: ['glb'] }],
  }

  let savePathArgs: { filters: { name: string; extensions: string[] }[]; defaultPath?: string } | null = null
  const selectedPath = await selectWorkflowParamPath({
    selectImage: async () => {
      throw new Error('image picker should not run')
    },
    selectMeshFile: async () => {
      throw new Error('mesh picker should not run')
    },
    selectDirectory: async () => {
      throw new Error('directory picker should not run')
    },
    savePath: async (args) => {
      savePathArgs = args
      return '/tmp/output.glb'
    },
  }, param, '/workspace/current.glb')

  assert.deepEqual(savePathArgs, {
    filters: [{ name: 'Meshes', extensions: ['glb'] }],
    defaultPath: '/workspace/current.glb',
  })
  assert.equal(selectedPath, '/tmp/output.glb')
  assert.equal(typeof selectedPath, 'string')
})

test('detects prompt-like string params by exact prompt id and prompt labels only', () => {
  const promptIdParam: StringParamSchema = {
    id: 'prompt',
    label: 'Text',
    type: 'string',
    default: '',
  }
  const promptLabelParam: StringParamSchema = {
    id: 'text',
    label: 'Negative Prompt',
    type: 'string',
    default: '',
  }
  const genericStringParam: StringParamSchema = {
    id: 'name',
    label: 'Model Name',
    type: 'string',
    default: '',
  }
  const nonStringPromptParam: ParamSchema = {
    id: 'prompt',
    label: 'Prompt Count',
    type: 'int',
    default: 1,
  }

  assert.equal(isPromptLikeStringParam(promptIdParam), true)
  assert.equal(isPromptLikeStringParam(promptLabelParam), true)
  assert.equal(isPromptLikeStringParam(genericStringParam), false)
  assert.equal(isPromptLikeStringParam(nonStringPromptParam), false)
})

test('resolves multiline editor state for prompt-like strings without changing string values', () => {
  const promptParam: StringParamSchema = {
    id: 'prompt',
    label: 'Prompt',
    type: 'string',
    default: '',
  }

  const promptState = resolveStringParamEditorState(promptParam, 'line one\nline two', false)
  const compactGenericState = resolveStringParamEditorState({
    id: 'seed_name',
    label: 'Seed Name',
    type: 'string',
    default: '',
  }, 'short value', false)
  const expandedGenericState = resolveStringParamEditorState({
    id: 'description',
    label: 'Description',
    type: 'string',
    default: '',
  }, 'long value', true)

  assert.deepEqual(promptState, { mode: 'multiline', value: 'line one\nline two' })
  assert.equal(typeof promptState.value, 'string')
  assert.deepEqual(compactGenericState, { mode: 'compact', value: 'short value' })
  assert.equal(typeof compactGenericState.value, 'string')
  assert.deepEqual(expandedGenericState, { mode: 'multiline', value: 'long value' })
  assert.equal(typeof expandedGenericState.value, 'string')
})

test('stops drag-start down events without preventing native control behavior', () => {
  let stopped = 0
  let prevented = 0

  stopControlDragPropagation({
    stopPropagation: () => {
      stopped += 1
    },
    preventDefault: () => {
      prevented += 1
    },
  })

  assert.equal(stopped, 1)
  assert.equal(prevented, 0)
})
