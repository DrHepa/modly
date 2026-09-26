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
    buildManifestAssetDownloadRequest('http://127.0.0.1:8765', 'cube3d/generate', undefined, 'private-token'),
    {
      url: 'http://127.0.0.1:8765/model/hf-download-assets?model_id=cube3d%2Fgenerate',
      headers: { Authorization: 'Bearer private-token' },
    },
  )
})

test('builds structured HF asset request with a safe target owner outside the renderer payload', () => {
  assert.deepEqual(
    buildManifestAssetDownloadRequest(
      'http://127.0.0.1:8765',
      'cube3d/generate',
      'cube3d/shared-owner',
      'private-token',
    ),
    {
      url: 'http://127.0.0.1:8765/model/hf-download-assets?model_id=cube3d%2Fgenerate&target_owner_id=cube3d%2Fshared-owner',
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

test('builds structured HTTPS asset request with a safe target owner', () => {
  assert.deepEqual(
    buildHttpsDownloadAssetsRequest(
      'http://127.0.0.1:8765',
      'gaussiangpt/generate',
      'gaussiangpt/generate',
    ),
    {
      url: 'http://127.0.0.1:8765/model/https-download-assets?model_id=gaussiangpt%2Fgenerate&target_owner_id=gaussiangpt%2Fgenerate',
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

test('normalizes byte-level progress fields used by pause and resume UI', () => {
  assert.deepEqual(normalizeDownloadEvent({
    percent: 7,
    status: 'Downloading...',
    file: 'main/model.safetensors',
    bytesDownloaded: 1024,
    totalBytes: 4096,
    stalledSeconds: 0,
  }), {
    progress: {
      percent: 7,
      status: 'Downloading...',
      file: 'main/model.safetensors',
      bytesDownloaded: 1024,
      totalBytes: 4096,
      stalledSeconds: 0,
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

test('normalizes terminal control events without requiring percent', () => {
  assert.deepEqual(normalizeDownloadEvent({
    status: 'cancelled',
    cancelled: true,
    bytesDownloaded: 2048,
    totalBytes: 4096,
    stalledSeconds: 0,
  }), {
    progress: {
      percent: 0,
      status: 'cancelled',
      cancelled: true,
      bytesDownloaded: 2048,
      totalBytes: 4096,
      stalledSeconds: 0,
    },
  })

  assert.deepEqual(normalizeDownloadEvent({ status: 'paused', paused: true }), {
    progress: { percent: 0, status: 'paused', paused: true },
  })
})
