import type {
  AssetLibraryEntry, AssetLibraryOpenRequest, AssetLibraryReadRequest,
  AssetLibraryListResult, AssetLibraryReadResult, AssetLibraryOpenResult,
} from '../../shared/types/assetLibrary.ts'
import { ASSET_CAPABILITIES, ASSET_ENTRY_STATES, ASSET_LIBRARY_PREVIEW_KINDS } from '../../shared/types/assetLibrary.ts'
import { isSafeViewerWorkspaceRelativePath } from './viewerAssetTarget.ts'
import {
  projectAssetLibraryListResult, projectAssetLibraryOpenResult, projectAssetLibraryReadResult,
  type RendererAssetLibraryListResult, type RendererAssetLibraryOpenResult, type RendererAssetLibraryReadResult,
} from './assetLibraryProjection.ts'

const UNSAFE_WORKSPACE_PATH_ERROR = 'Asset library service requires a safe workspace-relative path.'

export async function listAssetLibraryEntries(): Promise<RendererAssetLibraryListResult> {
  const api = getWorkspaceLibraryApi('list')
  const result: unknown = await api.list()
  assertEnvelope(result)
  if (result.success) {
    if (!Array.isArray(result.entries) || !result.entries.every(isEntry)) throw new Error('Invalid asset library entries.')
    const paths = result.entries.map(entry => entry.workspacePath)
    const ids = result.entries.map(entry => entry.id)
    if (new Set(paths).size !== paths.length || new Set(ids).size !== ids.length) throw new Error('Invalid asset library duplicate identity.')
  }
  return projectAssetLibraryListResult(result as AssetLibraryListResult)
}

export async function readAssetLibraryEntry(request: AssetLibraryReadRequest): Promise<RendererAssetLibraryReadResult> {
  assertRequest(request)
  const api = getWorkspaceLibraryApi('read')
  const result: unknown = await api.read(request)
  assertEntryResult(result, request)
  if (result.success && !isPreview(result.preview)) throw new Error('Invalid asset library preview.')
  return projectAssetLibraryReadResult(result as AssetLibraryReadResult)
}

export async function openAssetLibraryEntry(request: AssetLibraryOpenRequest): Promise<RendererAssetLibraryOpenResult> {
  assertRequest(request)
  const api = getWorkspaceLibraryApi('open')
  const result: unknown = await api.open(request)
  assertEntryResult(result, request)
  return projectAssetLibraryOpenResult(result as AssetLibraryOpenResult)
}

export function getDefaultAssetLibraryService() {
  return {
    list: listAssetLibraryEntries,
    read: readAssetLibraryEntry,
    open: openAssetLibraryEntry,
  }
}

function assertRequest(request: AssetLibraryReadRequest): void {
  if (!isRecord(request) || !isSafeViewerWorkspaceRelativePath(request.workspacePath)
    || (request.sourceWorkspacePath !== undefined && !isSafeViewerWorkspaceRelativePath(request.sourceWorkspacePath))) {
    throw new Error(UNSAFE_WORKSPACE_PATH_ERROR)
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => value[key] === undefined || typeof value[key] === 'string')
}

function isEntry(value: unknown): value is AssetLibraryEntry {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.workspacePath !== 'string'
    || typeof value.displayName !== 'string' || !['workflows', 'exports'].includes(value.sourceScope)
    || !ASSET_ENTRY_STATES.includes(value.state) || !ASSET_LIBRARY_PREVIEW_KINDS.includes(value.previewKind)
    || (value.capability !== undefined && !ASSET_CAPABILITIES.includes(value.capability))
    || !Array.isArray(value.warnings) || !value.warnings.every((warning: unknown) => typeof warning === 'string')
    || !optionalStrings(value, ['artifactId', 'versionId', 'createdAt', 'updatedAt'])) return false
  if (value.provenance !== undefined && (!isRecord(value.provenance)
    || !optionalStrings(value.provenance, ['workflowId', 'workflowNodeId', 'source', 'extensionId', 'extensionNodeId']))) return false
  if (value.source !== undefined && (!isRecord(value.source)
    || !['source', 'sidecar-source', 'manifest-source', 'derived-from'].includes(value.source.relation)
    || (value.source.workspacePath !== undefined && typeof value.source.workspacePath !== 'string')
    || (value.source.degraded !== undefined && typeof value.source.degraded !== 'boolean')
    || !optionalStrings(value.source, ['assetId', 'versionId']))) return false
  if (value.manifest !== undefined && (!isRecord(value.manifest) || typeof value.manifest.workspacePath !== 'string'
    || !['generated-world', 'scene-manifest'].includes(value.manifest.capability)
    || !optionalStrings(value.manifest, ['schema', 'title']))) return false
  return true
}

function isPreview(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.kind === 'none') return true
  if (value.kind === '3d-model') return value.viewerKind === 'glb' || value.viewerKind === 'gltf'
  if (!Number.isFinite(value.byteLength) || value.byteLength < 0) return false
  if (value.kind === 'audio') return ['wav', 'mp3', 'ogg', 'flac'].includes(value.audioKind) && typeof value.sourceUrl === 'string'
  if (value.kind === 'text') return typeof value.content === 'string' && typeof value.truncated === 'boolean'
  return value.kind === 'binary' && typeof value.binaryKind === 'string' && typeof value.message === 'string'
}

function assertEnvelope(value: unknown): asserts value is Record<string, any> {
  if (!isRecord(value) || (value.success !== true && value.success !== false)
    || (value.success === false && typeof value.error !== 'string')) throw new Error('Invalid asset library result envelope.')
}

function assertEntryResult(value: unknown, request: AssetLibraryReadRequest): asserts value is Record<string, any> {
  assertEnvelope(value)
  if (value.success && (!isEntry(value.entry) || value.entry.workspacePath !== request.workspacePath)) throw new Error('Invalid asset library entry response.')
  if (value.success && request.sourceWorkspacePath !== undefined && value.entry.source?.workspacePath !== request.sourceWorkspacePath) throw new Error('Invalid asset library source response.')
}

function getWorkspaceLibraryApi(method: 'list' | 'read' | 'open') {
  const api = typeof window === 'undefined' ? undefined : window.electron?.workspace?.library
  if (!api || typeof api[method] !== 'function') throw new Error('Workspace asset-library APIs are unavailable.')
  return api
}
