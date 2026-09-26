// Importing this module never imports application code or starts an observation.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { release } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REQUIRED_NODE_VERSION = 'v24.14.1'
const LOADER = join(ROOT, 'scripts/node-ts-extensionless-loader.mjs')
const EVIDENCE_BASE = join(ROOT, 'docs/worlds-engine-evidence/2026-09-09/backup-semantic-bridge')
const WORKSPACE_PREFIX = '/tmp/modly-worlds-command-latency-new-'
const CPU_PROFILE_BASE = join(ROOT, 'docs/worlds-engine-evidence/2026-09-12/command-latency-cpu-profile')
const CPU_PROFILE_FILENAME = 'worlds-command-latency.cpuprofile'
const CPU_PROFILE_OWNER_FILENAME = 'owned-cpu-profile.json'
const NS_PATTERN = /^(0|[1-9][0-9]*)$/
const SEAL_PATTERN = /^[a-f0-9]{64}$/
const LIMIT_NS = 50_000_000n
export const SCENARIO = Object.freeze({
  schema: 'worlds-command-latency-new-v1', historicalComparison: false,
  entities: 100, setupBatches: 32, measuredBatches: 20, thresholdNs: String(LIMIT_NS),
  seed: 'worlds-command-latency-new-v1', deadlineMs: 170_000, outerDeadlineSeconds: 180,
  instrumentation: 'none', repositoryApplyNs: null,
})
export const STAGE_DIAGNOSTIC = Object.freeze({ schema: 'worlds-command-stage-diagnostic.v1',
  instrumentation: 'same-hrtime-stage-wall-thread-process-cpu', sampleComparability: 'NON_COMPARABLE_DIAGNOSTIC',
  thresholdNs: null, gainAcceptance: null, maxMarkers: 48, maxDispatches: 20,
  clock: 'process.hrtime.bigint', cpuUnits: 'microseconds', cpuSkew: 'per-read hrtime brackets',
  attribution: 'coarse exclusive wall stages; CPU snapshots are skewed, not I/O or fsync attribution' })
export const NESTED_BACKUP_DIAGNOSTIC = Object.freeze({ ...STAGE_DIAGNOSTIC, schema: 'worlds-command-stage-diagnostic.v2',
  split: 'createBackup-final-verifyBackupPackage-only',
  grammar: 'v1 with exactly one entry/settled pair between after-package and backup-created; rejected prefix includes awaited verifier settlement; duplicate/reentrant/concurrent calls fail',
  attribution: 'exclusive nested backup wall envelopes; skewed CPU snapshots are not causal CPU, I/O, fsync or gain proof' })
export const FINE_BACKUP_DIAGNOSTIC = Object.freeze({ ...STAGE_DIAGNOSTIC, schema: 'worlds-command-stage-diagnostic.v3',
  instrumentation: 'same-hrtime-stage-wall-thread-process-cpu+backup-cost-observer',
  thresholdGainUnder50Ms: null, maxRecordsPerDispatch: 8192,
  profile: Object.freeze({ entities: 100, setupBatches: 32, measuredBatches: 20, fileSync: 'default', directorySync: 'default' }),
  split: 'operation-local-backup-cost-spans',
  grammar: 'v1 outer markers plus one contiguous paired backup-cost invocation; root envelope settles before an optional terminal observer-fault; pending, late, duplicate, reentrant or concurrent association fails',
  attribution: 'inclusive parent spans plus overlap-safe interval union, overlap, maximum concurrency and residual; awaited wall includes scheduler delay and is not causal gain proof' })

const FINE_BACKUP_PHASES = Object.freeze(['prior-proof', 'copy-package', 'pack-ledger', 'index', 'seal-sync'])
const FINE_BACKUP_KINDS = Object.freeze(['envelope', 'bounded-read', 'read-await', 'write-file', 'write-positional',
  'file-sync', 'directory-sync', 'utf8-decode', 'json-parse', 'validate', 'canonical-parse', 'canonical-encode',
  'replay', 'encode-buffer', 'hash', 'copy', 'proof-lookup', 'metadata', 'cache-hit', 'cache-miss',
  'cache-admit', 'cache-evict'])
const FINE_BACKUP_TARGETS = Object.freeze(['project', 'scene', 'state', 'receipt', 'pack', 'index', 'directory'])
const FINE_BACKUP_KEYS = Object.freeze(['schema', 'invocation', 'sequence', 'span', 'parent', 'phase', 'kind',
  'edge', 'ns', 'ledgerIndex', 'appliedRevision', 'target', 'requestedBytes', 'completedBytes', 'sourceBytes',
  'calls', 'outcome', 'durable'].sort())
const FINE_BACKUP_FAULTS = new Set(['RECORD_BOUND', 'RECORD_SCHEMA', 'SEQUENCE', 'INVOCATION', 'CLOCK',
  'PAIRING', 'ROOT', 'TERMINAL', 'OBSERVER_FAULT', 'LEDGER_ORDER'])

function fineBackupFail(code) { throw code }
function fineBackupAssert(condition, code) { if (!condition) fineBackupFail(code) }
function fineBackupInteger(value, nullable = false) {
  return (nullable && value === null) || (Number.isSafeInteger(value) && value >= 0)
}
function copyFineBackupRecord(record) {
  fineBackupAssert(record !== null && typeof record === 'object' && !Array.isArray(record), 'RECORD_SCHEMA')
  fineBackupAssert(Object.getPrototypeOf(record) === Object.prototype && Object.isFrozen(record), 'RECORD_SCHEMA')
  const keys = Reflect.ownKeys(record)
  fineBackupAssert(keys.every((key) => typeof key === 'string') && keys.length === FINE_BACKUP_KEYS.length, 'RECORD_SCHEMA')
  fineBackupAssert(keys.map(String).sort().every((key, index) => key === FINE_BACKUP_KEYS[index]), 'RECORD_SCHEMA')
  const descriptors = Object.getOwnPropertyDescriptors(record)
  fineBackupAssert(FINE_BACKUP_KEYS.every((key) => descriptors[key] && 'value' in descriptors[key]), 'RECORD_SCHEMA')
  const value = Object.fromEntries(FINE_BACKUP_KEYS.map((key) => [key, descriptors[key].value]))
  fineBackupAssert(value.schema === 'modly.world-backup-cost.v1', 'RECORD_SCHEMA')
  fineBackupAssert(Number.isSafeInteger(value.invocation) && value.invocation > 0, 'RECORD_SCHEMA')
  fineBackupAssert(Number.isSafeInteger(value.sequence) && value.sequence > 0, 'RECORD_SCHEMA')
  fineBackupAssert(Number.isSafeInteger(value.span) && value.span >= 0, 'RECORD_SCHEMA')
  fineBackupAssert(value.parent === null || (Number.isSafeInteger(value.parent) && value.parent > 0), 'RECORD_SCHEMA')
  fineBackupAssert(FINE_BACKUP_PHASES.includes(value.phase), 'RECORD_SCHEMA')
  fineBackupAssert(FINE_BACKUP_KINDS.includes(value.kind) || value.kind === 'observer-fault', 'RECORD_SCHEMA')
  fineBackupAssert(value.edge === 'begin' || value.edge === 'settled', 'RECORD_SCHEMA')
  fineBackupAssert(typeof value.ns === 'string' && NS_PATTERN.test(value.ns), 'RECORD_SCHEMA')
  fineBackupAssert(fineBackupInteger(value.ledgerIndex, true) && fineBackupInteger(value.appliedRevision, true), 'RECORD_SCHEMA')
  fineBackupAssert(FINE_BACKUP_TARGETS.includes(value.target), 'RECORD_SCHEMA')
  for (const key of ['requestedBytes', 'completedBytes', 'sourceBytes']) fineBackupAssert(fineBackupInteger(value[key], true), 'RECORD_SCHEMA')
  fineBackupAssert(Number.isSafeInteger(value.calls) && value.calls >= 0, 'RECORD_SCHEMA')
  fineBackupAssert(['pending', 'fulfilled', 'rejected'].includes(value.outcome), 'RECORD_SCHEMA')
  fineBackupAssert(value.durable === null || typeof value.durable === 'boolean', 'RECORD_SCHEMA')
  return Object.freeze(value)
}

function blankFineBackupKinds() {
  return Object.fromEntries(FINE_BACKUP_KINDS.map((kind) => [kind, { begun: 0, settled: 0, inclusiveNs: '0',
    calls: 0, requestedBytes: '0', completedBytes: '0', sourceBytes: '0' }]))
}
function blankFineBackupPhases() {
  return Object.fromEntries(FINE_BACKUP_PHASES.map((phase) => [phase, { spanCount: 0, inclusiveNs: '0' }]))
}
function freezeFineBackupSummary(value) {
  for (const entry of Object.values(value.kinds)) Object.freeze(entry)
  for (const entry of Object.values(value.phases)) Object.freeze(entry)
  Object.freeze(value.kinds); Object.freeze(value.phases)
  for (const key of ['cache', 'bytes', 'priorProof', 'boundedRead']) Object.freeze(value[key])
  if (value.root) Object.freeze(value.root)
  return Object.freeze(value)
}
function emptyFineBackupSummary(faultCode, recordCount = 0) {
  return freezeFineBackupSummary({ schema: 'worlds-command-backup-cost-summary.v1', status: 'FAIL', faultCode,
    invocation: null, recordCount: Math.min(Number.isSafeInteger(recordCount) && recordCount >= 0 ? recordCount : 0, 8192),
    logicalSpanCount: 0, terminalFault: faultCode === 'OBSERVER_FAULT', root: null,
    phases: blankFineBackupPhases(), kinds: blankFineBackupKinds(),
    cache: { hits: 0, misses: 0, admits: 0, evicts: 0 },
    bytes: { requested: '0', completed: '0', source: '0' },
    priorProof: { spanCount: 0, intervalUnionNs: '0', overlapNs: '0', maxConcurrency: 0, residualNs: '0' },
    boundedRead: { spanCount: 0, inclusiveNs: '0', childUnionNs: '0', residualNs: '0' } })
}
function intervalAccounting(intervals) {
  if (!intervals.length) return { intervalUnionNs: 0n, overlapNs: 0n, maxConcurrency: 0, residualNs: 0n }
  const ordered = intervals.map(([start, end]) => [start, end]).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : 1)
  let union = 0n, cursorStart = ordered[0][0], cursorEnd = ordered[0][1], maxEnd = ordered[0][1], inclusive = 0n
  const events = []
  for (const [start, end] of ordered) {
    inclusive += end - start; events.push([start, 1], [end, -1])
    if (end > maxEnd) maxEnd = end
    if (start > cursorEnd) { union += cursorEnd - cursorStart; cursorStart = start; cursorEnd = end }
    else if (end > cursorEnd) cursorEnd = end
  }
  union += cursorEnd - cursorStart
  events.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] - right[1])
  let concurrency = 0, maxConcurrency = 0
  for (const [, delta] of events) { concurrency += delta; if (concurrency > maxConcurrency) maxConcurrency = concurrency }
  return { intervalUnionNs: union, overlapNs: inclusive - union, maxConcurrency,
    residualNs: maxEnd - ordered[0][0] - union }
}

export function summarizeFineBackupRecords(input) {
  if (!Array.isArray(input)) return emptyFineBackupSummary('RECORD_SCHEMA')
  if (input.length > FINE_BACKUP_DIAGNOSTIC.maxRecordsPerDispatch) return emptyFineBackupSummary('RECORD_BOUND', input.length)
  if (!input.length) return emptyFineBackupSummary('ROOT')
  try {
    const records = input.map(copyFineBackupRecord), pending = new Map(), completed = [], begunSpans = new Set()
    let invocation = null, lastNs = null, rootSpan = null, root = null, terminalFault = false
    for (const [index, record] of records.entries()) {
      fineBackupAssert(record.sequence === index + 1, 'SEQUENCE')
      if (invocation === null) invocation = record.invocation
      else fineBackupAssert(record.invocation === invocation, 'INVOCATION')
      const ns = BigInt(record.ns)
      fineBackupAssert(lastNs === null || ns >= lastNs, 'CLOCK'); lastNs = ns
      if (record.kind === 'observer-fault') {
        fineBackupAssert(index === records.length - 1, 'TERMINAL')
        fineBackupAssert(root !== null && pending.size === 0 && record.span === 0 && record.parent === null
          && record.phase === 'prior-proof' && record.edge === 'settled' && record.target === 'directory'
          && record.ledgerIndex === null && record.appliedRevision === null && record.requestedBytes === null
          && record.completedBytes === null && record.sourceBytes === null && record.calls === 0
          && record.outcome === 'rejected' && record.durable === null, 'TERMINAL')
        terminalFault = true; continue
      }
      fineBackupAssert(root === null || root.settled !== true, 'TERMINAL')
      if (record.edge === 'begin') {
        fineBackupAssert(record.span > 0 && !begunSpans.has(record.span) && record.outcome === 'pending'
          && record.completedBytes === null && record.calls === 0 && record.durable === null, 'PAIRING')
        if (index === 0) {
          fineBackupAssert(record.kind === 'envelope' && record.parent === null, 'ROOT')
          rootSpan = record.span
        } else {
          fineBackupAssert(record.kind !== 'envelope' && record.parent !== null && pending.has(record.parent), 'PAIRING')
        }
        begunSpans.add(record.span); pending.set(record.span, { begin: record, start: ns }); continue
      }
      fineBackupAssert(record.outcome !== 'pending' && pending.has(record.span), 'PAIRING')
      const span = pending.get(record.span), begin = span.begin
      for (const key of ['span', 'parent', 'phase', 'kind', 'ledgerIndex', 'appliedRevision', 'target', 'requestedBytes'])
        fineBackupAssert(record[key] === begin[key], 'PAIRING')
      fineBackupAssert(ns >= span.start, 'CLOCK')
      pending.delete(record.span)
      const settled = { begin, settled: record, start: span.start, end: ns, duration: ns - span.start }
      completed.push(settled)
      if (record.span === rootSpan) {
        fineBackupAssert(record.kind === 'envelope' && record.parent === null && pending.size === 0, 'ROOT')
        root = { settled: true, span: record.span, durationNs: String(settled.duration), outcome: record.outcome, durable: record.durable }
      }
    }
    fineBackupAssert(root !== null && pending.size === 0, 'PAIRING')
    const kinds = blankFineBackupKinds(), phases = blankFineBackupPhases()
    let requested = 0n, completedBytes = 0n, source = 0n
    for (const span of completed) {
      const kind = kinds[span.begin.kind], phase = phases[span.begin.phase]
      kind.begun++; kind.settled++; kind.inclusiveNs = String(BigInt(kind.inclusiveNs) + span.duration)
      kind.calls += span.settled.calls
      kind.requestedBytes = String(BigInt(kind.requestedBytes) + BigInt(span.begin.requestedBytes ?? 0))
      kind.completedBytes = String(BigInt(kind.completedBytes) + BigInt(span.settled.completedBytes ?? 0))
      kind.sourceBytes = String(BigInt(kind.sourceBytes) + BigInt(span.settled.sourceBytes ?? 0))
      phase.spanCount++; phase.inclusiveNs = String(BigInt(phase.inclusiveNs) + span.duration)
      requested += BigInt(span.begin.requestedBytes ?? 0); completedBytes += BigInt(span.settled.completedBytes ?? 0)
      source += BigInt(span.settled.sourceBytes ?? 0)
    }
    const rootCompleted = completed.find((span) => span.begin.span === rootSpan)
    const priorIntervals = completed.filter((span) => span.begin.span !== rootSpan
      && span.begin.parent === rootSpan && span.begin.phase === 'prior-proof').map((span) => [span.start, span.end])
    const prior = intervalAccounting(priorIntervals)
    const bounded = completed.filter((span) => span.begin.kind === 'bounded-read')
    let boundedInclusive = 0n, boundedChildUnion = 0n
    for (const span of bounded) {
      boundedInclusive += span.duration
      boundedChildUnion += intervalAccounting(completed.filter((child) => child.begin.parent === span.begin.span)
        .map((child) => [child.start, child.end])).intervalUnionNs
    }
    const ledgerGroups = new Map()
    for (const span of completed.filter((candidate) => candidate.begin.phase === 'pack-ledger'
      && candidate.begin.parent === rootSpan && candidate.begin.ledgerIndex !== null)) {
      const group = ledgerGroups.get(span.begin.ledgerIndex)
      if (!group) ledgerGroups.set(span.begin.ledgerIndex, { start: span.start, end: span.end })
      else { if (span.start < group.start) group.start = span.start; if (span.end > group.end) group.end = span.end }
    }
    const ledgers = [...ledgerGroups].sort((left, right) => left[1].start < right[1].start ? -1 : left[1].start > right[1].start ? 1 : 0)
    for (const [index, entry] of ledgers.entries()) {
      fineBackupAssert(entry[0] === index, 'LEDGER_ORDER')
      if (index) fineBackupAssert(ledgers[index - 1][1].end <= entry[1].start, 'LEDGER_ORDER')
    }
    const cache = { hits: kinds['cache-hit'].settled, misses: kinds['cache-miss'].settled,
      admits: kinds['cache-admit'].settled, evicts: kinds['cache-evict'].settled }
    return freezeFineBackupSummary({ schema: 'worlds-command-backup-cost-summary.v1',
      status: terminalFault ? 'FAIL' : 'PASS', faultCode: terminalFault ? 'OBSERVER_FAULT' : null, invocation,
      recordCount: records.length, logicalSpanCount: completed.length, terminalFault,
      root: { span: rootCompleted.begin.span, durationNs: String(rootCompleted.duration),
        outcome: rootCompleted.settled.outcome, durable: rootCompleted.settled.durable }, phases, kinds, cache,
      bytes: { requested: String(requested), completed: String(completedBytes), source: String(source) },
      priorProof: { spanCount: priorIntervals.length, intervalUnionNs: String(prior.intervalUnionNs),
        overlapNs: String(prior.overlapNs), maxConcurrency: prior.maxConcurrency, residualNs: String(prior.residualNs) },
      boundedRead: { spanCount: bounded.length, inclusiveNs: String(boundedInclusive), childUnionNs: String(boundedChildUnion),
        residualNs: String(boundedInclusive - boundedChildUnion) } })
  } catch (faultCode) {
    return emptyFineBackupSummary(FINE_BACKUP_FAULTS.has(faultCode) ? faultCode : 'RECORD_SCHEMA', input.length)
  }
}

function admitStageRuntime(runtime) {
  assert.equal(runtime.version, 'v24.14.1', 'Stage diagnostic requires exact Node v24.14.1.')
  for (const fn of [runtime.hrtime?.bigint, runtime.threadCpuUsage, runtime.cpuUsage]) assert.equal(typeof fn, 'function', 'Stage diagnostic CPU/clock API unavailable.')
}

// This observer exists only in explicit diagnostic mode; callbacks never change publication.
export function createStageDiagnostic(descriptor, identity, runtime = process) {
  if (descriptor === undefined) return null
  const nested = descriptor.schema === NESTED_BACKUP_DIAGNOSTIC.schema
  const fine = descriptor.schema === FINE_BACKUP_DIAGNOSTIC.schema
  const scoped = nested || fine
  assert.deepEqual(descriptor, fine ? FINE_BACKUP_DIAGNOSTIC : nested ? NESTED_BACKUP_DIAGNOSTIC : STAGE_DIAGNOSTIC); admitStageRuntime(runtime)
  assert.match(identity.sourceSealSha256, SEAL_PATTERN); assert.match(identity.runtime.sha256, SEAL_PATTERN)
  assert.ok(typeof identity.runId === 'string' && identity.runId.length > 0 && identity.runId.length <= 256, 'Invalid diagnostic run identity.')
  assert.equal(identity.runtime.version, runtime.version); assert.ok(Number.isSafeInteger(runtime.pid) && runtime.pid > 0)
  let active = null, lastRecord = null, count = 0
  const seen = new Set()
  const scope = scoped ? new AsyncLocalStorage() : null
  let installError = null
  const fineInvocations = new Set()
  function faultDetail(value) {
    try {
      const detail = typeof value === 'string' ? value : value?.message
      if (typeof detail === 'string' && detail.length > 0) return detail.slice(0, 512)
    } catch { /* Error getters are not trusted; never coerce an external object. */ }
    return 'Diagnostic fault; detail unavailable.'
  }
  const fault = (message, record = active) => { if (record) record.error ??= faultDetail(message) }
  function successful(result, record = active) {
    if (!scoped) return result?.ok !== false
    try { return result?.ok !== false } catch (error) { fault(`Outcome observer failed: ${faultDetail(error)}`, record); return false }
  }
  function mark(stage) {
    if (!active) return
    if (scoped && scope.getStore() && scope.getStore() !== active.repositoryToken && scope.getStore() !== active.backupToken) return
    if (active.markers.length >= descriptor.maxMarkers) { fault('Marker bound exceeded.'); return }
    try {
      if (scoped && (typeof stage !== 'string' || stage.length > 512)) { fault('Nonprimitive or oversized marker.'); stage = 'invalid-marker' }
      const threadBefore = runtime.hrtime.bigint(), thread = runtime.threadCpuUsage(), threadAfter = runtime.hrtime.bigint()
      const processBefore = runtime.hrtime.bigint(), processCpu = runtime.cpuUsage(), processAfter = runtime.hrtime.bigint()
      active.markers.push({ stage, ns: String(threadBefore),
        thread: { beforeNs: String(threadBefore), afterNs: String(threadAfter), user: String(thread.user), system: String(thread.system) },
        process: { beforeNs: String(processBefore), afterNs: String(processAfter), user: String(processCpu.user), system: String(processCpu.system) } })
    } catch (error) { fault(`Marker API failed: ${faultDetail(error)}`) }
  }
  function finish() {
    if (fine) {
      active.fineBackup = active.fineCollectionFault
        ? emptyFineBackupSummary(active.fineCollectionFault, active.fineRecords.length)
        : summarizeFineBackupRecords(active.fineRecords)
      if (active.fineBackup.status !== 'PASS') fault(`Fine backup diagnostic failed: ${active.fineBackup.faultCode}.`)
    }
    try {
      assert.equal(active.error, null, active.error)
      const expected = ['dispatch-start', 'repository-entry', 'root-lock-directory-created', 'after-package',
        ...(nested ? ['backup-final-verification-entry', 'backup-final-verification-settled'] : []), 'backup-created', 'journal-published',
        ...active.documents.map((path) => `document-published:${path}`), 'state-published', 'removed-scenes-cleaned', 'journal-cleaned', 'repository-settled', 'dispatch-settled']
      const actual = active.markers.map((marker) => marker.stage)
      if (active.repositorySuccess && active.dispatchSuccess) assert.deepEqual(actual, expected, 'Missing, duplicate or unexpected marker.')
      else {
        assert.deepEqual(actual.slice(-2), ['repository-settled', 'dispatch-settled'], 'Missing rejection settlement.')
        assert.deepEqual(actual.slice(0, -2), expected.slice(0, actual.length - 2), 'Invalid rejected publication prefix.')
      }
      active.exclusive = []
      for (const [i, marker] of active.markers.entries()) {
        const ns = duration(marker.ns), threadAfter = duration(marker.thread.afterNs), processBefore = duration(marker.process.beforeNs), processAfter = duration(marker.process.afterNs)
        assert.ok(ns <= threadAfter && threadAfter <= processBefore && processBefore <= processAfter, 'Invalid CPU-read brackets.')
        for (const scope of ['thread', 'process']) for (const key of ['user', 'system']) {
          duration(marker[scope][key]); assert.ok(Number.isSafeInteger(Number(marker[scope][key])), 'Unsafe CPU integer.')
        }
        if (!i) continue
        const previous = active.markers[i - 1]
        assert.ok(ns > duration(previous.process.afterNs), 'Nonmonotonic/overlapping markers.')
        const segment = { from: previous.stage, to: marker.stage, wallNs: String(ns - duration(previous.ns)), thread: {}, process: {} }
        for (const scope of ['thread', 'process']) for (const key of ['user', 'system']) {
          const delta = duration(marker[scope][key]) - duration(previous[scope][key])
          assert.ok(delta >= 0n, 'Negative CPU delta.'); segment[scope][key] = String(delta)
        }
        active.exclusive.push(segment)
      }
      active.status = 'PASS'
    } catch (error) { active.status = 'FAIL'; active.error ??= faultDetail(error); active.exclusive = null }
    lastRecord = active; active = null
  }
  function observeFineBackup(record) {
    if (!fine) return undefined
    const current = active
    if (!current || scope.getStore() !== current.repositoryToken || current.repositoryPending !== 1) return undefined
    if (current.fineRecords.length >= descriptor.maxRecordsPerDispatch) { current.fineCollectionFault ??= 'RECORD_BOUND'; return undefined }
    try {
      const copy = copyFineBackupRecord(record)
      if (current.fineTerminalReceived) { current.fineCollectionFault ??= 'TERMINAL'; return undefined }
      if (current.fineInvocation === null) {
        current.fineInvocation = copy.invocation
        if (fineInvocations.has(copy.invocation)) current.fineCollectionFault ??= 'INVOCATION'
        else fineInvocations.add(copy.invocation)
      } else if (copy.invocation !== current.fineInvocation) current.fineCollectionFault ??= 'INVOCATION'
      if (copy.kind === 'observer-fault') current.fineTerminalReceived = true
      current.fineRecords.push(copy)
    } catch (faultCode) {
      current.fineCollectionFault ??= FINE_BACKUP_FAULTS.has(faultCode) ? faultCode : 'RECORD_SCHEMA'
    }
    return undefined
  }
  return {
    repositoryOptions: fine ? { failureCheckpoint: mark, backupCostObserver: observeFineBackup } : { failureCheckpoint: mark },
    installRepository(repository) {
      let original
      if (scoped) {
        try {
          const invoke = Reflect.apply
          assert.equal(typeof invoke, 'function', `${nested ? 'Nested' : 'Fine'} invocation API unavailable.`)
          const apply = repository.applyCommands
          assert.equal(typeof apply, 'function', `${nested ? 'Nested' : 'Fine'} applyCommands unavailable.`)
          original = apply.bind(repository)
          assert.equal(typeof original, 'function', `${nested ? 'Nested' : 'Fine'} applyCommands binding unavailable.`)
          original = (request) => invoke(apply, repository, [request])
          if (nested) {
            const create = repository.createBackup, verify = repository.verifyBackupPackage
            assert.equal(typeof create, 'function', 'Nested createBackup unavailable.'); assert.equal(typeof verify, 'function', 'Nested verifyBackupPackage unavailable.')
            repository.createBackup = async function (...args) {
              const record = active, context = scope.getStore()
              if (!record || (context !== record.repositoryToken && context !== record.backupToken)) return await invoke(create, this, args)
              if (record.backupCalls++ || record.backupToken) fault('Duplicate/reentrant/concurrent createBackup.')
              const token = Symbol('backup'); record.backupToken = token
              try { return await scope.run(token, () => invoke(create, this, args)) }
              finally { if (record.backupToken === token) record.backupToken = null }
            }
            repository.verifyBackupPackage = async function (...args) {
              const record = active
              if (!record?.backupToken || scope.getStore() !== record.backupToken) return await invoke(verify, this, args)
              if (record.verifierCalls++) fault('Duplicate/reentrant/concurrent final verifier.')
              mark('backup-final-verification-entry')
              try { return await invoke(verify, this, args) }
              finally { if (active === record) mark('backup-final-verification-settled') }
            }
          }
        } catch (error) { installError ??= `${nested ? 'Nested' : 'Fine'} method admission failed: ${faultDetail(error)}`; return false }
      } else original = repository.applyCommands.bind(repository)
      repository.applyCommands = async (request) => {
        if (!active) return original(request)
        const record = active
        if (scoped) {
          if (scope.getStore() || active.repositoryToken) fault('Duplicate/reentrant/concurrent repository call.')
          active.repositoryToken ??= Symbol('repository')
          active.repositoryPending = (active.repositoryPending ?? 0) + 1
        }
        try { if (request.batch?.transactionId !== active.transactionId) fault('Repository transaction association differs.') }
        catch (error) { if (!scoped) throw error; fault(`Association observer failed: ${faultDetail(error)}`) }
        mark('repository-entry')
        try {
          const result = await (scoped ? scope.run(record.repositoryToken, () => original(request)) : original(request)), target = scoped ? record : active
          target.repositorySuccess = successful(result, target); target.repositoryOutcome = 'fulfilled'; return result
        } catch (error) { (scoped ? record : active).repositoryOutcome = 'rejected'; throw error }
        finally { if (scoped) record.repositoryPending--; if (!scoped || active === record) mark('repository-settled') }
      }
      return scoped ? installError === null : undefined
    },
    async dispatch(plan, originalDispatch) {
      assert.ok(!active && !lastRecord && count < descriptor.maxDispatches && plan.phase === 'measure'
        && plan.index === count + 1 && typeof plan.transactionId === 'string' && plan.transactionId.length > 0 && plan.transactionId.length <= 256
        && !seen.has(plan.transactionId), 'Invalid diagnostic association/bound.')
      assert.ok(Array.isArray(plan.documents) && plan.documents[0] === 'project.world-project.json'
        && plan.documents.length >= 2 && plan.documents.length <= 32 && new Set(plan.documents).size === plan.documents.length, 'Invalid stable documents.')
      for (const path of plan.documents.slice(1)) assert.match(path, /^scenes\/scene-[a-f0-9]{32}\.world-scene\.json$/)
      assert.deepEqual(plan.documents.slice(1), [...plan.documents.slice(1)].sort(), 'Stable document order differs.')
      count++; seen.add(plan.transactionId)
      active = { ...descriptor, runId: identity.runId, pid: runtime.pid, nodeVersion: runtime.version, nodeSha256: identity.runtime.sha256,
        sourceSealSha256: identity.sourceSealSha256, transactionId: plan.transactionId, phase: plan.phase, index: plan.index,
        documents: [...plan.documents], markers: [], error: null, repositorySuccess: false, dispatchSuccess: false }
      if (nested) { active.backupCalls = 0; active.verifierCalls = 0 }
      if (fine) { active.fineRecords = []; active.fineInvocation = null; active.fineTerminalReceived = false; active.fineCollectionFault = null }
      if (scoped && installError) fault(installError)
      mark('dispatch-start')
      try { const result = await originalDispatch(); active.dispatchSuccess = successful(result); active.dispatchOutcome = 'fulfilled'; return result }
      catch (error) { active.dispatchOutcome = 'rejected'; throw error }
      finally {
        if (scoped && active.repositoryPending) fault('Controller settled before original repository operation.')
        mark('dispatch-settled')
        if (scoped) { delete active.repositoryToken; delete active.backupToken }
        finish()
      }
    },
    takeRecord() { const record = lastRecord; lastRecord = null; return record },
  }
}

export function parseArguments(args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('An explicit mode is required.')
  if (args.at(-1) === '--diagnostic-fine-backup') {
    const options = parseArguments(args.slice(0, -1))
    assert.ok(options.mode !== 'help' && !options.diagnosticStages && !options.diagnosticNestedBackup
      && !options.diagnosticFineBackup && !options.diagnosticCpuProfileDir, 'Invalid or mixed diagnostic argument.')
    return { ...options, diagnosticFineBackup: true }
  }
  if (args.at(-1) === '--diagnostic-nested-backup') {
    const options = parseArguments(args.slice(0, -1))
    assert.ok(options.mode !== 'help' && !options.diagnosticStages && !options.diagnosticNestedBackup
      && !options.diagnosticFineBackup && !options.diagnosticCpuProfileDir, 'Invalid or mixed diagnostic argument.')
    return { ...options, diagnosticNestedBackup: true }
  }
  if (args.at(-1) === '--diagnostic-stages') {
    const options = parseArguments(args.slice(0, -1))
    assert.ok(options.mode !== 'help' && !options.diagnosticStages && !options.diagnosticNestedBackup
      && !options.diagnosticFineBackup && !options.diagnosticCpuProfileDir, 'Invalid or mixed diagnostic argument.')
    return { ...options, diagnosticStages: true }
  }
  if (args.at(-2) === '--diagnostic-cpu-profile-dir') {
    const path = args.at(-1)
    validateCpuProfilePath(path)
    const options = parseArguments(args.slice(0, -2))
    assert.notEqual(options.mode, 'help', 'Diagnostic argument requires collector or run mode.')
    assert.equal(options.diagnosticCpuProfileDir, undefined, 'Duplicate diagnostic argument.')
    assert.equal(options.diagnosticStages, undefined, 'Mixed diagnostic argument.')
    assert.equal(options.diagnosticNestedBackup, undefined, 'Mixed diagnostic argument.')
    assert.equal(options.diagnosticFineBackup, undefined, 'Mixed diagnostic argument.')
    return { ...options, diagnosticCpuProfileDir: path }
  }
  if (args.length === 1 && args[0] === '--help') return { mode: 'help', sealSha256: null }
  if (args.length === 1 && args[0] === '--report-only') return { mode: 'report-only', sealSha256: null }
  if (args.length === 3 && args[0] === '--run' && args[1] === '--seal-sha256' && SEAL_PATTERN.test(args[2])) {
    return { mode: 'run', sealSha256: args[2] }
  }
  throw new Error('Invalid argument, ambiguous mode, or missing/invalid run seal.')
}

function duration(value) {
  if (typeof value !== 'string' || !NS_PATTERN.test(value)) throw new Error('Invalid integer duration sample.')
  return BigInt(value)
}

export function nearestRank(samples, percentile) {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) throw new Error('Invalid percentile.')
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('Missing duration samples.')
  const sorted = samples.map(duration).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  return String(sorted[Math.ceil(percentile * sorted.length) - 1])
}

export function classifyObservation(rows, gates) {
  let valid = Array.isArray(rows) && rows.length === 20
  try {
    valid &&= rows.every((row, i) => row?.phase === 'measure' && row.index === i + 1 && row.ok === true && duration(row.durationNs) >= 0n)
  } catch { valid = false }
  const base = {
    observationStatus: gates.finished && valid ? 'COMPLETE' : 'INCOMPLETE',
    functionalStatus: gates.functionalStatus, sourceStatus: gates.sourceStatus, cleanupStatus: gates.cleanupStatus,
    sampleCount: Array.isArray(rows) ? rows.length : 0,
    allCommandsUnder50Ms: null, p95Under50Ms: null, metrics: null, exitCode: 1,
    ...(gates.diagnosticCpuProfile ? { instrumentation: 'node-startup-cpu-profile',
      sampleComparability: 'NON_COMPARABLE_DIAGNOSTIC', profileArtifactStatus: 'PENDING_EXIT' } : {}),
    ...(gates.diagnosticStages ? { ...gates.diagnosticStages, stageStatus: gates.stageStatus } : {}),
  }
  if (gates.sourceStatus === 'FAIL') return { ...base, status: 'INVALID_SOURCE' }
  if (!gates.finished) return { ...base, status: 'PARTIAL' }
  if (gates.functionalStatus !== 'PASS') return { ...base, status: 'FUNCTIONAL_FAIL' }
  if (gates.sourceStatus !== 'PASS') return { ...base, status: 'INVALID_SOURCE' }
  if (gates.cleanupStatus !== 'PASS') return { ...base, status: 'CLEANUP_FAIL' }
  if (!valid) return { ...base, status: 'INVALID_SAMPLES' }
  if (gates.diagnosticStages && gates.stageStatus !== 'PASS') return { ...base, status: 'INVALID_DIAGNOSTIC' }
  const samples = rows.map((row) => row.durationNs)
  const p50Ns = nearestRank(samples, 0.5), p95Ns = nearestRank(samples, 0.95), maxNs = nearestRank(samples, 1)
  if (gates.diagnosticCpuProfile || gates.diagnosticStages) return { ...base, status: 'DIAGNOSTIC_WORKLOAD_COMPLETE', exitCode: 0,
    metrics: { p50Ns, p95Ns, maxNs, p50Ms: Number(p50Ns) / 1e6, p95Ms: Number(p95Ns) / 1e6, maxMs: Number(maxNs) / 1e6 } }
  const allCommandsUnder50Ms = samples.every((ns) => duration(ns) < LIMIT_NS)
  return {
    ...base, status: allCommandsUnder50Ms ? 'PASS' : 'LATENCY_FAIL', exitCode: allCommandsUnder50Ms ? 0 : 2,
    allCommandsUnder50Ms, p95Under50Ms: duration(p95Ns) < LIMIT_NS,
    metrics: { p50Ns, p95Ns, maxNs, p50Ms: Number(p50Ns) / 1e6, p95Ms: Number(p95Ns) / 1e6, maxMs: Number(maxNs) / 1e6 },
  }
}

export function canCleanupOwnedWorkspace(owned, observed, options = {}) {
  if (!owned || !observed || options.settled !== true || !/^[a-f0-9]{32}$/.test(owned.token ?? '')) return false
  if (!/^\/tmp\/modly-worlds-command-latency-new-[A-Za-z0-9]{6}$/.test(owned.path ?? '')) return false
  if (!NS_PATTERN.test(owned.dev ?? '') || !NS_PATTERN.test(owned.ino ?? '') || !Number.isSafeInteger(owned.uid) || owned.uid < 0) return false
  return options.durableToken === owned.token && observed.realPath === owned.path
    && observed.isDirectory === true && observed.isSymbolicLink === false
    && ['token', 'path', 'dev', 'ino', 'uid'].every((key) => observed[key] === owned[key])
}

export function buildScenario(identity, entities) {
  assert.equal(entities.length, 100)
  assert.equal(new Set(entities.map((entity) => entity.id)).size, 100)
  return { ...SCENARIO, ...identity, entityCount: 100, entities,
    batches: Array.from({ length: 52 }, (_, index) => ({ ordinal: index + 1, baseRevision: index,
      phase: index < 32 ? 'setup' : 'measure', index: index < 32 ? index + 1 : index - 31,
      transactionId: `tx:latency-new-v1:${index < 32 ? 'setup' : 'measure'}:${String(index < 32 ? index + 1 : index - 31).padStart(2, '0')}`,
      position: index === 0 ? null : [index, 0, 0] })) }
}

// Deliberately supports only the literal ESM syntax in the reviewed closure.
// Unknown imports fail closed instead of introducing another resolver/loader.
export function moduleSpecifiers(source) {
  const imports = [...source.matchAll(/^[ \t]*(import|export)\s+(type\s+)?(\{[^}]*\}|\*\s*(?:as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s*['"]([^'"]+)['"]/gm)]
  const sideEffects = [...source.matchAll(/^[ \t]*import\s*['"]([^'"]+)['"]/gm)]
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
  const staticCount = [...source.matchAll(/^[ \t]*import\b(?!\s*(?:\(|\.))/gm)].length
  const dynamicCount = [...source.matchAll(/\bimport\s*\(/g)].length
  if (staticCount !== imports.filter((match) => match[1] === 'import').length + sideEffects.length
    || dynamicCount !== dynamic.length || /\brequire\s*\(/.test(source)) throw new Error('Unsupported module import syntax in source closure.')
  return [...new Set([...imports.filter((match) => !match[2]).map((match) => match[4]), ...sideEffects.map((match) => match[1]), ...dynamic.map((match) => match[1])])]
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`
const dataHash = (value) => sha256(encode(value))
const errorRecord = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })

async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function confinedFile(path) {
  const canonical = await realpath(path)
  assert.equal(canonical, path, `Symlink or path alias: ${path}`)
  assert.ok(canonical.startsWith(`${ROOT}/`), `Source escapes canonical root: ${path}`)
  const info = await lstat(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Not a regular source file: ${path}`)
  return info
}

function validateCpuProfilePath(path) {
  assert.ok(typeof path === 'string' && path === resolve(path) && dirname(path) === CPU_PROFILE_BASE
    && /^attempt-[A-Za-z0-9][A-Za-z0-9-]*$/.test(relative(CPU_PROFILE_BASE, path)), 'Invalid diagnostic CPU-profile directory.')
}

// The OUTER operator owns this directory and descriptor. Collector only reads.
async function collectCpuProfileDescriptor(path) {
  validateCpuProfilePath(path)
  for (const directory of [CPU_PROFILE_BASE, path]) await safeDirectory(directory)
  const directory = await lstat(path, { bigint: true })
  assert.equal(directory.mode & 0o7777n, 0o700n, 'Diagnostic directory must be mode0700.')
  assert.equal(Number(directory.uid), process.getuid(), 'Foreign diagnostic directory owner.')
  const ownerPath = join(path, CPU_PROFILE_OWNER_FILENAME)
  const handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let owner, ownerFile
  try {
    const before = await handle.stat({ bigint: true })
    assert.ok(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= 4096n, 'Unsafe or oversized CPU-profile owner file.')
    assert.equal(before.mode & 0o7777n, 0o600n, 'Owner file must be mode0600.')
    assert.equal(Number(before.uid), process.getuid(), 'Foreign owner file.')
    const buffer = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      assert.ok(bytesRead > 0, 'Truncated owner file.'); offset += bytesRead
    }
    const after = await handle.stat({ bigint: true }), linked = await lstat(ownerPath, { bigint: true })
    for (const info of [after, linked]) {
      assert.ok(info.isFile() && !info.isSymbolicLink(), 'Owner file replaced.')
      for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(info[key], before[key], 'Owner file changed.')
    }
    owner = JSON.parse(buffer.toString('utf8'))
    assert.ok(owner && typeof owner === 'object' && !Array.isArray(owner), 'Invalid owner descriptor.')
    assert.deepEqual(Object.keys(owner).sort(), ['schema', 'token', 'path', 'uid', 'dev', 'ino', 'filename'].sort(), 'Owner descriptor keys differ.')
    assert.equal(buffer.toString('utf8'), encode(owner), 'Owner descriptor must be canonical JSON/LF.')
    assert.equal(owner.schema, 'worlds-command-latency-cpu-profile-owner.v1')
    assert.match(owner.token, /^[a-f0-9]{32}$/)
    assert.equal(owner.path, path); assert.equal(owner.filename, CPU_PROFILE_FILENAME)
    assert.equal(owner.uid, Number(directory.uid)); assert.equal(owner.dev, String(directory.dev)); assert.equal(owner.ino, String(directory.ino))
    ownerFile = { path: ownerPath, size: buffer.length, sha256: sha256(buffer), dev: String(before.dev), ino: String(before.ino), uid: Number(before.uid) }
  } finally { await handle.close() }
  const current = await lstat(path, { bigint: true })
  assert.ok(current.isDirectory() && !current.isSymbolicLink() && await realpath(path) === path, 'Diagnostic directory replaced.')
  for (const key of ['dev', 'ino', 'uid', 'mode']) assert.equal(current[key], directory[key], 'Diagnostic directory identity changed.')
  assert.equal(await absent(join(path, CPU_PROFILE_FILENAME)), true, 'CPU-profile output already exists.')
  return { instrumentation: 'node-startup-cpu-profile', owner, ownerFile,
    outputPath: join(path, CPU_PROFILE_FILENAME), artifactStatus: 'PENDING_EXIT', maxArtifactBytes: 64 * 1024 * 1024 }
}

const diagnosticMetadata = (readiness) => readiness.diagnosticCpuProfile ? {
  diagnosticCpuProfile: readiness.diagnosticCpuProfile, instrumentation: 'node-startup-cpu-profile',
  sampleComparability: 'NON_COMPARABLE_DIAGNOSTIC', profileArtifactStatus: 'PENDING_EXIT',
} : readiness.diagnosticStages ? { diagnosticStages: readiness.diagnosticStages, ...readiness.diagnosticStages } : {}

export async function collectSourceManifest(options = {}) {
  if (options.diagnosticStages || options.diagnosticNestedBackup || options.diagnosticFineBackup) {
    const selected = [options.diagnosticStages, options.diagnosticNestedBackup, options.diagnosticFineBackup].filter(Boolean)
    assert.equal(selected.length, 1, 'Mixed stages.'); assert.equal(selected[0], true)
    assert.equal(options.diagnosticCpuProfileDir, undefined, 'Mixed diagnostics.')
    admitStageRuntime(process)
  }
  assert.equal(await realpath(ROOT), ROOT, 'Canonical checkout is a symlink.')
  const pending = [join(ROOT, 'scripts/worlds-command-latency.mjs')]
  const files = new Map(), edges = [], extensionless = []
  async function add(path, scan) {
    if (files.has(path)) return
    const info = await confinedFile(path)
    files.set(path, { path: relative(ROOT, path), size: info.size, sha256: await fileHash(path) })
    if (!scan) return
    for (const specifier of moduleSpecifiers(await readFile(path, 'utf8'))) {
      if (specifier.startsWith('node:')) continue
      let target
      if (specifier === 'three') {
        const packagePath = join(ROOT, 'node_modules/three/package.json')
        await add(packagePath, false)
        const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
        assert.equal(pkg.exports?.['.']?.import, './build/three.module.js', 'Unexpected three ESM entry.')
        target = fileURLToPath(import.meta.resolve('three'))
        assert.equal(target, join(ROOT, 'node_modules/three/build/three.module.js'))
      } else {
        assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `Unexpected runtime package: ${specifier}`)
        target = resolve(dirname(path), specifier)
        if (!extname(target)) {
          let exact = false, typed = false
          try { exact = (await lstat(target)).isFile() } catch (error) { if (error.code !== 'ENOENT') throw error }
          try { typed = (await lstat(`${target}.ts`)).isFile() } catch (error) { if (error.code !== 'ENOENT') throw error }
          assert.ok(exact !== typed, `Missing or ambiguous extensionless import: ${target}`)
          if (typed) { target += '.ts'; extensionless.push({ importer: relative(ROOT, path), specifier }) }
        }
      }
      edges.push({ importer: relative(ROOT, path), specifier, target: relative(ROOT, target) })
      pending.push(target)
    }
  }
  while (pending.length) await add(pending.pop(), true)
  for (const path of ['package.json', 'package-lock.json', 'scripts/worlds-command-latency.test.mjs', 'docs/worlds-command-latency.md']) await add(join(ROOT, path), false)
  if (extensionless.length) await add(LOADER, true)
  assert.equal(pending.length, 0, 'Loader unexpectedly introduced local dependencies.')
  const sources = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const tsv = sources.map((file) => `${file.path}\t${file.size}\t${file.sha256}\n`).join('')
  const execArgv = ['--experimental-strip-types', ...(extensionless.length ? ['--loader', LOADER] : [])]
  const diagnosticCpuProfile = options.diagnosticCpuProfileDir === undefined ? null : await collectCpuProfileDescriptor(options.diagnosticCpuProfileDir)
  if (diagnosticCpuProfile) execArgv.push('--cpu-prof', `--cpu-prof-dir=${diagnosticCpuProfile.owner.path}`, `--cpu-prof-name=${CPU_PROFILE_FILENAME}`)
  const runtime = { executable: await realpath(process.execPath), version: process.version, sha256: await fileHash(process.execPath), execArgv }
  const diagnosticStages = options.diagnosticFineBackup ? FINE_BACKUP_DIAGNOSTIC
    : options.diagnosticNestedBackup ? NESTED_BACKUP_DIAGNOSTIC : options.diagnosticStages ? STAGE_DIAGNOSTIC : null
  const sourceSealSha256 = sha256(`${tsv}${encode(runtime)}${encode(SCENARIO)}${diagnosticCpuProfile ? encode(diagnosticCpuProfile) : ''}${diagnosticStages ? encode(diagnosticStages) : ''}`)
  return { sourceSealSha256, sources, tsv, runtime, extensionless, edges, loader: extensionless.length ? LOADER : null,
    ...(diagnosticCpuProfile ? { diagnosticCpuProfile } : {}), ...(diagnosticStages ? { diagnosticStages } : {}) }
}

export function validateRunAdmission(options, readiness, environment) {
  assert.equal(options.mode, 'run', 'Explicit run mode required.')
  assert.equal(options.sealSha256, readiness.sourceSealSha256, 'Reviewed source seal mismatch.')
  assert.equal(options.diagnosticCpuProfileDir, readiness.diagnosticCpuProfile?.owner.path, 'Diagnostic directory differs from sealed descriptor.')
  const nested = readiness.diagnosticStages?.schema === NESTED_BACKUP_DIAGNOSTIC.schema
  const fine = readiness.diagnosticStages?.schema === FINE_BACKUP_DIAGNOSTIC.schema
  assert.equal(options.diagnosticStages, readiness.diagnosticStages && !nested && !fine ? true : undefined, 'Stage diagnostic differs from seal.')
  assert.equal(options.diagnosticNestedBackup, nested ? true : undefined, 'Nested diagnostic differs from seal.')
  assert.equal(options.diagnosticFineBackup, fine ? true : undefined, 'Fine backup diagnostic differs from seal.')
  if (readiness.diagnosticStages) {
    assert.deepEqual(readiness.diagnosticStages, fine ? FINE_BACKUP_DIAGNOSTIC : nested ? NESTED_BACKUP_DIAGNOSTIC : STAGE_DIAGNOSTIC)
    admitStageRuntime(process)
  }
  assert.equal(environment.cwd, ROOT, 'Run from the canonical checkout.')
  assert.equal(environment.nodeOptions, '', 'NODE_OPTIONS is not allowed.')
  assert.equal(environment.nodePath, '', 'NODE_PATH is not allowed.')
  assert.equal(readiness.runtime.version, REQUIRED_NODE_VERSION, 'Unexpected sealed Node version.')
  assert.equal(environment.executable, readiness.runtime.executable, 'Unexpected Node executable.')
  assert.equal(environment.version, readiness.runtime.version, 'Unexpected Node version.')
  assert.deepEqual(environment.execArgv, readiness.runtime.execArgv, 'Unexpected runtime/loader flags.')
}

export function createLatencyReportOnly(readiness) {
  assert.equal(readiness.runtime.version, REQUIRED_NODE_VERSION, 'Unexpected sealed Node version.')
  assert.ok(typeof readiness.runtime.executable === 'string' && readiness.runtime.executable.startsWith('/'),
    'Sealed Node executable must be absolute.')
  return { mode: 'report-only', status: 'NOT_EXECUTED', applicationImported: false, workspaceCreated: false,
    scenario: { ...SCENARIO, ...diagnosticMetadata(readiness) }, ...readiness,
    proposedArgv: [readiness.runtime.executable, ...readiness.runtime.execArgv,
      join(ROOT, 'scripts/worlds-command-latency.mjs'), '--run', '--seal-sha256', readiness.sourceSealSha256,
      ...(readiness.diagnosticCpuProfile ? ['--diagnostic-cpu-profile-dir', readiness.diagnosticCpuProfile.owner.path]
        : readiness.diagnosticStages ? [readiness.diagnosticStages.schema === FINE_BACKUP_DIAGNOSTIC.schema ? '--diagnostic-fine-backup'
          : readiness.diagnosticStages.schema === NESTED_BACKUP_DIAGNOSTIC.schema ? '--diagnostic-nested-backup' : '--diagnostic-stages'] : [])] }
}

async function writeJson(directory, name, value) {
  await writeFile(join(directory, name), encode(value), { mode: 0o600 })
}

async function safeDirectory(path) {
  const info = await lstat(path)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Unsafe directory: ${path}`)
  assert.equal(await realpath(path), path, `Directory alias: ${path}`)
}

async function createEvidenceDirectory() {
  await safeDirectory(EVIDENCE_BASE)
  const parent = join(EVIDENCE_BASE, 'latency-measurements')
  try { await mkdir(parent, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await safeDirectory(parent)
  const directory = await mkdtemp(join(parent, 'new-'))
  await chmod(directory, 0o700)
  return directory
}

async function filesystem(path) {
  const info = await statfs(path, { bigint: true })
  const type = `0x${info.type.toString(16)}`
  return { type, label: type === '0x1021994' ? 'tmpfs' : type === '0xef53' ? 'ext-family' : type === '0x794c7630' ? 'overlayfs' : 'unknown' }
}

async function gitIdentity() {
  const head = (await readFile(join(ROOT, '.git/HEAD'), 'utf8')).trim()
  let commit = head
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5)
    assert.ok(/^refs\/[A-Za-z0-9_./-]+$/.test(ref) && !ref.includes('..'))
    try { commit = (await readFile(join(ROOT, '.git', ref), 'utf8')).trim() }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      commit = (await readFile(join(ROOT, '.git/packed-refs'), 'utf8')).split('\n').find((line) => line.endsWith(` ${ref}`))?.split(' ')[0]
    }
  }
  assert.match(commit ?? '', /^[a-f0-9]{40}$/)
  return { head, commit, indexSha256: await fileHash(join(ROOT, '.git/index')), dirtyStatus: 'Capture git status in the external invocation envelope; HEAD is not the source seal.' }
}

export function success(result, expectedWarnings = []) {
  assert.equal(result?.ok, true, `Operation failed: ${JSON.stringify(result?.error)}`)
  const warnings = result.value?.durabilityWarnings ?? result.value?.warnings ?? []
  assert.deepEqual([...warnings].sort(), [...expectedWarnings].sort(), 'Unexpected warning (including degraded durability).')
  return result.value
}

function counters(state) {
  return { revision: state.session?.snapshot.project.revision, savedRevision: state.savedRevision,
    undo: state.session?.undoStack.length, redo: state.session?.redoStack.length, receipts: state.session?.receipts.length }
}

function assertState(state, expected, undo, redo, receipts) {
  assert.equal(state.lifecycle, 'ready')
  assert.deepEqual(state.session.snapshot, expected, 'Authoritative full snapshot mismatch.')
  assert.deepEqual(counters(state), { revision: expected.project.revision, savedRevision: expected.project.revision, undo, redo, receipts })
  assert.equal(state.canUndo, undo > 0)
  assert.equal(state.canRedo, redo > 0)
  assert.equal(expected.scenes.length, 1)
  assert.equal(expected.scenes[0].entities.length, SCENARIO.entities)
  assert.equal(new Set(expected.scenes[0].entities.map((entity) => entity.id)).size, SCENARIO.entities)
  assert.equal(expected.project.resources.length, 0)
  for (const entity of expected.scenes[0].entities) assert.equal(entity.components.length, 0)
}

function assertFrozen(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  assert.ok(Object.isFrozen(value), 'Retained data is not recursively frozen.')
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    assert.ok('value' in descriptor, 'Unexpected accessor in retained data.')
    assertFrozen(descriptor.value, seen)
  }
}

async function absent(path) {
  try { await lstat(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}

async function treeManifest(root) {
  await safeDirectory(root)
  const entries = []
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name)
      assert.ok(!entry.isSymbolicLink(), 'Symlink in owned project tree.')
      if (entry.isDirectory()) { entries.push({ path: relative(root, path), kind: 'directory' }); await visit(path) }
      else {
        assert.ok(entry.isFile(), 'Special file in owned project tree.')
        entries.push({ path: relative(root, path), kind: 'file', size: (await lstat(path)).size, sha256: await fileHash(path) })
      }
    }
  }
  await visit(root)
  return { sha256: dataHash(entries), entries }
}

async function inspectSettled(workspace, projectKey, expected, receipt) {
  assert.match(projectKey, /^world-[a-f0-9]{32}$/)
  const root = join(workspace, 'Worlds', projectKey)
  await safeDirectory(root)
  const state = JSON.parse(await readFile(join(root, '.modly/state.v1.json'), 'utf8'))
  const project = JSON.parse(await readFile(join(root, 'project.world-project.json'), 'utf8'))
  const scenes = []
  for (const reference of project.scenes) {
    assert.match(reference.documentPath, new RegExp(`^Worlds/${projectKey}/scenes/scene-[a-f0-9]{32}\\.world-scene\\.json$`))
    scenes.push(JSON.parse(await readFile(join(workspace, reference.documentPath), 'utf8')))
  }
  assert.deepEqual({ project, scenes }, expected, 'Actual persisted documents differ from expected snapshot.')
  assert.equal(state.committedRevision, expected.project.revision)
  assert.equal(state.transactions.length, Math.min(32, expected.project.revision))
  const backupEntries = await readdir(join(root, '.modly/backups'), { withFileTypes: true })
  assert.ok(backupEntries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink()))
  const backups = backupEntries.map((entry) => entry.name).sort()
  assert.equal(backups.length, Math.min(8, expected.project.revision))
  assert.equal(await absent(join(root, '.modly/journal.v1.json')), true, 'Unsettled journal remains.')
  if (receipt) {
    const durable = state.transactions.find((transaction) => transaction.transactionId === receipt.transactionId)
    assert.ok(durable, 'Public receipt is missing from durable ledger.')
    for (const key of ['transactionId', 'payloadSha256', 'resultSha256', 'appliedRevision']) assert.equal(durable[key], receipt[key])
  }
  return { state, backups, snapshotSha256: dataHash({ project, scenes }) }
}

function projection(state) {
  return { projectKey: state.projectKey, activeSceneId: state.activeSceneId, savedRevision: state.savedRevision,
    canUndo: state.canUndo, canRedo: state.canRedo, session: state.session }
}

async function runObservation(readiness) {
  const evidence = await createEvidenceDirectory()
  const runId = `worlds-command-latency-new-v1:${randomBytes(16).toString('hex')}`
  const rows = [], postconditions = {}, controllers = new Set()
  const gates = { functionalStatus: 'UNTESTED', sourceStatus: 'PASS', cleanupStatus: 'UNTESTED', finished: false }
  if (readiness.diagnosticCpuProfile) gates.diagnosticCpuProfile = readiness.diagnosticCpuProfile
  if (readiness.diagnosticStages) { gates.diagnosticStages = readiness.diagnosticStages; gates.stageStatus = 'PASS' }
  const stageDiagnostic = createStageDiagnostic(readiness.diagnosticStages, { runId, sourceSealSha256: readiness.sourceSealSha256, runtime: readiness.runtime })
  let owned = null, pair = null, fault = null, aborted = null, scenarioSha256 = null
  const stop = () => { aborted = 'Termination requested; no further workload is admitted.' }
  const deadline = setTimeout(() => { aborted = 'Internal 170-second deadline reached.' }, SCENARIO.deadlineMs)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const checkDeadline = () => { if (aborted) throw new Error(aborted) }
  const summary = () => ({ ...classifyObservation(rows, gates), runId, evidence, scenario: SCENARIO.schema,
    historicalComparison: false, sourceSealSha256: readiness.sourceSealSha256, scenarioSha256,
    repositoryApplyNs: null, instrumentation: 'none', ...diagnosticMetadata(readiness), error: fault, postconditions })
  try {
    await writeJson(evidence, 'summary.json', summary())
    await writeJson(evidence, 'sources-before.json', readiness)
    await writeFile(join(evidence, 'sources-before.tsv'), readiness.tsv, { mode: 0o600 })
    await writeJson(evidence, 'metadata.json', { runId, startedAt: new Date().toISOString(), cwd: await realpath(process.cwd()),
      argv: process.argv, execArgv: process.execArgv, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '', NODE_PATH: process.env.NODE_PATH ?? '',
      runtime: readiness.runtime, platform: process.platform, architecture: process.arch, osRelease: release(), git: await gitIdentity(),
      evidenceFilesystem: await filesystem(evidence), workspaceFilesystem: await filesystem('/tmp'),
      deadline: { internalMs: SCENARIO.deadlineMs, requiredOuterSeconds: 180, attempts: 1 },
      measurementBoundary: readiness.diagnosticStages ? 'original durable repository and controller promise settlement; diagnostic markers are non-comparable' : 'unwrapped controller.dispatchCommands promise settlement',
      interSampleWork: 'input persistence, full-document/receipt assertions, settled state and backup inventory; outside timing',
      ...diagnosticMetadata(readiness),
      scope: 'same-process Node controller; not renderer, IPC, Electron, GPU, crash or power-loss proof' })
    // These are the ONLY application imports. Report-only never reaches this branch.
    const [{ WorldProjectRepository }, { createWorldProjectService }, { createWorldEditorController },
      { buildAddEmptyEntityCommands }, { createDeterministicWorldEditorIdentityGenerator, buildPatchEntityTransformsCommands }] = await Promise.all([
      import('../electron/main/world-project-repository.ts'),
      import('../src/areas/worlds/worldProjectService.ts'),
      import('../src/areas/worlds/editor/worldEditorController.ts'),
      import('../src/areas/worlds/editor/worldAuthoringModel.ts'),
      import('../src/areas/worlds/editor/worldEditorCommandBuilders.ts'),
    ])
    checkDeadline()
    await safeDirectory('/tmp')
    const workspace = await mkdtemp(WORKSPACE_PREFIX)
    const info = await lstat(workspace, { bigint: true })
    owned = { token: randomBytes(16).toString('hex'), path: workspace, dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid) }
    await writeJson(evidence, 'owned-workspace.json', owned)
    await chmod(workspace, 0o700)
    const makePair = () => {
      const repository = new WorldProjectRepository(stageDiagnostic ? { getWorkspaceRoot: () => workspace, ...stageDiagnostic.repositoryOptions } : { getWorkspaceRoot: () => workspace })
      if (stageDiagnostic) {
        const installed = stageDiagnostic.installRepository(repository)
        if ([NESTED_BACKUP_DIAGNOSTIC.schema, FINE_BACKUP_DIAGNOSTIC.schema].includes(readiness.diagnosticStages.schema))
          assert.equal(installed, true, 'Scoped diagnostic repository methods unavailable before workload.')
      }
      const service = createWorldProjectService(repository)
      const controller = createWorldEditorController(service)
      controllers.add(controller)
      return { repository, service, controller }
    }
    pair = makePair()
    const createRequest = { name: 'Command latency new v1', initialSceneName: 'Measurement scene' }
    await writeJson(evidence, 'create-request.json', createRequest)
    const createdResult = await pair.service.create(createRequest)
    await writeJson(evidence, 'create-result.json', createdResult)
    const created = success(createdResult)
    const projectKey = created.projectKey
    success(await pair.controller.openProject(projectKey))
    const opened = await pair.service.open({ projectKey })
    await writeJson(evidence, 'initial-open.json', opened)
    success(opened)
    const initial = pair.controller.getState()
    assert.equal(initial.session.snapshot.project.revision, 0)
    assert.deepEqual(initial.session.snapshot, created.snapshot)
    const sceneId = initial.activeSceneId
    const identities = createDeterministicWorldEditorIdentityGenerator(SCENARIO.seed)
    const seedCommands = Array.from({ length: 100 }, (_, index) => buildAddEmptyEntityCommands({
      snapshot: initial.session.snapshot, projectKey, activeSceneId: sceneId, identities,
    }, { name: `Entity ${String(index).padStart(3, '0')}` })[0])
    const entityId = seedCommands[0].entity.id
    assert.equal(new Set(seedCommands.map((command) => command.entity.id)).size, 100)
    const scenario = buildScenario({ createRequest, projectKey, projectId: created.snapshot.project.projectId, sceneId, entityId, ...diagnosticMetadata(readiness) },
      seedCommands.map((command) => command.entity))
    scenarioSha256 = dataHash(scenario)
    await writeJson(evidence, 'scenario.json', scenario)
    await writeJson(evidence, 'initial-snapshot.json', initial.session.snapshot)
    const transform = (x) => ({ position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
    let last = null, preFinalState = null, finalState = null, preFinalHash = null, finalHash = null

    for (const plan of scenario.batches) {
      checkDeadline()
      const before = pair.controller.getState()
      if (plan.ordinal === 52) { preFinalState = before; preFinalHash = dataHash(before) }
      const commands = plan.ordinal === 1 ? seedCommands : buildPatchEntityTransformsCommands(before.session.snapshot, sceneId,
        [{ entityId, transform: transform(plan.position[0]) }])
      const request = { transactionId: plan.transactionId, origin: 'ui', commands }
      const batch = { schema: 'modly.world-command-batch.v1', transactionId: request.transactionId,
        projectId: before.session.snapshot.project.projectId, baseRevision: before.session.snapshot.project.revision,
        origin: request.origin, commands: structuredClone(commands) }
      assert.equal(batch.baseRevision, plan.baseRevision)
      const authority = { projectKey, projectId: batch.projectId, baseRevision: batch.baseRevision, activeSceneId: sceneId }
      const expected = structuredClone(before.session.snapshot)
      expected.project.revision += 1
      if (plan.ordinal === 1) expected.scenes[0].entities.push(...seedCommands.map((command) => structuredClone(command.entity)))
      else expected.scenes[0].entities.find((entity) => entity.id === entityId).transform = transform(plan.position[0])
      const input = { phase: plan.phase, index: plan.index, request, authority, batch, batchSha256: dataHash(batch) }
      await appendFile(join(evidence, 'inputs.jsonl'), `${JSON.stringify(input)}\n`, { mode: 0o600 })
      await writeJson(evidence, 'pending-command.json', input)
      const row = { schema: SCENARIO.schema, runId, sourceSealSha256: readiness.sourceSealSha256, scenarioSha256,
        phase: plan.phase, index: plan.index, transactionId: request.transactionId, batchSha256: input.batchSha256,
        projectKey, projectId: batch.projectId, sceneId, entityId, baseRevision: batch.baseRevision,
        before: counters(before), ok: false, durationNs: null, repositoryApplyNs: null, instrumentation: 'none', ...diagnosticMetadata(readiness) }
      let result, endedNs, operationError
      checkDeadline()
      const measured = plan.phase === 'measure'
      const startedNs = measured ? process.hrtime.bigint() : null
      try {
        if (stageDiagnostic && measured) result = await stageDiagnostic.dispatch({ ...plan, documents: ['project.world-project.json',
          ...before.session.snapshot.project.scenes.map((scene) => `scenes/${scene.documentPath.split('/').at(-1)}`).sort()] }, () => pair.controller.dispatchCommands(request, authority))
        else { result = await pair.controller.dispatchCommands(request, authority) }
      }
      catch (error) { operationError = error }
      finally { endedNs = measured ? process.hrtime.bigint() : null }
      // Strict mode has no builders/assertions/logging inside timing; opt-in markers include diagnostic overhead.
      if (stageDiagnostic && measured) {
        row.stageDiagnostic = stageDiagnostic.takeRecord()
        if (row.stageDiagnostic?.status !== 'PASS') gates.stageStatus = 'FAIL'
      }
      if (measured) {
        row.startedNs = String(startedNs); row.endedNs = String(endedNs)
        row.durationNs = String(endedNs - startedNs); row.durationMs = Number(endedNs - startedNs) / 1e6
        row.under50Ms = readiness.diagnosticCpuProfile || readiness.diagnosticStages ? null : endedNs - startedNs < LIMIT_NS
      }
      try {
        if (operationError) throw operationError
        if (stageDiagnostic && measured && row.stageDiagnostic?.status !== 'PASS') throw new Error(`Invalid stage diagnostic: ${row.stageDiagnostic?.error ?? 'missing record'}`)
        row.response = result
        const value = success(result)
        assert.equal(value.idempotent, false)
        assert.equal(value.revision, expected.project.revision)
        assert.equal(value.receipt.transactionId, request.transactionId)
        const after = pair.controller.getState()
        assertState(after, expected, plan.ordinal, 0, plan.ordinal)
        const localReceipt = after.session.receipts.at(-1)
        assert.deepEqual(JSON.parse(localReceipt.canonicalPayload), batch)
        assert.equal(localReceipt.appliedRevision, value.receipt.appliedRevision)
        assert.equal(sha256(localReceipt.canonicalPayload), value.receipt.payloadSha256)
        const disk = await inspectSettled(workspace, projectKey, expected, value.receipt)
        row.after = counters(after); row.receipt = value.receipt; row.warnings = value.warnings
        row.idempotent = value.idempotent; row.resultRevision = value.revision
        row.ledgerAfter = disk.state.transactions.length; row.backupCountAfter = disk.backups.length
        await writeJson(evidence, `${plan.phase}-${String(plan.index).padStart(2, '0')}.json`, { input, expected, observed: after.session.snapshot, disk })
        checkDeadline()
        row.ok = true
        last = { input, result: value, expected, beforeSnapshot: before.session.snapshot }
      } catch (error) { row.error = errorRecord(error); throw error }
      finally {
        if (plan.phase === 'measure') rows.push(row)
        await appendFile(join(evidence, 'raw-rows.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 })
        await writeJson(evidence, 'summary.json', summary())
      }
    }
    finalState = pair.controller.getState(); finalHash = dataHash(finalState)
    assertState(finalState, last.expected, 52, 0, 52)
    assertFrozen(preFinalState); assertFrozen(finalState); assertFrozen(last.result)
    const frozenLeaf = finalState.session.snapshot.scenes[0].entities.find((entity) => entity.id === entityId).transform.position
    assert.equal(Reflect.set(frozenLeaf, '0', 999), false)
    assert.equal(dataHash(finalState), finalHash)
    postconditions.frozenData = { status: 'PASS', preFinalHash, finalHash, mutationRejected: true }
    await writeJson(evidence, 'pre-final-snapshot.json', preFinalState.session.snapshot)
    await writeJson(evidence, 'final-measured-snapshot.json', finalState.session.snapshot)
    const projectRoot = join(workspace, 'Worlds', projectKey)

    async function unchanged(name, operation) {
      checkDeadline()
      const before = projection(pair.controller.getState())
      const beforeHash = dataHash(before), treeBefore = await treeManifest(projectRoot)
      await writeJson(evidence, `${name}-before.json`, { projectionSha256: beforeHash, tree: treeBefore })
      const result = await operation()
      const afterHash = dataHash(projection(pair.controller.getState())), treeAfter = await treeManifest(projectRoot)
      await writeJson(evidence, `${name}-after.json`, { result, projectionSha256: afterHash, tree: treeAfter })
      assert.equal(afterHash, beforeHash, `${name} changed authoritative state/history/receipts.`)
      assert.deepEqual(treeAfter, treeBefore, `${name} wrote project bytes.`)
      checkDeadline()
      postconditions[name] = { status: 'PASS', beforeHash, afterHash, treeSha256: treeAfter.sha256 }
      await writeJson(evidence, 'postconditions.json', postconditions)
      return result
    }
    await unchanged('preview', async () => {
      const request = { transactionId: 'tx:latency-new-v1:preview', origin: 'ai', commands: buildPatchEntityTransformsCommands(
        finalState.session.snapshot, sceneId, [{ entityId, transform: transform(52) }]) }
      await writeJson(evidence, 'preview-input.json', request)
      const result = await pair.controller.previewProposal(request)
      success(result)
      return result
    })
    await unchanged('controller-retry', async () => {
      const result = await pair.controller.dispatchCommands(last.input.request, last.input.authority)
      const value = success(result)
      assert.equal(value.idempotent, true)
      assert.deepEqual(value.receipt, last.result.receipt)
      assert.equal(value.revision, 52)
      return result
    })
    let retryService = createWorldProjectService(new WorldProjectRepository({ getWorkspaceRoot: () => workspace }))
    await unchanged('fresh-service-retry', async () => {
      const result = await retryService.applyCommands({ projectKey, batch: last.input.batch })
      const value = success(result, ['transaction-idempotent'])
      assert.equal(value.idempotent, true)
      assert.equal(value.newRevision, 52)
      assert.deepEqual(value.snapshot, finalState.session.snapshot)
      assert.deepEqual(value.inverse, { kind: 'world-snapshot', snapshot: preFinalState.session.snapshot })
      assert.deepEqual(value.receipt, last.result.receipt)
      assert.deepEqual(value.changes, last.result.changes)
      return result
    })
    const changed = structuredClone(last.input.batch)
    changed.commands[0].patch.transform = transform(1000)
    await writeJson(evidence, 'changed-reuse-input.json', { projectKey, batch: changed })
    await unchanged('fresh-service-changed-reuse', async () => {
      const result = await retryService.applyCommands({ projectKey, batch: changed })
      assert.equal(result.ok, false); assert.equal(result.error.code, 'transaction_reuse')
      return result
    })
    await unchanged('controller-changed-reuse', async () => {
      const result = await pair.controller.dispatchCommands({ ...last.input.request, commands: changed.commands }, last.input.authority)
      assert.equal(result.ok, false); assert.equal(result.error.code, 'transaction_reuse')
      return result
    })
    retryService = null
    let expectedRedo
    for (const kind of ['undo', 'redo']) {
      checkDeadline()
      const result = await pair.controller[kind]()
      await writeJson(evidence, `${kind}-result.json`, result)
      const value = success(result)
      assert.equal(value.idempotent, false)
      const expected = structuredClone(kind === 'undo' ? preFinalState.session.snapshot : finalState.session.snapshot)
      expected.project.revision = kind === 'undo' ? 53 : 54
      assert.equal(value.revision, expected.project.revision)
      const state = pair.controller.getState()
      assertState(state, expected, kind === 'undo' ? 51 : 52, kind === 'undo' ? 1 : 0, 52)
      assert.deepEqual(state.session.receipts, finalState.session.receipts)
      const disk = await inspectSettled(workspace, projectKey, expected, value.receipt)
      await writeJson(evidence, `${kind}-persistence.json`, { expected, observed: state.session.snapshot, disk })
      postconditions[kind] = { status: 'PASS', revision: expected.project.revision, snapshotSha256: dataHash(expected), receipt: value.receipt }
      expectedRedo = expected
    }
    success(await pair.controller.closeProject())
    controllers.delete(pair.controller)
    pair = null // Do not reuse the measured repository/service/controller for reopen.
    checkDeadline()
    pair = makePair()
    const reopened = await pair.controller.openProject(projectKey)
    await writeJson(evidence, 'reopen-result.json', reopened)
    success(reopened)
    assertState(pair.controller.getState(), expectedRedo, 0, 0, 0)
    const freshOpen = await pair.service.open({ projectKey })
    await writeJson(evidence, 'fresh-service-open.json', freshOpen)
    assert.deepEqual(success(freshOpen).snapshot, expectedRedo)
    await writeJson(evidence, 'expected-reopened-snapshot.json', expectedRedo)
    await writeJson(evidence, 'reopened-snapshot.json', pair.controller.getState().session.snapshot)
    await writeJson(evidence, 'reopened-disk.json', await inspectSettled(workspace, projectKey, expectedRedo))
    assert.equal(dataHash(preFinalState), preFinalHash)
    assert.equal(dataHash(finalState), finalHash)
    assertFrozen(preFinalState); assertFrozen(finalState)
    postconditions.freshInstanceOpen = { status: 'PASS', revision: 54, emptyVolatileHistory: true, snapshotSha256: dataHash(expectedRedo) }
    postconditions.retainedEarlierData = { status: 'PASS', preFinalHash, finalHash }
    await writeJson(evidence, 'postconditions.json', postconditions)
    await writeJson(evidence, 'final-project-tree.json', await treeManifest(projectRoot))
    checkDeadline()
    gates.functionalStatus = 'PASS'; gates.finished = true
  } catch (error) {
    fault = errorRecord(error)
    gates.functionalStatus = 'FAIL'
    await writeJson(evidence, 'error.json', fault).catch((writeError) => { fault.evidenceWriteError = errorRecord(writeError) })
  } finally {
    clearTimeout(deadline)
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
    let settled = true
    for (const controller of controllers) {
      try { success(await controller.closeProject()) }
      catch (error) { settled = false; fault ??= errorRecord(error); gates.functionalStatus = 'FAIL' }
    }
    pair = null
    try {
      const after = await collectSourceManifest(readiness.diagnosticCpuProfile ? { diagnosticCpuProfileDir: readiness.diagnosticCpuProfile.owner.path }
        : readiness.diagnosticStages ? { [readiness.diagnosticStages.schema === FINE_BACKUP_DIAGNOSTIC.schema ? 'diagnosticFineBackup'
          : readiness.diagnosticStages.schema === NESTED_BACKUP_DIAGNOSTIC.schema ? 'diagnosticNestedBackup' : 'diagnosticStages']: true } : {})
      await writeJson(evidence, 'sources-after.json', after)
      await writeFile(join(evidence, 'sources-after.tsv'), after.tsv, { mode: 0o600 })
      assert.equal(after.sourceSealSha256, readiness.sourceSealSha256, 'Source changed during observation.')
    } catch (error) { gates.sourceStatus = 'FAIL'; fault ??= errorRecord(error) }
    try {
      // Persist partial/error evidence before considering removal of the private workspace.
      await writeJson(evidence, 'postconditions.json', postconditions)
      await writeJson(evidence, 'summary.json', summary())
      if (owned) {
        const durable = JSON.parse(await readFile(join(evidence, 'owned-workspace.json'), 'utf8'))
        assert.deepEqual(durable, owned)
        const current = await lstat(owned.path, { bigint: true })
        const observed = { ...owned, path: owned.path, realPath: await realpath(owned.path),
          dev: String(current.dev), ino: String(current.ino), uid: Number(current.uid),
          isDirectory: current.isDirectory(), isSymbolicLink: current.isSymbolicLink() }
        assert.ok(canCleanupOwnedWorkspace(owned, observed, { settled, durableToken: durable.token }), 'Owned workspace cleanup admission failed.')
        await writeJson(evidence, 'cleanup.json', { status: 'ADMITTED', owned, observed, settled })
        await rm(owned.path, { recursive: true, force: false })
        assert.equal(await absent(owned.path), true)
      }
      gates.cleanupStatus = 'PASS'
      await writeJson(evidence, 'cleanup.json', { status: 'PASS', owned, removed: Boolean(owned), settled })
    } catch (error) {
      gates.cleanupStatus = 'FAIL'; fault ??= errorRecord(error)
      await writeJson(evidence, 'cleanup.json', { status: 'FAIL', owned, settled, error: errorRecord(error) }).catch(() => {})
    }
  }
  const result = summary()
  await writeJson(evidence, 'summary.json', result)
  await writeFile(join(evidence, 'exit-code.txt'), `${result.exitCode}\n`, { mode: 0o600 })
  return result
}

async function main(args) {
  const options = parseArguments(args)
  if (options.mode === 'help') {
    process.stdout.write('Usage: worlds-command-latency.mjs --report-only | --run --seal-sha256 <reviewed SHA-256> [--diagnostic-cpu-profile-dir <owned directory> | --diagnostic-stages | --diagnostic-nested-backup | --diagnostic-fine-backup]\n')
    return 0
  }
  const readiness = await collectSourceManifest(options)
  if (options.mode === 'report-only') {
    process.stdout.write(encode(createLatencyReportOnly(readiness)))
    return 0
  }
  validateRunAdmission(options, readiness, { cwd: await realpath(process.cwd()), executable: await realpath(process.execPath),
    version: process.version, execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '', nodePath: process.env.NODE_PATH ?? '' })
  const result = await runObservation(readiness)
  process.stdout.write(encode(result))
  return result.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(encode({ status: 'PARTIAL', observationStatus: 'INCOMPLETE', functionalStatus: 'UNTESTED',
      allCommandsUnder50Ms: null, p95Under50Ms: null, metrics: null, exitCode: 1, error: errorRecord(error) }))
    process.exitCode = 1
  })
}
