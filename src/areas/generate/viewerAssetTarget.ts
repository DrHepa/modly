import type { GenerationJob } from '../../shared/stores/appStore.ts'
import type { ArtifactRef } from '../../shared/types/artifacts.ts'
import type { RendererAssetLibraryEntry } from './assetLibraryProjection.ts'

const FINAL_LABEL = 'Final output' as const
const CHECKPOINT_LABEL = 'Temporary checkpoint — not final output' as const
const WORKSPACE_PREFIX = '/workspace/'

export type ViewerAssetSourceKind = 'generation' | 'workflow' | 'import' | 'chat' | 'add-to-scene' | 'history'

type ViewerAssetMetadata = {
  sourceLabel: string
  sourceKind: ViewerAssetSourceKind
  workspacePath?: string
  artifactId?: string
  versionId?: string
  provenance?: ArtifactRef['provenance']
}

export type ViewerAssetTarget =
  | { kind: 'none'; modelUrl: null; isCheckpointPreview: false }
  | (ViewerAssetMetadata & { kind: 'final'; modelUrl: string; isCheckpointPreview: false; label: typeof FINAL_LABEL })
  | (ViewerAssetMetadata & { kind: 'workflow-checkpoint'; modelUrl: string; isCheckpointPreview: true; label: typeof CHECKPOINT_LABEL })

export interface ViewerWorkspaceContext {
  apiUrl?: string
  workspaceDir?: string
}

export interface ResolveViewerAssetTargetInput extends ViewerWorkspaceContext {
  currentJob: GenerationJob | null
  apiUrl: string
  sourceKind?: ViewerAssetSourceKind
  /** Caller supplies the selected current owner, never a previous checkpoint's artifact. */
  workflowArtifact?: Pick<ArtifactRef, 'id' | 'kind' | 'uri' | 'versionId' | 'legacy' | 'provenance'>
}

export function resolveViewerAssetTarget(input: ResolveViewerAssetTargetInput): ViewerAssetTarget {
  const job = input.currentJob
  const checkpoint = job?.status === 'generating' && job.previewKind === 'workflow-checkpoint'
  if (!job || (job.status !== 'done' && !checkpoint)) return { kind: 'none', modelUrl: null, isCheckpointPreview: false }
  const artifactPath = resolveViewerArtifactWorkspacePath(input.workflowArtifact, input)
  const artifactUrl = artifactPath ? `${input.apiUrl}${WORKSPACE_PREFIX}${artifactPath.split('/').map(encodeURIComponent).join('/')}` : undefined
  const modelUrl = job.outputUrl ? resolveViewerAssetTargetUrl(job.outputUrl, input.apiUrl) : artifactUrl
  if (!modelUrl) return { kind: 'none', modelUrl: null, isCheckpointPreview: false }
  const workspacePath = resolveViewerAssetWorkspacePathFromUrl(modelUrl, input)
  const matchesArtifact = !!artifactPath && artifactPath === workspacePath
  const artifact = matchesArtifact ? input.workflowArtifact : undefined
  const sourceKind = input.sourceKind ?? (checkpoint || matchesArtifact ? 'workflow'
    : job.id.startsWith('import-') ? 'import' : job.id === 'workflow-output' ? 'add-to-scene' : 'generation')
  const metadata: ViewerAssetMetadata = {
    sourceKind,
    sourceLabel: checkpoint ? CHECKPOINT_LABEL : FINAL_LABEL,
    ...(workspacePath ? { workspacePath } : {}),
    ...(artifact?.id ? { artifactId: artifact.id } : {}),
    ...(artifact?.versionId ? { versionId: artifact.versionId } : {}),
    ...(artifact?.provenance ? { provenance: artifact.provenance } : {}),
  }
  return checkpoint
    ? { kind: 'workflow-checkpoint', modelUrl, isCheckpointPreview: true, label: CHECKPOINT_LABEL, ...metadata }
    : { kind: 'final', modelUrl, isCheckpointPreview: false, label: FINAL_LABEL, ...metadata }
}

export function resolveViewerAssetTargetUrl(outputUrl: string, apiUrl: string): string {
  if (outputUrl.startsWith('http://') || outputUrl.startsWith('https://') || outputUrl.startsWith('blob:')) return outputUrl
  return outputUrl.startsWith('/') ? `${apiUrl}${outputUrl}` : outputUrl
}

export function resolveViewerAssetTargetFromLibraryEntry(entry: RendererAssetLibraryEntry, apiUrl: string): ViewerAssetTarget {
  if (entry.state !== 'ready' || entry.openTarget.kind === 'unavailable'
    || !isSafeViewerWorkspaceRelativePath(entry.workspacePath)
    || (entry.openTarget.kind === 'self' && entry.openTarget.workspacePath !== entry.workspacePath)
    || (entry.openTarget.kind === 'linked-source' && (entry.source?.degraded
      || entry.source?.workspacePath !== entry.openTarget.workspacePath || entry.workspacePath === entry.openTarget.workspacePath))) {
    return {
      kind: 'none',
      modelUrl: null,
      isCheckpointPreview: false,
    }
  }

  const modelUrl = isSafeViewerWorkspaceRelativePath(entry.openTarget.workspacePath, { meshOnly: true })
    ? `${apiUrl}${WORKSPACE_PREFIX}${entry.openTarget.workspacePath.split('/').map(encodeURIComponent).join('/')}` : undefined
  if (!modelUrl) {
    return {
      kind: 'none',
      modelUrl: null,
      isCheckpointPreview: false,
    }
  }

  return {
    kind: 'final',
    modelUrl,
    isCheckpointPreview: false,
    label: FINAL_LABEL,
    sourceLabel: entry.displayName,
    sourceKind: 'import',
    workspacePath: entry.openTarget.workspacePath,
    ...(entry.openTarget.kind === 'self'
      ? {
          ...(entry.artifactId ? { artifactId: entry.artifactId } : {}),
          ...(entry.versionId ? { versionId: entry.versionId } : {}),
          ...(entry.provenance ? { provenance: entry.provenance } : {}),
        }
      : {
          ...(entry.source?.assetId ? { artifactId: entry.source.assetId } : {}),
          ...(entry.source?.versionId ? { versionId: entry.source.versionId } : {}),
        }),
  }
}

/** Renderer preflight only. Native IO still owns physical/symlink custody. */
export function isSafeViewerWorkspaceRelativePath(workspacePath: string, options: { meshOnly?: boolean } = {}): boolean {
  if (typeof workspacePath !== 'string' || workspacePath !== workspacePath.trim() || !workspacePath
    || workspacePath.startsWith('/') || /^[A-Za-z]:/.test(workspacePath) || /[\\%?#\x00-\x1f]/.test(workspacePath)) return false
  if (workspacePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) return false
  return !options.meshOnly || /\.(glb|gltf)$/i.test(workspacePath)
}

export function resolveViewerAssetWorkspacePathFromUrl(modelUrl: string | null | undefined, context: ViewerWorkspaceContext = {}): string | undefined {
  if (!modelUrl || modelUrl.includes('#')) return undefined
  try {
    // Validate the raw URL before URL normalization can erase traversal evidence.
    decodeURIComponent(modelUrl)
    let route = modelUrl
    if (/^https?:\/\//.test(modelUrl)) {
      const parsed = new URL(modelUrl)
      if (parsed.username || parsed.password || (context.apiUrl !== undefined && (!context.apiUrl || parsed.origin !== new URL(context.apiUrl).origin))) return undefined
      route = modelUrl.match(/^https?:\/\/[^/?#]+(\/[^?#]*)?(?:\?[^#]*)?$/)?.[1] ?? ''
    } else if (!modelUrl.startsWith('/') || modelUrl.startsWith('//')) return undefined
    const rawPath = route.split('?', 1)[0]
    if (rawPath.startsWith(WORKSPACE_PREFIX)) {
      const encoded = rawPath.slice(WORKSPACE_PREFIX.length)
      if (encoded.split('/').some(segment => !segment || segment === '.' || segment === '..') || /%(?:2e|2f|5c|00|25)/i.test(encoded)) return undefined
      const decoded = decodeURIComponent(encoded)
      return isSafeViewerWorkspaceRelativePath(decoded, { meshOnly: true }) ? decoded : undefined
    }
    if (rawPath !== '/optimize/serve-file' || !context.workspaceDir) return undefined
    const parsed = new URL(modelUrl, context.apiUrl || 'http://localhost')
    if (parsed.username || parsed.password || !/^https?:$/.test(parsed.protocol)) return undefined
    if (/^https?:/.test(modelUrl) && (!context.apiUrl || parsed.origin !== new URL(context.apiUrl).origin)) return undefined
    if (parsed.searchParams.getAll('path').length !== 1) return undefined
    return resolveViewerWorkspacePathFromAbsoluteValue(parsed.searchParams.get('path') ?? undefined, { workspaceDir: context.workspaceDir, meshOnly: true })
  } catch { return undefined }
}

export function resolveViewerArtifactWorkspacePath(artifact: ResolveViewerAssetTargetInput['workflowArtifact'], context: ViewerWorkspaceContext = {}): string | undefined {
  if (!artifact || artifact.kind !== 'mesh') return undefined
  const paths = [artifact.uri, artifact.legacy?.filePath].filter((value): value is string => value !== undefined).map(value => {
    if (value.startsWith(WORKSPACE_PREFIX)) {
      const path = value.slice(WORKSPACE_PREFIX.length)
      return isSafeViewerWorkspaceRelativePath(path, { meshOnly: true }) ? path : undefined
    }
    return isSafeViewerWorkspaceRelativePath(value, { meshOnly: true }) ? value
      : resolveViewerWorkspacePathFromAbsoluteValue(value, { workspaceDir: context.workspaceDir, meshOnly: true })
  })
  const first = paths[0]
  return first && paths.every(path => path === first) ? first : undefined
}

export function resolveViewerWorkspacePathFromAbsoluteValue(value: string | undefined, options: { meshOnly?: boolean; workspaceDir?: string } = {}): string | undefined {
  if (typeof value !== 'string' || !options.workspaceDir || /[%?#\x00-\x1f]/.test(value)) return undefined
  const root = options.workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const absolute = value.replace(/\\/g, '/')
  // Do not infer custody from an arbitrary directory whose name happens to be workspace.
  if (!root || (!root.startsWith('/') && !/^[A-Za-z]:\//.test(root)) || !absolute.startsWith(`${root}/`)) return undefined
  const relative = absolute.slice(root.length + 1)
  return isSafeViewerWorkspaceRelativePath(relative, options) ? relative : undefined
}
