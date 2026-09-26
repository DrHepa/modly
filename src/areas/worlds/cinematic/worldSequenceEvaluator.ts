import type { WorldComponent, WorldComponentType, WorldWritableValue } from '../core/worldComponentRegistry.ts'
import type {
  WorldPropertyValue,
  WorldRationalTime,
  WorldSceneDocumentV1,
  WorldSequence,
  WorldSequenceTrack,
  WorldTransform,
  WorldTransformKeyframe,
  WorldVector3,
} from '../core/worldModel.ts'
import {
  clampWorldRationalTime,
  compareWorldRationalTime,
  normalizeWorldRationalTime,
  worldRationalDifferenceRatio,
} from './worldRationalTime.ts'

export type WorldSequenceEvaluationMode = 'playback' | 'seek'

export interface WorldSequenceEvaluationInput {
  readonly scene: WorldSceneDocumentV1
  readonly sequence: WorldSequence
  readonly time: WorldRationalTime
  readonly previousTime?: WorldRationalTime
  readonly mode?: WorldSequenceEvaluationMode
}

export type WorldSequenceEvaluatedPatch =
  | {
      readonly kind: 'transform'
      readonly trackIds: readonly string[]
      readonly entityId: string
      /** Only channels authored by at least one transform track are emitted. */
      readonly transform: Partial<WorldTransform>
    }
  | {
      readonly kind: 'component-property'
      readonly trackId: string
      readonly entityId: string
      readonly componentId: string
      readonly componentType: WorldComponentType
      readonly property: string
      readonly value: WorldWritableValue
    }
  | {
      readonly kind: 'playback-state'
      readonly media: 'animation' | 'audio'
      readonly trackId: string
      readonly entityId: string
      readonly componentId: string
      readonly playing: boolean
    }

export interface WorldSequenceEventMarker {
  readonly kind: 'event'
  readonly sequenceId: string
  readonly trackId: string
  readonly keyframeId: string
  readonly eventId: string
  readonly time: WorldRationalTime
}

export interface WorldSequenceEvaluation {
  readonly time: WorldRationalTime
  readonly patches: readonly WorldSequenceEvaluatedPatch[]
  /**
   * Timeline events are inert markers; behavior execution belongs to Play runtime.
   * Markers are globally ordered by exact time, then track ID, keyframe ID, and event ID.
   */
  readonly markers: readonly WorldSequenceEventMarker[]
}

export class WorldSequenceEvaluationError extends Error {
  readonly code: string
  readonly path: string

  constructor(code: string, path: string, message: string) {
    super(message)
    this.name = 'WorldSequenceEvaluationError'
    this.code = code
    this.path = path
  }
}

export function evaluateWorldSequence(input: WorldSequenceEvaluationInput): WorldSequenceEvaluation {
  const zero = { numerator: 0, denominator: 1 }
  const time = clampWorldRationalTime(input.time, zero, input.sequence.duration)
  const transformTracks = input.sequence.tracks.flatMap((track, trackIndex) => (
    track.type === 'transform' ? [{ track, trackIndex }] : []
  ))
  const patches = [
    ...evaluateTransformTracks(input.scene, transformTracks, time),
    ...input.sequence.tracks.flatMap((track, trackIndex) => (
      track.type === 'transform' ? [] : evaluateTrack(input.scene, track, trackIndex, time)
    )),
  ]
  const markers = evaluateEventCrossings(input, time)
  return { time, patches, markers }
}

function evaluateTransformTracks(
  scene: WorldSceneDocumentV1,
  entries: readonly { readonly track: Extract<WorldSequenceTrack, { type: 'transform' }>; readonly trackIndex: number }[],
  time: WorldRationalTime,
): WorldSequenceEvaluatedPatch[] {
  const groups = new Map<string, typeof entries[number][]>()
  for (const entry of entries) {
    const group = groups.get(entry.track.entityId) ?? []
    group.push(entry)
    groups.set(entry.track.entityId, group)
  }

  const patches: WorldSequenceEvaluatedPatch[] = []
  for (const [entityId, group] of [...groups].sort(([left], [right]) => codeUnitCompare(left, right))) {
    const entity = scene.entities.find((candidate) => candidate.id === entityId)
    if (!entity) {
      const first = group[0]
      throw new WorldSequenceEvaluationError('entity-reference', `sequence.tracks[${first.trackIndex}].entityId`, `Entity ${entityId} does not exist.`)
    }
    const authored = new Map<keyof WorldTransform, typeof group[number]>()
    for (const channel of ['position', 'rotation', 'scale'] as const) {
      const writers = group.filter(({ track }) => track.keyframes.some((keyframe) => keyframe.value[channel] !== undefined))
      if (writers.length > 1) {
        throw new WorldSequenceEvaluationError(
          'track-conflict',
          `sequence.tracks[${writers[1].trackIndex}]`,
          `Transform channel ${entityId}.${channel} has more than one writer.`,
        )
      }
      if (writers[0]) authored.set(channel, writers[0])
    }
    if (authored.size === 0) continue

    const transform: Partial<WorldTransform> = {}
    const position = authored.get('position')
    const rotation = authored.get('rotation')
    const scale = authored.get('scale')
    if (position) transform.position = sampleTransformChannel(position.track.keyframes, 'position', entity.transform.position, time)
    if (rotation) transform.rotation = sampleTransformChannel(rotation.track.keyframes, 'rotation', entity.transform.rotation, time)
    if (scale) transform.scale = sampleTransformChannel(scale.track.keyframes, 'scale', entity.transform.scale, time)
    patches.push({
      kind: 'transform',
      trackIds: [...new Set([...authored.values()].map(({ track }) => track.id))].sort(codeUnitCompare),
      entityId,
      transform,
    })
  }
  return patches
}

function evaluateTrack(
  scene: WorldSceneDocumentV1,
  track: Exclude<WorldSequenceTrack, { type: 'transform' }>,
  trackIndex: number,
  time: WorldRationalTime,
): WorldSequenceEvaluatedPatch[] {
  if (track.type === 'event') return []
  const path = `sequence.tracks[${trackIndex}]`
  const entity = scene.entities.find((candidate) => candidate.id === track.entityId)
  if (!entity) throw new WorldSequenceEvaluationError('entity-reference', `${path}.entityId`, `Entity ${track.entityId} does not exist.`)

  if (track.type === 'camera') {
    const camera = entity.components.find((component) => component.type === 'camera')
    if (camera?.type !== 'camera') throw new WorldSequenceEvaluationError('component-reference', `${path}.entityId`, `Entity ${track.entityId} has no camera component.`)
    return [{
      kind: 'component-property', trackId: track.id, entityId: track.entityId,
      componentId: camera.id, componentType: 'camera', property: 'primary',
      value: sampleDiscrete(track.keyframes, camera.primary, time),
    }]
  }

  const component = entity.components.find((candidate) => candidate.id === track.componentId)
  if (!component) throw new WorldSequenceEvaluationError('component-reference', `${path}.componentId`, `Component ${track.componentId} does not exist.`)

  if (track.type === 'animation') {
    assertComponentType(component, 'animation-player', path)
    return [{ kind: 'playback-state', media: 'animation', trackId: track.id, entityId: track.entityId, componentId: component.id, playing: sampleDiscrete(track.keyframes, component.autoplay, time) }]
  }
  if (track.type === 'audio') {
    assertComponentType(component, 'audio-source', path)
    return [{ kind: 'playback-state', media: 'audio', trackId: track.id, entityId: track.entityId, componentId: component.id, playing: sampleDiscrete(track.keyframes, component.autoplay, time) }]
  }
  if (track.type === 'light') {
    assertComponentType(component, 'light', path)
    return [{
      kind: 'component-property', trackId: track.id, entityId: track.entityId, componentId: component.id,
      componentType: 'light', property: 'intensity', value: sampleContinuous(track.keyframes, component.intensity, time),
    }]
  }

  const baseValue = readTimelineComponentProperty(component, track.property)
  if (!isWorldPropertyValue(baseValue)) {
    throw new WorldSequenceEvaluationError('track-property', `${path}.property`, `Property ${track.property} is unavailable on ${component.type}.`)
  }
  return [{
    kind: 'component-property', trackId: track.id, entityId: track.entityId, componentId: component.id,
    componentType: component.type, property: track.property,
    value: clonePropertyValue(sampleContinuous(track.keyframes, baseValue, time)),
  }]
}

function evaluateEventCrossings(input: WorldSequenceEvaluationInput, currentTime: WorldRationalTime): WorldSequenceEventMarker[] {
  if ((input.mode ?? 'seek') !== 'playback' || !input.previousTime) return []
  const previousTime = clampWorldRationalTime(input.previousTime, { numerator: 0, denominator: 1 }, input.sequence.duration)
  if (compareWorldRationalTime(previousTime, currentTime) >= 0) return []
  const markers: WorldSequenceEventMarker[] = []
  for (const track of input.sequence.tracks) {
    if (track.type !== 'event') continue
    for (const keyframe of track.keyframes) {
      if (compareWorldRationalTime(keyframe.time, previousTime) > 0 && compareWorldRationalTime(keyframe.time, currentTime) <= 0) {
        markers.push({
          kind: 'event', sequenceId: input.sequence.id, trackId: track.id, keyframeId: keyframe.id,
          eventId: keyframe.eventId, time: normalizeWorldRationalTime(keyframe.time),
        })
      }
    }
  }
  return markers.sort((left, right) => (
    compareWorldRationalTime(left.time, right.time)
    || codeUnitCompare(left.trackId, right.trackId)
    || codeUnitCompare(left.keyframeId, right.keyframeId)
    || codeUnitCompare(left.eventId, right.eventId)
  ))
}

function sampleTransformChannel(
  keyframes: readonly WorldTransformKeyframe[],
  channel: keyof WorldTransform,
  baseValue: WorldVector3,
  time: WorldRationalTime,
): WorldVector3 {
  const defining = keyframes.flatMap((keyframe) => {
    const value = keyframe.value[channel]
    return value ? [{ ...keyframe, value }] : []
  })
  return cloneVector3(sampleContinuous(defining, baseValue, time))
}

function sampleDiscrete<T>(
  keyframes: readonly { time: WorldRationalTime; value: T }[],
  baseValue: T,
  time: WorldRationalTime,
): T {
  let value = baseValue
  for (const keyframe of keyframes) {
    if (compareWorldRationalTime(keyframe.time, time) > 0) break
    value = keyframe.value
  }
  return cloneValue(value)
}

function sampleContinuous<T extends WorldPropertyValue>(
  keyframes: readonly { time: WorldRationalTime; interpolation?: 'step' | 'linear' | 'cubic'; value: T }[],
  baseValue: T,
  time: WorldRationalTime,
): T {
  if (keyframes.length === 0 || compareWorldRationalTime(time, keyframes[0].time) < 0) return cloneValue(baseValue)
  let leftIndex = 0
  while (leftIndex + 1 < keyframes.length && compareWorldRationalTime(keyframes[leftIndex + 1].time, time) <= 0) leftIndex += 1
  const left = keyframes[leftIndex]
  const right = keyframes[leftIndex + 1]
  if (!right || compareWorldRationalTime(time, left.time) === 0 || (left.interpolation ?? 'linear') === 'step') return cloneValue(left.value)

  let alpha = worldRationalDifferenceRatio(time, left.time, right.time, left.time)
  alpha = Math.min(1, Math.max(0, alpha))
  if (left.interpolation === 'cubic') alpha = alpha * alpha * (3 - 2 * alpha)
  return interpolateValue(left.value, right.value, alpha)
}

function interpolateValue<T extends WorldPropertyValue>(left: T, right: T, alpha: number): T {
  if (typeof left === 'number' && typeof right === 'number') return (left + (right - left) * alpha) as T
  if (isVector3(left) && isVector3(right)) {
    return [
      left[0] + (right[0] - left[0]) * alpha,
      left[1] + (right[1] - left[1]) * alpha,
      left[2] + (right[2] - left[2]) * alpha,
    ] as T
  }
  return cloneValue(left)
}

function assertComponentType<T extends WorldComponentType>(
  component: WorldComponent,
  expected: T,
  path: string,
): asserts component is Extract<WorldComponent, { type: T }> {
  if (component.type !== expected) throw new WorldSequenceEvaluationError('component-kind', `${path}.componentId`, `Track requires ${expected}, received ${component.type}.`)
}

function readComponentProperty(component: WorldComponent, property: string): unknown {
  let current: unknown = component
  for (const segment of property.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function readTimelineComponentProperty(component: WorldComponent, property: string): unknown {
  const authored = readComponentProperty(component, property)
  if (authored !== undefined) return authored
  if (component.type === 'collider' && property === 'collisionLayer') return 1
  if (component.type === 'collider' && property === 'collisionMask') return 0xffff
  return undefined
}

function isWorldPropertyValue(value: unknown): value is WorldPropertyValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || isVector3(value)
}

function isVector3(value: unknown): value is WorldVector3 {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && Number.isFinite(item))
}

function clonePropertyValue<T extends WorldPropertyValue>(value: T): T {
  return cloneValue(value)
}

function cloneVector3(value: WorldVector3): WorldVector3 {
  return [value[0], value[1], value[2]]
}

function cloneValue<T>(value: T): T {
  return Array.isArray(value) ? ([...value] as T) : value
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
