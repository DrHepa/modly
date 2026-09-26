import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { inflateSync } from 'node:zlib'

import type { WorldRenderExecutorContext } from './world-render-job-service.ts'
import {
  createElectronWorldRenderHostSession,
  createWorldRenderHostInitializePayload,
  createWorldWebmStartPayload,
  isWorldWebmFfmpegFallbackEligible,
  WorldRenderMainPortChannel,
  WorldRenderBrowserExecutor,
  type WorldRenderHostPort,
  type WorldRenderHostSession,
  type WorldRenderWebmAuthority,
} from './world-render-browser-executor.ts'
import { WORLD_RENDER_HOST_PROTOCOL } from '../../src/shared/types/worldRenderHost.ts'
import { WORLD_WEBM_PROTOCOL } from '../../src/areas/worlds/render/worldWebmProtocol.ts'

const PNG = Uint8Array.from([137, 80, 78, 71])
const WAV = Uint8Array.from([82, 73, 70, 70])

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settleWithin<T>(operation: Promise<T>, milliseconds = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error('test operation did not settle')), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function executionContext(signal = new AbortController().signal): {
  context: WorldRenderExecutorContext
  events: string[]
} {
  const events: string[] = []
  const context: WorldRenderExecutorContext = {
    jobId: 'render-00000000000000000000000000000000',
    signal,
    snapshot: {
      project: {
        schema: 'modly.world-project.v1', projectId: 'project:test', name: 'Test', revision: 4,
        resources: [], scenes: [{ id: 'scene:test', name: 'Scene', documentPath: 'Worlds/test/scenes/scene.world.json' }],
        startSceneId: 'scene:test', inputActions: [], graphicsProfiles: [{ id: 'graphics:test', name: 'Test', renderScale: 1, shadowQuality: 'off', antialiasing: 'off' }], activeGraphicsProfileId: 'graphics:test',
      },
      scenes: [],
    },
    scene: {
      schema: 'modly.world-scene.v1', projectId: 'project:test', sceneId: 'scene:test', name: 'Scene',
      environment: { backgroundColor: '#000000', ambientIntensity: 0 },
      entities: [{ id: 'entity:camera', name: 'Camera', parentId: null, enabled: true, locked: false, tags: [], transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [{ id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 50 }] }],
      sequences: [],
    },
    sequence: { id: 'sequence:test', name: 'Sequence', duration: { numerator: 1, denominator: 10 }, tracks: [] },
    preset: { width: 64, height: 64, fps: 30 },
    resources: [],
    framePlan: [
      { index: 0, time: { numerator: 0, denominator: 1 }, duration: { numerator: 1, denominator: 30 }, timestampMicroseconds: 0 },
      { index: 1, time: { numerator: 1, denominator: 30 }, duration: { numerator: 1, denominator: 30 }, timestampMicroseconds: 33_333 },
      { index: 2, time: { numerator: 1, denominator: 15 }, duration: { numerator: 1, denominator: 30 }, timestampMicroseconds: 66_667 },
    ],
    snapshotSha256: 'a'.repeat(64),
    reportProgress: async (progress) => { events.push(`progress:${progress.phase}:${progress.completedFrames}`) },
    writeFrame: async (index, bytes) => { assert.ok(bytes instanceof Uint8Array); events.push(`frame:${index}`) },
    writeAudio: async (bytes) => { assert.ok(bytes instanceof Uint8Array); events.push('audio') },
    writeWebm: async () => { throw new Error('WebM must not be written by the masters executor') },
  }
  context.snapshot.scenes.push(context.scene)
  context.scene.sequences.push(context.sequence)
  return { context, events }
}

test('executor performs an ordered frame handshake, writes WAV last, and always disposes', async () => {
  const { context, events } = executionContext()
  let disposed = 0
  const session: WorldRenderHostSession = {
    initialize: async () => { events.push('initialize') },
    renderFrame: async ({ index }) => { events.push(`render:${index}`); return PNG.slice() },
    renderAudio: async () => { events.push('render-audio'); return WAV.slice() },
    assembleWebm: async (payload) => { events.push(`assemble:${payload.frameCount}:${payload.audioSampleCount}`); return { ok: true } },
    dispose: async () => { disposed += 1 },
  }
  const executor = new WorldRenderBrowserExecutor({ createSession: async () => session })
  await executor.execute(context)
  assert.deepEqual(events, [
    'progress:preflighting:0', 'initialize', 'progress:rendering-frames:0',
    'render:0', 'frame:0', 'progress:rendering-frames:1',
    'render:1', 'frame:1', 'progress:rendering-frames:2',
    'render:2', 'frame:2', 'progress:rendering-frames:3',
    'progress:rendering-audio:3', 'render-audio', 'audio', 'progress:assembling:3', 'assemble:3:4800',
  ])
  assert.equal(disposed, 1)
})

test('runs FFmpeg only for exact Mediabunny eligibility after durable masters and completed sink cleanup', async () => {
  const { context, events } = executionContext()
  let mediabunnyReturned = false
  const session: WorldRenderHostSession = {
    initialize: async () => {},
    renderFrame: async () => PNG.slice(),
    renderAudio: async () => WAV.slice(),
    assembleWebm: async () => {
      events.push('mediabunny-aborted')
      mediabunnyReturned = true
      return { ok: false, code: 'codec-unavailable' }
    },
    dispose: async () => {},
  }
  await new WorldRenderBrowserExecutor({
    createSession: async () => session,
    assembleWithFfmpeg: async ({ jobId, plan }) => {
      assert.equal(mediabunnyReturned, true)
      assert.equal(jobId, context.jobId)
      assert.equal(plan.frameCount, context.framePlan.length)
      events.push('ffmpeg')
      return true
    },
  }).execute(context)
  assert.ok(events.indexOf('audio') < events.indexOf('mediabunny-aborted'))
  assert.ok(events.indexOf('mediabunny-aborted') < events.indexOf('ffmpeg'))
})

test('fallback eligibility is closed over exact codec and mux failures only', async () => {
  for (const code of ['codec-unavailable', 'codec-encode-failed', 'mux-construction-failed', 'mux-start-failed', 'mux-finalize-failed'] as const) {
    assert.equal(isWorldWebmFfmpegFallbackEligible(code), true, code)
  }
  for (const code of ['master-read-failed', 'master-decode-failed', 'sink-failed', 'worker-crashed', 'worker-timeout', 'protocol-failed', 'cancelled', 'internal-failed'] as const) {
    assert.equal(isWorldWebmFfmpegFallbackEligible(code), false, code)
  }
})

test('noneligible Mediabunny failures and missing FFmpeg remain masters-only partials', async (t) => {
  for (const [code, expectedFallbacks] of [
    ['master-read-failed', 0],
    ['worker-crashed', 0],
    ['codec-encode-failed', 1],
  ] as const) {
    await t.test(code, async () => {
      const { context, events } = executionContext()
      let fallbacks = 0
      const session: WorldRenderHostSession = {
        initialize: async () => {},
        renderFrame: async () => PNG.slice(),
        renderAudio: async () => WAV.slice(),
        assembleWebm: async () => ({ ok: false, code }),
        dispose: async () => {},
      }
      await new WorldRenderBrowserExecutor({
        createSession: async () => session,
        assembleWithFfmpeg: async () => { fallbacks += 1; return false },
      }).execute(context)
      assert.equal(fallbacks, expectedFallbacks)
      assert.equal(events.includes('audio'), true)
    })
  }
})

test('cancellation during FFmpeg fallback remains cancellation', async () => {
  const controller = new AbortController()
  const { context } = executionContext(controller.signal)
  const session: WorldRenderHostSession = {
    initialize: async () => {}, renderFrame: async () => PNG.slice(), renderAudio: async () => WAV.slice(),
    assembleWebm: async () => ({ ok: false, code: 'mux-finalize-failed' }), dispose: async () => {},
  }
  await assert.rejects(new WorldRenderBrowserExecutor({
    createSession: async () => session,
    assembleWithFfmpeg: async () => { controller.abort(); throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) },
  }).execute(context), (error: unknown) => error instanceof Error && error.name === 'AbortError')
})

test('a Mediabunny cancellation terminal remains cancellation and never reaches fallback', async () => {
  const { context } = executionContext()
  let fallbacks = 0
  const session: WorldRenderHostSession = {
    initialize: async () => {}, renderFrame: async () => PNG.slice(), renderAudio: async () => WAV.slice(),
    assembleWebm: async () => ({ ok: false, code: 'cancelled' }), dispose: async () => {},
  }
  await assert.rejects(new WorldRenderBrowserExecutor({
    createSession: async () => session,
    assembleWithFfmpeg: async () => { fallbacks += 1; return true },
  }).execute(context), (error: unknown) => error instanceof Error && error.name === 'AbortError')
  assert.equal(fallbacks, 0)
})

test('cancellation while a noneligible WebM cleanup result settles remains cancellation', async () => {
  const controller = new AbortController()
  const { context } = executionContext(controller.signal)
  const session: WorldRenderHostSession = {
    initialize: async () => {}, renderFrame: async () => PNG.slice(), renderAudio: async () => WAV.slice(),
    assembleWebm: async () => {
      controller.abort()
      return { ok: false, code: 'sink-failed' }
    },
    dispose: async () => {},
  }
  await assert.rejects(
    new WorldRenderBrowserExecutor({ createSession: async () => session }).execute(context),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
})

test('executor snapshots inputs before renderer initialization and ignores renderer mutation', async () => {
  const { context } = executionContext()
  const originalName = context.scene.name
  const session: WorldRenderHostSession = {
    initialize: async (payload) => { payload.snapshot.scene.name = 'Mutated renderer copy' },
    renderFrame: async () => PNG.slice(), renderAudio: async () => WAV.slice(), dispose: async () => {},
  }
  await new WorldRenderBrowserExecutor({ createSession: async () => session }).execute(context)
  assert.equal(context.scene.name, originalName)
})

test('initialize payload excludes disabled and ancestor-disabled presentation resources', () => {
  const { context } = executionContext()
  const resources = [
    { id: 'resource:active', type: 'model' as const, name: 'Active', workspacePath: 'Assets/active.glb', format: 'glb' as const },
    { id: 'resource:component-disabled', type: 'model' as const, name: 'Disabled component', workspacePath: 'Assets/component-disabled.glb', format: 'glb' as const },
    { id: 'resource:ancestor-disabled', type: 'model' as const, name: 'Disabled ancestor', workspacePath: 'Assets/ancestor-disabled.glb', format: 'glb' as const },
  ]
  context.snapshot.project.resources.push(...resources)
  context.resources.push(...resources.map((resource, index) => ({
    resource,
    files: [{
      role: 'primary' as const,
      originalWorkspacePath: resource.workspacePath,
      workspacePath: `Exports/pinned-${index}.bin`,
      size: 64,
      sha256: String(index + 1).repeat(64),
    }],
  })))
  const renderable = (id: string, resourceId: string, enabled: boolean) => ({
    id,
    type: 'renderable' as const,
    enabled,
    resourceId,
    visible: true,
    castShadow: false,
    receiveShadow: false,
    material: { baseColor: '#ffffff' as const, metallic: 0, roughness: 1, opacity: 1 },
  })
  const transform = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }
  context.scene.entities.unshift(
    { id: 'entity:active', name: 'Active', parentId: null, enabled: true, locked: false, tags: [], transform, components: [renderable('component:active', 'resource:active', true)] },
    { id: 'entity:component-disabled', name: 'Disabled component', parentId: null, enabled: true, locked: false, tags: [], transform, components: [renderable('component:component-disabled', 'resource:component-disabled', false)] },
    { id: 'entity:disabled-parent', name: 'Disabled parent', parentId: null, enabled: false, locked: false, tags: [], transform, components: [] },
    { id: 'entity:ancestor-disabled', name: 'Disabled child', parentId: 'entity:disabled-parent', enabled: true, locked: false, tags: [], transform, components: [renderable('component:ancestor-disabled', 'resource:ancestor-disabled', true)] },
  )

  const payload = createWorldRenderHostInitializePayload(context)
  assert.deepEqual(payload.snapshot.resources.map((resource) => resource.id), ['resource:active'])
})

test('abort stops work and disposes the hidden renderer', async () => {
  const controller = new AbortController()
  const { context } = executionContext(controller.signal)
  let disposed = 0
  const session: WorldRenderHostSession = {
    initialize: async () => {},
    renderFrame: async () => { controller.abort(); return PNG.slice() },
    renderAudio: async () => { throw new Error('audio must not start') },
    dispose: async () => { disposed += 1 },
  }
  await assert.rejects(
    new WorldRenderBrowserExecutor({ createSession: async () => session }).execute(context),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(disposed, 1)
})

test('session admission has an abort signal and finite deadline, and owns a late session without publishing it', async () => {
  const { context } = executionContext()
  const pending = deferred<WorldRenderHostSession>()
  let admissionSignal: AbortSignal | undefined
  let admissionDeadlineMs = 0
  let initialized = 0
  let disposed = 0
  const lateSession: WorldRenderHostSession = {
    initialize: async () => { initialized += 1 },
    renderFrame: async () => PNG.slice(),
    renderAudio: async () => WAV.slice(),
    dispose: async () => { disposed += 1 },
  }
  const before = Date.now()
  const executor = new WorldRenderBrowserExecutor({
    sessionAdmissionTimeoutMs: 10,
    sessionCleanupTimeoutMs: 10,
    createSession: async (input) => {
      admissionSignal = input.signal
      admissionDeadlineMs = input.admissionDeadlineMs
      return pending.promise
    },
  })

  await assert.rejects(
    settleWithin(executor.execute(context)),
    (error: unknown) => error instanceof Error && error.name === 'WorldRenderExecutorError',
  )
  assert.equal(admissionSignal?.aborted, true)
  assert.ok(admissionDeadlineMs >= before + 5 && admissionDeadlineMs <= Date.now() + 25)

  pending.resolve(lateSession)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(initialized, 0, 'a late session must never enter renderer initialization')
  assert.equal(disposed, 1, 'the exact late session must remain owned and be disposed')
  await settleWithin(executor.shutdown())
  assert.equal(disposed, 1, 'shutdown must join the existing disposal authority')
})

test('shutdown aborts a never-settling session admission and remains finite', async () => {
  const { context } = executionContext()
  let admissionSignal: AbortSignal | undefined
  const executor = new WorldRenderBrowserExecutor({
    sessionAdmissionTimeoutMs: 1_000,
    sessionCleanupTimeoutMs: 10,
    createSession: async (input) => {
      admissionSignal = input.signal
      return new Promise<never>(() => undefined)
    },
  })
  const execution = executor.execute(context)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))

  await settleWithin(executor.shutdown())
  assert.equal(admissionSignal?.aborted, true)
  await assert.rejects(
    settleWithin(execution),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
})

test('a never-settling session disposal is bounded and invoked exactly once', async () => {
  const { context } = executionContext()
  let disposals = 0
  const session: WorldRenderHostSession = {
    initialize: async () => {},
    renderFrame: async () => PNG.slice(),
    renderAudio: async () => WAV.slice(),
    dispose: () => {
      disposals += 1
      return new Promise<never>(() => undefined)
    },
  }
  const executor = new WorldRenderBrowserExecutor({
    sessionCleanupTimeoutMs: 10,
    createSession: async () => session,
  })

  await settleWithin(executor.execute(context))
  await settleWithin(executor.shutdown())
  assert.equal(disposals, 1)
})

function fakeElectronHost(input: {
  readonly loadFile: () => Promise<void>
  readonly clearStorageData: () => Promise<void>
  readonly clearCache: () => Promise<void>
}) {
  let destroyed = 0
  const port = {
    on: () => port,
    postMessage: () => undefined,
    start: () => undefined,
    close: () => undefined,
  }
  const isolatedSession = {
    setPermissionCheckHandler: () => undefined,
    setPermissionRequestHandler: () => undefined,
    webRequest: { onBeforeRequest: () => undefined },
    clearStorageData: input.clearStorageData,
    clearCache: input.clearCache,
  }
  const window = {
    setMenuBarVisibility: () => undefined,
    isDestroyed: () => destroyed > 0,
    destroy: () => { destroyed += 1 },
    loadFile: input.loadFile,
    on: () => window,
    webContents: {
      on: () => window.webContents,
      setWindowOpenHandler: () => undefined,
      postMessage: () => undefined,
    },
  }
  const BrowserWindow = function BrowserWindow(): typeof window { return window }
  const MessageChannelMain = function MessageChannelMain(): { port1: typeof port; port2: typeof port } {
    return { port1: port, port2: port }
  }
  return {
    electron: {
      session: { fromPartition: () => isolatedSession },
      BrowserWindow,
      MessageChannelMain,
    } as unknown as typeof import('electron'),
    destroyed: () => destroyed,
  }
}

test('production session destroys a late BrowserWindow when loadFile never settles', async () => {
  const load = deferred<void>()
  const fake = fakeElectronHost({
    loadFile: () => load.promise,
    clearStorageData: async () => undefined,
    clearCache: async () => undefined,
  })
  const signal = new AbortController().signal
  const creation = createElectronWorldRenderHostSession({
    jobId: 'render-00000000000000000000000000000000',
    generation: '1'.repeat(32),
    outputRepository: {} as never,
    timeoutMs: 1_000,
    signal,
    admissionDeadlineMs: Date.now() + 10,
    cleanupTimeoutMs: 10,
  }, { loadElectron: async () => fake.electron, moduleDirectory: '/tmp/world-render-test' })

  await assert.rejects(settleWithin(creation), /admission timed out/)
  assert.equal(fake.destroyed(), 1)
  load.reject(new Error('late load rejection'))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
})

test('production session bounds storage and cache cleanup while retaining late rejection custody', async () => {
  const storage = deferred<void>()
  const cache = deferred<void>()
  const fake = fakeElectronHost({
    loadFile: async () => undefined,
    clearStorageData: () => storage.promise,
    clearCache: () => cache.promise,
  })
  const session = await createElectronWorldRenderHostSession({
    jobId: 'render-00000000000000000000000000000000',
    generation: '2'.repeat(32),
    outputRepository: {} as never,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    admissionDeadlineMs: Date.now() + 100,
    cleanupTimeoutMs: 10,
  }, { loadElectron: async () => fake.electron, moduleDirectory: '/tmp/world-render-test' })

  await settleWithin(session.dispose())
  await settleWithin(session.dispose())
  assert.equal(fake.destroyed(), 1)
  storage.reject(new Error('late storage rejection'))
  cache.reject(new Error('late cache rejection'))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
})

class TestPort implements WorldRenderHostPort {
  readonly sent: unknown[] = []
  private readonly messageListeners: Array<(event: { data: unknown }) => void> = []
  private readonly messageErrorListeners: Array<() => void> = []
  private readonly closeListeners: Array<() => void> = []

  onMessage(listener: (event: { data: unknown }) => void): void { this.messageListeners.push(listener) }
  onMessageError(listener: () => void): void { this.messageErrorListeners.push(listener) }
  onClose(listener: () => void): void { this.closeListeners.push(listener) }

  start(): void {}
  close(): void { for (const listener of this.closeListeners) listener() }
  postMessage(value: unknown): void { this.sent.push(value) }
  emitMessage(data: unknown): void { for (const listener of this.messageListeners) listener({ data }) }
}

function rgbaFrame(width = 64, height = 64, seed = 0): Uint8Array {
  const rowBytes = width * 4
  return Uint8Array.from({ length: width * height * 4 }, (_, index) => (
    Math.floor(index / rowBytes) * 13 + (index % rowBytes) + seed
  ) & 0xff)
}

function frameResponse(input: {
  requestId: number
  rgba: Uint8Array
  sha256?: string
  width?: number
  height?: number
}) {
  const width = input.width ?? 64
  const height = input.height ?? 64
  return {
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: 'render-00000000000000000000000000000000',
    generation: '1'.repeat(32),
    requestId: input.requestId,
    kind: 'render-frame' as const,
    ok: true as const,
    payload: {
      index: 0,
      width,
      height,
      rgbaSha256: input.sha256 ?? createHash('sha256').update(input.rgba).digest('hex'),
      rgba: input.rgba.buffer.slice(input.rgba.byteOffset, input.rgba.byteOffset + input.rgba.byteLength),
    },
  }
}

function decodeCanonicalRgbaPng(png: Uint8Array): Uint8Array {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  assert.equal(png[24], 8)
  assert.equal(png[25], 6)
  const compressed: Uint8Array[] = []
  for (let offset = 8; offset < png.byteLength;) {
    const length = view.getUint32(offset, false)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    if (type === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
    if (type === 'IEND') break
  }
  const scanlines = inflateSync(Buffer.concat(compressed.map((bytes) => Buffer.from(bytes))))
  const rowBytes = width * 4
  assert.equal(scanlines.byteLength, height * (rowBytes + 1))
  const result = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    assert.equal(scanlines[row * (rowBytes + 1)], 0)
    result.set(scanlines.subarray(row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1)), row * rowBytes)
  }
  return result
}

async function initializedFrameChannel() {
  const port = new TestPort()
  const channel = new WorldRenderMainPortChannel({
    jobId: 'render-00000000000000000000000000000000',
    generation: '1'.repeat(32),
    timeoutMs: 1_000,
    port,
    readPinnedResource: async () => { throw new Error('not expected') },
  })
  const { context } = executionContext()
  const initialization = channel.initialize(createWorldRenderHostInitializePayload(context), new AbortController().signal)
  const initialize = port.sent.at(-1) as { requestId: number }
  port.emitMessage({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: context.jobId,
    generation: '1'.repeat(32),
    requestId: initialize.requestId,
    kind: 'initialize',
    ok: true,
    payload: {},
  })
  await initialization
  return { port, channel }
}

test('main verifies raw RGBA integrity and deterministically encodes a vertically-correct PNG', async () => {
  const first = await initializedFrameChannel()
  const firstRgba = rgbaFrame()
  const firstPending = first.channel.renderFrame({
    index: 0,
    time: { numerator: 0, denominator: 1 },
    timestampMicroseconds: 0,
  }, new AbortController().signal)
  const firstCommand = first.port.sent.at(-1) as { requestId: number }
  first.port.emitMessage(frameResponse({ requestId: firstCommand.requestId, rgba: firstRgba }))
  const firstPng = await firstPending
  const decoded = decodeCanonicalRgbaPng(firstPng)
  const rowBytes = 64 * 4
  assert.deepEqual(decoded.subarray(0, rowBytes), firstRgba.subarray(firstRgba.byteLength - rowBytes))

  const second = await initializedFrameChannel()
  const secondRgba = rgbaFrame(64, 64, 7)
  const secondPending = second.channel.renderFrame({
    index: 0,
    time: { numerator: 0, denominator: 1 },
    timestampMicroseconds: 0,
  }, new AbortController().signal)
  const secondCommand = second.port.sent.at(-1) as { requestId: number }
  second.port.emitMessage(frameResponse({ requestId: secondCommand.requestId, rgba: secondRgba }))
  const secondPng = await secondPending
  assert.notDeepEqual(secondPng, firstPng)
  await Promise.all([first.channel.close(), second.channel.close()])
})

test('main rejects a forged RGBA hash and malformed raw payload before persistence', async () => {
  const forged = await initializedFrameChannel()
  const rgba = rgbaFrame()
  const forgedPending = forged.channel.renderFrame({
    index: 0,
    time: { numerator: 0, denominator: 1 },
    timestampMicroseconds: 0,
  }, new AbortController().signal)
  const forgedCommand = forged.port.sent.at(-1) as { requestId: number }
  forged.port.emitMessage(frameResponse({ requestId: forgedCommand.requestId, rgba, sha256: '0'.repeat(64) }))
  await assert.rejects(forgedPending, /RGBA hash mismatch/)
  await forged.channel.close()

  const malformed = await initializedFrameChannel()
  const malformedPending = malformed.channel.renderFrame({
    index: 0,
    time: { numerator: 0, denominator: 1 },
    timestampMicroseconds: 0,
  }, new AbortController().signal)
  const malformedCommand = malformed.port.sent.at(-1) as { requestId: number }
  malformed.port.emitMessage(frameResponse({
    requestId: malformedCommand.requestId,
    rgba: rgba.subarray(0, rgba.byteLength - 1),
  }))
  await assert.rejects(malformedPending, /invalid response/)
  await malformed.channel.close()
})

test('main port channel multiplexes a pinned resource read while initialize is pending', async () => {
  const port = new TestPort()
  const bytes = Uint8Array.from({ length: 64 }, (_, index) => index)
  const digest = 'fdeab9acf3710362bd2658cdc9a29e8f9c757fcf9811603a8c447cd1d9151108'
  const channel = new WorldRenderMainPortChannel({
    jobId: 'render-00000000000000000000000000000000',
    generation: '1'.repeat(32),
    timeoutMs: 1_000,
    port,
    readPinnedResource: async (jobId, resourceId, role, signal) => {
      assert.equal(jobId, 'render-00000000000000000000000000000000')
      assert.equal(resourceId, 'resource:model')
      assert.equal(role, 'primary')
      assert.equal(signal.aborted, false)
      return { resourceId, role, size: bytes.byteLength, sha256: digest, bytes: bytes.slice() }
    },
  })
  const { context } = executionContext()
  context.snapshot.project.resources.push({
    id: 'resource:model', type: 'model', name: 'Model', workspacePath: 'Assets/model.glb', format: 'glb',
  })
  context.resources.push({
    resource: context.snapshot.project.resources[0],
    files: [{ role: 'primary', originalWorkspacePath: 'Assets/model.glb', workspacePath: 'Exports/pinned.bin', size: 64, sha256: digest }],
  })
  context.scene.entities.unshift({
    id: 'entity:model', name: 'Model', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: 'component:model', type: 'renderable', enabled: true, resourceId: 'resource:model', visible: true, castShadow: false, receiveShadow: false, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } }],
  })

  const initialization = channel.initialize(createWorldRenderHostInitializePayload(context), new AbortController().signal)
  const command = port.sent[0] as { requestId: number }
  port.emitMessage({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: context.jobId,
    generation: '1'.repeat(32),
    kind: 'resource-request',
    requestId: 1,
    resourceId: 'resource:model',
    role: 'primary',
  })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const resourceResponse = port.sent[1] as {
    kind: string
    result: { ok: boolean; bytes: ArrayBuffer }
  }
  assert.equal(resourceResponse.kind, 'resource-result')
  assert.equal(resourceResponse.result.ok, true)
  assert.ok(resourceResponse.result.bytes instanceof ArrayBuffer)
  assert.equal(resourceResponse.result.bytes.byteLength, 64)
  port.emitMessage({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: context.jobId,
    generation: '1'.repeat(32),
    requestId: command.requestId,
    kind: 'initialize',
    ok: true,
    payload: {},
  })
  await initialization
  await channel.close()
})

test('main port channel ignores another generation and fails its own malformed message without poisoning peers', async () => {
  const makeChannel = () => {
    const port = new TestPort()
    const channel = new WorldRenderMainPortChannel({
      jobId: 'render-00000000000000000000000000000000',
      generation: '1'.repeat(32),
      timeoutMs: 1_000,
      port,
      readPinnedResource: async () => { throw new Error('not expected') },
    })
    return { port, channel }
  }
  const first = makeChannel()
  const second = makeChannel()
  const { context } = executionContext()
  const firstPending = first.channel.initialize(createWorldRenderHostInitializePayload(context), new AbortController().signal)
  const secondPending = second.channel.initialize(createWorldRenderHostInitializePayload(context), new AbortController().signal)
  first.port.emitMessage({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: context.jobId,
    generation: '2'.repeat(32),
    requestId: 1,
    kind: 'initialize',
    ok: true,
    payload: {},
  })
  first.port.emitMessage({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: context.jobId,
    generation: '1'.repeat(32),
    requestId: 1,
    kind: 'initialize',
    ok: true,
    payload: { unexpected: true },
  })
  await assert.rejects(firstPending, /invalid response/)
  second.port.emitMessage({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: context.jobId,
    generation: '1'.repeat(32),
    requestId: 1,
    kind: 'initialize',
    ok: true,
    payload: {},
  })
  await secondPending
  await Promise.all([first.channel.close(), second.channel.close()])
})

test('closing the main port channel aborts pinned reads and settles command promises', async () => {
  const port = new TestPort()
  let resourceSignal: AbortSignal | null = null
  let resolveLateRead!: (value: {
    resourceId: string
    role: 'primary'
    size: number
    sha256: string
    bytes: Uint8Array
  }) => void
  const channel = new WorldRenderMainPortChannel({
    jobId: 'render-00000000000000000000000000000000',
    generation: '1'.repeat(32),
    timeoutMs: 1_000,
    port,
    readPinnedResource: async (_jobId, _resourceId, _role, signal) => {
      resourceSignal = signal
      return new Promise((resolvePromise) => { resolveLateRead = resolvePromise })
    },
  })
  const { context } = executionContext()
  const bytes = Uint8Array.from({ length: 64 }, (_, index) => index)
  const digest = 'fdeab9acf3710362bd2658cdc9a29e8f9c757fcf9811603a8c447cd1d9151108'
  context.snapshot.project.resources.push({
    id: 'resource:model', type: 'model', name: 'Model', workspacePath: 'Assets/model.glb', format: 'glb',
  })
  context.resources.push({
    resource: context.snapshot.project.resources[0],
    files: [{ role: 'primary', originalWorkspacePath: 'Assets/model.glb', workspacePath: 'Exports/pinned.bin', size: bytes.length, sha256: digest }],
  })
  context.scene.entities.unshift({
    id: 'entity:model', name: 'Model', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: 'component:model', type: 'renderable', enabled: true, resourceId: 'resource:model', visible: true, castShadow: false, receiveShadow: false, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } }],
  })
  const pending = channel.initialize(createWorldRenderHostInitializePayload(context), new AbortController().signal)
  port.emitMessage({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: context.jobId,
    generation: '1'.repeat(32),
    kind: 'resource-request',
    requestId: 1,
    resourceId: 'resource:model',
    role: 'primary',
  })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal((resourceSignal as AbortSignal | null)?.aborted, false)
  await channel.close()
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  assert.equal((resourceSignal as AbortSignal | null)?.aborted, true)
  resolveLateRead({
    resourceId: 'resource:model',
    role: 'primary',
    size: bytes.byteLength,
    sha256: digest,
    bytes: bytes.slice(),
  })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(port.sent.length, 1, 'a late read must not post into the closed job port')
})

async function initializedWebmChannel(authority: WorldRenderWebmAuthority, webmSettlementTimeoutMs?: number) {
  const port = new TestPort()
  const channel = new WorldRenderMainPortChannel({
    jobId: 'render-00000000000000000000000000000000',
    generation: '1'.repeat(32),
    timeoutMs: 1_000,
    port,
    readPinnedResource: async () => { throw new Error('not expected') },
    webmAuthority: authority,
    webmSettlementTimeoutMs,
  })
  const { context } = executionContext()
  const initialization = channel.initialize(createWorldRenderHostInitializePayload(context), new AbortController().signal)
  port.emitMessage({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: context.jobId,
    generation: '1'.repeat(32),
    requestId: 1,
    kind: 'initialize',
    ok: true,
    payload: {},
  })
  await initialization
  return { port, channel, context }
}

function webmWorkerMessage(requestId: number, kind: string, payload: object, generation = '1'.repeat(32)) {
  return {
    protocol: WORLD_WEBM_PROTOCOL,
    jobId: 'render-00000000000000000000000000000000',
    generation,
    requestId,
    kind,
    payload,
  }
}

async function preflightAndBeginWebm(port: TestPort, plan: ReturnType<typeof createWorldWebmStartPayload>): Promise<void> {
  port.emitMessage(webmWorkerMessage(1, 'preflight', {
    width: plan.width, height: plan.height, fps: plan.fps,
    videoCodec: 'vp9', videoBitrate: plan.videoBitrate,
    audioCodec: 'opus', audioBitrate: plan.audioBitrate,
    audioSampleRate: 48_000, audioChannels: 2,
  }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(2, 'sink-begin', {}))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
}

test('main WebM authority handles exact path-free pulls, positional writes, commit, and terminal proof', async () => {
  const calls: string[] = []
  const sinkId = `sink-${'2'.repeat(32)}`
  const artifact = { size: 4, sha256: 'f'.repeat(64) }
  const authority: WorldRenderWebmAuthority = {
    beginWebmAssembly: async (_jobId, _generation, plan) => {
      calls.push(`begin:${plan.frameCount}`)
      return { sinkId }
    },
    readWebmFrameMaster: async (_jobId, _generation, receivedSinkId, index) => {
      assert.equal(receivedSinkId, sinkId)
      calls.push(`frame:${index}`)
      return { index, size: 3, sha256: 'a'.repeat(64), bytes: Uint8Array.from([1, 2, 3]) }
    },
    readWebmAudioMaster: async (_jobId, _generation, receivedSinkId, sampleOffset, sampleCount) => {
      assert.equal(receivedSinkId, sinkId)
      calls.push(`audio:${sampleOffset}:${sampleCount}`)
      return { sampleOffset, sampleCount, bytes: new Uint8Array(sampleCount * 4) }
    },
    writeWebmAssembly: async (_jobId, _generation, receivedSinkId, position, bytes) => {
      assert.equal(receivedSinkId, sinkId)
      calls.push(`write:${position}:${bytes.byteLength}`)
      return { written: bytes.byteLength, extent: position + bytes.byteLength }
    },
    commitWebmAssembly: async (_jobId, _generation, receivedSinkId, extent) => {
      assert.equal(receivedSinkId, sinkId)
      calls.push(`commit:${extent}`)
      return artifact
    },
    confirmWebmAssembly: async (_jobId, _generation, receivedSinkId) => {
      assert.equal(receivedSinkId, sinkId)
      calls.push('confirm')
      return true
    },
    abortWebmAssembly: async () => { calls.push('abort'); return true },
  }
  const { port, channel, context } = await initializedWebmChannel(authority)
  const plan = createWorldWebmStartPayload(context)
  const assembly = channel.assembleWebm(plan, new AbortController().signal)
  const start = port.sent.at(-1) as { requestId: number; kind: string }
  assert.equal(start.kind, 'start')

  port.emitMessage(webmWorkerMessage(1, 'preflight', {
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    videoCodec: 'vp9',
    videoBitrate: plan.videoBitrate,
    audioCodec: 'opus',
    audioBitrate: plan.audioBitrate,
    audioSampleRate: 48_000,
    audioChannels: 2,
  }, '9'.repeat(32)))
  assert.equal(port.sent.length, 2, 'another generation must be ignored')

  const preflight = webmWorkerMessage(1, 'preflight', {
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    videoCodec: 'vp9',
    videoBitrate: plan.videoBitrate,
    audioCodec: 'opus',
    audioBitrate: plan.audioBitrate,
    audioSampleRate: 48_000,
    audioChannels: 2,
  })
  port.emitMessage(preflight)
  port.emitMessage(preflight)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(port.sent.filter((value) => {
    const candidate = value as { kind?: string; requestKind?: string; requestId?: number }
    return candidate.kind === 'response' && candidate.requestKind === 'preflight' && candidate.requestId === 1
  }).length, 1, 'duplicate Worker requests must be ignored rather than racing the legitimate ACK')
  port.emitMessage(webmWorkerMessage(2, 'sink-begin', {}))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(3, 'read-frame', { sinkId, index: 0 }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const frameResponse = port.sent.at(-1) as { payload: { bytes: ArrayBuffer } }
  assert.ok(frameResponse && 'payload' in frameResponse, JSON.stringify(frameResponse))
  assert.deepEqual([...new Uint8Array(frameResponse.payload.bytes)], [1, 2, 3])
  port.emitMessage(webmWorkerMessage(4, 'read-audio', { sinkId, sampleOffset: 0, sampleCount: 8 }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const writeBytes = Uint8Array.from([10, 11, 12, 13]).buffer
  port.emitMessage(webmWorkerMessage(5, 'sink-write', { sinkId, position: 0, bytes: writeBytes }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(6, 'sink-commit', { sinkId, extent: 4 }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(start.requestId + 100, 'progress', {
    phase: 'finalizing',
    completedFrames: plan.frameCount,
    frameCount: plan.frameCount,
    completedAudioSamples: plan.audioSampleCount,
    audioSampleCount: plan.audioSampleCount,
  }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(start.requestId + 101, 'complete', artifact))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(start.requestId, 'progress', {
    phase: 'finalizing',
    completedFrames: plan.frameCount,
    frameCount: plan.frameCount,
    completedAudioSamples: plan.audioSampleCount,
    audioSampleCount: plan.audioSampleCount,
  }))
  port.emitMessage(webmWorkerMessage(start.requestId, 'complete', artifact))

  assert.deepEqual(await assembly, { ok: true })
  assert.deepEqual(calls, ['begin:3', 'frame:0', 'audio:0:8', 'write:0:4', 'commit:4', 'confirm'])
  const sentBeforeLate = port.sent.length
  port.emitMessage(webmWorkerMessage(start.requestId, 'complete', artifact))
  assert.equal(port.sent.length, sentBeforeLate, 'late terminal messages must be ignored')
  channel.close()
})

test('main WebM cancellation wins commit races and independently aborts its temporary sink', async () => {
  const sinkId = `sink-${'3'.repeat(32)}`
  let releaseCommit!: () => void
  let aborts = 0
  const authority: WorldRenderWebmAuthority = {
    beginWebmAssembly: async () => ({ sinkId }),
    readWebmFrameMaster: async () => { throw new Error('not expected') },
    readWebmAudioMaster: async () => { throw new Error('not expected') },
    writeWebmAssembly: async () => { throw new Error('not expected') },
    commitWebmAssembly: async () => {
      await new Promise<void>((resolvePromise) => { releaseCommit = resolvePromise })
      return { size: 4, sha256: 'f'.repeat(64) }
    },
    confirmWebmAssembly: async () => { throw new Error('not expected') },
    abortWebmAssembly: async () => { aborts += 1; return true },
  }
  const { port, channel, context } = await initializedWebmChannel(authority)
  const plan = createWorldWebmStartPayload(context)
  const controller = new AbortController()
  const assembly = channel.assembleWebm(plan, controller.signal)
  const start = port.sent.at(-1) as { requestId: number }
  port.emitMessage(webmWorkerMessage(1, 'preflight', {
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    videoCodec: 'vp9',
    videoBitrate: plan.videoBitrate,
    audioCodec: 'opus',
    audioBitrate: plan.audioBitrate,
    audioSampleRate: 48_000,
    audioChannels: 2,
  }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(2, 'sink-begin', {}))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(3, 'sink-commit', { sinkId, extent: 4 }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  controller.abort()
  releaseCommit()
  await assert.rejects(assembly, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(aborts, 1)
  assert.equal((port.sent.at(-1) as { kind: string }).kind, 'abort')
  const sentBeforeLate = port.sent.length
  port.emitMessage(webmWorkerMessage(start.requestId, 'complete', { size: 4, sha256: 'f'.repeat(64) }))
  assert.equal(port.sent.length, sentBeforeLate)
  channel.close()
})

test('main WebM terminal rejection retracts a repository-committed sink', async () => {
  const sinkId = `sink-${'4'.repeat(32)}`
  const artifact = { size: 4, sha256: 'f'.repeat(64) }
  let aborts = 0
  let confirmations = 0
  const authority: WorldRenderWebmAuthority = {
    beginWebmAssembly: async () => ({ sinkId }),
    readWebmFrameMaster: async () => { throw new Error('not expected') },
    readWebmAudioMaster: async () => { throw new Error('not expected') },
    writeWebmAssembly: async () => { throw new Error('not expected') },
    commitWebmAssembly: async () => artifact,
    confirmWebmAssembly: async () => { confirmations += 1; return true },
    abortWebmAssembly: async () => { aborts += 1; return true },
  }
  const { port, channel, context } = await initializedWebmChannel(authority)
  const plan = createWorldWebmStartPayload(context)
  const assembly = channel.assembleWebm(plan, new AbortController().signal)
  const start = port.sent.at(-1) as { requestId: number }
  port.emitMessage(webmWorkerMessage(1, 'preflight', {
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    videoCodec: 'vp9',
    videoBitrate: plan.videoBitrate,
    audioCodec: 'opus',
    audioBitrate: plan.audioBitrate,
    audioSampleRate: 48_000,
    audioChannels: 2,
  }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(2, 'sink-begin', {}))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(3, 'sink-commit', { sinkId, extent: 4 }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(start.requestId, 'complete', artifact))

  assert.deepEqual(await assembly, { ok: false, code: 'protocol-failed' })
  assert.equal(aborts, 1)
  assert.equal(confirmations, 0)
  channel.close()
})

test('eligible Mediabunny failure does not resolve until its main-owned sink is fully aborted', async () => {
  const sinkId = `sink-${'6'.repeat(32)}`
  let enterAbort!: () => void
  let releaseAbort!: () => void
  const abortEntered = new Promise<void>((resolvePromise) => { enterAbort = resolvePromise })
  const abortReleased = new Promise<void>((resolvePromise) => { releaseAbort = resolvePromise })
  let aborts = 0
  const authority: WorldRenderWebmAuthority = {
    beginWebmAssembly: async () => ({ sinkId }),
    readWebmFrameMaster: async () => { throw new Error('not expected') },
    readWebmAudioMaster: async () => { throw new Error('not expected') },
    writeWebmAssembly: async () => { throw new Error('not expected') },
    commitWebmAssembly: async () => { throw new Error('not expected') },
    confirmWebmAssembly: async () => { throw new Error('not expected') },
    abortWebmAssembly: async () => { aborts += 1; enterAbort(); await abortReleased; return true },
  }
  const { port, channel, context } = await initializedWebmChannel(authority)
  const plan = createWorldWebmStartPayload(context)
  const assembly = channel.assembleWebm(plan, new AbortController().signal)
  const start = port.sent.at(-1) as { requestId: number }
  port.emitMessage(webmWorkerMessage(1, 'preflight', {
    width: plan.width, height: plan.height, fps: plan.fps,
    videoCodec: 'vp9', videoBitrate: plan.videoBitrate,
    audioCodec: 'opus', audioBitrate: plan.audioBitrate,
    audioSampleRate: 48_000, audioChannels: 2,
  }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(2, 'sink-begin', {}))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(start.requestId, 'error', {
    code: 'codec-encode-failed', message: 'encoder failed',
  }))
  await abortEntered
  let settled = false
  void assembly.finally(() => { settled = true })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(settled, false)
  releaseAbort()
  assert.deepEqual(await assembly, { ok: false, code: 'codec-encode-failed' })
  assert.equal(aborts, 1)
  channel.close()
})

test('failed main-owned sink abort replaces Mediabunny eligibility with sink-failed', async () => {
  const sinkId = `sink-${'7'.repeat(32)}`
  let enterAbort!: () => void
  let rejectAbort!: (error: Error) => void
  const abortEntered = new Promise<void>((resolvePromise) => { enterAbort = resolvePromise })
  const abortResult = new Promise<never>((_resolvePromise, rejectPromise) => { rejectAbort = rejectPromise })
  let aborts = 0
  const authority: WorldRenderWebmAuthority = {
    beginWebmAssembly: async () => ({ sinkId }),
    readWebmFrameMaster: async () => { throw new Error('not expected') },
    readWebmAudioMaster: async () => { throw new Error('not expected') },
    writeWebmAssembly: async () => { throw new Error('not expected') },
    commitWebmAssembly: async () => { throw new Error('not expected') },
    confirmWebmAssembly: async () => { throw new Error('not expected') },
    abortWebmAssembly: async () => { aborts += 1; enterAbort(); return abortResult },
  }
  const { port, channel, context } = await initializedWebmChannel(authority)
  const plan = createWorldWebmStartPayload(context)
  const assembly = channel.assembleWebm(plan, new AbortController().signal)
  const start = port.sent.at(-1) as { requestId: number }
  port.emitMessage(webmWorkerMessage(1, 'preflight', {
    width: plan.width, height: plan.height, fps: plan.fps,
    videoCodec: 'vp9', videoBitrate: plan.videoBitrate,
    audioCodec: 'opus', audioBitrate: plan.audioBitrate,
    audioSampleRate: 48_000, audioChannels: 2,
  }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(2, 'sink-begin', {}))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(start.requestId, 'error', {
    code: 'codec-encode-failed', message: 'encoder failed',
  }))
  await abortEntered

  let settled = false
  void assembly.finally(() => { settled = true })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(settled, false, 'fallback eligibility must not escape while cleanup is active')
  rejectAbort(new Error('physical sink cleanup failed'))
  assert.deepEqual(await assembly, { ok: false, code: 'sink-failed' })
  assert.equal(aborts, 1)
  channel.close()
})

test('main WebM cleans a sink that finishes opening after cancellation', async () => {
  const sinkId = `sink-${'5'.repeat(32)}`
  let beginEntered!: () => void
  let releaseBegin!: () => void
  const entered = new Promise<void>((resolvePromise) => { beginEntered = resolvePromise })
  const released = new Promise<void>((resolvePromise) => { releaseBegin = resolvePromise })
  let aborts = 0
  const authority: WorldRenderWebmAuthority = {
    beginWebmAssembly: async () => {
      beginEntered()
      await released
      return { sinkId }
    },
    readWebmFrameMaster: async () => { throw new Error('not expected') },
    readWebmAudioMaster: async () => { throw new Error('not expected') },
    writeWebmAssembly: async () => { throw new Error('not expected') },
    commitWebmAssembly: async () => { throw new Error('not expected') },
    confirmWebmAssembly: async () => { throw new Error('not expected') },
    abortWebmAssembly: async (_jobId, _generation, receivedSinkId) => {
      assert.equal(receivedSinkId, sinkId)
      aborts += 1
      return true
    },
  }
  const { port, channel, context } = await initializedWebmChannel(authority)
  const plan = createWorldWebmStartPayload(context)
  const controller = new AbortController()
  const assembly = channel.assembleWebm(plan, controller.signal)
  port.emitMessage(webmWorkerMessage(1, 'preflight', {
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    videoCodec: 'vp9',
    videoBitrate: plan.videoBitrate,
    audioCodec: 'opus',
    audioBitrate: plan.audioBitrate,
    audioSampleRate: 48_000,
    audioChannels: 2,
  }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(2, 'sink-begin', {}))
  await entered
  controller.abort()
  releaseBegin()
  await assert.rejects(assembly, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(aborts, 1)
  channel.close()
})

test('main WebM finish bounds a stuck request queue and retracts late commit success', async () => {
  const sinkId = `sink-${'8'.repeat(32)}`
  const artifact = { size: 4, sha256: 'f'.repeat(64) }
  const lateCommit = deferred<typeof artifact>()
  let aborts = 0
  const authority: WorldRenderWebmAuthority = {
    beginWebmAssembly: async () => ({ sinkId }),
    readWebmFrameMaster: async () => { throw new Error('not expected') },
    readWebmAudioMaster: async () => { throw new Error('not expected') },
    writeWebmAssembly: async () => { throw new Error('not expected') },
    commitWebmAssembly: () => lateCommit.promise,
    confirmWebmAssembly: async () => { throw new Error('not expected') },
    abortWebmAssembly: async () => { aborts += 1; return true },
  }
  const { port, channel, context } = await initializedWebmChannel(authority, 10)
  const plan = createWorldWebmStartPayload(context)
  const assembly = channel.assembleWebm(plan, new AbortController().signal)
  const start = port.sent.at(-1) as { requestId: number }
  await preflightAndBeginWebm(port, plan)
  port.emitMessage(webmWorkerMessage(3, 'sink-commit', { sinkId, extent: 4 }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(start.requestId, 'error', {
    code: 'codec-encode-failed', message: 'encoder failed while commit was pending',
  }))

  assert.deepEqual(await settleWithin(assembly), { ok: false, code: 'sink-failed' })
  assert.equal(aborts, 1)
  lateCommit.resolve(artifact)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(aborts, 1, 'late commit success must remain owned by the exact cleanup tombstone')
  channel.close()
})

test('main WebM finish bounds a stuck abort while retaining its late cleanup owner', async () => {
  const sinkId = `sink-${'9'.repeat(32)}`
  const lateAbort = deferred<true>()
  let aborts = 0
  const authority: WorldRenderWebmAuthority = {
    beginWebmAssembly: async () => ({ sinkId }),
    readWebmFrameMaster: async () => { throw new Error('not expected') },
    readWebmAudioMaster: async () => { throw new Error('not expected') },
    writeWebmAssembly: async () => { throw new Error('not expected') },
    commitWebmAssembly: async () => { throw new Error('not expected') },
    confirmWebmAssembly: async () => { throw new Error('not expected') },
    abortWebmAssembly: () => { aborts += 1; return lateAbort.promise },
  }
  const { port, channel, context } = await initializedWebmChannel(authority, 10)
  const plan = createWorldWebmStartPayload(context)
  const assembly = channel.assembleWebm(plan, new AbortController().signal)
  const start = port.sent.at(-1) as { requestId: number }
  await preflightAndBeginWebm(port, plan)
  port.emitMessage(webmWorkerMessage(start.requestId, 'error', {
    code: 'codec-encode-failed', message: 'encoder failed',
  }))

  assert.deepEqual(await settleWithin(assembly), { ok: false, code: 'sink-failed' })
  assert.equal(aborts, 1)
  lateAbort.resolve(true)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  channel.close()
})

test('main WebM finish bounds confirmation and retracts any late acknowledgement', async () => {
  const sinkId = `sink-${'e'.repeat(32)}`
  const artifact = { size: 4, sha256: 'f'.repeat(64) }
  const lateConfirmation = deferred<true>()
  let aborts = 0
  const authority: WorldRenderWebmAuthority = {
    beginWebmAssembly: async () => ({ sinkId }),
    readWebmFrameMaster: async () => { throw new Error('not expected') },
    readWebmAudioMaster: async () => { throw new Error('not expected') },
    writeWebmAssembly: async () => { throw new Error('not expected') },
    commitWebmAssembly: async () => artifact,
    confirmWebmAssembly: () => lateConfirmation.promise,
    abortWebmAssembly: async () => { aborts += 1; return true },
  }
  const { port, channel, context } = await initializedWebmChannel(authority, 10)
  const plan = createWorldWebmStartPayload(context)
  const assembly = channel.assembleWebm(plan, new AbortController().signal)
  const start = port.sent.at(-1) as { requestId: number }
  await preflightAndBeginWebm(port, plan)
  port.emitMessage(webmWorkerMessage(3, 'sink-commit', { sinkId, extent: 4 }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(start.requestId, 'progress', {
    phase: 'finalizing', completedFrames: plan.frameCount, frameCount: plan.frameCount,
    completedAudioSamples: plan.audioSampleCount, audioSampleCount: plan.audioSampleCount,
  }))
  port.emitMessage(webmWorkerMessage(start.requestId, 'complete', artifact))

  assert.deepEqual(await settleWithin(assembly), { ok: false, code: 'sink-failed' })
  assert.equal(aborts, 1)
  lateConfirmation.resolve(true)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(aborts, 1, 'late confirmation must remain attached to the exact cleanup tombstone')
  channel.close()
})

test('main WebM finish owns a sink that opens after its request-queue deadline', async () => {
  const sinkId = `sink-${'a'.repeat(32)}`
  const lateBegin = deferred<{ sinkId: string }>()
  let aborts = 0
  const authority: WorldRenderWebmAuthority = {
    beginWebmAssembly: () => lateBegin.promise,
    readWebmFrameMaster: async () => { throw new Error('not expected') },
    readWebmAudioMaster: async () => { throw new Error('not expected') },
    writeWebmAssembly: async () => { throw new Error('not expected') },
    commitWebmAssembly: async () => { throw new Error('not expected') },
    confirmWebmAssembly: async () => { throw new Error('not expected') },
    abortWebmAssembly: async () => { aborts += 1; return true },
  }
  const { port, channel, context } = await initializedWebmChannel(authority, 10)
  const plan = createWorldWebmStartPayload(context)
  const assembly = channel.assembleWebm(plan, new AbortController().signal)
  const start = port.sent.at(-1) as { requestId: number }
  port.emitMessage(webmWorkerMessage(1, 'preflight', {
    width: plan.width, height: plan.height, fps: plan.fps,
    videoCodec: 'vp9', videoBitrate: plan.videoBitrate,
    audioCodec: 'opus', audioBitrate: plan.audioBitrate,
    audioSampleRate: 48_000, audioChannels: 2,
  }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(2, 'sink-begin', {}))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  port.emitMessage(webmWorkerMessage(start.requestId, 'error', {
    code: 'codec-encode-failed', message: 'encoder failed while begin was pending',
  }))

  assert.deepEqual(await settleWithin(assembly), { ok: false, code: 'sink-failed' })
  lateBegin.resolve({ sinkId })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(aborts, 1)
  channel.close()
})

test('late sink begin cleanup gates fallback eligibility and FFmpeg never starts without cleanup proof', async (t) => {
  for (const cleanupResult of ['true', 'reject', 'false', 'pending'] as const) {
    await t.test(cleanupResult, async () => {
      const sinkCharacter = cleanupResult === 'true' ? '5'
        : cleanupResult === 'reject' ? '6'
          : cleanupResult === 'false' ? '7' : '8'
      const sinkId = `sink-${sinkCharacter.repeat(32)}`
      const lateBegin = deferred<{ sinkId: string }>()
      const pendingAbort = deferred<true>()
      let aborts = 0
      let ffmpegStarts = 0
      const authority: WorldRenderWebmAuthority = {
        beginWebmAssembly: () => lateBegin.promise,
        readWebmFrameMaster: async () => { throw new Error('not expected') },
        readWebmAudioMaster: async () => { throw new Error('not expected') },
        writeWebmAssembly: async () => { throw new Error('not expected') },
        commitWebmAssembly: async () => { throw new Error('not expected') },
        confirmWebmAssembly: async () => { throw new Error('not expected') },
        abortWebmAssembly: () => {
          aborts += 1
          if (cleanupResult === 'reject') return Promise.reject(new Error('cleanup failed'))
          if (cleanupResult === 'false') return Promise.resolve(false as never)
          if (cleanupResult === 'true') return Promise.resolve(true)
          return pendingAbort.promise
        },
      }
      const { port, channel, context } = await initializedWebmChannel(authority, 15)
      const session: WorldRenderHostSession = {
        initialize: async () => {},
        renderFrame: async () => PNG.slice(),
        renderAudio: async () => WAV.slice(),
        assembleWebm: async (plan, signal) => {
          const assembly = channel.assembleWebm(plan, signal)
          const start = port.sent.at(-1) as { requestId: number }
          port.emitMessage(webmWorkerMessage(1, 'preflight', {
            width: plan.width, height: plan.height, fps: plan.fps,
            videoCodec: 'vp9', videoBitrate: plan.videoBitrate,
            audioCodec: 'opus', audioBitrate: plan.audioBitrate,
            audioSampleRate: 48_000, audioChannels: 2,
          }))
          await new Promise((resolvePromise) => setImmediate(resolvePromise))
          port.emitMessage(webmWorkerMessage(2, 'sink-begin', {}))
          await new Promise((resolvePromise) => setImmediate(resolvePromise))
          port.emitMessage(webmWorkerMessage(start.requestId, 'error', {
            code: 'codec-encode-failed', message: 'codec failed while sink begin was pending',
          }))
          await new Promise((resolvePromise) => setImmediate(resolvePromise))
          lateBegin.resolve({ sinkId })
          return assembly
        },
        dispose: async () => { channel.close() },
      }

      await new WorldRenderBrowserExecutor({
        createSession: async () => session,
        assembleWithFfmpeg: async () => { ffmpegStarts += 1; return true },
      }).execute(context)

      assert.equal(aborts, 1)
      assert.equal(
        ffmpegStarts,
        cleanupResult === 'true' ? 1 : 0,
        'only an exact true cleanup acknowledgement may reach FFmpeg',
      )
    })
  }
})

test('main WebM close, worker timeout, and cancellation settle despite stuck cleanup', async (t) => {
  for (const trigger of ['close', 'worker-timeout', 'cancel'] as const) {
    await t.test(trigger, async () => {
      const sinkCharacter = trigger === 'close' ? 'b' : trigger === 'worker-timeout' ? 'c' : 'd'
      const sinkId = `sink-${sinkCharacter.repeat(32)}`
      const lateAbort = deferred<true>()
      let aborts = 0
      const authority: WorldRenderWebmAuthority = {
        beginWebmAssembly: async () => ({ sinkId }),
        readWebmFrameMaster: async () => { throw new Error('not expected') },
        readWebmAudioMaster: async () => { throw new Error('not expected') },
        writeWebmAssembly: async () => { throw new Error('not expected') },
        commitWebmAssembly: async () => { throw new Error('not expected') },
        confirmWebmAssembly: async () => { throw new Error('not expected') },
        abortWebmAssembly: () => { aborts += 1; return lateAbort.promise },
      }
      const { port, channel, context } = await initializedWebmChannel(authority, 10)
      const plan = createWorldWebmStartPayload(context)
      const controller = new AbortController()
      const assembly = channel.assembleWebm(plan, controller.signal)
      await preflightAndBeginWebm(port, plan)
      if (trigger === 'close') channel.close()
      else if (trigger === 'worker-timeout') channel.fail(new Error('worker timeout'), 'worker-timeout')
      else controller.abort()

      if (trigger === 'worker-timeout') {
        assert.deepEqual(await settleWithin(assembly), { ok: false, code: 'sink-failed' })
      } else {
        await assert.rejects(settleWithin(assembly), (error: unknown) => error instanceof Error && error.name === 'AbortError')
      }
      assert.equal(aborts, 1)
      lateAbort.resolve(true)
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
      if (trigger !== 'close') channel.close()
    })
  }
})

import { parseWorldRenderHostInitializePayload } from '../../src/shared/types/worldRenderHost.ts'

test('actual pinned descriptor producer forwards exact source index including zero without paths or legacy mutation', () => {
  for (const clipIndex of [undefined, 0, 2]) {
    const { context } = executionContext()
    const model = { id: 'resource:model', type: 'model' as const, name: 'Model', workspacePath: 'Assets/model.glb', format: 'glb' as const }
    const animation = {
      id: 'resource:animation', type: 'animation' as const, name: 'Animation', workspacePath: model.workspacePath,
      format: 'gltf-clip' as const, clipName: 'Duplicate', clipId: 'animation:0', ...(clipIndex === undefined ? {} : { clipIndex }),
    }
    context.snapshot.project.resources = [model, animation]
    context.resources = [model, animation].map((resource) => ({ resource, files: [{ role: 'primary', originalWorkspacePath: resource.workspacePath, workspacePath: 'Exports/pinned.bin', size: 64, sha256: 'a'.repeat(64) }] }))
    context.scene.entities.push({
      id: 'entity:model', name: 'Model', parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [
        { id: 'component:model', type: 'renderable', enabled: true, resourceId: model.id, visible: true, castShadow: false, receiveShadow: false, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } },
        { id: 'component:animation', type: 'animation-player', enabled: true, resourceId: animation.id, autoplay: true, speed: -2, loop: false },
      ],
    })
    const before = structuredClone(context.snapshot)
    const payload = createWorldRenderHostInitializePayload(context)
    const descriptor = payload.snapshot.resources.find((resource) => resource.id === animation.id)!
    assert.equal(Reflect.get(descriptor, 'clipIndex'), clipIndex)
    assert.equal(Object.hasOwn(descriptor, 'clipIndex'), clipIndex !== undefined)
    assert.equal(descriptor.boundModelResourceId, model.id)
    assert.equal(Object.hasOwn(descriptor, 'workspacePath'), false)
    assert.equal(Object.hasOwn(descriptor.files[0], 'workspacePath'), false)
    assert.equal(parseWorldRenderHostInitializePayload(payload), payload)
    assert.deepEqual(context.snapshot, before)
  }
})
