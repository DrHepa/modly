import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'

import {
  WORLD_WEBM_MAX_AUDIO_SAMPLES,
  WORLD_WEBM_MAX_FRAME_COUNT,
  WORLD_WEBM_MAX_OUTPUT_BYTES,
  type WorldWebmStartPayload,
} from '../../src/areas/worlds/render/worldWebmProtocol.ts'
import {
  assembleWorldWebmWithFfmpeg,
  calculateWorldFfmpegTimeouts,
  createPackagedWorldFfmpegFallback,
  createWorldFfmpegArguments,
  type WorldFfmpegWebmAuthority,
  type WorldFfmpegProcess,
  type WorldFfmpegSpawn,
} from './world-render-ffmpeg-encoder.ts'
import {
  WORLD_FFMPEG_RUNTIME_SCHEMA,
  type WorldFfmpegExecutionLease,
  type WorldFfmpegRuntimeResolution,
  type VerifiedWorldFfmpegRuntime,
} from './world-render-ffmpeg-runtime.ts'

const JOB_ID = 'render-0123456789abcdef0123456789abcdef'
const GENERATION = '0123456789abcdef0123456789abcdef'
const signingKeys = generateKeyPairSync('ed25519')
const signingKeyId = 'modly-test-ed25519-2026'
const trustedManifestKeys = Object.freeze({
  [signingKeyId]: signingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
})
const PLAN: WorldWebmStartPayload = {
  width: 64,
  height: 64,
  fps: 30,
  frameCount: 3,
  duration: { numerator: 1, denominator: 10 },
  frameDurations: [
    { numerator: 1, denominator: 30 },
    { numerator: 1, denominator: 30 },
    { numerator: 1, denominator: 30 },
  ],
  audioSampleCount: 4_800,
  videoBitrate: 500_000,
  audioBitrate: 128_000,
}
const NON_ALIGNED_PLAN: WorldWebmStartPayload = {
  ...PLAN,
  frameCount: 31,
  duration: { numerator: 101, denominator: 100 },
  frameDurations: [
    ...Array.from({ length: 30 }, () => ({ numerator: 1, denominator: 30 })),
    { numerator: 1, denominator: 100 },
  ],
  audioSampleCount: 48_480,
}
const EARLY_PARTIAL_PLAN: WorldWebmStartPayload = {
  ...PLAN,
  frameCount: 4,
  duration: { numerator: 23, denominator: 200 },
  frameDurations: [
    { numerator: 1, denominator: 30 },
    { numerator: 1, denominator: 30 },
    { numerator: 1, denominator: 30 },
    { numerator: 3, denominator: 200 },
  ],
  audioSampleCount: 5_520,
}
const RUNTIME: VerifiedWorldFfmpegRuntime = {
  target: 'linux-x64',
  rootPath: '/opt/modly/resources/ffmpeg/linux-x64',
  executablePath: '/opt/modly/resources/ffmpeg/linux-x64/bin/ffmpeg',
  sharedLibraryPaths: ['/opt/modly/resources/ffmpeg/linux-x64/bin/libavcodec.so.61'],
  ffmpegVersion: '7.1.1',
  signingKeyId,
  manifestSha256: 'e'.repeat(64),
}
const WEBM = Uint8Array.from([26, 69, 223, 163, 1, 2, 3, 4])

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function valuesAfter(args: readonly string[], option: string): readonly string[] {
  const values: string[] = []
  for (let index = 0; index + 1 < args.length; index += 1) {
    if (args[index] === option) values.push(args[index + 1]!)
  }
  return values
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

const acquireTestRuntimeLease = async (
  runtime: VerifiedWorldFfmpegRuntime,
  events?: string[],
): Promise<WorldFfmpegExecutionLease> => ({
  runtime,
  spawn: (spawnProcess, args, options) => spawnProcess(runtime.executablePath, args, options),
  release: async () => { events?.push('lease-release') },
})

interface ProcessHarness {
  readonly child: WorldFfmpegProcess
  readonly video: Buffer[]
  readonly nominalVideo: Buffer[]
  readonly finalVideo: Buffer[]
  readonly audio: Buffer[]
  readonly inputStreams: readonly Writable[]
  readonly audioInput: Writable
  readonly kills: string[]
  readonly unrefs: { count: number }
  finish(code?: number, progress?: string): void
}

function processHarness(plan: WorldWebmStartPayload = PLAN): ProcessHarness {
  const emitter = new EventEmitter()
  const stdin = new PassThrough({ highWaterMark: 1 })
  const stdout = new PassThrough({ highWaterMark: 1 })
  const stderr = new PassThrough({ highWaterMark: 1 })
  const fourthInput = new PassThrough({ highWaterMark: 1 })
  const fifthInput = plan.frameCount > 1 ? new PassThrough({ highWaterMark: 1 }) : null
  const video: Buffer[] = []
  const nominalVideo: Buffer[] = []
  const finalVideo: Buffer[] = []
  const audio: Buffer[] = []
  const kills: string[] = []
  const unrefs = { count: 0 }
  stdin.on('data', (chunk: Buffer) => {
    video.push(Buffer.from(chunk))
    ;(plan.frameCount > 1 ? nominalVideo : finalVideo).push(Buffer.from(chunk))
  })
  if (fifthInput) {
    fourthInput.on('data', (chunk: Buffer) => {
      video.push(Buffer.from(chunk))
      finalVideo.push(Buffer.from(chunk))
    })
  }
  const audioInput = fifthInput ?? fourthInput
  audioInput.on('data', (chunk: Buffer) => audio.push(Buffer.from(chunk)))
  const stdio = fifthInput
    ? [stdin, stdout, stderr, fourthInput, fifthInput, null]
    : [stdin, stdout, stderr, fourthInput, null]
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    stdio,
    kill(signal = 'SIGTERM') {
      kills.push(signal)
      return true
    },
    unref() { unrefs.count += 1 },
  }) as unknown as WorldFfmpegProcess
  return {
    child,
    video,
    nominalVideo,
    finalVideo,
    audio,
    inputStreams: fifthInput ? [stdin, fourthInput, fifthInput] : [stdin, fourthInput],
    audioInput,
    kills,
    unrefs,
    finish(code = 0, progress = `frame=${plan.frameCount}\nout_time_us=${Math.round(
      plan.duration.numerator * 1_000_000 / plan.duration.denominator,
    )}\ntotal_size=8\nprogress=end\n`) {
      stdout.end()
      stderr.end(progress)
      setImmediate(() => emitter.emit('close', code, null))
    },
  }
}

function authority(events: string[] = [], options: {
  delayWrites?: boolean
  confirmAcknowledgement?: boolean
  abortAcknowledgement?: boolean
} = {}): WorldFfmpegWebmAuthority {
  let extent = 0
  return {
    async beginWebmAssembly() { events.push('sink-begin'); return { sinkId: `sink-${'a'.repeat(32)}` } },
    async readWebmFrameMaster(_jobId, _generation, _sinkId, index) {
      events.push(`read-frame:${index}`)
      const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, index])
      return { index, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), bytes }
    },
    async readWebmAudioMaster(_jobId, _generation, _sinkId, sampleOffset, sampleCount) {
      events.push(`read-audio:${sampleOffset}:${sampleCount}`)
      return { sampleOffset, sampleCount, bytes: new Uint8Array(sampleCount * 4) }
    },
    acquireWebmFileOutputLease() {
      events.push('output-lease-acquire')
      let release: Promise<{ readonly extent: number }> | null = null
      return {
        fd: 71,
        release: () => release ??= Promise.resolve().then(() => {
          extent = WEBM.byteLength
          events.push('output-lease-release')
          return { extent }
        }),
      }
    },
    async writeWebmAssembly(_jobId, _generation, _sinkId, position, bytes) {
      events.push(`sink-write:${position}:${bytes.byteLength}`)
      if (options.delayWrites) await new Promise((resolvePromise) => setImmediate(resolvePromise))
      extent = Math.max(extent, position + bytes.byteLength)
      events.push(`sink-write-complete:${position}:${bytes.byteLength}`)
      return { written: bytes.byteLength, extent }
    },
    async commitWebmAssembly(_jobId, _generation, _sinkId, requestedExtent) {
      events.push(`sink-commit:${requestedExtent}`)
      assert.equal(requestedExtent, extent)
      return { size: extent, sha256: 'f'.repeat(64) }
    },
    async confirmWebmAssembly() {
      events.push('sink-confirm')
      return (options.confirmAcknowledgement ?? true) as never
    },
    async abortWebmAssembly() {
      events.push('sink-abort')
      return (options.abortAcknowledgement ?? true) as never
    },
  }
}

function successfulSpawn(
  harness: ProcessHarness,
  events: string[] = [],
  plan: WorldWebmStartPayload = PLAN,
): WorldFfmpegSpawn {
  return (file, args, options) => {
    events.push('spawn')
    assert.equal(file, RUNTIME.executablePath)
    assert.deepEqual(args, createWorldFfmpegArguments(plan))
    assert.equal(options.cwd, RUNTIME.rootPath)
    assert.equal(options.shell, false)
    assert.equal(options.detached, false)
    assert.equal(options.windowsHide, true)
    assert.deepEqual(options.stdio, [
      ...Array.from({ length: plan.frameCount > 1 ? 5 : 4 }, () => 'pipe' as const),
      71,
    ])
    assert.equal('PATH' in options.env || 'Path' in options.env, false)
    for (const name of [
      'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'FFREPORT',
      'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'WINDIR',
    ]) {
      assert.equal(name in options.env, false)
    }
    void Promise.all(harness.inputStreams.map((stream) => once(stream, 'finish')))
      .then(() => { events.push('inputs-finished'); harness.finish() })
    harness.child.once('close', () => { events.push('process-close') })
    return harness.child
  }
}

async function writeSignedLinuxBundle(resourcesPath: string): Promise<{
  executablePath: string
  libraryPath: string
}> {
  const root = join(resourcesPath, 'ffmpeg', 'linux-x64')
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  const executablePath = join(bin, 'ffmpeg')
  const libraryPath = join(bin, 'libavcodec.so.61')
  const licensePath = join(root, 'LICENSE.txt')
  const executable = Buffer.from('audited fake executable')
  const library = Buffer.from('audited fake library')
  const license = Buffer.from('Audited fake LGPL-2.1-or-later license text.\n')
  await Promise.all([
    writeFile(executablePath, executable),
    writeFile(libraryPath, library),
    writeFile(licensePath, license),
  ])
  await Promise.all([
    chmod(join(resourcesPath, 'ffmpeg'), 0o755),
    chmod(root, 0o755),
    chmod(bin, 0o755),
    chmod(executablePath, 0o755),
    chmod(libraryPath, 0o644),
    chmod(licensePath, 0o644),
  ])
  const manifest = {
    schema: WORLD_FFMPEG_RUNTIME_SCHEMA,
    target: 'linux-x64',
    ffmpegVersion: '7.1.1',
    signingKeyId,
    build: {
      license: 'LGPL-2.1-or-later', linkage: 'shared', gpl: false, nonfree: false, version3: false,
      videoEncoders: ['libvpx-vp9'], audioEncoders: ['libopus'],
      decoders: ['pcm_s16le', 'png'], demuxers: ['image2pipe', 's16le'],
      filters: ['aformat', 'anull', 'aresample', 'atrim', 'crop', 'format', 'hflip', 'interleave', 'null', 'rotate', 'scale', 'setpts', 'settb', 'transpose', 'trim', 'vflip', 'abuffer', 'buffer', 'abuffersink', 'buffersink'],
      muxers: ['webm'], parsers: ['png'], protocols: ['fd', 'pipe'],
    },
    directories: [{ path: '.', mode: 0o755 }, { path: 'bin', mode: 0o755 }],
    license: {
      path: 'LICENSE.txt', size: license.byteLength,
      sha256: createHash('sha256').update(license).digest('hex'), mode: 0o644,
    },
    executable: {
      path: 'bin/ffmpeg', size: executable.byteLength,
      sha256: createHash('sha256').update(executable).digest('hex'), mode: 0o755,
    },
    sharedLibraries: [{
      path: 'bin/libavcodec.so.61', size: library.byteLength,
      sha256: createHash('sha256').update(library).digest('hex'), mode: 0o644,
    }],
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  await writeFile(join(root, 'manifest.json'), manifestBytes)
  await writeFile(join(root, 'manifest.sig'), sign(null, manifestBytes, signingKeys.privateKey))
  await chmod(join(root, 'manifest.json'), 0o644)
  await chmod(join(root, 'manifest.sig'), 0o644)
  return { executablePath, libraryPath }
}

test('uses canonical path-free argv and concurrently drains all inputs before descriptor commit', async () => {
  const events: string[] = []
  const harness = processHarness()
  const result = await assembleWorldWebmWithFfmpeg({
    runtime: RUNTIME,
    acquireRuntimeLease: (runtime) => acquireTestRuntimeLease(runtime, events),
    plan: PLAN,
    jobId: JOB_ID,
    generation: GENERATION,
    authority: authority(events, { delayWrites: true }),
    spawnProcess: successfulSpawn(harness, events),
    signal: new AbortController().signal,
    environment: {
      PATH: '/attacker', LD_LIBRARY_PATH: '/attacker', FFREPORT: 'file=/workspace/leak',
      TEMP: '/workspace/temp', TMP: '/workspace/tmp', TMPDIR: '/workspace/tmpdir',
      SystemRoot: '/workspace/system-root', WINDIR: '/workspace/windows',
    },
  })

  assert.deepEqual(result, { ok: true, size: WEBM.byteLength, sha256: 'f'.repeat(64) })
  assert.equal(Buffer.concat(harness.video).subarray(0, 4).toString('hex'), '89504e47')
  assert.equal(Buffer.concat(harness.video).byteLength, 27)
  assert.equal(Buffer.concat(harness.nominalVideo).byteLength, 18)
  assert.equal(Buffer.concat(harness.finalVideo).byteLength, 9)
  assert.equal(Buffer.concat(harness.audio).byteLength, PLAN.audioSampleCount * 4)
  assert.equal(events.indexOf('output-lease-acquire') + 1, events.indexOf('spawn'))
  assert.ok(events.indexOf('inputs-finished') < events.indexOf(`sink-commit:${WEBM.byteLength}`))
  assert.ok(events.indexOf('process-close') < events.indexOf(`sink-commit:${WEBM.byteLength}`))
  assert.ok(events.indexOf('process-close') < events.indexOf('lease-release'))
  assert.ok(events.indexOf('process-close') < events.indexOf('output-lease-release'))
  assert.ok(events.indexOf('lease-release') < events.indexOf(`sink-commit:${WEBM.byteLength}`))
  assert.ok(events.indexOf('output-lease-release') < events.indexOf(`sink-commit:${WEBM.byteLength}`))
  assert.deepEqual(events.slice(-2), [`sink-commit:${WEBM.byteLength}`, 'sink-confirm'])
  assert.equal(events.includes('sink-abort'), false)
  assert.equal(createWorldFfmpegArguments(PLAN).some((argument) => argument.includes('/workspace')), false)
  assert.deepEqual(createWorldFfmpegArguments(PLAN).filter((argument) => argument.startsWith('pipe:')),
    ['pipe:2', 'pipe:0', 'pipe:3', 'pipe:4'])
  assert.equal(createWorldFfmpegArguments(PLAN).includes('-shortest'), false)
  assert.equal(createWorldFfmpegArguments(PLAN).includes('-t'), false)
  assert.deepEqual(createWorldFfmpegArguments(PLAN).slice(-7), [
    '-f', 'webm', '-fd', '5', '-blocksize', '8388608', 'fd:',
  ])
})

test('feeds a one-frame sub-frame render and PCM endpoint through three pipes plus the output fd', async () => {
  const single: WorldWebmStartPayload = {
    ...PLAN,
    frameCount: 1,
    duration: { numerator: 1, denominator: 100 },
    frameDurations: [{ numerator: 1, denominator: 100 }],
    audioSampleCount: 480,
  }
  const harness = processHarness(single)
  const result = await assembleWorldWebmWithFfmpeg({
    runtime: RUNTIME,
    acquireRuntimeLease: acquireTestRuntimeLease,
    plan: single,
    jobId: JOB_ID,
    generation: GENERATION,
    authority: authority(),
    spawnProcess: successfulSpawn(harness, [], single),
    signal: new AbortController().signal,
  })

  assert.deepEqual(result, { ok: true, size: WEBM.byteLength, sha256: 'f'.repeat(64) })
  assert.equal(Buffer.concat(harness.nominalVideo).byteLength, 0)
  assert.equal(Buffer.concat(harness.finalVideo).byteLength, 9)
  assert.equal(Buffer.concat(harness.audio).byteLength, 480 * 4)
})

test('feeds 1.01 seconds at 30 fps as 30 nominal PNGs, one 10 ms PNG, and exact PCM', async () => {
  const harness = processHarness(NON_ALIGNED_PLAN)
  const result = await assembleWorldWebmWithFfmpeg({
    runtime: RUNTIME,
    acquireRuntimeLease: acquireTestRuntimeLease,
    plan: NON_ALIGNED_PLAN,
    jobId: JOB_ID,
    generation: GENERATION,
    authority: authority(),
    spawnProcess: successfulSpawn(harness, [], NON_ALIGNED_PLAN),
    signal: new AbortController().signal,
  })

  assert.deepEqual(result, { ok: true, size: WEBM.byteLength, sha256: 'f'.repeat(64) })
  assert.equal(Buffer.concat(harness.nominalVideo).byteLength, 30 * 9)
  assert.equal(Buffer.concat(harness.finalVideo).byteLength, 9)
  assert.equal(Buffer.concat(harness.audio).byteLength, 48_480 * 4)
})

test('false repository confirm or abort acknowledgements cannot report FFmpeg success or preserve another failure', async (t) => {
  await t.test('confirm', async () => {
    const events: string[] = []
    const harness = processHarness()
    const result = await assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: authority(events, { confirmAcknowledgement: false }),
      spawnProcess: successfulSpawn(harness), signal: new AbortController().signal,
    })
    assert.deepEqual(result, { ok: false, code: 'sink-failed' })
    assert.deepEqual(events.slice(-3), [`sink-commit:${WEBM.byteLength}`, 'sink-confirm', 'sink-abort'])
  })

  await t.test('abort', async () => {
    const events: string[] = []
    const harness = processHarness()
    const spawnProcess: WorldFfmpegSpawn = () => {
      void Promise.all(harness.inputStreams.map((stream) => once(stream, 'finish')))
        .then(() => harness.finish(7))
      return harness.child
    }
    const result = await assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: authority(events, { abortAcknowledgement: false }),
      spawnProcess, signal: new AbortController().signal,
    })
    assert.deepEqual(result, { ok: false, code: 'sink-failed' })
    assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
  })
})

test('requires zero exit and exact terminal progress before commit', async (t) => {
  for (const [label, code, progress] of [
    ['nonzero exit', 7, 'frame=3\nout_time_us=100000\ntotal_size=8\nprogress=end\n'],
    ['missing terminal progress', 0, 'frame=3\nout_time_us=100000\ntotal_size=8\nprogress=continue\n'],
    ['incomplete frames', 0, 'frame=2\nout_time_us=100000\ntotal_size=8\nprogress=end\n'],
    ['terminal before later fields', 0, 'frame=3\nout_time_us=100000\ntotal_size=8\nprogress=end\nspeed=1x\n'],
    ['unexpected duration', 0, 'frame=3\nout_time_us=300000\ntotal_size=8\nprogress=end\n'],
    ['unexpected extent', 0, 'frame=3\nout_time_us=100000\ntotal_size=7\nprogress=end\n'],
    ['zero extent', 0, 'frame=3\nout_time_us=100000\ntotal_size=0\nprogress=end\n'],
    ['oversize extent', 0, `frame=3\nout_time_us=100000\ntotal_size=${WORLD_WEBM_MAX_OUTPUT_BYTES + 1}\nprogress=end\n`],
    ['regressing record', 0, 'frame=2\nout_time_us=90000\ntotal_size=4\nprogress=continue\nframe=1\nout_time_us=100000\ntotal_size=8\nprogress=end\n'],
    ['diagnostics overflow', 0, 'x'.repeat(256 * 1024 + 1)],
  ] as const) {
    await t.test(label, async () => {
      const events: string[] = []
      const harness = processHarness()
      const spawnProcess: WorldFfmpegSpawn = () => {
        void Promise.all(harness.inputStreams.map((stream) => once(stream, 'finish')))
          .then(() => harness.finish(code, progress))
        return harness.child
      }
      const result = await assembleWorldWebmWithFfmpeg({
        runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
        plan: PLAN, jobId: JOB_ID, generation: GENERATION,
        authority: authority(events), spawnProcess, signal: new AbortController().signal,
      })
      assert.equal(result.ok, false)
      assert.deepEqual(events.filter((event) => event.startsWith('sink-')), [
        'sink-begin', 'sink-abort',
      ])
    })
  }
})

test('unexpected stdout bytes and output-descriptor release failure abort without commit', async (t) => {
  await t.test('stdout bytes', async () => {
    const events: string[] = []
    const harness = processHarness()
    const spawnProcess: WorldFfmpegSpawn = () => {
      void Promise.all(harness.inputStreams.map((stream) => once(stream, 'finish'))).then(() => {
        ;(harness.child.stdout as PassThrough).write(WEBM)
        harness.finish()
      })
      return harness.child
    }
    const result = await assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: authority(events), spawnProcess, signal: new AbortController().signal,
    })
    assert.deepEqual(result, { ok: false, code: 'process-failed' })
    assert.equal(events.some((event) => event.startsWith('sink-commit')), false)
    assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
  })

  await t.test('descriptor release', async () => {
    const events: string[] = []
    const harness = processHarness()
    const sinkAuthority = authority(events)
    const rejectedRelease = Promise.reject(new Error('descriptor identity changed'))
    void rejectedRelease.catch(() => undefined)
    sinkAuthority.acquireWebmFileOutputLease = () => ({ fd: 71, release: () => rejectedRelease })
    const result = await assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: sinkAuthority, spawnProcess: successfulSpawn(harness),
      signal: new AbortController().signal,
    })
    assert.deepEqual(result, { ok: false, code: 'sink-failed' })
    assert.equal(events.some((event) => event.startsWith('sink-commit')), false)
    assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
  })
})

test('missing or invalid repository output descriptors fail closed before spawn', async (t) => {
  for (const [label, mutate] of [
    ['missing lease API', (candidate: Record<string, unknown>) => { delete candidate.acquireWebmFileOutputLease }],
    ['stdio descriptor', (candidate: Record<string, unknown>) => {
      candidate.acquireWebmFileOutputLease = () => ({ fd: 2, release: async () => ({ extent: 0 }) })
    }],
  ] as const) {
    await t.test(label, async () => {
      const events: string[] = []
      const sinkAuthority = authority(events) as unknown as Record<string, unknown>
      mutate(sinkAuthority)
      let spawns = 0
      const result = await assembleWorldWebmWithFfmpeg({
        runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
        plan: PLAN, jobId: JOB_ID, generation: GENERATION,
        authority: sinkAuthority as unknown as WorldFfmpegWebmAuthority,
        spawnProcess: () => { spawns += 1; return processHarness().child },
        signal: new AbortController().signal,
      })
      assert.deepEqual(result, { ok: false, code: 'sink-failed' })
      assert.equal(spawns, 0)
      assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
    })
  }
})

test('incremental progress accepts more than 256 KiB of valid continue history without lifetime buffering', async () => {
  const events: string[] = []
  const harness = processHarness()
  const history = 'frame=0\nout_time_us=0\ntotal_size=0\nprogress=continue\n'.repeat(6_000)
  const spawnProcess: WorldFfmpegSpawn = () => {
    void Promise.all(harness.inputStreams.map((stream) => once(stream, 'finish')))
      .then(() => harness.finish(0, `${history}frame=3\nout_time_us=100000\ntotal_size=8\nprogress=end\n`))
    return harness.child
  }
  const result = await assembleWorldWebmWithFfmpeg({
    runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
    plan: PLAN, jobId: JOB_ID, generation: GENERATION,
    authority: authority(events), spawnProcess, signal: new AbortController().signal,
  })
  assert.deepEqual(result, { ok: true, size: WEBM.byteLength, sha256: 'f'.repeat(64) })
  assert.deepEqual(events.slice(-2), [`sink-commit:${WEBM.byteLength}`, 'sink-confirm'])
})

test('inactivity, hard timeout, and cancellation terminate, force-kill, await close, and abort once', async (t) => {
  for (const kind of ['hard-timeout', 'inactivity', 'cancel'] as const) {
    await t.test(kind, async () => {
      const events: string[] = []
      const harness = processHarness()
      const emitter = harness.child as unknown as EventEmitter
      const originalKill = harness.child.kill.bind(harness.child)
      harness.child.kill = ((signal = 'SIGTERM') => {
        const killed = originalKill(signal)
        if (signal === 'SIGKILL') {
          harness.child.stdin.destroy()
          for (const stream of harness.inputStreams) stream.destroy()
          harness.child.stdout.destroy()
          harness.child.stderr.destroy()
          setImmediate(() => { events.push('closed'); emitter.emit('close', null, 'SIGKILL') })
        }
        return killed
      }) as WorldFfmpegProcess['kill']
      const controller = new AbortController()
      if (kind === 'cancel') setTimeout(() => controller.abort(), 10)
      const resultPromise = assembleWorldWebmWithFfmpeg({
        runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
        plan: PLAN, jobId: JOB_ID, generation: GENERATION,
        authority: authority(events), spawnProcess: () => harness.child, signal: controller.signal,
        timeouts: {
          inactivityMs: kind === 'inactivity' ? 15 : 1_000,
          hardMs: kind === 'hard-timeout' ? 15 : 1_000,
          killGraceMs: 10,
        },
      })
      if (kind === 'cancel') {
        await assert.rejects(resultPromise, (error: unknown) => error instanceof Error && error.name === 'AbortError')
      } else {
        const result = await resultPromise
        assert.deepEqual(result, { ok: false, code: 'timeout' })
      }
      assert.deepEqual(harness.kills, ['SIGTERM', 'SIGKILL'])
      assert.ok(events.indexOf('closed') < events.indexOf('sink-abort'))
      assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
      assert.equal(events.some((event) => event.startsWith('sink-commit')), false)
    })
  }
})

test('a child that misses the close deadline returns bounded but retains exact late native custody until close', async () => {
  const events: string[] = []
  const harness = processHarness()
  const emitter = harness.child as unknown as EventEmitter
  let leaseReleases = 0
  const lease: WorldFfmpegExecutionLease = {
    runtime: RUNTIME,
    spawn: (spawnProcess, args, options) => spawnProcess(RUNTIME.executablePath, args, options),
    release: async () => { leaseReleases += 1 },
  }
  const outcome = await Promise.race([
    assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: async () => lease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: authority(events), spawnProcess: () => harness.child,
      signal: new AbortController().signal,
      timeouts: { inactivityMs: 1_000, hardMs: 15, killGraceMs: 10, closeWaitMs: 10, taskWaitMs: 10 },
    }),
    new Promise<'test-timeout'>((resolvePromise) => setTimeout(() => resolvePromise('test-timeout'), 250)),
  ])
  assert.notEqual(outcome, 'test-timeout')
  assert.deepEqual(outcome, { ok: false, code: 'timeout' })
  assert.deepEqual(harness.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(harness.unrefs.count, 1)
  assert.equal(leaseReleases, 0, 'the verified runtime lease remains owned until native close')
  assert.equal(events.includes('output-lease-release'), false)
  assert.equal(emitter.listenerCount('error'), 1)
  assert.equal(emitter.listenerCount('close'), 1)
  assert.equal(events.filter((event) => event === 'sink-abort').length, 1)

  emitter.emit('close', null, 'SIGKILL')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(leaseReleases, 1)
  assert.equal(events.filter((event) => event === 'output-lease-release').length, 1)
  assert.equal(emitter.listenerCount('error'), 1)
  assert.equal(emitter.listenerCount('close'), 0)
  emitter.emit('close', null, 'SIGKILL')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(leaseReleases, 1, 'late lifecycle cleanup is idempotent')
})

test('a permanently no-close child is unrefed while both descriptor and runtime leases stay owned', async () => {
  const events: string[] = []
  const harness = processHarness()
  const emitter = harness.child as unknown as EventEmitter
  let leaseReleases = 0
  const lease: WorldFfmpegExecutionLease = {
    runtime: RUNTIME,
    spawn: (spawnProcess, args, options) => spawnProcess(RUNTIME.executablePath, args, options),
    release: async () => { leaseReleases += 1 },
  }
  const outcome = await Promise.race([
    assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: async () => lease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: authority(events), spawnProcess: () => harness.child,
      signal: new AbortController().signal,
      timeouts: { inactivityMs: 1_000, hardMs: 15, killGraceMs: 10, closeWaitMs: 10, taskWaitMs: 10 },
    }),
    new Promise<'test-timeout'>((resolvePromise) => setTimeout(() => resolvePromise('test-timeout'), 250)),
  ])
  assert.deepEqual(outcome, { ok: false, code: 'timeout' })
  assert.equal(harness.unrefs.count, 1)
  assert.equal(leaseReleases, 0)
  assert.equal(events.includes('output-lease-release'), false)
  assert.equal(harness.child.stdin.destroyed, true)
  assert.equal(harness.child.stdout.destroyed, true)
  assert.equal(harness.child.stderr.destroyed, true)
  assert.equal(harness.inputStreams.every((stream) => stream.destroyed), true)
  assert.equal(emitter.listenerCount('error'), 1)
  assert.equal(emitter.listenerCount('close'), 1)
})

test('successful close releases native custody once while a terminal error sink consumes late errors', async () => {
  const events: string[] = []
  const harness = processHarness()
  const emitter = harness.child as unknown as EventEmitter
  let leaseReleases = 0
  const lease: WorldFfmpegExecutionLease = {
    runtime: RUNTIME,
    spawn: (spawnProcess, args, options) => spawnProcess(RUNTIME.executablePath, args, options),
    release: async () => { leaseReleases += 1 },
  }
  const result = await assembleWorldWebmWithFfmpeg({
    runtime: RUNTIME,
    acquireRuntimeLease: async () => lease,
    plan: PLAN,
    jobId: JOB_ID,
    generation: GENERATION,
    authority: authority(events),
    spawnProcess: successfulSpawn(harness, events),
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, { ok: true, size: WEBM.byteLength, sha256: 'f'.repeat(64) })
  assert.equal(leaseReleases, 1)
  assert.equal(events.filter((event) => event === 'output-lease-release').length, 1)
  assert.equal(emitter.listenerCount('close'), 0)
  assert.equal(emitter.listenerCount('error'), 1)

  assert.doesNotThrow(() => emitter.emit('error', new Error('late post-close error')))
  assert.doesNotThrow(() => emitter.emit('error', new Error('repeated post-close error')))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(leaseReleases, 1)
  assert.equal(events.filter((event) => event === 'output-lease-release').length, 1)
  assert.equal(emitter.listenerCount('error'), 1)
})

test('generic child errors retain no-close custody until exact close and consume repeated failures', async () => {
  const events: string[] = []
  const harness = processHarness()
  const emitter = harness.child as unknown as EventEmitter
  let leaseReleases = 0
  const lease: WorldFfmpegExecutionLease = {
    runtime: RUNTIME,
    spawn: (spawnProcess, args, options) => spawnProcess(RUNTIME.executablePath, args, options),
    release: async () => { leaseReleases += 1; throw new Error('late release failed') },
  }
  const outcome = await assembleWorldWebmWithFfmpeg({
    runtime: RUNTIME, acquireRuntimeLease: async () => lease,
    plan: PLAN, jobId: JOB_ID, generation: GENERATION,
    authority: authority(events), spawnProcess: () => harness.child,
    signal: new AbortController().signal,
    timeouts: { inactivityMs: 1_000, hardMs: 15, killGraceMs: 10, closeWaitMs: 10, taskWaitMs: 10 },
  })
  assert.deepEqual(outcome, { ok: false, code: 'timeout' })
  assert.equal(emitter.listenerCount('error'), 1)
  assert.equal(emitter.listenerCount('close'), 1)
  emitter.emit('error', new Error('late signal-delivery failure'))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(leaseReleases, 0)
  assert.equal(events.filter((event) => event === 'output-lease-release').length, 0)
  assert.equal(emitter.listenerCount('error'), 1)
  assert.equal(emitter.listenerCount('close'), 1)
  emitter.emit('error', new Error('repeated late child error'))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(leaseReleases, 0)
  assert.equal(events.filter((event) => event === 'output-lease-release').length, 0)
  emitter.emit('close', null, 'SIGKILL')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(leaseReleases, 1)
  assert.equal(events.filter((event) => event === 'output-lease-release').length, 1)
  assert.equal(emitter.listenerCount('error'), 1)
  assert.equal(emitter.listenerCount('close'), 0)
  assert.doesNotThrow(() => emitter.emit('error', new Error('post-close error')))
  assert.doesNotThrow(() => emitter.emit('error', new Error('repeated post-close error')))
  emitter.emit('close', null, 'SIGKILL')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(leaseReleases, 1)
  assert.equal(events.filter((event) => event === 'output-lease-release').length, 1)
})

test('a kill-delivery error cannot release a running child\'s native custody without close', async () => {
  const events: string[] = []
  const harness = processHarness()
  const emitter = harness.child as unknown as EventEmitter
  const originalKill = harness.child.kill.bind(harness.child)
  let leaseReleases = 0
  const lease: WorldFfmpegExecutionLease = {
    runtime: RUNTIME,
    spawn: (spawnProcess, args, options) => spawnProcess(RUNTIME.executablePath, args, options),
    release: async () => { leaseReleases += 1 },
  }
  harness.child.kill = ((signal = 'SIGTERM') => {
    const result = originalKill(signal)
    if (signal === 'SIGTERM') {
      setImmediate(() => emitter.emit('error', new Error('kill ESRCH')))
    }
    return result
  }) as WorldFfmpegProcess['kill']
  const outcome = await Promise.race([
    assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: async () => lease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: authority(events), spawnProcess: () => harness.child,
      signal: new AbortController().signal,
      timeouts: { inactivityMs: 1_000, hardMs: 15, killGraceMs: 10, closeWaitMs: 10, taskWaitMs: 10 },
    }),
    new Promise<'test-timeout'>((resolvePromise) => setTimeout(() => resolvePromise('test-timeout'), 250)),
  ])
  assert.deepEqual(outcome, { ok: false, code: 'timeout' })
  assert.deepEqual(harness.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(leaseReleases, 0)
  assert.equal(events.includes('output-lease-release'), false)
  assert.equal(emitter.listenerCount('error'), 1)
  assert.equal(emitter.listenerCount('close'), 1)

  emitter.emit('error', new Error('late repeated kill error'))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(leaseReleases, 0)
  assert.equal(events.includes('output-lease-release'), false)
  emitter.emit('close', null, 'SIGKILL')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(leaseReleases, 1)
  assert.equal(events.filter((event) => event === 'output-lease-release').length, 1)
  assert.equal(emitter.listenerCount('error'), 1)
  assert.doesNotThrow(() => emitter.emit('error', new Error('post-close kill error')))
  assert.equal(leaseReleases, 1)
})

test('an output descriptor release that never resolves after child close is independently bounded and retained', async () => {
  const events: string[] = []
  const harness = processHarness()
  const sinkAuthority = authority(events)
  const lateRelease = deferred<{ readonly extent: number }>()
  const exactRelease = lateRelease.promise
  sinkAuthority.acquireWebmFileOutputLease = () => ({ fd: 71, release: () => exactRelease })
  const spawnProcess: WorldFfmpegSpawn = () => {
    void Promise.all(harness.inputStreams.map((stream) => once(stream, 'finish')))
      .then(() => harness.finish())
    return harness.child
  }
  const outcome = await Promise.race([
    assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: sinkAuthority, spawnProcess, signal: new AbortController().signal,
      timeouts: { inactivityMs: 1_000, hardMs: 1_000, killGraceMs: 10, closeWaitMs: 10, taskWaitMs: 10 },
    }),
    new Promise<'test-timeout'>((resolvePromise) => setTimeout(() => resolvePromise('test-timeout'), 250)),
  ])
  assert.notEqual(outcome, 'test-timeout')
  assert.deepEqual(outcome, { ok: false, code: 'timeout' })
  assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
  lateRelease.resolve({ extent: WEBM.byteLength })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
})

test('input backpressure that never drains is bounded and removes stream listeners', async () => {
  const events: string[] = []
  const harness = processHarness()
  const blockedInput = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) { /* deliberately never settles */ },
  })
  ;(harness.child as unknown as { stdin: Writable }).stdin = blockedInput
  ;(harness.child.stdio as unknown as [Writable, PassThrough, PassThrough, Writable])[0] = blockedInput
  const emitter = harness.child as unknown as EventEmitter
  const originalKill = harness.child.kill.bind(harness.child)
  harness.child.kill = ((signal = 'SIGTERM') => {
    const killed = originalKill(signal)
    if (signal === 'SIGKILL') setImmediate(() => emitter.emit('close', null, 'SIGKILL'))
    return killed
  }) as WorldFfmpegProcess['kill']
  const outcome = await Promise.race([
    assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: authority(events), spawnProcess: () => harness.child,
      signal: new AbortController().signal,
      timeouts: { inactivityMs: 15, hardMs: 1_000, killGraceMs: 10, closeWaitMs: 10, taskWaitMs: 10 },
    }),
    new Promise<'test-timeout'>((resolvePromise) => setTimeout(() => resolvePromise('test-timeout'), 250)),
  ])
  assert.notEqual(outcome, 'test-timeout')
  assert.deepEqual(outcome, { ok: false, code: 'timeout' })
  assert.equal(blockedInput.listenerCount('error'), 0)
  assert.equal(blockedInput.listenerCount('drain'), 0)
  assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
})

test('simultaneous cancellation and hard timeout settle once with only a terminal error sink', async () => {
  const events: string[] = []
  const harness = processHarness()
  const emitter = harness.child as unknown as EventEmitter
  harness.child.kill = ((signal = 'SIGTERM') => {
    harness.kills.push(String(signal))
    if (signal === 'SIGKILL') setImmediate(() => emitter.emit('close', null, 'SIGKILL'))
    return true
  }) as WorldFfmpegProcess['kill']
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 15)
  await assert.rejects(assembleWorldWebmWithFfmpeg({
    runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
    plan: PLAN, jobId: JOB_ID, generation: GENERATION,
    authority: authority(events), spawnProcess: () => harness.child, signal: controller.signal,
    timeouts: { inactivityMs: 1_000, hardMs: 15, killGraceMs: 10, closeWaitMs: 10, taskWaitMs: 10 },
  }), (error: unknown) => error instanceof Error && error.name === 'AbortError')
  assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
  assert.equal(emitter.listenerCount('error'), 1)
  assert.equal(emitter.listenerCount('close'), 0)
})

test('repository and runtime lease phases have independent owned deadlines', async (t) => {
  const timeouts = { inactivityMs: 1_000, hardMs: 1_000, killGraceMs: 10, closeWaitMs: 10, taskWaitMs: 10 }

  await t.test('sink begin never settles', async () => {
    const events: string[] = []
    const sinkAuthority = authority(events)
    sinkAuthority.beginWebmAssembly = async () => new Promise<never>(() => undefined)
    const result = await settleWithin(assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: sinkAuthority, spawnProcess: () => { throw new Error('must not spawn') },
      signal: new AbortController().signal, timeouts,
    }))
    assert.deepEqual(result, { ok: false, code: 'sink-failed' })
    assert.deepEqual(events, [])
  })

  await t.test('lease acquisition never settles', async () => {
    const events: string[] = []
    const result = await settleWithin(assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: async () => new Promise<never>(() => undefined),
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: authority(events), spawnProcess: () => { throw new Error('must not spawn') },
      signal: new AbortController().signal, timeouts,
    }))
    assert.deepEqual(result, { ok: false, code: 'timeout' })
    assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
  })

  await t.test('lease release never settles', async () => {
    const events: string[] = []
    const harness = processHarness()
    const lease: WorldFfmpegExecutionLease = {
      runtime: RUNTIME,
      spawn: (spawnProcess, args, options) => spawnProcess(RUNTIME.executablePath, args, options),
      release: async () => new Promise<never>(() => undefined),
    }
    const result = await settleWithin(assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: async () => lease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: authority(events), spawnProcess: successfulSpawn(harness),
      signal: new AbortController().signal, timeouts,
    }))
    assert.deepEqual(result, { ok: false, code: 'timeout' })
    assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
    assert.equal(events.some((event) => event.startsWith('sink-commit')), false)
  })

  for (const phase of ['commit', 'confirm'] as const) {
    await t.test(`${phase} never settles`, async () => {
      const events: string[] = []
      const harness = processHarness()
      const sinkAuthority = authority(events)
      if (phase === 'commit') {
        sinkAuthority.commitWebmAssembly = async () => new Promise<never>(() => undefined)
      } else {
        sinkAuthority.confirmWebmAssembly = async () => new Promise<never>(() => undefined)
      }
      const result = await settleWithin(assembleWorldWebmWithFfmpeg({
        runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
        plan: PLAN, jobId: JOB_ID, generation: GENERATION,
        authority: sinkAuthority, spawnProcess: successfulSpawn(harness),
        signal: new AbortController().signal, timeouts,
      }))
      assert.deepEqual(result, { ok: false, code: 'sink-failed' })
      assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
    })
  }

  await t.test('abort never settles', async () => {
    const events: string[] = []
    const harness = processHarness()
    const sinkAuthority = authority(events)
    sinkAuthority.abortWebmAssembly = async () => {
      events.push('sink-abort')
      return new Promise<never>(() => undefined)
    }
    const spawnProcess: WorldFfmpegSpawn = () => {
      void Promise.all(harness.inputStreams.map((stream) => once(stream, 'finish')))
        .then(() => harness.finish(7))
      return harness.child
    }
    const result = await settleWithin(assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: sinkAuthority, spawnProcess, signal: new AbortController().signal, timeouts,
    }))
    assert.deepEqual(result, { ok: false, code: 'sink-failed' })
    assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
  })
})

test('production custody deadlines are phase-specific, workload-scaled, and exactly bounded', () => {
  const ordinary = calculateWorldFfmpegTimeouts(PLAN, WEBM.byteLength)
  assert.ok(ordinary.sinkBeginMs > 2_100)
  assert.ok(ordinary.commitMs > 2_100)
  assert.ok(ordinary.confirmMs > 2_100)
  assert.ok(ordinary.abortMs > 2_100)
  assert.notEqual(ordinary.runtimeLeaseAcquireMs, ordinary.runtimeLeaseReleaseMs)
  assert.ok(ordinary.taskDrainMs >= ordinary.runtimeLeaseReleaseMs)
  assert.ok(ordinary.inactivityMs < ordinary.hardMs)

  const maximumPlan: WorldWebmStartPayload = {
    width: 7_680,
    height: 4_320,
    fps: 60,
    frameCount: WORLD_WEBM_MAX_FRAME_COUNT,
    duration: { numerator: 900, denominator: 1 },
    frameDurations: Array.from({ length: WORLD_WEBM_MAX_FRAME_COUNT }, () => ({ numerator: 1, denominator: 60 })),
    audioSampleCount: WORLD_WEBM_MAX_AUDIO_SAMPLES,
    videoBitrate: 80_000_000,
    audioBitrate: 128_000,
  }
  const maximum = calculateWorldFfmpegTimeouts(maximumPlan, WORLD_WEBM_MAX_OUTPUT_BYTES)
  assert.ok(Number.isSafeInteger(maximum.commitMs))
  assert.ok(maximum.commitMs > maximum.confirmMs)
  assert.ok(maximum.confirmMs > maximum.sinkBeginMs)
  assert.ok(maximum.sinkBeginMs > maximum.abortMs)
  assert.ok(maximum.abortMs >= 8_202_000, '64 GiB cleanup must cover the declared conservative I/O floor')
  assert.equal(maximum.cancellationCleanupMs, 30_000)
  assert.throws(
    () => calculateWorldFfmpegTimeouts(maximumPlan, WORLD_WEBM_MAX_OUTPUT_BYTES + 1),
    /output byte bound/i,
  )
})

test('canonical FFmpeg argv assigns the final PNG its exact rational duration and VFR timestamp', () => {
  const args = createWorldFfmpegArguments(NON_ALIGNED_PLAN)

  assert.deepEqual(args.filter((argument) => argument.startsWith('pipe:')),
    ['pipe:2', 'pipe:0', 'pipe:3', 'pipe:4'])
  assert.deepEqual(valuesAfter(args, '-framerate'), ['30', '100/1'])
  assert.deepEqual(valuesAfter(args, '-itsoffset'), [])
  assert.deepEqual(valuesAfter(args, '-filter_complex'), [
    '[0:v:0]settb=AVTB[nominal];[1:v:0]settb=AVTB,setpts=PTS+1/1/TB[final];'
      + '[nominal][final]interleave=nb_inputs=2:duration=longest[v]',
  ])
  assert.deepEqual(valuesAfter(args, '-map'), ['[v]', '2:a:0'])
  assert.deepEqual(valuesAfter(args, '-fps_mode:v'), ['passthrough'])
  assert.deepEqual(valuesAfter(args, '-enc_time_base:v'), ['filter'])
  assert.equal(args.includes('-shortest'), false)
  assert.equal(args.includes('-t'), false)
})

test('normalizes before assigning an exact final PTS and targets only a seekable inherited fd', () => {
  const args = createWorldFfmpegArguments(EARLY_PARTIAL_PLAN)

  assert.deepEqual(valuesAfter(args, '-framerate'), ['30', '200/3'])
  assert.deepEqual(valuesAfter(args, '-filter_complex'), [
    '[0:v:0]settb=AVTB[nominal];[1:v:0]settb=AVTB,setpts=PTS+1/10/TB[final];'
      + '[nominal][final]interleave=nb_inputs=2:duration=longest[v]',
  ])
  assert.equal(args.includes('-itsoffset'), false)
  assert.deepEqual(valuesAfter(args, '-fd'), ['5'])
  assert.deepEqual(valuesAfter(args, '-blocksize'), ['8388608'])
  assert.deepEqual(valuesAfter(args, '-fs'), [String(WORLD_WEBM_MAX_OUTPUT_BYTES)])
  assert.equal(args.at(-1), 'fd:')
  assert.equal(args.includes('pipe:1'), false)
})

test('single-frame and aligned plans keep exact path-free descriptor contracts', () => {
  const single: WorldWebmStartPayload = {
    ...PLAN,
    frameCount: 1,
    duration: { numerator: 1, denominator: 100 },
    frameDurations: [{ numerator: 1, denominator: 100 }],
    audioSampleCount: 480,
  }
  const singleArgs = createWorldFfmpegArguments(single)
  assert.deepEqual(singleArgs.filter((argument) => argument.startsWith('pipe:')),
    ['pipe:2', 'pipe:0', 'pipe:3'])
  assert.deepEqual(valuesAfter(singleArgs, '-framerate'), ['100/1'])
  assert.deepEqual(valuesAfter(singleArgs, '-map'), ['0:v:0', '1:a:0'])
  assert.equal(singleArgs.includes('-filter_complex'), false)
  assert.equal(singleArgs.includes('-itsoffset'), false)
  assert.deepEqual(valuesAfter(singleArgs, '-fd'), ['4'])
  assert.equal(singleArgs.at(-1), 'fd:')

  const alignedArgs = createWorldFfmpegArguments(PLAN)
  assert.deepEqual(valuesAfter(alignedArgs, '-framerate'), ['30', '30/1'])
  assert.deepEqual(valuesAfter(alignedArgs, '-itsoffset'), [])
  assert.deepEqual(valuesAfter(alignedArgs, '-filter_complex'), [
    '[0:v:0]settb=AVTB[nominal];[1:v:0]settb=AVTB,setpts=PTS+1/15/TB[final];'
      + '[nominal][final]interleave=nb_inputs=2:duration=longest[v]',
  ])
  assert.equal(alignedArgs.some((argument) => argument.includes('/')), true, 'rational rates are not paths')
  assert.equal(alignedArgs.some((argument) => argument.includes('/workspace')), false)

  const twoFrameArgs = createWorldFfmpegArguments({
    ...PLAN,
    frameCount: 2,
    duration: { numerator: 1, denominator: 20 },
    frameDurations: [{ numerator: 1, denominator: 30 }, { numerator: 1, denominator: 60 }],
    audioSampleCount: 2_400,
  })
  assert.deepEqual(valuesAfter(twoFrameArgs, '-framerate'), ['30', '60/1'])
  assert.deepEqual(valuesAfter(twoFrameArgs, '-itsoffset'), [])
  assert.deepEqual(valuesAfter(twoFrameArgs, '-filter_complex'), [
    '[0:v:0]settb=AVTB[nominal];[1:v:0]settb=AVTB,setpts=PTS+1/30/TB[final];'
      + '[nominal][final]interleave=nb_inputs=2:duration=longest[v]',
  ])
})

test('production custody defaults accept a valid 2.1 second commit', { timeout: 5_000 }, async () => {
  const events: string[] = []
  const harness = processHarness()
  const sinkAuthority = authority(events)
  const commit = sinkAuthority.commitWebmAssembly.bind(sinkAuthority)
  sinkAuthority.commitWebmAssembly = async (...args) => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_100))
    return commit(...args)
  }
  const result = await assembleWorldWebmWithFfmpeg({
    runtime: RUNTIME,
    acquireRuntimeLease: acquireTestRuntimeLease,
    plan: PLAN,
    jobId: JOB_ID,
    generation: GENERATION,
    authority: sinkAuthority,
    spawnProcess: successfulSpawn(harness),
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, { ok: true, size: WEBM.byteLength, sha256: 'f'.repeat(64) })
  assert.equal(events.filter((event) => event === 'sink-abort').length, 0)
})

test('workload-scaled custody waits remain immediately cancellable', async () => {
  const events: string[] = []
  const harness = processHarness()
  const sinkAuthority = authority(events)
  let enterCommit!: () => void
  const commitEntered = new Promise<void>((resolvePromise) => { enterCommit = resolvePromise })
  sinkAuthority.commitWebmAssembly = async () => {
    enterCommit()
    return new Promise<never>(() => undefined)
  }
  sinkAuthority.abortWebmAssembly = async () => {
    events.push('sink-abort')
    return new Promise<never>(() => undefined)
  }
  const controller = new AbortController()
  const assembly = assembleWorldWebmWithFfmpeg({
    runtime: RUNTIME,
    acquireRuntimeLease: acquireTestRuntimeLease,
    plan: PLAN,
    jobId: JOB_ID,
    generation: GENERATION,
    authority: sinkAuthority,
    spawnProcess: successfulSpawn(harness),
    signal: controller.signal,
    timeouts: { cancellationCleanupMs: 10 },
  })
  await commitEntered
  controller.abort()
  await assert.rejects(
    settleWithin(assembly),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
})

test('late phase completion remains owned and cannot create an orphan or unhandled rejection', async (t) => {
  const timeouts = { inactivityMs: 1_000, hardMs: 1_000, killGraceMs: 10, closeWaitMs: 10, taskWaitMs: 10 }

  for (const completion of ['success', 'failure'] as const) {
    await t.test(`late sink begin ${completion}`, async () => {
      const events: string[] = []
      const late = deferred<{ sinkId: string }>()
      const sinkAuthority = authority(events)
      sinkAuthority.beginWebmAssembly = () => late.promise
      sinkAuthority.abortWebmAssembly = async () => {
        events.push('sink-abort')
        if (completion === 'failure') throw new Error('late cleanup failed')
        return true
      }
      const result = await settleWithin(assembleWorldWebmWithFfmpeg({
        runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
        plan: PLAN, jobId: JOB_ID, generation: GENERATION,
        authority: sinkAuthority, spawnProcess: () => { throw new Error('must not spawn') },
        signal: new AbortController().signal, timeouts,
      }))
      assert.deepEqual(result, { ok: false, code: 'sink-failed' })
      if (completion === 'success') late.resolve({ sinkId: `sink-${'a'.repeat(32)}` })
      else late.reject(new Error('late begin failed'))
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
      assert.equal(events.filter((event) => event === 'sink-abort').length, completion === 'success' ? 1 : 0)
    })
  }

  await t.test('late lease acquisition releases the exact lease and consumes release failure', async () => {
    const events: string[] = []
    const late = deferred<WorldFfmpegExecutionLease>()
    const result = await settleWithin(assembleWorldWebmWithFfmpeg({
      runtime: RUNTIME, acquireRuntimeLease: () => late.promise,
      plan: PLAN, jobId: JOB_ID, generation: GENERATION,
      authority: authority(events), spawnProcess: () => { throw new Error('must not spawn') },
      signal: new AbortController().signal, timeouts,
    }))
    assert.deepEqual(result, { ok: false, code: 'timeout' })
    late.resolve({
      runtime: RUNTIME,
      spawn: () => { throw new Error('must not spawn') },
      release: async () => { events.push('late-lease-release'); throw new Error('late release failed') },
    })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(events.includes('late-lease-release'), true)
  })

  for (const completion of ['success', 'failure'] as const) {
    await t.test(`late lease release ${completion}`, async () => {
      const events: string[] = []
      const lateRelease = deferred<void>()
      const harness = processHarness()
      const lease: WorldFfmpegExecutionLease = {
        runtime: RUNTIME,
        spawn: (spawnProcess, args, options) => spawnProcess(RUNTIME.executablePath, args, options),
        release: () => { events.push('lease-release'); return lateRelease.promise },
      }
      const result = await settleWithin(assembleWorldWebmWithFfmpeg({
        runtime: RUNTIME, acquireRuntimeLease: async () => lease,
        plan: PLAN, jobId: JOB_ID, generation: GENERATION,
        authority: authority(events), spawnProcess: successfulSpawn(harness),
        signal: new AbortController().signal, timeouts,
      }))
      assert.deepEqual(result, { ok: false, code: 'timeout' })
      if (completion === 'success') lateRelease.resolve(undefined)
      else lateRelease.reject(new Error('late lease release failed'))
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
      assert.equal(events.filter((event) => event === 'lease-release').length, 1)
    })
  }

  for (const completion of ['success', 'failure'] as const) {
    await t.test(`late abort ${completion}`, async () => {
      const events: string[] = []
      const lateAbort = deferred<true>()
      const harness = processHarness()
      const sinkAuthority = authority(events)
      sinkAuthority.abortWebmAssembly = () => { events.push('sink-abort'); return lateAbort.promise }
      const spawnProcess: WorldFfmpegSpawn = () => {
        void Promise.all(harness.inputStreams.map((stream) => once(stream, 'finish')))
          .then(() => harness.finish(7))
        return harness.child
      }
      const result = await settleWithin(assembleWorldWebmWithFfmpeg({
        runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
        plan: PLAN, jobId: JOB_ID, generation: GENERATION,
        authority: sinkAuthority, spawnProcess, signal: new AbortController().signal, timeouts,
      }))
      assert.deepEqual(result, { ok: false, code: 'sink-failed' })
      if (completion === 'success') lateAbort.resolve(true)
      else lateAbort.reject(new Error('late abort failed'))
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
      assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
    })
  }

  for (const phase of ['commit', 'confirm'] as const) {
    for (const completion of ['success', 'failure'] as const) {
      await t.test(`late ${phase} ${completion}`, async () => {
        const events: string[] = []
        const harness = processHarness()
        const sinkAuthority = authority(events)
        const late = deferred<never>()
        if (phase === 'commit') sinkAuthority.commitWebmAssembly = () => late.promise
        else sinkAuthority.confirmWebmAssembly = () => late.promise
        const result = await settleWithin(assembleWorldWebmWithFfmpeg({
          runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
          plan: PLAN, jobId: JOB_ID, generation: GENERATION,
          authority: sinkAuthority, spawnProcess: successfulSpawn(harness),
          signal: new AbortController().signal, timeouts,
        }))
        assert.deepEqual(result, { ok: false, code: 'sink-failed' })
        if (completion === 'success') {
          late.resolve((phase === 'commit'
            ? { size: WEBM.byteLength, sha256: 'f'.repeat(64) }
            : true) as never)
        } else {
          late.reject(new Error(`late ${phase} failure`))
        }
        await new Promise((resolvePromise) => setImmediate(resolvePromise))
        assert.equal(events.filter((event) => event === 'sink-abort').length, 1)
      })
    }
  }
})

test('cancellation during real missing-package resolution rejects before any sink or spawn', async (t) => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-initial-abort-'))
  t.after(() => rm(resourcesPath, { recursive: true, force: true }))
  const events: string[] = []
  let spawns = 0
  const fallback = createPackagedWorldFfmpegFallback({
    resourcesPath, platform: 'linux', arch: 'x64', authority: authority(events),
    spawnProcess: () => { spawns += 1; return processHarness().child },
  })
  const controller = new AbortController()
  const operation = fallback({
    jobId: JOB_ID, generation: GENERATION, plan: PLAN, signal: controller.signal,
  })
  controller.abort()
  try {
    await assert.rejects(settleWithin(operation), { name: 'AbortError' })
  } finally {
    assert.deepEqual(events, [])
    assert.equal(spawns, 0)
  }
})

test('initial resolution seam bounds pending audits and observes late outcomes without side effects', async (t) => {
  for (const boundary of ['timeout', 'abort'] as const) {
    for (const lateOutcome of ['runtime', 'rejection'] as const) {
      await t.test(`${boundary}, late ${lateOutcome}`, async () => {
        const pending = deferred<WorldFfmpegRuntimeResolution>()
        const events: string[] = []
        let spawns = 0
        let resolutions = 0
        const controller = new AbortController()
        const fallback = createPackagedWorldFfmpegFallback({
          resourcesPath: '/test-only/pending-audit', platform: 'linux', arch: 'x64',
          authority: authority(events),
          spawnProcess: () => { spawns += 1; return processHarness().child },
          testDependencies: {
            resolveRuntime: () => { resolutions += 1; return pending.promise },
            runtimeResolutionTimeoutMs: 5,
          },
        })
        const operation = fallback({ jobId: JOB_ID, generation: GENERATION, plan: PLAN, signal: controller.signal })
        if (boundary === 'abort') controller.abort()
        if (boundary === 'abort') await assert.rejects(settleWithin(operation), { name: 'AbortError' })
        else assert.equal(await settleWithin(operation), false)
        assert.equal(resolutions, 1)
        assert.deepEqual(events, [])
        assert.equal(spawns, 0)
        if (lateOutcome === 'runtime') pending.resolve({ ok: true, runtime: RUNTIME })
        else pending.reject(new Error('late initial audit failure'))
        await new Promise((resolvePromise) => setImmediate(resolvePromise))
        assert.deepEqual(events, [], 'late audit cannot open, write, commit, confirm, abort or report progress')
        assert.equal(spawns, 0)
      })
    }
  }
})

test('initial resolution seam fails closed on rejection/invalid package and preserves settlement cancellation', async (t) => {
  for (const outcome of ['rejection', 'invalid', 'abort-runtime', 'abort-invalid'] as const) {
    await t.test(outcome, async () => {
      const events: string[] = []
      const controller = new AbortController()
      const fallback = createPackagedWorldFfmpegFallback({
        resourcesPath: '/test-only/audit-outcome', platform: 'linux', arch: 'x64', authority: authority(events),
        spawnProcess: () => { throw new Error('must not spawn') },
        testDependencies: {
          resolveRuntime: async () => {
            if (outcome === 'rejection') throw new Error('initial audit rejected')
            if (outcome.startsWith('abort-')) controller.abort()
            return outcome === 'abort-runtime' ? { ok: true, runtime: RUNTIME } : { ok: false, code: 'bundle-invalid' }
          },
        },
      })
      const operation = fallback({ jobId: JOB_ID, generation: GENERATION, plan: PLAN, signal: controller.signal })
      if (outcome.startsWith('abort-')) await assert.rejects(settleWithin(operation), { name: 'AbortError' })
      else assert.equal(await settleWithin(operation), false)
      assert.deepEqual(events, [])
    })
  }
})

test('missing packaged runtime returns truthful partial without opening a sink or spawning PATH FFmpeg', async (t) => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-missing-'))
  t.after(() => rm(resourcesPath, { recursive: true, force: true }))
  let sinkBegins = 0
  let spawns = 0
  const sinkAuthority = authority()
  sinkAuthority.beginWebmAssembly = async () => { sinkBegins += 1; return { sinkId: `sink-${'a'.repeat(32)}` } }
  const fallback = createPackagedWorldFfmpegFallback({
    resourcesPath,
    platform: 'linux',
    arch: 'x64',
    authority: sinkAuthority,
    spawnProcess: () => { spawns += 1; return processHarness().child },
    environment: { PATH: '/attacker' },
  })
  assert.equal(await fallback({
    jobId: JOB_ID, generation: GENERATION, plan: PLAN, signal: new AbortController().signal,
  }), false)
  assert.equal(sinkBegins, 0)
  assert.equal(spawns, 0)
})

test('replacement during sink begin cannot execute the verified executable or dynamic-library closure', async (t) => {
  for (const role of ['executable', 'library'] as const) {
    await t.test(role, async (t) => {
      const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-race-'))
      t.after(() => rm(resourcesPath, { recursive: true, force: true }))
      const bundle = await writeSignedLinuxBundle(resourcesPath)
      const events: string[] = []
      const sinkAuthority = authority(events)
      const begin = sinkAuthority.beginWebmAssembly.bind(sinkAuthority)
      sinkAuthority.beginWebmAssembly = async (...args) => {
        const opened = await begin(...args)
        const path = role === 'executable' ? bundle.executablePath : bundle.libraryPath
        await rm(path)
        await writeFile(path, `replacement ${role}`)
        await chmod(path, role === 'executable' ? 0o755 : 0o644)
        events.push(`replaced:${role}`)
        return opened
      }
      let spawned = false
      const fallback = createPackagedWorldFfmpegFallback({
        resourcesPath,
        platform: 'linux',
        arch: 'x64',
        trustedManifestKeys,
        authority: sinkAuthority,
        spawnProcess: () => { spawned = true; return processHarness().child },
      })
      assert.equal(await fallback({
        jobId: JOB_ID, generation: GENERATION, plan: PLAN, signal: new AbortController().signal,
      }), false)
      assert.equal(spawned, false)
      assert.deepEqual(events.filter((event) => event.startsWith('sink-') || event.startsWith('replaced:')), [
        'sink-begin', `replaced:${role}`, 'sink-abort',
      ])
    })
  }
})

test('an existing/unauthorized WebM sink prevents spawn and is never overwritten or aborted', async () => {
  let spawned = 0
  const existingAuthority = authority() as WorldFfmpegWebmAuthority
  existingAuthority.beginWebmAssembly = async () => { throw new Error('job_busy') }
  const result = await assembleWorldWebmWithFfmpeg({
    runtime: RUNTIME, acquireRuntimeLease: acquireTestRuntimeLease,
    plan: PLAN, jobId: JOB_ID, generation: GENERATION,
    authority: existingAuthority,
    spawnProcess: () => { spawned += 1; return processHarness().child },
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, { ok: false, code: 'sink-failed' })
  assert.equal(spawned, 0)
})
