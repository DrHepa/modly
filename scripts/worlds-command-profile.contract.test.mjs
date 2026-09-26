// Real persistence contract coverage. Synthetic profiler responses are NEVER CPU evidence.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, lstat, mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as diagnostic from './worlds-command-profile.mjs'
import { success } from './worlds-command-latency.mjs'
import { WorldProjectRepository } from '../electron/main/world-project-repository.ts'
import { createWorldProjectService } from '../src/areas/worlds/worldProjectService.ts'
import { createWorldEditorController } from '../src/areas/worlds/editor/worldEditorController.ts'
import { buildAddEmptyEntityCommands } from '../src/areas/worlds/editor/worldAuthoringModel.ts'
import { createDeterministicWorldEditorIdentityGenerator } from '../src/areas/worlds/editor/worldEditorCommandBuilders.ts'
import { canonicalWorldCommandBatchPayload, fingerprintWorldCommandBatch } from '../src/areas/worlds/core/worldCommands.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TESTS = join(ROOT, 'docs/worlds-engine-evidence/2026-09-09/current-command-cost-map/storage-binding-remediation/contract-tests')
const LABEL = 'SYNTHETIC_PROFILER_FOR_CONTRACT_ONLY'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const save = (root, name, value) => writeFile(join(root, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
const read = async (root, name) => (await diagnostic.readEvidenceFile(root, join(root, name), diagnostic.PROFILE_CONTRACT.maxDocumentBytes)).bytes
const json = async (root, name) => JSON.parse((await read(root, name)).toString('utf8'))
const safeDirectory = async (path) => {
  const info = await lstat(path)
  assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal(await realpath(path), path)
}
const absent = async (path) => { try { await lstat(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error } }
const observe = async (path) => {
  const info = await lstat(path, { bigint: true })
  return { path, realPath: await realpath(path), dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), isDirectory: info.isDirectory(), isSymbolicLink: info.isSymbolicLink() }
}

class SyntheticSession {
  connect() {}
  disconnect() {}
  post(method, _params, callback) {
    assert.ok(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Profiler.stop'].includes(method))
    const frame = (functionName) => ({ functionName, url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 })
    callback(null, method === 'Profiler.stop' ? { profile: { startTime: 0, endTime: 1,
      nodes: [{ id: 1, callFrame: frame('(root)'), children: [2] }, { id: 2, callFrame: frame('(program)') }],
      samples: [2], timeDeltas: [1] } } : {})
  }
}

async function auditBodies(evidence, disk) {
  assert.equal(disk.custody.status, 'PASS')
  for (const file of disk.custody.files) {
    const bytes = await read(evidence, file.blob)
    assert.equal(bytes.length, file.byteLength); assert.equal(hash(bytes), file.sha256)
    assert.equal(file.identity.noFollow, true); assert.equal(file.identity.type, 'regular-file')
  }
  return disk.custody.files.length
}

async function auditRevisionZero(evidence, disk) {
  const name = disk.backups.find((value) => value.startsWith('0-'))
  assert.ok(name, 'First commit must retain the real revision0 backup.')
  const prefix = `Worlds/${disk.state.projectKey}/.modly/backups/${name}`
  const body = async (suffix) => {
    const ref = disk.custody.files.find((file) => file.path === `${prefix}/${suffix}`)
    assert.ok(ref, suffix); return read(evidence, ref.blob)
  }
  const state = JSON.parse(await body('state.v1.json')), index = JSON.parse(await body('transactions.index.v1.json'))
  assert.equal(state.committedRevision, 0); assert.deepEqual(state.transactions, [])
  assert.equal(JSON.parse(await body('project.world-project.json')).revision, 0)
  const sceneFile = disk.snapshot.project.scenes[0].documentPath.split('/').at(-1)
  assert.equal(JSON.parse(await body(`scenes/${sceneFile}`)).sceneId, disk.snapshot.scenes[0].sceneId)
  assert.deepEqual(index.entries, []); assert.equal(index.pack.byteLength, 0)
  assert.equal((await body('transactions.pack.v1')).length, 0)
  assert.equal(index.pack.sha256, hash(Buffer.alloc(0)))
}

async function auditReceipts(evidence, first, disk) {
  const { input: { batch } } = await json(evidence, 'setup-01-input.json')
  const local = first.localReceipt, receipt = first.publicReceipt
  assert.deepEqual(Object.keys(local).sort(), ['appliedRevision', 'canonicalPayload', 'fingerprint', 'transactionId'])
  assert.deepEqual(Object.keys(receipt).sort(), ['appliedRevision', 'payloadSha256', 'resultSha256', 'transactionId'])
  const canonical = canonicalWorldCommandBatchPayload(batch)
  assert.equal(canonical, local.canonicalPayload); assert.equal(canonical.endsWith('\n'), false)
  const reordered = (value) => Array.isArray(value) ? value.map(reordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)])) : value
  assert.equal(canonicalWorldCommandBatchPayload(reordered(batch)), canonical)
  assert.notEqual(canonicalWorldCommandBatchPayload({ ...batch, commands: [...batch.commands].reverse() }), canonical)
  const unicodeBatch = structuredClone(batch); unicodeBatch.commands[0].entity.name = 'Unicode 😀é'
  const unicodeCanonical = canonicalWorldCommandBatchPayload(unicodeBatch)
  const fnv = (values) => { let value = 0x811c9dc5; for (const item of values) value = Math.imul(value ^ item, 0x01000193) >>> 0; return `fnv1a32:${value.toString(16).padStart(8, '0')}` }
  const utf16 = fnv(Array.from({ length: unicodeCanonical.length }, (_, i) => unicodeCanonical.charCodeAt(i)))
  const utf8 = fnv(Buffer.from(unicodeCanonical))
  assert.equal(fingerprintWorldCommandBatch(unicodeBatch), utf16); assert.notEqual(utf16, utf8)
  assert.equal(local.fingerprint, fingerprintWorldCommandBatch(batch))
  assert.equal(hash(canonical), receipt.payloadSha256); assert.notEqual(hash(`${canonical}\n`), receipt.payloadSha256)
  const transaction = disk.state.transactions[0]
  assert.equal(transaction.canonicalPayload, canonical)
  assert.equal(transaction.transactionDigest, hash(`${batch.transactionId}\n${canonical}`))
  const file = disk.custody.files.find((entry) => entry.path.endsWith('/after/result.v1.json'))
  const bytes = await read(evidence, file.blob), result = JSON.parse(bytes)
  assert.equal(bytes.at(-1), 10); assert.notEqual(bytes.at(-2), 10)
  assert.equal(hash(bytes), receipt.resultSha256); assert.notEqual(hash(bytes.subarray(0, -1)), receipt.resultSha256)
  assert.equal(`${canonicalWorldCommandBatchPayload(result)}\n`, bytes.toString('utf8'))
  const altered = Buffer.from(bytes); altered[0] ^= 1
  assert.notEqual(hash(altered), receipt.resultSha256); assert.notEqual(hash(`${canonical} `), receipt.payloadSha256)
  await save(evidence, 'receipt-contract-vectors.json', { instrumentation: LABEL, cpuEvidence: 'NOT_CPU_EVIDENCE',
    local, public: receipt, unicodeBatch, unicodeCanonical, utf16, utf8, resultBody: file,
    canonicalObjectOrder: 'PASS', arrayOrderPreserved: 'PASS', payloadLF: false, storedResultLF: 1 })
}

async function customIds(evidence) {
  const workspace = await mkdtemp('/tmp/modly-worlds-command-profile-new-')
  const allocated = { path: workspace }
  let owned = null, active = null, failure = null, final
  const errors = [], cases = []
  try {
    await save(evidence, 'workspace-provisional.json', { ...allocated, status: 'CREATED_IDENTITY_UNCONFIRMED', policy: 'RETAIN_BY_DESIGN' })
    const initial = await observe(workspace)
    const candidate = { token: randomBytes(16).toString('hex'), path: workspace, dev: initial.dev, ino: initial.ino, uid: initial.uid }
    assert.ok(diagnostic.matchesWorkspaceIdentity(candidate, initial, candidate))
    await save(evidence, 'owned-workspace.json', candidate); await save(evidence, 'workspace-initial.json', { owned: candidate, observed: initial })
    owned = candidate
    const store = diagnostic.createEvidenceBodyStore((name, bytes) => writeFile(join(evidence, name), bytes, { mode: 0o600, flag: 'wx' }))
    for (const [i, sceneId] of ['scene:custom', 'SCENE:custom', 'custom-id', `scene-${'f'.repeat(32)}`].entries()) {
      assert.ok(diagnostic.matchesWorkspaceIdentity(owned, await observe(workspace), owned))
      const service = createWorldProjectService(new WorldProjectRepository({ getWorkspaceRoot: () => workspace }))
      active = createWorldEditorController(service)
      const created = success(await service.create({ name: `Custom ${i}`, initialSceneName: 'Scene', initialSceneId: sceneId }))
      success(await active.openProject(created.projectKey))
      const state = active.getState(), binding = diagnostic.pinSceneBinding(created.projectKey, state.session.snapshot)
      assert.equal(binding.id, sceneId)
      assert.notEqual(binding.documentPath.split('/').at(-1), `${sceneId}.world-scene.json`)
      const commands = buildAddEmptyEntityCommands({ snapshot: state.session.snapshot, projectKey: created.projectKey, activeSceneId: sceneId,
        identities: createDeterministicWorldEditorIdentityGenerator(`contract-custom-${i}`) }, { name: 'Contract entity' })
      const request = { transactionId: `tx:contract-custom:${i}`, origin: 'ui', commands }
      const result = await active.dispatchCommands(request, { projectKey: created.projectKey, projectId: created.snapshot.project.projectId, baseRevision: 0, activeSceneId: sceneId })
      const after = active.getState()
      await save(evidence, `case-${i}-actual.json`, { created, binding, request, result, state: after })
      success(result)
      const disk = await diagnostic.inspectSettled(workspace, created.projectKey, { safeDirectory, readdir, absent,
        readBytes: (path, maximum) => diagnostic.readEvidenceFile(workspace, path, maximum), retainBytes: store.retainBytes,
        recordFile: (file) => appendFile(join(evidence, 'body-custody.jsonl'), `${JSON.stringify({ case: i, ...file })}\n`, { mode: 0o600 }) }, binding)
      await save(evidence, `case-${i}-disk.json`, disk)
      assert.deepEqual(disk.snapshot, after.session.snapshot)
      await auditBodies(evidence, disk); await auditRevisionZero(evidence, disk)
      cases.push({ sceneId, binding, projectKey: created.projectKey, revision: disk.state.committedRevision })
      success(await active.closeProject()); active = null
    }
    await save(evidence, 'body-budget.json', store.budget())
  } catch (error) { failure = error; errors.push({ stage: 'custom-contract', message: error.message }) }
  finally {
    if (active) { try { success(await active.closeProject()) } catch (error) { errors.push({ stage: 'controller-close', message: error.message }) } }
    final = owned ? await diagnostic.finalizeOwnedWorkspace(owned, { settled: !active || !errors.some((error) => error.stage === 'controller-close'), interrupted: false }, {
      observe, readOwnership: () => json(evidence, 'owned-workspace.json'), save: (name, value) => save(evidence, name, value),
    }) : { status: 'CREATED_IDENTITY_UNCONFIRMED', allocated, owned: null }
    if (!owned) await save(evidence, 'workspace-final.json', final)
    await save(evidence, 'custom-contract.json', { instrumentation: LABEL, cpuEvidence: 'NOT_CPU_EVIDENCE', allocated, cases, errors, final })
  }
  if (failure) throw failure
  assert.equal(final.status, 'WORKSPACE_RETAINED_BY_DESIGN'); assert.deepEqual(errors, [])
  return { workspace, cases }
}

test('real default-sync52 and independent scene IDs retain canonical bodies; SYNTHETIC profiler NOT CPU evidence', async (t) => {
  await mkdir(TESTS, { recursive: true, mode: 0o700 }); await safeDirectory(TESTS)
  const evidence = await mkdtemp(join(TESTS, 'contract-'))
  const wrapper = { schema: 'worlds-command-profile-contract-test-v1', instrumentation: LABEL, cpuEvidence: 'NOT_CPU_EVIDENCE',
    performanceAcceptance: 'NOT_ASSESSED', app: 'REAL_CONTROLLER_NORMALIZING_SERVICE_DEFAULT_SYNC_REPOSITORY',
    custody: 'REAL_INSPECTOR_BOUNDED_READER_CAS', evidence, argv: process.argv, execArgv: process.execArgv, status: 'PENDING' }
  await save(evidence, 'contract.json', wrapper)
  t.diagnostic(`Contract evidence: ${evidence}; ${LABEL}; NOT_CPU_EVIDENCE`)
  try {
    wrapper.initialEvidenceIdentity = await observe(evidence)
    const readiness = await diagnostic.collectProfileManifest()
    wrapper.sourceSealSha256 = readiness.sourceSealSha256
    assert.ok(readiness.diagnosticSources.some((file) => file.path === 'scripts/worlds-command-profile.contract.test.mjs'))
    assert.ok(readiness.diagnosticEdges.some((edge) => edge.importer === 'scripts/worlds-command-profile.contract.test.mjs' && edge.target === 'scripts/worlds-command-profile.mjs'))
    await save(evidence, 'contract.json', wrapper)
    const defaultEvidence = join(evidence, 'default'); await mkdir(defaultEvidence, { mode: 0o700 })
    const result = await diagnostic.runDiagnostic(readiness, { createEvidenceDirectory: async () => defaultEvidence, loadInspector: async () => ({ Session: SyntheticSession }) })
    wrapper.defaultResult = result
    await save(evidence, 'contract.json', wrapper)
    const first = await json(defaultEvidence, 'setup-01-observed.json')
    assert.equal(first.snapshot.project.revision, 1); assert.equal(first.snapshot.scenes[0].entities.length, 100)
    t.diagnostic(`Actual first dispatch: revision1/100 entities; ${result.ownedWorkspace.path}; ${result.status}`)
    assert.equal(result.status, 'DIAGNOSTIC_COMPLETE', JSON.stringify(result.errors))
    assert.equal(result.successfulSetup, 32); assert.equal(result.successfulProfiledCommands, 20); assert.equal(result.usableProfiles, 20)
    assert.equal(result.workspaceStatus, 'WORKSPACE_RETAINED_BY_DESIGN')
    const firstDisk = await json(defaultEvidence, 'setup-01-disk.json')
    await auditBodies(defaultEvidence, firstDisk); await auditRevisionZero(defaultEvidence, firstDisk)
    await auditReceipts(defaultEvidence, first, firstDisk)
    const reopened = await json(defaultEvidence, 'reopened-state.json'), disk = await json(defaultEvidence, 'reopened-disk.json')
    assert.equal(reopened.session.snapshot.project.revision, 52)
    for (const name of ['undoStack', 'redoStack', 'receipts']) assert.deepEqual(reopened.session[name], [])
    assert.equal(disk.state.transactions.length, 32); assert.equal(disk.backups.length, 8)
    assert.deepEqual(disk.snapshot, reopened.session.snapshot); await auditBodies(defaultEvidence, disk)
    const customEvidence = join(evidence, 'custom'); await mkdir(customEvidence, { mode: 0o700 })
    wrapper.custom = await customIds(customEvidence)
    wrapper.status = 'CONTRACT_PASS_NOT_CPU_EVIDENCE'
  } catch (error) { wrapper.status = 'INCOMPLETE'; wrapper.error = { name: error.name, message: error.message }; throw error }
  finally { wrapper.finalEvidenceIdentity = await observe(evidence); await save(evidence, 'contract.json', wrapper) }
})
