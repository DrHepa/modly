import { BufferGeometry, InstancedMesh, LoadingManager, Matrix4, Mesh, SkinnedMesh, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'

import { createWorldWorkspaceUrl } from '../worldWorkspaceUrl.ts'
import { parseWorldPhysicsMainMessage, WORLD_PHYSICS_GEOMETRY_LIMITS, WORLD_PHYSICS_PROTOCOL_VERSION, type WorldPhysicsBodyDto, type WorldPhysicsColliderDto, type WorldPhysicsColliderShapeDto, type WorldPhysicsSceneDto } from './worldPhysicsProtocol.ts'
import type { WorldRuntimeProjectionIssue, WorldRuntimeScenePlan, WorldRuntimeSceneProjection } from './worldRuntimeProjection.ts'

const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_CHAIN_GEOMETRY_BYTES = 8 * 1024 * 1024
const MAX_GLTF_JSON_ITEMS = 65_536
const MAX_GLTF_NODE_DEPTH = 256
const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const)

export interface WorldGeometryPreparationDependencies {
  apiUrl: string
  loadModelGeometry(source: WorldGeometrySourceRequest, signal: AbortSignal): Promise<WorldPreparedGeometrySource>
}

export interface WorldGeometrySourceRequest {
  generationId: number
  resourceId: string
  workspacePath: string
  format: 'glb' | 'gltf' | 'ply-mesh'
  url: string
}

export type WorldPreparedGeometrySource =
  | { success: true; resourceId: string; format: 'glb' | 'gltf' | 'ply-mesh'; meshes: WorldPreparedMesh[]; byteLength: number }
  | { success: false; resourceId: string; code: string; message: string }

export interface WorldPreparedMesh {
  name: string
  vertices: Float32Array
  indices: Uint32Array
  localMatrix: readonly number[]
  skinned: boolean
  morphed: boolean
  instanced: boolean
}

export type PrepareWorldRuntimeGeometryResult =
  | { success: true; projection: WorldRuntimeSceneProjection; transfer: Transferable[]; byteLength: number }
  | { success: false; issues: WorldRuntimeProjectionIssue[] }

export async function prepareWorldRuntimeGeometry(
  plan: WorldRuntimeScenePlan,
  deps: WorldGeometryPreparationDependencies,
  signal: AbortSignal,
  generationId = 0,
): Promise<PrepareWorldRuntimeGeometryResult> {
  if (signal.aborted) return geometryFailure('runtime-load-cancelled', 'geometry', 'Runtime scene load was superseded.')
  const sourceCache = new Map<string, WorldPreparedGeometrySource>()
  const chargedSources = new Set<string>()
  let totalBytes = 0
  const transfer: Transferable[] = []
  const bodies: WorldPhysicsBodyDto[] = []
  for (const body of plan.physics.bodies) {
    const colliders: WorldPhysicsColliderDto[] = []
    for (const collider of body.colliders) {
      if (collider.shape.kind !== 'convexHullSource' && collider.shape.kind !== 'trimeshSource') {
        colliders.push({ ...collider, shape: collider.shape })
        continue
      }
      const sourceKey = `${collider.shape.resourceId}\0${collider.shape.resourceWorkspacePath}\0${collider.shape.resourceFormat}`
      let source = sourceCache.get(sourceKey)
      if (!source) {
        const request: WorldGeometrySourceRequest = {
          generationId,
          resourceId: collider.shape.resourceId,
          workspacePath: collider.shape.resourceWorkspacePath,
          format: collider.shape.resourceFormat,
          url: createWorldWorkspaceUrl(deps.apiUrl, collider.shape.resourceWorkspacePath),
        }
        source = await deps.loadModelGeometry(request, signal)
        sourceCache.set(sourceKey, source)
      }
      if (signal.aborted) return geometryFailure('runtime-load-cancelled', 'geometry', 'Runtime scene load was superseded.')
      if (!source.success) return geometryFailure(source.code, `resources.${collider.shape.resourceId}`, source.message)
      if (!chargedSources.has(sourceKey)) {
        totalBytes += source.byteLength
        chargedSources.add(sourceKey)
        if (totalBytes > MAX_CHAIN_GEOMETRY_BYTES) return geometryFailure('physics-geometry-limit-exceeded', 'physics.geometry', 'Loaded collider sources exceed the Play chain budget.')
      }
      const prepared = buildColliderGeometry(source.meshes, collider.shape.entityScale, collider.shape.kind, MAX_CHAIN_GEOMETRY_BYTES - totalBytes)
      if (!prepared.success) return geometryFailure(prepared.code, `resources.${collider.shape.resourceId}`, prepared.message)
      totalBytes += prepared.byteLength
      const shape: WorldPhysicsColliderShapeDto = collider.shape.kind === 'convexHullSource'
        ? { kind: 'convexHull', vertices: prepared.vertices }
        : { kind: 'trimesh', vertices: prepared.vertices, indices: prepared.indices }
      colliders.push({ ...collider, shape })
      transfer.push(prepared.vertices.buffer)
      if (shape.kind === 'trimesh') transfer.push(shape.indices.buffer)
    }
    bodies.push({ ...body, colliders })
  }
  const physics: WorldPhysicsSceneDto = { ...plan.physics, bodies }
  const parsed = parseWorldPhysicsMainMessage({ version: WORLD_PHYSICS_PROTOCOL_VERSION, kind: 'init', generationId: 1, scene: physics })
  if (!parsed.success) return geometryFailure('physics-geometry-invalid', 'physics.geometry', parsed.issue)
  return { success: true, projection: { ...plan, physics }, transfer, byteLength: totalBytes }
}

export async function loadWorldGeometrySource(request: WorldGeometrySourceRequest, signal: AbortSignal): Promise<WorldPreparedGeometrySource> {
  try {
    const data = await fetchBoundedArrayBuffer(request.url, signal)
    if (request.format === 'gltf' || request.format === 'glb') {
      const parsed = request.format === 'gltf' ? parseGltfJson(data) : parseGlbJson(data)
      const preflight = preflightGltfGeometryDocument(parsed)
      if (!preflight.success) return { success: false, resourceId: request.resourceId, code: preflight.code, message: preflight.message }
    }
    if (request.format === 'ply-mesh') {
      const preflight = preflightPlyGeometry(data)
      if (!preflight.success) return { success: false, resourceId: request.resourceId, code: preflight.code, message: preflight.message }
    }
    const geometryPayload = request.format === 'glb' ? sanitizeGlbGeometryPayload(data) : request.format === 'gltf' ? sanitizeGltfGeometryPayload(data) : data
    const meshes = request.format === 'ply-mesh' ? parsePlyGeometry(data) : await parseGltfGeometry(geometryPayload, request.url)
    return { success: true, resourceId: request.resourceId, format: request.format, meshes, byteLength: data.byteLength }
  } catch (error) {
    return { success: false, resourceId: request.resourceId, code: signal.aborted ? 'runtime-load-cancelled' : 'unsupported-physics-geometry-source', message: error instanceof Error ? error.message : 'Model geometry could not be loaded.' }
  }
}

async function fetchBoundedArrayBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  if (signal.aborted) throw new Error('Model resource fetch was cancelled.')
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Model resource fetch failed with ${response.status}.`)
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_SOURCE_BYTES) throw new Error('Model resource exceeds the physics preparation source byte limit.')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Model resource response is not streamable.')
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    while (true) {
      if (signal.aborted) throw new Error('Model resource fetch was cancelled.')
      const next = await reader.read()
      if (next.done) { complete = true; break }
      total += next.value.byteLength
      if (total > MAX_SOURCE_BYTES) throw new Error('Model resource exceeds the physics preparation source byte limit.')
      chunks.push(next.value)
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return joined.buffer
}

type GltfJson = {
  buffers?: Array<{ uri?: string; byteLength?: number }>
  bufferViews?: Array<{ buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number }>
  accessors?: Array<{ bufferView?: number; componentType?: number; count?: number; type?: string }>
  meshes?: Array<{ primitives?: Array<Record<string, unknown>> }>
  nodes?: Array<{ mesh?: number; children?: number[] }>
  scenes?: Array<{ nodes?: number[] }>
  scene?: number
  images?: Array<{ uri?: string }>
  extensionsRequired?: string[]
}

function parseGltfJson(data: ArrayBuffer): GltfJson {
  return JSON.parse(new TextDecoder().decode(data)) as GltfJson
}

function parseGlbJson(data: ArrayBuffer): GltfJson {
  if (data.byteLength < 20) throw new Error('GLB payload is too small.')
  const view = new DataView(data)
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('GLB header is invalid.')
  const declaredLength = view.getUint32(8, true)
  if (declaredLength !== data.byteLength) throw new Error('GLB declared length does not match payload length.')
  let offset = 12
  let json: GltfJson | null = null
  let binChunks = 0
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) throw new Error('GLB chunk header is truncated.')
    const chunkLength = view.getUint32(offset, true); offset += 4
    const chunkType = view.getUint32(offset, true); offset += 4
    if (chunkLength <= 0 || offset + chunkLength > data.byteLength) throw new Error('GLB chunk length is invalid.')
    if (chunkType === 0x4e4f534a) {
      if (json) throw new Error('GLB contains multiple JSON chunks.')
      json = JSON.parse(new TextDecoder().decode(data.slice(offset, offset + chunkLength)).trim()) as GltfJson
    } else if (chunkType === 0x004e4942) {
      binChunks += 1
      if (binChunks > 1) throw new Error('GLB contains multiple BIN chunks.')
    } else {
      throw new Error('GLB contains an unsupported chunk type.')
    }
    offset += align4(chunkLength)
  }
  if (!json) throw new Error('GLB JSON chunk is missing.')
  return json
}

type PreflightResult = { success: true } | { success: false; code: string; message: string }

function preflightGltfGeometryDocument(json: GltfJson): PreflightResult {
  if ((json.extensionsRequired ?? []).length > 0) return { success: false, code: 'unsupported-physics-gltf-extension', message: 'Required glTF extensions are not supported for Play physics colliders yet.' }
  if ((json.buffers?.length ?? 0) > MAX_GLTF_JSON_ITEMS || (json.bufferViews?.length ?? 0) > MAX_GLTF_JSON_ITEMS || (json.accessors?.length ?? 0) > MAX_GLTF_JSON_ITEMS || (json.nodes?.length ?? 0) > MAX_GLTF_JSON_ITEMS || (json.meshes?.length ?? 0) > MAX_GLTF_JSON_ITEMS) {
    return { success: false, code: 'physics-geometry-limit-exceeded', message: 'glTF declares too many geometry records for Play physics.' }
  }
  for (const buffer of json.buffers ?? []) {
    if (!isNonNegativeSafeInteger(buffer.byteLength) || buffer.byteLength! > MAX_SOURCE_BYTES) return { success: false, code: 'physics-geometry-limit-exceeded', message: 'glTF buffer exceeds Play physics source limits.' }
    if (typeof buffer.uri === 'string') {
      if (!buffer.uri.startsWith('data:')) return { success: false, code: 'unsupported-physics-gltf-dependency', message: 'External glTF buffer dependencies are not supported for Play physics colliders yet.' }
      const estimate = estimateDataUriDecodedBytes(buffer.uri)
      if (estimate < 0 || estimate > MAX_SOURCE_BYTES) return { success: false, code: 'physics-geometry-limit-exceeded', message: 'Embedded glTF data URI exceeds Play physics source limits.' }
    }
  }
  for (const view of json.bufferViews ?? []) {
    if (!isNonNegativeSafeInteger(view.buffer) || !json.buffers?.[view.buffer!] || !isNonNegativeSafeInteger(view.byteLength) || view.byteLength! > MAX_SOURCE_BYTES) return { success: false, code: 'physics-geometry-limit-exceeded', message: 'glTF bufferView is outside Play physics limits.' }
    if (view.byteStride !== undefined && (!Number.isInteger(view.byteStride) || view.byteStride < 4 || view.byteStride > 252)) return { success: false, code: 'unsupported-physics-geometry-source', message: 'glTF bufferView stride is invalid.' }
  }
  for (const accessor of json.accessors ?? []) {
    if (!isNonNegativeSafeInteger(accessor.count) || accessor.count! > WORLD_PHYSICS_GEOMETRY_LIMITS.maxVerticesPerCollider * 3) return { success: false, code: 'physics-geometry-limit-exceeded', message: 'glTF accessor count exceeds Play physics limits.' }
    if (accessor.bufferView !== undefined && (!isNonNegativeSafeInteger(accessor.bufferView) || !json.bufferViews?.[accessor.bufferView])) return { success: false, code: 'unsupported-physics-geometry-source', message: 'glTF accessor bufferView is invalid.' }
  }
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) return { success: false, code: 'unsupported-physics-geometry-source', message: 'Only glTF TRIANGLES primitives are supported as physics colliders.' }
      const attributes = primitive.attributes as { POSITION?: unknown } | undefined
      if (!isNonNegativeSafeInteger(attributes?.POSITION) || !json.accessors?.[attributes!.POSITION as number]) return { success: false, code: 'unsupported-physics-geometry-source', message: 'glTF mesh primitive lacks a valid POSITION accessor.' }
      const position = json.accessors[attributes!.POSITION as number]!
      if (position.componentType !== 5126 || position.type !== 'VEC3') return { success: false, code: 'unsupported-physics-geometry-source', message: 'glTF POSITION accessor must be FLOAT VEC3.' }
      if (primitive.indices !== undefined) {
        if (!isNonNegativeSafeInteger(primitive.indices) || !json.accessors?.[primitive.indices as number]) return { success: false, code: 'unsupported-physics-geometry-source', message: 'glTF primitive index accessor is invalid.' }
        const indices = json.accessors[primitive.indices as number]!
        if (indices.count === undefined || indices.count % 3 !== 0 || indices.count / 3 > WORLD_PHYSICS_GEOMETRY_LIMITS.maxTrianglesPerCollider) return { success: false, code: 'physics-geometry-limit-exceeded', message: 'glTF triangle count exceeds Play physics limits.' }
      } else if (position.count === undefined || position.count % 3 !== 0 || position.count / 3 > WORLD_PHYSICS_GEOMETRY_LIMITS.maxTrianglesPerCollider) {
        return { success: false, code: 'physics-geometry-limit-exceeded', message: 'glTF non-indexed triangle count exceeds Play physics limits.' }
      }
    }
  }
  if (!preflightGltfNodeDepth(json)) return { success: false, code: 'physics-geometry-limit-exceeded', message: 'glTF node hierarchy exceeds Play physics limits.' }
  return { success: true }
}

function preflightGltfNodeDepth(json: GltfJson): boolean {
  const nodes = json.nodes ?? []
  const stack = (json.scenes?.[json.scene ?? 0]?.nodes ?? []).map((node) => ({ node, depth: 0 }))
  const seen = new Set<number>()
  while (stack.length > 0) {
    const next = stack.pop()!
    if (!Number.isInteger(next.node) || next.node < 0 || next.node >= nodes.length || next.depth > MAX_GLTF_NODE_DEPTH || seen.has(next.node)) return false
    seen.add(next.node)
    for (const child of nodes[next.node]?.children ?? []) stack.push({ node: child, depth: next.depth + 1 })
  }
  return true
}

function preflightPlyGeometry(data: ArrayBuffer): PreflightResult {
  const header = parsePlyHeader(data)
  if (!header.success) return header
  if (header.faces < 1) return { success: false, code: 'unsupported-physics-geometry-source', message: 'PLY point clouds are not supported as physics collider meshes.' }
  if (header.vertices < 3 || header.vertices > WORLD_PHYSICS_GEOMETRY_LIMITS.maxVerticesPerCollider || header.faces > WORLD_PHYSICS_GEOMETRY_LIMITS.maxTrianglesPerCollider) {
    return { success: false, code: 'physics-geometry-limit-exceeded', message: 'PLY vertex or face count exceeds Play physics limits.' }
  }
  return { success: true }
}

function parsePlyHeader(data: ArrayBuffer): { success: true; vertices: number; faces: number } | { success: false; code: string; message: string } {
  const prefix = new TextDecoder().decode(data.slice(0, Math.min(data.byteLength, 64 * 1024)))
  const headerEnd = prefix.indexOf('end_header')
  if (headerEnd < 0) return { success: false, code: 'unsupported-physics-geometry-source', message: 'PLY header is missing.' }
  const header = prefix.slice(0, headerEnd)
  const vertexMatch = /^element vertex\s+(\d+)$/m.exec(header)
  const faceMatch = /^element face\s+(\d+)$/m.exec(header)
  return { success: true, vertices: Number(vertexMatch?.[1] ?? 0), faces: Number(faceMatch?.[1] ?? 0) }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function estimateDataUriDecodedBytes(uri: string): number {
  const comma = uri.indexOf(',')
  if (comma < 0) return -1
  if (/;base64/i.test(uri.slice(0, comma))) return Math.ceil((uri.length - comma - 1) * 3 / 4)
  return uri.length - comma - 1
}

function sanitizeGltfGeometryPayload(data: ArrayBuffer): ArrayBuffer {
  const parsed = sanitizeGltfJson(parseGltfJson(data))
  return new TextEncoder().encode(JSON.stringify(parsed)).buffer
}

function sanitizeGlbGeometryPayload(data: ArrayBuffer): ArrayBuffer {
  const view = new DataView(data)
  const jsonLength = view.getUint32(12, true)
  const sanitizedJson = new TextEncoder().encode(JSON.stringify(sanitizeGltfJson(parseGlbJson(data))))
  const paddedJson = new Uint8Array(align4(sanitizedJson.byteLength))
  paddedJson.set(sanitizedJson)
  paddedJson.fill(0x20, sanitizedJson.byteLength)
  const binOffset = 20 + jsonLength
  const binHeaderLength = data.byteLength >= binOffset + 8 ? new DataView(data).getUint32(binOffset, true) : 0
  const binChunkLength = binHeaderLength > 0 && binOffset + 8 + binHeaderLength <= data.byteLength ? align4(binHeaderLength) : 0
  const total = 12 + 8 + paddedJson.byteLength + (binChunkLength > 0 ? 8 + binChunkLength : 0)
  const out = new ArrayBuffer(total)
  const outView = new DataView(out)
  let offset = 0
  outView.setUint32(offset, 0x46546c67, true); offset += 4
  outView.setUint32(offset, 2, true); offset += 4
  outView.setUint32(offset, total, true); offset += 4
  outView.setUint32(offset, paddedJson.byteLength, true); offset += 4
  outView.setUint32(offset, 0x4e4f534a, true); offset += 4
  new Uint8Array(out, offset, paddedJson.byteLength).set(paddedJson); offset += paddedJson.byteLength
  if (binChunkLength > 0) {
    outView.setUint32(offset, binHeaderLength, true); offset += 4
    outView.setUint32(offset, 0x004e4942, true); offset += 4
    new Uint8Array(out, offset, binHeaderLength).set(new Uint8Array(data, binOffset + 8, binHeaderLength))
  }
  return out
}

function sanitizeGltfJson<T extends GltfJson & { textures?: unknown; samplers?: unknown; materials?: unknown }>(json: T): T {
  const clone = structuredClone(json) as T
  delete clone.images
  delete clone.textures
  delete clone.samplers
  delete clone.materials
  for (const mesh of clone.meshes ?? []) for (const primitive of mesh.primitives ?? []) delete primitive.material
  return clone
}

function align4(value: number): number { return (value + 3) & ~3 }

async function parseGltfGeometry(data: ArrayBuffer, path: string): Promise<WorldPreparedMesh[]> {
  const manager = new LoadingManager()
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url
    throw new Error('Unexpected glTF dependency request was blocked for physics geometry preparation.')
  })
  const restoreProgressEvent = ensureProgressEventConstructor()
  const loader = new GLTFLoader(manager)
  const gltf = await loader.parseAsync(data, path).finally(restoreProgressEvent)
  const meshes: WorldPreparedMesh[] = []
  gltf.scene.updateMatrixWorld(true)
  gltf.scene.traverse((object) => {
    if (object instanceof InstancedMesh || object instanceof SkinnedMesh) {
      meshes.push({ name: object.name || 'unsupported', vertices: new Float32Array(0), indices: new Uint32Array(0), localMatrix: [...IDENTITY_MATRIX], skinned: object instanceof SkinnedMesh, morphed: false, instanced: object instanceof InstancedMesh })
    } else if (object instanceof Mesh && object.geometry instanceof BufferGeometry) {
      const morphTargetInfluences = (object as Mesh & { morphTargetInfluences?: number[] }).morphTargetInfluences
      meshes.push(extractPreparedMesh(object.geometry, object.matrixWorld.elements, object.name || 'mesh', false, Array.isArray(morphTargetInfluences) && morphTargetInfluences.length > 0, false))
    }
  })
  return meshes
}

function ensureProgressEventConstructor(): () => void {
  if (typeof globalThis.ProgressEvent === 'function') return () => undefined
  class GeometryPreparationProgressEvent extends Event {
    readonly lengthComputable: boolean
    readonly loaded: number
    readonly total: number
    constructor(type: string, init: ProgressEventInit = {}) {
      super(type)
      this.lengthComputable = init.lengthComputable ?? false
      this.loaded = init.loaded ?? 0
      this.total = init.total ?? 0
    }
  }
  const target = globalThis as typeof globalThis & { ProgressEvent?: typeof ProgressEvent }
  target.ProgressEvent = GeometryPreparationProgressEvent as typeof ProgressEvent
  return () => { Reflect.deleteProperty(target, 'ProgressEvent') }
}

function parsePlyGeometry(data: ArrayBuffer): WorldPreparedMesh[] {
  const geometry = new PLYLoader().parse(data)
  return [extractPreparedMesh(geometry, IDENTITY_MATRIX, 'ply-mesh', false, false, false)]
}

function extractPreparedMesh(geometry: BufferGeometry, localMatrix: readonly number[], name: string, skinned: boolean, morphed: boolean, instanced: boolean): WorldPreparedMesh {
  const position = geometry.getAttribute('position')
  const vertices = position ? extractPositionVertices(position) : new Float32Array(0)
  const index = geometry.getIndex()
  const indices = index ? new Uint32Array(index.array as ArrayLike<number>) : createSequentialTriangleIndices(vertices.length / 3)
  return { name, vertices, indices, localMatrix: [...localMatrix], skinned, morphed, instanced }
}

function createSequentialTriangleIndices(vertexCount: number): Uint32Array {
  if (!Number.isInteger(vertexCount) || vertexCount < 3 || vertexCount % 3 !== 0) return new Uint32Array(0)
  const indices = new Uint32Array(vertexCount)
  for (let index = 0; index < vertexCount; index += 1) indices[index] = index
  return indices
}

function buildColliderGeometry(meshes: readonly WorldPreparedMesh[], entityScale: readonly [number, number, number], kind: 'convexHullSource' | 'trimeshSource', remainingBytes: number): { success: true; vertices: Float32Array; indices: Uint32Array; byteLength: number } | { success: false; code: string; message: string } {
  if (meshes.length < 1) return { success: false, code: 'unsupported-physics-geometry-source', message: 'Model resource contains no mesh geometry.' }
  const vertexParts: Float32Array[] = []
  const indexParts: Uint32Array[] = []
  let vertexCount = 0
  let triangleCount = 0
  for (const mesh of meshes) {
    if (mesh.skinned || mesh.morphed || mesh.instanced) return { success: false, code: 'unsupported-physics-geometry-source', message: 'Skinned, morphed, or instanced meshes are not supported as physics colliders yet.' }
    if (!isFiniteMatrix(mesh.localMatrix) || mesh.vertices.length % 3 !== 0 || mesh.indices.length % 3 !== 0 || mesh.indices.length === 0) return { success: false, code: 'unsupported-physics-geometry-source', message: 'Mesh geometry must contain triangle positions and indices.' }
    const localVertexCount = mesh.vertices.length / 3
    const localTriangleCount = mesh.indices.length / 3
    if (vertexCount + localVertexCount > WORLD_PHYSICS_GEOMETRY_LIMITS.maxVerticesPerCollider || triangleCount + localTriangleCount > WORLD_PHYSICS_GEOMETRY_LIMITS.maxTrianglesPerCollider) return { success: false, code: 'physics-geometry-limit-exceeded', message: 'Collider geometry exceeds Play physics limits.' }
    for (const index of mesh.indices) if (index >= localVertexCount) return { success: false, code: 'unsupported-physics-geometry-source', message: 'Mesh index references a missing vertex.' }
    const nextByteLength = (vertexCount + localVertexCount) * 3 * Float32Array.BYTES_PER_ELEMENT + (kind === 'trimeshSource' ? (triangleCount + localTriangleCount) * 3 * Uint32Array.BYTES_PER_ELEMENT : 0)
    if (nextByteLength > remainingBytes) return { success: false, code: 'physics-geometry-limit-exceeded', message: 'Collider geometry exceeds the remaining Play chain budget.' }
    const transformed = transformVertices(mesh.vertices, mesh.localMatrix, entityScale)
    const remapped = remapTriangleIndices(mesh.indices, vertexCount, kind === 'trimeshSource' && hasNegativeTransformParity(mesh.localMatrix, entityScale))
    vertexParts.push(transformed)
    indexParts.push(remapped)
    vertexCount += localVertexCount
    triangleCount += localTriangleCount
  }
  const byteLength = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT + (kind === 'trimeshSource' ? triangleCount * 3 * Uint32Array.BYTES_PER_ELEMENT : 0)
  const vertices = concatFloat32(vertexParts, vertexCount * 3)
  const indices = concatUint32(indexParts, triangleCount * 3)
  return { success: true, vertices, indices: kind === 'convexHullSource' ? new Uint32Array(0) : indices, byteLength }
}

function remapTriangleIndices(source: Uint32Array, vertexOffset: number, reverseWinding: boolean): Uint32Array {
  const remapped = new Uint32Array(source.length)
  for (let offset = 0; offset < source.length; offset += 3) {
    remapped[offset] = source[offset]! + vertexOffset
    remapped[offset + 1] = source[offset + (reverseWinding ? 2 : 1)]! + vertexOffset
    remapped[offset + 2] = source[offset + (reverseWinding ? 1 : 2)]! + vertexOffset
  }
  return remapped
}

function hasNegativeTransformParity(localMatrix: readonly number[], entityScale: readonly [number, number, number]): boolean {
  const localDeterminant = new Matrix4().fromArray([...localMatrix]).determinant()
  const scaleDeterminant = entityScale[0] * entityScale[1] * entityScale[2]
  return Number.isFinite(localDeterminant) && Number.isFinite(scaleDeterminant) && localDeterminant * scaleDeterminant < 0
}

function transformVertices(source: Float32Array, localMatrix: readonly number[], entityScale: readonly [number, number, number]): Float32Array {
  const matrix = new Matrix4().fromArray([...localMatrix])
  const point = new Vector3()
  const out = new Float32Array(source.length)
  for (let offset = 0; offset < source.length; offset += 3) {
    point.set(source[offset]!, source[offset + 1]!, source[offset + 2]!).applyMatrix4(matrix)
    out[offset] = cleanNumber(point.x * entityScale[0])
    out[offset + 1] = cleanNumber(point.y * entityScale[1])
    out[offset + 2] = cleanNumber(point.z * entityScale[2])
  }
  return out
}

function cleanNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

function extractPositionVertices(position: { readonly count: number; getX(index: number): number; getY(index: number): number; getZ(index: number): number }): Float32Array {
  const vertices = new Float32Array(position.count * 3)
  for (let index = 0; index < position.count; index += 1) {
    const offset = index * 3
    vertices[offset] = position.getX(index)
    vertices[offset + 1] = position.getY(index)
    vertices[offset + 2] = position.getZ(index)
  }
  return vertices
}

function concatFloat32(parts: readonly Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

function concatUint32(parts: readonly Uint32Array[], length: number): Uint32Array {
  const out = new Uint32Array(length)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

function isFiniteMatrix(values: readonly number[]): boolean {
  return values.length === 16 && values.every(Number.isFinite)
}

function plyHeaderHasFaces(data: ArrayBuffer): boolean {
  const header = parsePlyHeader(data)
  return header.success && header.faces > 0
}

function geometryFailure(code: string, path: string, message: string): { success: false; issues: WorldRuntimeProjectionIssue[] } {
  return { success: false, issues: [{ code, path, message }] }
}
