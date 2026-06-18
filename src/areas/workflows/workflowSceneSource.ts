import type { SceneArtifactManifestV1 } from '../../shared/types/artifacts.ts'

export const SCENE_MANIFEST_FILE_NAME = 'scene-manifest.json'

export type SceneSourceKind = 'manifest' | 'directory'

export type ResolveSceneSourceSuccess = {
  ok: true
  sourceKind: SceneSourceKind
  inputWorkspacePath: string
  manifestWorkspacePath: string
  manifestAbsolutePath: string
  sceneRoot: string
  manifest: SceneArtifactManifestV1
}

export type ResolveSceneSourceFailure = {
  ok: false
  error: string
}

export type ResolveSceneSourceResult = ResolveSceneSourceSuccess | ResolveSceneSourceFailure

type ResolveSceneSourceArgs = {
  scenePath: string
  workspaceDir: string
  readFileBase64: (filePath: string) => Promise<string>
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value)
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizeWorkspaceRelativePath(value: string | undefined, workspaceDir: string): string | undefined {
  const normalizedValue = value?.trim().replace(/\\/g, '/')
  if (!normalizedValue) return undefined

  const normalizedWorkspace = trimTrailingSlashes(workspaceDir.replace(/\\/g, '/'))
  let relativePath: string | undefined

  if (normalizedValue.startsWith('/workspace/')) {
    relativePath = normalizedValue.slice('/workspace/'.length)
  } else if (normalizedValue === normalizedWorkspace) {
    return undefined
  } else if (normalizedValue.startsWith(`${normalizedWorkspace}/`)) {
    relativePath = normalizedValue.slice(normalizedWorkspace.length + 1)
  } else if (!isAbsolutePath(normalizedValue)) {
    relativePath = normalizedValue
  }

  if (!relativePath) return undefined
  const trimmed = trimTrailingSlashes(relativePath)
  if (!trimmed || trimmed === '.') return undefined

  const segments = trimmed.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return undefined
  return segments.join('/')
}

function resolveSceneSourceKind(inputWorkspacePath: string): SceneSourceKind | undefined {
  if (inputWorkspacePath === SCENE_MANIFEST_FILE_NAME || inputWorkspacePath.endsWith(`/${SCENE_MANIFEST_FILE_NAME}`)) {
    return 'manifest'
  }
  if (inputWorkspacePath.endsWith('.json')) return undefined
  return 'directory'
}

function decodeBase64Utf8(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeSceneRoot(sceneRoot: unknown): string | undefined {
  if (typeof sceneRoot !== 'string') return undefined
  const normalized = sceneRoot.trim().replace(/\\/g, '/')
  if (!normalized) return undefined
  if (normalized === '.') return normalized
  if (isAbsolutePath(normalized)) return undefined

  const segments = normalized.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return undefined
  return segments.join('/')
}

function validateSceneManifest(manifest: unknown): { ok: true; manifest: SceneArtifactManifestV1; sceneRoot: string } | { ok: false; error: string } {
  if (!isPlainObject(manifest)) {
    return { ok: false, error: 'Scene manifest must be a JSON object.' }
  }
  if (manifest.schema !== 'modly.scene-manifest.v1') {
    return { ok: false, error: 'Scene manifest schema must be modly.scene-manifest.v1.' }
  }

  const sceneRoot = normalizeSceneRoot(manifest.sceneRoot)
  if (!sceneRoot) {
    return { ok: false, error: 'Scene manifest sceneRoot must be a safe relative path.' }
  }
  if (!Array.isArray(manifest.assets)) {
    return { ok: false, error: 'Scene manifest assets must be an array.' }
  }

  return {
    ok: true,
    sceneRoot,
    manifest: manifest as SceneArtifactManifestV1,
  }
}

export async function resolveSceneSourceManifest(args: ResolveSceneSourceArgs): Promise<ResolveSceneSourceResult> {
  const inputWorkspacePath = normalizeWorkspaceRelativePath(args.scenePath, args.workspaceDir)
  if (!inputWorkspacePath) {
    return { ok: false, error: 'Load Scene requires a safe workspace-relative scene path.' }
  }

  const sourceKind = resolveSceneSourceKind(inputWorkspacePath)
  if (!sourceKind) {
    return { ok: false, error: `Load Scene accepts ${SCENE_MANIFEST_FILE_NAME} or a scene directory.` }
  }

  const manifestWorkspacePath = sourceKind === 'manifest'
    ? inputWorkspacePath
    : `${inputWorkspacePath}/${SCENE_MANIFEST_FILE_NAME}`
  const normalizedWorkspace = trimTrailingSlashes(args.workspaceDir.replace(/\\/g, '/'))
  const manifestAbsolutePath = `${normalizedWorkspace}/${manifestWorkspacePath}`

  let manifestRaw: string
  try {
    manifestRaw = decodeBase64Utf8(await args.readFileBase64(manifestAbsolutePath))
  } catch (error) {
    return { ok: false, error: `Unable to read scene manifest: ${String(error)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(manifestRaw)
  } catch (error) {
    return { ok: false, error: `Scene manifest is not valid JSON: ${String(error)}` }
  }

  const validation = validateSceneManifest(parsed)
  if (!validation.ok) return validation

  return {
    ok: true,
    sourceKind,
    inputWorkspacePath,
    manifestWorkspacePath,
    manifestAbsolutePath,
    sceneRoot: validation.sceneRoot,
    manifest: validation.manifest,
  }
}
