import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorldSceneDocumentV1, WorldSequence } from '../core/worldModel.ts'
import { evaluateWorldSequence, type WorldSequenceEvaluatedPatch } from './worldSequenceEvaluator.ts'

function createScene(): WorldSceneDocumentV1 {
  return {
    schema: 'modly.world-scene.v1',
    projectId: 'project:cinematic',
    sceneId: 'scene:cinematic',
    name: 'Cinematic',
    environment: { backgroundColor: '#101114', ambientIntensity: 0.2 },
    entities: [
      {
        id: 'entity:camera-a', name: 'Camera A', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ id: 'component:camera-a', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 }],
      },
      {
        id: 'entity:camera-b', name: 'Camera B', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [8, 4, 0], rotation: [0, 1, 0], scale: [1, 1, 1] },
        components: [{ id: 'component:camera-b', type: 'camera', enabled: true, projection: 'orthographic', primary: false, near: 0.1, far: 100, orthographicSize: 8 }],
      },
      {
        id: 'entity:actor', name: 'Actor', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [
          { id: 'component:model', type: 'renderable', enabled: true, resourceId: 'resource:model', visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } },
          { id: 'component:animation', type: 'animation-player', enabled: true, resourceId: 'resource:animation', autoplay: false, loop: true, speed: 1 },
          { id: 'component:audio', type: 'audio-source', enabled: true, resourceId: 'resource:audio', autoplay: false, loop: false, volume: 1, spatial: true, maxDistance: 20 },
          { id: 'component:light', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 1, range: 10, castShadow: false },
          { id: 'component:collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [0.5, 0.5, 0.5], sensor: false, friction: 0.5, restitution: 0 },
        ],
      },
    ],
    sequences: [],
  }
}

function createSequence(): WorldSequence {
  return {
    id: 'sequence:shot',
    name: 'Shot',
    duration: { numerator: 4, denominator: 1 },
    tracks: [
      {
        id: 'track:transform', type: 'transform', entityId: 'entity:actor', keyframes: [
          { id: 'key:transform-1', time: { numerator: 1, denominator: 1 }, interpolation: 'cubic', value: { position: [10, 0, 0], scale: [2, 2, 2] } },
          { id: 'key:transform-2', time: { numerator: 2, denominator: 1 }, interpolation: 'linear', value: { position: [20, 10, 0], rotation: [0, 1, 0] } },
          { id: 'key:transform-3', time: { numerator: 3, denominator: 1 }, interpolation: 'step', value: { rotation: [0, 2, 0] } },
        ],
      },
      { id: 'track:camera-a', type: 'camera', entityId: 'entity:camera-a', keyframes: [
        { id: 'key:camera-a-0', time: { numerator: 0, denominator: 1 }, interpolation: 'step', value: true },
        { id: 'key:camera-a-2', time: { numerator: 2, denominator: 1 }, interpolation: 'step', value: false },
      ] },
      { id: 'track:camera-b', type: 'camera', entityId: 'entity:camera-b', keyframes: [
        { id: 'key:camera-b-0', time: { numerator: 0, denominator: 1 }, interpolation: 'step', value: false },
        { id: 'key:camera-b-2', time: { numerator: 2, denominator: 1 }, interpolation: 'step', value: true },
      ] },
      { id: 'track:animation', type: 'animation', entityId: 'entity:actor', componentId: 'component:animation', keyframes: [
        { id: 'key:animation-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', value: true },
      ] },
      { id: 'track:audio', type: 'audio', entityId: 'entity:actor', componentId: 'component:audio', keyframes: [
        { id: 'key:audio-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', value: true },
        { id: 'key:audio-3', time: { numerator: 3, denominator: 1 }, interpolation: 'step', value: false },
      ] },
      { id: 'track:light', type: 'light', entityId: 'entity:actor', componentId: 'component:light', property: 'intensity', keyframes: [
        { id: 'key:light-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 1 },
        { id: 'key:light-2', time: { numerator: 2, denominator: 1 }, value: 3 },
      ] },
      { id: 'track:opacity', type: 'property', entityId: 'entity:actor', componentId: 'component:model', property: 'material.opacity', keyframes: [
        { id: 'key:opacity-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 1 },
        { id: 'key:opacity-2', time: { numerator: 2, denominator: 1 }, value: 0 },
      ] },
      { id: 'track:event', type: 'event', keyframes: [
        { id: 'key:event-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', eventId: 'event:beat-one' },
        { id: 'key:event-2', time: { numerator: 2, denominator: 1 }, interpolation: 'step', eventId: 'event:beat-two' },
      ] },
    ],
  }
}

function patchByTrack(patches: readonly WorldSequenceEvaluatedPatch[], trackId: string): WorldSequenceEvaluatedPatch {
  const patch = patches.find((candidate) => candidate.kind === 'transform'
    ? candidate.trackIds.includes(trackId)
    : candidate.trackId === trackId)
  assert.ok(patch, `Missing evaluated patch for ${trackId}`)
  return patch
}

test('samples every canonical track immutably with authored base and partial-transform semantics', () => {
  const scene = createScene()
  const sequence = createSequence()
  const sceneBefore = structuredClone(scene)
  const sequenceBefore = structuredClone(sequence)

  const beforeFirst = evaluateWorldSequence({ scene, sequence, time: { numerator: 1, denominator: 2 }, mode: 'seek' })
  assert.deepEqual(patchByTrack(beforeFirst.patches, 'track:transform'), {
    kind: 'transform', trackIds: ['track:transform'], entityId: 'entity:actor',
    transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
  })
  assert.deepEqual(beforeFirst.markers, [])

  const middle = evaluateWorldSequence({ scene, sequence, time: { numerator: 3, denominator: 2 }, mode: 'seek' })
  assert.deepEqual(patchByTrack(middle.patches, 'track:transform'), {
    kind: 'transform', trackIds: ['track:transform'], entityId: 'entity:actor',
    transform: { position: [15, 5, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
  })
  assert.deepEqual(patchByTrack(middle.patches, 'track:light'), {
    kind: 'component-property', trackId: 'track:light', entityId: 'entity:actor', componentId: 'component:light', componentType: 'light', property: 'intensity', value: 2.5,
  })
  assert.deepEqual(patchByTrack(middle.patches, 'track:opacity'), {
    kind: 'component-property', trackId: 'track:opacity', entityId: 'entity:actor', componentId: 'component:model', componentType: 'renderable', property: 'material.opacity', value: 0.25,
  })
  assert.deepEqual(patchByTrack(middle.patches, 'track:animation'), {
    kind: 'playback-state', media: 'animation', trackId: 'track:animation', entityId: 'entity:actor', componentId: 'component:animation', playing: true,
  })
  assert.deepEqual(patchByTrack(middle.patches, 'track:audio'), {
    kind: 'playback-state', media: 'audio', trackId: 'track:audio', entityId: 'entity:actor', componentId: 'component:audio', playing: true,
  })

  const later = evaluateWorldSequence({ scene, sequence, time: { numerator: 5, denominator: 2 }, mode: 'seek' })
  const transform = patchByTrack(later.patches, 'track:transform')
  assert.equal(transform.kind, 'transform')
  if (transform.kind === 'transform') assert.deepEqual(transform.transform, { position: [20, 10, 0], rotation: [0, 1.5, 0], scale: [2, 2, 2] })
  assert.deepEqual(scene, sceneBefore)
  assert.deepEqual(sequence, sequenceBefore)
})

test('uses step, linear, and v1 cubic smoothstep interpolation without mutating keyframes', () => {
  const scene = createScene()
  const sequence: WorldSequence = {
    id: 'sequence:interpolation', name: 'Interpolation', duration: { numerator: 1, denominator: 1 }, tracks: [
      { id: 'track:linear', type: 'property', entityId: 'entity:actor', componentId: 'component:light', property: 'intensity', keyframes: [
        { id: 'key:linear-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 0 },
        { id: 'key:linear-1', time: { numerator: 1, denominator: 1 }, value: 8 },
      ] },
      { id: 'track:cubic', type: 'property', entityId: 'entity:actor', componentId: 'component:model', property: 'material.opacity', keyframes: [
        { id: 'key:cubic-0', time: { numerator: 0, denominator: 1 }, interpolation: 'cubic', value: 0 },
        { id: 'key:cubic-1', time: { numerator: 1, denominator: 1 }, value: 1 },
      ] },
      { id: 'track:step', type: 'property', entityId: 'entity:actor', componentId: 'component:model', property: 'visible', keyframes: [
        { id: 'key:step-0', time: { numerator: 0, denominator: 1 }, interpolation: 'step', value: true },
        { id: 'key:step-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', value: false },
      ] },
    ],
  }
  const evaluation = evaluateWorldSequence({ scene, sequence, time: { numerator: 1, denominator: 4 }, mode: 'seek' })
  assert.equal((patchByTrack(evaluation.patches, 'track:linear') as { value: unknown }).value, 2)
  assert.equal((patchByTrack(evaluation.patches, 'track:cubic') as { value: unknown }).value, 0.15625)
  assert.equal((patchByTrack(evaluation.patches, 'track:step') as { value: unknown }).value, true)
})

test('emits marker-only events for forward playback crossings (previous, current] and never for seeks', () => {
  const scene = createScene()
  const sequence = createSequence()
  const forward = evaluateWorldSequence({
    scene, sequence, previousTime: { numerator: 1, denominator: 1 }, time: { numerator: 2, denominator: 1 }, mode: 'playback',
  })
  assert.deepEqual(forward.markers, [{
    kind: 'event', sequenceId: 'sequence:shot', trackId: 'track:event', keyframeId: 'key:event-2', eventId: 'event:beat-two', time: { numerator: 2, denominator: 1 },
  }])
  assert.equal('effects' in forward, false)

  const fromStart = evaluateWorldSequence({
    scene, sequence, previousTime: { numerator: 0, denominator: 1 }, time: { numerator: 2, denominator: 1 }, mode: 'playback',
  })
  assert.deepEqual(fromStart.markers.map((marker) => marker.eventId), ['event:beat-one', 'event:beat-two'])
  assert.deepEqual(evaluateWorldSequence({ scene, sequence, previousTime: { numerator: 2, denominator: 1 }, time: { numerator: 1, denominator: 1 }, mode: 'playback' }).markers, [])
  assert.deepEqual(evaluateWorldSequence({ scene, sequence, previousTime: { numerator: 0, denominator: 1 }, time: { numerator: 2, denominator: 1 }, mode: 'seek' }).markers, [])
})

test('orders cross-track event markers by exact time independently of track array order', () => {
  const maximum = Number.MAX_SAFE_INTEGER
  const tracks: WorldSequence['tracks'] = [
    { id: 'track:late', type: 'event', keyframes: [
      { id: 'key:late', time: { numerator: 2, denominator: 1 }, interpolation: 'step', eventId: 'event:late' },
    ] },
    { id: 'track:early', type: 'event', keyframes: [
      { id: 'key:early', time: { numerator: 1, denominator: 1 }, interpolation: 'step', eventId: 'event:early' },
    ] },
    { id: 'track:z-tie', type: 'event', keyframes: [
      { id: 'key:a-tie', time: { numerator: 3, denominator: 1 }, interpolation: 'step', eventId: 'event:z-tie' },
    ] },
    { id: 'track:a-tie', type: 'event', keyframes: [
      { id: 'key:z-tie', time: { numerator: 3, denominator: 1 }, interpolation: 'step', eventId: 'event:a-tie' },
    ] },
    { id: 'track:extreme-later', type: 'event', keyframes: [
      { id: 'key:extreme-later', time: { numerator: 1, denominator: maximum - 1 }, interpolation: 'step', eventId: 'event:extreme-later' },
    ] },
    { id: 'track:extreme-earlier', type: 'event', keyframes: [
      { id: 'key:extreme-earlier', time: { numerator: 1, denominator: maximum }, interpolation: 'step', eventId: 'event:extreme-earlier' },
    ] },
  ]
  const sequence = (orderedTracks: WorldSequence['tracks']): WorldSequence => ({
    id: 'sequence:ordered-events', name: 'Ordered events', duration: { numerator: 4, denominator: 1 }, tracks: orderedTracks,
  })
  const evaluate = (orderedTracks: WorldSequence['tracks']) => evaluateWorldSequence({
    scene: createScene(), sequence: sequence(orderedTracks), previousTime: { numerator: 0, denominator: 1 }, time: { numerator: 4, denominator: 1 }, mode: 'playback',
  }).markers

  const forward = evaluate(tracks)
  const reversed = evaluate([...tracks].reverse())
  assert.deepEqual(forward.map((marker) => marker.eventId), [
    'event:extreme-earlier',
    'event:extreme-later',
    'event:early',
    'event:late',
    'event:a-tie',
    'event:z-tie',
  ])
  assert.deepEqual(reversed, forward)
})

test('clamps sampling to the sequence range and resolves camera tracks to their canonical component', () => {
  const evaluation = evaluateWorldSequence({ scene: createScene(), sequence: createSequence(), time: { numerator: 10, denominator: 1 }, mode: 'seek' })
  assert.deepEqual(evaluation.time, { numerator: 4, denominator: 1 })
  assert.deepEqual(patchByTrack(evaluation.patches, 'track:camera-b'), {
    kind: 'component-property', trackId: 'track:camera-b', entityId: 'entity:camera-b', componentId: 'component:camera-b', componentType: 'camera', property: 'primary', value: true,
  })
})

test('uses canonical authored defaults for optional writable component fields', () => {
  const sequence: WorldSequence = {
    id: 'sequence:optional-base', name: 'Optional base', duration: { numerator: 2, denominator: 1 }, tracks: [{
      id: 'track:collision-layer', type: 'property', entityId: 'entity:actor', componentId: 'component:collider', property: 'collisionLayer', keyframes: [
        { id: 'key:layer-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', value: 2 },
      ],
    }],
  }
  const evaluation = evaluateWorldSequence({ scene: createScene(), sequence, time: { numerator: 1, denominator: 2 }, mode: 'seek' })
  assert.deepEqual(evaluation.patches[0], {
    kind: 'component-property', trackId: 'track:collision-layer', entityId: 'entity:actor', componentId: 'component:collider', componentType: 'collider', property: 'collisionLayer', value: 1,
  })
})

test('composes separate transform-channel tracks into one deterministic order-independent patch', () => {
  const scene = createScene()
  const tracks: WorldSequence['tracks'] = [
    { id: 'track:position-only', type: 'transform', entityId: 'entity:actor', keyframes: [
      { id: 'key:position-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: { position: [0, 0, 0] } },
      { id: 'key:position-1', time: { numerator: 1, denominator: 1 }, value: { position: [10, 4, 2] } },
    ] },
    { id: 'track:rotation-only', type: 'transform', entityId: 'entity:actor', keyframes: [
      { id: 'key:rotation-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: { rotation: [0, 0, 0] } },
      { id: 'key:rotation-1', time: { numerator: 1, denominator: 1 }, value: { rotation: [0, 2, 0] } },
    ] },
    { id: 'track:scale-only', type: 'transform', entityId: 'entity:actor', keyframes: [
      { id: 'key:scale-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: { scale: [1, 1, 1] } },
      { id: 'key:scale-1', time: { numerator: 1, denominator: 1 }, value: { scale: [3, 5, 7] } },
    ] },
  ]
  const sequence = (orderedTracks: WorldSequence['tracks']): WorldSequence => ({
    id: 'sequence:composed-transform', name: 'Composed transform', duration: { numerator: 1, denominator: 1 }, tracks: orderedTracks,
  })

  const forward = evaluateWorldSequence({ scene, sequence: sequence(tracks), time: { numerator: 1, denominator: 2 }, mode: 'seek' })
  const reversed = evaluateWorldSequence({ scene, sequence: sequence([...tracks].reverse()), time: { numerator: 1, denominator: 2 }, mode: 'seek' })

  assert.deepEqual(forward.patches, [{
    kind: 'transform',
    trackIds: ['track:position-only', 'track:rotation-only', 'track:scale-only'],
    entityId: 'entity:actor',
    transform: { position: [5, 2, 1], rotation: [0, 1, 0], scale: [2, 3, 4] },
  }])
  assert.deepEqual(reversed.patches, forward.patches)

  const positionOnly = evaluateWorldSequence({ scene, sequence: sequence([tracks[0]]), time: { numerator: 1, denominator: 2 }, mode: 'seek' })
  assert.deepEqual(positionOnly.patches, [{
    kind: 'transform', trackIds: ['track:position-only'], entityId: 'entity:actor', transform: { position: [5, 2, 1] },
  }])
})
