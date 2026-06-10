import type { GenerationJob } from '../../shared/stores/appStore'
import { buildSceneImportGenerationJob } from './sceneImportAutomation.ts'
import { resolveViewerAssetTargetFromLibraryEntry, type ViewerAssetTarget } from './viewerAssetTarget.ts'
import type { AssetLibraryOpenRequest } from '../../shared/types/assetLibrary'
import type { RendererAssetLibraryEntry } from './assetLibraryProjection.ts'

export type GenerateOpenPanel = 'export' | 'decimate' | 'smooth' | 'import' | 'library' | 'light' | null
export type AssetLibrarySortMode = 'type' | 'name' | 'date'

export interface AssetLibraryEntryGroup {
  capability: RendererAssetLibraryEntry['capability']
  capabilityLabel: string
  sectionKey: string
  entries: RendererAssetLibraryEntry[]
}

export interface AssetLibrarySourceScopeGroup {
  sourceScope: RendererAssetLibraryEntry['sourceScope']
  sourceScopeLabel: string
  sectionKey: string
  entryGroups: AssetLibraryEntryGroup[]
}

export interface AssetLibraryOpenSelection {
  historyUrl: string
  target: Extract<ViewerAssetTarget, { kind: 'final' }>
  job: GenerationJob
}

const ASSET_LIBRARY_CAPABILITY_SECTIONS = [
  { capability: 'mesh', label: 'Mesh' },
  { capability: 'rigged-mesh', label: 'Rigged mesh' },
  { capability: 'animation-motion', label: 'Animations/motions' },
  { capability: 'landmarks-sidecar', label: 'Landmarks sidecars' },
  { capability: 'generated-world', label: 'Generated worlds' },
  { capability: 'scene-manifest', label: 'Scene manifests' },
  { capability: undefined, label: 'Unknown metadata' },
] as const satisfies ReadonlyArray<{ capability: RendererAssetLibraryEntry['capability'], label: string }>

const ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS = [
  { sourceScope: 'workflows', label: 'Workflows' },
  { sourceScope: 'exports', label: 'Exports' },
] as const satisfies ReadonlyArray<{ sourceScope: RendererAssetLibraryEntry['sourceScope'], label: string }>

const ASSET_LIBRARY_CAPABILITY_ORDER = new Map<RendererAssetLibraryEntry['capability'], number>(
  ASSET_LIBRARY_CAPABILITY_SECTIONS.map((section, index) => [section.capability, index]),
)

const ASSET_LIBRARY_INTERNAL_DIRECTORY_NAMES = new Set(['tmp', 'temp', 'cache'])

export const ASSET_LIBRARY_SORT_OPTIONS = [
  { value: 'type', label: 'Type' },
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Date' },
] as const satisfies ReadonlyArray<{ value: AssetLibrarySortMode, label: string }>

export function getDefaultAssetLibraryCollapsedSectionKeys(): string[] {
  const sectionKeys = ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS.flatMap((scopeSection) => {
    const capabilityKeys = ASSET_LIBRARY_CAPABILITY_SECTIONS.map(
      (capabilitySection) => `capability:${scopeSection.sourceScope}:${capabilitySection.capability}`,
    )

    return [`scope:${scopeSection.sourceScope}`, ...capabilityKeys]
  })

  return [...sectionKeys]
}

export function toggleAssetLibrarySectionKey(currentKeys: string[], sectionKey: string): string[] {
  return currentKeys.includes(sectionKey)
    ? currentKeys.filter((value) => value !== sectionKey)
    : [...currentKeys, sectionKey]
}

export function buildAssetLibraryOpenRequest(entry: RendererAssetLibraryEntry): AssetLibraryOpenRequest {
  return {
    workspacePath: entry.workspacePath,
    ...(entry.openTarget.kind === 'linked-source' ? { sourceWorkspacePath: entry.openTarget.workspacePath } : {}),
  }
}

export function isAssetLibraryEntryOpenable(entry: RendererAssetLibraryEntry | null | undefined): entry is RendererAssetLibraryEntry {
  return Boolean(entry && entry.state === 'ready' && entry.openTarget.kind !== 'unavailable')
}

export function describeAssetLibraryOpenability(entry: RendererAssetLibraryEntry): string {
  if (entry.state === 'unknown-metadata') return 'Missing metadata prevents a safe open in Generate.'
  if (entry.state === 'unsupported') return 'This asset is tracked in the library but is not supported in Generate.'
  if (entry.state === 'unsafe') return 'This asset was rejected because its workspace path is unsafe.'

  switch (entry.openTarget.kind) {
    case 'self':
      return 'Ready to open this asset directly in Generate.'
    case 'linked-source':
      return 'Generate opens the linked source mesh for this sidecar asset.'
    case 'unavailable':
      switch (entry.openTarget.reason) {
        case 'capability-not-viewable':
          if (entry.capability === 'mesh' || entry.capability === 'rigged-mesh') {
            return 'This asset is tracked as a mesh in the library, but this format cannot open directly in Generate yet.'
          }
          return 'This capability is tracked in the library but cannot open in Generate yet.'
        case 'missing-source-link':
          return 'This asset needs a valid source mesh before it can open in Generate.'
        case 'missing-capability':
          return 'This asset is missing a supported capability classification.'
        case 'unsafe-entry':
          return 'This asset was rejected because its workspace path is unsafe.'
        case 'state-not-openable':
        default:
          return 'This asset is not openable in Generate.'
      }
  }
}

export function filterVisibleAssetLibraryEntries(entries: RendererAssetLibraryEntry[]): RendererAssetLibraryEntry[] {
  return entries.filter((entry) => entry.state !== 'unsupported' && !hasInternalAssetLibraryDirectory(entry.workspacePath))
}

export function filterAssetLibraryScopeGroups(
  entries: RendererAssetLibraryEntry[],
  searchQuery: string,
  sortMode: AssetLibrarySortMode,
): AssetLibrarySourceScopeGroup[] {
  const normalizedSearchQuery = normalizeAssetLibrarySearchQuery(searchQuery)
  const visibleEntries = filterVisibleAssetLibraryEntries(entries)

  return ASSET_LIBRARY_SOURCE_SCOPE_SECTIONS
    .map((scopeSection): AssetLibrarySourceScopeGroup | null => {
      const scopeEntries = visibleEntries.filter((entry) => entry.sourceScope === scopeSection.sourceScope)
      const scopeMatches = normalizedSearchQuery.length > 0 && matchesAssetLibrarySearch(scopeSection.label, normalizedSearchQuery)

      const entryGroups = ASSET_LIBRARY_CAPABILITY_SECTIONS
        .map((capabilitySection): AssetLibraryEntryGroup | null => {
          const capabilityEntries = scopeEntries.filter((entry) => entry.capability === capabilitySection.capability)
          if (capabilityEntries.length === 0) return null

          const capabilityMatches = scopeMatches || (normalizedSearchQuery.length > 0 && matchesAssetLibrarySearch(capabilitySection.label, normalizedSearchQuery))
          const visibleCapabilityEntries = !normalizedSearchQuery || capabilityMatches
            ? capabilityEntries
            : capabilityEntries.filter((entry) => matchesAssetLibraryEntrySearch(entry, normalizedSearchQuery))

          if (visibleCapabilityEntries.length === 0) return null

          return {
            capability: capabilitySection.capability,
            capabilityLabel: capabilitySection.label,
            sectionKey: `capability:${scopeSection.sourceScope}:${capabilitySection.capability}`,
            entries: sortAssetLibraryEntries(visibleCapabilityEntries, sortMode),
          }
        })
        .filter((group): group is AssetLibraryEntryGroup => group !== null)

      const sortedEntryGroups = sortMode === 'type'
        ? entryGroups
        : [...entryGroups].sort((left, right) => compareAssetLibraryEntryGroups(left, right, sortMode))

      if (sortedEntryGroups.length === 0) return null
      return {
        sourceScope: scopeSection.sourceScope,
        sourceScopeLabel: scopeSection.label,
        sectionKey: `scope:${scopeSection.sourceScope}`,
        entryGroups: sortedEntryGroups,
      }
    })
    .filter((group): group is AssetLibrarySourceScopeGroup => group !== null)
}

export function resolveAssetLibraryOpenSelection(
  entry: RendererAssetLibraryEntry,
  apiUrl: string,
  now = Date.now(),
): AssetLibraryOpenSelection | null {
  const target = resolveViewerAssetTargetFromLibraryEntry(entry, apiUrl)
  if (target.kind !== 'final') return null

  const historyUrl = target.workspacePath ? `/workspace/${target.workspacePath.split('/').map(encodeURIComponent).join('/')}` : target.modelUrl
  return {
    historyUrl,
    target,
    job: buildSceneImportGenerationJob({
      meshPath: target.workspacePath ?? entry.workspacePath,
      url: historyUrl,
      displayName: entry.displayName,
    }, now),
  }
}

export function resolveOpenPanelAfterLibrarySelection(currentPanel: GenerateOpenPanel): GenerateOpenPanel {
  return currentPanel === 'library' ? 'library' : currentPanel
}

function sortAssetLibraryEntries(
  entries: RendererAssetLibraryEntry[],
  sortMode: AssetLibrarySortMode,
): RendererAssetLibraryEntry[] {
  return [...entries].sort((left, right) => compareAssetLibraryEntries(left, right, sortMode))
}

function compareAssetLibraryEntryGroups(
  left: AssetLibraryEntryGroup,
  right: AssetLibraryEntryGroup,
  sortMode: Exclude<AssetLibrarySortMode, 'type'>,
): number {
  const entryComparison = compareAssetLibraryEntries(left.entries[0], right.entries[0], sortMode)
  if (entryComparison !== 0) return entryComparison

  return (ASSET_LIBRARY_CAPABILITY_ORDER.get(left.capability) ?? Number.MAX_SAFE_INTEGER)
    - (ASSET_LIBRARY_CAPABILITY_ORDER.get(right.capability) ?? Number.MAX_SAFE_INTEGER)
}

function compareAssetLibraryEntries(
  left: RendererAssetLibraryEntry,
  right: RendererAssetLibraryEntry,
  sortMode: AssetLibrarySortMode,
): number {
  if (sortMode === 'date') {
    const leftTime = resolveAssetLibrarySortTimestamp(left)
    const rightTime = resolveAssetLibrarySortTimestamp(right)
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime
    if (leftTime !== null && rightTime === null) return -1
    if (leftTime === null && rightTime !== null) return 1
  }

  return compareAssetLibraryEntryNames(left, right)
}

function compareAssetLibraryEntryNames(left: RendererAssetLibraryEntry, right: RendererAssetLibraryEntry): number {
  const displayNameComparison = left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' })
  if (displayNameComparison !== 0) return displayNameComparison
  const workspacePathComparison = left.workspacePath.localeCompare(right.workspacePath, undefined, { sensitivity: 'base' })
  if (workspacePathComparison !== 0) return workspacePathComparison
  return left.id.localeCompare(right.id, undefined, { sensitivity: 'base' })
    || left.workspacePath.localeCompare(right.workspacePath) || left.id.localeCompare(right.id)
}

function resolveAssetLibrarySortTimestamp(entry: RendererAssetLibraryEntry): number | null {
  return parseAssetLibrarySortTimestamp(entry.createdAt) ?? parseAssetLibrarySortTimestamp(entry.updatedAt)
}

function parseAssetLibrarySortTimestamp(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const epochMs = Date.parse(value)
  return Number.isFinite(epochMs) ? epochMs : null
}

function normalizeAssetLibrarySearchQuery(searchQuery: string): string {
  return searchQuery.trim().toLocaleLowerCase()
}

function matchesAssetLibraryEntrySearch(entry: RendererAssetLibraryEntry, normalizedSearchQuery: string): boolean {
  return [
    entry.displayName,
    entry.workspacePath,
    entry.source?.workspacePath,
    entry.manifest?.workspacePath,
    entry.capability,
    entry.sourceScope,
    ...entry.warnings,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => matchesAssetLibrarySearch(value, normalizedSearchQuery))
}

function matchesAssetLibrarySearch(value: string, normalizedSearchQuery: string): boolean {
  return value.toLocaleLowerCase().includes(normalizedSearchQuery)
}

function hasInternalAssetLibraryDirectory(workspacePath: string): boolean {
  const segments = workspacePath.replace(/\\/g, '/').trim().split('/').filter(Boolean)
  return segments.slice(1, -1).some((segment) => segment.startsWith('.') || ASSET_LIBRARY_INTERNAL_DIRECTORY_NAMES.has(segment.toLocaleLowerCase()))
}
