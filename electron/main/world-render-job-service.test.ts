import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import type { WorldProjectOpenResult } from '../../src/shared/types/worldProjects.ts'
import type { WorldRenderExecutor } from './world-render-job-service.ts'
import { WorldRenderJobService } from './world-render-job-service.ts'
import { WorldRenderBrowserExecutor } from './world-render-browser-executor.ts'
import { createPackagedWorldFfmpegFallback } from './world-render-ffmpeg-encoder.ts'
import type { WorldFfmpegRuntimeResolution } from './world-render-ffmpeg-runtime.ts'
import {
  WorldRenderOutputRepository,
  type WorldRenderExecutionPackage,
} from './world-render-output-repository.ts'
import { validWorldRenderWebm100ms } from './world-render-webm-test-fixture.ts'

const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const JOB_ID = 'render-0123456789abcdef0123456789abcdef'

function snapshot(): WorldProjectSnapshotV1 {
  return {
    project: {
      schema: 'modly.world-project.v1', projectId: 'project:render', name: 'Render project', revision: 4,
      resources: [], scenes: [{ id: 'scene:main', name: 'Main', documentPath: `Worlds/${PROJECT_KEY}/scenes/scene-main.world-scene.json` }],
      startSceneId: 'scene:main', inputActions: [],
      graphicsProfiles: [{ id: 'graphics:balanced', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'fxaa' }],
      activeGraphicsProfileId: 'graphics:balanced',
    },
    scenes: [{
      schema: 'modly.world-scene.v1', projectId: 'project:render', sceneId: 'scene:main', name: 'Main',
      environment: { backgroundColor: '#101114', ambientIntensity: 0.2 },
      entities: [{
        id: 'entity:camera', name: 'Camera', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 }],
      }],
      sequences: [{ id: 'sequence:intro', name: 'Intro', duration: { numerator: 1, denominator: 10 }, tracks: [] }],
    }],
  }
}

function png(index: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(64, 0)
  ihdr.writeUInt32BE(64, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(64 * (1 + 64 * 4))
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from(`frame=${index}`)),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const result = Buffer.alloc(12 + data.length)
  result.writeUInt32BE(data.length, 0)
  name.copy(result, 4)
  data.copy(result, 8)
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return result
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1))
  }
  return (value ^ 0xffff_ffff) >>> 0
}

function wav(): Buffer {
  const dataSize = 4_800 * 4
  const bytes = Buffer.alloc(44 + dataSize)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(48_000, 24)
  bytes.writeUInt32LE(192_000, 28)
  bytes.writeUInt16LE(4, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(dataSize, 40)
  return bytes
}

function webm(): Buffer {
  return validWorldRenderWebm100ms()
}

function reader(value: WorldProjectSnapshotV1) {
  return {
    async open(): Promise<WorldProjectOpenResult> {
      return { ok: true, value: { status: 'ready', projectKey: PROJECT_KEY, snapshot: structuredClone(value), durabilityWarnings: [] } }
    },
  }
}

function createRequest(expectedRevision = 4) {
  return {
    projectKey: PROJECT_KEY,
    expectedRevision,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
    preset: { width: 64, height: 64, fps: 30 as const },
  }
}

async function fixture(
  t: test.TestContext,
  executor?: WorldRenderExecutor,
  value = snapshot(),
  serviceOptions: { cancellationWaitMs?: number; idleWaitMs?: number; shutdownWaitMs?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-render-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'Assets'), { recursive: true })
  const repository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root, createJobId: () => JOB_ID })
  const service = new WorldRenderJobService({
    projectReader: reader(value), outputRepository: repository, executor, ...serviceOptions,
  })
  return { root, repository, service, value }
}

async function settleWithin<T>(operation: Promise<T>, milliseconds = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error('test operation did not settle')), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('fails closed without an executor and rejects stale/missing scene or sequence before allocation', async (t) => {
  const without = await fixture(t)
  const unavailable = await without.service.create(createRequest())
  assert.equal(unavailable.ok, false)
  if (!unavailable.ok) assert.equal(unavailable.error.code, 'executor_unavailable')
  const unavailableList = await without.repository.list()
  assert.equal(unavailableList.ok, true)
  if (unavailableList.ok) assert.equal(unavailableList.value.jobs.length, 0)

  const executor: WorldRenderExecutor = { execute: async () => undefined }
  const withExecutor = await fixture(t, executor)
  const stale = await withExecutor.service.create(createRequest(3))
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'revision_conflict')
  const missingScene = await withExecutor.service.create({ ...createRequest(), sceneId: 'scene:missing' })
  assert.equal(missingScene.ok, false)
  if (!missingScene.ok) assert.equal(missingScene.error.code, 'scene_not_found')
  const missingSequence = await withExecutor.service.create({ ...createRequest(), sequenceId: 'sequence:missing' })
  assert.equal(missingSequence.ok, false)
  if (!missingSequence.ok) assert.equal(missingSequence.error.code, 'sequence_not_found')
  const mismatchedReader = new WorldRenderJobService({
    projectReader: {
      async open(): Promise<WorldProjectOpenResult> {
        return {
          ok: true,
          value: {
            status: 'ready',
            projectKey: 'world-fedcba9876543210fedcba9876543210',
            snapshot: snapshot(),
            durabilityWarnings: [],
          },
        }
      },
    },
    outputRepository: withExecutor.repository,
    executor,
  })
  const mismatched = await mismatchedReader.create(createRequest())
  assert.equal(mismatched.ok, false)
  if (!mismatched.ok) assert.equal(mismatched.error.code, 'project_not_found')
  const rejectedList = await withExecutor.repository.list()
  assert.equal(rejectedList.ok, true)
  if (rejectedList.ok) assert.equal(rejectedList.value.jobs.length, 0)
})

test('drives monotonic phases and reports succeeded only after complete masters and WebM', async (t) => {
  const phases: string[] = []
  const executor: WorldRenderExecutor = {
    async execute(context) {
      phases.push('started')
      await context.reportProgress({ phase: 'preflighting', completedFrames: 0 })
      for (const frame of context.framePlan) {
        await context.writeFrame(frame.index, png(frame.index))
        await context.reportProgress({ phase: 'rendering-frames', completedFrames: frame.index + 1 })
      }
      await context.reportProgress({ phase: 'rendering-audio', completedFrames: context.framePlan.length })
      await context.writeAudio(wav())
      await context.reportProgress({ phase: 'assembling', completedFrames: context.framePlan.length })
      await context.writeWebm(webm())
    },
  }
  const { service, value } = await fixture(t, executor)
  const before = structuredClone(value)
  const created = await service.create(createRequest())
  assert.equal(created.ok, true)
  await service.whenIdle()
  const result = await service.get({ jobId: JOB_ID })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.status, 'succeeded')
  assert.equal(result.value.frameCount, 3)
  assert.equal(result.value.progress.completedUnits, result.value.progress.totalUnits)
  assert.equal(result.value.outputs.frames.length, 3)
  assert.equal(result.value.outputs.webm?.workspacePath.endsWith('/output.webm'), true)
  assert.deepEqual(value, before, 'rendering must not mutate the project document or revision')
  assert.deepEqual(phases, ['started'])
})

test('cancellation that arrives while final settlement owns the durable queue wins over success', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-render-settle-cancel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'Assets'), { recursive: true })
  let pauseSettlement = false
  let paused = false
  let settlementEntered!: () => void
  let releaseSettlement!: () => void
  const entered = new Promise<void>((resolvePromise) => { settlementEntered = resolvePromise })
  const released = new Promise<void>((resolvePromise) => { releaseSettlement = resolvePromise })
  const repository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => JOB_ID,
    syncDirectory: async () => {
      if (pauseSettlement && !paused) {
        paused = true
        settlementEntered()
        await released
      }
      return true
    },
  })
  const executor: WorldRenderExecutor = {
    async execute(context) {
      await context.reportProgress({ phase: 'preflighting', completedFrames: 0 })
      for (const frame of context.framePlan) {
        await context.writeFrame(frame.index, png(frame.index))
        await context.reportProgress({ phase: 'rendering-frames', completedFrames: frame.index + 1 })
      }
      await context.reportProgress({ phase: 'rendering-audio', completedFrames: context.framePlan.length })
      await context.writeAudio(wav())
      await context.reportProgress({ phase: 'assembling', completedFrames: context.framePlan.length })
      await context.writeWebm(webm())
      pauseSettlement = true
    },
  }
  const service = new WorldRenderJobService({ projectReader: reader(snapshot()), outputRepository: repository, executor })
  assert.equal((await service.create(createRequest())).ok, true)
  await entered
  const cancellation = service.cancel({ jobId: JOB_ID })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  releaseSettlement()
  await cancellation
  await service.whenIdle()

  const final = await service.get({ jobId: JOB_ID })
  assert.equal(final.ok, true)
  if (final.ok) {
    assert.equal(final.value.status, 'cancelled')
    assert.equal(final.value.outputs.webm, null)
  }
})

test('normal completion without WebM is truthful partial and missing masters fail', async (t) => {
  const partialExecutor: WorldRenderExecutor = {
    async execute(context) {
      await context.reportProgress({ phase: 'preflighting', completedFrames: 0 })
      for (const frame of context.framePlan) await context.writeFrame(frame.index, png(frame.index))
      await context.writeAudio(wav())
    },
  }
  const partial = await fixture(t, partialExecutor)
  assert.equal((await partial.service.create(createRequest())).ok, true)
  await partial.service.whenIdle()
  const partialResult = await partial.service.get({ jobId: JOB_ID })
  assert.equal(partialResult.ok, true)
  if (partialResult.ok) assert.equal(partialResult.value.status, 'partial')

  const failedExecutor: WorldRenderExecutor = {
    async execute(context) {
      await context.writeFrame(0, Buffer.from('only-one'))
    },
  }
  const failed = await fixture(t, failedExecutor)
  assert.equal((await failed.service.create(createRequest())).ok, true)
  await failed.service.whenIdle()
  const failedResult = await failed.service.get({ jobId: JOB_ID })
  assert.equal(failedResult.ok, true)
  if (failedResult.ok) assert.equal(failedResult.value.status, 'failed')
})

test('real fallback initial-resolution boundary preserves disk partial/cancellation truth through service and browser', async (t) => {
  for (const boundary of ['timeout', 'cancel'] as const) {
    for (const lateOutcome of ['missing', 'rejection'] as const) {
      await t.test(`${boundary}, late ${lateOutcome}`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), 'modly-world-render-initial-resolution-'))
        t.after(() => rm(root, { recursive: true, force: true }))
        await mkdir(join(root, 'Assets'))
        const repository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root, createJobId: () => JOB_ID })
        let enterResolution!: () => void
        const entered = new Promise<void>((resolvePromise) => { enterResolution = resolvePromise })
        let finishResolution!: (value: WorldFfmpegRuntimeResolution) => void
        let rejectResolution!: (error: Error) => void
        const pending = new Promise<WorldFfmpegRuntimeResolution>((resolvePromise, rejectPromise) => {
          finishResolution = resolvePromise
          rejectResolution = rejectPromise
        })
        let sinkBegins = 0
        let spawns = 0
        let disposed = 0
        const begin = repository.beginWebmAssembly.bind(repository)
        repository.beginWebmAssembly = async (...args) => { sinkBegins += 1; return begin(...args) }
        const executor = new WorldRenderBrowserExecutor({
          outputRepository: repository,
          createSession: async () => ({
            initialize: async () => {},
            renderFrame: async ({ index }) => png(index),
            renderAudio: async () => wav(),
            assembleWebm: async () => ({ ok: false, code: 'codec-unavailable' }),
            dispose: async () => { disposed += 1 },
          }),
          assembleWithFfmpeg: createPackagedWorldFfmpegFallback({
            resourcesPath: join(root, 'missing-resources'), platform: 'linux', arch: 'x64', authority: repository,
            spawnProcess: () => { spawns += 1; throw new Error('must not spawn') },
            testDependencies: {
              resolveRuntime: () => { enterResolution(); return pending },
              runtimeResolutionTimeoutMs: boundary === 'timeout' ? 5 : 1_000,
            },
          }),
        })
        const value = snapshot()
        const before = structuredClone(value)
        const service = new WorldRenderJobService({ projectReader: reader(value), outputRepository: repository, executor })
        assert.equal((await service.create(createRequest())).ok, true)
        await settleWithin(entered, 1_000)
        if (boundary === 'cancel') assert.equal((await settleWithin(service.cancel({ jobId: JOB_ID }), 1_000)).ok, true)
        await settleWithin(service.whenIdle(), 1_000)
        const final = await service.get({ jobId: JOB_ID })
        assert.equal(final.ok, true)
        if (!final.ok) return
        assert.equal(final.value.status, boundary === 'timeout' ? 'partial' : 'cancelled')
        assert.equal(final.value.outputs.webm, null)
        assert.equal(final.value.outputs.frames.length, 3)
        const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
        assert.deepEqual((await readdir(join(jobRoot, 'frames'))).sort(), ['frame-000000.png', 'frame-000001.png', 'frame-000002.png'])
        for (const frame of final.value.outputs.frames) {
          const bytes = await readFile(join(root, frame.workspacePath))
          assert.deepEqual(bytes, png(frame.index))
          assert.equal(createHash('sha256').update(bytes).digest('hex'), frame.sha256)
        }
        const audio = final.value.outputs.audio!
        assert.equal(audio.workspacePath, `Exports/Worlds/Renders/${JOB_ID}/audio/master.wav`)
        assert.deepEqual(await readFile(join(root, audio.workspacePath)), wav())
        assert.equal(audio.sha256, createHash('sha256').update(wav()).digest('hex'))
        if (boundary === 'timeout') {
          const manifest = final.value.outputs.renderManifest!
          assert.equal(manifest.workspacePath, `Exports/Worlds/Renders/${JOB_ID}/render-manifest.json`)
          const bytes = await readFile(join(root, manifest.workspacePath))
          assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256)
          const parsed = JSON.parse(bytes.toString())
          assert.deepEqual(parsed.frames.map((frame: { sha256: string }) => frame.sha256), final.value.outputs.frames.map((frame) => frame.sha256))
          assert.equal(parsed.audio.sha256, audio.sha256)
        } else {
          assert.equal(final.value.outputs.renderManifest, null, 'existing cancellation policy removes derived manifest, not masters')
          await assert.rejects(readFile(join(jobRoot, 'render-manifest.json')), { code: 'ENOENT' })
        }
        const storedBeforeLate = await readFile(join(jobRoot, 'job.v1.json'))
        if (lateOutcome === 'missing') finishResolution({ ok: false, code: 'bundle-missing' })
        else rejectResolution(new Error('late initial resolver rejection'))
        await new Promise((resolvePromise) => setImmediate(resolvePromise))
        assert.deepEqual(await readFile(join(jobRoot, 'job.v1.json')), storedBeforeLate, 'late audit cannot publish progress or terminal state')
        await assert.rejects(readFile(join(jobRoot, 'output.webm')), { code: 'ENOENT' })
        assert.equal(sinkBegins, 0)
        assert.equal(spawns, 0)
        assert.equal(disposed, 1)
        assert.deepEqual(value, before)
        const reopened = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
        assert.deepEqual(await reopened.get({ jobId: JOB_ID }), final, 'fresh repository reads actual durable terminal truth')
      })
    }
  }
})

test('whenIdle rejects when final durable settlement cannot be published', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-render-settlement-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'Assets'), { recursive: true })
  let allowDirectorySync = true
  const repository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => JOB_ID,
    syncDirectory: async () => allowDirectorySync,
  })
  const executor: WorldRenderExecutor = {
    async execute(context) {
      await context.reportProgress({ phase: 'preflighting', completedFrames: 0 })
      for (const frame of context.framePlan) {
        await context.writeFrame(frame.index, png(frame.index))
        await context.reportProgress({ phase: 'rendering-frames', completedFrames: frame.index + 1 })
      }
      await context.reportProgress({ phase: 'rendering-audio', completedFrames: context.framePlan.length })
      await context.writeAudio(wav())
      await context.reportProgress({ phase: 'assembling', completedFrames: context.framePlan.length })
      await context.writeWebm(webm())
      allowDirectorySync = false
    },
  }
  const service = new WorldRenderJobService({ projectReader: reader(snapshot()), outputRepository: repository, executor })
  assert.equal((await service.create(createRequest())).ok, true)
  await assert.rejects(service.whenIdle(), /write_failed/)
})

test('queued cancellation publication failure is returned and rejects the shared idle authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-render-queued-cancel-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ids = [
    'render-11111111111111111111111111111111',
    'render-22222222222222222222222222222222',
  ]
  let releaseFirst!: () => void
  let failQueuedFinish = false
  let cancellationPublications = 0
  const repository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => ids.shift()!,
    failureCheckpoint(stage) {
      if (failQueuedFinish && stage === 'last-valid-published') {
        cancellationPublications += 1
        if (cancellationPublications === 2) throw new Error('simulated queued cancellation publication failure')
      }
    },
  })
  const executor: WorldRenderExecutor = {
    execute: () => new Promise<void>((resolve) => { releaseFirst = resolve }),
  }
  const service = new WorldRenderJobService({
    projectReader: reader(snapshot()),
    outputRepository: repository,
    executor,
    maxConcurrentJobs: 1,
  })
  assert.equal((await service.create(createRequest())).ok, true)
  assert.equal((await service.create(createRequest())).ok, true)
  await new Promise((resolve) => setImmediate(resolve))

  failQueuedFinish = true
  const cancelled = await service.cancel({ jobId: 'render-22222222222222222222222222222222' })
  assert.equal(cancelled.ok, false)
  if (!cancelled.ok) assert.equal(cancelled.error.code, 'write_failed')
  const idle = service.whenIdle()
  releaseFirst()
  await assert.rejects(idle, /write_failed/)
})

test('cancellation is idempotent, aborts the executor, and becomes cancelled only after settlement', async (t) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let markExecutorEntered!: () => void
  const executorEntered = new Promise<void>((resolve) => { markExecutorEntered = resolve })
  let observedAbort = false
  const executor: WorldRenderExecutor = {
    async execute(context) {
      await context.reportProgress({ phase: 'preflighting', completedFrames: 0 })
      markExecutorEntered()
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => { observedAbort = true; resolve() }, { once: true })
      })
      await held
      throw new DOMException('Cancelled', 'AbortError')
    },
  }
  const { service } = await fixture(t, executor)
  assert.equal((await service.create(createRequest())).ok, true)
  await executorEntered
  const first = await service.cancel({ jobId: JOB_ID })
  assert.equal(first.ok, true)
  if (first.ok) assert.equal(first.value.status, 'cancel_requested')
  const second = await service.cancel({ jobId: JOB_ID })
  assert.equal(second.ok, true)
  if (second.ok) assert.equal(second.value.status, 'cancel_requested')
  const beforeSettle = await service.get({ jobId: JOB_ID })
  assert.equal(beforeSettle.ok && beforeSettle.value.status, 'cancel_requested')
  assert.equal(observedAbort, true)
  release()
  await service.whenIdle()
  const final = await service.get({ jobId: JOB_ID })
  assert.equal(final.ok && final.value.status, 'cancelled')
  const third = await service.cancel({ jobId: JOB_ID })
  assert.equal(third.ok && third.value.status, 'cancelled')
})

test('active cancellation aborts stalled package preflight before durable publication and never settles late', async (t) => {
  const { repository, service } = await fixture(t, { execute: async () => undefined })
  const internal = repository as unknown as {
    openExecutionPackage(jobId: string, signal?: AbortSignal): Promise<WorldRenderExecutionPackage>
    requestCancel(jobId: string): ReturnType<WorldRenderOutputRepository['requestCancel']>
    settle: WorldRenderOutputRepository['settle']
  }
  const originalOpen = repository.openExecutionPackage.bind(repository)
  const originalRequestCancel = repository.requestCancel.bind(repository)
  const originalSettle = repository.settle.bind(repository)
  let preflightEntered!: () => void
  let releasePreflight!: () => void
  const entered = new Promise<void>((resolvePromise) => { preflightEntered = resolvePromise })
  let preflightSignal: AbortSignal | undefined
  let signalWasAbortedBeforePublication = false
  let lateSettlements = 0

  internal.openExecutionPackage = async (jobId, signal) => {
    preflightSignal = signal
    preflightEntered()
    await new Promise<void>((resolvePromise) => {
      releasePreflight = resolvePromise
      if (signal?.aborted) resolvePromise()
      else signal?.addEventListener('abort', () => resolvePromise(), { once: true })
    })
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    return originalOpen(jobId, signal)
  }
  internal.requestCancel = async (jobId) => {
    signalWasAbortedBeforePublication = preflightSignal?.aborted === true
    return originalRequestCancel(jobId)
  }
  internal.settle = async (...args) => {
    lateSettlements += 1
    return originalSettle(...args)
  }

  assert.equal((await service.create(createRequest())).ok, true)
  await entered
  const cancelled = await service.cancel({ jobId: JOB_ID })
  releasePreflight()
  await service.whenIdle()
  const final = await service.get({ jobId: JOB_ID })

  assert.equal(cancelled.ok && cancelled.value.status, 'cancel_requested')
  assert.ok(preflightSignal, 'preflight must receive the active job signal')
  assert.equal(signalWasAbortedBeforePublication, true)
  assert.equal(final.ok && final.value.status, 'cancelled')
  assert.equal(lateSettlements, 0)
})

test('cancel, idle, and shutdown remain bounded when the repository cancellation authority never settles', async (t) => {
  let markEntered!: () => void
  const entered = new Promise<void>((resolvePromise) => { markEntered = resolvePromise })
  const executor: WorldRenderExecutor = {
    async execute(context) {
      markEntered()
      await new Promise<void>((resolvePromise) => {
        if (context.signal.aborted) resolvePromise()
        else context.signal.addEventListener('abort', () => resolvePromise(), { once: true })
      })
      throw new DOMException('Cancelled', 'AbortError')
    },
  }
  const { repository, service } = await fixture(t, executor, snapshot(), { cancellationWaitMs: 10 })
  assert.equal((await service.create(createRequest())).ok, true)
  await entered
  ;(repository as unknown as {
    requestCancel(jobId: string): ReturnType<WorldRenderOutputRepository['requestCancel']>
  }).requestCancel = async () => new Promise<never>(() => undefined)

  const cancelled = await Promise.race([
    service.cancel({ jobId: JOB_ID }),
    new Promise<'test-timeout'>((resolvePromise) => setTimeout(() => resolvePromise('test-timeout'), 250)),
  ])
  assert.notEqual(cancelled, 'test-timeout')
  assert.equal(typeof cancelled === 'object' && cancelled.ok, false)

  await assert.rejects(Promise.race([
    service.whenIdle(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('test-timeout')), 250)),
  ]), /write_failed/)
  const shutdown = await Promise.race([
    service.shutdown().then(() => 'shutdown' as const),
    new Promise<'test-timeout'>((resolvePromise) => setTimeout(() => resolvePromise('test-timeout'), 250)),
  ])
  assert.equal(shutdown, 'shutdown')
})

test('active cancellation does not strand idle or shutdown when final cancellation cleanup never settles', async (t) => {
  let markEntered!: () => void
  const entered = new Promise<void>((resolvePromise) => { markEntered = resolvePromise })
  const executor: WorldRenderExecutor = {
    async execute(context) {
      markEntered()
      await new Promise<void>((resolvePromise) => {
        if (context.signal.aborted) resolvePromise()
        else context.signal.addEventListener('abort', () => resolvePromise(), { once: true })
      })
      throw new DOMException('Cancelled', 'AbortError')
    },
  }
  const { repository, service } = await fixture(t, executor, snapshot(), {
    cancellationWaitMs: 500,
    idleWaitMs: 50,
    shutdownWaitMs: 100,
  })
  assert.equal((await service.create(createRequest())).ok, true)
  await entered
  ;(repository as unknown as {
    finishCancelled(jobId: string): ReturnType<WorldRenderOutputRepository['finishCancelled']>
  }).finishCancelled = async () => new Promise<never>(() => undefined)

  const cancelled = await service.cancel({ jobId: JOB_ID })
  assert.equal(cancelled.ok && cancelled.value.status, 'cancel_requested')

  const idle = await settleWithin(
    service.whenIdle().then(() => 'idle' as const, (error: unknown) => error),
    500,
  )
  assert.match(String(idle), /write_failed/)

  const shutdown = await settleWithin(service.shutdown().then(() => 'shutdown' as const), 500)
  assert.equal(shutdown, 'shutdown')
})

test('noncooperative executor cancellation, idle, and shutdown are finite without late output publication', async (t) => {
  let markEntered!: () => void
  const entered = new Promise<void>((resolvePromise) => { markEntered = resolvePromise })
  let lateContext: Parameters<WorldRenderExecutor['execute']>[0] | undefined
  const executor: WorldRenderExecutor = {
    execute: (context) => {
      lateContext = context
      markEntered()
      return new Promise<never>(() => undefined)
    },
  }
  const { root, service } = await fixture(t, executor, snapshot(), {
    cancellationWaitMs: 500,
    idleWaitMs: 15,
    shutdownWaitMs: 25,
  })
  assert.equal((await service.create(createRequest())).ok, true)
  await entered

  const cancelled = await settleWithin(service.cancel({ jobId: JOB_ID }), 1_000)
  assert.equal(cancelled.ok && cancelled.value.status, 'cancel_requested')
  await assert.rejects(settleWithin(service.whenIdle()), /write_failed/)
  await settleWithin(service.shutdown())

  assert.ok(lateContext)
  await assert.rejects(
    lateContext.writeWebm(webm()),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  const final = await service.get({ jobId: JOB_ID })
  assert.equal(final.ok && final.value.status, 'cancel_requested')
  if (final.ok) assert.equal(final.value.outputs.webm, null)

  const recoveredRepository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
  await recoveredRepository.recoverJobs()
  const recovered = await recoveredRepository.get({ jobId: JOB_ID })
  assert.equal(recovered.ok && recovered.value.status, 'cancelled')
  if (recovered.ok) assert.equal(recovered.value.outputs.webm, null)
})

test('shutdown bounds a noncooperative admission and prevents late job publication', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-render-late-admission-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let releaseOpen!: (value: WorldProjectOpenResult) => void
  const opened = new Promise<WorldProjectOpenResult>((resolvePromise) => { releaseOpen = resolvePromise })
  const repository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => JOB_ID,
  })
  const service = new WorldRenderJobService({
    projectReader: { open: () => opened },
    outputRepository: repository,
    executor: { execute: async () => undefined },
    cancellationWaitMs: 10,
    idleWaitMs: 10,
    shutdownWaitMs: 15,
  })
  const creating = service.create(createRequest())
  await new Promise((resolvePromise) => setImmediate(resolvePromise))

  await settleWithin(service.shutdown())
  releaseOpen({
    ok: true,
    value: {
      status: 'ready',
      projectKey: PROJECT_KEY,
      snapshot: snapshot(),
      durabilityWarnings: [],
    },
  })
  const created = await settleWithin(creating)
  assert.equal(created.ok, false)
  if (!created.ok) assert.equal(created.error.code, 'executor_unavailable')
  const listed = await repository.list()
  assert.equal(listed.ok, true)
  if (listed.ok) assert.deepEqual(listed.value.jobs, [])
})

test('restart marks active jobs interrupted, deletes only terminal work, and rejects a stale authority', async (t) => {
  let release!: () => void
  const executor: WorldRenderExecutor = { execute: () => new Promise<void>((resolve) => { release = resolve }) }
  const { root, service } = await fixture(t, executor)
  assert.equal((await service.create(createRequest())).ok, true)
  await new Promise((resolve) => setImmediate(resolve))

  const busyDelete = await service.delete({ jobId: JOB_ID })
  assert.equal(busyDelete.ok, false)
  if (!busyDelete.ok) assert.equal(busyDelete.error.code, 'job_busy')

  const restartedRepository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
  const restarted = new WorldRenderJobService({
    projectReader: reader(snapshot()), outputRepository: restartedRepository,
    executor: { execute: async () => undefined },
  })
  await restarted.initialize()
  const recovered = await restarted.get({ jobId: JOB_ID })
  assert.equal(recovered.ok && recovered.value.status, 'interrupted')
  const deleted = await restarted.delete({ jobId: JOB_ID })
  assert.equal(deleted.ok, true)
  const missing = await restarted.get({ jobId: JOB_ID })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.error.code, 'job_not_found')

  release()
  await assert.rejects(service.whenIdle(), /job_not_found/)
  const stillMissing = await restarted.get({ jobId: JOB_ID })
  assert.equal(stillMissing.ok, false)
  if (!stillMissing.ok) assert.equal(stillMissing.error.code, 'job_not_found')
})

test('bounded scheduling never runs more than the configured executor count', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-render-concurrency-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ids = [
    'render-0123456789abcdef0123456789abcdef',
    'render-fedcba9876543210fedcba9876543210',
  ]
  const releases: Array<() => void> = []
  const starts: string[] = []
  let active = 0
  let maximumActive = 0
  const executor: WorldRenderExecutor = {
    async execute(context) {
      starts.push(context.jobId)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
    },
  }
  const repository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => ids.shift()!,
  })
  const service = new WorldRenderJobService({
    projectReader: reader(snapshot()), outputRepository: repository, executor, maxConcurrentJobs: 1,
  })
  assert.equal((await service.create(createRequest())).ok, true)
  assert.equal((await service.create(createRequest())).ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(starts.length, 1)
  releases.shift()!()
  while (starts.length < 2) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(maximumActive, 1)
  releases.shift()!()
  await service.whenIdle()
  assert.equal(maximumActive, 1)
})

test('shutdown rejects new work, cancels queued and active jobs, and waits for durable settlement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-render-shutdown-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ids = [
    'render-11111111111111111111111111111111',
    'render-22222222222222222222222222222222',
  ]
  let executorStarted!: () => void
  const started = new Promise<void>((resolve) => { executorStarted = resolve })
  let aborts = 0
  const executor: WorldRenderExecutor = {
    async execute(context) {
      executorStarted()
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve()
        else context.signal.addEventListener('abort', () => { aborts += 1; resolve() }, { once: true })
      })
      throw new DOMException('Cancelled', 'AbortError')
    },
  }
  const repository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => ids.shift()!,
  })
  const service = new WorldRenderJobService({
    projectReader: reader(snapshot()), outputRepository: repository, executor, maxConcurrentJobs: 1,
  })
  assert.equal((await service.create(createRequest())).ok, true)
  assert.equal((await service.create(createRequest())).ok, true)
  await started
  await Promise.all([service.shutdown(), service.shutdown()])
  assert.equal(aborts, 1)
  const listed = await service.list()
  assert.equal(listed.ok, true)
  if (listed.ok) assert.deepEqual(listed.value.jobs.map((job) => job.status).sort(), ['cancelled', 'cancelled'])
  const afterShutdown = await service.create(createRequest())
  assert.equal(afterShutdown.ok, false)
  if (!afterShutdown.ok) assert.equal(afterShutdown.error.code, 'executor_unavailable')
})

test('shutdown waits for an in-flight create admission and cannot strand its durable queued job', async (t) => {
  const { repository, service } = await fixture(t, { execute: async () => undefined })
  const originalCreateJob = repository.createJob.bind(repository)
  let markEntered!: () => void
  let releaseCreate!: () => void
  const entered = new Promise<void>((resolve) => { markEntered = resolve })
  const released = new Promise<void>((resolve) => { releaseCreate = resolve })
  ;(repository as unknown as { createJob: typeof repository.createJob }).createJob = async (input) => {
    markEntered()
    await released
    return originalCreateJob(input)
  }

  const creating = service.create(createRequest())
  await entered
  let shutdownSettled = false
  const shuttingDown = service.shutdown().then(() => { shutdownSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  const settledBeforeAdmission = shutdownSettled
  releaseCreate()
  const [created] = await Promise.all([creating, shuttingDown])

  assert.equal(settledBeforeAdmission, false, 'shutdown must own an already admitted create call')
  assert.equal(created.ok, true)
  const listed = await service.list()
  assert.equal(listed.ok, true)
  if (listed.ok) assert.deepEqual(listed.value.jobs.map((entry) => entry.status), ['cancelled'])
})

test('preflight rejects invalid camera state and bounded duration before creating a job', async (t) => {
  const invalidCamera = snapshot()
  invalidCamera.scenes[0].entities[0].components = []
  const cameraFixture = await fixture(t, { execute: async () => undefined }, invalidCamera)
  const cameraResult = await cameraFixture.service.create(createRequest())
  assert.equal(cameraResult.ok, false)
  if (!cameraResult.ok) assert.equal(cameraResult.error.code, 'sequence_invalid')

  const tooLong = snapshot()
  tooLong.scenes[0].sequences[0].duration = { numerator: 901, denominator: 1 }
  const durationFixture = await fixture(t, { execute: async () => undefined }, tooLong)
  const durationResult = await durationFixture.service.create(createRequest())
  assert.equal(durationResult.ok, false)
  if (!durationResult.ok) assert.equal(durationResult.error.code, 'sequence_invalid')

  const zero = snapshot()
  zero.scenes[0].sequences[0].duration = { numerator: 0, denominator: 1 }
  const zeroFixture = await fixture(t, { execute: async () => undefined }, zero)
  const zeroResult = await zeroFixture.service.create(createRequest())
  assert.equal(zeroResult.ok, false)
  if (!zeroResult.ok) assert.equal(zeroResult.error.code, 'sequence_invalid')
})
