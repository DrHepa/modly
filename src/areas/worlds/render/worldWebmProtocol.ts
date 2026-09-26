import {
  WORLD_RENDER_ARTIFACT_MAX_BYTES,
  WORLD_RENDER_FPS_VALUES,
  WORLD_RENDER_MAX_HEIGHT,
  WORLD_RENDER_MAX_PIXELS,
  WORLD_RENDER_MAX_WIDTH,
  WORLD_RENDER_MIN_HEIGHT,
  WORLD_RENDER_MIN_WIDTH,
  isWorldRenderJobId,
} from '../../../shared/types/worldRenders.ts'
import type { WorldRationalTime } from '../core/worldModel.ts'

export const WORLD_WEBM_PROTOCOL = 'modly.world-webm-assembly.v1' as const
export const WORLD_WEBM_AUDIO_SAMPLE_RATE = 48_000 as const
export const WORLD_WEBM_AUDIO_CHANNELS = 2 as const
export const WORLD_WEBM_MAX_DURATION_SECONDS = 15 * 60
export const WORLD_WEBM_MAX_AUDIO_SAMPLES = WORLD_WEBM_AUDIO_SAMPLE_RATE * WORLD_WEBM_MAX_DURATION_SECONDS
export const WORLD_WEBM_MAX_FRAME_COUNT = 60 * WORLD_WEBM_MAX_DURATION_SECONDS
export const WORLD_WEBM_MAX_FRAME_BYTES = WORLD_RENDER_ARTIFACT_MAX_BYTES.frame
export const WORLD_WEBM_MAX_AUDIO_CHUNK_SAMPLES = WORLD_WEBM_AUDIO_SAMPLE_RATE
export const WORLD_WEBM_MAX_WRITE_BYTES = 8 * 1024 * 1024
export const WORLD_WEBM_MAX_OUTPUT_BYTES = WORLD_RENDER_ARTIFACT_MAX_BYTES.webm
export const WORLD_WEBM_MAX_REQUEST_ID = 2_000_000
export const WORLD_WEBM_DEFAULT_TIMEOUT_MS = 120_000

export type WorldWebmRequestKind =
  | 'preflight'
  | 'sink-begin'
  | 'read-frame'
  | 'read-audio'
  | 'sink-write'
  | 'sink-commit'
  | 'sink-abort'

export interface WorldWebmStartPayload {
  width: number
  height: number
  fps: 24 | 25 | 30 | 60
  frameCount: number
  duration: { numerator: number; denominator: number }
  frameDurations: readonly WorldRationalTime[]
  audioSampleCount: number
  videoBitrate: number
  audioBitrate: 128_000
}

export type WorldWebmMainCommand =
  | WorldWebmEnvelope<'start', WorldWebmStartPayload>
  | WorldWebmEnvelope<'abort', Record<never, never>>

export interface WorldWebmEnvelope<K extends string, P> {
  protocol: typeof WORLD_WEBM_PROTOCOL
  jobId: string
  generation: string
  requestId: number
  kind: K
  payload: P
}

export type WorldWebmWorkerRequest =
  | WorldWebmEnvelope<'preflight', {
      width: number
      height: number
      fps: 24 | 25 | 30 | 60
      videoCodec: 'vp9'
      videoBitrate: number
      audioCodec: 'opus'
      audioBitrate: 128_000
      audioSampleRate: 48_000
      audioChannels: 2
    }>
  | WorldWebmEnvelope<'sink-begin', Record<never, never>>
  | WorldWebmEnvelope<'read-frame', { sinkId: string; index: number }>
  | WorldWebmEnvelope<'read-audio', { sinkId: string; sampleOffset: number; sampleCount: number }>
  | WorldWebmEnvelope<'sink-write', { sinkId: string; position: number; bytes: ArrayBuffer }>
  | WorldWebmEnvelope<'sink-commit', { sinkId: string; extent: number }>
  | WorldWebmEnvelope<'sink-abort', { sinkId: string }>

export type WorldWebmProgressPhase = 'preflighting' | 'encoding' | 'finalizing'

export type WorldWebmFailureCode =
  | 'codec-unavailable'
  | 'codec-encode-failed'
  | 'mux-construction-failed'
  | 'mux-start-failed'
  | 'mux-finalize-failed'
  | 'master-read-failed'
  | 'master-decode-failed'
  | 'sink-failed'
  | 'worker-crashed'
  | 'worker-timeout'
  | 'protocol-failed'
  | 'cancelled'
  | 'internal-failed'

export type WorldWebmAssemblyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: WorldWebmFailureCode }

export type WorldWebmWorkerEvent =
  | WorldWebmEnvelope<'progress', {
      phase: WorldWebmProgressPhase
      completedFrames: number
      frameCount: number
      completedAudioSamples: number
      audioSampleCount: number
    }>
  | WorldWebmEnvelope<'complete', { size: number; sha256: string }>
  | WorldWebmEnvelope<'error', {
      code: WorldWebmFailureCode
      message: string
    }>

export type WorldWebmWorkerMessage = WorldWebmWorkerRequest | WorldWebmWorkerEvent

export type WorldWebmSuccessPayload =
  | Record<never, never>
  | { sinkId: string }
  | { index: number; size: number; sha256: string; bytes: ArrayBuffer }
  | { sampleOffset: number; sampleCount: number; bytes: ArrayBuffer }
  | { written: number; extent: number }
  | { size: number; sha256: string }

export type WorldWebmMainResponse =
  | {
      protocol: typeof WORLD_WEBM_PROTOCOL
      jobId: string
      generation: string
      requestId: number
      kind: 'response'
      requestKind: WorldWebmRequestKind
      ok: true
      payload: WorldWebmSuccessPayload
    }
  | {
      protocol: typeof WORLD_WEBM_PROTOCOL
      jobId: string
      generation: string
      requestId: number
      kind: 'response'
      requestKind: WorldWebmRequestKind
      ok: false
      error: {
        code: 'invalid-request' | 'master-invalid' | 'read-failed' | 'write-failed' | 'cancelled'
        message: string
      }
    }

export interface WorldWebmMessageIdentity {
  jobId: string
  generation: string
}

export function peekWorldWebmMessageIdentity(value: unknown): WorldWebmMessageIdentity | null {
  const record = inspectPlainRecord(value)
  if (!record || !isWorldRenderJobId(record.jobId) || !isGeneration(record.generation)) return null
  return { jobId: record.jobId, generation: record.generation }
}

export function parseWorldWebmMainCommand(value: unknown): WorldWebmMainCommand | null {
  const record = exactRecord(value, ['protocol', 'jobId', 'generation', 'requestId', 'kind', 'payload'])
  if (!record || !isIdentity(record)) return null
  if (record.kind === 'abort') return isEmptyRecord(record.payload) ? value as WorldWebmMainCommand : null
  if (record.kind !== 'start' || !parseStartPayload(record.payload)) return null
  return value as WorldWebmMainCommand
}

export function parseWorldWebmWorkerMessage(value: unknown): WorldWebmWorkerMessage | null {
  const record = exactRecord(value, ['protocol', 'jobId', 'generation', 'requestId', 'kind', 'payload'])
  if (!record || !isIdentity(record)) return null
  switch (record.kind) {
    case 'preflight': return parsePreflight(record.payload) ? value as WorldWebmWorkerMessage : null
    case 'sink-begin': return isEmptyRecord(record.payload) ? value as WorldWebmWorkerMessage : null
    case 'read-frame': return parseReadFrame(record.payload) ? value as WorldWebmWorkerMessage : null
    case 'read-audio': return parseReadAudio(record.payload) ? value as WorldWebmWorkerMessage : null
    case 'sink-write': return parseSinkWrite(record.payload) ? value as WorldWebmWorkerMessage : null
    case 'sink-commit': return parseSinkCommit(record.payload) ? value as WorldWebmWorkerMessage : null
    case 'sink-abort': return parseSinkAbort(record.payload) ? value as WorldWebmWorkerMessage : null
    case 'progress': return parseProgress(record.payload) ? value as WorldWebmWorkerMessage : null
    case 'complete': return parseArtifactResult(record.payload) ? value as WorldWebmWorkerMessage : null
    case 'error': return parseWorkerError(record.payload) ? value as WorldWebmWorkerMessage : null
    default: return null
  }
}

export function parseWorldWebmMainResponse(value: unknown): WorldWebmMainResponse | null {
  const inspected = inspectPlainRecord(value)
  if (!inspected || inspected.kind !== 'response' || typeof inspected.ok !== 'boolean') return null
  if (inspected.ok) {
    const record = exactRecord(value, [
      'protocol', 'jobId', 'generation', 'requestId', 'kind', 'requestKind', 'ok', 'payload',
    ])
    if (!record || !isIdentity(record) || record.ok !== true || !isRequestKind(record.requestKind)
      || !parseSuccessPayload(record.requestKind, record.payload)) return null
  } else {
    const record = exactRecord(value, [
      'protocol', 'jobId', 'generation', 'requestId', 'kind', 'requestKind', 'ok', 'error',
    ])
    if (!record || !isIdentity(record) || record.ok !== false || !isRequestKind(record.requestKind)) return null
    const error = exactRecord(record.error, ['code', 'message'])
    if (!error || !['invalid-request', 'master-invalid', 'read-failed', 'write-failed', 'cancelled'].includes(String(error.code))
      || !isBoundedText(error.message, 512)) return null
  }
  return value as WorldWebmMainResponse
}

export function worldWebmVideoBitrate(width: number, height: number, fps: number): number {
  if (!isDimensions(width, height) || !(WORLD_RENDER_FPS_VALUES as readonly number[]).includes(fps)) {
    throw new TypeError('World WebM video dimensions or frame rate are invalid.')
  }
  return Math.max(500_000, Math.min(80_000_000, Math.round(width * height * fps * 0.075)))
}

function parseStartPayload(value: unknown): value is WorldWebmStartPayload {
  const record = exactRecord(value, [
    'width', 'height', 'fps', 'frameCount', 'duration', 'frameDurations',
    'audioSampleCount', 'videoBitrate', 'audioBitrate',
  ])
  if (!record || !isDimensions(record.width, record.height)
    || !(WORLD_RENDER_FPS_VALUES as readonly unknown[]).includes(record.fps)
    || !isInteger(record.frameCount, 1, WORLD_WEBM_MAX_FRAME_COUNT)
    || !isInteger(record.audioSampleCount, 1, WORLD_WEBM_MAX_AUDIO_SAMPLES)
    || !isInteger(record.videoBitrate, 500_000, 80_000_000) || record.audioBitrate !== 128_000) return false
  const duration = exactRecord(record.duration, ['numerator', 'denominator'])
  if (!duration || !isInteger(duration.numerator, 1, Number.MAX_SAFE_INTEGER)
    || !isInteger(duration.denominator, 1, Number.MAX_SAFE_INTEGER)) return false
  const durationNumerator = BigInt(duration.numerator as number)
  const durationDenominator = BigInt(duration.denominator as number)
  if (durationNumerator > BigInt(WORLD_WEBM_MAX_DURATION_SECONDS) * durationDenominator) return false
  const expectedFrames = (durationNumerator * BigInt(record.fps as number) + durationDenominator - 1n) / durationDenominator
  const expectedSamples = durationNumerator * BigInt(WORLD_WEBM_AUDIO_SAMPLE_RATE) / durationDenominator
  return expectedFrames === BigInt(record.frameCount as number)
    && parseFrameDurations(
      record.frameDurations,
      record.frameCount as number,
      record.fps as number,
      durationNumerator,
      durationDenominator,
    )
    && expectedSamples === BigInt(record.audioSampleCount as number)
    && record.videoBitrate === worldWebmVideoBitrate(record.width as number, record.height as number, record.fps as number)
}

function parseFrameDurations(
  value: unknown,
  frameCount: number,
  fps: number,
  totalNumerator: bigint,
  totalDenominator: bigint,
): boolean {
  const durations = inspectExactArray(value, frameCount)
  if (!durations) return false
  for (let index = 0; index < durations.length; index += 1) {
    const duration = exactRecord(durations[index], ['numerator', 'denominator'])
    if (!duration || !isInteger(duration.numerator, 1, Number.MAX_SAFE_INTEGER)
      || !isInteger(duration.denominator, 1, Number.MAX_SAFE_INTEGER)) return false
    const numerator = BigInt(duration.numerator as number)
    const denominator = BigInt(duration.denominator as number)
    if (index + 1 < frameCount) {
      if (numerator * BigInt(fps) !== denominator) return false
      continue
    }
    const remainingNumerator = totalNumerator * BigInt(fps)
      - BigInt(frameCount - 1) * totalDenominator
    const remainingDenominator = totalDenominator * BigInt(fps)
    if (remainingNumerator <= 0n
      || numerator * remainingDenominator !== remainingNumerator * denominator) return false
  }
  return true
}

function inspectExactArray(value: unknown, exactLength: number): readonly unknown[] | null {
  if (!Array.isArray(value) || value.length !== exactLength) return null
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const expectedKeys = Array.from({ length: exactLength }, (_unused, index) => String(index))
    const actualKeys = Object.keys(descriptors).filter((key) => key !== 'length').sort((left, right) => Number(left) - Number(right))
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return null
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !('value' in descriptor)) return null
    }
    return expectedKeys.map((key) => descriptors[key].value)
  } catch {
    return null
  }
}

function parsePreflight(value: unknown): boolean {
  const record = exactRecord(value, [
    'width', 'height', 'fps', 'videoCodec', 'videoBitrate', 'audioCodec', 'audioBitrate', 'audioSampleRate', 'audioChannels',
  ])
  return Boolean(record && isDimensions(record.width, record.height)
    && (WORLD_RENDER_FPS_VALUES as readonly unknown[]).includes(record.fps)
    && record.videoCodec === 'vp9' && isInteger(record.videoBitrate, 500_000, 80_000_000)
    && record.audioCodec === 'opus' && record.audioBitrate === 128_000
    && record.audioSampleRate === WORLD_WEBM_AUDIO_SAMPLE_RATE && record.audioChannels === WORLD_WEBM_AUDIO_CHANNELS)
}

function parseReadFrame(value: unknown): boolean {
  const record = exactRecord(value, ['sinkId', 'index'])
  return Boolean(record && isSinkId(record.sinkId) && isInteger(record.index, 0, WORLD_WEBM_MAX_FRAME_COUNT - 1))
}

function parseReadAudio(value: unknown): boolean {
  const record = exactRecord(value, ['sinkId', 'sampleOffset', 'sampleCount'])
  return Boolean(record && isSinkId(record.sinkId)
    && isInteger(record.sampleOffset, 0, WORLD_WEBM_MAX_AUDIO_SAMPLES - 1)
    && isInteger(record.sampleCount, 1, WORLD_WEBM_MAX_AUDIO_CHUNK_SAMPLES)
    && (record.sampleOffset as number) + (record.sampleCount as number) <= WORLD_WEBM_MAX_AUDIO_SAMPLES)
}

function parseSinkWrite(value: unknown): boolean {
  const record = exactRecord(value, ['sinkId', 'position', 'bytes'])
  const byteLength = arrayBufferLength(record?.bytes)
  return Boolean(record && isSinkId(record.sinkId) && isInteger(record.position, 0, WORLD_WEBM_MAX_OUTPUT_BYTES - 1)
    && byteLength !== null && byteLength >= 1 && byteLength <= WORLD_WEBM_MAX_WRITE_BYTES
    && (record.position as number) + byteLength <= WORLD_WEBM_MAX_OUTPUT_BYTES)
}

function parseSinkCommit(value: unknown): boolean {
  const record = exactRecord(value, ['sinkId', 'extent'])
  return Boolean(record && isSinkId(record.sinkId) && isInteger(record.extent, 1, WORLD_WEBM_MAX_OUTPUT_BYTES))
}

function parseSinkAbort(value: unknown): boolean {
  const record = exactRecord(value, ['sinkId'])
  return Boolean(record && isSinkId(record.sinkId))
}

function parseProgress(value: unknown): boolean {
  const record = exactRecord(value, [
    'phase', 'completedFrames', 'frameCount', 'completedAudioSamples', 'audioSampleCount',
  ])
  return Boolean(record && ['preflighting', 'encoding', 'finalizing'].includes(String(record.phase))
    && isInteger(record.frameCount, 1, WORLD_WEBM_MAX_FRAME_COUNT)
    && isInteger(record.completedFrames, 0, record.frameCount as number)
    && isInteger(record.audioSampleCount, 1, WORLD_WEBM_MAX_AUDIO_SAMPLES)
    && isInteger(record.completedAudioSamples, 0, record.audioSampleCount as number))
}

function parseWorkerError(value: unknown): boolean {
  const record = exactRecord(value, ['code', 'message'])
  return Boolean(record && [
    'codec-unavailable', 'codec-encode-failed',
    'mux-construction-failed', 'mux-start-failed', 'mux-finalize-failed',
    'master-read-failed', 'master-decode-failed', 'sink-failed',
    'worker-crashed', 'worker-timeout', 'protocol-failed', 'cancelled', 'internal-failed',
  ].includes(String(record.code))
    && isBoundedText(record.message, 512))
}

function parseSuccessPayload(kind: WorldWebmRequestKind, value: unknown): boolean {
  if (kind === 'preflight' || kind === 'sink-abort') return isEmptyRecord(value)
  if (kind === 'sink-begin') {
    const record = exactRecord(value, ['sinkId'])
    return Boolean(record && isSinkId(record.sinkId))
  }
  if (kind === 'read-frame') {
    const record = exactRecord(value, ['index', 'size', 'sha256', 'bytes'])
    const length = arrayBufferLength(record?.bytes)
    return Boolean(record && isInteger(record.index, 0, WORLD_WEBM_MAX_FRAME_COUNT - 1)
      && isInteger(record.size, 1, WORLD_WEBM_MAX_FRAME_BYTES) && isSha256(record.sha256)
      && length === record.size)
  }
  if (kind === 'read-audio') {
    const record = exactRecord(value, ['sampleOffset', 'sampleCount', 'bytes'])
    const length = arrayBufferLength(record?.bytes)
    return Boolean(record && isInteger(record.sampleOffset, 0, WORLD_WEBM_MAX_AUDIO_SAMPLES - 1)
      && isInteger(record.sampleCount, 1, WORLD_WEBM_MAX_AUDIO_CHUNK_SAMPLES)
      && length === (record.sampleCount as number) * 4)
  }
  if (kind === 'sink-write') {
    const record = exactRecord(value, ['written', 'extent'])
    return Boolean(record && isInteger(record.written, 1, WORLD_WEBM_MAX_WRITE_BYTES)
      && isInteger(record.extent, 1, WORLD_WEBM_MAX_OUTPUT_BYTES))
  }
  return parseArtifactResult(value)
}

function parseArtifactResult(value: unknown): boolean {
  const record = exactRecord(value, ['size', 'sha256'])
  return Boolean(record && isInteger(record.size, 1, WORLD_WEBM_MAX_OUTPUT_BYTES) && isSha256(record.sha256))
}

function isIdentity(record: Record<string, unknown>): boolean {
  return record.protocol === WORLD_WEBM_PROTOCOL && isWorldRenderJobId(record.jobId)
    && isGeneration(record.generation) && isInteger(record.requestId, 1, WORLD_WEBM_MAX_REQUEST_ID)
}

function isRequestKind(value: unknown): value is WorldWebmRequestKind {
  return ['preflight', 'sink-begin', 'read-frame', 'read-audio', 'sink-write', 'sink-commit', 'sink-abort'].includes(String(value))
}

function isDimensions(width: unknown, height: unknown): boolean {
  return isInteger(width, WORLD_RENDER_MIN_WIDTH, WORLD_RENDER_MAX_WIDTH)
    && isInteger(height, WORLD_RENDER_MIN_HEIGHT, WORLD_RENDER_MAX_HEIGHT)
    && (width as number) * (height as number) <= WORLD_RENDER_MAX_PIXELS
}

function isGeneration(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function isSinkId(value: unknown): value is string {
  return typeof value === 'string' && /^sink-[a-f0-9]{32}$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum
    && [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
}

function arrayBufferLength(value: unknown): number | null {
  try {
    return value instanceof ArrayBuffer && Object.getPrototypeOf(value) === ArrayBuffer.prototype
      ? value.byteLength
      : null
  } catch {
    return null
  }
}

function isEmptyRecord(value: unknown): boolean {
  return Boolean(exactRecord(value, []))
}

function inspectPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length) return null
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) return null
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
  } catch {
    return null
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = inspectPlainRecord(value)
  if (!record) return null
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null
  return record
}
