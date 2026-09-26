import { isWorldCanonicalId, WORLD_MAX_SEMANTIC_ISSUES } from './core/worldValidationLimits.ts'
import { normalizeWorldRationalTime } from './cinematic/worldRationalTime.ts'
import { isWorldProjectKey } from '../../shared/types/worldProjects.ts'
import {
  WORLD_RENDER_ARTIFACT_MAX_BYTES,
  WORLD_RENDER_FPS_VALUES,
  WORLD_RENDER_MANIFEST_FILENAME,
  WORLD_RENDER_MAX_FRAME_COUNT,
  WORLD_RENDER_MAX_HEIGHT,
  WORLD_RENDER_MAX_PIXELS,
  WORLD_RENDER_MAX_STORED_JOBS,
  WORLD_RENDER_MAX_WIDTH,
  WORLD_RENDER_MIN_HEIGHT,
  WORLD_RENDER_MIN_WIDTH,
  WORLD_RENDER_PUBLIC_ERROR_CODES,
  isWorldRenderJobId,
  type WorldRenderArtifact,
  type WorldRenderCreateRequest,
  type WorldRenderCreateResult,
  type WorldRenderDeleteRequest,
  type WorldRenderDeleteResult,
  type WorldRenderGetResult,
  type WorldRenderJobDetail,
  type WorldRenderJobKeyRequest,
  type WorldRenderJobStatus,
  type WorldRenderJobSummary,
  type WorldRenderListResult,
  type WorldRenderPreset,
  type WorldRenderProgress,
  type WorldRenderPublicError,
  type WorldRenderPublicErrorCode,
  type WorldRendersApi,
} from '../../shared/types/worldRenders.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const STATUSES = new Set<WorldRenderJobStatus>([
  'queued', 'preflighting', 'rendering-frames', 'rendering-audio', 'assembling',
  'cancel_requested', 'cancelled', 'interrupted', 'failed', 'partial', 'succeeded', 'recovery_failed',
])
const PHASES = new Set<WorldRenderProgress['phase']>([
  'queued', 'preflighting', 'rendering-frames', 'rendering-audio', 'assembling', 'complete',
])
const TERMINAL = new Set<WorldRenderJobStatus>([
  'cancelled', 'interrupted', 'failed', 'partial', 'succeeded', 'recovery_failed',
])

export type WorldRenderService = WorldRendersApi

interface WorldRenderApiWindow {
  electron?: {
    workspace?: {
      worlds?: {
        renders?: WorldRendersApi
      }
    }
  }
}

export function createWorldRenderService(providedApi?: WorldRendersApi): WorldRenderService {
  const api = providedApi ?? resolveWorldRendersApi()
  return {
    create: async (request) => normalizeCreate(await safeCall(() => api.create(structuredClone(request))), request),
    list: async () => normalizeList(await safeCall(() => api.list())),
    get: async (request) => normalizeGet(await safeCall(() => api.get({ ...request })), request),
    cancel: async (request) => normalizeGet(await safeCall(() => api.cancel({ ...request })), request),
    delete: async (request) => normalizeDelete(await safeCall(() => api.delete({ ...request })), request),
  }
}

export const worldRenderService: WorldRenderService = {
  create: (request) => createWorldRenderService().create(request),
  list: () => createWorldRenderService().list(),
  get: (request) => createWorldRenderService().get(request),
  cancel: (request) => createWorldRenderService().cancel(request),
  delete: (request) => createWorldRenderService().delete(request),
}

async function safeCall(operation: () => Promise<unknown>): Promise<unknown> {
  try { return await operation() }
  catch { return publicFailure('internal_error') }
}

function resolveWorldRendersApi(): WorldRendersApi {
  const hostWindow = (globalThis as typeof globalThis & { window?: WorldRenderApiWindow }).window
  const api = hostWindow?.electron?.workspace?.worlds?.renders
  if (!api) return unavailableApi()
  return api
}

function unavailableApi(): WorldRendersApi {
  const unavailable = async () => publicFailure('executor_unavailable')
  return { create: unavailable, list: unavailable, get: unavailable, cancel: unavailable, delete: unavailable }
}

function normalizeCreate(value: unknown, request: WorldRenderCreateRequest): WorldRenderCreateResult {
  const failure = normalizeFailure(value)
  if (failure) return failure
  try {
    const job = detailValue(successValue(value))
    if (job.projectKey !== request.projectKey || job.revision !== request.expectedRevision
      || job.sceneId !== request.sceneId || job.sequenceId !== request.sequenceId
      || (request.preset && !samePreset(job.preset, request.preset))) throw new Error()
    return { ok: true, value: job }
  } catch { return invalidResponse() }
}

function normalizeList(value: unknown): WorldRenderListResult {
  const failure = normalizeFailure(value)
  if (failure) return failure
  try {
    const record = exactRecord(successValue(value), ['jobs'])
    const values = exactArrayValues(record.jobs, WORLD_RENDER_MAX_STORED_JOBS)
    const jobs: WorldRenderJobSummary[] = []
    for (const item of values) jobs.push(summaryValue(item))
    return { ok: true, value: { jobs } }
  } catch { return invalidResponse() }
}

function normalizeGet(value: unknown, request: WorldRenderJobKeyRequest): WorldRenderGetResult {
  const failure = normalizeFailure(value)
  if (failure) return failure
  try {
    const job = detailValue(successValue(value))
    if (job.jobId !== request.jobId) throw new Error()
    return { ok: true, value: job }
  } catch { return invalidResponse() }
}

function normalizeDelete(value: unknown, request: WorldRenderDeleteRequest): WorldRenderDeleteResult {
  const failure = normalizeFailure(value)
  if (failure) return failure
  try {
    const record = exactRecord(successValue(value), ['jobId'])
    if (record.jobId !== request.jobId || !isWorldRenderJobId(record.jobId)) throw new Error()
    return { ok: true, value: { jobId: record.jobId } }
  } catch { return invalidResponse() }
}

function summaryValue(value: unknown): WorldRenderJobSummary {
  const record = exactRecord(value, [
    'jobId', 'projectKey', 'projectId', 'revision', 'sceneId', 'sequenceId', 'preset', 'duration',
    'frameCount', 'status', 'progress', 'createdAt', 'updatedAt', 'outputs', 'error',
  ])
  if (!isWorldRenderJobId(record.jobId) || !isWorldProjectKey(record.projectKey)
    || !isWorldCanonicalId(record.projectId) || !isWorldCanonicalId(record.sceneId)
    || !isWorldCanonicalId(record.sequenceId) || !isNonNegativeInteger(record.revision)
    || !isNonNegativeInteger(record.frameCount) || (record.frameCount as number) > WORLD_RENDER_MAX_FRAME_COUNT
    || !STATUSES.has(record.status as WorldRenderJobStatus)
    || !isCanonicalTimestamp(record.createdAt) || !isCanonicalTimestamp(record.updatedAt)
    || (record.updatedAt as string) < (record.createdAt as string)) throw new Error()
  const duration = normalizeWorldRationalTime(record.duration as never)
  if (duration.numerator < 0) throw new Error()
  const preset = presetValue(record.preset)
  const progress = progressValue(record.progress, record.frameCount)
  return {
    jobId: record.jobId,
    projectKey: record.projectKey,
    projectId: record.projectId,
    revision: record.revision,
    sceneId: record.sceneId,
    sequenceId: record.sequenceId,
    preset,
    duration,
    frameCount: record.frameCount,
    status: record.status as WorldRenderJobStatus,
    progress,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function detailValue(value: unknown): WorldRenderJobDetail {
  const summary = summaryValue(value)
  const record = value as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, 'outputs') || !Object.prototype.hasOwnProperty.call(record, 'error')) throw new Error()
  const outputsRecord = exactRecord(record.outputs, ['frames', 'audio', 'renderManifest', 'webm'])
  const frameValues = exactArrayValues(outputsRecord.frames, summary.frameCount)
  const frames: WorldRenderJobDetail['outputs']['frames'] = []
  for (let expectedIndex = 0; expectedIndex < frameValues.length; expectedIndex += 1) {
    frames.push(frameValue(frameValues[expectedIndex], summary.jobId, expectedIndex))
  }
  const audio = nullableArtifact(
    outputsRecord.audio,
    summary.jobId,
    'audio/master.wav',
    WORLD_RENDER_ARTIFACT_MAX_BYTES.audio,
  )
  const renderManifest = nullableArtifact(
    outputsRecord.renderManifest,
    summary.jobId,
    WORLD_RENDER_MANIFEST_FILENAME,
    WORLD_RENDER_ARTIFACT_MAX_BYTES.renderManifest,
  )
  const webm = nullableArtifact(
    outputsRecord.webm,
    summary.jobId,
    'output.webm',
    WORLD_RENDER_ARTIFACT_MAX_BYTES.webm,
  )
  const error = record.error === null ? null : errorValue(record.error)
  const mastersSettled = summary.progress.phase === 'complete'
    && summary.progress.completedFrames === summary.frameCount
    && summary.progress.completedUnits === summary.progress.totalUnits
  if (summary.status === 'succeeded' && (!mastersSettled || !webm || frames.length !== summary.frameCount || !audio || !renderManifest || error)) throw new Error()
  if (summary.status === 'partial' && (!mastersSettled || webm || frames.length !== summary.frameCount || !audio || !renderManifest || !error)) throw new Error()
  if ((summary.status === 'failed' || summary.status === 'recovery_failed') && !error) throw new Error()
  if (!TERMINAL.has(summary.status) && summary.progress.phase === 'complete') throw new Error()
  return { ...summary, outputs: { frames, audio, renderManifest, webm }, error }
}

function frameValue(value: unknown, jobId: string, expectedIndex: number) {
  const record = exactRecord(value, ['workspacePath', 'size', 'sha256', 'index', 'time', 'timestampMicroseconds'])
  if (record.index !== expectedIndex || !isNonNegativeInteger(record.timestampMicroseconds)) throw new Error()
  const artifact = artifactValue(
    record,
    jobId,
    `frames/frame-${String(expectedIndex).padStart(6, '0')}.png`,
    WORLD_RENDER_ARTIFACT_MAX_BYTES.frame,
  )
  const time = normalizeWorldRationalTime(record.time as never)
  if (time.numerator < 0) throw new Error()
  return { ...artifact, index: expectedIndex, time, timestampMicroseconds: record.timestampMicroseconds }
}

function nullableArtifact(
  value: unknown,
  jobId: string,
  suffix: string,
  maximumSize: number,
): WorldRenderArtifact | null {
  return value === null ? null : artifactValue(value, jobId, suffix, maximumSize)
}

function artifactValue(value: unknown, jobId: string, suffix: string, maximumSize: number): WorldRenderArtifact {
  const record = exactRecord(value, ['workspacePath', 'size', 'sha256', 'index', 'time', 'timestampMicroseconds'])
  const expected = `Exports/Worlds/Renders/${jobId}/${suffix}`
  if (record.workspacePath !== expected || !isPositiveSafeInteger(record.size) || record.size > maximumSize
    || typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)) throw new Error()
  return { workspacePath: expected, size: record.size, sha256: record.sha256 }
}

function presetValue(value: unknown): WorldRenderPreset {
  const record = exactRecord(value, ['width', 'height', 'fps'])
  if (!Number.isSafeInteger(record.width) || (record.width as number) < WORLD_RENDER_MIN_WIDTH || (record.width as number) > WORLD_RENDER_MAX_WIDTH
    || !Number.isSafeInteger(record.height) || (record.height as number) < WORLD_RENDER_MIN_HEIGHT || (record.height as number) > WORLD_RENDER_MAX_HEIGHT
    || (record.width as number) * (record.height as number) > WORLD_RENDER_MAX_PIXELS
    || !WORLD_RENDER_FPS_VALUES.includes(record.fps as never)) throw new Error()
  return { width: record.width as number, height: record.height as number, fps: record.fps as WorldRenderPreset['fps'] }
}

function progressValue(value: unknown, frameCount: unknown): WorldRenderProgress {
  const record = exactRecord(value, ['phase', 'completedFrames', 'frameCount', 'completedUnits', 'totalUnits'])
  if (!PHASES.has(record.phase as WorldRenderProgress['phase']) || record.frameCount !== frameCount
    || !isNonNegativeInteger(record.completedFrames) || (record.completedFrames as number) > (frameCount as number)
    || !isNonNegativeInteger(record.completedUnits) || !isNonNegativeInteger(record.totalUnits)
    || (record.totalUnits as number) < 1 || (record.completedUnits as number) > (record.totalUnits as number)) throw new Error()
  return record as unknown as WorldRenderProgress
}

function errorValue(value: unknown): WorldRenderPublicError {
  const record = exactRecord(value, ['code', 'message', 'retryable', 'issues'])
  if (typeof record.code !== 'string' || !WORLD_RENDER_PUBLIC_ERROR_CODES.includes(record.code as WorldRenderPublicErrorCode)
    || typeof record.retryable !== 'boolean') throw new Error()
  if (record.issues !== undefined) exactArrayValues(record.issues, WORLD_MAX_SEMANTIC_ISSUES)
  const code = record.code as WorldRenderPublicErrorCode
  return { code, message: publicMessage(code), retryable: record.retryable }
}

function normalizeFailure(value: unknown): { ok: false; error: WorldRenderPublicError } | null {
  try {
    const envelope = exactRecord(value, ['ok', 'error', 'value'])
    if (envelope.ok !== false) return null
    if (Object.prototype.hasOwnProperty.call(envelope, 'value')) throw new Error()
    return { ok: false, error: errorValue(envelope.error) }
  } catch { return invalidResponse() }
}

function successValue(value: unknown): unknown {
  const envelope = exactRecord(value, ['ok', 'value'])
  if (envelope.ok !== true) throw new Error()
  return envelope.value
}

function exactRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
  let prototype: object | null
  let keys: PropertyKey[]
  let descriptors: PropertyDescriptorMap
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch { throw new Error() }
  if (prototype !== Object.prototype && prototype !== null) throw new Error()
  const allowed = new Set(allowedKeys)
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw new Error()
  const result: Record<string, unknown> = {}
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error()
    result[key] = descriptor.value
  }
  return result
}

/**
 * Reads an array through one descriptor snapshot so holes, inherited values,
 * accessors, exotic prototypes, symbols, and extra properties cannot bypass
 * element validation. The returned array is fresh, dense, and ordinary.
 */
function exactArrayValues(value: unknown, maximumLength: number): unknown[] {
  if (!Array.isArray(value)) throw new Error()
  let prototype: object | null
  let preflightLength: PropertyDescriptor | undefined
  try {
    // Inspect only the invariant own length before any O(n) descriptor work.
    prototype = Object.getPrototypeOf(value)
    preflightLength = Object.getOwnPropertyDescriptor(value, 'length')
  } catch { throw new Error() }
  if (prototype !== Array.prototype || !isCanonicalArrayLength(preflightLength, maximumLength)) throw new Error()
  const length = preflightLength.value as number

  let descriptors: Record<string, PropertyDescriptor>
  let descriptorKeys: PropertyKey[]
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
    descriptorKeys = Reflect.ownKeys(descriptors)
  } catch { throw new Error() }
  const lengthDescriptor = descriptors.length
  if (!isCanonicalArrayLength(lengthDescriptor, maximumLength) || lengthDescriptor.value !== length) throw new Error()
  if (descriptorKeys.length !== length + 1) throw new Error()
  const result: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error()
    result.push(descriptor.value)
  }
  return result
}

function isCanonicalArrayLength(
  descriptor: PropertyDescriptor | undefined,
  maximumLength: number,
): descriptor is PropertyDescriptor & { value: number } {
  return Boolean(descriptor && 'value' in descriptor
    && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0 && descriptor.value <= maximumLength
    && descriptor.enumerable === false && descriptor.configurable === false)
}

function publicFailure(code: WorldRenderPublicErrorCode): { ok: false; error: WorldRenderPublicError } {
  return { ok: false, error: { code, message: publicMessage(code), retryable: ['revision_conflict', 'executor_unavailable', 'job_busy', 'recovery_failed', 'write_failed', 'internal_error'].includes(code) } }
}

function invalidResponse(): { ok: false; error: WorldRenderPublicError } {
  return { ok: false, error: { code: 'output_invalid', message: 'World render response is invalid.', retryable: false } }
}

function publicMessage(code: WorldRenderPublicErrorCode): string {
  const messages: Record<WorldRenderPublicErrorCode, string> = {
    invalid_request: 'World render request is invalid.',
    unauthorized: 'World render request is unauthorized.',
    job_not_found: 'World render job was not found.',
    project_not_found: 'World project was not found.',
    revision_conflict: 'World project revision changed.',
    scene_not_found: 'World scene was not found.',
    sequence_not_found: 'World sequence was not found.',
    sequence_invalid: 'World sequence cannot be rendered.',
    executor_unavailable: 'World render executor is unavailable.',
    job_busy: 'World render job is busy.',
    unsafe_workspace: 'World render workspace is unsafe.',
    output_invalid: 'World render output is incomplete or invalid.',
    recovery_failed: 'World render recovery failed.',
    write_failed: 'World render output could not be saved.',
    internal_error: 'World render operation failed.',
  }
  return messages[code]
}

function samePreset(left: WorldRenderPreset, right: WorldRenderPreset): boolean {
  return left.width === right.width && left.height === right.height && left.fps === right.fps
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP_PATTERN.test(value) && new Date(value).toISOString() === value
}
