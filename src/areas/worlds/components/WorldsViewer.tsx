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
import { createWorldSceneSelectionTransformUpdates, type WorldSceneItemTransformUpdate, type WorldSceneTransformSnapshot } from '../worldsScenePlacement.ts'
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
import type { WorldCollisionZone, WorldCollisionZonePreset } from '../worldsCollisionZones.ts'

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
  collisionZones?: WorldCollisionZone[]
  unsupportedItems?: WorldsViewerUnsupportedItem[]
  selectedItemId?: string | null
  selectedItemIds?: string[]
  collisionEditMode?: boolean
  selectedCollisionZoneId?: string | null
  transformMode?: WorldsTransformMode | null
  onSelectItem?: (itemId: string | null, options?: { toggle?: boolean }) => void
  onAddCollisionZone?: (preset?: WorldCollisionZonePreset) => void
  onCollisionEditModeChange?: (enabled: boolean) => void
  onSelectCollisionZone?: (zoneId: string | null) => void
  onTransformModeChange?: (mode: WorldsTransformMode | null) => void
  onTransformItem?: (itemId: string, transform: WorldSceneItem['transform']) => void
  onTransformItems?: (updates: WorldSceneItemTransformUpdate[]) => void
  onTransformCollisionZone?: (zoneId: string, transform: WorldCollisionZone['transform']) => void
  onRemoveCollisionZone?: (zoneId: string | null) => void
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
const WORLD_SELECTION_ACTIVE_SILHOUETTE_COLOR = 0x8b5cf6
const WORLD_SELECTION_ACTIVE_SILHOUETTE_OPACITY = 0.8
const WORLD_SELECTION_ACTIVE_SILHOUETTE_SCALE = 1.012
const WORLD_SELECTION_SECONDARY_SILHOUETTE_COLOR = 0x38bdf8
const WORLD_SELECTION_SECONDARY_SILHOUETTE_OPACITY = 0.52
const WORLD_SELECTION_SECONDARY_SILHOUETTE_SCALE = 1.008

const WORLDS_CAMERA_HELP_TEXT = 'Left-drag look · Right-drag pan · Wheel zoom · WASD/Arrows move · Space up · Shift down · Q/E yaw'
const WORLDS_DEFAULT_CAMERA_POSITION = new THREE.Vector3(2.4, 1.8, 2.8)
const WORLDS_DEFAULT_CAMERA_TARGET = new THREE.Vector3(0, 0, 0)
const WORLDS_TRANSFORM_SELECTION_SUPPRESSION_MS = 180
const worldsFitDirection = new THREE.Vector3()
const worldsFitPosition = new THREE.Vector3()
const worldsFocusSize = new THREE.Vector3()

type WorldsCameraFitSnapshot = {
  position: THREE.Vector3
  target: THREE.Vector3
  near: number
  far: number
  maxDistance: number
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
  loader: 'ply' | 'gltf'
  primitive: 'mesh' | 'points' | 'scene'
  cameraFit: 'bounds'
  visibleDescription: 'PLY mesh geometry' | 'PLY point cloud geometry' | 'GLB/GLTF model scene'
}

type WorldsMeasuredBounds = {
  center: THREE.Vector3
  size: THREE.Vector3
}

export function WorldsViewer({
  items,
  collisionZones = [],
  unsupportedItems = [],
  selectedItemId = null,
  selectedItemIds = [],
  collisionEditMode = false,
  selectedCollisionZoneId = null,
  transformMode = null,
  onSelectItem = () => undefined,
  onAddCollisionZone = () => undefined,
  onCollisionEditModeChange = () => undefined,
  onSelectCollisionZone = () => undefined,
  onTransformModeChange = () => undefined,
  onTransformItem = () => undefined,
  onTransformItems = () => undefined,
  onTransformCollisionZone = () => undefined,
  onRemoveCollisionZone = () => undefined,
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
  const description = describeWorldsViewerScene(items, unsupportedItems, selectedItemId, selectedItemIds)
  const sceneObjectsRef = useRef(new Map<string, THREE.Object3D>())
  const transformDraggingRef = useRef(false)
  const suppressSelectionUntilRef = useRef(0)
  const [sceneObjectVersion, setSceneObjectVersion] = useState(0)
  const playbackRef = useRef<WorldsPlaybackRef>({ playing: false, timeSeconds: 0, durationSeconds: 0 })
  const playbackScrubRef = useRef<HTMLInputElement>(null)
  const playbackTimeLabelRef = useRef<HTMLSpanElement>(null)
  const playbackDuration = useMemo(() => resolveWorldsPlaybackDuration(visibleItems), [visibleItems])
  const [playbackPlaying, setPlaybackPlaying] = useState(false)
  const [playbackControlTime, setPlaybackControlTime] = useState(0)
  const [focusRequest, setFocusRequest] = useState<{ itemId: string; token: number } | null>(null)
  const [selectedBoundsVersion, setSelectedBoundsVersion] = useState(0)
  const selectedObject = useMemo(() => selectedItemId ? sceneObjectsRef.current.get(selectedItemId) ?? null : null, [sceneObjectVersion, selectedItemId])
  const selectedItemIdSet = useMemo(() => new Set(selectedItemIds), [selectedItemIds])
  const selectedItems = useMemo(() => visibleItems.filter((item) => selectedItemIdSet.has(item.id)), [selectedItemIdSet, visibleItems])
  const selectedSceneObjects = useMemo(() => resolveWorldsSelectedSceneObjects(sceneObjectsRef.current, selectedItemIds, selectedItemId), [sceneObjectVersion, selectedItemId, selectedItemIds])
  const selectSceneItemFromCanvas = useCallback((itemId: string | null, options?: { toggle?: boolean }) => {
    if (transformDraggingRef.current) return
    if (Date.now() < suppressSelectionUntilRef.current) return
    onSelectItem(itemId, options)
  }, [onSelectItem])
  const selectCollisionZoneFromCanvas = useCallback((zoneId: string | null) => {
    if (transformDraggingRef.current) return
    if (Date.now() < suppressSelectionUntilRef.current) return
    onSelectCollisionZone(zoneId)
  }, [onSelectCollisionZone])
  const handleTransformDragEnd = useCallback(() => {
    suppressSelectionUntilRef.current = Date.now() + WORLDS_TRANSFORM_SELECTION_SUPPRESSION_MS
  }, [])
  const focusSceneItemFromCanvas = useCallback((itemId: string) => {
    setFocusRequest((current) => ({ itemId, token: (current?.token ?? 0) + 1 }))
  }, [])
  const invalidateSelectedBounds = useCallback(() => {
    setSelectedBoundsVersion((version) => version + 1)
  }, [])
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

  const handleCanvasPointerMissed = useCallback((event: { ctrlKey?: boolean } | undefined) => {
    if (!shouldWorldsPointerMissClearSelection(event)) return
    if (collisionEditMode) {
      selectCollisionZoneFromCanvas(null)
      return
    }
    selectSceneItemFromCanvas(null)
  }, [collisionEditMode, selectCollisionZoneFromCanvas, selectSceneItemFromCanvas])

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
          collisionZones={collisionZones}
          selectedItemId={selectedItemId}
          selectedItemIds={selectedItemIds}
          collisionEditMode={collisionEditMode}
          selectedCollisionZoneId={selectedCollisionZoneId}
          mode={transformMode}
          onSelectItem={onSelectItem}
          onAddCollisionZone={onAddCollisionZone}
          onCollisionEditModeChange={onCollisionEditModeChange}
          onSelectCollisionZone={onSelectCollisionZone}
          onModeChange={onTransformModeChange}
          onRemoveItem={onRemoveItem}
          onRemoveCollisionZone={onRemoveCollisionZone}
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
        onPointerMissed={handleCanvasPointerMissed}
      >
        <color attach="background" args={['#18181b']} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[4, 6, 4]} intensity={1.2} />
        <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />
        <Bounds margin={1.25}>
          <Selection enabled={selectedItemIds.length > 0}>
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
                    onSceneItemAnchorChange={onSceneItemAnchorChange}
                    onAnimationMetadata={onAnimationMetadata}
                  />
                </Suspense>
              </WorldSceneItemErrorBoundary>
            ))}
            {collisionEditMode ? (
              <WorldCollisionZoneLayer
                collisionZones={collisionZones}
                selectedCollisionZoneId={selectedCollisionZoneId}
                transformMode={transformMode}
                draggingRef={transformDraggingRef}
                onSelectCollisionZone={selectCollisionZoneFromCanvas}
                onDragEndSelectionBlock={handleTransformDragEnd}
                onTransformCollisionZone={onTransformCollisionZone}
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
          {selectedObject && transformMode && !selectedCollisionZoneId ? (
            <WorldsTransformControls
              object={selectedObject}
              mode={transformMode}
              selectedItemId={selectedItemId}
              selectedItems={selectedItems}
              draggingRef={transformDraggingRef}
              onDragEndSelectionBlock={handleTransformDragEnd}
              onBoundsChange={invalidateSelectedBounds}
              onTransformItem={onTransformItem}
              onTransformItems={onTransformItems}
            />
          ) : null}
          <SceneFitController
            fitKey={sceneFitKey}
            resetToken={cameraState.resetToken}
            orbitControlsRef={orbitControlsRef}
            cameraFitSnapshotRef={cameraFitSnapshotRef}
          />
          <SceneFocusController
            focusRequest={focusRequest}
            orbitControlsRef={orbitControlsRef}
            sceneObjectsRef={sceneObjectsRef}
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
          items={visibleItems}
          collisionZones={collisionZones}
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
    return () => onRegisterObject(item.id, null)
  }, [invalidateBounds, item.id, onRegisterObject])

  useEffect(() => {
    return () => {
      lastAnchorRef.current = null
      onSceneItemAnchorChange(item.id, null)
    }
  }, [item.id, onSceneItemAnchorChange])

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
    if (current.userData.worldsCollisionZone === true) return null
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
    if (object.userData.worldsCollisionZone === true) return

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

function WorldCollisionZoneLayer({
  collisionZones,
  selectedCollisionZoneId,
  transformMode,
  draggingRef,
  onSelectCollisionZone,
  onDragEndSelectionBlock,
  onTransformCollisionZone,
}: {
  collisionZones: WorldCollisionZone[]
  selectedCollisionZoneId: string | null
  transformMode: WorldsTransformMode | null
  draggingRef: RefObject<boolean>
  onSelectCollisionZone: (zoneId: string | null) => void
  onDragEndSelectionBlock: () => void
  onTransformCollisionZone: (zoneId: string, transform: WorldCollisionZone['transform']) => void
}): JSX.Element | null {
  if (collisionZones.length === 0) return null

  return (
    <>
      {collisionZones.map((zone) => (
        <WorldCollisionZoneObject
          key={zone.id}
          zone={zone}
          selected={selectedCollisionZoneId === zone.id}
          transformMode={transformMode}
          draggingRef={draggingRef}
          onSelectCollisionZone={onSelectCollisionZone}
          onDragEndSelectionBlock={onDragEndSelectionBlock}
          onTransformCollisionZone={onTransformCollisionZone}
        />
      ))}
    </>
  )
}

function WorldCollisionZoneObject({
  zone,
  selected,
  transformMode,
  draggingRef,
  onSelectCollisionZone,
  onDragEndSelectionBlock,
  onTransformCollisionZone,
}: {
  zone: WorldCollisionZone
  selected: boolean
  transformMode: WorldsTransformMode | null
  draggingRef: RefObject<boolean>
  onSelectCollisionZone: (zoneId: string | null) => void
  onDragEndSelectionBlock: () => void
  onTransformCollisionZone: (zoneId: string, transform: WorldCollisionZone['transform']) => void
}): JSX.Element {
  const [zoneObject, setZoneObject] = useState<THREE.Mesh | null>(null)
  const syncZone = useCallback(() => {
    if (!zoneObject) return
    onTransformCollisionZone(zone.id, {
      position: zoneObject.position.toArray() as [number, number, number],
      rotation: [zoneObject.rotation.x, zoneObject.rotation.y, zoneObject.rotation.z],
      scale: zoneObject.scale.toArray().map((component) => Math.max(component, 0.05)) as [number, number, number],
    })
  }, [onTransformCollisionZone, zone.id, zoneObject])

  return (
    <>
      <mesh
        ref={setZoneObject}
        userData={{ worldsCollisionZone: true }}
        position={zone.transform.position}
        rotation={zone.transform.rotation}
        scale={zone.transform.scale}
        onClick={(event) => {
          event.stopPropagation()
          onSelectCollisionZone(zone.id)
        }}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={selected ? '#38bdf8' : '#f59e0b'} wireframe transparent opacity={selected ? 0.85 : 0.55} depthWrite={false} />
      </mesh>
      {selected && zoneObject && transformMode ? (
        <TransformControls
          object={zoneObject}
          mode={transformMode}
          space="local"
          onMouseDown={() => {
            draggingRef.current = true
          }}
          onMouseUp={() => {
            draggingRef.current = false
            onDragEndSelectionBlock()
            syncZone()
          }}
          onObjectChange={syncZone}
        />
      ) : null}
    </>
  )
}

function WorldSceneItemGeometry({ item, playbackRef, onAnimationMetadata, onBoundsChange }: { item: WorldSceneItem; playbackRef: MutableRefObject<WorldsPlaybackRef>; onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void; onBoundsChange: () => void }): JSX.Element | null {
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
    onBoundsChange()
    return () => {
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          ;(child.geometry as any).disposeBoundsTree?.()
        }
      })
    }
  }, [item.id, onBoundsChange, scene])
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
  draggingRef,
  onDragEndSelectionBlock,
  onBoundsChange,
  onTransformItem,
  onTransformItems,
}: {
  object: THREE.Object3D
  mode: WorldsTransformMode
  selectedItemId: string | null
  selectedItems: WorldSceneItem[]
  draggingRef: RefObject<boolean>
  onDragEndSelectionBlock: () => void
  onBoundsChange: () => void
  onTransformItem: (itemId: string, transform: WorldSceneItem['transform']) => void
  onTransformItems: (updates: WorldSceneItemTransformUpdate[]) => void
}): JSX.Element | null {
  const transformSnapshotRef = useRef<WorldSceneTransformSnapshot[] | null>(null)

  const createActiveTransform = useCallback((): WorldSceneItem['transform'] => ({
    position: object.position.toArray() as [number, number, number],
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: object.scale.toArray() as [number, number, number],
  }), [object])

  const takeSnapshot = useCallback(() => {
    transformSnapshotRef.current = selectedItems.map((item) => ({
      itemId: item.id,
      transform: item.id === selectedItemId
        ? createActiveTransform()
        : {
          position: [...item.transform.position],
          rotation: [...item.transform.rotation],
          scale: [...item.transform.scale],
        },
    }))
  }, [createActiveTransform, selectedItemId, selectedItems])

  useEffect(() => {
    if (!shouldResetWorldsTransformSnapshot(draggingRef.current)) return
    transformSnapshotRef.current = null
  }, [draggingRef, mode, object, selectedItemId, selectedItems])

  const syncTransform = useCallback(() => {
    if (!selectedItemId) return
    const activeTransform = createActiveTransform()
    const snapshot = transformSnapshotRef.current
    if (!isWorldsBatchTransformSnapshot(snapshot)) {
      onTransformItem(selectedItemId, activeTransform)
      return
    }

    onTransformItems(createWorldSceneSelectionTransformUpdates({
      mode,
      activeItemId: selectedItemId,
      snapshot,
      activeTransform,
    }))
  }, [createActiveTransform, mode, onTransformItem, onTransformItems, selectedItemId])

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
        syncTransform()
        onBoundsChange()
        transformSnapshotRef.current = null
      }}
      onObjectChange={() => {
        if (!transformSnapshotRef.current) takeSnapshot()
        syncTransform()
        onBoundsChange()
      }}
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

function SceneFocusController({
  focusRequest,
  orbitControlsRef,
  sceneObjectsRef,
}: {
  focusRequest: { itemId: string; token: number } | null
  orbitControlsRef: RefObject<WorldsOrbitControlsHandle | null>
  sceneObjectsRef: MutableRefObject<Map<string, THREE.Object3D>>
}): null {
  const { camera } = useThree()

  useEffect(() => {
    if (!focusRequest) return
    const object = sceneObjectsRef.current.get(focusRequest.itemId)
    const controls = orbitControlsRef.current
    if (!object || !controls) return
    focusWorldsCameraOnObject(camera, controls, object)
  }, [camera, focusRequest, orbitControlsRef, sceneObjectsRef])

  return null
}

export function focusWorldsCameraOnObject(camera: THREE.Camera, controls: WorldsOrbitControlsHandle, target: THREE.Object3D): boolean {
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
  camera.position.copy(bounds.center).addScaledVector(worldsFitDirection, distance)
  controls.target.copy(bounds.center)
  camera.updateMatrixWorld()
  controls.update()
  return true
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
