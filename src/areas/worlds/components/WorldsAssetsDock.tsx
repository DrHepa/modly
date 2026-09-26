import { useMemo, useState } from 'react'

import {
  filterWorkspaceAssetLibraryScopeGroups,
  type WorkspaceAssetLibrarySortMode,
} from '../../../shared/components/WorkspaceAssetLibrary.tsx'
import { Tooltip } from '../../../shared/components/ui/Tooltip.tsx'
import {
  describeWorldAssetOpenability,
  isWorldAssetVisibleInLibrary,
} from './WorldAssetSelector.tsx'
import type { WorldAssetLibraryRenderable } from '../worldAssetLibraryService.ts'

export interface WorldsAssetsDockProps {
  assets: WorldAssetLibraryRenderable[]
  loading: boolean
  addingAssetId: string | null
  error: string | null
  onRefresh(): void
  onAddAsset(asset: WorldAssetLibraryRenderable): void
}

export function WorldsAssetsDock({
  assets,
  loading,
  addingAssetId,
  error,
  onRefresh,
  onAddAsset,
}: WorldsAssetsDockProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<WorkspaceAssetLibrarySortMode>('type')
  const visibleAssets = useMemo(() => assets.filter(isWorldAssetVisibleInLibrary), [assets])
  const audioAssets = useMemo(() => sortAudioAssets(
    visibleAssets.filter(isWorldAudioAsset).filter((asset) => matchesAudioQuery(asset, query)),
    sortMode,
  ), [query, sortMode, visibleAssets])
  const groups = useMemo(
    () => filterWorkspaceAssetLibraryScopeGroups(visibleAssets.filter((asset) => !isWorldAudioAsset(asset)), query, sortMode),
    [query, sortMode, visibleAssets],
  )

  return (
    <div className="worlds-dock-panel" aria-label="Assets library">
      <header className="worlds-dock-header">
        <div><span>Assets</span><small>{visibleAssets.length}</small></div>
        <Tooltip content="Refresh workspace assets">
          <button type="button" className="worlds-icon-button" aria-label="Refresh assets" disabled={loading} onClick={onRefresh}>↻</button>
        </Tooltip>
      </header>
      <div className="worlds-assets-filters">
        <label htmlFor="worlds-assets-search">Search</label>
        <input
          id="worlds-assets-search"
          type="search"
          value={query}
          placeholder="Name or path"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <label htmlFor="worlds-assets-sort">Sort</label>
        <select id="worlds-assets-sort" value={sortMode} onChange={(event) => setSortMode(event.currentTarget.value as WorkspaceAssetLibrarySortMode)}>
          <option value="type">Type</option>
          <option value="name">Name</option>
          <option value="date">Date</option>
        </select>
      </div>
      {error ? <p role="alert" className="worlds-inline-error">{error}</p> : null}
      {loading ? <p role="status" className="worlds-empty-copy">Loading…</p> : groups.length === 0 && audioAssets.length === 0 ? (
        <p className="worlds-empty-copy">No compatible assets</p>
      ) : (
        <div className="worlds-assets-list" aria-label="Workspace assets">
          {groups.flatMap((scope) => scope.entryGroups.map((group) => (
            <section key={group.sectionKey} className="worlds-assets-group" aria-label={`${scope.sourceScopeLabel} ${group.capabilityLabel}`}>
              <h3>{scope.sourceScopeLabel} · {group.capabilityLabel}</h3>
              {group.entries.map((asset) => {
                const compatibleModel = asset.openable && 'item' in asset
                const busy = addingAssetId === asset.id
                return (
                  <div
                    key={asset.id}
                    className={`worlds-asset-row${compatibleModel ? ' is-actionable' : ''}`}
                    aria-busy={busy || undefined}
                  >
                    <span className="worlds-asset-glyph" aria-hidden="true">{compatibleModel ? '⬡' : '—'}</span>
                    <span className="worlds-asset-copy"><strong>{asset.displayName}</strong><small>{asset.type}</small></span>
                    {compatibleModel ? (
                      <Tooltip content={`Add ${asset.displayName} to scene`}>
                        <button
                          type="button"
                          className="worlds-asset-add"
                          aria-label={busy ? `Adding ${asset.displayName}` : `Add ${asset.displayName} to scene`}
                          disabled={addingAssetId !== null}
                          onClick={() => onAddAsset(asset)}
                        >{busy ? '…' : '+'}</button>
                      </Tooltip>
                    ) : <span className="worlds-asset-state">{conciseUnavailable(asset)}</span>}
                  </div>
                )
              })}
            </section>
          )))}
          {audioAssets.length > 0 ? (
            <section className="worlds-assets-group" aria-label="Workspace audio">
              <h3>Workspace · Audio</h3>
              {audioAssets.map((asset) => {
                const busy = addingAssetId === asset.id
                return (
                  <div key={asset.id} className="worlds-asset-row is-actionable" aria-busy={busy || undefined}>
                    <span className="worlds-asset-glyph" aria-hidden="true">♪</span>
                    <span className="worlds-asset-copy"><strong>{asset.displayName}</strong><small>{asset.audioFormat.toUpperCase()}</small></span>
                    <Tooltip content={`Attach ${asset.displayName} to selected entity`}>
                      <button
                        type="button"
                        className="worlds-asset-add worlds-authoring-action"
                        aria-label={busy ? `Attaching ${asset.displayName}` : `Attach audio ${asset.displayName}`}
                        disabled={addingAssetId !== null}
                        onClick={() => onAddAsset(asset)}
                      >{busy ? '…' : 'Attach audio'}</button>
                    </Tooltip>
                  </div>
                )
              })}
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}

function isWorldAudioAsset(asset: WorldAssetLibraryRenderable): asset is Extract<WorldAssetLibraryRenderable, { audio: true }> {
  return asset.openable && 'audio' in asset && asset.audio === true
}

function matchesAudioQuery(asset: Extract<WorldAssetLibraryRenderable, { audio: true }>, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  return !normalized || `${asset.displayName}\n${asset.workspacePath}\n${asset.audioFormat}`.toLocaleLowerCase().includes(normalized)
}

function sortAudioAssets(
  assets: Array<Extract<WorldAssetLibraryRenderable, { audio: true }>>,
  sortMode: WorkspaceAssetLibrarySortMode,
): Array<Extract<WorldAssetLibraryRenderable, { audio: true }>> {
  return [...assets].sort((left, right) => {
    if (sortMode === 'date') return (right.updatedAt ?? right.createdAt ?? '').localeCompare(left.updatedAt ?? left.createdAt ?? '') || left.displayName.localeCompare(right.displayName)
    if (sortMode === 'type') return left.audioFormat.localeCompare(right.audioFormat) || left.displayName.localeCompare(right.displayName)
    return left.displayName.localeCompare(right.displayName)
  })
}

function conciseUnavailable(asset: WorldAssetLibraryRenderable): string {
  const detail = describeWorldAssetOpenability(asset)
  if (asset.openable) return detail.startsWith('Ready') ? 'Ready' : 'Unavailable'
  if (asset.reason === 'unsafe') return 'Unsafe path'
  if (asset.reason === 'unavailable') return 'Unavailable'
  return 'Unsupported'
}

export default WorldsAssetsDock
