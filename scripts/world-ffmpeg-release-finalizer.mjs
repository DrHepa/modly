#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createWorldFfmpegGithubReleaseClient,
  decodeWorldFfmpegReleaseReceipt,
  encodeWorldFfmpegReleaseReceipt,
  requireWorldFfmpegReleaseTag,
  requireWorldFfmpegRepository,
  writeWorldFfmpegGithubOutput,
} from './world-ffmpeg-github-release.mjs'
import {
  requireWorldFfmpegPackageUploadReceipt,
  requireWorldFfmpegPackageUploadResultReceipt,
} from './world-ffmpeg-release-uploader.mjs'
import {
  requireWorldFfmpegSourceUploadReceipt,
  requireWorldFfmpegSourceUploadResultReceipt,
} from './world-ffmpeg-source-release-uploader.mjs'
import {
  requireWorldFfmpegReleaseDraftReceipt,
  verifyWorldFfmpegReleaseSetup,
  worldFfmpegReleaseMetadataSha256,
  worldFfmpegReleaseSetupReceiptSha256,
} from './world-ffmpeg-release-draft.mjs'

const PUBLICATION_SCHEMA = 'modly.world-ffmpeg-release-publication-receipt.v1'
const PUBLICATION_PROOF_SCHEMA = 'modly.world-ffmpeg-release-publication-proof.v1'
const TARGETS = Object.freeze(['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'])
const MAX_UPLOAD_RECEIPT_BYTES = 256 * 1024

export async function finalizeWorldFfmpegRelease(input) {
  const repository = requireWorldFfmpegRepository(input?.repository)
  const tag = requireWorldFfmpegReleaseTag(input?.tag)
  const setup = requireWorldFfmpegReleaseDraftReceipt(input?.releaseSetupReceipt, {
    repository,
    tag,
  })
  const setupReceiptSha256 = worldFfmpegReleaseSetupReceiptSha256(setup)
  const sourceResult = requireWorldFfmpegSourceUploadResultReceipt(
    input?.sourceUploadReceipt,
    { repository, tag, releaseId: setup.releaseId, setupReceiptSha256 },
  )
  if (!Array.isArray(input?.packageUploadReceipts) || input.packageUploadReceipts.length !== TARGETS.length) {
    throw new Error('World FFmpeg release finalization requires exactly four target upload receipts.')
  }
  const packageResults = input.packageUploadReceipts.map((value) => (
    requireWorldFfmpegPackageUploadResultReceipt(value, {
      repository,
      tag,
      releaseId: setup.releaseId,
      setupReceiptSha256,
    })
  ))
  const targets = packageResults.map(({ target }) => target).sort(codeUnitCompare)
  if (!sameArray(targets, TARGETS)) {
    throw new Error('World FFmpeg release finalization target tuple is incomplete or duplicated.')
  }
  const releaseIds = new Set([
    setup.releaseId,
    sourceResult.releaseId,
    ...packageResults.map(({ releaseId }) => releaseId),
  ])
  if (releaseIds.size !== 1) {
    throw new Error('World FFmpeg release finalization receipts bind different setup releases.')
  }
  const releaseId = setup.releaseId
  const client = input.releaseClient ?? createWorldFfmpegGithubReleaseClient({
    repository,
    tag,
    token: input.token,
  })
  if (typeof client.getRelease !== 'function') {
    throw new Error('World FFmpeg release client cannot prove release authority.')
  }
  const release = await client.getRelease()
  await verifyWorldFfmpegReleaseSetup({ client, release, receipt: setup })

  const initialAssets = await client.listAssets(releaseId)
  const sourceReceipt = requireWorldFfmpegSourceUploadReceipt(
    await readCanonicalRemoteReceipt(client, initialAssets, sourceResult.uploadReceiptFile),
    { repository, tag, releaseId, setupReceiptSha256 },
  )
  const packageReceipts = []
  for (const result of packageResults) {
    packageReceipts.push(requireWorldFfmpegPackageUploadReceipt(
      await readCanonicalRemoteReceipt(client, initialAssets, result.uploadReceiptFile),
      {
        target: result.target,
        attemptId: result.attemptId,
        publicationToken: result.publicationToken,
        repository,
        tag,
        releaseId,
        setupReceiptSha256,
      },
    ))
  }
  const expectedAssets = Object.freeze([
    setup.generationLock,
    ...sourceReceipt.assets,
    sourceResult.uploadReceiptFile,
    ...packageReceipts.flatMap((receipt) => receipt.assets),
    ...packageResults.map(({ uploadReceiptFile }) => uploadReceiptFile),
  ].map((asset) => Object.freeze(structuredClone(asset))).sort(({ name: left }, { name: right }) => (
    codeUnitCompare(left, right)
  )))
  requireUniqueDescriptors(expectedAssets)
  requireExactRemoteSet(initialAssets, expectedAssets)

  // Hash every remote byte immediately before publication. A second list after
  // hashing catches delete/recreate ABA because GitHub assigns a new asset id.
  for (const expected of expectedAssets) {
    await client.verifyAsset({ asset: findExactRemoteAsset(initialAssets, expected), expected })
  }
  const settledAssets = await client.listAssets(releaseId)
  requireExactRemoteSet(settledAssets, expectedAssets)

  const transition = release.draft
    ? requireReleasePublicationResult(
      await client.publishRelease({ releaseId, metadata: setup.metadata }),
      { releaseId, tag, metadataSha256: worldFfmpegReleaseMetadataSha256(setup.metadata) },
    )
    : Object.freeze({
      release,
      publicationProof: Object.freeze({
        schema: PUBLICATION_PROOF_SCHEMA,
        releaseId,
        tag,
        requestSha256: null,
        metadataSha256: worldFfmpegReleaseMetadataSha256(setup.metadata),
        settlement: 'preexisting-public',
      }),
    })
  if (!transition.release || transition.release.id !== releaseId
    || transition.release.tag !== tag || transition.release.draft !== false) {
    throw new Error('World FFmpeg release publication did not settle on the expected release.')
  }
  const postRelease = await client.getRelease()
  await verifyWorldFfmpegReleaseSetup({ client, release: postRelease, receipt: setup })
  if (postRelease.draft !== false) {
    throw new Error('World FFmpeg release post-publication state is not public.')
  }
  const postAssets = await client.listAssets(releaseId)
  requireExactRemoteSet(postAssets, expectedAssets)
  for (const expected of expectedAssets) {
    await client.verifyAsset({ asset: findExactRemoteAsset(postAssets, expected), expected })
  }
  const postSettledAssets = await client.listAssets(releaseId)
  requireExactRemoteSet(postSettledAssets, expectedAssets)
  return Object.freeze({
    schema: PUBLICATION_SCHEMA,
    repository,
    tag,
    releaseId,
    setupReceiptSha256,
    assets: expectedAssets,
    assetSetSha256: sha256(Buffer.from(JSON.stringify(expectedAssets))),
    publicationProof: transition.publicationProof,
    postPublishVerified: true,
  })
}

function requireReleasePublicationResult(value, expected) {
  const release = value?.release
  const proof = value?.publicationProof
  if (!release || release.id !== expected.releaseId || release.tag !== expected.tag
    || release.draft !== false || !exactRecord(proof, [
      'schema', 'releaseId', 'tag', 'requestSha256', 'metadataSha256', 'settlement',
    ]) || proof.schema !== PUBLICATION_PROOF_SCHEMA
    || proof.releaseId !== expected.releaseId || proof.tag !== expected.tag
    || !['patch-response', 'public-reconciliation'].includes(proof.settlement)
    || typeof proof.requestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.requestSha256)
    || proof.metadataSha256 !== expected.metadataSha256) {
    throw new Error('World FFmpeg release publication proof is invalid.')
  }
  return Object.freeze({ release, publicationProof: Object.freeze(structuredClone(proof)) })
}

async function readCanonicalRemoteReceipt(client, remoteAssets, expected) {
  const asset = findExactRemoteAsset(remoteAssets, expected)
  const bytes = await client.readAsset({ asset, maximumBytes: MAX_UPLOAD_RECEIPT_BYTES })
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== expected.size
    || sha256(bytes) !== expected.sha256) {
    throw new Error(`World FFmpeg remote upload receipt digest conflict: ${expected.name}.`)
  }
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error(`World FFmpeg remote upload receipt is invalid JSON: ${expected.name}.`)
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) {
    throw new Error(`World FFmpeg remote upload receipt is not canonical: ${expected.name}.`)
  }
  return value
}

function requireExactRemoteSet(remoteAssets, expectedAssets) {
  if (!Array.isArray(remoteAssets) || remoteAssets.length !== expectedAssets.length) {
    throw new Error('World FFmpeg release has a foreign or missing asset; exact remote asset set rejected.')
  }
  const remoteNames = new Set()
  const remoteIds = new Set()
  for (const asset of remoteAssets) {
    if (!Number.isSafeInteger(asset?.id) || asset.id < 1
      || typeof asset?.name !== 'string' || !Number.isSafeInteger(asset?.size) || asset.size < 1
      || remoteNames.has(asset.name) || remoteIds.has(asset.id)) {
      throw new Error('World FFmpeg release remote asset identities collide or are invalid.')
    }
    remoteNames.add(asset.name)
    remoteIds.add(asset.id)
  }
  for (const expected of expectedAssets) findExactRemoteAsset(remoteAssets, expected)
}

function findExactRemoteAsset(remoteAssets, expected) {
  const byName = remoteAssets.filter(({ name }) => name === expected.name)
  const byId = remoteAssets.filter(({ id }) => id === expected.githubAssetId)
  if (byName.length !== 1 || byId.length !== 1 || byName[0] !== byId[0]
    || byName[0].size !== expected.size) {
    throw new Error(`World FFmpeg release missing or conflicting remote asset: ${expected.name}.`)
  }
  return byName[0]
}

function requireUniqueDescriptors(assets) {
  const names = new Set()
  const ids = new Set()
  for (const asset of assets) {
    if (names.has(asset.name) || ids.has(asset.githubAssetId)) {
      throw new Error('World FFmpeg release receipt assets collide.')
    }
    names.add(asset.name)
    ids.add(asset.githubAssetId)
  }
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort(codeUnitCompare)
  const expected = [...keys].sort(codeUnitCompare)
  return sameArray(actual, expected)
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

function parseArguments(argv) {
  if (argv.length === 6 && argv[0] === '--tag' && argv[2] === '--repository'
    && argv[4] === '--github-output') {
    return { tag: argv[1], repository: argv[3], githubOutput: argv[5] }
  }
  throw new Error('Usage: world-ffmpeg-release-finalizer.mjs --tag <tag> --repository <owner/repo> --github-output <path>')
}

function requireEncodedReceipt(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string') throw new Error(`World FFmpeg finalization receipt is unavailable: ${name}.`)
  return decodeWorldFfmpegReleaseReceipt(value)
}

export function worldFfmpegFinalizerCliReceipts(environment) {
  return Object.freeze([
    requireEncodedReceipt(environment, 'WORLD_FFMPEG_WINDOWS_UPLOAD_RECEIPT'),
    requireEncodedReceipt(environment, 'WORLD_FFMPEG_DARWIN_UPLOAD_RECEIPT'),
    requireEncodedReceipt(environment, 'WORLD_FFMPEG_LINUX_UPLOAD_RECEIPT'),
    requireEncodedReceipt(environment, 'WORLD_FFMPEG_LINUX_ARM64_UPLOAD_RECEIPT'),
  ])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const args = parseArguments(process.argv.slice(2))
    const result = await finalizeWorldFfmpegRelease({
      ...args,
      token: process.env.GH_TOKEN,
      releaseSetupReceipt: requireEncodedReceipt(
        process.env,
        'WORLD_FFMPEG_RELEASE_DRAFT_RECEIPT',
      ),
      sourceUploadReceipt: requireEncodedReceipt(process.env, 'WORLD_FFMPEG_SOURCE_UPLOAD_RECEIPT'),
      packageUploadReceipts: worldFfmpegFinalizerCliReceipts(process.env),
    })
    const encoded = encodeWorldFfmpegReleaseReceipt(result)
    await writeWorldFfmpegGithubOutput(
      args.githubOutput,
      'WORLD_FFMPEG_RELEASE_PUBLICATION_RECEIPT',
      encoded,
    )
    process.stdout.write(`WORLD_FFMPEG_RELEASE_PUBLICATION_RECEIPT=${encoded}\n`)
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg release finalization failed.'}\n`)
    process.exitCode = 1
  })
}
