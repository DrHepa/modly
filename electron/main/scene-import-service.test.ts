import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSceneImportService } from './scene-import-service.ts'

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
        if (method === 'GET' && url.endsWith('/health')) return { ok: true, data: { ok: true } }
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
    assert.equal(absolute.statusCode, 400)
    assert.equal(absolute.error.code, 'INVALID_WORKSPACE_PATH')

    const traversal = await service.importMesh({ meshPath: '../escape.glb' })
    assert.equal(traversal.statusCode, 400)
    assert.equal(traversal.error.code, 'INVALID_WORKSPACE_PATH')

    const unsupported = await service.importMesh({ meshPath: 'Default/notes.txt' })
    assert.equal(unsupported.statusCode, 400)
    assert.equal(unsupported.error.code, 'UNSUPPORTED_MESH_EXTENSION')

    const missing = await service.importMesh({ meshPath: 'Default/missing.glb' })
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.error.code, 'MESH_FILE_NOT_FOUND')

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
        if (method === 'GET' && url.endsWith('/health')) return { ok: true, data: { ok: true } }
        if (method === 'POST' && url.endsWith('/optimize/import-by-path')) return { ok: true, data: { url: '/workspace/Default/imported.glb' } }
        throw new Error(`Unexpected request ${method} ${url}`)
      },
      getRendererWindow: () => null,
    })

    const result = await service.importMesh({ meshPath: 'Default/imported.glb' })
    assert.equal(result.statusCode, 503)
    assert.deepEqual(result.error, {
      code: 'RENDERER_UNAVAILABLE',
      message: 'Renderer window is not available; mesh was not imported into the scene.',
      retryable: true,
    })
  })
})
