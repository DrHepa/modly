import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntimeWorldSnapshot } from '../runtime/_testFixtures.ts'
import type { WorldPhysicsRuntimeHandlers } from '../runtime/worldPhysicsRuntime.ts'
import type { WorldPhysicsNavigationStep, WorldPhysicsSceneDto, WorldPhysicsNavigationInit } from '../runtime/worldPhysicsProtocol.ts'
import type { WorldPreparedGeometrySource } from '../runtime/worldGeometryPreparation.ts'
import { WorldEditorRunSession, type WorldEditorRunDependencies } from './worldEditorRunSession.ts'

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function harness() {
  let current = true
  let handlers: WorldPhysicsRuntimeHandlers
  let disposed = false
  let disposeCount = 0
  let initializeResolve: (() => void) | undefined
  const requests: { sequence: number; steps: WorldPhysicsNavigationStep[] }[] = []
  const inits: { scene: WorldPhysicsSceneDto; navigation?: WorldPhysicsNavigationInit }[] = []
  const timers = new Set<() => void>()
  const snapshot = createRuntimeWorldSnapshot()
  const input = { snapshot, sceneId: 'scene:one', apiUrl: 'http://127.0.0.1:8000', isCurrent: () => current }
  const dependencies: WorldEditorRunDependencies = {
    loadModelGeometry: async () => { throw new Error('Unexpected model request.') },
    scheduleTimeout: callback => { timers.add(callback); return () => timers.delete(callback) },
    createPhysics: (_generation, nextHandlers) => {
      handlers = nextHandlers
      return {
        initialize: (scene, navigation) => { inits.push({ scene, navigation }); return new Promise<void>(resolve => { initializeResolve = resolve }) },
        stepNavigation: (sequence, steps) => { requests.push({ sequence, steps }); return true },
        dispose: () => { if (!disposed) { disposed = true; disposeCount++ } },
      }
    },
  }
  return { input, dependencies, requests, inits, timers, disposeCount: () => disposeCount,
    ready: () => initializeResolve?.(), revoke: () => { current = false }, handlers: () => handlers }
}

test('Run session freezes until ready, queues at most one request and four latest-input recovery ticks', async () => {
  const h = harness()
  const before = structuredClone(h.input.snapshot)
  const session = new WorldEditorRunSession(h.input, [0, 3, 6], h.dependencies)
  session.advance(1, 0, { forward: true })
  assert.equal(h.requests.length, 0)
  await flush()
  assert.deepEqual(h.inits[0].navigation?.position, [0, 3, 6])
  assert.ok(h.inits[0].scene.bodies.every(body => body.bodyType === 'fixed' && !body.controller))
  h.ready(); await flush()
  assert.equal(session.status, 'ready')
  session.advance(1 / 120, 0, { forward: true })
  assert.equal(h.requests.length, 0)
  session.advance(1 / 120, 0, { forward: true })
  assert.equal(h.requests.length, 1)
  for (let i = 0; i < 100; i++) session.advance(1, 0, { forward: true })
  assert.equal(h.requests.length, 1)
  h.handlers().onNavigationPose?.({ sequence: 1, position: [0, 2, 5], grounded: true, recovered: false })
  const pose = session.advance(1 / 60, Math.PI / 2, { forward: true, boost: true, jump: true })
  assert.deepEqual(pose?.position, [0, 2, 5])
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].steps.length, 4)
  assert.ok(Math.abs(h.requests[1].steps[0].move[0] + 1) < 1e-8)
  assert.ok(Math.abs(h.requests[1].steps[0].move[1]) < 1e-8)
  assert.deepEqual(h.requests[1].steps.map(step => step.jumpPressed), [true, false, false, false])
  assert.ok(h.requests[1].steps.every(step => step.boost))
  assert.deepEqual(h.input.snapshot, before)
  session.dispose()
  assert.equal(h.disposeCount(), 1)
  assert.equal(h.timers.size, 0)
})

test('Run cancellation rejects late initialization/pose after pointer release, revision or Play lease revocation', async () => {
  for (const revoke of [false, true]) {
    const h = harness()
    const session = new WorldEditorRunSession(h.input, [0, 3, 6], h.dependencies)
    await flush()
    if (revoke) { h.revoke(); session.advance(1, 0, {}) } else session.dispose()
    h.ready(); await flush()
    h.handlers().onNavigationPose?.({ sequence: 1, position: [99, 99, 99], grounded: true, recovered: false })
    assert.equal(session.advance(1, 0, { forward: true }), null)
    assert.equal(session.status, 'disposed')
    assert.equal(h.requests.length, 0)
    assert.equal(h.disposeCount(), 1)
    assert.equal(h.timers.size, 0)
  }
})

test('Run empty fallback is distinct from Worker failure and preparation timeout', async () => {
  const empty = harness()
  empty.input.sceneId = 'scene:two'
  const fallback = new WorldEditorRunSession(empty.input, [0, 3, 6], empty.dependencies)
  assert.equal(fallback.status, 'empty')
  assert.equal(empty.inits.length, 0)
  fallback.dispose()
  for (const timeout of [false, true]) {
    const h = harness()
    const session = new WorldEditorRunSession(h.input, [0, 3, 6], h.dependencies)
    await flush()
    if (timeout) for (const callback of h.timers) callback()
    else h.handlers().onError?.({ code: 'worker-failed', message: 'Worker failed.' })
    h.ready(); await flush()
    assert.equal(session.status, 'failed')
    assert.equal(session.advance(1, 0, { forward: true }), null)
    assert.equal(h.disposeCount(), 1)
    assert.equal(h.timers.size, 0)
  }
})

test('Run aborts bounded shared geometry preparation and never creates a Worker from stale geometry', async () => {
  const h = harness()
  const floor = h.input.snapshot.scenes[0].entities[3].components[0]
  h.input.snapshot.scenes[0].entities[3].components[0] = { id: floor.id, enabled: true, type: 'collider', purpose: 'simulation', shape: 'mesh', resourceId: 'resource:hero', sensor: false, friction: .5, restitution: 0 }
  let signal: AbortSignal | undefined
  let finish!: (source: WorldPreparedGeometrySource) => void
  h.dependencies.loadModelGeometry = async (source, abort) => {
    assert.equal(source.url, 'http://127.0.0.1:8000/workspace/Assets/hero.glb')
    signal = abort
    return new Promise(resolve => { finish = resolve })
  }
  const session = new WorldEditorRunSession(h.input, [0, 3, 6], h.dependencies)
  await flush()
  assert.ok(signal)
  session.dispose()
  assert.equal(signal.aborted, true)
  finish({ success: false, resourceId: 'resource:hero', code: 'cancelled', message: 'Cancelled.' })
  await flush()
  assert.equal(session.status, 'disposed')
  assert.equal(h.inits.length, 0)
  assert.equal(h.timers.size, 0)
})
