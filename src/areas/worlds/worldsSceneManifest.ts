import type { SceneArtifactManifestInitialView, SceneArtifactManifestV1 } from '../../shared/types/artifacts.ts'
import type { WorldSceneItem, WorldSceneItemRole } from './worldRenderableResolver.ts'
import type { WorldCollisionSurface } from './worldsCollisionSurfaces.ts'
import {
  buildWorldsCollisionSurfaceManifest,
  parseWorldsCollisionSurfaceManifest,
  type WorldsCollisionSurfaceManifestV1,
} from './worldsCollisionSurfaceManifest.ts'

export const WORLDS_SCENE_MANIFEST_SCHEMA = 'modly.scene-manifest.v1'
export const WORLDS_SCENE_MANIFEST_FILE_NAME = 'scene-manifest.json'

export type WorldsSceneAssetRole = WorldSceneItemRole

export interface WorldsSceneManifestAssetV1 {
  id?: string
  name?: string
  role?: WorldsSceneAssetRole
  workspacePath: string
  kind: WorldSceneItem['kind']
  visible?: boolean
  animation?: WorldSceneItem['animation']
  transform: WorldSceneItem['transform']
}

export interface WorldsSceneManifestV1 extends SceneArtifactManifestV1 {
  schema: typeof WORLDS_SCENE_MANIFEST_SCHEMA
  sceneRoot: '.'
  generator: 'modly.worlds'
  version: 1
  createdAt: string
  assets: WorldsSceneManifestAssetV1[]
  collisionSurfaces?: WorldsCollisionSurfaceManifestV1
}

type ParseWorldsSceneManifestResult =
  | { success: true; manifest: WorldsSceneManifestV1; sceneItems: WorldSceneItem[]; collisionSurfaces: WorldCollisionSurface[] }
  | { success: false; error: string }

const WORLD_SCENE_ITEM_KINDS = new Set<WorldSceneItem['kind']>(['glb', 'gltf', 'ply-mesh', 'ply-points', 'gaussian-ply'])

export function buildWorldsSceneManifest(
  sceneItems: WorldSceneItem[],
  collisionSurfaces: WorldCollisionSurface[],
  options: { now?: Date; initialView?: SceneArtifactManifestInitialView } = {},
): WorldsSceneManifestV1 {
  return {
    schema: WORLDS_SCENE_MANIFEST_SCHEMA,
    sceneRoot: '.',
    generator: 'modly.worlds',
    version: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    ...(options.initialView ? { initialView: cloneSceneInitialView(options.initialView) } : {}),
    assets: sceneItems.map((item) => ({
      id: item.id,
      name: resolveWorkspaceBasename(item.workspacePath),
      role: item.role,
      workspacePath: normalizeWorldsWorkspacePath(item.workspacePath) ?? item.workspacePath,
      kind: item.kind,
      visible: item.visible,
      ...(item.animation ? { animation: cloneAnimationBinding(item.animation) } : {}),
      transform: cloneTransform(item.transform),
    })),
    ...(collisionSurfaces.length > 0 ? { collisionSurfaces: buildWorldsCollisionSurfaceManifest(collisionSurfaces) } : {}),
  }
}

export function createDefaultWorldsSceneManifestPath(now: Date = new Date()): string {
  return `Exports/Worlds/worlds-scene-${formatWorldsSceneTimestamp(now)}/${WORLDS_SCENE_MANIFEST_FILE_NAME}`
}

export function parseWorldsSceneManifestText(text: string, options: { apiUrl?: string } = {}): ParseWorldsSceneManifestResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { success: false, error: `Worlds scene manifest is not valid JSON: ${String(error)}` }
  }

  return parseWorldsSceneManifest(parsed, options)
}

export function parseWorldsSceneManifest(manifest: unknown, options: { apiUrl?: string } = {}): ParseWorldsSceneManifestResult {
  if (!isRecord(manifest)) return { success: false, error: 'Worlds scene manifest must be a JSON object.' }
  if (manifest.schema !== WORLDS_SCENE_MANIFEST_SCHEMA) return { success: false, error: 'Worlds scene manifest schema must be modly.scene-manifest.v1.' }
  if (manifest.sceneRoot !== '.') return { success: false, error: 'Worlds scene manifest sceneRoot must be ".".' }
  if (!Array.isArray(manifest.assets)) return { success: false, error: 'Worlds scene manifest assets must be an array.' }
  if (manifest.collisionZones !== undefined) {
    return { success: false, error: 'Worlds scene manifest uses legacy top-level collisionZones boxes. Convert or re-author them as collisionSurfaces before importing.' }
  }
  const parsedSurfaces = manifest.collisionSurfaces === undefined
    ? { success: true as const, surfaces: [] as WorldCollisionSurface[] }
    : parseWorldsCollisionSurfaceManifest(manifest.collisionSurfaces)
  if (parsedSurfaces.success !== true) return { success: false, error: parsedSurfaces.error }
  const initialView = parseSceneInitialView(manifest.initialView)
  if (initialView.success !== true) return { success: false, error: initialView.error }

  const usedIds = new Set<string>()
  const sceneItems: WorldSceneItem[] = []
  const assets: WorldsSceneManifestAssetV1[] = []

  for (const [index, value] of manifest.assets.entries()) {
    const asset = parseWorldsSceneManifestAsset(value, index, usedIds, options.apiUrl)
    if (!asset.success) return { success: false, error: asset.error }
    sceneItems.push(asset.sceneItem)
    assets.push(asset.manifestAsset)
  }

  const collisionSurfaces = parsedSurfaces.surfaces

  return {
    success: true,
    manifest: {
      ...manifest,
      schema: WORLDS_SCENE_MANIFEST_SCHEMA,
      sceneRoot: '.',
      generator: manifest.generator === 'modly.worlds' ? 'modly.worlds' : 'modly.worlds',
      version: 1,
      createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
      ...(initialView.value ? { initialView: cloneSceneInitialView(initialView.value) } : {}),
      assets,
      ...(collisionSurfaces.length > 0 ? { collisionSurfaces: buildWorldsCollisionSurfaceManifest(collisionSurfaces) } : {}),
    },
    sceneItems,
    collisionSurfaces,
  }
}

export function normalizeWorldsWorkspacePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.includes('\0')) return null
  if (/%2e|%2f|%5c/i.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

export function workspaceRelativePathFromAbsolute(filePath: string, workspaceDir: string): string | null {
  const normalizedFile = filePath.trim().replace(/\\/g, '/')
  const normalizedWorkspace = workspaceDir.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedFile || !normalizedWorkspace) return null
  if (normalizedFile === normalizedWorkspace) return null
  if (!normalizedFile.startsWith(`${normalizedWorkspace}/`)) return null
  return normalizeWorldsWorkspacePath(normalizedFile.slice(normalizedWorkspace.length + 1))
}

export function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function parseWorldsSceneManifestAsset(
  value: unknown,
  index: number,
  usedIds: Set<string>,
  apiUrl?: string,
): { success: true; manifestAsset: WorldsSceneManifestAssetV1; sceneItem: WorldSceneItem } | { success: false; error: string } {
  if (!isRecord(value)) return { success: false, error: `Worlds scene asset ${index + 1} must be an object.` }
  const workspacePath = normalizeWorldsWorkspacePath(value.workspacePath)
  if (!workspacePath) return { success: false, error: `Worlds scene asset ${index + 1} has an unsafe workspacePath.` }
  if (!WORLD_SCENE_ITEM_KINDS.has(value.kind as WorldSceneItem['kind'])) return { success: false, error: `Worlds scene asset ${index + 1} has an unsupported kind.` }
  const transform = parseTransform(value.transform)
  if (!transform) return { success: false, error: `Worlds scene asset ${index + 1} has an invalid transform.` }
  const animation = parseAnimationBinding(value.animation, index)
  if (animation.success !== true) return { success: false, error: animation.error }
  if (value.collision !== undefined) {
    return { success: false, error: `Worlds scene asset ${index + 1} uses legacy asset collision boxes. Convert or re-author them as collisionSurfaces before importing.` }
  }
  const visible = value.visible !== false
  const role = value.role === 'base-scene' ? 'base-scene' : 'asset'
  const requestedId = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `world:${workspacePath}`
  const id = uniqueSceneItemId(requestedId, usedIds)
  const kind = value.kind as WorldSceneItem['kind']

  return {
    success: true,
    manifestAsset: {
      id,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : resolveWorkspaceBasename(workspacePath),
      role,
      workspacePath,
      kind,
      visible,
      ...(animation.binding ? { animation: animation.binding } : {}),
      transform,
    },
    sceneItem: {
      id,
      workspacePath,
      url: apiUrl ? `${apiUrl}/workspace/${workspacePath}` : `/workspace/${workspacePath}`,
      kind,
      role,
      visible,
      ...(animation.binding ? { animation: animation.binding } : {}),
      transform,
    },
  }
}

function parseAnimationBinding(value: unknown, assetIndex: number): { success: true; binding?: WorldSceneItem['animation'] } | { success: false; error: string } {
  if (value === undefined) return { success: true }
  if (!isRecord(value) || value.kind !== 'pose-clip') return { success: false, error: `Worlds scene asset ${assetIndex + 1} has an invalid animation binding.` }

  const sidecarWorkspacePath = normalizeWorldsWorkspacePath(value.sidecarWorkspacePath)
  const legacySidecarWorkspacePath = value.legacySidecarWorkspacePath === undefined ? undefined : normalizeWorldsWorkspacePath(value.legacySidecarWorkspacePath)
  const sourceWorkspacePath = normalizeWorldsWorkspacePath(value.sourceWorkspacePath)
  if (!sidecarWorkspacePath || !sourceWorkspacePath || (value.legacySidecarWorkspacePath !== undefined && !legacySidecarWorkspacePath)) {
    return { success: false, error: `Worlds scene asset ${assetIndex + 1} has an unsafe animation path.` }
  }

  const durationSeconds = typeof value.durationSeconds === 'number' && Number.isFinite(value.durationSeconds) && value.durationSeconds > 0
    ? value.durationSeconds
    : undefined

  return {
    success: true,
    binding: {
      kind: 'pose-clip',
      sidecarWorkspacePath,
      ...(legacySidecarWorkspacePath ? { legacySidecarWorkspacePath } : {}),
      sourceWorkspacePath,
      ...(typeof value.clipId === 'string' && value.clipId.trim() ? { clipId: value.clipId.trim() } : {}),
      ...(typeof value.clipName === 'string' && value.clipName.trim() ? { clipName: value.clipName.trim() } : {}),
      ...(durationSeconds ? { durationSeconds } : {}),
    },
  }
}

function parseTransform(value: unknown): WorldSceneItem['transform'] | null {
  if (!isRecord(value)) return null
  const position = parseVector3(value.position)
  const rotation = parseVector3(value.rotation)
  const scale = parseVector3(value.scale)
  if (!position || !rotation || !scale) return null
  return { position, rotation, scale }
}

function parseSceneInitialView(
  value: unknown,
): { success: true; value?: SceneArtifactManifestInitialView } | { success: false; error: string } {
  if (value === undefined) return { success: true }
  if (!isRecord(value)) {
    return { success: false, error: 'Worlds scene manifest initialView must be an object.' }
  }

  const position = parseVector3(value.position)
  const target = parseVector3(value.target)
  if (!position || !target) {
    return { success: false, error: 'Worlds scene manifest initialView position and target must be finite numeric triples.' }
  }
  if (position.every((component, index) => component === target[index])) {
    return { success: false, error: 'Worlds scene manifest initialView position and target must differ.' }
  }

  const up = value.up === undefined ? undefined : parseVector3(value.up)
  if (value.up !== undefined && (!up || up.every((component) => component === 0))) {
    return { success: false, error: 'Worlds scene manifest initialView up must be a non-zero finite numeric triple.' }
  }

  return {
    success: true,
    value: {
      position,
      target,
      ...(up ? { up } : {}),
    },
  }
}

function parseVector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  if (!value.every((component) => typeof component === 'number' && Number.isFinite(component))) return null
  return [value[0], value[1], value[2]]
}

function cloneTransform(transform: WorldSceneItem['transform']): WorldSceneItem['transform'] {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
}

function cloneAnimationBinding(animation: NonNullable<WorldSceneItem['animation']>): NonNullable<WorldSceneItem['animation']> {
  return { ...animation }
}

function cloneSceneInitialView(initialView: SceneArtifactManifestInitialView): SceneArtifactManifestInitialView {
  return {
    position: [...initialView.position],
    target: [...initialView.target],
    ...(initialView.up ? { up: [...initialView.up] } : {}),
  }
}

function uniqueSceneItemId(baseId: string, usedIds: Set<string>): string {
  let candidate = baseId
  let duplicateIndex = 2
  while (usedIds.has(candidate)) {
    candidate = `${baseId}#${duplicateIndex}`
    duplicateIndex += 1
  }
  usedIds.add(candidate)
  return candidate
}

function resolveWorkspaceBasename(workspacePath: string): string {
  return workspacePath.replace(/\\/g, '/').split('/').at(-1) || workspacePath
}

function formatWorldsSceneTimestamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}-${hours}${minutes}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
