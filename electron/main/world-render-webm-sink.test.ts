import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { writeSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import { enumerateWorldFrames } from '../../src/areas/worlds/cinematic/worldRationalTime.ts'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import type { WorldRenderNormalizedCreateRequest } from '../../src/shared/types/worldRenders.ts'
import {
  WORLD_WEBM_MAX_OUTPUT_BYTES,
  type WorldWebmStartPayload,
} from '../../src/areas/worlds/render/worldWebmProtocol.ts'
import {
  assembleWorldWebmWithFfmpeg,
  type WorldFfmpegProcess,
} from './world-render-ffmpeg-encoder.ts'
import type { VerifiedWorldFfmpegRuntime } from './world-render-ffmpeg-runtime.ts'
import { WorldRenderOutputRepository } from './world-render-output-repository.ts'
import {
  validWorldRenderSeekableWebm100msWithoutDefaultDuration,
  validWorldRenderWebm100ms,
} from './world-render-webm-test-fixture.ts'

const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const JOB_ID = 'render-0123456789abcdef0123456789abcdef'
const GENERATION = '0123456789abcdef0123456789abcdef'
const WEBM = validWorldRenderWebm100ms()

function request(): WorldRenderNormalizedCreateRequest {
  return { projectKey: PROJECT_KEY, expectedRevision: 1, sceneId: 'scene:main', sequenceId: 'sequence:short', preset: { width: 64, height: 64, fps: 30 } }
}

function snapshot(): WorldProjectSnapshotV1 {
  const sequence = { id: 'sequence:short', name: 'Short', duration: { numerator: 1, denominator: 10 }, tracks: [] }
  return {
    project: {
      schema: 'modly.world-project.v1', projectId: 'project:render', name: 'Render', revision: 1,
      resources: [], scenes: [{ id: 'scene:main', name: 'Main', documentPath: `Worlds/${PROJECT_KEY}/scenes/main.world-scene.json` }],
      startSceneId: 'scene:main', inputActions: [],
      graphicsProfiles: [{ id: 'graphics:test', name: 'Test', renderScale: 1, shadowQuality: 'off', antialiasing: 'off' }], activeGraphicsProfileId: 'graphics:test',
    },
    scenes: [{
      schema: 'modly.world-scene.v1', projectId: 'project:render', sceneId: 'scene:main', name: 'Main',
      environment: { backgroundColor: '#000000', ambientIntensity: 0 },
      entities: [{ id: 'entity:camera', name: 'Camera', parentId: null, enabled: true, locked: false, tags: [], transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [{ id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 50 }] }],
      sequences: [sequence],
    }],
  }
}

function png(index: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc(64 * (1 + 64 * 4), index)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type)
  const value = Buffer.alloc(12 + data.length)
  value.writeUInt32BE(data.length, 0); name.copy(value, 4); data.copy(value, 8)
  let crc = 0xffff_ffff
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1))
  }
  value.writeUInt32BE((crc ^ 0xffff_ffff) >>> 0, 8 + data.length)
  return value
}

function wav(): Buffer {
  const samples = 4_800
  const value = Buffer.alloc(44 + samples * 4)
  value.write('RIFF'); value.writeUInt32LE(value.length - 8, 4); value.write('WAVEfmt ', 8); value.writeUInt32LE(16, 16)
  value.writeUInt16LE(1, 20); value.writeUInt16LE(2, 22); value.writeUInt32LE(48_000, 24); value.writeUInt32LE(192_000, 28)
  value.writeUInt16LE(4, 32); value.writeUInt16LE(16, 34); value.write('data', 36); value.writeUInt32LE(samples * 4, 40)
  for (let sample = 0; sample < samples; sample += 1) { value.writeInt16LE(sample % 32767, 44 + sample * 4); value.writeInt16LE(-(sample % 32767), 46 + sample * 4) }
  return value
}

const webmPlan: WorldWebmStartPayload = {
  width: 64, height: 64, fps: 30, frameCount: 3,
  duration: { numerator: 1, denominator: 10 }, audioSampleCount: 4_800,
  frameDurations: [
    { numerator: 1, denominator: 30 },
    { numerator: 1, denominator: 30 },
    { numerator: 1, denominator: 30 },
  ],
  videoBitrate: 500_000, audioBitrate: 128_000,
}

async function fixture(t: test.TestContext, options: object = {}) {
  const root = await mkdtemp(join(tmpdir(), 'modly-webm-sink-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root, createJobId: () => JOB_ID, ...options })
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 10 }, 30)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  for (const frame of plan) assert.equal((await repository.recordFrame(JOB_ID, frame.index, png(frame.index))).ok, true)
  assert.equal((await repository.recordAudio(JOB_ID, wav())).ok, true)
  assert.equal((await repository.updateProgress(JOB_ID, { phase: 'assembling', completedFrames: 3 })).ok, true)
  return { root, repository }
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

async function publishSucceededWebm(repository: WorldRenderOutputRepository): Promise<void> {
  const { sinkId } = await repository.beginWebmAssembly(
    JOB_ID, GENERATION, webmPlan, new AbortController().signal,
  )
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )
  await repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId)
  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok && settled.value.status, 'succeeded')
}

test('serves path-free verified frame and PCM ranges only after sink authorization', async (t) => {
  const { repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  const frame = await repository.readWebmFrameMaster(JOB_ID, GENERATION, sinkId, 1, new AbortController().signal)
  assert.deepEqual(Buffer.from(frame.bytes), png(1))
  const audio = await repository.readWebmAudioMaster(JOB_ID, GENERATION, sinkId, 100, 200, new AbortController().signal)
  assert.equal(audio.sampleOffset, 100)
  assert.equal(audio.sampleCount, 200)
  assert.deepEqual(Buffer.from(audio.bytes), wav().subarray(44 + 100 * 4, 44 + 300 * 4))
  await repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
})

test('normal list and get calls cannot unlink an active random-access sink temp', async (t) => {
  const { repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  assert.equal((await repository.list()).ok, true)
  assert.equal((await repository.get({ jobId: JOB_ID })).ok, true)

  await repository.commitWebmAssembly(JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal)
  await repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId)
  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok, true)
  if (settled.ok) assert.equal(settled.value.status, 'succeeded')
})

test('supports overlapping out-of-order positional writes, short writes, and atomic commit', async (t) => {
  let positionedCalls = 0
  const { root, repository } = await fixture(t, {
    positionedWrite: async (handle: { write(...args: unknown[]): Promise<{ bytesWritten: number }> }, bytes: Uint8Array, offset: number, length: number, position: number) => {
      positionedCalls += 1
      return handle.write(bytes, offset, Math.min(length, 7), position)
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  const split = Math.floor(WEBM.length / 2)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, split, WEBM.subarray(split))
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM.subarray(0, split + 16))
  const artifact = await repository.commitWebmAssembly(JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal)
  assert.ok(positionedCalls > 2)
  assert.equal(artifact.size, WEBM.length)
  assert.deepEqual(await readFile(join(root, artifact.workspacePath)), WEBM)
  await repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId)
  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok, true)
  if (settled.ok) assert.equal(settled.value.status, 'succeeded')
})

test('commits a seekable no-DefaultDuration WebM written only through an inherited descriptor lease', async (t) => {
  const { root, repository } = await fixture(t)
  const bytes = validWorldRenderSeekableWebm100msWithoutDefaultDuration()
  const { sinkId } = await repository.beginWebmAssembly(
    JOB_ID, GENERATION, webmPlan, new AbortController().signal,
  )
  const lease = repository.acquireWebmFileOutputLease(JOB_ID, GENERATION, sinkId)
  assert.equal(Number.isSafeInteger(lease.fd) && lease.fd > 2, true)
  assert.deepEqual(Object.keys(lease).sort(), ['fd', 'release'])
  assert.equal(writeSync(lease.fd, bytes, 0, bytes.byteLength, 0), bytes.byteLength)
  const firstRelease = lease.release()
  assert.strictEqual(lease.release(), firstRelease)
  assert.deepEqual(await firstRelease, { extent: bytes.byteLength })

  const artifact = await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, bytes.byteLength, new AbortController().signal,
  )
  assert.equal(artifact.size, bytes.byteLength)
  assert.deepEqual(await readFile(join(root, artifact.workspacePath)), bytes)
  assert.equal(await repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId), true)
})

test('fake-child FFmpeg orchestration promotes only the seekable repository descriptor after close', async (t) => {
  const { root, repository } = await fixture(t)
  const bytes = validWorldRenderSeekableWebm100msWithoutDefaultDuration()
  const runtime: VerifiedWorldFfmpegRuntime = {
    target: 'linux-x64',
    rootPath: '/audited/ffmpeg/linux-x64',
    executablePath: '/audited/ffmpeg/linux-x64/bin/ffmpeg',
    sharedLibraryPaths: ['/audited/ffmpeg/linux-x64/bin/libavcodec.so.61'],
    ffmpegVersion: '7.1.1', signingKeyId: 'test', manifestSha256: 'a'.repeat(64),
  }
  const lifecycle: string[] = []
  const result = await assembleWorldWebmWithFfmpeg({
    runtime,
    acquireRuntimeLease: async () => ({
      runtime,
      spawn: (spawnProcess, args, options) => spawnProcess(runtime.executablePath, args, options),
      release: async () => { lifecycle.push('runtime-release') },
    }),
    plan: webmPlan,
    jobId: JOB_ID,
    generation: GENERATION,
    authority: repository,
    signal: new AbortController().signal,
    spawnProcess: (_file, args, options) => {
      const inheritedFd = options.stdio[5]
      assert.equal(typeof inheritedFd, 'number')
      assert.deepEqual(args.slice(-7), ['-f', 'webm', '-fd', '5', '-blocksize', '8388608', 'fd:'])
      const emitter = new EventEmitter()
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const finalVideo = new PassThrough()
      const audio = new PassThrough()
      for (const stream of [stdin, finalVideo, audio]) stream.resume()
      const child = Object.assign(emitter, {
        stdin,
        stdout,
        stderr,
        stdio: [stdin, stdout, stderr, finalVideo, audio, null],
        kill: () => true,
        unref: () => undefined,
      }) as unknown as WorldFfmpegProcess
      void Promise.all([once(stdin, 'finish'), once(finalVideo, 'finish'), once(audio, 'finish')]).then(() => {
        assert.equal(writeSync(inheritedFd as number, bytes, 0, bytes.byteLength, 0), bytes.byteLength)
        lifecycle.push('native-write')
        stdout.end()
        stderr.end('frame=3\nout_time_us=100000\ntotal_size=' + bytes.byteLength + '\nprogress=end\n')
        setImmediate(() => { lifecycle.push('native-close'); emitter.emit('close', 0, null) })
      })
      return child
    },
  })

  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(await readFile(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, 'output.webm')), bytes)
  assert.ok(lifecycle.indexOf('native-close') < lifecycle.indexOf('runtime-release'))
})

test('descriptor sink abort is one exact tombstone and cannot acknowledge before inherited custody releases', async (t) => {
  const { root, repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(
    JOB_ID, GENERATION, webmPlan, new AbortController().signal,
  )
  const lease = repository.acquireWebmFileOutputLease(JOB_ID, GENERATION, sinkId)
  const firstAbort = repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
  assert.strictEqual(repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId), firstAbort)
  const early = await Promise.race([
    firstAbort.then(() => 'settled' as const),
    new Promise<'pending'>((resolvePromise) => setTimeout(() => resolvePromise('pending'), 20)),
  ])
  assert.equal(early, 'pending')
  assert.deepEqual(await lease.release(), { extent: 0 })
  assert.equal(await settleWithin(firstAbort), true)
  const entries = await readdir(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID))
  assert.equal(entries.some((entry) => /^\.webm-[a-f0-9]{32}\.tmp$/.test(entry)), false)
})

test('descriptor release rejects a replaced staging pathname and abort removes the attacker replacement', async (t) => {
  const { root, repository } = await fixture(t)
  const bytes = validWorldRenderSeekableWebm100msWithoutDefaultDuration()
  const { sinkId } = await repository.beginWebmAssembly(
    JOB_ID, GENERATION, webmPlan, new AbortController().signal,
  )
  const lease = repository.acquireWebmFileOutputLease(JOB_ID, GENERATION, sinkId)
  const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
  const temporaryName = (await readdir(jobRoot)).find((entry) => /^\.webm-[a-f0-9]{32}\.tmp$/.test(entry))
  assert.ok(temporaryName)
  const temporaryPath = join(jobRoot, temporaryName)
  await rm(temporaryPath)
  await writeFile(temporaryPath, bytes)
  assert.equal(writeSync(lease.fd, bytes, 0, bytes.byteLength, 0), bytes.byteLength)

  const exactRelease = lease.release()
  await assert.rejects(exactRelease, /unsafe_workspace/)
  const exactAbort = repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
  assert.strictEqual(repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId), exactAbort)
  await assert.rejects(exactAbort, /unsafe_workspace/)
  await assert.rejects(readFile(temporaryPath), /ENOENT/)
})

test('timeout and cancellation retain descriptor cleanup until a never-close child closes late', async (t) => {
  for (const kind of ['timeout', 'cancel'] as const) {
    await t.test(kind, async (t) => {
      const { root, repository } = await fixture(t)
      const runtime: VerifiedWorldFfmpegRuntime = {
        target: 'linux-x64', rootPath: '/audited/ffmpeg/linux-x64',
        executablePath: '/audited/ffmpeg/linux-x64/bin/ffmpeg',
        sharedLibraryPaths: ['/audited/ffmpeg/linux-x64/bin/libavcodec.so.61'],
        ffmpegVersion: '7.1.1', signingKeyId: 'test', manifestSha256: 'a'.repeat(64),
      }
      const emitter = new EventEmitter()
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const finalVideo = new PassThrough()
      const audio = new PassThrough()
      const kills: string[] = []
      const child = Object.assign(emitter, {
        stdin,
        stdout,
        stderr,
        stdio: [stdin, stdout, stderr, finalVideo, audio, null],
        kill: (signal = 'SIGTERM') => { kills.push(String(signal)); return true },
        unref: () => undefined,
      }) as unknown as WorldFfmpegProcess
      let runtimeReleases = 0
      let spawnCalls = 0
      let markSpawned!: () => void
      const spawned = new Promise<void>((resolvePromise) => { markSpawned = resolvePromise })
      const controller = new AbortController()
      const assembly = assembleWorldWebmWithFfmpeg({
        runtime,
        acquireRuntimeLease: async () => ({
          runtime,
          spawn: (spawnProcess, args, options) => spawnProcess(runtime.executablePath, args, options),
          release: async () => { runtimeReleases += 1 },
        }),
        plan: webmPlan,
        jobId: JOB_ID,
        generation: GENERATION,
        authority: repository,
        signal: controller.signal,
        spawnProcess: () => {
          spawnCalls += 1
          markSpawned()
          return child
        },
        timeouts: {
          inactivityMs: 1_000,
          hardMs: 15,
          killGraceMs: 10,
          closeWaitMs: 10,
          sinkBeginMs: 5_000,
          runtimeLeaseAcquireMs: 5_000,
          abortMs: 10,
          cancellationCleanupMs: 10,
          taskDrainMs: 10,
        },
      })
      await settleWithin(spawned, 5_500)
      assert.equal(spawnCalls, 1)
      if (kind === 'cancel') {
        controller.abort()
        await assert.rejects(assembly, (error: unknown) => error instanceof Error && error.name === 'AbortError')
      } else {
        assert.deepEqual(await assembly, { ok: false, code: 'sink-failed' })
      }
      assert.deepEqual(kills, ['SIGTERM', 'SIGKILL'])
      emitter.emit('error', new Error('late signal-delivery failure'))
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
      assert.equal(runtimeReleases, 0)
      const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
      assert.equal((await readdir(jobRoot)).some((entry) => /^\.webm-[a-f0-9]{32}\.tmp$/.test(entry)), true)

      emitter.emit('close', null, 'SIGKILL')
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!(await readdir(jobRoot)).some((entry) => /^\.webm-[a-f0-9]{32}\.tmp$/.test(entry))) break
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      }
      assert.equal((await readdir(jobRoot)).some((entry) => /^\.webm-[a-f0-9]{32}\.tmp$/.test(entry)), false)
      assert.equal(runtimeReleases, 1)
      assert.equal(emitter.listenerCount('close'), 0)
      assert.equal(emitter.listenerCount('error'), 1)
      assert.doesNotThrow(() => emitter.emit('error', new Error('post-close error')))
      assert.equal(runtimeReleases, 1)
      const recovered = await new WorldRenderOutputRepository({ getWorkspaceRoot: () => root }).recoverJobs()
      const recoveredJob = recovered.find((candidate) => candidate.jobId === JOB_ID)
      assert.equal(recoveredJob?.status, 'interrupted')
      assert.equal(recoveredJob?.outputs.webm, null)
    })
  }
})

test('an exact durable terminal receipt remains confirmed when its post-write checkpoint throws', async (t) => {
  let failConfirmedReceiptCheckpoint = false
  const { repository } = await fixture(t, {
    failureCheckpoint(stage: string) {
      if (failConfirmedReceiptCheckpoint && stage === 'artifact-receipt-published') {
        failConfirmedReceiptCheckpoint = false
        throw new Error('simulated post-receipt checkpoint failure')
      }
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  await repository.commitWebmAssembly(JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal)
  failConfirmedReceiptCheckpoint = true
  await repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId)

  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok, true)
  if (settled.ok) assert.equal(settled.value.status, 'succeeded')
})

test('a receipt directory sync failure cannot acknowledge WebM confirmation', async (t) => {
  let failNextReceiptDirectorySync = false
  const { root, repository } = await fixture(t, {
    syncDirectory: async (directory: string) => {
      if (failNextReceiptDirectorySync && directory.endsWith(join('.modly', 'artifacts'))) {
        failNextReceiptDirectorySync = false
        return false
      }
      return true
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  const artifact = await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )

  failNextReceiptDirectorySync = true
  await assert.rejects(repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId), /write_failed/)
  await repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)

  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok, true)
  if (settled.ok) {
    assert.equal(settled.value.status, 'partial')
    assert.equal(settled.value.outputs.webm, null)
  }
  await assert.rejects(readFile(join(root, artifact.workspacePath)), /ENOENT/)
})

test('rejects holes and bounds, makes abort idempotent, and removes its temp', async (t) => {
  const { root, repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 10, WEBM.subarray(10))
  await assert.rejects(repository.commitWebmAssembly(JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal), /output_invalid/)
  await assert.rejects(repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, WORLD_WEBM_MAX_OUTPUT_BYTES, new Uint8Array([1])), /invalid_request/)
  assert.equal(await repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId), true)
  assert.equal(await repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId), true)
  assert.equal((await readdir(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID))).some((name) => name.endsWith('.tmp')), false)
})

test('concurrent abort retries await one physical cleanup tombstone and receive its exact acknowledgement', async (t) => {
  let pauseAbort = false
  let enterAbort!: () => void
  let releaseAbort!: () => void
  const abortEntered = new Promise<void>((resolvePromise) => { enterAbort = resolvePromise })
  const abortReleased = new Promise<void>((resolvePromise) => { releaseAbort = resolvePromise })
  let abortSyncs = 0
  const { repository } = await fixture(t, {
    syncDirectory: async (directory: string) => {
      if (pauseAbort && basename(directory) === JOB_ID) {
        abortSyncs += 1
        enterAbort()
        await abortReleased
      }
      return true
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(
    JOB_ID, GENERATION, webmPlan, new AbortController().signal,
  )
  pauseAbort = true
  const first = repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
  await abortEntered
  let retrySettled = false
  const retryTombstone = repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
  assert.equal(retryTombstone, first)
  const retry = retryTombstone
    .finally(() => { retrySettled = true })
  try {
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(retrySettled, false, 'retry must await the in-flight physical cleanup')
  } finally {
    releaseAbort()
  }
  assert.equal(await first, true)
  assert.equal(await retry, true)
  assert.equal(abortSyncs, 1, 'physical cleanup must run exactly once')
})

test('abort cleanup false-success rejects every retry and prevents a replacement sink', async (t) => {
  let failAbortSync = false
  let abortSyncs = 0
  const { repository } = await fixture(t, {
    syncDirectory: async (directory: string) => {
      if (failAbortSync && basename(directory) === JOB_ID) {
        abortSyncs += 1
        return false
      }
      return true
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(
    JOB_ID, GENERATION, webmPlan, new AbortController().signal,
  )
  failAbortSync = true

  await assert.rejects(repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId), /write_failed/)
  await assert.rejects(repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId), /write_failed/)
  assert.equal(abortSyncs, 1, 'a retry must observe the same rejected cleanup tombstone')
  await assert.rejects(
    repository.beginWebmAssembly(JOB_ID, `${'2'.repeat(32)}`, webmPlan, new AbortController().signal),
    /job_busy/,
  )
})

test('durable cancellation wins over commit and recovery clears orphan assembly temps', async (t) => {
  const { root, repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  assert.equal((await repository.requestCancel(JOB_ID)).ok, true)
  await assert.rejects(repository.commitWebmAssembly(JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal), /cancelled/)
  await repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)

  const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
  await writeFile(join(jobRoot, 'orphan-webm.tmp'), 'orphan')
  const recovered = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
  await recovered.recoverJobs()
  await assert.rejects(readFile(join(jobRoot, 'orphan-webm.tmp')), /ENOENT/)
})

test('cancellation after commit returns retracts the published WebM before cancelling the job', async (t) => {
  const { root, repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  const artifact = await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )
  assert.deepEqual(await readFile(join(root, artifact.workspacePath)), WEBM)

  const requested = await repository.requestCancel(JOB_ID)
  assert.equal(requested.ok, true)
  if (requested.ok) {
    assert.equal(requested.value.status, 'cancel_requested')
    assert.equal(requested.value.outputs.webm, null)
  }
  await assert.rejects(readFile(join(root, artifact.workspacePath)), /ENOENT/)
  await assert.rejects(readFile(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, '.modly', 'artifacts', 'webm.v1.json')), /ENOENT/)
  assert.deepEqual(await readFile(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, 'frames', 'frame-000000.png')), png(0))
  assert.deepEqual(await readFile(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, 'audio', 'master.wav')), wav())

  const cancelled = await repository.finishCancelled(JOB_ID)
  assert.equal(cancelled.ok, true)
  if (cancelled.ok) assert.equal(cancelled.value.outputs.webm, null)
})

test('cancellation after terminal confirmation retracts its durable WebM publication', async (t) => {
  const { root, repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  const artifact = await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )
  await repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId)

  const requested = await repository.requestCancel(JOB_ID)
  assert.equal(requested.ok, true)
  if (requested.ok) {
    assert.equal(requested.value.status, 'cancel_requested')
    assert.equal(requested.value.outputs.webm, null)
  }
  await assert.rejects(readFile(join(root, artifact.workspacePath)), /ENOENT/)
})

test('a cancellation state checkpoint crash cannot resurrect a confirmed WebM on recovery', async (t) => {
  let failCancellationStateCheckpoint = false
  const { root, repository } = await fixture(t, {
    failureCheckpoint(stage: string) {
      if (failCancellationStateCheckpoint && stage === 'last-valid-published') {
        failCancellationStateCheckpoint = false
        throw new Error('simulated cancellation state checkpoint crash')
      }
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  const artifact = await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )
  await repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId)

  failCancellationStateCheckpoint = true
  const requested = await repository.requestCancel(JOB_ID)
  assert.equal(requested.ok, false)

  const recoveredRepository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
  const [recovered] = await recoveredRepository.recoverJobs()
  assert.equal(recovered.status, 'cancelled')
  assert.equal(recovered.outputs.webm, null)
  await assert.rejects(readFile(join(root, artifact.workspacePath)), /ENOENT/)
})

test('terminal rejection can abort and retract an already committed WebM', async (t) => {
  const { root, repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  const artifact = await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )

  await repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
  const detail = await repository.get({ jobId: JOB_ID })
  assert.equal(detail.ok, true)
  if (detail.ok) assert.equal(detail.value.outputs.webm, null)
  await assert.rejects(readFile(join(root, artifact.workspacePath)), /ENOENT/)
})

test('an unconfirmed commit is not durable output and recovery removes its promoted file', async (t) => {
  const { root, repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  const artifact = await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )
  const beforeRecovery = await repository.get({ jobId: JOB_ID })
  assert.equal(beforeRecovery.ok, true)
  if (beforeRecovery.ok) assert.equal(beforeRecovery.value.outputs.webm, null)
  assert.deepEqual(await readFile(join(root, artifact.workspacePath)), WEBM)

  const recoveredRepository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
  const [recovered] = await recoveredRepository.recoverJobs()
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.outputs.webm, null)
  await assert.rejects(readFile(join(root, artifact.workspacePath)), /ENOENT/)
})

test('settlement before terminal confirmation remains partial rather than promoting valid provisional bytes', async (t) => {
  const { repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  await repository.commitWebmAssembly(JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal)

  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok, true)
  if (settled.ok) {
    assert.equal(settled.value.status, 'partial')
    assert.equal(settled.value.outputs.webm, null)
  }
  await repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
})

test('aborting an uncommitted sink never removes a separately published canonical WebM', async (t) => {
  const { root, repository } = await fixture(t)
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  const published = await repository.recordWebm(JOB_ID, WEBM)
  assert.equal(published.ok, true)

  await repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
  const detail = await repository.get({ jobId: JOB_ID })
  assert.equal(detail.ok, true)
  if (detail.ok) assert.ok(detail.value.outputs.webm)
  assert.deepEqual(await readFile(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, 'output.webm')), WEBM)
})

test('cancellation wins when it arrives after WebM promotion but before durable publication', async (t) => {
  let pauseCommit = false
  let enteredCommit!: () => void
  let releaseCommit!: () => void
  const commitEntered = new Promise<void>((resolvePromise) => { enteredCommit = resolvePromise })
  const commitRelease = new Promise<void>((resolvePromise) => { releaseCommit = resolvePromise })
  const { root, repository } = await fixture(t, {
    syncDirectory: async () => {
      if (pauseCommit) {
        enteredCommit()
        await commitRelease
      }
      return true
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  pauseCommit = true
  const commit = repository.commitWebmAssembly(JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal)
  await commitEntered
  const cancellation = repository.requestCancel(JOB_ID)
  releaseCommit()
  await assert.rejects(commit, /cancelled/)
  assert.equal((await cancellation).ok, true)
  await repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
  const detail = await repository.get({ jobId: JOB_ID })
  assert.equal(detail.ok, true)
  if (detail.ok) assert.equal(detail.value.outputs.webm, null)
  await assert.rejects(readFile(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, 'output.webm')), /ENOENT/)
})

test('abort joins the exact commit lifecycle after promotion and retracts the owned canonical WebM before acknowledging', async (t) => {
  let pauseCommit = false
  let commitPaused = false
  let enterCommit!: () => void
  let releaseCommit!: () => void
  const commitEntered = new Promise<void>((resolvePromise) => { enterCommit = resolvePromise })
  const commitRelease = new Promise<void>((resolvePromise) => { releaseCommit = resolvePromise })
  const { root, repository } = await fixture(t, {
    syncDirectory: async (directory: string) => {
      if (pauseCommit && !commitPaused && basename(directory) === JOB_ID) {
        commitPaused = true
        enterCommit()
        await commitRelease
      }
      return true
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(
    JOB_ID, GENERATION, webmPlan, new AbortController().signal,
  )
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  pauseCommit = true
  const commit = repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )
  const commitRetry = repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )
  assert.equal(commitRetry, commit, 'commit retries must join the exact owned lifecycle')
  await commitEntered

  const canonicalPath = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, 'output.webm')
  assert.deepEqual(await readFile(canonicalPath), WEBM)
  let abortSettled = false
  const abort = repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
    .finally(() => { abortSettled = true })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(abortSettled, false, 'abort cannot acknowledge while the promoted commit is still in flight')

  releaseCommit()
  await assert.rejects(commit, /cancelled/)
  await assert.rejects(commitRetry, /cancelled/)
  assert.equal(await abort, true)
  await assert.rejects(readFile(canonicalPath), /ENOENT/)
})

test('cancellation joins confirmation at the receipt durability checkpoint and cannot strand the job', async (t) => {
  let pauseReceipt = false
  let enterReceipt!: () => void
  let releaseReceipt!: () => void
  const receiptEntered = new Promise<void>((resolvePromise) => { enterReceipt = resolvePromise })
  const receiptRelease = new Promise<void>((resolvePromise) => { releaseReceipt = resolvePromise })
  const { root, repository } = await fixture(t, {
    syncDirectory: async (directory: string) => {
      if (pauseReceipt && directory.endsWith(join('.modly', 'artifacts'))) {
        pauseReceipt = false
        enterReceipt()
        await receiptRelease
      }
      return true
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  const artifact = await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )
  pauseReceipt = true
  const confirmation = repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId)
  await receiptEntered
  const cancellation = repository.requestCancel(JOB_ID)
  releaseReceipt()

  await assert.rejects(confirmation, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  const requested = await cancellation
  assert.equal(requested.ok, true)
  if (requested.ok) {
    assert.equal(requested.value.status, 'cancel_requested')
    assert.equal(requested.value.outputs.webm, null)
  }
  const cancelled = await repository.finishCancelled(JOB_ID)
  assert.equal(cancelled.ok, true)
  if (cancelled.ok) {
    assert.equal(cancelled.value.status, 'cancelled')
    assert.equal(cancelled.value.outputs.webm, null)
  }
  await assert.rejects(readFile(join(root, artifact.workspacePath)), /ENOENT/)
  await assert.rejects(
    readFile(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, '.modly', 'artifacts', 'webm.v1.json')),
    /ENOENT/,
  )
  const deleted = await repository.delete({ jobId: JOB_ID })
  assert.equal(deleted.ok, true)
  await assert.rejects(readFile(join(root, artifact.workspacePath)), /ENOENT/)
})

test('request cancellation has a bounded public result while retaining the exact late confirmation and cleanup authority', async (t) => {
  let pauseReceipt = false
  let enterReceipt!: () => void
  let releaseReceipt!: () => void
  const receiptEntered = new Promise<void>((resolvePromise) => { enterReceipt = resolvePromise })
  const receiptRelease = new Promise<void>((resolvePromise) => { releaseReceipt = resolvePromise })
  const { repository } = await fixture(t, {
    cancellationWaitMs: 10,
    syncDirectory: async (directory: string) => {
      if (pauseReceipt && directory.endsWith(join('.modly', 'artifacts'))) {
        pauseReceipt = false
        enterReceipt()
        await receiptRelease
      }
      return true
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(
    JOB_ID, GENERATION, webmPlan, new AbortController().signal,
  )
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )
  pauseReceipt = true
  const confirmation = repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId)
  await receiptEntered

  const requested = await settleWithin(repository.requestCancel(JOB_ID))
  assert.equal(requested.ok, false)
  releaseReceipt()
  await assert.rejects(confirmation, (error: unknown) => error instanceof Error && error.name === 'AbortError')

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  const retried = await repository.requestCancel(JOB_ID)
  assert.equal(retried.ok, true)
  let cancelled = await repository.finishCancelled(JOB_ID)
  if (!cancelled.ok) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    cancelled = await repository.finishCancelled(JOB_ID)
  }
  assert.equal(cancelled.ok && cancelled.value.status, 'cancelled')
})

test('a cancellation intent durability failure performs no destructive WebM or manifest retraction', async (t) => {
  let failIntentDurability = false
  const { root, repository } = await fixture(t, {
    cancellationWaitMs: 25,
    syncDirectory: async (directory: string) => {
      if (failIntentDurability && basename(directory) === '.modly') {
        failIntentDurability = false
        return false
      }
      return true
    },
  })
  const { sinkId } = await repository.beginWebmAssembly(
    JOB_ID, GENERATION, webmPlan, new AbortController().signal,
  )
  await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
  await repository.commitWebmAssembly(
    JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
  )
  await repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId)
  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok && settled.value.status, 'succeeded')

  failIntentDurability = true
  const requested = await repository.requestCancel(JOB_ID)
  assert.equal(requested.ok, false)
  const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
  for (const path of [
    join(jobRoot, 'output.webm'),
    join(jobRoot, 'render-manifest.json'),
    join(jobRoot, '.modly', 'artifacts', 'webm.v1.json'),
    join(jobRoot, '.modly', 'artifacts', 'render-manifest.v1.json'),
  ]) assert.equal((await readFile(path)).byteLength > 0, true, path)
  const persisted = JSON.parse(String(await readFile(join(jobRoot, 'job.v1.json')))) as { status?: string }
  assert.equal(persisted.status, 'succeeded')
})

test('a cancellation intent write failure leaves the succeeded publication wholly intact', async (t) => {
  let failIntentWrite = false
  const { root, repository } = await fixture(t, {
    failureCheckpoint(stage: string) {
      if (failIntentWrite && stage === 'cancellation-intent-writing') {
        failIntentWrite = false
        throw new Error('simulated cancellation intent write failure')
      }
    },
  })
  await publishSucceededWebm(repository)
  failIntentWrite = true
  const requested = await repository.requestCancel(JOB_ID)
  assert.equal(requested.ok, false)

  const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
  await assert.rejects(readFile(join(jobRoot, '.modly', 'cancellation-intent.v1.json')), /ENOENT/)
  for (const path of [
    join(jobRoot, 'output.webm'),
    join(jobRoot, 'render-manifest.json'),
    join(jobRoot, '.modly', 'artifacts', 'webm.v1.json'),
    join(jobRoot, '.modly', 'artifacts', 'render-manifest.v1.json'),
  ]) assert.equal((await readFile(path)).byteLength > 0, true, path)
})

test('a post-intent retraction sync failure is restart-recoverable without orphaning published truth', async (t) => {
  let failReceiptRetractionSync = false
  const { root, repository } = await fixture(t, {
    syncDirectory(directory: string) {
      if (failReceiptRetractionSync && directory.endsWith(join('.modly', 'artifacts'))) {
        failReceiptRetractionSync = false
        return false
      }
      return true
    },
  })
  await publishSucceededWebm(repository)
  failReceiptRetractionSync = true
  const requested = await repository.requestCancel(JOB_ID)
  assert.equal(requested.ok, false)

  const restarted = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
  const recovered = await restarted.recoverJobs()
  assert.equal(recovered[0]?.status, 'cancelled')
  assert.equal(recovered[0]?.outputs.webm, null)
  assert.equal(recovered[0]?.outputs.renderManifest, null)
  const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
  for (const path of [
    join(jobRoot, 'output.webm'),
    join(jobRoot, 'render-manifest.json'),
    join(jobRoot, '.modly', 'artifacts', 'webm.v1.json'),
    join(jobRoot, '.modly', 'artifacts', 'render-manifest.v1.json'),
    join(jobRoot, '.modly', 'cancellation-intent.v1.json'),
  ]) await assert.rejects(readFile(path), /ENOENT/)
})

test('recovery idempotently completes every durable cancellation-intent checkpoint', async (t) => {
  const stages = [
    'cancellation-intent-published',
    'cancellation-render-manifest-receipt-removed',
    'cancellation-webm-receipt-removed',
    'cancellation-receipts-synced',
    'cancellation-render-manifest-removed',
    'cancellation-webm-removed',
    'cancellation-artifacts-synced',
    'last-valid-published',
    'journal-published',
    'state-published',
    'journal-cleaned',
    'cancellation-requested-published',
  ] as const

  for (const targetStage of stages) {
    await t.test(targetStage, async (t) => {
      let armed = false
      let failed = false
      const { root, repository } = await fixture(t, {
        failureCheckpoint(stage: string) {
          if (armed && !failed && stage === targetStage) {
            failed = true
            throw new Error(`simulated crash at ${stage}`)
          }
        },
      })
      await publishSucceededWebm(repository)
      armed = true
      const requested = await repository.requestCancel(JOB_ID)
      assert.equal(requested.ok, false)
      assert.equal(failed, true)

      const restarted = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
      const recovered = await restarted.recoverJobs()
      assert.equal(recovered.length, 1)
      assert.equal(recovered[0]?.status, 'cancelled')
      assert.equal(recovered[0]?.outputs.webm, null)
      assert.equal(recovered[0]?.outputs.renderManifest, null)
      const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
      for (const path of [
        join(jobRoot, 'output.webm'),
        join(jobRoot, 'render-manifest.json'),
        join(jobRoot, '.modly', 'artifacts', 'webm.v1.json'),
        join(jobRoot, '.modly', 'artifacts', 'render-manifest.v1.json'),
        join(jobRoot, '.modly', 'cancellation-intent.v1.json'),
      ]) await assert.rejects(readFile(path), /ENOENT/, `${targetStage}: ${path}`)
    })
  }
})

test('recovery completes cancellation crashes while publishing cancelled state or clearing its intent', async (t) => {
  for (const targetStage of ['cancellation-cancelled-published', 'cancellation-intent-cleared'] as const) {
    await t.test(targetStage, async (t) => {
      let armed = false
      let failed = false
      const { root, repository } = await fixture(t, {
        failureCheckpoint(stage: string) {
          if (armed && !failed && stage === targetStage) {
            failed = true
            throw new Error(`simulated crash at ${stage}`)
          }
        },
      })
      await publishSucceededWebm(repository)
      assert.equal((await repository.requestCancel(JOB_ID)).ok, true)
      armed = true
      const finished = await repository.finishCancelled(JOB_ID)
      assert.equal(finished.ok, false)
      assert.equal(failed, true)

      const restarted = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
      const recovered = await restarted.recoverJobs()
      assert.equal(recovered[0]?.status, 'cancelled')
      const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
      await assert.rejects(readFile(join(jobRoot, '.modly', 'cancellation-intent.v1.json')), /ENOENT/)
    })
  }
})

test('recovery rejects cancellation intents not exactly bound to the job revision and owned outputs', async (t) => {
  for (const mutation of [
    'revision',
    'webm-path',
    'webm-size',
    'webm-sha256',
    'manifest-size',
    'manifest-sha256',
    'webm-file-content',
    'manifest-file-content',
    'webm-receipt-sha256',
    'manifest-receipt-sha256',
    'extra-field',
  ] as const) {
    await t.test(mutation, async (t) => {
      let crashAfterIntent = false
      const { root, repository } = await fixture(t, {
        failureCheckpoint(stage: string) {
          if (crashAfterIntent && stage === 'cancellation-intent-published') {
            crashAfterIntent = false
            throw new Error('simulated crash after durable intent')
          }
        },
      })
      await publishSucceededWebm(repository)
      crashAfterIntent = true
      assert.equal((await repository.requestCancel(JOB_ID)).ok, false)

      const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
      const intentPath = join(jobRoot, '.modly', 'cancellation-intent.v1.json')
      const intent = JSON.parse(String(await readFile(intentPath))) as Record<string, unknown>
      if (mutation === 'revision') intent.revision = 2
      else if (mutation === 'extra-field') intent.attacker = true
      else if (mutation === 'webm-file-content' || mutation === 'manifest-file-content') {
        const artifactPath = join(jobRoot, mutation.startsWith('webm-') ? 'output.webm' : 'render-manifest.json')
        const bytes = await readFile(artifactPath)
        bytes[bytes.byteLength - 1] ^= 0x01
        await writeFile(artifactPath, bytes)
      } else if (mutation === 'webm-receipt-sha256' || mutation === 'manifest-receipt-sha256') {
        const receiptName = mutation.startsWith('webm-') ? 'webm.v1.json' : 'render-manifest.v1.json'
        const receiptPath = join(jobRoot, '.modly', 'artifacts', receiptName)
        const receipt = JSON.parse(String(await readFile(receiptPath))) as { artifact: { sha256: string } }
        receipt.artifact.sha256 = 'a'.repeat(64)
        await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`)
      } else if (mutation === 'webm-path') {
        const webm = intent.webm as Record<string, unknown>
        webm.workspacePath = `Exports/Worlds/Renders/${JOB_ID}/frames/frame-000000.png`
      } else {
        const key = mutation.startsWith('webm-') ? 'webm' : 'renderManifest'
        const descriptor = intent[key] as Record<string, unknown>
        if (mutation.endsWith('size')) descriptor.size = (descriptor.size as number) + 1
        else descriptor.sha256 = 'a'.repeat(64)
      }
      await writeFile(intentPath, `${JSON.stringify(intent)}\n`)

      const restarted = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
      await assert.rejects(restarted.recoverJobs(), /recovery_failed/)
      assert.equal((await readFile(join(jobRoot, 'output.webm'))).byteLength > 0, true)
      assert.equal((await readFile(join(jobRoot, 'render-manifest.json'))).byteLength > 0, true)
    })
  }
})

test('every cancellation cleanup checkpoint validates remaining receipts, files, and the immutable authority digest', async (t) => {
  const cases = [
    { stage: 'cancellation-intent-published', mutation: 'webm-receipt' },
    { stage: 'cancellation-render-manifest-receipt-removed', mutation: 'webm-receipt' },
    { stage: 'cancellation-webm-receipt-removed', mutation: 'webm-file' },
    { stage: 'cancellation-receipts-synced', mutation: 'webm-file' },
    { stage: 'cancellation-render-manifest-removed', mutation: 'webm-file' },
    { stage: 'cancellation-webm-removed', mutation: 'intent-descriptor' },
    { stage: 'cancellation-artifacts-synced', mutation: 'intent-descriptor' },
  ] as const

  for (const scenario of cases) {
    await t.test(scenario.stage, async (subtest) => {
      let armed = false
      let failed = false
      const { root, repository } = await fixture(subtest, {
        failureCheckpoint(stage: string) {
          if (armed && !failed && stage === scenario.stage) {
            failed = true
            throw new Error(`simulated crash at ${stage}`)
          }
        },
      })
      await publishSucceededWebm(repository)
      armed = true
      assert.equal((await repository.requestCancel(JOB_ID)).ok, false)
      assert.equal(failed, true)

      const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
      if (scenario.mutation === 'webm-receipt') {
        const path = join(jobRoot, '.modly', 'artifacts', 'webm.v1.json')
        const receipt = JSON.parse(String(await readFile(path))) as { artifact: { size: number } }
        receipt.artifact.size += 1
        await writeFile(path, `${JSON.stringify(receipt)}\n`)
      } else if (scenario.mutation === 'webm-file') {
        const path = join(jobRoot, 'output.webm')
        const bytes = await readFile(path)
        bytes[bytes.byteLength - 1] ^= 0x01
        await writeFile(path, bytes)
      } else {
        const path = join(jobRoot, '.modly', 'cancellation-intent.v1.json')
        const intent = JSON.parse(String(await readFile(path))) as { webm: { size: number } }
        intent.webm.size += 1
        await writeFile(path, `${JSON.stringify(intent)}\n`)
      }

      const protectedPaths = [
        join(jobRoot, 'output.webm'),
        join(jobRoot, 'render-manifest.json'),
        join(jobRoot, '.modly', 'artifacts', 'webm.v1.json'),
        join(jobRoot, '.modly', 'artifacts', 'render-manifest.v1.json'),
      ]
      const survivors = new Map<string, Buffer>()
      for (const path of protectedPaths) {
        try { survivors.set(path, await readFile(path)) } catch { /* already durably authorized and removed */ }
      }

      await assert.rejects(
        new WorldRenderOutputRepository({ getWorkspaceRoot: () => root }).recoverJobs(),
        /recovery_failed/,
      )
      for (const [path, bytes] of survivors) assert.deepEqual(await readFile(path), bytes, path)
    })
  }
})

test('never-settling physical sink cleanup bounds request and finalization while retaining late authority', async (t) => {
  let blockCleanup = false
  let releaseCleanup!: (value: boolean) => void
  const never = new Promise<boolean>((resolvePromise) => { releaseCleanup = resolvePromise })
  const { repository } = await fixture(t, {
    cancellationWaitMs: 10,
    failureCheckpoint(stage: string) {
      if (stage === 'cancellation-requested-published') blockCleanup = true
    },
    syncDirectory(directory: string) {
      if (blockCleanup && basename(directory) === JOB_ID) return never
      return true
    },
  })
  await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)

  const requested = await settleWithin(repository.requestCancel(JOB_ID))
  assert.equal(requested.ok, false)
  const finished = await settleWithin(repository.finishCancelled(JOB_ID))
  assert.equal(finished.ok, false)
  releaseCleanup(true)
  let completed = await repository.get({ jobId: JOB_ID })
  for (let attempt = 0; attempt < 100 && (!completed.ok || completed.value.status !== 'cancelled'); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    completed = await repository.get({ jobId: JOB_ID })
  }
  assert.equal(completed.ok && completed.value.status, 'cancelled')
})

test('cancellation retracts a published WebM manifest at every manifest publication checkpoint', async (t) => {
  const publicationStages = [
    'manifest-publication-intent-published',
    'manifest-artifact-published',
    'artifact-receipt-published',
    'last-valid-published',
    'journal-published',
    'state-published',
    'journal-cleaned',
    'manifest-publication-intent-cleared',
  ] as const

  for (const publicationStage of publicationStages) {
    await t.test(publicationStage, async (t) => {
      let armed = false
      let entered = false
      let enterCheckpoint!: () => void
      let releaseCheckpoint!: () => void
      const checkpointEntered = new Promise<void>((resolvePromise) => { enterCheckpoint = resolvePromise })
      const checkpointRelease = new Promise<void>((resolvePromise) => { releaseCheckpoint = resolvePromise })
      const { root, repository } = await fixture(t, {
        failureCheckpoint: async (stage: string) => {
          if (!armed || entered || stage !== publicationStage) return
          entered = true
          enterCheckpoint()
          await checkpointRelease
        },
      })
      const { sinkId } = await repository.beginWebmAssembly(
        JOB_ID, GENERATION, webmPlan, new AbortController().signal,
      )
      await repository.writeWebmAssembly(JOB_ID, GENERATION, sinkId, 0, WEBM)
      await repository.commitWebmAssembly(
        JOB_ID, GENERATION, sinkId, WEBM.length, new AbortController().signal,
      )
      await repository.confirmWebmAssembly(JOB_ID, GENERATION, sinkId)

      armed = true
      const settlement = repository.settle(JOB_ID, { executorError: null })
      await checkpointEntered
      const cancellation = repository.requestCancel(JOB_ID)
      releaseCheckpoint()

      const settled = await settlement
      assert.equal(settled.ok, true)
      if (settled.ok) {
        assert.equal(settled.value.status, 'cancel_requested')
        assert.equal(settled.value.outputs.webm, null)
        assert.equal(settled.value.outputs.renderManifest, null)
      }
      const requested = await cancellation
      assert.equal(requested.ok, true)
      if (requested.ok) {
        assert.equal(requested.value.status, 'cancel_requested')
        assert.equal(requested.value.outputs.webm, null)
        assert.equal(requested.value.outputs.renderManifest, null)
      }
      const cancelled = await repository.finishCancelled(JOB_ID)
      assert.equal(cancelled.ok, true)
      if (cancelled.ok) {
        assert.equal(cancelled.value.status, 'cancelled')
        assert.equal(cancelled.value.outputs.webm, null)
        assert.equal(cancelled.value.outputs.renderManifest, null)
      }

      const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
      for (const path of [
        join(jobRoot, 'output.webm'),
        join(jobRoot, 'render-manifest.json'),
        join(jobRoot, '.modly', 'artifacts', 'webm.v1.json'),
        join(jobRoot, '.modly', 'artifacts', 'render-manifest.v1.json'),
      ]) {
        await assert.rejects(readFile(path), /ENOENT/, path)
      }

      const restarted = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
      const recovered = await restarted.recoverJobs()
      assert.equal(recovered.length, 1)
      assert.equal(recovered[0]?.status, 'cancelled')
      assert.equal(recovered[0]?.outputs.webm, null)
      assert.equal(recovered[0]?.outputs.renderManifest, null)
      for (const path of [
        join(jobRoot, 'output.webm'),
        join(jobRoot, 'render-manifest.json'),
        join(jobRoot, '.modly', 'artifacts', 'webm.v1.json'),
        join(jobRoot, '.modly', 'artifacts', 'render-manifest.v1.json'),
      ]) {
        await assert.rejects(readFile(path), /ENOENT/, path)
      }
    })
  }
})

test('successful WebM abort identities prune only at a safe boundary while failed and in-flight cleanup remain retained', async (t) => {
  const cleanupCounts = (repository: WorldRenderOutputRepository) => {
    const internal = repository as unknown as {
      webmSinks: Map<string, unknown>
      webmSinkAbortions: Map<string, Promise<true>>
      cancelledWebmSinks: Set<string>
    }
    return {
      sinks: internal.webmSinks.size,
      abortions: internal.webmSinkAbortions.size,
      cancelled: internal.cancelledWebmSinks.size,
    }
  }

  await t.test('many successful cycles prune on terminal settlement', async (t) => {
    const { repository } = await fixture(t)
    for (let index = 0; index < 24; index += 1) {
      const generation = index.toString(16).padStart(32, '0')
      const { sinkId } = await repository.beginWebmAssembly(
        JOB_ID, generation, webmPlan, new AbortController().signal,
      )
      assert.equal(await repository.abortWebmAssembly(JOB_ID, generation, sinkId), true)
    }
    assert.deepEqual(cleanupCounts(repository), { sinks: 0, abortions: 24, cancelled: 24 })
    const settled = await repository.settle(JOB_ID, { executorError: null })
    assert.equal(settled.ok, true)
    if (settled.ok) assert.equal(settled.value.status, 'partial')
    assert.deepEqual(cleanupCounts(repository), { sinks: 0, abortions: 0, cancelled: 0 })
  })

  await t.test('failed cleanup survives a terminal boundary and still blocks replacement', async (t) => {
    let failCleanup = false
    const { repository } = await fixture(t, {
      syncDirectory: async (directory: string) => {
        if (failCleanup && basename(directory) === JOB_ID) {
          failCleanup = false
          return false
        }
        return true
      },
    })
    const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
    failCleanup = true
    await assert.rejects(repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId), /write_failed/)
    const settled = await repository.settle(JOB_ID, { executorError: null })
    assert.equal(settled.ok, true)
    assert.deepEqual(cleanupCounts(repository), { sinks: 1, abortions: 1, cancelled: 1 })
    await assert.rejects(
      repository.beginWebmAssembly(JOB_ID, 'f'.repeat(32), webmPlan, new AbortController().signal),
      /job_busy/,
    )
  })

  await t.test('in-flight cleanup prunes only after both cleanup and terminal settlement complete', async (t) => {
    let pauseCleanup = false
    let enterCleanup!: () => void
    let releaseCleanup!: () => void
    const cleanupEntered = new Promise<void>((resolvePromise) => { enterCleanup = resolvePromise })
    const cleanupRelease = new Promise<void>((resolvePromise) => { releaseCleanup = resolvePromise })
    const { repository } = await fixture(t, {
      syncDirectory: async (directory: string) => {
        if (pauseCleanup && basename(directory) === JOB_ID) {
          pauseCleanup = false
          enterCleanup()
          await cleanupRelease
        }
        return true
      },
    })
    const { sinkId } = await repository.beginWebmAssembly(JOB_ID, GENERATION, webmPlan, new AbortController().signal)
    pauseCleanup = true
    const cleanup = repository.abortWebmAssembly(JOB_ID, GENERATION, sinkId)
    await cleanupEntered
    const settled = await repository.settle(JOB_ID, { executorError: null })
    assert.equal(settled.ok, true)
    assert.deepEqual(cleanupCounts(repository), { sinks: 1, abortions: 1, cancelled: 1 })
    releaseCleanup()
    assert.equal(await cleanup, true)
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.deepEqual(cleanupCounts(repository), { sinks: 0, abortions: 0, cancelled: 0 })
  })
})
