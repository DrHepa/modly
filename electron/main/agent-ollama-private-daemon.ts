import { randomInt } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import type { JsonValue } from '../../src/shared/types/agentActions.ts'
import {
  startAgentOwnedProcess,
  type AgentOwnedProcess,
  type PinnedAgentExecutable,
  type StartAgentOwnedProcessOptions,
} from './agent-owned-process.ts'
import type { OpenAgentOllamaGpuDeviceAuthority } from './agent-ollama-gpu-device-authority.ts'
import type { OpenVerifiedOllamaModel } from './agent-ollama-model-store.ts'
import type { OpenAgentOllamaRuntimeTree } from './agent-ollama-runtime-tree.ts'

const PRIVATE_ALIAS = /^modly-private-[a-f0-9]{16,64}:latest$/
const DEFAULT_READINESS_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_READINESS_BYTES = 1024 * 1024
const MAX_READINESS_ATTEMPTS = 64
const RAW_SHA256 = /^[a-f0-9]{64}$/
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/
const PRIVATE_RUNTIME_ROOT = '/run/modly-ollama-runtime'
const PRIVATE_OLLAMA_PATH = '/run/modly-ollama-runtime/bin/ollama'
const PRIVATE_RUNTIME_TREE_PATH = '/run/modly-ollama-runtime/lib/ollama'
const PRIVATE_TMPFS_ROOTS = ['/tmp', '/run', '/home'] as const

export interface AgentPrivateOllamaLaunch {
  args: readonly string[]
  env: Readonly<Record<string, string>>
}

export interface BuildAgentPrivateOllamaLaunchOptions {
  model: OpenVerifiedOllamaModel
  accelerator: OpenAgentOllamaGpuDeviceAuthority
  alias: string
  port: number
  storeRoot: string
  runtimeSourceRoot: string
  ollamaFd: number
  runtimeDirFd: number
  manifestFd: number
  blobFds: readonly number[]
}

export interface AgentPrivateOllamaDaemon {
  readonly alias: string
  readonly endpoint: string
  responses(body: Readonly<Record<string, JsonValue>>, signal: AbortSignal): Promise<unknown>
  revalidate(): Promise<void>
  close(): Promise<void>
}

export interface StartAgentPrivateOllamaDaemonOptions {
  root: string
  bwrap: PinnedAgentExecutable
  ollama: PinnedAgentExecutable
  runtime: OpenAgentOllamaRuntimeTree
  accelerator: OpenAgentOllamaGpuDeviceAuthority
  model: OpenVerifiedOllamaModel
  alias: string
  signal: AbortSignal
  readinessMs?: number
  maxResponseBytes?: number
  choosePort?: () => number
  startProcess?: (options: StartAgentOwnedProcessOptions) => Promise<AgentOwnedProcess>
  fetch?: typeof globalThis.fetch
}

export interface ProbeAgentPrivateOllamaDaemonOptions {
  root: string
  bwrap: PinnedAgentExecutable
  ollama: PinnedAgentExecutable
  runtime: OpenAgentOllamaRuntimeTree
  accelerator: OpenAgentOllamaGpuDeviceAuthority
  signal: AbortSignal
  readinessMs?: number
  choosePort?: () => number
  startProcess?: (options: StartAgentOwnedProcessOptions) => Promise<AgentOwnedProcess>
  fetch?: typeof globalThis.fetch
}

export class AgentPrivateOllamaDaemonError extends Error {
  readonly code: 'invalid_binding' | 'daemon_unavailable' | 'daemon_timeout' | 'response_invalid' | 'response_too_large'

  constructor(code: AgentPrivateOllamaDaemonError['code'], cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'AgentPrivateOllamaDaemonError'
    this.code = code
  }
}

export function normalizeAgentOllamaDigest(value: unknown): `sha256:${string}` | undefined {
  if (typeof value !== 'string') return undefined
  if (RAW_SHA256.test(value)) return `sha256:${value}`
  if (PREFIXED_SHA256.test(value)) return value as `sha256:${string}`
  return undefined
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AgentPrivateOllamaDaemonError('invalid_binding')
  }
  return value
}

function normalizePort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 20_000 || value > 60_999) {
    throw new AgentPrivateOllamaDaemonError('invalid_binding')
  }
  return value
}

function appendPrivateEnvironment(args: string[], port: number): void {
  args.push(
    '--clearenv',
    '--setenv', 'HOME', '/home/modly',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'LC_ALL', 'C.UTF-8',
    '--setenv', 'OLLAMA_HOST', `127.0.0.1:${port}`,
    '--setenv', 'OLLAMA_NO_CLOUD', '1',
    '--setenv', 'OLLAMA_KEEP_ALIVE', '0',
    '--setenv', 'OLLAMA_MAX_LOADED_MODELS', '1',
    '--setenv', 'OLLAMA_NUM_PARALLEL', '1',
    '--setenv', 'OLLAMA_NOPRUNE', '1',
    '--setenv', 'HTTP_PROXY', 'http://127.0.0.1:9',
    '--setenv', 'HTTPS_PROXY', 'http://127.0.0.1:9',
    '--setenv', 'ALL_PROXY', 'http://127.0.0.1:9',
    '--setenv', 'NO_PROXY', '127.0.0.1,localhost',
  )
}

function appendDirectory(args: string[], path: string): void {
  if (!args.some((entry, index) => entry === '--dir' && args[index + 1] === path)) {
    args.push('--dir', path)
  }
}

function appendPrivateStoreRoot(args: string[], storeRoot: string): void {
  const privateParent = PRIVATE_TMPFS_ROOTS.find((root) => storeRoot === root || storeRoot.startsWith(`${root}/`))
  if (!privateParent) {
    args.push('--tmpfs', storeRoot)
    return
  }
  let current: string = privateParent
  for (const segment of storeRoot.slice(privateParent.length).split('/').filter(Boolean)) {
    current = join(current, segment)
    appendDirectory(args, current)
  }
}

function pathContains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root === '/' ? '/' : `${root}/`)
}

function validAcceleratorBinding(accelerator: OpenAgentOllamaGpuDeviceAuthority): boolean {
  if (!accelerator || typeof accelerator !== 'object' || !Array.isArray(accelerator.devicePaths)
    || !Array.isArray(accelerator.sysfsPaths)) return false
  if (accelerator.mode === 'cpu') return accelerator.devicePaths.length === 0 && accelerator.sysfsPaths.length === 0
  if (accelerator.mode !== 'nvidia' || accelerator.devicePaths.length < 3 || accelerator.devicePaths.length > 34
    || accelerator.devicePaths[0] !== '/dev/nvidiactl'
    || accelerator.devicePaths.at(-1) !== '/dev/nvidia-uvm'
    || accelerator.sysfsPaths.length !== 2
    || accelerator.sysfsPaths[0] !== '/sys/module/nvidia/initstate'
    || accelerator.sysfsPaths[1] !== '/sys/module/nvidia_uvm/initstate') return false
  let previous = -1
  for (const path of accelerator.devicePaths.slice(1, -1)) {
    const match = /^\/dev\/nvidia(0|[1-9][0-9]*)$/.exec(path)
    const index = match ? Number(match[1]) : Number.NaN
    if (!Number.isSafeInteger(index) || index < 0 || index > 254 || index <= previous) return false
    previous = index
  }
  return true
}

function appendPrivateAccelerator(args: string[], accelerator: OpenAgentOllamaGpuDeviceAuthority): void {
  if (!validAcceleratorBinding(accelerator)) throw new AgentPrivateOllamaDaemonError('invalid_binding')
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/sys')
  if (accelerator.mode === 'cpu') return
  for (const path of accelerator.devicePaths) args.push('--dev-bind', path, path)
  appendDirectory(args, '/sys/module')
  appendDirectory(args, '/sys/module/nvidia')
  appendDirectory(args, '/sys/module/nvidia_uvm')
  for (const path of accelerator.sysfsPaths) args.push('--ro-bind', path, path)
}

function basePrivateLaunch(
  port: number,
  storeRoot: string,
  runtimeSourceRoot: string,
  accelerator: OpenAgentOllamaGpuDeviceAuthority,
): string[] {
  if (!isAbsolute(storeRoot) || resolve(storeRoot) !== storeRoot
    || !isAbsolute(runtimeSourceRoot) || resolve(runtimeSourceRoot) !== runtimeSourceRoot
    || runtimeSourceRoot === '/'
    || pathContains(storeRoot, runtimeSourceRoot) || pathContains(runtimeSourceRoot, storeRoot)
    || pathContains(storeRoot, PRIVATE_RUNTIME_ROOT) || pathContains(PRIVATE_RUNTIME_ROOT, storeRoot)) {
    throw new AgentPrivateOllamaDaemonError('invalid_binding')
  }
  const args = [
    '--die-with-parent',
    '--unshare-all',
    '--unshare-user',
    '--disable-userns',
    '--share-net',
    '--hostname', 'modly-ollama',
    '--ro-bind', '/', '/',
  ]
  appendPrivateAccelerator(args, accelerator)
  if (!PRIVATE_TMPFS_ROOTS.some((root) => pathContains(root, runtimeSourceRoot))) {
    args.push('--tmpfs', runtimeSourceRoot)
  }
  args.push('--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/home', '--dir', '/home/modly')
  appendDirectory(args, PRIVATE_RUNTIME_ROOT)
  appendDirectory(args, join(PRIVATE_RUNTIME_ROOT, 'bin'))
  appendDirectory(args, join(PRIVATE_RUNTIME_ROOT, 'lib'))
  appendDirectory(args, PRIVATE_RUNTIME_TREE_PATH)
  appendPrivateStoreRoot(args, storeRoot)
  appendDirectory(args, join(storeRoot, 'blobs'))
  appendDirectory(args, join(storeRoot, 'manifests'))
  appendDirectory(args, join(storeRoot, 'manifests', 'registry.ollama.ai'))
  appendDirectory(args, join(storeRoot, 'manifests', 'registry.ollama.ai', 'library'))
  appendPrivateEnvironment(args, port)
  args.push('--setenv', 'OLLAMA_MODELS', storeRoot)
  return args
}

export function buildAgentPrivateOllamaLaunch(options: BuildAgentPrivateOllamaLaunchOptions): Readonly<AgentPrivateOllamaLaunch> {
  const port = normalizePort(options.port)
  if (!PRIVATE_ALIAS.test(options.alias) || options.blobFds.length !== options.model.blobs.length
    || !Number.isSafeInteger(options.ollamaFd) || options.ollamaFd < 3
    || !Number.isSafeInteger(options.runtimeDirFd) || options.runtimeDirFd <= options.ollamaFd
    || !Number.isSafeInteger(options.manifestFd) || options.manifestFd <= options.runtimeDirFd
    || options.blobFds.some((fd) => !Number.isSafeInteger(fd) || fd <= options.manifestFd)
    || options.storeRoot !== options.model.modelsDir) {
    throw new AgentPrivateOllamaDaemonError('invalid_binding')
  }
  const aliasName = options.alias.slice(0, -':latest'.length)
  const args = basePrivateLaunch(port, options.storeRoot, options.runtimeSourceRoot, options.accelerator)
  args.push(
    '--dir', join(options.storeRoot, 'manifests', 'registry.ollama.ai', 'library', aliasName),
    '--ro-bind-fd', String(options.ollamaFd), PRIVATE_OLLAMA_PATH,
    '--ro-bind-fd', String(options.runtimeDirFd), PRIVATE_RUNTIME_TREE_PATH,
    '--ro-bind-fd', String(options.manifestFd), join(options.storeRoot, 'manifests', 'registry.ollama.ai', 'library', aliasName, 'latest'),
  )
  options.model.blobs.forEach((blob, index) => {
    args.push('--ro-bind-fd', String(options.blobFds[index]), join(options.storeRoot, 'blobs', blob.digest.replace(':', '-')))
  })
  args.push('--chdir', '/', PRIVATE_OLLAMA_PATH, 'serve')
  return Object.freeze({
    args: Object.freeze(args),
    env: Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }),
  })
}

function buildProbeLaunch(
  port: number,
  ollamaFd: number,
  runtimeDirFd: number,
  storeRoot: string,
  runtimeSourceRoot: string,
  accelerator: OpenAgentOllamaGpuDeviceAuthority,
): Readonly<AgentPrivateOllamaLaunch> {
  const args = basePrivateLaunch(normalizePort(port), storeRoot, runtimeSourceRoot, accelerator)
  args.push(
    '--ro-bind-fd', String(ollamaFd), PRIVATE_OLLAMA_PATH,
    '--ro-bind-fd', String(runtimeDirFd), PRIVATE_RUNTIME_TREE_PATH,
    '--chdir', '/', PRIVATE_OLLAMA_PATH, 'serve',
  )
  return Object.freeze({ args: Object.freeze(args), env: Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }) })
}

async function canonicalPrivateRoot(root: string): Promise<string> {
  try {
    const [canonical, info] = await Promise.all([realpath(root), lstat(root)])
    if (canonical !== resolve(root) || info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error('unsafe root')
    }
    return canonical
  } catch (error) {
    throw new AgentPrivateOllamaDaemonError('invalid_binding', error)
  }
}

async function boundedResponse(response: Response, maximum: number): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new AgentPrivateOllamaDaemonError('response_too_large')
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      size += chunk.length
      if (size > maximum) {
        await reader.cancel().catch(() => undefined)
        throw new AgentPrivateOllamaDaemonError('response_too_large')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  endpoint: string,
  path: string,
  init: RequestInit,
  maximum: number,
): Promise<unknown> {
  const response = await fetchImpl(`${endpoint}${path}`, { ...init, redirect: 'error' })
  if (response.status !== 200) throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
  const bytes = await boundedResponse(response, maximum)
  try { return JSON.parse(bytes.toString('utf8')) } catch (error) {
    throw new AgentPrivateOllamaDaemonError('response_invalid', error)
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) return rejectDelay(signal.reason)
    const finish = () => {
      signal?.removeEventListener('abort', abort)
      resolveDelay()
    }
    const timer = setTimeout(finish, ms)
    timer.unref()
    const abort = () => { clearTimeout(timer); rejectDelay(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function waitForReadiness(input: {
  process: AgentOwnedProcess
  endpoint: string
  alias?: string
  digest?: string
  readinessMs: number
  signal: AbortSignal
  fetchImpl: typeof globalThis.fetch
}): Promise<void> {
  const approvedDigest = input.alias === undefined ? undefined : normalizeAgentOllamaDigest(input.digest)
  if (input.alias !== undefined && (!approvedDigest || approvedDigest !== input.digest)) {
    throw new AgentPrivateOllamaDaemonError('invalid_binding')
  }
  const deadline = Date.now() + input.readinessMs
  let attempts = 0
  let backoffMs = 50
  let exited: { code: number | null, signal: NodeJS.Signals | null } | undefined
  void input.process.exited.then((value) => { exited = value })
  while (Date.now() < deadline && attempts < MAX_READINESS_ATTEMPTS && !input.signal.aborted) {
    attempts += 1
    if (exited) throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
    const attempt = new AbortController()
    const timeout = setTimeout(() => attempt.abort(), Math.min(500, Math.max(1, deadline - Date.now())))
    timeout.unref()
    try {
      const version = await fetchJson(input.fetchImpl, input.endpoint, '/api/version', { signal: attempt.signal }, MAX_READINESS_BYTES)
      if (!version || typeof version !== 'object' || Array.isArray(version)
        || typeof (version as { version?: unknown }).version !== 'string'
        || (version as { version: string }).version.length < 1 || (version as { version: string }).version.length > 128) {
        throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
      }
      if (input.alias) {
        const tags = await fetchJson(input.fetchImpl, input.endpoint, '/api/tags', { signal: attempt.signal }, MAX_READINESS_BYTES)
        const models = tags && typeof tags === 'object' && !Array.isArray(tags) ? (tags as { models?: unknown }).models : undefined
        if (!Array.isArray(models) || models.length !== 1 || !models.some((candidate) => candidate && typeof candidate === 'object'
          && !Array.isArray(candidate) && ((candidate as { name?: unknown }).name === input.alias
            || (candidate as { model?: unknown }).model === input.alias)
          && normalizeAgentOllamaDigest((candidate as { digest?: unknown }).digest) === approvedDigest)) {
          throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
        }
        const shown = await fetchJson(input.fetchImpl, input.endpoint, '/api/show', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: input.alias, verbose: false }),
          signal: attempt.signal,
        }, MAX_READINESS_BYTES)
        const details = shown && typeof shown === 'object' && !Array.isArray(shown)
          ? (shown as { details?: unknown }).details
          : undefined
        if (!shown || typeof shown !== 'object' || Array.isArray(shown) || Object.hasOwn(shown, 'error')
          || !details || typeof details !== 'object' || Array.isArray(details)) {
          throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
        }
      }
      await input.process.revalidate()
      if (exited) throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
      return
    } catch {
      if (exited) throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
    } finally {
      clearTimeout(timeout)
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) await delay(Math.min(backoffMs, remaining), input.signal).catch(() => undefined)
    backoffMs = Math.min(backoffMs * 2, 500)
  }
  if (input.signal.aborted) throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
  throw new AgentPrivateOllamaDaemonError('daemon_timeout')
}

async function createAliasManifest(root: string, bytes: Buffer): Promise<{
  directory: string
  path: string
  handle: FileHandle
  identity: BigIntStats
}> {
  const directory = await mkdtemp(join(root, 'ollama-daemon-'))
  let handle: FileHandle | undefined
  try {
    await chmod(directory, 0o700)
    const path = join(directory, 'manifest.json')
    await writeFile(path, bytes, { flag: 'wx', mode: 0o400 })
    handle = await open(path, 'r')
    const identity = await handle.stat({ bigint: true })
    if (!identity.isFile() || Number(identity.mode & 0o777n) !== 0o400) throw new Error('invalid alias manifest')
    return { directory, path, handle, identity }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw new AgentPrivateOllamaDaemonError('invalid_binding', error)
  }
}

async function revalidateAliasManifest(
  path: string,
  handle: FileHandle,
  identity: BigIntStats,
): Promise<void> {
  const [byHandle, byPath] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
  if (!byHandle.isFile() || !byPath.isFile() || byPath.isSymbolicLink()
    || byHandle.dev !== identity.dev || byHandle.ino !== identity.ino
    || byPath.dev !== identity.dev || byPath.ino !== identity.ino
    || byHandle.size !== identity.size || byHandle.mtimeNs !== identity.mtimeNs || byHandle.ctimeNs !== identity.ctimeNs
    || Number(byHandle.mode & 0o777n) !== 0o400) {
    throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
  }
}

export async function startAgentPrivateOllamaDaemon(
  options: StartAgentPrivateOllamaDaemonOptions,
): Promise<AgentPrivateOllamaDaemon> {
  if (process.platform !== 'linux' || !PRIVATE_ALIAS.test(options.alias) || options.signal.aborted) {
    throw new AgentPrivateOllamaDaemonError('invalid_binding')
  }
  const root = await canonicalPrivateRoot(options.root)
  const readinessMs = boundedInteger(options.readinessMs, DEFAULT_READINESS_MS, 120_000)
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 16 * 1024 * 1024)
  const choosePort = options.choosePort ?? (() => randomInt(20_000, 61_000))
  let endpoint = ''
  const fetchImpl = options.fetch ?? globalThis.fetch
  const startProcess = options.startProcess ?? startAgentOwnedProcess
  let aliasManifest: Awaited<ReturnType<typeof createAliasManifest>> | undefined
  let owned: AgentOwnedProcess | undefined
  let closePromise: Promise<void> | undefined
  const abort = () => { void close() }
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      options.signal.removeEventListener('abort', abort)
      await owned?.close().catch(() => undefined)
      await aliasManifest?.handle.close().catch(() => undefined)
      if (aliasManifest) await rm(aliasManifest.directory, { recursive: true, force: true }).catch(() => undefined)
    })()
    return closePromise
  }
  try {
    await Promise.all([
      options.bwrap.revalidate(), options.ollama.revalidate(), options.runtime.revalidate(),
      options.accelerator.revalidate(), options.model.revalidate(),
    ])
    aliasManifest = await createAliasManifest(root, options.model.manifest.bytes)
    const ollamaFd = 4
    const runtimeDirFd = 5
    const manifestFd = 6
    const blobFds = options.model.blobs.map((_, index) => 7 + index)
    options.signal.addEventListener('abort', abort, { once: true })
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const port = normalizePort(choosePort())
      const candidateEndpoint = `http://127.0.0.1:${port}`
      const plan = buildAgentPrivateOllamaLaunch({
        model: options.model,
        accelerator: options.accelerator,
        alias: options.alias,
        port,
        storeRoot: options.model.modelsDir,
        runtimeSourceRoot: options.runtime.path,
        ollamaFd,
        runtimeDirFd,
        manifestFd,
        blobFds,
      })
      try {
        await Promise.all([
          options.bwrap.revalidate(),
          options.ollama.revalidate(),
          options.runtime.revalidate(),
          options.accelerator.revalidate(),
          options.model.revalidate(),
          revalidateAliasManifest(aliasManifest.path, aliasManifest.handle, aliasManifest.identity),
        ])
        owned = await startProcess({
          executable: options.bwrap,
          args: plan.args,
          env: plan.env,
          cwd: '/',
          inheritedHandles: [
            options.ollama.handle,
            options.runtime.handle,
            aliasManifest.handle,
            ...options.model.blobs.map((blob) => blob.handle),
          ],
          signal: options.signal,
          stderrBytes: 64 * 1024,
          terminationGraceMs: 500,
          reapTimeoutMs: 5_000,
        })
        await waitForReadiness({
          process: owned,
          endpoint: candidateEndpoint,
          alias: options.alias,
          digest: options.model.digest,
          readinessMs,
          signal: options.signal,
          fetchImpl,
        })
        await Promise.all([
          owned.revalidate(),
          options.runtime.revalidate(),
          options.accelerator.revalidate(),
          options.model.revalidate(),
          revalidateAliasManifest(aliasManifest.path, aliasManifest.handle, aliasManifest.identity),
        ])
        endpoint = candidateEndpoint
        break
      } catch (error) {
        lastError = error
        await owned?.close().catch(() => undefined)
        owned = undefined
        if (options.signal.aborted || error instanceof AgentPrivateOllamaDaemonError && error.code === 'invalid_binding') throw error
      }
    }
    if (!owned || !endpoint) throw lastError ?? new AgentPrivateOllamaDaemonError('daemon_unavailable')
    if (options.signal.aborted) throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
    const daemon: AgentPrivateOllamaDaemon = {
      alias: options.alias,
      endpoint,
      responses: async (body, signal) => {
        if (closePromise || signal.aborted || options.signal.aborted) throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
        await Promise.all([
          options.model.revalidate(),
          options.runtime.revalidate(),
          options.accelerator.revalidate(),
          owned!.revalidate(),
          revalidateAliasManifest(aliasManifest!.path, aliasManifest!.handle, aliasManifest!.identity),
        ])
        let result: unknown
        try {
          result = await fetchJson(fetchImpl, endpoint, '/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
            body: JSON.stringify(body),
            signal,
          }, maxResponseBytes)
        } catch (error) {
          if (error instanceof AgentPrivateOllamaDaemonError) throw error
          throw new AgentPrivateOllamaDaemonError('daemon_unavailable', error)
        } finally {
          await Promise.all([
            options.model.revalidate(), options.runtime.revalidate(), options.accelerator.revalidate(),
          ])
        }
        return result
      },
      revalidate: async () => {
        if (closePromise || options.signal.aborted) throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
        await Promise.all([
          options.bwrap.revalidate(),
          options.ollama.revalidate(),
          options.runtime.revalidate(),
          options.accelerator.revalidate(),
          options.model.revalidate(),
          owned!.revalidate(),
          revalidateAliasManifest(aliasManifest!.path, aliasManifest!.handle, aliasManifest!.identity),
        ])
      },
      close,
    }
    return Object.freeze(daemon)
  } catch (error) {
    await close()
    if (error instanceof AgentPrivateOllamaDaemonError) throw error
    throw new AgentPrivateOllamaDaemonError('daemon_unavailable', error)
  }
}

export async function probeAgentPrivateOllamaDaemon(options: ProbeAgentPrivateOllamaDaemonOptions): Promise<void> {
  if (process.platform !== 'linux' || options.signal.aborted) throw new AgentPrivateOllamaDaemonError('invalid_binding')
  const root = await canonicalPrivateRoot(options.root)
  const directory = await mkdtemp(join(root, 'ollama-probe-'))
  const choosePort = options.choosePort ?? (() => randomInt(20_000, 61_000))
  const readinessMs = boundedInteger(options.readinessMs, DEFAULT_READINESS_MS, 120_000)
  const startProcess = options.startProcess ?? startAgentOwnedProcess
  let owned: AgentOwnedProcess | undefined
  try {
    await chmod(directory, 0o700)
    await Promise.all([
      options.bwrap.revalidate(), options.ollama.revalidate(), options.runtime.revalidate(), options.accelerator.revalidate(),
    ])
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const port = normalizePort(choosePort())
      const plan = buildProbeLaunch(port, 4, 5, directory, options.runtime.path, options.accelerator)
      try {
        await Promise.all([
          options.bwrap.revalidate(), options.ollama.revalidate(), options.runtime.revalidate(),
          options.accelerator.revalidate(),
        ])
        owned = await startProcess({
          executable: options.bwrap,
          args: plan.args,
          env: plan.env,
          cwd: '/',
          inheritedHandles: [options.ollama.handle, options.runtime.handle],
          signal: options.signal,
          stderrBytes: 64 * 1024,
          terminationGraceMs: 500,
          reapTimeoutMs: 5_000,
        })
        await waitForReadiness({
          process: owned,
          endpoint: `http://127.0.0.1:${port}`,
          readinessMs,
          signal: options.signal,
          fetchImpl: options.fetch ?? globalThis.fetch,
        })
        await Promise.all([owned.revalidate(), options.runtime.revalidate(), options.accelerator.revalidate()])
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        await owned?.close().catch(() => undefined)
        owned = undefined
        if (options.signal.aborted || error instanceof AgentPrivateOllamaDaemonError && error.code === 'invalid_binding') throw error
      }
    }
    if (lastError || !owned) throw lastError ?? new AgentPrivateOllamaDaemonError('daemon_unavailable')
  } catch (error) {
    if (error instanceof AgentPrivateOllamaDaemonError) throw error
    throw new AgentPrivateOllamaDaemonError('daemon_unavailable', error)
  } finally {
    await owned?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
