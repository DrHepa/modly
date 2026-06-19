import { useEffect, useMemo, useState } from 'react'

import WorldAssetSelector from './components/WorldAssetSelector.tsx'
import WorldsViewer, { type WorldsViewerUnsupportedItem } from './components/WorldsViewer.tsx'
import { useAppStore } from '../../shared/stores/appStore.ts'
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
  sceneItems: WorldSceneItem[]
  unsupportedItems: WorldsViewerUnsupportedItem[]
  loadingAssets: boolean
  openingAsset: boolean
  error: string | null
  onToggleSelector: () => void
  onCloseSelector: () => void
  onRefreshAssets: () => void
  onSelectAsset: (assetId: string) => void
  onOpenSelected: () => void
}

export function WorldsPageView({
  selectorOpen,
  assets,
  selectedAssetId,
  sceneItems,
  unsupportedItems,
  loadingAssets,
  openingAsset,
  error,
  onToggleSelector,
  onCloseSelector,
  onRefreshAssets,
  onSelectAsset,
  onOpenSelected,
}: WorldsPageViewProps): JSX.Element {
  return (
    <main className="relative flex flex-1 overflow-hidden bg-surface-400 text-zinc-100" aria-label="Worlds viewer">
      <WorldsViewer items={sceneItems} unsupportedItems={unsupportedItems} />
      <div className="absolute left-3 top-3 flex items-center gap-2 rounded-xl border border-zinc-700/70 bg-zinc-950/70 p-1 shadow-xl backdrop-blur">
        <WorldAssetSelector
          open={selectorOpen}
          assets={assets}
          selectedAssetId={selectedAssetId}
          loading={loadingAssets}
          opening={openingAsset}
          error={error}
          onToggle={onToggleSelector}
          onClose={onCloseSelector}
          onRefresh={onRefreshAssets}
          onSelectAsset={onSelectAsset}
          onOpenSelected={onOpenSelected}
        />
      </div>
    </main>
  )
}

export default function WorldsPage(): JSX.Element {
  const apiUrl = useAppStore((state) => state.apiUrl)
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [assets, setAssets] = useState<WorldAssetLibraryRenderable[]>([])
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [sceneItems, setSceneItems] = useState<WorldSceneItem[]>([])
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

    if (!selectedAsset.openable) {
      setSceneItems([])
      setUnsupportedItems([{ workspacePath: selectedAsset.workspacePath, reason: selectedAsset.reason }])
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

      if (result.asset.openable) {
        setSceneItems([result.asset.item])
        setUnsupportedItems([])
      } else {
        setSceneItems([])
        setUnsupportedItems([{ workspacePath: result.asset.workspacePath, reason: result.asset.reason }])
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

  return (
    <WorldsPageView
      selectorOpen={selectorOpen}
      assets={assets}
      selectedAssetId={selectedAssetId}
      sceneItems={sceneItems}
      unsupportedItems={unsupportedItems}
      loadingAssets={loadingAssets}
      openingAsset={openingAsset}
      error={error}
      onToggleSelector={() => setSelectorOpen((open) => !open)}
      onCloseSelector={() => setSelectorOpen(false)}
      onRefreshAssets={() => void refreshAssets()}
      onSelectAsset={setSelectedAssetId}
      onOpenSelected={() => void openSelectedAsset()}
    />
  )
}
