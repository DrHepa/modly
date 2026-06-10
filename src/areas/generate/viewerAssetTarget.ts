import type { GenerationJob } from '../../shared/stores/appStore.ts'
import type { ArtifactRef } from '../../shared/types/artifacts.ts'
import type { RendererAssetLibraryEntry } from './assetLibraryProjection.ts'

const FINAL_LABEL = 'Final output' as const
const CHECKPOINT_LABEL = 'Temporary checkpoint — not final output' as const
const WORKSPACE_PREFIX = '/workspace/'

export type ViewerAssetSourceKind = 'generation' | 'workflow' | 'import' | 'chat' | 'add-to-scene' | 'history'

export type ViewerAssetTarget =
  | { kind: 'none'; modelUrl: null; isCheckpointPreview: false }
  | {
      kind: 'final'
      modelUrl: string
      isCheckpointPreview: false
      label: typeof FINAL_LABEL
      sourceLabel: string
      sourceKind: ViewerAssetSourceKind
      workspacePath?: string
      artifactId?: string
      versionId?: string
      provenance?: ArtifactRef['provenance']
    }
  | {
      kind: 'workflow-checkpoint'
      modelUrl: string
      isCheckpointPreview: true
      label: typeof CHECKPOINT_LABEL
      sourceLabel: string
      sourceKind: ViewerAssetSourceKind
      workspacePath?: string
      artifactId?: string
      versionId?: string
      provenance?: ArtifactRef['provenance']
    }

export interface ResolveViewerAssetTargetInput {
  currentJob: GenerationJob | null
  apiUrl: string
  sourceKind?: ViewerAssetSourceKind
  workflowArtifact?: Pick<ArtifactRef, 'id' | 'kind' | 'uri' | 'versionId' | 'legacy' | 'provenance'>
}

export function resolveViewerAssetTarget(input: ResolveViewerAssetTargetInput): ViewerAssetTarget {
  const currentOutputUrl = input.currentJob?.outputUrl
  const visibleModelUrl = currentOutputUrl ? resolveViewerAssetTargetUrl(currentOutputUrl, input.apiUrl) : undefined
  const artifactModelUrl = resolveViewerArtifactModelUrl(input.workflowArtifact, input.apiUrl)
  const modelUrl = visibleModelUrl ?? artifactModelUrl

  if (!modelUrl) {
    return {
      kind: 'none',
      modelUrl: null,
      isCheckpointPreview: false,
    }
  }

  const metadata = resolveViewerArtifactMetadata(input.workflowArtifact, modelUrl, artifactModelUrl, input.sourceKind)

  if (input.currentJob?.status === 'done') {
    return {
      kind: 'final',
      modelUrl,
      isCheckpointPreview: false,
      label: FINAL_LABEL,
      sourceLabel: FINAL_LABEL,
      sourceKind: resolveViewerAssetSourceKind(input.currentJob, input.sourceKind, false, input.workflowArtifact, modelUrl, artifactModelUrl),
      ...metadata,
    }
  }

  if (input.currentJob?.status === 'generating' && input.currentJob.previewKind === 'workflow-checkpoint') {
    return {
      kind: 'workflow-checkpoint',
      modelUrl,
      isCheckpointPreview: true,
      label: CHECKPOINT_LABEL,
      sourceLabel: CHECKPOINT_LABEL,
      sourceKind: resolveViewerAssetSourceKind(input.currentJob, input.sourceKind, true, input.workflowArtifact, modelUrl, artifactModelUrl),
      ...metadata,
    }
  }

  return {
    kind: 'none',
    modelUrl: null,
    isCheckpointPreview: false,
  }
}

export function resolveViewerAssetTargetUrl(outputUrl: string, apiUrl: string): string {
  if (outputUrl.startsWith('http://') || outputUrl.startsWith('https://') || outputUrl.startsWith('blob:')) {
    return outputUrl
  }

  return outputUrl.startsWith('/') ? `${apiUrl}${outputUrl}` : outputUrl
}

export function resolveViewerAssetTargetFromLibraryEntry(entry: RendererAssetLibraryEntry, apiUrl: string): ViewerAssetTarget {
  if (entry.openTarget.kind === 'unavailable') {
    return {
      kind: 'none',
      modelUrl: null,
      isCheckpointPreview: false,
    }
  }

  const modelUrl = resolveViewerWorkspaceModelUrl(entry.openTarget.workspacePath, apiUrl)
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

export function isSafeViewerWorkspaceRelativePath(workspacePath: string, options: { meshOnly?: boolean } = {}): boolean {
  const normalized = workspacePath.replace(/\\/g, '/').trim()
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || /%2e|%2f|%5c/i.test(normalized)) {
    return false
  }

  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '..')) {
    return false
  }

  if (!options.meshOnly) {
    return true
  }

  const lower = normalized.toLowerCase()
  return lower.endsWith('.glb') || lower.endsWith('.gltf')
}

export function resolveViewerAssetWorkspacePathFromUrl(modelUrl: string | null | undefined): string | undefined {
  if (typeof modelUrl !== 'string') return undefined

  const trimmed = modelUrl.trim()
  if (!trimmed || /^blob:/i.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return undefined
  if (/[\\/]\.\.(?:[\\/]|$)/.test(trimmed) || /%2e%2e/i.test(trimmed)) return undefined

  let pathname = trimmed
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return undefined
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.pathname === '/optimize/serve-file') {
      return parsed.searchParams.get('path') ? resolveWorkspacePathFromAbsoluteWorkspaceValue(parsed.searchParams.get('path')!) : undefined
    }

    pathname = parsed.pathname
  }

  if (!pathname.startsWith(WORKSPACE_PREFIX)) return undefined

  let workspacePath = pathname.slice(WORKSPACE_PREFIX.length)
  try {
    workspacePath = decodeURIComponent(workspacePath)
  } catch {
    return undefined
  }

  return normalizeViewerWorkspacePath(workspacePath, { meshOnly: true })
}

export function resolveViewerArtifactWorkspacePath(artifact: ResolveViewerAssetTargetInput['workflowArtifact']): string | undefined {
  if (!artifact || artifact.kind !== 'mesh') return undefined

  return normalizeViewerWorkspacePath(artifact.legacy?.filePath, { meshOnly: true })
    ?? normalizeViewerWorkspacePath(artifact.uri, { meshOnly: true })
    ?? resolveWorkspacePathFromAbsoluteWorkspaceValue(artifact.legacy?.filePath, { meshOnly: true })
    ?? resolveWorkspacePathFromAbsoluteWorkspaceValue(artifact.uri, { meshOnly: true })
}

export function resolveViewerWorkspacePathFromAbsoluteValue(value: string | undefined, options: { meshOnly?: boolean } = {}): string | undefined {
  return resolveWorkspacePathFromAbsoluteWorkspaceValue(value, options)
}

function resolveViewerArtifactModelUrl(
  artifact: ResolveViewerAssetTargetInput['workflowArtifact'],
  apiUrl: string,
): string | undefined {
  const workspacePath = resolveViewerArtifactWorkspacePath(artifact)
  return workspacePath ? `${apiUrl}${WORKSPACE_PREFIX}${workspacePath}` : undefined
}

function resolveViewerWorkspaceModelUrl(workspacePath: string, apiUrl: string): string | undefined {
  const normalizedWorkspacePath = normalizeViewerWorkspacePath(workspacePath, { meshOnly: true })
  return normalizedWorkspacePath ? `${apiUrl}${WORKSPACE_PREFIX}${normalizedWorkspacePath}` : undefined
}

function resolveViewerArtifactMetadata(
  artifact: ResolveViewerAssetTargetInput['workflowArtifact'],
  fallbackModelUrl: string,
  artifactModelUrl: string | undefined,
  explicitSourceKind: ViewerAssetSourceKind | undefined,
): Pick<Extract<ViewerAssetTarget, { kind: 'final' | 'workflow-checkpoint' }>, 'workspacePath' | 'artifactId' | 'versionId' | 'provenance'> {
  const artifactMatchesVisibleModel = Boolean(
    artifact
    && (
      explicitSourceKind !== 'history'
      || (artifactModelUrl && artifactModelUrl === fallbackModelUrl)
    ),
  )
  const workspacePath = artifactMatchesVisibleModel
    ? resolveViewerArtifactWorkspacePath(artifact) ?? resolveViewerAssetWorkspacePathFromUrl(fallbackModelUrl)
    : resolveViewerAssetWorkspacePathFromUrl(fallbackModelUrl)

  return {
    ...(workspacePath ? { workspacePath } : {}),
    ...(artifactMatchesVisibleModel && artifact?.id ? { artifactId: artifact.id } : {}),
    ...(artifactMatchesVisibleModel && artifact?.versionId ? { versionId: artifact.versionId } : {}),
    ...(artifactMatchesVisibleModel && artifact?.provenance ? { provenance: artifact.provenance } : {}),
  }
}

function resolveViewerAssetSourceKind(
  currentJob: GenerationJob,
  explicitSourceKind: ViewerAssetSourceKind | undefined,
  isCheckpoint: boolean,
  workflowArtifact: ResolveViewerAssetTargetInput['workflowArtifact'],
  modelUrl: string,
  artifactModelUrl: string | undefined,
): ViewerAssetSourceKind {
  if (explicitSourceKind) return explicitSourceKind
  if (isCheckpoint) return 'workflow'
  if (workflowArtifact && artifactModelUrl === modelUrl) return 'workflow'
  if (currentJob.id.startsWith('import-')) return 'import'
  if (currentJob.id === 'workflow-output') return 'add-to-scene'
  return 'generation'
}

function normalizeViewerWorkspacePath(value: string | undefined, options: { meshOnly?: boolean } = {}): string | undefined {
  if (typeof value !== 'string') return undefined

  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/workspace\//, '')
  return isSafeViewerWorkspaceRelativePath(normalized, options) ? normalized : undefined
}

function resolveWorkspacePathFromAbsoluteWorkspaceValue(value: string | undefined, options: { meshOnly?: boolean } = {}): string | undefined {
  if (typeof value !== 'string') return undefined

  const normalizedAbsoluteValue = value.replace(/\\/g, '/').trim()
  if (!normalizedAbsoluteValue || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(normalizedAbsoluteValue) || /%2e%2e/i.test(normalizedAbsoluteValue)) {
    return undefined
  }

  const workspaceIndex = normalizedAbsoluteValue.toLowerCase().indexOf(WORKSPACE_PREFIX)
  if (workspaceIndex < 0) return undefined

  const workspaceSuffix = normalizedAbsoluteValue.slice(workspaceIndex + WORKSPACE_PREFIX.length)
  if (!workspaceSuffix || /%2f|%5c|%2e/i.test(workspaceSuffix)) return undefined

  let decodedWorkspaceSuffix = workspaceSuffix
  try {
    decodedWorkspaceSuffix = decodeURIComponent(workspaceSuffix)
  } catch {
    return undefined
  }

  return normalizeViewerWorkspacePath(decodedWorkspaceSuffix, options)
}
