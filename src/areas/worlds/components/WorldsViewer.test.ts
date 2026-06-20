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
        export const Bounds = Canvas, Html = Canvas, GizmoHelper = Canvas
        export const GizmoViewport = () => null
        export const useThree = () => globalThis.__worldsCpu
        export const useBounds = () => globalThis.__worldsCpu.bounds
        export const useFrame = callback => { useEffect(() => { const frames = globalThis.__worldsCpu.frames; frames.add(callback); return () => frames.delete(callback) }) }
        export const OrbitControls = forwardRef((_props, ref) => { useImperativeHandle(ref, () => globalThis.__worldsCpu.controls); return null })
        export const useGLTF = url => globalThis.__worldsGltf(url)
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
// Real React lifecycle on a CPU mutation host; the canvas alone is substituted.
type Host = { type: string; props: any; children: Host[]; tagName?: string; focus?: () => void; contains?: (value: unknown) => boolean; closest?: () => null }
class CpuEvents {
  listeners = new Map<string, Set<(event: any) => void>>()
  addEventListener(type: string, callback: (event: any) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(callback); this.listeners.set(type, set) }
  removeEventListener(type: string, callback: (event: any) => void) { this.listeners.get(type)?.delete(callback) }
  emit(type: string, props: Record<string, unknown> = {}) {
    const event = { type, target: this, pointerId: 1, button: 0, buttons: 1, movementX: 0, movementY: 0, prevented: false, stopped: false,
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
    const visit = (node: Host) => {
      const geometry = node.props.geometry as THREE.BufferGeometry | undefined
      if (geometry) {
        geometry.computeBoundingBox()
        if (geometry.boundingBox) {
          const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...(node.props.position ?? [0, 0, 0]) as [number, number, number]), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(node.props.rotation ?? [0, 0, 0]) as [number, number, number])), new THREE.Vector3(...(node.props.scale ?? [1, 1, 1]) as [number, number, number]))
          this.box.union(geometry.boundingBox.clone().applyMatrix4(matrix))
        }
      }
      if (node.props.object instanceof THREE.Object3D) this.box.union(new THREE.Box3().setFromObject(node.props.object))
      node.children.forEach(visit)
    }
    visit(host); return this
  }, getSize() { return { box: this.box.clone(), center: this.box.getCenter(new THREE.Vector3()), distance: this.box.getSize(new THREE.Vector3()).length() * 2 } } }
  const state = { camera, controls, frames, bounds, gl: { domElement: canvas } }
  const install = () => { globals.window = windowEvents; globals.document = documentEvents; globals.__worldsCpu = state }
  install()
  const reconcilerPath = fileURLToPath(import.meta.resolve('react-reconciler'))
  assert.equal(reconcilerPath, path.join(projectRoot, 'node_modules/react-reconciler/index.js'))
  const require = createRequire(reconcilerPath)
  assert.equal(require('react'), React)
  const context = {}
  const remove = (p: Host, c: Host) => { const i = p.children.indexOf(c); if (i >= 0) p.children.splice(i, 1) }
  const append = (p: Host, c: Host) => { remove(p, c); p.children.push(c) }
  const insert = (p: Host, c: Host, b: Host) => { remove(p, c); p.children.splice(p.children.indexOf(b), 0, c) }
  const renderer = require(reconcilerPath)({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context, getPublicInstance: (x: Host) => x,
    prepareForCommit: () => null, resetAfterCommit: () => undefined,
    createInstance: (type: string, props: any) => {
      const node: Host = { type, props, children: [], tagName: type.toUpperCase(), closest: () => null }
      node.focus = () => { documentEvents.activeElement = node }
      node.contains = value => value === node || (type === 'section' && value === canvas) || node.children.some(child => child.contains?.(value))
      return node
    },
    createTextInstance: (text: string) => ({ type: '#text', props: { text }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, insertBefore: insert, insertInContainerBefore: insert,
    finalizeInitialChildren: () => false, shouldSetTextContent: () => false, prepareUpdate: () => true,
    commitUpdate: (x: Host, _p: unknown, _t: string, _old: unknown, props: any) => { x.props = props },
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
    assert.equal(left.prevented, true); assert.ok(cpu.captures.has(1))
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
    cpu.canvas.emit('pointermove', { pointerId: 7, movementX: 30, movementY: 100000 })
    const pitch = new THREE.Euler().setFromQuaternion(cpu.camera.quaternion, 'YXZ').x
    assert.ok(Math.abs(pitch) <= Math.PI / 2 - 0.05 + 1e-9)
    const direction = cpu.camera.getWorldDirection(new THREE.Vector3())
    assert.ok(direction.distanceTo(cpu.controls.target.clone().sub(cpu.camera.position).normalize()) < 1e-9)
    cpu.canvas.emit('pointercancel', { pointerId: 7 }); assert.equal(cpu.captures.size, 0)
    const cancelled = cpu.camera.quaternion.clone(); cpu.canvas.emit('pointermove', { pointerId: 7, movementX: 30 }); assert.ok(cpu.camera.quaternion.equals(cancelled))
    cpu.canvas.emit('pointerdown', { pointerId: 9 }); cpu.captures.delete(9); cpu.canvas.emit('lostpointercapture', { pointerId: 9 })
    cpu.canvas.emit('pointermove', { pointerId: 9, movementX: 30 }); assert.ok(cpu.camera.quaternion.equals(cancelled))
    cpu.canvas.emit('pointerdown', { pointerId: 10 }); cpu.render(null); assert.equal(cpu.captures.size, 0)
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
