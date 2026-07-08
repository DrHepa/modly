import { useEffect, useRef, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

import {
  buildWorldSceneCollisionAabbs,
  deriveWorldsMovementVector,
  normalizeWorldCameraKey,
  resolveWorldCameraCollisionMovement,
  rotateWorldsCameraYawTarget,
  shouldHandleWorldCameraKeyInput,
  updateWorldsMovementKeys,
  type WorldsMovementKeyState,
} from '../worldCameraNavigation.ts'
import type { WorldSceneItem } from '../worldRenderableResolver.ts'
import type { WorldCollisionZone } from '../worldsCollisionZones.ts'

export interface WorldsKeyboardCameraControlsProps {
  items: WorldSceneItem[]
  collisionZones: WorldCollisionZone[]
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

export function WorldsKeyboardCameraControls({ items: _items, collisionZones, speed, inputScopeRef, orbitControlsRef }: WorldsKeyboardCameraControlsProps): null {
  const keysRef = useRef<WorldsMovementKeyState>({})
  const rotationKeysRef = useRef<WorldsRotationKeyState>({ yawLeft: false, yawRight: false })
  const collisionsRef = useRef(buildWorldSceneCollisionAabbs(collisionZones))

  useEffect(() => {
    collisionsRef.current = buildWorldSceneCollisionAabbs(collisionZones)
  }, [collisionZones])

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
      const resolved = resolveWorldCameraCollisionMovement(camera.position, scaledMovementVector, collisionsRef.current)
      scaledMovementVector.set(resolved.x, resolved.y, resolved.z)
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
