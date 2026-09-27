import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { WebContents } from 'electron'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { WORLD_RUN_GROUND_FALLBACK_LABEL } from '../../src/areas/worlds/worldCameraNavigation.ts'
import {
  assertReopenedAuthoringVisual,
  click,
  key,
  paint,
  numeric,
  observeNativeClickPoint,
  readView,
  selectValue,
  sendNativeInput,
  waitFor,
  type CommonDriverPorts,
  type Invocation,
  type UiAuthoredBaseline,
} from './driver.ts'
import {
  admitCanvasInteractionPoint,
  admitNativeCanvasFocusEvidence,
  WORLD_SCULPT_WORKSPACE_RELATIVE_PATH,
  type AuthoringView,
  type CanvasInteractionPointObservation,
  type Point,
  type ColliderRunSample,
  type ColliderRunGeometry,
  type ColliderRunScreenshot,
  type ReservedEscapeReceipt,
} from './shared.ts'

const INSPECT_LABEL = 'Inspect (1) — Orbit, pan, select, and edit'
const FLY_LABEL = 'Fly (2) — Free 6DOF; click viewport to capture pointer'
const RUN_LABEL = 'Run (3) — Grounded editor navigation; does not start Play'
const INSPECT_STATUS = 'Inspect mode. Orbit, pan, select, and edit.'
const FLY_LOCKED_STATUS = 'Fly mode. Pointer locked.'
const RUN_LOCKED_STATUS = 'Run mode. Pointer locked.'
const RUN_FALLBACK_STATUS = `Run mode. ${WORLD_RUN_GROUND_FALLBACK_LABEL}.`

export interface WorldSculptNavigationSourceEvidence {
  bytes: number
  sourceSha256: string
  bundledSha256: string
  workspaceSha256: string
  servedSha256: string
}

export interface WorldSculptNavigationDriverPorts extends CommonDriverPorts {
  source: WorldSculptNavigationSourceEvidence
  admitReopened(contents: WebContents, view: AuthoringView, previousBoot: string): Promise<void>
  releaseReservedEscape(contents: WebContents): Promise<{view: AuthoringView; receipt: ReservedEscapeReceipt}>
  collisionGeometry(view: AuthoringView): Promise<ColliderRunGeometry[]>
  captureCollider(stage: string, view: AuthoringView, contents: WebContents): Promise<ColliderRunScreenshot>
}

function snapshot(view: AuthoringView): WorldProjectSnapshotV1 {
  assert.ok(view.editor.session, 'WorldSculpt navigation requires a real editor session')
  return view.editor.session.snapshot
}

function canonicalState(view: AuthoringView, applyCount: number) {
  assert.ok(view.editor.session)
  return structuredClone({
    snapshot: view.editor.session.snapshot,
    undoStack: view.editor.session.undoStack,
    redoStack: view.editor.session.redoStack,
    receipts: view.editor.session.receipts,
    applyCount,
  })
}

function assertCanonicalState(view: AuthoringView, ports: CommonDriverPorts, expected: ReturnType<typeof canonicalState>): void {
  assert.deepEqual(canonicalState(view, ports.applies().length), expected, 'Viewport navigation changed canonical document, history, receipts, or apply count')
}

function assertSuccessfulUiApply(
  before: WorldProjectSnapshotV1,
  after: WorldProjectSnapshotV1,
  invocation: Invocation,
  expectedCommandTypes: readonly string[],
): void {
  assert.ok(invocation.forwardedAt && invocation.settledAt && invocation.result?.ok, 'Canonical UI command did not complete successfully')
  assert.equal(invocation.request.batch.origin, 'ui')
  assert.equal(invocation.request.batch.projectId, before.project.projectId)
  assert.equal(invocation.request.batch.baseRevision, before.project.revision)
  assert.deepEqual(invocation.request.batch.commands.map((command) => command.type), expectedCommandTypes)
  assert.equal(after.project.revision, before.project.revision + 1)
  if (invocation.result.ok) {
    assert.equal(invocation.result.value.idempotent, false)
    assert.equal(invocation.result.value.newRevision, after.project.revision)
    assert.deepEqual(invocation.result.value.warnings, [])
    assert.deepEqual(invocation.result.value.snapshot, after)
    assert.deepEqual(invocation.result.value.inverse, { kind: 'world-snapshot', snapshot: before })
  }
}

function mode(view: AuthoringView, label: string) {
  const matches = view.navigation.modes.filter((candidate) => candidate.label === label)
  assert.equal(matches.length, 1, `Expected one navigation mode ${label}`)
  return matches[0]
}

function assertModeSet(view: AuthoringView): void {
  assert.deepEqual(view.navigation.modes.map((candidate) => candidate.label), [INSPECT_LABEL, FLY_LABEL, RUN_LABEL])
  assert.equal(view.navigation.modes.filter((candidate) => candidate.checked).length, 1)
  assert.equal(view.navigation.modes.filter((candidate) => candidate.tabIndex === 0).length, 1)
  assert.ok(view.navigation.modes.every((candidate) => !candidate.disabled))
}

function changed(a: readonly number[], b: readonly number[], epsilon = 1e-6): boolean {
  assert.equal(a.length, b.length)
  return a.some((value, index) => Math.abs(value - b[index]) > epsilon)
}

function horizontalDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2])
}

function model(view: AuthoringView, entityId: string) {
  const matches = view.canvas?.models.filter((candidate) => candidate.entityId === entityId) ?? []
  assert.equal(matches.length, 1, 'WorldSculpt entity must have exactly one rendered root')
  const observed = matches[0]
  assert.equal(observed.meshes, 1); assert.equal(observed.triangles, 4916); assert.equal(observed.visible, true)
  assert.ok(observed.matrixWorld.length === 16 && observed.matrixWorld.every(Number.isFinite))
  assert.equal(observed.worldCorners.length, 8)
  for (const corner of observed.worldCorners) assert.ok([...corner.world, ...corner.ndc, corner.depth].every(Number.isFinite))
  return observed
}

function framed(view: AuthoringView, entityId: string): boolean {
  const observed = view.canvas?.models.find((candidate) => candidate.entityId === entityId)
  return !!observed && observed.worldCorners.length === 8 && observed.worldCorners.every((corner) => (
    corner.world.every(Number.isFinite) && corner.ndc.every(Number.isFinite) && Number.isFinite(corner.depth)
    && Math.abs(corner.ndc[0]) <= 0.92 && Math.abs(corner.ndc[1]) <= 0.92
    && corner.ndc[2] > -1 && corner.ndc[2] < 1 && corner.depth > 0
  ))
}

function interactionPoint(view: AuthoringView, entityId: string | null): { observation: CanvasInteractionPointObservation; point: Readonly<Point> } {
  const canvas = view.canvas
  assert.ok(canvas, 'Actual Canvas observation is required for native interaction admission')
  const matches = entityId === null
    ? canvas.interactionTargets.empty ? [canvas.interactionTargets.empty] : []
    : canvas.interactionTargets.entities.filter((candidate) => candidate.firstEntityId === entityId)
  assert.equal(matches.length, 1, entityId === null ? 'Exactly one empty Canvas point is required' : `Exactly one focus point is required for ${entityId}`)
  const observation = matches[0]
  const point = admitCanvasInteractionPoint(observation, { canvasUuid: canvas.canvasUuid, rect: canvas.rect, entityId })
  return { observation, point }
}

async function settleNativePoint(contents: WebContents, ports: CommonDriverPorts, entityId: string | null): Promise<{ point: Readonly<Point>; view: AuthoringView }> {
  const captured = await readView(contents), admitted = interactionPoint(captured, entityId)
  ports.guard()
  sendNativeInput(contents, ports, { type: 'mouseMove', ...admitted.point })
  await contents.executeJavaScript(`new Promise((resolve, reject) => {
    let first, second; const timer = setTimeout(() => reject(new Error('Canvas hover settlement exceeded 1000 ms')), 1000);
    first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { clearTimeout(timer); resolve(); }); });
  })`, false)
  ports.guard()
  const settled = await readView(contents), confirmed = interactionPoint(settled, entityId)
  assert.equal(settled.bootId, captured.bootId, 'Renderer changed during native Canvas point admission')
  assert.deepEqual(confirmed.point, admitted.point, 'Native Canvas point retargeted after hover settlement')
  assert.deepEqual(confirmed.observation, admitted.observation, 'Native Canvas interaction ownership drifted after hover settlement')
  assert.deepEqual(settled.diagnostics, [], 'Canvas point admission produced a renderer diagnostic')
  assert.equal(settled.untrustedInputs, 0, 'Canvas point admission observed untrusted input')
  return { point: admitted.point, view: settled }
}

async function nativeCanvasClick(contents: WebContents, ports: CommonDriverPorts): Promise<Point> {
  const { point } = await settleNativePoint(contents, ports, null)
  ports.guard(); sendNativeInput(contents, ports, { type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  sendNativeInput(contents, ports, { type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  return { ...point }
}

async function nativeCanvasDoubleClick(contents: WebContents, ports: CommonDriverPorts, entityId: string): Promise<{
  point: Point; beforeCamera: number[]; traceStart: number; bootId: string; canvasUuid: string; cameraUuid: string
}> {
  const { point, view } = await settleNativePoint(contents, ports, entityId)
  assert.ok(view.canvas)
  const result = { point: { ...point }, beforeCamera: [...view.canvas.camera], traceStart: view.trace.at(-1)?.sequence ?? 0,
    bootId: view.bootId, canvasUuid: view.canvas.canvasUuid, cameraUuid: view.canvas.cameraFraming.uuid }
  ports.guard()
  sendNativeInput(contents, ports, { type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  sendNativeInput(contents, ports, { type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  sendNativeInput(contents, ports, { type: 'mouseDown', ...point, button: 'left', clickCount: 2 })
  sendNativeInput(contents, ports, { type: 'mouseUp', ...point, button: 'left', clickCount: 2 })
  return result
}

interface WorldSculptVisualProofEvidence {
  initialBounds: { x: number; y: number; width: number; height: number }
  focusedBounds: { x: number; y: number; width: number; height: number }
  focusPoint: Point
  emptyPoints: [Point, Point]
  dblclickSequence: number
}

function cleanCloseupObservation(before: AuthoringView, view: AuthoringView, entityId: string) {
  const previous = before.canvas!, current = view.canvas
  const beforeBounds = previous.models.find((candidate) => candidate.entityId === entityId)?.bounds
  const afterBounds = current?.models.find((candidate) => candidate.entityId === entityId)?.bounds
  const cameraDelta = current?.camera.length === previous.camera.length && current.camera.every(Number.isFinite)
    ? current.camera.map((value, index) => value - previous.camera[index]) : null
  return structuredClone({ view, cameraDelta, predicates: {
    ownerUnchanged: view.bootId === before.bootId && current?.canvasUuid === previous.canvasUuid && current.cameraFraming.uuid === previous.cameraFraming.uuid,
    selectionEmpty: view.selection.active === null && view.selection.ids.length === 0,
    gizmoHidden: current?.gizmo === null,
    modelPresent: current?.models.some((candidate) => candidate.entityId === entityId) ?? false,
    cameraPreserved: cameraDelta !== null && !changed(previous.camera, current!.camera),
    framed: framed(view, entityId),
    projectedSizePreserved: !!beforeBounds && !!afterBounds && afterBounds.width >= beforeBounds.width * 0.99 && afterBounds.height >= beforeBounds.height * 0.99,
  } })
}

async function prepareWorldSculptVisualProof(
  contents: WebContents,
  ports: CommonDriverPorts,
  initialView: AuthoringView,
  entityId: string,
  expectedCanonical: ReturnType<typeof canonicalState>,
): Promise<{ view: AuthoringView; evidence: WorldSculptVisualProofEvidence }> {
  const initial = model(initialView, entityId)
  assert.ok(initial.bounds && initial.bounds.width > 0 && initial.bounds.height > 0, 'WorldSculpt needs finite projected bounds before native focus')
  const initialBounds = { ...initial.bounds }
  const firstEmptyPoint = await nativeCanvasClick(contents, ports)
  let view = await waitFor(contents, ports, (current) => current.selection.active === null && current.selection.ids.length === 0
    && current.canvas?.gizmo === null && current.canvas.models.some((candidate) => candidate.entityId === entityId), 'worldsculpt-native-deselect')
  assertCanonicalState(view, ports, expectedCanonical)

  const focus = await nativeCanvasDoubleClick(contents, ports, entityId)
  let quiet: { camera: number[]; at: number; firstFrame: number; lastFrame: number; observations: number } | undefined
  view = await waitFor(contents, ports, (current) => {
    assert.ok(current.bootId === focus.bootId && current.canvas?.canvasUuid === focus.canvasUuid
      && current.canvas.cameraFraming.uuid === focus.cameraUuid, 'Native focus owner changed during settlement')
    const exactFocusEvents = current.trace.filter((event) => event.sequence > focus.traceStart && event.type === 'dblclick'
      && event.trusted && event.canvasUuid === focus.canvasUuid && event.x === focus.point.x && event.y === focus.point.y)
    const eligible = current.selection.active === entityId && !!current.canvas && current.canvas.controls.orbitEnabled === true
      && current.navigation.status === INSPECT_STATUS && framed(current, entityId) && exactFocusEvents.length === 1
    if (!eligible) { quiet = undefined; return false }
    const { camera, frame } = current.canvas, at = Date.parse(current.at)
    assert.ok(camera.length === 32 && camera.every(Number.isFinite) && Number.isFinite(at) && Number.isSafeInteger(frame))
    // Framing can precede the final focus pose. Observe quietness; never delay blindly or extend the focus budget.
    if (!quiet || changed(quiet.camera, camera)) {
      quiet = { camera: [...camera], at, firstFrame: frame, lastFrame: frame, observations: 1 }
      return false
    }
    if (frame <= quiet.lastFrame) return false
    quiet.lastFrame = frame; quiet.observations++
    return quiet.observations >= 3 && at - quiet.at >= 120
  }, 'worldsculpt-native-double-click-focus', 8000)
  assert.ok(view.canvas)
  const focused = model(view, entityId)
  assert.ok(focused.bounds)
  const focusEvidence = admitNativeCanvasFocusEvidence({
    beforeCamera: focus.beforeCamera,
    afterCamera: view.canvas.camera,
    beforeBounds: initialBounds,
    afterBounds: focused.bounds,
    afterWorldCorners: focused.worldCorners,
    trace: view.trace,
    traceStart: focus.traceStart,
    point: focus.point,
    canvasUuid: focus.canvasUuid,
  })
  const focusedBounds = { ...focused.bounds }
  const focusedCamera = [...view.canvas.camera]
  assertCanonicalState(view, ports, expectedCanonical)
  const before = structuredClone(view), label = `worldsculpt-focus-${view.bootId}-${focus.traceStart}`
  ports.record(`${label}-before`, structuredClone({ view: before, focus, settlement: quiet }))
  let lastCleanView: AuthoringView | undefined
  try {
    const secondEmptyPoint = await nativeCanvasClick(contents, ports)
    view = await waitFor(contents, ports, (current) => {
      lastCleanView = current
      return current.selection.active === null && current.selection.ids.length === 0
        && current.canvas?.gizmo === null && current.canvas.models.some((candidate) => candidate.entityId === entityId)
        && !changed(focusedCamera, current.canvas.camera) && framed(current, entityId)
    }, 'worldsculpt-native-clean-closeup')
    ports.record(`${label}-after`, cleanCloseupObservation(before, view, entityId))
    assert.ok(view.canvas)
    assert.equal(changed(focusedCamera, view.canvas.camera), false, 'Canvas deselection must preserve the focused camera')
    const clean = model(view, entityId)
    assert.ok(clean.bounds)
    assert.ok(clean.bounds.width >= focusedBounds.width * 0.99 && clean.bounds.height >= focusedBounds.height * 0.99, 'Clean closeup lost the focused projected size')
    assertCanonicalState(view, ports, expectedCanonical)
    return {
      view,
      evidence: {
        initialBounds,
        focusedBounds,
        focusPoint: { ...focus.point },
        emptyPoints: [{ ...firstEmptyPoint }, { ...secondEmptyPoint }],
        dblclickSequence: focusEvidence.dblclickSequence,
      },
    }
  } catch (error) {
    if (lastCleanView) ports.record(`${label}-after`, cleanCloseupObservation(before, lastCleanView, entityId))
    let observation: unknown
    try { ports.guard(contents); observation = cleanCloseupObservation(before, await readView(contents), entityId); ports.guard(contents) }
    catch (observationError) { observation = { unavailable: String(observationError) } }
    ports.record(`${label}-error`, { error: String(error), observation })
    throw error
  }
}

async function nativeOrbitDrag(contents: WebContents, ports: CommonDriverPorts): Promise<void> {
  const { point: start } = await settleNativePoint(contents, ports, null)
  const end = { x: start.x - 90, y: start.y - 42 }
  let down = false
  try {
    ports.guard(); sendNativeInput(contents, ports, { type: 'mouseDown', ...start, button: 'left', clickCount: 1 }); down = true
    for (let step = 1; step <= 6; step += 1) {
      ports.guard()
      sendNativeInput(contents, ports, { type: 'mouseMove', x: Math.round(start.x + (end.x - start.x) * step / 6), y: Math.round(start.y + (end.y - start.y) * step / 6), button: 'left', modifiers: ['leftbuttondown'] })
    }
  } finally {
    if (down && !contents.isDestroyed()) sendNativeInput(contents, ports, { type: 'mouseUp', ...end, button: 'left', clickCount: 1 })
  }
}

async function holdKeys(contents: WebContents, ports: CommonDriverPorts, keyCodes: readonly string[], milliseconds: number): Promise<void> {
  assert.ok(milliseconds >= 25 && milliseconds <= 400)
  const held: string[] = []
  try {
    for (const keyCode of keyCodes) { ports.guard(); sendNativeInput(contents, ports, { type: 'keyDown', keyCode }); held.push(keyCode) }
    const deadline = Date.now() + milliseconds
    while (Date.now() < deadline) { ports.guard(); await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now()))) }
  } finally {
    if (!contents.isDestroyed()) for (const keyCode of [...held].reverse()) sendNativeInput(contents, ports, { type: 'keyUp', keyCode })
  }
}

function captureNativeLook(view: AuthoringView) {
  assert.ok(view.canvas)
  return structuredClone({ at: view.at, bootId: view.bootId, canvasUuid: view.canvas.canvasUuid, frame: view.canvas.frame,
    pose: view.canvas.cameraPose, lock: view.navigation.pointerLock, status: view.navigation.status,
    orbit: view.canvas.controls.orbitEnabled, traceSequence: view.trace.at(-1)?.sequence ?? 0, trace: view.trace.slice(-4) })
}

function hasNativeLookReceipt(view: AuthoringView, before: ReturnType<typeof captureNativeLook>, delta: Point, cameraResponse: boolean): boolean {
  if (!view.canvas || view.bootId !== before.bootId || view.canvas.canvasUuid !== before.canvasUuid
    || !view.navigation.pointerLock.canvasOwned || view.navigation.pointerLock.changes !== before.lock.changes
    || view.navigation.pointerLock.errors !== 0 || view.canvas.controls.orbitEnabled !== false || view.navigation.status !== FLY_LOCKED_STATUS) return false
  const events = ['pointermove', 'mousemove'].map((type) => view.trace.find((event) => event.sequence > before.traceSequence && event.type === type
    && event.trusted && event.canvasUuid === before.canvasUuid && event.movementX === delta.x && event.movementY === delta.y
    && event.frame !== null && event.frame >= before.frame && view.canvas!.frame > event.frame))
  return events.every(Boolean) && events[0]!.sequence < events[1]!.sequence && view.canvas.frame > before.frame
    && (!cameraResponse || ((delta.x !== 0 || delta.y !== 0) && changed(before.pose.quaternion, view.canvas.cameraPose.quaternion)))
}

async function nativeRelativeLook(contents: WebContents, ports: CommonDriverPorts, view: AuthoringView, point: Point, delta: Point, label: string, prime: boolean, deadline: number): Promise<AuthoringView> {
  const remaining = () => { const value = deadline - Date.now(); assert.ok(value > 0 && value <= 4000, 'Native look exceeded its original 4000-ms deadline'); return value }
  const owner = { bootId: view.bootId, canvasUuid: view.canvas!.canvasUuid, lockChanges: view.navigation.pointerLock.changes }
  try {
    if (prime) {
      const before = captureNativeLook(view)
      remaining()
      sendNativeInput(contents, ports, { type: 'mouseMove', ...point, movementX: 0, movementY: 0 }, {
        owner, beforeSend(payload) { ports.record(`${label}-prime-before`, { observation: before, payload }) },
      })
      view = await waitFor(contents, ports, (current) => hasNativeLookReceipt(current, before, { x: 0, y: 0 }, false), `${label}-prime`, remaining())
      ports.record(`${label}-prime-after`, captureNativeLook(view))
    }
    // Priming can change the camera. Capture the measurement baseline only after its observed receipt.
    ports.guard(contents); view = await readView(contents); ports.guard(contents)
    const before = captureNativeLook(view)
    assert.equal(before.bootId, owner.bootId); assert.equal(before.canvasUuid, owner.canvasUuid)
    assert.equal(before.lock.changes, owner.lockChanges); assert.equal(before.lock.canvasOwned, true); assert.equal(before.lock.errors, 0)
    remaining()
    sendNativeInput(contents, ports, { type: 'mouseMove', ...point, movementX: delta.x, movementY: delta.y }, {
      owner, beforeSend(payload) { ports.record(`${label}-before`, { observation: before, payload }) },
    })
    view = await waitFor(contents, ports, (current) => hasNativeLookReceipt(current, before, delta, true), label, remaining())
    ports.record(`${label}-after`, captureNativeLook(view))
    return view
  } catch (error) {
    let observation: unknown
    try { ports.guard(contents); observation = captureNativeLook(await readView(contents)); ports.guard(contents) }
    catch (observationError) { observation = { unavailable: String(observationError) } }
    ports.record(`${label}-error`, { error: String(error), observation })
    throw error
  }
}

export async function runWorldSculptNavigationAcceptance(
  initialContents: WebContents,
  ports: WorldSculptNavigationDriverPorts,
  authored: UiAuthoredBaseline,
): Promise<void> {
  let contents = initialContents
  ports.stage('native-worldsculpt-library-add')
  let view = await readView(contents)
  assert.equal(view.editor.lifecycle, 'ready')
  assert.equal(view.editor.projectKey, authored.projectKey)
  const beforeSceneAdd = snapshot(view), sceneApplyOffset = ports.applies().length
  const existingSceneIds = new Set(beforeSceneAdd.scenes.map((scene) => scene.sceneId))
  await click(contents, ports, 'button', 'Add scene')
  view = await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready'
    && snapshot(current).project.revision === beforeSceneAdd.project.revision + 1
    && snapshot(current).scenes.length === beforeSceneAdd.scenes.length + 1
    && current.editor.activeSceneId !== null && !existingSceneIds.has(current.editor.activeSceneId)
    && snapshot(current).scenes.find((scene) => scene.sceneId === current.editor.activeSceneId)?.entities.length === 0,
  'worldsculpt-add-empty-scene', 12000)
  assert.equal(ports.applies().length, sceneApplyOffset + 1, 'WorldSculpt scene creation requires exactly one successful UI command envelope')
  const sceneInvocation = ports.applies()[sceneApplyOffset]
  assertSuccessfulUiApply(beforeSceneAdd, snapshot(view), sceneInvocation, ['add-scene'])
  const sceneCommand = sceneInvocation.request.batch.commands[0]
  assert.equal(sceneCommand.type, 'add-scene')
  if (sceneCommand.type !== 'add-scene') throw new Error('WorldSculpt setup requires one actual add-scene command')
  const worldSculptSceneId = sceneCommand.scene.sceneId
  assert.equal(sceneCommand.reference.id, worldSculptSceneId)
  assert.equal(view.editor.activeSceneId, worldSculptSceneId)
  assert.equal(sceneCommand.scene.entities.length, 0)
  const expectedAfterScene = structuredClone(beforeSceneAdd)
  expectedAfterScene.project.revision += 1
  expectedAfterScene.project.scenes.push(structuredClone(sceneCommand.reference))
  expectedAfterScene.scenes.push(structuredClone(sceneCommand.scene))
  assert.deepEqual(snapshot(view), expectedAfterScene, 'Scene creation changed data beyond the canonical add-scene command')
  ports.record('worldsculpt-empty-scene-add', {
    transactionId: sceneInvocation.request.batch.transactionId,
    sceneId: worldSculptSceneId,
    baseRevision: beforeSceneAdd.project.revision,
    appliedRevision: snapshot(view).project.revision,
    command: structuredClone(sceneCommand),
  })

  await click(contents, ports, 'button', 'Assets')
  view = await waitFor(contents, ports, (current) => current.editor.activeSceneId === worldSculptSceneId
    && current.assetButtons.filter((label) => label === 'Add scene.glb to scene').length === 1, 'worldsculpt-library-action')
  const beforeAdd = snapshot(view), applyOffset = ports.applies().length
  await click(contents, ports, 'button', 'Add scene.glb to scene')
  view = await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready'
    && snapshot(current).project.revision === beforeAdd.project.revision + 1
    && current.editor.activeSceneId === worldSculptSceneId
    && current.canvas?.models.length === 1 && current.canvas.models[0].triangles === 4916, 'worldsculpt-production-add', 12000)
  assert.equal(ports.applies().length, applyOffset + 1, 'WorldSculpt add requires exactly one successful UI command envelope')
  const invocation = ports.applies()[applyOffset]
  assertSuccessfulUiApply(beforeAdd, snapshot(view), invocation, ['add-resource', 'add-entity'])
  const addedEntity = invocation.request.batch.commands.find((command) => command.type === 'add-entity')
  assert.ok(addedEntity?.type === 'add-entity' && addedEntity.sceneId === worldSculptSceneId)
  const addedResource = invocation.request.batch.commands.find((command) => command.type === 'add-resource')
  assert.ok(addedResource?.type === 'add-resource')
  const worldSculptEntityId = addedEntity.entity.id
  const renderable = addedEntity.entity.components.find((component) => component.type === 'renderable')
  assert.ok(renderable?.type === 'renderable')
  assert.equal(renderable.resourceId, addedResource.resource.id)
  const resource = snapshot(view).project.resources.find((candidate) => candidate.id === renderable.resourceId)
  assert.ok(resource?.type === 'model'); assert.equal(resource.workspacePath, WORLD_SCULPT_WORKSPACE_RELATIVE_PATH)
  const expectedAfterAsset = structuredClone(beforeAdd)
  expectedAfterAsset.project.revision += 1
  expectedAfterAsset.project.resources.push(structuredClone(addedResource.resource))
  expectedAfterAsset.scenes.find((scene) => scene.sceneId === worldSculptSceneId)!.entities.push(structuredClone(addedEntity.entity))
  assert.deepEqual(snapshot(view), expectedAfterAsset, 'Asset import changed data beyond the canonical add-resource/add-entity commands')
  assert.equal(snapshot(view).scenes.find((scene) => scene.sceneId === worldSculptSceneId)?.entities.length, 1)
  ports.record('worldsculpt-asset-add', {
    transactionId: invocation.request.batch.transactionId,
    sceneId: worldSculptSceneId,
    entityId: worldSculptEntityId,
    resourceId: addedResource.resource.id,
    baseRevision: beforeAdd.project.revision,
    appliedRevision: snapshot(view).project.revision,
    commands: structuredClone(invocation.request.batch.commands),
  })
  model(view, worldSculptEntityId)
  await ports.pass('native-worldsculpt-library-add')

  ports.stage('native-inspect-orbit')
  const navigationBaseline = canonicalState(view, ports.applies().length)
  const traceStart = view.trace.length
  assertModeSet(view); assert.equal(mode(view, INSPECT_LABEL).checked, true)
  assert.equal(view.navigation.pointerLock.canvasOwned, false); assert.equal(view.canvas?.controls.orbitEnabled, true)
  assert.equal(view.navigation.status, INSPECT_STATUS)
  await click(contents, ports, 'button', 'Frame scene')
  view = await waitFor(contents, ports, (current) => framed(current, worldSculptEntityId) && current.navigation.status === INSPECT_STATUS, 'worldsculpt-framed', 8000)
  const initialVisualProof = await prepareWorldSculptVisualProof(contents, ports, view, worldSculptEntityId, navigationBaseline)
  view = initialVisualProof.view
  ports.record('worldsculpt-initial-closeup', initialVisualProof.evidence)
  view = await paint(contents, ports); view = await paint(contents, ports)
  const framedShot = await ports.checkpoint('12-worldsculpt-inspect-framed', view, contents)
  assertReopenedAuthoringVisual(framedShot, view, worldSculptEntityId)
  const inspectCamera = [...view.canvas!.camera]
  await nativeOrbitDrag(contents, ports)
  view = await waitFor(contents, ports, (current) => !!current.canvas && changed(inspectCamera, current.canvas.camera), 'trusted-inspect-orbit')
  assertCanonicalState(view, ports, navigationBaseline)
  const orbitTrace = view.trace.slice(traceStart)
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) assert.ok(orbitTrace.some((event) => event.type === type && event.trusted && event.canvasUuid === view.canvas?.canvasUuid), `Trusted Inspect ${type} missing`)
  await ports.checkpoint('13-worldsculpt-inspect-orbit', await paint(contents, ports), contents)
  await ports.pass('native-inspect-orbit')

  ports.stage('native-fly-pointer-lock')
  await click(contents, ports, 'button', FLY_LABEL)
  view = await waitFor(contents, ports, (current) => mode(current, FLY_LABEL).checked && current.canvas?.controls.orbitEnabled === false && current.navigation.status === 'Fly mode. Click viewport to capture pointer.', 'native-fly-mode')
  const lockChangesBefore = view.navigation.pointerLock.changes
  const canvasPoint = await nativeCanvasClick(contents, ports)
  view = await waitFor(contents, ports, (current) => current.navigation.pointerLock.canvasOwned && current.navigation.pointerLock.changes > lockChangesBefore && current.navigation.pointerLock.errors === 0 && current.navigation.status === FLY_LOCKED_STATUS, 'native-fly-pointer-lock')
  view = await nativeRelativeLook(contents, ports, view, canvasPoint, { x: 37, y: -19 }, 'native-fly-look', true, Date.now() + 4000)
  const flyBeforeMove = [...view.canvas!.cameraPose.position]
  await holdKeys(contents, ports, ['W'], 300)
  view = await waitFor(contents, ports, (current) => !!current.canvas && changed(flyBeforeMove, current.canvas.cameraPose.position), 'native-fly-translation')
  assert.equal(view.navigation.pointerLock.canvasOwned, true); assert.equal(view.canvas?.controls.orbitEnabled, false)
  assertCanonicalState(view, ports, navigationBaseline)
  await ports.checkpoint('14-worldsculpt-fly-locked', await paint(contents, ports), contents)
  await ports.pass('native-fly-pointer-lock')

  ports.stage('native-run-ground-only')
  const flyLockChanges = view.navigation.pointerLock.changes
  key(contents, ports, '3')
  view = await waitFor(contents, ports, (current) => mode(current, RUN_LABEL).checked && current.navigation.pointerLock.canvasOwned && current.canvas?.controls.orbitEnabled === false
    && [RUN_LOCKED_STATUS, RUN_FALLBACK_STATUS].includes(current.navigation.status ?? ''), 'native-run-lock-handoff')
  const retainedFlyToRun = view.navigation.pointerLock.changes === flyLockChanges
  assert.equal(retainedFlyToRun, true, 'Fly to Run must retain the authoritative pointer lock')
  const runBefore = [...view.canvas!.cameraPose.position]
  await holdKeys(contents, ports, ['Shift', 'W'], 320)
  view = await waitFor(contents, ports, (current) => !!current.canvas && current.navigation.pointerLock.canvasOwned && current.navigation.groundOnlyVisible
    && current.navigation.status === RUN_FALLBACK_STATUS && horizontalDistance(runBefore, current.canvas.cameraPose.position) > 0.01, 'native-run-ground-only')
  const runAfter = view.canvas!.cameraPose.position
  assert.ok(Math.abs(runAfter[1] - runBefore[1]) <= 1e-6, 'Ground-only fallback must pin camera Y')
  assert.ok(Math.abs(view.canvas!.cameraPose.yawPitchRoll[2]) <= 1e-6, 'Run mode must zero camera roll')
  assertCanonicalState(view, ports, navigationBaseline)
  await ports.checkpoint('15-worldsculpt-run-ground-only', await paint(contents, ports), contents)
  await ports.pass('native-run-ground-only')

  key(contents, ports, 'Escape')
  view = await waitFor(contents, ports, (current) => !current.navigation.pointerLock.canvasOwned && current.navigation.pointerLock.changes > flyLockChanges, 'native-pointer-release')
  await click(contents, ports, 'button', 'Frame scene')
  view = await waitFor(contents, ports, (current) => mode(current, INSPECT_LABEL).checked && !current.navigation.pointerLock.canvasOwned && current.canvas?.controls.orbitEnabled === true && current.navigation.status === INSPECT_STATUS && framed(current, worldSculptEntityId), 'native-inspect-restored', 8000)
  assertCanonicalState(view, ports, navigationBaseline)
  const finalNavigationView = view
  const navigationTrace = finalNavigationView.trace.slice(traceStart)
  const previousBoot = view.bootId

  ports.stage('native-navigation-document-isolation')
  contents = await ports.reopen()
  view = await waitFor(contents, ports, (current) => current.bootId !== previousBoot && current.editor.lifecycle === 'ready'
    && current.editor.projectKey === authored.projectKey && !!current.editor.activeSceneId
    && !!current.canvas && !current.canvas.contextLost && current.canvas.frame > 1, 'worldsculpt-fresh-reopen', 8000)
  await ports.admitReopened(contents, view, previousBoot)
  assert.deepEqual(snapshot(view), navigationBaseline.snapshot, 'Fresh repository/renderer lost the WorldSculpt document')
  assert.equal(ports.applies().length, navigationBaseline.applyCount)
  if (view.editor.activeSceneId !== worldSculptSceneId) {
    await selectValue(contents, ports, 'Active scene', worldSculptSceneId)
  }
  view = await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready'
    && current.editor.activeSceneId === worldSculptSceneId
    && current.canvas?.models.length === 1
    && current.canvas.models[0].entityId === worldSculptEntityId
    && current.canvas.models[0].triangles === 4916, 'worldsculpt-fresh-scene-selection', 8000)
  assert.deepEqual(snapshot(view), navigationBaseline.snapshot, 'Selecting the reopened WorldSculpt scene changed the document')
  assert.equal(ports.applies().length, navigationBaseline.applyCount)
  await click(contents, ports, 'button', 'Frame scene')
  view = await waitFor(contents, ports, (current) => framed(current, worldSculptEntityId) && mode(current, INSPECT_LABEL).checked && current.canvas?.controls.orbitEnabled === true, 'worldsculpt-fresh-frame', 8000)
  const reopenedCanonical = canonicalState(view, ports.applies().length)
  const restoredVisualProof = await prepareWorldSculptVisualProof(contents, ports, view, worldSculptEntityId, reopenedCanonical)
  view = restoredVisualProof.view
  ports.record('worldsculpt-restored-closeup', restoredVisualProof.evidence)
  view = await paint(contents, ports); view = await paint(contents, ports)
  const restoredShot = await ports.checkpoint('16-worldsculpt-restored-inspect', view, contents)
  assertReopenedAuthoringVisual(restoredShot, view, worldSculptEntityId)
  model(view, worldSculptEntityId)
  const graphics = finalNavigationView.canvas!
  ports.record('worldSculptNavigation', {
    schema: 'modly.worldsculpt-navigation-acceptance.v1', phase: 'complete', source: ports.source,
    inputTrace: navigationTrace,
    pointerLock: { changes: finalNavigationView.navigation.pointerLock.changes, errors: finalNavigationView.navigation.pointerLock.errors, acquired: true, retainedFlyToRun, released: !finalNavigationView.navigation.pointerLock.canvasOwned },
    graphics: { contextLost: graphics.contextLost, drawingBuffer: graphics.drawingBuffer, renderer: graphics.gl.renderer, unmaskedRenderer: graphics.gl.unmaskedRenderer },
    isolation: { canonicalUnchangedDuringNavigation: true, applyCountUnchanged: true, historyUnchanged: true, freshReopenMatched: true,
      observationCapabilityImmutable: finalNavigationView.navigation.observationCapability.writable === false && finalNavigationView.navigation.observationCapability.configurable === false },
    run: { groundOnlyFallback: true, colliderBacked: false, yPinned: true, horizontalMoved: true, rollZero: true },
    setup: { sceneId: worldSculptSceneId, entityId: worldSculptEntityId, sceneRevision: beforeSceneAdd.project.revision + 1, assetRevision: beforeAdd.project.revision + 1 },
    visualProof: { initial: initialVisualProof.evidence, restored: restoredVisualProof.evidence },
    screenshots: ['12-worldsculpt-inspect-framed.png', '13-worldsculpt-inspect-orbit.png', '14-worldsculpt-fly-locked.png', '15-worldsculpt-run-ground-only.png', '16-worldsculpt-restored-inspect.png'],
  })
  await ports.pass('native-navigation-document-isolation')
  await runColliderNavigationAcceptance(contents, ports)
}

async function revealInspectorTarget(contents: WebContents, ports: CommonDriverPorts, kind: 'button' | 'number', name: string): Promise<void> {
  ports.guard(contents)
  let view = await readView(contents)
  const ownerOf = (current: AuthoringView) => ({ bootId: current.bootId, canvasUuid: current.canvas?.canvasUuid,
    sceneId: current.editor.activeSceneId, selection: current.selection })
  const owner = structuredClone(ownerOf(view)), label = `inspector-reveal-${view.bootId}-${view.selection.active}-${name}`
  assert.ok(owner.canvasUuid && owner.sceneId && owner.selection.active)
  const samples: { at: number; frame: number; owner: ReturnType<typeof ownerOf>; target: Awaited<ReturnType<typeof observeNativeClickPoint>> }[] = []
  let quiet: { geometry: string; at: number; lastFrame: number; observations: number } | undefined
  let step = 0
  try {
    for (; step < 14; step++) {
      // Reuse each wheel step's existing 2000-ms paint budget for observed layout quietness.
      const deadline = Date.now() + 2000
      quiet = undefined
      let observed: Awaited<ReturnType<typeof observeNativeClickPoint>>
      for (;;) {
        ports.guard(contents)
        observed = await observeNativeClickPoint(contents, kind, name)
        ports.guard(contents)
        const sample = { at: Date.parse(view.at), frame: view.canvas?.frame ?? -1, owner: ownerOf(view), target: observed }
        samples.push(sample); if (samples.length > 8) samples.shift()
        assert.deepEqual(sample.owner, owner, 'Native Inspector owner changed during reveal')
        assert.equal(observed.matchCount, 1, `Ambiguous Inspector target: ${name}`)
        assert.equal(observed.enabled, true, `Disabled Inspector target: ${name}`)
        assert.ok(observed.visible && observed.rect && observed.inspector, `Inspector target or scroll owner missing: ${name}`)
        assert.ok([sample.at, sample.frame, ...Object.values(observed.rect), ...Object.values(observed.inspector.rect), observed.inspector.scrollTop, observed.inspector.scrollLeft].every(Number.isFinite))
        assert.ok(Date.now() < deadline, `Native Inspector target did not settle within 2000 ms: ${name}`)
        const geometry = JSON.stringify({ rect: observed.rect, inspector: observed.inspector })
        if (!quiet || quiet.geometry !== geometry) quiet = { geometry, at: sample.at, lastFrame: sample.frame, observations: 1 }
        else if (sample.frame > quiet.lastFrame) { quiet.lastFrame = sample.frame; quiet.observations++ }
        if (quiet.observations >= 3 && sample.at - quiet.at >= 120) break
        const frame = sample.frame
        view = await waitFor(contents, ports, (current) => !!current.canvas && current.canvas.frame > frame,
          'native-inspector-settlement', deadline - Date.now())
      }
      if (observed.hitMatches) { ports.record(label, structuredClone({ owner, step, quiet, samples })); return }
      const rect = observed.inspector!.rect
      assert.ok(observed.point.x < rect.x || observed.point.x >= rect.x + rect.width || observed.point.y < rect.y || observed.point.y >= rect.y + rect.height,
        `Inspector target occluded inside its scroll viewport: ${name}`)
      const point = await contents.executeJavaScript(`(() => {
        const elements = [...document.querySelectorAll('[aria-label="Entity inspector"]')];
        if (elements.length !== 1) throw new Error('Actual Inspector scroll owner missing');
        const r = elements[0].getBoundingClientRect();
        const point = { x: Math.round(r.x + r.width / 2), y: Math.round((Math.max(0, r.y) + Math.min(innerHeight, r.bottom)) / 2) };
        if (!elements[0].contains(document.elementFromPoint(point.x, point.y))) throw new Error('Inspector wheel owner occluded');
        return point;
      })()`, false) as Point
      sendNativeInput(contents, ports, { type: 'mouseMove', ...point })
      sendNativeInput(contents, ports, { type: 'mouseWheel', ...point, deltaX: 0, deltaY: observed.point.y > point.y ? -360 : 360 })
      view = await readView(contents)
    }
    throw new Error(`Native Inspector wheel did not reveal ${name}`)
  } catch (error) {
    ports.record(label, structuredClone({ owner, step, quiet, samples, error: String(error) }))
    throw error
  }
}

async function runColliderNavigationAcceptance(contents: WebContents, ports: WorldSculptNavigationDriverPorts): Promise<void> {
  ports.stage('native-collider-authoring')
  let view = await readView(contents)
  const authoringStart = ports.applies().length, beforeAuthoring = snapshot(view)
  const sceneOffset = ports.applies().length
  await click(contents, ports, 'button', 'Add scene')
  view = await waitFor(contents, ports, (v) => v.editor.lifecycle === 'ready' && snapshot(v).project.revision === beforeAuthoring.project.revision + 1, 'collider-add-scene')
  assert.equal(ports.applies().length, sceneOffset + 1)
  assertSuccessfulUiApply(beforeAuthoring, snapshot(view), ports.applies()[sceneOffset], ['add-scene'])
  const sceneCommand = ports.applies()[sceneOffset].request.batch.commands[0]
  assert.ok(sceneCommand.type === 'add-scene')
  const sceneId = sceneCommand.scene.sceneId
  assert.equal(view.editor.activeSceneId, sceneId)
  const entityIds: string[] = []
  for (const role of ['floor', 'wall'] as const) {
    await click(contents, ports, 'button', 'Assets')
    view = await readView(contents)
    const before = snapshot(view), offset = ports.applies().length
    await click(contents, ports, 'button', 'Add red-cube.glb to scene')
    view = await waitFor(contents, ports, (v) => v.editor.lifecycle === 'ready' && snapshot(v).project.revision === before.project.revision + 1 && !!v.selection.active, `collider-${role}-asset`)
    assert.equal(ports.applies().length, offset + 1)
    const invocation = ports.applies()[offset]
    // The Assets lane reuses the already registered cube resource on subsequent imports.
    assertSuccessfulUiApply(before, snapshot(view), invocation, ['add-entity'])
    const command = invocation.request.batch.commands[0]
    assert.ok(command.type === 'add-entity' && command.sceneId === sceneId)
    const id = command.entity.id; entityIds.push(id)
    assert.equal(view.selection.active, id)
    for (const label of ['Add Static Mesh', 'Add Fixed Body']) {
      const beforeComponent = snapshot(view), componentOffset = ports.applies().length
      await revealInspectorTarget(contents, ports, 'button', label)
      await click(contents, ports, 'button', label)
      view = await waitFor(contents, ports, (v) => v.editor.lifecycle === 'ready' && snapshot(v).project.revision === beforeComponent.project.revision + 1, `collider-${role}-${label}`)
      assert.equal(ports.applies().length, componentOffset + 1)
      assertSuccessfulUiApply(beforeComponent, snapshot(view), ports.applies()[componentOffset], ['add-component'])
    }
    const target = role === 'floor' ? { position: [0, 0, 0], scale: [30, 0.5, 30] } : { position: [0, 0.35, -2], scale: [16, 8, 1] }
    for (const field of ['position', 'scale'] as const) for (const axis of [0, 1, 2] as const) {
      const entity = snapshot(view).scenes.find((scene) => scene.sceneId === sceneId)!.entities.find((entity) => entity.id === id)!
      if (entity.transform[field][axis] !== target[field][axis]) {
        await revealInspectorTarget(contents, ports, 'number', `${field === 'position' ? 'Position' : 'Scale'}:${['X', 'Y', 'Z'][axis]}`)
        view = await numeric(contents, ports, sceneId, id, field, axis, target[field][axis])
      }
    }
  }
  const [floorId, wallId] = entityIds
  const baseline = canonicalState(view, ports.applies().length)
  const canonicalSha256 = createHash('sha256').update(JSON.stringify(baseline)).digest('hex')
  const geometry = await ports.collisionGeometry(view)
  assert.equal(geometry.length, 2)
  const observed = entityIds.map((id) => {
    const rendered = view.canvas?.models.find((model) => model.entityId === id)
    assert.ok(rendered?.visible && rendered.meshes === 1 && rendered.triangles === 12 && rendered.worldCorners.length === 8)
    const prepared = geometry.find((item) => item.entityId === id)!
    assert.ok(prepared && prepared.vertices === 36 && prepared.triangles === 12)
    const min = [0, 1, 2].map((axis) => Math.min(...rendered.worldCorners.map((corner) => corner.world[axis])))
    const max = [0, 1, 2].map((axis) => Math.max(...rendered.worldCorners.map((corner) => corner.world[axis])))
    for (const axis of [0, 1, 2]) {
      assert.ok(Number.isFinite(min[axis]) && Number.isFinite(max[axis]) && max[axis] > min[axis])
      assert.ok(Math.abs(min[axis] - prepared.min[axis]) < 1e-5 && Math.abs(max[axis] - prepared.max[axis]) < 1e-5, 'Visible and prepared collider bounds differ')
    }
    return { entityId: id, transform: structuredClone(rendered.transform), min, max }
  })
  const floor = geometry.find((item) => item.entityId === floorId)!, wall = geometry.find((item) => item.entityId === wallId)!
  const eyeY = floor.max[1] + 1.65
  const samples: ColliderRunSample[] = []
  const screenshots: ColliderRunScreenshot[] = []
  const traceStart = view.trace.at(-1)?.sequence ?? 0
  const take = async (phase: ColliderRunSample['phase']) => {
    view = await paint(contents, ports)
    assertCanonicalState(view, ports, baseline)
    assert.ok(view.canvas && [...view.canvas.cameraPose.position, ...view.canvas.cameraPose.quaternion].every(Number.isFinite))
    assert.equal(view.navigation.observationCapability.writable, false); assert.equal(view.navigation.observationCapability.configurable, false)
    const sample: ColliderRunSample = { phase, at: view.at, bootId: view.bootId, frame: view.canvas.frame, traceSequence: view.trace.at(-1)?.sequence ?? 0,
      position: [...view.canvas.cameraPose.position], quaternion: [...view.canvas.cameraPose.quaternion],
      status: view.navigation.status, groundOnly: view.navigation.groundOnlyVisible, locked: view.navigation.pointerLock.canvasOwned,
      lockChanges: view.navigation.pointerLock.changes, lockErrors: view.navigation.pointerLock.errors, orbit: view.canvas.controls.orbitEnabled,
      canonicalSha256: createHash('sha256').update(JSON.stringify(canonicalState(view, ports.applies().length))).digest('hex'), applyCount: ports.applies().length }
    samples.push(sample)
    return sample
  }
  const capture = async (name: string) => { screenshots.push(await ports.captureCollider(name, view, contents)) }
  await click(contents, ports, 'button', 'Frame scene')
  view = await waitFor(contents, ports, (v) => entityIds.every((id) => framed(v, id)), 'collider-scene-framed', 8000)
  await nativeCanvasClick(contents, ports)
  view = await paint(contents, ports)
  assert.equal(view.selection.active, null)
  await capture('17-collider-authored-inspect')
  await ports.pass('native-collider-authoring')

  ports.stage('native-collider-ground-wall-slide')
  await click(contents, ports, 'button', FLY_LABEL)
  await nativeCanvasClick(contents, ports)
  view = await waitFor(contents, ports, (v) => v.navigation.status === FLY_LOCKED_STATUS && v.navigation.pointerLock.canvasOwned, 'collider-fly-lock')
  // Bounded feedback uses only observed pose and guarded native input, never camera/scene setters.
  const colliderLookDeadline = Date.now() + 4000
  for (let step = 0; step < 16; step++) {
    const [yaw, pitch, roll] = view.canvas!.cameraPose.yawPitchRoll
    assert.ok(Math.abs(roll) < 1e-6)
    if (Math.abs(yaw) < 0.015 && Math.abs(pitch) < 0.015) break
    const rect = view.canvas!.rect
    view = await nativeRelativeLook(contents, ports, view, { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
      { x: Math.max(-300, Math.min(300, Math.round(yaw / 0.002))), y: Math.max(-300, Math.min(300, Math.round(pitch / 0.002))) },
      `collider-look-${step}`, step === 0, colliderLookDeadline)
    await take('staging')
  }
  assert.ok(view.canvas!.cameraPose.yawPitchRoll.every((value) => Math.abs(value) < 0.015), 'Native look staging did not converge')
  const target = [0, floor.max[1] + 3.5, 3]
  for (let step = 0; step < 140; step++) {
    const delta = target.map((value, axis) => value - view.canvas!.cameraPose.position[axis])
    const axis = delta.map(Math.abs).indexOf(Math.max(...delta.map(Math.abs)))
    if (Math.abs(delta[axis]) < 0.16) break
    const code = axis === 0 ? (delta[axis] > 0 ? 'D' : 'A') : axis === 1 ? (delta[axis] > 0 ? 'Space' : 'Control') : (delta[axis] > 0 ? 'S' : 'W')
    await holdKeys(contents, ports, [code], Math.max(25, Math.min(250, Math.round(Math.abs(delta[axis]) / 4 * 800))))
    await take('staging')
  }
  const staged = await take('staging')
  assert.ok(target.every((value, axis) => Math.abs(staged.position[axis] - value) < 0.2), 'Native Fly position staging did not converge')
  key(contents, ports, '3')
  view = await waitFor(contents, ports, (v) => v.navigation.status === 'Run mode. Collider-backed.' && v.navigation.pointerLock.canvasOwned, 'collider-run-ready', 8000)
  // Sample the actual descent and several stable contacts; no Worker grounded flag is claimed.
  for (let step = 0; step < 45; step++) {
    const sample = await take('descent')
    if (Math.abs(sample.position[1] - eyeY) <= 0.04) break
    await new Promise((resolve) => setTimeout(resolve, 35))
  }
  for (let step = 0; step < 4; step++) { await new Promise((resolve) => setTimeout(resolve, 60)); await take('ground') }
  for (let step = 0; step < 10; step++) {
    await holdKeys(contents, ports, ['W'], 250)
    const sample = await take('approach')
    if (sample.position[2] <= wall.max[2] + 0.36) break
  }
  for (let step = 0; step < 3; step++) { await holdKeys(contents, ports, ['W'], 250); await take('contact') }
  await capture('18-collider-wall-contact')
  for (let step = 0; step < 3; step++) { await holdKeys(contents, ports, ['W', 'D'], 250); await take('slide') }
  await ports.pass('native-collider-ground-wall-slide')

  ports.stage('native-collider-jump-handoff')
  await take('jump')
  // Keep Space down across an actual rendered frame, then release, to expose a real jump edge to the Worker.
  sendNativeInput(contents, ports, { type: 'keyDown', keyCode: 'Space' })
  try { await take('jump') } finally { sendNativeInput(contents, ports, { type: 'keyUp', keyCode: 'Space' }) }
  for (let step = 0; step < 35; step++) {
    const sample = await take('jump')
    if (step > 8 && Math.abs(sample.position[1] - eyeY) <= 0.04) break
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  for (let step = 0; step < 3; step++) { await new Promise((resolve) => setTimeout(resolve, 50)); await take('jump') }
  await capture('19-collider-jump-landed')
  await take('runExit'); key(contents, ports, '2')
  view = await waitFor(contents, ports, (v) => v.navigation.status === FLY_LOCKED_STATUS, 'collider-run-fly-handoff')
  await take('flyEnter')
  // Fly must cross the previously blocking wall at the same eye level.
  await holdKeys(contents, ports, ['W'], 400); await take('flyMove')
  const reservedExit = await ports.releaseReservedEscape(contents)
  view = reservedExit.view
  assertCanonicalState(view, ports, baseline)
  const reservedEscape = reservedExit.receipt
  assert.ok(reservedEscape.unlocked)
  ports.record('collider-unlocked-before-frame-scene', view)
  await click(contents, ports, 'button', 'Frame scene')
  view = await waitFor(contents, ports, (v) => v.navigation.status === INSPECT_STATUS && v.canvas?.controls.orbitEnabled === true && v.canvas.frame > reservedEscape.unlocked!.frame && entityIds.every((id) => framed(v, id)), 'collider-inspect-handoff')
  assert.equal(view.bootId, reservedEscape.unlocked.bootId); assert.equal(view.canvas!.canvasUuid, reservedEscape.unlocked.canvasUuid)
  await take('inspect')
  const inputTrace = view.trace.filter((event) => event.sequence > traceStart)
  const bootId = view.bootId
  await ports.pass('native-collider-jump-handoff')

  ports.stage('native-collider-reopen')
  contents = await ports.reopen()
  view = await waitFor(contents, ports, (v) => v.bootId !== bootId && v.editor.lifecycle === 'ready' && !!v.editor.activeSceneId
    && !!v.canvas && !v.canvas.contextLost && v.canvas.frame > 1, 'collider-fresh-reopen', 8000)
  await ports.admitReopened(contents, view, bootId)
  assert.deepEqual(snapshot(view), baseline.snapshot); assert.equal(ports.applies().length, baseline.applyCount)
  if (view.editor.activeSceneId !== sceneId) await selectValue(contents, ports, 'Active scene', sceneId)
  await click(contents, ports, 'button', 'Frame scene')
  view = await waitFor(contents, ports, (v) => v.editor.activeSceneId === sceneId && v.canvas?.models.length === 2 && entityIds.every((id) => framed(v, id)), 'collider-reopened-frame', 8000)
  assert.deepEqual(snapshot(view), baseline.snapshot); assert.equal(ports.applies().length, baseline.applyCount)
  const reopenedGeometry = await ports.collisionGeometry(view)
  assert.deepEqual(reopenedGeometry, geometry)
  for (const item of observed) assert.deepEqual(view.canvas!.models.find((model) => model.entityId === item.entityId)!.transform, item.transform)
  view = await paint(contents, ports)
  await capture('20-collider-restored-inspect')
  ports.record('colliderRun', { schema: 'modly.collider-run-acceptance.v1', grounding: 'geometric-native-observation', sceneId, floorId, wallId,
    authoring: structuredClone(ports.applies().slice(authoringStart)), beforeAuthoring, baseline, canonicalSha256, geometry, observed, samples, inputTrace, reservedEscape, screenshots,
    reopened: { bootId: view.bootId, snapshot: snapshot(view), applyCount: ports.applies().length, geometry: reopenedGeometry, observed: view.canvas!.models.map((model) => ({ entityId: model.entityId, transform: model.transform })) } })
  await ports.pass('native-collider-reopen')
}
