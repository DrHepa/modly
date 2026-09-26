import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { isAbsolute } from 'node:path'

const PUBLIC_API_URL = 'https://api.github.com/'
const MAX_JSON_BYTES = 1024 * 1024
const MAX_RECEIPT_BYTES = 256 * 1024
const MAX_REDIRECT_RESPONSE_BYTES = 64 * 1024
const DEFAULT_OPERATION_DEADLINE_MS = 45 * 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_AFTER_CAP_MS = 5_000
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CONTENT_ADDRESSED_ASSET_PATTERN = /^world-ffmpeg-([a-z0-9-]{1,80})-([a-f0-9]{64})-([A-Za-z0-9][A-Za-z0-9._-]{0,80})$/

export function worldFfmpegGithubContentAddressedAssetName(namespace, sha256, kind) {
  if (typeof namespace !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(namespace)
    || !SHA256_PATTERN.test(sha256)
    || typeof kind !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(kind)) {
    throw new Error('World FFmpeg content-addressed GitHub asset identity is invalid.')
  }
  return `world-ffmpeg-${namespace}-${sha256}-${kind}`
}

export function bindWorldFfmpegGithubReleaseMutations(client, { releaseId, metadata }) {
  requirePositiveInteger(releaseId, 'GitHub release id')
  const expected = requirePublicationMetadata(metadata)
  const preflight = async () => {
    const getRelease = client?.getRelease ?? client?.getDraftRelease
    if (typeof getRelease !== 'function') throw new Error('World FFmpeg mutation cannot prove current release authority.')
    const release = await getRelease.call(client)
    if (release?.id !== releaseId) throw new Error('World FFmpeg mutation release id conflicts with setup authority.')
    requireMatchingDraft(release, expected)
  }
  return Object.freeze({
    ...client,
    async uploadAsset(input) {
      if (input.releaseId !== releaseId) throw new Error('World FFmpeg upload release id conflicts with setup authority.')
      await preflight()
      return client.uploadAsset({ ...input, metadata: expected })
    },
    ...(typeof client.deleteAsset === 'function' ? {
      async deleteAsset(asset) {
        await preflight()
        return client.deleteAsset(asset, { releaseId, metadata: expected })
      },
    } : {}),
  })
}

export async function pruneWorldFfmpegGithubAssetNamespace(input) {
  const client = requireReleaseClient(input?.client)
  const releaseId = requirePositiveInteger(input?.releaseId, 'GitHub release id')
  const namespace = requireWorldFfmpegGithubAssetNamespace(input?.namespace)
  if (!Array.isArray(input?.keep) || input.keep.length < 1 || input.keep.length > 64) {
    throw new Error('World FFmpeg retained GitHub asset set is invalid.')
  }
  const keep = new Map()
  for (const value of input.keep) {
    const descriptor = requireExpectedAsset(value)
    if (!isExactOwnedContentAddressedName(descriptor.name, descriptor.sha256, namespace)
      || keep.has(descriptor.name)) {
      throw new Error('World FFmpeg retained GitHub asset namespace is invalid.')
    }
    keep.set(descriptor.name, descriptor)
  }
  const prefix = `world-ffmpeg-${namespace}-`
  const stale = (await client.listAssets(releaseId)).filter(({ name }) => (
    name.startsWith(prefix) && !keep.has(name)
  ))
  for (const asset of stale) {
    const parsed = parseOwnedContentAddressedName(asset.name)
    if (!parsed || parsed.namespace !== namespace || asset.state === 'starter' || asset.size < 1
      || typeof client.deleteAsset !== 'function') {
      throw new Error(`World FFmpeg stale remote asset is not safely reclaimable: ${asset.name}.`)
    }
    await client.verifyAsset({
      asset,
      expected: { name: asset.name, size: asset.size, sha256: parsed.sha256 },
    })
    await client.deleteAsset(asset)
    const survivors = (await client.listAssets(releaseId)).filter(({ id }) => id === asset.id)
    if (survivors.length !== 0) {
      throw new Error(`World FFmpeg stale remote asset deletion did not settle: ${asset.name}.`)
    }
  }
  return Object.freeze({ namespace, retained: Object.freeze([...keep.keys()].sort()) })
}

export function createWorldFfmpegGithubReleaseClient(input) {
  const repository = requireWorldFfmpegRepository(input?.repository)
  const tag = requireWorldFfmpegReleaseTag(input?.tag)
  const token = requireWorldFfmpegGithubToken(input?.token)
  const api = requireGithubApiAuthority(input?.apiUrl ?? process.env.GITHUB_API_URL ?? PUBLIC_API_URL)
  let initialRelease
  const now = input?.now ?? Date.now
  const sleep = input?.sleep ?? ((milliseconds) => new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds)
  }))
  const requestFactory = input?.requestFactory ?? httpsRequest
  const operationDeadlineMs = requireBoundedInteger(
    input?.operationDeadlineMs ?? DEFAULT_OPERATION_DEADLINE_MS,
    1,
    DEFAULT_OPERATION_DEADLINE_MS,
    'GitHub release operation deadline',
  )
  const requestTimeoutMs = requireBoundedInteger(
    input?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    DEFAULT_REQUEST_TIMEOUT_MS,
    'GitHub request timeout',
  )
  const maxAttempts = requireBoundedInteger(
    input?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    1,
    5,
    'GitHub retry attempts',
  )
  const retryAfterCapMs = requireBoundedInteger(
    input?.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS,
    0,
    DEFAULT_RETRY_AFTER_CAP_MS,
    'GitHub Retry-After cap',
  )
  if (typeof now !== 'function' || typeof sleep !== 'function' || typeof requestFactory !== 'function') {
    throw new Error('World FFmpeg GitHub release client dependencies are invalid.')
  }
  const deadlineAt = now() + operationDeadlineMs
  const requestOnce = (request) => _testOnlyGithubRequestOnce({
    ...request,
    token: request.token === null ? undefined : token,
    requestFactory,
    operationDeadlineMs: remaining(deadlineAt, now),
    requestTimeoutMs: Math.min(requestTimeoutMs, remaining(deadlineAt, now)),
  })
  const safeRequest = (operation) => _testOnlyRetrySafeGithubOperation(operation, {
    safe: true,
    maxAttempts,
    retryAfterCapMs,
    sleep,
    now,
    deadlineAt,
  })

  async function findRelease() {
    const response = await safeRequest(() => requestOnce({
      hostname: api.hostname,
      port: api.port,
      path: apiPath(api, `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`),
      method: 'GET',
      maxResponseBytes: MAX_JSON_BYTES,
    }))
    if (response.statusCode === 404) return null
    requireStatus(response, 200, 'release lookup')
    const release = requireRelease(
      JSON.parse(response.bytes.toString('utf8')), tag, repository, api, response.headers.etag,
    )
    initialRelease ??= release
    return release
  }

  async function getDraftRelease() {
    const release = await findRelease()
    if (!release || release.draft !== true) {
      throw new Error('World FFmpeg GitHub release is not the exact private draft authority.')
    }
    return release
  }

  async function ensureRelease({ title, body, targetCommitish }) {
    const expectedTitle = requireReleaseTitle(title)
    const expectedBody = requireReleaseBody(body)
    const expectedTargetCommitish = requireTargetCommitish(targetCommitish)
    const existing = await findRelease()
    if (existing) return requireMatchingRelease(existing, {
      title: expectedTitle,
      body: expectedBody,
      targetCommitish: expectedTargetCommitish,
    })
    const requestBody = Buffer.from(JSON.stringify({
      tag_name: tag,
      target_commitish: expectedTargetCommitish,
      name: expectedTitle,
      body: expectedBody,
      draft: true,
      generate_release_notes: false,
    }))
    let lastError
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await requestOnce({
          hostname: api.hostname,
          port: api.port,
          path: apiPath(api, `/repos/${repository}/releases`),
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(requestBody.byteLength) },
          body: requestBody,
          maxResponseBytes: MAX_JSON_BYTES,
        })
        if (response.statusCode !== 201) throw githubStatusError(response, 'draft creation')
        const created = requireMatchingDraft(
          requireRelease(
            JSON.parse(response.bytes.toString('utf8')), tag, repository, api, response.headers.etag,
          ),
          { title: expectedTitle, body: expectedBody, targetCommitish: expectedTargetCommitish },
        )
        initialRelease ??= created
        return created
      } catch (error) {
        lastError = error
        const reconciled = await findRelease()
        if (reconciled) return requireMatchingRelease(reconciled, {
          title: expectedTitle,
          body: expectedBody,
          targetCommitish: expectedTargetCommitish,
        })
        if (error?.statusCode === 422 || error?.retryable !== true || attempt === maxAttempts) throw error
        await boundedRetrySleep(error, { retryAfterCapMs, sleep, now, deadlineAt })
      }
    }
    throw lastError
  }

  async function ensureDraftRelease({ title, body, targetCommitish }) {
    const metadata = {
      title: requireReleaseTitle(title),
      body: requireReleaseBody(body),
      targetCommitish: requireTargetCommitish(targetCommitish),
    }
    return requireMatchingDraft(await ensureRelease(metadata), metadata)
  }

  async function listAssets(releaseId) {
    requirePositiveInteger(releaseId, 'GitHub release id')
    const assets = []
    for (let page = 1; page <= 10; page += 1) {
      const response = await safeRequest(() => requestOnce({
        hostname: api.hostname,
        port: api.port,
        path: apiPath(api, `/repos/${repository}/releases/${releaseId}/assets?per_page=100&page=${page}`),
        method: 'GET',
        maxResponseBytes: MAX_JSON_BYTES,
      }))
      requireStatus(response, 200, 'asset listing')
      const values = JSON.parse(response.bytes.toString('utf8'))
      if (!Array.isArray(values)) throw new Error('World FFmpeg GitHub asset listing is invalid.')
      for (const value of values) assets.push(requireRemoteAsset(value))
      if (values.length < 100) return Object.freeze(assets)
    }
    throw new Error('World FFmpeg GitHub asset listing exceeded its pagination bound.')
  }

  async function downloadResponseOnce(asset, maximumBytes, consume) {
    const first = await requestOnce({
      hostname: api.hostname,
      port: api.port,
      path: apiPath(api, `/repos/${repository}/releases/assets/${asset.id}`),
      method: 'GET',
      headers: { accept: 'application/octet-stream' },
      maxResponseBytes: maximumBytes,
      maxRedirectResponseBytes: MAX_REDIRECT_RESPONSE_BYTES,
      consume: (chunk, response) => {
        if (response.statusCode === 200) consume(chunk)
      },
    })
    if (first.statusCode === 200) return first
    if (first.statusCode !== 302) throw githubStatusError(first, 'asset download')
    const redirect = requireAssetRedirect(first.headers.location, api)
    const response = await requestOnce({
      hostname: redirect.hostname,
      port: redirect.port || 443,
      path: `${redirect.pathname}${redirect.search}`,
      method: 'GET',
      token: null,
      maxResponseBytes: maximumBytes,
      consume,
    })
    requireStatus(response, 200, 'asset download redirect')
    return response
  }

  async function verifyAsset({ asset, expected }) {
    const remote = requireRemoteAsset(asset)
    const descriptor = requireExpectedAsset(expected)
    if (remote.name !== descriptor.name || remote.size !== descriptor.size) {
      throw new Error(`World FFmpeg remote asset conflict: ${descriptor.name}.`)
    }
    return safeRequest(async () => {
      const hash = createHash('sha256')
      let size = 0
      const response = await downloadResponseOnce(remote, descriptor.size + 1, (chunk) => {
        size += chunk.byteLength
        if (size > descriptor.size) throw new Error(`World FFmpeg remote asset exceeded expected size: ${descriptor.name}.`)
        hash.update(chunk)
      })
      if (response.statusCode !== 200 || size !== descriptor.size || hash.digest('hex') !== descriptor.sha256) {
        throw new Error(`World FFmpeg remote asset digest conflict: ${descriptor.name}.`)
      }
      return Object.freeze({ size, sha256: descriptor.sha256 })
    })
  }

  async function readAsset({ asset, maximumBytes }) {
    const remote = requireRemoteAsset(asset)
    const maximum = requireBoundedInteger(maximumBytes, 1, MAX_RECEIPT_BYTES, 'remote receipt byte bound')
    return safeRequest(async () => {
      const chunks = []
      let size = 0
      const response = await downloadResponseOnce(remote, maximum, (chunk) => {
        size += chunk.byteLength
        if (size > maximum) throw new Error('World FFmpeg remote receipt exceeded its byte bound.')
        chunks.push(Buffer.from(chunk))
      })
      requireStatus(response, 200, 'receipt download')
      return Buffer.concat(chunks, size)
    })
  }

  async function requireCurrentDraft(releaseId, metadata) {
    const expected = metadata ?? initialRelease
    const release = await findRelease()
    if (!release || release.id !== releaseId) throw new Error('World FFmpeg mutation release id is not authoritative.')
    return requireMatchingDraft(release, expected ?? release)
  }

  async function uploadAsset({ releaseId, name, size, chunks, metadata }) {
    requirePositiveInteger(releaseId, 'GitHub release id')
    const descriptor = requireExpectedAsset({ name, size, sha256: '0'.repeat(64) })
    if (!chunks || typeof chunks[Symbol.asyncIterator] !== 'function') {
      throw new Error('World FFmpeg GitHub upload stream is invalid.')
    }
    const { upload } = await requireCurrentDraft(releaseId, metadata)
    const response = await requestOnce({
      hostname: upload.hostname,
      port: upload.port,
      path: `${upload.path}?name=${encodeURIComponent(descriptor.name)}`,
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(descriptor.size) },
      chunks,
      maxResponseBytes: MAX_JSON_BYTES,
    })
    if (response.statusCode !== 201) throw githubStatusError(response, 'asset upload', true)
    const asset = requireRemoteAsset(JSON.parse(response.bytes.toString('utf8')))
    if (asset.name !== descriptor.name || asset.size !== descriptor.size) {
      throw new Error('World FFmpeg GitHub upload returned a mismatched asset identity.')
    }
    return Object.freeze({ assetId: asset.id, name: asset.name, size: asset.size })
  }

  async function publishRelease({ releaseId, metadata }) {
    requirePositiveInteger(releaseId, 'GitHub release id')
    const expected = requirePublicationMetadata(metadata, tag)
    const body = canonicalJsonBytes({
      tag_name: tag,
      target_commitish: expected.targetCommitish,
      name: expected.title,
      body: expected.body,
      draft: false,
      make_latest: 'true',
    }, false)
    const requestSha256 = createHash('sha256').update(body).digest('hex')
    const metadataSha256 = releaseMetadataSha256(expected)
    // Last-moment revalidation catches stale workflow snapshots. GitHub does
    // not make this GET and the following mutation atomic; do not claim CAS
    // ownership or undo a public transition if another actor changes it later.
    const current = await findRelease()
    if (current?.id !== releaseId) throw new Error('World FFmpeg publication release id conflicts with setup authority.')
    requireMatchingRelease(current, expected)
    if (!current.draft) {
      return Object.freeze({
        release: current,
        publicationProof: releasePublicationProof({
          releaseId, tag, requestSha256, metadataSha256, settlement: 'public-reconciliation',
        }),
      })
    }
    try {
      const response = await requestOnce({
        hostname: api.hostname,
        port: api.port,
        path: apiPath(api, `/repos/${repository}/releases/${releaseId}`),
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.byteLength),
        },
        body,
        maxResponseBytes: MAX_JSON_BYTES,
      })
      if (response.statusCode !== 200) throw githubStatusError(response, 'release publication', true)
      const release = requireRelease(
        JSON.parse(response.bytes.toString('utf8')), tag, repository, api, response.headers.etag,
      )
      requireExactReleaseMetadata(release, expected, false)
      if (release.id !== releaseId) {
        throw new Error('World FFmpeg GitHub publication returned the wrong release authority.')
      }
      return Object.freeze({
        release,
        publicationProof: releasePublicationProof({
          releaseId, tag, requestSha256, metadataSha256, settlement: 'patch-response',
        }),
      })
    } catch (error) {
      const reconciled = await findRelease()
      if (reconciled?.id === releaseId) {
        try {
          requireExactReleaseMetadata(reconciled, expected, false)
          return Object.freeze({
            release: reconciled,
            publicationProof: releasePublicationProof({
              releaseId, tag, requestSha256, metadataSha256, settlement: 'public-reconciliation',
            }),
          })
        } catch {
          // The original PATCH failure remains authoritative unless the exact
          // configured public state is independently visible.
        }
      }
      throw error
    }
  }

  async function deleteAsset(asset, authority = {}) {
    const remote = requireRemoteAsset(asset)
    const expected = authority.metadata ?? initialRelease ?? await findRelease()
    const releaseId = requirePositiveInteger(authority.releaseId ?? initialRelease?.id, 'GitHub release id')
    let lastError
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await requireCurrentDraft(releaseId, expected)
      try {
        const response = await requestOnce({
          hostname: api.hostname,
          port: api.port,
          path: apiPath(api, `/repos/${repository}/releases/assets/${remote.id}`),
          method: 'DELETE',
          maxResponseBytes: MAX_JSON_BYTES,
        })
        if (response.statusCode !== 204 && response.statusCode !== 404) {
          throw githubStatusError(response, 'asset deletion', true)
        }
      } catch (error) {
        lastError = error
      }
      const release = await findRelease()
      if (!release) throw new Error('World FFmpeg release disappeared during asset deletion.')
      const survivors = (await listAssets(release.id)).filter(({ id }) => id === remote.id)
      if (survivors.length === 0) return Object.freeze({ assetId: remote.id, deleted: true })
      if (!lastError) {
        lastError = retryableError('World FFmpeg GitHub asset deletion is not yet visible.')
      }
      if (attempt === maxAttempts || lastError?.retryable !== true) {
        throw lastError ?? new Error('World FFmpeg GitHub asset deletion did not settle.')
      }
      await boundedRetrySleep(lastError, { retryAfterCapMs, sleep, now, deadlineAt })
    }
    throw lastError
  }

  return Object.freeze({
    repository,
    tag,
    apiUrl: api.url,
    getRelease: findRelease,
    getDraftRelease,
    ensureRelease,
    ensureDraftRelease,
    listAssets,
    verifyAsset,
    readAsset,
    uploadAsset,
    deleteAsset,
    publishRelease,
    waitForRetry: (error) => boundedRetrySleep(error, {
      retryAfterCapMs, sleep, now, deadlineAt,
    }),
  })
}

export async function reconcileWorldFfmpegGithubAsset(input) {
  const client = requireReleaseClient(input?.client)
  const releaseId = requirePositiveInteger(input?.releaseId, 'GitHub release id')
  const expected = requireExpectedAsset(input?.expected)
  if (typeof input?.createStream !== 'function') {
    throw new Error('World FFmpeg reconciled upload stream factory is invalid.')
  }
  const maxAttempts = requireBoundedInteger(input?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, 5, 'upload attempts')
  const findExisting = async () => {
    const matches = (await client.listAssets(releaseId)).filter(({ name }) => name === expected.name)
    if (matches.length > 1) throw new Error(`World FFmpeg remote asset name is ambiguous: ${expected.name}.`)
    if (matches.length === 0) return null
    const asset = matches[0]
    if (asset.state === 'starter' || asset.size === 0) {
      if (!isExactOwnedContentAddressedName(expected.name, expected.sha256)
        || typeof client.deleteAsset !== 'function') {
        throw new Error(`World FFmpeg remote starter asset is not safely reclaimable: ${expected.name}.`)
      }
      await client.deleteAsset(asset)
      const survivors = (await client.listAssets(releaseId)).filter(({ id }) => id === asset.id)
      if (survivors.length !== 0) {
        throw new Error(`World FFmpeg remote starter asset deletion did not settle: ${expected.name}.`)
      }
      return null
    }
    await client.verifyAsset({ asset, expected })
    return Object.freeze({ assetId: asset.id, name: asset.name, size: asset.size, sha256: expected.sha256 })
  }
  const reconcileAmbiguous = async (error) => {
    for (let observation = 0; observation < maxAttempts; observation += 1) {
      const existing = await findExisting()
      if (existing) return existing
      if (observation + 1 < maxAttempts) await client.waitForRetry?.(error)
    }
    return null
  }
  const existing = await findExisting()
  if (existing) return existing
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const stream = input.createStream()
    try {
      const uploaded = await client.uploadAsset({
        releaseId,
        name: expected.name,
        size: expected.size,
        chunks: stream.chunks,
      })
      stream.assertComplete()
      const reconciled = await findExisting()
      if (!reconciled || reconciled.assetId !== uploaded.assetId) {
        throw new Error(`World FFmpeg uploaded asset did not reconcile: ${expected.name}.`)
      }
      return reconciled
    } catch (error) {
      lastError = error
      const reconciled = error?.ambiguous === true || error?.statusCode === 409 || error?.statusCode === 422
        ? await reconcileAmbiguous(error)
        : await findExisting()
      if (reconciled) return reconciled
      const retryable = error?.retryable === true
      if (error?.statusCode === 422 || !retryable || attempt === maxAttempts) throw error
      await client.waitForRetry?.(error)
    }
  }
  throw lastError
}

export async function _testOnlyGithubRequestOnce(input) {
  const hostname = requireHostname(input?.hostname)
  const port = requireHttpsPort(input?.port ?? 443)
  const path = requireRequestPath(input?.path)
  const method = requireMethod(input?.method)
  const requestFactory = input?.requestFactory ?? httpsRequest
  const operationDeadlineMs = requireBoundedInteger(
    input?.operationDeadlineMs ?? DEFAULT_OPERATION_DEADLINE_MS,
    1,
    DEFAULT_OPERATION_DEADLINE_MS,
    'GitHub request operation deadline',
  )
  const requestTimeoutMs = requireBoundedInteger(
    input?.requestTimeoutMs ?? Math.min(DEFAULT_REQUEST_TIMEOUT_MS, operationDeadlineMs),
    1,
    Math.min(DEFAULT_REQUEST_TIMEOUT_MS, operationDeadlineMs),
    'GitHub request timeout',
  )
  const maximumBytes = requireBoundedInteger(
    input?.maxResponseBytes ?? MAX_JSON_BYTES,
    1,
    16 * 1024 * 1024 * 1024,
    'GitHub response byte bound',
  )
  const maximumRedirectBytes = requireBoundedInteger(
    input?.maxRedirectResponseBytes ?? Math.min(maximumBytes, MAX_JSON_BYTES),
    1,
    MAX_JSON_BYTES,
    'GitHub redirect response byte bound',
  )
  if (typeof requestFactory !== 'function' || (input?.consume !== undefined && typeof input.consume !== 'function')) {
    throw new Error('World FFmpeg GitHub request dependencies are invalid.')
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let responseEnded = false
    let responseSize = 0
    const responseChunks = []
    let bodyDone = input?.chunks === undefined
    let iterator
    let request
    let activeResponse
    const timer = setTimeout(() => {
      fail(retryableError('World FFmpeg GitHub operation deadline expired.', { code: 'ETIMEDOUT' }))
    }, operationDeadlineMs)
    const onRequestTimeout = () => fail(retryableError(
      'World FFmpeg GitHub request timed out.', { code: 'ETIMEDOUT' },
    ))
    const onRequestAbort = () => fail(new Error('World FFmpeg GitHub request was aborted.'))
    const onRequestClose = () => {
      if (!responseEnded) fail(new Error('World FFmpeg GitHub request closed before the operation settled.'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      request?.removeListener?.('timeout', onRequestTimeout)
      request?.removeListener?.('abort', onRequestAbort)
      request?.removeListener?.('close', onRequestClose)
    }
    const cancelIterator = () => {
      if (!bodyDone && iterator?.return) {
        try { void Promise.resolve(iterator.return()).catch(() => undefined) } catch { /* primary failure wins */ }
      }
    }
    const fail = (error, retryable = true) => {
      if (settled) return
      settled = true
      cleanup()
      cancelIterator()
      try { activeResponse?.destroy?.() } catch { /* best effort */ }
      try { request?.destroy?.() } catch { /* best effort */ }
      rejectPromise(retryable ? asGithubNetworkError(error) : error)
    }
    const succeed = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(value)
    }
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'modly-world-ffmpeg-release-custody-v1',
      'x-github-api-version': '2022-11-28',
      ...(input.token ? { authorization: `Bearer ${requireWorldFfmpegGithubToken(input.token)}` } : {}),
      ...input.headers,
    }
    try {
      request = requestFactory({
        protocol: 'https:', hostname, port, path, method,
        agent: false, timeout: requestTimeoutMs, headers,
      }, (response) => {
        try {
          activeResponse = response
          if (!response || typeof response.on !== 'function' || typeof response.once !== 'function') {
            throw new Error('World FFmpeg GitHub response authority is invalid.')
          }
          const statusCode = response.statusCode
          const responseHeaders = normalizeHeaders(response.headers)
          const responseMaximumBytes = statusCode === 302 ? maximumRedirectBytes : maximumBytes
          response.on('data', (chunk) => {
            if (settled) return
            const bytes = Buffer.from(chunk)
            responseSize += bytes.byteLength
            if (responseSize > responseMaximumBytes) {
              response.destroy?.()
              fail(new Error('World FFmpeg GitHub response exceeded its byte bound.'), false)
              return
            }
            try {
              if (input.consume) input.consume(bytes, { statusCode, headers: responseHeaders })
              else responseChunks.push(bytes)
            } catch (error) {
              response.destroy?.()
              fail(error, false)
            }
          })
          response.once('aborted', () => fail(new Error('World FFmpeg GitHub response was aborted.')))
          response.once('error', fail)
          response.once('end', () => {
            responseEnded = true
            if (!bodyDone) {
              fail(new Error('World FFmpeg GitHub response completed before the request body settled.'))
              return
            }
            succeed(Object.freeze({
              statusCode,
              headers: responseHeaders,
              bytes: input.consume ? Buffer.alloc(0) : Buffer.concat(responseChunks, responseSize),
              size: responseSize,
            }))
          })
          response.once('close', () => {
            if (!responseEnded) fail(new Error('World FFmpeg GitHub response closed before completion.'))
          })
        } catch (error) {
          fail(error, false)
        }
      })
      if (!request || typeof request.once !== 'function' || typeof request.removeListener !== 'function'
        || typeof request.end !== 'function' || typeof request.write !== 'function') {
        throw new Error('World FFmpeg GitHub request authority is invalid.')
      }
      if (settled) {
        request.destroy?.()
        return
      }
    } catch (error) {
      fail(error, false)
      return
    }
    request.once('timeout', onRequestTimeout)
    request.once('error', fail)
    request.once('abort', onRequestAbort)
    request.once('close', onRequestClose)
    if (input.chunks) {
      iterator = input.chunks[Symbol.asyncIterator]()
      void (async () => {
        try {
          while (!settled) {
            const next = await iterator.next()
            if (next.done) break
            const chunk = Buffer.from(next.value)
            if (!request.write(chunk)) await waitForRequestDrain(request)
          }
          if (settled) return
          bodyDone = true
          request.end()
        } catch (error) {
          const failure = Object.assign(
            error instanceof Error ? error : new Error('World FFmpeg GitHub upload stream failed.'),
            { ambiguous: true },
          )
          fail(failure, failure.retryable === true)
        }
      })()
    } else {
      try {
        if (input.body) request.write(input.body)
        bodyDone = true
        request.end()
      } catch (error) {
        fail(error, false)
      }
    }
  })
}

function waitForRequestDrain(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      request.removeListener('drain', onDrain)
      request.removeListener('error', onError)
      request.removeListener('close', onClose)
      request.removeListener('abort', onAbort)
    }
    const onDrain = () => {
      cleanup()
      resolvePromise()
    }
    const onError = (error) => {
      cleanup()
      rejectPromise(error)
    }
    const onClose = () => {
      cleanup()
      rejectPromise(new Error('World FFmpeg GitHub request closed during upload backpressure.'))
    }
    const onAbort = () => {
      cleanup()
      rejectPromise(new Error('World FFmpeg GitHub request was aborted during upload backpressure.'))
    }
    request.once('drain', onDrain)
    request.once('error', onError)
    request.once('close', onClose)
    request.once('abort', onAbort)
  })
}

export async function _testOnlyRetrySafeGithubOperation(operation, options = {}) {
  if (typeof operation !== 'function') throw new Error('World FFmpeg GitHub retry operation is invalid.')
  const safe = options.safe ?? true
  const maxAttempts = requireBoundedInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, 5, 'retry attempts')
  const retryAfterCapMs = requireBoundedInteger(
    options.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS,
    0,
    DEFAULT_RETRY_AFTER_CAP_MS,
    'Retry-After cap',
  )
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)))
  const now = options.now ?? Date.now
  const deadlineAt = options.deadlineAt ?? (now() + DEFAULT_OPERATION_DEADLINE_MS)
  if (!safe) return operation()
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await operation()
      if (!RETRYABLE_STATUSES.has(response?.statusCode) || attempt === maxAttempts) return response
      await boundedRetrySleep(githubStatusError(response, 'safe request'), {
        retryAfterCapMs, sleep, now, deadlineAt,
      })
    } catch (error) {
      lastError = error
      if (error?.retryable !== true || attempt === maxAttempts) throw error
      await boundedRetrySleep(error, { retryAfterCapMs, sleep, now, deadlineAt })
    }
  }
  throw lastError
}

export async function writeWorldFfmpegGithubOutput(path, key, value, dependencies = {}) {
  return writeWorldFfmpegGithubOutputs(path, [{ key, value }], dependencies)
}

export async function writeWorldFfmpegGithubOutputs(path, entries, dependencies = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || /[\r\n]/.test(path)
    || !Array.isArray(entries) || entries.length < 1 || entries.length > 16) {
    throw new Error('World FFmpeg GitHub output authority is invalid.')
  }
  const keys = new Set()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.key !== 'string' || !/^[A-Z][A-Z0-9_]{0,100}$/.test(entry.key)
      || keys.has(entry.key)
      || typeof entry.value !== 'string' || entry.value.length < 1 || entry.value.length > 256 * 1024
      || /[\0\r\n]/.test(entry.value)) {
      throw new Error('World FFmpeg GitHub output authority is invalid.')
    }
    keys.add(entry.key)
  }
  const pathInfo = await lstat(path)
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1) {
    throw new Error('World FFmpeg GitHub output file is not an ordinary single-link file.')
  }
  const handle = await open(path, constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
  let primaryError
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino) {
      throw new Error('World FFmpeg GitHub output identity changed before open.')
    }
    await dependencies.afterOpen?.({ path, identity: { dev: opened.dev, ino: opened.ino } })
    await handle.writeFile(entries.map(({ key, value }) => `${key}=${value}\n`).join(''))
    await handle.sync()
    const after = await handle.stat()
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size < opened.size) {
      throw new Error('World FFmpeg GitHub output identity changed during write.')
    }
    await dependencies.beforePathRevalidate?.({ path, identity: { dev: opened.dev, ino: opened.ino } })
    const publicAfter = await lstat(path)
    if (!publicAfter.isFile() || publicAfter.isSymbolicLink() || publicAfter.nlink !== 1
      || publicAfter.dev !== opened.dev || publicAfter.ino !== opened.ino
      || publicAfter.size !== after.size) {
      throw new Error('World FFmpeg GitHub output pathname was replaced or its identity changed.')
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try { await handle.close() } catch (error) {
      throw new AggregateError(
        primaryError ? [primaryError, error] : [error],
        'World FFmpeg GitHub output descriptor release failed.',
      )
    }
  }
}

export function encodeWorldFfmpegReleaseReceipt(value) {
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_RECEIPT_BYTES) {
    throw new Error('World FFmpeg release receipt exceeded its encoding bound.')
  }
  return bytes.toString('base64')
}

export function decodeWorldFfmpegReleaseReceipt(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > MAX_RECEIPT_BYTES * 2
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('World FFmpeg release receipt encoding is invalid.')
  }
  try {
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') !== value) throw new Error('noncanonical')
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!bytes.equals(Buffer.from(JSON.stringify(parsed)))) throw new Error('noncanonical')
    return parsed
  } catch {
    throw new Error('World FFmpeg release receipt encoding is invalid.')
  }
}

function requireReleaseClient(value) {
  for (const method of ['listAssets', 'verifyAsset', 'uploadAsset']) {
    if (typeof value?.[method] !== 'function') throw new Error('World FFmpeg release client is invalid.')
  }
  return value
}

function requireExpectedAsset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(value.name)
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 16 * 1024 * 1024 * 1024
    || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error('World FFmpeg expected remote asset descriptor is invalid.')
  }
  return Object.freeze({ name: value.name, size: value.size, sha256: value.sha256 })
}

function requireRemoteAsset(value) {
  const id = value?.id ?? value?.assetId
  if (!Number.isSafeInteger(id) || id < 1
    || typeof value?.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(value.name)
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 16 * 1024 * 1024 * 1024
    || (value.state !== undefined && value.state !== 'uploaded' && value.state !== 'starter')) {
    throw new Error('World FFmpeg remote GitHub asset identity is invalid.')
  }
  return Object.freeze({ id, name: value.name, size: value.size, ...(value.state ? { state: value.state } : {}) })
}

function parseOwnedContentAddressedName(name) {
  const match = CONTENT_ADDRESSED_ASSET_PATTERN.exec(name)
  return match ? Object.freeze({ namespace: match[1], sha256: match[2], kind: match[3] }) : null
}

function isExactOwnedContentAddressedName(name, expectedSha256, expectedNamespace = undefined) {
  const parsed = parseOwnedContentAddressedName(name)
  return Boolean(parsed && parsed.sha256 === expectedSha256
    && (expectedNamespace === undefined || parsed.namespace === expectedNamespace))
}

function requireWorldFfmpegGithubAssetNamespace(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) {
    throw new Error('World FFmpeg GitHub asset namespace is invalid.')
  }
  return value
}

function requireRelease(value, expectedTag, repository, api, etag = undefined) {
  const tag = value?.tag_name ?? value?.tag
  const title = value?.name ?? value?.title ?? ''
  const body = value?.body ?? ''
  const targetCommitish = value?.target_commitish ?? value?.targetCommitish
  if (!Number.isSafeInteger(value?.id) || value.id < 1 || tag !== expectedTag
    || typeof value?.draft !== 'boolean' || typeof title !== 'string'
    || typeof body !== 'string' || typeof targetCommitish !== 'string') {
    throw new Error('World FFmpeg GitHub release identity is invalid.')
  }
  const upload = requireReleaseUploadAuthority(value.upload_url, repository, value.id, api)
  const normalizedEtag = requireOptionalGithubEtag(etag)
  return Object.freeze({
    id: value.id, tag, draft: value.draft, title, body, targetCommitish, upload,
    ...(normalizedEtag ? { etag: normalizedEtag } : {}),
  })
}

function requireOptionalGithubEtag(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 256 || /[\0\r\n]/.test(value)
    || !/^"[\x20-\x21\x23-\x7e]{1,240}"$/.test(value)) {
    throw new Error('World FFmpeg GitHub release ETag authority is invalid.')
  }
  return value
}

function releasePublicationProof(input) {
  return Object.freeze({
    schema: 'modly.world-ffmpeg-release-publication-proof.v1',
    releaseId: input.releaseId,
    tag: input.tag,
    requestSha256: input.requestSha256,
    metadataSha256: input.metadataSha256,
    settlement: input.settlement,
  })
}

function requireMatchingDraft(release, metadata) {
  if (release.draft !== true || requireMatchingRelease(release, metadata) !== release) {
    throw new Error('Existing GitHub release conflicts with the required private draft.')
  }
  return release
}

function requireMatchingRelease(release, metadata) {
  if (typeof release.draft !== 'boolean') {
    throw new Error('Existing GitHub release conflicts with the required release authority.')
  }
  requireExactReleaseMetadata(release, metadata, release.draft)
  return release
}

function requireExactReleaseMetadata(release, metadata, draft) {
  const expected = requirePublicationMetadata(metadata, release?.tag)
  if (release?.tag !== expected.tag || release?.title !== expected.title
    || release?.body !== expected.body || release?.targetCommitish !== expected.targetCommitish
    || release?.draft !== draft) {
    throw new Error('Existing GitHub release conflicts with the required release metadata authority.')
  }
  return release
}

function requirePublicationMetadata(value, expectedTag) {
  const tag = requireWorldFfmpegReleaseTag(value?.tag ?? expectedTag)
  if (expectedTag !== undefined && tag !== expectedTag) {
    throw new Error('World FFmpeg GitHub release metadata tag conflicts.')
  }
  const title = requireReleaseTitle(value?.title)
  const body = requireReleaseBody(value?.body)
  const targetCommitish = requireTargetCommitish(value?.targetCommitish)
  if (value?.draft !== undefined && value.draft !== true) {
    throw new Error('World FFmpeg GitHub setup metadata must bind the initial private draft state.')
  }
  return Object.freeze({ tag, title, body, targetCommitish, draft: true })
}

function releaseMetadataSha256(metadata) {
  return createHash('sha256').update(canonicalJsonBytes(requirePublicationMetadata(metadata), true)).digest('hex')
}

function githubStatusError(response, operation, ambiguous = false) {
  const statusCode = response?.statusCode
  const error = new Error(`World FFmpeg GitHub ${operation} failed with HTTP ${statusCode ?? 'unknown'}.`)
  error.statusCode = statusCode
  error.retryable = RETRYABLE_STATUSES.has(statusCode) || statusCode === 409
  error.ambiguous = ambiguous || error.retryable || statusCode === 409 || statusCode === 422
  error.retryAfterMs = parseRetryAfter(response?.headers?.['retry-after'])
  return error
}

function retryableError(message, fields = {}) {
  return Object.assign(new Error(message), { retryable: true, ambiguous: true, ...fields })
}

function asGithubNetworkError(error) {
  if (error?.retryable === true) return error
  const wrapped = new Error(error instanceof Error ? error.message : 'World FFmpeg GitHub request failed.')
  wrapped.cause = error
  wrapped.code = error?.code
  wrapped.retryable = true
  wrapped.ambiguous = true
  return wrapped
}

async function boundedRetrySleep(error, options) {
  const retryAfterMs = Math.min(
    options.retryAfterCapMs,
    Number.isSafeInteger(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 250,
  )
  const remainingMs = remaining(options.deadlineAt, options.now)
  if (retryAfterMs >= remainingMs) throw new Error('World FFmpeg GitHub retry exceeded its operation deadline.')
  await options.sleep(retryAfterMs)
  remaining(options.deadlineAt, options.now)
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || value.length > 128) return undefined
  if (/^[0-9]{1,6}$/.test(value)) return Number(value) * 1_000
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : undefined
}

function requireAssetRedirect(value, api) {
  let url
  try { url = new URL(value) } catch { throw new Error('World FFmpeg GitHub asset redirect is invalid.') }
  const publicAuthority = api.hostname === 'api.github.com'
  if (url.protocol !== 'https:' || url.username || url.password
    || !(url.origin === api.origin
      || (publicAuthority && (url.hostname === 'release-assets.githubusercontent.com'
      || url.hostname === 'objects.githubusercontent.com'
      || url.hostname === 'github-releases.githubusercontent.com'
      || url.hostname.endsWith('.githubusercontent.com'))))) {
    throw new Error('World FFmpeg GitHub asset redirect authority is invalid.')
  }
  return url
}

function normalizeHeaders(headers) {
  const result = Object.create(null)
  for (const [name, value] of Object.entries(headers ?? {})) {
    result[String(name).toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value ?? '')
  }
  return Object.freeze(result)
}

function requireStatus(response, expected, operation) {
  if (response?.statusCode !== expected) throw githubStatusError(response, operation)
  return response
}

function remaining(deadlineAt, now) {
  const value = Math.floor(deadlineAt - now())
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('World FFmpeg GitHub operation deadline expired.')
  }
  return value
}

export function requireWorldFfmpegRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) {
    throw new Error('World FFmpeg GitHub repository authority is invalid.')
  }
  return value
}

export function requireWorldFfmpegReleaseTag(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255
    || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error('World FFmpeg GitHub release tag is invalid.')
  }
  return value
}

export function requireWorldFfmpegGithubToken(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error('World FFmpeg GitHub upload token is unavailable.')
  }
  return value
}

function requireReleaseTitle(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || /[\0\r\n]/.test(value)) {
    throw new Error('World FFmpeg GitHub release title is invalid.')
  }
  return value
}

function requireReleaseBody(value) {
  if (typeof value !== 'string' || value.length > 16 * 1024 || value.includes('\0')
    || value.includes('\r')) {
    throw new Error('World FFmpeg GitHub release body is invalid.')
  }
  return value
}

function requireTargetCommitish(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error('World FFmpeg GitHub release target commit authority is invalid.')
  }
  return value
}

function canonicalJsonBytes(value, newline) {
  return Buffer.from(`${JSON.stringify(value)}${newline ? '\n' : ''}`)
}

function requireHostname(value) {
  if (typeof value !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(value)) {
    throw new Error('World FFmpeg GitHub hostname is invalid.')
  }
  return value
}

function requireHttpsPort(value) {
  const numeric = typeof value === 'string' && /^[0-9]{1,5}$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 65_535) {
    throw new Error('World FFmpeg GitHub HTTPS port is invalid.')
  }
  return numeric
}

function requireGithubApiAuthority(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('World FFmpeg GitHub API authority is invalid.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/^[a-z0-9.-]{1,253}$/.test(url.hostname)
    || !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(url.pathname)) {
    throw new Error('World FFmpeg GitHub API authority is invalid.')
  }
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  const port = requireHttpsPort(url.port || 443)
  return Object.freeze({
    url: `${url.protocol}//${url.host}${basePath}`,
    origin: url.origin,
    hostname: url.hostname,
    port,
    basePath,
  })
}

function apiPath(api, suffix) {
  return `${api.basePath}${suffix}`
}

function requireReleaseUploadAuthority(value, repository, releaseId, api) {
  if (typeof value !== 'string' || value.length > 16 * 1024) {
    throw new Error('World FFmpeg GitHub release upload authority is unavailable.')
  }
  const template = value.replace(/\{\?name,label\}$/, '')
  let url
  try { url = new URL(template) } catch {
    throw new Error('World FFmpeg GitHub release upload authority is invalid.')
  }
  const allowedOrigin = api.hostname === 'api.github.com' ? 'https://uploads.github.com' : api.origin
  const expectedSuffix = `/repos/${repository}/releases/${releaseId}/assets`
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.origin !== allowedOrigin || !url.pathname.endsWith(expectedSuffix)
    || !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(url.pathname)) {
    throw new Error('World FFmpeg GitHub release upload authority is cross-origin or invalid.')
  }
  return Object.freeze({
    origin: url.origin,
    hostname: url.hostname,
    port: requireHttpsPort(url.port || 443),
    path: url.pathname,
  })
}

function requireRequestPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 16 * 1024
    || /[\0\r\n]/.test(value)) {
    throw new Error('World FFmpeg GitHub request path is invalid.')
  }
  return value
}

function requireMethod(value) {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(value)) throw new Error('World FFmpeg GitHub method is invalid.')
  return value
}

function requirePositiveInteger(value, label) {
  return requireBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER, label)
}

function requireBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`World FFmpeg ${label} is invalid.`)
  }
  return value
}
