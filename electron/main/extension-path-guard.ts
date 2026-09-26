import { isAbsolute, relative, resolve as resolvePath } from 'node:path'

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const OWNERSHIP_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function assertSafeSingleSegment(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`)
  }

  if (hasControlCharacter(value)) {
    throw new Error(`${label} must not contain control characters`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${label} must not be empty`)
  }
  if (trimmed !== value) {
    throw new Error(`${label} must not contain surrounding whitespace`)
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`${label} "${value}" is invalid`)
  }
  if (trimmed.length > 128) {
    throw new Error(`${label} must not exceed 128 characters`)
  }
  if (isAbsolute(trimmed)) {
    throw new Error(`${label} "${value}" must not be an absolute path`)
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`${label} "${value}" must not contain path separators`)
  }
  if (!pattern.test(trimmed)) {
    throw new Error(`${label} "${value}" must match ${pattern}`)
  }

  return trimmed
}

export function assertSafeOwnershipSegment(value: unknown, label = 'Ownership identifier'): string {
  return assertSafeSingleSegment(value, label, OWNERSHIP_SEGMENT_PATTERN)
}

export function assertSafeExtensionId(extensionId: unknown): string {
  return assertSafeSingleSegment(extensionId, 'Extension id', EXTENSION_ID_PATTERN)
}

export function resolvePathWithinRoot(rootDir: string, unsafeLeaf: string): string {
  const resolvedRoot = resolvePath(rootDir)
  const resolvedCandidate = resolvePath(resolvedRoot, unsafeLeaf)
  const normalizedRelative = relative(resolvedRoot, resolvedCandidate).replace(/\\/g, '/')

  // An empty relative path means the leaf resolved to the root itself ('', '.')
  // — never a valid child, and catastrophic for deletion call sites.
  if (normalizedRelative === '' || normalizedRelative === '..' || normalizedRelative.startsWith('../') || isAbsolute(normalizedRelative)) {
    throw new Error(`Resolved path escapes root: ${unsafeLeaf}`)
  }

  return resolvedCandidate
}

export function resolveExtensionPathWithinRoot(rootDir: string, extensionId: unknown): string {
  return resolvePathWithinRoot(rootDir, assertSafeExtensionId(extensionId))
}

// ─── Internal (non-extension) dir names inside extensionsDir ─────────────────
// Extension ids can never start with a dot, so dot-prefixed names are reserved
// for install machinery: staging copies, backups of the previous version.
// Both the Electron and Python discovery sides must skip them.

export const EXT_BACKUP_PREFIX  = '.modly-backup-'
export const EXT_STAGING_PREFIX = '.modly-staging-'
// Marker file inside an extension folder while its setup is still running —
// presence after a crash means the install never completed.
export const EXT_INCOMPLETE_MARKER = '.modly-incomplete'
// Reserved basename for registration-pending state. Active transactions append
// "-<extension-id>-<timestamp>" and live beside extension folders so linked
// source trees are never mutated.
export const EXT_REGISTRATION_PENDING_MARKER = '.modly-registration-pending'
// Reserved basename for the matching validated transaction commit marker.
export const EXT_VALIDATED_MARKER = '.modly-registration-validated'

export function isInternalExtensionDirName(name: string): boolean {
  return name.startsWith('.')
}

export function buildExtensionBackupPath(rootDir: string, extensionId: unknown, suffix: string): string {
  const safeId = assertSafeExtensionId(extensionId)
  return resolvePathWithinRoot(rootDir, `${EXT_BACKUP_PREFIX}${safeId}-${suffix}`)
}

// A backup dir is the previous version of an extension, parked during an
// install swap. Its name embeds the extension id: .modly-backup-<id>-<ts>.
// Ids may contain '-', so strip the numeric timestamp suffix, not a naive split.
export function parseExtensionBackupName(name: string): { extensionId: string } | null {
  if (!name.startsWith(EXT_BACKUP_PREFIX)) return null
  const rest  = name.slice(EXT_BACKUP_PREFIX.length)
  const match = rest.match(/^(.+)-\d+$/)
  if (!match) return null
  try {
    return { extensionId: assertSafeExtensionId(match[1]) }
  } catch {
    return null
  }
}

// Staging dir lives next to the final location so activation is a same-volume
// atomic rename. Unique per attempt (suffix) so a new install can never merge
// into the leftovers of a previous one, and never races the startup purge.
export function buildExtensionStagingPath(rootDir: string, extensionId: unknown, suffix: string): string {
  const safeId = assertSafeExtensionId(extensionId)
  return resolvePathWithinRoot(rootDir, `${EXT_STAGING_PREFIX}${safeId}-${suffix}`)
}
