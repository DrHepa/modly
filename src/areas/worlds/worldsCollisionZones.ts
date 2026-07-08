export type WorldCollisionZonePreset = 'wall' | 'blocker' | 'floor-zone'

export interface WorldCollisionZone {
  id: string
  label?: string
  shape: 'box'
  preset?: WorldCollisionZonePreset
  transform: {
    position: [number, number, number]
    rotation: [number, number, number]
    scale: [number, number, number]
  }
}

export function cloneWorldCollisionZone(zone: WorldCollisionZone): WorldCollisionZone {
  return {
    id: zone.id,
    ...(zone.label ? { label: zone.label } : {}),
    shape: 'box',
    ...(zone.preset ? { preset: zone.preset } : {}),
    transform: cloneWorldCollisionZoneTransform(zone.transform),
  }
}

export function cloneWorldCollisionZoneTransform(transform: WorldCollisionZone['transform']): WorldCollisionZone['transform'] {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
}

export function getWorldCollisionZonePresetDefinition(preset: WorldCollisionZonePreset): {
  label: string
  transform: WorldCollisionZone['transform']
} {
  switch (preset) {
    case 'wall':
      return {
        label: 'Wall',
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [2.4, 2.4, 0.2],
        },
      }
    case 'floor-zone':
      return {
        label: 'Floor zone',
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1.8, 0.15, 1.8],
        },
      }
    case 'blocker':
    default:
      return {
        label: 'Blocker',
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1.2, 1.2, 1.2],
        },
      }
  }
}
