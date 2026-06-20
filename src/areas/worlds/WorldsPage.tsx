import { useEffect, useRef, useState } from 'react'

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
      <div className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-xl border border-zinc-700/70 bg-zinc-950/70 p-1 shadow-xl backdrop-blur">
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
  // A new workspace owns a new lifecycle, including A -> B -> A transitions.
  return <WorldsWorkspace key={apiUrl} apiUrl={apiUrl} />
}

function WorldsWorkspace({ apiUrl }: { apiUrl: string }): JSX.Element {
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [assets, setAssets] = useState<WorldAssetLibraryRenderable[]>([])
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [sceneItems, setSceneItems] = useState<WorldSceneItem[]>([])
  const [unsupportedItems, setUnsupportedItems] = useState<WorldsViewerUnsupportedItem[]>([])
  const [loadingAssets, setLoadingAssets] = useState(false)
  const [openingAsset, setOpeningAsset] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mounted = useRef(false)
  const listEpoch = useRef(0)
  const openEpoch = useRef(0)
  const listing = useRef(false)
  const currentAssets = useRef<WorldAssetLibraryRenderable[]>([])
  const currentSelection = useRef<string | null>(null)

  function selectAsset(assetId: string | null): void {
    if (!mounted.current) return
    ++openEpoch.current
    currentSelection.current = assetId
    setSelectedAssetId(assetId)
    setOpeningAsset(false)
    setError(null)
  }

  async function refreshAssets(): Promise<void> {
    if (!mounted.current) return
    const epoch = ++listEpoch.current
    const ownsList = () => mounted.current && listEpoch.current === epoch
    ++openEpoch.current
    listing.current = true
    setOpeningAsset(false)
    setLoadingAssets(true)
    setError(null)
    try {
      const result = await listWorldAssetLibraryRenderables(apiUrl)
      if (!ownsList()) return
      if (result.success !== true) {
        currentAssets.current = []
        selectAsset(null)
        setError(result.error)
        setAssets([])
        return
      }

      currentAssets.current = result.assets
      const current = currentSelection.current
      selectAsset(current && result.assets.some((asset) => asset.id === current)
        ? current
        : result.assets.find((asset) => asset.openable)?.id ?? result.assets[0]?.id ?? null)
      setAssets(result.assets)
    } catch (reason: unknown) {
      if (!ownsList()) return
      currentAssets.current = []
      setAssets([])
      selectAsset(null)
      setError(reason instanceof Error ? reason.message : 'Unable to load world assets.')
    } finally {
      if (ownsList()) {
        listing.current = false
        setLoadingAssets(false)
      }
    }
  }

  async function openSelectedAsset(): Promise<void> {
    if (!mounted.current || listing.current) return
    const selectedAsset = currentAssets.current.find(asset => asset.id === currentSelection.current)
    if (!selectedAsset) return
    const epoch = ++openEpoch.current
    const ownsOpen = () => mounted.current && openEpoch.current === epoch
    setError(null)

    if (!selectedAsset.openable) {
      setOpeningAsset(false)
      setSceneItems([])
      setUnsupportedItems([{ workspacePath: selectedAsset.workspacePath, reason: selectedAsset.reason }])
      return
    }

    setOpeningAsset(true)
    setError(null)
    try {
      const result = await openWorldAssetLibraryRenderable({ workspacePath: selectedAsset.workspacePath }, apiUrl)
      if (!ownsOpen()) return
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
      if (!ownsOpen()) return
      setError(reason instanceof Error ? reason.message : 'Unable to open world asset.')
    } finally {
      if (ownsOpen()) setOpeningAsset(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void refreshAssets()
    return () => {
      mounted.current = false
      ++listEpoch.current
      ++openEpoch.current
    }
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
      onSelectAsset={selectAsset}
      onOpenSelected={() => void openSelectedAsset()}
    />
  )
}
