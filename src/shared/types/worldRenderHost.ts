import {
  parseWorldSceneDocument,
  parseWorldSequenceDocument,
} from '../../areas/worlds/core/worldDocuments.ts'
import type { WorldSceneDocumentV1, WorldSequence } from '../../areas/worlds/core/worldModel.ts'
import {
  isWorldCanonicalId,
  WORLD_MAX_COLLECTION_ITEMS,
} from '../../areas/worlds/core/worldValidationLimits.ts'
import {
  normalizeWorldRationalTime,
  subtractWorldRationalTime,
  type WorldFrameTime,
} from '../../areas/worlds/cinematic/worldRationalTime.ts'
import {
  WORLD_RENDER_FPS_VALUES,
  WORLD_RENDER_MAX_FRAME_COUNT,
  WORLD_RENDER_MAX_HEIGHT,
  WORLD_RENDER_MAX_PIXELS,
  WORLD_RENDER_MAX_WIDTH,
  WORLD_RENDER_MIN_HEIGHT,
  WORLD_RENDER_MIN_WIDTH,
  isWorldRenderJobId,
  type WorldRenderPreset,
} from './worldRenders.ts'

export const WORLD_RENDER_HOST_PROTOCOL = 'modly.world-render-host.v1' as const
export const WORLD_RENDER_HOST_CONNECT_CHANNEL = 'world-render-host:connect' as const
export const WORLD_RENDER_HOST_MAX_RESOURCE_BYTES = 512 * 1024 * 1024
export const WORLD_RENDER_HOST_MAX_FRAME_BYTES = 256 * 1024 * 1024
export const WORLD_RENDER_HOST_MAX_AUDIO_BYTES = 1024 * 1024 * 1024
export const WORLD_RENDER_HOST_MAX_AUDIO_SAMPLES = 48_000 * 15 * 60
export const WORLD_RENDER_HOST_MAX_RESOURCE_REQUESTS = WORLD_MAX_COLLECTION_ITEMS
export const WORLD_RENDER_HOST_MAX_CONCURRENT_RESOURCE_REQUESTS = 16
export const WORLD_RENDER_HOST_DEFAULT_TIMEOUT_MS = 120_000
export const WORLD_RENDER_HOST_MAX_TIMEOUT_MS = 10 * 60_000

export type WorldRenderPinnedResourceRole = 'primary' | 'source' | 'legacy'

export interface WorldRenderHostResourceDescriptor {
  id: string
  name: string
  type: 'model' | 'animation' | 'audio' | 'environment'
  format: string
  clipId?: string
  clipName?: string
  /** Explicit gltf-clip source order; absent records retain their legacy policy. */
  clipIndex?: number
  durationSeconds?: number
  boundModelResourceId?: string
  files: readonly {
    role: WorldRenderPinnedResourceRole
    size: number
    sha256: string
  }[]
}

export interface WorldRenderHostSnapshot {
  snapshotSha256: string
  projectId: string
  revision: number
  scene: WorldSceneDocumentV1
  sequence: WorldSequence
  resources: readonly WorldRenderHostResourceDescriptor[]
}

export interface WorldRenderHostInitializePayload {
  snapshot: WorldRenderHostSnapshot
  preset: WorldRenderPreset
  framePlan: readonly WorldFrameTime[]
}

export interface WorldRenderHostFrameRequest {
  index: number
  time: WorldFrameTime['time']
  timestampMicroseconds: number
}

export type WorldRenderHostCommand =
  | WorldRenderHostEnvelope<'initialize', WorldRenderHostInitializePayload>
  | WorldRenderHostEnvelope<'render-frame', WorldRenderHostFrameRequest>
  | WorldRenderHostEnvelope<'render-audio', Record<never, never>>
  | WorldRenderHostEnvelope<'dispose', Record<never, never>>

export interface WorldRenderHostEnvelope<K extends string, P> {
  protocol: typeof WORLD_RENDER_HOST_PROTOCOL
  jobId: string
  generation: string
  requestId: number
  kind: K
  payload: P
}

export interface WorldRenderHostFrameResult {
  index: number
  width: number
  height: number
  rgbaSha256: string
  /** Bottom-up RGBA8 pixels returned directly by WebGL readPixels. */
  rgba: ArrayBuffer
}

export interface WorldRenderHostAudioResult {
  sampleRate: 48_000
  channels: 2
  sampleCount: number
  pcmSha256: string
  wav: ArrayBuffer
}

export type WorldRenderHostResponse =
  | WorldRenderHostSuccessResponse<'initialize', Record<never, never>>
  | WorldRenderHostSuccessResponse<'render-frame', WorldRenderHostFrameResult>
  | WorldRenderHostSuccessResponse<'render-audio', WorldRenderHostAudioResult>
  | WorldRenderHostSuccessResponse<'dispose', Record<never, never>>
  | WorldRenderHostFailureResponse

export interface WorldRenderHostSuccessResponse<K extends string, P> extends WorldRenderHostEnvelope<K, P> {
  ok: true
}

export interface WorldRenderHostFailureResponse extends Omit<WorldRenderHostEnvelope<string, never>, 'payload'> {
  ok: false
  error: {
    code: 'invalid-command' | 'invalid-resource' | 'unsupported-resource' | 'decode-failed' | 'render-failed' | 'audio-failed' | 'gpu-context-lost' | 'cancelled'
    message: string
  }
}

export interface WorldRenderHostResourceRequest {
  protocol: typeof WORLD_RENDER_HOST_PROTOCOL
  jobId: string
  generation: string
  resourceId: string
  role: WorldRenderPinnedResourceRole
}

export interface WorldRenderHostResourcePortRequest extends WorldRenderHostResourceRequest {
  kind: 'resource-request'
  requestId: number
}

export type WorldRenderHostResourceFailureCode =
  | 'invalid-request'
  | 'resource-not-found'
  | 'resource-invalid'
  | 'cancelled'

export type WorldRenderHostResourceResult =
  | { ok: true; resourceId: string; role: WorldRenderPinnedResourceRole; size: number; sha256: string; bytes: ArrayBuffer }
  | { ok: false; code: WorldRenderHostResourceFailureCode; message: string }

export interface WorldRenderHostResourcePortResult {
  protocol: typeof WORLD_RENDER_HOST_PROTOCOL
  jobId: string
  generation: string
  kind: 'resource-result'
  requestId: number
  result: WorldRenderHostResourceResult
}

export interface WorldRenderHostMessageIdentity {
  readonly jobId: string
  readonly generation: string
}

/** Reads only routing data. Acceptance still requires one of the exact parsers below. */
export function peekWorldRenderHostMessageIdentity(value: unknown): WorldRenderHostMessageIdentity | null {
  const record = inspectPlainRecord(value)
  if (!record) return null
  return isWorldRenderJobId(record.jobId) && isGeneration(record.generation)
    ? { jobId: record.jobId, generation: record.generation }
    : null
}

export function parseWorldRenderHostCommand(value: unknown): WorldRenderHostCommand | null {
  const record = exactRecord(value, ['protocol', 'jobId', 'generation', 'requestId', 'kind', 'payload'])
  if (!record || !isEnvelopeIdentity(record)) return null
  if (record.kind === 'initialize') {
    return parseWorldRenderHostInitializePayload(record.payload) ? value as WorldRenderHostCommand : null
  }
  if (record.kind === 'render-frame') {
    return parseWorldRenderHostFrameRequest(record.payload) ? value as WorldRenderHostCommand : null
  }
  if ((record.kind === 'render-audio' || record.kind === 'dispose') && isEmptyRecord(record.payload)) {
    return value as WorldRenderHostCommand
  }
  return null
}

export function parseWorldRenderHostInitializePayload(value: unknown): WorldRenderHostInitializePayload | null {
  const payload = exactRecord(value, ['snapshot', 'preset', 'framePlan'])
  if (!payload) return null
  const snapshot = exactRecord(payload.snapshot, [
    'snapshotSha256', 'projectId', 'revision', 'scene', 'sequence', 'resources',
  ])
  if (!snapshot || !isSha256(snapshot.snapshotSha256) || !isWorldCanonicalId(snapshot.projectId)
    || !Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0) return null
  const parsedScene = parseWorldSceneDocument(snapshot.scene)
  const parsedSequence = parseWorldSequenceDocument(snapshot.sequence)
  if (!parsedScene.success || !parsedSequence.success || parsedScene.value.projectId !== snapshot.projectId) return null
  const sceneSequence = parsedScene.value.sequences.find((candidate) => candidate.id === parsedSequence.value.id)
  if (!sceneSequence || JSON.stringify(sceneSequence) !== JSON.stringify(parsedSequence.value)) return null
  const resources = parseResourceDescriptors(snapshot.resources)
  const preset = parsePreset(payload.preset)
  if (!resources || !preset || !parseFramePlan(payload.framePlan, preset, parsedSequence.value)) return null
  return value as WorldRenderHostInitializePayload
}

export function parseWorldRenderHostFrameRequest(value: unknown): WorldRenderHostFrameRequest | null {
  const frame = exactRecord(value, ['index', 'time', 'timestampMicroseconds'])
  if (!frame || !Number.isSafeInteger(frame.index) || (frame.index as number) < 0
    || (frame.index as number) >= WORLD_RENDER_MAX_FRAME_COUNT
    || !Number.isSafeInteger(frame.timestampMicroseconds) || (frame.timestampMicroseconds as number) < 0
    || !parseCanonicalRational(frame.time)) return null
  return value as WorldRenderHostFrameRequest
}

export function parseWorldRenderHostResourcePortRequest(value: unknown): WorldRenderHostResourcePortRequest | null {
  const record = exactRecord(value, ['protocol', 'jobId', 'generation', 'resourceId', 'role', 'kind', 'requestId'])
  if (!record || record.kind !== 'resource-request' || !isEnvelopeIdentity(record)
    || !isWorldCanonicalId(record.resourceId) || !isResourceRole(record.role)) return null
  return value as WorldRenderHostResourcePortRequest
}

export function parseWorldRenderHostResourcePortResult(value: unknown): WorldRenderHostResourcePortResult | null {
  const record = exactRecord(value, ['protocol', 'jobId', 'generation', 'kind', 'requestId', 'result'])
  if (!record || record.kind !== 'resource-result' || !isEnvelopeIdentity(record)) return null
  const result = inspectPlainRecord(record.result)
  if (!result || typeof result.ok !== 'boolean') return null
  if (result.ok === false) {
    const failure = exactRecord(record.result, ['ok', 'code', 'message'])
    if (!failure || !isResourceFailureCode(failure.code) || !isBoundedText(failure.message, 512)) return null
  } else {
    const success = exactRecord(record.result, ['ok', 'resourceId', 'role', 'size', 'sha256', 'bytes'])
    if (!success || success.ok !== true || !isWorldCanonicalId(success.resourceId)
      || !isResourceRole(success.role) || !isBoundedResourceSize(success.size)
      || !isSha256(success.sha256) || !(success.bytes instanceof ArrayBuffer)
      || success.bytes.byteLength !== success.size) return null
  }
  return value as WorldRenderHostResourcePortResult
}

export function parseWorldRenderHostResourceRequest(value: unknown): WorldRenderHostResourceRequest | null {
  const record = exactRecord(value, ['protocol', 'jobId', 'generation', 'resourceId', 'role'])
  if (!record || record.protocol !== WORLD_RENDER_HOST_PROTOCOL || !isWorldRenderJobId(record.jobId)
    || !isGeneration(record.generation) || !isWorldCanonicalId(record.resourceId)
    || !isResourceRole(record.role)) return null
  return value as WorldRenderHostResourceRequest
}

export function parseWorldRenderHostResponse(value: unknown): WorldRenderHostResponse | null {
  const inspected = inspectPlainRecord(value)
  if (!inspected || typeof inspected.ok !== 'boolean') return null
  if (inspected.ok === false) {
    const failure = exactRecord(value, ['protocol', 'jobId', 'generation', 'requestId', 'kind', 'ok', 'error'])
    if (!failure || !isEnvelopeIdentity(failure) || !isResponseKind(failure.kind) || !isExactError(failure.error)) return null
    return value as WorldRenderHostFailureResponse
  }
  const success = exactRecord(value, ['protocol', 'jobId', 'generation', 'requestId', 'kind', 'ok', 'payload'])
  if (!success || success.ok !== true || !isEnvelopeIdentity(success) || !isResponseKind(success.kind)) return null
  if (success.kind === 'render-frame') {
    const frame = exactRecord(success.payload, ['index', 'width', 'height', 'rgbaSha256', 'rgba'])
    if (!frame || !Number.isSafeInteger(frame.index) || (frame.index as number) < 0
      || !isRenderDimensions(frame.width, frame.height) || !isSha256(frame.rgbaSha256)
      || !(frame.rgba instanceof ArrayBuffer)
      || frame.rgba.byteLength !== (frame.width as number) * (frame.height as number) * 4
      || frame.rgba.byteLength > WORLD_RENDER_HOST_MAX_FRAME_BYTES) return null
  } else if (success.kind === 'render-audio') {
    const audio = exactRecord(success.payload, ['sampleRate', 'channels', 'sampleCount', 'pcmSha256', 'wav'])
    if (!audio || audio.sampleRate !== 48_000 || audio.channels !== 2
      || !Number.isSafeInteger(audio.sampleCount) || (audio.sampleCount as number) < 0
      || (audio.sampleCount as number) > WORLD_RENDER_HOST_MAX_AUDIO_SAMPLES
      || !isSha256(audio.pcmSha256) || !(audio.wav instanceof ArrayBuffer)
      || audio.wav.byteLength !== 44 + (audio.sampleCount as number) * 4
      || audio.wav.byteLength > WORLD_RENDER_HOST_MAX_AUDIO_BYTES) return null
  } else if (!isEmptyRecord(success.payload)) return null
  return value as WorldRenderHostResponse
}

function parseResourceDescriptors(value: unknown): readonly WorldRenderHostResourceDescriptor[] | null {
  const resources = exactArray(value, WORLD_MAX_COLLECTION_ITEMS)
  if (!resources) return null
  const ids = new Set<string>()
  for (const value of resources) {
    const descriptor = exactRecord(
      value,
      ['id', 'name', 'type', 'format', 'files'],
      ['clipId', 'clipName', 'clipIndex', 'durationSeconds', 'boundModelResourceId'],
    )
    if (!descriptor || !isWorldCanonicalId(descriptor.id) || ids.has(descriptor.id)
      || !isBoundedText(descriptor.name, 256) || !isBoundedText(descriptor.format, 64)
      || !['model', 'animation', 'audio', 'environment'].includes(String(descriptor.type))) return null
    ids.add(descriptor.id)
    const isAnimation = descriptor.type === 'animation'
    if (!isAnimation && ['clipId', 'clipName', 'clipIndex', 'durationSeconds', 'boundModelResourceId']
      .some((key) => Object.hasOwn(descriptor, key))) return null
    if (Object.hasOwn(descriptor, 'clipId') && !isWorldCanonicalId(descriptor.clipId)) return null
    if (Object.hasOwn(descriptor, 'clipName') && !isBoundedText(descriptor.clipName, 256)) return null
    if (Object.hasOwn(descriptor, 'clipIndex')
      && (!isAnimation || descriptor.format !== 'gltf-clip' || typeof descriptor.clipIndex !== 'number'
        || !Number.isSafeInteger(descriptor.clipIndex) || descriptor.clipIndex < 0)) return null
    if (Object.hasOwn(descriptor, 'durationSeconds')
      && (typeof descriptor.durationSeconds !== 'number' || !Number.isFinite(descriptor.durationSeconds)
        || descriptor.durationSeconds < 0 || descriptor.durationSeconds > 86_400)) return null
    if (Object.hasOwn(descriptor, 'boundModelResourceId') && !isWorldCanonicalId(descriptor.boundModelResourceId)) return null
    if (isAnimation && !Object.hasOwn(descriptor, 'boundModelResourceId')) return null
    const files = exactArray(descriptor.files, 3)
    if (!files || files.length < 1) return null
    const roles = new Set<WorldRenderPinnedResourceRole>()
    for (const value of files) {
      const file = exactRecord(value, ['role', 'size', 'sha256'])
      if (!file || !isResourceRole(file.role) || roles.has(file.role)
        || !isBoundedResourceSize(file.size) || !isSha256(file.sha256)) return null
      roles.add(file.role)
    }
    if (!roles.has('primary')) return null
  }
  return resources as readonly WorldRenderHostResourceDescriptor[]
}

function parsePreset(value: unknown): WorldRenderPreset | null {
  const preset = exactRecord(value, ['width', 'height', 'fps'])
  if (!preset || !isRenderDimensions(preset.width, preset.height)
    || !(WORLD_RENDER_FPS_VALUES as readonly unknown[]).includes(preset.fps)) return null
  return value as WorldRenderPreset
}

function parseFramePlan(value: unknown, preset: WorldRenderPreset, sequence: WorldSequence): boolean {
  const frames = exactArray(value, WORLD_RENDER_MAX_FRAME_COUNT)
  if (!frames) return false
  const duration = parseCanonicalRational(sequence.duration)
  if (!duration || duration.numerator < 0) return false
  const scaledNumerator = BigInt(duration.numerator) * BigInt(preset.fps)
  const denominator = BigInt(duration.denominator)
  const expectedCount = scaledNumerator === 0n ? 0n : (scaledNumerator + denominator - 1n) / denominator
  if (expectedCount > BigInt(WORLD_RENDER_MAX_FRAME_COUNT) || frames.length !== Number(expectedCount)) return false
  for (let index = 0; index < frames.length; index += 1) {
    const frame = exactRecord(frames[index], ['index', 'time', 'duration', 'timestampMicroseconds'])
    if (!frame || frame.index !== index || !Number.isSafeInteger(frame.timestampMicroseconds)
      || (frame.timestampMicroseconds as number) < 0) return false
    const frameTime = parseCanonicalRational(frame.time)
    const frameDuration = parseCanonicalRational(frame.duration)
    if (!frameTime || !frameDuration || frameDuration.numerator <= 0) return false
    const expectedTime = normalizeWorldRationalTime({ numerator: index, denominator: preset.fps })
    if (frameTime.numerator !== expectedTime.numerator || frameTime.denominator !== expectedTime.denominator) return false
    const expectedDuration = index + 1 < frames.length
      ? normalizeWorldRationalTime({ numerator: 1, denominator: preset.fps })
      : subtractWorldRationalTime(duration, expectedTime)
    if (frameDuration.numerator !== expectedDuration.numerator
      || frameDuration.denominator !== expectedDuration.denominator) return false
    const timestamp = roundPositiveRatio(BigInt(index) * 1_000_000n, BigInt(preset.fps))
    if (timestamp > BigInt(Number.MAX_SAFE_INTEGER) || frame.timestampMicroseconds !== Number(timestamp)) return false
  }
  return true
}

function parseCanonicalRational(value: unknown): { numerator: number; denominator: number } | null {
  const rational = exactRecord(value, ['numerator', 'denominator'])
  if (!rational || !Number.isSafeInteger(rational.numerator) || !Number.isSafeInteger(rational.denominator)
    || (rational.denominator as number) <= 0) return null
  try {
    const normalized = normalizeWorldRationalTime({
      numerator: rational.numerator as number,
      denominator: rational.denominator as number,
    })
    return normalized.numerator === rational.numerator && normalized.denominator === rational.denominator
      ? normalized
      : null
  } catch {
    return null
  }
}

function isEnvelopeIdentity(record: Record<string, unknown>): boolean {
  return record.protocol === WORLD_RENDER_HOST_PROTOCOL && isWorldRenderJobId(record.jobId)
    && isGeneration(record.generation) && Number.isSafeInteger(record.requestId)
    && (record.requestId as number) >= 1
}

function isResponseKind(value: unknown): value is WorldRenderHostCommand['kind'] {
  return ['initialize', 'render-frame', 'render-audio', 'dispose'].includes(String(value))
}

function isExactError(value: unknown): boolean {
  const error = exactRecord(value, ['code', 'message'])
  return Boolean(error
    && ['invalid-command', 'invalid-resource', 'unsupported-resource', 'decode-failed', 'render-failed', 'audio-failed', 'gpu-context-lost', 'cancelled'].includes(String(error.code))
    && isBoundedText(error.message, 512))
}

function isResourceFailureCode(value: unknown): value is WorldRenderHostResourceFailureCode {
  return ['invalid-request', 'resource-not-found', 'resource-invalid', 'cancelled'].includes(String(value))
}

function isGeneration(value: unknown): value is string {
  return typeof value === 'string' && value.length === 32
    && [...value].every((character) => (character >= 'a' && character <= 'f') || (character >= '0' && character <= '9'))
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64
    && [...value].every((character) => (character >= 'a' && character <= 'f') || (character >= '0' && character <= '9'))
}

function isBoundedText(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function isResourceRole(value: unknown): value is WorldRenderPinnedResourceRole {
  return value === 'primary' || value === 'source' || value === 'legacy'
}

function isBoundedResourceSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
    && (value as number) <= WORLD_RENDER_HOST_MAX_RESOURCE_BYTES
}

function isRenderDimensions(width: unknown, height: unknown): boolean {
  return Number.isSafeInteger(width) && (width as number) >= WORLD_RENDER_MIN_WIDTH
    && (width as number) <= WORLD_RENDER_MAX_WIDTH && Number.isSafeInteger(height)
    && (height as number) >= WORLD_RENDER_MIN_HEIGHT && (height as number) <= WORLD_RENDER_MAX_HEIGHT
    && (width as number) * (height as number) <= WORLD_RENDER_MAX_PIXELS
}

function isEmptyRecord(value: unknown): boolean {
  return Boolean(exactRecord(value, []))
}

function exactArray(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key !== 'string')) return null
    const named = Object.keys(descriptors).filter((key) => key !== 'length')
    if (named.length !== value.length) return null
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor?.enumerable || !('value' in descriptor)) return null
    }
    if (named.some((key) => !isCanonicalArrayIndex(key, value.length))) return null
    return value
  } catch {
    return null
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  const record = inspectPlainRecord(value)
  if (!record) return null
  try {
    const keys = Object.keys(record)
    const allowed = new Set([...required, ...optional])
    if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(record, key))) return null
    return record
  } catch {
    return null
  }
}

function inspectPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    if (Object.getOwnPropertySymbols(value).length) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) return null
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
  } catch {
    return null
  }
}

function roundPositiveRatio(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  return numerator % denominator * 2n >= denominator ? quotient + 1n : quotient
}
