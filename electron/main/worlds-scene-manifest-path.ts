import { isAbsolute, relative, resolve } from 'node:path'

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/

export function resolveSafeWorkspaceJsonPath(workspaceDir: string, workspacePath: string): { workspacePath: string; absolutePath: string } | null {
  const normalized = String(workspacePath ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || !normalized.endsWith('.json') || normalized.includes('\0') || /%2e|%2f|%5c/i.test(normalized)) return null
  if (normalized.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(normalized)) return null
  if (normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null

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
