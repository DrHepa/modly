export type WorldCollisionSurfaceShape = 'rect' | 'tri'
export type WorldCollisionSurfacePreset = 'rectangle' | 'square' | 'triangle' | 'wall' | 'floor' | 'ramp'
export type WorldCollisionSurfaceSidedness = 'double' | 'front'
export type WorldCollisionSurfaceTuple2 = [number, number]
export type WorldCollisionSurfaceTuple3 = [number, number, number]

export interface WorldCollisionSurfaceTransform {
  position: WorldCollisionSurfaceTuple3
  rotation: WorldCollisionSurfaceTuple3
  scale: WorldCollisionSurfaceTuple3
}

export interface WorldCollisionRectGeometry {
  halfWidth: number
  halfHeight: number
}

export interface WorldCollisionTriGeometry {
  vertices: [WorldCollisionSurfaceTuple2, WorldCollisionSurfaceTuple2, WorldCollisionSurfaceTuple2]
}

interface WorldCollisionSurfaceBase {
  id: string
  label?: string
  preset?: WorldCollisionSurfacePreset
  sidedness?: WorldCollisionSurfaceSidedness
  transform: WorldCollisionSurfaceTransform
}

export interface WorldCollisionRectSurface extends WorldCollisionSurfaceBase {
  shape: 'rect'
  geometry: WorldCollisionRectGeometry
}

export interface WorldCollisionTriSurface extends WorldCollisionSurfaceBase {
  shape: 'tri'
  geometry: WorldCollisionTriGeometry
}

export type WorldCollisionSurface = WorldCollisionRectSurface | WorldCollisionTriSurface

const CANONICAL_TRIANGLE_VERTICES: WorldCollisionTriGeometry['vertices'] = [
  [-0.5, -0.5],
  [-0.5, 0.5],
  [0.5, -0.5],
]

export function cloneWorldCollisionSurface(surface: WorldCollisionSurface): WorldCollisionSurface {
  return surface.shape === 'rect'
    ? {
        id: surface.id,
        ...(surface.label ? { label: surface.label } : {}),
        shape: 'rect',
        ...(surface.preset ? { preset: surface.preset } : {}),
        ...(surface.sidedness ? { sidedness: surface.sidedness } : {}),
        transform: cloneWorldCollisionSurfaceTransform(surface.transform),
        geometry: {
          halfWidth: surface.geometry.halfWidth,
          halfHeight: surface.geometry.halfHeight,
        },
      }
    : {
        id: surface.id,
        ...(surface.label ? { label: surface.label } : {}),
        shape: 'tri',
        ...(surface.preset ? { preset: surface.preset } : {}),
        ...(surface.sidedness ? { sidedness: surface.sidedness } : {}),
        transform: cloneWorldCollisionSurfaceTransform(surface.transform),
        geometry: {
          vertices: cloneTriangleVertices(surface.geometry.vertices),
        },
      }
}

export function cloneWorldCollisionSurfaceTransform(transform: WorldCollisionSurfaceTransform): WorldCollisionSurfaceTransform {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
}

export function normalizeWorldCollisionSurface(surface: WorldCollisionSurface): WorldCollisionSurface | null {
  const id = typeof surface.id === 'string' ? surface.id.trim() : ''
  if (id.length === 0) return null
  if (!isFiniteTuple3(surface.transform.position)) return null
  if (!isFiniteTuple3(surface.transform.rotation)) return null
  if (!isFiniteTuple3(surface.transform.scale)) return null
  if (surface.transform.scale[0] <= 0 || surface.transform.scale[1] <= 0 || surface.transform.scale[2] <= 0) return null

  const sidedness = surface.sidedness ?? 'double'
  if (sidedness !== 'double' && sidedness !== 'front') return null

  const preset = surface.preset
  if (preset && !isSurfacePreset(preset)) return null

  const label = typeof surface.label === 'string' && surface.label.trim().length > 0 ? surface.label.trim() : undefined
  const transform: WorldCollisionSurfaceTransform = {
    position: [...surface.transform.position],
    rotation: [...surface.transform.rotation],
    scale: [surface.transform.scale[0], 1, surface.transform.scale[2]],
  }

  if (surface.shape === 'rect') {
    const { halfWidth, halfHeight } = surface.geometry
    if (!Number.isFinite(halfWidth) || !Number.isFinite(halfHeight) || halfWidth <= 0 || halfHeight <= 0) return null

    return {
      id,
      ...(label ? { label } : {}),
      shape: 'rect',
      ...(preset ? { preset } : {}),
      sidedness,
      transform,
      geometry: { halfWidth, halfHeight },
    }
  }

  if (surface.shape !== 'tri') return null
  const vertices = cloneTriangleVertices(surface.geometry.vertices)
  if (!vertices.every((vertex) => isFiniteTuple2(vertex))) return null
  const areaTwice = signedTriangleAreaTwice(vertices)
  if (Math.abs(areaTwice) <= 1e-8) return null
  if (areaTwice < 0) {
    const swap = vertices[1]
    vertices[1] = vertices[2]
    vertices[2] = swap
  }

  return {
    id,
    ...(label ? { label } : {}),
    shape: 'tri',
    ...(preset ? { preset } : {}),
    sidedness,
    transform,
    geometry: { vertices },
  }
}

export function isValidWorldCollisionSurface(surface: WorldCollisionSurface): boolean {
  return normalizeWorldCollisionSurface(surface) !== null
}

export function createWorldCollisionSurfacePreset(
  preset: WorldCollisionSurfacePreset,
  options: {
    id: string
    label?: string
    sidedness?: WorldCollisionSurfaceSidedness
    transform?: Partial<WorldCollisionSurfaceTransform>
    rectGeometry?: Partial<WorldCollisionRectGeometry>
    triGeometry?: Partial<WorldCollisionTriGeometry>
  },
): WorldCollisionSurface | null {
  const definition = getWorldCollisionSurfacePresetDefinition(preset)
  const surface: WorldCollisionSurface = definition.shape === 'rect'
    ? {
        id: options.id,
        label: options.label ?? definition.label,
        preset,
        sidedness: options.sidedness ?? definition.sidedness,
        shape: 'rect',
        transform: mergeTransform(definition.transform, options.transform),
        geometry: {
          halfWidth: options.rectGeometry?.halfWidth ?? definition.geometry.halfWidth,
          halfHeight: options.rectGeometry?.halfHeight ?? definition.geometry.halfHeight,
        },
      }
    : {
        id: options.id,
        label: options.label ?? definition.label,
        preset,
        sidedness: options.sidedness ?? definition.sidedness,
        shape: 'tri',
        transform: mergeTransform(definition.transform, options.transform),
        geometry: {
          vertices: cloneTriangleVertices(options.triGeometry?.vertices ?? definition.geometry.vertices),
        },
      }

  return normalizeWorldCollisionSurface(surface)
}

export function getWorldCollisionSurfacePresetDefinition(
  preset: WorldCollisionSurfacePreset,
): {
  label: string
  sidedness: WorldCollisionSurfaceSidedness
  transform: WorldCollisionSurfaceTransform
  shape: WorldCollisionSurfaceShape
  geometry: WorldCollisionRectGeometry | WorldCollisionTriGeometry
} {
  switch (preset) {
    case 'rectangle':
      return {
        label: 'Rectangle',
        sidedness: 'double',
        shape: 'rect',
        transform: identityTransform(),
        geometry: { halfWidth: 1, halfHeight: 0.5 },
      }
    case 'square':
      return {
        label: 'Square',
        sidedness: 'double',
        shape: 'rect',
        transform: identityTransform(),
        geometry: { halfWidth: 0.5, halfHeight: 0.5 },
      }
    case 'triangle':
      return {
        label: 'Triangle',
        sidedness: 'double',
        shape: 'tri',
        transform: identityTransform(),
        geometry: { vertices: cloneTriangleVertices(CANONICAL_TRIANGLE_VERTICES) },
      }
    case 'wall':
      return {
        label: 'Wall',
        sidedness: 'double',
        shape: 'rect',
        transform: {
          position: [0, 0, 0],
          rotation: [-Math.PI / 2, 0, 0],
          scale: [1, 1, 1],
        },
        geometry: { halfWidth: 1.2, halfHeight: 1.2 },
      }
    case 'floor':
      return {
        label: 'Floor',
        sidedness: 'double',
        shape: 'rect',
        transform: identityTransform(),
        geometry: { halfWidth: 0.9, halfHeight: 0.9 },
      }
    case 'ramp':
      return {
        label: 'Ramp',
        sidedness: 'double',
        shape: 'rect',
        transform: {
          position: [0, 0, 0],
          rotation: [-Math.PI / 6, 0, 0],
          scale: [1, 1, 1],
        },
        geometry: { halfWidth: 1.2, halfHeight: 1.2 },
      }
  }
}

function identityTransform(): WorldCollisionSurfaceTransform {
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  }
}

function mergeTransform(
  base: WorldCollisionSurfaceTransform,
  override: Partial<WorldCollisionSurfaceTransform> | undefined,
): WorldCollisionSurfaceTransform {
  return {
    position: override?.position ? [...override.position] : [...base.position],
    rotation: override?.rotation ? [...override.rotation] : [...base.rotation],
    scale: override?.scale ? [...override.scale] : [...base.scale],
  }
}

function isSurfacePreset(value: string): value is WorldCollisionSurfacePreset {
  return value === 'rectangle' || value === 'square' || value === 'triangle' || value === 'wall' || value === 'floor' || value === 'ramp'
}

function cloneTriangleVertices(vertices: WorldCollisionTriGeometry['vertices']): WorldCollisionTriGeometry['vertices'] {
  return vertices.map((vertex) => [...vertex]) as WorldCollisionTriGeometry['vertices']
}

function signedTriangleAreaTwice(vertices: WorldCollisionTriGeometry['vertices']): number {
  const [a, b, c] = vertices
  return ((b[1] - a[1]) * (c[0] - a[0])) - ((b[0] - a[0]) * (c[1] - a[1]))
}

function isFiniteTuple2(value: WorldCollisionSurfaceTuple2): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1])
}

function isFiniteTuple3(value: WorldCollisionSurfaceTuple3): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2])
}
