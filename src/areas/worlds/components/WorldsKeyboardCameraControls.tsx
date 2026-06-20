import { useEffect, useRef, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

import {
  deriveWorldsMovementVector,
  normalizeWorldCameraKey,
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

export function WorldsKeyboardCameraControls({ speed, inputScopeRef, orbitControlsRef }: WorldsKeyboardCameraControlsProps): null {
  const keysRef = useRef<WorldsMovementKeyState>({})

  useEffect(() => {
    const isScopedEvent = (event: KeyboardEvent): boolean =>
      shouldHandleWorldCameraKeyInput({
        target: event.target as HTMLElement | null,
        activeElement: document.activeElement as HTMLElement | null,
        inputScope: inputScopeRef.current,
      })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isScopedEvent(event)) return
      if (!normalizeWorldCameraKey(event.code)) return
      keysRef.current = updateWorldsMovementKeys(keysRef.current, event.code, true)
      event.preventDefault()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      keysRef.current = updateWorldsMovementKeys(keysRef.current, event.code, false)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      keysRef.current = {}
    }
  }, [inputScopeRef])

  useFrame(({ camera }, delta) => {
    const scope = inputScopeRef.current
    if (!shouldHandleWorldCameraKeyInput({ target: document.activeElement as HTMLElement | null, activeElement: document.activeElement as HTMLElement | null, inputScope: scope })) {
      return
    }

    camera.getWorldDirection(forwardVector)
    rightVector.crossVectors(forwardVector, camera.up)

    const movement = deriveWorldsMovementVector(keysRef.current, {
      forward: forwardVector,
      right: rightVector,
      up: camera.up,
    })

    if (movement.x === 0 && movement.y === 0 && movement.z === 0) return
    movementVector.set(movement.x, movement.y, movement.z)
    scaledMovementVector.copy(movementVector).multiplyScalar(speed * delta)
    camera.position.add(scaledMovementVector)
    orbitControlsRef.current?.target.add(scaledMovementVector)
    orbitControlsRef.current?.update()
  })

  return null
}
