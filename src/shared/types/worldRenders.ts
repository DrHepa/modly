import type { WorldRationalTime } from '../../areas/worlds/core/worldModel.ts'
import { isWorldCanonicalId } from '../../areas/worlds/core/worldValidationLimits.ts'
import { isWorldProjectKey } from './worldProjects.ts'

export const WORLD_RENDER_JOB_SCHEMA = 'modly.world-render-job.v1' as const
export const WORLD_RENDER_SNAPSHOT_SCHEMA = 'modly.world-render-snapshot.v1' as const
export const WORLD_RENDER_MANIFEST_SCHEMA = 'modly.world-render-manifest.v1' as const
export const WORLD_RENDER_MANIFEST_FILENAME = 'render-manifest.json' as const

export const WORLD_RENDER_CHANNELS = Object.freeze({
  create: 'worlds:renders:create',
  list: 'worlds:renders:list',
  get: 'worlds:renders:get',
  cancel: 'worlds:renders:cancel',
  delete: 'worlds:renders:delete',
} as const)

export const WORLD_RENDER_FPS_VALUES = [24, 25, 30, 60] as const
export type WorldRenderFps = typeof WORLD_RENDER_FPS_VALUES[number]

export const WORLD_RENDER_DEFAULT_PRESET = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
} as const)

export const WORLD_RENDER_MIN_WIDTH = 64
export const WORLD_RENDER_MAX_WIDTH = 7680
export const WORLD_RENDER_MIN_HEIGHT = 64
export const WORLD_RENDER_MAX_HEIGHT = 4320
export const WORLD_RENDER_MAX_PIXELS = 7680 * 4320
export const WORLD_RENDER_MAX_DURATION_SECONDS = 15 * 60
export const WORLD_RENDER_MAX_FRAME_COUNT = 60 * WORLD_RENDER_MAX_DURATION_SECONDS
export const WORLD_RENDER_MAX_STORED_JOBS = 256
export const WORLD_RENDER_ARTIFACT_MAX_BYTES = Object.freeze({
  frame: 256 * 1024 * 1024,
  audio: 8 * 1024 * 1024 * 1024,
  renderManifest: 512 * 1024 * 1024,
  webm: 64 * 1024 * 1024 * 1024,
} as const)

export interface WorldRenderPreset {
  width: number
  height: number
  fps: WorldRenderFps
}

/** Renderer callers select content and quality only; output paths are never accepted. */
export interface WorldRenderCreateRequest {
  projectKey: string
  expectedRevision: number
  sceneId: string
  sequenceId: string
  preset?: WorldRenderPreset
}

export interface WorldRenderNormalizedCreateRequest extends Omit<WorldRenderCreateRequest, 'preset'> {
  preset: WorldRenderPreset
}

export interface WorldRenderJobKeyRequest {
  jobId: string
}

export type WorldRenderCancelRequest = WorldRenderJobKeyRequest
export type WorldRenderDeleteRequest = WorldRenderJobKeyRequest

export const WORLD_RENDER_PUBLIC_ERROR_CODES = Object.freeze([
  'invalid_request',
  'unauthorized',
  'job_not_found',
  'project_not_found',
  'revision_conflict',
  'scene_not_found',
  'sequence_not_found',
  'sequence_invalid',
  'executor_unavailable',
  'job_busy',
  'unsafe_workspace',
  'output_invalid',
  'recovery_failed',
  'write_failed',
  'internal_error',
] as const)

export type WorldRenderPublicErrorCode = typeof WORLD_RENDER_PUBLIC_ERROR_CODES[number]

export interface WorldRenderPublicIssue {
  code: string
  path: string
  message: string
}

export interface WorldRenderPublicError {
  code: WorldRenderPublicErrorCode
  message: string
  retryable: boolean
  issues?: WorldRenderPublicIssue[]
}

export type WorldRenderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorldRenderPublicError }

export type WorldRenderJobStatus =
  | 'queued'
  | 'preflighting'
  | 'rendering-frames'
  | 'rendering-audio'
  | 'assembling'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted'
  | 'failed'
  | 'partial'
  | 'succeeded'
  | 'recovery_failed'

export type WorldRenderProgressPhase =
  | 'queued'
  | 'preflighting'
  | 'rendering-frames'
  | 'rendering-audio'
  | 'assembling'
  | 'complete'

export interface WorldRenderProgress {
  phase: WorldRenderProgressPhase
  completedFrames: number
  frameCount: number
  completedUnits: number
  totalUnits: number
}

export interface WorldRenderArtifact {
  workspacePath: string
  size: number
  sha256: string
}

export interface WorldRenderFrameArtifact extends WorldRenderArtifact {
  index: number
  time: WorldRationalTime
  timestampMicroseconds: number
}

export interface WorldRenderOutputs {
  frames: WorldRenderFrameArtifact[]
  audio: WorldRenderArtifact | null
  renderManifest: WorldRenderArtifact | null
  webm: WorldRenderArtifact | null
}

export interface WorldRenderJobSummary {
  jobId: string
  projectKey: string
  projectId: string
  revision: number
  sceneId: string
  sequenceId: string
  preset: WorldRenderPreset
  duration: WorldRationalTime
  frameCount: number
  status: WorldRenderJobStatus
  progress: WorldRenderProgress
  createdAt: string
  updatedAt: string
}

export interface WorldRenderJobDetail extends WorldRenderJobSummary {
  outputs: WorldRenderOutputs
  error: WorldRenderPublicError | null
}

export interface WorldRenderListSuccess {
  jobs: WorldRenderJobSummary[]
}

export interface WorldRenderDeleteSuccess {
  jobId: string
}

export type WorldRenderCreateResult = WorldRenderResult<WorldRenderJobDetail>
export type WorldRenderGetResult = WorldRenderResult<WorldRenderJobDetail>
export type WorldRenderListResult = WorldRenderResult<WorldRenderListSuccess>
export type WorldRenderCancelResult = WorldRenderResult<WorldRenderJobDetail>
export type WorldRenderDeleteResult = WorldRenderResult<WorldRenderDeleteSuccess>

export interface WorldRendersApi {
  create(request: WorldRenderCreateRequest): Promise<WorldRenderCreateResult>
  list(): Promise<WorldRenderListResult>
  get(request: WorldRenderJobKeyRequest): Promise<WorldRenderGetResult>
  cancel(request: WorldRenderCancelRequest): Promise<WorldRenderCancelResult>
  delete(request: WorldRenderDeleteRequest): Promise<WorldRenderDeleteResult>
}

export interface WorldRenderParseIssue {
  code: 'invalid-value' | 'unknown-key'
  path: string
  message: string
}

export type WorldRenderParseResult<T> =
  | { success: true; value: T }
  | { success: false; issues: WorldRenderParseIssue[] }

const JOB_ID_PATTERN = /^render-[a-f0-9]{32}$/

export function isWorldRenderJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value)
}

export function parseWorldRenderCreateRequest(value: unknown): WorldRenderParseResult<WorldRenderNormalizedCreateRequest> {
  const record = exactRecord(value, ['projectKey', 'expectedRevision', 'sceneId', 'sequenceId', 'preset'])
  if (!record.success) return record
  const issues: WorldRenderParseIssue[] = []
  if (!isWorldProjectKey(record.value.projectKey)) issues.push(invalid('projectKey'))
  if (!isNonNegativeSafeInteger(record.value.expectedRevision)) issues.push(invalid('expectedRevision'))
  if (!isWorldCanonicalId(record.value.sceneId)) issues.push(invalid('sceneId'))
  if (!isWorldCanonicalId(record.value.sequenceId)) issues.push(invalid('sequenceId'))
  const preset = record.value.preset === undefined
    ? { ...WORLD_RENDER_DEFAULT_PRESET }
    : parsePreset(record.value.preset, issues)
  if (issues.length || !preset) return { success: false, issues }
  return {
    success: true,
    value: {
      projectKey: record.value.projectKey as string,
      expectedRevision: record.value.expectedRevision as number,
      sceneId: record.value.sceneId as string,
      sequenceId: record.value.sequenceId as string,
      preset,
    },
  }
}

export function parseWorldRenderJobKeyRequest(value: unknown): WorldRenderParseResult<WorldRenderJobKeyRequest> {
  const record = exactRecord(value, ['jobId'])
  if (!record.success) return record
  if (!isWorldRenderJobId(record.value.jobId)) return { success: false, issues: [invalid('jobId')] }
  return { success: true, value: { jobId: record.value.jobId } }
}

export function parseWorldRenderCancelRequest(value: unknown): WorldRenderParseResult<WorldRenderCancelRequest> {
  return parseWorldRenderJobKeyRequest(value)
}

export function parseWorldRenderDeleteRequest(value: unknown): WorldRenderParseResult<WorldRenderDeleteRequest> {
  return parseWorldRenderJobKeyRequest(value)
}

function parsePreset(value: unknown, issues: WorldRenderParseIssue[]): WorldRenderPreset | null {
  const record = exactRecord(value, ['width', 'height', 'fps'], 'preset')
  if (!record.success) {
    issues.push(...record.issues)
    return null
  }
  const { width, height, fps } = record.value
  if (!Number.isSafeInteger(width) || (width as number) < WORLD_RENDER_MIN_WIDTH || (width as number) > WORLD_RENDER_MAX_WIDTH) {
    issues.push(invalid('preset.width'))
  }
  if (!Number.isSafeInteger(height) || (height as number) < WORLD_RENDER_MIN_HEIGHT || (height as number) > WORLD_RENDER_MAX_HEIGHT) {
    issues.push(invalid('preset.height'))
  }
  if (!(WORLD_RENDER_FPS_VALUES as readonly unknown[]).includes(fps)) issues.push(invalid('preset.fps'))
  if (Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && (width as number) * (height as number) > WORLD_RENDER_MAX_PIXELS) issues.push(invalid('preset'))
  if (issues.length) return null
  return { width: width as number, height: height as number, fps: fps as WorldRenderFps }
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  path = '',
): WorldRenderParseResult<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { success: false, issues: [invalid(path || 'request')] }
  }
  let descriptors: PropertyDescriptorMap
  let symbols: symbol[]
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
    symbols = Object.getOwnPropertySymbols(value)
  } catch {
    return { success: false, issues: [invalid(path || 'request')] }
  }
  if ((prototype !== Object.prototype && prototype !== null) || symbols.length) {
    return { success: false, issues: [invalid(path || 'request')] }
  }
  const keys = Object.keys(descriptors)
  if (keys.some((key) => !descriptors[key].enumerable || !('value' in descriptors[key]))) {
    return { success: false, issues: [invalid(path || 'request')] }
  }
  const unknownKeys = keys.filter((key) => !allowedKeys.includes(key)).sort()
  if (unknownKeys.length) {
    return {
      success: false,
      issues: unknownKeys.map((key) => ({
        code: 'unknown-key',
        path: path ? `${path}.${key}` : key,
        message: 'Unknown key.',
      })),
    }
  }
  return {
    success: true,
    value: Object.fromEntries(keys.map((key) => [key, descriptors[key].value])) as Record<string, unknown>,
  }
}

function invalid(path: string): WorldRenderParseIssue {
  return { code: 'invalid-value', path, message: 'Invalid value.' }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
