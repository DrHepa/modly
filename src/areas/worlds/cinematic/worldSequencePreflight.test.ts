import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorldSceneDocumentV1, WorldSequence } from '../core/worldModel.ts'
import {
  preflightWorldSequence,
  WORLD_ORTHOGRAPHIC_SIZE_SEMANTICS,
} from './worldSequencePreflight.ts'

function createScene(): WorldSceneDocumentV1 {
  return {
    schema: 'modly.world-scene.v1', projectId: 'project:preflight', sceneId: 'scene:preflight', name: 'Preflight',
    environment: { backgroundColor: '#101114', ambientIntensity: 0.2 },
    entities: [
      {
        id: 'entity:camera-a', name: 'Camera A', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ id: 'component:camera-a', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 }],
      },
      {
        id: 'entity:camera-b', name: 'Camera B', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [5, 2, 0], rotation: [0, 1, 0], scale: [1, 1, 1] },
        components: [{ id: 'component:camera-b', type: 'camera', enabled: true, projection: 'orthographic', primary: false, near: 0.1, far: 100, orthographicSize: 8 }],
      },
      {
        id: 'entity:subject', name: 'Subject', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [
          { id: 'component:subject-model', type: 'renderable', enabled: true, resourceId: 'resource:model', visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } },
          { id: 'component:subject-light', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 1, range: 10, castShadow: false },
          { id: 'component:subject-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [0.5, 0.5, 0.5], sensor: false, friction: 0.5, restitution: 0 },
        ],
      },
    ],
    sequences: [],
  }
}

function createValidSequence(): WorldSequence {
  return {
    id: 'sequence:preflight', name: 'Preflight', duration: { numerator: 2, denominator: 1 }, tracks: [
      { id: 'track:camera-a', type: 'camera', entityId: 'entity:camera-a', keyframes: [
        { id: 'key:camera-a-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', value: false },
      ] },
      { id: 'track:camera-b', type: 'camera', entityId: 'entity:camera-b', keyframes: [
        { id: 'key:camera-b-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', value: true },
      ] },
      { id: 'track:ortho-height', type: 'property', entityId: 'entity:camera-b', componentId: 'component:camera-b', property: 'orthographicSize', keyframes: [
        { id: 'key:ortho-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 8 },
        { id: 'key:ortho-2', time: { numerator: 2, denominator: 1 }, value: 12 },
      ] },
      { id: 'track:near', type: 'property', entityId: 'entity:camera-a', componentId: 'component:camera-a', property: 'near', keyframes: [
        { id: 'key:near-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 0.1 },
        { id: 'key:near-2', time: { numerator: 2, denominator: 1 }, value: 1 },
      ] },
      { id: 'track:event', type: 'event', keyframes: [
        { id: 'key:event-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', eventId: 'event:cut' },
      ] },
      { id: 'track:collision-layer', type: 'property', entityId: 'entity:subject', componentId: 'component:subject-collider', property: 'collisionLayer', keyframes: [
        { id: 'key:layer-0', time: { numerator: 0, denominator: 1 }, interpolation: 'step', value: 1 },
        { id: 'key:layer-2', time: { numerator: 2, denominator: 1 }, interpolation: 'step', value: 2 },
      ] },
    ],
  }
}

test('accepts exact references, camera handoff, discontinuity samples, and vertical orthographic height semantics', () => {
  assert.equal(WORLD_ORTHOGRAPHIC_SIZE_SEMANTICS, 'vertical-world-space-height')
  const result = preflightWorldSequence({ scene: createScene(), sequence: createValidSequence() })
  assert.equal(result.success, true, JSON.stringify(result))
  if (result.success) {
    assert.deepEqual(result.sampleTimes, [
      { numerator: 0, denominator: 1 },
      { numerator: 1, denominator: 1 },
      { numerator: 2, denominator: 1 },
    ])
  }
})

test('preflights the minimum positive wire time without constructing an unrepresentable midpoint', () => {
  const maximum = Number.MAX_SAFE_INTEGER
  const sequence: WorldSequence = {
    id: 'sequence:minimum-time', name: 'Minimum time', duration: { numerator: 1, denominator: 1 }, tracks: [{
      id: 'track:minimum-time', type: 'property', entityId: 'entity:subject', componentId: 'component:subject-model', property: 'material.opacity', keyframes: [
        { id: 'key:minimum-time', time: { numerator: 1, denominator: maximum }, interpolation: 'linear', value: 0.75 },
      ],
    }],
  }

  const run = () => preflightWorldSequence({ scene: createScene(), sequence })
  assert.doesNotThrow(run)
  const result = run()
  assert.equal(result.success, true, JSON.stringify(result))
  if (result.success) {
    assert.deepEqual(result.sampleTimes, [
      { numerator: 0, denominator: 1 },
      { numerator: 1, denominator: maximum },
      { numerator: 1, denominator: 1 },
    ])
  }
})

test('preflights large coprime rational boundaries without rounding or arithmetic-limit failures', () => {
  const maximum = Number.MAX_SAFE_INTEGER
  const earliest = { numerator: 1, denominator: maximum }
  const interior = { numerator: 1, denominator: maximum - 1 }
  const latest = { numerator: 1, denominator: maximum - 2 }
  const sequence: WorldSequence = {
    id: 'sequence:coprime-times', name: 'Coprime times', duration: { numerator: 1, denominator: 1 }, tracks: [
      { id: 'track:coprime-near', type: 'property', entityId: 'entity:camera-a', componentId: 'component:camera-a', property: 'near', keyframes: [
        { id: 'key:coprime-near-a', time: earliest, interpolation: 'cubic', value: 0.1 },
        { id: 'key:coprime-near-b', time: latest, value: 0.2 },
      ] },
      { id: 'track:coprime-event', type: 'event', keyframes: [
        { id: 'key:coprime-event', time: interior, interpolation: 'step', eventId: 'event:coprime-boundary' },
      ] },
    ],
  }

  const run = () => preflightWorldSequence({ scene: createScene(), sequence })
  assert.doesNotThrow(run)
  const result = run()
  assert.equal(result.success, true, JSON.stringify(result))
  if (result.success) {
    assert.deepEqual(result.sampleTimes, [
      { numerator: 0, denominator: 1 },
      earliest,
      interior,
      latest,
      { numerator: 1, denominator: 1 },
    ])
  }
})

test('rejects missing, wrong-kind, and cross-owner track references precisely', () => {
  const cases: Array<{ mutate: (sequence: WorldSequence) => void; code: string }> = [
    { mutate: (sequence) => { (sequence.tracks[0] as Extract<WorldSequence['tracks'][number], { type: 'camera' }>).entityId = 'entity:missing' }, code: 'entity-reference' },
    { mutate: (sequence) => { (sequence.tracks[2] as Extract<WorldSequence['tracks'][number], { type: 'property' }>).componentId = 'component:missing' }, code: 'component-reference' },
    { mutate: (sequence) => {
      const track = sequence.tracks[2] as Extract<WorldSequence['tracks'][number], { type: 'property' }>
      track.entityId = 'entity:camera-a'
    }, code: 'component-owner' },
    { mutate: (sequence) => {
      sequence.tracks.push({ id: 'track:wrong-light', type: 'light', entityId: 'entity:camera-a', componentId: 'component:camera-a', property: 'intensity', keyframes: [] })
    }, code: 'component-kind' },
  ]

  for (const { mutate, code } of cases) {
    const sequence = createValidSequence()
    mutate(sequence)
    const result = preflightWorldSequence({ scene: createScene(), sequence })
    assert.equal(result.success, false, JSON.stringify(result))
    if (!result.success) assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result))
  }
})

test('rejects duplicate or overlapping writers for the same target channel', () => {
  const duplicateProperty = createValidSequence()
  duplicateProperty.tracks.push({
    id: 'track:ortho-height-copy', type: 'property', entityId: 'entity:camera-b', componentId: 'component:camera-b', property: 'orthographicSize', keyframes: [],
  })
  const duplicateResult = preflightWorldSequence({ scene: createScene(), sequence: duplicateProperty })
  assert.equal(duplicateResult.success, false)
  if (!duplicateResult.success) assert.ok(duplicateResult.issues.some((issue) => issue.code === 'track-conflict'))

  const specializedConflict = createValidSequence()
  specializedConflict.tracks.push({
    id: 'track:camera-a-property', type: 'property', entityId: 'entity:camera-a', componentId: 'component:camera-a', property: 'primary', keyframes: [],
  })
  const specializedResult = preflightWorldSequence({ scene: createScene(), sequence: specializedConflict })
  assert.equal(specializedResult.success, false)
  if (!specializedResult.success) assert.ok(specializedResult.issues.some((issue) => issue.code === 'track-conflict'))

  const transformConflict = createValidSequence()
  transformConflict.tracks.push(
    { id: 'track:transform-a', type: 'transform', entityId: 'entity:subject', keyframes: [{ id: 'key:position-a', time: { numerator: 0, denominator: 1 }, value: { position: [0, 0, 0] } }] },
    { id: 'track:transform-b', type: 'transform', entityId: 'entity:subject', keyframes: [{ id: 'key:position-b', time: { numerator: 1, denominator: 1 }, value: { position: [1, 0, 0] } }] },
  )
  const transformResult = preflightWorldSequence({ scene: createScene(), sequence: transformConflict })
  assert.equal(transformResult.success, false)
  if (!transformResult.success) assert.ok(transformResult.issues.some((issue) => issue.code === 'track-conflict'))
})

test('rejects non-writable targets, mixed property value kinds, and non-step discrete interpolation', () => {
  const readonly = createValidSequence()
  const readonlyTrack = readonly.tracks[2] as Extract<WorldSequence['tracks'][number], { type: 'property' }>
  readonlyTrack.property = 'projection'
  const readonlyResult = preflightWorldSequence({ scene: createScene(), sequence: readonly })
  assert.equal(readonlyResult.success, false)
  if (!readonlyResult.success) assert.ok(readonlyResult.issues.some((issue) => issue.code === 'track-property'))

  const mixed = createValidSequence()
  mixed.tracks.push({
    id: 'track:mixed', type: 'property', entityId: 'entity:subject', componentId: 'component:subject-model', property: 'visible',
    keyframes: [
      { id: 'key:mixed-0', time: { numerator: 0, denominator: 1 }, interpolation: 'step', value: true },
      { id: 'key:mixed-1', time: { numerator: 1, denominator: 1 }, value: 1 },
    ],
  })
  const mixedResult = preflightWorldSequence({ scene: createScene(), sequence: mixed })
  assert.equal(mixedResult.success, false)
  if (!mixedResult.success) assert.ok(mixedResult.issues.some((issue) => issue.code === 'track-value-kind'))

  const invalidDiscrete = createValidSequence() as unknown as { tracks: Array<Record<string, unknown>> }
  const cameraTrack = invalidDiscrete.tracks[0]
  ;(cameraTrack.keyframes as Array<Record<string, unknown>>)[0].interpolation = 'linear'
  const discreteResult = preflightWorldSequence({ scene: createScene(), sequence: invalidDiscrete as unknown as WorldSequence })
  assert.equal(discreteResult.success, false)
  if (!discreteResult.success) assert.ok(discreteResult.issues.some((issue) => issue.code === 'discrete-interpolation'))
})

test('rejects camera invariant gaps and clipping-plane violations at exact discontinuities', () => {
  const cameraGap = createValidSequence()
  const cameraB = cameraGap.tracks[1] as Extract<WorldSequence['tracks'][number], { type: 'camera' }>
  cameraB.keyframes[0].time = { numerator: 3, denominator: 2 }
  const gapResult = preflightWorldSequence({ scene: createScene(), sequence: cameraGap })
  assert.equal(gapResult.success, false)
  if (!gapResult.success) assert.ok(gapResult.issues.some((issue) => issue.code === 'camera-primary' && issue.path.includes('1/1')), JSON.stringify(gapResult))

  const clipping = createValidSequence()
  const near = clipping.tracks[3] as Extract<WorldSequence['tracks'][number], { type: 'property' }>
  near.keyframes[1].value = 150
  const clippingResult = preflightWorldSequence({ scene: createScene(), sequence: clipping })
  assert.equal(clippingResult.success, false)
  if (!clippingResult.success) assert.ok(clippingResult.issues.some((issue) => issue.code === 'component-invariant' || issue.code === 'track-property'), JSON.stringify(clippingResult))
})

test('proves camera clipping invariants at analytic extrema between keyframes', () => {
  const sequence: WorldSequence = {
    id: 'sequence:analytic-camera', name: 'Analytic camera', duration: { numerator: 1, denominator: 1 }, tracks: [
      { id: 'track:analytic-near', type: 'property', entityId: 'entity:camera-a', componentId: 'component:camera-a', property: 'near', keyframes: [
        { id: 'key:analytic-near-0', time: { numerator: 0, denominator: 1 }, interpolation: 'cubic', value: 9.9 },
        { id: 'key:analytic-near-1', time: { numerator: 1, denominator: 1 }, value: 1 },
      ] },
      { id: 'track:analytic-far', type: 'property', entityId: 'entity:camera-a', componentId: 'component:camera-a', property: 'far', keyframes: [
        { id: 'key:analytic-far-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 10 },
        { id: 'key:analytic-far-1', time: { numerator: 1, denominator: 1 }, value: 1.1 },
      ] },
    ],
  }

  const result = preflightWorldSequence({ scene: createScene(), sequence })
  assert.equal(result.success, false, JSON.stringify(result))
  if (!result.success) {
    assert.ok(result.issues.some((issue) => issue.code === 'component-invariant' && issue.path.includes('analytic-extremum')), JSON.stringify(result))
  }
})

test('timeline events remain marker-only and reject embedded gameplay actions', () => {
  const sequence = createValidSequence() as unknown as { tracks: Array<Record<string, unknown>> }
  const eventTrack = sequence.tracks.at(-1)!
  ;(eventTrack.keyframes as Array<Record<string, unknown>>)[0].actions = [{ type: 'apply-impulse' }]
  const result = preflightWorldSequence({ scene: createScene(), sequence: sequence as unknown as WorldSequence })
  assert.equal(result.success, false)
  if (!result.success) assert.ok(result.issues.some((issue) => issue.code === 'unknown-property'))
})
