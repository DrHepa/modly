import {
  WorkspaceAssetLibraryPopover,
  WorkspaceAssetLibraryToggleButton,
  type WorkspaceAssetLibrarySortMode,
} from '../../../shared/components/WorkspaceAssetLibrary.tsx'
import type { WorldAssetLibraryRenderable } from '../worldAssetLibraryService.ts'

export interface WorldAssetSelectorProps {
  open: boolean
  assets: WorldAssetLibraryRenderable[]
  selectedAssetId: string | null
  loading: boolean
  opening: boolean
  error: string | null
  searchQuery: string
  sortMode: WorkspaceAssetLibrarySortMode
  collapsedSectionKeys: string[]
  onToggle: () => void
  onClose: () => void
  onRefresh: () => void
  onSelectAsset: (assetId: string) => void
  onSearchQueryChange: (value: string) => void
  onSortModeChange: (sortMode: WorkspaceAssetLibrarySortMode) => void
  onToggleSection: (sectionKey: string) => void
  onOpenSelected: () => void
}

const WORLD_ASSET_LIBRARY_COPY = {
  dialogLabel: 'World asset selector',
  title: 'Workspace library',
  description: 'Select a workspace asset and open supported renderables in Worlds.',
  closeLabel: 'Close library',
  selectPrompt: 'Select an asset to open it in Worlds.',
  emptyLabel: 'No workspace assets are indexed yet.',
  emptyCategorizedLabel: 'No categorized world assets are available yet.',
  listLabel: 'World asset options',
} as const

export function WorldAssetSelector({
  open,
  assets,
  selectedAssetId,
  loading,
  opening,
  error,
  searchQuery,
  sortMode,
  collapsedSectionKeys,
  onToggle,
  onClose,
  onRefresh,
  onSelectAsset,
  onSearchQueryChange,
  onSortModeChange,
  onToggleSection,
  onOpenSelected,
}: WorldAssetSelectorProps): JSX.Element {
  return (
    <div className="relative">
      <WorkspaceAssetLibraryToggleButton
        open={open}
        label="Open asset"
        onToggle={onToggle}
      />

      {open ? (
        <WorkspaceAssetLibraryPopover
          entries={assets}
          selectedEntryId={selectedAssetId}
          loading={loading}
          opening={opening}
          error={error}
          searchQuery={searchQuery}
          sortMode={sortMode}
          copy={WORLD_ASSET_LIBRARY_COPY}
          onSelectEntry={onSelectAsset}
          onSearchQueryChange={onSearchQueryChange}
          onSortModeChange={onSortModeChange}
          onOpenSelected={onOpenSelected}
          onRefresh={onRefresh}
          collapsedSectionKeys={collapsedSectionKeys}
          onToggleSection={onToggleSection}
          onClose={onClose}
          isEntryOpenable={isWorldAssetOpenable}
          describeEntryOpenability={describeWorldAssetOpenability}
          isEntryVisible={isWorldAssetVisibleInLibrary}
        />
      ) : null}
    </div>
  )
}

export function isWorldAssetOpenable(asset: WorldAssetLibraryRenderable): boolean {
  return asset.openable
}

export function isWorldAssetVisibleInLibrary(asset: WorldAssetLibraryRenderable): boolean {
  return asset.state !== 'unsupported'
}

export function describeWorldAssetOpenability(asset: WorldAssetLibraryRenderable): string {
  if (asset.openable) return 'Ready to open in Worlds.'

  switch (asset.reason) {
    case 'unsafe':
      return 'This asset was rejected because its workspace path is unsafe.'
    case 'unavailable':
      return 'This workspace asset is unavailable in Worlds.'
    case 'unsupported-spz':
      return 'Gaussian splat assets are tracked in the library but cannot open in Worlds yet.'
    case 'unsupported-gaussian-ply':
      return 'Gaussian PLY assets are tracked in the library but cannot open in Worlds yet.'
    case 'unsupported-extension':
    default:
      return 'This asset is tracked in the library but is not supported in Worlds yet.'
  }
}

export default WorldAssetSelector
