import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { ARTIFACT_KINDS, type ArtifactKind } from '../../src/shared/types/artifacts.ts'
import type {
  AgentProcessArtifactContractV1,
  AgentProcessDeclarationV1,
  AgentProcessExecutionV1,
  AgentProcessModelAccessDeclarationV1,
  AgentProcessPythonRuntimeDeclarationV1,
  AgentProcessRuntimeFileIdentityV1,
} from '../../src/shared/types/agentActions.ts'
import { canonicalJson, sha256Canonical } from './agent-trust-contracts.ts'
import {
  AgentProcessPythonRuntimeError,
  bindExtensionPythonRuntime,
} from './agent-process-python-runtime.ts'

const PROCESS_SCHEMA = 'modly.agent-process.v1' as const
const EXECUTION_SCHEMA = 'modly.agent-process-execution.v1' as const
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const ARTIFACT_KIND_SET = new Set<string>(ARTIFACT_KINDS)
const MAX_RESOURCE_FILES = 23
const MAX_RUNTIME_FILE_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024
const EXECUTABLE_RESOURCE_EXTENSION = /\.(?:[cm]?js|[cm]?ts|py|pyc|pyz|zip|sh|bash|zsh|fish|exe|dll|so|dylib|wasm)$/i

export class AgentProcessManifestError extends Error {
  readonly code: 'invalid_metadata' | 'unsafe_runtime' | 'runtime_stale'

  constructor(code: AgentProcessManifestError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AgentProcessManifestError'
    this.code = code
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentProcessManifestError('invalid_metadata', `${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentProcessManifestError('invalid_metadata', `${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new AgentProcessManifestError('invalid_metadata', `${label} contains an unknown field`)
    }
  }
}

export function normalizeAgentProcessRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.trim() !== value
    || isAbsolute(value) || value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value)
    || /[\0\r\n\\*?<>:"|]/.test(value)) {
    throw new AgentProcessManifestError('unsafe_runtime', `${label} must be a safe extension-relative file path`)
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'
    || WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment))) {
    throw new AgentProcessManifestError('unsafe_runtime', `${label} contains an unsafe segment`)
  }
  return segments.join('/')
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AgentProcessManifestError('invalid_metadata', `${label} is outside its bound`)
  }
  return value
}

function normalizeArtifacts(value: unknown): AgentProcessArtifactContractV1 {
  const artifacts = record(value, 'Agent process artifacts')
  exactKeys(artifacts, ['maxCount', 'maxTotalBytes', 'allowed'], 'Agent process artifacts')
  const maxCount = positiveInteger(artifacts.maxCount, 'Agent process artifacts.maxCount', 32)
  const maxTotalBytes = positiveInteger(artifacts.maxTotalBytes, 'Agent process artifacts.maxTotalBytes', MAX_OUTPUT_BYTES)
  if (!Array.isArray(artifacts.allowed) || artifacts.allowed.length < 1 || artifacts.allowed.length > 32) {
    throw new AgentProcessManifestError('invalid_metadata', 'Agent process artifacts.allowed must be bounded')
  }
  const kinds = new Set<string>()
  const allowed = artifacts.allowed.map((raw, index) => {
    const label = `Agent process artifacts.allowed[${index}]`
    const policy = record(raw, label)
    exactKeys(policy, ['kind', 'mediaTypes', 'maxBytes'], label)
    if (typeof policy.kind !== 'string' || !ARTIFACT_KIND_SET.has(policy.kind) || kinds.has(policy.kind)) {
      throw new AgentProcessManifestError('invalid_metadata', `${label}.kind is invalid or duplicated`)
    }
    kinds.add(policy.kind)
    if (!Array.isArray(policy.mediaTypes) || policy.mediaTypes.length < 1 || policy.mediaTypes.length > 16) {
      throw new AgentProcessManifestError('invalid_metadata', `${label}.mediaTypes must be bounded`)
    }
    const mediaTypes = policy.mediaTypes.map((rawMedia, mediaIndex) => {
      if (typeof rawMedia !== 'string' || rawMedia.length < 1 || rawMedia.length > 128 || rawMedia.trim() !== rawMedia) {
        throw new AgentProcessManifestError('invalid_metadata', `${label}.mediaTypes[${mediaIndex}] is invalid`)
      }
      const mediaType = rawMedia.toLowerCase()
      if (!MEDIA_TYPE.test(mediaType)) throw new AgentProcessManifestError('invalid_metadata', `${label}.mediaTypes[${mediaIndex}] is invalid`)
      return mediaType
    }).sort()
    if (new Set(mediaTypes).size !== mediaTypes.length) {
      throw new AgentProcessManifestError('invalid_metadata', `${label}.mediaTypes contains duplicates`)
    }
    const maxBytes = positiveInteger(policy.maxBytes, `${label}.maxBytes`, maxTotalBytes)
    return { kind: policy.kind as ArtifactKind, mediaTypes, maxBytes }
  }).sort((left, right) => left.kind.localeCompare(right.kind))
  return { maxCount, maxTotalBytes, allowed }
}

function normalizePythonRuntime(value: unknown): AgentProcessPythonRuntimeDeclarationV1 {
  const runtime = record(value, 'Agent process runtime')
  exactKeys(runtime, ['kind', 'interpreter'], 'Agent process runtime')
  if (runtime.kind !== 'extension-python-venv-v1' || runtime.interpreter !== 'bin/python') {
    throw new AgentProcessManifestError('invalid_metadata', 'Agent process Python runtime must use extension venv bin/python')
  }
  return { kind: 'extension-python-venv-v1', interpreter: 'bin/python' }
}

function normalizeModelAccess(value: unknown): AgentProcessModelAccessDeclarationV1 {
  const modelAccess = record(value, 'Agent process modelAccess')
  exactKeys(modelAccess, ['schema', 'profile'], 'Agent process modelAccess')
  if (modelAccess.schema !== 'modly.agent-model-access.v1'
    || modelAccess.profile !== 'ollama-responses-json-v1') {
    throw new AgentProcessManifestError('invalid_metadata', 'Agent process modelAccess profile is invalid')
  }
  return {
    schema: 'modly.agent-model-access.v1',
    profile: 'ollama-responses-json-v1',
  }
}

export function normalizeAgentProcessDeclaration(value: unknown, entryValue: unknown): AgentProcessDeclarationV1 {
  const process = record(value, 'Agent process metadata')
  exactKeys(process, ['schema', 'runtimeFiles', 'resourceFiles', 'runtime', 'modelAccess', 'artifacts'], 'Agent process metadata')
  if (process.schema !== PROCESS_SCHEMA) throw new AgentProcessManifestError('invalid_metadata', 'Agent process schema is invalid')
  const entry = normalizeAgentProcessRelativePath(entryValue, 'Process entry')
  if (!/\.(?:js|mjs|pyz)$/i.test(entry)) {
    throw new AgentProcessManifestError('invalid_metadata', 'Agent process entry must be a self-contained JavaScript bundle or Python zipapp')
  }
  if (!Array.isArray(process.runtimeFiles) || process.runtimeFiles.length !== 1) {
    throw new AgentProcessManifestError('invalid_metadata', 'Agent process runtimeFiles must contain exactly one self-contained entry bundle')
  }
  const runtimeFiles = [normalizeAgentProcessRelativePath(process.runtimeFiles[0], 'Agent process runtimeFiles[0]')]
  if (runtimeFiles[0] !== entry) {
    throw new AgentProcessManifestError('invalid_metadata', 'Agent process runtimeFiles must contain only entry')
  }
  const runtime = process.runtime === undefined ? undefined : normalizePythonRuntime(process.runtime)
  if (runtime !== undefined && !/\.pyz$/i.test(entry)) {
    throw new AgentProcessManifestError('invalid_metadata', 'Extension Python runtime may execute only a Python zipapp')
  }
  const modelAccess = process.modelAccess === undefined ? undefined : normalizeModelAccess(process.modelAccess)
  if (modelAccess !== undefined && runtime === undefined) {
    throw new AgentProcessManifestError('invalid_metadata', 'Agent process modelAccess requires the extension Python sandbox runtime')
  }
  if (!Array.isArray(process.resourceFiles) || process.resourceFiles.length > MAX_RESOURCE_FILES) {
    throw new AgentProcessManifestError('invalid_metadata', 'Agent process resourceFiles must be an explicitly bounded array')
  }
  const resourceFiles = process.resourceFiles
    .map((path, index) => normalizeAgentProcessRelativePath(path, `Agent process resourceFiles[${index}]`))
    .sort()
  if (new Set(resourceFiles).size !== resourceFiles.length || resourceFiles.includes(entry)
    || resourceFiles.some((path) => EXECUTABLE_RESOURCE_EXTENSION.test(path))) {
    throw new AgentProcessManifestError('invalid_metadata', 'Agent process resourceFiles must be unique non-code data files')
  }
  const normalized = {
    schema: PROCESS_SCHEMA,
    runtimeFiles,
    resourceFiles,
    ...(runtime ? { runtime } : {}),
    ...(modelAccess ? { modelAccess } : {}),
    artifacts: normalizeArtifacts(process.artifacts),
  }
  canonicalJson(normalized)
  return normalized
}

function outside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)
}

async function assertNoSymlinkPath(root: string, declaredPath: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  if (canonicalRoot !== resolve(root)) throw new AgentProcessManifestError('unsafe_runtime', 'Extension root must not be a symlink')
  const segments = declaredPath.split('/')
  let cursor = canonicalRoot
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment)
    const info = await lstat(cursor)
    if (info.isSymbolicLink()) throw new AgentProcessManifestError('unsafe_runtime', 'Runtime paths must not contain symlinks')
    if (index < segments.length - 1 && !info.isDirectory()) throw new AgentProcessManifestError('unsafe_runtime', 'Runtime parents must be directories')
    if (index === segments.length - 1 && !info.isFile()) throw new AgentProcessManifestError('unsafe_runtime', 'Runtime declarations must name files')
  }
  if (outside(canonicalRoot, cursor) || await realpath(cursor) !== cursor) {
    throw new AgentProcessManifestError('unsafe_runtime', 'Runtime file escaped its extension')
  }
  return cursor
}

export async function hashAgentProcessFileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  const stream = handle.createReadStream({ autoClose: false, start: 0 })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

function identityFromStat(path: string, stat: BigIntStats): AgentProcessRuntimeFileIdentityV1 {
  const size = Number(stat.size)
  const uid = Number(stat.uid)
  const gid = Number(stat.gid)
  if (![size, uid, gid].every(Number.isSafeInteger) || size < 0 || size > MAX_RUNTIME_FILE_BYTES) {
    throw new AgentProcessManifestError('unsafe_runtime', 'Runtime file identity is outside bounds')
  }
  return {
    path,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    uid,
    gid,
    mode: Number(stat.mode & 0o7777n),
    size,
    mtimeNs: stat.mtimeNs.toString(),
    sha256: '',
  }
}

function statMatchesIdentity(stat: BigIntStats, identity: AgentProcessRuntimeFileIdentityV1): boolean {
  return stat.isFile()
    && stat.dev.toString() === identity.device
    && stat.ino.toString() === identity.inode
    && Number(stat.uid) === identity.uid
    && Number(stat.gid) === identity.gid
    && Number(stat.mode & 0o7777n) === identity.mode
    && Number(stat.size) === identity.size
    && stat.mtimeNs.toString() === identity.mtimeNs
}

async function openRuntimeFile(
  extensionDir: string,
  path: string,
  role: 'bundle' | 'resource',
): Promise<{ handle: FileHandle, identity: AgentProcessRuntimeFileIdentityV1 }> {
  const target = await assertNoSymlinkPath(extensionDir, path)
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(target, constants.O_RDONLY | noFollow)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new AgentProcessManifestError('unsafe_runtime', 'Runtime declaration is not a regular file')
    const identity = identityFromStat(path, before)
    if (role === 'resource' && (identity.mode & 0o111) !== 0) {
      throw new AgentProcessManifestError('unsafe_runtime', 'Agent process resources must not be executable')
    }
    const sha256 = await hashAgentProcessFileHandle(handle)
    const after = await handle.stat({ bigint: true })
    if (!statMatchesIdentity(after, identity)) throw new AgentProcessManifestError('runtime_stale', 'Runtime changed while hashing')
    return { handle, identity: { ...identity, sha256 } }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export async function bindAgentProcessExecution(
  extensionDir: string,
  entry: string,
  declaration: AgentProcessDeclarationV1,
  baseInterpreterPath?: string,
): Promise<AgentProcessExecutionV1> {
  const opened: FileHandle[] = []
  try {
    const runtimeFiles: AgentProcessRuntimeFileIdentityV1[] = []
    for (const path of [...declaration.runtimeFiles].sort()) {
      const bound = await openRuntimeFile(extensionDir, path, 'bundle')
      opened.push(bound.handle)
      runtimeFiles.push(bound.identity)
    }
    const resourceFiles: AgentProcessRuntimeFileIdentityV1[] = []
    for (const path of [...declaration.resourceFiles].sort()) {
      const bound = await openRuntimeFile(extensionDir, path, 'resource')
      opened.push(bound.handle)
      resourceFiles.push(bound.identity)
    }
    const runtime = declaration.runtime
      ? await bindExtensionPythonRuntime(
        extensionDir,
        declaration.runtime,
        baseInterpreterPath ?? (() => { throw new AgentProcessPythonRuntimeError('runtime_unavailable', 'Trusted base interpreter is unavailable') })(),
      )
      : undefined
    const modelAccess = declaration.modelAccess
    const runtimeHash = sha256Canonical({
      runtimeFiles,
      resourceFiles,
      ...(runtime ? { runtime } : {}),
      ...(modelAccess ? { modelAccess } : {}),
    })
    const artifacts = declaration.artifacts
    const bindingHash = sha256Canonical({ schema: EXECUTION_SCHEMA, entry, runtimeHash, artifacts })
    return {
      kind: 'process', schema: EXECUTION_SCHEMA, entry,
      runtimeFiles, resourceFiles, ...(runtime ? { runtime } : {}), ...(modelAccess ? { modelAccess } : {}),
      runtimeHash, artifacts, bindingHash,
    }
  } catch (error) {
    if (error instanceof AgentProcessManifestError) throw error
    if (error instanceof AgentProcessPythonRuntimeError) {
      throw new AgentProcessManifestError(
        error.code === 'runtime_stale' ? 'runtime_stale' : 'unsafe_runtime',
        error.message,
        error,
      )
    }
    throw new AgentProcessManifestError('unsafe_runtime', 'Unable to bind Agent process runtime', error)
  } finally {
    await Promise.all(opened.map((handle) => handle.close().catch(() => undefined)))
  }
}

export interface OpenAgentProcessRuntimeFile {
  role: 'bundle' | 'resource'
  identity: AgentProcessRuntimeFileIdentityV1
  handle: FileHandle
}

export async function openBoundAgentProcessRuntime(
  extensionDir: string,
  execution: AgentProcessExecutionV1,
): Promise<OpenAgentProcessRuntimeFile[]> {
  const opened: OpenAgentProcessRuntimeFile[] = []
  try {
    for (const [role, identities] of [
      ['bundle', execution.runtimeFiles],
      ['resource', execution.resourceFiles],
    ] as const) {
      for (const identity of identities) {
        const current = await openRuntimeFile(extensionDir, identity.path, role)
        opened.push({ role, identity, handle: current.handle })
        if (canonicalJson(current.identity) !== canonicalJson(identity)) {
          throw new AgentProcessManifestError('runtime_stale', 'Agent process runtime identity changed')
        }
      }
    }
    return opened
  } catch (error) {
    await Promise.all(opened.map(({ handle }) => handle.close().catch(() => undefined)))
    if (error instanceof AgentProcessManifestError) throw error
    throw new AgentProcessManifestError('runtime_stale', 'Unable to revalidate Agent process runtime', error)
  }
}

export async function revalidateOpenAgentProcessRuntime(files: readonly OpenAgentProcessRuntimeFile[]): Promise<void> {
  for (const { handle, identity } of files) {
    const stat = await handle.stat({ bigint: true })
    if (!statMatchesIdentity(stat, identity) || await hashAgentProcessFileHandle(handle) !== identity.sha256) {
      throw new AgentProcessManifestError('runtime_stale', 'Agent process runtime changed before spawn')
    }
  }
}
