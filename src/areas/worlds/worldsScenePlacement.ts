import type { WorldSceneItem } from './worldRenderableResolver.ts'

export function appendWorldSceneItem(
  sceneItems: WorldSceneItem[],
  item: WorldSceneItem,
  sceneItemAnchors: Record<string, [number, number, number]> = {},
): { sceneItems: WorldSceneItem[]; selectedSceneItemId: string } {
  const existingIds = new Set(sceneItems.map((sceneItem) => sceneItem.id))
  const placementOffset = calculateWorldSceneItemPlacementOffset(resolvePlacementIndex(sceneItems, item))
  const baseAnchor = item.role === 'base-scene' ? [0, 0, 0] as [number, number, number] : calculateBaseSceneAnchor(sceneItems, sceneItemAnchors)
  const placedItem = {
    ...item,
    role: item.role ?? 'asset',
    transform: {
      position: [
        item.transform.position[0] + baseAnchor[0] + placementOffset[0],
        item.transform.position[1] + baseAnchor[1] + placementOffset[1],
        item.transform.position[2] + baseAnchor[2] + placementOffset[2],
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
  const zeroBasedOffsetIndex = itemIndex - 1
  const ring = Math.floor(zeroBasedOffsetIndex / directions.length) + 1
  const [xDirection, zDirection] = directions[zeroBasedOffsetIndex % directions.length]

  return [xDirection * ring * spacing, 0, zDirection * ring * spacing]
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

export function toggleWorldSceneItemBaseRole(sceneItems: WorldSceneItem[], itemId: string | null): WorldSceneItem[] {
  if (!itemId || !sceneItems.some((item) => item.id === itemId)) return sceneItems
  return sceneItems.map((item) => item.id === itemId ? { ...item, role: item.role === 'base-scene' ? 'asset' : 'base-scene' } : item)
}

function resolvePlacementIndex(sceneItems: WorldSceneItem[], item: WorldSceneItem): number {
  const hasBaseScene = sceneItems.some((sceneItem) => sceneItem.visible && sceneItem.role === 'base-scene')
  if (!hasBaseScene || item.role === 'base-scene') return sceneItems.length
  return sceneItems.filter((sceneItem) => sceneItem.role !== 'base-scene').length + 1
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
