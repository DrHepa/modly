import { useEffect, useRef, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

import {
  deriveWorldsMovementVector,
  normalizeWorldCameraKey,
  rotateWorldsCameraYawTarget,
  shouldHandleWorldCameraKeyInput,
  updateWorldsMovementKeys,
  type WorldsMovementKeyState,
} from '../worldCameraNavigation.ts'

export interface WorldsKeyboardCameraControlsProps {
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

const forwardVector = new THREE.Vector3()
const rightVector = new THREE.Vector3()
const movementVector = new THREE.Vector3()
const scaledMovementVector = new THREE.Vector3()
const lookDirectionVector = new THREE.Vector3()
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

export function WorldsKeyboardCameraControls({ speed, inputScopeRef, orbitControlsRef }: WorldsKeyboardCameraControlsProps): null {
  const keysRef = useRef<WorldsMovementKeyState>({})
  const heldCodesRef = useRef(new Set<string>())
  const rotationKeysRef = useRef<WorldsRotationKeyState>({ yawLeft: false, yawRight: false })

  useEffect(() => {
    const heldCodes = heldCodesRef.current
    const clearKeys = () => {
      heldCodes.clear()
      keysRef.current = {}
      rotationKeysRef.current = { yawLeft: false, yawRight: false }
    }
    const updateKeys = () => {
      let keys: WorldsMovementKeyState = {}
      for (const code of heldCodes) {
        keys = updateWorldsMovementKeys(keys, code, true)
      }
      keysRef.current = keys
    }
    const isScopedEvent = (event: KeyboardEvent): boolean =>
      shouldHandleWorldCameraKeyInput({
        target: event.target as HTMLElement | null,
        activeElement: document.activeElement as HTMLElement | null,
        inputScope: inputScopeRef.current,
      })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isScopedEvent(event)) { clearKeys(); return }
      const movementKey = normalizeWorldCameraKey(event.code)
      const rotationKey = isWorldCameraRotationKey(event.code)
      if (!movementKey && !rotationKey) return
      if (movementKey) {
        heldCodes.add(event.code)
        updateKeys()
      }
      if (rotationKey) rotationKeysRef.current = updateWorldsRotationKeys(rotationKeysRef.current, event.code, true)
      event.preventDefault()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (isWorldCameraRotationKey(event.code)) rotationKeysRef.current = updateWorldsRotationKeys(rotationKeysRef.current, event.code, false)
      heldCodes.delete(event.code)
      updateKeys()
    }

    const handleFocusChange = () => {
      if (!shouldHandleWorldCameraKeyInput({ activeElement: document.activeElement as HTMLElement | null, inputScope: inputScopeRef.current })) clearKeys()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', clearKeys)
    document.addEventListener('visibilitychange', clearKeys)
    document.addEventListener('focusin', handleFocusChange)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', clearKeys)
      document.removeEventListener('visibilitychange', clearKeys)
      document.removeEventListener('focusin', handleFocusChange)
      clearKeys()
    }
  }, [inputScopeRef])

  useFrame(({ camera }, delta) => {
    const scope = inputScopeRef.current
    if (!shouldHandleWorldCameraKeyInput({ target: document.activeElement as HTMLElement | null, activeElement: document.activeElement as HTMLElement | null, inputScope: scope })) {
      keysRef.current = {}
      heldCodesRef.current.clear()
      rotationKeysRef.current = { yawLeft: false, yawRight: false }
      return
    }

    camera.getWorldDirection(forwardVector)
    rightVector.crossVectors(forwardVector, camera.up)

    const movement = deriveWorldsMovementVector(keysRef.current, {
      forward: forwardVector,
      right: rightVector,
      up: camera.up,
    })

    const yawDirection = Number(rotationKeysRef.current.yawLeft) - Number(rotationKeysRef.current.yawRight)
    const hasMovement = movement.x !== 0 || movement.y !== 0 || movement.z !== 0
    const hasYaw = yawDirection !== 0

    if (!hasMovement && !hasYaw) return
    if (hasMovement) {
      movementVector.set(movement.x, movement.y, movement.z)
      scaledMovementVector.copy(movementVector).multiplyScalar(speed * delta)
      camera.position.add(scaledMovementVector)
      orbitControlsRef.current?.target.add(scaledMovementVector)
    }
    if (hasYaw && orbitControlsRef.current) {
      camera.getWorldDirection(lookDirectionVector)
      orbitControlsRef.current.target.copy(rotateWorldsCameraYawTarget({
        cameraPosition: camera.position,
        target: orbitControlsRef.current.target,
        yawAngle: yawDirection * WORLD_CAMERA_YAW_SPEED * delta,
        up: camera.up,
        fallbackLookDirection: lookDirectionVector,
      }))
    }
    orbitControlsRef.current?.update()
  })

  return null
}
