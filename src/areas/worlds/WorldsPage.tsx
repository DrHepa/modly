import { useEffect, useMemo, useState } from 'react'

import WorldAssetSelector from './components/WorldAssetSelector.tsx'
import WorldsViewer, { type WorldsViewerUnsupportedItem } from './components/WorldsViewer.tsx'
import {
  getDefaultWorkspaceAssetLibraryCollapsedSectionKeys,
  type WorkspaceAssetLibrarySortMode,
} from '../../shared/components/WorkspaceAssetLibrary.tsx'
import { useAppStore } from '../../shared/stores/appStore.ts'
import type { SceneArtifactManifestInitialView } from '../../shared/types/artifacts.ts'
import type { WorldsTransformMode } from './components/WorldsTransformToolbar.tsx'
import { useWorldsSceneStore } from './worldsSceneStore.ts'
import {
  appendWorldSceneItem,
  attachWorldSceneItemAnimation,
  calculateBaseSceneAnchor,
  calculateWorldSceneItemPlacementOffset,
  shouldPendingWorldsSurfacePlacement,
  type WorldSceneItemTransformUpdate,
  updateWorldSceneItemTransforms,
  removeWorldSceneItem,
  resolveWorldSceneItemForPoseClip,
  toggleWorldSceneItemBaseRole,
  updateWorldSceneItemTransform,
} from './worldsScenePlacement.ts'
import {
  addWorldCollisionSurface,
  removeWorldCollisionSurface,
  updateWorldCollisionSurfaceTransform,
} from './worldsCollisionSurfaceEditor.ts'
import type { WorldCollisionSurface, WorldCollisionSurfacePreset } from './worldsCollisionSurfaces.ts'
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
  pendingSurfacePlacementItemId: string | null
  collisionEditMode: boolean
  selectedCollisionSurfaceId: string | null
  transformMode: WorldsTransformMode | null
  sceneItems: WorldSceneItem[]
  collisionSurfaces: WorldCollisionSurface[]
  initialView?: SceneArtifactManifestInitialView
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
  onAddCollisionSurface: (preset?: WorldCollisionSurfacePreset) => void
  onCollisionEditModeChange: (enabled: boolean) => void
  onSelectCollisionSurface: (surfaceId: string | null) => void
  onTransformCollisionSurface: (surfaceId: string, transform: WorldCollisionSurface['transform']) => void
  onRemoveCollisionSurface: (surfaceId: string | null) => void
  onAnimationMetadata: (itemId: string, animation: NonNullable<WorldSceneItem['animation']>) => void
  onRemoveSceneItem: (itemId: string | null) => void
  onToggleBaseSceneItem: (itemId: string | null) => void
  onSceneItemAnchorChange: (itemId: string, anchor: [number, number, number] | null) => void
  onCommitPendingSurfacePlacement: (itemId: string, transform: WorldSceneItem['transform']) => void
  onClearPendingSurfacePlacement: () => void
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
  pendingSurfacePlacementItemId,
  collisionEditMode,
  selectedCollisionSurfaceId,
  transformMode,
  sceneItems,
  collisionSurfaces = [],
  initialView,
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
  onAddCollisionSurface,
  onCollisionEditModeChange,
  onSelectCollisionSurface,
  onTransformCollisionSurface,
  onRemoveCollisionSurface,
  onAnimationMetadata,
  onRemoveSceneItem,
  onToggleBaseSceneItem,
  onSceneItemAnchorChange,
  onCommitPendingSurfacePlacement,
  onClearPendingSurfacePlacement,
  onOpenSelected,
  onSaveScene,
  onImportScene,
}: WorldsPageViewProps): JSX.Element {
  const hasSceneItems = sceneItems.length > 0
  const hasSceneContent = hasSceneItems || collisionSurfaces.length > 0
  const sceneActionBusy = savingScene || importingScene

  return (
    <main className="relative flex flex-1 overflow-hidden bg-surface-400 text-zinc-100" aria-label="Worlds viewer">
      <WorldsViewer
        items={sceneItems}
        initialView={initialView}
        unsupportedItems={unsupportedItems}
        selectedItemId={selectedSceneItemId}
        selectedItemIds={selectedSceneItemIds}
        pendingSurfacePlacementItemId={pendingSurfacePlacementItemId}
        collisionEditMode={collisionEditMode}
        selectedCollisionSurfaceId={selectedCollisionSurfaceId}
        transformMode={transformMode}
        collisionSurfaces={collisionSurfaces}
        onSelectItem={onSelectSceneItem}
        onAddCollisionSurface={onAddCollisionSurface}
        onCollisionEditModeChange={onCollisionEditModeChange}
        onSelectCollisionSurface={onSelectCollisionSurface}
        onTransformModeChange={onTransformModeChange}
        onTransformItem={onTransformSceneItem}
        onTransformItems={onTransformSceneItems}
        onTransformCollisionSurface={onTransformCollisionSurface}
        onRemoveCollisionSurface={onRemoveCollisionSurface}
        onAnimationMetadata={onAnimationMetadata}
        onRemoveItem={onRemoveSceneItem}
        onToggleBaseSceneItem={onToggleBaseSceneItem}
        onSceneItemAnchorChange={onSceneItemAnchorChange}
        onCommitPendingSurfacePlacement={onCommitPendingSurfacePlacement}
        onClearPendingSurfacePlacement={onClearPendingSurfacePlacement}
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
          disabled={!hasSceneContent || sceneActionBusy}
          onClick={onSaveScene}
          title={hasSceneContent ? 'Save the current Worlds scene manifest' : 'Add assets or collision surfaces before saving a Worlds scene'}
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

export {
  appendWorldSceneItem,
  attachWorldSceneItemAnimation,
  calculateBaseSceneAnchor,
  calculateWorldSceneItemPlacementOffset,
  removeWorldSceneItem,
  removeWorldCollisionSurface,
  resolveWorldSceneItemForPoseClip,
  shouldPendingWorldsSurfacePlacement,
  toggleWorldSceneItemBaseRole,
  updateWorldCollisionSurfaceTransform,
  updateWorldSceneItemTransform,
}

export function resolveWorldCollisionSurfacePlacementTransform(
  surfaces: WorldCollisionSurface[],
  sceneItems: WorldSceneItem[],
  options: {
    selectedCollisionSurfaceId?: string | null
    selectedSceneItemId?: string | null
    sceneItemAnchors?: Record<string, [number, number, number]>
  } = {},
): Partial<WorldCollisionSurface['transform']> {
  const { selectedCollisionSurfaceId = null, selectedSceneItemId = null, sceneItemAnchors = {} } = options
  if (selectedCollisionSurfaceId) {
    const selectedSurface = surfaces.find((surface) => surface.id === selectedCollisionSurfaceId)
    if (selectedSurface) {
      return {
        position: [...selectedSurface.transform.position],
        rotation: [...selectedSurface.transform.rotation],
      }
    }
  }

  if (selectedSceneItemId) {
    const selectedAnchor = sceneItemAnchors[selectedSceneItemId]
    if (selectedAnchor) return { position: [...selectedAnchor] }

    const selectedItem = sceneItems.find((sceneItem) => sceneItem.id === selectedSceneItemId)
    if (selectedItem) return { position: [...selectedItem.transform.position] }
  }

  return { position: calculateBaseSceneAnchor(sceneItems, sceneItemAnchors) }
}

export function normalizeWorldAssetLibraryAssets(value: unknown): WorldAssetLibraryRenderable[] | null {
  return Array.isArray(value) ? value as WorldAssetLibraryRenderable[] : null
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
  const collisionSurfaces = useWorldsSceneStore((state) => state.collisionSurfaces)
  const initialView = useWorldsSceneStore((state) => state.initialView)
  const selectedSceneItemId = useWorldsSceneStore((state) => state.selectedSceneItemId)
  const selectedSceneItemIds = useWorldsSceneStore((state) => state.selectedSceneItemIds)
  const collisionEditMode = useWorldsSceneStore((state) => state.collisionEditMode)
  const selectedCollisionSurfaceId = useWorldsSceneStore((state) => state.selectedCollisionSurfaceId)
  const transformMode = useWorldsSceneStore((state) => state.transformMode)
  const pendingSurfacePlacementItemId = useWorldsSceneStore((state) => state.pendingSurfacePlacementItemId)
  const setSceneItemAnchor = useWorldsSceneStore((state) => state.setSceneItemAnchor)
  const setWorldScene = useWorldsSceneStore((state) => state.setScene)
  const setSelectedSceneItemId = useWorldsSceneStore((state) => state.setSelectedSceneItemId)
  const toggleSelectedSceneItemId = useWorldsSceneStore((state) => state.toggleSelectedSceneItemId)
  const setCollisionEditMode = useWorldsSceneStore((state) => state.setCollisionEditMode)
  const setSelectedCollisionSurfaceId = useWorldsSceneStore((state) => state.setSelectedCollisionSurfaceId)
  const setTransformMode = useWorldsSceneStore((state) => state.setTransformMode)
  const clearTransformMode = useWorldsSceneStore((state) => state.clearTransformMode)
  const [unsupportedItems, setUnsupportedItems] = useState<WorldsViewerUnsupportedItem[]>([])
  const [loadingAssets, setLoadingAssets] = useState(false)
  const [openingAsset, setOpeningAsset] = useState(false)
  const [savingScene, setSavingScene] = useState(false)
  const [importingScene, setImportingScene] = useState(false)
  const [sceneStatus, setSceneStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const normalizedSceneItems = Array.isArray(sceneItems) ? sceneItems : []
  const normalizedCollisionSurfaces = Array.isArray(collisionSurfaces) ? collisionSurfaces : []
  const normalizedSelectedSceneItemIds = Array.isArray(selectedSceneItemIds)
    ? selectedSceneItemIds.filter((itemId): itemId is string => typeof itemId === 'string' && itemId.length > 0)
    : []

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

      const nextAssets = normalizeWorldAssetLibraryAssets(result.assets)
      if (!nextAssets) {
        setError('Workspace asset-library returned an invalid assets payload.')
        setAssets([])
        setSelectedAssetId(null)
        return
      }

      setAssets(nextAssets)
      setSelectedAssetId((current) => current && nextAssets.some((asset) => asset.id === current)
        ? current
        : nextAssets.find((asset) => asset.openable)?.id ?? nextAssets[0]?.id ?? null)
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
          const appended = appendWorldSceneItem(sceneState.sceneItems, result.asset.item, {
            sceneItemAnchors: sceneState.sceneItemAnchors,
            selectedSceneItemId: sceneState.selectedSceneItemId,
          })
          setWorldScene({
            ...appended,
            collisionSurfaces: sceneState.collisionSurfaces,
            pendingSurfacePlacementItemId: shouldPendingWorldsSurfacePlacement(sceneState.sceneItems, result.asset.item)
              ? appended.selectedSceneItemId
              : null,
          })
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

  function attachPoseClipAsset(asset: Extract<WorldAssetLibraryRenderable, { poseClip: true }>): { sceneItems: WorldSceneItem[]; collisionSurfaces: WorldCollisionSurface[]; selectedSceneItemId: string | null; pendingSurfacePlacementItemId?: string | null } {
    const sceneState = useWorldsSceneStore.getState()
    const existingTarget = resolveWorldSceneItemForPoseClip(sceneState.sceneItems, asset.animation.sourceWorkspacePath, sceneState.selectedSceneItemId)
    if (existingTarget) {
      return {
        sceneItems: attachWorldSceneItemAnimation(sceneState.sceneItems, existingTarget.id, asset.animation),
        collisionSurfaces: sceneState.collisionSurfaces,
        selectedSceneItemId: existingTarget.id,
      }
    }

    if (asset.linkedItem) {
      const appended = appendWorldSceneItem(sceneState.sceneItems, { ...asset.linkedItem, animation: asset.animation }, {
        sceneItemAnchors: sceneState.sceneItemAnchors,
        selectedSceneItemId: sceneState.selectedSceneItemId,
      })
      return {
        ...appended,
        collisionSurfaces: sceneState.collisionSurfaces,
        pendingSurfacePlacementItemId: shouldPendingWorldsSurfacePlacement(sceneState.sceneItems, asset.linkedItem)
          ? appended.selectedSceneItemId
          : null,
      }
    }

    return {
      sceneItems: sceneState.sceneItems,
      collisionSurfaces: sceneState.collisionSurfaces,
      selectedSceneItemId: sceneState.selectedSceneItemId,
    }
  }

  async function saveSceneManifest(): Promise<void> {
      const sceneState = useWorldsSceneStore.getState()
      const currentItems = sceneState.sceneItems
      if (currentItems.length === 0 && sceneState.collisionSurfaces.length === 0) return

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
          manifest: buildWorldsSceneManifest(currentItems, sceneState.collisionSurfaces, {
            initialView: sceneState.initialView ?? undefined,
          }),
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
        collisionSurfaces: parsed.collisionSurfaces,
        selectedSceneItemId: parsed.sceneItems.find((item) => item.visible)?.id ?? null,
        pendingSurfacePlacementItemId: null,
        initialView: parsed.manifest.initialView ?? null,
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
    const visibleItemIds = new Set(normalizedSceneItems.filter((item) => item.visible).map((item) => item.id))
    const nextSelectedSceneItemIds = normalizedSelectedSceneItemIds.filter((itemId) => visibleItemIds.has(itemId))
    const nextSelectedSceneItemId = selectedSceneItemId && visibleItemIds.has(selectedSceneItemId)
      ? selectedSceneItemId
      : nextSelectedSceneItemIds.at(-1) ?? null

    if (nextSelectedSceneItemId === selectedSceneItemId && nextSelectedSceneItemIds.length === normalizedSelectedSceneItemIds.length) return

    setWorldScene({
      sceneItems: normalizedSceneItems,
      collisionSurfaces: normalizedCollisionSurfaces,
      selectedSceneItemId: nextSelectedSceneItemId,
      selectedSceneItemIds: nextSelectedSceneItemIds,
    })
    if (!nextSelectedSceneItemId && !selectedCollisionSurfaceId) clearTransformMode()
  }, [clearTransformMode, normalizedCollisionSurfaces, normalizedSceneItems, normalizedSelectedSceneItemIds, selectedCollisionSurfaceId, selectedSceneItemId, setWorldScene])

  useEffect(() => {
    const hasSelectedSurface = normalizedCollisionSurfaces.some((surface) => surface.id === selectedCollisionSurfaceId)
    if (selectedCollisionSurfaceId && !hasSelectedSurface) setSelectedCollisionSurfaceId(null)
    if (collisionEditMode && normalizedCollisionSurfaces.length === 0) setCollisionEditMode(false)
  }, [collisionEditMode, normalizedCollisionSurfaces, selectedCollisionSurfaceId, setCollisionEditMode, setSelectedCollisionSurfaceId])

  return (
      <WorldsPageView
        selectorOpen={selectorOpen}
        assets={assets}
        selectedAssetId={selectedAssetId}
        selectedSceneItemId={selectedSceneItemId}
        selectedSceneItemIds={normalizedSelectedSceneItemIds}
        pendingSurfacePlacementItemId={pendingSurfacePlacementItemId}
        collisionEditMode={collisionEditMode}
        selectedCollisionSurfaceId={selectedCollisionSurfaceId}
        transformMode={transformMode}
        sceneItems={normalizedSceneItems}
        collisionSurfaces={normalizedCollisionSurfaces}
        initialView={initialView ?? undefined}
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
        if (!itemId && !selectedCollisionSurfaceId) setTransformMode(null)
      }}
      onTransformModeChange={setTransformMode}
      onTransformSceneItem={(itemId, transform) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: updateWorldSceneItemTransform(state.sceneItems, itemId, transform),
          collisionSurfaces: state.collisionSurfaces,
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
        })
      }}
      onTransformSceneItems={(updates) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: updateWorldSceneItemTransforms(state.sceneItems, updates),
          collisionSurfaces: state.collisionSurfaces,
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
        })
      }}
      onAddCollisionSurface={(preset) => {
        const state = useWorldsSceneStore.getState()
        const next = addWorldCollisionSurface(state.collisionSurfaces, preset, {
          anchorTransform: resolveWorldCollisionSurfacePlacementTransform(state.collisionSurfaces, state.sceneItems, {
            selectedCollisionSurfaceId: state.selectedCollisionSurfaceId,
            selectedSceneItemId: state.selectedSceneItemId,
            sceneItemAnchors: state.sceneItemAnchors,
          }),
        })
        setWorldScene({
          sceneItems: state.sceneItems,
          collisionSurfaces: next.surfaces,
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
        })
        setCollisionEditMode(true)
        setSelectedCollisionSurfaceId(next.selectedSurfaceId)
      }}
      onCollisionEditModeChange={(enabled) => {
        setCollisionEditMode(enabled)
        if (!enabled) setSelectedCollisionSurfaceId(null)
      }}
      onSelectCollisionSurface={setSelectedCollisionSurfaceId}
      onTransformCollisionSurface={(surfaceId, transform) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: state.sceneItems,
          collisionSurfaces: updateWorldCollisionSurfaceTransform(state.collisionSurfaces, surfaceId, transform),
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
        })
      }}
      onRemoveCollisionSurface={(surfaceId) => {
        const state = useWorldsSceneStore.getState()
        const next = removeWorldCollisionSurface(state.collisionSurfaces, surfaceId)
        setWorldScene({
          sceneItems: state.sceneItems,
          collisionSurfaces: next.surfaces,
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
        })
        setSelectedCollisionSurfaceId(next.selectedSurfaceId)
        if (!next.selectedSurfaceId) setTransformMode(null)
      }}
      onAnimationMetadata={(itemId, animation) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: attachWorldSceneItemAnimation(state.sceneItems, itemId, animation),
          collisionSurfaces: state.collisionSurfaces,
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
        })
      }}
      onRemoveSceneItem={(itemId) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          ...removeWorldSceneItem(state.sceneItems, itemId),
          collisionSurfaces: state.collisionSurfaces,
        })
        if (!state.selectedCollisionSurfaceId) clearTransformMode()
      }}
      onToggleBaseSceneItem={(itemId) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: toggleWorldSceneItemBaseRole(state.sceneItems, itemId),
          collisionSurfaces: state.collisionSurfaces,
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
          pendingSurfacePlacementItemId: state.pendingSurfacePlacementItemId === itemId ? null : undefined,
        })
      }}
      onSceneItemAnchorChange={setSceneItemAnchor}
      onCommitPendingSurfacePlacement={(itemId, transform) => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: updateWorldSceneItemTransform(state.sceneItems, itemId, transform),
          collisionSurfaces: state.collisionSurfaces,
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
          pendingSurfacePlacementItemId: null,
        })
      }}
      onClearPendingSurfacePlacement={() => {
        const state = useWorldsSceneStore.getState()
        setWorldScene({
          sceneItems: state.sceneItems,
          collisionSurfaces: state.collisionSurfaces,
          selectedSceneItemId: state.selectedSceneItemId,
          selectedSceneItemIds: state.selectedSceneItemIds,
          pendingSurfacePlacementItemId: null,
        })
      }}
      onOpenSelected={() => void openSelectedAsset()}
      onSaveScene={() => void saveSceneManifest()}
      onImportScene={() => void importSceneManifest()}
    />
  )
}
