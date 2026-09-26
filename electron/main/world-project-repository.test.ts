import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Session } from 'node:inspector/promises'
import fsPromises, { chmod, cp, lstat, mkdtemp, mkdir, open as openFile, readFile, readdir, readlink, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { WORLD_COMMAND_BATCH_SCHEMA, type WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { canonicalWorldCommandBatchPayload, type WorldCommandBatchV1 } from '../../src/areas/worlds/core/worldCommands.ts'
import { validateWorldProjectSnapshot } from '../../src/areas/worlds/core/worldDocuments.ts'
import { validateWorldWireValue } from '../../src/areas/worlds/core/worldWireValidation.ts'
import type { WorldProjectCommandSuccess, WorldProjectCreateSuccess, WorldProjectOpenSuccess } from '../../src/shared/types/worldProjects.ts'
import { WorldProjectRepository } from './world-project-repository.ts'

const PROJECT_KEY_A = 'world-0123456789abcdef0123456789abcdef'
const PROJECT_KEY_B = 'world-fedcba9876543210fedcba9876543210'
const SCENE_KEY_A = 'scene-0123456789abcdef0123456789abcdef'

test('AI query reads committed pages without writes and refuses pending recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-ai-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const created = assertCreated(await repository.create({ name: 'AI read', initialSceneName: 'Scene' }))
  const context = { schema: 'modly.world-ai-context.v1' as const, projectKey: PROJECT_KEY_A,
    projectId: created.snapshot.project.projectId, baseRevision: 0, activeSceneId: created.snapshot.project.startSceneId,
    editorEpoch: 1, originSessionId: 'session-a', requestId: 'tx:read-ai' }
  const recoveringOpen = t.mock.method(repository, 'open', async () => { throw new Error('AI query must not open or recover') })
  const before = await fingerprintTree(root)
  const result = await repository.queryAi({ context, query: { kind: 'project', pageSize: 1 } })
  assert.equal(result.ok, true)
  assert.deepEqual(await fingerprintTree(root), before)
  if (result.ok) {
    assert.equal(result.value.total, 1)
    assert.doesNotMatch(JSON.stringify(result.value), /workspacePath|documentPath|\/tmp\//)
  }
  let interrupted = false
  await createRepository(root, { failureCheckpoint(stage) {
    if (!interrupted && stage === 'journal-published') { interrupted = true; throw new Error('pending recovery fixture') }
  } }).applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(created.snapshot, 'tx:ai-query-pending') })
  const pending = await fingerprintTree(root)
  const blocked = await repository.queryAi({ context, query: { kind: 'project' } })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.equal(blocked.error.code, 'project_busy')
  assert.deepEqual(await fingerprintTree(root), pending)
  assert.equal(recoveringOpen.mock.callCount(), 0)
})

test('backup path classifiers handle native and Windows separators', () => {
  const digest = 'a'.repeat(64)
  const sourceOrder = new Map([[digest, 7]])
  const nativeAfter = `/tmp/root/Worlds/${PROJECT_KEY_A}/.modly/backups/6-${'b'.repeat(64)}/transactions/${digest}/after`
  const windowsRoot = `C:\\tmp\\root\\Worlds\\${PROJECT_KEY_A}\\.modly\\backups\\6-${'b'.repeat(64)}\\transactions\\${digest}`
  assert.deepEqual(classifyBackupTransactionSync(nativeAfter, sourceOrder), { kind: 'after', index: 7 })
  assert.deepEqual(classifyBackupTransactionSync(windowsRoot, sourceOrder), { kind: 'root', index: 7 })
  assert.equal(isBackupTransactionsRootSync(`C:\\tmp\\root\\Worlds\\${PROJECT_KEY_A}\\.modly\\backups\\6-${'b'.repeat(64)}\\transactions`), true)
})

function assertCreated(result: Awaited<ReturnType<WorldProjectRepository['create']>>): WorldProjectCreateSuccess {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.code)
  return result.value
}

function assertOpened(result: Awaited<ReturnType<WorldProjectRepository['open']>>): WorldProjectOpenSuccess {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.code)
  assert.equal(result.value.status, 'ready')
  return result.value as WorldProjectOpenSuccess
}

function createRepository(
  workspaceRoot: string,
  options: Partial<ConstructorParameters<typeof WorldProjectRepository>[0]> = {},
): WorldProjectRepository {
  return new WorldProjectRepository({
    getWorkspaceRoot: () => workspaceRoot,
    createProjectKey: () => PROJECT_KEY_A,
    createSceneKey: () => SCENE_KEY_A,
    now: () => new Date('2026-09-02T00:00:00.000Z'),
    ...options,
  })
}

function renameBatch(snapshot: WorldProjectSnapshotV1, transactionId: string, name = 'Renamed world'): WorldCommandBatchV1 {
  return {
    schema: WORLD_COMMAND_BATCH_SCHEMA,
    transactionId,
    projectId: snapshot.project.projectId,
    baseRevision: snapshot.project.revision,
    origin: 'ui',
    commands: [{ type: 'rename-project', name }],
  }
}

type DurableResultMutation = 'missing' | 'truncated' | 'corrupt' | 'wrong-hash' | 'wrong-transaction' | 'wrong-revision'
type TestDurableTransaction = {
  transactionId: string
  transactionDigest: string
  payloadSha256: string
  canonicalPayload: string
  appliedRevision: number
  resultSha256: string
}

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

type OpenFunction = typeof fsPromises.open

function replaceBuiltinOpen(replacement: OpenFunction): () => void {
  const original = fsPromises.open
  let restored = false
  fsPromises.open = replacement
  syncBuiltinESMExports()
  return () => {
    if (restored) return
    restored = true
    fsPromises.open = original
    syncBuiltinESMExports()
  }
}

async function convertPackedBackupToLegacy(backupRoot: string): Promise<void> {
  const backupState = JSON.parse(await readFile(join(backupRoot, 'state.v1.json'), 'utf8'))
  const index = JSON.parse(await readFile(join(backupRoot, 'transactions.index.v1.json'), 'utf8'))
  const pack = await readFile(join(backupRoot, 'transactions.pack.v1'))
  await mkdir(join(backupRoot, 'transactions'))
  for (const [entryIndex, transaction] of backupState.transactions.entries()) {
    const entry = index.entries[entryIndex]
    assert.equal(entry.transactionDigest, transaction.transactionDigest)
    const resultRoot = join(backupRoot, 'transactions', transaction.transactionDigest, 'after')
    await mkdir(resultRoot, { recursive: true })
    await writeFile(join(resultRoot, 'result.v1.json'), pack.subarray(entry.offset, entry.offset + entry.length))
  }
  await rm(join(backupRoot, 'transactions.pack.v1'), { force: true })
  await rm(join(backupRoot, 'transactions.index.v1.json'), { force: true })
}

async function withDurableCoverage<T>(operation: (drain: () => Promise<void>) => Promise<T>, phase: 'ordinary' | 'public-retry' | 'canonical-state') {
  const inspector = new Session()
  // In-process only: no TCP inspector endpoint and no production validation mocks.
  inspector.connect()
  try {
    await inspector.post('Profiler.enable')
    await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    await inspector.post('Profiler.takePreciseCoverage')
    const value = await operation(async () => { await inspector.post('Profiler.takePreciseCoverage') })
    const coverage = await inspector.post('Profiler.takePreciseCoverage')
    const scripts = coverage.result.filter((entry) => entry.url === new URL('./world-project-repository.ts', import.meta.url).href)
    assert.equal(scripts.length, 1, 'Actual repository module must appear unambiguously in coverage')
    const count = (name: string) => {
      const functions = scripts[0].functions.filter((entry) => entry.functionName === name)
      assert.equal(functions.length, 1, `Actual synchronous function ${name} must appear unambiguously in coverage`)
      return functions[0].ranges[0].count
    }
    return { value, counts: {
      semantic: count('verifyDurableResultSemantics'),
      hash: count('assertDurableResultHash'),
      ...(phase === 'public-retry' ? { materialize: count('materializeStoredPublicResult') } : {}),
      ...(phase === 'canonical-state' ? {
        canonicalBatch: count('parseCanonicalDurableBatch'),
        durableTransaction: count('parseDurableTransaction'),
      } : {}),
    } }
  } finally {
    try { await inspector.post('Profiler.stopPreciseCoverage') } finally { inspector.disconnect() }
  }
}

test('canonical state validation decodes each ledger batch once per fresh observation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-canonical-state-count-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.diagnostic(`New unit fixture: ${root}`)
  const repository = createRepository(root)
  let snapshot = assertCreated(await repository.create({ name: 'Canonical state', initialSceneName: 'Scene' })).snapshot
  assert.deepEqual(assertOpened(await repository.open({ projectKey: PROJECT_KEY_A })).snapshot, snapshot)
  const receipts: WorldProjectCommandSuccess['receipt'][] = []
  for (let index = 0; index < 2; index += 1) {
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A,
      batch: renameBatch(snapshot, `tx:canonical-state-${index}`, `Canonical state ${index} é`) })
    assert.equal(applied.ok, true)
    if (!applied.ok) return
    snapshot = applied.value.snapshot
    receipts.push(applied.value.receipt)
  }
  const statePath = join(root, 'Worlds', PROJECT_KEY_A, '.modly/state.v1.json')
  const before = await readFile(statePath)
  const measured = await withDurableCoverage(() => createRepository(root).open({ projectKey: PROJECT_KEY_A }), 'canonical-state')
  assert.deepEqual(assertOpened(measured.value).snapshot, snapshot)
  const after = await readFile(statePath)
  assert.deepEqual(after, before, 'Fresh open must preserve the full committed state and canonical receipt bytes')
  const transactions: TestDurableTransaction[] = JSON.parse(after.toString('utf8')).transactions
  assert.deepEqual(transactions.map(({ transactionId, appliedRevision, payloadSha256, resultSha256 }) => (
    { transactionId, appliedRevision, payloadSha256, resultSha256 }
  )), receipts)
  const { canonicalBatch: C, durableTransaction: D, semantic: S } = measured.counts
  assert.ok(C !== undefined && D !== undefined && D > 0 && S > 0, 'Actual uniquely identified parsers and semantic replay must execute')
  t.diagnostic(`Actual precise-coverage calls (not CPU samples): C=${C}, D=${D}, S=${S}; expected C=D+S=${D + S}`)
  assert.equal(C, D + S, 'Each state entry decodes once; independent durable-result replay keeps its own parse')
})

test('canonical state validation retains project canonical ordering and revision rejection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-canonical-state-reject-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.diagnostic(`New unit fixture: ${root}`)
  const repository = createRepository(root)
  let snapshot = assertCreated(await repository.create({ name: 'Canonical rejection', initialSceneName: 'Scene' })).snapshot
  for (let index = 0; index < 2; index += 1) {
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:canonical-reject-${index}`) })
    assert.equal(applied.ok, true)
    if (!applied.ok) return
    snapshot = applied.value.snapshot
  }
  const statePath = join(root, 'Worlds', PROJECT_KEY_A, '.modly/state.v1.json')
  const committed = await readFile(statePath), original = JSON.parse(committed.toString('utf8'))
  for (const mutation of ['foreign-project', 'transaction-id', 'base-revision', 'noncanonical', 'duplicate', 'reversed', 'zero-with-ledger', 'empty-with-revision', 'missing-latest'] as const) {
    await t.test(mutation, async () => {
      const state = structuredClone(original)
      if (['foreign-project', 'transaction-id', 'base-revision', 'noncanonical'].includes(mutation)) {
        const entry: TestDurableTransaction = state.transactions[1]
        const batch: WorldCommandBatchV1 = JSON.parse(entry.canonicalPayload)
        if (mutation === 'foreign-project') batch.projectId = 'project:foreign'
        if (mutation === 'transaction-id') batch.transactionId = 'tx:foreign'
        if (mutation === 'base-revision') batch.baseRevision = 0
        entry.canonicalPayload = mutation === 'noncanonical' ? JSON.stringify(batch, null, 2) : canonicalWorldCommandBatchPayload(batch)
        entry.payloadSha256 = sha256Bytes(entry.canonicalPayload)
        entry.transactionDigest = sha256Bytes(`${entry.transactionId}\n${entry.canonicalPayload}`)
      }
      if (mutation === 'duplicate') state.transactions[1] = structuredClone(state.transactions[0])
      if (mutation === 'reversed') state.transactions.reverse()
      if (mutation === 'zero-with-ledger') state.committedRevision = 0
      if (mutation === 'empty-with-revision') state.transactions = []
      if (mutation === 'missing-latest') state.committedRevision += 1
      const bytes = Buffer.from(`${JSON.stringify(state)}\n`)
      await writeFile(statePath, bytes)
      const rejected = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
      assert.equal(rejected.ok, false)
      if (!rejected.ok) assert.deepEqual({ code: rejected.error.code, retryable: rejected.error.retryable }, { code: 'invalid_document', retryable: false })
      assert.deepEqual(await readFile(statePath), bytes, 'Invalid state must not trigger publication or recovery writes')
    })
  }
  await writeFile(statePath, committed)
  assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, snapshot)
})

async function seedHousekeeping(repository: WorldProjectRepository) {
  let snapshot = assertCreated(await repository.create({ name: 'Housekeeping', initialSceneName: 'Scene' })).snapshot
  let batch = renameBatch(snapshot, 'tx:housekeeping-seed-0')
  for (let index = 0; index < 2; index += 1) {
    batch = renameBatch(snapshot, `tx:housekeeping-seed-${index}`)
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(applied.ok, true)
    snapshot = applied.value.snapshot
  }
  return { snapshot, batch }
}

test('clean apply skips empty eager housekeeping but keeps terminal validation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-clean-housekeeping-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let stage = ''
  const repository = createRepository(root, { failureCheckpoint: (next) => { stage = next } })
  const { snapshot } = await seedHousekeeping(repository)
  const observable = repository as unknown as { pruneCommittedData: (...args: unknown[]) => Promise<void> }
  const prune = observable.pruneCommittedData.bind(repository)
  const phases: string[] = []
  t.mock.method(observable, 'pruneCommittedData', async (...args: unknown[]) => {
    phases.push(stage === 'journal-cleaned' ? 'terminal' : 'eager')
    await prune(...args)
  })
  const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:clean-housekeeping') })
  assert.equal(applied.ok, true)
  t.diagnostic(`Real prune visits on a clean mutation: ${JSON.stringify(phases)}`)
  assert.deepEqual(phases, ['terminal'], 'No deletion needs the eager survivor recheck; terminal validation is unconditional')
  assert.equal(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot.project.revision, 3)
})

test('eager housekeeping namespace rejects malicious entries before publication', async (t) => {
  for (const mutation of ['transaction-symlink', 'backup-symlink', 'backup-file', 'malformed-backup'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-housekeeping-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const stages: string[] = []
    const repository = createRepository(root, { failureCheckpoint: (stage) => { stages.push(stage) } })
    const { snapshot } = await seedHousekeeping(repository)
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const outside = join(root, 'untouched')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'untouched')
    if (mutation === 'transaction-symlink') await symlink(outside, join(projectRoot, '.modly/transactions', 'f'.repeat(64)), 'dir')
    else if (mutation === 'backup-symlink') await symlink(outside, join(projectRoot, '.modly/backups', `0-${'f'.repeat(64)}`), 'dir')
    else if (mutation === 'backup-file') await writeFile(join(projectRoot, '.modly/backups', `0-${'f'.repeat(64)}`), 'not a directory')
    else await mkdir(join(projectRoot, '.modly/backups', 'not-a-canonical-backup'))
    const before = await fingerprintTree(projectRoot)
    stages.length = 0
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:namespace-${mutation}`) })
    assert.equal(applied.ok, false, mutation)
    if (!applied.ok) assert.equal(applied.error.code, mutation.endsWith('symlink') ? 'unsafe_workspace' : 'recovery_failed')
    assert.deepEqual(stages, ['root-lock-directory-created'], 'Unsafe namespace is rejected before staging or publication')
    assert.deepEqual(await fingerprintTree(projectRoot), before, mutation)
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched')
  }
})

test('eager housekeeping with leftovers retains verified cleanup and bounds repeated failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-housekeeping-leftovers-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let failAfterPackage = false
  let stage = ''
  const repository = createRepository(root, { failureCheckpoint: (next) => {
    stage = next
    if (failAfterPackage && next === 'after-package') throw new Error('Retained pre-journal interruption')
  } })
  const { snapshot } = await seedHousekeeping(repository)
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const transactionsRoot = join(projectRoot, '.modly/transactions')
  const backupsRoot = join(projectRoot, '.modly/backups')
  const orphan = join(transactionsRoot, 'f'.repeat(64))
  await mkdir(join(orphan, 'after'), { recursive: true })
  const sourceBackup = (await readdir(backupsRoot)).find((entry) => entry.startsWith('0-'))!
  assert.ok(sourceBackup)
  for (let index = 0; index < 9; index += 1) {
    await cp(join(backupsRoot, sourceBackup), join(backupsRoot, `0-${index.toString(16).padStart(64, '0')}`), { recursive: true })
  }
  const observable = repository as unknown as { pruneCommittedData: (...args: unknown[]) => Promise<void> }
  const prune = observable.pruneCommittedData.bind(repository)
  const phases: string[] = []
  let corruptSurvivor = true
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  const resultPath = join(transactionsRoot, state.transactions[0].transactionDigest, 'after/result.v1.json')
  const resultBytes = await readFile(resultPath)
  t.mock.method(observable, 'pruneCommittedData', async (...args: unknown[]) => {
    phases.push(stage === 'journal-cleaned' ? 'terminal' : 'eager')
    if (corruptSurvivor) { corruptSurvivor = false; await writeFile(resultPath, '{}\n') }
    await prune(...args)
  })
  const rejected = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:corrupt-before-prune') })
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.equal(rejected.error.code, 'recovery_failed')
  assert.equal(await pathExists(orphan), true, 'A read-only plan never authorizes deletion without fresh survivor verification')
  assert.equal((await readdir(backupsRoot)).length, 11, 'No obsolete backup is removed after survivor validation fails')
  await writeFile(resultPath, resultBytes)
  failAfterPackage = true
  for (let index = 0; index < 3; index += 1) {
    phases.length = 0
    const interrupted = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:housekeeping-interrupted-${index}`) })
    assert.equal(interrupted.ok, false)
    if (!interrupted.ok) assert.equal(interrupted.error.code, 'write_failed')
    assert.deepEqual(phases, ['eager'])
    assert.equal(await pathExists(orphan), false)
    assert.equal((await readdir(transactionsRoot)).length, 3, 'Only two committed results plus this failed attempt remain')
    assert.equal((await readdir(backupsRoot)).length, 8)
    assert.equal(await pathExists(join(projectRoot, '.modly/journal.v1.json')), false)
  }
  failAfterPackage = false
  phases.length = 0
  const retryBatch = renameBatch(snapshot, 'tx:housekeeping-interrupted-2')
  const retried = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: retryBatch })
  assert.equal(retried.ok, true)
  assert.deepEqual(phases, ['eager', 'terminal'])
  assert.equal((await readdir(transactionsRoot)).length, 3)
  assert.equal((await readdir(backupsRoot)).length, 8)
  const exactRetry = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch: retryBatch })
  assert.equal(exactRetry.ok && exactRetry.value.idempotent, true)
})

test('housekeeping preserves orphan cleanup for rejected idempotent and open requests', async (t) => {
  for (const kind of ['invalid', 'stale', 'idempotent', 'open'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-housekeeping-${kind}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    const { snapshot, batch } = await seedHousekeeping(repository)
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const beforeState = await readFile(join(projectRoot, '.modly/state.v1.json'))
    const orphan = join(projectRoot, '.modly/transactions', 'f'.repeat(64))
    await mkdir(join(orphan, 'after'), { recursive: true })
    if (kind === 'open') assert.equal(assertOpened(await repository.open({ projectKey: PROJECT_KEY_A })).snapshot.project.revision, 2)
    else {
      const request = kind === 'idempotent' ? batch : renameBatch(snapshot, `tx:housekeeping-${kind}`)
      if (kind === 'stale') request.baseRevision = 0
      if (kind === 'invalid') request.commands = [{ type: 'set-start-scene', sceneId: 'scene:absent' }]
      const result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: request })
      assert.equal(result.ok, kind === 'idempotent', kind)
      if (result.ok) { assert.equal(result.value.idempotent, true); assert.deepEqual(result.value.snapshot, snapshot) }
      else assert.equal(result.error.code, kind === 'stale' ? 'revision_conflict' : 'invalid_request')
    }
    assert.equal(await pathExists(orphan), false, kind)
    assert.deepEqual(await readFile(join(projectRoot, '.modly/state.v1.json')), beforeState)
  }
})

test('recovering apply and clean open never skip survivor housekeeping', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-housekeeping-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { snapshot } = await seedHousekeeping(createRepository(root))
  const batch = renameBatch(snapshot, 'tx:housekeeping-recovery')
  const interrupted = await createRepository(root, { failureCheckpoint: (stage) => {
    if (stage === 'journal-published') throw new Error('Pending journal fixture')
  } }).applyCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(interrupted.ok, false)
  const repository = createRepository(root)
  const observable = repository as unknown as { pruneCommittedData: (...args: unknown[]) => Promise<void> }
  const prune = observable.pruneCommittedData.bind(repository)
  const probe = t.mock.method(observable, 'pruneCommittedData', (...args: unknown[]) => prune(...args))
  const recovered = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(recovered.ok && recovered.value.idempotent, true)
  assert.equal(probe.mock.callCount(), 2, 'Recovered-commit prune and subsequent load housekeeping both retain fresh verification')
  const opened = assertOpened(await repository.open({ projectKey: PROJECT_KEY_A }))
  assert.equal(opened.snapshot.project.revision, 3)
  assert.equal(probe.mock.callCount(), 3, 'Even an empty clean open keeps its original housekeeping path')
})


async function withNewBackupCoverage<T>(repository: WorldProjectRepository, revision: number, operation: () => Promise<T>, establishEntries?: () => Promise<void>) {
  const inspector = new Session()
  const target = repository as unknown as { verifyBackupPackage: (...args: unknown[]) => Promise<unknown> }
  const original = target.verifyBackupPackage
  let firstBackup: { semantic: number; hash: number } | undefined
  let observed = false
  const observedFunctions = new Map<string, string>()
  const counts = { semantic: 0, hash: 0 }
  inspector.connect()
  const take = async () => {
    const coverage = await inspector.post('Profiler.takePreciseCoverage')
    const scripts = coverage.result.filter((entry) => entry.url === new URL('./world-project-repository.ts', import.meta.url).href)
    assert.equal(scripts.length, 1, 'The actual source module is loaded once')
    const count = (name: string) => {
      const matches = scripts[0].functions.filter((entry) => entry.functionName === name)
      if (matches.length === 0) {
        assert.ok(observedFunctions.has(name), `An omitted zero delta requires prior real coverage for ${name}`)
        return 0
      }
      assert.equal(matches.length, 1, `Actual function coverage: ${name}`)
      assert.equal(matches[0].ranges.length, 1, `${name} requires its complete function entry range`)
      assert.ok(matches[0].ranges[0].endOffset > matches[0].ranges[0].startOffset, `${name} has a real entry range`)
      const identity = `${scripts[0].scriptId}:${matches[0].ranges[0].startOffset}:${matches[0].ranges[0].endOffset}`
      const previousIdentity = observedFunctions.get(name)
      if (previousIdentity !== undefined) assert.equal(identity, previousIdentity, `${name} retains its exact actual module/entry identity`)
      observedFunctions.set(name, identity)
      return matches[0].ranges[0].count
    }
    const row = { semantic: count('verifyDurableResultSemantics'), hash: count('assertDurableResultHash') }
    counts.semantic += row.semantic
    counts.hash += row.hash
    return row
  }
  try {
    await inspector.post('Profiler.enable')
    await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    await inspector.post('Profiler.takePreciseCoverage')
    if (establishEntries) {
      await establishEntries()
      await take() // Real observed entries survive; all pre-measurement invocation counts are discarded.
      counts.semantic = counts.hash = 0
    }
    // Observe the first exact new target, not old/reference verifications. The original still runs.
    target.verifyBackupPackage = async function (...args) {
      if (observed || typeof args[2] !== 'string' || !args[2].startsWith(`.modly/backups/${revision}-`)) {
        return original.apply(this, args)
      }
      observed = true
      await take()
      try { return await original.apply(this, args) } finally { firstBackup = await take() }
    }
    const value = await operation()
    await take()
    assert.equal(observed, true, 'The exact first-new-backup verification was executed')
    assert.ok(firstBackup)
    return { value, counts, firstBackup }
  } finally {
    target.verifyBackupPackage = original
    try { await inspector.post('Profiler.stopPreciseCoverage') } finally { inspector.disconnect() }
  }
}

async function retainedProofIdentities(root: string): Promise<Set<string>> {
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  const identities = new Set<string>()
  for (const tx of state.transactions) {
    const bytes = await readFile(join(projectRoot, '.modly/transactions', tx.transactionDigest, 'after/result.v1.json'))
    identities.add(JSON.stringify([state.projectId, tx, bytes.toString('base64')]))
  }
  if (state.lastValidBackup) {
    const backupRoot = join(projectRoot, state.lastValidBackup)
    await addBackupTransactionIdentities(projectRoot, backupRoot, JSON.parse(await readFile(join(backupRoot, 'state.v1.json'), 'utf8')), state.projectId, identities)
  }
  return identities
}

async function addBackupTransactionIdentities(
  projectRoot: string,
  backupRoot: string,
  backupState: { transactions: TestDurableTransaction[] },
  projectId: string,
  identities: Set<string>,
): Promise<void> {
  const packPath = join(backupRoot, 'transactions.pack.v1')
  if (await pathExists(packPath)) {
    const index = JSON.parse(await readFile(join(backupRoot, 'transactions.index.v1.json'), 'utf8'))
    const pack = await readFile(packPath)
    for (const [entryIndex, tx] of backupState.transactions.entries()) {
      const entry = index.entries[entryIndex]
      const bytes = pack.subarray(entry.offset, entry.offset + entry.length)
      identities.add(JSON.stringify([projectId, tx, bytes.toString('base64')]))
    }
    return
  }
  for (const tx of backupState.transactions) {
    const bytes = await readFile(join(backupRoot, 'transactions', tx.transactionDigest, 'after/result.v1.json'))
    identities.add(JSON.stringify([projectId, tx, bytes.toString('base64')]))
  }
}

async function retainOnlyTransactions(root: string, transactions: TestDurableTransaction[]): Promise<void> {
  const statePath = join(root, 'Worlds', PROJECT_KEY_A, '.modly/state.v1.json')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { transactions: TestDurableTransaction[]; lastValidBackup: string | null }
  state.transactions = transactions.map((transaction) => ({ ...transaction }))
  state.lastValidBackup = null
  await writeFile(statePath, `${JSON.stringify(state)}\n`)
}

async function seedMatureBackupSource(root: string, label: string): Promise<WorldProjectCommandSuccess> {
  const repository = createRepository(root)
  let snapshot = assertCreated(await repository.create({ name: `${label} 0`, initialSceneName: 'Scene' })).snapshot
  let applied: WorldProjectCommandSuccess | undefined
  for (let index = 0; index < 33; index += 1) {
    const result = await repository.applyCommands({
      projectKey: PROJECT_KEY_A,
      batch: renameBatch(snapshot, `tx:${label.toLowerCase()}-${String(index).padStart(2, '0')}`, `${label} ${index + 1}`),
    })
    assert.equal(result.ok, true, `revision ${index + 1}`)
    if (!result.ok) throw new Error(`failed to seed revision ${index + 1}`)
    applied = result.value
    snapshot = result.value.snapshot
  }
  assert.ok(applied)
  return applied
}

async function latestBackupPack(root: string): Promise<{
  projectRoot: string
  backupRoot: string
  state: { transactions: TestDurableTransaction[]; lastValidBackup: string | null }
  index: { entries: Array<{ transactionDigest: string; offset: number; length: number }>; pack: { sha256: string } }
  pack: Buffer
}> {
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly', 'state.v1.json'), 'utf8'))
  assert.equal(typeof state.lastValidBackup, 'string')
  const backupRoot = join(projectRoot, state.lastValidBackup)
  const backupState = JSON.parse(await readFile(join(backupRoot, 'state.v1.json'), 'utf8'))
  const index = JSON.parse(await readFile(join(backupRoot, 'transactions.index.v1.json'), 'utf8'))
  const pack = await readFile(join(backupRoot, 'transactions.pack.v1'))
  assert.equal(sha256Bytes(pack), index.pack.sha256)
  return { projectRoot, backupRoot, state: backupState, index, pack }
}

function packedEntryBytes(
  source: { index: { entries: Array<{ offset: number; length: number }> }; pack: Buffer },
  index: number,
): Buffer {
  const entry = source.index.entries[index]
  assert.ok(entry)
  return Buffer.from(source.pack.subarray(entry.offset, entry.offset + entry.length))
}

function countFine(records: readonly FineBackupRecord[], kind: string): number {
  return records.filter((record) => record.edge === 'settled' && record.kind === kind).length
}

type SourceProofArguments = [Buffer, string, string, TestDurableTransaction,
  { layout: string; backupRelativePath: string; indexSha256: string; packSha256: string; packByteLength: number; offset: number; length: number }, unknown]

// Intercept the real operation-created capability, not a synthetic exported cache or verifier.
function interceptPackedSource(repository: WorldProjectRepository, before: (args: SourceProofArguments) => void) {
  const observable = repository as unknown as { createBackup: (...args: unknown[]) => Promise<unknown> }
  const original = observable.createBackup
  observable.createBackup = async function (...args) {
    const scope = args[3] as { createBackupBridge: (...args: unknown[]) => { sourceScope: (...args: SourceProofArguments) => unknown } }
    const create = scope.createBackupBridge
    scope.createBackupBridge = function (...bridgeArgs) {
      const bridge = create.apply(this, bridgeArgs)
      if (bridge) bridge.sourceScope = new Proxy(bridge.sourceScope, { apply(target, receiver, sourceArgs: SourceProofArguments) {
        before(sourceArgs)
        return Reflect.apply(target, receiver, sourceArgs)
      } })
      return bridge
    }
    try { return await original.apply(this, args) } finally { scope.createBackupBridge = create }
  }
  return () => { observable.createBackup = original }
}

test('sealed packed source requires its exact authority and bytes after warm prior-proof hits', async (t) => {
  for (const mutation of ['none', 'primary-backing-store', 'index', 'foreign-path', 'pack-hash', 'pack-length', 'offset', 'length', 'canonical', 'bytes'] as const) await t.test(mutation, async () => {
    const root = await mkdtemp(join(tmpdir(), `modly-world-source-seal-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const records: FineBackupRecord[] = []
    const primaryTransports: Buffer[] = []
    const originalOpen = fsPromises.open
    const restoreOpen = mutation === 'primary-backing-store' ? replaceBuiltinOpen((async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      if (!String(path).includes('/.modly/transactions/') || !String(path).endsWith('/result.v1.json') || flags === 'wx') return handle
      return new Proxy(handle, { get(target, property) {
        if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await target.read(buffer, offset, length, position)
          primaryTransports.push(buffer)
          return result
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }) as OpenFunction) : () => {}
    t.after(restoreOpen)
    const repository = createRepository(root, fineObserverOptions((record) => { records.push(record) }))
    let snapshot = await seedFineBackup(repository)
    for (let index = 1; index < 3; index += 1) {
      const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:source-seed-${index}`) })
      assert.equal(applied.ok, true)
      if (!applied.ok) return
      snapshot = applied.value.snapshot
    }
    records.length = 0
    let intercepted = 0
    const restore = interceptPackedSource(repository, (args) => {
      if (args[4].layout !== 'backup-pack' || intercepted++) return
      assert.equal(countFine(records.filter((record) => record.phase === 'prior-proof'), 'cache-hit'), 3,
        'The actual preceding stable verification hit all warm primary proofs before the sealed source call')
      if (mutation === 'primary-backing-store') {
        assert.ok(primaryTransports.length > 0, 'Retain actual read transports including original proof admissions')
        for (const bytes of primaryTransports) new Uint8Array(bytes.buffer).fill(0x20)
      }
      args[4] = { ...args[4] }
      if (mutation === 'index') args[4].indexSha256 = '0'.repeat(64)
      if (mutation === 'foreign-path') args[4].backupRelativePath = `.modly/backups/2-${'a'.repeat(64)}`
      if (mutation === 'pack-hash') args[4].packSha256 = '0'.repeat(64)
      if (mutation === 'pack-length') args[4].packByteLength += 1
      if (mutation === 'offset') args[4].offset += 1
      if (mutation === 'length') args[4].length += 1
      if (mutation === 'canonical') {
        const batch: WorldCommandBatchV1 = JSON.parse(args[3].canonicalPayload)
        batch.origin = 'workflow'
        const payload = canonicalWorldCommandBatchPayload(batch)
        args[3] = { ...args[3], canonicalPayload: payload, payloadSha256: sha256Bytes(payload),
          transactionDigest: sha256Bytes(`${batch.transactionId}\n${payload}`) }
      }
      if (mutation === 'bytes') {
        const changed = Buffer.from(args[0])
        const offset = changed.indexOf('"newRevision":1')
        assert.ok(offset >= 0)
        changed[offset + '"newRevision":'.length] = '0'.charCodeAt(0)
        assert.equal(changed.byteLength, args[0].byteLength)
        assert.equal(changed.equals(args[0]), false)
        args[0] = changed
      }
    })
    let applied: Awaited<ReturnType<WorldProjectRepository['applyCommands']>>
    try { applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:source-${mutation}`) }) }
    finally { restore(); restoreOpen() }
    assert.equal(applied.ok, true, 'Valid authority mismatches replay; corrupted source proof takes the unchanged full-primary fallback')
    assert.equal(intercepted, mutation === 'bytes' ? 1 : 2, 'The real two-receipt packed overlap reached the source bridge')
    const pack = records.filter((record) => record.phase === 'pack-ledger')
    const exact = mutation === 'none' || mutation === 'primary-backing-store'
    assert.equal(countFine(pack, 'cache-miss'), exact ? 0 : 1)
    assert.equal(countFine(pack, 'cache-hit'), mutation === 'bytes' || exact ? 3 : 2)
    assert.equal(countFine(pack, 'replay'), exact || mutation === 'bytes' ? 0 : 1)
    if (applied.ok) {
      assert.deepEqual(applied.value.inverse.snapshot, snapshot)
      assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, applied.value.snapshot)
    }
  })
})

test('backup pack source reuses prior suffix for warm capped ledger and keeps self-contained hashes', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-backup-source-incremental-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const records: FineBackupRecord[] = []
  const repository = createRepository(root, fineObserverOptions((record) => { records.push(record) }))
  const snapshot = (await seedMatureBackupSource(root, 'Incremental')).snapshot
  const source = await latestBackupPack(root)
  assert.equal(source.state.transactions.length, 32)
  records.length = 0
  const applied = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(snapshot, 'tx:incremental-next', 'Incremental next'),
  })
  assert.equal(applied.ok, true)
  if (!applied.ok) return
  assertFineGrammar(records)
  assert.equal(countFine(records, 'bounded-read'), 39, 'prior stable proof + package copies + only one primary tail receipt')
  assert.equal(countFine(records, 'write-positional'), 32)
  const next = await latestBackupPack(root)
  assert.equal(next.state.transactions.length, 32)
  assert.equal(next.index.entries.length, 32)
  assert.equal(sha256Bytes(next.pack), next.index.pack.sha256)
  for (let index = 0; index < 31; index += 1) {
    assert.equal(next.index.entries[index].transactionDigest, source.index.entries[index + 1].transactionDigest)
    assert.deepEqual(packedEntryBytes(next, index), packedEntryBytes(source, index + 1), `prior suffix entry ${index + 1} becomes new prefix ${index}`)
  }
  const tail = next.state.transactions.at(-1)!
  assert.equal(next.index.entries.at(-1)!.transactionDigest, tail.transactionDigest)
  assert.deepEqual(
    packedEntryBytes(next, 31),
    await readFile(join(next.projectRoot, '.modly', 'transactions', tail.transactionDigest, 'after', 'result.v1.json')),
  )
  await rm(source.backupRoot, { recursive: true, force: true })
  assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, applied.value.snapshot)
})

test('backup pack source diagnostic full-primary control keeps old read shape', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-backup-source-full-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const records: FineBackupRecord[] = []
  const snapshot = (await seedMatureBackupSource(root, 'FullControl')).snapshot
  const repository = createRepository(root, {
    ...fineObserverOptions((record) => { records.push(record) }),
    diagnosticBackupPackSource: 'force-full-primary',
  })
  const applied = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(snapshot, 'tx:full-control', 'Full control'),
  })
  assert.equal(applied.ok, true)
  assertFineGrammar(records)
  assert.equal(countFine(records, 'bounded-read'), 70)
  assert.equal(countFine(records, 'write-positional'), 32)
})

test('backup pack source falls back after post-load source corruption and forced incremental fails closed', { timeout: 180_000 }, async (t) => {
  for (const forced of [false, true]) await t.test(forced ? 'forced' : 'auto', async () => {
    const root = await mkdtemp(join(tmpdir(), `modly-world-backup-source-corrupt-${forced}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const snapshot = (await seedMatureBackupSource(root, forced ? 'ForcedCorrupt' : 'AutoCorrupt')).snapshot
    const before = await latestBackupPack(root)
    let armed = true
    const repository = createRepository(root, {
      diagnosticBackupPackSource: forced ? 'force-previous-packed-overlap' : 'auto',
      async failureCheckpoint(stage) {
        if (!armed || stage !== 'after-package') return
        armed = false
        await chmod(join(before.backupRoot, 'transactions.pack.v1'), 0o600)
        await writeFile(join(before.backupRoot, 'transactions.pack.v1'), Buffer.from('corrupt\n'))
      },
    })
    const result = await repository.applyCommands({
      projectKey: PROJECT_KEY_A,
      batch: renameBatch(snapshot, `tx:backup-source-corrupt-${forced}`, `Corrupt ${forced}`),
    })
    assert.equal(result.ok, !forced)
    if (forced) {
      if (!result.ok) assert.deepEqual({ code: result.error.code, retryable: result.error.retryable }, { code: 'recovery_failed', retryable: true })
      await chmod(join(before.backupRoot, 'transactions.pack.v1'), 0o600)
      await writeFile(join(before.backupRoot, 'transactions.pack.v1'), before.pack)
      assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, snapshot)
    } else if (result.ok) {
      const current = await latestBackupPack(root)
      assert.equal(current.index.entries.length, current.state.transactions.length)
      assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, result.value.snapshot)
    }
  })
})

test('backup pack source falls back after planned source-copy settlement failure only in auto mode', { timeout: 180_000 }, async (t) => {
  for (const mutation of ['read', 'close'] as const) for (const forced of [false, true]) await t.test(`${mutation}-${forced ? 'forced' : 'auto'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `modly-world-backup-source-settle-${mutation}-${forced}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const snapshot = (await seedMatureBackupSource(root, `${mutation}${forced ? 'Forced' : 'Auto'}Settle`)).snapshot
    const before = await latestBackupPack(root)
    const sourcePackPath = join(before.backupRoot, 'transactions.pack.v1')
    const originalOpen = fsPromises.open
    let sourcePackOpens = 0
    let reads = 0
    let injected = false
    const restoreOpen = replaceBuiltinOpen((async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      if (String(path) !== sourcePackPath || flags === 'wx') return handle
      sourcePackOpens += 1
      if (sourcePackOpens !== 3) return handle
      return new Proxy(handle, { get(target, property) {
        if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
          reads += 1
          if (mutation === 'read' && reads > 1) {
            injected = true
            return { bytesRead: 0, buffer }
          }
          const result = await target.read(buffer, offset, length, position)
          return result
        }
        if (property === 'close') return async () => {
          await target.close()
          if (mutation === 'close') {
            injected = true
            throw new Error('Injected source-copy close failure')
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } }) as typeof handle
    }) as OpenFunction)
    let result: Awaited<ReturnType<WorldProjectRepository['applyCommands']>>
    try {
      result = await createRepository(root, {
        diagnosticBackupPackSource: forced ? 'force-previous-packed-overlap' : 'auto',
      }).applyCommands({
        projectKey: PROJECT_KEY_A,
        batch: renameBatch(snapshot, `tx:backup-source-settle-${forced}`, `Settle ${forced}`),
      })
    } finally {
      restoreOpen()
    }
    assert.equal(sourcePackOpens, 3, 'The test must corrupt the already-opened source pack after planning succeeded')
    assert.equal(injected, true)
    assert.equal(result.ok, !forced)
    if (forced) {
      if (!result.ok) assert.equal(result.error.retryable, true)
      assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, snapshot)
    } else if (result.ok) {
      const current = await latestBackupPack(root)
      assert.equal(current.index.entries.length, 32)
      assert.equal(sha256Bytes(current.pack), current.index.pack.sha256)
      assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, result.value.snapshot)
    }
  })
})

async function retainedTransactionOrder(root: string): Promise<Map<string, number>> {
  const state = JSON.parse(await readFile(join(root, 'Worlds', PROJECT_KEY_A, '.modly', 'state.v1.json'), 'utf8'))
  return new Map(state.transactions.map((transaction: { transactionDigest: string }, index: number) => [transaction.transactionDigest, index]))
}

async function retainedTransactionBytes(root: string): Promise<Map<string, Buffer>> {
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  const entries = await Promise.all(state.transactions.map(async (transaction: { transactionDigest: string }) => [
    transaction.transactionDigest,
    await readFile(join(projectRoot, '.modly', 'transactions', transaction.transactionDigest, 'after', 'result.v1.json')),
  ] as const))
  return new Map(entries)
}

function classifyBackupTransactionSync(
  directory: string,
  sourceOrder: Map<string, number>,
): { kind: 'after' | 'root'; index: number } | null {
  const normalized = directory.replaceAll('\\', '/')
  const marker = `${PROJECT_KEY_A}/.modly/backups/`
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex === -1) return null
  const parts = normalized.slice(markerIndex + marker.length).split('/')
  if (parts.length === 4 && parts[1] === 'transactions' && parts[3] === 'after') {
    const index = sourceOrder.get(parts[2])
    return index === undefined ? null : { kind: 'after', index }
  }
  if (parts.length === 3 && parts[1] === 'transactions') {
    const index = sourceOrder.get(parts[2])
    return index === undefined ? null : { kind: 'root', index }
  }
  return null
}

function isBackupTransactionsRootSync(directory: string): boolean {
  const normalized = directory.replaceAll('\\', '/')
  const marker = `${PROJECT_KEY_A}/.modly/backups/`
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex === -1) return false
  const parts = normalized.slice(markerIndex + marker.length).split('/')
  return parts.length === 2 && parts[1] === 'transactions'
}

async function syncDirectoryForTest(directory: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof openFile>> | null = null
  try {
    handle = await openFile(directory, 'r')
    await handle.sync()
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function releasePendingCohort(pendingByCohort: Map<number, Array<() => void>>, cohort: number): void {
  const pending = pendingByCohort.get(cohort)
  if (!pending?.length) return
  pendingByCohort.delete(cohort)
  for (const release of pending) release()
}

async function waitForBoundedSignal(signal: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      signal,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), 5_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function assertExactBackupSyncIndexes(events: number[], expected: number, label: string): void {
  assert.equal(events.length, expected, `${label} sync total count`)
  const counts = new Map<number, number>()
  for (const index of events) counts.set(index, (counts.get(index) ?? 0) + 1)
  for (let index = 0; index < expected; index += 1) {
    assert.equal(counts.get(index), 1, `${label} sync count for index ${index}`)
  }
  assert.deepEqual([...counts.keys()].sort((left, right) => left - right), Array.from({ length: expected }, (_, index) => index))
}

async function seedWarmPublication(repository: WorldProjectRepository): Promise<WorldProjectSnapshotV1> {
  let snapshot = assertCreated(await repository.create({ name: 'Publication retirement', initialSceneName: 'Scene' })).snapshot
  for (let index = 0; index < 33; index += 1) {
    const batch = index === 0 ? componentBatch(snapshot, 'tx:retirement-seed-0')
      : renameBatch(snapshot, `tx:retirement-seed-${index}`, `Publication ${index}`)
    assert.ok(Buffer.byteLength(canonicalWorldCommandBatchPayload(batch)) < 1024, 'Small canonical authority fixture')
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(applied.ok, true)
    if (!applied.ok) throw new Error('Warm publication fixture failed')
    snapshot = applied.value.snapshot
  }
  return snapshot
}

test('publication retirement retains next-ledger primaries and independently captured dropped receipts', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-publication-retirement-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root) // Genuine public transactions and default directory sync.
  const snapshot = await seedWarmPublication(repository)
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const statePath = join(projectRoot, '.modly/state.v1.json')
  const prior = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(prior.transactions.length, 32)
  let rawProofBytes = 0
  for (const transaction of prior.transactions) {
    rawProofBytes += (await readFile(join(projectRoot, '.modly/transactions', transaction.transactionDigest, 'after/result.v1.json'))).byteLength
  }
  assert.ok(rawProofBytes * 2 < 1024 * 1024, 'Warm primary/backup receipts leave ample byte/metadata headroom')
  const batch = transformBatch(snapshot, 'tx:retirement-transform')
  const exactBatch = structuredClone(batch)
  const preview = await repository.previewCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(preview.ok, true)
  if (!preview.ok) return
  const expected = structuredClone(preview.value)
  mutatePublicResult(preview.value)
  const measured = await withNewBackupCoverage(repository, snapshot.project.revision, () => repository.applyCommands({ projectKey: PROJECT_KEY_A, batch }))
  assert.equal(measured.value.ok, true)
  if (!measured.value.ok) return
  t.diagnostic(`Publication structural counts, not timing: ${JSON.stringify({ counts: measured.counts, first: measured.firstBackup })}`)
  assert.deepEqual(measured.counts, { semantic: 1, hash: 448 })
  assert.deepEqual(measured.firstBackup, { semantic: 0, hash: 64 })
  assert.deepEqual(measured.value.value, expected)
  assert.equal(expected.newRevision, snapshot.project.revision + 1)
  assert.deepEqual(expected.inverse.snapshot, snapshot)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.transactions.length, 32)
  assert.equal(state.transactions.some((entry: TestDurableTransaction) => entry.transactionDigest === prior.transactions[0].transactionDigest), false)
  const transaction = state.transactions.at(-1)
  const resultPath = join(projectRoot, '.modly/transactions', transaction.transactionDigest, 'after/result.v1.json')
  const durableBytes = await readFile(resultPath)
  assert.equal(sha256Bytes(durableBytes), expected.receipt.resultSha256)
  assert.deepEqual(JSON.parse(durableBytes.toString('utf8')), { schema: 'modly.world-command-result.v2', transactionId: batch.transactionId,
    newRevision: expected.newRevision, changes: expected.changes, warnings: expected.warnings, inverse: expected.inverse })
  const backupRoot = join(projectRoot, state.lastValidBackup)
  const index = JSON.parse(await readFile(join(backupRoot, 'transactions.index.v1.json'), 'utf8'))
  const dropped = index.entries.find((entry: { transactionDigest: string }) => entry.transactionDigest === prior.transactions[0].transactionDigest)
  assert.ok(dropped, 'Dropped primary is independently retained in the newly proved complete backup')
  const pack = await readFile(join(backupRoot, 'transactions.pack.v1'))
  assert.equal(sha256Bytes(pack.subarray(dropped.offset, dropped.offset + dropped.length)), prior.transactions[0].resultSha256)
  const stable = await fingerprintTree(projectRoot)
  mutatePublicResult(measured.value.value)
  measured.value.value.inverse.snapshot.scenes[0].entities[0].transform.position.fill(999)
  const command = batch.commands[0]
  if (command.type === 'patch-entity') command.patch.transform!.scale.fill(999)
  const expectedRetry = { ...expected, idempotent: true, warnings: [...expected.warnings, 'transaction-idempotent'].sort() }
  for (const reader of [repository, createRepository(root)]) {
    const retry = await reader.applyCommands({ projectKey: PROJECT_KEY_A, batch: exactBatch })
    assert.equal(retry.ok, true)
    if (retry.ok) { assert.deepEqual(retry.value, expectedRetry); mutatePublicResult(retry.value) }
    assert.deepEqual(assertOpened(await reader.open({ projectKey: PROJECT_KEY_A })).snapshot, expected.snapshot)
  }
  assert.deepEqual(await readFile(resultPath), durableBytes)
  assert.deepEqual(await fingerprintTree(projectRoot), stable)
})

test('publication retirement discards staged and settled bridge authority changes on failure', { timeout: 170_000 }, async (t) => {
  for (const failStage of ['after-package', 'backup-created'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-retirement-failure-${failStage}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    let armed = false
    let failedStage: string | undefined
    const repository = createRepository(root, { failureCheckpoint(stage) {
      if (armed && stage === failStage) {
        armed = false
        failedStage = stage
        throw new Error(`Publication retirement rollback at ${stage}`)
      }
    } })
    const snapshot = await seedWarmPublication(repository)
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const statePath = join(projectRoot, '.modly/state.v1.json')
    const stateBytes = await readFile(statePath)
    const state = JSON.parse(stateBytes.toString('utf8'))
    const priorBackupRevision = Number(basename(state.lastValidBackup).split('-')[0])
    assert.equal(priorBackupRevision, 32)
    const batch = transformBatch(snapshot, `tx:retirement-failure-${failStage}`)
    const preview = await repository.previewCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(preview.ok, true)
    if (!preview.ok) return
    const expected = structuredClone(preview.value)
    const retried = await withNewBackupCoverage(repository, priorBackupRevision, () => repository.applyCommands({ projectKey: PROJECT_KEY_A, batch }), async () => {
      armed = true
      const failed = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
      assert.equal(failedStage, failStage, 'The exact post-retirement stage really failed')
      assert.equal(failed.ok, false)
      if (!failed.ok) assert.deepEqual({ code: failed.error.code, retryable: failed.error.retryable }, { code: 'write_failed', retryable: true })
      assert.deepEqual(await readFile(statePath), stateBytes, 'No prior durable ledger was replaced')
    })
    assert.equal(retried.value.ok, true)
    assert.deepEqual(retried.counts, { semantic: 1, hash: 544 }, 'Dirty survivor housekeeping retains its additional 96 fresh hashes')
    // The old namespace remains warm despite local removal; every restored pack range is freshly hashed twice.
    assert.deepEqual(retried.firstBackup, { semantic: 0, hash: 64 }, 'Failed retirement never mutates the persistent old-backup authority')
    t.diagnostic(`${failStage} rollback structural counts, not timing: ${JSON.stringify({ total: retried.counts, oldBackup: retried.firstBackup })}`)
    if (retried.value.ok) {
      assert.deepEqual(retried.value.value, expected)
      assert.deepEqual(retried.value.value.inverse.snapshot, snapshot)
      assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, expected.snapshot)
    }
  }
})

test('publication retirement cannot revive after intrinsic drift is restored at a later checkpoint', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-retirement-drift-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone')!
  const clone = globalThis.structuredClone
  let armed = false
  let drifted = false
  let restored = false
  const repository = createRepository(root, { failureCheckpoint(stage) {
    if (!armed) return
    if (stage === 'after-package' && !drifted) {
      drifted = true
      Object.defineProperty(globalThis, 'structuredClone', { ...descriptor, value: <T>(value: T, options?: StructuredSerializeOptions): T => clone(value, options) })
    } else if (stage === 'backup-created' && drifted && !restored) {
      restored = true
      armed = false
      Object.defineProperty(globalThis, 'structuredClone', descriptor)
    }
  } })
  let snapshot = await seedWarmPublication(repository)
  const batch = transformBatch(snapshot, 'tx:retirement-drift')
  const preview = await repository.previewCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(preview.ok, true)
  if (!preview.ok) return
  let drift: Awaited<ReturnType<typeof withNewBackupCoverage<Awaited<ReturnType<WorldProjectRepository['applyCommands']>>>>>
  try {
    armed = true
    drift = await withNewBackupCoverage(repository, snapshot.project.revision, () => repository.applyCommands({ projectKey: PROJECT_KEY_A, batch }))
  } finally {
    Object.defineProperty(globalThis, 'structuredClone', descriptor)
  }
  assert.equal(drifted && restored, true, 'Real source verification observes drift before later restoration')
  assert.equal(drift.value.ok, true)
  if (!drift.value.ok) return
  assert.deepEqual(drift.value.value, preview.value)
  assert.deepEqual(drift.counts, { semantic: 225, hash: 448 }, 'Every post-invalidation result authority performs full replay, with all physical hashes intact')
  assert.deepEqual(drift.firstBackup, { semantic: 32, hash: 64 }, 'No captured authority survives the invalidated retirement lease')
  snapshot = drift.value.value.snapshot
  const rows = []
  for (const phase of ['cold', 'warm'] as const) {
    const next = await withNewBackupCoverage(repository, snapshot.project.revision, () => repository.applyCommands({
      projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:retirement-after-drift-${phase}`),
    }))
    assert.equal(next.value.ok, true)
    if (!next.value.ok) return
    assert.deepEqual(next.counts, { semantic: phase === 'cold' ? 65 : 1, hash: 448 }, 'Restoration starts a new cold lease, not old candidates')
    assert.deepEqual(next.firstBackup, { semantic: 0, hash: 64 })
    snapshot = next.value.value.snapshot
    rows.push({ phase, total: next.counts, first: next.firstBackup })
  }
  assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, snapshot)
  t.diagnostic(`Intrinsic drift structural counts, not timing: ${JSON.stringify({ drift: drift.counts, first: drift.firstBackup, rows })}`)
})

test('apply-local durable proofs retain fresh reads and bound actual semantic verification', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-proof-count-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  let snapshot = assertCreated(await repository.create({ name: 'Proof counts', initialSceneName: 'Scene' })).snapshot
  let lastSetupBatch: WorldCommandBatchV1 | undefined
  for (let index = 0; index < 33; index += 1) {
    const batch = renameBatch(snapshot, `tx:proof-${index}`, `Revision ${index + 1}`)
    if (index === 0) batch.commands = [{ type: 'add-entity', sceneId: snapshot.project.startSceneId, entity: {
      id: 'entity:light', name: 'Light', parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ id: 'component:light', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 2, range: 15, castShadow: false }],
    } }]
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(applied.ok, true)
    if (!applied.ok) return
    snapshot = applied.value.snapshot
    lastSetupBatch = batch
  }
  assert.ok(lastSetupBatch)
  // Exercise the genuine public retry before V8 coverage; retain its original request.
  const warmedRetry = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: lastSetupBatch })
  assert.equal(warmedRetry.ok && warmedRetry.value.idempotent, true)
  assert.equal(warmedRetry.ok && warmedRetry.value.newRevision, snapshot.project.revision)
  if (warmedRetry.ok) assert.deepEqual(warmedRetry.value.snapshot, snapshot)
  const measuredRepository = createRepository(root)
  const rows = []
  let lastBatch = renameBatch(snapshot, 'tx:unused')
  for (let index = 0; index < 2; index += 1) {
    const identities = await retainedProofIdentities(root)
    lastBatch = renameBatch(snapshot, `tx:covered-${index}`, `Covered ${index}`)
    const measured = await withNewBackupCoverage(measuredRepository, snapshot.project.revision, () => measuredRepository.applyCommands({ projectKey: PROJECT_KEY_A, batch: lastBatch }))
    assert.equal(measured.value.ok, true)
    if (!measured.value.ok) return
    snapshot = measured.value.value.snapshot
    for (const identity of await retainedProofIdentities(root)) identities.add(identity)
    rows.push({ counts: measured.counts, firstBackup: measured.firstBackup, distinct: identities.size })
  }
  const retried = await withDurableCoverage(() => measuredRepository.applyCommands({ projectKey: PROJECT_KEY_A, batch: lastBatch }), 'public-retry')
  assert.equal(retried.value.ok && retried.value.value.idempotent, true)
  t.diagnostic(`Actual function calls, not latency: ${JSON.stringify({ rows, retry: retried.counts })}`)
  for (const [index, row] of rows.entries()) {
    assert.equal(row.distinct, 34)
    assert.equal(row.counts.hash, 448, 'Only the clean eager housekeeping pass is omitted; every remaining physical verification stays fresh')
    assert.deepEqual(row.firstBackup, { semantic: 0, hash: 64 }, 'The first new backup reuses only primary semantic proof; both range hashes remain')
    assert.ok(row.counts.semantic > 0, 'Remaining authority still performs real semantic verification')
  }
  assert.deepEqual(retried.counts, { semantic: 1, hash: 97, materialize: 1 })
})

async function mutateDurableResult(
  resultPath: string,
  statePath: string,
  mutation: DurableResultMutation,
  journalPath?: string,
): Promise<void> {
  if (mutation === 'missing') {
    await rm(resultPath, { force: true })
    return
  }
  const original = await readFile(resultPath)
  await chmod(resultPath, 0o600)
  let bytes: Buffer
  if (mutation === 'truncated') bytes = Buffer.from('{', 'utf8')
  else if (mutation === 'corrupt') bytes = Buffer.from('{}\n', 'utf8')
  else if (mutation === 'wrong-hash') bytes = Buffer.concat([original, Buffer.from(' ', 'utf8')])
  else {
    const result = JSON.parse(original.toString('utf8'))
    if (mutation === 'wrong-transaction') result.transactionId = 'tx:wrong-result'
    else result.newRevision += 1
    bytes = Buffer.from(`${JSON.stringify(result)}\n`, 'utf8')
  }
  await writeFile(resultPath, bytes)
  if (mutation === 'wrong-hash') return

  const state = JSON.parse(await readFile(statePath, 'utf8'))
  await chmod(statePath, 0o600)
  state.transactions.at(-1).resultSha256 = sha256Bytes(bytes)
  const stateBytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8')
  await writeFile(statePath, stateBytes)
  if (journalPath) {
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.afterStateSha256 = sha256Bytes(stateBytes)
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, 'utf8')
  }
}

async function mutatePackedBackupResult(
  backupRoot: string,
  statePath: string,
  mutation: DurableResultMutation,
): Promise<void> {
  const backupState = JSON.parse(await readFile(statePath, 'utf8'))
  const packPath = join(backupRoot, 'transactions.pack.v1')
  const indexPath = join(backupRoot, 'transactions.index.v1.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const entry = index.entries.at(-1)
  assert.ok(entry)
  const pack = await readFile(packPath)
  const original = pack.subarray(entry.offset, entry.offset + entry.length)
  await chmod(packPath, 0o600)
  if (mutation === 'missing') {
    await rm(packPath, { force: true })
    return
  }
  let bytes: Buffer
  if (mutation === 'truncated') bytes = Buffer.from('{', 'utf8')
  else if (mutation === 'corrupt') bytes = Buffer.from('{}\n', 'utf8')
  else if (mutation === 'wrong-hash') bytes = Buffer.concat([original, Buffer.from(' ', 'utf8')])
  else {
    const result = JSON.parse(original.toString('utf8'))
    if (mutation === 'wrong-transaction') result.transactionId = 'tx:wrong-result'
    else result.newRevision += 1
    bytes = Buffer.from(`${JSON.stringify(result)}\n`, 'utf8')
  }
  const nextPack = Buffer.concat([
    pack.subarray(0, entry.offset),
    bytes,
    pack.subarray(entry.offset + entry.length),
  ])
  await writeFile(packPath, nextPack)
  index.entries[index.entries.length - 1] = { ...entry, length: bytes.byteLength }
  let offset = 0
  for (const indexedEntry of index.entries) {
    indexedEntry.offset = offset
    offset += indexedEntry.length
  }
  index.pack.byteLength = nextPack.byteLength
  index.pack.sha256 = sha256Bytes(nextPack)
  if (mutation !== 'wrong-hash') {
    const transaction = backupState.transactions.at(-1)
    transaction.resultSha256 = sha256Bytes(bytes)
    index.entries[index.entries.length - 1].resultSha256 = transaction.resultSha256
    await chmod(statePath, 0o600)
    await writeFile(statePath, `${JSON.stringify(backupState)}\n`)
    index.stateSha256 = sha256Bytes(await readFile(statePath))
  }
  await chmod(indexPath, 0o600)
  await writeFile(indexPath, `${JSON.stringify(index)}\n`)
}

async function fingerprintTree(path: string): Promise<unknown> {
  const info = await lstat(path)
  const metadata = { mode: info.mode, size: info.size, mtimeMs: info.mtimeMs }
  if (info.isSymbolicLink()) return { kind: 'link', metadata, target: await readlink(path) }
  if (info.isFile()) return { kind: 'file', metadata, sha256: sha256Bytes(await readFile(path)) }
  if (!info.isDirectory()) return { kind: 'other', metadata }
  const entries: Record<string, unknown> = {}
  for (const name of (await readdir(path)).sort()) entries[name] = await fingerprintTree(join(path, name))
  return { kind: 'directory', metadata, entries }
}

function componentBatch(snapshot: WorldProjectSnapshotV1, transactionId: string): WorldCommandBatchV1 {
  return { ...renameBatch(snapshot, transactionId), commands: [{
    type: 'add-entity', sceneId: snapshot.project.startSceneId, entity: {
      id: 'entity:parity-light', name: 'Parity light', parentId: null, enabled: true, locked: false, tags: ['original'],
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [{ id: 'component:parity-light', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 2, range: 15, castShadow: false }],
    },
  }] }
}

function mutatePublicResult(value: WorldProjectCommandSuccess): void {
  value.snapshot.project.name = 'Caller mutation'
  value.snapshot.scenes[0].entities[0].tags.push('caller')
  value.snapshot.scenes[0].entities[0].components[0].enabled = false
  value.inverse.snapshot.project.name = 'Caller inverse'
  value.changes.push('caller-change')
  value.warnings.push('caller-warning')
  value.receipt.resultSha256 = '0'.repeat(64)
}

async function withStoredEnvelopeCoverage<T>(operation: () => Promise<T>) {
  const inspector = new Session()
  inspector.connect()
  try {
    await inspector.post('Profiler.enable')
    await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    await inspector.post('Profiler.takePreciseCoverage')
    const value = await operation()
    const coverage = await inspector.post('Profiler.takePreciseCoverage')
    const modules = coverage.result.filter((entry) => entry.url === new URL('./world-project-repository.ts', import.meta.url).href)
    assert.equal(modules.length, 1, 'Structural counts require the unique actual repository module')
    const count = (name: string): number => {
      const entries = modules[0].functions.filter((entry) => entry.functionName === name)
      assert.equal(entries.length, 1, `Structural counts require the unique actual ${name} function`)
      assert.equal(entries[0].ranges.length, 1, `${name} requires its complete function entry range`)
      const range = entries[0].ranges[0]
      assert.ok(range.endOffset > range.startOffset, `${name} has a nonempty real entry range`)
      assert.ok(Number.isSafeInteger(range.count) && range.count >= 0, `${name} has an exact entry count`)
      return range.count
    }
    return { value, counts: { inverseCopies: count('cloneWorldInverse'), jsonEncodings: count('encodeJson') } }
  } finally {
    try { await inspector.post('Profiler.stopPreciseCoverage') } finally { inspector.disconnect() }
  }
}

function transformBatch(snapshot: WorldProjectSnapshotV1, transactionId: string): WorldCommandBatchV1 {
  return { ...renameBatch(snapshot, transactionId), commands: [{ type: 'patch-entity',
    sceneId: snapshot.project.startSceneId, entityId: 'entity:parity-light',
    patch: { transform: { position: [4, 5, 6], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2] } },
  }] }
}

test('ordinary transform reuses only the detached evaluated stored envelope', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-stored-envelope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root) // Real default directory sync, without method/global mocks.
  const initial = assertCreated(await repository.create({ name: 'Stored envelope', initialSceneName: 'Scene' })).snapshot
  const seeded = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: componentBatch(initial, 'tx:envelope-seed') })
  assert.equal(seeded.ok, true)
  if (!seeded.ok) return
  const batch = transformBatch(seeded.value.snapshot, 'tx:envelope-transform')
  const exactBatch = structuredClone(batch)
  const beforePreview = await fingerprintTree(root)
  const preview = await repository.previewCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(preview.ok, true)
  if (!preview.ok) return
  const expected = structuredClone(preview.value)
  assert.deepEqual(await fingerprintTree(root), beforePreview, 'Preview does not write even its prepared envelope')
  mutatePublicResult(preview.value)
  preview.value.snapshot.scenes[0].entities[0].transform.position.fill(99)
  preview.value.inverse.snapshot.scenes[0].entities[0].transform.scale.fill(99)
  const measured = await withStoredEnvelopeCoverage(() => repository.applyCommands({ projectKey: PROJECT_KEY_A, batch }))
  assert.equal(measured.value.ok, true)
  if (!measured.value.ok) return
  t.diagnostic(`Actual structural counts (not latency): ${JSON.stringify(measured.counts)}`)
  assert.deepEqual(measured.counts, { inverseCopies: 2, jsonEncodings: expected.snapshot.scenes.length + 7 })
  assert.deepEqual(measured.value.value, expected, 'Preview and apply expose exactly the same detached public result')
  assert.deepEqual(Object.keys(expected).sort(), ['changes', 'idempotent', 'inverse', 'newRevision', 'projectKey', 'receipt', 'snapshot', 'warnings'])
  assert.equal(expected.newRevision, seeded.value.newRevision + 1)
  assert.deepEqual(expected.inverse.snapshot, seeded.value.snapshot)
  const canonicalPayload = canonicalWorldCommandBatchPayload(exactBatch)
  const digest = sha256Bytes(`${exactBatch.transactionId}\n${canonicalPayload}`)
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const statePath = join(projectRoot, '.modly/state.v1.json')
  const resultPath = join(projectRoot, '.modly/transactions', digest, 'after/result.v1.json')
  const durableBytes = await readFile(resultPath)
  const durable = JSON.parse(durableBytes.toString('utf8'))
  assert.equal(sha256Bytes(durableBytes), expected.receipt.resultSha256)
  assert.deepEqual(durable, { schema: 'modly.world-command-result.v2', transactionId: exactBatch.transactionId,
    newRevision: expected.newRevision, changes: expected.changes,
    warnings: expected.warnings, inverse: expected.inverse })
  const transaction = JSON.parse(await readFile(statePath, 'utf8')).transactions.at(-1)
  assert.equal(transaction.canonicalPayload, canonicalPayload)
  assert.equal(transaction.transactionDigest, digest)
  assert.deepEqual(expected.receipt, { transactionId: exactBatch.transactionId, appliedRevision: expected.newRevision,
    payloadSha256: sha256Bytes(canonicalPayload), resultSha256: sha256Bytes(durableBytes) })
  const stableTree = await fingerprintTree(projectRoot)
  mutatePublicResult(measured.value.value)
  measured.value.value.snapshot.scenes[0].entities[0].transform.rotation.fill(88)
  measured.value.value.inverse.snapshot.scenes[0].entities[0].transform.position.fill(88)
  const command = batch.commands[0]
  assert.equal(command.type, 'patch-entity')
  if (command.type === 'patch-entity') command.patch.transform!.position.fill(77)
  batch.commands.length = 0
  const expectedRetry = { ...expected, idempotent: true, warnings: [...expected.warnings, 'transaction-idempotent'].sort() }
  for (const reader of [repository, createRepository(root)]) {
    const retryPreview = await reader.previewCommands({ projectKey: PROJECT_KEY_A, batch: exactBatch })
    assert.equal(retryPreview.ok, true)
    if (retryPreview.ok) { assert.deepEqual(retryPreview.value, expectedRetry); mutatePublicResult(retryPreview.value) }
    const retry = await reader.applyCommands({ projectKey: PROJECT_KEY_A, batch: exactBatch })
    assert.equal(retry.ok, true)
    if (retry.ok) { assert.deepEqual(retry.value, expectedRetry); mutatePublicResult(retry.value) }
    assert.deepEqual(assertOpened(await reader.open({ projectKey: PROJECT_KEY_A })).snapshot, expected.snapshot)
  }
  assert.deepEqual(await readFile(resultPath), durableBytes, 'Caller mutations never become stored bytes')
  assert.deepEqual(await fingerprintTree(projectRoot), stableTree)
})

test('stored envelope preview retains asynchronous evaluation rejections', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-envelope-preview-errors-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const initial = assertCreated(await repository.create({ name: 'Preview errors', initialSceneName: 'Scene' })).snapshot
  const batch = renameBatch(initial, 'tx:preview-errors')
  assert.equal((await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })).ok, true)
  for (const [code, candidate] of [
    ['revision_conflict', { ...batch, transactionId: 'tx:preview-stale' }],
    ['transaction_reuse', { ...batch, commands: [{ type: 'rename-project' as const, name: 'Changed reuse' }] }],
  ] satisfies Array<[string, WorldCommandBatchV1]>) {
    await assert.rejects(repository.previewCommands({ projectKey: PROJECT_KEY_A, batch: candidate }), (error: unknown) => (
      error instanceof Error && 'code' in error && error.code === code
    ), 'Unwrap must not convert incumbent evaluation promise rejection into a public failure result')
  }
})

test('stored envelope request parsing rejects hostile batch and transform records without getter reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-envelope-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const initial = assertCreated(await repository.create({ name: 'Envelope boundary', initialSceneName: 'Scene' })).snapshot
  const seeded = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: componentBatch(initial, 'tx:boundary-seed') })
  assert.equal(seeded.ok, true)
  if (!seeded.ok) return
  const valid = transformBatch(seeded.value.snapshot, 'tx:boundary-transform')
  let getterCalls = 0
  const transparent = (value: object) => new Proxy(value, { get(target, property, receiver) {
    getterCalls += 1
    return Reflect.get(target, property, receiver)
  } })
  const throwing = (value: object) => new Proxy(value, { getPrototypeOf() { throw new Error('hostile prototype trap') } })
  const accessor = (value: object, key: string) => {
    const copy = { ...value }
    Object.defineProperty(copy, key, { enumerable: true, get() { getterCalls += 1; throw new Error('hostile getter') } })
    return copy
  }
  class ClassRecord { constructor(value: object) { Object.assign(this, value) } }
  const inherited = (value: object) => Object.assign(Object.create({ inherited: true }), value)
  const nested = (replace: (value: object) => object) => {
    const batch = structuredClone(valid)
    const command = batch.commands[0]
    assert.equal(command.type, 'patch-entity')
    if (command.type === 'patch-entity') command.patch.transform = replace(command.patch.transform!) as typeof command.patch.transform
    return batch
  }
  const rejected = [
    transparent(valid), throwing(valid), accessor(valid, 'commands'), new ClassRecord(valid), inherited(valid),
    nested(transparent), nested(throwing), nested((value) => accessor(value, 'position')),
    nested((value) => new ClassRecord(value)), nested(inherited),
  ]
  const stableTree = await fingerprintTree(join(root, 'Worlds', PROJECT_KEY_A))
  for (const candidate of rejected) {
    const request = { projectKey: PROJECT_KEY_A, batch: candidate as WorldCommandBatchV1 }
    for (const operation of ['previewCommands', 'applyCommands'] as const) {
      const result = await repository[operation](request)
      assert.equal(result.ok, false)
      if (!result.ok) assert.deepEqual({ code: result.error.code, retryable: result.error.retryable }, { code: 'invalid_request', retryable: false })
      assert.deepEqual(await fingerprintTree(join(root, 'Worlds', PROJECT_KEY_A)), stableTree)
    }
  }
  assert.equal(getterCalls, 0, 'Descriptor authorities reject wrappers/accessors before property acquisition')
  const accepted = structuredClone(valid)
  const command = accepted.commands[0]
  assert.equal(command.type, 'patch-entity')
  if (command.type === 'patch-entity') command.patch.transform = Object.assign(Object.create(null), command.patch.transform)
  Object.setPrototypeOf(accepted, null)
  const preview = await repository.previewCommands({ projectKey: PROJECT_KEY_A, batch: accepted })
  const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: accepted })
  assert.equal(preview.ok, true)
  assert.equal(applied.ok, true)
  if (preview.ok && applied.ok) assert.deepEqual(applied.value, preview.value)
  assert.equal(getterCalls, 0)
})

test('durable synchronous extraction preserves component values and detached public results', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-sync-values-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const initial = assertCreated(await repository.create({ name: 'Parity', initialSceneName: 'Scene' })).snapshot
  const batch = componentBatch(initial, 'tx:sync-values')
  const exactRequest = structuredClone(batch)
  const beforePreview = await fingerprintTree(root)
  const preview = await repository.previewCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(preview.ok, true)
  if (!preview.ok) return
  const expected = structuredClone(preview.value)
  assert.deepEqual(await fingerprintTree(root), beforePreview)
  mutatePublicResult(preview.value)
  const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(applied.ok, true)
  if (!applied.ok) return
  assert.deepEqual(applied.value, expected)
  assert.equal(applied.value.newRevision, 1)
  assert.deepEqual(applied.value.inverse.snapshot, initial)
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const durableBeforeMutations = await fingerprintTree(projectRoot)
  mutatePublicResult(applied.value)
  batch.commands.length = 0
  initial.project.name = 'Mutated create result'
  const expectedRetry = { ...expected, idempotent: true, warnings: [...expected.warnings, 'transaction-idempotent'].sort() }
  for (const reader of [repository, createRepository(root)]) {
    const retry = await reader.applyCommands({ projectKey: PROJECT_KEY_A, batch: exactRequest })
    assert.equal(retry.ok, true)
    if (!retry.ok) return
    assert.deepEqual(retry.value, expectedRetry)
    mutatePublicResult(retry.value)
    const opened = assertOpened(await reader.open({ projectKey: PROJECT_KEY_A }))
    assert.deepEqual(opened.snapshot, expected.snapshot)
    opened.snapshot.scenes[0].entities[0].transform.position[0] = 999
  }
  const reused = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(reused.ok, false)
  // Empty commands are rejected at the request boundary; a valid changed payload must reach reuse detection.
  const changed = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: { ...exactRequest, commands: [{ type: 'rename-project', name: 'Changed' }] } })
  assert.equal(changed.ok, false)
  if (!changed.ok) assert.deepEqual({ code: changed.error.code, retryable: changed.error.retryable }, { code: 'transaction_reuse', retryable: false })
  const stale = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: { ...exactRequest, transactionId: 'tx:sync-stale' } })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.deepEqual({ code: stale.error.code, retryable: stale.error.retryable }, { code: 'revision_conflict', retryable: true })
  assert.deepEqual(await fingerprintTree(projectRoot), durableBeforeMutations)
  assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, expected.snapshot)
})

test('durable synchronous extraction rejects authoritative valid-hash semantic corruption', { timeout: 170_000 }, async (t) => {
  const cases = ['json', 'schema', 'transaction', 'revision', 'chain', 'changes', 'warnings', 'inverse-kind', 'inverse-revision', 'inverse-confinement', 'replay'] as const
  for (const mutation of cases) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-sync-semantic-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    const initial = assertCreated(await repository.create({ name: 'Semantic parity', initialSceneName: 'Scene' })).snapshot
    const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: componentBatch(initial, `tx:semantic-${mutation}`) })
    assert.equal(first.ok, true)
    if (!first.ok) return
    const nextBatch = renameBatch(first.value.snapshot, `tx:semantic-next-${mutation}`)
    assert.equal((await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: nextBatch })).ok, true)
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
    const backupRoot = join(projectRoot, state.lastValidBackup)
    const backupStatePath = join(backupRoot, 'state.v1.json')
    const backupState = JSON.parse(await readFile(backupStatePath, 'utf8'))
    const tx = backupState.transactions[0]
    const packPath = join(backupRoot, 'transactions.pack.v1')
    const indexPath = join(backupRoot, 'transactions.index.v1.json')
    const index = JSON.parse(await readFile(indexPath, 'utf8'))
    const entry = index.entries[0]
    assert.equal(entry.transactionDigest, tx.transactionDigest)
    const originalPack = await readFile(packPath)
    const result = JSON.parse(originalPack.subarray(entry.offset, entry.offset + entry.length).toString('utf8'))
    if (mutation === 'schema') result.schema = 'modly.invalid.v1'
    if (mutation === 'transaction') result.transactionId = 'tx:other'
    if (mutation === 'revision') result.newRevision += 1
    if (mutation === 'chain') result.inverse.snapshot.project.name = 'Not the verified backup package snapshot'
    if (mutation === 'changes') result.changes.push(result.changes[0])
    if (mutation === 'warnings') result.warnings = ['z', 'a']
    if (mutation === 'inverse-kind') result.inverse.kind = 'invalid'
    if (mutation === 'inverse-revision') result.inverse.snapshot.project.revision += 1
    if (mutation === 'inverse-confinement') result.inverse.snapshot.project.scenes[0].documentPath = 'Worlds/other/scenes/scene.world-scene.json'
    if (mutation === 'replay') result.inverse.snapshot.scenes[0].entities.push(
      structuredClone(first.value.snapshot.scenes[0].entities[0]),
    )
    const bytes = Buffer.from(mutation === 'json' ? '{' : `${JSON.stringify(result)}\n`)
    const nextPack = Buffer.concat([bytes, originalPack.subarray(entry.offset + entry.length)])
    await chmod(packPath, 0o600)
    await writeFile(packPath, nextPack)
    tx.resultSha256 = sha256Bytes(bytes)
    await chmod(backupStatePath, 0o600)
    await writeFile(backupStatePath, `${JSON.stringify(backupState)}\n`)
    index.stateSha256 = sha256Bytes(await readFile(backupStatePath))
    index.pack.byteLength = nextPack.byteLength
    index.pack.sha256 = sha256Bytes(nextPack)
    index.entries[0] = { ...entry, length: bytes.byteLength, resultSha256: tx.resultSha256 }
    for (let entryIndex = 1; entryIndex < index.entries.length; entryIndex += 1) {
      index.entries[entryIndex].offset = index.entries[entryIndex - 1].offset + index.entries[entryIndex - 1].length
    }
    await chmod(indexPath, 0o600)
    await writeFile(indexPath, `${JSON.stringify(index)}\n`)
    assert.equal(sha256Bytes((await readFile(packPath)).subarray(0, bytes.byteLength)), JSON.parse(await readFile(backupStatePath, 'utf8')).transactions[0].resultSha256)
    const before = await fingerprintTree(projectRoot)
    for (const reader of [repository, createRepository(root)]) {
      const result = await reader.open({ projectKey: PROJECT_KEY_A })
      assert.equal(result.ok, false, mutation)
      if (!result.ok) assert.deepEqual({ code: result.error.code, retryable: result.error.retryable }, { code: 'recovery_failed', retryable: true }, mutation)
      assert.deepEqual(await fingerprintTree(projectRoot), before, mutation)
    }
  }
})

test('durable synchronous extraction rechecks warmed physical results and backup copies', { timeout: 170_000 }, async (t) => {
  const cases = ['missing', 'truncated', 'same-size', 'result-symlink', 'after-symlink', 'identical-replacement', 'backup-corrupt'] as const
  for (const mutation of cases) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-sync-physical-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    let armed = false
    let hit = false
    const repository = createRepository(root, { failureCheckpoint: async (stage) => {
      if (!armed || hit || stage !== (mutation === 'backup-corrupt' ? 'backup-created' : 'journal-cleaned')) return
      hit = true
      const current = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
      let resultPath = join(projectRoot, '.modly/transactions', current.transactions[0].transactionDigest, 'after/result.v1.json')
      if (mutation === 'backup-corrupt') {
        const directories = (await readdir(join(projectRoot, '.modly/backups'))).filter((name) => name.startsWith('1-'))
        assert.equal(directories.length, 1)
        resultPath = join(projectRoot, '.modly/backups', directories[0], 'transactions.pack.v1')
      }
      const bytes = await readFile(resultPath)
      const metadata = await lstat(resultPath)
      if (mutation === 'missing') await rm(resultPath)
      else if (mutation === 'result-symlink') {
        const outside = join(root, 'external-result.json')
        await rename(resultPath, outside)
        await symlink(outside, resultPath)
      } else if (mutation === 'after-symlink') {
        const after = join(resultPath, '..')
        const outside = join(root, 'external-after')
        await rename(after, outside)
        await symlink(outside, after, 'dir')
      } else if (mutation === 'identical-replacement') {
        const replacement = `${resultPath}.replacement`
        await writeFile(replacement, bytes)
        await rename(replacement, resultPath)
        assert.notEqual((await lstat(resultPath)).ino, metadata.ino)
      } else {
        await chmod(resultPath, 0o600)
        if (mutation === 'same-size') { bytes[0] = 0x20; await writeFile(resultPath, bytes); await utimes(resultPath, metadata.atime, metadata.mtime) }
        else await writeFile(resultPath, '{')
      }
    } })
    const initial = assertCreated(await repository.create({ name: 'Physical parity', initialSceneName: 'Scene' })).snapshot
    const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: componentBatch(initial, `tx:physical-${mutation}`) })
    assert.equal(first.ok, true)
    if (!first.ok) return
    const batch = renameBatch(first.value.snapshot, `tx:physical-next-${mutation}`)
    armed = true
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(hit, true, mutation)
    assert.equal(applied.ok, mutation === 'identical-replacement', mutation)
    if (!applied.ok) assert.deepEqual({ code: applied.error.code, retryable: applied.error.retryable },
      mutation.includes('symlink') ? { code: 'unsafe_workspace', retryable: false } : { code: 'recovery_failed', retryable: true }, mutation)
    const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
    assert.equal(state.committedRevision, 2, 'These checkpoints follow publication or allow publication before final backup verification')
    const hasJournal = await lstat(join(projectRoot, '.modly/journal.v1.json')).then(() => true, (error: NodeJS.ErrnoException) => { assert.equal(error.code, 'ENOENT'); return false })
    assert.equal(hasJournal, mutation === 'backup-corrupt')
    const opened = await repository.open({ projectKey: PROJECT_KEY_A })
    if (mutation.includes('symlink') || mutation === 'backup-corrupt') {
      assert.equal(opened.ok, false, mutation)
      if (!opened.ok) assert.deepEqual({ code: opened.error.code, retryable: opened.error.retryable },
        mutation.includes('symlink') ? { code: 'unsafe_workspace', retryable: false } : { code: 'recovery_failed', retryable: true })
    } else {
      const recovered = assertOpened(opened)
      assert.equal(recovered.snapshot.project.revision, mutation === 'identical-replacement' ? 2 : 1)
      const retry = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
      assert.equal(retry.ok, true, mutation)
      if (retry.ok) assert.equal(retry.value.idempotent, mutation === 'identical-replacement')
    }
  }
})


test('apply-local durable proofs refuse warmed hits after journal-cleaned runtime drift', { timeout: 170_000 }, async (t) => {
  for (const mutation of ['prototype', 'throwing-clone', 'deleted-clone', 'swapped-clone'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-proof-runtime-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const cloneDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone')!
    const originalClone = globalThis.structuredClone
    const pollutionKey = 'modlyDurableProofPollution'
    assert.equal(Object.hasOwn(Object.prototype, pollutionKey), false)
    let armed = false
    let hit = false
    let drain = async () => {}
    const repository = createRepository(root, { failureCheckpoint: async (stage) => {
      if (!armed || hit || stage !== 'journal-cleaned') return
      hit = true
      await drain()
      if (mutation === 'prototype') Object.defineProperty(Object.prototype, pollutionKey, { value: true, configurable: true })
      else if (mutation === 'deleted-clone') Reflect.deleteProperty(globalThis, 'structuredClone')
      else Object.defineProperty(globalThis, 'structuredClone', { ...cloneDescriptor, value: mutation === 'throwing-clone'
        ? () => { throw new Error('Changed clone runtime') }
        : <T>(value: T, options?: StructuredSerializeOptions): T => originalClone(value, options) })
    } })
    let snapshot = assertCreated(await repository.create({ name: 'Runtime proof', initialSceneName: 'Scene' })).snapshot
    for (let index = 0; index < 2; index += 1) {
      const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: index === 0
        ? componentBatch(snapshot, 'tx:runtime-component') : renameBatch(snapshot, 'tx:runtime-prior') })
      assert.equal(applied.ok, true)
      if (!applied.ok) return
      snapshot = applied.value.snapshot
    }
    const batch = renameBatch(snapshot, 'tx:runtime-current')
    armed = true
    let measured: Awaited<ReturnType<typeof withDurableCoverage<Awaited<ReturnType<WorldProjectRepository['applyCommands']>>>>>
    try {
      measured = await withDurableCoverage((reset) => { drain = reset; return repository.applyCommands({ projectKey: PROJECT_KEY_A, batch }) }, 'ordinary')
    } finally {
      Reflect.deleteProperty(Object.prototype, pollutionKey)
      Object.defineProperty(globalThis, 'structuredClone', cloneDescriptor)
    }
    assert.equal(hit, true)
    const expectedSuccess = mutation === 'swapped-clone'
    assert.equal(measured.value.ok, expectedSuccess, mutation)
    // Three primary hashes plus two independently range-hashed and verifier-hashed packed receipts.
    assert.deepEqual(measured.counts, expectedSuccess ? { semantic: 5, hash: 7 } : { semantic: 1, hash: 3 }, mutation)
    if (!measured.value.ok) assert.deepEqual({ code: measured.value.error.code, retryable: measured.value.error.retryable }, { code: 'recovery_failed', retryable: true })
    const retried = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(retried.ok && retried.value.idempotent, true)
    assert.equal(retried.ok && retried.value.newRevision, 3)
  }
})

test('apply-local durable proofs reject ambient toJSON before encoding a candidate key', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-proof-ambient-json-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(Object.hasOwn(Object.prototype, 'toJSON'), false)
  let armed = false
  let hit = false
  let ambientCalls = 0
  const repository = createRepository(root, { failureCheckpoint: (stage) => {
    if (!armed || hit || stage !== 'journal-cleaned') return
    hit = true
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value: function (this: unknown) {
      ambientCalls += 1
      return this
    } })
  } })
  const initial = assertCreated(await repository.create({ name: 'Ambient proof', initialSceneName: 'Scene' })).snapshot
  const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: componentBatch(initial, 'tx:ambient-first') })
  assert.equal(first.ok, true)
  if (!first.ok) return
  armed = true
  let result: Awaited<ReturnType<WorldProjectRepository['applyCommands']>>
  try {
    result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(first.value.snapshot, 'tx:ambient-next') })
  } finally {
    Reflect.deleteProperty(Object.prototype, 'toJSON')
  }
  assert.equal(hit, true)
  assert.equal(result.ok, false)
  if (!result.ok) assert.deepEqual({ code: result.error.code, retryable: result.error.retryable }, { code: 'recovery_failed', retryable: true })
  assert.equal(ambientCalls, 0, 'The existing ambient pollution policy must run before cache-key serialization')
})

test('apply-local durable proofs reject pre-scope ambient toJSON before namespace serialization', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-proof-pre-scope-json-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(Object.hasOwn(Object.prototype, 'toJSON'), false)
  let armed = false
  let injected = false
  let ambientCalls = 0
  const repository = createRepository(root, {
    syncDirectory: async (directory) => {
      const synced = await syncDirectoryForTest(directory)
      if (armed && !injected && basename(directory) === '.modly-projects.lock') {
        injected = true
        Object.defineProperty(Object.prototype, 'toJSON', {
          configurable: true,
          value: function (this: unknown) {
            if (Array.isArray(this) && this.includes('modly.world-command-result-proof.v1')) ambientCalls += 1
            return this
          },
        })
      }
      return synced
    },
  })
  const created = assertCreated(await repository.create({ name: 'Pre-scope toJSON', initialSceneName: 'Scene' }))
  armed = true
  let result: Awaited<ReturnType<WorldProjectRepository['applyCommands']>>
  try {
    result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(created.snapshot, 'tx:pre-scope-json') })
  } finally {
    Reflect.deleteProperty(Object.prototype, 'toJSON')
  }
  assert.equal(injected, true)
  assert.equal(result.ok, false)
  if (!result.ok) assert.deepEqual({ code: result.error.code, retryable: result.error.retryable }, { code: 'invalid_document', retryable: false })
  assert.equal(ambientCalls, 0, 'Cache namespace/key serialization must not run while inherited Object.prototype.toJSON is present')
})

test('apply-local durable proofs bind fresh canonical authority even when result bytes match', { timeout: 170_000 }, async (t) => {
  for (const mutation of ['valid-origin', 'wrong-transaction'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-proof-authority-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    let armed = false
    let hit = false
    let drain = async () => {}
    const repository = createRepository(root, { failureCheckpoint: async (stage) => {
      if (!armed || hit || stage !== 'journal-cleaned') return
      hit = true
      const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
      const backupRoot = join(projectRoot, state.lastValidBackup)
      const statePath = join(backupRoot, 'state.v1.json')
      const backup = JSON.parse(await readFile(statePath, 'utf8'))
      const transaction = backup.transactions[0]
      const indexPath = join(backupRoot, 'transactions.index.v1.json')
      const index = JSON.parse(await readFile(indexPath, 'utf8'))
      const packPath = join(backupRoot, 'transactions.pack.v1')
      const before = (await readFile(packPath)).subarray(index.entries[0].offset, index.entries[0].offset + index.entries[0].length)
      const batch: WorldCommandBatchV1 = JSON.parse(transaction.canonicalPayload)
      if (mutation === 'valid-origin') batch.origin = 'workflow'
      else { batch.transactionId = 'tx:changed-authority'; transaction.transactionId = batch.transactionId }
      transaction.canonicalPayload = canonicalWorldCommandBatchPayload(batch)
      transaction.payloadSha256 = sha256Bytes(transaction.canonicalPayload)
      transaction.transactionDigest = sha256Bytes(`${transaction.transactionId}\n${transaction.canonicalPayload}`)
      await chmod(statePath, 0o600)
      await writeFile(statePath, `${JSON.stringify(backup)}\n`)
      index.stateSha256 = sha256Bytes(await readFile(statePath))
      index.entries[0].transactionId = transaction.transactionId
      index.entries[0].transactionDigest = transaction.transactionDigest
      await chmod(indexPath, 0o600)
      await writeFile(indexPath, `${JSON.stringify(index)}\n`)
      const rereadPack = await readFile(packPath)
      assert.deepEqual(rereadPack.subarray(index.entries[0].offset, index.entries[0].offset + index.entries[0].length), before)
      assert.equal(sha256Bytes(before), transaction.resultSha256)
      await drain()
    } })
    let snapshot = assertCreated(await repository.create({ name: 'Authority proof', initialSceneName: 'Scene' })).snapshot
    for (let index = 0; index < 2; index += 1) {
      const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: index === 0
        ? componentBatch(snapshot, 'tx:authority-component') : renameBatch(snapshot, 'tx:authority-prior') })
      assert.equal(applied.ok, true)
      if (!applied.ok) return
      snapshot = applied.value.snapshot
    }
    armed = true
    const measured = await withDurableCoverage((reset) => { drain = reset; return repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:authority-current') }) }, 'ordinary')
    assert.equal(hit, true)
    assert.equal(measured.value.ok, mutation === 'valid-origin')
    assert.deepEqual(measured.counts, mutation === 'valid-origin' ? { semantic: 2, hash: 7 } : { semantic: 1, hash: 5 })
    if (!measured.value.ok) assert.deepEqual({ code: measured.value.error.code, retryable: measured.value.error.retryable }, { code: 'recovery_failed', retryable: true })
  }
})

test('apply-local durable proofs stay cold across failures and workspace namespaces', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-proof-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstRoot = join(root, 'first')
  const secondRoot = join(root, 'second')
  await mkdir(firstRoot)
  await mkdir(secondRoot)
  let workspaceRoot = firstRoot
  let fail = false
  const repository = createRepository(firstRoot, { getWorkspaceRoot: () => workspaceRoot, failureCheckpoint: (stage) => {
    if (fail && stage === 'journal-cleaned') { fail = false; throw new Error('Discard the completed operation scope') }
  } })
  const initial = assertCreated(await repository.create({ name: 'Namespace proof', initialSceneName: 'Scene' })).snapshot
  const firstBatch = componentBatch(initial, 'tx:lifecycle-first')
  const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: firstBatch })
  assert.equal(first.ok, true)
  if (!first.ok) return
  await cp(join(firstRoot, 'Worlds'), join(secondRoot, 'Worlds'), { recursive: true })
  const nextBatch = renameBatch(first.value.snapshot, 'tx:lifecycle-next')
  fail = true
  const failed = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: nextBatch })
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.deepEqual({ code: failed.error.code, retryable: failed.error.retryable }, { code: 'write_failed', retryable: true })
  const repaired = await withDurableCoverage(() => repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: nextBatch }), 'public-retry')
  assert.equal(repaired.value.ok && repaired.value.value.idempotent, true)
  // The failed apply never promotes its new primary or independently destination-keyed backup proof.
  workspaceRoot = secondRoot
  const other = await withDurableCoverage(() => repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: firstBatch }), 'public-retry')
  assert.equal(other.value.ok && other.value.value.idempotent, true)
  assert.equal(other.value.ok && other.value.value.newRevision, 1)
  t.diagnostic(`Failed-scope and namespace retry counts: ${JSON.stringify({ repaired: repaired.counts, other: other.counts })}`)
  assert.deepEqual(repaired.counts, { semantic: 3, hash: 5, materialize: 1 })
  assert.deepEqual(other.counts, { semantic: 2, hash: 2, materialize: 1 })
  assert.deepEqual(assertOpened(await repository.open({ projectKey: PROJECT_KEY_A })).snapshot, first.value.snapshot)
})

test('apply-local durable proof cache keeps newer namespace after overlapping workspaces', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-proof-overlap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstRoot = join(root, 'first')
  const secondRoot = join(root, 'second')
  await mkdir(firstRoot)
  await mkdir(secondRoot)
  let workspaceRoot = firstRoot
  let holdFirst = false
  let held = false
  let released = false
  let releaseFirst!: () => void
  let signalHeld!: () => void
  const releaseFirstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const heldGate = new Promise<void>((resolve) => { signalHeld = resolve })
  const repository = createRepository(firstRoot, { getWorkspaceRoot: () => workspaceRoot, failureCheckpoint: async (stage) => {
    if (!holdFirst || held || workspaceRoot !== firstRoot || stage !== 'after-package') return
    held = true
    signalHeld()
    await releaseFirstGate
  } })

  workspaceRoot = firstRoot
  let firstSnapshot = assertCreated(await repository.create({ name: 'First namespace', initialSceneName: 'Scene' })).snapshot
  const firstPrior = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: componentBatch(firstSnapshot, 'tx:overlap-first-prior') })
  assert.equal(firstPrior.ok, true)
  if (!firstPrior.ok) return
  firstSnapshot = firstPrior.value.snapshot

  workspaceRoot = secondRoot
  let secondSnapshot = assertCreated(await repository.create({ name: 'Second namespace', initialSceneName: 'Scene' })).snapshot
  const secondPrior = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: componentBatch(secondSnapshot, 'tx:overlap-second-prior') })
  assert.equal(secondPrior.ok, true)
  if (!secondPrior.ok) return
  secondSnapshot = secondPrior.value.snapshot

  workspaceRoot = firstRoot
  holdFirst = true
  const firstPending = repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(firstSnapshot, 'tx:overlap-first-held') })
  const releaseHeld = (): void => {
    if (released) return
    released = true
    releaseFirst()
  }
  try {
    await waitForBoundedSignal(heldGate, 'First namespace operation did not reach the after-package hold')

    workspaceRoot = secondRoot
    const secondWinner = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(secondSnapshot, 'tx:overlap-second-winner') })
    assert.equal(secondWinner.ok, true)
    if (!secondWinner.ok) return
    secondSnapshot = secondWinner.value.snapshot

    releaseHeld()
    const firstCompleted = await firstPending
    assert.equal(firstCompleted.ok, true)
    if (!firstCompleted.ok) return

    workspaceRoot = secondRoot
    const measured = await withDurableCoverage(() => repository.applyCommands({
      projectKey: PROJECT_KEY_A,
      batch: renameBatch(secondSnapshot, 'tx:overlap-second-after'),
    }), 'ordinary')
    assert.equal(measured.value.ok, true)
    t.diagnostic(`Overlapping namespaces kept the newer hot cache: ${JSON.stringify(measured.counts)}`)
    assert.deepEqual(measured.counts, { semantic: 1, hash: 29 })
  } finally {
    releaseHeld()
    await firstPending.catch(() => undefined)
  }
})

async function seedLargeProofScene(root: string, repository: WorldProjectRepository, entities: number, tags: number) {
  const initial = assertCreated(await repository.create({ name: 'Large proof', initialSceneName: 'Scene' })).snapshot
  initial.scenes[0].entities = Array.from({ length: entities }, (_, index) => ({
    id: `entity:large-${index}`, name: `Large ${index}`, parentId: null, enabled: true, locked: false,
    tags: Array.from({ length: tags }, (_, tag) => `t${String(tag).padStart(4, '0')}${'x'.repeat(251)}`),
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [],
  }))
  // Bound and validate the real graph before any large command/backup multiplication.
  assert.ok(entities <= 1_024 && tags <= 1_024)
  const validated = validateWorldProjectSnapshot(initial)
  assert.equal(validated.success, true)
  if (!validated.success) throw new Error('Large fixture is not valid')
  const wire = { snapshot: structuredClone(validated.value), inverse: { kind: 'world-snapshot', snapshot: structuredClone(validated.value) } }
  const countNodes = (value: unknown): number => value !== null && typeof value === 'object'
    ? 1 + Object.values(value).reduce<number>((total, child) => total + countNodes(child), 0) : 1
  assert.ok(countNodes(wire) < 100_000)
  assert.equal(validateWorldWireValue(wire).success, true)
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) < 16 * 1024 * 1024)
  const sceneBytes = Buffer.from(`${JSON.stringify(validated.value.scenes[0])}\n`)
  assert.ok(sceneBytes.byteLength < 16 * 1024 * 1024)
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const statePath = join(projectRoot, '.modly/state.v1.json')
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.deepEqual(state.transactions, [])
  const scenePath = join(root, state.scenes[0].path)
  await writeFile(scenePath, sceneBytes)
  state.scenes[0].sha256 = sha256Bytes(sceneBytes)
  await writeFile(statePath, `${JSON.stringify(state)}\n`)
  return assertOpened(await repository.open({ projectKey: PROJECT_KEY_A })).snapshot
}

test('apply-local durable proofs bypass oversized valid results without changing validity', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-proof-oversize-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const snapshot = await seedLargeProofScene(root, repository, 20, 900)
  const batch = renameBatch(snapshot, 'tx:oversized-proof')
  assert.ok(Buffer.byteLength(canonicalWorldCommandBatchPayload(batch)) < 256 * 1024)
  const measured = await withDurableCoverage(() => repository.applyCommands({ projectKey: PROJECT_KEY_A, batch }), 'ordinary')
  assert.equal(measured.value.ok, true)
  if (!measured.value.ok) return
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  const bytes = await readFile(join(projectRoot, '.modly/transactions', state.transactions[0].transactionDigest, 'after/result.v1.json'))
  const compact = JSON.parse(bytes.toString('utf8')) as unknown
  assertStoredCommandResultV2(compact)
  assert.ok(bytes.byteLength < 8 * 1024 * 1024, 'Compact v2 removes the redundant forward snapshot bytes')
  const proofCharge = bytes.byteLength + Buffer.byteLength(stableFixtureSerialize(measured.value.value.snapshot))
    + Buffer.byteLength(stableFixtureSerialize(measured.value.value.inverse.snapshot))
  assert.ok(proofCharge > 8 * 1024 * 1024, 'The exact receipt plus its two canonical chain authorities exceeds the proof budget')
  assert.deepEqual(measured.counts, { semantic: 3, hash: 3 })
  assert.deepEqual(measured.value.value.warnings, [])
  t.diagnostic(`Oversized valid result bytes=${bytes.byteLength}; actual calls=${JSON.stringify(measured.counts)}`)
  assert.deepEqual(assertOpened(await repository.open({ projectKey: PROJECT_KEY_A })).snapshot, measured.value.value.snapshot)
  const successful = measured.value.value
  const next = await withNewBackupCoverage(repository, successful.newRevision, () => repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(successful.snapshot, 'tx:oversized-bridge') }))
  assert.equal(next.value.ok, true)
  assert.deepEqual(next.firstBackup, { semantic: 1, hash: 2 }, 'Oversized proof source reaches the active bridge and falls back to real semantic replay')
})

test('apply-local durable proofs evict real valid results within the byte budget', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-proof-budget-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  let snapshot = await seedLargeProofScene(root, repository, 5, 800)
  for (let index = 0; index < 5; index += 1) {
    const batch = renameBatch(snapshot, `tx:budget-${index}`, `Budget ${index}`)
    assert.ok(Buffer.byteLength(canonicalWorldCommandBatchPayload(batch)) < 256 * 1024)
    const result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(result.ok, true)
    if (!result.ok) return
    snapshot = result.value.snapshot
  }
  const warm = await withNewBackupCoverage(repository, snapshot.project.revision, () => repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:budget-next') }))
  assert.equal(warm.value.ok, true)
  if (!warm.value.ok) return
  t.diagnostic(`Active byte-budget counts: total=${JSON.stringify(warm.counts)}, first=${JSON.stringify(warm.firstBackup)}`)
  assert.equal(warm.firstBackup.hash, 10)
  assert.ok(warm.firstBackup.semantic > 0, 'The active bridge falls back under simultaneous source/destination byte pressure')
  snapshot = warm.value.value.snapshot
  const measured = await withDurableCoverage(() => repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:budget-after-eviction') }), 'ordinary')
  assert.equal(measured.value.ok, true)
  if (!measured.value.ok) return
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  let rawBytes = 0
  const storedResults: StoredCommandResultV2Fixture[] = []
  assert.equal(measured.value.ok, true)
  if (!measured.value.ok) return
  const measuredSnapshot = measured.value.value.snapshot
  for (const transaction of state.transactions) {
    const bytes = await readFile(join(projectRoot, '.modly/transactions', transaction.transactionDigest, 'after/result.v1.json'))
    assert.ok(bytes.byteLength < 8 * 1024 * 1024)
    rawBytes += bytes.byteLength
    const stored = JSON.parse(bytes.toString('utf8')) as unknown
    assertStoredCommandResultV2(stored)
    storedResults.push(stored)
  }
  assert.equal(state.transactions.length, 7)
  const inverseAuthorityBytes = storedResults.reduce((total, stored) => total
    + Buffer.byteLength(stableFixtureSerialize(stored.inverse.snapshot)), 0)
  const forwardAuthorityBytes = storedResults.reduce((total, _stored, index) => total + Buffer.byteLength(stableFixtureSerialize(
	    index + 1 < storedResults.length ? storedResults[index + 1].inverse.snapshot : measuredSnapshot,
  )), 0)
  const proofChargeLowerBound = rawBytes + inverseAuthorityBytes + forwardAuthorityBytes
  assert.ok(proofChargeLowerBound > 8 * 1024 * 1024,
    'Seven valid receipts plus their canonical chain authorities exceed the byte budget before metadata charge')
  t.diagnostic(`Seven valid result bytes=${rawBytes}; proof lower bound=${proofChargeLowerBound}; warm calls=${JSON.stringify(warm.counts)}; post-eviction calls=${JSON.stringify(measured.counts)}`)
  assert.equal(warm.counts.hash, 71, 'Fresh packed ranges retain both hashes without the empty eager housekeeping pass')
  assert.equal(measured.counts.hash, 85)
  assert.ok(measured.counts.semantic > 1 && measured.counts.semantic <= measured.counts.hash, 'Real eviction must force additional semantic verification, not invalidate commands')
  assert.deepEqual(measured.value.value.warnings, [])
  assert.deepEqual(assertOpened(await repository.open({ projectKey: PROJECT_KEY_A })).snapshot, measured.value.value.snapshot)
})

test('sealed packed source falls back under capture pressure after real warm primary hits', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-source-pressure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const records: FineBackupRecord[] = []
  const repository = createRepository(root, fineObserverOptions((record) => { records.push(record) }))
  let snapshot = await seedLargeProofScene(root, repository, 3, 525)
  for (let index = 0; index < 5; index += 1) {
    const result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:source-pressure-${index}`) })
    assert.equal(result.ok, true)
    if (!result.ok) return
    snapshot = result.value.snapshot
  }
  records.length = 0
  const measured = await withNewBackupCoverage(repository, snapshot.project.revision, () => repository.applyCommands({
    projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:source-pressure-next'),
  }))
  assert.equal(measured.value.ok, true)
  assert.equal(measured.counts.hash, 71)
  assert.equal(measured.firstBackup.hash, 10)
  assert.ok(countFine(records.filter((record) => record.phase === 'prior-proof'), 'cache-hit') > 0)
  const lookups = records.filter((record) => record.phase === 'pack-ledger' && record.kind === 'proof-lookup' && record.edge === 'begin')
  assert.equal(lookups.length, 5)
  const packed = lookups.slice(0, 4).map((start) => {
    const end = records.find((record) => record.span === start.span && record.edge === 'settled')!
    const inside = records.filter((record) => record.sequence > start.sequence && record.sequence < end.sequence)
    return { hit: countFine(inside, 'cache-hit'), miss: countFine(inside, 'cache-miss'), replay: countFine(inside, 'replay') }
  })
  assert.ok(packed.some((row) => row.hit === 1), 'A real sealed old-pack range reuses a warm primary proof')
  assert.ok(packed.some((row) => row.miss === 1 && row.replay === 1), 'Another sealed old-pack range replays after capture pressure evicts its primary')
  assert.ok(countFine(records.filter((record) => record.phase === 'pack-ledger'), 'cache-evict') > 0)
  t.diagnostic(`Charged source/capture pressure, not timing: ${JSON.stringify({ packed, total: measured.counts })}`)
  if (measured.value.ok) assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, measured.value.value.snapshot)
})

test('apply-local durable proof cache refreshes committed hit recency after success', { timeout: 180_000 }, async (t) => {
  const successRoot = await mkdtemp(join(tmpdir(), 'modly-world-proof-lru-success-'))
  t.after(() => rm(successRoot, { recursive: true, force: true }))
  const successRepository = createRepository(successRoot)
  let successSnapshot = await seedLargeProofScene(successRoot, successRepository, 5, 800)
  for (let index = 0; index < 4; index += 1) {
    const result = await successRepository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(successSnapshot, `tx:lru-success-${index}`, `LRU success ${index}`) })
    assert.equal(result.ok, true)
    if (!result.ok) return
    successSnapshot = result.value.snapshot
  }
  const successState = JSON.parse(await readFile(join(successRoot, 'Worlds', PROJECT_KEY_A, '.modly/state.v1.json'), 'utf8')) as { transactions: TestDurableTransaction[] }
  const olderSuccess = successState.transactions.at(-2)
  const newestSuccess = successState.transactions.at(-1)
  assert.ok(olderSuccess && newestSuccess)
  assert.equal(newestSuccess.appliedRevision, olderSuccess.appliedRevision + 1)
  await retainOnlyTransactions(successRoot, [olderSuccess, newestSuccess])
  const touched = await successRepository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(successSnapshot, 'tx:lru-success-touch') })
  assert.equal(touched.ok, true, touched.ok ? undefined : JSON.stringify(touched.error))
  if (!touched.ok) return
  successSnapshot = touched.value.snapshot
  const nextBatch = renameBatch(successSnapshot, 'tx:lru-success-after')
  const preview = await successRepository.previewCommands({ projectKey: PROJECT_KEY_A, batch: nextBatch })
  assert.equal(preview.ok, true)
  if (!preview.ok) return
  const successMeasured = await withDurableCoverage(() => successRepository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: nextBatch,
  }), 'ordinary')
  assert.equal(successMeasured.value.ok, true)
  t.diagnostic(`Committed-hit counts: ${JSON.stringify(successMeasured.counts)}`)
  assert.equal(successMeasured.counts.hash, 43)
  assert.ok(successMeasured.counts.semantic > 1 && successMeasured.counts.semantic < successMeasured.counts.hash,
    'Committed hit recency must retain real cache reuse while byte pressure still forces semantic misses')
  if (successMeasured.value.ok) {
    assert.deepEqual(successMeasured.value.value, preview.value)
    assert.deepEqual(successMeasured.value.value.inverse.snapshot, successSnapshot)
    const projectRoot = join(successRoot, 'Worlds', PROJECT_KEY_A)
    const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
    const resultBytes = await readFile(join(projectRoot, '.modly/transactions', state.transactions.at(-1).transactionDigest, 'after/result.v1.json'))
    assert.equal(sha256Bytes(resultBytes), preview.value.receipt.resultSha256)
    assert.deepEqual(assertOpened(await createRepository(successRoot).open({ projectKey: PROJECT_KEY_A })).snapshot, preview.value.snapshot)
  }
  t.diagnostic(`Successful recency under packed destination pressure: ${JSON.stringify(successMeasured.counts)}`)
})

test('apply-local durable proof cache preserves interleaved hit and miss recency', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-proof-lru-interleaved-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  let snapshot = await seedLargeProofScene(root, repository, 8, 800)
  for (let index = 0; index < 3; index += 1) {
    const result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:lru-interleaved-${index}`, `LRU interleaved ${index}`) })
    assert.equal(result.ok, true)
    if (!result.ok) return
    snapshot = result.value.snapshot
  }
  let state = JSON.parse(await readFile(join(root, 'Worlds', PROJECT_KEY_A, '.modly/state.v1.json'), 'utf8')) as { transactions: TestDurableTransaction[] }
  const [, second, third] = state.transactions
  assert.equal(third.appliedRevision, second.appliedRevision + 1)
  await retainOnlyTransactions(root, [second, third])
  const interleaved = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:lru-interleaved-order') })
  assert.equal(interleaved.ok, true)
  if (!interleaved.ok) return
  snapshot = interleaved.value.snapshot
  state = JSON.parse(await readFile(join(root, 'Worlds', PROJECT_KEY_A, '.modly/state.v1.json'), 'utf8')) as { transactions: TestDurableTransaction[] }
  const fourth = state.transactions.at(-1)
  assert.ok(fourth)

  await retainOnlyTransactions(root, [third, fourth])
  const measured = await withDurableCoverage(() => repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(snapshot, 'tx:lru-interleaved-after'),
  }), 'ordinary')
  assert.equal(measured.value.ok, true)
  assert.equal(measured.counts.hash, 29)
  assert.ok(measured.counts.semantic > 1 && measured.counts.semantic < measured.counts.hash,
    'Interleaved hit and miss recency must retain cache reuse without suppressing real semantic misses')
  if (measured.value.ok) {
    assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, measured.value.value.snapshot)
  }
  t.diagnostic(`Interleaved LRU proof counts: ${JSON.stringify(measured.counts)}`)
})

test('apply-local durable proof cache discards failed hit recency touches', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-proof-lru-failed-touch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let failAtAfterPackage = false
  const repository = createRepository(root, { failureCheckpoint: (stage) => {
    if (failAtAfterPackage && stage === 'after-package') {
      failAtAfterPackage = false
      throw new Error('failed touch must not refresh committed proof recency')
    }
  } })
  let snapshot = await seedLargeProofScene(root, repository, 5, 800)
  for (let index = 0; index < 2; index += 1) {
    const result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:lru-failed-touch-${index}`, `LRU failed touch ${index}`) })
    assert.equal(result.ok, true)
    if (!result.ok) return
    snapshot = result.value.snapshot
  }
  const state = JSON.parse(await readFile(join(root, 'Worlds', PROJECT_KEY_A, '.modly/state.v1.json'), 'utf8')) as { transactions: TestDurableTransaction[] }
  const [first, second] = state.transactions
  await retainOnlyTransactions(root, [first, second])
  failAtAfterPackage = true
  const failed = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:lru-failed-touch-order') })
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.deepEqual({ code: failed.error.code, retryable: failed.error.retryable }, { code: 'write_failed', retryable: true })

  await retainOnlyTransactions(root, [first, second])
  const measured = await withDurableCoverage(() => repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(snapshot, 'tx:lru-failed-touch-after'),
  }), 'ordinary')
  assert.equal(measured.value.ok, true)
  assert.equal(measured.counts.semantic, 16)
  t.diagnostic(`Failed-touch discard LRU proof counts: ${JSON.stringify(measured.counts)}`)
})

test('create uses opaque keys, canonical paths, mode-confined documents, and reports degraded durability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-projects-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root, { syncDirectory: async () => false })

  const created = assertCreated(await repository.create({
    name: 'My world',
    initialSceneName: 'Opening scene',
    projectId: 'project:domain-id',
    initialSceneId: 'scene:domain-id',
  }))

  assert.equal(created.projectKey, PROJECT_KEY_A)
  assert.equal(created.snapshot.project.projectId, 'project:domain-id')
  assert.equal(created.snapshot.project.revision, 0)
  assert.equal(created.snapshot.project.scenes[0].documentPath, `Worlds/${PROJECT_KEY_A}/scenes/${SCENE_KEY_A}.world-scene.json`)
  assert.deepEqual(created.durabilityWarnings, ['durability-degraded'])
  assert.deepEqual((await readdir(join(root, 'Worlds', PROJECT_KEY_A))).sort(), ['.modly', 'project.world-project.json', 'scenes'])
})

test('create interruption cleanup or recovery never exposes a partial project', async (t) => {
  const stages = [
    'after-package',
    'backup-created',
    'journal-published',
    'document-published:project.world-project.json',
    `document-published:scenes/${SCENE_KEY_A}.world-scene.json`,
    'state-published',
    'removed-scenes-cleaned',
    'journal-cleaned',
  ]
  for (const [index, failureStage] of stages.entries()) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-create-prejournal-${index}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    let failed = false
    const repository = createRepository(root, {
      failureCheckpoint: (stage) => {
        if (!failed && stage === failureStage) {
          failed = true
          throw new Error('interrupt create before journal')
        }
      },
    })
    const created = await repository.create({ name: 'Interrupted', initialSceneName: 'Scene' })
    assert.equal(created.ok, false, failureStage)
    if (!created.ok) assert.equal(created.error.code, 'write_failed', failureStage)
    const listed = await createRepository(root).list()
    assert.equal(listed.ok, true, failureStage)
    if (listed.ok && index < 2) {
      assert.deepEqual(listed.value, { projects: [], issues: [] }, failureStage)
    } else if (listed.ok && index === stages.length - 1) {
      assert.equal(listed.value.projects[0]?.status, 'ready', failureStage)
      assert.deepEqual(listed.value.issues, [], failureStage)
    } else if (listed.ok) {
      assert.equal(listed.value.projects.length, 1, failureStage)
      assert.equal(listed.value.projects[0]?.status, 'needs-recovery', failureStage)
      assert.deepEqual(listed.value.issues, [{
        projectKey: PROJECT_KEY_A,
        status: 'needs-recovery',
        code: 'recovery_required',
      }], failureStage)
      const opened = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
      assert.equal(opened.snapshot.project.revision, 0, failureStage)
    }
  }
})

test('rejects traversal, Windows paths, scene escapes, and internal symlinks without mutating revision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-projects-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const created = assertCreated(await repository.create({ name: 'Safe', initialSceneName: 'Scene' }))

  for (const projectKey of ['../escape', 'C:\\escape', '/tmp/escape', 'world-%2e%2e']) {
    const opened = await repository.open({ projectKey })
    assert.deepEqual(opened, {
      ok: false,
      error: { code: 'invalid_request', message: 'World project request is invalid.', retryable: false },
    })
  }

  const escaped = {
    schema: WORLD_COMMAND_BATCH_SCHEMA,
    transactionId: 'tx:escape',
    projectId: created.snapshot.project.projectId,
    baseRevision: 0,
    origin: 'ui',
    commands: [{
      type: 'add-scene',
      reference: { id: 'scene:escape', name: 'Escape', documentPath: 'Exports/escape.world-scene.json' },
      scene: {
        schema: 'modly.world-scene.v1',
        projectId: created.snapshot.project.projectId,
        sceneId: 'scene:escape',
        name: 'Escape',
        environment: { backgroundColor: '#111111', ambientIntensity: 0.2 },
        entities: [],
        sequences: [],
      },
    }],
  } satisfies WorldCommandBatchV1
  const escapedResult = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: escaped })
  assert.equal(escapedResult.ok, false)
  if (!escapedResult.ok) assert.equal(escapedResult.error.code, 'invalid_document')
  assert.equal(assertOpened(await repository.open({ projectKey: PROJECT_KEY_A })).snapshot.project.revision, 0)

  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  await mkdir(join(root, 'external-scenes'))
  await rm(join(projectRoot, 'scenes'), { recursive: true })
  await symlink(join(root, 'external-scenes'), join(projectRoot, 'scenes'), 'dir')
  const linked = await repository.open({ projectKey: PROJECT_KEY_A })
  assert.equal(linked.ok, false)
  if (!linked.ok) assert.equal(linked.error.code, 'unsafe_workspace')
})

test('create, add a second scene, list, and reopen through a new repository instance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-projects-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const created = assertCreated(await repository.create({ name: 'Two scenes', initialSceneName: 'One' }))
  const secondPath = `Worlds/${PROJECT_KEY_A}/scenes/scene-fedcba9876543210fedcba9876543210.world-scene.json`
  const batch: WorldCommandBatchV1 = {
    schema: WORLD_COMMAND_BATCH_SCHEMA,
    transactionId: 'tx:add-second',
    projectId: created.snapshot.project.projectId,
    baseRevision: 0,
    origin: 'ui',
    commands: [{
      type: 'add-scene',
      reference: { id: 'scene:two', name: 'Two', documentPath: secondPath },
      scene: {
        schema: 'modly.world-scene.v1',
        projectId: created.snapshot.project.projectId,
        sceneId: 'scene:two',
        name: 'Two',
        environment: { backgroundColor: '#111111', ambientIntensity: 0.2 },
        entities: [],
        sequences: [],
      },
    }],
  }
  const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(applied.ok, true)
  if (applied.ok) assert.equal(applied.value.snapshot.scenes.length, 2)

  const reopened = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
  assert.equal(reopened.snapshot.scenes.length, 2)
  assert.equal(reopened.snapshot.project.revision, 1)
  const listed = await createRepository(root).list()
  assert.equal(listed.ok, true)
  if (listed.ok) assert.deepEqual(listed.value.projects, [{
    projectKey: PROJECT_KEY_A,
    projectId: created.snapshot.project.projectId,
    name: 'Two scenes',
    revision: 1,
    status: 'ready',
  }])
})

test('list reports duplicate project ids, unsupported schemas, and corrupt entries without paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-projects-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assertCreated(await createRepository(root).create({ name: 'First', initialSceneName: 'Scene', projectId: 'project:duplicate' }))
  assertCreated(await createRepository(root, {
    createProjectKey: () => PROJECT_KEY_B,
    createSceneKey: () => 'scene-fedcba9876543210fedcba9876543210',
  }).create({ name: 'Second', initialSceneName: 'Scene', projectId: 'project:duplicate' }))
  const futureKey = 'world-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  await mkdir(join(root, 'Worlds', futureKey), { recursive: true })
  await writeFile(join(root, 'Worlds', futureKey, 'project.world-project.json'), JSON.stringify({
    schema: 'modly.world-project.v2', projectId: 'project:future', name: 'Future', revision: 9,
  }))
  const corruptKey = 'world-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  await mkdir(join(root, 'Worlds', corruptKey), { recursive: true })
  await writeFile(join(root, 'Worlds', corruptKey, 'project.world-project.json'), '{not-json')

  const listed = await createRepository(root).list()
  assert.equal(listed.ok, true)
  if (!listed.ok) return
  assert.equal(listed.value.projects.find((entry) => entry.projectKey === futureKey)?.status, 'unsupported')
  assert.equal(listed.value.projects.find((entry) => entry.projectKey === corruptKey)?.status, 'corrupt')
  assert.equal(listed.value.projects.filter((entry) => entry.status === 'duplicate-project-id').length, 2)
  assert.deepEqual(listed.value.issues.map((issue) => issue.status).sort(), [
    'corrupt', 'duplicate-project-id', 'duplicate-project-id', 'unsupported',
  ])
  assert.equal(JSON.stringify(listed).includes(root), false)
  const unsupported = await createRepository(root).open({ projectKey: futureKey })
  assert.deepEqual(unsupported, {
    ok: true,
    value: { status: 'unsupported', projectKey: futureKey, schema: 'modly.world-project.v2', readOnly: true },
  })
})

test('supported state remains authoritative and never exposes arbitrary schema text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-schema-authority-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assertCreated(await createRepository(root).create({ name: 'Authority', initialSceneName: 'Scene' }))
  const projectPath = join(root, 'Worlds', PROJECT_KEY_A, 'project.world-project.json')
  const project = JSON.parse(await readFile(projectPath, 'utf8'))
  await writeFile(projectPath, JSON.stringify({ ...project, schema: 'modly.world-project.v2' }))

  const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
  assert.equal(opened.ok, false)
  if (!opened.ok) assert.equal(opened.error.code, 'invalid_document')
  const listed = await createRepository(root).list()
  assert.equal(listed.ok, true)
  if (listed.ok) assert.equal(listed.value.projects[0]?.status, 'corrupt')

  const arbitraryKey = 'world-cccccccccccccccccccccccccccccccc'
  await mkdir(join(root, 'Worlds', arbitraryKey), { recursive: true })
  await writeFile(join(root, 'Worlds', arbitraryKey, 'project.world-project.json'), JSON.stringify({
    schema: 'file:///private/schema', projectId: 'project:hostile', name: 'Hostile', revision: 1,
  }))
  const discovered = await createRepository(root).list()
  assert.equal(discovered.ok, true)
  if (discovered.ok) {
    assert.equal(discovered.value.projects.find((entry) => entry.projectKey === arbitraryKey)?.status, 'corrupt')
    assert.equal(JSON.stringify(discovered).includes('file:///private/schema'), false)
  }
})

test('rejects non-exact state references and non-canonical durable transaction metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-state-integrity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const created = assertCreated(await repository.create({ name: 'Integrity', initialSceneName: 'Scene' }))
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const statePath = join(projectRoot, '.modly', 'state.v1.json')
  const initialState = JSON.parse(await readFile(statePath, 'utf8'))
  initialState.project.sceneId = 'scene:smuggled'
  await writeFile(statePath, JSON.stringify(initialState))
  const nonExact = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
  assert.equal(nonExact.ok, false)
  if (!nonExact.ok) assert.equal(nonExact.error.code, 'invalid_document')

  delete initialState.project.sceneId
  await writeFile(statePath, JSON.stringify(initialState))
  const applied = await createRepository(root).applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(created.snapshot, 'tx:digest-integrity'),
  })
  assert.equal(applied.ok, true)
  const committedState = JSON.parse(await readFile(statePath, 'utf8'))
  const validCommittedState = structuredClone(committedState)
  committedState.transactions[0].transactionDigest = '0'.repeat(64)
  await writeFile(statePath, JSON.stringify(committedState))
  const inconsistent = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
  assert.equal(inconsistent.ok, false)
  if (!inconsistent.ok) assert.equal(inconsistent.error.code, 'invalid_document')

  const transaction = validCommittedState.transactions[0]
  const oldDigest = transaction.transactionDigest
  transaction.canonicalPayload = JSON.stringify(JSON.parse(transaction.canonicalPayload), null, 2)
  transaction.payloadSha256 = createHash('sha256').update(transaction.canonicalPayload).digest('hex')
  transaction.transactionDigest = createHash('sha256')
    .update(`${transaction.transactionId}\n${transaction.canonicalPayload}`)
    .digest('hex')
  await rename(
    join(projectRoot, '.modly', 'transactions', oldDigest),
    join(projectRoot, '.modly', 'transactions', transaction.transactionDigest),
  )
  await writeFile(statePath, JSON.stringify(validCommittedState))
  const nonCanonical = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
  assert.equal(nonCanonical.ok, false)
  if (!nonCanonical.ok) assert.equal(nonCanonical.error.code, 'invalid_document')
})

test('preview is write-free, apply is atomic, stale revisions fail, and durable idempotency survives restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-projects-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const created = assertCreated(await repository.create({ name: 'Commands', initialSceneName: 'Scene' }))
  const statePath = join(root, 'Worlds', PROJECT_KEY_A, '.modly', 'state.v1.json')
  const beforeState = await readFile(statePath, 'utf8')
  const batch = renameBatch(created.snapshot, 'tx:rename')

  const preview = await repository.previewCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(preview.ok, true)
  if (preview.ok) {
    assert.equal(preview.value.snapshot.project.name, 'Renamed world')
    assert.equal(preview.value.newRevision, 1)
  }
  assert.equal(await readFile(statePath, 'utf8'), beforeState)
  assert.equal(assertOpened(await repository.open({ projectKey: PROJECT_KEY_A })).snapshot.project.revision, 0)

  const invalid = renameBatch(created.snapshot, 'tx:invalid', '')
  const rejected = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: invalid })
  assert.equal(rejected.ok, false)
  assert.equal(await readFile(statePath, 'utf8'), beforeState)

  const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(applied.ok, true)
  if (!applied.ok) return
  assert.equal(applied.value.newRevision, 1)
  assert.equal(applied.value.idempotent, false)
  assert.deepEqual(applied.value.changes, [...applied.value.changes].sort())

  const stale = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(created.snapshot, 'tx:stale', 'Stale'),
  })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'revision_conflict')

  const idempotent = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(idempotent.ok, true)
  if (idempotent.ok) {
    assert.equal(idempotent.value.idempotent, true)
    assert.equal(idempotent.value.newRevision, 1)
    assert.equal(idempotent.value.warnings.includes('transaction-idempotent'), true)
  }
  const reused = await createRepository(root).applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: { ...batch, commands: [{ type: 'rename-project', name: 'Different' }] },
  })
  assert.equal(reused.ok, false)
  if (!reused.ok) assert.equal(reused.error.code, 'transaction_reuse')
})

test('preview and delete never recover a pending journal while open remains the recovery authority', async (t) => {
  for (const operation of ['preview', 'delete'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-no-${operation}-recovery-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const created = assertCreated(await createRepository(root).create({ name: 'Before', initialSceneName: 'Scene' }))
    const batch = renameBatch(created.snapshot, `tx:pending-${operation}`, 'After')
    let interrupted = false
    const applied = await createRepository(root, {
      failureCheckpoint: (stage) => {
        if (!interrupted && stage === 'journal-published') {
          interrupted = true
          throw new Error('leave recovery pending')
        }
      },
    }).applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(applied.ok, false)
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const journalPath = join(projectRoot, '.modly', 'journal.v1.json')
    assert.equal((await lstat(journalPath)).isFile(), true)
    const before = await fingerprintTree(projectRoot)

    const result = operation === 'preview'
      ? await createRepository(root).previewCommands({ projectKey: PROJECT_KEY_A, batch })
      : await createRepository(root).delete({
        projectKey: PROJECT_KEY_A,
        expectedRevision: created.snapshot.project.revision,
        transactionId: 'tx:delete-pending',
      })
    assert.equal(result.ok, false, operation)
    if (!result.ok) assert.equal(result.error.code, 'project_busy', operation)
    assert.deepEqual(await fingerprintTree(projectRoot), before, operation)

    const recovered = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
    assert.equal(recovered.snapshot.project.revision, 1, operation)
    await assert.rejects(lstat(journalPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  }
})

test('recovers every publication checkpoint without exposing a partial snapshot', async (t) => {
  const stages = [
    'after-package',
    'backup-created',
    'journal-published',
    'document-published:project.world-project.json',
    `document-published:scenes/${SCENE_KEY_A}.world-scene.json`,
    'state-published',
    'removed-scenes-cleaned',
    'journal-cleaned',
  ]
  for (const [index, failureStage] of stages.entries()) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-recovery-${index}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const created = assertCreated(await createRepository(root).create({ name: 'Before', initialSceneName: 'Scene' }))
    const batch = renameBatch(created.snapshot, `tx:recover-${index}`, 'After')
    let failed = false
    const interrupted = createRepository(root, {
      failureCheckpoint: async (stage) => {
        if (!failed && stage === failureStage) {
          failed = true
          throw new Error(`private ${root} interruption`)
        }
      },
    })
    const result = await interrupted.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(result.ok, false, failureStage)
    if (!result.ok) {
      assert.equal(result.error.code, 'write_failed', failureStage)
      assert.equal(JSON.stringify(result).includes(root), false)
    }

    const recoveredRepository = createRepository(root)
    const opened = assertOpened(await recoveredRepository.open({ projectKey: PROJECT_KEY_A }))
    assert.equal(opened.snapshot.project.revision, index < 2 ? 0 : 1, failureStage)
    const retry = await recoveredRepository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(retry.ok, true, failureStage)
    if (retry.ok) {
      assert.equal(retry.value.newRevision, 1, failureStage)
      assert.equal(retry.value.idempotent, index >= 2, failureStage)
    }
  }
})

test('stable durable results are hash and runtime verified before a project is ready', async (t) => {
  const mutations: DurableResultMutation[] = [
    'missing', 'truncated', 'corrupt', 'wrong-hash', 'wrong-transaction', 'wrong-revision',
  ]
  for (const mutation of mutations) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-stable-result-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    const created = assertCreated(await repository.create({ name: 'Before', initialSceneName: 'Scene' }))
    const batch = renameBatch(created.snapshot, `tx:stable-${mutation}`, 'Revision one')
    assert.equal((await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })).ok, true)

    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const statePath = join(projectRoot, '.modly', 'state.v1.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const resultPath = join(
      projectRoot, '.modly', 'transactions', state.transactions[0].transactionDigest, 'after', 'result.v1.json',
    )
    await mutateDurableResult(resultPath, statePath, mutation)

    const recovered = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
    assert.equal(recovered.snapshot.project.revision, 0, mutation)
    const retry = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(retry.ok, true, mutation)
    if (retry.ok) {
      assert.equal(retry.value.newRevision, 1, mutation)
      assert.equal(retry.value.idempotent, false, mutation)
    }
  }
})

test('pending after-package results are verified before roll-forward and safely restore the backup', async (t) => {
  const mutations: DurableResultMutation[] = [
    'missing', 'truncated', 'corrupt', 'wrong-hash', 'wrong-transaction', 'wrong-revision',
  ]
  for (const mutation of mutations) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-pending-result-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const initialRepository = createRepository(root)
    const created = assertCreated(await initialRepository.create({ name: 'Revision zero', initialSceneName: 'Scene' }))
    const first = await initialRepository.applyCommands({
      projectKey: PROJECT_KEY_A,
      batch: renameBatch(created.snapshot, `tx:pending-base-${mutation}`, 'Revision one'),
    })
    assert.equal(first.ok, true)
    if (!first.ok) continue
    const pendingBatch = renameBatch(first.value.snapshot, `tx:pending-${mutation}`, 'Revision two')
    let interrupted = false
    const pendingRepository = createRepository(root, {
      failureCheckpoint: (stage) => {
        if (!interrupted && stage === 'journal-published') {
          interrupted = true
          throw new Error('interrupt pending result')
        }
      },
    })
    assert.equal((await pendingRepository.applyCommands({ projectKey: PROJECT_KEY_A, batch: pendingBatch })).ok, false)

    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const journalPath = join(projectRoot, '.modly', 'journal.v1.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    const afterRoot = join(projectRoot, journal.afterRoot)
    await mutateDurableResult(
      join(afterRoot, 'result.v1.json'),
      join(afterRoot, 'state.v1.json'),
      mutation,
      journalPath,
    )

    const recovered = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
    assert.equal(recovered.snapshot.project.revision, 1, mutation)
    await assert.rejects(lstat(journalPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
    const retry = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch: pendingBatch })
    assert.equal(retry.ok, true, mutation)
    if (retry.ok) {
      assert.equal(retry.value.newRevision, 2, mutation)
      assert.equal(retry.value.idempotent, false, mutation)
    }
  }
})

test('invalid backup results fail closed with journal and staged package intact', async (t) => {
  const mutations: DurableResultMutation[] = [
    'missing', 'truncated', 'corrupt', 'wrong-hash', 'wrong-transaction', 'wrong-revision',
  ]
  for (const mutation of mutations) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-backup-result-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const initialRepository = createRepository(root)
    const created = assertCreated(await initialRepository.create({ name: 'Revision zero', initialSceneName: 'Scene' }))
    const first = await initialRepository.applyCommands({
      projectKey: PROJECT_KEY_A,
      batch: renameBatch(created.snapshot, `tx:backup-base-${mutation}`, 'Revision one'),
    })
    assert.equal(first.ok, true)
    if (!first.ok) continue
    let interrupted = false
    const pendingRepository = createRepository(root, {
      failureCheckpoint: (stage) => {
        if (!interrupted && stage === 'journal-published') {
          interrupted = true
          throw new Error('interrupt before backup validation')
        }
      },
    })
    const pendingBatch = renameBatch(first.value.snapshot, `tx:backup-pending-${mutation}`, 'Revision two')
    assert.equal((await pendingRepository.applyCommands({ projectKey: PROJECT_KEY_A, batch: pendingBatch })).ok, false)

    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const journalPath = join(projectRoot, '.modly', 'journal.v1.json')
    const journalBytes = await readFile(journalPath)
    const journal = JSON.parse(journalBytes.toString('utf8'))
    const afterRoot = join(projectRoot, journal.afterRoot)
    await writeFile(join(afterRoot, 'project.world-project.json'), '{')
    const backupRoot = join(projectRoot, journal.previousBackup)
    const backupStatePath = join(backupRoot, 'state.v1.json')
    await mutatePackedBackupResult(backupRoot, backupStatePath, mutation)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
      assert.equal(opened.ok, false, `${mutation} attempt ${attempt}`)
      if (!opened.ok) assert.equal(opened.error.code, 'recovery_failed', mutation)
      assert.deepEqual(await readFile(journalPath), journalBytes, mutation)
      assert.equal((await lstat(afterRoot)).isDirectory(), true, mutation)
    }
  }
})

test('list is observational and classifies recovery without changing any project tree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-list-read-only-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const created = assertCreated(await repository.create({ name: 'Before', initialSceneName: 'Scene' }))
  let interrupted = false
  const pendingRepository = createRepository(root, {
    failureCheckpoint: (stage) => {
      if (!interrupted && stage === 'journal-published') {
        interrupted = true
        throw new Error('leave recoverable journal')
      }
    },
  })
  assert.equal((await pendingRepository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(created.snapshot, 'tx:list-pending', 'After'),
  })).ok, false)

  const worldsRoot = join(root, 'Worlds')
  const pendingBefore = await fingerprintTree(worldsRoot)
  const pendingList = await createRepository(root).list()
  assert.deepEqual(pendingList, {
    ok: true,
    value: {
      projects: [{ projectKey: PROJECT_KEY_A, status: 'needs-recovery' }],
      issues: [{ projectKey: PROJECT_KEY_A, status: 'needs-recovery', code: 'recovery_required' }],
    },
  })
  assert.deepEqual(await fingerprintTree(worldsRoot), pendingBefore)

  const recovered = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
  assert.equal(recovered.snapshot.project.name, 'After')
  const readyBefore = await fingerprintTree(worldsRoot)
  const readyList = await createRepository(root).list()
  assert.equal(readyList.ok, true)
  if (readyList.ok) assert.equal(readyList.value.projects[0]?.status, 'ready')
  assert.deepEqual(await fingerprintTree(worldsRoot), readyBefore)

  const futureKey = 'world-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const corruptKey = 'world-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  await mkdir(join(worldsRoot, futureKey), { recursive: true })
  await writeFile(join(worldsRoot, futureKey, 'project.world-project.json'), '{"schema":"modly.world-project.v2"}')
  await mkdir(join(worldsRoot, corruptKey), { recursive: true })
  await writeFile(join(worldsRoot, corruptKey, 'project.world-project.json'), '{')
  const mixedBefore = await fingerprintTree(worldsRoot)
  const mixedList = await createRepository(root).list()
  assert.equal(mixedList.ok, true)
  if (mixedList.ok) {
    assert.equal(mixedList.value.projects.find((entry) => entry.projectKey === futureKey)?.status, 'unsupported')
    assert.equal(mixedList.value.projects.find((entry) => entry.projectKey === corruptKey)?.status, 'corrupt')
  }
  assert.deepEqual(await fingerprintTree(worldsRoot), mixedBefore)
})

test('incomplete root locks stay busy while fresh and become reclaimable only after the stale timeout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-incomplete-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let crashed = false
  const crashedRepository = createRepository(root, {
    failureCheckpoint: (stage) => {
      if (!crashed && stage === 'root-lock-directory-created') {
        crashed = true
        throw new Error('crash before owner publication')
      }
    },
  })
  const failed = await crashedRepository.create({ name: 'Blocked', initialSceneName: 'Scene' })
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.equal(failed.error.code, 'project_busy')
  const lockPath = join(root, 'Worlds', '.modly-projects.lock')
  assert.equal((await lstat(lockPath)).isDirectory(), true)
  await assert.rejects(lstat(join(lockPath, 'owner.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')

  const fresh = await createRepository(root).create({ name: 'Still blocked', initialSceneName: 'Scene' })
  assert.equal(fresh.ok, false)
  if (!fresh.ok) assert.equal(fresh.error.code, 'project_busy')

  const now = new Date('2026-09-02T00:00:00.000Z')
  const stale = new Date(now.getTime() - (2 * 60 * 1_000 + 1))
  await utimes(lockPath, stale, stale)
  assertCreated(await createRepository(root, { now: () => now }).create({ name: 'Recovered', initialSceneName: 'Scene' }))
})

test('malformed locks use directory age while valid live owners are never removed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-lock-owner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assertCreated(await createRepository(root).create({ name: 'Lock owner', initialSceneName: 'Scene' }))
  const lockPath = join(root, 'Worlds', '.modly-projects.lock')
  const now = new Date('2026-09-02T00:00:00.000Z')
  const stale = new Date(now.getTime() - (2 * 60 * 1_000 + 1))

  for (const ownerBytes of [null, '', '{malformed']) {
    await mkdir(lockPath)
    const ownerPath = join(lockPath, 'owner.json')
    if (ownerBytes !== null) await writeFile(ownerPath, ownerBytes)
    const fresh = new Date()
    await utimes(lockPath, fresh, fresh)
    const blocked = await createRepository(root, { now: () => fresh }).open({ projectKey: PROJECT_KEY_A })
    assert.equal(blocked.ok, false)
    if (!blocked.ok) assert.equal(blocked.error.code, 'project_busy')
    await utimes(lockPath, stale, stale)
    if (ownerBytes !== null) await utimes(ownerPath, stale, stale)
    assertOpened(await createRepository(root, { now: () => now }).open({ projectKey: PROJECT_KEY_A }))
  }

  await mkdir(lockPath)
  const malformedOwnerPath = join(lockPath, 'owner.json')
  await writeFile(malformedOwnerPath, '{old-malformed')
  await utimes(lockPath, stale, stale)
  await writeFile(malformedOwnerPath, '{fresh-malformed')
  const freshMalformed = await createRepository(root, { now: () => now }).open({ projectKey: PROJECT_KEY_A })
  assert.equal(freshMalformed.ok, false)
  if (!freshMalformed.ok) assert.equal(freshMalformed.error.code, 'project_busy')
  assert.equal(await readFile(malformedOwnerPath, 'utf8'), '{fresh-malformed')
  await utimes(malformedOwnerPath, stale, stale)
  assertOpened(await createRepository(root, { now: () => now }).open({ projectKey: PROJECT_KEY_A }))

  await mkdir(lockPath)
  const liveOwner = `${JSON.stringify({ pid: 4242, token: 'a'.repeat(32), createdAt: stale.toISOString() })}\n`
  const liveOwnerPath = join(lockPath, 'owner.json')
  await writeFile(liveOwnerPath, liveOwner)
  const live = await createRepository(root, { now: () => now, isProcessAlive: () => true }).open({ projectKey: PROJECT_KEY_A })
  assert.equal(live.ok, false)
  if (!live.ok) assert.equal(live.error.code, 'project_busy')
  assert.equal(await readFile(liveOwnerPath, 'utf8'), liveOwner)

  await utimes(liveOwnerPath, stale, stale)
  await utimes(lockPath, stale, stale)
  const dead = await createRepository(root, { now: () => now, isProcessAlive: () => false }).open({ projectKey: PROJECT_KEY_A })
  assertOpened(dead)
  await assert.rejects(lstat(lockPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
})

test('restores the complete prior backup when a prepared after-package is invalid', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const created = assertCreated(await createRepository(root).create({ name: 'Before', initialSceneName: 'Scene' }))
  const batch = renameBatch(created.snapshot, 'tx:corrupt-after', 'After')
  let interrupted = false
  const repository = createRepository(root, {
    failureCheckpoint: async (stage) => {
      if (stage !== 'journal-published' || interrupted) return
      interrupted = true
      const journal = JSON.parse(await readFile(join(root, 'Worlds', PROJECT_KEY_A, '.modly', 'journal.v1.json'), 'utf8'))
      await writeFile(join(root, 'Worlds', PROJECT_KEY_A, journal.afterRoot, 'project.world-project.json'), '{corrupt')
      throw new Error('interrupt after corrupting staged package')
    },
  })
  const failed = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(failed.ok, false)
  const reopened = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
  assert.equal(reopened.snapshot.project.name, 'Before')
  assert.equal(reopened.snapshot.project.revision, 0)
})

test('rollback of an interrupted scene removal preserves every prior committed scene', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-scene-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const created = assertCreated(await repository.create({ name: 'Before', initialSceneName: 'One' }))
  const secondKey = 'scene-fedcba9876543210fedcba9876543210'
  const secondPath = `Worlds/${PROJECT_KEY_A}/scenes/${secondKey}.world-scene.json`
  const added = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: {
      schema: WORLD_COMMAND_BATCH_SCHEMA,
      transactionId: 'tx:add-before-rollback',
      projectId: created.snapshot.project.projectId,
      baseRevision: 0,
      origin: 'ui',
      commands: [{
        type: 'add-scene',
        reference: { id: 'scene:two', name: 'Two', documentPath: secondPath },
        scene: {
          schema: 'modly.world-scene.v1', projectId: created.snapshot.project.projectId,
          sceneId: 'scene:two', name: 'Two', environment: { backgroundColor: '#111111', ambientIntensity: 0.2 },
          entities: [], sequences: [],
        },
      }],
    },
  })
  assert.equal(added.ok, true)
  let interrupted = false
  const removingRepository = createRepository(root, {
    failureCheckpoint: async (stage) => {
      if (stage !== 'journal-published' || interrupted) return
      interrupted = true
      const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
      const journal = JSON.parse(await readFile(join(projectRoot, '.modly', 'journal.v1.json'), 'utf8'))
      await writeFile(join(projectRoot, journal.afterRoot, 'project.world-project.json'), '{corrupt')
      throw new Error('interrupt invalid scene-removal package')
    },
  })
  const failed = await removingRepository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: {
      schema: WORLD_COMMAND_BATCH_SCHEMA,
      transactionId: 'tx:remove-rollback',
      projectId: created.snapshot.project.projectId,
      baseRevision: 1,
      origin: 'ui',
      commands: [{ type: 'remove-scene', sceneId: 'scene:two' }],
    },
  })
  assert.equal(failed.ok, false)

  const reopened = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
  assert.equal(reopened.snapshot.project.revision, 1)
  assert.equal(reopened.snapshot.scenes.length, 2)
  assert.equal((await readdir(join(root, 'Worlds', PROJECT_KEY_A, 'scenes'))).includes(`${secondKey}.world-scene.json`), true)
})

test('rejects retained transaction packages whose after directory is a symlink', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-transaction-link-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const created = assertCreated(await repository.create({ name: 'Linked transaction', initialSceneName: 'Scene' }))
  assert.equal((await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(created.snapshot, 'tx:linked-package'),
  })).ok, true)
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly', 'state.v1.json'), 'utf8'))
  const afterRoot = join(projectRoot, '.modly', 'transactions', state.transactions[0].transactionDigest, 'after')
  const externalAfter = join(root, 'external-after')
  await rename(afterRoot, externalAfter)
  await symlink(externalAfter, afterRoot, 'dir')

  const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
  assert.equal(opened.ok, false)
  if (!opened.ok) assert.equal(opened.error.code, 'unsafe_workspace')
})

test('complete backups retain every durable result referenced by their bounded ledger', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-ledger-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  let snapshot = assertCreated(await repository.create({ name: 'Revision 0', initialSceneName: 'Scene' })).snapshot
  const firstBatch = renameBatch(snapshot, 'tx:ledger-00', 'Revision 1')
  for (let index = 0; index < 33; index += 1) {
    const batch = index === 0
      ? firstBatch
      : renameBatch(snapshot, `tx:ledger-${String(index).padStart(2, '0')}`, `Revision ${index + 1}`)
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(applied.ok, true, `revision ${index + 1}`)
    if (!applied.ok) return
    snapshot = applied.value.snapshot
  }
  assert.equal(snapshot.project.revision, 33)
  const retainedBackupRevisions = (await readdir(join(root, 'Worlds', PROJECT_KEY_A, '.modly', 'backups')))
    .map((name) => Number(name.slice(0, name.indexOf('-'))))
    .sort((left, right) => left - right)
  assert.deepEqual(retainedBackupRevisions, [25, 26, 27, 28, 29, 30, 31, 32])
  await writeFile(join(root, 'Worlds', PROJECT_KEY_A, 'project.world-project.json'), '{corrupt')

  const recovered = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
  assert.equal(recovered.snapshot.project.revision, 32)
  const retried = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch: firstBatch })
  assert.equal(retried.ok, true)
  if (retried.ok) {
    assert.equal(retried.value.idempotent, true)
    assert.equal(retried.value.newRevision, 1)
  }
})

test('backup pack writes a single packed receipt file without per-result backup directories', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-backup-cohort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seeded = await seedMatureBackupSource(root, 'Cohort')
  const backupSyncDirectories: string[] = []

  const repository = createRepository(root, {
    syncDirectory: async (directory) => {
      const synced = await syncDirectoryForTest(directory)
      if (directory.replaceAll('\\', '/').includes(`${PROJECT_KEY_A}/.modly/backups/33-`)) backupSyncDirectories.push(directory.replaceAll('\\', '/'))
      return synced
    },
  })
  const applied = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(seeded.snapshot, 'tx:cohort-measured', 'Cohort measured'),
  })
  assert.equal(applied.ok, true)
  assert.equal(backupSyncDirectories.some((directory) => directory.includes('/transactions/')), false)
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  const backupRoot = join(projectRoot, state.lastValidBackup)
  assert.deepEqual((await readdir(backupRoot)).sort(), ['project.world-project.json', 'scenes', 'state.v1.json', 'transactions.index.v1.json', 'transactions.pack.v1'])
  const index = JSON.parse(await readFile(join(backupRoot, 'transactions.index.v1.json'), 'utf8'))
  assert.equal(index.entries.length, 32)
  assert.equal(index.pack.sha256, sha256Bytes(await readFile(join(backupRoot, 'transactions.pack.v1'))))
})

test('backup pack durability warnings settle before returning', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-backup-cohort-warning-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seeded = await seedMatureBackupSource(root, 'Warning')
  const lateSyncDirectories: string[] = []
  let returned = false

  const repository = createRepository(root, {
    syncDirectory: async (directory) => {
      const synced = await syncDirectoryForTest(directory)
      if (returned) lateSyncDirectories.push(directory)
      if (/\/\.modly\/backups\/33-[a-f0-9]{64}$/.test(directory.replaceAll('\\', '/'))) return false
      return synced
    },
  })
  const applied = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(seeded.snapshot, 'tx:cohort-warning', 'Warning measured'),
  })
  returned = true
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(applied.ok, true)
  if (applied.ok) assert.deepEqual(applied.value.warnings, ['durability-degraded'])
  assert.deepEqual(lateSyncDirectories, [])
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  const backupRoot = join(projectRoot, state.lastValidBackup)
  assert.equal(sha256Bytes(await readFile(join(backupRoot, 'transactions.pack.v1'))), JSON.parse(await readFile(join(backupRoot, 'transactions.index.v1.json'), 'utf8')).pack.sha256)
})

test('backup packing preserves result order, reduced sync counts, and independent backup bytes', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-backup-cohort-bytes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backupSyncDirectories: string[] = []
  const seeded = await seedMatureBackupSource(root, 'Bytes')
  const sourceBytesByDigest = await retainedTransactionBytes(root)
  const repository = createRepository(root, {
    syncDirectory: async (directory) => {
      const synced = await syncDirectoryForTest(directory)
      if (directory.replaceAll('\\', '/').includes(`${PROJECT_KEY_A}/.modly/backups/33-`)) backupSyncDirectories.push(directory.replaceAll('\\', '/'))
      return synced
    },
  })
  const applied = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(seeded.snapshot, 'tx:cohort-bytes', 'Bytes measured'),
  })
  assert.equal(applied.ok, true)
  assert.equal(backupSyncDirectories.filter((directory) => directory.endsWith('/transactions')).length, 0)
  assert.equal(backupSyncDirectories.filter((directory) => directory.includes('/transactions/')).length, 0)
  assert.equal(backupSyncDirectories.filter((directory) => directory.endsWith('/scenes')).length, 1)
  assert.equal(backupSyncDirectories.filter((directory) => /\/\.modly\/backups\/33-[a-f0-9]{64}$/.test(directory)).length, 2)

  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  const backupRoot = join(projectRoot, ...state.lastValidBackup.split('/'))
  const backupState = JSON.parse(await readFile(join(backupRoot, 'state.v1.json'), 'utf8'))
  await assert.rejects(lstat(join(backupRoot, 'transactions')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  const index = JSON.parse(await readFile(join(backupRoot, 'transactions.index.v1.json'), 'utf8'))
  const pack = await readFile(join(backupRoot, 'transactions.pack.v1'))
  assert.equal(index.schema, 'modly.world-backup-transaction-pack.v1')
  assert.equal(index.entries.length, 32)
  assert.equal(index.pack.byteLength, pack.byteLength)
  assert.equal(index.pack.sha256, sha256Bytes(pack))
  let expectedOffset = 0
  for (const [entryIndex, transaction] of backupState.transactions.entries()) {
    const entry = index.entries[entryIndex]
    assert.deepEqual(
      { transactionId: entry.transactionId, transactionDigest: entry.transactionDigest, resultSha256: entry.resultSha256, offset: entry.offset },
      { transactionId: transaction.transactionId, transactionDigest: transaction.transactionDigest, resultSha256: transaction.resultSha256, offset: expectedOffset },
    )
    const source = sourceBytesByDigest.get(transaction.transactionDigest)
    assert.ok(source, `source bytes captured for ${transaction.transactionDigest}`)
    const backup = pack.subarray(entry.offset, entry.offset + entry.length)
    assert.deepEqual(backup, source)
    assert.equal(sha256Bytes(backup), sha256Bytes(source))
    expectedOffset += entry.length
  }
  assert.equal(expectedOffset, pack.byteLength)

  const primaryDigests = new Set(state.transactions.map((transaction: { transactionDigest: string }) => transaction.transactionDigest))
  const retained = backupState.transactions.find((transaction: { transactionDigest: string }) => primaryDigests.has(transaction.transactionDigest))
  assert.ok(retained, 'backup should contain a transaction still retained in the primary ledger')
  const primaryResult = join(projectRoot, '.modly', 'transactions', retained.transactionDigest, 'after', 'result.v1.json')
  const primaryBefore = await readFile(primaryResult)
  const primaryStatBefore = await lstat(primaryResult)
  const retainedIndex = backupState.transactions.findIndex((transaction: { transactionDigest: string }) => transaction.transactionDigest === retained.transactionDigest)
  const retainedEntry = index.entries[retainedIndex]
  const corruptedPack = Buffer.from(pack)
  Buffer.from('{}\n').copy(corruptedPack, retainedEntry.offset)
  await chmod(join(backupRoot, 'transactions.pack.v1'), 0o600)
  await writeFile(join(backupRoot, 'transactions.pack.v1'), corruptedPack)
  const primaryAfter = await readFile(primaryResult)
  const primaryStatAfter = await lstat(primaryResult)
  assert.deepEqual(primaryAfter, primaryBefore)
  assert.equal(sha256Bytes(primaryAfter), sha256Bytes(primaryBefore))
  assert.equal(primaryStatAfter.dev, primaryStatBefore.dev)
  assert.equal(primaryStatAfter.ino, primaryStatBefore.ino)
  const listed = await createRepository(root).list()
  assert.equal(listed.ok, true)
  if (listed.ok) assert.equal(listed.value.projects.find((entry) => entry.projectKey === PROJECT_KEY_A)?.status, 'corrupt')
  const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
  assert.equal(opened.ok, false)
  if (!opened.ok) assert.equal(opened.error.code, 'recovery_failed')
})

test('ready discovery and open fail closed when the referenced backup result is invalid', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-referenced-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  let snapshot = assertCreated(await repository.create({ name: 'Revision 0', initialSceneName: 'Scene' })).snapshot
  const first = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(snapshot, 'tx:backup-source', 'Revision 1'),
  })
  assert.equal(first.ok, true)
  if (!first.ok) return
  snapshot = first.value.snapshot
  const second = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: renameBatch(snapshot, 'tx:backup-current', 'Revision 2'),
  })
  assert.equal(second.ok, true)
  if (!second.ok) return

  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const currentState = JSON.parse(await readFile(join(projectRoot, '.modly', 'state.v1.json'), 'utf8'))
  assert.equal(typeof currentState.lastValidBackup, 'string')
  const backupRoot = join(projectRoot, ...currentState.lastValidBackup.split('/'))
  const backupState = JSON.parse(await readFile(join(backupRoot, 'state.v1.json'), 'utf8'))
  const index = JSON.parse(await readFile(join(backupRoot, 'transactions.index.v1.json'), 'utf8'))
  const retainedEntry = index.entries.at(-1)
  assert.equal(retainedEntry.transactionDigest, backupState.transactions.at(-1).transactionDigest)
  const packPath = join(backupRoot, 'transactions.pack.v1')
  const packBytes = await readFile(packPath)
  const corruptPack = Buffer.from(packBytes)
  await chmod(packPath, 0o600)
  Buffer.from('{}\n').copy(corruptPack, retainedEntry.offset)
  await writeFile(packPath, corruptPack)
  const corruptBytes = await readFile(packPath)

  const listed = await createRepository(root).list()
  assert.equal(listed.ok, true)
  if (listed.ok) {
    assert.equal(listed.value.projects.find((entry) => entry.projectKey === PROJECT_KEY_A)?.status, 'corrupt')
  }
  const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
  assert.equal(opened.ok, false)
  if (!opened.ok) assert.equal(opened.error.code, 'recovery_failed')
  assert.deepEqual(await readFile(packPath), corruptBytes)
})

test('packed backup index and range corruption fail closed without legacy fallback', async (t) => {
  const cases = ['missing-pack', 'missing-index', 'bad-schema', 'wrong-state-sha', 'wrong-pack-sha', 'trailing-bytes', 'gap', 'mixed-layout'] as const
  for (const mutation of cases) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-packed-backup-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    let snapshot = assertCreated(await repository.create({ name: 'Packed corruption', initialSceneName: 'Scene' })).snapshot
    const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:packed-first-${mutation}`, 'Revision 1') })
    assert.equal(first.ok, true, mutation)
    if (!first.ok) continue
    snapshot = first.value.snapshot
    const second = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:packed-second-${mutation}`, 'Revision 2') })
    assert.equal(second.ok, true, mutation)
    if (!second.ok) continue
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
    const backupRoot = join(projectRoot, state.lastValidBackup)
    const indexPath = join(backupRoot, 'transactions.index.v1.json')
    const packPath = join(backupRoot, 'transactions.pack.v1')
    const index = JSON.parse(await readFile(indexPath, 'utf8'))
    const pack = await readFile(packPath)
    await chmod(indexPath, 0o600)
    await chmod(packPath, 0o600)
    if (mutation === 'missing-pack') await rm(packPath)
    else if (mutation === 'missing-index') await rm(indexPath)
    else if (mutation === 'bad-schema') await writeFile(indexPath, `${JSON.stringify({ ...index, schema: 'modly.bad.v1' })}\n`)
    else if (mutation === 'wrong-state-sha') await writeFile(indexPath, `${JSON.stringify({ ...index, stateSha256: '0'.repeat(64) })}\n`)
    else if (mutation === 'wrong-pack-sha') await writeFile(indexPath, `${JSON.stringify({ ...index, pack: { ...index.pack, sha256: '0'.repeat(64) } })}\n`)
    else if (mutation === 'trailing-bytes') {
      await writeFile(packPath, Buffer.concat([pack, Buffer.from('x')]))
    } else if (mutation === 'gap') {
      index.entries[0].offset = 1
      await writeFile(indexPath, `${JSON.stringify(index)}\n`)
    } else {
      await mkdir(join(backupRoot, 'transactions'))
    }
    const listed = await createRepository(root).list()
    assert.equal(listed.ok, true, mutation)
    if (listed.ok) assert.equal(listed.value.projects.find((entry) => entry.projectKey === PROJECT_KEY_A)?.status, 'corrupt', mutation)
    const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
    assert.equal(opened.ok, false, mutation)
    if (!opened.ok) assert.deepEqual({ code: opened.error.code, retryable: opened.error.retryable }, { code: 'recovery_failed', retryable: true }, mutation)
  }
})

test('backup layout classifier rejects every partial or mixed packed marker combination', async (t) => {
  const cases = ['legacy-pack-only', 'legacy-index-only', 'legacy-both-markers', 'packed-transactions-file', 'pack-directory', 'index-directory'] as const
  for (const mutation of cases) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-layout-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    let snapshot = assertCreated(await repository.create({ name: 'Layout', initialSceneName: 'Scene' })).snapshot
    const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:layout-first-${mutation}`, 'Revision 1') })
    assert.equal(first.ok, true)
    if (!first.ok) continue
    snapshot = first.value.snapshot
    const second = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:layout-second-${mutation}`, 'Revision 2') })
    assert.equal(second.ok, true)
    if (!second.ok) continue
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
    const backupRoot = join(projectRoot, state.lastValidBackup)
    if (mutation.startsWith('legacy-')) await convertPackedBackupToLegacy(backupRoot)
    if (mutation === 'legacy-pack-only' || mutation === 'legacy-both-markers') await writeFile(join(backupRoot, 'transactions.pack.v1'), Buffer.alloc(0))
    if (mutation === 'legacy-index-only' || mutation === 'legacy-both-markers') await writeFile(join(backupRoot, 'transactions.index.v1.json'), '{}\n')
    if (mutation === 'packed-transactions-file') await writeFile(join(backupRoot, 'transactions'), 'not a directory')
    if (mutation === 'pack-directory') { await rm(join(backupRoot, 'transactions.pack.v1')); await mkdir(join(backupRoot, 'transactions.pack.v1')) }
    if (mutation === 'index-directory') { await rm(join(backupRoot, 'transactions.index.v1.json')); await mkdir(join(backupRoot, 'transactions.index.v1.json')) }

    const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
    assert.equal(opened.ok, false, mutation)
    if (!opened.ok) assert.deepEqual({ code: opened.error.code, retryable: opened.error.retryable }, { code: 'recovery_failed', retryable: true }, mutation)
  }
})

test('packed backup pack and index symlinks are unsafe without legacy fallback', async (t) => {
  for (const mutation of ['pack-symlink', 'index-symlink'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-pack-symlink-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    let snapshot = assertCreated(await repository.create({ name: 'Pack symlink', initialSceneName: 'Scene' })).snapshot
    const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:symlink-first-${mutation}`, 'Revision 1') })
    assert.equal(first.ok, true)
    if (!first.ok) continue
    snapshot = first.value.snapshot
    const second = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:symlink-second-${mutation}`, 'Revision 2') })
    assert.equal(second.ok, true)
    if (!second.ok) continue
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
    const backupRoot = join(projectRoot, state.lastValidBackup)
    const filename = mutation === 'pack-symlink' ? 'transactions.pack.v1' : 'transactions.index.v1.json'
    const target = join(root, `${mutation}-target`)
    await rename(join(backupRoot, filename), target)
    await symlink(target, join(backupRoot, filename))

    const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
    assert.equal(opened.ok, false, mutation)
    if (!opened.ok) assert.deepEqual({ code: opened.error.code, retryable: opened.error.retryable }, { code: 'unsafe_workspace', retryable: false }, mutation)
  }
})

test('packed backup verifier rejects post-open pack path replacement and read close failure', async (t) => {
  const cases = ['path-replacement', 'close-success-failure', 'body-failure-close-failure'] as const
  for (const mutation of cases) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-pack-read-${mutation}-`))
    let restoreOpen: () => void = () => undefined
    t.after(async () => {
      restoreOpen()
      await rm(root, { recursive: true, force: true })
    })
    const repository = createRepository(root)
    let snapshot = assertCreated(await repository.create({ name: 'Read settlement', initialSceneName: 'Scene' })).snapshot
    const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:read-first-${mutation}`, 'Revision 1') })
    assert.equal(first.ok, true)
    if (!first.ok) continue
    snapshot = first.value.snapshot
    const second = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:read-second-${mutation}`, 'Revision 2') })
    assert.equal(second.ok, true)
    if (!second.ok) continue
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
    const packPath = join(projectRoot, state.lastValidBackup, 'transactions.pack.v1')
    const originalOpen = fsPromises.open
    let armed = true
    restoreOpen = replaceBuiltinOpen((async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      if (typeof path === 'string' && path === packPath && flags !== 'wx') {
        const firstHit = armed
        if (armed) armed = false
        if (mutation === 'path-replacement') {
          if (firstHit) {
            await rename(packPath, `${packPath}.old-opened`)
            await writeFile(packPath, '{}\n')
          }
        }
        if (mutation === 'body-failure-close-failure' && firstHit) {
          await chmod(packPath, 0o600)
          await writeFile(packPath, '{}\n')
        }
        if (mutation !== 'path-replacement') {
          return new Proxy(handle, {
            get(target, property, receiver) {
              if (property === 'close') return async () => {
                await target.close()
                throw new Error(`injected read close failure: ${mutation}`)
              }
              const value = Reflect.get(target, property, receiver) as unknown
              return typeof value === 'function' ? value.bind(target) : value
            },
          }) as typeof handle
        }
      }
      return handle
    }) as OpenFunction)

    const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
    assert.equal(opened.ok, false, mutation)
    if (!opened.ok) assert.deepEqual({ code: opened.error.code, retryable: opened.error.retryable }, { code: 'recovery_failed', retryable: true }, mutation)
    restoreOpen()
  }
})

test('legacy backup fixture opens recovers and retries with independent primary receipts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-legacy-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  let snapshot = assertCreated(await repository.create({ name: 'Legacy backup', initialSceneName: 'Scene' })).snapshot
  const firstBatch = renameBatch(snapshot, 'tx:legacy-first', 'Revision 1')
  const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: firstBatch })
  assert.equal(first.ok, true)
  if (!first.ok) return
  snapshot = first.value.snapshot
  const second = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:legacy-second', 'Revision 2') })
  assert.equal(second.ok, true)
  if (!second.ok) return
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  const backupRoot = join(projectRoot, state.lastValidBackup)
  await convertPackedBackupToLegacy(backupRoot)
  const legacyState = JSON.parse(await readFile(join(backupRoot, 'state.v1.json'), 'utf8'))
  const legacyResult = join(backupRoot, 'transactions', legacyState.transactions[0].transactionDigest, 'after', 'result.v1.json')
  const legacyBytes = await readFile(legacyResult)
  await rm(join(projectRoot, '.modly', 'transactions', legacyState.transactions[0].transactionDigest, 'after', 'result.v1.json'), { force: true })
  await writeFile(join(projectRoot, 'project.world-project.json'), '{corrupt')
  const opened = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
  assert.equal(opened.snapshot.project.revision, 1)
  const primaryResult = join(projectRoot, '.modly', 'transactions', legacyState.transactions[0].transactionDigest, 'after', 'result.v1.json')
  assert.deepEqual(await readFile(primaryResult), legacyBytes)
  await chmod(legacyResult, 0o600)
  await writeFile(legacyResult, '{}\n')
  assert.deepEqual(await readFile(primaryResult), legacyBytes)
  const retried = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch: firstBatch })
  assert.equal(retried.ok, true)
  if (retried.ok) assert.equal(retried.value.idempotent, true)
})

test('first backup with an empty ledger publishes exact empty transaction pack', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-empty-pack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const snapshot = assertCreated(await repository.create({ name: 'Empty ledger', initialSceneName: 'Scene' })).snapshot
  const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:first-empty-backup') })
  assert.equal(applied.ok, true)
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const state = JSON.parse(await readFile(join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  const backupRoot = join(projectRoot, state.lastValidBackup)
  const pack = await readFile(join(backupRoot, 'transactions.pack.v1'))
  const index = JSON.parse(await readFile(join(backupRoot, 'transactions.index.v1.json'), 'utf8'))
  assert.equal(pack.byteLength, 0)
  assert.equal(index.pack.byteLength, 0)
  assert.equal(index.pack.sha256, sha256Bytes(Buffer.alloc(0)))
  assert.deepEqual(index.entries, [])
  assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
})

test('backup pruning keeps retained packs and indexes while removing unretained backup directories', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-pack-prune-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  let snapshot = assertCreated(await repository.create({ name: 'Prune', initialSceneName: 'Scene' })).snapshot
  for (let index = 0; index < 12; index += 1) {
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:prune-${index}`, `Prune ${index}`) })
    assert.equal(applied.ok, true, `revision ${index + 1}`)
    if (!applied.ok) return
    snapshot = applied.value.snapshot
  }
  const backupsRoot = join(root, 'Worlds', PROJECT_KEY_A, '.modly', 'backups')
  const backupNames = (await readdir(backupsRoot)).sort((left, right) => Number(left.slice(0, left.indexOf('-'))) - Number(right.slice(0, right.indexOf('-'))))
  assert.deepEqual(backupNames.map((name) => Number(name.slice(0, name.indexOf('-')))), [4, 5, 6, 7, 8, 9, 10, 11])
  for (const name of backupNames) {
    assert.equal((await lstat(join(backupsRoot, name))).isDirectory(), true)
    assert.equal((await lstat(join(backupsRoot, name, 'transactions.pack.v1'))).isFile(), true)
    assert.equal((await lstat(join(backupsRoot, name, 'transactions.index.v1.json'))).isFile(), true)
  }
})

test('scene removal persists and recovery never resurrects an unreferenced scene', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-remove-scene-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const created = assertCreated(await repository.create({ name: 'Scenes', initialSceneName: 'One' }))
  const secondKey = 'scene-fedcba9876543210fedcba9876543210'
  const secondPath = `Worlds/${PROJECT_KEY_A}/scenes/${secondKey}.world-scene.json`
  const added = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: {
      schema: WORLD_COMMAND_BATCH_SCHEMA,
      transactionId: 'tx:add',
      projectId: created.snapshot.project.projectId,
      baseRevision: 0,
      origin: 'ui',
      commands: [{
        type: 'add-scene',
        reference: { id: 'scene:two', name: 'Two', documentPath: secondPath },
        scene: {
          schema: 'modly.world-scene.v1', projectId: created.snapshot.project.projectId,
          sceneId: 'scene:two', name: 'Two', environment: { backgroundColor: '#111111', ambientIntensity: 0.2 },
          entities: [], sequences: [],
        },
      }],
    },
  })
  assert.equal(added.ok, true)
  if (!added.ok) return
  const removed = await repository.applyCommands({
    projectKey: PROJECT_KEY_A,
    batch: {
      schema: WORLD_COMMAND_BATCH_SCHEMA,
      transactionId: 'tx:remove',
      projectId: created.snapshot.project.projectId,
      baseRevision: 1,
      origin: 'ui',
      commands: [{ type: 'remove-scene', sceneId: 'scene:two' }],
    },
  })
  assert.equal(removed.ok, true)
  const sceneFiles = await readdir(join(root, 'Worlds', PROJECT_KEY_A, 'scenes'))
  assert.equal(sceneFiles.includes(basename(secondPath)), false)
  assert.equal(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot.scenes.length, 1)
})

test('delete moves to trash, revision-checks, retries idempotently, and never deletes shared resources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-delete-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'Assets'), { recursive: true })
  await writeFile(join(root, 'Assets', 'shared.glb'), 'shared')
  const repository = createRepository(root)
  const created = assertCreated(await repository.create({ name: 'Delete', initialSceneName: 'Scene' }))

  const stale = await repository.delete({ projectKey: PROJECT_KEY_A, expectedRevision: 1, transactionId: 'tx:delete' })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'revision_conflict')
  const deleted = await repository.delete({ projectKey: PROJECT_KEY_A, expectedRevision: 0, transactionId: 'tx:delete' })
  assert.equal(deleted.ok, true)
  if (deleted.ok) assert.equal(deleted.value.idempotent, false)
  const retried = await createRepository(root).delete({ projectKey: PROJECT_KEY_A, expectedRevision: 0, transactionId: 'tx:delete' })
  assert.equal(retried.ok, true)
  if (retried.ok) assert.equal(retried.value.idempotent, true)
  assert.equal((await createRepository(root).open({ projectKey: PROJECT_KEY_A })).ok, false)
  assert.equal(await readFile(join(root, 'Assets', 'shared.glb'), 'utf8'), 'shared')
  assert.equal(created.snapshot.project.revision, 0)

  const receiptRoot = join(root, 'Worlds', '.trash', '.modly-delete-receipts')
  const [receiptName] = await readdir(receiptRoot)
  await writeFile(join(receiptRoot, receiptName), '{corrupt')
  const corruptReceipt = await createRepository(root).delete({
    projectKey: PROJECT_KEY_A, expectedRevision: 0, transactionId: 'tx:delete',
  })
  assert.equal(corruptReceipt.ok, false)
  if (!corruptReceipt.ok) assert.equal(corruptReceipt.error.code, 'recovery_failed')
})

test('delete rejects a prepared receipt whose canonical request disagrees with its lifecycle fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-delete-receipt-integrity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assertCreated(await createRepository(root).create({ name: 'Keep A', initialSceneName: 'Scene' }))
  assertCreated(await createRepository(root, {
    createProjectKey: () => PROJECT_KEY_B,
    createSceneKey: () => 'scene-fedcba9876543210fedcba9876543210',
  }).create({ name: 'Keep B', initialSceneName: 'Scene' }))
  const transactionId = 'tx:redirect-delete'
  const canonicalPayload = JSON.stringify({ expectedRevision: 0, projectKey: PROJECT_KEY_A, transactionId })
  const payloadSha256 = createHash('sha256').update(canonicalPayload).digest('hex')
  const receiptRoot = join(root, 'Worlds', '.trash', '.modly-delete-receipts')
  await mkdir(receiptRoot, { recursive: true })
  await writeFile(
    join(receiptRoot, `${createHash('sha256').update(transactionId).digest('hex')}.json`),
    JSON.stringify({
      schema: 'modly.world-delete-receipt.v1',
      transactionId,
      canonicalPayload,
      payloadSha256,
      projectKey: PROJECT_KEY_B,
      expectedRevision: 0,
      trashName: `${PROJECT_KEY_B}-${payloadSha256.slice(0, 16)}`,
      status: 'prepared',
    }),
  )

  const result = await createRepository(root).delete({
    projectKey: PROJECT_KEY_A,
    expectedRevision: 0,
    transactionId,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'recovery_failed')
  assert.equal((await createRepository(root).open({ projectKey: PROJECT_KEY_A })).ok, true)
  assert.equal((await createRepository(root).open({ projectKey: PROJECT_KEY_B })).ok, true)
})

// Kept local so the RED does not import a production type that does not exist yet.
type FineBackupRecord = Readonly<{
  schema: string; invocation: number; sequence: number; span: number; parent: number | null;
  phase: string; kind: string; edge: string; ns: string; ledgerIndex: number | null;
  appliedRevision: number | null; target: string; requestedBytes: number | null;
  completedBytes: number | null; sourceBytes: number | null; calls: number;
  outcome: string; durable: boolean | null;
}>

function fineObserverOptions(observer: (record: FineBackupRecord) => unknown) {
  return {
    now: () => new Date('2026-09-02T00:00:00.000Z'),
    backupCostObserver: (record: FineBackupRecord) => {
      return observer(record) as undefined
    },
  }
}

async function seedFineBackup(repository: WorldProjectRepository, mature = false) {
  let snapshot = assertCreated(await repository.create({ name: 'Fine backup', initialSceneName: 'Scene' })).snapshot
  const first = renameBatch(snapshot, 'tx:fine-seed-0')
  if (mature) first.commands = Array.from({ length: 100 }, (_, index) => ({
    type: 'add-entity' as const, sceneId: snapshot.project.startSceneId, entity: {
      id: `entity:fine-${index}`, name: `Light ${index}`, parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [index, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] },
      components: [{ id: `component:fine-${index}`, type: 'light' as const, enabled: true, lightKind: 'point' as const, color: '#ffffff', intensity: 2, range: 15, castShadow: false }],
    },
  }))
  for (let index = 0; index < (mature ? 32 : 1); index += 1) {
    const result = await repository.applyCommands({ projectKey: PROJECT_KEY_A,
      batch: index === 0 ? first : renameBatch(snapshot, `tx:fine-seed-${index}`, `Fine ${index}`) })
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('Fine backup setup did not commit')
    snapshot = result.value.snapshot
  }
  return snapshot
}

function assertFineGrammar(records: readonly FineBackupRecord[]) {
  assert.ok(records.length > 0, 'Original createBackup must deliver diagnostic records')
  assert.ok(records.length <= 8192)
  let previousNs = 0n
  const keys = ['schema', 'invocation', 'sequence', 'span', 'parent', 'phase', 'kind', 'edge', 'ns', 'ledgerIndex', 'appliedRevision', 'target', 'requestedBytes', 'completedBytes', 'sourceBytes', 'calls', 'outcome', 'durable'].sort()
  for (const [index, record] of records.entries()) {
    assert.equal(Object.isFrozen(record), true)
    assert.deepEqual(Object.keys(record).sort(), keys)
    assert.equal(record.schema, 'modly.world-backup-cost.v1')
    assert.equal(record.sequence, index + 1)
    assert.equal(record.invocation, records[0].invocation)
    assert.match(record.ns, /^\d+$/)
    assert.ok(BigInt(record.ns) >= previousNs)
    previousNs = BigInt(record.ns)
    for (const value of Object.values(record)) assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value))
    for (const field of ['requestedBytes', 'completedBytes', 'sourceBytes', 'calls'] as const) {
      assert.ok(record[field] === null || (Number.isSafeInteger(record[field]) && record[field]! >= 0))
    }
  }
  const faults = records.filter((record) => record.kind === 'observer-fault')
  assert.ok(faults.length <= 1)
  const terminalFault = faults[0]
  if (terminalFault) {
    assert.equal(records.indexOf(terminalFault), records.length - 1)
    assert.equal(terminalFault.span, 0)
    assert.equal(terminalFault.parent, null)
    assert.equal(terminalFault.edge, 'settled')
    assert.equal(terminalFault.outcome, 'rejected')
    assert.equal(terminalFault.calls, 0)
  }
  const ordinaryRecords = terminalFault ? records.slice(0, -1) : records
  const pending = new Map<number, FineBackupRecord>()
  for (const record of ordinaryRecords) {
    if (record.edge === 'begin') {
      assert.equal(pending.has(record.span), false)
      if (record.parent !== null) assert.equal(pending.has(record.parent), true)
      pending.set(record.span, record)
      assert.equal(record.outcome, 'pending')
    } else {
      const start = pending.get(record.span)
      assert.ok(start, 'Settlement must pair an original begin')
      for (const field of ['phase', 'kind', 'parent', 'target', 'ledgerIndex', 'appliedRevision'] as const) assert.equal(record[field], start[field])
      pending.delete(record.span)
      assert.ok(['fulfilled', 'rejected'].includes(record.outcome))
    }
  }
  assert.equal(pending.size, 0)
  const rootSettlement = ordinaryRecords.at(-1)
  assert.equal(rootSettlement?.kind, 'envelope')
  assert.equal(rootSettlement?.edge, 'settled')
  assert.equal(rootSettlement?.parent, null)
  if (terminalFault) assert.ok(terminalFault.sequence > rootSettlement!.sequence)
}

test('backup fine observer reuses sealed source proofs for mature H32/100entities with unchanged physical work', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-fine-mature-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const records: FineBackupRecord[] = []
  let armed = false
  const repository = createRepository(root, fineObserverOptions((record) => { if (armed) records.push(record) }))
  const snapshot = await seedFineBackup(repository, true)
  const sources = await retainedTransactionBytes(root)
  armed = true
  const result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:fine-mature', 'Measured') })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.snapshot.scenes[0].entities.length, 100)
  assert.deepEqual(result.value.inverse.snapshot, snapshot)
  assertFineGrammar(records)
  const settled = records.filter((record) => record.edge === 'settled')
  const count = (kind: string) => settled.filter((record) => record.kind === kind).length
  assert.equal(count('bounded-read'), 39, '3 prior documents + 32 prior receipts + 3 copies + one primary tail receipt')
  assert.equal(count('file-sync'), 5)
  assert.equal(count('directory-sync'), 4)
  assert.equal(count('write-file'), 4)
  for (const phase of ['prior-proof', 'pack-ledger']) {
    const scoped = records.filter((record) => record.phase === phase)
    assert.equal(countFine(scoped, 'cache-hit'), 32, `${phase}: all freshly read receipts reuse exact owned proofs`)
    assert.equal(countFine(scoped, 'replay'), 0, `${phase}: no duplicate semantic replay`)
  }
  const writes = settled.filter((record) => record.kind === 'write-positional')
  assert.equal(writes.length, 32)
  assert.deepEqual(writes.map((record) => record.ledgerIndex), Array.from({ length: 32 }, (_, index) => index))
  assert.deepEqual(writes.map((record) => record.appliedRevision), Array.from({ length: 32 }, (_, index) => index + 1))
  assert.equal(writes.reduce((sum, record) => sum + record.completedBytes!, 0), [...sources.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0))
  for (const kind of ['utf8-decode', 'json-parse', 'validate', 'canonical-encode', 'encode-buffer', 'hash', 'copy', 'proof-lookup']) assert.ok(count(kind) > 0, kind)
  assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, result.value.snapshot)
})

test('backup fine observer holds original read write and file directory sync settlement', { timeout: 170_000 }, async (t) => {
  for (const held of ['read', 'writeFile', 'file-sync', 'directory-sync'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-fine-hold-${held}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const records: FineBackupRecord[] = []
    let armed = false, hit = false, returned = false, release = () => {}, signal = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { signal = resolve })
    const repository = createRepository(root, { ...fineObserverOptions((record) => { if (armed) records.push(record) }),
      failureCheckpoint: (stage: string) => { if (stage === 'after-package') armed = true } })
    const snapshot = await seedFineBackup(repository)
    records.length = 0
    armed = false
    const originalOpen = fsPromises.open
    const restore = replaceBuiltinOpen((async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      const name = String(path).replaceAll('\\', '/')
      const backup = name.includes('/.modly/backups/1-')
      const directory = (await handle.stat()).isDirectory()
      return new Proxy(handle, { get(target, property) {
        const value = Reflect.get(target, property, target)
        const selected = held === 'read' ? property === 'read' && !directory && !backup
          : held === 'writeFile' ? property === 'writeFile' && backup
          : property === 'sync' && backup && directory === (held === 'directory-sync')
        if (selected && typeof value === 'function') return async (...args: unknown[]) => {
          if (armed && !hit) { hit = true; signal(); await gate }
          return value.apply(target, args)
        }
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }) as OpenFunction)
    const pending = repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, `tx:fine-hold-${held}`) }).then((value) => { returned = true; return value })
    try {
      await waitForBoundedSignal(entered, `Original ${held} was not held`)
      assert.equal(returned, false)
      const kind = held === 'read' ? 'read-await' : held === 'writeFile' ? 'write-file' : held
      assert.ok(records.some((record) => record.kind === kind && record.edge === 'begin'), 'Held original must have a begin record')
      release()
      assert.equal((await pending).ok, true)
      assertFineGrammar(records)
    } finally {
      release()
      try { await pending } finally { restore() }
    }
  }
})

test('backup fine observer preserves original body sync close and falsy faults', { timeout: 170_000 }, async (t) => {
  for (const fault of ['body', 'sync', 'close', 'body-close', 'zero', 'null', 'undefined', 'directory-false'] as const) {
    const lanes: Array<{ result: unknown; captured: unknown; calls: string[] }> = []
    for (const observed of [false, true]) {
      const root = await mkdtemp(join(tmpdir(), 'modly-world-fine-fault-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const records: FineBackupRecord[] = []
      let armed = false, captured: unknown
      const calls: string[] = []
      const repository = createRepository(root, { ...(observed ? fineObserverOptions((record) => { if (armed) records.push(record) }) : {}),
        failureCheckpoint: (stage) => { if (stage === 'after-package') armed = true },
        ...(fault === 'directory-false' ? { syncDirectory: async (directory: string) => {
          const value = await syncDirectoryForTest(directory)
          if (directory.replaceAll('\\', '/').includes('/.modly/backups/1-')) {
            calls.push('directory-sync:false')
            return false
          }
          return value
        } } : {}) })
      const snapshot = await seedFineBackup(repository)
      records.length = 0
      calls.length = 0
      armed = false
      const body = new Error('synthetic body'), closing = new Error('synthetic close')
      const originalOpen = fsPromises.open
      const restore = replaceBuiltinOpen((async (path, flags, mode) => {
        const handle = await originalOpen(path, flags, mode)
        if (!String(path).replaceAll('\\', '/').includes('/.modly/backups/1-') || !String(path).endsWith('transactions.pack.v1') || flags !== 'wx') return handle
        return new Proxy(handle, { get(target, property) {
          const value = Reflect.get(target, property, target)
          if (property === 'write' && ['body', 'body-close', 'zero', 'null', 'undefined'].includes(fault)) return async () => {
            calls.push(`write:${fault}`)
            throw fault === 'zero' ? 0 : fault === 'null' ? null : fault === 'undefined' ? undefined : body
          }
          if (property === 'sync' && fault === 'sync') return async () => { calls.push('sync:body'); throw body }
          if (property === 'close' && ['close', 'body-close'].includes(fault)) return async () => {
            calls.push(`close:${fault}`); await target.close(); throw closing
          }
          return typeof value === 'function' ? value.bind(target) : value
        } })
      }) as OpenFunction)
      const callable = repository as unknown as { createBackup: (...args: unknown[]) => Promise<boolean> }
      const originalBackup = callable.createBackup.bind(repository)
      t.mock.method(callable, 'createBackup', async (...args: unknown[]) => {
        try { return await originalBackup(...args) } catch (error) { captured = error; throw error }
      })
      let result: Awaited<ReturnType<WorldProjectRepository['applyCommands']>>
      try { result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:fine-fault') }) } finally { restore() }
      if (['body', 'body-close', 'sync'].includes(fault)) assert.equal(captured, body)
      if (fault === 'close') assert.equal(captured, closing)
      if (observed) assertFineGrammar(records)
      const capturedContract = captured === body ? 'body'
        : captured === closing ? 'closing'
        : captured instanceof Error ? { name: captured.name, message: captured.message, code: (captured as NodeJS.ErrnoException & { code?: string }).code ?? null }
        : { type: typeof captured, value: captured }
      lanes.push({ result, captured: capturedContract, calls })
    }
    assert.deepEqual(lanes[1].result, lanes[0].result, `${fault} public result`)
    assert.deepEqual(lanes[1].calls, lanes[0].calls, `${fault} original call order`)
    assert.deepEqual(lanes[1].captured, lanes[0].captured, `${fault} final captured fault`)
  }
})

test('backup fine observer contains throwing malformed late concurrent observers', { timeout: 170_000 }, async (t) => {
  for (const behavior of ['throw', 'thenable', 'getter', 'async-rejection', 'late'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'modly-world-fine-observer-fault-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const records: FineBackupRecord[] = []
    let armed = false, returned = false
    const repository = createRepository(root, fineObserverOptions((record) => {
      if (!armed) return
      assert.equal(returned, false, 'No retired context may deliver later records')
      records.push(record)
      if (behavior === 'throw') throw new Error('synthetic observer failure')
      if (behavior === 'thenable') return { then(_resolve: () => void, reject: (reason: unknown) => void) { reject(new Error('synthetic rejection')) } }
      if (behavior === 'getter') return Object.defineProperty({}, 'then', { get() { throw new Error('synthetic getter') } })
      if (behavior === 'async-rejection') return Promise.reject(new Error('synthetic promise'))
      if (behavior === 'late') queueMicrotask(() => { assert.equal(Object.isFrozen(record), true) })
    }))
    const snapshot = await seedFineBackup(repository)
    armed = true
    const result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:fine-observer-fault') })
    returned = true
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(result.ok, true)
    assertFineGrammar(records)
    assert.equal(records.filter((record) => record.kind === 'observer-fault').length, behavior === 'late' ? 0 : 1)
  }

  const roots = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), 'modly-world-fine-concurrent-'))))
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))
  const records: FineBackupRecord[] = []
  const retired = new Set<number>()
  const late: number[] = []
  let workspace = roots[0], armed = false
  const repository = createRepository(roots[0], {
    ...fineObserverOptions((record) => {
      if (!armed) return
      if (retired.has(record.invocation)) late.push(record.invocation)
      records.push(record)
    }),
    getWorkspaceRoot: () => workspace,
  })
  const first = await seedFineBackup(repository)
  workspace = roots[1]
  const second = await seedFineBackup(repository)
  records.length = 0
  armed = true
  let release = () => {}, signal = () => {}, held = false
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { signal = resolve })
  const originalOpen = fsPromises.open
  const restore = replaceBuiltinOpen((async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode)
    if (!String(path).startsWith(roots[0])) return handle
    return new Proxy(handle, { get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property === 'read' && typeof value === 'function') return async (...args: unknown[]) => {
        if (!held) { held = true; signal(); await gate }
        return value.apply(target, args)
      }
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }) as OpenFunction)
  workspace = roots[0]
  const firstPending = repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(first, 'tx:fine-concurrent-first') })
  try {
    await waitForBoundedSignal(entered, 'First operation did not hold an original read')
    workspace = roots[1]
    const secondResult = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(second, 'tx:fine-concurrent-second') })
    assert.equal(secondResult.ok, true)
    const completed = [...new Set(records.filter((record) => record.kind === 'envelope' && record.edge === 'settled').map((record) => record.invocation))]
    assert.equal(completed.length, 1, 'The independent second context settles while the first read remains held')
    retired.add(completed[0])
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(late, [])
    release()
    assert.equal((await firstPending).ok, true)
  } finally {
    release()
    try { await firstPending } finally { restore() }
  }
  const invocations = [...new Set(records.map((record) => record.invocation))]
  assert.equal(invocations.length, 2)
  for (const invocation of invocations) {
    const group = records.filter((record) => record.invocation === invocation)
    assertFineGrammar(group)
    retired.add(invocation)
  }
  const settledCount = records.length
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(records.length, settledCount)
  assert.deepEqual(late, [])
})

test('backup fine observer default disabled and observed bytes inverse tree equivalent', { timeout: 170_000 }, async (t) => {
  const lanes: { result: unknown; tree: unknown; calls: string[]; readWidth: number }[] = []
  const assertOriginalReadOrdering = (calls: readonly string[]): number => {
    const active = new Map<string, { stats: number; reads: number }>()
    let width = 0, maximumWidth = 0
    for (const call of calls) {
      if (call.startsWith('open:') && call.endsWith(':32768')) {
        const path = call.slice('open:'.length, -':32768'.length)
        assert.equal(active.has(path), false, `Overlapping identical logical read: ${path}`)
        active.set(path, { stats: 0, reads: 0 })
        width += 1
        maximumWidth = Math.max(maximumWidth, width)
        continue
      }
      for (const [path, state] of active) {
        if (call === `stat:${path}`) state.stats += 1
        if (call === `read:${path}`) state.reads += 1
        if (call === `close:${path}`) {
          assert.ok(state.stats > 0, `Logical read must stat before close: ${path}`)
          assert.ok(state.reads > 0, `Logical read must read before close: ${path}`)
          active.delete(path)
          width -= 1
          break
        }
      }
    }
    assert.equal(active.size, 0)
    assert.equal(width, 0)
    return maximumWidth
  }
  for (const observed of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'modly-world-fine-parity-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const records: FineBackupRecord[] = []
    const repository = createRepository(root, observed ? fineObserverOptions((record) => { records.push(record) }) : {})
    const snapshot = await seedFineBackup(repository)
    records.length = 0
    const calls: string[] = []
    const originalOpen = fsPromises.open
    const restore = replaceBuiltinOpen((async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      const name = String(path).replace(root, '').replace(/\.tmp-[a-f0-9]{24}/g, '.tmp-owned')
      calls.push(`open:${name}:${flags}`)
      return new Proxy(handle, { get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => { calls.push(`${String(property)}:${name}`); return value.apply(target, args) }
      } })
    }) as OpenFunction)
    let result: Awaited<ReturnType<WorldProjectRepository['applyCommands']>>
    try { result = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(snapshot, 'tx:fine-parity') }) } finally { restore() }
    assert.equal(result.ok, true)
    if (!result.ok) return
    if (observed) assertFineGrammar(records)
    else assert.deepEqual(records, [])
    assert.deepEqual(result.value.inverse.snapshot, snapshot)
    assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, result.value.snapshot)
    const readTree = async (path: string): Promise<unknown> => {
      const info = await lstat(path)
      if (info.isFile()) return { mode: info.mode & 0o777, bytes: (await readFile(path)).toString('base64') }
      assert.equal(info.isDirectory(), true)
      const entries: Record<string, unknown> = {}
      for (const entry of (await readdir(path)).sort()) entries[entry] = await readTree(join(path, entry))
      return { mode: info.mode & 0o777, entries }
    }
    lanes.push({ result, tree: await readTree(join(root, 'Worlds', PROJECT_KEY_A)), calls,
      readWidth: assertOriginalReadOrdering(calls) })
  }
  assert.deepEqual(lanes[1].result, lanes[0].result)
  assert.deepEqual(lanes[1].tree, lanes[0].tree)
  assert.equal(lanes[1].calls.length, lanes[0].calls.length)
  assert.deepEqual([...lanes[1].calls].sort(), [...lanes[0].calls].sort())
  assert.equal(lanes[1].readWidth, lanes[0].readWidth)
  assert.ok(lanes[0].readWidth >= 2 && lanes[0].readWidth <= 4)
})

// Private fixture schema: production keeps this storage detail out of shared/public DTOs.
type StoredCommandResultV2Fixture = {
  schema: 'modly.world-command-result.v2'
  transactionId: string
  newRevision: number
  changes: string[]
  warnings: string[]
  inverse: { kind: 'world-snapshot'; snapshot: WorldProjectSnapshotV1 }
}

function stableFixtureSerialize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableFixtureSerialize).join(',')}]`
  assert.equal(typeof value, 'object')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableFixtureSerialize(record[key])}`).join(',')}}`
}

function encodeFixtureJson(value: unknown): Buffer {
  return Buffer.from(`${stableFixtureSerialize(value)}\n`, 'utf8')
}

function assertStoredCommandResultV2(value: unknown): asserts value is StoredCommandResultV2Fixture {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const record = value as Record<string, unknown>
  assert.deepEqual(Object.keys(record).sort(), ['changes', 'inverse', 'newRevision', 'schema', 'transactionId', 'warnings'])
  assert.equal(record.schema, 'modly.world-command-result.v2')
  assert.equal(Object.hasOwn(record, 'snapshot'), false)
  assert.equal(typeof record.transactionId, 'string')
  assert.ok(Number.isSafeInteger(record.newRevision))
  assert.ok(Array.isArray(record.changes))
  assert.ok(Array.isArray(record.warnings))
  assert.ok(record.inverse && typeof record.inverse === 'object')
}

async function latestStoredReceipt(root: string) {
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const statePath = join(projectRoot, '.modly', 'state.v1.json')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    projectId: string; committedRevision: number; lastValidBackup: string | null; transactions: TestDurableTransaction[]
  }
  const transaction = state.transactions.at(-1)
  assert.ok(transaction)
  const resultPath = join(projectRoot, '.modly', 'transactions', transaction.transactionDigest, 'after', 'result.v1.json')
  const bytes = await readFile(resultPath)
  return { projectRoot, statePath, state, transaction, resultPath, bytes, value: JSON.parse(bytes.toString('utf8')) as unknown }
}

async function replaceLatestStoredReceipt(root: string, value: unknown): Promise<void> {
  const receipt = await latestStoredReceipt(root)
  const bytes = encodeFixtureJson(value)
  await chmod(receipt.resultPath, 0o600)
  await writeFile(receipt.resultPath, bytes)
  receipt.state.transactions.at(-1)!.resultSha256 = sha256Bytes(bytes)
  await chmod(receipt.statePath, 0o600)
  await writeFile(receipt.statePath, encodeFixtureJson(receipt.state))
}

async function readPackedStoredResults(backupRoot: string): Promise<Array<{ bytes: Buffer; value: unknown }>> {
  const index = JSON.parse(await readFile(join(backupRoot, 'transactions.index.v1.json'), 'utf8'))
  const pack = await readFile(join(backupRoot, 'transactions.pack.v1'))
  return index.entries.map((entry: { offset: number; length: number }) => {
    const bytes = Buffer.from(pack.subarray(entry.offset, entry.offset + entry.length))
    return { bytes, value: JSON.parse(bytes.toString('utf8')) as unknown }
  })
}

test('stored command result v2 writes compact primary receipts and preserves exact public retries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-result-v2-primary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const initial = assertCreated(await repository.create({ name: 'Stored v2 primary', initialSceneName: 'Scene' })).snapshot
  const batch = componentBatch(initial, 'tx:stored-v2-primary')
  const preview = await repository.previewCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(preview.ok, true)
  if (!preview.ok) return
  const expected = structuredClone(preview.value)
  const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(applied.ok, true)
  if (!applied.ok) return
  assert.deepEqual(applied.value, expected)
  assert.deepEqual(applied.value.inverse.snapshot, initial)

  const receipt = await latestStoredReceipt(root)
  assertStoredCommandResultV2(receipt.value)
  assert.equal(receipt.value.transactionId, batch.transactionId)
  assert.equal(receipt.value.newRevision, 1)
  assert.deepEqual(receipt.value.inverse, expected.inverse)
  assert.deepEqual(receipt.value.changes, expected.changes)
  assert.deepEqual(receipt.value.warnings, expected.warnings)
  assert.equal(sha256Bytes(receipt.bytes), expected.receipt.resultSha256)
  assert.equal(receipt.transaction.resultSha256, expected.receipt.resultSha256)

  const stable = await fingerprintTree(receipt.projectRoot)
  const expectedRetry = { ...expected, idempotent: true, warnings: [...expected.warnings, 'transaction-idempotent'].sort() }
  for (const reader of [repository, createRepository(root)]) {
    const retried = await reader.applyCommands({ projectKey: PROJECT_KEY_A, batch: structuredClone(batch) })
    assert.equal(retried.ok, true)
    if (retried.ok) assert.deepEqual(retried.value, expectedRetry)
  }
  assert.deepEqual(await fingerprintTree(receipt.projectRoot), stable)
  assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, expected.snapshot)
})

test('stored command result v2 survives packed backup recovery undo redo reuse and pruning with default sync', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-result-v2-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const initial = assertCreated(await repository.create({ name: 'Stored v2 lifecycle', initialSceneName: 'Scene' })).snapshot
  const firstBatch = componentBatch(initial, 'tx:stored-v2-first')
  const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: firstBatch })
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.deepEqual(first.value.warnings, [])
  const secondName = 'Stored v2 forward'
  const second = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(first.value.snapshot, 'tx:stored-v2-second', secondName) })
  assert.equal(second.ok, true)
  if (!second.ok) return

  const undoBatch = { ...renameBatch(second.value.snapshot, 'tx:stored-v2-undo', initial.project.name), origin: 'undo' as const }
  const undone = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: undoBatch })
  assert.equal(undone.ok, true)
  if (!undone.ok) return
  assert.equal(undone.value.snapshot.project.name, initial.project.name)
  const redoBatch = { ...renameBatch(undone.value.snapshot, 'tx:stored-v2-redo', secondName), origin: 'redo' as const }
  const redone = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: redoBatch })
  assert.equal(redone.ok, true)
  if (!redone.ok) return
  assert.equal(redone.value.snapshot.project.name, secondName)
  const exactRetry = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch: redoBatch })
  assert.equal(exactRetry.ok && exactRetry.value.idempotent, true)
  const reuse = await repository.applyCommands({ projectKey: PROJECT_KEY_A,
    batch: { ...redoBatch, commands: [{ type: 'rename-project', name: 'Different reuse' }] } })
  assert.equal(reuse.ok, false)
  if (!reuse.ok) assert.equal(reuse.error.code, 'transaction_reuse')

  let snapshot = redone.value.snapshot
  let finalBatch = renameBatch(snapshot, 'tx:stored-v2-prune-0')
  for (let index = 0; index < 8; index += 1) {
    finalBatch = renameBatch(snapshot, `tx:stored-v2-prune-${index}`, `Stored v2 prune ${index}`)
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: finalBatch })
    assert.equal(applied.ok, true)
    if (!applied.ok) return
    assert.deepEqual(applied.value.warnings, [])
    snapshot = applied.value.snapshot
  }
  assert.equal(snapshot.project.revision, 12)
  assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, snapshot)

  const receipt = await latestStoredReceipt(root)
  assertStoredCommandResultV2(receipt.value)
  const backupNames = (await readdir(join(receipt.projectRoot, '.modly', 'backups')))
    .sort((left, right) => Number(left.slice(0, left.indexOf('-'))) - Number(right.slice(0, right.indexOf('-'))))
  assert.deepEqual(backupNames.map((name) => Number(name.slice(0, name.indexOf('-')))), [4, 5, 6, 7, 8, 9, 10, 11])
  const backupRoot = join(receipt.projectRoot, receipt.state.lastValidBackup!)
  const packed = await readPackedStoredResults(backupRoot)
  assert.ok(packed.length > 0)
  for (const entry of packed) assertStoredCommandResultV2(entry.value)

  await writeFile(join(receipt.projectRoot, 'project.world-project.json'), '{corrupt')
  const recovered = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
  assert.equal(recovered.snapshot.project.revision, 11)
  const replayed = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch: finalBatch })
  assert.equal(replayed.ok, true)
  if (replayed.ok) {
    assert.equal(replayed.value.idempotent, false)
    assert.deepEqual(replayed.value.snapshot, snapshot)
  }
})

test('stored command result v2 keeps handcrafted legacy v1 primary and backup receipts unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-result-v2-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root)
  const initial = assertCreated(await repository.create({ name: 'Stored legacy receipt', initialSceneName: 'Scene' })).snapshot
  const firstBatch = componentBatch(initial, 'tx:stored-legacy-first')
  const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: firstBatch })
  assert.equal(first.ok, true)
  if (!first.ok) return
  const legacyValue = { schema: 'modly.world-command-result.v1', transactionId: firstBatch.transactionId,
    snapshot: first.value.snapshot, newRevision: first.value.newRevision, changes: first.value.changes,
    warnings: first.value.warnings, inverse: first.value.inverse }
  const legacyBytes = encodeFixtureJson(legacyValue)
  const receipt = await latestStoredReceipt(root)
  await chmod(receipt.resultPath, 0o600)
  await writeFile(receipt.resultPath, legacyBytes)
  receipt.state.transactions[0].resultSha256 = sha256Bytes(legacyBytes)
  await chmod(receipt.statePath, 0o600)
  await writeFile(receipt.statePath, encodeFixtureJson(receipt.state))
  assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, first.value.snapshot)

  const second = await repository.applyCommands({ projectKey: PROJECT_KEY_A,
    batch: renameBatch(first.value.snapshot, 'tx:stored-legacy-second', 'Legacy backup forward') })
  assert.equal(second.ok, true)
  if (!second.ok) return
  const current = await latestStoredReceipt(root)
  assert.deepEqual(await readFile(receipt.resultPath), legacyBytes, 'The primary v1 receipt is not rewritten')
  const backupRoot = join(current.projectRoot, current.state.lastValidBackup!)
  const packed = await readPackedStoredResults(backupRoot)
  assert.deepEqual(packed[0]?.bytes, legacyBytes, 'Backup packing copies the exact legacy v1 bytes')
  assert.deepEqual(packed[0]?.value, legacyValue)

  await writeFile(join(current.projectRoot, 'project.world-project.json'), '{corrupt')
  const recovered = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
  assert.deepEqual(recovered.snapshot, first.value.snapshot)
  assert.deepEqual(await readFile(receipt.resultPath), legacyBytes, 'Recovery restores exact legacy v1 bytes')
  const retry = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch: firstBatch })
  assert.equal(retry.ok && retry.value.idempotent, true)
  if (retry.ok) assert.deepEqual(retry.value.snapshot, first.value.snapshot)
})

test('stored command result v2 rejects corrupt primary and packed authorities with existing public codes', { timeout: 170_000 }, async (t) => {
  const primaryCases = ['missing-file', 'missing-field', 'mutated-inverse', 'canonical-payload', 'replay-mismatch',
    'invalid-changes', 'invalid-warnings', 'bad-sha', 'empty', 'truncated'] as const
  for (const mutation of primaryCases) await t.test(mutation, async () => {
    const root = await mkdtemp(join(tmpdir(), `modly-world-result-v2-corrupt-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    const initial = assertCreated(await repository.create({ name: 'Stored v2 corruption', initialSceneName: 'Scene' })).snapshot
    const batch = componentBatch(initial, `tx:stored-v2-corrupt-${mutation}`)
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(applied.ok, true)
    if (!applied.ok) return
    const receipt = await latestStoredReceipt(root)
    assertStoredCommandResultV2(receipt.value)
    if (mutation === 'missing-file') await rm(receipt.resultPath)
    else if (mutation === 'bad-sha') {
      await chmod(receipt.resultPath, 0o600)
      await writeFile(receipt.resultPath, Buffer.concat([receipt.bytes, Buffer.from(' ')]))
    } else if (mutation === 'empty' || mutation === 'truncated') {
      const bytes = Buffer.from(mutation === 'empty' ? '' : '{')
      await chmod(receipt.resultPath, 0o600)
      await writeFile(receipt.resultPath, bytes)
      receipt.state.transactions[0].resultSha256 = sha256Bytes(bytes)
      await chmod(receipt.statePath, 0o600)
      await writeFile(receipt.statePath, encodeFixtureJson(receipt.state))
    } else if (mutation === 'canonical-payload') {
      const transaction = receipt.state.transactions[0]
      const replacement = renameBatch(initial, batch.transactionId, 'Canonical authority changed')
      transaction.canonicalPayload = canonicalWorldCommandBatchPayload(replacement)
      transaction.payloadSha256 = sha256Bytes(transaction.canonicalPayload)
      const oldDigest = transaction.transactionDigest
      transaction.transactionDigest = sha256Bytes(`${transaction.transactionId}\n${transaction.canonicalPayload}`)
      await rename(join(receipt.projectRoot, '.modly', 'transactions', oldDigest),
        join(receipt.projectRoot, '.modly', 'transactions', transaction.transactionDigest))
      await chmod(receipt.statePath, 0o600)
      await writeFile(receipt.statePath, encodeFixtureJson(receipt.state))
    } else {
      const changed = structuredClone(receipt.value) as StoredCommandResultV2Fixture & Record<string, unknown>
      if (mutation === 'missing-field') delete (changed as Partial<StoredCommandResultV2Fixture>).inverse
      if (mutation === 'mutated-inverse') {
        changed.inverse.snapshot.project.projectId = 'project:foreign'
        for (const scene of changed.inverse.snapshot.scenes) scene.projectId = 'project:foreign'
      }
      if (mutation === 'replay-mismatch') changed.inverse.snapshot.scenes[0].entities.push(
        structuredClone(applied.value.snapshot.scenes[0].entities[0]),
      )
      if (mutation === 'invalid-changes') changed.changes.push(changed.changes[0])
      if (mutation === 'invalid-warnings') changed.warnings = ['z', 'a']
      await replaceLatestStoredReceipt(root, changed)
    }
    const recovered = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
    assert.equal(recovered.snapshot.project.revision, 0, mutation)
    const retried = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(retried.ok, true, mutation)
    if (retried.ok) assert.equal(retried.value.idempotent, false, mutation)
  })

  await t.test('primary-symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modly-world-result-v2-symlink-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    const initial = assertCreated(await repository.create({ name: 'Stored v2 symlink', initialSceneName: 'Scene' })).snapshot
    assert.equal((await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(initial, 'tx:stored-v2-symlink') })).ok, true)
    const receipt = await latestStoredReceipt(root)
    assertStoredCommandResultV2(receipt.value)
    const outside = join(root, 'outside-result.json')
    await rename(receipt.resultPath, outside)
    await symlink(outside, receipt.resultPath)
    const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
    assert.equal(opened.ok, false)
    if (!opened.ok) assert.deepEqual({ code: opened.error.code, retryable: opened.error.retryable }, { code: 'unsafe_workspace', retryable: false })
  })

  await t.test('mixed-packed-layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modly-world-result-v2-mixed-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    const initial = assertCreated(await repository.create({ name: 'Stored v2 mixed', initialSceneName: 'Scene' })).snapshot
    const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(initial, 'tx:stored-v2-mixed-first') })
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal((await repository.applyCommands({ projectKey: PROJECT_KEY_A,
      batch: renameBatch(first.value.snapshot, 'tx:stored-v2-mixed-second') })).ok, true)
    const receipt = await latestStoredReceipt(root)
    assertStoredCommandResultV2(receipt.value)
    await mkdir(join(receipt.projectRoot, receipt.state.lastValidBackup!, 'transactions'))
    const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
    assert.equal(opened.ok, false)
    if (!opened.ok) assert.deepEqual({ code: opened.error.code, retryable: opened.error.retryable }, { code: 'recovery_failed', retryable: true })
  })

  for (const mutation of ['post-open-replacement', 'close-failure'] as const) await t.test(mutation, async () => {
    const root = await mkdtemp(join(tmpdir(), `modly-world-result-v2-pack-${mutation}-`))
    let restore: () => void = () => undefined
    t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
    const repository = createRepository(root)
    const initial = assertCreated(await repository.create({ name: 'Stored v2 settled pack', initialSceneName: 'Scene' })).snapshot
    const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: renameBatch(initial, `tx:stored-v2-pack-first-${mutation}`) })
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal((await repository.applyCommands({ projectKey: PROJECT_KEY_A,
      batch: renameBatch(first.value.snapshot, `tx:stored-v2-pack-second-${mutation}`) })).ok, true)
    const receipt = await latestStoredReceipt(root)
    assertStoredCommandResultV2(receipt.value)
    const packPath = join(receipt.projectRoot, receipt.state.lastValidBackup!, 'transactions.pack.v1')
    const originalOpen = fsPromises.open
    let armed = true
    restore = replaceBuiltinOpen((async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      if (String(path) === packPath && flags !== 'wx') {
        if (mutation === 'post-open-replacement') {
          if (armed) {
            armed = false
            await rename(packPath, `${packPath}.opened`)
            await writeFile(packPath, '{}\n')
          }
        } else return new Proxy(handle, { get(target, property) {
          if (property === 'close') return async () => { await target.close(); throw new Error('synthetic v2 close failure') }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        } }) as typeof handle
      }
      return handle
    }) as OpenFunction)
    let opened: Awaited<ReturnType<WorldProjectRepository['open']>>
    try { opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A }) } finally { restore() }
    assert.equal(opened.ok, false)
    if (!opened.ok) assert.deepEqual({ code: opened.error.code, retryable: opened.error.retryable }, { code: 'recovery_failed', retryable: true })
  })
})

test('stored command result v2 preserves fine observer structure while reducing exact packed receipt bytes', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-result-v2-fine-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const records: FineBackupRecord[] = []
  let armed = false
  const repository = createRepository(root, fineObserverOptions((record) => { if (armed) records.push(record) }))
  let snapshot = assertCreated(await repository.create({ name: 'Stored v2 fine', initialSceneName: 'Scene' })).snapshot
  const publicByTransaction = new Map<string, WorldProjectCommandSuccess>()
  for (let index = 0; index < 32; index += 1) {
    const batch = index === 0 ? componentBatch(snapshot, 'tx:stored-v2-fine-0')
      : renameBatch(snapshot, `tx:stored-v2-fine-${index}`, `Stored v2 fine ${index}`)
    if (index === 0) {
      const command = batch.commands[0]
      assert.equal(command.type, 'add-entity')
      if (command.type === 'add-entity') command.entity = {
        ...command.entity,
        id: 'entity:fine-0',
        components: [],
      }
      batch.commands = Array.from({ length: 100 }, (_, entityIndex) => {
        const entity = structuredClone((batch.commands[0] as Extract<WorldCommandBatchV1['commands'][number], { type: 'add-entity' }>).entity)
        entity.id = `entity:fine-${entityIndex}`
        entity.name = `Fine ${entityIndex}`
        entity.transform.position = [entityIndex, 0, 0]
        return { type: 'add-entity' as const, sceneId: snapshot.project.startSceneId, entity }
      })
    }
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(applied.ok, true)
    if (!applied.ok) return
    publicByTransaction.set(batch.transactionId, structuredClone(applied.value))
    snapshot = applied.value.snapshot
  }
  const before = await latestStoredReceipt(root)
  assert.equal(before.state.transactions.length, 32)
  let v2Bytes = 0
  let hypotheticalV1Bytes = 0
  for (const transaction of before.state.transactions) {
    const bytes = await readFile(join(before.projectRoot, '.modly', 'transactions', transaction.transactionDigest, 'after', 'result.v1.json'))
    const stored = JSON.parse(bytes.toString('utf8')) as unknown
    assertStoredCommandResultV2(stored)
    const publicResult = publicByTransaction.get(transaction.transactionId)
    assert.ok(publicResult)
    v2Bytes += bytes.byteLength
    hypotheticalV1Bytes += encodeFixtureJson({ schema: 'modly.world-command-result.v1', transactionId: transaction.transactionId,
      snapshot: publicResult.snapshot, newRevision: publicResult.newRevision, changes: publicResult.changes,
      warnings: publicResult.warnings, inverse: publicResult.inverse }).byteLength
  }
  assert.ok(v2Bytes < hypotheticalV1Bytes, 'The exact stored v2 byte sum omits one redundant forward snapshot per receipt')

  armed = true
  const measured = await repository.applyCommands({ projectKey: PROJECT_KEY_A,
    batch: renameBatch(snapshot, 'tx:stored-v2-fine-measured', 'Stored v2 measured') })
  assert.equal(measured.ok, true)
  if (!measured.ok) return
  assert.deepEqual(measured.value.inverse.snapshot, snapshot)
  assertFineGrammar(records)
  const settled = records.filter((record) => record.edge === 'settled')
  const count = (kind: string) => settled.filter((record) => record.kind === kind).length
  assert.deepEqual({ boundedRead: count('bounded-read'), fileSync: count('file-sync'), directorySync: count('directory-sync'),
    writeFile: count('write-file'), writePositional: count('write-positional') },
	  { boundedRead: 39, fileSync: 5, directorySync: 4, writeFile: 4, writePositional: 32 })
  const writes = settled.filter((record) => record.kind === 'write-positional')
  assert.deepEqual(writes.map((record) => record.ledgerIndex), Array.from({ length: 32 }, (_, index) => index))
  assert.deepEqual(writes.map((record) => record.appliedRevision), Array.from({ length: 32 }, (_, index) => index + 1))
  assert.equal(writes.reduce((sum, record) => sum + record.completedBytes!, 0), v2Bytes)
  assert.deepEqual(assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A })).snapshot, measured.value.snapshot)
  const current = await latestStoredReceipt(root)
  assertStoredCommandResultV2(current.value)
  assert.equal(sha256Bytes(current.bytes), measured.value.receipt.resultSha256)
})

async function tamperPrimaryV2InverseName(root: string, transactionIndex: number, name: string): Promise<void> {
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const statePath = join(projectRoot, '.modly', 'state.v1.json')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    lastValidBackup: string | null; transactions: TestDurableTransaction[]
  }
  const transaction = state.transactions[transactionIndex]
  assert.ok(transaction)
  const resultPath = join(projectRoot, '.modly', 'transactions', transaction.transactionDigest, 'after', 'result.v1.json')
  const value = JSON.parse(await readFile(resultPath, 'utf8')) as unknown
  assertStoredCommandResultV2(value)
  value.inverse.snapshot.project.name = name
  const bytes = encodeFixtureJson(value)
  await chmod(resultPath, 0o600)
  await writeFile(resultPath, bytes)
  transaction.resultSha256 = sha256Bytes(bytes)
  state.lastValidBackup = null
  await chmod(statePath, 0o600)
  await writeFile(statePath, encodeFixtureJson(state))
}

async function tamperPackedV2InverseName(backupRoot: string, transactionIndex: number, name: string): Promise<void> {
  const statePath = join(backupRoot, 'state.v1.json')
  const indexPath = join(backupRoot, 'transactions.index.v1.json')
  const packPath = join(backupRoot, 'transactions.pack.v1')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { transactions: TestDurableTransaction[] }
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const pack = await readFile(packPath)
  const segments = index.entries.map((entry: { offset: number; length: number }) => (
    Buffer.from(pack.subarray(entry.offset, entry.offset + entry.length))
  ))
  const value = JSON.parse(segments[transactionIndex].toString('utf8')) as unknown
  assertStoredCommandResultV2(value)
  value.inverse.snapshot.project.name = name
  segments[transactionIndex] = encodeFixtureJson(value)
  const rebuilt = Buffer.concat(segments)
  let offset = 0
  for (const [entryIndex, entry] of index.entries.entries()) {
    entry.offset = offset
    entry.length = segments[entryIndex].byteLength
    if (entryIndex === transactionIndex) {
      entry.resultSha256 = sha256Bytes(segments[entryIndex])
      state.transactions[entryIndex].resultSha256 = entry.resultSha256
    }
    offset += entry.length
  }
  await chmod(statePath, 0o600)
  const stateBytes = encodeFixtureJson(state)
  await writeFile(statePath, stateBytes)
  index.stateSha256 = sha256Bytes(stateBytes)
  index.pack.byteLength = rebuilt.byteLength
  index.pack.sha256 = sha256Bytes(rebuilt)
  await chmod(packPath, 0o600)
  await writeFile(packPath, rebuilt)
  await chmod(indexPath, 0o600)
  await writeFile(indexPath, encodeFixtureJson(index))
}

test('stored command result v2 chain rejects adjacent retained snapshot and inverse mismatches', async (t) => {
  for (const layout of ['primary', 'packed-backup'] as const) await t.test(layout, async () => {
    const root = await mkdtemp(join(tmpdir(), `modly-world-result-v2-chain-adjacent-${layout}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    const initial = assertCreated(await repository.create({ name: 'Chain adjacent', initialSceneName: 'Scene' })).snapshot
    const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: componentBatch(initial, `tx:chain-adjacent-first-${layout}`) })
    assert.equal(first.ok, true)
    if (!first.ok) return
    const second = await repository.applyCommands({ projectKey: PROJECT_KEY_A,
      batch: renameBatch(first.value.snapshot, `tx:chain-adjacent-second-${layout}`, 'Chain adjacent second') })
    assert.equal(second.ok, true)
    if (!second.ok) return
    if (layout === 'primary') await tamperPrimaryV2InverseName(root, 0, 'Tampered prior')
    else {
      const third = await repository.applyCommands({ projectKey: PROJECT_KEY_A,
        batch: renameBatch(second.value.snapshot, 'tx:chain-adjacent-third-packed', 'Chain adjacent third') })
      assert.equal(third.ok, true)
      if (!third.ok) return
      const current = await latestStoredReceipt(root)
      await tamperPackedV2InverseName(join(current.projectRoot, current.state.lastValidBackup!), 0, 'Tampered prior')
    }
    const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
    assert.equal(opened.ok, false, layout)
    if (!opened.ok) assert.deepEqual({ code: opened.error.code, retryable: opened.error.retryable },
      { code: 'recovery_failed', retryable: true }, layout)
  })
})

test('stored command result v2 chain rejects latest replay snapshots that disagree with verified packages', async (t) => {
  for (const layout of ['primary', 'packed-backup'] as const) await t.test(layout, async () => {
    const root = await mkdtemp(join(tmpdir(), `modly-world-result-v2-chain-latest-${layout}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = createRepository(root)
    const initial = assertCreated(await repository.create({ name: 'Chain latest', initialSceneName: 'Scene' })).snapshot
    const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: componentBatch(initial, `tx:chain-latest-first-${layout}`) })
    assert.equal(first.ok, true)
    if (!first.ok) return
    if (layout === 'primary') await tamperPrimaryV2InverseName(root, 0, 'Tampered latest')
    else {
      const second = await repository.applyCommands({ projectKey: PROJECT_KEY_A,
        batch: renameBatch(first.value.snapshot, 'tx:chain-latest-second-packed', 'Chain latest second') })
      assert.equal(second.ok, true)
      if (!second.ok) return
      const current = await latestStoredReceipt(root)
      await tamperPackedV2InverseName(join(current.projectRoot, current.state.lastValidBackup!), 0, 'Tampered latest')
    }
    const opened = await createRepository(root).open({ projectKey: PROJECT_KEY_A })
    assert.equal(opened.ok, false, layout)
    if (!opened.ok) assert.deepEqual({ code: opened.error.code, retryable: opened.error.retryable },
      { code: 'recovery_failed', retryable: true }, layout)
  })
})

type StoredCommandResultV1Fixture = {
  schema: 'modly.world-command-result.v1'
  transactionId: string
  snapshot: WorldProjectSnapshotV1
  newRevision: number
  changes: string[]
  warnings: string[]
  inverse: { kind: 'world-snapshot'; snapshot: WorldProjectSnapshotV1 }
}

function assertStoredCommandResultV1(value: unknown): asserts value is StoredCommandResultV1Fixture {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const record = value as Record<string, unknown>
  assert.deepEqual(Object.keys(record).sort(), ['changes', 'inverse', 'newRevision', 'schema', 'snapshot', 'transactionId', 'warnings'])
  assert.equal(record.schema, 'modly.world-command-result.v1')
  assert.equal(typeof record.transactionId, 'string')
  assert.ok(Number.isSafeInteger(record.newRevision))
  assert.ok(Array.isArray(record.changes))
  assert.ok(Array.isArray(record.warnings))
  assert.ok(record.snapshot && typeof record.snapshot === 'object')
  assert.ok(record.inverse && typeof record.inverse === 'object')
}

test('diagnostic stored result schema keeps v2 for absent explicit and invalid constructor values', async (t) => {
  const lanes: Array<{ label: string; schema?: unknown }> = [
    { label: 'absent' },
    { label: 'explicit-v2', schema: 'v2' },
    { label: 'invalid-v3', schema: 'v3' },
    { label: 'invalid-null', schema: null },
    { label: 'invalid-zero', schema: 0 },
    { label: 'invalid-record', schema: {} },
  ]
  for (const lane of lanes) await t.test(lane.label, async () => {
    const root = await mkdtemp(join(tmpdir(), `modly-world-diagnostic-schema-${lane.label}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repository = lane.label === 'absent' ? createRepository(root) : createRepository(root, {
      diagnosticStoredResultSchema: lane.schema as never,
    })
    const initial = assertCreated(await repository.create({ name: lane.label, initialSceneName: 'Scene' })).snapshot
    const batch = componentBatch(initial, `tx:diagnostic-schema-${lane.label}`)
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
    assert.equal(applied.ok, true)
    if (!applied.ok) return
    const receipt = await latestStoredReceipt(root)
    assertStoredCommandResultV2(receipt.value)
    assert.equal(sha256Bytes(receipt.bytes), applied.value.receipt.resultSha256)
  })
})

test('diagnostic stored result schema writes exact legacy v1 receipts with public parity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-diagnostic-schema-v1-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root, { diagnosticStoredResultSchema: 'v1' })
  const initial = assertCreated(await repository.create({ name: 'Diagnostic v1', initialSceneName: 'Scene' })).snapshot
  const batch = componentBatch(initial, 'tx:diagnostic-schema-v1')
  const preview = await repository.previewCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(preview.ok, true)
  if (!preview.ok) return
  const applied = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch })
  assert.equal(applied.ok, true)
  if (!applied.ok) return
  assert.deepEqual(applied.value, preview.value)
  const receipt = await latestStoredReceipt(root)
  assertStoredCommandResultV1(receipt.value)
  const expectedStored: StoredCommandResultV1Fixture = {
    schema: 'modly.world-command-result.v1',
    transactionId: batch.transactionId,
    snapshot: applied.value.snapshot,
    newRevision: applied.value.newRevision,
    changes: applied.value.changes,
    warnings: applied.value.warnings,
    inverse: applied.value.inverse,
  }
  assert.deepEqual(receipt.value, expectedStored)
  assert.deepEqual(receipt.bytes, encodeFixtureJson(expectedStored))
  assert.equal(sha256Bytes(receipt.bytes), applied.value.receipt.resultSha256)
  assert.deepEqual(receipt.value.inverse.snapshot, initial)
})

test('diagnostic stored result schema reopens retries and packs an exact v1 chain', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-diagnostic-schema-v1-chain-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = createRepository(root, { diagnosticStoredResultSchema: 'v1' })
  const initial = assertCreated(await repository.create({ name: 'Diagnostic v1 chain', initialSceneName: 'Scene' })).snapshot
  const firstBatch = componentBatch(initial, 'tx:diagnostic-schema-v1-chain-first')
  const first = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: firstBatch })
  assert.equal(first.ok, true)
  if (!first.ok) return
  const secondBatch = renameBatch(first.value.snapshot, 'tx:diagnostic-schema-v1-chain-second', 'Diagnostic v1 second')
  const second = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: secondBatch })
  assert.equal(second.ok, true)
  if (!second.ok) return

  const current = await latestStoredReceipt(root)
  assertStoredCommandResultV1(current.value)
  assert.equal(current.state.transactions.length, 2)
  assert.ok(current.state.lastValidBackup)
  const packed = await readPackedStoredResults(join(current.projectRoot, current.state.lastValidBackup))
  assert.equal(packed.length, 1)
  assertStoredCommandResultV1(packed[0].value)
  assert.deepEqual(packed[0].value.snapshot, first.value.snapshot)
  assert.deepEqual(packed[0].value.inverse.snapshot, initial)
  assert.equal(sha256Bytes(packed[0].bytes), first.value.receipt.resultSha256)

  const reopened = createRepository(root)
  assert.deepEqual(assertOpened(await reopened.open({ projectKey: PROJECT_KEY_A })).snapshot, second.value.snapshot)
  const beforeRetry = await fingerprintTree(current.projectRoot)
  const retried = await reopened.applyCommands({ projectKey: PROJECT_KEY_A, batch: structuredClone(secondBatch) })
  assert.equal(retried.ok, true)
  if (!retried.ok) return
  assert.deepEqual(retried.value, {
    ...second.value,
    idempotent: true,
    warnings: [...second.value.warnings, 'transaction-idempotent'].sort(),
  })
  assert.deepEqual(await fingerprintTree(current.projectRoot), beforeRetry)
})
