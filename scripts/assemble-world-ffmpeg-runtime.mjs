#!/usr/bin/env node

import { createPrivateKey } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  inspectWorldFfmpegBinary,
  probeWorldFfmpegBinary,
} from './world-ffmpeg-binary-audit.mjs'
import { loadWorldFfmpegBuildTrust } from './world-ffmpeg-build-trust.mjs'
import { assembleWorldFfmpegRuntime } from './world-ffmpeg-runtime-assembler.mjs'
import {
  loadWorldFfmpegSupplyChain,
  verifyWorldFfmpegDistributionFiles,
} from './world-ffmpeg-supply-chain.mjs'

async function main(argv) {
  const input = parseArguments(argv)
  const contract = await loadWorldFfmpegSupplyChain()
  const distribution = await verifyWorldFfmpegDistributionFiles(contract)
  if (!distribution.ok) throw new Error(`${distribution.code}:${distribution.path}`)
  const trustedManifestKeys = (await loadWorldFfmpegBuildTrust(input.trustedKeys)).keys
  const privateKeyBytes = await readPrivateKey(input.privateKey)
  const privateKey = createPrivateKey(privateKeyBytes)
  const manifest = await assembleWorldFfmpegRuntime({
    bundleRoot: input.bundleRoot,
    target: input.target,
    supplyChain: contract,
    signingKeyId: input.signingKeyId,
    privateKey,
    trustedManifestKeys,
    probe: (path, context) => probeWorldFfmpegBinary(path, {
      ...context,
      parserInspectorPath: input.parserInspector,
      parserListPath: input.parserList,
    }),
    inspectBinary: (path, context) => inspectWorldFfmpegBinary(path, {
      ...context,
      inspectorPath: input.inspector,
    }),
  })
  process.stdout.write(`${JSON.stringify({
    target: manifest.target,
    ffmpegVersion: manifest.ffmpegVersion,
    signingKeyId: manifest.signingKeyId,
  })}\n`)
}

async function readPrivateKey(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 32 || info.size > 16 * 1024) {
    throw new Error('World FFmpeg signing key is not an ordinary bounded file.')
  }
  if (process.platform !== 'win32' && ![0o400, 0o600].includes(info.mode & 0o7777)) {
    throw new Error('World FFmpeg signing key permissions must be 0400 or 0600.')
  }
  return readFile(path)
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || values.has(key)) throw usage()
    values.set(key, value)
  }
  const allowed = ['--bundle-root', '--target', '--signing-key-id', '--private-key', '--trusted-keys', '--inspector', '--parser-inspector', '--parser-list']
  if (values.size !== allowed.length || [...values.keys()].some((key) => !allowed.includes(key))) throw usage()
  const bundleRoot = absolute(values.get('--bundle-root'), 'bundle root')
  const privateKey = absolute(values.get('--private-key'), 'private key')
  const trustedKeys = absolute(values.get('--trusted-keys'), 'trusted keys')
  const inspector = absolute(values.get('--inspector'), 'inspector')
  const parserInspector = absolute(values.get('--parser-inspector'), 'parser inspector')
  const parserList = absolute(values.get('--parser-list'), 'generated parser list')
  const target = values.get('--target')
  const signingKeyId = values.get('--signing-key-id')
  if (!['linux-arm64', 'linux-x64', 'darwin-arm64', 'win32-x64'].includes(target)
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(signingKeyId ?? '')) throw usage()
  return { bundleRoot, privateKey, trustedKeys, inspector, parserInspector, parserList, target, signingKeyId }
}

function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function usage() {
  return new Error('Usage: assemble-world-ffmpeg-runtime.mjs --bundle-root <absolute-dir> --target <tuple> --signing-key-id <id> --private-key <absolute-path> --trusted-keys <absolute-json> --inspector <absolute-path> --parser-inspector <absolute-path> --parser-list <absolute-path>')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg assembly failed.'}\n`)
    process.exitCode = 1
  })
}
