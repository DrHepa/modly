#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadWorldFfmpegSupplyChain,
  verifyWorldFfmpegSourceCache,
} from './world-ffmpeg-supply-chain.mjs'
import {
  worldFfmpegReleaseVerificationReceiptBytes,
} from './world-ffmpeg-release-material.mjs'

const MAX_TOOL_OUTPUT_BYTES = 256 * 1024
const TOOL_TIMEOUT_MS = 30_000

export async function verifyWorldFfmpegSources(input) {
  const cache = requireAbsolute(input.cache, 'source cache')
  const mode = input.mode ?? 'acquisition'
  if (mode !== 'acquisition' && mode !== 'canonical') {
    throw new Error('World FFmpeg source verification mode is invalid.')
  }
  const contract = input.contract ?? await loadWorldFfmpegSupplyChain()
  const cacheResult = await verifyWorldFfmpegSourceCache(cache, contract, { mode })
  if (!cacheResult.ok) throw new Error(`${cacheResult.code}:${cacheResult.source ?? 'tree'}`)
  if (mode === 'canonical') {
    return { ok: true, fingerprint: contract.ffmpegReleaseSignature.fingerprint }
  }
  const gpg = requireAbsolute(input.gpg, 'gpg executable')
  const gpgv = requireAbsolute(input.gpgv, 'gpgv executable')
  const run = input.runTool ?? runBoundedTool
  const home = await mkdtemp(join(tmpdir(), 'modly-world-ffmpeg-gpg-'))
  await chmod(home, 0o700)
  const keyring = join(home, 'release-keys.gpg')
  try {
    await run(gpg, [
      '--batch', '--no-options', '--no-auto-key-retrieve', '--no-default-keyring',
      '--homedir', home, '--keyring', keyring, '--import',
      join(cache, contract.ffmpegReleaseSignature.keyArchive),
    ])
    const fingerprintResult = await run(gpg, [
      '--batch', '--no-options', '--no-auto-key-retrieve', '--no-default-keyring',
      '--homedir', home, '--keyring', keyring, '--with-colons', '--fingerprint',
    ])
    const fingerprints = new Set(
      fingerprintResult.stdout.split('\n')
        .filter((line) => line.startsWith('fpr:'))
        .map((line) => line.split(':')[9])
        .filter((value) => /^[A-F0-9]{40}$/.test(value)),
    )
    if (!fingerprints.has(contract.ffmpegReleaseSignature.fingerprint)) {
      throw new Error('FFmpeg release key fingerprint is absent from the pinned key material.')
    }
    const signatureResult = await run(gpgv, [
      '--homedir', home, '--status-fd', '1', '--keyring', keyring,
      join(cache, contract.ffmpegReleaseSignature.archive),
      join(cache, contract.sources[0].archive),
    ])
    const validSignatures = signatureResult.stdout.split('\n').flatMap((line) => {
      const match = line.match(/^\[GNUPG:\] VALIDSIG (.+)$/)
      if (!match) return []
      const fields = match[1].trim().split(/\s+/)
      const primary = fields.at(-1)
      const signing = fields[0]
      return [/^[A-F0-9]{40}$/.test(primary) ? primary : signing]
    })
    if (validSignatures.length !== 1 || validSignatures[0] !== contract.ffmpegReleaseSignature.fingerprint) {
      throw new Error('FFmpeg detached signature was not made by the exact pinned release key.')
    }
    if (input.receiptOutput !== undefined) {
      await writeReceipt(
        requireAbsolute(input.receiptOutput, 'release-verification receipt output'),
        worldFfmpegReleaseVerificationReceiptBytes(contract),
      )
    }
    return { ok: true, fingerprint: contract.ffmpegReleaseSignature.fingerprint }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

async function writeReceipt(path, bytes) {
  let handle
  let created = false
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644)
    created = true
    await handle.writeFile(bytes)
    if (process.platform !== 'win32') await handle.chmod(0o644)
    await handle.sync()
  } catch (error) {
    if (created) await rm(path, { force: true }).catch(() => undefined)
    throw error
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function runBoundedTool(executable, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(executable, args, {
      cwd: '/',
      env: Object.freeze({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }),
      shell: false,
      windowsHide: true,
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`World FFmpeg source verification tool failed: ${String(stderr).slice(0, 4096)}`))
        return
      }
      resolvePromise({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || index + 1 >= argv.length || values.has(argv[index])) return null
    values.set(argv[index], argv[index + 1])
  }
  const allowed = new Set(['--cache', '--mode', '--gpg', '--gpgv', '--receipt-output'])
  if ([...values.keys()].some((key) => !allowed.has(key)) || !values.has('--cache')) return null
  const mode = values.get('--mode') ?? 'acquisition'
  if ((mode !== 'acquisition' && mode !== 'canonical')
    || (mode === 'acquisition' && (!values.has('--gpg') || !values.has('--gpgv')))
    || (mode === 'canonical' && (values.has('--gpg') || values.has('--gpgv') || values.has('--receipt-output')))) return null
  return {
    cache: values.get('--cache'), mode,
    ...(values.has('--gpg') ? { gpg: values.get('--gpg') } : {}),
    ...(values.has('--gpgv') ? { gpgv: values.get('--gpgv') } : {}),
    ...(values.has('--receipt-output') ? { receiptOutput: values.get('--receipt-output') } : {}),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = parseArguments(process.argv.slice(2))
  if (!input) {
    process.stderr.write('Usage: verify-world-ffmpeg-sources.mjs --cache <absolute-dir> [--mode acquisition --gpg <absolute-path> --gpgv <absolute-path> [--receipt-output <absolute-path>] | --mode canonical]\n')
    process.exitCode = 1
  } else {
    void verifyWorldFfmpegSources(input).then(() => {
      process.stdout.write('Verified FFmpeg 7.1.1 source hashes and upstream release signature.\n')
    }, (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg source verification failed.'}\n`)
      process.exitCode = 1
    })
  }
}
