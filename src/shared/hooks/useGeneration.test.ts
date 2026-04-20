import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationOptions } from '../stores/appStore.ts'
import type { ModelExtension } from '../types/electron.d.ts'
import { resolveLegacyGenerationRequest } from './useGeneration.ts'

const baseOptions: GenerationOptions = {
  modelId: 'vendor/model',
  remesh: 'quad',
  enableTexture: false,
  textureResolution: 1024,
  modelParams: {},
}

function createModelExtension(input: 'image' | 'text' | 'mesh'): ModelExtension {
  return {
    id: 'vendor/model',
    type: 'model',
    name: 'Vendor model',
    trusted: true,
    builtin: false,
    nodes: [
      {
        id: 'generate',
        name: 'Generate',
        input,
        output: 'mesh',
        paramsSchema: [],
      },
    ],
  }
}

test('resolveLegacyGenerationRequest keeps image-first requests when capability metadata says image', () => {
  const request = resolveLegacyGenerationRequest({
    imagePath: '/tmp/source.png',
    selectedImageData: Buffer.from('png-bytes').toString('base64'),
    generationOptions: baseOptions,
    modelExtensions: [createModelExtension('image')],
  })

  assert.deepEqual(request, {
    kind: 'image',
    imagePath: '/tmp/source.png',
    imageData: Buffer.from('png-bytes').toString('base64'),
  })
})

test('resolveLegacyGenerationRequest resolves text requests from model metadata instead of assuming imagePath', () => {
  const request = resolveLegacyGenerationRequest({
    imagePath: '',
    selectedImageData: null,
    generationOptions: {
      ...baseOptions,
      modelParams: { prompt: 'A stone castle', seed: 7 },
    },
    modelExtensions: [createModelExtension('text')],
  })

  assert.deepEqual(request, {
    kind: 'text',
    prompt: 'A stone castle',
  })
})

test('resolveLegacyGenerationRequest throws a clear error when model metadata cannot resolve a supported input', () => {
  assert.throws(
    () => resolveLegacyGenerationRequest({
      imagePath: '/tmp/source.png',
      selectedImageData: null,
      generationOptions: baseOptions,
      modelExtensions: [createModelExtension('mesh')],
    }),
    { message: 'Unsupported generation input for model vendor/model: mesh' },
  )

  assert.throws(
    () => resolveLegacyGenerationRequest({
      imagePath: '/tmp/source.png',
      selectedImageData: null,
      generationOptions: baseOptions,
      modelExtensions: [],
    }),
    { message: 'Missing generation input metadata for model vendor/model' },
  )
})
