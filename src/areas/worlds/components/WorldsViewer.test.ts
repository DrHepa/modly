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
    assert.equal(source.includes('WorldsFlyCameraControls'), false)
    assert.equal(viewerSource.includes("enabled={cameraState.mode === 'orbit'}"), false)
    assert.equal(viewerSource.includes("enabled={cameraState.mode === 'fly'}"), false)
    assert.equal(viewerSource.includes('<OrbitControls'), true)
    assert.equal(viewerSource.includes('PointerLockControls'), false)
    assert.equal(viewerSource.includes('makeDefault'), true)
    assert.equal(viewerSource.includes('enableDamping'), true)
    assert.equal(viewerSource.includes('enableRotate={WORLD_VIEWER_ORBIT_CONTROLS.enableRotate}'), true)
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
    assert.equal(keyboardControlsSource.includes('deriveWorldsMovementVector'), true)
    assert.equal(keyboardControlsSource.includes("isWorldCameraRotationKey(code: string): code is 'KeyQ' | 'KeyE'"), true)
    assert.equal(keyboardControlsSource.includes("rotationKeysRef.current = updateWorldsRotationKeys(rotationKeysRef.current, event.code, true)"), true)
    assert.equal(keyboardControlsSource.includes('rotateWorldsCameraYawTarget'), true)
    assert.equal(keyboardControlsSource.includes('camera.getWorldDirection(lookDirectionVector)'), true)
    assert.equal(keyboardControlsSource.includes('orbitControlsRef.current.target.copy(rotateWorldsCameraYawTarget({'), true)
    assert.equal(keyboardControlsSource.includes('camera.position.copy(orbitControlsRef.current.target).add('), false)
    assert.equal(keyboardControlsSource.includes('orbitOffsetVector.copy(camera.position).sub(orbitControlsRef.current.target)'), false)
    assert.equal(keyboardControlsSource.includes('activeElement: document.activeElement'), true)
    assert.equal(keyboardControlsSource.includes('orbitControlsRef.current?.target.add(scaledMovementVector)'), true)
    assert.equal(keyboardControlsSource.includes('orbitControlsRef.current?.update()'), true)
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
    assert.equal(viewerSource.includes('collisionZones={collisionZones}'), true)
    assert.equal(viewerSource.includes('collisionEditMode={collisionEditMode}'), true)
    assert.equal(viewerSource.includes('selectedCollisionZoneId={selectedCollisionZoneId}'), true)
    assert.equal(viewerSource.includes('selectedItemIds={selectedItemIds}'), true)
    assert.equal(viewerSource.includes('onAddCollisionZone={onAddCollisionZone}'), true)
    assert.equal(viewerSource.includes('onCollisionEditModeChange={onCollisionEditModeChange}'), true)
    assert.equal(viewerSource.includes('onSelectCollisionZone={onSelectCollisionZone}'), true)
    assert.equal(viewerSource.includes('const selectCollisionZoneFromCanvas = useCallback((zoneId: string | null) => {'), true)
    assert.equal(viewerSource.includes('onSelectCollisionZone(zoneId)'), true)
    assert.equal(viewerSource.includes('function WorldCollisionZoneLayer({'), true)
    assert.equal(viewerSource.includes('rotation={zone.transform.rotation}'), true)
    assert.equal(viewerSource.includes('onTransformCollisionZone,'), true)
    assert.equal(viewerSource.includes('onTransformCollisionZone(zone.id, {'), true)
    assert.equal(viewerSource.includes('const selectedItems = useMemo(() => visibleItems.filter((item) => selectedItemIdSet.has(item.id))'), true)
    assert.equal(viewerSource.includes('onRemoveItem={onRemoveItem}'), true)
    assert.equal(viewerSource.includes('onRemoveCollisionZone={onRemoveCollisionZone}'), true)
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
    assert.equal(viewerSource.includes('onTransformCollisionZone={onTransformCollisionZone}'), true)
    assert.equal(viewerSource.includes('createWorldSceneSelectionTransformUpdates'), true)
    assert.equal(viewerSource.includes('const transformSnapshotRef = useRef<WorldSceneTransformSnapshot[] | null>(null)'), true)
    assert.equal(viewerSource.includes('transformSnapshotRef.current = selectedItems.map((item) => ({'), true)
    assert.equal(viewerSource.includes('export function isWorldsBatchTransformSnapshot(snapshot: WorldSceneTransformSnapshot[] | null)'), true)
    assert.equal(viewerSource.includes('if (!shouldResetWorldsTransformSnapshot(draggingRef.current)) return'), true)
    assert.equal(viewerSource.includes('if (!isWorldsBatchTransformSnapshot(snapshot))'), true)
    assert.equal(viewerSource.includes('onTransformItems(createWorldSceneSelectionTransformUpdates({'), true)
    assert.equal(viewerSource.includes('takeSnapshot()'), true)
    assert.equal(viewerSource.includes('onDragEndSelectionBlock={handleTransformDragEnd}'), true)
    assert.equal(viewerSource.includes('onDragEndSelectionBlock()'), true)
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
    assert.equal(viewerSource.includes('resolveWorldsSelectedSceneObjects(sceneObjectsRef.current, selectedItemIds, selectedItemId)'), true)
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
    assert.equal(viewerSource.includes('cloneSkeletonScene(gltf.scene)'), true)
    assert.equal(viewerSource.includes('material.side = THREE.DoubleSide'), true)
    assert.equal(viewerSource.includes('WorldsSelectionHitbox'), true)
    assert.equal(viewerSource.includes('worldsSelectionHitbox'), true)
    assert.equal(viewerSource.includes('WorldCollisionZoneLayer'), true)
    assert.equal(viewerSource.includes('worldsCollisionZone'), true)
    assert.equal(viewerSource.includes('onClick={(event) => {'), true)
    assert.equal(viewerSource.includes('event.stopPropagation()'), true)
    assert.equal(viewerSource.includes('onSelectCollisionZone(zone.id)'), true)
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
  assert.equal(viewerSource.includes('selectCollisionZoneFromCanvas'), true)
  assert.equal(viewerSource.includes('if (transformMode) return'), false)
})

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

test('WorldsViewer fits bounds only on scene load or intentional reset', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.deepEqual(module.createWorldsSceneFitKey([item('ply-mesh', 'mesh.ply'), item('glb', 'scene.glb')]), 'world:mesh.ply:mesh.ply|world:scene.glb:scene.glb')
    assert.deepEqual(module.createWorldsSceneFitKey([{ ...item('ply-mesh', 'hidden.ply'), visible: false }, item('gltf', 'visible.gltf')]), 'world:visible.gltf:visible.gltf')
    assert.equal(viewerSource.includes('<Bounds fit clip observe'), false)
    assert.equal(viewerSource.includes('<Bounds margin={1.25}>'), true)
    assert.equal(viewerSource.includes('cameraFitSnapshotRef'), true)
    assert.equal(viewerSource.includes('resetToken={cameraState.resetToken}'), true)
    assert.equal(viewerSource.includes('cameraFitSnapshotRef={cameraFitSnapshotRef}'), true)
    assert.equal(viewerSource.includes('bounds.refresh()'), true)
    assert.equal(viewerSource.includes('bounds.getSize()'), true)
    assert.equal(viewerSource.includes('WORLDS_DEFAULT_CAMERA_POSITION'), true)
    assert.equal(viewerSource.includes('const shouldApplyInitialFit = cameraFitSnapshotRef.current === null'), true)
    assert.equal(viewerSource.includes('cameraFitSnapshotRef.current = snapshot'), true)
    assert.equal(viewerSource.includes('if (shouldApplyInitialFit) applySnapshot(snapshot)'), true)
    assert.equal(viewerSource.includes('controls.target.copy(snapshot.target)'), true)
    assert.equal(viewerSource.includes('controls.saveState?.()'), true)
    assert.equal(viewerSource.includes('refresh().clip().fit()'), false)
    assert.equal(viewerSource.includes('createWorldsSceneFitKey(visibleItems, cameraState.resetToken)'), false)
    assert.equal(viewerSource.includes('createWorldsSceneFitKey(visibleItems)'), true)
    assert.equal(viewerSource.includes('fallback={<HtmlStatus message="Loading world asset…" />}'), false)
    assert.equal(viewerSource.includes('<Suspense fallback={null}>'), true)
    assert.equal(viewerSource.includes('<WorldSceneItemObject'), true)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps collision zones out of normal render targets, bounds selection, and camera fit contracts', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(viewerSource.includes('if (object.userData.worldsCollisionZone === true) return'), true)
    assert.equal(viewerSource.includes('collisionEditMode ? ('), true)
    assert.equal(viewerSource.includes('<WorldCollisionZoneLayer'), true)
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

test('WorldsViewer routes collision zone gizmos through the same drag suppression path as asset gizmos', async () => {
  const viewerSource = await readFile(viewerEntry, 'utf8')

  assert.equal(viewerSource.includes('draggingRef={transformDraggingRef}'), true)
  assert.equal(viewerSource.includes('onSelectCollisionZone={selectCollisionZoneFromCanvas}'), true)
  assert.equal(viewerSource.includes('onDragEndSelectionBlock={handleTransformDragEnd}'), true)
  assert.equal(viewerSource.includes('draggingRef.current = true'), true)
  assert.equal(viewerSource.includes('draggingRef.current = false'), true)
  assert.equal(viewerSource.includes('selectedObject && transformMode && !selectedCollisionZoneId'), true)
  assert.equal(viewerSource.includes('!(collisionEditMode && selectedCollisionZoneId)'), false)
  assert.equal(viewerSource.includes('{selected && zoneObject && transformMode ? ('), true)
  assert.equal(viewerSource.includes('object={zoneObject}'), true)
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
  assert.equal(toolbarSource.includes('Add collision zone'), true)
  assert.equal(toolbarSource.includes('Add box'), false)
  assert.equal(toolbarSource.includes('Wall'), true)
  assert.equal(toolbarSource.includes('Blocker'), true)
  assert.equal(toolbarSource.includes('Floor zone'), true)
  assert.equal(toolbarSource.includes('World collision zones use the same move, rotate, and scale gizmo as scene assets.'), true)
  assert.equal(toolbarSource.includes('Remove zone'), true)
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
