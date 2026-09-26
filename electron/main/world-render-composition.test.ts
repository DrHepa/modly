import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { initializeWorldRenderSubsystem } from './world-render-composition.ts'
import { WorldRenderJobService } from './world-render-job-service.ts'
import { WorldRenderOutputRepository } from './world-render-output-repository.ts'

test('render subsystem recovers before it is returned and shuts service before browser executor', async () => {
  const events: string[] = []
  const service = {
    initialize: async () => { events.push('recover') },
    shutdown: async () => { events.push('cancel-jobs') },
    create: async () => ({ ok: false as const, error: { code: 'executor_unavailable' as const, message: '', retryable: true } }),
    list: async () => ({ ok: true as const, value: { jobs: [] } }),
    get: async () => ({ ok: false as const, error: { code: 'job_not_found' as const, message: '', retryable: false } }),
    cancel: async () => ({ ok: false as const, error: { code: 'job_not_found' as const, message: '', retryable: false } }),
    delete: async () => ({ ok: false as const, error: { code: 'job_not_found' as const, message: '', retryable: false } }),
  }
  const executor = { shutdown: async () => { events.push('dispose-hosts') } }
  const subsystem = await initializeWorldRenderSubsystem({ service, executor })
  assert.equal(subsystem.api, service)
  assert.deepEqual(events, ['recover'])
  await Promise.all([subsystem.shutdown(), subsystem.shutdown()])
  assert.deepEqual(events, ['recover', 'cancel-jobs', 'dispose-hosts'])
})

test('production render composition opens against a clean profile without creating its absent workspace', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'modly-world-render-composition-clean-'))
  const workspaceRoot = join(parent, 'workspace')
  t.after(() => rm(parent, { recursive: true, force: true }))
  const outputRepository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => workspaceRoot })
  const executor = {
    execute: async () => { throw new Error('unused') },
    shutdown: async () => undefined,
  }
  const service = new WorldRenderJobService({
    projectReader: { open: async () => { throw new Error('unused') } },
    outputRepository,
    executor,
  })

  const subsystem = await initializeWorldRenderSubsystem({ service, executor })
  assert.deepEqual(await subsystem.api.list(), { ok: true, value: { jobs: [] } })
  assert.equal(await lstat(workspaceRoot).then(() => true, () => false), false)
  await subsystem.shutdown()
})

test('main composes one real render authority, awaits recovery, registers trusted IPC, and owns shutdown', async () => {
  const ipc = await readFile(new URL('./ipc-handlers.ts', import.meta.url), 'utf8')
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(ipc, /export async function setupIpcHandlers/)
  assert.equal((ipc.match(/new WorldRenderOutputRepository\(/g) ?? []).length, 1)
  assert.equal((ipc.match(/new WorldRenderBrowserExecutor\(/g) ?? []).length, 1)
  assert.equal((ipc.match(/new WorldRenderJobService\(/g) ?? []).length, 1)
  assert.equal((ipc.match(/createPackagedWorldFfmpegFallback\(/g) ?? []).length, 1)
  assert.match(ipc, /resourcesPath: process\.resourcesPath/)
  assert.match(ipc, /spawnProcess: spawn as unknown as WorldFfmpegSpawn/)
  assert.doesNotMatch(ipc, /spawnProcess:\s*\(/)
  assert.equal((ipc.match(/getWorkspaceRoot: getWorldsWorkspaceRoot/g) ?? []).length, 3)
  assert.match(ipc, /await initializeWorldRenderSubsystem\(/)
  assert.match(ipc, /registerWorldRendersIpcHandlers\(ipcMain, worldRenderSubsystem\.api, \{\s*isTrustedSender: isTrustedMainFrameSender/)
  assert.match(ipc, /await worldRenderSubsystem\.shutdown\(\)/)
  assert.match(main, /ipcHandlersSetup = setupIpcHandlers\(pythonBridge, \(\) => mainWindow, trustedRendererUrl\)/)
  assert.ok(main.indexOf('const configuredIpcLifecycle = await ipcHandlersSetup') < main.lastIndexOf('createWindow()'))
})

test('quit during asynchronous render recovery owns the pending IPC lifecycle and never opens a late window', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(main, /let ipcHandlersSetup: Promise<IpcHandlersLifecycle> \| null = null/)
  assert.match(main, /ipcHandlersSetup = setupIpcHandlers\(pythonBridge, \(\) => mainWindow, trustedRendererUrl\)/)
  assert.match(main, /if \(isQuitting\) \{\s*await configuredIpcLifecycle\.shutdown\(\)\s*return\s*\}/)
  assert.match(main, /ipcHandlersSetup\?\.then\(\(lifecycle\) => lifecycle\.shutdown\(\)\)/)
})
