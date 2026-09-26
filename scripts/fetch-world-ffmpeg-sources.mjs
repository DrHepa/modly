#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadWorldFfmpegSupplyChain } from './world-ffmpeg-supply-chain.mjs'
import { syncWorldFfmpegDirectory } from './world-ffmpeg-durability.mjs'

const MAX_REDIRECTS = 0
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 60 * 60_000

export async function fetchWorldFfmpegSources(input) {
  const destination = resolveAbsoluteDirectory(input.destination)
  await assertOrdinaryDirectory(destination)
  const contract = input.contract ?? await loadWorldFfmpegSupplyChain()
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('HTTPS fetch is unavailable.')
  const deadlines = Object.freeze({
    request: requireTimeout(input.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'request'),
    download: requireTimeout(input.downloadTimeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS, 'download'),
    inactivity: requireTimeout(input.inactivityTimeoutMs, DEFAULT_INACTIVITY_TIMEOUT_MS, 'inactivity'),
  })
  const entries = [
    ...contract.sources.map(({ url, archive, sha256, maximumBytes }) => ({ url, archive, sha256, maximumBytes })),
    {
      url: contract.ffmpegReleaseSignature.url,
      archive: contract.ffmpegReleaseSignature.archive,
      sha256: null,
      maximumBytes: contract.ffmpegReleaseSignature.maximumBytes,
    },
    {
      url: contract.ffmpegReleaseSignature.keyUrl,
      archive: contract.ffmpegReleaseSignature.keyArchive,
      sha256: null,
      maximumBytes: contract.ffmpegReleaseSignature.maximumKeyBytes,
    },
  ]
  const declared = new Set(entries.map((entry) => entry.archive))
  const existing = await readdir(destination)
  if (existing.some((name) => !declared.has(name))) {
    throw new Error('World FFmpeg source destination contains an undeclared entry.')
  }
  for (const entry of entries) {
    const finalPath = join(destination, entry.archive)
    if (existing.includes(entry.archive)) {
      await verifyDownloadedFile(finalPath, entry.maximumBytes, entry.sha256)
      continue
    }
    await fetchOne({ ...entry, destination, finalPath, fetchImpl, deadlines, durability: input.durability })
  }
}

async function fetchOne(input) {
  const url = new URL(input.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('World FFmpeg source URL is not a plain HTTPS URL.')
  }
  const temporaryPath = join(input.destination, `.${input.archive}.partial-${randomBytes(8).toString('hex')}`)
  let handle = null
  const controller = new AbortController()
  try {
    const fetchOperation = Promise.resolve().then(() => input.fetchImpl(url, {
      method: 'GET', redirect: MAX_REDIRECTS === 0 ? 'error' : 'manual',
      headers: Object.freeze({ Accept: 'application/octet-stream', 'User-Agent': 'Modly-FFmpeg-source-fetch/1' }),
      signal: controller.signal,
    }))
    const response = await boundedOperation(
      fetchOperation,
      input.deadlines.request,
      'World FFmpeg source request timed out.',
      () => controller.abort(),
      cancelLateResponse,
    )
    if (!response || response.status !== 200 || !response.body) {
      throw new Error(`World FFmpeg source fetch failed with HTTP ${response?.status ?? 'unknown'}.`)
    }
    const declaredLength = response.headers?.get?.('content-length')
    if (declaredLength !== null && declaredLength !== undefined) {
      const length = Number(declaredLength)
      if (!Number.isSafeInteger(length) || length < 1 || length > input.maximumBytes) {
        throw new Error('World FFmpeg source Content-Length is invalid.')
      }
    }
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const hash = createHash('sha256')
    let size = 0
    const iterator = response.body[Symbol.asyncIterator]?.()
    if (!iterator || typeof iterator.next !== 'function') throw new Error('World FFmpeg source response body is not streamable.')
    const deadline = Date.now() + input.deadlines.download
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        controller.abort()
        detachIterator(iterator)
        throw new Error('World FFmpeg source body timed out.')
      }
      const inactivityBounded = input.deadlines.inactivity <= remaining
      const step = await boundedOperation(
        Promise.resolve().then(() => iterator.next()),
        Math.min(input.deadlines.inactivity, remaining),
        inactivityBounded
          ? 'World FFmpeg source body became inactive.'
          : 'World FFmpeg source body timed out.',
        () => {
          controller.abort()
          detachIterator(iterator)
        },
      )
      if (!step || typeof step !== 'object') throw new Error('World FFmpeg source response body is invalid.')
      if (step.done) break
      const chunk = step.value
      const bytes = Buffer.from(chunk)
      size += bytes.byteLength
      if (size > input.maximumBytes) throw new Error('World FFmpeg source exceeded its byte bound.')
      hash.update(bytes)
      await writeAll(handle, bytes)
    }
    if (size < 1) throw new Error('World FFmpeg source response was empty.')
    const digest = hash.digest('hex')
    if (input.sha256 && digest !== input.sha256) throw new Error('World FFmpeg source SHA-256 mismatch.')
    await handle.sync()
    await handle.close()
    handle = null
    await link(temporaryPath, input.finalPath)
    await rm(temporaryPath)
    await syncWorldFfmpegDirectory(input.destination, input.durability)
  } catch (error) {
    controller.abort()
    if (handle) await handle.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function boundedOperation(operation, milliseconds, message, onTimeout, onLateValue = () => undefined) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { onTimeout() } catch { /* timeout remains authoritative */ }
      rejectPromise(new Error(message))
    }, milliseconds)
    operation.then((value) => {
      if (settled) {
        try { onLateValue(value) } catch { /* late cleanup is best effort */ }
        return
      }
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }, (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
  })
}

function cancelLateResponse(response) {
  try {
    const cancellation = response?.body?.cancel?.()
    if (cancellation && typeof cancellation.catch === 'function') void cancellation.catch(() => undefined)
  } catch { /* the timeout result remains authoritative */ }
}

function detachIterator(iterator) {
  try {
    const completion = iterator.return?.()
    if (completion && typeof completion.catch === 'function') void completion.catch(() => undefined)
  } catch { /* the timeout result remains authoritative */ }
}

async function verifyDownloadedFile(path, maximumBytes, expectedSha256) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximumBytes) {
    throw new Error('Existing World FFmpeg source is not an ordinary bounded file.')
  }
  const handle = await open(path, constants.O_RDONLY)
  try {
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.byteLength
      if (size > maximumBytes) throw new Error('Existing World FFmpeg source exceeded its bound.')
      hash.update(chunk)
    }
    if (size !== info.size || (expectedSha256 && hash.digest('hex') !== expectedSha256)) {
      throw new Error('Existing World FFmpeg source SHA-256 mismatch.')
    }
  } finally {
    await handle.close()
  }
}

async function writeAll(handle, bytes) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (bytesWritten < 1) throw new Error('World FFmpeg source write made no progress.')
    offset += bytesWritten
  }
}

async function assertOrdinaryDirectory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('World FFmpeg source destination is not an ordinary directory.')
}

function resolveAbsoluteDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error('Usage: fetch-world-ffmpeg-sources.mjs --destination <absolute-existing-directory>')
  }
  return resolve(value)
}

function requireTimeout(value, fallback, label) {
  const timeout = value === undefined ? fallback : value
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`World FFmpeg source ${label} timeout is invalid.`)
  }
  return timeout
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--destination') return { destination: null }
  return { destination: argv[1] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { destination } = parseArguments(process.argv.slice(2))
  void fetchWorldFfmpegSources({ destination }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg source fetch failed.'}\n`)
    process.exitCode = 1
  })
}
