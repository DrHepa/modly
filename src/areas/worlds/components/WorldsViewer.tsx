import { Component, Suspense, createContext, lazy, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Bounds, Environment, GizmoHelper, GizmoViewport, Html, Lightformer, OrbitControls, TransformControls, useGLTF } from '@react-three/drei'
import { Select, Selection } from '@react-three/postprocessing'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { clone as cloneSkeletonScene } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import type { PoseClipSidecarV1 } from '../../../shared/types/electron.d.ts'
import type { SceneArtifactManifestInitialView } from '../../../shared/types/artifacts.ts'

import { classifyPlyGeometry } from '../plyClassification.ts'
import { isWorldsGaussianPlyEnabled, type WorldSceneItem } from '../worldRenderableResolver.ts'
import type { WorldProjectDocumentV1 } from '../core/worldModel.ts'
import { WorldViewportGraphics } from './WorldViewportGraphics.tsx'
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
  DEFAULT_WORLDS_VIEWPORT_CONTROL_MODE,
  createWorldsCameraState,
  type WorldsViewportControlMode,
} from '../worldCameraNavigation.ts'
import type { WorldsResolvedCollisionSurface } from '../worldsSurfaceMath.ts'
import { resolveWorldSurfaceProbeTranslation } from '../worldsSurfaceNavigation.ts'
import { resolveWorldsSurfacePlacement } from '../worldsSurfacePlacement.ts'
import {
  resolveWorldsBaseSceneSupportPlacement,
  resolveWorldsPendingSurfacePlacementDecision,
  WORLDS_DRAG_BASE_SUPPORT_MAX_CORRECTION,
} from '../worldsBaseSceneSupport.ts'
import { WorldsViewportModeControl } from './WorldsViewportModeControl.tsx'
import { WorldsViewportNavigationControls, type WorldsOrbitControlsHandle } from './WorldsViewportNavigationControls.tsx'
import WorldsTransformToolbar, { type WorldsItemSelectionOptions, type WorldsTransformMode } from './WorldsTransformToolbar.tsx'
import WorldCollisionSurfaceLayer from './WorldCollisionSurfaceLayer.tsx'
import type { WorldCollisionSurface, WorldCollisionSurfacePreset } from '../worldsCollisionSurfaces.ts'
import type { WorldsTimelineViewportPreview, WorldsViewportCamera, WorldsViewportEnvironment, WorldsViewportLight } from '../worldsViewportTypes.ts'
import { WorldCanvasLifecycle, type WorldViewportFailure } from './WorldViewportBoundary.tsx'

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree as any
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree as any
THREE.Mesh.prototype.raycast = acceleratedRaycast

export { WorldsViewportModeControl } from './WorldsViewportModeControl.tsx'
export { WorldsViewportNavigationControls } from './WorldsViewportNavigationControls.tsx'

const LazyWorldsGaussianPlyObject = lazy(async () => {
  const module = await import('./WorldsGaussianPlyObject.tsx')
  return { default: module.WorldsGaussianPlyObject }
})

export type WorldsViewerUnsupportedItem = {
  workspacePath: string
  reason: 'unsupported-spz' | 'unsupported-gaussian-ply' | 'unsupported-extension' | 'unsafe' | 'unavailable'
}

export interface WorldsViewerProps {
  project: WorldProjectDocumentV1
  onGraphicsFailure?: (failure: WorldViewportFailure) => void
  onGraphicsDiagnostic?: (message: string) => void
  items: WorldSceneItem[]
  initialView?: SceneArtifactManifestInitialView
  environment?: WorldsViewportEnvironment
  lights?: WorldsViewportLight[]
  useStudioLights?: boolean
  showPlaybackControls?: boolean
  showAuthoringToolbar?: boolean
  timelinePreview?: WorldsTimelineViewportPreview | null
  collisionSurfaces?: WorldCollisionSurface[]
  unsupportedItems?: WorldsViewerUnsupportedItem[]
  selectedItemId?: string | null
  selectedItemIds?: string[]
  pendingSurfacePlacementItemId?: string | null
  collisionEditMode?: boolean
  selectedCollisionSurfaceId?: string | null
  transformMode?: WorldsTransformMode | null
  onSelectItem?: (itemId: string | null, options?: WorldsItemSelectionOptions) => void
  onAddCollisionSurface?: (preset?: WorldCollisionSurfacePreset) => void
  onCollisionEditModeChange?: (enabled: boolean) => void
  onSelectCollisionSurface?: (surfaceId: string | null) => void
  onTransformModeChange?: (mode: WorldsTransformMode | null) => void
  transformPending?: boolean
  transformStatus?: string | null
  onTransformGestureBegin?: (itemIds: readonly string[]) => WorldsTransformGestureToken | null
  onTransformGestureCancel?: (gesture: WorldsTransformGestureToken) => void
  onTransformItem?: (itemId: string, transform: WorldSceneItem['transform'], meta?: WorldsTransformCommitMeta) => void
  onTransformItems?: (updates: WorldSceneItemTransformUpdate[], meta?: WorldsTransformCommitMeta) => void
  onTransformCollisionSurface?: (surfaceId: string, transform: WorldCollisionSurface['transform']) => void
  onRemoveCollisionSurface?: (surfaceId: string | null) => void
  onRemoveItem?: (itemId: string | null) => void
  onToggleBaseSceneItem?: (itemId: string | null) => void
  onSceneItemAnchorChange?: (itemId: string, anchor: [number, number, number] | null) => void
  onCommitPendingSurfacePlacement?: (itemId: string, transform: WorldSceneItem['transform']) => void
  onClearPendingSurfacePlacement?: () => void
  onAnimationMetadata?: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void
}

export interface WorldsTransformGestureToken {
  readonly gestureId: string
}

export interface WorldsTransformCommitMeta {
  readonly gesture: WorldsTransformGestureToken | null
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
  modes: ['inspect', 'fly', 'run'],
  orbitControls: 'inspect-only',
  pointerLock: 'explicit-fly-run',
  keyboardMovement: 'viewer-scoped',
} as const

export const WORLD_VIEWER_ORBIT_CONTROLS = {
  enablePan: true,
  enableZoom: true,
  enableRotate: true,
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

const WORLD_SELECTION_ACTIVE_SILHOUETTE_COLOR = 0x8b5cf6
const WORLD_SELECTION_ACTIVE_SILHOUETTE_OPACITY = 0.8
const WORLD_SELECTION_ACTIVE_SILHOUETTE_SCALE = 1.012
const WORLD_SELECTION_SECONDARY_SILHOUETTE_COLOR = 0x38bdf8
const WORLD_SELECTION_SECONDARY_SILHOUETTE_OPACITY = 0.52
const WORLD_SELECTION_SECONDARY_SILHOUETTE_SCALE = 1.008

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

type WorldsRenderLoadStatus = 'pending' | 'loading' | 'ready' | 'failed' | 'removed'
type WorldsRenderLoadState = { sourceKey: string; owner: object; attempt: object; status: WorldsRenderLoadStatus }
type WorldsRenderLoadReporter = (item: WorldSceneItem, attempt: object, status: WorldsRenderLoadStatus, owner?: object) => void
const WorldsRenderLoadContext = createContext<(status: WorldsRenderLoadStatus, attempt?: object) => void>(() => {})
function worldsRenderSourceKey(item: WorldSceneItem): string {
  return `${item.id}|${item.kind}|${item.workspacePath}|${item.url}`
}
function updateWorldsRenderLoadState(states: Map<string, WorldsRenderLoadState>, item: WorldSceneItem, attempt: object, status: WorldsRenderLoadStatus, boundaryOwner?: object): boolean {
  const sourceKey = worldsRenderSourceKey(item), previous = states.get(item.id)
  const owner = boundaryOwner ?? (status === 'pending' ? attempt : previous?.owner ?? attempt)
  if (status === 'pending') {
    if (attempt !== owner) return false
  } else {
    if (!previous || previous.owner !== owner || previous.sourceKey !== sourceKey) return false
    if (status === 'removed') {
      if (attempt === owner) return states.delete(item.id)
      if (previous.attempt !== attempt) return false
      // Child cleanup retires only its load; the still-mounted boundary keeps authority.
      states.set(item.id, { sourceKey, owner, attempt: owner, status: 'pending' })
      return true
    }
    if (previous.status === 'failed' && previous.attempt === owner && status !== 'failed') return false
    if (status !== 'loading' && !(status === 'failed' && attempt === owner) && previous.attempt !== attempt) return false
  }
  if (previous?.attempt === attempt && previous.sourceKey === sourceKey && previous.status === status) return false
  states.set(item.id, { sourceKey, owner, attempt, status })
  return true
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
  project,
  onGraphicsFailure,
  onGraphicsDiagnostic,
  items,
  initialView,
  environment,
  lights = [],
  useStudioLights = shouldUseWorldsStudioLights(lights),
  showPlaybackControls = true,
  showAuthoringToolbar = true,
  timelinePreview = null,
  collisionSurfaces = [],
  unsupportedItems = [],
  selectedItemId = null,
  selectedItemIds = [],
  pendingSurfacePlacementItemId = null,
  collisionEditMode = false,
  selectedCollisionSurfaceId = null,
  transformMode = null,
  transformPending = false,
  transformStatus = null,
  onSelectItem = () => undefined,
  onAddCollisionSurface = () => undefined,
  onCollisionEditModeChange = () => undefined,
  onSelectCollisionSurface = () => undefined,
  onTransformModeChange = () => undefined,
  onTransformGestureBegin,
  onTransformGestureCancel = () => undefined,
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
  const orbitControlsRef = useRef<OrbitControlsImpl | null>(null)
  const cameraFitSnapshotRef = useRef<WorldsCameraFitSnapshot | null>(null)
  const [cameraState, setCameraState] = useState(() => createWorldsCameraState())
  const [controlMode, setControlMode] = useState<WorldsViewportControlMode>(DEFAULT_WORLDS_VIEWPORT_CONTROL_MODE)
  const [pointerLocked, setPointerLocked] = useState(false)
  const [navigationStatus, setNavigationStatus] = useState('Inspect mode. Orbit, pan, select, and edit.')
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items])
  const sceneFitKey = useMemo(() => createWorldsSceneFitKey(visibleItems), [visibleItems])
  const description = describeWorldsViewerScene(items, unsupportedItems, selectedItemId, normalizedSelectedItemIds)
  const sceneObjectsRef = useRef(new Map<string, THREE.Object3D>())
  const renderLoadStatesRef = useRef(new Map<string, WorldsRenderLoadState>())
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
  const isInspectMode = controlMode === 'inspect'
  const editorControlsVisible = !timelinePreview
  const inspectAuthoringEnabled = editorControlsVisible && isInspectMode
  const handleControlModeChange = useCallback((nextMode: WorldsViewportControlMode) => {
    setControlMode(nextMode)
    if (nextMode !== 'inspect') setFocusRequest(null)
  }, [])
  const handleFrameScene = useCallback(() => {
    setControlMode('inspect')
    setCameraState((state) => ({ ...state, resetToken: state.resetToken + 1 }))
  }, [])
  useEffect(() => {
    if (timelinePreview) {
      setControlMode('inspect')
    }
  }, [timelinePreview])
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
  const reportRenderLoadState = useCallback<WorldsRenderLoadReporter>((item, attempt, status, owner) => {
    if (updateWorldsRenderLoadState(renderLoadStatesRef.current, item, attempt, status, owner)) setSceneLoadRevision((revision) => revision + 1)
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
      {editorControlsVisible ? <WorldsViewportModeControl
        mode={controlMode}
        status={navigationStatus}
        pointerLocked={pointerLocked}
        onModeChange={handleControlModeChange}
        onFrameScene={handleFrameScene}
      /> : null}
                {inspectAuthoringEnabled && showAuthoringToolbar ? <WorldsTransformToolbar
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
                /> : null}
                {transformPending || transformStatus ? <div className="worlds-empty-copy" role="status" aria-live="polite">{transformStatus ?? 'Saving transform…'}</div> : null}
      {showPlaybackControls ? <WorldsPlaybackControls
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
      /> : null}
      <Canvas
        shadows
        camera={{ position: [2.4, 1.8, 2.8], fov: 45, near: 0.01, far: 500 }}
        dpr={1}
        gl={{
          antialias: false,
          alpha: false,
          outputColorSpace: THREE.SRGBColorSpace,
          toneMapping: THREE.NoToneMapping,
          toneMappingExposure: 1.8,
        }}
        className="h-full w-full bg-[#18181b]"
        onPointerMissed={inspectAuthoringEnabled ? handleCanvasPointerMissed : undefined}
      >
        <WorldCanvasLifecycle onFailure={onGraphicsFailure} />
        <WorldsSceneLighting
          environment={environment}
          lights={lights}
          useStudioLights={useStudioLights}
        />
        <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />
        <Bounds margin={1.25}>
          <Selection enabled={normalizedSelectedItemIds.length > 0}>
            {visibleItems.map((item) => (
              <WorldSceneItemErrorBoundary key={worldsRenderSourceKey(item)} item={item} onRenderLoadStateChange={reportRenderLoadState}>
                <Suspense fallback={null}>
                  <WorldSceneItemObject
                    item={item}
                    selected={selectedItemIdSet.has(item.id)}
                    boundsVersion={item.id === selectedItemId ? selectedBoundsVersion : 0}
                    playbackRef={playbackRef}
                    onSelectItem={inspectAuthoringEnabled ? selectSceneItemFromCanvas : () => undefined}
                    onFocusItem={inspectAuthoringEnabled ? focusSceneItemFromCanvas : () => undefined}
                    onRegisterObject={registerSceneObject}
                    onLocalBoundsChange={cacheSceneItemLocalBounds}
                    onSceneItemAnchorChange={onSceneItemAnchorChange}
                    onAnimationMetadata={onAnimationMetadata}
                    timelineAnimationTimeSeconds={resolveWorldsTimelineAnimationTime(item.id, timelinePreview)}
                  />
                </Suspense>
              </WorldSceneItemErrorBoundary>
            ))}
            {inspectAuthoringEnabled && collisionEditMode ? (
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
          {inspectAuthoringEnabled ? selectedSceneObjects.secondaryObjects.map((object) => (
            <WorldsSelectionSilhouette
              key={object.uuid}
              target={object}
              color={WORLD_SELECTION_SECONDARY_SILHOUETTE_COLOR}
              opacity={WORLD_SELECTION_SECONDARY_SILHOUETTE_OPACITY}
              scaleMultiplier={WORLD_SELECTION_SECONDARY_SILHOUETTE_SCALE}
              renderOrder={1}
            />
          )) : null}
          {inspectAuthoringEnabled && selectedSceneObjects.activeObject ? (
            <WorldsSelectionSilhouette
              target={selectedSceneObjects.activeObject}
              color={WORLD_SELECTION_ACTIVE_SILHOUETTE_COLOR}
              opacity={WORLD_SELECTION_ACTIVE_SILHOUETTE_OPACITY}
              scaleMultiplier={WORLD_SELECTION_ACTIVE_SILHOUETTE_SCALE}
              renderOrder={2}
            />
          ) : null}
          {selectedObject && transformMode && !selectedCollisionSurfaceId && inspectAuthoringEnabled ? (
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
              onTransformGestureBegin={onTransformGestureBegin}
              onTransformGestureCancel={onTransformGestureCancel}
            />
          ) : null}
            {editorControlsVisible ? <SceneFitController
              enabled={inspectAuthoringEnabled}
              initialView={initialView}
              fitKey={sceneFitKey}
              loadRevision={sceneLoadRevision}
              sceneItems={visibleItems}
              sceneObjectsRef={sceneObjectsRef}
              sceneObjectVersion={sceneObjectVersion}
              renderLoadStatesRef={renderLoadStatesRef}
              resetToken={cameraState.resetToken}
              orbitControlsRef={orbitControlsRef}
              cameraFitSnapshotRef={cameraFitSnapshotRef}
              collisionSurfaces={resolvedCollisionSurfaces}
            /> : null}
            {inspectAuthoringEnabled ? <SceneFocusController
              focusRequest={focusRequest}
              orbitControlsRef={orbitControlsRef}
              sceneObjectsRef={sceneObjectsRef}
              collisionSurfaces={resolvedCollisionSurfaces}
            /> : null}
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
            <WorldViewportGraphics
              kind="editor"
              project={project}
              selectedObjects={[
                ...(selectedSceneObjects.activeObject ? [selectedSceneObjects.activeObject] : []),
                ...selectedSceneObjects.secondaryObjects,
              ]}
              onDiagnostic={onGraphicsDiagnostic}
              onGraphicsFailure={onGraphicsFailure}
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
          enabled={inspectAuthoringEnabled}
        />
        {editorControlsVisible ? <WorldsViewportNavigationControls
          mode={controlMode}
          collisionSurfaces={resolvedCollisionSurfaces}
          inputScopeRef={inputScopeRef}
          orbitControlsRef={orbitControlsRef}
          frameSceneToken={cameraState.resetToken}
          onModeChange={handleControlModeChange}
          onPointerLockChange={setPointerLocked}
          onStatusChange={setNavigationStatus}
        /> : null}
        {timelinePreview?.activeCamera ? <WorldsTimelinePreviewCameraController camera={timelinePreview.activeCamera} /> : null}
        <WorldsPlaybackFrameController playbackRef={playbackRef} scrubRef={playbackScrubRef} timeLabelRef={playbackTimeLabelRef} />
        {inspectAuthoringEnabled ? <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport axisColors={['#ef4444', '#22c55e', '#3b82f6']} labelColor="#f4f4f5" />
        </GizmoHelper> : null}
      </Canvas>

      {description.unsupported.length > 0 ? (
        <div role="status" className="absolute right-3 top-3 rounded-full border border-zinc-700/70 bg-zinc-950/70 px-3 py-1 text-xs text-zinc-300 shadow-xl backdrop-blur">
          Unsupported world asset: {description.unsupported[0].reason}
        </div>
      ) : null}
    </section>
  )
}

export function shouldUseWorldsStudioLights(lights: readonly WorldsViewportLight[]): boolean {
  return lights.length === 0
}

export function resolveWorldsTimelineAnimationTime(
  entityId: string,
  preview: WorldsTimelineViewportPreview | null | undefined,
): number | undefined {
  if (!preview) return undefined
  const state = preview.animationStates.find((candidate) => candidate.entityId === entityId)
  return state?.playing ? Math.max(0, preview.timeSeconds) : 0
}

export function createWorldsPoseClipLoadKey(
  workspacePath: string,
  animation: WorldSceneItem['animation'],
): string | null {
  if (!animation || animation.kind !== 'pose-clip' || workspacePath !== animation.sourceWorkspacePath) return null
  return JSON.stringify([
    workspacePath,
    animation.kind,
    animation.sourceWorkspacePath,
    animation.sidecarWorkspacePath,
    animation.legacySidecarWorkspacePath ?? null,
  ])
}

export function createWorldsTimelinePreviewCamera(
  descriptor: WorldsViewportCamera,
  viewportWidth: number,
  viewportHeight: number,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  const camera = descriptor.component.projection === 'orthographic'
    ? new THREE.OrthographicCamera()
    : new THREE.PerspectiveCamera()
  applyWorldsTimelinePreviewCamera(camera, descriptor, viewportWidth, viewportHeight)
  return camera
}

export function applyWorldsTimelinePreviewCamera(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  descriptor: WorldsViewportCamera,
  viewportWidth: number,
  viewportHeight: number,
): void {
  const component = descriptor.component
  const aspect = Math.max(1, viewportWidth) / Math.max(1, viewportHeight)
  camera.position.set(...descriptor.transform.position)
  camera.quaternion.setFromEuler(new THREE.Euler(...descriptor.transform.rotation, 'XYZ'))
  camera.up.set(0, 1, 0)
  camera.near = component.near
  camera.far = component.far
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.fov = component.fieldOfView ?? 45
    camera.aspect = aspect
  } else {
    const verticalSize = component.orthographicSize ?? 10
    camera.top = verticalSize / 2
    camera.bottom = -verticalSize / 2
    camera.left = -verticalSize * aspect / 2
    camera.right = verticalSize * aspect / 2
  }
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
}

function WorldsTimelinePreviewCameraController({ camera: descriptor }: { camera: WorldsViewportCamera }): null {
  const { get, set, size } = useThree()
  const camera = useMemo(
    () => descriptor.component.projection === 'orthographic'
      ? new THREE.OrthographicCamera()
      : new THREE.PerspectiveCamera(),
    [descriptor.component.projection],
  )
  useLayoutEffect(() => {
    const editorCamera = get().camera
    set({ camera })
    return () => {
      if (get().camera === camera) set({ camera: editorCamera })
    }
  }, [camera, get, set])
  useLayoutEffect(() => {
    applyWorldsTimelinePreviewCamera(camera, descriptor, size.width, size.height)
  }, [camera, descriptor, size.height, size.width])
  return null
}

export function WorldsSceneLighting({
  environment,
  lights,
  useStudioLights,
}: {
  environment?: WorldsViewportEnvironment
  lights: readonly WorldsViewportLight[]
  useStudioLights: boolean
}): JSX.Element {
  const backgroundColor = environment?.backgroundColor ?? '#18181b'
  const ambientIntensity = environment?.ambientIntensity ?? 0.3
  return (
    <>
      <color attach="background" args={[backgroundColor]} />
      {environment?.environmentResourceUrl ? (
        <Environment files={environment.environmentResourceUrl} background={false} />
      ) : null}
      {useStudioLights ? (
        <>
          <ambientLight intensity={ambientIntensity} />
          {!environment?.environmentResourceUrl ? (
            <Environment background={false}>
              <Lightformer intensity={2} position={[0, 4, 4]} scale={8} />
              <Lightformer intensity={0.5} position={[-4, 2, -4]} scale={6} />
              <Lightformer intensity={0.3} position={[4, 1, -4]} scale={6} />
            </Environment>
          ) : null}
          <directionalLight position={[5, 8, 5]} color="#ffffff" intensity={1.5} />
          <directionalLight position={[-4, 2, -4]} color="#ffffff" intensity={0.6} />
        </>
      ) : (
        <>
          {ambientIntensity > 0 ? <ambientLight intensity={ambientIntensity} /> : null}
          {lights.map((light) => <WorldsAuthoredLight key={light.component.id} light={light} />)}
        </>
      )}
    </>
  )
}

function WorldsAuthoredLight({ light }: { light: WorldsViewportLight }): JSX.Element {
  const { component, transform } = light
  if (component.lightKind === 'ambient') {
    return <ambientLight color={component.color} intensity={component.intensity} />
  }
  if (component.lightKind === 'directional') {
    return <WorldsTargetedAuthoredLight light={light} />
  }
  if (component.lightKind === 'point') {
    return <pointLight position={transform.position} color={component.color} intensity={component.intensity} distance={component.range} decay={2} castShadow={component.castShadow} />
  }
  return <WorldsTargetedAuthoredLight light={light} />
}

function WorldsTargetedAuthoredLight({ light }: { light: WorldsViewportLight }): JSX.Element {
  const { component, transform } = light
  const target = useMemo(() => new THREE.Object3D(), [])
  target.position.set(...resolveWorldsLightTarget(transform))
  if (component.lightKind === 'directional') {
    return (
      <>
        <primitive object={target} />
        <directionalLight position={transform.position} target={target} color={component.color} intensity={component.intensity} castShadow={component.castShadow} />
      </>
    )
  }
  if (component.lightKind !== 'spot') return <></>
  return (
    <>
      <primitive object={target} />
      <spotLight position={transform.position} target={target} color={component.color} intensity={component.intensity} distance={component.range} angle={component.angle} decay={2} castShadow={component.castShadow} />
    </>
  )
}

export function resolveWorldsLightTarget(transform: WorldsViewportLight['transform']): [number, number, number] {
  const direction = new THREE.Vector3(0, 0, -1)
    .applyEuler(new THREE.Euler(...transform.rotation, 'XYZ'))
  return [
    transform.position[0] + direction.x,
    transform.position[1] + direction.y,
    transform.position[2] + direction.z,
  ]
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
  timelineAnimationTimeSeconds,
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
  timelineAnimationTimeSeconds?: number
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
          <WorldSceneItemGeometry item={item} playbackRef={playbackRef} timelineAnimationTimeSeconds={timelineAnimationTimeSeconds} onAnimationMetadata={onAnimationMetadata} onBoundsChange={invalidateBounds} />
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
  const ctrlKey = event && 'nativeEvent' in event ? event.nativeEvent?.ctrlKey : event?.ctrlKey
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
    const preview: WorldsTransformPreviewResolution = {
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

  const preview: WorldsTransformPreviewResolution = {
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

function WorldSceneItemGeometry({ item, playbackRef, timelineAnimationTimeSeconds, onAnimationMetadata, onBoundsChange }: { item: WorldSceneItem; playbackRef: MutableRefObject<WorldsPlaybackRef>; timelineAnimationTimeSeconds?: number; onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void; onBoundsChange: () => void }): JSX.Element | null {
  if (item.kind === 'gaussian-ply') {
    if (!isWorldsGaussianPlyEnabled()) return null
    return <LazyWorldsGaussianPlyObject itemId={item.id} url={item.url} onBoundsChange={onBoundsChange} />
  }
  if (item.kind === 'ply-mesh' || item.kind === 'ply-points') {
    return <PlySceneObject item={item} onBoundsChange={onBoundsChange} />
  }
  return <GltfSceneObject item={item} playbackRef={playbackRef} timelineAnimationTimeSeconds={timelineAnimationTimeSeconds} onAnimationMetadata={onAnimationMetadata} onBoundsChange={onBoundsChange} />
}

function PlySceneObject({ item, onBoundsChange }: { item: WorldSceneItem; onBoundsChange: () => void }): JSX.Element | null {
  const [model, setModel] = useState<PlyRenderModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reportLoadState = useContext(WorldsRenderLoadContext)
  const activeAttemptRef = useRef<object | null>(null)
  const modelAttemptRef = useRef<object | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const attempt = {}
    activeAttemptRef.current = attempt
    modelAttemptRef.current = null
    reportLoadState('loading', attempt)
    setModel(null)
    setError(null)

    fetch(item.url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load PLY: ${response.status}`)
        return response.arrayBuffer()
      })
      .then((buffer) => {
        if (!controller.signal.aborted) {
          const nextModel = createPlyRenderModel(buffer, item)
          modelAttemptRef.current = attempt
          setModel(nextModel)
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Unable to load PLY')
          reportLoadState('failed', attempt)
        }
      })

    return () => {
      controller.abort()
      reportLoadState('removed', attempt)
    }
  }, [item, reportLoadState])

  useEffect(() => {
    if (model && modelAttemptRef.current === activeAttemptRef.current) {
      onBoundsChange()
      if (activeAttemptRef.current) reportLoadState('ready', activeAttemptRef.current)
    }
  }, [model, onBoundsChange, reportLoadState])

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
      <points geometry={model.geometry} userData={{ worldsSceneItemId: item.id }} castShadow={item.castShadow} receiveShadow={item.receiveShadow}>
        <pointsMaterial
          size={model.pointSize}
          sizeAttenuation
          vertexColors={model.hasVertexColors}
          color={item.material?.baseColor ?? (model.hasVertexColors ? undefined : '#a1a1aa')}
          opacity={item.material?.opacity ?? 1}
          transparent={(item.material?.opacity ?? 1) < 1}
        />
      </points>
    )
  }

  return (
      <mesh geometry={model.geometry} userData={{ worldsSceneItemId: item.id }} castShadow={item.castShadow} receiveShadow={item.receiveShadow}>
      <meshStandardMaterial
        vertexColors={model.hasVertexColors}
        color={item.material?.baseColor ?? (model.hasVertexColors ? undefined : '#d4d4d8')}
        roughness={item.material?.roughness ?? 0.8}
        metalness={item.material?.metallic ?? 0.05}
        opacity={item.material?.opacity ?? 1}
        transparent={(item.material?.opacity ?? 1) < 1}
      />
    </mesh>
  )
}

function GltfSceneObject({ item, playbackRef, timelineAnimationTimeSeconds, onAnimationMetadata, onBoundsChange }: { item: WorldSceneItem; playbackRef: MutableRefObject<WorldsPlaybackRef>; timelineAnimationTimeSeconds?: number; onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void; onBoundsChange: () => void }): JSX.Element {
  const gltf = useGLTF(item.url)
  const instance = useWorldsGltfSceneInstance(gltf.scene)
  if (!instance) return <group />
  return <GltfSceneInstanceObject item={item} instance={instance} playbackRef={playbackRef} timelineAnimationTimeSeconds={timelineAnimationTimeSeconds} onAnimationMetadata={onAnimationMetadata} onBoundsChange={onBoundsChange} />
}

function useWorldsGltfSceneInstance(sourceScene: THREE.Object3D): WorldsGltfSceneInstance | null {
  const resourceRef = useRef<{ sourceScene: THREE.Object3D; instance: WorldsGltfSceneInstance } | null>(null)
  const [activeResource, setActiveResource] = useState<{ sourceScene: THREE.Object3D; instance: WorldsGltfSceneInstance } | null>(null)

  useEffect(() => {
    let resource = resourceRef.current
    if (!resource || resource.sourceScene !== sourceScene || isWorldsGltfSceneInstanceDisposed(resource.instance)) {
      resource = { sourceScene, instance: createWorldsGltfSceneInstance(sourceScene) }
      resourceRef.current = resource
    }
    const release = retainWorldsGltfSceneInstance(resource.instance)
    setActiveResource(resource)
    return release
  }, [sourceScene])

  if (activeResource?.sourceScene !== sourceScene || isWorldsGltfSceneInstanceDisposed(activeResource.instance)) return null
  return activeResource.instance
}

function GltfSceneInstanceObject({ item, instance, playbackRef, timelineAnimationTimeSeconds, onAnimationMetadata, onBoundsChange }: { item: WorldSceneItem; instance: WorldsGltfSceneInstance; playbackRef: MutableRefObject<WorldsPlaybackRef>; timelineAnimationTimeSeconds?: number; onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void; onBoundsChange: () => void }): JSX.Element {
  const scene = instance.scene
  const reportLoadState = useContext(WorldsRenderLoadContext)
  useEffect(() => { reportLoadState('ready') }, [reportLoadState, scene])
  const animationRef = useRef(item.animation)
  const onAnimationMetadataRef = useRef(onAnimationMetadata)
  animationRef.current = item.animation
  onAnimationMetadataRef.current = onAnimationMetadata
  const poseClipLoadKey = createWorldsPoseClipLoadKey(item.workspacePath, item.animation)
  const poseClipRef = useRef<{
    sidecar: PoseClipSidecarV1
    bonesById: Map<string, THREE.Bone>
    snapshot: WorldsPoseClipBoneSnapshot
  } | null>(null)
  useEffect(() => {
    scene.traverse((child) => {
      child.userData.worldsSceneItemId = item.id
    })
  }, [item.id, scene])
  useEffect(() => {
    applyWorldsRenderableProjection(scene, item.material, item.castShadow, item.receiveShadow)
    onBoundsChange()
  }, [item.castShadow, item.material, item.receiveShadow, onBoundsChange, scene])
  useEffect(() => {
    const animation = animationRef.current
    poseClipRef.current = null
    if (!animation || poseClipLoadKey === null) return

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
        onAnimationMetadataRef.current(item.id, nextAnimation)
      }
    }).catch(() => undefined)

    return () => {
      cancelled = true
      poseClipRef.current = null
    }
  }, [item.id, poseClipLoadKey, scene])
  useFrame(() => {
    const poseClip = poseClipRef.current
    if (!poseClip) return
    applyWorldsPoseClipAtTime({
      sidecar: poseClip.sidecar,
      bonesById: poseClip.bonesById,
      snapshot: poseClip.snapshot,
      timeSeconds: timelineAnimationTimeSeconds ?? playbackRef.current?.timeSeconds ?? 0,
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
  onTransformGestureBegin,
  onTransformGestureCancel,
}: {
  object: THREE.Object3D
  mode: WorldsTransformMode
  selectedItemId: string | null
  selectedItems: WorldSceneItem[]
  sceneItems: readonly WorldSceneItem[]
  collisionSurfaces: readonly WorldsResolvedCollisionSurface[]
  draggingRef: MutableRefObject<boolean>
  sceneObjectsRef: MutableRefObject<Map<string, THREE.Object3D>>
  localBoundsRef: MutableRefObject<Map<string, WorldsCollisionBounds | null>>
  onDragEndSelectionBlock: () => void
  onBoundsChange: () => void
  onTransformItem: (itemId: string, transform: WorldSceneItem['transform'], meta?: WorldsTransformCommitMeta) => void
  onTransformItems: (updates: WorldSceneItemTransformUpdate[], meta?: WorldsTransformCommitMeta) => void
  onTransformGestureBegin?: (itemIds: readonly string[]) => WorldsTransformGestureToken | null
  onTransformGestureCancel: (gesture: WorldsTransformGestureToken) => void
}): JSX.Element | null {
  const dragSessionRef = useRef<{
    collisionSurfaces: readonly WorldsResolvedCollisionSurface[]
    denied: boolean
    gesture: WorldsTransformGestureToken | null
    lastValidTransforms: WorldSceneItemTransformUpdate[]
    localBoundsByItemId: Map<string, WorldsCollisionBounds | null>
    snapshot: WorldSceneTransformSnapshot[]
  } | null>(null)
  const latestDragLifecycleRef = useRef({
    sceneItems,
    onTransformGestureCancel,
  })
  latestDragLifecycleRef.current = {
    sceneItems,
    onTransformGestureCancel,
  }

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

    const gesture = onTransformGestureBegin ? onTransformGestureBegin(snapshot.map((entry) => entry.itemId)) : null
    dragSessionRef.current = {
      collisionSurfaces: [...collisionSurfaces],
      denied: !!onTransformGestureBegin && !gesture,
      gesture,
      lastValidTransforms: snapshot.map((entry) => ({ itemId: entry.itemId, transform: cloneWorldSceneTransform(entry.transform) })),
      localBoundsByItemId,
      snapshot,
    }
  }, [collisionSurfaces, localBoundsRef, onTransformGestureBegin, sceneObjectsRef, selectedItems])

  const restorePreviewTransforms = useCallback((updates: readonly WorldSceneItemTransformUpdate[]) => {
    applyWorldSceneTransformUpdatesToObjects(sceneObjectsRef.current, updates)
  }, [sceneObjectsRef])

  const cancelActiveDragSession = useCallback(() => {
    const session = dragSessionRef.current
    if (!session) return

    dragSessionRef.current = null
    draggingRef.current = false

    const currentTransformsByItemId = new Map(
      latestDragLifecycleRef.current.sceneItems.map((item) => [item.id, item.transform] as const),
    )
    restorePreviewTransforms(session.snapshot.map((entry) => ({
      itemId: entry.itemId,
      transform: cloneWorldSceneTransform(currentTransformsByItemId.get(entry.itemId) ?? entry.transform),
    })))

    if (session.gesture) latestDragLifecycleRef.current.onTransformGestureCancel(session.gesture)
  }, [draggingRef, restorePreviewTransforms])

  const selectedItemLifecycleKey = selectedItems.map((item) => item.id).join('\u001f')

  useEffect(() => {
    return () => {
      cancelActiveDragSession()
    }
  }, [cancelActiveDragSession, mode, object, selectedItemId, selectedItemLifecycleKey])

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
    if (session.denied) {
      restorePreviewTransforms(session.snapshot.map((entry) => ({ itemId: entry.itemId, transform: cloneWorldSceneTransform(entry.transform) })))
      return
    }
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
    if (session.denied) {
      restorePreviewTransforms(session.snapshot.map((entry) => ({ itemId: entry.itemId, transform: cloneWorldSceneTransform(entry.transform) })))
      return
    }
    const preview = resolvePreview()
    const committedUpdates = preview?.valid
      ? preview.updates
      : session.lastValidTransforms.length > 0
        ? session.lastValidTransforms
        : session.snapshot.map((entry) => ({ itemId: entry.itemId, transform: cloneWorldSceneTransform(entry.transform) }))
    restorePreviewTransforms(committedUpdates)

    if (committedUpdates.length <= 1) {
      onTransformItem(selectedItemId, cloneWorldSceneTransform(committedUpdates[0]?.transform ?? createActiveTransform()), { gesture: session.gesture })
      return
    }

    onTransformItems(committedUpdates.map(cloneTransformUpdate), { gesture: session.gesture })
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
  camera?: THREE.Camera,
): WorldsCameraFitSnapshot {
  const perspective = camera as THREE.PerspectiveCamera | undefined
  const verticalHalfFov = THREE.MathUtils.degToRad(perspective?.getEffectiveFOV?.() ?? 45) * 0.5
  const aspect = Number.isFinite(perspective?.aspect) && perspective!.aspect > 0 ? perspective!.aspect : 1
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect)
  const limitingHalfFov = Math.max(.001, Math.min(verticalHalfFov, horizontalHalfFov))
  // The enclosing sphere contains every transformed AABB corner, including corner depth.
  const radius = Math.max(bounds.size.length() * .5, WORLD_VIEWER_ORBIT_CONTROLS.minDistance)
  const safeDistance = radius / Math.sin(limitingHalfFov) * 1.25
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

export function measureWorldsSceneCameraBounds(
  sceneItems: readonly WorldSceneItem[],
  sceneObjects: ReadonlyMap<string, THREE.Object3D>,
  loadStates: ReadonlyMap<string, WorldsRenderLoadState> = new Map(),
): WorldsCameraBounds | null {
  const union = new THREE.Box3(), objectBounds = new THREE.Box3(), childBounds = new THREE.Box3()
  const center = new THREE.Vector3(), size = new THREE.Vector3()
  let visibleCount = 0
  for (const item of sceneItems) {
    if (!item.visible) continue
    if (item.kind === 'gaussian-ply' && !isWorldsGaussianPlyEnabled()) continue
    const state = loadStates.get(item.id)
    const currentState = state?.sourceKey === worldsRenderSourceKey(item) ? state : undefined
    if (currentState?.status === 'failed') continue
    if (currentState?.status === 'loading') return null
    visibleCount++
    const root = sceneObjects.get(item.id)
    if (!root) return null
    const measured = measureWorldsCameraRenderRoot(root, objectBounds, childBounds)
    if (!measured.hasBounds) {
      if (measured.nonrendering || currentState?.status === 'ready') continue
      return null
    }
    union.union(objectBounds)
  }
  if (!visibleCount || union.isEmpty()) return null
  union.getCenter(center); union.getSize(size)
  if (![...center.toArray(), ...size.toArray()].every(Number.isFinite)) return null
  return { center, size, distance: Math.max(size.length(), WORLD_VIEWER_ORBIT_CONTROLS.minDistance) }
}

function measureWorldsCameraRenderRoot(root: THREE.Object3D, bounds: THREE.Box3, childBounds: THREE.Box3): { hasBounds: boolean; nonrendering: boolean } {
  bounds.makeEmpty()
  for (let ancestor: THREE.Object3D | null = root; ancestor; ancestor = ancestor.parent) {
    if (!ancestor.visible) return { hasBounds: false, nonrendering: true }
    if (ancestor.userData.worldsSelectionHitbox || ancestor.userData.worldsSelectionSilhouette || ancestor.userData.worldsCollisionSurface) return { hasBounds: false, nonrendering: false }
  }
  root.updateWorldMatrix(true, true)
  // Native dispatch refreshes attached SkinnedMesh bind inverses before vertex bounds.
  root.updateMatrixWorld(true)
  let nonrendering = false
  const visit = (object: THREE.Object3D) => {
    if (object.userData.worldsSelectionHitbox || object.userData.worldsSelectionSilhouette || object.userData.worldsCollisionSurface) return
    if (!object.visible) { nonrendering = true; return }
    const custom = object.userData.worldsObjectBounds as THREE.Box3 | undefined
    if (custom?.isBox3 && !custom.isEmpty()) bounds.union(childBounds.copy(custom).applyMatrix4(object.matrixWorld))
    const rendered = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; boundingBox?: THREE.Box3 | null; computeBoundingBox?: () => void }
    if (rendered.geometry) {
      // Three's GLTF GPU instances and skinned meshes bound rendered vertices at object level.
      if (rendered.boundingBox !== undefined) rendered.computeBoundingBox?.()
      else if (!rendered.geometry.boundingBox) rendered.geometry.computeBoundingBox()
      const local = rendered.boundingBox !== undefined ? rendered.boundingBox : rendered.geometry.boundingBox
      if (local && !local.isEmpty()) bounds.union(childBounds.copy(local).applyMatrix4(object.matrixWorld))
    }
    object.children.forEach(visit)
  }
  visit(root)
  return { hasBounds: !bounds.isEmpty(), nonrendering }
}

function createWorldsInitialViewKey(initialView?: SceneArtifactManifestInitialView): string {
  return initialView ? [...initialView.position, ...initialView.target, ...(initialView.up ?? [0, 1, 0])].join('|') : ''
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

export function applyWorldsRenderableProjection(
  target: THREE.Object3D,
  materialOverride?: WorldSceneItem['material'],
  castShadow?: boolean,
  receiveShadow?: boolean,
): void {
  target.traverse((child) => {
    if ((child as THREE.Object3D & { isMesh?: boolean }).isMesh === true) {
      const mesh = child as THREE.Mesh
      if (castShadow !== undefined) mesh.castShadow = castShadow
      if (receiveShadow !== undefined) mesh.receiveShadow = receiveShadow
      if (!materialOverride) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) applyWorldsPbrMaterialOverride(material, materialOverride)
    } else if ((child as THREE.Object3D & { isPoints?: boolean }).isPoints === true && materialOverride) {
      const pointsMaterial = (child as THREE.Points).material as THREE.PointsMaterial
      if ((pointsMaterial as THREE.PointsMaterial & { isPointsMaterial?: boolean }).isPointsMaterial !== true) return
      pointsMaterial.color.set(materialOverride.baseColor)
      pointsMaterial.opacity = materialOverride.opacity
      pointsMaterial.transparent = materialOverride.opacity < 1
      pointsMaterial.needsUpdate = true
    }
  })
}

function applyWorldsPbrMaterialOverride(
  material: THREE.Material,
  override: NonNullable<WorldSceneItem['material']>,
): void {
  if ((material as THREE.MeshStandardMaterial & { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial === true) {
    const standard = material as THREE.MeshStandardMaterial
    standard.color.set(override.baseColor)
    standard.metalness = override.metallic
    standard.roughness = override.roughness
  }
  if ('opacity' in material) material.opacity = override.opacity
  material.transparent = override.opacity < 1
  material.needsUpdate = true
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

const pendingWorldsGltfInstanceDisposals = new WeakMap<object, { cancelled: boolean }>()
const disposedWorldsGltfSceneInstances = new WeakSet<object>()

function isWorldsGltfSceneInstanceDisposed(instance: object): boolean {
  return disposedWorldsGltfSceneInstances.has(instance)
}

export function retainWorldsGltfSceneInstance(instance: { dispose(): void }): () => void {
  const pending = pendingWorldsGltfInstanceDisposals.get(instance)
  if (pending) {
    pending.cancelled = true
    pendingWorldsGltfInstanceDisposals.delete(instance)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const scheduled = { cancelled: false }
    pendingWorldsGltfInstanceDisposals.set(instance, scheduled)
    queueMicrotask(() => {
      if (scheduled.cancelled || pendingWorldsGltfInstanceDisposals.get(instance) !== scheduled) return
      pendingWorldsGltfInstanceDisposals.delete(instance)
      disposedWorldsGltfSceneInstances.add(instance)
      instance.dispose()
    })
  }
}

function SceneFitController({
  enabled = true,
  initialView,
  fitKey,
  loadRevision,
  sceneItems,
  sceneObjectsRef,
  sceneObjectVersion,
  renderLoadStatesRef,
  resetToken,
  orbitControlsRef,
  cameraFitSnapshotRef,
  collisionSurfaces,
}: {
  enabled?: boolean
  initialView?: SceneArtifactManifestInitialView
  fitKey: string
  loadRevision: number
  sceneItems: readonly WorldSceneItem[]
  sceneObjectsRef: RefObject<ReadonlyMap<string, THREE.Object3D>>
  sceneObjectVersion: number
  renderLoadStatesRef?: RefObject<ReadonlyMap<string, WorldsRenderLoadState>>
  resetToken: number
  orbitControlsRef: RefObject<WorldsOrbitControlsHandle | null>
  cameraFitSnapshotRef: MutableRefObject<WorldsCameraFitSnapshot | null>
  collisionSurfaces: readonly WorldsResolvedCollisionSurface[]
}): null {
  const { camera } = useThree()
  const initialViewKey = createWorldsInitialViewKey(initialView)
  const previousInitialViewKeyRef = useRef(initialViewKey)
  const previousFitKeyRef = useRef<string | null>(null)
  const previousLoadRevisionRef = useRef(loadRevision)
  const boundsFitKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    const fitKeyChanged = previousFitKeyRef.current !== fitKey
    const initialViewChanged = previousInitialViewKeyRef.current !== initialViewKey
    const loadRevisionChanged = previousLoadRevisionRef.current !== loadRevision

    const needsBounds = fitKeyChanged || initialViewChanged || !cameraFitSnapshotRef.current
      || (!!initialView && loadRevisionChanged) || (!initialView && boundsFitKeyRef.current !== fitKey)
    const measuredBounds = needsBounds ? measureWorldsSceneCameraBounds(sceneItems, sceneObjectsRef.current ?? new Map(), renderLoadStatesRef?.current ?? new Map()) : null
    const effectiveBounds = measuredBounds ?? { center: WORLDS_DEFAULT_CAMERA_TARGET, size: new THREE.Vector3(), distance: 0 }
    const action = resolveWorldsSceneFitAction({
      fitKeyChanged,
      initialViewChanged,
      hasInitialView: !!initialView,
      hasMeasuredBounds: measuredBounds !== null,
      hasSnapshot: cameraFitSnapshotRef.current !== null,
      hasAppliedBoundsFitForCurrentFitKey: boundsFitKeyRef.current === fitKey,
      loadRevisionChanged,
    })

    if (action === 'apply-initial-view' && initialView) {
      const desiredSnapshot = createWorldsInitialViewCameraFitSnapshot(initialView, effectiveBounds)
      cameraFitSnapshotRef.current = resolveAndApplyWorldsCameraFitSnapshot(
        camera,
        orbitControlsRef.current,
        desiredSnapshot,
        collisionSurfaces,
      )
      boundsFitKeyRef.current = null
    } else if (action === 'apply-bounds-fit' && measuredBounds) {
      const desiredSnapshot = createWorldsBoundsCameraFitSnapshot(measuredBounds, camera.up, camera)
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
          effectiveBounds,
        )
      } else if (initialView) {
        const desiredSnapshot = createWorldsInitialViewCameraFitSnapshot(initialView, effectiveBounds)
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
    previousInitialViewKeyRef.current = initialViewKey
    previousLoadRevisionRef.current = loadRevision
  }, [camera, cameraFitSnapshotRef, collisionSurfaces, enabled, fitKey, initialView, initialViewKey, loadRevision, orbitControlsRef, sceneItems, sceneObjectsRef, sceneObjectVersion, renderLoadStatesRef])

  useEffect(() => {
    if (!enabled || resetToken === 0) return
    const snapshot = cameraFitSnapshotRef.current
    if (!snapshot) return
    applyWorldsCameraFitSnapshot(camera, orbitControlsRef.current, snapshot)
  }, [camera, cameraFitSnapshotRef, enabled, orbitControlsRef, resetToken])

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

class WorldSceneItemErrorBoundary extends Component<{ children: JSX.Element; item?: WorldSceneItem; onRenderLoadStateChange?: WorldsRenderLoadReporter }, { message: string | null }> {
  state = { message: null }
  private readonly attempt = {}
  private mounted = false
  private reportLoadState = (status: WorldsRenderLoadStatus, attempt = this.attempt) => {
    if (this.mounted && this.props.item) this.props.onRenderLoadStateChange?.(this.props.item, attempt, status, this.attempt)
  }
  componentDidMount(): void { this.mounted = true; this.reportLoadState('pending'); if (this.state.message) this.reportLoadState('failed') }
  componentDidCatch(): void { this.reportLoadState('failed') }
  componentWillUnmount(): void { this.reportLoadState('removed'); this.mounted = false }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : 'Unable to load world asset' }
  }

  render(): JSX.Element {
    if (this.state.message) return <HtmlStatus message={this.state.message} />
    return <WorldsRenderLoadContext.Provider value={this.reportLoadState}>{this.props.children}</WorldsRenderLoadContext.Provider>
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
