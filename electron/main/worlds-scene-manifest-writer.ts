import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { SceneArtifactManifestV1 } from '../../src/shared/types/artifacts.ts'
import { isSceneManifestRecord, resolveSafeWorkspaceJsonPath } from './worlds-scene-manifest-path.ts'

const writeQueues = new Map<string, Promise<void>>()

interface SceneManifestWriteRequest {
  workspacePath: string
  manifest: SceneArtifactManifestV1
}

type SceneManifestWriteResult =
  | { success: true; workspacePath: string }
  | { success: false; error: string }

/**
 * The main process exclusively owns scene-manifest directory creation during
 * this operation. Node has no portable openat-style API, so every existing
 * ancestor is rejected when it is a link, every newly created segment is
 * immediately revalidated, and the final file is opened with O_NOFOLLOW.
 * Existing multiply-linked files are rejected before any truncation so an
 * export path cannot alias repository-owned data through a hard link.
 * Adversarial external filesystem renames remain outside this same-process
 * namespace guarantee and therefore fail closed whenever identity changes are
 * observable.
 */
export async function writeWorldsSceneManifest(
  workspaceDir: string,
  requestValue: unknown,
): Promise<SceneManifestWriteResult> {
  const request = parseRequest(requestValue)
  if (!request) return { success: false, error: 'Worlds scene manifest payload is invalid.' }
  if (typeof workspaceDir !== 'string' || !workspaceDir.trim()
    || workspaceDir.includes('\0') || !isAbsolute(workspaceDir)) {
    return { success: false, error: 'Worlds scene manifest destination is unsafe.' }
  }
  const lexical = resolveSafeWorkspaceJsonPath(workspaceDir, request.workspacePath)
  if (!lexical) {
    return { success: false, error: 'Worlds scene manifests must be saved as safe workspace-relative JSON files.' }
  }
  try {
    const workspaceRoot = await realpath(workspaceDir)
    const rootInfo = await lstat(workspaceRoot)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('unsafe root')
    return await enqueueWrite(workspaceRoot, async () => {
      await writeManifestWithinRoot(workspaceRoot, lexical.workspacePath, request.manifest)
      return { success: true, workspacePath: lexical.workspacePath }
    })
  } catch {
    return { success: false, error: 'Worlds scene manifest destination is unsafe.' }
  }
}

async function writeManifestWithinRoot(
  workspaceRoot: string,
  workspacePath: string,
  manifest: SceneArtifactManifestV1,
): Promise<void> {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('no no-follow support')
  const segments = workspacePath.split('/')
  const fileName = segments.at(-1)
  if (!fileName) throw new Error('missing file')
  const parentSegments = segments.slice(0, -1)
  await ensurePhysicalParents(workspaceRoot, parentSegments)
  const parent = await validatePhysicalParents(workspaceRoot, parentSegments)
  const target = join(parent, fileName)
  assertPhysicalContainment(workspaceRoot, target)
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  let existing: Awaited<ReturnType<typeof lstat>> | null = null
  try {
    existing = await lstat(target)
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) throw new Error('unsafe target')
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error
  }

  const flags = existing
    ? constants.O_WRONLY | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  const handle = await open(target, flags, 0o600)
  try {
    const opened = await handle.stat()
    const current = await lstat(target)
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile()
      || opened.nlink !== 1 || current.nlink !== 1
      || opened.dev !== current.dev || opened.ino !== current.ino
      || (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino))) {
      throw new Error('target identity changed')
    }
    const revalidatedParent = await validatePhysicalParents(workspaceRoot, parentSegments)
    if (resolve(revalidatedParent) !== resolve(parent)) throw new Error('parent identity changed')
    if (existing) await handle.truncate(0)
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(parent)
}

async function ensurePhysicalParents(workspaceRoot: string, segments: string[]): Promise<void> {
  let current = workspaceRoot
  for (const segment of segments) {
    const candidate = join(current, segment)
    assertPhysicalContainment(workspaceRoot, candidate)
    try {
      const info = await lstat(candidate)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe directory')
    } catch (error) {
      if (nodeErrorCode(error) !== 'ENOENT') throw error
      try { await mkdir(candidate, { mode: 0o700 }) } catch (mkdirError) {
        if (nodeErrorCode(mkdirError) !== 'EEXIST') throw mkdirError
      }
      const created = await lstat(candidate)
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('unsafe created directory')
      await syncDirectory(dirname(candidate))
    }
    const physical = await realpath(candidate)
    assertPhysicalContainment(workspaceRoot, physical)
    current = physical
  }
}

async function validatePhysicalParents(workspaceRoot: string, segments: string[]): Promise<string> {
  let current = workspaceRoot
  for (const segment of segments) {
    const candidate = join(current, segment)
    assertPhysicalContainment(workspaceRoot, candidate)
    const info = await lstat(candidate)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe directory')
    const physical = await realpath(candidate)
    assertPhysicalContainment(workspaceRoot, physical)
    current = physical
  }
  return current
}

function assertPhysicalContainment(workspaceRoot: string, candidate: string): void {
  const relativePath = relative(resolve(workspaceRoot), resolve(candidate))
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('workspace escape')
  }
  const protectedRoot = join(resolve(workspaceRoot), 'Worlds')
  const protectedRelative = relative(protectedRoot, resolve(candidate))
  if (protectedRelative === '' || (!protectedRelative.startsWith('..') && !isAbsolute(protectedRelative))) {
    throw new Error('canonical Worlds namespace')
  }
}

function parseRequest(value: unknown): SceneManifestWriteRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (Reflect.ownKeys(value).some((key) => key !== 'workspacePath' && key !== 'manifest')) return null
  const record = value as { workspacePath?: unknown; manifest?: unknown }
  if (typeof record.workspacePath !== 'string' || !isSceneManifestRecord(record.manifest)) return null
  return { workspacePath: record.workspacePath, manifest: record.manifest }
}

async function enqueueWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
  const queued = previous.catch(() => undefined).then(() => gate)
  writeQueues.set(key, queued)
  await previous.catch(() => undefined)
  try { return await operation() } finally {
    release()
    if (writeQueues.get(key) === queued) writeQueues.delete(key)
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch { /* unsupported directory fsync is non-fatal for legacy exports */ }
  finally { await handle?.close().catch(() => undefined) }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}
