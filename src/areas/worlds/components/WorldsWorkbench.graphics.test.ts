import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { applyWorldCommandBatch, type WorldCommandBatchV1 } from '../core/worldCommands.ts'
import { cloneWorldProjectSnapshot } from '../core/worldDocuments.ts'
import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import { createRuntimeWorldSnapshot } from '../runtime/_testFixtures.ts'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const Reconciler = require('react-reconciler')
const repo = path.join(import.meta.dirname, '../../../..')
const entry = path.join(import.meta.dirname, 'WorldsWorkbench.tsx')

type Host = { type: string; props: Record<string, any>; children: Host[]; getBoundingClientRect(): { width: number }; querySelector(selector: string): Host | null; focus(): void }
type WorkbenchHarnessGlobal = typeof globalThis & {
  __worldsWorkbenchHarness?: {
    viewerMounts: number
    viewerUnmounts: number
    viewerLocalStateSeed: number
    runtimeMounts: number
    runtimeUnmounts: number
    applyCalls: WorldCommandBatchV1[]
    playStarts: number
    initialViewerDiagnostic: string | null
    staleDiagnosticAfterInitial: (() => void) | null
    suspendNextViewer: boolean
    speculativeDiagnostic: ((message: string) => void) | null
    runtimeSnapshots: WorldProjectSnapshotV1[]
    physicsInitialized: number
    physicsScenes: unknown[]
    physicsDisposed: number
    audioPrepared: number
    audioStopped: number
  }
}

function harness() {
  const value = {
    viewerMounts: 0,
    viewerUnmounts: 0,
    viewerLocalStateSeed: 0,
    runtimeMounts: 0,
    runtimeUnmounts: 0,
    applyCalls: [] as WorldCommandBatchV1[],
    playStarts: 0,
    initialViewerDiagnostic: null as string | null,
    staleDiagnosticAfterInitial: null as (() => void) | null,
    suspendNextViewer: false,
    speculativeDiagnostic: null as ((message: string) => void) | null,
    runtimeSnapshots: [] as WorldProjectSnapshotV1[],
    physicsInitialized: 0,
    physicsScenes: [] as unknown[],
    physicsDisposed: 0,
    audioPrepared: 0,
    audioStopped: 0,
  }
  ;(globalThis as WorkbenchHarnessGlobal).__worldsWorkbenchHarness = value
  return value
}

type ApplyGate = { promise: Promise<void>; resolve(): void; reject(error?: unknown): void }

function createDeferred(): ApplyGate {
  let resolve!: () => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function loadWorkbenchModule(snapshotSeed = createHarnessSnapshot()): Promise<{ module: { WorldsWorkbench: React.ComponentType }; api: ReturnType<typeof createProjectApi>; cleanup(): Promise<void> }> {
  const tempDir = await mkdtemp(path.join('/tmp', 'worlds-workbench-graphics-mounted-'))
  const mockDir = path.join(tempDir, 'mocks')
  await import('node:fs/promises').then(async (fs) => { await fs.mkdir(mockDir, { recursive: true }); await fs.symlink(path.join(repo, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir') })
  await writeFile(path.join(tempDir, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(mockDir, 'css-empty.mjs'), '')
  await writeFile(path.join(mockDir, 'WorldsViewer.mjs'), `
	import React from 'react'
	export default function WorldsViewer(props) {
	  if (globalThis.__worldsWorkbenchHarness.suspendNextViewer) {
	    globalThis.__worldsWorkbenchHarness.suspendNextViewer = false
	    globalThis.__worldsWorkbenchHarness.speculativeDiagnostic = props.onGraphicsDiagnostic
	    throw new Promise(() => {})
	  }
	  const [localStateToken] = React.useState(() => {
	    globalThis.__worldsWorkbenchHarness.viewerLocalStateSeed += 1
	    return globalThis.__worldsWorkbenchHarness.viewerLocalStateSeed
	  })
	  React.useLayoutEffect(() => {
	    const message = globalThis.__worldsWorkbenchHarness.initialViewerDiagnostic
	    if (message) props.onGraphicsDiagnostic(message)
	    const stale = globalThis.__worldsWorkbenchHarness.staleDiagnosticAfterInitial
	    if (stale) {
	      globalThis.__worldsWorkbenchHarness.staleDiagnosticAfterInitial = null
	      stale()
	    }
	  }, [])
	  React.useEffect(() => { globalThis.__worldsWorkbenchHarness.viewerMounts += 1; return () => { globalThis.__worldsWorkbenchHarness.viewerUnmounts += 1 } }, [])
	  return React.createElement('worlds-viewer', {
	    'aria-label': 'Worlds 3D canvas', tabIndex: 0,
	    activeGraphicsProfileId: props.project.activeGraphicsProfileId,
	    renderScale: props.project.graphicsProfiles.find((profile) => profile.id === props.project.activeGraphicsProfileId)?.renderScale,
	    localStateToken,
	    onGraphicsDiagnostic: props.onGraphicsDiagnostic,
	    onGraphicsFailure: props.onGraphicsFailure,
	    onTransformItem: props.onTransformItem,
	  })
	}
`)
  await writeFile(path.join(mockDir, 'WorldRuntimeViewport.mjs'), `
import React from 'react'
export default function WorldRuntimeViewport(props) {
  React.useEffect(() => { globalThis.__worldsWorkbenchHarness.runtimeMounts += 1; globalThis.__worldsWorkbenchHarness.playStarts += 1; return () => { globalThis.__worldsWorkbenchHarness.runtimeUnmounts += 1 } }, [])
  globalThis.__worldsWorkbenchHarness.runtimeSnapshots.push(structuredClone(props.snapshot))
  return React.createElement('world-runtime-viewport', {
    onGraphicsDiagnostic: props.onGraphicsDiagnostic,
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
  await writeFile(path.join(mockDir, 'physics.mjs'), `export function createBrowserWorldPhysicsRuntime() { return { async initialize(scene) { globalThis.__worldsWorkbenchHarness.physicsInitialized += 1; globalThis.__worldsWorkbenchHarness.physicsScenes.push(scene) }, step() {}, pause() {}, resume() {}, dispose() { globalThis.__worldsWorkbenchHarness.physicsDisposed += 1 } } }`)
  await writeFile(path.join(mockDir, 'audio.mjs'), `export function createBrowserWorldAudioAuthority() { return { async prepareScene() { globalThis.__worldsWorkbenchHarness.audioPrepared += 1 }, async activate() {}, async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {}, stop() { globalThis.__worldsWorkbenchHarness.audioStopped += 1 } } }`)
  const aliases = new Map([
    [path.join(import.meta.dirname, 'WorldsViewer.tsx'), path.join(mockDir, 'WorldsViewer.mjs')],
    [path.join(import.meta.dirname, 'WorldRuntimeViewport.tsx'), path.join(mockDir, 'WorldRuntimeViewport.mjs')],
    [path.join(import.meta.dirname, 'WorldsAssetsDock.tsx'), path.join(mockDir, 'WorldsAssetsDock.mjs')],
    [path.join(import.meta.dirname, 'WorldsInspector.tsx'), path.join(mockDir, 'WorldsInspector.mjs')],
    [path.join(import.meta.dirname, 'WorldsLegacyExportDialog.tsx'), path.join(mockDir, 'WorldsLegacyExportDialog.mjs')],
    [path.join(import.meta.dirname, 'WorldsSceneDock.tsx'), path.join(mockDir, 'WorldsSceneDock.mjs')],
    [path.join(import.meta.dirname, 'WorldsTimelineDrawer.tsx'), path.join(mockDir, 'WorldsTimelineDrawer.mjs')],
    [path.join(import.meta.dirname, 'WorldsAiDrawer.tsx'), path.join(mockDir, 'WorldsAiDrawer.mjs')],
    [path.join(import.meta.dirname, '../worldAssetLibraryService.ts'), path.join(mockDir, 'assetService.mjs')],
    [path.join(import.meta.dirname, '../runtime/worldPhysicsRuntime.ts'), path.join(mockDir, 'physics.mjs')],
    [path.join(import.meta.dirname, '../runtime/worldAudioRuntime.ts'), path.join(mockDir, 'audio.mjs')],
  ])
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', tsconfig: path.join(repo, 'tsconfig.web.json'),
    plugins: [{ name: 'worlds-workbench-mounted-aliases', setup(buildApi) {
      buildApi.onResolve({ filter: /\.css$/ }, () => ({ path: path.join(mockDir, 'css-empty.mjs') }))
      buildApi.onLoad({ filter: /WorldsWorkbench\.tsx$/ }, async (args) => {
        if (args.path !== entry || !process.env.WORLDS_WORKBENCH_SOURCE_OVERRIDE) return undefined
        return { contents: await import('node:fs/promises').then((fs) => fs.readFile(process.env.WORLDS_WORKBENCH_SOURCE_OVERRIDE!, 'utf8')), loader: 'tsx', resolveDir: import.meta.dirname }
      })
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (!args.path.startsWith('.')) return undefined
        const resolved = path.resolve(args.resolveDir, args.path)
        return aliases.has(resolved) ? { path: aliases.get(resolved)! } : undefined
      })
    } }],
  })
  const outfile = path.join(tempDir, 'WorldsWorkbench.bundle.mjs')
  await writeFile(outfile, result.outputFiles[0].text)
  const api = createProjectApi(snapshotSeed)
  setupWindow(api)
  return { module: await import(pathToFileURL(outfile).href), api, cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}

function mounted(options: { concurrent?: boolean; strict?: boolean } = {}) {
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
  const root = renderer.createContainer(container, options.concurrent ? 1 : 0, null, options.strict ?? false, null, '', () => {}, null)
  return {
    container,
    render: (value: React.ReactNode) => { renderer.flushSync(() => renderer.updateContainer(value, root, null, null)); renderer.flushPassiveEffects() },
    schedule: (value: React.ReactNode) => { renderer.updateContainer(value, root, null, null) },
    transition: (value: React.ReactNode) => React.startTransition(() => renderer.updateContainer(value, root, null, null)),
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

function createHarnessSnapshot(): WorldProjectSnapshotV1 {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.name = 'Graphics authority world'
  snapshot.project.projectId = 'project:graphics-authority'
  snapshot.project.revision = 1
  snapshot.project.graphicsProfiles = [
    { id: 'graphics:balanced', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'fxaa' },
    { id: 'graphics:custom', name: 'Custom', renderScale: 0.5, shadowQuality: 'off', antialiasing: 'off' },
  ]
  snapshot.project.activeGraphicsProfileId = 'graphics:balanced'
  snapshot.project.scenes = snapshot.project.scenes.map((scene, index) => ({ ...scene, documentPath: `Worlds/world-11111111111111111111111111111111/scenes/scene-${(index + 1).toString(16).padStart(32, '0')}.world-scene.json` }))
  for (const scene of snapshot.scenes) scene.projectId = snapshot.project.projectId
  return snapshot
}

function createProjectApi(seed: WorldProjectSnapshotV1) {
  let snapshot = cloneWorldProjectSnapshot(seed)
  let applyGate: ApplyGate | null = null
  let failNextApply: { code: 'revision_conflict' | 'write_failed'; message: string; retryable: boolean } | null = null
  const api = {
    get snapshot() { return snapshot },
    replaceSnapshot(next: WorldProjectSnapshotV1) { snapshot = cloneWorldProjectSnapshot(next) },
    holdNextApply(): ApplyGate { applyGate = createDeferred(); return applyGate },
    rejectNextApply(error: { code: 'revision_conflict' | 'write_failed'; message: string; retryable?: boolean }) {
      failNextApply = { code: error.code, message: error.message, retryable: error.retryable ?? false }
    },
    async list() { return { ok: true, value: { projects: [{ projectKey: 'world-11111111111111111111111111111111', status: 'ready', projectId: snapshot.project.projectId, name: snapshot.project.name, revision: snapshot.project.revision }], issues: [] } } },
    async open(request: { projectKey: string }) { return { ok: true, value: { status: 'ready', projectKey: request.projectKey, snapshot: cloneWorldProjectSnapshot(snapshot), durabilityWarnings: [] } } },
    async create() { throw new Error('unused') },
    async previewCommands() { throw new Error('unused') },
    async delete() { throw new Error('unused') },
    async applyCommands(request: { projectKey: string; batch: WorldCommandBatchV1 }) {
      ;(globalThis as WorkbenchHarnessGlobal).__worldsWorkbenchHarness?.applyCalls.push(structuredClone(request.batch))
      const gate = applyGate
      applyGate = null
      if (gate) await gate.promise
      if (failNextApply) {
        const error = failNextApply
        failNextApply = null
        return { ok: false, error }
      }
      const applied = applyWorldCommandBatch(snapshot, request.batch)
      if (!applied.success) return { ok: false, error: { code: 'write_failed', message: applied.issues[0]?.message ?? 'Apply failed.', retryable: false } }
      snapshot = cloneWorldProjectSnapshot(applied.snapshot)
      return { ok: true, value: { projectKey: request.projectKey, snapshot: cloneWorldProjectSnapshot(snapshot), newRevision: snapshot.project.revision, idempotent: false, changes: applied.changes, warnings: applied.warnings, inverse: applied.inverse, receipt: { ...applied.receipt, payloadSha256: '0'.repeat(64), resultSha256: '1'.repeat(64) } } }
    },
  }
  return api
}

function setupWindow(api: ReturnType<typeof createProjectApi>): void {
  const target = globalThis as any
  target.window = target
  target.window.electron = { workspace: { worlds: { projects: api } }, app: { info: async () => ({ apiUrl: 'http://127.0.0.1:9' }) } }
  target.window.addEventListener ??= () => undefined
  target.window.removeEventListener ??= () => undefined
  target.window.setTimeout ??= setTimeout
  target.window.clearTimeout ??= clearTimeout
  target.localStorage ??= { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  target.ResizeObserver ??= class { observe() {} disconnect() {} }
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

function textOf(node: Host | undefined): string {
  if (!node) return ''
  if (node.type === '#text') return String(node.props.text)
  return node.children.map(textOf).join('')
}

function statusNode(container: Host): Host | undefined {
  return find(container, (node) => node.props.className?.includes?.('worlds-workbench__status'))
}

test('mounted Workbench quality selection is canonical, pending-locked, and updates the editor viewport without remounting', async () => {
  const metrics = harness()
  const { module, api, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const viewer = () => find(host.container, (node) => node.type === 'worlds-viewer')!
    const quality = () => find(host.container, (node) => node.props.id === 'worlds-quality-picker')!
    const play = () => find(host.container, (node) => node.props['aria-label'] === 'Play World')!
    assert.equal(viewer().props.activeGraphicsProfileId, 'graphics:balanced')
    const initialViewerMounts = metrics.viewerMounts
    const initialViewerUnmounts = metrics.viewerUnmounts

    const gate = api.holdNextApply()
    quality().props.onChange({ currentTarget: { value: 'profile:graphics:custom' } })
    play().props.onClick()
    await settle(host, 2)
    assert.equal(metrics.applyCalls.length, 1)
    assert.equal(metrics.playStarts, 0)
    assert.equal(api.snapshot.project.activeGraphicsProfileId, 'graphics:balanced')
    assert.equal(viewer().props.activeGraphicsProfileId, 'graphics:balanced')
    assert.equal(quality().props.disabled, true)

    gate.resolve()
    await settle(host)
    assert.equal(api.snapshot.project.activeGraphicsProfileId, 'graphics:custom')
    assert.equal(viewer().props.activeGraphicsProfileId, 'graphics:custom')
    assert.equal(viewer().props.renderScale, 0.5)
    assert.equal(metrics.viewerMounts, initialViewerMounts, 'accepted quality updates props without remounting the editor viewport')
    assert.equal(metrics.viewerUnmounts, initialViewerUnmounts)
    assert.deepEqual(api.snapshot.project.graphicsProfiles.map((profile) => profile.id), ['graphics:balanced', 'graphics:custom'])
    assert.equal(api.snapshot.project.revision, 2)
    assert.equal(metrics.applyCalls[0].commands[0]?.type, 'replace-graphics-profiles')
  } finally { await cleanup() }
})

test('mounted Workbench scopes graphics diagnostics to the current viewport owner and exposes a live status', async () => {
  const metrics = harness()
  metrics.initialViewerDiagnostic = 'Initial child layout diagnostic'
  const { module, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const firstViewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    const staleDiagnostic = firstViewer.props.onGraphicsDiagnostic
    assert.equal(textOf(statusNode(host.container)), 'Graphics: Initial child layout diagnostic')
    firstViewer.props.onGraphicsDiagnostic('FXAA active')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: FXAA active')
    assert.equal(statusNode(host.container)?.props.role, 'status')
    assert.equal(statusNode(host.container)?.props['aria-live'], 'polite')

    find(host.container, (node) => node.props.id === 'worlds-scene-picker')!.props.onChange({ currentTarget: { value: 'scene:two' } })
    await settle(host)
    const currentViewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    staleDiagnostic('stale diagnostic')
    await settle(host, 1)
    assert.notEqual(textOf(statusNode(host.container)), 'Graphics: stale diagnostic')
    currentViewer.props.onGraphicsDiagnostic('')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Scene changed')
  } finally { await cleanup() }
})

test('mounted Workbench resets editor viewport local state on project or scene authority changes but not quality changes', async () => {
  const metrics = harness()
  const seed = createHarnessSnapshot()
  const { module, api, cleanup } = await loadWorkbenchModule(seed)
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const viewer = () => find(host.container, (node) => node.type === 'worlds-viewer')!
    const initialToken = viewer().props.localStateToken
    const initialViewerMounts = metrics.viewerMounts
    const initialViewerUnmounts = metrics.viewerUnmounts

    find(host.container, (node) => node.props.id === 'worlds-scene-picker')!.props.onChange({ currentTarget: { value: 'scene:two' } })
    await settle(host, 16)
    const sceneToken = viewer().props.localStateToken
    assert.equal(textOf(statusNode(host.container)), 'Scene changed')
    assert.notEqual(sceneToken, initialToken, 'scene changes reset viewer-local state independently of quality or scene-fit keys')
    assert.equal(metrics.viewerMounts, initialViewerMounts + 1)
    assert.equal(metrics.viewerUnmounts, initialViewerUnmounts + 1)

    const nextProject = createHarnessSnapshot()
    nextProject.project.projectId = 'project:graphics-authority-opened'
    nextProject.scenes = nextProject.scenes.map((scene) => ({ ...scene, projectId: nextProject.project.projectId }))
    api.replaceSnapshot(nextProject)
    find(host.container, (node) => node.props['aria-label'] === 'Open selected World project')!.props.onClick()
    await settle(host)
    assert.notEqual(viewer().props.localStateToken, sceneToken, 'project changes reset viewer-local state')
    assert.equal(metrics.viewerMounts, initialViewerMounts + 2)
    assert.equal(metrics.viewerUnmounts, initialViewerUnmounts + 2)
  } finally { await cleanup() }
})

test('mounted Workbench graphics failure clears only graphics-owned status and preserves unrelated status or errors', async () => {
  harness()
  const { module, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const viewer = () => find(host.container, (node) => node.type === 'worlds-viewer')!

    find(host.container, (node) => node.props.id === 'worlds-scene-picker')!.props.onChange({ currentTarget: { value: 'scene:two' } })
    await settle(host)
    assert.equal(textOf(statusNode(host.container)), 'Scene changed')
    viewer().props.onGraphicsFailure()
    await settle(host)
    assert.equal(textOf(statusNode(host.container)), 'Scene changed')

    viewer().props.onGraphicsDiagnostic('Renderer degraded')
    await settle(host)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: Renderer degraded')
    viewer().props.onGraphicsFailure()
    await settle(host)
    assert.notEqual(textOf(statusNode(host.container)), 'Graphics: Renderer degraded')

    find(host.container, (node) => node.props.id === 'worlds-scene-picker')!.props.onChange({ currentTarget: { value: 'scene:missing' } })
    await settle(host)
    assert.equal(textOf(statusNode(host.container)), 'Scene scene:missing does not exist.')
    assert.equal(statusNode(host.container)?.props.role, 'alert')
    viewer().props.onGraphicsFailure()
    await settle(host)
    assert.equal(textOf(statusNode(host.container)), 'Scene scene:missing does not exist.')
  } finally { await cleanup() }
})

test('ProjectBar disables Play directly while quality is pending or graphics are unavailable', async () => {
  const { module, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const gate = apiHoldNextApplyFromWindow()
    find(host.container, (node) => node.props.id === 'worlds-quality-picker')!.props.onChange({ currentTarget: { value: 'profile:graphics:custom' } })
    await settle(host, 2)
    assert.equal(find(host.container, (node) => node.props['aria-label'] === 'Play World')!.props.disabled, true)
    gate.resolve()
  } finally { await cleanup() }
})

test('adversarial Workbench preserves an active graphics diagnostic across a prop-only quality change when the reused viewport does not re-emit', async () => {
  const metrics = harness()
  const { module, api, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const viewer = () => find(host.container, (node) => node.type === 'worlds-viewer')!
    const initialViewerMounts = metrics.viewerMounts
    const initialViewerUnmounts = metrics.viewerUnmounts
    viewer().props.onGraphicsDiagnostic('Renderer degraded')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: Renderer degraded')

    find(host.container, (node) => node.props.id === 'worlds-quality-picker')!.props.onChange({ currentTarget: { value: 'profile:graphics:custom' } })
    await settle(host)

    assert.equal(api.snapshot.project.activeGraphicsProfileId, 'graphics:custom')
    assert.equal(metrics.viewerMounts, initialViewerMounts, 'quality changes must keep the existing editor viewport mounted')
    assert.equal(metrics.viewerUnmounts, initialViewerUnmounts)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: Renderer degraded', 'unchanged adapter diagnostics remain authoritative until the reused viewport clears or replaces them')
  } finally { await cleanup() }
})

test('adversarial Workbench rejects an ABA stale diagnostic callback captured from a previous viewport lifetime with identical semantic ids', async () => {
  harness()
  const { module, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const scenePicker = () => find(host.container, (node) => node.props.id === 'worlds-scene-picker')!
    const originalSceneId = scenePicker().props.value
    const firstViewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    const firstLifetimeDiagnostic = firstViewer.props.onGraphicsDiagnostic

    scenePicker().props.onChange({ currentTarget: { value: 'scene:two' } })
    await settle(host)
    scenePicker().props.onChange({ currentTarget: { value: originalSceneId } })
    await settle(host)

    firstLifetimeDiagnostic('ABA stale renderer warning')
    await settle(host, 1)

    assert.notEqual(textOf(statusNode(host.container)), 'Graphics: ABA stale renderer warning', 'a callback from the first A lifetime must remain stale after A→B→A')
  } finally { await cleanup() }
})

test('adversarial Workbench keeps a newly mounted child layout diagnostic when a stale callback fires later in the same commit', async () => {
  const metrics = harness()
  const { module, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const scenePicker = () => find(host.container, (node) => node.props.id === 'worlds-scene-picker')!
    const originalSceneId = scenePicker().props.value

    scenePicker().props.onChange({ currentTarget: { value: 'scene:two' } })
    await settle(host)
    const sceneTwoViewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    const sceneTwoDiagnostic = sceneTwoViewer.props.onGraphicsDiagnostic

    metrics.initialViewerDiagnostic = 'Fresh remount child layout warning'
    metrics.staleDiagnosticAfterInitial = () => sceneTwoDiagnostic('Late scene two stale warning')
    scenePicker().props.onChange({ currentTarget: { value: originalSceneId } })
    await settle(host)

    assert.equal(textOf(statusNode(host.container)), 'Graphics: Fresh remount child layout warning', 'per-lifetime pending diagnostics must not be globally overwritten by stale callbacks')
  } finally { await cleanup() }
})

test('adversarial StrictMode replay preserves the committed viewport diagnostic owner and first layout warning', async () => {
  const metrics = harness()
  metrics.initialViewerDiagnostic = 'StrictMode first layout warning'
  const { module, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted({ strict: true })
    host.render(React.createElement(React.StrictMode, null, React.createElement(module.WorldsWorkbench)))
    await settle(host, 16)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: StrictMode first layout warning')
    const viewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    viewer.props.onGraphicsDiagnostic('StrictMode live replacement')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: StrictMode live replacement')
  } finally { await cleanup() }
})

test('adversarial unmount/remount rejects a stale callback from the previous Workbench lifetime', async () => {
  harness()
  const { module, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const firstViewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    const staleDiagnostic = firstViewer.props.onGraphicsDiagnostic
    host.render(null)
    await settle(host, 4)
    staleDiagnostic('unmounted stale diagnostic')
    await settle(host, 2)
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host, 8)
    assert.notEqual(textOf(statusNode(host.container)), 'Graphics: unmounted stale diagnostic')
    const currentViewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    currentViewer.props.onGraphicsDiagnostic('remounted live diagnostic')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: remounted live diagnostic')
  } finally { await cleanup() }
})

test('adversarial current empty graphics message clears only graphics while retaining an exposed error priority', async () => {
  harness()
  const { module, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const viewer = () => find(host.container, (node) => node.type === 'worlds-viewer')!
    viewer().props.onGraphicsDiagnostic('Renderer degraded before error')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: Renderer degraded before error')
    find(host.container, (node) => node.props.id === 'worlds-scene-picker')!.props.onChange({ currentTarget: { value: 'scene:missing' } })
    await settle(host)
    assert.equal(textOf(statusNode(host.container)), 'Scene scene:missing does not exist.')
    assert.equal(statusNode(host.container)?.props.role, 'alert')
    viewer().props.onGraphicsDiagnostic('')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Scene scene:missing does not exist.')
    assert.equal(statusNode(host.container)?.props['aria-live'], 'assertive')
  } finally { await cleanup() }
})

test('adversarial suspended concurrent replacement cannot publish speculative graphics diagnostics', async () => {
  const metrics = harness()
  const { module, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted({ concurrent: true })
    const view = (key: string) => React.createElement(React.Suspense, { fallback: React.createElement('pending-view') }, React.createElement(module.WorldsWorkbench, { key }))
    host.render(view('committed'))
    await settle(host, 8)
    const committedViewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    committedViewer.props.onGraphicsDiagnostic('committed warning')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: committed warning')

    metrics.suspendNextViewer = true
    host.transition(view('speculative'))
    for (let index = 0; index < 100 && !metrics.speculativeDiagnostic; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(typeof metrics.speculativeDiagnostic, 'function')
    assert.ok(find(host.container, (node) => node.type === 'worlds-viewer'), 'committed viewport stays visible while replacement suspends')
    metrics.speculativeDiagnostic!('speculative warning')
    await settle(host, 2)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: committed warning')

    host.render(view('committed'))
    await settle(host, 4)
    committedViewer.props.onGraphicsDiagnostic('committed warning after abandoned replacement')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: committed warning after abandoned replacement')
  } finally { await cleanup() }
})

test('adversarial abandoned concurrent unmount render does not close the still-committed viewport token', async () => {
  harness()
  const { module, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted({ concurrent: true })
    const workbench = React.createElement(module.WorldsWorkbench)
    host.render(workbench)
    await settle(host, 8)
    const viewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    viewer.props.onGraphicsDiagnostic('live before abandoned render')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: live before abandoned render')
    host.schedule(null)
    host.schedule(workbench)
    await settle(host, 8)
    viewer.props.onGraphicsDiagnostic('live after abandoned render')
    await settle(host, 1)
    assert.equal(textOf(statusNode(host.container)), 'Graphics: live after abandoned render')
  } finally { await cleanup() }
})

test('mounted Workbench dispatches one canonical graphics profile command for stored and preset quality choices', async () => {
  harness()
  const choices = [
    { value: 'profile:graphics:custom', expectedActive: 'graphics:custom', expectedCount: 2, expectedScale: 0.5 },
    { value: 'preset:integrated', expectedActive: 'graphics:integrated', expectedCount: 3, expectedScale: 0.75 },
    { value: 'preset:dedicated', expectedActive: 'graphics:dedicated', expectedCount: 3, expectedScale: 1 },
  ]
  for (const choice of choices) {
    const metrics = harness()
    const { module, api, cleanup } = await loadWorkbenchModule()
    try {
      const host = mounted()
      host.render(React.createElement(module.WorldsWorkbench))
      await settle(host)
      const viewer = () => find(host.container, (node) => node.type === 'worlds-viewer')!
      const initialToken = viewer().props.localStateToken
      const quality = () => find(host.container, (node) => node.props.id === 'worlds-quality-picker')!

      quality().props.onChange({ currentTarget: { value: choice.value } })
      await settle(host)

      assert.equal(metrics.applyCalls.length, 1)
      assert.equal(metrics.applyCalls[0].commands.length, 1)
      assert.equal(metrics.applyCalls[0].commands[0]?.type, 'replace-graphics-profiles')
      assert.equal(metrics.applyCalls[0].baseRevision, 1)
      assert.equal(api.snapshot.project.revision, 2)
      assert.equal(api.snapshot.project.activeGraphicsProfileId, choice.expectedActive)
      assert.equal(viewer().props.activeGraphicsProfileId, choice.expectedActive)
      assert.equal(viewer().props.renderScale, choice.expectedScale)
      assert.equal(viewer().props.localStateToken, initialToken)
      assert.deepEqual(api.snapshot.project.graphicsProfiles.filter((profile) => profile.id === 'graphics:custom'), [
        { id: 'graphics:custom', name: 'Custom', renderScale: 0.5, shadowQuality: 'off', antialiasing: 'off' },
      ])
      assert.equal(api.snapshot.project.graphicsProfiles.length, choice.expectedCount)
      assert.equal(find(host.container, (node) => node.props['aria-label'] === 'Undo')!.props.disabled, false)
    } finally { await cleanup() }
  }
})

test('mounted Workbench treats selecting the already active graphics profile as a real no-op', async () => {
  const metrics = harness()
  const { module, api, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const viewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    find(host.container, (node) => node.props.id === 'worlds-quality-picker')!.props.onChange({ currentTarget: { value: 'profile:graphics:balanced' } })
    await settle(host)
    assert.equal(metrics.applyCalls.length, 0)
    assert.equal(api.snapshot.project.activeGraphicsProfileId, 'graphics:balanced')
    assert.equal(api.snapshot.project.revision, 1)
    assert.equal(find(host.container, (node) => node.type === 'worlds-viewer')!.props.localStateToken, viewer.props.localStateToken)
    assert.equal(find(host.container, (node) => node.props['aria-label'] === 'Undo')!.props.disabled, true)
  } finally { await cleanup() }
})

test('mounted Workbench keeps delayed rejected and stale quality replies scoped to the active editor state', async () => {
  const metrics = harness()
  const { module, api, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const quality = () => find(host.container, (node) => node.props.id === 'worlds-quality-picker')!
    const play = () => find(host.container, (node) => node.props['aria-label'] === 'Play World')!
    const viewer = () => find(host.container, (node) => node.type === 'worlds-viewer')!
    const firstToken = viewer().props.localStateToken

    const rejected = api.holdNextApply()
    api.rejectNextApply({ code: 'revision_conflict', message: 'World project revision changed.' })
    quality().props.onChange({ currentTarget: { value: 'profile:graphics:custom' } })
    quality().props.onChange({ currentTarget: { value: 'profile:graphics:custom' } })
    play().props.onClick()
    await settle(host, 2)
    assert.equal(metrics.applyCalls.length, 1)
    assert.equal(play().props.disabled, true)
    assert.equal(viewer().props.activeGraphicsProfileId, 'graphics:balanced')
    assert.equal(viewer().props.localStateToken, firstToken)
    rejected.resolve()
    await settle(host)
    assert.equal(api.snapshot.project.activeGraphicsProfileId, 'graphics:balanced')
    assert.equal(viewer().props.activeGraphicsProfileId, 'graphics:balanced')
    assert.equal(metrics.playStarts, 0)
    assert.notEqual(textOf(statusNode(host.container)), 'Quality saved')
    assert.equal(textOf(statusNode(host.container)), 'World project revision changed.')
    assert.equal(quality().props.disabled, false)

    const stale = api.holdNextApply()
    quality().props.onChange({ currentTarget: { value: 'profile:graphics:custom' } })
    await settle(host, 2)
    const external = cloneWorldProjectSnapshot(api.snapshot)
    external.project.revision = 2
    api.replaceSnapshot(external)
    stale.resolve()
    await settle(host)
    assert.equal(api.snapshot.project.activeGraphicsProfileId, 'graphics:balanced')
    assert.equal(viewer().props.activeGraphicsProfileId, 'graphics:balanced')
    assert.equal(textOf(statusNode(host.container)), 'World project write failed.')
    assert.equal(quality().props.disabled, false)
  } finally { await cleanup() }
})

test('mounted Workbench undo redo and reopen preserve exact graphics profile records through canonical history', async () => {
  harness()
  const { module, api, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const quality = () => find(host.container, (node) => node.props.id === 'worlds-quality-picker')!
    const undo = () => find(host.container, (node) => node.props['aria-label'] === 'Undo')!
    const redo = () => find(host.container, (node) => node.props['aria-label'] === 'Redo')!
    const originalProfiles = structuredClone(api.snapshot.project.graphicsProfiles)

    quality().props.onChange({ currentTarget: { value: 'preset:integrated' } })
    await settle(host)
    assert.equal(api.snapshot.project.activeGraphicsProfileId, 'graphics:integrated')
    assert.equal(undo().props.disabled, false)
    undo().props.onClick()
    await settle(host)
    assert.equal(api.snapshot.project.activeGraphicsProfileId, 'graphics:balanced')
    assert.deepEqual(api.snapshot.project.graphicsProfiles, originalProfiles)
    assert.equal(redo().props.disabled, false)
    redo().props.onClick()
    await settle(host)
    assert.equal(api.snapshot.project.activeGraphicsProfileId, 'graphics:integrated')
    assert.equal(api.snapshot.project.graphicsProfiles.some((profile) => profile.id === 'graphics:custom'), true)
    assert.equal(api.snapshot.project.graphicsProfiles.some((profile) => profile.id === 'graphics:integrated'), true)

    const reopenedSeed = cloneWorldProjectSnapshot(api.snapshot)
    await cleanup()
    const reopened = await loadWorkbenchModule(reopenedSeed)
    try {
      const reopenedHost = mounted()
      reopenedHost.render(React.createElement(reopened.module.WorldsWorkbench))
      await settle(reopenedHost)
      const reopenedViewer = find(reopenedHost.container, (node) => node.type === 'worlds-viewer')!
      assert.equal(reopenedViewer.props.activeGraphicsProfileId, 'graphics:integrated')
      assert.equal(reopenedViewer.props.renderScale, 0.75)
      assert.deepEqual(reopened.api.snapshot.project.graphicsProfiles, reopenedSeed.project.graphicsProfiles)
    } finally { await reopened.cleanup() }
  } catch (error) {
    await cleanup()
    throw error
  }
})

test('mounted Workbench production Play clones the accepted graphics profile and Stop preserves the canonical editor snapshot', async () => {
  const metrics = harness()
  const { module, api, cleanup } = await loadWorkbenchModule()
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    const quality = () => find(host.container, (node) => node.props.id === 'worlds-quality-picker')!
    const play = () => find(host.container, (node) => node.props['aria-label'] === 'Play World')!

    const gate = api.holdNextApply()
    quality().props.onChange({ currentTarget: { value: 'profile:graphics:custom' } })
    play().props.onClick()
    await settle(host, 2)
    assert.equal(metrics.playStarts, 0, 'pending quality request cannot start Play before the accepted rerender enables the real start route')
    gate.resolve()
    await settle(host)
    const accepted = cloneWorldProjectSnapshot(api.snapshot)
    play().props.onClick()
    await settle(host, 16)
    const runtime = find(host.container, (node) => node.type === 'world-runtime-viewport')!
    assert.equal(runtime.props.lifecycle, 'playing')
    assert.equal(runtime.props.activeGraphicsProfileId, 'graphics:custom')
    assert.equal(metrics.runtimeSnapshots.at(-1)?.project.activeGraphicsProfileId, 'graphics:custom')
    assert.equal(metrics.physicsInitialized, 1)
    assert.equal(metrics.audioPrepared, 1)

    find(host.container, (node) => node.props['aria-label'] === 'Stop World')!.props.onClick()
    await settle(host, 16)
    assert.equal(metrics.physicsDisposed, 1)
    assert.equal(metrics.audioStopped, 1)
    assert.deepEqual(api.snapshot, accepted)
    const editorViewer = find(host.container, (node) => node.type === 'worlds-viewer')!
    assert.equal(editorViewer.props.activeGraphicsProfileId, 'graphics:custom')
    assert.equal(editorViewer.props.renderScale, 0.5)
  } finally { await cleanup() }
})


test('mounted Workbench default Play route loads real GLB collider bytes into numeric physics DTOs', async () => {
  const metrics = harness()
  const seed = createHarnessSnapshot()
  seed.project.resources.push({ id: 'resource:mesh-default', type: 'model', name: 'Mesh Default', workspacePath: 'Assets/default-mesh.glb', format: 'glb' })
  const ground = seed.scenes[0].entities.find((entity) => entity.id === 'entity:ground')!
  ground.components[0] = { id: 'component:ground-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'mesh', resourceId: 'resource:mesh-default', sensor: false, friction: 0.8, restitution: 0, collisionLayer: 1, collisionMask: 0xffff }
  const originalFetch = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = async (input) => {
    requested.push(String(input))
    return new Response(makeMountedGlb(), { headers: { 'content-length': String(makeMountedGlb().byteLength) } })
  }
  const { module, cleanup } = await loadWorkbenchModule(seed)
  try {
    const host = mounted()
    host.render(React.createElement(module.WorldsWorkbench))
    await settle(host)
    find(host.container, (node) => node.props['aria-label'] === 'Play World')!.props.onClick()
    await settle(host, 16)
    assert.equal(metrics.physicsInitialized, 1)
    assert.equal(requested.some((url) => url.endsWith('/workspace/Assets/default-mesh.glb')), true)
    const scene = metrics.physicsScenes[0] as { bodies: Array<{ entityId: string; colliders: Array<{ shape: { kind: string; vertices?: Float32Array; indices?: Uint32Array } }> }> }
    const shape = scene.bodies.find((body) => body.entityId === 'entity:ground')?.colliders[0]?.shape
    assert.equal(shape?.kind, 'trimesh')
    assert.deepEqual([...(shape?.vertices ?? new Float32Array())], [0, 0, 0, 1, 0, 0, 0, 1, 0])
    assert.deepEqual([...(shape?.indices ?? new Uint32Array())], [0, 1, 2])
  } finally {
    globalThis.fetch = originalFetch
    await cleanup()
  }
})

function makeMountedGlb(): ArrayBuffer {
  const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint32Array([0, 1, 2])
  const vertexBytes = new Uint8Array(vertices.buffer)
  const indexBytes = new Uint8Array(indices.buffer)
  const bin = new Uint8Array(mountedAlign4(vertexBytes.byteLength + indexBytes.byteLength))
  bin.set(vertexBytes, 0); bin.set(indexBytes, vertexBytes.byteLength)
  const json = {
    asset: { version: '2.0' }, buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertexBytes.byteLength, target: 34962 }, { buffer: 0, byteOffset: vertexBytes.byteLength, byteLength: indexBytes.byteLength, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR', min: [0], max: [2] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const paddedJson = new Uint8Array(mountedAlign4(jsonBytes.byteLength)); paddedJson.set(jsonBytes); paddedJson.fill(0x20, jsonBytes.byteLength)
  const total = 12 + 8 + paddedJson.byteLength + 8 + bin.byteLength
  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  let offset = 0
  view.setUint32(offset, 0x46546c67, true); offset += 4
  view.setUint32(offset, 2, true); offset += 4
  view.setUint32(offset, total, true); offset += 4
  view.setUint32(offset, paddedJson.byteLength, true); offset += 4
  view.setUint32(offset, 0x4e4f534a, true); offset += 4
  new Uint8Array(out, offset, paddedJson.byteLength).set(paddedJson); offset += paddedJson.byteLength
  view.setUint32(offset, bin.byteLength, true); offset += 4
  view.setUint32(offset, 0x004e4942, true); offset += 4
  new Uint8Array(out, offset, bin.byteLength).set(bin)
  return out
}

function mountedAlign4(value: number): number { return (value + 3) & ~3 }

function apiHoldNextApplyFromWindow() {
  const api = (globalThis as any).window.electron.workspace.worlds.projects as ReturnType<typeof createProjectApi>
  return api.holdNextApply()
}
