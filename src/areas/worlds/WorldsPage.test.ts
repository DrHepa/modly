import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build, type Plugin } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { normalizeWorldsSelectedSceneItemIds, toggleWorldsSelectedSceneItem, useWorldsSceneStore } from './worldsSceneStore.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const pageEntry = path.join(projectRoot, 'src/areas/worlds/WorldsPage.tsx')
const toolbarEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsTransformToolbar.tsx')

function stubViewerPlugin(): Plugin {
  return {
    name: 'stub-worlds-viewer',
    setup(buildApi) {
      buildApi.onResolve({ filter: /components\/WorldsViewer\.tsx$/ }, () => ({ path: 'worlds-viewer-stub', namespace: 'stub' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'tsx',
        contents: `
          import React from 'react'
          export function WorldsViewer(props) {
            return <section aria-label="Worlds 3D canvas" data-items={props.items.length} data-selected={props.selectedItemId || ''} data-unsupported={(props.unsupportedItems || []).length} data-initial-view={(props.initialView?.position || []).join(',')}>Worlds canvas</section>
          }
          export default WorldsViewer
        `,
      }))
    },
  }
}

async function loadPageModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-page-test-'))
  const outfile = path.join(tempDir, 'WorldsPage.bundle.mjs')
  const result = await build({
    entryPoints: [pageEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [stubViewerPlugin()],
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  })
  await writeFile(outfile, result.outputFiles[0].text)
  return {
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function loadToolbarModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-toolbar-test-'))
  const outfile = path.join(tempDir, 'WorldsTransformToolbar.bundle.mjs')
  const result = await build({
    entryPoints: [toolbarEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react/jsx-runtime'],
  })
  await writeFile(outfile, result.outputFiles[0].text)
  return {
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

function asset(id: string, name: string) {
  return {
    id,
    name,
    displayName: name,
    type: 'PLY mesh',
    sourceScope: 'workflows',
    capability: 'mesh',
    state: 'ready',
    previewKind: '3d-model',
    warnings: [],
    openable: true,
    workspacePath: `Workflows/${id}.ply`,
    item: {
      id: `world:Workflows/${id}.ply`,
      workspacePath: `Workflows/${id}.ply`,
      url: `Workflows/${id}.ply`,
      kind: 'ply-mesh',
      role: 'asset',
      visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  }
}

test('WorldsPageView renders a dominant integrated canvas with compact selector overlay and no boxed layout', async () => {
  const { module, cleanup } = await loadPageModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorldsPageView, {
      selectorOpen: true,
      assets: [asset('fuse', 'Fuse simplified')],
      selectedAssetId: 'fuse',
      selectedSceneItemId: 'world:Workflows/fuse.ply',
      selectedSceneItemIds: ['world:Workflows/fuse.ply'],
      pendingSurfacePlacementItemId: null,
      collisionEditMode: false,
      selectedCollisionSurfaceId: null,
      transformMode: null,
      sceneItems: [asset('fuse', 'Fuse simplified').item],
      collisionSurfaces: [],
      initialView: { position: [8, 5, 12], target: [0, 1, 0] },
      unsupportedItems: [],
      loadingAssets: false,
      openingAsset: false,
      savingScene: false,
      importingScene: false,
      sceneStatus: null,
      error: null,
      searchQuery: '',
      sortMode: 'type',
      collapsedSectionKeys: [],
      onToggleSelector: () => undefined,
      onCloseSelector: () => undefined,
      onRefreshAssets: () => undefined,
      onSelectAsset: () => undefined,
      onSearchQueryChange: () => undefined,
      onSortModeChange: () => undefined,
      onToggleSection: () => undefined,
      onSelectSceneItem: () => undefined,
      onTransformModeChange: () => undefined,
      onTransformSceneItem: () => undefined,
      onTransformSceneItems: () => undefined,
      onAddCollisionSurface: () => undefined,
      onCollisionEditModeChange: () => undefined,
      onSelectCollisionSurface: () => undefined,
      onTransformCollisionSurface: () => undefined,
      onRemoveCollisionSurface: () => undefined,
      onRemoveSceneItem: () => undefined,
      onToggleBaseSceneItem: () => undefined,
      onCommitPendingSurfacePlacement: () => undefined,
      onClearPendingSurfacePlacement: () => undefined,
      onOpenSelected: () => undefined,
      onSaveScene: () => undefined,
      onImportScene: () => undefined,
    }))

    assert.match(markup, /<main[^>]*aria-label="Worlds viewer"/)
    assert.match(markup, /aria-label="Worlds 3D canvas"/)
    assert.match(markup, /role="dialog"/)
    assert.match(markup, /Open asset/)
    assert.match(markup, /Save scene/)
    assert.match(markup, /Import scene/)
    assert.match(markup, /z-20/)
    assert.match(markup, /data-initial-view="8,5,12"/)
    assert.match(markup, /data-items="1"/)
    assert.doesNotMatch(markup, /<aside|page card|boxed|Metadata|Inspector|Raw|Schema|Provenance|Details/i)
  } finally {
    await cleanup()
  }
})

test('WorldsPageView keeps empty guidance minimal and selector closed by default', async () => {
  const { module, cleanup } = await loadPageModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorldsPageView, {
      selectorOpen: false,
      assets: [],
      selectedAssetId: null,
      selectedSceneItemId: null,
      selectedSceneItemIds: [],
      pendingSurfacePlacementItemId: null,
      collisionEditMode: false,
      selectedCollisionSurfaceId: null,
      transformMode: null,
      sceneItems: [],
      collisionSurfaces: [],
      unsupportedItems: [],
      loadingAssets: false,
      openingAsset: false,
      savingScene: false,
      importingScene: false,
      sceneStatus: null,
      error: null,
      searchQuery: '',
      sortMode: 'type',
      collapsedSectionKeys: [],
      onToggleSelector: () => undefined,
      onCloseSelector: () => undefined,
      onRefreshAssets: () => undefined,
      onSelectAsset: () => undefined,
      onSearchQueryChange: () => undefined,
      onSortModeChange: () => undefined,
      onToggleSection: () => undefined,
      onSelectSceneItem: () => undefined,
      onTransformModeChange: () => undefined,
      onTransformSceneItem: () => undefined,
      onTransformSceneItems: () => undefined,
      onAddCollisionSurface: () => undefined,
      onCollisionEditModeChange: () => undefined,
      onSelectCollisionSurface: () => undefined,
      onTransformCollisionSurface: () => undefined,
      onRemoveCollisionSurface: () => undefined,
      onRemoveSceneItem: () => undefined,
      onToggleBaseSceneItem: () => undefined,
      onCommitPendingSurfacePlacement: () => undefined,
      onClearPendingSurfacePlacement: () => undefined,
      onOpenSelected: () => undefined,
      onSaveScene: () => undefined,
      onImportScene: () => undefined,
    }))

    assert.doesNotMatch(markup, /Open a workflow world or renderable asset/i)
    assert.doesNotMatch(markup, /role="dialog"/)
    assert.match(markup, /aria-haspopup="dialog"/)
    assert.match(markup, /aria-expanded="false"/)
    assert.match(markup, /disabled=""[^>]*>Save scene/)
    assert.doesNotMatch(markup, /metadata|inspector|raw json|schema|provenance|details/i)
  } finally {
    await cleanup()
  }
})

test('WorldsPage does not automatically close the selector after opening an asset', async () => {
  const source = await readFile(pageEntry, 'utf8')

  assert.doesNotMatch(source, /setUnsupportedItems\(\[\]\)\s*setSelectorOpen\(false\)/)
})

test('WorldsPage normalizes malformed asset-library assets payloads before any .some access', async () => {
  const { module, cleanup } = await loadPageModule()

  try {
    assert.equal(module.normalizeWorldAssetLibraryAssets(undefined), null)
    assert.deepEqual(module.normalizeWorldAssetLibraryAssets([]), [])
  } finally {
    await cleanup()
  }
})

test('WorldsPage appends opened assets with unique scene ids, deterministic offsets, and selects the newest item', async () => {
  const { module, cleanup } = await loadPageModule()

  try {
    const existingFuse = asset('fuse', 'Fuse simplified').item
    const openedFuseAgain = { ...asset('fuse', 'Fuse simplified').item }
    const openedHull = asset('hull', 'Hull').item

    assert.deepEqual(module.appendWorldSceneItem([existingFuse], openedHull), {
      sceneItems: [existingFuse, { ...openedHull, transform: { ...openedHull.transform, position: [1.75, 0, 0] } }],
      selectedSceneItemId: 'world:Workflows/hull.ply',
    })

    assert.deepEqual(module.appendWorldSceneItem([existingFuse], openedFuseAgain), {
      sceneItems: [existingFuse, { ...openedFuseAgain, id: 'world:Workflows/fuse.ply#2', transform: { ...openedFuseAgain.transform, position: [1.75, 0, 0] } }],
      selectedSceneItemId: 'world:Workflows/fuse.ply#2',
    })

    assert.deepEqual(module.calculateWorldSceneItemPlacementOffset(0), [0, 0, 0])
    assert.deepEqual(module.calculateWorldSceneItemPlacementOffset(1), [1.75, 0, 0])
    assert.deepEqual(module.calculateWorldSceneItemPlacementOffset(2), [0, 0, 1.75])
    assert.deepEqual(module.calculateWorldSceneItemPlacementOffset(8), [1.75, 0, -1.75])
    assert.deepEqual(module.calculateWorldSceneItemPlacementOffset(9), [1.75, 0, 0])
  } finally {
    await cleanup()
  }
})

test('WorldsPage places new assets relative to existing base worlds using transform anchors', async () => {
  const { module, cleanup } = await loadPageModule()

  try {
    const base = { ...asset('base', 'Base').item, role: 'base-scene', transform: { position: [10, 0, -4], rotation: [0, 0, 0], scale: [1, 1, 1] } }
    const secondBase = { ...asset('base-b', 'Base B').item, role: 'base-scene', transform: { position: [14, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }
    const prop = asset('prop', 'Prop').item

    assert.deepEqual(module.appendWorldSceneItem([base], prop).sceneItems[1].transform.position, [11.75, 0, -4])
    assert.deepEqual(module.appendWorldSceneItem([base, secondBase], prop).sceneItems[2].transform.position, [13.75, 0, -2])
    assert.deepEqual(module.appendWorldSceneItem([base], prop, { sceneItemAnchors: { [base.id]: [40, 2, -20] } }).sceneItems[1].transform.position, [41.75, 2, -20])
    assert.equal(module.shouldPendingWorldsSurfacePlacement([base], prop), true)
    assert.equal(module.shouldPendingWorldsSurfacePlacement([base], { ...prop, role: 'base-scene' }), false)
    assert.equal(module.shouldPendingWorldsSurfacePlacement([prop], prop), false)
    assert.deepEqual(module.toggleWorldSceneItemBaseRole([prop], prop.id)[0].role, 'base-scene')
    assert.deepEqual(module.toggleWorldSceneItemBaseRole([{ ...prop, role: 'base-scene' }], prop.id)[0].role, 'asset')
  } finally {
    await cleanup()
  }
})

test('WorldsPage places new assets near the actively selected item before falling back to the base scene area', async () => {
  const { module, cleanup } = await loadPageModule()

  try {
    const selected = { ...asset('selected', 'Selected').item, transform: { position: [3, 1, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } }
    const base = { ...asset('base', 'Base').item, role: 'base-scene', transform: { position: [20, 0, -10], rotation: [0, 0, 0], scale: [1, 1, 1] } }
    const prop = asset('prop', 'Prop').item

    assert.deepEqual(module.appendWorldSceneItem([selected, base], prop, {
      selectedSceneItemId: selected.id,
      sceneItemAnchors: {
        [selected.id]: [8, 2, 4],
        [base.id]: [40, 0, -20],
      },
    }).sceneItems[2].transform.position, [8, 2, 5.75])

    assert.deepEqual(module.appendWorldSceneItem([selected], prop, {
      selectedSceneItemId: selected.id,
    }).sceneItems[1].transform.position, [4.75, 1, 5])
  } finally {
    await cleanup()
  }
})

test('WorldsPage removes only the selected in-memory scene item and recovers selection', async () => {
  const { module, cleanup } = await loadPageModule()

  try {
    const fuse = asset('fuse', 'Fuse simplified').item
    const hull = asset('hull', 'Hull').item
    const tower = asset('tower', 'Tower').item

    assert.deepEqual(module.removeWorldSceneItem([fuse, hull, tower], hull.id), {
      sceneItems: [fuse, tower],
      selectedSceneItemId: tower.id,
    })
    assert.deepEqual(module.removeWorldSceneItem([fuse, hull, tower], tower.id), {
      sceneItems: [fuse, hull],
      selectedSceneItemId: hull.id,
    })
    assert.deepEqual(module.removeWorldSceneItem([fuse], fuse.id), {
      sceneItems: [],
      selectedSceneItemId: null,
    })
    assert.deepEqual(module.removeWorldSceneItem([fuse], null), {
      sceneItems: [fuse],
      selectedSceneItemId: null,
    })
  } finally {
    await cleanup()
  }
})

test('WorldsPage updates the selected scene item transform without mutating other assets', async () => {
  const { module, cleanup } = await loadPageModule()

  try {
    const fuse = asset('fuse', 'Fuse simplified').item
    const hull = asset('hull', 'Hull').item
    const movedHull = module.updateWorldSceneItemTransform([fuse, hull], hull.id, {
      position: [1, 2, 3],
      rotation: [0.1, 0.2, 0.3],
      scale: [2, 2, 2],
    })

    assert.deepEqual(movedHull, [
      fuse,
      {
        ...hull,
        transform: {
          position: [1, 2, 3],
          rotation: [0.1, 0.2, 0.3],
          scale: [2, 2, 2],
        },
      },
    ])
    assert.deepEqual(module.updateWorldSceneItemTransform([fuse, hull], 'missing', { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] }), [fuse, hull])
  } finally {
    await cleanup()
  }
})

test('WorldsPage exposes a batched multi-item transform callback through the viewer contract', async () => {
  const source = await readFile(pageEntry, 'utf8')

  assert.match(source, /selectedItemIds=\{selectedSceneItemIds\}/)
  assert.match(source, /onTransformItems=\{onTransformSceneItems\}/)
  assert.match(source, /onTransformSceneItems:\s*\(updates: WorldSceneItemTransformUpdate\[\]\) => void/)
  assert.match(source, /sceneItems: updateWorldSceneItemTransforms\(state\.sceneItems, updates\)/)
  assert.match(source, /selectedSceneItemIds: state\.selectedSceneItemIds/)
})

test('WorldsPage keeps collision edit state separate from scene selection and wires collision surface helpers through the viewer contract', async () => {
  const { module, cleanup } = await loadPageModule()
  const source = await readFile(pageEntry, 'utf8')

  try {
    const hero = asset('hero', 'Hero').item
    assert.deepEqual(module.resolveWorldCollisionSurfacePlacementTransform([], [hero], { selectedSceneItemId: hero.id }), {
      position: [0, 0, 0],
    })
    assert.equal(source.includes('collisionEditMode = useWorldsSceneStore((state) => state.collisionEditMode)'), true)
    assert.equal(source.includes('selectedCollisionSurfaceId = useWorldsSceneStore((state) => state.selectedCollisionSurfaceId)'), true)
    assert.equal(source.includes('collisionSurfaces = useWorldsSceneStore((state) => state.collisionSurfaces)'), true)
    assert.equal(source.includes('addWorldCollisionSurface'), true)
    assert.equal(source.includes('updateWorldCollisionSurfaceTransform'), true)
    assert.equal(source.includes('removeWorldCollisionSurface'), true)
    assert.equal(source.includes('onAddCollisionSurface={onAddCollisionSurface}'), true)
    assert.equal(source.includes('onCollisionEditModeChange={onCollisionEditModeChange}'), true)
    assert.equal(source.includes('setCollisionEditMode(true)'), true)
    assert.equal(source.includes('onSelectCollisionSurface={setSelectedCollisionSurfaceId}'), true)
    assert.equal(source.includes('collisionSurfaces: updateWorldCollisionSurfaceTransform(state.collisionSurfaces, surfaceId, transform)'), true)
  } finally {
    await cleanup()
  }
})

test('WorldsPage adds preset collision surfaces, enters edit mode, and selects the new surface id', async () => {
  const source = await readFile(pageEntry, 'utf8')
  const toolbarSource = await readFile(toolbarEntry, 'utf8')

  assert.equal(source.includes('const next = addWorldCollisionSurface(state.collisionSurfaces, preset,'), true)
  assert.equal(source.includes('setCollisionEditMode(true)'), true)
  assert.equal(source.includes('setSelectedCollisionSurfaceId(next.selectedSurfaceId)'), true)
  assert.equal(toolbarSource.includes("{ value: 'rectangle', label: 'Rectangle' }"), true)
  assert.equal(toolbarSource.includes("{ value: 'square', label: 'Square' }"), true)
  assert.equal(toolbarSource.includes("{ value: 'triangle', label: 'Triangle' }"), true)
  assert.equal(toolbarSource.includes("{ value: 'wall', label: 'Wall' }"), true)
  assert.equal(toolbarSource.includes("{ value: 'floor', label: 'Floor' }"), true)
  assert.equal(toolbarSource.includes("{ value: 'ramp', label: 'Ramp' }"), true)
})

test('Worlds scene store can switch the active item without collapsing an existing multi-selection', () => {
  const store = useWorldsSceneStore.getState()
  useWorldsSceneStore.setState({
    sceneItems: [asset('a', 'A').item, asset('b', 'B').item],
    collisionSurfaces: [],
    selectedSceneItemId: 'world:b',
    selectedSceneItemIds: ['world:a', 'world:b'],
    pendingSurfacePlacementItemId: null,
    collisionEditMode: false,
    selectedCollisionSurfaceId: null,
    transformMode: 'translate',
    sceneItemAnchors: {},
  })

  try {
    store.setSelectedSceneItemId('world:a', { preserveSelection: true })
    assert.deepEqual(useWorldsSceneStore.getState().selectedSceneItemIds, ['world:a', 'world:b'])
    assert.equal(useWorldsSceneStore.getState().selectedSceneItemId, 'world:a')
  } finally {
    useWorldsSceneStore.setState({
      sceneItems: [],
      collisionSurfaces: [],
      selectedSceneItemId: null,
      selectedSceneItemIds: [],
      pendingSurfacePlacementItemId: null,
      collisionEditMode: false,
      selectedCollisionSurfaceId: null,
      transformMode: null,
      sceneItemAnchors: {},
    })
  }
})

test('Worlds scene store clears the selected collision surface when an asset becomes active', () => {
  const store = useWorldsSceneStore.getState()
  useWorldsSceneStore.setState({
    sceneItems: [asset('a', 'A').item, asset('b', 'B').item],
    collisionSurfaces: [{
      id: 'surface-1',
      label: 'Surface 1',
      shape: 'rect',
      preset: 'rectangle',
      sidedness: 'double',
      geometry: { halfWidth: 1, halfHeight: 1 },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }],
    selectedSceneItemId: null,
    selectedSceneItemIds: [],
    pendingSurfacePlacementItemId: null,
    collisionEditMode: true,
    selectedCollisionSurfaceId: 'surface-1',
    transformMode: 'translate',
    sceneItemAnchors: {},
  })

  try {
    store.setSelectedSceneItemId('world:a')
    assert.equal(useWorldsSceneStore.getState().selectedSceneItemId, 'world:a')
    assert.deepEqual(useWorldsSceneStore.getState().selectedSceneItemIds, ['world:a'])
    assert.equal(useWorldsSceneStore.getState().selectedCollisionSurfaceId, null)
    assert.equal(useWorldsSceneStore.getState().collisionEditMode, true)
  } finally {
    useWorldsSceneStore.setState({
      sceneItems: [],
      collisionSurfaces: [],
      selectedSceneItemId: null,
      selectedSceneItemIds: [],
      pendingSurfacePlacementItemId: null,
      collisionEditMode: false,
      selectedCollisionSurfaceId: null,
      transformMode: null,
      sceneItemAnchors: {},
    })
  }
})

test('Worlds scene store keeps pending placement transient, clears removals, and page import/add flows wire pending callbacks', async () => {
  const source = await readFile(pageEntry, 'utf8')
  const store = useWorldsSceneStore.getState()
  const base = { ...asset('base', 'Base').item, role: 'base-scene' as const }
  const pending = asset('pending', 'Pending').item

  useWorldsSceneStore.setState({
    sceneItems: [base, pending],
    collisionSurfaces: [],
    selectedSceneItemId: pending.id,
    selectedSceneItemIds: [pending.id],
    pendingSurfacePlacementItemId: null,
    collisionEditMode: false,
    selectedCollisionSurfaceId: null,
    transformMode: null,
    sceneItemAnchors: {},
  })

  try {
    store.setPendingSurfacePlacementItemId(pending.id)
    assert.equal(useWorldsSceneStore.getState().pendingSurfacePlacementItemId, pending.id)

    store.clearPendingSurfacePlacementItemId()
    assert.equal(useWorldsSceneStore.getState().pendingSurfacePlacementItemId, null)

    store.setPendingSurfacePlacementItemId(pending.id)
    store.setScene({
      sceneItems: [base],
      collisionSurfaces: [],
      selectedSceneItemId: base.id,
      selectedSceneItemIds: [base.id],
    })
    assert.equal(useWorldsSceneStore.getState().pendingSurfacePlacementItemId, null)

    assert.equal(source.includes('pendingSurfacePlacementItemId={pendingSurfacePlacementItemId}'), true)
    assert.equal(source.includes('onCommitPendingSurfacePlacement={onCommitPendingSurfacePlacement}'), true)
    assert.equal(source.includes('onClearPendingSurfacePlacement={onClearPendingSurfacePlacement}'), true)
    assert.equal(source.includes('pendingSurfacePlacementItemId: shouldPendingWorldsSurfacePlacement(sceneState.sceneItems, result.asset.item)'), true)
    assert.equal(source.includes('pendingSurfacePlacementItemId: shouldPendingWorldsSurfacePlacement(sceneState.sceneItems, asset.linkedItem)'), true)
    assert.equal(source.includes('pendingSurfacePlacementItemId: null'), true)
  } finally {
    useWorldsSceneStore.setState({
      sceneItems: [],
      collisionSurfaces: [],
      selectedSceneItemId: null,
      selectedSceneItemIds: [],
      pendingSurfacePlacementItemId: null,
      collisionEditMode: false,
      selectedCollisionSurfaceId: null,
      transformMode: null,
      sceneItemAnchors: {},
    })
  }
})

test('Worlds scene store never keeps a base-scene item pending for surface placement', () => {
  const store = useWorldsSceneStore.getState()
  const base = { ...asset('base', 'Base').item, role: 'base-scene' as const }
  const prop = asset('prop', 'Prop').item

  useWorldsSceneStore.setState({
    sceneItems: [base, prop],
    collisionSurfaces: [],
    selectedSceneItemId: prop.id,
    selectedSceneItemIds: [prop.id],
    pendingSurfacePlacementItemId: null,
    collisionEditMode: false,
    selectedCollisionSurfaceId: null,
    transformMode: null,
    sceneItemAnchors: {},
  })

  try {
    store.setPendingSurfacePlacementItemId(base.id)
    assert.equal(useWorldsSceneStore.getState().pendingSurfacePlacementItemId, null)

    store.setPendingSurfacePlacementItemId(prop.id)
    assert.equal(useWorldsSceneStore.getState().pendingSurfacePlacementItemId, prop.id)

    store.setScene({
      sceneItems: [{ ...base, role: 'asset' }, { ...prop, role: 'base-scene' }],
      collisionSurfaces: [],
      selectedSceneItemId: prop.id,
      selectedSceneItemIds: [prop.id],
    })
    assert.equal(useWorldsSceneStore.getState().pendingSurfacePlacementItemId, null)
  } finally {
    useWorldsSceneStore.setState({
      sceneItems: [],
      collisionSurfaces: [],
      selectedSceneItemId: null,
      selectedSceneItemIds: [],
      pendingSurfacePlacementItemId: null,
      collisionEditMode: false,
      selectedCollisionSurfaceId: null,
      transformMode: null,
      sceneItemAnchors: {},
    })
  }
})

test('WorldsTransformToolbar falls back to asset transforms when collision edit mode is visible but no surface is selected', async () => {
  const { module, cleanup } = await loadToolbarModule()

  try {
    assert.equal(module.resolveWorldsTransformToolbarTarget({
      collisionEditMode: true,
      selectedItem: asset('asset', 'Asset').item,
      selectedCollisionSurface: null,
    }), 'asset')
    assert.equal(module.resolveWorldsTransformToolbarTarget({
      collisionEditMode: true,
      selectedItem: asset('asset', 'Asset').item,
      selectedCollisionSurface: {
        id: 'surface-1',
        label: 'Surface 1',
        shape: 'rect',
        preset: 'rectangle',
        sidedness: 'double',
        geometry: { halfWidth: 1, halfHeight: 1 },
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    }), 'collision-surface')
    assert.equal(module.resolveWorldsTransformToolbarTarget({
      collisionEditMode: true,
      selectedItem: null,
      selectedCollisionSurface: null,
    }), 'none')
  } finally {
    await cleanup()
  }
})

test('Worlds scene store toggles ctrl multi-selection and keeps the last active item as primary', () => {
  assert.deepEqual(toggleWorldsSelectedSceneItem(['world:a'], 'world:a', 'world:b'), {
    selectedSceneItemIds: ['world:a', 'world:b'],
    selectedSceneItemId: 'world:b',
  })

  assert.deepEqual(toggleWorldsSelectedSceneItem(['world:a', 'world:b'], 'world:b', 'world:b'), {
    selectedSceneItemIds: ['world:a'],
    selectedSceneItemId: 'world:a',
  })

  assert.deepEqual(toggleWorldsSelectedSceneItem(['world:a', 'world:b'], 'world:b', 'world:a'), {
    selectedSceneItemIds: ['world:b'],
    selectedSceneItemId: 'world:b',
  })
})

test('Worlds scene store normalizes multi-selection to visible scene items and preserves the active item when valid', () => {
  const visible = asset('visible', 'Visible').item
  const hidden = { ...asset('hidden', 'Hidden').item, visible: false }

  assert.deepEqual(
    normalizeWorldsSelectedSceneItemIds([visible, hidden], visible.id, [hidden.id, visible.id, hidden.id]),
    [visible.id],
  )
  assert.deepEqual(normalizeWorldsSelectedSceneItemIds([visible], visible.id, []), [visible.id])
})

test('WorldsPage carries imported manifest initial views into the viewer and preserved scene saves', async () => {
  const source = await readFile(pageEntry, 'utf8')

  assert.equal(source.includes('const initialView = useWorldsSceneStore((state) => state.initialView)'), true)
  assert.equal(source.includes('initialView: parsed.manifest.initialView ?? null'), true)
  assert.equal(source.includes('initialView={initialView ?? undefined}'), true)
  assert.equal(source.includes('initialView: sceneState.initialView ?? undefined'), true)
  assert.doesNotMatch(source, /setSceneInitialView|sceneInitialView/)
})

test('WorldsPage keeps composed scene state in the Worlds store for tab navigation and rapid asset opens', async () => {
  const source = await readFile(pageEntry, 'utf8')

  assert.match(source, /useWorldsSceneStore/)
  assert.match(source, /const sceneItems = useWorldsSceneStore\(\(state\) => state\.sceneItems\)/)
  assert.match(source, /selectedSceneItemIds/)
  assert.match(source, /toggleSelectedSceneItemId/)
  assert.doesNotMatch(source, /useState<\{ sceneItems: WorldSceneItem\[\]; selectedSceneItemId: string \| null \}>/)
})
