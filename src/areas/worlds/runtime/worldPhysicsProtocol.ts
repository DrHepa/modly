import type { WorldVector2, WorldVector3 } from '../core/worldModel.ts'
import { WORLD_MAX_RECOVERY_STEPS } from './worldRuntimeClock.ts'

export const WORLD_PHYSICS_PROTOCOL_VERSION = 1 as const
export const WORLD_PHYSICS_TRANSFORM_STRIDE = 7
/** Editor camera belongs to the default layer; obstacles must opt into that layer. */
export const WORLD_NAVIGATION_COLLISION_LAYER = 1
export const WORLD_NAVIGATION_COLLISION_MASK = 0xffff
export const WORLD_NAVIGATION_MAX_COORDINATE = 1_000_000
/** 1.8 m capsule, eye 1.65 m above its feet. Protocol positions are always eyes. */
export const WORLD_NAVIGATION_EYE_OFFSET = 0.75

export interface WorldPhysicsNavigationInit {
  position: WorldVector3
  /** Authored +Y side in world space. Double-sided triangles need no entry. */
  frontSurfaces: { componentId: string; point: WorldVector3; normal: WorldVector3 }[]
}
export interface WorldPhysicsNavigationStep {
  /** Normalized world-space X/Z direction, independent of camera pitch. */
  move: WorldVector2
  jumpPressed: boolean
  boost: boolean
}
export interface WorldPhysicsNavigationPose {
  sequence: number
  position: WorldVector3
  grounded: boolean
  recovered: boolean
}
export const WORLD_PHYSICS_GEOMETRY_LIMITS = Object.freeze({
  maxVerticesPerCollider: 16_384,
  maxTrianglesPerCollider: 32_768,
  maxVertexBytesPerCollider: 16_384 * 3 * Float32Array.BYTES_PER_ELEMENT,
  maxIndexBytesPerCollider: 32_768 * 3 * Uint32Array.BYTES_PER_ELEMENT,
  maxGeometryBytesPerScene: 8 * 1024 * 1024,
})

const WORLD_PHYSICS_GEOMETRY_RELATIVE_TOLERANCE = 2 ** -20

export type WorldPhysicsQuaternion = [number, number, number, number]

export type WorldPhysicsColliderShapeDto =
  | { kind: 'box'; halfExtents: WorldVector3 }
  | { kind: 'sphere'; radius: number }
  | { kind: 'capsule'; radius: number; halfHeight: number }
  | { kind: 'convexHull'; vertices: Float32Array }
  | { kind: 'trimesh'; vertices: Float32Array; indices: Uint32Array }

export interface WorldPhysicsColliderDto {
  componentId: string
  shape: WorldPhysicsColliderShapeDto
  sensor: boolean
  friction: number
  restitution: number
  collisionLayer: number
  collisionMask: number
  triggerComponentIds: string[]
}

export interface WorldPhysicsCharacterControllerDto {
  componentId: string
  colliderComponentId: string
  moveActionId: string
  jumpActionId?: string
  speed: number
  jumpSpeed: number
  maxSlopeRadians: number
}

export interface WorldPhysicsBodyDto {
  entityId: string
  bodyType: 'fixed' | 'dynamic' | 'kinematic-position' | 'kinematic-velocity'
  position: WorldVector3
  rotation: WorldPhysicsQuaternion
  gravityScale: number
  linearDamping: number
  angularDamping: number
  canSleep: boolean
  tags: string[]
  colliders: WorldPhysicsColliderDto[]
  controller?: WorldPhysicsCharacterControllerDto
}

export interface WorldPhysicsSceneDto {
  sceneId: string
  gravity: WorldVector3
  bodies: WorldPhysicsBodyDto[]
}

export interface WorldPhysicsCharacterInput {
  entityId: string
  move: WorldVector2
  jumpPressed: boolean
}

export interface WorldPhysicsImpulse {
  entityId: string
  impulse: WorldVector3
}

export interface WorldPhysicsTriggerEvent {
  type: 'enter' | 'exit'
  triggerComponentId: string
  otherEntityId: string
  otherTags: string[]
}

export interface WorldPhysicsStepRequest {
  sequence: number
  steps: WorldPhysicsFixedStep[]
}

export interface WorldPhysicsFixedStep {
  characters: WorldPhysicsCharacterInput[]
  impulses: WorldPhysicsImpulse[]
}

export interface WorldPhysicsStepTiming {
  substep: number
  solverMs: number
  /** Includes impulses, Character movement, the solver and per-step trigger draining; excludes snapshot packing/transport. */
  physicsStepMs: number
}

export type WorldPhysicsMainMessage =
  | { version: typeof WORLD_PHYSICS_PROTOCOL_VERSION; kind: 'init'; generationId: number; scene: WorldPhysicsSceneDto; diagnostics?: true; navigation?: WorldPhysicsNavigationInit }
  | { version: typeof WORLD_PHYSICS_PROTOCOL_VERSION; kind: 'navigation-step'; generationId: number; sequence: number; steps: WorldPhysicsNavigationStep[] }
  | ({ version: typeof WORLD_PHYSICS_PROTOCOL_VERSION; kind: 'step'; generationId: number } & WorldPhysicsStepRequest)
  | { version: typeof WORLD_PHYSICS_PROTOCOL_VERSION; kind: 'pause' | 'resume' | 'dispose'; generationId: number }

export type WorldPhysicsWorkerMessage =
  | ({ version: typeof WORLD_PHYSICS_PROTOCOL_VERSION; kind: 'navigation-pose'; generationId: number } & WorldPhysicsNavigationPose)
  | { version: typeof WORLD_PHYSICS_PROTOCOL_VERSION; kind: 'ready'; generationId: number; entityIds: string[] }
  | {
      version: typeof WORLD_PHYSICS_PROTOCOL_VERSION
      kind: 'snapshot'
      generationId: number
      sequence: number
      entityIds: string[]
      transforms: ArrayBuffer
      triggerEvents: WorldPhysicsTriggerEvent[]
      stepTimings?: WorldPhysicsStepTiming[]
    }
  | { version: typeof WORLD_PHYSICS_PROTOCOL_VERSION; kind: 'error'; generationId: number; code: string; message: string }

export type ParseWorldPhysicsMessageResult<T> =
  | { success: true; value: T }
  | { success: false; issue: string }

export function parseWorldPhysicsMainMessage(value: unknown): ParseWorldPhysicsMessageResult<WorldPhysicsMainMessage> {
  if (!isRecord(value) || value.version !== WORLD_PHYSICS_PROTOCOL_VERSION || !isGeneration(value.generationId) || typeof value.kind !== 'string') return invalid('Physics message envelope is invalid.')
  if (value.kind === 'init') {
    if (!hasOnlyKeys(value, ['version', 'kind', 'generationId', 'scene', ...('diagnostics' in value ? ['diagnostics'] : []), ...('navigation' in value ? ['navigation'] : [])])
      || ('diagnostics' in value && value.diagnostics !== true) || !isPhysicsScene(value.scene)
      || ('navigation' in value && (!isNavigationInit(value.navigation, value.scene) || 'diagnostics' in value))) return invalid('Physics init message is invalid.')
    return valid(value as unknown as WorldPhysicsMainMessage)
  }
  if (value.kind === 'navigation-step') {
    if (!hasOnlyKeys(value, ['version', 'kind', 'generationId', 'sequence', 'steps']) || !isSequence(value.sequence)
      || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > WORLD_MAX_RECOVERY_STEPS
      || !value.steps.every(step => isRecord(step) && hasOnlyKeys(step, ['move', 'jumpPressed', 'boost']) && isVector2(step.move)
        && Math.hypot(...step.move) <= 1.000001 && typeof step.jumpPressed === 'boolean' && typeof step.boost === 'boolean')) return invalid('Navigation step message is invalid.')
    return valid(value as unknown as WorldPhysicsMainMessage)
  }
  if (value.kind === 'step') {
    if (!hasOnlyKeys(value, ['version', 'kind', 'generationId', 'sequence', 'steps'])
      || !isSequence(value.sequence) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > WORLD_MAX_RECOVERY_STEPS
      || !value.steps.every(isFixedStep)) return invalid('Physics step message is invalid.')
    return valid(value as unknown as WorldPhysicsMainMessage)
  }
  if (value.kind === 'pause' || value.kind === 'resume' || value.kind === 'dispose') {
    if (!hasOnlyKeys(value, ['version', 'kind', 'generationId'])) return invalid(`Physics ${value.kind} message is invalid.`)
    return valid(value as unknown as WorldPhysicsMainMessage)
  }
  return invalid('Physics message kind is unsupported.')
}

function isFixedStep(value: unknown): value is WorldPhysicsFixedStep {
  return isRecord(value) && hasOnlyKeys(value, ['characters', 'impulses'])
    && isArrayOf(value.characters, isCharacterInput) && isArrayOf(value.impulses, isImpulse)
}

export function parseWorldPhysicsWorkerMessage(value: unknown): ParseWorldPhysicsMessageResult<WorldPhysicsWorkerMessage> {
  if (!isRecord(value) || value.version !== WORLD_PHYSICS_PROTOCOL_VERSION || !isGeneration(value.generationId) || typeof value.kind !== 'string') return invalid('Physics worker envelope is invalid.')
  if (value.kind === 'navigation-pose') {
    if (!hasOnlyKeys(value, ['version', 'kind', 'generationId', 'sequence', 'position', 'grounded', 'recovered']) || !isSequence(value.sequence)
      || !isNavigationPosition(value.position) || typeof value.grounded !== 'boolean' || typeof value.recovered !== 'boolean') return invalid('Navigation pose message is invalid.')
    return valid(value as unknown as WorldPhysicsWorkerMessage)
  }
  if (value.kind === 'ready') {
    if (!hasOnlyKeys(value, ['version', 'kind', 'generationId', 'entityIds']) || !isStringArray(value.entityIds)) return invalid('Physics ready message is invalid.')
    return valid(value as unknown as WorldPhysicsWorkerMessage)
  }
  if (value.kind === 'snapshot') {
    if (!hasOnlyKeys(value, ['version', 'kind', 'generationId', 'sequence', 'entityIds', 'transforms', 'triggerEvents', ...('stepTimings' in value ? ['stepTimings'] : [])])
      || ('stepTimings' in value && !isStepTimings(value.stepTimings))
      || !isSequence(value.sequence) || !isStringArray(value.entityIds) || !(value.transforms instanceof ArrayBuffer)
      || value.transforms.byteLength !== value.entityIds.length * WORLD_PHYSICS_TRANSFORM_STRIDE * Float32Array.BYTES_PER_ELEMENT
      || !finiteFloatBuffer(value.transforms) || !isArrayOf(value.triggerEvents, isTriggerEvent)) return invalid('Physics snapshot message is invalid.')
    return valid(value as unknown as WorldPhysicsWorkerMessage)
  }
  if (value.kind === 'error') {
    if (!hasOnlyKeys(value, ['version', 'kind', 'generationId', 'code', 'message']) || !isNonEmptyString(value.code) || !isNonEmptyString(value.message)) return invalid('Physics error message is invalid.')
    return valid(value as unknown as WorldPhysicsWorkerMessage)
  }
  return invalid('Physics worker message kind is unsupported.')
}

function isStepTimings(value: unknown): value is WorldPhysicsStepTiming[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > WORLD_MAX_RECOVERY_STEPS) return false
  for (const [index, row] of value.entries()) {
    if (!isRecord(row) || !hasOnlyKeys(row, ['substep', 'solverMs', 'physicsStepMs']) || row.substep !== index
      || !isNonNegativeNumber(row.solverMs) || !isNonNegativeNumber(row.physicsStepMs)
      || row.solverMs > row.physicsStepMs || row.physicsStepMs > Number.MAX_SAFE_INTEGER) return false
  }
  return true
}

function isPhysicsScene(value: unknown): value is WorldPhysicsSceneDto {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sceneId', 'gravity', 'bodies']) || !isNonEmptyString(value.sceneId)
    || !isVector3(value.gravity) || !Array.isArray(value.bodies) || value.bodies.length > 65_536) return false
  const budget = { advancedGeometryBytes: 0 }
  return value.bodies.every((bodyValue) => isBody(bodyValue, budget))
}

function isNavigationPosition(value: unknown): value is WorldVector3 {
  return isVector3(value) && value.every(coordinate => Math.abs(coordinate) <= WORLD_NAVIGATION_MAX_COORDINATE)
}

function isNavigationInit(value: unknown, scene: WorldPhysicsSceneDto): value is WorldPhysicsNavigationInit {
  if (!isRecord(value) || !hasOnlyKeys(value, ['position', 'frontSurfaces']) || !isNavigationPosition(value.position)
    || !Array.isArray(value.frontSurfaces) || value.frontSurfaces.length > 65_536) return false
  const colliderIds = new Set<string>()
  const triangleIds = new Set<string>()
  for (const body of scene.bodies) {
    if (body.bodyType !== 'fixed' || body.controller) return false
    for (const collider of body.colliders) {
      if (colliderIds.has(collider.componentId) || collider.triggerComponentIds.length) return false
      colliderIds.add(collider.componentId)
      if (collider.shape.kind === 'trimesh') triangleIds.add(collider.componentId)
    }
  }
  const seen = new Set<string>()
  return value.frontSurfaces.every(surface => {
    if (!isRecord(surface) || !hasOnlyKeys(surface, ['componentId', 'point', 'normal']) || !isNonEmptyString(surface.componentId)
      || !triangleIds.has(surface.componentId) || seen.has(surface.componentId) || !isNavigationPosition(surface.point)
      || !isVector3(surface.normal) || Math.abs(Math.hypot(...surface.normal) - 1) > 1e-5) return false
    seen.add(surface.componentId)
    return true
  })
}

function isBody(value: unknown, budget: { advancedGeometryBytes: number }): value is WorldPhysicsBodyDto {
  if (!isRecord(value) || !hasOnlyKeys(value, ['entityId', 'bodyType', 'position', 'rotation', 'gravityScale', 'linearDamping', 'angularDamping', 'canSleep', 'tags', 'colliders', 'controller'])) return false
  if (!(isNonEmptyString(value.entityId)
    && (value.bodyType === 'fixed' || value.bodyType === 'dynamic' || value.bodyType === 'kinematic-position' || value.bodyType === 'kinematic-velocity')
    && isVector3(value.position) && isQuaternion(value.rotation)
    && isFiniteNumber(value.gravityScale) && isNonNegativeNumber(value.linearDamping) && isNonNegativeNumber(value.angularDamping)
    && typeof value.canSleep === 'boolean' && isStringArray(value.tags) && Array.isArray(value.colliders) && value.colliders.length <= 65_536
    && (value.controller === undefined || isController(value.controller)))) return false
  return value.colliders.every((collider) => isCollider(collider, value.bodyType as WorldPhysicsBodyDto['bodyType'], budget))
}

function isCollider(value: unknown, bodyType: WorldPhysicsBodyDto['bodyType'], budget: { advancedGeometryBytes: number }): value is WorldPhysicsColliderDto {
  return isRecord(value) && hasOnlyKeys(value, ['componentId', 'shape', 'sensor', 'friction', 'restitution', 'collisionLayer', 'collisionMask', 'triggerComponentIds'])
    && isNonEmptyString(value.componentId) && isColliderShape(value.shape, bodyType, budget) && typeof value.sensor === 'boolean'
    && isNonNegativeNumber(value.friction) && isFiniteNumber(value.restitution)
    && isUint16(value.collisionLayer) && isUint16(value.collisionMask) && isStringArray(value.triggerComponentIds)
}

function isColliderShape(value: unknown, bodyType: WorldPhysicsBodyDto['bodyType'], budget: { advancedGeometryBytes: number }): value is WorldPhysicsColliderShapeDto {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'box') return hasOnlyKeys(value, ['kind', 'halfExtents']) && isPositiveVector3(value.halfExtents)
  if (value.kind === 'sphere') return hasOnlyKeys(value, ['kind', 'radius']) && isPositiveNumber(value.radius)
  if (value.kind === 'capsule') return hasOnlyKeys(value, ['kind', 'radius', 'halfHeight']) && isPositiveNumber(value.radius) && isPositiveNumber(value.halfHeight)
  if (value.kind === 'convexHull') return hasOnlyKeys(value, ['kind', 'vertices']) && isConvexHullShape(value.vertices, budget)
  if (value.kind === 'trimesh') {
    return bodyType === 'fixed' && hasOnlyKeys(value, ['kind', 'vertices', 'indices']) && isTriMeshShape(value.vertices, value.indices, budget)
  }
  return false
}

function isConvexHullShape(vertices: unknown, budget: { advancedGeometryBytes: number }): vertices is Float32Array {
  if (!isExactOrdinaryTypedArray(vertices, Float32Array)) return false
  if (!reserveAdvancedGeometryBytes(vertices.byteLength, budget)) return false
  const vertexCount = vertices.length / 3
  if (vertices.length % 3 !== 0 || vertexCount < 4 || vertexCount > WORLD_PHYSICS_GEOMETRY_LIMITS.maxVerticesPerCollider
    || vertices.byteLength > WORLD_PHYSICS_GEOMETRY_LIMITS.maxVertexBytesPerCollider) return false
  if (!finiteFloatArray(vertices)) return false
  return hasNonCoplanarPoints(vertices)
}

function isTriMeshShape(vertices: unknown, indices: unknown, budget: { advancedGeometryBytes: number }): boolean {
  if (!isExactOrdinaryTypedArray(vertices, Float32Array) || !isExactOrdinaryTypedArray(indices, Uint32Array)) return false
  if (!reserveAdvancedGeometryBytes(vertices.byteLength + indices.byteLength, budget)) return false
  const vertexCount = vertices.length / 3
  const triangleCount = indices.length / 3
  if (vertices.length % 3 !== 0 || indices.length % 3 !== 0 || vertexCount < 3 || vertexCount > WORLD_PHYSICS_GEOMETRY_LIMITS.maxVerticesPerCollider
    || triangleCount < 1 || triangleCount > WORLD_PHYSICS_GEOMETRY_LIMITS.maxTrianglesPerCollider
    || vertices.byteLength > WORLD_PHYSICS_GEOMETRY_LIMITS.maxVertexBytesPerCollider
    || indices.byteLength > WORLD_PHYSICS_GEOMETRY_LIMITS.maxIndexBytesPerCollider) return false
  if (!finiteFloatArray(vertices)) return false
  for (const index of indices) if (index >= vertexCount) return false
  return hasOnlyNonDegenerateTriangles(vertices, indices)
}

function reserveAdvancedGeometryBytes(byteLength: number, budget: { advancedGeometryBytes: number }): boolean {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return false
  const nextBytes = budget.advancedGeometryBytes + byteLength
  if (nextBytes > WORLD_PHYSICS_GEOMETRY_LIMITS.maxGeometryBytesPerScene) return false
  budget.advancedGeometryBytes = nextBytes
  return true
}

function isExactOrdinaryTypedArray<T extends Float32Array | Uint32Array>(
  value: unknown,
  constructor: { new(length: number): T; readonly prototype: T },
): value is T {
  if (!(value instanceof constructor)) return false
  if (!(value.buffer instanceof ArrayBuffer)) return false
  const buffer = value.buffer as ArrayBuffer & { readonly resizable?: boolean; readonly detached?: boolean }
  if (buffer.resizable || buffer.detached) return false
  return value.byteOffset === 0 && value.byteLength > 0 && value.buffer.byteLength === value.byteLength
}

function finiteFloatArray(values: Float32Array): boolean {
  for (const value of values) if (!Number.isFinite(value)) return false
  return true
}

function hasNonCoplanarPoints(vertices: Float32Array): boolean {
  const pointCount = vertices.length / 3
  const first = 0
  let second = -1
  let maxDistanceSq = 0
  for (let candidate = 1; candidate < pointCount; candidate += 1) {
    const distanceSq = pointDistanceSq(vertices, first, candidate)
    if (distanceSq > maxDistanceSq) {
      maxDistanceSq = distanceSq
      second = candidate
    }
  }
  if (second < 0 || maxDistanceSq === 0) return false
  const lineToleranceSq = maxDistanceSq * WORLD_PHYSICS_GEOMETRY_RELATIVE_TOLERANCE * WORLD_PHYSICS_GEOMETRY_RELATIVE_TOLERANCE
  if (maxDistanceSq <= lineToleranceSq) return false

  let third = -1
  let maxAreaSq = 0
  for (let candidate = 0; candidate < pointCount; candidate += 1) {
    const areaSq = triangleAreaSq(vertices, first, second, candidate)
    if (areaSq > maxAreaSq) {
      maxAreaSq = areaSq
      third = candidate
    }
  }
  const areaToleranceSq = maxDistanceSq * maxDistanceSq * WORLD_PHYSICS_GEOMETRY_RELATIVE_TOLERANCE * WORLD_PHYSICS_GEOMETRY_RELATIVE_TOLERANCE
  if (third < 0 || maxAreaSq <= areaToleranceSq) return false

  const volumeToleranceSq = maxAreaSq * maxDistanceSq * WORLD_PHYSICS_GEOMETRY_RELATIVE_TOLERANCE * WORLD_PHYSICS_GEOMETRY_RELATIVE_TOLERANCE
  for (let candidate = 0; candidate < pointCount; candidate += 1) {
    if (tetrahedronVolumeSq(vertices, first, second, third, candidate) > volumeToleranceSq) return true
  }
  return false
}

function hasOnlyNonDegenerateTriangles(vertices: Float32Array, indices: Uint32Array): boolean {
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]
    const b = indices[offset + 1]
    const c = indices[offset + 2]
    const areaSq = triangleAreaSq(vertices, a, b, c)
    const scaleSq = Math.max(pointDistanceSq(vertices, a, b), pointDistanceSq(vertices, b, c), pointDistanceSq(vertices, c, a))
    const toleranceSq = scaleSq * scaleSq * WORLD_PHYSICS_GEOMETRY_RELATIVE_TOLERANCE * WORLD_PHYSICS_GEOMETRY_RELATIVE_TOLERANCE
    if (scaleSq === 0 || areaSq <= toleranceSq) return false
  }
  return true
}

function pointDistanceSq(vertices: Float32Array, a: number, b: number): number {
  const ax = vertices[a * 3]
  const ay = vertices[a * 3 + 1]
  const az = vertices[a * 3 + 2]
  const bx = vertices[b * 3]
  const by = vertices[b * 3 + 1]
  const bz = vertices[b * 3 + 2]
  const x = bx - ax
  const y = by - ay
  const z = bz - az
  return x * x + y * y + z * z
}

function triangleAreaSq(vertices: Float32Array, a: number, b: number, c: number): number {
  const ax = vertices[a * 3]
  const ay = vertices[a * 3 + 1]
  const az = vertices[a * 3 + 2]
  const abx = vertices[b * 3] - ax
  const aby = vertices[b * 3 + 1] - ay
  const abz = vertices[b * 3 + 2] - az
  const acx = vertices[c * 3] - ax
  const acy = vertices[c * 3 + 1] - ay
  const acz = vertices[c * 3 + 2] - az
  const crossX = (aby * acz) - (abz * acy)
  const crossY = (abz * acx) - (abx * acz)
  const crossZ = (abx * acy) - (aby * acx)
  return (crossX * crossX) + (crossY * crossY) + (crossZ * crossZ)
}

function tetrahedronVolumeSq(vertices: Float32Array, a: number, b: number, c: number, d: number): number {
  const ax = vertices[a * 3]
  const ay = vertices[a * 3 + 1]
  const az = vertices[a * 3 + 2]
  const abx = vertices[b * 3] - ax
  const aby = vertices[b * 3 + 1] - ay
  const abz = vertices[b * 3 + 2] - az
  const acx = vertices[c * 3] - ax
  const acy = vertices[c * 3 + 1] - ay
  const acz = vertices[c * 3 + 2] - az
  const adx = vertices[d * 3] - ax
  const ady = vertices[d * 3 + 1] - ay
  const adz = vertices[d * 3 + 2] - az
  const crossX = (aby * acz) - (abz * acy)
  const crossY = (abz * acx) - (abx * acz)
  const crossZ = (abx * acy) - (aby * acx)
  const volume = (crossX * adx) + (crossY * ady) + (crossZ * adz)
  return volume * volume
}

function isController(value: unknown): value is WorldPhysicsCharacterControllerDto {
  return isRecord(value) && hasOnlyKeys(value, ['componentId', 'colliderComponentId', 'moveActionId', 'jumpActionId', 'speed', 'jumpSpeed', 'maxSlopeRadians'])
    && isNonEmptyString(value.componentId) && isNonEmptyString(value.colliderComponentId) && isNonEmptyString(value.moveActionId)
    && (value.jumpActionId === undefined || isNonEmptyString(value.jumpActionId)) && isNonNegativeNumber(value.speed)
    && isNonNegativeNumber(value.jumpSpeed) && isFiniteNumber(value.maxSlopeRadians)
}

function isCharacterInput(value: unknown): value is WorldPhysicsCharacterInput {
  return isRecord(value) && hasOnlyKeys(value, ['entityId', 'move', 'jumpPressed']) && isNonEmptyString(value.entityId)
    && isVector2(value.move) && typeof value.jumpPressed === 'boolean'
}

function isImpulse(value: unknown): value is WorldPhysicsImpulse {
  return isRecord(value) && hasOnlyKeys(value, ['entityId', 'impulse']) && isNonEmptyString(value.entityId) && isVector3(value.impulse)
}

function isTriggerEvent(value: unknown): value is WorldPhysicsTriggerEvent {
  return isRecord(value) && hasOnlyKeys(value, ['type', 'triggerComponentId', 'otherEntityId', 'otherTags'])
    && (value.type === 'enter' || value.type === 'exit') && isNonEmptyString(value.triggerComponentId)
    && isNonEmptyString(value.otherEntityId) && isStringArray(value.otherTags)
}

function finiteFloatBuffer(buffer: ArrayBuffer): boolean {
  for (const value of new Float32Array(buffer)) if (!Number.isFinite(value)) return false
  return true
}

function isArrayOf<T>(value: unknown, predicate: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.length <= 65_536 && value.every(predicate)
}

function isStringArray(value: unknown): value is string[] {
  return isArrayOf(value, isNonEmptyString) && new Set(value).size === value.length
}

function isVector2(value: unknown): value is WorldVector2 {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)
}

function isVector3(value: unknown): value is WorldVector3 {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
}

function isPositiveVector3(value: unknown): value is WorldVector3 {
  return isVector3(value) && value.every((item) => item > 0)
}

function isQuaternion(value: unknown): value is WorldPhysicsQuaternion {
  return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

function isUint16(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024 && !value.includes('\0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.every((key) => allowed.includes(key)) && allowed.filter((key) => key !== 'controller' && key !== 'jumpActionId').every((key) => key in value)
}

function valid<T>(value: T): ParseWorldPhysicsMessageResult<T> {
  return { success: true, value }
}

function invalid(issue: string): ParseWorldPhysicsMessageResult<never> {
  return { success: false, issue }
}
