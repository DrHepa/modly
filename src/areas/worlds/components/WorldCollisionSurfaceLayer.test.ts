import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build, type Plugin } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createWorldCollisionSurfacePreset } from '../worldsCollisionSurfaces.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const componentEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldCollisionSurfaceLayer.tsx')

function stubDreiPlugin(): Plugin {
  return {
    name: 'stub-drei-transform-controls',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@react-three\/drei$/ }, () => ({ path: 'drei-transform-controls-stub', namespace: 'stub' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'tsx',
        contents: `
          import { createElement } from 'react'
          export function TransformControls(props) {
            return createElement('transform-controls', {
              'data-mode': props.mode,
              'data-space': props.space,
              showX: String(props.showX),
              showY: String(props.showY),
              showZ: String(props.showZ),
            })
          }
        `,
      }))
    },
  }
}

async function loadCollisionSurfaceLayerModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-world-collision-surface-layer-test-'))
  const outfile = path.join(tempDir, 'WorldCollisionSurfaceLayer.bundle.mjs')
  const result = await build({
    entryPoints: [componentEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [stubDreiPlugin()],
    external: ['react', 'react-dom/server', 'react/jsx-runtime', 'three'],
  })
  await writeFile(outfile, result.outputFiles[0].text)
  return {
    source: result.outputFiles[0].text,
    componentSource: await readFile(componentEntry, 'utf8'),
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

test('WorldCollisionSurfaceLayer returns no render contract when edit mode is disabled', async () => {
  const { module, cleanup } = await loadCollisionSurfaceLayerModule()

  try {
    const floor = createWorldCollisionSurfacePreset('floor', { id: 'floor-1' })!
    const model = module.describeWorldCollisionSurfaceLayerModel({
      editMode: false,
      surfaces: [floor],
      selectedSurfaceId: floor.id,
      transformMode: 'translate',
    })
    const markup = renderToStaticMarkup(createElement(module.WorldCollisionSurfaceLayer, {
      editMode: false,
      surfaces: [floor],
      selectedSurfaceId: floor.id,
      transformMode: 'translate',
      onSelectSurface: () => undefined,
      onTransformSurface: () => undefined,
    }))

    assert.deepEqual(model.surfaces, [])
    assert.equal(model.gizmoSurfaceId, null)
    assert.equal(markup, '')
  } finally {
    await cleanup()
  }
})

test('WorldCollisionSurfaceLayer builds flat rect vertices and corners from half extents', async () => {
  const { module, cleanup } = await loadCollisionSurfaceLayerModule()

  try {
    const rect = module.buildRectCollisionSurfaceGeometryData({ halfWidth: 2, halfHeight: 1 })
    assert.deepEqual(rect.corners, [
      [-2, -1],
      [-2, 1],
      [2, 1],
      [2, -1],
    ])
    assert.deepEqual(rect.positions, [
      -2, 0, -1,
      -2, 0, 1,
      2, 0, 1,
      2, 0, -1,
    ])
    assert.deepEqual(rect.indices, [0, 1, 2, 0, 2, 3])
    assert.deepEqual(rect.outlinePositions, rect.positions)
    assert.equal(rect.positions.every((_, index) => index % 3 !== 1 || rect.positions[index] === 0), true)
  } finally {
    await cleanup()
  }
})

test('WorldCollisionSurfaceLayer builds flat triangles with stable winding', async () => {
  const { module, cleanup } = await loadCollisionSurfaceLayerModule()

  try {
    const tri = module.buildTriCollisionSurfaceGeometryData([
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
    ])
    assert.deepEqual(tri.vertices, [
      [-0.5, -0.5],
      [-0.5, 0.5],
      [0.5, -0.5],
    ])
    assert.deepEqual(tri.positions, [
      -0.5, 0, -0.5,
      -0.5, 0, 0.5,
      0.5, 0, -0.5,
    ])
    assert.deepEqual(tri.indices, [0, 1, 2])
  } finally {
    await cleanup()
  }
})

test('WorldCollisionSurfaceLayer routes rect and tri surfaces through separate render models', async () => {
  const { module, cleanup } = await loadCollisionSurfaceLayerModule()

  try {
    const rect = createWorldCollisionSurfacePreset('square', { id: 'rect-1' })!
    const tri = createWorldCollisionSurfacePreset('triangle', { id: 'tri-1' })!
    const model = module.describeWorldCollisionSurfaceLayerModel({
      editMode: true,
      surfaces: [rect, tri],
      selectedSurfaceId: 'tri-1',
      transformMode: null,
    })

    assert.deepEqual(model.surfaces.map((surface: { id: string; shape: string }) => [surface.id, surface.shape]), [
      ['rect-1', 'rect'],
      ['tri-1', 'tri'],
    ])
  } finally {
    await cleanup()
  }
})

test('WorldCollisionSurfaceLayer resolves a single gizmo target for the selected surface', async () => {
  const { module, componentSource, cleanup } = await loadCollisionSurfaceLayerModule()

  try {
    const rect = createWorldCollisionSurfacePreset('square', { id: 'rect-1' })!
    const tri = createWorldCollisionSurfacePreset('triangle', { id: 'tri-1' })!
    const model = module.describeWorldCollisionSurfaceLayerModel({
      editMode: true,
      surfaces: [rect, tri],
      selectedSurfaceId: 'tri-1',
      transformMode: 'translate',
    })
    assert.equal(model.gizmoSurfaceId, 'tri-1')
    assert.deepEqual(model.surfaces.filter((surface: { selected: boolean }) => surface.selected).map((surface: { id: string }) => surface.id), ['tri-1'])
    assert.equal(componentSource.includes('layerModel.gizmoSurfaceId && selectedRootObject && layerModel.transformMode ? ('), true)
    assert.equal(componentSource.includes('<TransformControls'), true)
  } finally {
    await cleanup()
  }
})

test('WorldCollisionSurfaceLayer hides scale Y and normalizes emitted scale.y to 1', async () => {
  const { module, componentSource, cleanup } = await loadCollisionSurfaceLayerModule()

  try {
    const rect = createWorldCollisionSurfacePreset('square', { id: 'rect-1' })!
    const axes = module.resolveWorldCollisionSurfaceTransformAxisVisibility('scale')
    const normalized = module.normalizeWorldCollisionSurfaceObjectTransform({
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0.1, y: 0.2, z: 0.3 },
      scale: { x: 0, y: 9, z: -2 },
    })
    assert.deepEqual(axes, { showX: true, showY: false, showZ: true })
    assert.deepEqual(normalized.scale, [module.WORLD_COLLISION_SURFACE_MIN_SCALE, 1, 2])
    assert.equal(componentSource.includes('showY={layerModel.transformAxes.showY}'), true)
  } finally {
    await cleanup()
  }
})

test('WorldCollisionSurfaceLayer keeps parent transform callbacks on mouse up and not per object change', async () => {
  const { source, componentSource, cleanup } = await loadCollisionSurfaceLayerModule()

  try {
    assert.match(componentSource, /onObjectChange=\{\(\) => \{\s*if \(transformMode === 'scale' && selectedRootObject\) enforceWorldCollisionSurfacePlanarScale\(selectedRootObject\)\s*\}\}/)
    assert.match(componentSource, /onMouseUp=\{\(\) => \{[\s\S]*onTransformSurface\(layerModel\.gizmoSurfaceId, normalizeWorldCollisionSurfaceObjectTransform\(selectedRootObject\)\)/)
    const onObjectChangeBlock = componentSource.match(/onObjectChange=\{\(\) => \{[\s\S]*?\}\}/)?.[0] ?? ''
    assert.equal(onObjectChangeBlock.includes('onTransformSurface('), false)
    assert.equal(source.includes('onTransformSurface(layerModel.gizmoSurfaceId, normalizeWorldCollisionSurfaceObjectTransform(selectedRootObject))'), true)
  } finally {
    await cleanup()
  }
})

test('WorldCollisionSurfaceLayer guards click selection through the supplied handler', async () => {
  const { module, cleanup } = await loadCollisionSurfaceLayerModule()

  try {
    const selections: string[] = []
    assert.equal(module.guardSelectWorldCollisionSurface({
      selectedSurfaceId: 'tri-1',
      surfaceId: 'tri-1',
      onSelectSurface: (surfaceId: string) => selections.push(surfaceId),
    }), false)
    assert.equal(module.guardSelectWorldCollisionSurface({
      selectedSurfaceId: 'rect-1',
      surfaceId: 'tri-1',
      onSelectSurface: (surfaceId: string) => selections.push(surfaceId),
    }), true)
    assert.deepEqual(selections, ['tri-1'])
  } finally {
    await cleanup()
  }
})

test('WorldCollisionSurfaceLayer uses flat fill and outline geometry without box primitives or debug overlays', async () => {
  const { componentSource, cleanup } = await loadCollisionSurfaceLayerModule()

  try {
    assert.equal(componentSource.includes('<lineLoop'), true)
    assert.equal(componentSource.includes('boxGeometry'), false)
    assert.equal(componentSource.includes('Html'), false)
    assert.equal(componentSource.includes('center'), false)
    assert.equal(componentSource.includes('debug'), false)
    assert.equal(componentSource.includes('label'), false)
  } finally {
    await cleanup()
  }
})

test('WorldCollisionSurfaceLayer exposes geometry and material cleanup helpers for owned resources', async () => {
  const { module, componentSource, cleanup } = await loadCollisionSurfaceLayerModule()

  try {
    const rect = createWorldCollisionSurfacePreset('square', { id: 'rect-1' })!
    const model = module.describeWorldCollisionSurfaceLayerModel({
      editMode: true,
      surfaces: [rect],
      selectedSurfaceId: 'rect-1',
      transformMode: null,
    })
    const resources = module.createWorldCollisionSurfaceRenderResources(model.surfaces[0])
    const materials = module.createWorldCollisionSurfaceLayerMaterials()

    let disposedGeometryCount = 0
    let disposedMaterialCount = 0
    resources.fillGeometry.dispose = () => { disposedGeometryCount += 1 }
    resources.outlineGeometry.dispose = () => { disposedGeometryCount += 1 }
    materials.selectedFill.dispose = () => { disposedMaterialCount += 1 }
    materials.unselectedFill.dispose = () => { disposedMaterialCount += 1 }
    materials.selectedOutline.dispose = () => { disposedMaterialCount += 1 }
    materials.unselectedOutline.dispose = () => { disposedMaterialCount += 1 }

    module.disposeWorldCollisionSurfaceRenderResources(resources)
    module.disposeWorldCollisionSurfaceLayerMaterials(materials)

    assert.equal(disposedGeometryCount, 2)
    assert.equal(disposedMaterialCount, 4)
    assert.equal(componentSource.includes('disposeWorldCollisionSurfaceLayerMaterials(materials)'), true)
    assert.equal(componentSource.includes('disposeWorldCollisionSurfaceRenderResources(entry.resources)'), true)
  } finally {
    await cleanup()
  }
})
