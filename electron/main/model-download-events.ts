export interface DownloadProgress {
  percent: number
  file?: string
  fileIndex?: number
  totalFiles?: number
  repoIndex?: number
  totalRepos?: number
  status?: string
}

export interface ModelDownloadFailure {
  code: string
  stage: string
  message: string
  repoId?: string
  file?: string
  retryable: boolean
}

export type NormalizedDownloadEvent = {
  progress?: DownloadProgress
  failure?: ModelDownloadFailure
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function safeMessage(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'Model asset download failed'
  return raw
    .replace(/(bearer\s+)[^\s]+/giu, '$1[redacted]')
    .replace(/(token=)[^&\s]+/giu, '$1[redacted]')
    .replace(/hf_[A-Za-z0-9]{8,}/gu, '[redacted-token]')
    .slice(0, 500)
}

export function normalizeDownloadEvent(value: unknown): NormalizedDownloadEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const event = value as Record<string, unknown>

  if (event.error !== undefined) {
    const rawFailure = event.error
    if (rawFailure && typeof rawFailure === 'object' && !Array.isArray(rawFailure)) {
      const failure = rawFailure as Record<string, unknown>
      return {
        failure: {
          code: optionalString(failure.code) ?? 'download_failed',
          stage: optionalString(failure.stage) ?? 'download',
          message: safeMessage(failure.message),
          ...(optionalString(failure.repo_id) ? { repoId: optionalString(failure.repo_id) } : {}),
          ...(optionalString(failure.file) ? { file: optionalString(failure.file) } : {}),
          retryable: failure.retryable !== false,
        },
      }
    }

    return {
      failure: {
        code: 'download_failed',
        stage: 'download',
        message: safeMessage(rawFailure),
        retryable: true,
      },
    }
  }

  if (typeof event.percent !== 'number' || !Number.isFinite(event.percent)) return {}

  const file = optionalString(event.file)
  const status = optionalString(event.status)
  const fileIndex = optionalCount(event.fileIndex)
  const totalFiles = optionalCount(event.totalFiles)
  const repoIndex = optionalCount(event.repoIndex)
  const totalRepos = optionalCount(event.totalRepos)

  return {
    progress: {
      percent: Math.max(0, Math.min(100, Math.round(event.percent))),
      ...(file ? { file } : {}),
      ...(fileIndex !== undefined ? { fileIndex } : {}),
      ...(totalFiles !== undefined ? { totalFiles } : {}),
      ...(repoIndex !== undefined ? { repoIndex } : {}),
      ...(totalRepos !== undefined ? { totalRepos } : {}),
      ...(status ? { status } : {}),
    },
  }
}

export function buildManifestAssetDownloadRequest(
  apiUrl: string,
  modelId: string,
  token?: string,
): { url: string; headers: Record<string, string> } {
  return {
    url: `${apiUrl}/model/hf-download-assets?model_id=${encodeURIComponent(modelId)}`,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }
}

export function buildHttpsDownloadAssetsRequest(
  apiUrl: string,
  modelId: string,
): { url: string; headers: Record<string, string> } {
  return {
    url: `${apiUrl}/model/https-download-assets?model_id=${encodeURIComponent(modelId)}`,
    headers: {},
  }
}

export class ModelAssetDownloadError extends Error {
  readonly failure: ModelDownloadFailure

  constructor(failure: ModelDownloadFailure) {
    const location = [failure.repoId, failure.file].filter(Boolean).join(' / ')
    super(`[${failure.code}/${failure.stage}] ${failure.message}${location ? ` (${location})` : ''}`)
    this.name = 'ModelAssetDownloadError'
    this.failure = failure
  }
}
