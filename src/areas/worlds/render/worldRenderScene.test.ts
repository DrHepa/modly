import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import type { WorldAnimationPlayerComponent } from '../core/worldComponentRegistry.ts'
import type { WorldSceneDocumentV1, WorldSequence } from '../core/worldModel.ts'
import {
  inspectSelfContainedGlb,
  isOfflineWorldComponentEnabled,
  projectOfflineCamera,
  WorldRenderGpuContextGuard,
  OfflineWorldRenderScene,
} from './worldRenderScene.ts'

function makeGlb(json: object): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify(json))
  const paddedLength = Math.ceil(raw.byteLength / 4) * 4
  const bytes = new Uint8Array(12 + 8 + paddedLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, bytes.byteLength, true)
  view.setUint32(12, paddedLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  bytes.fill(0x20, 20)
  bytes.set(raw, 20)
  return bytes
}

test('embedded GLB preflight rejects undeclared external dependencies and compressed decoders', () => {
  assert.deepEqual(inspectSelfContainedGlb(makeGlb({ asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin' }] })), {
    success: false,
    reason: 'external-dependency',
  })
  assert.deepEqual(inspectSelfContainedGlb(makeGlb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] })), {
    success: false,
    reason: 'unsupported-extension',
  })
  assert.deepEqual(inspectSelfContainedGlb(makeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 0 }] })), {
    success: true,
  })
})

// Invoke the real offline consumer method with only its local dependencies.
// No renderer construction, asset loading, or synthetic replacement timing math.
function offlineAnimationFixture(speed: number, loop: boolean, duration = 2) {
  const root = new THREE.Object3D()
  const clip = new THREE.AnimationClip('test track', duration, [new THREE.NumberKeyframeTrack('.position[x]', [0, 2], [0, 20])])
  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(clip).play()
  action.paused = true
  const component: WorldAnimationPlayerComponent = { id: 'component:animation', type: 'animation-player', enabled: true, resourceId: 'resource:animation', autoplay: true, speed, loop }
  const receiver = {
    animations: new Map([[component.id, { action, mixer, duration }]]),
    payload: { snapshot: { sequence: { id: 'sequence:test', name: 'Test', duration: { numerator: 4, denominator: 1 }, tracks: [] } } },
  }
  const sync = Reflect.get(OfflineWorldRenderScene.prototype, 'syncAnimation')
  assert.equal(typeof sync, 'function')
  return {
    root, clip, action, component,
    sample: (numerator: number, denominator = 1) => {
      Reflect.apply(sync, receiver, [component, { numerator, denominator }, []])
      return { time: action.time, value: root.position.x }
    },
  }
}

test('actual offline reverse once evaluates rational endpoint interior and exhaustion samples', () => {
  const fixture = offlineAnimationFixture(-1, false)
  assert.deepEqual(fixture.sample(0), { time: 2, value: 20 })
  assert.deepEqual(fixture.sample(1, 2), { time: 1.5, value: 15 })
  assert.deepEqual(fixture.sample(2), { time: 0, value: 0 })
  assert.deepEqual(fixture.sample(3), { time: 0, value: 0 })
  assert.equal(fixture.action.paused, true)
  const fast = offlineAnimationFixture(-2, false)
  assert.deepEqual(fast.sample(1, 4), { time: 1.5, value: 15 })
  assert.deepEqual(fast.sample(1), { time: 0, value: 0 })
})

test('actual offline reverse repeat uses nonnegative modulo and keeps zero origin', () => {
  const fixture = offlineAnimationFixture(-1, true)
  assert.deepEqual(fixture.sample(0), { time: 0, value: 0 })
  assert.deepEqual(fixture.sample(1, 2), { time: 1.5, value: 15 })
  assert.deepEqual(fixture.sample(2), { time: 0, value: 0 })
  assert.deepEqual(fixture.sample(5, 2), { time: 1.5, value: 15 })
  const fast = offlineAnimationFixture(-2, true)
  assert.deepEqual(fast.sample(1, 4), { time: 1.5, value: 15 })
  assert.deepEqual(fast.sample(1), { time: 0, value: 0 })
})

test('actual offline forward and stationary timing preserve clamp wrap and disabled state', () => {
  const once = offlineAnimationFixture(2, false)
  assert.deepEqual(once.sample(0), { time: 0, value: 0 })
  assert.deepEqual(once.sample(1, 4), { time: 0.5, value: 5 })
  assert.deepEqual(once.sample(3), { time: 2, value: 20 })
  const repeat = offlineAnimationFixture(2, true)
  assert.deepEqual(repeat.sample(5, 4), { time: 0.5, value: 5 })
  const stationary = offlineAnimationFixture(0, false)
  assert.deepEqual(stationary.sample(3), { time: 0, value: 0 })
  const empty = offlineAnimationFixture(-1, true, 0)
  assert.deepEqual(empty.sample(3), { time: 0, value: 0 })
  once.component.enabled = false
  assert.deepEqual(once.sample(0), { time: 2, value: 20 })
  assert.equal(once.action.enabled, false)
})

test('actual offline timing rejects nonfinite duration speed or elapsed samples', () => {
  for (const [duration, speed, numerator] of [[Infinity, -1, 1], [-1, 1, 1], [2, NaN, 1], [2, Infinity, 1], [2, 1, Infinity], [2, Number.MAX_VALUE, Number.MAX_VALUE]] as const) {
    const fixture = offlineAnimationFixture(speed, false, duration)
    assert.throws(() => fixture.sample(numerator), RangeError)
  }
})

test('offline camera projection chooses the sole authored primary and has no editor overlay state', () => {
  const scene: WorldSceneDocumentV1 = {
    schema: 'modly.world-scene.v1', projectId: 'project:test', sceneId: 'scene:test', name: 'Test',
    environment: { backgroundColor: '#123456', ambientIntensity: 0 }, sequences: [],
    entities: [{
      id: 'entity:camera', name: 'Camera', parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ id: 'component:camera', type: 'camera', enabled: true, projection: 'orthographic', primary: true, near: 0.1, far: 100, orthographicSize: 8 }],
    }],
  }
  const sequence: WorldSequence = { id: 'sequence:test', name: 'Test', duration: { numerator: 1, denominator: 1 }, tracks: [] }
  const projection = projectOfflineCamera(scene, sequence, { numerator: 0, denominator: 1 }, 16 / 9)
  assert.equal(projection.entityId, 'entity:camera')
  assert.equal(projection.projection, 'orthographic')
  assert.deepEqual(projection.frustum, { left: -64 / 9, right: 64 / 9, top: 4, bottom: -4 })
  assert.equal(Object.hasOwn(projection, 'grid'), false)
  assert.equal(Object.hasOwn(projection, 'selection'), false)
  assert.equal(Object.hasOwn(projection, 'gizmo'), false)
})

test('offline presentation ignores disabled components and enabled descendants of disabled entities', () => {
  const transform = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }
  const disabledComponent = { id: 'component:disabled', type: 'renderable' as const, enabled: false, resourceId: 'resource:disabled', visible: true, castShadow: false, receiveShadow: false, material: { baseColor: '#ffffff' as const, metallic: 0, roughness: 1, opacity: 1 } }
  const descendantComponent = { ...disabledComponent, id: 'component:descendant', enabled: true, resourceId: 'resource:descendant' }
  const scene: WorldSceneDocumentV1 = {
    schema: 'modly.world-scene.v1', projectId: 'project:test', sceneId: 'scene:test', name: 'Test',
    environment: { backgroundColor: '#000000', ambientIntensity: 0 }, sequences: [],
    entities: [
      { id: 'entity:enabled', name: 'Enabled', parentId: null, enabled: true, locked: false, tags: [], transform, components: [disabledComponent] },
      { id: 'entity:disabled-parent', name: 'Disabled parent', parentId: null, enabled: false, locked: false, tags: [], transform, components: [] },
      { id: 'entity:descendant', name: 'Descendant', parentId: 'entity:disabled-parent', enabled: true, locked: false, tags: [], transform, components: [descendantComponent] },
    ],
  }

  assert.equal(isOfflineWorldComponentEnabled(scene, 'entity:enabled', disabledComponent), false)
  assert.equal(isOfflineWorldComponentEnabled(scene, 'entity:descendant', descendantComponent), false)
})

test('GPU context loss is prevented, terminal, and restoration never revives the render', () => {
  const listeners = new Map<string, EventListener>()
  const target = {
    addEventListener: (type: string, listener: EventListener) => {
      listeners.set(type, listener)
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
  }
  const failures: Error[] = []
  const guard = new WorldRenderGpuContextGuard(target, (error) => failures.push(error))
  const lost = new Event('webglcontextlost', { cancelable: true })
  listeners.get('webglcontextlost')?.(lost)
  assert.equal(lost.defaultPrevented, true)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].name, 'WorldRenderGpuContextError')
  assert.throws(() => guard.assertUsable(), /WebGL context was lost/)
  listeners.get('webglcontextrestored')?.(new Event('webglcontextrestored'))
  assert.equal(failures.length, 1)
  assert.throws(() => guard.assertUsable(), /WebGL context was lost/)
  guard.dispose()
  assert.equal(listeners.size, 0)
})

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { WorldRenderHostResourceDescriptor } from '../../../shared/types/worldRenderHost.ts'

async function offlineLoadedExactClips() {
  return (await new GLTFLoader().parseAsync(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [],
    animations: ['Duplicate', undefined, 'Duplicate', 'animation_1', ''].map((name) => ({ ...(name === undefined ? {} : { name }), channels: [], samplers: [] })),
  }), '')).animations
}

function exactOfflineConsumer(clips: THREE.AnimationClip[], selector: object) {
  const modelId = 'resource:model', animationId = 'resource:animation'
  const entity = {
    id: 'entity:model', name: 'Model', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [
      { id: 'component:model', type: 'renderable', enabled: true, resourceId: modelId, visible: true, castShadow: false, receiveShadow: false, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } },
      { id: 'component:animation', type: 'animation-player', enabled: true, resourceId: animationId, autoplay: true, loop: true, speed: 1 },
    ],
  }
  const descriptor: WorldRenderHostResourceDescriptor = { id: animationId, name: 'Animation', type: 'animation', format: 'gltf-clip', boundModelResourceId: modelId, files: [], ...selector }
  const receiver = {
    payload: { snapshot: { scene: { entities: [entity] } } },
    entityObjects: new Map([[entity.id, new THREE.Group()]]),
    resources: new Map([[animationId, descriptor]]),
    gltfs: new Map([[modelId, { scene: new THREE.Group(), animations: clips }]]),
    renderables: new Map(), cameras: new Map(), lights: new Map(), animations: new Map(), scene: new THREE.Scene(),
  }
  const present = Reflect.get(OfflineWorldRenderScene.prototype, 'createPresentationComponents')
  assert.equal(typeof present, 'function', 'actual offline presentation method exists')
  return { receiver, present: () => Reflect.apply(present, receiver, []), action: () => receiver.animations.get('component:animation')?.action as THREE.AnimationAction | undefined }
}

test('actual offline presentation consumes exact loaded duplicate generated and colliding clips by identity', async () => {
  const clips = await offlineLoadedExactClips()
  assert.deepEqual(clips.map((clip) => clip.name), ['Duplicate', 'animation_1', 'Duplicate', 'animation_1', 'animation_4'])
  for (const clipIndex of [0, 1, 2, 3, 4]) {
    const consumer = exactOfflineConsumer(clips, { clipIndex, clipName: clips[clipIndex]!.name, clipId: 'clip:0' })
    consumer.present()
    assert.equal(consumer.action()!.getClip(), clips[clipIndex])
    assert.equal(consumer.action()!.paused, true)
    assert.equal(consumer.receiver.animations.get('component:animation').duration, clips[clipIndex]!.duration)
    consumer.action()!.stop()
  }
})

test('actual offline explicit rejection does not fall through to matching name clipId or single-clip policy', async () => {
  const clips = await offlineLoadedExactClips()
  for (const [clipIndex, clipName, reason] of [[-1, 'Duplicate', 'invalid-index'], ['0', 'Duplicate', 'invalid-index'], [5, 'Duplicate', 'index-out-of-range'], [1, 'Duplicate', 'name-mismatch']] as const) {
    const consumer = exactOfflineConsumer(clips, { clipIndex, clipName, clipId: 'clip:0' })
    assert.throws(consumer.present, new RegExp(`Indexed glTF animation selection failed \\(${reason}\\)`))
    assert.equal(consumer.action(), undefined)
    const mixer = consumer.receiver.renderables.get('component:model').mixer as THREE.AnimationMixer
    assert.equal(clips.filter((clip) => mixer.existingAction(clip)).length, 0)
  }
  const single = exactOfflineConsumer([clips[0]!], { clipIndex: 1, clipId: 'clip:0' })
  assert.throws(single.present, /index-out-of-range/)
  assert.equal(single.action(), undefined)
  assert.throws(exactOfflineConsumer([], { clipIndex: 0 }).present)
})

test('actual offline no-index name suffix and single fallback remain independently unchanged', async () => {
  const clips = await offlineLoadedExactClips()
  for (const [selector, expected] of [[{ clipName: 'Duplicate' }, 0], [{ clipName: 'missing', clipId: 'clip:3' }, 3], [{ clipId: '3' }, 3]] as const) {
    const consumer = exactOfflineConsumer(clips, selector)
    consumer.present()
    assert.equal(consumer.action()!.getClip(), clips[expected])
    consumer.action()!.stop()
  }
  const single = exactOfflineConsumer([clips[2]!], { clipName: 'missing', clipId: 'clip:99' })
  single.present()
  assert.equal(single.action()!.getClip(), clips[2])
  single.action()!.stop()
  assert.throws(exactOfflineConsumer(clips, { clipName: 'missing' }).present, /does not identify exactly one/)
})
