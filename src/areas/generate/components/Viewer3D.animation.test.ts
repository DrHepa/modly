import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'

const require = createRequire(import.meta.url)
// Preload the canonical Node transport before installing inert browser globals.
const axios = require('axios')
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
export function useFrame(callback, priority = 0) {
  const key = useRef({})
  const current = useRef(callback); current.current = callback
  useEffect(() => { const frame = delta => current.current({}, delta); frame.priority = priority; harness.frames.set(key.current, frame); return () => harness.frames.delete(key.current) }, [priority])
}
export function useGLTF(url) { harness.loads.push(['gltf', url]); const asset = harness.gltf.get(url); if (!asset) throw new Error('Missing fixture ' + url); return asset }
useGLTF.clear = url => harness.cleared.push(['gltf', url])
export function useLoader(loader, url) { harness.loads.push([loader.name, url]); return harness.obj.get(url) }
useLoader.clear = (loader, url) => harness.cleared.push([loader.name, url])
export const useThree = () => ({ gl: { domElement: { toDataURL: () => 'data:image/png;base64,fixture', getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } } })
export const useGizmoContext = () => ({})
export const Environment = () => null
export const GizmoHelper = () => null
export const Lightformer = () => null
export const Html = props => createElement('test-html', props, props.children)
export const OrbitControls = props => createElement('test-orbit', props)
export const EffectComposer = props => createElement('test-composer', props, props.children)
export const Outline = props => createElement('test-outline', props)
export function Selection(props) { harness.selections.push(props.enabled); return createElement('test-selection', props, props.children) }
export const Select = props => createElement('test-select', props, props.children)
export default forwardRef(function SplatViewer(props, ref) { return createElement('test-splat', { ...props, ref: undefined }) })
`

async function mount(t: any, initialPath: string | null = '/animated.glb', initialise?: (harness: any) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), 'modly-viewer-animation-'))
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const requests: unknown[] = []
  const originalAdapter = axios.defaults.adapter
  axios.defaults.adapter = async (request: unknown) => { requests.push(request); throw new Error('Unexpected transport request') }
  let unmount = () => undefined as void
  t.after(async () => {
    try {
      unmount()
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
      axios.defaults.adapter = originalAdapter
      await rm(directory, { recursive: true, force: true })
      assert.deepEqual(requests, [], 'No network request may leave the CPU harness')
    }
  })
  const events = new EventTarget()
  const storage = new Map<string, string>()
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }
  for (const [name, value] of Object.entries({
    window: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), setInterval, clearInterval, localStorage },
    document: { activeElement: null, hasFocus: () => true },
    HTMLInputElement: class {},
    localStorage,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const outfile = path.join(directory, 'viewer.mjs')
  await build({
    stdin: {
      contents: `export * from './src/areas/generate/components/Viewer3D'; export { default as Viewer3D } from './src/areas/generate/components/Viewer3D'; export { useAppStore } from './src/shared/stores/appStore'; export { useWorkflowRunStore } from './src/areas/workflows/workflowRunStore'; export { harness } from '@react-three/fiber'`,
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
        builder.onResolve({ filter: /^(react(?:\/.*)?|three(?:\/.*)?|axios|zustand(?:\/.*)?)$/ }, args => ({ path: require.resolve(args.path), external: true }))
      },
    }],
  })
  const viewerModule = await import(pathToFileURL(outfile).href)
  const { Viewer3D, useAppStore, useWorkflowRunStore, harness } = viewerModule
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
  initialise?.(harness)
  if (harness.electron) window.electron = harness.electron
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
  const component = (name: string): any => {
    const walk = (fiber: any): any => {
      if (!fiber) return undefined
      if (fiber.type?.name === name) return fiber.memoizedProps
      return walk(fiber.child) ?? walk(fiber.sibling)
    }
    const props = walk(root.current)
    assert.ok(props, `Missing mounted component ${name}`)
    return props
  }
  const node = (type: string) => find(host, entry => entry.type === type)
  const button = (label: string) => {
    const result = find(host, entry => entry.type === 'button' && entry.props.title === label)
    assert.ok(result, `Missing button ${label}`)
    return result
  }
  const click = (label: string) => flush(() => button(label).props.onClick())
  const switchTo = (url: string | null) => flush(() => job(url))
  const frame = (delta: number) => { for (const callback of [...harness.frames.values()].sort((a: any, b: any) => a.priority - b.priority)) (callback as (delta: number) => void)(delta) }
  return { harness, host, node, component, viewerModule, button, click, switchTo, frame, render, unmount, asset, first, clip, mixers, uncached, useAppStore, useWorkflowRunStore, undo, pointSelections, lightChanges }
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


function rigAsset(harness: any, url = '/rig.glb') {
  const scene = new THREE.Group()
  const parent = new THREE.Group()
  parent.position.set(3, 2, -1)
  parent.rotation.set(0.2, 0.4, 0.1)
  parent.scale.set(1, 2, 0.5)
  scene.add(parent)
  const root = new THREE.Bone()
  root.name = 'RigRoot'
  const tip = new THREE.Bone()
  tip.name = 'RigTip'
  tip.position.set(0, 1, 0)
  root.add(tip)
  parent.add(root)
  const skeleton = new THREE.Skeleton([root, tip])
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0], 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 0.3, 0.7, 0, 0, 0.5, 0.5, 0, 0], 4))
  const colors = new THREE.Float32BufferAttribute([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], 3)
  geometry.setAttribute('color', colors)
  geometry.addGroup(0, 3, 0)
  const materials = [new THREE.MeshStandardMaterial({ vertexColors: true }), new THREE.MeshBasicMaterial()]
  const first = new THREE.SkinnedMesh(geometry, materials)
  const second = new THREE.SkinnedMesh(geometry, materials)
  const backdrop = new THREE.Mesh(geometry, materials)
  parent.add(first, second, backdrop)
  scene.updateMatrixWorld(true)
  first.bind(skeleton)
  second.bind(skeleton)
  const clip = new THREE.AnimationClip('Bend', 1, [new THREE.NumberKeyframeTrack('RigTip.position[x]', [0, 1], [0, 2])])
  harness.gltf.set(url, { scene, animations: [clip] })
  return { scene, parent, root, tip, skeleton, geometry, colors, materials, first, second, backdrop, clip }
}

function rigOverlay(view: Awaited<ReturnType<typeof mount>>) {
  const node = find(view.host, entry => entry.type === 'primitive' && entry.props.object.name === 'RigInspectionOverlay')
  assert.ok(node, 'Missing mounted rig overlay')
  return node.props.object as import('three').Group
}

function singleMaterial(mesh: import('three').Mesh | import('three').LineSegments): import('three').Material {
  assert.ok(!Array.isArray(mesh.material))
  return mesh.material
}

function disposeCounts(t: any, objects: { dispose: () => void }[]) {
  return objects.map(object => t.mock.method(object, 'dispose'))
}

function overlayResources(overlay: import('three').Group) {
  return overlay.children.flatMap(child => {
    const mesh = child as import('three').Mesh
    return [mesh.geometry, ...(Array.isArray(mesh.material) ? mesh.material : [mesh.material])]
  })
}

test('Viewer3D reports mounted rig capability without a parent reset race and gates plain GLTF, OBJ and splats', async t => {
  const view = await mount(t, '/rig.glb', harness => rigAsset(harness))
  assert.equal(view.button('Rig bones').props.disabled, false)
  assert.equal(view.button('Rig joints').props.disabled, false)
  assert.equal(view.button('Bone influence').props.disabled, false)
  assert.ok(view.button('Play animation'))
  view.click('Rig joints')
  assert.equal(rigOverlay(view).children.filter(child => child instanceof THREE.Mesh).length, 2)
  view.asset('/rig.glb', [])
  view.render()
  assert.equal(view.button('Rig bones (rig only)').props.disabled, true)
  assert.equal(find(view.host, entry => entry.type === 'primitive' && entry.props.object.name === 'RigInspectionOverlay'), undefined)
  const obj = view.asset('/plain.obj', []).scene
  view.harness.obj.set('/plain.obj', obj)
  view.switchTo('/plain.obj')
  assert.equal(view.button('Rig joints (rig only)').props.disabled, true)
  view.switchTo('/scan.splat')
  assert.equal(find(view.host, entry => /^(Rig bones|Rig joints|Bone influence)/.test(entry.props.title ?? '')), undefined)
  view.switchTo(null)
  assert.equal(view.harness.frames.size, 0)
})

test('Viewer3D owns influence clones, preserves source colors and material arrays, and disposes transient resources', async t => {
  let rig!: ReturnType<typeof rigAsset>
  const view = await mount(t, '/rig.glb', harness => { rig = rigAsset(harness) })
  const sourceDisposals = disposeCounts(t, [rig.geometry, ...rig.materials])
  const originalColors = Array.from(rig.colors.array)
  view.click('Bone influence')
  const influenceGeometry = rig.first.geometry
  assert.notEqual(influenceGeometry, rig.geometry)
  assert.notEqual(rig.second.geometry, rig.geometry)
  assert.equal(rig.backdrop.geometry, rig.geometry, 'Unskinned shared geometry is not recolored')
  assert.equal(rig.geometry.getAttribute('color'), rig.colors)
  assert.deepEqual(Array.from(rig.colors.array), originalColors)
  assert.notDeepEqual(Array.from(influenceGeometry.getAttribute('color').array), originalColors)
  const overlay = rigOverlay(view)
  assert.equal(rig.scene.getObjectByName('RigInspectionOverlay'), undefined, 'Helpers stay outside source stats/BVH/selection')
  const selection = view.node('test-select')!
  assert.equal(find(selection, entry => entry.props.object === overlay), undefined)
  assert.ok(overlay.children.every(child => !('boundsTree' in (child as any).geometry)))
  const hits: any[] = []
  for (const child of overlay.children) child.raycast(new THREE.Raycaster(), hits)
  assert.equal(hits.length, 0, 'Helpers cannot be picked as source meshes')
  const transientDisposals = disposeCounts(t, [influenceGeometry, rig.second.geometry, singleMaterial(rig.first), singleMaterial(rig.second), singleMaterial(rig.backdrop), ...overlayResources(overlay)])
  view.click('Solid')
  assert.equal(rig.first.geometry, rig.geometry)
  assert.equal(rig.second.geometry, rig.geometry)
  assert.equal(rig.first.material, rig.materials)
  assert.equal(rig.backdrop.material, rig.materials)
  assert.equal(rig.geometry.getAttribute('color'), rig.colors)
  assert.ok(transientDisposals.every(spy => spy.mock.callCount() === 1))
  assert.ok(sourceDisposals.every(spy => spy.mock.callCount() === 0))
  view.click('Bone influence')
  const unmountDisposals = disposeCounts(t, [rig.first.geometry, rig.second.geometry, singleMaterial(rig.first), singleMaterial(rig.second), singleMaterial(rig.backdrop), ...overlayResources(rigOverlay(view))])
  view.unmount()
  assert.equal(rig.first.geometry, rig.geometry)
  assert.equal(rig.first.material, rig.materials)
  assert.equal(rig.geometry.getAttribute('color'), rig.colors)
  assert.ok(unmountDisposals.every(spy => spy.mock.callCount() === 1))
  assert.ok(sourceDisposals.every(spy => spy.mock.callCount() === 1))
  assert.equal(view.mixers[0].existingAction(rig.clip), null)
  assert.equal(view.harness.frames.size, 0)
})

test('Viewer3D source-local segments and unique joints follow transformed animated bones after mixer updates and pause', async t => {
  let rig!: ReturnType<typeof rigAsset>
  const view = await mount(t, '/rig.glb', harness => { rig = rigAsset(harness) })
  view.click('Rig joints')
  const overlay = rigOverlay(view)
  const helper = overlay.children.find(child => child instanceof THREE.LineSegments && !(child instanceof THREE.SkeletonHelper)) as import('three').LineSegments
  assert.ok(helper, 'Rig overlays use owned line segments, not hierarchy-traversing SkeletonHelper')
  const commonParent = new THREE.Group()
  const selectionGroup = new THREE.Group()
  commonParent.add(selectionGroup, overlay)
  selectionGroup.add(rig.scene)
  commonParent.position.set(3, -1, 5)
  commonParent.rotation.set(0.3, 0.5, -0.2)
  commonParent.scale.set(0.7, 1.6, -1.2)
  assert.equal(overlay.children.filter(child => child instanceof THREE.Mesh).length, 2, 'Shared bones receive one marker each')
  rig.scene.position.set(8, -2, 3)
  rig.scene.rotation.set(0.3, -0.7, 0.2)
  rig.scene.scale.set(-2, 0.5, 1.2)
  rig.scene.updateMatrix()
  rig.scene.matrixAutoUpdate = false
  const originalPositions = helper.geometry.getAttribute('position')
  const checkAlignment = () => {
    const tipWorld = rig.tip.getWorldPosition(new THREE.Vector3())
    const positions = helper.geometry.getAttribute('position')
    assert.equal(positions, originalPositions, 'Frames update the existing position buffer')
    assert.equal(positions.count, 2)
    const start = new THREE.Vector3().fromBufferAttribute(positions, 0).applyMatrix4(helper.matrixWorld)
    assert.ok(start.distanceTo(rig.root.getWorldPosition(new THREE.Vector3())) < 1e-5)
    const endpoint = new THREE.Vector3().fromBufferAttribute(positions, 1).applyMatrix4(helper.matrixWorld)
    assert.ok(endpoint.distanceTo(tipWorld) < 1e-5, `Skeleton endpoint ${endpoint.toArray()} vs ${tipWorld.toArray()}`)
    const markers = overlay.children.filter(child => child instanceof THREE.Mesh)
    assert.ok(markers.some(marker => marker.getWorldPosition(new THREE.Vector3()).distanceTo(tipWorld) < 1e-6))
  }
  view.frame(0)
  checkAlignment()
  view.click('Play animation')
  view.frame(0.25)
  assert.equal(rig.tip.position.x, 0.5)
  checkAlignment()
  view.click('Pause animation')
  commonParent.position.x += 4
  commonParent.rotation.z += 0.4
  rig.scene.matrix.setPosition(-3, 2, 1)
  view.frame(0.25)
  assert.equal(rig.tip.position.x, 0.5)
  checkAlignment()
  const disposals = disposeCounts(t, overlayResources(overlay))
  const next = rigAsset(view.harness, '/next-rig.glb')
  view.switchTo('/next-rig.glb')
  assert.ok(disposals.every(spy => spy.mock.callCount() === 1))
  assert.equal(overlay.children.length, 0)
  assert.equal(view.mixers[0].existingAction(rig.clip), null)
  assert.ok(view.button('Play animation'))
  view.frame(0.25)
  assert.equal(next.tip.position.x, 0)
})

test('Viewer3D rig helpers do not contaminate source mesh statistics on same-URL scene replacement', async t => {
  const view = await mount(t, '/rig.glb', harness => rigAsset(harness))
  view.click('Rig joints')
  const next = rigAsset(view.harness)
  view.render()
  assert.deepEqual(view.useAppStore.getState().meshStats, { vertices: 9, triangles: 3 })
  view.click('Rig bones')
  assert.equal(rigOverlay(view).children.filter(child => child instanceof THREE.Mesh).length, 0)
  assert.deepEqual(view.useAppStore.getState().meshStats, { vertices: 9, triangles: 3 })
  assert.equal(next.scene.getObjectByName('RigInspectionOverlay'), undefined)
})


test('Viewer3D restores absent colors and disposes influence geometry on same-source replacement and later source changes', async t => {
  let rig!: ReturnType<typeof rigAsset>
  const view = await mount(t, '/rig.glb', harness => {
    rig = rigAsset(harness)
    rig.geometry.deleteAttribute('color')
  })
  view.click('Bone influence')
  assert.equal(rig.geometry.getAttribute('color'), undefined)
  const clones = disposeCounts(t, [rig.first.geometry, rig.second.geometry])
  view.click('Wireframe')
  assert.ok(clones.every(spy => spy.mock.callCount() === 1))
  assert.equal(rig.first.geometry, rig.geometry)
  assert.equal(rig.geometry.getAttribute('color'), undefined)
  const wireframe = disposeCounts(t, [singleMaterial(rig.first), singleMaterial(rig.second), singleMaterial(rig.backdrop)])
  view.click('Bone influence')
  assert.ok(wireframe.every(spy => spy.mock.callCount() === 1))
  const oldMode = disposeCounts(t, [rig.first.geometry, rig.second.geometry, singleMaterial(rig.first), singleMaterial(rig.second), singleMaterial(rig.backdrop), ...overlayResources(rigOverlay(view))])
  rigAsset(view.harness)
  view.render()
  assert.ok(oldMode.every(spy => spy.mock.callCount() === 1))
  assert.equal(rig.first.material, rig.materials)
  assert.equal(rig.first.geometry, rig.geometry)
  assert.equal(rig.geometry.getAttribute('color'), undefined)
  view.click('Bone influence')
  const current = view.harness.gltf.get('/rig.glb').scene
  const sourceMeshes: import('three').Mesh[] = []
  current.traverse((child: import('three').Object3D) => { if (child instanceof THREE.Mesh) sourceMeshes.push(child) })
  const nextMode = disposeCounts(t, [...sourceMeshes.map(singleMaterial), ...sourceMeshes.filter(mesh => mesh instanceof THREE.SkinnedMesh).map(mesh => mesh.geometry), ...overlayResources(rigOverlay(view))])
  view.switchTo('/scan.splat')
  assert.ok(nextMode.every(spy => spy.mock.callCount() === 1))
  assert.equal(view.harness.frames.size, 0)
})

test('Viewer3D releases mode-owned matcap and checker textures without disposing source materials on mode changes', async t => {
  const view = await mount(t)
  // Canvas pixels are not rendered; these are only texture ownership checks.
  ;(globalThis.document as any).createElement = () => ({
    width: 0, height: 0,
    getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: '' }),
  })
  view.click('Matcap')
  const matcap = view.first.mesh.material as unknown as import('three').MeshMatcapMaterial
  const matcapDisposals = disposeCounts(t, [matcap, matcap.matcap!])
  view.click('UV Checker')
  assert.ok(matcapDisposals.every(spy => spy.mock.callCount() === 1))
  const checker = view.first.mesh.material as unknown as import('three').MeshBasicMaterial
  const checkerDisposals = disposeCounts(t, [checker, checker.map!])
  view.unmount()
  assert.ok(checkerDisposals.every(spy => spy.mock.callCount() === 1))
})


test('Viewer3D draws only unique skeleton-member edges across roots and detached references', async t => {
  let rig!: ReturnType<typeof rigAsset>
  const detachedParent = new THREE.Bone()
  const detachedChild = new THREE.Bone()
  detachedChild.position.set(0, 2, 0)
  detachedParent.add(detachedChild)
  const externalHost = new THREE.Group()
  externalHost.add(detachedParent)
  externalHost.position.set(4, -2, 3)
  externalHost.rotation.set(0.5, -0.2, 0.3)
  const foreignParent = new THREE.Bone()
  const memberWithForeignParent = new THREE.Bone()
  memberWithForeignParent.position.set(1, 3, 1)
  foreignParent.add(memberWithForeignParent)
  externalHost.add(foreignParent)
  const isolatedRoot = new THREE.Bone()
  const view = await mount(t, '/rig.glb', harness => {
    rig = rigAsset(harness)
    const unlistedChild = new THREE.Bone()
    rig.tip.add(unlistedChild)
    rig.parent.add(isolatedRoot)
    rig.skeleton.bones.push(detachedParent, detachedChild, memberWithForeignParent, isolatedRoot)
    externalHost.updateMatrixWorld(true)
    rig.skeleton.calculateInverses()
  })
  view.click('Rig joints')
  const overlay = rigOverlay(view)
  const line = overlay.children.find(child => child instanceof THREE.LineSegments && !(child instanceof THREE.SkeletonHelper)) as import('three').LineSegments
  assert.ok(line)
  const positions = line.geometry.getAttribute('position')
  assert.equal(positions.count, 4, 'Exactly two member-to-member edges, not foreign parent or unlisted descendant links')
  const markers = overlay.children.filter(child => child instanceof THREE.Mesh)
  assert.equal(markers.length, 6, 'Shared skeleton members are unique, including isolated and foreign-parent members')
  const check = () => {
    const expected = [rig.root, rig.tip, detachedParent, detachedChild]
    expected.forEach((bone, index) => {
      const actual = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(line.matrixWorld)
      assert.ok(actual.distanceTo(bone.getWorldPosition(new THREE.Vector3())) < 1e-5)
    })
    const memberWorld = memberWithForeignParent.getWorldPosition(new THREE.Vector3())
    assert.ok(markers.some(marker => marker.getWorldPosition(new THREE.Vector3()).distanceTo(memberWorld) < 1e-5))
  }
  view.frame(0)
  check()
  externalHost.position.x += 3
  detachedParent.rotation.z = 0.7
  detachedChild.position.y = 4
  view.frame(0)
  check()
  assert.equal(line.geometry.getAttribute('position'), positions)
  assert.equal(overlay.children.filter(child => child instanceof THREE.LineSegments).length, 1)
  const resources = disposeCounts(t, overlayResources(overlay))
  view.switchTo('/animated.glb')
  assert.ok(resources.every(spy => spy.mock.callCount() === 1))
  assert.equal(overlay.children.length, 0)
})

test('Viewer3D rig shells and overlays use translucent depth flags and restore owned resources across modes and teardown', async t => {
  let rig!: ReturnType<typeof rigAsset>
  const view = await mount(t, '/rig.glb', harness => { rig = rigAsset(harness) })
  const sourceDisposals = disposeCounts(t, [rig.geometry, ...rig.materials])
  const originalFlags = rig.materials.map(material => ({ transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite }))
  for (const mode of ['Rig bones', 'Rig joints', 'Bone influence']) {
    view.click(mode)
    const overlay = rigOverlay(view)
    const line = overlay.children.find(child => child instanceof THREE.LineSegments) as import('three').LineSegments
    const lineMaterial = singleMaterial(line)
    assert.equal(lineMaterial.depthTest, false)
    assert.equal(lineMaterial.depthWrite, false)
    assert.equal(lineMaterial.transparent, true)
    assert.equal(lineMaterial.opacity, mode === 'Bone influence' ? 0.72 : 0.98)
    assert.equal(line.frustumCulled, false)
    assert.equal(line.renderOrder, 4)
    for (const marker of overlay.children.filter(child => child instanceof THREE.Mesh)) {
      assert.equal(singleMaterial(marker).depthTest, false)
      assert.equal(singleMaterial(marker).depthWrite, false)
      assert.equal(marker.frustumCulled, false)
      assert.equal(marker.renderOrder, 5)
    }
    for (const mesh of [rig.first, rig.second, rig.backdrop]) {
      const material = singleMaterial(mesh)
      assert.equal(material.transparent, true)
      assert.equal(material.depthWrite, false)
      assert.equal(material.depthTest, true)
      assert.equal(material.side, THREE.DoubleSide)
      assert.equal(material.opacity, mode === 'Bone influence' ? (mesh === rig.backdrop ? 0.18 : 0.84) : 0.28)
    }
    assert.equal(rig.geometry.getAttribute('color'), rig.colors)
    assert.deepEqual(rig.materials.map(material => ({ transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite })), originalFlags)
    const owned = [singleMaterial(rig.first), singleMaterial(rig.second), singleMaterial(rig.backdrop), ...overlayResources(overlay)]
    if (mode === 'Bone influence') owned.push(rig.first.geometry, rig.second.geometry)
    const disposals = disposeCounts(t, owned)
    if (mode === 'Bone influence') view.unmount()
    else view.click('Solid')
    assert.ok(disposals.every(spy => spy.mock.callCount() === 1))
    assert.equal(rig.first.material, rig.materials)
    assert.equal(rig.first.geometry, rig.geometry)
    assert.ok(sourceDisposals.every(spy => spy.mock.callCount() === (mode === 'Bone influence' ? 1 : 0)))
  }
})

function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function settle() {
  for (let index = 0; index < 8; index++) { await Promise.resolve(); flush(() => undefined) }
}

function authoringAsset(harness: any, url = '/workspace/rig.glb') {
  const scene = new THREE.Group()
  const root = new THREE.Bone(); root.name = 'root'
  const child = new THREE.Bone(); child.name = 'child'; child.position.y = 1; root.add(child)
  const geometry = new THREE.BoxGeometry()
  const count = geometry.getAttribute('position').count
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4))
  const weights = new Float32Array(count * 4)
  for (let index = 0; index < count; index++) weights[index * 4] = 1
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial())
  mesh.name = 'body'; scene.add(root, mesh)
  mesh.bind(new THREE.Skeleton([child, root])) // Deliberately opposite to hierarchy order.
  const shared = new THREE.SkinnedMesh(geometry, mesh.material); shared.name = 'shared'
  scene.add(shared); shared.bind(mesh.skeleton)
  const prop = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); prop.name = 'removable'; scene.add(prop)
  const clip = new THREE.AnimationClip('root motion', 1, [new THREE.QuaternionKeyframeTrack('root.quaternion', [0, 1], [0, 0, 0, 1, 0, Math.sin(0.5), 0, Math.cos(0.5)])])
  harness.gltf.set(url, { scene, animations: [clip] })
  return { scene, root, child, mesh, shared, prop, clip }
}

test('Viewer3D source preflight rejects malformed encoding, escaped separators and foreign URL lookalikes', async t => {
  const view = await mount(t, null)
  const source = (modelUrl: string) => ({ kind: 'final', modelUrl, isCheckpointPreview: false, label: 'Final output' })
  const resolve = view.viewerModule.resolveViewer3DRigSourceWorkspacePath
  for (const url of ['http://evil.test/workspace/a.glb', 'http://local.test/other/workspace/a.glb', '/workspace/bad%.glb', '/workspace/a%00.glb', '/workspace/a%2fb.glb', '/workspace/%252e%252e/a.glb', '/workspace/a.glb%3fx=1', '/workspace/a.glb#ambiguous']) {
    assert.doesNotThrow(() => resolve(source(url), 'http://local.test'))
    assert.equal(resolve(source(url), 'http://local.test'), undefined, url)
  }
  for (const url of ['http://local.test?file=/workspace/rig.glb', 'http://local.test?file=/workspace/rig.glb?cache=1', '/workspace/rig.glb?cache=%']) assert.equal(resolve(source(url), 'http://local.test'), undefined, url)
  assert.equal(resolve(source('http://local.test/workspace/folder/a%20b.glb?cache=1'), 'http://local.test'), 'folder/a b.glb')
})

test('Viewer3D mounted stable selection rotates the real out-of-order Bone and excludes the GLTF writer until global Play', async t => {
  let rig: ReturnType<typeof authoringAsset>
  const view = await mount(t, '/workspace/rig.glb', h => { rig = authoringAsset(h) })
  view.click('Open Pose/Clip (2 bones)')
  let panel = view.component('PoseClipPanel')
  assert.equal(panel.selectedBoneId, undefined, 'No implicit first target')
  const childId = panel.summary.bones.find((bone: any) => bone.originalName === 'child').boneId
  view.click('Open Rig Editor (2 bones)')
  flush(() => view.component('RigEditorPanel').onSelectBone(childId))
  panel = view.component('PoseClipPanel')
  assert.equal(panel.selectedBoneId, childId)
  view.click('Play animation'); view.frame(0.2)
  const rootBefore = rig!.root.quaternion.clone(); const childBefore = rig!.child.quaternion.clone()
  flush(() => view.component('PoseClipPanel').onRotateSelectedTarget(childId, 'x', 30))
  assert.ok(rig!.root.quaternion.equals(rootBefore)); assert.ok(!rig!.child.quaternion.equals(childBefore))
  const posed = rig!.child.quaternion.clone(); view.frame(0.4)
  assert.ok(rig!.child.quaternion.equals(posed)); assert.ok(rig!.root.quaternion.equals(rootBefore))
  flush(() => view.component('PoseClipPanel').onCaptureKeyframe(childId, 0))
  assert.equal(view.component('PoseClipPanel').keyframes[0].boneId, childId)
  flush(() => view.component('PoseClipPanel').onCurrentTimeChange(0))
  flush(() => view.component('PoseClipPanel').onDeleteKeyframe(view.component('PoseClipPanel').keyframes[0].id, childId))
  assert.ok(rig!.child.quaternion.equals(childBefore), 'Deleting final key restores captured original')
  flush(() => view.component('PoseClipPanel').onRotateSelectedTarget(childId, 'z', 30))
  view.click('Play animation')
  assert.ok(rig!.child.quaternion.equals(childBefore)); view.frame(0.2)
  assert.ok(!rig!.root.quaternion.equals(rootBefore))
  assert.equal(rig!.root.name, 'root'); assert.equal(rig!.child.name, 'child')
})

test('Viewer3D same-URL replacement restores only old pose Bone objects and keeps new rig capability', async t => {
  let first: ReturnType<typeof authoringAsset>
  const view = await mount(t, '/workspace/rig.glb', h => { first = authoringAsset(h) })
  view.click('Open Pose/Clip (2 bones)')
  const panel = view.component('PoseClipPanel'); const id = panel.summary.bones[0].boneId
  const before = first!.root.quaternion.clone()
  flush(() => panel.onRotateSelectedTarget(id, 'x', 45))
  const second = authoringAsset(view.harness); second.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.2)
  const secondBefore = second.root.quaternion.clone()
  view.render()
  assert.ok(first!.root.quaternion.equals(before)); assert.ok(second.root.quaternion.equals(secondBefore))
  assert.equal(view.button('Rig bones').props.disabled, false)
  view.click('Open Pose/Clip (2 bones)')
  assert.equal(view.component('PoseClipPanel').keyframes.length, 0)
  assert.equal(view.component('PoseClipPanel').selectedBoneId, undefined)
  view.unmount(); assert.ok(second.root.quaternion.equals(secondBefore))
})

test('Viewer3D aliases persist an empty revision, recover rejected saves, and preserve a newer dirty revision', async t => {
  const writes: any[] = []; const pending = deferred(); let rejectNext = false
  const view = await mount(t, '/workspace/rig.glb', h => {
    authoringAsset(h)
    h.electron = { workspace: { artifacts: { writeRigRenameSidecar: (request: any) => {
      writes.push(request)
      if (rejectNext) return Promise.reject(new Error('alias write rejected'))
      return writes.length === 1 ? pending.promise : Promise.resolve({ success: true, sidecarWorkspacePath: request.sidecarWorkspacePath })
    } } } }
  })
  view.click('Open Rig Editor (2 bones)')
  let panel = view.component('RigEditorPanel'); const id = panel.summary.bones[0].boneId
  flush(() => panel.onSelectBone(id)); flush(() => view.component('RigEditorPanel').onAliasChange(id, 'Root alias'))
  const saving = view.component('RigEditorPanel').onSaveAliases(); await settle()
  assert.equal(writes.length, 1); assert.equal(view.component('RigEditorPanel').saveState, 'saving')
  flush(() => view.component('RigEditorPanel').onAliasChange(id, 'Newer alias'))
  pending.resolve({ success: true, sidecarWorkspacePath: writes[0].sidecarWorkspacePath }); await saving; await settle()
  assert.equal(view.component('RigEditorPanel').saveState, 'idle'); assert.equal(view.component('RigEditorPanel').aliasesDirty, true)
  await view.component('RigEditorPanel').onSaveAliases(); await settle()
  assert.equal(view.component('RigEditorPanel').aliasesDirty, false)
  flush(() => view.component('RigEditorPanel').onCancelAlias(id))
  assert.equal(view.component('RigEditorPanel').aliasesDirty, true)
  await view.component('RigEditorPanel').onSaveAliases(); await settle()
  assert.deepEqual(writes.at(-1).sidecar.aliases, {}); assert.equal(view.component('RigEditorPanel').aliasesDirty, false)
  flush(() => view.component('RigEditorPanel').onAliasChange(id, 'Will fail')); rejectNext = true
  await view.component('RigEditorPanel').onSaveAliases(); await settle()
  assert.equal(view.component('RigEditorPanel').saveState, 'error')
  assert.match(view.component('RigEditorPanel').saveError, /rejected/)
  rejectNext = false; await view.component('RigEditorPanel').onSaveAliases(); await settle()
  assert.equal(view.component('RigEditorPanel').saveState, 'saved')
})

test('Viewer3D automatic pose hydration cannot overwrite authored keys and explicit Load handles rejection and same-URL replacement', async t => {
  const initial = deferred(); let reader = () => initial.promise
  const writes: any[] = []
  const view = await mount(t, '/workspace/rig.glb', h => {
    authoringAsset(h)
    h.electron = { workspace: { artifacts: {
      readPoseClipSidecar: () => reader(), writePoseClipSidecar: async (request: any) => { writes.push(request); return { success: true, sidecarWorkspacePath: request.sidecarWorkspacePath } },
    } } }
  })
  view.click('Open Pose/Clip (2 bones)'); await settle()
  let panel = view.component('PoseClipPanel'); const id = panel.summary.bones[0].boneId
  // Direct invocation of the actual mounted callback models an already queued edit.
  flush(() => panel.onCaptureKeyframe(id, 0))
  initial.resolve({ success: false, error: 'late read failed' }); await settle()
  assert.equal(view.component('PoseClipPanel').keyframes.length, 1)
  assert.equal(view.component('PoseClipPanel').loadState, 'idle')
  await view.component('PoseClipPanel').onSaveSidecar(); await settle()
  assert.equal(writes.length, 1); assert.equal(view.component('PoseClipPanel').saveState, 'saved')
  reader = () => Promise.reject(new Error('explicit read rejected'))
  await view.component('PoseClipPanel').onLoadSidecar(); await settle()
  assert.equal(view.component('PoseClipPanel').loadState, 'error')
  const late = deferred(); reader = () => late.promise
  const loading = view.component('PoseClipPanel').onLoadSidecar()
  reader = async () => ({ success: true, status: 'not-found' })
  authoringAsset(view.harness); view.render(); view.click('Open Pose/Clip (2 bones)')
  late.resolve({ success: false, error: 'old source error' }); await loading; await settle()
  assert.equal(view.component('PoseClipPanel').keyframes.length, 0)
  assert.equal(view.component('PoseClipPanel').loadState, 'idle')
  assert.equal(view.component('PoseClipPanel').loadError, undefined)
})

async function bridgeFixture(t: any) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'modly-viewer-checkpoint-'))
  t.after(() => rm(workspaceDir, { recursive: true, force: true }))
  await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
  const sourceBytes = Buffer.from('unchanged source fixture')
  await writeFile(path.join(workspaceDir, 'Workflows/rig.glb'), sourceBytes)
  const service = await import(pathToFileURL(path.join(projectRoot, 'electron/main/artifact-registry-service.ts')).href)
  const preloadPath = path.join(workspaceDir, 'preload.mjs')
  await build({ entryPoints: [path.join(projectRoot, 'electron/preload/electron-api.ts')], outfile: preloadPath, bundle: true, format: 'esm', platform: 'node' })
  const { createElectronApi } = await import(pathToFileURL(preloadPath).href)
  const calls: any[] = []
  const writes: any[] = []
  const routes: Record<string, string> = {
    'workspace:artifact:writeEditedSceneArtifact': 'writeEditedSceneArtifact',
    'workspace:artifact:writeRigRenameSidecar': 'writeRigRenameSidecar',
    'workspace:artifact:readRigRenameSidecar': 'readRigRenameSidecar',
    'workspace:artifact:writePoseClipSidecar': 'writePoseClipSidecar',
    'workspace:artifact:readPoseClipSidecar': 'readPoseClipSidecar',
    'workspace:artifact:readRigMetaSidecar': 'readRigMetaSidecar',
  }
  const electron = createElectronApi({ send() {}, on() {}, removeAllListeners() {}, async invoke(channel: string, ...args: any[]) {
    calls.push([channel, ...args])
    if (channel === 'settings:get') return { workspaceDir }
    if (channel === 'fs:deleteDirectory') return { success: true } // Explicitly inert store cleanup port.
    const route = routes[channel]
    assert.ok(route, `Unexpected bridge call ${channel}`)
    if (route.startsWith('write')) writes.push(args[0])
    return service[route]({ workspaceDir, ...args[0] })
  } }, { setZoomFactor() {} }, { getPathForFile: () => '' })
  return { workspaceDir, electron, calls, writes, sourceBytes }
}

function checkpointGraph(workspaceDir: string, kind = 'waitNode', sibling = false) {
  return { id: 'viewer-checkpoint', name: 'Viewer checkpoint', description: '', createdAt: '', updatedAt: '',
    nodes: [
      { id: 'source', type: 'meshNode', position: { x: 0, y: 0 }, data: { params: { source: 'file', filePath: path.join(workspaceDir, 'Workflows/rig.glb') } } },
      { id: 'wait', type: kind, position: { x: 1, y: 0 }, data: { params: {} } },
      ...(sibling ? [{ id: 'other', type: 'waitNode', position: { x: 1, y: 1 }, data: { params: {} } }] : []),
    ], edges: [{ id: 'source-wait', source: 'source', target: 'wait' }, ...(sibling ? [{ id: 'source-other', source: 'source', target: 'other' }] : [])],
  }
}

async function withCpuFileReader(work: () => Promise<void>) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'FileReader')
  class MemoryFileReader {
    result: ArrayBuffer | null = null
    onloadend: (() => void) | null = null
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.() }) }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: MemoryFileReader })
  try { await work() } finally {
    if (before) Object.defineProperty(globalThis, 'FileReader', before)
    else Reflect.deleteProperty(globalThis, 'FileReader')
  }
}

test('Viewer3D actual checkpoint owner exports influence originals and animations through preload/main without transient pose leakage', async t => {
  const bridge = await bridgeFixture(t)
  let rig: ReturnType<typeof authoringAsset>
  const view = await mount(t, null, h => { rig = authoringAsset(h, '/workspace/Workflows/rig.glb'); h.electron = bridge.electron })
  await view.useWorkflowRunStore.getState().run(checkpointGraph(bridge.workspaceDir, 'waitNode', true), []); await settle()
  const owner = view.useWorkflowRunStore.getState().getCheckpointOwner('wait'); assert.ok(owner)
  const edit = view.component('ViewerEditToolbar').sceneEditControls; assert.ok(edit)
  view.click('Bone influence')
  const diagnosticGeometry = rig!.mesh.geometry
  const originalGeometry = rig!.shared.skeleton.bones[0] // Keep a real source object identity sentinel.
  const before = rig!.root.quaternion.clone()
  view.click('Open Pose/Clip (2 bones)')
  const pose = view.component('PoseClipPanel'); const id = pose.summary.bones.find((bone: any) => bone.originalName === 'root').boneId
  flush(() => pose.onRotateSelectedTarget(id, 'z', 45))
  assert.ok(!rig!.root.quaternion.equals(before))
  flush(() => edit.onEditCheckpoint())
  const primitive = find(view.host, node => node.type === 'primitive' && node.props.object === rig!.scene)!
  flush(() => primitive.props.onClick({ object: rig!.prop, stopPropagation() {} }))
  assert.equal(view.useAppStore.getState().meshSelected, false, 'Eligible part selection takes precedence over ordinary scene selection')
  flush(() => view.component('ViewerEditToolbar').sceneEditControls.onHideSelected())
  assert.equal(view.component('ViewerEditToolbar').sceneEditControls.canSave, true)
  await withCpuFileReader(async () => { await view.component('ViewerEditToolbar').sceneEditControls.onSave(); await settle() })
  assert.ok(rig!.root.quaternion.equals(before), 'Transient local rotation restored before export')
  assert.equal(rig!.mesh.geometry, diagnosticGeometry, 'No live diagnostic resource swapping')
  assert.equal(rig!.shared.skeleton.bones[0], originalGeometry)
  const store = view.useWorkflowRunStore.getState(); const currentOwner = store.getCheckpointOwner('wait')
  assert.ok(currentOwner.revision > owner.revision)
  assert.ok(find(view.host, node => node.type === '#text' && String(node.props.text).includes('Saved:')), 'Own successful CAS retains saved UI')
  const replacement = store.getPendingReplacement(currentOwner); assert.ok(replacement, JSON.stringify(bridge.writes))
  assert.equal(store.getPendingReplacement(store.getCheckpointOwner('other')), undefined)
  const savedBytes = await readFile(path.join(bridge.workspaceDir, replacement.uri))
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
  const loaded = await new GLTFLoader().parseAsync(Uint8Array.from(savedBytes).buffer, '')
  assert.equal(loaded.animations.length, 1)
  assert.equal(loaded.scene.getObjectByName('removable'), undefined)
  assert.equal(loaded.scene.getObjectByName('RigInspectionOverlay'), undefined)
  const exportedMesh = loaded.scene.getObjectByName('body') as import('three').Mesh
  assert.equal(exportedMesh.geometry.getAttribute('color'), undefined, 'Influence-only vertex colors not exported')
  assert.equal((exportedMesh.material as import('three').MeshStandardMaterial).transparent, false)
  assert.ok((loaded.scene.getObjectByName('root') as import('three').Bone).quaternion.angleTo(before) < 1e-6)
  assert.deepEqual(await readFile(path.join(bridge.workspaceDir, 'Workflows/rig.glb')), bridge.sourceBytes)
  assert.equal(store.waitStates.wait, 'pending', 'Save never Continues')
  await store.continueRun('wait', { owner: currentOwner, replacementArtifact: replacement }); await settle()
  assert.equal(view.useWorkflowRunStore.getState().waitStates.wait, 'done')
  assert.equal(view.useWorkflowRunStore.getState().waitStates.other, 'pending')
})

test('Viewer3D checkpoint settings race cannot borrow a newly selected owner or writer', async t => {
  const bridge = await bridgeFixture(t)
  let rig: ReturnType<typeof authoringAsset>
  const view = await mount(t, null, h => { rig = authoringAsset(h, '/workspace/Workflows/rig.glb'); h.electron = bridge.electron })
  await view.useWorkflowRunStore.getState().run(checkpointGraph(bridge.workspaceDir, 'waitNode', true), []); await settle()
  flush(() => view.component('ViewerEditToolbar').sceneEditControls.onEditCheckpoint())
  flush(() => find(view.host, node => node.type === 'primitive' && node.props.object === rig!.scene)!.props.onClick({ object: rig!.prop, stopPropagation() {} }))
  flush(() => view.component('ViewerEditToolbar').sceneEditControls.onHideSelected())
  const pendingSettings = deferred(); const oldGet = window.electron.settings.get
  window.electron.settings.get = () => pendingSettings.promise
  const saving = view.component('ViewerEditToolbar').sceneEditControls.onSave()
  const store = view.useWorkflowRunStore.getState(); const other = store.getCheckpointOwner('other')
  flush(() => store.selectCheckpoint(other))
  pendingSettings.resolve({ workspaceDir: bridge.workspaceDir }); await saving; await settle()
  window.electron.settings.get = oldGet
  assert.equal(bridge.writes.length, 0)
  assert.equal(view.useWorkflowRunStore.getState().getPendingReplacement(other), undefined)
  assert.equal(view.component('ViewerEditToolbar').sceneEditControls.saving, false)
})

test('Viewer3D actual landmark owner receives current source pointer hits, not foreign/helpers or ordinary selection', async t => {
  const bridge = await bridgeFixture(t)
  let rig: ReturnType<typeof authoringAsset>
  const view = await mount(t, null, h => { rig = authoringAsset(h, '/workspace/Workflows/rig.glb'); h.electron = bridge.electron })
  await view.useWorkflowRunStore.getState().run(checkpointGraph(bridge.workspaceDir, 'landmarksNode'), []); await settle()
  const source = find(view.host, node => node.type === 'primitive' && node.props.object === rig!.scene)!
  const hit = (object: import('three').Object3D, clientX = 50) => ({ nativeEvent: { clientX, clientY: 50 },
    intersections: [{ object, point: new THREE.Vector3(1, 2, 3) }], stopPropagation() {} })
  flush(() => source.props.onClick(hit(new THREE.Mesh())))
  assert.deepEqual(view.useWorkflowRunStore.getState().checkpoints.wait.landmarkCapture.completed, {})
  flush(() => source.props.onClick(hit(rig!.prop, Number.NaN)))
  assert.deepEqual(view.useWorkflowRunStore.getState().checkpoints.wait.landmarkCapture.completed, {})
  flush(() => source.props.onClick(hit(rig!.prop)))
  assert.equal(view.useWorkflowRunStore.getState().checkpoints.wait.landmarkCapture.completed.left_shoulder.world.x, 1)
  assert.equal(view.useAppStore.getState().meshSelected, false)
  const marker = find(view.host, node => node.type === 'mesh' && node.props.renderOrder === 6)!
  let stopped = false
  flush(() => marker.props.onClick({ stopPropagation() { stopped = true } }))
  assert.equal(stopped, true)
  assert.equal(view.useWorkflowRunStore.getState().checkpoints.wait.landmarkCapture.activeLandmarkId, 'left_shoulder')
  const oldClick = source.props.onClick
  view.switchTo('/animated.glb')
  flush(() => oldClick(hit(rig!.prop)))
  assert.equal(Object.keys(view.useWorkflowRunStore.getState().checkpoints.wait.landmarkCapture.completed).length, 1)
})


test('Viewer3D alias hydration ignores dirty edits and retired same-URL errors, with real preload/main empty persistence', async t => {
  const bridge = await bridgeFixture(t)
  const delayed = deferred()
  const actualRead = bridge.electron.workspace.artifacts.readRigRenameSidecar
  bridge.electron.workspace.artifacts.readRigRenameSidecar = () => delayed.promise
  const view = await mount(t, '/workspace/Workflows/rig.glb', h => { authoringAsset(h, '/workspace/Workflows/rig.glb'); h.electron = bridge.electron })
  view.click('Open Rig Editor (2 bones)'); await settle()
  let panel = view.component('RigEditorPanel'); const id = panel.summary.bones[0].boneId
  flush(() => panel.onSelectBone(id)); flush(() => view.component('RigEditorPanel').onAliasChange(id, 'Authored alias'))
  delayed.reject(new Error('late alias read rejection')); await settle()
  panel = view.component('RigEditorPanel')
  assert.equal(panel.loadState, 'idle'); assert.equal(panel.aliasesDirty, true)
  assert.equal(panel.renamePlan.aliases[id].alias, 'Authored alias')
  bridge.electron.workspace.artifacts.readRigRenameSidecar = actualRead
  await panel.onSaveAliases(); await settle()
  assert.equal(view.component('RigEditorPanel').aliasesDirty, false)
  flush(() => view.component('RigEditorPanel').onCancelAlias(id))
  await view.component('RigEditorPanel').onSaveAliases(); await settle()
  const request = bridge.writes.at(-1); assert.deepEqual(request.sidecar.aliases, {})
  const read = await actualRead({ sourceWorkspacePath: 'Workflows/rig.glb', sidecarWorkspacePath: request.sidecarWorkspacePath })
  assert.equal(read.status, 'found'); assert.deepEqual(read.sidecar.aliases, {})
  const retired = deferred()
  bridge.electron.workspace.artifacts.readRigRenameSidecar = () => retired.promise
  authoringAsset(view.harness, '/workspace/Workflows/rig.glb'); view.render(); await settle()
  let hydration: Promise<unknown> | undefined
  bridge.electron.workspace.artifacts.readRigRenameSidecar = (request: any) => { hydration = actualRead(request); return hydration }
  authoringAsset(view.harness, '/workspace/Workflows/rig.glb'); view.render(); await settle()
  await hydration; await settle()
  view.click('Open Rig Editor (2 bones)')
  retired.reject(new Error('retired scene error')); await settle()
  panel = view.component('RigEditorPanel')
  assert.equal(panel.loadState, 'loaded'); assert.equal(panel.loadError, undefined)
  assert.deepEqual(panel.renamePlan.aliases, {}); assert.equal(panel.aliasesDirty, false)
})

test('Viewer3D pose saves retain dirty revisions, recover rejection and ignore old scene completion', async t => {
  let next = deferred(); const writes: any[] = []
  const view = await mount(t, '/workspace/rig.glb', h => { authoringAsset(h); h.electron = { workspace: { artifacts: {
    writePoseClipSidecar: (request: any) => { writes.push(request); return next.promise },
  } } } })
  view.click('Open Pose/Clip (2 bones)')
  let panel = view.component('PoseClipPanel'); const id = panel.summary.bones[0].boneId
  view.click('Open Rig Editor (2 bones)')
  flush(() => view.component('RigEditorPanel').onSelectBone(id)); flush(() => view.component('PoseClipPanel').onCaptureKeyframe(id, 0))
  const first = view.component('PoseClipPanel').onSaveSidecar(); await settle()
  assert.equal(view.component('PoseClipPanel').saveState, 'saving')
  flush(() => view.component('PoseClipPanel').onClipMetadataChange({ name: 'New authored revision' }))
  next.resolve({ success: true, sidecarWorkspacePath: writes[0].sidecarWorkspacePath }); await first; await settle()
  assert.equal(view.component('PoseClipPanel').saveState, 'idle'); assert.equal(view.component('PoseClipPanel').canSaveSidecar, true)
  next = deferred(); const second = view.component('PoseClipPanel').onSaveSidecar()
  next.reject(new Error('pose write rejection')); await second; await settle()
  assert.equal(view.component('PoseClipPanel').saveState, 'error'); assert.match(view.component('PoseClipPanel').saveError, /rejection/)
  next = deferred(); const third = view.component('PoseClipPanel').onSaveSidecar()
  next.resolve({ success: true, sidecarWorkspacePath: writes.at(-1).sidecarWorkspacePath }); await third; await settle()
  assert.equal(view.component('PoseClipPanel').saveState, 'saved'); assert.equal(view.component('PoseClipPanel').canSaveSidecar, false)
  flush(() => view.component('PoseClipPanel').onClipMetadataChange({ name: 'Retired revision' }))
  next = deferred(); const stale = view.component('PoseClipPanel').onSaveSidecar()
  authoringAsset(view.harness); view.render(); view.click('Open Pose/Clip (2 bones)')
  next.resolve({ success: true, sidecarWorkspacePath: writes.at(-1).sidecarWorkspacePath }); await stale; await settle()
  panel = view.component('PoseClipPanel')
  assert.equal(panel.saveState, 'idle'); assert.equal(panel.keyframes.length, 0); assert.equal(panel.canSaveSidecar, false)
})

test('Viewer3D pose reset, close and unmount restore captured Bone references and stop preview writers', async t => {
  let rig: ReturnType<typeof authoringAsset>
  const view = await mount(t, '/workspace/rig.glb', h => { rig = authoringAsset(h) })
  view.click('Open Pose/Clip (2 bones)')
  const id = view.component('PoseClipPanel').summary.bones[0].boneId
  const before = rig!.root.quaternion.clone()
  view.click('Open Rig Editor (2 bones)')
  flush(() => view.component('RigEditorPanel').onSelectBone(id))
  flush(() => view.component('PoseClipPanel').onRotateSelectedTarget(id, 'z', 30))
  flush(() => view.component('PoseClipPanel').onCaptureKeyframe(id, 0))
  flush(() => view.component('PoseClipPanel').onPreviewPlay())
  assert.equal(view.component('PoseClipPanel').previewState, 'playing')
  view.click('Reset Pose/Clip preview')
  assert.ok(rig!.root.quaternion.equals(before)); assert.equal(view.component('PoseClipPanel').previewState, 'idle')
  assert.equal(view.component('PoseClipPanel').keyframes.length, 1)
  flush(() => view.component('PoseClipPanel').onRotateSelectedTarget(id, 'x', 20))
  flush(() => view.component('ViewerEditToolbar').poseClipControls.onOpenPoseClip())
  assert.ok(rig!.root.quaternion.equals(before))
  view.click('Open Pose/Clip (2 bones)')
  flush(() => view.component('PoseClipPanel').onRotateSelectedTarget(id, 'y', 20))
  view.unmount(); assert.ok(rig!.root.quaternion.equals(before)); assert.equal(view.harness.frames.size, 0)
})

for (const change of ['revision', 'run'] as const) {
  test(`Viewer3D physical save after checkpoint ${change} change cannot publish or claim selected success`, async t => {
    const bridge = await bridgeFixture(t)
    const reachedWriter = deferred(); const releaseWriter = deferred()
    const actualWrite = bridge.electron.workspace.artifacts.writeEditedSceneArtifact
    bridge.electron.workspace.artifacts.writeEditedSceneArtifact = async (request: any) => {
      reachedWriter.resolve(undefined); await releaseWriter.promise
      return actualWrite(request)
    }
    let rig: ReturnType<typeof authoringAsset>
    const view = await mount(t, null, h => { rig = authoringAsset(h, '/workspace/Workflows/rig.glb'); h.electron = bridge.electron })
    const graph = checkpointGraph(bridge.workspaceDir)
    await view.useWorkflowRunStore.getState().run(graph, []); await settle()
    const oldOwner = view.useWorkflowRunStore.getState().getCheckpointOwner('wait')
    flush(() => view.component('ViewerEditToolbar').sceneEditControls.onEditCheckpoint())
    flush(() => find(view.host, node => node.type === 'primitive' && node.props.object === rig!.scene)!.props.onClick({ object: rig!.prop, stopPropagation() {} }))
    flush(() => view.component('ViewerEditToolbar').sceneEditControls.onHideSelected())
    await withCpuFileReader(async () => {
      const saving = view.component('ViewerEditToolbar').sceneEditControls.onSave()
      await reachedWriter.promise
      if (change === 'revision') flush(() => assert.equal(view.useWorkflowRunStore.getState().setPendingReplacement(oldOwner), true))
      else await view.useWorkflowRunStore.getState().run(graph, [])
      await settle()
      releaseWriter.resolve(undefined); await saving; await settle()
    })
    assert.equal(bridge.writes.length, 1, 'Physical save is allowed once already underway')
    const store = view.useWorkflowRunStore.getState(); const owner = store.getCheckpointOwner('wait')
    assert.equal(store.getPendingReplacement(owner), undefined, 'No newer owner can be borrowed')
    assert.equal(store.waitStates.wait, 'pending')
    assert.equal(find(view.host, node => node.type === '#text' && String(node.props.text).includes('Saved:')), undefined)
    if (change === 'revision') assert.ok(find(view.host, node => node.type === '#text' && String(node.props.text).includes('was not selected')))
    else {
      assert.notEqual(owner.runId, oldOwner.runId)
      assert.equal(find(view.host, node => node.type === '#text' && String(node.props.text).includes('was not selected')), undefined, 'Retired run cannot update new run UI')
    }
  })
}


test('Viewer3D source click scope rejects foreign objects without swallowing their events', async t => {
  const view = await mount(t)
  const primitive = view.node('primitive')!
  let stopped = 0
  flush(() => primitive.props.onClick({ object: new THREE.Mesh(), stopPropagation() { stopped++ } }))
  assert.equal(stopped, 0); assert.equal(view.useAppStore.getState().meshSelected, false)
  flush(() => primitive.props.onClick({ object: view.first.mesh, stopPropagation() { stopped++ } }))
  assert.equal(stopped, 1); assert.equal(view.useAppStore.getState().meshSelected, true)
})

test('Viewer3D consecutive owner revisions retain authored edits while validation is unavailable and a new run still resets them', async t => {
  const bridge = await bridgeFixture(t)
  let rig: ReturnType<typeof authoringAsset>
  const view = await mount(t, null, h => { rig = authoringAsset(h, '/workspace/Workflows/rig.glb'); h.electron = bridge.electron })
  const graph = checkpointGraph(bridge.workspaceDir, 'waitNode', true)
  await view.useWorkflowRunStore.getState().run(graph, []); await settle()
  flush(() => view.component('ViewerEditToolbar').sceneEditControls.onEditCheckpoint())
  flush(() => find(view.host, node => node.type === 'primitive' && node.props.object === rig!.scene)!.props.onClick({ object: rig!.prop, stopPropagation() {} }))
  flush(() => view.component('ViewerEditToolbar').sceneEditControls.onHideSelected())
  await withCpuFileReader(async () => { await view.component('ViewerEditToolbar').sceneEditControls.onSave(); await settle() })
  const current = () => view.useWorkflowRunStore.getState()
  let owner = current().getCheckpointOwner('wait')
  const chosen = current().getPendingReplacement(owner); assert.ok(chosen)
  const before = view.component('ViewerEditToolbar').sceneEditControls
  assert.equal(before.mode, 'editing'); assert.equal(before.excludedCount, 1)
  const first = deferred(); const second = deferred()
  const originalGet = window.electron.settings.get
  let reads = 0
  window.electron.settings.get = () => (++reads === 1 ? first.promise : second.promise)
  try {
    flush(() => assert.equal(current().setPendingReplacement(owner), true)); await settle()
    assert.equal(reads, 1)
    assert.equal(view.component('ViewerEditToolbar').sceneEditControls, undefined, 'Pending validation confers no edit/save capability')
    owner = current().getCheckpointOwner('wait')
    flush(() => assert.equal(current().setPendingReplacement(owner, chosen), true)); await settle()
    assert.equal(reads, 2)
    assert.equal(view.component('ViewerEditToolbar').sceneEditControls, undefined)
    first.resolve({ workspaceDir: bridge.workspaceDir }); await settle()
    assert.equal(view.component('ViewerEditToolbar').sceneEditControls, undefined, 'Retired revision validation cannot enable current authority')
    assert.equal(bridge.writes.length, 1)
    second.resolve({ workspaceDir: bridge.workspaceDir }); await settle()
  } finally {
    first.resolve({ workspaceDir: bridge.workspaceDir }); second.resolve({ workspaceDir: bridge.workspaceDir })
    window.electron.settings.get = originalGet
  }
  const after = view.component('ViewerEditToolbar').sceneEditControls
  const ownerAfter = current().getCheckpointOwner('wait')
  assert.equal(ownerAfter.runId, owner.runId); assert.equal(ownerAfter.inputArtifactId, owner.inputArtifactId); assert.equal(ownerAfter.inputVersionId, owner.inputVersionId)
  assert.ok(find(view.host, node => node.type === 'primitive' && node.props.object === rig!.scene))
  assert.equal(current().getPendingReplacement(ownerAfter).versionId, chosen.versionId)
  assert.equal(after.excludedCount, 1, 'Revision-only revalidation preserves authored exclusions')
  assert.equal(after.mode, 'editing', 'Revision-only revalidation preserves edit mode')
  assert.equal(after.canSave, true)
  await current().run(graph, []); await settle()
  assert.notEqual(current().getCheckpointOwner('wait').runId, ownerAfter.runId)
  assert.equal(view.component('ViewerEditToolbar').sceneEditControls.excludedCount, 0, 'A genuinely new run retires the authored context')
  assert.equal(view.component('ViewerEditToolbar').sceneEditControls.mode, 'available')
})


test('Viewer3D migrates a matching legacy pose through mounted Load and hashed Save without changing legacy or source bytes', async t => {
  const bridge = await bridgeFixture(t)
  const actualRead = bridge.electron.workspace.artifacts.readPoseClipSidecar
  let hydration: Promise<unknown> | undefined
  bridge.electron.workspace.artifacts.readPoseClipSidecar = (request: any) => { hydration = actualRead(request); return hydration }
  const view = await mount(t, '/workspace/Workflows/rig.glb', h => { authoringAsset(h, '/workspace/Workflows/rig.glb'); h.electron = bridge.electron })
  view.click('Open Pose/Clip (2 bones)'); await settle(); await hydration; await settle()
  let panel = view.component('PoseClipPanel')
  const summary = panel.summary
  const request = view.viewerModule.resolveViewer3DPoseClipHydrationRequest(summary)
  assert.ok(request.legacySidecarWorkspacePath)
  assert.notEqual(request.sidecarWorkspacePath, request.legacySidecarWorkspacePath)
  let state = view.viewerModule.createViewer3DPoseClipState(summary)
  state = view.viewerModule.reduceViewer3DPoseClipState(state, { type: 'capture-keyframe', summary,
    keyframeId: 'legacy-key', boneId: summary.bones[0].boneId, timeSeconds: 0, rotation: { x: 0, y: 0, z: 0, w: 1 } })
  let legacySidecar: any
  await view.viewerModule.writeViewer3DPoseClipSidecar({ state, writer: async (write: any) => {
    legacySidecar = write.sidecar; return { success: true, sidecarWorkspacePath: write.sidecarWorkspacePath }
  } })
  const legacyPath = path.join(bridge.workspaceDir, request.legacySidecarWorkspacePath)
  await mkdir(path.dirname(legacyPath), { recursive: true })
  const legacyBytes = JSON.stringify(legacySidecar)
  await writeFile(legacyPath, legacyBytes)
  await panel.onLoadSidecar(); await settle()
  panel = view.component('PoseClipPanel')
  assert.equal(panel.loadState, 'loaded'); assert.equal(panel.keyframes[0].id, 'legacy-key')
  flush(() => panel.onClipMetadataChange({ fps: 30 }))
  await view.component('PoseClipPanel').onSaveSidecar(); await settle()
  assert.equal(view.component('PoseClipPanel').saveState, 'saved')
  assert.equal(bridge.writes.at(-1).sidecarWorkspacePath, request.sidecarWorkspacePath)
  assert.equal('legacySidecarWorkspacePath' in bridge.writes.at(-1), false)
  assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes)
  const hashed = JSON.parse(await readFile(path.join(bridge.workspaceDir, request.sidecarWorkspacePath), 'utf8'))
  assert.equal(hashed.schema, 'modly.pose-clip'); assert.equal(hashed.version, 1)
  assert.equal(hashed.clip.fps, 30); assert.equal(hashed.source.workspacePath, summary.sourceWorkspacePath)
  await view.component('PoseClipPanel').onLoadSidecar(); await settle()
  assert.equal(view.component('PoseClipPanel').fps, 30, 'Hashed sidecar takes precedence over older legacy data')
  const sourceB = 'Workflows/b/rig.glb'
  await mkdir(path.join(bridge.workspaceDir, 'Workflows/b'), { recursive: true })
  await writeFile(path.join(bridge.workspaceDir, sourceB), bridge.sourceBytes)
  authoringAsset(view.harness, '/workspace/Workflows/b/rig.glb'); view.switchTo('/workspace/Workflows/b/rig.glb'); view.render()
  view.click('Open Pose/Clip (2 bones)'); await settle(); await hydration; await settle()
  assert.equal(view.component('PoseClipPanel').keyframes.length, 0)
  assert.equal(view.component('PoseClipPanel').loadState, 'idle')
  assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes)
  assert.deepEqual(await readFile(path.join(bridge.workspaceDir, 'Workflows/rig.glb')), bridge.sourceBytes)
  assert.deepEqual(await readFile(path.join(bridge.workspaceDir, sourceB)), bridge.sourceBytes)
})

test('Viewer3D mounted adjacent trusted contract resolves real names and IDs without disturbing authored aliases or animation names', async t => {
  const bridge = await bridgeFixture(t)
  const metaPath = path.join(bridge.workspaceDir, 'Workflows/rig.rigmeta.json')
  const meta = { schema: 'modly.unirig.rigmeta', output_mesh: 'rig.glb', humanoid_contract: {
    schema: 'modly.humanoid.v1', humanoid_contract_status: 'trusted', required_roles: { hips: 'root', head: { boneId: 'child', label: 'Look Control' } },
    validation: { status: 'validated' }, provenance: { trust_scope: { trusted: ['required_roles'] } },
  } }
  await writeFile(metaPath, JSON.stringify(meta))
  const delayed = deferred()
  const actualRead = bridge.electron.workspace.artifacts.readRigMetaSidecar
  let pendingResult: any
  bridge.electron.workspace.artifacts.readRigMetaSidecar = async (request: any) => { pendingResult = await actualRead(request); return delayed.promise }
  let rig: ReturnType<typeof authoringAsset>
  const view = await mount(t, '/workspace/Workflows/rig.glb', h => { rig = authoringAsset(h, '/workspace/Workflows/rig.glb'); h.electron = bridge.electron })
  view.click('Open Rig Editor (2 bones)')
  const firstPanel = view.component('RigEditorPanel')
  const rootId = firstPanel.summary.bones.find((bone: any) => bone.originalName === 'root').boneId
  const childId = firstPanel.summary.bones.find((bone: any) => bone.originalName === 'child').boneId
  flush(() => firstPanel.onAliasChange(rootId, 'Manual Pelvis'))
  // Complete real filesystem IO before releasing the independently deferred UI response.
  for (let i = 0; !pendingResult && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(pendingResult?.success && pendingResult.status === 'found')
  delayed.resolve(pendingResult); await settle()
  const panel = view.component('RigEditorPanel')
  assert.equal(panel.effectiveNaming.byBoneId[rootId].label, 'Manual Pelvis')
  assert.equal(panel.effectiveNaming.byBoneId[rootId].provenance, 'manual')
  assert.equal(panel.effectiveNaming.byBoneId[childId].label, 'Look Control')
  assert.equal(panel.effectiveNaming.byBoneId[childId].provenance, 'unirig')
  assert.equal(panel.aliasesDirty, true)
  flush(() => panel.onCancelAlias(rootId))
  assert.equal(view.component('RigEditorPanel').effectiveNaming.byBoneId[rootId].label, 'Hips')
  assert.deepEqual([rig!.root.name, rig!.child.name, rig!.clip.name, rig!.clip.tracks[0].name], ['root', 'child', 'root motion', 'root.quaternion'])
  assert.equal(await readFile(metaPath, 'utf8'), JSON.stringify(meta))
  assert.deepEqual(await readFile(path.join(bridge.workspaceDir, 'Workflows/rig.glb')), bridge.sourceBytes)
})

test('Viewer3D metadata captures the reader before awaiting and retires same-URL success and rejection without blocking authoring', async t => {
  const bridge = await bridgeFixture(t)
  const metaPath = path.join(bridge.workspaceDir, 'Workflows/rig.rigmeta.json')
  const metadata = (label: string) => ({ schema: 'modly.unirig.rigmeta', output_mesh: 'rig.glb', humanoid_contract: {
    schema: 'modly.humanoid.v1', humanoid_contract_status: 'trusted', required_roles: { hips: { boneId: 'root', label } },
    validation: { status: 'validated' }, provenance: { trust_scope: { trusted: ['required_roles'] } },
  } })
  await writeFile(metaPath, JSON.stringify(metadata('Retired Pelvis')))
  const actualRead = bridge.electron.workspace.artifacts.readRigMetaSidecar
  const initial = deferred(); const captured = deferred(); let initialRequests = 0
  bridge.electron.workspace.artifacts.readRigMetaSidecar = async (request: any) => {
    initialRequests += 1; captured.resolve(await actualRead(request)); return initial.promise
  }
  const view = await mount(t, '/workspace/Workflows/rig.glb', h => { authoringAsset(h, '/workspace/Workflows/rig.glb'); h.electron = bridge.electron })
  // The queued read must use the port captured by its source effect, not this replacement.
  let wrongReaderCalls = 0
  bridge.electron.workspace.artifacts.readRigMetaSidecar = async () => { wrongReaderCalls++; throw new Error('wrong reader') }
  const oldRead = await captured.promise
  assert.equal(initialRequests, 1); assert.equal(wrongReaderCalls, 0)
  assert.ok(oldRead.success && oldRead.status === 'found')
  await writeFile(metaPath, JSON.stringify(metadata('Current Pelvis')))
  let currentRead: Promise<any> | undefined
  bridge.electron.workspace.artifacts.readRigMetaSidecar = (request: any) => { currentRead = actualRead(request); return currentRead }
  authoringAsset(view.harness, '/workspace/Workflows/rig.glb'); view.render(); await settle(); await currentRead; await settle()
  view.click('Open Rig Editor (2 bones)')
  const rootId = view.component('RigEditorPanel').summary.bones.find((bone: any) => bone.originalName === 'root').boneId
  assert.equal(view.component('RigEditorPanel').effectiveNaming.byBoneId[rootId].label, 'Current Pelvis')
  initial.resolve(oldRead); await settle()
  assert.equal(view.component('RigEditorPanel').effectiveNaming.byBoneId[rootId].label, 'Current Pelvis')
  const rejected = deferred()
  bridge.electron.workspace.artifacts.readRigMetaSidecar = () => rejected.promise
  authoringAsset(view.harness, '/workspace/Workflows/rig.glb'); view.render(); await settle()
  bridge.electron.workspace.artifacts.readRigMetaSidecar = (request: any) => { currentRead = actualRead(request); return currentRead }
  authoringAsset(view.harness, '/workspace/Workflows/rig.glb'); view.render(); await settle(); await currentRead; await settle()
  view.click('Open Rig Editor (2 bones)')
  rejected.reject(new Error('retired metadata failure')); await settle()
  assert.equal(view.component('RigEditorPanel').effectiveNaming.byBoneId[rootId].label, 'Current Pelvis')
  assert.ok(!view.component('RigEditorPanel').hydrationWarning?.messages.some((message: string) => message.includes('retired metadata failure')))
  bridge.electron.workspace.artifacts.readRigMetaSidecar = async () => { throw new Error('current metadata failure') }
  authoringAsset(view.harness, '/workspace/Workflows/rig.glb'); view.render(); await settle()
  view.click('Open Rig Editor (2 bones)')
  const panel = view.component('RigEditorPanel')
  assert.equal(panel.effectiveNaming.byBoneId[rootId].provenance, 'raw')
  assert.match(panel.hydrationWarning.messages.join('\n'), /current metadata failure/)
  flush(() => panel.onAliasChange(rootId, 'Still Editable'))
  assert.equal(view.component('RigEditorPanel').effectiveNaming.byBoneId[rootId].label, 'Still Editable')
  assert.deepEqual(await readFile(path.join(bridge.workspaceDir, 'Workflows/rig.glb')), bridge.sourceBytes)
})

// Exercise the isolated SplatViewer itself: only Canvas and Viewer construction
// are inert. Promise behavior comes from the installed public package export.
async function mountActualSplat(t: any) {
  const directory = await mkdtemp(path.join(tmpdir(), 'modly-splat-promise-'))
  const unhandled: unknown[] = []
  const onUnhandled = (error: unknown) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args) })
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected SplatViewer network request') })
  let unmount = () => undefined as void
  const advance = async () => {
    await settle()
    await new Promise<void>(resolve => setImmediate(resolve))
    await settle()
  }
  t.after(async () => {
    try { unmount(); await advance() } finally {
      process.off('unhandledRejection', onUnhandled)
      await rm(directory, { recursive: true, force: true })
    }
    assert.deepEqual(unhandled, [], 'The installed wrapper must not leave a derived rejection unhandled')
    assert.equal(fetch.mock.callCount(), 0, 'No network request may leave the splat CPU harness')
  })
  const packageModule = pathToFileURL(path.join(path.dirname(require.resolve('@mkkellogg/gaussian-splats-3d')), 'gaussian-splats-3d.module.js')).href
  const outfile = path.join(directory, 'splat.mjs')
  await build({
    stdin: {
      contents: `export { default as SplatViewer } from './src/areas/generate/components/SplatViewer.tsx'; export { harness, AbortablePromise, SceneFormat } from '@mkkellogg/gaussian-splats-3d'`,
      resolveDir: projectRoot, loader: 'tsx',
    },
    outfile, bundle: true, format: 'esm', platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [{
      name: 'actual-splat-public-promise',
      setup(builder) {
        builder.onResolve({ filter: /^@react-three\/fiber$/ }, () => ({ path: 'canvas', namespace: 'splat-fixture' }))
        builder.onLoad({ filter: /^canvas$/, namespace: 'splat-fixture' }, () => ({
          contents: `import { createElement } from 'react'; export const Canvas = () => createElement('test-splat-ready'); export const useFrame = () => { throw new Error('Inert Canvas must not mount gizmo children') }`,
          loader: 'js', resolveDir: projectRoot,
        }))
        builder.onResolve({ filter: /^@mkkellogg\/gaussian-splats-3d$/ }, () => ({ path: 'viewer', namespace: 'splat-fixture' }))
        builder.onLoad({ filter: /^viewer$/, namespace: 'splat-fixture' }, () => ({
          contents: `
            import { AbortablePromise, SceneFormat } from ${JSON.stringify(packageModule)}
            import * as THREE from 'three'
            export { AbortablePromise, SceneFormat }
            export const harness = { instances: [], loads: [], aborts: [] }
            export class Viewer {
              camera = new THREE.PerspectiveCamera()
              threeScene = new THREE.Scene()
              controls = { target: new THREE.Vector3(), update() {} }
              starts = 0; stops = 0; disposals = 0
              constructor(options) { this.options = options; harness.instances.push(this) }
              addSplatScene(url, options) {
                let finish, fail
                const load = new AbortablePromise((resolve, reject) => { finish = resolve; fail = reject }, reason => {
                  harness.aborts.push(reason); fail(new Error(String(reason)))
                })
                harness.loads.push({ url, options, load, resolve: () => finish(), reject: error => fail(error) })
                return load
              }
              getSplatMesh() { return { getSplatCount: () => 0, getSplatCenter() {} } }
              start() { this.starts++ }
              stop() { this.stops++ }
              dispose() { this.disposals++; return Promise.resolve() }
            }
          `,
          loader: 'js', resolveDir: projectRoot,
        }))
        builder.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }))
        builder.onResolve({ filter: /^(react(?:\/.*)?|three)$/ }, args => ({ path: require.resolve(args.path), external: true }))
      },
    }],
  })
  const { SplatViewer, harness, AbortablePromise, SceneFormat } = await import(pathToFileURL(outfile).href)
  const host: Host = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(host, 0, null, false, null, '', (error: unknown) => { throw error }, null)
  let mounted = true
  unmount = () => {
    if (!mounted) return
    mounted = false
    flush(() => renderer.updateContainer(null, root, null))
  }
  flush(() => renderer.updateContainer(createElement(SplatViewer, { url: '/fixture.splat', autoRotate: false }), root, null))
  assert.ok(find(host, node => node.type === 'p' && node.props.children === 'Loading splat…'))
  await advance()
  assert.equal(harness.instances.length, 1)
  assert.equal(harness.loads.length, 1)
  const viewer = harness.instances[0]
  const load = harness.loads[0]
  assert.ok(load.load instanceof AbortablePromise, 'Use the installed public wrapper, not a native Promise double')
  assert.equal(load.load instanceof Promise, false)
  assert.equal(load.url, '/fixture.splat')
  assert.equal(load.options.format, SceneFormat.Splat)
  assert.equal(viewer.starts, 0)
  return { host, harness, viewer, load, errors, unhandled, advance, unmount }
}

test('SplatViewer publishes readiness and starts after the installed AbortablePromise resolves', async t => {
  const view = await mountActualSplat(t)
  view.load.resolve()
  await view.advance()
  assert.equal(view.viewer.starts, 1)
  assert.ok(find(view.host, node => node.type === 'test-splat-ready'))
  assert.equal(find(view.host, node => node.type === 'p' && node.props.children === 'Loading splat…'), undefined)
  assert.equal(find(view.host, node => node.type === 'p' && node.props.children === 'Splat failed to load'), undefined)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.unhandled, [])
})

test('SplatViewer publishes installed AbortablePromise download failure without readiness or unhandled rejection', async t => {
  const view = await mountActualSplat(t)
  const error = new Error('Splat download failed')
  view.load.reject(error)
  await view.advance()
  assert.equal(view.viewer.starts, 0)
  assert.equal(find(view.host, node => node.type === 'test-splat-ready'), undefined)
  assert.ok(find(view.host, node => node.type === 'p' && node.props.children === 'Splat failed to load'))
  assert.ok(find(view.host, node => node.type === 'p' && node.props.children === error.message))
  assert.equal(find(view.host, node => node.type === 'p' && node.props.children === 'Loading splat…'), undefined)
  assert.deepEqual(view.errors, [['[SplatViewer] init failed:', error]])
  assert.deepEqual(view.unhandled, [])
})

test('SplatViewer aborts a pending installed AbortablePromise and ignores rejection after unmount', async t => {
  const view = await mountActualSplat(t)
  const grid = view.viewer.threeScene.children[0]
  assert.ok(grid instanceof THREE.GridHelper)
  const resources = [grid.geometry, ...(Array.isArray(grid.material) ? grid.material : [grid.material])]
  const disposals = disposeCounts(t, resources)
  view.unmount()
  await view.advance()
  assert.deepEqual(view.harness.aborts, ['Generate SplatViewer unmounted.'])
  assert.equal(view.viewer.starts, 0)
  assert.equal(view.viewer.stops, 1)
  assert.equal(view.viewer.disposals, 1)
  assert.equal(view.viewer.threeScene.children.length, 0)
  assert.deepEqual(disposals.map(dispose => dispose.mock.callCount()), resources.map(() => 1))
  assert.deepEqual(view.host.children, [], 'Retired completion must not republish loading, error or ready UI')
  assert.deepEqual(view.errors, [], 'Retired rejection must not enter the active error/status publication branch')
  assert.deepEqual(view.unhandled, [])
})
