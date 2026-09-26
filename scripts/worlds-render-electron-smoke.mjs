#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { inflateSync } from 'node:zlib'
import { app, BrowserWindow } from 'electron'
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input, WEBM } from 'mediabunny'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const internal = require(join(root, 'out', 'main', 'world-render-internal.js'))
const {
  createElectronWorldRenderHostSession,
  WorldRenderBrowserExecutor,
  WorldRenderJobService,
  WorldRenderOutputRepository,
} = internal

const PROJECT_KEY = 'world-11111111111111111111111111111111'
const JOB_ID = 'render-11111111111111111111111111111111'
const PARTIAL_JOB_ID = 'render-22222222222222222222222222222222'
const CANCEL_JOB_ID = 'render-33333333333333333333333333333333'
const GPU_JOB_ID = 'render-44444444444444444444444444444444'

let workspace = ''
let exitCode = 1

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
  // The smoke owns no shared-memory contract and must also run in restricted
  // CI containers whose /dev/shm mount is too small for Chromium's GPU process.
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}
app.on('window-all-closed', () => {})

const watchdog = setTimeout(() => {
  console.error('worlds-render-electron-smoke: FAIL (watchdog timeout)')
  app.exit(1)
}, 75_000)

async function runSmoke() {
try {
  await app.whenReady()
  console.log('worlds-render-electron-smoke: app-ready')
  workspace = await mkdtemp(join(tmpdir(), 'modly-world-render-smoke-'))
  await mkdir(join(workspace, 'Assets'), { recursive: true })
  await writeFile(join(workspace, 'Assets', 'triangle.glb'), triangleGlb())
  await writeFile(join(workspace, 'Assets', 'tone.wav'), toneWav())
  const snapshot = authoredSnapshot()
  const ids = [JOB_ID, PARTIAL_JOB_ID, CANCEL_JOB_ID, GPU_JOB_ID]
  const outputRepository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => workspace,
    createJobId: () => ids.shift(),
  })
  const executor = new WorldRenderBrowserExecutor({ outputRepository, timeoutMs: 30_000 })
  const service = new WorldRenderJobService({
    projectReader: { open: async () => ({ ok: true, value: { status: 'ready', projectKey: PROJECT_KEY, snapshot, durabilityWarnings: [] } }) },
    outputRepository,
    executor,
  })

  const created = await service.create({
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    sceneId: 'scene:main',
    sequenceId: 'sequence:short',
    preset: { width: 64, height: 64, fps: 30 },
  })
  assert.equal(created.ok, true, created.ok ? undefined : created.error.code)
  console.log('worlds-render-electron-smoke: job-created')
  await service.whenIdle()
  console.log('worlds-render-electron-smoke: job-idle')
  const completed = await service.get({ jobId: JOB_ID })
  assert.equal(completed.ok, true)
  assert.equal(completed.value.status, 'succeeded', JSON.stringify(completed.value.error))
  assert.ok(completed.value.outputs.webm)
  assert.ok(completed.value.outputs.renderManifest)
  assert.equal(completed.value.outputs.frames.length, 3)
  assert.deepEqual(completed.value.outputs.frames.map((frame) => frame.timestampMicroseconds), [0, 33_333, 66_667])
  for (const frame of completed.value.outputs.frames) {
    const png = await readFile(join(workspace, frame.workspacePath))
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(png.readUInt32BE(16), 64)
    assert.equal(png.readUInt32BE(20), 64)
    assert.equal(png.includes(Buffer.from('grid', 'utf8')), false)
    assert.equal(png.includes(Buffer.from('gizmo', 'utf8')), false)
    const rgba = decodeRgbaPng(png)
    const colors = new Set()
    for (let index = 0; index < rgba.length; index += 4) {
      colors.add(`${rgba[index]}:${rgba[index + 1]}:${rgba[index + 2]}:${rgba[index + 3]}`)
    }
    assert.ok(colors.size >= 2, 'rendered frame must contain model pixels distinct from the background')
  }
  const wav = await readFile(join(workspace, completed.value.outputs.audio.workspacePath))
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE')
  assert.equal(wav.readUInt16LE(22), 2)
  assert.equal(wav.readUInt32LE(24), 48_000)
  assert.equal(wav.readUInt32LE(40), 4_800 * 4)
  assert.equal(wav.length, 44 + 4_800 * 4)
  assert.ok(wav.subarray(44).some((byte) => byte !== 0), 'decoded audio resource must produce non-silent PCM')
  const webm = await readFile(join(workspace, completed.value.outputs.webm.workspacePath))
  assert.equal(webm.byteLength, completed.value.outputs.webm.size)
  const webmEvidence = await inspectWebm(webm)
  assert.equal(webmEvidence.videoCodec, 'vp9')
  assert.equal(webmEvidence.audioCodec, 'opus')
  assert.equal(webmEvidence.videoPackets, 3)
  assert.deepEqual(webmEvidence.videoTimestampsMicroseconds.map((value, index) => (
    Math.abs(value - [0, 33_333, 66_667][index]) <= 1_000
  )), [true, true, true])
  assert.ok(Math.abs(webmEvidence.videoDuration - webmEvidence.audioDuration) <= 1 / 30)
  console.log(`worlds-render-electron-smoke: masters frames=3 timestamps=0,33333,66667 png=${completed.value.outputs.frames.map((frame) => frame.sha256).join(',')} wav=${completed.value.outputs.audio.sha256} samples=4800 channels=2 rate=48000 status=succeeded webm=${completed.value.outputs.webm.sha256} codecs=vp9,opus drift=${Math.abs(webmEvidence.videoDuration - webmEvidence.audioDuration)}`)
  assert.equal(BrowserWindow.getAllWindows().length, 0)

  const partialExecutor = new WorldRenderBrowserExecutor({
    createSession: async (input) => {
      const session = await createElectronWorldRenderHostSession({ ...input, outputRepository })
      return {
        initialize: (payload, signal) => session.initialize(payload, signal),
        renderFrame: (payload, signal) => session.renderFrame(payload, signal),
        renderAudio: (signal) => session.renderAudio(signal),
        assembleWebm: async () => ({ ok: false, code: 'codec-unavailable' }),
        dispose: () => session.dispose(),
      }
    },
    timeoutMs: 30_000,
  })
  const partialService = new WorldRenderJobService({
    projectReader: { open: async () => ({ ok: true, value: { status: 'ready', projectKey: PROJECT_KEY, snapshot: authoredSnapshot(), durabilityWarnings: [] } }) },
    outputRepository,
    executor: partialExecutor,
  })
  const partialCreated = await partialService.create({
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    sceneId: 'scene:main',
    sequenceId: 'sequence:short',
    preset: { width: 64, height: 64, fps: 30 },
  })
  assert.equal(partialCreated.ok, true)
  await partialService.whenIdle()
  const partial = await partialService.get({ jobId: PARTIAL_JOB_ID })
  assert.equal(partial.ok, true)
  assert.equal(partial.value.status, 'partial')
  assert.equal(partial.value.outputs.frames.length, 3)
  assert.ok(partial.value.outputs.audio)
  assert.equal(partial.value.outputs.webm, null)
  await partialExecutor.shutdown()
  console.log('worlds-render-electron-smoke: codec-unavailable-injected status=partial masters=preserved webm=none')

  const cancelSnapshot = authoredSnapshot()
  cancelSnapshot.scenes[0].sequences[0] = {
    ...cancelSnapshot.scenes[0].sequences[0],
    id: 'sequence:cancel',
    duration: { numerator: 10, denominator: 1 },
  }
  const cancelService = new WorldRenderJobService({
    projectReader: { open: async () => ({ ok: true, value: { status: 'ready', projectKey: PROJECT_KEY, snapshot: cancelSnapshot, durabilityWarnings: [] } }) },
    outputRepository,
    executor,
  })
  const queued = await cancelService.create({
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    sceneId: 'scene:main',
    sequenceId: 'sequence:cancel',
    preset: { width: 64, height: 64, fps: 30 },
  })
  assert.equal(queued.ok, true)
  await waitFor(() => BrowserWindow.getAllWindows().length === 1, 10_000)
  const cancelResult = await cancelService.cancel({ jobId: CANCEL_JOB_ID })
  assert.equal(cancelResult.ok, true)
  assert.equal(cancelResult.value.status, 'cancel_requested')
  await cancelService.whenIdle()
  const cancelled = await cancelService.get({ jobId: CANCEL_JOB_ID })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.value.status, 'cancelled')
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  console.log('worlds-render-electron-smoke: cancellation active-window=1 status=cancelled windows=0')

  const gpuSnapshot = authoredSnapshot()
  gpuSnapshot.scenes[0].sequences[0] = {
    ...gpuSnapshot.scenes[0].sequences[0],
    id: 'sequence:gpu',
    duration: { numerator: 10, denominator: 1 },
  }
  const gpuService = new WorldRenderJobService({
    projectReader: { open: async () => ({ ok: true, value: { status: 'ready', projectKey: PROJECT_KEY, snapshot: gpuSnapshot, durabilityWarnings: [] } }) },
    outputRepository,
    executor,
  })
  const gpuQueued = await gpuService.create({
    projectKey: PROJECT_KEY,
    expectedRevision: 1,
    sceneId: 'scene:main',
    sequenceId: 'sequence:gpu',
    preset: { width: 64, height: 64, fps: 30 },
  })
  assert.equal(gpuQueued.ok, true)
  await waitFor(() => BrowserWindow.getAllWindows().length === 1, 10_000)
  const gpuWindow = BrowserWindow.getAllWindows()[0]
  await waitForAsync(async () => {
    if (!gpuWindow || gpuWindow.isDestroyed()) return false
    return gpuWindow.webContents.executeJavaScript("Boolean(document.querySelector('canvas'))")
  }, 10_000)
  const dispatchResult = await gpuWindow.webContents.executeJavaScript(`
    document.querySelector('canvas').dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
  `)
  assert.equal(dispatchResult, false, 'webglcontextlost must be prevented')
  await gpuService.whenIdle()
  const gpuFailed = await gpuService.get({ jobId: GPU_JOB_ID })
  assert.equal(gpuFailed.ok, true)
  assert.equal(gpuFailed.value.status, 'failed')
  assert.equal(gpuFailed.value.error?.code, 'output_invalid')
  assert.equal(gpuFailed.value.error?.issues?.some((issue) => issue.code === 'gpu-context-lost'), true)
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  console.log('worlds-render-electron-smoke: gpu-context-lost status=failed issue=gpu-context-lost windows=0')

  await executor.shutdown()
  exitCode = 0
  process.stdout.write('worlds-render-electron-smoke: PASS\n')
} catch (error) {
  console.error(`worlds-render-electron-smoke: FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  clearTimeout(watchdog)
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy()
  if (workspace) await rm(workspace, { recursive: true, force: true })
  app.exit(exitCode)
}
}

void runSmoke()

function authoredSnapshot() {
  const sequence = {
    id: 'sequence:short',
    name: 'Short',
    duration: { numerator: 1, denominator: 10 },
    tracks: [{
      id: 'track:model-transform', type: 'transform', entityId: 'entity:model',
      keyframes: [
        { id: 'key:model:0', time: { numerator: 0, denominator: 1 }, value: { rotation: [0, 0, 0] } },
        { id: 'key:model:1', time: { numerator: 1, denominator: 10 }, value: { rotation: [0, 0.3, 0] } },
      ],
    }],
  }
  const scene = {
    schema: 'modly.world-scene.v1', projectId: 'project:smoke', sceneId: 'scene:main', name: 'Smoke',
    environment: { backgroundColor: '#102030', ambientIntensity: 0.65 },
    entities: [
      {
        id: 'entity:model', name: 'Triangle', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{
          id: 'component:model', type: 'renderable', enabled: true, resourceId: 'resource:triangle', visible: true,
          castShadow: false, receiveShadow: false,
          material: { baseColor: '#ff6030', metallic: 0, roughness: 0.7, opacity: 1 },
        }],
      },
      {
        id: 'entity:camera', name: 'Camera', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [0, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 50 }],
      },
      {
        id: 'entity:audio', name: 'Tone', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{
          id: 'component:audio', type: 'audio-source', enabled: true, resourceId: 'resource:tone',
          autoplay: true, loop: false, volume: 0.4, spatial: false, maxDistance: 20,
        }],
      },
    ],
    sequences: [sequence],
  }
  return {
    project: {
      schema: 'modly.world-project.v1', projectId: 'project:smoke', name: 'Smoke', revision: 1,
      resources: [
        { id: 'resource:triangle', type: 'model', name: 'Triangle', workspacePath: 'Assets/triangle.glb', format: 'glb' },
        { id: 'resource:tone', type: 'audio', name: 'Tone', workspacePath: 'Assets/tone.wav', format: 'wav' },
      ],
      scenes: [{ id: 'scene:main', name: 'Smoke', documentPath: `Worlds/${PROJECT_KEY}/scenes/main.world-scene.json` }],
      startSceneId: 'scene:main', inputActions: [],
      graphicsProfiles: [{ id: 'graphics:smoke', name: 'Smoke', renderScale: 1, shadowQuality: 'off', antialiasing: 'off' }],
      activeGraphicsProfileId: 'graphics:smoke',
    },
    scenes: [scene],
  }
}

function triangleGlb() {
  const positions = Buffer.alloc(36)
  ;[-1, -1, 0, 1, -1, 0, 0, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4))
  const indices = Buffer.alloc(8)
  indices.writeUInt16LE(0, 0)
  indices.writeUInt16LE(1, 2)
  indices.writeUInt16LE(2, 4)
  const binary = Buffer.concat([positions, indices])
  const document = {
    asset: { version: '2.0', generator: 'Modly smoke' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0.25, 0.08, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    buffers: [{ byteLength: 44 }],
  }
  const jsonRaw = Buffer.from(JSON.stringify(document))
  const json = Buffer.alloc(Math.ceil(jsonRaw.length / 4) * 4, 0x20)
  jsonRaw.copy(json)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(json.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(binary.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, json, binHeader, binary])
}

function toneWav() {
  const sampleRate = 48_000
  const sampleCount = 4_800
  const bytes = Buffer.alloc(44 + sampleCount * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(sampleCount * 2, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    bytes.writeInt16LE(Math.round(Math.sin(index * Math.PI * 2 * 440 / sampleRate) * 8_000), 44 + index * 2)
  }
  return bytes
}

function decodeRgbaPng(png) {
  assert.deepEqual([...png.subarray(12, 16)], [...Buffer.from('IHDR')])
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.equal(png[24], 8, 'PNG smoke decoder requires 8-bit channels')
  assert.equal(png[25], 6, 'PNG smoke decoder requires RGBA pixels')
  const chunks = []
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset)
    const kind = png.subarray(offset + 4, offset + 8).toString('ascii')
    const end = offset + 12 + length
    assert.ok(end <= png.length, 'PNG chunk must be bounded')
    if (kind === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset = end
    if (kind === 'IEND') break
  }
  const filtered = inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  assert.equal(filtered.length, (stride + 1) * height)
  const rgba = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[row * (stride + 1)]
    for (let column = 0; column < stride; column += 1) {
      const encoded = filtered[row * (stride + 1) + 1 + column]
      const left = column >= 4 ? rgba[row * stride + column - 4] : 0
      const above = row > 0 ? rgba[(row - 1) * stride + column] : 0
      const upperLeft = row > 0 && column >= 4 ? rgba[(row - 1) * stride + column - 4] : 0
      const value = filter === 0 ? encoded
        : filter === 1 ? encoded + left
          : filter === 2 ? encoded + above
            : filter === 3 ? encoded + Math.floor((left + above) / 2)
              : filter === 4 ? encoded + paeth(left, above, upperLeft)
                : Number.NaN
      assert.ok(Number.isFinite(value), `unsupported PNG filter ${filter}`)
      rgba[row * stride + column] = value & 0xff
    }
  }
  return rgba
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance ? above : upperLeft
}

async function inspectWebm(bytes) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) })
  try {
    assert.equal(await input.getFormat(), WEBM)
    const [video, audio] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ])
    assert.ok(video)
    assert.ok(audio)
    const [videoCodec, audioCodec, width, height, channels, sampleRate, videoStats, videoDuration, audioDuration] = await Promise.all([
      video.getCodec(),
      audio.getCodec(),
      video.getCodedWidth(),
      video.getCodedHeight(),
      audio.getNumberOfChannels(),
      audio.getSampleRate(),
      video.computePacketStats(),
      video.computeDuration(),
      audio.computeDuration(),
    ])
    assert.equal(width, 64)
    assert.equal(height, 64)
    assert.equal(channels, 2)
    assert.equal(sampleRate, 48_000)
    const videoTimestampsMicroseconds = []
    for await (const packet of new EncodedPacketSink(video).packets(undefined, undefined, { metadataOnly: true })) {
      videoTimestampsMicroseconds.push(packet.microsecondTimestamp)
    }
    return {
      videoCodec,
      audioCodec,
      videoPackets: videoStats.packetCount,
      videoTimestampsMicroseconds,
      videoDuration,
      audioDuration,
    }
  } finally {
    input.dispose()
  }
}

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for the hidden render window.')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
}

async function waitForAsync(predicate, timeoutMs) {
  const startedAt = Date.now()
  while (!(await predicate())) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for the hidden render canvas.')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
}
