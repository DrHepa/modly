import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import type { Socket } from 'node:net'

import type { AgentProcessModelAccessDeclarationV1, JsonValue } from '../../src/shared/types/agentActions.ts'
import { normalizeJsonValue, sha256Canonical } from './agent-trust-contracts.ts'

export const AGENT_MODEL_ACCESS_SANDBOX_DIRECTORY = '/run/modly/model' as const
export const AGENT_MODEL_ACCESS_SANDBOX_SOCKET = '/run/modly/model/gateway.sock' as const
export const AGENT_MODEL_ACCESS_RESPONSES_PATH = '/v1/responses' as const
export const AGENT_MODEL_ACCESS_MODEL_SENTINEL = 'approved' as const

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const MODEL_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/
const RESPONSES_REQUEST_KEYS = new Set([
  'model', 'input', 'instructions', 'max_output_tokens', 'temperature', 'top_p',
  'text', 'reasoning', 'stream', 'store', 'background', 'previous_response_id', 'tools',
])

export interface AgentModelAccessLimits {
  maxRequests: 1
  maxRequestBytes: number
  maxResponseBytes: number
  idleMs: number
  totalMs: number
}

export interface AgentModelExecutionLeaseV1 {
  readonly schema: 'modly.agent-model-execution-lease.v1'
  readonly leaseId: string
  readonly assurance: 'pinned-local-cooperative-host'
  readonly transport: 'unix-http'
  readonly socketPath: typeof AGENT_MODEL_ACCESS_SANDBOX_SOCKET
  readonly responsesPath: typeof AGENT_MODEL_ACCESS_RESPONSES_PATH
  readonly model: typeof AGENT_MODEL_ACCESS_MODEL_SENTINEL
  readonly digest: `sha256:${string}`
  readonly bearerToken: string
  readonly limits: Readonly<AgentModelAccessLimits>
  readonly expiresAt: string
  readonly bindingHash: string
  /** Main-private host path. Never serialize this lease to renderer or persistence. */
  readonly directoryPath: string
  /** Main-private host path. Never expose it to the sandbox. */
  readonly hostSocketPath: string
  /** Open directory authority inherited by bubblewrap. */
  readonly directoryHandle: FileHandle
  revalidate(): Promise<void>
  close(): Promise<void>
}

export interface AcquireAgentModelAccessGatewayOptions {
  root: string
  actionId: string
  proposalHash: string
  capabilityHash: string
  digest: string
  approvedModelName: string
  declaration: AgentProcessModelAccessDeclarationV1
  privateModelAlias: string
  signal: AbortSignal
  forward: (request: Readonly<Record<string, JsonValue>>, signal: AbortSignal) => Promise<unknown>
  limits?: Partial<Omit<AgentModelAccessLimits, 'maxRequests'>>
  now?: () => Date
}

const DEFAULT_LIMITS: Readonly<AgentModelAccessLimits> = Object.freeze({
  maxRequests: 1,
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  idleMs: 30_000,
  totalMs: 180_000,
})

const APPROVED_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,2}(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/

class GatewayHttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

function normalizeBound(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError('Agent model access limit is invalid')
  }
  return value
}

function normalizeLimits(value: AcquireAgentModelAccessGatewayOptions['limits']): Readonly<AgentModelAccessLimits> {
  return Object.freeze({
    maxRequests: 1,
    maxRequestBytes: normalizeBound(value?.maxRequestBytes, DEFAULT_LIMITS.maxRequestBytes, 8 * 1024 * 1024),
    maxResponseBytes: normalizeBound(value?.maxResponseBytes, DEFAULT_LIMITS.maxResponseBytes, 16 * 1024 * 1024),
    idleMs: normalizeBound(value?.idleMs, DEFAULT_LIMITS.idleMs, 120_000),
    totalMs: normalizeBound(value?.totalMs, DEFAULT_LIMITS.totalMs, 10 * 60_000),
  })
}

function authorized(value: string | undefined, token: string): boolean {
  if (!value?.startsWith('Bearer ')) return false
  const candidate = Buffer.from(value.slice('Bearer '.length), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    connection: 'close',
  })
  response.end(body)
}

async function readBoundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new GatewayHttpError(413, 'request_too_large')
  }
  if (request.headers['transfer-encoding'] !== undefined) {
    throw new GatewayHttpError(400, 'unsupported_transfer_encoding')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maximum) throw new GatewayHttpError(413, 'request_too_large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

function normalizeResponsesRequest(value: unknown, alias: string): Readonly<Record<string, JsonValue>> {
  const normalized = normalizeJsonValue(value)
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new GatewayHttpError(400, 'invalid_request')
  }
  if (Object.keys(normalized).some((key) => !RESPONSES_REQUEST_KEYS.has(key))
    || normalized.model !== AGENT_MODEL_ACCESS_MODEL_SENTINEL
    || (normalized.stream !== undefined && normalized.stream !== false)
    || (normalized.store !== undefined && normalized.store !== false)
    || (normalized.background !== undefined && normalized.background !== false)
    || (normalized.previous_response_id !== undefined && normalized.previous_response_id !== null)
    || (normalized.tools !== undefined && (!Array.isArray(normalized.tools) || normalized.tools.length !== 0))) {
    throw new GatewayHttpError(400, 'unsupported_request')
  }
  return Object.freeze({ ...normalized, model: alias })
}

function redactPrivateAlias(value: JsonValue, alias: string): JsonValue {
  if (typeof value === 'string') return value.split(alias).join(AGENT_MODEL_ACCESS_MODEL_SENTINEL)
  if (Array.isArray(value)) return value.map((entry) => redactPrivateAlias(entry, alias))
  if (value && typeof value === 'object') {
    const redacted: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      const redactedKey = key.split(alias).join(AGENT_MODEL_ACCESS_MODEL_SENTINEL)
      if (Object.hasOwn(redacted, redactedKey)) throw new GatewayHttpError(502, 'invalid_upstream_response')
      redacted[redactedKey] = redactPrivateAlias(entry, alias)
    }
    return redacted
  }
  return value
}

async function canonicalPrivateRoot(root: string): Promise<string> {
  const canonical = await realpath(root)
  const info = await lstat(root)
  if (canonical !== resolve(root) || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new TypeError('Agent model access root must be a canonical private directory')
  }
  return canonical
}

async function createPrivateGatewayDirectory(root: string) {
  let directoryPath = ''
  let directoryHandle: FileHandle | undefined
  try {
    directoryPath = await mkdtemp(join(root, 'model-access-'))
    await chmod(directoryPath, 0o700)
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    directoryHandle = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | noFollow)
    const directoryIdentity = await directoryHandle.stat({ bigint: true })
    return { directoryPath, directoryHandle, directoryIdentity }
  } catch (error) {
    await directoryHandle?.close().catch(() => undefined)
    if (directoryPath) await rm(directoryPath, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function acquireAgentModelAccessGateway(
  options: AcquireAgentModelAccessGatewayOptions,
): Promise<AgentModelExecutionLeaseV1> {
  if (process.platform !== 'linux' || !SAFE_ID.test(options.actionId) || !SHA256.test(options.proposalHash)
    || !SHA256.test(options.capabilityHash) || !DIGEST.test(options.digest)
    || !APPROVED_MODEL.test(options.approvedModelName)
    || Reflect.ownKeys(options.declaration).length !== 2
    || options.declaration.schema !== 'modly.agent-model-access.v1'
    || options.declaration.profile !== 'ollama-responses-json-v1'
    || !MODEL_ALIAS.test(options.privateModelAlias) || options.signal.aborted) {
    throw new TypeError('Agent model access gateway binding is invalid')
  }
  const limits = normalizeLimits(options.limits)
  const digest = options.digest as `sha256:${string}`
  const now = options.now ?? (() => new Date())
  const root = await canonicalPrivateRoot(options.root)
  const { directoryPath, directoryHandle, directoryIdentity } = await createPrivateGatewayDirectory(root)
  const hostSocketPath = join(directoryPath, 'gateway.sock')
  const bearerToken = randomBytes(32).toString('base64url')
  const leaseId = randomUUID()
  const expiresAt = new Date(now().getTime() + limits.totalMs).toISOString()
  const tokenHash = createHash('sha256').update(bearerToken).digest('hex')
  const privateModelAliasHash = createHash('sha256').update(options.privateModelAlias).digest('hex')
  const approvedModelNameHash = createHash('sha256').update(options.approvedModelName).digest('hex')
  const declarationHash = sha256Canonical(options.declaration)
  const bindingHash = sha256Canonical({
    schema: 'modly.agent-model-execution-lease.v1',
    leaseId,
    actionId: options.actionId,
    proposalHash: options.proposalHash,
    capabilityHash: options.capabilityHash,
    digest,
    approvedModelNameHash,
    declarationHash,
    assurance: 'pinned-local-cooperative-host',
    transport: 'unix-http',
    socketPath: AGENT_MODEL_ACCESS_SANDBOX_SOCKET,
    responsesPath: AGENT_MODEL_ACCESS_RESPONSES_PATH,
    model: AGENT_MODEL_ACCESS_MODEL_SENTINEL,
    tokenHash,
    privateModelAliasHash,
    limits,
    expiresAt,
  })
  const connections = new Set<Socket>()
  let consumed = false
  let socketIdentity: Awaited<ReturnType<typeof lstat>> | undefined
  let closePromise: Promise<void> | undefined
  let leaseTimer: NodeJS.Timeout | undefined
  const requestAbortControllers = new Set<AbortController>()

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'POST' || request.url !== AGENT_MODEL_ACCESS_RESPONSES_PATH) {
          throw new GatewayHttpError(404, 'not_found')
        }
        const authorization = request.headers.authorization
        if (Array.isArray(authorization) || !authorized(authorization, bearerToken)) {
          throw new GatewayHttpError(401, 'unauthorized')
        }
        if (consumed) throw new GatewayHttpError(409, 'lease_consumed')
        consumed = true
        if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) {
          throw new GatewayHttpError(415, 'unsupported_media_type')
        }
        request.setTimeout(limits.idleMs, () => request.destroy(new Error('request_idle_timeout')))
        let raw: Buffer
        try {
          raw = await readBoundedBody(request, limits.maxRequestBytes)
        } finally {
          request.setTimeout(0)
        }
        let parsed: unknown
        try { parsed = JSON.parse(raw.toString('utf8')) } catch { throw new GatewayHttpError(400, 'invalid_json') }
        const body = normalizeResponsesRequest(parsed, options.privateModelAlias)
        const controller = new AbortController()
        requestAbortControllers.add(controller)
        const abort = () => controller.abort()
        options.signal.addEventListener('abort', abort, { once: true })
        const timeout = setTimeout(abort, limits.totalMs)
        timeout.unref()
        try {
          const forwarded = await options.forward(body, controller.signal)
          if (controller.signal.aborted) throw new GatewayHttpError(504, 'gateway_timeout')
          const result = redactPrivateAlias(normalizeJsonValue(forwarded), options.privateModelAlias)
          const bytes = Buffer.from(JSON.stringify(result), 'utf8')
          if (bytes.length > limits.maxResponseBytes) throw new GatewayHttpError(502, 'response_too_large')
          sendJson(response, 200, result)
        } finally {
          clearTimeout(timeout)
          options.signal.removeEventListener('abort', abort)
          requestAbortControllers.delete(controller)
        }
      } catch (error) {
        const failure = error instanceof GatewayHttpError ? error : new GatewayHttpError(502, 'upstream_unavailable')
        sendJson(response, failure.status, { error: { code: failure.code } })
      }
    })()
  })
  server.on('connection', (socket) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
  })

  const close = async (): Promise<void> => {
    closePromise ??= (async () => {
      options.signal.removeEventListener('abort', abortLease)
      clearTimeout(leaseTimer)
      for (const controller of requestAbortControllers) controller.abort()
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolveClose) => {
        if (!server.listening) return resolveClose()
        server.close(() => resolveClose())
      })
      await directoryHandle.close().catch(() => undefined)
      await rm(directoryPath, { recursive: true, force: true }).catch(() => undefined)
    })()
    return closePromise
  }
  const abortLease = () => { void close() }

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => { server.off('listening', onListening); rejectListen(error) }
      const onListening = () => { server.off('error', onError); resolveListen() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(hostSocketPath)
    })
    await chmod(hostSocketPath, 0o600)
    socketIdentity = await lstat(hostSocketPath)
    if (!socketIdentity.isSocket()) throw new TypeError('Agent model access socket is not a Unix socket')
    options.signal.addEventListener('abort', abortLease, { once: true })
    leaseTimer = setTimeout(abortLease, limits.totalMs)
    leaseTimer.unref()
    if (options.signal.aborted) {
      await close()
      throw new Error('Agent model access gateway was aborted')
    }

    return Object.freeze({
      schema: 'modly.agent-model-execution-lease.v1' as const,
      leaseId,
      assurance: 'pinned-local-cooperative-host' as const,
      transport: 'unix-http' as const,
      socketPath: AGENT_MODEL_ACCESS_SANDBOX_SOCKET,
      responsesPath: AGENT_MODEL_ACCESS_RESPONSES_PATH,
      model: AGENT_MODEL_ACCESS_MODEL_SENTINEL,
      digest,
      bearerToken,
      limits,
      expiresAt,
      bindingHash,
      directoryPath,
      hostSocketPath,
      directoryHandle,
      revalidate: async () => {
        if (closePromise || !server.listening || options.signal.aborted || now().getTime() >= Date.parse(expiresAt)) {
          throw new Error('Agent model access lease is unavailable')
        }
        const directory = await directoryHandle.stat({ bigint: true })
        const socket = await lstat(hostSocketPath)
        if (!directory.isDirectory() || directory.dev !== directoryIdentity.dev || directory.ino !== directoryIdentity.ino
          || Number(directory.mode & 0o777n) !== 0o700 || !socketIdentity || !socket.isSocket()
          || socket.dev !== socketIdentity.dev || socket.ino !== socketIdentity.ino || (socket.mode & 0o777) !== 0o600) {
          throw new Error('Agent model access lease identity changed')
        }
      },
      close,
    })
  } catch (error) {
    await close()
    throw error
  }
}
