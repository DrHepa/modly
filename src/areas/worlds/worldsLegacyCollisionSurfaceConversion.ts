import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type { WorldCollisionZone } from './worldsCollisionZones.ts'
import type { WorldCollisionSurface } from './worldsCollisionSurfaces.ts'
import { normalizeWorldCollisionSurface } from './worldsCollisionSurfaces.ts'

export const LEGACY_COLLISION_SURFACE_SLAB_THICKNESS_RATIO_THRESHOLD = 0.2

export type LegacyCollisionSurfaceConversionFailureReason = 'invalid-zone' | 'unsupported-preset' | 'not-slab-like'

export type LegacyCollisionSurfaceConversionResult =
  | {
      success: true
      surface: WorldCollisionSurface
      warnings: string[]
    }
  | {
      success: false
      reason: LegacyCollisionSurfaceConversionFailureReason
      error: string
      warnings: string[]
    }

export function convertLegacyCollisionZoneToSurface(zone: WorldCollisionZone): LegacyCollisionSurfaceConversionResult {
  if (zone.shape !== 'box') {
    return {
      success: false,
      reason: 'invalid-zone',
      error: `Legacy collision zone ${JSON.stringify(zone.id)} must use shape box.`,
      warnings: [],
    }
  }
  if (!isFiniteTransform(zone.transform)) {
    return {
      success: false,
      reason: 'invalid-zone',
      error: `Legacy collision zone ${JSON.stringify(zone.id)} has an invalid transform.`,
      warnings: [],
    }
  }
  if (zone.transform.scale.some((component) => component <= 0)) {
    return {
      success: false,
      reason: 'invalid-zone',
      error: `Legacy collision zone ${JSON.stringify(zone.id)} must have positive scale components.`,
      warnings: [],
    }
  }
  if (zone.preset === 'blocker') {
    return {
      success: false,
      reason: 'unsupported-preset',
      error: `Legacy collision zone ${JSON.stringify(zone.id)} uses blocker, which must be reauthored as explicit planar surfaces.`,
      warnings: [],
    }
  }
  if (zone.preset !== 'wall' && zone.preset !== 'floor-zone') {
    return {
      success: false,
      reason: 'unsupported-preset',
      error: `Legacy collision zone ${JSON.stringify(zone.id)} must use wall or floor-zone for planar conversion.`,
      warnings: [],
    }
  }

  const scale = zone.transform.scale
  const rankedAxes = [
    { index: 0 as const, size: scale[0] },
    { index: 1 as const, size: scale[1] },
    { index: 2 as const, size: scale[2] },
  ].sort((left, right) => left.size - right.size)
  const thinnestAxis = rankedAxes[0]!
  const nextAxis = rankedAxes[1]!
  const slabRatio = thinnestAxis.size / nextAxis.size
  if (slabRatio > LEGACY_COLLISION_SURFACE_SLAB_THICKNESS_RATIO_THRESHOLD) {
    return {
      success: false,
      reason: 'not-slab-like',
      error: `Legacy collision zone ${JSON.stringify(zone.id)} is too thick to convert; thickness ratio ${slabRatio.toFixed(3)} exceeds ${LEGACY_COLLISION_SURFACE_SLAB_THICKNESS_RATIO_THRESHOLD}.`,
      warnings: [],
    }
  }

  const { rotation, width, height } = buildSurfaceOrientation(zone.transform.rotation, scale, thinnestAxis.index)
  const normalized = normalizeWorldCollisionSurface({
    id: zone.id,
    ...(zone.label ? { label: zone.label } : {}),
    shape: 'rect',
    preset: zone.preset === 'wall' ? 'wall' : 'floor',
    sidedness: 'double',
    transform: {
      position: [...zone.transform.position],
      rotation,
      scale: [width, 1, height],
    },
    geometry: {
      halfWidth: 0.5,
      halfHeight: 0.5,
    },
  })
  if (!normalized || normalized.shape !== 'rect') {
    return {
      success: false,
      reason: 'invalid-zone',
      error: `Legacy collision zone ${JSON.stringify(zone.id)} could not be normalized into a planar surface.`,
      warnings: [],
    }
  }

  return {
    success: true,
    surface: normalized,
    warnings: [
      `Converted legacy ${zone.preset} box using slab threshold ${LEGACY_COLLISION_SURFACE_SLAB_THICKNESS_RATIO_THRESHOLD}.`,
    ],
  }
}

function buildSurfaceOrientation(
  boxRotation: [number, number, number],
  scale: [number, number, number],
  thinAxisIndex: 0 | 1 | 2,
): { rotation: [number, number, number]; width: number; height: number } {
  const boxQuaternion = new Quaternion().setFromEuler(new Euler(boxRotation[0], boxRotation[1], boxRotation[2], 'XYZ'))
  const localAxes = [
    new Vector3(1, 0, 0).applyQuaternion(boxQuaternion),
    new Vector3(0, 1, 0).applyQuaternion(boxQuaternion),
    new Vector3(0, 0, 1).applyQuaternion(boxQuaternion),
  ] as const

  const basis = thinAxisIndex === 0
    ? {
        u: localAxes[2].clone(),
        n: localAxes[0].clone(),
        v: localAxes[1].clone(),
        width: scale[2],
        height: scale[1],
      }
    : thinAxisIndex === 1
      ? {
          u: localAxes[0].clone(),
          n: localAxes[1].clone(),
          v: localAxes[2].clone(),
          width: scale[0],
          height: scale[2],
        }
      : {
          u: localAxes[0].clone(),
          n: localAxes[2].clone(),
          v: localAxes[1].clone().multiplyScalar(-1),
          width: scale[0],
          height: scale[1],
        }

  const matrix = new Matrix4().makeBasis(basis.u.normalize(), basis.n.normalize(), basis.v.normalize())
  const rotation = new Euler().setFromRotationMatrix(matrix, 'XYZ')

  return {
    rotation: [rotation.x, rotation.y, rotation.z],
    width: basis.width,
    height: basis.height,
  }
}

function isFiniteTransform(transform: WorldCollisionZone['transform']): boolean {
  return [...transform.position, ...transform.rotation, ...transform.scale].every((component) => Number.isFinite(component))
}
