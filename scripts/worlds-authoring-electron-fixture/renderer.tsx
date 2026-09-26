import { createRoot } from 'react-dom/client'
import { _roots } from '@react-three/fiber'
import { Box3, Euler, InstancedMesh, Matrix4, Mesh, Object3D, PerspectiveCamera, Raycaster, Vector2, Vector3, type Camera } from 'three'
import { WorldsWorkbench } from '../../src/areas/worlds/components/WorldsWorkbench.tsx'
import { worldEditorController } from '../../src/areas/worlds/editor/worldEditorController.ts'
import { useWorldsUiStore } from '../../src/areas/worlds/editor/worldsUiStore.ts'
import { useAppStore } from '../../src/shared/stores/appStore.ts'
import { useAgentStore } from '../../src/shared/stores/agentStore.ts'
import { parseObservedOrbitEnabled, type AiReviewObservation, type AuthoringView, type CanvasInteractionHitKind, type CanvasInteractionPointObservation, type CanvasInteractionTargetsObservation, type CanvasObservation, type HandleCandidate, type ModelObservation, type NativePointerHit, type NativeTrace, type Point, type Rect, type WorldCornerObservation } from './shared.ts'
import { withPickerScratch } from './picker-scratch.ts'
import './styles.css'

const bootId = crypto.randomUUID()
const diagnostics: string[] = []
const trace: NativeTrace[] = []
const canvasIds = new WeakMap<HTMLCanvasElement, string>()
function canvasId(canvas: HTMLCanvasElement): string {
  let id = canvasIds.get(canvas)
  if (!id) { id = crypto.randomUUID(); canvasIds.set(canvas, id) }
  return id
}
let lastTrustedPointer: null | { target: HTMLCanvasElement | null; sequence: number; frame: number | null; type: string; buttons: number; point: Point } = null
let untrustedInputs = 0
let pointerLockChanges = 0, pointerLockErrors = 0
let lastPointerLockChangeAt: string | null = null, lastPointerLockErrorAt: string | null = null
let hostSetupComplete = false
const reportError = (message: string) => { if (diagnostics.length < 64) diagnostics.push(message) }
window.addEventListener('error', (event) => reportError(event.error instanceof Error ? event.error.stack ?? event.message : event.message))
window.addEventListener('unhandledrejection', (event) => reportError(String(event.reason)))
document.addEventListener('securitypolicyviolation', (event) => reportError(`CSP denied ${event.violatedDirective}: ${event.blockedURI}`))
document.addEventListener('webglcontextlost', () => reportError('Actual Canvas context lost'), true)
document.addEventListener('pointerlockchange', (event) => {
  if (!event.isTrusted) untrustedInputs += 1
  pointerLockChanges += 1; lastPointerLockChangeAt = new Date().toISOString()
}, true)
document.addEventListener('pointerlockerror', (event) => {
  if (!event.isTrusted) untrustedInputs += 1
  pointerLockErrors += 1; lastPointerLockErrorAt = new Date().toISOString()
}, true)
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'keydown', 'keyup', 'input', 'change']) {
  document.addEventListener(type, (event) => {
    if (!event.isTrusted) untrustedInputs += 1
    const target = event.target instanceof Element ? event.target : null
    const namedControl = target?.closest('button[aria-label]') ?? target
    const mouse = event instanceof MouseEvent ? event : null
    const keyboard = event instanceof KeyboardEvent ? event : null
    const targetCanvas = target instanceof HTMLCanvasElement ? target : null
    const frame = targetCanvas ? _roots.get(targetCanvas)?.store.getState().gl.info.render.frame ?? null : null
    if (event.isTrusted && mouse && type.startsWith('pointer')) lastTrustedPointer = {
      target: targetCanvas, sequence: trace.length + 1, frame, type, buttons: mouse.buttons, point: { x: mouse.clientX, y: mouse.clientY },
    }
    trace.push({ sequence: trace.length + 1, at: new Date().toISOString(), type, trusted: event.isTrusted,
      x: mouse?.clientX ?? null, y: mouse?.clientY ?? null, buttons: mouse?.buttons ?? null,
      movementX: mouse?.movementX ?? null, movementY: mouse?.movementY ?? null, code: keyboard?.code ?? null,
      canvasUuid: targetCanvas ? canvasId(targetCanvas) : null, frame,
      target: namedControl ? `${namedControl.tagName}:${namedControl.getAttribute('aria-label') ?? namedControl.closest('[role="treeitem"]')?.querySelector('.worlds-tree-name')?.textContent ?? namedControl.className}` : '',
    })
    if (trace.length > 4096) reportError('Native input observation overflow')
  }, true)
}

const rect = (value: DOMRect): Rect => ({ x: value.x, y: value.y, width: value.width, height: value.height })
const isObject = (value: unknown): value is Object3D => value instanceof Object3D
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Observed Three object contract changed')
  return value as Record<string, unknown>
}
function project(point: Vector3, camera: Camera, viewport: Rect): Point {
  const ndc = point.clone().project(camera)
  if (![ndc.x, ndc.y, ndc.z].every(Number.isFinite)) throw new Error('Nonfinite observed projection')
  return { x: viewport.x + (ndc.x + 1) * viewport.width / 2, y: viewport.y + (1 - ndc.y) * viewport.height / 2 }
}

/** Reads the last rendered matrices. No updateMatrixWorld, control call, or actor mutation. */
function modelObservation(object: Object3D, entityId: string, camera: Camera, viewport: Rect): ModelObservation {
  const points: Point[] = []
  const worldBounds = new Box3(), instanceMatrix = new Matrix4()
  let meshes = 0, triangles = 0
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return
    for (let ancestor: Object3D | null = child; ancestor; ancestor = ancestor.parent) {
      if (!ancestor.visible || ancestor.userData.worldsSelectionSilhouette || ancestor.userData.worldsSelectionHitbox) return
    }
    const position = child.geometry.getAttribute('position')
    if (!position) return
    const instances = child instanceof InstancedMesh ? child.count : 1
    meshes += 1
    triangles += (child.geometry.index?.count ?? position.count) / 3 * instances
    for (let instance = 0; instance < instances; instance += 1) {
      if (child instanceof InstancedMesh) child.getMatrixAt(instance, instanceMatrix)
      for (let i = 0; i < position.count; i += 1) {
        const world = child.getVertexPosition(i, new Vector3())
        if (child instanceof InstancedMesh) world.applyMatrix4(instanceMatrix)
        world.applyMatrix4(child.matrixWorld)
        worldBounds.expandByPoint(world); points.push(project(world, camera, viewport))
      }
    }
  })
  const worldCorners: WorldCornerObservation[] = []
  if (!worldBounds.isEmpty()) {
    for (const x of [worldBounds.min.x, worldBounds.max.x]) for (const y of [worldBounds.min.y, worldBounds.max.y]) for (const z of [worldBounds.min.z, worldBounds.max.z]) {
      const world = new Vector3(x, y, z), ndc = world.clone().project(camera)
      worldCorners.push({ world: [x, y, z], ndc: [ndc.x, ndc.y, ndc.z], depth: -world.clone().applyMatrix4(camera.matrixWorldInverse).z })
    }
  }
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y)
  return {
    entityId, uuid: object.uuid, name: object.name, visible: object.visible, meshes, triangles,
    transform: { position: [object.position.x, object.position.y, object.position.z], rotation: [object.rotation.x, object.rotation.y, object.rotation.z], scale: [object.scale.x, object.scale.y, object.scale.z] },
    matrixWorld: [...object.matrixWorld.elements],
    worldCorners,
    bounds: points.length ? { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } : null,
  }
}

/** At most three geometry-derived candidates; raycasts are on private scratch meshes only. */
function observeHandles(control: Object3D, object: Object3D, camera: Camera, viewport: Rect, canvas: HTMLCanvasElement, bounds: Rect | null): { candidates: HandleCandidate[]; pointerHit: NativePointerHit | null } {
  const gizmo = record(record(control).gizmo)
  const picker = record(gizmo.picker).translate
  if (!isObject(picker)) throw new Error('Production TransformControls translation picker contract changed')
  return withPickerScratch(picker, camera, viewport, (scratch, sourceByScratch, hitAt) => {
    const origin = project(new Vector3().setFromMatrixPosition(object.matrixWorld), camera, viewport)
    const candidates: HandleCandidate[] = []
    const pointer = lastTrustedPointer
    const first = pointer?.target === canvas ? hitAt(pointer.point) : undefined
    const pointerHit: NativePointerHit | null = pointer ? {
      canvasUuid: pointer.target ? canvasId(pointer.target) : null, targetCanvas: pointer.target === canvas, trusted: true,
      sequence: pointer.sequence, frame: pointer.frame, type: pointer.type, buttons: pointer.buttons, point: { ...pointer.point },
      firstHitAxis: first?.object.name ?? null, pickerUuid: first ? sourceByScratch.get(first.object as Mesh)!.uuid : null,
    } : null
    for (const axis of ['Y', 'X', 'Z'] as const) {
      const matches = scratch.filter((mesh) => mesh.visible && mesh.name === axis)
      if (matches.length !== 1) continue
      const mesh = matches[0]
      const attribute = mesh.geometry.getAttribute('position')
      if (!attribute) throw new Error('Translation picker has no position attribute')
      const box = new Box3()
      for (let i = 0; i < attribute.count; i += 1) box.expandByPoint(new Vector3(attribute.getX(i), attribute.getY(i), attribute.getZ(i)))
      const start = project(box.getCenter(new Vector3()).applyMatrix4(mesh.matrixWorld), camera, viewport)
      start.x = Math.round(start.x); start.y = Math.round(start.y)
      const first = hitAt(start)
      if (first?.object.name !== axis) continue
      const dx = start.x - origin.x, dy = start.y - origin.y, length = Math.hypot(dx, dy)
      if (length < 14) continue
      const distance = Math.min(160, Math.max(100, (bounds?.height ?? 70) + 35))
      const end = { x: Math.round(start.x + dx / length * distance), y: Math.round(start.y + dy / length * distance) }
      const inside = (point: Point) => point.x > viewport.x + 18 && point.y > viewport.y + 18 && point.x < viewport.x + viewport.width - 18 && point.y < viewport.y + viewport.height - 18
      if (!inside(start) || !inside(end) || document.elementFromPoint(start.x, start.y) !== canvas || document.elementFromPoint(end.x, end.y) !== canvas) continue
      candidates.push({ axis, start, end, pickerUuid: sourceByScratch.get(mesh)!.uuid, firstHitAxis: first.object.name })
    }
    return { candidates, pointerHit }
  })
}

function observedEntityHit(object: Object3D, entityIds: readonly string[]): { entityId: string; kind: CanvasInteractionHitKind } | null {
  for (let current: Object3D | null = object; current; current = current.parent) {
    if (current.userData.worldsSelectionSilhouette === true || current.userData.worldsCollisionSurface === true) return null
    if (current.userData.worldsSelectionHitbox === true) {
      const matches = entityIds.filter((entityId) => current.name === `${entityId} selection hitbox`)
      if (matches.length !== 1) throw new Error('Selection hitbox identity is ambiguous')
      return { entityId: matches[0], kind: 'selection-hitbox' }
    }
    const entityId: unknown = current.userData.worldsSceneItemId
    if (typeof entityId === 'string' && entityIds.includes(entityId)) return { entityId, kind: 'model' }
  }
  return null
}

/** Bounded private raycasts over the production interaction registry; never mutates its raycaster, scene, camera or controls. */
function observeCanvasInteractionTargets(
  interaction: readonly Object3D[],
  models: readonly ModelObservation[],
  camera: Camera,
  viewport: Rect,
  canvas: HTMLCanvasElement,
): CanvasInteractionTargetsObservation {
  if (interaction.length > 512 || models.length > 256) throw new Error('Canvas interaction observation exceeds bounded fixture limits')
  const raycaster = new Raycaster(), ndc = new Vector2(), entityIds = models.map((model) => model.entityId)
  const observePoint = (point: Point): CanvasInteractionPointObservation => {
    ndc.set(((point.x - viewport.x) / viewport.width) * 2 - 1, -((point.y - viewport.y) / viewport.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    const hits = raycaster.intersectObjects([...interaction], true)
    if (hits.length > 512) throw new Error('Canvas interaction raycast exceeds bounded fixture limits')
    const first = hits.map((hit) => observedEntityHit(hit.object, entityIds)).find((hit) => hit !== null) ?? null
    return {
      point: { ...point }, canvasUuid: canvasId(canvas), hitCanvas: document.elementFromPoint(point.x, point.y) === canvas,
      interactionHitCount: hits.length, firstEntityId: first?.entityId ?? null, firstHitKind: first?.kind ?? null,
    }
  }
  const point = (x: number, y: number): Point => ({ x: Math.round(viewport.x + viewport.width * x), y: Math.round(viewport.y + viewport.height * y) })
  const emptyCandidates = [
    point(0.08, 0.12), point(0.92, 0.12), point(0.08, 0.88), point(0.92, 0.88),
    point(0.15, 0.5), point(0.85, 0.5), point(0.5, 0.88), point(0.5, 0.2),
  ]
  const empty = emptyCandidates.map(observePoint).find((candidate) => candidate.hitCanvas && candidate.interactionHitCount === 0) ?? null
  const entities = models.flatMap((model) => {
    const bounds = model.bounds
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return []
    const candidates: Point[] = []
    for (const y of [0.5, 0.35, 0.65]) for (const x of [0.5, 0.35, 0.65]) candidates.push({
      x: Math.round(bounds.x + bounds.width * x), y: Math.round(bounds.y + bounds.height * y),
    })
    const admitted = candidates.map(observePoint).find((candidate) => candidate.hitCanvas && candidate.firstEntityId === model.entityId)
    return admitted ? [admitted] : []
  })
  return { empty, entities }
}

function observeCanvas(): CanvasObservation | null {
  const canvases = [...document.querySelectorAll<HTMLCanvasElement>('[aria-label="Worlds 3D canvas"] canvas')]
  if (canvases.length !== 1) return null
  const canvas = canvases[0], root = _roots.get(canvas)
  if (!root) return null
  const state = root.store.getState(), viewport = rect(canvas.getBoundingClientRect())
  if (!(state.camera instanceof PerspectiveCamera)) throw new Error('Observed editor perspective camera contract changed')
  const gl = state.gl.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info')
  const models: ModelObservation[] = [], controls: Object3D[] = []
  state.scene.traverse((object) => {
    const entityId: unknown = object.userData.worldsSceneItemId
    if (object.type === 'Group' && typeof entityId === 'string' && !object.userData.worldsSelectionSilhouette && (object.name === entityId || object.name === `${entityId} selected`)) models.push(modelObservation(object, entityId, state.camera, viewport))
    if (record(object).isTransformControls === true && object.visible) controls.push(object)
  })
  if (controls.length > 1) throw new Error('Ambiguous live TransformControls ownership')
  const orbitEnabled = parseObservedOrbitEnabled(record(state).controls)
  let gizmo: CanvasObservation['gizmo'] = null
  if (controls.length) {
    const control = controls[0], values = record(control), object = values.object
    if (!isObject(object) || values.mode !== 'translate' || typeof values.enabled !== 'boolean' || typeof values.dragging !== 'boolean' || !(values.axis === null || typeof values.axis === 'string')) throw new Error('Observed TransformControls public runtime contract changed')
    const entityId = typeof object.userData.worldsSceneItemId === 'string' ? object.userData.worldsSceneItemId : null
    const model = models.find((value) => value.entityId === entityId)
    gizmo = { controlUuid: control.uuid, enabled: values.enabled, objectUuid: object.uuid, entityId, mode: values.mode, axis: values.axis, dragging: values.dragging,
      ...(values.dragging ? { candidates: [], pointerHit: null } : observeHandles(control, object, state.camera, viewport, canvas, model?.bounds ?? null)) }
  }
  const navigationEuler = new Euler().setFromQuaternion(state.camera.quaternion, 'YXZ')
  return {
    canvasUuid: canvasId(canvas), rect: viewport, drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], contextLost: gl.isContextLost(), frame: state.gl.info.render.frame,
    gl: { version: String(gl.getParameter(gl.VERSION)), vendor: String(gl.getParameter(gl.VENDOR)), renderer: String(gl.getParameter(gl.RENDERER)), unmaskedVendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null, unmaskedRenderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null },
    camera: [...state.camera.matrixWorld.elements, ...state.camera.projectionMatrix.elements], models, gizmo,
    cameraPose: { position: [state.camera.position.x, state.camera.position.y, state.camera.position.z], quaternion: [state.camera.quaternion.x, state.camera.quaternion.y, state.camera.quaternion.z, state.camera.quaternion.w], yawPitchRoll: [navigationEuler.y, navigationEuler.x, navigationEuler.z] },
    controls: { orbitEnabled },
    cameraFraming: { uuid: state.camera.uuid, near: state.camera.near, far: state.camera.far, matrixWorldInverse: [...state.camera.matrixWorldInverse.elements] },
    interactionTargets: observeCanvasInteractionTargets(state.internal.interaction, models, state.camera, viewport, canvas),
  }
}

function observeNavigation() {
  const canvas = document.querySelector<HTMLCanvasElement>('[aria-label="Worlds 3D canvas"] canvas')
  const statusMatches = [...document.querySelectorAll<HTMLElement>('[role="status"][data-pointer-locked]')]
  if (statusMatches.length > 1) throw new Error('Ambiguous navigation status observation')
  const descriptor = Object.getOwnPropertyDescriptor(window, 'worldsAuthoringObserve')
  return {
    modes: [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Editor navigation mode"] button[role="radio"]')].map((button) => ({
      label: button.getAttribute('aria-label') ?? '', checked: button.getAttribute('aria-checked') === 'true', tabIndex: button.tabIndex,
      focused: document.activeElement === button, disabled: button.disabled,
    })),
    status: statusMatches[0]?.textContent?.trim() ?? null,
    groundOnlyVisible: [...document.querySelectorAll('span')].some((element) => element.textContent?.trim() === 'Ground-only'),
    pointerLock: { canvasOwned: !!canvas && document.pointerLockElement === canvas, changes: pointerLockChanges, errors: pointerLockErrors, lastChangeAt: lastPointerLockChangeAt, lastErrorAt: lastPointerLockErrorAt },
    observationCapability: { writable: descriptor?.writable === true, configurable: descriptor?.configurable === true },
  }
}

function observeAiReview(): AiReviewObservation {
  const drawer = document.querySelector('[aria-label="Worlds AI"]')
  const prompt = drawer?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask Worlds AI"]')
  const picker = prompt?.parentElement?.querySelectorAll<HTMLButtonElement>(':scope > div.flex > div.flex > div.relative > button')
  const modelButton = picker?.length === 1 ? picker[0] : null
  const review = drawer?.querySelector('[aria-label="Worlds proposal review"]')
  const enabled = (label: string) => {
    const matches = review?.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)
    return matches?.length === 1 && !matches[0].disabled
  }
  return {
    expanded: drawer?.querySelector('[aria-controls="worlds-ai-content"]')?.getAttribute('aria-expanded') === 'true',
    prompt: prompt?.value ?? null, promptDisabled: !prompt || prompt.disabled,
    sendEnabled: !!prompt?.value.trim() && !!prompt.parentElement?.querySelector<HTMLButtonElement>(':scope > div.flex > button') && !prompt.parentElement.querySelector<HTMLButtonElement>(':scope > div.flex > button')!.disabled,
    selectedModel: modelButton?.textContent?.trim() ?? null,
    modelOptions: [...(modelButton?.parentElement?.querySelectorAll(':scope > div > button > span') ?? [])].map((option) => option.textContent ?? ''),
    busy: review?.getAttribute('aria-busy') === 'true', focused: review?.querySelector('h3') === document.activeElement,
    status: review?.querySelector('[role="status"], [role="alert"]')?.textContent?.trim() ?? '',
    details: [...(review?.querySelectorAll('[aria-label="Proposed property changes"] > li') ?? [])].map((row) => ({ entityName: row.querySelector('strong')?.textContent ?? '', property: row.querySelector(':scope > span')?.textContent ?? '', before: row.querySelector('del')?.textContent ?? '', after: row.querySelector('ins')?.textContent ?? '' })),
    warnings: [...(review?.querySelectorAll('[aria-label="Proposal warnings"] > li') ?? [])].map((row) => row.textContent ?? ''),
    applyEnabled: enabled('Apply Worlds proposal'), rejectEnabled: enabled('Reject Worlds proposal'),
  }
}
function observe(): AuthoringView {
  const ui = useWorldsUiStore.getState()
  let canvas: CanvasObservation | null = null
  try { canvas = observeCanvas() } catch (error) { reportError(String(error)) }
  const inspector = document.querySelector('[aria-label="Entity inspector"]')
  return structuredClone({
    bootId, at: new Date().toISOString(), environment: window.worldsAuthoringEnvironment,
    nodeGlobals: { require: typeof Reflect.get(window, 'require'), process: typeof Reflect.get(window, 'process') },
    hostSetupComplete, editor: worldEditorController.getState(), selection: { ids: [...ui.selectedEntityIds], active: ui.activeEntityId, mode: ui.transformMode },
    canvasCount: document.querySelectorAll('canvas').length, canvas, diagnostics: [...diagnostics],
    alerts: [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent?.trim() ?? ''),
    statuses: [...document.querySelectorAll('[role="status"]')].map((element) => element.textContent?.trim() ?? ''),
    inspectorName: inspector?.querySelector('.worlds-dock-header small')?.textContent ?? null,
    inspectorValues: [...(inspector?.querySelectorAll<HTMLInputElement>('input[type="number"]') ?? [])].map((input) => ({ label: `${input.closest('fieldset')?.querySelector('legend')?.textContent?.trim() ?? ''}:${input.closest('label')?.querySelector('span')?.textContent ?? ''}`, value: input.value, disabled: input.matches(':disabled') })),
    assetButtons: [...document.querySelectorAll('[aria-label="Assets library"] button.worlds-asset-add')].map((button) => button.getAttribute('aria-label') ?? ''),
    selectValues: [...document.querySelectorAll<HTMLSelectElement>('select[aria-label]')].map((select) => ({ label: select.getAttribute('aria-label') ?? '', value: select.value })),
    viewport: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    trace: [...trace], untrustedInputs, navigation: observeNavigation(), aiReview: observeAiReview(),
  })
}

// Exactly one read-only capability. No controller, store, Object3D or controls escape to the driver.
Object.defineProperty(window, 'worldsAuthoringObserve', { value: observe, writable: false, configurable: false })
async function mount(): Promise<void> {
  const info = await window.electron.app.info()
  if (info.apiUrl !== window.location.origin || !info.userData.startsWith('/tmp/modly-worlds-authoring-ui-') || !info.modelsDir.startsWith(`${info.userData}/`)) throw new Error('Unexpected fixture host-data response')
  // Explicit initial host configuration only; never used by the driver or after mount.
  useAppStore.setState({ apiUrl: info.apiUrl })
  const fixtureLocalAi = (info as typeof info & { fixtureLocalAi?: { ollamaUrl: string } }).fixtureLocalAi
  if (fixtureLocalAi) {
    if (fixtureLocalAi.ollamaUrl !== 'http://127.0.0.1:11434') throw new Error('Unexpected private fixture endpoint')
    // Endpoint bootstrap in this private session only; model selection stays in the actual native picker.
    useAgentStore.setState({ ollamaUrl: fixtureLocalAi.ollamaUrl })
  }
  hostSetupComplete = true
  const container = document.getElementById('root')
  if (!container) throw new Error('Fixture root is missing')
  createRoot(container).render(<WorldsWorkbench />)
}
void mount().catch((error: unknown) => { reportError(String(error)); console.error(error) })
