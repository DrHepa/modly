import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsPromises, { chmod, cp, mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalWorldCommandBatchPayload, type WorldCommandBatchV1 } from '../../src/areas/worlds/core/worldCommands.ts'
import { WORLD_COMMAND_BATCH_SCHEMA, type WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { WorldProjectRepository } from './world-project-repository.ts'

const projectKey = 'world-0123456789abcdef0123456789abcdef'
const sceneKey = 'scene-0123456789abcdef0123456789abcdef'
const packName = 'transactions.pack.v1'
const indexName = 'transactions.index.v1.json'
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`)
type Open = typeof fsPromises.open
type Verify = (...args: unknown[]) => Promise<unknown>

function repository(root: string, options: Partial<ConstructorParameters<typeof WorldProjectRepository>[0]> = {}) {
  return new WorldProjectRepository({ getWorkspaceRoot: () => root, createProjectKey: () => projectKey, createSceneKey: () => sceneKey, ...options })
}
function batch(snapshot: WorldProjectSnapshotV1, id: string): WorldCommandBatchV1 {
  return { schema: WORLD_COMMAND_BATCH_SCHEMA, transactionId: id, projectId: snapshot.project.projectId,
    baseRevision: snapshot.project.revision, origin: 'ui', commands: [{ type: 'rename-project', name: id }] }
}
async function seed(repo: WorldProjectRepository, count = 2) {
  const created = await repo.create({ name: 'Bridge', initialSceneName: 'Scene' })
  assert.equal(created.ok, true)
  let snapshot = created.value.snapshot
  for (let index = 0; index < count; index += 1) {
    const applied = await repo.applyCommands({ projectKey, batch: batch(snapshot, `tx:seed-${index}`) })
    assert.equal(applied.ok, true)
    snapshot = applied.value.snapshot
  }
  return snapshot
}
function newBackup(root: string, request: WorldCommandBatchV1) {
  return join(root, 'Worlds', projectKey, '.modly/backups', `${request.baseRevision}-${sha(`${request.transactionId}\n${canonicalWorldCommandBatchPayload(request)}`)}`)
}
function replaceOpen(replacement: Open) {
  const original = fsPromises.open
  fsPromises.open = replacement
  syncBuiltinESMExports()
  return () => { fsPromises.open = original; syncBuiltinESMExports() }
}
async function writeMutable(path: string, bytes: Buffer) {
  await chmod(path, 0o600)
  await writeFile(path, bytes)
}
async function capturePrimary(root: string) {
  const projectRoot = join(root, 'Worlds', projectKey)
  const stateBytes = await readFile(join(projectRoot, '.modly/state.v1.json'))
  const state = JSON.parse(stateBytes.toString())
  const paths: string[] = ['.modly/state.v1.json', 'project.world-project.json',
    ...state.scenes.map((scene: { path: string }) => `scenes/${scene.path.split('/').at(-1)}`),
    ...state.transactions.map((tx: { transactionDigest: string }) => `.modly/transactions/${tx.transactionDigest}/after/result.v1.json`)]
  return new Map(await Promise.all(paths.map(async (path) => [join(projectRoot, path), await readFile(join(projectRoot, path))] as const)))
}
async function assertUnpublished(root: string, before: Map<string, Buffer>, stages: string[]) {
  for (const [path, bytes] of before) assert.deepEqual(await readFile(path), bytes, path)
  await assert.rejects(readFile(join(root, 'Worlds', projectKey, '.modly/journal.v1.json')), { code: 'ENOENT' })
  assert.equal(stages.some((stage) => /^(backup-created|journal-published|document-published:|state-published)/.test(stage)), false)
}

// Only the actual source-owned semantic/hash functions supply counts. Wrappers delimit a real verifier call.
async function coverage<T>(repo: WorldProjectRepository, target: string | null, action: () => Promise<T>, before?: () => Promise<void>) {
  const inspector = new Session()
  const observable = repo as unknown as { verifyBackupPackage: Verify }
  const original = observable.verifyBackupPackage
  const total = { semantic: 0, hash: 0 }
  let first: typeof total | undefined
  let observed = false
  const observedFunctions = new Set<string>()
  inspector.connect()
  const take = async () => {
    const result = await inspector.post('Profiler.takePreciseCoverage')
    const scripts = result.result.filter((entry) => entry.url === new URL('./world-project-repository.ts', import.meta.url).href)
    assert.equal(scripts.length, 1)
    const count = (name: string) => {
      const matches = scripts[0].functions.filter((fn) => fn.functionName === name)
      if (matches.length === 0) {
        assert.ok(observedFunctions.has(name), `An omitted zero delta requires prior real coverage for ${name}`)
        return 0
      }
      assert.equal(matches.length, 1, name)
      observedFunctions.add(name)
      return matches[0].ranges[0].count
    }
    const row = { semantic: count('verifyDurableResultSemantics'), hash: count('assertDurableResultHash') }
    total.semantic += row.semantic; total.hash += row.hash
    return row
  }
  try {
    await inspector.post('Profiler.enable')
    await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    await inspector.post('Profiler.takePreciseCoverage')
    observable.verifyBackupPackage = async function (...args) {
      if (observed || target === null || join(String(args[0]), String(args[2])) !== target) return original.apply(this, args)
      observed = true
      await before?.()
      await take()
      try { return await original.apply(this, args) } finally { first = await take() }
    }
    const value = await action()
    await take()
    if (target !== null) { assert.equal(observed, true); assert.ok(first) }
    return { value, first, total }
  } finally {
    observable.verifyBackupPackage = original
    try { await inspector.post('Profiler.stopPreciseCoverage') } finally { inspector.disconnect() }
  }
}

async function rewriteBackup(backup: string, mutate: (receipt: Record<string, any>, tx: Record<string, any>) => void) {
  const statePath = join(backup, 'state.v1.json')
  const indexPath = join(backup, indexName)
  const state = JSON.parse((await readFile(statePath)).toString())
  const index = JSON.parse((await readFile(indexPath)).toString())
  const oldPack = await readFile(join(backup, packName))
  const entries: Buffer[] = index.entries.map((entry: { offset: number; length: number }) => oldPack.subarray(entry.offset, entry.offset + entry.length))
  const receipt = JSON.parse(entries[0].toString())
  mutate(receipt, state.transactions[0])
  entries[0] = encode(receipt)
  const pack = Buffer.concat(entries)
  let offset = 0
  index.entries = index.entries.map((entry: Record<string, unknown>, i: number) => {
    state.transactions[i].resultSha256 = sha(entries[i])
    const tx = state.transactions[i]
    const result = { ...entry, transactionId: tx.transactionId, transactionDigest: tx.transactionDigest, resultSha256: tx.resultSha256, offset, length: entries[i].length }
    offset += entries[i].length
    return result
  })
  const stateBytes = encode(state)
  index.stateSha256 = sha(stateBytes)
  index.pack.byteLength = pack.length
  index.pack.sha256 = sha(pack)
  await writeMutable(statePath, stateBytes)
  await writeMutable(join(backup, packName), pack)
  await writeMutable(indexPath, encode(index))
  assert.equal(sha((await readFile(join(backup, packName))).subarray(0, entries[0].length)), state.transactions[0].resultSha256)
}

test('new backup bridge misses a reencoded otherwise identical valid destination index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-bridge-index-seal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = repository(root)
  const snapshot = await seed(repo)
  const request = batch(snapshot, 'tx:index-seal')
  const target = newBackup(root, request)
  const measured = await coverage(repo, target, () => repo.applyCommands({ projectKey, batch: request }), async () => {
    const original = await readFile(join(target, indexName))
    const originalPack = await readFile(join(target, packName))
    const reencoded = Buffer.from(`${JSON.stringify(JSON.parse(original.toString()), null, 2)}\n`)
    assert.notEqual(sha(reencoded), sha(original), 'Only the encoded index identity changes')
    await writeMutable(join(target, indexName), reencoded)
    assert.deepEqual(await readFile(join(target, packName)), originalPack)
  })
  assert.equal(measured.value.ok, true, 'A seal mismatch is cache ineligibility, not invalid data')
  t.diagnostic(`index-only seal miss: first=${JSON.stringify(measured.first)}, total=${JSON.stringify(measured.total)}`)
  assert.deepEqual(measured.first, { semantic: 2, hash: 4 }, 'Both unchanged receipts replay under unsealed destination authority')
  const opened = await repository(root).open({ projectKey })
  assert.equal(opened.ok && opened.value.status === 'ready', true)
  if (opened.ok && opened.value.status === 'ready' && measured.value.ok) assert.deepEqual(opened.value.snapshot, measured.value.value.snapshot)
})

test('new backup bridge misses coherent changed destination ranges and pack authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-bridge-range-seal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = repository(root)
  const snapshot = await seed(repo)
  const request = batch(snapshot, 'tx:range-seal')
  const target = newBackup(root, request)
  const measured = await coverage(repo, target, () => repo.applyCommands({ projectKey, batch: request }), async () => {
    const state = JSON.parse((await readFile(join(target, 'state.v1.json'))).toString())
    const index = JSON.parse((await readFile(join(target, indexName))).toString())
    const originalPack = await readFile(join(target, packName))
    const first = index.entries[0], second = index.entries[1]
    const originalFirst = originalPack.subarray(first.offset, first.offset + first.length)
    const reencoded = Buffer.from(`${JSON.stringify(JSON.parse(originalFirst.toString()), null, 2)}\n`)
    assert.notEqual(reencoded.length, originalFirst.length)
    const unchangedSecond = originalPack.subarray(second.offset, second.offset + second.length)
    const pack = Buffer.concat([reencoded, unchangedSecond])
    state.transactions[0].resultSha256 = first.resultSha256 = sha(reencoded)
    first.length = reencoded.length
    second.offset = reencoded.length
    const stateBytes = encode(state)
    index.stateSha256 = sha(stateBytes)
    index.pack = { ...index.pack, byteLength: pack.length, sha256: sha(pack) }
    await writeMutable(join(target, 'state.v1.json'), stateBytes)
    await writeMutable(join(target, packName), pack)
    await writeMutable(join(target, indexName), encode(index))
    assert.deepEqual(pack.subarray(second.offset), unchangedSecond, 'The second receipt bytes and full transaction identity stay unchanged')
  })
  assert.equal(measured.value.ok, true, 'A coherent valid changed range remains acceptable')
  t.diagnostic(`range/pack seal miss: first=${JSON.stringify(measured.first)}, total=${JSON.stringify(measured.total)}`)
  assert.deepEqual(measured.first, { semantic: 2, hash: 4 }, 'The unchanged second receipt also replays after its destination range moves')
  const opened = await repository(root).open({ projectKey })
  assert.equal(opened.ok && opened.value.status === 'ready', true)
  if (opened.ok && opened.value.status === 'ready' && measured.value.ok) assert.deepEqual(opened.value.snapshot, measured.value.value.snapshot)
})

test('new backup bridge misses an identical valid package at a foreign backup path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-bridge-foreign-seal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = repository(root)
  const snapshot = await seed(repo)
  const request = batch(snapshot, 'tx:foreign-seal')
  const target = newBackup(root, request)
  const foreignRelative = `.modly/backups/${request.baseRevision}-${'a'.repeat(64)}`
  const foreign = join(root, 'Worlds', projectKey, foreignRelative)
  assert.notEqual(foreign, target)
  const observable = repo as unknown as { verifyBackupPackage: Verify }
  const verify = observable.verifyBackupPackage
  let redirected = false
  observable.verifyBackupPackage = async function (...args) {
    if (!redirected && join(String(args[0]), String(args[2])) === target) {
      redirected = true
      args[2] = foreignRelative
    }
    return verify.apply(this, args)
  }
  let measured: Awaited<ReturnType<typeof coverage<Awaited<ReturnType<WorldProjectRepository['applyCommands']>>>>>
  try {
    measured = await coverage(repo, target, () => repo.applyCommands({ projectKey, batch: request }), () => cp(target, foreign, { recursive: true }))
  } finally { observable.verifyBackupPackage = verify }
  assert.equal(redirected, true)
  assert.equal(measured.value.ok, true)
  assert.deepEqual(measured.first, { semantic: 2, hash: 4 }, 'A byte-identical foreign package cannot use the target-specific bridge')
  const opened = await repository(root).open({ projectKey })
  assert.equal(opened.ok && opened.value.status === 'ready', true)
  if (opened.ok && opened.value.status === 'ready' && measured.value.ok) assert.deepEqual(opened.value.snapshot, measured.value.value.snapshot)
  t.diagnostic(`foreign-path seal miss: first=${JSON.stringify(measured.first)}, total=${JSON.stringify(measured.total)}`)
})

test('new backup bridge rejects active valid-hash semantic and canonical authority corruption', async (t) => {
  for (const mutation of ['replay', 'inverse', 'project', 'revision', 'transaction', 'valid-origin'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-bridge-authority-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const stages: string[] = []
    const repo = repository(root, { failureCheckpoint: (stage) => { stages.push(stage) } })
    const snapshot = await seed(repo)
    const request = batch(snapshot, `tx:active-${mutation}`)
    const target = newBackup(root, request)
    const before = await capturePrimary(root)
    stages.length = 0
    const measured = await coverage(repo, target, () => repo.applyCommands({ projectKey, batch: request }), async () => {
      await rewriteBackup(target, (receipt, tx) => {
        if (mutation === 'replay') receipt.inverse.snapshot.scenes[0].name = 'Not replayed'
        if (mutation === 'inverse') receipt.inverse.snapshot.project.revision += 1
        if (mutation === 'project') receipt.inverse.snapshot.project.projectId = 'project:other'
        if (mutation === 'revision') receipt.newRevision += 1
        if (mutation === 'valid-origin' || mutation === 'transaction') {
          const changed: WorldCommandBatchV1 = JSON.parse(tx.canonicalPayload)
          if (mutation === 'valid-origin') changed.origin = 'workflow'
          else { changed.transactionId = 'tx:retargeted'; tx.transactionId = changed.transactionId }
          tx.canonicalPayload = canonicalWorldCommandBatchPayload(changed)
          tx.payloadSha256 = sha(tx.canonicalPayload)
          tx.transactionDigest = sha(`${tx.transactionId}\n${tx.canonicalPayload}`)
        }
      })
    })
    assert.equal(measured.value.ok, mutation === 'valid-origin', mutation)
    assert.equal(measured.first?.semantic, mutation === 'valid-origin' ? 2 : 1,
      `${mutation}: changed destination identity requires replay; chain failures settle after materialization`)
    if (!measured.value.ok) {
      assert.deepEqual({ code: measured.value.error.code, retryable: measured.value.error.retryable }, { code: 'recovery_failed', retryable: true })
      await assertUnpublished(root, before, stages)
    }
    t.diagnostic(`${mutation}: first=${JSON.stringify(measured.first)}, total=${JSON.stringify(measured.total)}`)
  }
})

test('new backup bridge owns proof bytes independently of awaited write buffers and backing stores', async (t) => {
  for (const mutation of ['late-valid-destination', 'valid-destination', 'forged-destination'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-bridge-buffer-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const stages: string[] = []
    let armed = false, sourceHits = 0, priorHits = 0
    const repo = repository(root, { failureCheckpoint: (stage) => { stages.push(stage) }, backupCostObserver: (record) => {
      if (!armed || record.edge !== 'settled' || record.kind !== 'cache-hit') return
      if (record.phase === 'prior-proof') priorHits += 1
      if (record.phase === 'pack-ledger') sourceHits += 1
    } })
    const snapshot = await seed(repo)
    armed = true
    const request = batch(snapshot, `tx:buffer-${mutation}`)
    const target = newBackup(root, request)
    const before = await capturePrimary(root)
    stages.length = 0
    const originalOpen = fsPromises.open
    let mutated = 0
    const transports: Buffer[] = []
    const restore = replaceOpen((async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      if (path !== join(target, packName) || flags !== 'wx') return handle
      return new Proxy(handle, { get(object, property) {
        if (property === 'write') return async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await object.write(buffer, offset, length, position)
          if (mutation === 'late-valid-destination') transports.push(buffer)
          else {
            // Keep disk bytes valid, but destroy the entire transport backing store before the await resumes.
            new Uint8Array(buffer.buffer).fill(0x20)
            mutated += 1
          }
          return result
        }
        const value = Reflect.get(object, property)
        return typeof value === 'function' ? value.bind(object) : value
      } })
    }) as Open)
    let measured: Awaited<ReturnType<typeof coverage<Awaited<ReturnType<WorldProjectRepository['applyCommands']>>>>>
    try {
      measured = await coverage(repo, target, () => repo.applyCommands({ projectKey, batch: request }), async () => {
        if (mutation === 'late-valid-destination') {
          // Destroy retained I/O buffers after hashing/writes: the untouched on-disk index still matches its seal.
          for (const buffer of transports) { new Uint8Array(buffer.buffer).fill(0x20); mutated += 1 }
          return
        }
        // Restore a coherent whole-pack digest for the real unmodified bytes on disk.
        const index = JSON.parse((await readFile(join(target, indexName))).toString())
        index.pack.sha256 = sha(await readFile(join(target, packName)))
        await writeMutable(join(target, indexName), encode(index))
        if (mutation === 'forged-destination') await rewriteBackup(target, (receipt) => { receipt.inverse.snapshot.scenes[0].name = 'Forged replay' })
      })
    } finally { restore() }
    assert.equal(mutated, 2)
    assert.equal(priorHits, 2, 'Warm primary proofs precede the real source bridge')
    assert.equal(sourceHits, 2, 'The packed source and primary tail reuse independent proof bytes before writing')
    assert.equal(measured.value.ok, mutation !== 'forged-destination')
    assert.equal(measured.first?.semantic, mutation === 'late-valid-destination' ? 0 : mutation === 'forged-destination' ? 1 : 2)
    if (!measured.value.ok) await assertUnpublished(root, before, stages)
    t.diagnostic(`${mutation}: first=${JSON.stringify(measured.first)}`)
  }
})

test('new backup bridge discards matched candidates after destination settlement failures', async (t) => {
  for (const mutation of ['shrink', 'replacement', 'whole-hash', 'overflow', 'close'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-bridge-settle-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const stages: string[] = []
    const repo = repository(root, { failureCheckpoint: (stage) => { stages.push(stage) } })
    const snapshot = await seed(repo)
    const request = batch(snapshot, `tx:settle-${mutation}`)
    const target = newBackup(root, request)
    const packPath = join(target, packName)
    const before = await capturePrimary(root)
    stages.length = 0
    const originalOpen = fsPromises.open
    let reads = 0, closes = 0, opens = 0
    let savedPack: Buffer, savedIndex: Buffer
    const restore = replaceOpen((async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      if (path !== packPath || flags === 'wx') return handle
      opens += 1
      return new Proxy(handle, { get(object, property) {
        if (property === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
          reads += 1
          if (mutation === 'overflow' && position === savedPack.length) return { bytesRead: 1, buffer }
          const result = await object.read(buffer, offset, length, position)
          if (reads === 1) {
            if (mutation === 'shrink') { await chmod(packPath, 0o600); await truncate(packPath, length) }
            if (mutation === 'replacement') { await rename(packPath, `${packPath}.old`); await writeFile(packPath, savedPack) }
          }
          return result
        }
        if (property === 'close') return async () => { closes += 1; await object.close(); if (mutation === 'close') throw new Error('Injected destination read close failure') }
        const value = Reflect.get(object, property)
        return typeof value === 'function' ? value.bind(object) : value
      } })
    }) as Open)
    let measured: Awaited<ReturnType<typeof coverage<Awaited<ReturnType<WorldProjectRepository['applyCommands']>>>>>
    try {
      measured = await coverage(repo, target, () => repo.applyCommands({ projectKey, batch: request }), async () => {
        // Use the original open implementation for evidence reads so only production handles are observed.
        const handle = await originalOpen(packPath, 'r')
        try { savedPack = await handle.readFile() } finally { await handle.close() }
        savedIndex = await readFile(join(target, indexName))
        if (mutation === 'whole-hash') {
          const index = JSON.parse(savedIndex.toString()); index.pack.sha256 = '0'.repeat(64)
          await writeMutable(join(target, indexName), encode(index))
        }
      })
    } finally { restore() }
    assert.equal(measured.value.ok, false, mutation)
    if (!measured.value.ok) assert.equal(measured.value.error.code, 'recovery_failed')
    assert.equal(opens, 1)
    assert.equal(closes, 1, 'Every opened destination handle actually closes before return')
    assert.ok(reads >= 2, 'At least one receipt is read before failing read/settlement')
    assert.equal(measured.first?.semantic, mutation === 'whole-hash' ? 2 : 0,
      'Index rewrite must miss the seal; unchanged index shrink/replacement/overflow/close cases have provisional hits')
    await assertUnpublished(root, before, stages)
    await writeMutable(packPath, savedPack!)
    await writeMutable(join(target, indexName), savedIndex!)
    const observable = repo as unknown as { verifyBackupPackage: Verify; createBackup: Verify }
    const createBackup = observable.createBackup
    let retryScopeChecks = 0
    observable.createBackup = async function (...args) {
      assert.equal(typeof args[3], 'function', 'Inspect the actual next apply scope, not a scope-less cold verifier')
      // Before retry replaces the failed destination, verify its restored bytes using that real apply's ordinary scope.
      await observable.verifyBackupPackage(args[0], projectKey, args[2], undefined, args[3])
      retryScopeChecks += 1
      return createBackup.apply(this, args)
    }
    let retried: Awaited<ReturnType<typeof coverage<Awaited<ReturnType<WorldProjectRepository['applyCommands']>>>>>
    try { retried = await coverage(repo, target, () => repo.applyCommands({ projectKey, batch: request })) }
    finally { observable.createBackup = createBackup }
    assert.equal(retryScopeChecks, 1)
    assert.deepEqual(retried.first, { semantic: 2, hash: 4 }, 'Failed destination candidates were not promoted into the next actual apply scope')
    const retry = retried.value
    assert.equal(retry.ok, true)
    const opened = await repository(root).open({ projectKey })
    assert.equal(opened.ok, true)
    if (opened.ok && opened.value.status === 'ready' && retry.ok) assert.deepEqual(opened.value.snapshot, retry.value.snapshot)
    const publicRetry = await repo.applyCommands({ projectKey, batch: request })
    assert.equal(publicRetry.ok && publicRetry.value.idempotent, true)
    t.diagnostic(`${mutation}: first=${JSON.stringify(measured.first)}, actual-retry-preflight=${JSON.stringify(retried.first)}, retry-total=${JSON.stringify(retried.total)}`)
  }
})

test('new backup bridge invalidates irreversibly during awaited pack writes on runtime and namespace drift', async (t) => {
  for (const mutation of ['clone', 'prototype', 'toJSON', 'namespace'] as const) {
    const root = await mkdtemp(join(tmpdir(), `modly-bridge-drift-${mutation}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const firstRoot = join(root, 'first'), secondRoot = join(root, 'second')
    let workspace = firstRoot
    const stages: string[] = []
    let armed = false
    const records: Array<{ invocation: number; phase: string; kind: string; edge: string }> = []
    const repo = repository(firstRoot, { getWorkspaceRoot: () => workspace, failureCheckpoint: (stage) => { stages.push(stage) },
      backupCostObserver: (record) => { if (armed) records.push(record) } })
    const snapshot = await seed(repo, 3)
    armed = true
    if (mutation === 'namespace') await cp(join(firstRoot, 'Worlds'), join(secondRoot, 'Worlds'), { recursive: true })
    const request = batch(snapshot, `tx:drift-${mutation}`)
    const target = newBackup(firstRoot, request)
    const before = await capturePrimary(firstRoot)
    stages.length = 0
    const cloneDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone')!
    const clone = globalThis.structuredClone
    const pollution = mutation === 'toJSON' ? 'toJSON' : 'modlyBridgePollution'
    assert.equal(Object.hasOwn(Object.prototype, pollution), false)
    let injected = false, ambientKeyCalls = 0
    const resetRuntime = () => {
      Object.defineProperty(globalThis, 'structuredClone', cloneDescriptor)
      Reflect.deleteProperty(Object.prototype, pollution)
    }
    const originalOpen = fsPromises.open
    const restore = replaceOpen((async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      if (path !== join(target, packName) || flags !== 'wx') return handle
      return new Proxy(handle, { get(object, property) {
        if (property === 'write') return async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await object.write(buffer, offset, length, position)
          if (!injected) {
            injected = true
            if (mutation === 'clone') Object.defineProperty(globalThis, 'structuredClone', { ...cloneDescriptor, value: <T>(value: T) => clone(value) })
            if (mutation === 'prototype') Object.defineProperty(Object.prototype, pollution, { configurable: true, value: true })
            if (mutation === 'toJSON') Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value: function (this: unknown) {
              if (Array.isArray(this) && this.includes('modly.world-command-result-proof.v1')) ambientKeyCalls += 1
              return this
            } })
            if (mutation === 'namespace') {
              workspace = secondRoot
              const other = await repo.applyCommands({ projectKey, batch: batch(snapshot, 'tx:namespace-winner') })
              assert.equal(other.ok, true)
              workspace = firstRoot
            }
          }
          return result
        }
        const value = Reflect.get(object, property)
        return typeof value === 'function' ? value.bind(object) : value
      } })
    }) as Open)
    let measured: Awaited<ReturnType<typeof coverage<Awaited<ReturnType<WorldProjectRepository['applyCommands']>>>>>
    try {
      const firstExpected = mutation === 'clone' || mutation === 'namespace'
      measured = await coverage(repo, firstExpected ? target : null, () => repo.applyCommands({ projectKey, batch: request }), async () => {
        // A previously observed drift must not revive the captured first receipt when restored.
        resetRuntime()
      })
    } finally { restore(); resetRuntime() }
    assert.equal(injected, true)
    const outer = records.filter((record) => record.invocation === records[0].invocation && record.edge === 'settled' && record.kind === 'cache-hit')
    assert.equal(outer.filter((record) => record.phase === 'prior-proof').length, 3)
    assert.equal(outer.filter((record) => record.phase === 'pack-ledger').length, 1,
      'The first sealed packed source hits; the second packed receipt cannot reuse the invalidated lease')
    assert.equal(measured.value.ok, mutation === 'clone' || mutation === 'namespace')
    if (measured.value.ok) assert.equal(measured.first?.semantic, 3, 'All destination receipts replay after invalidation, even after runtime restoration')
    else { assert.equal(measured.value.error.code, 'recovery_failed'); await assertUnpublished(firstRoot, before, stages) }
    assert.equal(ambientKeyCalls, 0, 'No logical-key encoding occurs in the polluted runtime')
    t.diagnostic(`${mutation}: first=${JSON.stringify(measured.first)}, total=${JSON.stringify(measured.total)}`)
  }
})
