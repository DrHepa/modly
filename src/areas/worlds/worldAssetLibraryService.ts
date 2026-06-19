import type {
  AssetLibraryEntry,
  AssetLibraryListResult,
  AssetLibraryOpenRequest,
  AssetLibraryOpenResult,
} from '../../shared/types/assetLibrary.ts'
import {
  resolveWorldRenderable,
  type WorldRenderable,
  type WorldSceneItem,
  type WorldUnsupportedReason,
} from './worldRenderableResolver.ts'

const UNSAFE_WORKSPACE_PATH_ERROR = 'World asset library service requires a safe workspace-relative path.'

export type WorldAssetLibraryType = 'GLB model' | 'GLTF scene' | 'PLY mesh' | 'PLY points' | 'Unsupported' | 'Unavailable'

export type WorldAssetLibraryRenderable =
  | {
      id: string
      name: string
      type: WorldAssetLibraryType
      sourceScope: 'workflows' | 'exports'
      openable: true
      workspacePath: string
      item: WorldSceneItem
    }
  | {
      id: string
      name: string
      type: WorldAssetLibraryType
      sourceScope: 'workflows' | 'exports'
      openable: false
      workspacePath: string
      reason: WorldUnsupportedReason
    }

export type WorldAssetLibraryListResult =
  | { success: true; assets: WorldAssetLibraryRenderable[] }
  | { success: false; error: string }

export type WorldAssetLibraryOpenResult =
  | { success: true; asset: WorldAssetLibraryRenderable }
  | { success: false; error: string }

export function listWorldAssetLibraryRenderables(apiUrl: string): Promise<WorldAssetLibraryListResult> {
  return getWorkspaceLibraryApi()
    .list()
    .then((result) => projectWorldAssetLibraryListResult(result, apiUrl))
}

export function openWorldAssetLibraryRenderable(request: AssetLibraryOpenRequest, apiUrl: string): Promise<WorldAssetLibraryOpenResult> {
  if (!isSafeWorkspacePath(request.workspacePath) || (request.sourceWorkspacePath && !isSafeWorkspacePath(request.sourceWorkspacePath))) {
    return Promise.reject(new Error(UNSAFE_WORKSPACE_PATH_ERROR))
  }

  return getWorkspaceLibraryApi()
    .open(request)
    .then((result) => projectWorldAssetLibraryOpenResult(result, apiUrl))
}

export function projectWorldAssetLibraryListResult(result: AssetLibraryListResult, apiUrl: string): WorldAssetLibraryListResult {
  if (result.success !== true) return result
  return {
    success: true,
    assets: result.entries.filter(isWorkflowWorldCandidate).map((entry) => projectWorldAssetLibraryEntry(entry, apiUrl)),
  }
}

export function projectWorldAssetLibraryOpenResult(result: AssetLibraryOpenResult, apiUrl: string): WorldAssetLibraryOpenResult {
  if (result.success !== true) return result
  return {
    success: true,
    asset: projectWorldAssetLibraryEntry(result.entry, apiUrl),
  }
}

function projectWorldAssetLibraryEntry(entry: AssetLibraryEntry, apiUrl: string): WorldAssetLibraryRenderable {
  const renderable = resolveWorldRenderable({ workspacePath: entry.workspacePath, apiUrl })
  const name = resolveName(entry)
  const sourceScope = entry.sourceScope

  if (renderable.openable) {
    return {
      id: entry.id,
      name,
      type: describeRenderableType(renderable),
      sourceScope,
      openable: true,
      workspacePath: entry.workspacePath,
      item: renderable.item,
    }
  }

  return {
    id: entry.id,
    name,
    type: describeUnsupportedType(renderable.reason),
    sourceScope,
    openable: false,
    workspacePath: entry.workspacePath,
    reason: renderable.reason,
  }
}

function isWorkflowWorldCandidate(entry: AssetLibraryEntry): boolean {
  if (entry.sourceScope !== 'workflows') return false
  if (entry.capability === 'generated-world' || entry.capability === 'scene-manifest' || entry.capability === 'mesh' || entry.capability === 'rigged-mesh') {
    return true
  }
  return ['.ply', '.glb', '.gltf', '.spz'].includes(getExtension(entry.workspacePath))
}

function describeRenderableType(renderable: Extract<WorldRenderable, { openable: true }>): WorldAssetLibraryType {
  switch (renderable.item.kind) {
    case 'glb':
      return 'GLB model'
    case 'gltf':
      return 'GLTF scene'
    case 'ply-mesh':
      return 'PLY mesh'
    case 'ply-points':
      return 'PLY points'
  }
}

function describeUnsupportedType(reason: WorldUnsupportedReason): WorldAssetLibraryType {
  return reason === 'unsafe' || reason === 'unavailable' ? 'Unavailable' : 'Unsupported'
}

function resolveName(entry: AssetLibraryEntry): string {
  const displayName = entry.displayName.trim()
  if (displayName) return displayName
  if (!isSafeWorkspacePath(entry.workspacePath)) return entry.workspacePath
  return entry.workspacePath.replace(/\\/g, '/').split('/').at(-1) || entry.workspacePath
}

function isSafeWorkspacePath(workspacePath: string): boolean {
  const normalized = workspacePath.replace(/\\/g, '/').trim().replace(/^\.\//, '')
  return Boolean(
    normalized
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:\//.test(normalized)
    && !/%2e|%2f|%5c/i.test(normalized)
    && !normalized.includes('\0')
    && !normalized.split('/').some((segment) => segment === '' || segment === '..'),
  )
}

function getExtension(workspacePath: string): string {
  const filename = workspacePath.replace(/\\/g, '/').split('/').at(-1) ?? workspacePath
  const dotIndex = filename.lastIndexOf('.')
  return dotIndex === -1 ? '' : filename.slice(dotIndex).toLowerCase()
}

function getWorkspaceLibraryApi() {
  const libraryApi = window.electron?.workspace?.library
  if (!libraryApi) {
    throw new Error('Workspace asset-library APIs are unavailable.')
  }
  return libraryApi
}
