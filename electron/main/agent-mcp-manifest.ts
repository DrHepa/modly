import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import Ajv from 'ajv'

import { ARTIFACT_KINDS, type ArtifactKind } from '../../src/shared/types/artifacts.ts'
import type { AgentApprovalPolicyV1, JsonValue } from '../../src/shared/types/agentActions.ts'
import { canonicalJson, sha256Canonical } from './agent-trust-contracts.ts'
import { assertSafeExtensionId, assertSafeOwnershipSegment } from './extension-path-guard.ts'

const MCP_SCHEMA = 'modly.mcp-stdio.v1' as const
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const DANGEROUS_ENV = /^(?:PATH|HOME|NODE_OPTIONS|PYTHONPATH|LD_.+|DYLD_.+)$/i
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const SHELL_OR_INTERPOLATION = /[\0\r\n`$;&|<>*?\\]/
const MAX_SERVERS = 16
const MAX_TOOLS_PER_SERVER = 64
const MAX_ARGS = 64
const MAX_ENV = 32
const MAX_RUNTIME_FILES = 24
const MAX_LITERAL = 4_096
const MAX_SCHEMA_BYTES = 128 * 1_024
const MAX_SCHEMA_DEPTH = 32
const MAX_SCHEMA_PROPERTIES = 1_024
const MAX_MANIFEST_BYTES = 512 * 1_024
const MAX_MANIFEST_DEPTH = 64
const MAX_MANIFEST_PROPERTIES = 10_000
const MAX_MANIFEST_ARRAY = 5_000

type JsonSchema = Record<string, JsonValue>

export type McpArtifactDeclaration = Readonly<{
  kind: ArtifactKind
  mediaTypes: readonly string[]
}>

export type NormalizedMcpTool = Readonly<{
  name: string
  capabilityId: string
  displayName: string
  description: string
  inputSchema: JsonSchema
  inputSchemaHash: string
  outputSchema?: JsonSchema
  outputSchemaHash?: string
  mutating: boolean
  approval: AgentApprovalPolicyV1
  artifact: McpArtifactDeclaration
}>

export type NormalizedMcpServer = Readonly<{
  id: string
  runtimeFiles: readonly string[]
  command: Readonly<{
    executable: string
    entrypoint?: string
    args: readonly string[]
    env: Readonly<Record<string, string>>
  }>
  tools: readonly NormalizedMcpTool[]
}>

export type NormalizedMcpManifest = Readonly<{
  schema: typeof MCP_SCHEMA
  transport: 'stdio'
  servers: readonly NormalizedMcpServer[]
}>

export type McpExecutableIdentity = Readonly<{
  declaredPath: string
  realPath: string
  symlink: boolean
  uid: number
  gid: number
  mode: number
  size: number
  sha256: string
}>

export type McpEntrypointIdentity = Omit<McpExecutableIdentity, 'symlink'> & Readonly<{ symlink: false }>
export type McpRuntimeFileIdentity = McpEntrypointIdentity

export type BoundMcpServer = Omit<NormalizedMcpServer, 'tools' | 'runtimeFiles'> & Readonly<{
  executable: McpExecutableIdentity
  entrypoint?: McpEntrypointIdentity
  runtimeFiles: readonly McpRuntimeFileIdentity[]
  capabilityBindingHash: string
  tools: readonly (NormalizedMcpTool & Readonly<{ capabilityBindingHash: string }>)[]
}>

export type BoundMcpManifest = Readonly<{
  schema: typeof MCP_SCHEMA
  transport: 'stdio'
  servers: readonly BoundMcpServer[]
}>

export type DiscoveredMcpTool = Readonly<{
  rootKind: 'builtin' | 'user'
  extensionDir: string
  extension: Readonly<{ id: string, name: string, version?: string }>
  manifest: BoundMcpManifest
  server: BoundMcpServer
  tool: BoundMcpServer['tools'][number]
}>

export interface McpDiscoveryError {
  code: 'MCP_MANIFEST_INVALID' | 'MCP_ID_COLLISION'
  message: string
  capabilityId?: string
}

export class AgentMcpManifestError extends Error {
  readonly code: 'invalid_manifest' | 'unsafe_command' | 'unsafe_executable'

  constructor(code: AgentMcpManifestError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AgentMcpManifestError'
    this.code = code
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new AgentMcpManifestError('invalid_manifest', `${label} must be a plain object`)
  return value
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new AgentMcpManifestError('invalid_manifest', `${label} contains an unknown field`)
    }
  }
}

function literal(value: unknown, label: string, maxLength = MAX_LITERAL): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > maxLength) {
    throw new AgentMcpManifestError('invalid_manifest', `${label} must be a bounded non-empty literal`)
  }
  if (SHELL_OR_INTERPOLATION.test(value)) {
    throw new AgentMcpManifestError('unsafe_command', `${label} contains shell or interpolation syntax`)
  }
  return value
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function displayText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value || hasControlCharacter(value)) {
    throw new AgentMcpManifestError('invalid_manifest', `${label} is invalid`)
  }
  return value
}

function safeId(value: unknown, label: string): string {
  const normalized = literal(value, label, 128)
  if (!SAFE_ID.test(normalized) || DANGEROUS_KEYS.has(normalized)) {
    throw new AgentMcpManifestError('invalid_manifest', `${label} is invalid`)
  }
  return normalized
}

function extensionRelativePath(value: unknown, label: string): string {
  const path = literal(value, label, 512)
  if (isAbsolute(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('//')) {
    throw new AgentMcpManifestError('unsafe_command', `${label} must be extension-relative`)
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'
    || /[<>:"|]/.test(segment) || WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment))) {
    throw new AgentMcpManifestError('unsafe_command', `${label} contains an unsafe path segment`)
  }
  return segments.join('/')
}

function normalizeCommand(value: unknown, label: string): NormalizedMcpServer['command'] {
  const command = record(value, label)
  exactKeys(command, ['executable', 'entrypoint', 'args', 'env'], label)
  const executable = extensionRelativePath(command.executable, `${label}.executable`)
  const entrypoint = command.entrypoint === undefined
    ? undefined
    : extensionRelativePath(command.entrypoint, `${label}.entrypoint`)
  const executableName = executable.split('/').at(-1)?.toLowerCase() ?? ''
  if (!entrypoint && /^(?:python(?:3(?:\.\d+)*)?|node|bun|deno)(?:\.exe)?$/.test(executableName)) {
    throw new AgentMcpManifestError('unsafe_command', `${label}.entrypoint is required for an interpreter executable`)
  }
  if (!Array.isArray(command.args) || command.args.length > MAX_ARGS) {
    throw new AgentMcpManifestError('invalid_manifest', `${label}.args must be a bounded array`)
  }
  const args = command.args.map((entry, index) => {
    const arg = literal(entry, `${label}.args[${index}]`)
    const assignedValue = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(assignedValue)
      || assignedValue.startsWith('/') || /^[A-Za-z]:/.test(assignedValue)
      || assignedValue === '..' || assignedValue.startsWith('../') || assignedValue.includes('/../')) {
      throw new AgentMcpManifestError('unsafe_command', `${label}.args contains a remote or non-relative value`)
    }
    if (!arg.startsWith('-') && (arg.includes('/') || arg.startsWith('.'))) {
      extensionRelativePath(arg, `${label}.args[${index}]`)
    }
    if (arg === '..' || arg.startsWith('../') || arg.includes('/../')) {
      throw new AgentMcpManifestError('unsafe_command', `${label}.args contains traversal`)
    }
    if (!entrypoint && !arg.startsWith('-') && /\.(?:py|js|mjs|cjs|sh|rb|pl|exe)$/i.test(arg)) {
      throw new AgentMcpManifestError('unsafe_command', `${label}.entrypoint must declare executable script identity`)
    }
    return arg
  })
  const rawEnv = record(command.env, `${label}.env`)
  if (Object.keys(rawEnv).length > MAX_ENV) throw new AgentMcpManifestError('invalid_manifest', `${label}.env is too large`)
  const env: Record<string, string> = {}
  for (const key of Object.keys(rawEnv).sort()) {
    if (!SAFE_ENV_KEY.test(key) || DANGEROUS_ENV.test(key) || DANGEROUS_KEYS.has(key)) {
      throw new AgentMcpManifestError('unsafe_command', `${label}.env contains a forbidden key`)
    }
    const value = literal(rawEnv[key], `${label}.env.${key}`)
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
      throw new AgentMcpManifestError('unsafe_command', `${label}.env contains a remote or absolute value`)
    }
    env[key] = value
  }
  return { executable, ...(entrypoint ? { entrypoint } : {}), args, env }
}

function normalizeRuntimeFiles(value: unknown, entrypoint: string | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_FILES) {
    throw new AgentMcpManifestError('invalid_manifest', `${label} must be a bounded array`)
  }
  const files = value.map((entry, index) => extensionRelativePath(entry, `${label}[${index}]`))
  if (new Set(files).size !== files.length) {
    throw new AgentMcpManifestError('invalid_manifest', `${label} contains duplicates`)
  }
  if (entrypoint !== undefined && !files.includes(entrypoint)) {
    throw new AgentMcpManifestError('invalid_manifest', `${label} must include the declared entrypoint`)
  }
  return files.sort()
}

function inspectJson(value: unknown, depth: number, counters: { properties: number }): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new AgentMcpManifestError('invalid_manifest', 'MCP JSON Schema is too deep')
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return
  if (Array.isArray(value)) {
    for (const entry of value) inspectJson(entry, depth + 1, counters)
    return
  }
  const item = record(value, 'MCP JSON Schema value')
  for (const [key, child] of Object.entries(item)) {
    if (DANGEROUS_KEYS.has(key)) throw new AgentMcpManifestError('invalid_manifest', 'MCP JSON Schema contains a dangerous key')
    counters.properties += 1
    if (counters.properties > MAX_SCHEMA_PROPERTIES) throw new AgentMcpManifestError('invalid_manifest', 'MCP JSON Schema has too many properties')
    if (key === '$ref' && (typeof child !== 'string' || !child.startsWith('#/'))) {
      throw new AgentMcpManifestError('invalid_manifest', 'MCP JSON Schema remote references are forbidden')
    }
    inspectJson(child, depth + 1, counters)
  }
}

function jsonSchema(value: unknown, label: string): { schema: JsonSchema, hash: string } {
  const schema = record(value, label)
  inspectJson(schema, 0, { properties: 0 })
  let canonical: string
  try { canonical = canonicalJson(schema) } catch (error) {
    throw new AgentMcpManifestError('invalid_manifest', `${label} is not canonical JSON`, error)
  }
  if (Buffer.byteLength(canonical, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new AgentMcpManifestError('invalid_manifest', `${label} is too large`)
  }
  if (schema.type !== 'object') throw new AgentMcpManifestError('invalid_manifest', `${label} must have type object`)
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
    ajv.compile(schema)
  } catch (error) {
    throw new AgentMcpManifestError('invalid_manifest', `${label} is not a supported strict JSON Schema`, error)
  }
  return { schema: JSON.parse(canonical) as JsonSchema, hash: createHash('sha256').update(canonical).digest('hex') }
}

function normalizeApproval(value: unknown, label: string): AgentApprovalPolicyV1 {
  const approval = record(value, label)
  exactKeys(approval, ['required', 'scope'], label)
  if (approval.required !== true || approval.scope !== 'single_action') {
    throw new AgentMcpManifestError('invalid_manifest', `${label} must require single_action approval`)
  }
  return { required: true, scope: 'single_action' }
}

function normalizeArtifact(value: unknown, label: string): McpArtifactDeclaration {
  const artifact = record(value, label)
  exactKeys(artifact, ['kind', 'media_types'], label)
  if (typeof artifact.kind !== 'string' || !(ARTIFACT_KINDS as readonly string[]).includes(artifact.kind)) {
    throw new AgentMcpManifestError('invalid_manifest', `${label}.kind is invalid`)
  }
  if (!Array.isArray(artifact.media_types) || artifact.media_types.length < 1 || artifact.media_types.length > 16) {
    throw new AgentMcpManifestError('invalid_manifest', `${label}.media_types is invalid`)
  }
  const mediaTypes = artifact.media_types.map((entry, index) => {
    const mediaType = literal(entry, `${label}.media_types[${index}]`, 128).toLowerCase()
    if (!MEDIA_TYPE.test(mediaType)) throw new AgentMcpManifestError('invalid_manifest', `${label}.media_types is invalid`)
    return mediaType
  })
  if (new Set(mediaTypes).size !== mediaTypes.length) throw new AgentMcpManifestError('invalid_manifest', `${label}.media_types contains duplicates`)
  return { kind: artifact.kind as ArtifactKind, mediaTypes }
}

function normalizeTool(value: unknown, extensionId: string, label: string): NormalizedMcpTool {
  const tool = record(value, label)
  exactKeys(tool, [
    'name', 'capability_id', 'display_name', 'description', 'input_schema', 'output_schema',
    'mutating', 'approval', 'artifact',
  ], label)
  const name = safeId(tool.name, `${label}.name`)
  const capabilityId = literal(tool.capability_id, `${label}.capability_id`, 257)
  const capabilitySegments = capabilityId.split('/')
  if (capabilitySegments.length !== 2 || capabilitySegments[0] !== extensionId) {
    throw new AgentMcpManifestError('invalid_manifest', `${label}.capability_id must match the extension`)
  }
  try { assertSafeOwnershipSegment(capabilitySegments[1], `${label}.capability_id node`) } catch (error) {
    throw new AgentMcpManifestError('invalid_manifest', `${label}.capability_id node is invalid`, error)
  }
  const input = jsonSchema(tool.input_schema, `${label}.input_schema`)
  const output = tool.output_schema === undefined ? undefined : jsonSchema(tool.output_schema, `${label}.output_schema`)
  if (typeof tool.mutating !== 'boolean') throw new AgentMcpManifestError('invalid_manifest', `${label}.mutating must be boolean`)
  return {
    name,
    capabilityId,
    displayName: displayText(tool.display_name, `${label}.display_name`, 80),
    description: displayText(tool.description, `${label}.description`, 500),
    inputSchema: input.schema,
    inputSchemaHash: input.hash,
    ...(output ? { outputSchema: output.schema, outputSchemaHash: output.hash } : {}),
    mutating: tool.mutating,
    approval: normalizeApproval(tool.approval, `${label}.approval`),
    artifact: normalizeArtifact(tool.artifact, `${label}.artifact`),
  }
}

export function normalizeMcpManifest(value: unknown, extensionIdValue: string): NormalizedMcpManifest {
  let extensionId: string
  try { extensionId = assertSafeExtensionId(extensionIdValue) } catch (error) {
    throw new AgentMcpManifestError('invalid_manifest', 'MCP extension id is invalid', error)
  }
  const manifest = record(value, 'MCP manifest')
  exactKeys(manifest, ['schema', 'transport', 'servers'], 'MCP manifest')
  if (manifest.schema !== MCP_SCHEMA || manifest.transport !== 'stdio') {
    throw new AgentMcpManifestError('invalid_manifest', 'MCP manifest schema or transport is unsupported')
  }
  if (!Array.isArray(manifest.servers) || manifest.servers.length < 1 || manifest.servers.length > MAX_SERVERS) {
    throw new AgentMcpManifestError('invalid_manifest', 'MCP manifest servers must be a bounded non-empty array')
  }
  const serverIds = new Set<string>()
  const capabilityIds = new Set<string>()
  const servers = manifest.servers.map((rawServer, serverIndex): NormalizedMcpServer => {
    const label = `MCP manifest servers[${serverIndex}]`
    const server = record(rawServer, label)
    exactKeys(server, ['id', 'runtimeFiles', 'command', 'tools'], label)
    const id = safeId(server.id, `${label}.id`)
    if (serverIds.has(id)) throw new AgentMcpManifestError('invalid_manifest', 'MCP manifest contains duplicate server ids')
    serverIds.add(id)
    if (!Array.isArray(server.tools) || server.tools.length < 1 || server.tools.length > MAX_TOOLS_PER_SERVER) {
      throw new AgentMcpManifestError('invalid_manifest', `${label}.tools must be a bounded non-empty array`)
    }
    const command = normalizeCommand(server.command, `${label}.command`)
    const runtimeFiles = normalizeRuntimeFiles(server.runtimeFiles, command.entrypoint, `${label}.runtimeFiles`)
    const toolNames = new Set<string>()
    const tools = server.tools.map((rawTool, toolIndex) => {
      const tool = normalizeTool(rawTool, extensionId, `${label}.tools[${toolIndex}]`)
      if (toolNames.has(tool.name)) throw new AgentMcpManifestError('invalid_manifest', `${label}.tools contains duplicate names`)
      if (capabilityIds.has(tool.capabilityId)) throw new AgentMcpManifestError('invalid_manifest', 'MCP manifest contains duplicate capability ids')
      toolNames.add(tool.name)
      capabilityIds.add(tool.capabilityId)
      return tool
    })
    return { id, runtimeFiles, command, tools }
  })
  return { schema: MCP_SCHEMA, transport: 'stdio', servers }
}

function outside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)
}

async function hashHandle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk)
  return hash.digest('hex')
}

async function fileIdentity(
  extensionDir: string,
  declaredPath: string,
  options: { executable: boolean, allowVenvPythonSymlink: boolean },
): Promise<McpExecutableIdentity> {
  try {
    const root = await realpath(extensionDir)
    const declared = resolve(root, ...declaredPath.split('/'))
    if (outside(root, declared)) throw new AgentMcpManifestError('unsafe_executable', 'MCP executable escapes its extension')
    const linkInfo = await lstat(declared)
    const symlink = linkInfo.isSymbolicLink()
    if (symlink && (!options.allowVenvPythonSymlink || !/^(?:\.?(?:venv))\/bin\/python(?:3(?:\.\d+)*)?$/.test(declaredPath))) {
      throw new AgentMcpManifestError('unsafe_executable', 'Only a venv Python executable may be a symlink')
    }
    const target = await realpath(declared)
    if (!symlink && outside(root, target)) throw new AgentMcpManifestError('unsafe_executable', 'MCP executable resolves outside its extension')
    if (typeof constants.O_NOFOLLOW !== 'number') {
      throw new AgentMcpManifestError('unsafe_executable', 'No-follow file opening is unavailable')
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || (before.mode & 0o002) !== 0) {
        throw new AgentMcpManifestError('unsafe_executable', 'MCP executable must be a non-world-writable regular file')
      }
      if (options.executable && process.platform !== 'win32' && (before.mode & 0o111) === 0) {
        throw new AgentMcpManifestError('unsafe_executable', 'MCP executable must have an executable mode')
      }
      const size = Number(before.size)
      if (!Number.isSafeInteger(size) || size < 1) throw new AgentMcpManifestError('unsafe_executable', 'MCP executable size is invalid')
      const sha256 = await hashHandle(handle)
      const after = await handle.stat()
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new AgentMcpManifestError('unsafe_executable', 'MCP executable changed while its identity was established')
      }
      return {
        declaredPath,
        realPath: target,
        symlink,
        uid: before.uid,
        gid: before.gid,
        mode: before.mode & 0o7777,
        size,
        sha256,
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch (error) {
    if (error instanceof AgentMcpManifestError) throw error
    throw new AgentMcpManifestError('unsafe_executable', 'MCP executable identity could not be established', error)
  }
}

function inspectManifestJson(value: unknown, depth: number, state: { properties: number }): void {
  if (depth > MAX_MANIFEST_DEPTH) throw new AgentMcpManifestError('invalid_manifest', 'Extension manifest is too deep')
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return
  if (Array.isArray(value)) {
    if (value.length > MAX_MANIFEST_ARRAY) throw new AgentMcpManifestError('invalid_manifest', 'Extension manifest array is too large')
    for (const child of value) inspectManifestJson(child, depth + 1, state)
    return
  }
  const item = record(value, 'Extension manifest value')
  for (const [key, child] of Object.entries(item)) {
    if (DANGEROUS_KEYS.has(key)) throw new AgentMcpManifestError('invalid_manifest', 'Extension manifest contains a dangerous key')
    state.properties += 1
    if (state.properties > MAX_MANIFEST_PROPERTIES) throw new AgentMcpManifestError('invalid_manifest', 'Extension manifest has too many properties')
    inspectManifestJson(child, depth + 1, state)
  }
}

async function readBoundedManifest(path: string): Promise<unknown> {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new AgentMcpManifestError('invalid_manifest', 'No-follow manifest opening is unavailable')
  }
  const pathInfo = await lstat(path)
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size < 1 || pathInfo.size > MAX_MANIFEST_BYTES) {
    throw new AgentMcpManifestError('invalid_manifest', 'Extension manifest must be a bounded regular file')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > MAX_MANIFEST_BYTES) {
      throw new AgentMcpManifestError('invalid_manifest', 'Extension manifest must be a bounded regular file')
    }
    const chunks: Buffer[] = []
    let offset = 0
    while (offset <= MAX_MANIFEST_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, MAX_MANIFEST_BYTES + 1 - offset))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      offset += bytesRead
    }
    if (offset > MAX_MANIFEST_BYTES) throw new AgentMcpManifestError('invalid_manifest', 'Extension manifest is too large')
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || offset !== Number(after.size)) {
      throw new AgentMcpManifestError('invalid_manifest', 'Extension manifest changed while it was read')
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, offset))
    const value = JSON.parse(text) as unknown
    inspectManifestJson(value, 0, { properties: 0 })
    return value
  } catch (error) {
    if (error instanceof AgentMcpManifestError) throw error
    throw new AgentMcpManifestError('invalid_manifest', 'Extension manifest could not be parsed safely', error)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function bindMcpManifest(manifest: NormalizedMcpManifest, extensionDir: string): Promise<BoundMcpManifest> {
  const servers = await Promise.all(manifest.servers.map(async (server): Promise<BoundMcpServer> => {
    const executable = await fileIdentity(extensionDir, server.command.executable, { executable: true, allowVenvPythonSymlink: true })
    const runtimeFiles = await Promise.all(server.runtimeFiles.map(async (path) => (
      await fileIdentity(extensionDir, path, { executable: false, allowVenvPythonSymlink: false }) as McpRuntimeFileIdentity
    )))
    const entrypoint = server.command.entrypoint === undefined
      ? undefined
      : runtimeFiles.find((file) => file.declaredPath === server.command.entrypoint) as McpEntrypointIdentity | undefined
    if (server.command.entrypoint !== undefined && !entrypoint) {
      throw new AgentMcpManifestError('unsafe_executable', 'MCP entrypoint identity is missing from runtimeFiles')
    }
    const serverBinding = {
      schema: 'modly.mcp-server-binding.v1',
      serverId: server.id,
      command: server.command,
      executable,
      entrypoint: entrypoint ?? null,
      runtimeFiles,
      tools: server.tools.map((tool) => ({
        name: tool.name,
        capabilityId: tool.capabilityId,
        inputSchemaHash: tool.inputSchemaHash,
        outputSchemaHash: tool.outputSchemaHash ?? null,
        mutating: tool.mutating,
        approval: tool.approval,
        artifact: tool.artifact,
      })),
    }
    const capabilityBindingHash = sha256Canonical(serverBinding)
    return {
      ...server,
      executable,
      ...(entrypoint ? { entrypoint } : {}),
      runtimeFiles,
      capabilityBindingHash,
      tools: server.tools.map((tool) => ({
        ...tool,
        capabilityBindingHash: sha256Canonical({
          schema: 'modly.mcp-tool-binding.v1',
          serverBindingHash: capabilityBindingHash,
          capabilityId: tool.capabilityId,
          name: tool.name,
          inputSchemaHash: tool.inputSchemaHash,
          outputSchemaHash: tool.outputSchemaHash ?? null,
          artifact: tool.artifact,
        }),
      })),
    }
  }))
  return { schema: MCP_SCHEMA, transport: 'stdio', servers }
}

async function discoverRoot(
  root: string,
  rootKind: DiscoveredMcpTool['rootKind'],
): Promise<{ tools: DiscoveredMcpTool[], errors: McpDiscoveryError[] }> {
  const tools: DiscoveredMcpTool[] = []
  const errors: McpDiscoveryError[] = []
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tools, errors }
    return { tools, errors: [{ code: 'MCP_MANIFEST_INVALID', message: 'An extension root could not be inspected for MCP declarations.' }] }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const configuredExtensionDir = join(root, entry.name)
    try {
      const extensionDir = await realpath(configuredExtensionDir)
      const extensionInfo = await stat(extensionDir)
      if (!extensionInfo.isDirectory()) continue
      const raw = await readBoundedManifest(join(extensionDir, 'manifest.json'))
      const extensionManifest = record(raw, 'Extension manifest')
      if (extensionManifest.type !== 'process' || extensionManifest.mcp === undefined) continue
      const extensionId = assertSafeExtensionId(typeof extensionManifest.id === 'string' ? extensionManifest.id : entry.name)
      const normalized = normalizeMcpManifest(extensionManifest.mcp, extensionId)
      const bound = await bindMcpManifest(normalized, extensionDir)
      const name = typeof extensionManifest.name === 'string' && extensionManifest.name.trim() ? extensionManifest.name.trim() : extensionId
      const version = typeof extensionManifest.version === 'string' && extensionManifest.version.trim() ? extensionManifest.version.trim() : undefined
      for (const server of bound.servers) {
        for (const tool of server.tools) {
          tools.push({
            rootKind,
            extensionDir,
            extension: { id: extensionId, name, ...(version ? { version } : {}) },
            manifest: bound,
            server,
            tool,
          })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      errors.push({ code: 'MCP_MANIFEST_INVALID', message: 'An invalid MCP declaration was excluded from Agent discovery.' })
    }
  }
  return { tools, errors }
}

export async function discoverGovernedMcpTools(options: {
  builtinDir: string
  userExtensionsDir: string
}): Promise<{ tools: DiscoveredMcpTool[], errors: McpDiscoveryError[] }> {
  const [builtin, user] = await Promise.all([
    discoverRoot(options.builtinDir, 'builtin'),
    discoverRoot(options.userExtensionsDir, 'user'),
  ])
  const candidates = [...builtin.tools, ...user.tools]
  const counts = new Map<string, number>()
  const identities = (candidate: DiscoveredMcpTool): string[] => [
    `server:${candidate.extension.id}/${candidate.server.id}`,
    `tool:${candidate.extension.id}/${candidate.server.id}/${candidate.tool.name}`,
    `capability:${candidate.tool.capabilityId}`,
  ]
  for (const candidate of candidates) {
    for (const identity of identities(candidate)) counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  const collided = new Set([...counts].filter(([, count]) => count > 1).map(([identity]) => identity))
  const collisionCapabilities = [...new Set(candidates
    .filter((candidate) => identities(candidate).some((identity) => collided.has(identity)))
    .map((candidate) => candidate.tool.capabilityId))].sort()
  return {
    tools: candidates
      .filter((candidate) => identities(candidate).every((identity) => !collided.has(identity)))
      .sort((left, right) => left.tool.capabilityId.localeCompare(right.tool.capabilityId)),
    errors: [
      ...builtin.errors,
      ...user.errors,
      ...collisionCapabilities.map((capabilityId) => ({
        code: 'MCP_ID_COLLISION' as const,
        message: 'An ambiguous MCP identity was excluded from Agent discovery.',
        capabilityId,
      })),
    ],
  }
}
