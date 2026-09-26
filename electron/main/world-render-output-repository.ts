import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { constants, fstatSync, type BigIntStats, type Stats } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { createInflate } from 'node:zlib'

import {
  cloneWorldProjectSnapshot,
  validateWorldProjectSnapshot,
} from '../../src/areas/worlds/core/worldDocuments.ts'
import type {
  WorldProjectSnapshotV1,
  WorldResource,
  WorldSequence,
} from '../../src/areas/worlds/core/worldModel.ts'
import { isWorldCanonicalId } from '../../src/areas/worlds/core/worldValidationLimits.ts'
import {
  compareWorldRationalTime,
  enumerateWorldFrames,
  normalizeWorldRationalTime,
  type WorldFrameTime,
} from '../../src/areas/worlds/cinematic/worldRationalTime.ts'
import {
  WORLD_RENDER_JOB_SCHEMA,
  WORLD_RENDER_ARTIFACT_MAX_BYTES,
  WORLD_RENDER_MANIFEST_FILENAME,
  WORLD_RENDER_MANIFEST_SCHEMA,
  WORLD_RENDER_MAX_DURATION_SECONDS,
  WORLD_RENDER_MAX_FRAME_COUNT,
  WORLD_RENDER_MAX_STORED_JOBS,
  WORLD_RENDER_PUBLIC_ERROR_CODES,
  WORLD_RENDER_SNAPSHOT_SCHEMA,
  isWorldRenderJobId,
  parseWorldRenderCreateRequest,
  parseWorldRenderDeleteRequest,
  parseWorldRenderJobKeyRequest,
  type WorldRenderArtifact,
  type WorldRenderDeleteResult,
  type WorldRenderFrameArtifact,
  type WorldRenderGetResult,
  type WorldRenderJobDetail,
  type WorldRenderJobSummary,
  type WorldRenderJobStatus,
  type WorldRenderListResult,
  type WorldRenderNormalizedCreateRequest,
  type WorldRenderProgress,
  type WorldRenderProgressPhase,
  type WorldRenderPublicError,
  type WorldRenderPublicErrorCode,
  type WorldRenderResult,
} from '../../src/shared/types/worldRenders.ts'
import {
  WORLD_WEBM_MAX_AUDIO_CHUNK_SAMPLES,
  WORLD_WEBM_MAX_OUTPUT_BYTES,
  WORLD_WEBM_MAX_WRITE_BYTES,
  type WorldWebmStartPayload,
} from '../../src/areas/worlds/render/worldWebmProtocol.ts'

const JOB_FILE = 'job.v1.json'
const SNAPSHOT_FILE = 'snapshot/render-snapshot.v1.json'
const LAST_VALID_FILE = '.modly/last-valid-job.v1.json'
const JOURNAL_FILE = '.modly/journal.v1.json'
const JOURNAL_SCHEMA = 'modly.world-render-journal.v1' as const
const CANCELLATION_INTENT_FILE = '.modly/cancellation-intent.v1.json'
const CANCELLATION_INTENT_SCHEMA = 'modly.world-render-cancellation-intent.v1' as const
const CANCELLATION_INTENT_STAGES = Object.freeze([
  'prepared',
  'manifest-receipt-removal-authorized',
  'webm-receipt-removal-authorized',
  'manifest-removal-authorized',
  'webm-removal-authorized',
  'requested-state-publication-authorized',
  'requested-state-published',
  'cancelled-state-publication-authorized',
  'cancelled-state-published',
] as const)
type CancellationIntentStage = typeof CANCELLATION_INTENT_STAGES[number]
const MANIFEST_PUBLICATION_INTENT_FILE = '.modly/manifest-publication-intent.v1.json'
const MANIFEST_PUBLICATION_INTENT_SCHEMA = 'modly.world-render-manifest-publication-intent.v1' as const
const MANIFEST_PUBLICATION_INTENT_STAGES = Object.freeze([
  'prepared',
  'receipt-removal-authorized',
  'artifact-removal-authorized',
] as const)
type ManifestPublicationIntentStage = typeof MANIFEST_PUBLICATION_INTENT_STAGES[number]
const ARTIFACT_RECEIPT_SCHEMA = 'modly.world-render-artifact-receipt.v1' as const
const ARTIFACT_RECEIPT_DIRECTORY = '.modly/artifacts'
const MAX_JSON_BYTES = 32 * 1024 * 1024
const MAX_PINNED_RESOURCE_BYTES = 16 * 1024 * 1024 * 1024
const MAX_PINNED_RESOURCE_TOTAL_BYTES = 64 * 1024 * 1024 * 1024
const MAX_RENDERER_RESOURCE_BYTES = 512 * 1024 * 1024
const MAX_ABSENCE_PATH_SEGMENTS = 256
const DEFAULT_CANCELLATION_WAIT_MS = 30_000
const MIN_CANCELLATION_WAIT_MS = 5
const MAX_CANCELLATION_WAIT_MS = 60_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const FRAME_NAME_PATTERN = /^frame-[0-9]{6}\.png$/
const WINDOWS_DEVICE_PREFIX = /^(?:\\\\[.?]\\|\\\?\\)/
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const CRC32_TABLE = createCrc32Table()

export const WORLD_RENDER_TERMINAL_STATUSES = Object.freeze([
  'cancelled',
  'interrupted',
  'failed',
  'partial',
  'succeeded',
  'recovery_failed',
] as const satisfies readonly WorldRenderJobStatus[])

const ACTIVE_STATUSES = new Set<WorldRenderJobStatus>([
  'queued', 'preflighting', 'rendering-frames', 'rendering-audio', 'assembling', 'cancel_requested',
])
const TERMINAL_STATUSES = new Set<WorldRenderJobStatus>(WORLD_RENDER_TERMINAL_STATUSES)
const PROGRESS_PHASES = new Set<WorldRenderProgressPhase>([
  'queued', 'preflighting', 'rendering-frames', 'rendering-audio', 'assembling', 'complete',
])
const STATUS_VALUES = new Set<WorldRenderJobStatus>([...ACTIVE_STATUSES, ...TERMINAL_STATUSES])
const PUBLIC_ERROR_CODES = new Set<WorldRenderPublicErrorCode>(WORLD_RENDER_PUBLIC_ERROR_CODES)

export type WorldRenderArtifactInput = Uint8Array | AsyncIterable<Uint8Array>

export type WorldRenderPinnedResourceRole = 'primary' | 'source' | 'legacy'

export interface WorldRenderPinnedResourceFile extends WorldRenderArtifact {
  role: WorldRenderPinnedResourceRole
  originalWorkspacePath: string
}

export interface WorldRenderPinnedResource {
  resource: WorldResource
  files: WorldRenderPinnedResourceFile[]
}

export interface WorldRenderPinnedResourceBytes {
  resourceId: string
  role: WorldRenderPinnedResourceRole
  size: number
  sha256: string
  bytes: Uint8Array
}

export interface WorldRenderSnapshotPackageV1 {
  schema: typeof WORLD_RENDER_SNAPSHOT_SCHEMA
  jobId: string
  projectKey: string
  projectId: string
  revision: number
  sceneId: string
  sequenceId: string
  preset: WorldRenderNormalizedCreateRequest['preset']
  project: WorldProjectSnapshotV1['project']
  scenes: WorldProjectSnapshotV1['scenes']
  sequence: WorldSequence
  resources: WorldRenderPinnedResource[]
  framePlan: WorldRenderFramePlanDescriptor
}

export interface WorldRenderFramePlanDescriptor {
  fps: WorldRenderNormalizedCreateRequest['preset']['fps']
  frameCount: number
  sha256: string
}

interface LoadedWorldRenderSnapshotPackageV1 extends Omit<WorldRenderSnapshotPackageV1, 'framePlan'> {
  framePlan: readonly WorldFrameTime[]
}

export interface WorldRenderExecutionPackage {
  snapshot: WorldProjectSnapshotV1
  scene: WorldProjectSnapshotV1['scenes'][number]
  sequence: WorldSequence
  preset: WorldRenderNormalizedCreateRequest['preset']
  resources: WorldRenderPinnedResource[]
  framePlan: WorldFrameTime[]
  snapshotSha256: string
}

type StoredArtifact = WorldRenderArtifact
type StoredFrameArtifact = WorldRenderFrameArtifact

interface StoredJobV1 {
  schema: typeof WORLD_RENDER_JOB_SCHEMA
  jobId: string
  request: WorldRenderNormalizedCreateRequest
  projectId: string
  duration: WorldSequence['duration']
  frameCount: number
  snapshot: StoredArtifact
  status: WorldRenderJobStatus
  progress: WorldRenderProgress
  outputs: {
    frames: StoredFrameArtifact[]
    audio: StoredArtifact | null
    renderManifest: StoredArtifact | null
    webm: StoredArtifact | null
  }
  error: WorldRenderPublicError | null
  createdAt: string
  updatedAt: string
}

interface JournalV1 {
  schema: typeof JOURNAL_SCHEMA
  jobId: string
  previousSha256: string
  nextSha256: string
}

interface CancellationIntentV1 {
  schema: typeof CANCELLATION_INTENT_SCHEMA
  stage: CancellationIntentStage
  authoritySha256: string
  jobId: string
  revision: number
  snapshotSha256: string
  sourceStateSha256: string
  requestedStateSha256: string
  cancelledStateSha256: string
  updatedAt: string
  renderManifest: StoredArtifact | null
  webm: StoredArtifact | null
}

type CancellationIntentAuthority = Omit<
  CancellationIntentV1,
  'schema' | 'stage' | 'authoritySha256'
>

interface ManifestPublicationIntentV1 {
  schema: typeof MANIFEST_PUBLICATION_INTENT_SCHEMA
  stage: ManifestPublicationIntentStage
  authoritySha256: string
  jobId: string
  revision: number
  snapshotSha256: string
  sourceStateSha256: string
  artifact: StoredArtifact
}

type ManifestPublicationIntentAuthority = Omit<
  ManifestPublicationIntentV1,
  'schema' | 'stage' | 'authoritySha256'
>

type ArtifactReceiptV1 =
  | {
      schema: typeof ARTIFACT_RECEIPT_SCHEMA
      jobId: string
      kind: 'frame'
      index: number
      artifact: StoredFrameArtifact
    }
  | {
      schema: typeof ARTIFACT_RECEIPT_SCHEMA
      jobId: string
      kind: 'audio' | 'render-manifest' | 'webm'
      index: null
      artifact: StoredArtifact
    }

interface RepositoryContext {
  workspaceRoot: string
  outputRoot: string
}

interface DirectoryObservation {
  dev: number
  ino: number
  mode: number
  nlink: number
  size: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
}

export interface WorldRenderOutputRepositoryOptions {
  getWorkspaceRoot(): string | Promise<string>
  createJobId?: () => string
  now?: () => Date
  failureCheckpoint?: (stage: string) => void | Promise<void>
  syncDirectory?: (directory: string) => boolean | Promise<boolean>
  maximumPinnedResourceBytes?: number
  maximumPinnedResourceTotalBytes?: number
  /** Caller-visible bound; the exact cancellation authority remains owned after expiry. */
  cancellationWaitMs?: number
  positionedWrite?: (
    handle: FileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesWritten: number }>
}

export interface CreateStoredWorldRenderJobInput {
  request: WorldRenderNormalizedCreateRequest
  snapshot: WorldProjectSnapshotV1
  framePlan: readonly WorldFrameTime[]
}

export interface WorldRenderProgressUpdate {
  phase: Exclude<WorldRenderProgressPhase, 'queued' | 'complete'>
  completedFrames: number
}

export interface WorldWebmFrameMasterBytes {
  index: number
  size: number
  sha256: string
  bytes: Uint8Array
}

export interface WorldWebmAudioMasterBytes {
  sampleOffset: number
  sampleCount: number
  bytes: Uint8Array
}

/**
 * Main-process-only lease for a repository-owned regular WebM staging file.
 * The descriptor is inherited directly by FFmpeg; no filesystem path crosses
 * the process boundary. Repeated release calls return the same custody promise.
 */
export interface WorldWebmFileOutputLease {
  readonly fd: number
  release(): Promise<{ readonly extent: number }>
}

interface WorldWebmCoverageInterval {
  start: number
  end: number
}

interface WorldWebmFileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly mode: bigint
}

interface ActiveWorldWebmFileOutputLease {
  readonly lease: WorldWebmFileOutputLease
  readonly completion: Promise<{ readonly extent: number }>
}

interface ActiveWorldWebmSink {
  sinkId: string
  jobId: string
  generation: string
  context: RepositoryContext
  jobRoot: string
  temporaryPath: string
  finalPath: string
  handle: FileHandle
  fileIdentity: WorldWebmFileIdentity
  fileOutputLease: ActiveWorldWebmFileOutputLease | null
  handleClosed: boolean
  cancelled: boolean
  extent: number
  coverage: WorldWebmCoverageInterval[]
  queue: Promise<void>
  commitExtent: number | null
  commitLifecycle: Promise<WorldRenderArtifact> | null
  canonicalArtifact: StoredArtifact | null
  committedArtifact: StoredArtifact | null
  plan: WorldWebmStartPayload
  frames: StoredFrameArtifact[]
  audio: StoredArtifact
  confirmation: Promise<true> | null
}

interface OwnedCancellationOperation {
  promise: Promise<WorldRenderResult<WorldRenderJobDetail>>
  settled: boolean
  result: WorldRenderResult<WorldRenderJobDetail> | null
}

class RenderRepositoryFault extends Error {
  readonly code: WorldRenderPublicErrorCode
  readonly retryable: boolean

  constructor(code: WorldRenderPublicErrorCode, retryable = false) {
    super(code)
    this.code = code
    this.retryable = retryable
  }
}

class DurableArtifactReceiptCheckpointError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super('artifact_receipt_checkpoint_failed')
    this.cause = cause
  }
}

const repositoryQueues = new Map<string, Promise<void>>()

/**
 * Durable derived-output authority. Every caller-provided byte stream is bound
 * to a repository-owned path; callers never choose filesystem destinations.
 */
export class WorldRenderOutputRepository {
  private readonly options: WorldRenderOutputRepositoryOptions
  private readonly createJobId: () => string
  private readonly now: () => Date
  private readonly maximumPinnedResourceBytes: number
  private readonly maximumPinnedResourceTotalBytes: number
  private readonly cancellationWaitMs: number
  private readonly jobCache = new Map<string, StoredJobV1>()
  private readonly executionCache = new Map<string, WorldRenderExecutionPackage>()
  private readonly frameIndexCache = new Map<string, Set<number>>()
  private readonly webmSinks = new Map<string, ActiveWorldWebmSink>()
  private readonly webmSinkAbortions = new Map<string, Promise<true>>()
  private readonly successfulWebmSinkAbortions = new Set<string>()
  private readonly webmCleanupPruneEligibleJobs = new Set<string>()
  private readonly cancelledWebmSinks = new Set<string>()
  private readonly cancellationRequests = new Set<string>()
  private readonly cancellationOperations = new Map<string, OwnedCancellationOperation>()
  private readonly cancellationFinalizations = new Map<string, OwnedCancellationOperation>()

  constructor(options: WorldRenderOutputRepositoryOptions) {
    this.options = options
    this.createJobId = options.createJobId ?? (() => `render-${randomBytes(16).toString('hex')}`)
    this.now = options.now ?? (() => new Date())
    this.maximumPinnedResourceBytes = boundedByteLimit(
      options.maximumPinnedResourceBytes,
      MAX_PINNED_RESOURCE_BYTES,
      'World render pinned resource limit',
    )
    this.maximumPinnedResourceTotalBytes = boundedByteLimit(
      options.maximumPinnedResourceTotalBytes,
      MAX_PINNED_RESOURCE_TOTAL_BYTES,
      'World render pinned resource total limit',
    )
    this.cancellationWaitMs = boundedDuration(
      options.cancellationWaitMs,
      DEFAULT_CANCELLATION_WAIT_MS,
      MIN_CANCELLATION_WAIT_MS,
      MAX_CANCELLATION_WAIT_MS,
      'World render cancellation wait',
    )
  }

  async createJob(input: CreateStoredWorldRenderJobInput): Promise<WorldRenderResult<WorldRenderJobDetail>> {
    return this.withWriteQueue(async (context) => {
      const parsedRequest = parseWorldRenderCreateRequest(input.request)
      if (!parsedRequest.success) throw new RenderRepositoryFault('invalid_request')
      const validated = validateWorldProjectSnapshot(input.snapshot)
      if (!validated.success) throw new RenderRepositoryFault('invalid_request')
      const request = parsedRequest.value
      const snapshot = cloneWorldProjectSnapshot(validated.value)
      if (snapshot.project.revision !== request.expectedRevision) throw new RenderRepositoryFault('revision_conflict', true)
      const scene = snapshot.scenes.find((candidate) => candidate.sceneId === request.sceneId)
      if (!scene) throw new RenderRepositoryFault('scene_not_found')
      const sequence = scene.sequences.find((candidate) => candidate.id === request.sequenceId)
      if (!sequence) throw new RenderRepositoryFault('sequence_not_found')
      assertDurationBound(sequence.duration)
      const expectedPlan = enumerateWorldFrames(sequence.duration, request.preset.fps, WORLD_RENDER_MAX_FRAME_COUNT)
      if (!sameFramePlan(expectedPlan, input.framePlan)) throw new RenderRepositoryFault('invalid_request')

      const entries = await readdir(context.outputRoot, { withFileTypes: true })
      const existingJobs = entries.filter((entry) => isWorldRenderJobId(entry.name))
      if (existingJobs.length >= WORLD_RENDER_MAX_STORED_JOBS) throw new RenderRepositoryFault('job_busy', true)

      let jobId = ''
      let jobRoot = ''
      let allocated = false
      for (let attempt = 0; attempt < 8; attempt += 1) {
        jobId = this.createJobId()
        if (!isWorldRenderJobId(jobId)) throw new RenderRepositoryFault('write_failed', true)
        jobRoot = join(context.outputRoot, jobId)
        assertContained(context.outputRoot, jobRoot)
        try {
          await mkdir(jobRoot, { mode: 0o700 })
          allocated = true
          break
        } catch (error) {
          if (nodeErrorCode(error) !== 'EEXIST' || attempt === 7) throw new RenderRepositoryFault('write_failed', true)
        }
      }

      try {
        if (!allocated) throw new RenderRepositoryFault('write_failed', true)
        await createJobDirectories(jobRoot)
        const resources = await this.pinResources(context, jobRoot, jobId, snapshot.project.resources)
        const packageValue: WorldRenderSnapshotPackageV1 = {
          schema: WORLD_RENDER_SNAPSHOT_SCHEMA,
          jobId,
          projectKey: request.projectKey,
          projectId: snapshot.project.projectId,
          revision: snapshot.project.revision,
          sceneId: request.sceneId,
          sequenceId: request.sequenceId,
          preset: { ...request.preset },
          project: structuredClone(snapshot.project),
          scenes: structuredClone(snapshot.scenes),
          sequence: structuredClone(sequence),
          resources: resources.map(clonePinnedResource),
          framePlan: describeFramePlan(expectedPlan, request.preset.fps),
        }
        const snapshotBytes = encodeJson(packageValue)
        if (snapshotBytes.byteLength > MAX_JSON_BYTES) throw new RenderRepositoryFault('invalid_request')
        const snapshotPath = join(jobRoot, SNAPSHOT_FILE)
        await atomicWriteBytes(snapshotPath, snapshotBytes, this.options.syncDirectory)
        await chmod(snapshotPath, 0o400)
        const now = canonicalTimestamp(this.now())
        const state: StoredJobV1 = {
          schema: WORLD_RENDER_JOB_SCHEMA,
          jobId,
          request,
          projectId: snapshot.project.projectId,
          duration: normalizeWorldRationalTime(sequence.duration),
          frameCount: expectedPlan.length,
          snapshot: artifactFor(context, snapshotPath, snapshotBytes),
          status: 'queued',
          progress: progressFor('queued', 0, expectedPlan.length),
          outputs: { frames: [], audio: null, renderManifest: null, webm: null },
          error: null,
          createdAt: now,
          updatedAt: now,
        }
        await this.publishState(jobRoot, null, state)
        return success(publicDetail(state))
      } catch (error) {
        if (allocated) await safeRemoveUnpublishedJob(context.outputRoot, jobRoot)
        throw error
      }
    })
  }

  async list(): Promise<WorldRenderListResult> {
    return this.withReadQueue(async (context) => {
      if (!context) return success({ jobs: [] })
      const states = await this.loadAll(context, false)
      return success({
        jobs: states.map(publicSummary),
      })
    })
  }

  async get(requestValue: unknown): Promise<WorldRenderGetResult> {
    const parsed = parseWorldRenderJobKeyRequest(requestValue)
    if (!parsed.success) return failure('invalid_request')
    return this.withReadQueue(async (context) => {
      if (!context) throw new RenderRepositoryFault('job_not_found')
      const state = await this.loadJob(context, parsed.value.jobId, false)
      return success(publicDetail(state))
    })
  }

  async openExecutionPackage(jobId: string, signal?: AbortSignal): Promise<WorldRenderExecutionPackage> {
    if (!isWorldRenderJobId(jobId)) throw new RenderRepositoryFault('invalid_request')
    throwIfRepositoryAborted(signal)
    const result = await this.withReadQueue(async (context) => {
      throwIfRepositoryAborted(signal)
      if (!context) throw new RenderRepositoryFault('job_not_found')
      const jobRoot = jobRootFor(context, jobId)
      const state = this.jobCache.get(jobRoot)
      if (!state) throw new RenderRepositoryFault('recovery_failed', true)
      return success({ context, jobRoot, state })
    }, signal)
    if (!result.ok) throw new RenderRepositoryFault(result.error.code, result.error.retryable)
    throwIfRepositoryAborted(signal)
    // The potentially large snapshot/resource verification deliberately runs
    // outside the repository queue. Durable cancellation can therefore be
    // published while preflight is hashing pinned bytes.
    const execution = await this.loadExecutionPackage(
      result.value.context,
      result.value.jobRoot,
      result.value.state,
      true,
      signal,
    )
    throwIfRepositoryAborted(signal)
    return cloneExecutionPackage(execution)
  }

  /**
   * Reads only a file declared by the immutable render snapshot. Paths never
   * cross this boundary. Bytes are bounded and re-hashed after the read so a
   * same-size mutation cannot be served to the sandboxed renderer.
   */
  async readPinnedResource(
    jobId: string,
    resourceId: string,
    role: WorldRenderPinnedResourceRole,
    signal: AbortSignal,
  ): Promise<WorldRenderPinnedResourceBytes> {
    if (!isWorldRenderJobId(jobId) || !isWorldCanonicalId(resourceId)
      || !['primary', 'source', 'legacy'].includes(role)) {
      throw new RenderRepositoryFault('invalid_request')
    }
    throwIfRepositoryAborted(signal)
    const result = await this.withReadQueue(async (context) => {
      throwIfRepositoryAborted(signal)
      if (!context) throw new RenderRepositoryFault('job_not_found')
      const jobRoot = jobRootFor(context, jobId)
      // openExecutionPackage() performs the complete on-disk preflight and is
      // required before a render host can request bytes. Reuse that private,
      // non-exported package here instead of re-hashing every unrelated pinned
      // resource while holding the durable repository queue. The requested
      // file itself is still reopened and verified below on every request.
      const state = this.jobCache.get(jobRoot)
      const execution = this.executionCache.get(jobRoot)
      if (!state || !execution || execution.snapshotSha256 !== state.snapshot.sha256) {
        throw new RenderRepositoryFault('output_invalid')
      }
      const resource = execution.resources.find((candidate) => candidate.resource.id === resourceId)
      const file = resource?.files.find((candidate) => candidate.role === role)
      if (!file) throw new RenderRepositoryFault('output_invalid')
      if (file.size > MAX_RENDERER_RESOURCE_BYTES) throw new RenderRepositoryFault('output_invalid')
      const path = resolveWorkspaceArtifactPath(context, file.workspacePath)
      assertContained(join(jobRoot, 'snapshot', 'resources'), path)
      return success({ path, size: file.size, sha256: file.sha256 })
    }, signal)
    throwIfRepositoryAborted(signal)
    if (!result.ok) throw new RenderRepositoryFault(result.error.code, result.error.retryable)
    const bytes = await readPinnedResourceBytes(
      result.value.path,
      result.value.size,
      result.value.sha256,
      signal,
    )
    throwIfRepositoryAborted(signal)
    return {
      resourceId,
      role,
      size: result.value.size,
      sha256: result.value.sha256,
      bytes,
    }
  }

  async updateProgress(jobId: string, update: WorldRenderProgressUpdate): Promise<WorldRenderResult<WorldRenderProgress>> {
    return this.mutate(jobId, (state) => {
      if (!isProgressUpdate(update, state.frameCount)) throw new RenderRepositoryFault('invalid_request')
      if (TERMINAL_STATUSES.has(state.status) || state.status === 'cancel_requested') return state
      const previousRank = phaseRank(state.progress.phase)
      const nextRank = phaseRank(update.phase)
      if (nextRank < previousRank || update.completedFrames < state.progress.completedFrames) {
        throw new RenderRepositoryFault('invalid_request')
      }
      if ((update.phase === 'rendering-audio' || update.phase === 'assembling')
        && update.completedFrames !== state.frameCount) throw new RenderRepositoryFault('invalid_request')
      if (update.completedFrames > state.outputs.frames.length) throw new RenderRepositoryFault('invalid_request')
      if (update.phase === 'assembling' && !state.outputs.audio) throw new RenderRepositoryFault('invalid_request')
      return {
        ...state,
        status: update.phase,
        progress: progressFor(update.phase, update.completedFrames, state.frameCount),
        updatedAt: canonicalTimestamp(this.now()),
      }
    }, (state) => ({ ...state.progress }))
  }

  async recordFrame(jobId: string, index: number, data: WorldRenderArtifactInput): Promise<WorldRenderResult<WorldRenderFrameArtifact>> {
    if (!isWorldRenderJobId(jobId) || !Number.isSafeInteger(index) || index < 0) return failure('invalid_request')
    return this.withWriteQueue(async (context) => {
      const jobRoot = jobRootFor(context, jobId)
      let state = await this.loadJobForMutation(context, jobId)
      assertWritableOutputState(state)
      const key = repositoryCacheKey(context, jobId)
      const indexes = this.frameIndexCache.get(key) ?? new Set(state.outputs.frames.map((frame) => frame.index))
      this.frameIndexCache.set(key, indexes)
      if (index >= state.frameCount || indexes.has(index)) {
        throw new RenderRepositoryFault('output_invalid')
      }
      const execution = await this.loadExecutionPackage(context, jobRoot, state)
      const frame = execution.framePlan[index]
      if (!frame || frame.index !== index) throw new RenderRepositoryFault('recovery_failed', true)
      const path = join(jobRoot, 'frames', frameFilename(index))
      const artifact = await writeOwnedArtifact(
        context,
        path,
        data,
        WORLD_RENDER_ARTIFACT_MAX_BYTES.frame,
        this.options.syncDirectory,
      )
      await this.checkpoint('artifact-written')
      const descriptor: StoredFrameArtifact = { ...artifact, ...cloneFrameArtifactTime(frame) }
      await this.publishArtifactReceipt(jobRoot, {
        schema: ARTIFACT_RECEIPT_SCHEMA,
        jobId,
        kind: 'frame',
        index,
        artifact: descriptor,
      })
      state = {
        ...state,
        outputs: {
          ...state.outputs,
          frames: [...state.outputs.frames, descriptor],
        },
      }
      indexes.add(index)
      this.rememberState(context, state)
      return success({ ...descriptor, time: { ...descriptor.time } })
    })
  }

  async recordAudio(jobId: string, data: WorldRenderArtifactInput): Promise<WorldRenderResult<WorldRenderArtifact>> {
    return this.recordSingleton(
      jobId,
      'audio',
      join('audio', 'master.wav'),
      data,
      WORLD_RENDER_ARTIFACT_MAX_BYTES.audio,
    )
  }

  async recordWebm(jobId: string, data: WorldRenderArtifactInput): Promise<WorldRenderResult<WorldRenderArtifact>> {
    return this.recordSingleton(jobId, 'webm', 'output.webm', data, WORLD_RENDER_ARTIFACT_MAX_BYTES.webm)
  }

  /**
   * Opens a repository-owned random-access WebM target after every PNG/WAV
   * master has been durably verified. The returned opaque id conveys no path.
   */
  async beginWebmAssembly(
    jobId: string,
    generation: string,
    plan: WorldWebmStartPayload,
    signal?: AbortSignal,
  ): Promise<{ sinkId: string }> {
    assertWebmIdentity(jobId, generation)
    throwIfRepositoryAborted(signal)
    if (this.cancellationRequests.has(jobId)) throw abortError('World WebM assembly was cancelled.')
    const result = await this.withWriteQueue(async (context) => {
      throwIfRepositoryAborted(signal)
      const jobRoot = jobRootFor(context, jobId)
      const state = sortStoredFrames(await this.loadJobForMutation(context, jobId))
      this.rememberState(context, state)
      if (state.status !== 'assembling' || state.outputs.webm || !webmPlanMatchesState(plan, state)
        || [...this.webmSinks.values()].some((sink) => sink.jobId === jobId)) {
        throw new RenderRepositoryFault('job_busy', true)
      }
      if (!await this.verifyCompleteMasters(context, jobRoot, state) || !state.outputs.audio) {
        throw new RenderRepositoryFault('output_invalid')
      }
      throwIfRepositoryAborted(signal)
      let sinkId = ''
      let temporaryPath = ''
      let handle: FileHandle | null = null
      for (let attempt = 0; attempt < 8; attempt += 1) {
        sinkId = `sink-${randomBytes(16).toString('hex')}`
        temporaryPath = join(jobRoot, `.webm-${sinkId.slice(5)}.tmp`)
        assertContained(context.outputRoot, temporaryPath)
        try {
          handle = await open(
            temporaryPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
            0o600,
          )
          break
        } catch (error) {
          if (nodeErrorCode(error) !== 'EEXIST' || attempt === 7) throw new RenderRepositoryFault('write_failed', true)
        }
      }
      if (!handle) throw new RenderRepositoryFault('write_failed', true)
      let fileIdentity: WorldWebmFileIdentity
      try {
        fileIdentity = observeInitialWebmFile(handle.fd, await handle.stat({ bigint: true }))
      } catch (error) {
        await handle.close().catch(() => undefined)
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
      if (signal?.aborted || this.cancellationRequests.has(jobId)) {
        await handle.close().catch(() => undefined)
        await rm(temporaryPath, { force: true })
        throw abortError('World WebM assembly was cancelled.')
      }
      const sink: ActiveWorldWebmSink = {
        sinkId,
        jobId,
        generation,
        context,
        jobRoot,
        temporaryPath,
        finalPath: join(jobRoot, 'output.webm'),
        handle,
        fileIdentity,
        fileOutputLease: null,
        handleClosed: false,
        cancelled: false,
        extent: 0,
        coverage: [],
        queue: Promise.resolve(),
        commitExtent: null,
        commitLifecycle: null,
        canonicalArtifact: null,
        committedArtifact: null,
        plan: structuredClone(plan),
        frames: state.outputs.frames.map((frame) => ({ ...frame, time: { ...frame.time } })),
        audio: { ...state.outputs.audio },
        confirmation: null,
      }
      this.webmSinks.set(sinkId, sink)
      return success({ sinkId })
    })
    return unwrapWebmInternalResult(result)
  }

  /**
   * Synchronously transfers staging-file custody to a child descriptor slot.
   * The method performs its final identity check without an await so no
   * interposed callback can replace the target between validation and spawn.
   */
  acquireWebmFileOutputLease(
    jobId: string,
    generation: string,
    sinkId: string,
  ): WorldWebmFileOutputLease {
    const sink = this.requireWebmSink(jobId, generation, sinkId)
    if (sink.handleClosed || sink.fileOutputLease || sink.commitLifecycle
      || sink.extent !== 0 || sink.coverage.length !== 0) {
      throw new RenderRepositoryFault('invalid_request')
    }
    assertSameWebmFile(sink.fileIdentity, fstatSync(sink.handle.fd, { bigint: true }), 0n)

    let releaseStarted = false
    let resolveRelease!: (value: { readonly extent: number }) => void
    let rejectRelease!: (error: unknown) => void
    const completion = new Promise<{ readonly extent: number }>((resolvePromise, rejectPromise) => {
      resolveRelease = resolvePromise
      rejectRelease = rejectPromise
    })
    void completion.catch(() => undefined)
    const lease: WorldWebmFileOutputLease = Object.freeze({
      fd: sink.handle.fd,
      release: (): Promise<{ readonly extent: number }> => {
        if (!releaseStarted) {
          releaseStarted = true
          void this.releaseWebmFileOutputLease(sink).then(resolveRelease, rejectRelease)
        }
        return completion
      },
    })
    sink.fileOutputLease = { lease, completion }
    return lease
  }

  private async releaseWebmFileOutputLease(
    sink: ActiveWorldWebmSink,
  ): Promise<{ readonly extent: number }> {
    await sink.queue
    const info = await sink.handle.stat({ bigint: true })
    assertSameWebmFile(sink.fileIdentity, info)
    if (info.size < 0n || info.size > BigInt(WORLD_WEBM_MAX_OUTPUT_BYTES)) {
      throw new RenderRepositoryFault('output_invalid')
    }
    const extent = Number(info.size)
    sink.extent = extent
    sink.coverage = extent === 0 ? [] : [{ start: 0, end: extent }]
    return { extent }
  }

  async readWebmFrameMaster(
    jobId: string,
    generation: string,
    sinkId: string,
    index: number,
    signal?: AbortSignal,
  ): Promise<WorldWebmFrameMasterBytes> {
    const sink = this.requireWebmSink(jobId, generation, sinkId)
    if (!Number.isSafeInteger(index) || index < 0 || index >= sink.plan.frameCount) {
      throw new RenderRepositoryFault('invalid_request')
    }
    throwIfRepositoryAborted(signal)
    const artifact = sink.frames[index]
    if (!artifact || artifact.index !== index || artifact.size <= 0
      || artifact.size > WORLD_RENDER_ARTIFACT_MAX_BYTES.frame) {
      throw new RenderRepositoryFault('output_invalid')
    }
    const path = resolveWorkspaceArtifactPath(sink.context, artifact.workspacePath)
    const bytes = await readBounded(path, WORLD_RENDER_ARTIFACT_MAX_BYTES.frame, signal)
    throwIfRepositoryAborted(signal)
    if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256) {
      throw new RenderRepositoryFault('output_invalid')
    }
    return { index, size: artifact.size, sha256: artifact.sha256, bytes }
  }

  async readWebmAudioMaster(
    jobId: string,
    generation: string,
    sinkId: string,
    sampleOffset: number,
    sampleCount: number,
    signal?: AbortSignal,
  ): Promise<WorldWebmAudioMasterBytes> {
    const sink = this.requireWebmSink(jobId, generation, sinkId)
    if (!Number.isSafeInteger(sampleOffset) || sampleOffset < 0
      || !Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > WORLD_WEBM_MAX_AUDIO_CHUNK_SAMPLES
      || sampleOffset + sampleCount > sink.plan.audioSampleCount) {
      throw new RenderRepositoryFault('invalid_request')
    }
    throwIfRepositoryAborted(signal)
    const path = resolveWorkspaceArtifactPath(sink.context, sink.audio.workspacePath)
    const bytes = await readVerifiedArtifactRange(path, sink.audio.size, 44 + sampleOffset * 4, sampleCount * 4, signal)
    throwIfRepositoryAborted(signal)
    return { sampleOffset, sampleCount, bytes }
  }

  async writeWebmAssembly(
    jobId: string,
    generation: string,
    sinkId: string,
    position: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ written: number; extent: number }> {
    const sink = this.requireWebmSink(jobId, generation, sinkId)
    if (sink.fileOutputLease) throw new RenderRepositoryFault('invalid_request')
    if (!(data instanceof Uint8Array) || data.byteLength < 1 || data.byteLength > WORLD_WEBM_MAX_WRITE_BYTES
      || !Number.isSafeInteger(position) || position < 0 || position >= WORLD_WEBM_MAX_OUTPUT_BYTES
      || position + data.byteLength > WORLD_WEBM_MAX_OUTPUT_BYTES) {
      throw new RenderRepositoryFault('invalid_request')
    }
    throwIfRepositoryAborted(signal)
    const owned = Buffer.from(data)
    return this.enqueueWebmSink(sink, async () => {
      throwIfWebmSinkUnavailable(sink, signal)
      if (sink.fileOutputLease) throw new RenderRepositoryFault('invalid_request')
      await writeAllPositioned(sink.handle, owned, position, this.options.positionedWrite)
      throwIfWebmSinkUnavailable(sink, signal)
      sink.extent = Math.max(sink.extent, position + owned.byteLength)
      sink.coverage = mergeCoverage(sink.coverage, position, position + owned.byteLength)
      return { written: owned.byteLength, extent: sink.extent }
    })
  }

  commitWebmAssembly(
    jobId: string,
    generation: string,
    sinkId: string,
    extent: number,
    signal?: AbortSignal,
  ): Promise<WorldRenderArtifact> {
    let sink: ActiveWorldWebmSink
    try {
      sink = this.requireWebmSink(jobId, generation, sinkId)
      if (!Number.isSafeInteger(extent) || extent < 1 || extent > WORLD_WEBM_MAX_OUTPUT_BYTES) {
        throw new RenderRepositoryFault('invalid_request')
      }
      if (sink.commitLifecycle) {
        if (sink.commitExtent !== extent) throw new RenderRepositoryFault('invalid_request')
        return sink.commitLifecycle
      }
    } catch (error) {
      return Promise.reject(error)
    }

    // Publish the exact lifecycle before its first asynchronous boundary. Abort
    // and every retry join this same authority instead of racing the rename.
    const lifecycle = this.commitActiveWebmSink(sink, extent, signal)
    sink.commitExtent = extent
    sink.commitLifecycle = lifecycle
    void lifecycle.catch(() => undefined)
    return lifecycle
  }

  private async commitActiveWebmSink(
    sink: ActiveWorldWebmSink,
    extent: number,
    signal?: AbortSignal,
  ): Promise<WorldRenderArtifact> {
    const { jobId } = sink
    throwIfWebmSinkUnavailable(sink, signal)
    if (sink.fileOutputLease) await sink.fileOutputLease.completion
    await sink.queue
    throwIfWebmSinkUnavailable(sink, signal)
    if (extent !== sink.extent || !hasCompleteCoverage(sink.coverage, extent)) {
      throw new RenderRepositoryFault('output_invalid')
    }
    await sink.handle.sync()
    await sink.handle.close()
    sink.handleClosed = true
    throwIfWebmSinkUnavailable(sink, signal)
    await verifyWebmPath(sink.temporaryPath, extent, sink.plan)
    const digest = await sha256File(sink.temporaryPath, signal)
    throwIfWebmSinkUnavailable(sink, signal)

    const result = await this.withWriteQueue(async (context) => {
      throwIfWebmSinkUnavailable(sink, signal)
      const state = sortStoredFrames(await this.loadJobForMutation(context, jobId))
      if (state.status !== 'assembling' || state.outputs.webm || !webmPlanMatchesState(sink.plan, state)) {
        sink.cancelled = true
        throw new RenderRepositoryFault('job_busy', true)
      }
      if (!await this.verifyCompleteMasters(context, sink.jobRoot, state)) {
        throw new RenderRepositoryFault('output_invalid')
      }
      throwIfWebmSinkUnavailable(sink, signal)
      const info = await lstat(sink.temporaryPath, { bigint: true })
      if (info.isSymbolicLink()) throw new RenderRepositoryFault('unsafe_workspace')
      assertSameWebmFile(sink.fileIdentity, info, BigInt(extent))
      await rejectPathIfPresent(sink.finalPath)
      const artifact: StoredArtifact = {
        workspacePath: workspaceRelativePath(context, sink.finalPath),
        size: extent,
        sha256: digest,
      }
      await rename(sink.temporaryPath, sink.finalPath)
      // rename() is the ownership linearization point. Record the descriptor in
      // the same continuation before any callback/checkpoint can interleave.
      sink.canonicalArtifact = { ...artifact }
      try {
        throwIfWebmSinkUnavailable(sink, signal)
        await syncDirectoryWith(dirname(sink.finalPath), this.options.syncDirectory)
        throwIfWebmSinkUnavailable(sink, signal)
        await verifyWebmArtifact(context, artifact, sink.plan)
        throwIfWebmSinkUnavailable(sink, signal)
        sink.committedArtifact = { ...artifact }
        return success({ ...artifact })
      } catch (error) {
        await safeRemoveSingleFile(sink.finalPath, true)
        await syncDirectoryWith(dirname(sink.finalPath), this.options.syncDirectory)
        sink.canonicalArtifact = null
        throw error
      }
    })
    if (!result.ok) {
      if (sink.cancelled || signal?.aborted) throw abortError('World WebM assembly was cancelled.')
      throw new RenderRepositoryFault(result.error.code, result.error.retryable)
    }
    return result.value
  }

  confirmWebmAssembly(jobId: string, generation: string, sinkId: string): Promise<true> {
    let sink: ActiveWorldWebmSink
    try {
      sink = this.requireWebmSink(jobId, generation, sinkId)
      if (!sink.committedArtifact) throw new RenderRepositoryFault('invalid_request')
    } catch (error) {
      return Promise.reject(error)
    }
    if (sink.confirmation) return sink.confirmation
    const confirmation = this.confirmActiveWebmSink(sink)
    sink.confirmation = confirmation
    void confirmation.catch(() => undefined)
    return confirmation
  }

  private async confirmActiveWebmSink(sink: ActiveWorldWebmSink): Promise<true> {
    const { jobId, sinkId } = sink
    const artifact = sink.committedArtifact
    if (!artifact) throw new RenderRepositoryFault('invalid_request')
    const result = await this.withWriteQueue(async (context) => {
      throwIfWebmSinkUnavailable(sink)
      const state = await this.loadJobForMutation(context, jobId)
      throwIfWebmSinkUnavailable(sink)
      if (state.status !== 'assembling' || state.outputs.webm || !webmPlanMatchesState(sink.plan, state)) {
        throw new RenderRepositoryFault('job_busy', true)
      }
      const mastersComplete = await this.verifyCompleteMasters(context, sink.jobRoot, state)
      throwIfWebmSinkUnavailable(sink)
      if (!mastersComplete) throw new RenderRepositoryFault('output_invalid')
      await verifyWebmArtifact(context, artifact, sink.plan)
      throwIfWebmSinkUnavailable(sink)
      const next: StoredJobV1 = {
        ...state,
        outputs: { ...state.outputs, webm: artifact },
        updatedAt: canonicalTimestamp(this.now()),
      }
      const rollbackUnconfirmed = async (preserveForCancellation = false): Promise<void> => {
        if (preserveForCancellation
          && (sink.cancelled || this.cancellationRequests.has(jobId))) return
        const published = await this.readPublishedState(sink.jobRoot)
        if (sameStoredArtifact(published.outputs.webm, artifact) && !TERMINAL_STATUSES.has(published.status)) {
          await this.publishState(sink.jobRoot, published, state)
        }
        await removeArtifactReceipt(sink.jobRoot, 'webm', null)
        await syncDirectoryWith(join(sink.jobRoot, ARTIFACT_RECEIPT_DIRECTORY), this.options.syncDirectory)
      }
      try {
        // State is published first. Recovery reconstructs outputs from receipts,
        // so a crash before the receipt remains an unconfirmed masters-only job.
        await this.publishState(sink.jobRoot, state, next)
        throwIfWebmSinkUnavailable(sink)
      } catch (error) {
        await rollbackUnconfirmed()
        throw error
      }
      const receipt: ArtifactReceiptV1 = {
        schema: ARTIFACT_RECEIPT_SCHEMA,
        jobId,
        kind: 'webm',
        index: null,
        artifact,
      }
      try {
        await this.publishArtifactReceipt(sink.jobRoot, receipt)
      } catch (error) {
        const receiptIsDurable = error instanceof DurableArtifactReceiptCheckpointError
          && await hasMatchingWebmReceipt(sink.jobRoot, jobId, artifact)
        if (!receiptIsDurable) {
          await rollbackUnconfirmed()
          throw error
        }
        // The exact atomic receipt is the durable terminal-confirmation point.
        // A later checkpoint error cannot turn it into a renderer failure.
      }
      try {
        // Cancellation may arrive inside any receipt write/rename/fsync/checkpoint.
        // Recheck after the complete durability operation before publication is
        // acknowledged or the active cleanup authority is released.
        throwIfWebmSinkUnavailable(sink)
      } catch (error) {
        // A durable receipt may now exist. Cancellation owns its retraction via
        // the fsynced cancellation intent rather than this confirmation path.
        await rollbackUnconfirmed(true)
        throw error
      }
      if (this.webmSinks.get(sinkId) !== sink || !this.webmSinks.delete(sinkId)) {
        throw new RenderRepositoryFault('internal_error', true)
      }
      return success(true as const)
    })
    if (!result.ok && sink.cancelled) throw abortError('World WebM assembly was cancelled.')
    return unwrapWebmInternalResult(result)
  }

  abortWebmAssembly(jobId: string, generation: string, sinkId: string): Promise<true> {
    try {
      assertWebmIdentity(jobId, generation)
      if (!/^sink-[a-f0-9]{32}$/.test(sinkId)) throw new RenderRepositoryFault('invalid_request')
    } catch (error) {
      return Promise.reject(error)
    }
    const identity = webmSinkIdentityKey(jobId, generation, sinkId)
    const existing = this.webmSinkAbortions.get(identity)
    if (existing) return existing
    const sink = this.webmSinks.get(sinkId)
    if (!sink || sink.jobId !== jobId || sink.generation !== generation) {
      return Promise.reject(new RenderRepositoryFault('invalid_request'))
    }
    sink.cancelled = true
    this.cancelledWebmSinks.add(identity)
    const cleanup = this.cleanupWebmSink(sink).then(() => {
      if (this.webmSinks.get(sinkId) !== sink || !this.webmSinks.delete(sinkId)) {
        throw new RenderRepositoryFault('internal_error', true)
      }
      this.successfulWebmSinkAbortions.add(identity)
      const state = this.jobCache.get(sink.jobRoot)
      if ((state && TERMINAL_STATUSES.has(state.status))
        || this.webmCleanupPruneEligibleJobs.has(jobId)) {
        this.pruneSuccessfulWebmCleanupState(jobId)
      }
      return true as const
    })
    this.webmSinkAbortions.set(identity, cleanup)
    return cleanup
  }

  private pruneSuccessfulWebmCleanupState(jobId: string): void {
    const prefix = `${jobId}:`
    for (const identity of this.successfulWebmSinkAbortions) {
      if (!identity.startsWith(prefix)) continue
      this.successfulWebmSinkAbortions.delete(identity)
      this.webmSinkAbortions.delete(identity)
      this.cancelledWebmSinks.delete(identity)
    }
    const hasRetainedCleanup = [...this.webmSinkAbortions.keys()].some((identity) => identity.startsWith(prefix))
    if (hasRetainedCleanup) this.webmCleanupPruneEligibleJobs.add(jobId)
    else this.webmCleanupPruneEligibleJobs.delete(jobId)
  }

  private async cleanupWebmSink(sink: ActiveWorldWebmSink): Promise<void> {
    let cleanupFailure: unknown = null
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try { await operation() } catch (error) { cleanupFailure ??= error }
    }

    // A commit may own the canonical path even though committedArtifact has not
    // yet been assigned. Join its exact memoized lifecycle before inspecting
    // or retracting either path. The commit's expected cancellation rejection
    // is consumed; cleanup independently proves the filesystem state below.
    if (sink.commitLifecycle) await sink.commitLifecycle.catch(() => undefined)
    if (sink.fileOutputLease) {
      await attempt(async () => { await sink.fileOutputLease?.completion })
    }
    await attempt(async () => { await sink.queue })
    if (!sink.handleClosed) {
      await attempt(async () => {
        await sink.handle.close()
        sink.handleClosed = true
      })
    }
    await attempt(async () => { await safeRemoveSingleFile(sink.temporaryPath, true) })
    const canonicalArtifact = sink.canonicalArtifact ?? sink.committedArtifact
    if (!canonicalArtifact) {
      await attempt(async () => { await syncDirectoryWith(sink.jobRoot, this.options.syncDirectory) })
    } else {
      const artifact = canonicalArtifact
      await attempt(async () => {
        const result = await this.withWriteQueue(async (context) => {
          const state = await this.loadJobForMutation(context, sink.jobId)
          const ownsPublishedArtifact = sameStoredArtifact(state.outputs.webm, artifact)
          let removeOwnedArtifact = !state.outputs.webm
          if (ownsPublishedArtifact && !TERMINAL_STATUSES.has(state.status)) {
            const next: StoredJobV1 = {
              ...state,
              outputs: { ...state.outputs, webm: null },
              updatedAt: canonicalTimestamp(this.now()),
            }
            await this.publishState(sink.jobRoot, state, next)
            removeOwnedArtifact = true
          }
          if (removeOwnedArtifact) {
            await verifyArtifact(context, artifact).catch((error) => {
              if (nodeErrorCode(error) !== 'ENOENT') throw error
            })
            await removeArtifactReceipt(sink.jobRoot, 'webm', null)
            await safeRemoveSingleFile(sink.finalPath, true)
            await syncDirectoryWith(join(sink.jobRoot, ARTIFACT_RECEIPT_DIRECTORY), this.options.syncDirectory)
            await syncDirectoryWith(sink.jobRoot, this.options.syncDirectory)
            sink.canonicalArtifact = null
            sink.committedArtifact = null
          }
          return success(null)
        })
        unwrapWebmInternalResult(result)
      })
    }
    if (cleanupFailure) {
      throw cleanupFailure instanceof RenderRepositoryFault
        ? cleanupFailure
        : new RenderRepositoryFault('write_failed', true)
    }
  }

  async requestCancel(jobId: string): Promise<WorldRenderResult<WorldRenderJobDetail>> {
    if (!isWorldRenderJobId(jobId)) return failure('invalid_request')
    // Acceptance is process-local and immediate. It must beat a settlement
    // already queued behind the caller, including one whose terminal state is
    // published before this operation acquires durable custody.
    this.cancellationRequests.add(jobId)
    for (const sink of this.webmSinks.values()) {
      if (sink.jobId === jobId) sink.cancelled = true
    }
    const operation = this.ownedCancellationOperation(jobId)
    const result = await waitForOwnedCancellation(operation.promise, this.cancellationWaitMs)
    if (result?.ok && TERMINAL_STATUSES.has(result.value.status)) {
      if (this.cancellationOperations.get(jobId) === operation) this.cancellationOperations.delete(jobId)
      this.cancellationFinalizations.delete(jobId)
    }
    return result ?? failure('write_failed')
  }

  private ownedCancellationOperation(jobId: string): OwnedCancellationOperation {
    const existing = this.cancellationOperations.get(jobId)
    if (existing && (!existing.settled || existing.result?.ok)) return existing
    const operation = this.trackCancellationOperation(this.performCancellationRequest(jobId))
    this.cancellationOperations.set(jobId, operation)
    return operation
  }

  private trackCancellationOperation(
    raw: Promise<WorldRenderResult<WorldRenderJobDetail>>,
  ): OwnedCancellationOperation {
    const operation: OwnedCancellationOperation = {
      promise: Promise.resolve(failure('write_failed')),
      settled: false,
      result: null,
    }
    operation.promise = raw.catch((error) => failureFrom(error)).then((result) => {
      operation.settled = true
      operation.result = result
      return result
    })
    void operation.promise.catch(() => undefined)
    return operation
  }

  private async performCancellationRequest(jobId: string): Promise<WorldRenderResult<WorldRenderJobDetail>> {
    const initialSinks = [...this.webmSinks.values()].filter((sink) => sink.jobId === jobId)
    for (const sink of initialSinks) sink.cancelled = true
    // Confirmation remains the exact authority for a possibly durable receipt.
    // The public request is bounded separately, while this owned operation keeps
    // joining it until the transaction can safely establish its intent.
    await Promise.all(initialSinks.map(async (sink) => {
      await sink.confirmation?.catch(() => undefined)
    }))
    const result = await this.withWriteQueue(async (context) => {
      const jobRoot = jobRootFor(context, jobId)
      const state = await this.loadJobForMutation(context, jobId)
      if (state.status === 'cancelled' || state.status === 'recovery_failed') {
        return success(publicDetail(state))
      }
      const next = await this.publishCancellationState(context, jobRoot, state)
      return success(publicDetail(next))
    })
    if (!result.ok || TERMINAL_STATUSES.has(result.value.status)) {
      if (result.ok) {
        this.cancellationRequests.delete(jobId)
        this.pruneSuccessfulWebmCleanupState(jobId)
      }
      return result
    }

    const cleanupSinks = new Map(initialSinks.map((sink) => [sink.sinkId, sink]))
    for (const sink of this.webmSinks.values()) {
      if (sink.jobId === jobId) cleanupSinks.set(sink.sinkId, sink)
    }
    for (const sink of cleanupSinks.values()) {
      try {
        await this.abortWebmAssembly(jobId, sink.generation, sink.sinkId)
      } catch (error) {
        return failureFrom(error)
      }
    }
    return result
  }

  private requireWebmSink(jobId: string, generation: string, sinkId: string): ActiveWorldWebmSink {
    assertWebmIdentity(jobId, generation)
    if (!/^sink-[a-f0-9]{32}$/.test(sinkId)) throw new RenderRepositoryFault('invalid_request')
    const sink = this.webmSinks.get(sinkId)
    if (sink?.jobId === jobId && sink.generation === generation && sink.cancelled) {
      throw abortError('World WebM assembly was cancelled.')
    }
    if (!sink && this.cancelledWebmSinks.has(webmSinkIdentityKey(jobId, generation, sinkId))) {
      throw abortError('World WebM assembly was cancelled.')
    }
    if (!sink || sink.jobId !== jobId || sink.generation !== generation) {
      throw new RenderRepositoryFault('invalid_request')
    }
    return sink
  }

  private async enqueueWebmSink<T>(sink: ActiveWorldWebmSink, operation: () => Promise<T>): Promise<T> {
    const result = sink.queue.then(operation)
    sink.queue = result.then(() => undefined, () => undefined)
    return result
  }

  async finishCancelled(jobId: string): Promise<WorldRenderResult<WorldRenderJobDetail>> {
    if (!isWorldRenderJobId(jobId)) return failure('invalid_request')
    let operation = this.cancellationFinalizations.get(jobId)
    if (!operation || (operation.settled && !operation.result?.ok)) {
      operation = this.trackCancellationOperation(this.performCancellationFinalization(jobId))
      this.cancellationFinalizations.set(jobId, operation)
    }
    return await waitForOwnedCancellation(operation.promise, this.cancellationWaitMs)
      ?? failure('write_failed')
  }

  private async performCancellationFinalization(jobId: string): Promise<WorldRenderResult<WorldRenderJobDetail>> {
    const request = this.cancellationOperations.get(jobId)
    if (request) {
      const requested = await request.promise
      if (!requested.ok) return requested
    }
    const result = await this.withWriteQueue(async (context) => {
      const jobRoot = jobRootFor(context, jobId)
      const state = await this.loadJobForMutation(context, jobId)
      if (state.status === 'cancelled') {
        const intent = await tryReadCancellationIntent(jobRoot, jobId)
        if (intent) await this.completeCancellationIntent(context, jobRoot, state, intent, 'cancelled')
        return success(publicDetail(state))
      }
      if (TERMINAL_STATUSES.has(state.status) && !this.cancellationRequests.has(jobId)) {
        return success(publicDetail(state))
      }
      if (state.status !== 'cancel_requested') throw new RenderRepositoryFault('job_busy', true)
      const intent = await tryReadCancellationIntent(jobRoot, jobId)
      const cancelled = intent
        ? await this.completeCancellationIntent(context, jobRoot, state, intent, 'cancelled')
        : await this.publishLegacyCancelledState(jobRoot, state)
      return success(publicDetail(cancelled))
    })
    if (result.ok && TERMINAL_STATUSES.has(result.value.status)) {
      this.cancellationRequests.delete(jobId)
      this.cancellationOperations.delete(jobId)
      this.cancellationFinalizations.delete(jobId)
      this.pruneSuccessfulWebmCleanupState(jobId)
    }
    return result
  }

  async settle(
    jobId: string,
    outcome: { executorError: WorldRenderPublicError | null },
    signal?: AbortSignal,
  ): Promise<WorldRenderResult<WorldRenderJobDetail>> {
    if (!isWorldRenderJobId(jobId)) return failure('invalid_request')
    let executorError: WorldRenderPublicError | null
    try { executorError = outcome?.executorError === null ? null : parsePublicError(outcome?.executorError) }
    catch { return failure('invalid_request') }
    const cancellationRequested = (): boolean => signal?.aborted === true || this.cancellationRequests.has(jobId)
    const result = await this.withWriteQueue(async (context) => {
      const jobRoot = jobRootFor(context, jobId)
      let state = await this.loadJobForMutation(context, jobId)
      if (TERMINAL_STATUSES.has(state.status)) {
        if (!cancellationRequested() || state.status === 'cancelled' || state.status === 'recovery_failed') {
          return success(publicDetail(state))
        }
        state = await this.publishCancellationState(context, jobRoot, state)
        return success(publicDetail(state))
      }
      if (cancellationRequested()) {
        state = await this.publishCancellationState(context, jobRoot, state)
        return success(publicDetail(state))
      }
      if (state.status === 'cancel_requested') {
        const cancelled: StoredJobV1 = { ...state, status: 'cancelled', error: null, updatedAt: canonicalTimestamp(this.now()) }
        await this.publishState(jobRoot, state, cancelled)
        return success(publicDetail(cancelled))
      }

      await this.loadExecutionPackage(context, jobRoot, state, true)
      state = sortStoredFrames(state)
      this.rememberState(context, state)
      if (cancellationRequested()) {
        state = await this.publishCancellationState(context, jobRoot, state)
        return success(publicDetail(state))
      }
      const mastersComplete = await this.verifyCompleteMasters(context, jobRoot, state)
      if (cancellationRequested()) {
        state = await this.publishCancellationState(context, jobRoot, state)
        return success(publicDetail(state))
      }
      if (mastersComplete) {
        let assemblyError = executorError
        let hasVerifiedWebm = false
        if (state.outputs.webm) {
          try {
            if (!await hasMatchingWebmReceipt(jobRoot, jobId, state.outputs.webm)) {
              throw new RenderRepositoryFault('output_invalid')
            }
            await verifyWebmArtifact(context, state.outputs.webm, webmVerificationPlanFromState(state))
            hasVerifiedWebm = true
          } catch (error) {
            if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
            await safeRemoveSingleFile(resolveWorkspaceArtifactPath(context, state.outputs.webm.workspacePath))
            await removeArtifactReceipt(jobRoot, 'webm', null)
            const withoutInvalidWebm: StoredJobV1 = {
              ...state,
              outputs: { ...state.outputs, webm: null },
              updatedAt: canonicalTimestamp(this.now()),
            }
            await this.publishState(jobRoot, state, withoutInvalidWebm)
            state = withoutInvalidWebm
            assemblyError ??= publicError('output_invalid')
          }
        }
        state = await this.publishRenderManifest(context, jobRoot, state)
        if (cancellationRequested()) {
          state = await this.publishCancellationState(context, jobRoot, state)
          return success(publicDetail(state))
        }
        const status: WorldRenderJobStatus = hasVerifiedWebm ? 'succeeded' : 'partial'
        const settled: StoredJobV1 = {
          ...state,
          status,
          progress: progressFor('complete', state.frameCount, state.frameCount),
          error: status === 'partial' ? assemblyError ?? publicError('output_invalid') : null,
          updatedAt: canonicalTimestamp(this.now()),
        }
        await this.publishState(jobRoot, state, settled)
        if (cancellationRequested()) {
          const cancelled = await this.publishCancellationState(context, jobRoot, settled)
          return success(publicDetail(cancelled))
        }
        this.cancellationRequests.delete(jobId)
        return success(publicDetail(settled))
      }

      if (cancellationRequested()) {
        state = await this.publishCancellationState(context, jobRoot, state)
        return success(publicDetail(state))
      }
      const failed: StoredJobV1 = {
        ...state,
        status: 'failed',
        error: executorError ?? publicError('output_invalid'),
        updatedAt: canonicalTimestamp(this.now()),
      }
      await this.publishState(jobRoot, state, failed)
      if (cancellationRequested()) {
        const cancelled = await this.publishCancellationState(context, jobRoot, failed)
        return success(publicDetail(cancelled))
      }
      this.cancellationRequests.delete(jobId)
      return success(publicDetail(failed))
    })
    if (result.ok && TERMINAL_STATUSES.has(result.value.status)) {
      this.pruneSuccessfulWebmCleanupState(jobId)
    }
    return result
  }

  /** Recovers journals, validates truth states, and interrupts work left active by a prior process. */
  async recoverJobs(): Promise<WorldRenderJobDetail[]> {
    const result = await this.withExistingWriteQueue(async (context) => {
      if (!context) return success([])
      const states = await this.loadAll(context, true)
      return success(states.map(publicDetail))
    })
    if (!result.ok) throw new RenderRepositoryFault(result.error.code, result.error.retryable)
    for (const state of result.value) {
      if (TERMINAL_STATUSES.has(state.status)) this.pruneSuccessfulWebmCleanupState(state.jobId)
    }
    return result.value
  }

  async delete(requestValue: unknown): Promise<WorldRenderDeleteResult> {
    const parsed = parseWorldRenderDeleteRequest(requestValue)
    if (!parsed.success) return failure('invalid_request')
    const result = await this.withWriteQueue(async (context) => {
      const jobRoot = jobRootFor(context, parsed.value.jobId)
      const state = await this.loadJob(context, parsed.value.jobId, false)
      if (!TERMINAL_STATUSES.has(state.status)) throw new RenderRepositoryFault('job_busy', true)
      await assertSafeTree(jobRoot)
      const trash = join(context.outputRoot, `.deleted-${parsed.value.jobId}-${randomBytes(8).toString('hex')}`)
      assertContained(context.outputRoot, trash)
      await rename(jobRoot, trash)
      this.forgetJob(context, parsed.value.jobId)
      await syncDirectoryWith(context.outputRoot, this.options.syncDirectory)
      await rm(trash, { recursive: true, force: true })
      await syncDirectoryWith(context.outputRoot, this.options.syncDirectory)
      return success({ jobId: parsed.value.jobId })
    })
    if (result.ok) {
      this.pruneSuccessfulWebmCleanupState(parsed.value.jobId)
      this.cancellationRequests.delete(parsed.value.jobId)
      this.cancellationOperations.delete(parsed.value.jobId)
      this.cancellationFinalizations.delete(parsed.value.jobId)
    }
    return result
  }

  private async publishCancellationState(
    context: RepositoryContext,
    jobRoot: string,
    state: StoredJobV1,
  ): Promise<StoredJobV1> {
    let intent = await tryReadCancellationIntent(jobRoot, state.jobId)
    if (!intent) {
      const updatedAt = state.status === 'cancel_requested'
        && !state.outputs.webm && !state.outputs.renderManifest
        ? state.updatedAt
        : canonicalTimestamp(this.now())
      const requested = cancellationStateFrom(state, 'cancel_requested', updatedAt)
      const cancelled = cancellationStateFrom(state, 'cancelled', updatedAt)
      const provisionalWebm = [...this.webmSinks.values()]
        .find((sink) => sink.jobId === state.jobId)?.canonicalArtifact ?? null
      const authority = {
        jobId: state.jobId,
        revision: state.request.expectedRevision,
        snapshotSha256: state.snapshot.sha256,
        sourceStateSha256: sha256(encodeStoredState(state)),
        requestedStateSha256: sha256(encodeStoredState(requested)),
        cancelledStateSha256: sha256(encodeStoredState(cancelled)),
        updatedAt,
        renderManifest: state.outputs.renderManifest ? { ...state.outputs.renderManifest } : null,
        webm: state.outputs.webm
          ? { ...state.outputs.webm }
          : provisionalWebm ? { ...provisionalWebm } : null,
      }
      intent = {
        schema: CANCELLATION_INTENT_SCHEMA,
        stage: 'prepared',
        authoritySha256: cancellationIntentAuthoritySha256(authority),
        ...authority,
      }
      // No receipt or derived file is touched until this exact intent has been
      // atomically written, file-synced, renamed, and directory-synced.
      await this.checkpoint('cancellation-intent-writing')
      await atomicWriteBytes(
        join(jobRoot, CANCELLATION_INTENT_FILE),
        encodeJson(intent),
        this.options.syncDirectory,
      )
      await this.checkpoint('cancellation-intent-published')
    }
    return this.completeCancellationIntent(context, jobRoot, state, intent, 'cancel_requested')
  }

  private async completeCancellationIntent(
    context: RepositoryContext,
    jobRoot: string,
    state: StoredJobV1,
    intent: CancellationIntentV1,
    targetStatus: 'cancel_requested' | 'cancelled',
  ): Promise<StoredJobV1> {
    let currentIntent = intent
    await validateCancellationIntent(context, jobRoot, state, currentIntent)

    if (cancellationIntentStageIndex(currentIntent.stage)
      <= cancellationIntentStageIndex('manifest-receipt-removal-authorized')) {
      if (currentIntent.stage === 'prepared') {
        currentIntent = await this.advanceCancellationIntent(
          jobRoot, currentIntent, 'manifest-receipt-removal-authorized',
        )
      }
      await validateCancellationIntent(context, jobRoot, state, currentIntent)
      if (currentIntent.renderManifest) await removeArtifactReceipt(jobRoot, 'render-manifest', null)
      await this.checkpoint('cancellation-render-manifest-receipt-removed')
    }
    if (cancellationIntentStageIndex(currentIntent.stage)
      <= cancellationIntentStageIndex('webm-receipt-removal-authorized')) {
      if (currentIntent.stage !== 'webm-receipt-removal-authorized') {
        currentIntent = await this.advanceCancellationIntent(
          jobRoot, currentIntent, 'webm-receipt-removal-authorized',
        )
      }
      await validateCancellationIntent(context, jobRoot, state, currentIntent)
      if (currentIntent.webm) await removeArtifactReceipt(jobRoot, 'webm', null)
      await this.checkpoint('cancellation-webm-receipt-removed')
      await syncDirectoryWith(join(jobRoot, ARTIFACT_RECEIPT_DIRECTORY), this.options.syncDirectory)
      await this.checkpoint('cancellation-receipts-synced')
    }
    if (cancellationIntentStageIndex(currentIntent.stage)
      <= cancellationIntentStageIndex('manifest-removal-authorized')) {
      if (currentIntent.stage !== 'manifest-removal-authorized') {
        currentIntent = await this.advanceCancellationIntent(
          jobRoot, currentIntent, 'manifest-removal-authorized',
        )
      }
      await validateCancellationIntent(context, jobRoot, state, currentIntent)
      if (currentIntent.renderManifest) {
        await safeRemoveSingleFile(join(jobRoot, WORLD_RENDER_MANIFEST_FILENAME), true)
      }
      await this.checkpoint('cancellation-render-manifest-removed')
    }
    if (cancellationIntentStageIndex(currentIntent.stage)
      <= cancellationIntentStageIndex('webm-removal-authorized')) {
      if (currentIntent.stage !== 'webm-removal-authorized') {
        currentIntent = await this.advanceCancellationIntent(
          jobRoot, currentIntent, 'webm-removal-authorized',
        )
      }
      await validateCancellationIntent(context, jobRoot, state, currentIntent)
      if (currentIntent.webm) await safeRemoveSingleFile(join(jobRoot, 'output.webm'), true)
      await this.checkpoint('cancellation-webm-removed')
      await syncDirectoryWith(jobRoot, this.options.syncDirectory)
      await this.checkpoint('cancellation-artifacts-synced')
    }

    const next = cancellationStateFrom(state, targetStatus, intent.updatedAt)
    const expectedHash = targetStatus === 'cancelled'
      ? intent.cancelledStateSha256
      : intent.requestedStateSha256
    if (sha256(encodeStoredState(next)) !== expectedHash) {
      throw new RenderRepositoryFault('recovery_failed', true)
    }
    const authorizedStage = targetStatus === 'cancelled'
      ? 'cancelled-state-publication-authorized'
      : 'requested-state-publication-authorized'
    const publishedStage = targetStatus === 'cancelled'
      ? 'cancelled-state-published'
      : 'requested-state-published'
    if (cancellationIntentStageIndex(currentIntent.stage) < cancellationIntentStageIndex(authorizedStage)) {
      currentIntent = await this.advanceCancellationIntent(jobRoot, currentIntent, authorizedStage)
      await validateCancellationIntent(context, jobRoot, state, currentIntent)
    }
    if (!encodeStoredState(next).equals(encodeStoredState(state))) {
      await this.publishState(jobRoot, state, next)
    }
    await this.checkpoint(targetStatus === 'cancelled'
      ? 'cancellation-cancelled-published'
      : 'cancellation-requested-published')
    if (cancellationIntentStageIndex(currentIntent.stage) < cancellationIntentStageIndex(publishedStage)) {
      currentIntent = await this.advanceCancellationIntent(jobRoot, currentIntent, publishedStage)
    }

    if (targetStatus === 'cancelled') {
      await safeRemoveSingleFile(join(jobRoot, CANCELLATION_INTENT_FILE), true)
      await syncDirectoryWith(join(jobRoot, '.modly'), this.options.syncDirectory)
      await this.checkpoint('cancellation-intent-cleared')
    }
    return next
  }

  private async advanceCancellationIntent(
    jobRoot: string,
    intent: CancellationIntentV1,
    stage: CancellationIntentStage,
  ): Promise<CancellationIntentV1> {
    if (cancellationIntentStageIndex(stage) <= cancellationIntentStageIndex(intent.stage)) return intent
    const next = { ...intent, stage }
    await atomicWriteBytes(
      join(jobRoot, CANCELLATION_INTENT_FILE),
      encodeJson(next),
      this.options.syncDirectory,
    )
    await this.checkpoint(`cancellation-intent-stage-${stage}-published`)
    return next
  }

  private async publishLegacyCancelledState(jobRoot: string, state: StoredJobV1): Promise<StoredJobV1> {
    const cancelled: StoredJobV1 = {
      ...state,
      status: 'cancelled',
      error: null,
      updatedAt: canonicalTimestamp(this.now()),
    }
    await this.publishState(jobRoot, state, cancelled)
    return cancelled
  }

  private async recordSingleton(
    jobId: string,
    kind: 'audio' | 'webm',
    relativePath: string,
    data: WorldRenderArtifactInput,
    maximumBytes: number,
  ): Promise<WorldRenderResult<WorldRenderArtifact>> {
    if (!isWorldRenderJobId(jobId)) return failure('invalid_request')
    return this.withWriteQueue(async (context) => {
      const jobRoot = jobRootFor(context, jobId)
      let state = await this.loadJobForMutation(context, jobId)
      assertWritableOutputState(state)
      if (state.outputs[kind]) throw new RenderRepositoryFault('output_invalid')
      if (kind === 'audio' && state.outputs.frames.length !== state.frameCount) {
        throw new RenderRepositoryFault('output_invalid')
      }
      if (kind === 'webm' && (state.outputs.frames.length !== state.frameCount || !state.outputs.audio)) {
        throw new RenderRepositoryFault('output_invalid')
      }
      const path = join(jobRoot, ...relativePath.split('/'))
      const artifact = await writeOwnedArtifact(context, path, data, maximumBytes, this.options.syncDirectory)
      await this.checkpoint('artifact-written')
      await this.publishArtifactReceipt(jobRoot, {
        schema: ARTIFACT_RECEIPT_SCHEMA,
        jobId,
        kind,
        index: null,
        artifact,
      })
      state = {
        ...state,
        status: kind === 'audio' ? 'rendering-audio' : state.status,
        outputs: { ...state.outputs, [kind]: artifact },
        progress: kind === 'audio'
          ? progressFor('rendering-audio', state.frameCount, state.frameCount, true)
          : state.progress,
        updatedAt: canonicalTimestamp(this.now()),
      }
      await this.publishState(jobRoot, await this.readPublishedState(jobRoot), state)
      return success({ ...artifact })
    })
  }

  private async mutate<T>(
    jobId: string,
    change: (state: StoredJobV1) => StoredJobV1,
    select: (state: StoredJobV1) => T = publicDetail as (state: StoredJobV1) => T,
  ): Promise<WorldRenderResult<T>> {
    if (!isWorldRenderJobId(jobId)) return failure('invalid_request')
    return this.withWriteQueue(async (context) => {
      const jobRoot = jobRootFor(context, jobId)
      const state = await this.loadJobForMutation(context, jobId)
      const next = change(state)
      if (!encodeStoredState(next).equals(encodeStoredState(state))) await this.publishState(jobRoot, state, next)
      return success(select(next))
    })
  }

  private async pinResources(
    context: RepositoryContext,
    jobRoot: string,
    jobId: string,
    resources: readonly WorldResource[],
  ): Promise<WorldRenderPinnedResource[]> {
    const pinned: WorldRenderPinnedResource[] = []
    let totalSize = 0
    for (const [index, resource] of resources.entries()) {
      const files: WorldRenderPinnedResourceFile[] = []
      for (const reference of resourceFileReferences(resource)) {
        const sourcePath = await resolveSafeWorkspaceFile(context, reference.workspacePath)
        const destinationPath = join(
          jobRoot,
          'snapshot',
          'resources',
          `resource-${String(index).padStart(4, '0')}-${reference.role}.bin`,
        )
        const remaining = this.maximumPinnedResourceTotalBytes - totalSize
        if (remaining <= 0) throw new RenderRepositoryFault('output_invalid')
        const copied = await copyPinnedFile(
          context,
          sourcePath,
          destinationPath,
          Math.min(this.maximumPinnedResourceBytes, remaining),
          this.options.syncDirectory,
        )
        totalSize += copied.size
        await chmod(destinationPath, 0o400)
        files.push({
          role: reference.role,
          originalWorkspacePath: reference.workspacePath,
          workspacePath: workspaceRelativePath(context, destinationPath),
          size: copied.size,
          sha256: copied.sha256,
        })
      }
      pinned.push({
        resource: structuredClone(resource),
        files,
      })
    }
    if (!isWorldRenderJobId(jobId)) throw new RenderRepositoryFault('write_failed', true)
    return pinned
  }

  private async loadAll(context: RepositoryContext, recovering: boolean): Promise<StoredJobV1[]> {
    const entries = await readdir(context.outputRoot, { withFileTypes: true })
    const states: StoredJobV1[] = []
    for (const entry of entries.sort((left, right) => codeUnitCompare(left.name, right.name))) {
      if (entry.name.startsWith('.')) continue
      if (!isWorldRenderJobId(entry.name)) continue
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new RenderRepositoryFault('unsafe_workspace')
      if (recovering) {
        const jobRoot = jobRootFor(context, entry.name)
        const hasPublication = await pathExists(join(jobRoot, JOB_FILE)) || await pathExists(join(jobRoot, LAST_VALID_FILE))
        if (!hasPublication) {
          await safeRemoveUnpublishedJob(context.outputRoot, jobRoot)
          continue
        }
      }
      states.push(await this.loadJob(context, entry.name, recovering))
    }
    return states.sort((left, right) => codeUnitCompare(left.createdAt, right.createdAt) || codeUnitCompare(left.jobId, right.jobId))
  }

  private async loadJobForMutation(context: RepositoryContext, jobId: string): Promise<StoredJobV1> {
    const jobRoot = jobRootFor(context, jobId)
    await ensureSafeDirectory(jobRoot, false).catch((error) => {
      if (nodeErrorCode(error) === 'ENOENT') throw new RenderRepositoryFault('job_not_found')
      throw error
    })
    const cached = this.jobCache.get(jobRoot)
    if (!cached) return this.loadJob(context, jobId, false)
    const publicationIntent = await tryReadManifestPublicationIntent(jobRoot, jobId)
    if (!publicationIntent) return cached
    const source: StoredJobV1 = {
      ...cached,
      outputs: { ...cached.outputs, renderManifest: null },
    }
    await this.rollbackManifestPublicationIntent(context, jobRoot, source, publicationIntent)
    return source
  }

  private async loadExecutionPackage(
    context: RepositoryContext,
    jobRoot: string,
    state: StoredJobV1,
    verifyFromDisk = false,
    signal?: AbortSignal,
  ): Promise<WorldRenderExecutionPackage> {
    throwIfRepositoryAborted(signal)
    const cached = this.executionCache.get(jobRoot)
    if (!verifyFromDisk && cached && cached.snapshotSha256 === state.snapshot.sha256) return cached
    const packageValue = await readAndVerifySnapshotPackage(context, jobRoot, state, signal)
    throwIfRepositoryAborted(signal)
    const snapshot = validateWorldProjectSnapshot({ project: packageValue.project, scenes: packageValue.scenes })
    if (!snapshot.success) throw new RenderRepositoryFault('recovery_failed', true)
    const scene = snapshot.value.scenes.find((candidate) => candidate.sceneId === state.request.sceneId)
    if (!scene) throw new RenderRepositoryFault('recovery_failed', true)
    const execution: WorldRenderExecutionPackage = {
      snapshot: cloneWorldProjectSnapshot(snapshot.value),
      scene: structuredClone(scene),
      sequence: structuredClone(packageValue.sequence),
      preset: { ...packageValue.preset },
      resources: packageValue.resources.map(clonePinnedResource),
      framePlan: packageValue.framePlan.map(cloneFrameTime),
      snapshotSha256: state.snapshot.sha256,
    }
    throwIfRepositoryAborted(signal)
    this.executionCache.set(jobRoot, execution)
    return execution
  }

  private rememberState(context: RepositoryContext, state: StoredJobV1): void {
    const key = repositoryCacheKey(context, state.jobId)
    this.jobCache.set(key, state)
    this.frameIndexCache.set(key, new Set(state.outputs.frames.map((frame) => frame.index)))
  }

  private forgetJob(context: RepositoryContext, jobId: string): void {
    const key = repositoryCacheKey(context, jobId)
    this.jobCache.delete(key)
    this.executionCache.delete(key)
    this.frameIndexCache.delete(key)
  }

  private async loadJob(context: RepositoryContext, jobId: string, recovering: boolean): Promise<StoredJobV1> {
    const jobRoot = jobRootFor(context, jobId)
    try {
      await ensureSafeDirectory(jobRoot, false)
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') throw new RenderRepositoryFault('job_not_found')
      throw error
    }
    const activeTemporaryPaths = new Set(
      [...this.webmSinks.values()]
        .filter((sink) => sink.jobId === jobId)
        .map((sink) => sink.temporaryPath),
    )
    await cleanupTemporaryFiles(jobRoot, activeTemporaryPaths)
    let state = await this.recoverPublishedState(jobRoot, jobId)
    try {
      const publicationIntent = await tryReadManifestPublicationIntent(jobRoot, jobId)
      if (publicationIntent) {
        const receipts = await readArtifactReceipts(jobRoot, jobId, state.frameCount)
        state = { ...state, outputs: { ...receipts, renderManifest: null } }
        await this.rollbackManifestPublicationIntent(context, jobRoot, state, publicationIntent)
      }
    } catch (error) {
      if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
      const recoveryFailed: StoredJobV1 = {
        ...state,
        status: 'recovery_failed',
        outputs: { frames: [], audio: null, renderManifest: null, webm: null },
        error: publicError('recovery_failed'),
        updatedAt: canonicalTimestamp(this.now()),
      }
      await this.publishState(jobRoot, state, recoveryFailed)
      return recoveryFailed
    }
    const cancellationIntent = await tryReadCancellationIntent(jobRoot, jobId)
    if (cancellationIntent) {
      // The durable intent is the crash authority. Complete every destructive
      // checkpoint idempotently, publish coherent cancelled truth, and only
      // then remove+fsync the tombstone.
      state = await this.completeCancellationIntent(
        context,
        jobRoot,
        state,
        cancellationIntent,
        recovering || state.status === 'cancelled' ? 'cancelled' : 'cancel_requested',
      )
      if (state.status === 'cancelled') this.cancellationRequests.delete(jobId)
    }
    try {
      const packageValue = await readAndVerifySnapshotPackage(context, jobRoot, state)
      if (state.status === 'recovery_failed') {
        if (state.error?.code !== 'recovery_failed') throw new RenderRepositoryFault('recovery_failed', true)
        this.rememberState(context, state)
        return state
      }
      state = { ...state, outputs: await readArtifactReceipts(jobRoot, jobId, state.frameCount) }
      await this.verifyTruthState(context, jobRoot, state, packageValue)
      await ensureSafeDirectory(join(jobRoot, 'frames'), false)
      await ensureSafeDirectory(join(jobRoot, 'audio'), false)
      const preserveProvisionalWebm = !recovering && [...this.webmSinks.values()].some(
        (sink) => sink.jobId === jobId && sink.committedArtifact && !sink.cancelled,
      )
      await cleanupUnrecordedArtifacts(jobRoot, state, preserveProvisionalWebm)
    } catch (error) {
      if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
      const recoveryFailed: StoredJobV1 = {
        ...state,
        status: 'recovery_failed',
        outputs: { frames: [], audio: null, renderManifest: null, webm: null },
        error: publicError('recovery_failed'),
        updatedAt: canonicalTimestamp(this.now()),
      }
      await this.publishState(jobRoot, state, recoveryFailed)
      return recoveryFailed
    }
    if (recovering && ACTIVE_STATUSES.has(state.status)) {
      const interrupted: StoredJobV1 = {
        ...state,
        status: 'interrupted',
        error: null,
        updatedAt: canonicalTimestamp(this.now()),
      }
      await this.publishState(jobRoot, state, interrupted)
      state = interrupted
    }
    this.rememberState(context, state)
    return state
  }

  private async verifyTruthState(
    context: RepositoryContext,
    jobRoot: string,
    state: StoredJobV1,
    packageValue: LoadedWorldRenderSnapshotPackageV1,
  ): Promise<void> {
    validateProgressTruth(state)
    for (const frame of state.outputs.frames) {
      const planned = packageValue.framePlan[frame.index]
      if (!planned || planned.index !== frame.index || planned.timestampMicroseconds !== frame.timestampMicroseconds
        || compareWorldRationalTime(planned.time, frame.time) !== 0) {
        throw new RenderRepositoryFault('recovery_failed', true)
      }
      if (frame.workspacePath !== workspaceRelativePath(context, join(jobRoot, 'frames', frameFilename(frame.index)))) {
        throw new RenderRepositoryFault('recovery_failed', true)
      }
      await verifyArtifact(context, frame)
    }
    if (state.outputs.audio) {
      if (state.outputs.audio.workspacePath !== workspaceRelativePath(context, join(jobRoot, 'audio', 'master.wav'))) {
        throw new RenderRepositoryFault('recovery_failed', true)
      }
      await verifyArtifact(context, state.outputs.audio)
    }
    if (state.outputs.webm) {
      if (state.outputs.webm.workspacePath !== workspaceRelativePath(context, join(jobRoot, 'output.webm'))) {
        throw new RenderRepositoryFault('recovery_failed', true)
      }
      await verifyArtifact(context, state.outputs.webm)
    }
    if (state.outputs.renderManifest) {
      if (state.outputs.renderManifest.workspacePath !== workspaceRelativePath(context, join(jobRoot, WORLD_RENDER_MANIFEST_FILENAME))) {
        throw new RenderRepositoryFault('recovery_failed', true)
      }
      await verifyArtifact(context, state.outputs.renderManifest)
    }
    if (state.status === 'partial' || state.status === 'succeeded') {
      if (!await this.verifyCompleteMasters(context, jobRoot, state) || !state.outputs.renderManifest) {
        throw new RenderRepositoryFault('recovery_failed', true)
      }
      await verifyRenderManifest(context, state)
    }
    if (state.status === 'succeeded') {
      if (!state.outputs.webm) throw new RenderRepositoryFault('recovery_failed', true)
      await verifyWebmArtifact(context, state.outputs.webm, webmVerificationPlanFromState(state))
    }
  }

  private async verifyCompleteMasters(context: RepositoryContext, _jobRoot: string, state: StoredJobV1): Promise<boolean> {
    if (state.outputs.frames.length !== state.frameCount || !state.outputs.audio) return false
    for (let index = 0; index < state.frameCount; index += 1) {
      const frame = state.outputs.frames[index]
      if (!frame || frame.index !== index || basename(frame.workspacePath) !== frameFilename(index)) return false
      try {
        await verifyArtifact(context, frame)
        await verifyPngArtifact(context, frame, state.request.preset.width, state.request.preset.height)
      } catch (error) {
        if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
        return false
      }
    }
    try {
      await verifyArtifact(context, state.outputs.audio)
      await verifyWavArtifact(context, state.outputs.audio, state.duration)
    } catch (error) {
      if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
      return false
    }
    return true
  }

  private async publishRenderManifest(
    context: RepositoryContext,
    jobRoot: string,
    state: StoredJobV1,
  ): Promise<StoredJobV1> {
    const manifestPath = join(jobRoot, WORLD_RENDER_MANIFEST_FILENAME)
    const receiptPath = artifactReceiptPath(jobRoot, 'render-manifest', null)
    if (state.outputs.renderManifest) {
      await verifyRenderManifest(context, state)
      return state
    }
    const bytes = renderManifestBytes(state)
    const artifact = artifactFor(context, manifestPath, bytes)
    const authority: ManifestPublicationIntentAuthority = {
      jobId: state.jobId,
      revision: state.request.expectedRevision,
      snapshotSha256: state.snapshot.sha256,
      sourceStateSha256: sha256(encodeStoredState(state)),
      artifact,
    }
    const intent: ManifestPublicationIntentV1 = {
      schema: MANIFEST_PUBLICATION_INTENT_SCHEMA,
      stage: 'prepared',
      authoritySha256: manifestPublicationIntentAuthoritySha256(authority),
      ...authority,
    }
    await rejectPathIfPresent(manifestPath)
    await rejectPathIfPresent(receiptPath)
    try {
      await atomicWriteBytes(
        join(jobRoot, MANIFEST_PUBLICATION_INTENT_FILE),
        encodeJson(intent),
        this.options.syncDirectory,
      )
      await this.checkpoint('manifest-publication-intent-published')
      const writtenArtifact = await writeOwnedArtifact(
        context,
        manifestPath,
        bytes,
        WORLD_RENDER_ARTIFACT_MAX_BYTES.renderManifest,
        this.options.syncDirectory,
      )
      if (!sameStoredArtifact(writtenArtifact, artifact)) throw new RenderRepositoryFault('write_failed', true)
      await this.checkpoint('manifest-artifact-published')
      await this.publishArtifactReceipt(jobRoot, {
        schema: ARTIFACT_RECEIPT_SCHEMA,
        jobId: state.jobId,
        kind: 'render-manifest',
        index: null,
        artifact,
      })
      const next: StoredJobV1 = {
        ...state,
        outputs: { ...state.outputs, renderManifest: artifact },
      }
      await this.publishState(jobRoot, state, next)
      await verifyRenderManifest(context, next)
      await safeRemoveSingleFile(join(jobRoot, MANIFEST_PUBLICATION_INTENT_FILE))
      await syncDirectoryWith(join(jobRoot, '.modly'), this.options.syncDirectory)
      await this.checkpoint('manifest-publication-intent-cleared')
      return next
    } catch (error) {
      const durableIntent = await tryReadManifestPublicationIntent(jobRoot, state.jobId)
      if (durableIntent) {
        await this.rollbackManifestPublicationIntent(context, jobRoot, state, durableIntent)
      }
      throw error
    }
  }

  private async rollbackManifestPublicationIntent(
    context: RepositoryContext,
    jobRoot: string,
    state: StoredJobV1,
    intent: ManifestPublicationIntentV1,
  ): Promise<void> {
    const source: StoredJobV1 = {
      ...state,
      outputs: { ...state.outputs, renderManifest: null },
    }
    let currentIntent = intent
    await validateManifestPublicationIntent(context, jobRoot, source, currentIntent)
    if (manifestPublicationIntentStageIndex(currentIntent.stage)
      < manifestPublicationIntentStageIndex('receipt-removal-authorized')) {
      currentIntent = await this.advanceManifestPublicationIntent(
        jobRoot,
        currentIntent,
        'receipt-removal-authorized',
      )
    }
    await validateManifestPublicationIntent(context, jobRoot, source, currentIntent)
    await removeArtifactReceipt(jobRoot, 'render-manifest', null)
    await syncDirectoryWith(join(jobRoot, ARTIFACT_RECEIPT_DIRECTORY), this.options.syncDirectory)
    await this.checkpoint('manifest-publication-rollback-receipt-removed')
    if (manifestPublicationIntentStageIndex(currentIntent.stage)
      < manifestPublicationIntentStageIndex('artifact-removal-authorized')) {
      currentIntent = await this.advanceManifestPublicationIntent(
        jobRoot,
        currentIntent,
        'artifact-removal-authorized',
      )
    }
    await validateManifestPublicationIntent(context, jobRoot, source, currentIntent)
    await safeRemoveSingleFile(join(jobRoot, WORLD_RENDER_MANIFEST_FILENAME), true)
    await syncDirectoryWith(jobRoot, this.options.syncDirectory)
    await this.checkpoint('manifest-publication-rollback-artifact-removed')
    await safeRemoveSingleFile(join(jobRoot, MANIFEST_PUBLICATION_INTENT_FILE))
    await syncDirectoryWith(join(jobRoot, '.modly'), this.options.syncDirectory)
    await this.checkpoint('manifest-publication-rollback-intent-cleared')
    this.rememberState(context, source)
  }

  private async advanceManifestPublicationIntent(
    jobRoot: string,
    intent: ManifestPublicationIntentV1,
    stage: ManifestPublicationIntentStage,
  ): Promise<ManifestPublicationIntentV1> {
    if (manifestPublicationIntentStageIndex(stage) <= manifestPublicationIntentStageIndex(intent.stage)) {
      return intent
    }
    const next = { ...intent, stage }
    await atomicWriteBytes(
      join(jobRoot, MANIFEST_PUBLICATION_INTENT_FILE),
      encodeJson(next),
      this.options.syncDirectory,
    )
    await this.checkpoint(`manifest-publication-intent-stage-${stage}-published`)
    return next
  }

  private async recoverPublishedState(jobRoot: string, jobId: string): Promise<StoredJobV1> {
    const statePath = join(jobRoot, JOB_FILE)
    const lastPath = join(jobRoot, LAST_VALID_FILE)
    const journalPath = join(jobRoot, JOURNAL_FILE)
    const current = await tryReadState(statePath, jobId)
    const last = await tryReadState(lastPath, jobId)
    const journal = await tryReadJournal(journalPath, jobId)

    let chosen: StoredJobV1 | null = null
    if (journal) {
      if (current && (current.sha256 === journal.nextSha256 || current.sha256 === journal.previousSha256)) chosen = current.state
      else if (last && (last.sha256 === journal.nextSha256 || last.sha256 === journal.previousSha256)) chosen = last.state
    } else if (current) chosen = current.state
    else if (last) chosen = last.state
    if (!chosen) throw new RenderRepositoryFault('recovery_failed', true)

    const bytes = encodeStoredState(chosen)
    if (!current || current.sha256 !== sha256(bytes)) await atomicWriteBytes(statePath, bytes, this.options.syncDirectory)
    if (!last || last.sha256 !== sha256(bytes)) await atomicWriteBytes(lastPath, bytes, this.options.syncDirectory)
    await rm(journalPath, { force: true })
    await syncDirectoryWith(dirname(journalPath), this.options.syncDirectory)
    return chosen
  }

  private async readPublishedState(jobRoot: string): Promise<StoredJobV1> {
    return (await tryReadState(join(jobRoot, JOB_FILE), basename(jobRoot)))?.state
      ?? (() => { throw new RenderRepositoryFault('recovery_failed', true) })()
  }

  private async publishArtifactReceipt(jobRoot: string, receipt: ArtifactReceiptV1): Promise<void> {
    const path = artifactReceiptPath(jobRoot, receipt.kind, receipt.index)
    await atomicWriteBytes(path, encodeJson(receipt), this.options.syncDirectory)
    try {
      await this.checkpoint('artifact-receipt-published')
    } catch (error) {
      // atomicWriteBytes has already fsynced the receipt's parent directory.
      // Preserve that distinction from a write/rename/fsync failure: only this
      // post-durability checkpoint error may be confirmed by an exact receipt.
      throw new DurableArtifactReceiptCheckpointError(error)
    }
  }

  private async publishState(jobRoot: string, previous: StoredJobV1 | null, next: StoredJobV1): Promise<void> {
    const nextBytes = encodeStoredState(next)
    const previousBytes = encodeStoredState(previous ?? next)
    const lastPath = join(jobRoot, LAST_VALID_FILE)
    const journalPath = join(jobRoot, JOURNAL_FILE)
    const statePath = join(jobRoot, JOB_FILE)
    await atomicWriteBytes(lastPath, nextBytes, this.options.syncDirectory)
    await this.checkpoint('last-valid-published')
    const journal: JournalV1 = {
      schema: JOURNAL_SCHEMA,
      jobId: next.jobId,
      previousSha256: sha256(previousBytes),
      nextSha256: sha256(nextBytes),
    }
    await atomicWriteBytes(journalPath, encodeJson(journal), this.options.syncDirectory)
    await this.checkpoint('journal-published')
    await atomicWriteBytes(statePath, nextBytes, this.options.syncDirectory)
    await this.checkpoint('state-published')
    await rm(journalPath, { force: true })
    await syncDirectoryWith(dirname(journalPath), this.options.syncDirectory)
    await this.checkpoint('journal-cleaned')
    this.jobCache.set(jobRoot, next)
    this.frameIndexCache.set(jobRoot, new Set(next.outputs.frames.map((frame) => frame.index)))
  }

  private async checkpoint(stage: string): Promise<void> {
    await this.options.failureCheckpoint?.(stage)
  }

  private async resolveContext(create: boolean, configuredValue?: unknown): Promise<RepositoryContext | null> {
    const configured = configuredValue ?? await this.options.getWorkspaceRoot()
    if (!isCanonicalAbsoluteRoot(configured)) throw new RenderRepositoryFault('unsafe_workspace')
    let workspaceRoot: string
    try {
      workspaceRoot = await realpath(configured)
    } catch (error) {
      if (!create && nodeErrorCode(error) === 'ENOENT') {
        await assertGenuinelyAbsentDirectoryPath(configured)
        return null
      }
      throw new RenderRepositoryFault('unsafe_workspace')
    }
    if (resolve(configured) !== resolve(workspaceRoot)) throw new RenderRepositoryFault('unsafe_workspace')
    const workspaceInfo = await lstat(workspaceRoot)
    if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) throw new RenderRepositoryFault('unsafe_workspace')
    const outputRoot = join(workspaceRoot, 'Exports', 'Worlds', 'Renders')
    assertContained(workspaceRoot, outputRoot)
    if (create) await ensureSafeDirectoryPath(workspaceRoot, outputRoot)
    else {
      try { await ensureSafeDirectory(outputRoot, false) } catch (error) {
        if (nodeErrorCode(error) === 'ENOENT') {
          await assertGenuinelyAbsentDirectoryPath(outputRoot, workspaceRoot)
          return null
        }
        throw error
      }
    }
    return { workspaceRoot, outputRoot }
  }

  private async withWriteQueue<T>(
    operation: (context: RepositoryContext) => Promise<WorldRenderResult<T>>,
  ): Promise<WorldRenderResult<T>> {
    let configured: unknown
    try { configured = await this.options.getWorkspaceRoot() } catch (error) { return failureFrom(error) }
    const queueKey = typeof configured === 'string' ? resolve(configured) : '<invalid>'
    return enqueueRepository(queueKey, async () => {
      try {
        const context = await this.resolveContext(true, configured)
        if (!context) throw new RenderRepositoryFault('unsafe_workspace')
        return await operation(context)
      } catch (error) {
        return failureFrom(error)
      }
    })
  }

  private async withExistingWriteQueue<T>(
    operation: (context: RepositoryContext | null) => Promise<WorldRenderResult<T>>,
  ): Promise<WorldRenderResult<T>> {
    let configured: unknown
    try { configured = await this.options.getWorkspaceRoot() } catch (error) { return failureFrom(error) }
    const queueKey = typeof configured === 'string' ? resolve(configured) : '<invalid>'
    return enqueueRepository(queueKey, async () => {
      try {
        return await operation(await this.resolveContext(false, configured))
      } catch (error) {
        return failureFrom(error)
      }
    })
  }

  private async withReadQueue<T>(
    operation: (context: RepositoryContext | null) => Promise<WorldRenderResult<T>>,
    signal?: AbortSignal,
  ): Promise<WorldRenderResult<T>> {
    let configured: unknown
    try {
      configured = await abortableRepositoryPromise(Promise.resolve(this.options.getWorkspaceRoot()), signal)
    } catch (error) {
      if (isRepositoryAbortError(error)) throw error
      return failure('unsafe_workspace')
    }
    const queueKey = typeof configured === 'string' ? resolve(configured) : '<invalid>'
    return enqueueRepository(queueKey, async () => {
      try {
        throwIfRepositoryAborted(signal)
        const result = await operation(await this.resolveContext(false, configured))
        throwIfRepositoryAborted(signal)
        return result
      } catch (error) {
        if (isRepositoryAbortError(error)) throw error
        return failureFrom(error)
      }
    }, signal)
  }
}

function publicDetail(state: StoredJobV1): WorldRenderJobDetail {
  const summary = publicSummary(state)
  return {
    ...summary,
    outputs: {
      frames: [...state.outputs.frames]
        .sort((left, right) => left.index - right.index)
        .map((frame) => ({ ...frame, time: { ...frame.time } })),
      audio: state.outputs.audio ? { ...state.outputs.audio } : null,
      renderManifest: state.outputs.renderManifest ? { ...state.outputs.renderManifest } : null,
      webm: state.outputs.webm ? { ...state.outputs.webm } : null,
    },
    error: state.error ? { ...state.error, ...(state.error.issues ? { issues: state.error.issues.map((issue) => ({ ...issue })) } : {}) } : null,
  }
}

function publicSummary(state: StoredJobV1): WorldRenderJobSummary {
  return {
    jobId: state.jobId,
    projectKey: state.request.projectKey,
    projectId: state.projectId,
    revision: state.request.expectedRevision,
    sceneId: state.request.sceneId,
    sequenceId: state.request.sequenceId,
    preset: { ...state.request.preset },
    duration: { ...state.duration },
    frameCount: state.frameCount,
    status: state.status,
    progress: { ...state.progress },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  }
}

function parseStoredJob(value: unknown, expectedJobId: string): StoredJobV1 {
  const record = requireExactRecord(value, [
    'schema', 'jobId', 'request', 'projectId', 'duration', 'frameCount', 'snapshot', 'status', 'progress',
    'outputs', 'error', 'createdAt', 'updatedAt',
  ])
  if (record.schema !== WORLD_RENDER_JOB_SCHEMA || record.jobId !== expectedJobId || !isWorldRenderJobId(record.jobId)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const request = parseWorldRenderCreateRequest(record.request)
  if (!request.success || !isCanonicalText(record.projectId) || !isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const duration = parseRational(record.duration)
  const frameCount = requireInteger(record.frameCount, 0, WORLD_RENDER_MAX_FRAME_COUNT)
  const snapshot = parseArtifact(record.snapshot)
  if (!STATUS_VALUES.has(record.status as WorldRenderJobStatus)) throw new RenderRepositoryFault('recovery_failed', true)
  const progress = parseProgress(record.progress, frameCount)
  const outputsRecord = requireExactRecord(record.outputs, ['frames', 'audio', 'renderManifest', 'webm'])
  if (!Array.isArray(outputsRecord.frames) || outputsRecord.frames.length > frameCount) throw new RenderRepositoryFault('recovery_failed', true)
  const frames = outputsRecord.frames.map(parseFrameArtifact)
  const indexes = new Set(frames.map((frame) => frame.index))
  if (indexes.size !== frames.length) throw new RenderRepositoryFault('recovery_failed', true)
  const outputs = {
    frames: frames.sort((left, right) => left.index - right.index),
    audio: outputsRecord.audio === null ? null : parseArtifact(outputsRecord.audio),
    renderManifest: outputsRecord.renderManifest === null ? null : parseArtifact(outputsRecord.renderManifest),
    webm: outputsRecord.webm === null ? null : parseArtifact(outputsRecord.webm),
  }
  if (outputs.frames.length || outputs.audio || outputs.renderManifest || outputs.webm) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const error = record.error === null ? null : parsePublicError(record.error)
  return {
    schema: WORLD_RENDER_JOB_SCHEMA,
    jobId: record.jobId,
    request: request.value,
    projectId: record.projectId,
    duration,
    frameCount,
    snapshot,
    status: record.status as WorldRenderJobStatus,
    progress,
    outputs,
    error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function parseSnapshotPackage(value: unknown, state: StoredJobV1): LoadedWorldRenderSnapshotPackageV1 {
  const record = requireExactRecord(value, [
    'schema', 'jobId', 'projectKey', 'projectId', 'revision', 'sceneId', 'sequenceId', 'preset',
    'project', 'scenes', 'sequence', 'resources', 'framePlan',
  ])
  const request = parseWorldRenderCreateRequest({
    projectKey: record.projectKey,
    expectedRevision: record.revision,
    sceneId: record.sceneId,
    sequenceId: record.sequenceId,
    preset: record.preset,
  })
  if (!request.success || record.schema !== WORLD_RENDER_SNAPSHOT_SCHEMA || record.jobId !== state.jobId
    || record.projectId !== state.projectId || stableSerialize(request.value) !== stableSerialize(state.request)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const validation = validateWorldProjectSnapshot({ project: record.project, scenes: record.scenes })
  if (!validation.success || validation.value.project.projectId !== state.projectId
    || validation.value.project.revision !== state.request.expectedRevision
    || !validation.value.scenes.some((candidate) => candidate.sceneId === state.request.sceneId)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const selectedScene = validation.value.scenes.find((candidate) => candidate.sceneId === state.request.sceneId)!
  const sequence = selectedScene.sequences.find((candidate) => candidate.id === state.request.sequenceId)
  if (!sequence || stableSerialize(sequence) !== stableSerialize(record.sequence)) throw new RenderRepositoryFault('recovery_failed', true)
  if (!Array.isArray(record.resources) || record.resources.length !== validation.value.project.resources.length) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const resources = record.resources.map(parsePinnedResource)
  for (const [index, resource] of resources.entries()) {
    if (stableSerialize(resource.resource) !== stableSerialize(validation.value.project.resources[index])) {
      throw new RenderRepositoryFault('recovery_failed', true)
    }
    const expectedFiles = resourceFileReferences(validation.value.project.resources[index])
    if (stableSerialize(resource.files.map(({ role, originalWorkspacePath }) => ({ role, workspacePath: originalWorkspacePath })))
      !== stableSerialize(expectedFiles)) throw new RenderRepositoryFault('recovery_failed', true)
  }
  const expected = enumerateWorldFrames(sequence.duration, request.value.preset.fps, WORLD_RENDER_MAX_FRAME_COUNT)
  const framePlanDescriptor = parseFramePlanDescriptor(record.framePlan)
  if (framePlanDescriptor.fps !== request.value.preset.fps
    || framePlanDescriptor.frameCount !== state.frameCount
    || framePlanDescriptor.sha256 !== framePlanSha256(expected)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  return {
    schema: WORLD_RENDER_SNAPSHOT_SCHEMA,
    jobId: state.jobId,
    projectKey: request.value.projectKey,
    projectId: state.projectId,
    revision: request.value.expectedRevision,
    sceneId: request.value.sceneId,
    sequenceId: request.value.sequenceId,
    preset: { ...request.value.preset },
    project: structuredClone(validation.value.project),
    scenes: structuredClone(validation.value.scenes),
    sequence: structuredClone(sequence),
    resources,
    framePlan: expected,
  }
}

async function readAndVerifySnapshotPackage(
  context: RepositoryContext,
  jobRoot: string,
  state: StoredJobV1,
  signal?: AbortSignal,
): Promise<LoadedWorldRenderSnapshotPackageV1> {
  throwIfRepositoryAborted(signal)
  await verifyArtifact(context, state.snapshot, signal)
  const snapshotPath = resolveWorkspaceArtifactPath(context, state.snapshot.workspacePath)
  if (snapshotPath !== join(jobRoot, SNAPSHOT_FILE)) throw new RenderRepositoryFault('recovery_failed', true)
  const value = parseJsonBuffer(await readBounded(snapshotPath, MAX_JSON_BYTES, signal))
  throwIfRepositoryAborted(signal)
  const parsed = parseSnapshotPackage(value, state)
  for (const [index, resource] of parsed.resources.entries()) {
    for (const file of resource.files) {
      throwIfRepositoryAborted(signal)
      await verifyArtifact(context, file, signal)
      const path = resolveWorkspaceArtifactPath(context, file.workspacePath)
      assertContained(join(jobRoot, 'snapshot', 'resources'), path)
      if (basename(path) !== `resource-${String(index).padStart(4, '0')}-${file.role}.bin`) {
        throw new RenderRepositoryFault('recovery_failed', true)
      }
    }
  }
  throwIfRepositoryAborted(signal)
  return parsed
}

function renderManifestBytes(state: StoredJobV1): Buffer {
  if (!state.outputs.audio || state.outputs.frames.length !== state.frameCount) {
    throw new RenderRepositoryFault('output_invalid')
  }
  return encodeJson({
    schema: WORLD_RENDER_MANIFEST_SCHEMA,
    jobId: state.jobId,
    snapshotSha256: state.snapshot.sha256,
    projectId: state.projectId,
    revision: state.request.expectedRevision,
    sceneId: state.request.sceneId,
    sequenceId: state.request.sequenceId,
    preset: { ...state.request.preset },
    duration: { ...state.duration },
    frameCount: state.frameCount,
    frames: state.outputs.frames.map((frame) => ({ ...frame, time: { ...frame.time } })),
    audio: { ...state.outputs.audio },
    webm: state.outputs.webm ? { ...state.outputs.webm } : null,
  })
}

async function verifyRenderManifest(context: RepositoryContext, state: StoredJobV1): Promise<void> {
  if (!state.outputs.renderManifest) throw new RenderRepositoryFault('recovery_failed', true)
  await verifyArtifact(context, state.outputs.renderManifest)
  const value = parseJsonBuffer(await readBounded(
    resolveWorkspaceArtifactPath(context, state.outputs.renderManifest.workspacePath),
      WORLD_RENDER_ARTIFACT_MAX_BYTES.renderManifest,
  ))
  const record = requireExactRecord(value, [
    'schema', 'jobId', 'snapshotSha256', 'projectId', 'revision', 'sceneId', 'sequenceId', 'preset',
    'duration', 'frameCount', 'frames', 'audio', 'webm',
  ])
  if (record.schema !== WORLD_RENDER_MANIFEST_SCHEMA || record.jobId !== state.jobId
    || record.snapshotSha256 !== state.snapshot.sha256 || record.projectId !== state.projectId
    || record.revision !== state.request.expectedRevision || record.sceneId !== state.request.sceneId
    || record.sequenceId !== state.request.sequenceId || record.frameCount !== state.frameCount
    || stableSerialize(record.preset) !== stableSerialize(state.request.preset)
    || stableSerialize(record.duration) !== stableSerialize(state.duration)
    || stableSerialize(record.frames) !== stableSerialize(state.outputs.frames)
    || stableSerialize(record.audio) !== stableSerialize(state.outputs.audio)
    || stableSerialize(record.webm) !== stableSerialize(state.outputs.webm)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
}

async function verifyArtifact(
  context: RepositoryContext,
  artifact: WorldRenderArtifact,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfRepositoryAborted(signal)
  const path = resolveWorkspaceArtifactPath(context, artifact.workspacePath)
  const info = await lstat(path)
  throwIfRepositoryAborted(signal)
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new RenderRepositoryFault('unsafe_workspace')
  }
  if (info.size !== artifact.size) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if (resolve(await realpath(path)) !== resolve(path)) throw new RenderRepositoryFault('unsafe_workspace')
  throwIfRepositoryAborted(signal)
  if (await sha256File(path, signal) !== artifact.sha256) throw new RenderRepositoryFault('recovery_failed', true)
  throwIfRepositoryAborted(signal)
  return true
}

async function verifyPngArtifact(
  context: RepositoryContext,
  artifact: WorldRenderArtifact,
  expectedWidth: number,
  expectedHeight: number,
): Promise<void> {
  if (artifact.size < 57 || artifact.size > WORLD_RENDER_ARTIFACT_MAX_BYTES.frame) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const path = resolveWorkspaceArtifactPath(context, artifact.workspacePath)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const inflater = createInflate()
  let decodedBytes = 0
  let expectedDecodedBytes = 0
  let rowBytes = 0
  let bitDepth = 0
  let colorType = -1
  let validationError: RenderRepositoryFault | null = null
  const inflated = new Promise<void>((resolvePromise, rejectPromise) => {
    inflater.on('data', (chunk: Buffer) => {
      if (validationError) return
      const start = decodedBytes
      decodedBytes += chunk.byteLength
      if (decodedBytes > expectedDecodedBytes) {
        validationError = new RenderRepositoryFault('output_invalid')
        inflater.destroy(validationError)
        return
      }
      if (rowBytes > 0) {
        let rowOffset = start % rowBytes === 0 ? 0 : rowBytes - (start % rowBytes)
        while (rowOffset < chunk.byteLength) {
          if (chunk[rowOffset] > 4) {
            validationError = new RenderRepositoryFault('output_invalid')
            inflater.destroy(validationError)
            return
          }
          rowOffset += rowBytes
        }
      }
    })
    inflater.once('end', resolvePromise)
    inflater.once('close', resolvePromise)
    inflater.once('error', rejectPromise)
  })
  try {
    const signature = await readExactly(handle, 0, 8)
    if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new RenderRepositoryFault('output_invalid')
    }
    let offset = 8
    let sawHeader = false
    let sawPalette = false
    let sawImageData = false
    let imageDataClosed = false
    let sawEnd = false
    while (offset < artifact.size) {
      const chunkHeader = await readExactly(handle, offset, 8)
      const dataLength = chunkHeader.readUInt32BE(0)
      const typeBytes = chunkHeader.subarray(4, 8)
      const type = typeBytes.toString('ascii')
      const chunkEnd = offset + 12 + dataLength
      if (!/^[A-Za-z]{4}$/.test(type) || chunkEnd > artifact.size || !Number.isSafeInteger(chunkEnd)) {
        throw new RenderRepositoryFault('output_invalid')
      }
      if (!sawHeader && type !== 'IHDR') throw new RenderRepositoryFault('output_invalid')
      if (sawImageData && type !== 'IDAT') imageDataClosed = true
      if (type === 'IDAT' && imageDataClosed) throw new RenderRepositoryFault('output_invalid')
      if (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) {
        throw new RenderRepositoryFault('output_invalid')
      }

      let crc = updateCrc32(0xffff_ffff, typeBytes)
      const headerData: Buffer | null = type === 'IHDR' ? Buffer.alloc(dataLength) : null
      let dataOffset = 0
      while (dataOffset < dataLength) {
        const length = Math.min(1024 * 1024, dataLength - dataOffset)
        const data = await readExactly(handle, offset + 8 + dataOffset, length)
        crc = updateCrc32(crc, data)
        if (headerData) data.copy(headerData, dataOffset)
        if (type === 'IDAT') {
          if (!inflater.write(data)) await once(inflater, 'drain')
        }
        dataOffset += length
      }
      const recordedCrc = (await readExactly(handle, offset + 8 + dataLength, 4)).readUInt32BE(0)
      if (((crc ^ 0xffff_ffff) >>> 0) !== recordedCrc) throw new RenderRepositoryFault('output_invalid')

      if (type === 'IHDR') {
        if (sawHeader || dataLength !== 13 || !headerData) throw new RenderRepositoryFault('output_invalid')
        const width = headerData.readUInt32BE(0)
        const height = headerData.readUInt32BE(4)
        bitDepth = headerData[8]
        colorType = headerData[9]
        const channels = pngChannelCount(colorType, bitDepth)
        if (width !== expectedWidth || height !== expectedHeight || channels === 0
          || headerData[10] !== 0 || headerData[11] !== 0 || headerData[12] !== 0) {
          throw new RenderRepositoryFault('output_invalid')
        }
        rowBytes = 1 + Math.ceil((width * channels * bitDepth) / 8)
        expectedDecodedBytes = rowBytes * height
        if (!Number.isSafeInteger(expectedDecodedBytes) || expectedDecodedBytes <= 0) {
          throw new RenderRepositoryFault('output_invalid')
        }
        sawHeader = true
      } else if (type === 'PLTE') {
        if (!sawHeader || sawPalette || sawImageData || dataLength < 3 || dataLength > 768
          || dataLength % 3 !== 0 || colorType === 0 || colorType === 4
          || (colorType === 3 && dataLength / 3 > 2 ** bitDepth)) {
          throw new RenderRepositoryFault('output_invalid')
        }
        sawPalette = true
      } else if (type === 'IDAT') {
        if (!sawHeader || dataLength === 0 || (colorType === 3 && !sawPalette)) {
          throw new RenderRepositoryFault('output_invalid')
        }
        sawImageData = true
      } else if (type === 'IEND') {
        if (!sawImageData || dataLength !== 0 || chunkEnd !== artifact.size) {
          throw new RenderRepositoryFault('output_invalid')
        }
        sawEnd = true
      }
      offset = chunkEnd
      if (sawEnd) break
    }
    if (!sawHeader || !sawImageData || !sawEnd) throw new RenderRepositoryFault('output_invalid')
    inflater.end()
    await inflated
    if (validationError || decodedBytes !== expectedDecodedBytes) throw new RenderRepositoryFault('output_invalid')
  } catch (error) {
    inflater.destroy()
    await inflated.catch(() => undefined)
    if (error instanceof RenderRepositoryFault) throw error
    throw new RenderRepositoryFault('output_invalid')
  } finally {
    await handle.close()
  }
}

function pngChannelCount(colorType: number, bitDepth: number): number {
  if (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) return 1
  if (colorType === 2 && [8, 16].includes(bitDepth)) return 3
  if (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) return 1
  if (colorType === 4 && [8, 16].includes(bitDepth)) return 2
  if (colorType === 6 && [8, 16].includes(bitDepth)) return 4
  return 0
}

function updateCrc32(current: number, bytes: Uint8Array): number {
  let value = current
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return value >>> 0
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1))
    table[index] = value >>> 0
  }
  return table
}

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset)
    if (bytesRead <= 0) throw new RenderRepositoryFault('output_invalid')
    offset += bytesRead
  }
  return bytes
}

async function verifyWavArtifact(
  context: RepositoryContext,
  artifact: WorldRenderArtifact,
  duration: WorldSequence['duration'],
): Promise<void> {
  if (artifact.size < 44 || artifact.size > 0xffff_ffff + 8) throw new RenderRepositoryFault('output_invalid')
  const path = resolveWorkspaceArtifactPath(context, artifact.workspacePath)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const header = Buffer.alloc(44)
    if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) throw new RenderRepositoryFault('output_invalid')
    const dataSize = header.readUInt32LE(40)
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.readUInt32LE(4) !== artifact.size - 8
      || header.toString('ascii', 8, 16) !== 'WAVEfmt ' || header.readUInt32LE(16) !== 16
      || header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 2
      || header.readUInt32LE(24) !== 48_000 || header.readUInt32LE(28) !== 192_000
      || header.readUInt16LE(32) !== 4 || header.readUInt16LE(34) !== 16
      || header.toString('ascii', 36, 40) !== 'data' || dataSize !== artifact.size - 44
      || dataSize % 4 !== 0) throw new RenderRepositoryFault('output_invalid')
    const sampleFrames = BigInt(dataSize / 4)
    const normalized = normalizeWorldRationalTime(duration)
    const expectedSampleFrames = BigInt(normalized.numerator) * 48_000n
      / BigInt(normalized.denominator)
    if (absoluteBigInt(sampleFrames - expectedSampleFrames) > 1n) {
      throw new RenderRepositoryFault('output_invalid')
    }
  } finally {
    await handle.close()
  }
}

interface EbmlElementHeader {
  id: number
  dataOffset: number
  dataEnd: number
  unknownSize: boolean
}

interface WebmTrackContract {
  number: number
  type: 'video' | 'audio'
  defaultDurationNanoseconds: bigint | null
  codecDelayNanoseconds: bigint
  seekPreRollNanoseconds: bigint
  opusPreSkipSamples: number | null
}

export type WorldWebmVerificationPlan = Pick<
  WorldWebmStartPayload,
  'width' | 'height' | 'fps' | 'frameCount' | 'duration' | 'frameDurations' | 'audioSampleCount'
>

type WebmVerificationPlan = WorldWebmVerificationPlan

export interface WorldWebmVerificationEvidence {
  readonly videoCodec: 'V_VP9'
  readonly audioCodec: 'A_OPUS'
  readonly timestampScaleNanoseconds: bigint
  readonly declaredDurationNanoseconds: bigint | null
  readonly videoFrameCount: number
  readonly videoPresentationTimestampsTicks: readonly bigint[]
  readonly videoEndNanoseconds: bigint
  readonly audioPacketCount: number
  readonly audioPresentedStartNanoseconds: bigint
  readonly audioPresentedEndNanoseconds: bigint
}

interface WebmInfoContract {
  timestampScaleNanoseconds: bigint
  declaredDurationNanoseconds: bigint | null
}

interface WebmVideoBlockTiming {
  timestampTicks: bigint
  blockDurationTicks: bigint | null
}

interface WebmTimelineState {
  videoBlocks: WebmVideoBlockTiming[]
  audioPackets: number
  audioBlocks: number
  lastAudioRawTimestampNanoseconds: bigint | null
  lastAudioRawEndNanoseconds: bigint | null
  audioFirstRawTimestampNanoseconds: bigint | null
  audioCumulativeCodedDurationNanoseconds: bigint
  audioInitialDiscardPaddingNanoseconds: bigint | null
  audioFinalDiscardPaddingNanoseconds: bigint | null
  audioFinalDiscardRawEndNanoseconds: bigint | null
  lastClusterTimestampTicks: bigint | null
}

const WEBM_DEFAULT_TIMESTAMP_SCALE_NANOSECONDS = 1_000_000n
const WEBM_MAX_TIMESTAMP_SCALE_NANOSECONDS = 1_000_000
const WEBM_MAX_OPUS_FRAME_BYTES = 1_275
const WEBM_MAX_OPUS_PACKET_FRAMES = 48
const WEBM_MAX_OPUS_PADDING_BYTES = WEBM_MAX_OPUS_FRAME_BYTES
const WEBM_MAX_OPUS_PADDING_LENGTH_BYTES = Math.ceil(WEBM_MAX_OPUS_PADDING_BYTES / 254)
const WEBM_MAX_OPUS_PACKET_BYTES = 2
  + 2 * (WEBM_MAX_OPUS_PACKET_FRAMES - 1)
  + WEBM_MAX_OPUS_PACKET_FRAMES * WEBM_MAX_OPUS_FRAME_BYTES
  + WEBM_MAX_OPUS_PADDING_LENGTH_BYTES
  + WEBM_MAX_OPUS_PADDING_BYTES
const WEBM_MAX_LACED_OPUS_PACKETS = 48

async function verifyWebmArtifact(
  context: RepositoryContext,
  artifact: WorldRenderArtifact,
  plan: WebmVerificationPlan,
): Promise<void> {
  await verifyArtifact(context, artifact)
  if (artifact.size < 64 || artifact.size > WORLD_RENDER_ARTIFACT_MAX_BYTES.webm) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const path = resolveWorkspaceArtifactPath(context, artifact.workspacePath)
  await verifyWebmPath(path, artifact.size, plan)
}

async function verifyWebmPath(
  path: string,
  size: number,
  plan: WebmVerificationPlan,
): Promise<WorldWebmVerificationEvidence> {
  if (!Number.isSafeInteger(size) || size < 64 || size > WORLD_RENDER_ARTIFACT_MAX_BYTES.webm) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const fileInfo = await handle.stat()
    if (!fileInfo.isFile() || fileInfo.nlink !== 1 || fileInfo.size !== size) throw new RenderRepositoryFault('unsafe_workspace')
    const ebml = await readEbmlFileElement(handle, 0, size, false)
    if (ebml.id !== 0x1a45dfa3 || ebml.dataEnd - ebml.dataOffset > 1024 * 1024) {
      throw new RenderRepositoryFault('output_invalid')
    }
    const ebmlHeader = await readExactly(handle, ebml.dataOffset, ebml.dataEnd - ebml.dataOffset)
    const documentType = parseSingleEbmlText(parseEbmlBufferElements(ebmlHeader), 0x4282)
    if (documentType !== 'webm') throw new RenderRepositoryFault('output_invalid')

    const segment = await readEbmlFileElement(handle, ebml.dataEnd, size, true)
    if (segment.id !== 0x18538067 || segment.dataEnd !== size) {
      throw new RenderRepositoryFault('output_invalid')
    }
    let offset = segment.dataOffset
    let info: WebmInfoContract | null = null
    let tracks: WebmTrackContract[] | null = null
    let sawCluster = false
    const timeline: WebmTimelineState = {
      videoBlocks: [],
      audioPackets: 0,
      audioBlocks: 0,
      lastAudioRawTimestampNanoseconds: null,
      lastAudioRawEndNanoseconds: null,
      audioFirstRawTimestampNanoseconds: null,
      audioCumulativeCodedDurationNanoseconds: 0n,
      audioInitialDiscardPaddingNanoseconds: null,
      audioFinalDiscardPaddingNanoseconds: null,
      audioFinalDiscardRawEndNanoseconds: null,
      lastClusterTimestampTicks: null,
    }
    while (offset < segment.dataEnd) {
      const element = await readEbmlFileElement(handle, offset, segment.dataEnd, true)
      if (element.unknownSize && element.id !== 0x1f43b675) throw new RenderRepositoryFault('output_invalid')
      let nextOffset = element.dataEnd
      if (element.id === 0x1549a966) {
        if (info || sawCluster || element.dataEnd === element.dataOffset
          || element.dataEnd - element.dataOffset > 1024 * 1024) {
          throw new RenderRepositoryFault('output_invalid')
        }
        info = parseWebmInfo(await readExactly(handle, element.dataOffset, element.dataEnd - element.dataOffset))
      } else if (element.id === 0x1654ae6b) {
        if (tracks || sawCluster || element.dataEnd - element.dataOffset > 16 * 1024 * 1024) {
          throw new RenderRepositoryFault('output_invalid')
        }
        tracks = parseWebmTracks(
          await readExactly(handle, element.dataOffset, element.dataEnd - element.dataOffset),
          plan.width,
          plan.height,
        )
      } else if (element.id === 0x1f43b675) {
        if (!info || !tracks) throw new RenderRepositoryFault('output_invalid')
        sawCluster = true
        nextOffset = await collectWebmClusterTimeline(
          handle,
          element.dataOffset,
          element.dataEnd,
          element.unknownSize,
          info,
          tracks,
          plan,
          timeline,
        )
      }
      if (nextOffset <= offset) throw new RenderRepositoryFault('output_invalid')
      offset = nextOffset
    }
    if (!info || !tracks || !sawCluster) {
      throw new RenderRepositoryFault('output_invalid')
    }
    return verifyWebmTimeline(plan, info, tracks, timeline)
  } finally {
    await handle.close()
  }
}

export async function inspectWorldWebmVerificationEvidence(
  path: string,
  size: number,
  plan: WorldWebmVerificationPlan,
): Promise<WorldWebmVerificationEvidence> {
  return verifyWebmPath(path, size, plan)
}

async function readEbmlFileElement(
  handle: FileHandle,
  offset: number,
  parentEnd: number,
  allowUnknownSize: boolean,
): Promise<EbmlElementHeader> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= parentEnd) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const prefix = await readExactly(handle, offset, Math.min(12, parentEnd - offset))
  const decoded = decodeEbmlElementHeader(prefix)
  const dataOffset = offset + decoded.headerLength
  const dataEnd = decoded.size === null ? parentEnd : dataOffset + decoded.size
  if ((decoded.size === null && !allowUnknownSize) || dataEnd < dataOffset || dataEnd > parentEnd
    || !Number.isSafeInteger(dataEnd)) throw new RenderRepositoryFault('output_invalid')
  return { id: decoded.id, dataOffset, dataEnd, unknownSize: decoded.size === null }
}

function decodeEbmlElementHeader(bytes: Uint8Array): { id: number; size: number | null; headerLength: number } {
  const idLength = ebmlVintLength(bytes[0], 4)
  if (bytes.byteLength < idLength + 1) throw new RenderRepositoryFault('output_invalid')
  let id = 0
  for (let index = 0; index < idLength; index += 1) id = id * 256 + bytes[index]
  const sizeOffset = idLength
  const sizeLength = ebmlVintLength(bytes[sizeOffset], 8)
  if (bytes.byteLength < idLength + sizeLength) throw new RenderRepositoryFault('output_invalid')
  const marker = 0x80 >> (sizeLength - 1)
  let value = BigInt(bytes[sizeOffset] & (marker - 1))
  let unknown = (bytes[sizeOffset] & (marker - 1)) === marker - 1
  for (let index = 1; index < sizeLength; index += 1) {
    value = value * 256n + BigInt(bytes[sizeOffset + index])
    unknown = unknown && bytes[sizeOffset + index] === 0xff
  }
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RenderRepositoryFault('output_invalid')
  return { id, size: unknown ? null : Number(value), headerLength: idLength + sizeLength }
}

function ebmlVintLength(first: number | undefined, maximum: number): number {
  if (first === undefined || first === 0) throw new RenderRepositoryFault('output_invalid')
  let marker = 0x80
  for (let length = 1; length <= maximum; length += 1) {
    if (first & marker) return length
    marker >>= 1
  }
  throw new RenderRepositoryFault('output_invalid')
}

function parseEbmlBufferElements(bytes: Buffer): Array<{ id: number; data: Buffer }> {
  const elements: Array<{ id: number; data: Buffer }> = []
  let offset = 0
  while (offset < bytes.byteLength) {
    const decoded = decodeEbmlElementHeader(bytes.subarray(offset, Math.min(bytes.byteLength, offset + 12)))
    if (decoded.size === null) throw new RenderRepositoryFault('output_invalid')
    const dataOffset = offset + decoded.headerLength
    const dataEnd = dataOffset + decoded.size
    if (dataEnd < dataOffset || dataEnd > bytes.byteLength) throw new RenderRepositoryFault('output_invalid')
    elements.push({ id: decoded.id, data: bytes.subarray(dataOffset, dataEnd) })
    offset = dataEnd
  }
  return elements
}

function parseWebmInfo(bytes: Buffer): WebmInfoContract {
  const fields = parseEbmlBufferElements(bytes)
  const timestampScale = parseOptionalSingleEbmlUnsigned(fields, 0x2ad7b1)
    ?? Number(WEBM_DEFAULT_TIMESTAMP_SCALE_NANOSECONDS)
  if (!Number.isSafeInteger(timestampScale) || timestampScale < 1
    || timestampScale > WEBM_MAX_TIMESTAMP_SCALE_NANOSECONDS) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const duration = parseOptionalSingleEbmlFloat(fields, 0x4489)
  if (duration !== null && (duration <= 0
    || duration > Number.MAX_SAFE_INTEGER / timestampScale)) {
    throw new RenderRepositoryFault('output_invalid')
  }
  return {
    timestampScaleNanoseconds: BigInt(timestampScale),
    declaredDurationNanoseconds: duration === null
      ? null
      : BigInt(Math.round(duration * timestampScale)),
  }
}

function parseWebmTracks(bytes: Buffer, expectedWidth: number, expectedHeight: number): WebmTrackContract[] {
  const entries = parseEbmlBufferElements(bytes).filter((element) => element.id === 0xae)
  if (entries.length !== 2) throw new RenderRepositoryFault('output_invalid')
  const tracks: WebmTrackContract[] = []
  for (const entry of entries) {
    const fields = parseEbmlBufferElements(entry.data)
    const number = parseSingleEbmlUnsigned(fields, 0xd7)
    const type = parseSingleEbmlUnsigned(fields, 0x83)
    const codec = parseSingleEbmlText(fields, 0x86)
    const defaultDurationBytes = optionalSingleEbmlField(fields, 0x23e383)
    const defaultDurationNanoseconds = defaultDurationBytes === null
      ? null
      : parseEbmlUnsignedBigInt(defaultDurationBytes)
    const codecDelayBytes = optionalSingleEbmlField(fields, 0x56aa)
    const codecDelayNanoseconds = codecDelayBytes === null ? 0n : parseEbmlUnsignedBigInt(codecDelayBytes)
    const seekPreRollBytes = optionalSingleEbmlField(fields, 0x56bb)
    const seekPreRollNanoseconds = seekPreRollBytes === null ? 0n : parseEbmlUnsignedBigInt(seekPreRollBytes)
    const trackTimestampScale = parseOptionalSingleEbmlFloat(fields, 0x23314f)
    if (defaultDurationNanoseconds !== null && defaultDurationNanoseconds <= 0n) {
      throw new RenderRepositoryFault('output_invalid')
    }
    if ((trackTimestampScale !== null && trackTimestampScale !== 1)
      || codecDelayNanoseconds < 0n || codecDelayNanoseconds > 120_000_000n
      || seekPreRollNanoseconds < 0n || seekPreRollNanoseconds > 120_000_000n) {
      throw new RenderRepositoryFault('output_invalid')
    }
    if (!Number.isSafeInteger(number) || number <= 0 || tracks.some((track) => track.number === number)) {
      throw new RenderRepositoryFault('output_invalid')
    }
    if (type === 1 && codec === 'V_VP9') {
      const video = singleEbmlField(fields, 0xe0)
      const videoFields = parseEbmlBufferElements(video)
      if (parseSingleEbmlUnsigned(videoFields, 0xb0) !== expectedWidth
        || parseSingleEbmlUnsigned(videoFields, 0xba) !== expectedHeight) {
        throw new RenderRepositoryFault('output_invalid')
      }
      if (codecDelayNanoseconds !== 0n || seekPreRollNanoseconds !== 0n) {
        throw new RenderRepositoryFault('output_invalid')
      }
      tracks.push({
        number,
        type: 'video',
        defaultDurationNanoseconds,
        codecDelayNanoseconds,
        seekPreRollNanoseconds,
        opusPreSkipSamples: null,
      })
    } else if (type === 2 && codec === 'A_OPUS') {
      const audio = singleEbmlField(fields, 0xe1)
      const audioFields = parseEbmlBufferElements(audio)
      const sampleRate = parseSingleEbmlFloat(audioFields, 0xb5)
      const channels = parseSingleEbmlUnsigned(audioFields, 0x9f)
      const codecPrivate = singleEbmlField(fields, 0x63a2)
      const opusPreSkipSamples = parseOpusHeadPreSkipSamples(codecPrivate)
      if (sampleRate !== 48_000 || channels !== 2
        || (codecDelayNanoseconds > 0n
          && (seekPreRollBytes === null || seekPreRollNanoseconds < codecDelayNanoseconds))
        || (codecDelayNanoseconds > 0n
          && !isSubNanosecondRationalMatch(
            codecDelayNanoseconds * 48_000n,
            BigInt(opusPreSkipSamples) * 1_000_000_000n,
            48_000n,
          ))) {
        throw new RenderRepositoryFault('output_invalid')
      }
      tracks.push({
        number,
        type: 'audio',
        defaultDurationNanoseconds,
        codecDelayNanoseconds,
        seekPreRollNanoseconds,
        opusPreSkipSamples,
      })
    } else {
      throw new RenderRepositoryFault('output_invalid')
    }
  }
  if (tracks.filter((track) => track.type === 'video').length !== 1
    || tracks.filter((track) => track.type === 'audio').length !== 1) {
    throw new RenderRepositoryFault('output_invalid')
  }
  return tracks
}

function singleEbmlField(fields: readonly { id: number; data: Buffer }[], id: number): Buffer {
  const match = optionalSingleEbmlField(fields, id)
  if (!match) throw new RenderRepositoryFault('output_invalid')
  return match
}

function optionalSingleEbmlField(
  fields: readonly { id: number; data: Buffer }[],
  id: number,
): Buffer | null {
  const matches = fields.filter((field) => field.id === id)
  if (matches.length > 1) throw new RenderRepositoryFault('output_invalid')
  return matches[0]?.data ?? null
}

function parseSingleEbmlUnsigned(fields: readonly { id: number; data: Buffer }[], id: number): number {
  const bytes = singleEbmlField(fields, id)
  if (bytes.byteLength < 1 || bytes.byteLength > 8) throw new RenderRepositoryFault('output_invalid')
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RenderRepositoryFault('output_invalid')
  return Number(value)
}

function parseOptionalSingleEbmlUnsigned(
  fields: readonly { id: number; data: Buffer }[],
  id: number,
): number | null {
  const bytes = optionalSingleEbmlField(fields, id)
  if (!bytes) return null
  if (bytes.byteLength < 1 || bytes.byteLength > 8) throw new RenderRepositoryFault('output_invalid')
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RenderRepositoryFault('output_invalid')
  return Number(value)
}

function parseSingleEbmlText(fields: readonly { id: number; data: Buffer }[], id: number): string {
  const bytes = singleEbmlField(fields, id)
  if (bytes.byteLength < 1 || bytes.byteLength > 128) throw new RenderRepositoryFault('output_invalid')
  const textEnd = bytes[bytes.byteLength - 1] === 0 ? bytes.byteLength - 1 : bytes.byteLength
  if (textEnd === 0 || bytes.subarray(0, textEnd).includes(0)) {
    throw new RenderRepositoryFault('output_invalid')
  }
  return bytes.subarray(0, textEnd).toString('utf8')
}

function parseSingleEbmlFloat(fields: readonly { id: number; data: Buffer }[], id: number): number {
  const bytes = singleEbmlField(fields, id)
  const value = bytes.byteLength === 4 ? bytes.readFloatBE(0) : bytes.byteLength === 8 ? bytes.readDoubleBE(0) : Number.NaN
  if (!Number.isFinite(value)) throw new RenderRepositoryFault('output_invalid')
  return value
}

function parseOptionalSingleEbmlFloat(
  fields: readonly { id: number; data: Buffer }[],
  id: number,
): number | null {
  const bytes = optionalSingleEbmlField(fields, id)
  if (!bytes) return null
  const value = bytes.byteLength === 4 ? bytes.readFloatBE(0) : bytes.byteLength === 8 ? bytes.readDoubleBE(0) : Number.NaN
  if (!Number.isFinite(value)) throw new RenderRepositoryFault('output_invalid')
  return value
}

function parseOpusHeadPreSkipSamples(bytes: Buffer): number {
  if (bytes.byteLength !== 19 || bytes.subarray(0, 8).toString('ascii') !== 'OpusHead'
    || bytes[8] !== 1 || bytes[9] !== 2 || (bytes.readUInt32LE(12) !== 0
      && bytes.readUInt32LE(12) !== 48_000) || bytes[18] !== 0) {
    throw new RenderRepositoryFault('output_invalid')
  }
  return bytes.readUInt16LE(10)
}

function isSubNanosecondRationalMatch(
  leftScaledNanoseconds: bigint,
  rightScaledNanoseconds: bigint,
  unitsPerNanosecond: bigint,
): boolean {
  return unitsPerNanosecond > 0n
    && absoluteBigInt(leftScaledNanoseconds - rightScaledNanoseconds) < unitsPerNanosecond
}

async function collectWebmClusterTimeline(
  handle: FileHandle,
  start: number,
  end: number,
  unknownSize: boolean,
  info: WebmInfoContract,
  tracks: readonly WebmTrackContract[],
  plan: WebmVerificationPlan,
  timeline: WebmTimelineState,
): Promise<number> {
  let offset = start
  let clusterTimestampTicks: bigint | null = null
  let sawBlock = false
  while (offset < end) {
    const element = await readEbmlFileElement(handle, offset, end, unknownSize)
    if (unknownSize && isWebmSegmentLevelOneElement(element.id)) break
    if (element.unknownSize) throw new RenderRepositoryFault('output_invalid')
    if (element.id === 0xe7) {
      if (clusterTimestampTicks !== null || sawBlock) throw new RenderRepositoryFault('output_invalid')
      const bytes = await readExactly(handle, element.dataOffset, element.dataEnd - element.dataOffset)
      clusterTimestampTicks = parseEbmlUnsignedBigInt(bytes)
      if (timeline.lastClusterTimestampTicks !== null
        && clusterTimestampTicks < timeline.lastClusterTimestampTicks) {
        throw new RenderRepositoryFault('output_invalid')
      }
      timeline.lastClusterTimestampTicks = clusterTimestampTicks
    } else if (element.id === 0xa3) {
      if (clusterTimestampTicks === null) throw new RenderRepositoryFault('output_invalid')
      sawBlock = true
      await collectWebmBlockTimeline(
        handle, element.dataOffset, element.dataEnd, clusterTimestampTicks, info, tracks, plan, timeline,
        null, 0n,
      )
    } else if (element.id === 0xa0) {
      if (clusterTimestampTicks === null) throw new RenderRepositoryFault('output_invalid')
      sawBlock = true
      await collectWebmBlockGroupTimeline(
        handle, element.dataOffset, element.dataEnd, clusterTimestampTicks, info, tracks, plan, timeline,
      )
    }
    offset = element.dataEnd
  }
  if (clusterTimestampTicks === null || !sawBlock) throw new RenderRepositoryFault('output_invalid')
  return offset
}

function isWebmSegmentLevelOneElement(id: number): boolean {
  return id === 0x114d9b74 // SeekHead
    || id === 0x1549a966 // Info
    || id === 0x1654ae6b // Tracks
    || id === 0x1f43b675 // Cluster
    || id === 0x1c53bb6b // Cues
    || id === 0x1941a469 // Attachments
    || id === 0x1043a770 // Chapters
    || id === 0x1254c367 // Tags
}

async function collectWebmBlockGroupTimeline(
  handle: FileHandle,
  start: number,
  end: number,
  clusterTimestampTicks: bigint,
  info: WebmInfoContract,
  tracks: readonly WebmTrackContract[],
  plan: WebmVerificationPlan,
  timeline: WebmTimelineState,
): Promise<void> {
  let offset = start
  let block: { start: number; end: number } | null = null
  let blockDurationTicks: bigint | null = null
  let sawBlockDuration = false
  let discardPaddingNanoseconds = 0n
  let sawDiscardPadding = false
  while (offset < end) {
    const element = await readEbmlFileElement(handle, offset, end, false)
    if (element.id === 0xa1) {
      if (block) throw new RenderRepositoryFault('output_invalid')
      block = { start: element.dataOffset, end: element.dataEnd }
    } else if (element.id === 0x9b) {
      if (sawBlockDuration) throw new RenderRepositoryFault('output_invalid')
      sawBlockDuration = true
      blockDurationTicks = parseEbmlUnsignedBigInt(
        await readExactly(handle, element.dataOffset, element.dataEnd - element.dataOffset),
      )
      if (blockDurationTicks <= 0n) throw new RenderRepositoryFault('output_invalid')
    } else if (element.id === 0x75a2) {
      if (sawDiscardPadding) throw new RenderRepositoryFault('output_invalid')
      sawDiscardPadding = true
      discardPaddingNanoseconds = parseEbmlSignedBigInt(
        await readExactly(handle, element.dataOffset, element.dataEnd - element.dataOffset),
      )
      if (absoluteBigInt(discardPaddingNanoseconds) > 120_000_000n) {
        throw new RenderRepositoryFault('output_invalid')
      }
    }
    offset = element.dataEnd
  }
  if (!block) throw new RenderRepositoryFault('output_invalid')
  await collectWebmBlockTimeline(
    handle, block.start, block.end, clusterTimestampTicks, info, tracks, plan, timeline,
    blockDurationTicks, discardPaddingNanoseconds,
  )
}

async function collectWebmBlockTimeline(
  handle: FileHandle,
  start: number,
  end: number,
  clusterTimestampTicks: bigint,
  info: WebmInfoContract,
  tracks: readonly WebmTrackContract[],
  plan: WebmVerificationPlan,
  timeline: WebmTimelineState,
  blockDurationTicks: bigint | null,
  discardPaddingNanoseconds: bigint,
): Promise<void> {
  const size = end - start
  if (size < 5) throw new RenderRepositoryFault('output_invalid')
  const prefix = await readExactly(handle, start, Math.min(16, size))
  const decodedTrack = decodeEbmlUnsignedVint(prefix)
  const headerLength = decodedTrack.length + 3
  if (size <= headerLength || prefix.byteLength < headerLength) throw new RenderRepositoryFault('output_invalid')
  const track = tracks.find((candidate) => candidate.number === decodedTrack.value)
  if (!track) throw new RenderRepositoryFault('output_invalid')
  const relativeTimestamp = prefix.readInt16BE(decodedTrack.length)
  const flags = prefix[decodedTrack.length + 2]
  const timestampTicks = clusterTimestampTicks + BigInt(relativeTimestamp)
  const rawTimestampNanoseconds = timestampTicks * info.timestampScaleNanoseconds
  const lacing = flags & 0x06
  if (track.type === 'video') {
    if (lacing !== 0 || discardPaddingNanoseconds !== 0n) throw new RenderRepositoryFault('output_invalid')
    recordWebmVideoTimestamp(
      timestampTicks,
      blockDurationTicks,
      info,
      track,
      plan,
      timeline,
    )
    return
  }

  const maximumAudioBlockBytes = WEBM_MAX_OPUS_PACKET_BYTES * WEBM_MAX_LACED_OPUS_PACKETS + 512
  if (size > maximumAudioBlockBytes) throw new RenderRepositoryFault('output_invalid')
  const block = await readExactly(handle, start, size)
  const packets = splitWebmLacedPackets(block.subarray(headerLength), lacing)
  const packetDurations = packets.map(opusPacketDurationNanoseconds)
  if (track.defaultDurationNanoseconds !== null) {
    for (const durationNanoseconds of packetDurations) {
      if (absoluteBigInt(durationNanoseconds - track.defaultDurationNanoseconds) > 1n) {
        throw new RenderRepositoryFault('output_invalid')
      }
    }
  }
  const codedDurationNanoseconds = packetDurations.reduce((sum, duration) => sum + duration, 0n)
  const absoluteDiscardPaddingNanoseconds = absoluteBigInt(discardPaddingNanoseconds)
  const effectiveDurationNanoseconds = codedDurationNanoseconds - absoluteDiscardPaddingNanoseconds
  if (effectiveDurationNanoseconds <= 0n) throw new RenderRepositoryFault('output_invalid')
  if (blockDurationTicks !== null
    && blockDurationTicks !== roundNanosecondsToTicks(effectiveDurationNanoseconds, info.timestampScaleNanoseconds)) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const isFirstAudioBlock = timeline.audioPackets === 0
  let packetRawTimestampNanoseconds = rawTimestampNanoseconds
  for (const durationNanoseconds of packetDurations) {
    recordWebmAudioPacket(packetRawTimestampNanoseconds, durationNanoseconds, info, plan, timeline)
    packetRawTimestampNanoseconds += durationNanoseconds
  }
  recordWebmAudioBlockDiscard(
    rawTimestampNanoseconds,
    codedDurationNanoseconds,
    discardPaddingNanoseconds,
    isFirstAudioBlock,
    track,
    timeline,
  )
}

function recordWebmVideoTimestamp(
  timestampTicks: bigint,
  blockDurationTicks: bigint | null,
  info: WebmInfoContract,
  track: WebmTrackContract,
  plan: WebmVerificationPlan,
  timeline: WebmTimelineState,
): void {
  const blockIndex = timeline.videoBlocks.length
  if (blockIndex >= plan.frameCount
    || timestampTicks < 0n
    || (blockIndex > 0
      && timestampTicks <= timeline.videoBlocks[blockIndex - 1].timestampTicks)) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const expectedTimestampTicks = roundRationalNanosecondsToTicks(
    { numerator: blockIndex, denominator: plan.fps },
    info.timestampScaleNanoseconds,
  )
  if (timestampTicks !== expectedTimestampTicks) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const expectedDuration = plan.frameDurations[blockIndex]
  if (!expectedDuration) throw new RenderRepositoryFault('output_invalid')
  if (track.defaultDurationNanoseconds !== null
    && !isSubNanosecondRationalMatch(
      track.defaultDurationNanoseconds * BigInt(plan.fps),
      1_000_000_000n,
      BigInt(plan.fps),
    )) {
    throw new RenderRepositoryFault('output_invalid')
  }
  timeline.videoBlocks.push({ timestampTicks, blockDurationTicks })
}

function recordWebmAudioPacket(
  rawTimestampNanoseconds: bigint,
  durationNanoseconds: bigint,
  info: WebmInfoContract,
  plan: WebmVerificationPlan,
  timeline: WebmTimelineState,
): void {
  const maximumPacketCount = Math.ceil(plan.audioSampleCount / 120) + WEBM_MAX_LACED_OPUS_PACKETS
  if (timeline.audioPackets >= maximumPacketCount
    || (timeline.lastAudioRawTimestampNanoseconds !== null
      && rawTimestampNanoseconds <= timeline.lastAudioRawTimestampNanoseconds)) {
    throw new RenderRepositoryFault('output_invalid')
  }
  timeline.audioFirstRawTimestampNanoseconds ??= rawTimestampNanoseconds
  const expectedRawTimestampNanoseconds = timeline.audioFirstRawTimestampNanoseconds
    + timeline.audioCumulativeCodedDurationNanoseconds
  if (absoluteBigInt(rawTimestampNanoseconds - expectedRawTimestampNanoseconds)
    > webmTimeQuantizationToleranceNanoseconds(info)) {
    throw new RenderRepositoryFault('output_invalid')
  }
  timeline.lastAudioRawTimestampNanoseconds = rawTimestampNanoseconds
  timeline.lastAudioRawEndNanoseconds = rawTimestampNanoseconds + durationNanoseconds
  timeline.audioCumulativeCodedDurationNanoseconds += durationNanoseconds
  timeline.audioPackets += 1
}

function recordWebmAudioBlockDiscard(
  rawTimestampNanoseconds: bigint,
  codedDurationNanoseconds: bigint,
  discardPaddingNanoseconds: bigint,
  isFirstAudioBlock: boolean,
  track: WebmTrackContract,
  timeline: WebmTimelineState,
): void {
  timeline.audioBlocks += 1
  if (discardPaddingNanoseconds === 0n) return
  if (discardPaddingNanoseconds < 0n) {
    const initialDiscardPaddingNanoseconds = -discardPaddingNanoseconds
    if (!isFirstAudioBlock || timeline.audioInitialDiscardPaddingNanoseconds !== null
      || track.codecDelayNanoseconds === 0n
      || absoluteBigInt(initialDiscardPaddingNanoseconds - track.codecDelayNanoseconds) > 1n) {
      throw new RenderRepositoryFault('output_invalid')
    }
    timeline.audioInitialDiscardPaddingNanoseconds = initialDiscardPaddingNanoseconds
    return
  }
  if (timeline.audioFinalDiscardPaddingNanoseconds !== null) {
    throw new RenderRepositoryFault('output_invalid')
  }
  timeline.audioFinalDiscardPaddingNanoseconds = discardPaddingNanoseconds
  timeline.audioFinalDiscardRawEndNanoseconds = rawTimestampNanoseconds + codedDurationNanoseconds
}

function splitWebmLacedPackets(payload: Buffer, lacing: number): readonly Buffer[] {
  if (payload.byteLength < 1) throw new RenderRepositoryFault('output_invalid')
  if (lacing === 0) return validateWebmLacePacketSizes(payload, 0, [payload.byteLength])
  const frameCount = payload[0] + 1
  if (frameCount < 1 || frameCount > WEBM_MAX_LACED_OPUS_PACKETS) {
    throw new RenderRepositoryFault('output_invalid')
  }
  let offset = 1
  const sizes: number[] = []
  if (lacing === 0x02) {
    for (let index = 0; index < frameCount - 1; index += 1) {
      let size = 0
      for (;;) {
        if (offset >= payload.byteLength) throw new RenderRepositoryFault('output_invalid')
        const part = payload[offset++]
        size += part
        if (part !== 0xff) break
      }
      sizes.push(size)
    }
  } else if (lacing === 0x04) {
    const remaining = payload.byteLength - offset
    if (remaining % frameCount !== 0) throw new RenderRepositoryFault('output_invalid')
    sizes.push(...Array.from({ length: frameCount - 1 }, () => remaining / frameCount))
  } else if (lacing === 0x06) {
    const first = decodeEbmlLaceVint(payload, offset)
    offset += first.length
    sizes.push(first.value)
    for (let index = 1; index < frameCount - 1; index += 1) {
      const difference = decodeEbmlLaceSignedVint(payload, offset)
      offset += difference.length
      sizes.push(sizes[index - 1] + difference.value)
    }
  } else {
    throw new RenderRepositoryFault('output_invalid')
  }
  sizes.push(payload.byteLength - offset - sizes.reduce((total, value) => total + value, 0))
  return validateWebmLacePacketSizes(payload, offset, sizes)
}

function validateWebmLacePacketSizes(payload: Buffer, offset: number, sizes: readonly number[]): readonly Buffer[] {
  const packets: Buffer[] = []
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 1 || size > WEBM_MAX_OPUS_PACKET_BYTES
      || offset + size > payload.byteLength) {
      throw new RenderRepositoryFault('output_invalid')
    }
    packets.push(payload.subarray(offset, offset + size))
    offset += size
  }
  if (offset !== payload.byteLength) throw new RenderRepositoryFault('output_invalid')
  return packets
}

function decodeEbmlLaceVint(bytes: Uint8Array, offset: number): { value: number; length: number } {
  const length = ebmlVintLength(bytes[offset], 4)
  if (offset + length > bytes.byteLength) throw new RenderRepositoryFault('output_invalid')
  const marker = 0x80 >> (length - 1)
  let value = bytes[offset] & (marker - 1)
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index]
  return { value, length }
}

function decodeEbmlLaceSignedVint(bytes: Uint8Array, offset: number): { value: number; length: number } {
  const unsigned = decodeEbmlLaceVint(bytes, offset)
  const bias = 2 ** (7 * unsigned.length - 1) - 1
  return { value: unsigned.value - bias, length: unsigned.length }
}

function opusPacketDurationNanoseconds(packet: Uint8Array): bigint {
  if (packet.byteLength < 1 || packet.byteLength > WEBM_MAX_OPUS_PACKET_BYTES) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const configuration = packet[0] >> 3
  let frameDurationMicroseconds: number
  if (configuration >= 16) frameDurationMicroseconds = 2_500 * 2 ** (configuration & 0x03)
  else if (configuration >= 12) frameDurationMicroseconds = 10_000 * 2 ** (configuration & 0x01)
  else if ((configuration & 0x03) === 0x03) frameDurationMicroseconds = 60_000
  else frameDurationMicroseconds = 10_000 * 2 ** (configuration & 0x03)
  const frameCode = packet[0] & 0x03
  const frameCount = validateOpusPacketFraming(packet, frameCode)
  const durationMicroseconds = frameDurationMicroseconds * frameCount
  if (frameCount < 1 || durationMicroseconds > 120_000) throw new RenderRepositoryFault('output_invalid')
  return BigInt(durationMicroseconds) * 1_000n
}

function validateOpusPacketFraming(packet: Uint8Array, frameCode: number): number {
  if (frameCode === 0) {
    assertOpusFrameSize(packet.byteLength - 1)
    return 1
  }
  if (frameCode === 1) {
    const payloadSize = packet.byteLength - 1
    if (payloadSize % 2 !== 0) throw new RenderRepositoryFault('output_invalid')
    assertOpusFrameSize(payloadSize / 2)
    return 2
  }
  if (frameCode === 2) {
    const decoded = decodeOpusFrameLength(packet, 1, packet.byteLength)
    const secondSize = packet.byteLength - decoded.nextOffset - decoded.size
    assertOpusFrameSize(decoded.size)
    assertOpusFrameSize(secondSize)
    if (decoded.nextOffset + decoded.size + secondSize !== packet.byteLength) {
      throw new RenderRepositoryFault('output_invalid')
    }
    return 2
  }

  if (packet.byteLength < 2) throw new RenderRepositoryFault('output_invalid')
  const control = packet[1]
  const frameCount = control & 0x3f
  if (frameCount < 1 || frameCount > WEBM_MAX_OPUS_PACKET_FRAMES) {
    throw new RenderRepositoryFault('output_invalid')
  }
  let offset = 2
  let paddingSize = 0
  if ((control & 0x40) !== 0) {
    for (;;) {
      if (offset >= packet.byteLength) throw new RenderRepositoryFault('output_invalid')
      const byte = packet[offset++]
      paddingSize += byte === 0xff ? 254 : byte
      if (!Number.isSafeInteger(paddingSize) || paddingSize > WEBM_MAX_OPUS_PADDING_BYTES
        || paddingSize > packet.byteLength) {
        throw new RenderRepositoryFault('output_invalid')
      }
      if (byte !== 0xff) break
    }
  }
  const payloadEnd = packet.byteLength - paddingSize
  if (payloadEnd < offset) throw new RenderRepositoryFault('output_invalid')

  if ((control & 0x80) === 0) {
    const payloadSize = payloadEnd - offset
    if (payloadSize % frameCount !== 0) throw new RenderRepositoryFault('output_invalid')
    assertOpusFrameSize(payloadSize / frameCount)
    return frameCount
  }

  let declaredPayloadSize = 0
  for (let index = 0; index < frameCount - 1; index += 1) {
    const decoded = decodeOpusFrameLength(packet, offset, payloadEnd)
    offset = decoded.nextOffset
    assertOpusFrameSize(decoded.size)
    declaredPayloadSize += decoded.size
    if (!Number.isSafeInteger(declaredPayloadSize) || declaredPayloadSize > payloadEnd - offset) {
      throw new RenderRepositoryFault('output_invalid')
    }
  }
  const finalFrameSize = payloadEnd - offset - declaredPayloadSize
  assertOpusFrameSize(finalFrameSize)
  if (offset + declaredPayloadSize + finalFrameSize !== payloadEnd) {
    throw new RenderRepositoryFault('output_invalid')
  }
  return frameCount
}

function decodeOpusFrameLength(
  packet: Uint8Array,
  offset: number,
  end: number,
): { size: number; nextOffset: number } {
  if (offset < 0 || offset >= end || end > packet.byteLength) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const first = packet[offset]
  if (first < 252) return { size: first, nextOffset: offset + 1 }
  if (offset + 1 >= end) throw new RenderRepositoryFault('output_invalid')
  return { size: first + 4 * packet[offset + 1], nextOffset: offset + 2 }
}

function assertOpusFrameSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > WEBM_MAX_OPUS_FRAME_BYTES) {
    throw new RenderRepositoryFault('output_invalid')
  }
}

function parseEbmlUnsignedBigInt(bytes: Uint8Array): bigint {
  if (bytes.byteLength < 1 || bytes.byteLength > 8) throw new RenderRepositoryFault('output_invalid')
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  return value
}

function parseEbmlSignedBigInt(bytes: Uint8Array): bigint {
  if (bytes.byteLength < 1 || bytes.byteLength > 8) throw new RenderRepositoryFault('output_invalid')
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  if ((bytes[0] & 0x80) !== 0) value -= 1n << BigInt(bytes.byteLength * 8)
  return value
}

function roundNanosecondsToTicks(nanoseconds: bigint, timestampScaleNanoseconds: bigint): bigint {
  if (nanoseconds < 0n || timestampScaleNanoseconds < 1n) {
    throw new RenderRepositoryFault('output_invalid')
  }
  return (nanoseconds + timestampScaleNanoseconds / 2n) / timestampScaleNanoseconds
}

function roundRationalNanoseconds(value: { numerator: number; denominator: number }): bigint {
  if (!Number.isSafeInteger(value.numerator) || value.numerator < 0
    || !Number.isSafeInteger(value.denominator) || value.denominator <= 0) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const numerator = BigInt(value.numerator) * 1_000_000_000n
  const denominator = BigInt(value.denominator)
  return (numerator + denominator / 2n) / denominator
}

function roundRationalNanosecondsToTicks(
  value: { numerator: number; denominator: number },
  timestampScaleNanoseconds: bigint,
): bigint {
  if (!Number.isSafeInteger(value.numerator) || value.numerator < 0
    || !Number.isSafeInteger(value.denominator) || value.denominator <= 0
    || timestampScaleNanoseconds < 1n) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const numerator = BigInt(value.numerator) * 1_000_000_000n
  const denominator = BigInt(value.denominator) * timestampScaleNanoseconds
  return (numerator + denominator / 2n) / denominator
}

function verifyWebmTimeline(
  plan: WebmVerificationPlan,
  info: WebmInfoContract,
  tracks: readonly WebmTrackContract[],
  timeline: WebmTimelineState,
): WorldWebmVerificationEvidence {
  if (timeline.videoBlocks.length !== plan.frameCount || timeline.audioPackets < 1
    || timeline.audioBlocks < 1 || timeline.audioFirstRawTimestampNanoseconds === null
    || timeline.lastAudioRawEndNanoseconds === null) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const videoTrack = tracks.find((track) => track.type === 'video')
  const audioTrack = tracks.find((track) => track.type === 'audio')
  if (!videoTrack || !audioTrack) throw new RenderRepositoryFault('output_invalid')
  const expectedDurationNanoseconds = roundRationalNanoseconds(plan.duration)
  const videoEndNanoseconds = verifyWebmVideoTimeline(
    plan, info, videoTrack, timeline.videoBlocks, expectedDurationNanoseconds,
  )
  const audio = verifyWebmAudioTimeline(plan, info, audioTrack, timeline)
  const timeQuantizationTolerance = webmTimeQuantizationToleranceNanoseconds(info)
  if (info.declaredDurationNanoseconds !== null) {
    const expectedDurationDifference = absoluteBigInt(
      info.declaredDurationNanoseconds * BigInt(plan.duration.denominator)
        - BigInt(plan.duration.numerator) * 1_000_000_000n,
    )
    if (expectedDurationDifference
      > timeQuantizationTolerance * BigInt(plan.duration.denominator)) {
      throw new RenderRepositoryFault('output_invalid')
    }
  }
  return Object.freeze({
    videoCodec: 'V_VP9',
    audioCodec: 'A_OPUS',
    timestampScaleNanoseconds: info.timestampScaleNanoseconds,
    declaredDurationNanoseconds: info.declaredDurationNanoseconds,
    videoFrameCount: timeline.videoBlocks.length,
    videoPresentationTimestampsTicks: Object.freeze(
      timeline.videoBlocks.map((block) => block.timestampTicks),
    ),
    videoEndNanoseconds,
    audioPacketCount: timeline.audioPackets,
    audioPresentedStartNanoseconds: audio.presentedStartNanoseconds,
    audioPresentedEndNanoseconds: audio.presentedEndNanoseconds,
  })
}

function verifyWebmAudioTimeline(
  plan: WebmVerificationPlan,
  info: WebmInfoContract,
  track: WebmTrackContract,
  timeline: WebmTimelineState,
): { presentedStartNanoseconds: bigint; presentedEndNanoseconds: bigint } {
  const firstRawTimestampNanoseconds = timeline.audioFirstRawTimestampNanoseconds
  const lastRawEndNanoseconds = timeline.lastAudioRawEndNanoseconds
  if (firstRawTimestampNanoseconds === null || lastRawEndNanoseconds === null
    || track.opusPreSkipSamples === null
    || (track.seekPreRollNanoseconds !== 0n
      && track.seekPreRollNanoseconds < track.codecDelayNanoseconds)) {
    throw new RenderRepositoryFault('output_invalid')
  }
  const timeToleranceNanoseconds = webmTimeQuantizationToleranceNanoseconds(info)
  const expectedRawEndNanoseconds = firstRawTimestampNanoseconds
    + timeline.audioCumulativeCodedDurationNanoseconds
  if (absoluteBigInt(lastRawEndNanoseconds - expectedRawEndNanoseconds)
    > timeToleranceNanoseconds) {
    throw new RenderRepositoryFault('output_invalid')
  }
  if (timeline.audioFinalDiscardPaddingNanoseconds !== null
    && (timeline.audioFinalDiscardRawEndNanoseconds === null
      || absoluteBigInt(timeline.audioFinalDiscardRawEndNanoseconds - lastRawEndNanoseconds)
        > timeToleranceNanoseconds)) {
    throw new RenderRepositoryFault('output_invalid')
  }

  let firstPresentationTimestampNanoseconds = firstRawTimestampNanoseconds
    - track.codecDelayNanoseconds
  if (firstPresentationTimestampNanoseconds < -timeToleranceNanoseconds
    && (track.codecDelayNanoseconds === 0n
      || absoluteBigInt(-firstPresentationTimestampNanoseconds - track.codecDelayNanoseconds)
        > timeToleranceNanoseconds)) {
    throw new RenderRepositoryFault('output_invalid')
  }
  if (timeline.audioInitialDiscardPaddingNanoseconds !== null) {
    firstPresentationTimestampNanoseconds += timeline.audioInitialDiscardPaddingNanoseconds
  }
  const presentedStartNanoseconds = firstPresentationTimestampNanoseconds < 0n
    ? 0n : firstPresentationTimestampNanoseconds
  const presentedEndNanoseconds = lastRawEndNanoseconds
    - track.codecDelayNanoseconds
    - (timeline.audioFinalDiscardPaddingNanoseconds ?? 0n)
  const expectedAudioSampleTimeNumerator = BigInt(plan.audioSampleCount) * 1_000_000_000n
  const oneAudioSampleNumerator = 1_000_000_000n
  if (presentedEndNanoseconds <= presentedStartNanoseconds
    || absoluteBigInt(presentedStartNanoseconds) > timeToleranceNanoseconds
    || absoluteBigInt(
      presentedEndNanoseconds * 48_000n - expectedAudioSampleTimeNumerator,
    ) > timeToleranceNanoseconds * 48_000n + oneAudioSampleNumerator) {
    throw new RenderRepositoryFault('output_invalid')
  }
  return { presentedStartNanoseconds, presentedEndNanoseconds }
}

function verifyWebmVideoTimeline(
  plan: WebmVerificationPlan,
  info: WebmInfoContract,
  track: WebmTrackContract,
  blocks: readonly WebmVideoBlockTiming[],
  expectedDurationNanoseconds: bigint,
): bigint {
  const expectedEndTicks = roundRationalNanosecondsToTicks(
    plan.duration,
    info.timestampScaleNanoseconds,
  )
  const toleranceNanoseconds = webmTimeQuantizationToleranceNanoseconds(info)
  if (info.declaredDurationNanoseconds !== null
    && (roundNanosecondsToTicks(info.declaredDurationNanoseconds, info.timestampScaleNanoseconds)
      !== expectedEndTicks
      || absoluteBigInt(info.declaredDurationNanoseconds - expectedDurationNanoseconds)
        > toleranceNanoseconds)) {
    throw new RenderRepositoryFault('output_invalid')
  }

  for (const [index, block] of blocks.entries()) {
    const expectedSampleDuration = plan.frameDurations[index]
    if (!expectedSampleDuration) throw new RenderRepositoryFault('output_invalid')
    const expectedSampleDurationNanoseconds = roundRationalNanoseconds(expectedSampleDuration)
    const expectedSampleEndTicks = index + 1 < blocks.length
      ? blocks[index + 1].timestampTicks
      : expectedEndTicks
    const effectiveDurationTicks = expectedSampleEndTicks - block.timestampTicks
    if (effectiveDurationTicks <= 0n) throw new RenderRepositoryFault('output_invalid')
    if (block.blockDurationTicks !== null
      && block.blockDurationTicks !== effectiveDurationTicks) {
      throw new RenderRepositoryFault('output_invalid')
    }
    if (block.blockDurationTicks === null && track.defaultDurationNanoseconds !== null
      && (absoluteBigInt(track.defaultDurationNanoseconds - expectedSampleDurationNanoseconds)
        > toleranceNanoseconds
        || absoluteBigInt(
          block.timestampTicks * info.timestampScaleNanoseconds
            + track.defaultDurationNanoseconds
            - expectedSampleEndTicks * info.timestampScaleNanoseconds,
        ) > toleranceNanoseconds)) {
      throw new RenderRepositoryFault('output_invalid')
    }
  }

  const finalBlock = blocks[blocks.length - 1]
  if (!finalBlock) throw new RenderRepositoryFault('output_invalid')
  if (finalBlock.blockDurationTicks === null
    && track.defaultDurationNanoseconds === null
    && info.declaredDurationNanoseconds === null) {
    throw new RenderRepositoryFault('output_invalid')
  }
  return expectedEndTicks * info.timestampScaleNanoseconds
}

function webmTimeQuantizationToleranceNanoseconds(info: WebmInfoContract): bigint {
  return info.timestampScaleNanoseconds > 1_000n ? info.timestampScaleNanoseconds : 1_000n
}

function decodeEbmlUnsignedVint(bytes: Uint8Array): { value: number; length: number } {
  const length = ebmlVintLength(bytes[0], 8)
  if (bytes.byteLength < length) throw new RenderRepositoryFault('output_invalid')
  const marker = 0x80 >> (length - 1)
  let value = bytes[0] & (marker - 1)
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[index]
  if (!Number.isSafeInteger(value) || value <= 0) throw new RenderRepositoryFault('output_invalid')
  return { value, length }
}

function resolveWorkspaceArtifactPath(context: RepositoryContext, workspacePath: string): string {
  if (!isCanonicalWorkspacePath(workspacePath)) throw new RenderRepositoryFault('unsafe_workspace')
  const path = join(context.workspaceRoot, ...workspacePath.split('/'))
  assertContained(context.outputRoot, path)
  return path
}

async function resolveSafeWorkspaceFile(context: RepositoryContext, workspacePath: string): Promise<string> {
  if (!isCanonicalWorkspacePath(workspacePath)) throw new RenderRepositoryFault('unsafe_workspace')
  const path = join(context.workspaceRoot, ...workspacePath.split('/'))
  assertContained(context.workspaceRoot, path)
  if (path === context.outputRoot || isContained(context.outputRoot, path)) throw new RenderRepositoryFault('unsafe_workspace')
  await assertNoSymlinkPath(context.workspaceRoot, path)
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new RenderRepositoryFault('unsafe_workspace')
  if (resolve(await realpath(path)) !== resolve(path)) throw new RenderRepositoryFault('unsafe_workspace')
  return path
}

async function copyPinnedFile(
  context: RepositoryContext,
  sourcePath: string,
  destinationPath: string,
  maximumBytes: number,
  syncDirectory?: WorldRenderOutputRepositoryOptions['syncDirectory'],
): Promise<{ size: number; sha256: string }> {
  const source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const sourceBefore = await source.stat()
  if (!sourceBefore.isFile() || sourceBefore.nlink !== 1) {
    await source.close()
    throw new RenderRepositoryFault('unsafe_workspace')
  }
  if (sourceBefore.size <= 0 || sourceBefore.size > maximumBytes) {
    await source.close()
    throw new RenderRepositoryFault('output_invalid')
  }
  const temporaryPath = temporarySibling(destinationPath)
  const destination = await open(temporaryPath, 'wx', 0o600)
  let size = 0
  const hash = createHash('sha256')
  try {
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      let position = 0
      while (true) {
        const result = await source.read(buffer, 0, buffer.length, position)
        if (!result.bytesRead) break
        const chunk = buffer.subarray(0, result.bytesRead)
        await writeAll(destination, chunk)
        hash.update(chunk)
        size += result.bytesRead
        if (!Number.isSafeInteger(size) || size > maximumBytes) throw new RenderRepositoryFault('output_invalid')
        position += result.bytesRead
      }
      if (size === 0) throw new RenderRepositoryFault('output_invalid')
      const sourceAfter = await source.stat()
      if (sourceBefore.dev !== sourceAfter.dev || sourceBefore.ino !== sourceAfter.ino
        || sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs
        || sourceBefore.ctimeMs !== sourceAfter.ctimeMs || sourceAfter.nlink !== 1) {
        throw new RenderRepositoryFault('unsafe_workspace')
      }
      await destination.sync()
    } finally {
      await Promise.allSettled([source.close(), destination.close()])
    }
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
  try {
    await rename(temporaryPath, destinationPath)
    await syncDirectoryWith(dirname(destinationPath), syncDirectory)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
  const info = await lstat(destinationPath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== size) {
    throw new RenderRepositoryFault('unsafe_workspace')
  }
  assertContained(context.outputRoot, destinationPath)
  return { size, sha256: hash.digest('hex') }
}

async function writeOwnedArtifact(
  context: RepositoryContext,
  path: string,
  data: WorldRenderArtifactInput,
  maximumBytes: number,
  syncDirectory?: WorldRenderOutputRepositoryOptions['syncDirectory'],
): Promise<StoredArtifact> {
  assertContained(context.outputRoot, path)
  await ensureSafeDirectory(dirname(path), false)
  await rejectPathIfPresent(path)
  const temporaryPath = temporarySibling(path)
  const handle = await open(temporaryPath, 'wx', 0o600)
  let size = 0
  const hash = createHash('sha256')
  try {
    for await (const raw of artifactChunks(data)) {
      const chunk = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
      if (!chunk.length) continue
      size += chunk.length
      if (!Number.isSafeInteger(size) || size > maximumBytes) throw new RenderRepositoryFault('output_invalid')
      await writeAll(handle, chunk)
      hash.update(chunk)
    }
    if (size === 0) throw new RenderRepositoryFault('output_invalid')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporaryPath, { force: true })
    throw error
  }
  await handle.close()
  await rename(temporaryPath, path)
  await syncDirectoryWith(dirname(path), syncDirectory)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== size) {
    throw new RenderRepositoryFault('unsafe_workspace')
  }
  return { workspacePath: workspaceRelativePath(context, path), size, sha256: hash.digest('hex') }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (bytesWritten <= 0) throw new RenderRepositoryFault('write_failed', true)
    offset += bytesWritten
  }
}

async function writeAllPositioned(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
  positionedWrite: WorldRenderOutputRepositoryOptions['positionedWrite'],
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = positionedWrite
      ? await positionedWrite(handle, bytes, offset, bytes.byteLength - offset, position + offset)
      : await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0
      || result.bytesWritten > bytes.byteLength - offset) {
      throw new RenderRepositoryFault('write_failed', true)
    }
    offset += result.bytesWritten
  }
}

async function readVerifiedArtifactRange(
  path: string,
  expectedSize: number,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfRepositoryAborted(signal)
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 1
    || position + length > expectedSize) throw new RenderRepositoryFault('invalid_request')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedSize) {
      throw new RenderRepositoryFault('unsafe_workspace')
    }
    const bytes = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      throwIfRepositoryAborted(signal)
      const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset)
      if (bytesRead <= 0) throw new RenderRepositoryFault('output_invalid')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) {
      throw new RenderRepositoryFault('unsafe_workspace')
    }
    throwIfRepositoryAborted(signal)
    return bytes
  } finally {
    await handle.close()
  }
}

function mergeCoverage(
  existing: readonly WorldWebmCoverageInterval[],
  start: number,
  end: number,
): WorldWebmCoverageInterval[] {
  const merged: WorldWebmCoverageInterval[] = []
  let next = { start, end }
  for (const interval of existing) {
    if (interval.end < next.start) merged.push({ ...interval })
    else if (next.end < interval.start) {
      merged.push(next)
      next = { ...interval }
    } else {
      next = { start: Math.min(next.start, interval.start), end: Math.max(next.end, interval.end) }
    }
  }
  merged.push(next)
  return merged
}

function hasCompleteCoverage(coverage: readonly WorldWebmCoverageInterval[], extent: number): boolean {
  return coverage.length === 1 && coverage[0].start === 0 && coverage[0].end === extent
}

function observeInitialWebmFile(fd: number, info: BigIntStats): WorldWebmFileIdentity {
  if (!Number.isSafeInteger(fd) || fd <= 2 || !info.isFile() || info.nlink !== 1n || info.size !== 0n
    || (process.platform !== 'win32' && (info.mode & 0o7777n) !== 0o600n)) {
    throw new RenderRepositoryFault('unsafe_workspace')
  }
  return { dev: info.dev, ino: info.ino, mode: info.mode }
}

function assertSameWebmFile(
  identity: WorldWebmFileIdentity,
  info: BigIntStats,
  expectedSize?: bigint,
): void {
  if (!info.isFile() || info.nlink !== 1n || info.dev !== identity.dev || info.ino !== identity.ino
    || info.mode !== identity.mode || (expectedSize !== undefined && info.size !== expectedSize)
    || info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RenderRepositoryFault('unsafe_workspace')
  }
}

function assertWebmIdentity(jobId: string, generation: string): void {
  if (!isWorldRenderJobId(jobId) || !/^[a-f0-9]{32}$/.test(generation)) {
    throw new RenderRepositoryFault('invalid_request')
  }
}

function throwIfWebmSinkUnavailable(sink: ActiveWorldWebmSink, signal?: AbortSignal): void {
  if (sink.cancelled || signal?.aborted) throw abortError('World WebM assembly was cancelled.')
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function unwrapWebmInternalResult<T>(result: WorldRenderResult<T>): T {
  if (!result.ok) throw new RenderRepositoryFault(result.error.code, result.error.retryable)
  return result.value
}

function sameStoredArtifact(left: StoredArtifact | null, right: StoredArtifact): boolean {
  return left?.workspacePath === right.workspacePath && left.size === right.size && left.sha256 === right.sha256
}

function cancellationStateFrom(
  state: StoredJobV1,
  status: 'cancel_requested' | 'cancelled',
  updatedAt: string,
): StoredJobV1 {
  return {
    ...state,
    status,
    outputs: { ...state.outputs, renderManifest: null, webm: null },
    error: null,
    updatedAt,
  }
}

function cancellationIntentStageIndex(stage: CancellationIntentStage): number {
  const index = CANCELLATION_INTENT_STAGES.indexOf(stage)
  if (index < 0) throw new RenderRepositoryFault('recovery_failed', true)
  return index
}

function cancellationIntentAuthoritySha256(authority: CancellationIntentAuthority): string {
  return sha256(encodeJson(authority))
}

function manifestPublicationIntentStageIndex(stage: ManifestPublicationIntentStage): number {
  const index = MANIFEST_PUBLICATION_INTENT_STAGES.indexOf(stage)
  if (index < 0) throw new RenderRepositoryFault('recovery_failed', true)
  return index
}

function manifestPublicationIntentAuthoritySha256(authority: ManifestPublicationIntentAuthority): string {
  return sha256(encodeJson(authority))
}

async function validateManifestPublicationIntent(
  context: RepositoryContext,
  jobRoot: string,
  state: StoredJobV1,
  intent: ManifestPublicationIntentV1,
): Promise<void> {
  const {
    schema: _schema,
    stage: _stage,
    authoritySha256,
    ...authority
  } = intent
  if (authoritySha256 !== manifestPublicationIntentAuthoritySha256(authority)
    || intent.jobId !== state.jobId || intent.revision !== state.request.expectedRevision
    || intent.snapshotSha256 !== state.snapshot.sha256
    || intent.sourceStateSha256 !== sha256(encodeStoredState(state))) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const expectedArtifact = artifactFor(
    context,
    join(jobRoot, WORLD_RENDER_MANIFEST_FILENAME),
    renderManifestBytes(state),
  )
  if (!sameStoredArtifact(intent.artifact, expectedArtifact)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }

  try {
    const receipt = parseArtifactReceipt(
      parseJsonBuffer(await readBounded(artifactReceiptPath(jobRoot, 'render-manifest', null), 16_384)),
      state.jobId,
    )
    if (receipt.kind !== 'render-manifest' || !sameStoredArtifact(receipt.artifact, intent.artifact)) {
      throw new RenderRepositoryFault('recovery_failed', true)
    }
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') {
      if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
      throw new RenderRepositoryFault('recovery_failed', true)
    }
  }

  try {
    await verifyArtifact(context, intent.artifact)
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') {
      if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
      throw new RenderRepositoryFault('recovery_failed', true)
    }
  }
}

async function validateCancellationIntent(
  context: RepositoryContext,
  jobRoot: string,
  state: StoredJobV1,
  intent: CancellationIntentV1,
): Promise<void> {
  const {
    schema: _schema,
    stage: _stage,
    authoritySha256,
    ...authority
  } = intent
  if (authoritySha256 !== cancellationIntentAuthoritySha256(authority)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if (intent.jobId !== state.jobId || intent.revision !== state.request.expectedRevision
    || intent.snapshotSha256 !== state.snapshot.sha256) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const stageIndex = cancellationIntentStageIndex(intent.stage)
  const currentHash = sha256(encodeStoredState(state))
  if (![intent.sourceStateSha256, intent.requestedStateSha256, intent.cancelledStateSha256].includes(currentHash)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if (intent.webm?.workspacePath !== undefined
    && intent.webm.workspacePath !== workspaceRelativePath(context, join(jobRoot, 'output.webm'))) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if (intent.renderManifest?.workspacePath !== undefined
    && intent.renderManifest.workspacePath !== workspaceRelativePath(context, join(jobRoot, WORLD_RENDER_MANIFEST_FILENAME))) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const requested = cancellationStateFrom(state, 'cancel_requested', intent.updatedAt)
  const cancelled = cancellationStateFrom(state, 'cancelled', intent.updatedAt)
  if (sha256(encodeStoredState(requested)) !== intent.requestedStateSha256
    || sha256(encodeStoredState(cancelled)) !== intent.cancelledStateSha256) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }

  const manifestPresent = await validateCancellationArtifactAuthority(
    context,
    jobRoot,
    state.jobId,
    'render-manifest',
    intent.renderManifest,
    stageIndex >= cancellationIntentStageIndex('manifest-receipt-removal-authorized'),
    stageIndex >= cancellationIntentStageIndex('manifest-removal-authorized'),
  )
  await validateCancellationArtifactAuthority(
    context,
    jobRoot,
    state.jobId,
    'webm',
    intent.webm,
    stageIndex >= cancellationIntentStageIndex('webm-receipt-removal-authorized')
      || Boolean(intent.webm && !sameStoredArtifact(state.outputs.webm, intent.webm)),
    stageIndex >= cancellationIntentStageIndex('webm-removal-authorized'),
  )
  if (manifestPresent && intent.renderManifest) {
    await validateCancellationManifestBinding(context, state, intent)
  }
}

async function validateCancellationArtifactAuthority(
  context: RepositoryContext,
  jobRoot: string,
  jobId: string,
  kind: 'render-manifest' | 'webm',
  artifact: StoredArtifact | null,
  receiptMayBeMissing: boolean,
  fileMayBeMissing: boolean,
): Promise<boolean> {
  const receiptPath = artifactReceiptPath(jobRoot, kind, null)
  try {
    const receipt = parseArtifactReceipt(parseJsonBuffer(await readBounded(receiptPath, 16_384)), jobId)
    if (!artifact || receipt.kind !== kind || !sameStoredArtifact(receipt.artifact, artifact)) {
      throw new RenderRepositoryFault('recovery_failed', true)
    }
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT' || (!receiptMayBeMissing && artifact !== null)) {
      if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
      throw new RenderRepositoryFault('recovery_failed', true)
    }
  }

  const expectedPath = join(jobRoot, kind === 'webm' ? 'output.webm' : WORLD_RENDER_MANIFEST_FILENAME)
  if (!artifact) {
    try {
      await lstat(expectedPath)
      throw new RenderRepositoryFault('recovery_failed', true)
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return false
      throw error
    }
  }
  try {
    await verifyArtifact(context, artifact)
    return true
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT' && fileMayBeMissing) return false
    if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
    throw new RenderRepositoryFault('recovery_failed', true)
  }
}

async function validateCancellationManifestBinding(
  context: RepositoryContext,
  state: StoredJobV1,
  intent: CancellationIntentV1,
): Promise<void> {
  if (!intent.renderManifest) throw new RenderRepositoryFault('recovery_failed', true)
  const record = requireExactRecord(parseJsonBuffer(await readBounded(
    resolveWorkspaceArtifactPath(context, intent.renderManifest.workspacePath),
    WORLD_RENDER_ARTIFACT_MAX_BYTES.renderManifest,
  )), [
    'schema', 'jobId', 'snapshotSha256', 'projectId', 'revision', 'sceneId', 'sequenceId', 'preset',
    'duration', 'frameCount', 'frames', 'audio', 'webm',
  ])
  if (record.schema !== WORLD_RENDER_MANIFEST_SCHEMA || record.jobId !== state.jobId
    || record.snapshotSha256 !== state.snapshot.sha256 || record.projectId !== state.projectId
    || record.revision !== state.request.expectedRevision || record.sceneId !== state.request.sceneId
    || record.sequenceId !== state.request.sequenceId || record.frameCount !== state.frameCount
    || stableSerialize(record.preset) !== stableSerialize(state.request.preset)
    || stableSerialize(record.duration) !== stableSerialize(state.duration)
    || stableSerialize(record.webm) !== stableSerialize(intent.webm)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
}

function webmSinkIdentityKey(jobId: string, generation: string, sinkId: string): string {
  return `${jobId}:${generation}:${sinkId}`
}

function webmPlanMatchesState(plan: WorldWebmStartPayload, state: StoredJobV1): boolean {
  if (!plan || typeof plan !== 'object' || plan.width !== state.request.preset.width
    || plan.height !== state.request.preset.height || plan.fps !== state.request.preset.fps
    || plan.frameCount !== state.frameCount || plan.audioBitrate !== 128_000
    || !Number.isSafeInteger(plan.videoBitrate) || plan.videoBitrate < 500_000 || plan.videoBitrate > 80_000_000
    || plan.duration.numerator !== state.duration.numerator || plan.duration.denominator !== state.duration.denominator) return false
  const expectedFrames = enumerateWorldFrames(state.duration, state.request.preset.fps, WORLD_RENDER_MAX_FRAME_COUNT)
  if (plan.frameDurations.length !== expectedFrames.length
    || expectedFrames.some((frame, index) => {
      const duration = plan.frameDurations[index]
      return !duration || compareWorldRationalTime(duration, frame.duration) !== 0
    })) return false
  const samples = BigInt(state.duration.numerator) * 48_000n / BigInt(state.duration.denominator)
  return samples === BigInt(plan.audioSampleCount)
}

function webmVerificationPlanFromState(state: StoredJobV1): WebmVerificationPlan {
  const audioSampleCount = BigInt(state.duration.numerator) * 48_000n
    / BigInt(state.duration.denominator)
  if (audioSampleCount < 1n || audioSampleCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RenderRepositoryFault('output_invalid')
  }
  return {
    width: state.request.preset.width,
    height: state.request.preset.height,
    fps: state.request.preset.fps,
    frameCount: state.frameCount,
    duration: { ...state.duration },
    frameDurations: enumerateWorldFrames(
      state.duration,
      state.request.preset.fps,
      WORLD_RENDER_MAX_FRAME_COUNT,
    ).map((frame) => ({ ...frame.duration })),
    audioSampleCount: Number(audioSampleCount),
  }
}

async function* artifactChunks(data: WorldRenderArtifactInput): AsyncIterable<Uint8Array> {
  if (data instanceof Uint8Array) {
    yield data
    return
  }
  if (!data || typeof data[Symbol.asyncIterator] !== 'function') throw new RenderRepositoryFault('invalid_request')
  for await (const chunk of data) {
    if (!(chunk instanceof Uint8Array)) throw new RenderRepositoryFault('output_invalid')
    yield chunk
  }
}

async function atomicWriteBytes(
  path: string,
  bytes: Uint8Array,
  syncDirectory?: WorldRenderOutputRepositoryOptions['syncDirectory'],
): Promise<void> {
  await ensureSafeDirectory(dirname(path), false)
  await rejectSymlinkOrHardlinkIfPresent(path)
  const temporaryPath = temporarySibling(path)
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporaryPath, { force: true })
    throw error
  }
  await handle.close()
  await rename(temporaryPath, path)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new RenderRepositoryFault('unsafe_workspace')
  await syncDirectoryWith(dirname(path), syncDirectory)
}

async function createJobDirectories(jobRoot: string): Promise<void> {
  for (const path of [
    join(jobRoot, '.modly'),
    join(jobRoot, '.modly', 'artifacts'),
    join(jobRoot, 'snapshot'),
    join(jobRoot, 'snapshot', 'resources'),
    join(jobRoot, 'frames'),
    join(jobRoot, 'audio'),
  ]) await ensureSafeDirectory(path, true)
}

async function ensureSafeDirectoryPath(root: string, target: string): Promise<void> {
  const candidate = relative(root, target)
  if (!candidate || candidate === '.') return
  if (candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) throw new RenderRepositoryFault('unsafe_workspace')
  let current = root
  for (const segment of candidate.split(sep)) {
    current = join(current, segment)
    await ensureSafeDirectory(current, true)
  }
}

async function ensureSafeDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: false, mode: 0o700 }).catch((error) => {
    if (nodeErrorCode(error) !== 'EEXIST') throw error
  })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new RenderRepositoryFault('unsafe_workspace')
  if (resolve(await realpath(path)) !== resolve(path)) throw new RenderRepositoryFault('unsafe_workspace')
}

/**
 * Distinguishes a missing canonical path from ENOENT produced below a symlink.
 * A successful check is observational only; every later write resolves and
 * validates the root again, so this check is never used as mutation authority.
 */
async function assertGenuinelyAbsentDirectoryPath(path: string, boundary?: string): Promise<void> {
  const target = resolve(path)
  const confinementRoot = boundary ? resolve(boundary) : null
  if (confinementRoot && target !== confinementRoot && !isContained(confinementRoot, target)) {
    throw new RenderRepositoryFault('unsafe_workspace')
  }

  let current = target
  const missingPaths: string[] = []
  while (true) {
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (nodeErrorCode(error) !== 'ENOENT') throw error
      if (missingPaths.length >= MAX_ABSENCE_PATH_SEGMENTS) {
        throw new RenderRepositoryFault('unsafe_workspace')
      }
      missingPaths.push(current)
      const parent = dirname(current)
      if (parent === current || (confinementRoot && current === confinementRoot)) {
        throw new RenderRepositoryFault('unsafe_workspace')
      }
      current = parent
      if (confinementRoot && current !== confinementRoot && !isContained(confinementRoot, current)) {
        throw new RenderRepositoryFault('unsafe_workspace')
      }
      continue
    }

    if (info.isSymbolicLink() || !info.isDirectory()) throw new RenderRepositoryFault('unsafe_workspace')
    let canonicalCurrent: string
    try { canonicalCurrent = resolve(await realpath(current)) } catch { throw new RenderRepositoryFault('unsafe_workspace') }
    if (canonicalCurrent !== current) throw new RenderRepositoryFault('unsafe_workspace')
    // The original target appeared after realpath reported ENOENT. Fail closed
    // rather than misclassifying that race as a genuinely absent repository.
    if (current === target) throw new RenderRepositoryFault('unsafe_workspace')

    let ancestorHandle: FileHandle
    try { ancestorHandle = await open(current, constants.O_RDONLY) } catch { throw new RenderRepositoryFault('unsafe_workspace') }
    try {
      const initialObservation = directoryObservation(info)
      const anchoredObservation = await observeAnchoredDirectoryPath(current, ancestorHandle)
      if (!sameDirectoryObservation(initialObservation, anchoredObservation)) {
        throw new RenderRepositoryFault('unsafe_workspace')
      }

      // The upward walk is only a first observation. Recheck every path it saw
      // missing, including the original target, after anchoring the ancestor.
      await assertPathsRemainAbsent(missingPaths)
      if (!sameDirectoryObservation(
        anchoredObservation,
        await observeAnchoredDirectoryPath(current, ancestorHandle),
      )) throw new RenderRepositoryFault('unsafe_workspace')

      // A fixed second confirmation closes a race inside the first recheck.
      // The final anchored check is the linearization point: path identity and
      // directory metadata must still match the open handle after the scan.
      await assertPathsRemainAbsent(missingPaths)
      if (!sameDirectoryObservation(
        anchoredObservation,
        await observeAnchoredDirectoryPath(current, ancestorHandle),
      )) throw new RenderRepositoryFault('unsafe_workspace')
      return
    } finally {
      await ancestorHandle.close().catch(() => undefined)
    }
  }
}

async function assertPathsRemainAbsent(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await lstat(path)
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') continue
      throw new RenderRepositoryFault('unsafe_workspace')
    }
    throw new RenderRepositoryFault('unsafe_workspace')
  }
}

async function observeAnchoredDirectoryPath(path: string, handle: FileHandle): Promise<DirectoryObservation> {
  let before: Stats
  let pathInfo: Stats
  let canonicalPath: string
  let after: Stats
  try {
    before = await handle.stat()
    pathInfo = await lstat(path)
    canonicalPath = resolve(await realpath(path))
    after = await handle.stat()
  } catch {
    throw new RenderRepositoryFault('unsafe_workspace')
  }
  const beforeObservation = directoryObservation(before)
  const pathObservation = directoryObservation(pathInfo)
  const afterObservation = directoryObservation(after)
  if (!before.isDirectory() || pathInfo.isSymbolicLink() || !pathInfo.isDirectory() || !after.isDirectory()
    || canonicalPath !== resolve(path)
    || !sameDirectoryObservation(beforeObservation, pathObservation)
    || !sameDirectoryObservation(beforeObservation, afterObservation)) {
    throw new RenderRepositoryFault('unsafe_workspace')
  }
  return afterObservation
}

function directoryObservation(info: Stats): DirectoryObservation {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  }
}

function sameDirectoryObservation(left: DirectoryObservation, right: DirectoryObservation): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs && left.birthtimeMs === right.birthtimeMs
}

async function assertNoSymlinkPath(root: string, path: string): Promise<void> {
  const candidate = relative(root, path)
  if (candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) throw new RenderRepositoryFault('unsafe_workspace')
  let current = root
  for (const segment of candidate.split(sep)) {
    current = join(current, segment)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new RenderRepositoryFault('unsafe_workspace')
  }
}

async function assertSafeTree(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new RenderRepositoryFault('unsafe_workspace')
  if (info.isFile()) {
    if (info.nlink !== 1) throw new RenderRepositoryFault('unsafe_workspace')
    return
  }
  if (!info.isDirectory()) throw new RenderRepositoryFault('unsafe_workspace')
  for (const entry of await readdir(path)) await assertSafeTree(join(path, entry))
}

async function cleanupTemporaryFiles(jobRoot: string, preservedPaths: ReadonlySet<string>): Promise<void> {
  await walkSafe(jobRoot, async (path, info) => {
    if (info.isFile() && basename(path).endsWith('.tmp') && !preservedPaths.has(path)) {
      if (info.nlink !== 1) throw new RenderRepositoryFault('unsafe_workspace')
      await rm(path, { force: true })
    }
  })
}

async function cleanupUnrecordedArtifacts(
  jobRoot: string,
  state: StoredJobV1,
  preserveProvisionalWebm = false,
): Promise<void> {
  const keepFrames = new Set(state.outputs.frames.map((frame) => basename(frame.workspacePath)))
  for (const entry of await readdir(join(jobRoot, 'frames'), { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new RenderRepositoryFault('unsafe_workspace')
    if (!FRAME_NAME_PATTERN.test(entry.name) || !keepFrames.has(entry.name)) await safeRemoveSingleFile(join(jobRoot, 'frames', entry.name))
  }
  const owned = [
    { path: join(jobRoot, 'audio', 'master.wav'), keep: Boolean(state.outputs.audio) },
    { path: join(jobRoot, WORLD_RENDER_MANIFEST_FILENAME), keep: Boolean(state.outputs.renderManifest) },
    { path: join(jobRoot, 'output.webm'), keep: Boolean(state.outputs.webm) || preserveProvisionalWebm },
  ]
  for (const candidate of owned) if (!candidate.keep) await safeRemoveSingleFile(candidate.path, true)
}

async function walkSafe(
  path: string,
  visit: (path: string, info: Awaited<ReturnType<typeof lstat>>) => Promise<void>,
): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new RenderRepositoryFault('unsafe_workspace')
  await visit(path, info)
  if (!info.isDirectory()) return
  for (const entry of await readdir(path)) await walkSafe(join(path, entry), visit)
}

async function safeRemoveSingleFile(path: string, optional = false): Promise<void> {
  let info
  try { info = await lstat(path) } catch (error) {
    if (optional && nodeErrorCode(error) === 'ENOENT') return
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new RenderRepositoryFault('unsafe_workspace')
  await rm(path, { force: true })
  await rejectPathIfPresent(path)
}

async function safeRemoveUnpublishedJob(outputRoot: string, jobRoot: string): Promise<void> {
  try {
    assertContained(outputRoot, jobRoot)
    await assertSafeTree(jobRoot)
    await rm(jobRoot, { recursive: true, force: true })
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error
  }
}

async function rejectPathIfPresent(path: string): Promise<void> {
  try {
    await lstat(path)
    throw new RenderRepositoryFault('output_invalid')
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return
    throw error
  }
}

async function rejectSymlinkOrHardlinkIfPresent(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new RenderRepositoryFault('unsafe_workspace')
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return
    throw error
  }
}

async function tryReadState(path: string, jobId: string): Promise<{ state: StoredJobV1; sha256: string } | null> {
  try {
    const bytes = await readBounded(path, MAX_JSON_BYTES)
    return { state: parseStoredJob(parseJsonBuffer(bytes), jobId), sha256: sha256(bytes) }
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return null
    if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
    return null
  }
}

async function tryReadJournal(path: string, jobId: string): Promise<JournalV1 | null> {
  try {
    const record = requireExactRecord(parseJsonBuffer(await readBounded(path, 8_192)), [
      'schema', 'jobId', 'previousSha256', 'nextSha256',
    ])
    if (record.schema !== JOURNAL_SCHEMA || record.jobId !== jobId
      || typeof record.previousSha256 !== 'string' || !SHA256_PATTERN.test(record.previousSha256)
      || typeof record.nextSha256 !== 'string' || !SHA256_PATTERN.test(record.nextSha256)) {
      throw new RenderRepositoryFault('recovery_failed', true)
    }
    return record as unknown as JournalV1
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return null
    if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
    throw new RenderRepositoryFault('recovery_failed', true)
  }
}

async function tryReadManifestPublicationIntent(
  jobRoot: string,
  jobId: string,
): Promise<ManifestPublicationIntentV1 | null> {
  try {
    const record = requireExactRecord(
      parseJsonBuffer(await readBounded(join(jobRoot, MANIFEST_PUBLICATION_INTENT_FILE), 32 * 1024)),
      [
        'schema', 'stage', 'authoritySha256', 'jobId', 'revision', 'snapshotSha256',
        'sourceStateSha256', 'artifact',
      ],
    )
    if (record.schema !== MANIFEST_PUBLICATION_INTENT_SCHEMA || record.jobId !== jobId
      || !MANIFEST_PUBLICATION_INTENT_STAGES.includes(record.stage as ManifestPublicationIntentStage)
      || typeof record.authoritySha256 !== 'string' || !SHA256_PATTERN.test(record.authoritySha256)
      || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
      || typeof record.snapshotSha256 !== 'string' || !SHA256_PATTERN.test(record.snapshotSha256)
      || typeof record.sourceStateSha256 !== 'string' || !SHA256_PATTERN.test(record.sourceStateSha256)) {
      throw new RenderRepositoryFault('recovery_failed', true)
    }
    return {
      schema: MANIFEST_PUBLICATION_INTENT_SCHEMA,
      stage: record.stage as ManifestPublicationIntentStage,
      authoritySha256: record.authoritySha256,
      jobId,
      revision: record.revision as number,
      snapshotSha256: record.snapshotSha256,
      sourceStateSha256: record.sourceStateSha256,
      artifact: parseArtifact(record.artifact),
    }
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return null
    if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
    throw new RenderRepositoryFault('recovery_failed', true)
  }
}

async function tryReadCancellationIntent(
  jobRoot: string,
  jobId: string,
): Promise<CancellationIntentV1 | null> {
  try {
    const record = requireExactRecord(
      parseJsonBuffer(await readBounded(join(jobRoot, CANCELLATION_INTENT_FILE), 64 * 1024)),
      [
        'schema', 'stage', 'authoritySha256', 'jobId', 'revision', 'snapshotSha256', 'sourceStateSha256',
        'requestedStateSha256', 'cancelledStateSha256', 'updatedAt', 'renderManifest', 'webm',
      ],
    )
    if (record.schema !== CANCELLATION_INTENT_SCHEMA || record.jobId !== jobId
      || !CANCELLATION_INTENT_STAGES.includes(record.stage as CancellationIntentStage)
      || typeof record.authoritySha256 !== 'string' || !SHA256_PATTERN.test(record.authoritySha256)
      || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
      || typeof record.snapshotSha256 !== 'string' || !SHA256_PATTERN.test(record.snapshotSha256)
      || typeof record.sourceStateSha256 !== 'string' || !SHA256_PATTERN.test(record.sourceStateSha256)
      || typeof record.requestedStateSha256 !== 'string' || !SHA256_PATTERN.test(record.requestedStateSha256)
      || typeof record.cancelledStateSha256 !== 'string' || !SHA256_PATTERN.test(record.cancelledStateSha256)
      || !isTimestamp(record.updatedAt)) {
      throw new RenderRepositoryFault('recovery_failed', true)
    }
    return {
      schema: CANCELLATION_INTENT_SCHEMA,
      stage: record.stage as CancellationIntentStage,
      authoritySha256: record.authoritySha256,
      jobId,
      revision: record.revision as number,
      snapshotSha256: record.snapshotSha256,
      sourceStateSha256: record.sourceStateSha256,
      requestedStateSha256: record.requestedStateSha256,
      cancelledStateSha256: record.cancelledStateSha256,
      updatedAt: record.updatedAt,
      renderManifest: record.renderManifest === null ? null : parseArtifact(record.renderManifest),
      webm: record.webm === null ? null : parseArtifact(record.webm),
    }
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return null
    if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
    throw new RenderRepositoryFault('recovery_failed', true)
  }
}

async function readArtifactReceipts(
  jobRoot: string,
  jobId: string,
  expectedFrameCount: number,
): Promise<StoredJobV1['outputs']> {
  const directory = join(jobRoot, ARTIFACT_RECEIPT_DIRECTORY)
  await ensureSafeDirectory(directory, false)
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length > expectedFrameCount + 3) throw new RenderRepositoryFault('recovery_failed', true)
  const outputs: StoredJobV1['outputs'] = { frames: [], audio: null, renderManifest: null, webm: null }
  const frameIndexes = new Set<number>()
  for (const entry of entries.sort((left, right) => codeUnitCompare(left.name, right.name))) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new RenderRepositoryFault('unsafe_workspace')
    const path = join(directory, entry.name)
    const receipt = parseArtifactReceipt(parseJsonBuffer(await readBounded(path, 16_384)), jobId)
    if (entry.name !== artifactReceiptFilename(receipt.kind, receipt.index)) {
      throw new RenderRepositoryFault('recovery_failed', true)
    }
    if (receipt.kind === 'frame') {
      if (receipt.index >= expectedFrameCount || frameIndexes.has(receipt.index)) {
        throw new RenderRepositoryFault('recovery_failed', true)
      }
      frameIndexes.add(receipt.index)
      outputs.frames.push(receipt.artifact)
    } else {
      const key = receipt.kind === 'render-manifest' ? 'renderManifest' : receipt.kind
      if (outputs[key]) throw new RenderRepositoryFault('recovery_failed', true)
      outputs[key] = receipt.artifact
    }
  }
  outputs.frames.sort((left, right) => left.index - right.index)
  return outputs
}

async function hasMatchingWebmReceipt(
  jobRoot: string,
  jobId: string,
  artifact: StoredArtifact,
): Promise<boolean> {
  try {
    const receipt = parseArtifactReceipt(
      parseJsonBuffer(await readBounded(artifactReceiptPath(jobRoot, 'webm', null), 16_384)),
      jobId,
    )
    return receipt.kind === 'webm' && sameStoredArtifact(receipt.artifact, artifact)
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return false
    if (error instanceof RenderRepositoryFault && error.code === 'unsafe_workspace') throw error
    return false
  }
}

function parseArtifactReceipt(value: unknown, expectedJobId: string): ArtifactReceiptV1 {
  const record = requireExactRecord(value, ['schema', 'jobId', 'kind', 'index', 'artifact'])
  if (record.schema !== ARTIFACT_RECEIPT_SCHEMA || record.jobId !== expectedJobId) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if (record.kind === 'frame') {
    const artifact = parseFrameArtifact(record.artifact)
    if (record.index !== artifact.index) throw new RenderRepositoryFault('recovery_failed', true)
    return {
      schema: ARTIFACT_RECEIPT_SCHEMA,
      jobId: expectedJobId,
      kind: 'frame',
      index: artifact.index,
      artifact,
    }
  }
  if ((record.kind === 'audio' || record.kind === 'render-manifest' || record.kind === 'webm')
    && record.index === null) {
    return {
      schema: ARTIFACT_RECEIPT_SCHEMA,
      jobId: expectedJobId,
      kind: record.kind,
      index: null,
      artifact: parseArtifact(record.artifact),
    }
  }
  throw new RenderRepositoryFault('recovery_failed', true)
}

function artifactReceiptPath(
  jobRoot: string,
  kind: ArtifactReceiptV1['kind'],
  index: number | null,
): string {
  return join(jobRoot, ARTIFACT_RECEIPT_DIRECTORY, artifactReceiptFilename(kind, index))
}

function artifactReceiptFilename(kind: ArtifactReceiptV1['kind'], index: number | null): string {
  if (kind === 'frame') {
    if (index === null) throw new RenderRepositoryFault('invalid_request')
    return `${frameFilename(index).slice(0, -4)}.v1.json`
  }
  if (index !== null) throw new RenderRepositoryFault('invalid_request')
  return `${kind}.v1.json`
}

async function removeArtifactReceipt(
  jobRoot: string,
  kind: ArtifactReceiptV1['kind'],
  index: number | null,
): Promise<void> {
  await safeRemoveSingleFile(artifactReceiptPath(jobRoot, kind, index), true)
}

async function readBounded(path: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  throwIfRepositoryAborted(signal)
  const info = await lstat(path)
  throwIfRepositoryAborted(signal)
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > maximum) {
    throw new RenderRepositoryFault('unsafe_workspace')
  }
  const bytes = signal ? await readFile(path, { signal }) : await readFile(path)
  throwIfRepositoryAborted(signal)
  return bytes
}

async function readPinnedResourceBytes(
  path: string,
  expectedSize: number,
  expectedSha256: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  throwIfRepositoryAborted(signal)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    throwIfRepositoryAborted(signal)
    const before = await handle.stat()
    throwIfRepositoryAborted(signal)
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedSize
      || before.size < 1 || before.size > MAX_RENDERER_RESOURCE_BYTES) {
      throw new RenderRepositoryFault('unsafe_workspace')
    }
    const bytes = Buffer.allocUnsafe(expectedSize)
    const hash = createHash('sha256')
    const maximumChunk = 1024 * 1024
    let position = 0
    while (position < expectedSize) {
      throwIfRepositoryAborted(signal)
      const length = Math.min(maximumChunk, expectedSize - position)
      const { bytesRead } = await handle.read(bytes, position, length, position)
      throwIfRepositoryAborted(signal)
      if (bytesRead < 1) throw new RenderRepositoryFault('recovery_failed', true)
      hash.update(bytes.subarray(position, position + bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    throwIfRepositoryAborted(signal)
    if (!after.isFile() || after.nlink !== 1 || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino
      || hash.digest('hex') !== expectedSha256) {
      throw new RenderRepositoryFault('recovery_failed', true)
    }
    return bytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  throwIfRepositoryAborted(signal)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const hash = createHash('sha256')
  try {
    throwIfRepositoryAborted(signal)
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (true) {
      throwIfRepositoryAborted(signal)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      throwIfRepositoryAborted(signal)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const info = await handle.stat()
    throwIfRepositoryAborted(signal)
    if (!info.isFile() || info.nlink !== 1) throw new RenderRepositoryFault('unsafe_workspace')
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

function parseArtifact(value: unknown): StoredArtifact {
  const record = requireExactRecord(value, ['workspacePath', 'size', 'sha256'])
  if (!isCanonicalWorkspacePath(record.workspacePath) || !Number.isSafeInteger(record.size)
    || (record.size as number) <= 0 || typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  return { workspacePath: record.workspacePath as string, size: record.size as number, sha256: record.sha256 }
}

function parseFrameArtifact(value: unknown): StoredFrameArtifact {
  const record = requireExactRecord(value, ['workspacePath', 'size', 'sha256', 'index', 'time', 'timestampMicroseconds'])
  const artifact = parseArtifact({ workspacePath: record.workspacePath, size: record.size, sha256: record.sha256 })
  const index = requireInteger(record.index, 0, WORLD_RENDER_MAX_FRAME_COUNT - 1)
  const timestampMicroseconds = requireInteger(record.timestampMicroseconds, 0, Number.MAX_SAFE_INTEGER)
  return { ...artifact, index, time: parseRational(record.time), timestampMicroseconds }
}

function parsePinnedResource(value: unknown): WorldRenderPinnedResource {
  const record = requireExactRecord(value, ['resource', 'files'])
  if (!Array.isArray(record.files) || record.files.length < 1 || record.files.length > 3) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const files = record.files.map(parsePinnedResourceFile)
  if (new Set(files.map((file) => file.role)).size !== files.length) throw new RenderRepositoryFault('recovery_failed', true)
  return { resource: structuredClone(record.resource) as WorldResource, files }
}

function parsePinnedResourceFile(value: unknown): WorldRenderPinnedResourceFile {
  const record = requireExactRecord(value, ['role', 'originalWorkspacePath', 'workspacePath', 'size', 'sha256'])
  if (record.role !== 'primary' && record.role !== 'source' && record.role !== 'legacy') {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if (!isCanonicalWorkspacePath(record.originalWorkspacePath)) throw new RenderRepositoryFault('recovery_failed', true)
  return {
    role: record.role,
    originalWorkspacePath: record.originalWorkspacePath,
    ...parseArtifact({ workspacePath: record.workspacePath, size: record.size, sha256: record.sha256 }),
  }
}

function parseFramePlanDescriptor(value: unknown): WorldRenderFramePlanDescriptor {
  const record = requireExactRecord(value, ['fps', 'frameCount', 'sha256'])
  if (record.fps !== 24 && record.fps !== 25 && record.fps !== 30 && record.fps !== 60) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if (typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  return {
    fps: record.fps,
    frameCount: requireInteger(record.frameCount, 0, WORLD_RENDER_MAX_FRAME_COUNT),
    sha256: record.sha256,
  }
}

function parseProgress(value: unknown, frameCount: number): WorldRenderProgress {
  const record = requireExactRecord(value, ['phase', 'completedFrames', 'frameCount', 'completedUnits', 'totalUnits'])
  if (!PROGRESS_PHASES.has(record.phase as WorldRenderProgressPhase) || record.frameCount !== frameCount) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const progress: WorldRenderProgress = {
    phase: record.phase as WorldRenderProgressPhase,
    completedFrames: requireInteger(record.completedFrames, 0, frameCount),
    frameCount,
    completedUnits: requireInteger(record.completedUnits, 0, frameCount + 2),
    totalUnits: requireInteger(record.totalUnits, frameCount + 2, frameCount + 2),
  }
  if (progress.completedUnits > progress.totalUnits) throw new RenderRepositoryFault('recovery_failed', true)
  return progress
}

function validateProgressTruth(state: StoredJobV1): void {
  if (state.progress.completedFrames > state.outputs.frames.length) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if (state.status !== 'cancel_requested' && ACTIVE_STATUSES.has(state.status)
    && state.progress.phase !== state.status) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if ((state.progress.phase === 'rendering-audio' || state.progress.phase === 'assembling' || state.progress.phase === 'complete')
    && state.outputs.frames.length !== state.frameCount) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if ((state.progress.phase === 'assembling' || state.progress.phase === 'complete') && !state.outputs.audio) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if ((state.status === 'partial' || state.status === 'succeeded') && state.progress.phase !== 'complete') {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const needsError = state.status === 'failed' || state.status === 'partial' || state.status === 'recovery_failed'
  if (Boolean(state.error) !== needsError
    || (state.status === 'recovery_failed' && state.error?.code !== 'recovery_failed')) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if (state.status === 'partial'
    && (state.outputs.frames.length !== state.frameCount || !state.outputs.audio
      || !state.outputs.renderManifest || state.outputs.webm)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  if (state.status === 'succeeded'
    && (state.outputs.frames.length !== state.frameCount || !state.outputs.audio
      || !state.outputs.renderManifest || !state.outputs.webm)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
}

function parsePublicError(value: unknown): WorldRenderPublicError {
  const record = requireExactRecord(value, ['code', 'message', 'retryable', 'issues'])
  if (typeof record.code !== 'string' || !PUBLIC_ERROR_CODES.has(record.code as WorldRenderPublicErrorCode)
    || typeof record.message !== 'string' || typeof record.retryable !== 'boolean') {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const known = publicError(record.code as WorldRenderPublicErrorCode)
  if (record.issues !== undefined && (!Array.isArray(record.issues) || record.issues.length > 64)) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  const issues = record.issues?.map((value) => {
    const issue = requireExactRecord(value, ['code', 'path', 'message'])
    if (!isBoundedPublicText(issue.code, 128, false)
      || !isBoundedPublicText(issue.path, 1024, true)
      || !isBoundedPublicText(issue.message, 1024, false)) {
      throw new RenderRepositoryFault('recovery_failed', true)
    }
    return { code: issue.code, path: issue.path, message: issue.message }
  })
  return {
    ...known,
    ...(issues?.length ? { issues } : {}),
  }
}

function isBoundedPublicText(value: unknown, maximum: number, allowEmpty: boolean): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && value.length <= maximum
    && !value.includes('\0')
}

function parseRational(value: unknown): WorldSequence['duration'] {
  const record = requireExactRecord(value, ['numerator', 'denominator'])
  if (!Number.isSafeInteger(record.numerator) || !Number.isSafeInteger(record.denominator) || record.denominator === 0) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  try { return normalizeWorldRationalTime({ numerator: record.numerator as number, denominator: record.denominator as number }) }
  catch { throw new RenderRepositoryFault('recovery_failed', true) }
}

function requireExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RenderRepositoryFault('recovery_failed', true)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new RenderRepositoryFault('recovery_failed', true)
  return record
}

function requireInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RenderRepositoryFault('recovery_failed', true)
  }
  return value
}

function boundedByteLimit(value: number | undefined, maximum: number, label: string): number {
  const selected = value ?? maximum
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`)
  }
  return selected
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`${label} must be a safe integer between ${minimum} and ${maximum}.`)
  }
  return selected
}

function waitForOwnedCancellation<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    void operation.then((value) => finish(value), () => finish(null))
  })
}

function assertDurationBound(duration: WorldSequence['duration']): void {
  const normalized = normalizeWorldRationalTime(duration)
  if (normalized.numerator < 0 || compareWorldRationalTime(normalized, { numerator: WORLD_RENDER_MAX_DURATION_SECONDS, denominator: 1 }) > 0) {
    throw new RenderRepositoryFault('sequence_invalid')
  }
}

function sameFramePlan(left: readonly WorldFrameTime[], right: readonly WorldFrameTime[]): boolean {
  return left.length === right.length && left.every((frame, index) => {
    const candidate = right[index]
    return candidate?.index === frame.index
      && candidate.timestampMicroseconds === frame.timestampMicroseconds
      && compareWorldRationalTime(candidate.time, frame.time) === 0
      && compareWorldRationalTime(candidate.duration, frame.duration) === 0
  })
}

function describeFramePlan(
  frames: readonly WorldFrameTime[],
  fps: WorldRenderNormalizedCreateRequest['preset']['fps'],
): WorldRenderFramePlanDescriptor {
  return { fps, frameCount: frames.length, sha256: framePlanSha256(frames) }
}

function framePlanSha256(frames: readonly WorldFrameTime[]): string {
  const hash = createHash('sha256')
  hash.update('[')
  for (const [index, frame] of frames.entries()) {
    if (index) hash.update(',')
    hash.update(stableSerialize(frame))
  }
  hash.update(']')
  return hash.digest('hex')
}

function progressFor(
  phase: WorldRenderProgressPhase,
  completedFrames: number,
  frameCount: number,
  audioComplete = false,
): WorldRenderProgress {
  let completedUnits = completedFrames
  if (phase === 'queued' || phase === 'preflighting') completedUnits = 0
  else if (phase === 'rendering-audio') completedUnits = frameCount + (audioComplete ? 1 : 0)
  else if (phase === 'assembling') completedUnits = frameCount + 1
  else if (phase === 'complete') completedUnits = frameCount + 2
  return { phase, completedFrames, frameCount, completedUnits, totalUnits: frameCount + 2 }
}

function phaseRank(phase: WorldRenderProgressPhase): number {
  return ['queued', 'preflighting', 'rendering-frames', 'rendering-audio', 'assembling', 'complete'].indexOf(phase)
}

function isProgressUpdate(value: unknown, frameCount: number): value is WorldRenderProgressUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).every((key) => key === 'phase' || key === 'completedFrames')
    && ['preflighting', 'rendering-frames', 'rendering-audio', 'assembling'].includes(record.phase as string)
    && Number.isSafeInteger(record.completedFrames)
    && (record.completedFrames as number) >= 0
    && (record.completedFrames as number) <= frameCount
}

function assertWritableOutputState(state: StoredJobV1): void {
  if (TERMINAL_STATUSES.has(state.status) || state.status === 'cancel_requested') throw new RenderRepositoryFault('job_busy', true)
}

function publicError(code: WorldRenderPublicErrorCode): WorldRenderPublicError {
  const definitions: Record<WorldRenderPublicErrorCode, { message: string; retryable: boolean }> = {
    invalid_request: { message: 'World render request is invalid.', retryable: false },
    unauthorized: { message: 'World render request is unauthorized.', retryable: false },
    job_not_found: { message: 'World render job was not found.', retryable: false },
    project_not_found: { message: 'World project was not found.', retryable: false },
    revision_conflict: { message: 'World project revision changed.', retryable: true },
    scene_not_found: { message: 'World scene was not found.', retryable: false },
    sequence_not_found: { message: 'World sequence was not found.', retryable: false },
    sequence_invalid: { message: 'World sequence cannot be rendered.', retryable: false },
    executor_unavailable: { message: 'World render executor is unavailable.', retryable: true },
    job_busy: { message: 'World render job is busy.', retryable: true },
    unsafe_workspace: { message: 'World render workspace is unsafe.', retryable: false },
    output_invalid: { message: 'World render output is incomplete or invalid.', retryable: false },
    recovery_failed: { message: 'World render recovery failed.', retryable: true },
    write_failed: { message: 'World render output could not be saved.', retryable: true },
    internal_error: { message: 'World render operation failed.', retryable: true },
  }
  return { code, ...definitions[code] }
}

function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function failure(code: WorldRenderPublicErrorCode): { ok: false; error: WorldRenderPublicError } {
  return { ok: false, error: publicError(code) }
}

function failureFrom(error: unknown): { ok: false; error: WorldRenderPublicError } {
  if (error instanceof RenderRepositoryFault) return { ok: false, error: publicError(error.code) }
  if (nodeErrorCode(error) === 'ENOENT') return failure('job_not_found')
  return failure('write_failed')
}

function artifactFor(context: RepositoryContext, path: string, bytes: Uint8Array): StoredArtifact {
  return { workspacePath: workspaceRelativePath(context, path), size: bytes.byteLength, sha256: sha256(bytes) }
}

function workspaceRelativePath(context: RepositoryContext, path: string): string {
  const candidate = relative(context.workspaceRoot, path).split(sep).join('/')
  if (!isCanonicalWorkspacePath(candidate)) throw new RenderRepositoryFault('unsafe_workspace')
  return candidate
}

function jobRootFor(context: RepositoryContext, jobId: string): string {
  if (!isWorldRenderJobId(jobId)) throw new RenderRepositoryFault('invalid_request')
  const path = join(context.outputRoot, jobId)
  assertContained(context.outputRoot, path)
  return path
}

function repositoryCacheKey(context: RepositoryContext, jobId: string): string {
  return jobRootFor(context, jobId)
}

function frameFilename(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 999_999) throw new RenderRepositoryFault('invalid_request')
  return `frame-${String(index).padStart(6, '0')}.png`
}

function clonePinnedResource(resource: WorldRenderPinnedResource): WorldRenderPinnedResource {
  return {
    resource: structuredClone(resource.resource),
    files: resource.files.map((file) => ({ ...file })),
  }
}

function cloneExecutionPackage(value: WorldRenderExecutionPackage): WorldRenderExecutionPackage {
  return {
    snapshot: cloneWorldProjectSnapshot(value.snapshot),
    scene: structuredClone(value.scene),
    sequence: structuredClone(value.sequence),
    preset: { ...value.preset },
    resources: value.resources.map(clonePinnedResource),
    framePlan: value.framePlan.map(cloneFrameTime),
    snapshotSha256: value.snapshotSha256,
  }
}

function sortStoredFrames(state: StoredJobV1): StoredJobV1 {
  if (state.outputs.frames.every((frame, index) => frame.index === index)) return state
  return {
    ...state,
    outputs: {
      ...state.outputs,
      frames: [...state.outputs.frames].sort((left, right) => left.index - right.index),
    },
  }
}

function resourceFileReferences(resource: WorldResource): Array<{
  role: WorldRenderPinnedResourceRole
  workspacePath: string
}> {
  const references: Array<{ role: WorldRenderPinnedResourceRole; workspacePath: string }> = [
    { role: 'primary', workspacePath: resource.workspacePath },
  ]
  if (resource.type === 'animation' && resource.sourceWorkspacePath) {
    references.push({ role: 'source', workspacePath: resource.sourceWorkspacePath })
  }
  if (resource.type === 'animation' && resource.legacyWorkspacePath) {
    references.push({ role: 'legacy', workspacePath: resource.legacyWorkspacePath })
  }
  return references
}

function cloneFrameTime(frame: WorldFrameTime): WorldFrameTime {
  return {
    index: frame.index,
    time: { ...frame.time },
    duration: { ...frame.duration },
    timestampMicroseconds: frame.timestampMicroseconds,
  }
}

function cloneFrameArtifactTime(
  frame: WorldFrameTime,
): Pick<StoredFrameArtifact, 'index' | 'time' | 'timestampMicroseconds'> {
  return { index: frame.index, time: { ...frame.time }, timestampMicroseconds: frame.timestampMicroseconds }
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${stableSerialize(value)}\n`, 'utf8')
}

function encodeStoredState(state: StoredJobV1): Buffer {
  return encodeJson({
    ...state,
    outputs: { frames: [], audio: null, renderManifest: null, webm: null },
  })
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => codeUnitCompare(left, right))
    .map(([key, item]) => [key, sortJson(item)]))
}

function parseJsonBuffer(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')) }
  catch { throw new RenderRepositoryFault('recovery_failed', true) }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value
}

function temporarySibling(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`)
}

function isCanonicalAbsoluteRoot(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !value.includes('\0')
    && isAbsolute(value) && !WINDOWS_DEVICE_PREFIX.test(value) && resolve(value) === value
}

function isCanonicalWorkspacePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0')
    || value.includes('\\') || value.startsWith('/') || WINDOWS_DEVICE_PREFIX.test(value) || WINDOWS_DRIVE_PREFIX.test(value)
    || posix.normalize(value) !== value) return false
  const segments = value.split('/')
  return segments.every((segment) => segment && segment !== '.' && segment !== '..'
    && !segment.includes(':') && !segment.endsWith('.') && !segment.endsWith(' ') && !WINDOWS_RESERVED_SEGMENT.test(segment))
}

function assertContained(root: string, target: string): void {
  if (!isContained(root, target)) throw new RenderRepositoryFault('unsafe_workspace')
}

function isContained(root: string, target: string): boolean {
  const candidate = relative(root, target)
  return candidate !== '' && candidate !== '..' && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate)
}

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new RenderRepositoryFault('write_failed', true)
  return value.toISOString()
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !value.includes('\0')
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
}

async function syncDirectoryWith(
  directory: string,
  override?: WorldRenderOutputRepositoryOptions['syncDirectory'],
): Promise<void> {
  if (override) {
    let synced = false
    try { synced = Boolean(await override(directory)) } catch { /* fail closed below */ }
    if (!synced) throw new RenderRepositoryFault('write_failed', true)
    return
  }
  let handle
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch {
    throw new RenderRepositoryFault('write_failed', true)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function enqueueRepository<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = repositoryQueues.get(key) ?? Promise.resolve()
  const queued = previous.catch(() => undefined).then(() => {
    throwIfRepositoryAborted(signal)
    return operation()
  })
  const settled = queued.then(() => undefined, () => undefined)
  repositoryQueues.set(key, settled)
  void settled.finally(() => {
    if (repositoryQueues.get(key) === settled) repositoryQueues.delete(key)
  })
  return abortableRepositoryPromise(queued, signal)
}

function abortableRepositoryPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfRepositoryAborted(signal)
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      cleanup()
      rejectPromise(repositoryAbortError())
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { cleanup(); resolvePromise(value) },
      (error: unknown) => { cleanup(); rejectPromise(error) },
    )
  })
}

function throwIfRepositoryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw repositoryAbortError()
}

function repositoryAbortError(): Error {
  const error = new Error('Pinned resource read was cancelled.')
  error.name = 'AbortError'
  return error
}

function isRepositoryAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
