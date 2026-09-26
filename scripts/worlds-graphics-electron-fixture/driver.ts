import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import type { WorldEditorSession } from '../../src/areas/worlds/core/worldSessions.ts'
import type { WorldViewportFailure } from '../../src/areas/worlds/components/WorldViewportBoundary.tsx'
import type { FixtureEnvironment } from '../worlds-character-electron-fixture/shared.ts'

export const CHECK_NAMES = ['sandbox-and-original-document', 'unsupported-webgl-contained', 'shell-and-explicit-retry', 'repeated-failure-contained', 'independent-repository-unchanged'] as const
export const SUPPORTED_CHECK_NAMES = ['sandbox-and-original-document', 'supported-native-play', 'hardware-webgl2', 'posed-scene-pixels', 'pause-resume-stop-restores', 'independent-repository-unchanged'] as const
export interface GraphicsCheck { name: typeof CHECK_NAMES[number] | typeof SUPPORTED_CHECK_NAMES[number]; status: 'PASS' | 'FAIL' | 'UNREACHED'; reason?: string; evidence?: unknown }
interface WorkerSample { generationId: number; sequence: number; entityIds: string[]; transforms: number[]; at: number }
interface GraphicsView {
  environment: FixtureEnvironment
  requireType: string
  processType: string
  editorSession: WorldEditorSession | null
  editorError: string | null
  lifecycle: string
  generationId: number
  bodyPoses: Array<{ entityId: string; position: number[]; rotation: number[] }>
  runtimeSnapshotPresent: boolean
  graphics: { attempt: number; failure: WorldViewportFailure | null }
  evidence: { stopCalls: number; physicsCreated: number; physicsDisposed: number; audioStopRequested: number; audioClosed: number; advanceCalls: number; failures: string[]; error: string | null; workerSamples: WorkerSample[]; nativeKeys: string[]; inputSequence: number }
  trustedClicks: string[]
  shellInteractions: number
}
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 25))
export function readGraphicsView(contents: WebContents): Promise<GraphicsView | null> {
  return contents.executeJavaScript("(() => { const text = document.getElementById('graphics-recovery-state')?.textContent; return text ? JSON.parse(text) : null; })()")
}
async function waitFor(contents: WebContents, description: string, predicate: (view: GraphicsView) => boolean): Promise<GraphicsView> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const view = await readGraphicsView(contents)
    if (view?.editorError || view?.evidence.error) throw new Error(view.editorError ?? view.evidence.error!)
    if (view?.graphics.failure && view.trustedClicks.includes('Start positive Play')) throw new Error(`CONTEXT_UNSUPPORTED: ${view.graphics.failure.message}`)
    if (view && predicate(view)) return view
    await delay()
  }
  throw new Error(`Timed out: ${description}. This lane requires an actual unsupported-WebGL startup; a working viewport is not a recovery PASS.`)
}
async function click(contents: WebContents, label: string): Promise<void> {
  const previous = (await readGraphicsView(contents))?.trustedClicks.length ?? 0
  const target = await contents.executeJavaScript(`(() => {
    const matches = [...document.querySelectorAll('button[aria-label]')].filter((element) => element.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (matches.length !== 1) throw new Error('Native target is ambiguous or missing');
    const element = matches[0]; element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rectangle = element.getBoundingClientRect(); const x = Math.round(rectangle.left + rectangle.width / 2); const y = Math.round(rectangle.top + rectangle.height / 2);
    return { x, y, available: rectangle.width > 0 && rectangle.height > 0 && !element.disabled && element.contains(document.elementFromPoint(x, y)) };
  })()`)
  assert.equal(target.available, true, `Native target unavailable: ${label}`)
  contents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y })
  contents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await waitFor(contents, `trusted click ${label}`, (view) => view.trustedClicks.length > previous && view.trustedClicks.at(-1) === label)
}

export async function runGraphicsInteractions(contents: WebContents, persist: (check: GraphicsCheck) => Promise<void>, verifyRepository: (session: WorldEditorSession) => Promise<void>): Promise<GraphicsView> {
  let original: WorldEditorSession
  let view: GraphicsView
  const check = async (name: GraphicsCheck['name'], operation: () => Promise<void>) => {
    try { await operation(); await persist({ name, status: 'PASS', evidence: view }) }
    catch (error) { await persist({ name, status: 'FAIL', reason: String(error) }); throw error }
  }
  await check('sandbox-and-original-document', async () => {
    view = await waitFor(contents, 'authored project', (value) => !!value.editorSession)
    assert.deepEqual(view.environment, { sandboxed: true, contextIsolated: true })
    assert.equal(view.requireType, 'undefined'); assert.equal(view.processType, 'undefined')
    original = structuredClone(view.editorSession!)
  })
  const assertContained = async (count: number) => {
    view = await waitFor(contents, 'contained real WebGL startup failure', (value) => !!value.graphics.failure && value.lifecycle === 'edit' && value.evidence.stopCalls === count)
    assert.equal(view.graphics.failure?.kind, 'render-error')
    assert.match(view.graphics.failure?.message ?? '', /WebGL context/i)
    assert.equal(view.runtimeSnapshotPresent, false)
    assert.equal(view.evidence.physicsCreated, count)
    assert.equal(view.evidence.physicsDisposed, count)
    assert.equal(view.evidence.audioStopRequested, count)
    assert.equal(view.evidence.advanceCalls, 0, 'Unsupported Canvas must not drive runtime frames')
    assert.deepEqual(view.editorSession, original, 'Recovery must retain the entire session, including history and receipts')
    assert.equal(await contents.executeJavaScript('document.querySelectorAll("canvas").length'), 0)
    assert.equal(await contents.executeJavaScript('document.querySelectorAll("[role=alert]").length'), 1)
  }
  await check('unsupported-webgl-contained', async () => { await click(contents, 'Start recovery probe'); await assertContained(1) })
  await check('shell-and-explicit-retry', async () => {
    await click(contents, 'Editor shell control')
    await click(contents, 'Retry viewport')
    view = await waitFor(contents, 'explicit viewport retry without auto-Play', (value) => value.graphics.attempt === 1 && !value.graphics.failure)
    assert.equal(view.lifecycle, 'edit'); assert.equal(view.evidence.stopCalls, 1); assert.equal(view.evidence.physicsCreated, 1)
    assert.equal(view.shellInteractions, 1)
    assert.deepEqual(view.editorSession, original)
  })
  await check('repeated-failure-contained', async () => {
    await click(contents, 'Start recovery probe'); await assertContained(2)
    await click(contents, 'Editor shell control')
    view = await waitFor(contents, 'editor shell after repeated failure', (value) => value.shellInteractions === 2)
    assert.deepEqual(view.editorSession, original)
  })
  await check('independent-repository-unchanged', async () => { await verifyRepository(original); view = (await readGraphicsView(contents))! })
  return view!
}

interface HardwareContext { version: string; renderer: string; vendor: string; debugRenderer: string | null; lost: boolean; width: number; height: number }
interface HardwareGpu { features: { webgl?: string }; devices: unknown }
export function assertHardwareAdmission(context: HardwareContext, gpu: HardwareGpu): void {
  const reason = 'CONTEXT_UNSUPPORTED: hardware WebGL2 attribution is required; no fallback.'
  assert.ok(context.version.startsWith('WebGL 2.0') && !context.lost && context.width > 0 && context.height > 0, reason)
  assert.ok(context.vendor && context.renderer && context.debugRenderer && !/swiftshader|llvmpipe|softpipe|software|lavapipe/i.test(`${context.renderer} ${context.debugRenderer}`), reason)
  assert.equal(gpu.features.webgl, 'enabled', reason)
  const info = gpu.devices
  assert.ok(info !== null && typeof info === 'object' && !Array.isArray(info), reason)
  const devices: unknown = Reflect.get(info, 'gpuDevice')
  assert.ok(Array.isArray(devices), reason)
  assert.ok(devices.some((device: unknown) => {
    if (device === null || typeof device !== 'object' || Array.isArray(device)) return false
    const active: unknown = Reflect.get(device, 'active'), vendorId: unknown = Reflect.get(device, 'vendorId'), deviceId: unknown = Reflect.get(device, 'deviceId')
    return active === true && typeof vendorId === 'number' && Number.isInteger(vendorId) && vendorId > 0 && typeof deviceId === 'number' && Number.isInteger(deviceId) && deviceId > 0
  }), reason)
}
/** Electron NativeImage bitmap is BGRA; require the authored red marker in both scene crops. */
export function compareSceneBitmaps(before: Uint8Array, after: Uint8Array, width = before.length / 4): { changedPixels: number; markerPixelsBefore: number; markerPixelsAfter: number } {
  assert.ok(before.length > 0 && before.length === after.length && before.length % 4 === 0, 'Scene capture dimensions differ.')
  assert.ok(Number.isSafeInteger(width) && width > 0 && before.length / 4 % width === 0, 'Invalid scene bitmap width')
  let changedPixels = 0, markerPixelsBefore = 0, markerPixelsAfter = 0, beforeX = 0, afterX = 0, removed = 0, added = 0
  const marker = (bytes: Uint8Array, offset: number) => bytes[offset+2]! > 100 && bytes[offset+2]! > bytes[offset+1]! * 1.5 && bytes[offset+2]! > bytes[offset]! * 1.5
  for (let offset = 0; offset < before.length; offset += 4) {
    const wasMarker = marker(before, offset), isMarker = marker(after, offset), x = offset / 4 % width
    if (wasMarker) { markerPixelsBefore += 1; beforeX += x }
    if (isMarker) { markerPixelsAfter += 1; afterX += x }
    if (wasMarker && !isMarker) removed += 1
    if (isMarker && !wasMarker) added += 1
    if (wasMarker !== isMarker) changedPixels += 1
  }
  assert.ok(markerPixelsBefore > 0 && markerPixelsAfter > 0 && changedPixels > 0, 'Both actual scene crops must contain the authored marker and changed scene pixels.')
  assert.ok(removed > 0 && added > 0 && afterX / markerPixelsAfter - beforeX / markerPixelsBefore > 0.5, 'Marker occupancy must move right with the sampled native D pose, not unrelated background pixels')
  return { changedPixels, markerPixelsBefore, markerPixelsAfter }
}

async function completedExistingCanvas(contents: WebContents) {
  return contents.executeJavaScript(`(async () => {
    const canvases = document.querySelectorAll('.world-runtime-viewport canvas');
    if (canvases.length !== 1 || document.querySelectorAll('canvas').length !== 1 || document.querySelector('[role=alert]')) throw new Error('CONTEXT_UNSUPPORTED: actual production Canvas missing or ambiguous');
    const canvas = canvases[0], gl = canvas.getContext('webgl2');
    if (!gl || gl.isContextLost()) throw new Error('CONTEXT_UNSUPPORTED: existing Canvas is not WebGL2');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), deadline = performance.now() + 2000;
    if (!fence) throw new Error('CONTEXT_UNSUPPORTED: existing-context completion fence unavailable');
    gl.flush();
    try { await new Promise((resolve, reject) => {
      const poll = () => { const status = gl.clientWaitSync(fence, 0, 0);
        if (gl.isContextLost() || status === gl.WAIT_FAILED || performance.now() >= deadline) reject(new Error('CONTEXT_UNSUPPORTED: completion fence failed'));
        else if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) resolve(); else setTimeout(poll, 10);
      }; poll();
    }); } finally { gl.deleteSync(fence); }
    if (!canvas.isConnected || canvas !== document.querySelector('.world-runtime-viewport canvas')) throw new Error('Canvas changed during completion observation');
    const rectangle = canvas.getBoundingClientRect(), extension = gl.getExtension('WEBGL_debug_renderer_info');
    return { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR), debugRenderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
      lost: gl.isContextLost(), width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, attributes: gl.getContextAttributes(), dpr: devicePixelRatio, css: { width: rectangle.width, height: rectangle.height }, fenceCompletedAt: performance.now(),
      bounds: { x: Math.ceil(rectangle.x)+8, y: Math.ceil(rectangle.y)+60, width: Math.floor(rectangle.width)-16, height: Math.floor(rectangle.height)-68 } };
  })()`)
}

export async function runSupportedGraphicsInteractions(contents: WebContents, persist: (check: GraphicsCheck) => Promise<void>, verifyRepository: (session: WorldEditorSession) => Promise<void>, gpu: HardwareGpu, capture: (name: string, bounds: Electron.Rectangle) => Promise<Uint8Array>): Promise<GraphicsView> {
  let view = await waitFor(contents, 'positive authored project', (value) => !!value.editorSession)
  const original = structuredClone(view.editorSession!)
  const entity = original.snapshot.scenes.flatMap((scene) => scene.entities).find((candidate) => candidate.tags.includes('physics-character'))
  assert.ok(entity, 'Positive fixture Character entity is missing.')
  assert.ok(entity?.components.some((component) => component.type === 'renderable' && component.resourceId === 'resource:positive-marker'))
  const check = async (name: GraphicsCheck['name'], operation: () => Promise<unknown>) => {
    try { const detail = await operation(); await persist({ name, status: 'PASS', evidence: { view, detail } }) }
    catch (error) { await persist({ name, status: 'FAIL', reason: String(error), evidence: view }); throw error }
  }
  const healthy = () => { assert.equal(view.graphics.failure, null, 'CONTEXT_UNSUPPORTED: production graphics failed'); assert.equal(view.evidence.failures.length, 0); assert.deepEqual(view.editorSession, original) }
  const pose = () => {
    const sample = view.evidence.workerSamples.at(-1)!; assert.ok(sample && sample.generationId === view.generationId)
    const offset = sample.entityIds.indexOf(entity.id) * 7; assert.ok(offset >= 0)
    const position = sample.transforms.slice(offset, offset+3); assert.deepEqual(view.bodyPoses.find((candidate) => candidate.entityId === entity.id)?.position, position)
    return { sample, position }
  }
  await check('sandbox-and-original-document', async () => { assert.deepEqual(view.environment, { sandboxed: true, contextIsolated: true }); assert.equal(view.requireType, 'undefined'); assert.equal(view.processType, 'undefined') })
  await check('supported-native-play', async () => {
    await click(contents, 'Start positive Play')
    view = await waitFor(contents, 'real viewport-driven Worker publications', (value) => value.lifecycle === 'playing' && value.evidence.advanceCalls > 0 && value.evidence.workerSamples.length >= 2)
    healthy(); assert.ok(view.evidence.inputSequence > 0); pose()
  })
  await check('hardware-webgl2', async () => { const context = await completedExistingCanvas(contents); assertHardwareAdmission(context, gpu); return { context, gpu, activeGraphicsProfileId: original.snapshot.project.activeGraphicsProfileId, profiles: original.snapshot.project.graphicsProfiles } })
  await check('posed-scene-pixels', async () => {
    await click(contents, 'Pause positive Play'); view = await waitFor(contents, 'first native Pause', (value) => value.lifecycle === 'paused')
    await delay(); const firstContext = await completedExistingCanvas(contents); view = (await readGraphicsView(contents))!; healthy(); const first = pose()
    assertHardwareAdmission(firstContext, gpu); const before = await capture('scene-before', firstContext.bounds)
    assert.equal((await readGraphicsView(contents))!.evidence.workerSamples.at(-1)!.sequence, first.sample.sequence, 'Pose changed during paused capture')
    await click(contents, 'Resume positive Play'); view = await waitFor(contents, 'native Resume', (value) => value.lifecycle === 'playing')
    const target = await contents.executeJavaScript(`(() => { const element = document.querySelector('[aria-label="Play viewport"]'); const r = element.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...target, button: 'left', clickCount: 1 }); contents.sendInputEvent({ type: 'mouseUp', ...target, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'D' })
    try { view = await waitFor(contents, 'real native D Worker pose delta', (value) => value.bodyPoses.some((candidate) => candidate.entityId === entity.id && candidate.position[0]! > first.position[0]! + 0.6)) }
    finally { contents.sendInputEvent({ type: 'keyUp', keyCode: 'D' }) }
    await click(contents, 'Pause positive Play'); view = await waitFor(contents, 'second native Pause', (value) => value.lifecycle === 'paused')
    const secondContext = await completedExistingCanvas(contents); view = (await readGraphicsView(contents))!; healthy(); const second = pose()
    assertHardwareAdmission(secondContext, gpu); assert.deepEqual(secondContext.bounds, firstContext.bounds)
    assert.ok(second.sample.sequence > first.sample.sequence && second.position[0]! > first.position[0]! + 0.6)
    assert.ok(view.evidence.nativeKeys.includes('keydown:KeyD') && view.evidence.nativeKeys.includes('keyup:KeyD'))
    const after = await capture('scene-after', secondContext.bounds)
    assert.equal((await readGraphicsView(contents))!.evidence.workerSamples.at(-1)!.sequence, second.sample.sequence)
    const pixels = compareSceneBitmaps(before, after, firstContext.bounds.width); assert.ok(pixels.changedPixels >= 100 && pixels.markerPixelsBefore >= 100 && pixels.markerPixelsAfter >= 100)
    return { first, second, firstContext, secondContext, pixels, completionClaim: 'Submitted existing-context work completed; NOT GPU timing or physical scanout.' }
  })
  await check('pause-resume-stop-restores', async () => {
    await click(contents, 'Stop positive Play'); view = await waitFor(contents, 'awaited Stop with real disposal', (value) => value.lifecycle === 'edit' && value.evidence.physicsDisposed === 1 && value.evidence.audioClosed === 1)
    healthy(); assert.equal(view.runtimeSnapshotPresent, false); assert.equal(view.evidence.physicsCreated, 1); assert.equal(view.evidence.audioStopRequested, 1)
    assert.deepEqual(view.editorSession, original, 'Stop must restore entire snapshot/history/receipts')
    assert.equal(await contents.executeJavaScript('document.querySelectorAll("canvas").length'), 0)
  })
  await check('independent-repository-unchanged', async () => { await verifyRepository(original) })
  return view
}
