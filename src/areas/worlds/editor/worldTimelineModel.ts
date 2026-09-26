import type { WorldCommand } from '../core/worldCommands.ts'
import { parseWorldSequenceDocument } from '../core/worldDocuments.ts'
import type {
  WorldProjectSnapshotV1,
  WorldPropertyValue,
  WorldRationalTime,
  WorldSceneDocumentV1,
  WorldSequence,
  WorldSequenceTrack,
  WorldTransform,
} from '../core/worldModel.ts'
import { validateWorldSequenceTrackTargets } from '../core/worldSequenceValidation.ts'
import { isWorldCanonicalId } from '../core/worldValidationLimits.ts'
import {
  clampWorldRationalTime,
  compareWorldRationalTime,
  normalizeWorldRationalTime,
  snapWorldRationalTimeToFrame,
  type WorldSequenceFps,
} from '../cinematic/worldRationalTime.ts'

export interface WorldTimelineEditContext {
  readonly snapshot: WorldProjectSnapshotV1
  readonly sceneId: string
}

export type WorldTimelineCommand = Extract<WorldCommand, { type: 'add-sequence' | 'replace-sequence' | 'remove-sequence' }>
export type WorldTimelineIdKind = 'sequence' | 'track' | 'keyframe'
export type WorldSequenceKeyframe = WorldSequenceTrack['keyframes'][number]

export interface WorldTimelineKeyframePatch {
  readonly time?: WorldRationalTime
  readonly interpolation?: 'step' | 'linear' | 'cubic' | null
  readonly value?: WorldPropertyValue | Partial<WorldTransform>
  readonly eventId?: string
}

export function deriveWorldTimelineId(kind: WorldTimelineIdKind, seed: string): string {
  if (!seed || seed.includes('\0')) throw new TypeError('Timeline ID seed must be a non-empty string without null bytes.')
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const namespace = kind === 'keyframe' ? 'key' : kind
  return `${namespace}:timeline:${hash.toString(16).padStart(8, '0')}`
}

export function snapWorldTimelineTime(
  time: WorldRationalTime,
  fps: WorldSequenceFps,
  duration: WorldRationalTime,
): WorldRationalTime {
  const normalizedDuration = normalizeWorldRationalTime(duration)
  if (normalizedDuration.numerator < 0) throw new RangeError('Sequence duration cannot be negative.')
  const normalized = normalizeWorldRationalTime(time)
  const bounded = clampWorldRationalTime(normalized, { numerator: 0, denominator: 1 }, normalizedDuration)
  return clampWorldRationalTime(snapWorldRationalTimeToFrame(bounded, fps), { numerator: 0, denominator: 1 }, normalizedDuration)
}

export function buildCreateWorldSequenceCommand(
  context: WorldTimelineEditContext,
  input: { readonly id?: string; readonly idSeed?: string; readonly name: string; readonly duration: WorldRationalTime },
): WorldTimelineCommand {
  const scene = findScene(context)
  const id = input.id ?? (input.idSeed ? deriveWorldTimelineId('sequence', input.idSeed) : null)
  if (!id || !isWorldCanonicalId(id)) throw new TypeError('Sequence ID must be injected or derived from a stable seed.')
  assertIdentifierAvailable(context.snapshot, id, 'Sequence')
  const sequence = validateSequenceStructure({ id, name: input.name, duration: normalizeWorldRationalTime(input.duration), tracks: [] })
  return { type: 'add-sequence', sceneId: scene.sceneId, sequence }
}

export function buildRemoveWorldSequenceCommand(context: WorldTimelineEditContext, sequenceId: string): WorldTimelineCommand {
  const { scene } = findSequence(context, sequenceId)
  return { type: 'remove-sequence', sceneId: scene.sceneId, sequenceId }
}

export function buildAddWorldSequenceTrackCommand(
  context: WorldTimelineEditContext,
  sequenceId: string,
  track: WorldSequenceTrack,
): WorldTimelineCommand {
  const { scene, sequence } = findSequence(context, sequenceId)
  assertIdentifiersAvailable(context.snapshot, [track.id, ...track.keyframes.map((keyframe) => keyframe.id)], 'Track')
  const replacement = structuredClone(sequence)
  replacement.tracks.push(structuredClone(track))
  return replaceSequenceCommand(scene, sequenceId, validateAuthorableSequence(scene, replacement))
}

export function buildRemoveWorldSequenceTrackCommand(
  context: WorldTimelineEditContext,
  sequenceId: string,
  trackId: string,
): WorldTimelineCommand {
  const { scene, sequence } = findSequence(context, sequenceId)
  const index = sequence.tracks.findIndex((track) => track.id === trackId)
  if (index < 0) throw new Error(`Track ${trackId} does not exist.`)
  const replacement = structuredClone(sequence)
  replacement.tracks.splice(index, 1)
  return replaceSequenceCommand(scene, sequenceId, validateAuthorableSequence(scene, replacement))
}

export function buildReorderWorldSequenceTrackCommand(
  context: WorldTimelineEditContext,
  sequenceId: string,
  trackId: string,
  toIndex: number,
): WorldTimelineCommand {
  const { scene, sequence } = findSequence(context, sequenceId)
  if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex >= sequence.tracks.length) throw new RangeError('Target track index is outside the sequence.')
  const replacement = structuredClone(sequence)
  const fromIndex = replacement.tracks.findIndex((track) => track.id === trackId)
  if (fromIndex < 0) throw new Error(`Track ${trackId} does not exist.`)
  const [track] = replacement.tracks.splice(fromIndex, 1)
  replacement.tracks.splice(toIndex, 0, track)
  return replaceSequenceCommand(scene, sequenceId, validateAuthorableSequence(scene, replacement))
}

export function buildAddWorldSequenceKeyframeCommand(
  context: WorldTimelineEditContext,
  sequenceId: string,
  trackId: string,
  keyframeValue: WorldSequenceKeyframe,
  fps?: WorldSequenceFps,
): WorldTimelineCommand {
  const { scene, sequence } = findSequence(context, sequenceId)
  const replacement = structuredClone(sequence)
  const track = findTrack(replacement, trackId)
  const keyframes = track.keyframes as WorldSequenceKeyframe[]
  assertIdentifierAvailable(context.snapshot, keyframeValue.id, 'Keyframe')
  const keyframe = structuredClone(keyframeValue)
  keyframe.time = normalizeEditTime(keyframe.time, sequence.duration, fps)
  if (keyframes.some((candidate) => compareWorldRationalTime(candidate.time, keyframe.time) === 0)) throw new Error('A track cannot contain two keyframes at the same time.')
  keyframes.push(keyframe)
  keyframes.sort((left, right) => compareWorldRationalTime(left.time, right.time))
  return replaceSequenceCommand(scene, sequenceId, validateAuthorableSequence(scene, replacement))
}

export function buildMoveWorldSequenceKeyframeCommand(
  context: WorldTimelineEditContext,
  sequenceId: string,
  trackId: string,
  keyframeId: string,
  input: { readonly time: WorldRationalTime; readonly fps: WorldSequenceFps },
): WorldTimelineCommand {
  return buildEditWorldSequenceKeyframeCommand(context, sequenceId, trackId, keyframeId, { time: input.time }, input.fps)
}

export function buildEditWorldSequenceKeyframeCommand(
  context: WorldTimelineEditContext,
  sequenceId: string,
  trackId: string,
  keyframeId: string,
  patch: WorldTimelineKeyframePatch,
  fps?: WorldSequenceFps,
): WorldTimelineCommand {
  if (Object.keys(patch).length === 0) throw new Error('Keyframe edit cannot be empty.')
  const { scene, sequence } = findSequence(context, sequenceId)
  const replacement = structuredClone(sequence)
  const track = findTrack(replacement, trackId)
  const keyframes = track.keyframes as WorldSequenceKeyframe[]
  const keyframe = keyframes.find((candidate) => candidate.id === keyframeId)
  if (!keyframe) throw new Error(`Keyframe ${keyframeId} does not exist.`)
  if (patch.time) keyframe.time = normalizeEditTime(patch.time, sequence.duration, fps)
  if (patch.interpolation === null) delete keyframe.interpolation
  else if (patch.interpolation !== undefined) keyframe.interpolation = patch.interpolation
  if (patch.value !== undefined) {
    if (track.type === 'event') throw new Error('Event keyframes do not contain values.')
    ;(keyframe as Exclude<WorldSequenceKeyframe, { eventId: string }>).value = structuredClone(patch.value) as never
  }
  if (patch.eventId !== undefined) {
    if (track.type !== 'event') throw new Error('Only event keyframes contain event IDs.')
    ;(keyframe as Extract<WorldSequenceKeyframe, { eventId: string }>).eventId = patch.eventId
  }
  keyframes.sort((left, right) => compareWorldRationalTime(left.time, right.time))
  for (let index = 1; index < keyframes.length; index += 1) {
    if (compareWorldRationalTime(keyframes[index - 1].time, keyframes[index].time) === 0) throw new Error('A track cannot contain two keyframes at the same time.')
  }
  return replaceSequenceCommand(scene, sequenceId, validateAuthorableSequence(scene, replacement))
}

export function buildRemoveWorldSequenceKeyframeCommand(
  context: WorldTimelineEditContext,
  sequenceId: string,
  trackId: string,
  keyframeId: string,
): WorldTimelineCommand {
  const { scene, sequence } = findSequence(context, sequenceId)
  const replacement = structuredClone(sequence)
  const track = findTrack(replacement, trackId)
  const index = track.keyframes.findIndex((keyframe) => keyframe.id === keyframeId)
  if (index < 0) throw new Error(`Keyframe ${keyframeId} does not exist.`)
  track.keyframes.splice(index, 1)
  return replaceSequenceCommand(scene, sequenceId, validateAuthorableSequence(scene, replacement))
}

function normalizeEditTime(time: WorldRationalTime, duration: WorldRationalTime, fps?: WorldSequenceFps): WorldRationalTime {
  const normalized = normalizeWorldRationalTime(time)
  const normalizedDuration = normalizeWorldRationalTime(duration)
  if (compareWorldRationalTime(normalized, { numerator: 0, denominator: 1 }) < 0 || compareWorldRationalTime(normalized, normalizedDuration) > 0) {
    throw new RangeError('Keyframe time must be inside the sequence duration.')
  }
  return fps ? snapWorldTimelineTime(normalized, fps, normalizedDuration) : normalized
}

function findScene(context: WorldTimelineEditContext): WorldSceneDocumentV1 {
  const scene = context.snapshot.scenes.find((candidate) => candidate.sceneId === context.sceneId)
  if (!scene) throw new Error(`Scene ${context.sceneId} does not exist.`)
  return scene
}

function findSequence(context: WorldTimelineEditContext, sequenceId: string): { scene: WorldSceneDocumentV1; sequence: WorldSequence } {
  const scene = findScene(context)
  const sequence = scene.sequences.find((candidate) => candidate.id === sequenceId)
  if (!sequence) throw new Error(`Sequence ${sequenceId} does not exist.`)
  return { scene, sequence }
}

function findTrack(sequence: WorldSequence, trackId: string): WorldSequenceTrack {
  const track = sequence.tracks.find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`Track ${trackId} does not exist.`)
  return track
}

function validateSequenceStructure(sequence: WorldSequence): WorldSequence {
  const result = parseWorldSequenceDocument(sequence)
  if (!result.success) throw new Error(result.issues[0]?.message ?? 'Sequence is invalid.')
  return result.value
}

function validateAuthorableSequence(scene: WorldSceneDocumentV1, sequence: WorldSequence): WorldSequence {
  const canonical = validateSequenceStructure(sequence)
  const targets = validateWorldSequenceTrackTargets(scene, canonical)
  if (!targets.success) throw new Error(targets.issues[0]?.message ?? 'Sequence track target is invalid.')
  return canonical
}

function replaceSequenceCommand(scene: WorldSceneDocumentV1, sequenceId: string, sequence: WorldSequence): WorldTimelineCommand {
  return { type: 'replace-sequence', sceneId: scene.sceneId, sequenceId, sequence }
}

function assertIdentifierAvailable(snapshot: WorldProjectSnapshotV1, id: string, label: string): void {
  assertIdentifiersAvailable(snapshot, [id], label)
}

function assertIdentifiersAvailable(snapshot: WorldProjectSnapshotV1, ids: readonly string[], label: string): void {
  const introduced = new Set<string>()
  for (const id of ids) {
    if (!isWorldCanonicalId(id)) throw new TypeError(`${label} ID must be a canonical identifier.`)
    if (introduced.has(id)) throw new Error(`${label} ID ${id} is duplicated in the edit.`)
    introduced.add(id)
  }
  const existing = collectWorldProjectIdentifiers(snapshot)
  for (const id of ids) {
    if (existing.has(id)) throw new Error(`${label} ID ${id} already exists.`)
  }
}

function collectWorldProjectIdentifiers(snapshot: WorldProjectSnapshotV1): Set<string> {
  const ids = new Set<string>([
    snapshot.project.projectId,
    ...snapshot.project.resources.map((resource) => resource.id),
    ...snapshot.project.scenes.map((scene) => scene.id),
    ...snapshot.project.inputActions.map((action) => action.id),
    ...snapshot.project.graphicsProfiles.map((profile) => profile.id),
  ])
  for (const scene of snapshot.scenes) {
    for (const entity of scene.entities) {
      ids.add(entity.id)
      for (const component of entity.components) {
        ids.add(component.id)
        if (component.type === 'behavior') for (const binding of component.bindings) ids.add(binding.id)
      }
    }
    for (const sequence of scene.sequences) {
      ids.add(sequence.id)
      for (const track of sequence.tracks) {
        ids.add(track.id)
        for (const keyframe of track.keyframes) ids.add(keyframe.id)
      }
    }
  }
  return ids
}
