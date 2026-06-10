import type {
  AssetCapability,
  AssetLibraryEntry,
  AssetLibraryListResult,
  AssetLibraryManifestRef,
  AssetLibraryOpenResult,
  AssetLibraryReadResult,
  AssetLibrarySourceLink,
} from '../../shared/types/assetLibrary.ts'
import { isSafeViewerWorkspaceRelativePath } from './viewerAssetTarget.ts'

const UNSAFE_ENTRY_WARNING = 'Renderer rejected unsafe asset-library entry workspace path.'
const UNSAFE_SOURCE_WARNING = 'Renderer rejected unsafe asset-library source workspace path.'
const UNSAFE_MANIFEST_WARNING = 'Renderer rejected unsafe asset-library manifest workspace path.'

export type RendererAssetLibraryOpenTargetReason =
  | 'unsafe-entry'
  | 'state-not-openable'
  | 'missing-capability'
  | 'missing-source-link'
  | 'capability-not-viewable'

export type RendererAssetLibraryOpenTarget =
  | {
      kind: 'self'
      workspacePath: string
    }
  | {
      kind: 'linked-source'
      workspacePath: string
      relation: NonNullable<AssetLibrarySourceLink['relation']>
    }
  | {
      kind: 'unavailable'
      reason: RendererAssetLibraryOpenTargetReason
    }

export interface RendererAssetLibraryEntry extends Omit<AssetLibraryEntry, 'source' | 'manifest'> {
  source?: AssetLibrarySourceLink
  manifest?: AssetLibraryManifestRef
  openTarget: RendererAssetLibraryOpenTarget
}

export type RendererAssetLibraryListResult =
  | { success: true; entries: RendererAssetLibraryEntry[] }
  | { success: false; error: string }

export type RendererAssetLibraryReadResult =
  | { success: true; entry: RendererAssetLibraryEntry; preview: Extract<AssetLibraryReadResult, { success: true }>['preview'] }
  | { success: false; error: string }

export type RendererAssetLibraryOpenResult =
  | { success: true; entry: RendererAssetLibraryEntry }
  | { success: false; error: string }

export function projectAssetLibraryEntry(entry: AssetLibraryEntry): RendererAssetLibraryEntry {
  const warnings = dedupeWarnings(entry.warnings)
  const safeWorkspacePath = normalizeWorkspacePath(entry.workspacePath)
  const source = projectSourceLink(entry.source, warnings)
  const manifest = projectManifestRef(entry.manifest, warnings)
  const displayName = resolveDisplayName(entry.displayName, safeWorkspacePath ?? entry.workspacePath)

  if (!safeWorkspacePath) {
    warnings.push(UNSAFE_ENTRY_WARNING)
  }

  return {
    ...entry,
    workspacePath: safeWorkspacePath ?? entry.workspacePath,
    displayName,
    state: safeWorkspacePath ? entry.state : 'unsafe',
    ...(source ? { source } : {}),
    ...(manifest ? { manifest } : {}),
    warnings: dedupeWarnings(warnings),
    openTarget: resolveOpenTarget(entry.capability, safeWorkspacePath, safeWorkspacePath ? entry.state : 'unsafe', source),
  }
}

export function projectAssetLibraryListResult(result: AssetLibraryListResult): RendererAssetLibraryListResult {
  if (result.success !== true) return result
  return { success: true, entries: result.entries.map(projectAssetLibraryEntry) }
}

export function projectAssetLibraryReadResult(result: AssetLibraryReadResult): RendererAssetLibraryReadResult {
  if (result.success !== true) return result
  return {
    success: true,
    entry: projectAssetLibraryEntry(result.entry),
    preview: result.preview,
  }
}

export function projectAssetLibraryOpenResult(result: AssetLibraryOpenResult): RendererAssetLibraryOpenResult {
  if (result.success !== true) return result
  return {
    success: true,
    entry: projectAssetLibraryEntry(result.entry),
  }
}

function resolveOpenTarget(
  capability: AssetCapability | undefined,
  workspacePath: string | undefined,
  state: AssetLibraryEntry['state'],
  source: AssetLibrarySourceLink | undefined,
): RendererAssetLibraryOpenTarget {
  if (!workspacePath) {
    return { kind: 'unavailable', reason: 'unsafe-entry' }
  }
  if (state !== 'ready') {
    return { kind: 'unavailable', reason: 'state-not-openable' }
  }
  if (!capability) {
    return { kind: 'unavailable', reason: 'missing-capability' }
  }
  if (capability === 'mesh' || capability === 'rigged-mesh') {
    if (!isSafeViewerWorkspaceRelativePath(workspacePath, { meshOnly: true })) {
      return { kind: 'unavailable', reason: 'capability-not-viewable' }
    }
    return { kind: 'self', workspacePath }
  }
  if (capability === 'animation-motion') {
    if (isSafeViewerWorkspaceRelativePath(workspacePath, { meshOnly: true })) {
      return { kind: 'self', workspacePath }
    }
    if (!source?.workspacePath) {
      return { kind: 'unavailable', reason: 'missing-source-link' }
    }
    return {
      kind: 'linked-source',
      workspacePath: source.workspacePath,
      relation: source.relation,
    }
  }
  if (capability === 'landmarks-sidecar') {
    if (!source?.workspacePath) {
      return { kind: 'unavailable', reason: 'missing-source-link' }
    }
    return {
      kind: 'linked-source',
      workspacePath: source.workspacePath,
      relation: source.relation,
    }
  }
  return { kind: 'unavailable', reason: 'capability-not-viewable' }
}

function projectSourceLink(source: AssetLibrarySourceLink | undefined, warnings: string[]): AssetLibrarySourceLink | undefined {
  if (!source) return undefined

  const workspacePath = source.workspacePath ? normalizeWorkspacePath(source.workspacePath) : undefined
  if (source.workspacePath && !workspacePath) {
    warnings.push(UNSAFE_SOURCE_WARNING)
  }

  return {
    relation: source.relation,
    ...(workspacePath ? { workspacePath } : {}),
    ...(source.assetId ? { assetId: source.assetId } : {}),
    ...(source.versionId ? { versionId: source.versionId } : {}),
    ...(source.degraded || (source.workspacePath !== undefined && !workspacePath) ? { degraded: true } : {}),
  }
}

function projectManifestRef(manifest: AssetLibraryManifestRef | undefined, warnings: string[]): AssetLibraryManifestRef | undefined {
  if (!manifest) return undefined

  const workspacePath = normalizeWorkspacePath(manifest.workspacePath)
  if (!workspacePath) {
    warnings.push(UNSAFE_MANIFEST_WARNING)
    return undefined
  }

  return {
    capability: manifest.capability,
    workspacePath,
    ...(manifest.schema ? { schema: manifest.schema } : {}),
    ...(manifest.title ? { title: manifest.title } : {}),
  }
}

function normalizeWorkspacePath(workspacePath: string | undefined): string | undefined {
  if (typeof workspacePath !== 'string') return undefined
  const normalized = workspacePath.replace(/\\/g, '/').trim()
  return isSafeViewerWorkspaceRelativePath(normalized) ? normalized : undefined
}

function resolveDisplayName(displayName: string, workspacePath: string): string {
  const trimmed = displayName.trim()
  if (trimmed) return trimmed
  const segments = workspacePath.replace(/\\/g, '/').split('/')
  return segments.at(-1) || workspacePath
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))]
}
