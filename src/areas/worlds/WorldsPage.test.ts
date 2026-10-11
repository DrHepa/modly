import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

import { build, type Plugin } from 'esbuild'
import React, { createElement } from 'react'
import { JSDOM } from 'jsdom'

import { normalizeWorldsSelectedSceneItemIds, toggleWorldsSelectedSceneItem, useWorldsSceneStore } from './worldsSceneStore.ts'
import type { WorldSceneItem } from './worldRenderableResolver.ts'
import { createValidWorldSnapshot } from './core/_testFixtures.ts'
import { applyWorldCommandBatch, type WorldCommand } from './core/worldCommands.ts'
import type { WorldProjectSnapshotV1, WorldTransform } from './core/worldModel.ts'
import type { WorldProjectsApi, WorldProjectCommandRequest } from '../../shared/types/worldProjects.ts'
import { createWorldEditorController } from './editor/worldEditorController.ts'
import { createWorldEditorViewportCommitAuthority, useWorldEditorProjectionBridge } from './editor/useWorldEditorProjectionBridge.ts'
import { createWorldEditorTransformAdmission } from './editor/worldEditorTransformAdmission.ts'
import { useWorldsUiStore } from './editor/worldsUiStore.ts'
import { buildAddModelEntityCommands, createDeterministicWorldEditorIdentityGenerator } from './editor/worldEditorCommandBuilders.ts'
import { importLegacyWorldsSceneManifest, exportLegacyWorldsSceneManifest, analyzeLegacyWorldsSceneExport } from './core/legacySceneManifestAdapter.ts'
import { buildWorldsSceneManifest } from './worldsSceneManifest.ts'
import { createWorldCollisionSurfacePreset } from './worldsCollisionSurfaces.ts'
import { isWorldCanonicalId } from './core/worldValidationLimits.ts'
import { appendWorldSceneItem } from './worldsScenePlacement.ts'
import { createWorldProjectService } from './worldProjectService.ts'
import { projectWorldAssetLibraryListResult } from './worldAssetLibraryService.ts'
import { buildAddSceneCommands } from './editor/worldEditorCommandBuilders.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const worldsRoot = path.join(projectRoot, 'src/areas/worlds')
const pageEntry = path.join(worldsRoot, 'WorldsPage.tsx')
const toolbarEntry = path.join(worldsRoot, 'components/WorldsTransformToolbar.tsx')
const workbenchEntry = path.join(worldsRoot, 'components/WorldsWorkbench.tsx')
const overlayFocusEntry = path.join(worldsRoot, 'editor/worldsOverlayFocus.ts')
const viewerEntry = path.join(worldsRoot, 'components/WorldsViewer.tsx')
const runtimeViewportEntry = path.join(worldsRoot, 'components/WorldRuntimeViewport.tsx')
const projectBarEntry = path.join(worldsRoot, 'components/WorldsProjectBar.tsx')
const sceneDockEntry = path.join(worldsRoot, 'components/WorldsSceneDock.tsx')
const legacyExportEntry = path.join(worldsRoot, 'components/WorldsLegacyExportDialog.tsx')
const timelineEntry = path.join(worldsRoot, 'components/WorldsTimelineDrawer.tsx')
const workbenchCss = path.join(worldsRoot, 'WorldsWorkbench.css')

function stubViewerPlugin(): Plugin {
  return {
    name: 'stub-worlds-viewer',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^(react(?:-dom)?(?:\/.*)?|@react-three\/(?:fiber|drei|postprocessing)(?:\/.*)?|zustand(?:\/.*)?|axios)$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      buildApi.onResolve({ filter: /shared\/stores\/appStore\.ts$/ }, () => ({ path: 'app-store', namespace: 'store' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'store' }, () => ({ loader: 'js', contents: `
        import {useSyncExternalStore} from 'react'
        export const useAppStore = select => useSyncExternalStore(globalThis.__worldsPageHarness.subscribe, () => select({apiUrl:globalThis.__worldsPageHarness.apiUrl}))
      ` }))
      buildApi.onResolve({ filter: /worldAssetLibraryService\.ts$/ }, () => ({ path: 'library', namespace: 'library' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'library' }, () => ({ loader: 'js', contents: `
        export const listWorldAssetLibraryRenderables = (...args) => globalThis.__worldsPageHarness.list(...args)
        export const openWorldAssetLibraryRenderable = (...args) => globalThis.__worldsPageHarness.open(...args)
        export const readWorldAssetLibraryAudio = () => { throw new Error('Unexpected audio read in mesh-only WorldsPage fixture') }
      ` }))
      const nativeOwners = new Set([
        path.join(worldsRoot, 'editor/useWorldEditorController.ts'),
        path.join(worldsRoot, 'editor/worldEditorController.ts'),
        path.join(worldsRoot, 'editor/worldsUiStore.ts'),
        path.join(worldsRoot, 'worldsSceneStore.ts'),
      ])
      buildApi.onResolve({ filter: /\.(?:ts|tsx)$/ }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path)
        if (resolved === viewerEntry) return { path: 'worlds-viewer-stub', namespace: 'stub' }
        return nativeOwners.has(resolved) ? { path: pathToFileURL(resolved).href, external: true } : null
      })
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'tsx',
        contents: `
          import React from 'react'
          export function WorldsViewer(props) {
            return <section aria-label="Worlds 3D canvas" data-items={props.items.length} data-path={props.items[0]?.workspacePath} data-initial-view={(props.initialView?.position || []).join(',')} data-selected={props.selectedItemId || ''} data-unsupported={(props.unsupportedItems || []).length}>Worlds canvas</section>
          }
          export default WorldsViewer
        `,
      }))
    },
  }
}

test('WorldsPage is composition-only and mounts the canonical WorldsWorkbench', async () => {
  const source = await readFile(pageEntry, 'utf8')
  assert.match(source, /import WorldsWorkbench from ['"]\.\/components\/WorldsWorkbench\.tsx['"]/)
  assert.match(source, /return <WorldsWorkbench \/>/)
  assert.doesNotMatch(source, /useEffect|useMemo|useState|useWorldsSceneStore|setScene|WorldsViewer/)
})

test('Worlds workbench keeps editor and Play viewports as separate integrated surfaces', async () => {
  const source = await readFile(workbenchEntry, 'utf8')
  const viewerSource = await readFile(viewerEntry, 'utf8')
  const runtimeSource = await readFile(runtimeViewportEntry, 'utf8')
  assert.match(source, /<section[^>]*aria-label="Worlds editor"/)
  assert.match(source, /WorldsProjectBar/)
  assert.match(source, /WorldsSceneDock/)
  assert.match(source, /WorldsAssetsDock/)
  assert.match(source, /WorldsInspector/)
  assert.match(source, /WorldsTimelineDrawer/)
  assert.match(source, /<WorldsViewer[^>]*showPlaybackControls=\{false\}/s)
  assert.doesNotMatch(source, /compactCameraHelp|controlMode=|onControlModeChange=/)
  assert.match(source, /playState\.lifecycle === 'edit'/)
  assert.match(source, /<WorldRuntimeViewport/)
  assert.doesNotMatch(viewerSource, /createWorldPlayController|WorldRuntimeViewport|applyWorldCommandBatch|useWorldEditorController|baseRevision/)
  assert.match(viewerSource, /showPlaybackControls\s*\?\s*<WorldsPlaybackControls/)
  assert.match(runtimeSource, /aria-label="Play viewport"/)
  assert.doesNotMatch(runtimeSource, /OrbitControls|TransformControls|GridHelper|Gizmo/)
  assert.doesNotMatch(runtimeSource, /WorldsViewportModeControl|WorldsViewportNavigationControls|Digit1|Digit2|Digit3/)
})

test('Worlds Timeline preview is isolated from canonical store authority and mutually exclusive with Play', async () => {
  const workbenchSource = await readFile(workbenchEntry, 'utf8')
  const timelineSource = await readFile(timelineEntry, 'utf8')
  assert.match(workbenchSource, /timelinePreviewController\.stop\(\)/)
  assert.match(workbenchSource, /revokeEditViewport\(\)/)
  assert.match(workbenchSource, /transformMode:\s*null/)
  assert.match(timelineSource, /onPreviewStop/)
  assert.doesNotMatch(timelineSource, /useWorldsSceneStore|\.setScene\s*\(/)
})

test('Worlds tree actions isolate descendant key events from treeitem navigation', async () => {
  const source = await readFile(sceneDockEntry, 'utf8')
  assert.match(source, /shouldHandleWorldTreeRowKeyEvent\(event\.target, event\.currentTarget\)/)
})

test('Worlds modal and responsive overlays use real modal or trapped focus contracts', async () => {
  const workbenchSource = await readFile(workbenchEntry, 'utf8')
  const overlayFocusSource = await readFile(overlayFocusEntry, 'utf8')
  const exportSource = await readFile(legacyExportEntry, 'utf8')
  assert.match(exportSource, /\.showModal\(\)/)
  assert.doesNotMatch(exportSource, /<dialog[^>]*\sopen(?:=|\s|>)/)
  assert.match(workbenchSource, /aria-modal="true"/)
  assert.match(workbenchSource, /trapWorldsOverlayFocus/)
  assert.match(workbenchSource, /import \{ restoreWorldsDockFocus, trapWorldsOverlayFocus \} from ['"]\.\.\/editor\/worldsOverlayFocus\.ts['"]/)
  assert.match(overlayFocusSource, /getClientRects\(\)\.length/)
  assert.match(workbenchSource, /restoreWorldsDockFocus/)
  assert.match(workbenchSource, /data-worlds-dock=/)
})

test('Worlds responsive container contracts collapse docks to inaccessible rails and overlays', async () => {
  const source = await readFile(workbenchCss, 'utf8')
  assert.match(source, /container-type:\s*inline-size/)
  assert.match(source, /@container\s+worlds-workbench\s*\(max-width:\s*1080px\)/)
  assert.match(source, /@container\s+worlds-workbench\s*\(max-width:\s*720px\)/)
  assert.match(source, /\.worlds-workbench__dock\s*\{[^}]*display:\s*none/s)
  assert.match(source, /\.worlds-workbench__rail\s*\{[^}]*display:\s*flex/s)
  assert.match(source, /min-(?:width|height):\s*32px/)
  assert.match(source, /prefers-reduced-motion:\s*reduce/)
})

test('Worlds compact informational text uses an AA contrast foreground', async () => {
  const source = await readFile(workbenchCss, 'utf8')
  assert.doesNotMatch(source, /(?:^|[;{]\s*)color:\s*#71717a/m)
  assert.match(source, /color:\s*#a1a1aa/)
})

test('Worlds reserves Recover for genuine revision conflicts and labels other failures as errors', async () => {
  const workbenchSource = await readFile(workbenchEntry, 'utf8')
  const projectBarSource = await readFile(projectBarEntry, 'utf8')
  assert.match(workbenchSource, /resolveWorldsPersistenceIndicator\(state\.lifecycle, state\.error\?\.code \?\? null\)/)
  assert.match(workbenchSource, /onRecoverConflict=\{handleRecoverConflict\}/)
  assert.match(projectBarSource, /saveStatus === 'error' \? 'Error'/)
  assert.match(projectBarSource, /saveStatus === 'conflict'[\s\S]*aria-label="Refresh conflicted World project"/)
})

test('Worlds production UI has no native title attributes or direct canonical-store authority', async () => {
  const productionFiles = await listProductionFiles(worldsRoot)
  for (const filePath of productionFiles) {
    const source = await readFile(filePath, 'utf8')
    assert.doesNotMatch(source, /\btitle\s*=\s*[{"']/, `${path.relative(projectRoot, filePath)} must use delayed accessible tooltips`)
    if (filePath.includes(`${path.sep}components${path.sep}`) || filePath.endsWith('WorldsPage.tsx')) {
      assert.doesNotMatch(source, /useWorldsSceneStore|\.setScene\s*\(/, `${path.relative(projectRoot, filePath)} must not own canonical scene data`)
    }
  }
})

async function listProductionFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : listProductionFiles(entryPath)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [entryPath] : []
  }))
  return nested.flat()
}

function createPageDomOwner() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
  }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    } finally {
      dom.window.close()
    }
  }
  try {
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { configurable: true, enumerable: true, writable: true, value })
    }
    return { window: dom.window, release }
  } catch (error) {
    release()
    throw error
  }
}

async function loadPageModule(seed: 'empty' | 'model' | false = false) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-worlds-page-test-'))
  const previousUi = useWorldsUiStore.getState()
  const previousLegacy = useWorldsSceneStore.getState()
  let releaseDom = () => {}
  let loadedController: import('./editor/worldEditorController.ts').WorldEditorController | undefined
  const pending = new Set<Promise<unknown>>()
  const serviceCompletions = new Set<() => void>()
  const writes: WorldProjectCommandRequest[] = []
  const track = <T,>(operation: Promise<T>): Promise<T> => {
    pending.add(operation)
    const completed = () => {
      pending.delete(operation)
      for (const listener of serviceCompletions) listener()
    }
    void operation.then(completed, completed)
    return operation
  }
  const drain = async () => { while (pending.size) await Promise.all([...pending]) }
  try {
    const owner = createPageDomOwner()
    releaseDom = owner.release
    const workspaceRoot = path.join(tempDir, 'workspace')
    await mkdir(workspaceRoot)
    let projectSequence = 0, sceneSequence = 0
    const repositoryOptions = {
      getWorkspaceRoot: () => workspaceRoot,
      createProjectKey: () => `world-${String(++projectSequence).padStart(32, '0')}`,
      createSceneKey: () => `scene-${String(++sceneSequence).padStart(32, '0')}`,
      now: () => new Date('2026-10-11T00:00:00.000Z'),
    }
    // Load the real Node-only owner at runtime without pulling Electron sources into the composite web project.
    const repositoryModule: { WorldProjectRepository: new (options: typeof repositoryOptions) => WorldProjectsApi } = await import(
      pathToFileURL(path.join(projectRoot, 'electron/main/world-project-repository.ts')).href,
    )
    const repository = new repositoryModule.WorldProjectRepository(repositoryOptions)
    const service = createWorldProjectService(repository)
    const projects: WorldProjectsApi = {
      create: request => track(service.create(request)),
      list: () => track(service.list()),
      open: request => track(service.open(request)),
      delete: request => track(service.delete(request)),
      previewCommands: request => track(service.previewCommands(request)),
      applyCommands: request => {
        writes.push(structuredClone(request))
        return track(service.applyCommands(request))
      },
      previewAi: request => track(service.previewAi!(request)),
      discardAi: request => track(service.discardAi!(request)),
    }
    // The real service/repository is the complete IPC project facade; no success DTO is manufactured.
    Object.defineProperty(owner.window, 'electron', { configurable: true, value: { workspace: { worlds: { projects } } } })
    if (seed) {
      const created = await service.create({ name: 'Page fixture', initialSceneName: 'First scene', projectId: 'project:page-fixture', initialSceneId: 'scene:page-first' })
      assert.equal(created.ok, true, JSON.stringify(created))
      if (!created.ok) assert.fail('Genuine fixture project creation failed')
      const { projectKey, snapshot } = created.value
      const context = { projectKey, snapshot, activeSceneId: snapshot.project.startSceneId,
        identities: createDeterministicWorldEditorIdentityGenerator('page-fixture-setup') }
      const commands: WorldCommand[] = buildAddSceneCommands(context, { name: 'Second scene' })
      if (seed === 'model') {
        const scene = structuredClone(snapshot.scenes[0])
        scene.editor = { initialView: { position: [8, 5, 12], target: [0, 1, 0], up: [0, 1, 0] } }
        commands.push({ type: 'replace-scene', sceneId: scene.sceneId, reference: snapshot.project.scenes[0], scene })
        commands.push(...buildAddModelEntityCommands(context, { workspacePath: 'Workflows/fuse.ply', format: 'ply-mesh', name: 'Fuse simplified', role: 'asset', transform: asset('fuse', 'Fuse simplified').item.transform }))
      }
      const setup = await service.applyCommands({ projectKey, batch: { schema: 'modly.world-command-batch.v1', transactionId: 'tx:page-fixture-setup',
        projectId: snapshot.project.projectId, baseRevision: snapshot.project.revision, origin: 'ui', commands } })
      assert.equal(setup.ok, true, JSON.stringify(setup))
    }
    useWorldsUiStore.getState().resetForScene()
    useWorldsUiStore.getState().setActiveLeftDock('scene')
    const outfile = path.join(tempDir, 'WorldsPage.bundle.mjs')
    const result = await build({
      stdin: { sourcefile: 'WorldsPage.fixture-entry.ts', resolveDir: worldsRoot, loader: 'ts', contents: `
        export { default } from './WorldsPage.tsx'
        export { worldEditorController } from './editor/worldEditorController.ts'
        export { appendWorldSceneItem, calculateWorldSceneItemPlacementOffset, shouldPendingWorldsSurfacePlacement,
          toggleWorldSceneItemBaseRole, removeWorldSceneItem, updateWorldSceneItemTransform } from './worldsScenePlacement.ts'
      ` },
      outfile,
      loader: { '.css': 'css' }, bundle: true, write: false, format: 'esm', platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'), plugins: [stubViewerPlugin()],
    })
    for (const output of result.outputFiles) {
      const relative = path.relative(tempDir, output.path)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('WorldsPage output escaped its owned temporary directory')
      }
      await mkdir(path.dirname(output.path), { recursive: true })
      await writeFile(output.path, output.contents)
    }
    const module = await import(pathToFileURL(outfile).href)
    loadedController = module.worldEditorController
    return {
      module, writes,
      controller: loadedController!,
      observeCompletion(listener: () => void) {
        serviceCompletions.add(listener)
        return () => { serviceCompletions.delete(listener) }
      },
      async cleanup() {
        try {
          // Called only after genuine unmount and held library completions have settled.
          await drain()
          await loadedController!.closeProject()
        } finally {
          try {
            useWorldsUiStore.setState(previousUi, true)
            useWorldsSceneStore.setState(previousLegacy, true)
          } finally {
            try { await rm(tempDir, { recursive: true, force: true }) }
            finally { releaseDom() }
          }
        }
      },
    }
  } catch (error) {
    try {
      await drain()
      if (loadedController) await loadedController.closeProject()
    } finally {
      try {
        useWorldsUiStore.setState(previousUi, true)
        useWorldsSceneStore.setState(previousLegacy, true)
      } finally {
        try { await rm(tempDir, { recursive: true, force: true }) }
        finally { releaseDom() }
      }
    }
    throw error
  }
}

async function loadToolbarModule() {
  const tempDir = await mkdtemp(path.join(tmpdir(), '.tmp-worlds-toolbar-test-'))
  try {
    const outfile = path.join(tempDir, 'WorldsTransformToolbar.bundle.mjs')
    const result = await build({
      entryPoints: [toolbarEntry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [{
        name: 'source-anchored-runtime',
        setup(buildApi) {
          const runtimeExternals = ['react', 'react/jsx-runtime', 'react-dom']
          buildApi.onResolve({ filter: /^[^./]/ }, (args) => {
            if (!runtimeExternals.some((name) => args.path === name || args.path.startsWith(`${name}/`))) return null
            return { path: fileURLToPath(import.meta.resolve(args.path)), external: true }
          })
        },
      }],
    })
    await writeFile(outfile, result.outputFiles[0].text)
    return {
      module: await import(pathToFileURL(outfile).href),
      async cleanup() {
        await rm(tempDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
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
    } satisfies WorldSceneItem,
  }
}

test('WorldsPage mounts a dominant integrated viewport with a compact Assets overlay and canonical project controls', async () => {
  const fixture = createPageLibraryHarness([asset('fuse', 'Fuse simplified')])
  const f = await mountedPage(fixture, 'model')
  try {
    const root = f.cpu.find(n => n.type === 'section' && n.props['aria-label'] === 'Worlds editor')
    assert.ok(root)
    assert.match(root.props.className, /worlds-workbench/)
    assert.ok(f.cpu.find(n => n.props['aria-label'] === 'World viewport' && n.props.className === 'worlds-workbench__viewport'))
    assert.ok(f.cpu.find(n => n.props['aria-label'] === 'World project controls'))
    assert.equal(f.canvas()?.props['data-items'], 1)
    assert.equal(f.canvas()?.props['data-initial-view'], '8,5,12')
    f.openAssets()
    await f.cpu.settle()
    assert.ok(f.cpu.find(n => n.props.role === 'dialog' && n.props['aria-label'] === 'Assets dock'))
    assert.equal(f.cpu.button('Add Fuse simplified to scene').props.disabled, false)
    assert.ok(f.cpu.find(n => n.props['aria-label'] === 'Assets library'))
    assert.doesNotMatch(f.cpu.text(root), /Raw JSON|Schema|Provenance|Metadata/i)
    const css = await readFile(workbenchCss, 'utf8')
    assert.match(css, /worlds-workbench__viewport/)
    assert.doesNotMatch(root.props.className, /page-card|boxed/)
  } finally { await f.cleanup() }
})

test('WorldsPage keeps empty guidance minimal and compact docks closed by default', async () => {
  const f = await mountedPage(createPageLibraryHarness([]), false)
  try {
    assert.ok(f.cpu.find(n => n.props['aria-label'] === 'Worlds editor'))
    assert.equal(f.canvas()?.props['data-items'], 0)
    assert.equal(f.cpu.find(n => n.props.role === 'dialog'), undefined)
    assert.ok(f.cpu.find(n => n.props.className === 'worlds-workbench__empty'))
    assert.match(f.cpu.text(f.cpu.find(n => n.props.className === 'worlds-workbench__empty')!), /Create a WorldStart with a project and scene\.New/)
    assert.equal(f.cpu.button('Open Assets dock').props.disabled, undefined)
    assert.equal(f.cpu.button('Open Inspector dock').props.disabled, undefined)
    assert.doesNotMatch(f.cpu.text(f.cpu.host), /Open a workflow world or renderable asset|Raw JSON|Schema|Provenance|Metadata/i)
    assert.equal(useWorldsUiStore.getState().overlayDock, null)
    assert.equal(f.controller.getState().session, null)
  } finally { await f.cleanup() }
})

test('WorldsPage does not automatically close the selector after opening an asset', async () => {
  const source = await readFile(pageEntry, 'utf8')

  assert.doesNotMatch(source, /setUnsupportedItems\(\[\]\)\s*setSelectorOpen\(false\)/)
})

// Real React lifecycle on a CPU mutation host; the canvas alone is substituted.
type Host = { type: string; props: any; children: Host[] }
function cpuHost(observeOwner?: (listener: () => void) => () => void) {
  const reconcilerPath = fileURLToPath(import.meta.resolve('react-reconciler'))
  assert.equal(reconcilerPath, path.join(projectRoot, 'node_modules/react-reconciler/index.js'))
  const require = createRequire(reconcilerPath)
  assert.equal(require('react'), React)
  const context = {}
  const commits = new Set<() => void>()
  const remove = (p: Host, c: Host) => { const i = p.children.indexOf(c); if (i >= 0) p.children.splice(i, 1) }
  const append = (p: Host, c: Host) => { remove(p, c); p.children.push(c) }
  const insert = (p: Host, c: Host, b: Host) => { remove(p, c); p.children.splice(p.children.indexOf(b), 0, c) }
  const nativeNodes = new WeakMap<Host, Node>()
  const syncNative = (node: Host): Node => {
    let element = nativeNodes.get(node)
    if (!element) {
      element = node.type === '#text' ? document.createTextNode(node.props.text) : document.createElement(node.type === 'root' ? 'div' : node.type)
      nativeNodes.set(node, element)
    }
    if (node.type === '#text') { element.textContent = node.props.text; return element }
    assert.ok(element instanceof HTMLElement)
    for (const name of element.getAttributeNames()) element.removeAttribute(name)
    for (const [name, value] of Object.entries(node.props)) {
      if (name === 'className') element.setAttribute('class', String(value))
      else if (name === 'tabIndex') element.setAttribute('tabindex', String(value))
      else if (name === 'disabled' || name === 'open') { if (value) element.setAttribute(name, '') }
      else if (name === 'id' || name === 'role' || name === 'type' || name.startsWith('aria-') || name.startsWith('data-')) {
        if (value !== undefined && value !== null) element.setAttribute(name, String(value))
      }
    }
    element.replaceChildren(...node.children.map(syncNative))
    return element
  }
  const getPublicInstance = (node: Host) => syncNative(node)
  let host: Host
  const syncOwnedDom = () => {
    if (typeof document === 'undefined') return
    const element = syncNative(host)
    if (!element.parentNode) document.body.appendChild(element)
  }
  const renderer = require(reconcilerPath)({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context, getPublicInstance,
    prepareForCommit: () => null,
    resetAfterCommit: () => { syncOwnedDom(); for (const listener of commits) listener() },
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
  host = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(host, 0, null, false, null, '', (e: unknown) => { throw e }, null)
  const flush = (fn = () => {}) => { renderer.flushSync(fn); for (let i = 0; i < 12; i++) { if (!renderer.flushPassiveEffects()) return; renderer.flushSync(() => {}) } assert.fail('Effects did not settle') }
  const render = (node: ReturnType<typeof createElement> | null) => flush(() => renderer.updateContainer(node, root, null))
  const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); flush() } }
  function find(predicate: (n: Host) => boolean, node = host): Host | undefined { if (predicate(node)) return node; for (const child of node.children) { const found = find(predicate, child); if (found) return found } }
  const text = (n: Host): string => n.type === '#text' ? n.props.text : n.children.map(text).join('')
  const button = (label: string) => { const n = find(n => n.type === 'button' && (n.props['aria-label'] === label || text(n) === label)); assert.ok(n, label); return n }
  const waitFor = (predicate: () => boolean, label: string) => new Promise<void>((resolve, reject) => {
    let complete = false, queued = false, checking = false
    let releaseOwner = () => {}
    const deadline = setTimeout(() => finish(new Error(`${label} did not settle through its real owner`)), 10_000)
    function finish(error?: unknown) {
      if (complete) return
      complete = true
      clearTimeout(deadline)
      commits.delete(wake)
      releaseOwner()
      if (error) reject(error)
      else resolve()
    }
    function verify() {
      if (complete || checking) return
      checking = true
      try {
        flush()
        if (predicate()) finish()
      } catch (error) { finish(error) }
      finally { checking = false }
    }
    function wake() {
      if (complete || queued || checking) return
      queued = true
      // A causal commit/publication/completion notification, never a disk-settlement tick.
      queueMicrotask(() => { queued = false; verify() })
    }
    commits.add(wake)
    try {
      releaseOwner = observeOwner?.(wake) ?? releaseOwner
      verify()
    } catch (error) { finish(error) }
  })
  return { host, text, render, flush, settle, waitFor, find, button,
    click: (label: string) => {
      const n = button(label); assert.ok(!n.props.disabled, label)
      const currentTarget = getPublicInstance(n)
      flush(() => n.props.onClick({ currentTarget, target: currentTarget }))
    },
    change: (label: string, value: string) => {
      const n = find(n => n.type === 'select' && n.props['aria-label'] === label)
      assert.ok(n, label); assert.ok(!n.props.disabled, label)
      flush(() => n.props.onChange({ currentTarget: { value } }))
    },
  }
}


// Exercise the real bridge hook and controller on the existing real React CPU host.
async function mountedCanonicalBridge(initialSnapshot: WorldProjectSnapshotV1 = createValidWorldSnapshot()) {
  const previousUi = useWorldsUiStore.getState()
  const previousLegacy = useWorldsSceneStore.getState()
  const projectKey = `world-${'a'.repeat(32)}`
  let snapshot = structuredClone(initialSnapshot)
  let denyWrites = false
  const writes: WorldProjectCommandRequest[] = []
  const errors: string[] = []
  const apply = (request: WorldProjectCommandRequest, persist: boolean) => {
    if (persist) writes.push(structuredClone(request))
    if (persist && denyWrites) return { ok: false as const, error: { code: 'write_failed' as const, message: 'Fixture write rejected', retryable: true } }
    const applied = applyWorldCommandBatch(snapshot, request.batch)
    assert.equal(applied.success, true, JSON.stringify(applied))
    if (!applied.success) throw new Error('Fixture command invalid')
    if (persist) snapshot = structuredClone(applied.snapshot)
    return { ok: true as const, value: { projectKey, snapshot: structuredClone(applied.snapshot), newRevision: applied.snapshot.project.revision,
      idempotent: false, changes: applied.changes, warnings: applied.warnings, inverse: applied.inverse,
      receipt: { transactionId: request.batch.transactionId, payloadSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), appliedRevision: applied.snapshot.project.revision } } }
  }
  const api: WorldProjectsApi = {
    async create() { throw new Error('Unused create') }, async delete() { throw new Error('Unused delete') },
    async list() { return { ok: true, value: { projects: [], issues: [] } } },
    async open() { return { ok: true, value: { status: 'ready', projectKey, snapshot: structuredClone(snapshot), durabilityWarnings: [] } } },
    async previewCommands(request) { return apply(request, false) }, async applyCommands(request) { return apply(request, true) },
  }
  const controller = createWorldEditorController(api)
  assert.equal((await controller.openProject(projectKey)).ok, true)
  const cpu = cpuHost()
  const authority = createWorldEditorViewportCommitAuthority()
  let lease = authority.issue()
  const pendingChanges: boolean[] = []
  let transformCompletion = Promise.resolve()
  let finishTransform: () => void = () => {}
  const admission = createWorldEditorTransformAdmission({
    getContext: () => { const state = controller.getState(); return { projectKey: state.projectKey, activeSceneId: state.activeSceneId, snapshot: state.session?.snapshot ?? null } },
    getViewportLease: () => lease, isViewportCurrent: authority.isCurrent,
    onError: (error) => errors.push(error),
    onPendingChange: (pending) => {
      pendingChanges.push(pending)
      if (pending) transformCompletion = new Promise<void>((resolve) => { finishTransform = resolve })
      else finishTransform()
    },
  })
  let bridge!: ReturnType<typeof useWorldEditorProjectionBridge>
  function Projection() {
    const state = React.useSyncExternalStore(controller.subscribe.bind(controller), controller.getState.bind(controller), controller.getState.bind(controller))
    bridge = useWorldEditorProjectionBridge({ controller, state, apiUrl: 'http://canonical.test', viewportCommitAuthority: authority,
      viewportCommitLease: lease, transformAdmission: admission, onError: (error) => errors.push(error) })
    React.useEffect(() => () => authority.revoke(), [])
    return createElement('projection', { 'data-items': bridge.viewerProps.items.length })
  }
  useWorldsUiStore.getState().resetForScene()
  cpu.render(createElement(Projection)); await cpu.settle()
  return { controller, cpu, writes, errors, bridge: () => bridge, rejectWrites: () => { denyWrites = true },
    async settleTransforms() {
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          transformCompletion,
          new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Transform ownership did not settle')), 1_000) }),
        ])
      } finally { clearTimeout(deadline) }
      await cpu.settle()
      assert.equal(admission.pending, false, 'the real admission must release pending ownership')
      assert.equal(pendingChanges.at(-1), false, 'actual pending-to-clear completion was observed')
    },
    async remount() { cpu.render(null); lease = authority.issue(); cpu.render(createElement(Projection)); await cpu.settle() },
    async cleanup() { cpu.render(null); await controller.closeProject(); useWorldsUiStore.setState(previousUi, true); useWorldsSceneStore.setState(previousLegacy, true) },
  }
}

// Mount the actual Workbench asset-owner callbacks without the unrelated viewport/Play graph.
// The callback and its lifetime effects are taken verbatim from their production owner.
async function loadWorkbenchAssetOwnerModule() {
  const source = await readFile(workbenchEntry, 'utf8')
  const take = (start: string, end: string) => {
    const from = source.indexOf(start), to = source.indexOf(end, from)
    assert.ok(from >= 0 && to > from, `Missing actual Workbench owner boundary: ${start}`)
    return source.slice(from, to)
  }
  const lifetime = take('  const pendingAssetRef =', '  const playIntentSequenceRef =')
  const dispatch = take('  const dispatchCommands = useCallback', '  const handleGraphicsProfileChoice =')
  const add = take('  const addAsset = useCallback', '  const convertLegacyScene =')
  const imports = {
    hook: path.join(worldsRoot, 'editor/useWorldEditorController.ts'),
    ui: path.join(worldsRoot, 'editor/worldsUiStore.ts'),
    builders: path.join(worldsRoot, 'editor/worldEditorCommandBuilders.ts'),
    authoring: path.join(worldsRoot, 'editor/worldAuthoringModel.ts'),
    placement: path.join(worldsRoot, 'worldsScenePlacement.ts'),
  }
  const tempDir = await mkdtemp(path.join(tmpdir(), '.tmp-worlds-asset-owner-'))
  try {
    const outfile = path.join(tempDir, 'asset-owner.bundle.mjs')
    const result = await build({
      stdin: { sourcefile: 'WorkbenchAssetOwner.tsx', resolveDir: path.dirname(workbenchEntry), loader: 'tsx', contents: `
        import {createElement, useCallback, useLayoutEffect, useRef, useState} from 'react'
        import {useWorldEditorController, createWorldUiTransactionId} from ${JSON.stringify(imports.hook)}
        import {useWorldsUiStore} from ${JSON.stringify(imports.ui)}
        import {buildAddModelEntityCommands, createDeterministicWorldEditorIdentityGenerator} from ${JSON.stringify(imports.builders)}
        import {buildAttachAudioSourceCommands} from ${JSON.stringify(imports.authoring)}
        import {appendWorldSceneItem} from ${JSON.stringify(imports.placement)}
        import type {WorldCommand} from '../core/worldCommands.ts'
        import type {WorldEditorController, WorldEditorDispatchAuthority} from '../editor/worldEditorController.ts'
        import type {useWorldEditorProjectionBridge} from '../editor/useWorldEditorProjectionBridge.ts'
        import type {WorldAssetLibraryRenderable, openWorldAssetLibraryRenderable as OpenRenderable} from '../worldAssetLibraryService.ts'
        interface AssetOwnerProps {
          ownerController: WorldEditorController
          bridge: ReturnType<typeof useWorldEditorProjectionBridge>
          apiUrl: string
          open: typeof OpenRenderable
          onError(message: string): void
        }
        export function AssetOwner({ownerController, bridge, apiUrl, open, onError}: AssetOwnerProps) {
          const editor = useWorldEditorController(ownerController)
          const {controller, state} = editor
          const activeEntityId = useWorldsUiStore(value => value.activeEntityId)
          const setSelection = useWorldsUiStore(value => value.setSelection)
          const [addingAssetId, setAddingAssetId] = useState<string | null>(null)
          const announceError = useCallback(onError, [onError])
          const announceStatus = useCallback(() => {}, [])
          const stopTimelinePreview = useCallback(() => {}, [])
          const openWorldAssetLibraryRenderable = open
          const readWorldAssetLibraryAudio = async () => { throw new Error('Unexpected audio request in model-owner fixture') }
          ${lifetime}
          ${dispatch}
          ${add}
          return createElement('asset-owner', {addingAssetId, onAddAsset:addAsset})
        }
      ` },
      outfile, bundle: true, write: false, format: 'esm', platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [{ name: 'actual-asset-owner-boundaries', setup(buildApi) {
        buildApi.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
        buildApi.onResolve({ filter: /.*/ }, args => Object.values(imports).includes(args.path)
          ? { path: pathToFileURL(args.path).href, external: true } : null)
      } }],
    })
    assert.equal(result.outputFiles.length, 1)
    await writeFile(outfile, result.outputFiles[0].contents)
    return { module: await import(pathToFileURL(outfile).href), cleanup: () => rm(tempDir, { recursive: true, force: true }) }
  } catch (error) { await rm(tempDir, { recursive: true, force: true }); throw error }
}

async function mountWorkbenchAssetOwner(f: Awaited<ReturnType<typeof mountedCanonicalBridge>>, open: (request: {workspacePath: string}, apiUrl: string) => Promise<unknown>) {
  const loaded = await loadWorkbenchAssetOwnerModule(), cpu = cpuHost()
  const onError = (message: string) => f.errors.push(message)
  function Owner() {
    React.useSyncExternalStore(f.controller.subscribe.bind(f.controller), f.controller.getState.bind(f.controller), f.controller.getState.bind(f.controller))
    return createElement(loaded.module.AssetOwner, { ownerController: f.controller, bridge: f.bridge(), apiUrl: 'http://canonical.test', open, onError })
  }
  cpu.render(createElement(Owner)); await cpu.settle()
  return { cpu, node: () => { const node = cpu.find(n => n.type === 'asset-owner'); assert.ok(node); return node },
    async cleanup() { cpu.render(null); await loaded.cleanup() },
  }
}

type PageRead<T> = { url: string; path?: string; settled: boolean; promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function createPageLibraryHarness(initialAssets = [asset('a', 'A'), asset('b', 'B')], controlled = false) {
  type List = { success: true; assets: ReturnType<typeof asset>[] }
  type Open = { success: true; asset: ReturnType<typeof asset> }
  const lists: PageRead<List>[] = [], opens: PageRead<Open>[] = []
  const listeners = new Set<() => void>()
  function held<T>(url: string, workspacePath?: string): PageRead<T> {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    const read: PageRead<T> = { url, path: workspacePath, settled: false, promise,
      resolve(value) { assert.equal(read.settled, false); read.settled = true; resolve(value) },
      reject(error) { assert.equal(read.settled, false); read.settled = true; reject(error) },
    }
    return read
  }
  const fixture = {
    apiUrl: 'http://A', lists, opens,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    list(url: string) { const read = held<List>(url); lists.push(read); if (!controlled) read.resolve({ success: true, assets: initialAssets }); return read.promise },
    open(request: { workspacePath: string }, url: string) { const read = held<Open>(url, request.workspacePath); opens.push(read); return read.promise },
    changeApi(cpu: ReturnType<typeof cpuHost>, url: string) { cpu.flush(() => { fixture.apiUrl = url; listeners.forEach(fn => fn()) }) },
    async drain() {
      for (const read of lists) if (!read.settled) read.resolve({ success: true, assets: [] })
      for (const read of opens) if (!read.settled) read.resolve({ success: true, asset: asset('detached', 'Detached') })
      await Promise.all([...lists.map(read => read.promise.then(() => undefined, () => undefined)), ...opens.map(read => read.promise.then(() => undefined, () => undefined))])
    },
  }
  return fixture
}

async function mountedPage(fixture: ReturnType<typeof createPageLibraryHarness>, seed: 'empty' | 'model' | false = 'empty') {
  const globals = globalThis as typeof globalThis & { __worldsPageHarness?: typeof fixture }
  const previous = globals.__worldsPageHarness
  globals.__worldsPageHarness = fixture
  let loaded: Awaited<ReturnType<typeof loadPageModule>> | undefined
  let cpu: ReturnType<typeof cpuHost> | undefined
  try {
    loaded = await loadPageModule(seed)
    const activeLoaded = loaded
    cpu = cpuHost(listener => {
      const releasePublication = activeLoaded.controller.subscribe(listener)
      const releaseCompletion = activeLoaded.observeCompletion(listener)
      return () => { releasePublication(); releaseCompletion() }
    })
    const activeCpu = cpu
    // A stable real parent keys the actual Page; API/project/asset identities are not substituted.
    function PageLifetime({ id }: { id: string }) { return createElement(activeLoaded.module.default, { key: id }) }
    const remount = (id: string) => activeCpu.render(createElement(PageLifetime, { id }))
    remount('A1')
    await cpu.waitFor(() => !activeCpu.find(n => n.type === 'strong' && activeCpu.text(n) === 'Loading Worlds')
      && (seed ? activeLoaded.controller.getState().lifecycle === 'ready' && !!activeLoaded.controller.getState().session && fixture.lists.length === 1
        : activeLoaded.controller.getState().lifecycle === 'closed'), 'canonical Page initialization')
    const canvas = () => activeCpu.find(n => n.props['aria-label'] === 'Worlds 3D canvas')
    const openAssets = () => { if (!activeCpu.find(n => n.props.role === 'dialog' && n.props['aria-label'] === 'Assets dock')) activeCpu.click('Open Assets dock') }
    return { ...loaded, cpu, canvas, openAssets, remount,
      async cleanup() {
        try { activeCpu.render(null) }
        finally {
          try { await fixture.drain(); await activeCpu.settle() }
          finally {
            try { await activeLoaded.cleanup() }
            finally { globals.__worldsPageHarness = previous }
          }
        }
      },
    }
  } catch (error) {
    try { if (cpu) cpu.render(null) }
    finally {
      try { await fixture.drain(); if (cpu) await cpu.settle() }
      finally {
        try { if (loaded) await loaded.cleanup() }
        finally { globals.__worldsPageHarness = previous }
      }
    }
    throw error
  }
}

for (const scenario of ['same-API session ABA', 'API ABA', 'latest refresh', 'unmount'] as const) {
  test(`mounted WorldsPage fences ${scenario} responses and preserves new busy ownership`, async () => {
    const fixture = createPageLibraryHarness(undefined, true)
    const f = await mountedPage(fixture)
    const list = (index: number, assets = [asset('a', 'A'), asset('b', 'B')]) => fixture.lists[index].resolve({ success: true, assets })
    const added = () => f.controller.getState().session!.snapshot.scenes.flatMap(scene => scene.entities)
    try {
      assert.equal(fixture.lists.length, 1)
      list(0); await f.cpu.settle(); f.openAssets(); await f.cpu.settle()
      if (scenario !== 'latest refresh') {
        f.cpu.click('Add A to scene')
        assert.equal(fixture.opens[0].path, 'Workflows/a.ply')
      }
      if (scenario === 'same-API session ABA') {
        const before = structuredClone(f.controller.getState().session!.snapshot)
        const projectKey = f.controller.getState().projectKey
        const sceneId = f.controller.getState().activeSceneId
        const selection = structuredClone(useWorldsUiStore.getState().selectedEntityIds)
        const publications: WorldProjectSnapshotV1[] = []
        let previousSnapshot = f.controller.getState().session!.snapshot
        const releasePublication = f.controller.subscribe(state => {
          if (state.session && state.session.snapshot !== previousSnapshot) {
            previousSnapshot = state.session.snapshot
            publications.push(structuredClone(previousSnapshot))
          }
        })
        try {
          f.remount('B')
          await f.cpu.waitFor(() => fixture.lists.length === 2 && f.controller.getState().lifecycle === 'ready'
            && !f.cpu.find(n => n.type === 'strong' && f.cpu.text(n) === 'Loading Worlds'), 'same-API session B')
          f.remount('A2')
          await f.cpu.waitFor(() => fixture.lists.length === 3 && f.controller.getState().lifecycle === 'ready'
            && !f.cpu.find(n => n.type === 'strong' && f.cpu.text(n) === 'Loading Worlds'), 'same-API session A2')
          f.openAssets(); await f.cpu.settle()
          assert.equal(f.controller.getState().projectKey, projectKey)
          assert.equal(f.controller.getState().session!.snapshot.project.projectId, before.project.projectId)
          assert.equal(f.controller.getState().activeSceneId, sceneId, 'this is a mounted lifetime ABA, not a scene transition')
          assert.deepEqual(fixture.lists.map(read => read.url), ['http://A', 'http://A', 'http://A'])
          assert.equal(f.cpu.button('Refresh assets').props.disabled, true, 'current A2 list is held')
          list(1, [asset('old', 'Old B')])
          await fixture.lists[1].promise; await f.cpu.settle()
          assert.equal(f.canvas()?.props['data-items'], 0, 'old same-API lifetime cannot resurrect an item')
          assert.equal(f.writes.length, 0, 'detached A1 cannot issue a canonical command')
          assert.deepEqual(f.controller.getState().session!.snapshot, before, 'no stale canonical snapshot publication')
          assert.deepEqual([...publications], [], 'no stale canonical publication through the actual controller')
          assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, selection, 'stale open cannot publish selection')
          assert.equal(f.cpu.button('Refresh assets').props.disabled, true, 'B finally cannot clear current A2 list busy')
          list(2); await fixture.lists[2].promise; await f.cpu.settle()
          assert.equal(f.cpu.find(n => n.props['aria-label'] === 'Add Old B to scene'), undefined)
          assert.equal(f.cpu.button('Add A to scene').props.disabled, false)
          f.cpu.click('Add A to scene'); assert.equal(fixture.opens.length, 2)
          assert.equal(fixture.opens[1].path, fixture.opens[0].path, 'asset identity deliberately repeats')
          assert.equal(fixture.opens[1].url, fixture.opens[0].url, 'API facade deliberately repeats')
          assert.equal(f.cpu.button('Adding A').props.disabled, true, 'A2 owns its pending add')
          fixture.opens[0].resolve({ success: true, asset: asset('a', 'Old A') })
          await fixture.opens[0].promise; await f.cpu.settle()
          assert.equal(f.canvas()?.props['data-items'], 0, 'stale A1 open cannot publish into A2')
          assert.equal(f.writes.length, 0)
          assert.deepEqual(f.controller.getState().session!.snapshot, before)
          assert.deepEqual([...publications], [])
          assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, selection)
          assert.equal(f.cpu.button('Adding A').props.disabled, true, 'old A1 finally cannot clear the newer A2 add busy owner')
          fixture.opens[1].resolve({ success: true, asset: asset('a', 'A') })
          await f.cpu.waitFor(() => f.writes.length === 1 && f.canvas()?.props['data-items'] === 1
            && !!f.cpu.find(n => n.props['aria-label'] === 'Add A to scene' && !n.props.disabled), 'current same-API asset add')
          assert.equal(f.canvas()?.props['data-path'], 'Workflows/a.ply')
          assert.equal(added().length, 1)
          assert.equal(added()[0].name, 'A')
          assert.equal(f.canvas()?.props['data-selected'], added()[0].id)
          assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, [added()[0].id])
          assert.equal(publications.length, 1, 'only the current lifetime publishes its canonical edit')
          assert.equal(publications[0].scenes.flatMap(scene => scene.entities)[0].name, 'A')
          assert.ok(f.cpu.find(n => n.props.role === 'dialog' && n.props['aria-label'] === 'Assets dock'), 'adding keeps the Assets dock visible')
          f.cpu.click('Add B to scene'); assert.equal(fixture.opens[2].path, 'Workflows/b.ply')
          fixture.opens[2].reject(new Error('Current open failed')); await f.cpu.settle()
          assert.ok(f.cpu.find(n => n.props.role === 'alert' && f.cpu.text(n) === 'Current open failed'))
          assert.equal(f.cpu.button('Add B to scene').props.disabled, false)
          assert.equal(f.writes.length, 1)
          assert.equal(publications.length, 1)
        } finally { releasePublication() }
      } else if (scenario === 'API ABA') {
        fixture.changeApi(f.cpu, 'http://B'); await f.cpu.waitFor(() => fixture.lists.length === 2, 'backend B list')
        fixture.changeApi(f.cpu, 'http://A'); await f.cpu.waitFor(() => fixture.lists.length === 3, 'backend A list')
        fixture.opens[0].resolve({ success: true, asset: asset('a', 'Old A') }); list(1, [asset('old', 'Old B')]); await f.cpu.settle()
        assert.equal(f.canvas()?.props['data-items'], 0)
        assert.equal(f.writes.length, 0)
        f.openAssets(); await f.cpu.settle()
        assert.equal(f.cpu.button('Refresh assets').props.disabled, true, 'stale A open/B list cannot clear the current A list busy owner')
        list(2, [asset('fresh', 'Fresh')]); await f.cpu.settle(); f.openAssets(); await f.cpu.settle()
        assert.equal(f.cpu.find(n => n.props['aria-label'] === 'Add Old B to scene'), undefined)
        f.cpu.click('Add Fresh to scene'); assert.equal(fixture.opens[1].path, 'Workflows/fresh.ply')
        assert.equal(fixture.opens[1].url, 'http://A')
        assert.equal(f.cpu.button('Adding Fresh').props.disabled, true)
        assert.equal(f.canvas()?.props['data-items'], 0)
        assert.equal(f.writes.length, 0)
        fixture.opens[1].resolve({ success: true, asset: asset('fresh', 'Fresh') })
        await f.cpu.waitFor(() => f.writes.length === 1 && f.canvas()?.props['data-items'] === 1
          && !!f.cpu.find(n => n.props['aria-label'] === 'Add Fresh to scene' && !n.props.disabled), 'new backend authoring owner')
        assert.equal(added().length, 1)
        assert.equal(added()[0].name, 'Fresh')
        assert.equal(f.canvas()?.props['data-selected'], added()[0].id)
      } else if (scenario === 'latest refresh') {
        const refresh = f.cpu.button('Refresh assets').props.onClick
        f.cpu.flush(() => { refresh(); refresh() }); assert.equal(fixture.lists.length, 3)
        list(1, [asset('old', 'Old')]); await f.cpu.settle()
        assert.equal(f.cpu.button('Refresh assets').props.disabled, true, 'old finally cannot clear the latest list busy owner')
        assert.equal(f.cpu.find(n => n.props.role === 'alert'), undefined)
        list(2); await f.cpu.settle()
        assert.equal(f.cpu.find(n => n.props['aria-label'] === 'Add Old to scene'), undefined)
        assert.equal(f.cpu.button('Add A to scene').props.disabled, false)
        f.cpu.click('Refresh assets'); fixture.lists[3].reject(new Error('Current list failed')); await f.cpu.settle()
        assert.ok(f.cpu.find(n => n.props.role === 'alert' && f.cpu.text(n) === 'Current list failed'))
        assert.equal(f.cpu.button('Refresh assets').props.disabled, false)
        const refreshAgain = f.cpu.button('Refresh assets').props.onClick
        f.cpu.flush(() => { refreshAgain(); refreshAgain() })
        fixture.lists[4].reject(new Error('Stale list failed')); await f.cpu.settle()
        assert.equal(f.cpu.button('Refresh assets').props.disabled, true)
        assert.equal(f.cpu.find(n => n.props.role === 'alert'), undefined, 'stale error cannot own the refreshed dock')
        list(5, [asset('b', 'B')]); await f.cpu.settle()
        assert.equal(f.cpu.button('Add B to scene').props.disabled, false)
        assert.equal(f.writes.length, 0)
      } else {
        const before = structuredClone(f.controller.getState().session!.snapshot)
        f.cpu.render(null); fixture.opens[0].resolve({ success: true, asset: asset('a', 'Detached') }); await f.cpu.settle()
        assert.equal(f.canvas(), undefined)
        assert.equal(f.writes.length, 0, 'detached read cannot persist')
        assert.deepEqual(f.controller.getState().session!.snapshot, before)
      }
    } finally { await f.cleanup() }
  })
}

test('WorldsPage rejects malformed asset-library entries and accepts an empty list through the real projection boundary', () => {
  assert.deepEqual(projectWorldAssetLibraryListResult({ success: true,
    // @ts-expect-error Deliberately malformed IPC response tests the real wire boundary.
    entries: undefined }, 'http://A'), { success: false, error: 'Workspace asset-library returned an invalid entries payload.' })
  assert.deepEqual(projectWorldAssetLibraryListResult({ success: true, entries: [] }, 'http://A'), { success: true, assets: [] })
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

test('Worlds bridge batches selected transforms with captured authority and rolls back rejected writes', async () => {
  const initial = createValidWorldSnapshot()
  const hero = initial.scenes[0].entities[0]
  for (const suffix of ['hull', 'unrelated']) initial.scenes[0].entities.push({ ...structuredClone(hero), id: `entity:${suffix}`, name: suffix,
    components: hero.components.map(component => ({ ...structuredClone(component), id: `component:${suffix}` })) })
  const f = await mountedCanonicalBridge(initial)
  try {
    f.cpu.flush(() => useWorldsUiStore.getState().setSelection(['entity:hero', 'entity:hull'], 'entity:hull'))
    assert.deepEqual(f.bridge().viewerProps.selectedItemIds, ['entity:hero', 'entity:hull'])
    const unrelated = structuredClone(f.controller.getState().session!.snapshot.scenes[0].entities[2])
    const captured = f.controller.getState().session!.snapshot.project.revision
    const transform: WorldTransform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 2, 2] }
    f.bridge().viewerProps.onTransformItems!([{ itemId: 'entity:hero', transform }, { itemId: 'entity:hull', transform }])
    await f.settleTransforms()
    assert.equal(f.writes.length, 1)
    assert.equal(f.writes[0].batch.baseRevision, captured)
    assert.equal(f.writes[0].batch.projectId, initial.project.projectId)
    assert.equal(f.writes[0].batch.commands.length, 2)
    assert.deepEqual(f.controller.getState().session!.snapshot.scenes[0].entities.slice(0, 2).map(entity => entity.transform), [transform, transform])
    assert.deepEqual(f.controller.getState().session!.snapshot.scenes[0].entities[2], unrelated)
    assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, ['entity:hero', 'entity:hull'])
    f.rejectWrites()
    f.bridge().viewerProps.onTransformItems!([{ itemId: 'entity:hull', transform: { ...transform, position: [9, 9, 9] } }])
    await f.settleTransforms()
    assert.equal(f.writes.length, 2)
    assert.deepEqual(f.controller.getState().session!.snapshot.scenes[0].entities[1].transform, transform)
    assert.deepEqual(useWorldsSceneStore.getState().sceneItems.find(item => item.id === 'entity:hull')?.transform, transform)
    assert.ok(f.errors.includes('Fixture write rejected'))
  } finally { await f.cleanup() }
})

test('WorldsPage keeps canonical entity selection separate from read-only navigation collision surfaces', async () => {
  const surface = createWorldCollisionSurfacePreset('floor', { id: 'surface-navigation-floor' })!
  const imported = importLegacyWorldsSceneManifest(buildWorldsSceneManifest([asset('hero', 'Hero').item], [surface]))
  assert.equal(imported.success, true, JSON.stringify(imported))
  if (!imported.success) assert.fail('Canonical collision fixture import failed')
  const f = await mountedCanonicalBridge(imported.snapshot)
  try {
    const before = structuredClone(f.controller.getState().session!.snapshot)
    const hero = f.bridge().projection!.items.find(item => item.workspacePath === 'Workflows/hero.ply')!
    assert.ok(hero)
    const projectedSurfaces = structuredClone(f.bridge().projection!.collisionSurfaces)
    assert.equal(projectedSurfaces.length, 1)
    assert.equal(f.bridge().viewerProps.collisionEditMode, false)
    assert.equal('onAddCollisionSurface' in f.bridge().viewerProps, false)
    assert.equal('onTransformCollisionSurface' in f.bridge().viewerProps, false)
    assert.equal('onRemoveCollisionSurface' in f.bridge().viewerProps, false)
    f.cpu.flush(() => f.bridge().viewerProps.onSelectItem!(hero.id))
    assert.equal(useWorldsUiStore.getState().activeEntityId, hero.id)
    assert.deepEqual(f.bridge().viewerProps.selectedItemIds, [hero.id])
    assert.equal(useWorldsSceneStore.getState().selectedCollisionSurfaceId, null)
    assert.equal(f.bridge().viewerProps.collisionEditMode, false)
    assert.deepEqual(f.bridge().projection!.collisionSurfaces, projectedSurfaces)
    assert.deepEqual(f.controller.getState().session!.snapshot, before)
    assert.equal(f.writes.length, 0, 'selection cannot mutate canonical collision authoring')
  } finally { await f.cleanup() }
})

test('legacy collision presets retain geometry and identity through canonical import and navigation projection', async () => {
  const presets = ['rectangle', 'square', 'triangle', 'wall', 'floor', 'ramp'] as const
  const surfaces = presets.map(preset => createWorldCollisionSurfacePreset(preset, { id: `surface-${preset}` })!)
  assert.deepEqual(surfaces.map(surface => surface.preset), [...presets])
  assert.equal(new Set(surfaces.map(surface => surface.id)).size, presets.length)
  const imported = importLegacyWorldsSceneManifest(buildWorldsSceneManifest([], surfaces))
  assert.equal(imported.success, true, JSON.stringify(imported))
  if (!imported.success) assert.fail('Preset import failed')
  const f = await mountedCanonicalBridge(imported.snapshot)
  try {
    assert.deepEqual(f.bridge().projection!.collisionSurfaces.map(surface => surface.preset).sort(), [...presets].sort())
    assert.equal(f.bridge().viewerProps.collisionEditMode, false, 'Legacy navigation colliders are view-only, not a simulation editing alias')
    const before = structuredClone(f.controller.getState().session!.snapshot)
    const colliderId = before.scenes[0].entities[0].id
    f.cpu.flush(() => useWorldsUiStore.getState().setSelection([colliderId], colliderId))
    assert.equal(useWorldsUiStore.getState().activeEntityId, colliderId)
    assert.equal(useWorldsSceneStore.getState().selectedCollisionSurfaceId, null)
    assert.deepEqual(f.controller.getState().session!.snapshot, before)
    const analysis = analyzeLegacyWorldsSceneExport(before)
    const exported = exportLegacyWorldsSceneManifest(before, { acceptedLosses: analysis.losses.map(loss => loss.id) })
    assert.equal(exported.success, true, JSON.stringify(exported))
    if (!exported.success) assert.fail('Preset export failed')
    assert.deepEqual(exported.manifest.collisionSurfaces?.surfaces.map(surface => ({ id: surface.id, preset: surface.preset, geometry: surface.geometry, transform: surface.transform })),
      surfaces.map(surface => ({ id: surface.id, preset: surface.preset, geometry: surface.geometry, transform: surface.transform })))
  } finally { await f.cleanup() }
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

test('Worlds pending placement is transient while canonical add preserves placement and post-success selection', async () => {
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

    const f = await mountedCanonicalBridge()
    try {
      const openedAsset = { ...asset('pending', 'Pending'), item: pending }
      const placement = appendWorldSceneItem(f.bridge().projection!.items, pending)
      const placedItem = placement.sceneItems.find(candidate => candidate.id === placement.selectedSceneItemId)!
      const owner = await mountWorkbenchAssetOwner(f, async request => {
        assert.equal(request.workspacePath, openedAsset.workspacePath)
        return { success: true, asset: openedAsset }
      })
      try {
        const add = owner.node().props.onAddAsset(openedAsset)
        await add; await owner.cpu.settle(); await f.cpu.settle()
        assert.equal(f.writes.length, 1)
        const added = f.writes[0].batch.commands.find(command => command.type === 'add-entity')
        assert.ok(added && added.type === 'add-entity')
        assert.deepEqual(f.controller.getState().session!.snapshot.scenes[0].entities.find(entity => entity.id === added.entity.id)?.transform, placedItem.transform)
        assert.equal(f.bridge().viewerProps.selectedItemId, added.entity.id, 'the actual Workbench callback selects only after successful dispatch')
        assert.equal(owner.node().props.addingAssetId, null)
      } finally { await owner.cleanup() }
      assert.equal(useWorldsSceneStore.getState().pendingSurfacePlacementItemId, null)
    } finally { await f.cleanup() }
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

test('canonical import projects exact initial view and preserves it through legacy export', async () => {
  const view = { position: [8, 5, 12] as [number, number, number], target: [0, 1, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number] }
  const manifest = buildWorldsSceneManifest([asset('hero', 'Hero').item], [], { initialView: view })
  const imported = importLegacyWorldsSceneManifest(manifest)
  assert.equal(imported.success, true, JSON.stringify(imported))
  if (!imported.success) assert.fail('View import failed')
  assert.deepEqual(imported.snapshot.scenes[0].editor?.initialView, view)
  const f = await mountedCanonicalBridge(imported.snapshot)
  try {
    assert.deepEqual(f.bridge().viewerProps.initialView, view)
    assert.deepEqual(useWorldsSceneStore.getState().initialView, view)
    const analysis = analyzeLegacyWorldsSceneExport(f.controller.getState().session!.snapshot)
    const exported = exportLegacyWorldsSceneManifest(f.controller.getState().session!.snapshot, { acceptedLosses: analysis.losses.map(loss => loss.id) })
    assert.equal(exported.success, true, JSON.stringify(exported))
    if (!exported.success) assert.fail('View export failed')
    assert.deepEqual(exported.manifest.initialView, view)
    assert.deepEqual(manifest.initialView, view)
  } finally { await f.cleanup() }
})


test('legacy path-derived IDs allocate bounded canonical identities without rewriting source paths or valid old IDs', () => {
  const ids = ['world:Workflows/hero.ply', String.raw`world:Workflows\hero.ply`, `world:Workflows/${'a'.repeat(320)}.ply`, 'legacy-safe']
  const items = ids.map((id, index) => ({ ...asset(`id-${index}`, `Item ${index}`).item, id }))
  const initialView = { position: [8, 5, 12] as [number, number, number], target: [0, 1, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number] }
  const manifest = buildWorldsSceneManifest(items, [], { initialView })
  const original = structuredClone(manifest)
  const first = importLegacyWorldsSceneManifest(manifest)
  const again = importLegacyWorldsSceneManifest(manifest)
  assert.equal(first.success, true, JSON.stringify(first))
  assert.equal(again.success, true, JSON.stringify(again))
  if (!first.success || !again.success) assert.fail('Path-derived identity import failed')
  const entities = first.snapshot.scenes[0].entities
  const canonicalIds = [...first.snapshot.project.resources.map(resource => resource.id), ...entities.flatMap(entity => [entity.id, ...entity.components.map(component => component.id)])]
  assert.ok(canonicalIds.every(isWorldCanonicalId), JSON.stringify(canonicalIds))
  assert.equal(new Set(canonicalIds).size, canonicalIds.length)
  assert.deepEqual(entities.map(entity => entity.id), again.snapshot.scenes[0].entities.map(entity => entity.id), 'raw-base digests and collision handling stay deterministic')
  assert.notEqual(entities[0].id, entities[1].id, 'slash and backslash raw identities keep distinct digests')
  assert.equal(entities[3].id, 'entity:legacy-safe', 'valid existing identities are not rewritten')
  assert.deepEqual(first.snapshot.project.resources.filter(resource => resource.type === 'model').map(resource => resource.workspacePath), items.map(item => item.workspacePath))
  assert.deepEqual(first.snapshot.scenes[0].editor?.initialView, initialView)
  assert.deepEqual(manifest, original, 'import does not mutate the opaque legacy identity or source path')
  const analysis = analyzeLegacyWorldsSceneExport(first.snapshot)
  const exported = exportLegacyWorldsSceneManifest(first.snapshot, { acceptedLosses: analysis.losses.map(loss => loss.id) })
  assert.equal(exported.success, true, JSON.stringify(exported))
  if (!exported.success) assert.fail('Path-derived identity export failed')
  assert.ok(exported.manifest.assets.every(asset => (asset.id?.length ?? 0) <= 228), 'the unchanged legacy allocator retains its separate bound')
  const reimported = importLegacyWorldsSceneManifest(exported.manifest)
  assert.equal(reimported.success, true, JSON.stringify(reimported))
  if (!reimported.success) assert.fail('Exported identity reimport failed')
  assert.deepEqual(reimported.snapshot.scenes[0].editor?.initialView, initialView)
})

test('canonical project and UI selection survive viewport remount while stale captured callbacks cannot write', async () => {
  const f = await mountedCanonicalBridge()
  try {
    f.cpu.flush(() => useWorldsUiStore.getState().setSelection(['entity:hero'], 'entity:hero'))
    const snapshot = structuredClone(f.controller.getState().session!.snapshot)
    const oldViewer = f.bridge().viewerProps
    const oldGesture = oldViewer.onTransformGestureBegin!(['entity:hero'])
    assert.ok(oldGesture, 'A real gesture captures the original viewport lease')
    await f.remount()
    assert.deepEqual(f.controller.getState().session!.snapshot, snapshot)
    assert.deepEqual(f.bridge().viewerProps.selectedItemIds, ['entity:hero'])
    assert.equal(f.bridge().viewerProps.selectedItemId, 'entity:hero')
    const transform: WorldTransform = { position: [7, 8, 9], rotation: [0, 0, 0], scale: [1, 1, 1] }
    oldViewer.onTransformItems!([{ itemId: 'entity:hero', transform }], { gesture: oldGesture }); await f.cpu.settle()
    assert.equal(f.writes.length, 0, 'A retired viewport lease cannot authorize an old completion')
    assert.deepEqual(f.controller.getState().session!.snapshot, snapshot)
    const captured = f.controller.getState()
    assert.equal((await f.controller.setActiveScene('scene:two')).ok, true)
    const stale = await f.controller.dispatchCommands({ transactionId: 'tx:late-open', origin: 'ui', commands: [{ type: 'patch-entity', sceneId: 'scene:one', entityId: 'entity:hero', patch: { transform } }] }, {
      projectKey: captured.projectKey!, projectId: captured.session!.snapshot.project.projectId,
      baseRevision: captured.session!.snapshot.project.revision, activeSceneId: captured.activeSceneId!,
    })
    assert.equal(stale.ok, false, 'A late captured open/add authority must not cross scenes')
    assert.equal(f.writes.length, 0)
    assert.deepEqual(f.controller.getState().session!.snapshot.scenes[0].entities[0].transform, snapshot.scenes[0].entities[0].transform)
  } finally { await f.cleanup() }
})


test('Worlds Workbench retains CURRENT workspace remount and asynchronous library ownership', async () => {
  const source = await readFile(workbenchEntry, 'utf8')
  assert.match(source, /<WorldsWorkspace key=\{apiUrl\} apiUrl=\{apiUrl\} \/>/)
  assert.match(source, /const epoch = \+\+assetListEpochRef\.current/)
  assert.match(source, /const ownsList = \(\) => assetsMountedRef\.current && assetListEpochRef\.current === epoch/)
  assert.match(source, /if \(!ownsList\(\)\) return/)
  assert.match(source, /if \(ownsList\(\)\) setAssetsLoading\(false\)/)
  assert.match(source, /const ownsOpen = \(\) => assetsMountedRef\.current && assetOpenEpochRef\.current === epoch && controller\.getState\(\)\.editorEpoch === editorEpoch/)
  assert.match(source, /if \(!ownsOpen\(\)\) return/g)
  assert.match(source, /if \(ownsOpen\(\)\) \{\s*pendingAssetRef\.current = null\s*setAddingAssetId\(null\)/)
})


test('actual Workbench asset owner rejects failed writes and stale opens without clearing a newer pending add', async () => {
  const f = await mountedCanonicalBridge()
  const opens: Array<{ path: string; resolve: (value: unknown) => void }> = []
  const owner = await mountWorkbenchAssetOwner(f, request => new Promise(resolve => opens.push({ path: request.workspacePath, resolve })))
  const oldAsset = asset('old-open', 'Old open'), currentAsset = asset('current-open', 'Current open')
  try {
    f.cpu.flush(() => useWorldsUiStore.getState().setSelection(['entity:hero'], 'entity:hero'))
    await owner.cpu.settle(); await f.cpu.settle()
    const oldAdd = owner.node().props.onAddAsset(oldAsset)
    await owner.cpu.settle()
    assert.equal(owner.node().props.addingAssetId, oldAsset.id)
    assert.equal(opens[0].path, oldAsset.workspacePath)
    assert.equal((await f.controller.setActiveScene('scene:two')).ok, true)
    await owner.cpu.settle(); await f.cpu.settle()
    assert.equal(owner.node().props.addingAssetId, null, 'the production scene/epoch effect retires the old pending owner')
    const currentAdd = owner.node().props.onAddAsset(currentAsset)
    await owner.cpu.settle()
    assert.equal(owner.node().props.addingAssetId, currentAsset.id)
    const snapshot = structuredClone(f.controller.getState().session!.snapshot)
    const selection = [...useWorldsUiStore.getState().selectedEntityIds]
    opens[0].resolve({ success: true, asset: oldAsset })
    await oldAdd; await owner.cpu.settle(); await f.cpu.settle()
    assert.equal(f.writes.length, 0, 'a stale actual open cannot dispatch into the newly active scene')
    assert.deepEqual(f.controller.getState().session!.snapshot, snapshot)
    assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, selection)
    assert.equal(owner.node().props.addingAssetId, currentAsset.id, 'old finally cannot clear the newer actual request')
    assert.equal(opens[1].path, currentAsset.workspacePath)
    f.rejectWrites()
    opens[1].resolve({ success: true, asset: currentAsset })
    await currentAdd; await owner.cpu.settle(); await f.cpu.settle()
    assert.equal(f.writes.length, 1, 'the live owner reaches the real rejecting command API')
    assert.deepEqual(f.controller.getState().session!.snapshot, snapshot)
    assert.deepEqual(useWorldsUiStore.getState().selectedEntityIds, selection, 'failed dispatch does not perform the success selection')
    assert.equal(owner.node().props.addingAssetId, null)
    assert.deepEqual(f.errors, ['Fixture write rejected'])
  } finally { await owner.cleanup(); await f.cleanup() }
})
