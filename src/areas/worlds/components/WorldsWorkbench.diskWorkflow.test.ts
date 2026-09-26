import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

import { WorldProjectRepository } from '../../../../electron/main/world-project-repository.ts'
import { WORLD_COMMAND_BATCH_SCHEMA, type WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import { cloneWorldProjectSnapshot } from '../core/worldDocuments.ts'
import type { WorldCommand, WorldCommandBatchV1 } from '../core/worldCommands.ts'
import type { WorldEditorController } from '../editor/worldEditorController.ts'
import { createWorldEditorController } from '../editor/worldEditorController.ts'
import { createWorldProjectService } from '../worldProjectService.ts'
import { buildAddCameraCommands, buildAddSceneCommands, createDeterministicWorldEditorIdentityGenerator } from '../editor/worldEditorCommandBuilders.ts'
import { buildAddEmptyEntityCommands } from '../editor/worldAuthoringModel.ts'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const Reconciler = require('react-reconciler')
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(currentDir, '../../../..')
const workbenchEntry = path.join(currentDir, 'WorldsWorkbench.tsx')
const controllerEntry = path.join(currentDir, '../editor/worldEditorController.ts')

type Host = { type: string; props: Record<string, any>; children: Host[]; getBoundingClientRect(): { width: number }; querySelector(selector: string): Host | null; focus(): void }
type WorkbenchDiskModule = { WorldsWorkbench: React.ComponentType; worldEditorController: WorldEditorController }
type WorkbenchHarnessGlobal = typeof globalThis & {
  __worldsWorkbenchHarness?: {
    runtimeSnapshots: WorldProjectSnapshotV1[]
    viewerMounts: number
    viewerUnmounts: number
    runtimeMounts: number
    runtimeUnmounts: number
    physicsInitialized: number
    physicsDisposed: number
    audioPrepared: number
    audioStopped: number
    hookCalls: number
    hookLayoutObservations: number
    hookControllerMatchesExport: boolean[]
    hookResultStateEpochs: number[]
  }
}

interface DiskHarness {
  module: WorkbenchDiskModule
  cleanup(): Promise<void>
}

interface FileHash { path: string; sha256: string }

function resetHarness() {
  const value = {
    runtimeSnapshots: [] as WorldProjectSnapshotV1[],
    viewerMounts: 0,
    viewerUnmounts: 0,
    runtimeMounts: 0,
    runtimeUnmounts: 0,
    physicsInitialized: 0,
    physicsDisposed: 0,
    audioPrepared: 0,
    audioStopped: 0,
    hookCalls: 0,
    hookLayoutObservations: 0,
    hookControllerMatchesExport: [] as boolean[],
    hookResultStateEpochs: [] as number[],
  }
  ;(globalThis as WorkbenchHarnessGlobal).__worldsWorkbenchHarness = value
  return value
}

async function loadWorkbenchModule(service: ReturnType<typeof createWorldProjectService>): Promise<DiskHarness> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'worlds-workbench-disk-mounted-'))
  const mockDir = path.join(tempDir, 'mocks')
  await mkdir(mockDir, { recursive: true })
  await symlink(path.join(repo, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir')
  await writeFile(path.join(tempDir, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(tempDir, 'entry.ts'), `export { WorldsWorkbench } from ${JSON.stringify(workbenchEntry)}\nexport { worldEditorController } from ${JSON.stringify(controllerEntry)}\n`)
  await writeFile(path.join(mockDir, 'css-empty.mjs'), '')
  await writeFile(path.join(mockDir, 'useWorldEditorControllerObserver.mjs'), `
import React from 'react'
import { worldEditorController } from ${JSON.stringify(controllerEntry)}
import { useWorldEditorController as realUseWorldEditorController, createWorldUiTransactionId, initializeWorldEditorController } from ${JSON.stringify(path.join(currentDir, '../editor/useWorldEditorController.ts'))}
export { createWorldUiTransactionId, initializeWorldEditorController }
export function useWorldEditorController(controller = worldEditorController) {
  const result = realUseWorldEditorController(controller)
  globalThis.__worldsWorkbenchHarness.hookCalls += 1
  globalThis.__worldsWorkbenchHarness.hookControllerMatchesExport.push(result.controller === worldEditorController)
  globalThis.__worldsWorkbenchHarness.hookResultStateEpochs.push(result.state.editorEpoch)
  React.useLayoutEffect(() => {
    globalThis.__worldsWorkbenchHarness.hookLayoutObservations += 1
  })
  return result
}
`)
  await writeFile(path.join(mockDir, 'WorldsViewer.mjs'), `
import React from 'react'
export default function WorldsViewer(props) {
  React.useEffect(() => { globalThis.__worldsWorkbenchHarness.viewerMounts += 1; return () => { globalThis.__worldsWorkbenchHarness.viewerUnmounts += 1 } }, [])
  const active = props.project.graphicsProfiles.find((profile) => profile.id === props.project.activeGraphicsProfileId)
  return React.createElement('worlds-viewer', {
    'aria-label': 'Worlds 3D canvas', tabIndex: 0,
    activeGraphicsProfileId: props.project.activeGraphicsProfileId,
    renderScale: active?.renderScale,
    onGraphicsDiagnostic: props.onGraphicsDiagnostic,
    onGraphicsFailure: props.onGraphicsFailure,
  })
}
`)
  await writeFile(path.join(mockDir, 'WorldRuntimeViewport.mjs'), `
import React from 'react'
export default function WorldRuntimeViewport(props) {
  React.useEffect(() => { globalThis.__worldsWorkbenchHarness.runtimeMounts += 1; return () => { globalThis.__worldsWorkbenchHarness.runtimeUnmounts += 1 } }, [])
  globalThis.__worldsWorkbenchHarness.runtimeSnapshots.push(structuredClone(props.snapshot))
  return React.createElement('world-runtime-viewport', {
    lifecycle: props.lifecycle,
    activeGraphicsProfileId: props.snapshot.project.activeGraphicsProfileId,
    profileCount: props.snapshot.project.graphicsProfiles.length,
  })
}
`)
  const simpleComponent = (name: string) => `import React from 'react'; export default function ${name}(props) { return React.createElement('${name.toLowerCase()}', props) }`
  for (const [file, name] of [
    ['WorldsAssetsDock.mjs', 'WorldsAssetsDock'], ['WorldsInspector.mjs', 'WorldsInspector'], ['WorldsLegacyExportDialog.mjs', 'WorldsLegacyExportDialog'],
    ['WorldsSceneDock.mjs', 'WorldsSceneDock'], ['WorldsTimelineDrawer.mjs', 'WorldsTimelineDrawer'], ['WorldsAiDrawer.mjs', 'WorldsAiDrawer'],
  ] as const) await writeFile(path.join(mockDir, file), simpleComponent(name))
  await writeFile(path.join(mockDir, 'assetService.mjs'), `export async function listWorldAssetLibraryRenderables() { return { success: true, assets: [] } } export async function openWorldAssetLibraryRenderable() { return { success: false, error: 'unused' } } export async function readWorldAssetLibraryAudio() { return { success: false, error: 'unused' } }`)
  await writeFile(path.join(mockDir, 'physics.mjs'), `export function createBrowserWorldPhysicsRuntime() { return { async initialize() { globalThis.__worldsWorkbenchHarness.physicsInitialized += 1 }, step() {}, pause() {}, resume() {}, dispose() { globalThis.__worldsWorkbenchHarness.physicsDisposed += 1 } } }`)
  await writeFile(path.join(mockDir, 'audio.mjs'), `export function createBrowserWorldAudioAuthority() { return { async prepareScene() { globalThis.__worldsWorkbenchHarness.audioPrepared += 1 }, async activate() {}, async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {}, stop() { globalThis.__worldsWorkbenchHarness.audioStopped += 1 } } }`)
  const aliases = new Map([
    [path.join(currentDir, '../editor/useWorldEditorController.ts'), path.join(mockDir, 'useWorldEditorControllerObserver.mjs')],
    [path.join(currentDir, 'WorldsViewer.tsx'), path.join(mockDir, 'WorldsViewer.mjs')],
    [path.join(currentDir, 'WorldRuntimeViewport.tsx'), path.join(mockDir, 'WorldRuntimeViewport.mjs')],
    [path.join(currentDir, 'WorldsAssetsDock.tsx'), path.join(mockDir, 'WorldsAssetsDock.mjs')],
    [path.join(currentDir, 'WorldsInspector.tsx'), path.join(mockDir, 'WorldsInspector.mjs')],
    [path.join(currentDir, 'WorldsLegacyExportDialog.tsx'), path.join(mockDir, 'WorldsLegacyExportDialog.mjs')],
    [path.join(currentDir, 'WorldsSceneDock.tsx'), path.join(mockDir, 'WorldsSceneDock.mjs')],
    [path.join(currentDir, 'WorldsTimelineDrawer.tsx'), path.join(mockDir, 'WorldsTimelineDrawer.mjs')],
    [path.join(currentDir, 'WorldsAiDrawer.tsx'), path.join(mockDir, 'WorldsAiDrawer.mjs')],
    [path.join(currentDir, '../worldAssetLibraryService.ts'), path.join(mockDir, 'assetService.mjs')],
    [path.join(currentDir, '../runtime/worldPhysicsRuntime.ts'), path.join(mockDir, 'physics.mjs')],
    [path.join(currentDir, '../runtime/worldAudioRuntime.ts'), path.join(mockDir, 'audio.mjs')],
  ])
  const result = await build({
    entryPoints: [path.join(tempDir, 'entry.ts')], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', tsconfig: path.join(repo, 'tsconfig.web.json'),
    plugins: [{ name: 'worlds-workbench-disk-mounted-aliases', setup(buildApi) {
      buildApi.onResolve({ filter: /\.css$/ }, () => ({ path: path.join(mockDir, 'css-empty.mjs') }))
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (!args.path.startsWith('.')) return undefined
        const resolved = path.resolve(args.resolveDir, args.path)
        return aliases.has(resolved) ? { path: aliases.get(resolved)! } : undefined
      })
    } }],
  })
  const outfile = path.join(tempDir, `WorldsWorkbench.bundle.${Date.now()}.mjs`)
  await writeFile(outfile, result.outputFiles[0].text)
  setupWindow(service)
  return { module: await import(pathToFileURL(outfile).href), cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}

function setupWindow(service: ReturnType<typeof createWorldProjectService>): void {
  const target = globalThis as any
  target.window = target
  target.window.electron = { workspace: { worlds: { projects: service } }, app: { info: async () => ({ apiUrl: 'http://127.0.0.1:9' }) } }
  target.window.addEventListener ??= () => undefined
  target.window.removeEventListener ??= () => undefined
  target.window.setTimeout ??= setTimeout
  target.window.clearTimeout ??= clearTimeout
  target.localStorage ??= { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  target.ResizeObserver ??= class { observe() {} disconnect() {} }
}

function mounted() {
  const append = (parent: Host, child: Host) => { parent.children.push(child) }
  const remove = (parent: Host, child: Host) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const renderer = Reconciler({
    now: performance.now.bind(performance), supportsMutation: true, isPrimaryRenderer: true,
    getRootHostContext: () => null, getChildHostContext: () => null, getPublicInstance: (node: Host) => node,
    prepareForCommit: () => null, resetAfterCommit() {}, shouldSetTextContent: () => false,
    createInstance: (type: string, props: Host['props']) => makeHost(type, props),
    createTextInstance: (text: string) => makeHost('#text', { text }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, clearContainer: (node: Host) => { node.children = [] },
    insertBefore: append, insertInContainerBefore: append, finalizeInitialChildren: () => false,
    prepareUpdate: () => true, commitUpdate: (node: Host, _payload: unknown, _type: unknown, _old: unknown, props: Host['props']) => { node.props = props },
    commitTextUpdate: (node: Host, _old: unknown, text: string) => { node.props.text = text },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1,
    detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  })
  const container: Host = makeHost('root', {})
  const root = renderer.createContainer(container, 0, null, false, null, '', () => {}, null)
  return {
    container,
    render: (value: React.ReactNode) => { renderer.flushSync(() => renderer.updateContainer(value, root, null, null)); renderer.flushPassiveEffects() },
    flush: () => { renderer.flushSync(() => {}); renderer.flushPassiveEffects() },
  }
}

function makeHost(type: string, props: Record<string, any>): Host {
  const node: Host = {
    type,
    props,
    children: [],
    getBoundingClientRect: () => ({ width: 1440 }),
    querySelector: (selector: string) => {
      if (selector === '[aria-label="Worlds 3D canvas"]') return find(node, (candidate) => candidate.props['aria-label'] === 'Worlds 3D canvas') ?? null
      return null
    },
    focus: () => undefined,
  }
  return node
}

async function settle(host: ReturnType<typeof mounted>, ticks = 8): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    host.flush()
  }
}

function find(node: Host, predicate: (node: Host) => boolean): Host | undefined {
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = find(child, predicate)
    if (found) return found
  }
  return undefined
}

function requireNode(host: ReturnType<typeof mounted>, predicate: (node: Host) => boolean, label: string): Host {
  const found = find(host.container, predicate)
  if (!found) throw new assert.AssertionError({ message: label, actual: found, expected: true, operator: '==' })
  return found
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested
    return Object.fromEntries(Object.keys(nested).sort().map((key) => [key, nested[key]]))
  })
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function recursiveHashes(root: string): Promise<FileHash[]> {
  const rows: FileHash[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) rows.push({ path: path.relative(root, absolute), sha256: sha256(await readFile(absolute)) })
    }
  }
  await visit(root)
  return rows
}

function sessionProof(controller: WorldEditorController) {
  const session = controller.getState().session
  if (!session) throw new assert.AssertionError({ message: 'session', actual: session, expected: true, operator: '==' })
  return {
    snapshot: structuredClone(session.snapshot),
    undoStack: structuredClone(session.undoStack),
    redoStack: structuredClone(session.redoStack),
    receipts: structuredClone(session.receipts),
  }
}

async function writeEvidence(evidenceRoot: string, name: string, value: unknown): Promise<void> {
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(path.join(evidenceRoot, name), `${JSON.stringify(value, null, 2)}\n`)
}

async function dispatchSetupCommands(controller: WorldEditorController, transactionId: string, commands: WorldCommand[]) {
  const state = controller.getState()
  if (!state.projectKey || !state.session || !state.activeSceneId) throw new assert.AssertionError({ message: 'dispatch setup requires ready session', actual: state, expected: true, operator: '==' })
  const projectKey = state.projectKey
  const session = state.session
  const activeSceneId = state.activeSceneId
  const result = await controller.dispatchCommands({ transactionId, origin: 'ui', commands }, {
    projectKey,
    projectId: session.snapshot.project.projectId,
    baseRevision: session.snapshot.project.revision,
    activeSceneId,
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.value.warnings, [])
}

async function createTwoSceneFixture(controller: WorldEditorController, projectKey: string): Promise<WorldProjectSnapshotV1> {
  const created = await controller.createProject({ name: 'Disk graphics workflow', initialSceneName: 'Forest Gate' })
  assert.equal(created.ok, true)
  let state = controller.getState()
  if (!state.session || !state.activeSceneId) throw new assert.AssertionError({ message: 'created fixture session', actual: state, expected: true, operator: '==' })
  const sceneOneId = state.activeSceneId
  await dispatchSetupCommands(controller, 'tx:setup-scene-one-entity', buildAddCameraCommands({ snapshot: state.session.snapshot, projectKey, activeSceneId: sceneOneId, identities: createDeterministicWorldEditorIdentityGenerator('disk-scene-one') }, { name: 'Forest camera', transform: { position: [0, 2, 6], rotation: [0, 0, 0], scale: [1, 1, 1] } }))

  state = controller.getState()
  if (!state.session) throw new assert.AssertionError({ message: 'fixture session before scene add', actual: state, expected: true, operator: '==' })
  const addSceneCommands = buildAddSceneCommands({ snapshot: state.session.snapshot, projectKey, identities: createDeterministicWorldEditorIdentityGenerator('disk-scene-two') }, { name: 'Harbor Gate' })
  await dispatchSetupCommands(controller, 'tx:setup-scene-two', addSceneCommands)
  assert.equal((await controller.setActiveScene(addSceneCommands[0].scene.sceneId)).ok, true)
  state = controller.getState()
  if (!state.session || !state.activeSceneId) throw new assert.AssertionError({ message: 'fixture session before scene two entity', actual: state, expected: true, operator: '==' })
  await dispatchSetupCommands(controller, 'tx:setup-scene-two-entity', buildAddEmptyEntityCommands({ snapshot: state.session.snapshot, projectKey, activeSceneId: state.activeSceneId, identities: createDeterministicWorldEditorIdentityGenerator('disk-scene-two-entity') }, { name: 'Harbor marker' }))

  state = controller.getState()
  if (!state.session || !state.activeSceneId) throw new assert.AssertionError({ message: 'fixture session before graphics', actual: state, expected: true, operator: '==' })
  const graphicsCommands: WorldCommand[] = [{
    type: 'replace-graphics-profiles',
    graphicsProfiles: [
      ...structuredClone(state.session.snapshot.project.graphicsProfiles),
      { id: 'graphics:disk-custom', name: 'Disk Custom', renderScale: 0.5, shadowQuality: 'off', antialiasing: 'off' },
    ],
    activeGraphicsProfileId: state.session.snapshot.project.activeGraphicsProfileId,
  }]
  await dispatchSetupCommands(controller, 'tx:setup-custom-graphics', graphicsCommands)
  const snapshot = cloneWorldProjectSnapshot(controller.getState().session!.snapshot)
  assert.deepEqual(snapshot.project.scenes.map((scene) => scene.name), ['Forest Gate', 'Harbor Gate'])
  assert.deepEqual(snapshot.scenes.map((scene) => scene.entities.map((entity) => entity.name)), [['Forest camera'], ['Harbor marker']])
  assert.equal(snapshot.project.activeGraphicsProfileId, 'graphics:balanced')
  assert.ok(snapshot.project.graphicsProfiles.some((profile) => profile.id === 'graphics:disk-custom'))
  return snapshot
}

test('mounted Workbench uses real disk repository for graphics Undo Redo Play Stop and reopen durability', async () => {
  const evidenceRoot = process.env.MODLY_WORLDS_DISK_WORKFLOW_EVIDENCE ?? await mkdtemp(path.join(tmpdir(), 'modly-worlds-graphics-disk-evidence-'))
  await mkdir(evidenceRoot, { recursive: true })
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'modly-worlds-graphics-disk-workspace-'))
  const projectKey = `world-${'d'.repeat(32)}`
  const sceneKeys = [`scene-${'1'.repeat(32)}`, `scene-${'2'.repeat(32)}`]
  let nextSceneKey = 0
  const repository = new WorldProjectRepository({
    getWorkspaceRoot: () => workspaceRoot,
    createProjectKey: () => projectKey,
    createSceneKey: () => sceneKeys[nextSceneKey++] ?? `scene-${String(nextSceneKey).padStart(32, '3')}`,
    now: () => new Date('2026-09-08T00:00:00.000Z'),
  })
  const service = createWorldProjectService(repository)
  const setupController = createWorldEditorController(service)
  const setupSnapshot = await createTwoSceneFixture(setupController, projectKey)
  await writeEvidence(evidenceRoot, '00-setup-snapshot.json', setupSnapshot)
  await writeEvidence(evidenceRoot, '00-setup-file-hashes.json', await recursiveHashes(workspaceRoot))

  const metrics = resetHarness()
  const loaded = await loadWorkbenchModule(service)
  try {
    const host = mounted()
    host.render(React.createElement(loaded.module.WorldsWorkbench))
    const controller = loaded.module.worldEditorController
    assert.ok(controller)
    assert.equal(metrics.hookCalls > 0, true, 'transparent observer must prove the real production useWorldEditorController ran')
    assert.equal(metrics.hookLayoutObservations > 0, true, 'hook observer must commit with the mounted Workbench tree')
    assert.equal(metrics.hookControllerMatchesExport.every(Boolean), true, 'Workbench hook must use the actual exported production worldEditorController instance')
    for (let attempt = 0; attempt < 200 && !controller.getState().session && !controller.getState().error; attempt += 1) await settle(host, 4)
    if (!controller.getState().session) await writeEvidence(evidenceRoot, 'debug-initial-controller-state.json', controller.getState())
    assert.deepEqual(controller.getState().session?.snapshot, setupSnapshot)
    assert.deepEqual(controller.getState().session?.snapshot.project.scenes.map((scene) => scene.name), ['Forest Gate', 'Harbor Gate'])
    assert.deepEqual(controller.getState().session?.snapshot.scenes.map((scene) => scene.entities.map((entity) => entity.name)), [['Forest camera'], ['Harbor marker']])

    const quality = () => requireNode(host, (node) => node.props.id === 'worlds-quality-picker', 'quality picker')
    const viewer = () => requireNode(host, (node) => node.type === 'worlds-viewer', 'editor viewer')
    const undo = () => requireNode(host, (node) => node.props['aria-label'] === 'Undo', 'undo')
    const redo = () => requireNode(host, (node) => node.props['aria-label'] === 'Redo', 'redo')
    const play = () => requireNode(host, (node) => node.props['aria-label'] === 'Play World', 'play')

    const historyBeforeQuality = controller.getState().session!.undoStack.length
    quality().props.onChange({ currentTarget: { value: 'profile:graphics:disk-custom' } })
    for (let attempt = 0; attempt < 200 && controller.getState().session?.snapshot.project.activeGraphicsProfileId !== 'graphics:disk-custom'; attempt += 1) await settle(host, 2)
    const afterQuality = sessionProof(controller)
    assert.equal(afterQuality.snapshot.project.activeGraphicsProfileId, 'graphics:disk-custom')
    assert.equal(afterQuality.snapshot.project.revision, setupSnapshot.project.revision + 1)
    assert.equal(afterQuality.undoStack.length, historyBeforeQuality + 1)
    assert.equal(afterQuality.redoStack.length, 0)
    assert.equal(afterQuality.receipts.at(-1)?.transactionId.startsWith('tx:ui-graphics-profile-'), true)
    assert.equal(viewer().props.activeGraphicsProfileId, 'graphics:disk-custom')
    assert.equal(viewer().props.renderScale, 0.5)

    const retryBatch: WorldCommandBatchV1 = {
      schema: WORLD_COMMAND_BATCH_SCHEMA,
      transactionId: afterQuality.receipts.at(-1)!.transactionId,
      projectId: setupSnapshot.project.projectId,
      baseRevision: setupSnapshot.project.revision,
      origin: 'ui',
      commands: [{ type: 'replace-graphics-profiles', graphicsProfiles: afterQuality.snapshot.project.graphicsProfiles, activeGraphicsProfileId: 'graphics:disk-custom' }],
    }
    const retry = await repository.applyCommands({ projectKey, batch: retryBatch })
    assert.equal(retry.ok && retry.value.idempotent, true)
    assert.deepEqual(retry.ok ? retry.value.warnings : [], ['transaction-idempotent'])

    undo().props.onClick()
    for (let attempt = 0; attempt < 200 && controller.getState().session?.snapshot.project.activeGraphicsProfileId !== 'graphics:balanced'; attempt += 1) await settle(host, 2)
    const afterUndo = sessionProof(controller)
    assert.equal(afterUndo.snapshot.project.activeGraphicsProfileId, 'graphics:balanced')
    assert.deepEqual(afterUndo.snapshot.project.graphicsProfiles, setupSnapshot.project.graphicsProfiles)
    assert.equal(afterUndo.redoStack.length, 1)

    redo().props.onClick()
    for (let attempt = 0; attempt < 200 && controller.getState().session?.snapshot.project.activeGraphicsProfileId !== 'graphics:disk-custom'; attempt += 1) await settle(host, 2)
    const afterRedo = sessionProof(controller)
    assert.equal(afterRedo.snapshot.project.activeGraphicsProfileId, 'graphics:disk-custom')
    assert.deepEqual(afterRedo.snapshot.project.graphicsProfiles, afterQuality.snapshot.project.graphicsProfiles)
    assert.equal(afterRedo.undoStack.length, afterQuality.undoStack.length)
    assert.deepEqual(afterRedo.receipts, afterQuality.receipts, 'volatile editor receipts remain scoped to direct command receipts; undo/redo persistence receipts are not restored into session receipts by the current controller')

    const beforePlayProof = sessionProof(controller)
    const beforePlayHashes = await recursiveHashes(workspaceRoot)
    await writeEvidence(evidenceRoot, '01-before-play-session.json', beforePlayProof)
    await writeEvidence(evidenceRoot, '01-before-play-file-hashes.json', beforePlayHashes)

    for (let attempt = 0; attempt < 100 && play().props.disabled; attempt += 1) await settle(host, 2)
    play().props.onClick()
    for (let attempt = 0; attempt < 200 && !find(host.container, (node) => node.type === 'world-runtime-viewport'); attempt += 1) await settle(host, 2)
    if (!find(host.container, (node) => node.type === 'world-runtime-viewport')) await writeEvidence(evidenceRoot, 'debug-play-state.json', { controller: controller.getState(), playDisabled: play().props.disabled, metrics })
    const runtime = requireNode(host, (node) => node.type === 'world-runtime-viewport', 'runtime viewport')
    assert.equal(runtime.props.lifecycle, 'playing')
    assert.equal(runtime.props.activeGraphicsProfileId, 'graphics:disk-custom')
    assert.equal(metrics.runtimeSnapshots.at(-1)?.project.activeGraphicsProfileId, 'graphics:disk-custom')
    assert.equal(metrics.runtimeSnapshots.at(-1)?.project.graphicsProfiles.some((profile) => profile.id === 'graphics:disk-custom'), true)
    assert.equal(metrics.physicsInitialized, 1)
    assert.equal(metrics.audioPrepared, 1)

    requireNode(host, (node) => node.props['aria-label'] === 'Stop World', 'stop').props.onClick()
    await settle(host, 24)
    assert.equal(metrics.physicsDisposed, 1)
    assert.equal(metrics.audioStopped, 1)
    assert.deepEqual(sessionProof(controller), beforePlayProof)
    assert.deepEqual(await recursiveHashes(workspaceRoot), beforePlayHashes)
    await writeEvidence(evidenceRoot, '02-after-stop-session.json', sessionProof(controller))
    await writeEvidence(evidenceRoot, '02-after-stop-file-hashes.json', await recursiveHashes(workspaceRoot))

    host.render(null)
    await settle(host, 8)
    await controller.closeProject()
    await loaded.cleanup()

    const reopenedMetrics = resetHarness()
    const reopened = await loadWorkbenchModule(createWorldProjectService(new WorldProjectRepository({ getWorkspaceRoot: () => workspaceRoot })))
    try {
      const reopenedHost = mounted()
      reopenedHost.render(React.createElement(reopened.module.WorldsWorkbench))
      const reopenedController = reopened.module.worldEditorController
      assert.ok(reopenedController)
      assert.equal(reopenedMetrics.hookCalls > 0, true, 'reopened mount must execute the real production hook')
      assert.equal(reopenedMetrics.hookLayoutObservations > 0, true, 'reopened hook observer must commit with the mounted Workbench tree')
      assert.equal(reopenedMetrics.hookControllerMatchesExport.every(Boolean), true, 'reopened Workbench hook must use the actual exported production controller instance')
      for (let attempt = 0; attempt < 200 && !reopenedController.getState().session && !reopenedController.getState().error; attempt += 1) await settle(reopenedHost, 2)
      if (!reopenedController.getState().session) await writeEvidence(evidenceRoot, 'debug-reopened-controller-state.json', reopenedController.getState())
      const reopenedSession = sessionProof(reopenedController)
      assert.deepEqual(reopenedSession.snapshot, beforePlayProof.snapshot)
      assert.deepEqual(reopenedSession.snapshot.project.scenes.map((scene) => scene.name), ['Forest Gate', 'Harbor Gate'])
      assert.deepEqual(reopenedSession.snapshot.scenes.map((scene) => scene.entities.map((entity) => entity.name)), [['Forest camera'], ['Harbor marker']])
      assert.equal(reopenedSession.snapshot.project.activeGraphicsProfileId, 'graphics:disk-custom')
      assert.equal(reopenedSession.snapshot.project.revision, beforePlayProof.snapshot.project.revision)
      assert.equal(reopenedSession.undoStack.length, 0, 'fresh disk reopen intentionally does not seed volatile editor history')
      assert.equal(reopenedSession.receipts.length, 0, 'fresh disk reopen intentionally does not seed volatile editor receipts')
      const reopenedViewer = requireNode(reopenedHost, (node) => node.type === 'worlds-viewer', 'reopened viewer')
      assert.equal(reopenedViewer.props.activeGraphicsProfileId, 'graphics:disk-custom')
      assert.equal(reopenedViewer.props.renderScale, 0.5)
      assert.ok(reopenedMetrics.viewerMounts >= 1)
      await writeEvidence(evidenceRoot, '03-reopened-session.json', reopenedSession)
      await writeEvidence(evidenceRoot, '03-reopened-file-hashes.json', await recursiveHashes(workspaceRoot))
      await reopenedController.closeProject()
    } finally {
      await reopened.cleanup()
    }

    await writeEvidence(evidenceRoot, '99-summary.json', {
      workspaceRoot,
      projectKey,
      setupRevision: setupSnapshot.project.revision,
      beforePlayRevision: beforePlayProof.snapshot.project.revision,
      beforePlaySessionSha256: sha256(canonical(beforePlayProof)),
      beforePlayFileManifestSha256: sha256(canonical(beforePlayHashes)),
      actualUiBoundary: 'Mounted production WorldsWorkbench and WorldsProjectBar; production useWorldEditorController executed through a transparent test observer returning the real hook result unchanged; graphics selection, Undo, Redo, Play, Stop, unmount, and reopen happened through rendered host props.',
      setupBoundary: 'Initial two-scene fixture used real WorldProjectRepository, createWorldProjectService, and createWorldEditorController canonical command application with default file and directory sync under isolated /tmp workspace.',
      stubs: ['Transparent production hook observer', 'Canvas/viewer implementation', 'Runtime viewport DOM', 'asset library', 'physics port', 'audio port', 'Electron IPC transport object'],
    })
  } catch (error) {
    await writeEvidence(evidenceRoot, 'failure.json', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null })
    throw error
  } finally {
    await loaded.cleanup().catch(() => undefined)
  }
})
