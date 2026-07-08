import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import React, { createElement } from 'react'
import * as THREE from 'three'

import { build } from 'esbuild'
import { renderToStaticMarkup } from 'react-dom/server'

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
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-worlds-viewer-test-'))
  const outfile = path.join(tempDir, 'WorldsViewer.bundle.mjs')
  const result = await build({
    entryPoints: [viewerEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [{ name: 'cpu-rendering-boundary', setup(api) {
      api.onResolve({ filter: /^@react-three\/(fiber|drei)$/ }, args => ({ path: args.path, namespace: 'cpu' }))
      api.onLoad({ filter: /.*/, namespace: 'cpu' }, () => ({ loader: 'tsx', contents: `
        import { forwardRef, useEffect, useImperativeHandle } from 'react'
        export const Canvas = ({children}) => children
        export const Bounds = ({children}) => <cpuBounds>{children}</cpuBounds>
        export const Html = Canvas, GizmoHelper = Canvas, TransformControls = Canvas
        export const GizmoViewport = () => null
        export const useThree = () => globalThis.__worldsCpu
        export const useBounds = () => globalThis.__worldsCpu.bounds
        export const useFrame = callback => { useEffect(() => { const frames = globalThis.__worldsCpu.frames; frames.add(callback); return () => frames.delete(callback) }) }
        export const OrbitControls = forwardRef((_props, ref) => { useImperativeHandle(ref, () => globalThis.__worldsCpu.controls); return null })
        export const useGLTF = url => globalThis.__worldsGltf(url)
      ` }))
      api.onResolve({ filter: /^@react-three\/postprocessing$/ }, () => ({ path: 'postprocessing', namespace: 'cpu-postprocessing' }))
      api.onLoad({ filter: /.*/, namespace: 'cpu-postprocessing' }, () => ({ loader: 'tsx', contents: `
        export const Selection = ({children}) => children
        export const Select = Selection
        export const EffectComposer = () => null
        export const Outline = () => null
      ` }))
      api.onResolve({ filter: /^(react(?:\/.*)?|three(?:\/.*)?)$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
    } }],
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

test('PLY render topology comes from the loaded bytes, not stale item metadata', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    const points = await readFile(pointsFixture)
    const mesh = await readFile(meshFixture)
    for (const [bytes, hint, primitive] of [[points, 'ply-mesh', 'points'], [mesh, 'ply-points', 'mesh']] as const) {
      const model = module.createPlyRenderModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), item(hint, 'same.ply'))
      try { assert.equal(model.primitive, primitive) } finally { model.geometry.dispose() }
    }
    for (const properties of ['property uchar red\nproperty uchar green\nproperty uchar blue', 'property list uchar float texcoord']) {
      const body = properties.includes('texcoord') ? '3 0 1 2 6 0 0 1 0 0 1' : '3 0 1 2 255 0 0'
      const text = `ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\n${properties}\nend_header\n0 0 0\n1 0 0\n0 1 0\n${body}\n`
      const model = module.createPlyRenderModel(new TextEncoder().encode(text).buffer, item('ply-points', 'stale.ply'))
      try { assert.equal(model.geometry.index, null); assert.equal(model.primitive, 'mesh') } finally { model.geometry.dispose() }
    }
  } finally { await cleanup() }
})

test('PLY viewer refuses ineligible bytes instead of guessing a render primitive', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    for (const text of ['not ply\n', 'ply\nformat ascii 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float scale_0\nproperty float rot_0\nend_header\n']) {
      assert.throws(() => module.createPlyRenderModel(new TextEncoder().encode(text).buffer, item('ply-mesh', 'untrusted.ply')), /PLY.*(header|Gaussian|unsupported)/i)
    }
  } finally { await cleanup() }
})

test('PLY viewer keeps supported newline combinations and rejects binary offset mismatches', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    for (const format of ['ascii', 'binary_little_endian', 'binary_big_endian']) {
      for (const magic of ['\n', '\r', '\r\n']) for (const interior of ['\n', '\r', '\r\n']) for (const end of ['\n', '\r', '\r\n']) {
        const header = `ply${magic}${['format '+format+' 1.0', '', 'element vertex 1', 'property float x', 'property float y', 'property float z', 'end_header'].join(interior)}${end}`
        const bytes = Buffer.concat([Buffer.from(header), format === 'ascii' ? Buffer.from('1 2 3\n') : (() => { const b = Buffer.alloc(12); [1,2,3].forEach((x,i) => format === 'binary_little_endian' ? b.writeFloatLE(x,i*4) : b.writeFloatBE(x,i*4)); return b })()])
        const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        if (format !== 'ascii' && (magic === '\r\n') !== (end === '\r\n')) {
          assert.throws(() => module.createPlyRenderModel(source, item('ply-points', 'offset.ply')), /PLY.*header/i)
        } else {
          const model = module.createPlyRenderModel(source, item('ply-mesh', 'valid.ply'))
          try { assert.equal(model.primitive, 'points'); assert.equal(model.geometry.getAttribute('position').count, 1); assert.ok(model.geometry.getAttribute('position').array.every(Number.isFinite)) } finally { model.geometry.dispose() }
        }
      }
    }
  } finally { await cleanup() }
})

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
    const first = item('ply-mesh', 'mesh.ply')
    assert.equal(module.createWorldsSceneFitKey([first]), module.createWorldsSceneFitKey([{ ...first, transform: { ...first.transform, position: [4, 0, 0] } }]))
    assert.notEqual(module.createWorldsSceneFitKey([first]), module.createWorldsSceneFitKey([{ ...first, url: 'blob:replacement' }]))
    assert.notEqual(module.createWorldsSceneFitKey([first]), module.createWorldsSceneFitKey([{ ...first, kind: 'ply-points' }]))
    assert.equal(module.createWorldsSceneFitKey([{ ...first, visible: false }, item('gltf', 'visible.gltf')]), module.createWorldsSceneFitKey([item('gltf', 'visible.gltf')]))
    assert.equal(viewerSource.includes('<Bounds fit clip observe'), false)
    assert.equal(viewerSource.includes('<Bounds margin={1.25}>'), true)
    assert.equal(viewerSource.includes('cameraFitSnapshotRef'), true)
    assert.equal(viewerSource.includes('resetToken={cameraState.resetToken}'), true)
    assert.equal(viewerSource.includes('cameraFitSnapshotRef={cameraFitSnapshotRef}'), true)
    assert.equal(viewerSource.includes('bounds.refresh()'), true)
    assert.equal(viewerSource.includes('bounds.getSize()'), true)
    assert.equal(viewerSource.includes('WORLDS_DEFAULT_CAMERA_POSITION'), true)
    assert.equal(viewerSource.includes('if (!ready || cameraFitSnapshotRef.current?.fitKey === fitKey) return'), true)
    assert.equal(viewerSource.includes('cameraFitSnapshotRef.current = snapshot'), true)
    assert.equal(viewerSource.includes('cameraFitSnapshotRef.current = null'), true)
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
// Real React lifecycle on a CPU mutation host; the canvas alone is substituted.
type Host = { type: string; props: any; children: Host[]; object3D?: THREE.Object3D; tagName?: string; focus?: () => void; contains?: (value: unknown) => boolean; closest?: () => null }
class CpuEvents {
  listeners = new Map<string, Set<(event: any) => void>>()
  addEventListener(type: string, callback: (event: any) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(callback); this.listeners.set(type, set) }
  removeEventListener(type: string, callback: (event: any) => void) { this.listeners.get(type)?.delete(callback) }
  emit(type: string, props: Record<string, unknown> = {}) {
    const event = { type, target: this, pointerId: 1, button: 0, buttons: 1, movementX: 0, movementY: 0, clientX: 0, clientY: 0, prevented: false, stopped: false,
      preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, stopImmediatePropagation() { this.stopped = true }, ...props }
    for (const callback of this.listeners.get(type) ?? []) callback(event)
    return event
  }
  get listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0) }
}
function cpuHost() {
  const globals = globalThis as any
  const previous = { window: globals.window, document: globals.document, cpu: globals.__worldsCpu }
  const windowEvents = new CpuEvents(), documentEvents = Object.assign(new CpuEvents(), { activeElement: null as any, hidden: false })
  const captures = new Set<number>()
  const canvas = Object.assign(new CpuEvents(), { tagName: 'CANVAS', closest: () => null,
    setPointerCapture: (id: number) => captures.add(id), hasPointerCapture: (id: number) => captures.has(id), releasePointerCapture: (id: number) => captures.delete(id) })
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500); camera.position.set(2.4, 1.8, 2.8)
  const controls = { target: new THREE.Vector3(), maxDistance: 500, update: () => { camera.lookAt(controls.target); camera.updateMatrixWorld() }, saveState: () => undefined }
  controls.update()
  const frames = new Set<(state: { camera: THREE.PerspectiveCamera }, delta: number) => void>()
  const bounds = { refreshes: 0, box: new THREE.Box3(), refresh() {
    this.refreshes++; this.box.makeEmpty()
    const visit = (node: Host, parentMatrix = new THREE.Matrix4()) => {
      const matrix = parentMatrix.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...(node.props.position ?? [0, 0, 0]) as [number, number, number]), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(node.props.rotation ?? [0, 0, 0]) as [number, number, number])), new THREE.Vector3(...(node.props.scale ?? [1, 1, 1]) as [number, number, number])))
      const geometry = node.props.geometry as THREE.BufferGeometry | undefined
      if (geometry) {
        geometry.computeBoundingBox()
        if (geometry.boundingBox) {
          this.box.union(geometry.boundingBox.clone().applyMatrix4(matrix))
        }
      }
      if (node.props.object instanceof THREE.Object3D) this.box.union(new THREE.Box3().setFromObject(node.props.object))
      node.children.forEach(child => visit(child, matrix))
    }
    const fitRoot = find(n => n.type === 'cpuBounds'); if (fitRoot) visit(fitRoot); return this
  }, getSize() { return { box: this.box.clone(), center: this.box.getCenter(new THREE.Vector3()), distance: this.box.getSize(new THREE.Vector3()).length() * 2 } } }
  const state = { camera, controls, frames, bounds, gl: { domElement: canvas } }
  const install = () => { globals.window = windowEvents; globals.document = documentEvents; globals.__worldsCpu = state }
  install()
  const reconcilerPath = fileURLToPath(import.meta.resolve('react-reconciler'))
  assert.equal(reconcilerPath, path.join(projectRoot, 'node_modules/react-reconciler/index.js'))
  const require = createRequire(reconcilerPath)
  assert.equal(require('react'), React)
  const context = {}
  const remove = (p: Host, c: Host) => { const i = p.children.indexOf(c); if (i >= 0) p.children.splice(i, 1); if (p.object3D && c.object3D) p.object3D.remove(c.object3D) }
  const append = (p: Host, c: Host) => { remove(p, c); p.children.push(c); if (p.object3D && c.object3D) p.object3D.add(c.object3D) }
  const insert = (p: Host, c: Host, b: Host) => { remove(p, c); p.children.splice(p.children.indexOf(b), 0, c); if (p.object3D && c.object3D) p.object3D.add(c.object3D) }
  const syncObject = (node: Host) => {
    const object = node.object3D
    if (!object) return
    object.position.fromArray(node.props.position ?? [0, 0, 0])
    object.rotation.fromArray([...(node.props.rotation ?? [0, 0, 0]), 'XYZ'])
    object.scale.fromArray(node.props.scale ?? [1, 1, 1])
    object.userData = node.props.userData ?? {}
  }
  const renderer = require(reconcilerPath)({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context, getPublicInstance: (x: Host) => x.object3D ?? x,
    prepareForCommit: () => null, resetAfterCommit: () => undefined,
    createInstance: (type: string, props: any) => {
      const node: Host = { type, props, children: [], tagName: type.toUpperCase(), closest: () => null }
      if (type === 'group') node.object3D = new THREE.Group()
      if (type === 'mesh') node.object3D = new THREE.Mesh(props.geometry)
      if (type === 'points') node.object3D = new THREE.Points(props.geometry)
      if (type === 'primitive') node.object3D = props.object
      syncObject(node)
      node.focus = () => { documentEvents.activeElement = node }
      node.contains = value => value === node || (type === 'section' && value === canvas) || node.children.some(child => child.contains?.(value))
      return node
    },
    createTextInstance: (text: string) => ({ type: '#text', props: { text }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, insertBefore: insert, insertInContainerBefore: insert,
    finalizeInitialChildren: () => false, shouldSetTextContent: () => false, prepareUpdate: () => true,
    commitUpdate: (x: Host, _p: unknown, _t: string, _old: unknown, props: any) => { x.props = props; syncObject(x) },
    commitTextUpdate: (x: Host, _old: string, text: string) => { x.props.text = text },
    clearContainer: (x: Host) => { x.children = [] }, detachDeletedInstance: () => undefined,
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
  })
  const host: Host = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(host, 0, null, false, null, '', (e: unknown) => { throw e }, null)
  const flush = (fn = () => {}) => { renderer.flushSync(fn); for (let i = 0; i < 12; i++) { if (!renderer.flushPassiveEffects()) return; renderer.flushSync(() => {}) } assert.fail('Effects did not settle') }
  const render = (node: ReturnType<typeof createElement> | null) => {
    install(); flush(() => renderer.updateContainer(node, root, null))
    if (node === null) { globals.window = previous.window; globals.document = previous.document; globals.__worldsCpu = previous.cpu }
  }
  const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); flush() } }
  function find(predicate: (n: Host) => boolean, node = host): Host | undefined { if (predicate(node)) return node; for (const child of node.children) { const found = find(predicate, child); if (found) return found } }
  const text = (n: Host): string => n.type === '#text' ? n.props.text : n.children.map(text).join('')
  const button = (label: string) => { const n = find(n => n.type === 'button' && (n.props['aria-label'] === label || text(n) === label)); assert.ok(n, label); return n }
  return { render, flush, settle, find, button, camera, controls, canvas, captures, bounds, windowEvents, documentEvents, frames,
    frame: (delta = 1) => { for (const callback of frames) callback({ camera }, delta); flush() },
    click: (label: string) => { const n = button(label); assert.ok(!n.props.disabled, label); flush(() => n.props.onClick()) } }
}

test('mounted PLY fetch ignores transforms, cancels replaced loads and disposes only owned geometry', async () => {
  const { module, cleanup } = await loadViewerModule()
  const cpu = cpuHost(), previousFetch = globalThis.fetch
  const requests: Array<{ signal: AbortSignal; resolve: (r: Response) => void }> = []
  const bytes = await readFile(pointsFixture)
  globalThis.fetch = ((_url: unknown, init: RequestInit) => new Promise<Response>(resolve => requests.push({ signal: init.signal as AbortSignal, resolve }))) as typeof fetch
  const render = (value: WorldSceneItem) => cpu.render(createElement(module.WorldsViewer, { items: [value] }))
  try {
    const first = item('ply-mesh', 'blob:first'); render(first)
    render({ ...first, transform: { ...first.transform, position: [9, 0, 0] } })
    assert.equal(requests.length, 1, 'transform-only edit must not fetch or parse again')
    render({ ...first, url: 'https://example.invalid/replacement.ply' })
    assert.equal(requests[0].signal.aborted, true)
    requests[0].resolve(new Response(bytes)); await cpu.settle()
    assert.equal(cpu.find(n => n.type === 'points'), undefined)
    requests[1].resolve(new Response(bytes)); await cpu.settle()
    const node = cpu.find(n => n.type === 'points'); assert.ok(node)
    const geometry = node.props.geometry as THREE.BufferGeometry
    let disposed = 0; geometry.addEventListener('dispose', () => disposed++)
    render({ ...first, url: 'https://example.invalid/next.ply' })
    assert.equal(disposed, 1, 'replacement disposes exactly the old owned buffer')
    requests[2].resolve(new Response('failure', { status: 404 })); await cpu.settle()
    assert.ok(cpu.find(n => n.props.role === 'status'))
    render({ ...first, url: 'blob:recovered' }); requests[3].resolve(new Response(bytes)); await cpu.settle()
    const recovered = cpu.find(n => n.type === 'points'); assert.ok(recovered)
    let recoveredDisposed = 0; recovered.props.geometry.addEventListener('dispose', () => recoveredDisposed++)
    cpu.render(null); assert.equal(recoveredDisposed, 1); assert.equal(disposed, 1)
  } finally { cpu.render(null); globalThis.fetch = previousFetch; await cleanup() }
})

test('mounted GLTF instances do not share scene parents and errors recover when the URL changes', async () => {
  const { module, cleanup } = await loadViewerModule()
  const cpu = cpuHost(), scene = new THREE.Group()
  const globals = globalThis as typeof globalThis & { __worldsGltf?: (url: string) => { scene: THREE.Group } }
  const previous = globals.__worldsGltf
  globals.__worldsGltf = url => { if (url === 'bad.glb') throw new Error('Expected GLTF load error'); return { scene } }
  try {
    const a = item('glb', 'same.glb'), b = { ...a, id: 'second' }
    cpu.render(createElement(module.WorldsViewer, { items: [a, b] }))
    const one = cpu.find(n => n.type === 'primitive'); assert.ok(one)
    const two = cpu.find(n => n.type === 'primitive' && n !== one); assert.ok(two)
    assert.notEqual(one.props.object, two.props.object); assert.notEqual(one.props.object, scene)
    cpu.render(createElement(module.WorldsViewer, { items: [{ ...a, url: 'bad.glb' }] }))
    assert.ok(cpu.find(n => n.props.role === 'status'))
    cpu.render(createElement(module.WorldsViewer, { items: [{ ...a, url: 'good.glb' }] }))
    assert.ok(cpu.find(n => n.type === 'primitive'), 'changed URL resets the item error boundary')
  } finally { cpu.render(null); globals.__worldsGltf = previous; await cleanup() }
})

test('deferred PLY geometry is fitted only after mounting, then movement and reset preserve the loaded snapshot', async () => {
  const { module, cleanup } = await loadViewerModule(), cpu = cpuHost(), previousFetch = globalThis.fetch
  let resolve!: (response: Response) => void
  globalThis.fetch = (() => new Promise<Response>(r => { resolve = r })) as typeof fetch
  try {
    const value = { ...item('ply-points', 'blob:deferred'), transform: { position: [7, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } } as WorldSceneItem
    cpu.render(createElement(module.WorldsViewer, { items: [value] }))
    assert.equal(cpu.bounds.refreshes, 0, 'loading status must not become the fitted scene')
    resolve(new Response(await readFile(pointsFixture))); await cpu.settle()
    assert.ok(cpu.find(n => n.type === 'points')); assert.equal(cpu.bounds.refreshes, 1)
    const fittedPosition = cpu.camera.position.clone(), fittedTarget = cpu.controls.target.clone()
    assert.equal(fittedTarget.x, 7)
    const near = cpu.camera.near, far = cpu.camera.far, maxDistance = cpu.controls.maxDistance
    cpu.find(n => n.type === 'section')!.focus!()
    cpu.windowEvents.emit('keydown', { code: 'KeyW', target: cpu.documentEvents.activeElement }); cpu.frame(0.5)
    assert.ok(cpu.camera.position.distanceTo(fittedPosition) > 0.1)
    assert.ok(cpu.camera.position.clone().sub(fittedPosition).distanceTo(cpu.controls.target.clone().sub(fittedTarget)) < 1e-9)
    cpu.windowEvents.emit('keyup', { code: 'KeyW' })
    cpu.click('Reset camera')
    assert.deepEqual(cpu.camera.position.toArray(), fittedPosition.toArray()); assert.deepEqual(cpu.controls.target.toArray(), fittedTarget.toArray())
    assert.deepEqual([cpu.camera.near, cpu.camera.far, cpu.controls.maxDistance], [near, far, maxDistance])
    cpu.render(createElement(module.WorldsViewer, { items: [{ ...value, transform: { ...value.transform, position: [10, 0, 0] } }] }))
    assert.equal(cpu.bounds.refreshes, 1, 'transform-only render must not fight navigation')
  } finally { cpu.render(null); globalThis.fetch = previousFetch; await cleanup() }
})

test('same-identity URL replacement cannot reset to old bounds or accept a late cancelled fit', async () => {
  const { module, cleanup } = await loadViewerModule(), cpu = cpuHost(), previousFetch = globalThis.fetch
  const requests: Array<{ resolve: (response: Response) => void; signal: AbortSignal }> = []
  globalThis.fetch = ((_url: unknown, init: RequestInit) => new Promise<Response>(resolve => requests.push({ resolve, signal: init.signal as AbortSignal }))) as typeof fetch
  try {
    const first = item('ply-points', 'blob:first')
    const render = (url: string, x: number) => cpu.render(createElement(module.WorldsViewer, { items: [{ ...first, url, transform: { ...first.transform, position: [x, 0, 0] } }] }))
    render('blob:first', 0); requests[0].resolve(new Response(await readFile(pointsFixture))); await cpu.settle()
    render('blob:cancelled', 10); render('blob:latest', 20)
    assert.equal(requests[1].signal.aborted, true)
    cpu.camera.position.set(90, 80, 70); cpu.click('Reset camera')
    assert.deepEqual(cpu.camera.position.toArray(), [90, 80, 70], 'pending replacement must not restore old fit')
    requests[2].resolve(new Response(await readFile(pointsFixture))); await cpu.settle()
    assert.equal(cpu.controls.target.x, 20)
    const latest = cpu.camera.position.clone(), count = cpu.bounds.refreshes
    requests[1].resolve(new Response(await readFile(meshFixture))); await cpu.settle()
    assert.deepEqual(cpu.camera.position.toArray(), latest.toArray()); assert.equal(cpu.bounds.refreshes, count)
    cpu.camera.position.set(1, 2, 3); cpu.click('Reset camera'); assert.deepEqual(cpu.camera.position.toArray(), latest.toArray())
  } finally { cpu.render(null); globalThis.fetch = previousFetch; await cleanup() }
})

test('scene fit waits for every visible PLY geometry and includes their mounted transforms', async () => {
  const { module, cleanup } = await loadViewerModule(), cpu = cpuHost(), previousFetch = globalThis.fetch
  const requests: Array<(response: Response) => void> = []
  globalThis.fetch = (() => new Promise<Response>(resolve => requests.push(resolve))) as typeof fetch
  try {
    const first = item('ply-points', 'blob:one')
    const second = { ...item('ply-points', 'blob:two'), transform: { ...first.transform, position: [10, 0, 0] } } as WorldSceneItem
    cpu.render(createElement(module.WorldsViewer, { items: [first, second] }))
    const bytes = await readFile(pointsFixture)
    requests[1](new Response(bytes)); await cpu.settle()
    assert.equal(cpu.bounds.refreshes, 0, 'partially mounted geometry must not establish the reset snapshot')
    requests[0](new Response(bytes)); await cpu.settle()
    assert.equal(cpu.bounds.refreshes, 1)
    assert.equal(cpu.controls.target.x, 5, 'fit contains both real geometry bounds and their transforms')
  } finally { cpu.render(null); globalThis.fetch = previousFetch; await cleanup() }
})

test('failed PLY and GLTF settle without blocking fit and reset of valid geometry while other loads remain pending', async () => {
  const { module, cleanup } = await loadViewerModule(), cpu = cpuHost(), previousFetch = globalThis.fetch
  const globals = globalThis as typeof globalThis & { __worldsGltf?: (url: string) => { scene: THREE.Group } }
  const previousGltf = globals.__worldsGltf
  const requests: Array<(response: Response) => void> = []
  globalThis.fetch = (() => new Promise<Response>(resolve => requests.push(resolve))) as typeof fetch
  globals.__worldsGltf = () => { throw new Error('Expected GLTF failure') }
  try {
    const valid = { ...item('ply-points', 'blob:valid'), transform: { position: [7, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } } as WorldSceneItem
    cpu.render(createElement(module.WorldsViewer, { items: [valid, item('ply-points', 'blob:failed'), item('ply-points', 'blob:pending'), item('glb', 'bad.glb')] }))
    requests[0](new Response(await readFile(pointsFixture))); await cpu.settle()
    requests[1](new Response('failure', { status: 404 })); await cpu.settle()
    assert.equal(cpu.bounds.refreshes, 0, 'failed loads settle but cannot bypass another pending load')
    requests[2](new Response('failure', { status: 404 })); await cpu.settle()
    assert.equal(cpu.bounds.refreshes, 1)
    assert.equal(cpu.controls.target.x, 7, 'only valid mounted geometry contributes to the fitted bounds')
    const fitted = cpu.camera.position.clone(), target = cpu.controls.target.clone()
    cpu.camera.position.set(90, 80, 70); cpu.click('Reset camera')
    assert.deepEqual(cpu.camera.position.toArray(), fitted.toArray())
    assert.deepEqual(cpu.controls.target.toArray(), target.toArray())
  } finally { cpu.render(null); globalThis.fetch = previousFetch; globals.__worldsGltf = previousGltf; await cleanup() }
})

test('left drag explicitly focuses the viewer for keyboard movement while right drag remains native', async () => {
  const { module, cleanup } = await loadViewerModule(), cpu = cpuHost()
  try {
    cpu.render(createElement(module.WorldsViewer, { items: [] }))
    const section = cpu.find(n => n.type === 'section')!
    const right = cpu.canvas.emit('pointerdown', { button: 2, buttons: 2 })
    assert.equal(right.prevented, false); assert.equal(right.stopped, false)
    const left = cpu.canvas.emit('pointerdown')
    assert.equal(cpu.documentEvents.activeElement, section, 'captured left drag must not rely on stopped bubbling to focus')
    assert.equal(left.prevented, false); assert.equal(cpu.captures.size, 0, 'a click remains available for selection')
    const drag = cpu.canvas.emit('pointermove', { clientX: 4, movementX: 4 }); assert.equal(drag.prevented, true); assert.ok(cpu.captures.has(1))
    const before = cpu.camera.position.clone()
    cpu.windowEvents.emit('keydown', { code: 'KeyW', target: section }); cpu.frame(0.1)
    assert.ok(cpu.camera.position.distanceTo(before) > 0)
  } finally { cpu.render(null); assert.equal(cpu.canvas.listenerCount, 0); assert.equal(cpu.windowEvents.listenerCount, 0); assert.equal(cpu.documentEvents.listenerCount, 0); assert.equal(cpu.frames.size, 0); assert.equal(cpu.captures.size, 0); await cleanup() }
})

test('mouse look owns one pointer, clamps pitch and releases on cancel, lost capture and unmount', async () => {
  const { module, cleanup } = await loadViewerModule(), cpu = cpuHost()
  try {
    cpu.render(createElement(module.WorldsViewer, { items: [] }))
    cpu.canvas.emit('pointerdown', { pointerId: 7 })
    const before = cpu.camera.quaternion.clone()
    cpu.canvas.emit('pointermove', { pointerId: 8, movementX: 100 })
    assert.ok(cpu.camera.quaternion.equals(before), 'another pointer cannot move the owned camera')
    cpu.canvas.emit('pointermove', { pointerId: 7, clientX: 4, movementX: 30, movementY: 100000 })
    const pitch = new THREE.Euler().setFromQuaternion(cpu.camera.quaternion, 'YXZ').x
    assert.ok(Math.abs(pitch) <= Math.PI / 2 - 0.05 + 1e-9)
    const direction = cpu.camera.getWorldDirection(new THREE.Vector3())
    assert.ok(direction.distanceTo(cpu.controls.target.clone().sub(cpu.camera.position).normalize()) < 1e-9)
    cpu.canvas.emit('pointercancel', { pointerId: 7 }); assert.equal(cpu.captures.size, 0)
    const cancelled = cpu.camera.quaternion.clone(); cpu.canvas.emit('pointermove', { pointerId: 7, movementX: 30 }); assert.ok(cpu.camera.quaternion.equals(cancelled))
    cpu.canvas.emit('pointerdown', { pointerId: 9 }); cpu.captures.delete(9); cpu.canvas.emit('lostpointercapture', { pointerId: 9 })
    cpu.canvas.emit('pointermove', { pointerId: 9, movementX: 30 }); assert.ok(cpu.camera.quaternion.equals(cancelled))
    cpu.canvas.emit('pointerdown', { pointerId: 10 }); cpu.canvas.emit('pointermove', { pointerId: 10, clientX: 4 }); assert.ok(cpu.captures.has(10)); cpu.render(null); assert.equal(cpu.captures.size, 0)
  } finally { cpu.render(null); await cleanup() }
})

test('keyboard aliases remain independently held and blur prevents stuck movement', async () => {
  const { module, cleanup } = await loadViewerModule(), cpu = cpuHost()
  try {
    cpu.render(createElement(module.WorldsViewer, { items: [] })); const section = cpu.find(n => n.type === 'section')!; section.focus!()
    cpu.windowEvents.emit('keydown', { code: 'KeyW', target: section }); cpu.windowEvents.emit('keydown', { code: 'ArrowUp', target: section }); cpu.windowEvents.emit('keyup', { code: 'KeyW' })
    const before = cpu.camera.position.clone(); cpu.frame(0.1)
    assert.ok(cpu.camera.position.distanceTo(before) > 0, 'ArrowUp remains held after W release')
    cpu.windowEvents.emit('blur'); section.focus!(); const blurred = cpu.camera.position.clone(); cpu.frame(0.1)
    assert.deepEqual(cpu.camera.position.toArray(), blurred.toArray())
    cpu.windowEvents.emit('keydown', { code: 'KeyW', target: section }); cpu.documentEvents.emit('visibilitychange'); cpu.frame(0.1)
    assert.deepEqual(cpu.camera.position.toArray(), blurred.toArray())
    cpu.windowEvents.emit('keydown', { code: 'KeyW', target: section })
    cpu.documentEvents.activeElement = { tagName: 'INPUT' }; cpu.documentEvents.emit('focusin')
    section.focus!(); cpu.frame(0.1)
    assert.deepEqual(cpu.camera.position.toArray(), blurred.toArray(), 'returning from editable focus must not restore previously held keys')
  } finally { cpu.render(null); await cleanup() }
})

test('overlay and editable or dialog focus keep their native keyboard and pointer ownership', async () => {
  const { module, cleanup } = await loadViewerModule(), cpu = cpuHost()
  try {
    cpu.render(createElement(module.WorldsViewer, { items: [] })); const section = cpu.find(n => n.type === 'section')!, select = cpu.find(n => n.type === 'select')!
    select.focus!(); section.props.onPointerDown?.({ target: select, currentTarget: section })
    assert.equal(cpu.documentEvents.activeElement, select, 'selector click must retain focus')
    for (const target of [select, cpu.button('Reset camera'), { tagName: 'INPUT' }, { tagName: 'DIV', isContentEditable: true }, { tagName: 'DIV', closest: () => ({ role: 'dialog' }) }]) {
      cpu.documentEvents.activeElement = target
      const before = cpu.camera.position.clone(), event = cpu.windowEvents.emit('keydown', { code: 'Space', target })
      cpu.frame(0.1); assert.equal(event.prevented, false); assert.deepEqual(cpu.camera.position.toArray(), before.toArray())
      cpu.windowEvents.emit('keyup', { code: 'Space' })
    }
  } finally { cpu.render(null); await cleanup() }
})
