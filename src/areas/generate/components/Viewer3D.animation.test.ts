import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'

const require = createRequire(import.meta.url)
const THREE: typeof import('three') = require('three')
const reconciler = require('react-reconciler')
const projectRoot = path.resolve(import.meta.dirname, '../../../..')

// Mount the actual Viewer3D and toolbar with React's installed reconciler.
// Only the R3F renderer, asset loaders, and isolated splat renderer are doubles:
// mixers, actions, clips, scene objects, React effects and appStore are real.
// This checks CPU lifecycle/wiring, not GPU rendering or pointer-ray behavior.
type Host = { type: string; props: any; children: Host[] }
const hostContext = {}
const remove = (parent: Host, child: Host) => {
  const index = parent.children.indexOf(child)
  if (index >= 0) parent.children.splice(index, 1)
}
const renderer = reconciler({
  now: Date.now,
  supportsMutation: true,
  isPrimaryRenderer: false,
  getRootHostContext: () => hostContext,
  getChildHostContext: () => hostContext,
  getPublicInstance: (instance: Host) => instance,
  prepareForCommit: () => null,
  resetAfterCommit: () => undefined,
  createInstance: (type: string, props: any) => ({ type, props, children: [] }),
  createTextInstance: (text: string) => ({ type: '#text', props: { text }, children: [] }),
  appendInitialChild: (parent: Host, child: Host) => parent.children.push(child),
  appendChild: (parent: Host, child: Host) => { remove(parent, child); parent.children.push(child) },
  appendChildToContainer: (parent: Host, child: Host) => { remove(parent, child); parent.children.push(child) },
  removeChild: remove,
  removeChildFromContainer: remove,
  insertBefore: (parent: Host, child: Host, before: Host) => {
    remove(parent, child)
    parent.children.splice(parent.children.indexOf(before), 0, child)
  },
  insertInContainerBefore: (parent: Host, child: Host, before: Host) => {
    remove(parent, child)
    parent.children.splice(parent.children.indexOf(before), 0, child)
  },
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  prepareUpdate: () => true,
  commitUpdate: (instance: Host, _payload: unknown, _type: string, _old: unknown, props: any) => { instance.props = props },
  commitTextUpdate: (instance: Host, _old: string, text: string) => { instance.props.text = text },
  clearContainer: (container: Host) => { container.children = [] },
  detachDeletedInstance: () => undefined,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
})

function flush(callback: () => void) {
  renderer.flushSync(callback)
  for (let i = 0; i < 10; i++) {
    if (!renderer.flushPassiveEffects()) return
    renderer.flushSync(() => undefined)
  }
  assert.fail('Viewer effects did not settle')
}

function find(host: Host, predicate: (node: Host) => boolean): Host | undefined {
  if (predicate(host)) return host
  for (const child of host.children) {
    const match = find(child, predicate)
    if (match) return match
  }
}

const adapterSource = `
import { Children, createElement, useEffect, useRef, forwardRef } from 'react'
export const harness = { gltf: new Map(), obj: new Map(), frames: new Map(), cleared: [], loads: [], canvas: null, gizmos: [], lights: [], selections: [] }
export function Canvas(props) {
  harness.canvas = props
  harness.gizmos = []; harness.lights = []
  const children = Children.toArray(props.children).filter(child => {
    const name = child.type?.name
    if (['TranslateGizmo', 'RotateGizmo', 'ScaleGizmo'].includes(name)) { harness.gizmos.push(child.props); return false }
    if (name === 'PointLightMarker') { harness.lights.push(child.props); return false }
    return true
  })
  return createElement('test-canvas', null, children)
}
export function useFrame(callback) {
  const key = useRef({})
  const current = useRef(callback); current.current = callback
  useEffect(() => { harness.frames.set(key.current, delta => current.current({}, delta)); return () => harness.frames.delete(key.current) }, [])
}
export function useGLTF(url) { harness.loads.push(['gltf', url]); const asset = harness.gltf.get(url); if (!asset) throw new Error('Missing fixture ' + url); return asset }
useGLTF.clear = url => harness.cleared.push(['gltf', url])
export function useLoader(loader, url) { harness.loads.push([loader.name, url]); return harness.obj.get(url) }
useLoader.clear = (loader, url) => harness.cleared.push([loader.name, url])
export const useThree = () => ({ gl: { domElement: { toDataURL: () => 'data:image/png;base64,fixture' } } })
export const useGizmoContext = () => ({})
export const Environment = () => null
export const GizmoHelper = () => null
export const Lightformer = () => null
export const OrbitControls = props => createElement('test-orbit', props)
export const EffectComposer = props => createElement('test-composer', props, props.children)
export const Outline = props => createElement('test-outline', props)
export function Selection(props) { harness.selections.push(props.enabled); return createElement('test-selection', props, props.children) }
export const Select = props => createElement('test-select', props, props.children)
export default forwardRef(function SplatViewer(props, ref) { return createElement('test-splat', { ...props, ref: undefined }) })
`

async function mount(t: any, initialPath: string | null = '/animated.glb') {
  const directory = await mkdtemp(path.join(tmpdir(), 'modly-viewer-animation-'))
  const saved = new Map<string, PropertyDescriptor | undefined>()
  let unmount = () => undefined as void
  t.after(async () => {
    try {
      unmount()
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
  const events = new EventTarget()
  const storage = new Map<string, string>()
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }
  for (const [name, value] of Object.entries({
    window: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), localStorage },
    document: { activeElement: null },
    HTMLInputElement: class {},
    localStorage,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const outfile = path.join(directory, 'viewer.mjs')
  await build({
    stdin: {
      contents: `export { default as Viewer3D } from './src/areas/generate/components/Viewer3D'; export { useAppStore } from './src/shared/stores/appStore'; export { harness } from '@react-three/fiber'`,
      resolveDir: projectRoot,
      loader: 'tsx',
    },
    outfile, bundle: true, format: 'esm', platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [{
      name: 'cpu-viewer-adapters',
      setup(builder) {
        builder.onResolve({ filter: /^(@react-three\/(fiber|drei|postprocessing)|\.\/SplatViewer)$/ }, () => ({ path: 'adapters', namespace: 'fixture' }))
        builder.onLoad({ filter: /^adapters$/, namespace: 'fixture' }, () => ({ contents: adapterSource, loader: 'js', resolveDir: projectRoot }))
        builder.onResolve({ filter: /^@shared\/hooks\/useGeneration$/ }, () => ({ path: 'generation', namespace: 'fixture' }))
        builder.onLoad({ filter: /^generation$/, namespace: 'fixture' }, () => ({
          contents: `import { useAppStore } from ${JSON.stringify(path.join(projectRoot, 'src/shared/stores/appStore.ts'))}; export const useGeneration = () => ({ currentJob: useAppStore(s => s.currentJob) })`,
          loader: 'js', resolveDir: projectRoot,
        }))
        // Bundle the real import entry, not the installed self-requiring UMD.
        // Bare Three stays external below so fixtures and BVH share constructors.
        builder.onResolve({ filter: /^three-mesh-bvh$/ }, () => ({ path: fileURLToPath(import.meta.resolve('three-mesh-bvh')) }))
        builder.onResolve({ filter: /^(react(?:\/.*)?|three(?:\/.*)?|zustand(?:\/.*)?)$/ }, args => ({ path: require.resolve(args.path), external: true }))
      },
    }],
  })
  const { Viewer3D, useAppStore, harness } = await import(pathToFileURL(outfile).href)
  const mixers: import('three').AnimationMixer[] = []
  const uncached: import('three').Object3D[] = []
  const originalClipAction = THREE.AnimationMixer.prototype.clipAction
  const originalUncache = THREE.AnimationMixer.prototype.uncacheRoot
  t.mock.method(THREE.AnimationMixer.prototype, 'clipAction', function (this: import('three').AnimationMixer, ...args: Parameters<typeof originalClipAction>) {
    if (!mixers.includes(this)) mixers.push(this)
    return originalClipAction.apply(this, args)
  })
  t.mock.method(THREE.AnimationMixer.prototype, 'uncacheRoot', function (this: import('three').AnimationMixer, root: import('three').Object3D) {
    uncached.push(root)
    return originalUncache.call(this, root)
  })
  const clip = new THREE.AnimationClip('Move', 1, [new THREE.NumberKeyframeTrack('AnimatedMesh.position[x]', [0, 1], [0, 10])])
  function asset(url: string, animations = [clip]) {
    const scene = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    mesh.name = 'AnimatedMesh'
    scene.add(mesh)
    harness.gltf.set(url, { scene, animations })
    return { scene, mesh }
  }
  const first = asset('/animated.glb')
  const host: Host = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(host, 0, null, false, null, '', (error: unknown) => { throw error }, null)
  const undo = { current: null as (() => boolean) | null }
  const pointSelections: (string | null)[] = []
  const lightChanges: unknown[] = []
  const props = { gizmoMode: 'translate', gizmoUndoRef: undo, pointLights: [{ id: 'light', position: [1, 2, 3], color: '#ffffff', intensity: 1 }], onSelectPointLight: (id: string | null) => pointSelections.push(id), onPointLightsChange: (lights: unknown) => lightChanges.push(lights) }
  const job = (url: string | null) => useAppStore.getState().setCurrentJob(url ? { id: url, status: 'done', outputUrl: url, imageFile: '', progress: 100, createdAt: 0 } : null)
  useAppStore.setState({ apiUrl: '' })
  job(initialPath)
  const render = () => flush(() => renderer.updateContainer(createElement(Viewer3D, props), root, null))
  unmount = () => flush(() => renderer.updateContainer(null, root, null))
  render()
  const node = (type: string) => find(host, entry => entry.type === type)
  const button = (label: string) => {
    const result = find(host, entry => entry.type === 'button' && entry.props.title === label)
    assert.ok(result, `Missing button ${label}`)
    return result
  }
  const click = (label: string) => flush(() => button(label).props.onClick())
  const switchTo = (url: string | null) => flush(() => job(url))
  const frame = (delta: number) => { for (const callback of harness.frames.values()) (callback as (delta: number) => void)(delta) }
  return { harness, host, node, button, click, switchTo, frame, render, unmount, asset, first, clip, mixers, uncached, useAppStore, undo, pointSelections, lightChanges }
}

test('Viewer3D mounts animated GLTF paused, plays and resumes the same real mixer without losing shared selection or gizmo undo', async t => {
  const view = await mount(t)
  assert.equal(view.button('Play animation').props.disabled, false)
  assert.equal(view.mixers.length, 1)
  view.frame(0.25)
  assert.equal(view.first.mesh.position.x, 0)
  view.click('Play animation')
  view.frame(0.25)
  assert.equal(view.first.mesh.position.x, 2.5)
  view.click('Pause animation')
  view.frame(0.25)
  assert.equal(view.first.mesh.position.x, 2.5)
  view.click('Play animation')
  view.frame(0.25)
  assert.equal(view.first.mesh.position.x, 5)
  assert.equal(view.mixers.length, 1)
  flush(() => view.node('primitive')!.props.onClick({ stopPropagation() {} }))
  assert.equal(view.useAppStore.getState().meshSelected, true)
  assert.equal(view.node('test-selection')!.props.enabled, true)
  assert.equal(view.node('test-outline')!.props.edgeStrength, 2.5)
  assert.deepEqual(view.pointSelections, [null])
  const gizmo = view.harness.gizmos[0]
  const before = view.first.scene.position.clone()
  gizmo.onDragStart()
  view.first.scene.position.x += 3
  gizmo.onDragEnd()
  assert.equal(view.undo.current?.(), true)
  assert.ok(view.first.scene.position.equals(before))
  assert.equal(view.undo.current?.(), false)
  flush(() => view.harness.lights[0].onSelect())
  assert.equal(view.useAppStore.getState().meshSelected, false)
  assert.equal(view.pointSelections.at(-1), 'light')
  flush(() => view.harness.lights[0].onPositionChange([4, 5, 6]))
  assert.deepEqual((view.lightChanges[0] as any[])[0].position, [4, 5, 6])
  view.click('Wireframe')
  assert.ok(view.first.mesh.material instanceof THREE.MeshBasicMaterial)
  assert.equal(view.first.mesh.material.wireframe, true)
  view.click('Auto-rotate')
  assert.equal(view.node('test-orbit')!.props.autoRotate, true)
  assert.ok(view.button('Screenshot'))
})

test('Viewer3D replaces GLTF mixers, resets playback, releases old bindings and does not animate clipless or OBJ assets', async t => {
  const view = await mount(t)
  view.click('Play animation')
  view.frame(0.25)
  const clips = view.harness.gltf.get('/animated.glb').animations
  const next = view.asset('/next.glb', clips)
  flush(() => view.node('primitive')!.props.onClick({ stopPropagation() {} }))
  view.harness.gizmos[0].onDragStart()
  view.first.scene.position.x += 3
  view.harness.gizmos[0].onDragEnd()
  view.switchTo('/next.glb')
  assert.equal(view.useAppStore.getState().meshSelected, false)
  assert.equal(view.undo.current?.(), false)
  assert.equal(view.mixers.length, 2)
  assert.deepEqual(view.uncached, [view.first.scene])
  assert.equal(view.mixers[0].existingAction(view.clip), null)
  assert.equal(view.first.mesh.position.x, 0)
  assert.ok(view.button('Play animation'))
  view.frame(0.25)
  assert.equal(next.mesh.position.x, 0)
  view.click('Play animation')
  view.frame(0.25)
  assert.equal(next.mesh.position.x, 2.5)
  view.asset('/still.glb', [])
  view.switchTo('/still.glb')
  assert.equal(view.button('No animation clips').props.disabled, true)
  assert.equal(view.mixers.length, 2)
  assert.equal(view.mixers[1].existingAction(view.clip), null)
  const obj = view.asset('/mesh.OBJ?version=1', []).scene
  view.harness.obj.set('/mesh.OBJ?version=1', obj)
  view.switchTo('/mesh.OBJ?version=1')
  assert.equal(view.node('primitive')!.props.object, obj)
  assert.ok(view.harness.loads.some(([loader, url]: string[]) => loader === 'OBJLoader' && url === '/mesh.OBJ?version=1'))
  assert.equal(view.button('No animation clips').props.disabled, true)
  assert.equal(view.harness.frames.size, 0)
  view.switchTo(null)
  assert.equal(view.node('primitive'), undefined)
  assert.equal(find(view.host, entry => entry.type === 'button'), undefined)
  assert.ok(view.harness.cleared.some(([loader, url]: string[]) => loader === 'OBJLoader' && url === '/mesh.OBJ?version=1'))
  assert.equal(view.undo.current?.(), false)
})

test('Viewer3D resets the mixer when a loader replaces the scene or clips at the same URL', async t => {
  const view = await mount(t)
  view.click('Play animation')
  view.frame(0.25)
  const clips = view.harness.gltf.get('/animated.glb').animations
  const next = view.asset('/animated.glb', clips)
  view.render()
  assert.equal(view.mixers.length, 2)
  assert.equal(view.mixers[0].existingAction(view.clip), null)
  assert.equal(view.harness.frames.size, 1)
  assert.ok(view.button('Play animation'))
  view.frame(0.25)
  assert.equal(next.mesh.position.x, 0)
  view.click('Play animation')
  view.frame(0.25)
  assert.equal(next.mesh.position.x, 2.5)
  view.harness.gltf.set('/animated.glb', { scene: next.scene, animations: [] })
  view.render()
  assert.equal(view.button('No animation clips').props.disabled, true)
  assert.equal(view.mixers[1].existingAction(view.clip), null)
  view.frame(0.25)
  assert.equal(next.mesh.position.x, 0)
})

test('Viewer3D keeps splats isolated, disables animation, and resets a later mesh to paused', async t => {
  const view = await mount(t)
  view.click('Play animation')
  view.frame(0.25)
  view.switchTo('/workspace/scan.ply')
  assert.equal(view.node('test-canvas'), undefined)
  assert.equal(view.node('test-splat')!.props.url, '/optimize/ply-to-splat?path=scan.ply')
  assert.equal(view.button('No animation clips').props.disabled, true)
  assert.equal(find(view.host, entry => entry.props.title === 'Wireframe'), undefined)
  assert.equal(view.harness.frames.size, 0)
  assert.equal(view.mixers[0].existingAction(view.clip), null)
  view.switchTo('/scan.splat')
  assert.equal(view.node('test-splat')!.props.url, '/scan.splat')
  view.asset('/returned.glb')
  view.switchTo('/returned.glb')
  assert.ok(view.button('Play animation'))
  assert.equal(view.node('test-splat'), undefined)
})

test('Viewer3D clears actions, loader cache, scene resources, frame subscription, shared selection and undo ref on unmount', async t => {
  const view = await mount(t, null)
  assert.equal(view.mixers.length, 0)
  view.switchTo('/animated.glb')
  assert.ok(view.button('Play animation'))
  view.click('Play animation')
  view.frame(0.25)
  flush(() => view.node('primitive')!.props.onClick({ stopPropagation() {} }))
  const geometryDisposed = t.mock.method(view.first.mesh.geometry, 'dispose')
  const materialDisposed = t.mock.method(view.first.mesh.material, 'dispose')
  view.unmount()
  assert.equal(view.harness.frames.size, 0)
  assert.equal(view.mixers[0].existingAction(view.clip), null)
  assert.deepEqual(view.uncached, [view.first.scene])
  assert.equal(view.first.mesh.position.x, 0)
  assert.ok(view.harness.cleared.some(([loader, url]: string[]) => loader === 'gltf' && url === '/animated.glb'))
  assert.equal(geometryDisposed.mock.callCount(), 1)
  assert.equal(materialDisposed.mock.callCount(), 1)
  assert.equal(view.useAppStore.getState().meshSelected, false)
  assert.equal(view.undo.current, null)
})
