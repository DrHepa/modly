import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { syncWorldFfmpegDirectory, syncWorldFfmpegFile } from './world-ffmpeg-durability.mjs'
import {
  quarantineAndReclaimWorldFfmpegDirectory,
  quarantineAndReclaimWorldFfmpegFile,
  recoverWorldFfmpegOwnedGarbage,
} from './world-ffmpeg-owned-garbage.mjs'

const ARCHIVE_NAME = 'modly-world-ffmpeg-7.1.1-sources.tar.xz'
const CHECKSUM_NAME = `${ARCHIVE_NAME}.sha256`
export const WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY = 'GENERATION.v1.json'
export const WORLD_FFMPEG_SOURCE_GENERATION_READY = 'READY.v1.json'
export const WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY = 'modly-world-ffmpeg-7.1.1-sources'
const CLAIM_NAME = `.${WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY}.claim.v1.json`
const GENERATION_SCHEMA = 'modly.world-ffmpeg-source-generation.v1'
const READY_SCHEMA = 'modly.world-ffmpeg-source-generation-ready.v1'
const SOURCE_PUBLICATION_GARBAGE_MAXIMUM_BYTES = 2 * 1024 * 1024 * 1024 + 16 * 1024

export async function publishWorldFfmpegSourceGeneration(input) {
  const preparedDirectory = requireAbsolute(input?.preparedDirectory, 'prepared source generation')
  const destinationDirectory = requireAbsolute(input?.destinationDirectory, 'source publication destination')
  const finalDirectory = join(destinationDirectory, WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY)
  if (pathsOverlap(preparedDirectory, finalDirectory)) {
    throw new Error('Prepared source generation must not overlap the published generation.')
  }
  for (const parentDirectory of new Set([dirname(preparedDirectory), destinationDirectory])) {
    const garbage = await recoverWorldFfmpegOwnedGarbage({
      parentDirectory,
      minimumAgeMs: input?.garbageRecoveryMinimumAgeMs,
      maximumBytes: SOURCE_PUBLICATION_GARBAGE_MAXIMUM_BYTES,
      durability: input?.durability,
    })
    if (garbage.pending > 0 || garbage.unclaimed.length > 0 || garbage.failures.length > 0) {
      throw new Error(`Corresponding-source publication has a concurrent or unclaimed cleanup generation: ${JSON.stringify(garbage)}.`)
    }
  }
  await assertOrdinaryDirectory(destinationDirectory)
  await assertOrdinaryDirectory(preparedDirectory)
  const preparedIdentity = directoryIdentity(await lstat(preparedDirectory, { bigint: true }))
  const prepared = await prepareGenerationIdentity(preparedDirectory, input.durability)
  const claimPath = join(destinationDirectory, CLAIM_NAME)
  const finalExistedBeforeClaim = await pathExists(finalDirectory)
  if (finalExistedBeforeClaim) {
    const verification = await verifyWorldFfmpegSourceGeneration(finalDirectory)
    if (verification.ok) {
      const publishedIdentityBytes = await readOrdinaryFile(
        join(finalDirectory, WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY),
        4096,
      )
      const publishedIdentity = parseCanonicalIdentity(publishedIdentityBytes)
      if (!samePublishedPayload(publishedIdentity, prepared)) {
        throw new Error('Existing corresponding-source generation belongs to different source bytes.')
      }
      return completePublishedGeneration({
        input, preparedDirectory, destinationDirectory, finalDirectory, claimPath,
        prepared, preparedIdentity, recovered: true, terminalIdentityBytes: publishedIdentityBytes,
      })
    }
  }
  const claim = await acquireClaim(claimPath, prepared.identityBytes)
  if (finalExistedBeforeClaim && claim.created) {
    await retireSourceClaim(claimPath, prepared.identityBytes, input)
    await syncWorldFfmpegDirectory(destinationDirectory, input.durability)
    throw new Error('Corresponding-source generation already exists, is invalid, and has no matching publication owner; refusing to overwrite.')
  }

  let createdDirectory = false
  if (!finalExistedBeforeClaim) {
    try {
      await mkdir(finalDirectory, { mode: 0o755 })
      createdDirectory = true
      await syncWorldFfmpegDirectory(destinationDirectory, input.durability)
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error
      if (claim.created) {
        await retireSourceClaim(claimPath, prepared.identityBytes, input)
        await syncWorldFfmpegDirectory(destinationDirectory, input.durability)
        throw new Error('Corresponding-source generation already exists; refusing to overwrite.')
      }
    }
  }
  await assertOrdinaryDirectory(finalDirectory)
  await publishExactFile(
    join(preparedDirectory, WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY),
    join(finalDirectory, WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY),
    prepared.identity,
  )
  await checkpoint(input, 'generation-claimed')
  await publishExactFile(
    join(preparedDirectory, ARCHIVE_NAME),
    join(finalDirectory, ARCHIVE_NAME),
    prepared.archive,
  )
  await checkpoint(input, 'archive-published')
  await publishExactFile(
    join(preparedDirectory, CHECKSUM_NAME),
    join(finalDirectory, CHECKSUM_NAME),
    prepared.checksum,
  )
  await checkpoint(input, 'checksum-published')

  // READY is a commit marker. The directory entry barrier for every payload
  // authority must complete before it can exist; recovery repeats this barrier
  // even when the payload files were already present from an earlier attempt.
  await syncWorldFfmpegDirectory(finalDirectory, input.durability)
  await checkpoint(input, 'payload-durable')

  const ready = {
    schema: READY_SCHEMA,
    generationIdentitySha256: prepared.identity.sha256,
    archiveSha256: prepared.archive.sha256,
  }
  const readyBytes = canonicalBytes(ready)
  await writeOrVerifyExclusive(join(finalDirectory, WORLD_FFMPEG_SOURCE_GENERATION_READY), readyBytes)
  await checkpoint(input, 'ready-published')
  await syncWorldFfmpegDirectory(finalDirectory, input.durability)
  await checkpoint(input, 'ready-durable')
  await syncWorldFfmpegDirectory(destinationDirectory, input.durability)
  const verification = await verifyWorldFfmpegSourceGeneration(finalDirectory)
  if (!verification.ok) throw new Error(`Corresponding-source generation verification failed: ${verification.code}.`)

  return completePublishedGeneration({
    input, preparedDirectory, destinationDirectory, finalDirectory, claimPath,
    prepared, preparedIdentity, recovered: !createdDirectory,
  })
}

async function completePublishedGeneration({
  input, preparedDirectory, destinationDirectory, finalDirectory, claimPath,
  prepared, preparedIdentity, recovered, terminalIdentityBytes,
}) {
  if (await pathExists(claimPath)) {
    const claimBytes = await readOrdinaryFile(claimPath, 4096)
    if (!claimBytes.equals(prepared.identityBytes)
      && !(terminalIdentityBytes && claimBytes.equals(terminalIdentityBytes))) {
      throw new Error('Corresponding-source generation has a different publication claim owner.')
    }
    await retireSourceClaim(claimPath, claimBytes, input)
  }
  await checkpoint(input, 'claim-removed')
  await quarantineAndReclaimWorldFfmpegDirectory({
    path: preparedDirectory,
    expectedIdentity: preparedIdentity,
    label: 'source-publication-prepared',
    maximumBytes: SOURCE_PUBLICATION_GARBAGE_MAXIMUM_BYTES,
    durability: input.durability,
    afterQuarantine: input.beforePreparedRetirement,
    beforeFileReclaim: input.beforePreparedFileReclaim,
  })
  await checkpoint(input, 'prepared-removed')
  await syncWorldFfmpegDirectory(destinationDirectory, input.durability).catch(() => undefined)
  await checkpoint(input, 'cleanup-durable')
  await checkpoint(input, 'return-committed')
  return Object.freeze({
    generationDirectory: finalDirectory,
    archivePath: join(finalDirectory, ARCHIVE_NAME),
    checksumPath: join(finalDirectory, CHECKSUM_NAME),
    readyPath: join(finalDirectory, WORLD_FFMPEG_SOURCE_GENERATION_READY),
    sha256: prepared.archive.sha256,
    recovered,
  })
}

async function retireSourceClaim(path, expectedBytes, input) {
  return quarantineAndReclaimWorldFfmpegFile({
    path,
    label: 'source-publication-claim',
    durability: input?.durability,
    async validate(candidatePath) {
      const bytes = await readOrdinaryFile(candidatePath, 4096)
      if (!bytes.equals(expectedBytes)) {
        throw new Error('Corresponding-source publication claim changed before retirement.')
      }
    },
    afterQuarantine: input?.beforeClaimRetirement,
  })
}

function samePublishedPayload(identity, prepared) {
  return identity.archive.name === ARCHIVE_NAME
    && identity.archive.size === prepared.archive.size
    && identity.archive.sha256 === prepared.archive.sha256
    && identity.checksum.name === CHECKSUM_NAME
    && identity.checksum.size === prepared.checksum.size
    && identity.checksum.sha256 === prepared.checksum.sha256
}

export async function verifyWorldFfmpegSourceGeneration(generationDirectory) {
  try {
    const root = requireAbsolute(generationDirectory, 'source generation')
    await assertOrdinaryDirectory(root)
    const expectedEntries = [
      ARCHIVE_NAME,
      CHECKSUM_NAME,
      WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY,
      WORLD_FFMPEG_SOURCE_GENERATION_READY,
    ].sort(codeUnitCompare)
    if (!sameArray((await readdir(root)).sort(codeUnitCompare), expectedEntries)) {
      return { ok: false, code: 'generation-tree-invalid' }
    }
    const identityBytes = await readOrdinaryFile(join(root, WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY), 4096)
    const identity = parseCanonicalIdentity(identityBytes)
    const archive = await hashOrdinaryFile(join(root, ARCHIVE_NAME), 2 * 1024 * 1024 * 1024)
    const checksum = await inspectOrdinaryFile(join(root, CHECKSUM_NAME), 1024)
    if (identity.archive.name !== ARCHIVE_NAME || identity.archive.size !== archive.size
      || identity.archive.sha256 !== archive.sha256
      || identity.checksum.name !== CHECKSUM_NAME || identity.checksum.size !== checksum.size
      || identity.checksum.sha256 !== checksum.sha256
      || !checksum.bytes.equals(Buffer.from(`${archive.sha256}  ${ARCHIVE_NAME}\n`))) {
      return { ok: false, code: 'generation-identity-invalid' }
    }
    const readyBytes = await readOrdinaryFile(join(root, WORLD_FFMPEG_SOURCE_GENERATION_READY), 4096)
    const ready = parseCanonicalReady(readyBytes)
    if (ready.generationIdentitySha256 !== sha256(identityBytes)
      || ready.archiveSha256 !== archive.sha256) {
      return { ok: false, code: 'generation-ready-invalid' }
    }
    return { ok: true }
  } catch {
    return { ok: false, code: 'generation-tree-invalid' }
  }
}

async function prepareGenerationIdentity(preparedDirectory, durability) {
  const entries = (await readdir(preparedDirectory)).sort(codeUnitCompare)
  const initial = [ARCHIVE_NAME, CHECKSUM_NAME].sort(codeUnitCompare)
  const resumable = [...initial, WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY].sort(codeUnitCompare)
  if (!sameArray(entries, initial) && !sameArray(entries, resumable)) {
    throw new Error('Prepared source generation has an invalid closure.')
  }
  const archive = await hashOrdinaryFile(join(preparedDirectory, ARCHIVE_NAME), 2 * 1024 * 1024 * 1024)
  const checksum = await inspectOrdinaryFile(join(preparedDirectory, CHECKSUM_NAME), 1024)
  if (!checksum.bytes.equals(Buffer.from(`${archive.sha256}  ${ARCHIVE_NAME}\n`))) {
    throw new Error('Prepared source generation checksum is invalid.')
  }
  const identityPath = join(preparedDirectory, WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY)
  let identityBytes
  if (entries.includes(WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY)) {
    identityBytes = await readOrdinaryFile(identityPath, 4096)
    const identity = parseCanonicalIdentity(identityBytes)
    if (identity.archive.name !== ARCHIVE_NAME || identity.archive.size !== archive.size
      || identity.archive.sha256 !== archive.sha256
      || identity.checksum.name !== CHECKSUM_NAME || identity.checksum.size !== checksum.size
      || identity.checksum.sha256 !== checksum.sha256) {
      throw new Error('Prepared source generation identity is invalid.')
    }
  } else {
    identityBytes = canonicalBytes({
      schema: GENERATION_SCHEMA,
      token: randomBytes(32).toString('hex'),
      archive: { name: ARCHIVE_NAME, size: archive.size, sha256: archive.sha256 },
      checksum: { name: CHECKSUM_NAME, size: checksum.size, sha256: checksum.sha256 },
    })
    await writeExclusive(identityPath, identityBytes)
  }
  await syncWorldFfmpegFile(join(preparedDirectory, ARCHIVE_NAME))
  await syncWorldFfmpegFile(join(preparedDirectory, CHECKSUM_NAME))
  await syncWorldFfmpegDirectory(preparedDirectory, durability)
  return {
    archive,
    checksum,
    identityBytes,
    identity: { size: identityBytes.byteLength, sha256: sha256(identityBytes) },
  }
}

async function acquireClaim(path, bytes) {
  try {
    await writeExclusive(path, bytes)
    return { created: true }
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error
    const existing = await readOrdinaryFile(path, 4096)
    if (!existing.equals(bytes)) {
      throw new Error('Corresponding-source generation already has a different publication claim.')
    }
    await syncWorldFfmpegFile(path)
    return { created: false }
  }
}

async function publishExactFile(source, destination, identity) {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    await syncWorldFfmpegFile(destination)
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error
    const existing = await hashOrdinaryFile(destination, Math.max(identity.size, 4096))
    if (existing.size !== identity.size || existing.sha256 !== identity.sha256) {
      throw new Error('Corresponding-source generation contains a conflicting published entry.')
    }
    await syncWorldFfmpegFile(destination)
  }
}

async function writeOrVerifyExclusive(path, bytes) {
  try {
    await writeExclusive(path, bytes)
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error
    if (!(await readOrdinaryFile(path, 4096)).equals(bytes)) {
      throw new Error('Corresponding-source generation has a conflicting ready marker.')
    }
    await syncWorldFfmpegFile(path)
  }
}

async function writeExclusive(path, bytes) {
  let handle
  let created = false
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644)
    created = true
    await handle.writeFile(bytes)
    if (process.platform !== 'win32') await handle.chmod(0o644)
    await handle.sync()
  } catch (error) {
    let cleanupError
    if (created && handle) {
      try {
        await quarantineAndReclaimWorldFfmpegFile({
          path,
          label: 'source-publication-partial-file',
          retainedHandle: handle,
        })
      } catch (candidate) { cleanupError = candidate }
    }
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Source publication write and partial-file retirement failed.')
    }
    throw error
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

async function hashOrdinaryFile(path, maximumBytes) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size < 1 || info.size > maximumBytes) {
    throw new Error('Source-generation entry is not an ordinary bounded file.')
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!sameFileIdentity(info, before)) throw new Error('Source-generation entry changed during validation.')
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.byteLength
      if (size > maximumBytes) throw new Error('Source-generation entry exceeded its bound.')
      hash.update(chunk)
    }
    const after = await handle.stat()
    if (size !== before.size || !sameFileIdentity(before, after)) {
      throw new Error('Source-generation entry changed during validation.')
    }
    return { sha256: hash.digest('hex'), size }
  } finally {
    await handle.close()
  }
}

async function inspectOrdinaryFile(path, maximumBytes) {
  const bytes = await readOrdinaryFile(path, maximumBytes)
  return { bytes, size: bytes.byteLength, sha256: sha256(bytes) }
}

async function readOrdinaryFile(path, maximumBytes) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size < 1 || info.size > maximumBytes) {
    throw new Error('Source-generation entry is not an ordinary bounded file.')
  }
  const bytes = await readFile(path)
  const after = await lstat(path)
  if (bytes.byteLength !== info.size || !sameFileIdentity(info, after)) {
    throw new Error('Source-generation entry changed during validation.')
  }
  return bytes
}

function parseCanonicalIdentity(bytes) {
  const value = parseCanonicalJson(bytes)
  if (!exactRecord(value, ['archive', 'checksum', 'schema', 'token'])
    || value.schema !== GENERATION_SCHEMA || !/^[a-f0-9]{64}$/.test(value.token)
    || !validFileIdentity(value.archive, ARCHIVE_NAME, 2 * 1024 * 1024 * 1024)
    || !validFileIdentity(value.checksum, CHECKSUM_NAME, 1024)) {
    throw new Error('Source-generation identity is invalid.')
  }
  return value
}

function parseCanonicalReady(bytes) {
  const value = parseCanonicalJson(bytes)
  if (!exactRecord(value, ['archiveSha256', 'generationIdentitySha256', 'schema'])
    || value.schema !== READY_SCHEMA
    || !/^[a-f0-9]{64}$/.test(value.archiveSha256)
    || !/^[a-f0-9]{64}$/.test(value.generationIdentitySha256)) {
    throw new Error('Source-generation ready marker is invalid.')
  }
  return value
}

function validFileIdentity(value, name, maximumBytes) {
  return exactRecord(value, ['name', 'sha256', 'size']) && value.name === name
    && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= maximumBytes
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
}

function parseCanonicalJson(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Source-generation metadata is invalid JSON.') }
  if (!bytes.equals(canonicalBytes(value))) throw new Error('Source-generation metadata is not canonical JSON.')
  return value
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function directoryIdentity(info) {
  return Object.freeze({ dev: String(info.dev), ino: String(info.ino) })
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

async function assertOrdinaryDirectory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Source publication path is not an ordinary directory.')
  }
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function checkpoint(input, name) {
  if (typeof input.checkpoint === 'function') await input.checkpoint(name)
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function sameArray(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  return sameArray(Object.keys(value).sort(codeUnitCompare), [...keys].sort(codeUnitCompare))
}

function nodeErrorCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : null
}

function pathsOverlap(left, right) {
  if (left === right) return true
  const leftToRight = relative(left, right)
  const rightToLeft = relative(right, left)
  return isContainedRelative(leftToRight) || isContainedRelative(rightToLeft)
}

function isContainedRelative(value) {
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function parseArguments(argv) {
  if (argv.length === 2 && argv[0] === '--verify') return { verify: argv[1] }
  if (argv.length !== 4 || argv[0] !== '--prepared' || argv[2] !== '--destination') {
    throw new Error('Usage: world-ffmpeg-source-publication.mjs --prepared <absolute-directory> --destination <absolute-directory> | --verify <absolute-generation-directory>')
  }
  return { preparedDirectory: argv[1], destinationDirectory: argv[3] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2))
  const interruptAfter = process.env.WORLD_FFMPEG_SOURCE_PUBLICATION_TEST_INTERRUPT
  if (interruptAfter && process.env.NODE_ENV !== 'test') {
    throw new Error('World FFmpeg source-publication test interruption is forbidden outside tests.')
  }
  const input = !parsed.verify && interruptAfter
    ? {
        ...parsed,
        checkpoint: async (name) => {
          if (name === interruptAfter) throw new Error(`Simulated source-publication interruption: ${name}.`)
        },
      }
    : parsed
  const operation = parsed.verify
    ? verifyWorldFfmpegSourceGeneration(parsed.verify).then((result) => {
        if (!result.ok) throw new Error(`World FFmpeg source generation is invalid: ${result.code}.`)
        return result
      })
    : publishWorldFfmpegSourceGeneration(input)
  void operation.then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg source publication failed.'}\n`)
    process.exitCode = 1
  })
}
