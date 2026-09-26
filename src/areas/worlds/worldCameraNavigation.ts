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

export interface WorldsCameraState {
  speed: number
  resetToken: number
}

export const WORLDS_VIEWPORT_CONTROL_MODES = ['inspect', 'fly', 'run'] as const

export type WorldsViewportControlMode = typeof WORLDS_VIEWPORT_CONTROL_MODES[number]

export const DEFAULT_WORLDS_VIEWPORT_CONTROL_MODE: WorldsViewportControlMode = 'inspect'

export type WorldsMovementDirection = 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down'

export type WorldsMovementKeyState = Partial<Record<WorldsMovementDirection, boolean>>

export type WorldsNavigationKeyState = WorldsMovementKeyState & {
  rollLeft?: boolean
  rollRight?: boolean
  boost?: boolean
  jump?: boolean
}

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

export interface WorldsViewportNavigationPose {
  position: WorldsVector3Like
  forward: WorldsVector3Like
  up?: WorldsVector3Like
  roll?: number
}

export interface WorldsRunNavigationState {
  velocityY: number
  grounded: boolean
  usedGroundFallback: boolean
  lastSafePosition: WorldsVector3Like
  jumpHeld: boolean
}

export interface ApplyWorldsFlyNavigationInput {
  pose: WorldsViewportNavigationPose
  keys: WorldsNavigationKeyState
  deltaSeconds: number
  speed?: number
}

export interface ApplyWorldsRunNavigationInput {
  pose: WorldsViewportNavigationPose
  state: WorldsRunNavigationState
  keys: WorldsNavigationKeyState
  deltaSeconds: number
  collisionSurfaces?: readonly (WorldsResolvedCollisionSurface | null | undefined)[]
}

export interface WorldsViewportNavigationResult {
  pose: WorldsViewportNavigationPose
  state?: WorldsRunNavigationState
  status: 'idle' | 'moving' | 'ground-only-fallback' | 'fall-recovered'
}

export interface WorldsOrbitHandoffInput {
  position: WorldsVector3Like
  forward: WorldsVector3Like
  distance?: number
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

const INTERACTIVE_TAG_NAMES = new Set([
  'A',
  'AREA',
  'AUDIO',
  'BUTTON',
  'DETAILS',
  'INPUT',
  'LABEL',
  'OPTGROUP',
  'OPTION',
  'SELECT',
  'SUMMARY',
  'TEXTAREA',
  'VIDEO',
])
const DIALOG_SCOPE_SELECTOR = 'dialog,[role="dialog"],[aria-modal="true"]'
const ZERO_VECTOR: WorldsVector3Like = { x: 0, y: 0, z: 0 }
const WORLD_UP: WorldsVector3Like = { x: 0, y: 1, z: 0 }
const DEFAULT_FORWARD: WorldsVector3Like = { x: 0, y: 0, z: -1 }
export const WORLD_CAMERA_COLLISION_HALF_EXTENTS = { x: 0.2, y: 0.35, z: 0.2 } as const
const WORLD_CAMERA_POSE_EPSILON = 1e-5
const FLY_BASE_SPEED = 4
const FLY_ROLL_SPEED = Math.PI
const RUN_WALK_SPEED = 3
const RUN_BOOST_SPEED = 6
const RUN_GRAVITY = -9.81
const RUN_JUMP_SPEED = 4.4
const RUN_MAX_FALL_SPEED = -32
const RUN_STEP_SECONDS = 1 / 60
const RUN_MAX_STEPS = 4
const RUN_FALL_RECOVERY_Y = -40
const RUN_GROUND_PROBE_DISTANCE = 1e-3
export const WORLD_RUN_GROUND_FALLBACK_LABEL = 'Ground-only fallback — no editor-navigation surfaces'
export const WORLD_RUN_PROBE_HALF_EXTENTS = { x: 0.30, y: 0.90, z: 0.30 } as const

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
  if (tagName && INTERACTIVE_TAG_NAMES.has(tagName)) return true
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

export function isWorldsViewportControlMode(value: unknown): value is WorldsViewportControlMode {
  return typeof value === 'string' && (WORLDS_VIEWPORT_CONTROL_MODES as readonly string[]).includes(value)
}

export function resolveWorldsViewportModeShortcut(code: string): WorldsViewportControlMode | null {
  if (code === 'Digit1') return 'inspect'
  if (code === 'Digit2') return 'fly'
  if (code === 'Digit3') return 'run'
  return null
}

export function applyWorldsViewportModeShortcut(
  mode: WorldsViewportControlMode,
  code: string,
  context: WorldsKeyboardInputContext,
): WorldsViewportControlMode {
  if (!shouldHandleWorldCameraKeyInput(context)) return mode
  return resolveWorldsViewportModeShortcut(code) ?? mode
}

/**
 * Maps viewport navigation input without reusing the legacy camera key map.
 * Fly owns camera-local vertical motion and roll, while Run owns jump; Shift is
 * boost-only in both modes and can therefore never also move the camera down.
 */
export function updateWorldsViewportNavigationKeys(
  keys: WorldsNavigationKeyState,
  mode: WorldsViewportControlMode,
  code: string,
  pressed: boolean,
): WorldsNavigationKeyState {
  if (mode === 'inspect') return keys
  const direction = viewportPlanarDirection(code)
  const modeKey = direction !== null
    || code === 'ShiftLeft' || code === 'ShiftRight'
    || (mode === 'fly' && (code === 'Space' || code === 'ControlLeft' || code === 'ControlRight' || code === 'KeyQ' || code === 'KeyE'))
    || (mode === 'run' && code === 'Space')
  if (!modeKey) return keys
  const next = { ...keys }
  if (direction) next[direction] = pressed
  if (code === 'ShiftLeft' || code === 'ShiftRight') next.boost = pressed
  if (mode === 'fly') {
    if (code === 'Space') next.up = pressed
    if (code === 'ControlLeft' || code === 'ControlRight') next.down = pressed
    if (code === 'KeyQ') next.rollLeft = pressed
    if (code === 'KeyE') next.rollRight = pressed
  } else if (code === 'Space') {
    next.jump = pressed
  }
  return next
}

export function shouldWorldsViewportModeConsumeMovement(mode: WorldsViewportControlMode): boolean {
  return mode !== 'inspect'
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

export function createWorldsRunNavigationState(position: WorldsVector3Like): WorldsRunNavigationState {
  return {
    velocityY: 0,
    grounded: false,
    usedGroundFallback: false,
    lastSafePosition: copyVector(position),
    jumpHeld: false,
  }
}

export function createWorldsOrbitTargetFromNavigation({
  position,
  forward,
  distance = 4,
}: WorldsOrbitHandoffInput): WorldsVector3Like {
  const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : 4
  return addVectors(position, scaleVector(normalizeVector(forward) === ZERO_VECTOR ? DEFAULT_FORWARD : normalizeVector(forward), safeDistance))
}

export function getWorldsOrbitHandoffDistance(
  position: WorldsVector3Like,
  target: WorldsVector3Like,
  fallbackDistance = 4,
): number {
  const distance = Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z)
  if (Number.isFinite(distance) && distance > WORLD_CAMERA_POSE_EPSILON) return distance
  return Number.isFinite(fallbackDistance) && fallbackDistance > WORLD_CAMERA_POSE_EPSILON ? fallbackDistance : 4
}

export function deriveWorldsNavigationPoseFromOrbit(
  position: WorldsVector3Like,
  target: WorldsVector3Like,
  fallbackForward: WorldsVector3Like = DEFAULT_FORWARD,
): WorldsViewportNavigationPose {
  const forward = normalizeVector(subtractVectors(target, position))
  return {
    position: copyVector(position),
    forward: forward === ZERO_VECTOR ? normalizeVector(fallbackForward) : forward,
    up: WORLD_UP,
    roll: 0,
  }
}

export function applyWorldsFlyNavigation({
  pose,
  keys,
  deltaSeconds,
  speed = FLY_BASE_SPEED,
}: ApplyWorldsFlyNavigationInput): WorldsViewportNavigationResult {
  const clampedDelta = clampNavigationDelta(deltaSeconds)
  const forward = normalizeVector(pose.forward) === ZERO_VECTOR ? DEFAULT_FORWARD : normalizeVector(pose.forward)
  const right = normalizeVector(crossVectors(forward, pose.up ?? WORLD_UP))
  const up = normalizeVector(pose.up ?? WORLD_UP)
  const movementDirection = deriveWorldsMovementVector(keys, { forward, right, up })
  const boost = keys.boost ? 3 : 1
  const nextRoll = (pose.roll ?? 0) + axisAmount(Boolean(keys.rollRight), Boolean(keys.rollLeft)) * FLY_ROLL_SPEED * clampedDelta
  const delta = scaleVector(movementDirection, speed * boost * clampedDelta)
  return {
    pose: {
      position: addVectors(pose.position, delta),
      forward,
      up,
      roll: nextRoll,
    },
    status: isApproximatelyZeroVector(delta, WORLD_CAMERA_POSE_EPSILON) && nextRoll === (pose.roll ?? 0) ? 'idle' : 'moving',
  }
}

export function applyWorldsRunNavigation({
  pose,
  state,
  keys,
  deltaSeconds,
  collisionSurfaces = [],
}: ApplyWorldsRunNavigationInput): WorldsViewportNavigationResult {
  const steps = Math.max(1, Math.min(RUN_MAX_STEPS, Math.ceil(clampNavigationDelta(deltaSeconds) / RUN_STEP_SECONDS)))
  const stepDelta = Math.min(clampNavigationDelta(deltaSeconds), RUN_STEP_SECONDS * RUN_MAX_STEPS) / steps
  let position = copyVector(pose.position)
  let velocityY = state.velocityY
  let grounded = state.grounded
  let lastSafePosition = copyVector(state.lastSafePosition)
  let usedGroundFallback = false
  let status: WorldsViewportNavigationResult['status'] = 'idle'
  const surfaces = collisionSurfaces.filter(Boolean) as WorldsResolvedCollisionSurface[]
  const horizontalForward = normalizeVector({ x: pose.forward.x, y: 0, z: pose.forward.z })
  const forward = horizontalForward === ZERO_VECTOR ? DEFAULT_FORWARD : horizontalForward
  const right = normalizeVector(crossVectors(forward, WORLD_UP))

  if (surfaces.length === 0) {
    usedGroundFallback = true
    grounded = true
    velocityY = 0
    status = 'ground-only-fallback'
  } else {
    if (state.usedGroundFallback) grounded = false
    if (!grounded && velocityY <= 0) {
      const groundProbe = resolveWorldCameraCollisionMovement(
        position,
        { x: 0, y: -RUN_GROUND_PROBE_DISTANCE, z: 0 },
        surfaces,
        WORLD_RUN_PROBE_HALF_EXTENTS,
      )
      grounded = Math.abs(groundProbe.y) < RUN_GROUND_PROBE_DISTANCE
    }
  }

  for (let index = 0; index < steps; index += 1) {
    const horizontalDirection = deriveWorldsMovementVector({
      forward: keys.forward,
      backward: keys.backward,
      left: keys.left,
      right: keys.right,
    }, { forward, right, up: ZERO_VECTOR })
    const horizontalSpeed = keys.boost ? RUN_BOOST_SPEED : RUN_WALK_SPEED
    const horizontalDelta = scaleVector(horizontalDirection, horizontalSpeed * stepDelta)

    if (surfaces.length === 0) {
      position = addVectors(position, horizontalDelta)
      position.y = pose.position.y
      grounded = true
      velocityY = 0
      continue
    }

    const jumpRequested = Boolean(keys.jump) && !state.jumpHeld && grounded
    if (jumpRequested) {
      velocityY = RUN_JUMP_SPEED
      grounded = false
    }
    velocityY = Math.max(RUN_MAX_FALL_SPEED, velocityY + RUN_GRAVITY * stepDelta)
    const verticalDelta = { x: 0, y: velocityY * stepDelta, z: 0 }
    const movedHorizontal = resolveWorldCameraCollisionMovement(position, horizontalDelta, surfaces, WORLD_RUN_PROBE_HALF_EXTENTS)
    position = addVectors(position, movedHorizontal)
    const movedVertical = resolveWorldCameraCollisionMovement(position, verticalDelta, surfaces, WORLD_RUN_PROBE_HALF_EXTENTS)
    position = addVectors(position, movedVertical)
    grounded = verticalDelta.y < 0 && Math.abs(movedVertical.y) < Math.abs(verticalDelta.y)
    if (grounded) velocityY = 0
    if (!isApproximatelyZeroVector(horizontalDelta, WORLD_CAMERA_POSE_EPSILON) || Math.abs(verticalDelta.y) > WORLD_CAMERA_POSE_EPSILON) status = status === 'ground-only-fallback' ? status : 'moving'
    if (grounded) lastSafePosition = copyVector(position)
  }

  if (position.y < RUN_FALL_RECOVERY_Y) {
    position = copyVector(lastSafePosition)
    velocityY = 0
    grounded = true
    status = 'fall-recovered'
  }

  return {
    pose: {
      position,
      forward,
      up: WORLD_UP,
      roll: 0,
    },
    state: {
      velocityY,
      grounded,
      usedGroundFallback,
      lastSafePosition,
      jumpHeld: Boolean(keys.jump),
    },
    status,
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

function viewportPlanarDirection(code: string): Extract<WorldsMovementDirection, 'forward' | 'backward' | 'left' | 'right'> | null {
  if (code === 'KeyW' || code === 'ArrowUp') return 'forward'
  if (code === 'KeyS' || code === 'ArrowDown') return 'backward'
  if (code === 'KeyA' || code === 'ArrowLeft') return 'left'
  if (code === 'KeyD' || code === 'ArrowRight') return 'right'
  return null
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

function crossVectors(left: WorldsVector3Like, right: WorldsVector3Like): WorldsVector3Like {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  }
}

function copyVector(vector: WorldsVector3Like): WorldsVector3Like {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  }
}

function clampNavigationDelta(deltaSeconds: number): number {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return 0
  return Math.min(deltaSeconds, RUN_STEP_SECONDS * RUN_MAX_STEPS)
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
