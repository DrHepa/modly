import type { SceneArtifactManifestV1 } from '../../shared/types/artifacts.ts'
import type { WorldSceneItem, WorldSceneItemRole } from './worldRenderableResolver.ts'
import {
  cloneWorldCollisionZone,
  cloneWorldCollisionZoneTransform,
  type WorldCollisionZone,
  type WorldCollisionZonePreset,
} from './worldsCollisionZones.ts'

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
  collision?: WorldSceneItem['collision']
  transform: WorldSceneItem['transform']
}

export interface WorldsSceneManifestCollisionZoneV1 {
  id?: string
  label?: string
  shape: 'box'
  preset?: WorldCollisionZonePreset
  transform: WorldCollisionZone['transform']
}

export interface WorldsSceneManifestV1 extends SceneArtifactManifestV1 {
  schema: typeof WORLDS_SCENE_MANIFEST_SCHEMA
  sceneRoot: '.'
  generator: 'modly.worlds'
  version: 1
  createdAt: string
  assets: WorldsSceneManifestAssetV1[]
  collisionZones: WorldsSceneManifestCollisionZoneV1[]
}

type ParseWorldsSceneManifestResult =
  | { success: true; manifest: WorldsSceneManifestV1; sceneItems: WorldSceneItem[]; collisionZones: WorldCollisionZone[] }
  | { success: false; error: string }

const WORLD_SCENE_ITEM_KINDS = new Set<WorldSceneItem['kind']>(['glb', 'gltf', 'ply-mesh', 'ply-points'])

export function buildWorldsSceneManifest(sceneItems: WorldSceneItem[], collisionZones: WorldCollisionZone[], options: { now?: Date } = {}): WorldsSceneManifestV1 {
  return {
    schema: WORLDS_SCENE_MANIFEST_SCHEMA,
    sceneRoot: '.',
    generator: 'modly.worlds',
    version: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
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
    collisionZones: collisionZones.map((zone) => ({
      id: zone.id,
      ...(zone.label ? { label: zone.label } : {}),
      shape: 'box',
      ...(zone.preset ? { preset: zone.preset } : {}),
      transform: cloneWorldCollisionZoneTransform(zone.transform),
    })),
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
  if (manifest.collisionZones !== undefined && !Array.isArray(manifest.collisionZones)) {
    return { success: false, error: 'Worlds scene manifest collisionZones must be an array.' }
  }

  const usedIds = new Set<string>()
  const sceneItems: WorldSceneItem[] = []
  const assets: WorldsSceneManifestAssetV1[] = []
  const legacyCollisionZones: WorldCollisionZone[] = []

  for (const [index, value] of manifest.assets.entries()) {
    const asset = parseWorldsSceneManifestAsset(value, index, usedIds, options.apiUrl)
    if (!asset.success) return { success: false, error: asset.error }
    sceneItems.push(asset.sceneItem)
    assets.push(asset.manifestAsset)
    legacyCollisionZones.push(...asset.legacyCollisionZones)
  }

  const collisionZones = parseWorldsSceneManifestCollisionZones(manifest.collisionZones, legacyCollisionZones)
  if (collisionZones.success !== true) return { success: false, error: collisionZones.error }

  return {
    success: true,
    manifest: {
      ...manifest,
      schema: WORLDS_SCENE_MANIFEST_SCHEMA,
      sceneRoot: '.',
      generator: manifest.generator === 'modly.worlds' ? 'modly.worlds' : 'modly.worlds',
      version: 1,
      createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
      assets,
      collisionZones: collisionZones.zones.map(cloneWorldCollisionZone),
    },
    sceneItems,
    collisionZones: collisionZones.zones,
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
): { success: true; manifestAsset: WorldsSceneManifestAssetV1; sceneItem: WorldSceneItem; legacyCollisionZones: WorldCollisionZone[] } | { success: false; error: string } {
  if (!isRecord(value)) return { success: false, error: `Worlds scene asset ${index + 1} must be an object.` }
  const workspacePath = normalizeWorldsWorkspacePath(value.workspacePath)
  if (!workspacePath) return { success: false, error: `Worlds scene asset ${index + 1} has an unsafe workspacePath.` }
  if (!WORLD_SCENE_ITEM_KINDS.has(value.kind as WorldSceneItem['kind'])) return { success: false, error: `Worlds scene asset ${index + 1} has an unsupported kind.` }
  const transform = parseTransform(value.transform)
  if (!transform) return { success: false, error: `Worlds scene asset ${index + 1} has an invalid transform.` }
  const animation = parseAnimationBinding(value.animation, index)
  if (animation.success !== true) return { success: false, error: animation.error }
  const collision = parseCollision(value.collision, index)
  if (collision.success !== true) return { success: false, error: collision.error }
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
    legacyCollisionZones: collision.value ? migrateLegacyCollisionZones(id, transform, collision.value) : [],
  }
}

function parseWorldsSceneManifestCollisionZones(
  value: unknown,
  legacyCollisionZones: WorldCollisionZone[],
): { success: true; zones: WorldCollisionZone[] } | { success: false; error: string } {
  if (value === undefined) return { success: true, zones: legacyCollisionZones.map(cloneWorldCollisionZone) }

  const zoneIds = new Set<string>()
  const zones: WorldCollisionZone[] = []
  for (const [index, zoneValue] of value.entries()) {
    if (!isRecord(zoneValue) || zoneValue.shape !== 'box') {
      return { success: false, error: `Worlds scene collision zone ${index + 1} is invalid.` }
    }

    const zoneId = typeof zoneValue.id === 'string' && zoneValue.id.trim() ? zoneValue.id.trim() : `collision-box-${index + 1}`
    if (zoneIds.has(zoneId)) {
      return { success: false, error: 'Worlds scene collision zones must use unique ids.' }
    }

    const transform = parseTransform(zoneValue.transform)
    if (!transform || transform.scale.some((component) => component <= 0)) {
      return { success: false, error: `Worlds scene collision zone ${index + 1} has an invalid transform.` }
    }

    zoneIds.add(zoneId)
    zones.push({
      id: zoneId,
      ...(typeof zoneValue.label === 'string' && zoneValue.label.trim() ? { label: zoneValue.label.trim() } : {}),
      shape: 'box',
      ...(isCollisionPreset(zoneValue.preset) ? { preset: zoneValue.preset } : {}),
      transform,
    })
  }

  return { success: true, zones }
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

function parseCollision(value: unknown, assetIndex: number): { success: true; value?: WorldSceneItem['collision'] } | { success: false; error: string } {
  if (value === undefined) return { success: true }
  if (!isRecord(value) || !Array.isArray(value.zones)) {
    return { success: false, error: `Worlds scene asset ${assetIndex + 1} has an invalid collision definition.` }
  }

  const zoneIds = new Set<string>()
  const zones = [] as NonNullable<WorldSceneItem['collision']>['zones']
  for (const [zoneIndex, zoneValue] of value.zones.entries()) {
    if (!isRecord(zoneValue) || zoneValue.shape !== 'box') {
      return { success: false, error: `Worlds scene asset ${assetIndex + 1} has an invalid collision zone.` }
    }

    const zoneId = typeof zoneValue.id === 'string' && zoneValue.id.trim()
      ? zoneValue.id.trim()
      : `collision-zone-${zoneIndex + 1}`
    if (zoneIds.has(zoneId)) {
      return { success: false, error: `Worlds scene asset ${assetIndex + 1} has duplicate collision zone ids.` }
    }

    const offset = parseVector3(zoneValue.offset)
    const size = parsePositiveVector3(zoneValue.size)
    if (!offset || !size) {
      return { success: false, error: `Worlds scene asset ${assetIndex + 1} has an invalid collision zone.` }
    }

    zoneIds.add(zoneId)
    zones.push({
      id: zoneId,
      ...(typeof zoneValue.label === 'string' && zoneValue.label.trim() ? { label: zoneValue.label.trim() } : {}),
      shape: 'box',
      offset,
      size,
    })
  }

  return {
    success: true,
    value: {
      enabled: value.enabled !== false,
      zones,
    },
  }
}

function parseVector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  if (!value.every((component) => typeof component === 'number' && Number.isFinite(component))) return null
  return [value[0], value[1], value[2]]
}

function parsePositiveVector3(value: unknown): [number, number, number] | null {
  const parsed = parseVector3(value)
  if (!parsed) return null
  if (parsed.some((component) => component <= 0)) return null
  return parsed
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

function migrateLegacyCollisionZones(
  itemId: string,
  itemTransform: WorldSceneItem['transform'],
  collision: NonNullable<WorldSceneItem['collision']>,
): WorldCollisionZone[] {
  if (collision.enabled !== true) return []
  return collision.zones.map((zone, index) => ({
    id: `${itemId}:legacy:${zone.id || index + 1}`,
    ...(zone.label ? { label: zone.label } : {}),
    shape: 'box',
    transform: {
      position: [
        itemTransform.position[0] + zone.offset[0],
        itemTransform.position[1] + zone.offset[1],
        itemTransform.position[2] + zone.offset[2],
      ],
      rotation: [...itemTransform.rotation],
      scale: [...zone.size],
    },
  }))
}

function isCollisionPreset(value: unknown): value is WorldCollisionZonePreset {
  return value === 'wall' || value === 'blocker' || value === 'floor-zone'
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
