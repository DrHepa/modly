import { Euler, Quaternion, Vector3 } from 'three'
import type { WorldSceneItem } from './worldRenderableResolver.ts'
import {
  cloneWorldCollisionZone,
  cloneWorldCollisionZoneTransform,
  getWorldCollisionZonePresetDefinition,
  type WorldCollisionZone,
  type WorldCollisionZonePreset,
} from './worldsCollisionZones.ts'

export type WorldSceneTransformMode = 'translate' | 'rotate' | 'scale'

export interface WorldSceneItemTransformUpdate {
  itemId: string
  transform: WorldSceneItem['transform']
}

export interface WorldSceneTransformSnapshot {
  itemId: string
  transform: WorldSceneItem['transform']
}

export interface AppendWorldSceneItemOptions {
  sceneItemAnchors?: Record<string, [number, number, number]>
  selectedSceneItemId?: string | null
}

export interface AddWorldCollisionZoneOptions {
  anchorPosition?: [number, number, number]
}

export function appendWorldSceneItem(
  sceneItems: WorldSceneItem[],
  item: WorldSceneItem,
  options: AppendWorldSceneItemOptions = {},
): { sceneItems: WorldSceneItem[]; selectedSceneItemId: string } {
  const { sceneItemAnchors = {}, selectedSceneItemId = null } = options
  const existingIds = new Set(sceneItems.map((sceneItem) => sceneItem.id))
  const placementOffset = calculateWorldSceneItemPlacementOffset(resolvePlacementIndex(sceneItems, item))
  const placementAnchor = resolvePlacementAnchor(sceneItems, sceneItemAnchors, selectedSceneItemId)
  const placedItem = {
    ...item,
    role: item.role ?? 'asset',
    transform: {
      position: [
        item.transform.position[0] + placementAnchor[0] + placementOffset[0],
        item.transform.position[1] + placementAnchor[1] + placementOffset[1],
        item.transform.position[2] + placementAnchor[2] + placementOffset[2],
      ] as [number, number, number],
      rotation: [...item.transform.rotation] as [number, number, number],
      scale: [...item.transform.scale] as [number, number, number],
    },
  }
  const uniqueItem = existingIds.has(placedItem.id) ? { ...placedItem, id: createDuplicateWorldSceneItemId(placedItem.id, existingIds) } : placedItem
  return {
    sceneItems: [...sceneItems, uniqueItem],
    selectedSceneItemId: uniqueItem.id,
  }
}

export function calculateBaseSceneAnchor(sceneItems: WorldSceneItem[], sceneItemAnchors: Record<string, [number, number, number]> = {}): [number, number, number] {
  const baseItems = sceneItems.filter((item) => item.visible && item.role === 'base-scene')
  if (baseItems.length === 0) return [0, 0, 0]

  const totals = baseItems.reduce<[number, number, number]>((accumulator, item) => [
    accumulator[0] + (sceneItemAnchors[item.id]?.[0] ?? item.transform.position[0]),
    accumulator[1] + (sceneItemAnchors[item.id]?.[1] ?? item.transform.position[1]),
    accumulator[2] + (sceneItemAnchors[item.id]?.[2] ?? item.transform.position[2]),
  ], [0, 0, 0])

  return [totals[0] / baseItems.length, totals[1] / baseItems.length, totals[2] / baseItems.length]
}

export function calculateWorldSceneItemPlacementOffset(itemIndex: number): [number, number, number] {
  if (itemIndex <= 0) return [0, 0, 0]

  const spacing = 1.75
  const directions: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ]
  const [xDirection, zDirection] = directions[(itemIndex - 1) % directions.length]

  return [xDirection * spacing, 0, zDirection * spacing]
}

export function removeWorldSceneItem(sceneItems: WorldSceneItem[], selectedItemId: string | null): { sceneItems: WorldSceneItem[]; selectedSceneItemId: string | null } {
  if (!selectedItemId) return { sceneItems, selectedSceneItemId: null }

  const removedIndex = sceneItems.findIndex((item) => item.id === selectedItemId)
  if (removedIndex === -1) return { sceneItems, selectedSceneItemId: null }

  const nextSceneItems = sceneItems.filter((item) => item.id !== selectedItemId)
  const nextSelectedItem = nextSceneItems[removedIndex] ?? nextSceneItems[removedIndex - 1] ?? null

  return {
    sceneItems: nextSceneItems,
    selectedSceneItemId: nextSelectedItem?.id ?? null,
  }
}

export function updateWorldSceneItemTransform(
  sceneItems: WorldSceneItem[],
  itemId: string,
  transform: WorldSceneItem['transform'],
): WorldSceneItem[] {
  if (!sceneItems.some((item) => item.id === itemId)) return sceneItems
  return sceneItems.map((item) => item.id === itemId
    ? {
      ...item,
      transform: {
        position: [...transform.position],
        rotation: [...transform.rotation],
        scale: [...transform.scale],
      },
    }
    : item)
}

export function updateWorldSceneItemTransforms(
  sceneItems: WorldSceneItem[],
  updates: WorldSceneItemTransformUpdate[],
): WorldSceneItem[] {
  if (updates.length === 0) return sceneItems
  const updatesById = new Map(updates.map((update) => [update.itemId, update.transform]))
  if (updatesById.size === 0) return sceneItems

  let changed = false
  const nextItems = sceneItems.map((item) => {
    const transform = updatesById.get(item.id)
    if (!transform) return item
    changed = true
    return {
      ...item,
      transform: {
        position: [...transform.position],
        rotation: [...transform.rotation],
        scale: [...transform.scale],
      },
    }
  })

  return changed ? nextItems : sceneItems
}

export function createWorldSceneSelectionTransformUpdates({
  mode,
  activeItemId,
  snapshot,
  activeTransform,
}: {
  mode: WorldSceneTransformMode
  activeItemId: string
  snapshot: WorldSceneTransformSnapshot[]
  activeTransform: WorldSceneItem['transform']
}): WorldSceneItemTransformUpdate[] {
  const baselineItems = new Map(snapshot.map((entry) => [entry.itemId, entry.transform]))
  const activeBaseline = baselineItems.get(activeItemId)
  if (!activeBaseline) {
    return [{ itemId: activeItemId, transform: cloneWorldSceneTransform(activeTransform) }]
  }

  const updates: WorldSceneItemTransformUpdate[] = [{
    itemId: activeItemId,
    transform: cloneWorldSceneTransform(activeTransform),
  }]

  if (baselineItems.size === 1) return updates

  const pivot = toVector3(activeBaseline.position)
  const activeBaselineQuaternion = toQuaternion(activeBaseline.rotation)

  if (mode === 'translate') {
    const positionDelta = toVector3(activeTransform.position).sub(pivot)
    for (const [itemId, transform] of baselineItems) {
      if (itemId === activeItemId) continue
      const nextPosition = toVector3(transform.position).add(positionDelta)
      updates.push({
        itemId,
        transform: {
          position: nextPosition.toArray() as [number, number, number],
          rotation: [...transform.rotation],
          scale: [...transform.scale],
        },
      })
    }
    return updates
  }

  if (mode === 'rotate') {
    const activeRotationQuaternion = toQuaternion(activeTransform.rotation)
    const rotationDelta = activeRotationQuaternion.clone().multiply(activeBaselineQuaternion.clone().invert())

    for (const [itemId, transform] of baselineItems) {
      if (itemId === activeItemId) continue
      const offset = toVector3(transform.position).sub(pivot).applyQuaternion(rotationDelta)
      const nextQuaternion = rotationDelta.clone().multiply(toQuaternion(transform.rotation))
      const nextEuler = new Euler().setFromQuaternion(nextQuaternion, 'XYZ')
      updates.push({
        itemId,
        transform: {
          position: pivot.clone().add(offset).toArray() as [number, number, number],
          rotation: [nextEuler.x, nextEuler.y, nextEuler.z],
          scale: [...transform.scale],
        },
      })
    }
    return updates
  }

  const scaleRatio = [0, 1, 2].map((axis) => {
    const baseline = activeBaseline.scale[axis]
    if (Math.abs(baseline) < 1e-6) return 1
    return activeTransform.scale[axis] / baseline
  }) as [number, number, number]
  const inverseActiveBaselineQuaternion = activeBaselineQuaternion.clone().invert()

  for (const [itemId, transform] of baselineItems) {
    if (itemId === activeItemId) continue
    const localOffset = toVector3(transform.position).sub(pivot).applyQuaternion(inverseActiveBaselineQuaternion)
    localOffset.set(
      localOffset.x * scaleRatio[0],
      localOffset.y * scaleRatio[1],
      localOffset.z * scaleRatio[2],
    )
    const nextPosition = localOffset.applyQuaternion(activeBaselineQuaternion).add(pivot)
    updates.push({
      itemId,
      transform: {
        position: nextPosition.toArray() as [number, number, number],
        rotation: [...transform.rotation],
        scale: [
          transform.scale[0] * scaleRatio[0],
          transform.scale[1] * scaleRatio[1],
          transform.scale[2] * scaleRatio[2],
        ],
      },
    })
  }

  return updates
}

export function attachWorldSceneItemAnimation(
  sceneItems: WorldSceneItem[],
  itemId: string,
  animation: NonNullable<WorldSceneItem['animation']>,
): WorldSceneItem[] {
  return sceneItems.map((item) => item.id === itemId ? { ...item, animation: { ...animation } } : item)
}

export function addWorldCollisionZone(
  collisionZones: WorldCollisionZone[],
  preset: WorldCollisionZonePreset = 'blocker',
  options: AddWorldCollisionZoneOptions = {},
): { collisionZones: WorldCollisionZone[]; selectedCollisionZoneId: string } {
  const zoneId = createWorldCollisionZoneId(collisionZones)
  const presetDefinition = getWorldCollisionZonePresetDefinition(preset)
  const anchorPosition = options.anchorPosition ?? [0, 0, 0]
  const nextZone: WorldCollisionZone = {
    id: zoneId,
    label: `${presetDefinition.label} ${collisionZones.length + 1}`,
    shape: 'box',
    preset,
    transform: {
      position: [
        anchorPosition[0] + presetDefinition.transform.position[0],
        anchorPosition[1] + presetDefinition.transform.position[1],
        anchorPosition[2] + presetDefinition.transform.position[2],
      ],
      rotation: [...presetDefinition.transform.rotation],
      scale: [...presetDefinition.transform.scale],
    },
  }

  return {
    collisionZones: [...collisionZones.map(cloneWorldCollisionZone), nextZone],
    selectedCollisionZoneId: zoneId,
  }
}

export function updateWorldCollisionZoneTransform(
  collisionZones: WorldCollisionZone[],
  zoneId: string,
  transform: WorldCollisionZone['transform'],
): WorldCollisionZone[] {
  const nextScale = transform.scale.map((component) => Math.max(component, 0.05)) as [number, number, number]
  let changed = false
  const nextZones = collisionZones.map((zone) => {
    if (zone.id !== zoneId) return zone
    changed = true
    return {
      ...cloneWorldCollisionZone(zone),
      transform: {
        position: [...transform.position],
        rotation: [...transform.rotation],
        scale: nextScale,
      },
    }
  })
  return changed ? nextZones : collisionZones
}

export function removeWorldCollisionZone(
  collisionZones: WorldCollisionZone[],
  zoneId: string | null,
): { collisionZones: WorldCollisionZone[]; selectedCollisionZoneId: string | null } {
  if (!zoneId) return { collisionZones, selectedCollisionZoneId: null }

  const removedIndex = collisionZones.findIndex((zone) => zone.id === zoneId)
  if (removedIndex === -1) return { collisionZones, selectedCollisionZoneId: null }

  const nextCollisionZones = collisionZones.filter((zone) => zone.id !== zoneId)
  const nextSelectedZone = nextCollisionZones[removedIndex] ?? nextCollisionZones[removedIndex - 1] ?? null

  return {
    collisionZones: nextCollisionZones,
    selectedCollisionZoneId: nextSelectedZone?.id ?? null,
  }
}

export function resolveWorldCollisionZonePlacementAnchor(
  collisionZones: WorldCollisionZone[],
  sceneItems: WorldSceneItem[],
  options: {
    selectedCollisionZoneId?: string | null
    selectedSceneItemId?: string | null
    sceneItemAnchors?: Record<string, [number, number, number]>
  } = {},
): [number, number, number] {
  const { selectedCollisionZoneId = null, selectedSceneItemId = null, sceneItemAnchors = {} } = options
  if (selectedCollisionZoneId) {
    const selectedZone = collisionZones.find((zone) => zone.id === selectedCollisionZoneId)
    if (selectedZone) return [...selectedZone.transform.position]
  }

  if (selectedSceneItemId) {
    const selectedAnchor = sceneItemAnchors[selectedSceneItemId]
    if (selectedAnchor) return [...selectedAnchor]

    const selectedItem = sceneItems.find((sceneItem) => sceneItem.id === selectedSceneItemId)
    if (selectedItem) return [...selectedItem.transform.position]
  }

  return calculateBaseSceneAnchor(sceneItems, sceneItemAnchors)
}

export function resolveWorldSceneItemForPoseClip(
  sceneItems: WorldSceneItem[],
  sourceWorkspacePath: string,
  selectedItemId: string | null,
): WorldSceneItem | null {
  const matches = sceneItems.filter((item) => item.workspacePath === sourceWorkspacePath && (item.kind === 'glb' || item.kind === 'gltf'))
  if (matches.length === 0) return null
  return matches.find((item) => item.id === selectedItemId) ?? matches[0] ?? null
}

export function toggleWorldSceneItemBaseRole(sceneItems: WorldSceneItem[], itemId: string | null): WorldSceneItem[] {
  if (!itemId || !sceneItems.some((item) => item.id === itemId)) return sceneItems
  return sceneItems.map((item) => item.id === itemId ? { ...item, role: item.role === 'base-scene' ? 'asset' : 'base-scene' } : item)
}

function resolvePlacementIndex(sceneItems: WorldSceneItem[], item: WorldSceneItem): number {
  const hasBaseScene = sceneItems.some((sceneItem) => sceneItem.visible && sceneItem.role === 'base-scene')
  if (!hasBaseScene || item.role === 'base-scene') return sceneItems.length
  return sceneItems.filter((sceneItem) => sceneItem.role !== 'base-scene').length + 1
}

function resolvePlacementAnchor(
  sceneItems: WorldSceneItem[],
  sceneItemAnchors: Record<string, [number, number, number]>,
  selectedSceneItemId: string | null,
): [number, number, number] {
  if (selectedSceneItemId) {
    const selectedAnchor = sceneItemAnchors[selectedSceneItemId]
    if (selectedAnchor) return [...selectedAnchor] as [number, number, number]

    const selectedItem = sceneItems.find((sceneItem) => sceneItem.id === selectedSceneItemId)
    if (selectedItem) return [...selectedItem.transform.position] as [number, number, number]
  }

  return calculateBaseSceneAnchor(sceneItems, sceneItemAnchors)
}

function cloneWorldSceneTransform(transform: WorldSceneItem['transform']): WorldSceneItem['transform'] {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  }
}

function createWorldCollisionZoneId(zones: readonly WorldCollisionZone[]): string {
  let index = zones.length + 1
  let candidate = `collision-box-${index}`
  const zoneIds = new Set(zones.map((zone) => zone.id))
  while (zoneIds.has(candidate)) {
    index += 1
    candidate = `collision-box-${index}`
  }
  return candidate
}

function toVector3(vector: [number, number, number]): Vector3 {
  return new Vector3(vector[0], vector[1], vector[2])
}

function toQuaternion(rotation: [number, number, number]): Quaternion {
  return new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], 'XYZ'))
}

function createDuplicateWorldSceneItemId(baseId: string, existingIds: Set<string>): string {
  let duplicateIndex = 2
  let candidate = `${baseId}#${duplicateIndex}`
  while (existingIds.has(candidate)) {
    duplicateIndex += 1
    candidate = `${baseId}#${duplicateIndex}`
  }
  return candidate
}
