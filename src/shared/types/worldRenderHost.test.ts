import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORLD_RENDER_HOST_PROTOCOL,
  parseWorldRenderHostCommand,
  parseWorldRenderHostResourcePortRequest,
  parseWorldRenderHostResourcePortResult,
  parseWorldRenderHostResponse,
  type WorldRenderHostCommand,
  type WorldRenderHostInitializePayload,
} from './worldRenderHost.ts'

const JOB_ID = 'render-11111111111111111111111111111111'
const GENERATION = '2'.repeat(32)
const SHA256 = 'a'.repeat(64)

function initializePayload(): WorldRenderHostInitializePayload {
  const sequence = {
    id: 'sequence:test',
    name: 'Test',
    duration: { numerator: 1, denominator: 10 },
    tracks: [],
  }
  return {
    snapshot: {
      snapshotSha256: SHA256,
      projectId: 'project:test',
      revision: 2,
      scene: {
        schema: 'modly.world-scene.v1',
        projectId: 'project:test',
        sceneId: 'scene:test',
        name: 'Test',
        environment: { backgroundColor: '#000000', ambientIntensity: 0 },
        entities: [{
          id: 'entity:camera',
          name: 'Camera',
          parentId: null,
          enabled: true,
          locked: false,
          tags: [],
          transform: { position: [0, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
          components: [{
            id: 'component:camera',
            type: 'camera',
            enabled: true,
            projection: 'perspective',
            primary: true,
            near: 0.1,
            far: 100,
            fieldOfView: 50,
          }],
        }],
        sequences: [sequence],
      },
      sequence,
      resources: [{
        id: 'resource:model',
        name: 'Model',
        type: 'model',
        format: 'glb',
        files: [{ role: 'primary', size: 64, sha256: SHA256 }],
      }],
    },
    preset: { width: 64, height: 64, fps: 30 },
    framePlan: [
      { index: 0, time: { numerator: 0, denominator: 1 }, duration: { numerator: 1, denominator: 30 }, timestampMicroseconds: 0 },
      { index: 1, time: { numerator: 1, denominator: 30 }, duration: { numerator: 1, denominator: 30 }, timestampMicroseconds: 33_333 },
      { index: 2, time: { numerator: 1, denominator: 15 }, duration: { numerator: 1, denominator: 30 }, timestampMicroseconds: 66_667 },
    ],
  }
}

function initializeCommand(): WorldRenderHostCommand {
  return {
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: JOB_ID,
    generation: GENERATION,
    requestId: 1,
    kind: 'initialize',
    payload: initializePayload(),
  }
}

test('host command parser accepts the exact bounded initialize envelope and rejects inconsistent plans', () => {
  const command = initializeCommand()
  assert.equal(parseWorldRenderHostCommand(command), command)

  const extra = structuredClone(command) as WorldRenderHostCommand & { path: string }
  extra.path = '/tmp/not-allowed'
  assert.equal(parseWorldRenderHostCommand(extra), null)

  const wrongTimestamp = structuredClone(command) as unknown as {
    kind: string
    payload: { framePlan: Array<{ timestampMicroseconds: number }> }
  }
  if (wrongTimestamp.kind !== 'initialize') throw new Error('fixture')
  wrongTimestamp.payload.framePlan[1].timestampMicroseconds = 12
  assert.equal(parseWorldRenderHostCommand(wrongTimestamp), null)

  const wrongDuration = structuredClone(command) as unknown as {
    kind: string
    payload: { framePlan: Array<{ duration: { numerator: number; denominator: number } }> }
  }
  if (wrongDuration.kind !== 'initialize') throw new Error('fixture')
  wrongDuration.payload.framePlan[2].duration = { numerator: 1, denominator: 29 }
  assert.equal(parseWorldRenderHostCommand(wrongDuration), null)

  const inherited = Object.assign(Object.create({ privileged: true }), command)
  assert.equal(parseWorldRenderHostCommand(inherited), null)
})

test('host command parser rejects accessors, sparse arrays, and oversized resource declarations without invoking getters', () => {
  let invoked = false
  const accessor = structuredClone(initializeCommand()) as unknown as Record<string, unknown>
  Object.defineProperty(accessor, 'payload', {
    enumerable: true,
    get() { invoked = true; return initializePayload() },
  })
  assert.equal(parseWorldRenderHostCommand(accessor), null)
  assert.equal(invoked, false)

  const sparse = structuredClone(initializeCommand()) as unknown as {
    kind: string
    payload: { framePlan: Array<unknown> }
  }
  if (sparse.kind !== 'initialize') throw new Error('fixture')
  sparse.payload.framePlan.length = 4
  assert.equal(parseWorldRenderHostCommand(sparse), null)

  const oversized = structuredClone(initializeCommand())
  if (oversized.kind !== 'initialize') throw new Error('fixture')
  oversized.payload.snapshot.resources[0].files[0].size = 512 * 1024 * 1024 + 1
  assert.equal(parseWorldRenderHostCommand(oversized), null)
})

test('resource messages require exact identities, request ids, metadata, and transferable byte lengths', () => {
  const request = {
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: JOB_ID,
    generation: GENERATION,
    kind: 'resource-request' as const,
    requestId: 7,
    resourceId: 'resource:model',
    role: 'primary' as const,
  }
  assert.deepEqual(parseWorldRenderHostResourcePortRequest(request), request)
  assert.equal(parseWorldRenderHostResourcePortRequest({ ...request, unexpected: true }), null)

  const bytes = new ArrayBuffer(64)
  const result = {
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: JOB_ID,
    generation: GENERATION,
    kind: 'resource-result' as const,
    requestId: 7,
    result: { ok: true as const, resourceId: 'resource:model', role: 'primary' as const, size: 64, sha256: SHA256, bytes },
  }
  assert.deepEqual(parseWorldRenderHostResourcePortResult(result), result)
  assert.equal(parseWorldRenderHostResourcePortResult({
    ...result,
    result: { ...result.result, size: 63 },
  }), null)
  assert.equal(parseWorldRenderHostResourcePortResult({
    ...result,
    result: { ok: false, code: 'resource-invalid', message: 'Pinned resource failed validation.', extra: true },
  }), null)
})

test('render responses require exact bounded raw RGBA and accept the GPU context failure code', () => {
  const rgba = new ArrayBuffer(64 * 64 * 4)
  const frame = {
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: JOB_ID,
    generation: GENERATION,
    requestId: 2,
    kind: 'render-frame' as const,
    ok: true as const,
    payload: { index: 0, width: 64, height: 64, rgbaSha256: SHA256, rgba },
  }
  assert.equal(parseWorldRenderHostResponse(frame), frame)
  assert.equal(parseWorldRenderHostResponse({ ...frame, payload: { ...frame.payload, width: 8_000 } }), null)
  assert.equal(parseWorldRenderHostResponse({
    ...frame,
    payload: { ...frame.payload, rgba: new ArrayBuffer(rgba.byteLength - 1) },
  }), null)
  assert.notEqual(parseWorldRenderHostResponse({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: JOB_ID,
    generation: GENERATION,
    requestId: 2,
    kind: 'render-frame',
    ok: false,
    error: { code: 'gpu-context-lost', message: 'WebGL context was lost.' },
  }), null)
  assert.equal(parseWorldRenderHostResponse({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: JOB_ID,
    generation: GENERATION,
    requestId: 2,
    kind: 'render-frame',
    ok: false,
    error: { code: 'render-failed', message: 'Failed.', path: '/tmp/private' },
  }), null)
})

function exactIndexedHostCommand(clipIndex?: unknown) {
  const command = initializeCommand()
  assert.equal(command.kind, 'initialize')
  if (command.kind !== 'initialize') throw new Error('Initialize fixture missing')
  const descriptor = {
    id: 'resource:animation', name: 'Animation', type: 'animation' as const, format: 'gltf-clip',
    boundModelResourceId: 'resource:model', files: [{ role: 'primary' as const, size: 64, sha256: SHA256 }],
  }
  if (arguments.length) Object.assign(descriptor, { clipIndex })
  command.payload.snapshot.resources = [...command.payload.snapshot.resources, descriptor]
  return command
}

test('strict pinned host admits exact glTF indices including zero and preserves omitted legacy selectors', () => {
  for (const clipIndex of [0, 2, Number.MAX_SAFE_INTEGER]) {
    const command = exactIndexedHostCommand(clipIndex)
    assert.equal(parseWorldRenderHostCommand(command), command)
  }
  const legacy = exactIndexedHostCommand()
  assert.equal(parseWorldRenderHostCommand(legacy), legacy)
})

test('strict pinned index gate rejects present undefined malformed non-glTF and unknown fields without widening name or duration', () => {
  for (const clipIndex of [undefined, null, '0', true, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseWorldRenderHostCommand(exactIndexedHostCommand(clipIndex)), null, String(clipIndex))
  }
  for (const extra of [
    { format: 'pose-clip' }, { type: 'model', format: 'glb' }, { type: 'audio', format: 'wav' },
    { type: 'environment', format: 'hdr' }, { metadata: {} }, { clipName: 'x'.repeat(257) },
    { clipName: 'x\u0001' }, { clipName: '' }, { durationSeconds: -1 }, { durationSeconds: 86_401 },
  ]) {
    const command = exactIndexedHostCommand(0)
    Object.assign(command.payload.snapshot.resources.at(-1)!, extra)
    assert.equal(parseWorldRenderHostCommand(command), null, JSON.stringify(extra))
  }
  const zeroDuration = exactIndexedHostCommand(0)
  Object.assign(zeroDuration.payload.snapshot.resources.at(-1)!, { durationSeconds: 0 })
  assert.equal(parseWorldRenderHostCommand(zeroDuration), zeroDuration, 'host duration semantics remain independently unchanged')
})
