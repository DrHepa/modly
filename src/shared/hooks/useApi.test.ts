import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationOptions } from '../stores/appStore.ts'
import { createGenerationApi } from './useApi.ts'

type ApiClientMock = Parameters<typeof createGenerationApi>[0]['client']

const options: GenerationOptions = {
  modelId: 'text/model',
  remesh: 'triangle',
  enableTexture: true,
  textureResolution: 2048,
  modelParams: { seed: 7 },
}

test('generateFromText posts JSON payload to /generate/from-text', async () => {
  const calls: Array<{ path: string; data: unknown; config: unknown }> = []
  const api = createGenerationApi({
    client: {
      async post(path: string, data?: unknown, config?: unknown) {
        calls.push({ path, data, config })
        return { data: { job_id: 'job-text-1' } }
      },
      async get() {
        throw new Error('Unexpected get call')
      },
    } as unknown as ApiClientMock,
    readFileBase64: async () => {
      throw new Error('readFileBase64 should not be called for text requests')
    },
  })

  const result = await api.generateFromText('A stone castle', options)

  assert.deepEqual(result, { jobId: 'job-text-1' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/generate/from-text')
  assert.deepEqual(calls[0].data, {
    prompt: 'A stone castle',
    model_id: 'text/model',
    remesh: 'triangle',
    enable_texture: true,
    texture_resolution: 2048,
    params: { seed: 7 },
  })
})

test('generateFromImage keeps multipart payload and does not read disk when imageData is provided', async () => {
  const calls: Array<{ path: string; data: FormData; config: unknown }> = []
  let readFileCalls = 0
  const api = createGenerationApi({
    client: {
      async post(path: string, data?: unknown, config?: unknown) {
        calls.push({ path, data: data as FormData, config })
        return { data: { job_id: 'job-image-1' } }
      },
      async get() {
        throw new Error('Unexpected get call')
      },
    } as unknown as ApiClientMock,
    readFileBase64: async () => {
      readFileCalls += 1
      return Buffer.from('fs-bytes').toString('base64')
    },
  })

  const result = await api.generateFromImage('/tmp/source.png', options, Buffer.from('png-bytes').toString('base64'))

  assert.deepEqual(result, { jobId: 'job-image-1' })
  assert.equal(readFileCalls, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/generate/from-image')
  assert.equal(calls[0].data.get('model_id'), 'text/model')
  assert.equal(calls[0].data.get('remesh'), 'triangle')
  assert.equal(calls[0].data.get('enable_texture'), 'true')
  assert.equal(calls[0].data.get('texture_resolution'), '2048')
  assert.equal(calls[0].data.get('params'), JSON.stringify({ seed: 7 }))
  assert.equal(calls[0].data.get('image') instanceof File, true)
})
