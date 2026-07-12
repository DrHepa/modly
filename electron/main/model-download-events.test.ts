import assert from 'node:assert/strict'
import test from 'node:test'

const {
  buildHttpsDownloadAssetsRequest,
  buildManifestAssetDownloadRequest,
  ModelAssetDownloadError,
  normalizeDownloadEvent,
} = await import(new URL('./model-download-events.ts', import.meta.url).href)

test('builds a canonical-id-only asset request with token outside the URL', () => {
  assert.deepEqual(
    buildManifestAssetDownloadRequest('http://127.0.0.1:8765', 'cube3d/generate', 'private-token'),
    {
      url: 'http://127.0.0.1:8765/model/hf-download-assets?model_id=cube3d%2Fgenerate',
      headers: { Authorization: 'Bearer private-token' },
    },
  )
})

test('builds a canonical-id-only HTTPS asset request without authorization', () => {
  assert.deepEqual(
    buildHttpsDownloadAssetsRequest(
      'http://127.0.0.1:8765',
      'gaussiangpt/vfront?variant=a&b',
    ),
    {
      url: 'http://127.0.0.1:8765/model/https-download-assets?model_id=gaussiangpt%2Fvfront%3Fvariant%3Da%26b',
      headers: {},
    },
  )
})

test('normalizes aggregate repository and file progress', () => {
  assert.deepEqual(normalizeDownloadEvent({
    percent: 62,
    status: 'downloaded',
    file: 'clip/model.safetensors',
    fileIndex: 7,
    totalFiles: 11,
    repoIndex: 2,
    totalRepos: 2,
  }), {
    progress: {
      percent: 62,
      status: 'downloaded',
      file: 'clip/model.safetensors',
      fileIndex: 7,
      totalFiles: 11,
      repoIndex: 2,
      totalRepos: 2,
    },
  })
})

test('preserves structured actionable failures without exposing unknown fields', () => {
  const event = normalizeDownloadEvent({
    error: {
      code: 'hash_mismatch',
      stage: 'verify',
      message: 'Downloaded file failed verification',
      repo_id: 'owner/model',
      file: 'cube3d/model.pt',
      retryable: true,
      token: 'must-not-leak',
    },
  })

  assert.deepEqual(event, {
    failure: {
      code: 'hash_mismatch',
      stage: 'verify',
      message: 'Downloaded file failed verification',
      repoId: 'owner/model',
      file: 'cube3d/model.pt',
      retryable: true,
    },
  })

  const error = new ModelAssetDownloadError(event.failure)
  assert.equal(error.message.includes('hash_mismatch'), true)
  assert.equal(error.message.includes('cube3d/model.pt'), true)
  assert.equal(error.message.includes('must-not-leak'), false)
})
