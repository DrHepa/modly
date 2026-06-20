import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import type { WorldSceneItem } from './worldRenderableResolver.ts'
import {
  DEFAULT_WORLDS_CAMERA_STATE,
  WORLD_CAMERA_LOOK_PITCH_LIMIT,
  WORLD_CAMERA_SPEED_PRESETS,
  clampWorldsCameraSpeed,
  createWorldsCameraState,
  deriveWorldsMovementVector,
  getWorldsCameraSpeedLabel,
  normalizeWorldCameraKey,
  shouldHandleWorldCameraKeyInput,
  shouldIgnoreWorldCameraKeyTarget,
  updateWorldsMovementKeys,
} from './worldCameraNavigation.ts'

const navigationSourcePath = path.join(import.meta.dirname, 'worldCameraNavigation.ts')

test('camera navigation exposes orbit-compatible keyboard state and compact speed labels without pointer lock', async () => {
  const source = await readFile(navigationSourcePath, 'utf8')

  assert.equal(source.includes('WORLD_CAMERA_MODES'), false)
  assert.equal(source.includes('WorldsCameraMode'), false)
  assert.equal(source.includes('pointerLocked'), false)
  assert.equal(source.includes('PointerLock'), false)
  assert.deepEqual(DEFAULT_WORLDS_CAMERA_STATE, {
    speed: 2,
    resetToken: 0,
  })
  assert.deepEqual(Object.keys(createWorldsCameraState()).sort(), ['resetToken', 'speed'])
  assert.deepEqual(createWorldsCameraState({ speed: 5, resetToken: 3 }), {
    speed: 5,
    resetToken: 3,
  })
  assert.deepEqual(WORLD_CAMERA_SPEED_PRESETS, [0.5, 1, 2, 5, 10])
  assert.ok(WORLD_CAMERA_LOOK_PITCH_LIMIT < Math.PI / 2)
  assert.equal(getWorldsCameraSpeedLabel(0.5), '0.5×')
  assert.equal(getWorldsCameraSpeedLabel(2), '2×')
})

test('camera speed helpers clamp invalid or out-of-range input to viewer-safe bounds', () => {
  assert.equal(clampWorldsCameraSpeed(-4), 0.25)
  assert.equal(clampWorldsCameraSpeed(3.75), 3.75)
  assert.equal(clampWorldsCameraSpeed(99), 20)
  assert.equal(clampWorldsCameraSpeed(Number.NaN), DEFAULT_WORLDS_CAMERA_STATE.speed)
})

test('movement key updates normalize WASD, arrows, vertical keys, and releases independently', () => {
  let keys = updateWorldsMovementKeys({}, 'KeyW', true)
  keys = updateWorldsMovementKeys(keys, 'ArrowRight', true)
  keys = updateWorldsMovementKeys(keys, 'Space', true)
  keys = updateWorldsMovementKeys(keys, 'ShiftRight', true)

  assert.deepEqual(keys, {
    forward: true,
    backward: false,
    left: false,
    right: true,
    up: true,
    down: true,
  })
  assert.equal(normalizeWorldCameraKey('KeyQ'), 'down')
  assert.equal(normalizeWorldCameraKey('Tab'), undefined)

  keys = updateWorldsMovementKeys(keys, 'KeyW', false)
  keys = updateWorldsMovementKeys(keys, 'ShiftRight', false)
  assert.equal(keys.forward, false)
  assert.equal(keys.down, false)
  assert.equal(keys.right, true)
})

test('movement vector derives normalized view-relative direction without mode input', () => {
  const lookingDown = deriveWorldsMovementVector(
    { forward: true },
    {
      forward: { x: 0, y: -0.7, z: -1 },
      right: { x: 1, y: 0, z: 0 },
    },
  )

  assert.equal(lookingDown.x, 0)
  assert.ok(Math.abs(lookingDown.y + 0.5734623443633283) < Number.EPSILON)
  assert.ok(Math.abs(lookingDown.z + 0.8192319205190405) < Number.EPSILON)

  const diagonal = deriveWorldsMovementVector(
    { forward: true, right: true, up: true },
    {
      forward: { x: 0, y: 0, z: -1 },
      right: { x: 1, y: 0, z: 0 },
    },
  )
  const component = 1 / Math.sqrt(3)
  assert.deepEqual(diagonal, { x: component, y: component, z: -component })

  assert.deepEqual(
    deriveWorldsMovementVector(
      { forward: true, backward: true, left: true, right: true, up: true, down: true },
      {
        forward: { x: 0, y: 0, z: -1 },
        right: { x: 1, y: 0, z: 0 },
      },
    ),
    { x: 0, y: 0, z: 0 },
  )

  const reverseDiagonal = deriveWorldsMovementVector(
    { left: true, down: true },
    {
      forward: { x: 0, y: 0, z: -1 },
      right: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 1, z: 0 },
    },
  )
  assert.equal(reverseDiagonal.x, 0)
  assert.ok(Math.abs(reverseDiagonal.y + Math.SQRT1_2) < Number.EPSILON)
  assert.ok(Math.abs(reverseDiagonal.z + Math.SQRT1_2) < Number.EPSILON)
})

test('keyboard guard ignores editable controls, selectors, dialogs, and contenteditable targets', () => {
  assert.equal(shouldIgnoreWorldCameraKeyTarget({ tagName: 'INPUT' }), true)
  assert.equal(shouldIgnoreWorldCameraKeyTarget({ tagName: 'select' }), true)
  assert.equal(shouldIgnoreWorldCameraKeyTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(shouldIgnoreWorldCameraKeyTarget({ isContentEditable: true, tagName: 'DIV' }), true)
  assert.equal(shouldIgnoreWorldCameraKeyTarget({ tagName: 'DIV', closest: (selector: string) => (selector === 'dialog,[role="dialog"],[aria-modal="true"]' ? {} : null) }), true)
  assert.equal(shouldIgnoreWorldCameraKeyTarget({ tagName: 'BUTTON', closest: (selector: string) => (selector === 'dialog,[role="dialog"],[aria-modal="true"]' ? {} : null) }), true)
  assert.equal(shouldIgnoreWorldCameraKeyTarget({ tagName: 'CANVAS', closest: () => null }), false)
})

test('keyboard input scope blocks movement while focused UI owns keys', () => {
  const viewerScope = {
    contains: (element: unknown) => element === canvas || element === selector || element === editable || element === dialogInput,
  }
  const canvas = { tagName: 'CANVAS', closest: () => null }
  const selector = { tagName: 'SELECT', closest: () => null }
  const editable = { tagName: 'DIV', isContentEditable: true, closest: () => null }
  const dialogInput = {
    tagName: 'INPUT',
    closest: (selectorText: string) => (selectorText === 'dialog,[role="dialog"],[aria-modal="true"]' ? {} : null),
  }
  const outsideCanvas = { tagName: 'CANVAS', closest: () => null }

  assert.equal(shouldHandleWorldCameraKeyInput({ target: canvas, activeElement: canvas, inputScope: viewerScope }), true)
  assert.equal(shouldHandleWorldCameraKeyInput({ target: canvas, activeElement: selector, inputScope: viewerScope }), false)
  assert.equal(shouldHandleWorldCameraKeyInput({ target: canvas, activeElement: editable, inputScope: viewerScope }), false)
  assert.equal(shouldHandleWorldCameraKeyInput({ target: canvas, activeElement: dialogInput, inputScope: viewerScope }), false)
  assert.equal(shouldHandleWorldCameraKeyInput({ target: outsideCanvas, activeElement: outsideCanvas, inputScope: viewerScope }), false)
  assert.equal(shouldHandleWorldCameraKeyInput({ target: selector, activeElement: canvas, inputScope: viewerScope }), false)
})

test('camera state stays viewer-local and separate from world scene item asset data', () => {
  const sceneItem: WorldSceneItem = {
    id: 'world:mesh.ply',
    workspacePath: 'mesh.ply',
    url: '/workspace/mesh.ply',
    kind: 'ply-mesh',
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }
  const cameraState = createWorldsCameraState({ speed: 5, resetToken: 3 })

  assert.deepEqual(Object.keys(cameraState).sort(), ['resetToken', 'speed'])
  assert.deepEqual(Object.keys(sceneItem).sort(), ['id', 'kind', 'transform', 'url', 'visible', 'workspacePath'])
  assert.equal('mode' in sceneItem, false)
  assert.equal('speed' in sceneItem, false)
  assert.deepEqual(sceneItem.transform, { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
})
