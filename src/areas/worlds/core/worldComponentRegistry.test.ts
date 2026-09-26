import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORLD_COMPONENT_TYPES,
  collectWorldComponentReferences,
  createDefaultWorldComponent,
  describeWorldComponentForAi,
  describeWorldComponentForEditor,
  getWorldComponentDefinition,
  isWorldComponentPropertyWritable,
  isWorldComponentPropertyWritableFor,
  parseWorldComponent,
  validateWorldInspectorFieldValue,
} from './worldComponentRegistry.ts'
import { createValidWorldSnapshot } from './_testFixtures.ts'
import { validateWorldProjectSnapshot } from './worldDocuments.ts'

const components: unknown[] = [
  { id: 'c:r', type: 'renderable', enabled: true, resourceId: 'model:one', visible: true, castShadow: true, receiveShadow: false, material: { baseColor: '#ffffff', metallic: 0.1, roughness: 0.8, opacity: 1 } },
  { id: 'c:c', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 500, fieldOfView: 60 },
  { id: 'c:l', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 2, range: 15, castShadow: true },
  { id: 'c:e', type: 'environment', enabled: true, backgroundColor: '#111111', ambientIntensity: 0.4 },
  { id: 'c:co', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [1, 2, 3], sensor: false, friction: 0.5, restitution: 0, collisionLayer: 2, collisionMask: 3 },
  { id: 'c:rb', type: 'rigid-body', enabled: true, bodyType: 'dynamic', gravityScale: 1, linearDamping: 0.1, angularDamping: 0.2, canSleep: true },
  { id: 'c:cc', type: 'character-controller', enabled: true, colliderComponentId: 'c:co', moveActionId: 'input:move', jumpActionId: 'input:jump', speed: 4, jumpSpeed: 6, maxSlopeDegrees: 45 },
  { id: 'c:ap', type: 'animation-player', enabled: true, resourceId: 'animation:walk', autoplay: false, loop: true, speed: 1 },
  { id: 'c:as', type: 'audio-source', enabled: true, resourceId: 'audio:theme', autoplay: true, loop: true, volume: 0.8, spatial: false, maxDistance: 20 },
  { id: 'c:al', type: 'audio-listener', enabled: true, primary: true },
  { id: 'c:t', type: 'trigger', enabled: true, colliderComponentId: 'c:co', once: false, targetTags: ['player'] },
  { id: 'c:b', type: 'behavior', enabled: true, bindings: [{ id: 'binding:start', event: { type: 'start' }, actions: [{ type: 'set-visibility', entityId: 'entity:door', visible: true }] }] },
]

test('fixed component policy cannot be mutated at runtime', { timeout: 20_000 }, () => {
  const original = [...WORLD_COMPONENT_TYPES]
  try {
    assert.equal(Object.isFrozen(WORLD_COMPONENT_TYPES), true)
    assert.equal(Reflect.set(WORLD_COMPONENT_TYPES, '0', 'unknown'), false)
    assert.equal(Reflect.deleteProperty(WORLD_COMPONENT_TYPES, '1'), false)
    assert.equal(Reflect.defineProperty(WORLD_COMPONENT_TYPES, '12', { value: 'unknown' }), false)
    assert.throws(() => Array.prototype.splice.call(WORLD_COMPONENT_TYPES, 0, 1), TypeError)
    assert.deepEqual(WORLD_COMPONENT_TYPES, original)
    for (const type of WORLD_COMPONENT_TYPES) {
      const definition = getWorldComponentDefinition(type)
      assert.ok(definition)
      assert.equal(Object.isFrozen(definition), true)
      assert.equal(Object.isFrozen(definition.writableProperties), true)
      assert.equal(Reflect.set(definition, 'cardinality', 'unknown'), false)
      assert.equal(Reflect.set(definition, 'entityAllowed', !definition.entityAllowed), false)
      assert.equal(Reflect.set(definition.writableProperties, '0', 'unknown'), false)
    }
    for (const component of components) assert.equal(parseWorldComponent(component).success, true)
  } finally {
    if (!Object.isFrozen(WORLD_COMPONENT_TYPES)) Array.prototype.splice.call(WORLD_COMPONENT_TYPES, 0, WORLD_COMPONENT_TYPES.length, ...original)
  }
})

test('registry exposes and parses exactly the twelve canonical component types', () => {
  assert.deepEqual(WORLD_COMPONENT_TYPES, [
    'renderable', 'camera', 'light', 'environment', 'collider', 'rigid-body',
    'character-controller', 'animation-player', 'audio-source', 'audio-listener', 'trigger', 'behavior',
  ])
  for (const component of components) {
    const parsed = parseWorldComponent(component)
    assert.equal(parsed.success, true, JSON.stringify(parsed))
  }
  assert.equal(getWorldComponentDefinition('renderable')?.cardinality, 'one')
  assert.equal(getWorldComponentDefinition('collider')?.cardinality, 'many')
  assert.equal(getWorldComponentDefinition('environment')?.entityAllowed, false)
})

test('registry classifies every writable property under one explicit Play runtime authority', () => {
  const expected = {
    renderable: { authority: 'presentation', writable: ['enabled', 'visible', 'castShadow', 'receiveShadow', 'material.baseColor', 'material.metallic', 'material.roughness', 'material.opacity'] },
    camera: { authority: 'presentation', writable: ['enabled', 'primary', 'near', 'far', 'fieldOfView', 'orthographicSize'] },
    light: { authority: 'presentation', writable: ['enabled', 'color', 'intensity', 'range', 'angle', 'castShadow'] },
    environment: { authority: 'presentation', writable: ['enabled', 'backgroundColor', 'ambientIntensity'] },
    collider: { authority: 'physics', writable: ['enabled', 'sensor', 'friction', 'restitution', 'collisionLayer', 'collisionMask'] },
    'rigid-body': { authority: 'physics', writable: ['enabled', 'gravityScale', 'linearDamping', 'angularDamping', 'canSleep'] },
    'character-controller': { authority: 'physics', writable: ['enabled', 'speed', 'jumpSpeed', 'maxSlopeDegrees'] },
    'animation-player': { authority: 'presentation', writable: ['enabled', 'autoplay', 'loop', 'speed'] },
    'audio-source': { authority: 'audio', writable: ['enabled', 'autoplay', 'loop', 'volume', 'spatial', 'maxDistance'] },
    'audio-listener': { authority: 'audio', writable: ['enabled', 'primary'] },
    trigger: { authority: 'behavior', writable: ['enabled', 'once'] },
    behavior: { authority: 'behavior', writable: ['enabled'] },
  } as const
  for (const type of WORLD_COMPONENT_TYPES) {
    const definition = getWorldComponentDefinition(type)
    assert.ok(definition, type)
    assert.equal(definition?.runtimeAuthority, expected[type].authority, type)
    assert.deepEqual(definition?.writableProperties, expected[type].writable, type)
    const liveProperties = definition?.livePropertyCapabilities.map((capability) => capability.property).sort() ?? []
    if (definition?.runtimeAuthority === 'presentation' && type !== 'animation-player') {
      assert.deepEqual(liveProperties, [...definition.writableProperties].sort(), `${type} live property coverage`)
    } else {
      assert.deepEqual(liveProperties, [], `${type} requires an authority patch`)
    }
  }
  const renderableCapabilities = getWorldComponentDefinition('renderable')?.livePropertyCapabilities ?? []
  assert.deepEqual(renderableCapabilities.find((capability) => capability.property === 'visible')?.modelFormats, ['glb', 'gltf', 'ply-mesh', 'ply-points', 'gaussian-ply'])
  assert.deepEqual(renderableCapabilities.find((capability) => capability.property === 'material.baseColor')?.modelFormats, ['glb', 'gltf'])
  assert.deepEqual(renderableCapabilities.find((capability) => capability.property === 'material.metallic')?.modelFormats, ['glb', 'gltf', 'ply-mesh'])
  assert.deepEqual(getWorldComponentDefinition('animation-player')?.livePropertyCapabilities, [])
})

test('component references and AI descriptions expose ids without unsafe state', () => {
  const controller = parseWorldComponent(components[6])
  assert.equal(controller.success, true)
  if (controller.success !== true) return
  assert.deepEqual(collectWorldComponentReferences(controller.value), [
    { kind: 'component', id: 'c:co', path: 'colliderComponentId' },
    { kind: 'input-action', id: 'input:jump', path: 'jumpActionId' },
    { kind: 'input-action', id: 'input:move', path: 'moveActionId' },
  ])
  const description = {
    id: 'c:cc',
    type: 'character-controller',
    enabled: true,
    label: 'Character controller',
    editorSection: 'Physics',
    allowedFields: ['enabled', 'speed', 'jumpSpeed', 'maxSlopeDegrees'],
    references: [
      { kind: 'component', id: 'c:co' },
      { kind: 'input-action', id: 'input:jump' },
      { kind: 'input-action', id: 'input:move' },
    ],
  }
  assert.deepEqual(describeWorldComponentForAi(controller.value), description)
  assert.deepEqual(describeWorldComponentForEditor(controller.value), description)
  const serialized = JSON.stringify(description)
  for (const forbidden of ['Object3D', 'http://', 'https://', '/home/', 'workspacePath', 'setter']) assert.equal(serialized.includes(forbidden), false)

  const renderable = {
    id: 'component:safe-description', type: 'renderable', enabled: true, resourceId: 'resource:safe-description', visible: true,
    castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
  }
  for (const unsafe of ['/home/private/secret', 'https://example.invalid/private.glb', 'https:example.com', 'mailto:private@example.com', 'urn:private:secret']) {
    assert.equal(parseWorldComponent({ ...renderable, id: unsafe }).success, false, unsafe)
    assert.equal(parseWorldComponent({ ...renderable, resourceId: unsafe }).success, false, unsafe)
    const forged = { ...structuredClone(controller.value), id: unsafe }
    assert.throws(() => describeWorldComponentForAi(forged), /canonical component/i, unsafe)
  }
})

test('registry exposes deterministic parseable defaults and editor metadata for all twelve component types', () => {
  for (const type of WORLD_COMPONENT_TYPES) {
    const definition = getWorldComponentDefinition(type)
    assert.ok(definition, type)
    if (!definition) continue
    assert.ok(definition.label.length > 0 && definition.label.length <= 32, type)
    assert.ok(definition.editorSection.length > 0, type)
    assert.ok(definition.inspectorFields.some((field) => field.property === 'enabled' && field.control === 'toggle'), type)
    for (const field of definition.inspectorFields) {
      assert.ok(field.label.length > 0, `${type}.${field.property}`)
      assert.ok(field.control.length > 0, `${type}.${field.property}`)
    }
    const id = `default:${type}`
    const first = definition.createDefault(id)
    const second = definition.createDefault(id)
    assert.notEqual(first, second, type)
    assert.deepEqual(first, second, type)
    assert.deepEqual(createDefaultWorldComponent(type, id), first, type)
    assert.equal(parseWorldComponent(first).success, true, `${type}: ${JSON.stringify(first)}`)
  }
})

test('registry defaults validate in a scene once controller and trigger companions are supplied', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.inputActions.push({ id: 'input:move', name: 'Move', valueType: 'axis2d', bindings: [] })

  const controllerCollider = createDefaultWorldComponent('collider', 'component:collider')
  const controllerBody = createDefaultWorldComponent('rigid-body', 'component:controller-body')
  const controller = createDefaultWorldComponent('character-controller', 'component:controller')
  assert.equal(controllerCollider.type, 'collider')
  assert.equal(controllerBody.type, 'rigid-body')
  assert.equal(controller.type, 'character-controller')
  if (controllerCollider.type !== 'collider' || controllerBody.type !== 'rigid-body' || controller.type !== 'character-controller') return
  controllerCollider.enabled = true
  controllerCollider.purpose = 'simulation'
  controllerCollider.sensor = false
  controllerBody.enabled = true
  controllerBody.bodyType = 'kinematic-position'
  controller.enabled = true
  controller.colliderComponentId = controllerCollider.id
  controller.moveActionId = 'input:move'
  controller.jumpActionId = 'input:jump'
  snapshot.scenes[0].entities.push({
    id: 'entity:controller', name: 'Controller', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [controllerCollider, controllerBody, controller],
  })

  const triggerCollider = createDefaultWorldComponent('collider', 'component:trigger-collider')
  const trigger = createDefaultWorldComponent('trigger', 'component:trigger')
  assert.equal(triggerCollider.type, 'collider')
  assert.equal(trigger.type, 'trigger')
  if (triggerCollider.type !== 'collider' || trigger.type !== 'trigger') return
  triggerCollider.enabled = true
  triggerCollider.purpose = 'simulation'
  triggerCollider.sensor = true
  trigger.enabled = true
  trigger.colliderComponentId = triggerCollider.id
  snapshot.scenes[0].entities.push({
    id: 'entity:trigger-default', name: 'Trigger', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [triggerCollider, trigger],
  })

  assert.equal(validateWorldProjectSnapshot(snapshot).success, true)
})

test('inspector metadata describes conditional light, collider, and rigid-body fields without becoming a validator', () => {
  const lightFields = getWorldComponentDefinition('light')?.inspectorFields ?? []
  assert.deepEqual(lightFields.find((field) => field.property === 'range')?.visibleWhen, { property: 'lightKind', oneOf: ['point', 'spot'] })
  assert.deepEqual(lightFields.find((field) => field.property === 'angle')?.visibleWhen, { property: 'lightKind', equals: 'spot' })
  assert.deepEqual(lightFields.find((field) => field.property === 'castShadow')?.visibleWhen, { property: 'lightKind', oneOf: ['directional', 'point', 'spot'] })

  const colliderFields = getWorldComponentDefinition('collider')?.inspectorFields ?? []
  assert.deepEqual(colliderFields.find((field) => field.property === 'resourceId')?.visibleWhen, { property: 'shape', oneOf: ['convex', 'mesh'] })
  assert.deepEqual(colliderFields.find((field) => field.property === 'halfHeight')?.visibleWhen, { property: 'shape', equals: 'capsule' })
  assert.ok(colliderFields.some((field) => field.property === 'halfExtents' && field.control === 'vector3' && field.visibleWhen && 'equals' in field.visibleWhen && field.visibleWhen.equals === 'box'))
  assert.ok(colliderFields.some((field) => field.property === 'vertices' && field.control === 'triangle2d' && field.visibleWhen && 'equals' in field.visibleWhen && field.visibleWhen.equals === 'tri-surface'))

  const bodyFields = getWorldComponentDefinition('rigid-body')?.inspectorFields ?? []
  assert.deepEqual(bodyFields.find((field) => field.property === 'gravityScale')?.visibleWhen, { property: 'bodyType', equals: 'dynamic' })
  assert.deepEqual(bodyFields.find((field) => field.property === 'linearDamping')?.visibleWhen, { property: 'bodyType', oneOf: ['dynamic', 'kinematic-position', 'kinematic-velocity'] })

  const point = parseWorldComponent(components[2])
  assert.equal(point.success, true)
  if (point.success !== true) return
  for (const value of [-1, 0, 3]) {
    assert.equal(validateWorldInspectorFieldValue(point.value, 'intensity', value), isWorldComponentPropertyWritableFor(point.value, 'intensity', value))
  }
  assert.equal(validateWorldInspectorFieldValue(point.value, 'lightKind', 'spot'), false)
})

test('behavior parser rejects JavaScript, unknown actions, and non-writable paths', () => {
  for (const value of [
    { id: 'bad', type: 'behavior', enabled: true, script: 'alert(1)', bindings: [] },
    { id: 'bad', type: 'behavior', enabled: true, bindings: [{ id: 'b', event: { type: 'start' }, actions: [{ type: 'eval', code: '1' }] }] },
    { id: 'bad', type: 'behavior', enabled: true, bindings: [{ id: 'b', event: { type: 'start' }, actions: [{ type: 'set-component-property', entityId: 'e', componentId: 'c', componentType: 'renderable', property: '__proto__.polluted', value: true }] }] },
    { id: 'bad', type: 'behavior', enabled: true, bindings: [{ id: 'b', event: { type: 'start' }, actions: [{ type: 'set-component-property', entityId: 'e', componentId: 'c', componentType: 'collider', property: 'shape', value: 'sphere' }] }] },
  ]) assert.equal(parseWorldComponent(value).success, false)

  assert.equal(isWorldComponentPropertyWritable('light', 'intensity', 2), true)
  assert.equal(isWorldComponentPropertyWritable('light', 'id', 'replaced'), false)
  assert.equal(isWorldComponentPropertyWritable('renderable', 'material.baseColor', '#ff0000'), true)
  assert.equal(isWorldComponentPropertyWritable('renderable', 'material.shader', 'custom'), false)
})

test('writable behavior properties enforce the target subtype value domain', () => {
  for (const action of [
    { type: 'set-component-property', entityId: 'e', componentId: 'c', componentType: 'renderable', property: 'material.opacity', value: 2 },
    { type: 'set-component-property', entityId: 'e', componentId: 'c', componentType: 'light', property: 'intensity', value: -1 },
    { type: 'set-component-property', entityId: 'e', componentId: 'c', componentType: 'camera', property: 'near', value: 0 },
  ]) {
    assert.equal(parseWorldComponent({ id: 'bad-domain', type: 'behavior', enabled: true, bindings: [{ id: 'b', event: { type: 'start' }, actions: [action] }] }).success, false)
  }
})

test('writable-property validation mirrors every bounded component parser domain', () => {
  const cases: Array<[string, string, unknown, boolean]> = [
    ['renderable', 'material.metallic', 0.5, true],
    ['renderable', 'material.metallic', -0.1, false],
    ['renderable', 'material.roughness', 1.1, false],
    ['renderable', 'material.opacity', Number.NaN, false],
    ['camera', 'near', 0.01, true],
    ['camera', 'near', 0, false],
    ['camera', 'far', -1, false],
    ['camera', 'fieldOfView', 180, false],
    ['camera', 'orthographicSize', 0, false],
    ['light', 'intensity', 0, true],
    ['light', 'intensity', -1, false],
    ['light', 'range', 0, false],
    ['light', 'angle', Math.PI, false],
    ['environment', 'ambientIntensity', -1, false],
    ['collider', 'friction', -1, false],
    ['collider', 'restitution', 1.1, false],
    ['collider', 'collisionLayer', 1.5, false],
    ['collider', 'collisionMask', 0x1_0000_0000, false],
    ['rigid-body', 'gravityScale', Number.POSITIVE_INFINITY, false],
    ['rigid-body', 'linearDamping', -1, false],
    ['character-controller', 'speed', -1, false],
    ['character-controller', 'jumpSpeed', -1, false],
    ['character-controller', 'maxSlopeDegrees', 91, false],
    ['animation-player', 'speed', 0, false],
    ['audio-source', 'volume', 1.1, false],
    ['audio-source', 'maxDistance', 0, false],
    ['trigger', 'once', 1, false],
  ]
  for (const [type, property, value, expected] of cases) {
    assert.equal(isWorldComponentPropertyWritable(type, property, value), expected, `${type}.${property}=${String(value)}`)
  }
})

test('collider layer and mask preserve Rapier v1 interaction groups exactly', () => {
  const base = { id: 'collider:groups', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [1, 1, 1], sensor: false, friction: 0, restitution: 0 }
  for (const value of [0, 0xffff]) {
    assert.equal(parseWorldComponent({ ...base, collisionLayer: value, collisionMask: value }).success, true, String(value))
    assert.equal(isWorldComponentPropertyWritable('collider', 'collisionLayer', value), true)
    assert.equal(isWorldComponentPropertyWritable('collider', 'collisionMask', value), true)
  }
  for (const value of [-1, 0x1_0000, 1.5]) {
    assert.equal(parseWorldComponent({ ...base, collisionLayer: value, collisionMask: value }).success, false, String(value))
    assert.equal(isWorldComponentPropertyWritable('collider', 'collisionLayer', value), false)
    assert.equal(isWorldComponentPropertyWritable('collider', 'collisionMask', value), false)
  }
})

test('component parser rejects inherited fields, accessors, and class instances but accepts null-prototype records', () => {
  const renderable = components[0]
  if (typeof renderable !== 'object' || renderable === null || Array.isArray(renderable)) throw new Error('Renderable fixture must be a record.')
  assert.equal(parseWorldComponent(Object.create(renderable)).success, false)

  let getterCalls = 0
  const accessor = { ...renderable }
  Object.defineProperty(accessor, 'id', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'accessor'
    },
  })
  assert.equal(parseWorldComponent(accessor).success, false)
  assert.equal(getterCalls, 0)

  class ComponentRecord {}
  assert.equal(parseWorldComponent(Object.assign(new ComponentRecord(), renderable)).success, false)

  const source = renderable
  const nullPrototype = Object.assign(Object.create(null), source)
  const material = Reflect.get(source, 'material')
  if (typeof material === 'object' && material !== null && !Array.isArray(material)) {
    nullPrototype.material = Object.assign(Object.create(null), material)
  }
  assert.equal(parseWorldComponent(nullPrototype).success, true)
})

test('legacy surface shapes are restricted to editor navigation colliders', () => {
  const surface = { id: 'surface', type: 'collider', enabled: true, shape: 'rect-surface', halfExtents: [4, 2], sidedness: 'double', sensor: false, friction: 0, restitution: 0 }
  assert.equal(parseWorldComponent({ ...surface, purpose: 'editor-navigation' }).success, true)
  assert.equal(parseWorldComponent({ ...surface, purpose: 'simulation' }).success, false)
  const preset = parseWorldComponent({ ...surface, purpose: 'editor-navigation', legacyPreset: 'floor' })
  assert.equal(preset.success, true)
  if (preset.success === true && preset.value.type === 'collider' && preset.value.shape === 'rect-surface') assert.equal(preset.value.legacyPreset, 'floor')
  assert.equal(parseWorldComponent({ ...surface, purpose: 'editor-navigation', legacyPreset: 'triangle' }).success, false)
  assert.equal(parseWorldComponent({ ...surface, purpose: 'editor-navigation', legacyPreset: 'unknown' }).success, false)
})

test('component wire boundary rejects transparent and throwing wrappers without throwing', () => {
  const renderable = components[0]
  let reads = 0
  const transparent = new Proxy(renderable as object, {
    get(target, property, receiver) {
      reads += 1
      return Reflect.get(target, property, receiver)
    },
  })
  assert.equal(parseWorldComponent(transparent).success, false)
  assert.equal(reads, 0)

  const throwing = new Proxy(renderable as object, {
    getPrototypeOf() {
      throw new Error('wrapper trap')
    },
  })
  assert.doesNotThrow(() => parseWorldComponent(throwing))
  assert.equal(parseWorldComponent(throwing).success, false)
})

test('component ids, behavior collections, and writable property names share bounded canonical domains', () => {
  const base = components[0]
  assert.equal(parseWorldComponent({ ...(base as Record<string, unknown>), id: 'x'.repeat(256) }).success, true)
  assert.equal(parseWorldComponent({ ...(base as Record<string, unknown>), id: 'x'.repeat(257) }).success, false)

  const oversizedActions = Array.from({ length: 1_025 }, () => ({ type: 'set-visibility', entityId: 'entity:hero', visible: true }))
  const oversizedBehavior = { id: 'behavior:bounded', type: 'behavior', enabled: true, bindings: [{ id: 'binding:bounded', event: { type: 'start' }, actions: oversizedActions }] }
  const firstOversized = parseWorldComponent(oversizedBehavior)
  const secondOversized = parseWorldComponent(oversizedBehavior)
  assert.equal(firstOversized.success, false)
  assert.deepEqual(firstOversized, secondOversized)
  if (firstOversized.success === false) assert.ok(firstOversized.issues.length <= 64)
  assert.equal(parseWorldComponent({ id: 'behavior:key', type: 'behavior', enabled: true, bindings: [{ id: 'binding:key', event: { type: 'start' }, actions: [{ type: 'set-component-property', entityId: 'entity:hero', componentId: 'component:hero', componentType: 'renderable', property: 'x'.repeat(257), value: true }] }] }).success, false)
})

test('light parsing and writable domains are subtype-specific', () => {
  const ambient = { id: 'light:ambient', type: 'light', enabled: true, lightKind: 'ambient', color: '#ffffff', intensity: 1 }
  const parsedAmbient = parseWorldComponent(ambient)
  assert.equal(parsedAmbient.success, true, JSON.stringify(parsedAmbient))
  for (const extra of [{ range: 1 }, { angle: 1 }, { castShadow: false }]) {
    assert.equal(parseWorldComponent({ ...ambient, ...extra }).success, false)
  }
  if (parsedAmbient.success === true && parsedAmbient.value.type === 'light') {
    assert.equal(isWorldComponentPropertyWritableFor(parsedAmbient.value, 'range', 1), false)
    assert.equal(isWorldComponentPropertyWritableFor(parsedAmbient.value, 'angle', 1), false)
    assert.equal(isWorldComponentPropertyWritableFor(parsedAmbient.value, 'castShadow', true), false)
  }
})
