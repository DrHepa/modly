import type {
  AssetCapability,
  AssetEntryState,
  AssetLibraryManifestRef,
  AssetLibraryPreviewKind,
  AssetLibrarySourceLink,
  AssetLibrarySourceScope,
} from '../types/assetLibrary.ts'

export interface WorkspaceAssetLibraryEntry {
  id: string
  workspacePath: string
  displayName: string
  createdAt?: string
  updatedAt?: string
  sourceScope: AssetLibrarySourceScope
  capability?: AssetCapability
  state: AssetEntryState
  previewKind: AssetLibraryPreviewKind
  warnings: string[]
  source?: AssetLibrarySourceLink
  manifest?: AssetLibraryManifestRef
}

export interface WorkspaceAssetLibraryToggleButtonProps {
  open: boolean
  disabled?: boolean
  label?: string
  onToggle: () => void
}

export interface WorkspaceAssetLibraryCopy {
  dialogLabel?: string
  title?: string
  description?: string
  closeLabel?: string
  refreshLabel?: string
  loadingLabel?: string
  searchLabel?: string
  searchPlaceholder?: string
  listLabel?: string
  selectPrompt?: string
  emptyLabel?: string
  emptyCategorizedLabel?: string
  openButtonLabel?: string
  openingLabel?: string
  noSearchResultsLabel?: (searchQuery: string) => string
}

export interface WorkspaceAssetLibraryPopoverProps<Entry extends WorkspaceAssetLibraryEntry = WorkspaceAssetLibraryEntry> {
  entries: Entry[]
  selectedEntryId: string | null
  loading: boolean
  opening: boolean
  error: string | null
  searchQuery: string
  sortMode?: WorkspaceAssetLibrarySortMode
  copy?: WorkspaceAssetLibraryCopy
  onSelectEntry: (entryId: string) => void
  onSearchQueryChange: (value: string) => void
  onSortModeChange?: (sortMode: WorkspaceAssetLibrarySortMode) => void
  onOpenSelected: () => void
  onRefresh: () => void
  collapsedSectionKeys: string[]
  onToggleSection: (sectionKey: string) => void
  onClose: () => void
  isEntryOpenable?: (entry: Entry) => boolean
  describeEntryOpenability?: (entry: Entry) => string
  isEntryVisible?: (entry: Entry) => boolean
}

interface WorkspaceAssetLibraryEntryGroup<Entry extends WorkspaceAssetLibraryEntry> {
  capability: NonNullable<Entry['capability']>
  capabilityLabel: string
  sectionKey: string
  entries: Entry[]
}

interface WorkspaceAssetLibrarySourceScopeGroup<Entry extends WorkspaceAssetLibraryEntry> {
  sourceScope: Entry['sourceScope']
  sourceScopeLabel: string
  sectionKey: string
  entryGroups: Array<WorkspaceAssetLibraryEntryGroup<Entry>>
}

export type WorkspaceAssetLibrarySortMode = 'type' | 'name' | 'date'

const WORKSPACE_ASSET_LIBRARY_CAPABILITY_SECTIONS = [
  { capability: 'mesh', label: 'Mesh' },
  { capability: 'rigged-mesh', label: 'Rigged mesh' },
  { capability: 'animation-motion', label: 'Animations/motions' },
  { capability: 'landmarks-sidecar', label: 'Landmarks sidecars' },
  { capability: 'generated-world', label: 'Generated worlds' },
  { capability: 'scene-manifest', label: 'Scene manifests' },
] as const satisfies ReadonlyArray<{ capability: AssetCapability, label: string }>

const WORKSPACE_ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS = [
  { sourceScope: 'workflows', label: 'Workflows' },
  { sourceScope: 'exports', label: 'Exports' },
] as const satisfies ReadonlyArray<{ sourceScope: AssetLibrarySourceScope, label: string }>

const WORKSPACE_ASSET_LIBRARY_SORT_OPTIONS = [
  { value: 'type', label: 'Type' },
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Date' },
] as const satisfies ReadonlyArray<{ value: WorkspaceAssetLibrarySortMode, label: string }>

const WORKSPACE_ASSET_LIBRARY_CAPABILITY_ORDER = new Map(
  WORKSPACE_ASSET_LIBRARY_CAPABILITY_SECTIONS.map((section, index) => [section.capability, index]),
)

const WORKSPACE_ASSET_LIBRARY_INTERNAL_DIRECTORY_NAMES = new Set(['tmp', 'temp', 'cache'])

const DEFAULT_COPY = {
  dialogLabel: 'Workspace library',
  title: 'Workspace library',
  description: 'Select a workspace asset and open the supported source in Generate.',
  closeLabel: 'Close library',
  refreshLabel: 'Refresh assets',
  loadingLabel: 'Loading workspace assets…',
  searchLabel: 'Search workspace assets',
  searchPlaceholder: 'Search by name, path, scope, or capability',
  listLabel: 'Workspace library assets',
  selectPrompt: 'Select an asset to open it in Generate.',
  emptyLabel: 'No workspace assets are indexed yet.',
  emptyCategorizedLabel: 'No categorized workspace assets are available yet.',
  openButtonLabel: 'Open selected asset',
  openingLabel: 'Opening…',
  noSearchResultsLabel: (searchQuery: string) => `No workspace assets match “${searchQuery.trim()}”.`,
} as const satisfies Required<WorkspaceAssetLibraryCopy>

export function getDefaultWorkspaceAssetLibraryCollapsedSectionKeys(): string[] {
  const sectionKeys = WORKSPACE_ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS.flatMap((scopeSection) => {
    const capabilityKeys = WORKSPACE_ASSET_LIBRARY_CAPABILITY_SECTIONS.map(
      (capabilitySection) => `capability:${scopeSection.sourceScope}:${capabilitySection.capability}`,
    )

    return [`scope:${scopeSection.sourceScope}`, ...capabilityKeys]
  })

  return [...sectionKeys]
}

export const getDefaultAssetLibraryCollapsedSectionKeys = getDefaultWorkspaceAssetLibraryCollapsedSectionKeys
export type AssetLibrarySortMode = WorkspaceAssetLibrarySortMode

export function WorkspaceAssetLibraryToggleButton({
  open,
  disabled = false,
  label = 'Library',
  onToggle,
}: WorkspaceAssetLibraryToggleButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:pointer-events-none
        ${open
          ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
          : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
        }`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h10" />
      </svg>
      {label}
    </button>
  )
}

export const AssetLibraryToggleButton = WorkspaceAssetLibraryToggleButton

export function WorkspaceAssetLibraryPopover<Entry extends WorkspaceAssetLibraryEntry = WorkspaceAssetLibraryEntry>({
  entries,
  selectedEntryId,
  loading,
  opening,
  error,
  searchQuery = '',
  sortMode = 'type',
  copy,
  onSelectEntry,
  onSearchQueryChange,
  onSortModeChange = () => undefined,
  onOpenSelected,
  onRefresh,
  collapsedSectionKeys = getDefaultWorkspaceAssetLibraryCollapsedSectionKeys(),
  onToggleSection,
  onClose,
  isEntryOpenable = defaultWorkspaceAssetLibraryEntryOpenability,
  describeEntryOpenability = describeDefaultWorkspaceAssetLibraryOpenability,
  isEntryVisible = defaultWorkspaceAssetLibraryEntryVisibility,
}: WorkspaceAssetLibraryPopoverProps<Entry>): JSX.Element {
  const resolvedCopy = { ...DEFAULT_COPY, ...copy }
  const visibleEntries = entries.filter(isEntryVisible)
  const scopeGroups = filterWorkspaceAssetLibraryScopeGroups(visibleEntries, searchQuery, sortMode)
  const visibleEntryIds = new Set(scopeGroups.flatMap((scopeGroup) => scopeGroup.entryGroups.flatMap((group) => group.entries.map((entry) => entry.id))))
  const selectedEntry = selectedEntryId && (visibleEntryIds.has(selectedEntryId) || visibleEntries.some((entry) => entry.id === selectedEntryId))
    ? visibleEntries.find((entry) => entry.id === selectedEntryId) ?? null
    : null
  const normalizedSearchQuery = normalizeWorkspaceAssetLibrarySearchQuery(searchQuery)
  const noSearchResultsMessage = resolvedCopy.noSearchResultsLabel(searchQuery)
  const openDisabled = !selectedEntry || !isEntryOpenable(selectedEntry) || loading || opening
  const selectedMessage = selectedEntry
    ? describeEntryOpenability(selectedEntry)
    : scopeGroups.length === 0 && normalizedSearchQuery
      ? noSearchResultsMessage
      : resolvedCopy.selectPrompt

  return (
    <div
      role="dialog"
      aria-label={resolvedCopy.dialogLabel}
      className="absolute top-full left-0 mt-1 z-50 w-[320px] max-w-[calc(100vw-2rem)] bg-zinc-900 border border-zinc-700/60 rounded-xl p-3 flex flex-col gap-3 shadow-xl"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{resolvedCopy.title}</p>
          <p className="text-xs text-zinc-300">{resolvedCopy.description}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
        >
          {resolvedCopy.closeLabel}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || opening}
          className="px-2.5 py-1.5 text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:pointer-events-none rounded-lg transition-colors"
        >
          {resolvedCopy.refreshLabel}
        </button>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="asset-library-search" className="text-[11px] text-zinc-300">
            {resolvedCopy.searchLabel}
          </label>
          <input
            id="asset-library-search"
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder={resolvedCopy.searchPlaceholder}
            className="bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          />
        </div>

        <div className="flex w-24 shrink-0 flex-col gap-1.5">
          <label htmlFor="asset-library-sort" className="text-[11px] text-zinc-300">
            Sort
          </label>
          <select
            id="asset-library-sort"
            value={sortMode}
            onChange={(event) => onSortModeChange(event.target.value as WorkspaceAssetLibrarySortMode)}
            className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          >
            {WORKSPACE_ASSET_LIBRARY_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <p role="status" className="text-xs text-zinc-400">{resolvedCopy.loadingLabel}</p>
      ) : visibleEntries.length === 0 && !normalizedSearchQuery ? (
        <p role="status" className="text-xs text-zinc-500">{resolvedCopy.emptyLabel}</p>
      ) : scopeGroups.length === 0 && normalizedSearchQuery ? (
        <p role="status" className="text-xs text-zinc-500">{noSearchResultsMessage}</p>
      ) : scopeGroups.length === 0 ? (
        <p role="status" className="text-xs text-zinc-500">{resolvedCopy.emptyCategorizedLabel}</p>
      ) : (
        <div role="list" aria-label={resolvedCopy.listLabel} className="max-h-64 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/40">
          {scopeGroups.map((scopeGroup) => {
            const scopeExpanded = !collapsedSectionKeys.includes(scopeGroup.sectionKey)
            const scopeRegionId = `asset-library-${scopeGroup.sectionKey.replace(/[^a-z0-9-]+/gi, '-')}`
            return (
              <section key={scopeGroup.sectionKey} role="group" aria-label={`Source scope ${scopeGroup.sourceScopeLabel}`} className="border-b border-zinc-800 last:border-b-0">
                <button
                  type="button"
                  aria-expanded={scopeExpanded}
                  aria-controls={scopeRegionId}
                  aria-label={`Toggle ${scopeGroup.sourceScopeLabel} assets`}
                  onClick={() => onToggleSection(scopeGroup.sectionKey)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-300">{scopeGroup.sourceScopeLabel}</span>
                  <span className="text-[10px] text-zinc-500">{scopeExpanded ? 'Hide' : 'Show'}</span>
                </button>

                {scopeExpanded && (
                  <div id={scopeRegionId}>
                    {scopeGroup.entryGroups.map((group) => {
                      const capabilityExpanded = !collapsedSectionKeys.includes(group.sectionKey)
                      const capabilityRegionId = `asset-library-${group.sectionKey.replace(/[^a-z0-9-]+/gi, '-')}`

                      return (
                        <section key={group.sectionKey} role="group" aria-label={`Capability category ${group.capabilityLabel}`} className="border-t border-zinc-800 first:border-t-0">
                          <button
                            type="button"
                            aria-expanded={capabilityExpanded}
                            aria-controls={capabilityRegionId}
                            aria-label={`Toggle ${group.capabilityLabel} assets in ${scopeGroup.sourceScopeLabel}`}
                            onClick={() => onToggleSection(group.sectionKey)}
                            className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
                          >
                            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-400">{group.capabilityLabel}</span>
                            <span className="text-[10px] text-zinc-500">{capabilityExpanded ? 'Hide' : 'Show'}</span>
                          </button>

                          {capabilityExpanded && (
                            <div id={capabilityRegionId}>
                              {group.entries.map((entry) => {
                                const selected = entry.id === selectedEntryId
                                return (
                                  <button
                                    key={entry.id}
                                    type="button"
                                    role="listitem"
                                    aria-pressed={selected}
                                    aria-label={`Select library asset ${entry.displayName}`}
                                    onClick={() => onSelectEntry(entry.id)}
                                    className={`w-full text-left px-4 py-2 border-t border-zinc-800 first:border-t-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400
                                      ${selected
                                        ? 'bg-violet-500/10 text-zinc-100'
                                        : 'text-zinc-300 hover:bg-zinc-800/80'
                                      }`}
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="text-xs font-medium">{entry.displayName}</span>
                                      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{formatWorkspaceAssetLibraryBadge(entry)}</span>
                                    </div>
                                  </button>
                                )
                              })}
                            </div>
                          )}
                        </section>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
        <p className="text-[11px] text-zinc-400">{selectedMessage}</p>
        {error && (
          <p role="alert" className="mt-2 text-[11px] text-amber-300">{error}</p>
        )}
      </div>

      <button
        type="button"
        onClick={onOpenSelected}
        disabled={openDisabled}
        aria-label={resolvedCopy.openButtonLabel}
        className="px-3 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs rounded-lg transition-colors font-medium"
      >
        {opening ? resolvedCopy.openingLabel : resolvedCopy.openButtonLabel}
      </button>
    </div>
  )
}

export const AssetLibraryPopover = WorkspaceAssetLibraryPopover

export function defaultWorkspaceAssetLibraryEntryVisibility(entry: WorkspaceAssetLibraryEntry): boolean {
  return entry.state !== 'unsupported' && !hasInternalWorkspaceAssetLibraryDirectory(entry.workspacePath)
}

export function defaultWorkspaceAssetLibraryEntryOpenability(entry: WorkspaceAssetLibraryEntry): boolean {
  const openTarget = (entry as WorkspaceAssetLibraryEntry & { openTarget?: { kind: string } }).openTarget
  return entry.state === 'ready' && openTarget?.kind !== 'unavailable'
}

export function describeDefaultWorkspaceAssetLibraryOpenability(entry: WorkspaceAssetLibraryEntry): string {
  const openTarget = (entry as WorkspaceAssetLibraryEntry & { openTarget?: { kind: string, reason?: string } }).openTarget

  if (entry.state === 'unknown-metadata') return 'Missing metadata prevents a safe open in Generate.'
  if (entry.state === 'unsafe') return 'This asset was rejected because its workspace path is unsafe.'
  if (entry.state === 'unsupported') return 'This asset is tracked in the library but is not supported in Generate.'
  if (openTarget?.kind === 'self') return 'Ready to open this asset directly in Generate.'
  if (openTarget?.kind === 'linked-source') return 'Generate opens the linked source mesh for this sidecar asset.'
  if (openTarget?.kind === 'unavailable') {
    if (openTarget.reason === 'capability-not-viewable') {
      if (entry.capability === 'mesh' || entry.capability === 'rigged-mesh') {
        return 'This asset is tracked as a mesh in the library, but this format cannot open directly in Generate yet.'
      }
      return 'This capability is tracked in the library but cannot open in Generate yet.'
    }
    if (openTarget.reason === 'missing-source-link') return 'This asset needs a valid source mesh before it can open in Generate.'
    if (openTarget.reason === 'missing-capability') return 'This asset is missing a supported capability classification.'
  }
  return 'Ready to open this asset directly in Generate.'
}

export function filterWorkspaceAssetLibraryScopeGroups<Entry extends WorkspaceAssetLibraryEntry>(
  entries: Entry[],
  searchQuery: string,
  sortMode: WorkspaceAssetLibrarySortMode,
): Array<WorkspaceAssetLibrarySourceScopeGroup<Entry>> {
  const normalizedSearchQuery = normalizeWorkspaceAssetLibrarySearchQuery(searchQuery)
  const scopeGroups: Array<WorkspaceAssetLibrarySourceScopeGroup<Entry>> = []

  for (const scopeSection of WORKSPACE_ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS) {
    const scopeEntries = entries.filter((entry) => entry.sourceScope === scopeSection.sourceScope)
    const scopeMatches = normalizedSearchQuery.length > 0 && matchesWorkspaceAssetLibrarySearch(scopeSection.label, normalizedSearchQuery)
    const entryGroups: Array<WorkspaceAssetLibraryEntryGroup<Entry>> = []

    for (const capabilitySection of WORKSPACE_ASSET_LIBRARY_CAPABILITY_SECTIONS) {
      const capabilityEntries = scopeEntries.filter((entry) => entry.capability === capabilitySection.capability)
      if (capabilityEntries.length === 0) continue

      const capabilityMatches = scopeMatches || (normalizedSearchQuery.length > 0 && matchesWorkspaceAssetLibrarySearch(capabilitySection.label, normalizedSearchQuery))
      const visibleCapabilityEntries = !normalizedSearchQuery || capabilityMatches
        ? capabilityEntries
        : capabilityEntries.filter((entry) => matchesWorkspaceAssetLibraryEntrySearch(entry, normalizedSearchQuery))

      if (visibleCapabilityEntries.length === 0) continue

      entryGroups.push({
        capability: capabilitySection.capability,
        capabilityLabel: capabilitySection.label,
        sectionKey: `capability:${scopeSection.sourceScope}:${capabilitySection.capability}`,
        entries: sortWorkspaceAssetLibraryEntries(visibleCapabilityEntries, sortMode),
      })
    }

    const sortedEntryGroups = sortMode === 'type'
      ? entryGroups
      : [...entryGroups].sort((left, right) => compareWorkspaceAssetLibraryEntryGroups(left, right, sortMode))

    if (sortedEntryGroups.length === 0) continue

    scopeGroups.push({
      sourceScope: scopeSection.sourceScope,
      sourceScopeLabel: scopeSection.label,
      sectionKey: `scope:${scopeSection.sourceScope}`,
      entryGroups: sortedEntryGroups,
    })
  }

  return scopeGroups
}

export function sortWorkspaceAssetLibraryEntries<Entry extends WorkspaceAssetLibraryEntry>(
  entries: Entry[],
  sortMode: WorkspaceAssetLibrarySortMode,
): Entry[] {
  return [...entries].sort((left, right) => compareWorkspaceAssetLibraryEntries(left, right, sortMode))
}

function compareWorkspaceAssetLibraryEntryGroups<Entry extends WorkspaceAssetLibraryEntry>(
  left: WorkspaceAssetLibraryEntryGroup<Entry>,
  right: WorkspaceAssetLibraryEntryGroup<Entry>,
  sortMode: Exclude<WorkspaceAssetLibrarySortMode, 'type'>,
): number {
  const entryComparison = compareWorkspaceAssetLibraryEntries(left.entries[0], right.entries[0], sortMode)
  if (entryComparison !== 0) return entryComparison

  return (WORKSPACE_ASSET_LIBRARY_CAPABILITY_ORDER.get(left.capability) ?? Number.MAX_SAFE_INTEGER)
    - (WORKSPACE_ASSET_LIBRARY_CAPABILITY_ORDER.get(right.capability) ?? Number.MAX_SAFE_INTEGER)
}

function compareWorkspaceAssetLibraryEntries(
  left: WorkspaceAssetLibraryEntry,
  right: WorkspaceAssetLibraryEntry,
  sortMode: WorkspaceAssetLibrarySortMode,
): number {
  if (sortMode === 'date') {
    const leftTime = resolveWorkspaceAssetLibrarySortTimestamp(left)
    const rightTime = resolveWorkspaceAssetLibrarySortTimestamp(right)

    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return rightTime - leftTime
    }
    if (leftTime !== null && rightTime === null) return -1
    if (leftTime === null && rightTime !== null) return 1
  }

  return compareWorkspaceAssetLibraryEntryNames(left, right)
}

function compareWorkspaceAssetLibraryEntryNames(
  left: WorkspaceAssetLibraryEntry,
  right: WorkspaceAssetLibraryEntry,
): number {
  const displayNameComparison = left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' })
  if (displayNameComparison !== 0) return displayNameComparison

  const workspacePathComparison = left.workspacePath.localeCompare(right.workspacePath, undefined, { sensitivity: 'base' })
  if (workspacePathComparison !== 0) return workspacePathComparison

  return left.id.localeCompare(right.id, undefined, { sensitivity: 'base' })
}

function resolveWorkspaceAssetLibrarySortTimestamp(entry: WorkspaceAssetLibraryEntry): number | null {
  return parseWorkspaceAssetLibrarySortTimestamp(entry.createdAt)
    ?? parseWorkspaceAssetLibrarySortTimestamp(entry.updatedAt)
}

function parseWorkspaceAssetLibrarySortTimestamp(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const epochMs = Date.parse(value)
  return Number.isFinite(epochMs) ? epochMs : null
}

function normalizeWorkspaceAssetLibrarySearchQuery(searchQuery: string): string {
  return searchQuery.trim().toLocaleLowerCase()
}

function matchesWorkspaceAssetLibraryEntrySearch(entry: WorkspaceAssetLibraryEntry, normalizedSearchQuery: string): boolean {
  return [
    entry.displayName,
    entry.workspacePath,
    entry.capability,
    entry.sourceScope,
    entry.source?.workspacePath,
    entry.manifest?.workspacePath,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => matchesWorkspaceAssetLibrarySearch(value, normalizedSearchQuery))
}

function matchesWorkspaceAssetLibrarySearch(value: string, normalizedSearchQuery: string): boolean {
  return value.toLocaleLowerCase().includes(normalizedSearchQuery)
}

function hasInternalWorkspaceAssetLibraryDirectory(workspacePath: string): boolean {
  const segments = workspacePath.replace(/\\/g, '/').trim().split('/').filter(Boolean)
  return segments.slice(1, -1).some((segment) => segment.startsWith('.') || WORKSPACE_ASSET_LIBRARY_INTERNAL_DIRECTORY_NAMES.has(segment.toLocaleLowerCase()))
}

function formatWorkspaceAssetLibraryBadge(entry: WorkspaceAssetLibraryEntry): string {
  if (entry.capability) return entry.capability
  return entry.state.replace(/-/g, ' ')
}
