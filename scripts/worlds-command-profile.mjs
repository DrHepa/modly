// Importing this module never imports application code or connects a profiler.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { release } from 'node:os'
import { isBuiltin } from 'node:module'
import { buildScenario, collectSourceManifest, moduleSpecifiers, parseArguments, success, validateRunAdmission } from './worlds-command-latency.mjs'

export { parseArguments }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts/worlds-command-profile.mjs')
const EVIDENCE_BASE = join(ROOT, 'docs/worlds-engine-evidence/2026-09-09/current-command-cost-map')
const WORKSPACE_PREFIX = '/tmp/modly-worlds-command-profile-new-'
const EXTRA_INPUTS = Object.freeze(['scripts/worlds-command-profile.mjs', 'scripts/worlds-command-profile.test.mjs',
  'scripts/worlds-command-profile.contract.test.mjs',
  'docs/worlds-command-profile.md', 'scripts/run-node-tests.mjs', 'electron/main/world-project-repository.test.ts'])
const NS = /^(0|[1-9][0-9]*)$/
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`
const hash = (value) => createHash('sha256').update(value).digest('hex')
const READER_FAILURES = Symbol('reader-failures')
const errorRecord = (error, stage) => ({ ...(stage ? { stage } : {}), name: error?.name ?? 'Error', code: error?.code ?? null,
  message: String(error?.message ?? error), ...(error?.[READER_FAILURES] ? { errors: error[READER_FAILURES] } : {}) })
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
export const PROFILE_CONTRACT = Object.freeze({
  schema: 'worlds-command-profile-v1', instrumentation: 'inspector-cpu+controller-lifecycle',
  performanceAcceptance: 'NOT_ASSESSED', historicalComparison: false,
  entities: 100, setupBatches: 32, profiledBatches: 20, seed: 'worlds-command-latency-new-v1',
  samplingIntervalUs: 1000, maxProfiles: 20, maxProfileBytes: 64 * 1024 * 1024,
  workspacePolicy: 'RETAIN_BY_DESIGN', maxEvidenceBodyBytes: 256 * 1024 * 1024,
  sceneBinding: 'PIN_INITIAL_VALIDATED_ID_DOCUMENT_PATH_PROJECT_ID',
  maxDocumentBytes: 16 * 1024 * 1024, maxPackBytes: 16 * 1024 * 1024, maxIndexBytes: 64 * 1024,
  maxLifecycleEvents: 4, internalDeadlineMs: 170_000, outerDeadlineSeconds: 180,
})
const INTERPRETATION = Object.freeze({
  weights: 'Sample-delta estimates in microseconds; not exact CPU timers or call counts.',
  inclusive: 'Synchronous sampled-stack ancestors, each function group counted once per sample; overlapping totals are not additive.',
  waits: 'Idle/unattributed samples and wall gaps do not identify filesystem, fsync, lock or scheduler waits.',
  boundaries: 'Profiles slightly enclose dispatch with inspector/harness margins; no cross-clock alignment or timing acceptance.',
})

export function buildProfileScenario(identity, entities) {
  const fixture = buildScenario(identity, entities)
  return { ...PROFILE_CONTRACT, identity: structuredClone(identity), entities: structuredClone(fixture.entities),
    batches: fixture.batches.map((batch) => ({ ...batch, phase: batch.phase === 'measure' ? 'profile' : 'setup' })) }
}

export function checkDiagnosticImports(source, inheritedSources, importer = SCRIPT) {
  const admitted = new Set(inheritedSources.map((entry) => entry.path))
  return moduleSpecifiers(source).map((specifier) => {
    if (specifier.startsWith('node:')) {
      assert.ok(isBuiltin(specifier), `Unknown diagnostic builtin: ${specifier}`)
      return { importer: relative(ROOT, importer), specifier, target: specifier }
    }
    assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), 'Unexpected diagnostic package import.')
    const target = relative(ROOT, resolve(dirname(importer), specifier))
    assert.ok(admitted.has(target), `Diagnostic import is outside inherited closure: ${specifier}`)
    return { importer: relative(ROOT, importer), specifier, target }
  })
}

export function sealProfileManifest(inherited, diagnosticSources, diagnosticEdges, contract = PROFILE_CONTRACT) {
  const manifest = { schema: 'worlds-command-profile-manifest-v1', inherited, diagnosticSources, diagnosticEdges, contract }
  return { ...manifest, sourceSealSha256: hash(encode(manifest)), runtime: inherited.runtime }
}

export async function collectProfileManifest() {
  const inherited = await collectSourceManifest()
  const diagnosticSources = []
  for (const path of EXTRA_INPUTS) {
    const absolute = join(ROOT, path)
    assert.equal(await realpath(absolute), absolute, 'Diagnostic input is a path alias.')
    const info = await lstat(absolute)
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Diagnostic input is not a regular file.')
    const bytes = await readFile(absolute)
    diagnosticSources.push({ path, size: bytes.byteLength, sha256: hash(bytes) })
  }
  const diagnosticEdges = checkDiagnosticImports(await readFile(SCRIPT, 'utf8'), inherited.sources)
  const contractTest = join(ROOT, 'scripts/worlds-command-profile.contract.test.mjs')
  diagnosticEdges.push(...checkDiagnosticImports(await readFile(contractTest, 'utf8'), [...inherited.sources, ...diagnosticSources], contractTest))
  return sealProfileManifest(inherited, diagnosticSources, diagnosticEdges)
}

export function validateProfileAdmission(options, readiness, environment) {
  assert.equal(options.mode, 'run', 'Explicit run mode required.')
  assert.equal(options.sealSha256, readiness.sourceSealSha256, 'Diagnostic seal mismatch.')
  assert.deepEqual(readiness.contract, PROFILE_CONTRACT, 'Unexpected diagnostic contract.')
  validateRunAdmission({ mode: 'run', sealSha256: readiness.inherited.sourceSealSha256 }, readiness.inherited, environment)
}

export function createProfileReportOnly(readiness) {
  validateRunAdmission({ mode: 'run', sealSha256: readiness.inherited.sourceSealSha256 }, readiness.inherited, {
    cwd: ROOT,
    executable: readiness.runtime.executable,
    version: readiness.runtime.version,
    execArgv: readiness.runtime.execArgv,
    nodeOptions: '',
    nodePath: '',
  })
  return { mode: 'report-only', status: 'NOT_EXECUTED', applicationImported: false, profilerConnected: false,
    workspaceCreated: false, evidenceCreated: false, performanceAcceptance: 'NOT_ASSESSED', ...readiness,
    proposedArgv: [readiness.runtime.executable, ...readiness.runtime.execArgv, SCRIPT, '--run', '--seal-sha256', readiness.sourceSealSha256] }
}

function describeFrame(frame) {
  assert.ok(frame && typeof frame.functionName === 'string' && typeof frame.url === 'string', 'Invalid profile frame.')
  for (const position of [frame.lineNumber, frame.columnNumber]) assert.ok(Number.isSafeInteger(position) && position >= -1, 'Invalid profile position.')
  const file = frame.url.startsWith('file:') ? fileURLToPath(frame.url) : frame.url
  const category = frame.functionName === '(idle)' ? 'idle'
    : frame.functionName === '(garbage collector)' ? 'gc'
      : ['(program)', '(root)'].includes(frame.functionName) || !file ? 'unattributed'
        : /^node:(?:internal\/)?inspector(?:\/|$)/.test(file) ? 'inspector'
          : [SCRIPT, join(ROOT, 'scripts/worlds-command-latency.mjs')].includes(file) ? 'harness'
            : file.startsWith(`${ROOT}/node_modules/`) ? 'dependency'
              : file.startsWith(`${ROOT}/`) ? 'application' : 'runtime'
  return { key: JSON.stringify([file, frame.functionName, frame.lineNumber, frame.columnNumber]), file,
    functionName: frame.functionName, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber,
    positions: 'zero-based V8 callFrame positions', category }
}

function finishCpuSummary(groups, sampleCount, totalSampleWeightUs, unassignedTailUs, profileCount) {
  const categories = new Map()
  for (const group of groups.values()) {
    const entry = categories.get(group.category) ?? { category: group.category, exclusiveSamples: 0, exclusiveWeightUs: 0 }
    entry.exclusiveSamples += group.exclusiveSamples; entry.exclusiveWeightUs += group.exclusiveWeightUs
    categories.set(group.category, entry)
  }
  return { schema: 'worlds-command-profile-cpu-summary-v1', performanceAcceptance: 'NOT_ASSESSED', interpretation: INTERPRETATION,
    profileCount, sampleCount, totalSampleWeightUs, unassignedTailUs,
    groups: [...groups.values()].sort((a, b) => b.exclusiveWeightUs - a.exclusiveWeightUs || compare(a.key, b.key)),
    categories: [...categories.values()].sort((a, b) => compare(a.category, b.category)) }
}

export function reduceCpuProfile(profile) {
  assert.ok(profile && Array.isArray(profile.nodes) && profile.nodes.length > 0 && profile.nodes.length <= 50_000, 'Invalid profile nodes.')
  assert.ok(Number.isFinite(profile.startTime) && Number.isFinite(profile.endTime) && profile.startTime >= 0 && profile.endTime >= profile.startTime, 'Invalid profile time domain.')
  assert.ok(Array.isArray(profile.samples) && profile.samples.length > 0 && profile.samples.length <= 500_000, 'Missing or invalid profile samples.')
  assert.ok(Array.isArray(profile.timeDeltas) && profile.timeDeltas.length === profile.samples.length, 'Missing or mismatched profile time deltas.')
  const nodes = new Map(), parents = new Map(), groups = new Map(), frames = new Map()
  for (const node of profile.nodes) {
    assert.ok(Number.isSafeInteger(node.id) && node.id > 0 && !nodes.has(node.id), 'Invalid or duplicate profile node.')
    assert.ok(node.children === undefined || Array.isArray(node.children), 'Invalid profile children.')
    nodes.set(node.id, node)
    const frame = describeFrame(node.callFrame)
    frames.set(node.id, frame)
    const group = groups.get(frame.key) ?? { ...frame, nodeCount: 0, exclusiveSamples: 0, inclusiveSamples: 0, exclusiveWeightUs: 0, inclusiveWeightUs: 0 }
    group.nodeCount++; groups.set(frame.key, group)
  }
  const root = profile.nodes[0].id
  for (const node of nodes.values()) for (const child of node.children ?? []) {
    assert.ok(nodes.has(child) && child !== root && !parents.has(child), 'Dangling, cyclic, duplicate or multiparent profile child.')
    parents.set(child, node.id)
  }
  const visited = new Set(), pending = [root]
  while (pending.length) {
    const id = pending.pop()
    assert.ok(!visited.has(id), 'Cyclic profile graph.')
    visited.add(id)
    for (const child of nodes.get(id).children ?? []) pending.push(child)
  }
  assert.equal(visited.size, nodes.size, 'Disconnected profile graph.')
  let total = 0
  for (let i = 0; i < profile.samples.length; i++) {
    const leaf = profile.samples[i], weight = profile.timeDeltas[i]
    assert.ok(nodes.has(leaf) && Number.isFinite(weight) && weight >= 0, 'Invalid sample or sample delta.')
    total += weight
    const exclusive = groups.get(frames.get(leaf).key)
    exclusive.exclusiveSamples++; exclusive.exclusiveWeightUs += weight
    const counted = new Set()
    for (let id = leaf; id !== undefined; id = parents.get(id)) {
      const key = frames.get(id).key
      if (counted.has(key)) continue
      counted.add(key)
      const inclusive = groups.get(key)
      inclusive.inclusiveSamples++; inclusive.inclusiveWeightUs += weight
    }
  }
  const span = profile.endTime - profile.startTime
  assert.ok(Number.isFinite(total) && total > 0 && total <= span, 'Invalid or empty sample weight coverage.')
  return finishCpuSummary(groups, profile.samples.length, total, span - total, 1)
}

export function aggregateCpuSummaries(summaries) {
  assert.ok(Array.isArray(summaries) && summaries.length > 0 && summaries.length <= PROFILE_CONTRACT.maxProfiles, 'Missing or excessive CPU summaries.')
  const groups = new Map()
  let samples = 0, weight = 0, tail = 0
  for (const summary of summaries) {
    assert.equal(summary.schema, 'worlds-command-profile-cpu-summary-v1')
    assert.equal(summary.profileCount, 1)
    samples += summary.sampleCount; weight += summary.totalSampleWeightUs; tail += summary.unassignedTailUs
    for (const item of summary.groups) {
      const group = groups.get(item.key)
      if (!group) groups.set(item.key, { ...item })
      else for (const key of ['nodeCount', 'exclusiveSamples', 'inclusiveSamples', 'exclusiveWeightUs', 'inclusiveWeightUs']) group[key] += item[key]
    }
  }
  return finishCpuSummary(groups, samples, weight, tail, summaries.length)
}

export function reserveProfileArtifact(budget, bytes) {
  assert.ok(Number.isSafeInteger(budget.count) && budget.count >= 0 && budget.count < PROFILE_CONTRACT.maxProfiles, 'Profile count budget exceeded.')
  assert.ok(Number.isSafeInteger(budget.bytes) && budget.bytes >= 0 && Number.isSafeInteger(bytes) && bytes > 0
    && budget.bytes + bytes <= PROFILE_CONTRACT.maxProfileBytes, 'Profile byte budget exceeded.')
  return { count: budget.count + 1, bytes: budget.bytes + bytes }
}

export function createLifecycleRecorder(clock = () => process.hrtime.bigint()) {
  let active = false, events = [], errors = []
  return {
    begin() { events = []; errors = []; active = true },
    listener(state) {
      if (!active || errors.length) return
      try {
        assert.ok(events.length < PROFILE_CONTRACT.maxLifecycleEvents, 'Lifecycle event budget exceeded.')
        const hrtimeNs = String(clock())
        assert.match(hrtimeNs, NS)
        events.push({ lifecycle: state.lifecycle, revision: state.session?.snapshot.project.revision ?? null, hrtimeNs })
      } catch (error) { errors.push(errorRecord(error, 'lifecycle-observer')) }
    },
    finish() { active = false; return { events, errors } },
  }
}

export async function captureProfiledDispatch({ profiler, operation, recorder, clock = () => process.hrtime.bigint(), checkAdmission = () => {} }) {
  const capture = { startedNs: null, endedNs: null, operationStarted: false, operationSettled: true, result: null,
    profile: null, lifecycle: { events: [], errors: [] }, errors: [] }
  let attemptedStart = false, stage = 'admission'
  try {
    checkAdmission()
    stage = 'profiler-start'; attemptedStart = true
    await profiler.post('Profiler.start')
    stage = 'admission'; checkAdmission()
    recorder.begin()
    stage = 'start-clock'; capture.startedNs = String(clock()); assert.match(capture.startedNs, NS)
    capture.operationStarted = true; capture.operationSettled = false
    try { capture.result = await operation() }
    catch (error) { capture.errors.push(errorRecord(error, 'dispatch')) }
    finally {
      capture.operationSettled = true
      try { capture.endedNs = String(clock()); assert.match(capture.endedNs, NS) }
      catch (error) { capture.errors.push(errorRecord(error, 'settlement-clock')) }
    }
  } catch (error) { capture.errors.push(errorRecord(error, stage)) }
  finally {
    capture.lifecycle = recorder.finish()
    capture.errors.push(...capture.lifecycle.errors)
    if (attemptedStart) {
      try { capture.profile = (await profiler.post('Profiler.stop')).profile }
      catch (error) { capture.errors.push(errorRecord(error, 'profiler-stop')) }
    }
  }
  return capture
}

export function lifecycleBrackets(capture, baseRevision) {
  assert.match(capture.startedNs ?? '', NS); assert.match(capture.endedNs ?? '', NS)
  assert.deepEqual(capture.lifecycle.errors, [])
  const events = capture.lifecycle.events
  assert.equal(events.length, 2, 'Expected exactly loading and ready lifecycle markers.')
  assert.deepEqual(events.map((event) => [event.lifecycle, event.revision]), [['loading', baseRevision], ['ready', baseRevision + 1]])
  for (const event of events) assert.match(event.hrtimeNs, NS)
  const [start, loading, ready, end] = [capture.startedNs, events[0].hrtimeNs, events[1].hrtimeNs, capture.endedNs].map(BigInt)
  assert.ok(start <= loading && loading <= ready && ready <= end, 'Lifecycle clocks are out of the dispatch interval.')
  return { beforeLoadingNs: String(loading - start), loadingToReadyNs: String(ready - loading),
    readyToSettlementNs: String(end - ready), dispatchWallNs: String(end - start) }
}

export function releaseProfileResources(resources) {
  const errors = []
  for (const [key, release] of [['unsubscribe', (value) => value()], ['session', (value) => value.disconnect()]]) {
    const value = resources[key]; resources[key] = null
    if (value) try { release(value) } catch (error) { errors.push(errorRecord(error, key)) }
  }
  return { settled: errors.length === 0, errors }
}

export function matchesWorkspaceIdentity(owned, observed, durable) {
  if (!owned || !observed || !/^[a-f0-9]{32}$/.test(owned.token ?? '')) return false
  if (!/^\/tmp\/modly-worlds-command-profile-new-[A-Za-z0-9]{6}$/.test(owned.path ?? '')) return false
  if (!NS.test(owned.dev ?? '') || !NS.test(owned.ino ?? '') || !Number.isSafeInteger(owned.uid) || owned.uid < 0) return false
  return durable?.token === owned.token && observed.realPath === owned.path
    && observed.isDirectory === true && observed.isSymbolicLink === false
    && ['path', 'dev', 'ino', 'uid'].every((key) => observed[key] === owned[key])
}

export async function finalizeOwnedWorkspace(owned, options, io) {
  const errors = []
  const observe = async (stage) => {
    const record = { status: 'OWNERSHIP_UNVERIFIED', owned, observed: null, settled: options.settled,
      interrupted: options.interrupted || Boolean(options.isInterrupted?.()), policy: 'RETAIN_BY_DESIGN', destructionAttempted: false }
    try {
      const durable = await io.readOwnership()
      record.observed = await io.observe(owned.path)
      assert.deepEqual(durable, owned, 'Durable ownership record changed.')
      assert.ok(matchesWorkspaceIdentity(owned, record.observed, durable), 'Workspace ownership mismatch.')
      record.status = 'WORKSPACE_RETAINED_BY_DESIGN'
    } catch (error) { errors.push(errorRecord(error, stage)) }
    return record
  }
  const admission = await observe('workspace-admission')
  try { await io.save('workspace-admission.json', admission) }
  catch (error) { errors.push(errorRecord(error, 'workspace-admission-write')) }
  // No pathname deletion exists: even replacement during the preceding await is non-destructive.
  const result = await observe('workspace-final')
  if (errors.length && result.status === 'WORKSPACE_RETAINED_BY_DESIGN') result.status = 'EVIDENCE_INCOMPLETE'
  result.errors = errors
  try { await io.save('workspace-final.json', result) }
  catch (error) { errors.push(errorRecord(error, 'workspace-final-write')); result.status = 'EVIDENCE_INCOMPLETE' }
  return result
}

async function safeDirectory(path) {
  const info = await lstat(path)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Unsafe directory: ${path}`)
  assert.equal(await realpath(path), path, `Directory alias: ${path}`)
}

async function createEvidenceDirectory() {
  await safeDirectory(EVIDENCE_BASE)
  const parent = join(EVIDENCE_BASE, 'diagnostics')
  try { await mkdir(parent, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await safeDirectory(parent)
  return mkdtemp(join(parent, 'attempt-'))
}

async function readJsonFile(path) {
  const { bytes } = await readEvidenceFile(dirname(path), path, PROFILE_CONTRACT.maxIndexBytes)
  return JSON.parse(bytes.toString('utf8'))
}

async function absent(path) {
  try { await lstat(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}

export function createEvidenceBodyStore(writeBlob, maximum = PROFILE_CONTRACT.maxEvidenceBodyBytes) {
  assert.ok(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= PROFILE_CONTRACT.maxEvidenceBodyBytes)
  const retained = new Map()
  let reservedBytes = 0
  return {
    budget: () => ({ reservedBytes, uniqueBlobs: retained.size, maximum }),
    async retainBytes(path, bytes) {
      assert.ok(Buffer.isBuffer(bytes), 'Evidence body must be actual bytes.')
      const sha256 = hash(bytes), blob = `body-${sha256}.bin`
      if (!retained.has(sha256)) {
        assert.ok(reservedBytes + bytes.length <= maximum, 'Evidence body byte budget exceeded.')
        reservedBytes += bytes.length // Failed/partial writes still consume the admission budget.
        await writeBlob(blob, bytes)
        retained.set(sha256, bytes.length)
      }
      assert.equal(retained.get(sha256), bytes.length)
      return { path, sha256, byteLength: bytes.length, blob }
    },
  }
}

// Bounded descriptor reads reuse the sealed repository IO helper, imported only on this run path.
export async function readEvidenceFile(workspace, path, maximum, io = { lstat, realpath, open }) {
  const local = relative(workspace, path)
  assert.ok(local && !local.startsWith('/') && !local.split('/').some((part) => part === '..' || !part), 'Evidence path escapes workspace.')
  assert.equal(resolve(workspace, local), path)
  assert.ok(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= PROFILE_CONTRACT.maxDocumentBytes)
  assert.ok(Number.isInteger(constants.O_NOFOLLOW) && constants.O_NOFOLLOW !== 0, 'No-follow reads unavailable.')
  const same = (a, b) => ['dev', 'ino', 'uid', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key])
  const parents = []
  for (let parent = workspace; ; ) {
    const info = await io.lstat(parent, { bigint: true })
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Unsafe evidence parent.')
    assert.equal(await io.realpath(parent), parent, 'Evidence parent alias.')
    parents.push([parent, info])
    if (parent === dirname(path)) break
    parent = join(parent, relative(parent, dirname(path)).split('/')[0])
  }
  const before = await io.lstat(path, { bigint: true })
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maximum), 'Unsafe or oversized evidence body.')
  const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let primaryFailure
  try {
    const opened = await handle.stat({ bigint: true })
    assert.ok(opened.isFile() && same(before, opened), 'Evidence body replaced before open.')
    const readOpened = io.readOpened ?? (await import('../electron/main/world-repository-io.ts')).readBoundedOpenedFile
    const bytes = await readOpened(handle, maximum, Number(opened.size))
    assert.equal(bytes.length, Number(opened.size), 'Evidence body shrank while reading.')
    const after = await io.lstat(path, { bigint: true })
    assert.ok(after.isFile() && !after.isSymbolicLink() && same(opened, after) && same(opened, await handle.stat({ bigint: true })), 'Evidence body changed during read.')
    assert.equal(await io.realpath(path), path, 'Evidence body alias.')
    for (const [parent, initial] of parents) {
      const current = await io.lstat(parent, { bigint: true })
      assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === initial.dev && current.ino === initial.ino, 'Evidence parent changed during read.')
      assert.equal(await io.realpath(parent), parent)
    }
    return { bytes, identity: { path, dev: String(opened.dev), ino: String(opened.ino), uid: Number(opened.uid),
      size: String(opened.size), mtimeNs: String(opened.mtimeNs), ctimeNs: String(opened.ctimeNs), type: 'regular-file', noFollow: true } }
  } catch (error) {
    primaryFailure = { error }
    throw error
  } finally {
    try { await handle.close() }
    catch (closeError) {
      if (!primaryFailure) throw closeError
      const combined = new AggregateError([primaryFailure.error, closeError], 'Evidence read and descriptor close both failed.')
      // Only this fixed pair is serialized; arbitrary exception graphs are not traversed.
      combined[READER_FAILURES] = [errorRecord(primaryFailure.error, 'evidence-read'), errorRecord(closeError, 'descriptor-close')]
      throw combined
    }
  }
}

function boundSceneFilename(projectKey, binding) {
  assert.match(projectKey, /^world-[a-f0-9]{32}$/)
  const prefix = `Worlds/${projectKey}/scenes/`
  assert.ok(typeof binding?.documentPath === 'string' && binding.documentPath.startsWith(prefix), 'Bound scene path is outside its project.')
  const filename = binding.documentPath.slice(prefix.length)
  assert.match(filename, /^scene-[a-f0-9]{32}\.world-scene\.json$/, 'Invalid bound scene filename.')
  return filename
}

// The caller supplies a production-validated initial snapshot; semantic IDs are not path components.
export function pinSceneBinding(projectKey, snapshot) {
  assert.equal(snapshot.project.scenes.length, 1); assert.equal(snapshot.scenes.length, 1)
  const ref = snapshot.project.scenes[0], scene = snapshot.scenes[0]
  assert.equal(ref.id, scene.sceneId); assert.equal(scene.projectId, snapshot.project.projectId)
  const binding = { id: ref.id, documentPath: ref.documentPath, projectId: snapshot.project.projectId }
  boundSceneFilename(projectKey, binding)
  return Object.freeze(binding)
}

export async function inspectSettled(workspace, projectKey, io, binding) {
  const sceneFilename = boundSceneFilename(projectKey, binding)
  const prefix = `Worlds/${projectKey}`, files = []
  const read = async (path, maximum = PROFILE_CONTRACT.maxDocumentBytes, expectedSha256) => {
    assert.ok(path.startsWith(`${prefix}/`) && !path.split('/').some((part) => ['.', '..', ''].includes(part)), 'Unsafe custody path.')
    const observed = await io.readBytes(join(workspace, path), maximum)
    const bytes = Buffer.isBuffer(observed) ? observed : observed.bytes
    assert.ok(Buffer.isBuffer(bytes) && bytes.length <= maximum, 'Evidence read exceeded per-file bound.')
    const ref = await io.retainBytes(path, bytes)
    assert.equal(ref.sha256, hash(bytes), 'Retained content identity mismatch.')
    files.push({ ...ref, ...(observed.identity ? { identity: observed.identity } : {}) })
    await io.recordFile?.(files.at(-1)) // Preserve even corrupt bytes before comparison/parsing can fail.
    if (expectedSha256 !== undefined) assert.equal(ref.sha256, expectedSha256, `Actual body hash mismatch: ${path}`)
    return { bytes, ref, json: () => JSON.parse(bytes.toString('utf8')) }
  }
  const validateResult = (bytes, transaction) => {
    assert.equal(hash(bytes), transaction.resultSha256, 'Actual result bytes disagree with ledger.')
    assert.equal(hash(transaction.canonicalPayload), transaction.payloadSha256)
    assert.equal(hash(`${transaction.transactionId}\n${transaction.canonicalPayload}`), transaction.transactionDigest)
    const result = JSON.parse(bytes.toString('utf8'))
    const batch = JSON.parse(transaction.canonicalPayload)
    assert.equal(batch.transactionId, transaction.transactionId)
    assert.equal(batch.projectId, binding.projectId)
    assert.equal(batch.baseRevision + 1, transaction.appliedRevision)
    assert.equal(result.transactionId, transaction.transactionId)
    assert.equal(result.newRevision, transaction.appliedRevision)
    assert.equal(result.inverse.kind, 'world-snapshot')
    assert.equal(result.inverse.snapshot.project.revision, result.newRevision - 1)
    assert.equal(result.inverse.snapshot.project.projectId, binding.projectId)
    if (result.schema === 'modly.world-command-result.v2') {
      assert.deepEqual(Object.keys(result).sort(), ['changes', 'inverse', 'newRevision', 'schema', 'transactionId', 'warnings'])
      assert.equal(Object.hasOwn(result, 'snapshot'), false)
    } else {
      assert.equal(result.schema, 'modly.world-command-result.v1')
      assert.deepEqual(Object.keys(result).sort(), ['changes', 'inverse', 'newRevision', 'schema', 'snapshot', 'transactionId', 'warnings'])
      assert.equal(result.snapshot.project.revision, result.newRevision)
      assert.equal(result.snapshot.project.projectId, binding.projectId)
    }
    return result
  }
  const readPackage = async (packageRoot, primary) => {
    const stateFile = await read(`${packageRoot}/${primary ? '.modly/' : ''}state.v1.json`)
    const state = stateFile.json()
    assert.equal(state.schema, 'modly.world-project-state.v1'); assert.equal(state.projectKey, projectKey)
    assert.ok(Number.isSafeInteger(state.committedRevision) && state.committedRevision >= 0 && state.committedRevision <= 52)
    assert.ok(Array.isArray(state.transactions) && state.transactions.length <= 32)
    assert.equal(state.project.path, `${prefix}/project.world-project.json`)
    const project = (await read(`${packageRoot}/project.world-project.json`, undefined, state.project.sha256)).json()
    assert.equal(state.projectId, binding.projectId); assert.equal(project.projectId, binding.projectId)
    assert.equal(project.revision, state.committedRevision)
    assert.equal(state.scenes.length, 1); assert.equal(project.scenes.length, 1)
    const scenes = []
    for (const ref of state.scenes) {
      assert.equal(ref.sceneId, binding.id); assert.equal(ref.path, binding.documentPath)
      assert.equal(project.scenes[0].id, binding.id); assert.equal(project.scenes[0].documentPath, binding.documentPath)
      const scene = (await read(`${packageRoot}/scenes/${sceneFilename}`, undefined, ref.sha256)).json()
      assert.equal(scene.sceneId, binding.id); assert.equal(scene.projectId, binding.projectId)
      scenes.push(scene)
    }
    return { state, snapshot: { project, scenes }, stateSha256: stateFile.ref.sha256 }
  }
  const primary = await readPackage(prefix, true)
  for (const transaction of primary.state.transactions) {
    assert.match(transaction.transactionDigest, /^[a-f0-9]{64}$/)
    const body = await read(`${prefix}/.modly/transactions/${transaction.transactionDigest}/after/result.v1.json`, undefined, transaction.resultSha256)
    const result = validateResult(body.bytes, transaction)
    if (result.newRevision === primary.state.committedRevision && result.schema === 'modly.world-command-result.v1') assert.deepEqual(result.snapshot, primary.snapshot)
    if (result.newRevision === primary.state.committedRevision && result.schema === 'modly.world-command-result.v2') assert.equal(primary.snapshot.project.revision, result.newRevision)
  }
  await io.safeDirectory(join(workspace, prefix, '.modly/backups'))
  const entries = await io.readdir(join(workspace, prefix, '.modly/backups'), { withFileTypes: true })
  assert.ok(entries.length <= 8 && entries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^[0-9]+-[a-f0-9]{64}$/.test(entry.name)), 'Unexpected backup inventory.')
  const backups = entries.map((entry) => entry.name).sort()
  if (primary.state.lastValidBackup !== null) {
    assert.ok(backups.some((name) => primary.state.lastValidBackup === `.modly/backups/${name}`), 'Referenced backup is absent.')
  }
  for (const name of backups) {
    const backupRoot = `${prefix}/.modly/backups/${name}`, backup = await readPackage(backupRoot, false)
    assert.equal(Number(name.split('-')[0]), backup.state.committedRevision, 'Backup directory revision disagrees with actual state.')
    const index = (await read(`${backupRoot}/transactions.index.v1.json`, PROFILE_CONTRACT.maxIndexBytes)).json()
    assert.equal(index.schema, 'modly.world-backup-transaction-pack.v1')
    for (const key of ['projectKey', 'projectId', 'committedRevision']) assert.equal(index[key], backup.state[key])
    assert.equal(index.stateSha256, backup.stateSha256); assert.equal(index.pack.path, 'transactions.pack.v1')
    const pack = await read(`${backupRoot}/transactions.pack.v1`, PROFILE_CONTRACT.maxPackBytes, index.pack.sha256)
    assert.equal(pack.bytes.length, index.pack.byteLength)
    assert.equal(index.entries.length, backup.state.transactions.length)
    let offset = 0
    for (const [i, entry] of index.entries.entries()) {
      const transaction = backup.state.transactions[i]
      for (const key of ['transactionId', 'transactionDigest', 'resultSha256']) assert.equal(entry[key], transaction[key])
      assert.equal(entry.offset, offset)
      assert.ok(Number.isSafeInteger(entry.length) && entry.length > 0 && entry.length <= PROFILE_CONTRACT.maxDocumentBytes && offset + entry.length <= pack.bytes.length)
      validateResult(pack.bytes.subarray(offset, offset + entry.length), transaction)
      offset += entry.length
    }
    assert.equal(offset, pack.bytes.length, 'Packed result ranges must cover actual bytes exactly.')
  }
  return { ...primary, backups, journalAbsent: await io.absent(join(workspace, prefix, '.modly/journal.v1.json')),
    custody: { status: 'PASS', coverage: 'Current primary ledger result bodies and all currently retained packed backups, not every historical filesystem state.', files } }
}

function assertState(state, expected, history) {
  assert.equal(state.lifecycle, 'ready')
  assert.deepEqual(state.session.snapshot, expected)
  assert.equal(state.savedRevision, expected.project.revision)
  assert.equal(state.session.undoStack.length, history)
  assert.equal(state.session.redoStack.length, 0)
  assert.equal(state.session.receipts.length, history)
  assert.equal(state.canUndo, history > 0); assert.equal(state.canRedo, false)
  assert.ok(Object.isFrozen(state.session) && Object.isFrozen(state.session.snapshot))
  assert.equal(expected.scenes.length, 1)
  assert.equal(expected.scenes[0].entities.length, PROFILE_CONTRACT.entities)
  assert.equal(new Set(expected.scenes[0].entities.map((entity) => entity.id)).size, PROFILE_CONTRACT.entities)
  assert.equal(expected.project.resources.length, 0)
  for (const entity of expected.scenes[0].entities) assert.equal(entity.components.length, 0)
}

function assertDisk(disk, expected, receipt) {
  assert.equal(disk.custody.status, 'PASS', 'Actual durable body custody incomplete.')
  assert.deepEqual(disk.snapshot, expected)
  assert.equal(disk.state.committedRevision, expected.project.revision)
  assert.equal(disk.state.transactions.length, Math.min(32, expected.project.revision))
  assert.equal(disk.backups.length, Math.min(8, expected.project.revision))
  assert.equal(disk.journalAbsent, true)
  if (receipt) {
    const stored = disk.state.transactions.find((item) => item.transactionId === receipt.transactionId)
    assert.ok(stored, 'Receipt absent from durable ledger.')
    for (const key of ['transactionId', 'payloadSha256', 'resultSha256', 'appliedRevision']) assert.equal(stored[key], receipt[key])
  }
}

const SYSTEM_PORTS = { createEvidenceDirectory, writeFile, appendFile, realpath, statfs, safeDirectory, mkdtemp, lstat,
  inspectSettled, readJsonFile, absent, readdir, readEvidenceFile, collectProfileManifest, release }

// Tests may supply explicit ports; the CLI always uses real defaults.
export async function runDiagnostic(readiness, ports = {}) {
  const { createEvidenceDirectory, writeFile, appendFile, realpath, statfs, safeDirectory, mkdtemp, lstat,
    inspectSettled, readJsonFile, absent, readdir, readEvidenceFile, collectProfileManifest, release } = { ...SYSTEM_PORTS, ...ports }
  const evidence = await createEvidenceDirectory()
  const runId = `${PROFILE_CONTRACT.schema}:${randomBytes(16).toString('hex')}`
  const save = (name, value) => writeFile(join(evidence, name), encode(value), { mode: 0o600 })
  const errors = [], rows = [], cpu = [], controllers = new Set()
  const resources = { session: null, unsubscribe: null }
  const recorder = createLifecycleRecorder()
  const bodies = createEvidenceBodyStore((name, bytes) => writeFile(join(evidence, name), bytes, { mode: 0o600, flag: 'wx' }))
  let allocated = null, owned = null, pair = null, profiler = null, sceneBinding = null, scenarioSha256 = null, finished = false, inFlight = false, aborted = null, lastActual = null
  let instrumentationSettled = true, sourceStatus = 'UNTESTED', workspaceStatus = 'UNTESTED', profileBudget = { count: 0, bytes: 0 }
  const deadlineNs = process.hrtime.bigint() + BigInt(PROFILE_CONTRACT.internalDeadlineMs) * 1_000_000n
  const stop = (signal) => { aborted ??= `Interrupted by ${signal}; no new workload admission. Workspace retained by design.` }
  const term = () => stop('SIGTERM'), interrupt = () => stop('SIGINT')
  process.once('SIGTERM', term); process.once('SIGINT', interrupt)
  const timer = setTimeout(() => stop('internal deadline'), PROFILE_CONTRACT.internalDeadlineMs)
  const checkAdmission = () => {
    if (process.hrtime.bigint() >= deadlineNs) stop('internal deadline')
    if (aborted) throw new Error(aborted)
  }
  const operation = async (call) => {
    checkAdmission()
    if (owned) assert.ok(matchesWorkspaceIdentity(owned, await observeOwned(owned.path), owned), 'Workspace ownership changed before operation.')
    checkAdmission(); assert.equal(inFlight, false); inFlight = true
    try { return await call() } finally { inFlight = false }
  }
  const observeOwned = async (path) => {
    const info = await lstat(path, { bigint: true })
    return { path, realPath: await realpath(path), dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid),
      isDirectory: info.isDirectory(), isSymbolicLink: info.isSymbolicLink() }
  }
  const inspect = async (workspace, projectKey, command) => {
    assert.ok(matchesWorkspaceIdentity(owned, await observeOwned(workspace), owned), 'Workspace ownership changed before custody.')
    return inspectSettled(workspace, projectKey, { safeDirectory, readdir, absent,
      readBytes: (path, maximum) => readEvidenceFile(workspace, path, maximum), retainBytes: bodies.retainBytes,
      recordFile: (file) => appendFile(join(evidence, 'body-custody.jsonl'), `${JSON.stringify({ command, ...file })}\n`, { mode: 0o600 }) }, sceneBinding)
  }
  const releaseResources = () => {
    const released = releaseProfileResources(resources)
    instrumentationSettled &&= released.settled
    errors.push(...released.errors)
    recorder.finish()
    return released.settled
  }
  const summary = () => ({ schema: PROFILE_CONTRACT.schema, instrumentation: PROFILE_CONTRACT.instrumentation,
    performanceAcceptance: 'NOT_ASSESSED', status: finished && !aborted && !errors.length && sourceStatus === 'PASS' && workspaceStatus === 'WORKSPACE_RETAINED_BY_DESIGN' && cpu.length === 20 ? 'DIAGNOSTIC_COMPLETE' : 'INCOMPLETE',
    runId, evidence, sourceSealSha256: readiness.sourceSealSha256, scenarioSha256, contract: PROFILE_CONTRACT, interpretation: INTERPRETATION,
    functionalStatus: finished ? 'PASS' : errors.length ? 'FAIL' : 'UNTESTED', sourceStatus, workspaceStatus, allocatedWorkspace: allocated, ownedWorkspace: owned,
    successfulSetup: rows.filter((row) => row.phase === 'setup' && row.ok).length,
    successfulProfiledCommands: rows.filter((row) => row.phase === 'profile' && row.ok).length,
    usableProfiles: cpu.length, profileBudget, evidenceBodyBudget: bodies.budget(), interrupted: aborted, errors })
  try {
    await save('summary.json', summary())
    await save('sources-before.json', readiness)
    await save('metadata.json', { runId, startedAt: new Date().toISOString(), cwd: await realpath(process.cwd()), argv: process.argv,
      execArgv: process.execArgv, runtime: readiness.runtime, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '', NODE_PATH: process.env.NODE_PATH ?? '',
      platform: process.platform, architecture: process.arch, osRelease: release(),
      evidenceFilesystemType: String((await statfs(evidence, { bigint: true })).type), workspaceFilesystemType: String((await statfs('/tmp', { bigint: true })).type),
      scope: 'same-process controller/service/default-sync repository; not renderer/IPC/Electron/GPU/crash/power-loss proof',
      captureBoundary: 'Profiler.start completion, hrtime start, unwrapped dispatch settlement, hrtime end, Profiler.stop; observer inside dispatch',
      interSampleWork: 'Profile persistence, builders, full snapshots, receipt assertions and disk inventories outside capture; cache impact uncontrolled.',
      externalEnvelopeRequired: 'Retain exact actual timeout argv/exit/signal, raw streams, Git dirty state and start/end; intended exit is not external termination proof.' })
    // Only this admitted run branch imports application modules.
    const [{ WorldProjectRepository }, { createWorldProjectService }, { createWorldEditorController },
      { buildAddEmptyEntityCommands }, { createDeterministicWorldEditorIdentityGenerator, buildPatchEntityTransformsCommands }] = await (ports.loadApplication?.() ?? Promise.all([
      import('../electron/main/world-project-repository.ts'), import('../src/areas/worlds/worldProjectService.ts'),
      import('../src/areas/worlds/editor/worldEditorController.ts'), import('../src/areas/worlds/editor/worldAuthoringModel.ts'),
      import('../src/areas/worlds/editor/worldEditorCommandBuilders.ts'),
    ]))
    checkAdmission(); await safeDirectory('/tmp')
    checkAdmission()
    const workspace = await mkdtemp(WORKSPACE_PREFIX)
    allocated = { path: workspace }
    workspaceStatus = 'CREATED_IDENTITY_UNCONFIRMED'
    await save('workspace-provisional.json', { ...allocated, status: workspaceStatus, policy: 'RETAIN_BY_DESIGN' })
    const info = await lstat(workspace, { bigint: true })
    const candidate = { token: randomBytes(16).toString('hex'), path: workspace, dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid) }
    const initialOwnership = await observeOwned(workspace)
    assert.ok(matchesWorkspaceIdentity(candidate, initialOwnership, candidate), 'New workspace ownership mismatch.')
    await save('owned-workspace.json', candidate)
    await save('workspace-initial.json', { owned: candidate, observed: initialOwnership, policy: 'RETAIN_BY_DESIGN' })
    owned = candidate
    const makePair = () => {
      const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace })
      const service = createWorldProjectService(repository), controller = createWorldEditorController(service)
      controllers.add(controller)
      return { repository, service, controller }
    }
    pair = makePair()
    const createRequest = { name: 'Command latency new v1', initialSceneName: 'Measurement scene' }
    await save('create-request.json', createRequest)
    const createdResult = await operation(() => pair.service.create(createRequest))
    await save('create-result.json', createdResult)
    const created = success(createdResult), projectKey = created.projectKey
    const openResult = await operation(() => pair.controller.openProject(projectKey))
    await save('initial-controller-open.json', openResult); success(openResult)
    const serviceOpen = await operation(() => pair.service.open({ projectKey }))
    await save('initial-service-open.json', serviceOpen)
    assert.deepEqual(success(serviceOpen).snapshot, created.snapshot)
    const initial = pair.controller.getState(), sceneId = initial.activeSceneId
    assert.equal(initial.session.snapshot.project.revision, 0)
    assert.deepEqual(initial.session.snapshot, created.snapshot)
    sceneBinding = pinSceneBinding(projectKey, initial.session.snapshot)
    assert.equal(sceneId, sceneBinding.id)
    await save('scene-binding.json', sceneBinding)
    const identities = createDeterministicWorldEditorIdentityGenerator(PROFILE_CONTRACT.seed)
    const seedCommands = Array.from({ length: 100 }, (_, index) => buildAddEmptyEntityCommands({
      snapshot: initial.session.snapshot, projectKey, activeSceneId: sceneId, identities,
    }, { name: `Entity ${String(index).padStart(3, '0')}` })[0])
    const entityId = seedCommands[0].entity.id
    const scenario = buildProfileScenario({ createRequest, projectKey, projectId: created.snapshot.project.projectId, sceneId, entityId }, seedCommands.map((command) => command.entity))
    scenarioSha256 = hash(encode(scenario))
    await save('scenario.json', scenario); await save('initial-snapshot.json', initial.session.snapshot)
    const transform = (x) => ({ position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
    let finalExpected = null
    for (const plan of scenario.batches) {
      checkAdmission()
      const before = pair.controller.getState()
      const commands = plan.ordinal === 1 ? seedCommands : buildPatchEntityTransformsCommands(before.session.snapshot, sceneId, [{ entityId, transform: transform(plan.position[0]) }])
      const request = { transactionId: plan.transactionId, origin: 'ui', commands }
      const batch = { schema: 'modly.world-command-batch.v1', transactionId: request.transactionId,
        projectId: before.session.snapshot.project.projectId, baseRevision: before.session.snapshot.project.revision, origin: 'ui', commands: structuredClone(commands) }
      assert.equal(batch.baseRevision, plan.baseRevision)
      const authority = { projectKey, projectId: batch.projectId, baseRevision: batch.baseRevision, activeSceneId: sceneId }
      const expected = structuredClone(before.session.snapshot)
      expected.project.revision++
      if (plan.ordinal === 1) expected.scenes[0].entities.push(...seedCommands.map((command) => structuredClone(command.entity)))
      else expected.scenes[0].entities.find((entity) => entity.id === entityId).transform = transform(plan.position[0])
      const input = { phase: plan.phase, index: plan.index, ordinal: plan.ordinal, request, batch, authority, batchSha256: hash(encode(batch)) }
      const name = `${plan.phase}-${String(plan.index).padStart(2, '0')}`
      const row = { schema: PROFILE_CONTRACT.schema, instrumentation: PROFILE_CONTRACT.instrumentation, performanceAcceptance: 'NOT_ASSESSED',
        runId, sourceSealSha256: readiness.sourceSealSha256, scenarioSha256, phase: plan.phase, index: plan.index, ordinal: plan.ordinal,
        baseRevision: batch.baseRevision, transactionId: request.transactionId, batchSha256: input.batchSha256, ok: false }
      await appendFile(join(evidence, 'inputs.jsonl'), `${JSON.stringify(input)}\n`, { mode: 0o600 })
      await save('pending-command.json', { status: 'PENDING', ...input })
      await save(`${name}-input.json`, { input, expected, before: before.session.snapshot })
      const commandErrors = []
      const retainError = (error, stage) => { const record = errorRecord(error, `${name}:${stage}`); commandErrors.push(record); errors.push(record) }
      const attempt = async (stage, call) => { try { return await call() } catch (error) { retainError(error, stage); return undefined } }
      let result = null, capture = null, after = null, disk = null
      row.actualCustody = { stateRead: false, observedRetained: false, diskRead: false, diskRetained: false }
      try {
        if (plan.phase === 'profile') {
          if (!profiler) {
            const { Session } = await (ports.loadInspector?.() ?? import('node:inspector'))
            resources.session = new Session(); resources.session.connect()
            const session = resources.session
            profiler = { post: (method, params = {}) => new Promise((fulfill, reject) => session.post(method, params, (error, value) => error ? reject(error) : fulfill(value))) }
            await profiler.post('Profiler.enable')
            await profiler.post('Profiler.setSamplingInterval', { interval: PROFILE_CONTRACT.samplingIntervalUs })
            resources.unsubscribe = pair.controller.subscribe(recorder.listener)
          }
          assert.ok(matchesWorkspaceIdentity(owned, await observeOwned(workspace), owned), 'Workspace ownership changed before profiled dispatch.')
          inFlight = true
          try {
            capture = await captureProfiledDispatch({ profiler, recorder, checkAdmission,
              operation: () => pair.controller.dispatchCommands(request, authority) })
          } finally { inFlight = false }
          const { profile, ...captured } = capture
          Object.assign(row, captured)
          result = capture.result
          for (const error of capture.errors) { commandErrors.push(error); errors.push(error) }
          await attempt('capture-write', () => save(`${name}-capture.json`, captured))
          if (profile) {
            await attempt('profile-write', async () => {
              const bytes = encode(profile), byteLength = Buffer.byteLength(bytes)
              row.profile = { file: `${name}.cpuprofile`, byteLength, sha256: hash(bytes), retained: false }
              profileBudget = reserveProfileArtifact(profileBudget, byteLength)
              await writeFile(join(evidence, row.profile.file), bytes, { mode: 0o600, flag: 'wx' })
              row.profile.retained = true
            })
            await attempt('profile-reduction', async () => {
              const reduced = reduceCpuProfile(profile)
              await save(`${name}-cpu.json`, reduced)
              if (row.profile?.retained) cpu.push(reduced)
            })
          } else retainError(new Error('Missing CPU profile.'), 'profile-missing')
          row.wall = await attempt('lifecycle', () => lifecycleBrackets(capture, batch.baseRevision))
        } else {
          await operation(async () => {
            row.operationStarted = true; row.operationSettled = false
            try { result = await pair.controller.dispatchCommands(request, authority) }
            finally { row.operationSettled = true }
          })
        }
      } catch (error) { retainError(error, 'dispatch-or-profiler-setup') }
      if (commandErrors.length) releaseResources()
      // Post-settlement custody is independent of every profiler/reducer/evidence failure above.
      row.result = result
      if (row.operationStarted && row.operationSettled) {
        after = await attempt('state-read', () => pair.controller.getState())
        if (after) {
          row.actualCustody.stateRead = true
          const actual = { result, publicReceipt: result?.value?.receipt ?? null,
            localReceipt: after.session?.receipts.at(-1) ?? null, snapshot: after.session?.snapshot ?? null,
            savedRevision: after.savedRevision, lifecycle: after.lifecycle,
            history: after.session ? { undo: after.session.undoStack.length, redo: after.session.redoStack.length, receipts: after.session.receipts.length } : null }
          lastActual = { command: name, actual, disk: null }
          await attempt('observed-write', async () => {
            await save(`${name}-observed.json`, actual)
            row.actualCustody.observedRetained = true
          })
        }
        disk = await attempt('disk-read', () => inspect(workspace, projectKey, name))
        if (disk) {
          row.actualCustody.diskRead = true
          if (lastActual?.command === name) lastActual.disk = disk
          await attempt('disk-write', async () => { await save(`${name}-disk.json`, disk); row.actualCustody.diskRetained = true })
        }
      }
      await attempt('actual-validation', () => {
        assert.ok(Object.values(row.actualCustody).every(Boolean), 'Mandatory actual custody incomplete.')
        const value = success(result)
        assert.equal(value.idempotent, false); assert.equal(value.revision, expected.project.revision)
        assert.equal(value.transactionId, request.transactionId); assert.equal(value.receipt.transactionId, request.transactionId)
        assertState(after, expected, plan.ordinal)
        const localReceipt = after.session.receipts.at(-1)
        assert.deepEqual(JSON.parse(localReceipt.canonicalPayload), batch)
        assert.equal(hash(localReceipt.canonicalPayload), value.receipt.payloadSha256)
        assert.equal(localReceipt.appliedRevision, value.receipt.appliedRevision)
        assertDisk(disk, expected, value.receipt)
        row.revision = value.revision; row.receipt = value.receipt; row.warnings = value.warnings
        row.ledgerCount = disk.state.transactions.length; row.backupCount = disk.backups.length
        checkAdmission()
      })
      row.errors = commandErrors
      await attempt('pending-write', () => save('pending-command.json', { status: row.operationSettled ? 'SETTLED' : 'NOT_SETTLED', ...input, actualCustody: row.actualCustody, errors: commandErrors }))
      row.ok = commandErrors.length === 0
      rows.push(row)
      await attempt('row-write', () => appendFile(join(evidence, 'raw-rows.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 }))
      await attempt('summary-write', () => save('summary.json', summary()))
      row.ok = commandErrors.length === 0
      assert.equal(commandErrors.length, 0, `${name} incomplete; original independent failures retained.`)
      finalExpected = expected
    }
    assert.equal(cpu.length, 20)
    await save('cpu-aggregate.json', aggregateCpuSummaries(cpu))
    assert.equal(releaseResources(), true, 'Instrumentation did not settle.')
    success(await operation(() => pair.controller.closeProject())); controllers.delete(pair.controller); pair = null
    pair = makePair()
    const reopened = await operation(() => pair.controller.openProject(projectKey))
    await save('fresh-controller-open.json', reopened); success(reopened)
    const reopenedState = pair.controller.getState()
    await save('reopened-state.json', reopenedState); await save('expected-reopened-snapshot.json', finalExpected)
    assert.equal(finalExpected.project.revision, 52); assertState(reopenedState, finalExpected, 0)
    const freshServiceOpen = await operation(() => pair.service.open({ projectKey }))
    await save('fresh-service-open.json', freshServiceOpen)
    assert.deepEqual(success(freshServiceOpen).snapshot, finalExpected)
    const disk = await inspect(workspace, projectKey, 'reopened')
    await save('reopened-disk.json', disk); assertDisk(disk, finalExpected)
    checkAdmission(); finished = true
  } catch (error) { errors.push(errorRecord(error, 'diagnostic')) }
  finally {
    releaseResources()
    let settled = !inFlight && instrumentationSettled
    if (lastActual) {
      try { await save('last-settled-actual.json', lastActual) }
      catch (error) { errors.push(errorRecord(error, 'last-actual-write')) }
    }
    for (const controller of controllers) {
      try { success(await controller.closeProject()) }
      catch (error) { settled = false; errors.push(errorRecord(error, 'controller-close')) }
    }
    pair = null
    try {
      const after = await collectProfileManifest()
      await save('sources-after.json', after)
      assert.equal(after.sourceSealSha256, readiness.sourceSealSha256, 'Source changed during diagnostic.')
      sourceStatus = 'PASS'
    } catch (error) { sourceStatus = 'FAIL'; errors.push(errorRecord(error, 'source-finalization')) }
    if (owned) {
      const retention = await finalizeOwnedWorkspace(owned, { settled, interrupted: Boolean(aborted), isInterrupted: () => Boolean(aborted) }, {
        readOwnership: () => readJsonFile(join(evidence, 'owned-workspace.json')),
        observe: observeOwned, save,
      })
      workspaceStatus = retention.status
      errors.push(...retention.errors)
      if (!settled) errors.push({ stage: 'settlement', message: 'Operations or instrumentation did not settle.' })
    } else {
      workspaceStatus = allocated ? 'CREATED_IDENTITY_UNCONFIRMED' : 'NOT_CREATED'
      try { await save('workspace-final.json', { status: workspaceStatus, allocated, owned: null, errors, policy: 'RETAIN_BY_DESIGN' }) }
      catch (error) { errors.push(errorRecord(error, 'workspace-final-write')) }
    }
    clearTimeout(timer)
    process.removeListener('SIGTERM', term); process.removeListener('SIGINT', interrupt)
  }
  const result = summary()
  result.exitCode = result.status === 'DIAGNOSTIC_COMPLETE' ? 0 : 1
  for (const [name, value] of [['errors.json', errors], ['summary.json', result]]) {
    try { await save(name, value) }
    catch (error) { errors.push(errorRecord(error, `final-write:${name}`)); result.status = 'INCOMPLETE'; result.exitCode = 1 }
  }
  try { await writeFile(join(evidence, 'intended-exit-code.txt'), `${result.exitCode}\n`, { mode: 0o600 }) }
  catch (error) { errors.push(errorRecord(error, 'intended-exit-write')); result.status = 'INCOMPLETE'; result.exitCode = 1 }
  return result
}

async function main(args) {
  const options = parseArguments(args)
  if (options.mode === 'help') {
    process.stdout.write('Usage: worlds-command-profile.mjs --report-only | --run --seal-sha256 <reviewed diagnostic SHA-256>\n')
    return 0
  }
  const readiness = await collectProfileManifest()
  if (options.mode === 'report-only') {
    process.stdout.write(encode(createProfileReportOnly(readiness)))
    return 0
  }
  validateProfileAdmission(options, readiness, { cwd: await realpath(process.cwd()), executable: await realpath(process.execPath),
    version: process.version, execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '', nodePath: process.env.NODE_PATH ?? '' })
  const result = await runDiagnostic(readiness)
  process.stdout.write(encode(result))
  return result.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(encode({ schema: PROFILE_CONTRACT.schema, status: 'INCOMPLETE', performanceAcceptance: 'NOT_ASSESSED',
      functionalStatus: 'UNTESTED', error: errorRecord(error), exitCode: 1 }))
    process.exitCode = 1
  })
}
