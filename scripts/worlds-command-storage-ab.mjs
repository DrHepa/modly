// Importing this module never imports application code or creates a workspace.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm, statfs } from 'node:fs/promises'
import { release } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REQUIRED_NODE_VERSION = 'v24.14.1'
const LOADER = join(ROOT, 'scripts/node-ts-extensionless-loader.mjs')
const SEAL_PATTERN = /^[a-f0-9]{64}$/
const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/
const SIGNED_INTEGER_PATTERN = /^-?(0|[1-9][0-9]*)$/
const WORKSPACE_PREFIXES = Object.freeze({
  v1: '/tmp/modly-worlds-command-storage-ab-v1-',
  v2: '/tmp/modly-worlds-command-storage-ab-v2-',
})
const EVIDENCE_PREFIX = '/tmp/modly-worlds-command-storage-ab-evidence-'
const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const SCENE_KEY = 'scene-0123456789abcdef0123456789abcdef'
const PROJECT_ID = 'project:worlds-command-storage-ab'
const SCENE_ID = 'scene:worlds-command-storage-ab'
const OBSERVER_BATCH_SCHEMA = 'modly.worlds-command-storage-ab-observer-batch.v1'
const OBSERVER_EVIDENCE_SCHEMA = 'modly.worlds-command-storage-ab-observer-evidence.v1'
const MAX_OBSERVER_BATCHES = 116
const MAX_OBSERVER_EVIDENCE_BYTES = 128 * 1024 * 1024

export const STORAGE_AB_DIAGNOSTIC = Object.freeze({
  schema: 'modly.worlds-command-storage-ab.v1',
  diagnosticFlag: '--diagnostic-storage-ab',
  entities: 100,
  setupBatchesPerLane: 32,
  measuredBatchesPerLane: 20,
  lanes: Object.freeze(['v1', 'v2']),
  order: 'odd-v1-v2-even-v2-v1',
  fileSync: 'default',
  directorySync: 'default',
  maxRecordsPerDispatch: 8192,
  historicalComparison: false,
  performanceAcceptance: 'NOT_ASSESSED',
  thresholdGainUnder50Ms: null,
  gainAcceptance: null,
})

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`
const canonical = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  assert.ok(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'Non-plain canonical value.')
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
const dataHash = (value) => sha256(canonical(value))
const errorRecord = (error, stage = 'run') => Object.freeze({
  stage,
  name: typeof error?.name === 'string' ? error.name : 'Error',
  code: typeof error?.code === 'string' ? error.code : null,
})

export function parseStorageAbArguments(args) {
  assert.ok(Array.isArray(args), 'Arguments must be an array.')
  if (args.length === 2 && args[0] === '--report-only' && args[1] === STORAGE_AB_DIAGNOSTIC.diagnosticFlag) {
    return { mode: 'report-only', sealSha256: null, diagnosticStorageAb: true }
  }
  if (args.length === 4 && args[0] === '--run' && args[1] === '--seal-sha256'
    && SEAL_PATTERN.test(args[2]) && args[3] === STORAGE_AB_DIAGNOSTIC.diagnosticFlag) {
    return { mode: 'run', sealSha256: args[2], diagnosticStorageAb: true }
  }
  throw new Error('Invalid, ambiguous, mixed, or unsealed storage A/B mode.')
}

export function createStorageAbStdoutReceipt({ result, evidenceRoot, summarySha256, sealVerified }) {
  assert.ok(result && typeof result === 'object', 'Storage A/B result required.')
  assert.equal(result.schema, STORAGE_AB_DIAGNOSTIC.schema, 'Invalid receipt schema.')
  assert.ok(result.status === 'PASS' || result.status === 'PARTIAL', 'Invalid receipt status.')
  assert.ok(result.exitCode === 0 || result.exitCode === 1, 'Invalid receipt exit code.')
  assert.ok(typeof evidenceRoot === 'string' && evidenceRoot.startsWith(EVIDENCE_PREFIX)
    && !/[\r\n]/.test(evidenceRoot), 'Invalid evidence root.')
  assert.ok(summarySha256 === null || SEAL_PATTERN.test(summarySha256), 'Invalid summary hash.')
  assert.equal(typeof sealVerified, 'boolean', 'Invalid seal verification status.')
  const receipt = Object.freeze({
    schema: STORAGE_AB_DIAGNOSTIC.schema,
    status: result.status,
    exitCode: result.exitCode,
    evidenceRoot,
    sourceSealSha256: result.sourceSealSha256,
    summarySha256,
    sealVerified,
  })
  assert.match(receipt.sourceSealSha256, SEAL_PATTERN, 'Invalid source seal.')
  assert.ok(Buffer.byteLength(encode(receipt)) < 4096, 'Storage A/B stdout receipt exceeds 4096 bytes.')
  return receipt
}

function unsigned(value, label) {
  assert.ok(typeof value === 'string' && INTEGER_PATTERN.test(value), `Invalid ${label}.`)
  return BigInt(value)
}

function signed(value, label) {
  assert.ok(typeof value === 'string' && SIGNED_INTEGER_PATTERN.test(value), `Invalid ${label}.`)
  return BigInt(value)
}

function nearestRank(values, percentile, parser = unsigned) {
  assert.ok(Array.isArray(values) && values.length > 0, 'Missing samples.')
  assert.ok(Number.isFinite(percentile) && percentile > 0 && percentile <= 1, 'Invalid percentile.')
  const sorted = values.map((value) => parser(value, 'sample')).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return String(sorted[Math.ceil(percentile * sorted.length) - 1])
}

function sampleSummary(values, parser = unsigned) {
  const parsed = values.map((value) => parser(value, 'sample'))
  const maximum = parsed.reduce((left, right) => left > right ? left : right)
  return { count: values.length, p50Ns: nearestRank(values, 0.5, parser), p95Ns: nearestRank(values, 0.95, parser), maxNs: String(maximum) }
}

export function summarizeStorageAbRows(rows, expectedPairs = STORAGE_AB_DIAGNOSTIC.measuredBatchesPerLane) {
  assert.ok(Number.isSafeInteger(expectedPairs) && expectedPairs > 0, 'Invalid expected pair count.')
  assert.equal(rows.length, expectedPairs * 2, 'Missing measured lane rows.')
  const byLane = { v1: [], v2: [] }
  const deltas = []
  let previousSettled = null
  for (let ordinal = 1; ordinal <= expectedPairs; ordinal += 1) {
    const expectedOrder = ordinal % 2 === 1 ? 'v1-v2' : 'v2-v1'
    const pair = rows.slice((ordinal - 1) * 2, ordinal * 2)
    assert.deepEqual(pair.map((row) => row.lane), expectedOrder.split('-'), `Invalid lane order for ordinal ${ordinal}.`)
    for (const row of pair) {
      assert.equal(row.ordinal, ordinal, 'Invalid measured ordinal.')
      assert.equal(row.order, expectedOrder, 'Invalid alternating order.')
      assert.ok(Number.isSafeInteger(row.baseRevision) && row.baseRevision >= 0, 'Invalid base revision.')
      assert.match(row.inputSha256, SEAL_PATTERN, 'Invalid input identity.')
      const started = unsigned(row.startedNs, 'start time')
      const settled = unsigned(row.settledNs, 'settled time')
      const duration = unsigned(row.durationNs, 'duration')
      assert.equal(settled - started, duration, 'Duration differs from monotonic boundaries.')
      assert.ok(settled >= started, 'Nonmonotonic measurement.')
      if (previousSettled !== null) assert.ok(started >= previousSettled, 'Lane operations overlap.')
      previousSettled = settled
      byLane[row.lane].push(row.durationNs)
    }
    assert.equal(pair[0].baseRevision, pair[1].baseRevision, 'Paired base revisions differ.')
    assert.equal(pair[0].inputSha256, pair[1].inputSha256, 'Paired input identity differs.')
    const v1 = pair.find((row) => row.lane === 'v1')
    const v2 = pair.find((row) => row.lane === 'v2')
    assert.ok(v1 && v2, 'Missing paired lane.')
    deltas.push(String(unsigned(v2.durationNs, 'v2 duration') - unsigned(v1.durationNs, 'v1 duration')))
  }
  return {
    schema: STORAGE_AB_DIAGNOSTIC.schema,
    lanes: { v1: sampleSummary(byLane.v1), v2: sampleSummary(byLane.v2) },
    pairedV2MinusV1: sampleSummary(deltas, signed),
    performanceAcceptance: 'NOT_ASSESSED', historicalComparison: false,
    thresholdGainUnder50Ms: null, gainAcceptance: null,
    descriptiveUnder50Ms: {
      v1: byLane.v1.filter((value) => unsigned(value, 'duration') < 50_000_000n).length,
      v2: byLane.v2.filter((value) => unsigned(value, 'duration') < 50_000_000n).length,
    },
  }
}

const FINE_KEYS = Object.freeze(['schema', 'invocation', 'sequence', 'span', 'parent', 'phase', 'kind', 'edge', 'ns',
  'ledgerIndex', 'appliedRevision', 'target', 'requestedBytes', 'completedBytes', 'sourceBytes', 'calls', 'outcome', 'durable'].sort())
const FINE_PHASES = new Set(['prior-proof', 'copy-package', 'pack-ledger', 'index', 'seal-sync'])
const FINE_KINDS = new Set(['envelope', 'bounded-read', 'read-await', 'write-file', 'write-positional', 'file-sync',
  'directory-sync', 'utf8-decode', 'json-parse', 'validate', 'canonical-parse', 'canonical-encode', 'replay',
  'encode-buffer', 'hash', 'copy', 'proof-lookup', 'metadata', 'cache-hit', 'cache-miss', 'cache-admit',
  'cache-evict', 'observer-fault'])
const FINE_TARGETS = new Set(['project', 'scene', 'state', 'receipt', 'pack', 'index', 'directory'])

function primitiveInteger(value, nullable = false) {
  return (nullable && value === null) || (Number.isSafeInteger(value) && value >= 0)
}

function copyFineRecord(record, requireFrozen = true) {
  assert.ok(record && typeof record === 'object' && !Array.isArray(record), 'Invalid observer record schema.')
  assert.equal(Object.getPrototypeOf(record), Object.prototype, 'Invalid observer record schema.')
  if (requireFrozen) assert.equal(Object.isFrozen(record), true, 'Observer record must be frozen.')
  const keys = Reflect.ownKeys(record)
  assert.ok(keys.every((key) => typeof key === 'string'), 'Invalid observer record schema.')
  assert.deepEqual(keys.map(String).sort(), FINE_KEYS, 'Invalid observer record schema.')
  const descriptors = Object.getOwnPropertyDescriptors(record)
  assert.ok(FINE_KEYS.every((key) => descriptors[key] && 'value' in descriptors[key]), 'Invalid observer record schema.')
  const value = Object.fromEntries(FINE_KEYS.map((key) => [key, descriptors[key].value]))
  assert.equal(value.schema, 'modly.world-backup-cost.v1', 'Invalid observer record schema.')
  assert.ok(Number.isSafeInteger(value.invocation) && value.invocation > 0, 'Invalid observer invocation.')
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0, 'Invalid observer sequence.')
  assert.ok(Number.isSafeInteger(value.span) && value.span > 0, 'Invalid observer span.')
  assert.ok(value.parent === null || (Number.isSafeInteger(value.parent) && value.parent > 0), 'Invalid observer parent.')
  assert.ok(FINE_PHASES.has(value.phase) && FINE_KINDS.has(value.kind) && FINE_TARGETS.has(value.target), 'Invalid observer record schema.')
  assert.ok(value.edge === 'begin' || value.edge === 'settled', 'Invalid observer edge.')
  unsigned(value.ns, 'observer clock')
  assert.ok(primitiveInteger(value.ledgerIndex, true) && primitiveInteger(value.appliedRevision, true), 'Invalid observer ledger identity.')
  for (const key of ['requestedBytes', 'completedBytes', 'sourceBytes']) assert.ok(primitiveInteger(value[key], true), 'Invalid observer bytes.')
  assert.ok(Number.isSafeInteger(value.calls) && value.calls >= 0, 'Invalid observer calls.')
  assert.ok(['pending', 'fulfilled', 'rejected'].includes(value.outcome), 'Invalid observer outcome.')
  assert.ok(value.durable === null || typeof value.durable === 'boolean', 'Invalid observer durability.')
  return value
}

export function summarizeStorageAbRecords(input) {
  assert.ok(Array.isArray(input) && input.length > 0 && input.length <= STORAGE_AB_DIAGNOSTIC.maxRecordsPerDispatch,
    'Observer record bound exceeded or empty.')
  const records = input.map(copyFineRecord)
  const invocation = records[0].invocation
  const open = new Map()
  let root = null
  let previousNs = -1n
  let terminalFault = false
  const kinds = {}
  for (const [index, record] of records.entries()) {
    assert.equal(record.invocation, invocation, 'Mixed observer invocation.')
    assert.equal(record.sequence, index + 1, 'Non-contiguous observer sequence.')
    const ns = unsigned(record.ns, 'observer clock')
    assert.ok(ns >= previousNs, 'Nonmonotonic observer clock.')
    previousNs = ns
    if (terminalFault) assert.fail('Record delivered after terminal observer fault.')
    if (record.kind === 'observer-fault') {
      assert.equal(index, records.length - 1, 'Observer fault must be terminal.')
      assert.equal(record.edge, 'settled', 'Observer fault must settle.')
      assert.equal(open.size, 0, 'Observer fault preceded unsettled spans.')
      terminalFault = true
      continue
    }
    if (record.edge === 'begin') {
      assert.equal(record.outcome, 'pending', 'Begin record must be pending.')
      assert.equal(record.durable, null, 'Begin durability must be null.')
      assert.equal(open.has(record.span), false, 'Duplicate observer span.')
      if (record.parent !== null) assert.equal(open.has(record.parent), true, 'Missing live observer parent.')
      open.set(record.span, record)
      if (record.kind === 'envelope' && record.parent === null) {
        assert.equal(root, null, 'Duplicate observer root.')
        root = record.span
      }
      continue
    }
    const begin = open.get(record.span)
    assert.ok(begin, 'Observer settled without begin.')
    assert.equal(record.kind, begin.kind, 'Observer kind pairing differs.')
    assert.equal(record.phase, begin.phase, 'Observer phase pairing differs.')
    assert.equal(record.parent, begin.parent, 'Observer parent pairing differs.')
    assert.notEqual(record.outcome, 'pending', 'Settled record remains pending.')
    open.delete(record.span)
    const metric = kinds[record.kind] ??= { calls: 0, requestedBytes: 0, completedBytes: 0, sourceBytes: 0 }
    metric.calls += record.calls
    metric.requestedBytes += record.requestedBytes ?? 0
    metric.completedBytes += record.completedBytes ?? 0
    metric.sourceBytes += record.sourceBytes ?? 0
  }
  assert.ok(root !== null, 'Missing observer root.')
  assert.equal(open.size, 0, 'Pending observer spans remain.')
  const lastOrdinary = terminalFault ? records.at(-2) : records.at(-1)
  assert.equal(lastOrdinary?.span, root, 'Observer root must settle last before terminal fault.')
  assert.equal(lastOrdinary?.edge, 'settled', 'Observer root did not settle.')
  return { records: records.length, invocation, terminalObserverFault: terminalFault, kinds }
}

function emptyObserverSummary() {
  return { records: 0, invocation: null, terminalObserverFault: false, kinds: {} }
}

function sanitizeObserverDispatch(dispatch, recordCount) {
  assert.ok(dispatch && typeof dispatch === 'object' && !Array.isArray(dispatch)
    && Object.getPrototypeOf(dispatch) === Object.prototype, 'Invalid observer dispatch association.')
  if (dispatch.phase === 'setup' || dispatch.phase === 'measure') {
    const keys = ['baseRevision', 'inputSha256', 'lane', 'order', 'ordinal', 'phase', 'transactionId']
    assert.deepEqual(Object.keys(dispatch).sort(), keys, 'Invalid observer dispatch keys.')
    assert.ok(STORAGE_AB_DIAGNOSTIC.lanes.includes(dispatch.lane), 'Invalid observer dispatch lane.')
    const limit = dispatch.phase === 'setup' ? STORAGE_AB_DIAGNOSTIC.setupBatchesPerLane : STORAGE_AB_DIAGNOSTIC.measuredBatchesPerLane
    assert.ok(Number.isSafeInteger(dispatch.ordinal) && dispatch.ordinal >= 1 && dispatch.ordinal <= limit,
      'Invalid observer dispatch ordinal.')
    const expectedOrder = dispatch.ordinal % 2 === 1 ? 'v1-v2' : 'v2-v1'
    assert.equal(dispatch.order, expectedOrder, 'Invalid observer dispatch order.')
    assert.equal(dispatch.transactionId, `tx:storage-ab:${dispatch.phase}:${String(dispatch.ordinal).padStart(2, '0')}`,
      'Invalid synthetic observer transaction identity.')
    assert.ok(Number.isSafeInteger(dispatch.baseRevision) && dispatch.baseRevision >= 0, 'Invalid observer base revision.')
    assert.match(dispatch.inputSha256, SEAL_PATTERN, 'Invalid observer input identity.')
  } else {
    const keys = ['lane', 'outcome', 'phase', 'role', 'zeroObserverReason']
    assert.deepEqual(Object.keys(dispatch).sort(), keys, 'Invalid auxiliary observer dispatch keys.')
    assert.equal(dispatch.phase, 'auxiliary', 'Invalid observer dispatch phase.')
    assert.ok(STORAGE_AB_DIAGNOSTIC.lanes.includes(dispatch.lane), 'Invalid observer dispatch lane.')
    assert.ok(AUXILIARY_ROLES.includes(dispatch.role), 'Invalid auxiliary observer role.')
    assert.equal(dispatch.outcome, dispatch.role === 'changed-reuse' ? 'rejected' : 'fulfilled', 'Invalid auxiliary observer outcome.')
    if (recordCount === 0) assert.equal(dispatch.zeroObserverReason, ZERO_OBSERVER_REASONS[dispatch.role],
      'Undocumented zero-record observer dispatch.')
    else assert.equal(dispatch.zeroObserverReason, null, 'Recorded observer dispatch has a zero-record reason.')
  }
  for (const value of Object.values(dispatch)) {
    if (typeof value === 'string') assert.equal(/[\\/\r\n]/.test(value), false, 'Path-like observer dispatch string.')
  }
  return Object.freeze(structuredClone(dispatch))
}

export function sanitizeStorageAbObserverRecords(records, { requireFrozen = true } = {}) {
  assert.ok(Array.isArray(records) && records.length <= STORAGE_AB_DIAGNOSTIC.maxRecordsPerDispatch,
    'Observer record bound exceeds 8192.')
  const copied = records.map((record) => Object.freeze(copyFineRecord(record, requireFrozen)))
  return Object.freeze(copied)
}

export function createStorageAbObserverBatch({ dispatch, records }) {
  const sanitizedRecords = sanitizeStorageAbObserverRecords(records)
  const sanitizedDispatch = sanitizeObserverDispatch(dispatch, sanitizedRecords.length)
  assert.ok(sanitizedRecords.length > 0 || sanitizedDispatch.phase === 'auxiliary', 'Empty setup or measured observer batch.')
  const summary = sanitizedRecords.length > 0 ? summarizeStorageAbRecords(sanitizedRecords) : emptyObserverSummary()
  return Object.freeze({
    schema: OBSERVER_BATCH_SCHEMA,
    dispatch: sanitizedDispatch,
    recordsSha256: dataHash(sanitizedRecords),
    summary,
    records: sanitizedRecords,
  })
}

export function assertStorageAbObserverEvidenceBounds({ batchCount, encodedBytes }) {
  assert.ok(Number.isSafeInteger(batchCount) && batchCount >= 0 && batchCount <= MAX_OBSERVER_BATCHES,
    'Observer evidence exceeds 116 batches.')
  assert.ok(Number.isSafeInteger(encodedBytes) && encodedBytes >= 0 && encodedBytes <= MAX_OBSERVER_EVIDENCE_BYTES,
    'Observer evidence exceeds 128 MiB byte bound.')
  return true
}

function observerAssociationKey(dispatch) {
  return dispatch.phase === 'auxiliary'
    ? `auxiliary:${dispatch.lane}:${dispatch.role}`
    : `${dispatch.phase}:${dispatch.lane}:${dispatch.ordinal}`
}

function validatePersistedObserverBatch(batch) {
  assert.ok(batch && typeof batch === 'object' && !Array.isArray(batch), 'Invalid persisted observer batch.')
  assert.deepEqual(Object.keys(batch).sort(), ['dispatch', 'records', 'recordsSha256', 'schema', 'summary'],
    'Invalid persisted observer batch keys.')
  assert.equal(batch.schema, OBSERVER_BATCH_SCHEMA, 'Invalid persisted observer batch schema.')
  const records = sanitizeStorageAbObserverRecords(batch.records, { requireFrozen: false })
  const dispatch = sanitizeObserverDispatch(batch.dispatch, records.length)
  assert.ok(records.length > 0 || dispatch.phase === 'auxiliary', 'Empty setup or measured observer batch.')
  const summary = records.length > 0 ? summarizeStorageAbRecords(records) : emptyObserverSummary()
  assert.equal(batch.recordsSha256, dataHash(records), 'Observer records hash mismatch.')
  assert.equal(canonical(batch.summary), canonical(summary), 'Observer summary replay mismatch.')
  return { dispatch, records, summary, recordsSha256: batch.recordsSha256 }
}

export function replayStorageAbObserverEvidence({ evidence, setupRows, measuredRows, auxiliaryRows }) {
  assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'Invalid observer evidence.')
  assert.deepEqual(Object.keys(evidence).sort(), ['batches', 'schema'], 'Invalid observer evidence keys.')
  assert.equal(evidence.schema, OBSERVER_EVIDENCE_SCHEMA, 'Invalid observer evidence schema.')
  const { batches } = evidence
  assert.ok(Array.isArray(batches) && Array.isArray(setupRows) && Array.isArray(measuredRows) && Array.isArray(auxiliaryRows),
    'Invalid observer replay input.')
  const encodedBytes = Buffer.byteLength(encode(evidence))
  assertStorageAbObserverEvidenceBounds({ batchCount: batches.length, encodedBytes })
  const rows = [...setupRows, ...measuredRows, ...auxiliaryRows]
  assert.equal(rows.length, batches.length, 'Observer batches do not cover every custody row.')
  const rowMap = new Map()
  for (const row of rows) {
    const key = observerAssociationKey(row)
    assert.equal(rowMap.has(key), false, 'Duplicate observer custody row association.')
    rowMap.set(key, row)
  }
  let recordCount = 0
  const seen = new Set()
  for (const batch of batches) {
    const replayed = validatePersistedObserverBatch(batch)
    const key = observerAssociationKey(replayed.dispatch)
    assert.equal(seen.has(key), false, 'Duplicate observer batch association.')
    seen.add(key)
    const row = rowMap.get(key)
    assert.ok(row, 'Observer batch has no linked custody row.')
    for (const [field, value] of Object.entries(replayed.dispatch)) assert.equal(row[field], value,
      `Observer dispatch association differs at ${field}.`)
    assert.equal(row.observerRecordsSha256, replayed.recordsSha256, 'Observer row hash link differs.')
    assert.equal(canonical(row.observer), canonical(replayed.summary), 'Observer row summary differs from replay.')
    assert.equal(canonical(row.io), canonical(selectedIo(replayed.summary)), 'Observer row I/O differs from replay.')
    recordCount += replayed.records.length
  }
  assert.equal(seen.size, rowMap.size, 'Unlinked observer custody row remains.')
  return {
    batches: batches.length,
    records: recordCount,
    linkedRows: rows.length,
    encodedBytes,
    evidenceSha256: dataHash(evidence),
  }
}

const AUXILIARY_ROLES = Object.freeze(['retry', 'idempotent-retry', 'changed-reuse', 'undo', 'redo', 'reopen'])
const ZERO_OBSERVER_REASONS = Object.freeze({
  retry: 'no-backup-idempotent-read',
  'idempotent-retry': 'no-backup-idempotent-read',
  'changed-reuse': 'no-backup-rejected-transaction-reuse',
  reopen: 'no-backup-read-only-open',
})

function validateStorageMetric(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Invalid storage metric.')
  assert.deepEqual(Object.keys(value).sort(), ['backupIndex', 'backupPack', 'committedRevision', 'lastValidBackup', 'ledgerEntries', 'primaryReceipt'],
    'Invalid storage metric.')
  assert.ok(Number.isSafeInteger(value.committedRevision) && value.committedRevision >= 0, 'Invalid storage revision.')
  assert.ok(Number.isSafeInteger(value.ledgerEntries) && value.ledgerEntries >= 0, 'Invalid storage ledger count.')
  assert.ok(value.lastValidBackup === null || typeof value.lastValidBackup === 'string', 'Invalid storage backup identity.')
  for (const key of ['primaryReceipt', 'backupPack', 'backupIndex']) {
    const metric = value[key]
    assert.ok(metric && typeof metric === 'object' && !Array.isArray(metric), 'Invalid storage byte metric.')
    assert.ok(Number.isSafeInteger(metric.bytes) && metric.bytes >= 0, 'Invalid storage byte count.')
    assert.match(metric.sha256, SEAL_PATTERN, 'Invalid storage byte hash.')
  }
  assert.match(value.primaryReceipt.resultSha256, SEAL_PATTERN, 'Invalid stored result hash.')
}

export function createStorageAbAuxiliaryCustodyRow(input) {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Invalid auxiliary custody input.')
  assert.ok(STORAGE_AB_DIAGNOSTIC.lanes.includes(input.lane), 'Invalid auxiliary lane.')
  assert.ok(AUXILIARY_ROLES.includes(input.role), 'Invalid auxiliary role.')
  const expectedOutcome = input.role === 'changed-reuse' ? 'rejected' : 'fulfilled'
  assert.equal(input.outcome, expectedOutcome, 'Invalid auxiliary outcome.')
  validateStorageMetric(input.storageBefore)
  validateStorageMetric(input.storageAfter)
  assert.ok(Array.isArray(input.records), 'Missing auxiliary observer records.')
  let observer
  let zeroObserverReason = null
  if (input.records.length > 0) {
    assert.equal(input.zeroObserverReason, null, 'Observer reason supplied for a recorded backup.')
    observer = summarizeStorageAbRecords(input.records)
  } else {
    assert.equal(input.zeroObserverReason, ZERO_OBSERVER_REASONS[input.role], 'Undocumented zero-record auxiliary operation.')
    zeroObserverReason = input.zeroObserverReason
    observer = { records: 0, invocation: null, terminalObserverFault: false, kinds: {} }
  }
  return {
    phase: 'auxiliary', lane: input.lane, role: input.role, outcome: input.outcome,
    observer, zeroObserverReason,
    storageBefore: structuredClone(input.storageBefore), storageAfter: structuredClone(input.storageAfter),
    publicResultSha256: dataHash(input.publicResult),
    diskBeforeSha256: dataHash(input.diskState?.before ?? input.diskState),
    diskAfterSha256: dataHash(input.diskState?.after ?? input.diskState),
    diskSha256: dataHash(input.diskState),
  }
}

export function validateStorageAbAuxiliaryCustodyRows(rows) {
  assert.ok(Array.isArray(rows), 'Auxiliary custody must be an array.')
  assert.equal(rows.length, STORAGE_AB_DIAGNOSTIC.lanes.length * AUXILIARY_ROLES.length, 'Missing auxiliary custody rows.')
  const lanes = { v1: 0, v2: 0 }
  const roles = Object.fromEntries(AUXILIARY_ROLES.map((role) => [role, 0]))
  const seen = new Set()
  for (const row of rows) {
    assert.equal(row.phase, 'auxiliary', 'Auxiliary row entered measured custody.')
    assert.ok(STORAGE_AB_DIAGNOSTIC.lanes.includes(row.lane), 'Invalid auxiliary lane.')
    assert.ok(AUXILIARY_ROLES.includes(row.role), 'Invalid auxiliary role.')
    assert.equal(seen.has(`${row.lane}:${row.role}`), false, 'Duplicate auxiliary custody row.')
    seen.add(`${row.lane}:${row.role}`)
    assert.equal(row.outcome, row.role === 'changed-reuse' ? 'rejected' : 'fulfilled', 'Invalid auxiliary outcome.')
    validateStorageMetric(row.storageBefore)
    validateStorageMetric(row.storageAfter)
    assert.match(row.publicResultSha256, SEAL_PATTERN, 'Invalid public result custody hash.')
    assert.match(row.diskBeforeSha256, SEAL_PATTERN, 'Invalid disk-before custody hash.')
    assert.match(row.diskAfterSha256, SEAL_PATTERN, 'Invalid disk-after custody hash.')
    assert.match(row.diskSha256, SEAL_PATTERN, 'Invalid disk custody hash.')
    assert.ok(row.observer && Number.isSafeInteger(row.observer.records) && row.observer.records >= 0,
      'Invalid auxiliary observer custody.')
    if (row.observer.records === 0) {
      assert.equal(row.zeroObserverReason, ZERO_OBSERVER_REASONS[row.role], 'Undocumented zero-record auxiliary operation.')
    } else {
      assert.equal(row.zeroObserverReason, null, 'Recorded observer operation has a zero-record reason.')
      assert.ok(Number.isSafeInteger(row.observer.invocation) && row.observer.invocation > 0, 'Invalid auxiliary observer invocation.')
    }
    assert.equal(Object.hasOwn(row, 'durationNs') || Object.hasOwn(row, 'ordinal') || Object.hasOwn(row, 'order'), false,
      'Auxiliary custody must not enter measured statistics.')
    lanes[row.lane] += 1
    roles[row.role] += 1
  }
  return { rows: rows.length, measuredRows: 0, lanes, roles }
}

export async function executeStorageAbCustodyLifecycle(options) {
  assert.ok(options && typeof options === 'object', 'Custody lifecycle options required.')
  assert.match(options.readiness?.sourceSealSha256, SEAL_PATTERN, 'Invalid source custody seal.')
  assert.equal(typeof options.readiness?.tsv, 'string', 'Invalid source custody manifest.')
  for (const callback of ['getWorkspaceOwners', 'writeJson', 'writeText', 'runWorkload', 'cleanupLane', 'collectSourcesAfter']) {
    assert.equal(typeof options[callback], 'function', `Missing custody callback: ${callback}.`)
  }
  const secondaryFailures = []
  let evidenceWriteStatus = 'PASS'
  let sourcesBeforeStatus = 'PASS'
  let workloadStatus = 'UNTESTED'
  let functionalStatus = 'UNTESTED'
  let sourceAfterStatus = 'FAIL'
  let primaryError = null
  let payload = options.basePayload && typeof options.basePayload === 'object' ? options.basePayload : {}
  let observerEvidence = null

  async function evidence(stage, callback) {
    try { return { ok: true, value: await callback() } }
    catch (error) {
      evidenceWriteStatus = 'FAIL'
      secondaryFailures.push(errorRecord(error, stage))
      return { ok: false, value: null }
    }
  }

  const beforeJson = await evidence('sources-before-json', () => options.writeJson('sources-before.json', options.readiness))
  const beforeTsv = await evidence('sources-before-tsv', () => options.writeText('sources-before.tsv', options.readiness.tsv))
  if (!beforeJson.ok || !beforeTsv.ok) sourcesBeforeStatus = 'FAIL'
  if (sourcesBeforeStatus === 'PASS') {
    workloadStatus = 'RUNNING'
    try {
      const completed = await options.runWorkload()
      assert.ok(completed && typeof completed === 'object', 'Workload result required.')
      functionalStatus = completed.functionalStatus === 'PASS' ? 'PASS' : 'FAIL'
      payload = completed.payload && typeof completed.payload === 'object' ? { ...payload, ...completed.payload } : payload
      observerEvidence = completed.observerEvidence ?? null
      workloadStatus = 'PASS'
    } catch (error) {
      workloadStatus = 'FAIL'
      functionalStatus = 'FAIL'
      primaryError = errorRecord(error, 'workload')
    }
  }
  if (observerEvidence !== null) {
    await evidence('observer-evidence', () => options.writeJson('observer-records.json', observerEvidence))
    if (Array.isArray(observerEvidence.batches)) observerEvidence.batches.length = 0
    observerEvidence = null
  }

  const cleanupLanes = { v1: 'NOT_CREATED', v2: 'NOT_CREATED' }
  const owners = options.getWorkspaceOwners()
  for (const lane of STORAGE_AB_DIAGNOSTIC.lanes) {
    if (!owners?.[lane]) continue
    try { await options.cleanupLane(lane, owners[lane]); cleanupLanes[lane] = 'PASS' }
    catch (error) { cleanupLanes[lane] = 'FAIL'; secondaryFailures.push(errorRecord(error, `cleanup-${lane}`)) }
  }
  const cleanupStatus = {
    lanes: cleanupLanes,
    overall: Object.values(cleanupLanes).every((status) => status === 'PASS' || status === 'NOT_CREATED') ? 'PASS' : 'FAIL',
  }

  let sourcesAfter = null
  try {
    sourcesAfter = await options.collectSourcesAfter()
    assert.equal(sourcesAfter.sourceSealSha256, options.readiness.sourceSealSha256, 'Source closure changed during run.')
    assert.equal(sourcesAfter.tsv, options.readiness.tsv, 'Source custody changed during run.')
    sourceAfterStatus = 'PASS'
  } catch (error) {
    secondaryFailures.push(errorRecord(error, 'sources-after'))
  }
  const sourceAfterEvidence = sourcesAfter ?? { status: 'FAIL', failure: secondaryFailures.at(-1) ?? null }
  await evidence('sources-after-json', () => options.writeJson('sources-after.json', sourceAfterEvidence))
  await evidence('sources-after-tsv', () => options.writeText('sources-after.tsv', sourcesAfter?.tsv ?? ''))
  if (payload.postconditions && typeof payload.postconditions === 'object') {
    payload.postconditions.sourceCustody = sourceAfterStatus
    await evidence('postconditions', () => options.writeJson('postconditions.json', payload.postconditions))
  }

  const requiredPass = () => sourcesBeforeStatus === 'PASS' && workloadStatus === 'PASS' && functionalStatus === 'PASS'
    && sourceAfterStatus === 'PASS' && cleanupStatus.overall === 'PASS' && evidenceWriteStatus === 'PASS'
  let result = {
    ...payload,
    schema: STORAGE_AB_DIAGNOSTIC.schema,
    status: requiredPass() ? 'PASS' : 'PARTIAL',
    observationStatus: requiredPass() ? 'COMPLETE' : 'INCOMPLETE',
    sourcesBeforeStatus, workloadStatus, functionalStatus, sourceAfterStatus, cleanupStatus, evidenceWriteStatus,
    sourceAfter: { status: sourceAfterStatus, identical: sourceAfterStatus === 'PASS' },
    performanceAcceptance: 'NOT_ASSESSED', historicalComparison: false, thresholdGainUnder50Ms: null,
    gainAcceptance: null, sourceSealSha256: options.readiness.sourceSealSha256,
    ...(primaryError ? { error: primaryError } : {}),
    secondaryFailures,
    exitCode: requiredPass() ? 0 : 1,
    finished: requiredPass(),
  }
  const exitWritten = await evidence('exit-code', () => options.writeText('exit-code.txt', `${result.exitCode}\n`))
  if (!exitWritten.ok) {
    result = { ...result, status: 'PARTIAL', observationStatus: 'INCOMPLETE', evidenceWriteStatus, exitCode: 1,
      finished: false, secondaryFailures }
  }
  const summaryWritten = await evidence('summary', () => options.writeJson('summary.json', result))
  if (!summaryWritten.ok) {
    result = { ...result, status: 'PARTIAL', observationStatus: 'INCOMPLETE', evidenceWriteStatus, exitCode: 1,
      finished: false, secondaryFailures }
  }
  if (summaryWritten.ok && summaryWritten.value && typeof summaryWritten.value === 'object') {
    Object.defineProperty(result, 'summaryArtifact', { value: Object.freeze(structuredClone(summaryWritten.value)), enumerable: false })
  }
  return result
}

export function createStorageAbRepositories(Repository, options) {
  assert.equal(typeof Repository, 'function', 'Repository constructor required.')
  const common = {
    createProjectKey: options.createProjectKey,
    createSceneKey: options.createSceneKey,
    now: options.now,
    backupCostObserver: options.observer,
  }
  return {
    v1: new Repository({ getWorkspaceRoot: () => options.v1Root, ...common, diagnosticStoredResultSchema: 'v1' }),
    v2: new Repository({ getWorkspaceRoot: () => options.v2Root, ...common, diagnosticStoredResultSchema: 'v2' }),
  }
}

// Literal-only ESM scanner. Unknown syntax or packages fail closed.
export function moduleSpecifiers(source) {
  const imports = [...source.matchAll(/^[ \t]*(import|export)\s+(type\s+)?(\{[^}]*\}|\*\s*(?:as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s*['"]([^'"]+)['"]/gm)]
  const sideEffects = [...source.matchAll(/^[ \t]*import\s*['"]([^'"]+)['"]/gm)]
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
  const staticCount = [...source.matchAll(/^[ \t]*import\b(?!\s*(?:\(|\.))/gm)].length
  const dynamicCount = [...source.matchAll(/\bimport\s*\(/g)].length
  assert.equal(staticCount, imports.filter((match) => match[1] === 'import').length + sideEffects.length,
    'Unsupported static import syntax in source closure.')
  assert.equal(dynamicCount, dynamic.length, 'Unsupported dynamic import syntax in source closure.')
  assert.equal(/\brequire\s*\(/.test(source), false, 'CommonJS is outside the source closure.')
  return [...new Set([...imports.filter((match) => !match[2]).map((match) => match[4]),
    ...sideEffects.map((match) => match[1]), ...dynamic.map((match) => match[1])])]
}

async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function confinedFile(path) {
  assert.equal(await realpath(path), path, `Source alias or symlink: ${path}`)
  assert.ok(path.startsWith(`${ROOT}/`), `Source escapes checkout: ${path}`)
  const info = await lstat(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Source is not a regular file: ${path}`)
  return info
}

export async function collectStorageAbReadiness(options) {
  assert.deepEqual(options, { mode: 'report-only', sealSha256: null, diagnosticStorageAb: true },
    'Storage A/B readiness requires exact report-only diagnostic mode.')
  assert.equal(await realpath(ROOT), ROOT, 'Canonical checkout is a symlink.')
  const pending = [join(ROOT, 'scripts/worlds-command-storage-ab.mjs')]
  const files = new Map()
  const edges = []
  const extensionless = []
  async function add(path, scan) {
    if (files.has(path)) return
    const info = await confinedFile(path)
    files.set(path, { path: relative(ROOT, path), size: info.size, sha256: await fileHash(path) })
    if (!scan) return
    const source = await readFile(path, 'utf8')
    for (const specifier of moduleSpecifiers(source)) {
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
        assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `Unsupported runtime package: ${specifier}`)
        target = resolve(dirname(path), specifier)
        if (!extname(target)) {
          let exact = false
          let typed = false
          try { exact = (await lstat(target)).isFile() } catch (error) { if (error.code !== 'ENOENT') throw error }
          try { typed = (await lstat(`${target}.ts`)).isFile() } catch (error) { if (error.code !== 'ENOENT') throw error }
          assert.notEqual(exact, typed, `Missing or ambiguous extensionless import: ${target}`)
          if (typed) { target += '.ts'; extensionless.push({ importer: relative(ROOT, path), specifier }) }
        }
      }
      edges.push({ importer: relative(ROOT, path), specifier, target: relative(ROOT, target) })
      pending.push(target)
    }
  }
  while (pending.length) await add(pending.pop(), true)
  for (const path of ['scripts/worlds-command-storage-ab.test.mjs', 'package.json', 'package-lock.json']) {
    await add(join(ROOT, path), false)
  }
  await add(LOADER, true)
  const sources = [...files.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const tsv = sources.map((file) => `${file.path}\t${file.size}\t${file.sha256}\n`).join('')
  const runtime = {
    executable: await realpath(process.execPath),
    version: process.version,
    sha256: await fileHash(process.execPath),
    execArgv: ['--experimental-strip-types', '--loader', LOADER],
  }
  const sourceSealSha256 = sha256(`${tsv}${encode(runtime)}${encode(STORAGE_AB_DIAGNOSTIC)}`)
  return { sourceSealSha256, sources, tsv, runtime, extensionless, edges, loader: LOADER,
    diagnostic: STORAGE_AB_DIAGNOSTIC }
}

export function createStorageAbReportOnly(readiness) {
  assert.match(readiness.sourceSealSha256, SEAL_PATTERN)
  assert.equal(readiness.runtime.version, REQUIRED_NODE_VERSION, 'Unexpected sealed Node version.')
  assert.ok(typeof readiness.runtime.executable === 'string' && readiness.runtime.executable.startsWith('/'),
    'Sealed Node executable must be absolute.')
  return {
    mode: 'report-only', status: 'NOT_EXECUTED', applicationImported: false, workspaceCreated: false,
    performanceAcceptance: 'NOT_ASSESSED', historicalComparison: false, thresholdGainUnder50Ms: null,
    gainAcceptance: null, diagnostic: STORAGE_AB_DIAGNOSTIC, ...readiness,
    proposedArgv: [readiness.runtime.executable, ...readiness.runtime.execArgv, join(ROOT, 'scripts/worlds-command-storage-ab.mjs'),
      '--run', '--seal-sha256', readiness.sourceSealSha256, '--diagnostic-storage-ab'],
  }
}

export function validateStorageAbRunAdmission(options, readiness, environment) {
  assert.deepEqual(options, { mode: 'run', sealSha256: readiness.sourceSealSha256, diagnosticStorageAb: true },
    'Reviewed source seal or storage A/B mode differs.')
  assert.deepEqual(readiness.diagnostic, STORAGE_AB_DIAGNOSTIC, 'Diagnostic descriptor differs from seal.')
  assert.equal(environment.cwd, ROOT, 'Run from the canonical checkout.')
  assert.equal(readiness.runtime.version, REQUIRED_NODE_VERSION, 'Unexpected sealed Node version.')
  assert.equal(environment.executable, readiness.runtime.executable, 'Unexpected Node executable.')
  assert.equal(environment.version, readiness.runtime.version, 'Unexpected Node version.')
  assert.deepEqual(environment.execArgv, readiness.runtime.execArgv, 'Runtime loader flags differ from seal.')
  assert.equal(environment.nodeOptions, '', 'NODE_OPTIONS is not allowed.')
  assert.equal(environment.nodePath, '', 'NODE_PATH is not allowed.')
}

async function absent(path) {
  try { await lstat(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}

async function ownedDirectory(prefix) {
  const path = await mkdtemp(prefix)
  await chmod(path, 0o700)
  const info = await lstat(path, { bigint: true })
  assert.ok(info.isDirectory() && !info.isSymbolicLink())
  assert.equal(await realpath(path), path)
  return { token: randomBytes(16).toString('hex'), path, dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid) }
}

async function assertOwned(owner) {
  const info = await lstat(owner.path, { bigint: true })
  assert.ok(info.isDirectory() && !info.isSymbolicLink())
  assert.equal(await realpath(owner.path), owner.path)
  assert.deepEqual({ dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid) },
    { dev: owner.dev, ino: owner.ino, uid: owner.uid })
}

async function filesystem(path) {
  const info = await statfs(path, { bigint: true })
  return { type: `0x${info.type.toString(16)}`, blockSize: String(info.bsize) }
}

export async function writeStorageAbAtomicEvidence(directory, name, content) {
  assert.ok(typeof directory === 'string' && directory.startsWith('/tmp/'), 'Invalid evidence directory.')
  assert.match(name, /^[a-z0-9][a-z0-9.-]{0,127}$/, 'Invalid evidence file name.')
  assert.equal(await realpath(directory), directory, 'Evidence directory is aliased.')
  const directoryInfo = await lstat(directory)
  assert.ok(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(), 'Evidence directory is not an owned directory.')
  const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content), 'utf8')
  const target = join(directory, name)
  try {
    const targetInfo = await lstat(target)
    assert.ok(targetInfo.isFile() && !targetInfo.isSymbolicLink(), 'Evidence target is not a regular file.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const temporary = join(directory, `.${name}.${randomBytes(16).toString('hex')}.tmp`)
  let handle = null
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, target)
    const directoryHandle = await open(directory, 'r')
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    const published = await lstat(target)
    assert.ok(published.isFile() && !published.isSymbolicLink(), 'Published evidence is not a regular file.')
    assert.equal(published.mode & 0o777, 0o600, 'Published evidence permissions differ.')
    return Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) })
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function writeEvidence(directory, name, value) {
  return writeStorageAbAtomicEvidence(directory, name, encode(value))
}

function successful(result) {
  assert.equal(result?.ok, true, result?.ok ? undefined : result?.error?.code)
  return result.value
}

function comparableResult(value) {
  const copied = structuredClone(value)
  if (copied.receipt) copied.receipt.resultSha256 = '<schema-specific>'
  return copied
}

function comparableOperationResult(result) {
  if (result?.ok !== true) return structuredClone(result)
  return { ok: true, value: comparableResult(result.value) }
}

function entity(index) {
  return {
    id: `entity:storage-ab-${String(index).padStart(3, '0')}`,
    name: `Entity ${String(index).padStart(3, '0')}`,
    parentId: null,
    enabled: true,
    locked: false,
    tags: [],
    transform: { position: [index, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [],
  }
}

function commandBatch(phase, ordinal, baseRevision, projectId, sceneId) {
  return {
    schema: 'modly.world-command-batch.v1',
    transactionId: `tx:storage-ab:${phase}:${String(ordinal).padStart(2, '0')}`,
    projectId,
    baseRevision,
    origin: 'ui',
    commands: phase === 'setup' && ordinal === 1
      ? Array.from({ length: STORAGE_AB_DIAGNOSTIC.entities }, (_, index) => ({ type: 'add-entity', sceneId, entity: entity(index) }))
      : [{ type: 'rename-project', name: `Storage AB ${phase} ${String(ordinal).padStart(2, '0')}` }],
  }
}

async function readStorageMetrics(root) {
  const projectRoot = join(root, 'Worlds', PROJECT_KEY)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  const transaction = state.transactions.at(-1)
  assert.ok(transaction)
  const receipt = await readFile(join(projectRoot, '.modly/transactions', transaction.transactionDigest, 'after/result.v1.json'))
  let pack = Buffer.alloc(0)
  let index = Buffer.alloc(0)
  if (state.lastValidBackup) {
    const backup = join(projectRoot, state.lastValidBackup)
    pack = await readFile(join(backup, 'transactions.pack.v1'))
    index = await readFile(join(backup, 'transactions.index.v1.json'))
  }
  return {
    committedRevision: state.committedRevision,
    ledgerEntries: state.transactions.length,
    lastValidBackup: state.lastValidBackup,
    primaryReceipt: { bytes: receipt.byteLength, sha256: sha256(receipt), resultSha256: transaction.resultSha256 },
    backupPack: { bytes: pack.byteLength, sha256: sha256(pack) },
    backupIndex: { bytes: index.byteLength, sha256: sha256(index) },
  }
}

function selectedIo(summary) {
  const selected = {}
  for (const kind of ['bounded-read', 'read-await', 'write-file', 'write-positional', 'file-sync', 'directory-sync']) {
    selected[kind] = summary.kinds[kind] ?? { calls: 0, requestedBytes: 0, completedBytes: 0, sourceBytes: 0 }
  }
  return selected
}

async function normalizedTree(root) {
  async function walk(path, relativePath) {
    const info = await lstat(path)
    assert.equal(info.isSymbolicLink(), false, 'Workspace contains a symlink.')
    if (info.isDirectory()) {
      const entries = {}
      for (const name of (await readdir(path)).sort()) {
        const normalized = relativePath === '.modly/backups' ? name.replace(/^(\d+)-[a-f0-9]{64}$/, '$1-<state>') : name
        entries[normalized] = await walk(join(path, name), relativePath ? `${relativePath}/${normalized}` : normalized)
      }
      return { kind: 'directory', entries }
    }
    assert.equal(info.isFile(), true)
    const bytes = await readFile(path)
    if (/result\.v1\.json$|transactions\.pack\.v1$|transactions\.index\.v1\.json$/.test(relativePath)) {
      return { kind: 'schema-specific-storage' }
    }
    if (/state\.v1\.json$/.test(relativePath)) {
      const value = JSON.parse(bytes.toString('utf8'))
      for (const transaction of value.transactions ?? []) transaction.resultSha256 = '<schema-specific>'
      if (typeof value.lastValidBackup === 'string') value.lastValidBackup = value.lastValidBackup.replace(/^(\.modly\/backups\/\d+)-[a-f0-9]{64}$/, '$1-<state>')
      return { kind: 'state', canonical: canonical(value) }
    }
    return { kind: 'file', bytes: bytes.toString('base64') }
  }
  return walk(join(root, 'Worlds', PROJECT_KEY), '')
}

async function backupCount(root) {
  const path = join(root, 'Worlds', PROJECT_KEY, '.modly', 'backups')
  return (await readdir(path)).length
}

async function runStorageAb(readiness) {
  const evidenceOwner = await ownedDirectory(EVIDENCE_PREFIX)
  const workspaceOwners = { v1: null, v2: null }
  const rows = []
  const setupCustody = []
  const auxiliaryCustody = []
  const observerBatches = []
  const postconditions = {}
  let active = null
  const evidence = evidenceOwner.path
  async function runWorkload() {
    workspaceOwners.v1 = await ownedDirectory(WORKSPACE_PREFIXES.v1)
    workspaceOwners.v2 = await ownedDirectory(WORKSPACE_PREFIXES.v2)
    await writeEvidence(evidence, 'owned-workspaces.json', workspaceOwners)
    const v1Filesystem = await filesystem(workspaceOwners.v1.path)
    const v2Filesystem = await filesystem(workspaceOwners.v2.path)
    assert.equal(v1Filesystem.type, v2Filesystem.type, 'Lane filesystem types differ.')
    await writeEvidence(evidence, 'environment.json', {
      cwd: await realpath(process.cwd()), argv: process.argv, execArgv: process.execArgv,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? '', NODE_PATH: process.env.NODE_PATH ?? '',
      runtime: readiness.runtime, platform: process.platform, architecture: process.arch, release: release(),
      filesystems: { v1: v1Filesystem, v2: v2Filesystem },
    })

    // Application code is imported only after seal and environment admission.
    const [{ WorldProjectRepository }] = await Promise.all([
      import('../electron/main/world-project-repository.ts'),
      import('../src/areas/worlds/worldProjectService.ts'),
      import('../src/areas/worlds/editor/worldEditorController.ts'),
      import('../src/areas/worlds/editor/worldAuthoringModel.ts'),
      import('../src/areas/worlds/editor/worldEditorCommandBuilders.ts'),
    ])
    const observer = (record) => { if (active) active.records.push(record) }
    const constructors = {
      v1Root: workspaceOwners.v1.path,
      v2Root: workspaceOwners.v2.path,
      observer,
      createProjectKey: () => PROJECT_KEY,
      createSceneKey: () => SCENE_KEY,
      now: () => new Date('2026-09-15T00:00:00.000Z'),
    }
    let repositories = createStorageAbRepositories(WorldProjectRepository, constructors)
    const createRequest = { name: 'Storage AB', initialSceneName: 'Scene', projectId: PROJECT_ID, initialSceneId: SCENE_ID }
    const created = {
      v1: successful(await repositories.v1.create(structuredClone(createRequest))),
      v2: successful(await repositories.v2.create(structuredClone(createRequest))),
    }
    assert.equal(canonical(created.v1.snapshot), canonical(created.v2.snapshot), 'Initial lane snapshots differ.')
    let snapshots = { v1: created.v1.snapshot, v2: created.v2.snapshot }
    let previousSettled = null

    async function dispatch(lane, batch, phase, ordinal, order) {
      assert.equal(active, null, 'Lane operations overlap.')
      const records = []
      active = { lane, records }
      const started = process.hrtime.bigint()
      if (previousSettled !== null) assert.ok(started >= previousSettled, 'Nonmonotonic inter-dispatch clock.')
      let applied
      try { applied = await repositories[lane].applyCommands({ projectKey: PROJECT_KEY, batch: structuredClone(batch) }) }
      finally { await new Promise((resolvePromise) => setImmediate(resolvePromise)); active = null }
      const settledNs = process.hrtime.bigint()
      assert.ok(settledNs >= started, 'Nonmonotonic dispatch clock.')
      previousSettled = settledNs
      const value = successful(applied)
      const observerBatch = createStorageAbObserverBatch({
        dispatch: { phase, lane, ordinal, order, transactionId: batch.transactionId,
          baseRevision: batch.baseRevision, inputSha256: dataHash(batch) },
        records,
      })
      observerBatches.push(observerBatch)
      const fine = observerBatch.summary
      const storage = await readStorageMetrics(workspaceOwners[lane].path)
      const row = {
        lane, phase, ordinal, order, baseRevision: batch.baseRevision, transactionId: batch.transactionId,
        inputSha256: dataHash(batch), startedNs: String(started), settledNs: String(settledNs),
        durationNs: String(settledNs - started), storage, io: selectedIo(fine), observer: fine,
        observerRecordsSha256: observerBatch.recordsSha256,
      }
      return { value, row }
    }

    async function dispatchPair(phase, ordinal) {
      assert.equal(snapshots.v1.project.revision, snapshots.v2.project.revision, 'Lane revisions differ before pair.')
      const batch = commandBatch(phase, ordinal, snapshots.v1.project.revision, PROJECT_ID, SCENE_ID)
      const order = ordinal % 2 === 1 ? 'v1-v2' : 'v2-v1'
      const values = {}
      const pairRows = []
      for (const lane of order.split('-')) {
        const dispatched = await dispatch(lane, batch, phase, ordinal, order)
        values[lane] = dispatched.value
        pairRows.push(dispatched.row)
      }
      assert.equal(canonical(comparableResult(values.v1)), canonical(comparableResult(values.v2)), `Public lane mismatch at ${phase} ${ordinal}.`)
      assert.equal(canonical(values.v1.snapshot), canonical(values.v2.snapshot), `Snapshot lane mismatch at ${phase} ${ordinal}.`)
      assert.equal(canonical(values.v1.inverse), canonical(values.v2.inverse), `Inverse lane mismatch at ${phase} ${ordinal}.`)
      snapshots = { v1: values.v1.snapshot, v2: values.v2.snapshot }
      if (phase === 'measure') rows.push(...pairRows)
      else setupCustody.push(...pairRows)
      return { batch, values }
    }

    for (let ordinal = 1; ordinal <= STORAGE_AB_DIAGNOSTIC.setupBatchesPerLane; ordinal += 1) await dispatchPair('setup', ordinal)
    assert.equal(snapshots.v1.scenes[0].entities.length, 100)
    let lastMeasured
    for (let ordinal = 1; ordinal <= STORAGE_AB_DIAGNOSTIC.measuredBatchesPerLane; ordinal += 1) lastMeasured = await dispatchPair('measure', ordinal)
    const metrics = summarizeStorageAbRows(rows)

    async function captureAuxiliary(lane, role, execute, zeroObserverReason) {
      assert.equal(active, null, 'Lane operations overlap.')
      const storageBefore = await readStorageMetrics(workspaceOwners[lane].path)
      const diskBefore = await normalizedTree(workspaceOwners[lane].path)
      const records = []
      active = { lane, records }
      let operationResult
      try { operationResult = await execute() }
      finally { await new Promise((resolvePromise) => setImmediate(resolvePromise)); active = null }
      const outcome = operationResult?.ok === false ? 'rejected' : 'fulfilled'
      const observerBatch = createStorageAbObserverBatch({
        dispatch: { phase: 'auxiliary', lane, role, outcome,
          zeroObserverReason: records.length === 0 ? zeroObserverReason : null },
        records,
      })
      observerBatches.push(observerBatch)
      const storageAfter = await readStorageMetrics(workspaceOwners[lane].path)
      const diskAfter = await normalizedTree(workspaceOwners[lane].path)
      const row = createStorageAbAuxiliaryCustodyRow({
        lane, role, outcome, records,
        zeroObserverReason: records.length === 0 ? zeroObserverReason : null,
        storageBefore, storageAfter, publicResult: operationResult, diskState: { before: diskBefore, after: diskAfter },
      })
      row.io = selectedIo(observerBatch.summary)
      row.observerRecordsSha256 = observerBatch.recordsSha256
      auxiliaryCustody.push(row)
      return operationResult
    }

    async function captureAuxiliaryPair(role, execute, zeroObserverReason) {
      const values = {}
      for (const lane of STORAGE_AB_DIAGNOSTIC.lanes) {
        values[lane] = await captureAuxiliary(lane, role, () => execute(lane), zeroObserverReason)
      }
      assert.equal(canonical(comparableOperationResult(values.v1)), canonical(comparableOperationResult(values.v2)),
        `Auxiliary public lane mismatch at ${role}.`)
      return values
    }

    repositories = createStorageAbRepositories(WorldProjectRepository, constructors)
    const retryResults = await captureAuxiliaryPair('retry', (lane) => repositories[lane].applyCommands({ projectKey: PROJECT_KEY,
      batch: structuredClone(lastMeasured.batch) }), ZERO_OBSERVER_REASONS.retry)
    const retries = { v1: successful(retryResults.v1), v2: successful(retryResults.v2) }
    assert.equal(retries.v1.idempotent, true)
    assert.equal(retries.v2.idempotent, true)
    assert.equal(canonical(comparableResult(retries.v1)), canonical(comparableResult(retries.v2)), 'Retry public projections differ.')
    const secondRetryResults = await captureAuxiliaryPair('idempotent-retry', (lane) => repositories[lane].applyCommands({ projectKey: PROJECT_KEY,
      batch: structuredClone(lastMeasured.batch) }), ZERO_OBSERVER_REASONS['idempotent-retry'])
    assert.equal(successful(secondRetryResults.v1).idempotent, true)
    assert.equal(successful(secondRetryResults.v2).idempotent, true)
    const changedResults = await captureAuxiliaryPair('changed-reuse', (lane) => {
      const changed = structuredClone(lastMeasured.batch)
      changed.commands = [{ type: 'rename-project', name: 'Changed transaction reuse' }]
      return repositories[lane].applyCommands({ projectKey: PROJECT_KEY, batch: changed })
    }, ZERO_OBSERVER_REASONS['changed-reuse'])
    for (const lane of STORAGE_AB_DIAGNOSTIC.lanes) {
      assert.equal(changedResults[lane].ok, false)
      assert.equal(changedResults[lane].error.code, 'transaction_reuse')
    }

    async function matchedAuxiliaryCommand(role, batch) {
      const results = await captureAuxiliaryPair(role, (lane) => repositories[lane].applyCommands({ projectKey: PROJECT_KEY,
        batch: structuredClone(batch) }), null)
      const values = { v1: successful(results.v1), v2: successful(results.v2) }
      snapshots = { v1: values.v1.snapshot, v2: values.v2.snapshot }
      return values
    }
    const undo = { ...commandBatch('undo', 1, snapshots.v1.project.revision, PROJECT_ID, SCENE_ID), origin: 'undo',
      commands: [{ type: 'rename-project', name: 'Storage AB measure 19' }] }
    const undone = await matchedAuxiliaryCommand('undo', undo)
    const redo = { ...commandBatch('redo', 1, snapshots.v1.project.revision, PROJECT_ID, SCENE_ID), origin: 'redo',
      commands: [{ type: 'rename-project', name: 'Storage AB measure 20' }] }
    const redone = await matchedAuxiliaryCommand('redo', redo)
    assert.equal(undone.v1.snapshot.project.name, 'Storage AB measure 19')
    assert.equal(redone.v1.snapshot.project.name, 'Storage AB measure 20')

    repositories = createStorageAbRepositories(WorldProjectRepository, constructors)
    const reopenedResults = await captureAuxiliaryPair('reopen', (lane) => repositories[lane].open({ projectKey: PROJECT_KEY }),
      ZERO_OBSERVER_REASONS.reopen)
    const reopened = { v1: successful(reopenedResults.v1), v2: successful(reopenedResults.v2) }
    assert.equal(reopened.v1.status, 'ready')
    assert.equal(reopened.v2.status, 'ready')
    assert.equal(canonical(reopened.v1.snapshot), canonical(reopened.v2.snapshot), 'Reopened snapshots differ.')
    const finalStorage = {
      v1: await readStorageMetrics(workspaceOwners.v1.path),
      v2: await readStorageMetrics(workspaceOwners.v2.path),
    }
    assert.equal(finalStorage.v1.ledgerEntries, 32)
    assert.equal(finalStorage.v2.ledgerEntries, 32)
    assert.equal(await backupCount(workspaceOwners.v1.path), 8)
    assert.equal(await backupCount(workspaceOwners.v2.path), 8)
    for (const lane of ['v1', 'v2']) assert.equal(await absent(join(workspaceOwners[lane].path, 'Worlds', PROJECT_KEY, '.modly', 'journal.v1.json')), true)
    assert.deepEqual(await normalizedTree(workspaceOwners.v1.path), await normalizedTree(workspaceOwners.v2.path),
      'Disk trees differ outside schema-specific receipt, pack, index bytes and result hashes.')
    const auxiliarySummary = validateStorageAbAuxiliaryCustodyRows(auxiliaryCustody)
    const observerEvidence = { schema: OBSERVER_EVIDENCE_SCHEMA, batches: observerBatches }
    const observerReplay = replayStorageAbObserverEvidence({ evidence: observerEvidence,
      setupRows: setupCustody, measuredRows: rows, auxiliaryRows: auxiliaryCustody })

    postconditions.functionalParity = 'PASS'
    postconditions.idempotentRetry = 'PASS'
    postconditions.changedReuse = 'PASS'
    postconditions.undoRedo = 'PASS'
    postconditions.reopen = 'PASS'
    postconditions.ledger32 = 'PASS'
    postconditions.backups8 = 'PASS'
    postconditions.journalAbsent = 'PASS'
    postconditions.diskEqualityOutsideStorageBodies = 'PASS'
    postconditions.auxiliaryCustody = auxiliarySummary
    postconditions.observerReplay = observerReplay
    await writeEvidence(evidence, 'scenario.json', { descriptor: STORAGE_AB_DIAGNOSTIC, createRequest,
      projectKey: PROJECT_KEY, projectId: PROJECT_ID, sceneId: SCENE_ID })
    await writeEvidence(evidence, 'setup-custody.json', setupCustody)
    await writeEvidence(evidence, 'raw-rows.json', rows)
    await writeEvidence(evidence, 'auxiliary-custody.json', auxiliaryCustody)
    return {
      functionalStatus: 'PASS',
      payload: { evidence, metrics, rows, auxiliaryCustody, storage: finalStorage, postconditions },
      observerEvidence,
    }
  }
  return executeStorageAbCustodyLifecycle({
    readiness,
    basePayload: { evidence, metrics: null, rows, auxiliaryCustody, postconditions },
    getWorkspaceOwners: () => workspaceOwners,
    writeJson: (name, value) => writeEvidence(evidence, name, value),
    writeText: (name, value) => writeStorageAbAtomicEvidence(evidence, name, value),
    runWorkload,
    cleanupLane: async (_lane, owner) => {
      active = null
      await assertOwned(owner)
      await rm(owner.path, { recursive: true, force: false })
      assert.equal(await absent(owner.path), true)
    },
    collectSourcesAfter: () => collectStorageAbReadiness({ mode: 'report-only', sealSha256: null, diagnosticStorageAb: true }),
  })
}

async function main(args) {
  const options = parseStorageAbArguments(args)
  const readiness = await collectStorageAbReadiness({ mode: 'report-only', sealSha256: null, diagnosticStorageAb: true })
  if (options.mode === 'report-only') {
    process.stdout.write(encode(createStorageAbReportOnly(readiness)))
    return 0
  }
  validateStorageAbRunAdmission(options, readiness, {
    cwd: await realpath(process.cwd()), executable: await realpath(process.execPath), version: process.version,
    execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '', nodePath: process.env.NODE_PATH ?? '',
  })
  const result = await runStorageAb(readiness)
  const receipt = createStorageAbStdoutReceipt({
    result,
    evidenceRoot: result.evidence,
    summarySha256: result.summaryArtifact?.sha256 ?? null,
    sealVerified: true,
  })
  process.stdout.write(encode(receipt))
  return result.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(encode({ schema: STORAGE_AB_DIAGNOSTIC.schema, status: 'PARTIAL', observationStatus: 'INCOMPLETE',
      functionalStatus: 'UNTESTED', performanceAcceptance: 'NOT_ASSESSED', historicalComparison: false,
      thresholdGainUnder50Ms: null, gainAcceptance: null, metrics: null, exitCode: 1, error: errorRecord(error) }))
    process.exitCode = 1
  })
}
