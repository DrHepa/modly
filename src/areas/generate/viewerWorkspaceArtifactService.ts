import type {
  ArtifactRegistryReadRequest,
  ArtifactRegistryReadResult,
  WorkspaceArtifactDownloadRequest,
  WorkspaceArtifactDownloadResult,
  WorkspaceArtifactPreviewRequest,
  WorkspaceArtifactPreviewResult,
} from '../../shared/types/electron.d.ts'
import { isSafeViewerWorkspaceRelativePath } from './viewerAssetTarget.ts'

const UNSAFE_WORKSPACE_PATH_ERROR = 'Viewer workspace artifact service requires a safe workspace-relative path.'

export function previewWorkspaceArtifact(request: WorkspaceArtifactPreviewRequest): Promise<WorkspaceArtifactPreviewResult> {
  const workspaceArtifactsApi = getWorkspaceArtifactsApi()
  const unsafe = createUnsafeWorkspacePathError(request.workspacePath)
  if (unsafe) return Promise.reject(unsafe)
  return workspaceArtifactsApi.previewWorkspaceArtifact(request)
}

export function downloadWorkspaceArtifact(request: WorkspaceArtifactDownloadRequest): Promise<WorkspaceArtifactDownloadResult> {
  const workspaceArtifactsApi = getWorkspaceArtifactsApi()
  const unsafe = createUnsafeWorkspacePathError(request.workspacePath)
  if (unsafe) return Promise.reject(unsafe)
  return workspaceArtifactsApi.downloadWorkspaceArtifact(request)
}

export function readWorkspaceArtifactSidecar(request: ArtifactRegistryReadRequest): Promise<ArtifactRegistryReadResult> {
  const workspaceArtifactsApi = getWorkspaceArtifactsApi()
  const unsafe = createUnsafeWorkspacePathError(request.workspacePath)
  if (unsafe) return Promise.reject(unsafe)
  return workspaceArtifactsApi.readSidecar(request)
}

function createUnsafeWorkspacePathError(workspacePath: string): Error | undefined {
  return isSafeViewerWorkspaceRelativePath(workspacePath) ? undefined : new Error(UNSAFE_WORKSPACE_PATH_ERROR)
}

function getWorkspaceArtifactsApi() {
  const artifactsApi = window.electron?.workspace?.artifacts
  if (!artifactsApi) {
    throw new Error('Workspace artifact APIs are unavailable.')
  }

  return artifactsApi
}
