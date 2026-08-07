import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openPinnedAgentExecutable, type AgentOwnedProcess } from './agent-owned-process.ts'
import {
  AgentPrivateOllamaDaemonError,
  buildAgentPrivateOllamaLaunch,
  probeAgentPrivateOllamaDaemon,
  startAgentPrivateOllamaDaemon,
} from './agent-ollama-private-daemon.ts'
import type { OpenVerifiedOllamaModel } from './agent-ollama-model-store.ts'

function fakeModel(root: string): OpenVerifiedOllamaModel {
  let closed = false
  return {
    model: 'qwen3.6:27b',
    digest: `sha256:${'a'.repeat(64)}`,
    modelsDir: root,
    manifest: {
      path: join(root, 'manifest'),
      bytes: Buffer.from('{}'),
      identity: {
        path: join(root, 'manifest'), device: '1', inode: '2', uid: 1, gid: 1, mode: 0o600,
        size: 2, nlink: 1, mtimeNs: '1', ctimeNs: '1', sha256: 'a'.repeat(64),
      },
      handle: { fd: 10 } as never,
    },
    blobs: [{
      digest: `sha256:${'b'.repeat(64)}`,
      mediaType: 'application/vnd.ollama.image.model',
      size: 2,
      path: join(root, 'blob'),
      identity: {
        path: join(root, 'blob'), device: '1', inode: '3', uid: 1, gid: 1, mode: 0o600,
        size: 2, nlink: 1, mtimeNs: '1', ctimeNs: '1', sha256: 'b'.repeat(64),
      },
      handle: { fd: 11 } as never,
    }],
    revalidate: async () => { if (closed) throw new Error('closed') },
    close: async () => { closed = true },
  }
}

function fakeOwned(server: Server): AgentOwnedProcess {
  let resolveExit!: (value: { code: number | null, signal: NodeJS.Signals | null }) => void
  const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => { resolveExit = resolve })
  let closed = false
  return {
    pid: 12345,
    get stderr() { return '' },
    exited,
    revalidate: async () => { if (closed) throw new Error('unavailable') },
    close: async () => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => server.close(() => resolve()))
      resolveExit({ code: 0, signal: null })
    },
  }
}

test('private Ollama launch is cloud-disabled and mounts only the alias model graph in its shadow store', async (t) => {
  if (process.platform !== 'linux') return t.skip('bubblewrap plan is Linux-only')
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-plan-'))
  const model = fakeModel(root)
  const plan = buildAgentPrivateOllamaLaunch({
    model,
    alias: 'modly-private-0123456789abcdef:latest',
    port: 43123,
    storeRoot: root,
    ollamaFd: 4,
    manifestFd: 5,
    blobFds: [6],
  })
  assert.deepEqual(plan.args.slice(0, 5), ['--die-with-parent', '--unshare-all', '--unshare-user', '--disable-userns', '--share-net'])
  const hasEnv = (name: string, value: string) => plan.args.some((entry, index) => (
    entry === '--setenv' && plan.args[index + 1] === name && plan.args[index + 2] === value
  ))
  assert.equal(hasEnv('OLLAMA_NO_CLOUD', '1'), true)
  assert.equal(hasEnv('OLLAMA_HOST', '127.0.0.1:43123'), true)
  assert.equal(plan.args.join('\0').includes(join(root, 'manifests/registry.ollama.ai/library/modly-private-0123456789abcdef/latest')), true)
  assert.equal(plan.args.join('\0').includes(join(root, '/blobs/sha256-' + 'b'.repeat(64))), true)
  const maskIndex = plan.args.findIndex((entry, index) => entry === '--tmpfs' && plan.args[index + 1] === root)
  assert.notEqual(maskIndex, -1, 'the canonical store is shadowed before exact FD mounts')
  assert.equal(plan.args.filter((entry) => entry === '--ro-bind-fd').length, 3)
  await rm(root, { recursive: true, force: true })
})

test('private Ollama daemon verifies version and exact alias before forwarding bounded Responses', async (t) => {
  if (process.platform !== 'linux') return t.skip('private Ollama daemon is Linux-only')
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-test-'))
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'fake executable')
  const model = fakeModel(root)
  const originalRevalidate = model.revalidate.bind(model)
  let modelRevalidations = 0
  model.revalidate = async () => { modelRevalidations += 1; await originalRevalidate() }
  const seen: unknown[] = []
  let failResponses = false
  let launchArgs: readonly string[] = []
  let inheritedCount = 0
  const daemon = await startAgentPrivateOllamaDaemon({
    root,
    bwrap: executable,
    ollama: executable,
    model,
    alias: 'modly-private-0123456789abcdef:latest',
    signal: new AbortController().signal,
    readinessMs: 1_000,
    choosePort: () => 43124,
    startProcess: async (input) => {
      launchArgs = input.args
      inheritedCount = input.inheritedHandles?.length ?? 0
      const server = createServer((request, response) => {
        if (request.url === '/api/version') {
          response.end('{"version":"0.32.5"}')
          return
        }
        if (request.url === '/api/tags') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ models: [{ name: 'modly-private-0123456789abcdef:latest', digest: model.digest }] }))
          return
        }
        if (request.url === '/api/show') {
          response.setHeader('content-type', 'application/json')
          response.end('{"details":{"format":"gguf"}}')
          return
        }
        if (request.url === '/v1/responses') {
          if (failResponses) {
            response.statusCode = 503
            response.end('{"error":"unavailable"}')
            return
          }
          let body = ''
          request.setEncoding('utf8')
          request.on('data', (chunk) => { body += chunk })
          request.on('end', () => {
            seen.push(JSON.parse(body))
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ model: 'modly-private-0123456789abcdef:latest', output_text: 'ok' }))
          })
          return
        }
        response.statusCode = 404
        response.end()
      })
      await new Promise<void>((resolve) => server.listen(43124, '127.0.0.1', resolve))
      return fakeOwned(server)
    },
  })
  try {
    assert.equal(launchArgs.some((entry, index) => (
      entry === '--setenv' && launchArgs[index + 1] === 'OLLAMA_NO_CLOUD' && launchArgs[index + 2] === '1'
    )), true)
    assert.equal(inheritedCount, 3, 'Ollama, alias manifest, and exact blob remain inherited authorities')
    const result = await daemon.responses({ model: daemon.alias, input: 'chair' }, new AbortController().signal)
    assert.deepEqual(result, { model: daemon.alias, output_text: 'ok' })
    assert.deepEqual(seen, [{ model: daemon.alias, input: 'chair' }])
    const beforeFailure = modelRevalidations
    failResponses = true
    await assert.rejects(daemon.responses({ model: daemon.alias, input: 'table' }, new AbortController().signal))
    assert.equal(modelRevalidations - beforeFailure, 2, 'model authority is checked before and after a failed request')
    await daemon.revalidate()
  } finally {
    await daemon.close()
    assert.deepEqual(await readdir(root), [])
    await executable.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('private Ollama daemon retries a collided random loopback port without shared-daemon fallback', async (t) => {
  if (process.platform !== 'linux') return t.skip('private Ollama daemon is Linux-only')
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-collision-'))
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'fake executable')
  const model = fakeModel(root)
  const ports = [43126, 43127]
  let launches = 0
  const daemon = await startAgentPrivateOllamaDaemon({
    root,
    bwrap: executable,
    ollama: executable,
    model,
    alias: 'modly-private-0011223344556677:latest',
    signal: new AbortController().signal,
    readinessMs: 500,
    choosePort: () => ports.shift() ?? 43127,
    startProcess: async () => {
      launches += 1
      if (launches === 1) throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' })
      const server = createServer((request, response) => {
        response.setHeader('content-type', 'application/json')
        if (request.url === '/api/version') response.end('{"version":"0.32.5"}')
        else if (request.url === '/api/tags') response.end(JSON.stringify({ models: [{ name: 'modly-private-0011223344556677:latest', digest: model.digest }] }))
        else if (request.url === '/api/show') response.end('{"details":{"format":"gguf"}}')
        else { response.statusCode = 404; response.end('{}') }
      })
      await new Promise<void>((resolve) => server.listen(43127, '127.0.0.1', resolve))
      return fakeOwned(server)
    },
  })
  try {
    assert.equal(launches, 2)
    assert.equal(daemon.endpoint, 'http://127.0.0.1:43127')
  } finally {
    await daemon.close()
    await executable.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('private Ollama daemon fails closed on early non-zero exit', async (t) => {
  if (process.platform !== 'linux') return t.skip('private Ollama daemon is Linux-only')
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-fail-'))
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'fake executable')
  const model = fakeModel(root)
  await assert.rejects(startAgentPrivateOllamaDaemon({
    root,
    bwrap: executable,
    ollama: executable,
    model,
    alias: 'modly-private-fedcba9876543210:latest',
    signal: new AbortController().signal,
    readinessMs: 50,
    choosePort: () => 43125,
    startProcess: async () => ({
      pid: 1, stderr: '', exited: Promise.resolve({ code: 7, signal: null }),
      revalidate: async () => { throw new Error('unavailable') }, close: async () => undefined,
    }),
  }), (error: unknown) => error instanceof AgentPrivateOllamaDaemonError && error.code === 'daemon_unavailable')
  await executable.close()
  await rm(root, { recursive: true, force: true })
})

test('private Ollama daemon bounds readiness and cleans every timed-out attempt', async (t) => {
  if (process.platform !== 'linux') return t.skip('private Ollama daemon is Linux-only')
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-timeout-'))
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'fake executable')
  const model = fakeModel(root)
  let closes = 0
  try {
    await assert.rejects(startAgentPrivateOllamaDaemon({
      root,
      bwrap: executable,
      ollama: executable,
      model,
      alias: 'modly-private-abcdef0123456789:latest',
      signal: new AbortController().signal,
      readinessMs: 25,
      choosePort: () => 43129,
      startProcess: async () => ({
        pid: 12345,
        stderr: '',
        exited: new Promise(() => undefined),
        revalidate: async () => undefined,
        close: async () => { closes += 1 },
      }),
      fetch: async () => { throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }) },
    }), (error: unknown) => error instanceof AgentPrivateOllamaDaemonError && error.code === 'daemon_timeout')
    assert.equal(closes, 3)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await executable.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('private Ollama probe never mistakes a colliding shared endpoint for its owned daemon', async (t) => {
  if (process.platform !== 'linux') return t.skip('private Ollama daemon is Linux-only')
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-decoy-'))
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'fake executable')
  const port = 43128
  const decoy = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/version') response.end('{"version":"0.32.5"}')
    else { response.statusCode = 404; response.end('{}') }
  })
  await new Promise<void>((resolve) => decoy.listen(port, '127.0.0.1', resolve))
  let closes = 0
  try {
    await assert.rejects(probeAgentPrivateOllamaDaemon({
      root,
      bwrap: executable,
      ollama: executable,
      signal: new AbortController().signal,
      readinessMs: 50,
      choosePort: () => port,
      startProcess: async () => ({
        pid: 12345,
        stderr: '',
        exited: Promise.resolve({ code: 98, signal: null }),
        revalidate: async () => { throw new Error('owned process exited') },
        close: async () => { closes += 1 },
      }),
    }), (error: unknown) => error instanceof AgentPrivateOllamaDaemonError)
    assert.equal(closes, 3)
  } finally {
    await new Promise<void>((resolve) => decoy.close(() => resolve()))
    await executable.close()
    await rm(root, { recursive: true, force: true })
  }
})
