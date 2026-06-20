import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { createElement } from 'react'
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

test('WorldsKeyboardCameraControls uses scoped key refs, useFrame movement, and moves the orbit target with the camera', async () => {
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
    assert.equal(mouseLookControlsSource.includes('event.stopImmediatePropagation()'), true)
    assert.equal(mouseLookControlsSource.includes('camera.quaternion.setFromEuler'), true)
    assert.equal(mouseLookControlsSource.includes('controls.target.copy'), true)
    assert.equal(mouseLookControlsSource.includes('WORLD_CAMERA_LOOK_PITCH_LIMIT'), true)
    assert.equal(viewerSource.includes('enableRotate: false'), true)
    assert.equal(viewerSource.includes('<WorldsMouseLookCameraControls inputScopeRef={inputScopeRef} orbitControlsRef={orbitControlsRef} />'), true)
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
    assert.equal(viewerSource.includes('cameraFitSnapshotRef.current = snapshot'), true)
    assert.equal(viewerSource.includes('controls.target.copy(snapshot.target)'), true)
    assert.equal(viewerSource.includes('controls.saveState?.()'), true)
    assert.equal(viewerSource.includes('refresh().clip().fit()'), false)
    assert.equal(viewerSource.includes('createWorldsSceneFitKey(visibleItems, cameraState.resetToken)'), false)
    assert.equal(viewerSource.includes('createWorldsSceneFitKey(visibleItems)'), true)
  } finally {
    await cleanup()
  }
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
      helpText: 'Left-drag look · Right-drag pan · Wheel zoom · WASD/Arrows move · Space/E up · Q/Shift down',
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
    assert.match(markup, /Left-drag look · Right-drag pan · Wheel zoom · WASD\/Arrows move · Space\/E up · Q\/Shift down/)
    assert.doesNotMatch(markup, /<aside|Inspector|side panel/i)
  } finally {
    await cleanup()
  }
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
