#!/usr/bin/env node
// Separate, explicitly reviewed native entry. The build-only entry never imports or runs this file.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { captureOwnedDisplayResources, waitForDisplayResourcesAbsent } from './display-resources.mjs'

const reviewedRepositoryHead = '3807bb10ca60e071d183a30392e0c0ed1ae7534e'
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

export function parseRunArguments(args) {
  assert.ok(args.length >= 1 && args.length <= 3, 'One reviewed build and explicitly bounded modes are required')
  assert.match(args[0], /^--reviewed-build-sha256=[a-f0-9]{64}$/)
  if (args.length >= 2) assert.equal(args[1], '--inherited-display', 'No native flags or unreviewed modes are permitted')
  if (args.length === 3) { assert.equal(args[2], '--local-ai'); return { buildSha256: args[0].split('=')[1], mode: 'inherited-display', runtimeMode: 'local-ai' } }
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
  assert.equal(a?.schema, 'modly.worlds-actual-ai-acceptance.v1', 'Actual AI acceptance schema missing')
  assert.equal(a.phase, 'complete', 'Actual AI acceptance phase incomplete')
  for (const name of ['actual-model-discovery', 'actual-ai-reject', 'actual-ai-apply-and-history', 'actual-ai-both-scenes-reopen']) assert.equal(result.checks.filter((check) => check.name === name && check.status === 'PASS').length, 1, `Actual AI check missing: ${name}`)
  const stable = (value) => JSON.stringify((function sort(v) { return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((key) => v[key] !== undefined).map((key) => [key, sort(v[key])])) : v })(value))
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const same = (value, other, label) => assert.deepEqual(value, other, `Actual AI ${label}`)
  const context = (c) => {
    same(Object.keys(c ?? {}).sort(), ['schema', 'projectKey', 'projectId', 'activeSceneId', 'baseRevision', 'editorEpoch', 'originSessionId', 'requestId'].sort(), 'complete context required')
    assert.equal(c.schema, 'modly.world-ai-context.v1'); assert.match(c.projectKey, /^world-[a-f0-9]{32}$/)
    for (const field of ['projectId', 'activeSceneId', 'originSessionId', 'requestId']) assert.ok(typeof c[field] === 'string' && c[field].length > 0)
    for (const field of ['baseRevision', 'editorEpoch']) assert.ok(Number.isSafeInteger(c[field]) && c[field] >= 0)
  }
  const raw = (r) => {
    assert.equal(r?.status, 200, 'Actual AI HTTP success required'); assert.equal(r.validation, 'accepted', 'Actual AI decode not accepted')
    assert.ok(typeof r.rawResponseBase64 === 'string'); const bytes = Buffer.from(r.rawResponseBase64, 'base64')
    assert.equal(bytes.toString('base64'), r.rawResponseBase64); assert.ok(bytes.length > 0 && bytes.length <= 65536)
    assert.equal(r.responseBytes, bytes.length); assert.equal(r.responseSha256, digest(bytes))
    same(JSON.parse(bytes.toString('utf8')), r.response, 'received bytes/decoded response mismatch')
    return r.response
  }
  const input = (i, label) => {
    assert.equal(i?.trusted, true, 'Actual AI decision was not trusted native input')
    assert.ok(Number.isSafeInteger(i.sequence) && i.sequence > 0); assert.equal(i.hitMatches, true)
    assert.equal(i.target, `BUTTON:${label}`)
    assert.ok(i.hover?.matchCount === 1 && i.hover.enabled === true && i.hover.visible === true && i.hover.hitMatches === true, 'Actual native fixed-point hover witness missing')
    same(i.point, i.hover.point, 'Native input point changed after hover')
    assert.ok(Number.isFinite(i.point.x) && Number.isFinite(i.point.y))
  }
  const propertyLabel = (property) => {
    const field = property.split('.').at(-1) ?? property
    return ({ parentId: 'Parent', baseColor: 'Color', bodyType: 'Body', lightKind: 'Light', halfExtents: 'Size', halfHeight: 'Height', fieldOfView: 'FOV', orthographicSize: 'Size', castShadow: 'Shadow', receiveShadow: 'Receive', collisionLayer: 'Layer', collisionMask: 'Mask' })[field] ?? field.charAt(0).toUpperCase() + field.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2')
  }
  const state = (s) => {
    assert.ok(s?.snapshot?.project && Array.isArray(s.snapshot.scenes))
    assert.ok(Number.isSafeInteger(s.history?.undo) && Number.isSafeInteger(s.history?.redo))
    assert.ok(Array.isArray(s.documents) && s.documents.length > 0)
    for (const d of s.documents) { assert.ok(typeof d.path === 'string' && !d.path.startsWith('/') && !d.path.split('/').includes('..')); assert.match(d.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(d.bytes) && d.bytes > 0) }
  }
  assert.equal(a.admittedModel?.toolsReviewed, true, 'Explicit reviewed tool-capable identity required')
  assert.ok(typeof a.admittedModel.name === 'string' && a.admittedModel.name.length > 0)
  assert.match(a.admittedModel.digest, /^sha256:[a-f0-9]{64}$/)
  const discovery = raw(a.discovery)
  assert.equal(discovery.models.filter((model) => model.name === a.admittedModel.name && model.digest === a.admittedModel.digest).length, 1, 'Actual discovery does not contain the exact reviewed identity')
  same(a.counters, { discoveryRequests: 1, discoveryResponses: 1, chatRequests: 2, receivedChats: 2, validDecodedChats: 2, validReturnedWorldProposals: 2, hostPreviews: 2, hostDiscards: 1, aiApplies: 1, aiSettledApplies: 1, undo: 1, redo: 1 }, 'finite counters mismatch')
  assert.ok(Array.isArray(a.turns) && a.turns.length === 2, 'Actual AI requires exactly two turns')
  for (const [index, t] of a.turns.entries()) {
    context(t.context); same(t.request.worldContext, t.context, 'captured request context changed'); assert.equal(t.request.model, a.admittedModel.name)
    same(t.responseReceipt.request, t.request, 'HTTP receipt request correlation changed')
    same(t.responseReceipt.admittedSelection, { name: a.admittedModel.name, digest: a.admittedModel.digest }, 'HTTP receipt admitted identity changed')
    const body = raw(t.responseReceipt); same(body.actions, [], 'generic actions forbidden'); same(body.proposals, [], 'generic proposals forbidden')
    assert.equal(body.worldProposals.length, 1, 'Actual AI proposal missing')
    const p = body.worldProposals[0]; same(p.context, t.context, 'returned proposal context changed')
    assert.equal(p.type, 'world_command_proposal'); assert.ok(p.commands.length > 0 && p.commands.length <= 16)
    assert.ok(Array.isArray(t.queries) && t.queries.length > 0)
    for (const q of t.queries) { same(q.request.context, t.context, 'query request context changed'); assert.equal(q.result.ok, true, 'Actual query failed'); same(q.result.value.context, t.context, 'query result context changed'); assert.equal(q.result.value.kind, q.request.query.kind) }
    for (const kind of index === 0 ? ['entities', 'components'] : ['project', 'resources']) assert.ok(t.queries.some((q) => q.result.value.kind === kind && q.result.value.items.length > 0), `Actual successful ${kind} query required`)
    same(t.preview.request.proposal, p, 'preview is not the actual returned proposal'); assert.equal(t.preview.result.ok, true)
    const preview = t.preview.result.value; assert.match(preview.authority, /^apply_[a-f0-9]{48}$/)
    assert.equal(preview.batch.origin, 'ai'); assert.equal(preview.batch.projectId, t.context.projectId); assert.equal(preview.batch.baseRevision, t.context.baseRevision)
    assert.ok(preview.batch.commands.length > 0 && preview.batch.commands.length <= 16 && Buffer.byteLength(stable(preview.batch)) <= 16384)
    state(t.before); state(t.beforeDecision); same(t.beforeDecision, t.before, 'document/history/disk changed before human decision')
    assert.equal(t.before.snapshot.project.revision, t.context.baseRevision)
    same(preview.result.inverse, { kind: 'world-snapshot', snapshot: t.before.snapshot }, 'preview inverse changed')
    assert.equal(preview.result.snapshot.project.revision, t.context.baseRevision + 1)
    assert.ok(preview.details.length > 0); same(t.review.details, preview.details.map(({ entityName, property, before, after }) => ({ entityName, property: propertyLabel(property), before, after })), 'complete ordered visible NET changed')
    same(preview.result.warnings, [], 'host warnings require explicit policy'); same(t.review.warnings, [], 'visible warnings require explicit policy')
    assert.equal(t.review.busy, false); assert.equal(t.review.focused, true); assert.equal(t.review.applyEnabled, true); assert.equal(t.review.rejectEnabled, true)
  }
  const [rejected, applied] = a.turns
  assert.notEqual(rejected.context.requestId, applied.context.requestId); const shared = { ...rejected.context, requestId: applied.context.requestId }; same(shared, applied.context, 'turns changed editor/project/revision/session')
  assert.equal(rejected.decision.kind, 'reject'); input(rejected.decision.input, 'Reject Worlds proposal')
  same(rejected.decision.after, rejected.before, 'Reject changed canonical document/history/disk')
  same(rejected.decision.discarded.request, { context: rejected.context, authority: rejected.preview.result.value.authority }, 'Reject capability/context mismatch')
  assert.equal(rejected.decision.discarded.result.ok, true); assert.equal(rejected.decision.discarded.result.value.discarded, true)
  assert.notEqual(stable(rejected.preview.result.value.result.snapshot), stable(rejected.before.snapshot), 'Rejected proposal must be non-no-op')
  const organized = rejected.preview.result.value.result.snapshot, originalScene = rejected.before.snapshot.scenes.find((s) => s.sceneId === rejected.context.activeSceneId), organizedScene = organized.scenes.find((s) => s.sceneId === rejected.context.activeSceneId)
  const groups = organizedScene.entities.filter((e) => !originalScene.entities.some((old) => old.id === e.id)); assert.equal(groups.length, 1)
  const group = groups[0]; assert.equal(group.name, 'AI review group'); assert.equal(group.parentId, null); same(group.components, [], 'Group must not contain Renderable/components')
  same(group.transform, { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, 'Group identity transform changed')
  const moved = organizedScene.entities.filter((e) => e.parentId === group.id); assert.equal(moved.length, 1)
  const expectedOrganization = structuredClone(rejected.before.snapshot); expectedOrganization.project.revision++
  const expectedScene = expectedOrganization.scenes.find((s) => s.sceneId === rejected.context.activeSceneId), target = expectedScene.entities.find((e) => e.id === moved[0].id)
  assert.ok(target && target.parentId === null && target.components.some((c) => c.type === 'renderable' && c.enabled))
  target.parentId = group.id; target.transform.position[0] += 0.25; expectedScene.entities.push(structuredClone(group)); same(organized, expectedOrganization, 'Organization modified unrelated canonical owners')
  const firstRows = rejected.queries.flatMap((q) => q.result.value.items)
  assert.ok(firstRows.some((r) => r.kind === 'entity' && r.id === target.id), 'Actual selected model entity query missing')
  assert.ok(firstRows.some((r) => r.kind === 'component' && r.entityId === target.id && r.type === 'renderable' && r.current && typeof r.current === 'object'), 'Actual selected model current components missing')
  assert.ok(applied.queries.flatMap((q) => q.result.value.items).some((r) => r.kind === 'project' && Array.isArray(r.capabilities) && r.capabilities.length > 0), 'Actual project capability query missing')
  same(applied.before, rejected.before, 'Reject changed next-turn base state')
  const pv = applied.preview.result.value, decision = applied.decision, call = decision.invocation
  assert.equal(decision.kind, 'apply'); input(decision.input, 'Apply Worlds proposal'); assert.ok(decision.input.sequence > rejected.decision.input.sequence)
  assert.equal(call.request.projectKey, applied.context.projectKey); same(call.request.batch, pv.batch, 'Apply payload differs from exact host preview')
  same(call.request.aiAuthority, { token: pv.authority, context: applied.context }, 'Apply capability/context changed')
  assert.ok(call.forwardedAt && call.settledAt); assert.equal(call.result.ok, true); assert.equal(call.result.value.idempotent, false)
  same(call.result.value.snapshot, pv.result.snapshot, 'Apply differs from exact canonical candidate'); same(call.result.value.inverse, pv.result.inverse, 'Apply inverse changed')
  assert.equal(call.result.value.newRevision, applied.context.baseRevision + 1); assert.equal(call.result.value.receipt.transactionId, pv.batch.transactionId)
  assert.equal(call.result.value.receipt.payloadSha256, digest(stable(pv.batch)), 'Canonical payload receipt changed')
  assert.equal(decision.stored?.verified, true); assert.equal(decision.stored.transactionId, pv.batch.transactionId)
  same(decision.stored.snapshot, pv.result.snapshot, 'Stored canonical snapshot changed'); same(decision.stored.inverse, pv.result.inverse, 'Stored inverse changed')
  const candidate = pv.result.snapshot, before = applied.before.snapshot
  assert.equal(before.scenes.length, 2); assert.equal(candidate.scenes.length, 3); assert.equal(candidate.project.scenes.length, 3)
  assert.equal(candidate.project.startSceneId, before.project.startSceneId)
  const newScenes = candidate.scenes.filter((scene) => !before.scenes.some((old) => old.sceneId === scene.sceneId)); assert.equal(newScenes.length, 1)
  const targets = [applied.context.activeSceneId, newScenes[0].sceneId]
  assert.ok(Array.isArray(a.sourceWitnesses) && a.sourceWitnesses.length > 0)
  const used = bodyHandles(applied.responseReceipt.response.worldProposals[0])
  function bodyHandles(p) { return [...new Set(p.commands.filter((command) => command.type === 'create-entity' && command.kind === 'observed-model').map((command) => command.resourceHandle))] }
  assert.ok(used.length > 0)
  for (const handle of used) {
    const row = applied.queries.flatMap((q) => q.result.value.items).find((row) => row.kind === 'resource' && row.id === handle && row.format === 'glb' && row.capability === 'mesh')
    assert.ok(row, 'Used opaque GLB handle was not returned to this actual turn')
    const witness = a.sourceWitnesses.find((w) => w.handle === handle); assert.ok(witness, 'Actual source byte witness missing')
    assert.equal(witness.fingerprint, row.fingerprint); const bytes = Buffer.from(witness.input.rawBase64, 'base64')
    assert.equal(bytes.length, witness.input.bytes); assert.equal(digest(bytes), witness.input.sha256)
    assert.ok(bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length, 'Actual source is not GLB bytes')
    const resource = candidate.project.resources.find((resource) => resource.id === witness.resourceId && resource.format === 'glb'); assert.ok(resource)
    assert.equal(witness.proof?.workspacePath, resource.workspacePath); assert.equal(witness.proof.format, 'glb'); assert.equal(witness.proof.files.length, 1)
    const sourceFile = witness.proof.files[0]; assert.equal(sourceFile.path, resource.workspacePath); assert.equal(sourceFile.sha256, witness.input.sha256); assert.equal(sourceFile.byteLength, bytes.length)
    assert.ok(typeof sourceFile.identity === 'string' && sourceFile.identity.length > 0)
    assert.equal(witness.proof.fingerprint, digest(Buffer.from(JSON.stringify(['glb', witness.proof.files])))); assert.equal(witness.fingerprint, witness.proof.fingerprint)
    for (const sceneId of targets) assert.ok(candidate.scenes.find((scene) => scene.sceneId === sceneId).entities.some((entity) => !before.scenes.flatMap((s) => s.entities).some((old) => old.id === entity.id) && entity.components.some((component) => component.type === 'renderable' && component.resourceId === witness.resourceId)), 'Both targeted scenes require actual observed Renderable geometry')
  }
  for (const type of ['camera', 'light']) assert.ok(newScenes[0].entities.some((entity) => entity.components.some((component) => component.type === type)), `AI-created scene ${type} missing`)
  assert.ok(newScenes[0].entities.some((entity) => entity.components.some((component) => component.type === 'renderable') && entity.components.some((component) => component.type === 'collider') && entity.components.some((component) => component.type === 'rigid-body')), 'AI model physical configuration missing')
  for (const [event, base, revision, label] of [[a.undo, before, applied.context.baseRevision + 2, 'Undo'], [a.redo, candidate, applied.context.baseRevision + 3, 'Redo']]) {
    assert.equal(event?.kind, label); input(event.input, label); assert.equal(event.result.ok, true); assert.equal(event.result.value.idempotent, false); assert.equal(event.stored?.verified, true)
    assert.ok(typeof event.result.value.receipt?.transactionId === 'string' && event.result.value.receipt.transactionId.length > 0, `${label} result transaction receipt missing`)
    assert.ok(event.result.value.inverse && typeof event.result.value.inverse === 'object', `${label} result inverse missing`)
    assert.ok(typeof event.stored.transactionId === 'string' && event.stored.transactionId.length > 0 && event.stored.snapshot && typeof event.stored.snapshot === 'object' && event.stored.inverse && typeof event.stored.inverse === 'object', `${label} stored result copies missing`)
    assert.equal(event.stored.transactionId, event.result.value.receipt.transactionId, `${label} stored transaction differs`)
    same(event.stored.snapshot, event.result.value.snapshot, `${label} stored snapshot differs`); same(event.stored.inverse, event.result.value.inverse, `${label} stored inverse differs`)
    const expected = structuredClone(base); expected.project.revision = revision; same(event.result.value.snapshot, expected, `${label} document differs`); assert.equal(event.result.value.newRevision, revision)
  }
  assert.ok(Array.isArray(a.reopened) && a.reopened.length === 2)
  same(a.reopened.map((r) => r.sceneId).sort(), targets.sort(), 'Fresh AI-targeted scene IDs mismatch')
  for (const r of a.reopened) {
    assert.ok(r.oldBootId && r.bootId && r.oldBootId !== r.bootId, 'Actual fresh renderer generation missing'); assert.equal(r.canonicalDiskMatches, true)
    same(r.snapshot, a.redo.result.value.snapshot, 'Fresh canonical disk/renderer differs')
    const m = r.model; assert.ok(m?.visible && m.meshes > 0 && m.triangles > 0); assert.ok(Array.isArray(m.matrixWorld) && m.matrixWorld.length === 16 && m.matrixWorld.every(Number.isFinite))
    const canonicalModel = r.snapshot.scenes.find((scene) => scene.sceneId === r.sceneId)?.entities.find((e) => e.id === m.entityId)
    assert.ok(canonicalModel && !before.scenes.flatMap((s) => s.entities).some((old) => old.id === canonicalModel.id) && canonicalModel.components.some((c) => c.type === 'renderable' && a.sourceWitnesses.some((w) => w.resourceId === c.resourceId)), 'Fresh geometry is not the new observed model')
    assert.ok(Array.isArray(m.worldCorners) && m.worldCorners.length === 8)
    for (const corner of m.worldCorners) { assert.ok(corner.world.length === 3 && corner.world.every(Number.isFinite) && corner.ndc.length === 3 && corner.ndc.every(Number.isFinite) && corner.depth > 0); assert.ok(Math.abs(corner.ndc[0]) <= 0.92 && Math.abs(corner.ndc[1]) <= 0.92 && corner.ndc[2] > -1 && corner.ndc[2] < 1) }
    assert.ok(r.screenshot?.bytes > 0 && r.screenshot.filename.endsWith('.png')); assert.match(r.screenshot.sha256, /^[a-f0-9]{64}$/)
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
if (localAi) {
  validateRunnerLocalAiConfig(localAi, repositoryAdmission)
  assert.deepEqual(Object.keys(build.reviewedAiModel ?? {}).sort(), ['name', 'digest', 'toolsReviewed'].sort(), 'Local AI requires an explicitly reviewed immutable identity')
  assert.equal(build.reviewedAiModel.toolsReviewed, true); assert.match(build.reviewedAiModel.digest, /^sha256:[a-f0-9]{64}$/)
  assert.ok(typeof build.reviewedAiModel.name === 'string' && build.reviewedAiModel.name.trim() === build.reviewedAiModel.name && build.reviewedAiModel.name.length > 0 && build.reviewedAiModel.name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(build.reviewedAiModel.name))
  assert.equal(mode, 'inherited-display'); assert.equal(localAi.mainWatchdogSeconds, 420); assert.equal(localAi.runnerWatchdogSeconds, 430)
  assert.equal(localAi.outerSeconds, 450); assert.equal(localAi.cleanupSeconds, 8); assert.equal(localAi.logBytes, 1048576)
  assert.equal(build.limits.mainWatchdogSeconds, 420); assert.equal(build.limits.runnerWatchdogSeconds, 430); assert.equal(build.limits.proposedOuterSeconds, 450)
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
const launcher = { schema: 'modly.worlds-authoring-launch.v1', launcherPid: process.pid, runDirectory, buildSha256: expectedSha, mode, ...(localAi ? { runtimeMode } : {}), display, inheritedXauthority: mode === 'inherited-display' ? process.env.XAUTHORITY ?? null : null, startedAt: new Date().toISOString() }
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
    if (localAi) { environment.WORLD_AUTHORING_RUNTIME_MODE = runtimeMode; environment.WORLD_AUTHORING_LOCAL_AI_CONFIG = JSON.stringify(localAi) }
    const electron = await child('electron', build.electronPath, [path.join(bundle, 'main.cjs')], environment)
    const outcome = await electron.done
    assert.equal(outcome.code, 0, `Native fixture failed; preserve ${runDirectory}`)
    const result = JSON.parse(await readFile(path.join(runDirectory, 'fixture-report.json'), 'utf8'))
    assert.equal(result.status, 'PASS', 'Native process exit without an evidence PASS is not success')
    assert.ok(result.checks.every((entry) => entry.status === 'PASS'))
    if (localAi) assertActualAiTerminal(result)
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
