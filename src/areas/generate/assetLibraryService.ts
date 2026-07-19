import type {
  AssetLibraryOpenRequest,
  AssetLibraryReadRequest,
} from '../../shared/types/assetLibrary.ts'
import { isSafeViewerWorkspaceRelativePath } from './viewerAssetTarget.ts'
import {
  projectAssetLibraryListResult,
  projectAssetLibraryOpenResult,
  projectAssetLibraryReadResult,
  type RendererAssetLibraryListResult,
  type RendererAssetLibraryOpenResult,
  type RendererAssetLibraryReadResult,
} from './assetLibraryProjection.ts'

const UNSAFE_WORKSPACE_PATH_ERROR = 'Asset library service requires a safe workspace-relative path.'

export function listAssetLibraryEntries(): Promise<RendererAssetLibraryListResult> {
  return getWorkspaceLibraryApi().list().then(projectAssetLibraryListResult)
}

export function readAssetLibraryEntry(request: AssetLibraryReadRequest): Promise<RendererAssetLibraryReadResult> {
  const unsafe = createUnsafeWorkspacePathError(request)
  if (unsafe) return Promise.reject(unsafe)
  return getWorkspaceLibraryApi().read(request).then(projectAssetLibraryReadResult)
}

export function openAssetLibraryEntry(request: AssetLibraryOpenRequest): Promise<RendererAssetLibraryOpenResult> {
  const unsafe = createUnsafeWorkspacePathError(request)
  if (unsafe) return Promise.reject(unsafe)
  return getWorkspaceLibraryApi().open(request).then(projectAssetLibraryOpenResult)
}

export function getDefaultAssetLibraryService() {
  return {
    list: listAssetLibraryEntries,
    read: readAssetLibraryEntry,
    open: openAssetLibraryEntry,
  }
}

function createUnsafeWorkspacePathError(request: AssetLibraryReadRequest): Error | undefined {
  if (!isSafeViewerWorkspaceRelativePath(request.workspacePath)) {
    return new Error(UNSAFE_WORKSPACE_PATH_ERROR)
  }
  if (request.sourceWorkspacePath && !isSafeViewerWorkspaceRelativePath(request.sourceWorkspacePath)) {
    return new Error(UNSAFE_WORKSPACE_PATH_ERROR)
  }
  return undefined
}

function getWorkspaceLibraryApi() {
  const libraryApi = window.electron?.workspace?.library
  if (!libraryApi) {
    throw new Error('Workspace asset-library APIs are unavailable.')
  }
  return libraryApi
}
