import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  WorldRenderJobDetail,
  WorldRenderProgressPhase,
  WorldRendersApi,
} from '../../shared/types/worldRenders.ts'
import {
  WORLD_RENDER_ARTIFACT_MAX_BYTES,
  WORLD_RENDER_MANIFEST_FILENAME,
  WORLD_RENDER_MAX_FRAME_COUNT,
  WORLD_RENDER_MAX_STORED_JOBS,
} from '../../shared/types/worldRenders.ts'
import { WORLD_MAX_SEMANTIC_ISSUES } from './core/worldValidationLimits.ts'
import { createWorldRenderService } from './worldRenderService.ts'

const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const JOB_ID = 'render-0123456789abcdef0123456789abcdef'

function detail(status: WorldRenderJobDetail['status'] = 'succeeded'): WorldRenderJobDetail {
  const root = `Exports/Worlds/Renders/${JOB_ID}`
  const artifact = (workspacePath: string) => ({ workspacePath, size: 16, sha256: 'a'.repeat(64) })
  const terminal = ['cancelled', 'interrupted', 'failed', 'partial', 'succeeded', 'recovery_failed'].includes(status)
  const masters = status === 'succeeded' || status === 'partial'
  return {
    jobId: JOB_ID,
    projectKey: PROJECT_KEY,
    projectId: 'project:render',
    revision: 4,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
    preset: { width: 1920, height: 1080, fps: 30 },
    duration: { numerator: 1, denominator: 1 },
    frameCount: 1,
    status,
    progress: {
      phase: terminal ? 'complete' : activePhase(status),
      completedFrames: masters ? 1 : 0,
      frameCount: 1,
      completedUnits: masters ? 3 : 0,
      totalUnits: 3,
    },
    outputs: {
      frames: masters ? [{ ...artifact(`${root}/frames/frame-000000.png`), index: 0, time: { numerator: 0, denominator: 1 }, timestampMicroseconds: 0 }] : [],
      audio: masters ? artifact(`${root}/audio/master.wav`) : null,
      renderManifest: masters ? artifact(`${root}/${WORLD_RENDER_MANIFEST_FILENAME}`) : null,
      webm: status === 'succeeded' ? artifact(`${root}/output.webm`) : null,
    },
    error: status === 'partial' || status === 'failed' || status === 'recovery_failed'
      ? { code: 'output_invalid', message: 'World render output is incomplete or invalid.', retryable: false }
      : null,
    createdAt: '2026-09-03T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:01.000Z',
  }
}

function activePhase(status: WorldRenderJobDetail['status']): WorldRenderProgressPhase {
  if (status === 'queued' || status === 'preflighting' || status === 'rendering-frames'
    || status === 'rendering-audio' || status === 'assembling') return status
  return 'queued'
}

function partialApi(overrides: Partial<WorldRendersApi>): WorldRendersApi {
  const unavailable = async (): Promise<never> => { throw new Error('unused') }
  return {
    create: unavailable,
    list: unavailable,
    get: unavailable,
    cancel: unavailable,
    delete: unavailable,
    ...overrides,
  }
}

function frame(index: number): WorldRenderJobDetail['outputs']['frames'][number] {
  return {
    workspacePath: `Exports/Worlds/Renders/${JOB_ID}/frames/frame-${String(index).padStart(6, '0')}.png`,
    size: 16,
    sha256: 'a'.repeat(64),
    index,
    time: { numerator: index, denominator: 1 },
    timestampMicroseconds: index,
  }
}

function instrumentDescriptorReads<T>(values: T[]): {
  value: T[]
  reads: { indexed: number; length: number }
} {
  const reads = { indexed: 0, length: 0 }
  return {
    reads,
    value: new Proxy(values, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'length') reads.length += 1
        else if (typeof property === 'string' && /^(?:0|[1-9][0-9]*)$/.test(property)) reads.indexed += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    }),
  }
}

test('renderer render service is the sole narrow adapter and forwards five typed requests', async () => {
  const calls: string[] = []
  const succeeded = detail()
  const api: WorldRendersApi = {
    create: async () => { calls.push('create'); return { ok: true, value: succeeded } },
    list: async () => { calls.push('list'); return { ok: true, value: { jobs: [succeeded] } } },
    get: async () => { calls.push('get'); return { ok: true, value: succeeded } },
    cancel: async () => { calls.push('cancel'); return { ok: true, value: { ...succeeded, status: 'cancelled', outputs: { frames: [], audio: null, renderManifest: null, webm: null } } } },
    delete: async () => { calls.push('delete'); return { ok: true, value: { jobId: JOB_ID } } },
  }
  const service = createWorldRenderService(api)
  const request = { projectKey: PROJECT_KEY, expectedRevision: 4, sceneId: 'scene:main', sequenceId: 'sequence:intro', preset: { width: 1920, height: 1080, fps: 30 as const } }
  const created = await service.create(request)
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal((await service.list()).ok, true)
  assert.equal((await service.get({ jobId: JOB_ID })).ok, true)
  assert.equal((await service.cancel({ jobId: JOB_ID })).ok, true)
  assert.equal((await service.delete({ jobId: JOB_ID })).ok, true)
  assert.deepEqual(calls, ['create', 'list', 'get', 'cancel', 'delete'])
})

test('renderer render service rejects foreign identities, absolute output paths, malformed success, and hostile failures', async () => {
  const wrongIdentity = detail()
  wrongIdentity.projectKey = 'world-fedcba9876543210fedcba9876543210'
  const foreign = createWorldRenderService(partialApi({ create: async () => ({ ok: true, value: wrongIdentity }) }))
  const request = { projectKey: PROJECT_KEY, expectedRevision: 4, sceneId: 'scene:main', sequenceId: 'sequence:intro' }
  assert.equal((await foreign.create(request)).ok, false)

  const leaked = detail()
  leaked.outputs.webm!.workspacePath = '/private/output.webm'
  const hostile = createWorldRenderService(partialApi({ get: async () => ({ ok: true, value: leaked }) }))
  const leakedResult = await hostile.get({ jobId: JOB_ID })
  assert.deepEqual(leakedResult, invalidResponse())
  assert.equal(JSON.stringify(leakedResult).includes('/private'), false)

  const wrongDelete = createWorldRenderService(partialApi({ delete: async () => ({ ok: true, value: { jobId: 'render-fedcba9876543210fedcba9876543210' } }) }))
  assert.deepEqual(await wrongDelete.delete({ jobId: JOB_ID }), invalidResponse())

  const failure = createWorldRenderService(partialApi({
    list: async () => ({ ok: false, error: { code: 'internal_error', message: '/private/secret', retryable: true } }),
  }))
  const sanitized = await failure.list()
  assert.deepEqual(sanitized, { ok: false, error: { code: 'internal_error', message: 'World render operation failed.', retryable: true } })
})

test('renderer render service converts thrown IPC and unsupported terminal output shapes to bounded failures', async () => {
  const throwing = createWorldRenderService(partialApi({ list: async () => { throw new Error('/private/secret') } }))
  assert.deepEqual(await throwing.list(), { ok: false, error: { code: 'internal_error', message: 'World render operation failed.', retryable: true } })

  const falseSuccess = detail('succeeded')
  falseSuccess.outputs.webm = null
  const invalid = createWorldRenderService(partialApi({ get: async () => ({ ok: true, value: falseSuccess }) }))
  assert.deepEqual(await invalid.get({ jobId: JOB_ID }), invalidResponse())

  const contradictorySuccess = detail('succeeded')
  contradictorySuccess.progress = {
    ...contradictorySuccess.progress,
    phase: 'assembling',
    completedUnits: contradictorySuccess.progress.totalUnits - 1,
  }
  const contradictory = createWorldRenderService(partialApi({
    get: async () => ({ ok: true, value: contradictorySuccess }),
  }))
  assert.deepEqual(await contradictory.get({ jobId: JOB_ID }), invalidResponse())
})

test('renderer render service rejects non-positive, non-finite, fractional, and unsafe terminal artifact sizes', async () => {
  const artifacts = [
    ['webm', (candidate: WorldRenderJobDetail) => candidate.outputs.webm],
    ['frame', (candidate: WorldRenderJobDetail) => candidate.outputs.frames[0]],
    ['audio', (candidate: WorldRenderJobDetail) => candidate.outputs.audio],
    ['render-manifest', (candidate: WorldRenderJobDetail) => candidate.outputs.renderManifest],
  ] as const
  const invalidSizes = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]

  for (const [artifactName, selectArtifact] of artifacts) {
    for (const invalidSize of invalidSizes) {
      const malformed = detail('succeeded')
      const artifact = selectArtifact(malformed)
      assert.ok(artifact)
      artifact.size = invalidSize
      const service = createWorldRenderService(partialApi({
        get: async () => ({ ok: true, value: malformed }),
      }))
      assert.deepEqual(
        await service.get({ jobId: JOB_ID }),
        invalidResponse(),
        `${artifactName}:${String(invalidSize)}`,
      )
    }
  }
})

test('renderer render service accepts exact producer artifact ceilings and rejects max plus one', async () => {
  const artifacts = [
    ['frame', WORLD_RENDER_ARTIFACT_MAX_BYTES.frame, (candidate: WorldRenderJobDetail) => candidate.outputs.frames[0]],
    ['audio', WORLD_RENDER_ARTIFACT_MAX_BYTES.audio, (candidate: WorldRenderJobDetail) => candidate.outputs.audio],
    ['render-manifest', WORLD_RENDER_ARTIFACT_MAX_BYTES.renderManifest, (candidate: WorldRenderJobDetail) => candidate.outputs.renderManifest],
    ['webm', WORLD_RENDER_ARTIFACT_MAX_BYTES.webm, (candidate: WorldRenderJobDetail) => candidate.outputs.webm],
  ] as const

  for (const [artifactName, maximumSize, selectArtifact] of artifacts) {
    const atMaximum = detail('succeeded')
    const maximumArtifact = selectArtifact(atMaximum)
    assert.ok(maximumArtifact)
    maximumArtifact.size = maximumSize
    const acceptingService = createWorldRenderService(partialApi({
      get: async () => ({ ok: true, value: atMaximum }),
    }))
    assert.equal((await acceptingService.get({ jobId: JOB_ID })).ok, true, `${artifactName}:maximum`)

    const aboveMaximum = detail('succeeded')
    const oversizedArtifact = selectArtifact(aboveMaximum)
    assert.ok(oversizedArtifact)
    oversizedArtifact.size = maximumSize + 1
    const rejectingService = createWorldRenderService(partialApi({
      get: async () => ({ ok: true, value: aboveMaximum }),
    }))
    assert.deepEqual(
      await rejectingService.get({ jobId: JOB_ID }),
      invalidResponse(),
      `${artifactName}:maximum-plus-one`,
    )
  }
})

test('renderer render service rejects sparse terminal frame arrays instead of accepting missing artifacts', async () => {
  for (const status of ['succeeded', 'partial'] as const) {
    const malformed = detail(status)
    malformed.outputs.frames = new Array<WorldRenderJobDetail['outputs']['frames'][number]>(malformed.frameCount)
    const cloned = structuredClone(malformed)
    assert.equal(Object.prototype.hasOwnProperty.call(cloned.outputs.frames, '0'), false)
    const service = createWorldRenderService(partialApi({
      get: async () => ({ ok: true, value: cloned }),
    }))

    assert.deepEqual(
      await service.get({ jobId: JOB_ID }),
      invalidResponse(),
      status,
    )
  }
})

test('renderer render service requires exact dense own data entries for every response array', async () => {
  const value = detail()
  const malformedJobArrays: Array<[string, WorldRenderJobDetail[]]> = []

  malformedJobArrays.push(['sparse', new Array<WorldRenderJobDetail>(1)])

  const accessor = new Array<WorldRenderJobDetail>(1)
  Object.defineProperty(accessor, '0', { enumerable: true, configurable: true, get: () => value })
  malformedJobArrays.push(['accessor', accessor])

  const nonEnumerable = new Array<WorldRenderJobDetail>(1)
  Object.defineProperty(nonEnumerable, '0', { enumerable: false, configurable: true, writable: true, value })
  malformedJobArrays.push(['non-enumerable', nonEnumerable])

  const inherited = new Array<WorldRenderJobDetail>(1)
  const inheritedPrototype = Object.create(Array.prototype) as unknown as WorldRenderJobDetail[]
  Object.defineProperty(inheritedPrototype, '0', { enumerable: true, configurable: true, writable: true, value })
  Object.setPrototypeOf(inherited, inheritedPrototype)
  malformedJobArrays.push(['prototype-value', inherited])

  const extraProperty = [value]
  Object.defineProperty(extraProperty, 'unexpected', { enumerable: true, configurable: true, writable: true, value: true })
  malformedJobArrays.push(['extra-property', extraProperty])

  for (const [variant, jobs] of malformedJobArrays) {
    const service = createWorldRenderService(partialApi({
      list: async () => ({ ok: true, value: { jobs } }),
    }))
    assert.deepEqual(await service.list(), invalidResponse(), variant)
  }

  const sparseIssues = new Array<{ code: string; path: string; message: string }>(1)
  const service = createWorldRenderService(partialApi({
    list: async () => ({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'World render operation failed.',
        retryable: true,
        issues: sparseIssues,
      },
    }),
  }))
  assert.deepEqual(await service.list(), invalidResponse(), 'sparse-error-issues')
})

test('renderer render service preflights array ceilings before indexed descriptor snapshots', async () => {
  const exactFrames = detail('queued')
  exactFrames.frameCount = WORLD_RENDER_MAX_FRAME_COUNT
  exactFrames.progress = {
    ...exactFrames.progress,
    frameCount: WORLD_RENDER_MAX_FRAME_COUNT,
    totalUnits: WORLD_RENDER_MAX_FRAME_COUNT + 2,
  }
  exactFrames.outputs.frames = Array.from({ length: WORLD_RENDER_MAX_FRAME_COUNT }, (_, index) => frame(index))
  const exactFrameService = createWorldRenderService(partialApi({
    get: async () => ({ ok: true, value: exactFrames }),
  }))
  assert.equal((await exactFrameService.get({ jobId: JOB_ID })).ok, true, 'frames:maximum')

  const exactJobs = Array.from({ length: WORLD_RENDER_MAX_STORED_JOBS }, () => detail('queued'))
  const exactJobService = createWorldRenderService(partialApi({
    list: async () => ({ ok: true, value: { jobs: exactJobs } }),
  }))
  assert.equal((await exactJobService.list()).ok, true, 'jobs:maximum')

  const exactIssues = Array.from({ length: WORLD_MAX_SEMANTIC_ISSUES }, () => ({
    code: 'renderer-failed', path: 'render.executor', message: 'Render failed.',
  }))
  const exactIssueService = createWorldRenderService(partialApi({
    list: async () => ({
      ok: false,
      error: { code: 'internal_error', message: 'World render operation failed.', retryable: true, issues: exactIssues },
    }),
  }))
  const exactIssueResult = await exactIssueService.list()
  assert.equal(exactIssueResult.ok, false, 'issues:maximum')
  if (!exactIssueResult.ok) assert.equal(exactIssueResult.error.code, 'internal_error', 'issues:maximum')

  const oversizedFrames = instrumentDescriptorReads(
    new Array<WorldRenderJobDetail['outputs']['frames'][number]>(WORLD_RENDER_MAX_FRAME_COUNT + 1).fill(frame(0)),
  )
  const frameContainer = detail('queued')
  frameContainer.frameCount = WORLD_RENDER_MAX_FRAME_COUNT
  frameContainer.progress = {
    ...frameContainer.progress,
    frameCount: WORLD_RENDER_MAX_FRAME_COUNT,
    totalUnits: WORLD_RENDER_MAX_FRAME_COUNT + 2,
  }
  frameContainer.outputs.frames = oversizedFrames.value
  const frameService = createWorldRenderService(partialApi({
    get: async () => ({ ok: true, value: frameContainer }),
  }))
  assert.deepEqual(await frameService.get({ jobId: JOB_ID }), invalidResponse(), 'frames:maximum-plus-one')
  assert.deepEqual(oversizedFrames.reads, { indexed: 0, length: 1 }, 'frames:bounded-descriptor-work')

  const oversizedJobs = instrumentDescriptorReads(
    new Array<WorldRenderJobDetail>(WORLD_RENDER_MAX_STORED_JOBS + 1).fill(detail('queued')),
  )
  const jobService = createWorldRenderService(partialApi({
    list: async () => ({ ok: true, value: { jobs: oversizedJobs.value } }),
  }))
  assert.deepEqual(await jobService.list(), invalidResponse(), 'jobs:maximum-plus-one')
  assert.deepEqual(oversizedJobs.reads, { indexed: 0, length: 1 }, 'jobs:bounded-descriptor-work')

  const oversizedIssues = instrumentDescriptorReads(
    new Array(WORLD_MAX_SEMANTIC_ISSUES + 1).fill({ code: 'renderer-failed', path: '', message: 'failed' }),
  )
  const issueService = createWorldRenderService(partialApi({
    list: async () => ({
      ok: false,
      error: {
        code: 'internal_error', message: 'World render operation failed.', retryable: true, issues: oversizedIssues.value,
      },
    }),
  }))
  assert.deepEqual(await issueService.list(), invalidResponse(), 'issues:maximum-plus-one')
  assert.deepEqual(oversizedIssues.reads, { indexed: 0, length: 1 }, 'issues:bounded-descriptor-work')
})

function invalidResponse() {
  return { ok: false as const, error: { code: 'output_invalid' as const, message: 'World render response is invalid.', retryable: false } }
}
