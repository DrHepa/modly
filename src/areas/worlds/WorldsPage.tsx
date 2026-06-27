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
  appendWorldSceneItem,
  attachWorldSceneItemAnimation,
  calculateWorldSceneItemPlacementOffset,
  type WorldSceneItemTransformUpdate,
  updateWorldSceneItemTransforms,
  removeWorldSceneItem,
  resolveWorldSceneItemForPoseClip,
  toggleWorldSceneItemBaseRole,
  updateWorldSceneItemTransform,
} from './worldsScenePlacement.ts'
import {
  listWorldAssetLibraryRenderables,
  openWorldAssetLibraryRenderable,
  type WorldAssetLibraryRenderable,
} from './worldAssetLibraryService.ts'
import type { WorldSceneItem } from './worldRenderableResolver.ts'
import {
  buildWorldsSceneManifest,
  createDefaultWorldsSceneManifestPath,
  decodeBase64Utf8,
  parseWorldsSceneManifestText,
  workspaceRelativePathFromAbsolute,
} from './worldsSceneManifest.ts'

export interface WorldsPageViewProps {
  selectorOpen: boolean
  assets: WorldAssetLibraryRenderable[]
  selectedAssetId: string | null
  selectedSceneItemId: string | null
  selectedSceneItemIds: string[]
  transformMode: WorldsTransformMode | null
  sceneItems: WorldSceneItem[]
  unsupportedItems: WorldsViewerUnsupportedItem[]
  loadingAssets: boolean
  openingAsset: boolean
  savingScene: boolean
  importingScene: boolean
  sceneStatus: string | null
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
  onSelectSceneItem: (itemId: string | null, options?: { toggle?: boolean }) => void
  onTransformModeChange: (mode: WorldsTransformMode | null) => void
  onTransformSceneItem: (itemId: string, transform: WorldSceneItem['transform']) => void
  onTransformSceneItems: (updates: WorldSceneItemTransformUpdate[]) => void
  onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void
  onRemoveSceneItem: (itemId: string | null) => void
  onToggleBaseSceneItem: (itemId: string | null) => void
  onSceneItemAnchorChange: (itemId: string, anchor: [number, number, number] | null) => void
  onOpenSelected: () => void
  onSaveScene: () => void
  onImportScene: () => void
}

export function WorldsPageView({
  selectorOpen,
  assets,
  selectedAssetId,
  selectedSceneItemId,
  selectedSceneItemIds,
  transformMode,
  sceneItems,
  unsupportedItems,
  loadingAssets,
  openingAsset,
  savingScene,
  importingScene,
  sceneStatus,
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
  onTransformSceneItems,
  onAnimationMetadata,
  onRemoveSceneItem,
  onToggleBaseSceneItem,
  onSceneItemAnchorChange,
  onOpenSelected,
  onSaveScene,
  onImportScene,
}: WorldsPageViewProps): JSX.Element {
  const hasSceneItems = sceneItems.length > 0
  const sceneActionBusy = savingScene || importingScene

  return (
    <main className="relative flex flex-1 overflow-hidden bg-surface-400 text-zinc-100" aria-label="Worlds viewer">
      <WorldsViewer
        items={sceneItems}
        unsupportedItems={unsupportedItems}
        selectedItemId={selectedSceneItemId}
        selectedItemIds={selectedSceneItemIds}
        transformMode={transformMode}
        onSelectItem={onSelectSceneItem}
        onTransformModeChange={onTransformModeChange}
        onTransformItem={onTransformSceneItem}
        onTransformItems={onTransformSceneItems}
        onAnimationMetadata={onAnimationMetadata}
        onRemoveItem={onRemoveSceneItem}
        onToggleBaseSceneItem={onToggleBaseSceneItem}
        onSceneItemAnchorChange={onSceneItemAnchorChange}
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
      <div className="absolute right-3 top-3 z-20 flex items-center gap-2 rounded-xl border border-zinc-700/70 bg-zinc-950/70 p-1 shadow-xl backdrop-blur" aria-label="Worlds scene persistence">
        <button
          type="button"
          className="rounded-lg px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!hasSceneItems || sceneActionBusy}
          onClick={onSaveScene}
          title={hasSceneItems ? 'Save the current Worlds scene manifest' : 'Add assets before saving a Worlds scene'}
        >
          {savingScene ? 'Saving…' : 'Save scene'}
        </button>
        <button
          type="button"
          className="rounded-lg px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-45"
          disabled={sceneActionBusy}
          onClick={onImportScene}
        >
          {importingScene ? 'Importing…' : 'Import scene'}
        </button>
        {sceneStatus ? <span className="max-w-52 truncate px-2 text-xs text-emerald-300" role="status">{sceneStatus}</span> : null}
      </div>
    </main>
  )
}

export { appendWorldSceneItem, attachWorldSceneItemAnimation, calculateWorldSceneItemPlacementOffset, removeWorldSceneItem, resolveWorldSceneItemForPoseClip, toggleWorldSceneItemBaseRole, updateWorldSceneItemTransform }

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
  const selectedSceneItemIds = useWorldsSceneStore((state) => state.selectedSceneItemIds)
  const transformMode = useWorldsSceneStore((state) => state.transformMode)
  const setSceneItemAnchor = useWorldsSceneStore((state) => state.setSceneItemAnchor)
  const setWorldScene = useWorldsSceneStore((state) => state.setScene)
  const setSelectedSceneItemId = useWorldsSceneStore((state) => state.setSelectedSceneItemId)
  const toggleSelectedSceneItemId = useWorldsSceneStore((state) => state.toggleSelectedSceneItemId)
  const setTransformMode = useWorldsSceneStore((state) => state.setTransformMode)
  const clearTransformMode = useWorldsSceneStore((state) => state.clearTransformMode)
  const [unsupportedItems, setUnsupportedItems] = useState<WorldsViewerUnsupportedItem[]>([])
  const [loadingAssets, setLoadingAssets] = useState(false)
  const [openingAsset, setOpeningAsset] = useState(false)
  const [savingScene, setSavingScene] = useState(false)
  const [importingScene, setImportingScene] = useState(false)
  const [sceneStatus, setSceneStatus] = useState<string | null>(null)
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

    if (selectedAsset.openable === true && 'sceneManifest' in selectedAsset) {
      await importSceneManifestFromWorkspacePath(selectedAsset.workspacePath)
      return
    }

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
        if ('sceneManifest' in result.asset) {
          await importSceneManifestFromWorkspacePath(result.asset.workspacePath)
        } else if ('poseClip' in result.asset) {
          const nextScene = attachPoseClipAsset(result.asset)
          setWorldScene(nextScene)
          setUnsupportedItems([])
          setSceneStatus(`Attached motion to ${result.asset.animation.sourceWorkspacePath}`)
        } else {
          const sceneState = useWorldsSceneStore.getState()
          setWorldScene(appendWorldSceneItem(sceneState.sceneItems, result.asset.item, {
            sceneItemAnchors: sceneState.sceneItemAnchors,
            selectedSceneItemId: sceneState.selectedSceneItemId,
          }))
          setUnsupportedItems([])
          setSceneStatus(null)
        }
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

  function attachPoseClipAsset(asset: Extract<WorldAssetLibraryRenderable, { poseClip: true }>): { sceneItems: WorldSceneItem[]; selectedSceneItemId: string | null } {
    const sceneState = useWorldsSceneStore.getState()
    const existingTarget = resolveWorldSceneItemForPoseClip(sceneState.sceneItems, asset.animation.sourceWorkspacePath, sceneState.selectedSceneItemId)
    if (existingTarget) {
      return {
        sceneItems: attachWorldSceneItemAnimation(sceneState.sceneItems, existingTarget.id, asset.animation),
        selectedSceneItemId: existingTarget.id,
      }
    }

    if (asset.linkedItem) {
      const appended = appendWorldSceneItem(sceneState.sceneItems, { ...asset.linkedItem, animation: asset.animation }, {
        sceneItemAnchors: sceneState.sceneItemAnchors,
        selectedSceneItemId: sceneState.selectedSceneItemId,
      })
      return appended
    }

    return { sceneItems: sceneState.sceneItems, selectedSceneItemId: sceneState.selectedSceneItemId }
  }

  async function saveSceneManifest(): Promise<void> {
    const currentItems = useWorldsSceneStore.getState().sceneItems
    if (currentItems.length === 0) return

    setSavingScene(true)
    setError(null)
    setSceneStatus(null)
    try {
      const settings = await window.electron.settings.get()
      const savePath = await window.electron.fs.savePath({
        filters: [{ name: 'Scene manifest', extensions: ['json'] }],
        defaultPath: `${settings.workspaceDir.replace(/[/\\]+$/, '')}/${createDefaultWorldsSceneManifestPath()}`,
      })
      if (!savePath) return

      const workspacePath = workspaceRelativePathFromAbsolute(savePath, settings.workspaceDir)
      if (!workspacePath) {
        setError('Save scene requires a destination inside the Modly workspace.')
        return
      }

      const result = await window.electron.workspace.worlds.writeSceneManifest({
        workspacePath,
        manifest: buildWorldsSceneManifest(currentItems),
      })
      if (result.success !== true) {
        setError(result.error)
        return
      }

      setSceneStatus(`Saved ${result.workspacePath}`)
      void refreshAssets()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to save Worlds scene.')
    } finally {
      setSavingScene(false)
    }
  }

  async function importSceneManifest(): Promise<void> {
    setImportingScene(true)
    setError(null)
    setSceneStatus(null)
    try {
      const filePath = await window.electron.fs.selectSceneFile()
      if (!filePath) return
      const settings = await window.electron.settings.get()
      const workspacePath = workspaceRelativePathFromAbsolute(filePath, settings.workspaceDir)
      if (!workspacePath) {
        setError('Import scene requires a scene manifest inside the Modly workspace.')
        return
      }
      await importSceneManifestFromWorkspacePath(workspacePath, settings.workspaceDir)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to import Worlds scene.')
    } finally {
      setImportingScene(false)
    }
  }

  async function importSceneManifestFromWorkspacePath(workspacePath: string, knownWorkspaceDir?: string): Promise<void> {
    setImportingScene(true)
    setError(null)
    setSceneStatus(null)
    try {
      const workspaceDir = knownWorkspaceDir ?? (await window.electron.settings.get()).workspaceDir
      const base64 = await window.electron.fs.readFileBase64(`${workspaceDir.replace(/[/\\]+$/, '')}/${workspacePath}`)
      const parsed = parseWorldsSceneManifestText(decodeBase64Utf8(base64), { apiUrl })
      if (parsed.success !== true) {
        setError(parsed.error)
        return
      }

      setWorldScene({
        sceneItems: parsed.sceneItems,
        selectedSceneItemId: parsed.sceneItems.find((item) => item.visible)?.id ?? null,
      })
      setUnsupportedItems([])
      setSceneStatus(`Imported ${workspacePath}`)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to import Worlds scene.')
    } finally {
      setImportingScene(false)
    }
  }

  useEffect(() => {
    void refreshAssets()
  }, [apiUrl])

  useEffect(() => {
    const visibleItemIds = new Set(sceneItems.filter((item) => item.visible).map((item) => item.id))
    const nextSelectedSceneItemIds = selectedSceneItemIds.filter((itemId) => visibleItemIds.has(itemId))
    const nextSelectedSceneItemId = selectedSceneItemId && visibleItemIds.has(selectedSceneItemId)
      ? selectedSceneItemId
      : nextSelectedSceneItemIds.at(-1) ?? null

    if (nextSelectedSceneItemId === selectedSceneItemId && nextSelectedSceneItemIds.length === selectedSceneItemIds.length) return

    setWorldScene({
      sceneItems,
      selectedSceneItemId: nextSelectedSceneItemId,
      selectedSceneItemIds: nextSelectedSceneItemIds,
    })
    if (!nextSelectedSceneItemId) clearTransformMode()
  }, [clearTransformMode, sceneItems, selectedSceneItemId, selectedSceneItemIds, setWorldScene])

  return (
    <WorldsPageView
      selectorOpen={selectorOpen}
      assets={assets}
      selectedAssetId={selectedAssetId}
      selectedSceneItemId={selectedSceneItemId}
      selectedSceneItemIds={selectedSceneItemIds}
      transformMode={transformMode}
      sceneItems={sceneItems}
      unsupportedItems={unsupportedItems}
      loadingAssets={loadingAssets}
      openingAsset={openingAsset}
      savingScene={savingScene}
      importingScene={importingScene}
      sceneStatus={sceneStatus}
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
      onSelectSceneItem={(itemId, options) => {
        if (options?.toggle && itemId) toggleSelectedSceneItemId(itemId)
        else setSelectedSceneItemId(itemId, { preserveSelection: options?.preserveSelection })
        if (!itemId) setTransformMode(null)
      }}
      onTransformModeChange={setTransformMode}
      onTransformSceneItem={(itemId, transform) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: updateWorldSceneItemTransform(state.sceneItems, itemId, transform),
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
        })
      }}
      onTransformSceneItems={(updates) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: updateWorldSceneItemTransforms(state.sceneItems, updates),
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
        })
      }}
      onAnimationMetadata={(itemId, animation) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: attachWorldSceneItemAnimation(state.sceneItems, itemId, animation),
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
        })
      }}
      onRemoveSceneItem={(itemId) => {
        setWorldScene(removeWorldSceneItem(useWorldsSceneStore.getState().sceneItems, itemId))
        clearTransformMode()
      }}
      onToggleBaseSceneItem={(itemId) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: toggleWorldSceneItemBaseRole(state.sceneItems, itemId),
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
        })
      }}
      onSceneItemAnchorChange={setSceneItemAnchor}
      onOpenSelected={() => void openSelectedAsset()}
      onSaveScene={() => void saveSceneManifest()}
      onImportScene={() => void importSceneManifest()}
    />
  )
}
