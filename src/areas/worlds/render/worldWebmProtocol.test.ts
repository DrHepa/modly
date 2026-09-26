import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORLD_WEBM_AUDIO_SAMPLE_RATE,
  WORLD_WEBM_MAX_AUDIO_SAMPLES,
  WORLD_WEBM_MAX_DURATION_SECONDS,
  WORLD_WEBM_MAX_OUTPUT_BYTES,
  WORLD_WEBM_PROTOCOL,
  parseWorldWebmMainCommand,
  parseWorldWebmMainResponse,
  parseWorldWebmWorkerMessage,
  worldWebmVideoBitrate,
} from './worldWebmProtocol.ts'

const JOB_ID = 'render-0123456789abcdef0123456789abcdef'
const GENERATION = '0123456789abcdef0123456789abcdef'

function envelope<P extends object>(kind: string, payload: P, requestId = 1) {
  return { protocol: WORLD_WEBM_PROTOCOL, jobId: JOB_ID, generation: GENERATION, requestId, kind, payload }
}

test('accepts exact positive-duration start/abort envelopes and rejects impossible jobs', () => {
  const start = envelope('start', {
    width: 1920,
    height: 1080,
    fps: 30,
    frameCount: 30,
    duration: { numerator: 1, denominator: 1 },
    frameDurations: Array.from({ length: 30 }, () => ({ numerator: 1, denominator: 30 })),
    audioSampleCount: WORLD_WEBM_AUDIO_SAMPLE_RATE,
    videoBitrate: worldWebmVideoBitrate(1920, 1080, 30),
    audioBitrate: 128_000,
  })
  assert.deepEqual(parseWorldWebmMainCommand(start), start)
  assert.deepEqual(parseWorldWebmMainCommand(envelope('abort', {}, 2)), envelope('abort', {}, 2))
  assert.equal(parseWorldWebmMainCommand({ ...start, extra: true }), null)
  assert.equal(parseWorldWebmMainCommand({ ...start, payload: { ...start.payload, duration: { numerator: 0, denominator: 1 }, frameCount: 0, audioSampleCount: 0 } }), null)
  assert.equal(parseWorldWebmMainCommand({ ...start, payload: { ...start.payload, duration: { numerator: WORLD_WEBM_MAX_DURATION_SECONDS + 1, denominator: 1 } } }), null)
  assert.equal(parseWorldWebmMainCommand({ ...start, payload: { ...start.payload, audioSampleCount: WORLD_WEBM_MAX_AUDIO_SAMPLES + 1 } }), null)
  assert.equal(parseWorldWebmMainCommand({ ...start, payload: { ...start.payload, frameCount: 29 } }), null)
  assert.equal(parseWorldWebmMainCommand({ ...start, payload: { ...start.payload, frameDurations: start.payload.frameDurations.slice(1) } }), null)
  assert.equal(parseWorldWebmMainCommand({
    ...start,
    payload: { ...start.payload, frameDurations: [...start.payload.frameDurations.slice(0, -1), { numerator: 1, denominator: 29 }] },
  }), null)
})

test('parses bounded master pulls, positional sink writes, commit, abort and progress', () => {
  const sinkId = 'sink-0123456789abcdef0123456789abcdef'
  const preflight = envelope('preflight', {
    width: 64, height: 64, fps: 30, videoCodec: 'vp9', videoBitrate: 500_000,
    audioCodec: 'opus', audioBitrate: 128_000, audioSampleRate: 48_000, audioChannels: 2,
  })
  const begin = envelope('sink-begin', {}, 2)
  const frame = envelope('read-frame', { sinkId, index: 0 }, 3)
  const audio = envelope('read-audio', { sinkId, sampleOffset: 0, sampleCount: 48_000 }, 4)
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer
  const write = envelope('sink-write', { sinkId, position: 1024, bytes }, 5)
  const commit = envelope('sink-commit', { sinkId, extent: 1028 }, 6)
  const abort = envelope('sink-abort', { sinkId }, 7)
  const progress = envelope('progress', {
    phase: 'encoding', completedFrames: 1, frameCount: 30,
    completedAudioSamples: 48_000, audioSampleCount: 48_000,
  }, 8)
  for (const message of [preflight, begin, frame, audio, write, commit, abort, progress]) {
    assert.deepEqual(parseWorldWebmWorkerMessage(message), message)
  }
  assert.equal(parseWorldWebmWorkerMessage(envelope('sink-write', { sinkId, position: WORLD_WEBM_MAX_OUTPUT_BYTES, bytes }, 9)), null)
  assert.equal(parseWorldWebmWorkerMessage(envelope('read-audio', { sinkId, sampleOffset: 1, sampleCount: 0 }, 10)), null)
  assert.equal(parseWorldWebmWorkerMessage(envelope('progress', { ...progress.payload, completedFrames: 31 }, 11)), null)
})

test('parses request-bound ACK/results and rejects forged prototypes or unknown keys', () => {
  const frameBytes = new Uint8Array([137, 80, 78, 71]).buffer
  const success = {
    protocol: WORLD_WEBM_PROTOCOL,
    jobId: JOB_ID,
    generation: GENERATION,
    requestId: 3,
    kind: 'response',
    requestKind: 'read-frame',
    ok: true,
    payload: { index: 0, size: 4, sha256: 'a'.repeat(64), bytes: frameBytes },
  }
  assert.deepEqual(parseWorldWebmMainResponse(success), success)
  assert.deepEqual(parseWorldWebmMainResponse({
    protocol: WORLD_WEBM_PROTOCOL,
    jobId: JOB_ID,
    generation: GENERATION,
    requestId: 4,
    kind: 'response',
    requestKind: 'sink-write',
    ok: false,
    error: { code: 'write-failed', message: 'Write failed.' },
  }), {
    protocol: WORLD_WEBM_PROTOCOL,
    jobId: JOB_ID,
    generation: GENERATION,
    requestId: 4,
    kind: 'response',
    requestKind: 'sink-write',
    ok: false,
    error: { code: 'write-failed', message: 'Write failed.' },
  })
  assert.equal(parseWorldWebmMainResponse({ ...success, payload: { ...success.payload, extra: true } }), null)
  assert.equal(parseWorldWebmMainResponse(Object.create({ ...success })), null)
  const accessor = { ...success } as Record<string, unknown>
  Object.defineProperty(accessor, 'payload', { enumerable: true, get: () => success.payload })
  assert.equal(parseWorldWebmMainResponse(accessor), null)
})

test('accepts exact complete/error worker terminals only', () => {
  const completed = envelope('complete', { size: 2048, sha256: 'b'.repeat(64) }, 12)
  assert.deepEqual(parseWorldWebmWorkerMessage(completed), completed)
  for (const code of [
    'codec-unavailable', 'codec-encode-failed',
    'mux-construction-failed', 'mux-start-failed', 'mux-finalize-failed',
    'master-read-failed', 'master-decode-failed', 'sink-failed',
    'worker-crashed', 'worker-timeout', 'protocol-failed', 'cancelled', 'internal-failed',
  ]) {
    const failed = envelope('error', { code, message: `${code} message` }, 12)
    assert.deepEqual(parseWorldWebmWorkerMessage(failed), failed)
  }
  assert.equal(parseWorldWebmWorkerMessage(envelope('error', { code: 'encode-failed', message: 'generic' }, 12)), null)
  assert.equal(parseWorldWebmWorkerMessage(envelope('complete', { size: 0, sha256: 'b'.repeat(64) }, 12)), null)
})
