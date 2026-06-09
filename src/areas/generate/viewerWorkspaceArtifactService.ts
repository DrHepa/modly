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

/** Capture physical ports, not wrappers which silently switch hosts after an await. */
export function captureViewerWorkspaceArtifactService() {
  const ports = typeof window === 'undefined' ? undefined : window.electron?.workspace?.artifacts
  const preview = ports?.previewWorkspaceArtifact
  const download = ports?.downloadWorkspaceArtifact
  const read = ports?.readSidecar
  const isCurrent = () => (typeof window === 'undefined' ? undefined : window.electron?.workspace?.artifacts) === ports
    && ports?.previewWorkspaceArtifact === preview && ports?.downloadWorkspaceArtifact === download && ports?.readSidecar === read
  const invoke = async <Request extends { workspacePath: string }, Result>(method: ((request: Request) => Promise<Result>) | undefined, request: Request): Promise<Result> => {
    if (!isSafeViewerWorkspaceRelativePath(request.workspacePath)) throw new Error(UNSAFE_WORKSPACE_PATH_ERROR)
    if (typeof method !== 'function') throw new Error('Workspace artifact APIs are unavailable.')
    if (!isCurrent()) throw new Error('Workspace artifact APIs changed; the captured request is retired.')
    const result = await method.call(ports, request)
    if (!isCurrent()) throw new Error('Workspace artifact APIs changed; the captured result is retired.')
    return result
  }
  return {
    isCurrent,
    previewWorkspaceArtifact: (request: WorkspaceArtifactPreviewRequest) => invoke(preview, request),
    downloadWorkspaceArtifact: (request: WorkspaceArtifactDownloadRequest) => invoke(download, request),
    readWorkspaceArtifactSidecar: (request: ArtifactRegistryReadRequest) => invoke(read, request),
  }
}

export async function previewWorkspaceArtifact(request: WorkspaceArtifactPreviewRequest): Promise<WorkspaceArtifactPreviewResult> {
  return captureViewerWorkspaceArtifactService().previewWorkspaceArtifact(request)
}

export async function downloadWorkspaceArtifact(request: WorkspaceArtifactDownloadRequest): Promise<WorkspaceArtifactDownloadResult> {
  return captureViewerWorkspaceArtifactService().downloadWorkspaceArtifact(request)
}

export async function readWorkspaceArtifactSidecar(request: ArtifactRegistryReadRequest): Promise<ArtifactRegistryReadResult> {
  return captureViewerWorkspaceArtifactService().readWorkspaceArtifactSidecar(request)
}
