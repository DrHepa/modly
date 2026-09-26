import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import * as THREE from 'three'
import type { WorldProjectDocumentV1 } from '../core/worldModel.ts'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const Reconciler = require('react-reconciler')
const repo = path.join(import.meta.dirname, '../../../..')
const entry = path.join(import.meta.dirname, 'WorldViewportGraphics.tsx')

type Host = { type: string; props: Record<string, unknown>; children: Host[] }
type FrameSubscription = { callback(state: unknown, delta: number): void; priority: number; active: boolean }
type MountedThrowGlobal = typeof globalThis & { __worldGraphicsMountedThrowRender?: string }

type MountedGraphicsModule = typeof import('./WorldViewportGraphics.tsx') & {
  __stub: {
    FiberProvider: React.ComponentType<{ value: unknown; children?: React.ReactNode }>
    SelectionProvider: React.ComponentType<{ value: unknown; children?: React.ReactNode }>
    frames: FrameSubscription[]
    composers: Array<{ disposed: boolean; render(delta?: number): void }>
    outlines: Array<{ selectedObjects: unknown[] }>
  }
}

function setMountedRenderThrow(message: string): void {
  ;(globalThis as MountedThrowGlobal).__worldGraphicsMountedThrowRender = message
}

function clearMountedRenderThrow(): void {
  delete (globalThis as MountedThrowGlobal).__worldGraphicsMountedThrowRender
}

async function loadMountedModule(): Promise<{ module: MountedGraphicsModule; cleanup(): Promise<void> }> {
  const tempDir = await mkdtemp(path.join('/tmp', 'world-viewport-graphics-mounted-'))
  const mockDir = path.join(tempDir, 'mocks')
  await import('node:fs/promises').then(async (fs) => { await fs.mkdir(mockDir, { recursive: true }); await fs.symlink(path.join(repo, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir') })
  await writeFile(path.join(tempDir, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(mockDir, 'fiber.mjs'), `
import React from 'react'
export const FiberContext = React.createContext(null)
export const frames = []
export function FiberProvider({ value, children }) { return React.createElement(FiberContext.Provider, { value }, children) }
export function useThree() { const value = React.useContext(FiberContext); if (!value) throw new Error('missing fiber context'); return value }
export function useFrame(callback, priority = 0) {
  React.useLayoutEffect(() => {
    const subscription = { callback, priority, active: true }
    frames.push(subscription)
    return () => { subscription.active = false }
  }, [callback, priority])
}
`)
  await writeFile(path.join(mockDir, 'postprocessing.mjs'), `
import React from 'react'
export const selectionContext = React.createContext(null)
export function SelectionProvider({ value, children }) { return React.createElement(selectionContext.Provider, { value }, children) }
`)
  await writeFile(path.join(mockDir, 'EffectComposer.mjs'), `
export const composers = []
export class EffectComposer {
  constructor(renderer, target) { this.renderer = renderer; this.target = target; this.copyPass = { fsQuad: { material: null }, dispose() {} }; this.passes = []; this.disposed = false; composers.push(this) }
  addPass(pass) { this.passes.push(pass) }
  setPixelRatio(value) { this.pixelRatio = value }
  setSize(width, height) { this.width = width; this.height = height }
  render(delta) { if (globalThis.__worldGraphicsMountedThrowRender) throw new Error(globalThis.__worldGraphicsMountedThrowRender); this.lastDelta = delta }
  dispose() { this.disposed = true; this.copyPass.dispose() }
}
`)
  await writeFile(path.join(mockDir, 'RenderPass.mjs'), `export class RenderPass { constructor(scene, camera) { this.scene = scene; this.camera = camera } }`)
  await writeFile(path.join(mockDir, 'OutlinePass.mjs'), `
export const outlines = []
export class OutlinePass {
  constructor(size, scene, camera) { this.size = size; this.renderScene = scene; this.renderCamera = camera; this.selectedObjects = []; this.fsQuad = { material: null }; this.visibleEdgeColor = { set(value) { this.value = value } }; this.hiddenEdgeColor = { set(value) { this.value = value } }; outlines.push(this) }
  dispose() { this.disposed = true; this.fsQuad?.dispose?.() }
}
`)
  await writeFile(path.join(mockDir, 'ShaderPass.mjs'), `export class ShaderPass { constructor() { this.fsQuad = { material: null }; this.material = { uniforms: { resolution: { value: { set(x, y) { this.x = x; this.y = y } } } } }; this.enabled = true } dispose() { this.disposed = true; this.fsQuad?.dispose?.() } }`)
  await writeFile(path.join(mockDir, 'OutputPass.mjs'), `export class OutputPass { constructor() { this.fsQuad = { material: null } } dispose() { this.disposed = true; this.fsQuad?.dispose?.() } }`)
  await writeFile(path.join(mockDir, 'FXAAShader.mjs'), `export const FXAAShader = { uniforms: {} }`)
  const aliases = new Map([
    ['@react-three/fiber', path.join(mockDir, 'fiber.mjs')],
    ['@react-three/postprocessing', path.join(mockDir, 'postprocessing.mjs')],
    ['three/examples/jsm/postprocessing/EffectComposer.js', path.join(mockDir, 'EffectComposer.mjs')],
    ['three/examples/jsm/postprocessing/RenderPass.js', path.join(mockDir, 'RenderPass.mjs')],
    ['three/examples/jsm/postprocessing/OutlinePass.js', path.join(mockDir, 'OutlinePass.mjs')],
    ['three/examples/jsm/postprocessing/ShaderPass.js', path.join(mockDir, 'ShaderPass.mjs')],
    ['three/examples/jsm/postprocessing/OutputPass.js', path.join(mockDir, 'OutputPass.mjs')],
    ['three/examples/jsm/shaders/FXAAShader.js', path.join(mockDir, 'FXAAShader.mjs')],
  ])
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', tsconfig: path.join(repo, 'tsconfig.web.json'),
    plugins: [{ name: 'world-graphics-mounted-aliases', setup(buildApi) { buildApi.onResolve({ filter: /^@react-three\/(fiber|postprocessing)$/ }, (args) => ({ path: aliases.get(args.path) ?? args.path, external: true })); buildApi.onResolve({ filter: /^three\/examples\/jsm\/(postprocessing|shaders)\// }, (args) => ({ path: aliases.get(args.path) ?? args.path, external: true })) } }],
  })
  const outfile = path.join(tempDir, 'WorldViewportGraphics.mounted.bundle.mjs')
  const stubImports = `\nimport { FiberProvider as StubFiberProvider, frames as stubFrames } from ${JSON.stringify(pathToFileURL(path.join(mockDir, 'fiber.mjs')).href)};\nimport { SelectionProvider as StubSelectionProvider } from ${JSON.stringify(pathToFileURL(path.join(mockDir, 'postprocessing.mjs')).href)};\nimport { composers as stubComposers } from ${JSON.stringify(pathToFileURL(path.join(mockDir, 'EffectComposer.mjs')).href)};\nimport { outlines as stubOutlines } from ${JSON.stringify(pathToFileURL(path.join(mockDir, 'OutlinePass.mjs')).href)};\nexport const __stub = { FiberProvider: StubFiberProvider, SelectionProvider: StubSelectionProvider, frames: stubFrames, composers: stubComposers, outlines: stubOutlines };\n`
  await writeFile(outfile, result.outputFiles[0].text + stubImports)
  return { module: await import(pathToFileURL(outfile).href) as MountedGraphicsModule, cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}

function mounted(options: { concurrent?: boolean; strict?: boolean } = {}) {
  const append = (parent: Host, child: Host) => { parent.children.push(child) }
  const remove = (parent: Host, child: Host) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const renderer = Reconciler({
    now: performance.now.bind(performance), supportsMutation: true, isPrimaryRenderer: true,
    getRootHostContext: () => null, getChildHostContext: () => null, getPublicInstance: (node: Host) => node,
    prepareForCommit: () => null, resetAfterCommit() {}, shouldSetTextContent: () => false,
    createInstance: (type: string, props: Host['props']) => ({ type, props, children: [] }),
    createTextInstance: (text: string) => ({ type: '#text', props: { text }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, clearContainer: (node: Host) => { node.children = [] },
    insertBefore: append, insertInContainerBefore: append, finalizeInitialChildren: () => false,
    prepareUpdate: () => true, commitUpdate: (node: Host, _payload: unknown, _type: unknown, _old: unknown, props: Host['props']) => { node.props = props },
    commitTextUpdate: (node: Host, _old: unknown, text: string) => { node.props.text = text },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1,
    detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  })
  const container: Host = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(container, options.concurrent ? 1 : 0, null, options.strict ?? false, null, '', () => {}, null)
  return {
    render: (value: React.ReactNode) => { renderer.flushSync(() => renderer.updateContainer(value, root, null, null)); renderer.flushPassiveEffects() },
    transition: (value: React.ReactNode) => React.startTransition(() => renderer.updateContainer(value, root, null, null)),
    flush: () => { renderer.flushSync(() => {}); renderer.flushPassiveEffects() },
  }
}

function createFakeRenderer() {
  let pixelRatio = 1
  const gl = {
    MAX_TEXTURE_SIZE: 0x0d33, MAX_RENDERBUFFER_SIZE: 0x84e8, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c, MAX_VIEWPORT_DIMS: 0x0d3a,
    RENDERBUFFER: 0x8d41, RGBA16F: 0x881a, DEPTH_COMPONENT24: 0x81a6, SAMPLES: 0x80a9,
    getParameter(parameter: number) { return parameter === this.MAX_VIEWPORT_DIMS ? [4096, 4096] : 4096 },
    getExtension() { return {} },
    getInternalformatParameter(_target: number, format: number) { return format === this.RGBA16F ? [4, 2] : [4, 2] },
  }
  return {
    getContext() { return gl }, capabilities: { isWebGL2: true, maxSamples: 4 },
    outputColorSpace: THREE.LinearSRGBColorSpace, toneMapping: THREE.LinearToneMapping, toneMappingExposure: 0.5,
    shadowMap: { enabled: true, type: THREE.BasicShadowMap }, getPixelRatio() { return pixelRatio }, setPixelRatio(value: number) { pixelRatio = value },
    render() {}, getRenderTarget() { return null }, setRenderTarget() {}, clear() {}, clearDepth() {},
  } as unknown as THREE.WebGLRenderer
}

function project(overrides: Partial<{ id: string; renderScale: number; antialiasing: 'off' | 'fxaa' | 'msaa'; activeGraphicsProfileId: string }> = {}): WorldProjectDocumentV1 {
  const profile = { id: overrides.id ?? 'graphics:mounted', name: 'Mounted', renderScale: overrides.renderScale ?? 1, shadowQuality: 'off' as const, antialiasing: overrides.antialiasing ?? 'fxaa' }
  return { schema: 'modly.world-project.v1', projectId: 'project:mounted', name: 'Mounted', revision: 1, resources: [], scenes: [], startSceneId: 'scene:one', inputActions: [], graphicsProfiles: [profile], activeGraphicsProfileId: overrides.activeGraphicsProfileId ?? profile.id }
}

function tree(module: MountedGraphicsModule, props: Partial<React.ComponentProps<typeof module.WorldViewportGraphics>> = {}, selection?: Iterable<THREE.Object3D>, fiberValue = { gl: createFakeRenderer(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), size: { width: 100, height: 100 }, setDpr: () => undefined }) {
  return React.createElement(module.__stub.FiberProvider, { value: fiberValue },
    React.createElement(module.__stub.SelectionProvider, { value: selection ? { selected: selection } : null },
      React.createElement(module.WorldViewportGraphics, { kind: 'editor', project: project(), ...props }),
    ),
  )
}

test('mounted adapter registers one positive-priority frame owner and survives StrictMode remount cleanup', async () => {
  const { module, cleanup } = await loadMountedModule()
  try {
    const host = mounted({ concurrent: true, strict: true })
    host.render(tree(module))
    assert.equal(module.__stub.frames.filter((frame) => frame.active).length, 1)
    assert.equal(module.__stub.frames.at(-1)?.priority, 1)
    host.render(null)
    assert.equal(module.__stub.frames.filter((frame) => frame.active).length, 0)
    assert.equal(module.__stub.composers.every((composer) => composer.disposed), true)
    host.render(tree(module))
    assert.equal(module.__stub.frames.filter((frame) => frame.active).length, 1)
  } finally { await cleanup() }
})

test('mounted adapter commits selection context and ignores stale frame callbacks after unmount', async () => {
  const { module, cleanup } = await loadMountedModule()
  try {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    const light = new THREE.DirectionalLight()
    const host = mounted()
    host.render(tree(module, {}, [mesh, light]))
    const frame = module.__stub.frames.find((candidate) => candidate.active)!
    frame.callback({}, 1 / 60)
    assert.deepEqual(module.__stub.outlines.at(-1)?.selectedObjects, [mesh])
    host.render(null)
    frame.callback({}, 1 / 60)
    assert.equal(module.__stub.frames.filter((candidate) => candidate.active).length, 0)
  } finally { await cleanup() }
})

test('mounted adapter clears resolved diagnostics and routes terminal render failure once', async () => {
  const { module, cleanup } = await loadMountedModule()
  try {
    const diagnostics: string[] = []
    const failures: unknown[] = []
    const host = mounted()
    const fiberValue = { gl: createFakeRenderer(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), size: { width: 100, height: 100 }, setDpr: () => undefined }
    host.render(tree(module, { project: project({ activeGraphicsProfileId: 'graphics:missing' }), onDiagnostic: (message) => diagnostics.push(message), onGraphicsFailure: (failure) => failures.push(failure) }, undefined, fiberValue))
    assert.match(diagnostics.at(-1) ?? '', /graphics:missing/)
    host.render(tree(module, { project: project(), onDiagnostic: (message) => diagnostics.push(message), onGraphicsFailure: (failure) => failures.push(failure) }, undefined, fiberValue))
    assert.equal(diagnostics.at(-1), '')
    setMountedRenderThrow('mounted composer failed')
    const frame = module.__stub.frames.find((candidate) => candidate.active)!
    frame.callback({}, 1 / 60)
    frame.callback({}, 1 / 60)
    clearMountedRenderThrow()
    assert.equal(failures.length, 1)
    assert.match(String((failures[0] as { message?: string }).message), /mounted composer failed/)
  } finally { await cleanup() }
})

test('abandoned concurrent render cannot replace committed failure callback refs', async () => {
  const { module, cleanup } = await loadMountedModule()
  try {
    const calls: string[] = []
    const host = mounted({ concurrent: true })
    const pending = new Promise<void>(() => {})
    function Suspender(): React.ReactNode { throw pending }
    const renderTree = (label: string, suspend = false) => React.createElement(React.Suspense, { fallback: React.createElement('aside') },
      tree(module, { onGraphicsFailure: () => calls.push(label) }),
      suspend ? React.createElement(Suspender) : null,
    )
    host.render(renderTree('committed'))
    host.transition(renderTree('abandoned', true))
    await new Promise((resolve) => setTimeout(resolve, 10))
    setMountedRenderThrow('abandoned callback check')
    module.__stub.frames.find((candidate) => candidate.active)!.callback({}, 1 / 60)
    clearMountedRenderThrow()
    assert.deepEqual(calls, ['committed'])
  } finally { await cleanup() }
})
