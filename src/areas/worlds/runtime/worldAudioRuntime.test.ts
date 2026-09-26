import assert from 'node:assert/strict'
import test from 'node:test'

import { validateWorldProjectSnapshot } from '../core/worldDocuments.ts'
import { createRuntimeWorldSnapshot, nestRuntimeCameraUnderDisabledParent } from './_testFixtures.ts'
import { WebAudioWorldAuthority } from './worldAudioRuntime.ts'

test('Web Audio authority owns pause/resume and disconnects sources on Stop', async () => {
  const calls: string[] = []
  const source = {
    buffer: null, loop: false,
    connect() { calls.push('source:connect'); return this },
    disconnect() { calls.push('source:disconnect') },
    start() { calls.push('source:start') },
    stop() { calls.push('source:stop') },
    addEventListener() {},
  }
  const gain = { gain: { value: 1 }, connect() { calls.push('gain:connect'); return this }, disconnect() { calls.push('gain:disconnect') } }
  const context = {
    state: 'running', currentTime: 0, destination: {}, listener: {},
    createBufferSource: () => source,
    createGain: () => gain,
    decodeAudioData: async () => ({ duration: 1 }),
    suspend: async () => { calls.push('suspend') },
    resume: async () => { calls.push('resume') },
    close: async () => { calls.push('close') },
  }
  const authority = new WebAudioWorldAuthority({
    createContext: () => context as never,
    fetchArrayBuffer: async () => new ArrayBuffer(8),
    resolveResourceUrl: (path) => `workspace://${path}`,
  })
  await authority.prepareScene(createRuntimeWorldSnapshot(), 'scene:one')
  await authority.activate()
  await authority.play('component:beep')
  await authority.pause()
  await authority.resume()
  await authority.stop()
  assert.deepEqual(calls.filter((call) => call === 'suspend' || call === 'resume' || call === 'close'), ['suspend', 'resume', 'close'])
  assert.equal(calls.includes('source:stop'), true)
  assert.equal(calls.includes('source:disconnect'), true)
  assert.equal(calls.includes('gain:disconnect'), true)
})

test('Web Audio authority stops only the requested source without ending the session', async () => {
  let stopped = 0
  let started = 0
  const context = {
    state: 'running', currentTime: 0, destination: {}, listener: {},
    createBufferSource: () => ({
      buffer: null, loop: false, connect() { return this }, disconnect() {},
      start() { started += 1 }, stop() { stopped += 1 }, addEventListener() {},
    }),
    createGain: () => ({ gain: { value: 1 }, connect() { return this }, disconnect() {} }),
    decodeAudioData: async () => ({ duration: 1 }),
    suspend: async () => undefined, resume: async () => undefined, close: async () => undefined,
  }
  const authority = new WebAudioWorldAuthority({
    createContext: () => context as never,
    fetchArrayBuffer: async () => new ArrayBuffer(8),
    resolveResourceUrl: (path) => `workspace://${path}`,
  })
  await authority.prepareScene(createRuntimeWorldSnapshot(), 'scene:one')
  await authority.activate()
  await authority.play('component:beep')
  await authority.play('component:beep')
  await authority.stopSource('component:beep')
  assert.equal(stopped, 2)
  await authority.play('component:beep')
  assert.equal(started, 3)
  await authority.stop()
  assert.equal(stopped, 3)
})

test('spatial sources start at their authored runtime pose', async () => {
  const calls: string[] = []
  const snapshot = createRuntimeWorldSnapshot()
  const sourceComponent = snapshot.scenes[0].entities[0].components.find((component) => component.type === 'audio-source')
  if (sourceComponent?.type !== 'audio-source') throw new Error('Audio source fixture is unavailable.')
  sourceComponent.spatial = true
  const source = {
    buffer: null, loop: false,
    connect() { return this }, disconnect() {}, start() {}, stop() {}, addEventListener() {},
  }
  const gain = { gain: { value: 1 }, connect() { return this }, disconnect() {} }
  const panner = {
    distanceModel: 'inverse', refDistance: 1, maxDistance: 1,
    connect() { return this }, disconnect() {},
    setPosition(x: number, y: number, z: number) { calls.push(`panner:${x},${y},${z}`) },
  }
  const context = {
    state: 'running', currentTime: 0, destination: {},
    listener: { setPosition() {}, setOrientation() {} },
    createBufferSource: () => source,
    createGain: () => gain,
    createPanner: () => panner,
    decodeAudioData: async () => ({ duration: 1 }),
    suspend: async () => undefined, resume: async () => undefined, close: async () => undefined,
  }
  const authority = new WebAudioWorldAuthority({
    createContext: () => context as never,
    fetchArrayBuffer: async () => new ArrayBuffer(8),
    resolveResourceUrl: (path) => `workspace://${path}`,
  })
  await authority.prepareScene(snapshot, 'scene:one')
  authority.update([{ entityId: 'entity:camera', position: [1, 2, 3], rotation: [0, 0, 0, 1] }])
  await authority.activate()
  await authority.play('component:beep')
  assert.deepEqual(calls, ['panner:1,2,3'])
  await authority.stop()
})

test('enabled audio child under a disabled parent neither fetches nor plays', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  nestRuntimeCameraUnderDisabledParent(snapshot)
  assert.equal(validateWorldProjectSnapshot(snapshot).success, true)
  let fetched = 0
  let started = 0
  const context = {
    state: 'running', currentTime: 0, destination: {}, listener: {},
    createBufferSource: () => ({
      buffer: null, loop: false, connect() { return this }, disconnect() {},
      start() { started += 1 }, stop() {}, addEventListener() {},
    }),
    createGain: () => ({ gain: { value: 1 }, connect() { return this }, disconnect() {} }),
    decodeAudioData: async () => ({ duration: 1 }),
    suspend: async () => undefined, resume: async () => undefined, close: async () => undefined,
  }
  const authority = new WebAudioWorldAuthority({
    createContext: () => context as never,
    fetchArrayBuffer: async () => { fetched += 1; return new ArrayBuffer(8) },
    resolveResourceUrl: (path) => `workspace://${path}`,
  })
  await authority.prepareScene(snapshot, 'scene:one')
  await authority.activate()
  await authority.play('component:beep')
  assert.equal(fetched, 0)
  assert.equal(started, 0)
  await authority.stop()
})
