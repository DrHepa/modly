import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import { canonicalWorldCommandBatchPayload } from '../../src/areas/worlds/core/worldCommands.ts'
import { sameWorldAiContext, type WorldAiContext, type WorldAiQueryRequest, type WorldAiQueryPage, type WorldAiResourceRow } from '../../src/areas/worlds/core/worldAiContract.ts'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import type { WorldProjectAiPreviewRequest, WorldProjectAiPreviewResult, WorldProjectAiDiscardRequest, WorldProjectResult } from '../../src/shared/types/worldProjects.ts'
import { parseWorldAiChatResponse } from '../../src/areas/worlds/editor/worldAiChatAdapter.ts'
import type { AuthoringView, LocalAiConfig, ReviewedAiModel } from './shared.ts'
import { click, key, paint, readView, selectValue, waitFor, assertReopenedAuthoringVisual, type CommonDriverPorts, type Invocation, type Shot } from './driver.ts'
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
  nativeClickWitness(label: string): unknown
  admitReopened(view: AuthoringView): void
  receipts(): { discoveries: readonly AiHttpReceipt[]; chats: readonly AiHttpReceipt[]; queries: readonly AiQueryCapture[]; previews: readonly AiPreviewCapture[]; discards: readonly AiDiscardCapture[]; discoveryRequests: number; chatRequests: number }
  documentState(view: AuthoringView): Promise<AiDocumentState>
  sourceWitnesses(preview: AiPreviewCapture, rows: WorldAiResourceRow[]): Promise<AiSourceWitness[]>
  stored(entry: Invocation): Promise<AiStoredWitness>
  capture(stage: string, view: AuthoringView, contents: WebContents): Promise<{ shot: Shot; screenshot: { filename: string; bytes: number; sha256: string } }>
}
const snapshot = (view: AuthoringView) => { assert.ok(view.editor.session); return view.editor.session.snapshot }
const identity = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
function budget(ports: AiDriverPorts, seconds: number, stage: string): void {
  ports.guard(); assert.ok(Date.now() + seconds * 1000 < ports.deadline - ports.config.cleanupSeconds * 1000, `Insufficient remaining fixed budget for ${stage}`)
}
function owner(ports: AiDriverPorts, contents: WebContents): void {
  ports.guard(); assert.equal(contents.isDestroyed(), false); assert.equal(contents, ports.currentContents(), 'Native AI cannot use a stale renderer generation')
}
function shortLabel(property: string): string {
  const field = property.split('.').at(-1) ?? property
  return ({ parentId: 'Parent', baseColor: 'Color', bodyType: 'Body', lightKind: 'Light', halfExtents: 'Size', halfHeight: 'Height', fieldOfView: 'FOV', orthographicSize: 'Size', castShadow: 'Shadow', receiveShadow: 'Receive', collisionLayer: 'Layer', collisionMask: 'Mask' } as Record<string, string>)[field]
    ?? field.charAt(0).toUpperCase() + field.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2')
}
function assertReview(view: AuthoringView, preview: AiPreviewCapture): void {
  assert.ok(preview.result.ok)
  const ui = view.aiReview, value = preview.result.value
  assert.ok(ui.expanded && !ui.busy && ui.focused && ui.applyEnabled && ui.rejectEnabled, 'Real visible review is not ready/focused')
  assert.deepEqual(value.result.warnings, []); assert.deepEqual(ui.warnings, [])
  assert.ok(value.details.length > 0)
  assert.deepEqual(ui.details, value.details.map(({ entityName, property, before, after }) => ({ entityName, property: shortLabel(property), before, after })), 'Complete ordered visible NET differs from actual host preview')
}
function assertOrganization(before: WorldProjectSnapshotV1, preview: AiPreviewCapture, targetId: string, sceneId: string): void {
  assert.ok(preview.result.ok); const candidate = preview.result.value.result.snapshot
  const oldScene = before.scenes.find((s) => s.sceneId === sceneId)!, nextScene = candidate.scenes.find((s) => s.sceneId === sceneId)!
  const added = nextScene.entities.filter((e) => !oldScene.entities.some((old) => old.id === e.id))
  assert.equal(added.length, 1, 'Review request must create exactly one organizational group')
  const group = added[0]; assert.equal(group.name, 'AI review group'); assert.equal(group.parentId, null); assert.deepEqual(group.transform, identity); assert.deepEqual(group.components, [])
  const expected = structuredClone(before); expected.project.revision++
  const scene = expected.scenes.find((s) => s.sceneId === sceneId)!, target = scene.entities.find((e) => e.id === targetId)!
  assert.equal(target.parentId, null); target.parentId = group.id; target.transform.position[0] += 0.25; scene.entities.push(structuredClone(group))
  assert.deepEqual(candidate, expected, 'Organization proposal changed data beyond requested group/parent/localX')
}
function assertCreation(before: WorldProjectSnapshotV1, preview: AiPreviewCapture, witnesses: AiSourceWitness[]) {
  assert.ok(preview.result.ok); const candidate = preview.result.value.result.snapshot, active = preview.request.proposal.context.activeSceneId
  assert.equal(before.scenes.length, 2); assert.equal(candidate.scenes.length, 3)
  const addedScenes = candidate.scenes.filter((s) => !before.scenes.some((old) => old.sceneId === s.sceneId)); assert.equal(addedScenes.length, 1)
  const scene = addedScenes[0], old = before.scenes.find((s) => s.sceneId === active)!, next = candidate.scenes.find((s) => s.sceneId === active)!
  const newModels = next.entities.filter((e) => !old.entities.some((entity) => entity.id === e.id)); assert.equal(newModels.length, 1)
  const newSceneModels = scene.entities.filter((e) => e.components.some((c) => c.type === 'renderable')); assert.equal(newSceneModels.length, 1)
  for (const [model, position] of [[newModels[0], [0, 0, 1.5]], [newSceneModels[0], [0, 0, 0]]] as const) {
    assert.equal(model.parentId, null); assert.ok(model.enabled && !model.locked); assert.deepEqual(model.transform, { ...identity, position })
    const render = model.components.find((c) => c.type === 'renderable'); assert.ok(render?.type === 'renderable' && render.enabled && render.visible)
    assert.ok(witnesses.some((w) => w.resourceId === render.resourceId), 'New model is not linked to actual same-turn opaque GLB bytes')
  }
  for (const type of ['camera', 'light']) assert.equal(scene.entities.filter((e) => e.components.some((c) => c.type === type && c.enabled)).length, 1)
  const cameraEntity = scene.entities.find((e) => e.components.some((c) => c.type === 'camera'))!, lightEntity = scene.entities.find((e) => e.components.some((c) => c.type === 'light'))!
  assert.deepEqual(cameraEntity.transform, { position: [0, 1.5, 5], rotation: [-0.2, 0, 0], scale: [1, 1, 1] })
  assert.ok(cameraEntity.components.some((c) => c.type === 'camera' && c.primary))
  assert.ok(lightEntity.components.some((c) => c.type === 'light' && c.lightKind === 'ambient' && c.intensity === 0.8))
  assert.equal(scene.entities.length, 3, 'Creation request admits one model/camera/light, not unrelated groups/entities')
  assert.ok(newSceneModels[0].components.some((c) => c.type === 'collider' && c.enabled && c.shape === 'box'))
  assert.ok(newSceneModels[0].components.some((c) => c.type === 'rigid-body' && c.enabled && c.bodyType === 'dynamic'))
  // Preserve every original entity, scene and resource; only requested new canonical owners may be added.
  const expected = structuredClone(before); expected.project.revision++
  expected.project.resources = candidate.project.resources; expected.project.scenes.push(candidate.project.scenes.find((s) => s.id === scene.sceneId)!)
  expected.scenes.find((s) => s.sceneId === active)!.entities.push(structuredClone(newModels[0])); expected.scenes.push(structuredClone(scene))
  assert.deepEqual(candidate, expected, 'Creation modified existing document data')
  for (const resource of before.project.resources) assert.deepEqual(candidate.project.resources.find((r) => r.id === resource.id), resource)
  for (const resource of candidate.project.resources.filter((r) => !before.project.resources.some((old) => old.id === r.id))) assert.ok(witnesses.some((w) => w.resourceId === resource.id), 'Unrequested resource registered')
  assert.deepEqual(preview.result.value.result.inverse, { kind: 'world-snapshot', snapshot: before })
  return { candidate, sceneId: scene.sceneId, models: [{ sceneId: active, entityId: newModels[0].id }, { sceneId: scene.sceneId, entityId: newSceneModels[0].id }] }
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
  for (const char of prompt) { owner(ports, contents); contents.sendInputEvent({ type: 'char', keyCode: char }) }
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
async function reviewTurn(contents: WebContents, ports: AiDriverPorts, prompt: string, before: AiDocumentState, index: number) {
  budget(ports, ports.config.turnSeconds + (index === 0 ? ports.config.turnSeconds + 40 : 40), `chat-${index + 1}`)
  const counts = { applies: ports.applies().length, chats: ports.receipts().chats.length, previews: ports.receipts().previews.length, queries: ports.receipts().queries.length }
  assert.equal(counts.chats, index); assert.equal(counts.previews, index)
  await ports.capture(`ai-${index + 1}-before-request`, await readView(contents), contents)
  const thinking = await typePrompt(contents, ports, prompt)
  const view = await waitFor(contents, ports, (v) => v.aiReview.applyEnabled && !v.aiReview.busy, `actual-chat-${index + 1}-review`, ports.config.turnSeconds * 1000)
  owner(ports, contents); assert.equal(ports.applies().length, counts.applies, 'Provider/preview auto-applied a proposal')
  const receipts = ports.receipts(); assert.equal(receipts.chats.length, index + 1); assert.equal(receipts.previews.length, index + 1)
  const responseReceipt = receipts.chats[index], preview = receipts.previews[index]
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
  for (const q of queries) { assert.ok(q.result.ok && sameWorldAiContext(q.request.context, context) && sameWorldAiContext(q.result.value.context, context)) }
  for (const kind of index === 0 ? ['entities', 'components'] : ['project', 'resources']) assert.ok(queries.some((q) => q.result.ok && q.result.value.kind === kind && q.result.value.items.length > 0), `Missing actual ${kind} tool query`)
  assertReview(view, preview)
  assert.deepEqual(await ports.documentState(view), before, 'Proposal preview changed canonical document/history/disk')
  await ports.capture(`ai-${index + 1}-complete-net-before-decision`, view, contents)
  return { view, context, thinking, request: responseReceipt.request, responseReceipt: structuredClone(responseReceipt), preview: structuredClone(preview), queries: structuredClone(queries), before: structuredClone(before), beforeDecision: await ports.documentState(view), review: structuredClone(view.aiReview) }
}
async function decisionInput(contents: WebContents, ports: AiDriverPorts, label: string) {
  const before = await readView(contents), start = before.trace.at(-1)?.sequence ?? 0
  await click(contents, ports, 'button', label)
  const view = await readView(contents), clicks = view.trace.filter((t) => t.sequence > start && t.type === 'click' && t.target === `BUTTON:${label}`)
  assert.equal(clicks.length, 1); assert.ok(clicks[0].trusted)
  // click already enforces a stable, visible, enabled fixed-point hit before mouseDown.
  const hover = ports.nativeClickWitness(label) as { point: { x: number; y: number }; matchCount: number; enabled: boolean; visible: boolean; hitMatches: boolean }
  assert.ok(hover && hover.matchCount === 1 && hover.enabled && hover.visible && hover.hitMatches)
  return { trusted: clicks[0].trusted, sequence: clicks[0].sequence, target: clicks[0].target, hitMatches: hover.hitMatches, point: hover.point, hover }
}
function revised(snapshot: WorldProjectSnapshotV1, revision: number) { const result = structuredClone(snapshot); result.project.revision = revision; return result }

/** TWO real future turns, no provider response/proposal substitution or mutation API escapes. */
export async function runActualOllamaDriver(contents: WebContents, ports: AiDriverPorts): Promise<void> {
  budget(ports, 250, 'finite actual AI scenario'); owner(ports, contents)
  const initial = await readView(contents), before = await ports.documentState(initial), activeSceneId = initial.editor.activeSceneId, projectKey = initial.editor.projectKey
  assert.ok(activeSceneId && projectKey); assert.equal(before.snapshot.scenes.length, 2)
  const eligible = before.snapshot.scenes.find((s) => s.sceneId === activeSceneId)!.entities.filter((e) => e.parentId === null && e.enabled && !e.locked && e.components.some((c) => c.type === 'renderable' && c.enabled && c.visible))
  assert.ok(eligible.length > 0, 'Actual baseline has no editable root model')
  const target = eligible[0], offset = ports.applies().length
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

  ports.stage('actual-ai-reject')
  const first = await reviewTurn(contents, ports, `Query this active scene's entities and current components for entity ${target.id}. Propose only: create root group named AI review group with identity transform, reparent that root model under it, increase its LOCAL X by exactly 0.25 while preserving its other transform values. No other changes. Use create-entity group, reparent and complete transform patch recipes. I will review and Reject; never apply yourself.`, before, 0)
  assertOrganization(before.snapshot, first.preview, target.id, activeSceneId)
  const firstRows = first.queries.flatMap((q) => q.result.ok ? q.result.value.items : [])
  assert.ok(firstRows.some((row) => row.kind === 'entity' && row.id === target.id))
  assert.ok(firstRows.some((row) => row.kind === 'component' && row.entityId === target.id && row.type === 'renderable' && row.current))
  const rejectedInput = await decisionInput(contents, ports, 'Reject Worlds proposal')
  let view = await waitFor(contents, ports, (v) => !v.aiReview.applyEnabled && !v.aiReview.busy && ports.receipts().discards.length === 1, 'actual-human-Reject-discard', 5000)
  assert.equal(ports.applies().length, offset); assert.deepEqual(await ports.documentState(view), before)
  const rejected = { ...first, decision: { kind: 'reject', input: rejectedInput, discarded: structuredClone(ports.receipts().discards[0]), after: await ports.documentState(view) } }
  await ports.capture('ai-1-rejected-document-unchanged', view, contents); await ports.pass('actual-ai-reject')

  ports.stage('actual-ai-apply-and-history')
  const second = await reviewTurn(contents, ports, 'Query project capabilities and resources (GLB mesh pages); use one SAME actually returned opaque GLB resource handle for both new models. Create ONE new scene named AI staging: one observed-model root at [0,0,0], box collider and dynamic body on that model, ONE camera at [0,1.5,5] rotation [-0.2,0,0], ONE ambient light intensity 0.8. Also add one observed-model root in the current active scene at [0,0,1.5]. Both models have rotation [0,0,0], scale [1,1,1]. Keep all existing scenes/entities/resources/start scene unchanged. Stay within 16 expanded commands. Propose only; I will explicitly Apply.', before, 1)
  const rows = second.queries.flatMap((q) => q.result.ok ? q.result.value.items.filter((i): i is WorldAiResourceRow => i.kind === 'resource') : [])
  assert.ok(second.queries.some((q) => q.result.ok && q.result.value.items.some((row) => row.kind === 'project' && row.capabilities && row.capabilities.length > 0)))
  const sourceWitnesses = await ports.sourceWitnesses(second.preview, rows), creation = assertCreation(before.snapshot, second.preview, sourceWitnesses)
  assert.equal(ports.applies().length, offset); assert.deepEqual(await ports.documentState(await readView(contents)), before)
  const appliedInput = await decisionInput(contents, ports, 'Apply Worlds proposal')
  view = await waitFor(contents, ports, (v) => v.editor.lifecycle === 'ready' && snapshot(v).project.revision === before.snapshot.project.revision + 1 && !v.aiReview.busy, 'actual-human-Apply-settled', 12000)
  assert.equal(ports.applies().length, offset + 1); const invocation = ports.applies()[offset]
  assert.ok(second.preview.result.ok && invocation.result?.ok && invocation.result.value.idempotent === false)
  assert.equal(invocation.request.batch.origin, 'ai'); assert.deepEqual(invocation.request.batch, second.preview.result.value.batch)
  assert.equal(canonicalWorldCommandBatchPayload(invocation.request.batch), canonicalWorldCommandBatchPayload(second.preview.result.value.batch))
  assert.deepEqual(invocation.request.aiAuthority, { token: second.preview.result.value.authority, context: second.context })
  assert.deepEqual(snapshot(view), creation.candidate); assert.deepEqual(invocation.result.value.inverse, second.preview.result.value.result.inverse)
  const applied = { ...second, decision: { kind: 'apply', input: appliedInput, invocation: structuredClone(invocation), stored: await ports.stored(invocation) } }
  await ports.capture('ai-2-applied-canonical-candidate', view, contents)
  await click(contents, ports, 'ai-toggle', 'Worlds AI')
  const historyEvents = []
  for (const [index, kind, original] of [[0, 'Undo', before.snapshot], [1, 'Redo', creation.candidate]] as const) {
    const start = (await readView(contents)).trace.at(-1)?.sequence ?? 0
    await click(contents, ports, 'button', kind)
    view = await waitFor(contents, ports, (v) => v.editor.lifecycle === 'ready' && snapshot(v).project.revision === before.snapshot.project.revision + 2 + index, `actual-ai-${kind}`, 12000)
    assert.equal(ports.applies().length, offset + 2 + index); const entry = ports.applies()[offset + 1 + index]
    assert.equal(entry.request.batch.origin, kind.toLowerCase()); assert.ok(entry.result?.ok && !entry.result.value.idempotent)
    assert.deepEqual(snapshot(view), revised(original, before.snapshot.project.revision + 2 + index))
    const events = view.trace.filter((t) => t.sequence > start && t.type === 'click' && t.target === `BUTTON:${kind}`); assert.equal(events.length, 1); assert.ok(events[0].trusted)
    const hover = ports.nativeClickWitness(kind) as { point: { x: number; y: number }; matchCount: number; enabled: boolean; visible: boolean; hitMatches: boolean }
    assert.ok(hover && hover.matchCount === 1 && hover.enabled && hover.visible && hover.hitMatches)
    historyEvents.push({ kind, input: { trusted: events[0].trusted, sequence: events[0].sequence, target: events[0].target, hitMatches: hover.hitMatches, point: hover.point, hover }, result: structuredClone(entry.result), stored: await ports.stored(entry) })
    await ports.capture(`ai-2-${kind.toLowerCase()}-exact-document`, await paint(contents, ports), contents)
  }
  await ports.pass('actual-ai-apply-and-history')

  ports.stage('actual-ai-both-scenes-reopen'); budget(ports, 25, 'fresh AI-target scenes')
  const durable = snapshot(view), oldBootId = view.bootId, auxiliaryKey = view.editor.projects.find((p) => p.projectKey !== projectKey)?.projectKey
  assert.ok(auxiliaryKey, 'Inherited authoring lane must provide the actual auxiliary project for explicit Open')
  contents = await ports.reopen(); owner(ports, contents)
  const fresh = await waitFor(contents, ports, (v) => v.bootId !== oldBootId && v.editor.lifecycle === 'ready' && !!v.canvas && !v.canvas.contextLost && v.canvas.frame > 1, 'actual-ai-fresh-renderer', 8000)
  ports.admitReopened(fresh)
  if (fresh.editor.projectKey !== auxiliaryKey) {
    await selectValue(contents, ports, 'World project', auxiliaryKey); await click(contents, ports, 'button', 'Open selected World project')
    await waitFor(contents, ports, (v) => v.editor.projectKey === auxiliaryKey && v.editor.lifecycle === 'ready', 'actual-ai-open-auxiliary')
  }
  await selectValue(contents, ports, 'World project', projectKey); await click(contents, ports, 'button', 'Open selected World project')
  await waitFor(contents, ports, (v) => v.editor.projectKey === projectKey && v.editor.lifecycle === 'ready', 'actual-ai-explicit-project-reopen')
  const reopened = []
  for (const [index, targetModel] of creation.models.entries()) {
    await selectValue(contents, ports, 'Active scene', targetModel.sceneId)
    view = await waitFor(contents, ports, (v) => v.editor.activeSceneId === targetModel.sceneId && !!v.canvas?.models.some((m) => m.entityId === targetModel.entityId && m.meshes > 0 && m.triangles > 0), `actual-ai-target-scene-${index + 1}`, 8000)
    view = await paint(contents, ports); assert.deepEqual(snapshot(view), durable); assert.equal(ports.applies().length, offset + 3)
    const captured = await ports.capture(`ai-3-fresh-target-scene-${index + 1}`, view, contents)
    assertReopenedAuthoringVisual(captured.shot, view, targetModel.entityId)
    const model = view.canvas!.models.find((m) => m.entityId === targetModel.entityId)!; const canonical = durable.scenes.find((s) => s.sceneId === targetModel.sceneId)!.entities.find((e) => e.id === targetModel.entityId)!
    for (const field of ['position', 'rotation', 'scale'] as const) for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(model.transform[field][axis] - canonical.transform[field][axis]) <= 1e-7)
    assert.deepEqual((await ports.documentState(view)).snapshot, durable)
    reopened.push({ sceneId: targetModel.sceneId, oldBootId, bootId: view.bootId, snapshot: durable, canonicalDiskMatches: true, model, screenshot: captured.screenshot })
  }
  await ports.pass('actual-ai-both-scenes-reopen')
  const receipts = ports.receipts(), aiCalls = ports.applies().filter((call) => call.request.batch.origin === 'ai')
  ports.record('actualAi', { schema: 'modly.worlds-actual-ai-acceptance.v1', phase: 'complete', admittedModel: ports.reviewedModel, discovery: structuredClone(discovery), turns: [rejected, applied], sourceWitnesses, undo: historyEvents[0], redo: historyEvents[1], reopened,
    counters: { discoveryRequests: receipts.discoveryRequests, discoveryResponses: receipts.discoveries.length, chatRequests: receipts.chatRequests, receivedChats: receipts.chats.length, validDecodedChats: receipts.chats.filter((c) => c.validation === 'accepted').length, validReturnedWorldProposals: receipts.chats.reduce((n, c) => n + parseWorldAiChatResponse(c.response).worldProposals.length, 0), hostPreviews: receipts.previews.length, hostDiscards: receipts.discards.length, aiApplies: aiCalls.length, aiSettledApplies: aiCalls.filter((c) => c.result?.ok && c.forwardedAt && c.settledAt).length, undo: historyEvents.filter((e) => e.kind === 'Undo').length, redo: historyEvents.filter((e) => e.kind === 'Redo').length } })
}
