import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'scripts/worlds-command-storage-ab.mjs')

let subjectPromise
async function subject() {
  if (!subjectPromise) {
    try { await readFile(TARGET) } catch (error) {
      if (error?.code === 'ENOENT') assert.fail('storage AB collector artifact is absent')
      throw error
    }
    subjectPromise = import(pathToFileURL(TARGET).href)
  }
  return subjectPromise
}

test('storage ab exposes the exact descriptor and fail-closed CLI parser', async () => {
  const { STORAGE_AB_DIAGNOSTIC, parseStorageAbArguments } = await subject()
  assert.deepEqual(STORAGE_AB_DIAGNOSTIC, {
    schema: 'modly.worlds-command-storage-ab.v1',
    diagnosticFlag: '--diagnostic-storage-ab',
    entities: 100,
    setupBatchesPerLane: 32,
    measuredBatchesPerLane: 20,
    lanes: ['v1', 'v2'],
    order: 'odd-v1-v2-even-v2-v1',
    fileSync: 'default',
    directorySync: 'default',
    maxRecordsPerDispatch: 8192,
    historicalComparison: false,
    performanceAcceptance: 'NOT_ASSESSED',
    thresholdGainUnder50Ms: null,
    gainAcceptance: null,
  })
  assert.deepEqual(parseStorageAbArguments(['--report-only', '--diagnostic-storage-ab']), {
    mode: 'report-only', sealSha256: null, diagnosticStorageAb: true,
  })
  const seal = 'a'.repeat(64)
  assert.deepEqual(parseStorageAbArguments(['--run', '--seal-sha256', seal, '--diagnostic-storage-ab']), {
    mode: 'run', sealSha256: seal, diagnosticStorageAb: true,
  })
  for (const invalid of [[], ['--report-only'], ['--run', '--seal-sha256', seal],
    ['--report-only', '--diagnostic-fine-backup', '--diagnostic-storage-ab'],
    ['--run', '--seal-sha256', 'bad', '--diagnostic-storage-ab'],
    ['--run', '--seal-sha256', seal, '--diagnostic-storage-ab', '--diagnostic-storage-ab']]) {
    assert.throws(() => parseStorageAbArguments(invalid))
  }
})

test('storage ab seals its complete source closure and keeps report-only inert', async () => {
  const { collectStorageAbReadiness, createStorageAbReportOnly, parseStorageAbArguments,
    validateStorageAbRunAdmission } = await subject()
  const options = parseStorageAbArguments(['--report-only', '--diagnostic-storage-ab'])
  const readiness = await collectStorageAbReadiness(options)
  assert.match(readiness.sourceSealSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(readiness.runtime.execArgv, ['--experimental-strip-types', '--loader', join(ROOT, 'scripts/node-ts-extensionless-loader.mjs')])
  const paths = new Set(readiness.sources.map((entry) => entry.path))
  for (const required of ['scripts/worlds-command-storage-ab.mjs', 'scripts/worlds-command-storage-ab.test.mjs',
    'electron/main/world-project-repository.ts', 'src/areas/worlds/worldProjectService.ts',
    'src/areas/worlds/editor/worldEditorController.ts', 'src/areas/worlds/editor/worldAuthoringModel.ts',
    'src/areas/worlds/editor/worldEditorCommandBuilders.ts', 'package.json', 'package-lock.json',
    'scripts/node-ts-extensionless-loader.mjs']) assert.equal(paths.has(required), true, required)
  const report = createStorageAbReportOnly(readiness)
  assert.deepEqual({ mode: report.mode, status: report.status, applicationImported: report.applicationImported,
    workspaceCreated: report.workspaceCreated, performanceAcceptance: report.performanceAcceptance,
    historicalComparison: report.historicalComparison, thresholdGainUnder50Ms: report.thresholdGainUnder50Ms },
  { mode: 'report-only', status: 'NOT_EXECUTED', applicationImported: false, workspaceCreated: false,
    performanceAcceptance: 'NOT_ASSESSED', historicalComparison: false, thresholdGainUnder50Ms: null })
  assert.equal(report.proposedArgv.at(-1), '--diagnostic-storage-ab')
  assert.equal(report.proposedArgv.at(-3), '--seal-sha256')
  assert.equal(report.proposedArgv.at(-2), readiness.sourceSealSha256)
  const environment = { cwd: ROOT, executable: readiness.runtime.executable, version: readiness.runtime.version,
    execArgv: readiness.runtime.execArgv, nodeOptions: '', nodePath: '' }
  assert.doesNotThrow(() => validateStorageAbRunAdmission({ mode: 'run', sealSha256: readiness.sourceSealSha256,
    diagnosticStorageAb: true }, readiness, environment))
  assert.throws(() => validateStorageAbRunAdmission({ mode: 'run', sealSha256: 'b'.repeat(64),
    diagnosticStorageAb: true }, readiness, environment), /seal/i)
})

test('storage ab summarizes matched alternating rows without performance acceptance', async () => {
  const { summarizeStorageAbRows } = await subject()
  const rows = [
    { lane: 'v1', ordinal: 1, order: 'v1-v2', baseRevision: 32, inputSha256: 'a'.repeat(64), startedNs: '10', settledNs: '110', durationNs: '100' },
    { lane: 'v2', ordinal: 1, order: 'v1-v2', baseRevision: 32, inputSha256: 'a'.repeat(64), startedNs: '120', settledNs: '200', durationNs: '80' },
    { lane: 'v2', ordinal: 2, order: 'v2-v1', baseRevision: 33, inputSha256: 'b'.repeat(64), startedNs: '210', settledNs: '300', durationNs: '90' },
    { lane: 'v1', ordinal: 2, order: 'v2-v1', baseRevision: 33, inputSha256: 'b'.repeat(64), startedNs: '310', settledNs: '420', durationNs: '110' },
  ]
  const summary = summarizeStorageAbRows(rows, 2)
  assert.deepEqual(summary.lanes.v1, { count: 2, p50Ns: '100', p95Ns: '110', maxNs: '110' })
  assert.deepEqual(summary.lanes.v2, { count: 2, p50Ns: '80', p95Ns: '90', maxNs: '90' })
  assert.deepEqual(summary.pairedV2MinusV1, { count: 2, p50Ns: '-20', p95Ns: '-20', maxNs: '-20' })
  assert.deepEqual({ performanceAcceptance: summary.performanceAcceptance, historicalComparison: summary.historicalComparison,
    thresholdGainUnder50Ms: summary.thresholdGainUnder50Ms, gainAcceptance: summary.gainAcceptance },
  { performanceAcceptance: 'NOT_ASSESSED', historicalComparison: false, thresholdGainUnder50Ms: null, gainAcceptance: null })
  assert.throws(() => summarizeStorageAbRows(rows.map((row, index) => index === 1 ? { ...row, inputSha256: 'c'.repeat(64) } : row), 2), /input/i)
  assert.throws(() => summarizeStorageAbRows(rows.map((row, index) => index === 2 ? { ...row, order: 'v1-v2' } : row), 2), /order/i)
  assert.throws(() => summarizeStorageAbRows(rows.map((row, index) => index === 1
    ? { ...row, startedNs: '100', settledNs: '180' } : row), 2), /overlap/i)
})

test('storage ab constructs isolated direct repository lanes with one diagnostic variable', async () => {
  const { createStorageAbRepositories } = await subject()
  const constructions = []
  class FakeRepository { constructor(options) { this.options = options; constructions.push(options) } }
  const observer = () => undefined
  const lanes = createStorageAbRepositories(FakeRepository, { v1Root: '/tmp/owned-v1', v2Root: '/tmp/owned-v2', observer,
    createProjectKey: () => 'world-0123456789abcdef0123456789abcdef',
    createSceneKey: () => 'scene-0123456789abcdef0123456789abcdef', now: () => new Date(0) })
  assert.notEqual(lanes.v1, lanes.v2)
  assert.equal(constructions.length, 2)
  assert.equal(constructions[0].getWorkspaceRoot(), '/tmp/owned-v1')
  assert.equal(constructions[1].getWorkspaceRoot(), '/tmp/owned-v2')
  assert.equal(constructions[0].diagnosticStoredResultSchema, 'v1')
  assert.equal(constructions[1].diagnosticStoredResultSchema, 'v2')
  assert.equal(constructions[0].backupCostObserver, observer)
  assert.equal(constructions[1].backupCostObserver, observer)
  assert.equal(Object.hasOwn(constructions[0], 'syncDirectory'), false)
  assert.equal(Object.hasOwn(constructions[1], 'syncDirectory'), false)
})

function fineRecord(overrides = {}) {
  return Object.freeze({ schema: 'modly.world-backup-cost.v1', invocation: 1, sequence: 1, span: 1, parent: null,
    phase: 'prior-proof', kind: 'envelope', edge: 'begin', ns: '10', ledgerIndex: null, appliedRevision: null,
    target: 'state', requestedBytes: null, completedBytes: null, sourceBytes: null, calls: 1,
    outcome: 'pending', durable: null, ...overrides })
}

test('storage ab validates bounded primitive observer grammar and exact I/O metrics', async () => {
  const { summarizeStorageAbRecords } = await subject()
  const records = [
    fineRecord(),
    fineRecord({ sequence: 2, span: 2, parent: 1, kind: 'write-positional', edge: 'begin', ns: '20', target: 'pack',
      requestedBytes: 40, calls: 1 }),
    fineRecord({ sequence: 3, span: 2, parent: 1, kind: 'write-positional', edge: 'settled', ns: '30', target: 'pack',
      requestedBytes: 40, completedBytes: 40, calls: 1, outcome: 'fulfilled', durable: true }),
    fineRecord({ sequence: 4, span: 1, edge: 'settled', ns: '40', outcome: 'fulfilled', durable: true }),
  ]
  const summary = summarizeStorageAbRecords(records)
  assert.deepEqual(summary.kinds['write-positional'], { calls: 1, requestedBytes: 40, completedBytes: 40, sourceBytes: 0 })
  assert.equal(summary.records, 4)
  assert.throws(() => summarizeStorageAbRecords(records.map((record, index) => index === 1 ? { ...record } : record)), /frozen|schema/i)
  assert.throws(() => summarizeStorageAbRecords([...records, fineRecord({ sequence: 5, extra: 'forbidden' })]), /schema/i)
  assert.throws(() => summarizeStorageAbRecords(Array.from({ length: 8193 }, (_, index) => fineRecord({ sequence: index + 1 }))), /bound/i)
})

function custodyReadiness() {
  return { sourceSealSha256: 'd'.repeat(64), tsv: 'source\t1\t' + 'e'.repeat(64) + '\n' }
}

function storageMetric(revision) {
  return {
    committedRevision: revision,
    ledgerEntries: 32,
    lastValidBackup: `.modly/backups/${revision}-state`,
    primaryReceipt: { bytes: 123, sha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64) },
    backupPack: { bytes: 456, sha256: 'c'.repeat(64) },
    backupIndex: { bytes: 78, sha256: 'd'.repeat(64) },
  }
}

function settledFineRecords(invocation = 1) {
  return [
    fineRecord({ invocation }),
    fineRecord({ invocation, sequence: 2, edge: 'settled', ns: '20', outcome: 'fulfilled', durable: true }),
  ]
}

test('storage ab failure custody preserves source-after and independent successful cleanup after workload failure', async () => {
  const { executeStorageAbCustodyLifecycle } = await subject()
  assert.equal(typeof executeStorageAbCustodyLifecycle, 'function', 'failure custody lifecycle is missing')
  const readiness = custodyReadiness()
  const events = []
  const original = Object.assign(new Error('/tmp/private-workspace must not leak'), { code: 'parity_mismatch' })
  const result = await executeStorageAbCustodyLifecycle({
    readiness,
    getWorkspaceOwners: () => ({ v1: { token: 'owner-v1' }, v2: { token: 'owner-v2' } }),
    writeJson: async (name) => { events.push(`json:${name}`) },
    writeText: async (name) => { events.push(`text:${name}`) },
    runWorkload: async () => { events.push('workload'); throw original },
    cleanupLane: async (lane) => { events.push(`cleanup:${lane}`) },
    collectSourcesAfter: async () => { events.push('sources-after'); return structuredClone(readiness) },
  })
  assert.deepEqual({ workloadStatus: result.workloadStatus, functionalStatus: result.functionalStatus,
    sourceAfterStatus: result.sourceAfterStatus, cleanup: result.cleanupStatus,
    evidenceWriteStatus: result.evidenceWriteStatus, exitCode: result.exitCode }, {
    workloadStatus: 'FAIL', functionalStatus: 'FAIL', sourceAfterStatus: 'PASS',
    cleanup: { lanes: { v1: 'PASS', v2: 'PASS' }, overall: 'PASS' }, evidenceWriteStatus: 'PASS', exitCode: 1,
  })
  assert.deepEqual(result.error, { stage: 'workload', name: 'Error', code: 'parity_mismatch' })
  assert.equal(JSON.stringify(result).includes('private-workspace'), false)
  assert.ok(events.indexOf('sources-after') > events.indexOf('cleanup:v2'))
  assert.ok(events.includes('json:sources-after.json'))
  assert.ok(events.includes('text:sources-after.tsv'))
  assert.ok(events.includes('json:summary.json'))
  assert.ok(events.includes('text:exit-code.txt'))
})

test('storage ab failure custody reports cleanup failure independently from a successful workload', async () => {
  const { executeStorageAbCustodyLifecycle } = await subject()
  assert.equal(typeof executeStorageAbCustodyLifecycle, 'function', 'failure custody lifecycle is missing')
  const readiness = custodyReadiness()
  const result = await executeStorageAbCustodyLifecycle({
    readiness,
    getWorkspaceOwners: () => ({ v1: { token: 'owner-v1' }, v2: { token: 'owner-v2' } }),
    writeJson: async () => undefined,
    writeText: async () => undefined,
    runWorkload: async () => ({ functionalStatus: 'PASS', payload: { marker: true } }),
    cleanupLane: async (lane) => { if (lane === 'v1') throw Object.assign(new Error('hidden path'), { code: 'cleanup_refused' }) },
    collectSourcesAfter: async () => structuredClone(readiness),
  })
  assert.equal(result.workloadStatus, 'PASS')
  assert.equal(result.functionalStatus, 'PASS')
  assert.equal(result.sourceAfterStatus, 'PASS')
  assert.deepEqual(result.cleanupStatus, { lanes: { v1: 'FAIL', v2: 'PASS' }, overall: 'FAIL' })
  assert.equal(result.evidenceWriteStatus, 'PASS')
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.secondaryFailures, [{ stage: 'cleanup-v1', name: 'Error', code: 'cleanup_refused' }])
  assert.equal(JSON.stringify(result).includes('hidden path'), false)
})

test('storage ab failure custody keeps successful cleanup as an independent passing gate', async () => {
  const { executeStorageAbCustodyLifecycle } = await subject()
  assert.equal(typeof executeStorageAbCustodyLifecycle, 'function', 'failure custody lifecycle is missing')
  const readiness = custodyReadiness()
  const result = await executeStorageAbCustodyLifecycle({
    readiness,
    getWorkspaceOwners: () => ({ v1: { token: 'owner-v1' }, v2: { token: 'owner-v2' } }),
    writeJson: async () => undefined,
    writeText: async () => undefined,
    runWorkload: async () => ({ functionalStatus: 'PASS', payload: { marker: true } }),
    cleanupLane: async () => undefined,
    collectSourcesAfter: async () => structuredClone(readiness),
  })
  assert.deepEqual(result.cleanupStatus, { lanes: { v1: 'PASS', v2: 'PASS' }, overall: 'PASS' })
  assert.deepEqual({ workloadStatus: result.workloadStatus, functionalStatus: result.functionalStatus,
    sourceAfterStatus: result.sourceAfterStatus, evidenceWriteStatus: result.evidenceWriteStatus, exitCode: result.exitCode },
  { workloadStatus: 'PASS', functionalStatus: 'PASS', sourceAfterStatus: 'PASS', evidenceWriteStatus: 'PASS', exitCode: 0 })
})

test('storage ab failure custody records every auxiliary lane operation without adding measured samples', async () => {
  const { createStorageAbAuxiliaryCustodyRow, validateStorageAbAuxiliaryCustodyRows,
    summarizeStorageAbRows } = await subject()
  assert.equal(typeof createStorageAbAuxiliaryCustodyRow, 'function', 'auxiliary custody row factory is missing')
  assert.equal(typeof validateStorageAbAuxiliaryCustodyRows, 'function', 'auxiliary custody validator is missing')
  const roles = ['retry', 'idempotent-retry', 'changed-reuse', 'undo', 'redo', 'reopen']
  const zeroReasons = {
    retry: 'no-backup-idempotent-read',
    'idempotent-retry': 'no-backup-idempotent-read',
    'changed-reuse': 'no-backup-rejected-transaction-reuse',
    reopen: 'no-backup-read-only-open',
  }
  const rows = []
  for (const lane of ['v1', 'v2']) {
    for (const [index, role] of roles.entries()) {
      const rejected = role === 'changed-reuse'
      const records = role === 'undo' || role === 'redo' ? settledFineRecords(index + 1) : []
      rows.push(createStorageAbAuxiliaryCustodyRow({
        lane, role, outcome: rejected ? 'rejected' : 'fulfilled', records,
        zeroObserverReason: records.length === 0 ? zeroReasons[role] : null,
        storageBefore: storageMetric(52 + index), storageAfter: storageMetric(52 + index + (role === 'undo' || role === 'redo' ? 1 : 0)),
        publicResult: rejected ? { ok: false, error: { code: 'transaction_reuse' } } : { ok: true, value: { revision: 52 + index } },
        diskState: { lane, role, revision: 52 + index },
      }))
    }
  }
  const summary = validateStorageAbAuxiliaryCustodyRows(rows)
  assert.deepEqual(summary, { rows: 12, measuredRows: 0, lanes: { v1: 6, v2: 6 },
    roles: { retry: 2, 'idempotent-retry': 2, 'changed-reuse': 2, undo: 2, redo: 2, reopen: 2 } })
  for (const row of rows) {
    assert.equal(row.phase, 'auxiliary')
    assert.match(row.publicResultSha256, /^[a-f0-9]{64}$/)
    assert.match(row.diskSha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(row.storageBefore, storageMetric(52 + roles.indexOf(row.role)))
    assert.ok(row.storageAfter)
    if (row.observer.records === 0) assert.equal(typeof row.zeroObserverReason, 'string')
    else assert.equal(row.zeroObserverReason, null)
  }
  const measured = [
    { lane: 'v1', ordinal: 1, order: 'v1-v2', baseRevision: 32, inputSha256: 'a'.repeat(64), startedNs: '10', settledNs: '20', durationNs: '10' },
    { lane: 'v2', ordinal: 1, order: 'v1-v2', baseRevision: 32, inputSha256: 'a'.repeat(64), startedNs: '30', settledNs: '40', durationNs: '10' },
  ]
  assert.equal(summarizeStorageAbRows(measured, 1).lanes.v1.count, 1)
  assert.throws(() => validateStorageAbAuxiliaryCustodyRows(rows.map((row) => row.role === 'undo'
    ? { ...row, observer: { records: 0 }, zeroObserverReason: 'no-backup-read-only-open' } : row)), /observer|backup/i)
})

function observerDispatch(phase = 'measure', lane = 'v1', ordinal = 1) {
  return {
    phase, lane, ordinal, order: ordinal % 2 === 1 ? 'v1-v2' : 'v2-v1',
    transactionId: `tx:storage-ab:${phase}:${String(ordinal).padStart(2, '0')}`,
    baseRevision: 31 + ordinal, inputSha256: String(ordinal % 10).repeat(64),
  }
}

test('storage ab observer evidence emits an exact bounded stdout receipt without rows', async () => {
  const { createStorageAbStdoutReceipt } = await subject()
  assert.equal(typeof createStorageAbStdoutReceipt, 'function', 'stdout receipt factory is missing')
  const result = { schema: 'modly.worlds-command-storage-ab.v1', status: 'PASS', exitCode: 0,
    sourceSealSha256: 'a'.repeat(64), rows: Array.from({ length: 1000 }, () => ({ payload: 'x'.repeat(1000) })) }
  const receipt = createStorageAbStdoutReceipt({ result, evidenceRoot: '/tmp/modly-worlds-command-storage-ab-evidence-owned',
    summarySha256: 'b'.repeat(64), sealVerified: true })
  assert.deepEqual(Object.keys(receipt).sort(), ['evidenceRoot', 'exitCode', 'schema', 'sealVerified',
    'sourceSealSha256', 'status', 'summarySha256'])
  assert.deepEqual(receipt, {
    schema: 'modly.worlds-command-storage-ab.v1', status: 'PASS', exitCode: 0,
    evidenceRoot: '/tmp/modly-worlds-command-storage-ab-evidence-owned', sourceSealSha256: 'a'.repeat(64),
    summarySha256: 'b'.repeat(64), sealVerified: true,
  })
  const encoded = `${JSON.stringify(receipt, null, 2)}\n`
  assert.ok(Buffer.byteLength(encoded) < 4096)
  assert.equal(encoded.includes('rows'), false)
  assert.throws(() => createStorageAbStdoutReceipt({ result,
    evidenceRoot: '/tmp/modly-worlds-command-storage-ab-evidence-' + 'x'.repeat(5000),
    summarySha256: 'b'.repeat(64), sealVerified: true }), /4096|receipt/i)
})

test('storage ab observer evidence sanitizes, bounds, associates, and replays raw records', async () => {
  const { createStorageAbObserverBatch, replayStorageAbObserverEvidence,
    assertStorageAbObserverEvidenceBounds } = await subject()
  assert.equal(typeof createStorageAbObserverBatch, 'function', 'observer batch factory is missing')
  assert.equal(typeof replayStorageAbObserverEvidence, 'function', 'observer replay is missing')
  assert.equal(typeof assertStorageAbObserverEvidenceBounds, 'function', 'observer evidence bounds are missing')
  const records = settledFineRecords(7)
  const measuredDispatch = observerDispatch('measure', 'v1', 1)
  const measured = createStorageAbObserverBatch({ dispatch: measuredDispatch, records })
  const setupDispatch = observerDispatch('setup', 'v2', 1)
  const setup = createStorageAbObserverBatch({ dispatch: setupDispatch, records: settledFineRecords(9) })
  assert.deepEqual(Object.keys(measured).sort(), ['dispatch', 'records', 'recordsSha256', 'schema', 'summary'])
  assert.equal(measured.schema, 'modly.worlds-command-storage-ab-observer-batch.v1')
  assert.equal(Object.isFrozen(measured), true)
  assert.equal(Object.isFrozen(measured.records), true)
  assert.equal(measured.records.every(Object.isFrozen), true)
  assert.match(measured.recordsSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(measured.dispatch, measuredDispatch)
  const auxiliaryDispatch = { phase: 'auxiliary', lane: 'v2', role: 'reopen', outcome: 'fulfilled',
    zeroObserverReason: 'no-backup-read-only-open' }
  const auxiliary = createStorageAbObserverBatch({ dispatch: auxiliaryDispatch, records: [] })
  assert.equal(auxiliary.summary.records, 0)
  const measuredRow = { ...measuredDispatch, observerRecordsSha256: measured.recordsSha256,
    observer: measured.summary, io: { 'bounded-read': { calls: 0, requestedBytes: 0, completedBytes: 0, sourceBytes: 0 },
      'read-await': { calls: 0, requestedBytes: 0, completedBytes: 0, sourceBytes: 0 },
      'write-file': { calls: 0, requestedBytes: 0, completedBytes: 0, sourceBytes: 0 },
      'write-positional': { calls: 0, requestedBytes: 0, completedBytes: 0, sourceBytes: 0 },
      'file-sync': { calls: 0, requestedBytes: 0, completedBytes: 0, sourceBytes: 0 },
      'directory-sync': { calls: 0, requestedBytes: 0, completedBytes: 0, sourceBytes: 0 } } }
  const setupRow = { ...setupDispatch, observerRecordsSha256: setup.recordsSha256,
    observer: setup.summary, io: structuredClone(measuredRow.io) }
  const auxiliaryRow = { ...auxiliaryDispatch, observerRecordsSha256: auxiliary.recordsSha256,
    observer: auxiliary.summary, io: structuredClone(measuredRow.io) }
  const observerEvidence = { schema: 'modly.worlds-command-storage-ab-observer-evidence.v1', batches: [setup, measured, auxiliary] }
  const replay = replayStorageAbObserverEvidence({ evidence: observerEvidence,
    setupRows: [setupRow], measuredRows: [measuredRow], auxiliaryRows: [auxiliaryRow] })
  assert.deepEqual(replay, { batches: 3, records: 4, linkedRows: 3, encodedBytes: replay.encodedBytes,
    evidenceSha256: replay.evidenceSha256 })
  assert.match(replay.evidenceSha256, /^[a-f0-9]{64}$/)
  assert.ok(replay.encodedBytes > 0)
  assert.throws(() => createStorageAbObserverBatch({ dispatch: { ...measuredDispatch, path: '/tmp/private' }, records }), /dispatch|key|path/i)
  assert.throws(() => createStorageAbObserverBatch({ dispatch: measuredDispatch,
    records: records.map((record, index) => index === 1 ? fineRecord({ invocation: 8, sequence: 2, edge: 'settled', ns: '20', outcome: 'fulfilled', durable: true }) : record) }), /invocation/i)
  assert.throws(() => createStorageAbObserverBatch({ dispatch: measuredDispatch,
    records: records.map((record, index) => index === 1 ? fineRecord({ invocation: 7, sequence: 3, edge: 'settled', ns: '20', outcome: 'fulfilled', durable: true }) : record) }), /sequence/i)
  assert.throws(() => createStorageAbObserverBatch({ dispatch: measuredDispatch,
    records: [records[0], fineRecord({ invocation: 7, sequence: 2, kind: 'write-file', edge: 'settled', ns: '20',
      outcome: 'fulfilled', durable: true })] }), /kind|pair/i)
  assert.throws(() => createStorageAbObserverBatch({ dispatch: measuredDispatch,
    records: records.map((record, index) => index === 1 ? fineRecord({ invocation: 7, sequence: 2, edge: 'settled', ns: '20',
      target: '/tmp/private', outcome: 'fulfilled', durable: true }) : record) }), /schema|path|target/i)
  assert.throws(() => createStorageAbObserverBatch({ dispatch: measuredDispatch,
    records: [records[0], fineRecord({ invocation: 7, sequence: 2, kind: 'observer-fault', edge: 'settled', ns: '15', outcome: 'rejected', durable: false }), records[1]] }), /fault|terminal/i)
  assert.throws(() => createStorageAbObserverBatch({ dispatch: measuredDispatch,
    records: Array.from({ length: 8193 }, (_, index) => fineRecord({ invocation: 7, sequence: index + 1 })) }), /8192|bound/i)
  assert.throws(() => replayStorageAbObserverEvidence({ evidence: { schema: observerEvidence.schema, batches: [measured] },
    setupRows: [], measuredRows: [{ ...measuredRow,
    observerRecordsSha256: 'f'.repeat(64) }], auxiliaryRows: [] }), /hash|link/i)
  assert.throws(() => replayStorageAbObserverEvidence({ evidence: { ...observerEvidence, extra: true },
    setupRows: [setupRow], measuredRows: [measuredRow], auxiliaryRows: [auxiliaryRow] }), /evidence|key/i)
  assert.throws(() => assertStorageAbObserverEvidenceBounds({ batchCount: 117, encodedBytes: 1 }), /116|batch/i)
  assert.throws(() => assertStorageAbObserverEvidenceBounds({ batchCount: 1, encodedBytes: 128 * 1024 * 1024 + 1 }), /128|byte/i)
})

test('storage ab observer evidence writes only after workload settlement and preserves later custody on failure', async () => {
  const { executeStorageAbCustodyLifecycle } = await subject()
  const readiness = custodyReadiness()
  const events = []
  const result = await executeStorageAbCustodyLifecycle({
    readiness,
    basePayload: { measuredRowsSettled: 40 },
    getWorkspaceOwners: () => ({ v1: { token: 'owner-v1' }, v2: { token: 'owner-v2' } }),
    writeJson: async (name) => {
      events.push(`write:${name}`)
      if (name === 'observer-records.json') throw Object.assign(new Error('/tmp/private'), { code: 'observer_write_failed' })
      return { bytes: 10, sha256: 'a'.repeat(64) }
    },
    writeText: async (name) => { events.push(`write:${name}`); return { bytes: 2, sha256: 'b'.repeat(64) } },
    runWorkload: async () => {
      events.push('measurement-settled')
      return { functionalStatus: 'PASS', payload: { measuredRowsSettled: 40 }, observerEvidence: { batches: [] } }
    },
    cleanupLane: async (lane) => { events.push(`cleanup:${lane}`) },
    collectSourcesAfter: async () => { events.push('sources-after'); return structuredClone(readiness) },
  })
  assert.ok(events.indexOf('write:observer-records.json') > events.indexOf('measurement-settled'))
  assert.ok(events.indexOf('cleanup:v1') > events.indexOf('write:observer-records.json'))
  assert.ok(events.indexOf('sources-after') > events.indexOf('cleanup:v2'))
  assert.equal(result.workloadStatus, 'PASS')
  assert.equal(result.functionalStatus, 'PASS')
  assert.equal(result.sourceAfterStatus, 'PASS')
  assert.deepEqual(result.cleanupStatus, { lanes: { v1: 'PASS', v2: 'PASS' }, overall: 'PASS' })
  assert.equal(result.evidenceWriteStatus, 'FAIL')
  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.exitCode, 1)
  assert.ok(result.secondaryFailures.some((failure) => failure.stage === 'observer-evidence'
    && failure.name === 'Error' && failure.code === 'observer_write_failed'))
  assert.equal(JSON.stringify(result).includes('/tmp/private'), false)
})

test('storage ab observer evidence writes atomically with exact bytes and file custody', async () => {
  const { writeStorageAbAtomicEvidence } = await subject()
  assert.equal(typeof writeStorageAbAtomicEvidence, 'function', 'atomic evidence writer is missing')
  const directory = await mkdtemp('/tmp/modly-worlds-storage-ab-atomic-')
  try {
    const content = '{"proof":true}\n'
    const written = await writeStorageAbAtomicEvidence(directory, 'proof.json', content)
    assert.deepEqual(written, { bytes: Buffer.byteLength(content), sha256: written.sha256 })
    assert.match(written.sha256, /^[a-f0-9]{64}$/)
    assert.equal(await readFile(join(directory, 'proof.json'), 'utf8'), content)
    const info = await lstat(join(directory, 'proof.json'))
    assert.equal(info.isFile(), true)
    assert.equal(info.isSymbolicLink(), false)
    assert.equal(info.mode & 0o777, 0o600)
    await assert.rejects(() => writeStorageAbAtomicEvidence(directory, '../escape.json', content), /name|path|evidence/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
