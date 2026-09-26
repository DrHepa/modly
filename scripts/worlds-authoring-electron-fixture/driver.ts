import assert from 'node:assert/strict'
import type { BrowserWindow, WebContents } from 'electron'
import type { WorldProjectSnapshotV1, WorldTransform } from '../../src/areas/worlds/core/worldModel.ts'
import type { WorldProjectCommandRequest, WorldProjectCommandResult } from '../../src/shared/types/worldProjects.ts'
import { NAMES, PROJECT_KEY, SCENE_ID, type AuthoringView, type CheckName, type HandleCandidate, type ModelObservation, type Point, type Rect, type SeedEvidence } from './shared.ts'
import { UI_ASSET_PATHS } from './scene.ts'

export interface Invocation {
  channel: string; receivedAt: string; request: WorldProjectCommandRequest
  forwardedAt?: string; settledAt?: string; result?: WorldProjectCommandResult; aborted?: boolean
}
export interface Shot { width: number; height: number; pixels: Buffer }
export interface DriverPorts {
  seed: SeedEvidence
  guard(contents?: WebContents): void
  inputGuard(contents: WebContents): void
  applies(): readonly Invocation[]
  arm(entityId: string, baseRevision: number, sceneId?: string): void
  held(): boolean
  release(): void
  abort(): void
  checkpoint(stage: string, view: AuthoringView, contents: WebContents): Promise<Shot>
  pass(name: CheckName): Promise<void>
  stage(name: CheckName): void
  record(name: string, value: unknown): void
  reopen(): Promise<WebContents>
}
export type CommonDriverPorts = Omit<DriverPorts, 'seed'>
export interface UiAuthoredBaseline {
  projectKey: string; sceneId: string; sceneIds: [string, string]
  names: { a: string; b: string }; seed: SeedEvidence
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export function sendNativeInput(contents: WebContents, ports: CommonDriverPorts, event: Parameters<WebContents['sendInputEvent']>[0]): void {
  // Every event, including releases, rechecks the exact focused owner synchronously.
  ports.inputGuard(contents)
  contents.sendInputEvent(event)
}
export function waitForOwnedWindowFocus(window: Pick<BrowserWindow, 'on' | 'removeListener' | 'isDestroyed' | 'isFocused'>, options: {
  deadline: number; signal: AbortSignal; assertOwned(): void
}): Promise<{ focusedAt: string; observedBy: 'already-focused' | 'native-focus-event' }> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null, settled = false
    function finish(error: unknown, observedBy?: 'already-focused' | 'native-focus-event'): void {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      window.removeListener('focus', onFocus); window.removeListener('closed', onClosed)
      options.signal.removeEventListener('abort', onAbort)
      if (observedBy === undefined) reject(error instanceof Error ? error : new Error(String(error)))
      else resolve({ focusedAt: new Date().toISOString(), observedBy })
    }
    function assertCandidate(): void {
      if (options.signal.aborted) throw options.signal.reason ?? new Error('Native focus admission aborted')
      options.assertOwned()
      assert.equal(window.isDestroyed(), false, 'Owned window destroyed during native focus admission')
      assert.ok(Number.isFinite(options.deadline) && Date.now() < options.deadline, 'Native focus admission deadline exceeded')
      if (options.signal.aborted) throw options.signal.reason ?? new Error('Native focus admission aborted')
    }
    function onFocus(): void {
      try {
        assertCandidate()
        assert.equal(window.isFocused(), true, 'Native focus event did not confirm the owned focused window')
        finish(null, 'native-focus-event')
      } catch (error) { finish(error) }
    }
    function onClosed(): void { finish(new Error('Owned window closed during native focus admission')) }
    function onAbort(): void { finish(options.signal.reason ?? new Error('Native focus admission aborted')) }
    try {
      if (options.signal.aborted) { onAbort(); return }
      assertCandidate()
      if (window.isFocused()) { finish(null, 'already-focused'); return }
      window.on('focus', onFocus); window.on('closed', onClosed)
      options.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        try { options.assertOwned(); finish(new Error('Native focus admission deadline exceeded')) }
        catch (error) { finish(error) }
      }, Math.max(0, options.deadline - Date.now()))
      // Recheck after listener installation; never treat a request to focus as proof.
      if (options.signal.aborted) onAbort()
      else { assertCandidate(); if (window.isFocused()) finish(null, 'already-focused') }
    } catch (error) { finish(error) }
  })
}
export async function readView(contents: WebContents): Promise<AuthoringView> {
  return contents.executeJavaScript('window.worldsAuthoringObserve()', false)
}
const snapshot = (view: AuthoringView) => { assert.ok(view.editor.session, 'Real controller session missing'); return view.editor.session.snapshot }
const entity = (value: WorldProjectSnapshotV1, id: string) => { const matches = value.scenes.flatMap((scene) => scene.entities.filter((item) => item.id === id)); assert.equal(matches.length, 1, `Expected one canonical entity ${id}`); return matches[0] }
const model = (view: AuthoringView, id: string): ModelObservation => {
  const matches = view.canvas?.models.filter((item) => item.entityId === id) ?? []
  assert.equal(matches.length, 1, `Expected one actual rendered root for ${id}`)
  const result = matches[0]
  assert.ok(result.visible && result.meshes > 0 && result.triangles > 0 && result.bounds && result.bounds.width > 5 && result.bounds.height > 5, `Model ${id} has no visible geometry`)
  return result
}
function healthy(view: AuthoringView, deniedAllowed = false): void {
  assert.deepEqual(view.environment, { sandboxed: true, contextIsolated: true })
  assert.deepEqual(view.nodeGlobals, { require: 'undefined', process: 'undefined' })
  assert.deepEqual(view.diagnostics, [], 'Mount / graphics / observation errors are fatal')
  assert.equal(view.untrustedInputs, 0, 'Only trusted native input is permitted')
  const unexpected = view.alerts.filter((value) => !(deniedAllowed && value === 'Wait for the current transform to finish.'))
  assert.deepEqual(unexpected, [], 'Unexpected Workbench alert')
  assert.equal(view.editor.error, null)
}
export async function waitFor(contents: WebContents, ports: CommonDriverPorts, predicate: (view: AuthoringView) => boolean, label: string, ms = 4000, denied = false): Promise<AuthoringView> {
  const deadline = Date.now() + ms
  let last: AuthoringView | undefined
  while (Date.now() < deadline) {
    ports.guard(contents)
    // The observation capability is installed synchronously before the full Workbench mounts.
    const ready = await contents.executeJavaScript('typeof window.worldsAuthoringObserve === "function"', false)
    ports.guard(contents)
    if (ready) { last = await readView(contents); ports.guard(contents); healthy(last, denied); if (predicate(last)) return last }
    await delay(40)
  }
  ports.record(`timeout-${label}`, last ?? null)
  throw new Error(`${label} was not reached within ${ms} ms`)
}
export async function paint(contents: WebContents, ports: CommonDriverPorts, denied = false): Promise<AuthoringView> {
  ports.guard(contents)
  const before = await readView(contents)
  ports.guard(contents)
  return waitFor(contents, ports, (value) => !!value.canvas && value.canvas.frame > (before.canvas?.frame ?? 0) + 1, 'actual-paint', 2000, denied)
}
interface NativeClickPointObservation {
  point: Point; matchCount: number; enabled: boolean; visible: boolean; hitMatches: boolean
  hit: { tagName: string; ariaLabel: string | null; text: string | null } | null
}
export function assertNativeClickPointStable(point: Point, observation: NativeClickPointObservation, name: string): void {
  assert.deepEqual(observation.point, point, `Native click point must not be retargeted: ${name}`)
  assert.equal(observation.matchCount, 1, `Ambiguous native DOM target: ${name}`)
  assert.equal(observation.enabled, true, `Disabled native target: ${name}`)
  assert.equal(observation.visible, true, `Hidden native target: ${name}`)
  assert.equal(observation.hitMatches, true, `Native click target drifted or was occluded after hover: ${name}; hit=${JSON.stringify(observation.hit)}`)
}
type NativeTargetKind = 'tree' | 'button' | 'number' | 'select' | 'ai-toggle' | 'ai-model' | 'ai-option' | 'ai-prompt' | 'ai-thinking'
export async function observeNativeClickPoint(contents: WebContents, kind: NativeTargetKind, name: string, point: Point | null = null): Promise<NativeClickPointObservation> {
  return contents.executeJavaScript(`(() => {
    const kind = ${JSON.stringify(kind)}, name = ${JSON.stringify(name)}, originalPoint = ${JSON.stringify(point)};
    const prompt = document.querySelectorAll('[aria-label="Worlds AI"] textarea[aria-label="Ask Worlds AI"]');
    const picker = prompt.length === 1 ? prompt[0].parentElement.querySelectorAll(':scope > div.flex > div.flex > div.relative > button') : [];
    const matches = kind === 'ai-toggle' ? [...document.querySelectorAll('[aria-label="Worlds AI"] .worlds-ai-drawer__bar button[aria-controls="worlds-ai-content"]')]
      : kind === 'ai-prompt' ? [...prompt]
      : kind === 'ai-model' ? [...picker]
      : kind === 'ai-option' ? (picker.length === 1 ? [...picker[0].parentElement.querySelectorAll(':scope > div > button')].filter(e => e.querySelector('span')?.textContent?.trim() === 'Ollama · ' + name) : [])
      : kind === 'ai-thinking' ? (prompt.length === 1 && ['Thinking: auto', 'Thinking: on', 'Thinking: off'].includes(name)
        ? [...prompt[0].parentElement.querySelectorAll('button[title]')].filter(e => e.getAttribute('title') === name) : [])
      : kind === 'tree'
      ? [...document.querySelectorAll('[role="treeitem"] .worlds-tree-name')].filter(e => e.textContent === name)
      : kind === 'number' ? [...document.querySelectorAll('[aria-label="Entity inspector"] input[type="number"]')].filter(e => e.closest('fieldset')?.querySelector('legend')?.textContent.trim().startsWith(name.split(':')[0]) && e.closest('label')?.querySelector('span')?.textContent === name.split(':')[1])
      : [...document.querySelectorAll(kind === 'select' ? 'select' : 'button')].filter(e => e.getAttribute('aria-label') === name);
    const e = matches.length === 1 ? matches[0] : null, r = e?.getBoundingClientRect();
    const point = originalPoint ?? (r ? {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} : {x: 0, y: 0});
    let visible = !!e && e.isConnected && !!r.width && !!r.height;
    for (let node = e; visible && node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) visible = false;
    }
    const hit = document.elementFromPoint(point.x, point.y);
    return {point, matchCount: matches.length, enabled: !!e && !e.matches(':disabled'), visible,
      hitMatches: !!e && (hit === e || e.contains(hit)),
      hit: hit ? {tagName: hit.tagName, ariaLabel: hit.getAttribute('aria-label'), text: hit.textContent} : null};
  })()`, false)
}
async function target(contents: WebContents, kind: NativeTargetKind, name: string): Promise<Point> {
  const observation = await observeNativeClickPoint(contents, kind, name)
  assertNativeClickPointStable(observation.point, observation, name)
  return observation.point
}
export async function click(contents: WebContents, ports: CommonDriverPorts, kind: NativeTargetKind, name: string): Promise<void> {
  ports.guard()
  const point = await target(contents, kind, name)
  ports.record(`native-click-${name}`, { at: new Date().toISOString(), ...point })
  sendNativeInput(contents, ports, { type: 'mouseMove', ...point })
  await contents.executeJavaScript(`new Promise((resolve, reject) => {
    let firstFrame, secondFrame;
    const timer = setTimeout(() => {
      cancelAnimationFrame(firstFrame); if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
      reject(new Error('Native click hover layout settlement exceeded 1000 ms'));
    }, 1000);
    firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => { clearTimeout(timer); resolve(); }); });
  })`, false)
  ports.guard()
  const hovered = await observeNativeClickPoint(contents, kind, name, point)
  ports.record(`native-click-hover-${name}`, { at: new Date().toISOString(), ...hovered })
  assertNativeClickPointStable(point, hovered, name)
  ports.guard()
  sendNativeInput(contents, ports, { type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  sendNativeInput(contents, ports, { type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}
function stableTransform(a: WorldTransform, b: WorldTransform, epsilon = 1e-8): void {
  for (const axis of ['position', 'rotation', 'scale'] as const) for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(a[axis][i] - b[axis][i]) < epsilon, `${axis}[${i}] changed unexpectedly`)
}
// Absolute tolerance for Three's double-precision Euler/quaternion round trips, not coordinate conversion.
// Root-level models require > 0.05 units of translation; 1e-7 cannot mask a no-op.
export const CAPTURED_TRANSFORM_TOLERANCE = 1e-7
export function assertCapturedTranslation(before: WorldTransform, preview: WorldTransform, actual: WorldTransform, axis: HandleCandidate['axis'], label: string): void {
  const chosen = ['X', 'Y', 'Z'].indexOf(axis)
  assert.ok(chosen >= 0, `${label}: expected one translation axis`)
  for (const value of [before, preview, actual]) {
    assert.deepEqual(Object.keys(value).sort(), ['position', 'rotation', 'scale'], `${label}: incomplete transform`)
    for (const field of ['position', 'rotation', 'scale'] as const) {
      assert.ok(Array.isArray(value[field]) && value[field].length === 3 && value[field].every(Number.isFinite), `${label}: nonfinite or incomplete ${field}`)
    }
  }
  assert.ok(Math.abs(preview.position[chosen] - before.position[chosen]) > 0.05, `${label}: no nonzero chosen-axis preview`)
  for (const field of ['position', 'rotation', 'scale'] as const) for (let index = 0; index < 3; index += 1) {
    assert.ok(Math.abs(actual[field][index] - preview[field][index]) <= CAPTURED_TRANSFORM_TOLERANCE, `${label}: ${field}[${index}] does not match the captured final preview`)
    if (field !== 'position' || index !== chosen) {
      for (const value of [preview, actual]) assert.ok(Math.abs(value[field][index] - before[field][index]) <= CAPTURED_TRANSFORM_TOLERANCE, `${label}: unrelated ${field}[${index}] changed during translation`)
    }
  }
}
export function assertNativeNumericCommit(before: WorldProjectSnapshotV1, after: WorldProjectSnapshotV1, sceneId: string, id: string, field: keyof WorldTransform, axis: 0 | 1 | 2, value: number, invocation: Invocation): void {
  assert.ok(Number.isFinite(value))
  const owner = before.scenes.find((scene) => scene.sceneId === sceneId)?.entities.find((item) => item.id === id)
  assert.ok(owner, 'Numeric edit must capture the actual scene/entity owner')
  assert.notEqual(owner.transform[field][axis], value, 'A no-op is not numeric authoring evidence')
  const expected = structuredClone(before)
  expected.project.revision += 1
  entity(expected, id).transform[field][axis] = value
  assert.deepEqual(after, expected, 'Numeric commit changed unrelated canonical data')
  assert.ok(invocation.forwardedAt && invocation.settledAt && invocation.result?.ok)
  assert.equal(invocation.request.batch.origin, 'ui')
  assert.equal(invocation.request.batch.projectId, before.project.projectId)
  assert.equal(invocation.request.batch.baseRevision, before.project.revision)
  assert.equal(invocation.request.batch.commands.length, 1)
  const command = invocation.request.batch.commands[0]
  assert.equal(command.type, 'patch-entity')
  if (command.type !== 'patch-entity') throw new Error('Numeric edit requires one actual transform patch')
  assert.equal(command.sceneId, sceneId); assert.equal(command.entityId, id)
  assert.deepEqual(Object.keys(command.patch), ['transform'])
  assert.deepEqual(command.patch.transform, entity(after, id).transform)
  if (invocation.result.ok) {
    assert.deepEqual(invocation.result.value.snapshot, after)
    assert.deepEqual(invocation.result.value.inverse, { kind: 'world-snapshot', snapshot: before }, 'Numeric inverse must match the captured before snapshot')
  }
}

export function assertUiAuthoredScene(value: WorldProjectSnapshotV1, sceneId: string, minimumModels = 2): void {
  const scene = value.scenes.find((item) => item.sceneId === sceneId)
  assert.ok(scene, 'Actual authored scene missing')
  const enabled = scene.entities.filter((item) => item.enabled)
  assert.ok(enabled.filter((item) => item.components.some((component) => component.type === 'renderable' && component.enabled)).length >= minimumModels, 'Actual model assets missing')
  assert.equal(enabled.filter((item) => item.components.some((component) => component.type === 'camera' && component.enabled && component.primary)).length, 1, 'Exactly one actual primary camera is required')
  assert.ok(enabled.some((item) => item.components.some((component) => component.type === 'light' && component.enabled)), 'Actual authored light missing')
}

export function assertBothScenesReopened(expected: WorldProjectSnapshotV1, actual: WorldProjectSnapshotV1, sceneIds: readonly string[], oldBoot: string, newBoot: string): void {
  assert.equal(sceneIds.length, 2); assert.equal(new Set(sceneIds).size, 2)
  assert.notEqual(newBoot, oldBoot, 'Reopen must use a genuinely fresh renderer')
  assert.deepEqual(actual, expected, 'Both-scene durable snapshot changed during reopen')
  for (const id of sceneIds) assertUiAuthoredScene(actual, id)
}

function unchangedExceptTransform(before: WorldProjectSnapshotV1, after: WorldProjectSnapshotV1, id: string): void {
  const expected = structuredClone(before)
  expected.project.revision += 1
  entity(expected, id).transform = structuredClone(entity(after, id).transform)
  assert.deepEqual(after, expected, 'A transform/history operation changed unrelated canonical data')
}
export function assertInspector(view: AuthoringView, transform: WorldTransform, pending: boolean): void {
  const fields = view.inspectorValues.filter((field) => /^(Position|Rotation|Scale)\b/.test(field.label))
  assert.equal(fields.length, 9, 'Expected all nine real Inspector transform fields')
  for (const [label, key] of [['Position', 'position'], ['Rotation', 'rotation'], ['Scale', 'scale']] as const) {
    for (const [index, axis] of ['X', 'Y', 'Z'].entries()) {
      const matches = fields.filter((field) => field.label.startsWith(label) && field.label.endsWith(`:${axis}`))
      assert.equal(matches.length, 1)
      assert.equal(matches[0].disabled, pending, 'Inspector fieldset disabled state disagrees with admission')
      const expected = transform[key][index] * (key === 'rotation' ? 180 / Math.PI : 1)
      assert.ok(Math.abs(Number(matches[0].value) - expected) < 0.001, 'Inspector does not reflect canonical selection')
    }
  }
}
function candidate(view: AuthoringView, id: string): HandleCandidate {
  assert.equal(view.canvas?.gizmo?.entityId, id, 'Gizmo must own the selected model')
  const candidates = view.canvas!.gizmo!.candidates
  assert.ok(candidates.length > 0 && candidates.length <= 3, 'No unambiguous geometry-derived translation handle; do not guess')
  const selected = structuredClone(candidates[0])
  Object.freeze(selected.start); Object.freeze(selected.end)
  return Object.freeze(selected)
}
export function isNativeHandleHover(view: AuthoringView, handle: HandleCandidate, id: string, captured: AuthoringView): boolean {
  const canvas = view.canvas, previous = captured.canvas
  assert.ok(canvas && previous, 'Actual Canvas observation is required before native down')
  const gizmo = canvas.gizmo, owner = previous.gizmo
  assert.ok(gizmo && owner, 'Actual native gizmo owner observation is required')
  assert.ok(owner.controlUuid && owner.objectUuid && previous.canvasUuid, 'Captured native owner identity is missing')
  assert.equal(owner.enabled, true, 'Disabled or missing native enabled observation is not admission denial')
  assert.equal(gizmo.enabled, true, 'Disabled or missing native enabled observation is not admission denial')
  assert.deepEqual([canvas.canvasUuid, gizmo.controlUuid, gizmo.objectUuid, gizmo.entityId, gizmo.mode],
    [previous.canvasUuid, owner.controlUuid, owner.objectUuid, id, 'translate'], 'Native control or attached actor owner drifted')
  assert.equal(owner.entityId, id); assert.equal(gizmo.dragging, false)
  const roots = canvas.models.filter((item) => item.entityId === id)
  assert.equal(roots.length, 1, 'Attached actor must have one rendered owner')
  assert.equal(roots[0].uuid, gizmo.objectUuid, 'Gizmo is not attached to the actual rendered actor')
  assert.equal(view.bootId, captured.bootId); assert.equal(canvas.contextLost, false)
  assert.deepEqual(canvas.rect, previous.rect, 'Canvas viewport drifted after candidate capture')
  assert.deepEqual([view.editor.projectKey, view.editor.activeSceneId, view.editor.lifecycle],
    [captured.editor.projectKey, captured.editor.activeSceneId, captured.editor.lifecycle], 'Project scene or pending lifecycle drifted')
  assert.deepEqual(view.editor.session, captured.editor.session, 'Canonical revision history or session changed before down')
  assert.deepEqual(view.selection, captured.selection); assert.deepEqual(captured.selection.ids, [id]); assert.equal(captured.selection.active, id)
  assert.equal(view.statuses.includes('Saving transform…'), captured.statuses.includes('Saving transform…'), 'Production pending marker drifted')
  assert.deepEqual(canvas.camera, previous.camera, 'Camera drifted before native down')
  const actors = (value: typeof canvas) => value.models.map(({ entityId, uuid, transform, matrixWorld }) => ({ entityId, uuid, transform, matrixWorld }))
  assert.deepEqual(actors(canvas), actors(previous), 'Rendered actor preview leaked before native down')
  const hit = gizmo.pointerHit
  assert.ok(hit, 'Last trusted native pointer observation is missing')
  assert.equal(hit.trusted, true); assert.equal(hit.targetCanvas, true, 'Pointer target is not the exact observed Canvas')
  assert.equal(hit.canvasUuid, canvas.canvasUuid, 'Native pointer belongs to another Canvas')
  assert.deepEqual(hit.point, handle.start, 'Frozen native handle point must not be retargeted')
  assert.equal(hit.type, 'pointermove'); assert.equal(hit.buttons, 0)
  const capturedSequence = captured.trace.at(-1)?.sequence ?? 0
  assert.ok(Number.isSafeInteger(hit.sequence) && hit.sequence > capturedSequence, 'Native pointer sequence is stale or invalid')
  assert.ok(Number.isSafeInteger(previous.frame) && Number.isSafeInteger(canvas.frame) && Number.isSafeInteger(hit.frame)
    && hit.frame! >= previous.frame && canvas.frame > previous.frame + 1 && canvas.frame > hit.frame! + 1, 'Native pointer/render frame evidence is stale or invalid')
  const input = view.trace.filter((item) => item.type?.startsWith('pointer') && item.trusted).at(-1)
  assert.ok(input, 'Trusted native pointer trace is missing')
  assert.deepEqual([input.sequence, input.type, input.x, input.y, input.buttons, input.canvasUuid, input.frame],
    [hit.sequence, hit.type, hit.point.x, hit.point.y, hit.buttons, canvas.canvasUuid, hit.frame], 'Fixed-point probe is not bound to the last trusted native trace')
  assert.equal(hit.firstHitAxis, handle.axis, 'Current rendered picker misses the frozen native point')
  assert.equal(hit.pickerUuid, handle.pickerUuid, 'Current fixed-point picker owner drifted')
  return view.canvas?.gizmo?.entityId === id && view.canvas.gizmo.axis === handle.axis
}
async function down(contents: WebContents, ports: CommonDriverPorts, handle: HandleCandidate, id: string, captured: AuthoringView, markDown: () => void, denied = false, assertHeld?: () => unknown): Promise<void> {
  const applyCount = ports.applies().length
  const admission = () => {
    ports.guard(); assert.equal(ports.applies().length, applyCount, 'Additional apply before native handle down')
    if (denied) { assert.ok(ports.held(), 'Held C apply was lost before native down'); assertHeld?.() }
  }
  admission()
  assert.equal(captured.canvas?.gizmo?.enabled, true, 'Actual enabled native control is required; disabled noninteraction is not denial')
  sendNativeInput(contents, ports, { type: 'mouseMove', ...handle.start })
  await paint(contents, ports, denied)
  const hovered = await waitFor(contents, ports, (view) => { admission(); return isNativeHandleHover(view, handle, id, captured) }, 'real-handle-hover', 1500, denied)
  ports.record('native-handle-fixed-point', { handle, canvas: hovered.canvas, trace: hovered.trace.find((item) => item.sequence === hovered.canvas?.gizmo?.pointerHit?.sequence) })
  admission()
  sendNativeInput(contents, ports, { type: 'mouseDown', ...handle.start, button: 'left', clickCount: 1 })
  markDown()
  await waitFor(contents, ports, (view) => view.canvas?.gizmo?.entityId === id && view.canvas.gizmo.dragging && view.canvas.gizmo.axis === handle.axis, 'real-handle-pointerdown', 1500, denied)
}
function up(contents: WebContents, ports: CommonDriverPorts, handle: HandleCandidate): void { sendNativeInput(contents, ports, { type: 'mouseUp', ...handle.end, button: 'left', clickCount: 1 }) }
type PaintColor = 'red' | 'blue' | 'neutral'
function colorCount(shot: Shot, bounds: Rect, color: PaintColor, exclude?: Rect): number {
  let count = 0
  const x0 = Math.max(0, Math.floor(bounds.x)), x1 = Math.min(shot.width, Math.ceil(bounds.x + bounds.width))
  const y0 = Math.max(0, Math.floor(bounds.y)), y1 = Math.min(shot.height, Math.ceil(bounds.y + bounds.height))
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    if (exclude && x >= exclude.x && x <= exclude.x + exclude.width && y >= exclude.y && y <= exclude.y + exclude.height) continue
    const i = (y * shot.width + x) * 4, b = shot.pixels[i], g = shot.pixels[i + 1], r = shot.pixels[i + 2]
    if (color === 'neutral' ? Math.min(r, g, b) > 110 && Math.max(r, g, b) - Math.min(r, g, b) < 35 : color === 'red' ? r > 90 && r > g * 1.45 && r > b * 1.45 : b > 90 && b > r * 1.4 && b > g * 1.3) count += 1
  }
  return count
}
function pixelChanges(before: Shot, after: Shot, region: Rect): number {
  assert.equal(before.width, after.width); assert.equal(before.height, after.height)
  let changed = 0
  for (let y = Math.max(0, Math.floor(region.y)); y < Math.min(after.height, Math.ceil(region.y + region.height)); y += 1) for (let x = Math.max(0, Math.floor(region.x)); x < Math.min(after.width, Math.ceil(region.x + region.width)); x += 1) {
    const i = (y * after.width + x) * 4
    if (Math.abs(before.pixels[i] - after.pixels[i]) + Math.abs(before.pixels[i + 1] - after.pixels[i + 1]) + Math.abs(before.pixels[i + 2] - after.pixels[i + 2]) > 60) changed += 1
  }
  return changed
}
function assertPaint(shot: Shot, view: AuthoringView, id: string, color: PaintColor, exclude?: Rect): number {
  const count = colorCount(shot, model(view, id).bounds!, color, exclude)
  assert.ok(count >= 25, `Screenshot lacks actual ${color} model pixels for ${id} (got ${count})`)
  return count
}
export function assertReopenedAuthoringVisual(shot: Shot, view: AuthoringView, id: string): number {
  const canvas = view.canvas
  assert.ok(canvas, 'Actual camera/viewport observation missing')
  const finiteArray = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every((item) => typeof item === 'number' && Number.isFinite(item))
  assert.ok(finiteArray(canvas.camera, 32), 'Actual camera matrices must be finite')
  const camera = canvas.cameraFraming
  assert.ok(camera && typeof camera.uuid === 'string' && camera.uuid.length > 0, 'Actual camera identity missing')
  assert.ok(finiteArray(camera.matrixWorldInverse, 16), 'Actual camera inverse matrix must be finite')
  assert.ok(Number.isFinite(camera.near) && Number.isFinite(camera.far) && camera.near > 0 && camera.far > camera.near, 'Actual camera near/far must be finite and positive')
  const viewport = canvas.rect
  assert.ok(viewport && [viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite) && viewport.width > 0 && viewport.height > 0, 'Actual viewport must be finite and positive')
  const corners = model(view, id).worldCorners
  assert.ok(Array.isArray(corners) && corners.length === 8, `All eight actual world-bound corners required for ${id}`)
  // Four percent of viewport width/height corresponds to an NDC limit of 0.92.
  for (const [index, corner] of corners.entries()) {
    assert.ok(corner && finiteArray(corner.world, 3) && finiteArray(corner.ndc, 3) && Number.isFinite(corner.depth), `World-bound corners must be finite for ${id}:${index}`)
    assert.ok(Math.abs(corner.ndc[0]) <= 0.92 && Math.abs(corner.ndc[1]) <= 0.92, `World-bound corner outside padded viewport for ${id}:${index}`)
    assert.ok(corner.depth > camera.near && corner.depth < camera.far, `World-bound corner outside positive camera depth for ${id}:${index}`)
    assert.ok(corner.ndc[2] > -1 && corner.ndc[2] < 1, `World-bound corner outside clip depth for ${id}:${index}`)
  }
  return assertPaint(shot, view, id, 'neutral')
}
function appliesCompleted(ports: CommonDriverPorts, count: number, origin: string): Invocation {
  assert.equal(ports.applies().length, count, 'Unexpected number of canonical authoring apply envelopes')
  const entry = ports.applies()[count - 1]
  assert.equal(entry.request.batch.origin, origin)
  assert.ok(entry.forwardedAt && entry.settledAt && entry.result?.ok, 'No successful unchanged production IPC receipt')
  if (entry.result.ok) { assert.equal(entry.result.value.idempotent, false); assert.deepEqual(entry.result.value.warnings, []) }
  return entry
}

export function key(contents: WebContents, ports: CommonDriverPorts, keyCode: string, modifiers: 'control'[] = []): void {
  ports.guard()
  sendNativeInput(contents, ports, { type: 'keyDown', keyCode, modifiers })
  sendNativeInput(contents, ports, { type: 'keyUp', keyCode, modifiers })
}

export async function selectValue(contents: WebContents, ports: CommonDriverPorts, name: string, value: string): Promise<void> {
  const index = await contents.executeJavaScript(`(() => {
    const matches = [...document.querySelectorAll('select')].filter(e => e.getAttribute('aria-label') === ${JSON.stringify(name)});
    if (matches.length !== 1) throw new Error('Ambiguous native select');
    const index = [...matches[0].options].findIndex(e => e.value === ${JSON.stringify(value)});
    if (index < 0) throw new Error('Actual option is absent');
    return index;
  })()`, false)
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < 16, 'Native select traversal is bounded')
  await click(contents, ports, 'select', name)
  key(contents, ports, 'Home')
  for (let step = 0; step < index; step += 1) key(contents, ports, 'Down')
  key(contents, ports, 'Return')
  await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready' && current.selectValues.some((select) => select.label === name && select.value === value), `native-select-${name}`)
}

export function isNativeNumericCommitSettled(view: AuthoringView, expectedRevision: number): boolean {
  return view.editor.lifecycle === 'ready' && snapshot(view).project.revision === expectedRevision
    && !view.statuses.includes('Saving transform…')
}

async function numeric(contents: WebContents, ports: CommonDriverPorts, sceneId: string, id: string, field: keyof WorldTransform, axis: 0 | 1 | 2, input: number): Promise<AuthoringView> {
  let view = await readView(contents)
  assert.equal(view.selection.active, id)
  const before = snapshot(view), value = field === 'rotation' ? input * Math.PI / 180 : input
  assert.notEqual(entity(before, id).transform[field][axis], value, 'Choose a meaningful native numeric edit')
  const offset = ports.applies().length, label = `${field[0].toUpperCase()}${field.slice(1)}:${['X', 'Y', 'Z'][axis]}`
  await click(contents, ports, 'number', label)
  key(contents, ports, 'A', ['control'])
  for (const character of String(input)) { ports.guard(); sendNativeInput(contents, ports, { type: 'char', keyCode: character }) }
  key(contents, ports, 'Return')
  view = await waitFor(contents, ports, (current) => isNativeNumericCommitSettled(current, before.project.revision + 1), `numeric-${sceneId}-${label}`, 12000)
  assertNativeNumericCommit(before, snapshot(view), sceneId, id, field, axis, value, appliesCompleted(ports, offset + 1, 'ui'))
  assertInspector(view, entity(snapshot(view), id).transform, false)
  ports.record(`numeric-${sceneId}-${id}-${label}`, { input, canonical: value, capturedOwner: { sceneId, entityId: id }, revision: snapshot(view).project.revision })
  return paint(contents, ports)
}

export async function runUiAuthoredScenes(contents: WebContents, ports: CommonDriverPorts, additionalAssetCount = 0): Promise<UiAuthoredBaseline> {
  assert.ok(Number.isSafeInteger(additionalAssetCount) && additionalAssetCount >= 0 && additionalAssetCount <= 1, 'Bounded additional asset count required')
  await waitFor(contents, ports, (view) => view.hostSetupComplete && view.editor.lifecycle === 'closed' && !view.editor.session, 'empty-native-Workbench')
  assert.equal(ports.applies().length, 0)
  await click(contents, ports, 'button', 'New World project')
  let view = await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready' && !!current.editor.session && !!current.editor.projectKey && !!current.editor.activeSceneId && !!current.canvas && !current.canvas.contextLost && current.canvas.frame > 1, 'native-project-positive-canvas', 8000)
  const projectKey = view.editor.projectKey!, firstSceneId = view.editor.activeSceneId!
  assert.equal(snapshot(view).scenes.length, 1); assert.equal(snapshot(view).scenes[0].entities.length, 0)
  assert.equal(ports.applies().length, 0, 'Canonical setup commands are forbidden in the UI lane')
  await ports.checkpoint('ui-00-empty-created-project', view, contents)
  await ports.pass('positive-canvas-admission')
  ports.stage('native-ui-project-and-both-scenes')
  const authored: { sceneId: string; ids: string[]; names: string[] }[] = []
  for (let sceneIndex = 0; sceneIndex < 2; sceneIndex += 1) {
    if (sceneIndex === 1) {
      const before = snapshot(view), offset = ports.applies().length
      await click(contents, ports, 'button', 'Add scene')
      view = await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready' && snapshot(current).scenes.length === 2 && current.editor.activeSceneId !== firstSceneId, 'native-add-second-scene', 12000)
      const invocation = appliesCompleted(ports, offset + 1, 'ui')
      assert.equal(invocation.request.batch.commands[0].type, 'add-scene')
      assert.deepEqual(snapshot(view).scenes.find((item) => item.sceneId === firstSceneId), before.scenes.find((item) => item.sceneId === firstSceneId))
    }
    const sceneId = view.editor.activeSceneId!, ids: string[] = [], names: string[] = []
    await click(contents, ports, 'button', 'Assets')
    view = await waitFor(contents, ports, (current) => current.assetButtons.length === UI_ASSET_PATHS.length + additionalAssetCount, 'actual-production-library-assets')
    for (const [assetIndex, path] of UI_ASSET_PATHS.entries()) {
      const matches = view.assetButtons.filter((label) => label.includes(path.split('/').at(-1)!))
      assert.equal(matches.length, 1, 'Actual discoverable input must have one Assets action')
      const before = snapshot(view), offset = ports.applies().length
      await click(contents, ports, 'button', matches[0])
      view = await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready' && snapshot(current).project.revision === before.project.revision + 1 && current.canvas?.models.length === assetIndex + 1 && current.canvas.models.every((item) => item.meshes > 0), 'native-add-model-asset', 12000)
      const invocation = appliesCompleted(ports, offset + 1, 'ui'), command = invocation.request.batch.commands.find((item) => item.type === 'add-entity')
      assert.ok(command?.type === 'add-entity'); assert.equal(command.sceneId, sceneId)
      const id = command.entity.id
      assert.equal(view.selection.active, id)
      ids.push(id); names.push(entity(snapshot(view), id).name)
    }
    await click(contents, ports, 'button', 'Scene')
    for (const kind of ['light', 'camera'] as const) {
      const before = snapshot(view), offset = ports.applies().length
      await click(contents, ports, 'button', `Add ${kind} entity`)
      view = await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready' && snapshot(current).project.revision === before.project.revision + 1 && !!current.selection.active && snapshot(current).scenes.find((item) => item.sceneId === sceneId)?.entities.find((item) => item.id === current.selection.active)?.components.some((component) => component.type === kind) === true, `native-add-${kind}`, 12000)
      const command = appliesCompleted(ports, offset + 1, 'ui').request.batch.commands[0]
      assert.ok(command.type === 'add-entity'); assert.equal(command.sceneId, sceneId)
      assert.ok(command.entity.components.some((component) => component.type === kind))
      if (kind === 'camera') {
        view = await numeric(contents, ports, sceneId, command.entity.id, 'position', 1, 2)
        view = await numeric(contents, ports, sceneId, command.entity.id, 'position', 2, 8)
        view = await numeric(contents, ports, sceneId, command.entity.id, 'rotation', 0, -15)
      }
    }
    await click(contents, ports, 'tree', names[0])
    view = await waitFor(contents, ports, (current) => current.selection.active === ids[0] && current.inspectorName === names[0], 'native-select-authored-model')
    for (const [field, values] of [['position', [-1.25, 0.25, 0.15]], ['rotation', [10, 15, 20]], ['scale', [1.1, 1.2, 1.3]]] as const) for (const axis of [0, 1, 2] as const) view = await numeric(contents, ports, sceneId, ids[0], field, axis, values[axis])
    await click(contents, ports, 'tree', names[1])
    view = await waitFor(contents, ports, (current) => current.selection.active === ids[1], 'native-select-second-model')
    view = await numeric(contents, ports, sceneId, ids[1], 'position', 0, 1.25)
    assertUiAuthoredScene(snapshot(view), sceneId)
    view = await paint(contents, ports)
    const shot = await ports.checkpoint(`ui-0${sceneIndex + 1}-authored-scene`, view, contents)
    for (const id of ids) { stableTransform(model(view, id).transform, entity(snapshot(view), id).transform); assertPaint(shot, view, id, 'neutral') }
    authored.push({ sceneId, ids, names })
  }
  assert.equal(authored.length, 2)
  await ports.pass('native-ui-project-and-both-scenes'); await ports.pass('native-numeric-authoring')
  await selectValue(contents, ports, 'Active scene', firstSceneId)
  view = await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready' && current.editor.activeSceneId === firstSceneId && current.canvas?.models.length === 2 && current.canvas.models.every((item) => item.meshes > 0 && authored[0].ids.includes(item.entityId)), 'native-switch-first-scene')
  const baseline = { projectKey, sceneId: firstSceneId, sceneIds: [firstSceneId, authored[1].sceneId] as [string, string], names: { a: authored[0].names[0], b: authored[0].names[1] }, seed: { snapshot: snapshot(view), aId: authored[0].ids[0], bId: authored[0].ids[1], sentinelSceneId: authored[1].sceneId } }
  ports.record('ui-authored-baseline', baseline)
  return baseline
}

export async function runAuthoringInteractions(initialContents: WebContents, ports: DriverPorts, authored?: UiAuthoredBaseline): Promise<void> {
  const projectKey = authored?.projectKey ?? PROJECT_KEY, sceneId = authored?.sceneId ?? SCENE_ID, names = authored?.names ?? NAMES
  const offset = ports.applies().length, initialHistory = (await readView(initialContents)).editor.session?.undoStack.length ?? 0
  const red: PaintColor = authored ? 'neutral' : 'red', blue: PaintColor = authored ? 'neutral' : 'blue'
  let contents = initialContents
  let pointerDown = false
  let lastHandle: HandleCandidate | null = null
  try {
    ports.stage('positive-canvas-admission')
    let view = await waitFor(contents, ports, (value) => value.hostSetupComplete && value.editor.lifecycle === 'ready' && value.canvasCount === 1 && !!value.canvas && !value.canvas.contextLost && value.canvas.frame > 1 && value.canvas.drawingBuffer.every((n) => n > 0) && value.canvas.models.length === 2 && value.canvas.models.every((item) => item.meshes > 0), 'positive-canvas-admission', 8000)
    assert.equal(view.editor.projectKey, projectKey); assert.equal(view.editor.activeSceneId, sceneId)
    assert.deepEqual(snapshot(view), ports.seed.snapshot); assert.equal(ports.applies().length, offset)
    assert.equal(view.editor.session!.undoStack.length, initialHistory); assert.deepEqual(view.editor.session!.redoStack, [])
    view = await paint(contents, ports)
    const initialShot = await ports.checkpoint('01-positive-canvas', view, contents)
    ports.record('initial-model-pixels', { a: assertPaint(initialShot, view, ports.seed.aId, red), b: assertPaint(initialShot, view, ports.seed.bId, blue) })
    await ports.pass('positive-canvas-admission')

    ports.stage('native-select-and-duplicate')
    await click(contents, ports, 'tree', names.a)
    view = await waitFor(contents, ports, (value) => value.selection.active === ports.seed.aId && value.inspectorName === names.a && value.canvas?.gizmo?.entityId === ports.seed.aId, 'select-A')
    await ports.checkpoint('02-a-selected', view, contents)
    await click(contents, ports, 'button', 'Duplicate selected entities')
    view = await waitFor(contents, ports, (value) => value.editor.lifecycle === 'ready' && snapshot(value).project.revision === ports.seed.snapshot.project.revision + 1 && value.canvas?.models.length === 3 && value.canvas.models.every((item) => item.meshes > 0), 'duplicate-C')
    const originalIds = new Set(ports.seed.snapshot.scenes.find((scene) => scene.sceneId === sceneId)!.entities.map((item) => item.id))
    const createdIds = snapshot(view).scenes.find((scene) => scene.sceneId === sceneId)!.entities.filter((item) => !originalIds.has(item.id)).map((item) => item.id)
    assert.equal(createdIds.length, 1)
    const cId = createdIds[0], c = entity(snapshot(view), cId)
    assert.equal(c.name, `${names.a} Copy`); assert.deepEqual(c.transform, entity(ports.seed.snapshot, ports.seed.aId).transform)
    assert.equal(view.selection.active, cId); assert.deepEqual(view.selection.ids, [cId])
    assert.equal(view.editor.session!.undoStack.length, initialHistory + 1); assert.equal(view.editor.session!.redoStack.length, 0)
    const duplicate = appliesCompleted(ports, offset + 1, 'ui')
    assert.equal(duplicate.request.batch.commands.length, 1); assert.equal(duplicate.request.batch.commands[0].type, 'add-entity')
    const expectedDuplicate = structuredClone(ports.seed.snapshot)
    expectedDuplicate.project.revision += 1
    expectedDuplicate.scenes.find((scene) => scene.sceneId === sceneId)!.entities.push(structuredClone(c))
    assert.deepEqual(snapshot(view), expectedDuplicate)
    assert.notEqual(model(view, cId).uuid, model(view, ports.seed.aId).uuid)
    view = await paint(contents, ports)
    const before = snapshot(view), beforeSession = structuredClone(view.editor.session), cBefore = structuredClone(c.transform)
    const beforeShot = await ports.checkpoint('03-c-duplicated-overlapping-a', view, contents)
    ports.record('duplication-scope', { cId, expectedInitialOverlap: true, note: 'Duplicate preserves A transform. This is creation evidence, not separate spatial visibility before drag.' })
    await ports.pass('native-select-and-duplicate')

    ports.stage('native-drag-preview')
    view = await paint(contents, ports)
    const cameraBefore = view.canvas!.camera, handle = candidate(view, cId)
    ports.record('primary-handle-geometry', { candidates: view.canvas!.gizmo!.candidates, selected: handle })
    ports.arm(cId, before.project.revision, sceneId)
    lastHandle = handle
    await down(contents, ports, handle, cId, view, () => { pointerDown = true })
    const previewSamples: AuthoringView[] = []
    for (let step = 1; step <= 8; step += 1) {
      sendNativeInput(contents, ports, { type: 'mouseMove', x: Math.round(handle.start.x + (handle.end.x - handle.start.x) * step / 8), y: Math.round(handle.start.y + (handle.end.y - handle.start.y) * step / 8), button: 'left', modifiers: ['leftbuttondown'] })
      view = await paint(contents, ports)
      assert.deepEqual(snapshot(view), before, 'A pointer preview changed the canonical revision/document')
      assert.deepEqual(view.editor.session, beforeSession, 'Preview altered command history or receipts')
      assert.equal(ports.applies().length, offset + 1, 'Transform apply was sent before pointer release')
      assert.deepEqual(view.canvas!.camera, cameraBefore, 'Pointer drag orbited the camera instead of moving C')
      assert.equal(view.canvas!.gizmo?.dragging, true)
      stableTransform(model(view, ports.seed.bId).transform, entity(before, ports.seed.bId).transform)
      previewSamples.push(view)
    }
    for (const id of [ports.seed.aId, ports.seed.bId, cId]) assert.equal(entity(before, id).parentId, null, 'Preview comparison requires the actual root-level seed entities')
    const cPreview = structuredClone(model(view, cId)), finalPreview = cPreview.transform
    for (const values of [finalPreview.position, finalPreview.rotation, finalPreview.scale]) Object.freeze(values)
    Object.freeze(finalPreview)
    assertCapturedTranslation(cBefore, finalPreview, finalPreview, handle.axis, 'Final observed C preview')
    const duringShot = await ports.checkpoint('04-during-native-drag', view, contents)
    const previewPixels = assertPaint(duringShot, view, cId, red, model(view, ports.seed.aId).bounds!)
    const previewDifference = pixelChanges(beforeShot, duringShot, cPreview.bounds!)
    assert.ok(previewDifference > 25, 'Screenshots do not show the displaced C preview')
    ports.record('preview-evidence', { capturedAt: new Date().toISOString(), entityId: cId, axis: handle.axis, absoluteTolerance: CAPTURED_TRANSFORM_TOLERANCE, finalPreview, samples: previewSamples, previewPixels, previewDifference })
    await ports.pass('native-drag-preview')

    ports.stage('pending-selection-and-overlap-denial')
    up(contents, ports, handle); pointerDown = false
    view = await waitFor(contents, ports, (value) => ports.held() && value.statuses.includes('Saving transform…'), 'held-production-transform')
    assert.equal(ports.applies().length, offset + 2)
    const held = ports.applies()[offset + 1]
    assert.equal(held.forwardedAt, undefined); assert.equal(held.result, undefined)
    const assertHeldPreview = (): WorldTransform => {
      assert.equal(ports.applies()[offset + 1], held); assert.ok(ports.held(), 'The exact C apply must still be held')
      assert.equal(held.forwardedAt, undefined); assert.equal(held.result, undefined)
      assert.equal(held.request.projectKey, projectKey); assert.equal(held.request.batch.baseRevision, before.project.revision)
      assert.equal(held.request.batch.commands.length, 1)
      const command = held.request.batch.commands[0]
      assert.equal(command.type, 'patch-entity')
      if (command.type !== 'patch-entity') throw new Error('Expected held C transform patch')
      assert.equal(command.sceneId, sceneId); assert.equal(command.entityId, cId)
      assert.deepEqual(Object.keys(command.patch), ['transform']); assert.ok(command.patch.transform)
      assertCapturedTranslation(cBefore, finalPreview, command.patch.transform, handle.axis, 'Held C request before release')
      return structuredClone(command.patch.transform)
    }
    assertHeldPreview()
    assert.deepEqual(view.editor.session, beforeSession)
    await ports.checkpoint('05-transform-held-before-production-handler', view, contents)
    await click(contents, ports, 'tree', names.b)
    view = await waitFor(contents, ports, (value) => value.selection.active === ports.seed.bId && value.inspectorName === names.b && value.canvas?.gizmo?.entityId === ports.seed.bId && value.statuses.includes('Saving transform…'), 'native-select-B-while-pending')
    const selectedPending = view
    assert.equal(view.editor.lifecycle, 'loading'); assert.deepEqual(view.editor.session, beforeSession)
    assertInspector(view, entity(before, ports.seed.bId).transform, true)
    await ports.checkpoint('06-b-selected-c-pending', view, contents)
    view = await paint(contents, ports)
    assertHeldPreview()
    assert.equal(ports.applies().length, offset + 2)
    assert.deepEqual(view.editor.session, beforeSession)
    assertInspector(view, entity(before, ports.seed.bId).transform, true)
    assert.equal(view.editor.projectKey, projectKey); assert.equal(view.editor.activeSceneId, sceneId)
    assert.equal(view.bootId, selectedPending.bootId); assert.deepEqual(view.selection, selectedPending.selection)
    assert.deepEqual([view.canvas?.gizmo?.controlUuid, view.canvas?.gizmo?.objectUuid, view.canvas?.gizmo?.entityId, view.canvas?.gizmo?.enabled],
      [selectedPending.canvas?.gizmo?.controlUuid, selectedPending.canvas?.gizmo?.objectUuid, ports.seed.bId, true], 'Pending native gizmo owner drifted during checkpoint')
    assert.deepEqual(view.canvas!.camera, selectedPending.canvas!.camera)
    for (const id of [ports.seed.bId, cId]) stableTransform(model(view, id).transform, model(selectedPending, id).transform)
    const overlap = candidate(view, ports.seed.bId)
    ports.record('overlap-handle-geometry', { checkpointFrame: selectedPending.canvas!.frame, refreshedFrame: view.canvas!.frame, candidates: view.canvas!.gizmo!.candidates, selected: overlap })
    lastHandle = overlap
    await down(contents, ports, overlap, ports.seed.bId, view, () => { pointerDown = true }, true, assertHeldPreview)
    const deniedSamples: AuthoringView[] = []
    for (let step = 1; step <= 3; step += 1) {
      sendNativeInput(contents, ports, { type: 'mouseMove', x: Math.round(overlap.start.x + (overlap.end.x - overlap.start.x) * step / 3), y: Math.round(overlap.start.y + (overlap.end.y - overlap.start.y) * step / 3), button: 'left', modifiers: ['leftbuttondown'] })
      view = await paint(contents, ports, true)
      assert.deepEqual(view.editor.session, beforeSession); assert.equal(ports.applies().length, offset + 2); assert.ok(ports.held())
      assert.deepEqual(view.canvas!.camera, selectedPending.canvas!.camera)
      stableTransform(model(view, ports.seed.bId).transform, model(selectedPending, ports.seed.bId).transform)
      stableTransform(model(view, cId).transform, model(selectedPending, cId).transform)
      deniedSamples.push(view)
    }
    up(contents, ports, overlap); pointerDown = false
    view = await paint(contents, ports, true)
    assert.ok(view.alerts.includes('Wait for the current transform to finish.'), 'Overlap did not exercise the real admission denial')
    assert.deepEqual(view.editor.session, beforeSession); assert.equal(ports.applies().length, offset + 2)
    await ports.checkpoint('07-overlap-denied-no-preview-leak', view, contents)
    ports.record('denied-overlap-samples', deniedSamples)
    await ports.pass('pending-selection-and-overlap-denial')

    ports.stage('captured-target-commit')
    ports.record('preview-request-binding-before-release', { at: new Date().toISOString(), entityId: cId, axis: handle.axis, absoluteTolerance: CAPTURED_TRANSFORM_TOLERANCE, finalPreview, requestTransform: assertHeldPreview() })
    ports.release()
    view = await waitFor(contents, ports, (value) => value.editor.lifecycle === 'ready' && snapshot(value).project.revision === before.project.revision + 1 && !value.statuses.includes('Saving transform…'), 'captured-C-commit', 12000, true)
    appliesCompleted(ports, offset + 2, 'ui')
    const committed = snapshot(view), cCommitted = structuredClone(entity(committed, cId).transform)
    unchangedExceptTransform(before, committed, cId)
    assertCapturedTranslation(cBefore, finalPreview, cCommitted, handle.axis, 'Committed C snapshot')
    ports.record('preview-committed-binding', { at: new Date().toISOString(), entityId: cId, revision: committed.project.revision, axis: handle.axis, absoluteTolerance: CAPTURED_TRANSFORM_TOLERANCE, finalPreview, committedTransform: cCommitted })
    assert.equal(view.selection.active, ports.seed.bId); assert.deepEqual(view.selection.ids, [ports.seed.bId])
    assert.equal(view.editor.session!.undoStack.length, initialHistory + 2); assert.equal(view.editor.session!.redoStack.length, 0)
    assert.equal(view.editor.session!.receipts.length, beforeSession!.receipts.length + 1)
    view = await paint(contents, ports, true)
    stableTransform(model(view, cId).transform, cCommitted)
    stableTransform(model(view, ports.seed.bId).transform, entity(before, ports.seed.bId).transform)
    assertInspector(view, entity(before, ports.seed.bId).transform, false)
    const committedShot = await ports.checkpoint('08-c-committed-b-still-selected', view, contents)
    assertPaint(committedShot, view, cId, red, model(view, ports.seed.aId).bounds!)
    assertPaint(committedShot, view, ports.seed.bId, blue)
    await ports.pass('captured-target-commit')

    ports.stage('native-undo')
    await click(contents, ports, 'button', 'Undo')
    view = await waitFor(contents, ports, (value) => value.editor.lifecycle === 'ready' && snapshot(value).project.revision === committed.project.revision + 1, 'native-undo', 12000, true)
    appliesCompleted(ports, offset + 3, 'undo')
    unchangedExceptTransform(committed, snapshot(view), cId); assert.deepEqual(entity(snapshot(view), cId).transform, cBefore)
    assert.equal(view.editor.session!.undoStack.length, initialHistory + 1); assert.equal(view.editor.session!.redoStack.length, 1); assert.equal(view.selection.active, ports.seed.bId)
    view = await paint(contents, ports)
    stableTransform(model(view, cId).transform, cBefore)
    const undoShot = await ports.checkpoint('09-native-undo', view, contents)
    assert.ok(pixelChanges(committedShot, undoShot, cPreview.bounds!) > 25, 'Undo did not repaint the displaced C area')
    await ports.pass('native-undo')

    ports.stage('native-redo')
    const undoSnapshot = snapshot(view)
    await click(contents, ports, 'button', 'Redo')
    view = await waitFor(contents, ports, (value) => value.editor.lifecycle === 'ready' && snapshot(value).project.revision === undoSnapshot.project.revision + 1, 'native-redo', 12000)
    appliesCompleted(ports, offset + 4, 'redo')
    unchangedExceptTransform(undoSnapshot, snapshot(view), cId); assert.deepEqual(entity(snapshot(view), cId).transform, cCommitted)
    assert.equal(view.editor.session!.undoStack.length, initialHistory + 2); assert.equal(view.editor.session!.redoStack.length, 0); assert.equal(view.selection.active, ports.seed.bId)
    view = await paint(contents, ports)
    stableTransform(model(view, cId).transform, cCommitted)
    const redoShot = await ports.checkpoint('10-native-redo', view, contents)
    assertPaint(redoShot, view, cId, red, model(view, ports.seed.aId).bounds!)
    assert.ok(pixelChanges(undoShot, redoShot, cPreview.bounds!) > 25, 'Redo did not repaint C')
    const durable = snapshot(view), previousBoot = view.bootId
    await ports.pass('native-redo')

    ports.stage('fresh-repository-and-renderer-reopen')
    contents = await ports.reopen()
    view = await waitFor(contents, ports, (value) => value.bootId !== previousBoot && value.editor.lifecycle === 'ready' && value.canvasCount === 1 && !!value.canvas && !value.canvas.contextLost && value.canvas.frame > 1 && value.canvas.models.length === 3 && value.canvas.models.every((item) => item.meshes > 0), 'reopen-positive-canvas', 8000)
    assert.deepEqual(snapshot(view), durable); assert.equal(ports.applies().length, offset + 4)
    view = await paint(contents, ports)
    for (const id of [ports.seed.aId, ports.seed.bId, cId]) stableTransform(model(view, id).transform, entity(durable, id).transform)
    const reopenShot = await ports.checkpoint('11-fresh-renderer-and-repository', view, contents)
    assertPaint(reopenShot, view, cId, red, model(view, ports.seed.aId).bounds!); assertPaint(reopenShot, view, ports.seed.bId, blue)
    ports.record('reopen-scope', { durableSnapshotMatched: true, volatileHistoryPersistenceRequired: false, previousBoot, reopenedBoot: view.bootId })
    await ports.pass('fresh-repository-and-renderer-reopen')
    if (authored) {
      ports.stage('native-both-scenes-reopen')
      const reopenedBoot = view.bootId
      // Opening the already-active project is disabled. Create a real empty auxiliary project, then use the actual picker/Open controls.
      await click(contents, ports, 'button', 'New World project')
      await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready' && current.editor.projectKey !== projectKey && current.editor.projects.length === 2, 'native-auxiliary-project')
      await selectValue(contents, ports, 'World project', projectKey)
      await click(contents, ports, 'button', 'Open selected World project')
      view = await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready' && current.editor.projectKey === projectKey && current.editor.activeSceneId === sceneId && current.canvas?.models.length === 3 && current.canvas.models.every((item) => item.meshes > 0), 'native-explicit-project-reopen', 8000)
      assertBothScenesReopened(durable, snapshot(view), authored.sceneIds, previousBoot, reopenedBoot)
      await ports.checkpoint('ui-03-explicit-first-scene-reopen', await paint(contents, ports), contents)
      await selectValue(contents, ports, 'Active scene', authored.sceneIds[1])
      view = await waitFor(contents, ports, (current) => current.editor.lifecycle === 'ready' && current.editor.activeSceneId === authored.sceneIds[1] && current.canvas?.models.length === 2 && current.canvas.models.every((item) => item.meshes > 0), 'native-reopened-second-scene', 8000)
      assertBothScenesReopened(durable, snapshot(view), authored.sceneIds, previousBoot, view.bootId)
      assert.equal(ports.applies().length, offset + 4)
      view = await paint(contents, ports)
      const secondShot = await ports.checkpoint('ui-04-explicit-second-scene-reopen', view, contents)
      for (const item of durable.scenes.find((item) => item.sceneId === authored.sceneIds[1])!.entities.filter((item) => item.components.some((component) => component.type === 'renderable'))) {
        stableTransform(model(view, item.id).transform, item.transform); assertReopenedAuthoringVisual(secondShot, view, item.id)
      }
      await ports.pass('native-both-scenes-reopen')
    }
  } finally {
    // Abort unforwarded IPC instead of accidentally saving after a failed assertion.
    ports.abort()
    if (pointerDown && lastHandle && !contents.isDestroyed()) up(contents, ports, lastHandle)
  }
}
