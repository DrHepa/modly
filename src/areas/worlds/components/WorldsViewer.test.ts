import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { createElement, type ComponentType, type ReactElement, type Ref } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as THREE from 'three'

import type { WorldSceneItem } from '../worldRenderableResolver.ts'
import { normalizeWorldSceneCollisionSurfaces, WORLD_RUN_GROUND_FALLBACK_LABEL } from '../worldCameraNavigation.ts'
import { createWorldCollisionSurfacePreset } from '../worldsCollisionSurfaces.ts'
import { createWorldEditorTransformAdmission } from '../editor/worldEditorTransformAdmission.ts'
import { createWorldEditorController } from '../editor/worldEditorController.ts'
import { createWorldEditorViewportCommitAuthority, useWorldEditorProjectionBridge } from '../editor/useWorldEditorProjectionBridge.ts'
import { useWorldsUiStore } from '../editor/worldsUiStore.ts'
import { useWorldsSceneStore } from '../worldsSceneStore.ts'
import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import { applyWorldCommandBatch } from '../core/worldCommands.ts'
import type { WorldProjectCommandRequest } from '../../../shared/types/worldProjects.ts'
import type { WorldsCameraFitSnapshot } from './WorldsViewer.tsx'
import { createRuntimeWorldSnapshot } from '../runtime/_testFixtures.ts'
import type { WorldEditorRunCollisionInput } from '../editor/worldEditorRunCollision.ts'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const Reconciler = require('react-reconciler')

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const worldsRoot = path.join(projectRoot, 'src/areas/worlds')
const viewerEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsViewer.tsx')
const modeControlEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsViewportModeControl.tsx')
const navigationControlsEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsViewportNavigationControls.tsx')
const meshFixture = path.join(projectRoot, 'src/areas/worlds/__fixtures__/colored-mesh.ply')
const pointsFixture = path.join(projectRoot, 'src/areas/worlds/__fixtures__/colored-points.ply')

type Host = {
  type: string; props: Record<string, any>; children: Host[]; object?: THREE.Object3D
  parent?: Host; resource?: THREE.BufferGeometry | THREE.Material; focus?: () => void
  ownerDocument?: NavigationTestDocument
  addEventListener?: (type: string, listener: NavigationTestListener | null) => void
  removeEventListener?: (type: string, listener: NavigationTestListener | null) => void
  emit?: (type: string, event?: NavigationTestEvent) => NavigationTestEvent
  contains?: (value: unknown) => boolean
  closest?: () => null
}
type WorldsCameraFitSnapshotRef = { current: WorldsCameraFitSnapshot | null }
type WorldsTestOrbitControls = ReturnType<typeof worldsFitControls>
type TestSceneFitControllerProps = {
  enabled?: boolean
  sceneItems: WorldSceneItem[]
  sceneObjectsRef: { current: Map<string, THREE.Object3D> }
  renderLoadStatesRef?: { current: Map<string, unknown> }
  sceneObjectVersion: number
  fitKey: string
  loadRevision: number
  resetToken: number
  orbitControlsRef: { current: WorldsTestOrbitControls | null }
  cameraFitSnapshotRef: WorldsCameraFitSnapshotRef
  collisionSurfaces: readonly unknown[]
}
type TestRenderLoadReporter = (item: WorldSceneItem, attempt: object, status: string, owner?: object) => void
type TestRenderBoundaryHandle = { reportLoadState(status: string, attempt?: object): void }
type TestRenderBoundaryProps = { children: ReactElement; item?: WorldSceneItem; onRenderLoadStateChange?: TestRenderLoadReporter }
type TestPlySceneObjectProps = { item: WorldSceneItem; onBoundsChange: () => void }
type ViewerInteractionTestExports = {
  TestSceneFitController: ComponentType<TestSceneFitControllerProps>
  TestRenderBoundary: ComponentType<TestRenderBoundaryProps & { ref?: Ref<TestRenderBoundaryHandle> }>
  TestPlySceneObject: ComponentType<TestPlySceneObjectProps>
}
function getViewerInteractionTestExports(module: unknown): ViewerInteractionTestExports {
  return module as ViewerInteractionTestExports
}
function requireWorldsCameraFitSnapshot(ref: WorldsCameraFitSnapshotRef): WorldsCameraFitSnapshot {
  assert.ok(ref.current)
  return ref.current
}

async function loadViewerModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-viewer-test-'))
  const outfile = path.join(tempDir, 'WorldsViewer.bundle.mjs')
  const result = await build({
    entryPoints: [viewerEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: [],
  })
  const source = result.outputFiles[0].text
  await writeFile(outfile, source)
  return {
    source,
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function loadModeControlModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-mode-control-test-'))
  const outfile = path.join(tempDir, 'WorldsViewportModeControl.bundle.mjs')
  const result = await build({
    entryPoints: [modeControlEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  })
  const source = result.outputFiles[0].text
  await writeFile(outfile, source)
  return {
    source,
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

type NavigationControlsTestModule = {
  WorldsViewportNavigationControls: ComponentType<{
    runCollisionInput?: WorldEditorRunCollisionInput
    mode: 'inspect' | 'fly' | 'run'
    collisionSurfaces: readonly unknown[]
    inputScopeRef: { current: HTMLElement }
    orbitControlsRef: { current: { target: THREE.Vector3; maxDistance: number; update: () => void } | null }
    frameSceneToken: number
    onModeChange: (mode: 'inspect' | 'fly' | 'run') => void
    onPointerLockChange: (locked: boolean) => void
    onStatusChange: (status: string) => void
  }>
  configureNavigationTestThree: (state: { camera: THREE.PerspectiveCamera; gl: { domElement: unknown } }) => void
  advanceNavigationTestFrame: (delta: number) => void
}

async function loadNavigationControlsModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-navigation-controls-test-'))
  const outfile = path.join(tempDir, 'WorldsViewportNavigationControls.bundle.mjs')
  const result = await build({
    stdin: {
      contents: `export { WorldsViewportNavigationControls } from './src/areas/worlds/components/WorldsViewportNavigationControls.tsx'; export { configureNavigationTestThree, advanceNavigationTestFrame } from '@react-three/fiber';`,
      resolveDir: projectRoot,
      sourcefile: 'WorldsViewportNavigationControls.test-entry.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react/jsx-runtime', 'three'],
    plugins: [{
      name: 'worlds-navigation-controls-test-fiber',
      setup(build) {
        build.onResolve({ filter: /^@react-three\/fiber$/ }, () => ({ path: '@react-three/fiber', namespace: 'worlds-navigation-test' }))
        build.onLoad({ filter: /.*/, namespace: 'worlds-navigation-test' }, () => ({
          loader: 'js',
          contents: `let state = null; let frame = null;
            export function configureNavigationTestThree(next) { state = next; frame = null; }
            export function useThree() { if (!state) throw new Error('navigation test state is not configured'); return state; }
            export function useFrame(callback) { frame = callback; }
            export function advanceNavigationTestFrame(delta) { if (!frame) throw new Error('navigation frame callback is not mounted'); frame({}, delta); }`,
        }))
      },
    }],
  })
  await writeFile(outfile, result.outputFiles[0].text)
  return {
    module: await import(pathToFileURL(outfile).href) as NavigationControlsTestModule,
    async cleanup() { await rm(tempDir, { recursive: true, force: true }) },
  }
}

type NavigationTestEvent = Record<string, unknown>
type NavigationTestListener = EventListenerOrEventListenerObject

class NavigationTestEventTarget {
  private readonly listeners = new Map<string, Set<NavigationTestListener>>()

  addEventListener(type: string, listener: NavigationTestListener | null): void {
    if (!listener) return
    const listeners = this.listeners.get(type) ?? new Set<NavigationTestListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: NavigationTestListener | null): void {
    if (!listener) return
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, event: NavigationTestEvent = {}): NavigationTestEvent {
    const payload: NavigationTestEvent = { target: this, ...event }
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (typeof listener === 'function') listener(payload as unknown as Event)
      else listener.handleEvent(payload as unknown as Event)
    }
    return payload
  }
}

class NavigationTestNode extends NavigationTestEventTarget {
  readonly children = new Set<NavigationTestNode>()
  readonly ownerDocument: NavigationTestDocument
  readonly tagName: string
  requestPointerLock?: () => Promise<void>

  constructor(ownerDocument: NavigationTestDocument, tagName: string) {
    super()
    this.ownerDocument = ownerDocument
    this.tagName = tagName
  }

  append(child: NavigationTestNode): void {
    this.children.add(child)
  }

  contains(value: unknown): boolean {
    if (value === this) return true
    for (const child of this.children) {
      if (child.contains(value)) return true
    }
    return false
  }

  closest(): null {
    return null
  }

  focus(): void {
    this.ownerDocument.activeElement = this
  }
}

class NavigationTestWindow extends NavigationTestEventTarget {
  readonly Node = NavigationTestNode
}

class NavigationTestDocument extends NavigationTestEventTarget {
  readonly defaultView = new NavigationTestWindow()
  activeElement: NavigationTestNode | Host | null = null
  pointerLockElement: NavigationTestNode | null = null
  hidden = false
  exitPointerLockCalls = 0

  exitPointerLock = (): void => {
    this.exitPointerLockCalls += 1
    this.pointerLockElement = null
    this.emit('pointerlockchange')
  }
}

function createNavigationTestDom() {
  const ownerDocument = new NavigationTestDocument()
  const scope = new NavigationTestNode(ownerDocument, 'DIV')
  const canvas = new NavigationTestNode(ownerDocument, 'CANVAS')
  scope.append(canvas)
  let requestPointerLockCalls = 0
  canvas.requestPointerLock = async () => {
    requestPointerLockCalls += 1
    ownerDocument.pointerLockElement = canvas
    ownerDocument.emit('pointerlockchange')
  }
  return {
    ownerDocument,
    scope,
    canvas,
    requestPointerLockCalls: () => requestPointerLockCalls,
  }
}

function createNavigationKeyboardEvent(code: string, target: NavigationTestNode) {
  let defaultPrevented = false
  return {
    event: {
      code,
      target,
      preventDefault: () => { defaultPrevented = true },
    },
    defaultPrevented: () => defaultPrevented,
  }
}

async function loadViewerInteractionModule(withGeometry = false, withFitCamera = false, withNavigation = false) {
  const tempDir = await mkdtemp(path.join('/tmp', 'worlds-viewer-interaction-test-'))
  const outfile = path.join(tempDir, 'WorldsViewer.interaction.bundle.mjs')
  await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }))
  await symlink(path.join(projectRoot, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir')
  const result = await build({
    entryPoints: [viewerEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    plugins: [{
      name: 'worlds-viewer-interaction-mocks',
      setup(build) {
        if (withFitCamera || withNavigation) build.onLoad({ filter: /WorldsViewer\.tsx$/ }, async () => ({
          contents: `${await readFile(viewerEntry, 'utf8')}\nexport { SceneFitController as TestSceneFitController, WorldSceneItemErrorBoundary as TestRenderBoundary, PlySceneObject as TestPlySceneObject };\nexport const testUpdateRenderLoadState = (...args) => updateWorldsRenderLoadState(...args);\nexport { fitTestCamera, fitTestBoundsCalls, navigationTestDom } from '@react-three/fiber';`,
          loader: 'tsx', resolveDir: path.dirname(viewerEntry),
        }))
        const navigationDomMock = withNavigation ? `
          class TestEventTarget {
            constructor(){ this.listeners = new Map(); }
            addEventListener(type, listener){ const values = this.listeners.get(type) ?? new Set(); values.add(listener); this.listeners.set(type, values); }
            removeEventListener(type, listener){ this.listeners.get(type)?.delete(listener); }
            listenerCount(type){ return this.listeners.get(type)?.size ?? 0; }
            emit(type, event = {}){ const payload = { target: this, ...event }; for (const listener of [...(this.listeners.get(type) ?? [])]) listener(payload); return payload; }
          }
          const ownerWindow = new TestEventTarget();
          const ownerDocument = new TestEventTarget(); ownerDocument.defaultView = ownerWindow; ownerDocument.pointerLockElement = null; ownerDocument.activeElement = null; ownerDocument.hidden = false; ownerDocument.exitPointerLockCalls = 0;
          ownerDocument.exitPointerLock = () => { ownerDocument.exitPointerLockCalls += 1; ownerDocument.pointerLockElement = null; ownerDocument.emit('pointerlockchange'); };
          const canvas = new TestEventTarget(); canvas.ownerDocument = ownerDocument; canvas.requestPointerLockCalls = 0;
          canvas.requestPointerLock = async () => { canvas.requestPointerLockCalls += 1; ownerDocument.pointerLockElement = canvas; ownerDocument.emit('pointerlockchange'); };
          export const navigationTestDom = { ownerDocument, ownerWindow, canvas };
        ` : 'export const navigationTestDom = null;'
        const mocks = new Map<string, string>([
          ['@react-three/fiber', `import { createElement } from 'react'; import * as THREE from 'three'; export const fitTestCamera = new THREE.PerspectiveCamera(45, 1, .01, 500); fitTestCamera.position.set(2.4, 1.8, 2.8); export const fitTestBoundsCalls = { refresh: 0 }; ${navigationDomMock} export function Canvas(props){ return createElement('canvas-mock', props, props.children); } export function useFrame(){} export function useThree(){ return { camera: ${withFitCamera || withNavigation ? 'fitTestCamera' : 'new THREE.PerspectiveCamera()'}, gl: { domElement: ${withNavigation ? 'navigationTestDom.canvas' : '{}'} }, scene: new THREE.Scene() }; }`],
          ['@react-three/drei', `import { createElement, Fragment, forwardRef, useImperativeHandle } from 'react'; import * as THREE from 'three'; import { fitTestBoundsCalls } from '@react-three/fiber'; export function Bounds(props){ return createElement(Fragment, null, props.children); } export function Environment(props){ return createElement(Fragment, null, props.children); } export function GizmoHelper(props){ return createElement(Fragment, null, props.children); } export function GizmoViewport(){ return null; } export function Html(props){ return createElement('html-mock', null, props.children); } export function Lightformer(){ return null; } export const OrbitControls = forwardRef(function OrbitControls(_props, ref){ useImperativeHandle(ref, () => ({ target: new THREE.Vector3(), update(){}, saveState(){}, maxDistance: Infinity })); return null; }); export function TransformControls(props){ return createElement('transform-controls', props); } export function useBounds(){ return { refresh(){ fitTestBoundsCalls.refresh++; return this; }, clip(){ return this; }, fit(){ return this; }, getSize(){ return { center: new THREE.Vector3(), size: new THREE.Vector3(${withFitCamera ? '1, 1, 1' : ''}), distance: ${withFitCamera ? '1.670244640136808' : '0'} }; } }; }
            // Match useGLTF asset identity; each test loads its own isolated mock module.
            const gltfAssets = new Map();
            export function useGLTF(url) {
              let asset = gltfAssets.get(url);
              if (!asset) {
                asset = { scene: new THREE.Group(), animations: [] };
                ${withGeometry ? `
                  const mesh = new THREE.Mesh(
                    new THREE.BoxGeometry(url.includes('wide') ? 4 : 1, 1, 1),
                    new THREE.MeshStandardMaterial(),
                  );
                  mesh.position.x = url.includes('wide') ? 2 : 0;
                  asset.scene.add(mesh);
                ` : ''}
                gltfAssets.set(url, asset);
              }
              return asset;
            }
          `],
          ['@react-three/postprocessing', `import { createElement, Fragment } from 'react'; export function Select(props){ return createElement(Fragment, null, props.children); } export function Selection(props){ return createElement(Fragment, null, props.children); }`],
          ['./WorldViewportGraphics.tsx', `export function WorldViewportGraphics(){ return null; }`],
          ['./WorldViewportBoundary.tsx', `export function WorldCanvasLifecycle(){ return null; }`],
          ['./WorldsViewportModeControl.tsx', `import { createElement, Fragment } from 'react'; export function WorldsViewportModeControl(props){ return createElement(Fragment, null, ['inspect', 'fly', 'run'].map((mode) => createElement('button', { key: mode, type: 'button', role: 'radio', 'aria-checked': props.mode === mode, 'aria-label': mode, onClick: () => props.onModeChange(mode) }, mode)), createElement('button', { type: 'button', 'aria-label': 'Frame scene', onClick: props.onFrameScene }, 'Frame scene')${withNavigation ? ", createElement('span', { role: 'status', 'data-navigation-status': true }, props.status)" : ''}); }`],
        ])
        if (!withNavigation) mocks.set('./WorldsViewportNavigationControls.tsx', 'export function WorldsViewportNavigationControls(){ return null; }')
        build.onResolve({ filter: /.*/ }, (args) => mocks.has(args.path) ? { path: args.path, namespace: 'worlds-viewer-mock' } : undefined)
        build.onLoad({ filter: /.*/, namespace: 'worlds-viewer-mock' }, (args) => ({ contents: mocks.get(args.path) ?? '', loader: 'js', resolveDir: projectRoot }))
      },
    }],
  })
  await writeFile(outfile, result.outputFiles[0].text)
  return {
    module: await import(pathToFileURL(outfile).href),
    async cleanup() { await rm(tempDir, { recursive: true, force: true }) },
  }
}

function item(kind: WorldSceneItem['kind'], url: string): WorldSceneItem {
  return {
    id: `world:${url}`,
    workspacePath: url,
    url,
    kind,
    role: 'asset',
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }
}

function projectDocument() {
  return {
    schema: 'modly.world-project.v1' as const,
    projectId: 'project:viewer-red',
    name: 'Viewer Red',
    revision: 7,
    resources: [],
    scenes: [{ id: 'scene:viewer', name: 'Viewer', documentPath: 'Worlds/viewer/scene.world-scene.json' }],
    startSceneId: 'scene:viewer',
    inputActions: [],
    graphicsProfiles: [{ id: 'graphics:viewer', name: 'Viewer', renderScale: 1, shadowQuality: 'off' as const, antialiasing: 'off' as const }],
    activeGraphicsProfileId: 'graphics:viewer',
  }
}

function projectSnapshot() {
  const entity = item('glb', 'asset.glb')
  entity.id = 'entity:ship'
  return {
    project: projectDocument(),
    scenes: [{
      schema: 'modly.world-scene.v1' as const,
      projectId: 'project:viewer-red',
      sceneId: 'scene:viewer',
      name: 'Viewer',
      environment: { backgroundColor: '#18181b' as const, ambientIntensity: 0.3 },
      sequences: [],
      entities: [{
        id: entity.id,
        name: 'Ship',
        parentId: null,
        enabled: true,
        locked: false,
        tags: [],
        transform: structuredClone(entity.transform),
        components: [],
      }],
    }],
  }
}

function mounted(withObjects = false) {
  let focusedHost: Host | null = null
  const hostDocument = new NavigationTestDocument()
  const owned = new Set<THREE.BufferGeometry | THREE.Material>()
  const own = <T extends THREE.BufferGeometry | THREE.Material>(resource: T): T => { owned.add(resource); return resource }
  const disposeOwned = (resource: THREE.BufferGeometry | THREE.Material | THREE.Material[] | undefined) => {
    if (Array.isArray(resource)) resource.forEach(disposeOwned)
    else if (resource && owned.delete(resource)) resource.dispose()
  }
  const sameValues = (a: unknown, b: unknown) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index])
  const createResource = (type: string, props: Host['props']) => {
    if (!withObjects) return undefined
    if (type === 'boxGeometry') return own(new THREE.BoxGeometry(...(props.args ?? []) as ConstructorParameters<typeof THREE.BoxGeometry>))
    if (type === 'meshBasicMaterial') {
      const parameters = Object.fromEntries(['color', 'transparent', 'opacity', 'depthWrite'].filter((key) => props[key] !== undefined).map((key) => [key, props[key]]))
      return own(new THREE.MeshBasicMaterial(parameters))
    }
    return undefined
  }
  const attachResource = (parent: Host, child: Host) => {
    const mesh = parent.object
    if (!(mesh instanceof THREE.Mesh) || !child.resource) return
    if (child.resource instanceof THREE.BufferGeometry) {
      if (mesh.geometry !== child.resource) { disposeOwned(mesh.geometry); mesh.geometry = child.resource }
    } else if (mesh.material !== child.resource) { disposeOwned(mesh.material); mesh.material = child.resource }
  }
  const detach = (child: Host) => {
    const parent = child.parent
    if (!parent) return
    const index = parent.children.indexOf(child)
    if (index >= 0) parent.children.splice(index, 1)
    if (child.object?.parent === parent.object) child.object?.removeFromParent()
    if (parent.object instanceof THREE.Mesh && child.resource) {
      if (parent.object.geometry === child.resource) parent.object.geometry = parent.props.geometry ?? own(new THREE.BufferGeometry())
      if (parent.object.material === child.resource) parent.object.material = parent.props.material ?? own(new THREE.MeshBasicMaterial())
    }
    child.parent = undefined
  }
  const append = (parent: Host, child: Host, before?: Host) => {
    if (child === before) return
    detach(child)
    const index = before ? parent.children.indexOf(before) : parent.children.length
    assert.ok(index >= 0, 'host insertion target must belong to its parent')
    parent.children.splice(index, 0, child)
    child.parent = parent
    attachResource(parent, child)
    if (withObjects && parent.object && child.object) {
      parent.object.add(child.object)
      const nextObject = parent.children.slice(index + 1).find((node) => node.object)?.object
      if (nextObject) {
        const objectIndex = parent.object.children.indexOf(child.object)
        const nextIndex = parent.object.children.indexOf(nextObject)
        assert.ok(objectIndex >= 0 && nextIndex >= 0, 'Object3D insertion members must be attached')
        parent.object.children.splice(objectIndex, 1)
        parent.object.children.splice(nextIndex, 0, child.object)
      }
    }
  }
  const disposeHost = (node: Host) => {
    for (const child of [...node.children]) { detach(child); disposeHost(child) }
    disposeOwned(node.resource)
    if (node.type === 'mesh' && node.object instanceof THREE.Mesh) {
      disposeOwned(node.object.geometry)
      disposeOwned(node.object.material)
    }
  }
  const remove = (parent: Host, child: Host) => {
    if (child.parent !== parent) return
    detach(child)
    disposeHost(child)
  }
  const update = (node: Host, props: Host['props'], previous?: Host['props']) => {
    if (withObjects && node.type === 'primitive' && node.object !== props.object) {
      const parent = node.parent
      const next = parent?.children[parent.children.indexOf(node) + 1]
      node.object?.removeFromParent()
      node.object = props.object
      for (const child of node.children) if (child.object) node.object?.add(child.object)
      if (parent) append(parent, node, next)
    }
    if (node.resource && previous && (node.type === 'boxGeometry'
      ? !sameValues(props.args, previous.args)
      : ['color', 'transparent', 'opacity', 'depthWrite'].some((key) => props[key] !== previous[key]))) {
      const oldResource = node.resource
      node.resource = createResource(node.type, props)
      if (node.parent) attachResource(node.parent, node)
      disposeOwned(oldResource)
    }
    const object = node.object
    if (object && (withObjects || !previous)) {
      for (const key of ['position', 'scale'] as const) {
        if (Array.isArray(props[key]) && !sameValues(props[key], previous?.[key])) object[key].fromArray(props[key])
      }
      if (Array.isArray(props.rotation) && !sameValues(props.rotation, previous?.rotation)) object.rotation.set(props.rotation[0], props.rotation[1], props.rotation[2], 'XYZ')
      if (props.userData) Object.assign(object.userData, props.userData)
      if (typeof props.name === 'string') object.name = props.name
      if (typeof props.visible === 'boolean' && props.visible !== previous?.visible) object.visible = props.visible
    }
    node.props = props
  }
  const renderer = Reconciler({
    now: performance.now.bind(performance), supportsMutation: true, isPrimaryRenderer: true,
    getRootHostContext: () => null, getChildHostContext: () => null, getPublicInstance: (node: Host) => node.object ?? node.resource ?? node,
    prepareForCommit: () => null, resetAfterCommit() {}, shouldSetTextContent: () => false,
    createInstance: (type: string, props: Host['props']) => {
      const object = type === 'group' ? new THREE.Group() : withObjects && type === 'mesh' ? new THREE.Mesh() : undefined
      if (object instanceof THREE.Mesh) {
        own(object.geometry)
        if (Array.isArray(object.material)) object.material.forEach(own)
        else own(object.material)
      }
      const node: Host = { type, props, children: [], object, resource: createResource(type, props) }
      const listeners = new Map<string, Set<NavigationTestListener>>()
      node.ownerDocument = hostDocument
      node.addEventListener = (eventType, listener) => {
        if (!listener) return
        const values = listeners.get(eventType) ?? new Set<NavigationTestListener>()
        values.add(listener)
        listeners.set(eventType, values)
      }
      node.removeEventListener = (eventType, listener) => { if (listener) listeners.get(eventType)?.delete(listener) }
      node.emit = (eventType, event = {}) => {
        const payload = { target: node, ...event }
        for (const listener of [...(listeners.get(eventType) ?? [])]) {
          if (typeof listener === 'function') listener(payload as unknown as Event)
          else listener.handleEvent(payload as unknown as Event)
        }
        return payload
      }
      node.contains = (value) => value === node || node.children.some((child) => child.contains?.(value))
      node.closest = () => null
      node.focus = () => { focusedHost = node; hostDocument.activeElement = node }
      update(node, props)
      return node
    },
    createTextInstance: (value: string) => ({ type: '#text', props: { value }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, clearContainer: (node: Host) => { for (const child of [...node.children]) remove(node, child) },
    insertBefore: append, insertInContainerBefore: append, finalizeInitialChildren: () => false,
    prepareUpdate: () => true, commitUpdate: (node: Host, _payload: unknown, _type: unknown, previous: Host['props'], props: Host['props']) => update(node, props, previous),
    commitTextUpdate: (node: Host, _old: unknown, value: string) => { node.props.value = value },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1,
    detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  })
  const container: Host = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(container, 0, null, false, null, '', () => {}, null)
  return {
    container,
    render: (value: React.ReactNode) => { renderer.flushSync(() => renderer.updateContainer(value, root, null, null)); renderer.flushPassiveEffects() },
    flush: () => { renderer.flushSync(() => {}); renderer.flushPassiveEffects() },
    focused: () => focusedHost,
  }
}

async function settleMounted(host: ReturnType<typeof mounted>, ticks = 6): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    host.flush()
  }
}

function findHost(node: Host, predicate: (node: Host) => boolean): Host | undefined {
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = findHost(child, predicate)
    if (found) return found
  }
  return undefined
}

function findHosts(node: Host, predicate: (node: Host) => boolean, matches: Host[] = []): Host[] {
  if (predicate(node)) matches.push(node)
  for (const child of node.children) findHosts(child, predicate, matches)
  return matches
}

function getHostText(node: Host): string {
  if (node.type === '#text') return String(node.props.value ?? '')
  return node.children.map(getHostText).join('')
}

async function mountedAnchorBridge(options: { holdTransformApply?: boolean } = {}) {
  const loaded = await loadViewerInteractionModule(true)
  const host = mounted(true)
  const previousUi = useWorldsUiStore.getState()
  const previousScene = useWorldsSceneStore.getState()
  useWorldsUiStore.getState().resetForScene()
  let input: WorldProjectSnapshotV1 = projectSnapshot()
  const projectKey = `world-${'b'.repeat(32)}`
  input.project.scenes[0].documentPath = `Worlds/${projectKey}/scenes/scene-${'b'.repeat(32)}.world-scene.json`
  input.project.resources = [{ id: 'resource:model', type: 'model', name: 'Model', workspacePath: 'Exports/model.glb', format: 'glb' }]
  input.scenes[0].entities = ['a', 'b', 'c'].map((id, index) => ({
    ...structuredClone(input.scenes[0].entities[0]), id: `entity:${id}`, name: id,
    transform: { position: [index * 3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: `component:${id}`, type: 'renderable', enabled: true, resourceId: 'resource:model', visible: true,
      castShadow: false, receiveShadow: false, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } }],
  }))
  const canonicalCalls: string[] = []
  const forbidden = async () => { canonicalCalls.push('mutation'); throw new Error('Selection must not mutate canonical state') }
  const requests: WorldProjectCommandRequest[] = []
  const pendingChanges: boolean[] = []
  let enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const controller = createWorldEditorController({
    open: async (request) => ({ ok: true, value: { status: 'ready', projectKey: request.projectKey, snapshot: structuredClone(input), durabilityWarnings: [] } }),
    create: forbidden, list: forbidden, previewCommands: forbidden, delete: forbidden,
    applyCommands: options.holdTransformApply ? async (request) => {
      requests.push(structuredClone(request))
      enter()
      await held
      const applied = applyWorldCommandBatch(input, request.batch)
      assert.equal(applied.success, true, 'The actual captured transform must replay through the production command core')
      if (!applied.success) throw new Error('Captured transform replay failed')
      input = structuredClone(applied.snapshot)
      return { ok: true, value: {
        projectKey, snapshot: structuredClone(applied.snapshot), newRevision: applied.snapshot.project.revision,
        idempotent: false, changes: applied.changes, warnings: applied.warnings, inverse: structuredClone(applied.inverse),
        receipt: {
          transactionId: request.batch.transactionId, appliedRevision: applied.snapshot.project.revision,
          payloadSha256: createHash('sha256').update(JSON.stringify(request.batch)).digest('hex'),
          resultSha256: createHash('sha256').update(JSON.stringify(applied.snapshot)).digest('hex'),
        },
      } }
    } : forbidden,
  })
  const authority = createWorldEditorViewportCommitAuthority()
  const lease = authority.issue()
  const errors: string[] = []
  const admission = createWorldEditorTransformAdmission({
    getContext: () => ({ projectKey: controller.getState().projectKey, activeSceneId: controller.getState().activeSceneId, snapshot: controller.getState().session?.snapshot ?? null }),
    getViewportLease: () => lease, isViewportCurrent: authority.isCurrent,
    onError: (message) => errors.push(message), onPendingChange: (pending) => pendingChanges.push(pending),
  })
  let bridge!: ReturnType<typeof useWorldEditorProjectionBridge>
  let toolbarOverride: boolean | undefined
  function BridgedViewer() {
    const state = React.useSyncExternalStore((listener) => controller.subscribe(listener), () => controller.getState())
    bridge = useWorldEditorProjectionBridge({ controller, state, apiUrl: '', viewportCommitAuthority: authority,
      viewportCommitLease: lease, transformAdmission: admission, onError: (message) => errors.push(message) })
    return createElement(loaded.module.WorldsViewer, {
      ...bridge.viewerProps, key: [state.projectKey, state.session?.snapshot.project.projectId, state.activeSceneId].join('\0'),
      showPlaybackControls: false,
      ...(toolbarOverride === undefined ? {} : { showAuthoringToolbar: toolbarOverride }),
    })
  }
  const render = async () => { host.render(createElement(BridgedViewer)); await settleMounted(host) }
  try {
    assert.equal((await controller.openProject(projectKey)).ok, true)
    await render()
    assert.deepEqual(bridge.issues, [])
    assert.equal(bridge.projection?.items.length, 3)
  } catch (error) {
    host.render(null)
    useWorldsUiStore.setState(previousUi, true)
    useWorldsSceneStore.setState(previousScene, true)
    await loaded.cleanup()
    throw error
  }
  return {
    host, controller, canonicalCalls, errors, admission, authority, requests, entered, release, pendingChanges,
    get bridge() { return bridge },
    async setAuthoringToolbar(value: boolean | undefined) { toolbarOverride = value; await render() },
    async select(id: string | null) { bridge.viewerProps.onSelectItem?.(id); await settleMounted(host) },
    async publish(next: WorldProjectSnapshotV1, key = projectKey) {
      input = next
      assert.equal((await controller.openProject(key)).ok, true)
      await render()
    },
    async cleanup() {
      release()
      host.render(null)
      await settleMounted(host)
      useWorldsUiStore.setState(previousUi, true)
      useWorldsSceneStore.setState(previousScene, true)
      await loaded.cleanup()
    },
  }
}

test('mounted canonical bridge gives Run a read-only revision and Play-intent lease', async () => {
  const rig = await mountedAnchorBridge()
  try {
    const input = rig.bridge.viewerProps.runCollisionInput
    assert.ok(input)
    assert.equal(input.snapshot, rig.controller.getState().session?.snapshot)
    assert.equal(input.sceneId, rig.controller.getState().activeSceneId)
    assert.equal(input.isCurrent(), true)
    const next = structuredClone(input.snapshot)
    next.project.revision++
    await rig.publish(next)
    assert.equal(input.isCurrent(), false)
    const current = rig.bridge.viewerProps.runCollisionInput!
    assert.equal(current.isCurrent(), true)
    rig.authority.revoke()
    assert.equal(current.isCurrent(), false)
    assert.equal(rig.requests.length, 0)
  } finally { await rig.cleanup() }
})

test('mounted actual editor bridge keeps captured C pending without a false-stale alert until its held dispatch settles', async (t) => {
  const rig = await mountedAnchorBridge({ holdTransformApply: true })
  try {
    await rig.select('entity:c')
    const before = rig.controller.getState().session!
    const controls = findHost(rig.host.container, (node) => node.type === 'transform-controls')
    assert.ok(controls)
    controls.props.onMouseDown()
    controls.props.object.position.y += 2
    controls.props.onObjectChange()
    const finalPreview = {
      position: controls.props.object.position.toArray(),
      rotation: [controls.props.object.rotation.x, controls.props.object.rotation.y, controls.props.object.rotation.z],
      scale: controls.props.object.scale.toArray(),
    }
    assert.strictEqual(rig.controller.getState().session, before)
    assert.equal(rig.requests.length, 0, 'Pointer preview must not dispatch')
    controls.props.onMouseUp()
    await rig.entered
    assert.equal(rig.requests.length, 1)
    const request = rig.requests[0]
    assert.equal(request.projectKey, rig.controller.getState().projectKey)
    assert.equal(request.batch.baseRevision, before.snapshot.project.revision)
    assert.equal(request.batch.commands.length, 1)
    const command = request.batch.commands[0]
    assert.equal(command.type, 'patch-entity')
    if (command.type !== 'patch-entity') throw new Error('Expected the actual captured C patch')
    assert.equal(command.sceneId, before.snapshot.project.startSceneId)
    assert.equal(command.entityId, 'entity:c')
    assert.deepEqual(command.patch.transform, finalPreview)
    assert.strictEqual(rig.controller.getState().session, before)
    assert.deepEqual({ pending: rig.admission.pending, alerts: rig.errors, changes: rig.pendingChanges },
      { pending: true, alerts: [], changes: [true] }, 'Admitted captured C must remain pending without a false-stale alert while dispatch is held')
    await rig.select('entity:b')
    assert.equal(rig.bridge.viewerProps.selectedItemId, 'entity:b')
    assert.equal(rig.bridge.viewerProps.transformPending, true)
    assert.equal(rig.admission.pending, true)
    assert.deepEqual(rig.requests, [request], 'Selecting B must not retarget or duplicate the held C dispatch')
    assert.deepEqual(rig.errors, [])
    rig.release()
    await settleMounted(rig.host)
    const after = rig.controller.getState().session!
    assert.equal(rig.controller.getState().lifecycle, 'ready')
    assert.equal(after.snapshot.project.revision, before.snapshot.project.revision + 1)
    for (const original of before.snapshot.scenes[0].entities) {
      const actual = after.snapshot.scenes[0].entities.find((entity) => entity.id === original.id)
      assert.deepEqual(actual, original.id === 'entity:c' ? { ...original, transform: finalPreview } : original)
    }
    assert.equal(after.undoStack.length, before.undoStack.length + 1)
    assert.equal(after.receipts.length, before.receipts.length + 1)
    assert.equal(rig.bridge.viewerProps.selectedItemId, 'entity:b')
    assert.equal(rig.requests.length, 1)
    assert.equal(rig.admission.pending, false)
    assert.deepEqual(rig.pendingChanges, [true, false])
    assert.deepEqual(rig.errors, [])
    t.diagnostic('actual Viewer gesture → real bridge/admission/controller → held production-core transport; C-only result, B selection retained')
  } finally { await rig.cleanup() }
})

test('mounted actual editor bridge rejects revoked lease and canceled captured gesture without dispatch', async (t) => {
  for (const rejection of ['revoked lease', 'canceled gesture']) await t.test(rejection, async () => {
    const rig = await mountedAnchorBridge({ holdTransformApply: true })
    try {
      await rig.select('entity:c')
      const before = rig.controller.getState().session!
      const gesture = rig.bridge.viewerProps.onTransformGestureBegin!(['entity:c'])
      assert.ok(gesture)
      if (rejection === 'revoked lease') rig.authority.revoke()
      else rig.bridge.viewerProps.onTransformGestureCancel!(gesture)
      rig.bridge.viewerProps.onTransformItem!('entity:c', structuredClone(before.snapshot.scenes[0].entities[2].transform), { gesture })
      await settleMounted(rig.host)
      assert.equal(rig.requests.length, 0)
      assert.strictEqual(rig.controller.getState().session, before)
      assert.equal(rig.admission.pending, false)
      assert.deepEqual(rig.errors, ['Transform is no longer current.'])
    } finally { await rig.cleanup() }
  })
})

test('mounted actual editor bridge preserves captured revision rejection without a transport commit', async () => {
  const rig = await mountedAnchorBridge({ holdTransformApply: true })
  try {
    await rig.select('entity:c')
    const before = rig.controller.getState().session!
    const gesture = rig.bridge.viewerProps.onTransformGestureBegin!(['entity:c'])
    assert.ok(gesture)
    const newer = structuredClone(before.snapshot)
    newer.project.revision += 1
    await rig.publish(newer)
    const current = rig.controller.getState().session!
    rig.bridge.viewerProps.onTransformItem!('entity:c', structuredClone(before.snapshot.scenes[0].entities[2].transform), { gesture })
    await settleMounted(rig.host)
    assert.equal(rig.requests.length, 0)
    assert.strictEqual(rig.controller.getState().session, current)
    assert.equal(rig.controller.getState().error?.code, 'revision_conflict')
    assert.equal(rig.admission.pending, false)
    assert.ok(rig.errors.includes('World editor authority changed while commands were prepared.'))
  } finally { await rig.cleanup() }
})

test('mounted editor bridge keeps its anchor sink stable and selection noncanonical', async (t) => {
  const rig = await mountedAnchorBridge()
  try {
    await rig.select('entity:a')
    const sink = rig.bridge.viewerProps.onSceneItemAnchorChange
    const session = rig.controller.getState().session
    await rig.select('entity:b')
    assert.strictEqual(rig.controller.getState().session, session)
    assert.deepEqual(session?.undoStack, [])
    assert.deepEqual(rig.canonicalCalls, [])
    assert.equal(findHost(rig.host.container, (node) => node.props.name === 'entity:a')?.object?.name, 'entity:a')
    assert.equal(findHost(rig.host.container, (node) => node.props.name === 'entity:b selected')?.object?.name, 'entity:b selected')
    t.diagnostic(JSON.stringify({ stableAnchorSink: sink === rig.bridge.viewerProps.onSceneItemAnchorChange, canonicalCalls: rig.canonicalCalls.length }))
    assert.strictEqual(rig.bridge.viewerProps.onSceneItemAnchorChange, sink)
  } finally { await rig.cleanup() }
})

test('mounted editor Viewer preserves unrelated model bounds and true anchor invalidation', async (t) => {
  const rig = await mountedAnchorBridge()
  const events: Array<[number, number, number] | null> = []
  const unsubscribe = useWorldsSceneStore.subscribe((next, previous) => {
    if (next.sceneItemAnchors['entity:c'] !== previous.sceneItemAnchors['entity:c']) events.push(next.sceneItemAnchors['entity:c'] ?? null)
  })
  try {
    await rig.select('entity:a')
    const c = findHost(rig.host.container, (node) => node.props.name === 'entity:c')?.object
    assert.ok(c)
    let meshes = 0
    c.traverse((object) => { if ((object as THREE.Mesh).geometry?.getAttribute('position')) meshes += 1 })
    assert.equal(meshes, 1, 'the actual Viewer owns a loaded mesh, not an empty mock group')
    const traverse = c.traverse.bind(c)
    let walks = 0
    c.traverse = (visitor) => { walks += 1; traverse(visitor) }
    const anchor = useWorldsSceneStore.getState().sceneItemAnchors['entity:c']
    assert.deepEqual(anchor, [6, 0, 0])
    events.length = 0
    await rig.select('entity:b')
    t.diagnostic(JSON.stringify({ unchangedCWorldBoundsWalks: walks, unchangedCAnchorPublications: events.length }))
    assert.equal(walks, 0)
    assert.deepEqual<typeof events>(events, [])
    assert.strictEqual(useWorldsSceneStore.getState().sceneItemAnchors['entity:c'], anchor)
    await rig.select('entity:c')
    walks = 0
    const controls = findHost(rig.host.container, (node) => node.type === 'transform-controls')
    assert.ok(controls)
    controls.props.onMouseDown()
    t.diagnostic(JSON.stringify({ cachedCGizmoStartBoundsWalks: walks }))
    assert.equal(walks, 0, 'gizmo start must use the retained local-bounds cache')
    controls.props.object.position.x += 1
    controls.props.onObjectChange()
    assert.deepEqual(rig.canonicalCalls, [])
    await rig.select(null)
    assert.equal(c.position.x, 6, 'selection cancellation restores the authoritative pose')
    const moved = structuredClone(rig.controller.getState().session!.snapshot)
    moved.scenes[0].entities[2].transform.position[0] = 9
    moved.project.revision += 1
    await rig.publish(moved)
    assert.deepEqual(useWorldsSceneStore.getState().sceneItemAnchors['entity:c'], [9, 0, 0])
    const changedContent = structuredClone(moved)
    changedContent.project.resources[0].workspacePath = 'Exports/wide.glb'
    changedContent.project.revision += 1
    await rig.publish(changedContent)
    assert.deepEqual(useWorldsSceneStore.getState().sceneItemAnchors['entity:c'], [11, 0, 0])
    const replacement = structuredClone(changedContent)
    replacement.project.projectId = 'project:replacement'
    replacement.project.startSceneId = replacement.project.scenes[0].id = 'scene:replacement'
    replacement.scenes[0].projectId = replacement.project.projectId
    replacement.scenes[0].sceneId = 'scene:replacement'
    events.length = 0
    await rig.publish(replacement, `world-${'c'.repeat(32)}`)
    assert.ok(events.includes(null), 'real project/scene replacement still clears old anchors')
    assert.deepEqual(events.at(-1), [11, 0, 0])
    const deleted = structuredClone(replacement)
    deleted.scenes[0].entities = deleted.scenes[0].entities.filter((entity) => entity.id !== 'entity:c')
    await rig.publish(deleted, `world-${'c'.repeat(32)}`)
    assert.equal(useWorldsSceneStore.getState().sceneItemAnchors['entity:c'], undefined)
    assert.equal(findHost(rig.host.container, (node) => node.props.name === 'entity:c'), undefined)
    rig.host.render(null)
    await settleMounted(rig.host)
    assert.deepEqual(useWorldsSceneStore.getState().sceneItemAnchors, {})
    assert.deepEqual(rig.errors, [])
    assert.deepEqual(rig.canonicalCalls, [])
    t.diagnostic('transform/content refresh, project/scene replacement, deletion and unmount anchor checks passed')
  } finally { unsubscribe(); await rig.cleanup() }
})

test('mounted Viewer keeps reusable authoring tools by default and explicit opt-out removes only the floating toolbar', async () => {
  const rig = await mountedAnchorBridge({ holdTransformApply: true })
  const toolbar = () => findHost(rig.host.container, (node) => node.props['aria-label'] === 'World asset transform controls')
  const control = () => findHost(rig.host.container, (node) => node.type === 'transform-controls')!
  try {
    await rig.select('entity:c')
    assert.ok(toolbar(), 'The omitted prop retains reusable authoring controls')
    assert.ok(control())
    const target = control().props.object as THREE.Object3D
    let meshes = 0
    target.traverse((object) => { if ((object as THREE.Mesh).geometry?.getAttribute('position')) meshes += 1 })
    assert.equal(meshes, 1, 'The real bridge-mounted Viewer must own a loaded position-bearing mesh')
    await rig.setAuthoringToolbar(true)
    assert.ok(toolbar()); assert.strictEqual(control().props.object, target)
    const before = rig.controller.getState().session!
    control().props.onMouseDown(); target.position.y += 2; control().props.onObjectChange(); control().props.onMouseUp()
    await rig.entered; await settleMounted(rig.host)
    assert.equal(rig.admission.pending, true); assert.equal(rig.requests.length, 1)
    const canvas = findHost(rig.host.container, (node) => node.type === 'canvas-mock')
    const reset = findHost(rig.host.container, (node) => node.props['aria-label'] === 'Frame scene')
    const status = findHost(rig.host.container, (node) => node.props.role === 'status')
    assert.ok(canvas); assert.ok(reset); assert.ok(status)
    for (const visible of [false, true]) {
      await rig.setAuthoringToolbar(visible)
      assert.equal(!!toolbar(), visible, 'Only the rendered floating toolbar follows the explicit override')
      assert.strictEqual(control().props.object, target)
      assert.strictEqual(findHost(rig.host.container, (node) => node.type === 'canvas-mock'), canvas)
      assert.strictEqual(findHost(rig.host.container, (node) => node.props['aria-label'] === 'Frame scene'), reset)
      assert.strictEqual(findHost(rig.host.container, (node) => node.props.role === 'status'), status)
      assert.equal(rig.admission.pending, true); assert.strictEqual(rig.controller.getState().session, before)
      assert.equal(rig.requests.length, 1); assert.deepEqual(rig.canonicalCalls, [])
    }
    rig.release(); await settleMounted(rig.host)
    assert.equal(rig.requests.length, 1); assert.equal(rig.admission.pending, false)
  } finally { rig.release(); await settleMounted(rig.host); await rig.cleanup() }
})

test('WorldsViewer parses vertex-color indexed PLY as a mesh render model', async () => {
  const { module, cleanup } = await loadViewerModule()
  const bytes = await readFile(meshFixture)

  try {
    const model = module.createPlyRenderModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), item('ply-mesh', 'mesh.ply'))

    assert.deepEqual(
      {
        primitive: model.primitive,
        hasVertexColors: model.hasVertexColors,
        material: model.material,
        viewerNormalization: model.viewerNormalization,
        vertexCount: model.geometry.getAttribute('position').count,
        indexCount: model.geometry.index?.count,
        minY: model.geometry.boundingBox?.min.y,
        centerX: ((model.geometry.boundingBox?.min.x ?? 0) + (model.geometry.boundingBox?.max.x ?? 0)) / 2,
        centerZ: ((model.geometry.boundingBox?.min.z ?? 0) + (model.geometry.boundingBox?.max.z ?? 0)) / 2,
      },
      {
        primitive: 'mesh',
        hasVertexColors: true,
        material: 'standard-vertex-color',
        viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered',
        vertexCount: 3,
        indexCount: 3,
        minY: 0,
        centerX: 0,
        centerZ: 0,
      },
    )
  } finally {
    await cleanup()
  }
})

test('mounted Viewer active transform gesture cancels when selected target unmounts before mouseup', async () => {
  const { module, cleanup } = await loadViewerInteractionModule()
  const host = mounted()
  const snapshot = projectSnapshot()
  const ship = item('glb', 'asset.glb')
  ship.id = 'entity:ship'
  const errors: string[] = []
  const lease = Object.freeze({ generation: 1 })
  const owner = createWorldEditorTransformAdmission({
    getContext: () => ({ projectKey: 'world-viewer-red', activeSceneId: 'scene:viewer', snapshot }),
    getViewportLease: () => lease,
    isViewportCurrent: (candidate) => candidate === lease,
    onError: (message) => errors.push(message),
    onPendingChange: () => undefined,
  })
  const activeGestures: Array<ReturnType<typeof owner.begin> extends infer Gesture ? NonNullable<Gesture> : never> = []
  const cancelledGestures: typeof activeGestures = []
  const admission = {
    begin: owner.begin,
    cancel(gesture: (typeof activeGestures)[number]) {
      cancelledGestures.push(gesture)
      owner.cancel(gesture)
    },
  }
  try {
    host.render(createElement(module.WorldsViewer, {
      project: snapshot.project,
      items: [ship],
      selectedItemId: 'entity:ship',
      selectedItemIds: ['entity:ship'],
      transformMode: 'translate',
      onTransformGestureBegin: (itemIds: readonly string[]) => {
        const gesture = owner.begin('viewport', itemIds)
        if (gesture) activeGestures.push(gesture)
        return gesture
      },
      onTransformGestureCancel: admission.cancel,
      onTransformItem: () => undefined,
      onTransformItems: () => undefined,
    }))
    await settleMounted(host)
    const controls = findHost(host.container, (node) => node.type === 'transform-controls')
    assert.ok(controls)
    assert.equal(typeof controls.props.onMouseDown, 'function')
    controls.props.onMouseDown()
    const activeViewportGesture = activeGestures[0]
    assert.ok(activeViewportGesture)
    assert.match(activeViewportGesture.gestureId, /^transform:viewport:/)
    assert.deepEqual(activeViewportGesture.entityIds, ['entity:ship'])
    assert.equal(owner.isCurrent(activeViewportGesture), true)
    assert.deepEqual(errors, [])

    host.render(createElement(module.WorldsViewer, {
      project: snapshot.project,
      items: [],
      selectedItemId: null,
      selectedItemIds: [],
      transformMode: 'translate',
      onTransformGestureBegin: (itemIds: readonly string[]) => owner.begin('viewport', itemIds),
      onTransformGestureCancel: admission.cancel,
      onTransformItem: () => undefined,
      onTransformItems: () => undefined,
    }))
    await settleMounted(host)

    const inspector = admission.begin('inspector', ['entity:ship'])
    assert.notEqual(inspector, null)
    assert.deepEqual(cancelledGestures, [activeViewportGesture])
    if (inspector) admission.cancel(inspector)
    assert.notEqual(admission.begin('viewport', ['entity:ship']), null)
    assert.deepEqual(errors, [])
  } finally {
    host.render(null)
    await cleanup()
  }
})

test('mounted Viewer active transform gesture cancels when selection clears before mouseup', async () => {
  const { module, cleanup } = await loadViewerInteractionModule()
  const host = mounted()
  const snapshot = projectSnapshot()
  const ship = item('glb', 'asset.glb')
  ship.id = 'entity:ship'
  const errors: string[] = []
  const lease = Object.freeze({ generation: 1 })
  const owner = createWorldEditorTransformAdmission({
    getContext: () => ({ projectKey: 'world-viewer-clear', activeSceneId: 'scene:viewer', snapshot }),
    getViewportLease: () => lease,
    isViewportCurrent: (candidate) => candidate === lease,
    onError: (message) => errors.push(message),
    onPendingChange: () => undefined,
  })
  type Gesture = NonNullable<ReturnType<typeof owner.begin>>
  const activeGestures: Gesture[] = []
  const cancelledGestures: Gesture[] = []
  let commits = 0
  const renderViewer = (selected: boolean) => host.render(createElement(module.WorldsViewer, {
    project: snapshot.project,
    items: [ship],
    selectedItemId: selected ? 'entity:ship' : null,
    selectedItemIds: selected ? ['entity:ship'] : [],
    transformMode: 'translate',
    onTransformGestureBegin: (itemIds: readonly string[]) => {
      const gesture = owner.begin('viewport', itemIds)
      if (gesture) activeGestures.push(gesture)
      return gesture
    },
    onTransformGestureCancel: (gesture: Gesture) => {
      cancelledGestures.push(gesture)
      owner.cancel(gesture)
    },
    onTransformItem: () => { commits += 1 },
    onTransformItems: () => { commits += 1 },
  }))

  try {
    renderViewer(true)
    await settleMounted(host)
    const controls = findHost(host.container, (node) => node.type === 'transform-controls')
    assert.ok(controls)
    controls.props.onMouseDown()
    const activeViewportGesture = activeGestures[0]
    assert.ok(activeViewportGesture)
    assert.equal(owner.isCurrent(activeViewportGesture), true)

    renderViewer(false)
    await settleMounted(host)

    assert.deepEqual(cancelledGestures, [activeViewportGesture])
    assert.equal(owner.isCurrent(activeViewportGesture), false)
    assert.equal(commits, 0)
    assert.deepEqual(errors, [])
    const inspector = owner.begin('inspector', ['entity:ship'])
    assert.notEqual(inspector, null)
    if (inspector) owner.cancel(inspector)
  } finally {
    host.render(null)
    await cleanup()
  }
})

test('mounted Viewer unmount cancels active transform without stale commit', async () => {
  const { module, cleanup } = await loadViewerInteractionModule()
  const host = mounted()
  const snapshot = projectSnapshot()
  const ship = item('glb', 'asset.glb')
  ship.id = 'entity:ship'
  const errors: string[] = []
  const lease = Object.freeze({ generation: 1 })
  const owner = createWorldEditorTransformAdmission({
    getContext: () => ({ projectKey: 'world-viewer-unmount', activeSceneId: 'scene:viewer', snapshot }),
    getViewportLease: () => lease,
    isViewportCurrent: (candidate) => candidate === lease,
    onError: (message) => errors.push(message),
    onPendingChange: () => undefined,
  })
  type Gesture = NonNullable<ReturnType<typeof owner.begin>>
  const activeGestures: Gesture[] = []
  const cancelledGestures: Gesture[] = []
  let commits = 0

  try {
    host.render(createElement(module.WorldsViewer, {
      project: snapshot.project,
      items: [ship],
      selectedItemId: 'entity:ship',
      selectedItemIds: ['entity:ship'],
      transformMode: 'translate',
      onTransformGestureBegin: (itemIds: readonly string[]) => {
        const gesture = owner.begin('viewport', itemIds)
        if (gesture) activeGestures.push(gesture)
        return gesture
      },
      onTransformGestureCancel: (gesture: Gesture) => {
        cancelledGestures.push(gesture)
        owner.cancel(gesture)
      },
      onTransformItem: () => { commits += 1 },
      onTransformItems: () => { commits += 1 },
    }))
    await settleMounted(host)
    const controls = findHost(host.container, (node) => node.type === 'transform-controls')
    assert.ok(controls)
    controls.props.onMouseDown()
    const activeViewportGesture = activeGestures[0]
    assert.ok(activeViewportGesture)

    host.render(null)
    await settleMounted(host)

    assert.deepEqual(cancelledGestures, [activeViewportGesture])
    assert.equal(owner.isCurrent(activeViewportGesture), false)
    assert.equal(commits, 0)
    assert.deepEqual(errors, [])
    assert.notEqual(owner.begin('inspector', ['entity:ship']), null)
  } finally {
    host.render(null)
    await cleanup()
  }
})

test('mounted Viewer denied transform begin stays denied after pending finishes before mouseup', async () => {
  const { module, cleanup } = await loadViewerInteractionModule()
  const host = mounted()
  const snapshot = projectSnapshot()
  const ship = item('glb', 'asset.glb')
  ship.id = 'entity:ship'
  const errors: string[] = []
  const pendingChanges: boolean[] = []
  const lease = Object.freeze({ generation: 1 })
  const owner = createWorldEditorTransformAdmission({
    getContext: () => ({ projectKey: 'world-viewer-denied', activeSceneId: 'scene:viewer', snapshot }),
    getViewportLease: () => lease,
    isViewportCurrent: (candidate) => candidate === lease,
    onError: (message) => errors.push(message),
    onPendingChange: (pending) => pendingChanges.push(pending),
  })
  const pending = owner.begin('inspector', ['entity:ship'])
  assert.ok(pending)
  assert.equal(owner.release(pending), true)
  let beginAttempts = 0
  let commits = 0

  try {
    host.render(createElement(module.WorldsViewer, {
      project: snapshot.project,
      items: [ship],
      selectedItemId: 'entity:ship',
      selectedItemIds: ['entity:ship'],
      transformMode: 'translate',
      onTransformGestureBegin: (itemIds: readonly string[]) => {
        beginAttempts += 1
        return owner.begin('viewport', itemIds)
      },
      onTransformGestureCancel: (gesture: NonNullable<ReturnType<typeof owner.begin>>) => owner.cancel(gesture),
      onTransformItem: () => { commits += 1 },
      onTransformItems: () => { commits += 1 },
    }))
    await settleMounted(host)
    const controls = findHost(host.container, (node) => node.type === 'transform-controls')
    assert.ok(controls)
    controls.props.onMouseDown()
    assert.equal(beginAttempts, 1)
    assert.equal(errors.at(-1), 'Wait for the current transform to finish.')

    owner.finish(pending)
    controls.props.object.position.set(4, 0, 0)
    controls.props.onObjectChange()
    controls.props.onMouseUp()
    await settleMounted(host)

    assert.equal(beginAttempts, 1)
    assert.equal(commits, 0)
    assert.deepEqual(pendingChanges, [true, false])
    assert.notEqual(owner.begin('viewport', ['entity:ship']), null)
  } finally {
    host.render(null)
    await cleanup()
  }
})

test('WorldsViewer parses vertex-color non-indexed PLY as a points render model', async () => {
  const { module, cleanup } = await loadViewerModule()
  const bytes = await readFile(pointsFixture)

  try {
    const model = module.createPlyRenderModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), item('ply-points', 'points.ply'))

    assert.deepEqual(
      {
        primitive: model.primitive,
        hasVertexColors: model.hasVertexColors,
        material: model.material,
        pointSize: model.pointSize,
        viewerNormalization: model.viewerNormalization,
        vertexCount: model.geometry.getAttribute('position').count,
        indexCount: model.geometry.index?.count ?? 0,
        minY: model.geometry.boundingBox?.min.y,
      },
      {
        primitive: 'points',
        hasVertexColors: true,
        material: 'points-vertex-color',
        pointSize: 0.025,
        viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered',
        vertexCount: 3,
        indexCount: 0,
        minY: 0,
      },
    )
  } finally {
    await cleanup()
  }
})

test('WorldsViewer exposes unified mouse and keyboard controls without importing Generate Viewer3D', async () => {
  const { source, module, cleanup } = await loadViewerModule()

  try {
    assert.equal(source.includes('components/Viewer3D'), false)
    assert.equal(source.includes('Viewer3D'), false)
    assert.equal(source.includes('Open a workflow world or renderable PLY/GLB asset.'), false)
    assert.equal(source.includes('Editor navigation mode'), true)
    assert.deepEqual(module.WORLD_VIEWER_ORBIT_CONTROLS, {
      enablePan: true,
      enableZoom: true,
      enableRotate: true,
      screenSpacePanning: true,
      minPolarAngle: 0,
      maxPolarAngle: Math.PI,
      minDistance: 0.05,
      maxDistance: 500,
      zoomSpeed: 1.25,
      panSpeed: 1.2,
      rotateSpeed: 0.75,
    })
    assert.equal((await readFile(viewerEntry, 'utf8')).includes('PointerLockControls'), false)
    assert.deepEqual(module.describeWorldsViewerScene([item('ply-mesh', 'mesh.ply')]), {
      hasRenderableItems: true,
      hasGrid: true,
      hasOrbitControls: true,
      hasUnifiedKeyboardMovement: true,
      hasGizmo: true,
      hasSelection: false,
      selectedItemId: null,
      selectedItemIds: [],
      transformControls: null,
      unsupported: [],
      renderTargets: [
        {
          workspacePath: 'mesh.ply',
          kind: 'ply-mesh',
          loader: 'ply',
          primitive: 'mesh',
          cameraFit: 'bounds',
          visibleDescription: 'PLY mesh geometry',
        },
      ],
    })
    assert.deepEqual(module.describeWorldsViewerScene([{ ...item('ply-mesh', 'mesh.ply'), visible: false }]), {
      hasRenderableItems: false,
      hasGrid: true,
      hasOrbitControls: true,
      hasUnifiedKeyboardMovement: true,
      hasGizmo: true,
      hasSelection: false,
      selectedItemId: null,
      selectedItemIds: [],
      transformControls: null,
      unsupported: [],
      renderTargets: [],
    })
  } finally {
    await cleanup()
  }
})

test('Timeline preview camera uses authored perspective and vertical orthographic size without leaking editor camera state', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    const transform = { position: [8, 4, 2], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] }
    const perspective = module.createWorldsTimelinePreviewCamera({
      entityId: 'entity:camera-perspective',
      component: { id: 'component:camera-perspective', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.25, far: 250, fieldOfView: 72 },
      transform,
    }, 1600, 900)
    assert.equal(perspective.isPerspectiveCamera, true)
    assert.equal(perspective.fov, 72)
    assert.equal(perspective.near, 0.25)
    assert.equal(perspective.far, 250)
    assert.deepEqual(perspective.position.toArray(), transform.position)

    const orthographic = module.createWorldsTimelinePreviewCamera({
      entityId: 'entity:camera-orthographic',
      component: { id: 'component:camera-orthographic', type: 'camera', enabled: true, projection: 'orthographic', primary: true, near: 0.1, far: 100, orthographicSize: 8 },
      transform,
    }, 1600, 800)
    assert.equal(orthographic.isOrthographicCamera, true)
    assert.equal(orthographic.top - orthographic.bottom, 8, 'orthographicSize is the vertical world-space height')
    assert.equal(orthographic.right - orthographic.left, 16)
    assert.equal(module.resolveWorldsTimelineAnimationTime('entity:hero', {
      timeSeconds: 1.5,
      animationStates: [{ entityId: 'entity:hero', componentId: 'component:animation', playing: true }],
      activeCamera: null,
    }), 1.5)
    assert.equal(module.resolveWorldsTimelineAnimationTime('entity:hero', {
      timeSeconds: 1.5,
      animationStates: [{ entityId: 'entity:hero', componentId: 'component:animation', playing: false }],
      activeCamera: null,
    }), 0)
    const poseClip = {
      kind: 'pose-clip',
      sidecarWorkspacePath: 'Animations/hero.pose.json',
      legacySidecarWorkspacePath: 'Animations/hero.legacy.json',
      sourceWorkspacePath: 'Characters/hero.glb',
      clipId: 'walk',
      clipName: 'Walk',
      durationSeconds: 1,
    }
    assert.equal(
      module.createWorldsPoseClipLoadKey('Characters/hero.glb', poseClip),
      module.createWorldsPoseClipLoadKey('Characters/hero.glb', { ...poseClip, clipId: 'walk-v2', durationSeconds: 2 }),
      'metadata-only projections must not restart the asynchronous pose load',
    )
    assert.notEqual(
      module.createWorldsPoseClipLoadKey('Characters/hero.glb', poseClip),
      module.createWorldsPoseClipLoadKey('Characters/hero.glb', { ...poseClip, sidecarWorkspacePath: 'Animations/run.pose.json' }),
    )
  } finally {
    await cleanup()
  }
})

test('WorldsViewer routes GLB and GLTF scene items through the GLTF render target with visible controls', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const glbItem = item('glb', 'workflows/world.glb')
    const gltfItem = item('gltf', 'workflows/world.gltf')

    assert.deepEqual(module.getWorldSceneItemRenderTarget(glbItem), {
      workspacePath: 'workflows/world.glb',
      kind: 'glb',
      loader: 'gltf',
      primitive: 'scene',
      cameraFit: 'bounds',
      visibleDescription: 'GLB/GLTF model scene',
    })
    assert.deepEqual(module.getWorldSceneItemRenderTarget(gltfItem), {
      workspacePath: 'workflows/world.gltf',
      kind: 'gltf',
      loader: 'gltf',
      primitive: 'scene',
      cameraFit: 'bounds',
      visibleDescription: 'GLB/GLTF model scene',
    })
    assert.deepEqual(module.describeWorldsViewerScene([glbItem, gltfItem]), {
      hasRenderableItems: true,
      hasGrid: true,
      hasOrbitControls: true,
      hasUnifiedKeyboardMovement: true,
      hasGizmo: true,
      hasSelection: false,
      selectedItemId: null,
      selectedItemIds: [],
      transformControls: null,
      unsupported: [],
      renderTargets: [
        {
          workspacePath: 'workflows/world.glb',
          kind: 'glb',
          loader: 'gltf',
          primitive: 'scene',
          cameraFit: 'bounds',
          visibleDescription: 'GLB/GLTF model scene',
        },
        {
          workspacePath: 'workflows/world.gltf',
          kind: 'gltf',
          loader: 'gltf',
          primitive: 'scene',
          cameraFit: 'bounds',
          visibleDescription: 'GLB/GLTF model scene',
        },
      ],
    })
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps Gaussian PLY experimental, disabled by default, and lazily loaded', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    const gaussianItem = item('gaussian-ply', 'workflows/gaussian.ply')

    assert.deepEqual(module.getWorldSceneItemRenderTarget(gaussianItem), {
      workspacePath: 'workflows/gaussian.ply',
      kind: 'gaussian-ply',
      loader: 'gaussian-ply',
      primitive: 'gaussian-splats',
      cameraFit: 'bounds',
      visibleDescription: 'Gaussian PLY splats',
    })
    assert.deepEqual(module.describeWorldsViewerScene([gaussianItem]).renderTargets, [{
      workspacePath: 'workflows/gaussian.ply',
      kind: 'gaussian-ply',
      loader: 'gaussian-ply',
      primitive: 'gaussian-splats',
      cameraFit: 'bounds',
      visibleDescription: 'Gaussian PLY splats',
    }])
    assert.equal(viewerSource.includes("import { WorldsGaussianPlyObject } from './WorldsGaussianPlyObject.tsx'"), false)
    assert.equal(viewerSource.includes("const module = await import('./WorldsGaussianPlyObject.tsx')"), true)
    assert.equal(viewerSource.includes("item.kind === 'gaussian-ply'"), true)
    assert.equal(viewerSource.includes('isWorldsGaussianPlyEnabled'), true)
    assert.equal(viewerSource.includes('if (!isWorldsGaussianPlyEnabled()) return null'), true)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps camera navigation state local with pan zoom look and keyboard controls', async () => {
  const { source, module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.deepEqual(module.WORLD_VIEWER_CAMERA_NAVIGATION, {
      modes: ['inspect', 'fly', 'run'],
      orbitControls: 'inspect-only',
      pointerLock: 'explicit-fly-run',
      keyboardMovement: 'viewer-scoped',
    })
    assert.equal(viewerSource.includes('WorldsViewportControlMode'), true)
    assert.equal(viewerSource.includes('useState(() => createWorldsCameraState())'), true)
    assert.equal(source.includes('WorldsViewportModeControl'), true)
    assert.equal(source.includes('WorldsViewportNavigationControls'), true)
    assert.equal(source.includes('WorldsCameraCollisionController'), false)
    assert.equal(source.includes('WorldsFlyCameraControls'), false)
    assert.equal(viewerSource.includes("controlMode === 'inspect'"), true)
    assert.equal(viewerSource.includes('inspectAuthoringEnabled'), true)
    assert.equal(viewerSource.includes('<OrbitControls'), true)
    assert.equal(viewerSource.includes('PointerLockControls'), false)
    assert.equal(viewerSource.includes('makeDefault'), true)
    assert.equal(viewerSource.includes('enableDamping'), true)
    assert.equal(viewerSource.includes('enableRotate={WORLD_VIEWER_ORBIT_CONTROLS.enableRotate}'), true)
    assert.equal(viewerSource.includes('inspectAuthoringEnabled ? <GizmoHelper'), true)
    assert.equal(viewerSource.includes('<SceneFitController\n              enabled={inspectAuthoringEnabled}'), true)
    assert.equal(viewerSource.includes('frameSceneToken={cameraState.resetToken}'), true)
    assert.equal(viewerSource.includes('cameraCollisionSyncRef'), false)
    assert.equal(viewerSource.includes('<WorldsCameraCollisionController'), false)
    assert.equal(viewerSource.indexOf('<OrbitControls') < viewerSource.indexOf('<WorldsViewportNavigationControls'), true)
    assert.equal(viewerSource.includes('WorldSceneItem') && viewerSource.includes('cameraState:'), false)
  } finally {
    await cleanup()
  }
})

test('mounted WorldsViewer Frame scene keeps actual navigation status canonical and releases owned modes without document writes', async () => {
  const loaded = await loadViewerInteractionModule(false, true, true)
  const host = mounted()
  const module = loaded.module as {
    WorldsViewer: ComponentType<Record<string, unknown>>
    fitTestCamera: THREE.PerspectiveCamera
    navigationTestDom: {
      ownerDocument: { pointerLockElement: unknown; exitPointerLockCalls: number; listenerCount: (type: string) => number }
      canvas: { emit: (type: string, event?: Record<string, unknown>) => unknown; requestPointerLockCalls: number; listenerCount: (type: string) => number }
    }
  }
  const canonicalStatus = 'Inspect mode. Orbit, pan, select, and edit.'
  const savedView = { position: [8, 5, 12] as [number, number, number], target: [0, 1, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number] }
  const documentWrites: string[] = []
  const write = (name: string) => () => { documentWrites.push(name) }
  const status = () => {
    const node = findHost(host.container, (candidate) => candidate.props['data-navigation-status'] === true)
    assert.ok(node, 'actual parent status must be observable through its mode-control boundary')
    return getHostText(node)
  }
  const button = (label: string) => {
    const node = findHost(host.container, (candidate) => candidate.props['aria-label'] === label)
    assert.ok(node, `${label} control must be mounted`)
    return node
  }
  const click = async (label: string) => {
    button(label).props.onClick()
    await settleMounted(host)
  }

  try {
    host.render(createElement(module.WorldsViewer, {
      project: projectDocument(), items: [], initialView: savedView,
      showAuthoringToolbar: false, showPlaybackControls: false, useStudioLights: false,
      onSelectItem: write('select-item'), onAddCollisionSurface: write('add-collision'),
      onCollisionEditModeChange: write('collision-edit'), onSelectCollisionSurface: write('select-collision'),
      onTransformModeChange: write('transform-mode'), onTransformItem: write('transform-item'),
      onTransformItems: write('transform-items'), onTransformCollisionSurface: write('transform-collision'),
      onRemoveCollisionSurface: write('remove-collision'), onRemoveItem: write('remove-item'),
      onToggleBaseSceneItem: write('toggle-base'), onCommitPendingSurfacePlacement: write('commit-placement'),
      onClearPendingSurfacePlacement: write('clear-placement'),
    }))
    await settleMounted(host)
    assert.equal(module.navigationTestDom.ownerDocument.listenerCount('pointerlockchange'), 1, 'the production navigation controller must own pointer-lock observation')
    assert.equal(module.navigationTestDom.canvas.listenerCount('pointerdown'), 1, 'the production navigation controller must own Canvas pointer input')
    assert.equal(status(), canonicalStatus)
    assert.deepEqual(module.fitTestCamera.position.toArray(), savedView.position)

    for (const changedPosition of [[30, 15, 25], [-9, -8, -7]]) {
      module.fitTestCamera.position.fromArray(changedPosition)
      await click('Frame scene')
      assert.equal(status(), canonicalStatus, 'repeated Inspect framing must not leave a stale transient status')
      assert.deepEqual(module.fitTestCamera.position.toArray(), savedView.position, 'the existing saved-view reset remains authoritative')
      assert.equal(button('inspect').props['aria-checked'], true)
    }

    for (const mode of ['fly', 'run'] as const) {
      await click(mode)
      assert.equal(button(mode).props['aria-checked'], true)
      module.navigationTestDom.canvas.emit('pointerdown', { button: 0 })
      await settleMounted(host)
      assert.equal(module.navigationTestDom.ownerDocument.pointerLockElement, module.navigationTestDom.canvas)
      assert.equal(status(), `${mode === 'fly' ? 'Fly' : 'Run'} mode. Pointer locked.`)
      module.fitTestCamera.position.set(20, 10, 15)
      await click('Frame scene')
      assert.equal(button('inspect').props['aria-checked'], true)
      assert.equal(module.navigationTestDom.ownerDocument.pointerLockElement, null, `${mode} pointer lock must be released by Frame scene`)
      assert.equal(status(), canonicalStatus)
      assert.deepEqual(module.fitTestCamera.position.toArray(), savedView.position)
    }

    assert.ok(module.navigationTestDom.ownerDocument.exitPointerLockCalls >= 2)
    assert.ok(module.navigationTestDom.canvas.requestPointerLockCalls >= 2)
    assert.deepEqual(documentWrites, [], 'camera navigation and framing must remain outside the canonical document command path')
  } finally {
    host.render(null)
    await loaded.cleanup()
  }
})

test('WorldsViewer pose playback uses useFrame refs instead of setInterval React state churn', async () => {
  const viewerSource = await readFile(viewerEntry, 'utf8')

  assert.equal(viewerSource.includes('setInterval'), false)
  assert.equal(viewerSource.includes('WorldsPlaybackFrameController'), true)
  assert.equal(viewerSource.includes('useFrame((_, delta)'), true)
  assert.equal(viewerSource.includes('playbackRef'), true)
})

test('WorldsViewportNavigationControls owns scoped Fly and Run input without global key listeners', async () => {
  const { module, cleanup } = await loadViewerModule()
  const navigationControlsSource = await readFile(navigationControlsEntry, 'utf8')
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(typeof module.WorldsViewportNavigationControls, 'function')
    assert.equal(navigationControlsSource.includes('PointerLockControls'), false)
    assert.equal(navigationControlsSource.includes("element.addEventListener('pointerdown'"), true)
    assert.equal(navigationControlsSource.includes("ownerDocument.addEventListener('mousemove'"), true)
    assert.equal(navigationControlsSource.includes("scope.addEventListener('keydown'"), true)
    assert.equal(navigationControlsSource.includes('window.addEventListener'), false)
    assert.equal(navigationControlsSource.includes('shouldHandleWorldCameraKeyInput'), true)
    assert.equal(navigationControlsSource.includes('applyWorldsFlyNavigation'), true)
    assert.equal(navigationControlsSource.includes('applyWorldsRunNavigation'), true)
    assert.equal(navigationControlsSource.includes('requestPointerLock'), true)
    assert.equal(navigationControlsSource.includes('exitPointerLock'), true)
    assert.equal(navigationControlsSource.includes('pointerLockedRef.current'), true)
    assert.equal(navigationControlsSource.includes("ownerWindow?.addEventListener('blur'"), true)
    assert.equal(navigationControlsSource.includes("scope.addEventListener('blur'"), true)
    assert.equal(navigationControlsSource.includes('getWorldsOrbitHandoffDistance'), true)
    assert.equal(navigationControlsSource.includes('updateWorldsViewportNavigationKeys'), true)
    assert.equal(navigationControlsSource.includes('WORLD_RUN_GROUND_FALLBACK_LABEL'), true)
    assert.equal(viewerSource.includes('ref={orbitControlsRef}'), true)
    assert.equal(viewerSource.includes('enabled={inspectAuthoringEnabled}'), true)
    assert.equal(viewerSource.includes('onPointerLockChange={setPointerLocked}'), true)
  } finally {
    await cleanup()
  }
})

test('mounted navigation jumps on the first grounded Run frame at and above 60 FPS', async () => {
  const { module, cleanup } = await loadNavigationControlsModule()
  const floor = createWorldCollisionSurfacePreset('floor', {
    id: 'mounted-run-floor',
    rectGeometry: { halfWidth: 20, halfHeight: 20 },
  })
  assert.ok(floor)
  const collisionSurfaces = normalizeWorldSceneCollisionSurfaces([floor])

  try {
    for (const delta of [1 / 120, 1 / 60, 1 / 59, 1 / 30]) {
      const host = mounted()
      const dom = createNavigationTestDom()
      const camera = new THREE.PerspectiveCamera()
      camera.position.set(0, 0.9, 0)
      module.configureNavigationTestThree({ camera, gl: { domElement: dom.canvas } })
      host.render(createElement(module.WorldsViewportNavigationControls, {
        mode: 'run',
        collisionSurfaces,
        inputScopeRef: { current: dom.scope as unknown as HTMLElement },
        orbitControlsRef: { current: null },
        frameSceneToken: 0,
        onModeChange: () => undefined,
        onPointerLockChange: () => undefined,
        onStatusChange: () => undefined,
      }))

      dom.canvas.emit('pointerdown', { button: 0 })
      const jump = createNavigationKeyboardEvent('Space', dom.scope)
      dom.scope.emit('keydown', jump.event)
      assert.equal(jump.defaultPrevented(), true)
      module.advanceNavigationTestFrame(delta)
      assert.ok(camera.position.y > 0.9, `first Run frame must jump at delta ${delta}`)

      host.render(null)
    }
  } finally {
    await cleanup()
  }
})

test('mounted navigation preserves authoritative pointer lock across Fly Run and cleans up every owner boundary', async () => {
  const { module, cleanup } = await loadNavigationControlsModule()
  const host = mounted()
  const dom = createNavigationTestDom()
  const camera = new THREE.PerspectiveCamera()
  const pointerChanges: boolean[] = []
  const statuses: string[] = []
  const commonProps = {
    collisionSurfaces: [],
    inputScopeRef: { current: dom.scope as unknown as HTMLElement },
    orbitControlsRef: { current: null },
    frameSceneToken: 0,
    onModeChange: () => undefined,
    onPointerLockChange: (locked: boolean) => { pointerChanges.push(locked) },
    onStatusChange: (status: string) => { statuses.push(status) },
  }
  module.configureNavigationTestThree({ camera, gl: { domElement: dom.canvas } })

  try {
    host.render(createElement(module.WorldsViewportNavigationControls, { ...commonProps, mode: 'fly' }))
    dom.canvas.emit('pointerdown', { button: 0 })
    assert.equal(dom.ownerDocument.pointerLockElement, dom.canvas)
    assert.equal(pointerChanges.at(-1), true)
    assert.equal(statuses.filter((status) => status === 'Fly mode. Pointer locked.').length, 1)

    pointerChanges.length = 0
    host.render(createElement(module.WorldsViewportNavigationControls, { ...commonProps, mode: 'run' }))
    assert.equal(dom.ownerDocument.pointerLockElement, dom.canvas)
    assert.deepEqual(pointerChanges, [true], 'mode handoff must republish the retained real lock')
    assert.equal(statuses.at(-1), 'Run mode. Pointer locked.')

    dom.ownerDocument.defaultView.emit('blur')
    assert.equal(dom.ownerDocument.pointerLockElement, null)
    assert.equal(pointerChanges.at(-1), false)

    dom.canvas.emit('pointerdown', { button: 0 })
    assert.equal(dom.ownerDocument.pointerLockElement, dom.canvas)
    host.render(null)
    assert.equal(dom.ownerDocument.pointerLockElement, null)
    assert.equal(pointerChanges.at(-1), false)
    assert.ok(dom.ownerDocument.exitPointerLockCalls >= 2)
  } finally {
    host.render(null)
    await cleanup()
  }
})

test('mounted viewport key bubbling leaves native interactive controls in control', async () => {
  const { module, cleanup } = await loadNavigationControlsModule()
  const host = mounted()
  const dom = createNavigationTestDom()
  const camera = new THREE.PerspectiveCamera()
  const frameSceneButton = new NavigationTestNode(dom.ownerDocument, 'BUTTON')
  dom.scope.append(frameSceneButton)
  const modeChanges: string[] = []
  module.configureNavigationTestThree({ camera, gl: { domElement: dom.canvas } })

  try {
    host.render(createElement(module.WorldsViewportNavigationControls, {
      mode: 'fly',
      collisionSurfaces: [],
      inputScopeRef: { current: dom.scope as unknown as HTMLElement },
      orbitControlsRef: { current: null },
      frameSceneToken: 0,
      onModeChange: (mode) => { modeChanges.push(mode) },
      onPointerLockChange: () => undefined,
      onStatusChange: () => undefined,
    }))
    frameSceneButton.focus()

    const enter = createNavigationKeyboardEvent('Enter', frameSceneButton)
    dom.scope.emit('keydown', enter.event)
    assert.equal(enter.defaultPrevented(), false)
    assert.equal(dom.requestPointerLockCalls(), 0)

    const shortcut = createNavigationKeyboardEvent('Digit3', frameSceneButton)
    dom.scope.emit('keydown', shortcut.event)
    assert.equal(shortcut.defaultPrevented(), false)
    assert.deepEqual(modeChanges, [])
  } finally {
    host.render(null)
    await cleanup()
  }
})

test('mounted canonical Run consumes only current Worker camera poses and terminates on pointer, mode, revision and Play boundaries', async () => {
  const { module, cleanup } = await loadNavigationControlsModule()
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  const workers: NavigationWorker[] = []
  // Transport/lifecycle proof only. Real KCC behavior is tested in worldRapierRuntime.test.ts.
  class NavigationWorker {
    messages: Record<string, any>[] = []
    listeners = new Set<(event: { data: unknown }) => void>()
    terminated = false
    constructor() { workers.push(this) }
    postMessage(message: Record<string, any>) { this.messages.push(message) }
    addEventListener(type: string, callback: (event: { data: unknown }) => void) { if (type === 'message') this.listeners.add(callback) }
    removeEventListener(type: string, callback: (event: { data: unknown }) => void) { if (type === 'message') this.listeners.delete(callback) }
    terminate() { this.terminated = true }
    emit(data: unknown) { for (const callback of this.listeners) callback({ data }) }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: NavigationWorker })
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  try {
    for (const boundary of ['pointer', 'fly', 'inspect', 'revision', 'play', 'unmount']) {
      const host = mounted()
      const dom = createNavigationTestDom()
      const camera = new THREE.PerspectiveCamera()
      camera.position.set(0, 3, 6)
      camera.quaternion.setFromEuler(new THREE.Euler(0.25, 0.6, 0.4, 'YXZ'))
      const snapshot = createRuntimeWorldSnapshot()
      const before = structuredClone(snapshot)
      let current = true
      const statuses: string[] = []
      const runCollisionInput = { snapshot, sceneId: 'scene:one', apiUrl: '', isCurrent: () => current }
      const props = { mode: 'run' as const, collisionSurfaces: [], runCollisionInput,
        inputScopeRef: { current: dom.scope as unknown as HTMLElement }, orbitControlsRef: { current: null }, frameSceneToken: 0,
        onModeChange: () => {}, onPointerLockChange: () => {}, onStatusChange: (status: string) => { statuses.push(status) } }
      module.configureNavigationTestThree({ camera, gl: { domElement: dom.canvas } })
      host.render(createElement(module.WorldsViewportNavigationControls, { ...props, mode: 'fly' }))
      dom.canvas.emit('pointerdown', { button: 0 })
      module.advanceNavigationTestFrame(1 / 60)
      assert.ok(Math.abs(new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').z - 0.4) < 1e-6, 'Fly must retain its roll')
      host.render(createElement(module.WorldsViewportNavigationControls, props))
      module.advanceNavigationTestFrame(1 / 60)
      assert.deepEqual(camera.position.toArray(), [0, 3, 6])
      assert.equal(statuses.at(-1), 'Run mode. Preparing collisions…')
      const preparingLook = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
      assert.ok(Math.abs(preparingLook.z) < 1e-6, 'Preparing Run must level Fly roll')
      assert.ok(Math.abs(preparingLook.x - 0.25) < 1e-6 && Math.abs(preparingLook.y - 0.6) < 1e-6, 'Run must retain pitch and yaw')
      await flush()
      const worker = workers.at(-1)!
      const generationId = worker.messages[0].generationId
      assert.ok(worker.messages[0].navigation)
      assert.ok(worker.messages[0].scene.bodies.every((body: any) => body.bodyType === 'fixed' && !body.controller))
      worker.emit({ version: 1, kind: 'ready', generationId, entityIds: [] }); await flush()
      module.advanceNavigationTestFrame(1 / 60)
      worker.emit({ version: 1, kind: 'navigation-pose', generationId, sequence: 1, position: [0, 1.66, 5.95], grounded: true, recovered: false })
      module.advanceNavigationTestFrame(1 / 60)
      assert.deepEqual(camera.position.toArray(), [0, 1.66, 5.95])
      assert.equal(statuses.at(-1), 'Run mode. Collider-backed.')
      assert.ok(Math.abs(new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').z) < 1e-6, 'Ready Run must remain level')
      if (boundary === 'pointer') dom.ownerDocument.exitPointerLock()
      else if (boundary === 'unmount') host.render(null)
      else if (boundary === 'fly' || boundary === 'inspect') host.render(createElement(module.WorldsViewportNavigationControls, { ...props, mode: boundary }))
      else { current = false; module.advanceNavigationTestFrame(1 / 60) }
      assert.equal(worker.terminated, true, boundary)
      const position = camera.position.toArray()
      worker.emit({ version: 1, kind: 'navigation-pose', generationId, sequence: 2, position: [99, 99, 99], grounded: true, recovered: false })
      assert.deepEqual(camera.position.toArray(), position)
      assert.deepEqual(snapshot, before)
      host.render(null)
    }
  } finally {
    if (previousWorker) Object.defineProperty(globalThis, 'Worker', previousWorker)
    else Reflect.deleteProperty(globalThis, 'Worker')
    await cleanup()
  }
})

test('mounted empty canonical Run levels Fly roll and delivers its visible Ground-only toolbar badge', async () => {
  const controls = await loadNavigationControlsModule()
  const toolbar = await loadModeControlModule()
  const host = mounted()
  const toolbarHost = mounted()
  const dom = createNavigationTestDom()
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(0, 3, 6)
  camera.quaternion.setFromEuler(new THREE.Euler(0.25, 0.6, 0.4, 'YXZ'))
  const statuses: string[] = []
  const props = {
    collisionSurfaces: [], inputScopeRef: { current: dom.scope as unknown as HTMLElement }, orbitControlsRef: { current: null }, frameSceneToken: 0,
    runCollisionInput: { snapshot: createRuntimeWorldSnapshot(), sceneId: 'scene:two', apiUrl: '', isCurrent: () => true },
    onModeChange: () => {}, onPointerLockChange: () => {}, onStatusChange: (status: string) => { statuses.push(status) },
  }
  controls.module.configureNavigationTestThree({ camera, gl: { domElement: dom.canvas } })
  try {
    host.render(createElement(controls.module.WorldsViewportNavigationControls, { ...props, mode: 'fly' }))
    dom.canvas.emit('pointerdown', { button: 0 })
    controls.module.advanceNavigationTestFrame(1 / 60)
    assert.ok(Math.abs(new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').z - 0.4) < 1e-6)
    host.render(createElement(controls.module.WorldsViewportNavigationControls, { ...props, mode: 'run' }))
    controls.module.advanceNavigationTestFrame(1 / 60)
    const status = statuses.at(-1)!
    toolbarHost.render(createElement(toolbar.module.WorldsViewportModeControl, { mode: 'run', status, pointerLocked: true, onModeChange: () => {}, onFrameScene: () => {} }))
    assert.ok(findHost(toolbarHost.container, node => node.type === 'span' && node.props['aria-hidden'] === 'true'), 'Actual Run status must show the visible Ground-only badge')
    assert.equal(status, `Run mode. ${WORLD_RUN_GROUND_FALLBACK_LABEL}.`)
    assert.equal(WORLD_RUN_GROUND_FALLBACK_LABEL, 'Ground-only fallback — no eligible colliders')
    const look = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
    assert.ok(Math.abs(look.z) < 1e-6, 'Empty Run must level Fly roll')
    assert.ok(Math.abs(look.x - 0.25) < 1e-6 && Math.abs(look.y - 0.6) < 1e-6, 'Empty Run must retain pitch/yaw')
  } finally { host.render(null); toolbarHost.render(null); await controls.cleanup(); await toolbar.cleanup() }
})

test('WorldsViewer retires drag-look and enables Orbit rotation only for Inspect', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(typeof module.WorldsViewportNavigationControls, 'function')
    assert.equal(viewerSource.includes('WorldsMouseLookCameraControls'), false)
    assert.equal(viewerSource.includes('WorldsKeyboardCameraControls'), false)
    assert.equal(viewerSource.includes('enableRotate: true'), true)
    assert.equal(viewerSource.includes('enabled={inspectAuthoringEnabled}'), true)
    assert.equal(viewerSource.includes('<WorldsViewportNavigationControls'), true)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer exposes selection state and a local transform toolbar contract', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.deepEqual(module.WORLD_VIEWER_TRANSFORM_CONTROLS, {
      modes: ['translate', 'rotate', 'scale'],
      placement: 'right-canvas-toolbar',
      disabledUntilSelection: true,
      backendBake: false,
    })
    assert.deepEqual(module.describeWorldsViewerScene([item('ply-mesh', 'mesh.ply')], [], 'world:mesh.ply', ['world:mesh.ply', 'world:ghost.ply']), {
      hasRenderableItems: true,
      hasGrid: true,
      hasOrbitControls: true,
      hasUnifiedKeyboardMovement: true,
      hasGizmo: true,
      hasSelection: true,
      selectedItemId: 'world:mesh.ply',
      selectedItemIds: ['world:mesh.ply'],
      transformControls: {
        modes: ['translate', 'rotate', 'scale'],
        attachedItemId: 'world:mesh.ply',
      },
      unsupported: [],
      renderTargets: [
        {
          workspacePath: 'mesh.ply',
          kind: 'ply-mesh',
          loader: 'ply',
          primitive: 'mesh',
          cameraFit: 'bounds',
          visibleDescription: 'PLY mesh geometry',
        },
      ],
    })
    assert.equal(viewerSource.includes('WorldsTransformToolbar'), true)
    assert.equal(viewerSource.includes('items={visibleItems}'), true)
    assert.equal(viewerSource.includes('const resolvedCollisionSurfaces = useMemo('), true)
    assert.equal(viewerSource.includes('collisionSurfaces={resolvedCollisionSurfaces}'), true)
    assert.equal(viewerSource.includes('collisionEditMode={collisionEditMode}'), true)
    assert.equal(viewerSource.includes('selectedCollisionSurfaceId={selectedCollisionSurfaceId}'), true)
    assert.equal(viewerSource.includes('selectedItemIds={normalizedSelectedItemIds}'), true)
    assert.equal(viewerSource.includes('onAddCollisionSurface={onAddCollisionSurface}'), true)
    assert.equal(viewerSource.includes('onCollisionEditModeChange={onCollisionEditModeChange}'), true)
    assert.equal(viewerSource.includes('onSelectCollisionSurface={onSelectCollisionSurface}'), true)
    assert.equal(viewerSource.includes('const selectCollisionSurfaceFromCanvas = useCallback((surfaceId: string | null) => {'), true)
    assert.equal(viewerSource.includes('onSelectCollisionSurface(surfaceId)'), true)
    assert.equal(viewerSource.includes('WorldCollisionSurfaceLayer'), true)
    assert.equal(viewerSource.includes('onTransformSurface={onTransformCollisionSurface}'), true)
    assert.equal(viewerSource.includes('const selectedItems = useMemo(() => visibleItems.filter((item) => selectedItemIdSet.has(item.id))'), true)
    assert.equal(viewerSource.includes('onRemoveItem={onRemoveItem}'), true)
    assert.equal(viewerSource.includes('onRemoveCollisionSurface={onRemoveCollisionSurface}'), true)
    assert.equal(viewerSource.includes('onToggleBaseSceneItem={onToggleBaseSceneItem}'), true)
    assert.equal(viewerSource.includes('onSceneItemAnchorChange={onSceneItemAnchorChange}'), true)
    assert.equal(viewerSource.includes('setFocusRequest'), true)
    assert.equal(viewerSource.includes('focusSceneItemFromCanvas'), true)
    assert.equal(viewerSource.includes('boundsRef.current.setFromObject(groupRef.current)'), false)
    assert.equal(viewerSource.includes('TransformControls'), true)
    assert.equal(viewerSource.includes('transformDraggingRef'), true)
    assert.equal(viewerSource.includes('if (transformDraggingRef.current) return'), true)
    assert.equal(viewerSource.includes('suppressSelectionUntilRef'), true)
    assert.equal(viewerSource.includes('Date.now() < suppressSelectionUntilRef.current'), true)
    assert.equal(viewerSource.includes('selectedItems={selectedItems}'), true)
    assert.equal(viewerSource.includes('onTransformItems={onTransformItems}'), true)
    assert.equal(viewerSource.includes('onTransformCollisionSurface = () => undefined'), true)
    assert.equal(viewerSource.includes('createWorldSceneSelectionTransformUpdates'), true)
    assert.equal(viewerSource.includes('const dragSessionRef = useRef<{'), true)
    assert.equal(viewerSource.includes('lastValidTransforms: WorldSceneItemTransformUpdate[]'), true)
    assert.equal(viewerSource.includes('localBoundsByItemId: Map<string, WorldsCollisionBounds | null>'), true)
    assert.equal(viewerSource.includes('const sceneItemLocalBoundsRef = useRef(new Map<string, WorldsCollisionBounds | null>())'), true)
    assert.equal(viewerSource.includes("import { resolveWorldsSurfacePlacement } from '../worldsSurfacePlacement.ts'"), true)
    assert.equal(viewerSource.includes('export function resolveWorldsTransformPreview({'), true)
    assert.equal(viewerSource.includes('export function isWorldsBatchTransformSnapshot(snapshot: WorldSceneTransformSnapshot[] | null)'), true)
    assert.equal(viewerSource.includes('const cancelActiveDragSession = useCallback(() => {'), true)
    assert.equal(viewerSource.includes('latestDragLifecycleRef.current.onTransformGestureCancel(session.gesture)'), true)
    assert.equal(viewerSource.includes('collisionSafe: true'), true)
    assert.equal(viewerSource.includes('collisionSafe: false'), true)
    assert.equal(viewerSource.includes('session.lastValidTransforms = preview.updates.map(cloneTransformUpdate)'), true)
    assert.equal(viewerSource.includes('takeSnapshot()'), true)
    assert.equal(viewerSource.includes('onDragEndSelectionBlock={handleTransformDragEnd}'), true)
    assert.equal(viewerSource.includes('onDragEndSelectionBlock()'), true)
    assert.equal(viewerSource.includes('previewTransform()'), true)
    assert.equal(viewerSource.includes('commitTransform()'), true)
    assert.equal(viewerSource.includes('collisionSurfaces={resolvedCollisionSurfaces}'), true)
    assert.equal(viewerSource.includes('collisionSurfaces: [...collisionSurfaces]'), true)
    assert.equal(viewerSource.includes('resolveWorldsSceneItemIdFromIntersections'), true)
    assert.equal(viewerSource.includes('onDoubleClick={handleDoubleClick}'), true)
    assert.equal(viewerSource.includes('<SceneFocusController'), true)
    assert.equal(viewerSource.includes('focusWorldsCameraOnObject'), true)
    assert.equal(viewerSource.includes('BoxHelper'), false)
    assert.equal(viewerSource.includes('<EffectComposer'), false)
    assert.equal(viewerSource.includes('WorldViewportGraphics'), true)
    assert.equal(viewerSource.includes('selectedObjects={['), true)
    assert.equal(viewerSource.includes('xRay={false}'), false)
    assert.equal(viewerSource.includes('autoClear={false}'), false)
    assert.equal(viewerSource.includes('WorldsSelectionSilhouette'), true)
    assert.equal(viewerSource.includes('selectedSceneObjects.secondaryObjects.map'), true)
    assert.equal(viewerSource.includes('resolveWorldsSelectedSceneObjects(sceneObjectsRef.current, normalizedSelectedItemIds, selectedItemId)'), true)
    assert.equal(viewerSource.includes('WORLD_SELECTION_SECONDARY_SILHOUETTE_COLOR'), true)
    assert.equal(viewerSource.includes('WORLD_SELECTION_ACTIVE_SILHOUETTE_COLOR'), true)
    assert.equal(viewerSource.includes('THREE.BackSide'), true)
    assert.equal(viewerSource.includes('child instanceof THREE.Points'), true)
    assert.equal(viewerSource.includes('new THREE.PointsMaterial({'), true)
    assert.equal(viewerSource.includes('worldsSelectionSilhouette'), true)
    assert.equal(viewerSource.includes('Select enabled={selected}'), true)
    assert.equal(viewerSource.includes('toggle: isWorldsMultiSelectToggleGesture(event.nativeEvent)'), true)
    assert.equal(viewerSource.includes('computeBoundsTree'), true)
    assert.equal(viewerSource.includes('acceleratedRaycast'), true)
    assert.equal(viewerSource.includes('SkeletonUtils'), true)
    assert.equal(viewerSource.includes('createWorldsGltfSceneInstance(sourceScene)'), true)
    assert.equal(viewerSource.includes('cloneWorldsSceneMaterialsForInstance(scene)'), true)
    assert.equal(viewerSource.includes('clone.side = THREE.DoubleSide'), true)
    assert.equal(viewerSource.includes('WorldsSelectionHitbox'), true)
    assert.equal(viewerSource.includes('worldsSelectionHitbox'), true)
    assert.equal(viewerSource.includes('worldsCollisionSurface'), true)
    assert.equal(viewerSource.includes('onSelect()'), false)
    assert.equal(viewerSource.includes('calculateWorldsSelectionBounds'), true)
    assert.equal(viewerSource.includes('measureWorldsObjectBounds'), true)
    assert.equal(viewerSource.includes('const [selectedBoundsVersion, setSelectedBoundsVersion] = useState(0)'), true)
    assert.equal(viewerSource.includes('boundsVersion={item.id === selectedItemId ? selectedBoundsVersion : 0}'), true)
    assert.equal(viewerSource.includes('onBoundsChange={invalidateSelectedBounds}'), true)
    assert.equal(viewerSource.includes('useFrame(() => {\n    const hitbox = hitboxRef.current'), false)
    assert.equal(viewerSource.includes('useFrame(() => {\n    if (!groupRef.current) return'), false)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps batch transform snapshots alive during drag and only batches multi-item snapshots', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.equal(module.shouldResetWorldsTransformSnapshot(true), false)
    assert.equal(module.shouldResetWorldsTransformSnapshot(false), true)
    assert.equal(module.isWorldsBatchTransformSnapshot(null), false)
    assert.equal(module.isWorldsBatchTransformSnapshot([]), false)
    assert.equal(module.isWorldsBatchTransformSnapshot([{ itemId: 'world:active', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }]), false)
    assert.equal(module.isWorldsBatchTransformSnapshot([
      { itemId: 'world:active', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { itemId: 'world:secondary', transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    ]), true)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer resolves floor wall and ramp previews through planar surface placement', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const floor = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('floor', {
      id: 'floor',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const floorPreview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0.7, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0, 0.7, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: floor,
    })

    assert.equal(floorPreview.valid, true)
    assert.equal(floorPreview.reason, 'snapped')
    assert.equal(floorPreview.snappedSurfaceId, 'floor')
    assert.equal(floorPreview.collisionSafe, true)
    assert.ok(Math.abs(floorPreview.updates[0]!.transform.position[1] - 0.5001) < 5e-4)

    const wall = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('wall', {
      id: 'wall',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const wallPreview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0, -0.75], rotation: [0, 0.25, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0, 0, -0.75], rotation: [0, 0.25, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: wall,
    })

    assert.equal(wallPreview.valid, true)
    assert.equal(wallPreview.reason, 'snapped')
    assert.equal(wallPreview.snappedSurfaceId, 'wall')
    assert.ok(wallPreview.updates[0]!.transform.position[2] > -0.76)
    assert.ok(wallPreview.updates[0]!.transform.position[2] < -0.45)
    assert.equal(wallPreview.updates[0]?.transform.rotation[1], 0.25)

    const ramp = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('ramp', {
      id: 'ramp',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const rampPreview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: ramp,
    })

    assert.equal(rampPreview.valid, true)
    assert.equal(rampPreview.reason, 'snapped')
    assert.equal(rampPreview.snappedSurfaceId, 'ramp')
    assert.ok(Math.abs(rampPreview.correctionDelta[1]) > 0.05)
    assert.ok(Math.abs(rampPreview.correctionDelta[2]) > 0.05)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer snaps translate previews to base-scene mesh support within drag threshold', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const active = item('glb', 'active.glb')
    active.id = 'active'
    const base = item('glb', 'base.glb')
    base.id = 'base'
    base.role = 'base-scene'
    const preview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: [],
      sceneItems: [active, base],
      sceneObjects: new Map([
        ['base', createRootWithMesh(createTriangleMesh([
          [0, 0, 0],
          [2, 0, 0],
          [0, 0, 2],
        ]))],
      ]),
    })

    assert.equal(preview.valid, true)
    assert.equal(preview.reason, 'snapped')
    assert.ok(Math.abs(preview.updates[0]!.transform.position[1] - 0.5001) < 5e-4)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps translate previews unchanged when base support exceeds the drag snap threshold', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const active = item('glb', 'active.glb')
    active.id = 'active'
    const base = item('glb', 'base.glb')
    base.id = 'base'
    base.role = 'base-scene'
    const preview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0.25, 1.2, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0.25, 1.2, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: [],
      sceneItems: [active, base],
      sceneObjects: new Map([
        ['base', createRootWithMesh(createTriangleMesh([
          [0, 0, 0],
          [2, 0, 0],
          [0, 0, 2],
        ]))],
      ]),
    })

    assert.equal(preview.valid, true)
    assert.equal(preview.reason, 'free')
    assert.deepEqual(preview.updates[0]!.transform.position, [0.25, 1.2, 0.25])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer applies one shared base-scene correction during multi-select translate and preserves offsets', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const active = item('glb', 'active.glb')
    active.id = 'active'
    const secondary = item('glb', 'secondary.glb')
    secondary.id = 'secondary'
    const base = item('glb', 'base.glb')
    base.id = 'base'
    base.role = 'base-scene'
    const preview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [
        { itemId: 'active', transform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { itemId: 'secondary', transform: { position: [1.75, 0.87, 0.25], rotation: [0, 0.3, 0], scale: [1, 1, 1] } },
      ],
      activeTransform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
        ['secondary', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: [],
      sceneItems: [active, secondary, base],
      sceneObjects: new Map([
        ['base', createRootWithMesh(createTriangleMesh([
          [0, 0, 0],
          [3, 0, 0],
          [0, 0, 3],
        ]))],
      ]),
    })

    assert.equal(preview.valid, true)
    assert.equal(preview.reason, 'snapped')
    assert.deepEqual([
      Number((preview.updates[1]!.transform.position[0] - preview.updates[0]!.transform.position[0]).toFixed(4)),
      Number((preview.updates[1]!.transform.position[1] - preview.updates[0]!.transform.position[1]).toFixed(4)),
      Number((preview.updates[1]!.transform.position[2] - preview.updates[0]!.transform.position[2]).toFixed(4)),
    ], [1.5, 0.25, 0])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps authored blockers authoritative and skips base support for rotate scale or missing base meshes', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const floor = item('glb', 'base.glb')
    floor.id = 'base'
    floor.role = 'base-scene'
    const active = item('glb', 'active.glb')
    active.id = 'active'
    const wall = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('wall', {
      id: 'wall',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])

    const blockedTranslate = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0.62, -1], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0, 0.62, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: wall,
      sceneItems: [active, floor],
      sceneObjects: new Map([
        ['base', createRootWithMesh(createTriangleMesh([
          [0, 0, 0],
          [3, 0, 0],
          [0, 0, 3],
        ]))],
      ]),
    })
    assert.equal(blockedTranslate.reason, 'blocked')
    assert.ok(Math.abs(blockedTranslate.updates[0]!.transform.position[2] + 0.5001) < 5e-4)

    const rotatePreview = module.resolveWorldsTransformPreview({
      mode: 'rotate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0.25, 0.62, 0.25], rotation: [0, 0.4, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: [],
      sceneItems: [active, floor],
      sceneObjects: new Map([
        ['base', createRootWithMesh(createTriangleMesh([
          [0, 0, 0],
          [2, 0, 0],
          [0, 0, 2],
        ]))],
      ]),
    })
    assert.deepEqual(rotatePreview.updates[0]!.transform.position, [0.25, 0.62, 0.25])

    const noBasePreview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0.25, 0.62, 0.25], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: [],
      sceneItems: [active],
      sceneObjects: new Map(),
    })
    assert.deepEqual(noBasePreview.updates[0]!.transform.position, [0.25, 0.62, 0.25])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer blocks unsafe translate rotate and scale previews while preserving the last valid pose', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const wall = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('wall', {
      id: 'wall',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const translatePreview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0, -1], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      activeTransform: { position: [0, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: wall,
    })
    assert.equal(translatePreview.valid, true)
    assert.equal(translatePreview.reason, 'blocked')
    assert.ok(Math.abs(translatePreview.updates[0]!.transform.position[2] + 0.5001) < 5e-4)

    const rotatePreview = module.resolveWorldsTransformPreview({
      mode: 'rotate',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0, -0.35], rotation: [0, 0, 0], scale: [1, 1, 0.2] } }],
      activeTransform: { position: [0, 0, -0.35], rotation: [0, Math.PI / 4, 0], scale: [1, 1, 0.2] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -1, y: -0.5, z: -0.2 }, max: { x: 1, y: 0.5, z: 0.2 } }],
      ]),
      collisionSurfaces: wall,
    })
    assert.equal(rotatePreview.valid, false)
    assert.equal(rotatePreview.reason, 'blocked')
    assert.deepEqual(rotatePreview.updates[0]?.transform.rotation, [0, 0, 0])
    assert.equal(rotatePreview.snappedZoneId, null)

    const blockedScalePreview = module.resolveWorldsTransformPreview({
      mode: 'scale',
      activeItemId: 'active',
      snapshot: [{ itemId: 'active', transform: { position: [0, 0, -0.4], rotation: [0, 0, 0], scale: [1, 1, 0.2] } }],
      activeTransform: { position: [0, 0, -0.4], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: wall,
    })
    assert.equal(blockedScalePreview.valid, false)
    assert.equal(blockedScalePreview.reason, 'blocked')
    assert.deepEqual(blockedScalePreview.updates[0]?.transform.scale, [1, 1, 0.2])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps multi-select previews on one shared resolved transform set', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const wall = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('wall', {
      id: 'wall',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const preview = module.resolveWorldsTransformPreview({
      mode: 'translate',
      activeItemId: 'active',
      snapshot: [
        { itemId: 'active', transform: { position: [0, 0, -1], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { itemId: 'secondary', transform: { position: [1.5, 0.25, -1], rotation: [0, 0.3, 0], scale: [1, 1, 1] } },
      ],
      activeTransform: { position: [0.5, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      localBoundsByItemId: new Map([
        ['active', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
        ['secondary', { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }],
      ]),
      collisionSurfaces: wall,
    })

    assert.equal(preview.valid, true)
    assert.equal(preview.reason, 'blocked')
    assert.deepEqual(preview.updates.map((entry: { itemId: string }) => entry.itemId), ['active', 'secondary'])
    assert.deepEqual([
      Number((preview.updates[1]!.transform.position[0] - preview.updates[0]!.transform.position[0]).toFixed(4)),
      Number((preview.updates[1]!.transform.position[1] - preview.updates[0]!.transform.position[1]).toFixed(4)),
      Number((preview.updates[1]!.transform.position[2] - preview.updates[0]!.transform.position[2]).toFixed(4)),
    ], [1.5, 0.25, 0])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer falls back deterministically when bounds are missing instead of freezing preview', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const wall = normalizeWorldSceneCollisionSurfaces([createWorldCollisionSurfacePreset('wall', {
      id: 'wall',
      rectGeometry: { halfWidth: 4, halfHeight: 4 },
    })!])
    const preview = module.resolveWorldsTransformPreview({
      mode: 'scale',
      activeItemId: 'active',
      snapshot: [
        { itemId: 'active', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { itemId: 'secondary', transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
      activeTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 1] },
      localBoundsByItemId: new Map(),
      collisionSurfaces: wall,
    })

    assert.equal(preview.valid, true)
    assert.equal(preview.reason, 'free')
    assert.equal(preview.collisionSafe, false)
    assert.deepEqual(preview.updates[1]?.transform.position, [4, 0, 0])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer commits parent callbacks only on mouse up and never during object-change preview', async () => {
  const viewerSource = await readFile(viewerEntry, 'utf8')

  assert.equal(viewerSource.includes('onObjectChange={() => {\n        previewTransform()\n      }}'), true)
  assert.equal(viewerSource.includes('onObjectChange={() => {\n        previewTransform()\n        commitTransform()'), false)
  assert.equal(viewerSource.includes('onMouseUp={() => {\n        draggingRef.current = false\n        onDragEndSelectionBlock()\n        commitTransform()\n        onBoundsChange()\n        dragSessionRef.current = null\n      }}'), true)
  assert.equal(viewerSource.includes('resolveWorldsPendingSurfacePlacementDecision'), true)
  assert.equal(viewerSource.includes('onCommitPendingSurfacePlacement(pendingItemId, decision.transform)'), true)
  assert.equal(viewerSource.includes('onClearPendingSurfacePlacement()'), true)
  assert.equal(viewerSource.includes('Pending placement'), false)
})

test('WorldsViewer resolves active and secondary scene objects for multi-select feedback without duplicating the active item', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const active = new THREE.Group()
    const secondary = new THREE.Group()
    const ignored = new THREE.Group()
    const sceneObjects = new Map<string, THREE.Object3D>([
      ['world:active', active],
      ['world:secondary', secondary],
      ['world:ignored', ignored],
    ])

    assert.deepEqual(module.resolveWorldsSelectedSceneObjects(sceneObjects, ['world:secondary', 'world:active', 'world:secondary', 'world:missing'], 'world:active'), {
      activeObject: active,
      secondaryObjects: [secondary],
    })
    assert.deepEqual(module.resolveWorldsSelectedSceneObjects(sceneObjects, ['world:secondary'], 'world:missing'), {
      activeObject: null,
      secondaryObjects: [secondary],
    })
  } finally {
    await cleanup()
  }
})

test('WorldsViewer resolves selection from real mesh intersections before expanded hitboxes', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const itemGroup = new THREE.Group()
    itemGroup.userData.worldsSceneItemId = 'world:real-mesh'
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    itemGroup.add(mesh)

    const hitbox = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial())
    hitbox.userData.worldsSelectionHitbox = true
    hitbox.userData.worldsSceneItemId = 'world:hitbox'
    const silhouette = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial())
    silhouette.userData.worldsSelectionSilhouette = true
    silhouette.userData.worldsSceneItemId = 'world:silhouette'

    assert.equal(module.resolveWorldsSceneItemIdFromObject(mesh), 'world:real-mesh')
    assert.equal(module.resolveWorldsSceneItemIdFromObject(hitbox), null)
    assert.equal(module.resolveWorldsSceneItemIdFromObject(silhouette), null)
    assert.equal(module.resolveWorldsSceneItemIdFromIntersections([{ object: hitbox }, { object: silhouette }, { object: mesh }], 'world:fallback'), 'world:real-mesh')
    assert.equal(module.resolveWorldsSceneItemIdFromIntersections([{ object: hitbox }], 'world:fallback'), 'world:fallback')
  } finally {
    await cleanup()
  }
})

test('WorldsViewer computes an expanded invisible bounds hitbox for easy asset reselection', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const target = new THREE.Group()
    target.position.set(4, 0, -2)
    const narrowMesh = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.2), new THREE.MeshBasicMaterial())
    target.add(narrowMesh)
    target.updateWorldMatrix(true, true)

    const bounds = module.calculateWorldsSelectionBounds(target)
    assert.ok(bounds)
    assert.deepEqual(bounds.center.toArray(), [4, 0, -2])
    assert.deepEqual(bounds.size.toArray(), [0.3, 0.3, 0.3])

    narrowMesh.userData.worldsSelectionHitbox = true
    assert.equal(module.calculateWorldsSelectionBounds(target), null)
  } finally {
    await cleanup()
  }
})

test('Fly and Run mode gates selection and transform gizmo pointer authority', async () => {
  const { cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(viewerSource.includes('inspectAuthoringEnabled'), true)
    assert.equal(viewerSource.includes('onPointerMissed={inspectAuthoringEnabled ? handleCanvasPointerMissed : undefined}'), true)
    assert.equal(viewerSource.includes('selectedObject && transformMode && !selectedCollisionSurfaceId && inspectAuthoringEnabled'), true)
    assert.equal(viewerSource.includes('selectSceneItemFromCanvas'), true)
    assert.equal(viewerSource.includes('if (transformMode) return'), false)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer uses Ctrl plus left click for multi-select toggles and preserves selection on Ctrl-empty clicks', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(module.isWorldsMultiSelectToggleGesture({ button: 0, ctrlKey: true }), true)
    assert.equal(module.isWorldsMultiSelectToggleGesture({ button: 0, ctrlKey: false, shiftKey: true }), false)
    assert.equal(module.isWorldsMultiSelectToggleGesture({ button: 2, ctrlKey: true }), false)
    assert.equal(module.shouldWorldsPointerMissClearSelection({ ctrlKey: true }), false)
    assert.equal(module.shouldWorldsPointerMissClearSelection({ ctrlKey: false }), true)
    assert.equal(module.shouldWorldsPointerMissClearSelection(undefined), true)
    assert.equal(viewerSource.includes('ctrlKey'), true)
    assert.equal(viewerSource.includes('shiftKey &&'), false)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer suppresses the immediate post-transform selection event without blocking later transform-mode clicks', async () => {
  const viewerSource = await readFile(viewerEntry, 'utf8')

  assert.equal(viewerSource.includes('const WORLDS_TRANSFORM_SELECTION_SUPPRESSION_MS = 180'), true)
  assert.equal(viewerSource.includes('if (Date.now() < suppressSelectionUntilRef.current) return'), true)
  assert.equal(viewerSource.includes('suppressSelectionUntilRef.current = Date.now() + WORLDS_TRANSFORM_SELECTION_SUPPRESSION_MS'), true)
  assert.equal(viewerSource.includes('selectCollisionSurfaceFromCanvas'), true)
  assert.equal(viewerSource.includes('if (transformMode) return'), false)
})

function createRootWithMesh(mesh: THREE.Object3D): THREE.Group {
  const root = new THREE.Group()
  root.add(mesh)
  root.updateWorldMatrix(true, true)
  return root
}

function createTriangleMesh(vertices: [[number, number, number], [number, number, number], [number, number, number]]): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3))
  geometry.computeVertexNormals()
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
}

test('WorldsViewer focus helper frames selected bounds instead of preserving the old camera distance', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const target = new THREE.Group()
    target.position.set(10, 0, -4)
    target.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial()))
    target.updateWorldMatrix(true, true)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    camera.position.set(30, 40, 50)
    const orbitTarget = new THREE.Vector3(1, 1, 1)
    let updateCalls = 0
    const previousDistance = camera.position.distanceTo(orbitTarget)
    const previousDirection = camera.position.clone().sub(orbitTarget).normalize()

    const focused = module.focusWorldsCameraOnObject(camera, {
      target: orbitTarget,
      maxDistance: 500,
      update: () => { updateCalls += 1 },
    }, target)

    assert.equal(focused, true)
    assert.deepEqual(orbitTarget.toArray(), [10, 0, -4])
    const bounds = module.calculateWorldsSelectionBounds(target)
    assert.ok(bounds)
    const expectedRadius = Math.max(bounds.size.length() * 0.5, module.WORLD_VIEWER_ORBIT_CONTROLS.minDistance)
    const focusedDistance = camera.position.distanceTo(orbitTarget)
    assert.ok(focusedDistance < previousDistance)
    assert.ok(focusedDistance > expectedRadius)
    assert.ok(focusedDistance < expectedRadius * 10)
    const focusedDirection = camera.position.clone().sub(orbitTarget).normalize()
    assert.ok(focusedDirection.distanceTo(previousDirection) < 1e-6)
    assert.equal(updateCalls, 1)
    assert.ok(camera.near >= 0.01)

    const empty = new THREE.Group()
    assert.equal(module.focusWorldsCameraOnObject(camera, {
      target: orbitTarget,
      maxDistance: 500,
      update: () => undefined,
    }, empty), false)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer focus helper keeps the object center as target and stops at a collision-safe camera position', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const target = new THREE.Group()
    target.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()))
    target.updateWorldMatrix(true, true)

    const surface = createWorldCollisionSurfacePreset('rectangle', {
      id: 'focus-wall',
      transform: { position: [5.7, 0, 0], rotation: [0, 0, -Math.PI / 2], scale: [4, 1, 4] },
    })
    assert.ok(surface)
    const collisionSurfaces = normalizeWorldSceneCollisionSurfaces([surface!])
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    camera.position.set(10, 0, 0)
    const orbitTarget = new THREE.Vector3(0, 0, 0)

    const focused = module.focusWorldsCameraOnObject(camera, {
      target: orbitTarget,
      maxDistance: 500,
      update: () => undefined,
    }, target, collisionSurfaces)

    assert.equal(focused, true)
    assert.deepEqual(orbitTarget.toArray(), [0, 0, 0])
    assert.ok(camera.position.x > 5.69)
    assert.ok(camera.position.x < 10)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer creates stable fit keys from visible scene descriptors', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.deepEqual(module.createWorldsSceneFitKey([item('ply-mesh', 'mesh.ply'), item('glb', 'scene.glb')]), 'world:mesh.ply:mesh.ply|world:scene.glb:scene.glb')
    assert.deepEqual(module.createWorldsSceneFitKey([{ ...item('ply-mesh', 'hidden.ply'), visible: false }, item('gltf', 'visible.gltf')]), 'world:visible.gltf:visible.gltf')
  } finally {
    await cleanup()
  }
})

function assertWorldsBoxInsideCamera(box: THREE.Box3, camera: THREE.PerspectiveCamera): void {
  camera.updateMatrixWorld()
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const corner = new THREE.Vector3(x, y, z)
    const depth = -corner.clone().applyMatrix4(camera.matrixWorldInverse).z
    const ndc = corner.project(camera)
    assert.ok(Math.abs(ndc.x) <= .8 + 1e-8, `horizontal padded corner ${ndc.x}`)
    assert.ok(Math.abs(ndc.y) <= .8 + 1e-8, `vertical padded corner ${ndc.y}`)
    assert.ok(depth > camera.near && depth < camera.far, `positive unclipped corner depth ${depth}`)
    assert.ok(ndc.z > -1 && ndc.z < 1)
  }
}

function worldsFitControls() {
  return { target: new THREE.Vector3(), maxDistance: 500, saves: 0, update() {}, saveState() { this.saves++ } }
}

test('WorldsViewer initial fit waits for every real visible render root, excludes helpers and preserves subsequent user orbit', async () => {
  const { module, cleanup } = await loadViewerInteractionModule(false, true)
  const interaction = getViewerInteractionTestExports(module)
  const host = mounted()
  try {
    const camera = module.fitTestCamera
    const controls = worldsFitControls()
    const snapshotRef: WorldsCameraFitSnapshotRef = { current: null }
    const first = item('glb', 'first.glb'), second = item('glb', 'second.glb')
    const rootA = new THREE.Group(), rootB = new THREE.Group()
    const helper = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    helper.userData.worldsSelectionHitbox = true
    rootA.add(helper) // Real first GLTF render: no instance yet, only selection geometry is available.
    const objectsRef = { current: new Map([[first.id, rootA]]) }
    const props = { sceneItems: [first, second], sceneObjectsRef: objectsRef, sceneObjectVersion: 0,
      fitKey: module.createWorldsSceneFitKey([first, second]), loadRevision: 0, resetToken: 0,
      orbitControlsRef: { current: controls }, cameraFitSnapshotRef: snapshotRef, collisionSurfaces: [] }
    const render = (changes = {}) => host.render(createElement(interaction.TestSceneFitController, { ...props, ...changes }))
    render()
    assert.equal(snapshotRef.current, null, 'helper-only and absent roots cannot consume initial fit')
    assert.deepEqual(camera.position.toArray(), [2.4, 1.8, 2.8])
    const meshA = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshBasicMaterial())
    rootA.add(meshA); rootA.position.set(12, 3, -7); rootA.rotation.set(.2, .7, -.3); rootA.scale.set(2, 1, .5)
    objectsRef.current.set(second.id, rootB)
    render({ loadRevision: 1, sceneObjectVersion: 1 })
    assert.equal(snapshotRef.current, null, 'one ready model cannot frame before the other GLTF instance')
    const meshB = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 1), new THREE.MeshBasicMaterial())
    rootB.add(meshB); rootB.position.set(19, -2, 4); rootB.rotation.set(-.4, .1, .9)
    const silhouette = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), new THREE.MeshBasicMaterial())
    silhouette.userData.worldsSelectionSilhouette = true; rootB.add(silhouette)
    rootA.updateWorldMatrix(true, true); rootB.updateWorldMatrix(true, true)
    const expected = new THREE.Box3().setFromObject(meshA).union(new THREE.Box3().setFromObject(meshB))
    render({ loadRevision: 2 })
    const fitSnapshot = requireWorldsCameraFitSnapshot(snapshotRef)
    assert.ok(controls.target.distanceTo(expected.getCenter(new THREE.Vector3())) < 1e-8)
    assertWorldsBoxInsideCamera(expected, camera)
    assert.equal(controls.saves, 1)
    assert.equal(module.fitTestBoundsCalls.refresh, 0, 'never refresh the contaminated aggregate Bounds group')
    const baseline = fitSnapshot.position.clone(), target = fitSnapshot.target.clone()
    camera.position.set(30, 15, 25); controls.target.set(10, 4, 5)
    rootA.position.x += 3
    render({ loadRevision: 3, sceneItems: [{ ...first, material: { baseColor: '#123456' } }, { ...second }], sceneObjectVersion: 2 })
    render({ loadRevision: 4 })
    assert.deepEqual(camera.position.toArray(), [30, 15, 25])
    assert.deepEqual(controls.target.toArray(), [10, 4, 5])
    assert.equal(controls.saves, 1)
    render({ loadRevision: 4, resetToken: 1 })
    assert.ok(camera.position.distanceTo(baseline) < 1e-8)
    assert.ok(controls.target.distanceTo(target) < 1e-8)
    assert.equal(controls.saves, 2)
    for (const mesh of [helper, meshA, meshB, silhouette]) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose() }
  } finally { host.render(null); await cleanup() }
})

test('WorldsViewer conservative scene fit contains rotated off-origin large corners at narrow and wide aspects', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(300, 45, 120), new THREE.MeshBasicMaterial())
    mesh.position.set(700, -400, 250); mesh.rotation.set(.7, 1.1, -.3); mesh.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(mesh)
    const bounds = { center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()), distance: 1 }
    for (const aspect of [.2, 2.5]) {
      const camera = new THREE.PerspectiveCamera(45, aspect, .01, 500)
      const snapshot = module.createWorldsBoundsCameraFitSnapshot(bounds, camera.up, camera)
      module.applyWorldsCameraFitSnapshot(camera, worldsFitControls(), snapshot)
      assert.ok(camera.near > 0 && camera.far > camera.near)
      assertWorldsBoxInsideCamera(box, camera)
    }
    mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose()
  } finally { await cleanup() }
})

test('WorldsViewer cloned equal saved views do not snap user orbit; changed values and reset restore the authored baseline', async () => {
  const { module, cleanup } = await loadViewerInteractionModule(false, true)
  const interaction = getViewerInteractionTestExports(module)
  const host = mounted()
  try {
    const camera = module.fitTestCamera, controls = worldsFitControls()
    const saved = { position: [8, 5, 12], target: [1, 2, 3] }
    const snapshotRef = { current: null as any }, objectsRef = { current: new Map() }
    const first = item('glb', 'saved.glb')
    const props = { initialView: saved, sceneItems: [first], sceneObjectsRef: objectsRef, sceneObjectVersion: 0,
      fitKey: module.createWorldsSceneFitKey([first]), loadRevision: 0, resetToken: 0,
      orbitControlsRef: { current: controls }, cameraFitSnapshotRef: snapshotRef, collisionSurfaces: [] }
    const render = (changes = {}) => host.render(createElement(interaction.TestSceneFitController, { ...props, ...changes }))
    render()
    assert.deepEqual(camera.position.toArray(), saved.position, 'saved view wins even before geometry loads')
    camera.position.set(30, 15, 25); controls.target.set(10, 4, 5)
    const clone = { position: [...saved.position], target: [...saved.target], up: [0, 1, 0] }
    render({ initialView: clone, loadRevision: 1 })
    assert.deepEqual(camera.position.toArray(), [30, 15, 25])
    assert.deepEqual(controls.target.toArray(), [10, 4, 5])
    const root = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 10, 8), new THREE.MeshBasicMaterial())
    root.add(mesh); objectsRef.current.set(first.id, root)
    render({ initialView: { ...clone, position: [...clone.position] }, loadRevision: 2, sceneObjectVersion: 1 })
    assert.deepEqual(camera.position.toArray(), [30, 15, 25])
    assert.equal(controls.saves, 1)
    const changed = { ...clone, target: [4, 2, 3] }
    render({ initialView: changed, loadRevision: 2 })
    assert.deepEqual(camera.position.toArray(), saved.position)
    assert.deepEqual(controls.target.toArray(), changed.target)
    camera.position.set(-9, -8, -7); controls.target.set(7, 8, 9)
    render({ initialView: { ...changed, target: [...changed.target] }, loadRevision: 3, resetToken: 1 })
    assert.deepEqual(camera.position.toArray(), saved.position)
    assert.deepEqual(controls.target.toArray(), changed.target)
    assert.equal(controls.saves, 3)
    mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose()
  } finally { host.render(null); await cleanup() }
})

test('WorldsViewer empty scene keeps the default editor orbit without inventing unit bounds', async () => {
  const { module, cleanup } = await loadViewerInteractionModule(false, true)
  const host = mounted()
  try {
    const controls = worldsFitControls(), snapshotRef = { current: null }
    host.render(createElement(module.TestSceneFitController, { sceneItems: [], sceneObjectsRef: { current: new Map() }, sceneObjectVersion: 0,
      fitKey: '', loadRevision: 0, resetToken: 0, orbitControlsRef: { current: controls }, cameraFitSnapshotRef: snapshotRef, collisionSurfaces: [] }))
    assert.equal(snapshotRef.current, null)
    assert.deepEqual(module.fitTestCamera.position.toArray(), [2.4, 1.8, 2.8])
    assert.equal(controls.saves, 0)
  } finally { host.render(null); await cleanup() }
})

test('WorldsViewer fit action applies bounds fit when delayed GLTF bounds arrive without an initial view', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.equal(module.resolveWorldsSceneFitAction({
      fitKeyChanged: true,
      initialViewChanged: false,
      hasInitialView: false,
      hasMeasuredBounds: false,
      hasSnapshot: true,
      hasAppliedBoundsFitForCurrentFitKey: false,
      loadRevisionChanged: false,
    }), 'noop')

    assert.equal(module.resolveWorldsSceneFitAction({
      fitKeyChanged: false,
      initialViewChanged: false,
      hasInitialView: false,
      hasMeasuredBounds: true,
      hasSnapshot: true,
      hasAppliedBoundsFitForCurrentFitKey: false,
      loadRevisionChanged: true,
    }), 'apply-bounds-fit')

    const bounds = {
      center: new THREE.Vector3(10, 4, -3),
      size: new THREE.Vector3(8, 6, 4),
      distance: 14,
    }
    const snapshot = module.createWorldsBoundsCameraFitSnapshot(bounds)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 500,
      update: () => undefined,
      saveState: () => undefined,
    }

    module.applyWorldsCameraFitSnapshot(camera, controls, snapshot)

    assert.deepEqual(controls.target.toArray(), [10, 4, -3])
    assert.notDeepEqual(camera.position.toArray(), [2.4, 1.8, 2.8])
    assert.ok(camera.position.distanceTo(snapshot.target) > 0)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer fit bounds include actual GLTF instance matrices and skinned object-level bounds', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    const actor = item('glb', 'instances.glb'), root = new THREE.Group()
    const geometry = new THREE.BoxGeometry(2, 3, 4), material = new THREE.MeshBasicMaterial()
    const instances = new THREE.InstancedMesh(geometry, material, 2)
    instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(100, 5, 0))
    instances.setMatrixAt(1, new THREE.Matrix4().compose(new THREE.Vector3(120, -2, 5), new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, .8, .1)), new THREE.Vector3(2, 1, .5)))
    root.add(instances); root.position.set(5, 2, -3); root.rotation.y = .4; root.updateWorldMatrix(true, true)
    instances.computeBoundingBox()
    const expected = new THREE.Box3().setFromObject(instances)
    const measured = module.measureWorldsSceneCameraBounds([actor], new Map([[actor.id, root]]))
    assert.ok(measured)
    assert.ok(measured.center.distanceTo(expected.getCenter(new THREE.Vector3())) < 1e-8, 'instance matrices are rendered bounds, not base geometry bounds')
    const camera = new THREE.PerspectiveCamera(45, .3, .01, 500)
    module.applyWorldsCameraFitSnapshot(camera, worldsFitControls(), module.createWorldsBoundsCameraFitSnapshot(measured, camera.up, camera))
    assertWorldsBoxInsideCamera(expected, camera)
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(geometry.attributes.position.count * 4).fill(0), 4))
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: geometry.attributes.position.count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4))
    const skinned = new THREE.SkinnedMesh(geometry, material), bone = new THREE.Bone()
    skinned.add(bone); skinned.bind(new THREE.Skeleton([bone])); bone.position.x = 30
    skinned.updateWorldMatrix(true, true); skinned.skeleton.update(); skinned.computeBoundingBox()
    const skinBounds = module.measureWorldsSceneCameraBounds([actor], new Map([[actor.id, skinned]]))
    assert.ok(skinBounds.center.x > 29, 'legitimate deformed object-level bounds are retained')
    geometry.dispose(); material.dispose()
  } finally { await cleanup() }
})

test('WorldsViewer fit-specific traversal prunes hidden ancestors and helper containers without changing shared selection bounds', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    const actor = item('glb', 'visible.glb'), root = new THREE.Group()
    const geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshBasicMaterial()
    const visible = new THREE.Mesh(geometry, material); visible.position.x = 20; root.add(visible)
    const hiddenChild = new THREE.Mesh(geometry, material); hiddenChild.position.x = 10000; hiddenChild.visible = false; root.add(hiddenChild)
    const hiddenParent = new THREE.Group(); hiddenParent.visible = false
    const nested = new THREE.Mesh(geometry, material); nested.position.y = 20000; hiddenParent.add(nested); root.add(hiddenParent)
    const helperParent = new THREE.Group(); helperParent.userData.worldsSelectionSilhouette = true
    const helperChild = new THREE.Mesh(geometry, material); helperChild.position.z = 30000; helperParent.add(helperChild); root.add(helperParent)
    const measured = module.measureWorldsSceneCameraBounds([actor], new Map([[actor.id, root]]))
    assert.deepEqual(measured.center.toArray(), [20, 0, 0])
    assert.deepEqual(measured.size.toArray(), [2, 2, 2])
    assert.ok(module.calculateWorldsSelectionBounds(root).size.x > 9000, 'shared selection/collision measurement semantics are not silently changed')
    const ancestor = new THREE.Group(); ancestor.visible = false; ancestor.add(root)
    assert.equal(module.measureWorldsSceneCameraBounds([actor], new Map([[actor.id, root]])), null)
    geometry.dispose(); material.dispose()
  } finally { await cleanup() }
})

test('WorldsViewer settled render failures release first-fit readiness but real replacement and PLY retry attempts still wait', async () => {
  const { module, cleanup } = await loadViewerInteractionModule(false, true)
  const interaction = getViewerInteractionTestExports(module)
  const fitHost = mounted(), failureHost = mounted(), plyHost = mounted()
  const originalFetch = globalThis.fetch
  try {
    const ready = item('glb', 'ready.glb'), failed = item('glb', 'failed.glb'), gaussian = item('gaussian-ply', 'disabled.ply')
    const root = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial())
    root.position.x = 25; root.add(mesh)
    const objectsRef = { current: new Map([[ready.id, root]]) }, loadsRef = { current: new Map() }
    const controls = worldsFitControls(), snapshotRef: WorldsCameraFitSnapshotRef = { current: null }, events: string[] = []
    const report = (actor: WorldSceneItem, attempt: object, state: string) => {
      events.push(state); module.testUpdateRenderLoadState(loadsRef.current, actor, attempt, state)
    }
    const props = { sceneItems: [ready, failed, gaussian], sceneObjectsRef: objectsRef, renderLoadStatesRef: loadsRef,
      sceneObjectVersion: 0, fitKey: module.createWorldsSceneFitKey([ready, failed, gaussian]), loadRevision: 0, resetToken: 0,
      orbitControlsRef: { current: controls }, cameraFitSnapshotRef: snapshotRef, collisionSurfaces: [] }
    const renderFit = (changes = {}) => fitHost.render(createElement(interaction.TestSceneFitController, { ...props, ...changes }))
    renderFit(); assert.equal(snapshotRef.current, null, 'real unresolved GLTF must still block partial fitting')
    const Throws = () => { throw new Error('Actual terminal GLTF loader failure') }
    failureHost.render(createElement(interaction.TestRenderBoundary, { item: failed, onRenderLoadStateChange: report, children: createElement(Throws) }))
    assert.ok(events.includes('failed'), 'actual error boundary must publish settled failure')
    renderFit({ loadRevision: 1 })
    assert.ok(snapshotRef.current, 'ready geometry plus disabled Gaussian and terminal GLTF error can fit')
    assert.deepEqual(controls.target.toArray(), [25, 0, 0])
    const oldAttempt = loadsRef.current.get(failed.id).attempt
    const replacement = { ...failed, url: 'replacement.glb' }
    assert.equal(module.measureWorldsSceneCameraBounds([ready, replacement], objectsRef.current, loadsRef.current), null, 'old source failure cannot poison a replacement')
    const newAttempt = {}
    module.testUpdateRenderLoadState(loadsRef.current, replacement, newAttempt, 'pending')
    module.testUpdateRenderLoadState(loadsRef.current, failed, oldAttempt, 'failed')
    assert.equal(module.measureWorldsSceneCameraBounds([ready, replacement], objectsRef.current, loadsRef.current), null)
    const ply = item('ply-mesh', 'failed.ply')
    let resolveRetry!: (value: Response) => void
    globalThis.fetch = async () => new Response(null, { status: 404 })
    plyHost.render(createElement(interaction.TestRenderBoundary, { item: ply, onRenderLoadStateChange: report,
      children: createElement(interaction.TestPlySceneObject, { item: ply, onBoundsChange() {} }) }))
    await settleMounted(plyHost)
    assert.ok(findHost(plyHost.container, (node) => node.props.role === 'status' && node.children.some((child) => child.props.value === 'Unable to load PLY: 404')))
    assert.ok(module.measureWorldsSceneCameraBounds([ready, ply], objectsRef.current, loadsRef.current), 'terminal PLY failure does not freeze ready geometry')
    globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveRetry = resolve })) as typeof fetch
    const retryItem = { ...ply }
    plyHost.render(createElement(interaction.TestRenderBoundary, { item: retryItem, onRenderLoadStateChange: report,
      children: createElement(interaction.TestPlySceneObject, { item: retryItem, onBoundsChange() {} }) }))
    assert.equal(module.measureWorldsSceneCameraBounds([ready, retryItem], objectsRef.current, loadsRef.current), null, 'actual same-source retry clears failure and remains pending')
    resolveRetry({ ok: true, arrayBuffer: async () => { const bytes = await readFile(meshFixture); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } } as Response)
    await settleMounted(plyHost)
    assert.ok(events.includes('ready'))
    mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose()
  } finally { globalThis.fetch = originalFetch; plyHost.render(null); failureHost.render(null); fitHost.render(null); await cleanup() }
})

test('WorldsViewer first-fit attached skin bounds match renderer-updated vertices under a new authored parent', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    const actor = item('glb', 'attached-skin.glb'), root = new THREE.Group()
    const geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshBasicMaterial()
    const count = geometry.attributes.position.count
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0), 4))
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4))
    const skin = new THREE.SkinnedMesh(geometry, material), bone = new THREE.Bone()
    skin.add(bone); skin.bind(new THREE.Skeleton([bone])); root.add(skin); root.position.x = 100
    const measured = module.measureWorldsSceneCameraBounds([actor], new Map([[actor.id, root]]))
    // Expected corners come from real native renderer-equivalent skin updates, not the measured stale box.
    root.updateMatrixWorld(true)
    const expected = new THREE.Box3()
    for (let index = 0; index < count; index++) expected.expandByPoint(skin.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(skin.matrixWorld))
    assert.deepEqual(expected.getCenter(new THREE.Vector3()).toArray(), [100, 0, 0])
    assert.ok(measured.center.distanceTo(expected.getCenter(new THREE.Vector3())) < 1e-8, 'first-fit skin world bounds cannot double the authored parent translation')
    const camera = new THREE.PerspectiveCamera(45, .5, .01, 500)
    module.applyWorldsCameraFitSnapshot(camera, worldsFitControls(), module.createWorldsBoundsCameraFitSnapshot(measured, camera.up, camera))
    assertWorldsBoxInsideCamera(expected, camera)
    geometry.dispose(); material.dispose()
  } finally { await cleanup() }
})

test('WorldsViewer active terminal boundary failure supersedes its loading PLY attempt and survives retired cleanup', async () => {
  const { module, cleanup } = await loadViewerInteractionModule(false, true)
  const interaction = getViewerInteractionTestExports(module)
  const host = mounted(), originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch
    const actor = item('ply-mesh', 'boundary-ply.ply'), loads = new Map()
    let boundary: TestRenderBoundaryHandle | null = null, reports = 0
    const report = (item: WorldSceneItem, attempt: object, status: string, owner?: object) => {
      reports++; module.testUpdateRenderLoadState(loads, item, attempt, status, owner)
    }
    const Throws = () => { throw new Error('Terminal child render failure after actual PLY load began') }
    const Child = ({ fail }: { fail: boolean }) => createElement('group', null,
      createElement(interaction.TestPlySceneObject, { item: actor, onBoundsChange() {} }), fail ? createElement(Throws) : null)
    const boundaryRef: Ref<TestRenderBoundaryHandle> = (instance) => { if (instance) boundary = instance }
    const render = (fail: boolean) => host.render(createElement(interaction.TestRenderBoundary, { item: actor, onRenderLoadStateChange: report,
      ref: boundaryRef, children: createElement(Child, { fail }) }))
    render(false)
    assert.equal(loads.get(actor.id)?.status, 'loading', 'real PLY effect has adopted its own pending load token')
    const loadAttempt = loads.get(actor.id).attempt, owner = loads.get(actor.id).owner
    render(true)
    assert.equal(loads.get(actor.id)?.status, 'failed', 'mounted boundary failure must supersede nested load attempt')
    const terminal = loads.get(actor.id)
    module.testUpdateRenderLoadState(loads, actor, loadAttempt, 'removed', owner)
    assert.equal(loads.get(actor.id), terminal, 'retired PLY cleanup cannot erase terminal boundary state')
    const ready = item('glb', 'ready-sibling.glb'), root = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial()); root.position.x = 25; root.add(mesh)
    const measured = module.measureWorldsSceneCameraBounds([ready, actor], new Map([[ready.id, root]]), loads)
    assert.deepEqual(measured.center.toArray(), [25, 0, 0], 'ready sibling can fit after real boundary failure')
    const activeBoundary = boundary as TestRenderBoundaryHandle | null
    assert.ok(activeBoundary)
    const retiredReport = activeBoundary.reportLoadState.bind(activeBoundary)
    host.render(null)
    const replacement = { ...actor, url: 'replacement-boundary.ply' }, freshOwner = {}
    module.testUpdateRenderLoadState(loads, replacement, freshOwner, 'pending', freshOwner)
    const replacementState = loads.get(actor.id), beforeRetiredReports = reports
    retiredReport('failed'); retiredReport('removed', loadAttempt)
    module.testUpdateRenderLoadState(loads, actor, owner, 'failed', owner)
    assert.equal(reports, beforeRetiredReports, 'unmounted boundary and nested callbacks are fenced')
    assert.equal(loads.get(actor.id), replacementState, 'retired owner/source cannot poison replacement')
    assert.equal(module.measureWorldsSceneCameraBounds([ready, replacement], new Map([[ready.id, root]]), loads), null)
    mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose()
  } finally { globalThis.fetch = originalFetch; host.render(null); await cleanup() }
})

test('WorldsViewer fit action preserves saved initial view while delayed bounds only refresh limits', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.equal(module.resolveWorldsSceneFitAction({
      fitKeyChanged: false,
      initialViewChanged: false,
      hasInitialView: true,
      hasMeasuredBounds: true,
      hasSnapshot: true,
      hasAppliedBoundsFitForCurrentFitKey: false,
      loadRevisionChanged: true,
    }), 'refresh-limits')
  } finally {
    await cleanup()
  }
})

test('WorldsViewer fit action does not steal the camera again for repeated bounds changes on the same loaded render set', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.equal(module.resolveWorldsSceneFitAction({
      fitKeyChanged: false,
      initialViewChanged: false,
      hasInitialView: false,
      hasMeasuredBounds: true,
      hasSnapshot: true,
      hasAppliedBoundsFitForCurrentFitKey: true,
      loadRevisionChanged: true,
    }), 'noop')
  } finally {
    await cleanup()
  }
})

test('WorldsViewer fit action refits when the visible render set changes', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    assert.equal(module.resolveWorldsSceneFitAction({
      fitKeyChanged: true,
      initialViewChanged: false,
      hasInitialView: false,
      hasMeasuredBounds: true,
      hasSnapshot: true,
      hasAppliedBoundsFitForCurrentFitKey: false,
      loadRevisionChanged: false,
    }), 'apply-bounds-fit')
  } finally {
    await cleanup()
  }
})

test('WorldsViewer applies an explicit initial view and reset restores the same bounded camera snapshot', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const bounds = {
      center: new THREE.Vector3(0, 1, 0),
      size: new THREE.Vector3(20, 10, 8),
      distance: 24,
    }
    const initialView = {
      position: [8, 5, 12],
      target: [1, 2, 3],
      up: [0, 0, 1],
    }
    const snapshot = module.createWorldsInitialViewCameraFitSnapshot(initialView, bounds)

    assert.deepEqual(snapshot.position.toArray(), initialView.position)
    assert.deepEqual(snapshot.target.toArray(), initialView.target)
    assert.deepEqual(snapshot.up.toArray(), initialView.up)
    assert.ok(snapshot.near > 0)
    assert.ok(snapshot.far > snapshot.near)
    assert.ok(snapshot.maxDistance >= snapshot.position.distanceTo(snapshot.target) * 2)
    assert.deepEqual(
      module.createWorldsInitialViewCameraFitSnapshot({
        position: [4, 3, 2],
        target: [0, 0, 0],
      }, bounds).up.toArray(),
      [0, 1, 0],
    )

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 500,
      updateCalls: 0,
      saveCalls: 0,
      update() { this.updateCalls += 1 },
      saveState() { this.saveCalls += 1 },
    }

    module.applyWorldsCameraFitSnapshot(camera, controls, snapshot)
    assert.deepEqual(camera.position.toArray(), initialView.position)
    assert.deepEqual(camera.up.toArray(), initialView.up)
    assert.deepEqual(controls.target.toArray(), initialView.target)
    assert.equal(camera.near, snapshot.near)
    assert.equal(camera.far, snapshot.far)
    assert.equal(controls.maxDistance, snapshot.maxDistance)

    camera.position.set(-20, -20, -20)
    camera.up.set(0, 1, 0)
    controls.target.set(9, 9, 9)
    module.applyWorldsCameraFitSnapshot(camera, controls, snapshot)

    assert.deepEqual(camera.position.toArray(), initialView.position)
    assert.deepEqual(camera.up.toArray(), initialView.up)
    assert.deepEqual(controls.target.toArray(), initialView.target)
    assert.equal(controls.updateCalls, 2)
    assert.equal(controls.saveCalls, 2)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer refreshes loaded-scene camera limits without moving the explicit pose', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const initialView = {
      position: [8, 5, 12],
      target: [1, 2, 3],
      up: [0, 0, 1],
    }
    const initialSnapshot = module.createWorldsInitialViewCameraFitSnapshot(initialView, {
      center: new THREE.Vector3(0, 0, 0),
      size: new THREE.Vector3(1, 1, 1),
      distance: 2,
    })
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 500,
      update: () => undefined,
      saveState: () => undefined,
    }

    module.applyWorldsCameraFitSnapshot(camera, controls, initialSnapshot)
    const poseBeforeLoad = {
      position: camera.position.toArray(),
      up: camera.up.toArray(),
      target: controls.target.toArray(),
      quaternion: camera.quaternion.toArray(),
    }
    const refreshedSnapshot = module.refreshWorldsCameraFitSnapshotLimits(camera, controls, initialSnapshot, {
      center: new THREE.Vector3(0, 10, 0),
      size: new THREE.Vector3(120, 80, 60),
      distance: 160,
    })

    assert.deepEqual(camera.position.toArray(), poseBeforeLoad.position)
    assert.deepEqual(camera.up.toArray(), poseBeforeLoad.up)
    assert.deepEqual(controls.target.toArray(), poseBeforeLoad.target)
    assert.deepEqual(camera.quaternion.toArray(), poseBeforeLoad.quaternion)
    assert.deepEqual(refreshedSnapshot.position.toArray(), initialView.position)
    assert.deepEqual(refreshedSnapshot.target.toArray(), initialView.target)
    assert.ok(refreshedSnapshot.far > initialSnapshot.far)
    assert.ok(refreshedSnapshot.maxDistance > initialSnapshot.maxDistance)
    assert.equal(camera.near, refreshedSnapshot.near)
    assert.equal(camera.far, refreshedSnapshot.far)
    assert.equal(controls.maxDistance, refreshedSnapshot.maxDistance)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer defers BVH construction until scheduled work and cancels cleanly before the first build', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    let computeCalls = 0
    let disposeCalls = 0
    ;(geometry as any).computeBoundsTree = () => {
      computeCalls += 1
      ;(geometry as any).boundsTree = { built: true }
    }
    ;(geometry as any).disposeBoundsTree = () => {
      disposeCalls += 1
      delete (geometry as any).boundsTree
    }

    const scene = new THREE.Group()
    scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))
    const scheduled: Array<() => void> = []
    const task = module.scheduleWorldsSceneBoundsTreeBuild(scene, (callback: () => void) => {
      scheduled.push(callback)
      return { cancel: () => undefined }
    })

    assert.equal(computeCalls, 0)
    assert.equal(scheduled.length, 1)

    task.release()
    scheduled[0]!()

    assert.equal(computeCalls, 0)
    assert.equal(disposeCalls, 0)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer GLTF instance cloning owns per-instance materials and keeps shared GLTF resources alive across remounts', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const sourceMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', side: THREE.FrontSide })
    let sourceMaterialDisposed = false
    sourceMaterial.dispose = () => {
      sourceMaterialDisposed = true
      THREE.Material.prototype.dispose.call(sourceMaterial)
    }

    const geometry = new THREE.BoxGeometry(1, 1, 1)
    let computeCalls = 0
    let disposeCalls = 0
    ;(geometry as any).computeBoundsTree = () => {
      computeCalls += 1
      ;(geometry as any).boundsTree = { built: true }
    }
    ;(geometry as any).disposeBoundsTree = () => {
      disposeCalls += 1
      delete (geometry as any).boundsTree
    }

    const sourceScene = new THREE.Group()
    sourceScene.add(new THREE.Mesh(geometry, sourceMaterial))

    const clonedScene = sourceScene.clone()
    module.cloneWorldsSceneMaterialsForInstance(clonedScene)
    const clonedMesh = clonedScene.children[0]

    assert.ok(clonedMesh instanceof THREE.Mesh)
    assert.notEqual(clonedMesh.material, sourceMaterial)
    assert.equal((clonedMesh.material as THREE.Material).side, THREE.DoubleSide)
    assert.equal(sourceMaterial.side, THREE.FrontSide)

    const scheduled: Array<() => void> = []
    const scheduler = (callback: () => void) => {
      scheduled.push(callback)
      return { cancel: () => undefined }
    }

    const firstInstance = module.createWorldsGltfSceneInstance(sourceScene, scheduler)
    const secondInstance = module.createWorldsGltfSceneInstance(sourceScene, scheduler)
    const firstMesh = firstInstance.scene.children[0]
    const secondMesh = secondInstance.scene.children[0]

    assert.ok(firstMesh instanceof THREE.Mesh)
    assert.ok(secondMesh instanceof THREE.Mesh)

    assert.equal(computeCalls, 0)
    scheduled.forEach((run) => run())
    assert.equal(computeCalls, 1)

    firstInstance.dispose()
    assert.equal(disposeCalls, 0)
    assert.equal(sourceMaterialDisposed, false)

    secondInstance.dispose()
    assert.equal(disposeCalls, 1)
    assert.equal(sourceMaterialDisposed, false)
  } finally {
    await cleanup()
  }
})

test('WorldsViewer disposes a GLTF instance only when the instance lifecycle ends, not on live material projection', async () => {
  const viewerSource = await readFile(viewerEntry, 'utf8')
  const componentSource = viewerSource.slice(
    viewerSource.indexOf('function GltfSceneObject'),
    viewerSource.indexOf('function resolveWorldsPlaybackDuration'),
  )
  assert.doesNotMatch(componentSource, /useMemo\(\(\) => createWorldsGltfSceneInstance/)
  assert.match(componentSource, /useWorldsGltfSceneInstance\(gltf\.scene\)/)
  assert.match(componentSource, /useEffect\(\(\) => \{[\s\S]*createWorldsGltfSceneInstance\(sourceScene\)/)
  const projectionEffect = componentSource.slice(
    componentSource.indexOf('applyWorldsRenderableProjection'),
    componentSource.indexOf('useEffect', componentSource.indexOf('applyWorldsRenderableProjection') + 1),
  )
  assert.doesNotMatch(projectionEffect, /instance\.dispose/)
})

test('WorldsViewer GLTF lifecycle survives the React StrictMode effect replay without leaking the final instance', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    let disposeCalls = 0
    const instance = { dispose: () => { disposeCalls += 1 } }
    const firstRelease = module.retainWorldsGltfSceneInstance(instance)
    firstRelease()
    const finalRelease = module.retainWorldsGltfSceneInstance(instance)
    await Promise.resolve()
    assert.equal(disposeCalls, 0)
    finalRelease()
    await Promise.resolve()
    assert.equal(disposeCalls, 1)
  } finally { await cleanup() }
})

test('WorldsViewer reset reapplies the stored collision-resolved snapshot from either current side', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const surface = createWorldCollisionSurfacePreset('rectangle', {
      id: 'reset-blocker',
      transform: { position: [0, 0, 0], rotation: [-Math.PI / 2, 0, 0], scale: [4, 1, 4] },
    })
    assert.ok(surface)
    const collisionSurfaces = normalizeWorldSceneCollisionSurfaces([surface!])
    const desiredSnapshot = {
      position: new THREE.Vector3(0, 0, 0),
      target: new THREE.Vector3(0, 0, -2),
      up: new THREE.Vector3(0, 1, 0),
      near: 0.01,
      far: 500,
      maxDistance: 50,
    }
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    camera.position.set(4, 0, 0)
    const controls = {
      target: new THREE.Vector3(),
      maxDistance: 500,
      update: () => undefined,
      saveState: () => undefined,
    }

    const storedSnapshot = module.resolveAndApplyWorldsCameraFitSnapshot(camera, controls, desiredSnapshot, collisionSurfaces)
    assert.ok(Math.abs(storedSnapshot.position.z) > 0.19)
    assert.deepEqual(camera.position.toArray(), storedSnapshot.position.toArray())

    camera.position.set(-4, 0, 0)
    controls.target.set(9, 9, 9)
    module.applyWorldsCameraFitSnapshot(camera, controls, storedSnapshot)

    assert.deepEqual(camera.position.toArray(), storedSnapshot.position.toArray())
    assert.deepEqual(controls.target.toArray(), storedSnapshot.target.toArray())
    const resolvedFromCurrentSide = module.createCollisionSafeWorldsCameraFitSnapshot(
      desiredSnapshot,
      new THREE.Vector3(-4, 0, 0),
      collisionSurfaces,
    )
    assert.ok(Math.abs(resolvedFromCurrentSide.position.z) > 0.19)
    assert.deepEqual(resolvedFromCurrentSide.position.toArray(), storedSnapshot.position.toArray())
  } finally {
    await cleanup()
  }
})


test('WorldsViewer collision-safe fit snapshots stay unchanged without blockers and depenetrate deterministically inside blockers', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const snapshot = {
      position: new THREE.Vector3(2.4, 1.8, 2.8),
      target: new THREE.Vector3(0, 0, 0),
      up: new THREE.Vector3(0, 1, 0),
      near: 0.01,
      far: 500,
      maxDistance: 50,
    }
    const unchanged = module.createCollisionSafeWorldsCameraFitSnapshot(snapshot, new THREE.Vector3(8, 8, 8), [])
    assert.deepEqual(unchanged.position.toArray(), [2.4, 1.8, 2.8])
    assert.deepEqual(unchanged.target.toArray(), [0, 0, 0])

    const surface = createWorldCollisionSurfacePreset('rectangle', {
      id: 'reset-blocker',
      transform: { position: [0, 0, 0], rotation: [-Math.PI / 2, 0, 0], scale: [4, 1, 4] },
    })
    assert.ok(surface)
    const collisionSurfaces = normalizeWorldSceneCollisionSurfaces([surface!])
    const blockedSnapshot = {
      ...snapshot,
      position: new THREE.Vector3(0, 0, 0),
    }

    const resolvedA = module.createCollisionSafeWorldsCameraFitSnapshot(blockedSnapshot, new THREE.Vector3(0, 0, 0), collisionSurfaces)
    const resolvedB = module.createCollisionSafeWorldsCameraFitSnapshot(blockedSnapshot, new THREE.Vector3(0, 0, 0), collisionSurfaces)

    assert.ok(Math.abs(Math.abs(resolvedA.position.z) - 0.2001) < 2e-3)
    assert.deepEqual(resolvedA.position.toArray(), resolvedB.position.toArray())
    assert.deepEqual(resolvedA.target.toArray(), [0, 0, 0])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer keeps collision surfaces out of normal render targets, bounds selection, and box-era contracts', async () => {
  const { module, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')

  try {
    assert.equal(viewerSource.includes('if (object.userData.worldsCollisionSurface === true) return'), true)
    assert.equal(viewerSource.includes('collisionEditMode ? ('), true)
    assert.equal(viewerSource.includes('<WorldCollisionSurfaceLayer'), true)
    assert.equal(viewerSource.includes('<WorldCollisionZoneLayer'), false)
    assert.equal(viewerSource.includes('worldsPlacementCollision'), false)
    assert.equal(viewerSource.includes('worldsSurfacePlacement'), true)
    assert.deepEqual(module.describeWorldsViewerScene([{
      ...item('ply-mesh', 'mesh.ply'),
      collision: { enabled: true, zones: [{ id: 'zone-1', shape: 'box', offset: [0, 0, 0], size: [1, 1, 1] }] },
    }]).renderTargets, [
      {
        workspacePath: 'mesh.ply',
        kind: 'ply-mesh',
        loader: 'ply',
        primitive: 'mesh',
        cameraFit: 'bounds',
        visibleDescription: 'PLY mesh geometry',
      },
    ])
  } finally {
    await cleanup()
  }
})

test('WorldsViewer routes collision surface gizmos through the same drag suppression path as asset gizmos', async () => {
  const viewerSource = await readFile(viewerEntry, 'utf8')

  assert.equal(viewerSource.includes('draggingRef={transformDraggingRef}'), true)
  assert.equal(viewerSource.includes('onSelectSurface={selectCollisionSurfaceFromCanvas}'), true)
  assert.equal(viewerSource.includes('onDragEndSelectionBlock={handleTransformDragEnd}'), true)
  assert.equal(viewerSource.includes('draggingRef.current = true'), true)
  assert.equal(viewerSource.includes('draggingRef.current = false'), true)
  assert.equal(viewerSource.includes('selectedObject && transformMode && !selectedCollisionSurfaceId'), true)
  assert.equal(viewerSource.includes('collisionEditMode={collisionEditMode}'), true)
  assert.equal(viewerSource.includes('!(collisionEditMode && selectedCollisionSurfaceId)'), false)
  assert.equal(viewerSource.includes('{selected && zoneObject && transformMode ? ('), false)
  assert.equal(viewerSource.includes('object={zoneObject}'), false)
})

test('mounted Viewer releases an interrupted collision drag when leaving Inspect before mouse up', async () => {
  const { module, cleanup } = await loadViewerInteractionModule()
  const host = mounted()
  const surface = createWorldCollisionSurfacePreset('square', { id: 'surface:interrupted-drag' })
  assert.ok(surface)
  const selections: Array<string | null> = []
  let transformCommits = 0

  try {
    host.render(createElement(module.WorldsViewer, {
      project: projectDocument(),
      items: [],
      collisionSurfaces: [surface],
      collisionEditMode: true,
      selectedCollisionSurfaceId: surface.id,
      transformMode: 'translate',
      onSelectCollisionSurface: (surfaceId: string | null) => selections.push(surfaceId),
      onTransformCollisionSurface: () => { transformCommits += 1 },
    }))
    await settleMounted(host)

    const collisionControls = findHost(host.container, (node) => node.type === 'transform-controls')
    assert.ok(collisionControls)
    collisionControls.props.onMouseDown()

    const flyButton = findHost(host.container, (node) => node.type === 'button' && node.props['aria-label'] === 'fly')
    assert.ok(flyButton)
    flyButton.props.onClick()
    await settleMounted(host)
    assert.equal(findHost(host.container, (node) => node.type === 'transform-controls'), undefined)
    assert.equal(transformCommits, 0, 'Unmounting an active collision drag must not commit it')

    const inspectButton = findHost(host.container, (node) => node.type === 'button' && node.props['aria-label'] === 'inspect')
    assert.ok(inspectButton)
    inspectButton.props.onClick()
    await settleMounted(host)
    assert.ok(findHost(host.container, (node) => node.type === 'transform-controls'))

    const canvas = findHost(host.container, (node) => node.type === 'canvas-mock')
    assert.ok(canvas)
    canvas.props.onPointerMissed({ ctrlKey: false })
    assert.deepEqual(selections, [null], 'Returning to Inspect must restore canvas selection after an interrupted drag')
    assert.equal(transformCommits, 0)

    const recoveredControls = findHost(host.container, (node) => node.type === 'transform-controls')
    assert.ok(recoveredControls)
    recoveredControls.props.onMouseDown()
    recoveredControls.props.onMouseUp()
    assert.equal(transformCommits, 1, 'An ordinary completed collision drag still commits exactly once')
    canvas.props.onPointerMissed({ ctrlKey: false })
    assert.deepEqual(selections, [null], 'Ordinary mouse up still applies the short post-drag selection guard')
  } finally {
    host.render(null)
    await cleanup()
  }
})

test('WorldsViewportModeControl exposes accessible Inspect Fly Run modes and Frame Scene', async () => {
  const { source, module, cleanup } = await loadModeControlModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')
  const modeControlSource = await readFile(modeControlEntry, 'utf8')

  try {
    assert.equal(typeof module.WorldsViewportModeControl, 'function')
    assert.equal(source.includes('WorldsViewportModeControl'), true)
    assert.equal(viewerSource.includes('<WorldsViewportModeControl'), true)
    assert.equal(viewerSource.includes('<WorldsCameraOverlay'), false)
    assert.equal(modeControlSource.includes('role="radiogroup"'), true)
    assert.equal(modeControlSource.includes('aria-label="Editor navigation mode"'), true)
    assert.equal(modeControlSource.includes('role="radio"'), true)
    assert.equal(modeControlSource.includes('aria-checked={active}'), true)
    assert.equal(modeControlSource.includes('min-h-9 min-w-9'), true)
    assert.equal(modeControlSource.includes('Inspect (1) — Orbit, pan, select, and edit'), true)
    assert.equal(modeControlSource.includes('Fly (2) — Free 6DOF; click viewport to capture pointer'), true)
    assert.equal(modeControlSource.includes('Run (3) — Grounded editor navigation; does not start Play'), true)
    assert.equal(modeControlSource.includes('Frame scene'), true)
    assert.equal(modeControlSource.includes('aria-live="polite"'), true)
    assert.equal(modeControlSource.includes('ArrowRight'), true)
    assert.equal(modeControlSource.includes('ArrowLeft'), true)
    assert.equal(modeControlSource.includes('ArrowDown'), true)
    assert.equal(modeControlSource.includes('ArrowUp'), true)
    assert.equal(modeControlSource.includes('.focus()'), true)
    assert.equal(modeControlSource.includes('event.stopPropagation()'), true)
    assert.equal(modeControlSource.includes('hidden sm:inline'), false)
  } finally {
    await cleanup()
  }
})

test('mounted mode radios keep Digit shortcuts, selection, roving focus, and live status synchronized', async () => {
  const { module, cleanup } = await loadModeControlModule()
  const host = mounted()
  let selectedMode = 'inspect'

  function ModeHarness(): ReactElement {
    const [mode, setMode] = React.useState<'inspect' | 'fly' | 'run'>('inspect')
    selectedMode = mode
    return createElement(module.WorldsViewportModeControl, {
      mode,
      status: `${mode === 'inspect' ? 'Inspect' : mode === 'fly' ? 'Fly' : 'Run'} mode. Pointer locked.`,
      pointerLocked: true,
      onModeChange: setMode,
      onFrameScene: () => undefined,
    })
  }

  try {
    host.render(createElement(ModeHarness))
    const initialRadios = findHosts(host.container, (node) => node.type === 'button' && node.props.role === 'radio')
    const inspectRadio = initialRadios.find((node) => node.props['aria-checked'] === true)
    assert.ok(inspectRadio)
    assert.equal(typeof inspectRadio.props.onFocus, 'function')
    inspectRadio.props.onFocus({})
    let prevented = false
    let stopped = false
    inspectRadio.props.onKeyDown({
      key: '3',
      code: 'Digit3',
      preventDefault: () => { prevented = true },
      stopPropagation: () => { stopped = true },
    })
    await settleMounted(host, 1)

    assert.equal(prevented, true)
    assert.equal(stopped, true)
    assert.equal(selectedMode, 'run')
    const runRadio = findHosts(host.container, (node) => node.type === 'button' && node.props.role === 'radio')
      .find((node) => node.props['aria-checked'] === true)
    assert.ok(runRadio)
    assert.equal(runRadio.props.tabIndex, 0)
    assert.equal(host.focused(), runRadio)

    const status = findHost(host.container, (node) => node.props.role === 'status')
    assert.ok(status)
    assert.equal((getHostText(status).match(/Pointer locked\./g) ?? []).length, 1)

    runRadio.props.onKeyDown({
      key: 'ArrowRight',
      code: 'ArrowRight',
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    })
    await settleMounted(host, 1)
    assert.equal(selectedMode, 'inspect')
    const wrappedRadio = findHosts(host.container, (node) => node.type === 'button' && node.props.role === 'radio')
      .find((node) => node.props['aria-checked'] === true)
    assert.ok(wrappedRadio)
    assert.equal(host.focused(), wrappedRadio)
  } finally {
    host.render(null)
    await cleanup()
  }
})

test('WorldsViewportModeControl renders radio modes with visible labels and frame button', async () => {
  const { module, cleanup } = await loadModeControlModule()

  try {
    const markup = renderToStaticMarkup(createElement(module.WorldsViewportModeControl, {
      mode: 'fly',
      status: 'Fly mode. Click viewport to capture pointer.',
      pointerLocked: false,
      onModeChange: () => undefined,
      onFrameScene: () => undefined,
    }))

    assert.match(markup, /role="radiogroup"/)
    assert.match(markup, /aria-label="Editor navigation mode"/)
    assert.match(markup, /role="radio"/)
    assert.match(markup, /Inspect/)
    assert.match(markup, /Fly/)
    assert.match(markup, /Run/)
    assert.match(markup, /aria-label="Frame scene"/)
    assert.match(markup, /aria-live="polite"/)
    assert.doesNotMatch(markup, /Movement speed|Reset camera|Left-drag look/)

    const fallbackMarkup = renderToStaticMarkup(createElement(module.WorldsViewportModeControl, {
      mode: 'run',
      status: `Run mode. ${WORLD_RUN_GROUND_FALLBACK_LABEL}.`,
      pointerLocked: true,
      onModeChange: () => undefined,
      onFrameScene: () => undefined,
    }))
    assert.match(fallbackMarkup, />Ground-only</)
  } finally {
    await cleanup()
  }
})

test('WorldsTransformToolbar clarifies that multi-select transforms use the active item as the pivot', async () => {
  const toolbarSource = await readFile(path.join(projectRoot, 'src/areas/worlds/components/WorldsTransformToolbar.tsx'), 'utf8')

  assert.equal(toolbarSource.includes('transforms use the active item as the pivot'), true)
  assert.equal(toolbarSource.includes('only the active item gets transform controls'), false)
  assert.equal(toolbarSource.includes('Add collision surface'), true)
  assert.equal(toolbarSource.includes('Add box'), false)
  assert.equal(toolbarSource.includes('Wall'), true)
  assert.equal(toolbarSource.includes('Triangle'), true)
  assert.equal(toolbarSource.includes('Floor'), true)
  assert.equal(toolbarSource.includes('World collision surfaces use the same move, rotate, and scale gizmo as scene assets.'), true)
  assert.equal(toolbarSource.includes('Remove surface'), true)
})

test('production Worlds modules keep a static boundary from Generate Viewer3D implementations', async () => {
  const productionFiles = await listProductionWorldsFiles(worldsRoot)
  assert.ok(productionFiles.length > 0, 'expected production Worlds files to be scanned')

  const forbiddenPatterns = [
    /src\/areas\/generate\/components\/Viewer3D/i,
    /@areas\/generate\/components\/Viewer3D/i,
    /\.\.\/\.\.\/generate\/components\/Viewer3D/i,
    /generate\/components\/Viewer3D/i,
  ]

  for (const filePath of productionFiles) {
    const source = await readFile(filePath, 'utf8')
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(source), false, `${path.relative(projectRoot, filePath)} must not import or reference Generate Viewer3D`)
    }
  }
})

test('production Worlds modules do not import PointerLockControls', async () => {
  const productionFiles = await listProductionWorldsFiles(worldsRoot)
  assert.ok(productionFiles.length > 0, 'expected production Worlds files to be scanned')

  const forbiddenPatterns = [/PointerLockControls/]

  for (const filePath of productionFiles) {
    const source = await readFile(filePath, 'utf8')
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(source), false, `${path.relative(projectRoot, filePath)} must not import or reference ${pattern}`)
    }
  }
})

test('WorldsViewer replaces studio lighting with authored lights and applies canonical PBR and shadow projection', async () => {
  const { module, source, cleanup } = await loadViewerModule()
  const viewerSource = await readFile(viewerEntry, 'utf8')
  try {
    assert.equal(module.shouldUseWorldsStudioLights([]), true)
    assert.equal(module.shouldUseWorldsStudioLights([{
      entityId: 'entity:light',
      component: { id: 'component:light', type: 'light', enabled: true, lightKind: 'ambient', color: '#ffffff', intensity: 1 },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }]), false)

    const material = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0, roughness: 1, opacity: 1 })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
    module.applyWorldsRenderableProjection(mesh, {
      baseColor: '#336699', metallic: 0.7, roughness: 0.2, opacity: 0.5,
    }, false, true)
    assert.equal(material.color.getHexString(), '336699')
    assert.equal(material.metalness, 0.7)
    assert.equal(material.roughness, 0.2)
    assert.equal(material.opacity, 0.5)
    assert.equal(material.transparent, true)
    assert.equal(mesh.castShadow, false)
    assert.equal(mesh.receiveShadow, true)
    mesh.geometry.dispose()
    material.dispose()

    assert.deepEqual(module.resolveWorldsLightTarget({
      position: [2, 3, 4], rotation: [0, 0, 0], scale: [1, 1, 1],
    }), [2, 3, 3])
    const rotatedTarget = module.resolveWorldsLightTarget({
      position: [2, 3, 4], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1],
    })
    assert.ok(Math.abs(rotatedTarget[0] - 1) < 1e-9)
    assert.ok(Math.abs(rotatedTarget[1] - 3) < 1e-9)
    assert.ok(Math.abs(rotatedTarget[2] - 4) < 1e-9)

    assert.match(source, /WorldsSceneLighting/)
    assert.match(viewerSource, /<Canvas[\s\S]*?\bshadows(?:=\{true\})?/)
    assert.match(viewerSource, /target=\{target\}/)
    assert.doesNotMatch(source, /<ambientLight intensity=\{0\.3\} \/>\s*<Environment/)
  } finally { await cleanup() }
})

async function listProductionWorldsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__fixtures__') return []
        return listProductionWorldsFiles(entryPath)
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return []
      return [entryPath]
    }),
  )
  return files.flat()
}
