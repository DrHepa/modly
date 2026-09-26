import assert from 'node:assert/strict'
import test from 'node:test'

import { applyWorldCommandBatch, applyWorldCommandInverse, type WorldCommand } from '../core/worldCommands.ts'
import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import type { WorldProjectSnapshotV1, WorldSequenceTrack } from '../core/worldModel.ts'
import { isWorldCanonicalId } from '../core/worldValidationLimits.ts'
import {
  buildAddWorldSequenceKeyframeCommand,
  buildAddWorldSequenceTrackCommand,
  buildCreateWorldSequenceCommand,
  buildEditWorldSequenceKeyframeCommand,
  buildMoveWorldSequenceKeyframeCommand,
  buildRemoveWorldSequenceCommand,
  buildRemoveWorldSequenceKeyframeCommand,
  buildRemoveWorldSequenceTrackCommand,
  buildReorderWorldSequenceTrackCommand,
  deriveWorldTimelineId,
  snapWorldTimelineTime,
  type WorldTimelineEditContext,
} from './worldTimelineModel.ts'

function context(snapshot: WorldProjectSnapshotV1): WorldTimelineEditContext {
  return { snapshot, sceneId: 'scene:one' }
}

function applyAndVerifyUndo(snapshot: WorldProjectSnapshotV1, command: WorldCommand, transactionId: string): WorldProjectSnapshotV1 {
  assert.ok(command.type === 'add-sequence' || command.type === 'replace-sequence' || command.type === 'remove-sequence')
  const before = structuredClone(snapshot)
  const applied = applyWorldCommandBatch(snapshot, {
    schema: 'modly.world-command-batch.v1', transactionId, projectId: snapshot.project.projectId,
    baseRevision: snapshot.project.revision, origin: 'ui', commands: [command],
  })
  assert.equal(applied.success, true, JSON.stringify(applied))
  assert.deepEqual(snapshot, before, 'builder and command bus must not mutate their input snapshot')
  if (!applied.success) return snapshot
  assert.equal(applied.snapshot.project.revision, before.project.revision + 1)

  const undone = applyWorldCommandInverse(applied.snapshot, applied.inverse)
  assert.equal(undone.success, true, JSON.stringify(undone))
  if (undone.success) {
    assert.equal(undone.snapshot.project.revision, applied.snapshot.project.revision + 1)
    const restored = structuredClone(undone.snapshot)
    restored.project.revision = before.project.revision
    assert.deepEqual(restored, before, 'Undo must restore exact document content while preserving monotonic revisions')
  }
  return applied.snapshot
}

test('builds the complete sequence/track/keyframe lifecycle only through canonical sequence commands', () => {
  let snapshot = createValidWorldSnapshot()
  snapshot = applyAndVerifyUndo(snapshot, buildCreateWorldSequenceCommand(context(snapshot), {
    id: 'sequence:editor', name: 'Editor sequence', duration: { numerator: 2, denominator: 1 },
  }), 'tx:timeline:create')

  const opacityTrack: WorldSequenceTrack = {
    id: 'track:opacity', type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity', keyframes: [],
  }
  snapshot = applyAndVerifyUndo(snapshot, buildAddWorldSequenceTrackCommand(context(snapshot), 'sequence:editor', opacityTrack), 'tx:timeline:add-track')
  snapshot = applyAndVerifyUndo(snapshot, buildAddWorldSequenceKeyframeCommand(context(snapshot), 'sequence:editor', 'track:opacity', {
    id: 'key:opacity-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 1,
  }), 'tx:timeline:add-key-0')
  snapshot = applyAndVerifyUndo(snapshot, buildAddWorldSequenceKeyframeCommand(context(snapshot), 'sequence:editor', 'track:opacity', {
    id: 'key:opacity-1', time: { numerator: 1, denominator: 1 }, interpolation: 'linear', value: 0,
  }), 'tx:timeline:add-key-1')

  snapshot = applyAndVerifyUndo(snapshot, buildEditWorldSequenceKeyframeCommand(context(snapshot), 'sequence:editor', 'track:opacity', 'key:opacity-1', {
    value: 0.25, interpolation: 'cubic',
  }), 'tx:timeline:edit-key')
  snapshot = applyAndVerifyUndo(snapshot, buildMoveWorldSequenceKeyframeCommand(context(snapshot), 'sequence:editor', 'track:opacity', 'key:opacity-1', {
    time: { numerator: 3, denominator: 2 }, fps: 30,
  }), 'tx:timeline:move-key')

  const eventTrack: WorldSequenceTrack = { id: 'track:events', type: 'event', keyframes: [] }
  snapshot = applyAndVerifyUndo(snapshot, buildAddWorldSequenceTrackCommand(context(snapshot), 'sequence:editor', eventTrack), 'tx:timeline:add-events')
  snapshot = applyAndVerifyUndo(snapshot, buildReorderWorldSequenceTrackCommand(context(snapshot), 'sequence:editor', 'track:events', 0), 'tx:timeline:reorder')
  assert.deepEqual(snapshot.scenes[0].sequences[0].tracks.map((track) => track.id), ['track:events', 'track:opacity'])

  snapshot = applyAndVerifyUndo(snapshot, buildRemoveWorldSequenceKeyframeCommand(context(snapshot), 'sequence:editor', 'track:opacity', 'key:opacity-0'), 'tx:timeline:remove-key')
  snapshot = applyAndVerifyUndo(snapshot, buildRemoveWorldSequenceTrackCommand(context(snapshot), 'sequence:editor', 'track:events'), 'tx:timeline:remove-track')
  snapshot = applyAndVerifyUndo(snapshot, buildRemoveWorldSequenceCommand(context(snapshot), 'sequence:editor'), 'tx:timeline:remove-sequence')
  assert.deepEqual(snapshot.scenes[0].sequences, [])
})

test('snaps 24/25/30/60 fps edits exactly and derives deterministic canonical IDs without ambient state', () => {
  assert.equal(deriveWorldTimelineId('sequence', 'shot one'), deriveWorldTimelineId('sequence', 'shot one'))
  assert.notEqual(deriveWorldTimelineId('sequence', 'shot one'), deriveWorldTimelineId('sequence', 'shot two'))
  assert.match(deriveWorldTimelineId('track', 'camera/main'), /^track:timeline:[0-9a-f]{8}$/)
  assert.match(deriveWorldTimelineId('keyframe', 'hero/position/0'), /^key:timeline:[0-9a-f]{8}$/)
  assert.equal(isWorldCanonicalId(deriveWorldTimelineId('keyframe', 'hero/position/0')), true)
  for (const fps of [24, 25, 30, 60] as const) {
    assert.deepEqual(
      snapWorldTimelineTime({ numerator: 1, denominator: fps * 2 }, fps, { numerator: 2, denominator: 1 }),
      { numerator: 1, denominator: fps },
    )
  }
  assert.deepEqual(snapWorldTimelineTime({ numerator: 26, denominator: 25 }, 25, { numerator: 1, denominator: 1 }), { numerator: 1, denominator: 1 })

  let snapshot = createValidWorldSnapshot()
  const sequenceId = deriveWorldTimelineId('sequence', 'deterministic shot')
  snapshot = applyAndVerifyUndo(snapshot, buildCreateWorldSequenceCommand(context(snapshot), {
    idSeed: 'deterministic shot', name: 'Deterministic shot', duration: { numerator: 1, denominator: 1 },
  }), 'tx:timeline:derived')
  assert.equal(snapshot.scenes[0].sequences[0].id, sequenceId)

  snapshot = applyAndVerifyUndo(snapshot, buildAddWorldSequenceTrackCommand(context(snapshot), sequenceId, {
    id: 'track:snapped', type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity', keyframes: [],
  }), 'tx:timeline:snap-track')
  snapshot = applyAndVerifyUndo(snapshot, buildAddWorldSequenceKeyframeCommand(context(snapshot), sequenceId, 'track:snapped', {
    id: 'key:snapped', time: { numerator: 1, denominator: 48 }, interpolation: 'linear', value: 1,
  }, 24), 'tx:timeline:snap-key')
  assert.deepEqual(snapshot.scenes[0].sequences[0].tracks[0].keyframes[0].time, { numerator: 1, denominator: 24 })
})

test('invalid edits fail before command creation and leave the source snapshot byte-for-byte unchanged', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].sequences.push({
    id: 'sequence:invalid-guard', name: 'Invalid guard', duration: { numerator: 1, denominator: 1 }, tracks: [
      { id: 'track:opacity', type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity', keyframes: [
        { id: 'key:opacity', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 1 },
      ] },
    ],
  })
  const before = structuredClone(snapshot)

  assert.throws(() => buildCreateWorldSequenceCommand(context(snapshot), {
    id: 'resource:hero', name: 'Colliding sequence', duration: { numerator: 1, denominator: 1 },
  }), /already exists/)
  assert.throws(() => buildAddWorldSequenceTrackCommand(context(snapshot), 'sequence:invalid-guard', {
    id: 'component:hero-renderable', type: 'event', keyframes: [],
  }), /already exists/)
  assert.throws(() => buildAddWorldSequenceKeyframeCommand(context(snapshot), 'sequence:invalid-guard', 'track:opacity', {
    id: 'entity:hero', time: { numerator: 1, denominator: 2 }, interpolation: 'linear', value: 0.5,
  }), /already exists/)
  assert.throws(() => buildAddWorldSequenceTrackCommand(context(snapshot), 'sequence:invalid-guard', {
    id: 'track:opacity-copy', type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity', keyframes: [],
  }), /already writes/)
  assert.throws(() => buildAddWorldSequenceKeyframeCommand(context(snapshot), 'sequence:invalid-guard', 'track:opacity', {
    id: 'key:duplicate-time', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 0.5,
  }), /strictly increasing|same time/)
  assert.throws(() => buildMoveWorldSequenceKeyframeCommand(context(snapshot), 'sequence:invalid-guard', 'track:opacity', 'key:opacity', {
    time: { numerator: 2, denominator: 1 }, fps: 24,
  }), /inside the sequence duration/)
  assert.throws(() => buildEditWorldSequenceKeyframeCommand(context(snapshot), 'sequence:invalid-guard', 'track:opacity', 'key:opacity', { value: 2 }), /not writable/)
  assert.throws(() => buildReorderWorldSequenceTrackCommand(context(snapshot), 'sequence:invalid-guard', 'track:opacity', 2), /track index/)
  assert.deepEqual(snapshot, before)
})

test('prechecks behavior-binding and nested track keyframe IDs before returning commands', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].components.push({
    id: 'component:timeline-id-guard', type: 'behavior', enabled: true,
    bindings: [{ id: 'binding:timeline-shared', event: { type: 'start' }, actions: [] }],
  })
  snapshot.scenes[0].sequences.push({
    id: 'sequence:id-guard', name: 'ID guard', duration: { numerator: 1, denominator: 1 },
    tracks: [{ id: 'track:event-id-guard', type: 'event', keyframes: [] }],
  })
  const before = structuredClone(snapshot)

  assert.throws(() => buildAddWorldSequenceKeyframeCommand(context(snapshot), 'sequence:id-guard', 'track:event-id-guard', {
    id: 'binding:timeline-shared', time: { numerator: 0, denominator: 1 }, interpolation: 'step', eventId: 'event:id-guard',
  }), /already exists/)

  assert.throws(() => buildAddWorldSequenceTrackCommand(context(snapshot), 'sequence:id-guard', {
    id: 'track:nested-id-guard', type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity', keyframes: [{
      id: 'resource:hero', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 1,
    }],
  }), /already exists/)

  assert.throws(() => buildAddWorldSequenceTrackCommand(context(snapshot), 'sequence:id-guard', {
    id: 'track:self-collision', type: 'event', keyframes: [{
      id: 'track:self-collision', time: { numerator: 0, denominator: 1 }, interpolation: 'step', eventId: 'event:self-collision',
    }],
  }), /already exists|duplicate/)
  assert.deepEqual(snapshot, before)
})
