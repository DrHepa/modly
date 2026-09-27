#!/usr/bin/env node
// Separate, explicitly reviewed native entry. The build-only entry never imports or runs this file.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { captureOwnedDisplayResources, waitForDisplayResourcesAbsent } from './display-resources.mjs'

const reviewedRepositoryHead = 'bdcbd778e28358c1d582503e3202c7d9b649dd1a'
const reviewedRepositoryBranch = 'codex/worlds-engine'

export function validateRunnerRepositoryAdmission(build) {
  assert.ok(build && typeof build === 'object' && !Array.isArray(build), 'Build manifest record required')
  const admission = build.repositoryAdmission
  assert.ok(admission && typeof admission === 'object' && !Array.isArray(admission), 'Repository admission required')
  assert.deepEqual(Object.keys(admission).sort(), ['schema', 'root', 'head', 'branch'].sort(), 'Repository admission keys changed')
  assert.equal(admission.schema, 'modly.worlds-authoring-repository-admission.v1')
  assert.ok(typeof admission.root === 'string' && path.isAbsolute(admission.root)
    && path.resolve(admission.root) === admission.root && !admission.root.includes('\0'), 'Canonical repository admission root required')
  assert.equal(admission.root, build.repositoryRoot, 'Repository admission root changed')
  assert.equal(admission.head, build.initialHead, 'Repository admission head changed')
  assert.equal(admission.branch, build.initialBranch, 'Repository admission branch changed')
  assert.equal(admission.head, reviewedRepositoryHead, 'Reviewed repository head changed')
  assert.equal(admission.branch, reviewedRepositoryBranch, 'Reviewed repository branch changed')
  assert.ok(Array.isArray(build.sourceInputs) && build.sourceInputs.length > 0, 'Source input inventory required')
  const anchorPath = path.join(admission.root, 'scripts/worlds-authoring-electron-fixture/run.mjs')
  const anchors = build.sourceInputs.filter((entry) => entry?.path === anchorPath)
  assert.equal(anchors.length, 1, 'Pinned runner source anchor required')
  const anchor = anchors[0], output = build.outputs?.['run.mjs']
  assert.ok(output && Number.isSafeInteger(output.bytes) && output.bytes >= 0 && /^[a-f0-9]{64}$/.test(output.sha256), 'Pinned runner output receipt required')
  assert.equal(anchor.bytes, output.bytes, 'Runner source/output byte pin changed')
  assert.equal(anchor.sha256, output.sha256, 'Runner source/output hash pin changed')
  return admission
}

export function validateRunnerLocalAiConfig(localAi, repositoryAdmission) {
  assert.ok(localAi && typeof localAi === 'object' && !Array.isArray(localAi), 'Local-AI configuration required')
  assert.ok(repositoryAdmission && typeof repositoryAdmission.root === 'string', 'Repository admission required for local-AI paths')
  assert.equal(localAi.apiRoot, path.join(repositoryAdmission.root, 'api'), 'Local-AI API path changed')
  assert.equal(localAi.pythonPath, path.join(repositoryAdmission.root, 'api/.venv/bin/python'), 'Local-AI Python path changed')
  return localAi
}

export function validateRunnerWorldSculptInput(build, runtimeMode) {
  assert.ok(build && typeof build === 'object' && !Array.isArray(build), 'Build manifest record required')
  if (runtimeMode !== 'worldsculpt-navigation') {
    assert.equal(build.worldSculptInput, undefined, 'WorldSculpt input is forbidden outside its runtime lane')
    return null
  }
  assert.equal(build.runtimeMode, runtimeMode, 'WorldSculpt runtime mode must match the reviewed manifest')
  const input = build.worldSculptInput
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'WorldSculpt input contract required')
  assert.deepEqual(Object.keys(input).sort(), ['schema', 'sourceIdentity', 'bundled', 'workspaceRelativePath'].sort())
  assert.equal(input.schema, 'modly.worlds-authoring-worldsculpt-input.v1')
  assert.equal(input.workspaceRelativePath, 'Workflows/worldsculpt-5a9cc08eaf924e988e527f75137ea8c4/scene.glb')
  const source = input.sourceIdentity, bundled = input.bundled
  assert.ok(source && typeof source === 'object' && !Array.isArray(source)); assert.deepEqual(Object.keys(source).sort(), ['bytes', 'sha256', 'device', 'inode', 'uid', 'mode'].sort())
  assert.ok(bundled && typeof bundled === 'object' && !Array.isArray(bundled)); assert.deepEqual(Object.keys(bundled).sort(), ['relativePath', 'bytes', 'sha256'].sort())
  assert.equal(bundled.relativePath, 'inputs/worldsculpt-scene.glb')
  assert.ok(Number.isSafeInteger(source.bytes) && source.bytes >= 12); assert.equal(bundled.bytes, source.bytes)
  assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.equal(bundled.sha256, source.sha256)
  assert.match(source.device, /^[0-9]+$/); assert.match(source.inode, /^[0-9]+$/)
  assert.ok(Number.isSafeInteger(source.uid) && source.uid >= 0); assert.ok(Number.isSafeInteger(source.mode) && source.mode >= 0 && source.mode <= 0o777)
  assert.deepEqual(build.outputs?.[bundled.relativePath], { bytes: bundled.bytes, sha256: bundled.sha256 }, 'Bundled WorldSculpt output pin changed')
  return input
}

export function parseRunArguments(args) {
  assert.ok(args.length >= 1 && args.length <= 3, 'One reviewed build and explicitly bounded modes are required')
  assert.match(args[0], /^--reviewed-build-sha256=[a-f0-9]{64}$/)
  if (args.length >= 2) assert.equal(args[1], '--inherited-display', 'No native flags or unreviewed modes are permitted')
  if (args.length === 3) {
    assert.ok(['--local-ai', '--worldsculpt-navigation'].includes(args[2]), 'No unreviewed runtime modes are permitted')
    return { buildSha256: args[0].split('=')[1], mode: 'inherited-display', runtimeMode: args[2] === '--local-ai' ? 'local-ai' : 'worldsculpt-navigation' }
  }
  return { buildSha256: args[0].split('=')[1], mode: args.length === 2 ? 'inherited-display' : 'owned-xvfb' }
}

export function inheritedDisplayEnvironment(environment, runDirectory, buildSha256) {
  assert.ok(typeof environment.DISPLAY === 'string' && environment.DISPLAY.trim(), 'Inherited DISPLAY is required; no replacement display is created')
  for (const name of ['WORLD_AUTHORING_RUN_DIRECTORY', 'WORLD_AUTHORING_BUILD_SHA256', 'WORLD_AUTHORING_RUNTIME_MODE', 'WORLD_AUTHORING_LOCAL_AI_CONFIG']) assert.equal(Object.hasOwn(environment, name), false, `Refusing reserved fixture environment field ${name}`)
  // Preserve every inherited value, including display/auth/HOME/XDG fields. Never read authentication bytes.
  return { ...environment, WORLD_AUTHORING_RUN_DIRECTORY: runDirectory, WORLD_AUTHORING_BUILD_SHA256: buildSha256 }
}

/** Evidence policy only. Synthetic guard controls never establish that a native run occurred. */
export function assertActualAiTerminal(result) {
  const a = result.evidence?.actualAi
  const expectedPrompt = 'Add one perspective camera named AI Probe Camera to the current scene at position [0, 2, 5], with field of view 60, no rotation and scale [1, 1, 1]. Put it at the scene root and change nothing else.'
  const expectedModel = { name: 'qwen3.6:27b', digest: 'sha256:a50eda8ed977ab48a12431878896b27ffd5cef552c17af3317d9623b939a7f1e', toolsReviewed: true }
  assert.equal(a?.schema, 'modly.worlds-actual-ai-acceptance.v1', 'Actual AI acceptance schema missing')
  assert.equal(a.phase, 'complete', 'Actual AI acceptance phase incomplete')
  for (const name of ['actual-model-discovery', 'actual-ai-camera-auto-apply-and-history', 'actual-ai-camera-reopen']) assert.equal(result.checks.filter((check) => check.name === name && check.status === 'PASS').length, 1, `Actual AI check missing: ${name}`)
  const stable = (value) => JSON.stringify((function sort(v) { return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((key) => v[key] !== undefined).map((key) => [key, sort(v[key])])) : v })(value))
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const same = (value, other, label) => assert.deepEqual(value, other, `Actual AI ${label}`)
  const context = (c) => {
    same(Object.keys(c ?? {}).sort(), ['schema', 'projectKey', 'projectId', 'activeSceneId', 'baseRevision', 'editorEpoch', 'originSessionId', 'requestId'].sort(), 'complete context required')
    assert.equal(c.schema, 'modly.world-ai-context.v1'); assert.match(c.projectKey, /^world-[a-f0-9]{32}$/)
    for (const field of ['projectId', 'activeSceneId', 'originSessionId', 'requestId']) assert.ok(typeof c[field] === 'string' && c[field].length > 0)
    for (const field of ['baseRevision', 'editorEpoch']) assert.ok(Number.isSafeInteger(c[field]) && c[field] >= 0)
  }
  const raw = (receipt) => {
    assert.equal(receipt?.status, 200, 'Actual AI HTTP success required'); assert.equal(receipt.validation, 'accepted', 'Actual AI decode not accepted')
    assert.ok(typeof receipt.rawResponseBase64 === 'string'); const bytes = Buffer.from(receipt.rawResponseBase64, 'base64')
    assert.equal(bytes.toString('base64'), receipt.rawResponseBase64); assert.ok(bytes.length > 0 && bytes.length <= 65536)
    assert.equal(receipt.responseBytes, bytes.length); assert.equal(receipt.responseSha256, digest(bytes))
    same(JSON.parse(bytes.toString('utf8')), receipt.response, 'received bytes/decoded response mismatch')
    return receipt.response
  }
  const nativeButtonInput = (input, label) => {
    assert.equal(input?.trusted, true, 'Actual AI history input was not trusted native input')
    assert.ok(Number.isSafeInteger(input.sequence) && input.sequence > 0); assert.equal(input.hitMatches, true)
    assert.equal(input.target, `BUTTON:${label}`)
    assert.ok(input.hover?.matchCount === 1 && input.hover.enabled === true && input.hover.visible === true && input.hover.hitMatches === true, 'Actual native fixed-point hover witness missing')
    same(input.point, input.hover.point, 'Native input point changed after hover')
    assert.ok(Number.isFinite(input.point.x) && Number.isFinite(input.point.y))
  }
  const state = (value) => {
    assert.ok(value?.snapshot?.project && Array.isArray(value.snapshot.scenes))
    assert.ok(Number.isSafeInteger(value.history?.undo) && Number.isSafeInteger(value.history?.redo))
    assert.ok(Array.isArray(value.documents) && value.documents.length > 0)
    for (const document of value.documents) { assert.ok(typeof document.path === 'string' && !document.path.startsWith('/') && !document.path.split('/').includes('..')); assert.match(document.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(document.bytes) && document.bytes > 0) }
  }
  same(a.admittedModel, expectedModel, 'reviewed model identity changed')
  const discovery = raw(a.discovery)
  assert.equal(discovery.models.filter((model) => model.name === expectedModel.name && model.digest === expectedModel.digest).length, 1, 'Actual discovery does not contain the exact reviewed identity')
  assert.equal(a.prompt, expectedPrompt, 'Actual AI camera prompt changed')
  same(a.counters, { discoveryRequests: 1, discoveryResponses: 1, chatRequests: 1, receivedChats: 1, validDecodedChats: 1, validReturnedWorldProposals: 1, hostPreviews: 1, hostDiscards: 0, aiApplies: 1, aiSettledApplies: 1, undo: 1, redo: 1 }, 'finite counters mismatch')
  assert.equal(Object.hasOwn(a, 'turns'), false, 'Obsolete multi-turn evidence is forbidden')
  assert.equal(Object.hasOwn(a, 'sourceWitnesses'), false, 'Camera acceptance must not fabricate model-source witnesses')
  const turn = a.turn
  context(turn?.context); same(turn.request?.worldContext, turn.context, 'captured request context changed')
  assert.equal(turn.request.model, expectedModel.name); assert.equal(turn.request.ollama_url, 'http://127.0.0.1:11434'); assert.equal(turn.request.thinking, 'off')
  assert.equal(turn.request.originSessionId, turn.context.originSessionId); same(turn.request.context, {}, 'legacy prompt context must remain empty')
  same(turn.request.messages, [{ role: 'user', content: expectedPrompt }], 'exact user request changed')
  assert.equal(Object.hasOwn(turn.request, 'provider'), false); assert.equal(Object.hasOwn(turn.request, 'openaiModel'), false)
  same(turn.responseReceipt.request, turn.request, 'HTTP receipt request correlation changed')
  same(turn.responseReceipt.admittedSelection, { name: expectedModel.name, digest: expectedModel.digest }, 'HTTP receipt admitted identity changed')
  const body = raw(turn.responseReceipt); same(body.actions, [], 'generic actions forbidden'); same(body.proposals, [], 'generic proposals forbidden')
  assert.equal(body.worldProposals.length, 1, 'Actual AI proposal missing')
  const proposal = body.worldProposals[0]; same(proposal.context, turn.context, 'returned proposal context changed')
  assert.equal(proposal.type, 'world_command_proposal')
  assert.equal(proposal.commands.length, 1, 'Actual response must contain exactly one parsed recipe')
  const recipe = proposal.commands[0]
  assert.equal(recipe.type, 'create-entity'); assert.equal(recipe.kind, 'camera')
  assert.ok(typeof recipe.localRef === 'string' && recipe.localRef.length > 0, 'Parsed camera local identity missing')
  same(recipe.sceneRef, { kind: 'existing', id: turn.context.activeSceneId }, 'camera recipe does not target the captured active scene')
  assert.ok(recipe.parentRef === undefined || recipe.parentRef === null, 'camera recipe is not rooted')
  assert.equal(recipe.name, 'AI Probe Camera'); same(recipe.transform, { position: [0, 2, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }, 'requested camera transform changed')
  const cameraOptions = recipe.camera ?? {}
  assert.ok(cameraOptions && typeof cameraOptions === 'object' && !Array.isArray(cameraOptions), 'Parsed camera options are invalid')
  same({ projection: cameraOptions.projection ?? 'perspective', near: cameraOptions.near ?? 0.1, far: cameraOptions.far ?? 1000,
    fieldOfView: cameraOptions.fieldOfView ?? 60 }, { projection: 'perspective', near: 0.1, far: 1000, fieldOfView: 60 }, 'requested camera options changed')
  assert.equal(cameraOptions.orthographicSize, undefined, 'Perspective camera carried an orthographic option')
  assert.ok(Array.isArray(turn.queries) && turn.queries.length >= 1)
  for (const query of turn.queries) {
    same(query.request.context, turn.context, 'query request context changed'); assert.equal(query.result.ok, true, 'Actual query failed')
    same(query.result.value.context, turn.context, 'query result context changed'); assert.equal(query.result.value.kind, query.request.query.kind)
    // Camera creation is advertised by the production recipe tool; validate a
    // project capability query if present without prescribing an extra round.
    if (query.result.value.kind === 'project') assert.ok(query.result.value.items.some((row) => row.kind === 'project' && row.id === turn.context.projectId && Array.isArray(row.capabilities) && row.capabilities.includes('create-camera')), 'Invalid optional create-camera capability query')
  }
  const sceneRows = turn.queries.filter((query) => query.result.value.kind === 'scenes').flatMap((query) => query.result.value.items)
  assert.ok(sceneRows.some((row) => row.kind === 'scene' && row.id === turn.context.activeSceneId && row.isActive === true), 'Actual captured active scene query missing')
  same(turn.preview.request.proposal, proposal, 'preview is not the actual returned proposal'); assert.equal(turn.preview.result.ok, true)
  const preview = turn.preview.result.value
  assert.match(preview.authority, /^apply_[a-f0-9]{48}$/); assert.equal(preview.batch.origin, 'ai')
  assert.equal(preview.batch.projectId, turn.context.projectId); assert.equal(preview.batch.baseRevision, turn.context.baseRevision)
  assert.equal(preview.batch.commands.length, 1); assert.ok(Buffer.byteLength(stable(preview.batch)) <= 16384)
  state(turn.before); state(turn.after); assert.equal(turn.before.snapshot.project.revision, turn.context.baseRevision)
  assert.equal(turn.after.history.undo, turn.before.history.undo + 1); assert.equal(turn.after.history.redo, 0)
  same(preview.result.inverse, { kind: 'world-snapshot', snapshot: turn.before.snapshot }, 'preview inverse changed')
  assert.equal(preview.result.snapshot.project.revision, turn.context.baseRevision + 1); assert.ok(preview.details.length > 0)
  same(preview.result.warnings, [], 'host warnings require explicit policy')
  assert.equal(turn.settledUi?.expanded, true); assert.equal(turn.settledUi.busy, false); assert.equal(turn.settledUi.status, 'Saved')
  same(turn.settledUi.manualControls, { apply: 0, reject: 0 }, 'manual proposal controls became visible')
  assert.equal(turn.settledUi.applyEnabled, false); assert.equal(turn.settledUi.rejectEnabled, false)
  same(turn.settledUi.details, [], 'manual review details became visible'); same(turn.settledUi.warnings, [], 'manual review warnings became visible')
  same(turn.manualDecisionInputs, [], 'manual Apply/Reject input is forbidden')
  const before = turn.before.snapshot, candidate = preview.result.snapshot
  const beforeEntityIds = new Set(before.scenes.flatMap((scene) => scene.entities.map((entity) => entity.id)))
  const added = candidate.scenes.flatMap((scene) => scene.entities.filter((entity) => !beforeEntityIds.has(entity.id)).map((entity) => ({ sceneId: scene.sceneId, entity })))
  assert.equal(added.length, 1, 'Canonical candidate must add exactly one entity')
  assert.equal(added[0].sceneId, turn.context.activeSceneId)
  const camera = added[0].entity
  assert.ok(typeof camera.id === 'string' && camera.id.length > 0 && camera.id.length <= 256)
  assert.equal(camera.name, 'AI Probe Camera'); assert.equal(camera.parentId, null); assert.equal(camera.enabled, true); assert.equal(camera.locked, false); same(camera.tags, [], 'camera tags changed')
  same(camera.transform, { position: [0, 2, 5], rotation: [0, 0, 0], scale: [1, 1, 1] }, 'camera transform changed')
  assert.equal(camera.components.length, 1, 'Camera entity contains unrelated components')
  const component = camera.components[0], activeBefore = before.scenes.find((scene) => scene.sceneId === turn.context.activeSceneId)
  const expectedPrimary = !activeBefore.entities.some((entity) => entity.components.some((value) => value.type === 'camera' && value.primary))
  assert.ok(typeof component.id === 'string' && component.id.length > 0 && component.id.length <= 256 && component.id !== camera.id)
  same(component, { id: component.id, type: 'camera', enabled: true, projection: 'perspective', primary: expectedPrimary, near: 0.1, far: 1000, fieldOfView: 60 }, 'camera component/defaults changed')
  const allIds = candidate.scenes.flatMap((scene) => scene.entities.flatMap((entity) => [entity.id, ...entity.components.map((value) => value.id)]))
  assert.equal(new Set(allIds).size, allIds.length, 'Canonical entity/component IDs are not unique')
  const expected = structuredClone(before); expected.project.revision++
  expected.scenes.find((scene) => scene.sceneId === turn.context.activeSceneId).entities.push(structuredClone(camera))
  same(candidate, expected, 'camera proposal changed unrelated canonical owners')
  const command = preview.batch.commands[0]; assert.equal(command.type, 'add-entity'); assert.equal(command.sceneId, turn.context.activeSceneId); same(command.entity, camera, 'compiled camera differs from candidate')
  same(turn.after.snapshot, candidate, 'settled document differs from canonical candidate')
  const call = turn.invocation
  assert.equal(call.request.projectKey, turn.context.projectKey); same(call.request.batch, preview.batch, 'auto-apply payload differs from exact host preview')
  same(call.request.aiAuthority, { token: preview.authority, context: turn.context }, 'auto-apply capability/context changed')
  assert.ok(call.forwardedAt && call.settledAt); assert.equal(call.result.ok, true); assert.equal(call.result.value.idempotent, false)
  same(call.result.value.snapshot, candidate, 'auto-apply differs from exact canonical candidate'); same(call.result.value.inverse, preview.result.inverse, 'auto-apply inverse changed')
  assert.equal(call.result.value.newRevision, turn.context.baseRevision + 1); assert.equal(call.result.value.receipt.transactionId, preview.batch.transactionId)
  assert.equal(call.result.value.receipt.payloadSha256, digest(stable(preview.batch)), 'Canonical payload receipt changed')
  assert.equal(turn.stored?.verified, true); assert.equal(turn.stored.transactionId, preview.batch.transactionId)
  same(turn.stored.snapshot, candidate, 'stored canonical snapshot changed'); same(turn.stored.inverse, preview.result.inverse, 'stored inverse changed')
  for (const [event, base, revision, label] of [[a.undo, before, turn.context.baseRevision + 2, 'Undo'], [a.redo, candidate, turn.context.baseRevision + 3, 'Redo']]) {
    assert.equal(event?.kind, label); nativeButtonInput(event.input, label); assert.equal(event.result.ok, true); assert.equal(event.result.value.idempotent, false); assert.equal(event.stored?.verified, true)
    assert.ok(typeof event.result.value.receipt?.transactionId === 'string' && event.result.value.receipt.transactionId.length > 0, `${label} result transaction receipt missing`)
    assert.ok(event.result.value.inverse && typeof event.result.value.inverse === 'object', `${label} result inverse missing`)
    assert.equal(event.stored.transactionId, event.result.value.receipt.transactionId, `${label} stored transaction differs`)
    same(event.stored.snapshot, event.result.value.snapshot, `${label} stored snapshot differs`); same(event.stored.inverse, event.result.value.inverse, `${label} stored inverse differs`)
    const expectedHistory = structuredClone(base); expectedHistory.project.revision = revision
    same(event.result.value.snapshot, expectedHistory, `${label} document differs`); assert.equal(event.result.value.newRevision, revision)
  }
  assert.ok(a.undo.input.sequence < a.redo.input.sequence, 'Undo/Redo native order changed')
  const reopened = a.reopened
  assert.equal(reopened.sceneId, turn.context.activeSceneId); assert.equal(reopened.entityId, camera.id)
  assert.ok(reopened.oldBootId && reopened.bootId && reopened.oldBootId !== reopened.bootId, 'Actual fresh renderer generation missing')
  assert.equal(reopened.canonicalDiskMatches, true); same(reopened.snapshot, a.redo.result.value.snapshot, 'Fresh canonical disk/renderer differs')
  assert.equal(reopened.selectionActive, camera.id); assert.equal(reopened.inspectorName, camera.name)
  assert.equal(reopened.selectionInput?.trusted, true); assert.equal(reopened.selectionInput.target, `SPAN:${camera.name}`); assert.equal(reopened.selectionInput.hitMatches, true)
  assert.ok(reopened.selectionInput.hover?.matchCount === 1 && reopened.selectionInput.hover.enabled === true && reopened.selectionInput.hover.visible === true && reopened.selectionInput.hover.hitMatches === true)
  same(reopened.selectionInput.point, reopened.selectionInput.hover.point, 'Camera tree selection point changed after hover')
  const fields = new Map(reopened.inspectorValues.map((field) => [field.label, field]))
  for (const [label, value] of [['Position:X', 0], ['Position:Y', 2], ['Position:Z', 5], ['Rotation:X', 0], ['Rotation:Y', 0], ['Rotation:Z', 0], ['Scale:X', 1], ['Scale:Y', 1], ['Scale:Z', 1], ['Camera:Near', 0.1], ['Camera:Far', 1000], ['Camera:Field of view', 60]]) {
    const field = fields.get(label); assert.ok(field, `Fresh camera Inspector missing ${label}`); assert.equal(field.disabled, false); assert.equal(Number(field.value), value)
  }
  assert.ok(reopened.screenshot?.bytes > 0 && reopened.screenshot.filename.endsWith('.png')); assert.match(reopened.screenshot.sha256, /^[a-f0-9]{64}$/)
}

export function assertActualWorldSculptNavigationTerminal(result) {
  assert.equal(result?.status, 'PASS', 'WorldSculpt navigation requires an evidence PASS')
  assert.deepEqual(result.errors, [], 'WorldSculpt navigation retained runtime or cleanup failures')
  const requiredChecks = ['native-worldsculpt-library-add', 'native-inspect-orbit', 'native-fly-pointer-lock', 'native-run-ground-only', 'native-navigation-document-isolation']
  for (const name of requiredChecks) assert.equal(result.checks?.filter((check) => check?.name === name && check.status === 'PASS').length, 1, `WorldSculpt navigation check missing: ${name}`)
  const evidence = result.evidence?.worldSculptNavigation
  assert.equal(evidence?.schema, 'modly.worldsculpt-navigation-acceptance.v1')
  assert.equal(evidence.phase, 'complete')
  const source = evidence.source
  assert.ok(Number.isSafeInteger(source?.bytes) && source.bytes >= 12)
  for (const field of ['sourceSha256', 'bundledSha256', 'workspaceSha256', 'servedSha256']) assert.match(source?.[field], /^[a-f0-9]{64}$/)
  assert.equal(source.sourceSha256, source.bundledSha256); assert.equal(source.sourceSha256, source.workspaceSha256); assert.equal(source.sourceSha256, source.servedSha256)
  assert.ok(Array.isArray(evidence.inputTrace) && evidence.inputTrace.length > 0 && evidence.inputTrace.length <= 4096)
  assert.ok(evidence.inputTrace.every((event) => event?.trusted === true), 'Only trusted native navigation input is accepted')
  assert.ok(evidence.inputTrace.some((event) => event.type === 'pointermove' && (event.movementX !== 0 || event.movementY !== 0)), 'Native relative pointer motion missing')
  for (const code of ['KeyW', 'Digit3']) assert.ok(evidence.inputTrace.some((event) => event.type === 'keydown' && event.code === code), `Native ${code} evidence missing`)
  assert.ok(Number.isSafeInteger(evidence.pointerLock?.changes) && evidence.pointerLock.changes >= 2)
  assert.equal(evidence.pointerLock.errors, 0); assert.equal(evidence.pointerLock.acquired, true)
  assert.equal(evidence.pointerLock.retainedFlyToRun, true); assert.equal(evidence.pointerLock.released, true)
  assert.equal(evidence.graphics?.contextLost, false)
  assert.ok(Array.isArray(evidence.graphics.drawingBuffer) && evidence.graphics.drawingBuffer.length === 2 && evidence.graphics.drawingBuffer.every((value) => Number.isSafeInteger(value) && value > 0))
  const renderer = typeof evidence.graphics.renderer === 'string' ? evidence.graphics.renderer.trim() : ''
  const unmaskedRenderer = typeof evidence.graphics.unmaskedRenderer === 'string' ? evidence.graphics.unmaskedRenderer.trim() : ''
  const rendererEvidence = `${renderer} ${unmaskedRenderer}`
  assert.ok(renderer, 'Native WebGL renderer evidence required')
  assert.ok(unmaskedRenderer, 'Positive unmasked hardware GPU identity required')
  assert.ok(!/(?:swiftshader|llvmpipe|softpipe|lavapipe|software(?: rasterizer)?|microsoft basic render|mesa offscreen|osmesa|virtualbox|virgl)/i.test(rendererEvidence), 'Software renderer evidence is not hardware GPU proof')
  assert.match(unmaskedRenderer, /\b(?:nvidia|geforce|quadro|tesla|amd|radeon|intel|apple|adreno|mali|powervr|tegra|vivante|videocore|qualcomm|imagination)\b/i, 'Recognized unmasked hardware GPU identity required')
  assert.deepEqual(evidence.isolation, { canonicalUnchangedDuringNavigation: true, applyCountUnchanged: true, historyUnchanged: true, freshReopenMatched: true, observationCapabilityImmutable: true })
  assert.deepEqual(evidence.run, { groundOnlyFallback: true, colliderBacked: false, yPinned: true, horizontalMoved: true, rollZero: true })
  assert.deepEqual(evidence.screenshots, ['12-worldsculpt-inspect-framed.png', '13-worldsculpt-inspect-orbit.png', '14-worldsculpt-fly-locked.png', '15-worldsculpt-run-ground-only.png', '16-worldsculpt-restored-inspect.png'])
  assertActualColliderRunTerminal(result.evidence?.colliderRun)
  for (const name of ['native-collider-authoring', 'native-collider-ground-wall-slide', 'native-collider-jump-handoff', 'native-collider-reopen']) assert.equal(result.checks?.filter((check) => check?.name === name && check.status === 'PASS').length, 1, `Collider Run check missing: ${name}`)
}


export function assertActualColliderRunTerminal(evidence) {
  assert.equal(evidence?.schema, 'modly.collider-run-acceptance.v1', 'Collider Run evidence is required')
  assert.deepEqual(Object.keys(evidence).sort(), ['schema', 'grounding', 'sceneId', 'floorId', 'wallId', 'authoring', 'beforeAuthoring', 'baseline', 'canonicalSha256', 'geometry', 'observed', 'samples', 'inputTrace', 'reservedEscape', 'screenshots', 'reopened'].sort())
  assert.equal(evidence.grounding, 'geometric-native-observation')
  const finite = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite)
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const { baseline, sceneId, floorId, wallId, geometry, observed, samples, inputTrace, reopened } = evidence
  assert.notEqual(floorId, wallId); assert.equal(typeof sceneId, 'string')
  assert.equal(evidence.canonicalSha256, digest(baseline), 'Canonical baseline digest mismatch')
  assert.ok(Number.isSafeInteger(baseline.applyCount) && baseline.applyCount > 0)
  assert.ok(Array.isArray(baseline.undoStack) && Array.isArray(baseline.redoStack) && Array.isArray(baseline.receipts))
  assert.ok(Array.isArray(evidence.authoring) && evidence.authoring.length >= 7 && evidence.authoring.length <= 20)
  let prior = structuredClone(evidence.beforeAuthoring)
  const authoredCommands = []
  for (const entry of evidence.authoring) {
    assert.ok(entry.forwardedAt && entry.settledAt && entry.result?.ok)
    const batch = entry.request.batch, result = entry.result.value
    assert.equal(batch.origin, 'ui'); assert.equal(batch.projectId, prior.project.projectId); assert.equal(batch.baseRevision, prior.project.revision)
    assert.deepEqual(result.inverse, { kind: 'world-snapshot', snapshot: prior }); assert.equal(result.idempotent, false); assert.deepEqual(result.warnings, [])
    assert.equal(batch.commands.length, 1)
    const command = batch.commands[0]; authoredCommands.push(command)
    if (command.type === 'add-scene') {
      assert.equal(authoredCommands.length, 1); assert.equal(command.scene.sceneId, sceneId); assert.equal(command.reference.id, sceneId)
      assert.deepEqual(command.scene.entities, []); prior.scenes.push(structuredClone(command.scene)); prior.project.scenes.push(structuredClone(command.reference))
    } else {
      assert.equal(command.sceneId, sceneId)
      const scene = prior.scenes.find((scene) => scene.sceneId === sceneId); assert.ok(scene)
      if (command.type === 'add-entity') { assert.ok([floorId, wallId].includes(command.entity.id)); scene.entities.push(structuredClone(command.entity)) }
      else {
        const entity = scene.entities.find((entity) => entity.id === command.entityId); assert.ok(entity)
        if (command.type === 'add-component') entity.components.push(structuredClone(command.component))
        else { assert.equal(command.type, 'patch-entity'); assert.deepEqual(Object.keys(command.patch), ['transform']); entity.transform = structuredClone(command.patch.transform) }
      }
    }
    prior.project.revision++; assert.equal(result.newRevision, prior.project.revision); assert.deepEqual(result.snapshot, prior)
  }
  assert.deepEqual(prior, baseline.snapshot, 'Authoring receipts do not produce navigation baseline')
  const scene = baseline.snapshot.scenes.find((scene) => scene.sceneId === sceneId)
  assert.ok(scene && scene.entities.length === 2)
  assert.equal(geometry.length, 2); assert.equal(observed.length, 2)
  for (const id of [floorId, wallId]) {
    const entity = scene.entities.find((entity) => entity.id === id), mesh = geometry.filter((item) => item.entityId === id), visible = observed.filter((item) => item.entityId === id)
    assert.ok(entity?.enabled && !entity.parentId); assert.equal(mesh.length, 1); assert.equal(visible.length, 1)
    const body = entity.components.filter((item) => item.type === 'rigid-body'), colliders = entity.components.filter((item) => item.type === 'collider'), renderables = entity.components.filter((item) => item.type === 'renderable')
    assert.equal(body.length, 1); assert.equal(body[0].bodyType, 'fixed'); assert.equal(body[0].enabled, true)
    assert.equal(colliders.length, 1); assert.equal(colliders[0].shape, 'mesh'); assert.equal(colliders[0].enabled, true); assert.equal(colliders[0].sensor, false); assert.equal(colliders[0].purpose, 'simulation')
    assert.equal(renderables.length, 1); assert.equal(renderables[0].visible, true); assert.equal(renderables[0].enabled, true)
    assert.equal(colliders[0].resourceId, renderables[0].resourceId); assert.equal(mesh[0].resourceId, colliders[0].resourceId); assert.equal(mesh[0].componentId, colliders[0].id)
    const resource = baseline.snapshot.project.resources.find((item) => item.id === colliders[0].resourceId)
    assert.equal(resource?.workspacePath, 'Exports/AuthoringFixtures/red-cube.glb'); assert.equal(resource.format, 'glb')
    assert.deepEqual(entity.transform, id === floorId ? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [30, 0.5, 30] } : { position: [0, 0.35, -2], rotation: [0, 0, 0], scale: [16, 8, 1] })
    assert.deepEqual(visible[0].transform, entity.transform); assert.equal(mesh[0].vertices, 36); assert.equal(mesh[0].triangles, 12)
    for (const key of ['min', 'max']) {
      assert.ok(finite(mesh[0][key], 3) && finite(visible[0][key], 3))
      const local = key === 'min' ? [-0.35, 0, -0.35] : [0.35, 0.7, 0.35]
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(mesh[0][key][axis] - visible[0][key][axis]) < 1e-5, 'Visible/collider bounds mismatch')
        assert.ok(Math.abs(mesh[0][key][axis] - (entity.transform.position[axis] + local[axis] * entity.transform.scale[axis])) < 1e-5, 'Geometry/transform mismatch')
      }
    }
    const components = authoredCommands.filter((command) => command.type === 'add-component' && command.entityId === id)
    assert.deepEqual(components.map((command) => command.component.type), ['collider', 'rigid-body'])
  }
  assert.ok(Array.isArray(inputTrace) && inputTrace.length > 0 && inputTrace.length <= 4096)
  for (const [index, event] of inputTrace.entries()) {
    assert.equal(event.trusted, true); assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > 0 && Number.isFinite(Date.parse(event.at)))
    if (index) { assert.ok(event.sequence === inputTrace[index - 1].sequence + 1); assert.ok(Date.parse(event.at) >= Date.parse(inputTrace[index - 1].at)) }
  }
  assert.ok(inputTrace.some((event) => event.type === 'pointermove' && Number.isFinite(event.movementX) && Number.isFinite(event.movementY) && Math.hypot(event.movementX, event.movementY) > 0))
  const phases = ['staging', 'descent', 'ground', 'approach', 'contact', 'slide', 'jump', 'runExit', 'flyEnter', 'flyMove', 'inspect']
  assert.ok(Array.isArray(samples) && samples.length >= 25 && samples.length <= 260)
  for (const [index, sample] of samples.entries()) {
    assert.deepEqual(Object.keys(sample).sort(), ['phase', 'at', 'bootId', 'frame', 'traceSequence', 'position', 'quaternion', 'status', 'groundOnly', 'locked', 'lockChanges', 'lockErrors', 'orbit', 'canonicalSha256', 'applyCount'].sort())
    assert.ok(phases.includes(sample.phase) && finite(sample.position, 3) && finite(sample.quaternion, 4)); assert.ok(Math.abs(Math.hypot(...sample.quaternion) - 1) < 1e-5)
    assert.ok(Number.isSafeInteger(sample.frame) && sample.frame > 0 && Number.isFinite(Date.parse(sample.at)) && typeof sample.bootId === 'string' && sample.bootId.length > 0)
    assert.equal(sample.canonicalSha256, evidence.canonicalSha256); assert.equal(sample.applyCount, baseline.applyCount)
    assert.equal(sample.groundOnly, false); assert.equal(sample.lockErrors, 0)
    assert.ok(Number.isSafeInteger(sample.traceSequence) && inputTrace.some((event) => event.sequence === sample.traceSequence && Date.parse(event.at) <= Date.parse(sample.at)))
    assert.ok(Number.isSafeInteger(sample.lockChanges) && sample.lockChanges > 0)
    const inspect = sample.phase === 'inspect', fly = ['staging', 'flyEnter', 'flyMove'].includes(sample.phase)
    assert.equal(sample.status, inspect ? 'Inspect mode. Orbit, pan, select, and edit.' : fly ? 'Fly mode. Pointer locked.' : 'Run mode. Collider-backed.')
    assert.equal(sample.locked, !inspect); assert.equal(sample.orbit, inspect)
    if (index) {
      const previous = samples[index - 1]
      assert.equal(sample.bootId, previous.bootId); assert.ok(sample.frame > previous.frame && Date.parse(sample.at) > Date.parse(previous.at)); assert.ok(sample.traceSequence >= previous.traceSequence)
      assert.ok(phases.indexOf(sample.phase) >= phases.indexOf(previous.phase))
      assert.equal(sample.lockChanges, previous.lockChanges + (inspect ? 1 : 0), 'Navigation lost/reacquired authoritative lock')
    }
  }
  const phase = (name, minimum = 1) => { const values = samples.filter((sample) => sample.phase === name); assert.ok(values.length >= minimum, `Missing ${name} poses`); return values }
  const eventsDuring = (name) => {
    const values = phase(name), first = samples.indexOf(values[0]), start = first ? samples[first - 1].traceSequence : 0
    return inputTrace.filter((event) => event.sequence > start && event.sequence <= values.at(-1).traceSequence)
  }
  for (const [name, codes] of [['descent', ['Digit3']], ['contact', ['KeyW']], ['slide', ['KeyW', 'KeyD']], ['jump', ['Space']], ['flyEnter', ['Digit2']], ['flyMove', ['KeyW']]]) {
    const events = eventsDuring(name)
    for (const code of codes) for (const type of ['keydown', 'keyup']) assert.ok(events.some((event) => event.type === type && event.code === code), `Missing native ${name} ${code} ${type}`)
  }
  // Reserved Escape is consumed before DOM delivery in the pinned browser. DISPATCH is not ingress.
  const escape = evidence.reservedEscape, flyBeforeEscape = phase('flyMove').at(-1), inspectAfterEscape = phase('inspect')[0]
  const exact = (value, keys) => { assert.ok(value && typeof value === 'object'); assert.deepEqual(Object.keys(value).sort(), keys.split(' ').sort()) }
  const instant = (value) => { const time = Date.parse(value); assert.ok(typeof value === 'string' && Number.isFinite(time)); return time }
  exact(escape, 'schema attemptId generation webContentsId keyboardLock before dispatches browserKeyUps mouseObservation browserMouse domEvents unlocked interference listenersRemoved')
  assert.equal(escape.schema, 'modly.browser-reserved-escape.v1')
  assert.ok(Number.isSafeInteger(escape.generation) && escape.generation > 0 && Number.isSafeInteger(escape.webContentsId) && escape.webContentsId > 0)
  assert.equal(escape.attemptId, `reserved-escape:${escape.generation}:${escape.webContentsId}`)
  assert.equal(escape.keyboardLock, 'denied-by-owned-session-policy'); assert.deepEqual(escape.interference, []); assert.equal(escape.listenersRemoved, true)
  for (const state of [escape.before, escape.unlocked]) {
    exact(state, 'at bootId canvasUuid frame traceSequence position quaternion locked lockChanges lockErrors focused fullscreen heldKeys canonicalSha256 applyCount')
    instant(state.at); assert.equal(state.bootId, flyBeforeEscape.bootId); assert.ok(typeof state.canvasUuid === 'string' && state.canvasUuid.length > 0)
    assert.ok(Number.isSafeInteger(state.frame) && state.frame >= flyBeforeEscape.frame && Number.isSafeInteger(state.traceSequence))
    assert.ok(finite(state.position, 3) && finite(state.quaternion, 4)); assert.ok(Math.abs(Math.hypot(...state.quaternion) - 1) < 1e-5)
    assert.equal(state.focused, true); assert.equal(state.fullscreen, false); assert.deepEqual(state.heldKeys, [])
    assert.equal(state.canonicalSha256, evidence.canonicalSha256); assert.equal(state.applyCount, baseline.applyCount)
    assert.equal(state.lockErrors, flyBeforeEscape.lockErrors)
  }
  const {before, unlocked} = escape
  assert.equal(before.traceSequence, flyBeforeEscape.traceSequence)
  const lastMouseBefore = [...inputTrace].reverse().find((event) => event.sequence <= before.traceSequence && typeof event.buttons === 'number')
  if (lastMouseBefore) assert.equal(lastMouseBefore.buttons, 0)
  assert.equal(before.locked, true); assert.equal(unlocked.locked, false); assert.equal(before.lockChanges, flyBeforeEscape.lockChanges)
  assert.equal(unlocked.lockChanges, before.lockChanges + 1); assert.equal(unlocked.canvasUuid, before.canvasUuid); assert.ok(unlocked.frame > before.frame)
  assert.ok(instant(before.at) >= instant(flyBeforeEscape.at) && instant(unlocked.at) > instant(before.at) && instant(unlocked.at) - instant(before.at) <= 4000)
  assert.ok(Array.isArray(escape.dispatches) && escape.dispatches.length === 2)
  for (const [index, dispatch] of escape.dispatches.entries()) {
    exact(dispatch, 'kind startedAt returnedAt payload'); assert.equal(dispatch.kind, 'DISPATCH')
    assert.deepEqual(dispatch.payload, {type: index ? 'keyUp' : 'keyDown', keyCode: 'Escape', modifiers: []})
    assert.ok(instant(dispatch.startedAt) >= instant(index ? escape.dispatches[0].returnedAt : before.at))
    assert.ok(instant(dispatch.returnedAt) >= instant(dispatch.startedAt) && instant(dispatch.returnedAt) <= instant(unlocked.at))
  }
  assert.ok(Array.isArray(escape.browserKeyUps) && escape.browserKeyUps.length === 1, 'Exactly one browser Escape KeyUp ingress is required')
  const ingress = escape.browserKeyUps[0]
  exact(ingress, 'at attemptId generation webContentsId input')
  for (const field of ['attemptId', 'generation', 'webContentsId']) assert.equal(ingress[field], escape[field])
  assert.deepEqual(ingress.input, {type: 'keyUp', key: 'Escape', code: 'Escape', isAutoRepeat: false, isComposing: false, shift: false, control: false, alt: false, meta: false, modifiers: []})
  assert.ok(instant(ingress.at) >= instant(escape.dispatches[1].startedAt) && instant(ingress.at) <= instant(unlocked.at))
  // Bounded public-field correlation, not synthetic/physical provenance. Restore can precede KeyUp.
  assert.equal(escape.mouseObservation, 'bounded-restoration-compatible-not-origin-proof')
  assert.ok(Array.isArray(escape.browserMouse) && escape.browserMouse.length <= 2 && Array.isArray(escape.domEvents))
  assert.equal(escape.domEvents.length, escape.browserMouse.length * 2)
  assert.equal(unlocked.traceSequence, before.traceSequence + escape.domEvents.length)
  assert.deepEqual(escape.domEvents, inputTrace.filter((event) => event.sequence > before.traceSequence && event.sequence <= unlocked.traceSequence), 'Full observed unlock slice must be retained')
  const downAt = instant(escape.dispatches[0].startedAt)
  for (const [index, mouse] of escape.browserMouse.entries()) {
    exact(mouse, 'at sequence phase attemptId generation webContentsId input')
    assert.equal(mouse.sequence, index + 1)
    for (const field of ['attemptId','generation','webContentsId']) assert.equal(mouse[field], escape[field])
    assert.ok(['keyDown','keyUp','await-release'].includes(mouse.phase))
    const at = instant(mouse.at)
    assert.ok(at >= downAt && at - downAt <= 250 && at <= instant(unlocked.at))
    if (mouse.phase === 'keyDown') assert.ok(at <= instant(escape.dispatches[0].returnedAt))
    if (mouse.phase === 'keyUp') assert.ok(at >= instant(escape.dispatches[1].startedAt) && at <= instant(escape.dispatches[1].returnedAt))
    if (mouse.phase === 'await-release') assert.ok(at >= instant(escape.dispatches[1].returnedAt))
    if (index) assert.ok(at >= instant(escape.browserMouse[index - 1].at))
    exact(mouse.input, 'type clickCount movementX movementY button globalX globalY x y')
    assert.equal(mouse.input.type, 'mouseMove'); assert.equal(mouse.input.button, 'none'); assert.equal(mouse.input.clickCount, 0)
    assert.equal(mouse.input.movementX, 0); assert.equal(mouse.input.movementY, 0)
    for (const field of ['globalX','globalY','x','y']) assert.ok(Number.isFinite(mouse.input[field]))
    assert.deepEqual(mouse.input, escape.browserMouse[0].input)
    for (let offset = 0; offset < 2; offset++) {
      const event = escape.domEvents[index * 2 + offset]
      exact(event, 'sequence at type trusted screenX screenY x y buttons movementX movementY code canvasUuid frame target')
      assert.equal(event.sequence, before.traceSequence + index * 2 + offset + 1); assert.equal(event.type, offset ? 'mousemove' : 'pointermove')
      assert.equal(event.trusted, true); assert.equal(event.buttons, 0); assert.equal(event.code, null)
      assert.equal(event.movementX, 0); assert.equal(event.movementY, 0)
      assert.equal(event.canvasUuid, before.canvasUuid); assert.ok(event.target.startsWith('CANVAS:'))
      assert.ok(Number.isSafeInteger(event.frame) && event.frame >= before.frame && event.frame <= unlocked.frame)
      assert.ok(instant(event.at) >= at && instant(event.at) - downAt <= 250 && instant(event.at) <= instant(unlocked.at))
      assert.deepEqual([event.screenX,event.screenY,event.x,event.y], [mouse.input.globalX,mouse.input.globalY,mouse.input.x,mouse.input.y])
    }
  }
  const frameClicks = eventsDuring('inspect').filter((event) => event.type === 'click' && event.target === 'BUTTON:Frame scene')
  assert.equal(frameClicks.length, 1, 'Trusted Frame scene click must follow the independently observed unlock')
  assert.ok(frameClicks[0].sequence > unlocked.traceSequence && instant(frameClicks[0].at) >= instant(unlocked.at))
  for (const event of inputTrace.filter((event) => event.sequence > unlocked.traceSequence && event.sequence <= inspectAfterEscape.traceSequence)) {
    assert.ok(instant(event.at) >= instant(unlocked.at), 'No pre-unlock Frame scene input')
    assert.equal(event.target, 'BUTTON:Frame scene', 'No unclassified post-unlock input')
    assert.ok(['pointermove','mousemove','pointerdown','pointerup','click'].includes(event.type))
  }
  assert.ok(inspectAfterEscape.frame > unlocked.frame && instant(inspectAfterEscape.at) >= instant(frameClicks[0].at))
  assert.equal(inspectAfterEscape.lockChanges, unlocked.lockChanges)
  const held = new Set(); let diagonal = false
  for (const event of eventsDuring('slide')) {
    if (event.type === 'keydown') held.add(event.code)
    if (event.type === 'keyup') held.delete(event.code)
    if (held.has('KeyW') && held.has('KeyD')) diagonal = true
  }
  assert.ok(diagonal && held.size === 0, 'Slide requires overlapping native forward/right input and complete releases')
  const floor = geometry.find((item) => item.entityId === floorId), wall = geometry.find((item) => item.entityId === wallId), eyeY = floor.max[1] + 1.65
  const grounded = (sample) => assert.ok(Math.abs(sample.position[1] - eyeY) <= 0.04, 'Geometric grounding is outside contact tolerance')
  const separated = (sample) => { assert.ok(sample.position[2] >= wall.max[2] + 0.29 && sample.position[2] <= wall.max[2] + 0.36, 'Wall stop separation invalid'); assert.ok(Math.abs(sample.position[0]) < wall.max[0] - 0.4, 'Not beside the visible wall') }
  const staging = phase('staging').at(-1), descent = phase('descent', 2), ground = phase('ground', 4), approach = phase('approach', 2), contact = phase('contact', 3), slide = phase('slide', 3), jump = phase('jump', 8)
  assert.ok(staging.position[1] > eyeY + 1 && descent[0].position[1] > eyeY + 0.2 && descent.some((sample, index) => index > 0 && sample.position[1] < descent[index - 1].position[1] - 0.02), 'Actual descent is absent')
  for (const sample of [...ground, ...approach, ...contact, ...slide]) grounded(sample)
  for (const sample of samples.filter((sample) => !['staging', 'flyEnter', 'flyMove', 'inspect'].includes(sample.phase))) {
    assert.ok(sample.position[0] > floor.min[0] + 0.3 && sample.position[0] < floor.max[0] - 0.3 && sample.position[2] > floor.min[2] + 0.3 && sample.position[2] < floor.max[2] - 0.3)
    assert.ok(sample.position[2] >= wall.max[2] + 0.29, 'Run penetrated the visible wall')
  }
  assert.ok(ground.at(-1).position[2] - contact[0].position[2] > 1 && approach[0].position[2] - approach.at(-1).position[2] > 0.2, 'No wall approach')
  for (const sample of [...contact, ...slide, ...jump]) separated(sample)
  assert.ok(Math.max(...contact.map((sample) => sample.position[2])) - Math.min(...contact.map((sample) => sample.position[2])) < 0.03, 'Wall contact never stabilized')
  assert.ok(slide.at(-1).position[0] - contact.at(-1).position[0] > 0.5, 'No tangential wall slide')
  grounded(jump[0]); const peak = jump.reduce((best, sample, index) => sample.position[1] > jump[best].position[1] ? index : best, 0)
  assert.ok(peak > 0 && peak < jump.length - 3 && jump[peak].position[1] > eyeY + 0.45, 'Jump rise/apex absent')
  assert.ok(jump.slice(peak + 1).some((sample, index) => sample.position[1] < jump[peak + index].position[1] - 0.02), 'Jump descent absent')
  jump.slice(-3).forEach(grounded)
  const exit = phase('runExit')[0], enter = phase('flyEnter')[0], moved = phase('flyMove')[0]
  assert.ok(Math.hypot(...exit.position.map((value, axis) => value - enter.position[axis])) <= 0.02 && Math.hypot(...exit.quaternion.map((value, axis) => value - enter.quaternion[axis])) <= 0.01, 'Run/Fly pose discontinuity')
  assert.ok(moved.position[2] < wall.min[2] - 0.1 && enter.position[2] - moved.position[2] > 0.8, 'Fly did not freely cross the stopped wall')
  phase('inspect'); assert.ok(typeof reopened.bootId === 'string' && reopened.bootId.length > 0 && reopened.bootId !== samples[0].bootId)
  assert.deepEqual(reopened.snapshot, baseline.snapshot); assert.equal(reopened.applyCount, baseline.applyCount); assert.deepEqual(reopened.geometry, geometry)
  assert.deepEqual(reopened.observed, observed.map(({ entityId, transform }) => ({ entityId, transform })))
  assert.deepEqual(evidence.screenshots.map((shot) => shot.filename), ['17-collider-authored-inspect.png', '18-collider-wall-contact.png', '19-collider-jump-landed.png', '20-collider-restored-inspect.png'])
  for (const shot of evidence.screenshots) { assert.ok(Number.isSafeInteger(shot.bytes) && shot.bytes > 32); assert.match(shot.sha256, /^[a-f0-9]{64}$/) }
}

export async function verifyActualColliderScreenshots(evidence, directory) {
  for (const shot of evidence.screenshots) {
    assert.match(shot.filename, /^(?:17-collider-authored-inspect|18-collider-wall-contact|19-collider-jump-landed|20-collider-restored-inspect)\.png$/)
    const file = path.join(directory, shot.filename), info = await lstat(file)
    assert.ok(info.isFile() && !info.isSymbolicLink()); assert.equal(await realpath(file), file)
    const bytes = await readFile(file)
    assert.equal(bytes.length, shot.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), shot.sha256)
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const checkpoint = JSON.parse(await readFile(file.replace(/\.png$/, '.json'), 'utf8'))
    assert.equal(checkpoint.screenshot.sha256, shot.sha256); assert.equal(checkpoint.screenshot.bytes, shot.bytes)
    assert.equal(checkpoint.screenshot.width, bytes.readUInt32BE(16)); assert.equal(checkpoint.screenshot.height, bytes.readUInt32BE(20))
    assert.ok(checkpoint.screenshot.width > 0 && checkpoint.screenshot.height > 0)
    assert.deepEqual(checkpoint.view.editor.session.snapshot, evidence.baseline.snapshot)
    assert.deepEqual(checkpoint.freshRepository.value.snapshot, evidence.baseline.snapshot)
    assert.equal(checkpoint.commandEnvelopes.length, evidence.baseline.applyCount)
    assert.equal(checkpoint.view.bootId, shot.filename.startsWith('20-') ? evidence.reopened.bootId : evidence.samples[0].bootId)
  }
}

export function installOwnedFatalGate(entry, interrupt, limit) {
  let fatalQueued = false, interrupted = false, disposed = false, pending = Buffer.alloc(0)
  const cleanups = [], pipes = [], openPipes = new Set(['stdout', 'stderr'])
  entry.logErrors = []; entry.logErrorOverflow = 0
  const retain = (operation, error, details = {}) => {
    if (entry.logErrors.length < 64) entry.logErrors.push({ operation, error: String(error).slice(0, 2048), ...details })
    else entry.logErrorOverflow++
  }
  const fail = (message) => {
    if (interrupted) return
    interrupted = true
    try { interrupt(message) } catch (error) { retain('interrupt', error) }
  }
  const enqueue = (operation, task) => {
    // Every newly created terminal promise has its own immediate, non-throwing rejection observer.
    entry.logWrites = entry.logWrites.then(task).catch((error) => { retain(operation, error); fail(String(error)) })
  }
  const afterDrain = (message) => {
    if (fatalQueued) return
    fatalQueued = true
    enqueue('fatal', () => fail(message))
  }
  for (const [index, stream] of [entry.child.stdout, entry.child.stderr].entries()) {
    let total = 0
    const name = index === 0 ? 'stdout' : 'stderr'
    let resolveClosed
    pipes.push(new Promise((resolve) => { resolveClosed = resolve }))
    const file = index === 0 ? entry.stdout : entry.stderr
    const onData = (chunk) => {
      if (disposed || !chunk.length) return
      if (total >= limit) { afterDrain('Owned Electron log bound exceeded; retained bounded original prefix'); return }
      const bytes = Buffer.from(chunk), retained = bytes.subarray(0, Math.max(0, limit - total))
      total += bytes.length
      enqueue('write', async () => {
        for (let offset = 0; offset < retained.length;) {
          const { bytesWritten } = await file.write(retained, offset, retained.length - offset)
          if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > retained.length - offset) throw new Error('Owned log write made invalid progress')
          offset += bytesWritten
        }
      })
      if (total > limit) { afterDrain('Owned Electron log bound exceeded; retained bounded original prefix'); return }
      if (index !== 1 || fatalQueued) return
      pending = Buffer.concat([pending, bytes])
      let newline
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline), content = line.at(-1) === 13 ? line.subarray(0, -1) : line
        pending = pending.subarray(newline + 1)
        if (content.equals(Buffer.from('App threw an error during load'))) { afterDrain('Owned Electron: App threw an error during load'); pending = Buffer.alloc(0); return }
      }
      if (pending.length > 65536) { pending = Buffer.alloc(0); afterDrain('Owned Electron stderr line bound exceeded') }
    }
    const onError = (error) => { retain('pipe', error, { pipe: name }); fail(String(error)) }
    const cleanup = () => { stream.off('data', onData); stream.off('error', onError); stream.off('close', onClose) }
    const onClose = () => { openPipes.delete(name); cleanup(); resolveClosed() }
    stream.on('data', onData); stream.on('error', onError); stream.once('close', onClose); cleanups.push(cleanup)
  }
  entry.disposeLogs = () => { disposed = true; for (const cleanup of cleanups) cleanup(); pending = Buffer.alloc(0) }
  entry.finishLogs = async (milliseconds) => {
    let timer
    try {
      const closed = await Promise.race([Promise.all(pipes).then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds) })])
      if (!closed) {
        const message = 'Owned Electron pipes did not close; retained logs are partial'
        retain('pipe-close', message, { partial: true, openPipes: [...openPipes], incompleteStderrBytes: pending.length }); fail(message)
      }
    } finally {
      clearTimeout(timer); entry.disposeLogs()
      for (const stream of [entry.child.stdout, entry.child.stderr]) {
        try { stream.destroy?.() } catch (error) { retain('pipe-destroy', error); fail(String(error)) }
      }
    }
    // Admission is now closed; no data callback can append beyond this final stable queue.
    await entry.logWrites
  }
}

export async function runAuthoringFixture(args = process.argv.slice(2)) {
const { buildSha256: expectedSha, mode, runtimeMode = 'authoring' } = parseRunArguments(args)
const bundle = path.dirname(fileURLToPath(import.meta.url))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
assert.equal(path.dirname(bundle), '/tmp'); assert.match(path.basename(bundle), /^modly-worlds-authoring-ui-/)
assert.equal(await realpath(bundle), bundle); assert.equal((await lstat(bundle)).mode & 0o777, 0o700); assert.equal((await lstat(bundle)).uid, process.getuid())
const bytes = await readFile(path.join(bundle, 'fixture-build.json'))
assert.equal(sha(bytes), expectedSha, 'Reviewed build manifest changed')
const build = JSON.parse(bytes.toString('utf8'))
assert.equal(build.schema, 'modly.worlds-authoring-build.v1'); assert.equal(build.outputDirectory, bundle); assert.equal(build.execution, 'NOT_RUN')
const repositoryAdmission = validateRunnerRepositoryAdmission(build)
assert.equal(build.compilerDiagnostics?.schema, 'modly.worlds-authoring-compiler-diagnostics.v1')
assert.deepEqual(build.compilerDiagnostics.esbuild.map((entry) => entry.entry), ['main', 'preload'])
assert.ok(build.compilerDiagnostics.esbuild.every((entry) => Array.isArray(entry.warnings)) && Array.isArray(build.compilerDiagnostics.mainTranslationWarnings))
assert.equal(build.nativeMode ?? 'owned-xvfb', mode, 'Native mode must match the separately reviewed build')
assert.equal(build.runtimeMode ?? 'authoring', runtimeMode, 'Runtime mode must match the reviewed manifest and CLI')
const localAi = runtimeMode === 'local-ai' ? build.localAi : null
const worldSculptInput = validateRunnerWorldSculptInput(build, runtimeMode)
if (localAi) {
  validateRunnerLocalAiConfig(localAi, repositoryAdmission)
  assert.deepEqual(Object.keys(build.reviewedAiModel ?? {}).sort(), ['name', 'digest', 'toolsReviewed'].sort(), 'Local AI requires an explicitly reviewed immutable identity')
  assert.equal(build.reviewedAiModel.toolsReviewed, true); assert.match(build.reviewedAiModel.digest, /^sha256:[a-f0-9]{64}$/)
  assert.ok(typeof build.reviewedAiModel.name === 'string' && build.reviewedAiModel.name.trim() === build.reviewedAiModel.name && build.reviewedAiModel.name.length > 0 && build.reviewedAiModel.name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(build.reviewedAiModel.name))
  assert.equal(mode, 'inherited-display'); assert.equal(localAi.mainWatchdogSeconds, 420); assert.equal(localAi.runnerWatchdogSeconds, 430)
  assert.equal(localAi.outerSeconds, 450); assert.equal(localAi.cleanupSeconds, 8); assert.equal(localAi.logBytes, 1048576)
  assert.equal(build.limits.mainWatchdogSeconds, 420); assert.equal(build.limits.runnerWatchdogSeconds, 430); assert.equal(build.limits.proposedOuterSeconds, 450)
} else if (worldSculptInput) {
  assert.equal(runtimeMode, 'worldsculpt-navigation'); assert.equal(mode, 'inherited-display')
  assert.equal(build.localAi, undefined); assert.equal(build.reviewedAiModel, undefined)
} else { assert.equal(runtimeMode, 'authoring'); assert.equal(build.localAi, undefined) }
if (mode === 'inherited-display') inheritedDisplayEnvironment(process.env, '', expectedSha)
for (const [relative, expected] of Object.entries(build.outputs)) {
  const filename = path.resolve(bundle, relative)
  assert.ok(filename.startsWith(`${bundle}/`)); assert.equal(await realpath(filename), filename); assert.ok((await lstat(filename)).isFile())
  const current = await readFile(filename); assert.equal(current.length, expected.bytes); assert.equal(sha(current), expected.sha256, `Built output changed: ${relative}`)
}
assert.equal(build.repositoryRoot, repositoryAdmission.root, 'Canonical source input repository required')
assert.ok(Array.isArray(build.sourceInputs) && build.sourceInputs.length > 0, 'Source input inventory required')
const sourceInventory = build.sourceInputs.map((entry) => ({ ...entry }))
const evidencePrefix = path.join(build.repositoryRoot, 'docs', 'worlds-engine-evidence') + path.sep
// Validate the COMPLETE inventory before any source bytes, not just forbidden bytes.
for (const expected of sourceInventory) {
  assert.ok(typeof expected.path === 'string' && path.isAbsolute(expected.path) && path.resolve(expected.path) === expected.path && !expected.path.includes('\0'), 'Unsafe source input path')
  assert.ok(!/(?:^|\.)xauthority(?:\.|$)/i.test(path.basename(expected.path)) && !/\.ses$/i.test(path.basename(expected.path)) && !/\.(?:pem|key|p12|pfx)$/i.test(path.basename(expected.path)) && !expected.path.startsWith(evidencePrefix), 'Forbidden source input')
  assert.ok(Number.isSafeInteger(expected.bytes) && expected.bytes >= 0 && typeof expected.sha256 === 'string' && /^[a-f0-9]{64}$/.test(expected.sha256), 'Invalid source input pins')
  assert.ok((await lstat(expected.path)).isFile(), 'Nonregular source input')
  assert.equal(await realpath(expected.path), expected.path, 'Source input alias forbidden')
}
for (const expected of sourceInventory) {
  assert.ok((await lstat(expected.path)).isFile(), 'Nonregular source input')
  assert.equal(await realpath(expected.path), expected.path, 'Source input alias forbidden')
  const current = await readFile(expected.path); assert.equal(current.length, expected.bytes); assert.equal(sha(current), expected.sha256, `Source input changed: ${expected.path}`)
}
// The exclusive marker is allocated before any server or Electron process. A failed run is consumed too.
const marker = await open(path.join(bundle, 'run-consumed.json'), 'wx', 0o600)
const runDirectory = await mkdtemp(path.join(bundle, 'run-')); await chmod(runDirectory, 0o700)
const displayNumber = mode === 'owned-xvfb' ? randomInt(200, 60000) : null
const display = mode === 'inherited-display' ? process.env.DISPLAY : `:${displayNumber}`
const displayPaths = { socket: `/tmp/.X11-unix/X${displayNumber}`, lock: `/tmp/.X${displayNumber}-lock` }
const launcher = { schema: 'modly.worlds-authoring-launch.v1', launcherPid: process.pid, runDirectory, buildSha256: expectedSha, mode, ...(runtimeMode !== 'authoring' ? { runtimeMode } : {}), display, inheritedXauthority: mode === 'inherited-display' ? process.env.XAUTHORITY ?? null : null, startedAt: new Date().toISOString() }
await marker.writeFile(`${JSON.stringify(launcher, null, 2)}\n`); await marker.sync(); await marker.close()
const owned = [], events = [], removedInheritedNames = mode === 'owned-xvfb' ? Object.keys(process.env).sort() : []
let failed = null, stopping = false, displayAttempted = false
const logPath = path.join(runDirectory, 'launcher.json')
const log = () => writeFile(logPath, `${JSON.stringify({ ...launcher, status: failed ? 'FAIL' : stopping ? 'CLOSED' : 'RUNNING', error: failed ? String(failed.stack ?? failed) : null, removedInheritedNames, events }, null, 2)}\n`, { mode: 0o600 })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const groupAlive = (pid) => { try { process.kill(-pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const recordFailure = (error, details = {}) => { failed ??= error; events.push({ at: new Date().toISOString(), operation: 'owned-cleanup-error', error: String(error), ...details }) }
function stopOwned(entry, signal) {
  try {
    if (!entry.child.pid || !groupAlive(entry.child.pid)) return
    // Only a process group created by this exact detached child, never a user session or name match.
    process.kill(-entry.child.pid, signal)
    events.push({ at: new Date().toISOString(), operation: signal, ownedGroup: entry.child.pid, name: entry.name })
  } catch (error) { recordFailure(error, { signal, ownedGroup: entry.child.pid, name: entry.name }) }
}
let rejectInterrupt
const interrupted = new Promise((_resolve, reject) => { rejectInterrupt = reject })
void interrupted.catch(() => undefined)
const interrupt = (message) => { if (!failed) failed = new Error(message); rejectInterrupt(failed); for (const entry of owned) stopOwned(entry, 'SIGTERM') }
process.once('SIGTERM', () => interrupt('Outer TERM received'))
process.once('SIGINT', () => interrupt('Interrupted'))
const watchdog = setTimeout(() => interrupt(`Owned native run exceeded ${localAi?.runnerWatchdogSeconds ?? 125} seconds`), (localAi?.runnerWatchdogSeconds ?? 125) * 1000)
function field(value) { const bytes = Buffer.from(value); const length = Buffer.alloc(2); length.writeUInt16BE(bytes.length); return Buffer.concat([length, bytes]) }
async function child(name, executable, args, env) {
  if (failed || stopping) throw failed ?? new Error('Stopped before owned process spawn')
  const stdout = await open(path.join(runDirectory, `${name}.stdout.log`), 'wx', 0o600), stderr = await open(path.join(runDirectory, `${name}.stderr.log`), 'wx', 0o600)
  if (failed || stopping) { await stdout.close(); await stderr.close(); throw failed ?? new Error('Stopped before owned process spawn') }
  const instance = spawn(executable, args, { cwd: runDirectory, env, detached: true, stdio: name === 'electron' ? ['ignore', 'pipe', 'pipe'] : ['ignore', stdout.fd, stderr.fd] })
  const entry = { name, child: instance, stdout, stderr, exited: false, code: null, signal: null }
  entry.logWrites = Promise.resolve()
  if (name === 'electron') installOwnedFatalGate(entry, interrupt, localAi?.logBytes ?? 1048576)
  entry.done = new Promise((resolve, reject) => {
    instance.once('error', reject)
    instance.once('exit', (code, signal) => { entry.exited = true; entry.code = code; entry.signal = signal; events.push({ at: new Date().toISOString(), name, exitCode: code, signal }); resolve({ code, signal }) })
  })
  void entry.done.catch(() => undefined)
  owned.push(entry)
  events.push({ at: new Date().toISOString(), name, pid: instance.pid, executable, args })
  return entry
}
async function manifest(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), filename = path.join(directory, relative), info = await lstat(filename)
    if (info.isDirectory()) result.push(...await manifest(directory, relative))
    else if (info.isFile()) { const bytes = await readFile(filename); result.push({ path: relative, type: 'file', bytes: bytes.length, sha256: sha(bytes), mode: info.mode & 0o777, uid: info.uid }) }
    else result.push({ path: relative, type: info.isSymbolicLink() ? 'symlink-not-followed' : 'nonregular-not-read', mode: info.mode & 0o777, uid: info.uid })
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
async function execute() {
  if (mode === 'inherited-display') {
    launcher.displayResources = { scope: 'inherited-user-display-not-owned', cleanup: 'NOT_PERMITTED' }
    await log()
    const environment = inheritedDisplayEnvironment(process.env, runDirectory, expectedSha)
    if (runtimeMode !== 'authoring') environment.WORLD_AUTHORING_RUNTIME_MODE = runtimeMode
    if (localAi) environment.WORLD_AUTHORING_LOCAL_AI_CONFIG = JSON.stringify(localAi)
    const electron = await child('electron', build.electronPath, [path.join(bundle, 'main.cjs')], environment)
    const outcome = await electron.done
    assert.equal(outcome.code, 0, `Native fixture failed; preserve ${runDirectory}`)
    const result = JSON.parse(await readFile(path.join(runDirectory, 'fixture-report.json'), 'utf8'))
    if (worldSculptInput && result.status === 'PASS') await verifyActualColliderScreenshots(result.evidence.colliderRun, runDirectory)
    assert.equal(result.status, 'PASS', 'Native process exit without an evidence PASS is not success')
    assert.ok(result.checks.every((entry) => entry.status === 'PASS'))
    if (localAi) assertActualAiTerminal(result)
    if (worldSculptInput) assertActualWorldSculptNavigationTerminal(result)
    return
  }
  for (const name of ['home', 'tmp', 'cache', 'config', 'data', 'runtime']) await mkdir(path.join(runDirectory, name), { mode: 0o700 })
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: path.join(runDirectory, 'home'), TMPDIR: path.join(runDirectory, 'tmp'), XDG_CACHE_HOME: path.join(runDirectory, 'cache'), XDG_CONFIG_HOME: path.join(runDirectory, 'config'), XDG_DATA_HOME: path.join(runDirectory, 'data'), XDG_RUNTIME_DIR: path.join(runDirectory, 'runtime') }
  const { socket, lock } = displayPaths
  for (const filename of [socket, lock]) assert.equal(await lstat(filename).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error }), false, 'Proposed private display already exists; no retry')
  launcher.displayResources = { paths: displayPaths, preSpawnAbsentAt: new Date().toISOString(), captured: null, cleanup: null }
  const family = Buffer.alloc(2); family.writeUInt16BE(65535)
  const authority = path.join(runDirectory, 'Xauthority')
  await writeFile(authority, Buffer.concat([family, field(''), field(String(displayNumber)), field('MIT-MAGIC-COOKIE-1'), field(randomBytes(16))]), { flag: 'wx', mode: 0o600 })
  displayAttempted = true
  const xvfb = await child('Xvfb', '/usr/bin/Xvfb', [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp', '-auth', authority], env)
  const deadline = Date.now() + 4000
  let ready = false
  while (Date.now() < deadline) {
    if (failed || stopping) throw failed ?? new Error('Stopped while waiting for owned Xvfb')
    if (xvfb.exited || !xvfb.child.pid || !alive(xvfb.child.pid)) throw new Error('Owned Xvfb failed before readiness')
    const info = await lstat(socket).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
    if (info) { assert.ok(info.isSocket()); assert.equal(info.uid, process.getuid()); ready = true; break }
    await pause(40)
  }
  assert.ok(ready, 'Owned Xvfb did not create its socket within 4 seconds')
  launcher.displayResources.captured = await captureOwnedDisplayResources(displayPaths, xvfb.child.pid, process.getuid())
  launcher.xvfbPid = xvfb.child.pid; await log()
  const electron = await child('electron', build.electronPath, [path.join(bundle, 'main.cjs')], { ...env, DISPLAY: display, XAUTHORITY: authority, WORLD_AUTHORING_RUN_DIRECTORY: runDirectory, WORLD_AUTHORING_BUILD_SHA256: expectedSha })
  const earlyXExit = xvfb.done.then(() => { throw new Error('Owned Xvfb exited before Electron completed') })
  void earlyXExit.catch(() => undefined)
  const outcome = await Promise.race([electron.done, earlyXExit])
  assert.equal(outcome.code, 0, `Native fixture failed; preserve ${runDirectory}`)
  const result = JSON.parse(await readFile(path.join(runDirectory, 'fixture-report.json'), 'utf8'))
  assert.equal(result.status, 'PASS', 'Native process exit without an evidence PASS is not success')
  assert.ok(result.checks.every((entry) => entry.status === 'PASS'))
}
try { await Promise.race([execute(), interrupted]) }
catch (error) { failed ??= error; console.error(error) }
finally {
  stopping = true
  try {
    for (const entry of [...owned].reverse()) stopOwned(entry, 'SIGTERM')
    await pause(localAi ? 10000 : 1500)
    for (const entry of [...owned].reverse()) stopOwned(entry, 'SIGKILL')
    for (const entry of owned) {
      try {
        await Promise.race([entry.done, pause(1000)])
        const remains = !!entry.child.pid && groupAlive(entry.child.pid)
        events.push({ at: new Date().toISOString(), name: entry.name, groupGone: !remains })
        if (remains) recordFailure(new Error(`Owned process group ${entry.child.pid} remains after KILL`))
      } catch (error) { recordFailure(error, { name: entry.name }) }
      finally {
        try { await entry.finishLogs?.(1000); await entry.logWrites }
        catch (error) { recordFailure(error, { name: entry.name, operation: 'log-drain' }) }
        finally {
          entry.disposeLogs?.()
          for (const file of [entry.stdout, entry.stderr]) {
            try { await file.close() } catch (error) { recordFailure(error, { name: entry.name, operation: 'log-close' }) }
          }
          if (entry.logErrors?.length) {
            events.push({ at: new Date().toISOString(), name: entry.name, logErrors: entry.logErrors, logErrorOverflow: entry.logErrorOverflow })
            failed ??= new Error('Owned Electron logs retained failures; inspect launcher evidence')
          }
        }
      }
    }
  } catch (error) { failed ??= error; console.error(error) }
  finally {
    try {
      if (displayAttempted) {
        launcher.displayResources.cleanup = await waitForDisplayResourcesAbsent(displayPaths)
        if (launcher.displayResources.cleanup.status !== 'ABSENT') failed ??= new Error('Display filesystem paths remain after owned group shutdown; retained identities must be reviewed, never unlinked by name')
      }
      await log()
      await writeFile(path.join(runDirectory, 'disk-manifest-after-cleanup.json'), `${JSON.stringify(await manifest(runDirectory), null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    } catch (error) { failed ??= error; console.error(error); await log() }
    finally { clearTimeout(watchdog); console.log(`worlds-authoring-launch: ${failed ? 'FAIL' : 'CLOSED'}; retained=${runDirectory}`); process.exitCode = failed ? 1 : 0 }
  }
}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await runAuthoringFixture() } catch (error) { console.error(error); process.exitCode = 1 }
}
