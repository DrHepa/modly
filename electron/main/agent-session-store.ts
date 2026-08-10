import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  AGENT_SESSION_SCHEMA,
  AGENT_SESSION_SCHEMA_VERSION,
  AGENT_GOVERNED_TERMINAL_STATUSES,
  type AgentArtifactRef,
  type AgentAttachmentRef,
  type AgentGovernedTerminalStatus,
  type AgentSession,
  type AgentSessionActivateRequest,
  type AgentSessionAddAttachmentRequest,
  type AgentSessionAppendMessageRequest,
  type AgentSessionCreateRequest,
  type AgentSessionDeleteRequest,
  type AgentSessionListItem,
  type AgentSessionListResult,
  type AgentSessionMessage,
  type AgentSessionReadAttachmentRequest,
  type AgentSessionReadRequest,
  type AgentSessionRemoveAttachmentRequest,
  type AgentSessionRenameRequest,
  type AgentSessionSummary,
} from '../../src/shared/types/agentSessions.ts'

export const AGENT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const AGENT_SESSION_MAX_ATTACHMENTS = 8
export const AGENT_SESSION_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

interface AgentSessionDocumentV1 {
  schema: typeof AGENT_SESSION_SCHEMA
  version: typeof AGENT_SESSION_SCHEMA_VERSION
  activeSessionId: string
  sessions: AgentSession[]
}

export interface StoreOptions {
  rootDir: string
  now?: () => number
  randomId?: () => string
  removePath?: typeof rm
}

const DOCUMENT_FILE = 'agent-sessions.json'
const ATTACHMENTS_DIR = 'agent-session-attachments'
const DEFAULT_TITLE = 'New chat'
const MIME_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' } as const
const PRIVATE_URI_PATTERN = /\b(?:data|file)\s*:/i
const WEB_URL_PATTERN = /\bhttps?\s*:\s*\/\//i
const WINDOWS_DRIVE_PATH_PATTERN = /[A-Za-z]:[\\/][^\s"'<>]+/
const UNC_PATH_PATTERN = /(?:\\\\|\/\/)[^\\/\s"'<>]+[\\/][^\s"'<>]+/
const POSIX_ABSOLUTE_PATH_PATTERN = /(?:^|[^A-Za-z0-9._/-])\/(?!\/)[^\s"'<>]+/m
const CREDENTIAL_WORDS = new Set([
  'authorization', 'authentication', 'bearer',
  'password', 'passwd', 'passphrase', 'pwd',
  'token', 'secret', 'secrets', 'credential', 'credentials',
  'apikey', 'apisecret', 'accesstoken', 'refreshtoken', 'authtoken', 'clientsecret',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function nonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0')
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function containsPrivateLocation(text: string): boolean {
  return PRIVATE_URI_PATTERN.test(text)
    || WEB_URL_PATTERN.test(text)
    || WINDOWS_DRIVE_PATH_PATTERN.test(text)
    || UNC_PATH_PATTERN.test(text)
    || POSIX_ABSOLUTE_PATH_PATTERN.test(text)
}

function containsCredentialMaterial(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (words.some((word) => CREDENTIAL_WORDS.has(word))) return true
  return words.some((word, index) => {
    const next = words[index + 1]
    return (word === 'api' && (next === 'key' || next === 'secret'))
      || (word === 'private' && next === 'key')
      || (word === 'client' && next === 'secret')
      || ((word === 'access' || word === 'refresh' || word === 'auth') && next === 'token')
  })
}

function safePersistedText(value: unknown, max: number): value is string {
  if (!nonEmptyString(value, max)) return false
  const text = value as string
  return !containsPrivateLocation(text)
    && !containsCredentialMaterial(text)
}

function redactPersistedText(value: unknown, max: number): string | null {
  if (!nonEmptyString(value, max)) return null
  if (containsPrivateLocation(value) || containsCredentialMaterial(value)) return '[redacted private content]'
  return value
}

function safeAttachmentDisplayName(value: string, mimeType: keyof typeof MIME_EXTENSIONS): string {
  const fallback = `attachment${MIME_EXTENSIONS[mimeType]}`
  if (PRIVATE_URI_PATTERN.test(value) || WEB_URL_PATTERN.test(value)) return fallback
  const basename = value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1)?.trim()
  if (!basename || basename === '.' || basename === '..') return fallback
  const printableBasename = Array.from(basename)
    .filter((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f)
    .join('')
  if (containsCredentialMaterial(printableBasename)) return fallback
  const neutral = printableBasename
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .trim()
    .slice(0, 255)
  return neutral && neutral !== '.' && neutral !== '..' ? neutral : fallback
}

function isoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function safeId(value: unknown): value is string {
  return nonEmptyString(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

function safeWorkspacePath(value: unknown): value is string {
  if (!nonEmptyString(value, 1024) || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const normalized = path.posix.normalize(value)
  return normalized === value && normalized !== '.' && !normalized.startsWith('../') && !normalized.includes('/../')
}

function parseArtifact(value: unknown): AgentArtifactRef | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'kind', 'versionId', 'workspacePath'])) return null
  if (!safeId(value.id) || !nonEmptyString(value.kind, 80) || !safeId(value.versionId) || !safeWorkspacePath(value.workspacePath)) return null
  return { id: value.id, kind: value.kind, versionId: value.versionId, workspacePath: value.workspacePath } as AgentArtifactRef
}

function parseSummary(value: unknown): AgentSessionSummary | null {
  if (!isRecord(value) || !safePersistedText(value.label, 300)) return null
  if (value.kind === 'governed-action') {
    if (!hasOnlyKeys(value, ['kind', 'label', 'governedAction']) || !isRecord(value.governedAction)) return null
    const governedAction = value.governedAction
    if (!hasOnlyKeys(governedAction, ['status', 'capability', 'model', 'outputs'])) return null
    if (typeof governedAction.status !== 'string'
      || !(AGENT_GOVERNED_TERMINAL_STATUSES as readonly string[]).includes(governedAction.status)) return null
    if (!safePersistedText(governedAction.capability, 200) || !safePersistedText(governedAction.model, 200)) return null
    if (!Array.isArray(governedAction.outputs) || governedAction.outputs.length > 32) return null
    const outputs = governedAction.outputs.map((output) => {
      if (!isRecord(output) || !hasOnlyKeys(output, ['kind', 'sha256', 'sizeBytes'])) return null
      if (!safePersistedText(output.kind, 80) || typeof output.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(output.sha256)) return null
      if (!Number.isSafeInteger(output.sizeBytes) || (output.sizeBytes as number) < 0) return null
      return { kind: output.kind.trim(), sha256: output.sha256, sizeBytes: output.sizeBytes as number }
    })
    if (outputs.some((output) => !output)) return null
    return {
      kind: 'governed-action',
      label: value.label.trim(),
      governedAction: {
        status: governedAction.status as AgentGovernedTerminalStatus,
        capability: governedAction.capability.trim(),
        model: governedAction.model.trim(),
        outputs: outputs as Array<{ kind: string, sha256: string, sizeBytes: number }>,
      },
    } as AgentSessionSummary
  }
  if (!hasOnlyKeys(value, ['kind', 'label', 'artifact'])) return null
  if (value.kind !== 'action' && value.kind !== 'artifact') return null
  const artifact = value.artifact === undefined ? undefined : parseArtifact(value.artifact)
  if (value.artifact !== undefined && !artifact) return null
  if (value.kind === 'artifact' && !artifact) return null
  return { kind: value.kind, label: value.label.trim(), ...(artifact ? { artifact } : {}) }
}

function parseAttachment(value: unknown): AgentAttachmentRef | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'mimeType', 'sizeBytes'])) return null
  if (!safeId(value.id) || !nonEmptyString(value.name, 255)) return null
  if (value.mimeType !== 'image/png' && value.mimeType !== 'image/jpeg' && value.mimeType !== 'image/webp') return null
  if (safeAttachmentDisplayName(value.name, value.mimeType) !== value.name) return null
  if (!Number.isInteger(value.sizeBytes) || (value.sizeBytes as number) <= 0 || (value.sizeBytes as number) > AGENT_SESSION_MAX_ATTACHMENT_BYTES) return null
  return { id: value.id, name: value.name, mimeType: value.mimeType, sizeBytes: value.sizeBytes as number }
}

function parseMessage(value: unknown): AgentSessionMessage | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'role', 'content', 'attachmentIds', 'summaries'])) return null
  if (!safeId(value.id) || (value.role !== 'user' && value.role !== 'assistant') || !nonEmptyString(value.content, 100_000)) return null
  if (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > AGENT_SESSION_MAX_ATTACHMENTS || !value.attachmentIds.every(safeId)) return null
  if (new Set(value.attachmentIds).size !== value.attachmentIds.length) return null
  if (!Array.isArray(value.summaries) || value.summaries.length > 32) return null
  const summaries = value.summaries.map(parseSummary)
  if (summaries.some((item) => !item)) return null
  return { id: value.id, role: value.role, content: value.content, attachmentIds: [...value.attachmentIds], summaries: summaries as AgentSessionSummary[] }
}

function parseSession(value: unknown): AgentSession | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'title', 'revision', 'createdAt', 'updatedAt', 'expiresAt', 'messages', 'attachments'])) return null
  if (!safeId(value.id) || !safePersistedText(value.title, 200) || !Number.isInteger(value.revision) || (value.revision as number) < 1) return null
  if (!isoDate(value.createdAt) || !isoDate(value.updatedAt) || !isoDate(value.expiresAt)) return null
  if (Date.parse(value.expiresAt) - Date.parse(value.updatedAt) !== AGENT_SESSION_TTL_MS) return null
  if (!Array.isArray(value.messages) || !Array.isArray(value.attachments)) return null
  const attachments = value.attachments.map(parseAttachment)
  const messages = value.messages.map(parseMessage)
  if (attachments.some((item) => !item) || messages.some((item) => !item)) return null
  const attachmentIds = new Set((attachments as AgentAttachmentRef[]).map((item) => item.id))
  if ((messages as AgentSessionMessage[]).some((message) => message.attachmentIds.some((id) => !attachmentIds.has(id)))) return null
  return {
    id: value.id, title: value.title, revision: value.revision as number,
    createdAt: value.createdAt, updatedAt: value.updatedAt, expiresAt: value.expiresAt,
    messages: messages as AgentSessionMessage[], attachments: attachments as AgentAttachmentRef[],
  }
}

function parseStrictDocument(value: unknown): AgentSessionDocumentV1 | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schema', 'version', 'activeSessionId', 'sessions'])) return null
  if (value.schema !== AGENT_SESSION_SCHEMA || value.version !== AGENT_SESSION_SCHEMA_VERSION || !safeId(value.activeSessionId) || !Array.isArray(value.sessions)) return null
  const sessions = value.sessions.map(parseSession)
  if (sessions.some((item) => !item)) return null
  const parsed = sessions as AgentSession[]
  if (!parsed.some((session) => session.id === value.activeSessionId)) return null
  if (new Set(parsed.map((session) => session.id)).size !== parsed.length) return null
  return { schema: AGENT_SESSION_SCHEMA, version: AGENT_SESSION_SCHEMA_VERSION, activeSessionId: value.activeSessionId, sessions: parsed }
}

function listItem(session: AgentSession): AgentSessionListItem {
  const { messages, attachments, ...base } = session
  return { ...base, messageCount: messages.length, attachmentCount: attachments.length }
}

function imageSignatureMatches(mimeType: keyof typeof MIME_EXTENSIONS, bytes: Uint8Array): boolean {
  if (mimeType === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  if (mimeType === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
}

export class AgentSessionCleanupError extends Error {
  readonly code = 'agent_session_cleanup_failed'
  readonly recoverable = true

  constructor(operation: string, cause: unknown) {
    super(`Agent session cleanup could not complete (${operation}). Please retry.`, { cause })
    this.name = 'AgentSessionCleanupError'
  }
}

export class AgentSessionStore {
  private readonly rootDir: string
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly removePath: typeof rm
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: StoreOptions) {
    this.rootDir = options.rootDir
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomUUID
    this.removePath = options.removePath ?? rm
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private documentPath(): string { return path.join(this.rootDir, DOCUMENT_FILE) }
  private attachmentsRoot(): string { return path.join(this.rootDir, ATTACHMENTS_DIR) }
  private attachmentPath(sessionId: string, attachment: AgentAttachmentRef): string {
    return path.join(this.attachmentsRoot(), sessionId, `${attachment.id}${MIME_EXTENSIONS[attachment.mimeType]}`)
  }

  private async secureOpenedPath(
    target: string,
    expected: 'directory' | 'file',
    mode: number,
    missingAllowed = false,
  ): Promise<boolean> {
    let pathInfo
    try {
      pathInfo = await lstat(target)
    } catch (error) {
      if (missingAllowed && isMissingError(error)) return false
      throw error
    }
    const validType = expected === 'directory' ? pathInfo.isDirectory() : pathInfo.isFile()
    if (pathInfo.isSymbolicLink() || !validType) {
      throw new Error(`Agent session ${expected === 'directory' ? 'root' : 'document'} must be a real ${expected}.`)
    }
    const directoryFlag = expected === 'directory' ? (constants.O_DIRECTORY ?? 0) : 0
    const handle = await open(target, constants.O_RDONLY | directoryFlag | (constants.O_NOFOLLOW ?? 0))
    try {
      const openedInfo = await handle.stat()
      const openedType = expected === 'directory' ? openedInfo.isDirectory() : openedInfo.isFile()
      if (!openedType || openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
        throw new Error(`Agent session ${expected === 'directory' ? 'root' : 'document'} changed during validation.`)
      }
      await handle.chmod(mode)
    } finally {
      await handle.close()
    }
    return true
  }

  private async requireSecureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    await this.secureOpenedPath(this.rootDir, 'directory', 0o700)
  }

  private async secureDocumentIfPresent(): Promise<void> {
    await this.secureOpenedPath(this.documentPath(), 'file', 0o600, true)
  }

  private async removeForCleanup(
    target: string,
    options: Parameters<typeof rm>[1],
    operation: string,
  ): Promise<void> {
    try {
      await this.removePath(target, options)
    } catch (error) {
      if (isMissingError(error)) return
      if (error instanceof AgentSessionCleanupError) throw error
      throw new AgentSessionCleanupError(operation, error)
    }
  }

  private async requireManagedAttachmentsRoot(create: boolean): Promise<string> {
    const root = this.attachmentsRoot()
    if (create) await mkdir(root, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Managed attachment root must be a real directory.')
    return realpath(root)
  }

  private async requireManagedSessionDir(sessionId: string, create: boolean): Promise<string> {
    const canonicalRoot = await this.requireManagedAttachmentsRoot(create)
    const sessionDir = path.join(this.attachmentsRoot(), sessionId)
    if (create) {
      try { await mkdir(sessionDir, { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const sessionInfo = await lstat(sessionDir)
    if (sessionInfo.isSymbolicLink() || !sessionInfo.isDirectory()) throw new Error('Managed attachment session directory cannot be a symlink.')
    const canonicalSessionDir = await realpath(sessionDir)
    if (path.dirname(canonicalSessionDir) !== canonicalRoot) throw new Error('Managed attachment session directory escaped its canonical root.')
    return canonicalSessionDir
  }

  private async writeManagedAttachment(sessionId: string, attachment: AgentAttachmentRef, bytes: Uint8Array): Promise<string> {
    const sessionDir = await this.requireManagedSessionDir(sessionId, true)
    const destination = path.join(sessionDir, `${attachment.id}${MIME_EXTENSIONS[attachment.mimeType]}`)
    try {
      await lstat(destination)
      throw new Error('Managed attachment destination already exists.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temp = `${destination}.${this.randomId()}.tmp`
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, destination)
    const destinationInfo = await lstat(destination)
    if (destinationInfo.isSymbolicLink() || !destinationInfo.isFile() || path.dirname(await realpath(destination)) !== sessionDir) {
      await this.removeForCleanup(destination, { recursive: true, force: true }, 'discard invalid attachment')
      throw new Error('Managed attachment destination failed containment validation.')
    }
    return destination
  }

  private async readManagedAttachment(sessionId: string, attachment: AgentAttachmentRef): Promise<Uint8Array> {
    const sessionDir = await this.requireManagedSessionDir(sessionId, false)
    const source = path.join(sessionDir, `${attachment.id}${MIME_EXTENSIONS[attachment.mimeType]}`)
    const sourceInfo = await lstat(source)
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || path.dirname(await realpath(source)) !== sessionDir) {
      throw new Error('Managed attachment file cannot be a symlink or escape its session directory.')
    }
    const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const openedInfo = await handle.stat()
      if (!openedInfo.isFile() || openedInfo.dev !== sourceInfo.dev || openedInfo.ino !== sourceInfo.ino) {
        throw new Error('Managed attachment changed during validation.')
      }
      return new Uint8Array(await handle.readFile())
    } finally {
      await handle.close()
    }
  }

  private async removeManagedAttachment(sessionId: string, attachment: AgentAttachmentRef): Promise<void> {
    let sessionDir: string
    try {
      sessionDir = await this.requireManagedSessionDir(sessionId, false)
    } catch (error) {
      if (isMissingError(error)) return
      throw new AgentSessionCleanupError('validate attachment directory', error)
    }
    const target = path.join(sessionDir, `${attachment.id}${MIME_EXTENSIONS[attachment.mimeType]}`)
    try {
      await lstat(target)
    } catch (error) {
      if (isMissingError(error)) return
      throw new AgentSessionCleanupError('inspect attachment', error)
    }
    await this.removeForCleanup(target, { recursive: true, force: true }, 'remove attachment')
  }

  private async removeManagedSessionDirectory(sessionId: string): Promise<void> {
    let canonicalRoot: string
    try {
      canonicalRoot = await this.requireManagedAttachmentsRoot(false)
    } catch (error) {
      if (isMissingError(error)) return
      throw new AgentSessionCleanupError('validate attachment root', error)
    }
    const sessionDir = path.join(this.attachmentsRoot(), sessionId)
    let info
    try {
      info = await lstat(sessionDir)
    } catch (error) {
      if (isMissingError(error)) return
      throw new AgentSessionCleanupError('inspect session attachments', error)
    }
    if (!info.isSymbolicLink()) {
      if (!info.isDirectory()) throw new AgentSessionCleanupError('validate session attachments', new Error('Managed session attachment path is not a directory.'))
      let canonicalSessionDir: string
      try {
        canonicalSessionDir = await realpath(sessionDir)
      } catch (error) {
        throw new AgentSessionCleanupError('validate session attachments', error)
      }
      if (path.dirname(canonicalSessionDir) !== canonicalRoot) {
        throw new AgentSessionCleanupError('validate session attachments', new Error('Managed session attachment directory escaped its root.'))
      }
    }
    await this.removeForCleanup(sessionDir, { recursive: true, force: true }, 'remove session attachments')
  }

  private newSession(title = DEFAULT_TITLE): AgentSession {
    const now = this.now()
    const timestamp = new Date(now).toISOString()
    return {
      id: this.randomId(), title: title.trim() || DEFAULT_TITLE, revision: 1,
      createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(now + AGENT_SESSION_TTL_MS).toISOString(),
      messages: [], attachments: [],
    }
  }

  private async readRaw(): Promise<unknown | null> {
    try { return JSON.parse(await readFile(this.documentPath(), 'utf8')) as unknown }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async backupCorrupt(): Promise<void> {
    try {
      await this.pruneCorruptBackups()
      const suffix = `${this.now()}-${this.randomId()}`
      await writeFile(path.join(this.rootDir, `agent-sessions.corrupt-${suffix}.json`), await readFile(this.documentPath()), { mode: 0o600 })
    } catch (error) {
      if (error instanceof AgentSessionCleanupError) throw error
      throw new AgentSessionCleanupError('preserve corrupt session backup', error)
    }
  }

  private async pruneCorruptBackups(removeAll = false): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.rootDir)
    } catch (error) {
      if (isMissingError(error)) return
      throw new AgentSessionCleanupError('inspect corrupt session backups', error)
    }
    const cutoff = this.now() - AGENT_SESSION_TTL_MS
    for (const name of entries) {
      const match = /^agent-sessions\.corrupt-(\d+)-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.exec(name)
      if (!match) continue
      const createdAt = Number(match[1])
      if (removeAll || (Number.isSafeInteger(createdAt) && createdAt <= cutoff)) {
        await this.removeForCleanup(path.join(this.rootDir, name), { force: true }, 'remove corrupt session backup')
      }
    }
  }

  private async load(): Promise<{ document: AgentSessionDocumentV1, readOnly: false } | { document: null, readOnly: true }> {
    await this.requireSecureRoot()
    await this.secureDocumentIfPresent()
    let raw: unknown
    try { raw = await this.readRaw() }
    catch {
      await this.pruneTempFiles()
      await this.pruneCorruptBackups()
      await this.backupCorrupt()
      const fresh = this.freshDocument()
      await this.writeDocument(fresh)
      return { document: fresh, readOnly: false }
    }
    if (raw === null) {
      await this.pruneTempFiles()
      await this.pruneCorruptBackups()
      const fresh = this.freshDocument()
      await this.writeDocument(fresh)
      return { document: fresh, readOnly: false }
    }
    if (isRecord(raw) && raw.schema === AGENT_SESSION_SCHEMA && typeof raw.version === 'number' && raw.version > AGENT_SESSION_SCHEMA_VERSION) {
      return { document: null, readOnly: true }
    }
    await this.pruneTempFiles()
    await this.pruneCorruptBackups()
    let document = parseStrictDocument(raw)
    if (!document) {
      await this.backupCorrupt()
      const parsedCandidates = isRecord(raw) && Array.isArray(raw.sessions) ? raw.sessions.map(parseSession).filter((item): item is AgentSession => item !== null) : []
      const seenIds = new Set<string>()
      const candidates = parsedCandidates.filter((candidate) => {
        if (seenIds.has(candidate.id)) return false
        seenIds.add(candidate.id)
        return true
      })
      const active = isRecord(raw) && safeId(raw.activeSessionId) && candidates.some((item) => item.id === raw.activeSessionId) ? raw.activeSessionId : candidates[0]?.id
      document = candidates.length > 0 && active
        ? { schema: AGENT_SESSION_SCHEMA, version: AGENT_SESSION_SCHEMA_VERSION, activeSessionId: active, sessions: candidates }
        : this.freshDocument()
      await this.writeDocument(document)
    }
    document = await this.pruneExpired(document)
    await this.pruneOrphans(document)
    return { document, readOnly: false }
  }

  private freshDocument(): AgentSessionDocumentV1 {
    const session = this.newSession()
    return { schema: AGENT_SESSION_SCHEMA, version: AGENT_SESSION_SCHEMA_VERSION, activeSessionId: session.id, sessions: [session] }
  }

  private async writeDocument(document: AgentSessionDocumentV1): Promise<void> {
    await this.requireSecureRoot()
    const temp = path.join(this.rootDir, `${DOCUMENT_FILE}.${this.randomId()}.tmp`)
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.documentPath())
  }

  private async pruneExpired(document: AgentSessionDocumentV1): Promise<AgentSessionDocumentV1> {
    const survivors = document.sessions.filter((session) => Date.parse(session.expiresAt) > this.now())
    if (survivors.length === document.sessions.length) return document
    const nextSurvivors = survivors.length > 0 ? survivors : [this.newSession()]
    const activeSessionId = nextSurvivors.some((item) => item.id === document.activeSessionId)
      ? document.activeSessionId
      : [...nextSurvivors].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0].id
    const next = { ...document, activeSessionId, sessions: nextSurvivors }
    try { await this.writeDocument(next) } catch { /* Logical pruning still wins if cleanup persistence fails. */ }
    await this.pruneOrphans(next)
    return next
  }

  private async pruneTempFiles(): Promise<void> {
    try {
      const entries = await readdir(this.rootDir)
      const isV1Temp = (name: string) => /^agent-sessions\.json\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tmp$/.test(name)
      await Promise.all(entries.filter(isV1Temp).map((name) => rm(path.join(this.rootDir, name), { force: true }).catch(() => undefined)))
    } catch { /* best effort */ }
  }

  private async pruneOrphans(document: AgentSessionDocumentV1): Promise<void> {
    try {
      await this.requireManagedAttachmentsRoot(false)
      const sessionIds = new Set(document.sessions.map((session) => session.id))
      const dirs = await readdir(this.attachmentsRoot())
      for (const dir of dirs) {
        const candidate = path.join(this.attachmentsRoot(), dir)
        const info = await lstat(candidate).catch(() => null)
        if (!info) continue
        if (info.isSymbolicLink() || !sessionIds.has(dir)) {
          await rm(candidate, { recursive: true, force: true }).catch(() => undefined)
        }
      }
      for (const session of document.sessions) {
        const expected = new Set(session.attachments.map((attachment) => path.basename(this.attachmentPath(session.id, attachment))))
        try {
          const sessionDir = await this.requireManagedSessionDir(session.id, false)
          const files = await readdir(sessionDir)
          await Promise.all(files.filter((file) => file.endsWith('.tmp') || !expected.has(file)).map((file) => rm(path.join(sessionDir, file), { force: true }).catch(() => undefined)))
        } catch { /* no attachment directory */ }
      }
    } catch { /* no attachment root */ }
  }

  private requireWritable(result: Awaited<ReturnType<AgentSessionStore['load']>>): AgentSessionDocumentV1 {
    if (result.readOnly) throw new Error('Agent sessions were written by a newer version of Modly and are read-only.')
    return result.document
  }

  private find(document: AgentSessionDocumentV1, sessionId: string): AgentSession {
    if (!safeId(sessionId)) throw new Error('Invalid agent session identifier.')
    const session = document.sessions.find((item) => item.id === sessionId)
    if (!session || Date.parse(session.expiresAt) <= this.now()) throw new Error('Agent session not found or expired.')
    return session
  }

  private checkRevision(session: AgentSession, expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || session.revision !== expectedRevision) throw new Error('Agent session revision conflict.')
  }

  private mutate(session: AgentSession, patch: Partial<Pick<AgentSession, 'title' | 'messages' | 'attachments'>>): AgentSession {
    const now = this.now()
    const timestamp = new Date(now).toISOString()
    return { ...session, ...patch, revision: session.revision + 1, updatedAt: timestamp, expiresAt: new Date(now + AGENT_SESSION_TTL_MS).toISOString() }
  }

  /**
   * Linearizes an external main-process commit with session activation and
   * deletion. The operation runs only while sessionId is the live active
   * session, under the same exclusive queue used by every session mutation.
   */
  async commitIfActive(
    sessionId: string,
    operation: () => Promise<void>,
  ): Promise<'committed' | 'inactive' | 'commit_failed'> {
    return this.exclusive(async () => {
      if (!safeId(sessionId) || typeof operation !== 'function') return 'inactive'
      const loaded = await this.load()
      if (loaded.readOnly || loaded.document.activeSessionId !== sessionId) return 'inactive'
      try {
        this.find(loaded.document, sessionId)
      } catch {
        return 'inactive'
      }
      try {
        await operation()
        return 'committed'
      } catch {
        return 'commit_failed'
      }
    })
  }

  async list(): Promise<AgentSessionListResult> {
    return this.exclusive(async () => {
      const loaded = await this.load()
      if (loaded.readOnly) return { sessions: [], activeSessionId: '', readOnly: true }
      return { sessions: loaded.document.sessions.map(listItem).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), activeSessionId: loaded.document.activeSessionId, readOnly: false }
    })
  }

  async create(request: AgentSessionCreateRequest): Promise<AgentSession> {
    return this.exclusive(async () => {
      if (!isRecord(request) || !hasOnlyKeys(request, ['title']) || (request.title !== undefined && !safePersistedText(request.title, 200))) throw new Error('Invalid agent session create request.')
      const loaded = await this.load(); const document = this.requireWritable(loaded)
      const session = this.newSession(request.title)
      await this.writeDocument({ ...document, activeSessionId: session.id, sessions: [...document.sessions, session] })
      return session
    })
  }

  async read(request: AgentSessionReadRequest): Promise<AgentSession> {
    return this.exclusive(async () => {
      if (!isRecord(request) || !hasOnlyKeys(request, ['sessionId'])) throw new Error('Invalid agent session read request.')
      const loaded = await this.load(); const document = this.requireWritable(loaded)
      return this.find(document, request.sessionId)
    })
  }

  async activate(request: AgentSessionActivateRequest): Promise<AgentSessionListResult> {
    return this.exclusive(async () => {
      if (!isRecord(request) || !hasOnlyKeys(request, ['sessionId'])) throw new Error('Invalid agent session activate request.')
      const loaded = await this.load(); const document = this.requireWritable(loaded)
      this.find(document, request.sessionId)
      if (document.activeSessionId !== request.sessionId) await this.writeDocument({ ...document, activeSessionId: request.sessionId })
      return { sessions: document.sessions.map(listItem).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), activeSessionId: request.sessionId, readOnly: false }
    })
  }

  async rename(request: AgentSessionRenameRequest): Promise<AgentSession> {
    return this.exclusive(async () => {
      if (!isRecord(request) || !hasOnlyKeys(request, ['sessionId', 'expectedRevision', 'title']) || !safePersistedText(request.title, 200)) throw new Error('Invalid agent session rename request.')
      const loaded = await this.load(); const document = this.requireWritable(loaded); const session = this.find(document, request.sessionId)
      this.checkRevision(session, request.expectedRevision)
      const title = request.title.trim()
      if (title === session.title) return session
      const updated = this.mutate(session, { title })
      await this.writeDocument({ ...document, sessions: document.sessions.map((item) => item.id === updated.id ? updated : item) })
      return updated
    })
  }

  async appendMessage(request: AgentSessionAppendMessageRequest): Promise<AgentSession> {
    return this.exclusive(async () => {
      if (!isRecord(request) || !hasOnlyKeys(request, ['sessionId', 'expectedRevision', 'message']) || !isRecord(request.message)) throw new Error('Invalid agent session message request.')
      if (!hasOnlyKeys(request.message, ['id', 'role', 'content', 'attachmentIds', 'summaries'])) throw new Error('Agent messages may contain only allowed fields.')
      const summaries = Array.isArray(request.message.summaries)
        ? request.message.summaries.map((summary) => isRecord(summary) && typeof summary.label === 'string'
          ? { ...summary, label: redactPersistedText(summary.label, 300) }
          : summary)
        : []
      const message = parseMessage({ ...request.message, attachmentIds: request.message.attachmentIds ?? [], summaries })
      if (!message) throw new Error('Invalid agent session message.')
      const loaded = await this.load(); const document = this.requireWritable(loaded); const session = this.find(document, request.sessionId)
      this.checkRevision(session, request.expectedRevision)
      if (session.messages.some((item) => item.id === message.id)) throw new Error('Agent message identifier already exists.')
      if (message.attachmentIds.some((id) => !session.attachments.some((attachment) => attachment.id === id))) throw new Error('Agent message references an unavailable attachment.')
      const updated = this.mutate(session, { messages: [...session.messages, message] })
      await this.writeDocument({ ...document, sessions: document.sessions.map((item) => item.id === updated.id ? updated : item) })
      return updated
    })
  }

  async addAttachment(request: AgentSessionAddAttachmentRequest): Promise<AgentSession> {
    return this.exclusive(async () => {
      if (!isRecord(request) || !hasOnlyKeys(request, ['sessionId', 'expectedRevision', 'attachment']) || !isRecord(request.attachment) || !hasOnlyKeys(request.attachment, ['name', 'mimeType', 'bytes'])) throw new Error('Invalid agent session attachment request.')
      const { name, mimeType } = request.attachment
      const bytes = request.attachment.bytes instanceof Uint8Array ? request.attachment.bytes : null
      if (!nonEmptyString(name, 255) || !(mimeType in MIME_EXTENSIONS) || !bytes || bytes.byteLength <= 0 || bytes.byteLength > AGENT_SESSION_MAX_ATTACHMENT_BYTES) throw new Error('Invalid agent session attachment.')
      if (!imageSignatureMatches(mimeType as keyof typeof MIME_EXTENSIONS, bytes)) throw new Error('Attachment image signature does not match its validated media type.')
      const loaded = await this.load(); const document = this.requireWritable(loaded); const session = this.find(document, request.sessionId)
      this.checkRevision(session, request.expectedRevision)
      const referencedIds = new Set(session.messages.flatMap((message) => message.attachmentIds))
      const stagedCount = session.attachments.filter((attachment) => !referencedIds.has(attachment.id)).length
      if (stagedCount >= AGENT_SESSION_MAX_ATTACHMENTS) throw new Error('Agent session staged attachment count limit exceeded.')
      const validatedMimeType = mimeType as keyof typeof MIME_EXTENSIONS
      const attachment: AgentAttachmentRef = {
        id: this.randomId(),
        name: safeAttachmentDisplayName(name, validatedMimeType),
        mimeType: validatedMimeType,
        sizeBytes: bytes.byteLength,
      }
      await this.writeManagedAttachment(session.id, attachment, bytes)
      const updated = this.mutate(session, { attachments: [...session.attachments, attachment] })
      try { await this.writeDocument({ ...document, sessions: document.sessions.map((item) => item.id === updated.id ? updated : item) }) }
      catch (error) { await this.removeManagedAttachment(session.id, attachment); throw error }
      return updated
    })
  }

  async readAttachment(request: AgentSessionReadAttachmentRequest): Promise<Uint8Array> {
    return this.exclusive(async () => {
      if (!isRecord(request) || !hasOnlyKeys(request, ['sessionId', 'attachmentId']) || !safeId(request.attachmentId)) throw new Error('Invalid agent session attachment read request.')
      const loaded = await this.load(); const document = this.requireWritable(loaded); const session = this.find(document, request.sessionId)
      const attachment = session.attachments.find((item) => item.id === request.attachmentId)
      if (!attachment) throw new Error('Agent attachment not found.')
      const file = await this.readManagedAttachment(session.id, attachment)
      if (file.byteLength !== attachment.sizeBytes || !imageSignatureMatches(attachment.mimeType, file)) throw new Error('Agent attachment is corrupt.')
      return file
    })
  }

  async removeAttachment(request: AgentSessionRemoveAttachmentRequest): Promise<AgentSession> {
    return this.exclusive(async () => {
      if (!isRecord(request) || !hasOnlyKeys(request, ['sessionId', 'expectedRevision', 'attachmentId']) || !safeId(request.attachmentId)) {
        throw new Error('Invalid agent session attachment removal request.')
      }
      const loaded = await this.load(); const document = this.requireWritable(loaded); const session = this.find(document, request.sessionId)
      this.checkRevision(session, request.expectedRevision)
      const attachment = session.attachments.find((item) => item.id === request.attachmentId)
      if (!attachment) throw new Error('Agent attachment not found.')
      if (session.messages.some((message) => message.attachmentIds.includes(attachment.id))) {
        throw new Error('Referenced agent attachments cannot be removed.')
      }
      const updated = this.mutate(session, { attachments: session.attachments.filter((item) => item.id !== attachment.id) })
      await this.removeManagedAttachment(session.id, attachment)
      await this.writeDocument({ ...document, sessions: document.sessions.map((item) => item.id === updated.id ? updated : item) })
      return updated
    })
  }

  async delete(request: AgentSessionDeleteRequest): Promise<AgentSessionListResult> {
    return this.exclusive(async () => {
      if (!isRecord(request) || !hasOnlyKeys(request, ['sessionId', 'expectedRevision'])) throw new Error('Invalid agent session delete request.')
      const loaded = await this.load(); const document = this.requireWritable(loaded); const session = this.find(document, request.sessionId)
      this.checkRevision(session, request.expectedRevision)
      const survivors = document.sessions.filter((item) => item.id !== session.id)
      if (survivors.length === 0) survivors.push(this.newSession())
      const activeSessionId = document.activeSessionId === session.id
        ? [...survivors].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0].id
        : document.activeSessionId
      const next = { ...document, activeSessionId, sessions: survivors }
      await this.pruneCorruptBackups(true)
      await this.removeManagedSessionDirectory(session.id)
      await this.writeDocument(next)
      return { sessions: survivors.map(listItem).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), activeSessionId, readOnly: false }
    })
  }
}
