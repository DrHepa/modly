import { useEffect, useRef, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

import {
  applyWorldsKeyboardCameraPose,
  WORLD_CAMERA_COLLISION_HALF_EXTENTS,
  normalizeWorldCameraKey,
  shouldHandleWorldCameraKeyInput,
  updateWorldsMovementKeys,
  type WorldsMovementKeyState,
} from '../worldCameraNavigation.ts'
import type { WorldsResolvedCollisionSurface } from '../worldsSurfaceMath.ts'

export interface WorldsKeyboardCameraControlsProps {
  collisionSurfaces: WorldsResolvedCollisionSurface[]
  speed: number
  inputScopeRef: RefObject<HTMLElement>
  orbitControlsRef: RefObject<WorldsOrbitControlsHandle | null>
}

export type WorldsOrbitControlsHandle = {
  target: THREE.Vector3
  maxDistance: number
  update: () => void
  saveState?: () => void
}

const WORLD_CAMERA_YAW_SPEED = Math.PI / 2

type WorldsRotationKeyState = {
  yawLeft: boolean
  yawRight: boolean
}

function isWorldCameraRotationKey(code: string): code is 'KeyQ' | 'KeyE' {
  return code === 'KeyQ' || code === 'KeyE'
}

function updateWorldsRotationKeys(keys: WorldsRotationKeyState, code: 'KeyQ' | 'KeyE', pressed: boolean): WorldsRotationKeyState {
  if (code === 'KeyQ') return { ...keys, yawLeft: pressed }
  return { ...keys, yawRight: pressed }
}

export function WorldsKeyboardCameraControls({ collisionSurfaces, speed, inputScopeRef, orbitControlsRef }: WorldsKeyboardCameraControlsProps): null {
  const keysRef = useRef<WorldsMovementKeyState>({})
  const rotationKeysRef = useRef<WorldsRotationKeyState>({ yawLeft: false, yawRight: false })
  const collisionsRef = useRef<WorldsResolvedCollisionSurface[]>([])

  useEffect(() => {
    collisionsRef.current = collisionSurfaces
  }, [collisionSurfaces])

  useEffect(() => {
    const isScopedEvent = (event: KeyboardEvent): boolean =>
      shouldHandleWorldCameraKeyInput({
        target: event.target as HTMLElement | null,
        activeElement: document.activeElement as HTMLElement | null,
        inputScope: inputScopeRef.current,
      })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isScopedEvent(event)) return
      const movementKey = normalizeWorldCameraKey(event.code)
      const rotationKey = isWorldCameraRotationKey(event.code)
      if (!movementKey && !rotationKey) return
      if (movementKey) keysRef.current = updateWorldsMovementKeys(keysRef.current, event.code, true)
      if (rotationKey) rotationKeysRef.current = updateWorldsRotationKeys(rotationKeysRef.current, event.code, true)
      event.preventDefault()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (isWorldCameraRotationKey(event.code)) {
        rotationKeysRef.current = updateWorldsRotationKeys(rotationKeysRef.current, event.code, false)
      }
      keysRef.current = updateWorldsMovementKeys(keysRef.current, event.code, false)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      keysRef.current = {}
      rotationKeysRef.current = { yawLeft: false, yawRight: false }
    }
  }, [inputScopeRef])

  useFrame(({ camera }, delta) => {
    const scope = inputScopeRef.current
    if (!shouldHandleWorldCameraKeyInput({ target: document.activeElement as HTMLElement | null, activeElement: document.activeElement as HTMLElement | null, inputScope: scope })) {
      return
    }

    const yawDirection = Number(rotationKeysRef.current.yawLeft) - Number(rotationKeysRef.current.yawRight)
    const movementKeys = keysRef.current
    const hasMovement = Object.values(movementKeys).some(Boolean)
    const hasYaw = yawDirection !== 0

    if (!hasMovement && !hasYaw) return
    const controls = orbitControlsRef.current
    if (!controls) return

    const nextPose = applyWorldsKeyboardCameraPose({
      cameraPosition: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      keys: movementKeys,
      speed,
      deltaSeconds: delta,
      yawDirection: yawDirection * WORLD_CAMERA_YAW_SPEED * delta,
      up: camera.up,
      collisionSurfaces: collisionsRef.current,
      collisionHalfExtents: WORLD_CAMERA_COLLISION_HALF_EXTENTS,
    })

    camera.position.set(nextPose.cameraPosition.x, nextPose.cameraPosition.y, nextPose.cameraPosition.z)
    controls.target.set(nextPose.target.x, nextPose.target.y, nextPose.target.z)
    controls.update()
  })

  return null
}
