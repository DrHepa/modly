#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { syncWorldFfmpegDirectory } from './world-ffmpeg-durability.mjs'
import { runWithWorldFfmpegCwdCustody } from './world-ffmpeg-cwd-custody.mjs'
import {
  bindWorldFfmpegGithubReleaseMutations,
  createWorldFfmpegGithubReleaseClient,
  decodeWorldFfmpegReleaseReceipt,
  pruneWorldFfmpegGithubAssetNamespace,
  reconcileWorldFfmpegGithubAsset,
  requireWorldFfmpegReleaseTag,
  requireWorldFfmpegRepository,
  writeWorldFfmpegGithubOutput,
  worldFfmpegGithubContentAddressedAssetName,
} from './world-ffmpeg-github-release.mjs'
import {
  loadWorldFfmpegPackageToolLock,
  requireWorldFfmpegPackageResultManifest,
  requireWorldFfmpegPackageResultReceipt,
} from './world-ffmpeg-package-tools.mjs'
import {
  requireWorldFfmpegReleaseDraftReceipt,
  verifyWorldFfmpegReleaseSetup,
} from './world-ffmpeg-release-draft.mjs'

const MAX_RESULT_BYTES = 128 * 1024
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024
const MAX_REPORT_BYTES = 1024 * 1024
const MAX_UPLOAD_RECEIPT_BYTES = 256 * 1024
const UPLOAD_SCHEMA = 'modly.electron-builder-package-upload-receipt.v1'

export async function verifyOrUploadWorldFfmpegPackageResult(input) {
  const receipt = requireWorldFfmpegPackageResultReceipt(input?.resultReceipt)
  const outputDirectory = resolve(dirname(receipt.manifestPath))
  return runWithWorldFfmpegCwdCustody(outputDirectory, () => (
    runAnchoredUpload({ ...input, receipt, outputDirectory })
  ))
}

async function runAnchoredUpload(input) {
  const { receipt } = input
  await requireAnchoredOutputRoot(receipt, input.outputDirectory)
  const lock = input.contract ?? await loadWorldFfmpegPackageToolLock()
  const manifestFile = await openBoundDirectFile(
    receipt.manifestFile.name,
    { path: receipt.manifestFile.name, ...receipt.manifestFile },
    MAX_RESULT_BYTES,
    true,
  )
  const retained = [manifestFile]
  let operationError
  try {
    const manifest = parseCanonicalManifest(manifestFile.bytes)
    requireWorldFfmpegPackageResultManifest(manifest, receipt, lock.extractors[receipt.target])
    const names = new Set([manifestFile.name])
    const uploadFiles = []
    for (const descriptor of [...manifest.artifacts, manifest.buildReport]) {
      if (names.has(descriptor.path)) throw new Error('World FFmpeg upload input names collide.')
      names.add(descriptor.path)
      const maximumBytes = descriptor === manifest.buildReport ? MAX_REPORT_BYTES : MAX_ARTIFACT_BYTES
      const bound = await openBoundDirectFile(descriptor.path, descriptor, maximumBytes)
      retained.push(bound)
      uploadFiles.push(bound)
    }
    uploadFiles.push(manifestFile)
    await input.beforeUpload?.(Object.freeze({
      target: manifest.target,
      names: Object.freeze(uploadFiles.map(({ name }) => name)),
    }))
    if (input.verifyOnly === true) {
      for (const file of uploadFiles) await requireBoundPublicName(file)
      await requireAnchoredOutputRoot(receipt, input.outputDirectory)
      const verificationReceipt = Object.freeze({
        schema: 'modly.electron-builder-package-verification-receipt.v1',
        target: manifest.target,
        attemptId: manifest.attemptId,
        publicationToken: manifest.publicationToken,
        outputIdentity: receipt.outputIdentity,
        uploaded: false,
        files: Object.freeze(uploadFiles.map(fileDescriptor)),
      })
      return Object.freeze({
        target: manifest.target,
        attemptId: manifest.attemptId,
        verified: Object.freeze(uploadFiles.map(fileSummary)),
        verificationReceipt,
      })
    }
    const repository = requireWorldFfmpegRepository(input.repository)
    const tag = requireWorldFfmpegReleaseTag(input.tag)
    const releaseSetup = requireWorldFfmpegReleaseDraftReceipt(input.releaseSetupReceipt, {
      repository,
      tag,
    })
    let releaseClient = input.releaseClient
      ?? (input.upload
        ? createLegacyInjectedReleaseClient(input.upload, tag)
        : createWorldFfmpegGithubReleaseClient({ repository, tag, token: input.token }))
    const release = await getWorldFfmpegUploadRelease(releaseClient)
    if (!Number.isSafeInteger(release?.id) || release.id < 1
      || release.tag !== tag || typeof release.draft !== 'boolean') {
      throw new Error('World FFmpeg upload release authority is invalid.')
    }
    const { setupReceiptSha256 } = await verifyWorldFfmpegReleaseSetup({
      client: releaseClient,
      release,
      receipt: releaseSetup,
    })
    if (release.draft === false) {
      return await reconcilePublishedWorldFfmpegPackage({
        client: releaseClient,
        release,
        repository,
        tag,
        manifest,
        receipt,
        uploadFiles,
        lock,
        setupReceiptSha256,
      })
    }
    releaseClient = bindWorldFfmpegGithubReleaseMutations(releaseClient, {
      releaseId: releaseSetup.releaseId, metadata: releaseSetup.metadata,
    })
    const assets = []
    for (const file of uploadFiles) {
      const remote = remotePackageFileDescriptor(manifest, file)
      const response = await reconcileWorldFfmpegGithubAsset({
        client: releaseClient,
        releaseId: release.id,
        expected: remote,
        createStream: () => createBoundChunkStream(file),
      })
      await requireBoundPublicName(file)
      assets.push(Object.freeze({
        name: remote.name,
        size: file.size,
        sha256: file.sha256,
        githubAssetId: response.assetId,
      }))
    }
    await requireAnchoredOutputRoot(receipt, input.outputDirectory)
    const uploadReceipt = Object.freeze({
      schema: UPLOAD_SCHEMA,
      target: manifest.target,
      attemptId: manifest.attemptId,
      publicationToken: manifest.publicationToken,
      repository,
      tag,
      releaseId: release.id,
      setupReceiptSha256,
      assets: Object.freeze(assets),
    })
    const uploadReceiptName = `UPLOAD.${manifest.target}.v1.json`
    if (names.has(uploadReceiptName)) throw new Error('World FFmpeg upload receipt name collides.')
    const receiptBytes = Buffer.from(`${JSON.stringify(uploadReceipt)}\n`)
    const uploadReceiptFile = await writeOrBindDirectFile(uploadReceiptName, receiptBytes)
    retained.push(uploadReceiptFile)
    await syncWorldFfmpegDirectory('.')
    const remoteUploadReceipt = Object.freeze({
      name: worldFfmpegGithubContentAddressedAssetName(
        `package-${manifest.target}`, uploadReceiptFile.sha256, 'upload-receipt.v1.json',
      ),
      size: uploadReceiptFile.size,
      sha256: uploadReceiptFile.sha256,
    })
    const response = await reconcileWorldFfmpegGithubAsset({
      client: releaseClient,
      releaseId: release.id,
      expected: remoteUploadReceipt,
      createStream: () => createBoundChunkStream(uploadReceiptFile),
    })
    await requireBoundPublicName(uploadReceiptFile)
    await requireAnchoredOutputRoot(receipt, input.outputDirectory)
    const uploadResultReceipt = Object.freeze({
      schema: 'modly.electron-builder-package-upload-result-receipt.v1',
      target: manifest.target,
      attemptId: manifest.attemptId,
      publicationToken: manifest.publicationToken,
      repository,
      tag,
      releaseId: release.id,
      setupReceiptSha256,
      outputIdentity: receipt.outputIdentity,
      uploadReceiptFile: Object.freeze({
        ...remoteUploadReceipt,
        githubAssetId: response.assetId,
      }),
    })
    await pruneWorldFfmpegGithubAssetNamespace({
      client: releaseClient,
      releaseId: release.id,
      namespace: `package-${manifest.target}`,
      keep: [...assets, uploadResultReceipt.uploadReceiptFile],
    })
    return Object.freeze({ uploadReceipt, uploadResultReceipt })
  } catch (error) {
    operationError = error
    throw error
  } finally {
    const closeErrors = []
    for (const { handle } of retained.reverse()) {
      try { await handle.close() } catch (error) { closeErrors.push(error) }
    }
    if (closeErrors.length > 0) {
      throw new AggregateError(
        operationError ? [operationError, ...closeErrors] : closeErrors,
        'World FFmpeg package upload descriptor release failed.',
      )
    }
  }
}

async function requireAnchoredOutputRoot(receipt, publicPath) {
  const [anchored, published] = await Promise.all([
    lstat('.', { bigint: true }),
    lstat(publicPath, { bigint: true }),
  ])
  for (const info of [anchored, published]) {
    if (!info.isDirectory() || info.isSymbolicLink()
      || String(info.dev) !== receipt.outputIdentity.dev
      || String(info.ino) !== receipt.outputIdentity.ino) {
      throw new Error('World FFmpeg upload output root identity changed.')
    }
  }
}

async function openBoundDirectFile(name, descriptor, maximumBytes, captureBytes = false) {
  if (!validDirectName(name) || descriptor.path !== name
    || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > maximumBytes
    || !/^[0-9]{1,40}$/.test(descriptor.dev) || !/^[1-9][0-9]{0,39}$/.test(descriptor.ino)
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
    throw new Error('World FFmpeg upload descriptor is invalid.')
  }
  const pathInfo = await lstat(name, { bigint: true })
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n) {
    throw new Error('World FFmpeg upload input is not an ordinary single-link file.')
  }
  const handle = await open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!sameBoundIdentity(pathInfo, before, descriptor)) {
      throw new Error('World FFmpeg upload input identity changed before open.')
    }
    const { bytes, sha256 } = await readAndHashHandle(handle, descriptor.size, captureBytes)
    const after = await handle.stat({ bigint: true })
    if (!sameStableHandle(before, after) || sha256 !== descriptor.sha256) {
      throw new Error('World FFmpeg upload input changed during verification.')
    }
    return Object.freeze({
      name,
      handle,
      identity: before,
      size: descriptor.size,
      sha256,
      bytes,
    })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function writeOrBindDirectFile(name, bytes) {
  if (!validDirectName(name) || !Buffer.isBuffer(bytes) || bytes.byteLength < 2 || bytes.byteLength > MAX_REPORT_BYTES) {
    throw new Error('World FFmpeg upload receipt input is invalid.')
  }
  let handle
  let created = false
  try {
    try {
      handle = await open(name, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
        | (constants.O_NOFOLLOW ?? 0), 0o600)
      created = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      handle = await open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    }
    if (created) {
      let offset = 0
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
        if (bytesWritten < 1) throw new Error('World FFmpeg upload receipt write made no progress.')
        offset += bytesWritten
      }
      await handle.sync()
    }
    const identity = await handle.stat({ bigint: true })
    if (!identity.isFile() || identity.nlink !== 1n || identity.size !== BigInt(bytes.byteLength)) {
      throw new Error('World FFmpeg upload receipt identity is invalid.')
    }
    const observed = await readAndHashHandle(handle, bytes.byteLength, true)
    const after = await handle.stat({ bigint: true })
    if (!sameStableHandle(identity, after)
      || observed.sha256 !== createHash('sha256').update(bytes).digest('hex')
      || !observed.bytes.equals(bytes)) {
      throw new Error('Existing World FFmpeg upload receipt conflicts with the exact retry generation.')
    }
    return Object.freeze({
      name,
      handle,
      identity,
      size: bytes.byteLength,
      sha256: observed.sha256,
      bytes: observed.bytes,
    })
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    throw error
  }
}

function createBoundChunkStream(file) {
  let consumed = false
  let completed = false
  let streamedBytes = 0
  const hash = createHash('sha256')
  const chunks = async function * () {
    if (consumed) throw new Error('World FFmpeg upload byte stream was consumed more than once.')
    consumed = true
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < file.size) {
      const length = Math.min(buffer.byteLength, file.size - position)
      const { bytesRead } = await file.handle.read(buffer, 0, length, position)
      if (bytesRead < 1) throw new Error('World FFmpeg upload byte stream ended early.')
      const chunk = Buffer.from(buffer.subarray(0, bytesRead))
      hash.update(chunk)
      streamedBytes += bytesRead
      position += bytesRead
      yield chunk
    }
    completed = true
  }
  return Object.freeze({
    chunks: chunks(),
    assertComplete() {
      if (!consumed || !completed || streamedBytes !== file.size
        || hash.digest('hex') !== file.sha256) {
        throw new Error('World FFmpeg upload did not stream the exact verified open bytes.')
      }
    },
  })
}

async function requireBoundPublicName(file) {
  const [pathInfo, handleInfo] = await Promise.all([
    lstat(file.name, { bigint: true }),
    file.handle.stat({ bigint: true }),
  ])
  if (!sameStableHandle(file.identity, handleInfo)
    || !sameBoundIdentity(pathInfo, handleInfo, {
      dev: String(file.identity.dev), ino: String(file.identity.ino),
      size: file.size, sha256: file.sha256,
    })) {
    throw new Error(`World FFmpeg upload input ${file.name} was replaced after open.`)
  }
}

async function readAndHashHandle(handle, expectedSize, captureBytes) {
  const chunks = captureBytes ? [] : undefined
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedSize))
  const hash = createHash('sha256')
  let position = 0
  while (position < expectedSize) {
    const length = Math.min(buffer.byteLength, expectedSize - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead < 1) throw new Error('World FFmpeg upload input ended early.')
    const chunk = buffer.subarray(0, bytesRead)
    hash.update(chunk)
    if (chunks) chunks.push(Buffer.from(chunk))
    position += bytesRead
  }
  return { bytes: chunks ? Buffer.concat(chunks) : undefined, sha256: hash.digest('hex') }
}

function parseCanonicalManifest(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error('World FFmpeg upload manifest is not valid JSON.')
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) {
    throw new Error('World FFmpeg upload manifest is not canonical.')
  }
  return value
}

function sameBoundIdentity(pathInfo, handleInfo, descriptor) {
  return pathInfo.isFile() && !pathInfo.isSymbolicLink() && pathInfo.nlink === 1n
    && handleInfo.isFile() && handleInfo.nlink === 1n
    && pathInfo.dev === handleInfo.dev && pathInfo.ino === handleInfo.ino
    && pathInfo.size === handleInfo.size && Number(handleInfo.size) === descriptor.size
    && String(handleInfo.dev) === descriptor.dev && String(handleInfo.ino) === descriptor.ino
}

function sameStableHandle(left, right) {
  return left.isFile() && right.isFile() && left.nlink === 1n && right.nlink === 1n
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function fileSummary(file) {
  return Object.freeze({ name: file.name, size: file.size, sha256: file.sha256 })
}

function remotePackageFileDescriptor(manifest, file) {
  let kind
  if (file.name === manifest.buildReport.path) kind = 'build-report.v1.json'
  else if (file.name === `RESULT.${manifest.target}.v1.json`) kind = 'result.v1.json'
  else if (manifest.artifacts.some(({ path }) => path === file.name)) {
    const match = /(\.[A-Za-z0-9]{1,16})$/.exec(file.name)
    kind = `artifact${match?.[1] ?? '.bin'}`
  } else {
    throw new Error('World FFmpeg package upload file kind is unbound.')
  }
  return Object.freeze({
    name: worldFfmpegGithubContentAddressedAssetName(
      `package-${manifest.target}`, file.sha256, kind,
    ),
    size: file.size,
    sha256: file.sha256,
  })
}

function fileDescriptor(file) {
  return Object.freeze({
    name: file.name,
    dev: String(file.identity.dev),
    ino: String(file.identity.ino),
    size: file.size,
    sha256: file.sha256,
  })
}

function validDirectName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(value)
}

function createLegacyInjectedReleaseClient(upload, tag) {
  if (typeof upload !== 'function') throw new Error('World FFmpeg injected upload transport is invalid.')
  const assets = new Map()
  return Object.freeze({
    async getRelease() { return Object.freeze({ id: 1, tag, draft: true }) },
    async getDraftRelease() { return Object.freeze({ id: 1, tag, draft: true }) },
    async listAssets() { return Object.freeze([...assets.values()]) },
    async verifyAsset({ asset, expected }) {
      const observed = assets.get(asset.name)
      if (!observed || observed.id !== asset.id || observed.size !== expected.size) {
        throw new Error('World FFmpeg injected upload asset conflict.')
      }
      return Object.freeze({ size: expected.size, sha256: expected.sha256 })
    },
    async uploadAsset({ name, size, chunks }) {
      const response = await upload({ name, size, chunks })
      if (!response || !Number.isSafeInteger(response.assetId) || response.assetId < 1
        || response.name !== name) {
        throw new Error('World FFmpeg injected upload returned an invalid asset receipt.')
      }
      assets.set(name, Object.freeze({ id: response.assetId, name, size }))
      return Object.freeze({ assetId: response.assetId, name, size })
    },
  })
}

async function getWorldFfmpegUploadRelease(client) {
  if (typeof client?.getRelease === 'function') return client.getRelease()
  if (typeof client?.getDraftRelease === 'function') return client.getDraftRelease()
  throw new Error('World FFmpeg upload client cannot prove release authority.')
}

async function reconcilePublishedWorldFfmpegPackage(input) {
  const {
    client, release, repository, tag, manifest, receipt, uploadFiles, lock, setupReceiptSha256,
  } = input
  if (typeof client.listAssets !== 'function' || typeof client.verifyAsset !== 'function'
    || typeof client.readAsset !== 'function') {
    throw new Error('World FFmpeg public release client cannot reconcile exact package bytes.')
  }
  const namespace = `package-${manifest.target}`
  const prefix = `world-ffmpeg-${namespace}-`
  const remoteNamespace = (await client.listAssets(release.id)).filter(({ name }) => name.startsWith(prefix))
  const receiptCandidates = remoteNamespace.filter((asset) => (
    parsePackageRemoteAssetName(asset.name, manifest.target)?.kind === 'upload-receipt.v1.json'
  ))
  if (receiptCandidates.length !== 1) {
    throw new Error(`World FFmpeg public ${manifest.target} release has no unique upload receipt authority.`)
  }
  const uploadReceiptFile = await readPublishedRemoteFile(
    client,
    receiptCandidates[0],
    MAX_UPLOAD_RECEIPT_BYTES,
    manifest.target,
    'package upload receipt',
  )
  const uploadReceipt = requireWorldFfmpegPackageUploadReceipt(
    parseCanonicalRemoteJson(uploadReceiptFile.bytes, 'package upload receipt'),
    { target: manifest.target, repository, tag, releaseId: release.id, setupReceiptSha256 },
  )
  const expectedNamespace = [...uploadReceipt.assets, uploadReceiptFile.descriptor]
  requireExactPublishedNamespace(remoteNamespace, expectedNamespace, manifest.target)
  for (const expected of expectedNamespace) {
    await client.verifyAsset({
      asset: findRemoteDescriptor(remoteNamespace, expected),
      expected,
    })
  }

  // A new workflow attempt has fresh local filesystem and attempt identities, so
  // its RESULT bytes are intentionally different. The deployable artifact,
  // build report, runtime digest, and the prior remote RESULT must all remain
  // exact before the prior target receipt can be reconstructed.
  for (const file of uploadFiles) {
    if (file.name === `RESULT.${manifest.target}.v1.json`) continue
    const expected = remotePackageFileDescriptor(manifest, file)
    if (!uploadReceipt.assets.some((asset) => sameRemoteDescriptor(asset, expected))) {
      throw new Error(`World FFmpeg public ${manifest.target} package bytes conflict with the rebuilt attempt.`)
    }
  }
  const resultAsset = uploadReceipt.assets.find((asset) => packageRemoteKind(asset, manifest.target) === 'result.v1.json')
  if (!resultAsset) throw new Error('World FFmpeg public package receipt omits its RESULT authority.')
  const resultFile = await readPublishedRemoteFile(
    client,
    findRemoteDescriptor(remoteNamespace, resultAsset),
    MAX_RESULT_BYTES,
    manifest.target,
    'package RESULT',
  )
  if (!sameRemoteDescriptor(resultFile.descriptor, resultAsset)) {
    throw new Error('World FFmpeg public package RESULT descriptor conflicts with its upload receipt.')
  }
  const publishedManifest = parseCanonicalRemoteJson(resultFile.bytes, 'package RESULT')
  const syntheticReceipt = {
    schema: 'modly.electron-builder-package-result-receipt.v1',
    attemptId: publishedManifest?.attemptId,
    target: publishedManifest?.target,
    publicationToken: publishedManifest?.publicationToken,
    manifestPath: `/remote/output-${publishedManifest?.attemptId}/RESULT.${publishedManifest?.target}.v1.json`,
    outputIdentity: publishedManifest?.outputIdentity,
    manifestFile: {
      name: `RESULT.${publishedManifest?.target}.v1.json`,
      dev: '0',
      ino: '1',
      size: resultFile.descriptor.size,
      sha256: resultFile.descriptor.sha256,
    },
  }
  const verifiedManifest = requireWorldFfmpegPackageResultManifest(
    publishedManifest,
    syntheticReceipt,
    lock.extractors[manifest.target],
  )
  if (verifiedManifest.attemptId !== uploadReceipt.attemptId
    || verifiedManifest.publicationToken !== uploadReceipt.publicationToken
    || verifiedManifest.inspection.runtimeManifestSha256 !== manifest.inspection.runtimeManifestSha256) {
    throw new Error('World FFmpeg public package RESULT authority conflicts with the rebuilt attempt.')
  }
  const resultAuthorities = [
    ...verifiedManifest.artifacts.map((artifact) => remotePackageDescriptorForManifestEntry(
      verifiedManifest.target, artifact, 'artifact',
    )),
    remotePackageDescriptorForManifestEntry(
      verifiedManifest.target, verifiedManifest.buildReport, 'build-report.v1.json',
    ),
    resultFile.descriptor,
  ]
  if (resultAuthorities.length !== uploadReceipt.assets.length
    || resultAuthorities.some((expected) => (
      !uploadReceipt.assets.some((asset) => sameRemoteDescriptor(asset, expected))
    ))) {
    throw new Error('World FFmpeg public package RESULT does not bind the complete remote asset set.')
  }
  const uploadResultReceipt = Object.freeze({
    schema: 'modly.electron-builder-package-upload-result-receipt.v1',
    target: uploadReceipt.target,
    attemptId: uploadReceipt.attemptId,
    publicationToken: uploadReceipt.publicationToken,
    repository,
    tag,
    releaseId: release.id,
    setupReceiptSha256,
    outputIdentity: verifiedManifest.outputIdentity,
    uploadReceiptFile: uploadReceiptFile.descriptor,
  })
  requireWorldFfmpegPackageUploadResultReceipt(uploadResultReceipt, {
    target: manifest.target, repository, tag, releaseId: release.id, setupReceiptSha256,
  })
  for (const file of uploadFiles) await requireBoundPublicName(file)
  await requireAnchoredOutputRoot(receipt, dirname(receipt.manifestPath))
  return Object.freeze({ uploadReceipt, uploadResultReceipt })
}

async function readPublishedRemoteFile(client, asset, maximumBytes, target, label) {
  if (!Number.isSafeInteger(asset?.id) || asset.id < 1
    || !Number.isSafeInteger(asset?.size) || asset.size < 1 || asset.size > maximumBytes) {
    throw new Error(`World FFmpeg public ${label} identity is invalid.`)
  }
  const parsedName = parsePackageRemoteAssetName(asset.name, target)
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

function parseCanonicalRemoteJson(bytes, label) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error(`World FFmpeg public ${label} is invalid JSON.`)
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) {
    throw new Error(`World FFmpeg public ${label} is not canonical.`)
  }
  return value
}

function requireExactPublishedNamespace(remoteAssets, expectedAssets, target) {
  if (remoteAssets.length !== expectedAssets.length) {
    throw new Error(`World FFmpeg public ${target} package namespace has foreign or missing assets.`)
  }
  const names = new Set()
  const ids = new Set()
  for (const expected of expectedAssets) {
    if (names.has(expected.name) || ids.has(expected.githubAssetId)) {
      throw new Error(`World FFmpeg public ${target} package receipt assets collide.`)
    }
    names.add(expected.name)
    ids.add(expected.githubAssetId)
    findRemoteDescriptor(remoteAssets, expected)
  }
}

function findRemoteDescriptor(remoteAssets, expected) {
  const byName = remoteAssets.filter(({ name }) => name === expected.name)
  const byId = remoteAssets.filter(({ id }) => id === expected.githubAssetId)
  if (byName.length !== 1 || byId.length !== 1 || byName[0] !== byId[0]
    || byName[0].size !== expected.size) {
    throw new Error(`World FFmpeg public package remote asset conflicts: ${expected.name}.`)
  }
  return byName[0]
}

function remotePackageDescriptorForManifestEntry(target, entry, kind) {
  let remoteKind = kind
  if (kind === 'artifact') {
    const match = /(\.[A-Za-z0-9]{1,16})$/.exec(entry.path)
    remoteKind = `artifact${match?.[1] ?? '.bin'}`
  }
  return Object.freeze({
    name: worldFfmpegGithubContentAddressedAssetName(`package-${target}`, entry.sha256, remoteKind),
    size: entry.size,
    sha256: entry.sha256,
  })
}

function parsePackageRemoteAssetName(name, target) {
  const match = new RegExp(`^world-ffmpeg-package-${target}-([a-f0-9]{64})-([A-Za-z0-9][A-Za-z0-9._-]{0,80})$`).exec(name ?? '')
  return match ? Object.freeze({ sha256: match[1], kind: match[2] }) : null
}

function sameRemoteDescriptor(left, right) {
  return left.name === right.name && left.size === right.size && left.sha256 === right.sha256
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function requireWorldFfmpegPackageUploadReceipt(value, expected = {}) {
  if (!exactRecord(value, [
    'schema', 'target', 'attemptId', 'publicationToken', 'repository', 'tag', 'releaseId',
    'setupReceiptSha256', 'assets',
  ]) || value.schema !== UPLOAD_SCHEMA || !/^(?:darwin-arm64|linux-arm64|linux-x64|win32-x64)$/.test(value.target)
    || !/^[a-f0-9]{32}$/.test(value.attemptId) || !/^[a-f0-9]{32}$/.test(value.publicationToken)
    || requireWorldFfmpegRepository(value.repository) !== value.repository
    || requireWorldFfmpegReleaseTag(value.tag) !== value.tag
    || !Number.isSafeInteger(value.releaseId) || value.releaseId < 1
    || !/^[a-f0-9]{64}$/.test(value.setupReceiptSha256)
    || !Array.isArray(value.assets) || value.assets.length < 3 || value.assets.length > 66
    || value.assets.some((asset) => !validRemoteAssetDescriptor(asset))) {
    throw new Error('World FFmpeg package upload receipt is invalid.')
  }
  if ((expected.target !== undefined && value.target !== expected.target)
    || (expected.attemptId !== undefined && value.attemptId !== expected.attemptId)
    || (expected.publicationToken !== undefined && value.publicationToken !== expected.publicationToken)
    || (expected.repository !== undefined && value.repository !== expected.repository)
    || (expected.tag !== undefined && value.tag !== expected.tag)
    || (expected.releaseId !== undefined && value.releaseId !== expected.releaseId)
    || (expected.setupReceiptSha256 !== undefined
      && value.setupReceiptSha256 !== expected.setupReceiptSha256)) {
    throw new Error('World FFmpeg package upload receipt authority mismatches.')
  }
  const names = value.assets.map(({ name }) => name)
  const kinds = value.assets.map((asset) => packageRemoteKind(asset, value.target))
  if (new Set(names).size !== names.length
    || !kinds.includes('build-report.v1.json')
    || !kinds.includes('result.v1.json')
    || kinds.filter((kind) => kind.startsWith('artifact.')).length < 1) {
    throw new Error('World FFmpeg package upload receipt names collide or omit required evidence.')
  }
  return Object.freeze(structuredClone(value))
}

export function requireWorldFfmpegPackageUploadResultReceipt(value, expected = {}) {
  if (!exactRecord(value, [
    'schema', 'target', 'attemptId', 'publicationToken', 'repository', 'tag', 'releaseId',
    'setupReceiptSha256', 'outputIdentity', 'uploadReceiptFile',
  ]) || value.schema !== 'modly.electron-builder-package-upload-result-receipt.v1'
    || !/^(?:darwin-arm64|linux-arm64|linux-x64|win32-x64)$/.test(value.target)
    || !/^[a-f0-9]{32}$/.test(value.attemptId) || !/^[a-f0-9]{32}$/.test(value.publicationToken)
    || requireWorldFfmpegRepository(value.repository) !== value.repository
    || requireWorldFfmpegReleaseTag(value.tag) !== value.tag
    || !Number.isSafeInteger(value.releaseId) || value.releaseId < 1
    || !/^[a-f0-9]{64}$/.test(value.setupReceiptSha256)
    || !validOutputIdentity(value.outputIdentity)
    || !validRemoteAssetDescriptor(value.uploadReceiptFile)
    || packageRemoteKind(value.uploadReceiptFile, value.target) !== 'upload-receipt.v1.json') {
    throw new Error('World FFmpeg package upload result receipt is invalid.')
  }
  if ((expected.target !== undefined && value.target !== expected.target)
    || (expected.repository !== undefined && value.repository !== expected.repository)
    || (expected.tag !== undefined && value.tag !== expected.tag)
    || (expected.releaseId !== undefined && value.releaseId !== expected.releaseId)
    || (expected.setupReceiptSha256 !== undefined
      && value.setupReceiptSha256 !== expected.setupReceiptSha256)) {
    throw new Error('World FFmpeg package upload result receipt authority mismatches.')
  }
  return Object.freeze(structuredClone(value))
}

function validRemoteAssetDescriptor(value) {
  return exactRecord(value, ['name', 'size', 'sha256', 'githubAssetId'])
    && validDirectName(value.name)
    && Number.isSafeInteger(value.size) && value.size >= 1 && value.size <= MAX_ARTIFACT_BYTES
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.githubAssetId) && value.githubAssetId >= 1
}

function packageRemoteKind(value, target) {
  const match = new RegExp(`^world-ffmpeg-package-${target}-([a-f0-9]{64})-([A-Za-z0-9][A-Za-z0-9._-]{0,80})$`).exec(value?.name ?? '')
  if (!match || match[1] !== value.sha256) {
    throw new Error('World FFmpeg package upload content address is invalid.')
  }
  return match[2]
}

function validOutputIdentity(value) {
  return exactRecord(value, ['dev', 'ino'])
    && /^[0-9]{1,40}$/.test(value.dev) && /^[1-9][0-9]{0,39}$/.test(value.ino)
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function decodeReceipt(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > 16 * 1024
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('World FFmpeg package-result receipt encoding is invalid.')
  }
  try {
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') !== value) throw new Error('noncanonical')
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!bytes.equals(Buffer.from(JSON.stringify(parsed)))) throw new Error('noncanonical')
    return requireWorldFfmpegPackageResultReceipt(parsed)
  } catch {
    throw new Error('World FFmpeg package-result receipt encoding is invalid.')
  }
}

function parseArguments(argv) {
  if (argv.length === 3 && argv[0] === '--verify-only' && argv[1] === '--github-output') {
    return { verifyOnly: true, githubOutput: argv[2] }
  }
  if (argv.length === 6 && argv[0] === '--tag' && argv[2] === '--repository'
    && argv[4] === '--github-output') {
    return { verifyOnly: false, tag: argv[1], repository: argv[3], githubOutput: argv[5] }
  }
  throw new Error('Usage: world-ffmpeg-release-uploader.mjs --verify-only --github-output <path> | --tag <tag> --repository <owner/repo> --github-output <path>')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const args = parseArguments(process.argv.slice(2))
    const encodedReceipt = process.env.WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT
    const result = await verifyOrUploadWorldFfmpegPackageResult({
      ...args,
      resultReceipt: decodeReceipt(encodedReceipt),
      releaseSetupReceipt: args.verifyOnly
        ? undefined
        : decodeWorldFfmpegReleaseReceipt(process.env.WORLD_FFMPEG_RELEASE_DRAFT_RECEIPT),
      token: process.env.GH_TOKEN,
    })
    if (args.verifyOnly) {
      const encoded = Buffer.from(JSON.stringify(result.verificationReceipt)).toString('base64')
      await writeWorldFfmpegGithubOutput(
        args.githubOutput,
        'WORLD_FFMPEG_PACKAGE_VERIFICATION_RECEIPT',
        encoded,
      )
      process.stdout.write(`WORLD_FFMPEG_PACKAGE_VERIFICATION_RECEIPT=${encoded}\n`)
      process.stdout.write(`Verified ${result.verified.length} exact open ${result.target} package files; uploaded=false.\n`)
    } else {
      const encoded = Buffer.from(JSON.stringify(result.uploadResultReceipt)).toString('base64')
      await writeWorldFfmpegGithubOutput(
        args.githubOutput,
        'WORLD_FFMPEG_PACKAGE_UPLOAD_RECEIPT',
        encoded,
      )
      process.stdout.write(`WORLD_FFMPEG_PACKAGE_UPLOAD_RECEIPT=${encoded}\n`)
    }
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg release upload failed.'}\n`)
    process.exitCode = 1
  })
}
