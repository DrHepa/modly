import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { WorldProjectRepository } from '../../electron/main/world-project-repository.ts'
import { registerWorldProjectsIpcHandlers } from '../../electron/main/world-projects-ipc.ts'
import { buildAddEmptyEntityCommands } from '../../src/areas/worlds/editor/worldAuthoringModel.ts'
import { createDeterministicWorldEditorIdentityGenerator } from '../../src/areas/worlds/editor/worldEditorCommandBuilders.ts'
import { WORLD_COMMAND_BATCH_SCHEMA } from '../../src/areas/worlds/core/worldModel.ts'
import { readFixtureView, readFocusedControl, runCharacterInteractions } from './driver.ts'
import { assertSandboxLaunch, FIXTURE_PROJECT_KEY, FIXTURE_SCENE_KEY, FIXTURE_TARGET_NAME, SANDBOX_DISABLING_SWITCHES, type FixtureCheckpoint } from './shared.ts'

assertSandboxLaunch(process.argv, process.env)
for (const flag of SANDBOX_DISABLING_SWITCHES) {
  if (app.commandLine.hasSwitch(flag)) throw new Error(`Refusing active sandbox-disabling switch: ${flag}`)
}
const bundleDirectory = realpathSync(__dirname)
assert.equal(bundleDirectory, path.resolve(__dirname))
assert.match(path.basename(bundleDirectory), /^modly-worlds-character-ui-/)
const buildEvidence = JSON.parse(readFileSync(path.join(bundleDirectory, 'fixture-build.json'), 'utf8'))
assert.equal(buildEvidence.schema, 'modly.worlds-character-ui-build.v1')
const runDirectory = mkdtempSync(path.join(bundleDirectory, 'run-'))
const workspace = path.join(runDirectory, 'workspace')
const userData = path.join(runDirectory, 'userData')
const sessionData = path.join(runDirectory, 'sessionData')
const crashDumps = path.join(runDirectory, 'crashDumps')
for (const directory of [workspace, userData, sessionData, crashDumps]) mkdirSync(directory, { mode: 0o700 })
// Synchronous setup is intentional: these paths and sandbox mode must be set before app readiness.
app.setName('Worlds Character Fixture')
app.setPath('userData', userData)
app.setPath('sessionData', sessionData)
app.setPath('crashDumps', crashDumps)
app.enableSandbox()
app.on('window-all-closed', () => {})

const checkpoints: FixtureCheckpoint[] = []
const rendererErrors: string[] = []
const focusDiagnostics: Array<{ name: string; evidence: unknown }> = []
const report: Record<string, unknown> = {
  schema: 'modly.worlds-character-ui-run.v1',
  scope: 'source-level-character-authoring',
  included: ['production-inspector-overlay-focus-helper'],
  excluded: ['full-compact-workbench-layout', 'Play', 'packaged-application'],
  status: 'RUNNING', startedAt: new Date().toISOString(), runDirectory, workspace, userData, sessionData,
  pid: process.pid, versions: process.versions, build: buildEvidence, checkpoints, rendererErrors, focusDiagnostics,
  launch: {
    argv: [...process.argv],
    sandboxDisablingSwitches: Object.fromEntries(SANDBOX_DISABLING_SWITCHES.map((flag) => [flag, app.commandLine.hasSwitch(flag)])),
  },
}
const reportPath = path.join(runDirectory, 'fixture-report.json')
const watchdog = setTimeout(() => {
  Object.assign(report, { status: 'FAIL', error: 'Fixture exceeded its 90 second deadline.', finishedAt: new Date().toISOString() })
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  app.exit(1)
}, 90_000)
console.log(`worlds-character-fixture: evidence=${runDirectory}`)

let fixtureWindow: BrowserWindow | null = null

async function run(): Promise<void> {
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => FIXTURE_PROJECT_KEY, createSceneKey: () => FIXTURE_SCENE_KEY })
  const created = await repository.create({ name: 'Character UI fixture', initialSceneName: 'Scene 1', projectId: 'project:character-fixture', initialSceneId: 'scene:character-fixture' })
  assert.ok(created.ok, created.ok ? undefined : created.error.message)
  const commands = buildAddEmptyEntityCommands({
    snapshot: created.value.snapshot, projectKey: created.value.projectKey,
    activeSceneId: created.value.snapshot.project.startSceneId,
    identities: createDeterministicWorldEditorIdentityGenerator('character-ui-fixture-seed'),
  }, { name: FIXTURE_TARGET_NAME })
  const seeded = await repository.applyCommands({ projectKey: FIXTURE_PROJECT_KEY, batch: {
    schema: WORLD_COMMAND_BATCH_SCHEMA, transactionId: 'tx:character-fixture-seed', origin: 'ui',
    projectId: created.value.snapshot.project.projectId, baseRevision: created.value.snapshot.project.revision, commands,
  } })
  assert.ok(seeded.ok, seeded.ok ? undefined : seeded.error.message)
  await app.whenReady()
  const partition = `worlds-character-fixture-${path.basename(runDirectory)}`
  const isolatedSession = session.fromPartition(partition)
  const filePrefix = pathToFileURL(`${bundleDirectory}${path.sep}`).href
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(filePrefix) && details.url !== 'about:blank' })
  })
  const requestedWebPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false } as const satisfies Electron.WebPreferences
  report.requestedWebPreferences = requestedWebPreferences
  const window = new BrowserWindow({
    title: 'Worlds character fixture — isolated', width: 1120, height: 940, show: true,
    webPreferences: {
      preload: path.join(bundleDirectory, 'preload.cjs'), session: isolatedSession,
      ...requestedWebPreferences, backgroundThrottling: false,
    },
  })
  fixtureWindow = window
  registerWorldProjectsIpcHandlers(ipcMain, repository, {
    isTrustedSender: (value) => {
      const event = value as Electron.IpcMainInvokeEvent
      return !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    },
  })
  const indexPath = path.join(bundleDirectory, 'index.html')
  const indexUrl = pathToFileURL(indexPath).href
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== indexUrl) event.preventDefault() })
  const rendererFailure = new Promise<never>((_resolve, reject) => {
    window.webContents.on('render-process-gone', (_event, details) => reject(new Error(`Fixture renderer exited: ${details.reason}`)))
    window.webContents.on('preload-error', (_event, _preloadPath, error) => reject(error))
    window.on('unresponsive', () => reject(new Error('Fixture window is unresponsive.')))
    window.on('closed', () => reject(new Error('Fixture window closed before completion.')))
  })
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') rendererErrors.push(details.message)
  })
  await Promise.race([window.loadFile(indexPath), rendererFailure])
  window.show()
  window.focus()
  window.webContents.focus()
  assert.equal(window.isFocused(), true, 'Native event input requires this fixture window to be focused.')
  const result = await Promise.race([runCharacterInteractions(window.webContents, async (entry) => {
    // A fresh repository instance independently checks the committed snapshot after every interaction.
    const reader = new WorldProjectRepository({ getWorkspaceRoot: () => workspace })
    const persisted = await reader.open({ projectKey: FIXTURE_PROJECT_KEY })
    assert.ok(persisted.ok && persisted.value.status === 'ready')
    assert.deepEqual(persisted.value.snapshot, entry.snapshot)
    checkpoints.push(structuredClone(entry))
    await writeFile(reportPath, JSON.stringify(report, null, 2))
  }, async (name, evidence) => {
    if (focusDiagnostics.length >= 4) throw new Error('Fixture exceeded its bounded focus diagnostic count.')
    focusDiagnostics.push({ name, evidence })
    await writeFile(reportPath, JSON.stringify(report, null, 2))
  }), rendererFailure])
  assert.equal(rendererErrors.length, 0, 'Renderer errors are not allowed to masquerade as successful interaction evidence.')
  await writeFile(path.join(runDirectory, 'character-inspector.png'), (await window.webContents.capturePage()).toPNG())
  Object.assign(report, { status: 'PASS', sandbox: result.finalView.environment, nativeInputs: result.nativeInputs, screenshot: 'character-inspector.png' })
}

void run().catch(async (error: unknown) => {
  Object.assign(report, { status: 'FAIL', error: error instanceof Error ? error.stack ?? error.message : String(error) })
  if (fixtureWindow && !fixtureWindow.isDestroyed()) {
    try {
      report.failureView = await readFixtureView(fixtureWindow.webContents)
      report.failureFocus = await readFocusedControl(fixtureWindow.webContents)
    } catch { /* Preserve the original failure even if the renderer is gone. */ }
    try { await writeFile(path.join(runDirectory, 'failure.png'), (await fixtureWindow.webContents.capturePage()).toPNG()) } catch { /* Preserve the original failure. */ }
  }
}).finally(async () => {
  clearTimeout(watchdog)
  report.finishedAt = new Date().toISOString()
  try {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`worlds-character-fixture: ${report.status}; report=${reportPath}`)
  } finally {
    if (fixtureWindow && !fixtureWindow.isDestroyed()) fixtureWindow.destroy()
    app.exit(report.status === 'PASS' ? 0 : 1)
  }
})
