import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const worldsRoot = path.join(projectRoot, 'src/areas/worlds')
const pageEntry = path.join(worldsRoot, 'WorldsPage.tsx')
const workbenchEntry = path.join(worldsRoot, 'components/WorldsWorkbench.tsx')
const overlayFocusEntry = path.join(worldsRoot, 'editor/worldsOverlayFocus.ts')
const viewerEntry = path.join(worldsRoot, 'components/WorldsViewer.tsx')
const runtimeViewportEntry = path.join(worldsRoot, 'components/WorldRuntimeViewport.tsx')
const projectBarEntry = path.join(worldsRoot, 'components/WorldsProjectBar.tsx')
const sceneDockEntry = path.join(worldsRoot, 'components/WorldsSceneDock.tsx')
const legacyExportEntry = path.join(worldsRoot, 'components/WorldsLegacyExportDialog.tsx')
const timelineEntry = path.join(worldsRoot, 'components/WorldsTimelineDrawer.tsx')
const workbenchCss = path.join(worldsRoot, 'WorldsWorkbench.css')

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
