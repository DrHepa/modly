import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { WorldProjectRepository } from '../../electron/main/world-project-repository.ts'
import { registerWorldProjectsIpcHandlers } from '../../electron/main/world-projects-ipc.ts'
import { applyWorldCommandBatch, canonicalWorldCommandBatchPayload, fingerprintWorldCommandBatch } from '../../src/areas/worlds/core/worldCommands.ts'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { createPhysicsFixtureBatches } from './scene.ts'
import { readPhysicsFixtureView, runPhysicsInteractions } from './driver.ts'
import { ACCEPTANCE_CHANNELS, assertSandboxLaunch, CHECK_NAMES, PROJECT_KEY, SCENE_KEY, SANDBOX_DISABLING_SWITCHES, type PhysicsCheck } from './shared.ts'
import { captureWorkerProjectFiles, readWorkerFixtureView, runWorkerPhysicsInteractions } from './worker-driver.ts'
import { WORKER_BUILD_SCHEMA, WORKER_RUN_SCHEMA, WORKER_SCOPE, WORKER_CHECK_NAMES, type WorkerCheck } from './worker-contract.ts'

import { boundedEntryOperation, createAcceptanceOwner, createDurableEntryWriter, stableEntryJson, validateAcceptanceBuild, verifyEntryCustody } from './acceptance-entry.ts'

const entryStartedMs = performance.now()
assertSandboxLaunch(process.argv, process.env)
assert.equal(process.argv.some(value => value.startsWith('--acceptance-phase')), false, 'Acceptance phase is bound only to the verified build declaration.')
for (const flag of SANDBOX_DISABLING_SWITCHES) assert.equal(app.commandLine.hasSwitch(flag), false, `Refusing active sandbox-disabling switch: ${flag}`)
const bundleDirectory = realpathSync(__dirname)
assert.equal(bundleDirectory, path.resolve(__dirname))
assert.equal(path.dirname(bundleDirectory), '/tmp')
assert.match(path.basename(bundleDirectory), /^modly-worlds-physics-(?:ui|worker)-/)
assert.equal(lstatSync(bundleDirectory).mode & 0o777, 0o700)
if (process.getuid) assert.equal(lstatSync(bundleDirectory).uid, process.getuid())
const build = JSON.parse(readFileSync(path.join(bundleDirectory, 'fixture-build.json'), 'utf8'))
const workerOnly = build.schema === WORKER_BUILD_SCHEMA
const entryDeclaration = validateAcceptanceBuild(build)
if (entryDeclaration) assert.ok(workerOnly, 'Acceptance requires the Worker build schema.')
assert.equal(build.schema, workerOnly ? WORKER_BUILD_SCHEMA : 'modly.worlds-physics-ui-build.v1')
assert.equal(build.scope, workerOnly ? WORKER_SCOPE : 'source-level-physics-play-phase1')
assert.match(path.basename(bundleDirectory), workerOnly ? /^modly-worlds-physics-worker-/ : /^modly-worlds-physics-ui-/)
if (workerOnly) assert.equal(build.lane, 'worker-only')
assert.equal(build.execution, 'NOT_RUN')
assert.equal(build.outputDirectory, bundleDirectory)
for (const [relative, expected] of Object.entries(build.outputs) as Array<[string, { sha256: string; bytes: number }]>) {
  const absolute = path.resolve(bundleDirectory, relative)
  assert.ok(absolute.startsWith(`${bundleDirectory}${path.sep}`))
  assert.equal(realpathSync(absolute), absolute)
  const bytes = readFileSync(absolute)
  assert.equal(bytes.length, expected.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, `Built file changed: ${relative}`)
}
const runDirectory = mkdtempSync(path.join(bundleDirectory, 'run-'))
const workspace = path.join(runDirectory, 'workspace')
const userData = path.join(runDirectory, 'userData')
const sessionData = path.join(runDirectory, 'sessionData')
const crashDumps = path.join(runDirectory, 'crashDumps')
for (const directory of [workspace, userData, sessionData, crashDumps]) mkdirSync(directory, { mode: 0o700 })
// These private paths and sandbox settings must precede Electron readiness.
app.setName(workerOnly ? 'Worlds Worker-only Physics Fixture' : 'Worlds Physics Fixture')
app.setPath('userData', userData)
app.setPath('sessionData', sessionData)
app.setPath('crashDumps', crashDumps)
app.enableSandbox()
app.on('window-all-closed', () => {})

const checks: Array<PhysicsCheck | WorkerCheck> = (workerOnly ? WORKER_CHECK_NAMES : CHECK_NAMES).map((name) => ({ name, status: 'UNREACHED', reason: 'Not yet executed.' }))
const rendererErrors: string[] = []
const blockedRequests: string[] = []
const report: Record<string, unknown> = {
  schema: workerOnly ? WORKER_RUN_SCHEMA : 'modly.worlds-physics-ui-run.v1', scope: workerOnly ? WORKER_SCOPE : 'source-level-physics-play-phase1', status: 'RUNNING',
  included: workerOnly ? ['programmatic-public-Play-API', 'authored-input-sampler', 'real-Rapier-Worker', 'sandboxed-production-IPC-repository']
    : ['production-Play-controller', 'production-ProjectBar', 'production-WorldRuntimeViewport', 'real-Rapier-Worker', 'sandboxed-production-IPC-repository'],
  excluded: [...(workerOnly ? ['native-keyboard', 'production-viewport', 'graphics-gameplay', 'screenshots'] : []), 'visible-asset-quality', 'audio-output', 'full-Workbench', '500-bodies', 'step-timings', '50-cycles', 'packaged-application'],
  anticipatedFailure: 'Rapier default active collision types exclude the kinematic Character / fixed sensor pair. This is not an accepted PASS condition.',
  startedAt: new Date().toISOString(), runDirectory, workspace, userData, sessionData, pid: process.pid,
  versions: process.versions, build, checks, rendererErrors, blockedRequests,
  launch: { argv: [...process.argv], sandboxDisablingSwitches: Object.fromEntries(SANDBOX_DISABLING_SWITCHES.map((flag) => [flag, app.commandLine.hasSwitch(flag)])) },
}
const reportPath = path.join(runDirectory, entryDeclaration ? 'acceptance-report.json' : workerOnly ? 'worker-fixture-report.json' : 'fixture-report.json')
const persistEntry = createDurableEntryWriter({
  openFile: name => open(path.join(runDirectory, name), 'wx', 0o600),
  async syncDirectory() { const directory = await open(runDirectory, 'r'); try { await directory.sync() } finally { await directory.close() } },
})
let entryOwner: ReturnType<typeof createAcceptanceOwner> | null = null
let entryAuthorDeadlineMs = 0
let entryCancel: (() => void) | null = null
let entryClaimed!: () => void, entryBaselineCaptured!: () => void
const entryClaim = new Promise<void>(resolve => { entryClaimed = resolve })
const entryBaseline = new Promise<void>(resolve => { entryBaselineCaptured = resolve })
if (entryDeclaration) Object.assign(report, { schema: 'modly.worlds-physics-acceptance-entry.v1', scope: 'fixture-model-functional-entry', nativeAccepted: false,
  acceptance: entryDeclaration, checks: [], included: ['canonical504-body-authoring', 'Canvas-free-real-Play-pump', 'durable-terminal-receipt', 'independent-project-ledger-backup-custody'],
  excluded: ['native-performance-acceptance', 'Worker-WASM-memory-release', 'Character-course-acceptance', 'graphics', 'packaged-application'], anticipatedFailure: null })
const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
let fixtureWindow: BrowserWindow | null = null
let workerBaseline: { snapshot: WorldProjectSnapshotV1; files: Awaited<ReturnType<typeof captureWorkerProjectFiles>> } | null = null
const projectRoot = path.join(workspace, 'Worlds', PROJECT_KEY)

async function recordIndependentWorkerDurability(): Promise<void> {
  const entry: WorkerCheck = { name: 'independent-durable-reopen', status: 'UNREACHED' }
  try {
    // Never condition these reads on a live renderer, successful Stop, or a DOM assertion.
    const beforeReopen = await captureWorkerProjectFiles(projectRoot)
    const reopened = await new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: PROJECT_KEY })
    assert.ok(reopened.ok && reopened.value.status === 'ready', JSON.stringify(reopened))
    const afterReopen = await captureWorkerProjectFiles(projectRoot)
    assert.ok(workerBaseline, 'No complete pre-Play durable baseline was captured; isolation is unproved.')
    assert.deepEqual(reopened.value.snapshot, workerBaseline.snapshot)
    assert.deepEqual(beforeReopen, workerBaseline.files, 'Durable document or transaction ledger changed during Play.')
    assert.deepEqual(afterReopen, workerBaseline.files, 'Independent reopen changed durable project bytes.')
    entry.status = 'PASS'
    entry.evidence = { snapshot: reopened.value.snapshot, stableFiles: afterReopen, rendererRequired: false }
  } catch (cause) {
    entry.status = 'FAIL'; entry.reason = cause instanceof Error ? cause.message : String(cause)
  }
  checks[checks.findIndex(candidate => candidate.name === entry.name)] = entry
}
const watchdog = entryDeclaration ? setTimeout(() => {
  // A hard exit cannot claim settled audio/quiet, independent reopen or receipt acknowledgement.
  const emergency = { status: 'PARTIAL', nativeAccepted: false, settled: false, independentReopen: 'UNESTABLISHED',
    error: 'Whole-entry hard deadline exceeded; retained input/project/terminal files are authoritative.', runDirectory, finishedAt: new Date().toISOString() }
  try {
    const file = openSync(path.join(runDirectory, 'acceptance-hard-timeout.json'), 'wx', 0o600)
    try { writeFileSync(file, stableEntryJson(emergency)); fsyncSync(file) } finally { closeSync(file) }
    const directory = openSync(runDirectory, 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch (cause) { console.error('Acceptance emergency evidence persistence failed:', cause) }
  finally { app.exit(1) }
}, Math.max(0, entryStartedMs + entryDeclaration.mainMs - performance.now())) : setTimeout(() => {
  Object.assign(report, { status: 'FAIL', error: 'Physics fixture exceeded its 125 second deadline.', finishedAt: new Date().toISOString() })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  app.exit(1)
}, 125_000)
console.log(`worlds-physics-fixture: evidence=${runDirectory}`)

async function run(): Promise<void> {
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => PROJECT_KEY, createSceneKey: () => SCENE_KEY })
  const created = await repository.create({ name: 'Real physics fixture', initialSceneName: 'Physics course', projectId: 'project:physics-fixture', initialSceneId: 'scene:physics-fixture' })
  assert.ok(created.ok, JSON.stringify(created))
  let authored = created.value.snapshot
  const entryBatches = createPhysicsFixtureBatches(authored, PROJECT_KEY, entryDeclaration ? 'acceptance-500' : undefined)
  const expectedHistory: Array<{ transactionId: string; beforeRevision: number; afterRevision: number }> = []
  const expectedReceipts: Array<{ transactionId: string; fingerprint: string; canonicalPayload: string; appliedRevision: number }> = []
  for (const batch of entryBatches) {
    if (workerOnly) {
      // Predict the same course without writing it: the worker renderer authors through the real editor.
      const preview = applyWorldCommandBatch(authored, batch)
      assert.ok(preview.success, JSON.stringify(preview))
      expectedHistory.push({ transactionId: batch.transactionId, beforeRevision: authored.project.revision, afterRevision: preview.snapshot.project.revision })
      expectedReceipts.push({ transactionId: batch.transactionId, fingerprint: fingerprintWorldCommandBatch(batch), canonicalPayload: canonicalWorldCommandBatchPayload(batch), appliedRevision: preview.snapshot.project.revision })
      authored = preview.snapshot
    } else {
      const applied = await repository.applyCommands({ projectKey: PROJECT_KEY, batch })
      assert.ok(applied.ok, JSON.stringify(applied))
      authored = applied.value.snapshot
    }
  }
  report[workerOnly ? 'expectedAuthoredSnapshot' : 'authoredSnapshot'] = authored
  if (entryDeclaration) await persistEntry('acceptance-inputs.json', stableEntryJson({ initialSnapshot: created.value.snapshot, canonicalSeedBatches: entryBatches, expectedSnapshot: authored, nativeAccepted: false }))
  else await persist()
  await app.whenReady()
  const isolatedSession = session.fromPartition(`worlds-physics-fixture-${path.basename(bundleDirectory)}-${path.basename(runDirectory)}`)
  const filePrefix = pathToFileURL(`${bundleDirectory}${path.sep}`).href
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(filePrefix) || details.url === 'about:blank'
    if (!allowed && blockedRequests.length < 32) blockedRequests.push(details.url.slice(0, 2048))
    callback({ cancel: !allowed })
  })
  const requestedWebPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false } as const
  report.requestedWebPreferences = requestedWebPreferences
  const window = new BrowserWindow({
    title: workerOnly ? 'Worlds Worker-only physics fixture — isolated' : 'Worlds physics fixture — isolated', width: 1120, height: 940, show: true,
    webPreferences: { preload: path.join(bundleDirectory, 'preload.cjs'), session: isolatedSession, ...requestedWebPreferences, backgroundThrottling: false },
  })
  fixtureWindow = window
  registerWorldProjectsIpcHandlers(ipcMain, repository, {
    isTrustedSender: (value) => {
      const event = value as Electron.IpcMainInvokeEvent
      return !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    },
  })
  if (entryDeclaration) {
    const context = { ...entryDeclaration, token: randomBytes(32).toString('hex') }
    entryOwner = createAcceptanceOwner(context, {
      sender: window.webContents, get frame() { return window.webContents.mainFrame }, startedMs: entryStartedMs, now: () => performance.now(), isLive: () => !window.isDestroyed(), persist: persistEntry,
      async captureBaseline(payload) {
        await boundedEntryOperation((async () => {
          const value = payload as { session: { snapshot: WorldProjectSnapshotV1; undoStack: unknown; redoStack: unknown; receipts: unknown }; canvasCount: number;
            environment: { sandboxed: boolean; contextIsolated: boolean }; requireType: string; processType: string }
          assert.equal(value.canvasCount, 0); assert.equal(value.environment.sandboxed, true); assert.equal(value.environment.contextIsolated, true)
          assert.equal(value.requireType, 'undefined'); assert.equal(value.processType, 'undefined')
          assert.deepEqual(value.session.snapshot, authored); assert.deepEqual(value.session.undoStack, expectedHistory)
          assert.deepEqual(value.session.redoStack, []); assert.deepEqual(value.session.receipts, expectedReceipts)
          const files = await captureWorkerProjectFiles(projectRoot)
          const reopened = await new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: PROJECT_KEY })
          assert.ok(reopened.ok && reopened.value.status === 'ready', JSON.stringify(reopened)); assert.deepEqual(reopened.value.snapshot, authored)
          const after = await captureWorkerProjectFiles(projectRoot); assert.deepEqual(after, files)
          const ledger = JSON.parse(readFileSync(path.join(projectRoot, '.modly/state.v1.json'), 'utf8'))
          assert.equal(ledger.committedRevision, 23); assert.equal(ledger.transactions.length, 23)
          assert.deepEqual(ledger.transactions.map((row: { transactionId: string; canonicalPayload: string; appliedRevision: number }) => ({ transactionId: row.transactionId, canonicalPayload: row.canonicalPayload, appliedRevision: row.appliedRevision })),
            expectedReceipts.map(({ transactionId, canonicalPayload, appliedRevision }) => ({ transactionId, canonicalPayload, appliedRevision })))
          await persistEntry('acceptance-baseline.json', stableEntryJson({ snapshot: authored, files, editorHistory: value.session.undoStack,
            receipts: expectedReceipts, seedBatches: entryBatches, historyRepresentation: 'canonical-seed-batches-and-revision-edges; full session equality checked locally by protected pump' }))
          workerBaseline = { snapshot: structuredClone(authored), files }
          entryBaselineCaptured()
        })(), Math.max(1, entryAuthorDeadlineMs - performance.now()), 'Acceptance authoring/baseline custody')
      },
    })
    const identity = (event: Electron.IpcMainInvokeEvent) => ({ sender: event.sender, frame: event.senderFrame })
    ipcMain.handle(ACCEPTANCE_CHANNELS.context, event => {
      const claimed = entryOwner!.claim(identity(event))
      assert.ok(performance.now() < entryStartedMs + entryDeclaration.startupMs, 'Acceptance startup exceeded12s.')
      entryAuthorDeadlineMs = performance.now() + entryDeclaration.authorMs
      entryClaimed()
      return claimed
    })
    ipcMain.handle(ACCEPTANCE_CHANNELS.request, (event, raw) => entryOwner!.invoke(identity(event), raw))
    ipcMain.handle(ACCEPTANCE_CHANNELS.receipt, (event, raw) => entryOwner!.receipt(identity(event), raw))
    report.cancelAuthority = { tokenPrivate: true, phase: context.phase }
    const cancel = () => { if (!window.isDestroyed()) window.webContents.send(ACCEPTANCE_CHANNELS.cancel, { token: context.token, phase: context.phase }) }
    entryCancel = cancel
  } else {
    ipcMain.handle(ACCEPTANCE_CHANNELS.context, event => {
      assert.ok(!window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame)
      return null // Legacy worker authoring uses the unchanged four-body course.
    })
  }
  const indexPath = path.join(bundleDirectory, 'renderer', workerOnly ? 'worker-index.html' : 'index.html')
  const indexUrl = pathToFileURL(indexPath).href
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== indexUrl) event.preventDefault() })
  const rendererFailure = new Promise<never>((_resolve, reject) => {
    window.webContents.on('render-process-gone', (_event, details) => reject(new Error(`Fixture renderer exited: ${details.reason}`)))
    window.webContents.on('preload-error', (_event, _preloadPath, error) => reject(error))
    window.on('unresponsive', () => reject(new Error('Fixture window became unresponsive.')))
    window.on('closed', () => reject(new Error('Fixture window closed before completion.')))
  })
  // Keep late window lifecycle rejections handled after the awaited race has settled.
  void rendererFailure.catch(() => undefined)
  window.webContents.on('console-message', (details) => { if (details.level === 'error' && rendererErrors.length < 64) rendererErrors.push(details.message.slice(0, 4096)) })
  const loaded = Promise.race([window.loadFile(indexPath), rendererFailure])
  if (entryDeclaration) await boundedEntryOperation(loaded, Math.max(1, entryStartedMs + entryDeclaration.startupMs - performance.now()), 'Acceptance renderer load')
  else await loaded
  if (entryDeclaration) {
    await boundedEntryOperation(Promise.race([entryClaim, rendererFailure]), Math.max(1, entryStartedMs + entryDeclaration.startupMs - performance.now()), 'Acceptance startup')
    await boundedEntryOperation(Promise.race([entryBaseline, entryOwner!.received, rendererFailure]), Math.max(1, entryAuthorDeadlineMs - performance.now()), 'Acceptance authoring/baseline')
    const phaseEnd = entryStartedMs + entryDeclaration.startupMs + entryDeclaration.authorMs + entryDeclaration.pumpMs
    await boundedEntryOperation(Promise.race([entryOwner!.received, rendererFailure]), Math.max(1, phaseEnd - performance.now()), 'Acceptance startup/author/pump/receipt')
    report.terminalReceipt = { ...entryOwner!.state(), terminal: 'acceptance-terminal.json' }
    return
  }
  if (workerOnly) {
    const result = await runWorkerPhysicsInteractions(window.webContents, async (entry) => {
      const index = checks.findIndex(candidate => candidate.name === entry.name)
      assert.ok(index >= 0)
      checks[index] = entry
      await persist()
    }, async (view) => {
      assert.ok(view.editorSession)
      assert.deepEqual(view.editorSession.snapshot, authored)
      const reopened = await new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: PROJECT_KEY })
      assert.ok(reopened.ok && reopened.value.status === 'ready', JSON.stringify(reopened))
      assert.deepEqual(reopened.value.snapshot, authored)
      const files = await captureWorkerProjectFiles(projectRoot)
      const ledger = JSON.parse(readFileSync(path.join(projectRoot, '.modly/state.v1.json'), 'utf8'))
      assert.equal(ledger.committedRevision, 13); assert.equal(ledger.transactions.length, 13)
      workerBaseline = { snapshot: structuredClone(authored), files }
      report.authoredSnapshot = authored
      report.editorBaselineSession = view.editorSession
      report.durableBaseline = files
    }, rendererFailure)
    Object.assign(report, { finalView: result.finalView, error: result.error })
    return
  }
  window.show(); window.focus(); window.webContents.focus()
  assert.equal(window.isFocused(), true, 'Native fixture input requires its own focused window.')
  const result = await Promise.race([runPhysicsInteractions(window.webContents, async (entry) => {
    const index = checks.findIndex((candidate) => candidate.name === entry.name)
    assert.ok(index >= 0)
    checks[index] = entry
    await persist()
  }, async (expected) => {
    assert.deepEqual(expected, authored)
    const reader = new WorldProjectRepository({ getWorkspaceRoot: () => workspace })
    const reopened = await reader.open({ projectKey: PROJECT_KEY })
    assert.ok(reopened.ok && reopened.value.status === 'ready', JSON.stringify(reopened))
    assert.deepEqual(reopened.value.snapshot, authored, 'Play must never persist runtime transforms or change the revision.')
  }), rendererFailure])
  Object.assign(report, { finalView: result.finalView, error: result.error,
    status: result.checks.every((entry) => entry.status === 'PASS') && rendererErrors.length === 0 && blockedRequests.length === 0 ? 'PASS' : 'FAIL' })
  await writeFile(path.join(runDirectory, 'final.png'), (await window.webContents.capturePage()).toPNG())
}

void run().catch(async (error: unknown) => {
  Object.assign(report, { status: 'FAIL', error: error instanceof Error ? error.stack ?? error.message : String(error) })
  if (entryDeclaration) {
    entryCancel?.()
    try { if (entryOwner) await boundedEntryOperation(entryOwner.received, entryDeclaration.cancelMs, 'Acceptance cancellation/terminal receipt') } catch { /* An unsettled cancellation stays partial. */ }
    try { await entryOwner?.forcePartial(String(report.error)) } catch (cause) { report.terminalPersistenceError = String(cause) }
    report.status = 'PARTIAL'
    return
  }
  if (fixtureWindow && !fixtureWindow.isDestroyed()) {
    try { report.failureView = await (workerOnly ? readWorkerFixtureView(fixtureWindow.webContents) : readPhysicsFixtureView(fixtureWindow.webContents)) } catch { /* Preserve the first failure. */ }
    if (!workerOnly) try { await writeFile(path.join(runDirectory, 'failure.png'), (await fixtureWindow.webContents.capturePage()).toPNG()) } catch { /* Preserve the first failure. */ }
  }
}).finally(async () => {
  if (entryDeclaration) {
    try {
      report.independentCustody = await boundedEntryOperation(verifyEntryCustody(workerBaseline, {
        capture: () => captureWorkerProjectFiles(projectRoot), reopen: () => new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: PROJECT_KEY }),
      }), entryDeclaration.reopenMs, 'Independent acceptance reopen/custody')
    } catch (cause) { report.independentCustody = { unchanged: false, error: String(cause), retainedObservation: cause instanceof Error ? cause.cause ?? null : null }; report.error ??= String(cause) }
    report.status = entryOwner?.state().functionalComplete && entryOwner.state().receiptReceived && report.error == null
      && rendererErrors.length === 0 && blockedRequests.length === 0 ? 'FUNCTIONAL_COMPLETE' : 'PARTIAL'
    report.nativeAccepted = false; report.finishedAt = new Date().toISOString()
    let entryExitCode = 1
    try {
      await boundedEntryOperation(persistEntry('acceptance-report.json', stableEntryJson(report)), entryDeclaration.graceMs, 'Acceptance final report durability')
      if (report.status === 'FUNCTIONAL_COMPLETE') entryExitCode = 0
    } catch (cause) {
      report.status = 'PARTIAL'; report.finalReportPersistenceError = String(cause); report.error ??= String(cause)
      console.error('Acceptance final report persistence failed:', cause)
    } finally { if (fixtureWindow && !fixtureWindow.isDestroyed()) fixtureWindow.destroy(); app.exit(entryExitCode) }
    return
  }
  if (workerOnly) {
    await recordIndependentWorkerDurability()
    for (const entry of checks) if (entry.status === 'UNREACHED') entry.reason ??= String(report.error ?? 'Prerequisite was not reached.')
    report.status = checks.every(entry => entry.status === 'PASS') && report.error == null && rendererErrors.length === 0 && blockedRequests.length === 0 ? 'PASS' : 'FAIL'
  }
  clearTimeout(watchdog)
  report.finishedAt = new Date().toISOString()
  try { await persist(); console.log(`worlds-physics-fixture: ${report.status}; report=${reportPath}`) }
  finally { if (fixtureWindow && !fixtureWindow.isDestroyed()) fixtureWindow.destroy(); app.exit(report.status === 'PASS' ? 0 : 1) }
})
