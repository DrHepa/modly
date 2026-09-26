import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const source = (name) => readFile(new URL(`./worlds-ai-electron-fixture/${name}`, import.meta.url), 'utf8')
const repositoryPythonFor = (moduleUrl) => fileURLToPath(new URL('../api/.venv/bin/python', moduleUrl))
const repositoryPython = repositoryPythonFor(import.meta.url)

test('AI fixture Python admission is source-relative and independent of PATH, PYTHON and cwd', async () => {
  const relocatedRoot = '/tmp/relocated-modly'
  const relocatedModule = pathToFileURL(path.join(relocatedRoot, 'scripts/worlds-ai-electron-fixture.test.mjs')).href
  assert.equal(repositoryPythonFor(relocatedModule), path.join(relocatedRoot, 'api/.venv/bin/python'))
  const originalCwd = process.cwd(), originalPath = process.env.PATH, originalPython = process.env.PYTHON
  const unrelatedCwd = await mkdtemp('/tmp/modly-worlds-ai-path-control-')
  try {
    process.chdir(unrelatedCwd); process.env.PATH = '/tmp/attacker-path'; process.env.PYTHON = '/tmp/attacker-python'
    assert.equal(repositoryPythonFor(import.meta.url), repositoryPython)
  } finally {
    process.chdir(originalCwd)
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath
    if (originalPython === undefined) delete process.env.PYTHON; else process.env.PYTHON = originalPython
  }
})

test('AI fixture has an explicit build-only entry and never starts an application while building', async () => {
  const { parseBuildArguments } = await import('./worlds-ai-electron-fixture.mjs')
  assert.deepEqual(parseBuildArguments(['--build-only']), { buildOnly: true })
  for (const args of [[], ['--run'], ['--build-only', '--run'], ['--out-dir', '/tmp/existing']]) assert.throws(() => parseBuildArguments(args), /build-only/)
})

test('AI fixture rejects ambient injection, unsafe displays and non-owned network origins', async () => {
  const { assertFixtureLaunch, requireEphemeralOrigin, childEnvironment, isFixtureSender } = await import('./worlds-ai-electron-fixture/shared.ts')
  const { prepareNativeState } = await import('./worlds-ai-electron-fixture.mjs')
  const launch = await prepareNativeState(await mkdtemp('/tmp/modly-worlds-ai-ui-guard-contract-'))
  const argv = launch.argv; const environment = { ...launch.environment, DISPLAY: ':99' }
  assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, 'disabled:')
  assert.doesNotThrow(() => assertFixtureLaunch(argv, environment, launch))
  for (const DBUS_SESSION_BUS_ADDRESS of ['', 'autolaunch:', '/run/user/1000/bus', 'unix:path=/run/user/1000/bus', 'unix:abstract=/tmp/dbus-test']) {
    const forgedLaunch = { ...launch, environment: { ...launch.environment, DBUS_SESSION_BUS_ADDRESS } }
    assert.throws(() => assertFixtureLaunch(argv, { ...environment, DBUS_SESSION_BUS_ADDRESS }, forgedLaunch), /DBUS_SESSION_BUS_ADDRESS/)
  }
  for (const DISPLAY of ['', ':1', ':1.0', 'localhost:99', ':0']) assert.throws(() => assertFixtureLaunch(argv, { ...environment, DISPLAY }, launch))
  for (const flag of ['--no-sandbox', '--no-zygote', '--disable-gpu-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--allow-file-access-from-files']) assert.throws(() => assertFixtureLaunch([...argv, flag], environment, launch))
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SANDBOX', 'SESSION_MANAGER']) assert.throws(() => assertFixtureLaunch(argv, { ...environment, [key]: '1' }, launch))
  assert.equal(requireEphemeralOrigin('http://127.0.0.1:32189'), 'http://127.0.0.1:32189')
  for (const origin of ['http://127.0.0.1:8765', 'http://127.0.0.1:8766', 'http://127.0.0.1:11434', 'http://localhost:32189', 'https://127.0.0.1:32189', 'http://user@127.0.0.1:32189', 'http://127.0.0.1:32189/path', 'http://example.com:32189']) assert.throws(() => requireEphemeralOrigin(origin))
  const env = childEnvironment('/tmp/private-run')
  assert.equal(env.HOME, '/tmp/private-run')
  assert.equal(Object.keys(env).some((key) => /proxy|pythonpath|node|display/i.test(key)), false)
  const mainFrame = {}; const contents = { mainFrame }; const window = { isDestroyed: () => false, webContents: contents }
  assert.equal(isFixtureSender({ sender: contents, senderFrame: mainFrame }, window), true)
  assert.equal(isFixtureSender({ sender: {}, senderFrame: mainFrame }, window), false)
  assert.equal(isFixtureSender({ sender: contents, senderFrame: {} }, window), false)
  assert.equal(isFixtureSender({ sender: contents, senderFrame: mainFrame }, { ...window, isDestroyed: () => true }), false)
})

test('fixture lifecycle cannot reopen after cleanup and delayed setup is fenced before new effects', async () => {
  const { createRunFence } = await import('./worlds-ai-electron-fixture/shared.ts')
  const fence = createRunFence(); assert.doesNotThrow(() => fence.assertOpen()); fence.close()
  assert.throws(() => fence.assertOpen()); fence.close(); assert.throws(() => fence.assertOpen())
  const main = await source('main.ts')
  assert.match(main, /finally\(async \(\) => \{\s*fence\.close\(\)/)
  assert.match(main, /await bridge\.start\(\)\s*fence\.assertOpen\(\)/)
  assert.match(main, /await startBackend\(bridgeOrigin\)\s*fence\.assertOpen\(\)/)
})

test('raw durable inspection verifies a real private repository and rejects tampered hashes or pending recovery', async () => {
  const { WorldProjectRepository } = await import('../electron/main/world-project-repository.ts')
  const { inspectWorld, fingerprintTree } = await import('./worlds-ai-electron-fixture/inspection.ts')
  const workspace = await mkdtemp('/tmp/modly-worlds-ai-raw-world-')
  const projectKey = 'world-' + 'c'.repeat(32)
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => projectKey })
  const created = await repository.create({ name: 'Raw inspection test', initialSceneName: 'Scene' })
  assert.equal(created.ok, true)
  const before = await fingerprintTree(workspace)
  assert.deepEqual((await inspectWorld(workspace, projectKey)).snapshot, created.value.snapshot)
  assert.deepEqual(await fingerprintTree(workspace), before)
  const statePath = path.join(workspace, 'Worlds', projectKey, '.modly/state.v1.json')
  const original = await readFile(statePath); const state = JSON.parse(original)
  state.project.sha256 = '0'.repeat(64)
  await writeFile(statePath, JSON.stringify(state)); await assert.rejects(inspectWorld(workspace, projectKey))
  await writeFile(statePath, original)
  await writeFile(path.join(workspace, 'Worlds', projectKey, '.modly/journal.v1.json'), '{}')
  await assert.rejects(inspectWorld(workspace, projectKey), /Pending recovery/)
})

test('AI fixture uses production components, sessions, IPC and native input with observation-only page evaluation', async () => {
  const renderer = await source('renderer.tsx'); const driver = await source('driver.ts'); const main = await source('main.ts'); const preload = await source('preload.ts')
  for (const name of ['WorldsAiDrawer', 'createWorldAiChatAdapter', 'createWorldEditorController', 'createWorldProjectService', 'useAgentSessionsStore']) assert.match(renderer, new RegExp(name))
  assert.doesNotMatch(renderer, /fetch\s*=|requestWorldAiChat\s*=|createWorldPlayController|WorldsWorkbench\s*\//)
  for (const name of ['registerWorldProjectsIpcHandlers', 'WorldProjectRepository', 'AgentSessionStore', 'AutomationHttpBridge', 'port: 0', 'getOrigin()', 'isFixtureSender']) assert.ok(main.includes(name), name)
  assert.match(preload, /api\.agentSessions/)
  assert.match(preload, /api\.workspace\.worlds\.projects/)
  assert.doesNotMatch(preload, /exposeInMainWorld\(['"]electron['"],\s*api\)/)
  assert.match(driver, /sendInputEvent\(/); assert.match(driver, /insertText\(/); assert.match(driver, /contents\.reload\(\)/)
  assert.doesNotMatch(driver, /dispatchEvent\(|\.click\(|\.focus\(|\.value\s*=(?!=)|__react|\.apply\(|\.reject\(|\.undo\(/)
  assert.equal((driver.match(/executeJavaScript\(/g) ?? []).length, 2)
  for (const forbidden of ['new PythonBridge', 'setupIpcHandlers(', 'requestSingleInstanceLock(', 'appendSwitch(', 'kill(-']) assert.equal(main.includes(forbidden), false, forbidden)
})

test('native AI fixture follows the direct-edit single-pane UX instead of the removed review and CLI UI', async () => {
  const renderer = await source('renderer.tsx'); const driver = await source('driver.ts'); const backend = await source('backend.py')
  assert.match(renderer, /autoApply:\s*true/)
  assert.match(driver, /assertSinglePane\(/)
  assert.match(driver, /agent-model-picker/)
  assert.match(driver, /Undo AI change/)
  const controls = driver.slice(driver.indexOf('const SELECTORS ='), driver.indexOf('type Control ='))
  assert.doesNotMatch(controls, /Apply Worlds proposal|Reject Worlds proposal|worlds-ai-drawer__review/)
  assert.doesNotMatch(driver, /preview-\$\{number\}/)
  assert.doesNotMatch(backend, /Review the proposed name change|Nothing has been applied/)
})

test('responsive receipt preserves the tooltip checkpoint instead of reporting the later model-menu state', async () => {
  const { responsiveEvidence } = await import('./worlds-ai-electron-fixture/driver.ts')
  const tooltipView = { ui: { tooltips: [{ left: 8, right: 120, top: 20, bottom: 60 }] } }
  const modelView = { ui: { viewport: { width: 512, height: 370, scrollWidth: 504, scrollHeight: 611 },
    modelPickerBounds: { left: 91, right: 313, top: 176, bottom: 326 }, tooltips: [] } }
  assert.deepEqual(responsiveEvidence('zoom-200', tooltipView, modelView), { mode: 'zoom-200',
    viewport: modelView.ui.viewport, picker: modelView.ui.modelPickerBounds, tooltips: tooltipView.ui.tooltips })
})

test('fixture DOM reads are observation-only; keyboard focus, not injected scroll or focus, moves controls into view', async () => {
  const driver = await source('driver.ts')
  assert.doesNotMatch(driver, /scrollIntoView\s*\(/)
  assert.doesNotMatch(driver, /generic ChatPanel icon-only Send button has no accessible name/)
  assert.match(driver, /sendInputEvent\(/)
})

test('browser diagnostics sanitize request and response metadata without retaining secrets', async () => {
  const { safeFixtureRequest, safeResponseCorsHeaders } = await import('./worlds-ai-electron-fixture/httpDiagnostics.ts')
  const apiOrigin = 'http://127.0.0.1:45678'
  assert.deepEqual(safeFixtureRequest(`${apiOrigin}/agent/chat`, 'POST', apiOrigin), { path: '/agent/chat', method: 'POST' })
  assert.deepEqual(safeFixtureRequest(`${apiOrigin}/agent/chat`, 'OPTIONS', apiOrigin, 'CORS request rejected'), {
    path: '/agent/chat', method: 'OPTIONS', error: 'cors_or_network',
  })
  assert.deepEqual(safeFixtureRequest(`${apiOrigin}/agent/chat?token=supersecret`, 'BREW-supersecret', apiOrigin, 'supersecret network detail'), {
    path: '<redacted>', method: '<redacted>', error: 'network',
  })
  assert.deepEqual(safeFixtureRequest('http://user:supersecret@127.0.0.1:45678/agent/chat#frag', 'POST', apiOrigin), {
    path: '<redacted>', method: 'POST',
  })
  assert.deepEqual(safeFixtureRequest('file:///home/user/supersecret.html', 'GET', apiOrigin), { path: '<redacted>', method: 'GET' })

  const safe = safeResponseCorsHeaders({
    'access-control-allow-origin': ['null'],
    'access-control-allow-methods': ['GET, POST, OPTIONS'],
    'access-control-allow-headers': ['Accept, Accept-Language, Content-Language, Content-Type'],
    'access-control-max-age': ['600'],
  })
  assert.deepEqual(safe, {
    'access-control-allow-origin': { kind: 'null' },
    'access-control-allow-methods': ['GET', 'POST', 'OPTIONS'],
    'access-control-allow-headers': ['accept', 'accept-language', 'content-language', 'content-type'],
    'access-control-max-age': '600',
  })
  assert.deepEqual(safeResponseCorsHeaders({ 'access-control-allow-origin': ['file://'] })['access-control-allow-origin'], { kind: 'file', value: 'file://' })
  assert.deepEqual(safeResponseCorsHeaders({ 'access-control-allow-origin': ['http://127.0.0.1:45678'] })['access-control-allow-origin'],
    { kind: 'loopback', value: 'http://127.0.0.1:45678' })
  assert.deepEqual(safeResponseCorsHeaders({ 'access-control-allow-origin': ['*'] })['access-control-allow-origin'], { kind: 'wildcard' })

  const hostile = safeResponseCorsHeaders({
    'access-control-allow-origin': ['http://user:supersecret@127.0.0.1:45678/path?token=supersecret#frag'],
    'access-control-allow-methods': ['POST, BREW-supersecret'],
    'access-control-allow-headers': ['Content-Type, Authorization, X-Token, X-Trace'],
    'access-control-max-age': ['forever-supersecret'],
  })
  assert.equal(hostile['access-control-allow-origin'].kind, 'redacted')
  assert.deepEqual(hostile['access-control-allow-methods'], ['POST', '<redacted>'])
  assert.deepEqual(hostile['access-control-allow-headers'], ['content-type', '<redacted>', '<redacted>', '<redacted>'])
  assert.equal(hostile['access-control-max-age'], '<redacted>')
  assert.doesNotMatch(JSON.stringify({
    hostile,
    request: safeFixtureRequest(`${apiOrigin}/agent/chat?token=supersecret`, 'BREW-supersecret', apiOrigin, 'supersecret'),
    userinfo: safeFixtureRequest('http://user:supersecret@127.0.0.1:45678/agent/chat#frag', 'POST', apiOrigin),
  }), new RegExp('supersecret|Authorization|X-Token|BREW|/home/user|/agent/chat\\\\?token|user:', 'i'))
})

test('AI backend keeps the actual router and parser while only the provider is an explicit bounded NDJSON stub', async () => {
  const backend = await source('backend.py')
  assert.match(backend, /from routers import agent/)
  assert.match(backend, /app\.include_router\(agent\.router\)/)
  assert.match(backend, /agent\.AUTOMATION_BRIDGE = bridge_origin/)
  assert.match(backend, /StreamingResponse/)
  assert.match(backend, /sys\.addaudithook/)
  assert.match(backend, /socket\.connect/)
  assert.match(backend, /payload\["ollama_url"\] != api_origin/)
  assert.match(backend, /STUB/)
  assert.doesNotMatch(backend, /MockTransport|ASGITransport|monkeypatch|agent\.agent_chat\s*=|agent\._stream_ollama_round\s*=|from main import/)
})

test('fixture backend diagnostics cover accepted rejected and preflight ASGI requests without sensitive input', async () => {
  const root = await mkdtemp('/tmp/modly-worlds-ai-backend-diagnostics-')
  await mkdir(path.join(root, 'routers'), { recursive: true, mode: 0o700 })
  await writeFile(path.join(root, 'routers', '__init__.py'), '', { mode: 0o600 })
  await writeFile(path.join(root, 'routers', 'agent.py'), 'from fastapi import APIRouter\nrouter = APIRouter()\nAUTOMATION_BRIDGE = None\n', { mode: 0o600 })
  const driver = path.join(root, 'drive_backend.py')
  await writeFile(driver, `
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(${JSON.stringify(path.resolve('scripts/worlds-ai-electron-fixture'))})))
sys.path.insert(1, str(Path(${JSON.stringify(root)})))
from backend import create_fixture_app

events = []
def emit(kind, **data):
    events.append({"kind": kind, **data})

app = create_fixture_app({"bridgeOrigin": "http://127.0.0.1:54321", "projectKey": "world-" + "c" * 32}, "http://127.0.0.1:45678", emit)

async def request(method, path, headers=None, body=b"", client=("127.0.0.1", 49152), query=b""):
    sent = []
    headers = headers or []
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
             "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": query,
             "headers": [(name.lower().encode(), value.encode()) for name, value in headers],
             "client": client, "server": ("127.0.0.1", 45678)}
    received = False
    async def receive():
        nonlocal received
        if received:
            return {"type": "http.disconnect"}
        received = True
        return {"type": "http.request", "body": body, "more_body": False}
    async def send(message):
        sent.append(message)
    await app(scope, receive, send)
    return next(message["status"] for message in sent if message["type"] == "http.response.start")

async def main():
    payload = json.dumps({"model": "worlds-fixture-stub", "stream": True,
                          "tools": [{"function": {"name": "query_world"}}, {"function": {"name": "propose_world_commands"}}],
                          "messages": []}).encode()
    await request("POST", "/api/chat", [("Origin", "null"), ("Content-Length", str(len(payload))), ("Content-Type", "application/json")], payload)
    await request("OPTIONS", "/agent/chat", [("Origin", "null"), ("Access-Control-Request-Method", "POST"),
                                             ("Access-Control-Request-Headers", "Content-Type, Authorization, X-Secret")])
    await request("GET", "/api/chat")
    await request("GET", "/api/chat", [("Origin", "file://")])
    await request("GET", "/api/chat", [("Origin", "http://127.0.0.1:54321")])
    await request("GET", "/api/chat", [("Origin", "file:///home/user/supersecret-world")])
    await request("OPTIONS", "/agent/chat", [("Origin", "null"), ("Access-Control-Request-Method", "BREW-supersecret")])
    await request("GET", "/secret", [("Origin", "http://evil.example/" + "x" * 200),
                                     ("Access-Control-Request-Headers", "X-Token, Bad Header")], b"", query=b"token=supersecret")
    await request("GET", "/secret", [("Origin", "http://user:supersecret@127.0.0.1:54321/path?token=supersecret#frag")])
    await request("GET", "/api/chat", [("Origin", "http://127.0.0.1:supersecret")])
    await request("GET", "/api/chat", [("Origin", "http://127.0.0.1:999999")])
    await request("GET", "/api/chat", [("Origin", "http://[::1")])
    await request("POST", "/agent/chat", [("Origin", "null"), ("Content-Length", "2"), ("Authorization", "Bearer secret")], b"{}")
    print(json.dumps(events, separators=(",", ":")))

asyncio.run(main())
`, { mode: 0o600 })
  const child = spawn(repositoryPython, ['-I', '-B', driver], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const exit = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))
  clearTimeout(timer)
  assert.deepEqual(exit, { code: 0, signal: null }, stderr)
  const events = JSON.parse(stdout)
  assert.equal(events.some((event) => event.kind === 'http-complete' && event.path === '/api/chat' && event.status === 200), true)
  assert.equal(events.some((event) => event.kind === 'http-complete' && event.method === 'OPTIONS' && event.path === '/agent/chat'), true)
  assert.equal(events.some((event) => event.kind === 'http-attempt' && event.origin?.kind === 'null'), true)
  assert.equal(events.some((event) => event.kind === 'http-attempt' && event.origin?.kind === 'absent'), true)
  assert.equal(events.some((event) => event.kind === 'http-attempt' && event.origin?.kind === 'file' && event.origin?.value === 'file://'), true)
  assert.equal(events.some((event) => event.kind === 'http-attempt' && event.origin?.kind === 'loopback' && event.origin?.value === 'http://127.0.0.1:54321'), true)
  assert.equal(events.some((event) => event.kind === 'http-attempt' && event.accessControlRequestMethod === '<redacted>'), true)
  assert.equal(events.some((event) => event.kind === 'http-reject' && event.rejection === 'route_unavailable' && event.path === '<redacted>'), true)
  assert.equal(events.some((event) => event.kind === 'http-reject' && event.rejection === 'origin_rejected'), true)
  assert.ok(events.filter((event) => event.kind === 'http-reject' && event.rejection === 'origin_rejected' && event.origin?.kind === 'redacted' && event.status === 403).length >= 4)
  assert.equal(events.some((event) => event.kind === 'http-reject' && event.rejection === 'payload_rejected'), true)
  const serialized = JSON.stringify(events)
  assert.doesNotMatch(serialized, new RegExp('supersecret|Bearer secret|Authorization|evil\\\\.example/x|/secret\\\\?token|prompt|/home/user|BREW|999999', 'i'))
  assert.equal(serialized.includes('[::1'), false)
  assert.match(serialized, /accessControlRequestHeaders/)
})

test('fixture backend serve lifecycle emits finished counts from isolated app instances', async () => {
  const root = await mkdtemp('/tmp/modly-worlds-ai-backend-serve-lifecycle-')
  await mkdir(path.join(root, 'routers'), { recursive: true, mode: 0o700 })
  await writeFile(path.join(root, 'routers', '__init__.py'), '', { mode: 0o600 })
  await writeFile(path.join(root, 'routers', 'agent.py'), 'from fastapi import APIRouter\nrouter = APIRouter()\nAUTOMATION_BRIDGE = None\n', { mode: 0o600 })
  const driver = path.join(root, 'drive_backend_serve.py')
  await writeFile(driver, `
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(${JSON.stringify(path.resolve('scripts/worlds-ai-electron-fixture'))})))
sys.path.insert(1, str(Path(${JSON.stringify(root)})))
import backend

events = []
app_ids = []

def emit(kind, **data):
    events.append({"kind": kind, **data})

class FakeListener:
    def __init__(self):
        self.closed = False
    def bind(self, address):
        self.bound = address
    def listen(self, backlog):
        self.backlog = backlog
    def getsockname(self):
        return ("127.0.0.1", 49152)
    def close(self):
        self.closed = True

class FakeSocketModule:
    AF_INET = object()
    SOCK_STREAM = object()
    def socket(self, family, kind):
        return FakeListener()

class FakeConfig:
    def __init__(self, app, **kwargs):
        self.app = app
        self.kwargs = kwargs

class FakeServer:
    created = []
    def __init__(self, config):
        self.config = config
        self.should_exit = False
        self._started = False
        self._release = None
        self._release_scheduled = False
        self.sequence = len(FakeServer.created) + 1
        FakeServer.created.append(self)
        app_ids.append(id(config.app))
    @property
    def started(self):
        if self._started and self._release is not None and not self._release_scheduled:
            self._release_scheduled = True
            asyncio.get_running_loop().call_soon(self._release.set)
        return self._started
    async def serve(self, sockets):
        self._release = asyncio.Event()
        counts = getattr(self.config.app.state, "fixture_counts", None)
        if counts is not None:
            counts["agent"] += self.sequence
            counts["provider"] += self.sequence * 2
        self._started = True
        await self._release.wait()

backend.socket = FakeSocketModule()
backend.uvicorn.Config = FakeConfig
backend.uvicorn.Server = FakeServer
backend.emit = emit

async def main():
    config = {"bridgeOrigin": "http://127.0.0.1:54321", "projectKey": "world-" + "d" * 32, "runId": "run-lifecycle"}
    await backend.serve(config)
    await backend.serve({**config, "runId": "run-lifecycle-2"})
    print(json.dumps({"events": events, "appIds": app_ids}, separators=(",", ":")))

asyncio.run(main())
`, { mode: 0o600 })
  const child = spawn(repositoryPython, ['-I', '-B', driver], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const exit = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))
  clearTimeout(timer)
  assert.deepEqual(exit, { code: 0, signal: null }, stderr)
  const result = JSON.parse(stdout)
  assert.equal(new Set(result.appIds).size, 2)
  const finished = result.events.filter((event) => event.kind === 'finished')
  assert.deepEqual(finished.map((event) => event.counts), [{ agent: 1, provider: 2 }, { agent: 2, provider: 4 }])
  assert.equal(result.events.filter((event) => event.kind === 'ready').length, 2)
})

test('read-only durable inspection rejects unexplained writes, hash mismatches and journal state without recovering open', async () => {
  const { fingerprintTree, inspectWorld } = await import('./worlds-ai-electron-fixture/inspection.ts')
  const root = await mkdtemp('/tmp/modly-worlds-ai-inspection-')
  await writeFile(path.join(root, 'one'), 'unchanged')
  const first = await fingerprintTree(root)
  assert.deepEqual(await fingerprintTree(root), first)
  await writeFile(path.join(root, 'one'), 'modified')
  assert.notDeepEqual(await fingerprintTree(root), first)
  await assert.rejects(inspectWorld(root, 'world-' + 'a'.repeat(32)))
  const inspection = await source('inspection.ts')
  assert.doesNotMatch(inspection, /\.open\(|new WorldProjectRepository|writeFile|mkdir\(|rename\(/)
  assert.match(inspection, /state\.v1\.json/); assert.match(inspection, /journal\.v1\.json/)
  assert.match(inspection, /validateWorldProjectSnapshot/)
})

test('native delta assertions reject revision-only progress and any unrelated canonical change', async () => {
  const { assertNameDelta } = await import('./worlds-ai-electron-fixture/driver.ts')
  const { createValidWorldSnapshot } = await import('../src/areas/worlds/core/_testFixtures.ts')
  const before = createValidWorldSnapshot(); const targetId = before.scenes[0].entities[0].id
  const after = structuredClone(before); after.project.revision += 1; after.scenes[0].entities[0].name = 'Reviewed target'
  assert.doesNotThrow(() => assertNameDelta(after, before, targetId, 'Reviewed target'))
  const noOp = structuredClone(before); noOp.project.revision += 1
  assert.throws(() => assertNameDelta(noOp, before, targetId, 'Reviewed target'))
  after.project.name = 'Unexpected'; assert.throws(() => assertNameDelta(after, before, targetId, 'Reviewed target'))
})

test('build artifact includes the actual UI/HTTP/backend source graph and remains NOT_RUN', async () => {
  const { buildWorldsAiFixture } = await import('./worlds-ai-electron-fixture.mjs')
  const build = await buildWorldsAiFixture()
  console.log(`AI fixture build evidence: ${build.outputDirectory}`)
  assert.equal(build.execution, 'NOT_RUN'); assert.equal(build.provider, 'DETERMINISTIC_NDJSON_STUB')
  assert.equal(path.dirname(build.outputDirectory), '/tmp')
  assert.match(path.basename(build.outputDirectory), /^modly-worlds-ai-ui-/)
  assert.match(build.nextCommand, /xvfb-run -a/); assert.doesNotMatch(build.nextCommand, /DISPLAY=:1|--no-sandbox|--disable-web-security/)
  assert.deepEqual(build.buildWarnings, [])
  assert.equal(build.launch.environment.DBUS_SESSION_BUS_ADDRESS, 'disabled:')
  assert.ok(build.nextCommand.includes('env -i HOME=')); assert.ok(build.nextCommand.includes('DBUS_SESSION_BUS_ADDRESS=\"disabled:\"'))
  assert.ok(build.nextCommand.includes(`--user-data-dir=${build.launch.paths.userData}`))
  assert.ok(build.nextCommand.includes(build.launch.argv[1])); assert.equal(build.launch.preparedDirectories.length, 9)
  const { lstat, realpath } = await import('node:fs/promises')
  for (const item of build.launch.preparedDirectories) { const info = await lstat(item.path); assert.ok(info.isDirectory()); assert.equal(info.mode & 0o777, 0o700); assert.equal(await realpath(item.path), item.path) }
  assert.equal((await readdir(build.outputDirectory)).some((name) => name.startsWith('run-')), false)
  for (const name of ['bootstrap.cjs', 'main.cjs', 'preload.cjs', 'backend/backend.py', 'backend/routers/agent.py', 'backend/routers/world_ai.py', 'backend/services/agent_providers/openai.py', 'renderer/index.html']) assert.ok(build.outputs[name]?.bytes > 0, name)
  for (const suffix of ['WorldsAiDrawer.tsx', 'ChatPanel.tsx', 'worldAiChatAdapter.ts', 'worldEditorController.ts', 'world-project-repository.ts', 'world-projects-ipc.ts', 'agent-session-store.ts']) assert.ok(build.sourceInputs.some((entry) => entry.path.endsWith(suffix)), suffix)
  for (const [name, value] of Object.entries(build.outputs)) assert.equal(createHash('sha256').update(await readFile(path.join(build.outputDirectory, name))).digest('hex'), value.sha256, name)
  const html = await readFile(path.join(build.outputDirectory, 'renderer/index.html'), 'utf8')
  assert.match(html, /connect-src __FIXTURE_API_ORIGIN__/)
  assert.doesNotMatch(html, /unsafe-eval|https?:\/\//)
})

// Execute only verbatim directory setup and terminal code in a VM: no Electron,
// backend, sockets or subprocesses. Native acceptance remains a separate gate.
async function terminalHarness({ duringSave, duringCleanup, withChild = false } = {}) {
  const vm = await import('node:vm'); const ts = await import('typescript')
  const { createRunFence } = await import('./worlds-ai-electron-fixture/shared.ts')
  const { EventEmitter } = await import('node:events')
  const main = await source('main.ts')
  const childListeners = main.slice(main.indexOf('  let buffer ='), main.indexOf("  const timer = setTimeout(() => fail(new Error('Fixture backend startup"))
  const setup = main.slice(main.indexOf('const reportPath ='), main.indexOf('\nasync function startBackend'))
  const terminal = main.slice(main.indexOf('  const result = await runAiInteractions'), main.indexOf('\n}\n\nvoid Promise.race'))
  const finalizer = main.slice(main.indexOf('void Promise.race'), main.indexOf('\nstartup.takeOwnership(fail)')).replace('void Promise.race', 'globalThis.completion = Promise.race')
  assert.ok(setup && terminal && finalizer)
  let releaseScreenshot
  const screenshot = new Promise((resolve) => { releaseScreenshot = resolve })
  const report = { status: 'RUNNING' }; const saves = []; let exitCode; let context
  const ownedChild = new EventEmitter(); const kills = []
  ownedChild.exitCode = null; ownedChild.signalCode = null
  ownedChild.stdout = new EventEmitter(); ownedChild.stderr = new EventEmitter()
  ownedChild.kill = (signal) => { kills.push(signal); return true }
  const save = (_filename, bytes) => {
    const value = JSON.parse(bytes); saves.push(value.status)
    duringSave?.(value, () => vm.runInContext('fail(new Error("persistence callback failure"))', context))
  }
  context = vm.createContext({ assert, path, report, createRunFence, ownedChild, console: { log() {} }, setTimeout, clearTimeout, Buffer,
    runDirectory: '/tmp/no-effects', writeFileSync: save,
    writeFile: async (filename, bytes) => { if (filename.endsWith('fixture-report.json')) save(filename, bytes) },
    queries: [{}, {}, {}], rendererErrors: [], blockedRequests: [], screenshots: {}, checkpoint: async () => {},
    backendEvents: [...Array.from({ length: 3 }, () => ({ kind: 'stub-proposal', queriedEntityId: 'target' })),
      ...Array.from({ length: 3 }, () => ({ kind: 'agent-request' })), ...Array.from({ length: 9 }, () => ({ kind: 'stub-round' }))],
    fixtureWindow: { webContents: { capturePage: async () => { await screenshot; return { toPNG: () => Buffer.from('PNG') } } } },
    runAiInteractions: async (_contents, _checkpoint, capture) => { await capture('reopened'); return { targetId: 'target' } },
    runResponsiveChecks: async () => [],
    digest: () => ({ bytes: 3, sha256: 'test' }), app: { exit(code) { exitCode = code } },
    duringCleanup: async () => duringCleanup?.(() => vm.runInContext('fail(new Error("cleanup callback failure"))', context)),
  })
  vm.runInContext(ts.transpile(`${setup}\n${withChild ? `child = ownedChild;\n${childListeners}` : ''}\nasync function run() {${terminal}\n}\n${finalizer}\nbridge = { stop: duringCleanup };`, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  }), context)
  return { report, saves, releaseScreenshot, fail: () => vm.runInContext('fail(new Error("deadline failure"))', context),
    exitCode: () => exitCode, completion: context.completion, ownedChild, kills }
}

test('private session root exists before the closed Drawer checkpoint and real store hydration', async () => {
  const { prepareNativeState } = await import('./worlds-ai-electron-fixture.mjs')
  const { AgentSessionStore } = await import('../electron/main/agent-session-store.ts')
  const { fingerprintTree } = await import('./worlds-ai-electron-fixture/inspection.ts')
  const launch = await prepareNativeState(await mkdtemp('/tmp/modly-worlds-ai-ui-root-contract-'))
  const rootDir = launch.paths.agentSessions
  const store = new AgentSessionStore({ rootDir })
  assert.deepEqual(await fingerprintTree(rootDir), {}, 'The first checkpoint must work without mounting ChatPanel or fabricating a session.')
  const listed = await store.list()
  assert.equal(listed.readOnly, false); assert.equal(listed.sessions.length, 1)
  assert.deepEqual((await store.read({ sessionId: listed.activeSessionId })).messages, [])
  assert.ok(Object.keys(await fingerprintTree(rootDir)).length > 0)
})

test('terminal failure is synchronous and cannot be overwritten by a late final screenshot', async () => {
  const h = await terminalHarness()
  try {
    h.fail()
    assert.equal(h.report.status, 'FAIL', 'Latch failure before any await or Promise reaction.')
  } finally { h.releaseScreenshot(); await h.completion }
  assert.equal(h.report.status, 'FAIL'); assert.equal(h.exitCode(), 1)
  assert.equal(h.saves.includes('PASS'), false)
})

test('terminal failure during success cleanup cannot become a passing exit', async () => {
  const h = await terminalHarness({ duringCleanup: async (fail) => { await Promise.resolve(); fail() } })
  h.releaseScreenshot(); await h.completion
  assert.equal(h.report.status, 'FAIL'); assert.equal(h.exitCode(), 1); assert.equal(h.saves.at(-1), 'FAIL')
})

test('terminal failure during success persistence is rewritten as FAIL before exit', async () => {
  const h = await terminalHarness({ duringSave: (value, fail) => { if (value.status === 'PASS') fail() } })
  h.releaseScreenshot(); await h.completion
  assert.equal(h.report.status, 'FAIL'); assert.equal(h.exitCode(), 1); assert.equal(h.saves.at(-1), 'FAIL')
})

test('terminal persistence errors retain failure and a nonzero exit even when retry fails', async () => {
  const h = await terminalHarness({ duringSave: () => { throw new Error('disk unavailable') } })
  h.releaseScreenshot(); await h.completion.catch(() => {})
  assert.equal(h.report.status, 'FAIL'); assert.equal(h.exitCode(), 1)
})

test('reopened transcript requires actual rendered user and assistant DOM rather than only stored messages', async () => {
  const vm = await import('node:vm')
  const { readView, hasRenderedTranscript } = await import('./worlds-ai-electron-fixture/driver.ts')
  const expected = [{ role: 'user', content: 'saved user' }, { role: 'assistant', content: 'saved assistant' }]
  let nodes = []
  const document = { activeElement: null,
    getElementById: (id) => id === 'worlds-ai-fixture-state' ? { textContent: JSON.stringify({ messages: expected, sessionInitialized: true }) } : null,
    querySelector: () => null,
    querySelectorAll: (selector) => selector.includes('.px-4.py-3.gap-5') ? nodes : [],
  }
  const contents = { executeJavaScript: async (code) => vm.runInNewContext(code, { document }) }
  assert.equal(hasRenderedTranscript(await readView(contents), expected), false)
  nodes = expected.map((message) => ({ querySelector: (selector) => {
    const user = selector.includes('rounded-br-sm')
    return user === (message.role === 'user') ? { innerText: message.content,
      checkVisibility: () => true, getBoundingClientRect: () => ({ width: 100, height: 20 }) } : null
  } }))
  assert.equal(hasRenderedTranscript(await readView(contents), expected), true)
  const rendered = await readView(contents); rendered.ui.transcript[0].rendered = false
  assert.equal(hasRenderedTranscript(rendered, expected), false)
  nodes.reverse(); assert.equal(hasRenderedTranscript(await readView(contents), expected), false)
  nodes.reverse(); expected[1].content = 'wrong saved assistant'
  // Freeze DOM independently from the changed store expectation.
  nodes[1] = { querySelector: (selector) => selector.includes('rounded-br-sm') ? null : {
    innerText: 'saved assistant', checkVisibility: () => true, getBoundingClientRect: () => ({ width: 100, height: 20 }),
  } }
  assert.equal(hasRenderedTranscript(await readView(contents), expected), false)
  const driver = await source('driver.ts')
  assert.match(driver, /await waitForTranscript\(contents, messages, activate\)/)
})


test('terminal success waits for cleanup and persists exactly one final PASS', async () => {
  let releaseCleanup; let cleanupStarted
  const started = new Promise((resolve) => { cleanupStarted = resolve })
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve })
  const h = await terminalHarness({ duringCleanup: async () => { cleanupStarted(); await cleanupGate } })
  h.releaseScreenshot(); await started
  assert.equal(h.report.status, 'RUNNING'); assert.equal(h.exitCode(), undefined); assert.deepEqual(h.saves, [])
  releaseCleanup(); await h.completion
  assert.equal(h.report.status, 'PASS'); assert.equal(h.exitCode(), 0); assert.deepEqual(h.saves, ['PASS'])
})

test('transcript restoration waits past populated store and expands actual collapsed history control', async () => {
  const vm = await import('node:vm')
  const { waitForTranscript } = await import('./worlds-ai-electron-fixture/driver.ts')
  const expected = Array.from({ length: 6 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' : 'user', content: `saved ${index}` }))
  let reads = 0; let expanded = false
  const controls = []
  const document = { activeElement: null,
    getElementById: (id) => id === 'worlds-ai-fixture-state' ? { textContent: JSON.stringify({ messages: expected, sessionInitialized: true }) } : null,
    querySelector: (selector) => selector.includes('button.self-start') && reads > 1 && !expanded ? { textContent: '2 previous messages' } : null,
    querySelectorAll: (selector) => selector.includes('.px-4.py-3.gap-5') && reads > 1
      ? (expanded ? expected : expected.slice(-4)).map((message) => ({ querySelector: (query) => {
        return query.includes('rounded-br-sm') === (message.role === 'user') ? { innerText: message.content,
          checkVisibility: () => true, getBoundingClientRect: () => ({ width: 100, height: 20 }) } : null
      } })) : [],
  }
  const contents = { executeJavaScript: async (code) => { reads++; return vm.runInNewContext(code, { document }) } }
  const view = await waitForTranscript(contents, expected, async (control) => { controls.push(control); expanded = true })
  assert.ok(reads >= 3); assert.deepEqual(controls, ['history'])
  assert.equal(JSON.stringify(view.ui.transcript.map(({ role, content }) => ({ role, content }))), JSON.stringify(expected.map(({ role, content }) => ({ role, content }))))
  const panel = await readFile(new URL('../src/areas/generate/components/ChatPanel.tsx', import.meta.url), 'utf8')
  for (const markup of ['const COLLAPSE_AFTER = 4', 'flex flex-col px-4 py-3 gap-5', 'rounded-br-sm', 'leading-relaxed text-zinc-200', 'previous message']) assert.ok(panel.includes(markup), markup)
})


// Integrated from the independent verbatim VM child-close diagnostic. EventEmitter
// doubles only: no process spawn, Electron, backend, filesystem write or socket.
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))
for (const code of [23, 0]) {
  test(`backend unexpected exit ${code} latches failure before delayed close and cannot pass`, async () => {
    const h = await terminalHarness({ withChild: true })
    try {
      h.ownedChild.exitCode = code; h.ownedChild.emit('exit', code, null)
      assert.equal(h.report.status, 'FAIL', 'Even zero exit is unexpected before requested shutdown.')
      h.releaseScreenshot(); await nextTurn()
      assert.equal(h.exitCode(), undefined, 'Every spawned child must be awaited through close.')
      assert.equal(h.saves.includes('PASS'), false); assert.deepEqual(h.kills, [])
    } finally {
      h.releaseScreenshot(); h.ownedChild.emit('close', code, null); await h.completion
    }
    assert.equal(h.report.status, 'FAIL'); assert.equal(h.exitCode(), 1); assert.equal(h.saves.at(-1), 'FAIL')
  })
}

test('backend requested SIGTERM waits for close after exit and preserves clean success', async () => {
  const h = await terminalHarness({ withChild: true })
  h.releaseScreenshot(); await nextTurn()
  try {
    assert.deepEqual(h.kills, ['SIGTERM']); assert.equal(h.report.status, 'RUNNING')
    h.ownedChild.signalCode = 'SIGTERM'; h.ownedChild.emit('exit', null, 'SIGTERM')
    await nextTurn(); assert.equal(h.exitCode(), undefined); assert.deepEqual(h.saves, [])
  } finally { h.ownedChild.emit('close', null, 'SIGTERM'); await h.completion }
  assert.equal(h.exitCode(), 0); assert.deepEqual(h.saves, ['PASS'])
})

test('backend pending close still validates trailing stdout and child errors before terminal status', async () => {
  for (const fault of ['stdout', 'error', 'incomplete-stdout', 'extra-round']) {
    const h = await terminalHarness({ withChild: true })
    h.releaseScreenshot(); await nextTurn()
    h.ownedChild.signalCode = 'SIGTERM'; h.ownedChild.emit('exit', null, 'SIGTERM')
    assert.equal(h.exitCode(), undefined)
    if (fault === 'stdout') h.ownedChild.stdout.emit('data', Buffer.from('not-json\n'))
    else if (fault === 'error') h.ownedChild.emit('error', new Error('late child validation error'))
    else h.ownedChild.stdout.emit('data', Buffer.from(fault === 'extra-round' ? '{"kind":"stub-round"}\n' : 'incomplete'))
    if (fault === 'stdout' || fault === 'error') assert.equal(h.report.status, 'FAIL')
    assert.equal(h.exitCode(), undefined)
    h.ownedChild.emit('close', null, 'SIGTERM'); await h.completion
    assert.equal(h.exitCode(), 1); assert.equal(h.saves.at(-1), 'FAIL')
  }
})

test('backend missing close after observed exit has a bounded failing teardown', async () => {
  const h = await terminalHarness({ withChild: true })
  // Reproduce a populated ChildProcess status even if its exit observer were late.
  h.ownedChild.exitCode = 23
  const started = Date.now(); h.releaseScreenshot(); await nextTurn()
  assert.equal(h.exitCode(), undefined)
  await h.completion
  assert.ok(Date.now() - started >= 4_900 && Date.now() - started < 8_000)
  assert.equal(h.exitCode(), 1); assert.equal(h.report.status, 'FAIL')
  assert.match(h.report.cleanupError, /Owned child shutdown deadline exceeded/)
  assert.equal(h.saves.at(-1), 'FAIL'); assert.deepEqual(h.kills, [])
})

test('backend forced SIGKILL remains failure and still waits for owned close', async () => {
  const h = await terminalHarness({ withChild: true })
  let forced
  const forcedSignal = new Promise((resolve) => { forced = resolve })
  h.ownedChild.kill = (signal) => { h.kills.push(signal); if (signal === 'SIGKILL') forced(); return true }
  h.releaseScreenshot(); await forcedSignal
  assert.equal(h.report.status, 'FAIL'); assert.equal(h.exitCode(), undefined)
  h.ownedChild.signalCode = 'SIGKILL'; h.ownedChild.emit('exit', null, 'SIGKILL'); h.ownedChild.emit('close', null, 'SIGKILL')
  await h.completion
  assert.deepEqual(h.kills, ['SIGTERM', 'SIGKILL']); assert.equal(h.exitCode(), 1); assert.equal(h.saves.at(-1), 'FAIL')
})

test('startup main CJS build preserves a genuine import meta URL and rejects unsupported metadata', async () => {
  const { mainBuildOptions } = await import('./worlds-ai-electron-fixture.mjs')
  const { transform } = await import('esbuild'); const vm = await import('node:vm'); const { createRequire } = await import('node:module')
  const outfile = '/tmp/modly-worlds-ai-ui-contract/main.cjs'
  const options = mainBuildOptions(outfile)
  const result = await transform('import { createRequire } from "node:module"; globalThis.requireType = typeof createRequire(import.meta.url)', options)
  const context = vm.createContext({ require: createRequire(import.meta.url) }); vm.runInContext(result.code, context)
  assert.equal(context.requireType, 'function'); assert.deepEqual(result.warnings, [])
  assert.ok(result.code.includes('file:///tmp/modly-worlds-ai-ui-contract/main.cjs'))
  await assert.rejects(transform('console.log(import.meta.unhandled)', options), /import.meta/)
})

async function startupHarness({ argvChange, envChange, failImport = false, failWrite = false, noTransfer = false, tamper, appMismatch = false, switchMismatch = false, emitStartupFailure = false } = {}) {
  const fs = await import('node:fs'); const vm = await import('node:vm'); const { createRequire } = await import('node:module'); const { EventEmitter } = await import('node:events')
  const { prepareNativeState } = await import('./worlds-ai-electron-fixture.mjs')
  const root = await mkdtemp('/tmp/modly-worlds-ai-ui-startup-contract-')
  const launch = await prepareNativeState(root)
  const bootstrap = await source('bootstrap.cjs')
  const outputs = {}
  for (const name of ['bootstrap.cjs', 'main.cjs', 'preload.cjs', 'renderer/index.html', 'backend/backend.py', 'backend/routers/agent.py', 'backend/routers/world_ai.py', 'backend/routers/__init__.py', 'backend/services/__init__.py', 'backend/services/agent_providers/__init__.py', 'backend/services/agent_providers/openai.py']) {
    const filename = path.join(root, name); fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
    const bytes = Buffer.from(name === 'bootstrap.cjs' ? bootstrap : 'VM contract only; never loaded')
    fs.writeFileSync(filename, bytes); outputs[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  const manifest = { schema: 'modly.worlds-ai-ui-build.v1', execution: 'NOT_RUN', outputDirectory: root,
    versions: { electron: '44.1.1' }, launch, outputs }
  fs.writeFileSync(path.join(root, 'fixture-build.json'), JSON.stringify(manifest), { mode: 0o600 })
  tamper?.({ root, launch, fs })
  const events = []; const exits = []; const runtimeErrors = []
  const processDouble = Object.assign(new EventEmitter(), { argv: [...launch.argv], env: { ...launch.environment, DISPLAY: ':99', XAUTHORITY: path.join(launch.paths.tmp, 'private-authority') },
    versions: { electron: '44.1.1' }, execPath: launch.argv[0], getuid: () => process.getuid(), pid: 100,
    stderr: { write(value) { events.push(['stderr', value]) } } })
  argvChange?.(processDouble.argv); envChange?.(processDouble.env)
  const paths = { userData: appMismatch ? '/wrong' : launch.paths.userData }
  const app = { isReady: () => false, setName() {}, getPath: (name) => paths[name], setPath(name, value) { paths[name] = value; events.push(['setPath', name, value]) },
    enableSandbox() { events.push(['sandbox']) }, exit(code) { exits.push(code) },
    commandLine: { getSwitchValue: () => switchMismatch ? '/wrong' : launch.paths.userData, hasSwitch: (name) => name === 'allow-file-access-from-files' } }
  const realRequire = createRequire(import.meta.url)
  const context = vm.createContext({ __dirname: root, __filename: path.join(root, 'bootstrap.cjs'), Buffer, process: processDouble,
    require(name) {
      if (name === 'electron') return { app }
      if (name.startsWith('node:')) return name === 'node:fs' && failWrite ? { ...fs, writeFileSync(filename, ...args) { if (filename.endsWith('startup-failure.json')) throw Error('write denied'); return fs.writeFileSync(filename, ...args) } } : realRequire(name)
      assert.equal(name, path.join(root, 'main.cjs')); events.push(['heavy-load'])
      if (failImport) throw Error('controlled transitive import failure')
      if (emitStartupFailure) processDouble.emit('uncaughtException', new Error('controlled early uncaught failure'))
      return { startFixture(startup) {
        events.push(['entry', startup]); if (!noTransfer) startup.takeOwnership((error) => runtimeErrors.push(error))
      } }
    },
  })
  vm.runInContext(bootstrap, context, { filename: path.join(root, 'bootstrap.cjs') })
  return { root, launch, events, exits, runtimeErrors, processDouble, fs }
}

test('startup bootstrap binds private state and sandbox before heavy import then transfers error ownership', async () => {
  const h = await startupHarness()
  assert.deepEqual(h.exits, [])
  assert.deepEqual(h.events.slice(0, 4).map(([kind, name]) => [kind, name]), [['setPath', 'userData'], ['setPath', 'sessionData'], ['setPath', 'crashDumps'], ['sandbox', undefined]])
  assert.equal(h.events[4][0], 'heavy-load')
  const main = await source('main.ts')
  assert.match(main, /export function startFixture\(startup: FixtureStartup\)/)
  assert.ok(main.indexOf('startup.takeOwnership(fail)') > main.indexOf('void Promise.race'))
  assert.match(main, /Promise.resolve\(\).then\(run\)/)
  h.processDouble.emit('uncaughtException', new Error('runtime error')); h.processDouble.emit('unhandledRejection', new Error('runtime rejection'))
  assert.equal(h.runtimeErrors.length, 2); assert.deepEqual(h.exits, [], 'Later failures must use owned runtime cleanup, not bootstrap exit.')
  for (const filename of ['startup-attempt.json']) assert.ok(h.fs.statSync(path.join(h.launch.paths.stateRoot, filename)).isFile())
})

test('startup bootstrap accepts only the explicit disabled DBus sentinel before heavy imports', async () => {
  const safe = await startupHarness({ envChange: (env) => { env.DBUS_SESSION_BUS_ADDRESS = 'disabled:' } })
  assert.deepEqual(safe.exits, [])
  assert.equal(safe.events.some(([kind]) => kind === 'heavy-load'), true)
  for (const DBUS_SESSION_BUS_ADDRESS of ['', 'autolaunch:', '/run/user/1000/bus', 'unix:path=/run/user/1000/bus', 'unix:abstract=/tmp/dbus-test']) {
    const h = await startupHarness({ envChange: (env) => { env.DBUS_SESSION_BUS_ADDRESS = DBUS_SESSION_BUS_ADDRESS } })
    assert.deepEqual(h.exits, [1], DBUS_SESSION_BUS_ADDRESS)
    assert.equal(h.events.some(([kind]) => kind === 'heavy-load'), false, DBUS_SESSION_BUS_ADDRESS)
  }
})

test('startup import and initialization failures request nonzero exit without depending on Electron default handlers', async () => {
  for (const options of [{ failImport: true }, { noTransfer: true }, { failImport: true, failWrite: true }, { appMismatch: true }, { emitStartupFailure: true }]) {
    const h = await startupHarness(options); assert.deepEqual(h.exits, [1])
    if (!options.failWrite) assert.ok(h.fs.existsSync(path.join(h.launch.paths.stateRoot, 'startup-failure.json')))
  }
})

test('startup bootstrap rejects unsafe argv environment symlinks wrong modes and state reuse before heavy imports', async () => {
  const cases = [
    { argvChange: (argv) => argv.push('--allow-file-access-from-files') },
    { argvChange: (argv) => argv.push(argv[2]) },
    { argvChange: (argv) => { argv[2] = '--user-data-dir=/tmp/not-owned' } },
    { switchMismatch: true },
    { argvChange: (argv) => { argv[1] = '/tmp/other-bootstrap.cjs' } },
    { tamper: ({ root, fs }) => fs.writeFileSync(path.join(root, 'main.cjs'), 'tampered') },
    { envChange: (env) => { env.HOME = '/wrong' } },
    { envChange: (env) => { env.ELECTRON_DISABLE_SANDBOX = '' } },
    { tamper: ({ launch, fs }) => fs.chmodSync(launch.paths.cache, 0o755) },
    { tamper: ({ root, launch, fs }) => { fs.rmdirSync(launch.paths.cache); fs.symlinkSync(root, launch.paths.cache) } },
    { tamper: ({ launch, fs }) => fs.writeFileSync(path.join(launch.paths.stateRoot, 'startup-attempt.json'), '{}') },
  ]
  for (const options of cases) {
    const h = await startupHarness(options); assert.deepEqual(h.exits, [1]); assert.equal(h.events.some(([kind]) => kind === 'heavy-load'), false)
  }
})

test('startup AI launch grammar allows only the exact prepared private user data argument', async () => {
  const { assertFixtureLaunch } = await import('./worlds-ai-electron-fixture/shared.ts')
  const { prepareNativeState } = await import('./worlds-ai-electron-fixture.mjs')
  const launch = await prepareNativeState(await mkdtemp('/tmp/modly-worlds-ai-ui-argv-contract-'))
  const env = { ...launch.environment, DISPLAY: ':99' }
  assert.doesNotThrow(() => assertFixtureLaunch(launch.argv, env, launch))
  for (const argv of [launch.argv.slice(0, 2), [...launch.argv, launch.argv[2]], [...launch.argv, '--no-sandbox'], [launch.argv[0], '--user-data-dir=', launch.argv[1]]]) assert.throws(() => assertFixtureLaunch(argv, env, launch))
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SANDBOX', 'SESSION_MANAGER']) assert.throws(() => assertFixtureLaunch(launch.argv, { ...env, [name]: '' }, launch))
  for (const DBUS_SESSION_BUS_ADDRESS of ['', 'autolaunch:', '/run/user/1000/bus', 'unix:path=/run/user/1000/bus']) assert.throws(() => assertFixtureLaunch(launch.argv, { ...env, DBUS_SESSION_BUS_ADDRESS }, launch), /DBUS_SESSION_BUS_ADDRESS/)
})
