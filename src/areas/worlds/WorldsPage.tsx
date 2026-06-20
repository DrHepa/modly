import { useEffect, useMemo, useState } from 'react'

import WorldAssetSelector from './components/WorldAssetSelector.tsx'
import WorldsViewer, { type WorldsViewerUnsupportedItem } from './components/WorldsViewer.tsx'
import {
  getDefaultWorkspaceAssetLibraryCollapsedSectionKeys,
  type WorkspaceAssetLibrarySortMode,
} from '../../shared/components/WorkspaceAssetLibrary.tsx'
import { useAppStore } from '../../shared/stores/appStore.ts'
import type { WorldsTransformMode } from './components/WorldsTransformToolbar.tsx'
import { useWorldsSceneStore } from './worldsSceneStore.ts'
import {
  listWorldAssetLibraryRenderables,
  openWorldAssetLibraryRenderable,
  type WorldAssetLibraryRenderable,
} from './worldAssetLibraryService.ts'
import type { WorldSceneItem } from './worldRenderableResolver.ts'

export interface WorldsPageViewProps {
  selectorOpen: boolean
  assets: WorldAssetLibraryRenderable[]
  selectedAssetId: string | null
  selectedSceneItemId: string | null
  transformMode: WorldsTransformMode | null
  sceneItems: WorldSceneItem[]
  unsupportedItems: WorldsViewerUnsupportedItem[]
  loadingAssets: boolean
  openingAsset: boolean
  error: string | null
  searchQuery: string
  sortMode: WorkspaceAssetLibrarySortMode
  collapsedSectionKeys: string[]
  onToggleSelector: () => void
  onCloseSelector: () => void
  onRefreshAssets: () => void
  onSelectAsset: (assetId: string) => void
  onSearchQueryChange: (value: string) => void
  onSortModeChange: (sortMode: WorkspaceAssetLibrarySortMode) => void
  onToggleSection: (sectionKey: string) => void
  onSelectSceneItem: (itemId: string | null) => void
  onTransformModeChange: (mode: WorldsTransformMode | null) => void
  onTransformSceneItem: (itemId: string, transform: WorldSceneItem['transform']) => void
  onRemoveSceneItem: (itemId: string | null) => void
  onOpenSelected: () => void
}

export function WorldsPageView({
  selectorOpen,
  assets,
  selectedAssetId,
  selectedSceneItemId,
  transformMode,
  sceneItems,
  unsupportedItems,
  loadingAssets,
  openingAsset,
  error,
  searchQuery,
  sortMode,
  collapsedSectionKeys,
  onToggleSelector,
  onCloseSelector,
  onRefreshAssets,
  onSelectAsset,
  onSearchQueryChange,
  onSortModeChange,
  onToggleSection,
  onSelectSceneItem,
  onTransformModeChange,
  onTransformSceneItem,
  onRemoveSceneItem,
  onOpenSelected,
}: WorldsPageViewProps): JSX.Element {
  return (
    <main className="relative flex flex-1 overflow-hidden bg-surface-400 text-zinc-100" aria-label="Worlds viewer">
      <WorldsViewer
        items={sceneItems}
        unsupportedItems={unsupportedItems}
        selectedItemId={selectedSceneItemId}
        transformMode={transformMode}
        onSelectItem={onSelectSceneItem}
        onTransformModeChange={onTransformModeChange}
        onTransformItem={onTransformSceneItem}
        onRemoveItem={onRemoveSceneItem}
      />
      <div className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-xl border border-zinc-700/70 bg-zinc-950/70 p-1 shadow-xl backdrop-blur">
        <WorldAssetSelector
          open={selectorOpen}
          assets={assets}
          selectedAssetId={selectedAssetId}
          loading={loadingAssets}
          opening={openingAsset}
          error={error}
          searchQuery={searchQuery}
          sortMode={sortMode}
          collapsedSectionKeys={collapsedSectionKeys}
          onToggle={onToggleSelector}
          onClose={onCloseSelector}
          onRefresh={onRefreshAssets}
          onSelectAsset={onSelectAsset}
          onSearchQueryChange={onSearchQueryChange}
          onSortModeChange={onSortModeChange}
          onToggleSection={onToggleSection}
          onOpenSelected={onOpenSelected}
        />
      </div>
    </main>
  )
}

export function appendWorldSceneItem(sceneItems: WorldSceneItem[], item: WorldSceneItem): { sceneItems: WorldSceneItem[]; selectedSceneItemId: string } {
  const existingIds = new Set(sceneItems.map((sceneItem) => sceneItem.id))
  const placementOffset = calculateWorldSceneItemPlacementOffset(sceneItems.length)
  const placedItem = {
    ...item,
    transform: {
      position: [
        item.transform.position[0] + placementOffset[0],
        item.transform.position[1] + placementOffset[1],
        item.transform.position[2] + placementOffset[2],
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

function createDuplicateWorldSceneItemId(baseId: string, existingIds: Set<string>): string {
  let duplicateIndex = 2
  let candidate = `${baseId}#${duplicateIndex}`
  while (existingIds.has(candidate)) {
    duplicateIndex += 1
    candidate = `${baseId}#${duplicateIndex}`
  }
  return candidate
}

export default function WorldsPage(): JSX.Element {
  const apiUrl = useAppStore((state) => state.apiUrl)
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [assets, setAssets] = useState<WorldAssetLibraryRenderable[]>([])
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [librarySearchQuery, setLibrarySearchQuery] = useState('')
  const [librarySortMode, setLibrarySortMode] = useState<WorkspaceAssetLibrarySortMode>('type')
  const [libraryCollapsedSectionKeys, setLibraryCollapsedSectionKeys] = useState<string[]>(() => getDefaultWorkspaceAssetLibraryCollapsedSectionKeys())
  const sceneItems = useWorldsSceneStore((state) => state.sceneItems)
  const selectedSceneItemId = useWorldsSceneStore((state) => state.selectedSceneItemId)
  const transformMode = useWorldsSceneStore((state) => state.transformMode)
  const setWorldScene = useWorldsSceneStore((state) => state.setScene)
  const setSelectedSceneItemId = useWorldsSceneStore((state) => state.setSelectedSceneItemId)
  const setTransformMode = useWorldsSceneStore((state) => state.setTransformMode)
  const clearTransformMode = useWorldsSceneStore((state) => state.clearTransformMode)
  const [unsupportedItems, setUnsupportedItems] = useState<WorldsViewerUnsupportedItem[]>([])
  const [loadingAssets, setLoadingAssets] = useState(false)
  const [openingAsset, setOpeningAsset] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  )
  async function refreshAssets(): Promise<void> {
    setLoadingAssets(true)
    setError(null)
    try {
      const result = await listWorldAssetLibraryRenderables(apiUrl)
      if (result.success !== true) {
        setError(result.error)
        setAssets([])
        setSelectedAssetId(null)
        return
      }

      setAssets(result.assets)
      setSelectedAssetId((current) => current && result.assets.some((asset) => asset.id === current)
        ? current
        : result.assets.find((asset) => asset.openable)?.id ?? result.assets[0]?.id ?? null)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to load world assets.')
    } finally {
      setLoadingAssets(false)
    }
  }

  async function openSelectedAsset(): Promise<void> {
    if (!selectedAsset) return

    if (selectedAsset.openable === false) {
      setSelectedSceneItemId(null)
      clearTransformMode()
      setUnsupportedItems((items) => [...items, { workspacePath: selectedAsset.workspacePath, reason: selectedAsset.reason }])
      return
    }

    setOpeningAsset(true)
    setError(null)
    try {
      const result = await openWorldAssetLibraryRenderable({ workspacePath: selectedAsset.workspacePath }, apiUrl)
      if (result.success !== true) {
        setError(result.error)
        return
      }

      if (result.asset.openable === true) {
        setWorldScene(appendWorldSceneItem(useWorldsSceneStore.getState().sceneItems, result.asset.item))
        setUnsupportedItems([])
      } else {
        setSelectedSceneItemId(null)
        clearTransformMode()
        const unsupportedAsset = result.asset.openable === false ? result.asset : null
        if (unsupportedAsset) {
          setUnsupportedItems((items) => [...items, { workspacePath: unsupportedAsset.workspacePath, reason: unsupportedAsset.reason }])
        }
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to open world asset.')
    } finally {
      setOpeningAsset(false)
    }
  }

  useEffect(() => {
    void refreshAssets()
  }, [apiUrl])

  useEffect(() => {
    if (selectedSceneItemId && sceneItems.some((item) => item.id === selectedSceneItemId && item.visible)) return
    if (selectedSceneItemId) setSelectedSceneItemId(null)
    clearTransformMode()
  }, [clearTransformMode, sceneItems, selectedSceneItemId, setSelectedSceneItemId])

  return (
    <WorldsPageView
      selectorOpen={selectorOpen}
      assets={assets}
      selectedAssetId={selectedAssetId}
      selectedSceneItemId={selectedSceneItemId}
      transformMode={transformMode}
      sceneItems={sceneItems}
      unsupportedItems={unsupportedItems}
      loadingAssets={loadingAssets}
      openingAsset={openingAsset}
      error={error}
      searchQuery={librarySearchQuery}
      sortMode={librarySortMode}
      collapsedSectionKeys={libraryCollapsedSectionKeys}
      onToggleSelector={() => setSelectorOpen((open) => !open)}
      onCloseSelector={() => setSelectorOpen(false)}
      onRefreshAssets={() => void refreshAssets()}
      onSelectAsset={setSelectedAssetId}
      onSearchQueryChange={setLibrarySearchQuery}
      onSortModeChange={setLibrarySortMode}
      onToggleSection={(sectionKey) => {
        setLibraryCollapsedSectionKeys((current) => current.includes(sectionKey)
          ? current.filter((value) => value !== sectionKey)
          : [...current, sectionKey])
      }}
      onSelectSceneItem={(itemId) => {
        setSelectedSceneItemId(itemId)
        if (!itemId) setTransformMode(null)
      }}
      onTransformModeChange={setTransformMode}
      onTransformSceneItem={(itemId, transform) => {
        setWorldScene({
          sceneItems: updateWorldSceneItemTransform(useWorldsSceneStore.getState().sceneItems, itemId, transform),
          selectedSceneItemId: useWorldsSceneStore.getState().selectedSceneItemId,
        })
      }}
      onRemoveSceneItem={(itemId) => {
        setWorldScene(removeWorldSceneItem(useWorldsSceneStore.getState().sceneItems, itemId))
        clearTransformMode()
      }}
      onOpenSelected={() => void openSelectedAsset()}
    />
  )
}
