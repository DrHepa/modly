import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { WorldProjectRepository } from '../../electron/main/world-project-repository.ts'
import { registerWorldProjectsIpcHandlers } from '../../electron/main/world-projects-ipc.ts'
import { AgentSessionStore } from '../../electron/main/agent-session-store.ts'
import { AutomationHttpBridge } from '../../electron/main/automation-http-bridge.ts'
import { buildAddEmptyEntityCommands } from '../../src/areas/worlds/editor/worldAuthoringModel.ts'
import { createDeterministicWorldEditorIdentityGenerator } from '../../src/areas/worlds/editor/worldEditorCommandBuilders.ts'
import { WORLD_COMMAND_BATCH_SCHEMA } from '../../src/areas/worlds/core/worldModel.ts'
import { assertFixtureLaunch, childEnvironment, createRunFence, isFixtureSender, PROJECT_KEY, SCENE_KEY, TARGET_NAME, requireEphemeralOrigin, type FixtureStartup } from './shared.ts'
import { digest, fingerprintTree, inspectWorld } from './inspection.ts'
import { readView, runAiInteractions, runResponsiveChecks, type PageView } from './driver.ts'
import { safeFixtureRequest, safeResponseCorsHeaders } from './httpDiagnostics.ts'

export function startFixture(startup: FixtureStartup): void {
const { bundleDirectory, build, launch, builtinFileAccess } = startup
assertFixtureLaunch(process.argv, process.env, launch)
assert.equal(realpathSync(__dirname), bundleDirectory)
const { userData, sessionData, crashDumps } = launch.paths
for (const name of ['userData', 'sessionData', 'crashDumps'] as const) assert.equal(app.getPath(name), launch.paths[name])
const runDirectory = mkdtempSync(path.join(bundleDirectory, 'run-'))
const workspace = path.join(runDirectory, 'workspace')
mkdirSync(workspace, { mode: 0o700 })
app.on('window-all-closed', () => {})
const backendEvents: Array<Record<string, unknown>> = []
const browserHttpEvents: Array<Record<string, unknown>> = []
const queries: Array<Record<string, unknown>> = []
const checkpoints: Array<Record<string, unknown>> = []
const rendererErrors: string[] = []
const blockedRequests: string[] = []
const report: Record<string, unknown> = {
  schema: 'modly.worlds-ai-ui-run.v1', status: 'RUNNING', scope: 'source-level-edit-only-ai-direct-edit', provider: 'DETERMINISTIC_NDJSON_STUB',
  excluded: ['live-model', 'full-Workbench', 'GPU', 'Play', 'native-cancellation-stale-scene-branches', 'screen-reader', 'packaged-application'],
  runDirectory, workspace, userData, sessionData, startedAt: new Date().toISOString(), pid: process.pid, versions: process.versions,
  build, launch, builtinFileAccess, backendEvents, browserHttpEvents, queries, checkpoints, rendererErrors, blockedRequests, display: process.env.DISPLAY,
}
const reportPath = path.join(runDirectory, 'fixture-report.json')
// Synchronous small evidence writes cannot race a later terminal write.
const persist = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
let window: BrowserWindow | null = null
let child: ChildProcess | null = null
let childClosed: Promise<void> | null = null
let bridge: AutomationHttpBridge | null = null
const fence = createRunFence()
let failed = false
let stoppingChild = false
let destroyingWindow = false
let rejectFailure: (error: unknown) => void = () => {}
const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject })
function fail(error: unknown): void {
  // Latch before any await: Promise.race does not cancel its losing run.
  if (!failed) {
    failed = true
    Object.assign(report, { status: 'FAIL', error: error instanceof Error ? error.stack ?? error.message : String(error) })
  }
  fence.close()
  rejectFailure(error)
}
void failure.catch(() => {}) // Retain a settled sink through late child/renderer events and cleanup.
const watchdog = setTimeout(() => fail(new Error('Native AI fixture exceeded its 120 second deadline.')), 120_000)
console.log(`worlds-ai-fixture: evidence=${runDirectory}`)

async function bounded<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded.`)), milliseconds) })
  try { return await Promise.race([operation, deadline]) } finally { clearTimeout(timer) }
}

async function startBackend(bridgeOrigin: string): Promise<string> {
  fence.assertOpen()
  const runId = randomUUID()
  const configPath = path.join(runDirectory, 'backend-config.json')
  await writeFile(configPath, JSON.stringify({ runId, bridgeOrigin, projectKey: PROJECT_KEY }), { flag: 'wx', mode: 0o600 })
  fence.assertOpen()
  let ready: (value: string) => void = () => {}
  const readiness = new Promise<string>((resolve) => { ready = resolve })
  child = spawn(build.pythonExecutable, ['-I', '-B', path.join(bundleDirectory, 'backend/backend.py'), configPath], {
    cwd: runDirectory, env: childEnvironment(runDirectory), stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  })
  const ownedChild = child
  report.backendPid = ownedChild.pid
  let buffer = ''; let stdoutBytes = 0; let stderr = ''; let isReady = false
  childClosed = new Promise((resolve) => {
    ownedChild.once('error', (error) => fail(error))
    const observeExit = (code: number | null, signal: NodeJS.Signals | null) => {
      report.backendExit = { code, signal }
      if (!stoppingChild || (code !== 0 && signal !== 'SIGTERM')) fail(new Error(`Fixture backend exited: ${code ?? signal}`))
    }
    ownedChild.once('exit', observeExit) // exit precedes close while piped output may still be pending.
    ownedChild.once('close', (code, signal) => {
      observeExit(code, signal)
      if (buffer.trim()) fail(new Error('Fixture backend closed with incomplete output.'))
      resolve()
    })
  })
  ownedChild.stdout!.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length
    if (stdoutBytes > 128 * 1024) { fail(new Error('Fixture backend output exceeded its bound.')); return }
    buffer += chunk.toString()
    try {
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n'); const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (!line) continue
        const event = JSON.parse(line) as Record<string, unknown>
        assert.ok(backendEvents.length < 64); backendEvents.push(event)
        if (event.kind === 'ready') {
          assert.equal(isReady, false); assert.equal(event.pid, ownedChild.pid); assert.equal(event.runId, runId); assert.equal(event.bridgeOrigin, bridgeOrigin)
          assert.equal(event.provider, 'DETERMINISTIC_NDJSON_STUB')
          const origin = requireEphemeralOrigin(event.apiOrigin); assert.notEqual(origin, bridgeOrigin)
          isReady = true; ready(origin)
        }
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  })
  ownedChild.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); report.backendStderr = stderr.slice(0, 32768); if (stderr.length > 32768) fail(new Error('Fixture backend stderr exceeded its bound.')) })
  const timer = setTimeout(() => fail(new Error('Fixture backend startup exceeded 15 seconds.')), 15_000)
  try { return await Promise.race([readiness, failure]) } finally { clearTimeout(timer) }
}

async function run(): Promise<void> {
  fence.assertOpen()
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => PROJECT_KEY, createSceneKey: () => SCENE_KEY })
  const created = await repository.create({ name: 'AI direct-edit fixture', initialSceneName: 'Scene 1', projectId: 'project:ai-fixture', initialSceneId: 'scene:ai-fixture' })
  fence.assertOpen()
  assert.ok(created.ok)
  const identities = createDeterministicWorldEditorIdentityGenerator('ai-fixture-seed')
  const seedContext = { snapshot: created.value.snapshot, projectKey: PROJECT_KEY, activeSceneId: 'scene:ai-fixture', identities }
  const seeded = await repository.applyCommands({ projectKey: PROJECT_KEY, batch: {
    schema: WORLD_COMMAND_BATCH_SCHEMA, transactionId: 'tx:ai-fixture-seed', origin: 'ui', projectId: 'project:ai-fixture', baseRevision: created.value.snapshot.project.revision,
    commands: [...buildAddEmptyEntityCommands(seedContext, { name: TARGET_NAME }), ...buildAddEmptyEntityCommands(seedContext, { name: 'Unchanged witness' })],
  } })
  assert.ok(seeded.ok)
  await app.whenReady()
  fence.assertOpen()
  const denyUnrelated = async (): Promise<never> => { throw new Error('Unrelated production service is not available in this fixture.') }
  bridge = new AutomationHttpBridge({ host: '127.0.0.1', port: 0,
    queryWorld: async (request) => {
      assert.equal(request.context.projectKey, PROJECT_KEY)
      const before = await fingerprintTree(path.join(workspace, 'Worlds'))
      const result = await repository.queryAi(request)
      assert.deepEqual(await fingerprintTree(path.join(workspace, 'Worlds')), before, 'Actual HTTP query must not write the World.')
      queries.push({ request, result }); assert.ok(queries.length <= 3)
      return result
    },
    getAutomationCapabilities: denyUnrelated, createProcessRun: denyUnrelated, getProcessRun: denyUnrelated, cancelProcessRun: denyUnrelated, importSceneMesh: denyUnrelated,
    logger: { info: () => {}, warn: (message) => { report.bridgeWarning = message }, error: (message) => { report.bridgeError = message } },
  })
  await bridge.start()
  fence.assertOpen()
  const bridgeOrigin = requireEphemeralOrigin(bridge.getOrigin())
  const apiOrigin = await startBackend(bridgeOrigin)
  fence.assertOpen()
  report.origins = { bridgeOrigin, apiOrigin }
  const indexPath = path.join(runDirectory, 'renderer/index.html')
  const indexUrl = pathToFileURL(indexPath).href
  // Copies retain frozen bytes; only this run's HTML receives its exact private API origin.
  for (const relative of Object.keys(build.outputs).filter((name) => name.startsWith('renderer/assets/'))) {
    const destination = path.join(runDirectory, relative)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    fence.assertOpen()
    await copyFile(path.join(bundleDirectory, relative), destination)
    assert.deepEqual(digest(readFileSync(destination)), build.outputs[relative])
  }
  const template = readFileSync(path.join(bundleDirectory, 'renderer/index.html'), 'utf8')
  assert.equal(template.split('__FIXTURE_API_ORIGIN__').length, 2)
  const html = template.replace('__FIXTURE_API_ORIGIN__', apiOrigin)
  await writeFile(indexPath, html, { flag: 'wx', mode: 0o600 }); report.runtimeHtml = digest(Buffer.from(html))
  fence.assertOpen()
  const allowedFiles = new Set([indexUrl, ...Object.keys(build.outputs).filter((name) => name.startsWith('renderer/assets/')).map((name) => pathToFileURL(path.join(runDirectory, name)).href)])
  const modelInventoryUrl = `${apiOrigin}/agent/models?ollama_url=${encodeURIComponent(apiOrigin)}`
  const isolatedSession = session.fromPartition(`worlds-ai-fixture-${path.basename(bundleDirectory)}-${path.basename(runDirectory)}`)
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolatedSession.setPermissionCheckHandler(() => false)
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = allowedFiles.has(details.url) || details.url === 'about:blank'
      || (details.url === `${apiOrigin}/agent/chat` && ['POST', 'OPTIONS'].includes(details.method))
      || (details.url === modelInventoryUrl && details.method === 'GET')
    if (!allowed) { blockedRequests.push(JSON.stringify(safeFixtureRequest(details.url, details.method, apiOrigin))); fail(new Error('Unexpected fixture renderer request was blocked.')) }
    callback({ cancel: !allowed })
  })
  isolatedSession.webRequest.onCompleted({ urls: [`${apiOrigin}/agent/chat`] }, (details) => {
    if (browserHttpEvents.length < 32) browserHttpEvents.push({ kind: 'browser-http-complete', ...safeFixtureRequest(details.url, details.method, apiOrigin), status: details.statusCode })
  })
  isolatedSession.webRequest.onErrorOccurred({ urls: [`${apiOrigin}/agent/chat`] }, (details) => {
    if (browserHttpEvents.length < 32) browserHttpEvents.push({ kind: 'browser-fetch-rejection', ...safeFixtureRequest(details.url, details.method, apiOrigin, details.error) })
  })
  isolatedSession.webRequest.onHeadersReceived({ urls: [`${apiOrigin}/agent/chat`] }, (details, callback) => {
    if (browserHttpEvents.length < 32) browserHttpEvents.push({ kind: 'browser-response-headers', ...safeFixtureRequest(details.url, details.method, apiOrigin),
      responseCorsHeaders: safeResponseCorsHeaders(details.responseHeaders) })
    callback({})
  })
  const requestedWebPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false } as const
  report.requestedWebPreferences = requestedWebPreferences
  const fixtureWindow = new BrowserWindow({ title: 'Worlds AI fixture — isolated provider STUB', width: 1120, height: 940, show: true,
    webPreferences: { ...requestedWebPreferences, preload: path.join(bundleDirectory, 'preload.cjs'), session: isolatedSession, backgroundThrottling: false } })
  window = fixtureWindow
  const trusted = (event: unknown) => isFixtureSender(event, fixtureWindow) && fixtureWindow.webContents.getURL() === indexUrl
  registerWorldProjectsIpcHandlers(ipcMain, repository, { isTrustedSender: trusted })
  const sessionStore = new AgentSessionStore({ rootDir: path.join(userData, 'agent-sessions') })
  // Exact existing production session protocols; the broad app IPC setup is deliberately not invoked.
  for (const method of ['list', 'create', 'read', 'activate', 'rename', 'delete', 'appendMessage', 'addAttachment', 'removeAttachment', 'readAttachment'] as const) {
    const operation = sessionStore[method].bind(sessionStore) as (request?: unknown) => Promise<unknown>
    ipcMain.handle(`agentSessions:${method}`, (event, ...args: unknown[]) => {
      if (!trusted(event) || args.length !== (method === 'list' ? 0 : 1)) throw new Error('Fixture IPC sender or argument count rejected.')
      return operation(args[0])
    })
  }
  ipcMain.handle('worldsAiFixture:config', (event, ...args: unknown[]) => { if (!trusted(event) || args.length) throw new Error('Fixture config access rejected.'); return { apiOrigin } })
  fixtureWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  fixtureWindow.webContents.on('will-navigate', (event, url) => { if (url !== indexUrl) event.preventDefault() })
  fixtureWindow.webContents.on('render-process-gone', (_event, details) => { if (!destroyingWindow) fail(new Error(`Fixture renderer exited: ${details.reason}`)) })
  fixtureWindow.webContents.on('preload-error', (_event, _path, error) => fail(error))
  fixtureWindow.on('unresponsive', () => fail(new Error('Fixture renderer is unresponsive.')))
  fixtureWindow.webContents.on('console-message', (details) => { if (details.level === 'error') { rendererErrors.push(details.message); fail(new Error(`Fixture renderer error: ${details.message}`)) } })
  await fixtureWindow.loadFile(indexPath)
  fence.assertOpen()
  fixtureWindow.show(); fixtureWindow.focus(); fixtureWindow.webContents.focus()
  assert.equal(fixtureWindow.isFocused(), true)
  let baseline: Awaited<ReturnType<typeof fingerprintTree>> | null = null
  const screenshots: Record<string, ReturnType<typeof digest>> = {}
  report.screenshots = screenshots
  const checkpoint = async (name: string, view: PageView) => {
    fence.assertOpen()
    // Hash first, then raw reads. No recovering open can conceal an unintended write.
    const before = await fingerprintTree(path.join(workspace, 'Worlds'))
    const durable = await inspectWorld(workspace, PROJECT_KEY)
    assert.deepEqual(durable.snapshot, view.snapshot)
    if (name === 'initial' || name.startsWith('undone-')) baseline = before
    if (name === 'applied-3') baseline = before
    if (name === 'reopened') assert.deepEqual(before, baseline)
    assert.deepEqual(await fingerprintTree(path.join(workspace, 'Worlds')), before)
    const chatFingerprint = await fingerprintTree(path.join(userData, 'agent-sessions'))
    fence.assertOpen()
    checkpoints.push({ name, view, worldFingerprint: before, state: durable.state, chatFingerprint })
    persist()
  }
  const result = await runAiInteractions(fixtureWindow.webContents, checkpoint, async (name) => {
    fence.assertOpen()
    const bytes = (await fixtureWindow.webContents.capturePage()).toPNG()
    fence.assertOpen()
    await writeFile(path.join(runDirectory, `${name}.png`), bytes, { flag: 'wx', mode: 0o600 })
    fence.assertOpen()
    screenshots[name] = digest(bytes)
  })
  fence.assertOpen()
  report.responsive = await runResponsiveChecks(fixtureWindow.webContents, async (width, height, zoom) => {
    fence.assertOpen()
    fixtureWindow.setSize(width, height)
    fixtureWindow.webContents.setZoomFactor(zoom)
    await new Promise((resolve) => setTimeout(resolve, 120))
    fence.assertOpen()
  }, checkpoint, async (name) => {
    fence.assertOpen()
    const bytes = (await fixtureWindow.webContents.capturePage()).toPNG()
    await writeFile(path.join(runDirectory, `${name}.png`), bytes, { flag: 'wx', mode: 0o600 })
    screenshots[name] = digest(bytes)
  })
  fence.assertOpen()
  report.result = result // Only the terminal owner may decide PASS, after cleanup.
}

void Promise.race([Promise.resolve().then(run), failure]).catch(async (error: unknown) => {
  fail(error)
  try { persist() } catch (error) { report.persistenceError = String(error) }
  if (window && !window.isDestroyed()) {
    const contents = window.webContents
    try { await bounded((async () => {
      report.failureView = await readView(contents)
      await writeFile(path.join(runDirectory, 'failure.png'), (await contents.capturePage()).toPNG(), { mode: 0o600 })
    })(), 2_000, 'Failure observation') } catch { /* Preserve original failure. */ }
  }
}).finally(async () => {
  fence.close()
  const cleanup = async (operation: () => void | Promise<void>) => {
    try { await operation() } catch (error) { fail(error); report.cleanupError = String(error) }
  }
  await cleanup(() => { if (window && !window.isDestroyed()) { destroyingWindow = true; window.destroy() } })
  await cleanup(async () => {
    if (child) {
      const owned = child
      let force: ReturnType<typeof setTimeout> | undefined
      try {
        if (owned.exitCode === null && owned.signalCode === null) {
          stoppingChild = true
          try { if (!owned.kill('SIGTERM')) fail(new Error('Owned child refused shutdown signal.')) } catch (error) { fail(error) }
          force = setTimeout(() => {
            if (owned.exitCode === null && owned.signalCode === null) {
              fail(new Error('Owned child required forced shutdown.'))
              try { owned.kill('SIGKILL') } catch (error) { fail(error) }
            }
          }, 3_000)
        } else if (!stoppingChild) fail(new Error('Fixture backend exited before requested shutdown.'))
        // Non-null exitCode/signalCode is not close: wait for every spawned child
        // and its piped output/error observations before any terminal success.
        assert.ok(childClosed)
        await bounded(childClosed, 5_000, 'Owned child shutdown')
      } finally { clearTimeout(force) }
    }
  })
  await cleanup(async () => { if (bridge) await bounded(bridge.stop(), 3_000, 'Owned bridge shutdown') })
  if (!failed) {
    try {
      const result = report.result as Awaited<ReturnType<typeof runAiInteractions>>
      // Final protocol counts include any output drained during owned shutdown.
      assert.equal(queries.length, 3)
      const proposals = backendEvents.filter((event) => event.kind === 'stub-proposal')
      assert.equal(proposals.length, 3)
      for (const event of proposals) assert.equal(event.queriedEntityId, result.targetId)
      assert.equal(backendEvents.filter((event) => event.kind === 'agent-request').length, 3)
      assert.equal(backendEvents.filter((event) => event.kind === 'stub-round').length, 9)
      assert.equal(rendererErrors.length, 0); assert.equal(blockedRequests.length, 0)
    } catch (error) { fail(error) }
  }
  report.finishedAt = new Date().toISOString()
  const terminalStatus = failed ? 'FAIL' : 'PASS'
  report.status = terminalStatus
  try {
    persist()
    // Keep failure monotonic even if a persistence callback itself reports failure.
    if (report.status !== terminalStatus) persist()
  } catch (error) {
    fail(error); report.persistenceError = String(error)
    try { persist() } catch { /* An unwritable report is never a successful exit. */ }
  }
  clearTimeout(watchdog)
  console.log(`worlds-ai-fixture: ${report.status}; report=${reportPath}`)
  app.exit(failed ? 1 : 0)
})
startup.takeOwnership(fail)
}
