import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  WorldRenderJobDetail,
  WorldRenderJobSummary,
  WorldRenderProgressPhase,
} from '../../../shared/types/worldRenders.ts'
import {
  WORLD_RENDER_ARTIFACT_MAX_BYTES,
  WORLD_RENDER_MANIFEST_FILENAME,
} from '../../../shared/types/worldRenders.ts'
import { createWorldRenderService, type WorldRenderService } from '../worldRenderService.ts'
import {
  createWorldRenderUiController,
  describeWorldRenderJob,
  worldRenderProgressPercent,
  type WorldRenderUiTarget,
} from './worldRenderUiController.ts'

const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const FIRST_JOB = 'render-11111111111111111111111111111111'
const SECOND_JOB = 'render-22222222222222222222222222222222'

function target(revision = 4): WorldRenderUiTarget {
  return {
    projectKey: PROJECT_KEY,
    revision,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
    preset: { width: 1920, height: 1080, fps: 30 },
  }
}

function job(jobId = FIRST_JOB, status: WorldRenderJobDetail['status'] = 'queued', completedUnits = 0): WorldRenderJobDetail {
  const masters = status === 'partial' || status === 'succeeded'
  const root = `Exports/Worlds/Renders/${jobId}`
  return {
    jobId,
    projectKey: PROJECT_KEY,
    projectId: 'project:render',
    revision: 4,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
    preset: { width: 1920, height: 1080, fps: 30 },
    duration: { numerator: 1, denominator: 1 },
    frameCount: 1,
    status,
    progress: { phase: phaseForStatus(status), completedFrames: completedUnits > 0 ? 1 : 0, frameCount: 1, completedUnits, totalUnits: 3 },
    outputs: {
      frames: masters ? [{ workspacePath: `${root}/frames/frame-000000.png`, size: 1, sha256: 'a'.repeat(64), index: 0, time: { numerator: 0, denominator: 1 }, timestampMicroseconds: 0 }] : [],
      audio: masters ? { workspacePath: `${root}/audio/master.wav`, size: 1, sha256: 'b'.repeat(64) } : null,
      renderManifest: masters ? { workspacePath: `${root}/${WORLD_RENDER_MANIFEST_FILENAME}`, size: 1, sha256: 'c'.repeat(64) } : null,
      webm: status === 'succeeded' ? { workspacePath: `${root}/output.webm`, size: 1, sha256: 'd'.repeat(64) } : null,
    },
    error: ['partial', 'failed', 'recovery_failed'].includes(status) ? { code: 'output_invalid', message: 'World render output is incomplete or invalid.', retryable: false } : null,
    createdAt: '2026-09-03T10:00:00.000Z',
    updatedAt: `2026-09-03T10:00:0${Math.min(9, completedUnits)}.000Z`,
  }
}

function phaseForStatus(status: WorldRenderJobDetail['status']): WorldRenderProgressPhase {
  if (status === 'queued' || status === 'preflighting' || status === 'rendering-frames'
    || status === 'rendering-audio' || status === 'assembling') return status
  return status === 'cancel_requested' ? 'assembling' : 'complete'
}

function summary(value: WorldRenderJobDetail): WorldRenderJobSummary {
  const { outputs: _outputs, error: _error, ...result } = value
  return result
}

function fakeService(overrides: Partial<WorldRenderService> = {}): WorldRenderService {
  return {
    create: async () => ({ ok: true, value: job() }),
    list: async () => ({ ok: true, value: { jobs: [] } }),
    get: async () => ({ ok: true, value: job() }),
    cancel: async () => ({ ok: true, value: job(FIRST_JOB, 'cancelled') }),
    delete: async (request) => ({ ok: true, value: { jobId: request.jobId } }),
    ...overrides,
  }
}

function manualScheduler() {
  let nextId = 0
  const callbacks = new Map<number, { callback: () => void; delayMs: number }>()
  return {
    setTimeout(callback: () => void, delayMs: number) {
      const id = ++nextId
      callbacks.set(id, { callback, delayMs })
      return id
    },
    clearTimeout(id: number) { callbacks.delete(id) },
    async runNext() {
      const entry = callbacks.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined
      if (!entry) return false
      callbacks.delete(entry[0])
      entry[1].callback()
      await new Promise((resolve) => setImmediate(resolve))
      return true
    },
    count: () => callbacks.size,
    nextDelay: () => callbacks.values().next().value?.delayMs as number | undefined,
  }
}

function pollFailure(retryable: boolean) {
  return {
    ok: false as const,
    error: {
      code: 'internal_error' as const,
      message: 'World render operation failed.',
      retryable,
    },
  }
}

test('reopen reconciles the latest matching durable job and polls monotonic progress', async () => {
  const scheduler = manualScheduler()
  const older = job('render-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'failed')
  older.updatedAt = '2026-09-03T09:00:00.000Z'
  const current = job(FIRST_JOB, 'rendering-frames', 1)
  const wrongRevision = job(SECOND_JOB, 'rendering-frames', 2)
  wrongRevision.revision = 5
  wrongRevision.updatedAt = '2026-09-03T11:00:00.000Z'
  const foreignProgress = job(FIRST_JOB, 'rendering-audio', 2)
  foreignProgress.revision = 5
  const regressed = job(FIRST_JOB, 'preflighting', 0)
  const completed = job(FIRST_JOB, 'succeeded', 3)
  let reads = 0
  const controller = createWorldRenderUiController({
    service: fakeService({
      list: async () => ({ ok: true, value: { jobs: [summary(older), summary(current), summary(wrongRevision)] } }),
      get: async ({ jobId }) => ({
        ok: true,
        value: jobId === SECOND_JOB
          ? wrongRevision
          : [current, foreignProgress, regressed, completed][Math.min(reads++, 3)],
      }),
    }),
    scheduler,
  })
  await controller.open(target())
  assert.equal(controller.getState().job?.jobId, FIRST_JOB)
  assert.equal(controller.getState().job?.progress.completedUnits, 1)
  assert.equal(scheduler.count(), 1)
  await scheduler.runNext()
  assert.equal(controller.getState().job?.revision, 4, 'foreign revision progress is ignored')
  assert.equal(controller.getState().job?.progress.completedUnits, 1)
  await scheduler.runNext()
  assert.equal(controller.getState().job?.progress.completedUnits, 1, 'late regressive progress is ignored')
  await scheduler.runNext()
  assert.equal(controller.getState().job?.status, 'succeeded')
  assert.equal(scheduler.count(), 0)
})

test('active polling retries transient failures with bounded backoff and resets after recovery', async () => {
  const scheduler = manualScheduler()
  const current = job(FIRST_JOB, 'rendering-frames', 1)
  const recovered = job(FIRST_JOB, 'rendering-audio', 2)
  const completed = job(FIRST_JOB, 'succeeded', 3)
  let reads = 0
  const controller = createWorldRenderUiController({
    service: fakeService({
      list: async () => ({ ok: true, value: { jobs: [summary(current)] } }),
      get: async () => {
        const read = reads++
        if (read === 0) return { ok: true, value: current }
        if (read >= 1 && read <= 4) return pollFailure(true)
        if (read === 5) return { ok: true, value: recovered }
        if (read === 6) return pollFailure(true)
        return { ok: true, value: completed }
      },
    }),
    scheduler,
  })

  await controller.open(target())
  assert.equal(scheduler.nextDelay(), 600)
  await scheduler.runNext()
  assert.equal(controller.getState().error?.retryable, true)
  assert.equal(scheduler.nextDelay(), 1_200)
  await scheduler.runNext()
  assert.equal(scheduler.nextDelay(), 2_400)
  await scheduler.runNext()
  assert.equal(scheduler.nextDelay(), 4_800)
  await scheduler.runNext()
  assert.equal(scheduler.nextDelay(), 4_800, 'retry backoff is capped')
  await scheduler.runNext()
  assert.equal(controller.getState().job?.progress.completedUnits, 2)
  assert.equal(controller.getState().error, null)
  assert.equal(scheduler.nextDelay(), 600)
  await scheduler.runNext()
  assert.equal(scheduler.nextDelay(), 1_200, 'successful polling resets retry backoff')
  await scheduler.runNext()
  assert.equal(controller.getState().job?.status, 'succeeded')
  assert.equal(controller.getState().error, null)
  assert.equal(scheduler.count(), 0)
})

test('non-retryable polling failures stop and target changes or disposal cancel pending retries', async () => {
  const nonRetryScheduler = manualScheduler()
  let nonRetryReads = 0
  const nonRetryController = createWorldRenderUiController({
    service: fakeService({
      list: async () => ({ ok: true, value: { jobs: [summary(job())] } }),
      get: async () => nonRetryReads++ === 0 ? { ok: true, value: job() } : pollFailure(false),
    }),
    scheduler: nonRetryScheduler,
  })
  await nonRetryController.open(target())
  await nonRetryScheduler.runNext()
  assert.equal(nonRetryController.getState().error?.retryable, false)
  assert.equal(nonRetryScheduler.count(), 0)

  const switchScheduler = manualScheduler()
  let listReads = 0
  let switchReads = 0
  const switchController = createWorldRenderUiController({
    service: fakeService({
      list: async () => ({ ok: true, value: { jobs: listReads++ === 0 ? [summary(job())] : [] } }),
      get: async () => switchReads++ === 0 ? { ok: true, value: job() } : pollFailure(true),
    }),
    scheduler: switchScheduler,
  })
  await switchController.open(target())
  await switchScheduler.runNext()
  assert.equal(switchScheduler.nextDelay(), 1_200)
  await switchController.open(target(5))
  assert.equal(switchController.getState().target?.revision, 5)
  assert.equal(switchScheduler.count(), 0)
  assert.equal(await switchScheduler.runNext(), false)

  const disposeScheduler = manualScheduler()
  let disposeReads = 0
  const disposeController = createWorldRenderUiController({
    service: fakeService({
      list: async () => ({ ok: true, value: { jobs: [summary(job())] } }),
      get: async () => disposeReads++ === 0 ? { ok: true, value: job() } : pollFailure(true),
    }),
    scheduler: disposeScheduler,
  })
  await disposeController.open(target())
  await disposeScheduler.runNext()
  assert.equal(disposeScheduler.nextDelay(), 1_200)
  disposeController.dispose()
  assert.equal(disposeScheduler.count(), 0)
  assert.equal(await disposeScheduler.runNext(), false)
})

test('create stops preview first, pins the exact target, retry uses current revision and requires a new job ID', async () => {
  const order: string[] = []
  const requests: unknown[] = []
  let attempt = 0
  const controller = createWorldRenderUiController({
    service: fakeService({
      create: async (request) => {
        order.push('create')
        requests.push(request)
        attempt += 1
        const result = job(attempt === 1 ? FIRST_JOB : SECOND_JOB)
        result.revision = request.expectedRevision
        return { ok: true, value: result }
      },
    }),
    beforeStart: () => { order.push('stop-preview') },
    scheduler: manualScheduler(),
  })
  await controller.open(target())
  await controller.start()
  assert.deepEqual(order, ['stop-preview', 'create'])
  assert.deepEqual(requests[0], { projectKey: PROJECT_KEY, expectedRevision: 4, sceneId: 'scene:main', sequenceId: 'sequence:intro', preset: { width: 1920, height: 1080, fps: 30 } })
  await controller.open(target(5))
  await controller.retry()
  assert.equal((requests[1] as { expectedRevision: number }).expectedRevision, 5)
  assert.equal(controller.getState().job?.jobId, SECOND_JOB)
})

test('cancel races and disposed controllers ignore late responses and clear polling', async () => {
  const scheduler = manualScheduler()
  let release!: (value: ReturnType<typeof job>) => void
  const deferred = new Promise<WorldRenderJobDetail>((resolve) => { release = resolve })
  const controller = createWorldRenderUiController({
    service: fakeService({ get: async () => ({ ok: true, value: await deferred }) }),
    scheduler,
  })
  const opening = controller.open(target())
  controller.dispose()
  release(job('render-ffffffffffffffffffffffffffffffff', 'succeeded', 3))
  await opening
  assert.equal(controller.getState().job, null)
  assert.equal(scheduler.count(), 0)

  const active = createWorldRenderUiController({
    service: fakeService({
      list: async () => ({ ok: true, value: { jobs: [summary(job())] } }),
      get: async () => ({ ok: true, value: job() }),
      cancel: async () => ({ ok: true, value: job(FIRST_JOB, 'cancel_requested', 1) }),
    }),
    scheduler: manualScheduler(),
  })
  await active.open(target())
  await active.cancel()
  assert.equal(active.getState().job?.status, 'cancel_requested')
})

test('stale revision is preserved as refresh conflict and terminal descriptions never fake video success', async () => {
  const controller = createWorldRenderUiController({
    service: fakeService({
      create: async () => ({ ok: false, error: { code: 'revision_conflict', message: 'World project revision changed.', retryable: true } }),
    }),
  })
  await controller.open(target())
  await controller.start()
  assert.equal(controller.getState().error?.code, 'revision_conflict')
  assert.equal(controller.getState().error?.message, 'World project revision changed.')

  assert.deepEqual(describeWorldRenderJob(job(FIRST_JOB, 'succeeded', 3)), {
    label: 'WebM ready', detail: `Exports/Worlds/Renders/${FIRST_JOB}/output.webm`, tone: 'success', retry: false,
  })
  assert.deepEqual(describeWorldRenderJob(job(FIRST_JOB, 'partial', 3)), {
    label: 'Masters kept', detail: 'PNG + WAV kept · video failed', tone: 'warning', retry: true,
  })
  assert.equal(describeWorldRenderJob(job(FIRST_JOB, 'cancelled')).label, 'Cancelled')
  assert.equal(describeWorldRenderJob(job(FIRST_JOB, 'interrupted')).label, 'Interrupted')
  assert.equal(describeWorldRenderJob(job(FIRST_JOB, 'failed')).label, 'Failed')
  assert.equal(describeWorldRenderJob(job(FIRST_JOB, 'recovery_failed')).label, 'Recovery failed')
  assert.equal(worldRenderProgressPercent(job(FIRST_JOB, 'rendering-frames', 1).progress), 33)
})

test('controller cannot present a zero-byte succeeded WebM as ready', async () => {
  const malformed = job(FIRST_JOB, 'succeeded', 3)
  assert.ok(malformed.outputs.webm)
  malformed.outputs.webm.size = 0
  const service = createWorldRenderService({
    create: async () => { throw new Error('unused') },
    list: async () => ({ ok: true, value: { jobs: [summary(malformed)] } }),
    get: async () => ({ ok: true, value: malformed }),
    cancel: async () => { throw new Error('unused') },
    delete: async () => { throw new Error('unused') },
  })
  const controller = createWorldRenderUiController({ service, scheduler: manualScheduler() })

  await controller.open(target())

  const state = controller.getState()
  const description = state.job ? describeWorldRenderJob(state.job) : null
  assert.equal(state.job, null)
  assert.equal(state.error?.code, 'output_invalid')
  assert.notEqual(description?.label, 'WebM ready')
})

test('controller cannot present a producer-impossible oversized WebM as ready', async () => {
  const malformed = job(FIRST_JOB, 'succeeded', 3)
  assert.ok(malformed.outputs.webm)
  malformed.outputs.webm.size = WORLD_RENDER_ARTIFACT_MAX_BYTES.webm + 1
  const service = createWorldRenderService({
    create: async () => { throw new Error('unused') },
    list: async () => ({ ok: true, value: { jobs: [summary(malformed)] } }),
    get: async () => ({ ok: true, value: malformed }),
    cancel: async () => { throw new Error('unused') },
    delete: async () => { throw new Error('unused') },
  })
  const controller = createWorldRenderUiController({ service, scheduler: manualScheduler() })

  await controller.open(target())

  const state = controller.getState()
  const description = state.job ? describeWorldRenderJob(state.job) : null
  assert.equal(state.job, null)
  assert.equal(state.error?.code, 'output_invalid')
  assert.notEqual(description?.label, 'WebM ready')
})

test('controller cannot present sparse succeeded or partial frame outputs as terminal results', async () => {
  for (const status of ['succeeded', 'partial'] as const) {
    const malformed = job(FIRST_JOB, status, 3)
    malformed.outputs.frames = new Array<WorldRenderJobDetail['outputs']['frames'][number]>(malformed.frameCount)
    const cloned = structuredClone(malformed)
    assert.equal(Object.prototype.hasOwnProperty.call(cloned.outputs.frames, '0'), false)
    const service = createWorldRenderService({
      create: async () => { throw new Error('unused') },
      list: async () => ({ ok: true, value: { jobs: [summary(malformed)] } }),
      get: async () => ({ ok: true, value: cloned }),
      cancel: async () => { throw new Error('unused') },
      delete: async () => { throw new Error('unused') },
    })
    const controller = createWorldRenderUiController({ service, scheduler: manualScheduler() })

    await controller.open(target())

    const state = controller.getState()
    const description = state.job ? describeWorldRenderJob(state.job) : null
    assert.equal(state.job, null, status)
    assert.equal(state.error?.code, 'output_invalid', status)
    assert.notEqual(description?.label, status === 'succeeded' ? 'WebM ready' : 'Masters kept', status)
  }
})
