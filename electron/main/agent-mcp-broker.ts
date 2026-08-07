import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants, type BigIntStats } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import Ajv from 'ajv'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'

import type { AgentActionExecutor, AgentActionExecutorRequest } from './agent-actions-service.ts'
import {
  MCP_MAX_INHERITED_FDS,
  discoverGovernedMcpTools,
  type BoundMcpServer,
  type DiscoveredMcpTool,
  type McpExecutableIdentity,
} from './agent-mcp-manifest.ts'
import { assertArtifactRefV1, canonicalJson, sha256Canonical } from './agent-trust-contracts.ts'
import type {
  AgentMcpArtifactOutputContractV1,
  ArtifactRefV1,
  JsonValue,
} from '../../src/shared/types/agentActions.ts'
import {
  closeOpenAgentHostRuntime,
  openBoundAgentHostRuntime,
  revalidateOpenAgentHostRuntime,
  type OpenAgentHostRuntime,
} from './agent-host-runtime.ts'

const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_RUNTIME_DEPTH = 32
const MAX_RUNTIME_PROPERTIES = 2_048
const MAX_RUNTIME_ARRAY = 1_000
const MAX_RUNTIME_STRING = 200_000
const MAX_APPROVAL_SCHEMA_DEPTH = 16
const MAX_APPROVAL_SCHEMA_NODES = 512
const MAX_APPROVAL_ARRAY_ITEMS = 100
const MAX_APPROVAL_STRING_LENGTH = 4_096
const APPROVAL_PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/
const MAX_TRANSPORT_BYTES = 4 * 1024 * 1024
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024
const MAX_RESULT_BYTES = MAX_MESSAGE_BYTES
const MAX_CONTENT_BYTES = 256 * 1024
const MAX_TEXT_CONTENT_BYTES = 64 * 1024
const MAX_ARTIFACTS = 4
const MAX_ARTIFACT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024
const ARTIFACT_COPY_CHUNK_BYTES = 64 * 1024
const SANDBOX_TMPFS_BYTES = 64 * 1024 * 1024
const PROCESS_TERMINATION_GRACE_MS = 250
const PROCESS_REAP_TIMEOUT_MS = 2_000
const DEFAULT_READINESS_CACHE_TTL_MS = 30_000
const DEFAULT_READINESS_TIMEOUT_MS = 2_000
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000
const DEFAULT_LIST_TIMEOUT_MS = 10_000
const DEFAULT_CALL_TIMEOUT_MS = 5 * 60 * 1_000
const FIXED_HOST_ENV = Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })

export type AgentMcpBrokerErrorCode =
  | 'unsupported_capability'
  | 'capability_stale'
  | 'invalid_arguments'
  | 'schema_drift'
  | 'protocol_error'
  | 'invalid_result'
  | 'artifact_too_large'
  | 'sandbox_unavailable'
  | 'timeout'
  | 'cancelled'

export class AgentMcpBrokerError extends Error {
  readonly code: AgentMcpBrokerErrorCode

  constructor(code: AgentMcpBrokerErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'AgentMcpBrokerError'
    this.code = code
  }
}

export interface McpTransportSession {
  transport: Transport
  cancel(): Promise<void>
  close(): Promise<void>
  revalidate?(): Promise<void>
}

interface OpenMcpInputArtifact {
  binding: DiscoveredMcpTool['tool']['inputArtifacts'][number]
  ref: ArtifactRefV1
  handle: FileHandle
  identity: BigIntStats
}

export interface McpTransportFactoryContext {
  binding: DiscoveredMcpTool
  signal: AbortSignal
  inputFiles: readonly OpenMcpInputArtifact[]
  outputFiles?: readonly OpenMcpOutputFile[]
}

export interface OpenMcpOutputFile {
  path: string
  hostPath: string
  maxBytes: number
  handle: FileHandle
  identity: BigIntStats
}

export type McpTransportFactory = (context: McpTransportFactoryContext) => Promise<McpTransportSession>

export interface BubblewrapLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: '/'
  shell: false
}

export interface OwnedStdioTransportOptions {
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  cwd: string
  inheritedHandles?: readonly FileHandle[]
  ownsInheritedHandles?: boolean
  terminationGraceMs?: number
  reapTimeoutMs?: number
  onGroupSignal?: (signal: NodeJS.Signals) => void
}

export interface AgentMcpExecutorOptions {
  discovery: Parameters<typeof discoverGovernedMcpTools>[0]
  getWorkspaceRoot: () => string | Promise<string>
  getPrivateTempRoot?: (workspaceRoot: string) => string | Promise<string>
  transportFactory?: McpTransportFactory
  platform?: NodeJS.Platform
  bwrapPath?: string
  prlimitPath?: string
  systemPaths?: readonly string[]
  initializeTimeoutMs?: number
  listTimeoutMs?: number
  callTimeoutMs?: number
  sandboxReadiness?: AgentMcpSandboxReadiness
}

export type AgentMcpSandboxProfile = AgentMcpArtifactOutputContractV1['profile']
export type AgentMcpSandboxReadiness = (profile?: AgentMcpSandboxProfile) => Promise<boolean>

export interface AgentMcpSandboxReadinessOptions {
  platform?: NodeJS.Platform
  bwrapPath?: string
  prlimitPath?: string
  systemPaths?: readonly string[]
  getWorkspaceRoot?: () => string | Promise<string>
  cacheTtlMs?: number
  timeoutMs?: number
  probe?: (profile: AgentMcpSandboxProfile) => Promise<boolean>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new AgentMcpBrokerError('invalid_result')
  const allowed = new Set(keys)
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new AgentMcpBrokerError('invalid_result')
  }
  return value
}

function inspectRuntimeJson(
  value: unknown,
  depth: number,
  state: { properties: number },
  failure: 'invalid_arguments' | 'invalid_result',
): void {
  if (depth > MAX_RUNTIME_DEPTH) throw new AgentMcpBrokerError(failure)
  if (typeof value === 'string') {
    const maxString = failure === 'invalid_arguments' ? MAX_RUNTIME_STRING : MAX_RESULT_BYTES
    if (value.length > maxString) throw new AgentMcpBrokerError(failure)
    return
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new AgentMcpBrokerError(failure)
    return
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_RUNTIME_ARRAY) throw new AgentMcpBrokerError(failure)
    for (const child of value) inspectRuntimeJson(child, depth + 1, state, failure)
    return
  }
  if (!isPlainRecord(value)) throw new AgentMcpBrokerError(failure)
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new AgentMcpBrokerError(failure)
    state.properties += 1
    if (state.properties > MAX_RUNTIME_PROPERTIES) throw new AgentMcpBrokerError(failure)
    inspectRuntimeJson(child, depth + 1, state, failure)
  }
}

function asJsonValue(value: unknown, failure: 'invalid_arguments' | 'invalid_result'): JsonValue {
  inspectRuntimeJson(value, 0, { properties: 0 }, failure)
  try {
    const serialized = canonicalJson(value)
    const cap = failure === 'invalid_arguments' ? MAX_REQUEST_BYTES : MAX_RESULT_BYTES
    if (Buffer.byteLength(serialized, 'utf8') > cap) throw new AgentMcpBrokerError(failure)
    return JSON.parse(serialized) as JsonValue
  } catch (error) {
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError(failure, error)
  }
}

function compileSchema(schema: unknown, failure: 'invalid_arguments' | 'invalid_result') {
  try {
    const ajv = new Ajv({
      allErrors: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      ownProperties: true,
      strict: true,
      strictSchema: true,
      strictTypes: true,
      strictRequired: true,
      allowUnionTypes: false,
      validateSchema: true,
      addUsedSchema: false,
    })
    return ajv.compile(schema as object)
  } catch (error) {
    throw new AgentMcpBrokerError(failure, error)
  }
}

export function validateMcpArguments(schema: unknown, value: unknown): JsonValue {
  const normalized = asJsonValue(value, 'invalid_arguments')
  const validate = compileSchema(schema, 'invalid_arguments')
  if (!validate(normalized)) throw new AgentMcpBrokerError('invalid_arguments')
  return normalized
}

function assertPreviewableSchemaNode(
  schema: unknown,
  depth: number,
  state: { nodes: number },
): void {
  if (depth > MAX_APPROVAL_SCHEMA_DEPTH || !isPlainRecord(schema)) {
    throw new AgentMcpBrokerError('invalid_arguments')
  }
  state.nodes += 1
  if (state.nodes > MAX_APPROVAL_SCHEMA_NODES) throw new AgentMcpBrokerError('invalid_arguments')
  for (const keyword of [
    '$ref', '$defs', 'definitions', 'patternProperties', 'propertyNames',
    'unevaluatedProperties', 'dependentSchemas', 'dependencies',
    'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
    'contains', 'prefixItems', 'unevaluatedItems', 'pattern', 'format',
  ]) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword)) {
      throw new AgentMcpBrokerError('invalid_arguments')
    }
  }
  if (Array.isArray(schema.type) || typeof schema.type !== 'string') {
    throw new AgentMcpBrokerError('invalid_arguments')
  }
  switch (schema.type) {
    case 'object': {
      if (schema.additionalProperties !== false || !isPlainRecord(schema.properties)) {
        throw new AgentMcpBrokerError('invalid_arguments')
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!APPROVAL_PROPERTY_NAME.test(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') {
          throw new AgentMcpBrokerError('invalid_arguments')
        }
        assertPreviewableSchemaNode(child, depth + 1, state)
      }
      return
    }
    case 'array':
      if (
        !Number.isSafeInteger(schema.maxItems)
        || (schema.maxItems as number) < 0
        || (schema.maxItems as number) > MAX_APPROVAL_ARRAY_ITEMS
        || schema.items === undefined
      ) throw new AgentMcpBrokerError('invalid_arguments')
      assertPreviewableSchemaNode(schema.items, depth + 1, state)
      return
    case 'string':
      if (!Number.isSafeInteger(schema.maxLength) || (schema.maxLength as number) < 0 || (schema.maxLength as number) > MAX_APPROVAL_STRING_LENGTH) {
        throw new AgentMcpBrokerError('invalid_arguments')
      }
      return
    case 'integer':
    case 'number':
    case 'boolean':
    case 'null':
      return
    default:
      throw new AgentMcpBrokerError('invalid_arguments')
  }
}

/**
 * Proposal-time validation intentionally uses the exact execution-time Ajv
 * validator, then applies the smaller schema subset whose normalized values can
 * be rendered completely in the approval UI.
 */
export function validateMcpProposalArguments(schema: unknown, value: unknown): JsonValue {
  assertPreviewableSchemaNode(schema, 0, { nodes: 0 })
  return validateMcpArguments(schema, value)
}

function validateStructuredOutput(schema: unknown | undefined, value: unknown): JsonValue {
  const normalized = asJsonValue(value, 'invalid_result')
  if (schema !== undefined && !compileSchema(schema, 'invalid_result')(normalized)) {
    throw new AgentMcpBrokerError('invalid_result')
  }
  return normalized
}

class BoundedTransport implements Transport {
  private bytes = 0
  private readonly inner: Transport
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: Transport['onmessage']
  sessionId?: string

  constructor(inner: Transport) {
    this.inner = inner
  }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.()
    this.inner.onerror = (error) => this.onerror?.(error)
    this.inner.onmessage = (message, extra) => {
      let size: number
      try { size = Buffer.byteLength(JSON.stringify(message), 'utf8') } catch {
        this.onerror?.(new AgentMcpBrokerError('protocol_error'))
        void this.close()
        return
      }
      this.bytes += size
      if (size > MAX_MESSAGE_BYTES || this.bytes > MAX_TRANSPORT_BYTES) {
        this.onerror?.(new AgentMcpBrokerError('protocol_error'))
        void this.close()
        return
      }
      this.onmessage?.(message, extra)
    }
    this.inner.setProtocolVersion = (version) => this.setProtocolVersion?.(version)
    await this.inner.start()
    this.sessionId = this.inner.sessionId
  }

  setProtocolVersion?(version: string): void

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options)
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

interface LinuxProcessGroupIdentity {
  pgrp: number
  startTime: string
}

async function readLinuxProcessGroupIdentity(pid: number): Promise<LinuxProcessGroupIdentity | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = value.lastIndexOf(')')
    if (commandEnd < 0) return undefined
    const fields = value.slice(commandEnd + 1).trim().split(/\s+/)
    const pgrp = Number(fields[2])
    const startTime = fields[19]
    if (!Number.isSafeInteger(pgrp) || typeof startTime !== 'string' || !/^\d+$/.test(startTime)) return undefined
    return { pgrp, startTime }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function signalOwnedProcessGroup(
  pid: number,
  startTime: string | undefined,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (startTime === undefined) return false
  const identity = await readLinuxProcessGroupIdentity(pid)
  if (!identity || identity.pgrp !== pid || identity.startTime !== startTime) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

/**
 * Official MCP framing over an owned detached child process. The MCP Client
 * still owns every protocol decision; this transport only relays bounded
 * newline-delimited SDK messages and owns process-tree termination.
 */
export class OwnedStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: Transport['onmessage']
  sessionId?: string

  private readonly options: OwnedStdioTransportOptions
  private readonly readBuffer = new ReadBuffer({ maxBufferSize: MAX_MESSAGE_BYTES })
  private child?: ChildProcess
  private exitPromise?: Promise<void>
  private started = false
  private closed = false
  private closeNotified = false
  private termination?: Promise<void>
  private inheritedClosed = false
  private processStartTime?: string

  constructor(options: OwnedStdioTransportOptions) {
    this.options = options
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('OwnedStdioTransport is already started')
    if (this.closed) throw new Error('OwnedStdioTransport is closed')
    this.started = true
    const inherited = this.options.inheritedHandles ?? []
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', ...inherited.map((handle) => handle.fd)],
    })
    this.child = child
    this.exitPromise = new Promise((resolveExit) => {
      child.once('close', () => {
        resolveExit()
        this.notifyClose()
      })
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.readBuffer.append(chunk)
        let message = this.readBuffer.readMessage()
        while (message !== null) {
          this.onmessage?.(message)
          message = this.readBuffer.readMessage()
        }
      } catch (error) {
        this.onTransportError(error)
      }
    })
    let stderrBytes = 0
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > MAX_CONTENT_BYTES) this.onTransportError(new AgentMcpBrokerError('protocol_error'))
    })
    child.on('error', (error) => this.onerror?.(error))

    try {
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        const onSpawn = (): void => { cleanup(); resolveSpawn() }
        const onError = (error: Error): void => { cleanup(); rejectSpawn(error) }
        const cleanup = (): void => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }
        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
      if (process.platform === 'linux' && child.pid !== undefined) {
        const identity = await readLinuxProcessGroupIdentity(child.pid)
        if (identity && identity.pgrp === child.pid) {
          this.processStartTime = identity.startTime
        } else if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          throw new AgentMcpBrokerError('protocol_error')
        }
      }
    } finally {
      if (this.options.ownsInheritedHandles !== false) await this.closeInheritedHandles()
    }
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const stdin = this.child?.stdin
    if (!stdin || !stdin.writable || this.closed) throw new Error('Owned stdio transport is not writable')
    const serialized = serializeMessage(message)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MESSAGE_BYTES) throw new AgentMcpBrokerError('protocol_error')
    await new Promise<void>((resolveWrite, rejectWrite) => {
      stdin.write(serialized, (error?: Error | null) => error ? rejectWrite(error) : resolveWrite())
    })
  }

  close(): Promise<void> {
    if (this.termination) return this.termination
    this.termination = this.terminate()
    return this.termination
  }

  private onTransportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error('Owned stdio transport failed')
    this.onerror?.(normalized)
    void this.close().catch(() => undefined)
  }

  private async terminate(): Promise<void> {
    this.closed = true
    this.readBuffer.clear()
    this.child?.stdin?.destroy()
    const pid = this.child?.pid
    if (pid !== undefined && process.platform === 'linux') {
      const startTime = this.processStartTime
      try {
        if (await signalOwnedProcessGroup(pid, startTime, 'SIGTERM')) this.options.onGroupSignal?.('SIGTERM')
      } catch (error) { this.onerror?.(error as Error) }
      const exited = this.exitPromise
        ? await Promise.race([
          this.exitPromise.then(() => true),
          delay(this.options.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS).then(() => false),
        ])
        : true
      if (!exited) {
        try {
          if (await signalOwnedProcessGroup(pid, startTime, 'SIGKILL')) this.options.onGroupSignal?.('SIGKILL')
        } catch (error) { this.onerror?.(error as Error) }
      }
    } else {
      this.child?.kill('SIGTERM')
      const exited = this.exitPromise
        ? await Promise.race([
          this.exitPromise.then(() => true),
          delay(this.options.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS).then(() => false),
        ])
        : true
      if (!exited) this.child?.kill('SIGKILL')
    }
    if (this.options.ownsInheritedHandles !== false) await this.closeInheritedHandles()
    if (this.exitPromise) {
      const reaped = await Promise.race([
        this.exitPromise.then(() => true),
        delay(this.options.reapTimeoutMs ?? PROCESS_REAP_TIMEOUT_MS).then(() => false),
      ])
      if (!reaped) {
        this.child?.kill('SIGKILL')
        throw new AgentMcpBrokerError('protocol_error')
      }
    }
    this.notifyClose()
  }

  private async closeInheritedHandles(): Promise<void> {
    if (this.inheritedClosed) return
    this.inheritedClosed = true
    await Promise.all((this.options.inheritedHandles ?? []).map((handle) => handle.close().catch(() => undefined)))
  }

  private notifyClose(): void {
    if (this.closeNotified) return
    this.closeNotified = true
    this.onclose?.()
  }
}

function safePositiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('MCP timeout must be a positive safe integer')
  return value
}

function assertSafeActionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new AgentMcpBrokerError('unsupported_capability')
}

function isOutside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

async function ensureDirectory(path: string, mode = 0o700): Promise<void> {
  try { await mkdir(path, { mode }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AgentMcpBrokerError('invalid_result')
}

interface ActionOutputPaths {
  workspace: string
  finalRoot: string
  finalDir: string
  stagingRoot: string
}

interface RelativeOutputStage {
  stageDir: string
  outputDir: string
  slots: OpenMcpOutputFile[]
}

export function agentMcpWorkspaceStagingRoot(workspaceRoot: string): string {
  return join(workspaceRoot, 'Workflows', 'agent-actions', '.staging')
}

async function createActionOutputPaths(workspaceValue: string, actionId: string): Promise<ActionOutputPaths> {
  if (typeof workspaceValue !== 'string' || !isAbsolute(workspaceValue)) throw new AgentMcpBrokerError('sandbox_unavailable')
  let workspace: string
  try {
    workspace = await realpath(workspaceValue)
    const rootInfo = await lstat(workspace)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new AgentMcpBrokerError('sandbox_unavailable')
    const workflows = join(workspace, 'Workflows')
    const finalRoot = join(workflows, 'agent-actions')
    const finalDir = join(finalRoot, actionId)
    const stagingRoot = agentMcpWorkspaceStagingRoot(workspace)
    await ensureDirectory(workflows)
    await ensureDirectory(finalRoot)
    await ensureDirectory(stagingRoot, 0o700)
    const stagingInfo = await lstat(stagingRoot)
    if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink() || (stagingInfo.mode & 0o077) !== 0) {
      throw new AgentMcpBrokerError('sandbox_unavailable')
    }
    if (isOutside(workspace, finalDir) || isOutside(workspace, finalRoot)) {
      throw new AgentMcpBrokerError('sandbox_unavailable')
    }
    try {
      await lstat(finalDir)
      throw new AgentMcpBrokerError('sandbox_unavailable')
    } catch (error) {
      if (error instanceof AgentMcpBrokerError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { workspace, finalRoot, finalDir, stagingRoot }
  } catch (error) {
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError('sandbox_unavailable', error)
  }
}

async function createRelativeOutputStage(
  paths: ActionOutputPaths,
  candidate: DiscoveredMcpTool,
  actionId: string,
): Promise<RelativeOutputStage> {
  return createRelativeOutputStageForPolicies(paths, candidate.tool.artifact.allowed, actionId)
}

async function createRelativeOutputStageForPolicies(
  paths: ActionOutputPaths,
  policies: readonly Readonly<{ path?: string, maxBytes: number }>[],
  actionId: string,
): Promise<RelativeOutputStage> {
  const slots: OpenMcpOutputFile[] = []
  let stageDir: string | undefined
  try {
    stageDir = await mkdtemp(join(paths.stagingRoot, `${actionId}-`))
    const outputDir = join(stageDir, 'output')
    await mkdir(outputDir, { mode: 0o700 })
    for (const policy of policies) {
      if (!policy.path || typeof constants.O_NOFOLLOW !== 'number') throw new AgentMcpBrokerError('sandbox_unavailable')
      const hostPath = join(outputDir, ...policy.path.split('/'))
      if (isOutside(outputDir, hostPath)) throw new AgentMcpBrokerError('sandbox_unavailable')
      await mkdir(dirname(hostPath), { recursive: true, mode: 0o700 })
      const handle = await open(
        hostPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      const identity = await handle.stat({ bigint: true })
      if (!identity.isFile() || identity.nlink !== 1n || identity.size !== 0n || Number(identity.mode & 0o777n) !== 0o600) {
        await handle.close().catch(() => undefined)
        throw new AgentMcpBrokerError('sandbox_unavailable')
      }
      slots.push({ path: policy.path, hostPath, maxBytes: policy.maxBytes, handle, identity })
    }
    return { stageDir, outputDir, slots }
  } catch (error) {
    await closeHandles(slots.map((slot) => slot.handle))
    if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError('sandbox_unavailable', error)
  }
}

async function closeRelativeOutputStage(stage: RelativeOutputStage | undefined): Promise<void> {
  if (!stage) return
  await closeHandles(stage.slots.map((slot) => slot.handle))
}

async function revalidateRelativeOutputSlots(stage: RelativeOutputStage): Promise<void> {
  for (const slot of stage.slots) {
    const handleInfo = await slot.handle.stat({ bigint: true })
    const pathInfo = await lstat(slot.hostPath, { bigint: true })
    const sameAuthority = (info: BigIntStats): boolean => info.isFile()
      && info.dev === slot.identity.dev && info.ino === slot.identity.ino
      && info.uid === slot.identity.uid && info.gid === slot.identity.gid
      && info.nlink === 1n && Number(info.mode & 0o777n) === 0o600
    if (!sameAuthority(handleInfo) || !sameAuthority(pathInfo) || handleInfo.size !== pathInfo.size
      || handleInfo.mtimeNs !== pathInfo.mtimeNs || handleInfo.size > BigInt(slot.maxBytes)) {
      throw new AgentMcpBrokerError(handleInfo.size > BigInt(slot.maxBytes) ? 'artifact_too_large' : 'invalid_result')
    }
  }
}

export function buildBubblewrapLaunch(input: {
  platform: NodeJS.Platform
  bwrapFd: number
  executableFd: number
  runtimeFiles: readonly Readonly<{ path: string, fd: number }>[]
  inputFiles?: readonly Readonly<{ path: string, fd: number }>[]
  hostRuntime?: Readonly<{ rootFd: number, executable: string }>
  outputFiles?: readonly Readonly<{ path: string, fd: number }>[]
  prlimitFd?: number
  processFileSizeLimitBytes?: number
  executable: string
  entrypoint?: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  systemPaths: readonly string[]
}): BubblewrapLaunch {
  const safeRuntimePath = (value: string): string => {
    if (typeof value !== 'string' || value.length < 1 || value.length > 512 || isAbsolute(value)
      || value.includes('\\') || /[\0\r\n]/.test(value)) {
      throw new AgentMcpBrokerError('sandbox_unavailable')
    }
    const segments = value.split('/')
    if (segments.some((segment) => segment.length < 1 || segment === '.' || segment === '..')) {
      throw new AgentMcpBrokerError('sandbox_unavailable')
    }
    return segments.join('/')
  }
  const executable = safeRuntimePath(input.executable)
  const runtimeFiles = input.runtimeFiles.map((file) => ({ path: safeRuntimePath(file.path), fd: file.fd }))
  const inputFiles = (input.inputFiles ?? []).map((file, index) => {
    if (file.path !== `/input/${index}`) throw new AgentMcpBrokerError('sandbox_unavailable')
    return { path: file.path, fd: file.fd }
  })
  const hostRuntime = input.hostRuntime === undefined ? undefined : {
    rootFd: input.hostRuntime.rootFd,
    executable: safeRuntimePath(input.hostRuntime.executable),
  }
  const outputFiles = (input.outputFiles ?? []).map((file) => ({ path: safeRuntimePath(file.path), fd: file.fd }))
  const inheritedFds = [
    input.bwrapFd, input.executableFd, ...runtimeFiles.map((file) => file.fd),
    ...(hostRuntime ? [hostRuntime.rootFd] : []),
    ...inputFiles.map((file) => file.fd),
    ...outputFiles.map((file) => file.fd),
    ...(input.prlimitFd === undefined ? [] : [input.prlimitFd]),
  ]
  const hasBoundOutputs = outputFiles.length > 0
  const processFileSizeLimit = input.processFileSizeLimitBytes
  if (input.platform !== 'linux' || inheritedFds.some((fd) => !Number.isSafeInteger(fd) || fd < 3)
    || new Set(inheritedFds).size !== inheritedFds.length
    || inheritedFds.length > MCP_MAX_INHERITED_FDS
    || new Set(runtimeFiles.map((file) => file.path)).size !== runtimeFiles.length
    || new Set(outputFiles.map((file) => file.path)).size !== outputFiles.length
    || hasBoundOutputs !== (input.prlimitFd !== undefined)
    || hasBoundOutputs !== (processFileSizeLimit !== undefined)
    || (processFileSizeLimit !== undefined && (!Number.isSafeInteger(processFileSizeLimit)
      || processFileSizeLimit < 1 || processFileSizeLimit > SANDBOX_TMPFS_BYTES))
    || (input.entrypoint !== undefined && !runtimeFiles.some((file) => file.path === input.entrypoint))) {
    throw new AgentMcpBrokerError('sandbox_unavailable')
  }
  const entrypoint = input.entrypoint === undefined ? undefined : safeRuntimePath(input.entrypoint)
  const runtimeDirectories = new Set<string>(['/app'])
  for (const file of runtimeFiles) {
    const segments = file.path.split('/').slice(0, -1)
    let directory = '/app'
    for (const segment of segments) {
      directory = `${directory}/${segment}`
      runtimeDirectories.add(directory)
    }
  }
  const args = [
    '--die-with-parent', '--unshare-all', '--unshare-user', '--disable-userns',
    '--proc', '/proc', '--dev', '/dev',
    '--size', String(SANDBOX_TMPFS_BYTES), '--tmpfs', '/tmp',
    '--size', String(SANDBOX_TMPFS_BYTES), '--tmpfs', '/home', '--dir', '/home/modly',
    '--size', String(SANDBOX_TMPFS_BYTES), '--tmpfs', '/output',
    '--dir', '/input', '--dir', '/run', '--dir', '/run/modly',
  ]
  for (const directory of [...runtimeDirectories].sort((left, right) => (
    left.split('/').length - right.split('/').length || left.localeCompare(right)
  ))) args.push('--dir', directory)
  // These read-only host paths are the explicit runtime/loader trusted
  // computing base. Extension-owned code and resources are never mounted from
  // the extension directory; they are bound individually from verified FDs.
  for (const path of input.systemPaths) {
    if (!isAbsolute(path)) throw new AgentMcpBrokerError('sandbox_unavailable')
    args.push('--ro-bind', path, path)
  }
  args.push(
    '--ro-bind-fd', String(input.executableFd), '/run/modly/executable',
  )
  for (const file of runtimeFiles) args.push('--ro-bind-fd', String(file.fd), `/app/${file.path}`)
  for (const file of inputFiles) args.push('--ro-bind-fd', String(file.fd), file.path)
  if (hostRuntime) {
    args.push('--dir', '/runtime', '--ro-bind', `/proc/self/fd/${hostRuntime.rootFd}`, '/runtime')
  }
  const outputDirectories = new Set<string>()
  for (const file of outputFiles) {
    const segments = file.path.split('/').slice(0, -1)
    let directory = '/output'
    for (const segment of segments) {
      directory = `${directory}/${segment}`
      outputDirectories.add(directory)
    }
  }
  for (const directory of [...outputDirectories].sort((left, right) => (
    left.split('/').length - right.split('/').length || left.localeCompare(right)
  ))) args.push('--dir', directory)
  for (const file of outputFiles) args.push('--bind-fd', String(file.fd), `/output/${file.path}`)
  args.push(
    '--chdir', '/app',
    '--clearenv',
    '--setenv', 'HOME', '/home/modly',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'LC_ALL', 'C.UTF-8',
  )
  for (const [key, value] of Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right))) {
    args.push('--setenv', key, value)
  }
  if (hostRuntime) args.push('--setenv', 'MODLY_HOST_RUNTIME_EXECUTABLE', `/runtime/${hostRuntime.executable}`)
  args.push(
    '--argv0', `/app/${executable}`,
    '--',
    '/run/modly/executable',
    ...(entrypoint ? [`/app/${entrypoint}`] : []),
    ...input.args,
  )
  if (input.prlimitFd !== undefined && processFileSizeLimit !== undefined) {
    // RLIMIT_FSIZE is one process-wide ceiling applied uniformly to every file
    // the server writes; it cannot encode the authoritative maxBytes of each
    // declared output slot. The aggregate contract provides the early hard
    // ceiling, while post-exit slot and aggregate checks decide acceptance.
    return {
      command: `/proc/self/fd/${input.prlimitFd}`,
      args: [
        `--fsize=${processFileSizeLimit}:${processFileSizeLimit}`,
        '--', `/proc/self/fd/${input.bwrapFd}`, ...args,
      ],
      env: { ...FIXED_HOST_ENV }, cwd: '/', shell: false,
    }
  }
  return { command: `/proc/self/fd/${input.bwrapFd}`, args, env: { ...FIXED_HOST_ENV }, cwd: '/', shell: false }
}

async function existingSystemPaths(paths: readonly string[]): Promise<string[]> {
  const result: string[] = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (!info.isDirectory() && !info.isFile()) throw new AgentMcpBrokerError('sandbox_unavailable')
      result.push(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!result.includes('/usr')) throw new AgentMcpBrokerError('sandbox_unavailable')
  return result
}

async function hashOpenFile(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk)
  return hash.digest('hex')
}

async function openTrustedExecutable(path: string): Promise<FileHandle> {
  if (!isAbsolute(path) || typeof constants.O_NOFOLLOW !== 'number') {
    throw new AgentMcpBrokerError('sandbox_unavailable')
  }
  const pathInfo = await lstat(path)
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new AgentMcpBrokerError('sandbox_unavailable')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || (before.mode & 0o111) === 0 || (before.mode & 0o002) !== 0) {
      throw new AgentMcpBrokerError('sandbox_unavailable')
    }
    await hashOpenFile(handle)
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new AgentMcpBrokerError('sandbox_unavailable')
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function openVerifiedLaunchFile(identity: McpExecutableIdentity): Promise<FileHandle> {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new AgentMcpBrokerError('capability_stale')
  const handle = await open(identity.realPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    const size = Number(before.size)
    if (!before.isFile() || size !== identity.size || before.uid !== identity.uid || before.gid !== identity.gid
      || (before.mode & 0o7777) !== identity.mode || (before.mode & 0o002) !== 0) {
      throw new AgentMcpBrokerError('capability_stale')
    }
    const sha256 = await hashOpenFile(handle)
    const after = await handle.stat()
    if (sha256 !== identity.sha256 || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new AgentMcpBrokerError('capability_stale')
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError('capability_stale', error)
  }
}

async function closeHandles(handles: readonly FileHandle[]): Promise<void> {
  await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)))
}

function inputStatMatches(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile()
    && left.dev === right.dev && left.ino === right.ino
    && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs
}

async function assertNoSymlinkInputPath(workspace: string, workspacePath: string): Promise<string> {
  let cursor = workspace
  try {
    for (const [index, segment] of workspacePath.split('/').entries()) {
      cursor = join(cursor, segment)
      const info = await lstat(cursor)
      if (info.isSymbolicLink() || (index < workspacePath.split('/').length - 1 ? !info.isDirectory() : !info.isFile())) {
        throw new AgentMcpBrokerError('invalid_arguments')
      }
    }
    if (isOutside(workspace, cursor) || await realpath(cursor) !== cursor) throw new AgentMcpBrokerError('invalid_arguments')
    return cursor
  } catch (error) {
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError('invalid_arguments', error)
  }
}

async function openMcpInputArtifacts(
  workspace: string,
  candidate: DiscoveredMcpTool,
  argumentsValue: JsonValue,
  refs: readonly ArtifactRefV1[],
  signal: AbortSignal,
): Promise<{ argumentsValue: JsonValue, inputs: OpenMcpInputArtifact[] }> {
  const declarations = candidate.tool.inputArtifacts
  if (declarations.length !== refs.length || declarations.length > 16
    || refs.reduce((total, ref) => total + ref.sizeBytes, 0) > 512 * 1024 * 1024
    || !isPlainRecord(argumentsValue)) throw new AgentMcpBrokerError('invalid_arguments')
  const normalized = JSON.parse(canonicalJson(argumentsValue)) as Record<string, JsonValue>
  const inputs: OpenMcpInputArtifact[] = []
  try {
    for (const [index, binding] of declarations.entries()) {
      if (signal.aborted) throw new AgentMcpBrokerError('cancelled')
      const ref = assertArtifactRefV1(refs[index])
      if (normalized[binding.argument] !== ref.id || ref.kind !== binding.kind
        || !binding.mediaTypes.includes(ref.mediaType)) throw new AgentMcpBrokerError('invalid_arguments')
      const source = await assertNoSymlinkInputPath(workspace, ref.workspacePath)
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
      const before = await handle.stat({ bigint: true })
      inputs.push({ binding, ref, handle, identity: before })
      if (!before.isFile() || before.size !== BigInt(ref.sizeBytes) || await hashOpenFile(handle) !== ref.sha256) {
        throw new AgentMcpBrokerError('capability_stale')
      }
      const after = await handle.stat({ bigint: true })
      if (!inputStatMatches(before, after)) throw new AgentMcpBrokerError('capability_stale')
      normalized[binding.argument] = binding.sandboxPath
    }
    return { argumentsValue: normalized, inputs }
  } catch (error) {
    await closeHandles(inputs.map((input) => input.handle))
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError('capability_stale', error)
  }
}

async function revalidateMcpInputArtifacts(inputs: readonly OpenMcpInputArtifact[]): Promise<void> {
  for (const input of inputs) {
    const before = await input.handle.stat({ bigint: true })
    if (!inputStatMatches(before, input.identity) || await hashOpenFile(input.handle) !== input.ref.sha256) {
      throw new AgentMcpBrokerError('capability_stale')
    }
    const after = await input.handle.stat({ bigint: true })
    if (!inputStatMatches(before, after)) throw new AgentMcpBrokerError('capability_stale')
  }
}

async function executeSandboxProbe(
  launch: BubblewrapLaunch,
  inheritedHandles: readonly FileHandle[],
  timeoutMs: number,
  validate?: () => Promise<boolean>,
): Promise<boolean> {
  let child: ChildProcess | undefined
  let exitPromise: Promise<{ code: number | null, signal: NodeJS.Signals | null }> | undefined
  let startTime: string | undefined
  try {
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd, env: launch.env, shell: launch.shell, detached: true,
      stdio: ['ignore', 'ignore', 'pipe', ...inheritedHandles.map((handle) => handle.fd)],
    })
    let stderrBytes = 0
    child.stderr?.on('data', (chunk: Buffer | string) => { stderrBytes += Buffer.byteLength(chunk) })
    exitPromise = new Promise((resolveExit, rejectExit) => {
      child?.once('error', rejectExit)
      child?.once('close', (code, signal) => resolveExit({ code, signal }))
    })
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child?.once('spawn', resolveSpawn)
      child?.once('error', rejectSpawn)
    })
    if (child.pid !== undefined) {
      const identity = await readLinuxProcessGroupIdentity(child.pid)
      if (identity?.pgrp === child.pid) startTime = identity.startTime
    }
    const outcome = await Promise.race([
      exitPromise,
      delay(timeoutMs).then(() => null),
    ])
    if (outcome === null || outcome.code !== 0 || outcome.signal !== null || stderrBytes > MAX_CONTENT_BYTES) return false
    return validate ? await validate() : true
  } catch {
    return false
  } finally {
    if (child?.pid !== undefined) {
      try { await signalOwnedProcessGroup(child.pid, startTime, 'SIGTERM') } catch { /* readiness remains false */ }
      const exited = exitPromise
        ? await Promise.race([exitPromise.then(() => true), delay(25).then(() => false)]).catch(() => false)
        : true
      if (!exited) {
        try { await signalOwnedProcessGroup(child.pid, startTime, 'SIGKILL') } catch { /* readiness remains false */ }
      }
    }
    if (exitPromise) {
      await Promise.race([exitPromise.catch(() => undefined), delay(PROCESS_REAP_TIMEOUT_MS)])
    }
    await closeHandles(inheritedHandles)
  }
}

async function runBasicSandboxProbe(options: AgentMcpSandboxReadinessOptions): Promise<boolean> {
  const handles: FileHandle[] = []
  try {
    const systemPaths = await existingSystemPaths(options.systemPaths ?? ['/usr', '/bin', '/lib', '/lib64'])
    handles.push(await openTrustedExecutable(options.bwrapPath ?? '/usr/bin/bwrap'))
    const truePath = await realpath('/usr/bin/true').catch(async () => realpath('/bin/true'))
    handles.push(await openTrustedExecutable(truePath))
    handles.push(await openTrustedExecutable(truePath))
    const launch = buildBubblewrapLaunch({
      platform: 'linux',
      bwrapFd: 3,
      executableFd: 4,
      runtimeFiles: [{ path: 'probe-resource', fd: 5 }],
      executable: 'probe',
      args: [],
      env: {},
      systemPaths,
    })
    return await executeSandboxProbe(
      launch, handles, options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    )
  } finally {
    await closeHandles(handles)
  }
}

async function missingReadinessDirectories(workspaceValue: string): Promise<string[]> {
  const workspace = await realpath(workspaceValue)
  const candidates = [
    join(workspace, 'Workflows'),
    join(workspace, 'Workflows', 'agent-actions'),
    agentMcpWorkspaceStagingRoot(workspace),
  ]
  const missing: string[] = []
  for (const candidate of candidates) {
    try {
      await lstat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(candidate)
    }
  }
  return missing.reverse()
}

async function runRelativeFilesSandboxProbe(options: AgentMcpSandboxReadinessOptions): Promise<boolean> {
  if (!options.getWorkspaceRoot) return false
  const handles: FileHandle[] = []
  let stage: RelativeOutputStage | undefined
  let cleanupDirectories: string[] = []
  try {
    const workspaceValue = await options.getWorkspaceRoot()
    cleanupDirectories = await missingReadinessDirectories(workspaceValue)
    const actionId = `readiness-probe-${process.pid}-${Date.now()}`
    const paths = await createActionOutputPaths(workspaceValue, actionId)
    stage = await createRelativeOutputStageForPolicies(paths, [
      { path: 'probe-output-a', maxBytes: 1_024 },
      { path: 'probe-output-b', maxBytes: 1_024 },
    ], actionId)
    if (stage.slots.length !== 2) return false

    const systemPaths = await existingSystemPaths(options.systemPaths ?? ['/usr', '/bin', '/lib', '/lib64'])
    const bwrapHandle = await openTrustedExecutable(options.bwrapPath ?? '/usr/bin/bwrap')
    const shellPath = await realpath('/usr/bin/sh').catch(async () => realpath('/bin/sh'))
    const shellHandle = await openTrustedExecutable(shellPath)
    const truePath = await realpath('/usr/bin/true').catch(async () => realpath('/bin/true'))
    const resourceHandle = await openTrustedExecutable(truePath)
    const prlimitHandle = await openTrustedExecutable(options.prlimitPath ?? '/usr/bin/prlimit')
    handles.push(bwrapHandle, shellHandle, resourceHandle, ...stage.slots.map((slot) => slot.handle), prlimitHandle)
    const launch = buildBubblewrapLaunch({
      platform: 'linux',
      bwrapFd: 3,
      executableFd: 4,
      runtimeFiles: [{ path: 'probe-resource', fd: 5 }],
      outputFiles: stage.slots.map((slot, index) => ({ path: slot.path, fd: index + 6 })),
      prlimitFd: 8,
      processFileSizeLimitBytes: stage.slots.reduce((total, slot) => total + slot.maxBytes, 0),
      executable: 'probe',
      args: ['-c', 'printf x > /output/probe-output-a; printf y > /output/probe-output-b'],
      env: {},
      systemPaths,
    })
    return await executeSandboxProbe(
      launch,
      handles,
      options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      async () => {
        if (!stage) return false
        await revalidateRelativeOutputSlots(stage)
        for (const [index, output] of stage.slots.entries()) {
          const info = await output.handle.stat({ bigint: true })
          if (info.size !== 1n) return false
          const byte = Buffer.alloc(1)
          const { bytesRead } = await output.handle.read(byte, 0, 1, 0)
          if (bytesRead !== 1 || byte[0] !== 0x78 + index) return false
        }
        return true
      },
    )
  } catch {
    return false
  } finally {
    await closeHandles(handles)
    await closeRelativeOutputStage(stage)
    if (stage) await rm(stage.stageDir, { recursive: true, force: true }).catch(() => undefined)
    for (const directory of cleanupDirectories) await rmdir(directory).catch(() => undefined)
  }
}

async function runSandboxProbe(
  options: AgentMcpSandboxReadinessOptions,
  profile: AgentMcpSandboxProfile,
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== 'linux') return false
  return profile === 'relative-files-v1'
    ? runRelativeFilesSandboxProbe(options)
    : runBasicSandboxProbe(options)
}

export function createAgentMcpSandboxReadiness(
  options: AgentMcpSandboxReadinessOptions = {},
): AgentMcpSandboxReadiness {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 1) throw new TypeError('MCP readiness cache TTL must be positive')
  const cached = new Map<AgentMcpSandboxProfile, { expiresAt: number, ready: boolean }>()
  const pending = new Map<AgentMcpSandboxProfile, Promise<boolean>>()
  return async (profile = 'artifact-v1'): Promise<boolean> => {
    const now = Date.now()
    const cachedProfile = cached.get(profile)
    if (cachedProfile && cachedProfile.expiresAt > now) return cachedProfile.ready
    const pendingProfile = pending.get(profile)
    if (pendingProfile) return pendingProfile
    const probe = (options.probe ? options.probe(profile) : runSandboxProbe(options, profile))
      .then((ready) => ready === true)
      .catch(() => false)
    pending.set(profile, probe)
    try {
      const ready = await probe
      cached.set(profile, { ready, expiresAt: Date.now() + cacheTtlMs })
      return ready
    } finally {
      pending.delete(profile)
    }
  }
}

function productionTransportFactory(options: AgentMcpExecutorOptions): McpTransportFactory {
  return async ({ binding, inputFiles, outputFiles }) => {
    const platform = options.platform ?? process.platform
    const bwrapPath = options.bwrapPath ?? '/usr/bin/bwrap'
    if (platform !== 'linux') throw new AgentMcpBrokerError('sandbox_unavailable')
    const systemPaths = await existingSystemPaths(options.systemPaths ?? ['/usr', '/bin', '/lib', '/lib64'])
    const ownedHandles: FileHandle[] = []
    let hostRuntime: OpenAgentHostRuntime | undefined
    try {
      ownedHandles.push(await openTrustedExecutable(bwrapPath))
      ownedHandles.push(await openVerifiedLaunchFile(binding.server.executable))
      for (const runtimeFile of binding.server.runtimeFiles) {
        ownedHandles.push(await openVerifiedLaunchFile(runtimeFile))
      }
      const inheritedHandles: FileHandle[] = [...ownedHandles]
      let nextFd = 3 + inheritedHandles.length
      let hostRuntimeLaunch: { rootFd: number, executable: string } | undefined
      if (binding.server.hostRuntime) {
        hostRuntime = await openBoundAgentHostRuntime(binding.server.hostRuntime)
        hostRuntimeLaunch = { rootFd: nextFd, executable: binding.server.hostRuntime.executable.relativePath }
        inheritedHandles.push(hostRuntime.rootHandle)
        nextFd += 1
      }
      const inputLaunch = inputFiles.map((input) => {
        const result = { path: input.binding.sandboxPath, fd: nextFd }
        inheritedHandles.push(input.handle)
        nextFd += 1
        return result
      })
      const outputLaunch: Array<{ path: string, fd: number }> = []
      let prlimitFd: number | undefined
      if (binding.server.artifactOutput.profile === 'relative-files-v1') {
        if (!outputFiles || outputFiles.length !== binding.server.tools.find((tool) => tool.name === binding.tool.name)?.artifact.allowed.length) {
          throw new AgentMcpBrokerError('sandbox_unavailable')
        }
        for (const output of outputFiles) {
          outputLaunch.push({ path: output.path, fd: nextFd })
          inheritedHandles.push(output.handle)
          nextFd += 1
        }
        const prlimitHandle = await openTrustedExecutable(options.prlimitPath ?? '/usr/bin/prlimit')
        ownedHandles.push(prlimitHandle)
        inheritedHandles.push(prlimitHandle)
        prlimitFd = nextFd
        nextFd += 1
      } else if (outputFiles?.length) {
        throw new AgentMcpBrokerError('sandbox_unavailable')
      }
      const launch = buildBubblewrapLaunch({
        platform,
        bwrapFd: 3,
        executableFd: 4,
        runtimeFiles: binding.server.runtimeFiles.map((file, index) => ({ path: file.declaredPath, fd: index + 5 })),
        inputFiles: inputLaunch,
        ...(hostRuntimeLaunch ? { hostRuntime: hostRuntimeLaunch } : {}),
        ...(outputLaunch.length ? {
          outputFiles: outputLaunch,
          prlimitFd,
          processFileSizeLimitBytes: binding.server.artifactOutput.maxTotalBytes,
        } : {}),
        executable: binding.server.command.executable,
        entrypoint: binding.server.command.entrypoint,
        args: binding.server.command.args,
        env: binding.server.command.env,
        systemPaths,
      })
      const transport = new OwnedStdioTransport({
        ...launch, inheritedHandles, ownsInheritedHandles: false,
      })
      let closed = false
      const finalize = async (): Promise<void> => {
        if (closed) return
        closed = true
        let failure: unknown
        try {
          await transport.close()
          await revalidateMcpInputArtifacts(inputFiles)
          if (hostRuntime) await revalidateOpenAgentHostRuntime(hostRuntime)
        } catch (error) { failure = error }
        await closeHandles(ownedHandles)
        await closeOpenAgentHostRuntime(hostRuntime)
        if (failure) throw failure
      }
      return { transport, cancel: finalize, close: finalize, revalidate: async () => {
        await revalidateMcpInputArtifacts(inputFiles)
        if (hostRuntime) await revalidateOpenAgentHostRuntime(hostRuntime)
      } }
    } catch (error) {
      await closeHandles(ownedHandles)
      await closeOpenAgentHostRuntime(hostRuntime)
      if (error instanceof AgentMcpBrokerError) throw error
      throw new AgentMcpBrokerError('sandbox_unavailable', error)
    }
  }
}

async function revalidateBinding(
  discoveryOptions: AgentMcpExecutorOptions['discovery'],
  candidate: DiscoveredMcpTool,
): Promise<DiscoveredMcpTool> {
  try {
    const discovery = await discoverGovernedMcpTools(discoveryOptions)
    const matches = discovery.tools.filter((entry) => entry.tool.capabilityId === candidate.tool.capabilityId)
    if (matches.length !== 1) throw new AgentMcpBrokerError('capability_stale')
    const refreshed = matches[0]
    if (refreshed.server.id !== candidate.server.id || refreshed.tool.name !== candidate.tool.name
      || refreshed.tool.capabilityBindingHash !== candidate.tool.capabilityBindingHash
      || refreshed.server.capabilityBindingHash !== candidate.server.capabilityBindingHash) {
      throw new AgentMcpBrokerError('capability_stale')
    }
    return refreshed
  } catch (error) {
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError('capability_stale', error)
  }
}

function assertServerCapabilities(client: Client): void {
  const capabilities = client.getServerCapabilities()
  if (!capabilities || !isPlainRecord(capabilities)) throw new AgentMcpBrokerError('protocol_error')
  if (Object.keys(capabilities).some((key) => key !== 'tools') || !isPlainRecord(capabilities.tools)) {
    throw new AgentMcpBrokerError('protocol_error')
  }
  if (client.getInstructions() !== undefined) throw new AgentMcpBrokerError('protocol_error')
}

async function verifyToolInventory(client: Client, server: BoundMcpServer, signal: AbortSignal, timeout: number): Promise<void> {
  const listed: Array<{ name: string, inputSchema: unknown, outputSchema?: unknown, execution?: unknown }> = []
  let cursor: string | undefined
  for (let page = 0; page < 16; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout, maxTotalTimeout: timeout })
    listed.push(...result.tools)
    cursor = result.nextCursor
    if (!cursor) break
    if (page === 15) throw new AgentMcpBrokerError('schema_drift')
  }
  const declaredByName = new Map(server.tools.map((tool) => [tool.name, tool]))
  if (listed.length !== declaredByName.size || new Set(listed.map((tool) => tool.name)).size !== listed.length) {
    throw new AgentMcpBrokerError('schema_drift')
  }
  for (const actual of listed) {
    const declared = declaredByName.get(actual.name)
    if (!declared || actual.execution !== undefined
      || sha256Canonical(actual.inputSchema) !== declared.inputSchemaHash
      || (actual.outputSchema === undefined ? undefined : sha256Canonical(actual.outputSchema)) !== declared.outputSchemaHash) {
      throw new AgentMcpBrokerError('schema_drift')
    }
  }
}

function validateContent(result: Record<string, unknown>): void {
  if (!Array.isArray(result.content) || result.content.length > 32) throw new AgentMcpBrokerError('invalid_result')
  let bytes = 0
  for (const entryValue of result.content) {
    const entry = exactRecord(entryValue, ['type', 'text'])
    if (entry.type !== 'text' || typeof entry.text !== 'string') {
      throw new AgentMcpBrokerError('invalid_result')
    }
    bytes += Buffer.byteLength(entry.text, 'utf8')
    if (bytes > MAX_TEXT_CONTENT_BYTES) throw new AgentMcpBrokerError('invalid_result')
  }
  if (result.isError === true || 'toolResult' in result) throw new AgentMcpBrokerError('invalid_result')
}

function assertWithinDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new AgentMcpBrokerError('timeout')
}

interface ValidatedArtifactDescriptor {
  id: string
  name: string
  kind: ArtifactRefV1['kind']
  mediaType: string
  sha256: string
  dataBase64: string
  sizeBytes: number
}

function decodedBase64Size(value: string): number {
  if (value.length < 4 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AgentMcpBrokerError('invalid_result')
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const size = (value.length / 4) * 3 - padding
  if (!Number.isSafeInteger(size) || size < 1) throw new AgentMcpBrokerError('invalid_result')
  if (size > MAX_ARTIFACT_BYTES) throw new AgentMcpBrokerError('artifact_too_large')
  return size
}

function validateArtifactDescriptor(
  descriptorValue: unknown,
  candidate: DiscoveredMcpTool,
): ValidatedArtifactDescriptor {
  const descriptor = exactRecord(descriptorValue, ['id', 'name', 'kind', 'mediaType', 'sha256', 'dataBase64'])
  const policy = candidate.tool.artifact.allowed.find((entry) => entry.kind === descriptor.kind
    && typeof descriptor.mediaType === 'string' && entry.mediaTypes.includes(descriptor.mediaType))
  if (!policy
    || typeof descriptor.mediaType !== 'string'
    || candidate.tool.artifact.profile !== 'artifact-v1') {
    throw new AgentMcpBrokerError('invalid_result')
  }
  if (typeof descriptor.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(descriptor.id)
    || typeof descriptor.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(descriptor.name)
    || descriptor.name === '.' || descriptor.name === '..'
    || typeof descriptor.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.sha256)
    || typeof descriptor.dataBase64 !== 'string') {
    throw new AgentMcpBrokerError('invalid_result')
  }
  const sizeBytes = decodedBase64Size(descriptor.dataBase64)
  if (sizeBytes > policy.maxBytes) throw new AgentMcpBrokerError('artifact_too_large')
  return {
    id: descriptor.id,
    name: descriptor.name,
    kind: descriptor.kind as ArtifactRefV1['kind'],
    mediaType: descriptor.mediaType,
    sha256: descriptor.sha256,
    dataBase64: descriptor.dataBase64,
    sizeBytes,
  }
}

async function writeEmbeddedArtifact(
  descriptor: ValidatedArtifactDescriptor,
  paths: ActionOutputPaths,
  publishDir: string,
  signal: AbortSignal,
  deadline: number,
): Promise<ArtifactRefV1> {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new AgentMcpBrokerError('invalid_result')
  const destination = join(publishDir, descriptor.name)
  let destinationHandle: FileHandle | undefined
  try {
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    const hash = createHash('sha256')
    let bytePosition = 0
    for (let base64Position = 0; base64Position < descriptor.dataBase64.length;) {
      if (signal.aborted) throw new AgentMcpBrokerError('cancelled')
      assertWithinDeadline(deadline)
      const remaining = descriptor.dataBase64.length - base64Position
      const encodedLength = Math.min(ARTIFACT_COPY_CHUNK_BYTES, remaining)
      const encoded = descriptor.dataBase64.slice(base64Position, base64Position + encodedLength)
      const decoded = Buffer.from(encoded, 'base64')
      if (decoded.byteLength < 1 || decoded.toString('base64') !== encoded
        || bytePosition + decoded.byteLength > descriptor.sizeBytes) {
        throw new AgentMcpBrokerError('invalid_result')
      }
      let written = 0
      while (written < decoded.byteLength) {
        const result = await destinationHandle.write(decoded, written, decoded.byteLength - written, bytePosition + written)
        if (result.bytesWritten < 1) throw new AgentMcpBrokerError('invalid_result')
        written += result.bytesWritten
      }
      hash.update(decoded)
      bytePosition += decoded.byteLength
      base64Position += encodedLength
    }
    if (bytePosition !== descriptor.sizeBytes || hash.digest('hex') !== descriptor.sha256) {
      throw new AgentMcpBrokerError('invalid_result')
    }
    await destinationHandle.sync()
    const workspacePath = relative(paths.workspace, join(paths.finalDir, descriptor.name)).split(sep).join('/')
    return assertArtifactRefV1({
      schema: 'modly.artifact-ref.v1',
      version: 1,
      id: descriptor.id,
      kind: descriptor.kind,
      mediaType: descriptor.mediaType,
      workspacePath,
      sha256: descriptor.sha256,
      sizeBytes: descriptor.sizeBytes,
    })
  } catch (error) {
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError('invalid_result', error)
  } finally {
    await destinationHandle?.close().catch(() => undefined)
  }
}

async function publishResultArtifacts(
  resultValue: unknown,
  candidate: DiscoveredMcpTool,
  paths: ActionOutputPaths,
  signal: AbortSignal,
  deadline: number,
): Promise<{ artifacts: ArtifactRefV1[], rollback: () => Promise<void> }> {
  const result = exactRecord(resultValue, ['content', 'structuredContent', 'isError'])
  validateContent(result)
  const structured = validateStructuredOutput(candidate.tool.outputSchema, result.structuredContent)
  const record = exactRecord(structured, ['artifacts'])
  if (!Array.isArray(record.artifacts) || record.artifacts.length < 1
    || record.artifacts.length > Math.min(MAX_ARTIFACTS, candidate.tool.artifact.maxCount)) {
    throw new AgentMcpBrokerError('invalid_result')
  }
  const descriptors = record.artifacts.map((descriptor) => validateArtifactDescriptor(descriptor, candidate))
  if (new Set(descriptors.map((descriptor) => descriptor.id)).size !== descriptors.length
    || new Set(descriptors.map((descriptor) => descriptor.name)).size !== descriptors.length) {
    throw new AgentMcpBrokerError('invalid_result')
  }
  if (descriptors.reduce((total, descriptor) => total + descriptor.sizeBytes, 0)
    > Math.min(MAX_OUTPUT_BYTES, candidate.tool.artifact.maxTotalBytes)) {
    throw new AgentMcpBrokerError('artifact_too_large')
  }
  let publishDir: string | undefined
  let published = false
  try {
    publishDir = await mkdtemp(join(paths.finalRoot, `.${candidate.server.id}-publish-`))
    const artifacts: ArtifactRefV1[] = []
    for (const descriptor of descriptors) {
      artifacts.push(await writeEmbeddedArtifact(descriptor, paths, publishDir, signal, deadline))
    }
    if (signal.aborted) throw new AgentMcpBrokerError('cancelled')
    assertWithinDeadline(deadline)
    await rename(publishDir, paths.finalDir)
    publishDir = undefined
    published = true
    let rollbackPromise: Promise<void> | undefined
    const rollback = (): Promise<void> => {
      rollbackPromise ??= rm(paths.finalDir, { recursive: true, force: true })
      return rollbackPromise
    }
    return { artifacts, rollback }
  } catch (error) {
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError('invalid_result', error)
  } finally {
    if (publishDir) await rm(publishDir, { recursive: true, force: true }).catch(() => undefined)
    if (!published) await rm(paths.finalDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface RelativeFileDescriptor {
  id: string
  name: string
  kind: ArtifactRefV1['kind']
  mediaType: string
}

function validateRelativeFileDescriptors(
  resultValue: unknown,
  candidate: DiscoveredMcpTool,
): RelativeFileDescriptor[] {
  const result = exactRecord(resultValue, ['content', 'structuredContent', 'isError'])
  validateContent(result)
  const structured = validateStructuredOutput(candidate.tool.outputSchema, result.structuredContent)
  const record = exactRecord(structured, ['artifacts'])
  const contract = candidate.tool.artifact
  if (!Array.isArray(record.artifacts) || record.artifacts.length < 1 || record.artifacts.length > contract.maxCount) {
    throw new AgentMcpBrokerError('invalid_result')
  }
  const byPath = new Map(contract.allowed.map((policy) => [policy.path, policy]))
  const descriptors = record.artifacts.map((raw): RelativeFileDescriptor => {
    const descriptor = exactRecord(raw, ['id', 'name', 'kind', 'mediaType'])
    if (typeof descriptor.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(descriptor.id)
      || typeof descriptor.name !== 'string' || typeof descriptor.mediaType !== 'string') {
      throw new AgentMcpBrokerError('invalid_result')
    }
    const policy = byPath.get(descriptor.name)
    if (!policy || descriptor.kind !== policy.kind || !policy.mediaTypes.includes(descriptor.mediaType)) {
      throw new AgentMcpBrokerError('invalid_result')
    }
    return {
      id: descriptor.id, name: descriptor.name,
      kind: descriptor.kind as ArtifactRefV1['kind'], mediaType: descriptor.mediaType,
    }
  })
  if (new Set(descriptors.map((item) => item.id)).size !== descriptors.length
    || new Set(descriptors.map((item) => item.name)).size !== descriptors.length
    || contract.allowed.some((policy) => policy.required === true && !descriptors.some((item) => item.name === policy.path))) {
    throw new AgentMcpBrokerError('invalid_result')
  }
  return descriptors
}

async function listRelativeOutputFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new AgentMcpBrokerError('invalid_result')
      if (entry.isDirectory()) { await visit(join(directory, entry.name), path); continue }
      if (!entry.isFile()) throw new AgentMcpBrokerError('invalid_result')
      files.push(path)
    }
  }
  await visit(root, '')
  return files.sort()
}

async function copyVerifiedRelativeOutput(
  descriptor: RelativeFileDescriptor,
  candidate: DiscoveredMcpTool,
  stage: RelativeOutputStage,
  publishDir: string,
  paths: ActionOutputPaths,
  signal: AbortSignal,
  deadline: number,
): Promise<ArtifactRefV1> {
  const policy = candidate.tool.artifact.allowed.find((entry) => entry.path === descriptor.name)
  const slot = stage.slots.find((entry) => entry.path === descriptor.name)
  if (!policy || !slot || typeof constants.O_NOFOLLOW !== 'number') throw new AgentMcpBrokerError('invalid_result')
  const destination = join(publishDir, ...descriptor.name.split('/'))
  await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 })
  let sourceHandle: FileHandle | undefined
  let destinationHandle: FileHandle | undefined
  try {
    sourceHandle = slot.handle
    const before = await sourceHandle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n
      || before.dev !== slot.identity.dev || before.ino !== slot.identity.ino
      || before.uid !== slot.identity.uid || before.gid !== slot.identity.gid
      || Number(before.mode & 0o777n) !== 0o600) throw new AgentMcpBrokerError('invalid_result')
    const sizeBytes = Number(before.size)
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > policy.maxBytes) {
      throw new AgentMcpBrokerError('artifact_too_large')
    }
    destinationHandle = await open(
      destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600,
    )
    const hash = createHash('sha256')
    let total = 0
    for await (const chunk of sourceHandle.createReadStream({ autoClose: false, start: 0 })) {
      if (signal.aborted) throw new AgentMcpBrokerError('cancelled')
      assertWithinDeadline(deadline)
      const bytes = chunk as Buffer
      total += bytes.byteLength
      if (total > policy.maxBytes) throw new AgentMcpBrokerError('artifact_too_large')
      hash.update(bytes)
      let offset = 0
      while (offset < bytes.byteLength) {
        const write = await destinationHandle.write(bytes, offset, bytes.byteLength - offset)
        if (write.bytesWritten < 1) throw new AgentMcpBrokerError('invalid_result')
        offset += write.bytesWritten
      }
    }
    const after = await sourceHandle.stat({ bigint: true })
    if (total !== sizeBytes || !inputStatMatches(before, after)) throw new AgentMcpBrokerError('invalid_result')
    const sha256 = hash.digest('hex')
    await destinationHandle.sync()
    return assertArtifactRefV1({
      schema: 'modly.artifact-ref.v1', version: 1, id: descriptor.id,
      kind: descriptor.kind, mediaType: descriptor.mediaType,
      workspacePath: relative(paths.workspace, join(paths.finalDir, ...descriptor.name.split('/'))).split(sep).join('/'),
      sha256, sizeBytes,
    })
  } catch (error) {
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError('invalid_result', error)
  } finally {
    await destinationHandle?.close().catch(() => undefined)
  }
}

async function publishRelativeFileArtifacts(
  resultValue: unknown,
  candidate: DiscoveredMcpTool,
  paths: ActionOutputPaths,
  stage: RelativeOutputStage,
  signal: AbortSignal,
  deadline: number,
): Promise<{ artifacts: ArtifactRefV1[], rollback: () => Promise<void> }> {
  const descriptors = validateRelativeFileDescriptors(resultValue, candidate)
  const files = await listRelativeOutputFiles(stage.outputDir)
  if (files.length !== descriptors.length || files.some((file, index) => file !== [...descriptors.map((item) => item.name)].sort()[index])) {
    throw new AgentMcpBrokerError('invalid_result')
  }
  const publishDir = join(stage.stageDir, 'publish')
  await mkdir(publishDir, { mode: 0o700 })
  try {
    const artifacts: ArtifactRefV1[] = []
    for (const descriptor of descriptors) {
      artifacts.push(await copyVerifiedRelativeOutput(descriptor, candidate, stage, publishDir, paths, signal, deadline))
    }
    if (artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) > candidate.tool.artifact.maxTotalBytes) {
      throw new AgentMcpBrokerError('artifact_too_large')
    }
    if (signal.aborted) throw new AgentMcpBrokerError('cancelled')
    assertWithinDeadline(deadline)
    await rename(publishDir, paths.finalDir)
    let rollbackPromise: Promise<void> | undefined
    return {
      artifacts,
      rollback: () => {
        rollbackPromise ??= rm(paths.finalDir, { recursive: true, force: true })
        return rollbackPromise
      },
    }
  } catch (error) {
    await rm(paths.finalDir, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof AgentMcpBrokerError) throw error
    throw new AgentMcpBrokerError('invalid_result', error)
  }
}

function classifyMcpError(error: unknown, signal: AbortSignal): AgentMcpBrokerError {
  if (error instanceof AgentMcpBrokerError) return error
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return new AgentMcpBrokerError('cancelled', error)
  if (error instanceof Error && /timed?\s*out|timeout/i.test(`${error.name} ${error.message}`)) {
    return new AgentMcpBrokerError('timeout', error)
  }
  return new AgentMcpBrokerError('protocol_error', error)
}

export function createAgentMcpExecutor(options: AgentMcpExecutorOptions): AgentActionExecutor {
  const initializeTimeout = safePositiveTimeout(options.initializeTimeoutMs, DEFAULT_INITIALIZE_TIMEOUT_MS)
  const listTimeout = safePositiveTimeout(options.listTimeoutMs, DEFAULT_LIST_TIMEOUT_MS)
  const callTimeout = safePositiveTimeout(options.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS)
  const factory = options.transportFactory ?? productionTransportFactory(options)
  const production = options.transportFactory === undefined
  const readiness = production
    ? options.sandboxReadiness ?? createAgentMcpSandboxReadiness({
      platform: options.platform,
      bwrapPath: options.bwrapPath,
      prlimitPath: options.prlimitPath,
      systemPaths: options.systemPaths,
      getWorkspaceRoot: options.getWorkspaceRoot,
    })
    : undefined

  return async (request: AgentActionExecutorRequest): Promise<{
    artifacts: ArtifactRefV1[]
    rollback: () => Promise<void>
  }> => {
    if (request.capability.execution?.kind !== 'mcp_tool') throw new AgentMcpBrokerError('unsupported_capability')
    assertSafeActionId(request.actionId)
    if (request.signal.aborted) throw new AgentMcpBrokerError('cancelled')
    const discovery = await discoverGovernedMcpTools(options.discovery)
    const matches = discovery.tools.filter((candidate) => candidate.tool.capabilityId === request.capability.id)
    if (matches.length !== 1) throw new AgentMcpBrokerError('capability_stale')
    let candidate = matches[0]
    if (candidate.tool.capabilityBindingHash !== request.capability.execution.bindingHash
      || candidate.tool.inputSchemaHash !== request.capability.execution.inputSchemaHash
      || candidate.tool.outputSchemaHash !== request.capability.execution.outputSchemaHash) {
      throw new AgentMcpBrokerError('capability_stale')
    }
    const argumentsValue = validateMcpArguments(candidate.tool.inputSchema, request.arguments)
    if (readiness && !await readiness(candidate.server.artifactOutput.profile)) {
      throw new AgentMcpBrokerError('sandbox_unavailable')
    }
    const output = await createActionOutputPaths(await options.getWorkspaceRoot(), request.actionId)
    const relativeStage = candidate.tool.artifact.profile === 'relative-files-v1'
      ? await createRelativeOutputStage(output, candidate, request.actionId)
      : undefined
    let openedInputs: Awaited<ReturnType<typeof openMcpInputArtifacts>>
    try {
      openedInputs = await openMcpInputArtifacts(
        output.workspace, candidate, argumentsValue, request.inputArtifacts, request.signal,
      )
    } catch (error) {
      await closeRelativeOutputStage(relativeStage)
      if (relativeStage) await rm(relativeStage.stageDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    const executionDeadline = Math.min(
      Number.MAX_SAFE_INTEGER,
      Date.now() + initializeTimeout + listTimeout + callTimeout,
    )
    const executionSignal = request.signal
    let session: McpTransportSession | undefined
    let client: Client | undefined
    let success = false
    const abort = (): void => { void session?.cancel().catch(() => undefined) }
    executionSignal.addEventListener('abort', abort, { once: true })
    try {
      candidate = await revalidateBinding(options.discovery, candidate)
      await revalidateMcpInputArtifacts(openedInputs.inputs)
      session = await factory({
        binding: candidate, signal: executionSignal,
        inputFiles: openedInputs.inputs,
        ...(relativeStage ? { outputFiles: relativeStage.slots } : {}),
      })
      const transport = new BoundedTransport(session.transport)
      client = new Client(
        { name: 'modly-agent-mcp-broker', version: '1.0.0' },
        { capabilities: {} },
      )
      await client.connect(transport, {
        signal: executionSignal,
        timeout: initializeTimeout,
        maxTotalTimeout: initializeTimeout,
      })
      assertServerCapabilities(client)
      await verifyToolInventory(client, candidate.server, executionSignal, listTimeout)
      candidate = await revalidateBinding(options.discovery, candidate)
      if (candidate.tool.capabilityBindingHash !== request.capability.execution.bindingHash) {
        throw new AgentMcpBrokerError('capability_stale')
      }
      await revalidateMcpInputArtifacts(openedInputs.inputs)
      await session.revalidate?.()
      const result = await client.callTool(
        { name: candidate.tool.name, arguments: openedInputs.argumentsValue as Record<string, unknown> },
        CallToolResultSchema,
        { signal: executionSignal, timeout: callTimeout, maxTotalTimeout: callTimeout },
      )
      candidate = await revalidateBinding(options.discovery, candidate)
      if (candidate.tool.capabilityBindingHash !== request.capability.execution.bindingHash) {
        throw new AgentMcpBrokerError('capability_stale')
      }
      await revalidateMcpInputArtifacts(openedInputs.inputs)
      await session.revalidate?.()
      await client.close()
      client = undefined
      await session.close()
      session = undefined
      await revalidateMcpInputArtifacts(openedInputs.inputs)
      if (relativeStage) {
        await revalidateRelativeOutputSlots(relativeStage)
      }
      const transaction = relativeStage
        ? await publishRelativeFileArtifacts(result, candidate, output, relativeStage, request.signal, executionDeadline)
        : await publishResultArtifacts(result, candidate, output, request.signal, executionDeadline)
      success = true
      return transaction
    } catch (error) {
      throw classifyMcpError(error, request.signal)
    } finally {
      executionSignal.removeEventListener('abort', abort)
      await client?.close().catch(() => undefined)
      await session?.close().catch(() => undefined)
      await closeHandles(openedInputs.inputs.map((input) => input.handle))
      await closeRelativeOutputStage(relativeStage)
      if (relativeStage) await rm(relativeStage.stageDir, { recursive: true, force: true }).catch(() => undefined)
      if (!success) await rm(output.finalDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
