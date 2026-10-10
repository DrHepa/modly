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
    assert.equal(module.createWorldsSceneFitKey([item('ply-mesh', 'mesh.ply'), item('glb', 'scene.glb')]), JSON.stringify([JSON.stringify(['world:mesh.ply', 'mesh.ply', 'mesh.ply', 'ply-mesh']), JSON.stringify(['world:scene.glb', 'scene.glb', 'scene.glb', 'glb'])]))
    assert.equal(module.createWorldsSceneFitKey([{ ...item('ply-mesh', 'hidden.ply'), visible: false }, item('gltf', 'visible.gltf')]), module.createWorldsSceneFitKey([item('gltf', 'visible.gltf')]))
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
function cpuHost({ strictEffects = false }: { strictEffects?: boolean } = {}) {
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
  const root = renderer.createContainer(host, strictEffects ? 1 : 0, null, strictEffects, null, '', (e: unknown) => { throw e }, null)
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

test('WorldsViewer instance construction is render-pure and cloned-material disposal is idempotent', async () => {
  const { module, cleanup } = await loadViewerModule()
  const source = new THREE.Group(), material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide })
  const geometry = new THREE.BoxGeometry() as THREE.BufferGeometry & { boundsTree?: unknown; computeBoundsTree?: () => void }
  let builds = 0, sourceDisposals = 0, cloneDisposals = 0
  geometry.computeBoundsTree = () => { builds++; geometry.boundsTree = {} }
  material.addEventListener('dispose', () => sourceDisposals++)
  source.add(new THREE.Mesh(geometry, material))
  try {
    const instance = module.createWorldsGltfSceneInstance(source)
    const clone = instance.scene.children[0] as THREE.Mesh
    ;(clone.material as THREE.Material).addEventListener('dispose', () => cloneDisposals++)
    assert.notEqual(instance.scene, source); assert.notEqual(clone.material, material)
    assert.equal(clone.geometry, geometry)
    await Promise.resolve()
    assert.equal(builds, 0, 'uncommitted render must not acquire cached geometry acceleration')
    assert.equal(geometry.boundsTree, undefined)
    assert.equal(material.side, THREE.FrontSide)
    instance.dispose(); instance.dispose()
    assert.equal(cloneDisposals, 1); assert.equal(sourceDisposals, 0)
  } finally { geometry.dispose(); material.dispose(); await cleanup() }
})

test('mounted Worlds GLTF reacquires deferred BVH through real StrictEffects replay without disposing its live material', async () => {
  const { module, cleanup } = await loadViewerModule(), cpu = cpuHost({ strictEffects: true })
  const globals = globalThis as any, previousGltf = globals.__worldsGltf
  const source = new THREE.Group(), material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide })
  const geometry = new THREE.BoxGeometry() as THREE.BufferGeometry & { boundsTree?: unknown; computeBoundsTree?: (options: unknown) => void; disposeBoundsTree?: () => void }
  let builds = 0, releases = 0, sourceDisposals = 0, setups = 0, cleanups = 0
  const cloneDisposals = new Map<THREE.Material, number>(), idle: Array<() => void> = [], cancelled = new Set<number>()
  const originalClone = material.clone.bind(material)
  material.clone = () => {
    const clone = originalClone(); cloneDisposals.set(clone, 0)
    clone.addEventListener('dispose', () => cloneDisposals.set(clone, cloneDisposals.get(clone)! + 1))
    return clone
  }
  material.addEventListener('dispose', () => sourceDisposals++)
  geometry.computeBoundsTree = options => { assert.deepEqual(options, { indirect: true }); builds++; geometry.boundsTree = {} }
  geometry.disposeBoundsTree = () => { releases++; delete geometry.boundsTree }
  source.add(new THREE.Mesh(geometry, material))
  Object.assign(cpu.windowEvents, {
    requestIdleCallback: (callback: () => void) => { idle.push(callback); return idle.length },
    cancelIdleCallback: (id: number) => { cancelled.add(id) },
  })
  globals.__worldsGltf = () => ({ scene: source })
  function ReplayProbe() { React.useEffect(() => { setups++; return () => { cleanups++ } }, []); return null }
  try {
    cpu.render(createElement(React.Fragment, null, createElement(ReplayProbe), createElement(module.WorldsViewer, { items: [item('glb', 'synthetic.glb')] })))
    assert.equal(setups, 2); assert.equal(cleanups, 1, 'positive control must prove real effect replay, not a normal remount')
    const primitive = cpu.find(n => n.type === 'primitive'); assert.ok(primitive)
    const mountedScene = primitive.props.object as THREE.Group, mountedMaterial = (mountedScene.children[0] as THREE.Mesh).material as THREE.Material
    assert.notEqual(mountedScene, source); assert.equal(source.parent, null)
    await cpu.settle()
    assert.equal(cloneDisposals.get(mountedMaterial), 0, 'cleanup replay must not dispose the still-mounted material')
    assert.equal(builds, 0); assert.ok(cancelled.size > 0, 'replay must cancel the first effect-owned task')
    idle.forEach(callback => callback()) // Deliberately deliver cancelled callbacks too.
    assert.equal(builds, 1); assert.ok(geometry.boundsTree)
    cpu.render(null); await cpu.settle()
    assert.equal(releases, 1); assert.equal(geometry.boundsTree, undefined)
    assert.equal(cloneDisposals.get(mountedMaterial), 1); assert.equal(sourceDisposals, 0)
    assert.equal(material.side, THREE.FrontSide); assert.equal(cleanups, 2)
    idle.forEach(callback => callback()); assert.equal(builds, 1, 'late callbacks after unmount must not resurrect acceleration')
  } finally { cpu.render(null); globals.__worldsGltf = previousGltf; geometry.dispose(); material.dispose(); await cleanup() }
})

test('WorldsViewer scheduled BVH cancellation releases exact shared owners and preserves foreign replacement trees', async () => {
  const { module, cleanup } = await loadViewerModule()
  const geometry = new THREE.BoxGeometry() as THREE.BufferGeometry & { boundsTree?: unknown; computeBoundsTree?: (options: unknown) => void; disposeBoundsTree?: () => void }
  const material = new THREE.MeshBasicMaterial(), source = new THREE.Group(), scheduled: Array<() => void> = []
  let builds = 0, releases = 0
  geometry.computeBoundsTree = options => { assert.deepEqual(options, { indirect: true }); builds++; geometry.boundsTree = { build: builds } }
  geometry.disposeBoundsTree = () => { releases++; delete geometry.boundsTree }
  source.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material))
  const schedule = (callback: () => void) => { scheduled.push(callback); return { cancel: () => undefined } }
  try {
    const a = module.scheduleWorldsSceneBoundsTreeBuild(source, schedule), b = module.scheduleWorldsSceneBoundsTreeBuild(source, schedule)
    scheduled.splice(0).forEach(run => run()); assert.equal(builds, 1)
    a.cancel(); a.release(); assert.equal(releases, 0, 'one live shared owner remains')
    b.cancel(); b.release(); assert.equal(releases, 1, 'cancel after build must release, not leak')
    const c = module.scheduleWorldsSceneBoundsTreeBuild(source, schedule)
    scheduled.splice(0).forEach(run => run())
    const foreign = {}; geometry.boundsTree = foreign; c.release()
    assert.equal(geometry.boundsTree, foreign); assert.equal(releases, 1)
    const d = module.scheduleWorldsSceneBoundsTreeBuild(source, schedule)
    scheduled.splice(0).forEach(run => run()); d.release()
    assert.equal(geometry.boundsTree, foreign); assert.equal(builds, 2, 'foreign tree must never be claimed')
    delete geometry.boundsTree
    const old = module.scheduleWorldsSceneBoundsTreeBuild(source, schedule)
    scheduled.splice(0).forEach(run => run()); delete geometry.boundsTree
    const fresh = module.scheduleWorldsSceneBoundsTreeBuild(source, schedule)
    scheduled.splice(0).forEach(run => run()); const freshTree = geometry.boundsTree
    old.release(); assert.equal(geometry.boundsTree, freshTree); assert.equal(releases, 1, 'stale task must not decrement a new tree owner')
    fresh.release(); assert.equal(releases, 2); assert.equal(geometry.boundsTree, undefined)
  } finally { geometry.dispose(); material.dispose(); await cleanup() }
})

test('WorldsViewer installed BVH construction keeps synthetic authored index and position buffers intact', async () => {
  const { module, cleanup } = await loadViewerModule(), geometry = new THREE.BufferGeometry()
  const positions: number[] = [], indices: number[] = []
  for (let i = 0; i < 48; i++) { const x = (i * 17) % 48; positions.push(x, 0, 0, x + 0.4, 0, 0, x, 0.4, 0); indices.push(i * 3, i * 3 + 1, i * 3 + 2) }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices)
  const index = geometry.index!, position = geometry.getAttribute('position'), authoredIndices = Array.from(index.array), authoredPositions = Array.from(position.array)
  let geometryDisposals = 0; geometry.addEventListener('dispose', () => geometryDisposals++)
  try {
    assert.equal(module.acquireWorldsManagedBoundsTree(geometry), true)
    assert.ok((geometry as any).boundsTree, 'positive control must build the installed BVH, not a fake')
    assert.equal(geometry.index, index); assert.equal(geometry.getAttribute('position'), position)
    assert.deepEqual(Array.from(index.array), authoredIndices); assert.deepEqual(Array.from(position.array), authoredPositions)
    assert.equal(module.releaseWorldsManagedBoundsTree(geometry), true)
    assert.equal((geometry as any).boundsTree, null); assert.equal(geometryDisposals, 0, 'shared geometry is borrowed, never disposed')
  } finally { module.releaseWorldsManagedBoundsTree(geometry); geometry.dispose(); await cleanup() }
})

test('WorldsViewer optional BVH failures preserve valid sibling acceleration and ordinary mesh raycasting', async t => {
  const { module, cleanup } = await loadViewerModule(), source = new THREE.Group(), material = new THREE.MeshBasicMaterial()
  const rejected = new THREE.BoxGeometry() as THREE.BufferGeometry & { computeBoundsTree?: () => void }, valid = new THREE.BoxGeometry() as THREE.BufferGeometry & { boundsTree?: unknown; computeBoundsTree?: (options: unknown) => void; disposeBoundsTree?: () => void }
  const warnings: unknown[][] = [], scheduled: Array<() => void> = []; let releases = 0
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
  rejected.computeBoundsTree = () => { throw new Error('Synthetic unsupported geometry') }
  valid.computeBoundsTree = options => { assert.deepEqual(options, { indirect: true }); valid.boundsTree = {} }
  valid.disposeBoundsTree = () => { releases++; delete valid.boundsTree }
  const rejectedMesh = new THREE.Mesh(rejected, material); source.add(rejectedMesh, new THREE.Mesh(valid, material))
  try {
    const task = module.scheduleWorldsSceneBoundsTreeBuild(source, callback => { scheduled.push(callback); return { cancel: () => undefined } })
    assert.doesNotThrow(() => scheduled[0]()); assert.equal(warnings.length, 1); assert.ok(valid.boundsTree)
    const hits = new THREE.Raycaster(new THREE.Vector3(0, 0, 2), new THREE.Vector3(0, 0, -1)).intersectObject(rejectedMesh)
    assert.ok(hits.length > 0, 'failed optional acceleration retains installed fallback raycasting')
    task.release(); assert.equal(releases, 1)
  } finally { rejected.dispose(); valid.dispose(); material.dispose(); await cleanup() }
})

test('WorldsViewer authored initial view survives deferred GLTF and PLY settlement, navigation and reset', async () => {
  const { module, cleanup } = await loadViewerModule(), cpu = cpuHost(), previousFetch = globalThis.fetch
  const globals = globalThis as any, previousGltf = globals.__worldsGltf, scene = new THREE.Group()
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial(); scene.add(new THREE.Mesh(geometry, material))
  let gltfReady = false, resolveGltf!: () => void, resolvePly!: (response: Response) => void
  const pendingGltf = new Promise<void>(resolve => { resolveGltf = resolve })
  globals.__worldsGltf = () => { if (!gltfReady) throw pendingGltf; return { scene } }
  globalThis.fetch = (() => new Promise<Response>(resolve => { resolvePly = resolve })) as typeof fetch
  const initialView = { position: [30, 20, 40], target: [7, 1, -3], up: [0, 1, 0] } as const
  try {
    cpu.render(createElement(module.WorldsViewer, { items: [item('glb', 'delayed.glb'), item('ply-points', 'blob:delayed')], initialView }))
    assert.equal(cpu.bounds.refreshes, 0)
    resolvePly(new Response(await readFile(pointsFixture))); await cpu.settle()
    assert.equal(cpu.bounds.refreshes, 0, 'one real mounted PLY must not bypass pending GLTF')
    gltfReady = true; resolveGltf(); await cpu.settle()
    assert.ok(cpu.find(n => n.type === 'primitive')); assert.ok(cpu.bounds.refreshes > 0)
    assert.deepEqual(cpu.camera.position.toArray(), initialView.position); assert.deepEqual(cpu.controls.target.toArray(), initialView.target)
    cpu.camera.position.set(90, 80, 70); cpu.controls.target.set(9, 8, 7); cpu.click('Reset camera')
    assert.deepEqual(cpu.camera.position.toArray(), initialView.position); assert.deepEqual(cpu.controls.target.toArray(), initialView.target)
  } finally { cpu.render(null); globalThis.fetch = previousFetch; globals.__worldsGltf = previousGltf; geometry.dispose(); material.dispose(); await cleanup() }
})
