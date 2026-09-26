import assert from 'node:assert/strict'
import test from 'node:test'

import { applyWorldCommandBatch } from '../core/worldCommands.ts'
import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import { validateWorldProjectSnapshot } from '../core/worldDocuments.ts'
import type { WorldProjectSnapshotV1, WorldSequence } from '../core/worldModel.ts'
import type { WorldProjectsApi, WorldProjectCommandRequest } from '../../../shared/types/worldProjects.ts'
import { buildCreateWorldSequenceCommand } from './worldTimelineModel.ts'
import { createWorldEditorController } from './worldEditorController.ts'
import {
  createWorldTimelinePreviewController,
  createWorldTimelinePreviewFrame,
  type WorldTimelineAnimationFrameDriver,
} from './worldTimelinePreview.ts'

function createTimelineSnapshot(): WorldProjectSnapshotV1 {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources.push(
    { id: 'resource:motion', type: 'animation', name: 'Motion', workspacePath: 'Assets/motion.pose.json', format: 'pose-clip', sourceWorkspacePath: 'Assets/hero.glb' },
    { id: 'resource:audio', type: 'audio', name: 'Audio', workspacePath: 'Assets/audio.wav', format: 'wav' },
  )
  const scene = snapshot.scenes[0]
  scene.entities[0].components.push(
    { id: 'component:motion', type: 'animation-player', enabled: true, resourceId: 'resource:motion', autoplay: false, loop: true, speed: 1 },
    { id: 'component:audio', type: 'audio-source', enabled: true, resourceId: 'resource:audio', autoplay: false, loop: false, volume: 1, spatial: false, maxDistance: 20 },
    { id: 'component:light', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 1, range: 10, castShadow: false },
  )
  scene.entities.push(
    {
      id: 'entity:camera-a', name: 'Camera A', parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ id: 'component:camera-a', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 }],
    },
    {
      id: 'entity:camera-b', name: 'Camera B', parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [8, 4, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
      components: [{ id: 'component:camera-b', type: 'camera', enabled: true, projection: 'orthographic', primary: false, near: 0.1, far: 100, orthographicSize: 8 }],
    },
  )
  scene.sequences.push(createSequence())
  return snapshot
}

function createSequence(): WorldSequence {
  return {
    id: 'sequence:preview', name: 'Preview', duration: { numerator: 2, denominator: 1 }, tracks: [
      { id: 'track:transform', type: 'transform', entityId: 'entity:hero', keyframes: [
        { id: 'key:transform-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: { position: [0, 0, 0] } },
        { id: 'key:transform-2', time: { numerator: 2, denominator: 1 }, value: { position: [4, 2, 0] } },
      ] },
      { id: 'track:opacity', type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity', keyframes: [
        { id: 'key:opacity-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 1 },
        { id: 'key:opacity-2', time: { numerator: 2, denominator: 1 }, value: 0.2 },
      ] },
      { id: 'track:light', type: 'light', entityId: 'entity:hero', componentId: 'component:light', property: 'intensity', keyframes: [
        { id: 'key:light-0', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: 1 },
        { id: 'key:light-2', time: { numerator: 2, denominator: 1 }, value: 5 },
      ] },
      { id: 'track:camera-a', type: 'camera', entityId: 'entity:camera-a', keyframes: [
        { id: 'key:camera-a-0', time: { numerator: 0, denominator: 1 }, interpolation: 'step', value: true },
        { id: 'key:camera-a-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', value: false },
      ] },
      { id: 'track:camera-b', type: 'camera', entityId: 'entity:camera-b', keyframes: [
        { id: 'key:camera-b-0', time: { numerator: 0, denominator: 1 }, interpolation: 'step', value: false },
        { id: 'key:camera-b-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', value: true },
      ] },
      { id: 'track:animation', type: 'animation', entityId: 'entity:hero', componentId: 'component:motion', keyframes: [
        { id: 'key:animation-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', value: true },
      ] },
      { id: 'track:audio', type: 'audio', entityId: 'entity:hero', componentId: 'component:audio', keyframes: [
        { id: 'key:audio-1', time: { numerator: 1, denominator: 1 }, interpolation: 'step', value: true },
      ] },
      { id: 'track:event', type: 'event', keyframes: [
        { id: 'key:event-half', time: { numerator: 1, denominator: 2 }, interpolation: 'step', eventId: 'event:half' },
        { id: 'key:event-one', time: { numerator: 1, denominator: 1 }, interpolation: 'step', eventId: 'event:one' },
      ] },
    ],
  }
}

test('builds an immutable evaluated scene clone with transform, light, property, media, and primary-camera state', () => {
  const snapshot = createTimelineSnapshot()
  const before = JSON.stringify(snapshot)
  const frame = createWorldTimelinePreviewFrame({
    snapshot,
    sceneId: 'scene:one',
    sequenceId: 'sequence:preview',
    time: { numerator: 1, denominator: 1 },
    mode: 'seek',
  })

  assert.equal(JSON.stringify(snapshot), before)
  assert.notEqual(frame.snapshot, snapshot)
  const scene = frame.snapshot.scenes[0]
  assert.deepEqual(scene.entities.find((entity) => entity.id === 'entity:hero')?.transform.position, [2, 1, 0])
  const hero = scene.entities.find((entity) => entity.id === 'entity:hero')
  assert.equal(hero?.components.find((component) => component.id === 'component:hero-renderable')?.type, 'renderable')
  assert.equal((hero?.components.find((component) => component.id === 'component:hero-renderable') as { material?: { opacity?: number } })?.material?.opacity, 0.6)
  assert.equal((hero?.components.find((component) => component.id === 'component:light') as { intensity?: number })?.intensity, 3)
  assert.deepEqual(frame.animationStates, [{ entityId: 'entity:hero', componentId: 'component:motion', playing: true }])
  assert.deepEqual(frame.audioStates, [{ entityId: 'entity:hero', componentId: 'component:audio', playing: true }])
  assert.equal(frame.activeCamera?.entityId, 'entity:camera-b')
  assert.equal(frame.activeCamera?.component.projection, 'orthographic')
  assert.equal(frame.activeCamera?.component.orthographicSize, 8)
  assert.deepEqual(frame.markers, [], 'seek and scrub must never expose event crossings')
})

test('rAF preview uses exact frame rationals, exposes forward markers, pauses without catch-up, and stops cleanly', () => {
  let nextHandle = 0
  const callbacks = new Map<number, (timestampMs: number) => void>()
  const cancelled: number[] = []
  const driver: WorldTimelineAnimationFrameDriver = {
    request(callback) {
      const handle = ++nextHandle
      callbacks.set(handle, callback)
      return handle
    },
    cancel(handle) {
      callbacks.delete(handle)
      cancelled.push(handle)
    },
  }
  const fire = (timestampMs: number) => {
    const entry = [...callbacks.entries()][0]
    assert.ok(entry, 'expected a scheduled animation frame')
    callbacks.delete(entry[0])
    entry[1](timestampMs)
  }
  const snapshot = createTimelineSnapshot()
  const controller = createWorldTimelinePreviewController(driver)
  const input = { snapshot, sceneId: 'scene:one', sequenceId: 'sequence:preview', fps: 30 as const }

  controller.play(input)
  assert.equal(controller.getState().lifecycle, 'playing')
  assert.deepEqual(controller.getState().frame?.time, { numerator: 0, denominator: 1 })
  fire(1_000)
  fire(1_500)
  assert.deepEqual(controller.getState().frame?.time, { numerator: 1, denominator: 2 })
  assert.deepEqual(controller.getState().frame?.markers.map((marker) => marker.eventId), ['event:half'])

  controller.pause()
  const pausedTime = controller.getState().frame?.time
  assert.equal(controller.getState().lifecycle, 'paused')
  assert.equal(callbacks.size, 0)
  controller.play(input)
  fire(10_000)
  assert.deepEqual(controller.getState().frame?.time, pausedTime, 'resume baseline must not include paused wall time')
  fire(10_100)
  assert.deepEqual(controller.getState().frame?.time, { numerator: 3, denominator: 5 })

  controller.seek(input, { numerator: 1, denominator: 1 })
  assert.equal(controller.getState().lifecycle, 'paused')
  assert.deepEqual(controller.getState().frame?.time, { numerator: 1, denominator: 1 })
  assert.deepEqual(controller.getState().frame?.markers, [])
  controller.stop()
  assert.deepEqual(controller.getState(), { lifecycle: 'stopped', frame: null })
  assert.ok(cancelled.length > 0)
  controller.dispose()
})

test('rAF preview clamps hostile wall-clock jumps to the exact sequence end', () => {
  const callbacks: Array<(timestampMs: number) => void> = []
  const driver: WorldTimelineAnimationFrameDriver = {
    request(callback) {
      callbacks.push(callback)
      return callbacks.length
    },
    cancel() {},
  }
  const controller = createWorldTimelinePreviewController(driver)
  controller.play({ snapshot: createTimelineSnapshot(), sceneId: 'scene:one', sequenceId: 'sequence:preview', fps: 60 })
  callbacks.shift()?.(0)
  assert.doesNotThrow(() => callbacks.shift()?.(Number.MAX_VALUE))
  assert.equal(controller.getState().lifecycle, 'paused')
  assert.deepEqual(controller.getState().frame?.time, { numerator: 2, denominator: 1 })
})

test('preview performs zero gateway writes while explicit timeline edits persist and remain Undo/Redo authoritative', async () => {
  let repositorySnapshot = createTimelineSnapshot()
  repositorySnapshot.scenes[0].sequences = []
  assert.equal(validateWorldProjectSnapshot(repositorySnapshot).success, true, JSON.stringify(validateWorldProjectSnapshot(repositorySnapshot)))
  const applyRequests: WorldProjectCommandRequest[] = []
  const api: WorldProjectsApi = {
    async create() { return { ok: true, value: { projectKey: `world-${'a'.repeat(32)}`, snapshot: structuredClone(repositorySnapshot), durabilityWarnings: [] } } },
    async list() { return { ok: true, value: { projects: [], issues: [] } } },
    async open() { return { ok: true, value: { status: 'ready', projectKey: `world-${'a'.repeat(32)}`, snapshot: structuredClone(repositorySnapshot), durabilityWarnings: [] } } },
    async previewCommands(request) { return apply(request, false) },
    async applyCommands(request) {
      applyRequests.push(structuredClone(request))
      return apply(request, true)
    },
    async delete(request) { return { ok: true, value: { projectKey: request.projectKey, transactionId: request.transactionId, idempotent: false } } },
  }
  function apply(request: WorldProjectCommandRequest, persist: boolean) {
    const result = applyWorldCommandBatch(repositorySnapshot, request.batch)
    assert.equal(result.success, true, JSON.stringify(result))
    if (!result.success) throw new Error('fixture command failed')
    if (persist) repositorySnapshot = structuredClone(result.snapshot)
    return {
      ok: true as const,
      value: {
        projectKey: `world-${'a'.repeat(32)}`,
        snapshot: structuredClone(result.snapshot),
        newRevision: result.snapshot.project.revision,
        idempotent: false,
        changes: result.changes,
        warnings: result.warnings,
        inverse: structuredClone(result.inverse),
        receipt: { transactionId: request.batch.transactionId, payloadSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), appliedRevision: result.snapshot.project.revision },
      },
    }
  }

  const controller = createWorldEditorController(api)
  const openedResult = await controller.openProject(`world-${'a'.repeat(32)}`)
  assert.equal(openedResult.ok, true, JSON.stringify(openedResult))
  const opened = controller.getState().session
  assert.ok(opened)
  const documentBefore = JSON.stringify(opened.snapshot)
  const preview = createWorldTimelinePreviewController({ request: () => 1, cancel: () => undefined })
  const previewSnapshot = createTimelineSnapshot()
  preview.play({ snapshot: previewSnapshot, sceneId: 'scene:one', sequenceId: 'sequence:preview', fps: 30 })
  preview.seek({ snapshot: previewSnapshot, sceneId: 'scene:one', sequenceId: 'sequence:preview', fps: 30 }, { numerator: 1, denominator: 1 })
  preview.stop()
  assert.equal(applyRequests.length, 0)
  assert.equal(JSON.stringify(controller.getState().session?.snapshot), documentBefore)

  const command = buildCreateWorldSequenceCommand({ snapshot: opened.snapshot, sceneId: 'scene:one' }, {
    id: 'sequence:persisted', name: 'Persisted', duration: { numerator: 5, denominator: 1 },
  })
  assert.equal((await controller.dispatchCommands({ transactionId: 'tx:timeline-create', origin: 'ui', commands: [command] })).ok, true)
  assert.equal(controller.getState().session?.snapshot.scenes[0].sequences[0]?.id, 'sequence:persisted')
  assert.equal((await controller.undo()).ok, true)
  assert.equal(controller.getState().session?.snapshot.scenes[0].sequences.length, 0)
  assert.equal((await controller.redo()).ok, true)
  assert.equal(controller.getState().session?.snapshot.scenes[0].sequences[0]?.id, 'sequence:persisted')
  assert.deepEqual(applyRequests.map((request) => request.batch.origin), ['ui', 'undo', 'redo'])
})
