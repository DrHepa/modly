import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

import { build, type Plugin } from 'esbuild'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const pageEntry = path.join(projectRoot, 'src/areas/worlds/WorldsPage.tsx')

function stubViewerPlugin(): Plugin {
  return {
    name: 'stub-worlds-viewer',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      buildApi.onResolve({ filter: /shared\/stores\/appStore\.ts$/ }, () => ({ path: 'app-store', namespace: 'store' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'store' }, () => ({ loader: 'js', contents: `
        import {useSyncExternalStore} from 'react'
        export const useAppStore = select => useSyncExternalStore(globalThis.__worldsPageHarness.subscribe, () => select({apiUrl:globalThis.__worldsPageHarness.apiUrl}))
      ` }))
      buildApi.onResolve({ filter: /worldAssetLibraryService\.ts$/ }, () => ({ path: 'library', namespace: 'library' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'library' }, () => ({ loader: 'js', contents: `
        export const listWorldAssetLibraryRenderables = (...args) => globalThis.__worldsPageHarness.list(...args)
        export const openWorldAssetLibraryRenderable = (...args) => globalThis.__worldsPageHarness.open(...args)
      ` }))
      buildApi.onResolve({ filter: /components\/WorldsViewer\.tsx$/ }, () => ({ path: 'worlds-viewer-stub', namespace: 'stub' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'tsx',
        contents: `
          import React from 'react'
          export function WorldsViewer(props) {
            return <section aria-label="Worlds 3D canvas" data-items={props.items.length} data-path={props.items[0]?.workspacePath} data-selected={props.selectedItemId || ''} data-unsupported={(props.unsupportedItems || []).length}>Worlds canvas</section>
          }
          export default WorldsViewer
        `,
      }))
    },
  }
}

async function loadPageModule() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-worlds-page-test-'))
  const outfile = path.join(tempDir, 'WorldsPage.bundle.mjs')
  const result = await build({
    entryPoints: [pageEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [stubViewerPlugin()],
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
      transformMode: null,
      sceneItems: [asset('fuse', 'Fuse simplified').item],
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
      onRemoveSceneItem: () => undefined,
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
      transformMode: null,
      sceneItems: [],
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
      onRemoveSceneItem: () => undefined,
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

// Real React lifecycle on a CPU mutation host; the canvas alone is substituted.
type Host = { type: string; props: any; children: Host[] }
function cpuHost() {
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
    createInstance: (type: string, props: any) => ({ type, props, children: [] }),
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
  const render = (node: ReturnType<typeof createElement> | null) => flush(() => renderer.updateContainer(node, root, null))
  const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); flush() } }
  function find(predicate: (n: Host) => boolean, node = host): Host | undefined { if (predicate(node)) return node; for (const child of node.children) { const found = find(predicate, child); if (found) return found } }
  const text = (n: Host): string => n.type === '#text' ? n.props.text : n.children.map(text).join('')
  const button = (label: string) => { const n = find(n => n.type === 'button' && (n.props['aria-label'] === label || text(n) === label)); assert.ok(n, label); return n }
  return { render, flush, settle, find, button, click: (label: string) => { const n = button(label); assert.ok(!n.props.disabled, label); flush(() => n.props.onClick()) } }
}

for (const scenario of ['selection ABA', 'API ABA', 'latest refresh', 'unmount'] as const) {
  test(`mounted WorldsPage fences ${scenario} responses and preserves new busy ownership`, async () => {
    const { module, cleanup } = await loadPageModule()
    const cpu = cpuHost()
    const lists: Array<{ url: string; resolve: (v: any) => void; reject: (v: unknown) => void }> = []
    const opens: Array<{ path: string; url: string; resolve: (v: any) => void; reject: (v: unknown) => void }> = []
    const listeners = new Set<() => void>()
    const fixture = { apiUrl: 'http://A', subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      list: (url: string) => new Promise((resolve, reject) => lists.push({ url, resolve, reject })),
      open: (request: { workspacePath: string }, url: string) => new Promise((resolve, reject) => opens.push({ path: request.workspacePath, url, resolve, reject })),
    }
    const globals = globalThis as typeof globalThis & { __worldsPageHarness?: typeof fixture }
    const previous = globals.__worldsPageHarness; globals.__worldsPageHarness = fixture
    const list = (index: number, assets = [asset('a', 'A'), asset('b', 'B')]) => lists[index].resolve({ success: true, assets })
    const canvas = () => cpu.find(n => n.props['aria-label'] === 'Worlds 3D canvas')
    const changeApi = (url: string) => cpu.flush(() => { fixture.apiUrl = url; listeners.forEach(fn => fn()) })
    try {
      cpu.render(createElement(module.default)); assert.equal(lists.length, 1)
      list(0); await cpu.settle(); cpu.click('Open asset')
      cpu.click('Open selected asset'); assert.equal(opens[0].path, 'Workflows/a.ply')
      if (scenario === 'selection ABA') {
        cpu.click('Select world asset B'); cpu.click('Select world asset A')
        assert.ok(!cpu.button('Open selected asset').props.disabled, 'selection cancels the old busy owner')
        cpu.click('Open selected asset'); assert.equal(opens.length, 2)
        opens[0].resolve({ success: true, asset: asset('a', 'Old A') }); await cpu.settle()
        assert.equal(canvas()?.props['data-items'], 0, 'old A cannot resurrect after ABA')
        assert.equal(cpu.button('Opening…').props.disabled, true, 'old finally cannot clear new busy state')
        opens[1].resolve({ success: true, asset: asset('a', 'A') }); await cpu.settle()
        assert.equal(canvas()?.props['data-path'], 'Workflows/a.ply')
        assert.ok(cpu.find(n => n.props.role === 'dialog'), 'opening keeps selector visible')
        cpu.click('Select world asset B'); cpu.click('Open selected asset')
        assert.equal(opens[2].path, 'Workflows/b.ply')
        opens[2].reject(new Error('Current open failed')); await cpu.settle()
        assert.ok(cpu.find(n => n.props.role === 'alert')); assert.ok(!cpu.button('Open selected asset').props.disabled)
      } else if (scenario === 'API ABA') {
        changeApi('http://B'); changeApi('http://A'); assert.equal(lists.length, 3)
        opens[0].resolve({ success: true, asset: asset('a', 'Old A') }); list(1, [asset('old', 'Old B')]); await cpu.settle()
        assert.equal(canvas()?.props['data-items'], 0)
        assert.equal(cpu.find(n => n.props['aria-label'] === 'Select world asset Old B'), undefined)
        list(2, [asset('fresh', 'Fresh')]); await cpu.settle(); cpu.click('Open asset')
        cpu.click('Open selected asset'); assert.equal(opens[1].path, 'Workflows/fresh.ply')
      } else if (scenario === 'latest refresh') {
        // Capture an actual handler before batching two requests in the same event turn.
        const refresh = cpu.button('Refresh assets').props.onClick
        cpu.flush(() => { refresh(); refresh() }); assert.equal(lists.length, 3)
        opens[0].reject(new Error('Stale open')); list(1, [asset('old', 'Old')]); await cpu.settle()
        assert.equal(cpu.button('Loading assets…').props.disabled, true)
        assert.equal(cpu.find(n => n.props.role === 'alert'), undefined)
        list(2); await cpu.settle(); assert.equal(cpu.button('Select world asset A').props['aria-pressed'], true)
        cpu.click('Refresh assets'); lists[3].reject(new Error('Current list failed')); await cpu.settle()
        assert.ok(cpu.find(n => n.props.role === 'alert')); assert.equal(cpu.button('Open selected asset').props.disabled, true)
      } else {
        cpu.render(null); opens[0].resolve({ success: true, asset: asset('a', 'Detached') }); await cpu.settle()
        assert.equal(canvas(), undefined)
      }
    } finally { cpu.render(null); globals.__worldsPageHarness = previous; await cleanup() }
  })
}

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
    assert.deepEqual(module.calculateWorldSceneItemPlacementOffset(9), [3.5, 0, 0])
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

test('WorldsPage keeps composed scene state in the Worlds store for tab navigation and rapid asset opens', async () => {
  const source = await readFile(pageEntry, 'utf8')

  assert.match(source, /useWorldsSceneStore/)
  assert.match(source, /useWorldsSceneStore\.getState\(\)\.sceneItems/)
  assert.doesNotMatch(source, /useState<\{ sceneItems: WorldSceneItem\[\]; selectedSceneItemId: string \| null \}>/)
})
