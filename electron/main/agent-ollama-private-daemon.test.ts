import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openPinnedAgentExecutable, type AgentOwnedProcess } from './agent-owned-process.ts'
import {
  AGENT_PRIVATE_OLLAMA_MAX_READINESS_ATTEMPTS,
  AgentPrivateOllamaDaemonError,
  _testOnlyWaitForAgentPrivateOllamaReadiness,
  buildAgentPrivateOllamaLaunch,
  normalizeAgentOllamaDigest,
  probeAgentPrivateOllamaDaemon,
  startAgentPrivateOllamaDaemon,
} from './agent-ollama-private-daemon.ts'
import type { OpenAgentOllamaGpuDeviceAuthority } from './agent-ollama-gpu-device-authority.ts'
import type { OpenVerifiedOllamaModel } from './agent-ollama-model-store.ts'
import type { OpenAgentOllamaRuntimeTree } from './agent-ollama-runtime-tree.ts'

let loopbackListenSupport: Promise<boolean> | undefined

function listenOnLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('listening', onListening)
      server.off('error', onError)
    }
    const onListening = () => { cleanup(); resolve() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    server.once('listening', onListening)
    server.once('error', onError)
    try {
      server.listen(port, '127.0.0.1')
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

function closeListeningServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

async function probeLoopbackListenSupport(): Promise<boolean> {
  const server = createServer()
  try {
    await listenOnLoopback(server, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') return false
    throw error
  } finally {
    await closeListeningServer(server)
  }
}

function canListenOnLoopback(): Promise<boolean> {
  return loopbackListenSupport ??= probeLoopbackListenSupport()
}

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

function fakeRuntime(root: string): OpenAgentOllamaRuntimeTree {
  let closed = false
  return {
    path: `${root}-ollama-runtime`,
    handle: { fd: 12 } as never,
    identity: { entryCount: 1 } as never,
    revalidate: async () => { if (closed) throw new Error('closed') },
    close: async () => { closed = true },
  }
}

function fakeAccelerator(mode: 'cpu' | 'nvidia' = 'cpu'): OpenAgentOllamaGpuDeviceAuthority {
  let closed = false
  return {
    mode,
    devicePaths: mode === 'nvidia'
      ? ['/dev/nvidiactl', '/dev/nvidia0', '/dev/nvidia2', '/dev/nvidia-uvm']
      : [],
    sysfsPaths: mode === 'nvidia'
      ? ['/sys/module/nvidia/initstate', '/sys/module/nvidia_uvm/initstate']
      : [],
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
    accelerator: fakeAccelerator('nvidia'),
    alias: 'modly-private-0123456789abcdef:latest',
    port: 43123,
    storeRoot: root,
    runtimeSourceRoot: '/usr/local/lib/ollama',
    ollamaFd: 4,
    runtimeDirFd: 5,
    manifestFd: 6,
    blobFds: [7],
  })
  assert.deepEqual(plan.args.slice(0, 5), ['--die-with-parent', '--unshare-all', '--unshare-user', '--disable-userns', '--share-net'])
  const hasEnv = (name: string, value: string) => plan.args.some((entry, index) => (
    entry === '--setenv' && plan.args[index + 1] === name && plan.args[index + 2] === value
  ))
  assert.equal(hasEnv('OLLAMA_NO_CLOUD', '1'), true)
  assert.equal(hasEnv('OLLAMA_HOST', '127.0.0.1:43123'), true)
  assert.equal(plan.args.join('\0').includes(join(root, 'manifests/registry.ollama.ai/library/modly-private-0123456789abcdef/latest')), true)
  assert.equal(plan.args.join('\0').includes(join(root, '/blobs/sha256-' + 'b'.repeat(64))), true)
  const maskIndex = plan.args.findIndex((entry, index) => entry === '--tmpfs' && plan.args[index + 1] === '/tmp')
  const runtimeSourceMaskIndex = plan.args.findIndex((entry, index) => (
    entry === '--tmpfs' && plan.args[index + 1] === '/usr/local/lib/ollama'
  ))
  const storeIndex = plan.args.findIndex((entry, index) => entry === '--dir' && plan.args[index + 1] === root)
  const firstStoreBind = plan.args.findIndex((entry, index) => entry === '--ro-bind-fd'
    && plan.args[index + 2]?.startsWith(`${root}/`))
  assert.equal(maskIndex < storeIndex && storeIndex < firstStoreBind, true, 'the canonical store is privately shadowed before exact FD mounts')
  assert.equal(runtimeSourceMaskIndex > plan.args.indexOf('--ro-bind'), true)
  assert.equal(runtimeSourceMaskIndex < plan.args.findIndex((entry, index) => (
    entry === '--ro-bind-fd' && plan.args[index + 1] === '5'
  )), true, 'the canonical runner tree is hidden before its exact directory FD mount')
  assert.equal(plan.args.filter((entry) => entry === '--ro-bind-fd').length, 4)
  const rootBindIndex = plan.args.findIndex((entry, index) => (
    entry === '--ro-bind' && plan.args[index + 1] === '/' && plan.args[index + 2] === '/'
  ))
  const procIndex = plan.args.findIndex((entry, index) => entry === '--proc' && plan.args[index + 1] === '/proc')
  const devIndex = plan.args.findIndex((entry, index) => entry === '--dev' && plan.args[index + 1] === '/dev')
  const sysIndex = plan.args.findIndex((entry, index) => entry === '--tmpfs' && plan.args[index + 1] === '/sys')
  assert.equal(rootBindIndex < procIndex && procIndex < devIndex && devIndex < sysIndex, true)
  const exactPairs = (flag: string) => plan.args.flatMap((entry, index) => entry === flag
    ? [[plan.args[index + 1], plan.args[index + 2]]]
    : [])
  assert.deepEqual(exactPairs('--dev-bind'), [
    ['/dev/nvidiactl', '/dev/nvidiactl'],
    ['/dev/nvidia0', '/dev/nvidia0'],
    ['/dev/nvidia2', '/dev/nvidia2'],
    ['/dev/nvidia-uvm', '/dev/nvidia-uvm'],
  ])
  assert.deepEqual(exactPairs('--ro-bind').filter(([source]) => source?.startsWith('/sys/')), [
    ['/sys/module/nvidia/initstate', '/sys/module/nvidia/initstate'],
    ['/sys/module/nvidia_uvm/initstate', '/sys/module/nvidia_uvm/initstate'],
  ])
  assert.equal(plan.args.includes('/dev/nvidia-modeset'), false)
  assert.equal(plan.args.includes('/dev/dri'), false)
  await rm(root, { recursive: true, force: true })
})

test('private Ollama launch creates runtime and nested store paths only below writable private mounts', async (t) => {
  if (process.platform !== 'linux') return t.skip('bubblewrap plan is Linux-only')
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-topology-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const plan = buildAgentPrivateOllamaLaunch({
    model: fakeModel(root),
    accelerator: fakeAccelerator(),
    alias: 'modly-private-0123456789abcdef:latest',
    port: 43123,
    storeRoot: root,
    runtimeSourceRoot: '/usr/local/lib/ollama',
    ollamaFd: 4,
    runtimeDirFd: 5,
    manifestFd: 6,
    blobFds: [7],
  })
  const optionIndex = (flag: string, value: string) => plan.args.findIndex((entry, index) => (
    entry === flag && plan.args[index + 1] === value
  ))
  const privateRunIndex = optionIndex('--tmpfs', '/run')
  const runtimeRoot = '/run/modly-ollama-runtime'
  const runtimeRootIndex = optionIndex('--dir', runtimeRoot)
  const runtimeBinIndex = optionIndex('--dir', join(runtimeRoot, 'bin'))
  const ollamaBindIndex = optionIndex('--ro-bind-fd', '4')
  assert.notEqual(privateRunIndex, -1)
  assert.equal(privateRunIndex < runtimeRootIndex && runtimeRootIndex < runtimeBinIndex, true)
  assert.equal(runtimeBinIndex < ollamaBindIndex, true)
  assert.equal(plan.args[ollamaBindIndex + 2], join(runtimeRoot, 'bin', 'ollama'))
  const runnerTreeBindIndex = optionIndex('--ro-bind-fd', '5')
  assert.equal(runtimeBinIndex < runnerTreeBindIndex, true)
  assert.equal(plan.args[runnerTreeBindIndex + 2], join(runtimeRoot, 'lib', 'ollama'))
  assert.deepEqual(plan.args.slice(-4), ['--chdir', '/', join(runtimeRoot, 'bin', 'ollama'), 'serve'])
  assert.equal(plan.args.includes('/runtime'), false)
  assert.equal(plan.args.includes('--dev-bind'), false)
  assert.equal(plan.args.some((entry, index) => entry === '--ro-bind'
    && (plan.args[index + 1] === '/dev' || plan.args[index + 1] === '/sys')), false)
  const cpuRootIndex = optionIndex('--ro-bind', '/')
  const cpuProcIndex = optionIndex('--proc', '/proc')
  const cpuDevIndex = optionIndex('--dev', '/dev')
  const cpuSysIndex = optionIndex('--tmpfs', '/sys')
  assert.equal(cpuRootIndex < cpuProcIndex && cpuProcIndex < cpuDevIndex && cpuDevIndex < cpuSysIndex, true)

  const privateTmpIndex = optionIndex('--tmpfs', '/tmp')
  const storeRootIndex = optionIndex('--dir', root)
  assert.equal(privateTmpIndex < storeRootIndex, true)
  assert.equal(optionIndex('--tmpfs', root), -1, 'a parent private tmpfs must not hide an earlier nested store mount')

  assert.throws(() => buildAgentPrivateOllamaLaunch({
    model: fakeModel('/'),
    accelerator: fakeAccelerator(),
    alias: 'modly-private-0123456789abcdef:latest',
    port: 43123,
    storeRoot: '/',
    runtimeSourceRoot: '/usr/local/lib/ollama',
    ollamaFd: 4,
    runtimeDirFd: 5,
    manifestFd: 6,
    blobFds: [7],
  }), (error: unknown) => error instanceof AgentPrivateOllamaDaemonError && error.code === 'invalid_binding')
  assert.throws(() => buildAgentPrivateOllamaLaunch({
    model: fakeModel(root),
    accelerator: fakeAccelerator(),
    alias: 'modly-private-0123456789abcdef:latest',
    port: 43123,
    storeRoot: root,
    runtimeSourceRoot: join(root, 'runtime'),
    ollamaFd: 4,
    runtimeDirFd: 5,
    manifestFd: 6,
    blobFds: [7],
  }), (error: unknown) => error instanceof AgentPrivateOllamaDaemonError && error.code === 'invalid_binding')
})

test('Ollama readiness digest normalization accepts only exact lowercase SHA-256 forms', () => {
  const raw = 'a'.repeat(64)
  assert.equal(normalizeAgentOllamaDigest(raw), `sha256:${raw}`)
  assert.equal(normalizeAgentOllamaDigest(`sha256:${raw}`), `sha256:${raw}`)
  for (const rejected of [raw.toUpperCase(), `sha256:${raw.toUpperCase()}`, `sha512:${raw}`, ` ${raw}`, `${raw} `, 'a'.repeat(63)]) {
    assert.equal(normalizeAgentOllamaDigest(rejected), undefined)
  }
})

test('private Ollama daemon verifies version and exact alias before forwarding bounded Responses', async (t) => {
  if (process.platform !== 'linux') return t.skip('private Ollama daemon is Linux-only')
  if (!await canListenOnLoopback()) return t.skip('IPv4 loopback listen is unavailable in this test environment')
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-test-'))
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'fake executable')
  const model = fakeModel(root)
  const runtime = fakeRuntime(root)
  const accelerator = fakeAccelerator('nvidia')
  const originalRevalidate = model.revalidate.bind(model)
  const originalRuntimeRevalidate = runtime.revalidate.bind(runtime)
  const originalAcceleratorRevalidate = accelerator.revalidate.bind(accelerator)
  let modelRevalidations = 0
  let runtimeRevalidations = 0
  let acceleratorRevalidations = 0
  model.revalidate = async () => { modelRevalidations += 1; await originalRevalidate() }
  runtime.revalidate = async () => { runtimeRevalidations += 1; await originalRuntimeRevalidate() }
  accelerator.revalidate = async () => { acceleratorRevalidations += 1; await originalAcceleratorRevalidate() }
  const seen: unknown[] = []
  let failResponses = false
  let launchArgs: readonly string[] = []
  let inheritedCount = 0
  let readinessRequests = 0
  const showBodies: unknown[] = []
  const daemon = await startAgentPrivateOllamaDaemon({
    root,
    bwrap: executable,
    ollama: executable,
    runtime,
    accelerator,
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
          readinessRequests += 1
          response.end('{"version":"0.32.5"}')
          return
        }
        if (request.url === '/api/tags') {
          readinessRequests += 1
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ models: [{ name: 'modly-private-0123456789abcdef:latest', digest: model.digest.slice('sha256:'.length) }] }))
          return
        }
        if (request.url === '/api/show') {
          readinessRequests += 1
          let body = ''
          request.setEncoding('utf8')
          request.on('data', (chunk) => { body += chunk })
          request.on('end', () => {
            showBodies.push(JSON.parse(body))
            response.setHeader('content-type', 'application/json')
            response.end('{"details":{"format":"gguf"}}')
          })
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
      await listenOnLoopback(server, 43124)
      return fakeOwned(server)
    },
  })
  try {
    assert.equal(launchArgs.some((entry, index) => (
      entry === '--setenv' && launchArgs[index + 1] === 'OLLAMA_NO_CLOUD' && launchArgs[index + 2] === '1'
    )), true)
    assert.equal(inheritedCount, 4, 'Ollama, runner tree, alias manifest, and exact blob remain inherited authorities')
    assert.equal(runtimeRevalidations >= 3, true, 'runner tree is checked before launch and after readiness')
    assert.equal(acceleratorRevalidations >= 3, true, 'device authority is checked before launch and after readiness')
    assert.equal(readinessRequests, 3, 'one successful readiness pass must issue only version, tags, and show')
    assert.deepEqual(showBodies, [{ model: daemon.alias, verbose: false }])
    const result = await daemon.responses({ model: daemon.alias, input: 'chair' }, new AbortController().signal)
    assert.deepEqual(result, { model: daemon.alias, output_text: 'ok' })
    assert.deepEqual(seen, [{ model: daemon.alias, input: 'chair' }])
    const beforeFailure = modelRevalidations
    const runtimeBeforeFailure = runtimeRevalidations
    const acceleratorBeforeFailure = acceleratorRevalidations
    failResponses = true
    await assert.rejects(daemon.responses({ model: daemon.alias, input: 'table' }, new AbortController().signal))
    assert.equal(modelRevalidations - beforeFailure, 2, 'model authority is checked before and after a failed request')
    assert.equal(runtimeRevalidations - runtimeBeforeFailure, 2, 'runner tree is checked before and after a failed request')
    assert.equal(acceleratorRevalidations - acceleratorBeforeFailure, 2, 'device authority is checked before and after a failed request')
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
  if (!await canListenOnLoopback()) return t.skip('IPv4 loopback listen is unavailable in this test environment')
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-collision-'))
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'fake executable')
  const model = fakeModel(root)
  const ports = [43126, 43127]
  let launches = 0
  const daemon = await startAgentPrivateOllamaDaemon({
    root,
    bwrap: executable,
    ollama: executable,
    runtime: fakeRuntime(root),
    accelerator: fakeAccelerator(),
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
      await listenOnLoopback(server, 43127)
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
    runtime: fakeRuntime(root),
    accelerator: fakeAccelerator(),
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

test('private Ollama readiness exhausts the production attempt cap under a deterministic backoff clock', async () => {
  const readinessMs = 1_000_000
  const delays: number[] = []
  let now = 0
  let requests = 0
  let revalidations = 0
  const owned: AgentOwnedProcess = {
    pid: 12345,
    stderr: '',
    exited: new Promise(() => undefined),
    revalidate: async () => { revalidations += 1 },
    close: async () => undefined,
  }

  await assert.rejects(_testOnlyWaitForAgentPrivateOllamaReadiness({
    process: owned,
    endpoint: 'http://127.0.0.1:43129',
    readinessMs,
    signal: new AbortController().signal,
    fetchImpl: async (input) => {
      requests += 1
      assert.equal(String(input), 'http://127.0.0.1:43129/api/version')
      return new Response('{}', { status: 200 })
    },
  }, {
    now: () => now,
    delay: async (milliseconds, signal) => {
      assert.equal(signal?.aborted, false)
      delays.push(milliseconds)
      now += milliseconds
    },
  }), (error: unknown) => error instanceof AgentPrivateOllamaDaemonError && error.code === 'daemon_timeout')

  assert.equal(requests, AGENT_PRIVATE_OLLAMA_MAX_READINESS_ATTEMPTS)
  assert.equal(delays.length, AGENT_PRIVATE_OLLAMA_MAX_READINESS_ATTEMPTS)
  assert.deepEqual(delays.slice(0, 5), [50, 100, 200, 400, 500])
  assert.equal(delays.slice(5).every((milliseconds) => milliseconds === 500), true)
  assert.equal(now, delays.reduce((total, milliseconds) => total + milliseconds, 0))
  assert.equal(now < readinessMs, true, 'the attempt cap, not the synthetic deadline, must terminate readiness')
  assert.equal(revalidations, 0)
})

test('private Ollama daemon bounds readiness and cleans every timed-out attempt', async (t) => {
  if (process.platform !== 'linux') return t.skip('private Ollama daemon is Linux-only')
  const requestsPerRejectedReadinessAttempt = 2
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-timeout-'))
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'fake executable')
  const model = fakeModel(root)
  let closes = 0
  let requests = 0
  try {
    await assert.rejects(startAgentPrivateOllamaDaemon({
      root,
      bwrap: executable,
      ollama: executable,
      runtime: fakeRuntime(root),
      accelerator: fakeAccelerator(),
      model,
      alias: 'modly-private-abcdef0123456789:latest',
      signal: new AbortController().signal,
      readinessMs: 250,
      choosePort: () => 43129,
      startProcess: async () => ({
        pid: 12345,
        stderr: '',
        exited: new Promise(() => undefined),
        revalidate: async () => undefined,
        close: async () => { closes += 1 },
      }),
      fetch: async (input) => {
        requests += 1
        const url = String(input)
        if (url.endsWith('/api/version')) return new Response('{"version":"0.32.5"}', { status: 200 })
        if (url.endsWith('/api/tags')) {
          return new Response(JSON.stringify({
            models: [{ name: 'modly-private-abcdef0123456789:latest', digest: model.digest.toUpperCase() }],
          }), { status: 200 })
        }
        throw new Error('unexpected readiness request')
      },
    }), (error: unknown) => error instanceof AgentPrivateOllamaDaemonError && error.code === 'daemon_timeout')
    assert.equal(closes, 3)
    assert.equal(requests > 0, true)
    assert.equal(requests % requestsPerRejectedReadinessAttempt, 0)
    t.diagnostic(`deadline-bounded readiness requests=${requests}`)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await executable.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('private Ollama probe never mistakes a colliding shared endpoint for its owned daemon', async (t) => {
  if (process.platform !== 'linux') return t.skip('private Ollama daemon is Linux-only')
  if (!await canListenOnLoopback()) return t.skip('IPv4 loopback listen is unavailable in this test environment')
  const root = await mkdtemp(join(tmpdir(), 'modly-private-ollama-decoy-'))
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'fake executable')
  const port = 43128
  const decoy = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/version') response.end('{"version":"0.32.5"}')
    else { response.statusCode = 404; response.end('{}') }
  })
  await listenOnLoopback(decoy, port)
  let closes = 0
  let probeArgs: readonly string[] = []
  try {
    await assert.rejects(probeAgentPrivateOllamaDaemon({
      root,
      bwrap: executable,
      ollama: executable,
      runtime: fakeRuntime(root),
      accelerator: fakeAccelerator('nvidia'),
      signal: new AbortController().signal,
      readinessMs: 50,
      choosePort: () => port,
      startProcess: async (input) => {
        probeArgs = input.args
        return {
          pid: 12345,
          stderr: '',
          exited: Promise.resolve({ code: 98, signal: null }),
          revalidate: async () => { throw new Error('owned process exited') },
          close: async () => { closes += 1 },
        }
      },
    }), (error: unknown) => error instanceof AgentPrivateOllamaDaemonError)
    assert.equal(closes, 3)
    const privateRunIndex = probeArgs.findIndex((entry, index) => entry === '--tmpfs' && probeArgs[index + 1] === '/run')
    const runtimeIndex = probeArgs.findIndex((entry, index) => entry === '--dir' && probeArgs[index + 1] === '/run/modly-ollama-runtime')
    const binaryIndex = probeArgs.findIndex((entry, index) => entry === '--ro-bind-fd'
      && probeArgs[index + 2] === '/run/modly-ollama-runtime/bin/ollama')
    const runnerTreeIndex = probeArgs.findIndex((entry, index) => entry === '--ro-bind-fd'
      && probeArgs[index + 2] === '/run/modly-ollama-runtime/lib/ollama')
    assert.equal(privateRunIndex < runtimeIndex && runtimeIndex < binaryIndex && binaryIndex < runnerTreeIndex, true)
    assert.deepEqual(probeArgs.flatMap((entry, index) => entry === '--dev-bind'
      ? [[probeArgs[index + 1], probeArgs[index + 2]]]
      : []), [
      ['/dev/nvidiactl', '/dev/nvidiactl'],
      ['/dev/nvidia0', '/dev/nvidia0'],
      ['/dev/nvidia2', '/dev/nvidia2'],
      ['/dev/nvidia-uvm', '/dev/nvidia-uvm'],
    ])
    assert.equal(probeArgs.some((entry, index) => entry === '--proc' && probeArgs[index + 1] === '/proc'), true)
    assert.equal(probeArgs.some((entry, index) => entry === '--dev' && probeArgs[index + 1] === '/dev'), true)
  } finally {
    await closeListeningServer(decoy)
    await executable.close()
    await rm(root, { recursive: true, force: true })
  }
})
