import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORLD_WEBM_PROTOCOL,
  type WorldWebmMainResponse,
  type WorldWebmStartPayload,
  type WorldWebmWorkerEvent,
  type WorldWebmWorkerRequest,
} from './worldWebmProtocol.ts'
import {
  assembleWorldWebm,
  type WorldWebmMediaDependencies,
  type WorldWebmTransport,
} from './worldWebmAssembler.ts'

const JOB_ID = 'render-0123456789abcdef0123456789abcdef'
const GENERATION = '0123456789abcdef0123456789abcdef'
const payload: WorldWebmStartPayload = {
  width: 64, height: 64, fps: 30, frameCount: 3,
  duration: { numerator: 1, denominator: 10 }, audioSampleCount: 4_800,
  frameDurations: [
    { numerator: 1, denominator: 30 },
    { numerator: 1, denominator: 30 },
    { numerator: 1, denominator: 30 },
  ],
  videoBitrate: 500_000, audioBitrate: 128_000,
}

function response(request: WorldWebmWorkerRequest, body: object): WorldWebmMainResponse {
  return {
    protocol: WORLD_WEBM_PROTOCOL, jobId: JOB_ID, generation: GENERATION,
    requestId: request.requestId, kind: 'response', requestKind: request.kind,
    ok: true, payload: body,
  } as WorldWebmMainResponse
}

function harness(options: {
  videoSupported?: boolean
  audioSupported?: boolean
  failVideo?: boolean
  failMuxConstruction?: boolean
  failMuxStart?: boolean
  failMuxFinalize?: boolean
  failOutputCancel?: boolean
  failDecode?: boolean
  failAvailabilityProbe?: boolean
  failRequest?: 'read-frame' | 'sink-write' | 'sink-abort'
  opusPacketSamples?: readonly number[]
} = {}) {
  const calls: string[] = []
  const events: WorldWebmWorkerEvent[] = []
  const closed = { bitmaps: 0, videoSamples: 0, audioSamples: 0, videoSource: 0, audioSource: 0 }
  let extent = 0
  class Quality {
    constructor(options: object) { calls.push(`quality:${JSON.stringify(options)}`) }
  }
  class WebMOutputFormat { constructor() { calls.push('format') } }
  class StreamTarget {
    readonly writable: WritableStream<{ type: 'write'; data: Uint8Array; position: number }>
    constructor(writable: WritableStream<{ type: 'write'; data: Uint8Array; position: number }>, options: object) { this.writable = writable; calls.push(`target:${JSON.stringify(options)}`) }
  }
  class VideoSample {
    constructor(_bitmap: { close(): void }, init: object) { calls.push(`video-sample:${JSON.stringify(init)}`) }
    close() { closed.videoSamples += 1; calls.push('video-sample-close') }
  }
  class AudioSample {
    readonly sampleCount: number
    constructor(init: { data: ArrayBuffer }) {
      this.sampleCount = init.data.byteLength / 4
      calls.push(`audio-sample:${JSON.stringify({ ...init, data: 'bytes' })}`)
    }
    close() { closed.audioSamples += 1; calls.push('audio-sample-close') }
  }
  class VideoSampleSource {
    constructor(config: object) { calls.push(`video-source:${JSON.stringify(config)}`) }
    async add() { calls.push('video-add'); if (options.failVideo) throw new Error('encoder exploded') }
    close() { closed.videoSource += 1; calls.push('video-close') }
  }
  class AudioSampleSource {
    private readonly config: {
      onEncodedPacket?: (
        packet: { timestamp: number; duration: number; byteLength: number },
        metadata?: { decoderConfig?: { description?: ArrayBuffer } },
      ) => unknown
    }
    private sampleCount = 0
    constructor(config: AudioSampleSource['config']) {
      this.config = config
      calls.push(`audio-source:onEncodedPacket:${typeof config.onEncodedPacket}`)
    }
    async add(sample: AudioSample) { this.sampleCount += sample.sampleCount; calls.push('audio-add') }
    close() {
      closed.audioSource += 1
      calls.push('audio-close')
      if (this.sampleCount < 1 || !this.config.onEncodedPacket) return
      const packetSamples = options.opusPacketSamples ?? exactOpusPacketSamples(this.sampleCount)
      const decoderDescription = new ArrayBuffer(opusHead(312).byteLength)
      new Uint8Array(decoderDescription).set(opusHead(312))
      let timestampSamples = 0
      for (let index = 0; index < packetSamples.length; index += 1) {
        const samples = packetSamples[index]!
        this.config.onEncodedPacket({
          timestamp: timestampSamples / 48_000,
          duration: samples / 48_000,
          byteLength: 8,
        }, index === 0 ? { decoderConfig: { description: decoderDescription } } : undefined)
        timestampSamples += samples
      }
    }
  }
  class Output {
    state: 'pending' | 'started' | 'canceled' | 'finalizing' | 'finalized' = 'pending'
    private writer: WritableStreamDefaultWriter<{ type: 'write'; data: Uint8Array; position: number }> | null = null
    readonly options: { target: StreamTarget }
    constructor(optionsValue: { target: StreamTarget }) {
      if (options.failMuxConstruction) throw new Error('mux construction exploded')
      this.options = optionsValue
      calls.push('output')
    }
    addVideoTrack(_source: unknown, metadata: object) { calls.push(`video-track:${JSON.stringify(metadata)}`) }
    addAudioTrack() { calls.push('audio-track') }
    async start() {
      this.state = 'started'; calls.push('output-start')
      if (options.failMuxStart) throw new Error('mux start exploded')
      this.writer = this.options.target.writable.getWriter()
      await this.writer.write({ type: 'write', data: new Uint8Array([3, 4]), position: 2 })
    }
    async finalize() {
      this.state = 'finalizing'; calls.push('output-finalize')
      if (options.failMuxFinalize) throw new Error('mux finalize exploded')
      await this.writer!.write({ type: 'write', data: new Uint8Array([1, 2, 3]), position: 0 })
      await this.writer!.close(); this.state = 'finalized'; calls.push('output-finalized')
    }
    async cancel() {
      this.state = 'canceled'; calls.push('output-cancel')
      if (options.failOutputCancel) throw new Error('output cancel exploded')
      await this.writer?.close()
    }
  }
  const dependencies = {
    Quality, WebMOutputFormat, StreamTarget, VideoSample, AudioSample, VideoSampleSource, AudioSampleSource, Output,
    canEncodeVideo: async (codec: string, config: object) => {
      calls.push(`can-video:${codec}:${JSON.stringify(config)}`)
      if (options.failAvailabilityProbe) throw new Error('availability probe exploded')
      return options.videoSupported ?? true
    },
    canEncodeAudio: async (codec: string, config: object) => { calls.push(`can-audio:${codec}:${JSON.stringify(config)}`); return options.audioSupported ?? true },
    decodePng: async () => {
      if (options.failDecode) throw new Error('PNG decode exploded')
      return { close() { closed.bitmaps += 1; calls.push('bitmap-close') } }
    },
  } as unknown as WorldWebmMediaDependencies
  const transport: WorldWebmTransport = {
    async request(request, transfer) {
      calls.push(`request:${request.kind}`)
      if (request.kind === options.failRequest) throw new Error(`${request.kind} exploded`)
      if (request.kind === 'preflight' || request.kind === 'sink-abort') return response(request, {})
      if (request.kind === 'sink-begin') return response(request, { sinkId: 'sink-0123456789abcdef0123456789abcdef' })
      if (request.kind === 'read-frame') return response(request, { index: request.payload.index, size: 4, sha256: 'a'.repeat(64), bytes: new Uint8Array([137, 80, 78, 71]).buffer })
      if (request.kind === 'read-audio') return response(request, { sampleOffset: request.payload.sampleOffset, sampleCount: request.payload.sampleCount, bytes: new ArrayBuffer(request.payload.sampleCount * 4) })
      if (request.kind === 'sink-write') {
        const byteLength = request.payload.bytes.byteLength
        extent = Math.max(extent, request.payload.position + byteLength)
        assert.deepEqual(transfer, [request.payload.bytes])
        structuredClone(request.payload.bytes, { transfer: [request.payload.bytes] })
        assert.equal(request.payload.bytes.byteLength, 0, 'the production Worker transfer detaches its write buffer')
        return response(request, { written: byteLength, extent })
      }
      if (request.kind === 'sink-commit') return response(request, { size: request.payload.extent, sha256: 'b'.repeat(64) })
      throw new Error('unexpected request')
    },
    emit(event) { events.push(event); calls.push(`event:${event.kind}`) },
  }
  return { dependencies, transport, calls, events, closed }
}

function exactOpusPacketSamples(sampleCount: number): readonly number[] {
  const packets: number[] = []
  for (let remaining = sampleCount; remaining > 0;) {
    const next = Math.min(960, remaining)
    packets.push(next)
    remaining -= next
  }
  return packets
}

function opusHead(preSkip: number): Uint8Array {
  const bytes = new Uint8Array(19)
  bytes.set([79, 112, 117, 115, 72, 101, 97, 100, 1, 2])
  bytes[10] = preSkip & 0xff
  bytes[11] = preSkip >> 8
  bytes.set([128, 187, 0, 0], 12)
  return bytes
}

test('uses exact Mediabunny preflight/source options, awaits positional writes, closes resources, then commits after finalize', async () => {
  const h = harness()
  const result = await assembleWorldWebm({
    protocol: WORLD_WEBM_PROTOCOL, jobId: JOB_ID, generation: GENERATION, requestId: 1, kind: 'start', payload,
  }, h.dependencies, h.transport, new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(h.calls.some((value) => value === 'quality:{"bitrate":500000}'), true)
  assert.equal(h.calls.some((value) => value === 'quality:{"bitrate":128000}'), true)
  assert.equal(h.calls.some((value) => value.includes('can-video:vp9:') && value.includes('"latencyMode":"quality"') && value.includes('"alpha":"discard"')), true)
  assert.equal(h.calls.some((value) => value.includes('can-audio:opus:') && value.includes('"numberOfChannels":2') && value.includes('"sampleRate":48000')), true)
  assert.equal(h.calls.includes('audio-source:onEncodedPacket:function'), true)
  assert.equal(h.calls.filter((value) => value === 'request:read-frame').length, 3)
  assert.equal(h.calls.filter((value) => value === 'request:read-audio').length, 1)
  assert.deepEqual(h.closed, { bitmaps: 3, videoSamples: 3, audioSamples: 1, videoSource: 1, audioSource: 1 })
  assert.ok(h.calls.indexOf('output-finalized') < h.calls.indexOf('request:sink-commit'))
  assert.equal(h.events.at(-1)?.kind, 'complete')
})

test('WebCodecs Opus flush padding fails as codec-encode-failed before commit and only after sink cleanup', async () => {
  const h = harness({ opusPacketSamples: Array.from({ length: 6 }, () => 960) })

  const result = await assembleWorldWebm({
    protocol: WORLD_WEBM_PROTOCOL, jobId: JOB_ID, generation: GENERATION,
    requestId: 1, kind: 'start', payload,
  }, h.dependencies, h.transport, new AbortController().signal)

  assert.deepEqual(result, { ok: false, code: 'codec-encode-failed' })
  assert.equal(h.calls.includes('request:sink-commit'), false)
  assert.ok(h.calls.indexOf('output-finalized') < h.calls.indexOf('request:sink-abort'))
  const terminal = h.events.at(-1)
  assert.equal(terminal?.kind, 'error')
  if (terminal?.kind !== 'error') assert.fail('expected a terminal error event')
  assert.equal(terminal.payload.code, 'codec-encode-failed')
})

test('passes the exact shortened final frame duration to Mediabunny without a nominal DefaultDuration', async () => {
  const h = harness()
  const exactPayload: WorldWebmStartPayload = {
    ...payload,
    frameCount: 31,
    duration: { numerator: 101, denominator: 100 },
    frameDurations: [
      ...Array.from({ length: 30 }, () => ({ numerator: 1, denominator: 30 })),
      { numerator: 1, denominator: 100 },
    ],
    audioSampleCount: 48_480,
  }

  const result = await assembleWorldWebm({
    protocol: WORLD_WEBM_PROTOCOL, jobId: JOB_ID, generation: GENERATION,
    requestId: 1, kind: 'start', payload: exactPayload,
  }, h.dependencies, h.transport, new AbortController().signal)

  assert.equal(result.ok, true)
  assert.equal(h.calls.filter((value) => value.startsWith('video-sample:')).at(-1),
    'video-sample:{"timestamp":1,"duration":0.01}')
  assert.equal(h.calls.includes('video-track:{}'), true)
})

test('codec unavailability stays partial-ready without a sink and encode failure cancels output then aborts sink', async () => {
  const unsupported = harness({ videoSupported: false })
  const unavailable = await assembleWorldWebm({ protocol: WORLD_WEBM_PROTOCOL, jobId: JOB_ID, generation: GENERATION, requestId: 1, kind: 'start', payload }, unsupported.dependencies, unsupported.transport, new AbortController().signal)
  assert.deepEqual(unavailable, { ok: false, code: 'codec-unavailable' })
  assert.equal(unsupported.calls.includes('request:sink-begin'), false)
  assert.equal(unsupported.events.at(-1)?.kind, 'error')

  const failed = harness({ failVideo: true })
  const failure = await assembleWorldWebm({ protocol: WORLD_WEBM_PROTOCOL, jobId: JOB_ID, generation: GENERATION, requestId: 1, kind: 'start', payload }, failed.dependencies, failed.transport, new AbortController().signal)
  assert.deepEqual(failure, { ok: false, code: 'codec-encode-failed' })
  assert.ok(failed.calls.indexOf('output-cancel') < failed.calls.indexOf('request:sink-abort'))
  assert.equal(failed.events.at(-1)?.kind, 'error')
})

test('failed renderer output or repository sink cleanup overrides fallback eligibility with sink-failed', async (t) => {
  for (const [label, options] of [
    ['renderer output cancel', { failVideo: true, failOutputCancel: true }],
    ['repository sink abort', { failVideo: true, failRequest: 'sink-abort' as const }],
  ] as const) {
    await t.test(label, async () => {
      const h = harness(options)
      const result = await assembleWorldWebm({
        protocol: WORLD_WEBM_PROTOCOL, jobId: JOB_ID, generation: GENERATION,
        requestId: 1, kind: 'start', payload,
      }, h.dependencies, h.transport, new AbortController().signal)

      assert.deepEqual(result, { ok: false, code: 'sink-failed' })
      const terminal = h.events.at(-1)
      assert.equal(terminal?.kind, 'error')
      if (terminal?.kind !== 'error') assert.fail('expected a terminal error event')
      assert.equal(terminal.payload.code, 'sink-failed')
    })
  }
})

test('classifies only exact codec and mux failures as fallback eligible', async (t) => {
  const cases = [
    ['mux construction', { failMuxConstruction: true }, 'mux-construction-failed'],
    ['mux start', { failMuxStart: true }, 'mux-start-failed'],
    ['mux finalize', { failMuxFinalize: true }, 'mux-finalize-failed'],
    ['master decode', { failDecode: true }, 'master-decode-failed'],
    ['master read', { failRequest: 'read-frame' as const }, 'master-read-failed'],
    ['sink callback', { failRequest: 'sink-write' as const }, 'sink-failed'],
    ['generic internal probe', { failAvailabilityProbe: true }, 'internal-failed'],
  ] as const

  for (const [label, options, code] of cases) {
    await t.test(label, async () => {
      const h = harness(options)
      const result = await assembleWorldWebm({
        protocol: WORLD_WEBM_PROTOCOL, jobId: JOB_ID, generation: GENERATION,
        requestId: 1, kind: 'start', payload,
      }, h.dependencies, h.transport, new AbortController().signal)
      assert.deepEqual(result, { ok: false, code })
      if (h.calls.includes('request:sink-begin')) {
        assert.ok(h.calls.indexOf('output-cancel') < h.calls.indexOf('request:sink-abort'))
      }
    })
  }
})
