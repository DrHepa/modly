import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorldBehaviorAction } from '../core/worldComponentRegistry.ts'
import { createWorldEditorSession } from '../core/worldSessions.ts'
import { projectWorldEditorViewport } from '../editor/useWorldEditorProjectionBridge.ts'
import { createRuntimeWorldSnapshot } from './_testFixtures.ts'
import { createWorldPlayController, type WorldPhysicsRuntimePort } from './worldPlayController.ts'
import type { WorldPreparedGeometrySource } from './worldGeometryPreparation.ts'
import type { WorldAudioAuthority, WorldAudioPose } from './worldAudioRuntime.ts'
import type { WorldPhysicsSceneDto, WorldPhysicsStepRequest } from './worldPhysicsProtocol.ts'
import type { WorldPhysicsRuntimeHandlers } from './worldPhysicsRuntime.ts'
import { WorldInputSampler } from './worldInputRuntime.ts'
import { projectWorldRuntimeScene } from './worldRuntimeProjection.ts'
import { applyWorldCommandBatch } from '../core/worldCommands.ts'
import { buildCharacterControllerPresetCommands } from '../editor/worldAuthoringModel.ts'
import { createDeterministicWorldEditorIdentityGenerator } from '../editor/worldEditorCommandBuilders.ts'

test('authored character controls reach the existing physics port and Stop retains exact editor data', async () => {
  for (const withJump of [true, false]) {
    const snapshot = createRuntimeWorldSnapshot()
    const hero = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:hero')!
    hero.components = hero.components.filter((component) => component.type !== 'character-controller')
    const commands = buildCharacterControllerPresetCommands({ snapshot, projectKey: `world-${'a'.repeat(32)}`, activeSceneId: 'scene:one', identities: createDeterministicWorldEditorIdentityGenerator(`play-character-${withJump}`) }, hero.id, withJump ? {} : { jumpActionId: null })
    const authored = applyWorldCommandBatch(snapshot, { schema: 'modly.world-command-batch.v1', transactionId: 'tx:play-character', projectId: snapshot.project.projectId, baseRevision: snapshot.project.revision, origin: 'ui', commands })
    assert.ok(authored.success)
    const editor = createWorldEditorSession(authored.snapshot)
    assert.ok(editor.success)
    const before = JSON.stringify(editor.session.snapshot)
    const { controller, physics } = createHarness()
    const sampler = new WorldInputSampler(authored.snapshot.project.inputActions)
    assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
    await controller.advance(0, sampler.sample())
    sampler.setControl('keyboard', 'KeyW', 1)
    sampler.setControl('keyboard', 'KeyD', 1)
    sampler.setControl('keyboard', 'Space', 1)
    assert.equal((await controller.advance(17, sampler.sample())).success, true)
    assert.deepEqual(physics[0].steps.at(-1)?.steps[0]?.characters, [{ entityId: 'entity:hero', move: [1, 1], jumpPressed: withJump }])
    await controller.advance(34, sampler.sample())
    assert.equal(physics[0].steps.at(-1)?.steps[0]?.characters[0]?.jumpPressed, false)
    assert.equal((await controller.stop()).success, true)
    assert.equal(controller.getState().editor, editor.session)
    assert.equal(JSON.stringify(editor.session.snapshot), before)
    assert.equal(physics[0].disposed, true)
    sampler.dispose()
  }
})

function createHarness(options: { rejectInitializeGeneration?: number; rejectActivationGeneration?: number; rejectPlayGeneration?: number; initialize?: (generationId: number) => Promise<void>; stopAudio?: (generationId: number) => Promise<void>; pauseAudio?: () => Promise<void>; resumeAudio?: () => Promise<void>; playAudio?: () => Promise<void> } = {}) {
  const physics: Array<{ generationId: number; initialized: string[]; steps: WorldPhysicsStepRequest[]; disposed: boolean; handlers: WorldPhysicsRuntimeHandlers }> = []
  const audio: Array<{ prepared: string[]; activated: boolean; stopped: boolean; paused: boolean; played: string[]; stoppedSources: string[]; updated: WorldAudioPose[][] }> = []
  const controller = createWorldPlayController({
    createPhysics(generationId, handlers): WorldPhysicsRuntimePort {
      const state = { generationId, initialized: [] as string[], steps: [] as WorldPhysicsStepRequest[], disposed: false, handlers }
      physics.push(state)
      return {
        async initialize(scene: WorldPhysicsSceneDto) {
          state.initialized.push(scene.sceneId)
          if (options.rejectInitializeGeneration === generationId) throw new Error(`Physics ${generationId} failed.`)
          await options.initialize?.(generationId)
        },
        step(request) { state.steps.push(request) },
        pause() {}, resume() {},
        dispose() { state.disposed = true },
      }
    },
    createAudio(): WorldAudioAuthority {
      const generation = audio.length + 1
      const state = { prepared: [] as string[], activated: false, stopped: false, paused: false, played: [] as string[], stoppedSources: [] as string[], updated: [] as WorldAudioPose[][] }
      audio.push(state)
      return {
        async prepareScene(_snapshot, sceneId) { state.prepared.push(sceneId) },
        async activate() {
          state.activated = true
          if (options.rejectActivationGeneration === generation) throw new Error(`Audio ${generation} failed.`)
        },
        async play(componentId) {
          state.played.push(componentId)
          if (options.rejectPlayGeneration === generation) throw new Error(`Audio play ${generation} failed.`)
          await options.playAudio?.()
        },
        async stopSource(componentId) { state.stoppedSources.push(componentId) },
        update(poses) { state.updated.push(structuredClone(poses) as WorldAudioPose[]) },
        async pause() { state.paused = true; await options.pauseAudio?.() },
        async resume() { state.paused = false; await options.resumeAudio?.() },
        async stop() { state.stopped = true; await options.stopAudio?.(generation) },
      }
    },
  })
  return { controller, physics, audio }
}

function deferredClosure() {
  let resolve = () => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<void>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

test('Stop waits for owned audio closure, rejects reentrant Stop and denies Play until settlement', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const before = JSON.stringify(editor.session.snapshot)
  const closure = deferredClosure()
  const { controller, physics, audio } = createHarness({ stopAudio: () => closure.promise })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  let reentrant: ReturnType<typeof controller.stop> | undefined
  controller.subscribe(() => {
    if (controller.getState().lifecycle === 'stopping' && !reentrant) reentrant = controller.stop()
  })
  let settled = false
  const stopping = controller.stop().then((result) => { settled = true; return result })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(controller.getState().lifecycle, 'stopping')
  assert.equal(controller.getState().runtimeSnapshot, null)
  assert.deepEqual(controller.getState().bodyPoses, [])
  assert.equal(physics[0]?.disposed, true)
  assert.equal(audio[0]?.stopped, true)
  assert.equal((await reentrant)?.success, false)
  assert.equal((await controller.start(editor.session, 'scene:one')).success, false)
  physics[0]?.handlers.onSnapshot({ generationId: physics[0].generationId, sequence: 99, entityIds: ['entity:hero'], transforms: new Float32Array([99, 0, 0, 0, 0, 0, 1]), triggerEvents: [] })
  physics[0]?.handlers.onError?.({ code: 'late-stop-error', message: 'Disposed Worker failed.' })
  assert.equal(controller.getState().failure, null)
  closure.resolve()
  assert.equal((await stopping).success, true)
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(controller.getState().editor, editor.session)
  assert.equal(JSON.stringify(editor.session.snapshot), before)
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  assert.equal((await controller.stop()).success, true)
})

test('Stop cancels loading but remains stopping until the prepared audio authority closes', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const initialization = deferredClosure()
  const closure = deferredClosure()
  const { controller, physics } = createHarness({ initialize: () => initialization.promise, stopAudio: () => closure.promise })
  const starting = controller.start(editor.session, 'scene:one')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getState().lifecycle, 'loading')
  let settled = false
  const stopping = controller.stop().then((result) => { settled = true; return result })
  const cancelled = await withDeadline(starting)
  assert.equal(cancelled.success, false)
  assert.equal(cancelled.success ? '' : cancelled.issues[0]?.code, 'runtime-load-cancelled')
  assert.equal(settled, false)
  assert.equal(controller.getState().lifecycle, 'stopping')
  assert.equal(physics[0]?.disposed, true)
  initialization.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getState().runtimeSnapshot, null)
  assert.equal((await controller.start(editor.session, 'scene:one')).success, false)
  closure.resolve()
  assert.equal((await stopping).success, true)
  assert.equal(controller.getState().editor, editor.session)
  assert.equal(controller.getState().failure, null)
})

test('Stop waits for every audio settlement and reports a retired closure rejection without deadlocking', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const retired = deferredClosure()
  const active = deferredClosure()
  const stops: number[] = []
  const { controller, physics } = createHarness({ stopAudio(generationId) {
    stops.push(generationId)
    return generationId === 1 ? retired.promise : active.promise
  } })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  assert.equal((await withDeadline(controller.requestSceneChange('scene:two'))).success, true)
  retired.reject(new Error('AudioContext close failed.'))
  await new Promise((resolve) => setImmediate(resolve))
  let settled = false
  const stopping = controller.stop().then((result) => { settled = true; return result })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(controller.getState().lifecycle, 'stopping')
  assert.equal(physics.every((runtime) => runtime.disposed), true)
  assert.deepEqual(stops, [1, 2])
  active.resolve()
  const result = await stopping
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-audio-stop-failed')
  assert.equal(result.success ? '' : result.issues[0]?.message, 'AudioContext close failed.')
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(controller.getState().runtimeSnapshot, null)
  assert.equal(controller.getState().editor, editor.session)
  assert.equal(controller.getState().failure?.code, 'runtime-audio-stop-failed')
})

test('Stop rejects stale pause and resume publications while audio closure is pending', async () => {
  for (const operation of ['pause', 'resume'] as const) {
    const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
    if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
    const closure = deferredClosure()
    const operationAudio = deferredClosure()
    const { controller } = createHarness({
      stopAudio: () => closure.promise,
      pauseAudio: operation === 'pause' ? () => operationAudio.promise : undefined,
      resumeAudio: operation === 'resume' ? () => operationAudio.promise : undefined,
    })
    assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
    if (operation === 'resume') assert.equal((await controller.pause()).success, true)
    const operating = controller[operation]()
    const stopping = controller.stop()
    operationAudio.resolve()
    assert.equal((await operating).success, false)
    assert.equal(controller.getState().lifecycle, 'stopping')
    assert.equal(controller.getState().runtimeSnapshot, null)
    closure.resolve()
    assert.equal((await stopping).success, true)
    assert.equal(controller.getState().lifecycle, 'edit')
  }
})

test('same-Play pause and resume during replacement release scene-change ownership', async () => {
  for (const operation of ['pause', 'resume'] as const) {
    const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
    if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
    const initialization = deferredClosure()
    const { controller } = createHarness({ initialize: (generationId) => generationId === 2 ? initialization.promise : Promise.resolve() })
    assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
    if (operation === 'resume') assert.equal((await controller.pause()).success, true)
    const replacing = controller.requestSceneChange('scene:two')
    try {
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(controller.getState().lifecycle, 'loading')
      assert.equal((await controller[operation]()).success, true)
      initialization.resolve()
      assert.equal((await replacing).success, true)
      if (operation === 'pause') assert.equal((await controller.resume()).success, true)
      assert.equal(controller.getState().sceneId, 'scene:two')
      assert.equal(controller.getState().lifecycle, 'playing')
      assert.equal((await controller.requestSceneChange('scene:one')).success, true)
    } finally {
      initialization.resolve()
      await replacing
      await controller.stop()
    }
  }
})

test('Stop prevents an awaited behavior audio effect from republishing runtime mutations', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  replaceJumpBehaviorActions(snapshot, [
    { type: 'set-visibility', entityId: 'entity:hero', visible: false },
    { type: 'play-audio', entityId: 'entity:camera', componentId: 'component:beep' },
  ])
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const closure = deferredClosure()
  const effectAudio = deferredClosure()
  const { controller, physics } = createHarness({ stopAudio: () => closure.promise, playAudio: () => effectAudio.promise })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const sampler = new WorldInputSampler(snapshot.project.inputActions)
  await controller.advance(0, sampler.sample())
  sampler.setControl('keyboard', 'Space', 1)
  const advancing = controller.advance(17, sampler.sample())
  const stopping = controller.stop()
  effectAudio.resolve()
  assert.equal((await advancing).success, false)
  assert.equal(controller.getState().lifecycle, 'stopping')
  assert.equal(controller.getState().runtimeSnapshot, null)
  assert.deepEqual(controller.getState().diagnostics, [])
  assert.deepEqual(physics[0]?.steps, [])
  closure.resolve()
  assert.equal((await stopping).success, true)
  sampler.dispose()
})

function replaceJumpBehaviorActions(snapshot: ReturnType<typeof createRuntimeWorldSnapshot>, actions: WorldBehaviorAction[]): void {
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  const binding = behavior.bindings.find((candidate) => candidate.event.type === 'input')
  if (!binding) throw new Error('Runtime input binding fixture is unavailable.')
  binding.actions = actions
}

function addSceneTwoStartBehavior(snapshot: ReturnType<typeof createRuntimeWorldSnapshot>, actions: WorldBehaviorAction[]): void {
  snapshot.scenes[1].entities[0].components.push({
    id: 'component:scene-two-start',
    type: 'behavior',
    enabled: true,
    bindings: [{ id: 'binding:scene-two-start', event: { type: 'start' }, actions }],
  })
}

async function triggerJumpBehavior(snapshot: ReturnType<typeof createRuntimeWorldSnapshot>) {
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error(`Runtime editor fixture is invalid: ${editor.issues[0]?.message ?? 'unknown error'}`)
  const harness = createHarness()
  const started = await harness.controller.start(editor.session, 'scene:one')
  if (!started.success) throw new Error(`Runtime did not start: ${started.issues[0]?.message ?? 'unknown error'}`)
  const before = harness.controller.getState().runtimeSnapshot
  const generationId = harness.controller.getState().generationId
  const sampler = new WorldInputSampler(snapshot.project.inputActions)
  sampler.setControl('keyboard', 'Space', 1)
  await harness.controller.advance(0, sampler.sample())
  const result = await harness.controller.advance(1000 / 60, sampler.sample())
  return { ...harness, result, before, generationId }
}

function invalidTransactionActions(...properties: WorldBehaviorAction[]): WorldBehaviorAction[] {
  return [
    { type: 'play-audio', entityId: 'entity:camera', componentId: 'component:beep' },
    { type: 'play-animation', entityId: 'entity:hero', componentId: 'component:hero-animation' },
    { type: 'apply-impulse', entityId: 'entity:crate', impulse: [3, 0, 0] },
    { type: 'change-scene', sceneId: 'scene:two' },
    ...properties,
  ]
}

function assertBehaviorTransactionRejectedAtomically(result: Awaited<ReturnType<typeof triggerJumpBehavior>>): void {
  assert.equal(result.result.success, false)
  assert.equal(result.result.success ? '' : result.result.issues[0]?.code, 'runtime-behavior-state-invalid')
  const state = result.controller.getState()
  assert.equal(state.lifecycle, 'playing')
  assert.equal(state.sceneId, 'scene:one')
  assert.equal(state.generationId, result.generationId)
  assert.equal(state.runtimeSnapshot, result.before)
  assert.equal(state.failure, null)
  assert.equal(state.diagnostics.at(-1)?.code, 'runtime-behavior-state-invalid')
  assert.deepEqual(state.animationRequests, [])
  assert.equal(result.physics.length, 1)
  assert.equal(result.physics[0]?.disposed, false)
  assert.deepEqual(result.physics[0]?.steps, [])
  assert.equal(result.audio.length, 1)
  assert.equal(result.audio[0]?.stopped, false)
  assert.deepEqual(result.audio[0]?.played, [])
}

test('Play clones editor state, pauses/resumes and Stop restores the exact editor session', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  assert.equal(editor.success, true)
  if (!editor.success) return
  const { controller, physics, audio } = createHarness()
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  assert.equal(controller.getState().lifecycle, 'playing')
  assert.notEqual(controller.getState().runtimeSnapshot, editor.session.snapshot)
  assert.equal((await controller.pause()).success, true)
  assert.equal(controller.getState().lifecycle, 'paused')
  assert.equal((await controller.resume()).success, true)
  const before = JSON.stringify(editor.session.snapshot)
  assert.equal((await controller.stop()).success, true)
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(controller.getState().editor, editor.session)
  assert.equal(JSON.stringify(editor.session.snapshot), before)
  assert.equal(physics.every((item) => item.disposed), true)
  assert.equal(audio.every((item) => item.stopped), true)
})

test('Play uses the shared Start-transition graph gate before creating runtime authorities', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  behavior.bindings[0]!.actions.push({ type: 'change-scene', sceneId: 'scene:one' })
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const { controller, physics, audio } = createHarness()

  const result = await controller.start(editor.session, 'scene:one')

  assert.equal(result.success, false)
  if (!result.success) {
    assert.equal(result.issues[0]?.code, 'runtime-start-transition-cycle')
    assert.equal(result.issues[0]?.message, 'Start behavior created a scene transition cycle at scene:one.')
  }
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.deepEqual(physics, [])
  assert.deepEqual(audio, [])
})

test('visual behavior can stop one authored audio source without stopping Play', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  replaceJumpBehaviorActions(snapshot, [
    { type: 'play-audio', entityId: 'entity:camera', componentId: 'component:beep' },
    { type: 'stop-audio', entityId: 'entity:camera', componentId: 'component:beep' } as unknown as WorldBehaviorAction,
  ])
  const result = await triggerJumpBehavior(snapshot)
  assert.equal(result.result.success, true)
  assert.deepEqual(result.audio[0]?.played, ['component:beep'])
  assert.deepEqual(result.audio[0]?.stoppedSources, ['component:beep'])
  assert.equal(result.audio[0]?.stopped, false)
  assert.equal(result.controller.getState().lifecycle, 'playing')
})

test('input behavior changes scene through two-phase generation and late snapshots are rejected', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  assert.equal(editor.success, true)
  if (!editor.success) return
  const { controller, physics } = createHarness()
  await controller.start(editor.session, 'scene:one')
  const sampler = new WorldInputSampler(editor.session.snapshot.project.inputActions)
  sampler.setControl('keyboard', 'Space', 1)
  await controller.advance(0, sampler.sample())
  await controller.advance(1000 / 60, sampler.sample())
  assert.equal(physics[0]?.steps.length, 1)
  physics[0]?.handlers.onTriggerEvents([{ type: 'enter', triggerComponentId: 'component:zone-trigger', otherEntityId: 'entity:hero', otherTags: ['player'] }])
  await controller.advance(2 * 1000 / 60, sampler.sample())
  assert.equal(controller.getState().sceneId, 'scene:two')
  assert.equal(physics[0]?.disposed, true)
  const generation = controller.getState().generationId
  physics[0]?.handlers.onSnapshot({ generationId: generation - 1, sequence: 99, entityIds: ['entity:hero'], transforms: new Float32Array([99, 0, 0, 0, 0, 0, 1]), triggerEvents: [] })
  assert.equal(controller.getState().bodyPoses.some((pose) => pose.position[0] === 99), false)
})

test('supported visual property effects publish a live viewport projection', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  const inputBinding = behavior.bindings.find((binding) => binding.event.type === 'input')
  if (!inputBinding) throw new Error('Runtime input binding fixture is unavailable.')
  inputBinding.actions.unshift({
    type: 'set-component-property',
    entityId: 'entity:hero',
    componentId: 'component:hero-renderable',
    componentType: 'renderable',
    property: 'material.opacity',
    value: 0.25,
  })
  const editor = createWorldEditorSession(snapshot)
  assert.equal(editor.success, true)
  if (!editor.success) return
  const { controller } = createHarness()
  await controller.start(editor.session, 'scene:one')
  const before = controller.getState().runtimeSnapshot
  const sampler = new WorldInputSampler(editor.session.snapshot.project.inputActions)
  sampler.setControl('keyboard', 'Space', 1)
  await controller.advance(0, sampler.sample())
  await controller.advance(1000 / 60, sampler.sample())
  const after = controller.getState().runtimeSnapshot
  assert.notEqual(after, before)
  const hero = after?.scenes[0].entities.find((entity) => entity.id === 'entity:hero')
  const renderable = hero?.components.find((component) => component.type === 'renderable')
  assert.equal(renderable?.type === 'renderable' ? renderable.material.opacity : undefined, 0.25)
  if (!after) throw new Error('Runtime snapshot was not published.')
  const viewport = projectWorldEditorViewport(after, 'scene:one', 'http://127.0.0.1:8000')
  assert.equal(viewport.success, true)
  if (viewport.success) assert.equal(viewport.value.items.find((item) => item.id === 'entity:hero')?.material?.opacity, 0.25)
})

test('behavior transaction rejects disabling the sole primary camera without external effects', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  replaceJumpBehaviorActions(snapshot, invalidTransactionActions({
    type: 'set-component-property', entityId: 'entity:camera', componentId: 'component:camera',
    componentType: 'camera', property: 'enabled', value: false,
  }))
  const executed = await triggerJumpBehavior(snapshot)
  assertBehaviorTransactionRejectedAtomically(executed)
  assert.equal(
    executed.result.success ? '' : executed.result.issues[0]?.message,
    'Behavior transaction was rejected: Play requires exactly one enabled primary camera.',
  )
  assert.equal(executed.result.success ? '' : executed.result.issues[0]?.path, 'scenes.scene:one.entities')
})

test('behavior transaction rejects clearing the sole primary camera without external effects', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  replaceJumpBehaviorActions(snapshot, invalidTransactionActions({
    type: 'set-component-property', entityId: 'entity:camera', componentId: 'component:camera',
    componentType: 'camera', property: 'primary', value: false,
  }))
  const executed = await triggerJumpBehavior(snapshot)
  assertBehaviorTransactionRejectedAtomically(executed)
  assert.equal(
    executed.result.success ? '' : executed.result.issues[0]?.message,
    'Behavior transaction was rejected: Play requires exactly one enabled primary camera.',
  )
  assert.equal(executed.result.success ? '' : executed.result.issues[0]?.path, 'scenes.scene:one.entities')
})

test('behavior transaction validates combined camera clipping changes only after the final candidate', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  replaceJumpBehaviorActions(snapshot, invalidTransactionActions(
    {
      type: 'set-component-property', entityId: 'entity:camera', componentId: 'component:camera',
      componentType: 'camera', property: 'near', value: 100,
    },
    {
      type: 'set-component-property', entityId: 'entity:camera', componentId: 'component:camera',
      componentType: 'camera', property: 'far', value: 50,
    },
  ))
  const executed = await triggerJumpBehavior(snapshot)
  assertBehaviorTransactionRejectedAtomically(executed)
  assert.equal(
    executed.result.success ? '' : executed.result.issues[0]?.message,
    'Behavior transaction was rejected: Camera clipping planes are invalid.',
  )
  assert.equal(
    executed.result.success ? '' : executed.result.issues[0]?.path,
    'snapshot.scenes[0].entities[0].components[0]',
  )
})

test('behavior transaction accepts an atomic primary camera handoff', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.scenes[0].entities.push({
    id: 'entity:camera-secondary', name: 'Secondary camera', parentId: null, enabled: true, locked: false, tags: ['camera'],
    transform: { position: [4, 3, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{
      id: 'component:camera-secondary', type: 'camera', enabled: true, projection: 'perspective', primary: false,
      near: 0.1, far: 500, fieldOfView: 55,
    }],
  })
  replaceJumpBehaviorActions(snapshot, [
    {
      type: 'set-component-property', entityId: 'entity:camera', componentId: 'component:camera',
      componentType: 'camera', property: 'primary', value: false,
    },
    {
      type: 'set-component-property', entityId: 'entity:camera-secondary', componentId: 'component:camera-secondary',
      componentType: 'camera', property: 'primary', value: true,
    },
  ])
  const executed = await triggerJumpBehavior(snapshot)
  assert.equal(executed.result.success, true)
  const runtimeSnapshot = executed.controller.getState().runtimeSnapshot
  assert.notEqual(runtimeSnapshot, executed.before)
  const projection = runtimeSnapshot ? projectWorldRuntimeScene(runtimeSnapshot, 'scene:one') : null
  assert.equal(projection?.success, true)
  if (projection?.success) assert.equal(projection.value.primaryCameraEntityId, 'entity:camera-secondary')
  assert.equal(executed.physics[0]?.steps.length, 1)
  assert.equal(executed.controller.getState().failure, null)
})

test('behavior transaction preflights a scene target before external effects', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const targetCamera = snapshot.scenes[1].entities[0].components.find((component) => component.type === 'camera')
  if (targetCamera?.type !== 'camera') throw new Error('Target camera fixture is unavailable.')
  targetCamera.primary = false
  replaceJumpBehaviorActions(snapshot, invalidTransactionActions())
  const executed = await triggerJumpBehavior(snapshot)
  assertBehaviorTransactionRejectedAtomically(executed)
  assert.equal(
    executed.result.success ? '' : executed.result.issues[0]?.message,
    'Behavior transaction was rejected: Play requires exactly one enabled primary camera.',
  )
  assert.equal(executed.result.success ? '' : executed.result.issues[0]?.path, 'scenes.scene:two.entities')
})

test('behavior transaction preflights the target Start result before external effects', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  addSceneTwoStartBehavior(snapshot, [{
    type: 'set-component-property', entityId: 'entity:camera-two', componentId: 'component:camera-two',
    componentType: 'camera', property: 'primary', value: false,
  }])
  replaceJumpBehaviorActions(snapshot, invalidTransactionActions())
  const executed = await triggerJumpBehavior(snapshot)
  assertBehaviorTransactionRejectedAtomically(executed)
  assert.equal(
    executed.result.success ? '' : executed.result.issues[0]?.message,
    'Behavior transaction was rejected: Play requires exactly one enabled primary camera.',
  )
})

test('successful scene transition preserves committed behavior snapshot changes', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  replaceJumpBehaviorActions(snapshot, [
    {
      type: 'set-component-property', entityId: 'entity:hero', componentId: 'component:hero-renderable',
      componentType: 'renderable', property: 'material.opacity', value: 0.4,
    },
    { type: 'change-scene', sceneId: 'scene:two' },
  ])
  const executed = await triggerJumpBehavior(snapshot)
  assert.equal(executed.result.success, true)
  assert.equal(executed.controller.getState().sceneId, 'scene:two')
  const hero = executed.controller.getState().runtimeSnapshot?.scenes[0].entities.find((entity) => entity.id === 'entity:hero')
  const renderable = hero?.components.find((component) => component.type === 'renderable')
  assert.equal(renderable?.type === 'renderable' ? renderable.material.opacity : undefined, 0.4)
})

test('rejected behavior transaction does not consume a once trigger', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  const triggerBinding = behavior.bindings.find((binding) => binding.event.type === 'trigger-enter')
  if (!triggerBinding) throw new Error('Runtime trigger binding fixture is unavailable.')
  triggerBinding.actions = [{
    type: 'set-component-property', entityId: 'entity:camera', componentId: 'component:camera',
    componentType: 'camera', property: 'primary', value: false,
  }]
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const { controller, physics } = createHarness()
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const sampler = new WorldInputSampler(snapshot.project.inputActions)
  await controller.advance(0, sampler.sample())
  const triggerEvent = { type: 'enter' as const, triggerComponentId: 'component:zone-trigger', otherEntityId: 'entity:hero', otherTags: ['player'] }
  physics[0]?.handlers.onTriggerEvents([triggerEvent])
  const first = await controller.advance(1000 / 60, sampler.sample())
  physics[0]?.handlers.onTriggerEvents([triggerEvent])
  const second = await controller.advance(2 * 1000 / 60, sampler.sample())
  assert.equal(first.success, false)
  assert.equal(second.success, false)
  assert.deepEqual(controller.getState().diagnostics.map((issue) => issue.code), [
    'runtime-behavior-state-invalid',
    'runtime-behavior-state-invalid',
  ])
  assert.deepEqual(physics[0]?.steps, [])
})

test('invalid replacement Start never publishes the prepared scene', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  addSceneTwoStartBehavior(snapshot, [{
    type: 'set-component-property', entityId: 'entity:camera-two', componentId: 'component:camera-two',
    componentType: 'camera', property: 'primary', value: false,
  }])
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const { controller, physics, audio } = createHarness()
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const before = controller.getState().runtimeSnapshot
  const published: string[] = []
  const unsubscribe = controller.subscribe(() => {
    const state = controller.getState()
    published.push(`${state.lifecycle}:${state.sceneId ?? 'none'}`)
  })
  const result = await controller.requestSceneChange('scene:two')
  unsubscribe()
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-behavior-state-invalid')
  assert.equal(published.includes('playing:scene:two'), false)
  assert.equal(controller.getState().sceneId, 'scene:one')
  assert.equal(controller.getState().runtimeSnapshot, before)
  assert.equal(physics[0]?.disposed, false)
  assert.equal(physics.length, 1)
  assert.equal(audio[0]?.stopped, false)
  assert.equal(audio.length, 1)
})

test('failed replacement Start restores the exact prior published state', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.scenes[1].entities[0].components.push(
    {
      id: 'component:scene-two-renderable', type: 'renderable', enabled: true, resourceId: 'resource:hero', visible: true,
      castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
    },
    {
      id: 'component:scene-two-audio', type: 'audio-source', enabled: true, resourceId: 'resource:beep',
      autoplay: false, loop: false, volume: 1, spatial: false, maxDistance: 20,
    },
  )
  addSceneTwoStartBehavior(snapshot, [
    {
      type: 'set-component-property', entityId: 'entity:camera-two', componentId: 'component:scene-two-renderable',
      componentType: 'renderable', property: 'material.opacity', value: 0.4,
    },
    { type: 'play-audio', entityId: 'entity:camera-two', componentId: 'component:scene-two-audio' },
  ])
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const { controller, physics, audio } = createHarness({ rejectPlayGeneration: 2 })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const before = controller.getState()
  const result = await controller.requestSceneChange('scene:two')
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-start-failed')
  const after = controller.getState()
  assert.equal(after.lifecycle, 'playing')
  assert.equal(after.sceneId, before.sceneId)
  assert.equal(after.generationId, before.generationId)
  assert.equal(after.runtimeSnapshot, before.runtimeSnapshot)
  assert.deepEqual(after.animationRequests, before.animationRequests)
  assert.deepEqual(after.diagnostics, before.diagnostics)
  assert.equal(physics[0]?.disposed, false)
  assert.equal(physics[1]?.disposed, true)
  assert.equal(audio[0]?.stopped, false)
  assert.equal(audio[1]?.stopped, true)
})

test('failed replacement load does not consume a once transition trigger', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  const triggerBinding = behavior.bindings.find((binding) => binding.event.type === 'trigger-enter')
  if (!triggerBinding) throw new Error('Runtime trigger binding fixture is unavailable.')
  triggerBinding.actions = [{ type: 'change-scene', sceneId: 'scene:two' }]
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const { controller, physics } = createHarness({ rejectInitializeGeneration: 2 })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const sampler = new WorldInputSampler(snapshot.project.inputActions)
  await controller.advance(0, sampler.sample())
  const triggerEvent = { type: 'enter' as const, triggerComponentId: 'component:zone-trigger', otherEntityId: 'entity:hero', otherTags: ['player'] }
  physics[0]?.handlers.onTriggerEvents([triggerEvent])
  const first = await controller.advance(1000 / 60, sampler.sample())
  assert.equal(first.success, false)
  assert.equal(controller.getState().sceneId, 'scene:one')
  physics[0]?.handlers.onTriggerEvents([triggerEvent])
  const second = await controller.advance(2 * 1000 / 60, sampler.sample())
  assert.equal(second.success, true)
  assert.equal(controller.getState().sceneId, 'scene:two')
  assert.equal(physics.length, 3)
})

test('replacement Start scene transitions remain inside the active two-phase switch', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  addSceneTwoStartBehavior(snapshot, [{ type: 'change-scene', sceneId: 'scene:one' }])
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const { controller, physics, audio } = createHarness()
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const result = await controller.requestSceneChange('scene:two')
  assert.equal(result.success, true)
  assert.equal(controller.getState().lifecycle, 'playing')
  assert.equal(controller.getState().sceneId, 'scene:one')
  assert.equal(physics.length, 3)
  assert.equal(physics[0]?.disposed, true)
  assert.equal(physics[1]?.disposed, true)
  assert.equal(physics[2]?.disposed, false)
  assert.equal(audio[0]?.stopped, true)
  assert.equal(audio[1]?.stopped, true)
  assert.equal(audio[2]?.stopped, false)
})

test('recursive Start transition does not await an intermediate audio shutdown tail', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  addSceneTwoStartBehavior(snapshot, [{ type: 'change-scene', sceneId: 'scene:one' }])
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const physics: Array<{ disposed: boolean }> = []
  const audio: Array<{ stopped: boolean }> = []
  const controller = createWorldPlayController({
    createPhysics() {
      const state = { disposed: false }
      physics.push(state)
      return {
        async initialize() {}, step() {}, pause() {}, resume() {}, dispose() { state.disposed = true },
      }
    },
    createAudio() {
      const generation = audio.length + 1
      const state = { stopped: false }
      audio.push(state)
      return {
        async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {},
        async pause() {}, async resume() {},
        async stop() {
          state.stopped = true
          if (generation === 2) await new Promise<void>(() => undefined)
        },
      }
    },
  })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const result = await withDeadline(controller.requestSceneChange('scene:two'))
  assert.equal(result.success, true)
  assert.equal(controller.getState().lifecycle, 'playing')
  assert.equal(controller.getState().sceneId, 'scene:one')
  assert.equal(physics.length, 3)
  assert.equal(physics[0]?.disposed, true)
  assert.equal(physics[1]?.disposed, true)
  assert.equal(physics[2]?.disposed, false)
  assert.equal(audio[0]?.stopped, true)
  assert.equal(audio[1]?.stopped, true)
  assert.equal(audio[2]?.stopped, false)
})

test('recursive Start failure preserves the exact prior scene and authorities', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const sceneThree = structuredClone(snapshot.scenes[1])
  sceneThree.sceneId = 'scene:three'
  sceneThree.name = 'Runtime three'
  const cameraThree = sceneThree.entities[0]!
  cameraThree.id = 'entity:camera-three'
  cameraThree.name = 'Camera three'
  const cameraComponent = cameraThree.components.find((component) => component.type === 'camera')
  const listenerComponent = cameraThree.components.find((component) => component.type === 'audio-listener')
  if (cameraComponent?.type !== 'camera' || listenerComponent?.type !== 'audio-listener') {
    throw new Error('Third scene camera fixture is unavailable.')
  }
  cameraComponent.id = 'component:camera-three'
  listenerComponent.id = 'component:listener-three'
  cameraThree.components.push({
    id: 'component:scene-three-start', type: 'behavior', enabled: true,
    bindings: [{
      id: 'binding:scene-three-start', event: { type: 'start' }, actions: [{
        type: 'set-component-property', entityId: 'entity:camera-three', componentId: 'component:camera-three',
        componentType: 'camera', property: 'primary', value: false,
      }],
    }],
  })
  snapshot.project.scenes.push({
    id: 'scene:three', name: 'Runtime three', documentPath: 'Worlds/runtime/scenes/three.world-scene.json',
  })
  snapshot.scenes.push(sceneThree)
  addSceneTwoStartBehavior(snapshot, [{ type: 'change-scene', sceneId: 'scene:three' }])
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const { controller, physics, audio } = createHarness()
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const before = controller.getState()
  const published: string[] = []
  controller.subscribe(() => {
    const state = controller.getState()
    published.push(`${state.lifecycle}:${state.sceneId ?? 'none'}`)
  })
  const result = await controller.requestSceneChange('scene:two')
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-behavior-state-invalid')
  const after = controller.getState()
  assert.equal(after.lifecycle, 'playing')
  assert.equal(after.sceneId, before.sceneId)
  assert.equal(after.generationId, before.generationId)
  assert.equal(after.runtimeSnapshot, before.runtimeSnapshot)
  assert.equal(published.includes('playing:scene:two'), false)
  assert.equal(published.includes('playing:scene:three'), false)
  assert.equal(physics[0]?.disposed, false)
  assert.equal(physics.length, 1)
  assert.equal(audio[0]?.stopped, false)
  assert.equal(audio.length, 1)
})

test('replacement settles before Stop even when the prior audio shutdown tail stalls', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const physics: Array<{ disposed: boolean }> = []
  const audio: Array<{ stopped: boolean }> = []
  const priorClosure = deferredClosure()
  let priorStopCalls = 0
  const controller = createWorldPlayController({
    createPhysics() {
      const state = { disposed: false }
      physics.push(state)
      return {
        async initialize() {}, step() {}, pause() {}, resume() {}, dispose() { state.disposed = true },
      }
    },
    createAudio() {
      const generation = audio.length + 1
      const state = { stopped: false }
      audio.push(state)
      return {
        async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {},
        async pause() {}, async resume() {},
        async stop() {
          state.stopped = true
          if (generation === 1) {
            priorStopCalls += 1
            if (priorStopCalls === 1) await priorClosure.promise
          }
        },
      }
    },
  })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const switching = controller.requestSceneChange('scene:two')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getState().sceneId, 'scene:two')
  assert.equal(controller.getState().lifecycle, 'playing')
  const result = await withDeadline(switching)
  assert.equal(result.success, true)
  let settled = false
  const stopping = controller.stop().then((stopResult) => { settled = true; return stopResult })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(controller.getState().lifecycle, 'stopping')
  assert.equal(priorStopCalls, 1)
  priorClosure.resolve()
  assert.equal((await stopping).success, true)
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(physics.every((runtime) => runtime.disposed), true)
  assert.equal(audio.every((authority) => authority.stopped), true)
})

test('retired Worker failure cannot stall or tear down the terminal scene when prior audio shutdown stalls', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const physics: Array<{ handlers: WorldPhysicsRuntimeHandlers; disposed: boolean }> = []
  const audio: Array<{ stopped: boolean }> = []
  const controller = createWorldPlayController({
    createPhysics(_generationId, handlers) {
      const state = { handlers, disposed: false }
      physics.push(state)
      return {
        async initialize() {}, step() {}, pause() {}, resume() {}, dispose() { state.disposed = true },
      }
    },
    createAudio() {
      const generation = audio.length + 1
      const state = { stopped: false }
      audio.push(state)
      return {
        async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {},
        async pause() {}, async resume() {},
        async stop() {
          state.stopped = true
          if (generation === 1) await new Promise<void>(() => undefined)
        },
      }
    },
  })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const switching = controller.requestSceneChange('scene:two')
  await new Promise((resolve) => setImmediate(resolve))
  physics[0]?.handlers.onError?.({ code: 'late-worker-error', message: 'Retired Rapier failed.' })
  const result = await withDeadline(switching)
  assert.equal(result.success, true)
  assert.equal(controller.getState().lifecycle, 'playing')
  assert.equal(controller.getState().sceneId, 'scene:two')
  assert.equal(controller.getState().failure, null)
  assert.equal(physics[0]?.disposed, true)
  assert.equal(physics[1]?.disposed, false)
  assert.equal(audio[0]?.stopped, true)
  assert.equal(audio[1]?.stopped, false)
})

test('Start failure cleanup settles when the candidate audio stop stalls', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.scenes[1].entities[0].components.push({
    id: 'component:scene-two-audio', type: 'audio-source', enabled: true, resourceId: 'resource:beep',
    autoplay: false, loop: false, volume: 1, spatial: false, maxDistance: 20,
  })
  addSceneTwoStartBehavior(snapshot, [
    { type: 'play-audio', entityId: 'entity:camera-two', componentId: 'component:scene-two-audio' },
  ])
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const audio: Array<{ stopped: boolean }> = []
  const controller = createWorldPlayController({
    createPhysics() {
      return { async initialize() {}, step() {}, pause() {}, resume() {}, dispose() {} }
    },
    createAudio() {
      const generation = audio.length + 1
      const state = { stopped: false }
      audio.push(state)
      return {
        async prepareScene() {}, async activate() {},
        async play() { if (generation === 2) throw new Error('Candidate Start audio failed.') }, async stopSource() {},
        update() {}, async pause() {}, async resume() {},
        async stop() {
          state.stopped = true
          if (generation === 2) await new Promise<void>(() => undefined)
        },
      }
    },
  })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const before = controller.getState()
  const result = await withDeadline(controller.requestSceneChange('scene:two'))
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-start-failed')
  assert.equal(controller.getState().sceneId, before.sceneId)
  assert.equal(controller.getState().runtimeSnapshot, before.runtimeSnapshot)
  assert.equal(audio[0]?.stopped, false)
  assert.equal(audio[1]?.stopped, true)
})

test('Stop cancels a replacement stalled in a Start audio effect', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.scenes[1].entities[0].components.push({
    id: 'component:scene-two-audio', type: 'audio-source', enabled: true, resourceId: 'resource:beep',
    autoplay: false, loop: false, volume: 1, spatial: false, maxDistance: 20,
  })
  addSceneTwoStartBehavior(snapshot, [
    { type: 'play-audio', entityId: 'entity:camera-two', componentId: 'component:scene-two-audio' },
  ])
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const audio: Array<{ stopped: boolean }> = []
  const controller = createWorldPlayController({
    createPhysics() {
      return { async initialize() {}, step() {}, pause() {}, resume() {}, dispose() {} }
    },
    createAudio() {
      const generation = audio.length + 1
      const state = { stopped: false }
      audio.push(state)
      return {
        async prepareScene() {}, async activate() {},
        async play() { if (generation === 2) await new Promise<void>(() => undefined) }, async stopSource() {},
        update() {}, async pause() {}, async resume() {}, async stop() { state.stopped = true },
      }
    },
  })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const switching = controller.requestSceneChange('scene:two')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getState().lifecycle, 'loading')
  assert.equal((await controller.stop()).success, true)
  const result = await withDeadline(switching)
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-load-cancelled')
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(audio[1]?.stopped, true)
})

test('active Worker failure cancels a replacement stalled in a Start audio effect', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.scenes[1].entities[0].components.push({
    id: 'component:scene-two-audio', type: 'audio-source', enabled: true, resourceId: 'resource:beep',
    autoplay: false, loop: false, volume: 1, spatial: false, maxDistance: 20,
  })
  addSceneTwoStartBehavior(snapshot, [
    { type: 'play-audio', entityId: 'entity:camera-two', componentId: 'component:scene-two-audio' },
  ])
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  const physics: Array<{ handlers: WorldPhysicsRuntimeHandlers; disposed: boolean }> = []
  const audio: Array<{ stopped: boolean }> = []
  const controller = createWorldPlayController({
    createPhysics(_generationId, handlers) {
      const state = { handlers, disposed: false }
      physics.push(state)
      return {
        async initialize() {}, step() {}, pause() {}, resume() {}, dispose() { state.disposed = true },
      }
    },
    createAudio() {
      const generation = audio.length + 1
      const state = { stopped: false }
      audio.push(state)
      return {
        async prepareScene() {}, async activate() {},
        async play() { if (generation === 2) await new Promise<void>(() => undefined) }, async stopSource() {},
        update() {}, async pause() {}, async resume() {}, async stop() { state.stopped = true },
      }
    },
  })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const switching = controller.requestSceneChange('scene:two')
  await new Promise((resolve) => setImmediate(resolve))
  physics[0]?.handlers.onError?.({ code: 'worker-error', message: 'Active Rapier failed.' })
  const result = await withDeadline(switching)
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-load-cancelled')
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(controller.getState().failure?.message, 'Active Rapier failed.')
  assert.equal(physics.every((runtime) => runtime.disposed), true)
  assert.equal(audio.every((authority) => authority.stopped), true)
})

test('Start impulse failure is returned before publishing the prepared generation', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  behavior.bindings.push({
    id: 'binding:start-impulse', event: { type: 'start' },
    actions: [{ type: 'apply-impulse', entityId: 'entity:crate', impulse: [1, 0, 0] }],
  })
  const editor = createWorldEditorSession(snapshot)
  if (!editor.success) throw new Error('Runtime editor fixture is invalid.')
  let disposed = false
  let audioStopped = false
  const controller = createWorldPlayController({
    createPhysics() {
      return {
        async initialize() {},
        step() { throw new Error('Start impulse failed.') },
        pause() {}, resume() {}, dispose() { disposed = true },
      }
    },
    createAudio: () => ({
      async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {},
      async pause() {}, async resume() {}, async stop() { audioStopped = true },
    }),
  })
  const published: string[] = []
  controller.subscribe(() => {
    const state = controller.getState()
    published.push(`${state.lifecycle}:${state.sceneId ?? 'none'}`)
  })
  const result = await controller.start(editor.session, 'scene:one')
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-start-failed')
  assert.equal(result.success ? '' : result.issues[0]?.message, 'Start impulse failed.')
  assert.equal(published.includes('playing:scene:one'), false)
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(disposed, true)
  assert.equal(audioStopped, true)
})

test('non-live property bindings abort before Worker or audio creation', async () => {
  for (const scenario of ['physics-authority', 'gaussian-capability', 'disabled-physics-authority'] as const) {
    const snapshot = createRuntimeWorldSnapshot()
    if (scenario === 'gaussian-capability') {
      snapshot.project.resources.push({ id: 'resource:gaussian', type: 'model', name: 'Gaussian', workspacePath: 'Assets/gaussian.ply', format: 'gaussian-ply' })
      snapshot.scenes[0].entities.push({
        id: 'entity:gaussian', name: 'Gaussian', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ id: 'component:gaussian-renderable', type: 'renderable', enabled: true, resourceId: 'resource:gaussian', visible: true, castShadow: false, receiveShadow: false, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } }],
      })
    }
    const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
    if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
    if (scenario === 'disabled-physics-authority') behavior.enabled = false
    behavior.bindings[0]!.actions = [scenario !== 'gaussian-capability' ? {
      type: 'set-component-property', entityId: 'entity:crate', componentId: 'component:crate-body',
      componentType: 'rigid-body', property: 'gravityScale', value: 0,
    } : {
      type: 'set-component-property', entityId: 'entity:gaussian', componentId: 'component:gaussian-renderable',
      componentType: 'renderable', property: 'material.baseColor', value: '#ff0000',
    }]
    const editor = createWorldEditorSession(snapshot)
    assert.equal(editor.success, true)
    if (!editor.success) continue
    let physicsFactories = 0
    let audioFactories = 0
    const controller = createWorldPlayController({
      createPhysics() {
        physicsFactories += 1
        throw new Error('Physics factory must not run after Play preflight failure.')
      },
      createAudio() {
        audioFactories += 1
        throw new Error('Audio factory must not run after Play preflight failure.')
      },
    })
    const result = await controller.start(editor.session, 'scene:one')
    const expectedCode = scenario !== 'gaussian-capability'
      ? 'runtime-property-authority-unsupported'
      : 'runtime-property-presentation-unsupported'
    assert.equal(result.success, false)
    assert.equal(result.success ? '' : result.issues[0]?.code, expectedCode)
    assert.equal(result.success ? '' : result.issues[0]?.path, 'scenes.entities[0].components[3].bindings[0].actions[0].property')
    assert.equal(physicsFactories, 0)
    assert.equal(audioFactories, 0)
    assert.equal(controller.getState().lifecycle, 'edit')
    assert.equal(controller.getState().failure?.code, expectedCode)
  }
})

test('four recovery ticks keep each timer impulse beside its Rapier substep', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  behavior.bindings.push({
    id: 'binding:impulse-timer',
    event: { type: 'timer', delaySeconds: 1 / 60, repeat: true },
    actions: [{ type: 'apply-impulse', entityId: 'entity:crate', impulse: [1, 0, 0] }],
  })
  const editor = createWorldEditorSession(snapshot)
  assert.equal(editor.success, true)
  if (!editor.success) return
  const { controller, physics } = createHarness()
  await controller.start(editor.session, 'scene:one')
  const sampler = new WorldInputSampler(snapshot.project.inputActions)
  await controller.advance(0, sampler.sample())
  await controller.advance(4 * 1000 / 60, sampler.sample())
  assert.equal(physics[0]?.steps.length, 1)
  assert.deepEqual(physics[0]?.steps[0]?.steps.map((step) => step.impulses.map((impulse) => impulse.impulse[0])), [[1], [1], [1], [1]])
})

test('physics parent snapshots propagate to render and camera-listener descendants', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const camera = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:camera')!
  camera.parentId = 'entity:crate'
  camera.transform = { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
  snapshot.scenes[0].entities.push({
    id: 'entity:crate-child', name: 'Crate child', parentId: 'entity:crate', enabled: true, locked: false, tags: [],
    transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [],
  })
  const editor = createWorldEditorSession(snapshot)
  assert.equal(editor.success, true)
  if (!editor.success) return
  const { controller, physics, audio } = createHarness()
  await controller.start(editor.session, 'scene:one')
  physics[0]?.handlers.onSnapshot({
    generationId: 1,
    sequence: 1,
    entityIds: ['entity:crate'],
    transforms: new Float32Array([10, 4, 0, 0, 0, 0, 1]),
    triggerEvents: [],
  })
  const updated = audio[0]?.updated.at(-1) ?? []
  assert.deepEqual(updated.find((pose) => pose.entityId === 'entity:crate-child')?.position, [11, 4, 0])
  assert.deepEqual(updated.find((pose) => pose.entityId === 'entity:camera')?.position, [10, 6, 0])
})

test('initial runtime failures return to edit with exact editor identity and a visible failure', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  assert.equal(editor.success, true)
  if (!editor.success) return
  const { controller, physics, audio } = createHarness({ rejectInitializeGeneration: 1 })
  const result = await controller.start(editor.session, 'scene:one')
  assert.equal(result.success, false)
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(controller.getState().editor, editor.session)
  assert.equal(controller.getState().runtimeSnapshot, null)
  assert.equal(controller.getState().failure?.code, 'runtime-load-failed')
  assert.equal(physics[0]?.disposed, true)
  assert.equal(audio[0]?.stopped, true)
})

test('factory and activation failures are returned instead of rejecting public Play', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  assert.equal(editor.success, true)
  if (!editor.success) return
  const factoryController = createWorldPlayController({
    createPhysics() { throw new Error('Worker construction failed.') },
    createAudio() { throw new Error('Audio should not be constructed.') },
  })
  const factoryResult = await factoryController.start(editor.session, 'scene:one')
  assert.equal(factoryResult.success, false)
  assert.match(factoryResult.success ? '' : factoryResult.issues[0]?.message ?? '', /Worker construction failed/)
  assert.equal(factoryController.getState().lifecycle, 'edit')

  const activated = createHarness({ rejectActivationGeneration: 1 })
  const activationResult = await activated.controller.start(editor.session, 'scene:one')
  assert.equal(activationResult.success, false)
  assert.match(activationResult.success ? '' : activationResult.issues[0]?.message ?? '', /Audio 1 failed/)
  assert.equal(activated.controller.getState().lifecycle, 'edit')
  assert.equal(activated.physics[0]?.disposed, true)
  assert.equal(activated.audio[0]?.stopped, true)
})

test('active Worker failure is generation-gated and returns Play to edit', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  assert.equal(editor.success, true)
  if (!editor.success) return
  const { controller, physics } = createHarness()
  await controller.start(editor.session, 'scene:one')
  physics[0]?.handlers.onError?.({ code: 'worker-error', message: 'Rapier crashed.' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(controller.getState().failure?.message, 'Rapier crashed.')
  const failure = controller.getState().failure
  physics[0]?.handlers.onError?.({ code: 'late-error', message: 'Late.' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getState().failure, failure)
})

test('replacement load failure preserves the previous active scene and authorities', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  assert.equal(editor.success, true)
  if (!editor.success) return
  const { controller, physics, audio } = createHarness({ rejectInitializeGeneration: 2 })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const result = await controller.requestSceneChange('scene:two')
  assert.equal(result.success, false)
  assert.equal(controller.getState().lifecycle, 'playing')
  assert.equal(controller.getState().sceneId, 'scene:one')
  assert.equal(physics[0]?.disposed, false)
  assert.equal(physics[1]?.disposed, true)
  assert.equal(audio[0]?.stopped, false)
  assert.equal(audio[1]?.stopped, true)
})

test('Stop cancels deferred initialization without surfacing a late Worker failure', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  assert.equal(editor.success, true)
  if (!editor.success) return
  let rejectInitialization: ((error: Error) => void) | null = null
  const captured: { handlers?: WorldPhysicsRuntimeHandlers } = {}
  const controller = createWorldPlayController({
    createPhysics(_generationId, nextHandlers) {
      captured.handlers = nextHandlers
      return {
        initialize: () => new Promise<void>((_resolve, reject) => { rejectInitialization = reject }),
        step() {}, pause() {}, resume() {},
        dispose() { rejectInitialization?.(new Error('initialization cancelled')) },
      }
    },
    createAudio: () => ({
      async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {},
      async pause() {}, async resume() {}, async stop() {},
    }),
  })
  const starting = controller.start(editor.session, 'scene:one')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getState().lifecycle, 'loading')
  assert.equal((await controller.stop()).success, true)
  const result = await starting
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-load-cancelled')
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(controller.getState().editor, editor.session)
  assert.equal(controller.getState().failure, null)
  captured.handlers?.onError?.({ code: 'late-error', message: 'Late.' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getState().failure, null)
})

test('Worker failure after ready cancels pending initial audio preparation or activation', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  assert.equal(editor.success, true)
  if (!editor.success) return
  for (const stalledPhase of ['prepare', 'activate'] as const) {
    const captured: { handlers?: WorldPhysicsRuntimeHandlers } = {}
    let disposed = false
    let audioStopped = false
    const controller = createWorldPlayController({
      createPhysics(_generationId, nextHandlers) {
        captured.handlers = nextHandlers
        return {
          async initialize() {}, step() {}, pause() {}, resume() {},
          dispose() { disposed = true },
        }
      },
      createAudio: () => ({
        async prepareScene() {
          if (stalledPhase === 'prepare') await new Promise<void>(() => undefined)
        },
        async activate() {
          if (stalledPhase === 'activate') await new Promise<void>(() => undefined)
        },
        async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {},
        async stop() { audioStopped = true },
      }),
    })
    const starting = controller.start(editor.session, 'scene:one')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(controller.getState().lifecycle, 'loading')
    const readyHandlers = captured.handlers
    if (!readyHandlers) throw new Error('Physics handlers were not captured.')
    readyHandlers.onError?.({ code: 'worker-error', message: `Rapier failed during ${stalledPhase}.` })
    const result = await withDeadline(starting)
    assert.equal(result.success, false)
    assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-load-failed')
    assert.equal(controller.getState().lifecycle, 'edit')
    assert.equal(controller.getState().failure?.message, `Rapier failed during ${stalledPhase}.`)
    assert.equal(disposed, true)
    assert.equal(audioStopped, true)
    const failure = controller.getState().failure
    readyHandlers.onError?.({ code: 'late-error', message: 'Late.' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(controller.getState().failure, failure)
  }
})

test('Worker failure after ready cancels replacement preparation or activation and preserves the active scene', async () => {
  const editor = createWorldEditorSession(createRuntimeWorldSnapshot())
  assert.equal(editor.success, true)
  if (!editor.success) return
  for (const stalledPhase of ['prepare', 'activate'] as const) {
    const physics: Array<{ handlers: WorldPhysicsRuntimeHandlers; disposed: boolean }> = []
    const audio: Array<{ stopped: boolean }> = []
    const controller = createWorldPlayController({
      createPhysics(_generationId, handlers) {
        const state = { handlers, disposed: false }
        physics.push(state)
        return {
          async initialize() {}, step() {}, pause() {}, resume() {},
          dispose() { state.disposed = true },
        }
      },
      createAudio() {
        const generation = audio.length + 1
        const state = { stopped: false }
        audio.push(state)
        return {
          async prepareScene() {
            if (generation === 2 && stalledPhase === 'prepare') await new Promise<void>(() => undefined)
          },
          async activate() {
            if (generation === 2 && stalledPhase === 'activate') await new Promise<void>(() => undefined)
          },
          async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {},
          async stop() { state.stopped = true },
        }
      },
    })
    assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
    const switching = controller.requestSceneChange('scene:two')
    await new Promise((resolve) => setImmediate(resolve))
    const pendingHandlers = physics[1]?.handlers
    if (!pendingHandlers) throw new Error('Replacement physics handlers were not captured.')
    pendingHandlers.onError?.({ code: 'worker-error', message: `Replacement Rapier failed during ${stalledPhase}.` })
    const result = await withDeadline(switching)
    assert.equal(result.success, false)
    assert.equal(controller.getState().lifecycle, 'playing')
    assert.equal(controller.getState().sceneId, 'scene:one')
    assert.equal(physics[0]?.disposed, false)
    assert.equal(physics[1]?.disposed, true)
    assert.equal(audio[0]?.stopped, false)
    assert.equal(audio[1]?.stopped, true)
    const state = controller.getState()
    pendingHandlers.onError?.({ code: 'late-error', message: 'Late.' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(controller.getState(), state)
  }
})

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Test deadline expired.')), 250)),
  ])
}

test('Play prepares canonical mesh collider geometry before creating physics or audio authorities', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:mesh', type: 'model', name: 'Mesh', workspacePath: 'Assets/mesh.glb', format: 'glb' })
  const ground = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:ground')!
  ground.components[0] = {
    id: 'component:ground-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'mesh', resourceId: 'resource:mesh',
    sensor: false, friction: 0.8, restitution: 0, collisionLayer: 1, collisionMask: 0xffff,
  }
  const editor = createWorldEditorSession(snapshot)
  assert.equal(editor.success, true)
  if (!editor.success) return
  const loaded: string[] = []
  const physicsScenes: WorldPhysicsSceneDto[] = []
  const controller = createWorldPlayController({
    geometry: {
      apiUrl: 'http://127.0.0.1:8000',
      async loadModelGeometry(request) {
        assert.equal(request.generationId, 1)
        loaded.push(request.url)
        return { success: true, resourceId: request.resourceId, format: request.format, byteLength: 48, meshes: [{ name: 'tri', vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), localMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], skinned: false, morphed: false, instanced: false }] }
      },
    },
    createPhysics() { return { async initialize(scene) { physicsScenes.push(scene) }, step() {}, pause() {}, resume() {}, dispose() {} } },
    createAudio: () => ({ async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {}, async stop() {} }),
  })
  const result = await controller.start(editor.session, 'scene:one')
  assert.equal(result.success, true)
  assert.deepEqual(loaded, ['http://127.0.0.1:8000/workspace/Assets/mesh.glb'])
  const shape = physicsScenes[0]?.bodies.find((body) => body.entityId === 'entity:ground')?.colliders[0]?.shape
  assert.equal(shape?.kind, 'trimesh')
})

test('bad Start-chain mesh geometry creates zero physics or audio authorities', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:bad-mesh', type: 'model', name: 'Bad Mesh', workspacePath: 'Assets/bad.glb', format: 'glb' })
  snapshot.scenes[1].entities.push({
    id: 'entity:bad-mesh', name: 'Bad Mesh', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: 'component:bad-mesh-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'mesh', resourceId: 'resource:bad-mesh', sensor: false, friction: 0, restitution: 0, collisionLayer: 1, collisionMask: 0xffff }],
  })
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  behavior.bindings[0]!.actions = [{ type: 'change-scene', sceneId: 'scene:two' }]
  const editor = createWorldEditorSession(snapshot)
  assert.equal(editor.success, true)
  if (!editor.success) return
  let physicsFactories = 0
  let audioFactories = 0
  const controller = createWorldPlayController({
    geometry: { apiUrl: 'http://127.0.0.1:8000', async loadModelGeometry(request) { return { success: false, resourceId: request.resourceId, code: 'unsupported-physics-geometry-source', message: 'bad mesh' } } },
    createPhysics() { physicsFactories += 1; return { async initialize() {}, step() {}, pause() {}, resume() {}, dispose() {} } },
    createAudio() { audioFactories += 1; return { async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {}, async stop() {} } },
  })
  const result = await controller.start(editor.session, 'scene:one')
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'unsupported-physics-geometry-source')
  assert.equal(physicsFactories, 0)
  assert.equal(audioFactories, 0)
  assert.equal(controller.getState().lifecycle, 'edit')
})

test('Stop aborts pending mesh geometry preparation and stale success cannot activate', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:mesh', type: 'model', name: 'Mesh', workspacePath: 'Assets/mesh.glb', format: 'glb' })
  const ground = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:ground')!
  ground.components[0] = { id: 'component:ground-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'mesh', resourceId: 'resource:mesh', sensor: false, friction: 0.8, restitution: 0, collisionLayer: 1, collisionMask: 0xffff }
  const editor = createWorldEditorSession(snapshot)
  assert.equal(editor.success, true)
  if (!editor.success) return
  const capturedSignal: { current: { aborted: boolean } | null } = { current: null }
  const resolveGeometry: { current: ((value: WorldPreparedGeometrySource) => void) | null } = { current: null }
  let physicsFactories = 0
  let audioFactories = 0
  const controller = createWorldPlayController({
    geometry: {
      apiUrl: 'http://127.0.0.1:8000',
      loadModelGeometry(_request, signal) {
        capturedSignal.current = signal
        return new Promise((resolve) => { resolveGeometry.current = resolve })
      },
    },
    createPhysics() { physicsFactories += 1; return { async initialize() {}, step() {}, pause() {}, resume() {}, dispose() {} } },
    createAudio() { audioFactories += 1; return { async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {}, async stop() {} } },
  })
  const starting = controller.start(editor.session, 'scene:one')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controller.getState().lifecycle, 'loading')
  assert.equal((await controller.stop()).success, true)
  assert.equal(capturedSignal.current?.aborted, true)
  resolveGeometry.current?.({ success: true, resourceId: 'resource:mesh', format: 'glb', byteLength: 48, meshes: [{ name: 'tri', vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), localMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], skinned: false, morphed: false, instanced: false }] })
  const result = await withDeadline(starting)
  assert.equal(result.success, false)
  assert.equal(result.success ? '' : result.issues[0]?.code, 'runtime-load-cancelled')
  assert.equal(controller.getState().lifecycle, 'edit')
  assert.equal(physicsFactories, 0)
  assert.equal(audioFactories, 0)
})

test('presentation-only behavior remains valid on a scene with an unchanged prepared mesh collider', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:mesh', type: 'model', name: 'Mesh', workspacePath: 'Assets/mesh.glb', format: 'glb' })
  const ground = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:ground')!
  ground.components[0] = { id: 'component:ground-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'mesh', resourceId: 'resource:mesh', sensor: false, friction: 0.8, restitution: 0, collisionLayer: 1, collisionMask: 0xffff }
  const behavior = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'behavior')
  if (behavior?.type !== 'behavior') throw new Error('Runtime behavior fixture is unavailable.')
  const inputBinding = behavior.bindings.find((binding) => binding.event.type === 'input')
  if (!inputBinding) throw new Error('Runtime input binding fixture is unavailable.')
  inputBinding.actions = [{ type: 'set-component-property', entityId: 'entity:hero', componentId: 'component:hero-renderable', componentType: 'renderable', property: 'material.opacity', value: 0.5 }]
  const editor = createWorldEditorSession(snapshot)
  assert.equal(editor.success, true)
  if (!editor.success) return
  let geometryLoads = 0
  const controller = createWorldPlayController({
    geometry: { apiUrl: 'http://127.0.0.1:8000', async loadModelGeometry(request) { geometryLoads += 1; return { success: true, resourceId: request.resourceId, format: request.format, byteLength: 48, meshes: [{ name: 'tri', vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), localMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], skinned: false, morphed: false, instanced: false }] } } },
    createPhysics() { return { async initialize() {}, step() {}, pause() {}, resume() {}, dispose() {} } },
    createAudio: () => ({ async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {}, async stop() {} }),
  })
  assert.equal((await controller.start(editor.session, 'scene:one')).success, true)
  const sampler = new WorldInputSampler(snapshot.project.inputActions)
  sampler.setControl('keyboard', 'Space', 1)
  await controller.advance(0, sampler.sample())
  const result = await controller.advance(1000 / 60, sampler.sample())
  assert.equal(result.success, true)
  assert.equal(geometryLoads, 1)
  const hero = controller.getState().runtimeSnapshot?.scenes[0].entities.find((entity) => entity.id === 'entity:hero')
  const renderable = hero?.components.find((component) => component.type === 'renderable')
  assert.equal(renderable?.type === 'renderable' ? renderable.material.opacity : undefined, 0.5)
})
