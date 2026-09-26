import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimeWorldSnapshot } from './_testFixtures.ts'
import { projectWorldRuntimeScene } from './worldRuntimeProjection.ts'
import { WorldPhysicsWorkerRuntime, type WorldPhysicsSnapshot, type WorldPhysicsWorkerEventLike, type WorldPhysicsWorkerLike } from './worldPhysicsRuntime.ts'
import { WORLD_PHYSICS_PROTOCOL_VERSION } from './worldPhysicsProtocol.ts'

class FakeWorker implements WorldPhysicsWorkerLike {
  messages: unknown[] = []
  terminated = false
  terminateCount = 0
  throwOnPost: Error | null = null
  private readonly listeners = new Map<string, Set<(event: WorldPhysicsWorkerEventLike) => void>>()
  postMessage(message: unknown): void {
    if (this.throwOnPost) throw this.throwOnPost
    this.messages.push(message)
  }
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: WorldPhysicsWorkerEventLike) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: WorldPhysicsWorkerEventLike) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  terminate(): void { this.terminated = true; this.terminateCount += 1 }
  listenerCount(): number { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0) }
  emit(data: unknown): void { this.dispatch('message', { data }) }
  emitError(message: string): void { this.dispatch('error', { message }) }
  emitMessageError(): void { this.dispatch('messageerror', { data: null }) }
  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as WorldPhysicsWorkerEventLike)
  }
}

async function timingRuntime(diagnostics = true, generationId = 7, beforeReady?: (runtime: WorldPhysicsWorkerRuntime) => void) {
  const fake = new FakeWorker()
  const snapshots: WorldPhysicsSnapshot[] = []
  const issues: string[] = []
  let cancelledTimers = 0
  const runtime = new WorldPhysicsWorkerRuntime({ generationId, worker: fake, diagnostics: diagnostics ? true : undefined,
    onSnapshot: snapshot => snapshots.push(snapshot), onTriggerEvents: () => undefined, onError: issue => issues.push(issue.code),
    scheduleTimeout: () => () => { cancelledTimers += 1 } })
  beforeReady?.(runtime)
  const ready = runtime.initialize({ sceneId: 'scene:timings', gravity: [0, 0, 0], bodies: [] })
  beforeReady?.(runtime)
  fake.emit({ version: 1, kind: 'ready', generationId, entityIds: [] })
  await ready
  const step = (sequence: number, count = 1) => runtime.step({ sequence, steps: Array.from({ length: count }, () => ({ characters: [], impulses: [] })) })
  const snapshot = (sequence: number, count = 1) => ({ version: 1, kind: 'snapshot', generationId, sequence, entityIds: [], transforms: new ArrayBuffer(0), triggerEvents: [],
    stepTimings: Array.from({ length: count }, (_, substep) => ({ substep, solverMs: 1, physicsStepMs: 3 })) })
  return { fake, runtime, snapshots, issues, step, snapshot, cancelledTimers: () => cancelledTimers }
}

test('physics timing diagnostics gates controls until ready delivery in both transport schedules', async t => {
  // Source-bound admission model only: Worker world creation and main-thread ready delivery are distinct.
  class ReadinessWorker extends FakeWorker {
    worldReady = false
    paused = false
    executed: number[] = []
    override postMessage(data: unknown): void {
      const message = structuredClone(data) as { kind: string; sequence?: number }
      super.postMessage(message)
      if (!this.worldReady) return
      if (message.kind === 'pause') this.paused = true
      if (message.kind === 'resume') this.paused = false
      if (message.kind === 'step' && !this.paused && typeof message.sequence === 'number') this.executed.push(message.sequence)
    }
  }
  for (const order of ['pause-after-worker-ready-posted', 'pause-before-worker-ready'] as const) {
    for (const diagnostics of [true, false]) {
      const fake = new ReadinessWorker()
      const snapshots: number[] = [], issues: string[] = []
      let cancelled = 0, reentrantPausedPosts = 0
      const step = (sequence: number) => runtime.step({ sequence, steps: [{ characters: [], impulses: [] }] })
      const runtime = new WorldPhysicsWorkerRuntime({ generationId: 101, worker: fake, diagnostics: diagnostics ? true : undefined,
        scheduleTimeout: () => () => { cancelled += 1 }, onTriggerEvents: () => {}, onError: issue => issues.push(issue.code),
        onSnapshot(snapshot) {
          snapshots.push(snapshot.sequence)
          if (snapshot.sequence !== 0) return
          runtime.pause()
          const before = fake.messages.length
          step(1)
          reentrantPausedPosts += fake.messages.length - before
          runtime.resume()
        } })
      const controls = () => { runtime.pause(); runtime.resume(); runtime.pause() }
      const queuedReply = (sequence: number) => new Promise<void>(resolve => queueMicrotask(() => {
        if (fake.executed.includes(sequence)) fake.emit({ version: 1, kind: 'snapshot', generationId: 101, sequence,
          entityIds: [], transforms: new ArrayBuffer(0), triggerEvents: [],
          ...(diagnostics ? { stepTimings: [{ substep: 0, solverMs: 0, physicsStepMs: 0 }] } : {}) })
        resolve()
      }))
      try {
        const ready = runtime.initialize({ sceneId: 'scene:delayed-ready', gravity: [0, 0, 0], bodies: [] })
        if (order === 'pause-before-worker-ready') controls()
        fake.worldReady = true // The Worker has created its world and posted ready, but delivery is held.
        if (order === 'pause-after-worker-ready-posted') controls()
        const preReadyControls = fake.messages.filter(message => ['pause', 'resume'].includes((message as { kind: string }).kind))
          .map(message => (message as { kind: string }).kind)
        const pausedBeforeDelivery = fake.paused
        await new Promise<void>(resolve => queueMicrotask(() => {
          fake.emit({ version: 1, kind: 'ready', generationId: 101, entityIds: [] }); resolve()
        }))
        await ready
        if (!diagnostics) runtime.resume() // Legacy controls still post; undo their admitted late pause before stepping.
        step(0); await queuedReply(0)
        runtime.resume(); step(9); await queuedReply(9)
        t.diagnostic(JSON.stringify({ order, diagnostics, preReadyControls, executed: fake.executed, snapshots, issues }))
        assert.deepEqual(issues, [], 'A pre-delivery control must not strand diagnostic request ownership.')
        assert.deepEqual(snapshots, [0, 9])
        assert.deepEqual(fake.executed, [0, 9])
        assert.deepEqual(preReadyControls, diagnostics ? [] : ['pause', 'resume', 'pause'])
        assert.equal(pausedBeforeDelivery, !diagnostics && order === 'pause-after-worker-ready-posted')
        assert.equal(reentrantPausedPosts, diagnostics ? 0 : 1)
        assert.equal(fake.terminated, false)
      } finally {
        runtime.dispose(); runtime.dispose()
        assert.equal(fake.terminateCount, 1)
        assert.equal(fake.listenerCount(), 0)
        assert.equal(cancelled, 1)
      }
    }
  }
})

test('physics timing diagnostics preserves queued replies while suppressing paused requests', async () => {
  for (const [index, diagnostics] of [true, false, true].entries()) {
    const run = await timingRuntime(diagnostics, 20 + index, runtime => { runtime.pause(); runtime.resume(); runtime.pause() })
    const queuedReply = (sequence: number, count = 1) => new Promise<void>(resolve => queueMicrotask(() => {
      const { stepTimings, ...legacy } = run.snapshot(sequence, count)
      run.fake.emit(diagnostics ? { ...legacy, stepTimings } : legacy)
      resolve()
    }))
    try {
      run.step(0, 2) // Pre-ready pauses cannot suppress this first admitted request.
      run.runtime.pause(); run.runtime.pause()
      const beforePaused = run.fake.messages.length
      run.step(1)
      const pausedPosts = run.fake.messages.length - beforePaused
      await queuedReply(0, 2)
      assert.deepEqual(run.snapshots.map(snapshot => snapshot.sequence), [0])
      run.runtime.resume(); run.runtime.resume()
      run.step(9)
      await queuedReply(9)
      assert.deepEqual(run.issues, [])
      assert.deepEqual(run.snapshots.map(snapshot => snapshot.sequence), [0, 9])
      assert.equal(run.fake.terminated, false)
      assert.equal(pausedPosts, diagnostics ? 0 : 1)
      if (diagnostics) {
        run.runtime.pause()
        const beforeIgnored = run.fake.messages.length
        for (let sequence = 10; sequence < 75; sequence += 1) run.step(sequence)
        assert.equal(run.fake.messages.length, beforeIgnored, 'Paused attempts cannot consume any of the 64 request slots.')
        run.runtime.resume(); run.step(10); await queuedReply(10)
        assert.deepEqual(run.issues, [])
        assert.equal(run.snapshots.at(-1)?.sequence, 10, 'Paused attempts cannot advance sequence ownership.')
      }
      run.runtime.pause()
    } finally { run.runtime.dispose(); run.runtime.dispose() }
    const disposedPosts = run.fake.messages.length
    run.runtime.pause(); run.runtime.resume(); run.step(200)
    assert.equal(run.fake.messages.length, disposedPosts)
    assert.equal(run.fake.listenerCount(), 0)
    assert.equal(run.fake.terminateCount, 1)
    assert.equal(run.cancelledTimers(), 1)
  }
})

test('physics timing diagnostics binds requested rows and leaves default delivery unchanged', async () => {
  const enabled = await timingRuntime()
  try {
    assert.equal((enabled.fake.messages[0] as { diagnostics?: true }).diagnostics, true)
    enabled.step(0, 4)
    enabled.fake.emit({ ...enabled.snapshot(0, 4), generationId: 6 })
    const reply = enabled.snapshot(0, 4)
    enabled.fake.emit(reply)
    assert.deepEqual(enabled.snapshots[0].stepTimings, reply.stepTimings)
    reply.stepTimings[0].solverMs = 2
    assert.equal(enabled.snapshots[0].stepTimings![0].solverMs, 1)
    enabled.step(9)
    enabled.fake.emit(enabled.snapshot(9))
    assert.deepEqual(enabled.snapshots.map(snapshot => snapshot.sequence), [0, 9])
    enabled.runtime.pause(); enabled.runtime.resume()
  } finally { enabled.runtime.dispose(); enabled.runtime.dispose() }
  assert.equal(enabled.fake.listenerCount(), 0)
  assert.equal(enabled.fake.terminateCount, 1)
  assert.equal(enabled.cancelledTimers(), 1)
  const disabled = await timingRuntime(false)
  try {
    assert.equal(Object.hasOwn(disabled.fake.messages[0] as object, 'diagnostics'), false)
    const { stepTimings: _ignored, ...legacy } = disabled.snapshot(88)
    disabled.fake.emit(legacy)
    assert.equal(Object.hasOwn(disabled.snapshots[0], 'stepTimings'), false)
  } finally { disabled.runtime.dispose() }
})

test('physics timing diagnostics rejects unsolicited malformed missing replayed and mismatched replies', async () => {
  for (const failure of ['unsolicited', 'missing', 'malformed', 'count', 'sequence', 'duplicate', 'out-of-order']) {
    const run = await timingRuntime(failure !== 'unsolicited')
    try {
      run.step(8)
      const reply: Record<string, unknown> = run.snapshot(8)
      if (failure === 'missing') delete reply.stepTimings
      if (failure === 'malformed') reply.stepTimings = [{ substep: 0, solverMs: NaN, physicsStepMs: 3 }]
      if (failure === 'count') reply.stepTimings = run.snapshot(8, 2).stepTimings
      if (failure === 'sequence') reply.sequence = 9
      if (failure === 'duplicate') run.fake.emit(reply)
      if (failure === 'out-of-order') { run.step(9); reply.sequence = 9 }
      run.fake.emit(reply)
      assert.equal(run.issues.length, 1, failure)
      assert.equal(run.fake.terminated, true, failure)
      assert.equal(run.snapshots.length, failure === 'duplicate' ? 1 : 0, failure)
    } finally { run.runtime.dispose() }
  }
})

test('physics timing diagnostics rejects reused invalid and overflowing requests before posting', async () => {
  for (const failure of ['reuse', 'older', 'negative', 'fraction', 'zero-steps', 'five-steps', 'overflow']) {
    const run = await timingRuntime()
    try {
      if (failure === 'overflow') for (let sequence = 0; sequence < 64; sequence += 1) run.step(sequence)
      else { run.step(8); run.fake.emit(run.snapshot(8)) }
      const before = run.fake.messages.length
      run.step(failure === 'overflow' ? 64 : failure === 'reuse' ? 8 : failure === 'older' ? 7 : failure === 'negative' ? -1 : failure === 'fraction' ? 8.5 : 9,
        failure === 'zero-steps' ? 0 : failure === 'five-steps' ? 5 : 1)
      assert.equal(run.fake.messages.length, before, failure)
      assert.equal(run.issues.length, 1, failure)
      assert.equal(run.fake.listenerCount(), 0, failure)
    } finally { run.runtime.dispose() }
  }
  const fresh = await timingRuntime(true, 8)
  try { fresh.step(0); fresh.fake.emit(fresh.snapshot(0)); assert.equal(fresh.snapshots.length, 1) }
  finally { fresh.runtime.dispose() }
})

test('worker adapter initializes, ignores late generations and terminates on dispose', async () => {
  const fake = new FakeWorker()
  const snapshots: number[] = []
  const runtime = new WorldPhysicsWorkerRuntime({
    generationId: 7,
    worker: fake,
    onSnapshot: (snapshot) => { snapshots.push(snapshot.sequence) },
    onTriggerEvents: () => undefined,
  })
  const projection = projectWorldRuntimeScene(createRuntimeWorldSnapshot(), 'scene:one')
  assert.equal(projection.success, true)
  if (!projection.success) return
  const initializing = runtime.initialize(projection.value.physics)
  let ready = false
  void initializing.then(() => { ready = true })
  fake.emit({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'ready', generationId: 6, entityIds: [] })
  await Promise.resolve()
  assert.equal(ready, false)
  fake.emit({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'ready', generationId: 7, entityIds: projection.value.physics.bodies.map((body) => body.entityId) })
  await initializing
  runtime.step({ sequence: 1, steps: [{ characters: [], impulses: [] }] })
  fake.emit({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'snapshot', generationId: 6, sequence: 1, entityIds: [], transforms: new ArrayBuffer(0), triggerEvents: [] })
  fake.emit({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'snapshot', generationId: 7, sequence: 2, entityIds: [], transforms: new ArrayBuffer(0), triggerEvents: [] })
  assert.deepEqual(snapshots, [2])
  runtime.dispose()
  assert.equal(fake.terminated, true)
  assert.equal((fake.messages.at(-1) as { kind: string }).kind, 'dispose')
})

test('worker native errors and message errors reject initialization and ignore late events', async () => {
  const projection = projectWorldRuntimeScene(createRuntimeWorldSnapshot(), 'scene:one')
  assert.equal(projection.success, true)
  if (!projection.success) return
  for (const eventType of ['error', 'messageerror'] as const) {
    const fake = new FakeWorker()
    const issues: string[] = []
    const runtime = new WorldPhysicsWorkerRuntime({
      generationId: 8,
      worker: fake,
      onSnapshot: () => undefined,
      onTriggerEvents: () => undefined,
      onError: (issue) => issues.push(issue.code),
      initializationTimeoutMs: 100,
    })
    const initializing = runtime.initialize(projection.value.physics)
    if (eventType === 'error') fake.emitError('WASM module crashed.')
    else fake.emitMessageError()
    await assert.rejects(withDeadline(initializing), eventType === 'error' ? /WASM module crashed/ : /message could not be decoded/i)
    assert.deepEqual(issues, [eventType === 'error' ? 'worker-error' : 'worker-message-error'])
    assert.equal(fake.terminated, true)
    fake.emit({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'ready', generationId: 8, entityIds: [] })
    fake.emitError('late')
    assert.equal(issues.length, 1)
  }
})

test('worker initialization has a bounded timeout and catches postMessage failure', async () => {
  const projection = projectWorldRuntimeScene(createRuntimeWorldSnapshot(), 'scene:one')
  assert.equal(projection.success, true)
  if (!projection.success) return
  const timedOutWorker = new FakeWorker()
  const timedOut = new WorldPhysicsWorkerRuntime({
    generationId: 9,
    worker: timedOutWorker,
    onSnapshot: () => undefined,
    onTriggerEvents: () => undefined,
    initializationTimeoutMs: 5,
  })
  await assert.rejects(withDeadline(timedOut.initialize(projection.value.physics)), /timed out/i)
  assert.equal(timedOutWorker.terminated, true)

  const throwingWorker = new FakeWorker()
  throwingWorker.throwOnPost = new Error('post failed')
  const throwing = new WorldPhysicsWorkerRuntime({
    generationId: 10,
    worker: throwingWorker,
    onSnapshot: () => undefined,
    onTriggerEvents: () => undefined,
  })
  await assert.rejects(throwing.initialize(projection.value.physics), /post failed/)
  assert.equal(throwingWorker.terminated, true)
})

test('disposing initialization cancels readiness and ignores every late Worker event', async () => {
  const projection = projectWorldRuntimeScene(createRuntimeWorldSnapshot(), 'scene:one')
  assert.equal(projection.success, true)
  if (!projection.success) return
  const fake = new FakeWorker()
  const issues: string[] = []
  const runtime = new WorldPhysicsWorkerRuntime({
    generationId: 11,
    worker: fake,
    onSnapshot: () => undefined,
    onTriggerEvents: () => undefined,
    onError: (issue) => issues.push(issue.code),
  })
  const initializing = runtime.initialize(projection.value.physics)
  runtime.dispose()
  await assert.rejects(initializing, /cancelled/i)
  fake.emit({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'ready', generationId: 11, entityIds: [] })
  fake.emitError('late')
  fake.emitMessageError()
  assert.deepEqual(issues, [])
})

test('worker failure after ready is surfaced and terminates the initialized runtime', async () => {
  const projection = projectWorldRuntimeScene(createRuntimeWorldSnapshot(), 'scene:one')
  assert.equal(projection.success, true)
  if (!projection.success) return
  const fake = new FakeWorker()
  const issues: string[] = []
  const runtime = new WorldPhysicsWorkerRuntime({
    generationId: 12,
    worker: fake,
    onSnapshot: () => undefined,
    onTriggerEvents: () => undefined,
    onError: (issue) => issues.push(issue.code),
  })
  const initializing = runtime.initialize(projection.value.physics)
  fake.emit({
    version: WORLD_PHYSICS_PROTOCOL_VERSION,
    kind: 'ready',
    generationId: 12,
    entityIds: projection.value.physics.bodies.map((body) => body.entityId),
  })
  await initializing
  fake.emitError('Rapier failed after readiness.')
  assert.deepEqual(issues, ['worker-error'])
  assert.equal(fake.terminated, true)
})

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Test deadline expired.')), 250)),
  ])
}
