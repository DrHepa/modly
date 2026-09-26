import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const entry = path.join(import.meta.dirname, 'WorldsProjectBar.tsx')

async function loadProjectBar() {
  const tempDir = await mkdtemp(path.join('/tmp', 'worlds-project-bar-test-'))
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: path.join(import.meta.dirname, '../../../..', 'tsconfig.web.json') })
  const outfile = path.join(tempDir, 'WorldsProjectBar.bundle.mjs')
  await writeFile(outfile, result.outputFiles[0].text)
  return { module: await import(pathToFileURL(outfile).href), cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}

test('ProjectBar exposes a compact native quality select with stored profiles and preset actions', async () => {
  const { module, cleanup } = await loadProjectBar()
  try {
    const tree = module.default({
      projects: [], projectKey: 'project:one', projectPickerKey: '', scenes: [], activeSceneId: 'scene:one', saveStatus: 'saved',
      canUndo: false, canRedo: false, selectionCount: 0, busy: false, playState: 'edit', canPlay: true,
      graphicsProfiles: [{ id: 'graphics:balanced', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'fxaa' }],
      activeGraphicsProfileId: 'graphics:balanced', graphicsProfilePending: false, graphicsUnavailable: false,
      onGraphicsProfileChoice() {}, onProjectPickerKey() {}, onOpenProject() {}, onNewProject() {}, onScene() {}, onAddScene() {}, onUndo() {}, onRedo() {},
      onDuplicate() {}, onDelete() {}, onLegacyExport() {}, onRecoverConflict() {}, onPlayIntent() {}, onPlay() {}, onPause() {}, onResume() {}, onStop() {}, onDock() {},
    })
    const label = findElement(tree, (node) => node.type === 'label' && node.props?.htmlFor === 'worlds-quality-picker')
    const select = findElement(tree, (node) => node.props?.id === 'worlds-quality-picker')
    assert.equal(label.props.children, 'Quality')
    assert.equal(select.props['aria-label'], 'Rendering quality')
    const options = collectElements(select, (node) => node.type === 'option')
    assert.deepEqual(options.map((option) => [option.props.value, option.props.children]), [
      ['profile:graphics:balanced', 'Balanced'],
      ['preset:integrated', 'Integrated preset'],
      ['preset:dedicated', 'Dedicated preset'],
    ])
  } finally { await cleanup() }
})

test('Workbench source gates Play synchronously while graphics profile transactions are pending and dispatches canonical commands', async () => {
  const source = await readFile(path.join(import.meta.dirname, 'WorldsWorkbench.tsx'), 'utf8')
  assert.match(source, /graphicsProfilePendingRef\.current = true/)
  assert.match(source, /if \(graphicsProfilePendingRef\.current\) return announceError\('Wait for the quality change to finish before starting Play\.'\)/)
  assert.match(source, /buildWorldGraphicsProfileSelectionCommands\(current\.session\.snapshot, choice\)/)
  assert.match(source, /editor\.dispatchUiCommands\(commands, 'graphics-profile', authority\)/)
  assert.match(source, /canPlay=\{!graphicsState\.failure && !editorBusy && !graphicsProfilePending/)
  assert.match(source, /graphicsUnavailable=\{!!graphicsState\.failure\}/)
  assert.match(source, /Resolve the graphics failure before changing quality/)
  assert.match(source, /onGraphicsDiagnostic=\{handleActiveGraphicsDiagnostic\}/)
})

test('ProjectBar quality select handler dispatches preset choices and disables on graphics failure', async () => {
  const { module, cleanup } = await loadProjectBar()
  try {
    const calls: unknown[] = []
    const baseProps = {
      projects: [], projectKey: 'project:one', projectPickerKey: '', scenes: [], activeSceneId: 'scene:one', saveStatus: 'saved',
      canUndo: false, canRedo: false, selectionCount: 0, busy: false, playState: 'edit', canPlay: true,
      graphicsProfiles: [{ id: 'graphics:balanced', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'fxaa' }],
      activeGraphicsProfileId: 'graphics:balanced', graphicsProfilePending: false, graphicsUnavailable: false,
      onGraphicsProfileChoice(choice: unknown) { calls.push(choice) }, onProjectPickerKey() {}, onOpenProject() {}, onNewProject() {}, onScene() {}, onAddScene() {}, onUndo() {}, onRedo() {},
      onDuplicate() {}, onDelete() {}, onLegacyExport() {}, onRecoverConflict() {}, onPlayIntent() {}, onPlay() {}, onPause() {}, onResume() {}, onStop() {}, onDock() {},
    }
    const enabledTree = module.default(baseProps)
    const select = findElement(enabledTree, (node) => node.props?.id === 'worlds-quality-picker')
    assert.equal(select.props.disabled, false)
    select.props.onChange({ currentTarget: { value: 'preset:dedicated' } })
    select.props.onChange({ currentTarget: { value: 'profile:graphics:balanced' } })
    assert.deepEqual(calls, [{ kind: 'preset', preset: 'dedicated' }, { kind: 'profile', profileId: 'graphics:balanced' }])
    const disabledTree = module.default({ ...baseProps, graphicsUnavailable: true })
    assert.equal(findElement(disabledTree, (node) => node.props?.id === 'worlds-quality-picker').props.disabled, true)
  } finally { await cleanup() }
})

function findElement(node: any, predicate: (node: any) => boolean): any {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  for (const child of children) {
    const found = findElement(child, predicate)
    if (found) return found
  }
  return null
}

function collectElements(node: any, predicate: (node: any) => boolean, results: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, results)
    return results
  }
  if (!node || typeof node !== 'object') return results
  if (predicate(node)) results.push(node)
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  for (const child of children) collectElements(child, predicate, results)
  return results
}
