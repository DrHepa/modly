import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Bounds, GizmoHelper, GizmoViewport, Html, OrbitControls, TransformControls, useBounds, useGLTF } from '@react-three/drei'
import { EffectComposer, Outline, Select, Selection } from '@react-three/postprocessing'
import * as THREE from 'three'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { clone as cloneSkeletonScene } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import type { PoseClipSidecarV1 } from '../../../shared/types/electron.d.ts'

import { classifyPlyGeometry } from '../plyClassification.ts'
import { createWorldsCameraState } from '../worldCameraNavigation.ts'
import type { WorldSceneItem } from '../worldRenderableResolver.ts'
import {
  applyWorldsPoseClipAtTime,
  createWorldsPoseClipBoneMap,
  takeWorldsPoseClipSnapshot,
  type WorldsPoseClipBoneSnapshot,
} from '../worldsPoseClipPlayback.ts'
import { WORLD_VIEWER_CAMERA_OVERLAY, WorldsCameraOverlay } from './WorldsCameraOverlay.tsx'
import { WorldsKeyboardCameraControls, type WorldsOrbitControlsHandle } from './WorldsKeyboardCameraControls.tsx'
import { WorldsMouseLookCameraControls } from './WorldsMouseLookCameraControls.tsx'
import WorldsTransformToolbar, { type WorldsTransformMode } from './WorldsTransformToolbar.tsx'

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree as any
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree as any
THREE.Mesh.prototype.raycast = acceleratedRaycast

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
  selectedItemId?: string | null
  transformMode?: WorldsTransformMode | null
  onSelectItem?: (itemId: string | null) => void
  onTransformModeChange?: (mode: WorldsTransformMode | null) => void
  onTransformItem?: (itemId: string, transform: WorldSceneItem['transform']) => void
  onRemoveItem?: (itemId: string | null) => void
  onToggleBaseSceneItem?: (itemId: string | null) => void
  onSceneItemAnchorChange?: (itemId: string, anchor: [number, number, number] | null) => void
  onAnimationMetadata?: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void
}

type WorldsPlaybackRef = {
  playing: boolean
  timeSeconds: number
  durationSeconds: number
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

export const WORLD_VIEWER_TRANSFORM_CONTROLS = {
  modes: ['translate', 'rotate', 'scale'],
  placement: 'right-canvas-toolbar',
  disabledUntilSelection: true,
  backendBake: false,
} as const

const WORLD_SELECTION_OUTLINE_VISIBLE_COLOR = 0x8b5cf6
const WORLD_SELECTION_OUTLINE_HIDDEN_COLOR = 0x5b21b6
const WORLD_SELECTION_OUTLINE_EDGE_STRENGTH = 2.5
const WORLD_SELECTION_OUTLINE_BLUR = false
const WORLD_SELECTION_OUTLINE_MULTISAMPLING = 0
const WORLD_SELECTION_OUTLINE_RESOLUTION_SCALE = 0.5

const WORLDS_CAMERA_HELP_TEXT = 'Left-drag look · Right-drag pan · Wheel zoom · WASD/Arrows move · Space/E up · Q/Shift down'
const WORLDS_DEFAULT_CAMERA_POSITION = new THREE.Vector3(2.4, 1.8, 2.8)
const WORLDS_DEFAULT_CAMERA_TARGET = new THREE.Vector3(0, 0, 0)
const worldsFitDirection = new THREE.Vector3()
const worldsFitPosition = new THREE.Vector3()

type WorldsCameraFitSnapshot = {
  position: THREE.Vector3
  target: THREE.Vector3
  near: number
  far: number
  maxDistance: number
}

export type WorldSceneItemRenderTarget = {
  workspacePath: string
  kind: WorldSceneItem['kind']
  loader: 'ply' | 'gltf'
  primitive: 'mesh' | 'points' | 'scene'
  cameraFit: 'bounds'
  visibleDescription: 'PLY mesh geometry' | 'PLY point cloud geometry' | 'GLB/GLTF model scene'
}

export function WorldsViewer({
  items,
  unsupportedItems = [],
  selectedItemId = null,
  transformMode = null,
  onSelectItem = () => undefined,
  onTransformModeChange = () => undefined,
  onTransformItem = () => undefined,
  onRemoveItem = () => undefined,
  onToggleBaseSceneItem = () => undefined,
  onSceneItemAnchorChange = () => undefined,
  onAnimationMetadata = () => undefined,
}: WorldsViewerProps): JSX.Element {
  const inputScopeRef = useRef<HTMLElement>(null)
  const orbitControlsRef = useRef<WorldsOrbitControlsHandle | null>(null)
  const cameraFitSnapshotRef = useRef<WorldsCameraFitSnapshot | null>(null)
  const [cameraState, setCameraState] = useState(() => createWorldsCameraState())
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items])
  const sceneFitKey = useMemo(() => createWorldsSceneFitKey(visibleItems), [visibleItems])
  const description = describeWorldsViewerScene(items, unsupportedItems, selectedItemId)
  const sceneObjectsRef = useRef(new Map<string, THREE.Object3D>())
  const transformDraggingRef = useRef(false)
  const [sceneObjectVersion, setSceneObjectVersion] = useState(0)
  const playbackRef = useRef<WorldsPlaybackRef>({ playing: false, timeSeconds: 0, durationSeconds: 0 })
  const playbackScrubRef = useRef<HTMLInputElement>(null)
  const playbackTimeLabelRef = useRef<HTMLSpanElement>(null)
  const playbackDuration = useMemo(() => resolveWorldsPlaybackDuration(visibleItems), [visibleItems])
  const [playbackPlaying, setPlaybackPlaying] = useState(false)
  const [playbackControlTime, setPlaybackControlTime] = useState(0)
  const selectedObject = useMemo(() => selectedItemId ? sceneObjectsRef.current.get(selectedItemId) ?? null : null, [sceneObjectVersion, selectedItemId])
  const selectSceneItemFromCanvas = useCallback((itemId: string | null) => {
    if (transformMode) return
    if (transformDraggingRef.current) return
    onSelectItem(itemId)
  }, [onSelectItem, transformMode])
  const registerSceneObject = useCallback((itemId: string, object: THREE.Object3D | null) => {
    if (object) sceneObjectsRef.current.set(itemId, object)
    else sceneObjectsRef.current.delete(itemId)
    setSceneObjectVersion((version) => version + 1)
  }, [])

  useEffect(() => {
    playbackRef.current.durationSeconds = playbackDuration
    if (playbackRef.current.timeSeconds > playbackDuration) playbackRef.current.timeSeconds = playbackDuration
    updatePlaybackOverlayRefs(playbackRef.current.timeSeconds, playbackDuration, playbackScrubRef, playbackTimeLabelRef)
  }, [playbackDuration])

  const setPlaybackTime = useCallback((timeSeconds: number) => {
    const clamped = clampPlaybackTime(timeSeconds, playbackRef.current.durationSeconds)
    playbackRef.current.timeSeconds = clamped
    setPlaybackControlTime(clamped)
    updatePlaybackOverlayRefs(clamped, playbackRef.current.durationSeconds, playbackScrubRef, playbackTimeLabelRef)
  }, [])

  const setPlaybackIsPlaying = useCallback((playing: boolean) => {
    playbackRef.current.playing = playing && playbackRef.current.durationSeconds > 0
    setPlaybackPlaying(playbackRef.current.playing)
  }, [])

  return (
    <section
      ref={inputScopeRef}
      className="relative h-full w-full overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
      aria-label="Worlds 3D canvas"
      tabIndex={0}
      onPointerDown={(event) => event.currentTarget.focus()}
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
      <WorldsTransformToolbar
        items={visibleItems}
        selectedItemId={selectedItemId}
        mode={transformMode}
        onSelectItem={onSelectItem}
        onModeChange={onTransformModeChange}
        onRemoveItem={onRemoveItem}
        onToggleBaseSceneItem={onToggleBaseSceneItem}
      />
      <WorldsPlaybackControls
        durationSeconds={playbackDuration}
        playing={playbackPlaying}
        controlTimeSeconds={playbackControlTime}
        scrubRef={playbackScrubRef}
        timeLabelRef={playbackTimeLabelRef}
        onTogglePlaying={() => setPlaybackIsPlaying(!playbackRef.current.playing)}
        onTimeChange={setPlaybackTime}
        onReset={() => {
          setPlaybackIsPlaying(false)
          setPlaybackTime(0)
        }}
      />
      <Canvas
        camera={{ position: [2.4, 1.8, 2.8], fov: 45, near: 0.01, far: 500 }}
        dpr={[1, 1]}
        gl={{ antialias: true, alpha: false }}
        className="h-full w-full bg-[#18181b]"
        onPointerMissed={() => selectSceneItemFromCanvas(null)}
      >
        <color attach="background" args={['#18181b']} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[4, 6, 4]} intensity={1.2} />
        <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />
        <Bounds margin={1.25}>
            <Selection enabled={Boolean(selectedItemId)}>
              <EffectComposer
                multisampling={WORLD_SELECTION_OUTLINE_MULTISAMPLING}
                resolutionScale={WORLD_SELECTION_OUTLINE_RESOLUTION_SCALE}
              >
                <Outline
                  blur={WORLD_SELECTION_OUTLINE_BLUR}
                  edgeStrength={WORLD_SELECTION_OUTLINE_EDGE_STRENGTH}
                  visibleEdgeColor={WORLD_SELECTION_OUTLINE_VISIBLE_COLOR}
                  hiddenEdgeColor={WORLD_SELECTION_OUTLINE_HIDDEN_COLOR}
                  xRay={false}
                />
              </EffectComposer>
              {visibleItems.map((item) => (
                <WorldSceneItemErrorBoundary key={item.id}>
                  <Suspense fallback={null}>
                    <WorldSceneItemObject
                      item={item}
                      selected={item.id === selectedItemId}
                    playbackRef={playbackRef}
                    onSelectItem={selectSceneItemFromCanvas}
                    onRegisterObject={registerSceneObject}
                    onSceneItemAnchorChange={onSceneItemAnchorChange}
                    onAnimationMetadata={onAnimationMetadata}
                  />
                  </Suspense>
                </WorldSceneItemErrorBoundary>
              ))}
            </Selection>
            {selectedObject ? <WorldsSelectionSilhouette target={selectedObject} /> : null}
            {selectedObject && transformMode ? (
              <WorldsTransformControls
                object={selectedObject}
                mode={transformMode}
                selectedItemId={selectedItemId}
                draggingRef={transformDraggingRef}
                onTransformItem={onTransformItem}
              />
            ) : null}
            <SceneFitController
              fitKey={sceneFitKey}
              resetToken={cameraState.resetToken}
              orbitControlsRef={orbitControlsRef}
              cameraFitSnapshotRef={cameraFitSnapshotRef}
            />
        </Bounds>
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
        <WorldsMouseLookCameraControls inputScopeRef={inputScopeRef} orbitControlsRef={orbitControlsRef} enabled={!transformMode && !transformDraggingRef.current} />
        <WorldsPlaybackFrameController playbackRef={playbackRef} scrubRef={playbackScrubRef} timeLabelRef={playbackTimeLabelRef} />
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

function WorldsPlaybackControls({
  durationSeconds,
  playing,
  controlTimeSeconds,
  scrubRef,
  timeLabelRef,
  onTogglePlaying,
  onTimeChange,
  onReset,
}: {
  durationSeconds: number
  playing: boolean
  controlTimeSeconds: number
  scrubRef: RefObject<HTMLInputElement>
  timeLabelRef: RefObject<HTMLSpanElement>
  onTogglePlaying: () => void
  onTimeChange: (timeSeconds: number) => void
  onReset: () => void
}): JSX.Element | null {
  if (durationSeconds <= 0) return null

  return (
    <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-zinc-700/70 bg-zinc-950/75 px-2 py-1.5 text-xs text-zinc-200 shadow-xl backdrop-blur" aria-label="Worlds pose clip playback">
      <button type="button" className="rounded-lg px-2 py-1 font-semibold hover:bg-zinc-800" onClick={onTogglePlaying}>{playing ? 'Pause' : 'Play'}</button>
      <input
        ref={scrubRef}
        aria-label="Pose clip global time"
        className="h-1 w-36 accent-violet-400"
        type="range"
        min={0}
        max={durationSeconds}
        step={0.01}
        defaultValue={controlTimeSeconds}
        onChange={(event) => onTimeChange(Number(event.currentTarget.value))}
      />
      <span ref={timeLabelRef} className="min-w-24 tabular-nums text-zinc-300">{formatPlaybackTime(controlTimeSeconds)} / {formatPlaybackTime(durationSeconds)}</span>
      <button type="button" className="rounded-lg px-2 py-1 font-semibold hover:bg-zinc-800" onClick={onReset}>Reset</button>
    </div>
  )
}

function WorldsPlaybackFrameController({
  playbackRef,
  scrubRef,
  timeLabelRef,
}: {
  playbackRef: MutableRefObject<WorldsPlaybackRef>
  scrubRef: RefObject<HTMLInputElement>
  timeLabelRef: RefObject<HTMLSpanElement>
}): null {
  useFrame((_, delta) => {
    const playback = playbackRef.current
    if (!playback || !playback.playing || playback.durationSeconds <= 0) return
    playback.timeSeconds = (playback.timeSeconds + delta) % playback.durationSeconds
    updatePlaybackOverlayRefs(playback.timeSeconds, playback.durationSeconds, scrubRef, timeLabelRef)
  })
  return null
}

export function describeWorldsViewerScene(items: WorldSceneItem[], unsupportedItems: WorldsViewerUnsupportedItem[] = [], selectedItemId: string | null = null) {
  const visibleItems = items.filter((item) => item.visible)
  const selectedItem = selectedItemId ? visibleItems.find((item) => item.id === selectedItemId) ?? null : null
  return {
    hasRenderableItems: visibleItems.length > 0,
    hasGrid: true,
    hasOrbitControls: true,
    hasUnifiedKeyboardMovement: true,
    hasGizmo: true,
    hasSelection: Boolean(selectedItem),
    selectedItemId: selectedItem?.id ?? null,
    transformControls: selectedItem
      ? {
        modes: [...WORLD_VIEWER_TRANSFORM_CONTROLS.modes],
        attachedItemId: selectedItem.id,
      }
      : null,
    unsupported: unsupportedItems,
    renderTargets: visibleItems.map(getWorldSceneItemRenderTarget),
  }
}

export function createWorldsSceneFitKey(items: WorldSceneItem[]): string {
  const assetKey = items
    .filter((item) => item.visible)
    .map((item) => `${item.id}:${item.workspacePath}`)
    .join('|')
  return assetKey
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

export function createPlyRenderModel(source: ArrayBuffer, item: Pick<WorldSceneItem, 'kind'>): PlyRenderModel {
  const geometry = new PLYLoader().parse(source)
  const classification = classifyPlyGeometry(geometry)
  const shouldRenderPoints = item.kind === 'ply-points' || classification.kind === 'points'

  normalizeHyWorldPlyGeometryForViewer(geometry)
  geometry.computeBoundingSphere()
  if (!shouldRenderPoints && !geometry.getAttribute('normal')) {
    geometry.computeVertexNormals()
  }
  if (!shouldRenderPoints) {
    ;(geometry as any).computeBoundsTree?.()
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

type WorldsObjectClickEvent = ThreeEvent<MouseEvent> & {
  object: THREE.Object3D
  intersections: Array<{ object: THREE.Object3D }>
}

function WorldSceneItemObject({
  item,
  selected,
  playbackRef,
  onSelectItem,
  onRegisterObject,
  onSceneItemAnchorChange,
  onAnimationMetadata,
}: {
  item: WorldSceneItem
  selected: boolean
  playbackRef: MutableRefObject<WorldsPlaybackRef>
  onSelectItem: (itemId: string | null) => void
  onRegisterObject: (itemId: string, object: THREE.Object3D | null) => void
  onSceneItemAnchorChange: (itemId: string, anchor: [number, number, number] | null) => void
  onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void
}): JSX.Element | null {
  const groupRef = useRef<THREE.Group>(null)
  const boundsRef = useRef(new THREE.Box3())
  const centerRef = useRef(new THREE.Vector3())
  const lastAnchorRef = useRef<[number, number, number] | null>(null)

  useEffect(() => {
    onRegisterObject(item.id, groupRef.current)
    return () => onRegisterObject(item.id, null)
  }, [item.id, onRegisterObject])

  useEffect(() => {
    if (item.role !== 'base-scene') {
      lastAnchorRef.current = null
      onSceneItemAnchorChange(item.id, null)
    }
  }, [item.id, item.role, onSceneItemAnchorChange])

  useFrame(() => {
    if (item.role !== 'base-scene' || !groupRef.current) return
    const bounds = boundsRef.current.setFromObject(groupRef.current)
    if (bounds.isEmpty()) return
    const center = bounds.getCenter(centerRef.current)
    const anchor: [number, number, number] = [center.x, center.y, center.z]
    const previous = lastAnchorRef.current
    if (previous && previous.every((value, index) => Math.abs(value - anchor[index]) < 0.001)) return
    lastAnchorRef.current = anchor
    onSceneItemAnchorChange(item.id, anchor)
  })

  const handleClick = (event: WorldsObjectClickEvent) => {
    event.stopPropagation()
    onSelectItem(resolveWorldsSceneItemIdFromIntersections(event.intersections, item.id))
  }

  const selectionName = selected ? `${item.id} selected` : item.id

  return (
    <>
      <Select enabled={selected}>
        <group
          ref={groupRef}
          name={selectionName}
          userData={{ worldsSceneItemId: item.id }}
          position={item.transform.position}
          rotation={item.transform.rotation}
          scale={item.transform.scale}
          onClick={handleClick}
        >
          <WorldSceneItemGeometry item={item} playbackRef={playbackRef} onAnimationMetadata={onAnimationMetadata} />
        </group>
      </Select>
      <WorldsSelectionHitbox itemId={item.id} targetRef={groupRef} onSelectItem={onSelectItem} />
    </>
  )
}

export function resolveWorldsSceneItemIdFromObject(object: THREE.Object3D | null | undefined): string | null {
  let current: THREE.Object3D | null | undefined = object
  while (current) {
    if (current.userData.worldsSelectionHitbox === true) return null
    if (current.userData.worldsSelectionSilhouette === true) return null
    const itemId = current.userData.worldsSceneItemId
    if (typeof itemId === 'string' && itemId.length > 0) return itemId
    current = current.parent
  }
  return null
}

export function resolveWorldsSceneItemIdFromIntersections(intersections: Array<{ object: THREE.Object3D }>, fallbackItemId: string): string {
  for (const intersection of intersections) {
    const itemId = resolveWorldsSceneItemIdFromObject(intersection.object)
    if (itemId) return itemId
  }
  return fallbackItemId
}

export function calculateWorldsSelectionBounds(target: THREE.Object3D): { center: THREE.Vector3; size: THREE.Vector3 } | null {
  target.updateWorldMatrix(true, true)

  const bounds = new THREE.Box3()
  const childBounds = new THREE.Box3()
  let hasBounds = false

  target.traverse((object) => {
    if (object.userData.worldsSelectionHitbox === true) return
    if (object.userData.worldsSelectionSilhouette === true) return

    const geometry = (object as THREE.Mesh | THREE.Points).geometry
    if (!geometry) return
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    if (!geometry.boundingBox) return

    childBounds.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld)
    bounds.union(childBounds)
    hasBounds = true
  })

  if (!hasBounds || bounds.isEmpty()) return null

  const center = new THREE.Vector3()
  const size = new THREE.Vector3()
  bounds.getCenter(center)
  bounds.getSize(size)

  const minimumSize = 0.3
  size.set(Math.max(size.x, minimumSize), Math.max(size.y, minimumSize), Math.max(size.z, minimumSize))

  return { center, size }
}

function WorldsSelectionHitbox({
  itemId,
  targetRef,
  onSelectItem,
}: {
  itemId: string
  targetRef: RefObject<THREE.Object3D | null>
  onSelectItem: (itemId: string | null) => void
}): JSX.Element {
  const hitboxRef = useRef<THREE.Mesh>(null)

  const handlePointerDown = (event: { stopPropagation: () => void }) => {
    event.stopPropagation()
  }

  const handleClick = (event: WorldsObjectClickEvent) => {
    event.stopPropagation()
    onSelectItem(resolveWorldsSceneItemIdFromIntersections(event.intersections, itemId))
  }

  useFrame(() => {
    const hitbox = hitboxRef.current
    const target = targetRef.current
    if (!hitbox || !target) return

    const bounds = calculateWorldsSelectionBounds(target)
    if (!bounds) {
      hitbox.visible = false
      return
    }

    hitbox.visible = true
    hitbox.position.copy(bounds.center)
    hitbox.scale.copy(bounds.size)
  })

  return (
    <mesh
      ref={hitboxRef}
      name={`${itemId} selection hitbox`}
      userData={{ worldsSelectionHitbox: true }}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} color="#ffffff" />
    </mesh>
  )
}

function WorldSceneItemGeometry({ item, playbackRef, onAnimationMetadata }: { item: WorldSceneItem; playbackRef: MutableRefObject<WorldsPlaybackRef>; onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void }): JSX.Element | null {
  if (item.kind === 'ply-mesh' || item.kind === 'ply-points') {
    return <PlySceneObject item={item} />
  }
  return <GltfSceneObject item={item} playbackRef={playbackRef} onAnimationMetadata={onAnimationMetadata} />
}

function PlySceneObject({ item }: { item: WorldSceneItem }): JSX.Element | null {
  const [model, setModel] = useState<PlyRenderModel | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setModel(null)
    setError(null)

    fetch(item.url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load PLY: ${response.status}`)
        return response.arrayBuffer()
      })
      .then((buffer) => {
        if (!controller.signal.aborted) setModel(createPlyRenderModel(buffer, item))
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load PLY')
      })

    return () => {
      controller.abort()
    }
  }, [item])

  useEffect(() => {
    return () => {
      ;(model?.geometry as any)?.disposeBoundsTree?.()
      model?.geometry.dispose()
    }
  }, [model])

  if (error) return <HtmlStatus message={error} />
  if (!model) return <HtmlStatus message="Loading PLY…" />

  if (model.primitive === 'points') {
    return (
      <points geometry={model.geometry} userData={{ worldsSceneItemId: item.id }}>
        <pointsMaterial size={model.pointSize} sizeAttenuation vertexColors={model.hasVertexColors} color={model.hasVertexColors ? undefined : '#a1a1aa'} />
      </points>
    )
  }

  return (
      <mesh geometry={model.geometry} userData={{ worldsSceneItemId: item.id }}>
      <meshStandardMaterial vertexColors={model.hasVertexColors} color={model.hasVertexColors ? undefined : '#d4d4d8'} roughness={0.8} metalness={0.05} />
    </mesh>
  )
}

function GltfSceneObject({ item, playbackRef, onAnimationMetadata }: { item: WorldSceneItem; playbackRef: MutableRefObject<WorldsPlaybackRef>; onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void }): JSX.Element {
  const gltf = useGLTF(item.url)
  const scene = useMemo(() => cloneSkeletonScene(gltf.scene), [gltf.scene])
  const poseClipRef = useRef<{
    sidecar: PoseClipSidecarV1
    bonesById: Map<string, THREE.Bone>
    snapshot: WorldsPoseClipBoneSnapshot
  } | null>(null)
  useEffect(() => {
    scene.traverse((child) => {
      child.userData.worldsSceneItemId = item.id
      if (child instanceof THREE.Mesh) {
        ;(child.geometry as any).computeBoundsTree?.()
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        materials.forEach((material) => {
          material.side = THREE.DoubleSide
          material.needsUpdate = true
        })
      }
    })
    return () => {
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          ;(child.geometry as any).disposeBoundsTree?.()
        }
      })
    }
  }, [item.id, scene])
  useEffect(() => {
    const animation = item.animation
    poseClipRef.current = null
    if (!animation || animation.kind !== 'pose-clip') return
    if (item.workspacePath !== animation.sourceWorkspacePath) return

    let cancelled = false
    window.electron.workspace.artifacts.readPoseClipSidecar({
      sidecarWorkspacePath: animation.sidecarWorkspacePath,
      ...(animation.legacySidecarWorkspacePath ? { legacySidecarWorkspacePath: animation.legacySidecarWorkspacePath } : {}),
      sourceWorkspacePath: animation.sourceWorkspacePath,
    }).then((result) => {
      if (cancelled || result.success !== true || result.status !== 'found') return
      const bonesById = createWorldsPoseClipBoneMap(scene, result.sidecar)
      const snapshot = takeWorldsPoseClipSnapshot(bonesById)
      poseClipRef.current = { sidecar: result.sidecar, bonesById, snapshot }
      const nextAnimation = {
        ...animation,
        clipId: result.sidecar.clip.id,
        clipName: result.sidecar.clip.name,
        durationSeconds: result.sidecar.clip.durationSeconds,
      }
      if (animation.clipId !== nextAnimation.clipId || animation.clipName !== nextAnimation.clipName || animation.durationSeconds !== nextAnimation.durationSeconds) {
        onAnimationMetadata(item.id, nextAnimation)
      }
    }).catch(() => undefined)

    return () => {
      cancelled = true
      poseClipRef.current = null
    }
  }, [item.animation, item.id, item.workspacePath, onAnimationMetadata, scene])
  useFrame(() => {
    const poseClip = poseClipRef.current
    if (!poseClip) return
    applyWorldsPoseClipAtTime({
      sidecar: poseClip.sidecar,
      bonesById: poseClip.bonesById,
      snapshot: poseClip.snapshot,
      timeSeconds: playbackRef.current?.timeSeconds ?? 0,
    })
  })
  return <primitive object={scene} />
}

function resolveWorldsPlaybackDuration(items: WorldSceneItem[]): number {
  return items.reduce((duration, item) => Math.max(duration, item.animation?.durationSeconds ?? 0), 0)
}

function clampPlaybackTime(timeSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(timeSeconds)) return 0
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0
  return Math.min(Math.max(timeSeconds, 0), durationSeconds)
}

function updatePlaybackOverlayRefs(timeSeconds: number, durationSeconds: number, scrubRef: RefObject<HTMLInputElement>, labelRef: RefObject<HTMLSpanElement>): void {
  if (scrubRef.current) scrubRef.current.value = String(timeSeconds)
  if (labelRef.current) labelRef.current.textContent = `${formatPlaybackTime(timeSeconds)} / ${formatPlaybackTime(durationSeconds)}`
}

function formatPlaybackTime(timeSeconds: number): string {
  return `${Math.max(0, timeSeconds).toFixed(2)}s`
}

function WorldsSelectionSilhouette({ target }: { target: THREE.Object3D }): JSX.Element {
  const silhouette = useMemo(() => {
    const clone = cloneSkeletonScene(target)
    clone.userData.worldsSelectionSilhouette = true
    clone.traverse((child) => {
      child.userData.worldsSelectionSilhouette = true
      if (child instanceof THREE.Mesh) {
        child.raycast = () => undefined
        child.material = new THREE.MeshBasicMaterial({
          color: 0x8b5cf6,
          side: THREE.BackSide,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
          depthTest: true,
        })
        child.renderOrder = 2
      }
    })
    clone.scale.multiplyScalar(1.012)
    return clone
  }, [target])

  useFrame(() => {
    silhouette.position.copy(target.position)
    silhouette.quaternion.copy(target.quaternion)
    silhouette.scale.copy(target.scale).multiplyScalar(1.012)
    silhouette.updateMatrixWorld(true)
  })

  useEffect(() => {
    return () => {
      silhouette.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const materials = Array.isArray(child.material) ? child.material : [child.material]
          materials.forEach((material) => material.dispose())
        }
      })
    }
  }, [silhouette])

  return <primitive object={silhouette} />
}

function WorldsTransformControls({
  object,
  mode,
  selectedItemId,
  draggingRef,
  onTransformItem,
}: {
  object: THREE.Object3D
  mode: WorldsTransformMode
  selectedItemId: string | null
  draggingRef: RefObject<boolean>
  onTransformItem: (itemId: string, transform: WorldSceneItem['transform']) => void
}): JSX.Element | null {
  if (!selectedItemId) return null

  const syncTransform = () => {
    onTransformItem(selectedItemId, {
      position: object.position.toArray() as [number, number, number],
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
      scale: object.scale.toArray() as [number, number, number],
    })
  }

  return (
    <TransformControls
      object={object}
      mode={mode}
      onMouseDown={() => { draggingRef.current = true }}
      onMouseUp={() => { draggingRef.current = false; syncTransform() }}
      onObjectChange={syncTransform}
    />
  )
}

function SceneFitController({
  fitKey,
  resetToken,
  orbitControlsRef,
  cameraFitSnapshotRef,
}: {
  fitKey: string
  resetToken: number
  orbitControlsRef: RefObject<WorldsOrbitControlsHandle | null>
  cameraFitSnapshotRef: RefObject<WorldsCameraFitSnapshot | null>
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
    const shouldApplyInitialFit = cameraFitSnapshotRef.current === null
    bounds.refresh()
    const { center, distance } = bounds.getSize()
    const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : WORLDS_DEFAULT_CAMERA_POSITION.length()
    worldsFitDirection.copy(WORLDS_DEFAULT_CAMERA_POSITION).sub(WORLDS_DEFAULT_CAMERA_TARGET).normalize()
    const snapshot = {
      position: worldsFitPosition.copy(center).addScaledVector(worldsFitDirection, safeDistance).clone(),
      target: center.clone(),
      near: safeDistance / 100,
      far: safeDistance * 100,
      maxDistance: safeDistance * 10,
    }
    cameraFitSnapshotRef.current = snapshot
    if (shouldApplyInitialFit) applySnapshot(snapshot)
  }, [bounds, cameraFitSnapshotRef, fitKey])

  useEffect(() => {
    if (resetToken === 0) return
    const snapshot = cameraFitSnapshotRef.current
    if (!snapshot) return
    applySnapshot(snapshot)
  }, [cameraFitSnapshotRef, resetToken])

  return null
}

class WorldSceneItemErrorBoundary extends Component<{ children: JSX.Element }, { message: string | null }> {
  state = { message: null }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : 'Unable to load world asset' }
  }

  render(): JSX.Element {
    if (this.state.message) return <HtmlStatus message={this.state.message} />
    return this.props.children
  }
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
