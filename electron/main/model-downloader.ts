/**
 * ModelDownloader — downloads models via the SSE endpoint of the Python backend.
 * No longer depends on the Go API catalog.
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
import { getSettings } from './settings-store.ts'
import { app } from 'electron'
import { buildHttpsDownloadAssetsRequest, buildManifestAssetDownloadRequest, ModelAssetDownloadError, normalizeDownloadEvent } from './model-download-events.ts'
import type { ModelSource } from './model-sources.ts'
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
  paused?: boolean
  cancelled?: boolean
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

async function throwDownloadHttpError(res: Response, fallback: string): Promise<never> {
  let body: unknown
  try {
    body = JSON.parse(await res.text())
  } catch {
    body = undefined
  }
  const detail = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { detail?: unknown }).detail
    : undefined
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const failure = detail as Record<string, unknown>
    const transientStatus = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500
    throw new ModelAssetDownloadError({
      code: typeof failure.code === 'string' ? failure.code : 'http_error',
      stage: typeof failure.stage === 'string' ? failure.stage : 'request',
      message: typeof failure.message === 'string' ? failure.message : fallback,
      retryable: failure.retryable === true && transientStatus,
    })
  }
  if (typeof detail === 'string' && /target owner/i.test(detail)) {
    throw new ModelAssetDownloadError({
      code: 'target_owner_mismatch',
      stage: 'request',
      message: detail,
      retryable: false,
    })
  }
  throw new ModelAssetDownloadError({
    code: 'http_error',
    stage: 'request',
    message: `${fallback}: HTTP ${res.status}`,
    retryable: res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500,
  })
}

function asRetryableDownloadError(error: unknown, fallback: string): ModelAssetDownloadError {
  if (error instanceof ModelAssetDownloadError) return error
  return new ModelAssetDownloadError({
    code: 'download_failed',
    stage: 'request',
    message: error instanceof Error && error.message ? error.message : fallback,
    retryable: true,
  })
}

async function consumeStructuredModelAssetDownload(
  request: StructuredAssetDownloadRequest,
  onProgress: ProgressCallback,
): Promise<void> {
  const { net } = require('electron')
  const abortController = new AbortController()
  let res: Response
  try {
    res = await net.fetch(request.url, { headers: request.headers, signal: abortController.signal })
  } catch (error) {
    throw asRetryableDownloadError(error, 'Manifest asset download request failed')
  }

  if (!res.ok) await throwDownloadHttpError(res, 'Manifest asset download failed')
  if (!res.body) {
    throw new ModelAssetDownloadError({
      code: 'missing_stream',
      stage: 'request',
      message: 'Manifest asset download returned no response stream',
      retryable: true,
    })
  }

  const decoder = new TextDecoder()
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = res.body.getReader()
  } catch (error) {
    throw asRetryableDownloadError(error, 'Manifest asset download stream failed')
  }
  let buffer = ''
  let completed = false
  let stopped = false
  const STALL_TIMEOUT_MS = 120_000

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
    if (event.progress.paused || event.progress.cancelled) {
      stopped = true
      return
    }
    if (event.progress.percent === 100 && event.progress.status === 'done') completed = true
  }

  async function readWithTimeout() {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Model download stalled for ${Math.round(STALL_TIMEOUT_MS / 1000)}s`)), STALL_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  try {
    while (true) {
      const { done, value } = await readWithTimeout()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    }

    buffer += decoder.decode()
    if (buffer) consumeLine(buffer)
    if (!completed && !stopped) {
      throw new ModelAssetDownloadError({
        code: 'incomplete_stream',
        stage: 'download',
        message: 'Manifest asset download ended before completion',
        retryable: true,
      })
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    abortController.abort()
    throw asRetryableDownloadError(error, 'Manifest asset download stream failed')
  }
}

/**
 * Download the exact hf_downloads plan resolved by the Python registry.
 * The renderer provides only the canonical capability id; repositories,
 * revisions, target directories and files remain manifest-owned.
 */
export async function downloadModelAssetsFromHF(
  modelId: string,
  targetOwnerId: string,
  onProgress: ProgressCallback,
): Promise<void> {
  const hfToken = getSettings(app.getPath('userData')).hfToken
  return consumeStructuredModelAssetDownload(
    buildManifestAssetDownloadRequest(PYTHON_API_URL, modelId, targetOwnerId, hfToken),
    onProgress,
  )
}

/**
 * Download the exact https_downloads plan resolved by the Python registry.
 * URLs, filenames, sizes and hashes remain manifest-owned.
 */
export async function downloadModelAssetsFromHttps(
  modelId: string,
  targetOwnerId: string,
  onProgress: ProgressCallback,
): Promise<void> {
  return consumeStructuredModelAssetDownload(
    buildHttpsDownloadAssetsRequest(PYTHON_API_URL, modelId, targetOwnerId),
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
  const abortController = new AbortController()
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

  let res: Response
  try {
    res = await net.fetch(url, { signal: abortController.signal })
  } catch (error) {
    throw asRetryableDownloadError(error, 'HuggingFace download request failed')
  }
  if (!res.ok) await throwDownloadHttpError(res, 'HuggingFace download failed')
  await consumeDownloadStream(res, onProgress, () => abortController.abort())
}

/** Download a validated node-level source plan through one aggregate SSE stream. */
export async function downloadModelSourcesFromHF(
  modelId: string,
  targetOwnerId: string,
  sources: ModelSource[],
  onProgress: ProgressCallback,
): Promise<void> {
  const { net } = require('electron')
  const abortController = new AbortController()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const hfToken = getSettings(app.getPath('userData')).hfToken
  if (hfToken) headers.Authorization = `Bearer ${hfToken}`
  const url = `${PYTHON_API_URL}/model/hf-download-sources?model_id=${encodeURIComponent(modelId)}&target_owner_id=${encodeURIComponent(targetOwnerId)}`
  let res: Response
  try {
    res = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: abortController.signal,
    })
  } catch (error) {
    throw asRetryableDownloadError(error, 'HuggingFace multi-source download request failed')
  }
  if (!res.ok) await throwDownloadHttpError(res, 'HuggingFace multi-source download failed')
  await consumeDownloadStream(res, onProgress, () => abortController.abort())
}

async function consumeDownloadStream(
  res: Response,
  onProgress: ProgressCallback,
  abortRequest: () => void = () => undefined,
): Promise<void> {
  if (!res.body) {
    throw new ModelAssetDownloadError({
      code: 'missing_stream',
      stage: 'request',
      message: 'HuggingFace download returned no response stream',
      retryable: true,
    })
  }

  const decoder = new TextDecoder()
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = res.body.getReader()
  } catch (error) {
    throw asRetryableDownloadError(error, 'HuggingFace download stream failed')
  }
  let buffer = ''
  let completed = false
  let stopped = false
  const STALL_TIMEOUT_MS = 120_000

  const consumeLine = (line: string): void => {
    if (!line.startsWith('data: ')) return
    let data: unknown
    try {
      data = JSON.parse(line.slice(6))
    } catch {
      return
    }

    const normalized = normalizeDownloadEvent(data)
    if (normalized.failure) throw new ModelAssetDownloadError(normalized.failure)
    if (!normalized.progress) return

    onProgress(normalized.progress)
    if (normalized.progress.paused || normalized.progress.cancelled) {
      stopped = true
      return
    }
    if (normalized.progress.percent === 100 && normalized.progress.status === 'done') {
      completed = true
    }
  }

  async function readWithTimeout() {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Model download stalled for ${Math.round(STALL_TIMEOUT_MS / 1000)}s`)), STALL_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  try {
    while (true) {
      const { done, value } = await readWithTimeout()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    }

    buffer += decoder.decode()
    if (buffer) consumeLine(buffer)

    if (!completed && !stopped) {
      throw new ModelAssetDownloadError({
        code: 'incomplete_stream',
        stage: 'download',
        message: 'HuggingFace download ended before completion',
        retryable: true,
      })
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    abortRequest()
    throw asRetryableDownloadError(error, 'HuggingFace download stream failed')
  }
}
