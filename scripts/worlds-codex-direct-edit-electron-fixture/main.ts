import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, readFile, realpath, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { app, BrowserWindow, ipcMain, session as electronSession, type IpcMainInvokeEvent } from 'electron'

import { WorldProjectRepository } from '../../electron/main/world-project-repository.ts'
import { registerWorldProjectsIpcHandlers } from '../../electron/main/world-projects-ipc.ts'
import { registerWorldsCliEditorContextBroker } from '../../electron/main/worlds-cli-ipc.ts'
import { registerWorldsCliReadinessBroker } from '../../electron/main/worlds-cli-readiness-broker.ts'
import { registerWorldsCliDirectEditBroker } from '../../electron/main/worlds-cli-direct-edit-broker.ts'
import { createWorldsCliDirectEditDispatch } from '../../electron/main/worlds-cli-direct-edit-dispatch.ts'
import { WorldsCliTransport, type WorldsCliEditorScope } from '../../electron/main/worlds-cli-transport.ts'
import { getMainWindowDocumentEpoch, installMainWindowNavigationGuard, isTrustedWorldsCliSender } from '../../electron/main/worlds-cli-window-trust.ts'
import {
  activateLeaveWorlds,
  activateProductionUndo,
  captureScreenshot,
  reloadAndWaitRestored,
  scanVisibleWorkbench,
  waitForAppliedEditor,
  waitForInitialEditor,
  waitForLostReplyReconciliation,
  waitForNavigationComplete,
  waitForUndoRestored,
} from './driver.ts'
import { inspectWorldRaw } from './inspection.ts'
import {
  FIXTURE_SCENARIOS,
  NATIVE_LABELS,
  OVERALL_NATIVE_LABEL,
  PROJECT_ID,
  PROJECT_KEY,
  RENAMED_ENTITY_NAME,
  SANDBOX_DISABLING_SWITCHES,
  SCENE_ID,
  SCENE_KEY,
  TARGET_ENTITY_ID,
  TARGET_ENTITY_NAME,
  assertFixtureLaunch,
  type FixtureBuildManifest,
  type FixtureEvent,
  type FixtureScenario,
  type FixtureStartup,
  type UdsTranscriptEntry,
} from './shared.ts'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type SafeRecord = Record<string, unknown>
type RuntimeReport = {
  schema: 'modly.worlds-codex-direct-edit-native-evidence.v1'
  status: 'PASS'
  label: string
  scenario: FixtureScenario
  inboundFrames: 5
  outboundFrames: 5
  counters: Record<string, number>
  h0: Awaited<ReturnType<typeof inspectWorldRaw>>
  h1: Awaited<ReturnType<typeof inspectWorldRaw>>
  h2: Awaited<ReturnType<typeof inspectWorldRaw>> | null
  transcript: UdsTranscriptEntry[]
  events: FixtureEvent[]
  observations: unknown[]
  controllerViews: Record<string, unknown>
  domScans: Record<string, unknown>
  commitReceipts: unknown[]
  adoptionReceipts: unknown[]
}

const DIRECT_CHANNELS = {
  readinessResponse: 'workspace:worlds:cli:directEditReadinessResponse',
  readinessCancel: 'workspace:worlds:cli:directEditReadinessCancel',
  commit: 'workspace:worlds:cli:directEditCommit',
  cancel: 'workspace:worlds:cli:directEditCancel',
  adopt: 'workspace:worlds:cli:directEditAdopt',
} as const
const OPERATIONS = ['pair', 'plan', 'query', 'ack', 'propose'] as const
const SCENARIO_ORDER = ['primary', 'duplicate-loss', 'cancellation'] as const
const execFileAsync = promisify(execFile)

function digest(bytes: Buffer | string): { bytes: number; sha256: string } {
  const value = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
  return { bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') }
}

function exactResponse(value: unknown): SafeRecord {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as SafeRecord
}

function correlation(value: unknown): { nonce: string; editIntent: string } {
  const record = exactResponse(value)
  assert.deepEqual(Object.keys(record).sort(), ['editIntent', 'nonce'])
  assert.match(String(record.nonce), /^[a-f0-9]{48}$/)
  assert.match(String(record.editIntent), /^edit_[a-f0-9]{48}$/)
  return { nonce: String(record.nonce), editIntent: String(record.editIntent) }
}

async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await chmod(filename, 0o600)
}

async function writePrivateText(filename: string, value: string): Promise<void> {
  await writeFile(filename, value, { flag: 'wx', mode: 0o600 })
  await chmod(filename, 0o600)
}

async function readGitCustody(repositoryRoot: string, privateHome: string) {
  const options = { cwd: repositoryRoot, encoding: 'buffer' as const, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: privateHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C.UTF-8' } }
  const [{ stdout: head }, { stdout: branch }, { stdout: porcelain }] = await Promise.all([
    execFileAsync('/usr/bin/git', ['rev-parse', 'HEAD'], options),
    execFileAsync('/usr/bin/git', ['rev-parse', '--abbrev-ref', 'HEAD'], options),
    execFileAsync('/usr/bin/git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options),
  ])
  return { head: head.toString().trim(), branch: branch.toString().trim(), porcelain: digest(porcelain) }
}

async function wire(socketPath: string, operation: string, request: SafeRecord,
  transcript: UdsTranscriptEntry[], rawFrames: Array<{ direction: 'inbound' | 'outbound'; operation: string; body: string }>): Promise<SafeRecord> {
  const body = Buffer.from(JSON.stringify(request))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  const inbound = digest(body)
  rawFrames.push({ direction: 'inbound', operation, body: body.toString('utf8') })
  transcript.push({ sequence: transcript.length + 1, direction: 'inbound', operation,
    bytes: inbound.bytes, sha256: inbound.sha256, safe: { ...request, code: request.code ? '[REDACTED]' : undefined,
      session: request.session ? '[REDACTED]' : undefined } })
  const response = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(socketPath)
    const chunks: Buffer[] = []
    let expected = -1
    socket.setTimeout(4_000, () => { socket.destroy(); reject(new Error(`UDS ${operation} timed out.`)) })
    socket.once('error', reject)
    socket.once('connect', () => socket.write(Buffer.concat([header, body])))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const combined = Buffer.concat(chunks)
      if (expected < 0 && combined.length >= 4) expected = combined.readUInt32BE(0)
      if (expected >= 0 && combined.length >= expected + 4) {
        socket.end()
        resolve(combined.subarray(4, expected + 4))
      }
    })
  })
  const parsed = exactResponse(JSON.parse(response.toString('utf8')))
  const outbound = digest(response)
  rawFrames.push({ direction: 'outbound', operation, body: response.toString('utf8') })
  transcript.push({ sequence: transcript.length + 1, direction: 'outbound', operation,
    bytes: outbound.bytes, sha256: outbound.sha256, safe: operation === 'pair' && parsed.session
      ? { ...parsed, session: '[REDACTED]' } : parsed })
  return parsed
}

function assertNoUnsafeSwitches(): void {
  app.enableSandbox()
  for (const flag of SANDBOX_DISABLING_SWITCHES) assert.equal(app.commandLine.hasSwitch(flag), false, flag)
  // Keep exact audited spellings visible to source review: no-sandbox, disable-setuid-sandbox,
  // disable-gpu-sandbox, disable-web-security.
}

async function seedRepository(workspace: string): Promise<{ repository: WorldProjectRepository; baseRevision: number }> {
  const repository = new WorldProjectRepository({
    getWorkspaceRoot: () => workspace,
    createProjectKey: () => PROJECT_KEY,
    createSceneKey: () => SCENE_KEY,
  })
  const created = await repository.create({ name: 'C3 native fixture', initialSceneName: 'Fixture scene',
    projectId: PROJECT_ID, initialSceneId: SCENE_ID })
  assert.ok(created.ok)
  const seeded = await repository.applyCommands({ projectKey: PROJECT_KEY, batch: {
    schema: 'modly.world-command-batch.v1',
    transactionId: 'fixture-seed-target',
    projectId: PROJECT_ID,
    baseRevision: 0,
    origin: 'ui',
    commands: [{ type: 'add-entity', sceneId: SCENE_ID, entity: {
      id: TARGET_ENTITY_ID,
      name: TARGET_ENTITY_NAME,
      parentId: null,
      enabled: true,
      locked: false,
      tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [],
    } }],
  } })
  assert.ok(seeded.ok)
  return { repository, baseRevision: 1 }
}

async function runScenario(startup: FixtureStartup, scenario: FixtureScenario): Promise<RuntimeReport> {
  const paths = startup.launch.scenarios[scenario]
  const { repository, baseRevision } = await seedRepository(paths.workspace)
  const h0 = await inspectWorldRaw(paths.workspace, PROJECT_KEY)
  const events: FixtureEvent[] = []
  const transcript: UdsTranscriptEntry[] = []
  const rawFrames: Array<{ direction: 'inbound' | 'outbound'; operation: string; body: string }> = []
  const observations: unknown[] = []
  const counters = { requests: 0, deliveries: 0, commits: 0, cancels: 0, adopts: 0, readiness: 0 }
  const commitAttemptsByIntent = new Map<string, number>()
  const commitReceipts: unknown[] = []
  const adoptionReceipts: unknown[] = []
  const controllerViews: Record<string, unknown> = {}
  const domScans: Record<string, unknown> = {}
  const event = (type: string, detail?: unknown) => events.push({ sequence: events.length + 1, at: Date.now(), scenario, type,
    ...(detail === undefined ? {} : { detail }) })
  let currentWindow: BrowserWindow | null = null
  const trustedRendererUrl = pathToFileURL(path.join(startup.bundleDirectory, 'renderer/index.html')).href
  const handlers = new Set<string>()
  let heldCommitRelease: (() => void) | null = null
  let heldCommitCorrelation: { nonce: string; editIntent: string } | null = null
  const heldCommit = new Promise<void>((resolve) => { heldCommitRelease = resolve })
  const register = {
    handle(channel: string, handler: InvokeHandler) {
      handlers.add(channel)
      ipcMain.handle(channel, async (ipcEvent, ...args) => {
        if (channel === DIRECT_CHANNELS.readinessResponse || channel === DIRECT_CHANNELS.readinessCancel) counters.readiness += 1
        if (channel === DIRECT_CHANNELS.commit) {
          counters.commits += 1
          const captured = correlation(args[0])
          commitAttemptsByIntent.set(captured.editIntent, (commitAttemptsByIntent.get(captured.editIntent) ?? 0) + 1)
          if (scenario === 'cancellation') heldCommitCorrelation = captured
          event(scenario === 'cancellation' ? 'commit-attempt-held' : 'commit-attempt', captured)
          if (scenario === 'cancellation') await heldCommit
        }
        if (channel === DIRECT_CHANNELS.cancel) {
          counters.cancels += 1
          const captured = correlation(args[0])
          assert.deepEqual(captured, heldCommitCorrelation)
          event('direct-cancel-ipc', captured)
          const result = exactResponse(await handler(ipcEvent, ...args))
          assert.equal(result.ok, true)
          assert.equal(result.status === 'STALE', true)
          event('cancel-ack-stale', { correlation: captured, result })
          heldCommitRelease?.()
          return result
        }
        if (channel === DIRECT_CHANNELS.adopt) { counters.adopts += 1; adoptionReceipts.push({ request: args[0] }) }
        const result = exactResponse(await handler(ipcEvent, ...args))
        if (channel === DIRECT_CHANNELS.commit) {
          if (scenario === 'cancellation') {
            assert.equal(result.ok, false)
            assert.equal(result.code === 'STALE', true)
            event('held-commit-returns-stale', { correlation: heldCommitCorrelation, result })
          } else commitReceipts.push(result)
        }
        if (channel === DIRECT_CHANNELS.adopt) adoptionReceipts[adoptionReceipts.length - 1] = {
          ...(adoptionReceipts.at(-1) as SafeRecord), result,
        }
        return result
      })
    },
  }
  registerWorldProjectsIpcHandlers(register, repository, { isTrustedSender: (value) => {
    const ipcEvent = value as IpcMainInvokeEvent
    return !!currentWindow && ipcEvent.sender === currentWindow.webContents
      && ipcEvent.senderFrame === currentWindow.webContents.mainFrame
  } })
  const getWindow = () => currentWindow
  const editorBroker = registerWorldsCliEditorContextBroker(register, { getWindow, trustedRendererUrl })
  const readinessBroker = registerWorldsCliReadinessBroker(register, { getWindow, trustedRendererUrl })
  const directEditBroker = registerWorldsCliDirectEditBroker(register, {
    getWindow,
    trustedRendererUrl,
    getWorkspaceRoot: () => paths.workspace,
    readiness: readinessBroker,
    repository,
  })
  let transport: WorldsCliTransport | null = null
  const dispatchDirectEdit = createWorldsCliDirectEditDispatch(() => transport, directEditBroker)
  const captureTrust = () => {
    const window = currentWindow
    if (!window || !isTrustedWorldsCliSender({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, window, trustedRendererUrl)) return null
    return { window, contents: window.webContents, frame: window.webContents.mainFrame, documentUrl: trustedRendererUrl,
      documentEpoch: getMainWindowDocumentEpoch(window.webContents), workspaceRoot: paths.workspace }
  }
  const readScope = async (): Promise<WorldsCliEditorScope | null> => {
    const trust = captureTrust()
    if (!trust) return null
    const context = await editorBroker.request()
    if (!context || captureTrust()?.window !== trust.window) return null
    const canonicalWorkspace = await realpath(paths.workspace)
    const opened = await repository.open({ projectKey: context.projectKey })
    if (!opened.ok || opened.value.status !== 'ready' || opened.value.snapshot.project.projectId !== context.projectId
      || opened.value.snapshot.project.revision !== context.revision
      || !opened.value.snapshot.project.scenes.some((entry) => entry.id === context.sceneId)) return null
    return { ...context, trust, canonicalWorkspace }
  }
  transport = new WorldsCliTransport({ repository, runtimeDir: paths.runtime, captureTrust,
    activeEditorScope: readScope, dispatchDirectEditProposal: dispatchDirectEdit,
    onPairRequest: async () => ({ ok: false }) })

  const observed = (ipcEvent: Electron.IpcMainEvent, value: unknown) => {
    if (!currentWindow || ipcEvent.sender !== currentWindow.webContents
      || ipcEvent.senderFrame !== currentWindow.webContents.mainFrame) return
    const record = exactResponse(value)
    observations.push(record)
    if (record.type === 'navigation-request' || record.type === 'navigation-complete') event(record.type, record)
    else event('renderer-observation', record)
  }
  const config = (ipcEvent: Electron.IpcMainEvent) => { ipcEvent.returnValue = { scenario } }
  ipcMain.on('worldsC3Fixture:observe', observed)
  ipcMain.on('worldsC3Fixture:config', config)
  try {
    const isolatedSession = electronSession.fromPath(paths.profile, { cache: false })
    isolatedSession.webRequest.onBeforeRequest((details, callback) => {
      const ownedFile = details.url === trustedRendererUrl || details.url.startsWith(pathToFileURL(path.join(startup.bundleDirectory, 'renderer/')).href)
      if (details.url === 'about:blank' || ownedFile) { callback({ cancel: false }); return }
      event('blocked-network', details.url)
      callback({ cancel: true })
    })
    currentWindow = new BrowserWindow({ width: 1440, height: 960, show: true,
      webPreferences: { preload: path.join(startup.bundleDirectory, 'preload.cjs'), session: isolatedSession, sandbox: true,
        contextIsolation: true, nodeIntegration: false, webSecurity: true } })
    installMainWindowNavigationGuard(currentWindow.webContents, trustedRendererUrl)
    currentWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const originalSend = currentWindow.webContents.send.bind(currentWindow.webContents)
    Object.defineProperty(currentWindow.webContents, 'send', { configurable: true, value: (channel: string, ...args: unknown[]) => {
      if (channel !== 'workspace:worlds:cli:directEditRequest') return originalSend(channel, ...args)
      counters.requests += 1
      event('request', { frozen: Object.isFrozen(args[0]) })
      if (scenario !== 'duplicate-loss') { counters.deliveries += 1; return originalSend(channel, ...args) }
      for (let index = 0; index < 50; index += 1) { counters.deliveries += 1; originalSend(channel, ...args) }
    } })
    await currentWindow.loadURL(trustedRendererUrl)
    controllerViews.initial = await waitForInitialEditor(currentWindow.webContents, baseRevision)
    domScans.initial = await scanVisibleWorkbench(currentWindow.webContents, TARGET_ENTITY_NAME)
    const scope = await readScope()
    assert.ok(scope)
    const pairing = await transport.beginPairing(scope)

    const paired = await wire(transport.socketPath, OPERATIONS[0], { operation: 'pair', code: pairing.code }, transcript, rawFrames)
    assert.equal(paired.ok, true)
    assert.equal(paired.proposalScope, 'worlds:auto-apply')
    const sessionToken = String(paired.session)
    const planned = await wire(transport.socketPath, OPERATIONS[1], { operation: 'plan', session: sessionToken,
      projectKey: PROJECT_KEY, sceneId: SCENE_ID }, transcript, rawFrames)
    assert.equal(planned.ok, true)
    assert.deepEqual(Object.keys(planned).sort(), ['expiresAt', 'ok', 'planId', 'projectKey', 'revision', 'sceneId'])
    const planId = String(planned.planId)
    assert.match(planId, /^plan_[a-f0-9]{48}$/)
    assert.equal(planned.projectKey, PROJECT_KEY)
    assert.equal(planned.revision, baseRevision)
    assert.equal(planned.sceneId, SCENE_ID)
    assert.ok(Number.isSafeInteger(planned.expiresAt) && Number(planned.expiresAt) > Date.now())
    const planProjectKey = String(planned.projectKey)
    const planRevision = Number(planned.revision)
    const planSceneId = String(planned.sceneId)
    const planExpiresAt = Number(planned.expiresAt)
    assert.ok(planExpiresAt <= Number(paired.expiresAt))
    const queried = await wire(transport.socketPath, OPERATIONS[2], { operation: 'query', session: sessionToken,
      projectKey: planProjectKey, revision: planRevision, sceneId: planSceneId, kind: 'entities', entityId: TARGET_ENTITY_ID, planId }, transcript, rawFrames)
    assert.equal(queried.ok, true)
    const page = exactResponse(queried.page)
    assert.equal(page.kind, 'entities')
    assert.equal(page.total, 1)
    assert.equal(page.nextCursor, null)
    assert.deepEqual((page.items as SafeRecord[]).map((entry) => entry.id), [TARGET_ENTITY_ID])
    const deliveryId = String(queried.deliveryId)
    assert.match(deliveryId, /^delivery_[a-f0-9]{48}$/)
    const acknowledged = await wire(transport.socketPath, OPERATIONS[3], { operation: 'ack', session: sessionToken,
      projectKey: planProjectKey, planId, deliveryId }, transcript, rawFrames)
    assert.deepEqual(acknowledged, { ok: true })
    const recipe = JSON.stringify({ commands: [{ type: 'patch-entity', sceneId: planSceneId,
      entityId: TARGET_ENTITY_ID, patch: { name: RENAMED_ENTITY_NAME } }] })
    const proposed = await wire(transport.socketPath, OPERATIONS[4], { operation: 'propose', session: sessionToken,
      projectKey: planProjectKey, planId, json: recipe }, transcript, rawFrames)
    event('FIXTURE_SEEDED_PROPOSE', proposed)
    assert.equal(proposed.ok, true)
    assert.equal(proposed.status, 'direct-edit-dispatched')
    assert.equal(Object.hasOwn(proposed, 'transactionId'), false)
    assert.equal(transcript.length, 10)

    let h1 = h0
    let h2: Awaited<ReturnType<typeof inspectWorldRaw>> | null = null
    if (scenario === 'primary') {
      controllerViews.applied = await waitForAppliedEditor(currentWindow.webContents, baseRevision + 1)
      domScans.applied = await scanVisibleWorkbench(currentWindow.webContents, RENAMED_ENTITY_NAME)
      await captureScreenshot(currentWindow.webContents, paths.evidence, 'applied-visible.png')
      h1 = await inspectWorldRaw(paths.workspace, PROJECT_KEY)
      assert.equal(h1.snapshot.project.revision, baseRevision + 1)
      assert.deepEqual(counters, { requests: 1, deliveries: 1, commits: 1, cancels: 0, adopts: 1, readiness: 1 })
      assert.equal(commitReceipts.length, 1)
      assert.equal(adoptionReceipts.length, 1)
      const committed = exactResponse(commitReceipts[0])
      assert.equal(committed.ok, true)
      const receipt = exactResponse(committed.receipt)
      assert.equal(receipt.projectId, PROJECT_ID)
      assert.equal(receipt.newRevision, baseRevision + 1)
      assert.equal(receipt.snapshotSha256, h1.fullHash)
      assert.equal(h1.state.transactions.length, h0.state.transactions.length + 1)
      assert.equal(h1.state.transactions.at(-1)?.transactionId, receipt.transactionId)
      const appliedController = (controllerViews.applied as { controller: { undo: string[]; externalCliUndoTransactionId: string | null } }).controller
      assert.deepEqual(appliedController.undo, [receipt.transactionId])
      assert.equal(appliedController.externalCliUndoTransactionId, receipt.transactionId)
      const adopted = adoptionReceipts[0] as { request: unknown; result: unknown }
      const adoptionRequest = exactResponse(adopted.request)
      assert.equal(adoptionRequest.transactionId, receipt.transactionId)
      assert.equal(adoptionRequest.newRevision, receipt.newRevision)
      assert.equal(adoptionRequest.snapshotSha256, receipt.snapshotSha256)
      assert.deepEqual(adopted.result, { ok: true, status: 'APPLIED' })
      await activateProductionUndo(currentWindow.webContents)
      controllerViews.undo = await waitForUndoRestored(currentWindow.webContents, baseRevision + 2)
      domScans.undo = await scanVisibleWorkbench(currentWindow.webContents, TARGET_ENTITY_NAME)
      await captureScreenshot(currentWindow.webContents, paths.evidence, 'undo-restored.png')
      h2 = await inspectWorldRaw(paths.workspace, PROJECT_KEY)
      assert.equal(h2.snapshot.project.revision, baseRevision + 2)
      assert.equal(h2.state.committedRevision, baseRevision + 2)
      assert.equal(h2.state.transactions.length, h0.state.transactions.length + 2)
      assert.equal(h2.contentHash, h0.contentHash)
      assert.notEqual(h2.fullHash, h0.fullHash)
      controllerViews.reopened = await reloadAndWaitRestored(currentWindow.webContents, baseRevision + 2)
      domScans.reopened = await scanVisibleWorkbench(currentWindow.webContents, TARGET_ENTITY_NAME)
      await captureScreenshot(currentWindow.webContents, paths.evidence, 'reopened.png')
      const reopened = await inspectWorldRaw(paths.workspace, PROJECT_KEY)
      assert.equal(reopened.fullHash, h2.fullHash)
    } else if (scenario === 'duplicate-loss') {
      controllerViews.reconciled = await waitForLostReplyReconciliation(currentWindow.webContents, baseRevision + 1)
      domScans.reconciled = await scanVisibleWorkbench(currentWindow.webContents, RENAMED_ENTITY_NAME)
      h1 = await inspectWorldRaw(paths.workspace, PROJECT_KEY)
      assert.equal(counters.requests, 1)
      assert.equal(counters.deliveries, 50)
      assert.equal(counters.commits, 1)
      assert.equal(counters.adopts, 0)
      assert.equal(commitReceipts.length, 1)
      const committed = exactResponse(commitReceipts[0])
      const receipt = exactResponse(committed.receipt)
      assert.equal(committed.ok, true)
      assert.equal(receipt.projectId, PROJECT_ID)
      assert.equal(receipt.newRevision, baseRevision + 1)
      assert.equal(receipt.snapshotSha256, h1.fullHash)
      assert.equal(h1.state.transactions.length, h0.state.transactions.length + 1)
      assert.equal(h1.state.transactions.at(-1)?.transactionId, receipt.transactionId)
      assert.equal([...commitAttemptsByIntent.values()].reduce((total, count) => total + Math.max(0, count - 1), 0), 0)
    } else {
      const heldDeadline = Date.now() + 4_000
      while (!events.some((entry) => entry.type === 'commit-attempt-held')) {
        if (Date.now() >= heldDeadline) throw new Error('Held production commit was not observed.')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await activateLeaveWorlds(currentWindow.webContents)
      controllerViews.destination = await waitForNavigationComplete(currentWindow.webContents)
      h1 = await inspectWorldRaw(paths.workspace, PROJECT_KEY)
      assert.equal(h1.fullHash, h0.fullHash)
      assert.equal(counters.adopts, 0)
      assert.equal([...commitAttemptsByIntent.values()].reduce((total, count) => total + Math.max(0, count - 1), 0), 0)
      const ordered = ['navigation-request', 'direct-cancel-ipc', 'cancel-ack-stale', 'held-commit-returns-stale', 'navigation-complete']
      let offset = -1
      for (const type of ordered) {
        const next = events.findIndex((entry, index) => index > offset && entry.type === type)
        assert.ok(next > offset, `Missing ordered event ${type}.`)
        offset = next
      }
      const navigationRequest = exactResponse(events.find((entry) => entry.type === 'navigation-request')?.detail)
      const navigationComplete = exactResponse(events.find((entry) => entry.type === 'navigation-complete')?.detail)
      assert.equal(navigationRequest.trusted, true)
      assert.equal(navigationComplete.navigationId, navigationRequest.navigationId)
      assert.equal(navigationComplete.page, 'generate')
      assert.equal(navigationComplete.destinationVisible, true)
    }

    const retryCommitIpcCount = [...commitAttemptsByIntent.values()].reduce((total, count) => total + Math.max(0, count - 1), 0)
    const report: RuntimeReport = { schema: 'modly.worlds-codex-direct-edit-native-evidence.v1', status: 'PASS',
      label: NATIVE_LABELS[scenario], scenario, inboundFrames: 5, outboundFrames: 5,
      counters: { ...counters, retryCommitIpcCount }, h0, h1, h2, transcript, events, observations,
      controllerViews, domScans, commitReceipts, adoptionReceipts }
    await writePrivateJson(path.join(paths.evidence, 'uds-transcript.json'), transcript)
    await writePrivateText(path.join(paths.evidence, 'events.ndjson'), `${events.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
    await writePrivateJson(path.join(paths.evidence, 'scenario-report.json'), report)
    return report
  } catch (error) {
    if (currentWindow && !currentWindow.isDestroyed()) await captureScreenshot(currentWindow.webContents, paths.evidence, 'failure.png').catch(() => undefined)
    throw error
  } finally {
    ipcMain.off('worldsC3Fixture:observe', observed)
    ipcMain.off('worldsC3Fixture:config', config)
    editorBroker.shutdown()
    readinessBroker.shutdown()
    await directEditBroker.shutdown()
    await transport?.revoke()
    await writePrivateJson(path.join(paths.evidence, 'uds-raw-after-revoke.json'), rawFrames).catch(() => undefined)
    if (currentWindow && !currentWindow.isDestroyed()) currentWindow.destroy()
    for (const channel of handlers) ipcMain.removeHandler(channel)
  }
}

export function startFixture(startup: FixtureStartup): void {
  startup.takeOwnership((error) => {
    process.stderr.write(`${String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 8192)}\n`)
    app.exit(1)
  })
  void (async () => {
    assertFixtureLaunch(process.argv, process.env, startup.launch, startup.assertLiveEnvironment)
    assertNoUnsafeSwitches()
    assert.equal(startup.build.execution, 'NOT_RUN')
    assert.equal(startup.build.nativeEvidence, 'ABSENT')
    await app.whenReady()
    const reports = []
    assert.deepEqual(SCENARIO_ORDER, FIXTURE_SCENARIOS)
    for (const scenario of SCENARIO_ORDER) reports.push(await runScenario(startup, scenario))
    const complete = { schema: 'modly.worlds-codex-direct-edit-native-run.v1', status: 'PASS', label: OVERALL_NATIVE_LABEL,
      build: (startup.build as FixtureBuildManifest).sourceAggregateSha256, reports, sourceInputsAfter: [] as Array<{ path: string; bytes: number; sha256: string }>,
      outputsAfter: {} as Record<string, { bytes: number; sha256: string }>, gitCustodyAfter: await readGitCustody(
        startup.build.repositoryRoot, startup.launch.paths.home) }
    for (const input of startup.build.sourceInputs) {
      const bytes = await readFile(input.path)
      const after = { path: input.path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      assert.deepEqual({ bytes: after.bytes, sha256: after.sha256 },
        { bytes: input.bytes, sha256: input.sha256 })
      complete.sourceInputsAfter.push(after)
    }
    for (const [relative, expected] of Object.entries(startup.build.outputs)) {
      const bytes = await readFile(path.join(startup.bundleDirectory, relative))
      const after = digest(bytes)
      assert.deepEqual(after, expected)
      complete.outputsAfter[relative] = after
    }
    assert.deepEqual(complete.gitCustodyAfter, startup.build.gitCustody)
    await writePrivateJson(path.join(startup.launch.paths.stateRoot, 'native-result.json'), complete)
    app.exit(0)
  })().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error).slice(0, 8192)}\n`)
    app.exit(1)
  })
}
