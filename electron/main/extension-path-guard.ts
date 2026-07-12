import { isAbsolute, relative, resolve as resolvePath } from 'node:path'

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const OWNERSHIP_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

function assertSafeSingleSegment(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`)
  }

  if (CONTROL_CHARACTER_PATTERN.test(value)) {
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

  if (normalizedRelative === '..' || normalizedRelative.startsWith('../') || isAbsolute(normalizedRelative)) {
    throw new Error(`Resolved path escapes root: ${unsafeLeaf}`)
  }

  return resolvedCandidate
}

export function resolveExtensionPathWithinRoot(rootDir: string, extensionId: unknown): string {
  return resolvePathWithinRoot(rootDir, assertSafeExtensionId(extensionId))
}

export function buildExtensionBackupPath(rootDir: string, extensionId: unknown, suffix: string): string {
  const safeId = assertSafeExtensionId(extensionId)
  return resolvePathWithinRoot(rootDir, `.modly-backup-${safeId}-${suffix}`)
}
