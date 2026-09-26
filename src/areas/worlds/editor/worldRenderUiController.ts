import type {
  WorldRenderJobDetail,
  WorldRenderJobSummary,
  WorldRenderPreset,
  WorldRenderProgress,
  WorldRenderPublicError,
} from '../../../shared/types/worldRenders.ts'
import { worldRenderService, type WorldRenderService } from '../worldRenderService.ts'

const POLL_INTERVAL_MS = 600
const POLL_RETRY_MAX_DELAY_MS = 4_800
const ACTIVE_STATUSES = new Set<WorldRenderJobDetail['status']>([
  'queued', 'preflighting', 'rendering-frames', 'rendering-audio', 'assembling', 'cancel_requested',
])
const TERMINAL_STATUSES = new Set<WorldRenderJobDetail['status']>([
  'cancelled', 'interrupted', 'failed', 'partial', 'succeeded', 'recovery_failed',
])
const PHASE_RANK: Record<WorldRenderProgress['phase'], number> = {
  queued: 0,
  preflighting: 1,
  'rendering-frames': 2,
  'rendering-audio': 3,
  assembling: 4,
  complete: 5,
}

export interface WorldRenderUiTarget {
  readonly projectKey: string
  readonly revision: number
  readonly sceneId: string
  readonly sequenceId: string
  readonly preset: WorldRenderPreset
}

export interface WorldRenderUiState {
  readonly target: WorldRenderUiTarget | null
  readonly loading: boolean
  readonly action: 'idle' | 'creating' | 'cancelling' | 'deleting'
  readonly job: WorldRenderJobDetail | null
  readonly error: WorldRenderPublicError | null
}

export interface WorldRenderScheduler {
  setTimeout(callback: () => void, delayMs: number): number
  clearTimeout(id: number): void
}

export interface WorldRenderUiController {
  getState(): WorldRenderUiState
  subscribe(listener: () => void): () => void
  open(target: WorldRenderUiTarget): Promise<void>
  refresh(): Promise<void>
  start(): Promise<void>
  retry(): Promise<void>
  cancel(): Promise<void>
  delete(): Promise<void>
  dispose(): void
}

export interface WorldRenderJobDescription {
  label: string
  detail: string
  tone: 'neutral' | 'progress' | 'success' | 'warning' | 'danger'
  retry: boolean
}

export function createWorldRenderUiController(options: {
  service?: WorldRenderService
  scheduler?: WorldRenderScheduler
  beforeStart?: () => void
} = {}): WorldRenderUiController {
  const service = options.service ?? worldRenderService
  const scheduler = options.scheduler ?? browserScheduler()
  const beforeStart = options.beforeStart ?? (() => undefined)
  let state: WorldRenderUiState = { target: null, loading: false, action: 'idle', job: null, error: null }
  let generation = 0
  let disposed = false
  let pollTimer: number | null = null
  let pollRetryDelayMs = POLL_INTERVAL_MS
  const listeners = new Set<() => void>()

  const publish = (patch: Partial<WorldRenderUiState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const clearPoll = () => {
    if (pollTimer === null) return
    scheduler.clearTimeout(pollTimer)
    pollTimer = null
  }
  const resetPolling = () => {
    clearPoll()
    pollRetryDelayMs = POLL_INTERVAL_MS
  }
  const schedulePoll = (delayMs = POLL_INTERVAL_MS) => {
    clearPoll()
    if (disposed || !state.job || !ACTIVE_STATUSES.has(state.job.status)
      || !matchesTarget(state.job, state.target)) return
    const token = generation
    const jobId = state.job.jobId
    pollTimer = scheduler.setTimeout(() => {
      pollTimer = null
      void poll(token, jobId)
    }, delayMs)
  }
  const schedulePollRetry = () => {
    pollRetryDelayMs = Math.min(pollRetryDelayMs * 2, POLL_RETRY_MAX_DELAY_MS)
    schedulePoll(pollRetryDelayMs)
  }
  const poll = async (token: number, jobId: string) => {
    const result = await service.get({ jobId })
    if (disposed || token !== generation || state.job?.jobId !== jobId) return
    if (!result.ok) {
      publish({ error: result.error })
      if (result.error.retryable) schedulePollRetry()
      else pollRetryDelayMs = POLL_INTERVAL_MS
      return
    }
    pollRetryDelayMs = POLL_INTERVAL_MS
    if (matchesTarget(result.value, state.target) && shouldAdoptProgress(state.job, result.value)) {
      publish({ job: result.value, error: null })
    }
    schedulePoll()
  }

  const open = async (target: WorldRenderUiTarget) => {
    if (disposed) disposed = false
    generation += 1
    const token = generation
    resetPolling()
    const pinned = cloneTarget(target)
    publish({ target: pinned, loading: true, action: 'idle', job: null, error: null })
    const listed = await service.list()
    if (disposed || token !== generation) return
    if (!listed.ok) {
      publish({ loading: false, error: listed.error })
      return
    }
    const latest = listed.value.jobs
      .filter((candidate) => matchesTarget(candidate, pinned))
      .sort(compareNewestFirst)[0]
    if (!latest) {
      publish({ loading: false, job: null, error: null })
      return
    }
    const loaded = await service.get({ jobId: latest.jobId })
    if (disposed || token !== generation) return
    if (!loaded.ok) {
      publish({ loading: false, error: loaded.error })
      return
    }
    if (!matchesTarget(loaded.value, pinned)) {
      publish({ loading: false, error: invalidResponse() })
      return
    }
    publish({ loading: false, job: loaded.value, error: null })
    schedulePoll()
  }

  const start = async (retryFrom: string | null = null) => {
    if (disposed || !state.target || state.action !== 'idle') return
    generation += 1
    const token = generation
    resetPolling()
    const target = cloneTarget(state.target)
    publish({ action: 'creating', error: null })
    beforeStart()
    const result = await service.create({
      projectKey: target.projectKey,
      expectedRevision: target.revision,
      sceneId: target.sceneId,
      sequenceId: target.sequenceId,
      preset: { ...target.preset },
    })
    if (disposed || token !== generation) return
    if (!result.ok) {
      publish({ action: 'idle', error: result.error })
      return
    }
    if (!matchesExactTarget(result.value, target) || (retryFrom !== null && result.value.jobId === retryFrom)) {
      publish({ action: 'idle', error: invalidResponse() })
      return
    }
    publish({ action: 'idle', job: result.value, error: null })
    schedulePoll()
  }

  const cancel = async () => {
    if (disposed || state.action !== 'idle' || !state.job || !canCancelWorldRenderJob(state.job)) return
    generation += 1
    const token = generation
    const jobId = state.job.jobId
    resetPolling()
    publish({ action: 'cancelling', error: null })
    const result = await service.cancel({ jobId })
    if (disposed || token !== generation) return
    if (!result.ok) {
      publish({ action: 'idle', error: result.error })
      schedulePoll()
      return
    }
    if (result.value.jobId !== jobId || !matchesTarget(result.value, state.target)) {
      publish({ action: 'idle', error: invalidResponse() })
      return
    }
    publish({ action: 'idle', job: result.value, error: null })
    schedulePoll()
  }

  const remove = async () => {
    if (disposed || state.action !== 'idle' || !state.job || !TERMINAL_STATUSES.has(state.job.status)) return
    generation += 1
    const token = generation
    const jobId = state.job.jobId
    resetPolling()
    publish({ action: 'deleting', error: null })
    const result = await service.delete({ jobId })
    if (disposed || token !== generation) return
    if (!result.ok) {
      publish({ action: 'idle', error: result.error })
      return
    }
    if (result.value.jobId !== jobId) {
      publish({ action: 'idle', error: invalidResponse() })
      return
    }
    publish({ action: 'idle', job: null, error: null })
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    open,
    refresh: async () => { if (state.target) await open(state.target) },
    start: () => start(),
    retry: () => start(state.job?.jobId ?? null),
    cancel,
    delete: remove,
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      resetPolling()
      listeners.clear()
      state = { ...state, loading: false, action: 'idle', job: null }
    },
  }
}

export function worldRenderProgressPercent(progress: WorldRenderProgress): number {
  if (progress.totalUnits <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(progress.completedUnits / progress.totalUnits * 100)))
}

export function canCancelWorldRenderJob(job: WorldRenderJobDetail): boolean {
  return ACTIVE_STATUSES.has(job.status) && job.status !== 'cancel_requested'
}

export function describeWorldRenderJob(job: WorldRenderJobDetail): WorldRenderJobDescription {
  if (job.status === 'succeeded') return {
    label: 'WebM ready', detail: job.outputs.webm?.workspacePath ?? 'Video unavailable', tone: 'success', retry: false,
  }
  if (job.status === 'partial') return {
    label: 'Masters kept', detail: 'PNG + WAV kept · video failed', tone: 'warning', retry: true,
  }
  if (job.status === 'cancelled') return { label: 'Cancelled', detail: 'Render cancelled', tone: 'neutral', retry: true }
  if (job.status === 'interrupted') return { label: 'Interrupted', detail: 'App closed during render', tone: 'warning', retry: true }
  if (job.status === 'failed') return { label: 'Failed', detail: job.error?.message ?? 'Render failed', tone: 'danger', retry: true }
  if (job.status === 'recovery_failed') return { label: 'Recovery failed', detail: job.error?.message ?? 'Render recovery failed', tone: 'danger', retry: true }
  if (job.status === 'cancel_requested') return { label: 'Cancelling', detail: `${worldRenderProgressPercent(job.progress)}%`, tone: 'progress', retry: false }
  const labels: Record<'queued' | 'preflighting' | 'rendering-frames' | 'rendering-audio' | 'assembling', string> = {
    queued: 'Queued', preflighting: 'Preparing', 'rendering-frames': 'Frames', 'rendering-audio': 'Audio', assembling: 'Video',
  }
  return { label: labels[job.status], detail: `${worldRenderProgressPercent(job.progress)}%`, tone: 'progress', retry: false }
}

function shouldAdoptProgress(current: WorldRenderJobDetail, next: WorldRenderJobDetail): boolean {
  if (current.jobId !== next.jobId) return false
  if (TERMINAL_STATUSES.has(current.status)) return false
  if (TERMINAL_STATUSES.has(next.status) || next.status === 'cancel_requested') return true
  if (next.progress.completedUnits < current.progress.completedUnits) return false
  if (next.progress.completedUnits === current.progress.completedUnits
    && PHASE_RANK[next.progress.phase] < PHASE_RANK[current.progress.phase]) return false
  return next.updatedAt >= current.updatedAt
}

function matchesTarget(job: WorldRenderJobDetail | WorldRenderJobSummary, target: WorldRenderUiTarget | null): boolean {
  return Boolean(target && job.projectKey === target.projectKey && job.sceneId === target.sceneId
    && job.sequenceId === target.sequenceId && job.revision === target.revision
    && job.preset.width === target.preset.width && job.preset.height === target.preset.height
    && job.preset.fps === target.preset.fps)
}

function matchesExactTarget(job: WorldRenderJobDetail, target: WorldRenderUiTarget): boolean {
  return matchesTarget(job, target)
}

function cloneTarget(target: WorldRenderUiTarget): WorldRenderUiTarget {
  return { ...target, preset: { ...target.preset } }
}

function compareNewestFirst(left: { updatedAt: string; createdAt: string; jobId: string }, right: { updatedAt: string; createdAt: string; jobId: string }): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || right.jobId.localeCompare(left.jobId)
}

function invalidResponse(): WorldRenderPublicError {
  return { code: 'output_invalid', message: 'World render response is invalid.', retryable: false }
}

function browserScheduler(): WorldRenderScheduler {
  return {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
    clearTimeout: (id) => globalThis.clearTimeout(id),
  }
}
