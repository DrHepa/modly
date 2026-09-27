import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { build } from 'vite'
import type { Plugin } from 'vite'

import type { WorldPhysicsBodyDto, WorldPhysicsSceneDto, WorldPhysicsTriggerEvent } from './worldPhysicsProtocol.ts'

const RAPIER_WASM_MODULE_SUFFIX = '/node_modules/@dimforge/rapier3d/rapier_wasm3d.js'
const RAPIER_WASM_ESM_IMPORT = 'import * as wasm from "./rapier_wasm3d_bg.wasm";'

function rapierWasmIntegration(): Plugin {
  return {
    name: 'modly-test-rapier-wasm-integration',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith(RAPIER_WASM_MODULE_SUFFIX)) return null
      if (!code.includes(RAPIER_WASM_ESM_IMPORT)) throw new Error('Pinned Rapier WASM entry no longer matches the test integration contract.')
      return code.replace(RAPIER_WASM_ESM_IMPORT, [
        'import initRapierWasm from "./rapier_wasm3d_bg.wasm?init";',
        'import * as rapierWasmBindings from "./rapier_wasm3d_bg.js";',
        'const rapierWasmInstance = await initRapierWasm({ "./rapier_wasm3d_bg.js": rapierWasmBindings });',
        'const wasm = rapierWasmInstance.exports;',
      ].join('\n'))
    },
  }
}

test('real Rapier World applies recovery impulses at their authored fixed ticks', async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../../..')
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'modly-world-rapier-'))
  const outputDirectory = path.join(temporaryRoot, 'out')
  const entryPath = path.join(temporaryRoot, 'entry.mjs')
  const rapierUrl = pathToFileURL(path.join(repositoryRoot, 'node_modules/@dimforge/rapier3d/rapier.js')).href
  const stepperUrl = pathToFileURL(path.join(repositoryRoot, 'src/areas/worlds/runtime/worldRapierStep.ts')).href
  await writeFile(entryPath, `
const [{ default: RAPIER }, { executeWorldPhysicsFixedSteps }] = await Promise.all([
  import(${JSON.stringify(rapierUrl)}),
  import(${JSON.stringify(stepperUrl)}),
])

function createBody() {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 })
  world.timestep = 1 / 60
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setAdditionalMass(1))
  world.createCollider(RAPIER.ColliderDesc.ball(0.5), body)
  world.step()
  return { world, body }
}

const steps = Array.from({ length: 4 }, () => ({
  characters: [],
  impulses: [{ entityId: 'entity:body', impulse: [1, 0, 0] }],
}))
const sequential = createBody()
executeWorldPhysicsFixedSteps(
  steps,
  (impulse) => sequential.body.applyImpulse({ x: impulse.impulse[0], y: impulse.impulse[1], z: impulse.impulse[2] }, true),
  () => sequential.world.step(),
)
const sequentialX = sequential.body.translation().x
const sequentialVelocity = sequential.body.linvel().x
sequential.world.free()

const aggregated = createBody()
for (const step of steps) for (const impulse of step.impulses) {
  aggregated.body.applyImpulse({ x: impulse.impulse[0], y: impulse.impulse[1], z: impulse.impulse[2] }, true)
}
for (const _step of steps) aggregated.world.step()
const aggregatedX = aggregated.body.translation().x
const aggregatedVelocity = aggregated.body.linvel().x
aggregated.world.free()

export default { sequentialX, sequentialVelocity, aggregatedX, aggregatedVelocity }
`)
  try {
    await build({
      configFile: false,
      root: repositoryRoot,
      plugins: [rapierWasmIntegration()],
      build: {
        target: 'node24',
        outDir: outputDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry: entryPath, formats: ['es'] },
        rollupOptions: {
          output: { format: 'es', entryFileNames: 'world-rapier-node.mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
        },
      },
    })
    const executed = await import(`${pathToFileURL(path.join(outputDirectory, 'world-rapier-node.mjs')).href}?run=${Date.now()}`) as {
      default: { sequentialX: number; sequentialVelocity: number; aggregatedX: number; aggregatedVelocity: number }
    }
    assert.ok(executed.default.sequentialX > 0)
    assert.ok(executed.default.aggregatedX > executed.default.sequentialX)
    assert.ok(
      Math.abs(executed.default.aggregatedVelocity - executed.default.sequentialVelocity) < 1e-5,
      JSON.stringify(executed.default),
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('physics timing diagnostics preserve production Worker KCC sensors solid ground and platforms', { timeout: 30_000 }, async (t) => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../../..')
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'modly-world-rapier-sensor-'))
  const entryPath = path.join(temporaryRoot, 'entry.mjs')
  const outputDirectory = path.join(temporaryRoot, 'out')
  const sourceUrl = (relative: string) => pathToFileURL(path.join(repositoryRoot, relative)).href
  const body = (entityId: string, position: WorldPhysicsBodyDto['position'], shape: WorldPhysicsBodyDto['colliders'][number]['shape'], sensor = false): WorldPhysicsBodyDto => ({
    entityId, bodyType: 'fixed', position, rotation: [0, 0, 0, 1], gravityScale: 1,
    linearDamping: 0, angularDamping: 0, canSleep: false, tags: [],
    colliders: [{ componentId: `collider:${entityId}`, shape, sensor, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff, triggerComponentIds: sensor ? ['trigger:sensor'] : [] }],
  })
  // Match the native course's projected shapes; keep the Character kinematic and the sensor fixed.
  const character = body('entity:character', [0, 1, 0], { kind: 'capsule', radius: 0.35, halfHeight: 0.55 })
  character.bodyType = 'kinematic-position'
  character.tags = ['physics-character']
  character.controller = { componentId: 'controller:character', colliderComponentId: character.colliders[0].componentId, moveActionId: 'input:move', jumpActionId: 'input:jump', speed: 4, jumpSpeed: 6, maxSlopeRadians: Math.PI / 4 }
  const load = body('entity:load', [-5, 2, -3], { kind: 'sphere', radius: 0.25 })
  load.bodyType = 'dynamic'
  const scene: WorldPhysicsSceneDto = {
    sceneId: 'scene:sensor-query', gravity: [0, -9.81, 0], bodies: [
      body('entity:ground', [0, -0.5, 0], { kind: 'box', halfExtents: [10, 0.5, 6] }),
      character,
      body('entity:sensor', [1.2, 1, 0], { kind: 'box', halfExtents: [0.2, 1.5, 1] }, true),
      body('entity:platform', [3.25, 0.5, 0], { kind: 'box', halfExtents: [0.75, 0.5, 1] }),
      load,
    ],
  }
  try {
    // Only the message transport is local to Node. The imported Worker handler and all Rapier physics are real.
    await writeFile(entryPath, `
export async function run(scene) {
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
  const previousPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let clockCalls = 0
  let activeGeneration = 73
  let firstFourTransforms
  let unexpectedTimings = false
  let receive
  let reply
  let issue
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const timer = setTimeout(() => rejectReady(new Error('Production Worker readiness timed out.')), 3000)
  globalThis.self = {
    // Rapier's WASM reads self.performance; use the real platform object, not a synthetic clock.
    performance: globalThis.performance,
    addEventListener(kind, listener) { if (kind === 'message') receive = listener },
    postMessage(message, transfer) {
      if (message.kind === 'snapshot' && transfer?.[0] !== message.transforms) throw new Error('Transform transfer ownership changed.')
      reply = message
      if (message.kind === 'ready') resolveReady(message)
      if (message.kind === 'error') { issue = new Error(message.code + ': ' + message.message); rejectReady(issue) }
    },
  }
  const send = (message) => receive({ data: { version: 1, generationId: 73, ...message } })
  try {
    await import(${JSON.stringify(sourceUrl('src/areas/worlds/runtime/worldPhysics.worker.ts'))})
    send({ kind: 'init', scene })
    const initialized = await ready
    clearTimeout(timer)
    // Monotonic deterministic units test only; Rapier retains its real self.performance object.
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clockCalls++ } })
    const poses = []
    const triggerEvents = []
    for (let sequence = 1; sequence <= 151; sequence += 1) {
      reply = undefined
      send({ kind: 'step', sequence, steps: [{ characters: [{ entityId: 'entity:character', move: [sequence > 31 ? 1 : 0, 0], jumpPressed: false }], impulses: [{ entityId: 'entity:load', impulse: [0.0001, 0, 0] }] }] })
      if (issue) throw issue
      if (reply?.kind !== 'snapshot' || reply.generationId !== 73 || reply.sequence !== sequence) throw new Error('Missing matching production Worker snapshot.')
      unexpectedTimings ||= Object.hasOwn(reply, 'stepTimings')
      if (sequence === 4) firstFourTransforms = Array.from(new Float32Array(reply.transforms))
      const index = reply.entityIds.indexOf('entity:character')
      if (index < 0) throw new Error('Character body is absent from the production snapshot.')
      poses.push(Array.from(new Float32Array(reply.transforms).slice(index * 7, index * 7 + 3)))
      for (const event of reply.triggerEvents) {
        if (triggerEvents.length >= 16) throw new Error('Production trigger event observation bound exceeded.')
        triggerEvents.push({ sequence, event })
      }
    }
    const offClockCalls = clockCalls
    await new Promise(resolve => setTimeout(resolve, 0))
    activeGeneration = 74
    send({ kind: 'init', generationId: activeGeneration, scene, diagnostics: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    if (reply?.kind !== 'ready' || reply.generationId !== activeGeneration) throw new Error('Opt-in diagnostics initialization was rejected: ' + JSON.stringify(reply))
    clockCalls = 0
    const step = { characters: [{ entityId: 'entity:character', move: [0, 0], jumpPressed: false }], impulses: [{ entityId: 'entity:load', impulse: [0.0001, 0, 0] }] }
    send({ kind: 'step', generationId: activeGeneration, sequence: 0, steps: [step, step, step, step] })
    const measured = reply
    send({ kind: 'pause', generationId: activeGeneration }); reply = undefined
    send({ kind: 'step', generationId: activeGeneration, sequence: 1, steps: [step] })
    if (reply !== undefined) throw new Error('Paused Worker executed a diagnostic step.')
    send({ kind: 'resume', generationId: activeGeneration })
    send({ kind: 'step', generationId: activeGeneration, sequence: 9, steps: [step] })
    const resumed = reply
    const measuredClockCalls = clockCalls
    send({ kind: 'step', generationId: activeGeneration, sequence: 9, steps: [step] })
    const duplicateRejected = reply.kind === 'error' && clockCalls === measuredClockCalls
    send({ kind: 'step', generationId: activeGeneration, sequence: 10, steps: [step, step, step, step, step] })
    const oversizedRejected = reply.kind === 'error' && clockCalls === measuredClockCalls
    return { ready: initialized, poses, triggerEvents, unexpectedTimings, offClockCalls, measuredClockCalls, measured, resumed, firstFourTransforms, duplicateRejected, oversizedRejected }
  } finally {
    clearTimeout(timer)
    try { if (receive) send({ kind: 'dispose', generationId: activeGeneration }) }
    finally {
      if (previousPerformance) Object.defineProperty(globalThis, 'performance', previousPerformance)
      if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf)
      else delete globalThis.self
    }
  }
}
`)
    const { default: productionConfig } = await import(sourceUrl('electron.vite.config.ts'))
    assert.equal(typeof productionConfig.renderer?.worker?.plugins, 'function')
    await build({
      configFile: false, envFile: false, root: temporaryRoot, publicDir: false,
      cacheDir: path.join(temporaryRoot, 'vite-cache'), logLevel: 'warn',
      plugins: productionConfig.renderer.worker.plugins(),
      build: {
        target: 'node24', outDir: outputDirectory, emptyOutDir: false, minify: false,
        lib: { entry: entryPath, formats: ['es'] },
        rollupOptions: { output: { entryFileNames: 'worker-query-node.mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' } },
      },
    })
    const executed = await import(pathToFileURL(path.join(outputDirectory, 'worker-query-node.mjs')).href) as {
      run(scene: WorldPhysicsSceneDto): Promise<{ ready: { generationId: number; entityIds: string[] }; poses: number[][]; triggerEvents: { sequence: number; event: WorldPhysicsTriggerEvent }[];
        unexpectedTimings: boolean; offClockCalls: number; measuredClockCalls: number; measured: { stepTimings: unknown; transforms: ArrayBuffer }; resumed: { stepTimings: unknown };
        firstFourTransforms: number[]; duplicateRejected: boolean; oversizedRejected: boolean }>
    }
    const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
    const result = await executed.run(scene)
    assert.equal(result.unexpectedTimings, false)
    assert.equal(result.offClockCalls, 0)
    assert.equal(result.measuredClockCalls, 20)
    assert.deepEqual(result.measured.stepTimings, Array.from({ length: 4 }, (_, substep) => ({ substep, solverMs: 1, physicsStepMs: 3 })))
    assert.deepEqual(result.resumed.stepTimings, [{ substep: 0, solverMs: 1, physicsStepMs: 3 }])
    assert.deepEqual(Array.from(new Float32Array(result.measured.transforms)), result.firstFourTransforms, 'Opt-in timing must not alter impulse/KCC/solver ordering.')
    assert.equal(result.duplicateRejected && result.oversizedRejected, true)
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'self'), previousSelf, 'The test-local message scope must be restored.')
    const finalPose = result.poses.at(-1)!
    const evidence = JSON.stringify({ finalPose, acknowledgedSteps: result.poses.length })
    assert.equal(result.ready.generationId, 73)
    assert.deepEqual(result.ready.entityIds, scene.bodies.map(item => item.entityId))
    assert.equal(result.poses.length, 151)
    assert.ok(result.poses[30][1] > 0.89 && result.poses[30][1] < 0.93, 'The solid ground must support the capsule.')
    assert.ok(finalPose[0] > 1.9, `Character must cross the fixed sensor: ${evidence}`)
    assert.ok(finalPose[0] > 2.1 && finalPose[0] < 2.16, `The raised solid platform must still block walking: ${evidence}`)
    assert.ok(Math.abs(finalPose[0] - result.poses[120][0]) < 0.01, 'Continued input must not pass through the platform.')
    assert.ok(finalPose[1] > 0.89 && finalPose[1] < 0.93, 'Sensor filtering must not filter out solid ground.')
    t.diagnostic(`Real production Worker regression: ${evidence}`)
    assert.deepEqual(result.triggerEvents.map(frame => frame.event), [
      { type: 'enter', triggerComponentId: 'trigger:sensor', otherEntityId: 'entity:character', otherTags: ['physics-character'] },
      { type: 'exit', triggerComponentId: 'trigger:sensor', otherEntityId: 'entity:character', otherTags: ['physics-character'] },
    ], 'The fixed sensor must emit Character enter then exit with authored tags, not events for its overlapping fixed ground.')
    assert.ok(result.triggerEvents[0].sequence < result.triggerEvents[1].sequence, 'Enter and exit must arrive in their distinct acknowledged fixed steps.')
    t.diagnostic(`Real production Worker events: ${JSON.stringify(result.triggerEvents)}`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('production Worker maps bounded convexHull and fixed trimesh geometry to real Rapier colliders', { timeout: 30_000 }, async (t) => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../../..')
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'modly-world-rapier-advanced-'))
  const entryPath = path.join(temporaryRoot, 'entry.mjs')
  const outputDirectory = path.join(temporaryRoot, 'out')
  const sourceUrl = (relative: string) => pathToFileURL(path.join(repositoryRoot, relative)).href
  const body = (
    entityId: string,
    bodyType: WorldPhysicsBodyDto['bodyType'],
    position: WorldPhysicsBodyDto['position'],
    shape: WorldPhysicsBodyDto['colliders'][number]['shape'],
    sensor = false,
  ): WorldPhysicsBodyDto => ({
    entityId,
    bodyType,
    position,
    rotation: [0, 0, 0, 1],
    gravityScale: 1,
    linearDamping: 0,
    angularDamping: 0,
    canSleep: false,
    tags: sensor ? ['sensor'] : [],
    colliders: [{
      componentId: `collider:${entityId}`,
      shape,
      sensor,
      friction: 0.5,
      restitution: 0,
      collisionLayer: 1,
      collisionMask: 0xffff,
      triggerComponentIds: sensor ? [`trigger:${entityId}`] : [],
    }],
  })
  const cubeHullVertices = new Float32Array([
    -0.5, -0.5, -0.5,
    0.5, -0.5, -0.5,
    0.5, 0.5, -0.5,
    -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5,
    0.5, -0.5, 0.5,
    0.5, 0.5, 0.5,
    -0.5, 0.5, 0.5,
  ])
  const floorVertices = new Float32Array([
    -5, 0, -5,
    5, 0, -5,
    5, 0, 5,
    -5, 0, 5,
  ])
  const floorIndices = new Uint32Array([0, 1, 2, 0, 2, 3])
  const scene: WorldPhysicsSceneDto = {
    sceneId: 'scene:advanced-geometry',
    gravity: [0, -9.81, 0],
    bodies: [
      body('entity:floor', 'fixed', [0, 0, 0], { kind: 'trimesh', vertices: floorVertices, indices: floorIndices }),
      body('entity:hull', 'dynamic', [-1, 3, 0], { kind: 'convexHull', vertices: cubeHullVertices }),
      body('entity:sphere', 'dynamic', [1, 3, 0], { kind: 'sphere', radius: 0.5 }),
      body('entity:sensor', 'fixed', [1, 0.6, 0], { kind: 'box', halfExtents: [0.75, 0.1, 0.75] }, true),
    ],
  }
  try {
    await writeFile(entryPath, `
export async function run(scene) {
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
  let receive
  const replies = []
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const timer = setTimeout(() => rejectReady(new Error('Production Worker advanced-geometry readiness timed out.')), 3000)
  globalThis.self = {
    performance: globalThis.performance,
    addEventListener(kind, listener) { if (kind === 'message') receive = listener },
    postMessage(message) {
      replies.push(message)
      if (message.kind === 'ready') resolveReady(message)
      if (message.kind === 'error') rejectReady(new Error(message.code + ': ' + message.message))
    },
  }
  const send = (message) => receive({ data: { version: 1, generationId: 91, ...message } })
  try {
    await import(${JSON.stringify(sourceUrl('src/areas/worlds/runtime/worldPhysics.worker.ts'))})
    send({ kind: 'init', scene })
    const initialized = await ready
    clearTimeout(timer)
    let finalSnapshot
    const triggerEvents = []
    for (let sequence = 1; sequence <= 180; sequence += 1) {
      send({ kind: 'step', sequence, steps: [{ characters: [], impulses: [] }] })
      const snapshot = replies.at(-1)
      if (snapshot?.kind !== 'snapshot' || snapshot.sequence !== sequence) throw new Error('Missing advanced-geometry snapshot.')
      finalSnapshot = snapshot
      for (const event of snapshot.triggerEvents) triggerEvents.push({ sequence, event })
    }
    const positions = {}
    const transforms = new Float32Array(finalSnapshot.transforms)
    for (const [index, entityId] of finalSnapshot.entityIds.entries()) positions[entityId] = Array.from(transforms.slice(index * 7, index * 7 + 3))
    return { ready: initialized, positions, triggerEvents }
  } finally {
    clearTimeout(timer)
    try { if (receive) send({ kind: 'dispose' }) }
    finally {
      if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf)
      else delete globalThis.self
    }
  }
}
`)
    const { default: productionConfig } = await import(sourceUrl('electron.vite.config.ts'))
    assert.equal(typeof productionConfig.renderer?.worker?.plugins, 'function')
    await build({
      configFile: false,
      envFile: false,
      root: temporaryRoot,
      publicDir: false,
      cacheDir: path.join(temporaryRoot, 'vite-cache'),
      logLevel: 'warn',
      plugins: productionConfig.renderer.worker.plugins(),
      build: {
        target: 'node24',
        outDir: outputDirectory,
        emptyOutDir: false,
        minify: false,
        lib: { entry: entryPath, formats: ['es'] },
        rollupOptions: { output: { entryFileNames: 'worker-advanced-node.mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' } },
      },
    })
    const executed = await import(pathToFileURL(path.join(outputDirectory, 'worker-advanced-node.mjs')).href) as {
      run(scene: WorldPhysicsSceneDto): Promise<{ ready: { generationId: number; entityIds: string[] }; positions: Record<string, number[]>; triggerEvents: { sequence: number; event: WorldPhysicsTriggerEvent }[] }>
    }
    const result = await executed.run(scene)
    const evidence = JSON.stringify(result.positions)
    assert.deepEqual(result.ready.entityIds, scene.bodies.map(item => item.entityId))
    assert.ok(result.positions['entity:hull'][1] > 0.45 && result.positions['entity:hull'][1] < 0.57, `Convex hull must settle on fixed trimesh floor: ${evidence}`)
    assert.ok(result.positions['entity:sphere'][1] > 0.45 && result.positions['entity:sphere'][1] < 0.57, `Primitive sphere compatibility must settle on the same fixed trimesh floor: ${evidence}`)
    assert.ok(result.triggerEvents.some(frame => frame.event.triggerComponentId === 'trigger:entity:sensor' && frame.event.otherEntityId === 'entity:sphere'), 'Existing sensor/event contracts must still work with the advanced scene.')
    t.diagnostic(`Real production Worker advanced geometry: ${JSON.stringify({ positions: result.positions, triggerEvents: result.triggerEvents.slice(0, 4) })}`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('production Worker rejects invalid advanced geometry without false ready and accepts a later valid scene', { timeout: 30_000 }, async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../../..')
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'modly-world-rapier-invalid-'))
  const entryPath = path.join(temporaryRoot, 'entry.mjs')
  const outputDirectory = path.join(temporaryRoot, 'out')
  const sourceUrl = (relative: string) => pathToFileURL(path.join(repositoryRoot, relative)).href
  const fixedBody = (entityId: string, shape: WorldPhysicsBodyDto['colliders'][number]['shape']): WorldPhysicsBodyDto => ({
    entityId,
    bodyType: 'fixed',
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    gravityScale: 1,
    linearDamping: 0,
    angularDamping: 0,
    canSleep: false,
    tags: [],
    colliders: [{
      componentId: `collider:${entityId}`,
      shape,
      sensor: false,
      friction: 0.5,
      restitution: 0,
      collisionLayer: 1,
      collisionMask: 0xffff,
      triggerComponentIds: [],
    }],
  })
  const invalidScene: WorldPhysicsSceneDto = {
    sceneId: 'scene:invalid-coplanar',
    gravity: [0, -9.81, 0],
    bodies: [fixedBody('entity:coplanar', { kind: 'convexHull', vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]) })],
  }
  const validScene: WorldPhysicsSceneDto = {
    sceneId: 'scene:valid-after-invalid',
    gravity: [0, -9.81, 0],
    bodies: [fixedBody('entity:floor', { kind: 'box', halfExtents: [1, 0.1, 1] })],
  }
  try {
    await writeFile(entryPath, `
export async function run(invalidScene, validScene) {
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
  let receive
  const replies = []
  globalThis.self = {
    performance: globalThis.performance,
    addEventListener(kind, listener) { if (kind === 'message') receive = listener },
    postMessage(message) { replies.push(message) },
  }
  const send = (generationId, message) => receive({ data: { version: 1, generationId, ...message } })
  try {
    await import(${JSON.stringify(sourceUrl('src/areas/worlds/runtime/worldPhysics.worker.ts'))})
    send(101, { kind: 'init', scene: invalidScene })
    await new Promise(resolve => setTimeout(resolve, 0))
    send(102, { kind: 'init', scene: validScene })
    const deadline = Date.now() + 3000
    while (!replies.some(message => message.kind === 'ready' && message.generationId === 102)) {
      if (Date.now() > deadline) throw new Error('Valid init after invalid advanced geometry timed out.')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return replies.map(message => ({ kind: message.kind, generationId: message.generationId, code: message.code }))
  } finally {
    try { if (receive) send(102, { kind: 'dispose' }) }
    finally {
      if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf)
      else delete globalThis.self
    }
  }
}
`)
    const { default: productionConfig } = await import(sourceUrl('electron.vite.config.ts'))
    await build({
      configFile: false,
      envFile: false,
      root: temporaryRoot,
      publicDir: false,
      cacheDir: path.join(temporaryRoot, 'vite-cache'),
      logLevel: 'warn',
      plugins: productionConfig.renderer.worker.plugins(),
      build: {
        target: 'node24',
        outDir: outputDirectory,
        emptyOutDir: false,
        minify: false,
        lib: { entry: entryPath, formats: ['es'] },
        rollupOptions: { output: { entryFileNames: 'worker-invalid-node.mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' } },
      },
    })
    const executed = await import(pathToFileURL(path.join(outputDirectory, 'worker-invalid-node.mjs')).href) as {
      run(invalidScene: WorldPhysicsSceneDto, validScene: WorldPhysicsSceneDto): Promise<Array<{ kind: string; generationId: number; code?: string }>>
    }
    const messages = await executed.run(invalidScene, validScene)
    assert.deepEqual(messages.filter(message => message.code === 'invalid-main-message').map(message => message.kind), ['error'])
    assert.equal(messages.some(message => message.kind === 'ready' && message.generationId === 101), false)
    assert.equal(messages.some(message => message.kind === 'ready' && message.generationId === 102), true)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('production Worker navigation probe uses frozen mixed solids, sided surfaces, groups and overlap recovery', { timeout: 30_000 }, async (t) => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../../..')
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'modly-world-navigation-'))
  const outputDirectory = path.join(temporaryRoot, 'out')
  const entryPath = path.join(temporaryRoot, 'entry.mjs')
  const sourceUrl = (relative: string) => pathToFileURL(path.join(repositoryRoot, relative)).href
  await writeFile(entryPath, `
export async function run() {
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')
  let receive, resolveReady, rejectReady, last
  let generationId = 0
  globalThis.self = {
    performance: globalThis.performance,
    addEventListener(kind, listener) { if (kind === 'message') receive = listener },
    postMessage(message) {
      last = message
      if (message.kind === 'ready') resolveReady(message)
      if (message.kind === 'error') rejectReady(new Error('generation '+generationId+' '+message.code + ': ' + message.message))
    },
  }
  const send = message => receive({ data: { version: 1, generationId, ...message } })
  const solid = (id, position, shape, extra = {}) => ({ entityId: id, bodyType: 'fixed', position, rotation: [0,0,0,1], gravityScale: 0, linearDamping: 0, angularDamping: 0, canSleep: true, tags: [], colliders: [{componentId: id, shape, sensor: false, friction: .5, restitution: 0, collisionLayer: 1, collisionMask: 65535, triggerComponentIds: [], ...extra}] })
  const floor = solid('floor', [0,-.5,0], {kind:'box',halfExtents:[20,.5,20]})
  const plane = (id, double = false) => solid(id, [0,0,0], {kind:'trimesh', vertices:new Float32Array([-10,-10,0, 10,-10,0, 10,10,0, -10,10,0]), indices:new Uint32Array([0,1,2,0,2,3])})
  async function scenario(bodies, position, steps, frontSurfaces = [], play = false, trace = false) {
    generationId++
    const ready = new Promise((resolve,reject) => { resolveReady=resolve; rejectReady=reject })
    const timer = setTimeout(() => rejectReady(new Error('Navigation Worker readiness timed out')), 3000)
    if (play) {
      const hero = solid('hero',position,{kind:'capsule',radius:.3,halfHeight:.6})
      hero.bodyType='kinematic-position'
      hero.controller={componentId:'controller',colliderComponentId:'hero',moveActionId:'move',jumpActionId:'jump',speed:3,jumpSpeed:4.4,maxSlopeRadians:Math.PI/4}
      bodies=[...bodies,hero]
    }
    send({kind:'init',scene:{sceneId:'navigation',gravity:[0,-9.81,0],bodies},...(!play ? {navigation:{position,frontSurfaces}} : {})})
    try { await ready } finally { clearTimeout(timer) }
    await Promise.resolve()
    const initialY = position[1] + (play ? .75 : 0)
    const poses = []
    let maxY = initialY, previousY = initialY, plateau = 0, maxAirbornePlateauTicks = 0, cameraPose
    for (let i=0;i<steps.length;i++) {
      if (play) {
        send({kind:'step',sequence:i,steps:[{characters:[{entityId:'hero',move:[steps[i].move[0],-steps[i].move[1]],jumpPressed:steps[i].jumpPressed}],impulses:[]}]})
        if(last.kind !== 'snapshot' || last.sequence !== i) throw new Error('Missing Play character snapshot')
        const values = new Float32Array(last.transforms), offset=last.entityIds.indexOf('hero')*7
        cameraPose={position:[values[offset],values[offset+1]+.75,values[offset+2]]}
      } else {
        send({kind:'navigation-step',sequence:i,steps:[steps[i]]})
        if(last.kind !== 'navigation-pose' || last.sequence !== i) throw new Error('Missing camera-only pose: '+JSON.stringify(last))
        cameraPose=last
      }
      if (trace) poses.push({position: [...cameraPose.position], grounded: cameraPose.grounded, recovered: cameraPose.recovered})
      const y=cameraPose.position[1]
      maxY=Math.max(maxY,y)
      plateau=y > initialY+.1 && Math.abs(y-previousY)<.0002 ? plateau+1 : 0
      maxAirbornePlateauTicks=Math.max(maxAirbornePlateauTicks,plateau)
      previousY=y
    }
    const result={...cameraPose,maxY,maxAirbornePlateauTicks,...(trace ? {poses} : {})}
    send({kind:'dispose'})
    return result
  }
  const input = (move=[0,0], jumpPressed=false, boost=false) => ({move,jumpPressed,boost})
  try {
    await import(${JSON.stringify(sourceUrl('src/areas/worlds/runtime/worldPhysics.worker.ts'))})
    const results={}
    results.wall=await scenario([floor, solid('wall',[0,2,0],{kind:'box',halfExtents:[4,2,.1]})], [0,2,3], Array.from({length:180},()=>input([0,-1])))
    results.slide=await scenario([floor, solid('wall',[0,2,0],{kind:'box',halfExtents:[10,2,.1]})], [0,2,3], Array.from({length:180},()=>input([Math.SQRT1_2,-Math.SQRT1_2])))
    results.filtered=await scenario([floor, solid('sensor',[0,2,1],{kind:'box',halfExtents:[4,2,.1]},{sensor:true}), solid('masked',[0,2,0],{kind:'box',halfExtents:[4,2,.1]},{collisionMask:2})], [0,2,3], Array.from({length:120},()=>input([0,-1])))
    const front=[{componentId:'plane', point:[0,0,0], normal:[0,0,1]}]
    results.front=await scenario([floor,plane('plane')], [0,2,3], Array.from({length:120},()=>input([0,-1])),front)
    results.back=await scenario([floor,plane('plane')], [0,2,-3], Array.from({length:120},()=>input([0,1])),front)
    results.double=await scenario([floor,plane('plane')], [0,2,-3], Array.from({length:120},()=>input([0,1])))
    // Both footprints lie on y = z / 2, with the authored front facing upward.
    const slopeNormal=[0, 2/Math.sqrt(5), -1/Math.sqrt(5)]
    const slopeFront=[{componentId:'slope', point:[0,0,0], normal:slopeNormal}]
    const slopeEyeHeight=z=>z/2+.75+.6+(.3+.01)/slopeNormal[1]
    const underFloor=solid('under-floor',[0,-2.5,0],{kind:'box',halfExtents:[20,.5,20]})
    results.underFloor=await scenario([underFloor],[0,-.34,3],Array.from({length:180},()=>input([0,-1])),[],false,true)
    for (const [name,vertices,indices] of [
      ['rect', [-10,-5,-10, -10,5,10, 10,5,10, 10,-5,-10], [0,1,2,0,2,3]],
      ['tri', [-10,-5,-10, 0,5,10, 10,-5,-10], [0,1,2]],
    ]) {
      const slope=solid('slope',[0,0,0],{kind:'trimesh',vertices:new Float32Array(vertices),indices:new Uint32Array(indices)})
      results[name+'Downhill']=await scenario([slope],[0,slopeEyeHeight(3),3],Array.from({length:100},(_,i)=>input([0,i<10?0:-1])),slopeFront,false,true)
      results[name+'Uphill']=await scenario([slope],[0,slopeEyeHeight(-3),-3],Array.from({length:100},(_,i)=>input([0,i<10?0:1])),slopeFront,false,true)
      results[name+'Stop']=await scenario([slope],[0,slopeEyeHeight(3),3],Array.from({length:160},(_,i)=>input([0,i>=10&&i<100?-1:0])),slopeFront,false,true)
      results[name+'Jump']=await scenario([slope],[0,slopeEyeHeight(3),3],Array.from({length:180},(_,i)=>input([0,i<10||i>=120?0:-1],i===60)),slopeFront,false,true)
      results[name+'Back']=await scenario([slope,underFloor],[0,-.34,3],Array.from({length:180},()=>input([0,-1])),slopeFront,false,true)
    }
    results.overlap=await scenario([floor,solid('wall',[0,2,0],{kind:'box',halfExtents:[4,2,.1]})],[0,.7,.2],Array.from({length:60},()=>input()))
    results.jump=await scenario([floor],[0,2,3],Array.from({length:150},(_,i)=>input([0,0],i===90)))
    results.initialJump=await scenario([floor],[0,1.66,3],Array.from({length:60},(_,i)=>input([0,0],i===0)))
    const ceiling=solid('ceiling',[0,2.3,0],{kind:'box',halfExtents:[10,.1,10]})
    results.lowCeiling=await scenario([floor,ceiling],[0,1.66,0],Array.from({length:100},(_,i)=>input([0,0],i===30)))
    results.playLowCeiling=await scenario([floor,ceiling],[0,.91,0],Array.from({length:100},(_,i)=>input([0,0],i===30)),[],true)
    results.boost=await scenario([floor],[0,2,3],Array.from({length:60},()=>input([1,0],false,true)))
    const hull={kind:'convexHull',vertices:new Float32Array([-2,0,-.2,2,0,-.2,2,4,-.2,-2,4,-.2,-2,0,.2,2,0,.2,2,4,.2,-2,4,.2])}
    const mesh={kind:'trimesh',vertices:new Float32Array([-10,0,-10,10,0,-10,10,0,10,-10,0,10]),indices:new Uint32Array([0,1,2,0,2,3])}
    results.advanced=await scenario([solid('mesh',[0,0,0],mesh),solid('hull',[0,0,0],hull)], [0,2,3], Array.from({length:150},()=>input([0,-1])))
    for(const [name,shape] of [['sphere',{kind:'sphere',radius:2}],['capsule',{kind:'capsule',radius:1,halfHeight:2}]]) results[name]=await scenario([floor,solid(name,[0,1,0],shape)],[0,2,4],Array.from({length:150},()=>input([0,-1])))
    return results
  } finally { send({kind:'dispose'}); if(previousSelf) Object.defineProperty(globalThis,'self',previousSelf); else delete globalThis.self }
}
`)
  try {
    const { default: productionConfig } = await import(sourceUrl('electron.vite.config.ts'))
    await build({ configFile: false, envFile: false, root: temporaryRoot, publicDir: false, cacheDir: path.join(temporaryRoot, 'cache'), logLevel: 'warn', plugins: productionConfig.renderer.worker.plugins(), build: { target: 'node24', outDir: outputDirectory, emptyOutDir: false, minify: false, lib: { entry: entryPath, formats: ['es'] }, rollupOptions: { output: { entryFileNames: 'navigation.mjs' } } } })
    const executed = await import(pathToFileURL(path.join(outputDirectory, 'navigation.mjs')).href)
    const result = await executed.run()
    t.diagnostic(JSON.stringify(result, (key, value) => key === 'poses' ? undefined : value))
    for (const name of ['wall', 'front', 'advanced']) {
      assert.ok(result[name].position[2] > .29 && result[name].position[2] < .65, name)
      assert.ok(result[name].position[1] > 1.64 && result[name].position[1] < 1.71, name)
      assert.equal(result[name].grounded, true)
      assert.equal(result[name].transforms, undefined)
      assert.equal(result[name].triggerEvents, undefined)
    }
    assert.ok(result.slide.position[0] > 5 && result.slide.position[2] > .39)
    assert.ok(result.filtered.position[2] < -2.5)
    assert.ok(result.back.position[2] > 2.5)
    assert.ok(result.double.position[2] < -.29 && result.double.position[2] > -.4)
    assert.ok(result.overlap.position[1] > 1.64 && result.overlap.position[2] > .39)
    assert.ok(result.jump.maxY > 2.4)
    assert.ok(result.initialJump.maxY > 2.4, 'Space on the first grounded Run tick must not be lost during initialization')
    for (const name of ['lowCeiling','playLowCeiling']) {
      assert.ok(result[name].maxY > 1.9 && result[name].maxY < 2.06, name+' must jump and contact the low ceiling')
      assert.ok(result[name].maxAirbornePlateauTicks <= 2, name+' must fall promptly after ceiling contact, not hang: '+result[name].maxAirbornePlateauTicks)
    }
    assert.ok(result.boost.position[0] > 5.85 && result.boost.position[0] < 6.1)
    assert.ok(result.sphere.position[2] > 1.8)
    assert.ok(result.capsule.position[2] > 1.2)
    const clearance = (position: number[]) => (position[1] - .75 - position[2] / 2) * 2 / Math.sqrt(5) - (.6 * 2 / Math.sqrt(5) + .3)
    for (const shape of ['rect', 'tri']) {
      for (const action of ['Downhill', 'Uphill', 'Stop']) {
        const name = shape + action
        const poses = result[name].poses as Array<{ position: number[]; grounded: boolean; recovered: boolean }>
        const gaps = poses.map(pose => clearance(pose.position))
        t.diagnostic(JSON.stringify({ name, airborneTicks: poses.filter(pose => !pose.grounded).length, minClearance: Math.min(...gaps), maxClearance: Math.max(...gaps) }))
        for (const [tick, pose] of poses.entries()) {
          assert.equal(pose.grounded, true, name + ' must retain support at tick ' + tick)
          assert.equal(pose.recovered, false, name + ' must not fall back to last-safe')
          assert.ok(gaps[tick] >= -.002 && gaps[tick] <= .025, name + ' capsule-to-plane clearance at tick ' + tick + ': ' + gaps[tick])
        }
        const z = poses.at(-1)!.position[2]
        assert.ok(action === 'Uphill' ? z > .4 : z < -1.3, name + ' must travel along the ramp')
        if (action === 'Stop') {
          const stopped = poses.slice(100)
          for (const pose of stopped) assert.ok(Math.hypot(...pose.position.map((value, axis) => value - stopped[0].position[axis])) < .01, name + ' must not drift after input stops')
        }
      }
      const jump = result[shape + 'Jump'].poses as Array<{ position: number[]; grounded: boolean; recovered: boolean }>
      t.diagnostic(JSON.stringify({ name: shape + 'Jump', groundedBeforeJump: jump[59].grounded, jumpRise: jump[60].position[1] - jump[59].position[1], maxClearance: Math.max(...jump.map(pose => clearance(pose.position))) }))
      assert.equal(jump[59].grounded, true, shape + ' must support the downhill jump edge')
      assert.equal(jump[60].grounded, false, shape + ' must leave the slope when jumping')
      assert.ok(jump[60].position[1] > jump[59].position[1] + .05, shape + ' must apply the jump immediately')
      assert.ok(Math.max(...jump.map(pose => clearance(pose.position))) > .8, shape + ' jump must clear the slope, not snap back')
      assert.ok(jump.every(pose => !pose.recovered && clearance(pose.position) >= -.002), shape + ' jump must not penetrate or recover')
      for (const pose of jump.slice(150)) {
        assert.equal(pose.grounded, true, shape + ' must land and remain supported')
        assert.ok(clearance(pose.position) <= .025, shape + ' landing must restore capsule clearance')
      }
      const back = result[shape + 'Back'].poses as Array<{ position: number[]; grounded: boolean; recovered: boolean }>
      for (const [tick, pose] of back.entries()) {
        assert.equal(pose.grounded, true, shape + ' back-to-front passage must retain the lower floor')
        assert.equal(pose.recovered, false)
        assert.ok(Math.abs(pose.position[1] + .34) < .025, shape + ' back-to-front passage must not lift onto the ramp')
        assert.ok(Math.abs(pose.position[2] - result.underFloor.poses[tick].position[2]) < .01, shape + ' back-to-front passage must match the unobstructed floor at tick ' + tick)
      }
      assert.ok(clearance(back[0].position) < -.9 && clearance(back.at(-1)!.position) > .5, shape + ' must cross from behind until the whole capsule clears the front')
    }
  } finally { await rm(temporaryRoot, { recursive: true, force: true }) }
})
