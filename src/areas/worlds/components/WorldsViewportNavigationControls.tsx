import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

import {
  applyWorldsFlyNavigation,
  applyWorldsRunNavigation,
  applyWorldsViewportModeShortcut,
  createWorldsOrbitTargetFromNavigation,
  createWorldsRunNavigationState,
  deriveWorldsNavigationPoseFromOrbit,
  getWorldsOrbitHandoffDistance,
  shouldHandleWorldCameraKeyInput,
  updateWorldsViewportNavigationKeys,
  WORLD_RUN_GROUND_FALLBACK_LABEL,
  type WorldsKeyboardInputScopeLike,
  type WorldsNavigationKeyState,
  type WorldsRunNavigationState,
  type WorldsViewportControlMode,
  type WorldsViewportNavigationPose,
} from '../worldCameraNavigation.ts'
import type { WorldsResolvedCollisionSurface } from '../worldsSurfaceMath.ts'

export type WorldsOrbitControlsHandle = {
  target: THREE.Vector3
  maxDistance: number
  update: () => void
  saveState?: () => void
}

export interface WorldsViewportNavigationControlsProps {
  mode: WorldsViewportControlMode
  collisionSurfaces: readonly WorldsResolvedCollisionSurface[]
  inputScopeRef: RefObject<HTMLElement>
  orbitControlsRef: RefObject<WorldsOrbitControlsHandle | null>
  frameSceneToken: number
  onModeChange: (mode: WorldsViewportControlMode) => void
  onPointerLockChange: (locked: boolean) => void
  onStatusChange: (status: string) => void
}

const POINTER_SENSITIVITY = 0.002
const PITCH_LIMIT = Math.PI / 2 - 0.05

type LookState = { yaw: number; pitch: number }

function createWorldsKeyboardInputScope(scope: HTMLElement | null): WorldsKeyboardInputScopeLike | null {
  const ownerWindow = scope?.ownerDocument.defaultView
  if (!scope || !ownerWindow) return null
  return {
    contains: (element: unknown) => element instanceof ownerWindow.Node && scope.contains(element),
  }
}

function shouldUseScopedKey(event: KeyboardEvent, scope: HTMLElement | null): boolean {
  return shouldHandleWorldCameraKeyInput({
    target: event.target as HTMLElement | null,
    activeElement: scope?.ownerDocument.activeElement as HTMLElement | null,
    inputScope: createWorldsKeyboardInputScope(scope),
  })
}

function poseFromOrbit(camera: THREE.Camera, controls: WorldsOrbitControlsHandle | null): WorldsViewportNavigationPose {
  const target = controls?.target ?? camera.position.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion))
  return deriveWorldsNavigationPoseFromOrbit(camera.position, target)
}

function poseFromView(camera: THREE.Camera): WorldsViewportNavigationPose {
  const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize()
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize()
  return {
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    forward: { x: forward.x, y: forward.y, z: forward.z },
    up: { x: up.x, y: up.y, z: up.z },
    roll: euler.z,
  }
}

function applyPose(camera: THREE.Camera, pose: WorldsViewportNavigationPose, look: LookState): void {
  camera.position.set(pose.position.x, pose.position.y, pose.position.z)
  const euler = new THREE.Euler(look.pitch, look.yaw, pose.roll ?? 0, 'YXZ')
  camera.quaternion.setFromEuler(euler)
}

function updateLookFromCamera(camera: THREE.Camera, lookRef: { current: LookState }): void {
  const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
  lookRef.current.yaw = euler.y
  lookRef.current.pitch = euler.x
}

export function WorldsViewportNavigationControls({
  mode,
  collisionSurfaces,
  inputScopeRef,
  orbitControlsRef,
  frameSceneToken,
  onModeChange,
  onPointerLockChange,
  onStatusChange,
}: WorldsViewportNavigationControlsProps): null {
  const { camera, gl } = useThree()
  const keysRef = useRef<WorldsNavigationKeyState>({})
  const poseRef = useRef<WorldsViewportNavigationPose | null>(null)
  const lookRef = useRef<LookState>({ yaw: 0, pitch: 0 })
  const runStateRef = useRef<WorldsRunNavigationState | null>(null)
  const modeRef = useRef(mode)
  const pointerLockedRef = useRef(false)
  const orbitDistanceRef = useRef(4)
  const frameSceneTokenRef = useRef(frameSceneToken)
  const runFallbackActiveRef = useRef(false)
  const statusRef = useRef('')
  const surfacesRef = useRef<readonly WorldsResolvedCollisionSurface[]>(collisionSurfaces)

  useEffect(() => { surfacesRef.current = collisionSurfaces }, [collisionSurfaces])

  const clearKeys = useCallback(() => {
    keysRef.current = {}
  }, [])

  const publishStatus = useCallback((status: string) => {
    if (statusRef.current === status) return
    statusRef.current = status
    onStatusChange(status)
  }, [onStatusChange])

  const releasePointerLock = useCallback(() => {
    const ownerDocument = gl.domElement.ownerDocument
    if (ownerDocument.pointerLockElement !== gl.domElement) return
    try {
      ownerDocument.exitPointerLock?.()
    } catch {
      pointerLockedRef.current = false
      onPointerLockChange(false)
    }
  }, [gl.domElement, onPointerLockChange])

  const requestPointerLock = useCallback(() => {
    if (modeRef.current === 'inspect') return
    inputScopeRef.current?.focus({ preventScroll: true })
    if (typeof gl.domElement.requestPointerLock !== 'function') {
      pointerLockedRef.current = false
      onPointerLockChange(false)
      clearKeys()
      publishStatus('Pointer lock unavailable.')
      return
    }
    try {
      const request = gl.domElement.requestPointerLock()
      void request.catch(() => {
        pointerLockedRef.current = false
        onPointerLockChange(false)
        clearKeys()
        publishStatus('Pointer lock unavailable.')
      })
    } catch {
      pointerLockedRef.current = false
      onPointerLockChange(false)
      clearKeys()
      publishStatus('Pointer lock unavailable.')
    }
  }, [clearKeys, gl.domElement, inputScopeRef, onPointerLockChange, publishStatus])

  useEffect(() => {
    const previousMode = modeRef.current
    const frameSceneRequested = frameSceneTokenRef.current !== frameSceneToken
    frameSceneTokenRef.current = frameSceneToken
    modeRef.current = mode
    clearKeys()
    if (mode !== 'run') runFallbackActiveRef.current = false
    if (mode === 'inspect') {
      releasePointerLock()
      if (previousMode !== 'inspect' && !frameSceneRequested) {
        const pose = poseFromView(camera)
        poseRef.current = pose
        const target = createWorldsOrbitTargetFromNavigation({
          position: pose.position,
          forward: pose.forward,
          distance: orbitDistanceRef.current,
        })
        orbitControlsRef.current?.target.set(target.x, target.y, target.z)
        orbitControlsRef.current?.update()
      }
      publishStatus('Inspect mode. Orbit, pan, select, and edit.')
    } else {
      if (previousMode === 'inspect') {
        const controls = orbitControlsRef.current
        if (controls) orbitDistanceRef.current = getWorldsOrbitHandoffDistance(camera.position, controls.target, orbitDistanceRef.current)
        poseRef.current = poseFromOrbit(camera, controls)
      } else {
        poseRef.current = poseFromView(camera)
      }
      updateLookFromCamera(camera, lookRef)
      if (mode === 'run') runStateRef.current = createWorldsRunNavigationState(poseRef.current.position)
      onPointerLockChange(pointerLockedRef.current)
      publishStatus(pointerLockedRef.current
        ? `${mode === 'fly' ? 'Fly' : 'Run'} mode. Pointer locked.`
        : `${mode === 'fly' ? 'Fly' : 'Run'} mode. Click viewport to capture pointer.`)
    }
  }, [camera, clearKeys, frameSceneToken, mode, onPointerLockChange, orbitControlsRef, publishStatus, releasePointerLock])

  useEffect(() => {
    const ownerDocument = gl.domElement.ownerDocument
    const handlePointerLockChange = () => {
      const locked = ownerDocument.pointerLockElement === gl.domElement
      if (locked && modeRef.current === 'inspect') {
        releasePointerLock()
        pointerLockedRef.current = false
        onPointerLockChange(false)
        publishStatus('Inspect mode. Orbit, pan, select, and edit.')
        return
      }
      pointerLockedRef.current = locked
      onPointerLockChange(locked)
      if (!locked) {
        clearKeys()
        publishStatus(modeRef.current === 'inspect'
          ? 'Inspect mode. Orbit, pan, select, and edit.'
          : `${modeRef.current === 'fly' ? 'Fly' : 'Run'} mode. Pointer released; click viewport to recapture.`)
      } else {
        publishStatus(`${modeRef.current === 'fly' ? 'Fly' : 'Run'} mode. Pointer locked.`)
      }
    }
    const handlePointerLockError = () => {
      pointerLockedRef.current = false
      onPointerLockChange(false)
      clearKeys()
      publishStatus('Pointer lock unavailable.')
    }
    ownerDocument.addEventListener('pointerlockchange', handlePointerLockChange)
    ownerDocument.addEventListener('pointerlockerror', handlePointerLockError)
    return () => {
      ownerDocument.removeEventListener('pointerlockchange', handlePointerLockChange)
      ownerDocument.removeEventListener('pointerlockerror', handlePointerLockError)
      releasePointerLock()
      pointerLockedRef.current = false
      onPointerLockChange(false)
      clearKeys()
    }
  }, [clearKeys, gl.domElement, onPointerLockChange, publishStatus, releasePointerLock])

  useEffect(() => {
    const element = gl.domElement
    const ownerDocument = element.ownerDocument
    const ownerWindow = ownerDocument.defaultView
    const releaseNavigationOwnership = () => {
      clearKeys()
      releasePointerLock()
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      requestPointerLock()
    }
    const handleMouseMove = (event: MouseEvent) => {
      if (!pointerLockedRef.current || ownerDocument.pointerLockElement !== element || modeRef.current === 'inspect') return
      lookRef.current.yaw -= event.movementX * POINTER_SENSITIVITY
      lookRef.current.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, lookRef.current.pitch - event.movementY * POINTER_SENSITIVITY))
    }
    const handleVisibility = () => { if (ownerDocument.hidden) releaseNavigationOwnership() }
    element.addEventListener('pointerdown', handlePointerDown)
    ownerDocument.addEventListener('mousemove', handleMouseMove)
    ownerDocument.addEventListener('visibilitychange', handleVisibility)
    ownerWindow?.addEventListener('blur', releaseNavigationOwnership)
    return () => {
      element.removeEventListener('pointerdown', handlePointerDown)
      ownerDocument.removeEventListener('mousemove', handleMouseMove)
      ownerDocument.removeEventListener('visibilitychange', handleVisibility)
      ownerWindow?.removeEventListener('blur', releaseNavigationOwnership)
    }
  }, [clearKeys, gl.domElement, releasePointerLock, requestPointerLock])

  useEffect(() => {
    const scope = inputScopeRef.current
    if (!scope) return undefined
    const releaseNavigationOwnership = () => {
      clearKeys()
      releasePointerLock()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldUseScopedKey(event, scope)) return
      const shortcut = applyWorldsViewportModeShortcut(modeRef.current, event.code, {
        target: event.target as HTMLElement | null,
        activeElement: scope.ownerDocument.activeElement as HTMLElement | null,
        inputScope: createWorldsKeyboardInputScope(scope),
      })
      if (shortcut !== modeRef.current) {
        event.preventDefault()
        onModeChange(shortcut)
        return
      }
      if (event.code === 'Enter' && modeRef.current !== 'inspect') {
        event.preventDefault()
        requestPointerLock()
        return
      }
      if (!pointerLockedRef.current) return
      const nextKeys = updateWorldsViewportNavigationKeys(keysRef.current, modeRef.current, event.code, true)
      if (nextKeys === keysRef.current) return
      keysRef.current = nextKeys
      event.preventDefault()
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!shouldUseScopedKey(event, scope)) return
      const nextKeys = updateWorldsViewportNavigationKeys(keysRef.current, modeRef.current, event.code, false)
      if (nextKeys === keysRef.current) return
      keysRef.current = nextKeys
      if (pointerLockedRef.current) event.preventDefault()
    }
    scope.addEventListener('keydown', handleKeyDown)
    scope.addEventListener('keyup', handleKeyUp)
    scope.addEventListener('blur', releaseNavigationOwnership)
    return () => {
      scope.removeEventListener('keydown', handleKeyDown)
      scope.removeEventListener('keyup', handleKeyUp)
      scope.removeEventListener('blur', releaseNavigationOwnership)
    }
  }, [clearKeys, inputScopeRef, onModeChange, releasePointerLock, requestPointerLock])

  useFrame((_, delta) => {
    if (modeRef.current === 'inspect' || !pointerLockedRef.current || gl.domElement.ownerDocument.pointerLockElement !== gl.domElement) return
    const pose = poseRef.current ?? poseFromView(camera)
    const viewRotation = new THREE.Euler(lookRef.current.pitch, lookRef.current.yaw, pose.roll ?? 0, 'YXZ')
    const forward = new THREE.Vector3(0, 0, -1).applyEuler(viewRotation).normalize()
    const up = new THREE.Vector3(0, 1, 0).applyEuler(viewRotation).normalize()
    const nextPose = {
      ...pose,
      forward: { x: forward.x, y: forward.y, z: forward.z },
      up: { x: up.x, y: up.y, z: up.z },
    }
    const result = modeRef.current === 'fly'
      ? applyWorldsFlyNavigation({ pose: nextPose, keys: keysRef.current, deltaSeconds: delta })
      : applyWorldsRunNavigation({
        pose: nextPose,
        state: runStateRef.current ?? createWorldsRunNavigationState(nextPose.position),
        keys: keysRef.current,
        deltaSeconds: delta,
        collisionSurfaces: surfacesRef.current,
      })
    poseRef.current = result.pose
    if (result.state) runStateRef.current = result.state
    if (result.status === 'ground-only-fallback') {
      runFallbackActiveRef.current = true
      publishStatus(`Run mode. ${WORLD_RUN_GROUND_FALLBACK_LABEL}.`)
    } else if (modeRef.current === 'run' && runFallbackActiveRef.current) {
      runFallbackActiveRef.current = false
      publishStatus('Run mode. Pointer locked.')
    }
    if (result.status === 'fall-recovered') publishStatus('Run mode. Returned to the last safe ground position.')
    applyPose(camera, result.pose, lookRef.current)
  })

  return null
}
