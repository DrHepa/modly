import type { WorldSceneItem } from './worldRenderableResolver.ts'
import type { WorldCollisionSurface } from './worldsCollisionSurfaces.ts'
import {
  resolveWorldCollisionProbeTranslation,
  type WorldsCollisionBox,
} from './worldsCollisionMath.ts'
import { resolveWorldCollisionSurface, type WorldsResolvedCollisionSurface } from './worldsSurfaceMath.ts'
import { resolveWorldSurfaceProbeTranslation } from './worldsSurfaceNavigation.ts'

export interface WorldsCollisionAabb {
  itemId: string | null
  zoneId: string
  min: WorldsVector3Like
  max: WorldsVector3Like
}

type WorldsCameraCollisionShape = WorldsCollisionAabb | WorldsCollisionBox

export interface WorldsCameraState {
  speed: number
  resetToken: number
}

export type WorldsMovementDirection = 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down'

export type WorldsMovementKeyState = Partial<Record<WorldsMovementDirection, boolean>>

export interface WorldsVector3Like {
  x: number
  y: number
  z: number
}

export interface WorldsMovementAxes {
  forward: WorldsVector3Like
  right: WorldsVector3Like
  up?: WorldsVector3Like
}

export interface WorldsYawRotationInput {
  cameraPosition: WorldsVector3Like
  target: WorldsVector3Like
  yawAngle: number
  up?: WorldsVector3Like
  fallbackLookDirection?: WorldsVector3Like
  fallbackDistance?: number
}

export interface ApplyWorldsKeyboardCameraPoseInput {
  cameraPosition: WorldsVector3Like
  target: WorldsVector3Like
  keys: WorldsMovementKeyState
  speed: number
  deltaSeconds: number
  yawDirection?: number
  up?: WorldsVector3Like
  collisionSurfaces?: readonly (WorldsResolvedCollisionSurface | null | undefined)[]
  collisionHalfExtents?: WorldsVector3Like
}

export interface ApplyWorldsKeyboardCameraPoseResult {
  cameraPosition: WorldsVector3Like
  target: WorldsVector3Like
}

export interface WorldsKeyboardTargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

export interface WorldsKeyboardInputScopeLike {
  contains: (element: unknown) => boolean
}

export interface WorldsKeyboardInputContext {
  target?: WorldsKeyboardTargetLike | null
  activeElement?: WorldsKeyboardTargetLike | null
  inputScope?: WorldsKeyboardInputScopeLike | null
}

export type WorldsOrbitCameraIntent = 'idle' | 'pan' | 'dolly' | 'look' | 'sync'

export interface WorldsOrbitCameraPoseIntentInput {
  previousCameraPosition: WorldsVector3Like
  previousTarget: WorldsVector3Like
  nextCameraPosition: WorldsVector3Like
  nextTarget: WorldsVector3Like
  epsilon?: number
}

export interface WorldsOrbitCameraPoseIntentResult {
  intent: WorldsOrbitCameraIntent
  cameraDelta: WorldsVector3Like
  targetDelta: WorldsVector3Like
}

export interface ResolveWorldsOrbitCameraPoseInput {
  acceptedCameraPosition: WorldsVector3Like
  acceptedTarget: WorldsVector3Like
  desiredCameraPosition: WorldsVector3Like
  desiredTarget: WorldsVector3Like
  collisionBoxes: readonly WorldsCollisionBox[]
  halfExtents?: WorldsVector3Like
  epsilon?: number
}

export interface ResolveWorldsOrbitCameraPoseResult {
  intent: WorldsOrbitCameraIntent
  cameraPosition: WorldsVector3Like
  target: WorldsVector3Like
  corrected: boolean
  collidedZoneIds: string[]
  depenetrated: boolean
}

export const WORLD_CAMERA_SPEED_PRESETS = [0.5, 1, 2, 5, 10] as const

export const WORLD_CAMERA_SPEED_MIN = 0.25
export const WORLD_CAMERA_SPEED_MAX = 20
export const WORLD_CAMERA_LOOK_PITCH_LIMIT = Math.PI / 2 - 0.05

export const DEFAULT_WORLDS_CAMERA_STATE: WorldsCameraState = {
  speed: 2,
  resetToken: 0,
}

const MOVEMENT_KEY_BY_CODE: Readonly<Record<string, WorldsMovementDirection>> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'up',
  ShiftLeft: 'down',
  ShiftRight: 'down',
}

const EDITABLE_TAG_NAMES = new Set(['INPUT', 'SELECT', 'TEXTAREA'])
const DIALOG_SCOPE_SELECTOR = 'dialog,[role="dialog"],[aria-modal="true"]'
const ZERO_VECTOR: WorldsVector3Like = { x: 0, y: 0, z: 0 }
const WORLD_UP: WorldsVector3Like = { x: 0, y: 1, z: 0 }
const DEFAULT_FORWARD: WorldsVector3Like = { x: 0, y: 0, z: -1 }
export const WORLD_CAMERA_COLLISION_HALF_EXTENTS = { x: 0.2, y: 0.35, z: 0.2 } as const
const WORLD_CAMERA_POSE_EPSILON = 1e-5

export function createWorldsCameraState(overrides: Partial<WorldsCameraState> = {}): WorldsCameraState {
  return {
    ...DEFAULT_WORLDS_CAMERA_STATE,
    ...overrides,
    speed: overrides.speed === undefined ? DEFAULT_WORLDS_CAMERA_STATE.speed : clampWorldsCameraSpeed(overrides.speed),
  }
}

export function clampWorldsCameraSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return DEFAULT_WORLDS_CAMERA_STATE.speed
  return Math.min(WORLD_CAMERA_SPEED_MAX, Math.max(WORLD_CAMERA_SPEED_MIN, speed))
}

export function getWorldsCameraSpeedLabel(speed: number): string {
  return `${clampWorldsCameraSpeed(speed).toLocaleString('en-US', { maximumFractionDigits: 2 })}×`
}

export function normalizeWorldCameraKey(code: string): WorldsMovementDirection | undefined {
  return MOVEMENT_KEY_BY_CODE[code]
}

export function updateWorldsMovementKeys(keys: WorldsMovementKeyState, code: string, pressed: boolean): Required<WorldsMovementKeyState> {
  const direction = normalizeWorldCameraKey(code)
  const next = normalizeMovementKeys(keys)
  if (direction) next[direction] = pressed
  return next
}

export function shouldIgnoreWorldCameraKeyTarget(target: WorldsKeyboardTargetLike | null | undefined): boolean {
  if (!target) return false
  const tagName = target.tagName?.toUpperCase()
  if (tagName && EDITABLE_TAG_NAMES.has(tagName)) return true
  if (target.isContentEditable) return true
  return Boolean(target.closest?.(DIALOG_SCOPE_SELECTOR))
}

export function shouldHandleWorldCameraKeyInput({ target, activeElement, inputScope }: WorldsKeyboardInputContext): boolean {
  if (!inputScope || !activeElement) return false
  if (!inputScope.contains(activeElement)) return false
  if (shouldIgnoreWorldCameraKeyTarget(target)) return false
  if (shouldIgnoreWorldCameraKeyTarget(activeElement)) return false
  return true
}

export function deriveWorldsMovementVector(keys: WorldsMovementKeyState, axes: WorldsMovementAxes): WorldsVector3Like {
  const movementKeys = normalizeMovementKeys(keys)
  const forward = normalizeVector(axes.forward)
  const right = normalizeVector(axes.right)
  const up = normalizeVector(axes.up ?? WORLD_UP)

  const x = axisAmount(movementKeys.right, movementKeys.left)
  const z = axisAmount(movementKeys.forward, movementKeys.backward)
  const y = axisAmount(movementKeys.up, movementKeys.down)

  return normalizeVector({
    x: right.x * x + forward.x * z + up.x * y,
    y: right.y * x + forward.y * z + up.y * y,
    z: right.z * x + forward.z * z + up.z * y,
  })
}

export function rotateWorldsCameraYawTarget({
  cameraPosition,
  target,
  yawAngle,
  up = WORLD_UP,
  fallbackLookDirection = DEFAULT_FORWARD,
  fallbackDistance = 1,
}: WorldsYawRotationInput): WorldsVector3Like {
  const lookOffset = {
    x: target.x - cameraPosition.x,
    y: target.y - cameraPosition.y,
    z: target.z - cameraPosition.z,
  }
  const offsetLength = Math.hypot(lookOffset.x, lookOffset.y, lookOffset.z)
  const baseOffset = offsetLength === 0
    ? scaleVector(normalizeVector(fallbackLookDirection), fallbackDistance)
    : lookOffset
  const rotatedOffset = rotateVectorAroundAxis(baseOffset, normalizeVector(up), yawAngle)

  return {
    x: cameraPosition.x + rotatedOffset.x,
    y: cameraPosition.y + rotatedOffset.y,
    z: cameraPosition.z + rotatedOffset.z,
  }
}

export function applyWorldsKeyboardCameraPose({
  cameraPosition,
  target,
  keys,
  speed,
  deltaSeconds,
  yawDirection = 0,
  up = WORLD_UP,
  collisionSurfaces = [],
  collisionHalfExtents = WORLD_CAMERA_COLLISION_HALF_EXTENTS,
}: ApplyWorldsKeyboardCameraPoseInput): ApplyWorldsKeyboardCameraPoseResult {
  const lookDirection = normalizeVector(subtractVectors(target, cameraPosition))
  const forward = lookDirection === ZERO_VECTOR ? DEFAULT_FORWARD : lookDirection
  const right = normalizeVector({
    x: forward.y * up.z - forward.z * up.y,
    y: forward.z * up.x - forward.x * up.z,
    z: forward.x * up.y - forward.y * up.x,
  })
  const movementDirection = deriveWorldsMovementVector(keys, { forward, right, up })
  const movementDelta = scaleVector(movementDirection, speed * deltaSeconds)
  const appliedMovementDelta = collisionSurfaces.length > 0
    ? resolveWorldCameraCollisionMovement(cameraPosition, movementDelta, collisionSurfaces, collisionHalfExtents)
    : movementDelta
  const nextCameraPosition = addVectors(cameraPosition, appliedMovementDelta)
  const translatedTarget = addVectors(target, appliedMovementDelta)

  if (yawDirection === 0) {
    return {
      cameraPosition: nextCameraPosition,
      target: translatedTarget,
    }
  }

  return {
    cameraPosition: nextCameraPosition,
    target: rotateWorldsCameraYawTarget({
      cameraPosition: nextCameraPosition,
      target: translatedTarget,
      yawAngle: yawDirection,
      up,
      fallbackLookDirection: forward,
    }),
  }
}

export function normalizeWorldSceneCollisionSurfaces(collisionSurfaces: readonly WorldCollisionSurface[]): WorldsResolvedCollisionSurface[] {
  const normalized: WorldsResolvedCollisionSurface[] = []
  const seenIds = new Set<string>()
  for (const surface of collisionSurfaces) {
    const resolved = resolveWorldCollisionSurface(surface)
    if (!resolved || seenIds.has(resolved.id)) continue
    seenIds.add(resolved.id)
    normalized.push(resolved)
  }
  return normalized
}

export function resolveWorldCameraCollisionMovement(
  position: WorldsVector3Like,
  delta: WorldsVector3Like,
  collisions: readonly (WorldsResolvedCollisionSurface | null | undefined)[],
  halfExtents: WorldsVector3Like = WORLD_CAMERA_COLLISION_HALF_EXTENTS,
): WorldsVector3Like {
  if (collisions.length === 0) return delta

  return resolveWorldSurfaceProbeTranslation({
    position,
    delta,
    probeHalfExtents: halfExtents,
    surfaces: collisions,
  }).acceptedDelta
}

export function classifyWorldsOrbitCameraPoseIntent({
  previousCameraPosition,
  previousTarget,
  nextCameraPosition,
  nextTarget,
  epsilon = WORLD_CAMERA_POSE_EPSILON,
}: WorldsOrbitCameraPoseIntentInput): WorldsOrbitCameraPoseIntentResult {
  const cameraDelta = subtractVectors(nextCameraPosition, previousCameraPosition)
  const targetDelta = subtractVectors(nextTarget, previousTarget)
  const cameraMoved = !isApproximatelyZeroVector(cameraDelta, epsilon)
  const targetMoved = !isApproximatelyZeroVector(targetDelta, epsilon)

  if (!cameraMoved && !targetMoved) return { intent: 'idle', cameraDelta, targetDelta }
  if (cameraMoved && targetMoved && areApproximatelyEqualVectors(cameraDelta, targetDelta, epsilon)) {
    return { intent: 'pan', cameraDelta, targetDelta }
  }
  if (cameraMoved && !targetMoved) return { intent: 'dolly', cameraDelta, targetDelta }
  if (!cameraMoved && targetMoved) return { intent: 'look', cameraDelta, targetDelta }
  return { intent: 'sync', cameraDelta, targetDelta }
}

export function resolveWorldsOrbitCameraPose({
  acceptedCameraPosition,
  acceptedTarget,
  desiredCameraPosition,
  desiredTarget,
  collisionBoxes,
  halfExtents = WORLD_CAMERA_COLLISION_HALF_EXTENTS,
  epsilon = WORLD_CAMERA_POSE_EPSILON,
}: ResolveWorldsOrbitCameraPoseInput): ResolveWorldsOrbitCameraPoseResult {
  const classification = classifyWorldsOrbitCameraPoseIntent({
    previousCameraPosition: acceptedCameraPosition,
    previousTarget: acceptedTarget,
    nextCameraPosition: desiredCameraPosition,
    nextTarget: desiredTarget,
    epsilon,
  })

  switch (classification.intent) {
    case 'pan': {
        const resolution = resolveWorldCollisionProbeTranslation({
          position: acceptedCameraPosition,
          delta: classification.cameraDelta,
          probeHalfExtents: halfExtents,
          collisionBoxes,
        })
        const appliedCameraDelta = subtractVectors(resolution.position, acceptedCameraPosition)
      const target = addVectors(acceptedTarget, appliedCameraDelta)
      return {
        intent: classification.intent,
        cameraPosition: resolution.position,
        target,
        corrected: !areApproximatelyEqualVectors(resolution.position, desiredCameraPosition, epsilon)
          || !areApproximatelyEqualVectors(target, desiredTarget, epsilon),
        collidedZoneIds: resolution.collidedZoneIds,
        depenetrated: !areApproximatelyEqualVectors(resolution.depenetration.position, acceptedCameraPosition, epsilon),
      }
    }
    case 'dolly': {
        const resolution = resolveWorldCollisionProbeTranslation({
          position: acceptedCameraPosition,
          delta: classification.cameraDelta,
          probeHalfExtents: halfExtents,
          collisionBoxes,
        })
        return {
        intent: classification.intent,
        cameraPosition: resolution.position,
        target: copyVector(acceptedTarget),
        corrected: !areApproximatelyEqualVectors(resolution.position, desiredCameraPosition, epsilon)
          || !areApproximatelyEqualVectors(acceptedTarget, desiredTarget, epsilon),
        collidedZoneIds: resolution.collidedZoneIds,
        depenetrated: !areApproximatelyEqualVectors(resolution.depenetration.position, acceptedCameraPosition, epsilon),
      }
    }
    case 'look': {
        const resolution = resolveWorldCollisionProbeTranslation({
          position: acceptedCameraPosition,
          delta: ZERO_VECTOR,
          probeHalfExtents: halfExtents,
          collisionBoxes,
        })
        return {
        intent: classification.intent,
        cameraPosition: resolution.position,
        target: copyVector(desiredTarget),
        corrected: !areApproximatelyEqualVectors(resolution.position, desiredCameraPosition, epsilon),
        collidedZoneIds: resolution.collidedZoneIds,
        depenetrated: !areApproximatelyEqualVectors(resolution.depenetration.position, acceptedCameraPosition, epsilon),
      }
    }
    case 'sync': {
        const resolution = resolveWorldCollisionProbeTranslation({
          position: desiredCameraPosition,
          delta: ZERO_VECTOR,
          probeHalfExtents: halfExtents,
          collisionBoxes,
        })
        return {
        intent: classification.intent,
        cameraPosition: resolution.position,
        target: copyVector(desiredTarget),
        corrected: !areApproximatelyEqualVectors(resolution.position, desiredCameraPosition, epsilon),
        collidedZoneIds: resolution.collidedZoneIds,
        depenetrated: !areApproximatelyEqualVectors(resolution.depenetration.position, desiredCameraPosition, epsilon),
      }
    }
    case 'idle':
    default: {
        const resolution = resolveWorldCollisionProbeTranslation({
          position: acceptedCameraPosition,
          delta: ZERO_VECTOR,
          probeHalfExtents: halfExtents,
          collisionBoxes,
        })
        return {
        intent: classification.intent,
        cameraPosition: resolution.position,
        target: copyVector(desiredTarget),
        corrected: !areApproximatelyEqualVectors(resolution.position, desiredCameraPosition, epsilon),
        collidedZoneIds: resolution.collidedZoneIds,
        depenetrated: !areApproximatelyEqualVectors(resolution.depenetration.position, acceptedCameraPosition, epsilon),
      }
    }
  }
}

function normalizeMovementKeys(keys: WorldsMovementKeyState): Required<WorldsMovementKeyState> {
  return {
    forward: Boolean(keys.forward),
    backward: Boolean(keys.backward),
    left: Boolean(keys.left),
    right: Boolean(keys.right),
    up: Boolean(keys.up),
    down: Boolean(keys.down),
  }
}

function rotateVectorAroundAxis(vector: WorldsVector3Like, axis: WorldsVector3Like, angle: number): WorldsVector3Like {
  const normalizedAxis = normalizeVector(axis)
  if (normalizedAxis === ZERO_VECTOR) return vector

  const cosAngle = Math.cos(angle)
  const sinAngle = Math.sin(angle)
  const dot = vector.x * normalizedAxis.x + vector.y * normalizedAxis.y + vector.z * normalizedAxis.z
  const cross = {
    x: normalizedAxis.y * vector.z - normalizedAxis.z * vector.y,
    y: normalizedAxis.z * vector.x - normalizedAxis.x * vector.z,
    z: normalizedAxis.x * vector.y - normalizedAxis.y * vector.x,
  }

  return {
    x: vector.x * cosAngle + cross.x * sinAngle + normalizedAxis.x * dot * (1 - cosAngle),
    y: vector.y * cosAngle + cross.y * sinAngle + normalizedAxis.y * dot * (1 - cosAngle),
    z: vector.z * cosAngle + cross.z * sinAngle + normalizedAxis.z * dot * (1 - cosAngle),
  }
}

function scaleVector(vector: WorldsVector3Like, scalar: number): WorldsVector3Like {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
    z: vector.z * scalar,
  }
}

function axisAmount(positive: boolean, negative: boolean): number {
  return Number(positive) - Number(negative)
}

function addVectors(left: WorldsVector3Like, right: WorldsVector3Like): WorldsVector3Like {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  }
}

function subtractVectors(left: WorldsVector3Like, right: WorldsVector3Like): WorldsVector3Like {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  }
}

function copyVector(vector: WorldsVector3Like): WorldsVector3Like {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  }
}

function normalizeVector(vector: WorldsVector3Like): WorldsVector3Like {
  const length = Math.hypot(vector.x, vector.y, vector.z)
  if (length === 0) return ZERO_VECTOR
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  }
}

function isApproximatelyZeroVector(vector: WorldsVector3Like, epsilon: number): boolean {
  return Math.abs(vector.x) <= epsilon && Math.abs(vector.y) <= epsilon && Math.abs(vector.z) <= epsilon
}

function areApproximatelyEqualVectors(left: WorldsVector3Like, right: WorldsVector3Like, epsilon: number): boolean {
  return isApproximatelyZeroVector(subtractVectors(left, right), epsilon)
}

function normalizeWorldCameraCollisionShapes(collisions: readonly WorldsCameraCollisionShape[]): WorldsCollisionBox[] {
  return collisions.map((collision) => isWorldsCollisionBox(collision) ? collision : worldCollisionBoxFromAabb(collision))
}

function isWorldsCollisionBox(collision: WorldsCameraCollisionShape): collision is WorldsCollisionBox {
  return 'transform' in collision && 'halfExtents' in collision && 'worldAabb' in collision
}

function worldCollisionBoxFromAabb(collision: WorldsCollisionAabb): WorldsCollisionBox {
  const center = {
    x: (collision.min.x + collision.max.x) * 0.5,
    y: (collision.min.y + collision.max.y) * 0.5,
    z: (collision.min.z + collision.max.z) * 0.5,
  }
  return {
    zoneId: collision.zoneId,
    halfExtents: {
      x: Math.abs(collision.max.x - collision.min.x) * 0.5,
      y: Math.abs(collision.max.y - collision.min.y) * 0.5,
      z: Math.abs(collision.max.z - collision.min.z) * 0.5,
    },
    transform: {
      position: center,
      axes: [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
      ],
    },
    worldAabb: {
      min: { ...collision.min },
      max: { ...collision.max },
    },
  }
}
