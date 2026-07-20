import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Bounds, Environment, GizmoHelper, GizmoViewport, Html, Lightformer, OrbitControls, TransformControls, useBounds, useGLTF } from '@react-three/drei'
import { EffectComposer, Outline, Select, Selection } from '@react-three/postprocessing'
import * as THREE from 'three'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { clone as cloneSkeletonScene } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import type { PoseClipSidecarV1 } from '../../../shared/types/electron.d.ts'
import type { SceneArtifactManifestInitialView } from '../../../shared/types/artifacts.ts'

import { classifyPlyGeometry } from '../plyClassification.ts'
import { isWorldsGaussianPlyEnabled, type WorldSceneItem } from '../worldRenderableResolver.ts'
import { createWorldSceneSelectionTransformUpdates, type WorldSceneItemTransformUpdate, type WorldSceneTransformSnapshot } from '../worldsScenePlacement.ts'
import {
  applyWorldsPoseClipAtTime,
  createWorldsPoseClipBoneMap,
  takeWorldsPoseClipSnapshot,
  type WorldsPoseClipBoneSnapshot,
} from '../worldsPoseClipPlayback.ts'
import type { WorldsCollisionBounds } from '../worldsCollisionMath.ts'
import { calculateWorldsObjectLocalBounds } from '../worldsObjectBounds.ts'
import {
  normalizeWorldSceneCollisionSurfaces,
  WORLD_CAMERA_COLLISION_HALF_EXTENTS,
  createWorldsCameraState,
} from '../worldCameraNavigation.ts'
import type { WorldsResolvedCollisionSurface } from '../worldsSurfaceMath.ts'
import { resolveWorldSurfaceProbeTranslation } from '../worldsSurfaceNavigation.ts'
import { resolveWorldsSurfacePlacement } from '../worldsSurfacePlacement.ts'
import {
  resolveWorldsBaseSceneSupportPlacement,
  resolveWorldsPendingSurfacePlacementDecision,
  WORLDS_DRAG_BASE_SUPPORT_MAX_CORRECTION,
} from '../worldsBaseSceneSupport.ts'
import { WORLD_VIEWER_CAMERA_OVERLAY, WorldsCameraOverlay } from './WorldsCameraOverlay.tsx'
import { WorldsKeyboardCameraControls, type WorldsOrbitControlsHandle } from './WorldsKeyboardCameraControls.tsx'
import { WorldsMouseLookCameraControls } from './WorldsMouseLookCameraControls.tsx'
import WorldsTransformToolbar, { type WorldsTransformMode } from './WorldsTransformToolbar.tsx'
import WorldCollisionSurfaceLayer from './WorldCollisionSurfaceLayer.tsx'
import type { WorldCollisionSurface, WorldCollisionSurfacePreset } from '../worldsCollisionSurfaces.ts'

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree as any
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree as any
THREE.Mesh.prototype.raycast = acceleratedRaycast

export { WORLD_VIEWER_CAMERA_OVERLAY, WorldsCameraOverlay } from './WorldsCameraOverlay.tsx'
export { WorldsKeyboardCameraControls } from './WorldsKeyboardCameraControls.tsx'
export { WorldsMouseLookCameraControls } from './WorldsMouseLookCameraControls.tsx'

const LazyWorldsGaussianPlyObject = lazy(async () => {
  const module = await import('./WorldsGaussianPlyObject.tsx')
  return { default: module.WorldsGaussianPlyObject }
})

export type WorldsViewerUnsupportedItem = {
  workspacePath: string
  reason: 'unsupported-spz' | 'unsupported-gaussian-ply' | 'unsupported-extension' | 'unsafe' | 'unavailable'
}

export interface WorldsViewerProps {
  items: WorldSceneItem[]
  initialView?: SceneArtifactManifestInitialView
  collisionSurfaces?: WorldCollisionSurface[]
  unsupportedItems?: WorldsViewerUnsupportedItem[]
  selectedItemId?: string | null
  selectedItemIds?: string[]
  pendingSurfacePlacementItemId?: string | null
  collisionEditMode?: boolean
  selectedCollisionSurfaceId?: string | null
  transformMode?: WorldsTransformMode | null
  onSelectItem?: (itemId: string | null, options?: { toggle?: boolean }) => void
  onAddCollisionSurface?: (preset?: WorldCollisionSurfacePreset) => void
  onCollisionEditModeChange?: (enabled: boolean) => void
  onSelectCollisionSurface?: (surfaceId: string | null) => void
  onTransformModeChange?: (mode: WorldsTransformMode | null) => void
  onTransformItem?: (itemId: string, transform: WorldSceneItem['transform']) => void
  onTransformItems?: (updates: WorldSceneItemTransformUpdate[]) => void
  onTransformCollisionSurface?: (surfaceId: string, transform: WorldCollisionSurface['transform']) => void
  onRemoveCollisionSurface?: (surfaceId: string | null) => void
  onRemoveItem?: (itemId: string | null) => void
  onToggleBaseSceneItem?: (itemId: string | null) => void
  onSceneItemAnchorChange?: (itemId: string, anchor: [number, number, number] | null) => void
  onCommitPendingSurfacePlacement?: (itemId: string, transform: WorldSceneItem['transform']) => void
  onClearPendingSurfacePlacement?: () => void
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
const WORLD_SELECTION_ACTIVE_SILHOUETTE_COLOR = 0x8b5cf6
const WORLD_SELECTION_ACTIVE_SILHOUETTE_OPACITY = 0.8
const WORLD_SELECTION_ACTIVE_SILHOUETTE_SCALE = 1.012
const WORLD_SELECTION_SECONDARY_SILHOUETTE_COLOR = 0x38bdf8
const WORLD_SELECTION_SECONDARY_SILHOUETTE_OPACITY = 0.52
const WORLD_SELECTION_SECONDARY_SILHOUETTE_SCALE = 1.008

const WORLDS_CAMERA_HELP_TEXT = 'Left-drag look · Right-drag pan · Wheel zoom · WASD/Arrows move · Space up · Shift down · Q/E yaw'
const WORLDS_DEFAULT_CAMERA_POSITION = new THREE.Vector3(2.4, 1.8, 2.8)
const WORLDS_DEFAULT_CAMERA_TARGET = new THREE.Vector3(0, 0, 0)
const WORLDS_DEFAULT_CAMERA_UP = new THREE.Vector3(0, 1, 0)
const WORLDS_MIN_CAMERA_NEAR = 0.01
const WORLDS_TRANSFORM_SELECTION_SUPPRESSION_MS = 180
const worldsFitDirection = new THREE.Vector3()
const worldsFitPosition = new THREE.Vector3()
const worldsFocusSize = new THREE.Vector3()
const worldsResolvedCameraPosition = new THREE.Vector3()

export type WorldsCameraFitSnapshot = {
  position: THREE.Vector3
  target: THREE.Vector3
  up: THREE.Vector3
  near: number
  far: number
  maxDistance: number
}

export type WorldsCameraBounds = {
  center: THREE.Vector3
  size: THREE.Vector3
  distance: number
}

export function isWorldsBatchTransformSnapshot(snapshot: WorldSceneTransformSnapshot[] | null): snapshot is WorldSceneTransformSnapshot[] {
  return !!snapshot && snapshot.length > 1
}

export function shouldResetWorldsTransformSnapshot(isDragging: boolean): boolean {
  return !isDragging
}

export type WorldSceneItemRenderTarget = {
  workspacePath: string
  kind: WorldSceneItem['kind']
  loader: 'ply' | 'gltf' | 'gaussian-ply'
  primitive: 'mesh' | 'points' | 'scene' | 'gaussian-splats'
  cameraFit: 'bounds'
  visibleDescription: 'PLY mesh geometry' | 'PLY point cloud geometry' | 'Gaussian PLY splats' | 'GLB/GLTF model scene'
}

type WorldsMeasuredBounds = {
  center: THREE.Vector3
  size: THREE.Vector3
}

type WorldsDeferredTaskHandle = {
  cancel: () => void
}

type WorldsDeferredTaskScheduler = (callback: () => void) => WorldsDeferredTaskHandle

type WorldsSceneFitAction = 'noop' | 'apply-bounds-fit' | 'apply-initial-view' | 'refresh-limits'

type WorldsGltfSceneInstance = {
  scene: THREE.Object3D
  dispose: () => void
}

const worldsManagedBoundsTreeRefCounts = new WeakMap<THREE.BufferGeometry, number>()

function isWorldsMeshObject(object: THREE.Object3D): object is THREE.Mesh {
  return (object as THREE.Object3D & { isMesh?: boolean }).isMesh === true
}

export function WorldsViewer({
  items,
  initialView,
  collisionSurfaces = [],
  unsupportedItems = [],
  selectedItemId = null,
  selectedItemIds = [],
  pendingSurfacePlacementItemId = null,
  collisionEditMode = false,
  selectedCollisionSurfaceId = null,
  transformMode = null,
  onSelectItem = () => undefined,
  onAddCollisionSurface = () => undefined,
  onCollisionEditModeChange = () => undefined,
  onSelectCollisionSurface = () => undefined,
  onTransformModeChange = () => undefined,
  onTransformItem = () => undefined,
  onTransformItems = () => undefined,
  onTransformCollisionSurface = () => undefined,
  onRemoveCollisionSurface = () => undefined,
  onRemoveItem = () => undefined,
  onToggleBaseSceneItem = () => undefined,
  onSceneItemAnchorChange = () => undefined,
  onCommitPendingSurfacePlacement = () => undefined,
  onClearPendingSurfacePlacement = () => undefined,
  onAnimationMetadata = () => undefined,
}: WorldsViewerProps): JSX.Element {
  const normalizedSelectedItemIds = useMemo(
    () => Array.isArray(selectedItemIds) ? selectedItemIds.filter((itemId): itemId is string => typeof itemId === 'string' && itemId.length > 0) : [],
    [selectedItemIds],
  )
  const normalizedCollisionSurfaces = useMemo(
    () => Array.isArray(collisionSurfaces) ? collisionSurfaces : [],
    [collisionSurfaces],
  )
  const resolvedCollisionSurfaces = useMemo(
    () => normalizeWorldSceneCollisionSurfaces(normalizedCollisionSurfaces),
    [normalizedCollisionSurfaces],
  )
  const inputScopeRef = useRef<HTMLElement>(null)
  const orbitControlsRef = useRef<WorldsOrbitControlsHandle | null>(null)
  const cameraFitSnapshotRef = useRef<WorldsCameraFitSnapshot | null>(null)
  const [cameraState, setCameraState] = useState(() => createWorldsCameraState())
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items])
  const sceneFitKey = useMemo(() => createWorldsSceneFitKey(visibleItems), [visibleItems])
  const description = describeWorldsViewerScene(items, unsupportedItems, selectedItemId, normalizedSelectedItemIds)
  const sceneObjectsRef = useRef(new Map<string, THREE.Object3D>())
  const sceneItemLocalBoundsRef = useRef(new Map<string, WorldsCollisionBounds | null>())
  const transformDraggingRef = useRef(false)
  const suppressSelectionUntilRef = useRef(0)
  const [sceneObjectVersion, setSceneObjectVersion] = useState(0)
  const [sceneLoadRevision, setSceneLoadRevision] = useState(0)
  const playbackRef = useRef<WorldsPlaybackRef>({ playing: false, timeSeconds: 0, durationSeconds: 0 })
  const playbackScrubRef = useRef<HTMLInputElement>(null)
  const playbackTimeLabelRef = useRef<HTMLSpanElement>(null)
  const playbackDuration = useMemo(() => resolveWorldsPlaybackDuration(visibleItems), [visibleItems])
  const [playbackPlaying, setPlaybackPlaying] = useState(false)
  const [playbackControlTime, setPlaybackControlTime] = useState(0)
  const [focusRequest, setFocusRequest] = useState<{ itemId: string; token: number } | null>(null)
  const [selectedBoundsVersion, setSelectedBoundsVersion] = useState(0)
  const selectedObject = useMemo(() => selectedItemId ? sceneObjectsRef.current.get(selectedItemId) ?? null : null, [sceneObjectVersion, selectedItemId])
  const selectedItemIdSet = useMemo(() => new Set(normalizedSelectedItemIds), [normalizedSelectedItemIds])
  const selectedItems = useMemo(() => visibleItems.filter((item) => selectedItemIdSet.has(item.id)), [selectedItemIdSet, visibleItems])
  const selectedSceneObjects = useMemo(() => resolveWorldsSelectedSceneObjects(sceneObjectsRef.current, normalizedSelectedItemIds, selectedItemId), [sceneObjectVersion, normalizedSelectedItemIds, selectedItemId])
  const selectSceneItemFromCanvas = useCallback((itemId: string | null, options?: { toggle?: boolean }) => {
    if (transformDraggingRef.current) return
    if (Date.now() < suppressSelectionUntilRef.current) return
    onSelectItem(itemId, options)
  }, [onSelectItem])
  const selectCollisionSurfaceFromCanvas = useCallback((surfaceId: string | null) => {
    if (transformDraggingRef.current) return
    if (Date.now() < suppressSelectionUntilRef.current) return
    onSelectCollisionSurface(surfaceId)
  }, [onSelectCollisionSurface])
  const handleTransformDragEnd = useCallback(() => {
    suppressSelectionUntilRef.current = Date.now() + WORLDS_TRANSFORM_SELECTION_SUPPRESSION_MS
  }, [])
  const focusSceneItemFromCanvas = useCallback((itemId: string) => {
    setFocusRequest((current) => ({ itemId, token: (current?.token ?? 0) + 1 }))
  }, [])
  const invalidateSelectedBounds = useCallback(() => {
    setSelectedBoundsVersion((version) => version + 1)
  }, [])
  const cacheSceneItemLocalBounds = useCallback((itemId: string, bounds: WorldsCollisionBounds | null) => {
    if (bounds) {
      sceneItemLocalBoundsRef.current.set(itemId, cloneCollisionBounds(bounds))
      setSceneLoadRevision((revision) => revision + 1)
    } else {
      sceneItemLocalBoundsRef.current.delete(itemId)
    }
  }, [])
  const registerSceneObject = useCallback((itemId: string, object: THREE.Object3D | null) => {
    if (object) sceneObjectsRef.current.set(itemId, object)
    else {
      sceneObjectsRef.current.delete(itemId)
      sceneItemLocalBoundsRef.current.delete(itemId)
    }
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

  const handleCanvasPointerMissed = useCallback((event: { ctrlKey?: boolean } | undefined) => {
    if (!shouldWorldsPointerMissClearSelection(event)) return
    if (collisionEditMode) {
      selectCollisionSurfaceFromCanvas(null)
      return
    }
    selectSceneItemFromCanvas(null)
  }, [collisionEditMode, selectCollisionSurfaceFromCanvas, selectSceneItemFromCanvas])

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
          collisionSurfaces={normalizedCollisionSurfaces}
          selectedItemId={selectedItemId}
          selectedItemIds={normalizedSelectedItemIds}
          collisionEditMode={collisionEditMode}
          selectedCollisionSurfaceId={selectedCollisionSurfaceId}
          mode={transformMode}
          onSelectItem={onSelectItem}
          onAddCollisionSurface={onAddCollisionSurface}
          onCollisionEditModeChange={onCollisionEditModeChange}
          onSelectCollisionSurface={onSelectCollisionSurface}
          onModeChange={onTransformModeChange}
          onRemoveItem={onRemoveItem}
          onRemoveCollisionSurface={onRemoveCollisionSurface}
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
        gl={{
          antialias: true,
          alpha: false,
          outputColorSpace: THREE.SRGBColorSpace,
          toneMapping: THREE.NeutralToneMapping,
          toneMappingExposure: 1.8,
        }}
        className="h-full w-full bg-[#18181b]"
        onPointerMissed={handleCanvasPointerMissed}
      >
        <color attach="background" args={['#18181b']} />
        <ambientLight intensity={0.3} />
        <Environment background={false}>
          <Lightformer intensity={2} position={[0, 4, 4]} scale={8} />
          <Lightformer intensity={0.5} position={[-4, 2, -4]} scale={6} />
          <Lightformer intensity={0.3} position={[4, 1, -4]} scale={6} />
        </Environment>
        <directionalLight position={[5, 8, 5]} color="#ffffff" intensity={1.5} />
        <directionalLight position={[-4, 2, -4]} color="#ffffff" intensity={0.6} />
        <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />
        <Bounds margin={1.25}>
          <Selection enabled={normalizedSelectedItemIds.length > 0}>
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
                    selected={selectedItemIdSet.has(item.id)}
                    boundsVersion={item.id === selectedItemId ? selectedBoundsVersion : 0}
                    playbackRef={playbackRef}
                    onSelectItem={selectSceneItemFromCanvas}
                    onFocusItem={focusSceneItemFromCanvas}
                    onRegisterObject={registerSceneObject}
                    onLocalBoundsChange={cacheSceneItemLocalBounds}
                    onSceneItemAnchorChange={onSceneItemAnchorChange}
                    onAnimationMetadata={onAnimationMetadata}
                  />
                </Suspense>
              </WorldSceneItemErrorBoundary>
            ))}
            {collisionEditMode ? (
              <WorldCollisionSurfaceLayer
                editMode={collisionEditMode}
                surfaces={normalizedCollisionSurfaces}
                selectedSurfaceId={selectedCollisionSurfaceId}
                transformMode={transformMode}
                draggingRef={transformDraggingRef}
                onSelectSurface={selectCollisionSurfaceFromCanvas}
                onTransformDragEndSelectionBlock={handleTransformDragEnd}
                onTransformSurface={onTransformCollisionSurface}
              />
            ) : null}
          </Selection>
          {selectedSceneObjects.secondaryObjects.map((object) => (
            <WorldsSelectionSilhouette
              key={object.uuid}
              target={object}
              color={WORLD_SELECTION_SECONDARY_SILHOUETTE_COLOR}
              opacity={WORLD_SELECTION_SECONDARY_SILHOUETTE_OPACITY}
              scaleMultiplier={WORLD_SELECTION_SECONDARY_SILHOUETTE_SCALE}
              renderOrder={1}
            />
          ))}
          {selectedSceneObjects.activeObject ? (
            <WorldsSelectionSilhouette
              target={selectedSceneObjects.activeObject}
              color={WORLD_SELECTION_ACTIVE_SILHOUETTE_COLOR}
              opacity={WORLD_SELECTION_ACTIVE_SILHOUETTE_OPACITY}
              scaleMultiplier={WORLD_SELECTION_ACTIVE_SILHOUETTE_SCALE}
              renderOrder={2}
            />
          ) : null}
          {selectedObject && transformMode && !selectedCollisionSurfaceId ? (
            <WorldsTransformControls
              object={selectedObject}
              mode={transformMode}
              selectedItemId={selectedItemId}
              selectedItems={selectedItems}
              sceneItems={visibleItems}
              collisionSurfaces={resolvedCollisionSurfaces}
              draggingRef={transformDraggingRef}
              sceneObjectsRef={sceneObjectsRef}
              localBoundsRef={sceneItemLocalBoundsRef}
              onDragEndSelectionBlock={handleTransformDragEnd}
              onBoundsChange={invalidateSelectedBounds}
              onTransformItem={onTransformItem}
              onTransformItems={onTransformItems}
            />
          ) : null}
            <SceneFitController
              initialView={initialView}
              fitKey={sceneFitKey}
              loadRevision={sceneLoadRevision}
              resetToken={cameraState.resetToken}
              orbitControlsRef={orbitControlsRef}
              cameraFitSnapshotRef={cameraFitSnapshotRef}
              collisionSurfaces={resolvedCollisionSurfaces}
            />
            <SceneFocusController
              focusRequest={focusRequest}
              orbitControlsRef={orbitControlsRef}
              sceneObjectsRef={sceneObjectsRef}
              collisionSurfaces={resolvedCollisionSurfaces}
            />
            <WorldsPendingSurfacePlacementController
              pendingItemId={pendingSurfacePlacementItemId}
              sceneItems={visibleItems}
              selectedItemIds={normalizedSelectedItemIds}
              sceneObjectsRef={sceneObjectsRef}
              localBoundsRef={sceneItemLocalBoundsRef}
              sceneObjectVersion={sceneObjectVersion}
              sceneLoadRevision={sceneLoadRevision}
              onCommitPendingSurfacePlacement={onCommitPendingSurfacePlacement}
              onClearPendingSurfacePlacement={onClearPendingSurfacePlacement}
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
          collisionSurfaces={resolvedCollisionSurfaces}
          speed={cameraState.speed}
          inputScopeRef={inputScopeRef}
          orbitControlsRef={orbitControlsRef}
        />
        <WorldsMouseLookCameraControls
          inputScopeRef={inputScopeRef}
          orbitControlsRef={orbitControlsRef}
          enabled={!transformMode && !transformDraggingRef.current}
        />
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

export function describeWorldsViewerScene(
  items: WorldSceneItem[],
  unsupportedItems: WorldsViewerUnsupportedItem[] = [],
  selectedItemId: string | null = null,
  selectedItemIds: string[] = selectedItemId ? [selectedItemId] : [],
) {
  const visibleItems = items.filter((item) => item.visible)
  const selectedItem = selectedItemId ? visibleItems.find((item) => item.id === selectedItemId) ?? null : null
  const resolvedSelectedItemIds = selectedItemIds.filter((itemId, index) => selectedItemIds.indexOf(itemId) === index && visibleItems.some((item) => item.id === itemId))
  return {
    hasRenderableItems: visibleItems.length > 0,
    hasGrid: true,
    hasOrbitControls: true,
    hasUnifiedKeyboardMovement: true,
    hasGizmo: true,
    hasSelection: resolvedSelectedItemIds.length > 0,
    selectedItemId: selectedItem?.id ?? null,
    selectedItemIds: resolvedSelectedItemIds,
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

export function resolveWorldsSelectedSceneObjects(
  sceneObjects: ReadonlyMap<string, THREE.Object3D>,
  selectedItemIds: readonly string[],
  activeItemId: string | null,
): {
  activeObject: THREE.Object3D | null
  secondaryObjects: THREE.Object3D[]
} {
  const activeObject = activeItemId ? sceneObjects.get(activeItemId) ?? null : null
  const secondaryObjects: THREE.Object3D[] = []
  const seen = new Set<string>()

  for (const itemId of selectedItemIds) {
    if (!itemId || itemId === activeItemId || seen.has(itemId)) continue
    const object = sceneObjects.get(itemId)
    if (!object) continue
    secondaryObjects.push(object)
    seen.add(itemId)
  }

  return { activeObject, secondaryObjects }
}

export function createWorldsSceneFitKey(items: WorldSceneItem[]): string {
  const assetKey = items
    .filter((item) => item.visible)
    .map((item) => `${item.id}:${item.workspacePath}`)
    .join('|')
  return assetKey
}

export function getWorldSceneItemRenderTarget(item: WorldSceneItem): WorldSceneItemRenderTarget {
  if (item.kind === 'gaussian-ply') {
    return {
      workspacePath: item.workspacePath,
      kind: item.kind,
      loader: 'gaussian-ply',
      primitive: 'gaussian-splats',
      cameraFit: 'bounds',
      visibleDescription: 'Gaussian PLY splats',
    }
  }

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
  boundsVersion,
  playbackRef,
  onSelectItem,
  onFocusItem,
  onRegisterObject,
  onLocalBoundsChange,
  onSceneItemAnchorChange,
  onAnimationMetadata,
}: {
  item: WorldSceneItem
  selected: boolean
  boundsVersion: number
  playbackRef: MutableRefObject<WorldsPlaybackRef>
  onSelectItem: (itemId: string | null, options?: { toggle?: boolean }) => void
  onFocusItem: (itemId: string) => void
  onRegisterObject: (itemId: string, object: THREE.Object3D | null) => void
  onLocalBoundsChange: (itemId: string, bounds: WorldsCollisionBounds | null) => void
  onSceneItemAnchorChange: (itemId: string, anchor: [number, number, number] | null) => void
  onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void
}): JSX.Element | null {
  const groupRef = useRef<THREE.Group>(null)
  const boundsRef = useRef(new THREE.Box3())
  const childBoundsRef = useRef(new THREE.Box3())
  const centerRef = useRef(new THREE.Vector3())
  const sizeRef = useRef(new THREE.Vector3())
  const lastAnchorRef = useRef<[number, number, number] | null>(null)
  const [contentVersion, setContentVersion] = useState(0)

  const invalidateBounds = useCallback(() => {
    setContentVersion((version) => version + 1)
  }, [])

  const updateAnchor = useCallback(() => {
    const group = groupRef.current
    if (!group) return

    const bounds = measureWorldsObjectBounds(group, boundsRef.current, childBoundsRef.current, centerRef.current, sizeRef.current)
    if (!bounds) {
      if (lastAnchorRef.current) {
        lastAnchorRef.current = null
        onSceneItemAnchorChange(item.id, null)
      }
      return
    }

    const anchor: [number, number, number] = [bounds.center.x, bounds.center.y, bounds.center.z]
    const previous = lastAnchorRef.current
    if (previous && previous.every((value, index) => Math.abs(value - anchor[index]) < 0.001)) return
    lastAnchorRef.current = anchor
    onSceneItemAnchorChange(item.id, anchor)
  }, [item.id, onSceneItemAnchorChange])

  useEffect(() => {
    onRegisterObject(item.id, groupRef.current)
    invalidateBounds()
    return () => {
      onLocalBoundsChange(item.id, null)
      onRegisterObject(item.id, null)
    }
  }, [invalidateBounds, item.id, onLocalBoundsChange, onRegisterObject])

  useEffect(() => {
    return () => {
      lastAnchorRef.current = null
      onLocalBoundsChange(item.id, null)
      onSceneItemAnchorChange(item.id, null)
    }
  }, [item.id, onLocalBoundsChange, onSceneItemAnchorChange])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    onLocalBoundsChange(item.id, calculateWorldsObjectLocalBounds(group))
  }, [contentVersion, item.id, onLocalBoundsChange])

  useEffect(() => {
    updateAnchor()
  }, [
    boundsVersion,
    contentVersion,
    item.id,
    item.role,
    item.transform.position[0],
    item.transform.position[1],
    item.transform.position[2],
    item.transform.rotation[0],
    item.transform.rotation[1],
    item.transform.rotation[2],
    item.transform.scale[0],
    item.transform.scale[1],
    item.transform.scale[2],
    item.visible,
    selected,
    updateAnchor,
  ])

  const handleClick = (event: WorldsObjectClickEvent) => {
    event.stopPropagation()
    onSelectItem(resolveWorldsSceneItemIdFromIntersections(event.intersections, item.id), {
      toggle: isWorldsMultiSelectToggleGesture(event.nativeEvent),
    })
  }

  const handleDoubleClick = (event: WorldsObjectClickEvent) => {
    event.stopPropagation()
    onFocusItem(resolveWorldsSceneItemIdFromIntersections(event.intersections, item.id))
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
          onDoubleClick={handleDoubleClick}
        >
          <WorldSceneItemGeometry item={item} playbackRef={playbackRef} onAnimationMetadata={onAnimationMetadata} onBoundsChange={invalidateBounds} />
        </group>
      </Select>
      <WorldsSelectionHitbox itemId={item.id} targetRef={groupRef} boundsVersion={boundsVersion + contentVersion} onSelectItem={onSelectItem} onFocusItem={onFocusItem} />
    </>
  )
}

export function resolveWorldsSceneItemIdFromObject(object: THREE.Object3D | null | undefined): string | null {
  let current: THREE.Object3D | null | undefined = object
  while (current) {
    if (current.userData.worldsSelectionHitbox === true) return null
    if (current.userData.worldsSelectionSilhouette === true) return null
    if (current.userData.worldsCollisionSurface === true) return null
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

export function isWorldsMultiSelectToggleGesture(event: Pick<MouseEvent, 'button' | 'ctrlKey'>): boolean {
  return event.button === 0 && event.ctrlKey
}

export function shouldWorldsPointerMissClearSelection(
  event: Pick<MouseEvent, 'ctrlKey'> | { ctrlKey?: boolean; nativeEvent?: Pick<MouseEvent, 'ctrlKey'> } | null | undefined,
): boolean {
  const ctrlKey = 'nativeEvent' in (event ?? {}) ? event?.nativeEvent?.ctrlKey : event?.ctrlKey
  return ctrlKey !== true
}

export function measureWorldsObjectBounds(
  target: THREE.Object3D,
  bounds: THREE.Box3,
  childBounds: THREE.Box3,
  center: THREE.Vector3,
  size: THREE.Vector3,
): WorldsMeasuredBounds | null {
  target.updateWorldMatrix(true, true)
  bounds.makeEmpty()
  let hasBounds = false

  target.traverse((object) => {
    if (object.userData.worldsSelectionHitbox === true) return
    if (object.userData.worldsSelectionSilhouette === true) return
    if (object.userData.worldsCollisionSurface === true) return

    const customBounds = object.userData.worldsObjectBounds
    if (customBounds instanceof THREE.Box3 && !customBounds.isEmpty()) {
      childBounds.copy(customBounds).applyMatrix4(object.matrixWorld)
      bounds.union(childBounds)
      hasBounds = true
    }

    const geometry = (object as THREE.Mesh | THREE.Points).geometry
    if (!geometry) return
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    if (!geometry.boundingBox) return

    childBounds.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld)
    bounds.union(childBounds)
    hasBounds = true
  })

  if (!hasBounds || bounds.isEmpty()) return null

  bounds.getCenter(center)
  bounds.getSize(size)

  const minimumSize = 0.3
  size.set(Math.max(size.x, minimumSize), Math.max(size.y, minimumSize), Math.max(size.z, minimumSize))

  return { center, size }
}

export function calculateWorldsSelectionBounds(target: THREE.Object3D): { center: THREE.Vector3; size: THREE.Vector3 } | null {
  return measureWorldsObjectBounds(target, new THREE.Box3(), new THREE.Box3(), new THREE.Vector3(), new THREE.Vector3())
}

export interface WorldsTransformPreviewResolution {
  correctionDelta: [number, number, number]
  reason: 'free' | 'snapped' | 'blocked' | 'invalid-candidate'
  snappedPreset: null
  snappedSurfaceId: string | null
  snappedZoneId: null
  collisionSafe: boolean
  updates: WorldSceneItemTransformUpdate[]
  valid: boolean
}

export function resolveWorldsTransformPreview({
  mode,
  activeItemId,
  snapshot,
  activeTransform,
  localBoundsByItemId,
  collisionSurfaces = [],
  sceneItems = [],
  sceneObjects,
}: {
  mode: WorldsTransformMode
  activeItemId: string
  snapshot: WorldSceneTransformSnapshot[]
  activeTransform: WorldSceneItem['transform']
  localBoundsByItemId: ReadonlyMap<string, WorldsCollisionBounds | null | undefined>
  collisionSurfaces?: readonly WorldsResolvedCollisionSurface[]
  sceneItems?: readonly WorldSceneItem[]
  sceneObjects?: ReadonlyMap<string, THREE.Object3D>
}): WorldsTransformPreviewResolution {
  const baseUpdates = isWorldsBatchTransformSnapshot(snapshot)
    ? createWorldSceneSelectionTransformUpdates({
      mode,
      activeItemId,
      snapshot,
      activeTransform,
    })
    : [{ itemId: activeItemId, transform: cloneWorldSceneTransform(activeTransform) }]

  const placementItems = snapshot.map((entry) => ({
    id: entry.itemId,
    localBounds: localBoundsByItemId.get(entry.itemId),
    startTransform: cloneWorldSceneTransform(entry.transform),
  }))

  if (collisionSurfaces.length === 0) {
    const preview = {
      correctionDelta: [0, 0, 0],
      reason: 'free',
      snappedPreset: null,
      snappedSurfaceId: null,
      snappedZoneId: null,
      collisionSafe: true,
      updates: baseUpdates.map(cloneTransformUpdate),
      valid: true,
    }
    if (mode !== 'translate' || !sceneObjects || sceneItems.length === 0) return preview

    const baseSupport = resolveWorldsBaseSceneSupportPlacement({
      anchorItemId: activeItemId,
      items: placementItems,
      desiredTransforms: preview.updates.map((entry) => ({ id: entry.itemId, transform: cloneWorldSceneTransform(entry.transform) })),
      sceneItems,
      sceneObjects,
      ignoredItemIds: snapshot.map((entry) => entry.itemId),
      maxCorrection: WORLDS_DRAG_BASE_SUPPORT_MAX_CORRECTION,
    })
    if (baseSupport.status !== 'applied') return preview

    return {
      ...preview,
      correctionDelta: [...baseSupport.correctionDelta],
      reason: 'snapped',
      updates: baseSupport.updates.map(cloneTransformUpdate),
    }
  }

  const desiredTransforms = baseUpdates.map((entry) => ({
    id: entry.itemId,
    transform: cloneWorldSceneTransform(entry.transform),
  }))

  if (!placementItems.every((entry) => !!entry.localBounds)) {
    return {
      correctionDelta: [0, 0, 0],
      reason: 'free',
      snappedPreset: null,
      snappedSurfaceId: null,
      snappedZoneId: null,
      collisionSafe: false,
      updates: baseUpdates.map(cloneTransformUpdate),
      valid: true,
    }
  }

  const resolved = resolveWorldsSurfacePlacement({
    mode,
    items: placementItems,
    desiredTransforms,
    surfaces: collisionSurfaces,
  })

  const preview = {
    correctionDelta: resolved.acceptedTranslationDelta ?? [0, 0, 0],
    reason: resolved.reason,
    snappedPreset: null,
    snappedSurfaceId: resolved.snappedSurfaceId,
    snappedZoneId: null,
    collisionSafe: resolved.reason !== 'invalid-candidate',
    updates: resolved.resolvedTransforms.map((entry) => ({
      itemId: entry.id,
      transform: cloneWorldSceneTransform(entry.transform),
    })),
    valid: resolved.valid,
  }

  if (mode !== 'translate' || !preview.valid || !sceneObjects || sceneItems.length === 0) return preview

  const baseSupport = resolveWorldsBaseSceneSupportPlacement({
    anchorItemId: activeItemId,
    items: placementItems,
    desiredTransforms: preview.updates.map((entry) => ({ id: entry.itemId, transform: cloneWorldSceneTransform(entry.transform) })),
    sceneItems,
    sceneObjects,
    ignoredItemIds: snapshot.map((entry) => entry.itemId),
    maxCorrection: WORLDS_DRAG_BASE_SUPPORT_MAX_CORRECTION,
  })
  if (baseSupport.status !== 'applied') return preview

  return {
    ...preview,
    correctionDelta: [
      preview.correctionDelta[0] + baseSupport.correctionDelta[0],
      preview.correctionDelta[1] + baseSupport.correctionDelta[1],
      preview.correctionDelta[2] + baseSupport.correctionDelta[2],
    ],
    reason: preview.reason === 'blocked' ? 'blocked' : 'snapped',
    updates: baseSupport.updates.map(cloneTransformUpdate),
  }
}

function WorldsPendingSurfacePlacementController({
  pendingItemId,
  sceneItems,
  selectedItemIds,
  sceneObjectsRef,
  localBoundsRef,
  sceneObjectVersion,
  sceneLoadRevision,
  onCommitPendingSurfacePlacement,
  onClearPendingSurfacePlacement,
}: {
  pendingItemId: string | null
  sceneItems: readonly WorldSceneItem[]
  selectedItemIds: readonly string[]
  sceneObjectsRef: MutableRefObject<Map<string, THREE.Object3D>>
  localBoundsRef: MutableRefObject<Map<string, WorldsCollisionBounds | null>>
  sceneObjectVersion: number
  sceneLoadRevision: number
  onCommitPendingSurfacePlacement: (itemId: string, transform: WorldSceneItem['transform']) => void
  onClearPendingSurfacePlacement: () => void
}): null {
  const handledPendingItemIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!pendingItemId) {
      handledPendingItemIdRef.current = null
      return
    }
    if (handledPendingItemIdRef.current === pendingItemId) return

    const decision = resolveWorldsPendingSurfacePlacementDecision({
      pendingItemId,
      sceneItems,
      sceneObjects: sceneObjectsRef.current,
      localBoundsByItemId: localBoundsRef.current,
      selectedItemIds,
    })
    if (decision.status === 'wait') return

    handledPendingItemIdRef.current = pendingItemId
    if (decision.status === 'commit') {
      onCommitPendingSurfacePlacement(pendingItemId, decision.transform)
      return
    }
    onClearPendingSurfacePlacement()
  }, [
    pendingItemId,
    sceneItems,
    sceneLoadRevision,
    sceneObjectVersion,
    localBoundsRef,
    onClearPendingSurfacePlacement,
    onCommitPendingSurfacePlacement,
    sceneObjectsRef,
    selectedItemIds,
  ])

  return null
}

function WorldsSelectionHitbox({
  itemId,
  targetRef,
  boundsVersion,
  onSelectItem,
  onFocusItem,
}: {
  itemId: string
  targetRef: RefObject<THREE.Object3D | null>
  boundsVersion: number
  onSelectItem: (itemId: string | null, options?: { toggle?: boolean }) => void
  onFocusItem: (itemId: string) => void
}): JSX.Element {
  const hitboxRef = useRef<THREE.Mesh>(null)
  const boundsRef = useRef(new THREE.Box3())
  const childBoundsRef = useRef(new THREE.Box3())
  const centerRef = useRef(new THREE.Vector3())
  const sizeRef = useRef(new THREE.Vector3())

  const handlePointerDown = (event: { stopPropagation: () => void }) => {
    event.stopPropagation()
  }

  const handleClick = (event: WorldsObjectClickEvent) => {
    event.stopPropagation()
    onSelectItem(resolveWorldsSceneItemIdFromIntersections(event.intersections, itemId), {
      toggle: isWorldsMultiSelectToggleGesture(event.nativeEvent),
    })
  }

  const handleDoubleClick = (event: WorldsObjectClickEvent) => {
    event.stopPropagation()
    onFocusItem(resolveWorldsSceneItemIdFromIntersections(event.intersections, itemId))
  }

  useEffect(() => {
    const hitbox = hitboxRef.current
    const target = targetRef.current
    if (!hitbox || !target) return

    const bounds = measureWorldsObjectBounds(target, boundsRef.current, childBoundsRef.current, centerRef.current, sizeRef.current)
    if (!bounds) {
      hitbox.visible = false
      return
    }

    hitbox.visible = true
    hitbox.position.copy(bounds.center)
    hitbox.scale.copy(bounds.size)
  }, [boundsVersion, targetRef])

  return (
    <mesh
      ref={hitboxRef}
      name={`${itemId} selection hitbox`}
      userData={{ worldsSelectionHitbox: true }}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} color="#ffffff" />
    </mesh>
  )
}

function WorldSceneItemGeometry({ item, playbackRef, onAnimationMetadata, onBoundsChange }: { item: WorldSceneItem; playbackRef: MutableRefObject<WorldsPlaybackRef>; onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void; onBoundsChange: () => void }): JSX.Element | null {
  if (item.kind === 'gaussian-ply') {
    if (!isWorldsGaussianPlyEnabled()) return null
    return <LazyWorldsGaussianPlyObject itemId={item.id} url={item.url} onBoundsChange={onBoundsChange} />
  }
  if (item.kind === 'ply-mesh' || item.kind === 'ply-points') {
    return <PlySceneObject item={item} onBoundsChange={onBoundsChange} />
  }
  return <GltfSceneObject item={item} playbackRef={playbackRef} onAnimationMetadata={onAnimationMetadata} onBoundsChange={onBoundsChange} />
}

function PlySceneObject({ item, onBoundsChange }: { item: WorldSceneItem; onBoundsChange: () => void }): JSX.Element | null {
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
    if (model) onBoundsChange()
  }, [model, onBoundsChange])

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

function GltfSceneObject({ item, playbackRef, onAnimationMetadata, onBoundsChange }: { item: WorldSceneItem; playbackRef: MutableRefObject<WorldsPlaybackRef>; onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void; onBoundsChange: () => void }): JSX.Element {
  const gltf = useGLTF(item.url)
  const instance = useMemo(() => createWorldsGltfSceneInstance(gltf.scene), [gltf.scene])
  const scene = instance.scene
  const poseClipRef = useRef<{
    sidecar: PoseClipSidecarV1
    bonesById: Map<string, THREE.Bone>
    snapshot: WorldsPoseClipBoneSnapshot
  } | null>(null)
  useEffect(() => {
    scene.traverse((child) => {
      child.userData.worldsSceneItemId = item.id
    })
    onBoundsChange()
    return () => {
      instance.dispose()
    }
  }, [instance, item.id, onBoundsChange, scene])
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

function WorldsSelectionSilhouette({
  target,
  color,
  opacity,
  scaleMultiplier,
  renderOrder,
}: {
  target: THREE.Object3D
  color: number
  opacity: number
  scaleMultiplier: number
  renderOrder: number
}): JSX.Element {
  const silhouette = useMemo(() => {
    const clone = cloneSkeletonScene(target)
    clone.userData.worldsSelectionSilhouette = true
    clone.traverse((child) => {
      child.userData.worldsSelectionSilhouette = true
      if (child instanceof THREE.Mesh) {
        child.raycast = () => undefined
        child.material = new THREE.MeshBasicMaterial({
          color,
          side: THREE.BackSide,
          transparent: true,
          opacity,
          depthWrite: false,
          depthTest: true,
        })
        child.renderOrder = renderOrder
      }
      if (child instanceof THREE.Points) {
        child.raycast = () => undefined
        const sourceMaterial = child.material
        const pointSize = sourceMaterial instanceof THREE.PointsMaterial && Number.isFinite(sourceMaterial.size)
          ? Math.max(sourceMaterial.size * 1.75, 0.03)
          : 0.05
        child.material = new THREE.PointsMaterial({
          color,
          size: pointSize,
          sizeAttenuation: true,
          transparent: true,
          opacity,
          depthWrite: false,
          depthTest: true,
        })
        child.renderOrder = renderOrder
      }
    })
    clone.scale.multiplyScalar(scaleMultiplier)
    return clone
  }, [color, opacity, renderOrder, scaleMultiplier, target])

  useFrame(() => {
    silhouette.position.copy(target.position)
    silhouette.quaternion.copy(target.quaternion)
    silhouette.scale.copy(target.scale).multiplyScalar(scaleMultiplier)
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
  selectedItems,
  sceneItems,
  collisionSurfaces,
  draggingRef,
  sceneObjectsRef,
  localBoundsRef,
  onDragEndSelectionBlock,
  onBoundsChange,
  onTransformItem,
  onTransformItems,
}: {
  object: THREE.Object3D
  mode: WorldsTransformMode
  selectedItemId: string | null
  selectedItems: WorldSceneItem[]
  sceneItems: readonly WorldSceneItem[]
  collisionSurfaces: readonly WorldsResolvedCollisionSurface[]
  draggingRef: RefObject<boolean>
  sceneObjectsRef: MutableRefObject<Map<string, THREE.Object3D>>
  localBoundsRef: MutableRefObject<Map<string, WorldsCollisionBounds | null>>
  onDragEndSelectionBlock: () => void
  onBoundsChange: () => void
  onTransformItem: (itemId: string, transform: WorldSceneItem['transform']) => void
  onTransformItems: (updates: WorldSceneItemTransformUpdate[]) => void
}): JSX.Element | null {
  const dragSessionRef = useRef<{
    collisionSurfaces: readonly WorldsResolvedCollisionSurface[]
    lastValidTransforms: WorldSceneItemTransformUpdate[]
    localBoundsByItemId: Map<string, WorldsCollisionBounds | null>
    snapshot: WorldSceneTransformSnapshot[]
  } | null>(null)

  const createActiveTransform = useCallback((): WorldSceneItem['transform'] => ({
    position: object.position.toArray() as [number, number, number],
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: object.scale.toArray() as [number, number, number],
  }), [object])

  const takeSnapshot = useCallback(() => {
    const snapshot = selectedItems.map((item) => {
      const selectedObject = sceneObjectsRef.current.get(item.id)
      return {
        itemId: item.id,
        transform: selectedObject ? readWorldSceneTransformFromObject(selectedObject) : cloneWorldSceneTransform(item.transform),
      }
    })
    const localBoundsByItemId = new Map<string, WorldsCollisionBounds | null>()
    for (const entry of snapshot) {
      const cachedBounds = localBoundsRef.current.get(entry.itemId)
      if (cachedBounds) {
        localBoundsByItemId.set(entry.itemId, cloneCollisionBounds(cachedBounds))
        continue
      }

      const selectedObject = sceneObjectsRef.current.get(entry.itemId)
      const measuredBounds = selectedObject ? calculateWorldsObjectLocalBounds(selectedObject) : null
      localBoundsByItemId.set(entry.itemId, measuredBounds ? cloneCollisionBounds(measuredBounds) : null)
      if (measuredBounds) localBoundsRef.current.set(entry.itemId, cloneCollisionBounds(measuredBounds))
    }

    dragSessionRef.current = {
      collisionSurfaces: [...collisionSurfaces],
      lastValidTransforms: snapshot.map((entry) => ({ itemId: entry.itemId, transform: cloneWorldSceneTransform(entry.transform) })),
      localBoundsByItemId,
      snapshot,
    }
  }, [collisionSurfaces, localBoundsRef, sceneObjectsRef, selectedItems])

  useEffect(() => {
    if (!shouldResetWorldsTransformSnapshot(draggingRef.current)) return
    dragSessionRef.current = null
  }, [draggingRef, mode, object, selectedItemId, selectedItems])

  const restorePreviewTransforms = useCallback((updates: readonly WorldSceneItemTransformUpdate[]) => {
    applyWorldSceneTransformUpdatesToObjects(sceneObjectsRef.current, updates)
  }, [sceneObjectsRef])

  const resolvePreview = useCallback((): WorldsTransformPreviewResolution | null => {
    if (!selectedItemId) return null
    if (!dragSessionRef.current) takeSnapshot()
    const session = dragSessionRef.current
    if (!session) return null

    return resolveWorldsTransformPreview({
      mode,
      activeItemId: selectedItemId,
      snapshot: session.snapshot,
      activeTransform: createActiveTransform(),
      localBoundsByItemId: session.localBoundsByItemId,
      collisionSurfaces: session.collisionSurfaces,
      sceneItems,
      sceneObjects: sceneObjectsRef.current,
    })
  }, [createActiveTransform, mode, sceneItems, sceneObjectsRef, selectedItemId, takeSnapshot])

  const previewTransform = useCallback(() => {
    const preview = resolvePreview()
    const session = dragSessionRef.current
    if (!preview || !session) return
    if (!preview.valid) {
      restorePreviewTransforms(session.lastValidTransforms)
      return
    }

    restorePreviewTransforms(preview.updates)
    session.lastValidTransforms = preview.updates.map(cloneTransformUpdate)
  }, [resolvePreview, restorePreviewTransforms])

  const commitTransform = useCallback(() => {
    if (!selectedItemId) return
    const session = dragSessionRef.current
    if (!session) return
    const preview = resolvePreview()
    const committedUpdates = preview?.valid
      ? preview.updates
      : session.lastValidTransforms.length > 0
        ? session.lastValidTransforms
        : session.snapshot.map((entry) => ({ itemId: entry.itemId, transform: cloneWorldSceneTransform(entry.transform) }))
    restorePreviewTransforms(committedUpdates)

    if (committedUpdates.length <= 1) {
      onTransformItem(selectedItemId, cloneWorldSceneTransform(committedUpdates[0]?.transform ?? createActiveTransform()))
      return
    }

    onTransformItems(committedUpdates.map(cloneTransformUpdate))
  }, [createActiveTransform, onTransformItem, onTransformItems, resolvePreview, restorePreviewTransforms, selectedItemId])

  if (!selectedItemId) return null

  return (
    <TransformControls
      object={object}
      mode={mode}
      onMouseDown={() => {
        draggingRef.current = true
        takeSnapshot()
      }}
      onMouseUp={() => {
        draggingRef.current = false
        onDragEndSelectionBlock()
        commitTransform()
        onBoundsChange()
        dragSessionRef.current = null
      }}
      onObjectChange={() => {
        previewTransform()
      }}
    />
  )
}

export function deriveWorldsCameraLimitsFromBounds(
  bounds: WorldsCameraBounds,
  position: THREE.Vector3,
  target: THREE.Vector3,
): Pick<WorldsCameraFitSnapshot, 'near' | 'far' | 'maxDistance'> {
  const sizeLength = bounds.size.length()
  const sceneRadius = Math.max(
    Number.isFinite(sizeLength) ? sizeLength * 0.5 : 0,
    WORLD_VIEWER_ORBIT_CONTROLS.minDistance,
  )
  const fallbackDistance = Math.max(sceneRadius * 2, WORLDS_DEFAULT_CAMERA_POSITION.length())
  const sceneDistance = Number.isFinite(bounds.distance) && bounds.distance > 0
    ? bounds.distance
    : fallbackDistance
  const cameraToCenter = position.distanceTo(bounds.center)
  const safeCameraToCenter = Number.isFinite(cameraToCenter) ? cameraToCenter : sceneDistance
  const viewDistance = position.distanceTo(target)
  const safeViewDistance = Number.isFinite(viewDistance) ? viewDistance : sceneDistance
  const nearestSceneDistance = Math.max(safeCameraToCenter - sceneRadius, 0)
  const near = Math.max(
    WORLDS_MIN_CAMERA_NEAR,
    Math.min(
      sceneDistance / 100,
      nearestSceneDistance > 0 ? nearestSceneDistance / 10 : WORLDS_MIN_CAMERA_NEAR,
    ),
  )

  return {
    near,
    far: Math.max(
      near * 100,
      sceneDistance * 100,
      safeCameraToCenter + sceneRadius * 2,
      safeViewDistance * 2,
    ),
    maxDistance: Math.max(
      WORLD_VIEWER_ORBIT_CONTROLS.minDistance,
      sceneDistance * 10,
      safeViewDistance * 2,
    ),
  }
}

export function createWorldsInitialViewCameraFitSnapshot(
  initialView: SceneArtifactManifestInitialView,
  bounds: WorldsCameraBounds,
): WorldsCameraFitSnapshot {
  const position = new THREE.Vector3().fromArray(initialView.position)
  const target = new THREE.Vector3().fromArray(initialView.target)
  const up = initialView.up
    ? new THREE.Vector3().fromArray(initialView.up)
    : WORLDS_DEFAULT_CAMERA_UP.clone()

  return {
    position,
    target,
    up,
    ...deriveWorldsCameraLimitsFromBounds(bounds, position, target),
  }
}

export function createWorldsBoundsCameraFitSnapshot(
  bounds: WorldsCameraBounds,
  cameraUp: THREE.Vector3 = WORLDS_DEFAULT_CAMERA_UP,
): WorldsCameraFitSnapshot {
  const safeDistance = Number.isFinite(bounds.distance) && bounds.distance > 0
    ? bounds.distance
    : WORLDS_DEFAULT_CAMERA_POSITION.length()
  worldsFitDirection.copy(WORLDS_DEFAULT_CAMERA_POSITION).sub(WORLDS_DEFAULT_CAMERA_TARGET).normalize()
  const target = bounds.center.clone()
  const position = worldsFitPosition.copy(target).addScaledVector(worldsFitDirection, safeDistance).clone()

  return {
    position,
    target,
    up: cameraUp.clone(),
    ...deriveWorldsCameraLimitsFromBounds(bounds, position, target),
  }
}

export function hasWorldsCameraBoundsGeometry(bounds: WorldsCameraBounds): boolean {
  return Number.isFinite(bounds.distance)
    && bounds.distance > 0
    && Number.isFinite(bounds.size.x)
    && Number.isFinite(bounds.size.y)
    && Number.isFinite(bounds.size.z)
    && bounds.size.lengthSq() > 0
}

export function resolveWorldsSceneFitAction({
  fitKeyChanged,
  initialViewChanged,
  hasInitialView,
  hasMeasuredBounds,
  hasSnapshot,
  hasAppliedBoundsFitForCurrentFitKey,
  loadRevisionChanged,
}: {
  fitKeyChanged: boolean
  initialViewChanged: boolean
  hasInitialView: boolean
  hasMeasuredBounds: boolean
  hasSnapshot: boolean
  hasAppliedBoundsFitForCurrentFitKey: boolean
  loadRevisionChanged: boolean
}): WorldsSceneFitAction {
  if (hasInitialView) {
    if (!hasSnapshot || fitKeyChanged || initialViewChanged) return 'apply-initial-view'
    if (loadRevisionChanged) return 'refresh-limits'
    return 'noop'
  }

  if (!hasMeasuredBounds) return 'noop'
  if (!hasAppliedBoundsFitForCurrentFitKey) return 'apply-bounds-fit'
  return 'noop'
}

export function applyWorldsCameraFitLimits(
  camera: THREE.Camera,
  controls: WorldsOrbitControlsHandle | null,
  snapshot: WorldsCameraFitSnapshot,
): void {
  if (
    'near' in camera
    && 'far' in camera
    && typeof (camera as { updateProjectionMatrix?: unknown }).updateProjectionMatrix === 'function'
  ) {
    const clippingCamera = camera as THREE.PerspectiveCamera | THREE.OrthographicCamera
    clippingCamera.near = snapshot.near
    clippingCamera.far = snapshot.far
    clippingCamera.updateProjectionMatrix()
  }
  if (controls) controls.maxDistance = snapshot.maxDistance
}

export function applyWorldsCameraFitSnapshot(
  camera: THREE.Camera,
  controls: WorldsOrbitControlsHandle | null,
  snapshot: WorldsCameraFitSnapshot,
): WorldsCameraFitSnapshot {
  camera.position.copy(snapshot.position)
  camera.up.copy(snapshot.up)
  camera.lookAt(snapshot.target)
  applyWorldsCameraFitLimits(camera, controls, snapshot)
  camera.updateMatrixWorld()

  if (controls) {
    controls.target.copy(snapshot.target)
    controls.update()
    controls.saveState?.()
  }

  return snapshot
}

export function resolveAndApplyWorldsCameraFitSnapshot(
  camera: THREE.Camera,
  controls: WorldsOrbitControlsHandle | null,
  snapshot: WorldsCameraFitSnapshot,
  collisionSurfaces: readonly WorldsResolvedCollisionSurface[] = [],
): WorldsCameraFitSnapshot {
  const collisionSafeSnapshot = createCollisionSafeWorldsCameraFitSnapshot(snapshot, camera.position, collisionSurfaces)
  return applyWorldsCameraFitSnapshot(camera, controls, collisionSafeSnapshot)
}

export function refreshWorldsCameraFitSnapshotLimits(
  camera: THREE.Camera,
  controls: WorldsOrbitControlsHandle | null,
  snapshot: WorldsCameraFitSnapshot,
  bounds: WorldsCameraBounds,
): WorldsCameraFitSnapshot {
  const refreshedSnapshot = {
    position: snapshot.position.clone(),
    target: snapshot.target.clone(),
    up: snapshot.up.clone(),
    ...deriveWorldsCameraLimitsFromBounds(bounds, snapshot.position, snapshot.target),
  }
  applyWorldsCameraFitLimits(camera, controls, refreshedSnapshot)
  return refreshedSnapshot
}

export function scheduleWorldsDeferredTask(callback: () => void): WorldsDeferredTaskHandle {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(() => callback())
    return {
      cancel: () => window.cancelIdleCallback(handle),
    }
  }

  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(() => callback())
    return {
      cancel: () => cancelAnimationFrame(handle),
    }
  }

  let cancelled = false
  queueMicrotask(() => {
    if (!cancelled) callback()
  })

  return {
    cancel: () => {
      cancelled = true
    },
  }
}

export function cloneWorldsSceneMaterialsForInstance(target: THREE.Object3D): Set<THREE.Material> {
  const ownedMaterials = new Set<THREE.Material>()
  const clonesBySourceMaterial = new Map<THREE.Material, THREE.Material>()

  target.traverse((child) => {
    if (!isWorldsMeshObject(child)) return

    const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material]
    const clonedMaterials = sourceMaterials.map((material) => {
      const cached = clonesBySourceMaterial.get(material)
      if (cached) return cached
      const clone = material.clone()
      clone.side = THREE.DoubleSide
      clone.needsUpdate = true
      clonesBySourceMaterial.set(material, clone)
      ownedMaterials.add(clone)
      return clone
    })

    child.material = Array.isArray(child.material) ? clonedMaterials : clonedMaterials[0]!
  })

  return ownedMaterials
}

export function acquireWorldsManagedBoundsTree(geometry: THREE.BufferGeometry): boolean {
  const existingCount = worldsManagedBoundsTreeRefCounts.get(geometry)
  if (existingCount) {
    worldsManagedBoundsTreeRefCounts.set(geometry, existingCount + 1)
    return true
  }

  if ((geometry as { boundsTree?: unknown }).boundsTree) return false

  ;(geometry as any).computeBoundsTree?.()
  if (!(geometry as { boundsTree?: unknown }).boundsTree) return false
  worldsManagedBoundsTreeRefCounts.set(geometry, 1)
  return true
}

export function releaseWorldsManagedBoundsTree(geometry: THREE.BufferGeometry): boolean {
  const existingCount = worldsManagedBoundsTreeRefCounts.get(geometry)
  if (!existingCount) return false
  if (existingCount > 1) {
    worldsManagedBoundsTreeRefCounts.set(geometry, existingCount - 1)
    return false
  }

  ;(geometry as any).disposeBoundsTree?.()
  worldsManagedBoundsTreeRefCounts.delete(geometry)
  return true
}

export function scheduleWorldsSceneBoundsTreeBuild(
  target: THREE.Object3D,
  schedule: WorldsDeferredTaskScheduler = scheduleWorldsDeferredTask,
): { cancel: () => void; release: () => void } {
  const acquiredGeometries = new Set<THREE.BufferGeometry>()
  let released = false
  const scheduled = schedule(() => {
    if (released) return

    target.traverse((child) => {
      if (!isWorldsMeshObject(child)) return
      const geometry = child.geometry
      if (!geometry || acquiredGeometries.has(geometry)) return
      if (acquireWorldsManagedBoundsTree(geometry)) acquiredGeometries.add(geometry)
    })
  })

  const release = () => {
    if (released) return
    released = true
    scheduled.cancel()
    acquiredGeometries.forEach((geometry) => {
      releaseWorldsManagedBoundsTree(geometry)
    })
    acquiredGeometries.clear()
  }

  return {
    cancel: () => {
      scheduled.cancel()
      released = true
    },
    release,
  }
}

export function createWorldsGltfSceneInstance(
  sourceScene: THREE.Object3D,
  schedule: WorldsDeferredTaskScheduler = scheduleWorldsDeferredTask,
): WorldsGltfSceneInstance {
  const scene = cloneSkeletonScene(sourceScene)
  const ownedMaterials = cloneWorldsSceneMaterialsForInstance(scene)
  const boundsTreeBuild = scheduleWorldsSceneBoundsTreeBuild(scene, schedule)

  return {
    scene,
    dispose: () => {
      boundsTreeBuild.release()
      ownedMaterials.forEach((material) => material.dispose())
    },
  }
}

function SceneFitController({
  initialView,
  fitKey,
  loadRevision,
  resetToken,
  orbitControlsRef,
  cameraFitSnapshotRef,
  collisionSurfaces,
}: {
  initialView?: SceneArtifactManifestInitialView
  fitKey: string
  loadRevision: number
  resetToken: number
  orbitControlsRef: RefObject<WorldsOrbitControlsHandle | null>
  cameraFitSnapshotRef: MutableRefObject<WorldsCameraFitSnapshot | null>
  collisionSurfaces: readonly WorldsResolvedCollisionSurface[]
}): null {
  const bounds = useBounds()
  const { camera } = useThree()
  const previousInitialViewRef = useRef<SceneArtifactManifestInitialView | undefined>(undefined)
  const previousFitKeyRef = useRef<string | null>(null)
  const previousLoadRevisionRef = useRef(loadRevision)
  const boundsFitKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const fitKeyChanged = previousFitKeyRef.current !== fitKey
    const initialViewChanged = previousInitialViewRef.current !== undefined
      && previousInitialViewRef.current !== initialView
    const loadRevisionChanged = previousLoadRevisionRef.current !== loadRevision

    bounds.refresh()
    const measuredBounds = bounds.getSize()
    const action = resolveWorldsSceneFitAction({
      fitKeyChanged,
      initialViewChanged,
      hasInitialView: !!initialView,
      hasMeasuredBounds: hasWorldsCameraBoundsGeometry(measuredBounds),
      hasSnapshot: cameraFitSnapshotRef.current !== null,
      hasAppliedBoundsFitForCurrentFitKey: boundsFitKeyRef.current === fitKey,
      loadRevisionChanged,
    })

    if (action === 'apply-initial-view' && initialView) {
      const desiredSnapshot = createWorldsInitialViewCameraFitSnapshot(initialView, measuredBounds)
      cameraFitSnapshotRef.current = resolveAndApplyWorldsCameraFitSnapshot(
        camera,
        orbitControlsRef.current,
        desiredSnapshot,
        collisionSurfaces,
      )
      boundsFitKeyRef.current = null
    } else if (action === 'apply-bounds-fit') {
      const desiredSnapshot = createWorldsBoundsCameraFitSnapshot(measuredBounds, camera.up)
      cameraFitSnapshotRef.current = resolveAndApplyWorldsCameraFitSnapshot(
        camera,
        orbitControlsRef.current,
        desiredSnapshot,
        collisionSurfaces,
      )
      boundsFitKeyRef.current = fitKey
    } else if (action === 'refresh-limits') {
      const snapshot = cameraFitSnapshotRef.current
      if (snapshot) {
        cameraFitSnapshotRef.current = refreshWorldsCameraFitSnapshotLimits(
          camera,
          orbitControlsRef.current,
          snapshot,
          measuredBounds,
        )
      } else if (initialView) {
        const desiredSnapshot = createWorldsInitialViewCameraFitSnapshot(initialView, measuredBounds)
        const collisionOrigin = camera.position
        const resolvedSnapshot = createCollisionSafeWorldsCameraFitSnapshot(
          desiredSnapshot,
          collisionOrigin,
          collisionSurfaces,
        )
        cameraFitSnapshotRef.current = resolvedSnapshot
        applyWorldsCameraFitLimits(camera, orbitControlsRef.current, resolvedSnapshot)
      }
    }

    previousFitKeyRef.current = fitKey
    previousInitialViewRef.current = initialView
    previousLoadRevisionRef.current = loadRevision
  }, [bounds, camera, cameraFitSnapshotRef, collisionSurfaces, fitKey, initialView, loadRevision, orbitControlsRef])

  useEffect(() => {
    if (resetToken === 0) return
    const snapshot = cameraFitSnapshotRef.current
    if (!snapshot) return
    applyWorldsCameraFitSnapshot(camera, orbitControlsRef.current, snapshot)
  }, [camera, cameraFitSnapshotRef, orbitControlsRef, resetToken])

  return null
}

function SceneFocusController({
  focusRequest,
  orbitControlsRef,
  sceneObjectsRef,
  collisionSurfaces,
}: {
  focusRequest: { itemId: string; token: number } | null
  orbitControlsRef: RefObject<WorldsOrbitControlsHandle | null>
  sceneObjectsRef: MutableRefObject<Map<string, THREE.Object3D>>
  collisionSurfaces: readonly WorldsResolvedCollisionSurface[]
}): null {
  const { camera } = useThree()

  useEffect(() => {
    if (!focusRequest) return
    const object = sceneObjectsRef.current.get(focusRequest.itemId)
    const controls = orbitControlsRef.current
    if (!object || !controls) return
    focusWorldsCameraOnObject(camera, controls, object, collisionSurfaces)
  }, [camera, collisionSurfaces, focusRequest, orbitControlsRef, sceneObjectsRef])

  return null
}

export function focusWorldsCameraOnObject(
  camera: THREE.Camera,
  controls: WorldsOrbitControlsHandle,
  target: THREE.Object3D,
  collisionSurfaces: readonly WorldsResolvedCollisionSurface[] = [],
): boolean {
  const bounds = calculateWorldsSelectionBounds(target)
  if (!bounds) return false

  worldsFocusSize.copy(bounds.size)
  const radius = Math.max(worldsFocusSize.length() * 0.5, WORLD_VIEWER_ORBIT_CONTROLS.minDistance)
  worldsFitDirection.copy(camera.position).sub(controls.target)
  if (worldsFitDirection.lengthSq() === 0) {
    worldsFitDirection.copy(WORLDS_DEFAULT_CAMERA_POSITION).sub(WORLDS_DEFAULT_CAMERA_TARGET)
  }
  worldsFitDirection.normalize()

  let distance = radius * 1.4
  if (camera instanceof THREE.PerspectiveCamera) {
    const verticalFov = THREE.MathUtils.degToRad(camera.fov)
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect)
    const limitingHalfAngle = Math.min(verticalFov, horizontalFov) / 2
    distance = (radius / Math.sin(Math.max(limitingHalfAngle, 0.01))) * 1.4
    camera.near = Math.max(0.01, distance / 100)
    camera.far = Math.max(camera.far, distance * 100)
    camera.updateProjectionMatrix()
  }

  distance = THREE.MathUtils.clamp(distance, WORLD_VIEWER_ORBIT_CONTROLS.minDistance, WORLD_VIEWER_ORBIT_CONTROLS.maxDistance)
  const desiredPosition = worldsFitPosition.copy(bounds.center).addScaledVector(worldsFitDirection, distance)
  camera.position.copy(resolveWorldsCameraPositionWithSurfaces(camera.position, desiredPosition, collisionSurfaces))
  controls.target.copy(bounds.center)
  camera.updateMatrixWorld()
  controls.update()
  return true
}

export function createCollisionSafeWorldsCameraFitSnapshot(
  snapshot: WorldsCameraFitSnapshot,
  currentPosition: THREE.Vector3,
  collisionSurfaces: readonly WorldsResolvedCollisionSurface[],
): WorldsCameraFitSnapshot {
  if (collisionSurfaces.length === 0) return snapshot
  return {
    ...snapshot,
    position: resolveWorldsCameraPositionWithSurfaces(currentPosition, snapshot.position, collisionSurfaces),
  }
}

export function resolveWorldsCameraPositionWithSurfaces(
  currentPosition: THREE.Vector3,
  desiredPosition: THREE.Vector3,
  collisionSurfaces: readonly WorldsResolvedCollisionSurface[],
): THREE.Vector3 {
  if (collisionSurfaces.length === 0) return desiredPosition.clone()
  const resolution = resolveWorldSurfaceProbeTranslation({
    position: surfaceVectorFromThree(currentPosition),
    delta: {
      x: desiredPosition.x - currentPosition.x,
      y: desiredPosition.y - currentPosition.y,
      z: desiredPosition.z - currentPosition.z,
    },
    probeHalfExtents: WORLD_CAMERA_COLLISION_HALF_EXTENTS,
    surfaces: collisionSurfaces,
  })
  return setThreeFromSurfaceVector(worldsResolvedCameraPosition.clone(), resolution.position)
}

function applyWorldSceneTransformUpdatesToObjects(
  sceneObjects: ReadonlyMap<string, THREE.Object3D>,
  updates: readonly WorldSceneItemTransformUpdate[],
): void {
  for (const update of updates) {
    const target = sceneObjects.get(update.itemId)
    if (!target) continue
    applyWorldSceneTransformToObject(target, update.transform)
  }
}

function applyWorldSceneTransformToObject(target: THREE.Object3D, transform: WorldSceneItem['transform']): void {
  target.position.fromArray(transform.position)
  target.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2], 'XYZ')
  target.scale.fromArray(transform.scale)
  target.updateMatrixWorld(true)
}

function readWorldSceneTransformFromObject(target: THREE.Object3D): WorldSceneItem['transform'] {
  return {
    position: target.position.toArray() as [number, number, number],
    rotation: [target.rotation.x, target.rotation.y, target.rotation.z],
    scale: target.scale.toArray() as [number, number, number],
  }
}

function cloneWorldSceneTransform(transform: WorldSceneItem['transform']): WorldSceneItem['transform'] {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
}

function cloneTransformUpdate(update: WorldSceneItemTransformUpdate): WorldSceneItemTransformUpdate {
  return {
    itemId: update.itemId,
    transform: cloneWorldSceneTransform(update.transform),
  }
}

function cloneCollisionBounds(bounds: WorldsCollisionBounds): WorldsCollisionBounds {
  return {
    min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
    max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
  }
}

function surfaceVectorFromThree(vector: THREE.Vector3): WorldsResolvedCollisionSurface['origin'] {
  return { x: vector.x, y: vector.y, z: vector.z }
}

function setThreeFromSurfaceVector(target: THREE.Vector3, vector: WorldsResolvedCollisionSurface['origin']): THREE.Vector3 {
  return target.set(vector.x, vector.y, vector.z)
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
