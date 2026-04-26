import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSceneImportService, type SceneImportMeshResult, type SceneImportServiceDeps } from './scene-import-service.ts'
import { createElectronApi } from '../preload/electron-api.ts'

function assertFailure(result: SceneImportMeshResult, status: number, code: string): void {
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('Expected an import failure')
  assert.equal(result.statusCode, status)
  assert.equal(result.error.code, code)
}

async function withWorkspace(run: (workspaceDir: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'modly-scene-import-'))
  const workspaceDir = join(root, 'workspace')
  await mkdir(join(workspaceDir, 'Default'), { recursive: true })
  try {
    await run(workspaceDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('imports workspace-relative mesh through backend and sends renderer event', async () => {
  await withWorkspace(async (workspaceDir) => {
    await writeFile(join(workspaceDir, 'Default', 'imported.glb'), 'glb')
    const calls: Array<{ method: string; url: string; body?: unknown }> = []
    const sent: Array<{ channel: string; payload: unknown }> = []

    const service = createSceneImportService({
      resolveWorkspaceDir: async () => workspaceDir,
      backendBaseUrl: 'http://127.0.0.1:8765',
      backendRequest: async (method, url, body) => {
        calls.push({ method, url, body })
        if (method === 'GET' && url.endsWith('/health')) return { ok: true, data: { status: 'ok' } }
        if (method === 'POST' && url.endsWith('/optimize/import-by-path')) return { ok: true, data: { url: '/workspace/Default/imported.glb' } }
        throw new Error(`Unexpected request ${method} ${url}`)
      },
      getRendererWindow: () => ({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      }),
    })

    const result = await service.importMesh({ meshPath: 'Default/imported.glb' })

    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('Expected an import dispatch')
    assert.equal(result.statusCode, 200)
    assert.deepEqual(result.result, {
      meshPath: 'Default/imported.glb',
      url: '/workspace/Default/imported.glb',
      displayName: 'imported.glb',
    })
    assert.deepEqual(calls, [
      { method: 'GET', url: 'http://127.0.0.1:8765/health', body: undefined },
      {
        method: 'POST',
        url: 'http://127.0.0.1:8765/optimize/import-by-path',
        body: { path: join(workspaceDir, 'Default', 'imported.glb') },
      },
    ])
    assert.deepEqual(sent, [{ channel: 'scene:importMesh', payload: result.result }])
  })
})

test('rejects invalid scene import mesh requests before backend mutation', async () => {
  await withWorkspace(async (workspaceDir) => {
    await writeFile(join(workspaceDir, 'Default', 'notes.txt'), 'txt')
    let backendCalls = 0
    const service = createSceneImportService({
      resolveWorkspaceDir: async () => workspaceDir,
      backendBaseUrl: 'http://127.0.0.1:8765',
      backendRequest: async () => {
        backendCalls += 1
        return { ok: true, data: {} }
      },
      getRendererWindow: () => null,
    })

    const absolute = await service.importMesh({ meshPath: join(workspaceDir, 'Default', 'imported.glb') })
    assertFailure(absolute, 400, 'INVALID_WORKSPACE_PATH')

    const traversal = await service.importMesh({ meshPath: '../escape.glb' })
    assertFailure(traversal, 400, 'INVALID_WORKSPACE_PATH')

    const unsupported = await service.importMesh({ meshPath: 'Default/notes.txt' })
    assertFailure(unsupported, 400, 'UNSUPPORTED_MESH_EXTENSION')

    const missing = await service.importMesh({ meshPath: 'Default/missing.glb' })
    assertFailure(missing, 404, 'MESH_FILE_NOT_FOUND')

    assert.equal(backendCalls, 0)
  })
})

test('returns factual error when renderer window is unavailable', async () => {
  await withWorkspace(async (workspaceDir) => {
    await writeFile(join(workspaceDir, 'Default', 'imported.glb'), 'glb')
    const service = createSceneImportService({
      resolveWorkspaceDir: async () => workspaceDir,
      backendBaseUrl: 'http://127.0.0.1:8765',
      backendRequest: async (method, url) => {
        if (method === 'GET' && url.endsWith('/health')) return { ok: true, data: { status: 'ok' } }
        if (method === 'POST' && url.endsWith('/optimize/import-by-path')) return { ok: true, data: { url: '/workspace/Default/imported.glb' } }
        throw new Error(`Unexpected request ${method} ${url}`)
      },
      getRendererWindow: () => null,
    })

    const result = await service.importMesh({ meshPath: 'Default/imported.glb' })
    assertFailure(result, 503, 'RENDERER_UNAVAILABLE')
    if (result.ok) throw new Error('Expected an import failure')
    assert.deepEqual(result.error, {
      code: 'RENDERER_UNAVAILABLE',
      message: 'Renderer window is not available; mesh was not imported into the scene.',
      retryable: true,
    })
  })
})

function createFixture(workspaceDir: string, overrides: Partial<SceneImportServiceDeps> = {}) {
  const calls: Array<{ method: string; body?: unknown }> = []
  const sent: unknown[] = []
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (_channel: string, payload: unknown) => { sent.push(payload) } },
  }
  const service = createSceneImportService({
    resolveWorkspaceDir: () => workspaceDir,
    getRendererWindow: () => window,
    backendRequest: async (method, _url, body) => {
      calls.push({ method, body })
      return { ok: true, status: 200, data: method === 'GET' ? { status: 'ok' } : { url: '/optimize/serve-file?path=%2Ftmp%2Fmesh.glb' } }
    },
    ...overrides,
  })
  return { service, window, calls, sent }
}

for (const meshPath of ['', ' ', '/tmp/escape.glb', '../escape.glb', 'Default/../escape.glb', '..\\escape.glb', 'C:\\mesh.glb', 'C:mesh.glb', '\\\\server\\mesh.glb', '\\mesh.glb', 'file:///tmp/mesh.glb', 'Default/mesh\0.glb']) {
  test(`rejects unsafe path ${JSON.stringify(meshPath)} before renderer or backend access`, async () => {
    const fixture = createFixture('/unused', { resolveWorkspaceDir: () => { throw new Error('Path must fail before workspace access') } })
    assertFailure(await fixture.service.importMesh({ meshPath }), 400, 'INVALID_WORKSPACE_PATH')
    assert.deepEqual(fixture.calls, [])
    assert.deepEqual(fixture.sent, [])
  })
}

for (const directoryLink of [false, true]) {
  test(`rejects ${directoryLink ? 'directory' : 'file'} symlink escape before backend access`, async () => {
    await withWorkspace(async (workspaceDir) => {
      const outside = join(workspaceDir, '..', 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'escape.glb'), 'mesh')
      await symlink(directoryLink ? outside : join(outside, 'escape.glb'), join(workspaceDir, directoryLink ? 'link' : 'link.glb'))
      const fixture = createFixture(workspaceDir)
      assertFailure(await fixture.service.importMesh({ meshPath: directoryLink ? 'link/escape.glb' : 'link.glb' }), 400, 'INVALID_WORKSPACE_PATH')
      assert.deepEqual(fixture.calls, [])
      assert.deepEqual(fixture.sent, [])
    })
  })
}

test('accepts contained symlink with canonical backend path and Windows relative separators', async () => {
  await withWorkspace(async (workspaceDir) => {
    await writeFile(join(workspaceDir, 'Default', 'mesh.GLB'), 'mesh')
    await symlink(join(workspaceDir, 'Default', 'mesh.GLB'), join(workspaceDir, 'linked.glb'))
    const fixture = createFixture(workspaceDir)
    for (const meshPath of ['linked.glb', 'Default\\mesh.GLB']) {
      const result = await fixture.service.importMesh({ meshPath })
      assert.equal(result.ok, true)
      assert.deepEqual(fixture.calls.at(-1)?.body, { path: join(workspaceDir, 'Default', 'mesh.GLB') })
    }
    assert.equal(fixture.sent.length, 2)
  })
})

for (const filename of ['mesh.obj', 'mesh.stl', 'mesh.ply', 'Espaço 50% #draft?.glb']) {
  test(`preserves supported mesh format and literal filename ${filename}`, async () => {
    await withWorkspace(async (workspaceDir) => {
      await writeFile(join(workspaceDir, 'Default', filename), 'mesh')
      const url = `/optimize/serve-file?path=${encodeURIComponent(`/tmp/converted ${filename === 'mesh.ply' ? 'splat.splat' : 'mesh.glb'}`)}`
      const requests: unknown[] = []
      const fixture = createFixture(workspaceDir, {
        backendRequest: async (method, _url, body) => {
          if (method === 'GET') return { ok: true, data: { status: 'ok' } }
          requests.push(body)
          return { ok: true, data: { url } }
        },
      })
      const result = await fixture.service.importMesh({ meshPath: `Default/${filename}` })
      assert.equal(result.ok, true)
      if (!result.ok) throw new Error('Expected import dispatch')
      assert.equal(result.result.url, url)
      assert.equal(result.result.displayName, filename)
      assert.deepEqual(requests, [{ path: join(workspaceDir, 'Default', filename) }])
    })
  })
}

test('keeps the automation allowlist narrower than normal SPLAT import', async () => {
  const fixture = createFixture('/unused', { resolveWorkspaceDir: () => { throw new Error('Unexpected workspace access') } })
  assertFailure(await fixture.service.importMesh({ meshPath: 'Default/mesh.splat' }), 400, 'UNSUPPORTED_MESH_EXTENSION')
  assert.deepEqual(fixture.calls, [])
})

for (const health of [
  { ok: false, status: 503, data: { status: 'ok' } },
  { ok: true, status: 500, data: { status: 'ok' } },
  { ok: true, data: { status: 'starting' } },
  { ok: true, data: { ok: false } },
  { ok: true, data: null },
]) {
  test(`rejects unhealthy backend ${JSON.stringify(health)} without import dispatch`, async () => {
    await withWorkspace(async (workspaceDir) => {
      await writeFile(join(workspaceDir, 'Default', 'mesh.glb'), 'mesh')
      let requests = 0
      const fixture = createFixture(workspaceDir, { backendRequest: async () => { requests += 1; return health } })
      assertFailure(await fixture.service.importMesh({ meshPath: 'Default/mesh.glb' }), 503, 'BACKEND_NOT_READY')
      assert.equal(requests, 1)
      assert.deepEqual(fixture.sent, [])
    })
  })
}

for (const response of [
  { ok: false, status: 400, data: { url: '/workspace/mesh.glb' } },
  { ok: true, status: 500, data: { url: '/workspace/mesh.glb' } },
  { ok: true, data: { ok: false, url: '/workspace/mesh.glb' } },
  ...[undefined, '', ' ', 'https://remote.invalid/mesh.glb', '//remote.invalid/mesh.glb', 'file:///tmp/mesh.glb', 'javascript:alert(1)', '/workspace/../private.glb', '/workspace/%2e%2e/private.glb', '/workspace/mesh.glb\n', '/unrelated/mesh.glb', '/optimize/serve-file', '/optimize/serve-file?path='].map((url) => ({ ok: true, data: { url } })),
]) {
  test(`rejects failed or malformed backend import ${JSON.stringify(response)}`, async () => {
    await withWorkspace(async (workspaceDir) => {
      await writeFile(join(workspaceDir, 'Default', 'mesh.glb'), 'mesh')
      const fixture = createFixture(workspaceDir, {
        backendRequest: async (method) => method === 'GET' ? { ok: true, data: { status: 'ok' } } : response,
      })
      assertFailure(await fixture.service.importMesh({ meshPath: 'Default/mesh.glb' }), 502, 'SCENE_IMPORT_BACKEND_FAILED')
      assert.deepEqual(fixture.sent, [])
    })
  })
}

for (const failure of ['health', 'import', 'destroyed-window', 'destroyed-contents', 'send'] as const) {
  test(`reports ${failure} failure without successful dispatch`, async () => {
    await withWorkspace(async (workspaceDir) => {
      await writeFile(join(workspaceDir, 'Default', 'mesh.glb'), 'mesh')
      const fixture = createFixture(workspaceDir, {
        backendRequest: async (method) => {
          if ((failure === 'health' && method === 'GET') || (failure === 'import' && method === 'POST')) throw new Error('unavailable')
          if (method === 'POST' && failure === 'destroyed-window') fixture.window.isDestroyed = () => true
          if (method === 'POST' && failure === 'destroyed-contents') fixture.window.webContents.isDestroyed = () => true
          return { ok: true, data: method === 'GET' ? { status: 'ok' } : { url: '/workspace/mesh.glb' } }
        },
      })
      if (failure === 'send') fixture.window.webContents.send = () => { throw new Error('renderer gone') }
      const result = await fixture.service.importMesh({ meshPath: 'Default/mesh.glb' })
      assertFailure(result, failure === 'import' ? 502 : 503, failure === 'health' ? 'BACKEND_NOT_READY' : failure === 'import' ? 'SCENE_IMPORT_BACKEND_FAILED' : 'RENDERER_UNAVAILABLE')
      assert.deepEqual(fixture.sent, [])
    })
  })
}

test('success reports dispatch only even when no Generate listener acknowledges it', async () => {
  await withWorkspace(async (workspaceDir) => {
    await writeFile(join(workspaceDir, 'Default', 'mesh.glb'), 'mesh')
    const fixture = createFixture(workspaceDir)
    const result = await fixture.service.importMesh({ meshPath: 'Default/mesh.glb' })
    assert.equal(result.ok, true)
    assert.equal(fixture.sent.length, 1)
    assert.equal('rendered' in result, false)
  })
})

test('preload scene event forwards the exact mesh payload and cleans up its listener', () => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const removed: string[] = []
  const api = createElectronApi({
    async invoke() { throw new Error('Event subscription must not invoke a backend') },
    send() { throw new Error('Event subscription must not send a command') },
    on(channel, listener) { listeners.set(channel, listener) },
    removeAllListeners(channel) { removed.push(channel); listeners.delete(channel) },
  }, { setZoomFactor() {} }, { getPathForFile() { return '/inert/file' } })
  const received: unknown[] = []
  const payload = { meshPath: 'Default/model.obj', url: '/optimize/serve-file?path=%2Ftmp%2Fmesh.glb', displayName: 'model.obj' }
  api.scene.onImportMesh((event) => received.push(event))
  listeners.get('scene:importMesh')?.({}, payload)
  assert.deepEqual(received, [payload])
  api.scene.offImportMesh()
  assert.equal(listeners.has('scene:importMesh'), false)
  assert.deepEqual(removed, ['scene:importMesh'])
})
