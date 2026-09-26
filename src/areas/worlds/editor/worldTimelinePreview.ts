import { evaluateWorldSequence, type WorldSequenceEventMarker } from '../cinematic/worldSequenceEvaluator.ts'
import { compareWorldRationalTime, normalizeWorldRationalTime } from '../cinematic/worldRationalTime.ts'
import { preflightWorldSequence } from '../cinematic/worldSequencePreflight.ts'
import type { WorldComponent } from '../core/worldComponentRegistry.ts'
import type {
  WorldProjectSnapshotV1,
  WorldPropertyValue,
  WorldRationalTime,
  WorldSceneDocumentV1,
  WorldSequence,
  WorldTransform,
} from '../core/worldModel.ts'
import { projectWorldScene, type WorldProjectedCamera } from './worldEditorProjection.ts'
import { snapWorldTimelineTime } from './worldTimelineModel.ts'
import type { WorldSequenceFps } from '../cinematic/worldRationalTime.ts'

export type WorldTimelinePreviewLifecycle = 'stopped' | 'paused' | 'playing'

export interface WorldTimelinePreviewInput {
  readonly snapshot: WorldProjectSnapshotV1
  readonly sceneId: string
  readonly sequenceId: string
  readonly fps: WorldSequenceFps
}

export interface WorldTimelinePreviewMediaState {
  readonly entityId: string
  readonly componentId: string
  readonly playing: boolean
}

export interface WorldTimelinePreviewFrame {
  readonly snapshot: WorldProjectSnapshotV1
  readonly sceneId: string
  readonly sequenceId: string
  readonly time: WorldRationalTime
  readonly markers: readonly WorldSequenceEventMarker[]
  readonly animationStates: readonly WorldTimelinePreviewMediaState[]
  readonly audioStates: readonly WorldTimelinePreviewMediaState[]
  readonly activeCamera: WorldProjectedCamera | null
}

export type WorldTimelinePreviewState =
  | { readonly lifecycle: 'stopped'; readonly frame: null }
  | { readonly lifecycle: 'paused' | 'playing'; readonly frame: WorldTimelinePreviewFrame }

export interface WorldTimelineAnimationFrameDriver {
  request(callback: (timestampMs: number) => void): number
  cancel(handle: number): void
}

export interface WorldTimelinePreviewController {
  getState(): WorldTimelinePreviewState
  subscribe(listener: (state: WorldTimelinePreviewState) => void): () => void
  play(input: WorldTimelinePreviewInput): void
  pause(): void
  seek(input: WorldTimelinePreviewInput, time: WorldRationalTime): void
  stop(): void
  dispose(): void
}

export interface CreateWorldTimelinePreviewFrameInput {
  readonly snapshot: WorldProjectSnapshotV1
  readonly sceneId: string
  readonly sequenceId: string
  readonly time: WorldRationalTime
  readonly previousTime?: WorldRationalTime
  readonly mode?: 'seek' | 'playback'
}

export function createWorldTimelinePreviewFrame(input: CreateWorldTimelinePreviewFrameInput): WorldTimelinePreviewFrame {
  assertPreviewable(input)
  return createValidatedWorldTimelinePreviewFrame(input)
}

function createValidatedWorldTimelinePreviewFrame(input: CreateWorldTimelinePreviewFrameInput): WorldTimelinePreviewFrame {
  const scene = findPreviewScene(input.snapshot, input.sceneId)
  const sequence = findPreviewSequence(scene, input.sequenceId)
  const evaluation = evaluateWorldSequence({
    scene,
    sequence,
    time: input.time,
    ...(input.previousTime ? { previousTime: input.previousTime } : {}),
    mode: input.mode ?? 'seek',
  })
  const snapshot = structuredClone(input.snapshot)
  const previewScene = findPreviewScene(snapshot, input.sceneId)
  const animationStates: WorldTimelinePreviewMediaState[] = []
  const audioStates: WorldTimelinePreviewMediaState[] = []

  for (const patch of evaluation.patches) {
    const entity = previewScene.entities.find((candidate) => candidate.id === patch.entityId)
    if (!entity) throw new Error(`Entity ${patch.entityId} disappeared while creating preview.`)
    if (patch.kind === 'transform') {
      entity.transform = mergePreviewTransform(entity.transform, patch.transform)
      continue
    }
    const component = entity.components.find((candidate) => candidate.id === patch.componentId)
    if (!component) throw new Error(`Component ${patch.componentId} disappeared while creating preview.`)
    if (patch.kind === 'component-property') {
      writePreviewComponentProperty(component, patch.property, patch.value)
      continue
    }
    const state = { entityId: patch.entityId, componentId: patch.componentId, playing: patch.playing }
    if (patch.media === 'animation') animationStates.push(state)
    else audioStates.push(state)
  }

  const projection = projectWorldScene(snapshot, input.sceneId, (workspacePath) => workspacePath)
  if (!projection.success) throw new Error(projection.issues[0]?.message ?? 'Preview scene cannot be projected.')
  const primaryCameras = projection.value.cameras.filter((camera) => camera.effectiveEnabled && camera.component.primary)
  if (primaryCameras.length > 1) throw new Error('Preview scene has more than one active primary camera.')

  return deepFreezePreview({
    snapshot,
    sceneId: input.sceneId,
    sequenceId: input.sequenceId,
    time: evaluation.time,
    markers: evaluation.markers.map((marker) => structuredClone(marker)),
    animationStates: animationStates.map((state) => ({ ...state })),
    audioStates: audioStates.map((state) => ({ ...state })),
    activeCamera: primaryCameras[0] ? structuredClone(primaryCameras[0]) : null,
  })
}

export function createWorldTimelinePreviewController(
  driver: WorldTimelineAnimationFrameDriver = browserAnimationFrameDriver(),
): WorldTimelinePreviewController {
  let state: WorldTimelinePreviewState = stoppedState()
  let activeInput: WorldTimelinePreviewInput | null = null
  let listeners = new Set<(state: WorldTimelinePreviewState) => void>()
  let scheduledHandle: number | null = null
  let anchorTimestampMs: number | null = null
  let anchorFrameIndex = 0
  let generation = 0

  const publish = (next: WorldTimelinePreviewState) => {
    state = next
    for (const listener of listeners) listener(state)
  }
  const cancelScheduled = () => {
    generation += 1
    if (scheduledHandle !== null) driver.cancel(scheduledHandle)
    scheduledHandle = null
  }
  const schedule = () => {
    const scheduledGeneration = generation
    scheduledHandle = driver.request((timestampMs) => {
      scheduledHandle = null
      if (scheduledGeneration !== generation || state.lifecycle !== 'playing' || !activeInput) return
      if (anchorTimestampMs === null) {
        anchorTimestampMs = timestampMs
        schedule()
        return
      }
      const elapsedMs = Math.max(0, timestampMs - anchorTimestampMs)
      const scene = findPreviewScene(activeInput.snapshot, activeInput.sceneId)
      const sequence = findPreviewSequence(scene, activeInput.sequenceId)
      const durationFrameIndex = worldTimelineFrameIndex(sequence.duration, activeInput.fps)
      const elapsedFrames = Number.isFinite(elapsedMs)
        ? Math.floor(elapsedMs * activeInput.fps / 1_000)
        : durationFrameIndex
      const targetFrameIndex = Math.min(durationFrameIndex, anchorFrameIndex + elapsedFrames)
      const targetTime = snapWorldTimelineTime(
        { numerator: targetFrameIndex, denominator: activeInput.fps },
        activeInput.fps,
        sequence.duration,
      )
      const previousTime = state.frame.time
      if (compareWorldRationalTime(targetTime, previousTime) > 0) {
        const frame = createValidatedWorldTimelinePreviewFrame({
          ...activeInput,
          time: targetTime,
          previousTime,
          mode: 'playback',
        })
        if (compareWorldRationalTime(frame.time, sequence.duration) >= 0) {
          publish({ lifecycle: 'paused', frame })
          return
        }
        publish({ lifecycle: 'playing', frame })
      }
      schedule()
    })
  }

  return {
    getState() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    play(input) {
      cancelScheduled()
      const scene = findPreviewScene(input.snapshot, input.sceneId)
      const sequence = findPreviewSequence(scene, input.sequenceId)
      assertPreviewable(input)
      const currentTime = activeInput?.fps === input.fps && matchesPreviewInput(state.frame, input)
        && compareWorldRationalTime(state.frame.time, sequence.duration) < 0
        ? state.frame.time
        : { numerator: 0, denominator: 1 }
      activeInput = clonePreviewInput(input)
      const frame = createValidatedWorldTimelinePreviewFrame({ ...activeInput, time: currentTime, mode: 'seek' })
      anchorTimestampMs = null
      anchorFrameIndex = worldTimelineFrameIndex(frame.time, input.fps)
      publish({ lifecycle: 'playing', frame })
      schedule()
    },
    pause() {
      if (state.lifecycle !== 'playing') return
      cancelScheduled()
      anchorTimestampMs = null
      publish({ lifecycle: 'paused', frame: state.frame })
    },
    seek(input, time) {
      cancelScheduled()
      assertPreviewable(input)
      activeInput = clonePreviewInput(input)
      const scene = findPreviewScene(activeInput.snapshot, activeInput.sceneId)
      const sequence = findPreviewSequence(scene, activeInput.sequenceId)
      const snapped = snapWorldTimelineTime(time, activeInput.fps, sequence.duration)
      const frame = createValidatedWorldTimelinePreviewFrame({ ...activeInput, time: snapped, mode: 'seek' })
      anchorTimestampMs = null
      anchorFrameIndex = worldTimelineFrameIndex(frame.time, activeInput.fps)
      publish({ lifecycle: 'paused', frame })
    },
    stop() {
      cancelScheduled()
      activeInput = null
      anchorTimestampMs = null
      anchorFrameIndex = 0
      if (state.lifecycle !== 'stopped') publish(stoppedState())
    },
    dispose() {
      cancelScheduled()
      activeInput = null
      anchorTimestampMs = null
      anchorFrameIndex = 0
      state = stoppedState()
      listeners.clear()
      listeners = new Set()
    },
  }
}

function assertPreviewable(input: Pick<WorldTimelinePreviewInput, 'snapshot' | 'sceneId' | 'sequenceId'>): void {
  const scene = findPreviewScene(input.snapshot, input.sceneId)
  const sequence = findPreviewSequence(scene, input.sequenceId)
  const preflight = preflightWorldSequence({ scene, sequence })
  if (!preflight.success) throw new Error(preflight.issues[0]?.message ?? 'Sequence cannot be previewed.')
}

function browserAnimationFrameDriver(): WorldTimelineAnimationFrameDriver {
  return {
    request(callback) {
      if (typeof requestAnimationFrame !== 'function') throw new Error('Timeline preview requires requestAnimationFrame.')
      return requestAnimationFrame(callback)
    },
    cancel(handle) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
    },
  }
}

function stoppedState(): WorldTimelinePreviewState {
  return Object.freeze({ lifecycle: 'stopped', frame: null })
}

function clonePreviewInput(input: WorldTimelinePreviewInput): WorldTimelinePreviewInput {
  return {
    snapshot: input.snapshot,
    sceneId: input.sceneId,
    sequenceId: input.sequenceId,
    fps: input.fps,
  }
}

function matchesPreviewInput(frame: WorldTimelinePreviewFrame | null, input: WorldTimelinePreviewInput): frame is WorldTimelinePreviewFrame {
  return !!frame
    && frame.snapshot.project.projectId === input.snapshot.project.projectId
    && frame.snapshot.project.revision === input.snapshot.project.revision
    && frame.sceneId === input.sceneId
    && frame.sequenceId === input.sequenceId
}

function worldTimelineFrameIndex(time: WorldRationalTime, fps: WorldSequenceFps): number {
  const normalized = normalizeWorldRationalTime(time)
  const numerator = BigInt(normalized.numerator) * BigInt(fps)
  const denominator = BigInt(normalized.denominator)
  const quotient = numerator / denominator
  const rounded = numerator % denominator * 2n >= denominator ? quotient + 1n : quotient
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Timeline preview frame exceeds the safe-integer range.')
  return Number(rounded)
}

function findPreviewScene(snapshot: WorldProjectSnapshotV1, sceneId: string): WorldSceneDocumentV1 {
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  if (!scene) throw new Error(`Scene ${sceneId} does not exist.`)
  return scene
}

function findPreviewSequence(scene: WorldSceneDocumentV1, sequenceId: string): WorldSequence {
  const sequence = scene.sequences.find((candidate) => candidate.id === sequenceId)
  if (!sequence) throw new Error(`Sequence ${sequenceId} does not exist.`)
  return sequence
}

function mergePreviewTransform(base: WorldTransform, patch: Partial<WorldTransform>): WorldTransform {
  return {
    position: patch.position ? [...patch.position] : [...base.position],
    rotation: patch.rotation ? [...patch.rotation] : [...base.rotation],
    scale: patch.scale ? [...patch.scale] : [...base.scale],
  }
}

function writePreviewComponentProperty(component: WorldComponent, property: string, value: WorldPropertyValue): void {
  const segments = property.split('.')
  let current: Record<string, unknown> = component as unknown as Record<string, unknown>
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = current[segments[index]]
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error(`Component property ${property} cannot be previewed.`)
    current = next as Record<string, unknown>
  }
  current[segments.at(-1)!] = Array.isArray(value) ? [...value] : value
}

function deepFreezePreview<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreezePreview(descriptor.value)
  }
  return Object.freeze(value)
}
