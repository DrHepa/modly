import type {
  WorldCollisionRectGeometry,
  WorldCollisionSurface,
  WorldCollisionSurfacePreset,
  WorldCollisionSurfaceTransform,
  WorldCollisionTriGeometry,
} from './worldsCollisionSurfaces.ts'
import {
  cloneWorldCollisionSurface,
  cloneWorldCollisionSurfaceTransform,
  createWorldCollisionSurfacePreset,
  normalizeWorldCollisionSurface,
} from './worldsCollisionSurfaces.ts'

const COLLISION_SURFACE_ID_PREFIX = 'collision-surface-'
const DUPLICATE_OFFSET: [number, number, number] = [0.5, 0, 0.5]

export interface AddWorldCollisionSurfaceOptions {
  anchorTransform?: Partial<WorldCollisionSurfaceTransform>
}

export function createWorldCollisionSurfaceId(surfaces: readonly Pick<WorldCollisionSurface, 'id'>[]): string {
  const usedIds = new Set(surfaces.map((surface) => surface.id))
  let highestNumericId = 0

  for (const surface of surfaces) {
    const suffix = surface.id.startsWith(COLLISION_SURFACE_ID_PREFIX) ? Number.parseInt(surface.id.slice(COLLISION_SURFACE_ID_PREFIX.length), 10) : Number.NaN
    if (Number.isInteger(suffix) && suffix > highestNumericId) highestNumericId = suffix
  }

  let candidateIndex = highestNumericId + 1
  let candidate = `${COLLISION_SURFACE_ID_PREFIX}${candidateIndex}`
  while (usedIds.has(candidate)) {
    candidateIndex += 1
    candidate = `${COLLISION_SURFACE_ID_PREFIX}${candidateIndex}`
  }
  return candidate
}

export function addWorldCollisionSurface(
  surfaces: readonly WorldCollisionSurface[],
  preset: WorldCollisionSurfacePreset = 'rectangle',
  options: AddWorldCollisionSurfaceOptions = {},
): { surfaces: WorldCollisionSurface[]; selectedSurfaceId: string } {
  const id = createWorldCollisionSurfaceId(surfaces)
  const anchorTransform = options.anchorTransform
  const surface = createWorldCollisionSurfacePreset(preset, {
    id,
    transform: anchorTransform ? {
      position: anchorTransform.position,
      rotation: anchorTransform.rotation,
      scale: anchorTransform.scale,
    } : undefined,
  })
  if (!surface) {
    throw new Error(`Failed to create collision surface preset ${JSON.stringify(preset)}.`)
  }

  return {
    surfaces: [...surfaces, surface],
    selectedSurfaceId: id,
  }
}

export function updateWorldCollisionSurfaceTransform(
  surfaces: readonly WorldCollisionSurface[],
  surfaceId: string,
  transform: WorldCollisionSurfaceTransform,
): WorldCollisionSurface[] {
  let changed = false
  const nextSurfaces = surfaces.map((surface) => {
    if (surface.id !== surfaceId) return surface
    const normalized = normalizeWorldCollisionSurface({
      ...cloneWorldCollisionSurface(surface),
      transform: cloneWorldCollisionSurfaceTransform(transform),
    })
    if (!normalized) return surface
    changed = true
    return normalized
  })
  return changed ? nextSurfaces : surfaces
}

export function updateWorldCollisionSurfaceRectGeometry(
  surfaces: readonly WorldCollisionSurface[],
  surfaceId: string,
  geometry: WorldCollisionRectGeometry,
): WorldCollisionSurface[] {
  let changed = false
  const nextSurfaces = surfaces.map((surface) => {
    if (surface.id !== surfaceId) return surface
    if (surface.shape !== 'rect') return surface

    const normalized = normalizeWorldCollisionSurface({
      ...cloneWorldCollisionSurface(surface),
      geometry: {
        halfWidth: geometry.halfWidth,
        halfHeight: geometry.halfHeight,
      },
    })
    if (!normalized || normalized.shape !== 'rect') return surface
    changed = true
    return normalized
  })
  return changed ? nextSurfaces : surfaces
}

export function updateWorldCollisionSurfaceTriangleGeometry(
  surfaces: readonly WorldCollisionSurface[],
  surfaceId: string,
  vertices: WorldCollisionTriGeometry['vertices'],
): WorldCollisionSurface[] {
  let changed = false
  const nextSurfaces = surfaces.map((surface) => {
    if (surface.id !== surfaceId) return surface
    if (surface.shape !== 'tri') return surface

    const normalized = normalizeWorldCollisionSurface({
      ...cloneWorldCollisionSurface(surface),
      geometry: {
        vertices: vertices.map((vertex) => [...vertex]) as WorldCollisionTriGeometry['vertices'],
      },
    })
    if (!normalized || normalized.shape !== 'tri') return surface
    changed = true
    return normalized
  })
  return changed ? nextSurfaces : surfaces
}

export function removeWorldCollisionSurface(
  surfaces: readonly WorldCollisionSurface[],
  surfaceId: string | null,
): { surfaces: WorldCollisionSurface[]; selectedSurfaceId: string | null } {
  if (!surfaceId) return { surfaces: [...surfaces], selectedSurfaceId: null }

  const removedIndex = surfaces.findIndex((surface) => surface.id === surfaceId)
  if (removedIndex === -1) return { surfaces: [...surfaces], selectedSurfaceId: null }

  const nextSurfaces = surfaces.filter((surface) => surface.id !== surfaceId)
  const nextSelected = nextSurfaces[removedIndex] ?? nextSurfaces[removedIndex - 1] ?? null
  return {
    surfaces: nextSurfaces,
    selectedSurfaceId: nextSelected?.id ?? null,
  }
}

export function duplicateWorldCollisionSurface(
  surfaces: readonly WorldCollisionSurface[],
  surfaceId: string | null,
): { surfaces: WorldCollisionSurface[]; selectedSurfaceId: string | null } {
  if (!surfaceId) return { surfaces: [...surfaces], selectedSurfaceId: null }

  const source = surfaces.find((surface) => surface.id === surfaceId)
  if (!source) return { surfaces: [...surfaces], selectedSurfaceId: null }

  const duplicateId = createWorldCollisionSurfaceId(surfaces)
  const duplicated = normalizeWorldCollisionSurface({
    ...cloneWorldCollisionSurface(source),
    id: duplicateId,
    ...(source.label ? { label: `${source.label} Copy` } : {}),
    transform: {
      position: [
        source.transform.position[0] + DUPLICATE_OFFSET[0],
        source.transform.position[1] + DUPLICATE_OFFSET[1],
        source.transform.position[2] + DUPLICATE_OFFSET[2],
      ],
      rotation: [...source.transform.rotation],
      scale: [...source.transform.scale],
    },
  })
  if (!duplicated) return { surfaces: [...surfaces], selectedSurfaceId: null }

  return {
    surfaces: [...surfaces, duplicated],
    selectedSurfaceId: duplicateId,
  }
}

export function getWorldCollisionSurfaceDuplicateOffset(): [number, number, number] {
  return [...DUPLICATE_OFFSET]
}
