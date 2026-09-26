import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { lstat, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, session, type Session } from 'electron'
import { WorldProjectRepository, WORLD_PROJECT_TRANSACTION_LEDGER_LIMIT } from '../../electron/main/world-project-repository.ts'
import { registerWorldProjectsIpcHandlers } from '../../electron/main/world-projects-ipc.ts'
import { registerArtifactRegistryIpcHandlers } from '../../electron/main/artifact-registry-service.ts'
import { AutomationHttpBridge } from '../../electron/main/automation-http-bridge.ts'
import { AgentSessionStore } from '../../electron/main/agent-session-store.ts'
import { sameWorldAiContext, WORLD_AI_QUERY_BYTES, type WorldAiContext } from '../../src/areas/worlds/core/worldAiContract.ts'
import { parseWorldAiChatResponse } from '../../src/areas/worlds/editor/worldAiChatAdapter.ts'
import { applyWorldCommandBatch, canonicalWorldCommandBatchPayload, parseWorldCommandBatch } from '../../src/areas/worlds/core/worldCommands.ts'
import { validateWorldProjectSnapshot } from '../../src/areas/worlds/core/worldDocuments.ts'
import { observeWorldAiSource } from '../../electron/main/world-ai-resource-observations.ts'
import { runActualOllamaDriver, type AiDriverPorts, type AiQueryCapture, type AiPreviewCapture, type AiDiscardCapture, type AiHttpReceipt } from './ai-driver.ts'
import { WORLD_PROJECT_CHANNELS, type WorldProjectCommandRequest, type WorldProjectCommandResult, type WorldProjectCommandSuccess } from '../../src/shared/types/worldProjects.ts'
import type { AssetLibraryListResult } from '../../src/shared/types/assetLibrary.ts'
import { ASSET_PATHS, UI_ASSET_PATHS, WORLD_SCULPT_ASSET_PATHS, provisionAuthoringInputs, seedAuthoring } from './scene.ts'
import { runAuthoringInteractions, runUiAuthoredScenes, readView, waitForOwnedWindowFocus, type DriverPorts, type Invocation } from './driver.ts'
import { runWorldSculptNavigationAcceptance } from './navigation-driver.ts'
import { CHECK_NAMES, UI_CHECK_NAMES, NAVIGATION_CHECK_NAMES, PROJECT_KEY, SCENE_KEY, SCENE_ID, createWorldSculptPointerLockPermissionPolicy, parseWorldSculptInputContract, type AuthoringView, type Check, type CheckName, type SeedEvidence } from './shared.ts'
import { AI_CHECK_NAMES, LOCAL_AI_PATH_ADMISSION, LOCAL_AI_SESSION_METHODS, createLocalAiConfig, validateLocalAiConfig, validateRepositoryAdmission, parseReviewedAiModel, localAiBridgeEnvironment, parseOwnedBridgeOrigin, localAiPythonArguments, parseUvicornAddress, isLocalAiRoute, isLocalAiHttpRequest, parseLocalAiModels, parseLocalAiChat } from './shared.ts'

interface Digest { bytes: number; sha256: string }
interface LedgerTransaction {
  transactionId: string; transactionDigest: string; payloadSha256: string; canonicalPayload: string
  appliedRevision: number; resultSha256: string
}
interface StoredWitness extends Digest {
  projectKey: string; transaction: LedgerTransaction; filename: string; capturedAt: string
}
interface BuildManifest {
  schema: string; execution: string; outputDirectory: string; repositoryRoot: string
  repositoryAdmission: unknown; initialHead: string; initialBranch: string
  outputs: Record<string, Digest>; sourceInputs: Array<Digest & { path: string }>; [key: string]: unknown
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const now = () => new Date().toISOString()
const reviewedRepositoryHead = '416fcfa079aa3e569e8dd460c64c7462fac7850b'
const reviewedRepositoryBranch = 'codex/worlds-engine'
const sourceRepositoryRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const bundle = realpathSync(__dirname)
assert.equal(path.resolve(__dirname), bundle)
assert.equal(path.dirname(bundle), '/tmp'); assert.match(path.basename(bundle), /^modly-worlds-authoring-ui-/)
assert.equal(lstatSync(bundle).mode & 0o777, 0o700); assert.equal(lstatSync(bundle).uid, process.getuid?.())
assert.equal(process.argv.length, 2, 'No Electron flags or arguments are permitted')
const forbiddenSwitches = ['no-sandbox', 'no-zygote', 'disable-setuid-sandbox', 'disable-gpu-sandbox', 'disable-gpu', 'disable-software-rasterizer', 'use-gl', 'use-angle']
for (const value of forbiddenSwitches) assert.equal(app.commandLine.hasSwitch(value), false, `Forbidden runtime switch ${value}`)
const manifestBytes = readFileSync(path.join(bundle, 'fixture-build.json'))
assert.equal(hash(manifestBytes), process.env.WORLD_AUTHORING_BUILD_SHA256)
const build: BuildManifest = JSON.parse(manifestBytes.toString('utf8'))
assert.equal(build.schema, 'modly.worlds-authoring-build.v1'); assert.equal(build.execution, 'NOT_RUN'); assert.equal(build.outputDirectory, bundle)
assert.ok(path.isAbsolute(build.repositoryRoot) && path.resolve(build.repositoryRoot) === build.repositoryRoot && !build.repositoryRoot.includes('\0'), 'Canonical source input repository required')
assert.equal(build.repositoryRoot, sourceRepositoryRoot, 'Translated source repository admission changed')
assert.equal(build.initialHead, reviewedRepositoryHead); assert.equal(build.initialBranch, reviewedRepositoryBranch)
const repositoryAdmission = validateRepositoryAdmission(build.repositoryAdmission, sourceRepositoryRoot, reviewedRepositoryHead, reviewedRepositoryBranch)
assert.equal(repositoryAdmission.root, build.repositoryRoot); assert.equal(repositoryAdmission.head, build.initialHead); assert.equal(repositoryAdmission.branch, build.initialBranch)
const nativeMode = build.nativeMode ?? 'owned-xvfb'
assert.ok(nativeMode === 'owned-xvfb' || nativeMode === 'inherited-display')
const inheritedDisplay = nativeMode === 'inherited-display'
const runtimeMode = build.runtimeMode ?? 'authoring'
assert.ok(runtimeMode === 'authoring' || runtimeMode === 'local-ai' || runtimeMode === 'worldsculpt-navigation')
const expectedLocalAi = createLocalAiConfig(
  path.join(repositoryAdmission.root, LOCAL_AI_PATH_ADMISSION.apiRootRelative),
  path.join(repositoryAdmission.root, LOCAL_AI_PATH_ADMISSION.pythonPathRelative),
)
const localAi = runtimeMode === 'local-ai' ? validateLocalAiConfig(build.localAi, expectedLocalAi) : null
const worldSculptInput = runtimeMode === 'worldsculpt-navigation' ? parseWorldSculptInputContract(build.worldSculptInput) : null
const reviewedAiModel = localAi ? parseReviewedAiModel(build.reviewedAiModel) : null
if (localAi) {
  assert.equal(inheritedDisplay, true)
  assert.equal(process.env.WORLD_AUTHORING_RUNTIME_MODE, runtimeMode)
  assert.equal(process.env.WORLD_AUTHORING_LOCAL_AI_CONFIG, JSON.stringify(localAi))
} else if (worldSculptInput) {
  assert.equal(inheritedDisplay, true); assert.equal(process.env.WORLD_AUTHORING_RUNTIME_MODE, runtimeMode)
  assert.equal(build.localAi, undefined); assert.equal(build.reviewedAiModel, undefined)
  assert.equal(process.env.WORLD_AUTHORING_LOCAL_AI_CONFIG, undefined)
} else {
  assert.equal(build.localAi, undefined); assert.equal(build.worldSculptInput, undefined); assert.equal(process.env.WORLD_AUTHORING_RUNTIME_MODE, undefined)
  assert.equal(process.env.WORLD_AUTHORING_LOCAL_AI_CONFIG, undefined)
}
if (!inheritedDisplay) for (const [key, value] of Object.entries(process.env)) {
  if (value && (/^(?:ELECTRON_|NODE_|WAYLAND_|LD_|LIBGL_|MESA_|GALLIUM_|__GL_|VK_|ANGLE_)/.test(key) || ['NODE_OPTIONS', 'NODE_PATH'].includes(key))) throw new Error(`Refusing inherited runtime override ${key}`)
}
const runDirectory = process.env.WORLD_AUTHORING_RUN_DIRECTORY!
assert.ok(runDirectory && path.dirname(runDirectory) === bundle && /^run-/.test(path.basename(runDirectory)))
assert.equal(realpathSync(runDirectory), runDirectory); assert.equal(lstatSync(runDirectory).mode & 0o777, 0o700)
const launcher = JSON.parse(readFileSync(path.join(bundle, 'run-consumed.json'), 'utf8'))
assert.equal(launcher.runDirectory, runDirectory); assert.equal(launcher.launcherPid, process.ppid)
assert.equal(launcher.buildSha256, hash(manifestBytes)); assert.equal(process.env.DISPLAY, launcher.display)
assert.equal(launcher.mode ?? 'owned-xvfb', nativeMode)
assert.equal(launcher.runtimeMode ?? 'authoring', runtimeMode)
if (inheritedDisplay) {
  assert.ok(typeof launcher.display === 'string' && launcher.display.trim())
  assert.equal(process.env.XAUTHORITY ?? null, launcher.inheritedXauthority)
} else {
  assert.match(launcher.display, /^:(?:[2-9][0-9]{2}|[1-9][0-9]{3,4})$/)
  assert.equal(process.env.XAUTHORITY, path.join(runDirectory, 'Xauthority'))
}
const verifySources = () => {
  assert.equal(build.repositoryRoot, repositoryAdmission.root, 'Canonical source input repository required')
  assert.ok(Array.isArray(build.sourceInputs) && build.sourceInputs.length > 0, 'Source input inventory required')
  const inventory = build.sourceInputs.map((entry) => ({ ...entry }))
  const evidencePrefix = path.join(build.repositoryRoot, 'docs', 'worlds-engine-evidence') + path.sep
  // Validate the COMPLETE inventory before any source bytes, not just forbidden bytes.
  for (const entry of inventory) {
    assert.ok(typeof entry.path === 'string' && path.isAbsolute(entry.path) && path.resolve(entry.path) === entry.path && !entry.path.includes('\0'), 'Unsafe source input path')
    assert.ok(!/(?:^|\.)xauthority(?:\.|$)/i.test(path.basename(entry.path)) && !/\.ses$/i.test(path.basename(entry.path)) && !/\.(?:pem|key|p12|pfx)$/i.test(path.basename(entry.path)) && !entry.path.startsWith(evidencePrefix), 'Forbidden source input')
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid source input pins')
    assert.ok(lstatSync(entry.path).isFile(), 'Nonregular source input')
    assert.equal(realpathSync(entry.path), entry.path, 'Source input alias forbidden')
  }
  for (const entry of inventory) {
    assert.ok(lstatSync(entry.path).isFile(), 'Nonregular source input')
    assert.equal(realpathSync(entry.path), entry.path, 'Source input alias forbidden')
    const bytes = readFileSync(entry.path)
    assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256, `Source input changed: ${entry.path}`)
  }
}
for (const [relative, entry] of Object.entries(build.outputs)) {
  const filename = path.resolve(bundle, relative)
  assert.ok(filename.startsWith(`${bundle}/`)); assert.equal(realpathSync(filename), filename)
  assert.ok(lstatSync(filename).isFile())
  const bytes = readFileSync(filename)
  assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256, `Build output changed: ${relative}`)
}
verifySources()
const workspace = path.join(runDirectory, 'workspace'), userData = path.join(runDirectory, 'userData')
const sessionData = path.join(runDirectory, 'sessionData'), crashDumps = path.join(runDirectory, 'crashDumps')
for (const directory of [workspace, userData, sessionData, crashDumps]) mkdirSync(directory, { mode: 0o700 })
mkdirSync(path.join(userData, 'models'), { mode: 0o700 })
app.setName('Worlds Native Authoring Fixture')
app.setPath('userData', userData); app.setPath('sessionData', sessionData); app.setPath('crashDumps', crashDumps)
app.enableSandbox()
app.on('window-all-closed', onOwnedWindowsClosed)
app.on('before-quit', onOwnedBeforeQuit)
app.on('will-quit', onOwnedWillQuit)

const checks: Check[] = [...CHECK_NAMES, ...(inheritedDisplay ? UI_CHECK_NAMES : []), ...(localAi ? AI_CHECK_NAMES : []), ...(worldSculptInput ? NAVIGATION_CHECK_NAMES : [])].map((name) => ({ name, status: 'UNREACHED', reason: 'Not yet reached; positive Canvas is required.' }))
const assetPaths: readonly string[] = inheritedDisplay ? [...UI_ASSET_PATHS, ...(worldSculptInput ? WORLD_SCULPT_ASSET_PATHS : [])] : ASSET_PATHS
const applies: Invocation[] = []
const storedWitnesses: StoredWitness[] = []
const ipcTrace: unknown[] = [], network: unknown[] = [], errors: string[] = [], cleanup: unknown[] = []
const seedRecords: unknown[] = []
const evidence: Record<string, unknown> = {}
const report: Record<string, unknown> = {
  schema: 'modly.worlds-authoring-run.v1', scope: 'source-level-full-Workbench-native-authoring', status: 'RUNNING',
  included: ['unchanged-full-WorldsWorkbench', 'default-controller-hook-service', 'shared-transform-admission', 'production-projection-SceneDock-Inspector-Viewer-Canvas-drei', 'trusted-native-pointer-input', 'real-production-IPC-repository-history', 'independent-disk-and-renderer-reopen'],
  excluded: ['engine-completion', 'primitive-authoring', ...(!inheritedDisplay ? ['asset-import-UI'] : []), ...(!localAi ? ['AI-provider'] : []), 'Timeline-authoring', 'Play', 'audio-acceptance', 'packaged-E2E', 'performance-acceptance', ...(!worldSculptInput ? ['hardware-GPU-claim'] : []), 'volatile-history-persistence'],
  authoringFlow: inheritedDisplay ? 'assets-only provisioning; canonical project/both scenes/entities authored through trusted native UI' : 'legacy canonical seed plus first-scene pointer/history fixture',
  artificialGate: 'One next transform apply is held in main BEFORE the unchanged handler. This run has no performance metrics or thresholds; inherited 857 ms command p95 remains FAIL.',
  startedAt: now(), runDirectory, workspace, userData, sessionData, pid: process.pid, launcher, versions: process.versions,
  checks, applies, storedWitnesses, ipcTrace, network, errors, cleanup, seedRecords, evidence, build,
  requestedWebPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
}
if (localAi) report.localAi = { status: 'NOT_RUN', scope: 'single-chat-real-Ollama-camera-auto-apply-native-authoring', config: localAi, reviewedAiModel,
  networkScope: 'owned session and narrow host proxy ONLY; not a global Python/Ollama network sandbox', modelSelection: 'component-local native picker; NEVER fixture/global default setter' }
const reportPath = path.join(runDirectory, 'fixture-report.json')
const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
let firstFailure: Error | null = null, currentStage: CheckName | null = null, stopping = false
let currentWindow: BrowserWindow | null = null, server: Server | null = null, isolatedSession: Session | null = null
let origin = '', indexUrl = '', generation = 0
let admissionDeadline: ReturnType<typeof setTimeout> | null = null
const ownedChannels: string[] = []
let rejectFatal!: (reason: Error) => void
const focusAdmissionAbort = new AbortController()
const upstreamAbort = new AbortController()
const fatal = new Promise<never>((_resolve, reject) => { rejectFatal = reject })
void fatal.catch(() => undefined)
type LifecycleClassification = 'active' | 'intentional-replacement' | 'teardown'
type LifecycleReceipt = Readonly<{ sequence: number; at: string; event: string; generation: number; stage: CheckName | null; classification: LifecycleClassification; ownedWindowCount: number; terminalExitAuthorized: boolean }>
const lifecycle: LifecycleReceipt[] = []
let lifecycleSequence = 0, terminalExitAuthorized = false
evidence.lifecycle = lifecycle
function fail(error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error))
  if (!firstFailure) {
    firstFailure = normalized; errors.push(normalized.stack ?? normalized.message); report.status = 'FAIL'
    const check = checks.find((value) => value.name === currentStage)
    if (check?.status === 'UNREACHED') { check.status = 'FAIL'; check.reason = normalized.message }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    rejectFatal(normalized)
    focusAdmissionAbort.abort(normalized)
    upstreamAbort.abort(normalized)
  }
}
function recordLifecycle(event: string, windowGeneration = generation, classification: LifecycleClassification = stopping ? 'teardown' : 'active'): void {
  if (lifecycle.length === 128) { lifecycle.shift(); evidence.lifecycleOmitted = Number(evidence.lifecycleOmitted ?? 0) + 1 }
  lifecycle.push(Object.freeze({ sequence: ++lifecycleSequence, at: now(), event, generation: windowGeneration, stage: currentStage, classification,
    ownedWindowCount: BrowserWindow.getAllWindows().length, terminalExitAuthorized }))
}
function onOwnedWindowsClosed(): void { recordLifecycle('window-all-closed', generation, stopping ? 'teardown' : currentWindow ? 'active' : 'intentional-replacement') }
function handleOwnedQuit(event: Electron.Event, name: 'before-quit' | 'will-quit'): void {
  if (!terminalExitAuthorized) event.preventDefault()
  recordLifecycle(name)
  if (!terminalExitAuthorized && !stopping) fail(new Error(`Unexpected owned application ${name}`))
}
function onOwnedBeforeQuit(event: Electron.Event): void { handleOwnedQuit(event, 'before-quit') }
function onOwnedWillQuit(event: Electron.Event): void { handleOwnedQuit(event, 'will-quit') }
function disposeOwnedLifecycleListeners(): void {
  app.removeListener('before-quit', onOwnedBeforeQuit)
  app.removeListener('will-quit', onOwnedWillQuit)
  app.removeListener('window-all-closed', onOwnedWindowsClosed)
  recordLifecycle('owned-lifecycle-listeners-disposed')
}
// Passive observations need a live exact owner, not continuous desktop focus.
function guard(contents?: Electron.WebContents): void {
  if (firstFailure) throw firstFailure
  if (stopping) throw new Error('Fixture is stopping')
  if (contents) assert.ok(currentWindow, 'Owned fixture window missing')
  if (currentWindow) {
    assert.equal(currentWindow.isDestroyed(), false, 'Owned fixture window lost')
    const windows = BrowserWindow.getAllWindows()
    assert.equal(windows.length, 1, 'Unexpected window ownership')
    assert.equal(windows[0], currentWindow, 'Unexpected owned window identity')
    assert.equal(currentWindow.webContents.isDestroyed(), false, 'Owned fixture renderer lost')
    if (contents) assert.equal(contents, currentWindow.webContents, 'Owned fixture renderer replaced')
  }
}
function inputGuard(contents: Electron.WebContents): void {
  guard(contents); assert.ok(currentWindow)
  assert.equal(currentWindow.isFocused(), true, 'Native input is permitted only in the owned focused window')
}
function assertCurrentAiContents(contents: Electron.WebContents): void {
  guard(contents); assert.ok(currentWindow); assert.equal(contents, currentWindow.webContents); assert.equal(contents.isDestroyed(), false)
}
async function admitNativeFocus(contents: Electron.WebContents): Promise<void> {
  // Observe genuine focus only; never steal the desktop after asynchronous work.
  guard(contents); const window = currentWindow!
  const admission = await waitForOwnedWindowFocus(window, {
    deadline: Math.min(Date.now() + 8000, mainDeadline - (localAi?.cleanupSeconds ?? 0) * 1000), signal: focusAdmissionAbort.signal,
    assertOwned() { guard(contents); assert.equal(currentWindow, window, 'Owned fixture window replaced during native focus admission') },
  })
  inputGuard(contents)
  const admissions = (evidence.nativeInputFocusAdmissions ??= []) as unknown[]
  admissions.push({ ...admission, webContentsId: contents.id })
}
const mainDeadline = Date.now() + (localAi?.mainWatchdogSeconds ?? 120) * 1000
const watchdog = setTimeout(() => fail(new Error(`Native authoring main exceeded its ${localAi?.mainWatchdogSeconds ?? 120} second internal deadline`)), (localAi?.mainWatchdogSeconds ?? 120) * 1000)
process.once('SIGTERM', () => fail(new Error('Outer deadline or interruption sent SIGTERM')))
process.once('SIGINT', () => fail(new Error('Interrupted by SIGINT')))

type Gate = { entityId: string; sceneId: string; baseRevision: number; state: 'armed' | 'held' | 'released' | 'aborted'; continue: (forward: boolean) => void; promise: Promise<boolean> }
let gate: Gate | null = null
function arm(entityId: string, baseRevision: number, sceneId = SCENE_ID): void {
  assert.equal(gate, null, 'Exactly one primary transform gate is allowed')
  let continueGate!: (forward: boolean) => void
  const promise = new Promise<boolean>((resolve) => { continueGate = resolve })
  gate = { entityId, sceneId, baseRevision, state: 'armed', continue: continueGate, promise }
  evidence.gateArmedAt = now()
}
function abortGate(): void { if (gate && (gate.state === 'armed' || gate.state === 'held')) { gate.state = 'aborted'; gate.continue(false); evidence.gateAbortedAt = now() } }
function trusted(value: unknown): value is Electron.IpcMainInvokeEvent {
  const event = value as Electron.IpcMainInvokeEvent
  return !!currentWindow && !currentWindow.isDestroyed() && event.sender === currentWindow.webContents && event.senderFrame === currentWindow.webContents.mainFrame && event.senderFrame.url === indexUrl
}
function register(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  assert.ok(!ownedChannels.includes(channel)); ownedChannels.push(channel)
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!trusted(event)) throw new Error(`Untrusted sender for ${channel}`)
      if (firstFailure || stopping) throw firstFailure ?? new Error('Fixture stopping')
      ipcTrace.push({ at: now(), phase: generation, channel, args: structuredClone(args), senderId: event.sender.id, senderFrameUrl: event.senderFrame?.url })
      return await handler(event, ...args)
    } catch (error) { fail(error); throw error }
  })
}
const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, ...(!inheritedDisplay ? { createProjectKey: () => PROJECT_KEY, createSceneKey: () => SCENE_KEY } : {}) })
registerWorldProjectsIpcHandlers({
  handle(channel, handler) {
    register(channel, async (event, ...args) => {
      if (![WORLD_PROJECT_CHANNELS.list, WORLD_PROJECT_CHANNELS.open, WORLD_PROJECT_CHANNELS.applyCommands, ...(inheritedDisplay ? [WORLD_PROJECT_CHANNELS.create] : []), ...(localAi ? [WORLD_PROJECT_CHANNELS.previewAi, WORLD_PROJECT_CHANNELS.discardAi] : [])].includes(channel as typeof WORLD_PROJECT_CHANNELS.list)) throw new Error(`Unexpected project operation ${channel}`)
      if (channel !== WORLD_PROJECT_CHANNELS.applyCommands) {
        const result = await handler(event, ...args)
        if (!result || (result as { ok?: unknown }).ok !== true) throw new Error(`Production ${channel} failed: ${JSON.stringify(result)}`)
        if (channel === WORLD_PROJECT_CHANNELS.previewAi || channel === WORLD_PROJECT_CHANNELS.discardAi) captureAiProjectRead(channel, args, result)
        return result
      }
      assert.equal(args.length, 1)
      const request = args[0] as WorldProjectCommandRequest
      if (request.batch.origin === 'ai') {
        const preview = aiPreviews.find((item) => item.result.ok && item.result.value.authority === request.aiAuthority?.token)
        assert.ok(preview?.result.ok && request.aiAuthority, 'AI Apply must spend one actual host preview capability')
        assert.deepEqual(request.batch, preview.result.value.batch)
        assert.ok(sameWorldAiContext(request.aiAuthority.context, preview.request.proposal.context))
        assert.equal(applies.some((item) => item.request.batch.origin === 'ai'), false, 'Finite actual driver admits exactly one AI Apply')
      }
      if (!inheritedDisplay) assert.equal(request.projectKey, PROJECT_KEY)
      const entry: Invocation = { channel, receivedAt: now(), request: structuredClone(request) }
      applies.push(entry)
      if (gate?.state === 'held') throw new Error('Overlapping transform leaked a second canonical apply')
      if (gate?.state === 'armed') {
        assert.equal(request.batch.origin, 'ui'); assert.equal(request.batch.baseRevision, gate.baseRevision)
        assert.match(request.batch.transactionId, /^tx:ui-viewport-transform-/)
        assert.equal(request.batch.commands.length, 1)
        const command = request.batch.commands[0]
        assert.equal(command.type, 'patch-entity')
        if (command.type !== 'patch-entity') throw new Error('Expected transform patch')
        assert.equal(command.sceneId, gate.sceneId); assert.equal(command.entityId, gate.entityId)
        assert.deepEqual(Object.keys(command.patch), ['transform'])
        gate.state = 'held'; evidence.gateHeldAt = now()
        await persist()
        if (!await gate.promise) { entry.aborted = true; throw new Error('Unforwarded transform gate aborted') }
      }
      if (firstFailure || stopping) throw firstFailure ?? new Error('Stopped before canonical apply')
      entry.forwardedAt = now()
      // Do not substitute transport validation, command authority, repository I/O or result data.
      const result = await handler(event, ...args) as WorldProjectCommandResult
      entry.settledAt = now(); entry.result = structuredClone(result)
      assert.ok(result.ok, JSON.stringify(result))
      await captureStoredWitness(entry)
      await persist()
      return result
    })
  },
}, repository, { isTrustedSender: trusted })
register('app:info', (_event, ...args) => {
  assert.equal(args.length, 0)
  return { version: app.getVersion(), userData, modelsDir: path.join(userData, 'models'), apiUrl: origin, ...(localAi ? { fixtureLocalAi: { ollamaUrl: localAi.ollamaUrl } } : {}) }
})
const agentSessions = localAi ? new AgentSessionStore({ rootDir: path.join(userData, 'agent-sessions') }) : null
let sessionRequests = 0
if (agentSessions) for (const method of LOCAL_AI_SESSION_METHODS) {
  const operation = agentSessions[method].bind(agentSessions) as (request?: unknown) => Promise<unknown>
  register(`agentSessions:${method}`, (_event, ...args) => {
    assert.equal(args.length, method === 'list' ? 0 : 1)
    assert.ok(++sessionRequests <= 128, 'Owned private session operation count exceeded')
    assert.ok(Buffer.byteLength(JSON.stringify(args)) <= localAi!.bodyBytes, 'Bounded private session request required')
    return operation(args[0])
  })
}
if (inheritedDisplay) {
  // Reuse production payload validation, discovery, preview and open logic; expose only library channels.
  const libraryChannels = new Set(['workspace:library:list', 'workspace:library:open', 'workspace:library:read'])
  registerArtifactRegistryIpcHandlers({ getWorkspaceDir: () => workspace, ipcMain: {
    handle(channel, handler) { if (libraryChannels.has(channel)) register(channel, handler) },
  } })
} else {
  register('workspace:library:list', (_event, ...args): AssetLibraryListResult => {
    assert.equal(args.length, 0)
    return { success: true, entries: [] }
  })
  for (const channel of ['workspace:library:open', 'workspace:library:read']) register(channel, () => { throw new Error(`No library reading was authorized: ${channel}`) })
}
const onViolation = (event: Electron.IpcMainEvent, value: unknown) => fail(new Error(`Preload ownership violation from ${event.sender.id}: ${JSON.stringify(value)}`))
ipcMain.on('worlds-authoring:violation', onViolation)

// Dormant unless the exact separately reviewed manifest/runtime admission selected local-AI.
let automationBridge: AutomationHttpBridge | null = null
let pythonChild: ChildProcess | null = null, pythonPid: number | null = null, pythonOrigin = ''
let pythonExit: Promise<void> | null = null, pythonExited = false, activeAiContext: WorldAiContext | null = null, chatInFlight = false
const aiSockets = new Set<Socket>(), aiRequests = new Set<Promise<void>>()
const aiEvents: unknown[] = []
const aiQueries: AiQueryCapture[] = [], aiChats: AiHttpReceipt[] = [], aiDiscoveries: AiHttpReceipt[] = []
const aiPreviews: AiPreviewCapture[] = [], aiDiscards: AiDiscardCapture[] = []
function captureAiProjectRead(channel: string, args: unknown[], result: unknown): void {
  assert.equal(args.length, 1)
  if (channel === WORLD_PROJECT_CHANNELS.previewAi) {
    assert.equal(aiPreviews.length, 0, 'Exactly one actual host preview admitted')
    const captured = { at: now(), request: structuredClone(args[0]), result: structuredClone(result) } as AiPreviewCapture
    const chat = aiChats.find((item) => item.validation === 'accepted' && item.request && sameWorldAiContext(item.request.worldContext, captured.request.proposal.context))
    assert.ok(chat && parseWorldAiChatResponse(chat.response).worldProposals.some((proposal) => JSON.stringify(proposal) === JSON.stringify(captured.request.proposal)), 'Preview must originate in an actual returned same-turn proposal')
    aiPreviews.push(captured)
  } else {
    throw new Error('Manual AI discard is forbidden in the direct auto-apply acceptance lane')
  }
}
let discoveredModels = new Map<string, string>(), queryBytes = 0, queryRequests = 0, modelRequests = 0, chatRequests = 0
const aiLogFiles: Array<Awaited<ReturnType<typeof open>>> = []
const aiLogByteCounts = [0, 0]
let aiLogWrites = Promise.resolve()
function aiEvent(value: unknown): void {
  if (aiEvents.length >= 256) { fail(new Error('Owned runtime event receipt limit exceeded')); return }
  aiEvents.push({ at: now(), ...(value as Record<string, unknown>) })
}
async function bounded<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })]) }
  finally { clearTimeout(timer) }
}
function signalPython(signal: NodeJS.Signals): void {
  if (!pythonChild || !pythonPid || pythonChild.pid !== pythonPid) return
  try { process.kill(-pythonPid, signal); aiEvent({ operation: signal, ownedPythonGroup: pythonPid }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}
async function startLocalAi(): Promise<void> {
  if (!localAi) return
  evidence.actualApi = { status: 'STARTING', events: aiEvents, queries: aiQueries, chats: aiChats, discoveries: aiDiscoveries, logByteCounts: aiLogByteCounts,
    aiInteraction: 'NOT_RUN; startup/discovery is never actual native AI acceptance' }
  const identity = build.pythonIdentity as { logicalPath: string; resolvedPath: string; linkTarget: string; device: string; inode: string; mode: number }
  assert.equal(identity.logicalPath, localAi.pythonPath)
  const info = lstatSync(localAi.pythonPath)
  assert.ok(info.isSymbolicLink()); assert.equal(realpathSync(localAi.pythonPath), identity.resolvedPath)
  assert.equal(readlinkSync(localAi.pythonPath), identity.linkTarget); assert.equal(String(info.dev), identity.device)
  assert.equal(String(info.ino), identity.inode); assert.equal(info.mode, identity.mode)
  const denied = async (): Promise<never> => { throw new Error('Generic automation authority is not admitted') }
  let bridgeHost: string | null = null
  automationBridge = new AutomationHttpBridge({ host: '127.0.0.1', port: 0,
    createServer: ((handler?: (request: IncomingMessage, response: ServerResponse) => void) => {
      const owned = createServer((request, response) => {
        if (stopping || upstreamAbort.signal.aborted || request.socket.remoteAddress !== '127.0.0.1'
          || !bridgeHost || request.headers.host !== bridgeHost || request.method !== 'POST' || request.url !== '/automation/worlds/query'
          || request.headers['content-type'] !== 'application/json' || request.headers.authorization || request.headers.cookie || request.headers['transfer-encoding']
          || typeof request.headers['content-length'] !== 'string' || !/^[1-9][0-9]*$/.test(request.headers['content-length']) || Number(request.headers['content-length']) > WORLD_AI_QUERY_BYTES) {
          response.writeHead(403, { Connection: 'close' }); response.end(); return
        }
        const deadline = setTimeout(() => request.destroy(new Error('Owned query request deadline exceeded')), localAi.bodySeconds * 1000)
        response.once('close', () => clearTimeout(deadline))
        handler!(request, response)
      })
      owned.on('connection', (socket) => { aiSockets.add(socket); socket.once('close', () => aiSockets.delete(socket)) })
      owned.on('error', fail); owned.on('upgrade', (_request, socket) => socket.destroy())
      return owned
    }) as typeof createServer,
    queryWorld: async (request) => {
      if (stopping || upstreamAbort.signal.aborted || !activeAiContext || !sameWorldAiContext(request.context, activeAiContext)) throw new Error('World query is outside its actual captured chat turn')
      if (++queryRequests > localAi.queryCount) throw new Error('Owned World query count exceeded')
      // SAME canonical disk authority as the Workbench IPC, not a second projection/repository.
      const result = await repository.queryAi(request)
      const bytes = Buffer.byteLength(JSON.stringify({ request, result }))
      queryBytes += bytes
      if (queryBytes > localAi.queryTotalBytes) throw new Error('Owned World query capture limit exceeded')
      aiQueries.push({ at: now(), request: structuredClone(request), result: structuredClone(result), bytes })
      return result
    }, getAutomationCapabilities: denied, createProcessRun: denied, getProcessRun: denied, cancelProcessRun: denied, importSceneMesh: denied,
    logger: { info: (message) => aiEvent({ bridge: message }), warn: (message) => aiEvent({ bridgeWarning: message }), error: (message) => aiEvent({ bridgeError: message }) },
  })
  // An exclusive production bind is the ONLY admission check: never probe/kill/reuse a port occupant.
  await bounded(automationBridge.start(), localAi.startupSeconds * 1000, 'Exclusive owned bridge bind timed out')
  const bridgeOrigin = parseOwnedBridgeOrigin(automationBridge.getOrigin())
  assert.equal(automationBridge.getOrigin(), bridgeOrigin, 'Owned bridge socket must remain live through startup origin validation')
  bridgeHost = bridgeOrigin.slice(7)
  aiEvent({ bridgeBound: bridgeOrigin })
  if (stopping || upstreamAbort.signal.aborted) throw new Error('Stopped before Python spawn')
  const env = localAiBridgeEnvironment(runDirectory, bridgeOrigin)
  for (const directory of new Set(Object.entries(env).filter(([key]) => ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'MODELS_DIR', 'EXTENSIONS_DIR'].includes(key)).map(([, value]) => value))) mkdirSync(directory, { mode: 0o700 })
  for (const stream of ['stdout', 'stderr']) aiLogFiles.push(await open(path.join(runDirectory, `actual-api.${stream}.log`), 'wx', 0o600))
  if (stopping || upstreamAbort.signal.aborted) throw new Error('Stopped before Python spawn')
  const args = localAiPythonArguments(localAi)
  pythonChild = spawn(localAi.pythonPath, args, { cwd: env.HOME, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  pythonPid = pythonChild.pid ?? null
  let resolveStarted!: (origin: string) => void, rejectStarted!: (error: Error) => void
  const started = new Promise<string>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject })
  void started.catch(() => undefined)
  pythonExit = new Promise<void>((resolve) => {
    pythonChild!.once('error', (error) => { rejectStarted(error); fail(error) })
    pythonChild!.once('exit', (code, signal) => {
      pythonExited = true; aiEvent({ pythonExited: { pid: pythonPid, code, signal } })
      if (!stopping) { const error = new Error(`Owned actual API exited early: ${code}/${signal}`); rejectStarted(error); fail(error) }
    })
    pythonChild!.once('close', () => resolve())
  })
  assert.ok(pythonPid, 'Owned Python pid was not recorded')
  aiEvent({ pythonStarted: { pid: pythonPid, executable: localAi.pythonPath, args, cwd: env.HOME, environmentNames: Object.keys(env), identity } })
  const counts = aiLogByteCounts; let startupStderr = ''
  for (const [index, stream] of [pythonChild.stdout!, pythonChild.stderr!].entries()) stream.on('data', (chunk: Buffer) => {
    counts[index] += chunk.length
    if (counts[index] > localAi.logBytes) { const error = new Error('Owned API stdout/stderr capture limit exceeded'); rejectStarted(error); fail(error); signalPython('SIGTERM'); return }
    const bytes = Buffer.from(chunk)
    aiLogWrites = aiLogWrites.then(async () => { await aiLogFiles[index].write(bytes) }).catch((error) => { fail(error) })
    if (index === 1 && !pythonOrigin) {
      startupStderr += chunk.toString('utf8')
      const captured = parseUvicornAddress(startupStderr)
      if (captured) resolveStarted(captured)
    }
  })
  const onAbort = () => rejectStarted(new Error('Owned API startup aborted'))
  upstreamAbort.signal.addEventListener('abort', onAbort, { once: true })
  try { pythonOrigin = await bounded(started, localAi.startupSeconds * 1000, 'Owned canonical Uvicorn startup timed out') }
  finally { upstreamAbort.signal.removeEventListener('abort', onAbort) }
  if (pythonExited || stopping || upstreamAbort.signal.aborted) throw new Error('Owned API lost after startup capture')
  aiEvent({ pythonStartupAddress: pythonOrigin, readiness: 'captured installed Uvicorn startup line ONLY; no HTTP retry/probe', stdoutBytes: counts[0], stderrBytes: counts[1] })
  Object.assign(evidence.actualApi as Record<string, unknown>, { status: 'STARTUP_CAPTURED_ONLY', pythonOrigin })
}

async function proxyLocalAi(request: IncomingMessage, response: ServerResponse): Promise<void> {
  assert.ok(localAi && agentSessions && pythonOrigin && !pythonExited)
  if (request.socket.remoteAddress !== '127.0.0.1' || !isLocalAiHttpRequest(request.method ?? '', request.url ?? '', request.headers, origin, indexUrl)) throw new Error('Owned agent request headers rejected')
  const isChat = request.method === 'POST'
  if (isChat ? ++chatRequests > localAi.chatRequests : ++modelRequests > localAi.modelRequests) throw new Error('Owned agent request count exceeded')
  if (isChat && chatInFlight) throw new Error('Overlapping owned chat turn refused')
  if (isChat) chatInFlight = true
  const controller = new AbortController(), onAbort = () => controller.abort(upstreamAbort.signal.reason)
  const onClose = () => { if (!response.writableEnded) controller.abort(new Error('Owned renderer request disconnected')) }
  upstreamAbort.signal.addEventListener('abort', onAbort, { once: true }); response.once('close', onClose)
  const turnDeadline = setTimeout(() => controller.abort(new Error('Owned total agent request deadline exceeded')), (isChat ? localAi.turnSeconds : localAi.modelsSeconds) * 1000)
  let body: Buffer = Buffer.alloc(0), capturedChat: ReturnType<typeof parseLocalAiChat> | null = null
  try {
    if (upstreamAbort.signal.aborted || stopping) throw new Error('Owned request aborted before forwarding')
    if (isChat) {
      const length = request.headers['content-length']
      if (typeof length !== 'string' || !/^[1-9][0-9]*$/.test(length) || Number(length) > localAi.bodyBytes) throw new Error('Owned chat Content-Length rejected')
      body = await bounded(new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []; let total = 0
        request.on('data', (chunk: Buffer) => { total += chunk.length; if (total > localAi.bodyBytes) { reject(new Error('Owned chat body exceeds limit')); request.destroy() } else chunks.push(Buffer.from(chunk)) })
        request.once('end', () => total === Number(length) ? resolve(Buffer.concat(chunks)) : reject(new Error('Owned chat body length disagrees')))
        request.once('error', reject); request.once('aborted', () => reject(new Error('Owned chat body aborted')))
      }), localAi.bodySeconds * 1000, 'Owned chat body deadline exceeded')
      capturedChat = parseLocalAiChat(JSON.parse(body.toString('utf8')), discoveredModels, localAi)
      assert.deepEqual(capturedChat.admittedSelection, { name: reviewedAiModel!.name, digest: reviewedAiModel!.digest }, 'Only the explicitly reviewed same-run discovered identity may be forwarded')
      const sessions = await bounded(agentSessions.list(), localAi.bodySeconds * 1000, 'Owned session list deadline exceeded')
      assert.equal(sessions.activeSessionId, capturedChat.request.originSessionId, 'Chat must belong to the actual private active session')
      await bounded(agentSessions.read({ sessionId: capturedChat.request.originSessionId }), localAi.bodySeconds * 1000, 'Owned session read deadline exceeded')
      activeAiContext = capturedChat.request.worldContext
    } else if (request.headers['content-length'] && request.headers['content-length'] !== '0') throw new Error('Owned discovery cannot carry a body')
    if (stopping || controller.signal.aborted) throw new Error('Owned request stopped before upstream creation')
    const route = request.url!
    const result = await new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
      const upstream = httpRequest(`${pythonOrigin}${route}`, { method: request.method, signal: controller.signal,
        headers: isChat ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} }, (incoming) => {
        const status = incoming.statusCode ?? 0
        if (status >= 300 && status < 400 || incoming.headers['content-type']?.split(';')[0] !== 'application/json') { incoming.destroy(); reject(new Error('Owned canonical redirect/non-JSON response refused')); return }
        const chunks: Buffer[] = []; let total = 0
        incoming.on('data', (chunk: Buffer) => { total += chunk.length; if (total > localAi.responseBytes) { incoming.destroy(new Error('Owned canonical response exceeds limit')) } else chunks.push(Buffer.from(chunk)) })
        incoming.once('error', reject); incoming.once('aborted', () => reject(new Error('Owned canonical response aborted')))
        incoming.once('end', () => resolve({ status, bytes: Buffer.concat(chunks) }))
      })
      upstream.once('error', reject); upstream.end(isChat ? body : undefined)
    })
    const received: AiHttpReceipt = { at: now(), status: result.status, responseBytes: result.bytes.length, responseSha256: hash(result.bytes), rawResponseBase64: result.bytes.toString('base64'), validation: 'pending',
      ...(isChat ? { request: structuredClone(capturedChat!.request), admittedSelection: structuredClone(capturedChat!.admittedSelection) } : {}) }
    if (isChat) aiChats.push(received)
    else aiDiscoveries.push(received)
    // Persist received original bytes before any JSON or canonical DTO decoder can reject them.
    await persist()
    try {
      const decoded: unknown = JSON.parse(result.bytes.toString('utf8'))
      received.response = structuredClone(decoded)
      if (isChat) {
        if (result.status === 200) {
          parseWorldAiChatResponse(decoded)
          received.validation = 'accepted'
        } else received.validation = 'rejected' // Preserve the real non-200 body/status for renderer HTTP handling.
      } else {
        if (result.status !== 200) throw new Error('Owned actual discovery HTTP failure')
        discoveredModels = parseLocalAiModels(decoded)
        received.validation = 'accepted'
      }
    } catch (error) {
      received.validation = 'rejected'; await persist(); throw error
    }
    await persist()
    if (stopping || controller.signal.aborted) throw new Error('Owned request stopped before renderer response')
    response.writeHead(result.status, { 'Content-Type': 'application/json', 'Content-Length': result.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(result.bytes)
  } finally {
    clearTimeout(turnDeadline); upstreamAbort.signal.removeEventListener('abort', onAbort); response.off('close', onClose)
    controller.abort(); if (isChat) { activeAiContext = null; chatInFlight = false }
  }
}
async function stopLocalAi(): Promise<void> {
  if (!localAi) return
  const failures: unknown[] = []
  upstreamAbort.abort(new Error('Owned actual API teardown'))
  for (const socket of aiSockets) socket.destroy()
  try { if (automationBridge) { await bounded(automationBridge.stop(), 1000, 'Owned query bridge drain timed out'); aiEvent({ bridgeClosed: true }) } } catch (error) { failures.push(error) }
  try { await bounded(Promise.allSettled([...aiRequests]), 1000, 'Owned upstream request drain timed out') } catch (error) { failures.push(error) }
  try { if (pythonChild) {
    signalPython('SIGTERM')
    try { await bounded(pythonExit!, 2000, 'Owned Python TERM wait exceeded') }
    catch { signalPython('SIGKILL'); await bounded(pythonExit!, 1000, 'Owned Python KILL wait exceeded') }
    // Check the recorded group too: a closed parent stream is not descendant-group proof.
    if (pythonPid) {
      let remains = false
      try { process.kill(-pythonPid, 0); remains = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      if (remains) {
        signalPython('SIGKILL'); await new Promise<void>((resolve) => setTimeout(resolve, 250))
        try { process.kill(-pythonPid, 0); throw new Error('Owned Python group remains after bounded shutdown') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
    }
  } } catch (error) { failures.push(error) }
  try { await aiLogWrites; for (const file of aiLogFiles) { await file.sync(); await file.close() } } catch (error) { failures.push(error) }
  cleanup.push({ actualApiClosed: failures.length === 0, aiEvents, externalOllamaStopOrUnload: 'NOT_PERMITTED/NOT_ATTEMPTED' })
  if (failures.length) throw new AggregateError(failures, 'Owned actual API teardown incomplete')
}

async function diskManifest(directory: string, prefix = ''): Promise<Array<{ path: string; sha256: string; bytes: number; mode: number }>> {
  const result: Array<{ path: string; sha256: string; bytes: number; mode: number }> = []
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), filename = path.join(directory, relative), info = await lstat(filename)
    assert.equal(info.uid, process.getuid?.(), `Unexpected workspace owner: ${relative}`)
    if (info.isDirectory()) result.push(...await diskManifest(directory, relative))
    else {
      assert.ok(info.isFile(), `Unexpected workspace link/socket: ${relative}`)
      const bytes = await readFile(filename)
      result.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), mode: info.mode & 0o777 })
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
let seed: SeedEvidence | undefined, seedFiles: Awaited<ReturnType<typeof diskManifest>>
function assertStoredResult(bytes: Buffer, transaction: LedgerTransaction, value: WorldProjectCommandSuccess): void {
  const receipt = value.receipt
  for (const key of ['transactionId', 'payloadSha256', 'resultSha256', 'appliedRevision'] as const) assert.equal(transaction[key], receipt[key])
  assert.match(transaction.payloadSha256, /^[a-f0-9]{64}$/, 'Stored result requires an actual canonical payload digest')
  assert.match(transaction.transactionDigest, /^[a-f0-9]{64}$/, 'Stored result requires an actual confined ledger digest')
  assert.equal(hash(bytes), receipt.resultSha256, 'Stored result bytes disagree with the accepted IPC receipt')
  assert.equal(value.newRevision, receipt.appliedRevision, 'Accepted IPC revision disagrees with its receipt')
  assert.equal(value.snapshot.project.revision, receipt.appliedRevision, 'Accepted IPC snapshot revision disagrees with its receipt')
  assert.equal(value.idempotent, false, 'A durable command result must represent the original canonical apply')
  assert.match(value.projectKey, /^world-[a-f0-9]{32}$/, 'Accepted IPC result requires a confined project identity')

  const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
  const exactRecord = (candidate: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
    assert.ok(isRecord(candidate), `${label} must be an object`)
    assert.deepEqual(Object.keys(candidate).sort(), [...keys].sort(), `${label} has missing or unexpected fields`)
    return candidate
  }
  const storedWire: unknown = JSON.parse(bytes.toString('utf8'))
  assert.ok(isRecord(storedWire), 'Stored command result must be an object')
  const stored = exactRecord(storedWire, storedWire.schema === 'modly.world-command-result.v1'
    ? ['schema', 'transactionId', 'snapshot', 'newRevision', 'changes', 'warnings', 'inverse']
    : ['schema', 'transactionId', 'newRevision', 'changes', 'warnings', 'inverse'], 'Stored command result')
  assert.ok(stored.schema === 'modly.world-command-result.v1' || stored.schema === 'modly.world-command-result.v2', 'Stored command result schema is unsupported')
  assert.equal(stored.transactionId, receipt.transactionId, 'Stored transaction identity disagrees with its accepted IPC receipt')
  assert.equal(stored.newRevision, receipt.appliedRevision, 'Stored revision disagrees with its accepted IPC receipt')

  assert.equal(hash(Buffer.from(transaction.canonicalPayload)), transaction.payloadSha256, 'Ledger payload digest disagrees with its canonical payload')
  assert.equal(hash(Buffer.from(`${transaction.transactionId}\n${transaction.canonicalPayload}`)), transaction.transactionDigest,
    'Ledger transaction digest disagrees with its canonical identity and payload')
  const parsedBatchWire: unknown = JSON.parse(transaction.canonicalPayload)
  const parsedBatch = parseWorldCommandBatch(parsedBatchWire)
  assert.ok(parsedBatch.success, 'Ledger canonical payload is not a valid command batch')
  assert.equal(canonicalWorldCommandBatchPayload(parsedBatch.value), transaction.canonicalPayload, 'Ledger payload is not canonical')
  assert.equal(parsedBatch.value.transactionId, transaction.transactionId, 'Ledger payload transaction identity changed')
  assert.equal(parsedBatch.value.projectId, value.snapshot.project.projectId, 'Ledger payload project identity changed')
  assert.equal(parsedBatch.value.baseRevision + 1, transaction.appliedRevision, 'Ledger payload revision does not produce its applied revision')

  const storedInverse = exactRecord(stored.inverse, ['kind', 'snapshot'], 'Stored command inverse')
  assert.equal(storedInverse.kind, 'world-snapshot', 'Stored inverse kind changed')
  const validatedInverse = validateWorldProjectSnapshot(storedInverse.snapshot)
  assert.ok(validatedInverse.success, 'Stored inverse snapshot is invalid')
  assert.equal(validatedInverse.value.project.projectId, parsedBatch.value.projectId, 'Stored inverse project identity changed')
  assert.equal(validatedInverse.value.project.revision, parsedBatch.value.baseRevision, 'Stored inverse revision changed')

  const replayed = applyWorldCommandBatch(validatedInverse.value, parsedBatch.value)
  assert.ok(replayed.success, 'Stored command batch cannot be replayed from its inverse')
  assert.equal(replayed.receipt.transactionId, transaction.transactionId, 'Replayed transaction identity changed')
  assert.equal(replayed.receipt.appliedRevision, transaction.appliedRevision, 'Replayed revision changed')
  assert.deepEqual(stored.changes, replayed.changes, 'Durable stored changes disagree with canonical replay')
  assert.deepEqual(stored.warnings, replayed.warnings, 'Durable stored warnings disagree with canonical replay')
  assert.deepEqual(stored.inverse, replayed.inverse, 'Durable stored inverse disagrees with canonical replay')
  assert.deepEqual(value, {
    projectKey: value.projectKey,
    snapshot: replayed.snapshot,
    newRevision: transaction.appliedRevision,
    idempotent: false,
    changes: replayed.changes,
    warnings: replayed.warnings,
    inverse: replayed.inverse,
    receipt: {
      transactionId: transaction.transactionId,
      payloadSha256: transaction.payloadSha256,
      resultSha256: transaction.resultSha256,
      appliedRevision: transaction.appliedRevision,
    },
  }, 'Accepted IPC result disagrees with the canonical durable replay')
  if (stored.schema === 'modly.world-command-result.v1') {
    const validatedSnapshot = validateWorldProjectSnapshot(stored.snapshot)
    assert.ok(validatedSnapshot.success, 'Legacy stored forward snapshot is invalid')
    assert.deepEqual(stored.snapshot, replayed.snapshot, 'Legacy stored forward snapshot disagrees with canonical replay')
    assert.deepEqual(validatedSnapshot.value, replayed.snapshot, 'Legacy stored forward snapshot normalization disagrees with canonical replay')
  }
}
async function captureStoredWitness(entry: Invocation): Promise<void> {
  const result = entry.result
  if (!result?.ok) throw new Error('Stored witness requires a successful production apply')
  const value = result.value, projectKey = entry.request.projectKey
  assert.equal(value.idempotent, false, 'Authoring requires a new canonical transaction, not an idempotent response')
  assert.equal(value.projectKey, projectKey); assert.match(projectKey, /^world-[a-f0-9]{32}$/)
  assert.equal(storedWitnesses.some((witness) => witness.projectKey === projectKey && witness.transaction.transactionId === value.receipt.transactionId), false, 'Duplicate stored witness owner')
  const ledger = JSON.parse(await readFile(path.join(workspace, 'Worlds', projectKey, '.modly/state.v1.json'), 'utf8')) as { schema: string; projectKey: string; committedRevision: number; transactions: LedgerTransaction[] }
  assert.equal(ledger.schema, 'modly.world-project-state.v1'); assert.equal(ledger.projectKey, projectKey)
  assert.equal(ledger.committedRevision, value.newRevision, 'Stored witness must be captured before the next canonical apply')
  const transaction = ledger.transactions.find((recorded) => recorded.transactionId === value.receipt.transactionId)
  assert.ok(transaction, 'Accepted receipt must still be retained at the IPC success boundary')
  assert.match(transaction.transactionDigest, /^[a-f0-9]{64}$/)
  const bytes: Buffer = await readFile(path.join(workspace, 'Worlds', projectKey, '.modly/transactions', transaction.transactionDigest, 'after/result.v1.json'))
  assertStoredResult(bytes, transaction, value)
  const index = applies.indexOf(entry); assert.ok(index >= 0)
  const filename = path.join(runDirectory, `stored-result-${index}.json`)
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 })
  assert.deepEqual(await readFile(filename), bytes, 'Exclusive evidence copy must preserve actual stored result bytes')
  storedWitnesses.push({ projectKey, transaction: structuredClone(transaction), filename, capturedAt: now(), bytes: bytes.length, sha256: hash(bytes) })
}
async function checkpoint(stage: string, view: AuthoringView, contents: Electron.WebContents) {
  guard(contents); assert.match(stage, /^[a-z0-9-]+$/)
  const fresh = new WorldProjectRepository({ getWorkspaceRoot: () => workspace })
  const projectKey = view.editor.projectKey
  assert.ok(projectKey, 'Checkpoint requires an actual UI/controller project key')
  const opened = await fresh.open({ projectKey })
  assert.ok(opened.ok && opened.value.status === 'ready', JSON.stringify(opened))
  assert.deepEqual(opened.value.snapshot, view.editor.session?.snapshot, 'Renderer session disagrees with independent durable repository')
  assert.deepEqual(opened.value.durabilityWarnings, [])
  const manifest = await diskManifest(workspace)
  const capturedSeed = seed
  const sentinelPaths: string[] = []
  if (!inheritedDisplay && capturedSeed) {
    const sentinel = capturedSeed.snapshot.project.scenes.find((scene) => scene.id === capturedSeed.sentinelSceneId)
    assert.ok(sentinel, 'Seeded sentinel scene must exist for non-target disk protection')
    sentinelPaths.push(sentinel.documentPath)
  }
  for (const relative of [...assetPaths, ...sentinelPaths]) assert.deepEqual(manifest.find((item) => item.path === relative), seedFiles.find((item) => item.path === relative), `Non-target input/scene changed: ${relative}`)
  const ledger = JSON.parse(await readFile(path.join(workspace, 'Worlds', projectKey, '.modly/state.v1.json'), 'utf8'))
  assert.equal(ledger.schema, 'modly.world-project-state.v1'); assert.equal(ledger.committedRevision, opened.value.snapshot.project.revision)
  const successful = applies.filter((entry) => entry.request.projectKey === projectKey && entry.result?.ok)
  const initialLedger = (evidence.seedLedger ?? { transactions: [] }) as { transactions: LedgerTransaction[] }
  const witnesses = storedWitnesses.filter((witness) => witness.projectKey === projectKey)
  assert.equal(witnesses.length, successful.length, 'Every historical successful IPC apply requires a pre-expiry stored witness')
  const witnessedTransactions: LedgerTransaction[] = []
  for (const entry of successful) {
    const result = entry.result
    if (!result?.ok) throw new Error('Historical successful IPC result disappeared')
    const witness = witnesses.find((item) => item.transaction.transactionId === result.value.receipt.transactionId)
    assert.ok(witness, 'Never skip an expired transaction without previously verified stored bytes')
    const storedBytes: Buffer = await readFile(witness.filename)
    assert.equal(storedBytes.length, witness.bytes); assert.equal(hash(storedBytes), witness.sha256)
    assertStoredResult(storedBytes, witness.transaction, result.value)
    witnessedTransactions.push(witness.transaction)
  }
  assert.deepEqual(ledger.transactions, [...initialLedger.transactions, ...witnessedTransactions].slice(-WORLD_PROJECT_TRANSACTION_LEDGER_LIMIT), 'Durable ledger must equal the exact ordered retained suffix')
  evidence.canonicalApplyCounts = { totalIpcApplies: applies.length, projectKey, successfulProjectApplies: successful.length, retainedProjectTransactions: ledger.transactions.length }
  guard(contents); const image = await contents.capturePage()
  const size = image.getSize(), pixels = image.toBitmap(), png = image.toPNG()
  assert.equal(pixels.length, size.width * size.height * 4)
  assert.equal(size.width, view.viewport.width, 'Native screenshot pixel coordinates must equal actual CSS coordinates')
  assert.equal(size.height, view.viewport.height, 'Native screenshot pixel coordinates must equal actual CSS coordinates')
  await writeFile(path.join(runDirectory, `${stage}.png`), png, { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(runDirectory, `${stage}.json`), `${JSON.stringify({ at: now(), view, freshRepository: opened, manifest, ledger, commandEnvelopes: structuredClone(applies), screenshot: { file: `${stage}.png`, bytes: png.length, sha256: hash(png), ...size } }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await persist()
  return { ...size, pixels }
}

async function openWindow(): Promise<Electron.WebContents> {
  if (currentWindow) {
    const previous = currentWindow, previousGeneration = generation; currentWindow = null
    recordLifecycle('replacement-destroy-started', previousGeneration, 'intentional-replacement')
    if (!previous.isDestroyed()) previous.destroy()
    assert.equal(previous.isDestroyed(), true)
    recordLifecycle('replacement-destroyed', previousGeneration, 'intentional-replacement')
    cleanup.push({ at: now(), closedRendererGeneration: previousGeneration, destroyed: true })
    isolatedSession?.webRequest.onBeforeRequest(null)
  }
  generation += 1
  const windowGeneration = generation
  if (firstFailure || stopping) throw firstFailure ?? new Error('Stopped before renderer creation')
  if (admissionDeadline) clearTimeout(admissionDeadline)
  const rendererAdmissionEndsAt = Date.now() + 8000
  admissionDeadline = setTimeout(() => fail(new Error(`Renderer ${windowGeneration} failed positive Canvas admission within 8 seconds of window creation`)), 8000)
  isolatedSession = session.fromPartition(`worlds-authoring-${path.basename(bundle)}-${generation}`)
  const allowed = new Set(Object.keys(build.outputs).filter((name) => name.startsWith('renderer/')).map((name) => `${origin}/${name.slice('renderer/'.length)}`))
  for (const relative of assetPaths) allowed.add(`${origin}/workspace/${relative}`)
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    const accepted = (allowed.has(details.url) && details.method === 'GET') || (!!localAi && isLocalAiRoute(details.url, details.method, origin))
    network.push({ at: now(), source: 'session', url: details.url, method: details.method, webContentsId: details.webContentsId, accepted })
    callback({ cancel: !accepted })
    if (!accepted) fail(new Error(`Unexpected network request ${details.method} ${details.url}`))
  })
  const pointerLockPermissionPolicy = createWorldSculptPointerLockPermissionPolicy({
    runtimeMode,
    expectedOrigin: origin,
    expectedDocumentUrl: indexUrl,
    getOwnedWebContents: () => currentWindow && !currentWindow.isDestroyed() && !currentWindow.webContents.isDestroyed()
      ? currentWindow.webContents
      : null,
    onDeniedRequest: (permission) => fail(new Error(`Unexpected permission request ${permission}`)),
  })
  isolatedSession.setPermissionRequestHandler(pointerLockPermissionPolicy.request)
  isolatedSession.setPermissionCheckHandler(pointerLockPermissionPolicy.check)
  const window = new BrowserWindow({ width: 1600, height: 1000, useContentSize: true, show: false, title: 'Worlds native authoring — private fixture',
    webPreferences: { preload: path.join(bundle, 'preload.cjs'), session: isolatedSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  currentWindow = window
  recordLifecycle('created', windowGeneration)
  window.webContents.setWindowOpenHandler(() => { fail(new Error('Unexpected window-open request')); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => { if (url !== indexUrl) { event.preventDefault(); fail(new Error(`Unexpected navigation ${url}`)) } })
  window.webContents.on('will-attach-webview', (event) => { event.preventDefault(); fail(new Error('Unexpected webview')) })
  window.webContents.on('preload-error', (_event, _preloadPath, error) => fail(error))
  window.webContents.on('render-process-gone', (_event, details) => { if (!stopping && currentWindow === window) fail(new Error(`Owned renderer exited: ${details.reason}`)) })
  window.on('unresponsive', () => fail(new Error('Owned renderer unresponsive')))
  const classification = (): LifecycleClassification => stopping ? 'teardown' : currentWindow === window ? 'active' : 'intentional-replacement'
  window.on('close', () => recordLifecycle('close', windowGeneration, classification()))
  window.on('closed', () => {
    recordLifecycle('closed', windowGeneration, classification())
    if (!stopping && currentWindow === window) fail(new Error('Owned window closed unexpectedly'))
  })
  window.webContents.on('console-message', (details) => { if (details.level === 'error') fail(new Error(`Renderer console: ${details.message}`)) })
  window.webContents.on('ipc-message', (_event, channel) => { if (channel !== 'worlds-authoring:violation') fail(new Error(`Unexpected one-way IPC ${channel}`)) })
  window.webContents.on('ipc-message-sync', (_event, channel) => fail(new Error(`Unexpected synchronous IPC ${channel}`)))
  await window.loadURL(indexUrl)
  window.show(); window.focus(); window.webContents.focus()
  evidence[`renderer-focus-${generation}`] = await waitForOwnedWindowFocus(window, {
    deadline: rendererAdmissionEndsAt, signal: focusAdmissionAbort.signal,
    assertOwned() {
      if (firstFailure || stopping) throw firstFailure ?? new Error('Fixture is stopping')
      assert.equal(currentWindow, window, 'Owned fixture window replaced during native focus admission')
      const windows = BrowserWindow.getAllWindows()
      assert.equal(windows.length, 1, 'Unexpected window ownership')
      assert.equal(windows[0], window, 'Unexpected native focus admission owner')
    },
  })
  guard()
  evidence[`renderer-${generation}`] = { at: now(), webContentsId: window.webContents.id, osPid: window.webContents.getOSProcessId(), sessionPartition: `worlds-authoring-${path.basename(bundle)}-${generation}`, url: indexUrl, requestedPreferences: report.requestedWebPreferences, sandboxProof: 'Verified by real sandboxed preload process flags and absent renderer Node globals during admission' }
  return window.webContents
}

async function run(): Promise<void> {
  if (inheritedDisplay) {
    const bundledWorldSculpt = worldSculptInput ? await readFile(path.join(bundle, worldSculptInput.bundled.relativePath)) : null
    await provisionAuthoringInputs(workspace, worldSculptInput && bundledWorldSculpt ? { contract: worldSculptInput, bytes: bundledWorldSculpt } : undefined)
    seedRecords.push({ phase: 'INPUT_PROVISIONING_ONLY', paths: assetPaths, canonicalSeed: false, at: now() })
    const empty = await repository.list()
    assert.ok(empty.ok && empty.value.projects.length === 0, 'Native UI lane must start with no canonical projects')
  } else seed = await seedAuthoring(repository, workspace, (entry) => seedRecords.push(entry))
  seedFiles = await diskManifest(workspace)
  evidence.seed = seed; evidence.seedFiles = seedFiles
  if (!inheritedDisplay) evidence.seedLedger = JSON.parse(await readFile(path.join(workspace, 'Worlds', PROJECT_KEY, '.modly/state.v1.json'), 'utf8'))
  await persist(); verifySources()
  await app.whenReady()
  if (firstFailure || stopping) throw firstFailure ?? new Error('Stopped before owned server creation')
  await startLocalAi()
  evidence.gpuFeatureStatus = app.getGPUFeatureStatus()
  const served = new Map<string, { bytes: Buffer; type: string }>()
  for (const relative of Object.keys(build.outputs).filter((name) => name.startsWith('renderer/'))) {
    const route = `/${relative.slice('renderer/'.length)}`
    const ext = path.extname(relative), type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' } as Record<string, string>)[ext]
    assert.ok(type, `Unknown renderer output MIME contract: ${relative}`)
    served.set(route, { bytes: await readFile(path.join(bundle, relative)), type })
  }
  for (const relative of assetPaths) served.set(`/workspace/${relative}`, { bytes: await readFile(path.join(workspace, relative)), type: 'model/gltf-binary' })
  server = createServer((request, response) => {
    if (localAi && isLocalAiRoute(`${origin}${request.url ?? ''}`, request.method ?? '', origin) && !stopping) {
      const operation = proxyLocalAi(request, response).catch((error) => { request.destroy(); response.destroy(); fail(error) })
      aiRequests.add(operation); void operation.finally(() => aiRequests.delete(operation))
      return
    }
    const route = request.url ?? '', entry = served.get(route)
    const accepted = request.method === 'GET' && request.headers.host === origin.slice('http://'.length) && !!entry && !stopping
    network.push({ at: now(), source: 'server', method: request.method, route, accepted })
    if (!accepted || !entry) { response.writeHead(403); response.end(); fail(new Error(`Unknown owned-server request ${request.method} ${route}`)); return }
    response.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': entry.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end(entry.bytes)
  })
  server.on('error', fail)
  server.on('upgrade', (_request, socket) => { socket.destroy(); fail(new Error('Unexpected websocket upgrade')) })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`; indexUrl = `${origin}/index.html`
  evidence.hostPorts = { origin, routes: [...served.keys()], assetLibrary: inheritedDisplay ? 'production-disk-library-registration' : 'empty-list/refused-open-read', externalBackendAttached: !!localAi }
  currentStage = 'positive-canvas-admission'
  const contents = await openWindow()
  const ports: Omit<DriverPorts, 'seed'> = {
    guard, inputGuard, applies: () => applies, arm, held: () => gate?.state === 'held', abort: abortGate,
    release: () => { assert.equal(gate?.state, 'held'); gate!.state = 'released'; evidence.gateReleasedAt = now(); gate!.continue(true) },
    checkpoint, reopen: openWindow,
    stage: (name) => { currentStage = name },
    record: (name, value) => { evidence[name] = value },
    pass: async (name) => {
      if ((name === 'positive-canvas-admission' || name === 'fresh-repository-and-renderer-reopen') && admissionDeadline) { clearTimeout(admissionDeadline); admissionDeadline = null }
      checks.find((check) => check.name === name)!.status = 'PASS'; delete checks.find((check) => check.name === name)!.reason; await persist()
    },
  }
  const aiPorts: AiDriverPorts = {
    ...ports, config: localAi!, reviewedModel: reviewedAiModel!, deadline: mainDeadline, admitNativeFocus,
    currentContents: () => { assert.ok(currentWindow); return currentWindow.webContents },
    receipts: () => ({ discoveries: aiDiscoveries, chats: aiChats, queries: aiQueries, previews: aiPreviews, discards: aiDiscards, discoveryRequests: modelRequests, chatRequests }),
    nativeClickWitness: (label) => structuredClone(evidence[`native-click-hover-${label}`]),
    admitReopened(view) {
      assert.ok(view.canvas && !view.canvas.contextLost && view.canvas.frame > 1)
      assert.deepEqual(view.environment, { sandboxed: true, contextIsolated: true }); assert.deepEqual(view.nodeGlobals, { require: 'undefined', process: 'undefined' })
      if (admissionDeadline) { clearTimeout(admissionDeadline); admissionDeadline = null }
      evidence.actualAiRendererAdmission = { at: now(), bootId: view.bootId, frame: view.canvas.frame }
    },
    async documentState(view) {
      assert.ok(view.editor.session && view.editor.projectKey)
      const snapshot = view.editor.session.snapshot, projectKey = view.editor.projectKey
      const fresh = await new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey })
      assert.ok(fresh.ok && fresh.value.status === 'ready'); assert.deepEqual(fresh.value.snapshot, snapshot); assert.deepEqual(fresh.value.durabilityWarnings, [])
      const paths = [`Worlds/${projectKey}/project.world-project.json`, ...snapshot.project.scenes.map((scene) => scene.documentPath)].sort()
      const documents = []
      for (const relative of paths) {
        assert.ok(relative.startsWith(`Worlds/${projectKey}/`) && !relative.split('/').includes('..'))
        const filename = path.join(workspace, relative); assert.equal(realpathSync(filename), filename); assert.ok((await lstat(filename)).isFile())
        const bytes = await readFile(filename); documents.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) })
      }
      return { snapshot: structuredClone(snapshot), history: { undo: view.editor.session.undoStack.length, redo: view.editor.session.redoStack.length }, documents }
    },
    async sourceWitnesses(preview, rows) {
      assert.ok(preview.result.ok); const candidate = preview.result.value.result.snapshot
      const handles = [...new Set(preview.request.proposal.commands.flatMap((command) => command.type === 'create-entity' && command.kind === 'observed-model' ? [command.resourceHandle] : []))]
      assert.equal(handles.length, 1, 'Requested SAME opaque source must be used for both new models')
      const witnesses = []
      for (const handle of handles) {
        const row = rows.find((row) => row.id === handle && row.format === 'glb' && row.capability === 'mesh'); assert.ok(row)
        const matching = []
        for (const resource of candidate.project.resources) {
          if (resource.type !== 'model' || resource.format !== 'glb') continue
          assert.ok(assetPaths.includes(resource.workspacePath), 'Native fixture never serves arbitrary model paths')
          const proof = await observeWorldAiSource(workspace, resource.workspacePath)
          if (proof.fingerprint === row.fingerprint) matching.push({ resource, proof })
        }
        assert.equal(matching.length, 1, 'Opaque source must resolve to exactly one actual canonical GLB resource')
        const { resource, proof } = matching[0], bytes = await readFile(path.join(workspace, resource.workspacePath))
        assert.equal(proof.format, 'glb'); assert.equal(proof.files.length, 1); assert.equal(proof.files[0].sha256, hash(bytes)); assert.equal(proof.files[0].byteLength, bytes.length)
        witnesses.push({ handle, resourceId: resource.id, fingerprint: proof.fingerprint, proof: structuredClone(proof), input: { bytes: bytes.length, sha256: hash(bytes), rawBase64: bytes.toString('base64') } })
      }
      return witnesses
    },
    async stored(entry) {
      assert.ok(entry.result?.ok)
      const value = entry.result.value
      const witness = storedWitnesses.find((w) => w.transaction.transactionId === value.receipt.transactionId && w.projectKey === entry.request.projectKey)
      assert.ok(witness); const bytes = await readFile(witness.filename); assert.equal(bytes.length, witness.bytes); assert.equal(hash(bytes), witness.sha256); assertStoredResult(bytes, witness.transaction, value)
      return { verified: true, transactionId: witness.transaction.transactionId, snapshot: structuredClone(value.snapshot), inverse: structuredClone(value.inverse), witness: structuredClone(witness) }
    },
    async capture(stage, view, contents) {
      assertCurrentAiContents(contents); const shot = await checkpoint(stage, view, contents), bytes = await readFile(path.join(runDirectory, `${stage}.png`))
      return { shot, screenshot: { filename: `${stage}.png`, bytes: bytes.length, sha256: hash(bytes) } }
    },
  }
  if (inheritedDisplay) {
    const authored = await runUiAuthoredScenes(contents, ports, worldSculptInput ? 1 : 0)
    await runAuthoringInteractions(contents, { ...ports, seed: authored.seed }, authored)
    if (worldSculptInput) {
      assert.ok(currentWindow)
      const workspaceBytes = await readFile(path.join(workspace, worldSculptInput.workspaceRelativePath))
      const servedEntry = served.get(`/workspace/${worldSculptInput.workspaceRelativePath}`)
      assert.ok(servedEntry)
      await runWorldSculptNavigationAcceptance(currentWindow.webContents, {
        ...ports,
        source: {
          bytes: worldSculptInput.sourceIdentity.bytes,
          sourceSha256: worldSculptInput.sourceIdentity.sha256,
          bundledSha256: worldSculptInput.bundled.sha256,
          workspaceSha256: hash(workspaceBytes),
          servedSha256: hash(servedEntry.bytes),
        },
      }, authored)
    }
  } else {
    assert.ok(seed)
    await runAuthoringInteractions(contents, { ...ports, seed })
  }
  if (localAi) {
    assert.ok(currentWindow)
    assertCurrentAiContents(currentWindow.webContents)
    await runActualOllamaDriver(currentWindow.webContents, aiPorts)
    Object.assign(report.localAi as Record<string, unknown>, { status: 'PASS' })
    Object.assign(evidence.actualApi as Record<string, unknown>, { aiInteraction: 'ACTUAL_SINGLE_CHAT_CAMERA_AUTO_APPLY_COMPLETE' })
  }
  guard(); verifySources()
  if (!inheritedDisplay) assert.equal(applies.length, 4)
  assert.ok(checks.every((check) => check.status === 'PASS'))
  report.status = 'PASS'
}

console.log(`worlds-authoring: evidence=${runDirectory}`)
const execution = run()
void execution.catch(() => undefined)
void Promise.race([execution, fatal]).catch(async (error: unknown) => {
  fail(error); report.status = 'FAIL'
  if (currentStage) { const check = checks.find((value) => value.name === currentStage)!; if (check.status !== 'PASS') { check.status = 'FAIL'; check.reason = String(error) } }
  if (checks[0].status !== 'PASS') report.authoring = 'UNREACHED — positive Canvas admission failed'
  if (currentWindow && !currentWindow.isDestroyed()) {
    try { evidence.failureView = await Promise.race([readView(currentWindow.webContents), new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('Failure view timed out')), 1000))]) } catch (caught) { cleanup.push({ failureViewError: String(caught) }) }
    try {
      const image = await Promise.race([currentWindow.webContents.capturePage(), new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('Failure screenshot timed out')), 1000))])
      await writeFile(path.join(runDirectory, 'failure.png'), image.toPNG())
    } catch (caught) { cleanup.push({ failureScreenshotError: String(caught) }) }
  }
}).finally(async () => {
  stopping = true; focusAdmissionAbort.abort(firstFailure ?? new Error('Fixture is stopping')); abortGate()
  recordLifecycle('owned-cleanup-started')
  upstreamAbort.abort(firstFailure ?? new Error('Owned fixture teardown'))
  if (admissionDeadline) clearTimeout(admissionDeadline)
  const closeDeadline = setTimeout(() => {
    try {
    report.status = 'FAIL'; cleanup.push({ deadline: `Main cleanup exceeded ${localAi?.cleanupSeconds ?? 3} seconds` })
    cleanup.push({ terminalExit: 'forced', ownedCleanupComplete: false, reason: 'hard-cleanup-deadline' })
    recordLifecycle('forced-incomplete-deadline-exit')
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    } finally { app.exit(1) }
  }, (localAi?.cleanupSeconds ?? 3) * 1000)
  let cleanupCompleted = false
  try {
    try {
    if (currentWindow && !currentWindow.isDestroyed()) { currentWindow.destroy(); cleanup.push({ ownedWindowDestroyed: currentWindow.isDestroyed(), at: now() }) }
    recordLifecycle('owned-window-cleanup-terminal')
    isolatedSession?.webRequest.onBeforeRequest(null)
    for (const channel of ownedChannels) ipcMain.removeHandler(channel)
    ipcMain.removeListener('worlds-authoring:violation', onViolation)
    cleanup.push({ unregisteredOwnedChannels: ownedChannels, gate: gate?.state ?? 'unarmed' })
    recordLifecycle('owned-channel-cleanup-terminal')
    if (server) { const closing = new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve())); server.closeAllConnections(); await (localAi ? bounded(closing, 1000, 'Owned static server drain timed out') : closing); cleanup.push({ ownedServerClosed: true }) }
    recordLifecycle('owned-static-cleanup-terminal')
    } finally { await stopLocalAi(); recordLifecycle('owned-api-cleanup-terminal') }
    evidence.finalWorkspaceManifest = await diskManifest(workspace)
    recordLifecycle('final-workspace-manifest')
    report.finishedAt = now()
    await persist()
    cleanupCompleted = true
    recordLifecycle('owned-cleanup-persisted')
  } catch (error) { report.status = 'FAIL'; cleanup.push({ error: String(error) }); writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`) }
  finally {
    let exitCode = 1
    try {
      if (cleanupCompleted) {
        cleanup.push({ terminalExit: 'ordinary', ownedCleanupComplete: true })
        recordLifecycle('terminal-publication-ready')
      } else {
        report.status = 'FAIL'; cleanup.push({ terminalExit: 'forced', ownedCleanupComplete: false, reason: 'owned-cleanup-error' })
        recordLifecycle('forced-incomplete-cleanup-error-exit')
      }
      // Keep normal quit unauthorized and the cleanup bound live through fallible terminal work.
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      disposeOwnedLifecycleListeners()
      terminalExitAuthorized = cleanupCompleted
      if (terminalExitAuthorized) recordLifecycle('terminal-exit-authorized')
      console.log(`worlds-authoring: ${report.status}; report=${reportPath}`)
      exitCode = terminalExitAuthorized && report.status === 'PASS' ? 0 : 1
    } catch (error) {
      terminalExitAuthorized = false; report.status = 'FAIL'; exitCode = 1
      cleanup.push({ terminalExit: 'forced', ownedCleanupComplete: false, reason: 'terminal-publication-or-disposal', terminalError: String(error) })
      try {
        recordLifecycle('forced-incomplete-terminal-error-exit')
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      } catch { /* Terminal publication is best effort; failure must not suppress the forced exit attempt. */ }
      try { console.error(`worlds-authoring: forced incomplete terminal exit; ${String(error)}`) } catch { /* Logging is also best effort. */ }
    } finally {
      clearTimeout(watchdog); clearTimeout(closeDeadline)
      // Immediate forced app.exit and OS termination can still bypass these owned normal-quit guards.
      app.exit(exitCode)
    }
  }
})
