import type {
  WorldCollisionRectGeometry,
  WorldCollisionSurface,
  WorldCollisionSurfacePreset,
  WorldCollisionSurfaceSidedness,
  WorldCollisionSurfaceTransform,
  WorldCollisionTriGeometry,
} from './worldsCollisionSurfaces.ts'
import { cloneWorldCollisionSurface, normalizeWorldCollisionSurface } from './worldsCollisionSurfaces.ts'

export const WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA = 'modly.collision-surfaces.v1'

export interface WorldsCollisionSurfaceManifestV1 {
  schema: typeof WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA
  surfaces: WorldCollisionSurface[]
}

export type ParseWorldsCollisionSurfaceManifestResult =
  | { success: true; manifest: WorldsCollisionSurfaceManifestV1; surfaces: WorldCollisionSurface[] }
  | { success: false; error: string }

export function createEmptyWorldsCollisionSurfaceManifest(): WorldsCollisionSurfaceManifestV1 {
  return {
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: [],
  }
}

export function buildWorldsCollisionSurfaceManifest(surfaces: readonly WorldCollisionSurface[]): WorldsCollisionSurfaceManifestV1 {
  const usedIds = new Set<string>()
  const normalizedSurfaces = surfaces.map((surface, index) => {
    const normalized = normalizeWorldCollisionSurface(cloneWorldCollisionSurface(surface))
    if (!normalized) {
      throw new Error(`World collision surface ${describeSurface(index, surface.id)} is invalid.`)
    }
    if (usedIds.has(normalized.id)) {
      throw new Error(`World collision surfaces must use unique ids; duplicate id ${JSON.stringify(normalized.id)} was found.`)
    }
    usedIds.add(normalized.id)
    return cloneWorldCollisionSurface(normalized)
  })

  return {
    schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
    surfaces: normalizedSurfaces,
  }
}

export function serializeWorldsCollisionSurfaceManifest(surfaces: readonly WorldCollisionSurface[], space = 2): string {
  return JSON.stringify(buildWorldsCollisionSurfaceManifest(surfaces), null, space)
}

export function parseWorldsCollisionSurfaceManifestText(text: string): ParseWorldsCollisionSurfaceManifestResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { success: false, error: `World collision surface manifest is not valid JSON: ${String(error)}` }
  }

  return parseWorldsCollisionSurfaceManifest(parsed)
}

export function parseWorldsCollisionSurfaceManifest(manifest: unknown): ParseWorldsCollisionSurfaceManifestResult {
  if (!isRecord(manifest)) {
    return { success: false, error: 'World collision surface manifest must be a JSON object.' }
  }
  if (manifest.schema !== WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA) {
    return { success: false, error: 'World collision surface manifest schema must be modly.collision-surfaces.v1.' }
  }
  if (!Array.isArray(manifest.surfaces)) {
    return { success: false, error: 'World collision surface manifest surfaces must be an array.' }
  }

  const usedIds = new Set<string>()
  const surfaces: WorldCollisionSurface[] = []
  for (const [index, value] of manifest.surfaces.entries()) {
    const parsedSurface = parseManifestSurface(value, index)
    if (!parsedSurface.success) return parsedSurface
    if (usedIds.has(parsedSurface.surface.id)) {
      return {
        success: false,
        error: `World collision surfaces must use unique ids; duplicate id ${JSON.stringify(parsedSurface.surface.id)} was found.`,
      }
    }
    usedIds.add(parsedSurface.surface.id)
    surfaces.push(cloneWorldCollisionSurface(parsedSurface.surface))
  }

  return {
    success: true,
    manifest: {
      schema: WORLDS_COLLISION_SURFACE_MANIFEST_SCHEMA,
      surfaces: surfaces.map(cloneWorldCollisionSurface),
    },
    surfaces: surfaces.map(cloneWorldCollisionSurface),
  }
}

function parseManifestSurface(value: unknown, index: number): { success: true; surface: WorldCollisionSurface } | { success: false; error: string } {
  if (!isRecord(value)) {
    return { success: false, error: `World collision surface ${describeSurface(index)} must be an object.` }
  }

  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const identifier = describeSurface(index, id || undefined)
  if (!id) {
    return { success: false, error: `World collision surface ${identifier} must define a non-empty string id.` }
  }

  const transform = parseTransform(value.transform)
  if (!transform) {
    return { success: false, error: `World collision surface ${identifier} has an invalid transform.` }
  }

  const sidedness = parseSidedness(value.sidedness)
  if (value.sidedness !== undefined && !sidedness) {
    return { success: false, error: `World collision surface ${identifier} has an invalid sidedness.` }
  }

  const preset = parsePreset(value.preset)
  if (value.preset !== undefined && !preset) {
    return { success: false, error: `World collision surface ${identifier} has an invalid preset.` }
  }

  const label = typeof value.label === 'string' && value.label.trim().length > 0 ? value.label.trim() : undefined
  const shape = value.shape
  if (shape === 'rect') {
    const geometry = parseRectGeometry(value.geometry)
    if (!geometry) {
      return { success: false, error: `World collision surface ${identifier} has invalid rect geometry.` }
    }
    if (preset && !isPresetCompatibleWithShape(preset, 'rect')) {
      return { success: false, error: `World collision surface ${identifier} uses preset ${JSON.stringify(preset)} which is incompatible with shape rect.` }
    }

    const normalized = normalizeWorldCollisionSurface({
      id,
      ...(label ? { label } : {}),
      shape: 'rect',
      ...(preset ? { preset } : {}),
      ...(sidedness ? { sidedness } : {}),
      transform,
      geometry,
    })
    if (!normalized) {
      return { success: false, error: `World collision surface ${identifier} could not be normalized.` }
    }
    return { success: true, surface: normalized }
  }

  if (shape === 'tri') {
    const geometry = parseTriGeometry(value.geometry)
    if (!geometry) {
      return { success: false, error: `World collision surface ${identifier} has invalid triangle geometry.` }
    }
    if (preset && !isPresetCompatibleWithShape(preset, 'tri')) {
      return { success: false, error: `World collision surface ${identifier} uses preset ${JSON.stringify(preset)} which is incompatible with shape tri.` }
    }

    const normalized = normalizeWorldCollisionSurface({
      id,
      ...(label ? { label } : {}),
      shape: 'tri',
      ...(preset ? { preset } : {}),
      ...(sidedness ? { sidedness } : {}),
      transform,
      geometry,
    })
    if (!normalized) {
      return { success: false, error: `World collision surface ${identifier} has a degenerate or non-finite triangle.` }
    }
    return { success: true, surface: normalized }
  }

  return { success: false, error: `World collision surface ${identifier} must use shape rect or tri.` }
}

function parseTransform(value: unknown): WorldCollisionSurfaceTransform | null {
  if (!isRecord(value)) return null
  const position = parseTuple3(value.position)
  const rotation = parseTuple3(value.rotation)
  const scale = parseTuple3(value.scale)
  if (!position || !rotation || !scale) return null
  if (scale[0] <= 0 || scale[1] <= 0 || scale[2] <= 0) return null
  return {
    position,
    rotation,
    scale: [scale[0], 1, scale[2]],
  }
}

function parseRectGeometry(value: unknown): WorldCollisionRectGeometry | null {
  if (!isRecord(value)) return null
  if (!Number.isFinite(value.halfWidth) || !Number.isFinite(value.halfHeight)) return null
  if (value.halfWidth <= 0 || value.halfHeight <= 0) return null
  return {
    halfWidth: value.halfWidth,
    halfHeight: value.halfHeight,
  }
}

function parseTriGeometry(value: unknown): WorldCollisionTriGeometry | null {
  if (!isRecord(value) || !Array.isArray(value.vertices) || value.vertices.length !== 3) return null
  const vertices = value.vertices.map(parseTuple2)
  if (vertices.some((vertex) => !vertex)) return null
  return {
    vertices: vertices as WorldCollisionTriGeometry['vertices'],
  }
}

function parseTuple2(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  if (!value.every((component) => typeof component === 'number' && Number.isFinite(component))) return null
  return [value[0], value[1]]
}

function parseTuple3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  if (!value.every((component) => typeof component === 'number' && Number.isFinite(component))) return null
  return [value[0], value[1], value[2]]
}

function parseSidedness(value: unknown): WorldCollisionSurfaceSidedness | null {
  return value === 'double' || value === 'front' ? value : null
}

function parsePreset(value: unknown): WorldCollisionSurfacePreset | null {
  return value === 'rectangle'
    || value === 'square'
    || value === 'triangle'
    || value === 'wall'
    || value === 'floor'
    || value === 'ramp'
    ? value
    : null
}

function isPresetCompatibleWithShape(preset: WorldCollisionSurfacePreset, shape: WorldCollisionSurface['shape']): boolean {
  if (shape === 'rect') {
    return preset === 'rectangle' || preset === 'square' || preset === 'wall' || preset === 'floor' || preset === 'ramp'
  }
  return preset === 'triangle'
}

function describeSurface(index: number, id?: string): string {
  return id && id.trim().length > 0 ? `${index + 1} (${JSON.stringify(id.trim())})` : `${index + 1}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
