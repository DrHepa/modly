#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runWithWorldFfmpegCwdCustody } from './world-ffmpeg-cwd-custody.mjs'
import {
  bindWorldFfmpegGithubReleaseMutations,
  createWorldFfmpegGithubReleaseClient,
  decodeWorldFfmpegReleaseReceipt,
  encodeWorldFfmpegReleaseReceipt,
  pruneWorldFfmpegGithubAssetNamespace,
  reconcileWorldFfmpegGithubAsset,
  requireWorldFfmpegReleaseTag,
  requireWorldFfmpegRepository,
  writeWorldFfmpegGithubOutput,
  worldFfmpegGithubContentAddressedAssetName,
} from './world-ffmpeg-github-release.mjs'
import {
  requireWorldFfmpegReleaseDraftReceipt,
  verifyWorldFfmpegReleaseSetup,
} from './world-ffmpeg-release-draft.mjs'

const ARCHIVE_NAME = 'modly-world-ffmpeg-7.1.1-sources.tar.xz'
const CHECKSUM_NAME = `${ARCHIVE_NAME}.sha256`
const GENERATION_NAME = 'GENERATION.v1.json'
const READY_NAME = 'READY.v1.json'
const SOURCE_UPLOAD_SCHEMA = 'modly.world-ffmpeg-source-upload-receipt.v1'
const SOURCE_UPLOAD_RESULT_SCHEMA = 'modly.world-ffmpeg-source-upload-result-receipt.v1'
const GENERATION_SCHEMA = 'modly.world-ffmpeg-source-generation.v1'
const READY_SCHEMA = 'modly.world-ffmpeg-source-generation-ready.v1'
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_METADATA_BYTES = 4096
const MAX_UPLOAD_RECEIPT_BYTES = 256 * 1024

export async function uploadWorldFfmpegSourceGeneration(input) {
  const generationDirectory = requireAbsoluteDirectory(input?.generationDirectory)
  const rootInfo = await lstat(generationDirectory, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('World FFmpeg source upload root is not an ordinary directory.')
  }
  const rootIdentity = directoryIdentity(rootInfo)
  return runWithWorldFfmpegCwdCustody(generationDirectory, () => runAnchoredSourceUpload({
    ...input,
    generationDirectory,
    rootIdentity,
  }))
}

async function runAnchoredSourceUpload(input) {
  await requireAnchoredRoot(input.generationDirectory, input.rootIdentity)
  const expectedNames = [ARCHIVE_NAME, CHECKSUM_NAME, GENERATION_NAME, READY_NAME].sort(codeUnitCompare)
  const entries = await readdir('.', { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    || !sameArray(entries.map(({ name }) => name).sort(codeUnitCompare), expectedNames)) {
    throw new Error('World FFmpeg source upload generation closure is invalid.')
  }
  const retained = []
  let primaryError
  try {
    const archive = await openBoundFile(ARCHIVE_NAME, MAX_ARCHIVE_BYTES, false)
    retained.push(archive)
    const checksum = await openBoundFile(CHECKSUM_NAME, 1024, true)
    retained.push(checksum)
    const generation = await openBoundFile(GENERATION_NAME, MAX_METADATA_BYTES, true)
    retained.push(generation)
    const ready = await openBoundFile(READY_NAME, MAX_METADATA_BYTES, true)
    retained.push(ready)
    requireSourceGeneration(archive, checksum, generation, ready)
    await input.beforeUpload?.(Object.freeze({
      names: Object.freeze(retained.map(({ name }) => name)),
      rootIdentity: input.rootIdentity,
    }))

    const repository = requireWorldFfmpegRepository(input.repository)
    const tag = requireWorldFfmpegReleaseTag(input.tag)
    const releaseSetup = requireWorldFfmpegReleaseDraftReceipt(input.releaseSetupReceipt, {
      repository,
      tag,
    })
    let client = input.releaseClient ?? createWorldFfmpegGithubReleaseClient({
      repository,
      tag,
      token: input.token,
    })
    const release = await getWorldFfmpegSourceUploadRelease(client)
    if (!Number.isSafeInteger(release?.id) || release.id < 1
      || release.tag !== tag || typeof release.draft !== 'boolean') {
      throw new Error('World FFmpeg source upload release authority is invalid.')
    }
    const { setupReceiptSha256 } = await verifyWorldFfmpegReleaseSetup({
      client,
      release,
      receipt: releaseSetup,
    })
    if (release.draft === false) {
      return await reconcilePublishedWorldFfmpegSource({
        client,
        release,
        repository,
        tag,
        archive,
        checksum,
        generation,
        ready,
        retained,
        generationDirectory: input.generationDirectory,
        rootIdentity: input.rootIdentity,
        setupReceiptSha256,
      })
    }
    client = bindWorldFfmpegGithubReleaseMutations(client, {
      releaseId: releaseSetup.releaseId, metadata: releaseSetup.metadata,
    })
    const archiveAsset = await reconcileRetainedFile(client, release.id, archive, 'sources.tar.xz')
    const checksumAsset = await reconcileRetainedFile(client, release.id, checksum, 'sources.sha256')
    const generationAsset = await reconcileSourceGenerationIdentity({
      client,
      releaseId: release.id,
      localFile: generation,
      archive,
      checksum,
    })
    const readyBytes = Buffer.from(`${JSON.stringify({
      schema: READY_SCHEMA,
      generationIdentitySha256: generationAsset.sha256,
      archiveSha256: archive.sha256,
    })}\n`)
    const readyAsset = ready.bytes.equals(readyBytes)
      ? await reconcileRetainedFile(client, release.id, ready, 'ready.v1.json')
      : await reconcileBuffer(client, release.id, readyBytes, 'ready.v1.json')
    const assets = Object.freeze([archiveAsset, checksumAsset, generationAsset, readyAsset])
    for (const file of retained) await requireBoundPublicName(file)
    await requireAnchoredRoot(input.generationDirectory, input.rootIdentity)
    const uploadReceipt = Object.freeze({
      schema: SOURCE_UPLOAD_SCHEMA,
      repository,
      tag,
      releaseId: release.id,
      setupReceiptSha256,
      assets,
    })
    const uploadReceiptBytes = Buffer.from(`${JSON.stringify(uploadReceipt)}\n`)
    const uploadReceiptDescriptor = Object.freeze({
      name: worldFfmpegGithubContentAddressedAssetName(
        'source', sha256(uploadReceiptBytes), 'source-upload.v1.json',
      ),
      size: uploadReceiptBytes.byteLength,
      sha256: sha256(uploadReceiptBytes),
    })
    const receiptAsset = await reconcileWorldFfmpegGithubAsset({
      client,
      releaseId: release.id,
      expected: uploadReceiptDescriptor,
      createStream: () => createBufferStream(uploadReceiptBytes, uploadReceiptDescriptor.sha256),
    })
    for (const file of retained) await requireBoundPublicName(file)
    await requireAnchoredRoot(input.generationDirectory, input.rootIdentity)
    const uploadResultReceipt = Object.freeze({
      schema: SOURCE_UPLOAD_RESULT_SCHEMA,
      repository,
      tag,
      releaseId: release.id,
      setupReceiptSha256,
      uploadReceiptFile: Object.freeze({
        ...uploadReceiptDescriptor,
        githubAssetId: receiptAsset.assetId,
      }),
    })
    await pruneWorldFfmpegGithubAssetNamespace({
      client,
      releaseId: release.id,
      namespace: 'source',
      keep: [...assets, uploadResultReceipt.uploadReceiptFile],
    })
    return Object.freeze({ uploadReceipt, uploadResultReceipt })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await closeWorldFfmpegSourceUploadFiles(retained, primaryError)
  }
}

async function closeWorldFfmpegSourceUploadFiles(files, primaryError) {
  const closeErrors = []
  for (const { handle } of [...files].reverse()) {
    try { await handle.close() } catch (error) { closeErrors.push(error) }
  }
  if (closeErrors.length > 0) {
    throw new AggregateError(
      primaryError ? [primaryError, ...closeErrors] : closeErrors,
      'World FFmpeg source upload descriptor release failed.',
    )
  }
}

export const _testOnlyCloseWorldFfmpegSourceUploadFiles = closeWorldFfmpegSourceUploadFiles

async function getWorldFfmpegSourceUploadRelease(client) {
  if (typeof client?.getRelease === 'function') return client.getRelease()
  if (typeof client?.getDraftRelease === 'function') return client.getDraftRelease()
  throw new Error('World FFmpeg source upload client cannot prove release authority.')
}

async function reconcilePublishedWorldFfmpegSource(input) {
  const {
    client, release, repository, tag, archive, checksum, retained,
    generationDirectory, rootIdentity, setupReceiptSha256,
  } = input
  if (typeof client.listAssets !== 'function' || typeof client.verifyAsset !== 'function'
    || typeof client.readAsset !== 'function') {
    throw new Error('World FFmpeg public release client cannot reconcile exact source bytes.')
  }
  const prefix = 'world-ffmpeg-source-'
  const remoteNamespace = (await client.listAssets(release.id)).filter(({ name }) => name.startsWith(prefix))
  const receiptCandidates = remoteNamespace.filter((asset) => (
    parseSourceRemoteAssetName(asset.name)?.kind === 'source-upload.v1.json'
  ))
  if (receiptCandidates.length !== 1) {
    throw new Error('World FFmpeg public source release has no unique upload receipt authority.')
  }
  const uploadReceiptFile = await readPublishedSourceMetadata(
    client, receiptCandidates[0], MAX_UPLOAD_RECEIPT_BYTES, 'source upload receipt',
  )
  const uploadReceipt = requireWorldFfmpegSourceUploadReceipt(
    parseCanonicalJson(uploadReceiptFile.bytes, 'public source upload receipt'),
    { repository, tag, releaseId: release.id, setupReceiptSha256 },
  )
  const expectedNamespace = [...uploadReceipt.assets, uploadReceiptFile.descriptor]
  requireExactPublishedSourceNamespace(remoteNamespace, expectedNamespace)
  for (const expected of expectedNamespace) {
    await client.verifyAsset({ asset: findRemoteSourceDescriptor(remoteNamespace, expected), expected })
  }
  for (const [file, kind] of [[archive, 'sources.tar.xz'], [checksum, 'sources.sha256']]) {
    const expected = remoteSourceDescriptor(file.name, file.size, file.sha256, kind)
    if (!uploadReceipt.assets.some((asset) => sameRemoteDescriptor(asset, expected))) {
      throw new Error(`World FFmpeg public source ${kind} conflicts with the rebuilt generation.`)
    }
  }
  const generationDescriptor = uploadReceipt.assets.find((asset) => (
    sourceRemoteKind(asset, 'source') === 'generation.v1.json'
  ))
  const readyDescriptor = uploadReceipt.assets.find((asset) => (
    sourceRemoteKind(asset, 'source') === 'ready.v1.json'
  ))
  if (!generationDescriptor || !readyDescriptor) {
    throw new Error('World FFmpeg public source receipt omits generation evidence.')
  }
  const generationFile = await readPublishedSourceMetadata(
    client,
    findRemoteSourceDescriptor(remoteNamespace, generationDescriptor),
    MAX_METADATA_BYTES,
    'source generation identity',
  )
  if (!sameRemoteDescriptor(generationFile.descriptor, generationDescriptor)) {
    throw new Error('World FFmpeg public source generation descriptor conflicts.')
  }
  requireGenerationIdentity(generationFile.bytes, archive, checksum)
  const readyFile = await readPublishedSourceMetadata(
    client,
    findRemoteSourceDescriptor(remoteNamespace, readyDescriptor),
    MAX_METADATA_BYTES,
    'source ready marker',
  )
  if (!sameRemoteDescriptor(readyFile.descriptor, readyDescriptor)) {
    throw new Error('World FFmpeg public source ready descriptor conflicts.')
  }
  requireReadyMarker(readyFile.bytes, generationFile.descriptor.sha256, archive.sha256)
  for (const file of retained) await requireBoundPublicName(file)
  await requireAnchoredRoot(generationDirectory, rootIdentity)
  const uploadResultReceipt = Object.freeze({
    schema: SOURCE_UPLOAD_RESULT_SCHEMA,
    repository,
    tag,
    releaseId: release.id,
    setupReceiptSha256,
    uploadReceiptFile: uploadReceiptFile.descriptor,
  })
  requireWorldFfmpegSourceUploadResultReceipt(uploadResultReceipt, {
    repository, tag, releaseId: release.id, setupReceiptSha256,
  })
  return Object.freeze({ uploadReceipt, uploadResultReceipt })
}

async function readPublishedSourceMetadata(client, asset, maximumBytes, label) {
  if (!Number.isSafeInteger(asset?.id) || asset.id < 1
    || !Number.isSafeInteger(asset?.size) || asset.size < 1 || asset.size > maximumBytes) {
    throw new Error(`World FFmpeg public ${label} identity is invalid.`)
  }
  const parsedName = parseSourceRemoteAssetName(asset.name)
  if (!parsedName) throw new Error(`World FFmpeg public ${label} content address is invalid.`)
  const bytes = await client.readAsset({ asset, maximumBytes })
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== asset.size || sha256(bytes) !== parsedName.sha256) {
    throw new Error(`World FFmpeg public ${label} digest conflicts with its content address.`)
  }
  const descriptor = Object.freeze({
    name: asset.name,
    size: asset.size,
    sha256: parsedName.sha256,
    githubAssetId: asset.id,
  })
  await client.verifyAsset({ asset, expected: descriptor })
  return Object.freeze({ bytes, descriptor })
}

function requireExactPublishedSourceNamespace(remoteAssets, expectedAssets) {
  if (remoteAssets.length !== expectedAssets.length) {
    throw new Error('World FFmpeg public source namespace has foreign or missing assets.')
  }
  const names = new Set()
  const ids = new Set()
  for (const expected of expectedAssets) {
    if (names.has(expected.name) || ids.has(expected.githubAssetId)) {
      throw new Error('World FFmpeg public source receipt assets collide.')
    }
    names.add(expected.name)
    ids.add(expected.githubAssetId)
    findRemoteSourceDescriptor(remoteAssets, expected)
  }
}

function findRemoteSourceDescriptor(remoteAssets, expected) {
  const byName = remoteAssets.filter(({ name }) => name === expected.name)
  const byId = remoteAssets.filter(({ id }) => id === expected.githubAssetId)
  if (byName.length !== 1 || byId.length !== 1 || byName[0] !== byId[0]
    || byName[0].size !== expected.size) {
    throw new Error(`World FFmpeg public source remote asset conflicts: ${expected.name}.`)
  }
  return byName[0]
}

function parseSourceRemoteAssetName(name) {
  const match = /^world-ffmpeg-source-([a-f0-9]{64})-([A-Za-z0-9][A-Za-z0-9._-]{0,80})$/.exec(name ?? '')
  return match ? Object.freeze({ sha256: match[1], kind: match[2] }) : null
}

function sameRemoteDescriptor(left, right) {
  return left.name === right.name && left.size === right.size && left.sha256 === right.sha256
}

function requireSourceGeneration(archive, checksum, generationFile, readyFile) {
  requireGenerationIdentity(generationFile.bytes, archive, checksum)
  requireReadyMarker(readyFile.bytes, generationFile.sha256, archive.sha256)
}

function requireGenerationIdentity(bytes, archive, checksum) {
  const generation = parseCanonicalJson(bytes, 'source-generation identity')
  if (!exactRecord(generation, ['archive', 'checksum', 'schema', 'token'])
    || generation.schema !== GENERATION_SCHEMA || !/^[a-f0-9]{64}$/.test(generation.token)
    || !sameSourceDescriptor(generation.archive, archive)
    || !sameSourceDescriptor(generation.checksum, checksum)) {
    throw new Error('World FFmpeg source upload generation identity is invalid.')
  }
  if (!checksum.bytes.equals(Buffer.from(`${archive.sha256}  ${ARCHIVE_NAME}\n`))) {
    throw new Error('World FFmpeg source upload checksum is invalid.')
  }
  return generation
}

function requireReadyMarker(bytes, generationSha256, archiveSha256) {
  const ready = parseCanonicalJson(bytes, 'source-generation ready marker')
  if (!exactRecord(ready, ['archiveSha256', 'generationIdentitySha256', 'schema'])
    || ready.schema !== READY_SCHEMA
    || ready.archiveSha256 !== archiveSha256
    || ready.generationIdentitySha256 !== generationSha256) {
    throw new Error('World FFmpeg source upload ready marker is invalid.')
  }
}

async function reconcileRetainedFile(client, releaseId, file, kind) {
  const expected = remoteSourceDescriptor(file.name, file.size, file.sha256, kind)
  const uploaded = await reconcileWorldFfmpegGithubAsset({
    client,
    releaseId,
    expected,
    createStream: () => createHandleStream(file),
  })
  await requireBoundPublicName(file)
  return Object.freeze({ ...expected, githubAssetId: uploaded.assetId })
}

async function reconcileBuffer(client, releaseId, bytes, kind) {
  const digest = sha256(bytes)
  const expected = remoteSourceDescriptor(kind, bytes.byteLength, digest, kind)
  const uploaded = await reconcileWorldFfmpegGithubAsset({
    client,
    releaseId,
    expected,
    createStream: () => createBufferStream(bytes, expected.sha256),
  })
  return Object.freeze({ ...expected, githubAssetId: uploaded.assetId })
}

async function reconcileSourceGenerationIdentity({ client, releaseId, localFile, archive, checksum }) {
  const existing = await readExistingSourceGeneration({ client, releaseId, archive, checksum })
  if (existing) return existing
  try {
    return await reconcileRetainedFile(client, releaseId, localFile, 'generation.v1.json')
  } catch (error) {
    const concurrent = await readExistingSourceGeneration({ client, releaseId, archive, checksum })
    if (concurrent) return concurrent
    throw error
  }
}

async function readExistingSourceGeneration({ client, releaseId, archive, checksum }) {
  const matches = (await client.listAssets(releaseId)).filter(({ name }) => (
    /^world-ffmpeg-source-[a-f0-9]{64}-generation\.v1\.json$/.test(name)
  ))
  if (matches.length > 1) {
    throw new Error('World FFmpeg remote source-generation identity name is ambiguous.')
  }
  if (matches.length === 0) return null
  if (typeof client.readAsset !== 'function') {
    throw new Error('World FFmpeg source upload client cannot verify an existing generation identity.')
  }
  const asset = matches[0]
  if (!Number.isSafeInteger(asset?.id) || asset.id < 1
    || !Number.isSafeInteger(asset.size) || asset.size < 2 || asset.size > MAX_METADATA_BYTES) {
    throw new Error('World FFmpeg remote source-generation identity is invalid.')
  }
  const bytes = await client.readAsset({ asset, maximumBytes: MAX_METADATA_BYTES })
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== asset.size) {
    throw new Error('World FFmpeg remote source-generation identity read is invalid.')
  }
  requireGenerationIdentity(bytes, archive, checksum)
  const expected = Object.freeze({
    name: asset.name,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  })
  if (!asset.name.includes(`-${expected.sha256}-`)) {
    throw new Error('World FFmpeg remote source-generation content address is invalid.')
  }
  await client.verifyAsset({ asset, expected })
  return Object.freeze({ ...expected, githubAssetId: asset.id })
}

async function openBoundFile(name, maximumBytes, captureBytes) {
  if (!validDirectName(name)) throw new Error('World FFmpeg source upload name is invalid.')
  const pathInfo = await lstat(name, { bigint: true })
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n
    || pathInfo.size < 1n || pathInfo.size > BigInt(maximumBytes)) {
    throw new Error(`World FFmpeg source upload entry is not an ordinary bounded file: ${name}.`)
  }
  const handle = await open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!sameStableFile(pathInfo, before)) {
      throw new Error(`World FFmpeg source upload entry changed before open: ${name}.`)
    }
    const read = await readAndHashHandle(handle, Number(before.size), captureBytes)
    const after = await handle.stat({ bigint: true })
    if (!sameStableFile(before, after)) {
      throw new Error(`World FFmpeg source upload entry changed during verification: ${name}.`)
    }
    return Object.freeze({
      name,
      handle,
      identity: before,
      size: Number(before.size),
      sha256: read.sha256,
      bytes: read.bytes,
    })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function requireBoundPublicName(file) {
  const [pathInfo, handleInfo] = await Promise.all([
    lstat(file.name, { bigint: true }),
    file.handle.stat({ bigint: true }),
  ])
  if (!sameStableFile(file.identity, handleInfo) || !sameStableFile(pathInfo, handleInfo)) {
    throw new Error(`World FFmpeg source upload entry was replaced after open: ${file.name}.`)
  }
}

async function requireAnchoredRoot(publicPath, identity) {
  const [anchored, published] = await Promise.all([
    lstat('.', { bigint: true }),
    lstat(publicPath, { bigint: true }),
  ])
  for (const info of [anchored, published]) {
    if (!info.isDirectory() || info.isSymbolicLink()
      || String(info.dev) !== identity.dev || String(info.ino) !== identity.ino) {
      throw new Error('World FFmpeg source upload root identity changed.')
    }
  }
}

async function readAndHashHandle(handle, expectedSize, captureBytes) {
  const chunks = captureBytes ? [] : undefined
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedSize))
  let position = 0
  while (position < expectedSize) {
    const length = Math.min(buffer.byteLength, expectedSize - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead < 1) throw new Error('World FFmpeg source upload entry ended early.')
    const chunk = buffer.subarray(0, bytesRead)
    hash.update(chunk)
    if (chunks) chunks.push(Buffer.from(chunk))
    position += bytesRead
  }
  return Object.freeze({
    bytes: chunks ? Buffer.concat(chunks, expectedSize) : undefined,
    sha256: hash.digest('hex'),
  })
}

function createHandleStream(file) {
  let consumed = false
  let complete = false
  let size = 0
  const hash = createHash('sha256')
  return Object.freeze({
    chunks: (async function * () {
      if (consumed) throw new Error('World FFmpeg source upload stream was consumed more than once.')
      consumed = true
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let position = 0
      while (position < file.size) {
        const length = Math.min(buffer.byteLength, file.size - position)
        const { bytesRead } = await file.handle.read(buffer, 0, length, position)
        if (bytesRead < 1) throw new Error('World FFmpeg source upload stream ended early.')
        const chunk = Buffer.from(buffer.subarray(0, bytesRead))
        hash.update(chunk)
        size += bytesRead
        position += bytesRead
        yield chunk
      }
      complete = true
    })(),
    assertComplete() {
      if (!consumed || !complete || size !== file.size || hash.digest('hex') !== file.sha256) {
        throw new Error('World FFmpeg source upload did not stream the exact retained bytes.')
      }
    },
  })
}

function createBufferStream(bytes, expectedSha256) {
  let consumed = false
  let complete = false
  return Object.freeze({
    chunks: (async function * () {
      if (consumed) throw new Error('World FFmpeg source receipt stream was consumed more than once.')
      consumed = true
      yield bytes
      complete = true
    })(),
    assertComplete() {
      if (!consumed || !complete || sha256(bytes) !== expectedSha256) {
        throw new Error('World FFmpeg source receipt upload did not stream exact bytes.')
      }
    },
  })
}

export function requireWorldFfmpegSourceUploadReceipt(value, expected = {}) {
  if (!exactRecord(value, ['schema', 'repository', 'tag', 'releaseId', 'setupReceiptSha256', 'assets'])
    || value.schema !== SOURCE_UPLOAD_SCHEMA
    || requireWorldFfmpegRepository(value.repository) !== value.repository
    || requireWorldFfmpegReleaseTag(value.tag) !== value.tag
    || !Number.isSafeInteger(value.releaseId) || value.releaseId < 1
    || !/^[a-f0-9]{64}$/.test(value.setupReceiptSha256)
    || !Array.isArray(value.assets) || value.assets.length !== 4
    || value.assets.some((asset) => !validRemoteAssetDescriptor(asset))) {
    throw new Error('World FFmpeg source upload receipt is invalid.')
  }
  const names = value.assets.map(({ name }) => name)
  const kinds = value.assets.map((asset) => sourceRemoteKind(asset, 'source')).sort(codeUnitCompare)
  if (!sameArray(kinds, ['generation.v1.json', 'ready.v1.json', 'sources.sha256', 'sources.tar.xz'])
    || new Set(names).size !== names.length
    || !matchesExpectedAuthority(value, expected)) {
    throw new Error('World FFmpeg source upload receipt authority mismatches.')
  }
  return Object.freeze(structuredClone(value))
}

export function requireWorldFfmpegSourceUploadResultReceipt(value, expected = {}) {
  if (!exactRecord(value, [
    'schema', 'repository', 'tag', 'releaseId', 'setupReceiptSha256', 'uploadReceiptFile',
  ])
    || value.schema !== SOURCE_UPLOAD_RESULT_SCHEMA
    || requireWorldFfmpegRepository(value.repository) !== value.repository
    || requireWorldFfmpegReleaseTag(value.tag) !== value.tag
    || !Number.isSafeInteger(value.releaseId) || value.releaseId < 1
    || !/^[a-f0-9]{64}$/.test(value.setupReceiptSha256)
    || !validRemoteAssetDescriptor(value.uploadReceiptFile)
    || sourceRemoteKind(value.uploadReceiptFile, 'source') !== 'source-upload.v1.json'
    || !matchesExpectedAuthority(value, expected)) {
    throw new Error('World FFmpeg source upload result receipt is invalid.')
  }
  return Object.freeze(structuredClone(value))
}

function parseCanonicalJson(bytes, label) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error(`World FFmpeg ${label} is invalid JSON.`)
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) {
    throw new Error(`World FFmpeg ${label} is not canonical.`)
  }
  return value
}

function sameSourceDescriptor(value, file) {
  return exactRecord(value, ['name', 'sha256', 'size'])
    && value.name === file.name && value.size === file.size && value.sha256 === file.sha256
}

function sameStableFile(left, right) {
  return left.isFile() && right.isFile() && left.nlink === 1n && right.nlink === 1n
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function fileSummary(file) {
  return Object.freeze({ name: file.name, size: file.size, sha256: file.sha256 })
}

function remoteSourceDescriptor(_localName, size, digest, kind) {
  return Object.freeze({
    name: worldFfmpegGithubContentAddressedAssetName('source', digest, kind),
    size,
    sha256: digest,
  })
}

function validRemoteAssetDescriptor(value) {
  return exactRecord(value, ['name', 'size', 'sha256', 'githubAssetId'])
    && validDirectName(value.name)
    && Number.isSafeInteger(value.size) && value.size >= 1 && value.size <= MAX_ARCHIVE_BYTES
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.githubAssetId) && value.githubAssetId >= 1
}

function sourceRemoteKind(value, namespace) {
  const match = new RegExp(`^world-ffmpeg-${namespace}-([a-f0-9]{64})-([A-Za-z0-9][A-Za-z0-9._-]{0,80})$`).exec(value?.name ?? '')
  if (!match || match[1] !== value.sha256) {
    throw new Error('World FFmpeg source upload content address is invalid.')
  }
  return match[2]
}

function matchesExpectedAuthority(value, expected) {
  return (expected.repository === undefined || value.repository === expected.repository)
    && (expected.tag === undefined || value.tag === expected.tag)
    && (expected.releaseId === undefined || value.releaseId === expected.releaseId)
    && (expected.setupReceiptSha256 === undefined
      || value.setupReceiptSha256 === expected.setupReceiptSha256)
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  return sameArray(Object.keys(value).sort(codeUnitCompare), [...keys].sort(codeUnitCompare))
}

function directoryIdentity(info) {
  return Object.freeze({ dev: String(info.dev), ino: String(info.ino) })
}

function validDirectName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(value)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameArray(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function requireAbsoluteDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error('World FFmpeg source upload directory must be an absolute path.')
  }
  return resolve(value)
}

function parseArguments(argv) {
  if (argv.length === 8 && argv[0] === '--generation' && argv[2] === '--tag'
    && argv[4] === '--repository' && argv[6] === '--github-output') {
    return {
      generationDirectory: argv[1],
      tag: argv[3],
      repository: argv[5],
      githubOutput: argv[7],
    }
  }
  throw new Error('Usage: world-ffmpeg-source-release-uploader.mjs --generation <absolute-directory> --tag <tag> --repository <owner/repo> --github-output <path>')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const args = parseArguments(process.argv.slice(2))
    const result = await uploadWorldFfmpegSourceGeneration({
      ...args,
      token: process.env.GH_TOKEN,
      releaseSetupReceipt: decodeWorldFfmpegReleaseReceipt(
        process.env.WORLD_FFMPEG_RELEASE_DRAFT_RECEIPT,
      ),
    })
    const encoded = encodeWorldFfmpegReleaseReceipt(result.uploadResultReceipt)
    await writeWorldFfmpegGithubOutput(
      args.githubOutput,
      'WORLD_FFMPEG_SOURCE_UPLOAD_RECEIPT',
      encoded,
    )
    process.stdout.write(`WORLD_FFMPEG_SOURCE_UPLOAD_RECEIPT=${encoded}\n`)
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg source release upload failed.'}\n`)
    process.exitCode = 1
  })
}
