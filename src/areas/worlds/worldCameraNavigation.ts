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
  KeyE: 'up',
  KeyQ: 'down',
  ShiftLeft: 'down',
  ShiftRight: 'down',
}

const EDITABLE_TAG_NAMES = new Set(['INPUT', 'SELECT', 'TEXTAREA'])
const DIALOG_SCOPE_SELECTOR = 'dialog,[role="dialog"],[aria-modal="true"]'
const ZERO_VECTOR: WorldsVector3Like = { x: 0, y: 0, z: 0 }
const WORLD_UP: WorldsVector3Like = { x: 0, y: 1, z: 0 }

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

function axisAmount(positive: boolean, negative: boolean): number {
  return Number(positive) - Number(negative)
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
