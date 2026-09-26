import { isAbsolute, relative, resolve } from 'node:path'

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/
const WINDOWS_UNSAFE_SEGMENT = /[<>:"|?*]|[ .]$/

function isWindowsUnsafeSegment(segment: string): boolean {
  return WINDOWS_UNSAFE_SEGMENT.test(segment)
    || Array.from(segment).some((character) => character.codePointAt(0)! < 0x20)
}

export function resolveSafeWorkspaceJsonPath(workspaceDir: string, workspacePath: string): { workspacePath: string; absolutePath: string } | null {
  const normalized = String(workspacePath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || !normalized.endsWith('.json') || normalized.includes('\0') || /%2e|%2f|%5c/i.test(normalized)) return null
  if (normalized.startsWith('/') || WINDOWS_DRIVE_PATH.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || isWindowsUnsafeSegment(segment))) return null

  // workspace/Worlds is owned exclusively by the canonical project repository.
  // Legacy scene-manifest exports remain available under Exports/Worlds, but
  // must never bypass WorldCommandBatch or mutate repository metadata directly.
  if (segments[0]?.toLowerCase() === 'worlds') return null

  const root = resolve(workspaceDir)
  const absolutePath = resolve(root, normalized)
  const relativePath = relative(root, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null

  return { workspacePath: normalized, absolutePath }
}

export function isSceneManifestRecord(value: unknown): value is { schema: 'modly.scene-manifest.v1'; sceneRoot: string; assets: unknown[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as { schema?: unknown; sceneRoot?: unknown; assets?: unknown }
  if (candidate.schema !== 'modly.scene-manifest.v1') return false
  if (typeof candidate.sceneRoot !== 'string' || !candidate.sceneRoot.trim()) return false
  return Array.isArray(candidate.assets)
}
