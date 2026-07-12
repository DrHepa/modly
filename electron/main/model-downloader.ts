/**
 * ModelDownloader — downloads models via the SSE endpoint of the Python backend.
 * No longer depends on the Go API catalog.
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
import { getSettings } from './settings-store.ts'
import { app } from 'electron'
import { buildHttpsDownloadAssetsRequest, buildManifestAssetDownloadRequest, ModelAssetDownloadError, normalizeDownloadEvent } from './model-download-events.ts'
export { ModelAssetDownloadError }
export type { ModelDownloadFailure } from './model-download-events.ts'
export {
  getCanonicalModelPath,
  getLegacyModelPaths,
  selectPreferredModelPath,
} from './model-ownership.ts'
export type {
  ModelOwnershipDescriptor,
  PreferredModelPath,
} from './model-ownership.ts'

export interface DownloadProgress {
  percent: number
  file?: string
  fileIndex?: number
  totalFiles?: number
  repoIndex?: number
  totalRepos?: number
  status?: string
  bytesDownloaded?: number
  totalBytes?: number
  stalledSeconds?: number
}
export type ProgressCallback = (progress: DownloadProgress) => void

const PYTHON_API_URL = process.env['PYTHON_API_URL'] ?? 'http://127.0.0.1:8765'

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Check if a model is already downloaded (directory exists and is non-empty).
 */
export function isModelDownloaded(modelsDir: string, modelId: string, downloadCheck?: string): boolean {
  const modelDir = join(modelsDir, modelId)
  if (!existsSync(modelDir)) return false
  if (downloadCheck && downloadCheck.trim()) {
    return existsSync(join(modelDir, downloadCheck))
  }
  try {
    return readdirSync(modelDir).length > 0
  } catch {
    return false
  }
}

/**
 * Recursively compute the total size in bytes of a directory.
 */
function dirSizeBytes(dirPath: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(dirPath)) {
      const full = join(dirPath, entry)
      try {
        const s = statSync(full)
        total += s.isDirectory() ? dirSizeBytes(full) : s.size
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* skip unreadable dir */ }
  return total
}

/**
 * Read HuggingFace download metadata files to get declared file sizes.
 * HF stores these at <modelDir>/.cache/huggingface/download/<filename>.metadata
 * Each file is JSON with a "size" field (bytes).
 * Used as fallback when dirSizeBytes returns near-zero (e.g. symlinks on Windows).
 */
function getModelSizeFromHFMetadata(modelDir: string): number {
  const cacheDir = join(modelDir, '.cache', 'huggingface', 'download')
  if (!existsSync(cacheDir)) return 0
  let total = 0
  try {
    for (const entry of readdirSync(cacheDir)) {
      if (!entry.endsWith('.metadata')) continue
      try {
        const data = JSON.parse(readFileSync(join(cacheDir, entry), 'utf-8'))
        if (typeof data.size === 'number' && data.size > 0) total += data.size
      } catch { /* skip malformed metadata */ }
    }
  } catch { /* skip unreadable cache dir */ }
  return total
}

/**
 * List all locally downloaded models by scanning the models directory.
 * Returns id, name and size_gb (rounded to 1 decimal).
 */
export function listDownloadedModels(modelsDir: string): { id: string; name: string; size_gb: number }[] {
  if (!existsSync(modelsDir)) return []
  try {
    return readdirSync(modelsDir)
      .filter((name) => {
        try {
          const dir = join(modelsDir, name)
          return statSync(dir).isDirectory() && readdirSync(dir).length > 0
        } catch {
          return false
        }
      })
      .map((name) => {
        const modelDir = join(modelsDir, name)
        let bytes = dirSizeBytes(modelDir)
        // Fallback: if near-zero (symlinks not followed), use HF metadata declared sizes
        if (bytes < 1_000_000) bytes = getModelSizeFromHFMetadata(modelDir)
        const size_gb = Math.round(bytes / 1e9 * 10) / 10
        return { id: name, name, size_gb }
      })
  } catch {
    return []
  }
}

type StructuredAssetDownloadRequest = ReturnType<typeof buildManifestAssetDownloadRequest>

async function consumeStructuredModelAssetDownload(
  request: StructuredAssetDownloadRequest,
  onProgress: ProgressCallback,
): Promise<void> {
  const { net } = require('electron')
  const res = await net.fetch(request.url, { headers: request.headers })

  if (!res.ok) {
    throw new ModelAssetDownloadError({
      code: 'http_error',
      stage: 'request',
      message: `Manifest asset download failed with HTTP ${res.status}`,
      retryable: res.status >= 500 || res.status === 429,
    })
  }
  if (!res.body) {
    throw new ModelAssetDownloadError({
      code: 'missing_stream',
      stage: 'request',
      message: 'Manifest asset download returned no response stream',
      retryable: true,
    })
  }

  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffer = ''
  let completed = false

  const consumeLine = (line: string): void => {
    if (!line.startsWith('data: ')) return
    let payload: unknown
    try {
      payload = JSON.parse(line.slice(6))
    } catch {
      return
    }

    const event = normalizeDownloadEvent(payload)
    if (event.failure) throw new ModelAssetDownloadError(event.failure)
    if (!event.progress) return
    onProgress(event.progress)
    if (event.progress.percent === 100 && event.progress.status === 'done') completed = true
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consumeLine(line)
  }

  buffer += decoder.decode()
  if (buffer) consumeLine(buffer)
  if (!completed) {
    throw new ModelAssetDownloadError({
      code: 'incomplete_stream',
      stage: 'download',
      message: 'Manifest asset download ended before completion',
      retryable: true,
    })
  }
}

/**
 * Download the exact hf_downloads plan resolved by the Python registry.
 * The renderer provides only the canonical capability id; repositories,
 * revisions, target directories and files remain manifest-owned.
 */
export async function downloadModelAssetsFromHF(
  modelId: string,
  onProgress: ProgressCallback,
): Promise<void> {
  const hfToken = getSettings(app.getPath('userData')).hfToken
  return consumeStructuredModelAssetDownload(
    buildManifestAssetDownloadRequest(PYTHON_API_URL, modelId, hfToken),
    onProgress,
  )
}

/**
 * Download the exact https_downloads plan resolved by the Python registry.
 * URLs, filenames, sizes and hashes remain manifest-owned.
 */
export async function downloadModelAssetsFromHttps(
  modelId: string,
  onProgress: ProgressCallback,
): Promise<void> {
  return consumeStructuredModelAssetDownload(
    buildHttpsDownloadAssetsRequest(PYTHON_API_URL, modelId),
    onProgress,
  )
}

/**
 * Download a model from HuggingFace Hub via the Python FastAPI SSE endpoint.
 * Reports progress (0–100) via the onProgress callback.
 */
export async function downloadModelFromHF(
  repoId:        string,
  modelId:       string,
  onProgress:    ProgressCallback,
  skipPrefixes?: string[],
  includePrefixes?: string[],
): Promise<void> {
  const { net } = require('electron')
  const STALL_TIMEOUT_MS = 120_000
  let url = `${PYTHON_API_URL}/model/hf-download?repo_id=${encodeURIComponent(repoId)}&model_id=${encodeURIComponent(modelId)}`
  if (skipPrefixes && skipPrefixes.length > 0) {
    url += `&skip_prefixes=${encodeURIComponent(JSON.stringify(skipPrefixes))}`
  }
  if (includePrefixes && includePrefixes.length > 0) {
    url += `&include_prefixes=${encodeURIComponent(JSON.stringify(includePrefixes))}`
  }
  const hfToken = getSettings(app.getPath('userData')).hfToken
  if (hfToken) {
    url += `&token=${encodeURIComponent(hfToken)}`
  }

  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`HuggingFace download failed: HTTP ${res.status}`)
  if (!res.body) throw new Error('No response body from HF download stream')

  const decoder = new TextDecoder()
  const reader  = res.body.getReader()
  let buffer = ''

  async function readWithTimeout() {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Model download stalled for ${Math.round(STALL_TIMEOUT_MS / 1000)}s`)), STALL_TIMEOUT_MS)
      }),
    ])
  }

  while (true) {
    const { done, value } = await readWithTimeout()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const data = JSON.parse(line.slice(6))
        if (typeof data.percent === 'number') onProgress({
          percent:    data.percent,
          file:       data.file,
          fileIndex:  data.fileIndex,
          totalFiles: data.totalFiles,
          status:     data.status,
          bytesDownloaded: data.bytesDownloaded,
          totalBytes: data.totalBytes,
          stalledSeconds:  data.stalledSeconds,
        })
        if (data.paused) throw new Error('Model download paused')
        if (data.cancelled) throw new Error('Model download cancelled')
        if (data.error) throw new Error(`HF download error: ${data.error}`)
      } catch (e) {
        if (
          e instanceof Error &&
          (
            e.message.startsWith('HF download error:') ||
            e.message === 'Model download paused' ||
            e.message === 'Model download cancelled'
          )
        ) throw e
      }
    }
  }
}
