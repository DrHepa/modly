import assert from 'node:assert/strict'
import test from 'node:test'

import { isWorldComponentPropertyWritable, type WorldBehaviorAction, type WorldComponentType, type WorldWritableValue } from '../core/worldComponentRegistry.ts'
import { validateWorldProjectSnapshot } from '../core/worldDocuments.ts'
import { createRuntimeWorldSnapshot, nestRuntimeCameraUnderDisabledParent } from './_testFixtures.ts'
import { createWorldBehaviorRuntime, validateWorldStartTransitionGraph } from './worldBehaviorRuntime.ts'
import { WorldInputSampler } from './worldInputRuntime.ts'

test('behavior runtime evaluates Start, Input, Timer and Trigger in authored order', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const created = createWorldBehaviorRuntime(snapshot, 'scene:one')
  assert.equal(created.success, true)
  if (!created.success) return
  assert.deepEqual(created.runtime.start().effects.map((effect) => effect.action.type), ['set-visibility'])
  const sampler = new WorldInputSampler(snapshot.project.inputActions)
  sampler.setControl('keyboard', 'Space', 1)
  const step = created.runtime.step(0.5, sampler.sample(), [{ type: 'enter', triggerComponentId: 'component:zone-trigger', otherEntityId: 'entity:hero', otherTags: ['player'] }])
  assert.deepEqual(step.effects.map((effect) => effect.action.type), ['play-audio', 'play-animation', 'change-scene'])
  assert.equal(step.sceneTransition?.sceneId, 'scene:two')
  assert.equal(step.diagnostics.some((issue) => issue.code === 'scene-transition-superseded'), true)
  assert.equal(created.runtime.step(0.01, sampler.sample(), [{ type: 'enter', triggerComponentId: 'component:zone-trigger', otherEntityId: 'entity:hero', otherTags: ['player'] }]).effects.length, 0)
})

test('behavior runtime rejects stale input audio and scene references before external effects', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  behavior.bindings = [{
    id: 'binding:stale-portal',
    event: { type: 'input', actionId: 'input:missing', phase: 'pressed' },
    actions: [
      { type: 'play-audio', entityId: 'entity:camera', componentId: 'component:missing-audio' },
      { type: 'change-scene', sceneId: 'scene:missing' },
    ],
  }]
  const created = createWorldBehaviorRuntime(snapshot, 'scene:one')
  assert.equal(created.success, false)
  if (created.success) return
  assert.deepEqual(created.issues.map((issue) => issue.code), [
    'runtime-input-action-missing',
    'runtime-audio-source-missing',
    'runtime-scene-target-missing',
  ])
})

test('behavior runtime suppresses duplicate trigger enter until the matching exit clears the gate', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const trigger = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:zone')?.components.find((component) => component.type === 'trigger')
  if (trigger?.type !== 'trigger') throw new Error('Runtime trigger fixture is unavailable.')
  trigger.once = false
  const created = createWorldBehaviorRuntime(snapshot, 'scene:one')
  assert.equal(created.success, true)
  if (!created.success) return
  const enter = { type: 'enter' as const, triggerComponentId: 'component:zone-trigger', otherEntityId: 'entity:hero', otherTags: ['player'] }
  const exit = { type: 'exit' as const, triggerComponentId: 'component:zone-trigger', otherEntityId: 'entity:hero', otherTags: ['player'] }
  assert.deepEqual(created.runtime.step(0.01, { sequence: 1, actions: {} }, [enter]).effects.map((effect) => effect.action.type), ['change-scene'])
  assert.deepEqual(created.runtime.step(0.01, { sequence: 2, actions: {} }, [enter]).effects, [])
  assert.deepEqual(created.runtime.step(0.01, { sequence: 3, actions: {} }, [exit]).effects, [])
  assert.deepEqual(created.runtime.step(0.01, { sequence: 4, actions: {} }, [enter]).effects.map((effect) => effect.action.type), ['change-scene'])
})

test('unsupported sequence events fail preflight instead of being ignored', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')!
  if (behavior.type !== 'behavior') throw new Error('fixture')
  behavior.bindings[0].event = { type: 'sequence-event', sequenceId: 'sequence:missing', eventId: 'event:missing' }
  const result = createWorldBehaviorRuntime(snapshot, 'scene:one')
  assert.equal(result.success, false)
  if (!result.success) assert.equal(result.issues[0]?.code, 'unsupported-behavior-event')
})

test('enabled behavior child under a disabled parent never emits Start', () => {
  const snapshot = createRuntimeWorldSnapshot()
  nestRuntimeCameraUnderDisabledParent(snapshot)
  assert.equal(validateWorldProjectSnapshot(snapshot).success, true)
  const created = createWorldBehaviorRuntime(snapshot, 'scene:one')
  assert.equal(created.success, true)
  if (created.success) assert.deepEqual(created.runtime.start().effects, [])
})

test('shared Start-transition graph authority accepts an acyclic chain and pinpoints the action that closes a cycle', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const start = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (start?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  start.bindings[0]!.actions.push({ type: 'change-scene', sceneId: 'scene:two' })

  const acyclic = validateWorldStartTransitionGraph(snapshot, ['scene:one', 'scene:two'])
  assert.equal(acyclic.success, true)
  if (acyclic.success) assert.deepEqual(acyclic.chains.map((chain) => chain.sceneIds), [['scene:one', 'scene:two'], ['scene:two']])

  snapshot.scenes[1].entities[0].components.push({
    id: 'component:scene-two-start', type: 'behavior', enabled: true,
    bindings: [{ id: 'binding:scene-two-start', event: { type: 'start' }, actions: [{ type: 'change-scene', sceneId: 'scene:one' }] }],
  })
  const cyclic = validateWorldStartTransitionGraph(snapshot, ['scene:one', 'scene:two'])
  assert.equal(cyclic.success, false)
  if (!cyclic.success) {
    assert.equal(cyclic.issues[0]?.code, 'runtime-start-transition-cycle')
    assert.equal(cyclic.issues[0]?.path, 'scenes.scene:two.behaviors.component:scene-two-start.binding:scene-two-start.actions')
    assert.equal(cyclic.issues[0]?.message, 'Start behavior created a scene transition cycle at scene:one.')
  }
})

test('disabled behaviors still preflight non-live property actions before runtime authorities exist', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  behavior.enabled = false
  behavior.bindings[0]!.actions = [{
    type: 'set-component-property',
    entityId: 'entity:crate',
    componentId: 'component:crate-body',
    componentType: 'rigid-body',
    property: 'gravityScale',
    value: 0,
  }]
  assert.equal(validateWorldProjectSnapshot(snapshot).success, true)
  const created = createWorldBehaviorRuntime(snapshot, 'scene:one')
  assert.equal(created.success, false)
  if (!created.success) {
    assert.equal(created.issues[0]?.code, 'runtime-property-authority-unsupported')
    assert.equal(created.issues[0]?.path, 'scenes.entities[0].components[3].bindings[0].actions[0].property')
  }
})

test('authority-managed writable properties fail Play preflight with exact target diagnostics', () => {
  const snapshot = createRuntimeWorldSnapshot()
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  const cases: Array<{
    entityId: string
    componentId: string
    componentType: WorldComponentType
    values: Record<string, WorldWritableValue>
  }> = [
    { entityId: 'entity:crate', componentId: 'component:crate-body', componentType: 'rigid-body', values: { enabled: false, gravityScale: 0, linearDamping: 0.2, angularDamping: 0.3, canSleep: false } },
    { entityId: 'entity:crate', componentId: 'component:crate-collider', componentType: 'collider', values: { enabled: false, sensor: true, friction: 0.2, restitution: 0.3, collisionLayer: 2, collisionMask: 4 } },
    { entityId: 'entity:hero', componentId: 'component:hero-controller', componentType: 'character-controller', values: { enabled: false, speed: 4, jumpSpeed: 5, maxSlopeDegrees: 30 } },
    { entityId: 'entity:camera', componentId: 'component:beep', componentType: 'audio-source', values: { enabled: false, autoplay: true, loop: true, volume: 0.5, spatial: true, maxDistance: 10 } },
    { entityId: 'entity:camera', componentId: 'component:listener', componentType: 'audio-listener', values: { enabled: false, primary: false } },
    { entityId: 'entity:zone', componentId: 'component:zone-trigger', componentType: 'trigger', values: { enabled: false, once: false } },
    { entityId: 'entity:camera', componentId: 'component:camera-behavior', componentType: 'behavior', values: { enabled: false } },
  ]
  const actions: WorldBehaviorAction[] = cases.flatMap((entry) => Object.entries(entry.values).map(([property, value]) => ({
    type: 'set-component-property' as const,
    entityId: entry.entityId,
    componentId: entry.componentId,
    componentType: entry.componentType,
    property,
    value,
  })))
  behavior.bindings[0]!.actions = actions
  assert.equal(validateWorldProjectSnapshot(snapshot).success, true)
  assert.equal(isWorldComponentPropertyWritable('collider', 'shape', 'sphere'), false)
  const created = createWorldBehaviorRuntime(snapshot, 'scene:one')
  assert.equal(created.success, false)
  if (created.success) return
  assert.equal(created.issues.length, actions.length)
  const gravityIssue = created.issues.find((issue) => issue.message.includes('gravityScale'))
  assert.equal(gravityIssue?.code, 'runtime-property-authority-unsupported')
  assert.equal(
    gravityIssue?.message,
    'Play cannot update entity:crate/component:crate-body.gravityScale live because rigid-body is owned by the physics runtime.',
  )
  assert.match(gravityIssue?.path ?? '', /actions\[1\]\.property$/)
})

test('presentation property preflight rejects renderer formats that cannot apply the write live', () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.resources.push(
    { id: 'resource:points', type: 'model', name: 'Points', workspacePath: 'Assets/points.ply', format: 'ply-points' },
    { id: 'resource:mesh', type: 'model', name: 'Mesh', workspacePath: 'Assets/mesh.ply', format: 'ply-mesh' },
    { id: 'resource:gaussian', type: 'model', name: 'Gaussian', workspacePath: 'Assets/gaussian.ply', format: 'gaussian-ply' },
  )
  snapshot.scenes[0].entities.push(
    {
      id: 'entity:points', name: 'Points', parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [
        { id: 'component:points-renderable', type: 'renderable', enabled: true, resourceId: 'resource:points', visible: true, castShadow: false, receiveShadow: false, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } },
        { id: 'component:points-animation', type: 'animation-player', enabled: true, resourceId: 'resource:walk', autoplay: true, loop: true, speed: 1 },
      ],
    },
    {
      id: 'entity:mesh', name: 'Mesh', parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ id: 'component:mesh-renderable', type: 'renderable', enabled: true, resourceId: 'resource:mesh', visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } }],
    },
    {
      id: 'entity:gaussian', name: 'Gaussian', parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ id: 'component:gaussian-renderable', type: 'renderable', enabled: true, resourceId: 'resource:gaussian', visible: true, castShadow: false, receiveShadow: false, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } }],
    },
  )
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  behavior.bindings[0]!.actions = [
    { type: 'set-component-property', entityId: 'entity:points', componentId: 'component:points-renderable', componentType: 'renderable', property: 'material.metallic', value: 0.4 },
    { type: 'set-component-property', entityId: 'entity:points', componentId: 'component:points-animation', componentType: 'animation-player', property: 'speed', value: 2 },
    { type: 'set-component-property', entityId: 'entity:mesh', componentId: 'component:mesh-renderable', componentType: 'renderable', property: 'material.baseColor', value: '#ff0000' },
    { type: 'set-component-property', entityId: 'entity:gaussian', componentId: 'component:gaussian-renderable', componentType: 'renderable', property: 'material.baseColor', value: '#00ff00' },
    { type: 'set-component-property', entityId: 'entity:hero', componentId: 'component:hero-animation', componentType: 'animation-player', property: 'speed', value: 2 },
    { type: 'set-component-property', entityId: 'entity:gaussian', componentId: 'component:gaussian-renderable', componentType: 'renderable', property: 'visible', value: false },
    { type: 'set-component-property', entityId: 'entity:hero', componentId: 'component:hero-renderable', componentType: 'renderable', property: 'material.opacity', value: 0.5 },
  ]
  assert.equal(validateWorldProjectSnapshot(snapshot).success, true)
  const created = createWorldBehaviorRuntime(snapshot, 'scene:one')
  assert.equal(created.success, false)
  if (created.success) return
  assert.equal(created.issues.length, 5)
  assert.deepEqual(created.issues.map((issue) => issue.code), Array(5).fill('runtime-property-presentation-unsupported'))
  assert.equal(created.issues[0]?.message, 'Play cannot update entity:points/component:points-renderable.material.metallic live for model format ply-points.')
  assert.equal(created.issues[1]?.message, 'Play cannot update entity:points/component:points-animation.speed live for model format ply-points and animation format gltf-clip.')
})
