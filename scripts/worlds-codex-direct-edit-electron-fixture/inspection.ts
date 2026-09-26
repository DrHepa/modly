import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

import { validateWorldProjectSnapshot } from '../../src/areas/worlds/core/worldDocuments.ts'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { canonicalWorldProjectSnapshotPayload } from '../../src/areas/worlds/core/worldSnapshotDigest.ts'

export const digest = (bytes: Uint8Array | string) => ({
  bytes: typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
})

export type TreeFingerprint = Record<string, { kind: 'directory' } | { kind: 'file'; bytes: number; sha256: string }>

/** Independent raw traversal: reject links and never invoke repository recovery. */
export async function fingerprintTree(root: string): Promise<TreeFingerprint> {
  assert.equal(await realpath(root), path.resolve(root))
  const result: TreeFingerprint = {}
  const visit = async (prefix: string): Promise<void> => {
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const relative = path.posix.join(prefix, entry.name)
      if (entry.isDirectory()) { result[relative] = { kind: 'directory' }; await visit(relative) }
      else {
        assert.ok(entry.isFile(), `Unexpected linked or special durable entry: ${relative}`)
        result[relative] = { kind: 'file', ...digest(await readFile(path.join(root, relative))) }
      }
    }
  }
  await visit('')
  return result
}

export function fullSnapshotHash(snapshot: WorldProjectSnapshotV1): string {
  return digest(canonicalWorldProjectSnapshotPayload(snapshot)).sha256
}

export function revisionNeutralContentHash(snapshot: WorldProjectSnapshotV1): string {
  const neutral = structuredClone(snapshot)
  neutral.project.revision = 0
  return digest(canonicalWorldProjectSnapshotPayload(neutral)).sha256
}

export async function inspectWorldRaw(workspace: string, projectKey: string) {
  assert.match(projectKey, /^world-[a-f0-9]{32}$/)
  const worldsRoot = path.join(workspace, 'Worlds')
  const projectRoot = path.join(worldsRoot, projectKey)
  const before = await fingerprintTree(projectRoot)
  assert.equal(before['.modly/journal.v1.json'], undefined, 'Pending journal is not accepted as durable state.')

  const boundedFile = async (filename: string): Promise<Buffer> => {
    assert.equal(await realpath(filename), filename)
    const info = await lstat(filename)
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 16 * 1024 * 1024)
    return readFile(filename)
  }
  const stateBytes = await boundedFile(path.join(projectRoot, '.modly/state.v1.json'))
  const state = JSON.parse(stateBytes.toString()) as {
    schema: string; projectKey: string; projectId: string; committedRevision: number
    project: { path: string; sha256: string }; scenes: Array<{ path: string; sha256: string }>
    transactions: Array<{ transactionId: string; transactionDigest: string; resultSha256: string; payloadSha256: string; canonicalPayload: string }>
  }
  assert.equal(state.schema, 'modly.world-project-state.v1')
  assert.equal(state.projectKey, projectKey)
  const readReference = async (reference: { path: string; sha256: string }): Promise<unknown> => {
    assert.match(reference.sha256, /^[a-f0-9]{64}$/)
    const filename = path.resolve(workspace, reference.path)
    assert.ok(filename.startsWith(`${projectRoot}${path.sep}`), 'Durable reference escaped the fixture World.')
    const bytes = await boundedFile(filename)
    assert.equal(digest(bytes).sha256, reference.sha256)
    return JSON.parse(bytes.toString())
  }
  const project = await readReference(state.project)
  const scenes = await Promise.all(state.scenes.map(readReference))
  const validated = validateWorldProjectSnapshot({ project, scenes })
  assert.ok(validated.success, 'Raw durable World documents are invalid.')
  assert.equal(validated.value.project.revision, state.committedRevision)
  assert.equal(validated.value.project.projectId, state.projectId)
  assert.ok(state.transactions.length <= 32)
  for (const transaction of state.transactions) {
    assert.match(transaction.transactionDigest, /^[a-f0-9]{64}$/)
    assert.equal(digest(transaction.canonicalPayload).sha256, transaction.payloadSha256)
    const result = await boundedFile(path.join(projectRoot, '.modly/transactions', transaction.transactionDigest, 'after/result.v1.json'))
    assert.equal(digest(result).sha256, transaction.resultSha256)
  }
  const after = await fingerprintTree(projectRoot)
  assert.deepEqual(after, before, 'Raw inspection must not recover or write.')
  const snapshot = validated.value
  return {
    snapshot,
    state,
    fingerprint: before,
    treeHash: digest(JSON.stringify(before)).sha256,
    fullHash: fullSnapshotHash(snapshot),
    contentHash: revisionNeutralContentHash(snapshot),
    journalPresent: false as const,
  }
}
