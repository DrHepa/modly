import { randomInt } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { JsonValue } from '../../src/shared/types/agentActions.ts'
import {
  startAgentOwnedProcess,
  type AgentOwnedProcess,
  type PinnedAgentExecutable,
  type StartAgentOwnedProcessOptions,
} from './agent-owned-process.ts'
import type { OpenVerifiedOllamaModel } from './agent-ollama-model-store.ts'

const PRIVATE_ALIAS = /^modly-private-[a-f0-9]{16,64}:latest$/
const DEFAULT_READINESS_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_READINESS_BYTES = 1024 * 1024

export interface AgentPrivateOllamaLaunch {
  args: readonly string[]
  env: Readonly<Record<string, string>>
}

export interface BuildAgentPrivateOllamaLaunchOptions {
  model: OpenVerifiedOllamaModel
  alias: string
  port: number
  storeRoot: string
  ollamaFd: number
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

function basePrivateLaunch(port: number, storeRoot: string): string[] {
  const args = [
    '--die-with-parent',
    '--unshare-all',
    '--unshare-user',
    '--disable-userns',
    '--share-net',
    '--hostname', 'modly-ollama',
    '--ro-bind', '/', '/',
    '--tmpfs', storeRoot,
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    '--tmpfs', '/home',
    '--dir', '/home/modly',
    '--dir', '/runtime',
    '--dir', '/runtime/bin',
    '--dir', join(storeRoot, 'blobs'),
    '--dir', join(storeRoot, 'manifests'),
    '--dir', join(storeRoot, 'manifests', 'registry.ollama.ai'),
    '--dir', join(storeRoot, 'manifests', 'registry.ollama.ai', 'library'),
  ]
  appendPrivateEnvironment(args, port)
  args.push('--setenv', 'OLLAMA_MODELS', storeRoot)
  return args
}

export function buildAgentPrivateOllamaLaunch(options: BuildAgentPrivateOllamaLaunchOptions): Readonly<AgentPrivateOllamaLaunch> {
  const port = normalizePort(options.port)
  if (!PRIVATE_ALIAS.test(options.alias) || options.blobFds.length !== options.model.blobs.length
    || !Number.isSafeInteger(options.ollamaFd) || options.ollamaFd < 3
    || !Number.isSafeInteger(options.manifestFd) || options.manifestFd <= options.ollamaFd
    || options.blobFds.some((fd) => !Number.isSafeInteger(fd) || fd <= options.manifestFd)
    || options.storeRoot !== options.model.modelsDir) {
    throw new AgentPrivateOllamaDaemonError('invalid_binding')
  }
  const aliasName = options.alias.slice(0, -':latest'.length)
  const args = basePrivateLaunch(port, options.storeRoot)
  args.push(
    '--dir', join(options.storeRoot, 'manifests', 'registry.ollama.ai', 'library', aliasName),
    '--ro-bind-fd', String(options.ollamaFd), '/runtime/bin/ollama',
    '--ro-bind-fd', String(options.manifestFd), join(options.storeRoot, 'manifests', 'registry.ollama.ai', 'library', aliasName, 'latest'),
  )
  options.model.blobs.forEach((blob, index) => {
    args.push('--ro-bind-fd', String(options.blobFds[index]), join(options.storeRoot, 'blobs', blob.digest.replace(':', '-')))
  })
  args.push('--chdir', '/', '/runtime/bin/ollama', 'serve')
  return Object.freeze({
    args: Object.freeze(args),
    env: Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }),
  })
}

function buildProbeLaunch(port: number, ollamaFd: number, storeRoot: string): Readonly<AgentPrivateOllamaLaunch> {
  const args = basePrivateLaunch(normalizePort(port), storeRoot)
  args.push(
    '--ro-bind-fd', String(ollamaFd), '/runtime/bin/ollama',
    '--chdir', '/', '/runtime/bin/ollama', 'serve',
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
  const deadline = Date.now() + input.readinessMs
  let exited: { code: number | null, signal: NodeJS.Signals | null } | undefined
  void input.process.exited.then((value) => { exited = value })
  while (Date.now() < deadline && !input.signal.aborted) {
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
          && (candidate as { digest?: unknown }).digest === input.digest)) {
          throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
        }
        const shown = await fetchJson(input.fetchImpl, input.endpoint, '/api/show', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: input.alias, verbose: false }),
          signal: attempt.signal,
        }, MAX_READINESS_BYTES)
        if (!shown || typeof shown !== 'object' || Array.isArray(shown) || Object.hasOwn(shown, 'error')) {
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
    await delay(25, input.signal).catch(() => undefined)
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
    await Promise.all([options.bwrap.revalidate(), options.ollama.revalidate(), options.model.revalidate()])
    aliasManifest = await createAliasManifest(root, options.model.manifest.bytes)
    const ollamaFd = 4
    const manifestFd = 5
    const blobFds = options.model.blobs.map((_, index) => 6 + index)
    options.signal.addEventListener('abort', abort, { once: true })
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const port = normalizePort(choosePort())
      const candidateEndpoint = `http://127.0.0.1:${port}`
      const plan = buildAgentPrivateOllamaLaunch({
        model: options.model,
        alias: options.alias,
        port,
        storeRoot: options.model.modelsDir,
        ollamaFd,
        manifestFd,
        blobFds,
      })
      try {
        await Promise.all([
          options.bwrap.revalidate(),
          options.ollama.revalidate(),
          options.model.revalidate(),
          revalidateAliasManifest(aliasManifest.path, aliasManifest.handle, aliasManifest.identity),
        ])
        owned = await startProcess({
          executable: options.bwrap,
          args: plan.args,
          env: plan.env,
          cwd: '/',
          inheritedHandles: [options.ollama.handle, aliasManifest.handle, ...options.model.blobs.map((blob) => blob.handle)],
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
          await options.model.revalidate()
        }
        return result
      },
      revalidate: async () => {
        if (closePromise || options.signal.aborted) throw new AgentPrivateOllamaDaemonError('daemon_unavailable')
        await Promise.all([
          options.bwrap.revalidate(),
          options.ollama.revalidate(),
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
    await Promise.all([options.bwrap.revalidate(), options.ollama.revalidate()])
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const port = normalizePort(choosePort())
      const plan = buildProbeLaunch(port, 4, directory)
      try {
        await Promise.all([options.bwrap.revalidate(), options.ollama.revalidate()])
        owned = await startProcess({
          executable: options.bwrap,
          args: plan.args,
          env: plan.env,
          cwd: '/',
          inheritedHandles: [options.ollama.handle],
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
