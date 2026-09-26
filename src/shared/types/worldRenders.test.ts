import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORLD_RENDER_ARTIFACT_MAX_BYTES,
  WORLD_RENDER_DEFAULT_PRESET,
  WORLD_RENDER_MAX_DURATION_SECONDS,
  WORLD_RENDER_MAX_FRAME_COUNT,
  WORLD_RENDER_PUBLIC_ERROR_CODES,
  WORLD_RENDER_CHANNELS,
  parseWorldRenderCancelRequest,
  parseWorldRenderCreateRequest,
  parseWorldRenderDeleteRequest,
  parseWorldRenderJobKeyRequest,
} from './worldRenders.ts'

const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const JOB_ID = 'render-0123456789abcdef0123456789abcdef'

test('render create requests are exact and default to 1080p at 30 fps', () => {
  assert.deepEqual(parseWorldRenderCreateRequest({
    projectKey: PROJECT_KEY,
    expectedRevision: 0,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
  }), {
    success: true,
    value: {
      projectKey: PROJECT_KEY,
      expectedRevision: 0,
      sceneId: 'scene:main',
      sequenceId: 'sequence:intro',
      preset: WORLD_RENDER_DEFAULT_PRESET,
    },
  })

  const custom = parseWorldRenderCreateRequest({
    projectKey: PROJECT_KEY,
    expectedRevision: 7,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
    preset: { width: 3840, height: 2160, fps: 60 },
  })
  assert.equal(custom.success, true)
  if (custom.success) assert.deepEqual(custom.value.preset, { width: 3840, height: 2160, fps: 60 })

  for (const invalid of [
    { projectKey: PROJECT_KEY, expectedRevision: 0, sceneId: 'scene:main', sequenceId: 'sequence:intro', outputPath: '/tmp/out.webm' },
    { projectKey: PROJECT_KEY, expectedRevision: -1, sceneId: 'scene:main', sequenceId: 'sequence:intro' },
    { projectKey: PROJECT_KEY, expectedRevision: Number.NaN, sceneId: 'scene:main', sequenceId: 'sequence:intro' },
    { projectKey: PROJECT_KEY, expectedRevision: 0, sceneId: '../scene', sequenceId: 'sequence:intro' },
    { projectKey: PROJECT_KEY, expectedRevision: 0, sceneId: 'scene:main', sequenceId: 'sequence:intro', preset: { width: 1920, height: 1080, fps: 29 } },
    { projectKey: PROJECT_KEY, expectedRevision: 0, sceneId: 'scene:main', sequenceId: 'sequence:intro', preset: { width: 0, height: 1080, fps: 30 } },
    { projectKey: PROJECT_KEY, expectedRevision: 0, sceneId: 'scene:main', sequenceId: 'sequence:intro', preset: { width: 8192, height: 8192, fps: 30 } },
    { projectKey: PROJECT_KEY, expectedRevision: 0, sceneId: 'scene:main', sequenceId: 'sequence:intro', preset: { width: 1920, height: 1080, fps: 30, codec: 'vp9' } },
  ]) assert.equal(parseWorldRenderCreateRequest(invalid).success, false, JSON.stringify(invalid))

  const inherited = Object.create({
    projectKey: PROJECT_KEY,
    expectedRevision: 0,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
  })
  assert.equal(parseWorldRenderCreateRequest(inherited).success, false)
  assert.equal(parseWorldRenderCreateRequest({
    projectKey: PROJECT_KEY,
    expectedRevision: 0,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
    preset: Object.create({ width: 1920, height: 1080, fps: 30 }),
  }).success, false)

  const customPrototype = Object.assign(Object.create({ inherited: true }), {
    projectKey: PROJECT_KEY,
    expectedRevision: 0,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
  })
  assert.equal(parseWorldRenderCreateRequest(customPrototype).success, false)

  let getterInvoked = false
  const hiddenAccessor = {
    projectKey: PROJECT_KEY,
    expectedRevision: 0,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
  }
  Object.defineProperty(hiddenAccessor, 'hidden', {
    enumerable: false,
    get() {
      getterInvoked = true
      return 'unsafe'
    },
  })
  assert.equal(parseWorldRenderCreateRequest(hiddenAccessor).success, false)
  assert.equal(getterInvoked, false)

  const hiddenSymbol = {
    projectKey: PROJECT_KEY,
    expectedRevision: 0,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
  }
  Object.defineProperty(hiddenSymbol, Symbol('hidden'), { enumerable: false, value: true })
  assert.equal(parseWorldRenderCreateRequest(hiddenSymbol).success, false)
})

test('job, cancel, and delete requests accept only opaque IDs and retain zero progress inputs', () => {
  assert.deepEqual(parseWorldRenderJobKeyRequest({ jobId: JOB_ID }), { success: true, value: { jobId: JOB_ID } })
  assert.deepEqual(parseWorldRenderCancelRequest({ jobId: JOB_ID }), { success: true, value: { jobId: JOB_ID } })
  assert.deepEqual(parseWorldRenderDeleteRequest({ jobId: JOB_ID }), { success: true, value: { jobId: JOB_ID } })
  for (const value of [JOB_ID.toUpperCase(), '../render', 'C:\\render', '/tmp/render', 'render-short']) {
    assert.equal(parseWorldRenderJobKeyRequest({ jobId: value }).success, false, value)
  }
  assert.equal(parseWorldRenderCancelRequest({ jobId: JOB_ID, force: true }).success, false)
  assert.equal(parseWorldRenderDeleteRequest({ jobId: JOB_ID, expectedRevision: 0 }).success, false)
})

test('public render bounds and errors are stable', () => {
  assert.equal(WORLD_RENDER_MAX_DURATION_SECONDS, 900)
  assert.equal(WORLD_RENDER_MAX_FRAME_COUNT, 54_000)
  assert.deepEqual(WORLD_RENDER_ARTIFACT_MAX_BYTES, {
    frame: 256 * 1024 * 1024,
    audio: 8 * 1024 * 1024 * 1024,
    renderManifest: 512 * 1024 * 1024,
    webm: 64 * 1024 * 1024 * 1024,
  })
  assert.deepEqual(WORLD_RENDER_PUBLIC_ERROR_CODES, [
    'invalid_request',
    'unauthorized',
    'job_not_found',
    'project_not_found',
    'revision_conflict',
    'scene_not_found',
    'sequence_not_found',
    'sequence_invalid',
    'executor_unavailable',
    'job_busy',
    'unsafe_workspace',
    'output_invalid',
    'recovery_failed',
    'write_failed',
    'internal_error',
  ])
  assert.deepEqual(WORLD_RENDER_CHANNELS, {
    create: 'worlds:renders:create',
    list: 'worlds:renders:list',
    get: 'worlds:renders:get',
    cancel: 'worlds:renders:cancel',
    delete: 'worlds:renders:delete',
  })
})
