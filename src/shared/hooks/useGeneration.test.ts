import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationOptions } from '../stores/appStore.ts'
import type { ModelExtension } from '../types/electron.d.ts'
import { resolveLegacyGenerationRequest } from './useGeneration.ts'
import { createGenerationApi } from './useApi.ts'

const baseOptions: GenerationOptions = {
  modelId: 'vendor/model',
  remesh: 'quad',
  enableTexture: false,
  textureResolution: 1024,
  modelParams: {},
}

function createModelExtension(input: 'none' | 'image' | 'text' | 'mesh' | 'scene'): ModelExtension {
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



test('resolveLegacyGenerationRequest resolves inputless models before image validation', () => {
  const request = resolveLegacyGenerationRequest({
    imagePath: null,
    selectedImageData: Buffer.from('must-not-be-read').toString('base64'),
    generationOptions: {
      ...baseOptions,
      modelParams: { seed: 23 },
    },
    modelExtensions: [createModelExtension('none')],
  })

  assert.deepEqual(request, { kind: 'none' })
})

test('resolveLegacyGenerationRequest retains legacy modalities and diagnoses missing metadata', () => {
  assert.deepEqual(resolveLegacyGenerationRequest({
    imagePath: '/tmp/source.png', selectedImageData: null,
    generationOptions: baseOptions, modelExtensions: [createModelExtension('mesh')],
  }), { kind: 'image', imagePath: '/tmp/source.png', imageData: undefined })

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

test('resolves the selected composite node rather than the first node in its bundle', { timeout: 1000 }, () => {
  const extension = createModelExtension('image')
  extension.nodes.push({ ...extension.nodes[0], id: 'text', input: 'text' })
  assert.deepEqual(resolveLegacyGenerationRequest({ imagePath: null, selectedImageData: null,
    generationOptions: { ...baseOptions, modelId: `${extension.id}/text`, modelParams: { prompt: 'selected text' } },
    modelExtensions: [extension],
  }), { kind: 'text', prompt: 'selected text' })
})

test('keeps scene and positional text-only declarations distinct from image fallback', { timeout: 1000 }, () => {
  const extension = createModelExtension('image')
  extension.nodes[0].input = 'scene'
  assert.deepEqual(resolveLegacyGenerationRequest({ imagePath: 'Scenes/demo/scene-manifest.json', selectedImageData: null,
    generationOptions: baseOptions, modelExtensions: [extension],
  }), { kind: 'scene', inputPath: 'Scenes/demo/scene-manifest.json' })
  extension.nodes[0].input = 'image'
  extension.nodes[0].inputs = ['text', 'text']
  assert.deepEqual(resolveLegacyGenerationRequest({ imagePath: null, selectedImageData: null,
    generationOptions: { ...baseOptions, modelParams: { prompt: '' } }, modelExtensions: [extension],
  }), { kind: 'text', prompt: '' })
})

const submissionCases = [
  { name: 'text-first mixed inputs retain the selected image', input: 'text', inputs: ['text', 'image'], kind: 'image' },
  { name: 'image-first mixed inputs retain the selected image', input: 'image', inputs: ['image', 'text'], kind: 'image' },
  { name: 'all-text positional inputs override scalar image', input: 'image', inputs: ['text', 'text'], kind: 'text' },
  { name: 'missing positional inputs preserve scalar text', input: 'text', inputs: undefined, kind: 'text' },
  { name: 'empty positional inputs preserve scalar text', input: 'text', inputs: [], kind: 'text' },
  { name: 'missing positional inputs preserve scalar image', input: 'image', inputs: undefined, kind: 'image' },
  { name: 'empty positional inputs preserve scalar image', input: 'image', inputs: [], kind: 'image' },
  { name: 'custom positional inputs retain the legacy artifact fallback', input: 'text', inputs: ['text', 'custom-artifact'], kind: 'image' },
]

for (const { name, input, inputs, kind } of submissionCases) {
  test(`resolver and API submission: ${name}`, { timeout: 2000 }, async () => {
    const extension = createModelExtension('image')
    extension.nodes.push({ ...extension.nodes[0], id: 'selected', input, inputs })
    const options = { ...baseOptions, modelId: `${extension.id}/selected`, modelParams: { prompt: 'requested prompt' } }
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x42])
    const calls: Array<{ path: string; body: unknown }> = []
    const api = createGenerationApi({
      client: {
        async post(path: string, body: unknown) {
          calls.push({ path, body })
          return { data: { job_id: 'fixture-job' } }
        },
        async get() { throw new Error('Unexpected poll') },
      } as unknown as Parameters<typeof createGenerationApi>[0]['client'],
      readFileBase64: async () => { throw new Error('Selected image data must avoid disk reads') },
    })
    const request = resolveLegacyGenerationRequest({
      imagePath: '/tmp/reference.png', selectedImageData: imageBytes.toString('base64'),
      generationOptions: options, modelExtensions: [extension],
    })

    assert.deepEqual(await api.submitGeneration(request, options), { jobId: 'fixture-job' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, `/generate/from-${kind}`)
    if (kind === 'image') {
      assert.ok(calls[0].body instanceof FormData)
      const image = calls[0].body.get('image')
      assert.ok(image instanceof Blob)
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes)
      assert.equal(calls[0].body.get('model_id'), options.modelId)
      assert.equal(calls[0].body.get('params'), JSON.stringify(options.modelParams))
    } else {
      assert.deepEqual(calls[0].body, {
        prompt: options.modelParams.prompt, model_id: options.modelId, remesh: options.remesh,
        enable_texture: options.enableTexture, texture_resolution: options.textureResolution,
        params: options.modelParams,
      })
    }
  })
}
