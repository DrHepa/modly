#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadWorldFfmpegPackageToolLock,
  verifyWorldFfmpegPackageToolCache,
} from './world-ffmpeg-package-tools.mjs'
import { syncWorldFfmpegDirectory } from './world-ffmpeg-durability.mjs'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 60 * 60_000
const MAX_REDIRECT_HOPS = 3
const MAX_REDIRECT_LOCATION_BYTES = 8 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export async function prepareWorldFfmpegPackageToolCache(input) {
  const target = requireTarget(input?.target)
  const cacheDirectory = requireAbsolute(input?.cacheDirectory, 'package-tool cache')
  const contract = input?.contract ?? await loadWorldFfmpegPackageToolLock()
  if (!contract.targets[target] || !contract.extractors[target]) {
    throw new Error('World FFmpeg package-tool cache is missing the authenticated target helper lock.')
  }
  const fetchImpl = input?.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('HTTPS fetch is unavailable.')
  const rootInfo = await lstat(cacheDirectory)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('World FFmpeg package-tool cache is not an ordinary directory.')
  }
  const existing = await readdir(cacheDirectory)
  if (existing.length > 0) {
    const verification = await verifyWorldFfmpegPackageToolCache({ target, cacheDirectory, contract })
    if (!verification.ok) throw new Error('World FFmpeg package-tool cache is invalid; refusing network acquisition.')
    return verification
  }
  const deadlines = Object.freeze({
    request: requireTimeout(input?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'request'),
    download: requireTimeout(input?.downloadTimeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS, 'download'),
    inactivity: requireTimeout(input?.inactivityTimeoutMs, DEFAULT_INACTIVITY_TIMEOUT_MS, 'inactivity'),
  })
  const createdDirectories = []
  try {
    for (const entry of contract.targets[target]) {
      const releaseDirectory = join(cacheDirectory, entry.release)
      if (!createdDirectories.includes(releaseDirectory)) {
        await mkdir(releaseDirectory, { mode: 0o755 })
        createdDirectories.push(releaseDirectory)
      }
      await fetchArchive({ entry, releaseDirectory, fetchImpl, deadlines, durability: input.durability })
    }
    const verification = await verifyWorldFfmpegPackageToolCache({ target, cacheDirectory, contract })
    if (!verification.ok) throw new Error(`World FFmpeg package-tool cache verification failed: ${verification.code}.`)
    await syncWorldFfmpegDirectory(cacheDirectory, input.durability)
    return verification
  } catch (error) {
    for (const directory of createdDirectories.reverse()) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
    await syncWorldFfmpegDirectory(cacheDirectory, input.durability).catch(() => undefined)
    throw error
  }
}

async function fetchArchive(input) {
  const url = new URL(input.entry.url)
  if (!isPlainHttpsUrl(url) || url.hostname !== 'github.com'
    || !url.pathname.startsWith('/electron-userland/electron-builder-binaries/releases/download/')) {
    throw new Error('World FFmpeg package-tool URL is not a plain HTTPS URL.')
  }
  const finalPath = join(input.releaseDirectory, input.entry.filename)
  const temporaryPath = join(input.releaseDirectory, `.${input.entry.filename}.partial-${randomBytes(8).toString('hex')}`)
  const controller = new AbortController()
  let handle
  try {
    const response = await fetchWithValidatedRedirects({
      initialUrl: url,
      fetchImpl: input.fetchImpl,
      requestTimeoutMs: input.deadlines.request,
      controller,
    })
    if (!response || response.status !== 200 || !response.body) {
      throw new Error(`World FFmpeg package-tool fetch failed with HTTP ${response?.status ?? 'unknown'}.`)
    }
    const declaredLength = response.headers?.get?.('content-length')
    if (declaredLength !== null && declaredLength !== undefined) {
      const length = Number(declaredLength)
      if (!Number.isSafeInteger(length) || length < 1 || length > input.entry.maximumBytes) {
        throw new Error('World FFmpeg package-tool Content-Length is invalid.')
      }
    }
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const hash = createHash('sha256')
    const iterator = response.body[Symbol.asyncIterator]?.()
    if (!iterator || typeof iterator.next !== 'function') throw new Error('World FFmpeg package-tool response body is not streamable.')
    const hardDeadline = Date.now() + input.deadlines.download
    let size = 0
    while (true) {
      const remaining = hardDeadline - Date.now()
      if (remaining <= 0) throw new Error('World FFmpeg package-tool body timed out.')
      const step = await boundedOperation(
        Promise.resolve().then(() => iterator.next()),
        Math.min(remaining, input.deadlines.inactivity),
        remaining <= input.deadlines.inactivity
          ? 'World FFmpeg package-tool body timed out.'
          : 'World FFmpeg package-tool body became inactive.',
        () => { controller.abort(); detachIterator(iterator) },
      )
      if (!step || typeof step !== 'object') throw new Error('World FFmpeg package-tool response body is invalid.')
      if (step.done) break
      const bytes = Buffer.from(step.value)
      size += bytes.byteLength
      if (size > input.entry.maximumBytes) throw new Error('World FFmpeg package-tool exceeded its byte bound.')
      hash.update(bytes)
      await writeAll(handle, bytes)
    }
    if (size < 1 || hash.digest('hex') !== input.entry.sha256) {
      throw new Error('World FFmpeg package-tool SHA-256 mismatch.')
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporaryPath, finalPath)
    await rm(temporaryPath)
    await syncWorldFfmpegDirectory(input.releaseDirectory, input.durability)
  } catch (error) {
    controller.abort()
    if (handle) await handle.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function fetchWithValidatedRedirects(input) {
  let current = input.initialUrl
  const visited = new Set([current.href])
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const request = Promise.resolve().then(() => input.fetchImpl(current, {
      method: 'GET', redirect: 'manual',
      headers: Object.freeze({ Accept: 'application/octet-stream', 'User-Agent': 'Modly-electron-builder-tool-fetch/1' }),
      signal: input.controller.signal,
    }))
    const response = await boundedOperation(
      request,
      input.requestTimeoutMs,
      'World FFmpeg package-tool request timed out.',
      () => input.controller.abort(),
      cancelLateResponse,
    )
    if (!response || typeof response.status !== 'number') {
      throw new Error('World FFmpeg package-tool response is invalid.')
    }
    if (response.redirected === true) {
      cancelLateResponse(response)
      throw new Error('World FFmpeg package-tool fetch followed an unvalidated redirect.')
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response
    cancelLateResponse(response)
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new Error('World FFmpeg package-tool redirect hop limit exceeded.')
    }
    const location = response.headers?.get?.('location')
    const next = validatedRedirectUrl(current, location)
    if (visited.has(next.href)) throw new Error('World FFmpeg package-tool redirect loop detected.')
    visited.add(next.href)
    current = next
  }
  throw new Error('World FFmpeg package-tool redirect hop limit exceeded.')
}

function validatedRedirectUrl(current, location) {
  if (typeof location !== 'string' || location.length < 1
    || Buffer.byteLength(location, 'utf8') > MAX_REDIRECT_LOCATION_BYTES
    || /[\u0000-\u001f\u007f]/.test(location)) {
    throw new Error('World FFmpeg package-tool redirect location is invalid.')
  }
  let next
  try { next = new URL(location, current) } catch {
    throw new Error('World FFmpeg package-tool redirect location is invalid.')
  }
  if (!isPlainHttpsUrl(next)) {
    throw new Error('World FFmpeg package-tool redirect must remain credential-free HTTPS on the default port.')
  }
  const validTransition = current.hostname === 'github.com'
    ? next.hostname === 'release-assets.githubusercontent.com'
    : current.hostname === 'release-assets.githubusercontent.com'
      && next.hostname === 'release-assets.githubusercontent.com'
  if (!validTransition || !next.pathname.startsWith('/github-production-release-asset/')) {
    throw new Error('World FFmpeg package-tool redirect host transition is not allowed.')
  }
  return next
}

function isPlainHttpsUrl(url) {
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port
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
      if (settled) { try { onLateValue(value) } catch { /* cleanup only */ }; return }
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
  try { void response?.body?.cancel?.()?.catch?.(() => undefined) } catch { /* cleanup only */ }
}

function detachIterator(iterator) {
  try { void iterator.return?.()?.catch?.(() => undefined) } catch { /* cleanup only */ }
}

async function writeAll(handle, bytes) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (bytesWritten < 1) throw new Error('World FFmpeg package-tool write made no progress.')
    offset += bytesWritten
  }
}

function requireTimeout(value, fallback, label) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_TIMEOUT_MS) {
    throw new Error(`World FFmpeg package-tool ${label} timeout is invalid.`)
  }
  return result
}

function requireTarget(value) {
  if (!['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'].includes(value)) {
    throw new Error('World FFmpeg package-tool target is unsupported.')
  }
  return value
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== '--target' || argv[2] !== '--cache') {
    throw new Error('Usage: prepare-electron-builder-tool-cache.mjs --target <tuple> --cache <absolute-empty-directory>')
  }
  return { target: argv[1], cacheDirectory: argv[3] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void prepareWorldFfmpegPackageToolCache(parseArguments(process.argv.slice(2))).then(() => {
    process.stdout.write('Prepared exact electron-builder package-tool cache.\n')
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg package-tool preparation failed.'}\n`)
    process.exitCode = 1
  })
}
