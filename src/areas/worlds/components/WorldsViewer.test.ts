import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as THREE from 'three'

import type { WorldSceneItem } from '../worldRenderableResolver.ts'
import { normalizeWorldSceneCollisionSurfaces } from '../worldCameraNavigation.ts'
import { createWorldCollisionSurfacePreset } from '../worldsCollisionSurfaces.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const worldsRoot = path.join(projectRoot, 'src/areas/worlds')
const viewerEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsViewer.tsx')
const cameraOverlayEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsCameraOverlay.tsx')
const keyboardControlsEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsKeyboardCameraControls.tsx')
const mouseLookControlsEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsMouseLookCameraControls.tsx')
const meshFixture = path.join(projectRoot, 'src/areas/worlds/__fixtures__/colored-mesh.ply')
const pointsFixture = path.join(projectRoot, 'src/areas/worlds/__fixtures__/colored-points.ply')

async function loadViewerModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-viewer-test-'))
  const outfile = path.join(tempDir, 'WorldsViewer.bundle.mjs')
  const result = await build({
    entryPoints: [viewerEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: [],
  })
  const source = result.outputFiles[0].text
  await writeFile(outfile, source)
  return {
    source,
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

function item(kind: WorldSceneItem['kind'], url: string): WorldSceneItem {
  return {
    id: `world:${url}`,
    workspacePath: url,
    url,
    kind,
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }
}

test('WorldsViewer parses vertex-color indexed PLY as a mesh render model', async () => {
  const { module, cleanup } = await loadViewerModule()
  const bytes = await readFile(meshFixture)

  try {
    const model = module.createPlyRenderModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), item('ply-mesh', 'mesh.ply'))

    assert.deepEqual(
      {
        primitive: model.primitive,
        hasVertexColors: model.hasVertexColors,
        material: model.material,
        viewerNormalization: model.viewerNormalization,
        vertexCount: model.geometry.getAttribute('position').count,
        indexCount: model.geometry.index?.count,
        minY: model.geometry.boundingBox?.min.y,
        centerX: ((model.geometry.boundingBox?.min.x ?? 0) + (model.geometry.boundingBox?.max.x ?? 0)) / 2,
        centerZ: ((model.geometry.boundingBox?.min.z ?? 0) + (model.geometry.boundingBox?.max.z ?? 0)) / 2,
      },
      {
        primitive: 'mesh',
        hasVertexColors: true,
        material: 'standard-vertex-color',
        viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered',
        vertexCount: 3,
        indexCount: 3,
        minY: 0,
        centerX: 0,
        centerZ: 0,
      },
    )
  } finally {
    await cleanup()
  }
})

test('WorldsViewer parses vertex-color non-indexed PLY as a points render model', async () => {
  const { module, cleanup } = await loadViewerModule()
  const bytes = await readFile(pointsFixture)

  try {
    const model = module.createPlyRenderModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), item('ply-points', 'points.ply'))

    assert.deepEqual(
      {
        primitive: model.primitive,
        hasVertexColors: model.hasVertexColors,
        material: model.material,
        pointSize: model.pointSize,
        viewerNormalization: model.viewerNormalization,
        vertexCount: model.geometry.getAttribute('position').count,
        indexCount: model.geometry.index?.count ?? 0,
        minY: model.geometry.boundingBox?.min.y,
      },
      {
        primitive: 'points',
        hasVertexColors: true,
        material: 'points-vertex-color',
        pointSize: 0.025,
        viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered',
        vertexCount: 3,
        indexCount: 0,
        minY: 0,
      },
    )
  } finally {
    await cleanup()
  }
})

test('WorldsViewer exposes unified mouse and keyboard controls without importing Generate Viewer3D', async () => {
  const { source, module, cleanup } = await loadViewerModule()

  try {
    assert.equal(source.includes('components/Viewer3D'), false)
    assert.equal(source.includes('Viewer3D'), false)
    assert.equal(source.includes('Open a workflow world or renderable PLY/GLB asset.'), false)
    assert.equal(source.includes('top-14'), true)
    assert.deepEqual(module.WORLD_VIEWER_ORBIT_CONTROLS, {
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
    })
    assert.equal((await readFile(viewerEntry, 'utf8')).includes('PointerLockControls'), false)
    assert.deepEqual(module.describeWorldsViewerScene([item('ply-mesh', 'mesh.ply')]), {
      hasRenderableItems: true,
      hasGrid: true,
      hasOrbitControls: true,
      hasUnifiedKeyboardMovement: true,
      hasGizmo: true,
      hasSelection: false,
      selectedItemId: null,
      selectedItemIds: [],
      transformControls: null,
      unsupported: [],
      renderTargets: [
        {
          workspacePath: 'mesh.ply',
          kind: 'ply-mesh',
          loader: 'ply',
          primitive: 'mesh',
          cameraFit: 'bounds',
          visibleDescription: 'PLY mesh geometry',
        },
      ],
    })
    assert.deepEqual(module.describeWorldsViewerScene([{ ...item('ply-mesh', 'mesh.ply'), visible: false }]), {
      hasRenderableItems: false,
      hasGrid: true,
      hasOrbitControls: true,
      hasUnifiedKeyboardMovement: true,
      hasGizmo: true,
      hasSelection: false,
      selectedItemId: null,
      selectedItemIds: [],
      transformControls: null,
      unsupported: [],
      renderTargets: [],
    })
  } finally {
    await cleanup()
  }
})

test('WorldsViewer routes GLB and GLTF scene items through the GLTF render target with visible controls', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const glbItem = item('glb', 'workflows/world.glb')
    const gltfItem = item('gltf', 'workflows/world.gltf')

    assert.deepEqual(module.getWorldSceneItemRenderTarget(glbItem), {
      workspacePath: 'workflows/world.glb',
      kind: 'glb',
      loader: 'gltf',
      primitive: 'scene',
      cameraFit: 'bounds',
      visibleDescription: 'GLB/GLTF model scene',
    })
    assert.deepEqual(module.getWorldSceneItemRenderTarget(gltfItem), {
      workspacePath: 'workflows/world.gltf',
      kind: 'gltf',
      loader: 'gltf',
      primitive: 'scene',
      cameraFit: 'bounds',
      visibleDescription: 'GLB/GLTF model scene',
    })
    assert.deepEqual(module.describeWorldsViewerScene([glbItem, gltfItem]), {
      hasRenderableItems: true,
      hasGrid: true,
      hasOrbitControls: true,
      hasUnifiedKeyboardMovement: true,
      hasGizmo: true,
      hasSelection: false,
      selectedItemId: null,
      selectedItemIds: [],
      transformControls: null,
      unsupported: [],
      renderTargets: [
        {
          workspacePath: 'workflows/world.glb',
          kind: 'glb',
          loader: 'gltf',
          primitive: 'scene',
          cameraFit: 'bounds',
          visibleDescription: 'GLB/GLTF model scene',
        },
        {
          workspacePath: 'workflows/world.gltf',
          kind: 'gltf',
          loader: 'gltf',
          primitive: 'scene',
          cameraFit: 'bounds',
          visibleDescription: 'GLB/GLTF model scene',
        },
      ],
    })
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps Gaussian PLY experimental, disabled by default, and lazily loaded', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    const gaussianItem = item('gaussian-ply', 'workflows/gaussian.ply')

    assert.deepEqual(module.getWorldSceneItemRenderTarget(gaussianItem), {
      workspacePath: 'workflows/gaussian.ply',
      kind: 'gaussian-ply',
      loader: 'gaussian-ply',
      primitive: 'gaussian-splats',
      cameraFit: 'bounds',
      visibleDescription: 'Gaussian PLY splats',
    })
    assert.deepEqual(module.describeWorldsViewerScene([gaussianItem]).renderTargets, [{
      workspacePath: 'workflows/gaussian.ply',
      kind: 'gaussian-ply',
      loader: 'gaussian-ply',
      primitive: 'gaussian-splats',
      cameraFit: 'bounds',
      visibleDescription: 'Gaussian PLY splats',
    }])
    assert.equal(viewerSource.includes("import { WorldsGaussianPlyObject } from './WorldsGaussianPlyObject.tsx'"), false)
    assert.equal(viewerSource.includes("const module = await import('./WorldsGaussianPlyObject.tsx')"), true)
    assert.equal(viewerSource.includes("item.kind === 'gaussian-ply'"), true)
    assert.equal(viewerSource.includes('isWorldsGaussianPlyEnabled'), true)
    assert.equal(viewerSource.includes('if (!isWorldsGaussianPlyEnabled()) return null'), true)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps camera navigation state local with pan zoom look and keyboard controls', async () => {
  const { source, module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.deepEqual(module.WORLD_VIEWER_CAMERA_NAVIGATION, {
      orbitControls: 'always-enabled',
      keyboardMovement: 'focused-viewer-scope',
    })
    assert.equal(viewerSource.includes('pointerLock'), false)
    assert.equal(viewerSource.includes('useState(() => createWorldsCameraState())'), true)
    assert.equal(source.includes('WorldsKeyboardCameraControls'), true)
    assert.equal(source.includes('WorldsMouseLookCameraControls'), true)
    assert.equal(source.includes('WorldsCameraCollisionController'), false)
    assert.equal(source.includes('WorldsFlyCameraControls'), false)
    assert.equal(viewerSource.includes("enabled={cameraState.mode === 'orbit'}"), false)
    assert.equal(viewerSource.includes("enabled={cameraState.mode === 'fly'}"), false)
    assert.equal(viewerSource.includes('<OrbitControls'), true)
    assert.equal(viewerSource.includes('PointerLockControls'), false)
    assert.equal(viewerSource.includes('makeDefault'), true)
    assert.equal(viewerSource.includes('enableDamping'), true)
    assert.equal(viewerSource.includes('enableRotate={WORLD_VIEWER_ORBIT_CONTROLS.enableRotate}'), true)
    assert.equal(viewerSource.includes('cameraCollisionSyncRef'), false)
    assert.equal(viewerSource.includes('<WorldsCameraCollisionController'), false)
    assert.equal(viewerSource.indexOf('<OrbitControls') < viewerSource.indexOf('<WorldsKeyboardCameraControls'), true)
    assert.equal(viewerSource.indexOf('<WorldsKeyboardCameraControls') < viewerSource.indexOf('<WorldsMouseLookCameraControls'), true)
    assert.equal(viewerSource.includes('WorldSceneItem') && viewerSource.includes('cameraState:'), false)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer pose playback uses useFrame refs instead of setInterval React state churn', async () => {
  const viewerSource = await readFile(viewerEntry, 'utf8')

  assert.equal(viewerSource.includes('setInterval'), false)
  assert.equal(viewerSource.includes('WorldsPlaybackFrameController'), true)
  assert.equal(viewerSource.includes('useFrame((_, delta)'), true)
  assert.equal(viewerSource.includes('playbackRef'), true)
})

test('WorldsKeyboardCameraControls uses scoped key refs, useFrame movement, and yaws by rotating the look target in place', async () => {
  const { source, module, cleanup } = await loadViewerModule()
  const keyboardControlsSource = await readFile(keyboardControlsEntry, 'utf8')
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(typeof module.WorldsKeyboardCameraControls, 'function')
    assert.equal(keyboardControlsSource.includes('PointerLockControls'), false)
    assert.equal(keyboardControlsSource.includes('<PointerLockControls'), false)
    assert.equal(keyboardControlsSource.includes('selector={pointerLockSelector}'), false)
    assert.equal(keyboardControlsSource.includes('gl.domElement.addEventListener'), false)
    assert.equal(keyboardControlsSource.includes("'pointerdown'"), false)
    assert.equal(keyboardControlsSource.includes("'pointermove'"), false)
    assert.equal(keyboardControlsSource.includes("'pointerup'"), false)
    assert.equal(keyboardControlsSource.includes('clampWorldsCameraPitch'), false)
    assert.equal(keyboardControlsSource.includes('cameraState.mode'), false)
    assert.equal(keyboardControlsSource.includes("import { useFrame } from '@react-three/fiber'"), true)
    assert.equal(keyboardControlsSource.includes('useFrame('), true)
    assert.equal(keyboardControlsSource.includes('shouldHandleWorldCameraKeyInput'), true)
    assert.equal(keyboardControlsSource.includes('updateWorldsMovementKeys'), true)
    assert.equal(keyboardControlsSource.includes('applyWorldsKeyboardCameraPose'), true)
    assert.equal(keyboardControlsSource.includes("isWorldCameraRotationKey(code: string): code is 'KeyQ' | 'KeyE'"), true)
    assert.equal(keyboardControlsSource.includes("rotationKeysRef.current = updateWorldsRotationKeys(rotationKeysRef.current, event.code, true)"), true)
    assert.equal(keyboardControlsSource.includes('rotateWorldsCameraYawTarget'), false)
    assert.equal(keyboardControlsSource.includes('camera.getWorldDirection(lookDirectionVector)'), false)
    assert.equal(keyboardControlsSource.includes('applyWorldsKeyboardCameraPose({'), true)
    assert.equal(keyboardControlsSource.includes('camera.position.copy(orbitControlsRef.current.target).add('), false)
    assert.equal(keyboardControlsSource.includes('orbitOffsetVector.copy(camera.position).sub(orbitControlsRef.current.target)'), false)
    assert.equal(keyboardControlsSource.includes('activeElement: document.activeElement'), true)
    assert.equal(keyboardControlsSource.includes('resolveWorldCollisionProbeTranslation({'), false)
    assert.equal(keyboardControlsSource.includes('camera.position.set(nextPose.cameraPosition.x'), true)
    assert.equal(keyboardControlsSource.includes('controls.target.set(nextPose.target.x'), true)
    assert.equal(keyboardControlsSource.includes('controls.update()'), true)
    assert.equal(keyboardControlsSource.includes('poseSyncRef?.current?.syncCurrentPose()'), false)
    assert.equal(viewerSource.includes('ref={orbitControlsRef}'), true)
    assert.equal(viewerSource.includes('enabled={cameraState.mode === \'fly\'}'), false)
    assert.equal(viewerSource.includes('enabled={!cameraState.pointerLocked}'), false)
    assert.equal(viewerSource.includes('pointerLocked: false'), false)
    assert.equal(viewerSource.includes('Mouse look'), false)
    assert.equal(viewerSource.includes('Pointer lock'), false)
    assert.equal(viewerSource.includes('Esc releases'), false)
    assert.equal(viewerSource.includes('setPointerLockRequested(true)'), false)
    assert.equal(viewerSource.includes('pointerLockSelector'), false)
    assert.equal(viewerSource.includes('onPointerLockChange'), false)
  } finally {
    await cleanup()
  }
})

test('WorldsMouseLookCameraControls handles only left-drag look without pointer lock or OrbitControls left-rotate', async () => {
  const { module, cleanup } = await loadViewerModule()
  const mouseLookControlsSource = await readFile(mouseLookControlsEntry, 'utf8')
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(typeof module.WorldsMouseLookCameraControls, 'function')
    assert.equal(mouseLookControlsSource.includes('PointerLockControls'), false)
    assert.equal(mouseLookControlsSource.includes('pointerLock'), false)
    assert.equal(mouseLookControlsSource.includes('event.button !== 0'), true)
    assert.equal(mouseLookControlsSource.includes("canvas.addEventListener('pointerdown', handlePointerDown, { capture: true })"), true)
    assert.equal(mouseLookControlsSource.includes('LOOK_DRAG_START_THRESHOLD_PX'), true)
    assert.equal(mouseLookControlsSource.includes('pendingPointerRef'), true)
    assert.equal(mouseLookControlsSource.includes('event.stopImmediatePropagation()'), true)
    assert.equal(mouseLookControlsSource.includes('pendingPointerRef.current = {'), true)
    assert.equal(mouseLookControlsSource.includes('if (dragDistance < LOOK_DRAG_START_THRESHOLD_PX) return'), true)
    assert.equal(mouseLookControlsSource.includes('camera.quaternion.setFromEuler'), true)
    assert.equal(mouseLookControlsSource.includes('controls.target.copy'), true)
    assert.equal(mouseLookControlsSource.includes('poseSyncRef?.current?.syncCurrentPose()'), false)
    assert.equal(mouseLookControlsSource.includes('WORLD_CAMERA_LOOK_PITCH_LIMIT'), true)
    assert.equal(viewerSource.includes('enableRotate: false'), true)
    assert.equal(viewerSource.includes('<WorldsMouseLookCameraControls'), true)
    assert.equal(viewerSource.includes('enabled={!transformMode && !transformDraggingRef.current}'), true)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer exposes selection state and a local transform toolbar contract', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.deepEqual(module.WORLD_VIEWER_TRANSFORM_CONTROLS, {
      modes: ['translate', 'rotate', 'scale'],
      placement: 'right-canvas-toolbar',
      disabledUntilSelection: true,
      backendBake: false,
    })
    assert.deepEqual(module.describeWorldsViewerScene([item('ply-mesh', 'mesh.ply')], [], 'world:mesh.ply', ['world:mesh.ply', 'world:ghost.ply']), {
      hasRenderableItems: true,
      hasGrid: true,
      hasOrbitControls: true,
      hasUnifiedKeyboardMovement: true,
      hasGizmo: true,
      hasSelection: true,
      selectedItemId: 'world:mesh.ply',
      selectedItemIds: ['world:mesh.ply'],
      transformControls: {
        modes: ['translate', 'rotate', 'scale'],
        attachedItemId: 'world:mesh.ply',
      },
      unsupported: [],
      renderTargets: [
        {
          workspacePath: 'mesh.ply',
          kind: 'ply-mesh',
          loader: 'ply',
          primitive: 'mesh',
          cameraFit: 'bounds',
          visibleDescription: 'PLY mesh geometry',
        },
      ],
    })
    assert.equal(viewerSource.includes('WorldsTransformToolbar'), true)
    assert.equal(viewerSource.includes('items={visibleItems}'), true)
    assert.equal(viewerSource.includes('const resolvedCollisionSurfaces = useMemo('), true)
    assert.equal(viewerSource.includes('collisionSurfaces={resolvedCollisionSurfaces}'), true)
    assert.equal(viewerSource.includes('collisionEditMode={collisionEditMode}'), true)
    assert.equal(viewerSource.includes('selectedCollisionSurfaceId={selectedCollisionSurfaceId}'), true)
    assert.equal(viewerSource.includes('selectedItemIds={normalizedSelectedItemIds}'), true)
    assert.equal(viewerSource.includes('onAddCollisionSurface={onAddCollisionSurface}'), true)
    assert.equal(viewerSource.includes('onCollisionEditModeChange={onCollisionEditModeChange}'), true)
    assert.equal(viewerSource.includes('onSelectCollisionSurface={onSelectCollisionSurface}'), true)
    assert.equal(viewerSource.includes('const selectCollisionSurfaceFromCanvas = useCallback((surfaceId: string | null) => {'), true)
    assert.equal(viewerSource.includes('onSelectCollisionSurface(surfaceId)'), true)
    assert.equal(viewerSource.includes('WorldCollisionSurfaceLayer'), true)
    assert.equal(viewerSource.includes('onTransformSurface={onTransformCollisionSurface}'), true)
    assert.equal(viewerSource.includes('const selectedItems = useMemo(() => visibleItems.filter((item) => selectedItemIdSet.has(item.id))'), true)
    assert.equal(viewerSource.includes('onRemoveItem={onRemoveItem}'), true)
    assert.equal(viewerSource.includes('onRemoveCollisionSurface={onRemoveCollisionSurface}'), true)
    assert.equal(viewerSource.includes('onToggleBaseSceneItem={onToggleBaseSceneItem}'), true)
    assert.equal(viewerSource.includes('onSceneItemAnchorChange={onSceneItemAnchorChange}'), true)
    assert.equal(viewerSource.includes('setFocusRequest'), true)
    assert.equal(viewerSource.includes('focusSceneItemFromCanvas'), true)
    assert.equal(viewerSource.includes('boundsRef.current.setFromObject(groupRef.current)'), false)
    assert.equal(viewerSource.includes('TransformControls'), true)
    assert.equal(viewerSource.includes('transformDraggingRef'), true)
    assert.equal(viewerSource.includes('if (transformDraggingRef.current) return'), true)
    assert.equal(viewerSource.includes('suppressSelectionUntilRef'), true)
    assert.equal(viewerSource.includes('Date.now() < suppressSelectionUntilRef.current'), true)
    assert.equal(viewerSource.includes('selectedItems={selectedItems}'), true)
    assert.equal(viewerSource.includes('onTransformItems={onTransformItems}'), true)
    assert.equal(viewerSource.includes('onTransformCollisionSurface = () => undefined'), true)
    assert.equal(viewerSource.includes('createWorldSceneSelectionTransformUpdates'), true)
    assert.equal(viewerSource.includes('const dragSessionRef = useRef<{'), true)
    assert.equal(viewerSource.includes('lastValidTransforms: WorldSceneItemTransformUpdate[]'), true)
    assert.equal(viewerSource.includes('localBoundsByItemId: Map<string, WorldsCollisionBounds | null>'), true)
    assert.equal(viewerSource.includes('const sceneItemLocalBoundsRef = useRef(new Map<string, WorldsCollisionBounds | null>())'), true)
    assert.equal(viewerSource.includes("import { resolveWorldsSurfacePlacement } from '../worldsSurfacePlacement.ts'"), true)
    assert.equal(viewerSource.includes('export function resolveWorldsTransformPreview({'), true)
    assert.equal(viewerSource.includes('export function isWorldsBatchTransformSnapshot(snapshot: WorldSceneTransformSnapshot[] | null)'), true)
    assert.equal(viewerSource.includes('if (!shouldResetWorldsTransformSnapshot(draggingRef.current)) return'), true)
    assert.equal(viewerSource.includes('collisionSafe: true'), true)
    assert.equal(viewerSource.includes('collisionSafe: false'), true)
    assert.equal(viewerSource.includes('session.lastValidTransforms = preview.updates.map(cloneTransformUpdate)'), true)
    assert.equal(viewerSource.includes('takeSnapshot()'), true)
    assert.equal(viewerSource.includes('onDragEndSelectionBlock={handleTransformDragEnd}'), true)
    assert.equal(viewerSource.includes('onDragEndSelectionBlock()'), true)
    assert.equal(viewerSource.includes('previewTransform()'), true)
    assert.equal(viewerSource.includes('commitTransform()'), true)
    assert.equal(viewerSource.includes('collisionSurfaces={resolvedCollisionSurfaces}'), true)
    assert.equal(viewerSource.includes('collisionSurfaces: [...collisionSurfaces]'), true)
    assert.equal(viewerSource.includes('resolveWorldsSceneItemIdFromIntersections'), true)
    assert.equal(viewerSource.includes('onDoubleClick={handleDoubleClick}'), true)
    assert.equal(viewerSource.includes('<SceneFocusController'), true)
    assert.equal(viewerSource.includes('focusWorldsCameraOnObject'), true)
    assert.equal(viewerSource.includes('BoxHelper'), false)
    assert.equal(viewerSource.includes('EffectComposer'), true)
    assert.equal(viewerSource.includes('Outline'), true)
    assert.equal(viewerSource.includes('resolutionScale={WORLD_SELECTION_OUTLINE_RESOLUTION_SCALE}'), true)
    assert.equal(viewerSource.includes('xRay={false}'), true)
    assert.equal(viewerSource.includes('autoClear={false}'), false)
    assert.equal(viewerSource.includes('WorldsSelectionSilhouette'), true)
    assert.equal(viewerSource.includes('selectedSceneObjects.secondaryObjects.map'), true)
    assert.equal(viewerSource.includes('resolveWorldsSelectedSceneObjects(sceneObjectsRef.current, normalizedSelectedItemIds, selectedItemId)'), true)
    assert.equal(viewerSource.includes('WORLD_SELECTION_SECONDARY_SILHOUETTE_COLOR'), true)
    assert.equal(viewerSource.includes('WORLD_SELECTION_ACTIVE_SILHOUETTE_COLOR'), true)
    assert.equal(viewerSource.includes('THREE.BackSide'), true)
    assert.equal(viewerSource.includes('child instanceof THREE.Points'), true)
    assert.equal(viewerSource.includes('new THREE.PointsMaterial({'), true)
    assert.equal(viewerSource.includes('worldsSelectionSilhouette'), true)
    assert.equal(viewerSource.includes('Select enabled={selected}'), true)
    assert.equal(viewerSource.includes('toggle: isWorldsMultiSelectToggleGesture(event.nativeEvent)'), true)
    assert.equal(viewerSource.includes('computeBoundsTree'), true)
    assert.equal(viewerSource.includes('acceleratedRaycast'), true)
    assert.equal(viewerSource.includes('SkeletonUtils'), true)
    assert.equal(viewerSource.includes('createWorldsGltfSceneInstance(gltf.scene)'), true)
    assert.equal(viewerSource.includes('cloneWorldsSceneMaterialsForInstance(scene)'), true)
    assert.equal(viewerSource.includes('clone.side = THREE.DoubleSide'), true)
    assert.equal(viewerSource.includes('WorldsSelectionHitbox'), true)
    assert.equal(viewerSource.includes('worldsSelectionHitbox'), true)
    assert.equal(viewerSource.includes('worldsCollisionSurface'), true)
    assert.equal(viewerSource.includes('onSelect()'), false)
    assert.equal(viewerSource.includes('calculateWorldsSelectionBounds'), true)
    assert.equal(viewerSource.includes('measureWorldsObjectBounds'), true)
    assert.equal(viewerSource.includes('const [selectedBoundsVersion, setSelectedBoundsVersion] = useState(0)'), true)
    assert.equal(viewerSource.includes('boundsVersion={item.id === selectedItemId ? selectedBoundsVersion : 0}'), true)
    assert.equal(viewerSource.includes('onBoundsChange={invalidateSelectedBounds}'), true)
    assert.equal(viewerSource.includes('useFrame(() => {\n    const hitbox = hitboxRef.current'), false)
    assert.equal(viewerSource.includes('useFrame(() => {\n    if (!groupRef.current) return'), false)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps batch transform snapshots alive during drag and only batches multi-item snapshots', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.equal(module.shouldResetWorldsTransformSnapshot(true), false)
    assert.equal(module.shouldResetWorldsTransformSnapshot(false), true)
    assert.equal(module.isWorldsBatchTransformSnapshot(null), false)
    assert.equal(module.isWorldsBatchTransformSnapshot([]), false)
    assert.equal(module.isWorldsBatchTransformSnapshot([{ itemId: 'world:active', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }]), false)
    assert.equal(module.isWorldsBatchTransformSnapshot([
      { itemId: 'world:active', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { itemId: 'world:secondary', transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    ]), true)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer resolves floor wall and ramp previews through planar surface placement', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const floor = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('floor', {
      id: 'floor',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const floorPreview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0.7, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0, 0.7, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: floor,
    })

    assert.equal(floorPreview.valid, true)
    assert.equal(floorPreview.reason, 'snapped')
    assert.equal(floorPreview.snappedSurfaceId, 'floor')
    assert.equal(floorPreview.collisionSafe, true)
    assert.ok(Math.abs(floorPreview.updates[0]!.transform.position[1] - 0.5001) < 5e-4)

    const wall = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('wall', {
      id: 'wall',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const wallPreview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0, -0.75], rotation: [0, 0.25, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0, 0, -0.75], rotation: [0, 0.25, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: wall,
    })

    assert.equal(wallPreview.valid, true)
    assert.equal(wallPreview.reason, 'snapped')
    assert.equal(wallPreview.snappedSurfaceId, 'wall')
    assert.ok(wallPreview.updates[0]!.transform.position[2] > -0.76)
    assert.ok(wallPreview.updates[0]!.transform.position[2] < -0.45)
    assert.equal(wallPreview.updates[0]?.transform.rotation[1], 0.25)

    const ramp = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('ramp', {
      id: 'ramp',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const rampPreview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: ramp,
    })

    assert.equal(rampPreview.valid, true)
    assert.equal(rampPreview.reason, 'snapped')
    assert.equal(rampPreview.snappedSurfaceId, 'ramp')
    assert.ok(Math.abs(rampPreview.correctionDelta[1]) > 0.05)
    assert.ok(Math.abs(rampPreview.correctionDelta[2]) > 0.05)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer snaps translate previews to base-scene mesh support within drag threshold', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const active = item('glb', 'active.glb')
    active.id = 'active'
    const base = item('glb', 'base.glb')
    base.id = 'base'
    base.role = 'base-scene'
    const preview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: [],
      sceneItems: [active, base],
      sceneObjects: new Map([
        ['base', createRootWithMesh(createTriangleMesh([
          [0, 0, 0],
          [2, 0, 0],
          [0, 0, 2],
        ]))],
      ]),
    })

    assert.equal(preview.valid, true)
    assert.equal(preview.reason, 'snapped')
    assert.ok(Math.abs(preview.updates[0]!.transform.position[1] - 0.5001) < 5e-4)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps translate previews unchanged when base support exceeds the drag snap threshold', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const active = item('glb', 'active.glb')
    active.id = 'active'
    const base = item('glb', 'base.glb')
    base.id = 'base'
    base.role = 'base-scene'
    const preview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0.25, 1.2, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0.25, 1.2, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: [],
      sceneItems: [active, base],
      sceneObjects: new Map([
        ['base', createRootWithMesh(createTriangleMesh([
          [0, 0, 0],
          [2, 0, 0],
          [0, 0, 2],
        ]))],
      ]),
    })

    assert.equal(preview.valid, true)
    assert.equal(preview.reason, 'free')
    assert.deepEqual(preview.updates[0]!.transform.position, [0.25, 1.2, 0.25])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer applies one shared base-scene correction during multi-select translate and preserves offsets', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const active = item('glb', 'active.glb')
    active.id = 'active'
    const secondary = item('glb', 'secondary.glb')
    secondary.id = 'secondary'
    const base = item('glb', 'base.glb')
    base.id = 'base'
    base.role = 'base-scene'
    const preview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [
        { itemId: 'active', transform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { itemId: 'secondary', transform: { position: [1.75, 0.87, 0.25], rotation: [0, 0.3, 0], scale: [1, 1, 1] } },
      ],
      activeTransform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
        ['secondary', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: [],
      sceneItems: [active, secondary, base],
      sceneObjects: new Map([
        ['base', createRootWithMesh(createTriangleMesh([
          [0, 0, 0],
          [3, 0, 0],
          [0, 0, 3],
        ]))],
      ]),
    })

    assert.equal(preview.valid, true)
    assert.equal(preview.reason, 'snapped')
    assert.deepEqual([
      Number((preview.updates[1]!.transform.position[0] - preview.updates[0]!.transform.position[0]).toFixed(4)),
      Number((preview.updates[1]!.transform.position[1] - preview.updates[0]!.transform.position[1]).toFixed(4)),
      Number((preview.updates[1]!.transform.position[2] - preview.updates[0]!.transform.position[2]).toFixed(4)),
    ], [1.5, 0.25, 0])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps authored blockers authoritative and skips base support for rotate scale or missing base meshes', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const floor = item('glb', 'base.glb')
    floor.id = 'base'
    floor.role = 'base-scene'
    const active = item('glb', 'active.glb')
    active.id = 'active'
    const wall = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('wall', {
      id: 'wall',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])

    const blockedTranslate = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0.62, -1], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0, 0.62, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: wall,
      sceneItems: [active, floor],
      sceneObjects: new Map([
        ['base', createRootWithMesh(createTriangleMesh([
          [0, 0, 0],
          [3, 0, 0],
          [0, 0, 3],
        ]))],
      ]),
    })
    assert.equal(blockedTranslate.reason, 'blocked')
    assert.ok(Math.abs(blockedTranslate.updates[0]!.transform.position[2] + 0.5001) < 5e-4)

    const rotatePreview = module.resolveWorldsTransformPreview({
      mode: 'rotate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0.25, 0.62, 0.25], rotation: [0, 0.4, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: [],
      sceneItems: [active, floor],
      sceneObjects: new Map([
        ['base', createRootWithMesh(createTriangleMesh([
          [0, 0, 0],
          [2, 0, 0],
          [0, 0, 2],
        ]))],
      ]),
    })
    assert.deepEqual(rotatePreview.updates[0]!.transform.position, [0.25, 0.62, 0.25])

    const noBasePreview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: [],
      sceneItems: [active],
      sceneObjects: new Map(),
    })
    assert.deepEqual(noBasePreview.updates[0]!.transform.position, [0.25, 0.62, 0.25])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer blocks unsafe translate rotate and scale previews while preserving the last valid pose', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const wall = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('wall', {
      id: 'wall',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const translatePreview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0, -1], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: wall,
    })
    assert.equal(translatePreview.valid, true)
    assert.equal(translatePreview.reason, 'blocked')
    assert.ok(Math.abs(translatePreview.updates[0]!.transform.position[2] + 0.5001) < 5e-4)

    const rotatePreview = module.resolveWorldsTransformPreview({
      mode: 'rotate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0, -0.35], rotation: [0, 0, 0], scale: [1, 1, 0.2] } }],
      activeTransform: { position: [0, 0, -0.35], rotation: [0, Math.PI / 4, 0], scale: [1, 1, 0.2] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -1, y: -0.5, z: -0.2 }, max: { x: 1, y: 0.5, z: 0.2 } }],
      ]),
      collisionSurfaces: wall,
    })
    assert.equal(rotatePreview.valid, false)
    assert.equal(rotatePreview.reason, 'blocked')
    assert.deepEqual(rotatePreview.updates[0]?.transform.rotation, [0, 0, 0])
    assert.equal(rotatePreview.snappedZoneId, null)

    const blockedScalePreview = module.resolveWorldsTransformPreview({
      mode: 'scale',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0, -0.4], rotation: [0, 0, 0], scale: [1, 1, 0.2] } }],
      activeTransform: { position: [0, 0, -0.4], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: wall,
    })
    assert.equal(blockedScalePreview.valid, false)
    assert.equal(blockedScalePreview.reason, 'blocked')
    assert.deepEqual(blockedScalePreview.updates[0]?.transform.scale, [1, 1, 0.2])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps multi-select previews on one shared resolved transform set', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const wall = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('wall', {
      id: 'wall',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const preview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [
        { itemId: 'active', transform: { position: [0, 0, -1], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { itemId: 'secondary', transform: { position: [1.5, 0.25, -1], rotation: [0, 0.3, 0], scale: [1, 1, 1] } },
      ],
      activeTransform: { position: [0.5, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
        ['secondary', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: wall,
    })

    assert.equal(preview.valid, true)
    assert.equal(preview.reason, 'blocked')
    assert.deepEqual(preview.updates.map((entry: { itemId: string }) => entry.itemId), ['active', 'secondary'])
    assert.deepEqual([
      Number((preview.updates[1]!.transform.position[0] - preview.updates[0]!.transform.position[0]).toFixed(4)),
      Number((preview.updates[1]!.transform.position[1] - preview.updates[0]!.transform.position[1]).toFixed(4)),
      Number((preview.updates[1]!.transform.position[2] - preview.updates[0]!.transform.position[2]).toFixed(4)),
    ], [1.5, 0.25, 0])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer falls back deterministically when bounds are missing instead of freezing preview', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const wall = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('wall', {
      id: 'wall',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const preview = module.resolveWorldsTransformPreview({
      mode: 'scale',
      activeItemId: 'active',
      snapshot: [
        { itemId: 'active', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { itemId: 'secondary', transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
      activeTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 1] },
      localBoundsByItemId: new Map(),
      collisionSurfaces: wall,
    })

    assert.equal(preview.valid, true)
    assert.equal(preview.reason, 'free')
    assert.equal(preview.collisionSafe, false)
    assert.deepEqual(preview.updates[1]?.transform.position, [4, 0, 0])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer commits parent callbacks only on mouse up and never during object-change preview', async () => {
  const viewerSource = await readFile(viewerEntry, 'utf8')

  assert.equal(viewerSource.includes('onObjectChange={() => {\n        previewTransform()\n      }}'), true)
  assert.equal(viewerSource.includes('onObjectChange={() => {\n        previewTransform()\n        commitTransform()'), false)
  assert.equal(viewerSource.includes('onMouseUp={() => {\n        draggingRef.current = false\n        onDragEndSelectionBlock()\n        commitTransform()\n        onBoundsChange()\n        dragSessionRef.current = null\n      }}'), true)
  assert.equal(viewerSource.includes('resolveWorldsPendingSurfacePlacementDecision'), true)
  assert.equal(viewerSource.includes('onCommitPendingSurfacePlacement(pendingItemId, decision.transform)'), true)
  assert.equal(viewerSource.includes('onClearPendingSurfacePlacement()'), true)
  assert.equal(viewerSource.includes('Pending placement'), false)
})

test('WorldsViewer resolves active and secondary scene objects for multi-select feedback without duplicating the active item', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const active = new THREE.Group()
    const secondary = new THREE.Group()
    const ignored = new THREE.Group()
    const sceneObjects = new Map<string, THREE.Object3D>([
      ['world:active', active],
      ['world:secondary', secondary],
      ['world:ignored', ignored],
    ])

    assert.deepEqual(module.resolveWorldsSelectedSceneObjects(sceneObjects, ['world:secondary', 'world:active', 'world:secondary', 'world:missing'], 'world:active'), {
      activeObject: active,
      secondaryObjects: [secondary],
    })
    assert.deepEqual(module.resolveWorldsSelectedSceneObjects(sceneObjects, ['world:secondary'], 'world:missing'), {
      activeObject: null,
      secondaryObjects: [secondary],
    })
  } finally {
    await cleanup()
  }
})

test('WorldsViewer resolves selection from real mesh intersections before expanded hitboxes', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const itemGroup = new THREE.Group()
    itemGroup.userData.worldsSceneItemId = 'world:real-mesh'
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    itemGroup.add(mesh)

    const hitbox = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial())
    hitbox.userData.worldsSelectionHitbox = true
    hitbox.userData.worldsSceneItemId = 'world:hitbox'
    const silhouette = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial())
    silhouette.userData.worldsSelectionSilhouette = true
    silhouette.userData.worldsSceneItemId = 'world:silhouette'

    assert.equal(module.resolveWorldsSceneItemIdFromObject(mesh), 'world:real-mesh')
    assert.equal(module.resolveWorldsSceneItemIdFromObject(hitbox), null)
    assert.equal(module.resolveWorldsSceneItemIdFromObject(silhouette), null)
    assert.equal(module.resolveWorldsSceneItemIdFromIntersections([{ object: hitbox }, { object: silhouette }, { object: mesh }], 'world:fallback'), 'world:real-mesh')
    assert.equal(module.resolveWorldsSceneItemIdFromIntersections([{ object: hitbox }], 'world:fallback'), 'world:fallback')
  } finally {
    await cleanup()
  }
})

test('WorldsViewer computes an expanded invisible bounds hitbox for easy asset reselection', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const target = new THREE.Group()
    target.position.set(4, 0, -2)
    const narrowMesh = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.2), new THREE.MeshBasicMaterial())
    target.add(narrowMesh)
    target.updateWorldMatrix(true, true)

    const bounds = module.calculateWorldsSelectionBounds(target)
    assert.ok(bounds)
    assert.deepEqual(bounds.center.toArray(), [4, 0, -2])
    assert.deepEqual(bounds.size.toArray(), [0.3, 0.3, 0.3])

    narrowMesh.userData.worldsSelectionHitbox = true
    assert.equal(module.calculateWorldsSelectionBounds(target), null)
  } finally {
    await cleanup()
  }
})

test('WorldsMouseLookCameraControls can be disabled so selection and transform gizmos receive pointer events', async () => {
  const { cleanup } = await loadViewerModule()
  const mouseLookControlsSource = await readFile(mouseLookControlsEntry, 'utf8')
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(mouseLookControlsSource.includes('enabled = true'), true)
    assert.equal(mouseLookControlsSource.includes('if (!enabled) return'), true)
    assert.equal(viewerSource.includes('enabled={!transformMode && !transformDraggingRef.current}'), true)
    assert.equal(viewerSource.includes('selectSceneItemFromCanvas'), true)
    assert.equal(viewerSource.includes('if (transformMode) return'), false)
    assert.equal(viewerSource.includes('onPointerMissed={handleCanvasPointerMissed}'), true)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer uses Ctrl plus left click for multi-select toggles and preserves selection on Ctrl-empty clicks', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(module.isWorldsMultiSelectToggleGesture({ button: 0, ctrlKey: true }), true)
    assert.equal(module.isWorldsMultiSelectToggleGesture({ button: 0, ctrlKey: false, shiftKey: true }), false)
    assert.equal(module.isWorldsMultiSelectToggleGesture({ button: 2, ctrlKey: true }), false)
    assert.equal(module.shouldWorldsPointerMissClearSelection({ ctrlKey: true }), false)
    assert.equal(module.shouldWorldsPointerMissClearSelection({ ctrlKey: false }), true)
    assert.equal(module.shouldWorldsPointerMissClearSelection(undefined), true)
    assert.equal(viewerSource.includes('ctrlKey'), true)
    assert.equal(viewerSource.includes('shiftKey &&'), false)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer suppresses the immediate post-transform selection event without blocking later transform-mode clicks', async () => {
  const viewerSource = await readFile(viewerEntry, 'utf8')

  assert.equal(viewerSource.includes('const WORLDS_TRANSFORM_SELECTION_SUPPRESSION_MS = 180'), true)
  assert.equal(viewerSource.includes('if (Date.now() < suppressSelectionUntilRef.current) return'), true)
  assert.equal(viewerSource.includes('suppressSelectionUntilRef.current = Date.now() + WORLDS_TRANSFORM_SELECTION_SUPPRESSION_MS'), true)
  assert.equal(viewerSource.includes('selectCollisionSurfaceFromCanvas'), true)
  assert.equal(viewerSource.includes('if (transformMode) return'), false)
})

function createRootWithMesh(mesh: THREE.Object3D): THREE.Group {
  const root = new THREE.Group()
  root.add(mesh)
  root.updateWorldMatrix(true, true)
  return root
}

function createTriangleMesh(vertices: [[number, number, number], [number, number, number], [number, number, number]]): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3))
  geometry.computeVertexNormals()
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
}

test('WorldsViewer focus helper frames selected bounds instead of preserving the old camera distance', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const target = new THREE.Group()
    target.position.set(10, 0, -4)
    target.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial()))
    target.updateWorldMatrix(true, true)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    camera.position.set(30, 40, 50)
    const orbitTarget = new THREE.Vector3(1, 1, 1)
    let updateCalls = 0
    const previousDistance = camera.position.distanceTo(orbitTarget)
    const previousDirection = camera.position.clone().sub(orbitTarget).normalize()

    const focused = module.focusWorldsCameraOnObject(camera, {
      target: orbitTarget,
      maxDistance: 500,
      update: () => { updateCalls += 1 },
    }, target)

    assert.equal(focused, true)
    assert.deepEqual(orbitTarget.toArray(), [10, 0, -4])
    const bounds = module.calculateWorldsSelectionBounds(target)
    assert.ok(bounds)
    const expectedRadius = Math.max(bounds.size.length() * 0.5, module.WORLD_VIEWER_ORBIT_CONTROLS.minDistance)
    const focusedDistance = camera.position.distanceTo(orbitTarget)
    assert.ok(focusedDistance < previousDistance)
    assert.ok(focusedDistance > expectedRadius)
    assert.ok(focusedDistance < expectedRadius * 10)
    const focusedDirection = camera.position.clone().sub(orbitTarget).normalize()
    assert.ok(focusedDirection.distanceTo(previousDirection) < 1e-6)
    assert.equal(updateCalls, 1)
    assert.ok(camera.near >= 0.01)

    const empty = new THREE.Group()
    assert.equal(module.focusWorldsCameraOnObject(camera, {
      target: orbitTarget,
      maxDistance: 500,
      update: () => undefined,
    }, empty), false)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer focus helper keeps the object center as target and stops at a collision-safe camera position', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const target = new THREE.Group()
    target.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()))
    target.updateWorldMatrix(true, true)

    const surface = createWorldCollisionSurfacePreset('rectangle', {
      id: 'focus-wall',
      transform: { position: [5.7, 0, 0], rotation: [0, 0, -Math.PI / 2], scale: [4, 1, 4] },
    })
    assert.ok(surface)
    const collisionSurfaces = normalizeWorldSceneCollisionSurfaces([surface!])
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    camera.position.set(10, 0, 0)
    const orbitTarget = new THREE.Vector3(0, 0, 0)

    const focused = module.focusWorldsCameraOnObject(camera, {
      target: orbitTarget,
      maxDistance: 500,
      update: () => undefined,
    }, target, collisionSurfaces)

    assert.equal(focused, true)
    assert.deepEqual(orbitTarget.toArray(), [0, 0, 0])
    assert.ok(camera.position.x > 5.69)
    assert.ok(camera.position.x < 10)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer creates stable fit keys from visible scene descriptors', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.deepEqual(module.createWorldsSceneFitKey([item('ply-mesh', 'mesh.ply'), item('glb', 'scene.glb')]), 'world:mesh.ply:mesh.ply|world:scene.glb:scene.glb')
    assert.deepEqual(module.createWorldsSceneFitKey([{ ...item('ply-mesh', 'hidden.ply'), visible: false }, item('gltf', 'visible.gltf')]), 'world:visible.gltf:visible.gltf')
  } finally {
    await cleanup()
  }
})

test('WorldsViewer fit action applies bounds fit when delayed GLTF bounds arrive without an initial view', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.equal(module.resolveWorldsSceneFitAction({
      fitKeyChanged: true,
      initialViewChanged: false,
      hasInitialView: false,
      hasMeasuredBounds: false,
      hasSnapshot: true,
      hasAppliedBoundsFitForCurrentFitKey: false,
      loadRevisionChanged: false,
    }), 'noop')

    assert.equal(module.resolveWorldsSceneFitAction({
      fitKeyChanged: false,
      initialViewChanged: false,
      hasInitialView: false,
      hasMeasuredBounds: true,
      hasSnapshot: true,
      hasAppliedBoundsFitForCurrentFitKey: false,
      loadRevisionChanged: true,
    }), 'apply-bounds-fit')

    const bounds = {
      center: new THREE.Vector3(10, 4, -3),
      size: new THREE.Vector3(8, 6, 4),
      distance: 14,
    }
    const snapshot = module.createWorldsBoundsCameraFitSnapshot(bounds)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 500,
      update: () => undefined,
      saveState: () => undefined,
    }

    module.applyWorldsCameraFitSnapshot(camera, controls, snapshot)

    assert.deepEqual(controls.target.toArray(), [10, 4, -3])
    assert.notDeepEqual(camera.position.toArray(), [2.4, 1.8, 2.8])
    assert.ok(camera.position.distanceTo(snapshot.target) > 0)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer fit action preserves saved initial view while delayed bounds only refresh limits', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.equal(module.resolveWorldsSceneFitAction({
      fitKeyChanged: false,
      initialViewChanged: false,
      hasInitialView: true,
      hasMeasuredBounds: true,
      hasSnapshot: true,
      hasAppliedBoundsFitForCurrentFitKey: false,
      loadRevisionChanged: true,
    }), 'refresh-limits')
  } finally {
    await cleanup()
  }
})

test('WorldsViewer fit action does not steal the camera again for repeated bounds changes on the same loaded render set', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.equal(module.resolveWorldsSceneFitAction({
      fitKeyChanged: false,
      initialViewChanged: false,
      hasInitialView: false,
      hasMeasuredBounds: true,
      hasSnapshot: true,
      hasAppliedBoundsFitForCurrentFitKey: true,
      loadRevisionChanged: true,
    }), 'noop')
  } finally {
    await cleanup()
  }
})

test('WorldsViewer fit action refits when the visible render set changes', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.equal(module.resolveWorldsSceneFitAction({
      fitKeyChanged: true,
      initialViewChanged: false,
      hasInitialView: false,
      hasMeasuredBounds: true,
      hasSnapshot: true,
      hasAppliedBoundsFitForCurrentFitKey: false,
      loadRevisionChanged: false,
    }), 'apply-bounds-fit')
  } finally {
    await cleanup()
  }
})

test('WorldsViewer applies an explicit initial view and reset restores the same bounded camera snapshot', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const bounds = {
      center: new THREE.Vector3(0, 1, 0),
      size: new THREE.Vector3(20, 10, 8),
      distance: 24,
    }
    const initialView = {
      position: [8, 5, 12],
      target: [1, 2, 3],
      up: [0, 0, 1],
    }
    const snapshot = module.createWorldsInitialViewCameraFitSnapshot(initialView, bounds)

    assert.deepEqual(snapshot.position.toArray(), initialView.position)
    assert.deepEqual(snapshot.target.toArray(), initialView.target)
    assert.deepEqual(snapshot.up.toArray(), initialView.up)
    assert.ok(snapshot.near > 0)
    assert.ok(snapshot.far > snapshot.near)
    assert.ok(snapshot.maxDistance >= snapshot.position.distanceTo(snapshot.target) * 2)
    assert.deepEqual(
      module.createWorldsInitialViewCameraFitSnapshot({
        position: [4, 3, 2],
        target: [0, 0, 0],
      }, bounds).up.toArray(),
      [0, 1, 0],
    )

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 500,
      updateCalls: 0,
      saveCalls: 0,
      update() { this.updateCalls += 1 },
      saveState() { this.saveCalls += 1 },
    }

    module.applyWorldsCameraFitSnapshot(camera, controls, snapshot)
    assert.deepEqual(camera.position.toArray(), initialView.position)
    assert.deepEqual(camera.up.toArray(), initialView.up)
    assert.deepEqual(controls.target.toArray(), initialView.target)
    assert.equal(camera.near, snapshot.near)
    assert.equal(camera.far, snapshot.far)
    assert.equal(controls.maxDistance, snapshot.maxDistance)

    camera.position.set(-20, -20, -20)
    camera.up.set(0, 1, 0)
    controls.target.set(9, 9, 9)
    module.applyWorldsCameraFitSnapshot(camera, controls, snapshot)

    assert.deepEqual(camera.position.toArray(), initialView.position)
    assert.deepEqual(camera.up.toArray(), initialView.up)
    assert.deepEqual(controls.target.toArray(), initialView.target)
    assert.equal(controls.updateCalls, 2)
    assert.equal(controls.saveCalls, 2)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer refreshes loaded-scene camera limits without moving the explicit pose', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const initialView = {
      position: [8, 5, 12],
      target: [1, 2, 3],
      up: [0, 0, 1],
    }
    const initialSnapshot = module.createWorldsInitialViewCameraFitSnapshot(initialView, {
      center: new THREE.Vector3(0, 0, 0),
      size: new THREE.Vector3(1, 1, 1),
      distance: 2,
    })
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 500,
      update: () => undefined,
      saveState: () => undefined,
    }

    module.applyWorldsCameraFitSnapshot(camera, controls, initialSnapshot)
    const poseBeforeLoad = {
      position: camera.position.toArray(),
      up: camera.up.toArray(),
      target: controls.target.toArray(),
      quaternion: camera.quaternion.toArray(),
    }
    const refreshedSnapshot = module.refreshWorldsCameraFitSnapshotLimits(camera, controls, initialSnapshot, {
      center: new THREE.Vector3(0, 10, 0),
      size: new THREE.Vector3(120, 80, 60),
      distance: 160,
    })

    assert.deepEqual(camera.position.toArray(), poseBeforeLoad.position)
    assert.deepEqual(camera.up.toArray(), poseBeforeLoad.up)
    assert.deepEqual(controls.target.toArray(), poseBeforeLoad.target)
    assert.deepEqual(camera.quaternion.toArray(), poseBeforeLoad.quaternion)
    assert.deepEqual(refreshedSnapshot.position.toArray(), initialView.position)
    assert.deepEqual(refreshedSnapshot.target.toArray(), initialView.target)
    assert.ok(refreshedSnapshot.far > initialSnapshot.far)
    assert.ok(refreshedSnapshot.maxDistance > initialSnapshot.maxDistance)
    assert.equal(camera.near, refreshedSnapshot.near)
    assert.equal(camera.far, refreshedSnapshot.far)
    assert.equal(controls.maxDistance, refreshedSnapshot.maxDistance)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer defers BVH construction until scheduled work and cancels cleanly before the first build', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    let computeCalls = 0
    let disposeCalls = 0
    ;(geometry as any).computeBoundsTree = () => {
      computeCalls += 1
      ;(geometry as any).boundsTree = { built: true }
    }
    ;(geometry as any).disposeBoundsTree = () => {
      disposeCalls += 1
      delete (geometry as any).boundsTree
    }

    const scene = new THREE.Group()
    scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))
    const scheduled: Array<() => void> = []
    const task = module.scheduleWorldsSceneBoundsTreeBuild(scene, (callback: () => void) => {
      scheduled.push(callback)
      return { cancel: () => undefined }
    })

    assert.equal(computeCalls, 0)
    assert.equal(scheduled.length, 1)

    task.release()
    scheduled[0]!()

    assert.equal(computeCalls, 0)
    assert.equal(disposeCalls, 0)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer GLTF instance cloning owns per-instance materials and keeps shared GLTF resources alive across remounts', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const sourceMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', side: THREE.FrontSide })
    let sourceMaterialDisposed = false
    sourceMaterial.dispose = () => {
      sourceMaterialDisposed = true
      THREE.Material.prototype.dispose.call(sourceMaterial)
    }

    const geometry = new THREE.BoxGeometry(1, 1, 1)
    let computeCalls = 0
    let disposeCalls = 0
    ;(geometry as any).computeBoundsTree = () => {
      computeCalls += 1
      ;(geometry as any).boundsTree = { built: true }
    }
    ;(geometry as any).disposeBoundsTree = () => {
      disposeCalls += 1
      delete (geometry as any).boundsTree
    }

    const sourceScene = new THREE.Group()
    sourceScene.add(new THREE.Mesh(geometry, sourceMaterial))

    const clonedScene = sourceScene.clone()
    module.cloneWorldsSceneMaterialsForInstance(clonedScene)
    const clonedMesh = clonedScene.children[0]

    assert.ok(clonedMesh instanceof THREE.Mesh)
    assert.notEqual(clonedMesh.material, sourceMaterial)
    assert.equal((clonedMesh.material as THREE.Material).side, THREE.DoubleSide)
    assert.equal(sourceMaterial.side, THREE.FrontSide)

    const scheduled: Array<() => void> = []
    const scheduler = (callback: () => void) => {
      scheduled.push(callback)
      return { cancel: () => undefined }
    }

    const firstInstance = module.createWorldsGltfSceneInstance(sourceScene, scheduler)
    const secondInstance = module.createWorldsGltfSceneInstance(sourceScene, scheduler)
    const firstMesh = firstInstance.scene.children[0]
    const secondMesh = secondInstance.scene.children[0]

    assert.ok(firstMesh instanceof THREE.Mesh)
    assert.ok(secondMesh instanceof THREE.Mesh)

    assert.equal(computeCalls, 0)
    scheduled.forEach((run) => run())
    assert.equal(computeCalls, 1)

    firstInstance.dispose()
    assert.equal(disposeCalls, 0)
    assert.equal(sourceMaterialDisposed, false)

    secondInstance.dispose()
    assert.equal(disposeCalls, 1)
    assert.equal(sourceMaterialDisposed, false)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer reset reapplies the stored collision-resolved snapshot from either current side', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const surface = createWorldCollisionSurfacePreset('rectangle', {
      id: 'reset-blocker',
      transform: { position: [0, 0, 0], rotation: [-Math.PI / 2, 0, 0], scale: [4, 1, 4] },
    })
    assert.ok(surface)
    const collisionSurfaces = normalizeWorldSceneCollisionSurfaces([surface!])
    const desiredSnapshot = {
      position: new THREE.Vector3(0, 0, 0),
      target: new THREE.Vector3(0, 0, -2),
      up: new THREE.Vector3(0, 1, 0),
      near: 0.01,
      far: 500,
      maxDistance: 50,
    }
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    camera.position.set(4, 0, 0)
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 500,
      update: () => undefined,
      saveState: () => undefined,
    }

    const storedSnapshot = module.resolveAndApplyWorldsCameraFitSnapshot(camera, controls, desiredSnapshot, collisionSurfaces)
    assert.ok(Math.abs(storedSnapshot.position.z) > 0.19)
    assert.deepEqual(camera.position.toArray(), storedSnapshot.position.toArray())

    camera.position.set(-4, 0, 0)
    controls.target.set(9, 9, 9)
    module.applyWorldsCameraFitSnapshot(camera, controls, storedSnapshot)

    assert.deepEqual(camera.position.toArray(), storedSnapshot.position.toArray())
    assert.deepEqual(controls.target.toArray(), storedSnapshot.target.toArray())
    const resolvedFromCurrentSide = module.createCollisionSafeWorldsCameraFitSnapshot(
      desiredSnapshot,
      new THREE.Vector3(-4, 0, 0),
      collisionSurfaces,
    )
    assert.ok(Math.abs(resolvedFromCurrentSide.position.z) > 0.19)
    assert.deepEqual(resolvedFromCurrentSide.position.toArray(), storedSnapshot.position.toArray())
  } finally {
    await cleanup()
  }
})


test('WorldsViewer collision-safe fit snapshots stay unchanged without blockers and depenetrate deterministically inside blockers', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const snapshot = {
      position: new THREE.Vector3(2.4, 1.8, 2.8),
      target: new THREE.Vector3(0, 0, 0),
      up: new THREE.Vector3(0, 1, 0),
      near: 0.01,
      far: 500,
      maxDistance: 50,
    }
    const unchanged = module.createCollisionSafeWorldsCameraFitSnapshot(snapshot, new THREE.Vector3(8, 8, 8), [])
    assert.deepEqual(unchanged.position.toArray(), [2.4, 1.8, 2.8])
    assert.deepEqual(unchanged.target.toArray(), [0, 0, 0])

    const surface = createWorldCollisionSurfacePreset('rectangle', {
      id: 'reset-blocker',
      transform: { position: [0, 0, 0], rotation: [-Math.PI / 2, 0, 0], scale: [4, 1, 4] },
    })
    assert.ok(surface)
    const collisionSurfaces = normalizeWorldSceneCollisionSurfaces([surface!])
    const blockedSnapshot = {
      ...snapshot,
      position: new THREE.Vector3(0, 0, 0),
    }

    const resolvedA = module.createCollisionSafeWorldsCameraFitSnapshot(blockedSnapshot, new THREE.Vector3(0, 0, 0), collisionSurfaces)
    const resolvedB = module.createCollisionSafeWorldsCameraFitSnapshot(blockedSnapshot, new THREE.Vector3(0, 0, 0), collisionSurfaces)

    assert.ok(Math.abs(Math.abs(resolvedA.position.z) - 0.2001) < 2e-3)
    assert.deepEqual(resolvedA.position.toArray(), resolvedB.position.toArray())
    assert.deepEqual(resolvedA.target.toArray(), [0, 0, 0])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps collision surfaces out of normal render targets, bounds selection, and box-era contracts', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(viewerSource.includes('if (object.userData.worldsCollisionSurface === true) return'), true)
    assert.equal(viewerSource.includes('collisionEditMode ? ('), true)
    assert.equal(viewerSource.includes('<WorldCollisionSurfaceLayer'), true)
    assert.equal(viewerSource.includes('<WorldCollisionZoneLayer'), false)
    assert.equal(viewerSource.includes('worldsPlacementCollision'), false)
    assert.equal(viewerSource.includes('worldsSurfacePlacement'), true)
    assert.deepEqual(module.describeWorldsViewerScene([{
      ...item('ply-mesh', 'mesh.ply'),
      collision: { enabled: true, zones: [{ id: 'zone-1', shape: 'box', offset: [0, 0, 0], size: [1, 1, 1] }] },
    }]).renderTargets, [
      {
        workspacePath: 'mesh.ply',
        kind: 'ply-mesh',
        loader: 'ply',
        primitive: 'mesh',
        cameraFit: 'bounds',
        visibleDescription: 'PLY mesh geometry',
      },
    ])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer routes collision surface gizmos through the same drag suppression path as asset gizmos', async () => {
  const viewerSource = await readFile(viewerEntry, 'utf8')

  assert.equal(viewerSource.includes('draggingRef={transformDraggingRef}'), true)
  assert.equal(viewerSource.includes('onSelectSurface={selectCollisionSurfaceFromCanvas}'), true)
  assert.equal(viewerSource.includes('onDragEndSelectionBlock={handleTransformDragEnd}'), true)
  assert.equal(viewerSource.includes('draggingRef.current = true'), true)
  assert.equal(viewerSource.includes('draggingRef.current = false'), true)
  assert.equal(viewerSource.includes('selectedObject && transformMode && !selectedCollisionSurfaceId'), true)
  assert.equal(viewerSource.includes('collisionEditMode={collisionEditMode}'), true)
  assert.equal(viewerSource.includes('!(collisionEditMode && selectedCollisionSurfaceId)'), false)
  assert.equal(viewerSource.includes('{selected && zoneObject && transformMode ? ('), false)
  assert.equal(viewerSource.includes('object={zoneObject}'), false)
})

test('WorldsCameraOverlay exposes compact accessible speed reset and help controls without mode UI', async () => {
  const { source, module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')
  const overlaySource = await readFile(cameraOverlayEntry, 'utf8')

  try {
    assert.deepEqual(module.WORLD_VIEWER_CAMERA_OVERLAY, {
      placement: 'compact-in-canvas-overlay',
      sidePanel: false,
      labels: {
        speed: 'Movement speed',
        reset: 'Reset camera',
        help: 'Camera and keyboard movement help',
      },
      helpText: 'Left-drag look · Right-drag pan · Wheel zoom · WASD/Arrows move · Space up · Shift down · Q/E yaw',
    })
    assert.equal(source.includes('WorldsCameraOverlay'), true)
    assert.equal(viewerSource.includes('<WorldsCameraOverlay'), true)
    assert.equal(viewerSource.includes('setCameraState((state) => ({ ...state, speed: nextSpeed }))'), true)
    assert.equal(viewerSource.includes('resetToken: state.resetToken + 1'), true)
    assert.equal(overlaySource.includes('aria-label={WORLD_VIEWER_CAMERA_OVERLAY.labels.speed}'), true)
    assert.equal(overlaySource.includes('aria-label={WORLD_VIEWER_CAMERA_OVERLAY.labels.reset}'), true)
    assert.equal(overlaySource.includes('aria-describedby="worlds-camera-help"'), false)
    assert.equal(overlaySource.includes('pointerLockButtonId'), false)
    assert.equal(overlaySource.includes('onStartMouseLook'), false)
    assert.equal(overlaySource.includes('onStopMouseLook'), false)
    assert.equal(overlaySource.includes('pointerLocked'), false)
    assert.equal(overlaySource.includes('WORLD_CAMERA_MODES'), false)
    assert.equal(overlaySource.includes('onModeChange'), false)
    assert.equal(overlaySource.includes('mode !=='), false)
    assert.equal(overlaySource.includes('focus-visible:outline'), true)
    assert.equal(overlaySource.includes('<aside'), false)
    assert.equal(overlaySource.includes('Inspector'), false)
  } finally {
    await cleanup()
  }
})

test('WorldsCameraOverlay renders speed choices, reset and look guidance without a mode toggle', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorldsCameraOverlay, {
      speed: 5,
      onSpeedChange: () => undefined,
      onResetCamera: () => undefined,
    }))

    assert.match(markup, /aria-label="Camera navigation controls"/)
    assert.doesNotMatch(markup, /role="group"[^>]*aria-label="Camera mode"/)
    assert.doesNotMatch(markup, /Fly\/Walk/)
    assert.match(markup, /aria-label="Movement speed"/)
    assert.match(markup, /<option[^>]*value="5"[^>]*selected=""[^>]*>5×<\/option>/)
    assert.match(markup, /aria-label="Reset camera"[^>]*>Reset camera</)
    assert.doesNotMatch(markup, /Mouse look|Pointer lock|Release mouse|aria-pressed/)
    assert.match(markup, /Left-drag look · Right-drag pan · Wheel zoom · WASD\/Arrows move · Space up · Shift down · Q\/E yaw/)
    assert.doesNotMatch(markup, /<aside|Inspector|side panel/i)
  } finally {
    await cleanup()
  }
})

test('WorldsTransformToolbar clarifies that multi-select transforms use the active item as the pivot', async () => {
  const toolbarSource = await readFile(path.join(projectRoot, 'src/areas/worlds/components/WorldsTransformToolbar.tsx'), 'utf8')

  assert.equal(toolbarSource.includes('transforms use the active item as the pivot'), true)
  assert.equal(toolbarSource.includes('only the active item gets transform controls'), false)
  assert.equal(toolbarSource.includes('Add collision surface'), true)
  assert.equal(toolbarSource.includes('Add box'), false)
  assert.equal(toolbarSource.includes('Wall'), true)
  assert.equal(toolbarSource.includes('Triangle'), true)
  assert.equal(toolbarSource.includes('Floor'), true)
  assert.equal(toolbarSource.includes('World collision surfaces use the same move, rotate, and scale gizmo as scene assets.'), true)
  assert.equal(toolbarSource.includes('Remove surface'), true)
})

test('production Worlds modules keep a static boundary from Generate Viewer3D implementations', async () => {
  const productionFiles = await listProductionWorldsFiles(worldsRoot)
  assert.ok(productionFiles.length > 0, 'expected production Worlds files to be scanned')

  const forbiddenPatterns = [
    /src\/areas\/generate\/components\/Viewer3D/i,
    /@areas\/generate\/components\/Viewer3D/i,
    /\.\.\/\.\.\/generate\/components\/Viewer3D/i,
    /generate\/components\/Viewer3D/i,
  ]

  for (const filePath of productionFiles) {
    const source = await readFile(filePath, 'utf8')
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(source), false, `${path.relative(projectRoot, filePath)} must not import or reference Generate Viewer3D`)
    }
  }
})

test('production Worlds modules do not import PointerLockControls', async () => {
  const productionFiles = await listProductionWorldsFiles(worldsRoot)
  assert.ok(productionFiles.length > 0, 'expected production Worlds files to be scanned')

  const forbiddenPatterns = [/PointerLockControls/]

  for (const filePath of productionFiles) {
    const source = await readFile(filePath, 'utf8')
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(source), false, `${path.relative(projectRoot, filePath)} must not import or reference ${pattern}`)
    }
  }
})

async function listProductionWorldsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__fixtures__') return []
        return listProductionWorldsFiles(entryPath)
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return []
      return [entryPath]
    }),
  )
  return files.flat()
}
