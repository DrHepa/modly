#!/usr/bin/env node

import { createHash, createPrivateKey } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function materializeWorldFfmpegReleasePrivateKey(input) {
  const output = requireAbsolute(input?.output, 'release private-key output')
  const encoded = input?.base64
  if (typeof encoded !== 'string' || encoded.length < 40 || encoded.length > 32 * 1024
    || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('World FFmpeg release private-key secret is absent or invalid.')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded || bytes.byteLength < 32 || bytes.byteLength > 16 * 1024) {
    throw new Error('World FFmpeg release private-key secret is not canonical base64.')
  }
  let key
  try { key = createPrivateKey(bytes) } catch { throw new Error('World FFmpeg release private-key secret is invalid.') }
  if (key.asymmetricKeyType !== 'ed25519'
    || !Buffer.from(key.export({ type: 'pkcs8', format: 'pem' })).equals(bytes)) {
    throw new Error('World FFmpeg release private-key secret is not canonical Ed25519 PEM.')
  }
  let handle
  let created = false
  try {
    handle = await open(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    created = true
    await handle.writeFile(bytes)
    if (process.platform !== 'win32') await handle.chmod(0o600)
    await handle.sync()
  } catch (error) {
    if (created) await rm(output, { force: true }).catch(() => undefined)
    throw error
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
  return Object.freeze({
    path: output,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--output') {
    throw new Error('Usage: world-ffmpeg-release-key.mjs --output <absolute-new-pem>')
  }
  return { output: argv[1], base64: process.env.WORLD_FFMPEG_RELEASE_PRIVATE_KEY_B64 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void materializeWorldFfmpegReleasePrivateKey(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg release private-key setup failed.'}\n`)
    process.exitCode = 1
  })
}
