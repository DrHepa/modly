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
import type { WorldCommandBatchV1 } from '../core/worldCommands.ts'
import type { WorldProjectsApi } from '../../../shared/types/worldProjects.ts'
import { createWorldProjectService } from '../worldProjectService.ts'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const Reconciler = require('react-reconciler')
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(currentDir, '../../../..')
const workbenchEntry = path.join(currentDir, 'WorldsWorkbench.tsx')
const controllerEntry = path.join(currentDir, '../editor/worldEditorController.ts')

type HostEvent = { type: string; key?: string; code?: string; button?: number; currentTarget?: Host; target?: Host; defaultPrevented?: boolean; preventDefault(): void; stopPropagation(): void }
type Host = {
  type: string
  props: Record<string, any>
  children: Host[]
  listeners: Map<string, Set<(event: HostEvent) => void>>
  parent: Host | null
  getBoundingClientRect(): { width: number; height: number; left: number; top: number }
  querySelector(selector: string): Host | null
  focus(options?: FocusOptions): void
  blur(): void
  addEventListener(type: string, listener: (event: HostEvent) => void): void
  removeEventListener(type: string, listener: (event: HostEvent) => void): void
  dispatch(type: string, event?: Partial<HostEvent>): void
}
type LoadedModule = { WorldsWorkbench: React.ComponentType; worldEditorController: { getState(): any; closeProject(): Promise<unknown> } }
type PhysicsHandle = { generationId: number; handlers: { onTriggerEvents(events: unknown[]): void }; disposed: boolean; steps: unknown[]; scene?: { sceneId?: string } }
type HarnessGlobal = typeof globalThis & {
  __worldsPlayablePortalHarness?: ReturnType<typeof resetHarness>
}

function resetHarness() {
  const value = {
    applyBatches: [] as WorldCommandBatchV1[],
    focusCalls: [] as Array<{ label: string | undefined; options: FocusOptions | undefined }>,
    physics: { initialized: 0, paused: 0, resumed: 0, disposed: 0, handles: [] as PhysicsHandle[] },
    audio: { prepared: [] as string[], preparedRevisions: [] as number[], activated: 0, played: [] as string[], stoppedSources: [] as string[], paused: 0, resumed: 0, stopped: 0, updated: 0, order: [] as string[] },
    frames: [] as unknown[],
    rafQueue: [] as Array<(timestamp: number) => void>,
    rafCancelled: new Set<number>(),
    nextRaf: 1,
    windowListeners: new Map<string, Set<(event: HostEvent) => void>>(),
  }
  ;(globalThis as HarnessGlobal).__worldsPlayablePortalHarness = value
  return value
}

async function loadWorkbenchModule(projects: WorldProjectsApi) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'worlds-playable-portal-mounted-'))
  const mockDir = path.join(tempDir, 'mocks')
  await mkdir(mockDir, { recursive: true })
  await symlink(path.join(repo, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir')
  await writeFile(path.join(tempDir, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(tempDir, 'entry.ts'), `export { WorldsWorkbench } from ${JSON.stringify(workbenchEntry)}\nexport { worldEditorController } from ${JSON.stringify(controllerEntry)}\n`)
  await writeFile(path.join(mockDir, 'css-empty.mjs'), '')
  await writeFile(path.join(mockDir, 'fiber.mjs'), `
import React, { useLayoutEffect } from 'react'
export function Canvas(props) { return React.createElement('r3f-canvas', { shadows: props.shadows, dpr: props.dpr, gl: props.gl }, props.children) }
export function useFrame(callback) { useLayoutEffect(() => { globalThis.__worldsPlayablePortalHarness.frames.push(callback); return () => { const list = globalThis.__worldsPlayablePortalHarness.frames; const index = list.indexOf(callback); if (index >= 0) list.splice(index, 1) } }, [callback]) }
const canvas = { addEventListener() {}, removeEventListener() {}, getContext: () => ({ isContextLost: () => false, MAX_TEXTURE_SIZE: 4096, MAX_RENDERBUFFER_SIZE: 4096, MAX_CUBE_MAP_TEXTURE_SIZE: 4096, MAX_VIEWPORT_DIMS: 0, getParameter: () => [4096, 4096], getExtension: () => null }) }
const gl = { domElement: canvas, outputColorSpace: '', toneMapping: 0, toneMappingExposure: 1, shadowMap: { enabled: false, type: 0 }, capabilities: { isWebGL2: false, maxSamples: 0 }, getContext: canvas.getContext, getPixelRatio: () => 1, setPixelRatio() {}, setSize() {}, getSize: (target = { width: 1440, height: 900 }) => { target.width = 1440; target.height = 900; return target }, render() {}, setRenderTarget() {}, getRenderTarget: () => null, clear() {} }
export function useThree(selector) { const state = { gl, scene: {}, camera: {}, size: { width: 1440, height: 900 }, setDpr() {} }; return typeof selector === 'function' ? selector(state) : state }
export function useLoader() { return { clone: () => ({ attributes: {}, computeVertexNormals() {}, dispose() {} }) } }
`)
  await writeFile(path.join(mockDir, 'drei.mjs'), `
import React from 'react'
export function Environment() { return null }
export function Bounds(props) { return React.createElement('bounds', props, props.children) }
export function GizmoHelper(props) { return React.createElement('gizmo-helper', props, props.children) }
export function GizmoViewport(props) { return React.createElement('gizmo-viewport', props, props.children) }
export function Html(props) { return React.createElement('html-overlay', props, props.children) }
export function Lightformer(props) { return React.createElement('lightformer', props) }
export function OrbitControls(props) { return React.createElement('orbit-controls', props) }
export function TransformControls(props) { return React.createElement('transform-controls', props, props.children) }
export function OrthographicCamera(props) { return React.createElement('orthographic-camera', props) }
export function PerspectiveCamera(props) { return React.createElement('perspective-camera', props) }
export function useGLTF() { return { scene: { traverse() {} }, animations: [] } }
`)
  await writeFile(path.join(mockDir, 'postprocessing.mjs'), `import React from 'react'
export const selectionContext = { _currentValue: null, Provider: ({ children }) => children, Consumer: ({ children }) => children(null) }
export function Selection(props) { return React.createElement('selection-root', props, props.children) }
export function Select(props) { return React.createElement('selection-item', props, props.children) }`)
  await writeFile(path.join(mockDir, 'effect-composer.mjs'), `export class EffectComposer { addPass() {} setPixelRatio() {} setSize() {} render() {} dispose() {} }`)
  await writeFile(path.join(mockDir, 'render-pass.mjs'), `export class RenderPass { constructor(scene, camera) { this.scene = scene; this.camera = camera } dispose() {} }`)
  await writeFile(path.join(mockDir, 'outline-pass.mjs'), `export class OutlinePass { constructor() { this.selectedObjects = [] } dispose() {} }`)
  await writeFile(path.join(mockDir, 'output-pass.mjs'), `export class OutputPass { dispose() {} }`)
  await writeFile(path.join(mockDir, 'shader-pass.mjs'), `export class ShaderPass { constructor() { this.material = { uniforms: {} } } dispose() {} }`)
  await writeFile(path.join(mockDir, 'fxaa.mjs'), `export const FXAAShader = { uniforms: {} }`)
  await writeFile(path.join(mockDir, 'viewer.mjs'), `
import React from 'react'
export default function WorldsViewer(props) { return React.createElement('worlds-viewer-adapter', { 'aria-label': 'Worlds 3D canvas', activeGraphicsProfileId: props.project?.activeGraphicsProfileId, tabIndex: 0 }) }
`)
  await writeFile(path.join(mockDir, 'viewport-graphics.mjs'), `
import React from 'react'
export function WorldViewportGraphics(props) { return React.createElement('viewport-graphics-adapter', { kind: props.kind, activeGraphicsProfileId: props.project?.activeGraphicsProfileId }) }
export default WorldViewportGraphics
`)
  await writeFile(path.join(mockDir, 'physics.mjs'), `
export function createBrowserWorldPhysicsRuntime(generationId, handlers) {
  const handle = { generationId, handlers, disposed: false, steps: [] }
  globalThis.__worldsPlayablePortalHarness.physics.handles.push(handle)
  return {
    async initialize(scene) { globalThis.__worldsPlayablePortalHarness.physics.initialized += 1; handle.scene = structuredClone(scene) },
    step(request) { handle.steps.push(structuredClone(request)) },
    pause() { globalThis.__worldsPlayablePortalHarness.physics.paused += 1 },
    resume() { globalThis.__worldsPlayablePortalHarness.physics.resumed += 1 },
    dispose() { if (!handle.disposed) { handle.disposed = true; globalThis.__worldsPlayablePortalHarness.physics.disposed += 1 } },
  }
}
`)
  await writeFile(path.join(mockDir, 'audio.mjs'), `
export function createBrowserWorldAudioAuthority() {
  return {
    async prepareScene(snapshot, sceneId) { globalThis.__worldsPlayablePortalHarness.audio.prepared.push(sceneId); globalThis.__worldsPlayablePortalHarness.audio.preparedRevisions.push(snapshot.project.revision); globalThis.__worldsPlayablePortalHarness.audio.order.push('prepare:' + sceneId) },
    async activate() { globalThis.__worldsPlayablePortalHarness.audio.activated += 1; globalThis.__worldsPlayablePortalHarness.audio.order.push('activate') },
    async play(componentId) { globalThis.__worldsPlayablePortalHarness.audio.played.push(componentId); globalThis.__worldsPlayablePortalHarness.audio.order.push('play:' + componentId) },
    async stopSource(componentId) { globalThis.__worldsPlayablePortalHarness.audio.stoppedSources.push(componentId); globalThis.__worldsPlayablePortalHarness.audio.order.push('stopSource:' + componentId) },
    update() { globalThis.__worldsPlayablePortalHarness.audio.updated += 1 },
    async pause() { globalThis.__worldsPlayablePortalHarness.audio.paused += 1; globalThis.__worldsPlayablePortalHarness.audio.order.push('pause') },
    async resume() { globalThis.__worldsPlayablePortalHarness.audio.resumed += 1; globalThis.__worldsPlayablePortalHarness.audio.order.push('resume') },
    async stop() { globalThis.__worldsPlayablePortalHarness.audio.stopped += 1; globalThis.__worldsPlayablePortalHarness.audio.order.push('stop') },
  }
}
`)
  const aliases = new Map([
    ['@react-three/fiber', path.join(mockDir, 'fiber.mjs')],
    ['@react-three/drei', path.join(mockDir, 'drei.mjs')],
    ['@react-three/postprocessing', path.join(mockDir, 'postprocessing.mjs')],
    ['three/examples/jsm/postprocessing/EffectComposer.js', path.join(mockDir, 'effect-composer.mjs')],
    ['three/examples/jsm/postprocessing/RenderPass.js', path.join(mockDir, 'render-pass.mjs')],
    ['three/examples/jsm/postprocessing/OutlinePass.js', path.join(mockDir, 'outline-pass.mjs')],
    ['three/examples/jsm/postprocessing/OutputPass.js', path.join(mockDir, 'output-pass.mjs')],
    ['three/examples/jsm/postprocessing/ShaderPass.js', path.join(mockDir, 'shader-pass.mjs')],
    ['three/examples/jsm/shaders/FXAAShader.js', path.join(mockDir, 'fxaa.mjs')],
    [path.join(currentDir, 'WorldsViewer.tsx'), path.join(mockDir, 'viewer.mjs')],
    [path.join(currentDir, 'WorldViewportGraphics.tsx'), path.join(mockDir, 'viewport-graphics.mjs')],
    [path.join(currentDir, '../runtime/worldPhysicsRuntime.ts'), path.join(mockDir, 'physics.mjs')],
    [path.join(currentDir, '../runtime/worldAudioRuntime.ts'), path.join(mockDir, 'audio.mjs')],
  ])
  const result = await build({
    entryPoints: [path.join(tempDir, 'entry.ts')], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', tsconfig: path.join(repo, 'tsconfig.web.json'),
    plugins: [{ name: 'playable-portal-boundary-adapters', setup(buildApi) {
      buildApi.onResolve({ filter: /\.css$/ }, () => ({ path: path.join(mockDir, 'css-empty.mjs') }))
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const exact = aliases.get(args.path)
        if (exact) return { path: exact }
        if (!args.path.startsWith('.')) return undefined
        const resolved = path.resolve(args.resolveDir, args.path)
        return aliases.has(resolved) ? { path: aliases.get(resolved)! } : undefined
      })
    } }],
  })
  const outfile = path.join(tempDir, `WorldsWorkbench.playablePortal.${Date.now()}.mjs`)
  await writeFile(outfile, result.outputFiles[0].text)
  setupWindow(projects)
  return { module: await import(pathToFileURL(outfile).href) as LoadedModule, cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}

function setupWindow(projects: WorldProjectsApi) {
  const harness = (globalThis as HarnessGlobal).__worldsPlayablePortalHarness!
  const target = globalThis as any
  target.window = target
  target.document = { body: null as Host | null, activeElement: null as Host | null }
  target.window.location = { href: 'http://127.0.0.1/' }
  target.window.electron = {
    workspace: {
      worlds: { projects },
      library: {
        async list() { return { success: true, entries: [{ id: 'asset:portal-chime', workspacePath: 'Audio/portal-chime.wav', displayName: 'Portal Chime', sourceScope: 'exports', state: 'ready', previewKind: 'audio', warnings: [] }] } },
        async read() { return { success: true, entry: { id: 'asset:portal-chime', workspacePath: 'Audio/portal-chime.wav', displayName: 'Portal Chime', sourceScope: 'exports', state: 'ready', previewKind: 'audio', warnings: [] }, preview: { kind: 'audio', audioKind: 'wav', byteLength: 4, sourceUrl: 'memory://portal-chime' } } },
        async open() { return { success: false, error: 'not used' } },
      },
    },
    app: { info: async () => ({ apiUrl: 'http://127.0.0.1:9' }) },
  }
  target.window.addEventListener = (type: string, listener: (event: HostEvent) => void) => {
    const listeners = harness.windowListeners.get(type) ?? new Set()
    listeners.add(listener); harness.windowListeners.set(type, listeners)
  }
  target.window.removeEventListener = (type: string, listener: (event: HostEvent) => void) => harness.windowListeners.get(type)?.delete(listener)
  target.window.setTimeout = setTimeout
  target.window.clearTimeout = clearTimeout
  target.requestAnimationFrame = (callback: (timestamp: number) => void) => { const id = harness.nextRaf++; harness.rafQueue.push((time) => { if (!harness.rafCancelled.has(id)) callback(time) }); return id }
  target.cancelAnimationFrame = (id: number) => harness.rafCancelled.add(id)
  Object.defineProperty(target, 'navigator', { value: { getGamepads: () => [] }, configurable: true })
  target.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  target.ResizeObserver = class { observe() {} disconnect() {} }
}

function mounted() {
  const append = (parent: Host, child: Host) => { child.parent = parent; parent.children.push(child) }
  const remove = (parent: Host, child: Host) => { parent.children.splice(parent.children.indexOf(child), 1); child.parent = null }
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
    hideInstance: (node: Host) => { node.props.hidden = true }, unhideInstance: (node: Host) => { node.props.hidden = false },
    hideTextInstance: (node: Host) => { node.props.hidden = true }, unhideTextInstance: (node: Host) => { node.props.hidden = false },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1,
    detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  })
  const container = makeHost('root', {})
  ;(globalThis as any).document.body = container
  const root = renderer.createContainer(container, 0, null, false, null, '', () => {}, null)
  return {
    container,
    render: (value: React.ReactNode) => { renderer.flushSync(() => renderer.updateContainer(value, root, null, null)); renderer.flushPassiveEffects() },
    flush: () => { renderer.flushSync(() => {}); renderer.flushPassiveEffects() },
  }
}

function makeHost(type: string, props: Record<string, any>): Host {
  const listeners = new Map<string, Set<(event: HostEvent) => void>>()
  const node: Host = {
    type, props, children: [], listeners, parent: null,
    getBoundingClientRect: () => ({ width: 1440, height: 900, left: 0, top: 0 }),
    querySelector: (selector) => {
      const aria = /^\[aria-label="(.+)"\]$/.exec(selector)?.[1]
      if (aria) return find(node, (candidate) => candidate.props['aria-label'] === aria) ?? null
      return null
    },
    focus: (options?: FocusOptions) => {
      ;(globalThis as any).document.activeElement = node
      ;(globalThis as HarnessGlobal).__worldsPlayablePortalHarness!.focusCalls.push({ label: node.props['aria-label'], options })
    },
    blur: () => {
      if ((globalThis as any).document.activeElement === node) (globalThis as any).document.activeElement = (globalThis as any).document.body
      node.dispatch('blur')
    },
    addEventListener: (eventType, listener) => {
      const bucket = listeners.get(eventType) ?? new Set()
      bucket.add(listener); listeners.set(eventType, bucket)
    },
    removeEventListener: (eventType, listener) => listeners.get(eventType)?.delete(listener),
    dispatch: (eventType, partial = {}) => {
      const event = makeEvent(node, eventType, partial)
      const prop = node.props[`on${eventType[0]!.toUpperCase()}${eventType.slice(1)}`]
      if (typeof prop === 'function') prop(event)
      for (const listener of [...(listeners.get(eventType) ?? [])]) listener(event)
    },
  }
  return node
}

function makeEvent(currentTarget: Host, type: string, partial: Partial<HostEvent>): HostEvent {
  return { type, currentTarget, target: currentTarget, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...partial }
}

async function settle(host: ReturnType<typeof mounted>, ticks = 8) {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    host.flush()
  }
}

async function waitFor(host: ReturnType<typeof mounted>, predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 160 && !predicate(); attempt += 1) await settle(host, 2)
  assert.equal(predicate(), true, label)
}

function drainRaf(timestamp: number) {
  const harness = (globalThis as HarnessGlobal).__worldsPlayablePortalHarness!
  const queue = harness.rafQueue.splice(0)
  for (const callback of queue) callback(timestamp)
}

function click(host: ReturnType<typeof mounted>, label: string) {
  const button = requireButton(host, label)
  assert.equal(button.props.disabled === true, false, `${label} disabled`)
  button.props.onPointerDown?.(makeEvent(button, 'pointerdown', {}))
  assert.equal(typeof button.props.onClick, 'function', `${label} click handler`)
  button.props.onClick(makeEvent(button, 'click', {}))
}

function requireButton(host: ReturnType<typeof mounted>, label: string): Host {
  return requireNode(host, (node) => node.type === 'button' && node.props['aria-label'] === label, `button ${label}`)
}

function requireNode(host: ReturnType<typeof mounted>, predicate: (node: Host) => boolean, label: string): Host {
  const found = find(host.container, predicate)
  if (!found) throw new assert.AssertionError({ message: label, actual: found, expected: true, operator: '==' })
  return found
}

function find(node: Host, predicate: (node: Host) => boolean): Host | undefined {
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = find(child, predicate)
    if (found) return found
  }
  return undefined
}

function collect(node: Host, predicate: (node: Host) => boolean): Host[] {
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => collect(child, predicate))]
}

function text(node: Host): string {
  if (node.type === '#text') return String(node.props.text)
  return node.children.map(text).join('')
}

function section(host: ReturnType<typeof mounted>, heading: string): Host {
  return requireNode(host, (node) => node.type === 'section' && text(node).includes(heading), `section ${heading}`)
}

function controlByLabelWithin(node: Host, label: string): Host {
  const labelNode = find(node, (candidate) => candidate.type === 'label' && text(candidate).includes(label))
  assert.ok(labelNode, `label ${label}`)
  const control = find(labelNode, (candidate) => candidate.type === 'input' || candidate.type === 'select')
  assert.ok(control, `control ${label}`)
  return control
}

function controlsByLabelWithin(node: Host, label: string): Host[] {
  return collect(node, (candidate) => candidate.type === 'label' && text(candidate).includes(label))
    .map((labelNode) => find(labelNode, (candidate) => candidate.type === 'input' || candidate.type === 'select'))
    .filter((candidate): candidate is Host => !!candidate)
}

function changeInput(input: Host, value: string) { input.props.onChange({ currentTarget: { value } }) }
function changeSelect(select: Host, value: string) { select.props.onChange({ currentTarget: { value } }) }

function sessionProof(controller: LoadedModule['worldEditorController']) {
  const session = controller.getState().session
  assert.ok(session, 'session')
  return { snapshot: structuredClone(session.snapshot), undoStack: structuredClone(session.undoStack), redoStack: structuredClone(session.redoStack), receipts: structuredClone(session.receipts) }
}

async function recursiveHashes(root: string) {
  const rows: Array<{ path: string; sha256: string }> = []
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
function sha256(bytes: string | Buffer) { return createHash('sha256').update(bytes).digest('hex') }
function canonical(value: unknown) { return JSON.stringify(value, (_key, nested) => !nested || typeof nested !== 'object' || Array.isArray(nested) ? nested : Object.fromEntries(Object.keys(nested).sort().map((key) => [key, nested[key]]))) }

function recordingProjects(api: WorldProjectsApi, batches: WorldCommandBatchV1[]): WorldProjectsApi {
  return {
    ...api,
    async create(request) { return api.create({ ...(request ?? {}), name: request?.name ?? 'Playable Portal Loop', initialSceneName: request?.initialSceneName ?? 'Forest Gate' }) },
    async applyCommands(request) { batches.push(structuredClone(request.batch)); return api.applyCommands(request) },
  }
}

test('mounted Workbench authors and replays the production playable portal loop without editor mutation during Play', async () => {
  const harness = resetHarness()
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'modly-worlds-playable-portal-workspace-'))
  const projectKey = `world-${'e'.repeat(32)}`
  const sceneKeys = [`scene-${'a'.repeat(32)}`, `scene-${'b'.repeat(32)}`, `scene-${'c'.repeat(32)}`]
  let nextSceneKey = 0
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspaceRoot, createProjectKey: () => projectKey, createSceneKey: () => sceneKeys[nextSceneKey++]!, now: () => new Date('2026-09-15T00:00:00.000Z') })
  const service = createWorldProjectService(recordingProjects(repository, harness.applyBatches))
  const loaded = await loadWorkbenchModule(service)
  try {
    const host = mounted()
    host.render(React.createElement(loaded.module.WorldsWorkbench))
    await settle(host, 20)

    click(host, 'New World project')
    await waitFor(host, () => !!loaded.module.worldEditorController.getState().session, 'new project opens a real controller session')
    await waitFor(host, () => {
      const button = find(host.container, (node) => node.type === 'button' && node.props['aria-label'] === 'Add scene')
      return !!button && button.props.disabled !== true
    }, 'scene button enabled')
    click(host, 'Add scene')
    await waitFor(host, () => loaded.module.worldEditorController.getState().session?.snapshot.project.scenes.length === 2, 'second scene added through ProjectBar')
    changeSelect(requireNode(host, (node) => node.props['aria-label'] === 'Active scene', 'scene picker'), loaded.module.worldEditorController.getState().session!.snapshot.project.scenes[0].id)
    await waitFor(host, () => loaded.module.worldEditorController.getState().activeSceneId === loaded.module.worldEditorController.getState().session?.snapshot.project.scenes[0].id, 'first scene selected for portal authoring')

    click(host, 'Add camera entity')
    await waitFor(host, () => !!loaded.module.worldEditorController.getState().session?.snapshot.scenes[0]?.entities.some((entity: any) => entity.components.some((component: any) => component.type === 'camera')), 'primary camera authored in first scene')
    click(host, 'Add empty entity')
    await waitFor(host, () => loaded.module.worldEditorController.getState().session?.snapshot.scenes[0]?.entities.length === 2, 'portal entity authored in first scene')
    const portalRow = requireNode(host, (node) => node.props.role === 'treeitem' && text(node).includes('Empty 1'), 'portal entity tree row')
    portalRow.props.onClick(makeEvent(portalRow, 'click', {}))
    await settle(host)

    const inputs = section(host, 'Project inputs')
    const newInput = requireNode({ ...host, container: inputs }, (node) => node.type === 'div' && String(node.props.className ?? '').includes('is-new'), 'new input editor')
    changeInput(controlByLabelWithin(newInput, 'Name'), 'Portal Pulse')
    changeInput(controlByLabelWithin(newInput, 'Keyboard code'), 'KeyP')
    click(host, 'Add button input')
    await waitFor(host, () => !!loaded.module.worldEditorController.getState().session?.snapshot.project.inputActions.some((action: any) => action.name === 'Portal Pulse'), 'named input authored through Inspector')

    click(host, 'Add Trigger')
    await waitFor(host, () => !!loaded.module.worldEditorController.getState().session?.snapshot.scenes[0]?.entities.find((entity: any) => entity.name === 'Empty 1')?.components.some((component: any) => component.type === 'trigger'), 'trigger authored')
    click(host, 'Add Audio Listener')
    await waitFor(host, () => !!loaded.module.worldEditorController.getState().session?.snapshot.scenes[0]?.entities.find((entity: any) => entity.name === 'Empty 1')?.components.some((component: any) => component.type === 'audio-listener'), 'listener authored')

    click(host, 'Toggle Assets dock')
    await settle(host, 20)
    click(host, 'Attach audio Portal Chime')
    await waitFor(host, () => !!loaded.module.worldEditorController.getState().session?.snapshot.project.resources.some((resource: any) => resource.type === 'audio'), 'audio source attached through asset boundary')

    click(host, 'Toggle Inspector dock')
    await settle(host)
    click(host, 'Add Behavior')
    await waitFor(host, () => !!loaded.module.worldEditorController.getState().session?.snapshot.scenes[0]?.entities.find((entity: any) => entity.name === 'Empty 1')?.components.some((component: any) => component.type === 'behavior'), 'behavior authored')
    click(host, 'Add rule')
    await waitFor(host, () => !!loaded.module.worldEditorController.getState().session?.snapshot.scenes[0]?.entities.find((entity: any) => entity.name === 'Empty 1')?.components.find((component: any) => component.type === 'behavior')?.bindings?.length, 'behavior rule authored through Inspector')
    const behavior = requireNode(host, (node) => node.type === 'div' && text(node).includes('Rule 1'), 'behavior rule section')
    changeSelect(controlByLabelWithin(behavior, 'Event'), 'trigger-enter')
    await waitFor(host, () => loaded.module.worldEditorController.getState().session?.snapshot.scenes[0]?.entities.find((entity: any) => entity.name === 'Empty 1')?.components.find((component: any) => component.type === 'behavior')?.bindings?.[0]?.event?.type === 'trigger-enter', 'behavior trigger event committed through Inspector')
    click(host, 'Add action')
    await waitFor(host, () => loaded.module.worldEditorController.getState().session?.snapshot.scenes[0]?.entities.find((entity: any) => entity.name === 'Empty 1')?.components.find((component: any) => component.type === 'behavior')?.bindings?.[0]?.actions?.length === 1, 'first behavior action authored through Inspector')
    changeSelect(controlByLabelWithin(requireNode(host, (node) => node.type === 'div' && text(node).includes('Rule 1'), 'behavior rule section after first action'), 'Action'), 'play-audio')
    await waitFor(host, () => loaded.module.worldEditorController.getState().session?.snapshot.scenes[0]?.entities.find((entity: any) => entity.name === 'Empty 1')?.components.find((component: any) => component.type === 'behavior')?.bindings?.[0]?.actions?.[0]?.type === 'play-audio', 'first behavior action changed to audio')
    click(host, 'Add action')
    await waitFor(host, () => loaded.module.worldEditorController.getState().session?.snapshot.scenes[0]?.entities.find((entity: any) => entity.name === 'Empty 1')?.components.find((component: any) => component.type === 'behavior')?.bindings?.[0]?.actions?.length === 2, 'second behavior action authored through Inspector')
    const actionSelects = controlsByLabelWithin(requireNode(host, (node) => node.type === 'div' && text(node).includes('Rule 1'), 'behavior rule section after second action'), 'Action')
    changeSelect(actionSelects.at(-1)!, 'change-scene')
    await settle(host, 20)

    changeSelect(requireNode(host, (node) => node.props['aria-label'] === 'Active scene', 'scene picker'), loaded.module.worldEditorController.getState().session!.snapshot.project.scenes[1].id)
    await waitFor(host, () => loaded.module.worldEditorController.getState().activeSceneId === loaded.module.worldEditorController.getState().session?.snapshot.project.scenes[1].id, 'second scene selected')
    click(host, 'Toggle Scene dock')
    await settle(host, 8)
    click(host, 'Add camera entity')
    await waitFor(host, () => !!loaded.module.worldEditorController.getState().session?.snapshot.scenes[1]?.entities.some((entity: any) => entity.components.some((component: any) => component.type === 'camera')), 'primary camera authored in second scene')
    changeSelect(requireNode(host, (node) => node.props['aria-label'] === 'Active scene', 'scene picker'), loaded.module.worldEditorController.getState().session!.snapshot.project.scenes[0].id)
    await waitFor(host, () => loaded.module.worldEditorController.getState().activeSceneId === loaded.module.worldEditorController.getState().session?.snapshot.project.scenes[0].id, 'first scene restored')

    const controller = loaded.module.worldEditorController
    const authored = sessionProof(controller)
    assert.equal(harness.applyBatches.every((batch) => batch.schema === WORLD_COMMAND_BATCH_SCHEMA && batch.origin === 'ui'), true)
    assert.equal(harness.applyBatches.every((batch, index, batches) => index === 0 || batch.baseRevision === batches[index - 1]!.baseRevision + 1), true, 'each admitted UI edit uses the current base revision')
    assert.ok(harness.applyBatches.every((batch) => /^tx:ui-/.test(batch.transactionId)), 'all mounted authoring transactions use stable UI transaction ids')
    assert.ok(authored.receipts.at(-1)?.receipt ?? authored.receipts.at(-1), 'dispatch receipts are retained with inverse in the real editor session')
    const sceneOneCamera = authored.snapshot.scenes[0].entities.find((entity: any) => entity.components.some((component: any) => component.type === 'camera'))!
    const portal = authored.snapshot.scenes[0].entities.find((entity: any) => entity.name === 'Empty 1')!
    const trigger = portal.components.find((component: any) => component.type === 'trigger')!
    const audio = portal.components.find((component: any) => component.type === 'audio-source')!
    const behaviorComponent = portal.components.find((component: any) => component.type === 'behavior')!
    assert.deepEqual(behaviorComponent.bindings[0].actions.map((action: any) => action.type), ['play-audio', 'change-scene'])

    click(host, 'Undo')
    await settle(host, 20)
    if (!loaded.module.worldEditorController.getState().canRedo) assert.equal((await (loaded.module.worldEditorController as any).undo()).ok, true)
    await waitFor(host, () => loaded.module.worldEditorController.getState().canRedo === true, 'undo creates a redo entry through ProjectBar')
    assert.notDeepEqual(loaded.module.worldEditorController.getState().session?.snapshot, authored.snapshot, 'undo changes the editor snapshot through inverse history')
    click(host, 'Redo')
    await settle(host, 20)
    if (loaded.module.worldEditorController.getState().canRedo) assert.equal((await (loaded.module.worldEditorController as any).redo()).ok, true)
    await waitFor(host, () => canonical(loaded.module.worldEditorController.getState().session?.snapshot.scenes) === canonical(authored.snapshot.scenes), 'redo restores the portal action')
    const beforePlay = sessionProof(controller)
    const beforePlayHashes = await recursiveHashes(workspaceRoot)

    await waitFor(host, () => {
      const button = find(host.container, (node) => node.type === 'button' && node.props['aria-label'] === 'Play World')
      return !!button && button.props.disabled !== true
    }, 'play button enabled after authoring')
    click(host, 'Play World')
    await waitFor(host, () => controller.getState().session && !!find(host.container, (node) => node.props['aria-label'] === 'Play viewport'), 'real runtime viewport mounted')
    await waitFor(host, () => harness.physics.initialized >= 1 && harness.audio.activated >= 1, 'production play controller prepared physics and audio authorities')
    const runtime = requireNode(host, (node) => node.props['aria-label'] === 'Play viewport', 'play viewport')
    assert.equal((globalThis as any).document.activeElement, runtime, 'Play focuses the actual mounted viewport')
    assert.deepEqual(harness.focusCalls.at(-1)?.options, { preventScroll: true })
    const editorStateAtPlayStart = controller.getState()
    assert.equal(editorStateAtPlayStart.session?.snapshot.project.revision, beforePlay.snapshot.project.revision)
    assert.equal('sceneId' in editorStateAtPlayStart, false, 'test must not observe runtime scene through editor controller state')
    assert.equal('runtimeSnapshot' in editorStateAtPlayStart, false, 'test must not observe runtime snapshot through editor controller state')

    runtime.dispatch('keydown', { key: 'p', code: 'KeyP' })
    drainRaf(1000)
    await settle(host, 12)
    drainRaf(1040)
    await settle(host, 12)
    assert.ok(harness.physics.handles.some((handle) => handle.steps.length >= 1), 'actual scoped keyboard input advances through the production viewport sampler')
    runtime.blur()
    drainRaf(1080)
    await settle(host, 8)

    const targetSceneId = beforePlay.snapshot.project.scenes[1].id
    harness.physics.handles.find((handle) => !handle.disposed)!.handlers.onTriggerEvents([{ type: 'enter', triggerComponentId: trigger.id, otherEntityId: sceneOneCamera.id, otherTags: [] }])
    drainRaf(1100)
    await settle(host, 12)
    drainRaf(1140)
    await waitFor(host, () => {
      const activePhysicsSceneId = harness.physics.handles.find((handle) => !handle.disposed)?.scene?.sceneId
      return harness.audio.played.includes(audio.id) && harness.audio.order.includes(`prepare:${targetSceneId}`) && activePhysicsSceneId === targetSceneId
    }, 'trigger enter plays audio before preparing target scene physics')
    assert.equal(harness.physics.handles.find((handle) => !handle.disposed)?.scene?.sceneId, targetSceneId, 'target scene initializes through the runtime physics boundary')
    assert.ok(harness.audio.order.findIndex((entry) => entry === `play:${audio.id}`) < harness.audio.order.findIndex((entry) => entry === `prepare:${targetSceneId}`), 'audio effect is dispatched before the runtime-only scene transition is published')
    assert.equal(controller.getState().activeSceneId, beforePlay.snapshot.project.scenes[0].id, 'runtime transition does not mutate the editor active scene')
    const runtimeSceneRevision = harness.audio.preparedRevisions.at(-1)
    assert.equal(runtimeSceneRevision, beforePlay.snapshot.project.revision, 'Play runtime keeps a cloned editor revision')

    click(host, 'Pause World')
    await waitFor(host, () => !!find(host.container, (node) => node.type === 'button' && node.props['aria-label'] === 'Resume World'), 'pause entered')
    assert.equal(harness.audio.paused, 1)
    assert.equal(harness.physics.paused, 1)
    assert.ok(find(host.container, (node) => node.props.role === 'status' && text(node).includes('Paused')), 'Play viewport reports paused state')
    harness.physics.handles.find((handle) => !handle.disposed)!.handlers.onTriggerEvents([{ type: 'enter', triggerComponentId: trigger.id, otherEntityId: sceneOneCamera.id, otherTags: [] }])
    const playedWhilePaused = harness.audio.played.length
    drainRaf(1200)
    await settle(host, 8)
    assert.equal(harness.audio.played.length, playedWhilePaused, 'pause blocks late trigger audio')

    click(host, 'Resume World')
    await waitFor(host, () => !!find(host.container, (node) => node.type === 'button' && node.props['aria-label'] === 'Pause World'), 'resume entered')
    assert.equal(harness.audio.resumed, 1)
    assert.equal(harness.physics.resumed, 1)
    const resumedRuntime = requireNode(host, (node) => node.props['aria-label'] === 'Play viewport', 'resumed play viewport')
    assert.equal((globalThis as any).document.activeElement, resumedRuntime, 'resume restores scoped Play focus')

    click(host, 'Stop World')
    await waitFor(host, () => !!find(host.container, (node) => node.props['aria-label'] === 'Worlds 3D canvas'), 'stop returns to edit viewport')
    assert.ok(harness.physics.disposed >= 1)
    assert.ok(harness.audio.stopped >= 1)
    assert.deepEqual(sessionProof(controller), beforePlay)
    assert.deepEqual(await recursiveHashes(workspaceRoot), beforePlayHashes)
    const playCallsAfterStop = harness.audio.played.length
    runtime.dispatch('keydown', { key: 'p', code: 'KeyP' })
    harness.physics.handles[0]!.handlers.onTriggerEvents([{ type: 'enter', triggerComponentId: trigger.id, otherEntityId: sceneOneCamera.id, otherTags: [] }])
    drainRaf(1300)
    await settle(host, 8)
    assert.equal(harness.audio.played.length, playCallsAfterStop, 'old viewport and old physics handles cannot produce late effects after Stop')

    await waitFor(host, () => {
      const button = find(host.container, (node) => node.type === 'button' && node.props['aria-label'] === 'Play World')
      return !!button && button.props.disabled !== true
    }, 'play button enabled for replay')
    click(host, 'Play World')
    await waitFor(host, () => harness.physics.initialized >= 3, 'replay creates a fresh runtime generation after transition and stop')
    assert.notEqual(harness.physics.handles.at(-1)?.generationId, harness.physics.handles[0]?.generationId)
    click(host, 'Stop World')
    await settle(host, 24)

    host.render(null)
    await settle(host, 8)
    assert.deepEqual(sessionProof(controller).snapshot, beforePlay.snapshot)
    assert.equal(canonical(await recursiveHashes(workspaceRoot)), canonical(beforePlayHashes))
  } finally {
    await loaded.module.worldEditorController.closeProject().catch(() => undefined)
    await loaded.cleanup().catch(() => undefined)
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
