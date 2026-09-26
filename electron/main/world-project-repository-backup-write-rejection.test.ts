import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsPromises, { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { canonicalWorldCommandBatchPayload, type WorldCommandBatchV1 } from '../../src/areas/worlds/core/worldCommands.ts'
import { WORLD_COMMAND_BATCH_SCHEMA, type WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import type { WorldProjectCommandResult, WorldProjectCommandSuccess, WorldProjectCreateSuccess, WorldProjectOpenSuccess } from '../../src/shared/types/worldProjects.ts'
import { WorldProjectRepository } from './world-project-repository.ts'

const PROJECT_KEY_A = 'world-0123456789abcdef0123456789abcdef'
const SCENE_KEY_A = 'scene-0123456789abcdef0123456789abcdef'

type OpenFunction = typeof fsPromises.open

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

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
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

async function pathExists(path: string): Promise<boolean> {
  try { await fsPromises.lstat(path); return true } catch { return false }
}

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

test('backup pack destination open rejection prevents journal and public publication', { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-backup-pack-open-reject-'))
  let restoreOpen: () => void = () => undefined
  t.after(async () => {
    restoreOpen()
    await rm(root, { recursive: true, force: true })
  })

  const seeded = await seedMatureBackupSource(root, 'PackOpen')
  const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
  const statePath = join(projectRoot, '.modly', 'state.v1.json')
  const projectPath = join(projectRoot, 'project.world-project.json')
  const scenePaths = seeded.snapshot.project.scenes.map((scene) => join(projectRoot, 'scenes', basename(scene.documentPath)))
  const priorStateBytes = await readFile(statePath)
  const priorProjectBytes = await readFile(projectPath)
  const priorSceneBytes = new Map(await Promise.all(scenePaths.map(async (path) => [path, await readFile(path)] as const)))

  const measuredBatch = renameBatch(seeded.snapshot, 'tx:pack-open-rejection', 'Pack open rejected')
  const measuredCanonical = canonicalWorldCommandBatchPayload(measuredBatch)
  const measuredDigest = sha256Bytes(`${measuredBatch.transactionId}\n${measuredCanonical}`)
  const afterRoot = join(projectRoot, '.modly', 'transactions', measuredDigest, 'after')
  const expectedBackupRoot = join(projectRoot, '.modly', 'backups', `33-${measuredDigest}`)
  const journalPath = join(projectRoot, '.modly', 'journal.v1.json')
  const checkpoints: string[] = []
  let rejectedPackOpen = false
  const originalOpen = fsPromises.open

  restoreOpen = replaceBuiltinOpen((async (path, flags, mode) => {
    if (typeof path === 'string' && path === join(expectedBackupRoot, 'transactions.pack.v1') && flags === 'wx') {
      rejectedPackOpen = true
      const collision = await originalOpen(path, 'wx', 0o600)
      try {
        await collision.writeFile(Buffer.from('collision\n'))
        await collision.sync()
      } finally {
        await collision.close()
      }
    }
    return originalOpen(path, flags, mode)
  }) as OpenFunction)

  const repository = createRepository(root, { failureCheckpoint: (stage) => { checkpoints.push(stage) } })
  const failed: WorldProjectCommandResult = await repository.applyCommands({ projectKey: PROJECT_KEY_A, batch: measuredBatch })
  assert.equal(rejectedPackOpen, true)
  assert.equal(failed.ok, false)
  if (!failed.ok) {
    assert.equal(failed.error.code, 'write_failed')
    assert.equal(failed.error.retryable, true)
  }
  assert.equal(await pathExists(journalPath), false)
  assert.equal(checkpoints.includes('backup-created'), false)
  assert.equal(checkpoints.includes('journal-published'), false)
  assert.equal(checkpoints.some((stage) => stage.startsWith('document-published:')), false)
  assert.equal(checkpoints.includes('state-published'), false)
  assert.deepEqual(await readFile(statePath), priorStateBytes)
  assert.deepEqual(await readFile(projectPath), priorProjectBytes)
  for (const [path, bytes] of priorSceneBytes) assert.deepEqual(await readFile(path), bytes)
  assert.equal(await pathExists(afterRoot), true)

  restoreOpen()
  await rm(expectedBackupRoot, { recursive: true, force: true })
  const retried = await createRepository(root).applyCommands({ projectKey: PROJECT_KEY_A, batch: measuredBatch })
  assert.equal(retried.ok, true)
  if (!retried.ok) return
  assert.equal(retried.value.newRevision, seeded.snapshot.project.revision + 1)
  const reopened = assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
  assert.deepEqual(reopened.snapshot, retried.value.snapshot)
  assert.deepEqual((await readdir(expectedBackupRoot)).sort(), ['project.world-project.json', 'scenes', 'state.v1.json', 'transactions.index.v1.json', 'transactions.pack.v1'])
})

test('backup pack write sync close and index failures settle before publication', { timeout: 120_000 }, async (t) => {
  const cases = ['partial-success', 'zero-progress-write', 'pack-sync-failure', 'pack-close-failure', 'index-open-failure'] as const
  for (const mutation of cases) {
    const root = await mkdtemp(join(tmpdir(), `modly-world-backup-pack-${mutation}-`))
    let restoreOpen: () => void = () => undefined
    t.after(async () => {
      restoreOpen()
      await rm(root, { recursive: true, force: true })
    })
    const seeded = await seedMatureBackupSource(root, `Pack${mutation.replaceAll('-', '')}`)
    const projectRoot = join(root, 'Worlds', PROJECT_KEY_A)
    const statePath = join(projectRoot, '.modly', 'state.v1.json')
    const projectPath = join(projectRoot, 'project.world-project.json')
    const scenePaths = seeded.snapshot.project.scenes.map((scene) => join(projectRoot, 'scenes', basename(scene.documentPath)))
    const priorStateBytes = await readFile(statePath)
    const priorProjectBytes = await readFile(projectPath)
    const priorSceneBytes = new Map(await Promise.all(scenePaths.map(async (path) => [path, await readFile(path)] as const)))
    const batch = renameBatch(seeded.snapshot, `tx:${mutation}`, `Pack ${mutation}`)
    const digest = sha256Bytes(`${batch.transactionId}\n${canonicalWorldCommandBatchPayload(batch)}`)
    const expectedBackupRoot = join(projectRoot, '.modly', 'backups', `33-${digest}`)
    const afterRoot = join(projectRoot, '.modly', 'transactions', digest, 'after')
    const journalPath = join(projectRoot, '.modly', 'journal.v1.json')
    const checkpoints: string[] = []
    const events: string[] = []
    const originalOpen = fsPromises.open

    restoreOpen = replaceBuiltinOpen((async (path, flags, mode) => {
      if (typeof path === 'string' && path === join(expectedBackupRoot, 'transactions.pack.v1') && flags === 'wx') {
        const handle = await originalOpen(path, flags, mode)
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'write') return async (buffer: Buffer, offset?: number, length?: number, position?: number) => {
              events.push('pack-write')
              if (mutation === 'zero-progress-write') return { bytesWritten: 0, buffer }
              if (mutation === 'partial-success' && typeof length === 'number' && length > 7) {
                return target.write(buffer, offset, 7, position)
              }
              return target.write(buffer, offset, length, position)
            }
            if (property === 'sync') return async () => {
              events.push('pack-sync')
              if (mutation === 'pack-sync-failure') throw new Error('injected pack sync failure')
              return target.sync()
            }
            if (property === 'close') return async () => {
              events.push('pack-close')
              await target.close()
              if (mutation === 'pack-close-failure') throw new Error('injected pack close failure')
            }
            const value = Reflect.get(target, property, receiver) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) as typeof handle
      }
      if (typeof path === 'string'
        && path.startsWith(expectedBackupRoot)
        && path.includes('.transactions.index.v1.json.tmp-')
        && flags === 'wx'
        && mutation === 'index-open-failure') {
        events.push('index-open-failure')
        throw Object.assign(new Error('injected index open failure'), { code: 'EEXIST' })
      }
      return originalOpen(path, flags, mode)
    }) as OpenFunction)

    const result = await createRepository(root, { failureCheckpoint: (stage) => { checkpoints.push(stage) } })
      .applyCommands({ projectKey: PROJECT_KEY_A, batch })
    const shouldPass = mutation === 'partial-success'
    assert.equal(result.ok, shouldPass, mutation)
    if (!result.ok) assert.deepEqual({ code: result.error.code, retryable: result.error.retryable }, { code: 'write_failed', retryable: true }, mutation)
    assert.equal(events.includes('pack-close'), true, `${mutation} closes any opened pack handle before return`)
    if (!shouldPass) {
      assert.equal(await pathExists(journalPath), false, mutation)
      assert.equal(checkpoints.includes('backup-created'), false, mutation)
      assert.equal(checkpoints.includes('journal-published'), false, mutation)
      assert.equal(checkpoints.some((stage) => stage.startsWith('document-published:')), false, mutation)
      assert.equal(checkpoints.includes('state-published'), false, mutation)
      assert.deepEqual(await readFile(statePath), priorStateBytes, mutation)
      assert.deepEqual(await readFile(projectPath), priorProjectBytes, mutation)
      for (const [path, bytes] of priorSceneBytes) assert.deepEqual(await readFile(path), bytes, mutation)
      assert.equal(await pathExists(afterRoot), true, mutation)
      if (mutation !== 'index-open-failure') assert.equal(await pathExists(join(expectedBackupRoot, 'transactions.index.v1.json')), false, mutation)
    } else {
      assert.deepEqual((await readdir(expectedBackupRoot)).sort(), ['project.world-project.json', 'scenes', 'state.v1.json', 'transactions.index.v1.json', 'transactions.pack.v1'])
      assertOpened(await createRepository(root).open({ projectKey: PROJECT_KEY_A }))
    }
    restoreOpen()
  }
})
