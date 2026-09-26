import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import { canonicalWorldCommandBatchPayload } from '../../src/areas/worlds/core/worldCommands.ts'
import { sameWorldAiContext, worldAiCameraComponent, type WorldAiContext, type WorldAiQueryRequest, type WorldAiQueryPage, type WorldAiResourceRow } from '../../src/areas/worlds/core/worldAiContract.ts'
import type { WorldEntity, WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import type { WorldProjectAiPreviewRequest, WorldProjectAiPreviewResult, WorldProjectAiDiscardRequest, WorldProjectResult } from '../../src/shared/types/worldProjects.ts'
import { parseWorldAiChatResponse } from '../../src/areas/worlds/editor/worldAiChatAdapter.ts'
import type { AuthoringView, LocalAiConfig, ReviewedAiModel } from './shared.ts'
import { click, key, paint, readView, selectValue, sendNativeInput, waitFor, type CommonDriverPorts, type Invocation, type Shot } from './driver.ts'
import { observeNativeClickPoint, assertNativeClickPointStable } from './driver.ts'

export interface AiHttpReceipt {
  at: string; status: number; responseBytes: number; responseSha256: string; rawResponseBase64: string
  validation: 'pending' | 'accepted' | 'rejected'; response?: unknown
  request?: { worldContext: WorldAiContext; model: string; [key: string]: unknown }
  admittedSelection?: { name: string; digest: string }
}
export interface AiQueryCapture { at: string; request: WorldAiQueryRequest; result: WorldProjectResult<WorldAiQueryPage>; bytes: number }
export interface AiPreviewCapture { at: string; request: WorldProjectAiPreviewRequest; result: WorldProjectAiPreviewResult }
export interface AiDiscardCapture { at: string; request: WorldProjectAiDiscardRequest; result: WorldProjectResult<{ discarded: true }> }
export interface AiDocumentState { snapshot: WorldProjectSnapshotV1; history: { undo: number; redo: number }; documents: Array<{ path: string; bytes: number; sha256: string }> }
export interface AiSourceWitness { handle: string; resourceId: string; fingerprint: string; input: { bytes: number; sha256: string; rawBase64: string }; [key: string]: unknown }
export interface AiStoredWitness { verified: true; transactionId: string; snapshot: WorldProjectSnapshotV1; inverse: unknown; [key: string]: unknown }
export interface AiDriverPorts extends CommonDriverPorts {
  config: LocalAiConfig; reviewedModel: Readonly<ReviewedAiModel>; deadline: number
  currentContents(): WebContents
  admitNativeFocus(contents: WebContents): Promise<void>
  nativeClickWitness(label: string): unknown
  admitReopened(view: AuthoringView): void
  receipts(): { discoveries: readonly AiHttpReceipt[]; chats: readonly AiHttpReceipt[]; queries: readonly AiQueryCapture[]; previews: readonly AiPreviewCapture[]; discards: readonly AiDiscardCapture[]; discoveryRequests: number; chatRequests: number }
  documentState(view: AuthoringView): Promise<AiDocumentState>
  sourceWitnesses(preview: AiPreviewCapture, rows: WorldAiResourceRow[]): Promise<AiSourceWitness[]>
  stored(entry: Invocation): Promise<AiStoredWitness>
  capture(stage: string, view: AuthoringView, contents: WebContents): Promise<{ shot: Shot; screenshot: { filename: string; bytes: number; sha256: string } }>
}
const snapshot = (view: AuthoringView) => { assert.ok(view.editor.session); return view.editor.session.snapshot }
export const AI_CAMERA_PROMPT = 'Add one perspective camera named AI Probe Camera to the current scene at position [0, 2, 5], with field of view 60, no rotation and scale [1, 1, 1]. Put it at the scene root and change nothing else.'
function budget(ports: AiDriverPorts, seconds: number, stage: string): void {
  ports.guard(); assert.ok(Date.now() + seconds * 1000 < ports.deadline - ports.config.cleanupSeconds * 1000, `Insufficient remaining fixed budget for ${stage}`)
}
function owner(ports: AiDriverPorts, contents: WebContents): void {
  ports.guard(contents); assert.equal(contents.isDestroyed(), false); assert.equal(contents, ports.currentContents(), 'Native AI cannot use a stale renderer generation')
}
function assertCameraRecipe(preview: AiPreviewCapture): void {
  const commands = preview.request.proposal.commands
  assert.equal(commands.length, 1, 'Actual model must return exactly one recipe')
  const recipe = commands[0]
  assert.equal(recipe.type, 'create-entity')
  if (recipe.type !== 'create-entity') throw new Error('Actual proposal is not a create-entity recipe')
  assert.equal(recipe.kind, 'camera')
  if (recipe.kind !== 'camera') throw new Error('Actual proposal is not a camera recipe')
  assert.deepEqual(recipe.sceneRef, { kind: 'existing', id: preview.request.proposal.context.activeSceneId })
  assert.ok(recipe.parentRef === undefined || recipe.parentRef === null, 'Requested camera must compile at the scene root')
  assert.equal(recipe.name, 'AI Probe Camera')
  assert.deepEqual(recipe.transform, { position: [0, 2, 5], rotation: [0, 0, 0], scale: [1, 1, 1] })
  assert.deepEqual(worldAiCameraComponent('component:acceptance', recipe.camera ?? {}), {
    id: 'component:acceptance', type: 'camera', enabled: true, primary: false,
    projection: 'perspective', near: 0.1, far: 1000, fieldOfView: 60,
  })
}
function assertCameraCreation(before: WorldProjectSnapshotV1, preview: AiPreviewCapture): { candidate: WorldProjectSnapshotV1; camera: WorldEntity } {
  assert.ok(preview.result.ok); assertCameraRecipe(preview)
  const value = preview.result.value, candidate = value.result.snapshot, activeSceneId = preview.request.proposal.context.activeSceneId
  const beforeIds = new Set(before.scenes.flatMap((scene) => scene.entities.map((entity) => entity.id)))
  const added = candidate.scenes.flatMap((scene) => scene.entities.filter((entity) => !beforeIds.has(entity.id)).map((entity) => ({ sceneId: scene.sceneId, entity })))
  assert.equal(added.length, 1, 'Auto-apply candidate must add exactly one entity')
  const camera = added[0].entity
  assert.equal(added[0].sceneId, activeSceneId); assert.equal(camera.name, 'AI Probe Camera'); assert.equal(camera.parentId, null)
  assert.equal(camera.enabled, true); assert.equal(camera.locked, false); assert.deepEqual(camera.tags, [])
  assert.deepEqual(camera.transform, { position: [0, 2, 5], rotation: [0, 0, 0], scale: [1, 1, 1] })
  assert.equal(camera.components.length, 1, 'AI camera entity must contain only its Camera component')
  const component = camera.components[0]
  assert.equal(component.type, 'camera')
  if (component.type !== 'camera') throw new Error('AI camera component missing')
  const activeBefore = before.scenes.find((scene) => scene.sceneId === activeSceneId)!
  const expectedPrimary = !activeBefore.entities.some((entity) => entity.components.some((candidate) => candidate.type === 'camera' && candidate.primary))
  assert.deepEqual(component, { id: component.id, type: 'camera', enabled: true, projection: 'perspective', primary: expectedPrimary, near: 0.1, far: 1000, fieldOfView: 60 })
  const allIds = before.scenes.flatMap((scene) => scene.entities.flatMap((entity) => [entity.id, ...entity.components.map((item) => item.id)]))
  assert.ok(typeof camera.id === 'string' && camera.id.length > 0 && !allIds.includes(camera.id)); assert.ok(typeof component.id === 'string' && component.id.length > 0 && !allIds.includes(component.id) && component.id !== camera.id)
  const expected = structuredClone(before); expected.project.revision++
  expected.scenes.find((scene) => scene.sceneId === activeSceneId)!.entities.push(structuredClone(camera))
  assert.deepEqual(candidate, expected, 'Camera proposal changed unrelated canonical owners')
  assert.deepEqual(value.result.inverse, { kind: 'world-snapshot', snapshot: before })
  assert.equal(value.batch.commands.length, 1); const command = value.batch.commands[0]
  assert.equal(command.type, 'add-entity')
  if (command.type !== 'add-entity') throw new Error('Camera preview did not compile to add-entity')
  assert.equal(command.sceneId, activeSceneId); assert.deepEqual(command.entity, camera)
  return { candidate, camera }
}
interface ThinkingRequestWitness {
  title: 'Thinking: off'; steps: Array<{ title: string; hover: unknown }>
  bootId: string; projectKey: string; projectId: string; activeSceneId: string; baseRevision: number; model: string
}
async function typePrompt(contents: WebContents, ports: AiDriverPorts, prompt: string): Promise<ThinkingRequestWitness> {
  owner(ports, contents); assert.ok(prompt.length <= 1100)
  await click(contents, ports, 'ai-prompt', 'Ask Worlds AI')
  assert.equal(await contents.executeJavaScript('document.activeElement?.getAttribute("aria-label")', false), 'Ask Worlds AI')
  key(contents, ports, 'A', ['control'])
  for (const char of prompt) { owner(ports, contents); sendNativeInput(contents, ports, { type: 'char', keyCode: char }) }
  const ready = await waitFor(contents, ports, (v) => v.aiReview.prompt === prompt && v.aiReview.sendEnabled && !v.aiReview.busy, 'actual-prompt-hydrated-readiness', 5000)
  assert.equal(ready.aiReview.selectedModel, ports.reviewedModel.name)
  const steps = await selectThinkingOff(contents, ports)
  // The genuine Thinking button takes focus; reacquire the actual prompt without changing its value.
  await click(contents, ports, 'ai-prompt', 'Ask Worlds AI')
  assert.equal(await contents.executeJavaScript('document.activeElement?.getAttribute("aria-label")', false), 'Ask Worlds AI')
  owner(ports, contents)
  const bound = await readView(contents)
  assert.ok(bound.editor.projectKey && bound.editor.activeSceneId)
  assert.ok(bound.aiReview.sendEnabled && !bound.aiReview.busy)
  assert.equal(bound.aiReview.prompt, prompt); assert.equal(bound.aiReview.selectedModel, ports.reviewedModel.name)
  assert.equal(await observeThinkingTitle(contents, ports), 'Thinking: off', 'Thinking title changed before the actual request')
  const witness: ThinkingRequestWitness = { title: 'Thinking: off', steps, bootId: bound.bootId, projectKey: bound.editor.projectKey,
    projectId: snapshot(bound).project.projectId, activeSceneId: bound.editor.activeSceneId, baseRevision: snapshot(bound).project.revision, model: ports.reviewedModel.name }
  ports.record('actual-native-thinking-off-before-send', witness)
  key(contents, ports, 'Return')
  return witness
}
async function observeThinkingTitle(contents: WebContents, ports: AiDriverPorts): Promise<string> {
  owner(ports, contents)
  const titles: unknown = await contents.executeJavaScript(`(() => {
    const prompt = document.querySelectorAll('[aria-label="Worlds AI"] textarea[aria-label="Ask Worlds AI"]');
    return prompt.length === 1 ? [...prompt[0].parentElement.querySelectorAll('button[title]')]
      .map(e => e.getAttribute('title')).filter(title => ['Thinking: auto', 'Thinking: on', 'Thinking: off'].includes(title)) : [];
  })()`, false)
  assert.ok(Array.isArray(titles) && titles.length === 1 && typeof titles[0] === 'string', 'Missing or ambiguous genuine Thinking title')
  const title = titles[0]
  const observed = await observeNativeClickPoint(contents, 'ai-thinking', title)
  owner(ports, contents); assertNativeClickPointStable(observed.point, observed, title)
  return title
}
async function selectThinkingOff(contents: WebContents, ports: AiDriverPorts): Promise<ThinkingRequestWitness['steps']> {
  const steps: ThinkingRequestWitness['steps'] = []
  let title = await observeThinkingTitle(contents, ports)
  for (let index = 0; title !== 'Thinking: off' && index < 2; index++) {
    const next = title === 'Thinking: auto' ? 'Thinking: on' : 'Thinking: off'
    await click(contents, ports, 'ai-thinking', title)
    const hover = ports.nativeClickWitness(title) as { point: { x: number; y: number }; matchCount: number; enabled: boolean; visible: boolean; hitMatches: boolean }
    assert.ok(hover && hover.matchCount === 1 && hover.enabled && hover.visible && hover.hitMatches, 'Missing genuine Thinking native hover witness')
    steps.push({ title, hover: structuredClone(hover) })
    await paint(contents, ports)
    title = await observeThinkingTitle(contents, ports)
    assert.equal(title, next, 'Thinking title drifted instead of the genuine local cycle')
  }
  assert.equal(title, 'Thinking: off', 'Thinking off requires at most two genuine native clicks')
  return steps
}
async function autoApplyCameraTurn(contents: WebContents, ports: AiDriverPorts, before: AiDocumentState) {
  budget(ports, ports.config.turnSeconds + 40, 'camera-chat')
  const counts = { applies: ports.applies().length, chats: ports.receipts().chats.length, previews: ports.receipts().previews.length, queries: ports.receipts().queries.length }
  assert.equal(counts.chats, 0); assert.equal(counts.previews, 0); assert.equal(ports.receipts().discards.length, 0)
  const traceStart = (await readView(contents)).trace.at(-1)?.sequence ?? 0
  await ports.capture('ai-camera-before-request', await readView(contents), contents)
  const thinking = await typePrompt(contents, ports, AI_CAMERA_PROMPT)
  const view = await waitFor(contents, ports, (v) => v.editor.lifecycle === 'ready'
    && snapshot(v).project.revision === before.snapshot.project.revision + 1
    && ports.applies().length === counts.applies + 1 && !v.aiReview.busy, 'actual-camera-auto-apply-settled', ports.config.turnSeconds * 1000)
  owner(ports, contents)
  const receipts = ports.receipts(); assert.equal(receipts.chats.length, 1); assert.equal(receipts.previews.length, 1); assert.equal(receipts.discards.length, 0)
  const responseReceipt = receipts.chats[0], preview = receipts.previews[0]
  assert.equal(responseReceipt.status, 200); assert.equal(responseReceipt.validation, 'accepted'); assert.ok(responseReceipt.request)
  assert.equal(responseReceipt.request.thinking, 'off', 'Actual request Thinking differs from the native off witness')
  assert.equal(view.bootId, thinking.bootId, 'Thinking request renderer generation changed')
  assert.equal(responseReceipt.request.model, thinking.model, 'Thinking request context model changed')
  const requestContext = responseReceipt.request.worldContext
  for (const field of ['projectKey', 'projectId', 'activeSceneId', 'baseRevision'] as const)
    assert.equal(requestContext[field], thinking[field], `Thinking request context ${field} changed`)
  const parsed = parseWorldAiChatResponse(responseReceipt.response); assert.equal(parsed.worldProposals.length, 1)
  assert.deepEqual(parsed.worldProposals[0], preview.request.proposal)
  const context = preview.request.proposal.context; assert.ok(sameWorldAiContext(context, responseReceipt.request.worldContext))
  assert.equal(context.projectId, before.snapshot.project.projectId); assert.equal(context.baseRevision, before.snapshot.project.revision)
  const queries = receipts.queries.slice(counts.queries); assert.ok(queries.length > 0)
  for (const q of queries) {
    assert.ok(q.result.ok && sameWorldAiContext(q.request.context, context) && sameWorldAiContext(q.result.value.context, context))
    assert.equal(q.result.value.kind, q.request.query.kind)
    // The production recipe tool already advertises camera creation. A separate
    // project query is optional, but any returned capability page must be valid.
    if (q.result.value.kind === 'project') assert.ok(q.result.value.items.some((row) => row.kind === 'project' && row.id === context.projectId && row.capabilities?.includes('create-camera')), 'Invalid optional create-camera capability query')
  }
  const sceneRows = queries.filter((q) => q.result.ok && q.result.value.kind === 'scenes').flatMap((q) => q.result.ok ? q.result.value.items : [])
  assert.ok(sceneRows.some((row) => row.kind === 'scene' && row.id === context.activeSceneId && row.isActive === true), 'Missing actual captured active scene query')
  const creation = assertCameraCreation(before.snapshot, preview)
  const manualDecisionInputs = view.trace.filter((event) => event.sequence > traceStart && event.type === 'click'
    && (event.target === 'BUTTON:Apply Worlds proposal' || event.target === 'BUTTON:Reject Worlds proposal'))
  assert.deepEqual(manualDecisionInputs, [], 'Direct auto-apply must not use a manual decision input')
  assert.deepEqual(view.aiReview.manualControls, { apply: 0, reject: 0 }, 'Settled production UI exposed manual proposal decisions')
  assert.equal(view.aiReview.applyEnabled, false); assert.equal(view.aiReview.rejectEnabled, false); assert.equal(view.aiReview.busy, false)
  assert.deepEqual(view.aiReview.details, []); assert.deepEqual(view.aiReview.warnings, []); assert.equal(view.aiReview.status, 'Saved')
  assert.equal(ports.applies().length, counts.applies + 1); const invocation = ports.applies()[counts.applies]
  assert.ok(preview.result.ok && invocation.result?.ok && invocation.result.value.idempotent === false)
  assert.equal(invocation.request.batch.origin, 'ai'); assert.deepEqual(invocation.request.batch, preview.result.value.batch)
  assert.equal(canonicalWorldCommandBatchPayload(invocation.request.batch), canonicalWorldCommandBatchPayload(preview.result.value.batch))
  assert.deepEqual(invocation.request.aiAuthority, { token: preview.result.value.authority, context })
  assert.deepEqual(snapshot(view), creation.candidate); assert.deepEqual(invocation.result.value.snapshot, creation.candidate)
  assert.deepEqual(invocation.result.value.inverse, preview.result.value.result.inverse)
  const after = await ports.documentState(view)
  assert.deepEqual(after.snapshot, creation.candidate); assert.equal(after.history.undo, before.history.undo + 1); assert.equal(after.history.redo, 0)
  await ports.capture('ai-camera-auto-applied-canonical-candidate', view, contents)
  return { view, creation, evidence: { context, thinking, request: structuredClone(responseReceipt.request), responseReceipt: structuredClone(responseReceipt),
    queries: structuredClone(queries), preview: structuredClone(preview), before: structuredClone(before), after: structuredClone(after),
    settledUi: structuredClone(view.aiReview), manualDecisionInputs: structuredClone(manualDecisionInputs), invocation: structuredClone(invocation), stored: await ports.stored(invocation) } }
}
function revised(snapshot: WorldProjectSnapshotV1, revision: number) { const result = structuredClone(snapshot); result.project.revision = revision; return result }

/** One real model turn, direct production auto-apply, and native history/reopen proof. */
export async function runActualOllamaDriver(contents: WebContents, ports: AiDriverPorts): Promise<void> {
  budget(ports, 250, 'finite actual AI scenario'); owner(ports, contents)
  const initial = await readView(contents), before = await ports.documentState(initial), activeSceneId = initial.editor.activeSceneId, projectKey = initial.editor.projectKey
  assert.ok(activeSceneId && projectKey); assert.equal(before.snapshot.scenes.length, 2)
  const offset = ports.applies().length
  assert.equal(ports.receipts().chats.length, 0); assert.equal(ports.receipts().discoveries.length, 0)
  ports.stage('actual-model-discovery')
  await click(contents, ports, 'ai-toggle', 'Worlds AI')
  await waitFor(contents, ports, (v) => v.aiReview.expanded && v.aiReview.prompt !== null, 'actual-AI-drawer', 5000)
  await click(contents, ports, 'ai-model', 'Worlds model picker')
  await waitFor(contents, ports, (v) => v.aiReview.modelOptions.includes(ports.reviewedModel.name), 'actual-reviewed-discovery-option', ports.config.modelsSeconds * 1000)
  const discovery = ports.receipts().discoveries[0]; assert.equal(ports.receipts().discoveries.length, 1)
  assert.equal(discovery.validation, 'accepted'); const body = discovery.response as { models: Array<{ name: string; digest: string }> }
  assert.equal(body.models.filter((m) => m.name === ports.reviewedModel.name && m.digest === ports.reviewedModel.digest).length, 1)
  await click(contents, ports, 'ai-option', ports.reviewedModel.name)
  await waitFor(contents, ports, (v) => v.aiReview.selectedModel === ports.reviewedModel.name && v.aiReview.modelOptions.length === 0, 'actual-selected-reviewed-model')
  await ports.pass('actual-model-discovery')

  ports.stage('actual-ai-camera-auto-apply-and-history')
  const turn = await autoApplyCameraTurn(contents, ports, before)
  let view = turn.view
  assert.equal(ports.applies().length, offset + 1)
  await ports.admitNativeFocus(contents)
  await click(contents, ports, 'ai-toggle', 'Worlds AI')
  await waitFor(contents, ports, (current) => !current.aiReview.expanded, 'actual-ai-drawer-closed-before-history')
  const historyEvents = []
  for (const [index, kind, original] of [[0, 'Undo', before.snapshot], [1, 'Redo', turn.creation.candidate]] as const) {
    const start = (await readView(contents)).trace.at(-1)?.sequence ?? 0
    await ports.admitNativeFocus(contents)
    await click(contents, ports, 'button', kind)
    view = await waitFor(contents, ports, (v) => v.editor.lifecycle === 'ready' && snapshot(v).project.revision === before.snapshot.project.revision + 2 + index, `actual-ai-${kind}`, 12000)
    assert.equal(ports.applies().length, offset + 2 + index); const entry = ports.applies()[offset + 1 + index]
    assert.equal(entry.request.batch.origin, kind.toLowerCase()); assert.ok(entry.result?.ok && !entry.result.value.idempotent)
    assert.deepEqual(snapshot(view), revised(original, before.snapshot.project.revision + 2 + index))
    const events = view.trace.filter((t) => t.sequence > start && t.type === 'click' && t.target === `BUTTON:${kind}`); assert.equal(events.length, 1); assert.ok(events[0].trusted)
    const hover = ports.nativeClickWitness(kind) as { point: { x: number; y: number }; matchCount: number; enabled: boolean; visible: boolean; hitMatches: boolean }
    assert.ok(hover && hover.matchCount === 1 && hover.enabled && hover.visible && hover.hitMatches)
    historyEvents.push({ kind, input: { trusted: events[0].trusted, sequence: events[0].sequence, target: events[0].target, hitMatches: hover.hitMatches, point: hover.point, hover }, result: structuredClone(entry.result), stored: await ports.stored(entry) })
    await ports.capture(`ai-camera-${kind.toLowerCase()}-exact-document`, await paint(contents, ports), contents)
  }
  assert.deepEqual(snapshot(view), revised(turn.creation.candidate, before.snapshot.project.revision + 3), 'Redo changed the generated camera identity or values')
  await ports.pass('actual-ai-camera-auto-apply-and-history')

  ports.stage('actual-ai-camera-reopen'); budget(ports, 25, 'fresh AI camera')
  const durable = snapshot(view), oldBootId = view.bootId, auxiliaryKey = view.editor.projects.find((p) => p.projectKey !== projectKey)?.projectKey
  assert.ok(auxiliaryKey, 'Inherited authoring lane must provide the actual auxiliary project for explicit Open')
  contents = await ports.reopen(); owner(ports, contents)
  const fresh = await waitFor(contents, ports, (v) => v.bootId !== oldBootId && v.editor.lifecycle === 'ready' && !!v.canvas && !v.canvas.contextLost && v.canvas.frame > 1, 'actual-ai-fresh-renderer', 8000)
  ports.admitReopened(fresh)
  await ports.admitNativeFocus(contents)
  if (fresh.editor.projectKey !== auxiliaryKey) {
    await selectValue(contents, ports, 'World project', auxiliaryKey); await click(contents, ports, 'button', 'Open selected World project')
    await waitFor(contents, ports, (v) => v.editor.projectKey === auxiliaryKey && v.editor.lifecycle === 'ready', 'actual-ai-open-auxiliary')
  }
  await ports.admitNativeFocus(contents)
  await selectValue(contents, ports, 'World project', projectKey); await click(contents, ports, 'button', 'Open selected World project')
  await waitFor(contents, ports, (v) => v.editor.projectKey === projectKey && v.editor.lifecycle === 'ready', 'actual-ai-explicit-project-reopen')
  await ports.admitNativeFocus(contents)
  await selectValue(contents, ports, 'Active scene', activeSceneId)
  view = await waitFor(contents, ports, (current) => current.editor.activeSceneId === activeSceneId && current.editor.lifecycle === 'ready', 'actual-ai-camera-scene-reopen')
  const selectionStart = view.trace.at(-1)?.sequence ?? 0
  await ports.admitNativeFocus(contents)
  await click(contents, ports, 'tree', turn.creation.camera.name)
  view = await waitFor(contents, ports, (current) => current.selection.active === turn.creation.camera.id && current.inspectorName === turn.creation.camera.name, 'actual-ai-camera-inspector-reopen')
  view = await paint(contents, ports); assert.deepEqual(snapshot(view), durable); assert.equal(ports.applies().length, offset + 3)
  const selectionEvents = view.trace.filter((event) => event.sequence > selectionStart && event.type === 'click' && event.target === `SPAN:${turn.creation.camera.name}`)
  assert.equal(selectionEvents.length, 1); assert.equal(selectionEvents[0].trusted, true)
  const selectionHover = ports.nativeClickWitness(turn.creation.camera.name) as { point: { x: number; y: number }; matchCount: number; enabled: boolean; visible: boolean; hitMatches: boolean }
  assert.ok(selectionHover && selectionHover.matchCount === 1 && selectionHover.enabled && selectionHover.visible && selectionHover.hitMatches)
  const inspector = new Map(view.inspectorValues.map((field) => [field.label, field]))
  for (const [label, expected] of [['Position:X', 0], ['Position:Y', 2], ['Position:Z', 5], ['Rotation:X', 0], ['Rotation:Y', 0], ['Rotation:Z', 0], ['Scale:X', 1], ['Scale:Y', 1], ['Scale:Z', 1], ['Camera:Near', 0.1], ['Camera:Far', 1000], ['Camera:Field of view', 60]] as const) {
    const field = inspector.get(label); assert.ok(field, `Fresh camera Inspector missing ${label}`); assert.equal(field.disabled, false); assert.equal(Number(field.value), expected)
  }
  const captured = await ports.capture('ai-camera-fresh-reopen-inspector', view, contents)
  assert.deepEqual((await ports.documentState(view)).snapshot, durable)
  const reopened = { sceneId: activeSceneId, entityId: turn.creation.camera.id, oldBootId, bootId: view.bootId, snapshot: durable, canonicalDiskMatches: true,
    selectionActive: view.selection.active, inspectorName: view.inspectorName, inspectorValues: structuredClone(view.inspectorValues),
    selectionInput: { trusted: selectionEvents[0].trusted, sequence: selectionEvents[0].sequence, target: selectionEvents[0].target, hitMatches: selectionHover.hitMatches, point: selectionHover.point, hover: selectionHover }, screenshot: captured.screenshot }
  await ports.pass('actual-ai-camera-reopen')
  const receipts = ports.receipts(), aiCalls = ports.applies().filter((call) => call.request.batch.origin === 'ai')
  ports.record('actualAi', { schema: 'modly.worlds-actual-ai-acceptance.v1', phase: 'complete', admittedModel: ports.reviewedModel, discovery: structuredClone(discovery), prompt: AI_CAMERA_PROMPT, turn: turn.evidence, undo: historyEvents[0], redo: historyEvents[1], reopened,
    counters: { discoveryRequests: receipts.discoveryRequests, discoveryResponses: receipts.discoveries.length, chatRequests: receipts.chatRequests, receivedChats: receipts.chats.length, validDecodedChats: receipts.chats.filter((c) => c.validation === 'accepted').length, validReturnedWorldProposals: receipts.chats.reduce((n, c) => n + parseWorldAiChatResponse(c.response).worldProposals.length, 0), hostPreviews: receipts.previews.length, hostDiscards: receipts.discards.length, aiApplies: aiCalls.length, aiSettledApplies: aiCalls.filter((c) => c.result?.ok && c.forwardedAt && c.settledAt).length, undo: historyEvents.filter((e) => e.kind === 'Undo').length, redo: historyEvents.filter((e) => e.kind === 'Redo').length } })
}
