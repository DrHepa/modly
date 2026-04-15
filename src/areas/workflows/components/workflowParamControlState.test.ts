import assert from 'node:assert/strict'
import test from 'node:test'

import type { BooleanParamSchema, StringParamSchema } from '../../../shared/types/electron.d.ts'
import { selectWorkflowParamPath, toggleBooleanParamValue } from './workflowParamControlState.ts'

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
