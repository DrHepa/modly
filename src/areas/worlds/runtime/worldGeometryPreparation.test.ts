import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimeWorldSnapshot } from './_testFixtures.ts'
import { prepareWorldRuntimeGeometry, type WorldGeometrySourceRequest, type WorldPreparedGeometrySource } from './worldGeometryPreparation.ts'
import { planWorldRuntimeScene } from './worldRuntimeProjection.ts'

const triangleVertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
const tetraVertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])

test('prepares fixed static mesh source into numeric trimesh using signed entity scale', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:mesh', type: 'model', name: 'Mesh', workspacePath: 'Assets/mesh.glb', format: 'glb' })
  const ground = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:ground')!
  ground.transform.scale = [-2, 3, 0.5]
  ground.components[0] = {
    id: 'component:ground-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'mesh', resourceId: 'resource:mesh',
    sensor: false, friction: 0.8, restitution: 0, collisionLayer: 1, collisionMask: 0xffff,
  }
  const plan = planWorldRuntimeScene(snapshot, 'scene:one')
  assert.equal(plan.success, true)
  if (!plan.success) return
  const result = await prepareWorldRuntimeGeometry(plan.value, {
    apiUrl: 'http://127.0.0.1:8000',
    async loadModelGeometry(request: WorldGeometrySourceRequest): Promise<WorldPreparedGeometrySource> {
      assert.equal(request.url, 'http://127.0.0.1:8000/workspace/Assets/mesh.glb')
      return { success: true, resourceId: request.resourceId, format: request.format, byteLength: 48, meshes: [{ name: 'tri', vertices: triangleVertices, indices: new Uint32Array([0, 1, 2]), localMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], skinned: false, morphed: false, instanced: false }] }
    },
  }, new AbortController().signal)
  assert.equal(result.success, true)
  if (!result.success) return
  const shape = result.projection.physics.bodies.find((body) => body.entityId === 'entity:ground')?.colliders[0]?.shape
  assert.equal(shape?.kind, 'trimesh')
  if (shape?.kind === 'trimesh') {
    assert.deepEqual([...shape.vertices], [0, 0, 0, -2, 0, 0, 0, 3, 0])
    assert.deepEqual([...shape.indices], [0, 2, 1])
    assert.equal(result.transfer.includes(shape.vertices.buffer), true)
    assert.equal(result.transfer.includes(shape.indices.buffer), true)
  }
})


test('negative entity scale reverses trimesh winding while preserving signed vertices and inputs', async () => {
  const sourceVertices = new Float32Array(triangleVertices)
  const sourceIndices = new Uint32Array([0, 1, 2])
  const result = await prepareSingleMeshTrimesh([-1, 1, 1], [{
    name: 'neg-entity', vertices: sourceVertices, indices: sourceIndices,
    localMatrix: identityMatrix(), skinned: false, morphed: false, instanced: false,
  }])
  assert.equal(result.success, true)
  if (!result.success) return
  const shape = findGroundTrimesh(result.projection)
  assert.deepEqual([...shape.vertices], [0, 0, 0, -1, 0, 0, 0, 1, 0])
  assert.deepEqual([...shape.indices], [0, 2, 1])
  assert.deepEqual([...sourceVertices], [...triangleVertices])
  assert.deepEqual([...sourceIndices], [0, 1, 2])
})

test('reflected asset child reverses trimesh winding with positive entity scale', async () => {
  const result = await prepareSingleMeshTrimesh([1, 1, 1], [{
    name: 'reflected-child', vertices: triangleVertices, indices: new Uint32Array([0, 1, 2]),
    localMatrix: scaleMatrix(-1, 1, 1), skinned: false, morphed: false, instanced: false,
  }])
  assert.equal(result.success, true)
  if (!result.success) return
  const shape = findGroundTrimesh(result.projection)
  assert.deepEqual([...shape.vertices], [0, 0, 0, -1, 0, 0, 0, 1, 0])
  assert.deepEqual([...shape.indices], [0, 2, 1])
})

test('two reflections retain trimesh winding order', async () => {
  const result = await prepareSingleMeshTrimesh([-1, 1, 1], [{
    name: 'double-reflection', vertices: triangleVertices, indices: new Uint32Array([0, 1, 2]),
    localMatrix: scaleMatrix(-1, 1, 1), skinned: false, morphed: false, instanced: false,
  }])
  assert.equal(result.success, true)
  if (!result.success) return
  const shape = findGroundTrimesh(result.projection)
  assert.deepEqual([...shape.vertices], [0, 0, 0, 1, 0, 0, 0, 1, 0])
  assert.deepEqual([...shape.indices], [0, 1, 2])
})

test('multiple mesh parts apply winding parity per part with merge offsets', async () => {
  const second = new Float32Array([2, 0, 0, 3, 0, 0, 2, 1, 0])
  const result = await prepareSingleMeshTrimesh([-1, 1, 1], [
    { name: 'entity-reflected', vertices: triangleVertices, indices: new Uint32Array([0, 1, 2]), localMatrix: identityMatrix(), skinned: false, morphed: false, instanced: false },
    { name: 'double-reflected', vertices: second, indices: new Uint32Array([0, 1, 2]), localMatrix: scaleMatrix(-1, 1, 1), skinned: false, morphed: false, instanced: false },
  ])
  assert.equal(result.success, true)
  if (!result.success) return
  const shape = findGroundTrimesh(result.projection)
  assert.deepEqual([...shape.vertices], [0, 0, 0, -1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0])
  assert.deepEqual([...shape.indices], [0, 2, 1, 3, 4, 5])
})

test('positive nonuniform transform keeps trimesh winding order', async () => {
  const result = await prepareSingleMeshTrimesh([2, 3, 0.5], [{
    name: 'positive-nonuniform', vertices: triangleVertices, indices: new Uint32Array([0, 1, 2]),
    localMatrix: identityMatrix(), skinned: false, morphed: false, instanced: false,
  }])
  assert.equal(result.success, true)
  if (!result.success) return
  const shape = findGroundTrimesh(result.projection)
  assert.deepEqual([...shape.vertices], [0, 0, 0, 2, 0, 0, 0, 3, 0])
  assert.deepEqual([...shape.indices], [0, 1, 2])
})

test('prepares convex source into numeric convex hull and rejects unsupported source geometry before physics', async () => {
  const snapshot = createRuntimeWorldSnapshot()
  const crate = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:crate')!
  crate.components[0] = {
    id: 'component:crate-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'convex', resourceId: 'resource:hero',
    sensor: false, friction: 0.5, restitution: 0.1, collisionLayer: 4, collisionMask: 0xffff,
  }
  const plan = planWorldRuntimeScene(snapshot, 'scene:one')
  assert.equal(plan.success, true)
  if (!plan.success) return
  const ok = await prepareWorldRuntimeGeometry(plan.value, {
    apiUrl: 'http://127.0.0.1:8000',
    async loadModelGeometry(request) { return { success: true, resourceId: request.resourceId, format: request.format, byteLength: 48, meshes: [{ name: 'tetra', vertices: tetraVertices, indices: new Uint32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]), localMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], skinned: false, morphed: false, instanced: false }] } },
  }, new AbortController().signal)
  assert.equal(ok.success, true)
  if (ok.success) assert.equal(ok.projection.physics.bodies.find((body) => body.entityId === 'entity:crate')?.colliders[0]?.shape.kind, 'convexHull')

  const bad = await prepareWorldRuntimeGeometry(plan.value, {
    apiUrl: 'http://127.0.0.1:8000',
    async loadModelGeometry(request) { return { success: false, resourceId: request.resourceId, code: 'unsupported-physics-geometry-source', message: 'Point clouds are not mesh collider geometry.' } },
  }, new AbortController().signal)
  assert.equal(bad.success, false)
  if (!bad.success) assert.equal(bad.issues[0]?.code, 'unsupported-physics-geometry-source')
})

test('default GLB loader extracts indexed and non-indexed triangle geometry with child transforms', async () => {
  const glb = makeGlb({ indexed: true, matrix: [2, 0, 0, 0, 0, -3, 0, 0, 0, 0, 0.5, 0, 1, 2, 3, 1] })
  const source = await import('./worldGeometryPreparation.ts').then((module) => module.loadWorldGeometrySource({ generationId: 1, resourceId: 'resource:glb', workspacePath: 'Assets/mesh.glb', format: 'glb', url: dataUrl(glb, 'model/gltf-binary') }, new AbortController().signal))
  assert.equal(source.success, true)
  if (!source.success) return
  assert.equal(source.meshes.length, 1)
  assert.deepEqual([...source.meshes[0]!.indices], [0, 1, 2])
  assert.deepEqual(source.meshes[0]!.localMatrix.map((value) => Math.round(value * 1000) / 1000), [2, 0, 0, 0, 0, -3, 0, 0, 0, 0, 0.5, 0, 1, 2, 3, 1])

  const nonIndexed = await import('./worldGeometryPreparation.ts').then((module) => module.loadWorldGeometrySource({ generationId: 1, resourceId: 'resource:glb', workspacePath: 'Assets/nonindexed.glb', format: 'glb', url: dataUrl(makeGlb({ indexed: false }), 'model/gltf-binary') }, new AbortController().signal))
  assert.equal(nonIndexed.success, true)
  if (nonIndexed.success) assert.deepEqual([...nonIndexed.meshes[0]!.indices], [0, 1, 2])
})


test('default GLB loader reflected child transform reverses prepared trimesh winding', async () => {
  const loaded = await import('./worldGeometryPreparation.ts').then((module) => module.loadWorldGeometrySource({
    generationId: 1, resourceId: 'resource:reflected-glb', workspacePath: 'Assets/reflected.glb', format: 'glb',
    url: dataUrl(makeGlb({ indexed: true, matrix: [...scaleMatrix(-1, 1, 1)] }), 'model/gltf-binary'),
  }, new AbortController().signal))
  assert.equal(loaded.success, true, JSON.stringify(loaded))
  if (!loaded.success) return
  const result = await prepareSingleMeshTrimesh([1, 1, 1], loaded.meshes)
  assert.equal(result.success, true)
  if (!result.success) return
  const shape = findGroundTrimesh(result.projection)
  assert.deepEqual([...shape.vertices], [0, 0, 0, -1, 0, 0, 0, 1, 0])
  assert.deepEqual([...shape.indices], [0, 2, 1])
})

test('default PLY loader accepts face meshes and rejects point-only PLY', async () => {
  const ply = `ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n`
  const source = await import('./worldGeometryPreparation.ts').then((module) => module.loadWorldGeometrySource({ generationId: 1, resourceId: 'resource:ply', workspacePath: 'Assets/mesh.ply', format: 'ply-mesh', url: dataUrl(new TextEncoder().encode(ply).buffer, 'application/octet-stream') }, new AbortController().signal))
  assert.equal(source.success, true)
  if (source.success) assert.deepEqual([...source.meshes[0]!.indices], [0, 1, 2])

  const points = `ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n`
  const bad = await import('./worldGeometryPreparation.ts').then((module) => module.loadWorldGeometrySource({ generationId: 1, resourceId: 'resource:points', workspacePath: 'Assets/points.ply', format: 'ply-mesh', url: dataUrl(new TextEncoder().encode(points).buffer, 'application/octet-stream') }, new AbortController().signal))
  assert.equal(bad.success, false)
  if (!bad.success) assert.equal(bad.code, 'unsupported-physics-geometry-source')
})

test('default GLTF loader rejects external dependencies instead of fetching them', async () => {
  const gltf = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin', byteLength: 12 }], meshes: [] })
  const result = await import('./worldGeometryPreparation.ts').then((module) => module.loadWorldGeometrySource({ generationId: 1, resourceId: 'resource:gltf', workspacePath: 'Assets/mesh.gltf', format: 'gltf', url: dataUrl(new TextEncoder().encode(gltf).buffer, 'model/gltf+json') }, new AbortController().signal))
  assert.equal(result.success, false)
  if (!result.success) assert.equal(result.code, 'unsupported-physics-gltf-dependency')
})


async function prepareSingleMeshTrimesh(entityScale: [number, number, number], meshes: NonNullable<Extract<WorldPreparedGeometrySource, { success: true }>['meshes']>) {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:mesh', type: 'model', name: 'Mesh', workspacePath: 'Assets/mesh.glb', format: 'glb' })
  const ground = snapshot.scenes[0].entities.find((entity) => entity.id === 'entity:ground')!
  ground.transform.scale = entityScale
  ground.components[0] = {
    id: 'component:ground-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'mesh', resourceId: 'resource:mesh',
    sensor: false, friction: 0.8, restitution: 0, collisionLayer: 1, collisionMask: 0xffff,
  }
  const plan = planWorldRuntimeScene(snapshot, 'scene:one')
  assert.equal(plan.success, true)
  if (!plan.success) throw new Error('Expected valid runtime plan')
  return prepareWorldRuntimeGeometry(plan.value, {
    apiUrl: 'http://127.0.0.1:8000',
    async loadModelGeometry(request: WorldGeometrySourceRequest): Promise<WorldPreparedGeometrySource> {
      return { success: true, resourceId: request.resourceId, format: request.format, byteLength: 48, meshes }
    },
  }, new AbortController().signal)
}

function findGroundTrimesh(projection: { physics: { bodies: Array<{ entityId: string; colliders: Array<{ shape: unknown }> }> } }) {
  const shape = projection.physics.bodies.find((body) => body.entityId === 'entity:ground')?.colliders[0]?.shape
  assert.equal((shape as { kind?: string } | undefined)?.kind, 'trimesh')
  return shape as { kind: 'trimesh'; vertices: Float32Array; indices: Uint32Array }
}

function identityMatrix(): readonly number[] { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }

function scaleMatrix(x: number, y: number, z: number): readonly number[] { return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1] }

function dataUrl(data: ArrayBuffer, type: string) {
  return `data:${type};base64,${Buffer.from(data).toString('base64')}`
}

function makeGlb(options: { indexed: boolean; matrix?: number[] }): ArrayBuffer {
  const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint32Array([0, 1, 2])
  const vertexBytes = new Uint8Array(vertices.buffer)
  const indexBytes = options.indexed ? new Uint8Array(indices.buffer) : new Uint8Array(0)
  const bin = new Uint8Array(align4(vertexBytes.byteLength + indexBytes.byteLength))
  bin.set(vertexBytes, 0)
  bin.set(indexBytes, vertexBytes.byteLength)
  const accessors = [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }]
  const primitives: Record<string, unknown> = { attributes: { POSITION: 0 }, mode: 4 }
  const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: vertexBytes.byteLength, target: 34962 }]
  if (options.indexed) {
    bufferViews.push({ buffer: 0, byteOffset: vertexBytes.byteLength, byteLength: indexBytes.byteLength, target: 34963 })
    accessors.push({ bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR', min: [0], max: [2] })
    primitives.indices = 1
  }
  const json = { asset: { version: '2.0' }, buffers: [{ byteLength: bin.byteLength }], bufferViews, accessors, meshes: [{ primitives: [primitives] }], nodes: [{ mesh: 0, ...(options.matrix ? { matrix: options.matrix } : {}) }], scenes: [{ nodes: [0] }], scene: 0 }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const paddedJson = new Uint8Array(align4(jsonBytes.byteLength)); paddedJson.set(jsonBytes); paddedJson.fill(0x20, jsonBytes.byteLength)
  const total = 12 + 8 + paddedJson.byteLength + 8 + bin.byteLength
  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  let offset = 0
  view.setUint32(offset, 0x46546c67, true); offset += 4
  view.setUint32(offset, 2, true); offset += 4
  view.setUint32(offset, total, true); offset += 4
  view.setUint32(offset, paddedJson.byteLength, true); offset += 4
  view.setUint32(offset, 0x4e4f534a, true); offset += 4
  new Uint8Array(out, offset, paddedJson.byteLength).set(paddedJson); offset += paddedJson.byteLength
  view.setUint32(offset, bin.byteLength, true); offset += 4
  view.setUint32(offset, 0x004e4942, true); offset += 4
  new Uint8Array(out, offset, bin.byteLength).set(bin)
  return out
}

function align4(value: number): number { return (value + 3) & ~3 }

test('GLB preflight rejects oversized accessors before parser allocation', async () => {
  const glb = makeGlbWithJson({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 0 }],
    bufferViews: [],
    accessors: [{ componentType: 5126, count: 100_000, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  }, new Uint8Array(0).buffer)
  const result = await import('./worldGeometryPreparation.ts').then((module) => module.loadWorldGeometrySource({ generationId: 1, resourceId: 'resource:huge', workspacePath: 'Assets/huge.glb', format: 'glb', url: dataUrl(glb, 'model/gltf-binary') }, new AbortController().signal))
  assert.equal(result.success, false)
  if (!result.success) assert.equal(result.code, 'physics-geometry-limit-exceeded')
})

test('bounded stream fetch cancels and releases on overflow before parser work', async () => {
  const originalFetch = globalThis.fetch
  let cancelled = false
  let chunks = 0
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      chunks += 1
      controller.enqueue(new Uint8Array(5 * 1024 * 1024))
    },
    cancel() { cancelled = true },
  }))
  try {
    const result = await import('./worldGeometryPreparation.ts').then((module) => module.loadWorldGeometrySource({ generationId: 1, resourceId: 'resource:overflow', workspacePath: 'Assets/overflow.glb', format: 'glb', url: 'http://127.0.0.1:8000/workspace/Assets/overflow.glb' }, new AbortController().signal))
    assert.equal(result.success, false)
    assert.equal(cancelled, true)
    assert.ok(chunks >= 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('default GLB loader extracts interleaved POSITION without copying adjacent NORMAL data', async () => {
  const glb = makeInterleavedGlb()
  const result = await import('./worldGeometryPreparation.ts').then((module) => module.loadWorldGeometrySource({ generationId: 1, resourceId: 'resource:interleaved', workspacePath: 'Assets/interleaved.glb', format: 'glb', url: dataUrl(glb, 'model/gltf-binary') }, new AbortController().signal))
  assert.equal(result.success, true, JSON.stringify(result))
  if (!result.success) return
  assert.deepEqual([...result.meshes[0]!.vertices], [0, 0, 0, 1, 0, 0, 0, 1, 0])
})

function makeGlbWithJson(json: unknown, bin: ArrayBuffer): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const paddedJson = new Uint8Array(align4(jsonBytes.byteLength)); paddedJson.set(jsonBytes); paddedJson.fill(0x20, jsonBytes.byteLength)
  const paddedBin = new Uint8Array(align4(bin.byteLength)); paddedBin.set(new Uint8Array(bin))
  const total = 12 + 8 + paddedJson.byteLength + (paddedBin.byteLength > 0 ? 8 + paddedBin.byteLength : 0)
  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  let offset = 0
  view.setUint32(offset, 0x46546c67, true); offset += 4
  view.setUint32(offset, 2, true); offset += 4
  view.setUint32(offset, total, true); offset += 4
  view.setUint32(offset, paddedJson.byteLength, true); offset += 4
  view.setUint32(offset, 0x4e4f534a, true); offset += 4
  new Uint8Array(out, offset, paddedJson.byteLength).set(paddedJson); offset += paddedJson.byteLength
  if (paddedBin.byteLength > 0) {
    view.setUint32(offset, paddedBin.byteLength, true); offset += 4
    view.setUint32(offset, 0x004e4942, true); offset += 4
    new Uint8Array(out, offset, paddedBin.byteLength).set(paddedBin)
  }
  return out
}

function makeInterleavedGlb(): ArrayBuffer {
  const rows = new Float32Array([
    0, 0, 0, 9, 9, 9,
    1, 0, 0, 8, 8, 8,
    0, 1, 0, 7, 7, 7,
  ])
  const indices = new Uint32Array([0, 1, 2])
  const vertexBytes = new Uint8Array(rows.buffer)
  const indexBytes = new Uint8Array(indices.buffer)
  const bin = new Uint8Array(align4(vertexBytes.byteLength + indexBytes.byteLength))
  bin.set(vertexBytes, 0); bin.set(indexBytes, vertexBytes.byteLength)
  return makeGlbWithJson({
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: vertexBytes.byteLength, byteStride: 24, target: 34962 },
      { buffer: 0, byteOffset: vertexBytes.byteLength, byteLength: indexBytes.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR', min: [0], max: [2] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  }, bin.buffer)
}
