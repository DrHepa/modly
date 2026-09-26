import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { validateWorldProjectSnapshot } from '../../src/areas/worlds/core/worldDocuments.ts'

export const digest = (bytes: Uint8Array) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
type Fingerprint = Record<string, { kind: 'directory' } | { kind: 'file'; bytes: number; sha256: string }>

/** Reads only; includes empty directories and rejects links rather than following them. */
export async function fingerprintTree(root: string): Promise<Fingerprint> {
  assert.equal(await realpath(root), path.resolve(root))
  const result: Fingerprint = {}
  async function visit(prefix: string): Promise<void> {
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = path.join(prefix, entry.name)
      if (entry.isDirectory()) { result[relative] = { kind: 'directory' }; await visit(relative) }
      else { assert.ok(entry.isFile(), `Unexpected linked or special file: ${relative}`); result[relative] = { kind: 'file', ...digest(await readFile(path.join(root, relative))) } }
    }
  }
  await visit('')
  return result
}

/** Independent raw committed-marker verification. Never invokes recovering repository open. */
export async function inspectWorld(workspace: string, projectKey: string) {
  assert.match(projectKey, /^world-[a-f0-9]{32}$/)
  const root = path.join(workspace, 'Worlds', projectKey)
  const worlds = await fingerprintTree(path.join(workspace, 'Worlds'))
  assert.equal(worlds['.modly-projects.lock'], undefined, 'Active repository lock is not a stable checkpoint.')
  const fingerprint = await fingerprintTree(root)
  assert.equal(fingerprint['.modly/journal.v1.json'], undefined, 'Pending recovery is not acceptance.')
  const bounded = async (filename: string) => {
    assert.equal(await realpath(filename), filename)
    const stat = await lstat(filename); assert.ok(stat.isFile() && stat.size <= 16 * 1024 * 1024)
    return readFile(filename)
  }
  const state = JSON.parse((await bounded(path.join(root, '.modly/state.v1.json'))).toString())
  assert.equal(state.schema, 'modly.world-project-state.v1'); assert.equal(state.projectKey, projectKey)
  const readRef = async (ref: { path: string; sha256: string }) => {
    assert.match(ref.sha256, /^[a-f0-9]{64}$/)
    const filename = path.resolve(workspace, ref.path)
    assert.ok(filename.startsWith(`${root}${path.sep}`), 'Durable reference escaped the fixture World.')
    const bytes = await bounded(filename); assert.equal(digest(bytes).sha256, ref.sha256)
    return JSON.parse(bytes.toString())
  }
  const project = await readRef(state.project)
  const scenes = await Promise.all(state.scenes.map(readRef))
  const validated = validateWorldProjectSnapshot({ project, scenes })
  assert.ok(validated.success, 'Raw durable World documents are invalid.')
  assert.equal(project.revision, state.committedRevision)
  assert.equal(project.projectId, state.projectId)
  assert.ok(Array.isArray(state.transactions) && state.transactions.length <= 32)
  for (const transaction of state.transactions) {
    assert.match(transaction.transactionDigest, /^[a-f0-9]{64}$/)
    const result = await bounded(path.join(root, '.modly', 'transactions', transaction.transactionDigest, 'after', 'result.v1.json'))
    assert.equal(digest(result).sha256, transaction.resultSha256)
    assert.equal(digest(Buffer.from(transaction.canonicalPayload)).sha256, transaction.payloadSha256)
  }
  assert.deepEqual(await fingerprintTree(root), fingerprint, 'Durable inspection itself must not write.')
  return { snapshot: validated.value, fingerprint, state }
}
