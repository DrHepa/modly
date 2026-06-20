import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type MutableRefObject, type RefObject } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Bounds, GizmoHelper, GizmoViewport, Html, OrbitControls, useBounds, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'

import { classifyPlyGeometry, classifyPlyHeader } from '../plyClassification.ts'
import { createWorldsCameraState, shouldIgnoreWorldCameraKeyTarget } from '../worldCameraNavigation.ts'
import type { WorldSceneItem } from '../worldRenderableResolver.ts'
import { WORLD_VIEWER_CAMERA_OVERLAY, WorldsCameraOverlay } from './WorldsCameraOverlay.tsx'
import { WorldsKeyboardCameraControls, type WorldsOrbitControlsHandle } from './WorldsKeyboardCameraControls.tsx'
import { WorldsMouseLookCameraControls } from './WorldsMouseLookCameraControls.tsx'

export { WORLD_VIEWER_CAMERA_OVERLAY, WorldsCameraOverlay } from './WorldsCameraOverlay.tsx'
export { WorldsKeyboardCameraControls } from './WorldsKeyboardCameraControls.tsx'
export { WorldsMouseLookCameraControls } from './WorldsMouseLookCameraControls.tsx'

export type WorldsViewerUnsupportedItem = {
  workspacePath: string
  reason: 'unsupported-spz' | 'unsupported-gaussian-ply' | 'unsupported-extension' | 'unsafe' | 'unavailable'
}

export interface WorldsViewerProps {
  items: WorldSceneItem[]
  unsupportedItems?: WorldsViewerUnsupportedItem[]
}

export type PlyRenderModel = {
  primitive: 'mesh' | 'points'
  geometry: THREE.BufferGeometry
  hasVertexColors: boolean
  material: 'standard-vertex-color' | 'standard-neutral' | 'points-vertex-color' | 'points-neutral'
  pointSize?: number
  viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered'
}

export const WORLD_VIEWER_CAMERA_NAVIGATION = {
  orbitControls: 'always-enabled',
  keyboardMovement: 'focused-viewer-scope',
} as const

export const WORLD_VIEWER_ORBIT_CONTROLS = {
  enablePan: true,
  enableZoom: true,
  enableRotate: false,
  screenSpacePanning: true,
  minPolarAngle: 0,
  maxPolarAngle: Math.PI,
  minDistance: 0.05,
  maxDistance: 500,
  zoomSpeed: 1.25,
  panSpeed: 1.2,
  rotateSpeed: 0.75,
} as const

const WORLDS_CAMERA_HELP_TEXT = 'Left-drag look · Right-drag pan · Wheel zoom · WASD/Arrows move · Space/E up · Q/Shift down'
const WORLDS_DEFAULT_CAMERA_POSITION = new THREE.Vector3(2.4, 1.8, 2.8)
const WORLDS_DEFAULT_CAMERA_TARGET = new THREE.Vector3(0, 0, 0)
const worldsFitDirection = new THREE.Vector3()
const worldsFitPosition = new THREE.Vector3()

type WorldsCameraFitSnapshot = {
  fitKey: string
  position: THREE.Vector3
  target: THREE.Vector3
  near: number
  far: number
  maxDistance: number
}

type WorldSceneItemStatus = 'ready' | 'failed'
type WorldSceneItemSettlement = (key: string, status: WorldSceneItemStatus | null) => void

export type WorldSceneItemRenderTarget = {
  workspacePath: string
  kind: WorldSceneItem['kind']
  loader: 'ply' | 'gltf'
  primitive: 'mesh' | 'points' | 'scene'
  cameraFit: 'bounds'
  visibleDescription: 'PLY mesh geometry' | 'PLY point cloud geometry' | 'GLB/GLTF model scene'
}

export function WorldsViewer({ items, unsupportedItems = [] }: WorldsViewerProps): JSX.Element {
  const inputScopeRef = useRef<HTMLElement>(null)
  const orbitControlsRef = useRef<ComponentRef<typeof OrbitControls> | null>(null)
  const cameraFitSnapshotRef = useRef<WorldsCameraFitSnapshot | null>(null)
  const [cameraState, setCameraState] = useState(() => createWorldsCameraState())
  const [settledItems, setSettledItems] = useState(() => new Map<string, WorldSceneItemStatus>())
  const onItemSettled = useCallback<WorldSceneItemSettlement>((key, status) => {
    setSettledItems((current) => {
      if ((current.get(key) ?? null) === status) return current
      const next = new Map(current)
      if (status) next.set(key, status)
      else next.delete(key)
      return next
    })
  }, [])
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items])
  const sceneFitKey = useMemo(() => createWorldsSceneFitKey(visibleItems), [visibleItems])
  const description = describeWorldsViewerScene(items, unsupportedItems)

  return (
    <section
      ref={inputScopeRef}
      className="relative h-full w-full overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
      aria-label="Worlds 3D canvas"
      tabIndex={0}
      onPointerDown={(event) => {
        if (!shouldIgnoreWorldCameraKeyTarget(event.target as HTMLElement)) event.currentTarget.focus()
      }}
    >
      <WorldsCameraOverlay
        speed={cameraState.speed}
        onSpeedChange={(nextSpeed) => {
          setCameraState((state) => ({ ...state, speed: nextSpeed }))
        }}
        onResetCamera={() => {
          setCameraState((state) => ({ ...state, resetToken: state.resetToken + 1 }))
        }}
        helpText={WORLDS_CAMERA_HELP_TEXT}
      />
      <Canvas
        camera={{ position: [2.4, 1.8, 2.8], fov: 45, near: 0.01, far: 500 }}
        dpr={[1, 1]}
        gl={{ antialias: true, alpha: false }}
        className="h-full w-full bg-[#18181b]"
      >
        <color attach="background" args={['#18181b']} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[4, 6, 4]} intensity={1.2} />
        <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />
        <Suspense fallback={<HtmlStatus message="Loading world asset…" />}>
          <Bounds margin={1.25}>
            {visibleItems.map((item) => (
              <WorldSceneItemErrorBoundary key={JSON.stringify([item.id, item.url, item.kind])} itemKey={worldSceneItemKey(item)} onSettled={onItemSettled}>
                <WorldSceneItemObject item={item} onSettled={onItemSettled} />
              </WorldSceneItemErrorBoundary>
            ))}
            <SceneFitController
              fitKey={sceneFitKey}
              ready={visibleItems.every((item) => settledItems.has(worldSceneItemKey(item))) && (visibleItems.length === 0 || visibleItems.some((item) => settledItems.get(worldSceneItemKey(item)) === 'ready'))}
              resetToken={cameraState.resetToken}
              orbitControlsRef={orbitControlsRef}
              cameraFitSnapshotRef={cameraFitSnapshotRef}
            />
          </Bounds>
        </Suspense>
        <OrbitControls
          ref={orbitControlsRef}
          makeDefault
          enableDamping
          dampingFactor={0.08}
          enablePan={WORLD_VIEWER_ORBIT_CONTROLS.enablePan}
          enableZoom={WORLD_VIEWER_ORBIT_CONTROLS.enableZoom}
          enableRotate={WORLD_VIEWER_ORBIT_CONTROLS.enableRotate}
          screenSpacePanning={WORLD_VIEWER_ORBIT_CONTROLS.screenSpacePanning}
          minPolarAngle={WORLD_VIEWER_ORBIT_CONTROLS.minPolarAngle}
          maxPolarAngle={WORLD_VIEWER_ORBIT_CONTROLS.maxPolarAngle}
          minDistance={WORLD_VIEWER_ORBIT_CONTROLS.minDistance}
          maxDistance={WORLD_VIEWER_ORBIT_CONTROLS.maxDistance}
          zoomSpeed={WORLD_VIEWER_ORBIT_CONTROLS.zoomSpeed}
          panSpeed={WORLD_VIEWER_ORBIT_CONTROLS.panSpeed}
          rotateSpeed={WORLD_VIEWER_ORBIT_CONTROLS.rotateSpeed}
        />
        <WorldsKeyboardCameraControls
          speed={cameraState.speed}
          inputScopeRef={inputScopeRef}
          orbitControlsRef={orbitControlsRef}
        />
        <WorldsMouseLookCameraControls inputScopeRef={inputScopeRef} orbitControlsRef={orbitControlsRef} />
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport axisColors={['#ef4444', '#22c55e', '#3b82f6']} labelColor="#f4f4f5" />
        </GizmoHelper>
      </Canvas>

      {description.unsupported.length > 0 ? (
        <div role="status" className="absolute right-3 top-3 rounded-full border border-zinc-700/70 bg-zinc-950/70 px-3 py-1 text-xs text-zinc-300 shadow-xl backdrop-blur">
          Unsupported world asset: {description.unsupported[0].reason}
        </div>
      ) : null}
    </section>
  )
}

export function describeWorldsViewerScene(items: WorldSceneItem[], unsupportedItems: WorldsViewerUnsupportedItem[] = []) {
  const visibleItems = items.filter((item) => item.visible)
  return {
    hasRenderableItems: visibleItems.length > 0,
    hasGrid: true,
    hasOrbitControls: true,
    hasUnifiedKeyboardMovement: true,
    hasGizmo: true,
    unsupported: unsupportedItems,
    renderTargets: visibleItems.map(getWorldSceneItemRenderTarget),
  }
}

export function createWorldsSceneFitKey(items: WorldSceneItem[]): string {
  return JSON.stringify(items.filter((item) => item.visible).map(worldSceneItemKey))
}

function worldSceneItemKey(item: WorldSceneItem): string {
  return JSON.stringify([item.id, item.workspacePath, item.url, item.kind])
}

export function getWorldSceneItemRenderTarget(item: WorldSceneItem): WorldSceneItemRenderTarget {
  if (item.kind === 'ply-points') {
    return {
      workspacePath: item.workspacePath,
      kind: item.kind,
      loader: 'ply',
      primitive: 'points',
      cameraFit: 'bounds',
      visibleDescription: 'PLY point cloud geometry',
    }
  }

  if (item.kind === 'ply-mesh') {
    return {
      workspacePath: item.workspacePath,
      kind: item.kind,
      loader: 'ply',
      primitive: 'mesh',
      cameraFit: 'bounds',
      visibleDescription: 'PLY mesh geometry',
    }
  }

  return {
    workspacePath: item.workspacePath,
    kind: item.kind,
    loader: 'gltf',
    primitive: 'scene',
    cameraFit: 'bounds',
    visibleDescription: 'GLB/GLTF model scene',
  }
}

export function createPlyRenderModel(source: ArrayBuffer, _item: Pick<WorldSceneItem, 'kind'>): PlyRenderModel {
  // Only the actual fetched bytes establish topology, never earlier list metadata.
  const header = classifyPlyHeader(new TextDecoder().decode(new Uint8Array(source, 0, Math.min(source.byteLength, 65536))))
  if (header.kind === 'invalid') throw new Error('Invalid or unsupported PLY header.')
  if (header.kind === 'gaussian') throw new Error('PLY Gaussian data is unsupported in Worlds.')
  const geometry = new PLYLoader().parse(source)
  try {
    const classification = classifyPlyGeometry(geometry, header)
    if (classification.kind === 'unknown') throw new Error('Unsupported PLY topology.')
    const shouldRenderPoints = classification.kind === 'points'

    normalizeHyWorldPlyGeometryForViewer(geometry)
    geometry.computeBoundingSphere()
    if (!shouldRenderPoints && !geometry.getAttribute('normal')) {
      geometry.computeVertexNormals()
    }

    if (shouldRenderPoints) {
      return {
        primitive: 'points',
        geometry,
        hasVertexColors: classification.hasVertexColors,
        material: classification.hasVertexColors ? 'points-vertex-color' : 'points-neutral',
        pointSize: 0.025,
        viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered',
      }
    }

    return {
      primitive: 'mesh',
      geometry,
      hasVertexColors: classification.hasVertexColors,
      material: classification.hasVertexColors ? 'standard-vertex-color' : 'standard-neutral',
      viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered',
    }
  } catch (error) {
    geometry.dispose()
    throw error
  }
}

export function normalizeHyWorldPlyGeometryForViewer(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.rotateX(-Math.PI / 2)
  geometry.computeBoundingBox()

  const box = geometry.boundingBox
  if (!box) return geometry

  const center = new THREE.Vector3()
  box.getCenter(center)

  geometry.translate(-center.x, -box.min.y, -center.z)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

type WorldSceneObjectProps = { item: WorldSceneItem; onSettled: WorldSceneItemSettlement }

function WorldSceneItemObject({ item, onSettled }: WorldSceneObjectProps): JSX.Element | null {
  if (item.kind === 'ply-mesh' || item.kind === 'ply-points') {
    return <PlySceneObject item={item} onSettled={onSettled} />
  }
  return <GltfSceneObject item={item} onSettled={onSettled} />
}

function PlySceneObject({ item, onSettled }: WorldSceneObjectProps): JSX.Element | null {
  const [model, setModel] = useState<PlyRenderModel | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let ownedModel: PlyRenderModel | null = null
    setModel(null)
    setError(null)

    fetch(item.url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load PLY: ${response.status}`)
        return response.arrayBuffer()
      })
      .then((buffer) => {
        if (!controller.signal.aborted) {
          ownedModel = createPlyRenderModel(buffer, { kind: item.kind })
          setModel(ownedModel)
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load PLY')
      })

    return () => {
      controller.abort()
      ownedModel?.geometry.dispose()
    }
  }, [item.url, item.kind])

  const key = worldSceneItemKey(item)
  useEffect(() => {
    if (!model) return
    // Notify only after the primitive and its real geometry have committed.
    onSettled(key, 'ready')
    return () => onSettled(key, null)
  }, [model, key, onSettled])

  if (error) return <WorldSceneItemFailure itemKey={key} onSettled={onSettled} message={error} />
  if (!model) return <HtmlStatus message="Loading PLY…" />

  if (model.primitive === 'points') {
    return (
      <points geometry={model.geometry} position={item.transform.position} rotation={item.transform.rotation} scale={item.transform.scale}>
        <pointsMaterial size={model.pointSize} sizeAttenuation vertexColors={model.hasVertexColors} color={model.hasVertexColors ? undefined : '#a1a1aa'} />
      </points>
    )
  }

  return (
    <mesh geometry={model.geometry} position={item.transform.position} rotation={item.transform.rotation} scale={item.transform.scale}>
      <meshStandardMaterial vertexColors={model.hasVertexColors} color={model.hasVertexColors ? undefined : '#d4d4d8'} roughness={0.8} metalness={0.05} />
    </mesh>
  )
}

function GltfSceneObject({ item, onSettled }: WorldSceneObjectProps): JSX.Element {
  const gltf = useGLTF(item.url)
  // Cached resources remain shared, but each mounted item owns its object/bone hierarchy.
  const scene = useMemo(() => cloneSkeleton(gltf.scene), [gltf.scene])
  const key = worldSceneItemKey(item)
  useEffect(() => {
    onSettled(key, 'ready')
    return () => onSettled(key, null)
  }, [scene, key, onSettled])
  return <primitive object={scene} dispose={null} position={item.transform.position} rotation={item.transform.rotation} scale={item.transform.scale} />
}

function SceneFitController({
  fitKey,
  ready,
  resetToken,
  orbitControlsRef,
  cameraFitSnapshotRef,
}: {
  fitKey: string
  ready: boolean
  resetToken: number
  orbitControlsRef: RefObject<WorldsOrbitControlsHandle | null>
  cameraFitSnapshotRef: MutableRefObject<WorldsCameraFitSnapshot | null>
}): null {
  const bounds = useBounds()
  const { camera } = useThree()

  const applySnapshot = (snapshot: WorldsCameraFitSnapshot) => {
    camera.position.copy(snapshot.position)
    camera.near = snapshot.near
    camera.far = snapshot.far
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    const controls = orbitControlsRef.current
    if (controls) {
      controls.target.copy(snapshot.target)
      controls.maxDistance = snapshot.maxDistance
      controls.update()
      controls.saveState?.()
    }
  }

  useEffect(() => {
    cameraFitSnapshotRef.current = null
  }, [cameraFitSnapshotRef, fitKey])

  useEffect(() => {
    if (!ready || cameraFitSnapshotRef.current?.fitKey === fitKey) return
    bounds.refresh()
    const { center, distance } = bounds.getSize()
    const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : WORLDS_DEFAULT_CAMERA_POSITION.length()
    worldsFitDirection.copy(WORLDS_DEFAULT_CAMERA_POSITION).sub(WORLDS_DEFAULT_CAMERA_TARGET).normalize()
    const snapshot = {
      fitKey,
      position: worldsFitPosition.copy(center).addScaledVector(worldsFitDirection, safeDistance).clone(),
      target: center.clone(),
      near: safeDistance / 100,
      far: safeDistance * 100,
      maxDistance: safeDistance * 10,
    }
    cameraFitSnapshotRef.current = snapshot
    applySnapshot(snapshot)
  }, [bounds, cameraFitSnapshotRef, fitKey, ready])

  useEffect(() => {
    if (resetToken === 0) return
    const snapshot = cameraFitSnapshotRef.current
    if (!snapshot || snapshot.fitKey !== fitKey) return
    applySnapshot(snapshot)
  }, [cameraFitSnapshotRef, fitKey, resetToken])

  return null
}

class WorldSceneItemErrorBoundary extends Component<{ children: JSX.Element; itemKey: string; onSettled: WorldSceneItemSettlement }, { message: string | null }> {
  state = { message: null }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : 'Unable to load world asset' }
  }

  render(): JSX.Element {
    if (this.state.message) return <WorldSceneItemFailure itemKey={this.props.itemKey} onSettled={this.props.onSettled} message={this.state.message} />
    return this.props.children
  }
}

function WorldSceneItemFailure({ itemKey, onSettled, message }: { itemKey: string; onSettled: WorldSceneItemSettlement; message: string }): JSX.Element {
  useEffect(() => {
    onSettled(itemKey, 'failed')
    return () => onSettled(itemKey, null)
  }, [itemKey, onSettled])
  return <HtmlStatus message={message} />
}

function HtmlStatus({ message }: { message: string }): JSX.Element {
  return (
    <Html center>
      <div role="status" className="rounded-full border border-zinc-700/70 bg-zinc-950/80 px-3 py-1 text-xs text-zinc-300 shadow-xl backdrop-blur">
        {message}
      </div>
    </Html>
  )
}

export default WorldsViewer
