import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import type {
  AgentCapabilitySnapshotV1,
  AgentOllamaModelSnapshotV1,
  AgentProcessModelAccessDeclarationV1,
} from '../../src/shared/types/agentActions.ts'
import {
  acquireAgentModelAccessGateway,
  type AgentModelExecutionLeaseV1,
} from './agent-model-access-gateway.ts'
import {
  openPinnedAgentExecutable,
  type PinnedAgentExecutable,
} from './agent-owned-process.ts'
import {
  openVerifiedOllamaModel,
  probeOllamaModelStore,
  type OpenVerifiedOllamaModel,
} from './agent-ollama-model-store.ts'
import {
  openAgentOllamaRuntimeTree,
  type OpenAgentOllamaRuntimeTree,
} from './agent-ollama-runtime-tree.ts'
import {
  probeAgentPrivateOllamaDaemon,
  startAgentPrivateOllamaDaemon,
  type AgentPrivateOllamaDaemon,
  type ProbeAgentPrivateOllamaDaemonOptions,
  type StartAgentPrivateOllamaDaemonOptions,
} from './agent-ollama-private-daemon.ts'
import { assertAgentOllamaModelSnapshotV1 } from './agent-trust-contracts.ts'

const SHA256 = /^[a-f0-9]{64}$/
const DEFAULT_BINARY = '/usr/local/bin/ollama'
const DEFAULT_MODELS_DIR = '/usr/share/ollama/.ollama/models'
const DEFAULT_BWRAP = '/usr/bin/bwrap'
const DEFAULT_READINESS_CACHE_MS = 30_000
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1_000
const MAX_STALE_ENTRIES = 128
const OWNED_DIRECTORY = /^(?:model-access|ollama-daemon|ollama-probe)-[A-Za-z0-9._-]+$/

export interface AgentOllamaConfiguration {
  binaryPath: string
  modelsDir: string
  runtimeDir: string
  bwrapPath: string
}

export interface ResolveAgentOllamaConfigurationOptions {
  env?: Readonly<Record<string, string | undefined>>
  homeDir?: string
  bwrapPath?: string
  platform?: NodeJS.Platform
}

export interface AgentModelAccessAcquireInput {
  actionId: string
  proposalHash: string
  capability: AgentCapabilitySnapshotV1
  model: AgentOllamaModelSnapshotV1
  privateTempRoot: string
  signal: AbortSignal
}

export interface AgentModelAccessRuntime {
  readiness(declaration: AgentProcessModelAccessDeclarationV1): Promise<boolean>
  acquire(input: Readonly<AgentModelAccessAcquireInput>): Promise<AgentModelExecutionLeaseV1>
  shutdown(): Promise<void>
}

interface AgentModelAccessReadinessProbeInput {
  root: string
  configuration: Readonly<AgentOllamaConfiguration>
  bwrap: PinnedAgentExecutable
  ollama: PinnedAgentExecutable
  runtime: OpenAgentOllamaRuntimeTree
  signal: AbortSignal
}

export interface CreateAgentModelAccessRuntimeOptions extends ResolveAgentOllamaConfigurationOptions {
  root: string
  readinessCacheMs?: number
  staleMs?: number
  readinessProbe?: (input: Readonly<AgentModelAccessReadinessProbeInput>) => boolean | Promise<boolean | void> | void
  startPrivateDaemon?: (options: StartAgentPrivateOllamaDaemonOptions) => Promise<AgentPrivateOllamaDaemon>
  probePrivateDaemon?: (options: ProbeAgentPrivateOllamaDaemonOptions) => Promise<void>
}

export class AgentModelAccessRuntimeError extends Error {
  readonly code: 'invalid_configuration' | 'provider_unavailable' | 'model_binding_invalid' | 'shutting_down'

  constructor(code: AgentModelAccessRuntimeError['code'], cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'AgentModelAccessRuntimeError'
    this.code = code
  }
}

function exactDeclaration(value: unknown): value is AgentProcessModelAccessDeclarationV1 {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === 2
    && (value as AgentProcessModelAccessDeclarationV1).schema === 'modly.agent-model-access.v1'
    && (value as AgentProcessModelAccessDeclarationV1).profile === 'ollama-responses-json-v1')
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new AgentModelAccessRuntimeError('invalid_configuration', new Error(`${label} must be canonical and absolute`))
  }
  try {
    const [canonical, info] = await Promise.all([realpath(path), lstat(path)])
    if (canonical !== path || info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not canonical`)
    return canonical
  } catch (error) {
    if (error instanceof AgentModelAccessRuntimeError) throw error
    throw new AgentModelAccessRuntimeError('invalid_configuration', error)
  }
}

async function validateExecutablePath(path: string, label: string): Promise<string> {
  const executable = await openPinnedAgentExecutable(path, label).catch((error) => {
    throw new AgentModelAccessRuntimeError('invalid_configuration', error)
  })
  try {
    await executable.revalidate()
    return executable.path
  } finally {
    await executable.close()
  }
}

async function resolveModelsCandidate(path: string): Promise<string | undefined> {
  try {
    const canonical = await canonicalDirectory(path, 'Ollama model store')
    if (!await probeOllamaModelStore(canonical)) return undefined
    return canonical
  } catch {
    return undefined
  }
}

function deriveRuntimeDirectory(binaryPath: string): string {
  const binDirectory = dirname(binaryPath)
  if (basename(binaryPath) !== 'ollama' || basename(binDirectory) !== 'bin') {
    throw new AgentModelAccessRuntimeError('invalid_configuration')
  }
  return join(dirname(binDirectory), 'lib', 'ollama')
}

async function validateRuntimeDirectory(path: string): Promise<string> {
  let runtime: OpenAgentOllamaRuntimeTree | undefined
  try {
    runtime = await openAgentOllamaRuntimeTree(path)
    await runtime.revalidate()
    return runtime.path
  } catch (error) {
    throw new AgentModelAccessRuntimeError('invalid_configuration', error)
  } finally {
    await runtime?.close()
  }
}

export async function resolveAgentOllamaConfiguration(
  options: ResolveAgentOllamaConfigurationOptions = {},
): Promise<Readonly<AgentOllamaConfiguration>> {
  if ((options.platform ?? process.platform) !== 'linux') {
    throw new AgentModelAccessRuntimeError('invalid_configuration')
  }
  const env = options.env ?? process.env
  const configuredBinary = env.MODLY_AGENT_OLLAMA_BINARY
  const configuredModels = env.MODLY_AGENT_OLLAMA_MODELS_DIR
  const configuredRuntime = env.MODLY_AGENT_OLLAMA_RUNTIME_DIR
  if (configuredBinary !== undefined && configuredBinary.length === 0
    || configuredModels !== undefined && configuredModels.length === 0
    || configuredRuntime !== undefined && configuredRuntime.length === 0) {
    throw new AgentModelAccessRuntimeError('invalid_configuration')
  }
  const binaryPath = await validateExecutablePath(configuredBinary ?? DEFAULT_BINARY, 'Ollama executable')
  const bwrapPath = await validateExecutablePath(options.bwrapPath ?? DEFAULT_BWRAP, 'bubblewrap executable')
  const runtimeDir = await validateRuntimeDirectory(configuredRuntime ?? deriveRuntimeDirectory(binaryPath))
  let modelsDir: string | undefined
  if (configuredModels !== undefined) {
    modelsDir = await resolveModelsCandidate(configuredModels)
    if (!modelsDir) throw new AgentModelAccessRuntimeError('invalid_configuration')
  } else {
    for (const candidate of [DEFAULT_MODELS_DIR, join(options.homeDir ?? homedir(), '.ollama', 'models')]) {
      modelsDir = await resolveModelsCandidate(candidate)
      if (modelsDir) break
    }
    if (!modelsDir) throw new AgentModelAccessRuntimeError('invalid_configuration')
  }
  return Object.freeze({ binaryPath, modelsDir, runtimeDir, bwrapPath })
}

async function ensurePrivateRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) {
    throw new AgentModelAccessRuntimeError('invalid_configuration')
  }
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const [canonical, info] = await Promise.all([realpath(root), lstat(root)])
    if (canonical !== root || info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error('Agent model access root is unsafe')
    }
    return canonical
  } catch (error) {
    throw new AgentModelAccessRuntimeError('invalid_configuration', error)
  }
}

async function cleanStaleDirectories(root: string, staleMs: number): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  let inspected = 0
  for (const entry of entries) {
    if (inspected >= MAX_STALE_ENTRIES) break
    if (!OWNED_DIRECTORY.test(entry.name)) continue
    inspected += 1
    const path = join(root, entry.name)
    const info = await lstat(path).catch(() => undefined)
    if (!info || info.isSymbolicLink() || !info.isDirectory() || Date.now() - info.mtimeMs < staleMs) continue
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function openAuthorities(configuration: Readonly<AgentOllamaConfiguration>): Promise<{
  bwrap: PinnedAgentExecutable
  ollama: PinnedAgentExecutable
  runtime: OpenAgentOllamaRuntimeTree
}> {
  let bwrap: PinnedAgentExecutable | undefined
  let ollama: PinnedAgentExecutable | undefined
  let runtime: OpenAgentOllamaRuntimeTree | undefined
  try {
    bwrap = await openPinnedAgentExecutable(configuration.bwrapPath, 'bubblewrap executable')
    ollama = await openPinnedAgentExecutable(configuration.binaryPath, 'Ollama executable')
    runtime = await openAgentOllamaRuntimeTree(configuration.runtimeDir)
    return { bwrap, ollama, runtime }
  } catch (error) {
    await Promise.all([bwrap?.close(), ollama?.close(), runtime?.close()])
    throw error
  }
}

export function createAgentModelAccessRuntime(options: CreateAgentModelAccessRuntimeOptions): AgentModelAccessRuntime {
  const environment = Object.freeze({ ...(options.env ?? process.env) })
  const readinessCacheMs = options.readinessCacheMs ?? DEFAULT_READINESS_CACHE_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  if (!Number.isSafeInteger(readinessCacheMs) || readinessCacheMs < 0 || readinessCacheMs > 10 * 60_000
    || !Number.isSafeInteger(staleMs) || staleMs < 60_000 || staleMs > 30 * 24 * 60 * 60 * 1_000) {
    throw new AgentModelAccessRuntimeError('invalid_configuration')
  }
  let initialized: Promise<string> | undefined
  let shuttingDown = false
  let shutdownPromise: Promise<void> | undefined
  let readinessCache: { at: number, promise: Promise<boolean> } | undefined
  const readinessControllers = new Set<AbortController>()
  const activeControllers = new Set<AbortController>()
  const activeLeases = new Set<AgentModelExecutionLeaseV1>()
  const inFlightOperations = new Set<Promise<unknown>>()
  const startPrivateDaemon = options.startPrivateDaemon ?? startAgentPrivateOllamaDaemon
  const probePrivateDaemon = options.probePrivateDaemon ?? probeAgentPrivateOllamaDaemon

  const initialize = (): Promise<string> => {
    initialized ??= (async () => {
      const root = await ensurePrivateRoot(options.root)
      await cleanStaleDirectories(root, staleMs)
      return root
    })()
    return initialized
  }

  const configuration = () => resolveAgentOllamaConfiguration({
    env: environment,
    homeDir: options.homeDir,
    bwrapPath: options.bwrapPath,
    platform: options.platform,
  })

  const trackOperation = <T>(promise: Promise<T>): Promise<T> => {
    inFlightOperations.add(promise)
    void promise.then(
      () => { inFlightOperations.delete(promise) },
      () => { inFlightOperations.delete(promise) },
    )
    return promise
  }

  const readiness = (declaration: AgentProcessModelAccessDeclarationV1): Promise<boolean> => {
    if (shuttingDown || !exactDeclaration(declaration) || (options.platform ?? process.platform) !== 'linux') {
      return Promise.resolve(false)
    }
    if (readinessCache && Date.now() - readinessCache.at <= readinessCacheMs) return readinessCache.promise
    const controller = new AbortController()
    readinessControllers.add(controller)
    const promise = (async () => {
      let authorities: Awaited<ReturnType<typeof openAuthorities>> | undefined
      try {
        const [root, resolved] = await Promise.all([initialize(), configuration()])
        if (!await probeOllamaModelStore(resolved.modelsDir)) return false
        authorities = await openAuthorities(resolved)
        if (options.readinessProbe) {
          const result = await options.readinessProbe({
            root, configuration: resolved, ...authorities, signal: controller.signal,
          })
          return result !== false && !controller.signal.aborted && !shuttingDown
        }
        await probePrivateDaemon({ root, ...authorities, signal: controller.signal })
        return !controller.signal.aborted && !shuttingDown
      } catch {
        return false
      } finally {
        readinessControllers.delete(controller)
        await Promise.all([authorities?.bwrap.close(), authorities?.ollama.close(), authorities?.runtime.close()])
      }
    })()
    const tracked = trackOperation(promise)
    readinessCache = { at: Date.now(), promise: tracked }
    return tracked
  }

  const acquireOperation = async (input: Readonly<AgentModelAccessAcquireInput>): Promise<AgentModelExecutionLeaseV1> => {
    if (shuttingDown) throw new AgentModelAccessRuntimeError('shutting_down')
    const execution = input.capability.execution
    const rawDeclaration = execution?.kind === 'process' ? execution.modelAccess : undefined
    if (!exactDeclaration(rawDeclaration) || !SHA256.test(input.capability.hash)
      || typeof input.privateTempRoot !== 'string' || !isAbsolute(input.privateTempRoot)
      || resolve(input.privateTempRoot) !== input.privateTempRoot) {
      throw new AgentModelAccessRuntimeError('model_binding_invalid')
    }
    const declaration: AgentProcessModelAccessDeclarationV1 = Object.freeze({
      schema: rawDeclaration.schema,
      profile: rawDeclaration.profile,
    })
    const actionId = input.actionId
    const proposalHash = input.proposalHash
    const capabilityHash = input.capability.hash
    let model: AgentOllamaModelSnapshotV1
    try { model = assertAgentOllamaModelSnapshotV1(input.model) } catch (error) {
      throw new AgentModelAccessRuntimeError('model_binding_invalid', error)
    }
    if (!await readiness(declaration) || shuttingDown) throw new AgentModelAccessRuntimeError('provider_unavailable')
    if (input.signal.aborted) throw new AgentModelAccessRuntimeError('provider_unavailable')
    const controller = new AbortController()
    const abort = () => controller.abort()
    input.signal.addEventListener('abort', abort, { once: true })
    activeControllers.add(controller)
    let authorities: Awaited<ReturnType<typeof openAuthorities>> | undefined
    let verified: OpenVerifiedOllamaModel | undefined
    let daemon: AgentPrivateOllamaDaemon | undefined
    let gateway: AgentModelExecutionLeaseV1 | undefined
    try {
      const [root, resolved] = await Promise.all([initialize(), configuration()])
      authorities = await openAuthorities(resolved)
      verified = await openVerifiedOllamaModel({
        modelsDir: resolved.modelsDir,
        model: model.model,
        digest: model.digest,
        signal: controller.signal,
      })
      await verified.revalidate()
      const alias = `modly-private-${randomBytes(16).toString('hex')}:latest`
      daemon = await startPrivateDaemon({
        root,
        ...authorities,
        model: verified,
        alias,
        signal: controller.signal,
      })
      await daemon.revalidate()
      gateway = await acquireAgentModelAccessGateway({
        root,
        actionId,
        proposalHash,
        capabilityHash,
        digest: model.digest,
        approvedModelName: model.model,
        declaration,
        privateModelAlias: alias,
        signal: controller.signal,
        forward: (body, signal) => daemon!.responses(body, signal),
      })
      let closePromise: Promise<void> | undefined
      const close = (): Promise<void> => {
        closePromise ??= (async () => {
          input.signal.removeEventListener('abort', abort)
          activeControllers.delete(controller)
          activeLeases.delete(lease)
          await gateway!.close().catch(() => undefined)
          await daemon!.close().catch(() => undefined)
          await verified!.close().catch(() => undefined)
          await Promise.all([authorities!.bwrap.close(), authorities!.ollama.close(), authorities!.runtime.close()])
        })()
        return closePromise
      }
      const lease: AgentModelExecutionLeaseV1 = Object.freeze({
        ...gateway,
        revalidate: async () => {
          if (closePromise || shuttingDown || controller.signal.aborted) {
            throw new AgentModelAccessRuntimeError('provider_unavailable')
          }
          await gateway!.revalidate()
          await daemon!.revalidate()
          await verified!.revalidate()
        },
        close,
      })
      activeLeases.add(lease)
      if (input.signal.aborted || shuttingDown) {
        controller.abort()
        await close()
        throw new AgentModelAccessRuntimeError('provider_unavailable')
      }
      return lease
    } catch (error) {
      input.signal.removeEventListener('abort', abort)
      activeControllers.delete(controller)
      controller.abort()
      await gateway?.close().catch(() => undefined)
      await daemon?.close().catch(() => undefined)
      await verified?.close().catch(() => undefined)
      await Promise.all([authorities?.bwrap.close(), authorities?.ollama.close(), authorities?.runtime.close()])
      if (error instanceof AgentModelAccessRuntimeError) throw error
      throw new AgentModelAccessRuntimeError('provider_unavailable', error)
    }
  }

  const acquire = (input: Readonly<AgentModelAccessAcquireInput>): Promise<AgentModelExecutionLeaseV1> => (
    trackOperation(acquireOperation(input))
  )

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      shuttingDown = true
      readinessCache = undefined
      for (const controller of readinessControllers) controller.abort()
      for (const controller of activeControllers) controller.abort()
      await Promise.allSettled([...activeLeases].map((lease) => lease.close()))
      while (inFlightOperations.size > 0) {
        await Promise.allSettled([...inFlightOperations])
      }
      await Promise.allSettled([...activeLeases].map((lease) => lease.close()))
      activeLeases.clear()
      activeControllers.clear()
    })()
    return shutdownPromise
  }

  return Object.freeze({ readiness, acquire, shutdown })
}
