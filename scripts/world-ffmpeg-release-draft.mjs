#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createWorldFfmpegGithubReleaseClient,
  encodeWorldFfmpegReleaseReceipt,
  reconcileWorldFfmpegGithubAsset,
  requireWorldFfmpegReleaseTag,
  requireWorldFfmpegRepository,
  writeWorldFfmpegGithubOutput,
} from './world-ffmpeg-github-release.mjs'

const DRAFT_SCHEMA = 'modly.world-ffmpeg-release-draft-receipt.v1'
const LOCK_SCHEMA = 'modly.world-ffmpeg-release-generation-lock.v1'
export const WORLD_FFMPEG_RELEASE_GENERATION_LOCK_NAME = 'WORLD_FFMPEG_RELEASE_GENERATION.v1.json'
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function worldFfmpegReleaseBodyFor(tag) {
  return `World FFmpeg release evidence for ${requireWorldFfmpegReleaseTag(tag)}.`
}

export async function ensureWorldFfmpegReleaseDraft(input) {
  const repository = requireWorldFfmpegRepository(input?.repository)
  const tag = requireWorldFfmpegReleaseTag(input?.tag)
  const metadata = requireSetupMetadata({
    tag,
    title: input?.title,
    body: input?.body ?? worldFfmpegReleaseBodyFor(tag),
    targetCommitish: input?.targetCommitish,
    draft: true,
  })
  const client = input.releaseClient ?? createWorldFfmpegGithubReleaseClient({
    repository,
    tag,
    token: input.token,
  })
  const ensureRelease = typeof client?.ensureRelease === 'function'
    ? client.ensureRelease.bind(client)
    : client?.ensureDraftRelease?.bind(client)
  if (typeof ensureRelease !== 'function') {
    throw new Error('World FFmpeg release setup client is invalid.')
  }
  const release = await ensureRelease({
    title: metadata.title,
    body: metadata.body,
    targetCommitish: metadata.targetCommitish,
  })
  requireReleaseMatchesSetup(release, { repository, tag, metadata })
  const lockBytes = generationLockBytes({ repository, releaseId: release.id, metadata })
  const expectedLock = Object.freeze({
    name: WORLD_FFMPEG_RELEASE_GENERATION_LOCK_NAME,
    size: lockBytes.byteLength,
    sha256: sha256(lockBytes),
  })
  const generationLock = await ensureGenerationLock({
    client,
    release,
    expected: expectedLock,
    bytes: lockBytes,
  })
  const receipt = Object.freeze({
    schema: DRAFT_SCHEMA,
    repository,
    tag,
    releaseId: release.id,
    metadata,
    generationLock,
  })
  return requireWorldFfmpegReleaseDraftReceipt(receipt, {
    repository,
    tag,
    title: metadata.title,
    body: metadata.body,
    targetCommitish: metadata.targetCommitish,
  })
}

export function requireWorldFfmpegReleaseDraftReceipt(value, expected = {}) {
  if (!exactRecord(value, [
    'schema', 'repository', 'tag', 'releaseId', 'metadata', 'generationLock',
  ]) || value.schema !== DRAFT_SCHEMA
    || requireWorldFfmpegRepository(value.repository) !== value.repository
    || requireWorldFfmpegReleaseTag(value.tag) !== value.tag
    || !Number.isSafeInteger(value.releaseId) || value.releaseId < 1) {
    throw new Error('World FFmpeg release setup receipt is invalid.')
  }
  const metadata = requireSetupMetadata(value.metadata)
  const lock = requireRemoteLockDescriptor(value.generationLock)
  const expectedBytes = generationLockBytes({
    repository: value.repository,
    releaseId: value.releaseId,
    metadata,
  })
  if (metadata.tag !== value.tag || lock.name !== WORLD_FFMPEG_RELEASE_GENERATION_LOCK_NAME
    || lock.size !== expectedBytes.byteLength || lock.sha256 !== sha256(expectedBytes)
    || (expected.repository !== undefined && expected.repository !== value.repository)
    || (expected.tag !== undefined && expected.tag !== value.tag)
    || (expected.releaseId !== undefined && expected.releaseId !== value.releaseId)
    || (expected.title !== undefined && expected.title !== metadata.title)
    || (expected.body !== undefined && expected.body !== metadata.body)
    || (expected.targetCommitish !== undefined
      && expected.targetCommitish !== metadata.targetCommitish)) {
    throw new Error('World FFmpeg release setup receipt authority mismatches.')
  }
  return Object.freeze(structuredClone(value))
}

export function worldFfmpegReleaseSetupReceiptSha256(value) {
  const receipt = requireWorldFfmpegReleaseDraftReceipt(value)
  return sha256(Buffer.from(JSON.stringify(receipt)))
}

export function worldFfmpegReleaseMetadataSha256(value) {
  return sha256(Buffer.from(`${JSON.stringify(requireSetupMetadata(value))}\n`))
}

export async function verifyWorldFfmpegReleaseSetup(input) {
  const receipt = requireWorldFfmpegReleaseDraftReceipt(input?.receipt)
  const release = input?.release
  requireReleaseMatchesSetup(release, receipt)
  const client = input?.client
  if (typeof client?.listAssets !== 'function' || typeof client?.verifyAsset !== 'function') {
    throw new Error('World FFmpeg release setup verification client is invalid.')
  }
  const matches = (await client.listAssets(receipt.releaseId)).filter(({ name }) => (
    name === receipt.generationLock.name
  ))
  if (matches.length !== 1) {
    throw new Error('World FFmpeg release generation lock is missing or ambiguous.')
  }
  const remote = matches[0]
  if (remote.id !== receipt.generationLock.githubAssetId
    || remote.size !== receipt.generationLock.size) {
    throw new Error('World FFmpeg release generation lock identity conflicts.')
  }
  await client.verifyAsset({ asset: remote, expected: receipt.generationLock })
  return Object.freeze({
    receipt,
    setupReceiptSha256: worldFfmpegReleaseSetupReceiptSha256(receipt),
  })
}

function requireReleaseMatchesSetup(release, setup) {
  const metadata = requireSetupMetadata(setup.metadata)
  if (!Number.isSafeInteger(release?.id) || release.id < 1
    || (setup.releaseId !== undefined && release.id !== setup.releaseId)
    || release.tag !== setup.tag || release.tag !== metadata.tag
    || release.title !== metadata.title || release.body !== metadata.body
    || release.targetCommitish !== metadata.targetCommitish
    || typeof release.draft !== 'boolean') {
    throw new Error('World FFmpeg release setup authority mismatches.')
  }
  return release
}

async function ensureGenerationLock({ client, release, expected, bytes }) {
  if (typeof client?.listAssets !== 'function' || typeof client?.verifyAsset !== 'function') {
    throw new Error('World FFmpeg release setup cannot prove its generation lock.')
  }
  const find = async () => {
    const matches = (await client.listAssets(release.id)).filter(({ name }) => name === expected.name)
    if (matches.length > 1) throw new Error('World FFmpeg release generation lock is ambiguous.')
    if (matches.length === 0) return null
    const asset = matches[0]
    if (asset.size !== expected.size) throw new Error('World FFmpeg release generation lock size conflicts.')
    await client.verifyAsset({ asset, expected })
    return Object.freeze({ ...expected, githubAssetId: asset.id })
  }
  const existing = await find()
  if (existing) return existing
  if (release.draft !== true) {
    throw new Error('World FFmpeg public release is missing its immutable generation lock.')
  }
  if (typeof client.uploadAsset !== 'function') {
    throw new Error('World FFmpeg release setup cannot publish its generation lock.')
  }
  const response = await reconcileWorldFfmpegGithubAsset({
    client,
    releaseId: release.id,
    expected,
    createStream: () => createBufferStream(bytes, expected.sha256),
  })
  const settled = await find()
  if (!settled || settled.githubAssetId !== response.assetId) {
    throw new Error('World FFmpeg release generation lock publication did not settle.')
  }
  return settled
}

function generationLockBytes({ repository, releaseId, metadata }) {
  return Buffer.from(`${JSON.stringify({
    schema: LOCK_SCHEMA,
    repository,
    releaseId,
    metadata,
  })}\n`)
}

function createBufferStream(bytes, expectedSha256) {
  let consumed = false
  let complete = false
  return Object.freeze({
    chunks: (async function * () {
      if (consumed) throw new Error('World FFmpeg release generation lock stream was reused.')
      consumed = true
      yield bytes
      complete = true
    })(),
    assertComplete() {
      if (!consumed || !complete || sha256(bytes) !== expectedSha256) {
        throw new Error('World FFmpeg release generation lock did not stream exact bytes.')
      }
    },
  })
}

function requireSetupMetadata(value) {
  if (!exactRecord(value, ['tag', 'title', 'body', 'targetCommitish', 'draft'])
    || requireWorldFfmpegReleaseTag(value.tag) !== value.tag
    || requireTitle(value.title) !== value.title
    || requireBody(value.body) !== value.body
    || requireTargetCommitish(value.targetCommitish) !== value.targetCommitish
    || value.draft !== true) {
    throw new Error('World FFmpeg release setup metadata is invalid.')
  }
  return Object.freeze(structuredClone(value))
}

function requireRemoteLockDescriptor(value) {
  if (!exactRecord(value, ['name', 'size', 'sha256', 'githubAssetId'])
    || value.name !== WORLD_FFMPEG_RELEASE_GENERATION_LOCK_NAME
    || !Number.isSafeInteger(value.size) || value.size < 2 || value.size > 64 * 1024
    || !SHA256_PATTERN.test(value.sha256)
    || !Number.isSafeInteger(value.githubAssetId) || value.githubAssetId < 1) {
    throw new Error('World FFmpeg release generation lock descriptor is invalid.')
  }
  return value
}

function requireTitle(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255
    || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error('World FFmpeg release title is invalid.')
  }
  return value
}

function requireBody(value) {
  if (typeof value !== 'string' || value.length > 16 * 1024 || value.includes('\0')
    || value.includes('\r')) {
    throw new Error('World FFmpeg release body is invalid.')
  }
  return value
}

function requireTargetCommitish(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error('World FFmpeg release target commit authority is invalid.')
  }
  return value
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort(codeUnitCompare)
  const expected = [...keys].sort(codeUnitCompare)
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseArguments(argv) {
  if (argv.length === 10 && argv[0] === '--tag' && argv[2] === '--repository'
    && argv[4] === '--title' && argv[6] === '--target-commitish' && argv[8] === '--github-output') {
    return {
      tag: argv[1],
      repository: argv[3],
      title: argv[5],
      targetCommitish: argv[7],
      githubOutput: argv[9],
    }
  }
  throw new Error('Usage: world-ffmpeg-release-draft.mjs --tag <tag> --repository <owner/repo> --title <title> --target-commitish <sha> --github-output <path>')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const args = parseArguments(process.argv.slice(2))
    const receipt = await ensureWorldFfmpegReleaseDraft({
      ...args,
      token: process.env.GH_TOKEN,
    })
    const encoded = encodeWorldFfmpegReleaseReceipt(receipt)
    await writeWorldFfmpegGithubOutput(
      args.githubOutput,
      'WORLD_FFMPEG_RELEASE_DRAFT_RECEIPT',
      encoded,
    )
    process.stdout.write(`WORLD_FFMPEG_RELEASE_DRAFT_RECEIPT=${encoded}\n`)
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg release draft setup failed.'}\n`)
    process.exitCode = 1
  })
}
