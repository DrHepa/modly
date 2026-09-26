import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto'
import { constants, lstatSync, readFileSync } from 'node:fs'
import { chmod, lstat, open, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { syncWorldFfmpegDirectory } from './world-ffmpeg-durability.mjs'

const TRUST_FILE_NAME = 'trusted-keys.v1.json'
const PRIVATE_KEY_FILE_NAME = 'private-key.pem'
const MAX_TRUST_BYTES = 64 * 1024
const MAX_PRIVATE_KEY_BYTES = 16 * 1024
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export async function createWorldFfmpegBuildTrust(input) {
  const outputDirectory = requireAbsolute(input?.outputDirectory, 'trust output directory')
  const keyId = requireKeyId(input?.keyId)
  await assertEmptyOrdinaryDirectory(outputDirectory)

  let privateKey
  let privateKeyFile
  let generatedPrivateKeyBytes = null
  if (input?.privateKeyFile !== undefined) {
    privateKeyFile = requireAbsolute(input.privateKeyFile, 'private key')
    privateKey = createPrivateKey(await readPrivateKey(privateKeyFile))
  } else {
    const pair = generateKeyPairSync('ed25519')
    privateKey = pair.privateKey
    generatedPrivateKeyBytes = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }))
    privateKeyFile = join(outputDirectory, PRIVATE_KEY_FILE_NAME)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('World FFmpeg build trust requires an Ed25519 private key.')
  }
  const publicKey = createPublicKey(privateKey)
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('World FFmpeg build trust requires an Ed25519 public key.')
  }
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const trustFile = join(outputDirectory, TRUST_FILE_NAME)
  const trustBytes = Buffer.from(`${JSON.stringify({ [keyId]: publicKeyPem })}\n`)
  let wrotePrivateKey = false
  let wroteTrust = false
  try {
    if (generatedPrivateKeyBytes) {
      await writeExclusive(privateKeyFile, generatedPrivateKeyBytes, 0o600)
      wrotePrivateKey = true
    }
    await writeExclusive(trustFile, trustBytes, 0o644)
    wroteTrust = true
    await syncWorldFfmpegDirectory(outputDirectory, input.durability)
    const loaded = await loadWorldFfmpegBuildTrust(trustFile)
    if (loaded.keys[keyId] !== publicKeyPem) throw new Error('World FFmpeg build trust publication changed.')
  } catch (error) {
    if (wroteTrust) await removeOwnedFile(trustFile)
    if (wrotePrivateKey) await removeOwnedFile(privateKeyFile)
    await syncWorldFfmpegDirectory(outputDirectory, input.durability).catch(() => undefined)
    throw error
  }
  return Object.freeze({
    keyId,
    privateKeyFile,
    trustFile,
    trustSha256: createHash('sha256').update(trustBytes).digest('hex'),
    publicKeySha256: createHash('sha256').update(publicKeyPem).digest('hex'),
  })
}

export async function loadWorldFfmpegBuildTrust(path) {
  const absolutePath = requireAbsolute(path, 'trust file')
  const info = await lstat(absolutePath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size < 2 || info.size > MAX_TRUST_BYTES) {
    throw new Error('World FFmpeg build trust is not an ordinary bounded file.')
  }
  const bytes = await readFile(absolutePath)
  return parseWorldFfmpegBuildTrust(bytes)
}

export function loadWorldFfmpegBuildTrustSync(path) {
  const absolutePath = requireAbsolute(path, 'trust file')
  const info = lstatSync(absolutePath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size < 2 || info.size > MAX_TRUST_BYTES) {
    throw new Error('World FFmpeg build trust is not an ordinary bounded file.')
  }
  return parseWorldFfmpegBuildTrust(readFileSync(absolutePath))
}

function parseWorldFfmpegBuildTrust(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('World FFmpeg build trust is not valid JSON.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || !bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) {
    throw new Error('World FFmpeg build trust is not exact canonical JSON.')
  }
  const keys = Object.keys(value)
  if (keys.length !== 1 || !KEY_ID_PATTERN.test(keys[0])) {
    throw new Error('World FFmpeg build trust must contain exactly one named key.')
  }
  const keyId = keys[0]
  const pem = value[keyId]
  if (typeof pem !== 'string' || pem.length < 32 || pem.length > 16 * 1024) {
    throw new Error('World FFmpeg build trust public key is invalid.')
  }
  let publicKey
  try { publicKey = createPublicKey(pem) } catch { throw new Error('World FFmpeg build trust public key is invalid.') }
  const canonicalPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  if (publicKey.asymmetricKeyType !== 'ed25519' || pem !== canonicalPem) {
    throw new Error('World FFmpeg build trust public key is not canonical Ed25519 material.')
  }
  return Object.freeze({
    keys: Object.freeze({ [keyId]: pem }),
    keyId,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}

async function readPrivateKey(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size < 32 || info.size > MAX_PRIVATE_KEY_BYTES) {
    throw new Error('World FFmpeg build private key is not an ordinary bounded file.')
  }
  if (process.platform !== 'win32' && ![0o400, 0o600].includes(info.mode & 0o7777)) {
    throw new Error('World FFmpeg build private key permissions must be 0400 or 0600.')
  }
  return readFile(path)
}

async function assertEmptyOrdinaryDirectory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('World FFmpeg trust output is not an ordinary directory.')
  }
  if ((await readdir(path)).length !== 0) {
    throw new Error('World FFmpeg trust output must be empty.')
  }
}

async function writeExclusive(path, bytes, mode) {
  let handle
  let created = false
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
    created = true
    await handle.writeFile(bytes)
    if (process.platform !== 'win32') await handle.chmod(mode)
    await handle.sync()
  } catch (error) {
    if (created) await rm(path, { force: true }).catch(() => undefined)
    throw error
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

async function removeOwnedFile(path) {
  const handle = await open(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
  try { await handle.truncate(0) } finally { await handle.close() }
  await rm(path, { force: true })
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function requireKeyId(value) {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    throw new Error('World FFmpeg build trust key id is invalid.')
  }
  return value
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined || values.has(argv[index])) throw usage()
    values.set(argv[index], argv[index + 1])
  }
  const allowed = new Set(['--output', '--key-id', '--private-key'])
  if ([...values.keys()].some((key) => !allowed.has(key))
    || !values.has('--output') || !values.has('--key-id')) throw usage()
  return {
    outputDirectory: requireAbsolute(values.get('--output'), 'trust output directory'),
    keyId: requireKeyId(values.get('--key-id')),
    ...(values.has('--private-key')
      ? { privateKeyFile: requireAbsolute(values.get('--private-key'), 'private key') }
      : {}),
  }
}

function usage() {
  return new Error('Usage: world-ffmpeg-build-trust.mjs --output <absolute-empty-dir> --key-id <id> [--private-key <absolute-pem>]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void createWorldFfmpegBuildTrust(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg build trust failed.'}\n`)
    process.exitCode = 1
  })
}
