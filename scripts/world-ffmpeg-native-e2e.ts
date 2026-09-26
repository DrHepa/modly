#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

import { enumerateWorldFrames } from '../src/areas/worlds/cinematic/worldRationalTime.ts'
import type { WorldProjectSnapshotV1 } from '../src/areas/worlds/core/worldModel.ts'
import { worldWebmVideoBitrate, type WorldWebmStartPayload } from '../src/areas/worlds/render/worldWebmProtocol.ts'
import type { WorldRenderNormalizedCreateRequest } from '../src/shared/types/worldRenders.ts'
import {
  assembleWorldWebmWithFfmpeg,
  type WorldFfmpegProcess,
  type WorldFfmpegSpawnOptions,
} from '../electron/main/world-render-ffmpeg-encoder.ts'
import {
  acquireWorldFfmpegExecutionLease,
  resolvePackagedWorldFfmpegRuntime,
  type VerifiedWorldFfmpegRuntime,
} from '../electron/main/world-render-ffmpeg-runtime.ts'
import {
  inspectWorldWebmVerificationEvidence,
  WorldRenderOutputRepository,
} from '../electron/main/world-render-output-repository.ts'
import { loadWorldFfmpegBuildTrust } from './world-ffmpeg-build-trust.mjs'
import {
  WORLD_FFMPEG_NATIVE_CASES,
  worldFfmpegNativeCasePlan,
} from './world-ffmpeg-native-e2e-contract.mjs'

const WIDTH = 64
const HEIGHT = 64

async function main(argv: readonly string[]): Promise<void> {
  const { resourcesPath, trustFile } = parseArguments(argv)
  const trust = await loadWorldFfmpegBuildTrust(trustFile)
  const resolved = await resolvePackagedWorldFfmpegRuntime({
    resourcesPath,
    platform: process.platform,
    arch: process.arch,
    trustedManifestKeys: trust.keys,
  })
  if (!resolved.ok) throw new Error(`Native FFmpeg proof unavailable: ${resolved.code}`)

  for (const [index, testCase] of WORLD_FFMPEG_NATIVE_CASES.entries()) {
    await runSuccessfulCase(resourcesPath, resolved.runtime, trust.keys, testCase, index)
  }
  await runCancellationCase(resolved.runtime, trust.keys)
  process.stdout.write(`Verified native FFmpeg fallback matrix with ${WORLD_FFMPEG_NATIVE_CASES.length} exact timing cases and cancellation custody.\n`)
}

async function runSuccessfulCase(
  resourcesPath: string,
  runtime: VerifiedWorldFfmpegRuntime,
  trustedManifestKeys: Readonly<Record<string, string>>,
  testCase: (typeof WORLD_FFMPEG_NATIVE_CASES)[number],
  index: number,
): Promise<void> {
  const fixture = await createFixture(testCase, index)
  try {
    assert.equal(runtime.rootPath, join(resolve(resourcesPath), 'ffmpeg', runtime.target))
    const controller = new AbortController()
    const result = await assembleWorldWebmWithFfmpeg({
      runtime,
      acquireRuntimeLease: (candidate) => acquireWorldFfmpegExecutionLease({
        runtime: candidate,
        trustedManifestKeys,
      }),
      plan: fixture.webmPlan,
      jobId: fixture.jobId,
      generation: fixture.generation,
      authority: fixture.repository,
      spawnProcess: spawnWorldFfmpeg,
      signal: controller.signal,
    })
    assert.equal(result.ok, true, `${testCase.id}: native assembly failed`)
    const settled = await fixture.repository.settle(fixture.jobId, { executorError: null })
    assert.equal(settled.ok && settled.value.status, 'succeeded')
    if (!settled.ok || !settled.value.outputs.webm) throw new Error(`${testCase.id}: no durable WebM output`)
    const bytes = await readFile(join(fixture.root, settled.value.outputs.webm.workspacePath))
    assert.equal(bytes.byteLength, result.ok ? result.size : -1)
    assert.ok(bytes.byteLength > 0)
    const evidence = await inspectWorldWebmVerificationEvidence(
      join(fixture.root, settled.value.outputs.webm.workspacePath),
      bytes.byteLength,
      fixture.webmPlan,
    )
    assert.equal(evidence.videoCodec, 'V_VP9')
    assert.equal(evidence.audioCodec, 'A_OPUS')
    assert.equal(evidence.videoFrameCount, fixture.webmPlan.frameCount)
    assert.ok(evidence.declaredDurationNanoseconds !== null, `${testCase.id}: missing seekable Segment Duration`)
    const expectedDurationNanoseconds = roundRationalNanoseconds(testCase.duration)
    const expectedEndTicks = roundToTicks(expectedDurationNanoseconds, evidence.timestampScaleNanoseconds)
    assert.deepEqual(
      evidence.videoPresentationTimestampsTicks,
      Array.from({ length: fixture.webmPlan.frameCount }, (_value, frameIndex) => (
        roundRationalToTicks(frameIndex, fixture.webmPlan.fps, evidence.timestampScaleNanoseconds)
      )),
    )
    assert.equal(evidence.videoEndNanoseconds, expectedEndTicks * evidence.timestampScaleNanoseconds)
    assert.ok(abs(evidence.declaredDurationNanoseconds - expectedDurationNanoseconds)
      <= evidence.timestampScaleNanoseconds)
    assert.ok(abs(evidence.audioPresentedStartNanoseconds) <= evidence.timestampScaleNanoseconds)
    assert.ok(abs(evidence.audioPresentedEndNanoseconds - expectedDurationNanoseconds)
      <= evidence.timestampScaleNanoseconds + 20_834n)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
}

async function runCancellationCase(
  runtime: VerifiedWorldFfmpegRuntime,
  trustedManifestKeys: Readonly<Record<string, string>>,
): Promise<void> {
  const fixture = await createFixture(WORLD_FFMPEG_NATIVE_CASES[2], 15)
  const controller = new AbortController()
  let signalSpawned: (() => void) | null = null
  let signalClosed: (() => void) | null = null
  const spawned = new Promise<void>((resolvePromise) => { signalSpawned = resolvePromise })
  const closed = new Promise<void>((resolvePromise) => { signalClosed = resolvePromise })
  const operation = assembleWorldWebmWithFfmpeg({
    runtime,
    acquireRuntimeLease: (candidate) => acquireWorldFfmpegExecutionLease({
      runtime: candidate,
      trustedManifestKeys,
    }),
    plan: fixture.webmPlan,
    jobId: fixture.jobId,
    generation: fixture.generation,
    authority: fixture.repository,
    spawnProcess: (path, args, options) => {
      const child = spawn(path, [...args], { ...options, stdio: [...options.stdio] })
      child.once('close', () => signalClosed?.())
      signalSpawned?.()
      return child as unknown as WorldFfmpegProcess
    },
    signal: controller.signal,
  })
  try {
    await bounded(spawned, 30_000, 'native FFmpeg spawn')
    controller.abort()
    await assert.rejects(operation, (error: unknown) => error instanceof Error && error.name === 'AbortError')
    await bounded(closed, 15_000, 'cancelled FFmpeg close')
    const files = await listFiles(fixture.root)
    assert.equal(files.some((path) => path.endsWith('output.webm') || path.includes('.webm.')), false)
  } finally {
    controller.abort()
    await operation.catch(() => undefined)
    await rm(fixture.root, { recursive: true, force: true })
  }
}

async function createFixture(testCase: (typeof WORLD_FFMPEG_NATIVE_CASES)[number], index: number) {
  const nativePlan = worldFfmpegNativeCasePlan(testCase)
  const suffix = (index + 1).toString(16).padStart(32, '0')
  const projectKey = `world-${suffix}`
  const jobId = `render-${suffix}`
  const generation = (index + 101).toString(16).padStart(32, '0')
  const root = await mkdtemp(join(tmpdir(), `modly-world-ffmpeg-native-${testCase.id}-`))
  const repository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root, createJobId: () => jobId })
  const request: WorldRenderNormalizedCreateRequest = {
    projectKey,
    expectedRevision: 1,
    sceneId: 'scene:main',
    sequenceId: 'sequence:native-proof',
    preset: { width: WIDTH, height: HEIGHT, fps: nativePlan.fps as 30 },
  }
  const snapshot = snapshotFor(testCase.duration, projectKey)
  const frames = enumerateWorldFrames(testCase.duration, nativePlan.fps as 30)
  assert.equal((await repository.createJob({ request, snapshot, framePlan: frames })).ok, true)
  for (const frame of frames) {
    assert.equal((await repository.recordFrame(jobId, frame.index, png(frame.index))).ok, true)
  }
  assert.equal((await repository.recordAudio(jobId, wav(nativePlan.audioSampleCount))).ok, true)
  assert.equal((await repository.updateProgress(jobId, { phase: 'assembling', completedFrames: frames.length })).ok, true)
  const webmPlan: WorldWebmStartPayload = {
    width: WIDTH,
    height: HEIGHT,
    fps: nativePlan.fps as 30,
    frameCount: frames.length,
    duration: { ...testCase.duration },
    frameDurations: frames.map((frame) => ({ ...frame.duration })),
    audioSampleCount: nativePlan.audioSampleCount,
    videoBitrate: worldWebmVideoBitrate(WIDTH, HEIGHT, nativePlan.fps),
    audioBitrate: 128_000,
  }
  return { root, repository, jobId, generation, webmPlan }
}

function snapshotFor(
  duration: { readonly numerator: number; readonly denominator: number },
  projectKey: string,
): WorldProjectSnapshotV1 {
  const sequence = { id: 'sequence:native-proof', name: 'Native proof', duration: { ...duration }, tracks: [] }
  return {
    project: {
      schema: 'modly.world-project.v1', projectId: 'project:native-proof', name: 'Native proof', revision: 1,
      resources: [], scenes: [{ id: 'scene:main', name: 'Main', documentPath: `Worlds/${projectKey}/scenes/main.world-scene.json` }],
      startSceneId: 'scene:main', inputActions: [],
      graphicsProfiles: [{ id: 'graphics:native', name: 'Native', renderScale: 1, shadowQuality: 'off', antialiasing: 'off' }],
      activeGraphicsProfileId: 'graphics:native',
    },
    scenes: [{
      schema: 'modly.world-scene.v1', projectId: 'project:native-proof', sceneId: 'scene:main', name: 'Main',
      environment: { backgroundColor: '#000000', ambientIntensity: 0 },
      entities: [{
        id: 'entity:camera', name: 'Camera', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 50 }],
      }],
      sequences: [sequence],
    }],
  }
}

function png(index: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(WIDTH, 0); ihdr.writeUInt32BE(HEIGHT, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 4))
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let column = 0; column < WIDTH; column += 1) {
      const offset = row * (1 + WIDTH * 4) + 1 + column * 4
      raw[offset] = (column * 4 + index * 17) & 0xff
      raw[offset + 1] = (row * 4 + index * 29) & 0xff
      raw[offset + 2] = (column + row + index * 41) & 0xff
      raw[offset + 3] = 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
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

function wav(sampleCount: number): Buffer {
  const value = Buffer.alloc(44 + sampleCount * 4)
  value.write('RIFF'); value.writeUInt32LE(value.length - 8, 4); value.write('WAVEfmt ', 8); value.writeUInt32LE(16, 16)
  value.writeUInt16LE(1, 20); value.writeUInt16LE(2, 22); value.writeUInt32LE(48_000, 24); value.writeUInt32LE(192_000, 28)
  value.writeUInt16LE(4, 32); value.writeUInt16LE(16, 34); value.write('data', 36); value.writeUInt32LE(sampleCount * 4, 40)
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const left = ((sample * 811) % 65_535) - 32_767
    const right = ((sample * 1_237) % 65_535) - 32_767
    value.writeInt16LE(left, 44 + sample * 4)
    value.writeInt16LE(right, 46 + sample * 4)
  }
  return value
}

function spawnWorldFfmpeg(path: string, args: readonly string[], options: WorldFfmpegSpawnOptions): WorldFfmpegProcess {
  return spawn(path, [...args], { ...options, stdio: [...options.stdio] }) as unknown as WorldFfmpegProcess
}

async function bounded<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(`${label} did not settle.`)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const results: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) results.push(...await listFiles(root, path))
    else results.push(path)
  }
  return results
}

function roundRationalNanoseconds(value: { readonly numerator: number; readonly denominator: number }): bigint {
  const numerator = BigInt(value.numerator) * 1_000_000_000n
  const denominator = BigInt(value.denominator)
  return (numerator + denominator / 2n) / denominator
}

function roundToTicks(nanoseconds: bigint, scale: bigint): bigint {
  return (nanoseconds + scale / 2n) / scale
}

function roundRationalToTicks(frameIndex: number, fps: number, scale: bigint): bigint {
  const numerator = BigInt(frameIndex) * 1_000_000_000n
  const denominator = BigInt(fps) * scale
  return (numerator + denominator / 2n) / denominator
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

function parseArguments(argv: readonly string[]): { resourcesPath: string; trustFile: string } {
  if (argv.length !== 4 || argv[0] !== '--resources' || argv[2] !== '--trust-file'
    || !isAbsolute(argv[1]) || argv[1].includes('\0')
    || !isAbsolute(argv[3]) || argv[3].includes('\0')) {
    throw new Error('Usage: world-ffmpeg-native-e2e.ts --resources <absolute-packaged-resources-path> --trust-file <absolute-trusted-keys-json>')
  }
  return { resourcesPath: resolve(argv[1]), trustFile: resolve(argv[3]) }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Native FFmpeg proof failed.'}\n`)
  process.exitCode = 1
})
