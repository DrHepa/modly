import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

import { createHash } from 'node:crypto'

import type { BrowserWindow, MessagePortMain, Session } from 'electron'

import { isWorldGltfAnimationResourceBoundToModel, type WorldResource } from '../../src/areas/worlds/core/worldModel.ts'
import { worldAudioSampleCount } from '../../src/areas/worlds/render/worldOfflineAudio.ts'
import {
  WORLD_WEBM_DEFAULT_TIMEOUT_MS,
  WORLD_WEBM_MAX_REQUEST_ID,
  WORLD_WEBM_PROTOCOL,
  parseWorldWebmMainCommand,
  parseWorldWebmMainResponse,
  parseWorldWebmWorkerMessage,
  peekWorldWebmMessageIdentity,
  worldWebmVideoBitrate,
  type WorldWebmAssemblyOutcome,
  type WorldWebmFailureCode,
  type WorldWebmMainResponse,
  type WorldWebmStartPayload,
  type WorldWebmSuccessPayload,
  type WorldWebmWorkerEvent,
  type WorldWebmWorkerRequest,
} from '../../src/areas/worlds/render/worldWebmProtocol.ts'
import {
  WORLD_RENDER_HOST_CONNECT_CHANNEL,
  WORLD_RENDER_HOST_DEFAULT_TIMEOUT_MS,
  WORLD_RENDER_HOST_MAX_AUDIO_SAMPLES,
  WORLD_RENDER_HOST_MAX_CONCURRENT_RESOURCE_REQUESTS,
  WORLD_RENDER_HOST_MAX_FRAME_BYTES,
  WORLD_RENDER_HOST_MAX_RESOURCE_REQUESTS,
  WORLD_RENDER_HOST_MAX_RESOURCE_BYTES,
  WORLD_RENDER_HOST_MAX_TIMEOUT_MS,
  WORLD_RENDER_HOST_PROTOCOL,
  parseWorldRenderHostInitializePayload,
  parseWorldRenderHostResourcePortRequest,
  parseWorldRenderHostResponse,
  peekWorldRenderHostMessageIdentity,
  type WorldRenderHostAudioResult,
  type WorldRenderHostCommand,
  type WorldRenderHostFrameRequest,
  type WorldRenderHostFrameResult,
  type WorldRenderHostFailureResponse,
  type WorldRenderHostInitializePayload,
  type WorldRenderHostResourceDescriptor,
  type WorldRenderHostResourceFailureCode,
  type WorldRenderHostResourcePortRequest,
  type WorldRenderHostResourcePortResult,
  type WorldRenderHostResourceResult,
  type WorldRenderHostResponse,
} from '../../src/shared/types/worldRenderHost.ts'
import type {
  WorldRenderOutputRepository,
  WorldRenderPinnedResourceBytes,
  WorldRenderPinnedResourceRole,
} from './world-render-output-repository.ts'
import {
  WorldRenderExecutorError,
  type WorldRenderExecutor,
  type WorldRenderExecutorContext,
} from './world-render-job-service.ts'

const SUPPORTED_MODEL_FORMATS = new Set(['glb'])
const SUPPORTED_ANIMATION_FORMATS = new Set(['gltf-clip'])
const SUPPORTED_AUDIO_FORMATS = new Set(['wav', 'mp3', 'ogg', 'flac'])
const SUPPORTED_ENVIRONMENT_FORMATS = new Set(['hdr', 'exr', 'image'])
const DEFAULT_SESSION_ADMISSION_TIMEOUT_MS = 30_000
const DEFAULT_SESSION_CLEANUP_TIMEOUT_MS = 2_000
const MIN_SESSION_PHASE_TIMEOUT_MS = 5

export interface WorldRenderHostSession {
  initialize(payload: WorldRenderHostInitializePayload, signal: AbortSignal): Promise<void>
  renderFrame(request: WorldRenderHostFrameRequest, signal: AbortSignal): Promise<Uint8Array>
  renderAudio(signal: AbortSignal): Promise<Uint8Array>
  assembleWebm?(payload: WorldWebmStartPayload, signal: AbortSignal): Promise<WorldWebmAssemblyOutcome>
  dispose(): Promise<void>
}

class WorldRenderHostFailureError extends Error {
  readonly hostCode: WorldRenderHostFailureResponse['error']['code']

  constructor(error: WorldRenderHostFailureResponse['error']) {
    super(`${error.code}: ${error.message}`)
    this.name = 'WorldRenderHostFailureError'
    this.hostCode = error.code
  }
}

export interface WorldRenderBrowserExecutorOptions {
  outputRepository?: WorldRenderOutputRepository
  createSession?: (input: {
    readonly jobId: string
    readonly generation: string
    readonly outputRepository?: WorldRenderOutputRepository
    readonly timeoutMs: number
    readonly signal: AbortSignal
    readonly admissionDeadlineMs: number
    readonly cleanupTimeoutMs: number
  }) => Promise<WorldRenderHostSession>
  assembleWithFfmpeg?: (input: {
    readonly jobId: string
    readonly generation: string
    readonly plan: WorldWebmStartPayload
    readonly signal: AbortSignal
  }) => Promise<boolean>
  timeoutMs?: number
  sessionAdmissionTimeoutMs?: number
  sessionCleanupTimeoutMs?: number
}

/** Internal offline executor: persists masters, then delegates WebM assembly to the hidden Worker. */
export class WorldRenderBrowserExecutor implements WorldRenderExecutor {
  private readonly options: WorldRenderBrowserExecutorOptions
  private readonly timeoutMs: number
  private readonly sessionAdmissionTimeoutMs: number
  private readonly sessionCleanupTimeoutMs: number
  private readonly active = new Set<WorldRenderHostSession>()
  private readonly sessionDisposals = new WeakMap<WorldRenderHostSession, Promise<void>>()
  private readonly pendingSessionDisposals = new Set<Promise<void>>()
  private readonly shutdownController = new AbortController()
  private stopping = false
  private shutdownPromise: Promise<void> | null = null

  constructor(options: WorldRenderBrowserExecutorOptions) {
    if (!options.createSession && !options.outputRepository) {
      throw new TypeError('Production world rendering requires an output repository.')
    }
    const timeout = options.timeoutMs ?? WORLD_RENDER_HOST_DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > WORLD_RENDER_HOST_MAX_TIMEOUT_MS) {
      throw new TypeError('World render host timeout is outside the supported bound.')
    }
    this.options = options
    this.timeoutMs = timeout
    this.sessionAdmissionTimeoutMs = boundedSessionPhaseTimeout(
      options.sessionAdmissionTimeoutMs ?? Math.min(timeout, DEFAULT_SESSION_ADMISSION_TIMEOUT_MS),
      'admission',
    )
    this.sessionCleanupTimeoutMs = boundedSessionPhaseTimeout(
      options.sessionCleanupTimeoutMs ?? Math.min(timeout, DEFAULT_SESSION_CLEANUP_TIMEOUT_MS),
      'cleanup',
    )
  }

  async execute(context: WorldRenderExecutorContext): Promise<void> {
    if (this.stopping) throw new Error('World render browser executor is shutting down.')
    throwIfAborted(context.signal)
    await context.reportProgress({ phase: 'preflighting', completedFrames: 0 })
    const payload = createWorldRenderHostInitializePayload(context)
    const generation = randomBytes(16).toString('hex')
    let session: WorldRenderHostSession | null = null
    try {
      session = await this.admitSession(context, generation)
      this.active.add(session)
      throwIfAborted(context.signal)
      await session.initialize(structuredClone(payload), context.signal)
      throwIfAborted(context.signal)
      await context.reportProgress({ phase: 'rendering-frames', completedFrames: 0 })
      for (const frame of payload.framePlan) {
        throwIfAborted(context.signal)
        const png = await session.renderFrame({
          index: frame.index,
          time: { ...frame.time },
          timestampMicroseconds: frame.timestampMicroseconds,
        }, context.signal)
        throwIfAborted(context.signal)
        await context.writeFrame(frame.index, png)
        await context.reportProgress({ phase: 'rendering-frames', completedFrames: frame.index + 1 })
      }
      throwIfAborted(context.signal)
      await context.reportProgress({ phase: 'rendering-audio', completedFrames: payload.framePlan.length })
      const wav = await session.renderAudio(context.signal)
      throwIfAborted(context.signal)
      await context.writeAudio(wav)
      await context.reportProgress({ phase: 'assembling', completedFrames: payload.framePlan.length })
      if (session.assembleWebm) {
        try {
          const plan = createWorldWebmStartPayload(context)
          const result = await session.assembleWebm(plan, context.signal)
          throwIfAborted(context.signal)
          if (!result.ok && result.code === 'cancelled') {
            throw abortError('World WebM assembly was cancelled.')
          }
          if (!result.ok && isWorldWebmFfmpegFallbackEligible(result.code) && this.options.assembleWithFfmpeg) {
            await this.options.assembleWithFfmpeg({
              jobId: context.jobId,
              generation,
              plan,
              signal: context.signal,
            })
          }
        } catch (error) {
          if (isAbortError(error) || context.signal.aborted) throw error
          // PNG + WAV are already durable. Any codec, Worker, mux, or finalize
          // failure intentionally settles as a truthful masters-only partial.
        }
      }
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) throw error
      throw new WorldRenderExecutorError({
        code: 'output_invalid',
        message: 'World render output is incomplete or invalid.',
        retryable: false,
        issues: [{
          code: error instanceof WorldRenderHostFailureError && error.hostCode === 'gpu-context-lost'
            ? 'gpu-context-lost'
            : 'renderer-failed',
          path: 'render.executor',
          message: boundedIssueMessage(error),
        }],
      })
    } finally {
      if (session) {
        this.active.delete(session)
        await this.disposeSessionWithinBoundary(session)
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    this.shutdownController.abort()
    this.shutdownPromise ??= Promise.all(
      [...this.active].map((session) => this.disposeSessionWithinBoundary(session)),
    ).then(() => undefined)
    await this.shutdownPromise
  }

  private async admitSession(
    context: WorldRenderExecutorContext,
    generation: string,
  ): Promise<WorldRenderHostSession> {
    const createSession = this.options.createSession ?? createElectronWorldRenderHostSession
    const controller = new AbortController()
    const admissionDeadlineMs = Date.now() + this.sessionAdmissionTimeoutMs
    let abortCause: 'context' | 'shutdown' | 'timeout' | null = null
    const abort = (cause: Exclude<typeof abortCause, null>): void => {
      if (abortCause) return
      abortCause = cause
      controller.abort()
    }
    const onContextAbort = (): void => abort('context')
    const onShutdown = (): void => abort('shutdown')
    context.signal.addEventListener('abort', onContextAbort, { once: true })
    this.shutdownController.signal.addEventListener('abort', onShutdown, { once: true })
    if (context.signal.aborted) abort('context')
    else if (this.shutdownController.signal.aborted || this.stopping) abort('shutdown')
    const timer = setTimeout(() => abort('timeout'), this.sessionAdmissionTimeoutMs)
    timer.unref?.()
    let operation: Promise<WorldRenderHostSession>
    try {
      operation = Promise.resolve(createSession({
        jobId: context.jobId,
        generation,
        outputRepository: this.options.outputRepository,
        timeoutMs: this.timeoutMs,
        signal: controller.signal,
        admissionDeadlineMs,
        cleanupTimeoutMs: this.sessionCleanupTimeoutMs,
      }))
    } catch (error) {
      operation = Promise.reject(error)
    }
    try {
      const outcome = await settleSessionAdmission({
        operation,
        signal: controller.signal,
        onLateSession: (lateSession) => this.startSessionDisposal(lateSession),
      })
      if (outcome.status === 'fulfilled') return outcome.value
      if (outcome.status === 'rejected') throw outcome.error
      if (abortCause === 'timeout') throw new Error('World render host session admission timed out.')
      throw abortError('World render host session admission was cancelled.')
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', onContextAbort)
      this.shutdownController.signal.removeEventListener('abort', onShutdown)
    }
  }

  private startSessionDisposal(session: WorldRenderHostSession): Promise<void> {
    const existing = this.sessionDisposals.get(session)
    if (existing) return existing
    const operation = Promise.resolve().then(() => session.dispose())
    this.sessionDisposals.set(session, operation)
    this.pendingSessionDisposals.add(operation)
    void operation.then(
      () => { this.pendingSessionDisposals.delete(operation) },
      () => { this.pendingSessionDisposals.delete(operation) },
    )
    return operation
  }

  private async disposeSessionWithinBoundary(session: WorldRenderHostSession): Promise<void> {
    await settleWorldWebmPhase({
      operation: this.startSessionDisposal(session),
      timeoutMs: this.sessionCleanupTimeoutMs,
    })
  }
}

type SessionAdmissionOutcome =
  | { readonly status: 'fulfilled'; readonly value: WorldRenderHostSession }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'aborted' }

function settleSessionAdmission(input: {
  readonly operation: Promise<WorldRenderHostSession>
  readonly signal: AbortSignal
  readonly onLateSession: (session: WorldRenderHostSession) => void | Promise<void>
}): Promise<SessionAdmissionOutcome> {
  return new Promise((resolvePromise) => {
    let waiting = true
    const finish = (outcome: SessionAdmissionOutcome): void => {
      if (!waiting) return
      waiting = false
      input.signal.removeEventListener('abort', onAbort)
      resolvePromise(outcome)
    }
    const onAbort = (): void => finish({ status: 'aborted' })
    input.signal.addEventListener('abort', onAbort, { once: true })
    if (input.signal.aborted) finish({ status: 'aborted' })
    void input.operation.then(
      (session) => {
        if (waiting) finish({ status: 'fulfilled', value: session })
        else {
          try { void Promise.resolve(input.onLateSession(session)).catch(() => undefined) }
          catch { /* the late session remains fail-closed */ }
        }
      },
      (error: unknown) => {
        if (waiting) finish({ status: 'rejected', error })
        // A late rejection is consumed by this exact admission owner.
      },
    )
  })
}

function boundedSessionPhaseTimeout(value: number, phase: string): number {
  if (!Number.isSafeInteger(value) || value < MIN_SESSION_PHASE_TIMEOUT_MS
    || value > WORLD_RENDER_HOST_MAX_TIMEOUT_MS) {
    throw new TypeError(`World render host session ${phase} timeout is outside the supported bound.`)
  }
  return value
}

const WORLD_WEBM_FFMPEG_ELIGIBLE_FAILURES = new Set<WorldWebmFailureCode>([
  'codec-unavailable',
  'codec-encode-failed',
  'mux-construction-failed',
  'mux-start-failed',
  'mux-finalize-failed',
])

export function isWorldWebmFfmpegFallbackEligible(code: WorldWebmFailureCode): boolean {
  return WORLD_WEBM_FFMPEG_ELIGIBLE_FAILURES.has(code)
}

export function createWorldWebmStartPayload(context: WorldRenderExecutorContext): WorldWebmStartPayload {
  const audioSampleCount = worldAudioSampleCount(context.sequence.duration)
  return {
    width: context.preset.width,
    height: context.preset.height,
    fps: context.preset.fps,
    frameCount: context.framePlan.length,
    duration: { ...context.sequence.duration },
    frameDurations: context.framePlan.map((frame) => ({ ...frame.duration })),
    audioSampleCount,
    videoBitrate: worldWebmVideoBitrate(context.preset.width, context.preset.height, context.preset.fps),
    audioBitrate: 128_000,
  }
}

export function createWorldRenderHostInitializePayload(context: WorldRenderExecutorContext): WorldRenderHostInitializePayload {
  const sampleCount = worldAudioSampleCount(context.sequence.duration)
  if (sampleCount > WORLD_RENDER_HOST_MAX_AUDIO_SAMPLES) {
    throw new Error('Offline audio exceeds the 15 minute in-memory rendering bound.')
  }
  const usedIds = collectUsedResourceIds(context.scene)
  const pinned = new Map(context.resources.map((resource) => [resource.resource.id, resource]))
  const descriptors: WorldRenderHostResourceDescriptor[] = []
  for (const resourceId of [...usedIds].sort(codeUnitCompare)) {
    const entry = pinned.get(resourceId)
    if (!entry) throw new Error(`Pinned render resource ${resourceId} is missing.`)
    assertSupportedResource(entry.resource)
    const primary = entry.files.filter((file) => file.role === 'primary')
    if (primary.length !== 1 || primary[0].size > WORLD_RENDER_HOST_MAX_RESOURCE_BYTES) {
      throw new Error(`Pinned render resource ${resourceId} has no bounded primary file.`)
    }
    const animationResource = entry.resource.type === 'animation' && entry.resource.format === 'gltf-clip'
      ? entry.resource
      : null
    const boundModelResourceId = animationResource
      ? context.snapshot.project.resources.find((candidate) => candidate.type === 'model'
        && isWorldGltfAnimationResourceBoundToModel(animationResource, candidate))?.id
      : undefined
    if (entry.resource.type === 'animation' && !boundModelResourceId) {
      throw new Error(`GLTF animation ${resourceId} is not bound to a pinned GLB model.`)
    }
    descriptors.push({
      id: entry.resource.id,
      name: entry.resource.name,
      type: entry.resource.type,
      format: entry.resource.format,
      ...(entry.resource.type === 'animation' && entry.resource.clipId ? { clipId: entry.resource.clipId } : {}),
      ...(entry.resource.type === 'animation' && entry.resource.clipName ? { clipName: entry.resource.clipName } : {}),
      ...(entry.resource.type === 'animation' && entry.resource.clipIndex !== undefined
        ? { clipIndex: entry.resource.clipIndex } : {}),
      ...(entry.resource.type === 'animation' && entry.resource.durationSeconds !== undefined
        ? { durationSeconds: entry.resource.durationSeconds } : {}),
      ...(boundModelResourceId ? { boundModelResourceId } : {}),
      files: entry.files.map(({ role, size, sha256 }) => ({ role, size, sha256 })),
    })
  }
  assertAudioListenerContract(context.scene)
  return structuredClone({
    snapshot: {
      snapshotSha256: context.snapshotSha256,
      projectId: context.snapshot.project.projectId,
      revision: context.snapshot.project.revision,
      scene: context.scene,
      sequence: context.sequence,
      resources: descriptors,
    },
    preset: context.preset,
    framePlan: context.framePlan,
  })
}

function collectUsedResourceIds(scene: WorldRenderExecutorContext['scene']): Set<string> {
  const ids = new Set<string>()
  if (scene.environment.environmentResourceId) ids.add(scene.environment.environmentResourceId)
  for (const entity of scene.entities) {
    if (!isEntityEffectivelyEnabled(scene, entity.id)) continue
    for (const component of entity.components) {
      if (component.type === 'renderable' || component.type === 'animation-player' || component.type === 'audio-source') {
        if (component.enabled) ids.add(component.resourceId)
      }
    }
  }
  return ids
}

function isEntityEffectivelyEnabled(
  scene: WorldRenderExecutorContext['scene'],
  entityId: string,
): boolean {
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const visited = new Set<string>()
  let entity = entities.get(entityId)
  while (entity && !visited.has(entity.id)) {
    visited.add(entity.id)
    if (!entity.enabled) return false
    entity = entity.parentId ? entities.get(entity.parentId) : undefined
  }
  return true
}

function assertSupportedResource(resource: WorldResource): void {
  const supported = resource.type === 'model' ? SUPPORTED_MODEL_FORMATS
    : resource.type === 'animation' ? SUPPORTED_ANIMATION_FORMATS
      : resource.type === 'audio' ? SUPPORTED_AUDIO_FORMATS
        : SUPPORTED_ENVIRONMENT_FORMATS
  if (!supported.has(resource.format)) {
    throw new Error(`Offline masters do not support ${resource.type}/${resource.format}; use a self-contained GLB, Chromium-decodable audio, or pinned HDR/EXR/image environment.`)
  }
}

function assertAudioListenerContract(scene: WorldRenderExecutorContext['scene']): void {
  const hasSpatial = scene.entities.some((entity) => isEntityEffectivelyEnabled(scene, entity.id) && entity.components.some((component) => (
    component.type === 'audio-source' && component.enabled && component.spatial
  )))
  if (!hasSpatial) return
  const listeners = scene.entities.filter((entity) => isEntityEffectivelyEnabled(scene, entity.id) && entity.components.some((component) => (
    component.type === 'audio-listener' && component.enabled && component.primary
  )))
  if (listeners.length !== 1) throw new Error(`Spatial offline audio requires exactly one enabled primary listener; found ${listeners.length}.`)
}

interface PendingResponse {
  readonly expectedKind: WorldRenderHostCommand['kind']
  readonly resolve: (response: WorldRenderHostResponse) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

interface ActiveResourceRead {
  readonly request: WorldRenderHostResourcePortRequest
  readonly controller: AbortController
  readonly timeout: ReturnType<typeof setTimeout>
}

interface PinnedResourceExpectation {
  readonly resourceId: string
  readonly role: WorldRenderPinnedResourceRole
  readonly size: number
  readonly sha256: string
}

interface ActiveWebmAssembly {
  readonly requestId: number
  readonly payload: WorldWebmStartPayload
  readonly signal: AbortSignal
  readonly resolve: (outcome: WorldWebmAssemblyOutcome) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
  sinkId: string | null
  committed: { size: number; sha256: string } | null
  stage: 'starting' | 'preflighted' | 'sink-open' | 'committed' | 'aborted'
  lastWorkerRequestId: number
  lastProgress: { completedFrames: number; completedAudioSamples: number }
  lastProgressPhase: number
  requestQueue: Promise<void>
  readonly sinkAbortions: Map<string, { raw: Promise<true>; observed: Promise<boolean> }>
}

export interface WorldRenderWebmAuthority {
  beginWebmAssembly(jobId: string, generation: string, plan: WorldWebmStartPayload, signal?: AbortSignal): Promise<{ sinkId: string }>
  readWebmFrameMaster(jobId: string, generation: string, sinkId: string, index: number, signal?: AbortSignal): Promise<{ index: number; size: number; sha256: string; bytes: Uint8Array }>
  readWebmAudioMaster(jobId: string, generation: string, sinkId: string, sampleOffset: number, sampleCount: number, signal?: AbortSignal): Promise<{ sampleOffset: number; sampleCount: number; bytes: Uint8Array }>
  writeWebmAssembly(jobId: string, generation: string, sinkId: string, position: number, bytes: Uint8Array, signal?: AbortSignal): Promise<{ written: number; extent: number }>
  commitWebmAssembly(jobId: string, generation: string, sinkId: string, extent: number, signal?: AbortSignal): Promise<{ size: number; sha256: string }>
  confirmWebmAssembly(jobId: string, generation: string, sinkId: string): Promise<true>
  abortWebmAssembly(jobId: string, generation: string, sinkId: string): Promise<true>
}

export interface WorldRenderHostPort {
  onMessage(listener: (event: { data: unknown }) => void): void
  onMessageError(listener: () => void): void
  onClose(listener: () => void): void
  postMessage(value: unknown): void
  start(): void
  close(): void
}

export interface WorldRenderMainPortChannelOptions {
  readonly jobId: string
  readonly generation: string
  readonly timeoutMs: number
  readonly port: WorldRenderHostPort
  readonly readPinnedResource: (
    jobId: string,
    resourceId: string,
    role: WorldRenderPinnedResourceRole,
    signal: AbortSignal,
  ) => Promise<WorldRenderPinnedResourceBytes>
  readonly webmAuthority?: WorldRenderWebmAuthority
  readonly webmSettlementTimeoutMs?: number
}

/**
 * Job-scoped authority for the single hidden-renderer MessagePort. Commands and
 * resource reads share the port but have independent request namespaces.
 */
export class WorldRenderMainPortChannel implements WorldRenderHostSession {
  private readonly jobId: string
  private readonly generation: string
  private readonly timeoutMs: number
  private readonly port: WorldRenderHostPort
  private readonly readPinnedResource: WorldRenderMainPortChannelOptions['readPinnedResource']
  private readonly webmAuthority: WorldRenderMainPortChannelOptions['webmAuthority']
  private readonly webmSettlementTimeoutMs: number
  private readonly pending = new Map<number, PendingResponse>()
  private readonly resourceReads = new Map<number, ActiveResourceRead>()
  private readonly allowedResources = new Map<string, PinnedResourceExpectation>()
  private requestId = 0
  private lastResourceRequestId = 0
  private resourceRequestCount = 0
  private initialized = false
  private initializing = false
  private closed = false
  private failure: Error | null = null
  private expectedWidth = 0
  private expectedHeight = 0
  private expectedAudioSamples = 0
  private webmAssembly: ActiveWebmAssembly | null = null

  constructor(options: WorldRenderMainPortChannelOptions) {
    const identity = peekWorldRenderHostMessageIdentity({
      jobId: options.jobId,
      generation: options.generation,
    })
    if (!identity) throw new TypeError('World render host channel identity is invalid.')
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000
      || options.timeoutMs > WORLD_RENDER_HOST_MAX_TIMEOUT_MS) {
      throw new TypeError('World render host channel timeout is outside the supported bound.')
    }
    const webmSettlementTimeoutMs = options.webmSettlementTimeoutMs ?? Math.min(options.timeoutMs, 30_000)
    if (!Number.isSafeInteger(webmSettlementTimeoutMs) || webmSettlementTimeoutMs < 5
      || webmSettlementTimeoutMs > 30_000) {
      throw new TypeError('World WebM settlement timeout is outside the supported bound.')
    }
    this.jobId = options.jobId
    this.generation = options.generation
    this.timeoutMs = options.timeoutMs
    this.port = options.port
    this.readPinnedResource = options.readPinnedResource
    this.webmAuthority = options.webmAuthority
    this.webmSettlementTimeoutMs = webmSettlementTimeoutMs
    this.port.onMessage(({ data }) => this.receive(data))
    this.port.onMessageError(() => this.fail(
      new Error('World render host message could not be decoded.'),
      'protocol-failed',
    ))
    this.port.onClose(() => this.fail(new Error('World render host channel closed.'), 'worker-crashed'))
    this.port.start()
  }

  async initialize(payload: WorldRenderHostInitializePayload, signal: AbortSignal): Promise<void> {
    if (this.initialized || this.initializing) throw new Error('World render host has already been initialized.')
    if (!parseWorldRenderHostInitializePayload(payload)) throw new Error('World render initialize payload is invalid.')
    this.initializing = true
    this.allowedResources.clear()
    for (const resource of payload.snapshot.resources) {
      for (const file of resource.files) {
        this.allowedResources.set(resourceKey(resource.id, file.role), {
          resourceId: resource.id,
          role: file.role,
          size: file.size,
          sha256: file.sha256,
        })
      }
    }
    this.expectedWidth = payload.preset.width
    this.expectedHeight = payload.preset.height
    this.expectedAudioSamples = worldAudioSampleCount(payload.snapshot.sequence.duration)
    try {
      const response = await this.request('initialize', payload, signal)
      if (!response.ok || response.kind !== 'initialize') throw new Error('World render host returned an invalid initialize response.')
      this.initialized = true
    } finally {
      this.initializing = false
    }
  }

  async renderFrame(payload: WorldRenderHostFrameRequest, signal: AbortSignal): Promise<Uint8Array> {
    this.assertInitialized()
    const response = await this.request('render-frame', payload, signal)
    if (!response.ok || response.kind !== 'render-frame') throw new Error('World render host returned an invalid frame response.')
    const frame = response.payload as WorldRenderHostFrameResult
    if (frame.index !== payload.index || frame.width !== this.expectedWidth || frame.height !== this.expectedHeight) {
      throw new Error('World render host returned a frame with an unexpected identity or size.')
    }
    const rgba = new Uint8Array(frame.rgba)
    if (sha256Bytes(rgba) !== frame.rgbaSha256) {
      throw new Error('World render host returned an RGBA hash mismatch.')
    }
    const png = encodeWorldRenderRgbaPng(rgba, this.expectedWidth, this.expectedHeight)
    assertPngHeader(png, this.expectedWidth, this.expectedHeight)
    return png
  }

  async renderAudio(signal: AbortSignal): Promise<Uint8Array> {
    this.assertInitialized()
    const response = await this.request('render-audio', {}, signal)
    if (!response.ok || response.kind !== 'render-audio') throw new Error('World render host returned an invalid audio response.')
    const audio = response.payload as WorldRenderHostAudioResult
    if (audio.sampleCount !== this.expectedAudioSamples) throw new Error('World render host returned an unexpected audio sample count.')
    const wav = new Uint8Array(audio.wav)
    assertPcm16StereoWav(wav, audio.sampleCount)
    if (sha256Bytes(wav.subarray(44)) !== audio.pcmSha256) throw new Error('World render host returned an audio hash mismatch.')
    return wav
  }

  async assembleWebm(payload: WorldWebmStartPayload, signal: AbortSignal): Promise<WorldWebmAssemblyOutcome> {
    this.assertInitialized()
    throwIfAborted(signal)
    if (!this.webmAuthority) return { ok: false, code: 'sink-failed' }
    if (this.webmAssembly) throw new Error('World WebM assembly is already active.')
    if (this.requestId >= WORLD_WEBM_MAX_REQUEST_ID - 1) throw new Error('World WebM request limit was exceeded.')
    const requestId = ++this.requestId
    const command = {
      protocol: WORLD_WEBM_PROTOCOL,
      jobId: this.jobId,
      generation: this.generation,
      requestId,
      kind: 'start',
      payload: structuredClone(payload),
    }
    if (!parseWorldWebmMainCommand(command)) throw new TypeError('World WebM assembly plan is invalid.')

    return new Promise<WorldWebmAssemblyOutcome>((resolvePromise, rejectPromise) => {
      const durationSeconds = payload.duration.numerator / payload.duration.denominator
      const assemblyTimeoutMs = Math.min(30 * 60_000, Math.max(
        WORLD_WEBM_DEFAULT_TIMEOUT_MS,
        Math.ceil(durationSeconds * 4_000) + WORLD_WEBM_DEFAULT_TIMEOUT_MS,
      ))
      const onAbort = (): void => {
        const active = this.webmAssembly
        if (!active || active.requestId !== requestId) return
        this.postWorldWebmAbort(active)
        void this.finishWorldWebm(active, 'cancelled', 'cancelled', abortError('World WebM assembly was cancelled.'))
      }
      const timeout = setTimeout(() => {
        const active = this.webmAssembly
        if (!active || active.requestId !== requestId) return
        this.postWorldWebmAbort(active)
        void this.finishWorldWebm(active, 'failure', 'worker-timeout')
      }, assemblyTimeoutMs)
      const cleanup = (): void => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
      }
      const active: ActiveWebmAssembly = {
        requestId,
        payload: structuredClone(payload),
        signal,
        resolve: resolvePromise,
        reject: rejectPromise,
        cleanup,
        sinkId: null,
        committed: null,
        stage: 'starting',
        lastWorkerRequestId: 0,
        lastProgress: { completedFrames: 0, completedAudioSamples: 0 },
        lastProgressPhase: -1,
        requestQueue: Promise.resolve(),
        sinkAbortions: new Map(),
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.webmAssembly = active
      try {
        this.port.postMessage(command)
      } catch (error) {
        this.webmAssembly = null
        cleanup()
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async dispose(): Promise<void> {
    this.close()
  }

  async disposeRenderer(signal: AbortSignal): Promise<void> {
    if (this.closed || !this.initialized) return
    const response = await this.request('dispose', {}, signal)
    if (!response.ok || response.kind !== 'dispose') throw new Error('World render host returned an invalid dispose response.')
    this.initialized = false
  }

  fail(error: Error, worldWebmCode: WorldWebmFailureCode = 'internal-failed'): void {
    if (this.closed) return
    this.failure ??= error
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
    this.abortResourceReads()
    const active = this.webmAssembly
    if (active) {
      this.postWorldWebmAbort(active)
      void this.finishWorldWebm(
        active,
        worldWebmCode === 'cancelled' ? 'cancelled' : 'failure',
        worldWebmCode,
        error,
      )
    }
  }

  close(): void {
    if (this.closed) return
    this.fail(abortError('World render host was disposed.'), 'cancelled')
    this.closed = true
    this.allowedResources.clear()
    try { this.port.close() } catch { /* already closed */ }
  }

  private assertInitialized(): void {
    if (this.failure) throw this.failure
    if (!this.initialized || this.closed) throw new Error('World render host is not initialized.')
  }

  private async request<K extends WorldRenderHostCommand['kind']>(
    kind: K,
    payload: Extract<WorldRenderHostCommand, { kind: K }>['payload'],
    signal: AbortSignal,
  ): Promise<WorldRenderHostResponse> {
    throwIfAborted(signal)
    if (this.closed) throw abortError('World render host is disposed.')
    if (this.failure) throw this.failure
    const requestId = ++this.requestId
    const command = {
      protocol: WORLD_RENDER_HOST_PROTOCOL,
      jobId: this.jobId,
      generation: this.generation,
      requestId,
      kind,
      payload,
    } as WorldRenderHostCommand
    return new Promise<WorldRenderHostResponse>((resolvePromise, rejectPromise) => {
      const cleanup = (): void => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
      }
      const timeout = setTimeout(() => {
        if (!this.pending.delete(requestId)) return
        cleanup()
        rejectPromise(new Error(`World render host ${kind} request timed out.`))
      }, this.timeoutMs)
      const onAbort = (): void => {
        if (!this.pending.delete(requestId)) return
        cleanup()
        rejectPromise(abortError('World render request was cancelled.'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, {
        expectedKind: kind,
        resolve: resolvePromise,
        reject: rejectPromise,
        cleanup,
      })
      try { this.port.postMessage(command) }
      catch (error) {
        this.pending.delete(requestId)
        cleanup()
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private receive(value: unknown): void {
    if (this.closed) return
    if (isWorldWebmProtocolMessage(value)) {
      const webmIdentity = peekWorldWebmMessageIdentity(value)
      if (!webmIdentity || webmIdentity.jobId !== this.jobId || webmIdentity.generation !== this.generation) return
      const message = parseWorldWebmWorkerMessage(value)
      if (!message) {
        const active = this.webmAssembly
        if (active) {
          this.postWorldWebmAbort(active)
          void this.finishWorldWebm(active, 'failure', 'protocol-failed')
        }
        return
      }
      this.receiveWorldWebm(message)
      return
    }
    const identity = peekWorldRenderHostMessageIdentity(value)
    if (identity && (identity.jobId !== this.jobId || identity.generation !== this.generation)) return

    const resourceRequest = parseWorldRenderHostResourcePortRequest(value)
    if (resourceRequest) {
      void this.handleResourceRequest(resourceRequest)
      return
    }

    const response = parseWorldRenderHostResponse(value)
    if (response) {
      if (response.jobId !== this.jobId || response.generation !== this.generation) return
      const pending = this.pending.get(response.requestId)
      if (!pending) return
      if (response.kind !== pending.expectedKind) {
        this.pending.delete(response.requestId)
        pending.cleanup()
        pending.reject(new Error('World render host returned a response for the wrong command kind.'))
        return
      }
      this.pending.delete(response.requestId)
      pending.cleanup()
      if (response.ok) pending.resolve(response)
      else pending.reject(new WorldRenderHostFailureError(response.error))
      return
    }

    const pendingKinds = [...this.pending.values()].map((pending) => pending.expectedKind).sort(codeUnitCompare).join('|') || 'none'
    this.fail(new Error(
      `World render host returned an invalid response (${describeResponseShape(value)}; pending=${pendingKinds}; resources=${this.resourceRequestCount}).`,
    ), 'protocol-failed')
  }

  private receiveWorldWebm(message: WorldWebmWorkerRequest | WorldWebmWorkerEvent): void {
    const active = this.webmAssembly
    if (!active || message.jobId !== this.jobId || message.generation !== this.generation) return
    if (message.kind === 'progress') {
      if (message.requestId !== active.requestId) return
      if (!this.acceptWorldWebmProgress(active, message.payload)) {
        this.postWorldWebmAbort(active)
        void this.finishWorldWebm(active, 'failure', 'protocol-failed')
      }
      return
    }
    if (message.kind === 'complete') {
      if (message.requestId !== active.requestId) return
      const progressComplete = active.lastProgressPhase === 2
        && active.lastProgress.completedFrames === active.payload.frameCount
        && active.lastProgress.completedAudioSamples === active.payload.audioSampleCount
      if (active.stage !== 'committed' || !active.committed
        || !progressComplete || message.payload.size !== active.committed.size
        || message.payload.sha256 !== active.committed.sha256) {
        this.postWorldWebmAbort(active)
        void this.finishWorldWebm(active, 'failure', 'protocol-failed')
        return
      }
      void this.finishWorldWebm(active, 'succeeded')
      return
    }
    if (message.kind === 'error') {
      if (message.requestId !== active.requestId) return
      const cancelled = active.signal.aborted || message.payload.code === 'cancelled'
      void this.finishWorldWebm(
        active,
        cancelled ? 'cancelled' : 'failure',
        message.payload.code,
        cancelled ? abortError('World WebM assembly was cancelled.') : undefined,
      )
      return
    }
    if (message.requestId <= active.lastWorkerRequestId) {
      return
    }
    active.lastWorkerRequestId = message.requestId
    active.requestQueue = active.requestQueue
      .then(() => this.handleWorldWebmRequest(active, message))
      .catch(() => undefined)
  }

  private async handleWorldWebmRequest(active: ActiveWebmAssembly, request: WorldWebmWorkerRequest): Promise<void> {
    if (this.webmAssembly !== active || this.closed || active.signal.aborted || !this.webmAuthority) return
    try {
      if (request.kind === 'preflight') {
        if (active.stage !== 'starting' || !worldWebmPreflightMatches(active.payload, request.payload)) {
          throw new WorldWebmAuthorityError('invalid-request', 'World WebM codec preflight does not match its plan.')
        }
        active.stage = 'preflighted'
        this.postWorldWebmSuccess(request, {})
        return
      }
      if (request.kind === 'sink-begin') {
        if (active.stage !== 'preflighted' || active.sinkId) {
          throw new WorldWebmAuthorityError('invalid-request', 'World WebM sink begin is out of order.')
        }
        const result = await this.webmAuthority.beginWebmAssembly(
          this.jobId, this.generation, active.payload, active.signal,
        )
        if (this.webmAssembly !== active || active.signal.aborted) {
          // Retain the late identity before cleanup starts so finishWorldWebm
          // joins this exact tombstone and cannot preserve codec eligibility
          // unless physical repository cleanup acknowledges true.
          active.sinkId = result.sinkId
          await this.startWorldWebmAbort(active, result.sinkId)
          return
        }
        active.sinkId = result.sinkId
        active.stage = 'sink-open'
        this.postWorldWebmSuccess(request, result)
        return
      }
      if (request.kind === 'sink-abort') {
        if (!active.sinkId || request.payload.sinkId !== active.sinkId) {
          throw new WorldWebmAuthorityError('invalid-request', 'World WebM sink identity is invalid.')
        }
        if (!await this.startWorldWebmAbort(active, active.sinkId)) {
          throw new Error('World WebM repository cleanup acknowledgement is invalid.')
        }
        if (this.webmAssembly !== active) return
        active.sinkId = null
        active.stage = 'aborted'
        this.postWorldWebmSuccess(request, {})
        return
      }
      if (active.stage !== 'sink-open' || !active.sinkId || request.payload.sinkId !== active.sinkId) {
        throw new WorldWebmAuthorityError('invalid-request', 'World WebM sink request is out of order.')
      }
      if (request.kind === 'read-frame') {
        if (request.payload.index >= active.payload.frameCount) {
          throw new WorldWebmAuthorityError('invalid-request', 'World WebM frame index exceeds its plan.')
        }
        const result = await this.webmAuthority.readWebmFrameMaster(
          this.jobId, this.generation, active.sinkId, request.payload.index, active.signal,
        )
        if (this.webmAssembly !== active || active.signal.aborted) return
        this.postWorldWebmSuccess(request, {
          ...result,
          bytes: exactArrayBuffer(result.bytes),
        })
        return
      }
      if (request.kind === 'read-audio') {
        if (request.payload.sampleOffset + request.payload.sampleCount > active.payload.audioSampleCount) {
          throw new WorldWebmAuthorityError('invalid-request', 'World WebM audio range exceeds its plan.')
        }
        const result = await this.webmAuthority.readWebmAudioMaster(
          this.jobId, this.generation, active.sinkId,
          request.payload.sampleOffset, request.payload.sampleCount, active.signal,
        )
        if (this.webmAssembly !== active || active.signal.aborted) return
        this.postWorldWebmSuccess(request, {
          ...result,
          bytes: exactArrayBuffer(result.bytes),
        })
        return
      }
      if (request.kind === 'sink-write') {
        const bytes = new Uint8Array(request.payload.bytes)
        const result = await this.webmAuthority.writeWebmAssembly(
          this.jobId, this.generation, active.sinkId, request.payload.position, bytes, active.signal,
        )
        if (this.webmAssembly !== active || active.signal.aborted) return
        this.postWorldWebmSuccess(request, result)
        return
      }
      const committedSinkId = active.sinkId
      const result = await this.webmAuthority.commitWebmAssembly(
        this.jobId, this.generation, committedSinkId, request.payload.extent, active.signal,
      )
      if (this.webmAssembly !== active || active.signal.aborted) {
        await this.startWorldWebmAbort(active, committedSinkId)
        return
      }
      active.committed = result
      active.stage = 'committed'
      this.postWorldWebmSuccess(request, result)
    } catch (error) {
      if (this.webmAssembly !== active || active.signal.aborted) return
      const code = error instanceof WorldWebmAuthorityError ? error.code
        : request.kind === 'read-frame' || request.kind === 'read-audio' ? 'read-failed'
          : 'write-failed'
      this.postWorldWebmFailure(request, code, boundedIssueMessage(error))
    }
  }

  private acceptWorldWebmProgress(
    active: ActiveWebmAssembly,
    progress: Extract<WorldWebmWorkerEvent, { kind: 'progress' }>['payload'],
  ): boolean {
    const phase = ['preflighting', 'encoding', 'finalizing'].indexOf(progress.phase)
    if (phase < active.lastProgressPhase || progress.frameCount !== active.payload.frameCount
      || progress.audioSampleCount !== active.payload.audioSampleCount
      || progress.completedFrames < active.lastProgress.completedFrames
      || progress.completedAudioSamples < active.lastProgress.completedAudioSamples) return false
    active.lastProgressPhase = phase
    active.lastProgress = {
      completedFrames: progress.completedFrames,
      completedAudioSamples: progress.completedAudioSamples,
    }
    return true
  }

  private postWorldWebmSuccess(request: WorldWebmWorkerRequest, payload: WorldWebmSuccessPayload): void {
    if (this.closed) return
    const response = {
      protocol: WORLD_WEBM_PROTOCOL,
      jobId: this.jobId,
      generation: this.generation,
      requestId: request.requestId,
      kind: 'response',
      requestKind: request.kind,
      ok: true,
      payload,
    }
    if (!parseWorldWebmMainResponse(response)) {
      this.postWorldWebmFailure(request, 'master-invalid', 'World WebM authority returned an invalid result.')
      return
    }
    try { this.port.postMessage(response) }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }

  private postWorldWebmFailure(
    request: WorldWebmWorkerRequest,
    code: Extract<WorldWebmMainResponse, { ok: false }>['error']['code'],
    message: string,
  ): void {
    if (this.closed) return
    const response: WorldWebmMainResponse = {
      protocol: WORLD_WEBM_PROTOCOL,
      jobId: this.jobId,
      generation: this.generation,
      requestId: request.requestId,
      kind: 'response',
      requestKind: request.kind,
      ok: false,
      error: { code, message: boundedIssueMessage(message) },
    }
    try { this.port.postMessage(response) }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }

  private postWorldWebmAbort(active: ActiveWebmAssembly): void {
    if (this.closed) return
    const requestId = Math.min(WORLD_WEBM_MAX_REQUEST_ID, Math.max(active.requestId + 1, this.requestId + 1))
    this.requestId = Math.max(this.requestId, requestId)
    try {
      this.port.postMessage({
        protocol: WORLD_WEBM_PROTOCOL,
        jobId: this.jobId,
        generation: this.generation,
        requestId,
        kind: 'abort',
        payload: {},
      })
    } catch { /* main-owned sink abort remains authoritative */ }
  }

  private startWorldWebmAbort(
    active: ActiveWebmAssembly,
    sinkId: string,
  ): Promise<boolean> {
    const existing = active.sinkAbortions.get(sinkId)
    if (existing) return existing.observed
    let raw: Promise<true>
    try {
      raw = this.webmAuthority
        ? this.webmAuthority.abortWebmAssembly(this.jobId, this.generation, sinkId)
        : Promise.reject(new Error('World WebM repository authority is unavailable.'))
    } catch (error) {
      raw = Promise.reject(error)
    }
    const observed = Promise.resolve(raw).then((acknowledgement) => acknowledgement === true, () => false)
    void observed.catch(() => undefined)
    active.sinkAbortions.set(sinkId, { raw, observed })
    return observed
  }

  private async finishWorldWebm(
    active: ActiveWebmAssembly,
    outcome: 'succeeded' | 'failure' | 'cancelled',
    failureCode: WorldWebmFailureCode = 'internal-failed',
    error?: Error,
  ): Promise<void> {
    if (this.webmAssembly !== active) return
    this.webmAssembly = null
    active.cleanup()
    let sinkId = active.sinkId
    let cleanupFailed = false
    let confirmed = false
    if (sinkId && outcome !== 'succeeded') this.startWorldWebmAbort(active, sinkId)
    const queueOutcome = await settleWorldWebmPhase({
      operation: active.requestQueue,
      timeoutMs: this.webmSettlementTimeoutMs,
    })
    if (queueOutcome.status !== 'fulfilled') cleanupFailed = true
    sinkId ??= active.sinkId
    active.sinkId = null
    if (sinkId && this.webmAuthority) {
      if (outcome === 'succeeded' && !cleanupFailed) {
        let confirmation: Promise<true>
        try {
          confirmation = this.webmAuthority.confirmWebmAssembly(this.jobId, this.generation, sinkId)
        } catch (error) {
          confirmation = Promise.reject(error)
        }
        const confirmationOutcome = await settleWorldWebmPhase({
          operation: confirmation,
          timeoutMs: this.webmSettlementTimeoutMs,
          onLateFulfilled: async (acknowledgement) => {
            if (acknowledgement === true) await this.startWorldWebmAbort(active, sinkId as string)
          },
        })
        confirmed = confirmationOutcome.status === 'fulfilled' && confirmationOutcome.value === true
        if (!confirmed) cleanupFailed = true
      }
      if (!confirmed || active.signal.aborted) {
        const cleanup = this.startWorldWebmAbort(active, sinkId)
        const cleanupOutcome = await settleWorldWebmPhase({
          operation: cleanup,
          timeoutMs: this.webmSettlementTimeoutMs,
        })
        if (cleanupOutcome.status !== 'fulfilled' || !cleanupOutcome.value) {
          cleanupFailed = true
        }
      }
    }
    if (active.signal.aborted) active.reject(abortError('World WebM assembly was cancelled.'))
    else if (outcome === 'succeeded' && confirmed && !cleanupFailed) active.resolve({ ok: true })
    else if (outcome === 'cancelled') active.reject(error ?? abortError('World WebM assembly was cancelled.'))
    else active.resolve({ ok: false, code: cleanupFailed ? 'sink-failed' : failureCode })
  }

  private async handleResourceRequest(request: WorldRenderHostResourcePortRequest): Promise<void> {
    if (request.jobId !== this.jobId || request.generation !== this.generation || this.closed) return
    this.resourceRequestCount += 1
    if (this.failure || (!this.initializing && !this.initialized) || request.requestId <= this.lastResourceRequestId
      || this.resourceRequestCount > WORLD_RENDER_HOST_MAX_RESOURCE_REQUESTS
      || this.resourceReads.size >= WORLD_RENDER_HOST_MAX_CONCURRENT_RESOURCE_REQUESTS) {
      this.postResourceFailure(request, 'invalid-request', 'Pinned resource request is invalid.')
      return
    }
    this.lastResourceRequestId = request.requestId
    const expected = this.allowedResources.get(resourceKey(request.resourceId, request.role))
    if (!expected) {
      this.postResourceFailure(request, 'resource-not-found', 'Pinned resource is not part of this render snapshot.')
      return
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const active: ActiveResourceRead = { request, controller, timeout }
    this.resourceReads.set(request.requestId, active)
    const onAbort = (): void => {
      if (this.resourceReads.get(request.requestId) !== active) return
      this.finishResourceRead(active)
      if (!this.closed) this.postResourceFailure(request, 'resource-invalid', 'Pinned resource request timed out.')
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const resource = await this.readPinnedResource(this.jobId, request.resourceId, request.role, controller.signal)
      if (controller.signal.aborted || this.resourceReads.get(request.requestId) !== active || this.closed) return
      const bytes = Uint8Array.from(resource.bytes)
      if (resource.resourceId !== expected.resourceId || resource.role !== expected.role
        || resource.size !== expected.size || resource.sha256 !== expected.sha256
        || bytes.byteLength !== expected.size || bytes.byteLength > WORLD_RENDER_HOST_MAX_RESOURCE_BYTES
        || sha256Bytes(bytes) !== expected.sha256) {
        throw new Error('Pinned resource identity changed while reading.')
      }
      this.finishResourceRead(active)
      const buffer = bytes.buffer as ArrayBuffer
      this.postResourceResult(request, {
        ok: true,
        resourceId: request.resourceId,
        role: request.role,
        size: bytes.byteLength,
        sha256: expected.sha256,
        bytes: buffer,
      })
    } catch {
      if (controller.signal.aborted || this.resourceReads.get(request.requestId) !== active || this.closed) return
      this.finishResourceRead(active)
      this.postResourceFailure(request, 'resource-invalid', 'Pinned resource failed validation.')
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private finishResourceRead(active: ActiveResourceRead): void {
    if (this.resourceReads.get(active.request.requestId) !== active) return
    this.resourceReads.delete(active.request.requestId)
    clearTimeout(active.timeout)
  }

  private abortResourceReads(): void {
    const reads = [...this.resourceReads.values()]
    this.resourceReads.clear()
    for (const active of reads) {
      clearTimeout(active.timeout)
      active.controller.abort()
    }
  }

  private postResourceFailure(
    request: WorldRenderHostResourcePortRequest,
    code: WorldRenderHostResourceFailureCode,
    message: string,
  ): void {
    this.postResourceResult(request, { ok: false, code, message })
  }

  private postResourceResult(
    request: WorldRenderHostResourcePortRequest,
    result: WorldRenderHostResourceResult,
  ): void {
    if (this.closed) return
    const response: WorldRenderHostResourcePortResult = {
      protocol: WORLD_RENDER_HOST_PROTOCOL,
      jobId: this.jobId,
      generation: this.generation,
      kind: 'resource-result',
      requestId: request.requestId,
      result,
    }
    try { this.port.postMessage(response) }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }
}

class ElectronWorldRenderHostSession implements WorldRenderHostSession {
  private readonly jobId: string
  private readonly generation: string
  private readonly timeoutMs: number
  private readonly window: BrowserWindow
  private readonly port: MessagePortMain
  private readonly isolatedSession: Session
  private readonly channel: WorldRenderMainPortChannel
  private readonly cleanupTimeoutMs: number
  private disposal: Promise<void> | null = null

  private constructor(input: {
    jobId: string
    generation: string
    timeoutMs: number
    window: BrowserWindow
    port: MessagePortMain
    isolatedSession: Session
    outputRepository: WorldRenderOutputRepository
    cleanupTimeoutMs: number
  }) {
    this.jobId = input.jobId
    this.generation = input.generation
    this.timeoutMs = input.timeoutMs
    this.window = input.window
    this.port = input.port
    this.isolatedSession = input.isolatedSession
    this.cleanupTimeoutMs = input.cleanupTimeoutMs
    this.channel = new WorldRenderMainPortChannel({
      jobId: this.jobId,
      generation: this.generation,
      timeoutMs: this.timeoutMs,
      port: adaptMessagePortMain(this.port),
      readPinnedResource: (jobId, resourceId, role, signal) => (
        input.outputRepository.readPinnedResource(jobId, resourceId, role, signal)
      ),
      webmAuthority: input.outputRepository,
    })
    this.window.webContents.on('render-process-gone', (_event, details) => this.channel.fail(
      new Error(`World render host process exited (${details.reason}, ${details.exitCode}).`),
      'worker-crashed',
    ))
    this.window.on('unresponsive', () => this.channel.fail(
      new Error('World render host became unresponsive.'),
      'worker-timeout',
    ))
  }

  static async create(input: {
    jobId: string
    generation: string
    timeoutMs: number
    outputRepository: WorldRenderOutputRepository
    signal: AbortSignal
    admissionDeadlineMs: number
    cleanupTimeoutMs: number
    loadElectron: () => Promise<typeof import('electron')>
    moduleDirectory: string
  }): Promise<ElectronWorldRenderHostSession> {
    const electron = await settleElectronAdmissionOperation({
      operation: input.loadElectron(),
      signal: input.signal,
      admissionDeadlineMs: input.admissionDeadlineMs,
    })
    assertElectronAdmissionActive(input.signal, input.admissionDeadlineMs)
    const partition = `world-render-${input.generation}`
    const isolatedSession = electron.session.fromPartition(partition, { cache: false })
    isolatedSession.setPermissionCheckHandler(() => false)
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    isolatedSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    )
    const window = new electron.BrowserWindow({
      width: 64,
      height: 64,
      show: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: join(input.moduleDirectory, '../preload/world-render.js'),
        session: isolatedSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    })
    window.setMenuBarVisibility(false)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    const htmlPath = resolve(input.moduleDirectory, '../renderer/world-render.html')
    const onAbort = (): void => {
      if (!window.isDestroyed()) window.destroy()
    }
    input.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await settleElectronAdmissionOperation({
        operation: window.loadFile(htmlPath),
        signal: input.signal,
        admissionDeadlineMs: input.admissionDeadlineMs,
      })
      assertElectronAdmissionActive(input.signal, input.admissionDeadlineMs)
      const { port1, port2 } = new electron.MessageChannelMain()
      const host = new ElectronWorldRenderHostSession({ ...input, window, port: port1, isolatedSession })
      window.webContents.postMessage(WORLD_RENDER_HOST_CONNECT_CHANNEL, {
        protocol: WORLD_RENDER_HOST_PROTOCOL,
        jobId: input.jobId,
        generation: input.generation,
      }, [port2])
      return host
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      throw error
    } finally {
      input.signal.removeEventListener('abort', onAbort)
    }
  }

  async initialize(payload: WorldRenderHostInitializePayload, signal: AbortSignal): Promise<void> {
    await this.channel.initialize(payload, signal)
  }

  async renderFrame(payload: WorldRenderHostFrameRequest, signal: AbortSignal): Promise<Uint8Array> {
    return this.channel.renderFrame(payload, signal)
  }

  async renderAudio(signal: AbortSignal): Promise<Uint8Array> {
    return this.channel.renderAudio(signal)
  }

  async assembleWebm(payload: WorldWebmStartPayload, signal: AbortSignal): Promise<WorldWebmAssemblyOutcome> {
    return this.channel.assembleWebm(payload, signal)
  }

  dispose(): Promise<void> {
    this.disposal ??= this.performDispose()
    return this.disposal
  }

  private async performDispose(): Promise<void> {
    if (!this.window.isDestroyed()) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 2_000))
      timeout.unref?.()
      try { await this.channel.disposeRenderer(controller.signal) }
      catch { /* forced cleanup below is authoritative */ }
      finally { clearTimeout(timeout) }
    }
    this.channel.close()
    if (!this.window.isDestroyed()) this.window.destroy()
    const physicalCleanup = Promise.allSettled([
      Promise.resolve().then(() => this.isolatedSession.clearStorageData()),
      Promise.resolve().then(() => this.isolatedSession.clearCache()),
    ]).then(() => undefined)
    await settleWorldWebmPhase({ operation: physicalCleanup, timeoutMs: this.cleanupTimeoutMs })
  }
}

export async function createElectronWorldRenderHostSession(input: {
  readonly jobId: string
  readonly generation: string
  readonly outputRepository?: WorldRenderOutputRepository
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly admissionDeadlineMs: number
  readonly cleanupTimeoutMs: number
}, dependencies: {
  readonly loadElectron?: () => Promise<typeof import('electron')>
  readonly moduleDirectory?: string
} = {}): Promise<WorldRenderHostSession> {
  if (!input.outputRepository) throw new TypeError('World render output repository is required.')
  boundedSessionPhaseTimeout(input.cleanupTimeoutMs, 'cleanup')
  if (!Number.isSafeInteger(input.admissionDeadlineMs) || input.admissionDeadlineMs < 0) {
    throw new TypeError('World render host admission deadline is invalid.')
  }
  return ElectronWorldRenderHostSession.create({
    ...input,
    outputRepository: input.outputRepository,
    loadElectron: dependencies.loadElectron ?? (() => import('electron')),
    moduleDirectory: dependencies.moduleDirectory ?? __dirname,
  })
}

function assertElectronAdmissionActive(signal: AbortSignal, admissionDeadlineMs: number): void {
  if (signal.aborted) throw abortError('World render host session admission was cancelled.')
  if (Date.now() >= admissionDeadlineMs) throw new Error('World render host session admission timed out.')
}

function settleElectronAdmissionOperation<T>(input: {
  readonly operation: Promise<T>
  readonly signal: AbortSignal
  readonly admissionDeadlineMs: number
}): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let waiting = true
    const remainingMs = input.admissionDeadlineMs - Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (callback: () => void): void => {
      if (!waiting) return
      waiting = false
      if (timer) clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => rejectPromise(
      abortError('World render host session admission was cancelled.'),
    ))
    input.signal.addEventListener('abort', onAbort, { once: true })
    if (input.signal.aborted) onAbort()
    else if (remainingMs <= 0) finish(() => rejectPromise(
      new Error('World render host session admission timed out.'),
    ))
    else {
      timer = setTimeout(() => finish(() => rejectPromise(
        new Error('World render host session admission timed out.'),
      )), remainingMs)
      timer.unref?.()
    }
    void input.operation.then(
      (value) => finish(() => resolvePromise(value)),
      (error: unknown) => finish(() => rejectPromise(error)),
    )
  })
}

function adaptMessagePortMain(port: MessagePortMain): WorldRenderHostPort {
  return {
    onMessage: (listener) => { port.on('message', listener) },
    onMessageError: (listener) => {
      ;(port as unknown as { on(event: 'messageerror', callback: () => void): void }).on('messageerror', listener)
    },
    onClose: (listener) => { port.on('close', listener) },
    // Electron's main-process API accepts only MessagePortMain objects in its
    // transfer list. ArrayBuffers still cross the direct job port as bounded
    // structured-clone data and never cross contextBridge.
    postMessage: (value) => port.postMessage(value),
    start: () => port.start(),
    close: () => port.close(),
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError('World render request was cancelled.')
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

type WorldWebmPhaseOutcome<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'timeout' }

function settleWorldWebmPhase<T>(input: {
  readonly operation: Promise<T>
  readonly timeoutMs: number
  readonly onLateFulfilled?: (value: T) => void | Promise<void>
}): Promise<WorldWebmPhaseOutcome<T>> {
  return new Promise((resolvePromise) => {
    let waiting = true
    const timer = setTimeout(() => {
      if (!waiting) return
      waiting = false
      resolvePromise({ status: 'timeout' })
    }, input.timeoutMs)
    const settle = (outcome: WorldWebmPhaseOutcome<T>): void => {
      if (!waiting) return
      waiting = false
      clearTimeout(timer)
      resolvePromise(outcome)
    }
    void input.operation.then(
      (value) => {
        if (waiting) {
          settle({ status: 'fulfilled', value })
          return
        }
        if (input.onLateFulfilled) {
          try { void Promise.resolve(input.onLateFulfilled(value)).catch(() => undefined) }
          catch { /* late compensation remains fail-closed */ }
        }
      },
      (error: unknown) => {
        if (waiting) settle({ status: 'rejected', error })
        // A late rejection is deliberately consumed by this handler.
      },
    )
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function boundedIssueMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const source = message || 'World render host failed.'
  let sanitized = ''
  for (let index = 0; index < source.length && sanitized.length < 512; index += 1) {
    const code = source.charCodeAt(index)
    sanitized += code <= 0x1f || code === 0x7f ? ' ' : source[index]
  }
  return sanitized
}

function describeResponseShape(value: unknown): string {
  if (Array.isArray(value)) return `array:length=${value.length},items=${value.map((item) => typeof item).join('|')}`
  if (!value || typeof value !== 'object') return typeof value
  const record = value as Record<string, unknown>
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : null
  const bytes = payload?.rgba instanceof ArrayBuffer ? payload.rgba.byteLength
    : payload?.wav instanceof ArrayBuffer ? payload.wav.byteLength
      : null
  return `kind=${String(record.kind)},ok=${String(record.ok)},keys=${Object.keys(record).sort().join('|')},payload=${payload ? Object.keys(payload).sort().join('|') : 'none'},bytes=${String(bytes)}`
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function resourceKey(resourceId: string, role: WorldRenderPinnedResourceRole): string {
  return `${resourceId}\u0000${role}`
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

class WorldWebmAuthorityError extends Error {
  readonly code: Extract<WorldWebmMainResponse, { ok: false }>['error']['code']

  constructor(code: Extract<WorldWebmMainResponse, { ok: false }>['error']['code'], message: string) {
    super(message)
    this.name = 'WorldWebmAuthorityError'
    this.code = code
  }
}

function isWorldWebmProtocolMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'protocol')
    return Boolean(descriptor && 'value' in descriptor && descriptor.value === WORLD_WEBM_PROTOCOL)
  } catch {
    return false
  }
}

function worldWebmPreflightMatches(
  plan: WorldWebmStartPayload,
  preflight: Extract<WorldWebmWorkerRequest, { kind: 'preflight' }>['payload'],
): boolean {
  return preflight.width === plan.width && preflight.height === plan.height && preflight.fps === plan.fps
    && preflight.videoCodec === 'vp9' && preflight.videoBitrate === plan.videoBitrate
    && preflight.audioCodec === 'opus' && preflight.audioBitrate === plan.audioBitrate
    && preflight.audioSampleRate === 48_000 && preflight.audioChannels === 2
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Encodes bounded bottom-up WebGL RGBA8 pixels as a canonical top-down PNG. */
function encodeWorldRenderRgbaPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width * 4
  const expectedBytes = rowBytes * height
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || rgba.byteLength !== expectedBytes || expectedBytes > WORLD_RENDER_HOST_MAX_FRAME_BYTES) {
    throw new Error('World render host returned an invalid RGBA payload.')
  }
  const scanlineBytes = expectedBytes + height
  if (!Number.isSafeInteger(scanlineBytes) || scanlineBytes > WORLD_RENDER_HOST_MAX_FRAME_BYTES) {
    throw new Error('World render host RGBA scanlines exceed the supported bound.')
  }
  const scanlines = Buffer.allocUnsafe(scanlineBytes)
  for (let outputRow = 0; outputRow < height; outputRow += 1) {
    const outputOffset = outputRow * (rowBytes + 1)
    const sourceOffset = (height - outputRow - 1) * rowBytes
    scanlines[outputOffset] = 0
    scanlines.set(rgba.subarray(sourceOffset, sourceOffset + rowBytes), outputOffset + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const compressed = deflateSync(scanlines, { level: 9 })
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  if (png.byteLength > WORLD_RENDER_HOST_MAX_FRAME_BYTES) {
    throw new Error('Encoded world render PNG exceeds the supported bound.')
  }
  return png
}

function pngChunk(type: 'IHDR' | 'IDAT' | 'IEND', data: Uint8Array): Buffer {
  const name = Buffer.from(type, 'ascii')
  const result = Buffer.allocUnsafe(data.byteLength + 12)
  result.writeUInt32BE(data.byteLength, 0)
  name.copy(result, 4)
  result.set(data, 8)
  result.writeUInt32BE(crc32Parts(name, data), data.byteLength + 8)
  return result
}

function crc32Parts(first: Uint8Array, second: Uint8Array): number {
  let value = 0xffff_ffff
  for (const bytes of [first, second]) {
    for (const byte of bytes) {
      value ^= byte
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1))
    }
  }
  return (value ^ 0xffff_ffff) >>> 0
}

function assertPngHeader(bytes: Uint8Array, width: number, height: number): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.byteLength < 24 || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error('World render host returned a non-PNG frame.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(16, false) !== width || view.getUint32(20, false) !== height) {
    throw new Error('World render host returned PNG dimensions that do not match the render preset.')
  }
}

function assertPcm16StereoWav(bytes: Uint8Array, sampleCount: number): void {
  if (bytes.byteLength !== 44 + sampleCount * 4
    || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE'
    || ascii(bytes, 12, 4) !== 'fmt ' || ascii(bytes, 36, 4) !== 'data') {
    throw new Error('World render host returned an invalid WAV container.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, true) !== bytes.byteLength - 8 || view.getUint32(16, true) !== 16
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 2
    || view.getUint32(24, true) !== 48_000 || view.getUint32(28, true) !== 192_000
    || view.getUint16(32, true) !== 4 || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== sampleCount * 4) {
    throw new Error('World render host returned WAV metadata that does not match stereo PCM16 at 48 kHz.')
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index])
  return value
}
