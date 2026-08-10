import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type {
  AgentSkillsDeclarationV1,
  AgentSkillsPublicSnapshotV1,
} from '../../src/shared/types/agentActions.ts'
import { canonicalJson, sha256Canonical } from './agent-trust-contracts.ts'

const DECLARATION_SCHEMA = 'modly.agent-skills.v1' as const
const DOCUMENT_SCHEMA = 'modly.agent-skill.v1' as const
const MAX_RAW_BYTES = 8_192
const MAX_NORMALIZED_BYTES = 6_144
const MAX_PATH_BYTES = 512
const MAX_NAME_LENGTH = 96
const MAX_SUMMARY_LENGTH = 500
const MAX_BULLET_LENGTH = 512
const MAX_INSTRUCTIONS = 24
const MAX_CONSTRAINTS = 24
const MAX_EXAMPLES = 8
const SAFE_SKILL_NAME = /^modly-[a-z0-9]+(?:-[a-z0-9]+)*-v1$/
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const RAW_DIRECTIVE = /(?:\{\{|\{%|:::|@(?:include|import)\b|!INCLUDE\b)/i
const URL_SLASH_CODE_POINTS = new Set([0x2f, 0x5c, 0x2044, 0x2215, 0xff0f, 0xff3c])
const URL_COLON_CODE_POINTS = new Set([0x3a, 0x2d0, 0x2236, 0xa789, 0xfe13, 0xfe55, 0xff1a])
const URL_DOT_CODE_POINTS = new Set([0x2e, 0x3002, 0xfe52, 0xff0e, 0xff61])
const URL_DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u
const URL_WHITESPACE = /\p{White_Space}/u
const URL_SCHEME_WITH_AUTHORITY = /(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]*\s*:\s*\/\s*\//
const URL_DANGEROUS_SCHEME = /(?:^|[^a-z0-9+.-])(?:h\s*t\s*t\s*p\s*s?|f\s*i\s*l\s*e|f\s*t\s*p\s*s?|w\s*s\s*s?|d\s*a\s*t\s*a|j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|m\s*a\s*i\s*l\s*t\s*o|b\s*l\s*o\s*b)\s*:/
const URL_WWW = /(?:^|[^a-z0-9.-])w\s*w\s*w\s*\./
const FRONTMATTER_KEYS = ['name', 'version', 'summary'] as const

export type AgentSkillNormalizedV1 = Readonly<{
  schema: typeof DOCUMENT_SCHEMA
  version: 1
  name: string
  summary: string
  instructions: readonly string[]
  constraints: readonly string[]
  examples?: readonly string[]
}>

export type AgentSkillFileIdentityV1 = Readonly<{
  path: string
  device: string
  inode: string
  uid: number
  gid: number
  mode: number
  size: number
  nlink: number
  mtimeNs: string
  ctimeNs: string
  sha256: string
}>

export type BoundAgentSkillSetV1 = Readonly<{
  declaration: AgentSkillsDeclarationV1
  identity: AgentSkillFileIdentityV1
  normalized: AgentSkillNormalizedV1
  normalizedHash: string
  skillSetHash: string
  publicSnapshot: AgentSkillsPublicSnapshotV1
}>

export interface AgentSkillReadHooks {
  afterOpen?: (context: Readonly<{ absolutePath: string, handle: FileHandle }>) => void | Promise<void>
  afterRead?: (context: Readonly<{ absolutePath: string, handle: FileHandle }>) => void | Promise<void>
}

export class AgentSkillsManifestError extends Error {
  readonly code: 'invalid_declaration' | 'invalid_document' | 'unsafe_file' | 'skill_stale'

  constructor(code: AgentSkillsManifestError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AgentSkillsManifestError'
    this.code = code
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new AgentSkillsManifestError('invalid_declaration', `${label} contains an unknown field`)
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function normalizedUrlProbe(value: string): string {
  let probe = ''
  for (const character of value.normalize('NFKC').toLowerCase()) {
    const codePoint = character.codePointAt(0) as number
    if (URL_DEFAULT_IGNORABLE.test(character)) continue
    if (URL_WHITESPACE.test(character)) {
      probe += ' '
      continue
    }
    if (URL_SLASH_CODE_POINTS.has(codePoint)) probe += '/'
    else if (URL_COLON_CODE_POINTS.has(codePoint)) probe += ':'
    else if (URL_DOT_CODE_POINTS.has(codePoint)) probe += '.'
    else probe += character
  }
  return probe
}

function normalizeSkillRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATH_BYTES
    || value.trim() !== value || isAbsolute(value) || value.startsWith('/')
    || value.startsWith('//') || /^[A-Za-z]:/.test(value)
    || /[\\%?#:\0\r\n]/.test(value)) {
    throw new AgentSkillsManifestError('invalid_declaration', 'Agent skill file must be a canonical extension-relative path')
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'
    || !SAFE_PATH_SEGMENT.test(segment) || WINDOWS_RESERVED.test(segment)
    || /[. ]$/.test(segment))) {
    throw new AgentSkillsManifestError('invalid_declaration', 'Agent skill file contains an unsafe path segment')
  }
  if (!/\.md$/.test(segments.at(-1) ?? '')) {
    throw new AgentSkillsManifestError('invalid_declaration', 'Agent skill file must use the lowercase .md extension')
  }
  return segments.join('/')
}

export function normalizeAgentSkillsDeclaration(value: unknown): AgentSkillsDeclarationV1 {
  if (!isPlainRecord(value)) {
    throw new AgentSkillsManifestError('invalid_declaration', 'Agent skills declaration must be a plain object')
  }
  exactKeys(value, ['schema', 'file'], 'Agent skills declaration')
  if (value.schema !== DECLARATION_SCHEMA) {
    throw new AgentSkillsManifestError('invalid_declaration', 'Agent skills declaration schema is unsupported')
  }
  return { schema: DECLARATION_SCHEMA, file: normalizeSkillRelativePath(value.file) }
}

function plainText(value: string, label: string, maximum: number): string {
  const urlProbe = normalizedUrlProbe(value)
  if (value.length < 1 || value.length > maximum || value.trim() !== value
    || hasControlCharacter(value) || hasLoneSurrogate(value)
    || value.includes('`') || value.includes('<') || value.includes('>')
    || value.includes('[') || value.includes(']') || value.includes('~~~')
    || RAW_DIRECTIVE.test(value)
    || URL_SCHEME_WITH_AUTHORITY.test(urlProbe)
    || URL_DANGEROUS_SCHEME.test(urlProbe)
    || URL_WWW.test(urlProbe)) {
    throw new AgentSkillsManifestError('invalid_document', `${label} is not safe bounded plain text`)
  }
  return value
}

function parseFrontmatter(lines: readonly string[]): {
  bodyStart: number
  name: string
  summary: string
} {
  if (lines[0] !== '---') {
    throw new AgentSkillsManifestError('invalid_document', 'Agent skill frontmatter must start on the first line')
  }
  const end = lines.indexOf('---', 1)
  if (end !== 4) {
    throw new AgentSkillsManifestError('invalid_document', 'Agent skill frontmatter must contain exactly three ordered fields')
  }
  const parsed = new Map<string, string>()
  for (let index = 1; index < end; index += 1) {
    const match = /^([a-z][a-z_]*): (.+)$/.exec(lines[index])
    if (!match) throw new AgentSkillsManifestError('invalid_document', 'Agent skill frontmatter syntax is invalid')
    const [, key, rawValue] = match
    if (key !== FRONTMATTER_KEYS[index - 1] || parsed.has(key)) {
      throw new AgentSkillsManifestError('invalid_document', 'Agent skill frontmatter fields are unknown, duplicated, or out of order')
    }
    parsed.set(key, rawValue)
  }
  const name = plainText(parsed.get('name') ?? '', 'Agent skill name', MAX_NAME_LENGTH)
  if (!SAFE_SKILL_NAME.test(name)) {
    throw new AgentSkillsManifestError('invalid_document', 'Agent skill name must use the modly-...-v1 convention')
  }
  if (parsed.get('version') !== '1') {
    throw new AgentSkillsManifestError('invalid_document', 'Agent skill version must be integer 1')
  }
  const summary = plainText(parsed.get('summary') ?? '', 'Agent skill summary', MAX_SUMMARY_LENGTH)
  return { bodyStart: end + 1, name, summary }
}

function parseBody(lines: readonly string[]): Pick<AgentSkillNormalizedV1, 'instructions' | 'constraints' | 'examples'> {
  const significant = lines.filter((line) => line !== '')
  let section: 'instructions' | 'constraints' | 'examples' | undefined
  const instructions: string[] = []
  const constraints: string[] = []
  const examples: string[] = []
  const visited: string[] = []
  for (const line of significant) {
    if (line.startsWith('## ')) {
      const next = line === '## Instructions'
        ? 'instructions'
        : line === '## Constraints'
          ? 'constraints'
          : line === '## Examples'
            ? 'examples'
            : undefined
      if (!next) throw new AgentSkillsManifestError('invalid_document', 'Agent skill body contains an unknown heading')
      if (visited.includes(next)) throw new AgentSkillsManifestError('invalid_document', 'Agent skill body contains a duplicate heading')
      const expected = (['instructions', 'constraints', 'examples'] as const)[visited.length]
      if (next !== expected) throw new AgentSkillsManifestError('invalid_document', 'Agent skill body headings are out of order')
      visited.push(next)
      section = next
      continue
    }
    if (!section || !line.startsWith('- ') || line.slice(2).trim() !== line.slice(2)) {
      throw new AgentSkillsManifestError('invalid_document', 'Agent skill body accepts only ordered sections and plain bullet items')
    }
    const item = plainText(line.slice(2), `Agent skill ${section} item`, MAX_BULLET_LENGTH)
    const target = section === 'instructions' ? instructions : section === 'constraints' ? constraints : examples
    target.push(item)
  }
  if (instructions.length < 1 || instructions.length > MAX_INSTRUCTIONS
    || constraints.length < 1 || constraints.length > MAX_CONSTRAINTS
    || examples.length > MAX_EXAMPLES) {
    throw new AgentSkillsManifestError('invalid_document', 'Agent skill bullet collections are outside their bounds')
  }
  return {
    instructions,
    constraints,
    ...(examples.length > 0 ? { examples } : {}),
  }
}

export function parseAgentSkillDocument(bytes: Uint8Array): AgentSkillNormalizedV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_RAW_BYTES) {
    throw new AgentSkillsManifestError('invalid_document', 'Agent skill document is empty or too large')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new AgentSkillsManifestError('invalid_document', 'Agent skill document must be strict UTF-8', error)
  }
  if (text.includes('\r') || !text.endsWith('\n') || text.startsWith('\ufeff')) {
    throw new AgentSkillsManifestError('invalid_document', 'Agent skill document must use canonical LF UTF-8 text')
  }
  const lines = text.slice(0, -1).split('\n')
  const frontmatter = parseFrontmatter(lines)
  const body = parseBody(lines.slice(frontmatter.bodyStart))
  const normalized: AgentSkillNormalizedV1 = {
    schema: DOCUMENT_SCHEMA,
    version: 1,
    name: frontmatter.name,
    summary: frontmatter.summary,
    instructions: body.instructions,
    constraints: body.constraints,
    ...(body.examples ? { examples: body.examples } : {}),
  }
  const canonical = canonicalJson(normalized)
  if (Buffer.byteLength(canonical, 'utf8') > MAX_NORMALIZED_BYTES) {
    throw new AgentSkillsManifestError('invalid_document', 'Normalized Agent skill is too large')
  }
  return JSON.parse(canonical) as AgentSkillNormalizedV1
}

function outside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function safeNumber(value: bigint, label: string, maximum: number): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw new AgentSkillsManifestError('unsafe_file', `${label} is outside its bound`)
  }
  return number
}

function statIdentity(path: string, stat: BigIntStats): Omit<AgentSkillFileIdentityV1, 'sha256'> {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AgentSkillsManifestError('unsafe_file', 'Agent skill must be a regular file')
  }
  const mode = safeNumber(stat.mode & 0o7777n, 'Agent skill mode', 0o7777)
  const size = safeNumber(stat.size, 'Agent skill size', MAX_RAW_BYTES)
  const uid = safeNumber(stat.uid, 'Agent skill uid', 0xffff_ffff)
  const gid = safeNumber(stat.gid, 'Agent skill gid', 0xffff_ffff)
  const nlink = safeNumber(stat.nlink, 'Agent skill link count', Number.MAX_SAFE_INTEGER)
  if (size < 1 || nlink !== 1 || (mode & 0o002) !== 0 || (mode & 0o111) !== 0) {
    throw new AgentSkillsManifestError('unsafe_file', 'Agent skill must be a private, non-executable, singly-linked regular file')
  }
  return {
    path,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    uid,
    gid,
    mode,
    size,
    nlink,
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  }
}

function statMatches(stat: BigIntStats, identity: Omit<AgentSkillFileIdentityV1, 'sha256'>): boolean {
  return stat.isFile()
    && stat.dev.toString() === identity.device
    && stat.ino.toString() === identity.inode
    && Number(stat.uid) === identity.uid
    && Number(stat.gid) === identity.gid
    && Number(stat.mode & 0o7777n) === identity.mode
    && Number(stat.size) === identity.size
    && Number(stat.nlink) === identity.nlink
    && stat.mtimeNs.toString() === identity.mtimeNs
    && stat.ctimeNs.toString() === identity.ctimeNs
}

async function assertNoSymlinkPath(extensionDir: string, declaredPath: string): Promise<{ root: string, target: string, pathStat: BigIntStats }> {
  const root = await realpath(extensionDir)
  if (root !== resolve(extensionDir)) {
    throw new AgentSkillsManifestError('unsafe_file', 'Agent skill extension root must not be a symlink')
  }
  let cursor = root
  const segments = declaredPath.split('/')
  let pathStat: BigIntStats | undefined
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment)
    const stat = await lstat(cursor, { bigint: true })
    if (stat.isSymbolicLink()) throw new AgentSkillsManifestError('unsafe_file', 'Agent skill paths must not contain symlinks')
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new AgentSkillsManifestError('unsafe_file', 'Agent skill parents must be directories')
    }
    if (index === segments.length - 1) pathStat = stat
  }
  if (!pathStat || outside(root, cursor) || await realpath(cursor) !== cursor) {
    throw new AgentSkillsManifestError('unsafe_file', 'Agent skill escaped its extension root')
  }
  return { root, target: cursor, pathStat }
}

async function readBoundSkillFile(
  extensionDir: string,
  declaredPath: string,
  hooks?: AgentSkillReadHooks,
): Promise<{ bytes: Buffer, identity: AgentSkillFileIdentityV1 }> {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new AgentSkillsManifestError('unsafe_file', 'No-follow file opening is unavailable')
  }
  let handle: FileHandle | undefined
  try {
    const { target, pathStat } = await assertNoSymlinkPath(extensionDir, declaredPath)
    const pathIdentity = statIdentity(declaredPath, pathStat)
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    const identity = statIdentity(declaredPath, before)
    if (!statMatches(before, pathIdentity)) {
      throw new AgentSkillsManifestError('skill_stale', 'Agent skill changed before it was opened')
    }
    await hooks?.afterOpen?.({ absolutePath: target, handle })
    const chunks: Buffer[] = []
    let offset = 0
    while (offset <= MAX_RAW_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(4096, MAX_RAW_BYTES + 1 - offset))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      offset += bytesRead
    }
    if (offset > MAX_RAW_BYTES) {
      throw new AgentSkillsManifestError('unsafe_file', 'Agent skill file is too large')
    }
    await hooks?.afterRead?.({ absolutePath: target, handle })
    const after = await handle.stat({ bigint: true })
    const currentPath = await lstat(target, { bigint: true })
    if (!statMatches(after, identity) || !statMatches(currentPath, identity)
      || offset !== identity.size || await realpath(target) !== target) {
      throw new AgentSkillsManifestError('skill_stale', 'Agent skill changed while it was read')
    }
    const bytes = Buffer.concat(chunks, offset)
    return {
      bytes,
      identity: {
        ...identity,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    }
  } catch (error) {
    if (error instanceof AgentSkillsManifestError) throw error
    throw new AgentSkillsManifestError('unsafe_file', 'Agent skill file could not be bound safely', error)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function bindAgentSkillSet(
  extensionDir: string,
  declarationValue: AgentSkillsDeclarationV1,
  options: { hooks?: AgentSkillReadHooks } = {},
): Promise<BoundAgentSkillSetV1> {
  const declaration = normalizeAgentSkillsDeclaration(declarationValue)
  const source = await readBoundSkillFile(extensionDir, declaration.file, options.hooks)
  const normalized = parseAgentSkillDocument(source.bytes)
  const normalizedHash = sha256Canonical(normalized)
  const bindings = [{
    path: declaration.file,
    identity: source.identity,
    contentHash: source.identity.sha256,
    normalizedHash,
  }].sort((left, right) => codeUnitCompare(left.path, right.path))
  const skillSetHash = sha256Canonical({
    schema: 'modly.agent-skills-binding.v1',
    version: 1,
    bindings,
  })
  const publicSnapshot: AgentSkillsPublicSnapshotV1 = {
    schema: DECLARATION_SCHEMA,
    version: 1,
    hash: skillSetHash,
    count: 1,
    items: [{ name: normalized.name, version: 1, hash: normalizedHash }],
  }
  return {
    declaration,
    identity: source.identity,
    normalized,
    normalizedHash,
    skillSetHash,
    publicSnapshot,
  }
}
