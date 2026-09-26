import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { WORLD_RUN_GROUND_FALLBACK_LABEL } from '../../src/areas/worlds/worldCameraNavigation.ts'
import {
  assertReopenedAuthoringVisual,
  click,
  key,
  paint,
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
  point: Point; beforeCamera: number[]; traceStart: number; canvasUuid: string
}> {
  const { point, view } = await settleNativePoint(contents, ports, entityId)
  assert.ok(view.canvas)
  const result = { point: { ...point }, beforeCamera: [...view.canvas.camera], traceStart: view.trace.at(-1)?.sequence ?? 0, canvasUuid: view.canvas.canvasUuid }
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
  view = await waitFor(contents, ports, (current) => {
    const exactFocusEvents = current.trace.filter((event) => event.sequence > focus.traceStart && event.type === 'dblclick'
      && event.trusted && event.canvasUuid === focus.canvasUuid && event.x === focus.point.x && event.y === focus.point.y)
    return current.selection.active === entityId && !!current.canvas && current.canvas.controls.orbitEnabled === true
      && current.navigation.status === INSPECT_STATUS && framed(current, entityId) && exactFocusEvents.length === 1
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

  const secondEmptyPoint = await nativeCanvasClick(contents, ports)
  view = await waitFor(contents, ports, (current) => current.selection.active === null && current.selection.ids.length === 0
    && current.canvas?.gizmo === null && current.canvas.models.some((candidate) => candidate.entityId === entityId)
    && !changed(focusedCamera, current.canvas.camera) && framed(current, entityId), 'worldsculpt-native-clean-closeup')
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
  assert.ok(milliseconds >= 250 && milliseconds <= 400)
  const held: string[] = []
  try {
    for (const keyCode of keyCodes) { ports.guard(); sendNativeInput(contents, ports, { type: 'keyDown', keyCode }); held.push(keyCode) }
    const deadline = Date.now() + milliseconds
    while (Date.now() < deadline) { ports.guard(); await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now()))) }
  } finally {
    if (!contents.isDestroyed()) for (const keyCode of [...held].reverse()) sendNativeInput(contents, ports, { type: 'keyUp', keyCode })
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
  const flyBeforeLook = [...view.canvas!.cameraPose.quaternion]
  sendNativeInput(contents, ports, { type: 'mouseMove', x: canvasPoint.x + 37, y: canvasPoint.y - 19 })
  view = await waitFor(contents, ports, (current) => !!current.canvas && changed(flyBeforeLook, current.canvas.cameraPose.quaternion), 'native-fly-look')
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
    && current.editor.projectKey === authored.projectKey && !!current.editor.activeSceneId, 'worldsculpt-fresh-reopen', 8000)
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
}
