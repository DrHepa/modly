import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import type { WorldSceneItem } from './worldRenderableResolver.ts'
import { createWorldCollisionSurfacePreset } from './worldsCollisionSurfaces.ts'
import {
  applyWorldsKeyboardCameraPose,
  DEFAULT_WORLDS_CAMERA_STATE,
  WORLD_CAMERA_COLLISION_HALF_EXTENTS,
  WORLD_CAMERA_LOOK_PITCH_LIMIT,
  WORLD_CAMERA_SPEED_PRESETS,
  clampWorldsCameraSpeed,
  createWorldsCameraState,
  deriveWorldsMovementVector,
  getWorldsCameraSpeedLabel,
  normalizeWorldCameraKey,
  resolveWorldCameraCollisionMovement,
  rotateWorldsCameraYawTarget,
  shouldHandleWorldCameraKeyInput,
  shouldIgnoreWorldCameraKeyTarget,
  updateWorldsMovementKeys,
} from './worldCameraNavigation.ts'
import { normalizeWorldSceneCollisionSurfaces } from './worldCameraNavigation.ts'

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
  assert.equal(normalizeWorldCameraKey('KeyQ'), undefined)
  assert.equal(normalizeWorldCameraKey('KeyE'), undefined)
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

test('yaw helper rotates camera look target in place without moving the camera position', () => {
  const cameraPosition = { x: 4, y: 2, z: 6 }
  const target = { x: 4, y: 2, z: 1 }

  const yawedTarget = rotateWorldsCameraYawTarget({
    cameraPosition,
    target,
    yawAngle: Math.PI / 2,
  })

  assert.deepEqual(cameraPosition, { x: 4, y: 2, z: 6 })
  assert.ok(Math.abs(yawedTarget.x - (-1)) < 1e-9)
  assert.ok(Math.abs(yawedTarget.y - 2) < 1e-9)
  assert.ok(Math.abs(yawedTarget.z - 6) < 1e-9)
})

test('yaw helper falls back to camera look direction when target is at camera position', () => {
  const yawedTarget = rotateWorldsCameraYawTarget({
    cameraPosition: { x: 1, y: 3, z: 5 },
    target: { x: 1, y: 3, z: 5 },
    yawAngle: -Math.PI / 2,
    fallbackLookDirection: { x: 0, y: 0, z: -1 },
  })

  assert.ok(Math.abs(yawedTarget.x - 2) < 1e-9)
  assert.ok(Math.abs(yawedTarget.y - 3) < 1e-9)
  assert.ok(Math.abs(yawedTarget.z - 5) < 1e-9)
})

test('keyboard pose helper restores A and D as pure strafing without yaw drift', () => {
  const basePose = {
    cameraPosition: { x: 0, y: 1, z: 5 },
    target: { x: 0, y: 1, z: 0 },
    speed: 2,
    deltaSeconds: 0.5,
  }

  const strafeLeft = applyWorldsKeyboardCameraPose({
    ...basePose,
    keys: { left: true },
  })
  const strafeRight = applyWorldsKeyboardCameraPose({
    ...basePose,
    keys: { right: true },
  })

  assert.deepEqual(strafeLeft.cameraPosition, { x: -1, y: 1, z: 5 })
  assert.deepEqual(strafeLeft.target, { x: -1, y: 1, z: 0 })
  assert.deepEqual(strafeRight.cameraPosition, { x: 1, y: 1, z: 5 })
  assert.deepEqual(strafeRight.target, { x: 1, y: 1, z: 0 })
})

test('keyboard pose helper restores Q and E as in-place yaw that preserves camera position', () => {
  const basePose = {
    cameraPosition: { x: 0, y: 1, z: 5 },
    target: { x: 0, y: 1, z: 0 },
    keys: {},
    speed: 2,
    deltaSeconds: 0.5,
  }

  const yawLeft = applyWorldsKeyboardCameraPose({
    ...basePose,
    yawDirection: Math.PI / 2,
  })
  const yawRight = applyWorldsKeyboardCameraPose({
    ...basePose,
    yawDirection: -Math.PI / 2,
  })

  assert.deepEqual(yawLeft.cameraPosition, basePose.cameraPosition)
  assert.deepEqual(yawRight.cameraPosition, basePose.cameraPosition)
  assert.ok(Math.abs(yawLeft.target.x + 5) < 1e-9)
  assert.ok(Math.abs(yawLeft.target.y - 1) < 1e-9)
  assert.ok(Math.abs(yawLeft.target.z - 5) < 1e-9)
  assert.ok(Math.abs(yawRight.target.x - 5) < 1e-9)
  assert.ok(Math.abs(yawRight.target.y - 1) < 1e-9)
  assert.ok(Math.abs(yawRight.target.z - 5) < 1e-9)
})

test('keyboard pose helper restores Space and Shift as vertical translation of camera and target together', () => {
  const basePose = {
    cameraPosition: { x: 2, y: 1, z: 5 },
    target: { x: 3, y: 2, z: 0 },
    speed: 4,
    deltaSeconds: 0.25,
  }
  const originalLookVector = {
    x: basePose.target.x - basePose.cameraPosition.x,
    y: basePose.target.y - basePose.cameraPosition.y,
    z: basePose.target.z - basePose.cameraPosition.z,
  }

  const moveUp = applyWorldsKeyboardCameraPose({
    ...basePose,
    keys: { up: true },
  })
  const moveDown = applyWorldsKeyboardCameraPose({
    ...basePose,
    keys: { down: true },
  })

  assert.equal(moveUp.cameraPosition.y - basePose.cameraPosition.y, 1)
  assert.equal(moveUp.target.y - basePose.target.y, 1)
  assert.equal(moveDown.cameraPosition.y - basePose.cameraPosition.y, -1)
  assert.equal(moveDown.target.y - basePose.target.y, -1)
  assert.deepEqual({
    x: moveUp.target.x - moveUp.cameraPosition.x,
    y: moveUp.target.y - moveUp.cameraPosition.y,
    z: moveUp.target.z - moveUp.cameraPosition.z,
  }, originalLookVector)
  assert.deepEqual({
    x: moveDown.target.x - moveDown.cameraPosition.x,
    y: moveDown.target.y - moveDown.cameraPosition.y,
    z: moveDown.target.z - moveDown.cameraPosition.z,
  }, originalLookVector)
})

test('keyboard pose helper stays smooth across repeated frames without mediator reinterpretation', () => {
  let pose = {
    cameraPosition: { x: 0, y: 1, z: 5 },
    target: { x: 0, y: 1, z: 0 },
  }

  for (let index = 0; index < 5; index += 1) {
    const nextPose = applyWorldsKeyboardCameraPose({
      ...pose,
      keys: { left: true, forward: true },
      speed: 2,
      deltaSeconds: 0.25,
    })
    assert.ok(Math.abs((nextPose.cameraPosition.x - pose.cameraPosition.x) + Math.SQRT1_2 / 2) < 1e-9)
    assert.ok(Math.abs((nextPose.cameraPosition.z - pose.cameraPosition.z) + Math.SQRT1_2 / 2) < 1e-9)
    const lookVector = {
      x: nextPose.target.x - nextPose.cameraPosition.x,
      y: nextPose.target.y - nextPose.cameraPosition.y,
      z: nextPose.target.z - nextPose.cameraPosition.z,
    }
    assert.ok(Math.abs(lookVector.x) < 1e-9)
    assert.ok(Math.abs(lookVector.y) < 1e-9)
    assert.ok(Math.abs(lookVector.z + 5) < 1e-9)
    pose = nextPose
  }
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

test('collision helpers normalize world collision surfaces for active keyboard navigation', () => {
  const rect = createWorldCollisionSurfacePreset('wall', { id: 'wall-1' })
  const tri = createWorldCollisionSurfacePreset('triangle', { id: 'tri-1' })
  assert.ok(rect)
  assert.ok(tri)

  const collisions = normalizeWorldSceneCollisionSurfaces([rect!, tri!])

  assert.equal(collisions.length, 2)
  assert.equal(collisions[0]?.id, 'wall-1')
  assert.equal(collisions[1]?.id, 'tri-1')
})

test('collision helpers use the surface solver for keyboard movement without changing the direct movement semantics', () => {
  const wall = createWorldCollisionSurfacePreset('wall', { id: 'wall' })
  assert.ok(wall)
  const collisions = normalizeWorldSceneCollisionSurfaces([wall!])

  const unblocked = resolveWorldCameraCollisionMovement(
    { x: 1.7, y: 0, z: 1.7 },
    { x: 0.2, y: 0, z: 0 },
    collisions,
  )
  const blocked = resolveWorldCameraCollisionMovement(
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 0, z: 2 },
    collisions,
  )

  assert.deepEqual(unblocked, { x: 0.2, y: 0, z: 0 })
  assert.equal(blocked.x, 0)
  assert.equal(blocked.y, 0)
  assert.ok(blocked.z > 0.79)
  assert.ok(blocked.z < 0.81)
})

test('keyboard pose helper uses collision surfaces to clamp forward motion at walls', () => {
  const wall = createWorldCollisionSurfacePreset('wall', { id: 'wall' })
  assert.ok(wall)
  const collisionSurfaces = normalizeWorldSceneCollisionSurfaces([wall!])

  const pose = applyWorldsKeyboardCameraPose({
    cameraPosition: { x: 0, y: 0, z: -1 },
    target: { x: 0, y: 0, z: -3 },
    keys: { backward: true },
    speed: 4,
    deltaSeconds: 0.5,
    collisionSurfaces,
    collisionHalfExtents: WORLD_CAMERA_COLLISION_HALF_EXTENTS,
  })

  assert.ok(pose.cameraPosition.z < -0.19)
  assert.ok(pose.cameraPosition.z > -0.21)
  assert.ok(pose.target.z < -2.19)
})

test('camera navigation source keeps right-drag pan and wheel on original OrbitControls without a collision mediator', async () => {
  const source = await readFile(navigationSourcePath, 'utf8')

  assert.equal(source.includes('collisionZones'), false)
  assert.equal(source.includes('buildWorldSceneCollisionAabbs'), false)
})
