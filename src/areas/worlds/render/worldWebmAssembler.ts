import {
  WORLD_WEBM_AUDIO_CHANNELS,
  WORLD_WEBM_AUDIO_SAMPLE_RATE,
  WORLD_WEBM_MAX_AUDIO_CHUNK_SAMPLES,
  WORLD_WEBM_MAX_REQUEST_ID,
  WORLD_WEBM_PROTOCOL,
  parseWorldWebmMainCommand,
  parseWorldWebmMainResponse,
  type WorldWebmMainResponse,
  type WorldWebmFailureCode,
  type WorldWebmRequestKind,
  type WorldWebmStartPayload,
  type WorldWebmWorkerEvent,
  type WorldWebmWorkerRequest,
} from './worldWebmProtocol.ts'

type WebmStreamChunk = { type: 'write'; data: Uint8Array; position: number }
type WebmOutputState = 'pending' | 'started' | 'canceled' | 'finalizing' | 'finalized'

interface Closeable { close(): void }
type WorldWebmBitmap = Closeable
interface WorldWebmVideoSource extends Closeable { add(sample: Closeable): Promise<void> }
interface WorldWebmAudioSource extends Closeable { add(sample: Closeable): Promise<void> }
interface WorldWebmEncodedAudioPacket {
  readonly timestamp: number
  readonly duration: number
  readonly byteLength: number
}
interface WorldWebmOutput {
  state: WebmOutputState
  addVideoTrack(source: WorldWebmVideoSource, metadata: { frameRate?: number }): unknown
  addAudioTrack(source: WorldWebmAudioSource): unknown
  start(): Promise<void>
  finalize(): Promise<void>
  cancel(): Promise<void>
}

export interface WorldWebmMediaDependencies {
  Quality: new (options: { bitrate: number }) => unknown
  WebMOutputFormat: new () => unknown
  StreamTarget: new (writable: WritableStream<WebmStreamChunk>, options: { chunked: true; chunkSize: number }) => unknown
  VideoSample: new (bitmap: WorldWebmBitmap, init: { timestamp: number; duration: number }) => Closeable
  AudioSample: new (init: {
    data: ArrayBuffer
    format: 's16'
    numberOfChannels: 2
    sampleRate: 48_000
    timestamp: number
  }) => Closeable
  VideoSampleSource: new (config: {
    codec: 'vp9'
    quality: unknown
    keyFrameInterval: 2
    latencyMode: 'quality'
    hardwareAcceleration: 'no-preference'
    alpha: 'discard'
  }) => WorldWebmVideoSource
  AudioSampleSource: new (config: {
    codec: 'opus'
    quality: unknown
    onEncodedPacket: (packet: WorldWebmEncodedAudioPacket, metadata: unknown) => void
  }) => WorldWebmAudioSource
  Output: new (options: { format: unknown; target: unknown }) => WorldWebmOutput
  canEncodeVideo(codec: 'vp9', options: {
    width: number
    height: number
    quality: unknown
    latencyMode: 'quality'
    hardwareAcceleration: 'no-preference'
    alpha: 'discard'
  }): Promise<boolean>
  canEncodeAudio(codec: 'opus', options: {
    numberOfChannels: 2
    sampleRate: 48_000
    quality: unknown
  }): Promise<boolean>
  decodePng(bytes: ArrayBuffer): Promise<WorldWebmBitmap>
}

export interface WorldWebmTransport {
  request(request: WorldWebmWorkerRequest, transfer?: readonly Transferable[]): Promise<WorldWebmMainResponse>
  emit(event: WorldWebmWorkerEvent): void
}

export type WorldWebmAssemblyResult =
  | { ok: true; size: number; sha256: string }
  | { ok: false; code: WorldWebmFailureCode }

class WorldWebmAssemblyFailure extends Error {
  readonly code: Exclude<WorldWebmAssemblyResult, { ok: true }>['code']

  constructor(code: Exclude<WorldWebmAssemblyResult, { ok: true }>['code'], message: string) {
    super(message)
    this.name = 'WorldWebmAssemblyFailure'
    this.code = code
  }
}

export class WorldWebmTransportFailure extends Error {
  readonly code: Extract<WorldWebmFailureCode, 'worker-timeout' | 'protocol-failed'>

  constructor(code: WorldWebmTransportFailure['code'], message: string) {
    super(message)
    this.name = 'WorldWebmTransportFailure'
    this.code = code
  }
}

export async function assembleWorldWebm(
  startValue: unknown,
  dependencies: WorldWebmMediaDependencies,
  transport: WorldWebmTransport,
  signal: AbortSignal,
): Promise<WorldWebmAssemblyResult> {
  const start = parseWorldWebmMainCommand(startValue)
  if (!start || start.kind !== 'start') throw new TypeError('World WebM start command is invalid.')
  const identity = { jobId: start.jobId, generation: start.generation }
  const payload = start.payload
  let requestId = 0
  let sinkId: string | null = null
  let output: WorldWebmOutput | null = null
  let videoSource: WorldWebmVideoSource | null = null
  let audioSource: WorldWebmAudioSource | null = null
  let sourcesClosed = false
  let extent = 0
  const audioPacketAudit = new MediabunnyOpusPacketAudit(payload.audioSampleCount)

  const emit = <K extends WorldWebmWorkerEvent['kind']>(
    kind: K,
    eventPayload: Extract<WorldWebmWorkerEvent, { kind: K }>['payload'],
  ): void => {
    transport.emit({
      protocol: WORLD_WEBM_PROTOCOL,
      ...identity,
      requestId: start.requestId,
      kind,
      payload: eventPayload,
    } as Extract<WorldWebmWorkerEvent, { kind: K }>)
  }

  const request = async <K extends WorldWebmRequestKind>(
    kind: K,
    requestPayload: Extract<WorldWebmWorkerRequest, { kind: K }>['payload'],
    transfer?: readonly Transferable[],
  ): Promise<Extract<WorldWebmMainResponse, { ok: true }>['payload']> => {
    throwIfAborted(signal)
    if (requestId >= WORLD_WEBM_MAX_REQUEST_ID) throw new WorldWebmAssemblyFailure('sink-failed', 'World WebM request limit was exceeded.')
    const message = {
      protocol: WORLD_WEBM_PROTOCOL,
      ...identity,
      requestId: ++requestId,
      kind,
      payload: requestPayload,
    } as Extract<WorldWebmWorkerRequest, { kind: K }>
    let raw: WorldWebmMainResponse
    try {
      raw = await transport.request(message, transfer)
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      if (error instanceof WorldWebmTransportFailure) throw error
      const code: WorldWebmFailureCode = kind === 'read-frame' || kind === 'read-audio'
        ? 'master-read-failed'
        : kind === 'preflight' ? 'protocol-failed' : 'sink-failed'
      throw new WorldWebmAssemblyFailure(code, error instanceof Error ? error.message : String(error))
    }
    const response = parseWorldWebmMainResponse(raw)
    if (!response || response.jobId !== identity.jobId || response.generation !== identity.generation
      || response.requestId !== message.requestId || response.requestKind !== kind) {
      throw new WorldWebmAssemblyFailure('sink-failed', 'World WebM host returned an invalid response.')
    }
    if (!response.ok) {
      const code = kind === 'read-frame' || kind === 'read-audio' ? 'master-read-failed'
        : response.error.code === 'cancelled' ? 'cancelled' : 'sink-failed'
      throw new WorldWebmAssemblyFailure(code, response.error.message)
    }
    return response.payload
  }

  const closeSources = (): void => {
    if (sourcesClosed) return
    sourcesClosed = true
    try { videoSource?.close() } catch { /* already failed */ }
    try { audioSource?.close() } catch { /* already failed */ }
  }

  try {
    throwIfAborted(signal)
    emit('progress', progressPayload('preflighting', payload, 0, 0))
    const videoQuality = new dependencies.Quality({ bitrate: payload.videoBitrate })
    const audioQuality = new dependencies.Quality({ bitrate: payload.audioBitrate })
    const videoSupport = {
      width: payload.width,
      height: payload.height,
      quality: videoQuality,
      latencyMode: 'quality' as const,
      hardwareAcceleration: 'no-preference' as const,
      alpha: 'discard' as const,
    }
    const audioSupport = {
      numberOfChannels: WORLD_WEBM_AUDIO_CHANNELS,
      sampleRate: WORLD_WEBM_AUDIO_SAMPLE_RATE,
      quality: audioQuality,
    }
    const [videoSupported, audioSupported] = await Promise.all([
      dependencies.canEncodeVideo('vp9', videoSupport),
      dependencies.canEncodeAudio('opus', audioSupport),
    ])
    throwIfAborted(signal)
    if (!videoSupported || !audioSupported) {
      throw new WorldWebmAssemblyFailure('codec-unavailable', 'VP9 or Opus encoding is unavailable.')
    }
    await request('preflight', {
      width: payload.width,
      height: payload.height,
      fps: payload.fps,
      videoCodec: 'vp9',
      videoBitrate: payload.videoBitrate,
      audioCodec: 'opus',
      audioBitrate: payload.audioBitrate,
      audioSampleRate: WORLD_WEBM_AUDIO_SAMPLE_RATE,
      audioChannels: WORLD_WEBM_AUDIO_CHANNELS,
    })
    const begin = await request('sink-begin', {})
    if (!isSinkBeginPayload(begin)) throw new WorldWebmAssemblyFailure('sink-failed', 'World WebM sink id is invalid.')
    sinkId = begin.sinkId

    try {
      const writable = new WritableStream<WebmStreamChunk>({
        write: async (chunk) => {
          if (chunk.type !== 'write' || !(chunk.data instanceof Uint8Array)) {
            throw new WorldWebmAssemblyFailure('sink-failed', 'Mediabunny emitted an invalid stream write.')
          }
          const bytes = chunk.data.slice().buffer
          const byteLength = bytes.byteLength
          const result = await request('sink-write', { sinkId: sinkId!, position: chunk.position, bytes }, [bytes])
          if (!isWritePayload(result) || result.written !== byteLength) {
            throw new WorldWebmAssemblyFailure('sink-failed', 'World WebM write acknowledgement is invalid.')
          }
          extent = Math.max(extent, result.extent)
        },
      })
      const target = new dependencies.StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 })
      output = new dependencies.Output({ format: new dependencies.WebMOutputFormat(), target })
      videoSource = new dependencies.VideoSampleSource({
        codec: 'vp9',
        quality: videoQuality,
        keyFrameInterval: 2,
        latencyMode: 'quality',
        hardwareAcceleration: 'no-preference',
        alpha: 'discard',
      })
      audioSource = new dependencies.AudioSampleSource({
        codec: 'opus',
        quality: audioQuality,
        onEncodedPacket: (packet) => audioPacketAudit.observe(packet),
      })
      // A nominal Track DefaultDuration cannot represent the exact shortened
      // final sample of a non-frame-aligned sequence. Sample durations remain
      // authoritative, so do not ask the muxer to stamp one constant default.
      output.addVideoTrack(videoSource, {})
      output.addAudioTrack(audioSource)
    } catch (error) {
      throw classifyFailure('mux-construction-failed', error)
    }
    try {
      await output.start()
    } catch (error) {
      throw classifyFailure('mux-start-failed', error)
    }

    let frameIndex = 0
    let audioSampleOffset = 0
    emit('progress', progressPayload('encoding', payload, 0, 0))
    while (frameIndex < payload.frameCount || audioSampleOffset < payload.audioSampleCount) {
      throwIfAborted(signal)
      const nextFrameTime = frameIndex < payload.frameCount ? frameIndex / payload.fps : Number.POSITIVE_INFINITY
      const nextAudioTime = audioSampleOffset < payload.audioSampleCount
        ? audioSampleOffset / WORLD_WEBM_AUDIO_SAMPLE_RATE
        : Number.POSITIVE_INFINITY
      if (nextFrameTime <= nextAudioTime) {
        const frame = await request('read-frame', { sinkId, index: frameIndex })
        if (!isFramePayload(frame, frameIndex)) throw new WorldWebmAssemblyFailure('master-read-failed', 'World WebM frame master is invalid.')
        let bitmap: WorldWebmBitmap
        try {
          bitmap = await dependencies.decodePng(frame.bytes)
        } catch (error) {
          throw classifyFailure('master-decode-failed', error)
        }
        try {
          const plannedDuration = payload.frameDurations[frameIndex]
          const durationSeconds = plannedDuration.numerator / plannedDuration.denominator
          if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
            throw new WorldWebmAssemblyFailure('protocol-failed', 'World WebM frame duration is invalid.')
          }
          const sample = new dependencies.VideoSample(bitmap, {
            timestamp: frameIndex / payload.fps,
            duration: durationSeconds,
          })
          try {
            try { await videoSource.add(sample) }
            catch (error) { throw classifyFailure('codec-encode-failed', error) }
          } finally { sample.close() }
        } finally {
          bitmap.close()
        }
        frameIndex += 1
      } else {
        const count = Math.min(WORLD_WEBM_MAX_AUDIO_CHUNK_SAMPLES, payload.audioSampleCount - audioSampleOffset)
        const audio = await request('read-audio', { sinkId, sampleOffset: audioSampleOffset, sampleCount: count })
        if (!isAudioPayload(audio, audioSampleOffset, count)) {
          throw new WorldWebmAssemblyFailure('master-read-failed', 'World WebM audio master is invalid.')
        }
        const sample = new dependencies.AudioSample({
          data: audio.bytes,
          format: 's16',
          numberOfChannels: WORLD_WEBM_AUDIO_CHANNELS,
          sampleRate: WORLD_WEBM_AUDIO_SAMPLE_RATE,
          timestamp: audioSampleOffset / WORLD_WEBM_AUDIO_SAMPLE_RATE,
        })
        try {
          try { await audioSource.add(sample) }
          catch (error) { throw classifyFailure('codec-encode-failed', error) }
        } finally { sample.close() }
        audioSampleOffset += count
      }
      emit('progress', progressPayload('encoding', payload, frameIndex, audioSampleOffset))
    }
    closeSources()
    emit('progress', progressPayload('finalizing', payload, frameIndex, audioSampleOffset))
    try {
      await output.finalize()
    } catch (error) {
      throw classifyFailure('mux-finalize-failed', error)
    }
    audioPacketAudit.assertExactPresentationCoverage()
    throwIfAborted(signal)
    if (extent < 1) throw new WorldWebmAssemblyFailure('sink-failed', 'Mediabunny produced no WebM bytes.')
    const committed = await request('sink-commit', { sinkId, extent })
    if (!isArtifactPayload(committed) || committed.size !== extent) {
      throw new WorldWebmAssemblyFailure('sink-failed', 'World WebM commit result is invalid.')
    }
    emit('complete', committed)
    return { ok: true, size: committed.size, sha256: committed.sha256 }
  } catch (error) {
    closeSources()
    let failure = normalizeFailure(error, signal)
    let cleanupFailed = false
    if (output && output.state !== 'canceled' && output.state !== 'finalized') {
      try { await output.cancel() } catch { cleanupFailed = true }
    }
    if (sinkId) {
      try { await request('sink-abort', { sinkId }) } catch { cleanupFailed = true }
    }
    if (cleanupFailed && failure.code !== 'cancelled') {
      failure = new WorldWebmAssemblyFailure(
        'sink-failed',
        'World WebM assembly cleanup could not be confirmed.',
      )
    }
    emit('error', { code: failure.code, message: boundedMessage(failure.message) })
    return { ok: false, code: failure.code }
  }
}

/**
 * Mediabunny 1.55.4 writes Matroska Opus with CodecDelay=0 and has no
 * DiscardPadding input. Therefore its packet timeline is publishable only when
 * WebCodecs emits an already exact, zero-based presentation interval. Chromium
 * may append a full Opus packet while flushing; observing packet metadata here
 * lets that predictable encoder incompatibility fall back before sink commit.
 */
class MediabunnyOpusPacketAudit {
  private readonly expectedSampleCount: number
  private readonly maximumPacketCount: number
  private nextTimestampSamples = 0
  private packetCount = 0
  private invalid = false

  constructor(expectedSampleCount: number) {
    this.expectedSampleCount = expectedSampleCount
    this.maximumPacketCount = Math.ceil(expectedSampleCount / 120) + 1
  }

  observe(packet: WorldWebmEncodedAudioPacket): void {
    if (this.invalid) return
    try {
      this.packetCount += 1
      const timestampSamples = exactAudioSampleIndex(packet.timestamp)
      const durationSamples = exactAudioSampleIndex(packet.duration)
      if (this.packetCount > this.maximumPacketCount
        || !Number.isSafeInteger(packet.byteLength) || packet.byteLength < 1
        || timestampSamples === null || durationSamples === null
        || durationSamples < 120 || durationSamples > 5_760
        || timestampSamples !== this.nextTimestampSamples
        || this.nextTimestampSamples > Number.MAX_SAFE_INTEGER - durationSamples) {
        this.invalid = true
        return
      }
      this.nextTimestampSamples += durationSamples
      if (this.nextTimestampSamples > this.expectedSampleCount) this.invalid = true
    } catch {
      this.invalid = true
    }
  }

  assertExactPresentationCoverage(): void {
    if (this.invalid || this.packetCount < 1 || this.nextTimestampSamples !== this.expectedSampleCount) {
      throw new WorldWebmAssemblyFailure(
        'codec-encode-failed',
        'WebCodecs Opus output cannot be represented with exact Mediabunny presentation coverage.',
      )
    }
  }
}

function exactAudioSampleIndex(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null
  const scaled = seconds * WORLD_WEBM_AUDIO_SAMPLE_RATE
  if (!Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-7) return null
  return Math.round(scaled)
}

function progressPayload(
  phase: 'preflighting' | 'encoding' | 'finalizing',
  payload: WorldWebmStartPayload,
  completedFrames: number,
  completedAudioSamples: number,
) {
  return {
    phase,
    completedFrames,
    frameCount: payload.frameCount,
    completedAudioSamples,
    audioSampleCount: payload.audioSampleCount,
  }
}

function normalizeFailure(error: unknown, signal: AbortSignal): WorldWebmAssemblyFailure {
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new WorldWebmAssemblyFailure('cancelled', 'World WebM assembly was cancelled.')
  }
  if (error instanceof WorldWebmAssemblyFailure) return error
  if (error instanceof WorldWebmTransportFailure) return new WorldWebmAssemblyFailure(error.code, error.message)
  return new WorldWebmAssemblyFailure('internal-failed', error instanceof Error ? error.message : String(error))
}

function classifyFailure(code: WorldWebmFailureCode, error: unknown): WorldWebmAssemblyFailure {
  if (error instanceof WorldWebmAssemblyFailure) return error
  if (error instanceof WorldWebmTransportFailure) return new WorldWebmAssemblyFailure(error.code, error.message)
  return new WorldWebmAssemblyFailure(code, error instanceof Error ? error.message : String(error))
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error('World WebM assembly was cancelled.')
  error.name = 'AbortError'
  throw error
}

function isSinkBeginPayload(value: object): value is { sinkId: string } {
  return 'sinkId' in value && typeof value.sinkId === 'string' && /^sink-[a-f0-9]{32}$/.test(value.sinkId)
}

function isWritePayload(value: object): value is { written: number; extent: number } {
  return 'written' in value && 'extent' in value && Number.isSafeInteger(value.written) && Number.isSafeInteger(value.extent)
}

function isFramePayload(value: object, index: number): value is { index: number; size: number; sha256: string; bytes: ArrayBuffer } {
  return 'index' in value && value.index === index && 'size' in value && 'sha256' in value && 'bytes' in value
    && value.bytes instanceof ArrayBuffer && value.bytes.byteLength === value.size
}

function isAudioPayload(value: object, offset: number, count: number): value is { sampleOffset: number; sampleCount: number; bytes: ArrayBuffer } {
  return 'sampleOffset' in value && value.sampleOffset === offset && 'sampleCount' in value && value.sampleCount === count
    && 'bytes' in value && value.bytes instanceof ArrayBuffer && value.bytes.byteLength === count * 4
}

function isArtifactPayload(value: object): value is { size: number; sha256: string } {
  return 'size' in value && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size > 0
    && 'sha256' in value && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
}

function boundedMessage(value: string): string {
  const source = value || 'World WebM assembly failed.'
  let result = ''
  for (let index = 0; index < source.length && result.length < 512; index += 1) {
    const code = source.charCodeAt(index)
    result += code < 0x20 || code === 0x7f ? ' ' : source[index]
  }
  return result || 'World WebM assembly failed.'
}
