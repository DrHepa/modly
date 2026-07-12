import { useEffect, useRef, type RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'

import { WORLD_CAMERA_LOOK_PITCH_LIMIT } from '../worldCameraNavigation.ts'
import type { WorldsOrbitControlsHandle } from './WorldsKeyboardCameraControls.tsx'

export interface WorldsMouseLookCameraControlsProps {
  inputScopeRef: RefObject<HTMLElement>
  orbitControlsRef: RefObject<WorldsOrbitControlsHandle | null>
  enabled?: boolean
}

const LOOK_SENSITIVITY = 0.003
const LOOK_DRAG_START_THRESHOLD_PX = 3
const lookDirection = new THREE.Vector3()
const lookTarget = new THREE.Vector3()
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ')

type PendingLookPointer = {
  pointerId: number
  startX: number
  startY: number
}

export function WorldsMouseLookCameraControls({ inputScopeRef, orbitControlsRef, enabled = true }: WorldsMouseLookCameraControlsProps): null {
  const { camera, gl } = useThree()
  const draggingRef = useRef(false)
  const pendingPointerRef = useRef<PendingLookPointer | null>(null)

  useEffect(() => {
    const canvas = gl.domElement

    const syncOrbitTargetToLookDirection = () => {
        const controls = orbitControlsRef.current
        if (!controls) return
        camera.getWorldDirection(lookDirection)
        const distance = Math.max(camera.position.distanceTo(controls.target), 0.1)
        controls.target.copy(lookTarget.copy(camera.position).addScaledVector(lookDirection, distance))
        controls.update()
      }

    const handlePointerDown = (event: PointerEvent) => {
      if (!enabled) return
      if (event.button !== 0) return
      if (!inputScopeRef.current?.contains(canvas)) return
      pendingPointerRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!enabled) return
      const pendingPointer = pendingPointerRef.current
      if (!draggingRef.current) {
        if (!pendingPointer || pendingPointer.pointerId !== event.pointerId) return
        const dragDistance = Math.hypot(event.clientX - pendingPointer.startX, event.clientY - pendingPointer.startY)
        if (dragDistance < LOOK_DRAG_START_THRESHOLD_PX) return
        draggingRef.current = true
        canvas.setPointerCapture?.(event.pointerId)
      }
      lookEuler.setFromQuaternion(camera.quaternion)
      lookEuler.y -= event.movementX * LOOK_SENSITIVITY
      lookEuler.x = THREE.MathUtils.clamp(lookEuler.x - event.movementY * LOOK_SENSITIVITY, -WORLD_CAMERA_LOOK_PITCH_LIMIT, WORLD_CAMERA_LOOK_PITCH_LIMIT)
      camera.quaternion.setFromEuler(lookEuler)
      syncOrbitTargetToLookDirection()
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }

    const stopDragging = (event: PointerEvent) => {
      const wasDragging = draggingRef.current
      pendingPointerRef.current = null
      draggingRef.current = false
      if (!wasDragging) return
      canvas.releasePointerCapture?.(event.pointerId)
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }

    canvas.addEventListener('pointerdown', handlePointerDown, { capture: true })
    canvas.addEventListener('pointermove', handlePointerMove, { capture: true })
    canvas.addEventListener('pointerup', stopDragging, { capture: true })
    canvas.addEventListener('pointercancel', stopDragging, { capture: true })
    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown, { capture: true })
      canvas.removeEventListener('pointermove', handlePointerMove, { capture: true })
      canvas.removeEventListener('pointerup', stopDragging, { capture: true })
      canvas.removeEventListener('pointercancel', stopDragging, { capture: true })
    }
  }, [camera, enabled, gl, inputScopeRef, orbitControlsRef])

  return null
}
