import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { WorldProjectRepository } from '../../electron/main/world-project-repository.ts'
import { registerWorldProjectsIpcHandlers } from '../../electron/main/world-projects-ipc.ts'
import { createPhysicsFixtureBatches } from '../worlds-physics-electron-fixture/scene.ts'
import { readGraphicsView, runGraphicsInteractions, runSupportedGraphicsInteractions, CHECK_NAMES, SUPPORTED_CHECK_NAMES, type GraphicsCheck } from './driver.ts'
import { assertSandboxLaunch, PROJECT_KEY, SCENE_KEY, SANDBOX_DISABLING_SWITCHES } from '../worlds-physics-electron-fixture/shared.ts'

declare const __GRAPHICS_CASE__: string
export function admitGraphicsNativeFocus(window: BrowserWindow, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false, requesting = false, finishing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const contents = window.webContents
    const dispose = () => {
      if (timer !== undefined) clearTimeout(timer)
      window.removeListener('focus', checkFocus)
      window.removeListener('closed', closed)
      window.removeListener('unresponsive', unresponsive)
      contents.removeListener('destroyed', destroyed)
      contents.removeListener('render-process-gone', rendererGone)
      contents.removeListener('preload-error', preloadError)
      signal.removeEventListener('abort', cancelled)
    }
    const settle = (error?: Error) => {
      if (settled) return
      settled = true; dispose()
      if (error) reject(error); else resolve()
    }
    const fail = (reason: string) => settle(new Error(`FOCUS_ADMISSION: ${reason}`))
    const closed = () => fail('Fixture window closed before native focus admission.')
    const destroyed = () => fail('Fixture window or contents destroyed before native focus admission.')
    const unresponsive = () => fail('Fixture window became unresponsive during native focus admission.')
    const rendererGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => fail(`Fixture renderer exited during native focus admission: ${details.reason}`)
    const preloadError = (_event: Electron.Event, _path: string, error: Error) => fail(`Fixture preload failed during native focus admission: ${error.message}`)
    const cancelled = () => fail(`Native focus admission cancelled: ${String(signal.reason ?? 'owner cancellation')}`)
    const checkFocus = () => {
      if (settled || requesting || finishing) return
      if (signal.aborted) { cancelled(); return }
      if (window.isDestroyed() || contents.isDestroyed()) { destroyed(); return }
      if (!window.isFocused()) return
      finishing = true
      try {
        // Page focus is permitted only after containing-window focus is observed.
        contents.focus()
        if (settled) return
        if (signal.aborted) cancelled()
        else if (window.isDestroyed() || contents.isDestroyed()) destroyed()
        else if (!window.isFocused()) fail('Native fixture input requires its own focused window; focus lost before final check.')
        else settle()
      } catch (error) { fail(`Native focus finalization failed: ${String(error)}`) }
    }
    if (signal.aborted) { cancelled(); return }
    if (window.isDestroyed() || contents.isDestroyed()) { destroyed(); return }
    window.on('focus', checkFocus); window.on('closed', closed); window.on('unresponsive', unresponsive)
    contents.on('destroyed', destroyed); contents.on('render-process-gone', rendererGone); contents.on('preload-error', preloadError)
    signal.addEventListener('abort', cancelled, { once: true })
    timer = setTimeout(() => fail('Native focus acquisition exceeded its 8 second deadline.'), 8_000)
    checkFocus()
    if (settled) return
    // One owned request, with listeners installed before synchronous or delayed acquisition.
    requesting = true
    try { window.show(); if (!settled) window.focus() }
    catch (error) { fail(`Native focus request failed: ${String(error)}`) }
    finally { requesting = false }
    checkFocus()
  })
}
export function enumerateGraphicsOutputs(directory: string): string[] {
  const files: string[] = []
  const visit = (prefix = '') => {
    for (const entry of readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name)
      if (entry.isDirectory()) visit(relative)
      else { assert.ok(entry.isFile(), 'Refusing non-file emitted artifact'); if (relative !== 'fixture-build.json') files.push(relative) }
    }
  }
  visit(); return files.sort()
}
export function assertGraphicsBuildPhase(build: { case?: unknown; scope?: unknown; mainDeadlineMs?: unknown; outerDeadlineSeconds?: unknown; outputs?: Record<string, { sha256: string; bytes: number }>; outputInventory?: readonly string[]; workerFiles?: readonly string[]; productionWorkerEntry?: unknown }, caseName: string, actualFiles: readonly string[]): void {
  assert.ok(caseName === 'recovery' || caseName === 'supported-runtime')
  assert.equal(build.case, caseName)
  assert.equal(build.scope, caseName === 'recovery' ? 'source-level-graphics-recovery' : 'small-scene-hardware-context-admission')
  assert.equal(build.mainDeadlineMs, 125000); assert.equal(build.outerDeadlineSeconds, 145)
  assert.match(build.outputs?.['main.cjs']?.sha256 ?? '', /^[a-f0-9]{64}$/)
  const emitted = build.outputs?.['main.cjs']; assert.ok(emitted)
  assert.ok(Number.isSafeInteger(emitted.bytes) && emitted.bytes > 0)
  const keys = Object.keys(build.outputs!).sort()
  assert.ok(Array.isArray(actualFiles) && Array.isArray(build.outputInventory))
  assert.equal(new Set(build.outputInventory).size, build.outputInventory.length, 'Duplicate output inventory')
  assert.deepEqual([...build.outputInventory].sort(), keys, 'Manifest inventory differs from hashed outputs')
  assert.deepEqual([...actualFiles].sort(), keys, 'Emitted files omitted or substituted in manifest')
  for (const key of keys) {
    assert.ok(/^(?:main\.cjs|preload\.cjs|renderer\/.+|vite-cache\/.+)$/.test(key) && !/[\\\0]/.test(key) && key.split('/').every(part => part && part !== '.' && part !== '..'), 'Unknown or escaping output entry')
    assert.match(build.outputs![key]?.sha256 ?? '', /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(build.outputs![key]?.bytes) && build.outputs![key]!.bytes > 0)
  }
  for (const required of ['main.cjs', 'preload.cjs', 'renderer/index.html']) assert.ok(keys.includes(required), `Missing required emitted entry: ${required}`)
  const workers = keys.filter(key => /^renderer\/assets\/worldPhysics\.worker-[\w-]+\.js$/.test(key))
  assert.equal(workers.length, 1); assert.deepEqual(build.workerFiles, workers)
  assert.equal(build.productionWorkerEntry, 'src/areas/worlds/runtime/worldPhysics.worker.ts')
  assert.ok(keys.some(key => /^renderer\/assets\/.+\.js$/.test(key) && !workers.includes(key)), 'Missing emitted renderer JavaScript')
}
const positive = __GRAPHICS_CASE__ === 'supported-runtime'

assertSandboxLaunch(process.argv, process.env)
for (const flag of SANDBOX_DISABLING_SWITCHES) assert.equal(app.commandLine.hasSwitch(flag), false, `Refusing active sandbox-disabling switch: ${flag}`)
const bundleDirectory = realpathSync(__dirname)
assert.equal(bundleDirectory, path.resolve(__dirname))
assert.equal(path.dirname(bundleDirectory), '/tmp')
assert.match(path.basename(bundleDirectory), /^modly-worlds-graphics-ui-/)
assert.equal(lstatSync(bundleDirectory).mode & 0o777, 0o700)
if (process.getuid) assert.equal(lstatSync(bundleDirectory).uid, process.getuid())
const build = JSON.parse(readFileSync(path.join(bundleDirectory, 'fixture-build.json'), 'utf8'))
assert.equal(build.schema, 'modly.worlds-graphics-ui-build.v1')
assert.equal(build.execution, 'NOT_RUN')
assert.equal(build.outputDirectory, bundleDirectory)
assertGraphicsBuildPhase(build, __GRAPHICS_CASE__, enumerateGraphicsOutputs(bundleDirectory))
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
app.setName(positive ? 'Worlds Supported Graphics Fixture' : 'Worlds Graphics Recovery Fixture')
app.setPath('userData', userData)
app.setPath('sessionData', sessionData)
app.setPath('crashDumps', crashDumps)
app.enableSandbox()
app.on('window-all-closed', () => {})

const checks: GraphicsCheck[] = (positive ? SUPPORTED_CHECK_NAMES : CHECK_NAMES).map((name) => ({ name, status: 'UNREACHED', reason: 'Not yet executed.' }))
const rendererErrors: string[] = []
const blockedRequests: string[] = []
const report: Record<string, unknown> = {
  schema: 'modly.worlds-graphics-ui-run.v1', scope: 'source-level-graphics-recovery', status: 'RUNNING',
  included: ['production-Play-controller', 'production-WorldViewportBoundary', 'production-WorldRuntimeViewport', 'real-Rapier-Worker', 'sandboxed-production-IPC-repository'],
  excluded: ['visual-Play', 'gameplay', 'sensor-validation', 'live-context-loss', 'editor-Canvas-retry', 'DOM-focus-recovery', 'audio-output', 'settled-audio-guarantee', 'full-Workbench', 'performance', 'packaged-application'],
  requiredEnvironment: 'Actual unsupported WebGL startup; a working viewport is not a recovery PASS.',
  startedAt: new Date().toISOString(), runDirectory, workspace, userData, sessionData, pid: process.pid,
  versions: process.versions, build, checks, rendererErrors, blockedRequests,
  launch: { argv: [...process.argv], sandboxDisablingSwitches: Object.fromEntries(SANDBOX_DISABLING_SWITCHES.map((flag) => [flag, app.commandLine.hasSwitch(flag)])) },
}
if (positive) Object.assign(report, { scope: build.scope, requiredEnvironment: 'Normal physical display with attributed hardware WebGL2; reject unsupported/software contexts without fallback.',
  excluded: ['full-Workbench', 'animation-clips', '250-entities-2M-triangles-50-active-1080p', 'frame-fluency', 'command-to-paint', '50-cycles', 'audio-output', 'packaged-application'] })
const reportPath = path.join(runDirectory, 'fixture-report.json')
const persist = async () => {
  const file = await open(reportPath, 'w', 0o600)
  try { await file.writeFile(`${JSON.stringify(report, null, 2)}\n`); await file.sync() } finally { await file.close() }
  const directory = await open(runDirectory, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
let fixtureWindow: BrowserWindow | null = null
const focusAdmissionOwner = new AbortController()
let assetServer: Server | null = null
const watchdog = setTimeout(() => {
  Object.assign(report, { status: 'FAIL', error: 'Graphics recovery fixture exceeded its 125 second deadline.', finishedAt: new Date().toISOString() })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  app.exit(1)
}, 125_000)
console.log(`worlds-graphics-fixture: evidence=${runDirectory}`)

function createPositiveMarkerGlb(): Buffer {
  const vertices = new Float32Array([-0.3,-0.45,-0.3, 0.3,-0.45,-0.3, 0.3,0.45,-0.3, -0.3,0.45,-0.3, -0.3,-0.45,0.3, 0.3,-0.45,0.3, 0.3,0.45,0.3, -0.3,0.45,0.3])
  const indices = new Uint16Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5])
  const binary = Buffer.concat([Buffer.from(vertices.buffer), Buffer.from(indices.buffer)])
  const document = { asset: { version: '2.0', generator: 'Modly positive graphics fixture' }, extensionsUsed: ['KHR_materials_unlit'], scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [1,0,0,1] }, extensions: { KHR_materials_unlit: {} } }],
    buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertices.byteLength }, { buffer: 0, byteOffset: vertices.byteLength, byteLength: indices.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.3,-0.45,-0.3], max: [0.3,0.45,0.3] }, { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }] }
  const json = Buffer.from(JSON.stringify(document).padEnd(Math.ceil(JSON.stringify(document).length / 4) * 4, ' '))
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67,0); header.writeUInt32LE(2,4); header.writeUInt32LE(28+json.length+binary.length,8); header.writeUInt32LE(json.length,12); header.writeUInt32LE(0x4e4f534a,16)
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length,0); binHeader.writeUInt32LE(0x004e4942,4)
  return Buffer.concat([header,json,binHeader,binary])
}

async function run(): Promise<void> {
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => PROJECT_KEY, createSceneKey: () => SCENE_KEY })
  const created = await repository.create({ name: 'Real physics fixture', initialSceneName: 'Physics course', projectId: 'project:physics-fixture', initialSceneId: 'scene:physics-fixture' })
  assert.ok(created.ok, JSON.stringify(created))
  let authored = created.value.snapshot
  for (const batch of createPhysicsFixtureBatches(authored, PROJECT_KEY)) {
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY, batch })
    assert.ok(applied.ok, JSON.stringify(applied))
    authored = applied.value.snapshot
  }
  let assetBase = '', assetUrl = ''
  if (positive) {
    const asset = createPositiveMarkerGlb(), assetPath = 'positive-marker.glb'
    await writeFile(path.join(workspace, assetPath), asset, { flag: 'wx', mode: 0o600 })
    const scene = authored.scenes[0]!, character = scene.entities.find((entity) => entity.tags.includes('physics-character'))!, camera = scene.entities.find((entity) => entity.components.some((component) => component.type === 'camera'))!
    assert.ok(character && camera)
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY, batch: { schema: 'modly.world-command-batch.v1', transactionId: 'tx:positive-graphics-asset', origin: 'ui', projectId: authored.project.projectId, baseRevision: authored.project.revision, commands: [
      { type: 'add-resource', resource: { id: 'resource:positive-marker', name: 'Positive Character marker', workspacePath: assetPath, type: 'model', format: 'glb' } },
      { type: 'add-component', sceneId: scene.sceneId, entityId: character.id, component: { id: 'component:positive-marker', type: 'renderable', enabled: true, resourceId: 'resource:positive-marker', visible: true, castShadow: false, receiveShadow: false, material: { baseColor: '#ff0000', metallic: 0, roughness: 1, opacity: 1 } } },
      { type: 'patch-entity', sceneId: scene.sceneId, entityId: camera.id, patch: { transform: { position: [0,2,9], rotation: [0,0,0], scale: [1,1,1] } } },
    ] } }); assert.ok(applied.ok, JSON.stringify(applied)); authored = applied.value.snapshot
    report.asset = { workspacePath: assetPath, bytes: asset.length, sha256: createHash('sha256').update(asset).digest('hex'), triangles: 12, entityId: character.id, animationBinding: null }
    assetServer = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/workspace/positive-marker.glb') { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': asset.length, 'Access-Control-Allow-Origin': 'null', 'Cache-Control': 'no-store' }); response.end(asset)
    })
    await new Promise<void>((resolve, reject) => { assetServer!.once('error', reject); assetServer!.listen(0, '127.0.0.1', resolve) })
    const address = assetServer.address(); assert.ok(address && typeof address !== 'string')
    assetBase = `http://127.0.0.1:${address.port}`; assetUrl = `${assetBase}/workspace/positive-marker.glb`; report.assetUrl = assetUrl
  }
  report.authoredSnapshot = authored
  await persist()
  await app.whenReady()
  const isolatedSession = session.fromPartition(`worlds-graphics-fixture-${path.basename(bundleDirectory)}-${path.basename(runDirectory)}`)
  const filePrefix = pathToFileURL(`${bundleDirectory}${path.sep}`).href
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(filePrefix) || details.url === 'about:blank' || (positive && details.url === assetUrl && details.method === 'GET')
    if (!allowed && blockedRequests.length < 32) blockedRequests.push(details.url.slice(0, 2048))
    callback({ cancel: !allowed })
  })
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolatedSession.setPermissionCheckHandler(() => false)
  const requestedWebPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false } as const
  report.requestedWebPreferences = requestedWebPreferences
  const window = new BrowserWindow({
    title: positive ? 'Worlds supported graphics fixture — isolated' : 'Worlds graphics recovery fixture — isolated', width: 1120, height: 940, show: true,
    webPreferences: { preload: path.join(bundleDirectory, 'preload.cjs'), session: isolatedSession, ...requestedWebPreferences, backgroundThrottling: false },
  })
  fixtureWindow = window
  registerWorldProjectsIpcHandlers(ipcMain, repository, {
    isTrustedSender: (value) => {
      const event = value as Electron.IpcMainInvokeEvent
      return !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    },
  })
  const indexPath = path.join(bundleDirectory, 'renderer', 'index.html')
  const hash = positive ? new URLSearchParams({ case: 'supported-runtime', assetBase }).toString() : ''
  const indexUrl = pathToFileURL(indexPath).href + (hash ? `#${hash}` : '')
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== indexUrl) event.preventDefault() })
  const rendererFailure = new Promise<never>((_resolve, reject) => {
    const rejectRenderer = (error: Error) => { focusAdmissionOwner.abort(error); reject(error) }
    window.webContents.on('render-process-gone', (_event, details) => rejectRenderer(new Error(`Fixture renderer exited: ${details.reason}`)))
    window.webContents.on('preload-error', (_event, _preloadPath, error) => rejectRenderer(error))
    window.on('unresponsive', () => rejectRenderer(new Error('Fixture window became unresponsive.')))
    window.on('closed', () => rejectRenderer(new Error('Fixture window closed before completion.')))
  })
  // Keep late window lifecycle rejections handled after the awaited race has settled.
  void rendererFailure.catch(() => undefined)
  window.webContents.on('console-message', (details) => { if (details.level === 'error' && rendererErrors.length < 64) rendererErrors.push(details.message.slice(0, 4096)) })
  await Promise.race([window.loadFile(indexPath, { hash }), rendererFailure])
  try { await Promise.race([admitGraphicsNativeFocus(window, focusAdmissionOwner.signal), rendererFailure]) }
  finally { focusAdmissionOwner.abort(new Error('Native focus admission race completed.')) }
  const recordCheck = async (entry: GraphicsCheck) => {
    const index = checks.findIndex((candidate) => candidate.name === entry.name)
    assert.ok(index >= 0)
    checks[index] = entry
    await persist()
  }
  const verifyRepository = async (expected: import('../../src/areas/worlds/core/worldSessions.ts').WorldEditorSession) => {
    assert.deepEqual(expected.snapshot, authored)
    const reader = new WorldProjectRepository({ getWorkspaceRoot: () => workspace })
    const reopened = await reader.open({ projectKey: PROJECT_KEY })
    assert.ok(reopened.ok && reopened.value.status === 'ready', JSON.stringify(reopened))
    assert.deepEqual(reopened.value.snapshot, authored, 'Play must never persist runtime transforms or change the revision.')
  }
  const gpu = positive ? { features: app.getGPUFeatureStatus(), devices: await app.getGPUInfo('complete') } : null
  report.gpu = gpu
  const capture = async (name: string, bounds: Electron.Rectangle) => {
    const image = await window.webContents.capturePage(bounds), png = image.toPNG()
    await writeFile(path.join(runDirectory, `${name}.png`), png, { flag: 'wx' })
    report[name] = { bounds, size: image.getSize(), bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') }
    return image.toBitmap()
  }
  const result = await Promise.race([positive ? runSupportedGraphicsInteractions(window.webContents, recordCheck, verifyRepository, gpu!, capture) : runGraphicsInteractions(window.webContents, recordCheck, verifyRepository), rendererFailure])
  const unexpectedRendererErrors = positive ? rendererErrors : rendererErrors.filter((message) => !/WebGL context|above error occurred|React will try to recreate/i.test(message) || /Uncaught|Unhandled promise rejection/i.test(message))
  Object.assign(report, { finalView: result, unexpectedRendererErrors,
    status: checks.every((entry) => entry.status === 'PASS') && unexpectedRendererErrors.length === 0 && blockedRequests.length === 0 ? 'PASS' : 'FAIL' })
  await writeFile(path.join(runDirectory, 'final.png'), (await window.webContents.capturePage()).toPNG())
}

void run().catch(async (error: unknown) => {
  Object.assign(report, { status: positive && /CONTEXT_UNSUPPORTED/.test(String(error)) ? 'CONTEXT_UNSUPPORTED' : 'FAIL', error: error instanceof Error ? error.stack ?? error.message : String(error) })
  if (fixtureWindow && !fixtureWindow.isDestroyed()) {
    try { report.failureView = await readGraphicsView(fixtureWindow.webContents) } catch { /* Preserve the first failure. */ }
    try { await writeFile(path.join(runDirectory, 'failure.png'), (await fixtureWindow.webContents.capturePage()).toPNG()) } catch { /* Preserve the first failure. */ }
  }
}).finally(async () => {
  focusAdmissionOwner.abort(new Error('Graphics fixture owner completed.'))
  report.finishedAt = new Date().toISOString()
  let durable = false
  try { await persist(); durable = true; console.log(`worlds-graphics-fixture: ${report.status}; report=${reportPath}`) }
  finally { clearTimeout(watchdog); assetServer?.close(); if (fixtureWindow && !fixtureWindow.isDestroyed()) fixtureWindow.destroy(); app.exit(durable && report.status === 'PASS' ? 0 : 1) }
})
