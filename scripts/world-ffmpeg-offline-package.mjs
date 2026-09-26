#!/usr/bin/env node

import { isAbsolute, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  runWorldFfmpegOfflinePackage,
  worldFfmpegPackageArguments,
} from './world-ffmpeg-package-tools.mjs'

const require = createRequire(import.meta.url)
const {
  WORLD_FFMPEG_CLEAN_BOOTSTRAP_STAGE,
  requireClosedWorldFfmpegCleanEnvironment,
  worldFfmpegPackageTargetFor,
} = require('./world-ffmpeg-package-environment.cjs')

function absoluteEnvironment(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${name} must name an absolute audited package input.`)
  }
  return resolve(value)
}

async function main() {
  const target = assertWorldFfmpegCleanPackageAuthority()
  const attemptToken = requireAttemptTokenArgument(process.argv)
  const cacheDirectory = absoluteEnvironment('ELECTRON_BUILDER_CACHE')
  const buildTrustFile = absoluteEnvironment('WORLD_FFMPEG_BUILD_TRUST_FILE')
  const result = await runWorldFfmpegOfflinePackage({
    target,
    cacheDirectory,
    buildTrustFile,
    argv: worldFfmpegPackageArguments(target),
    attemptToken,
    processLifecycle: worldFfmpegNestedPackageProcessLifecycle(
      process.platform,
      process.pid,
      process.env.WORLD_FFMPEG_CLEAN_BOOTSTRAP,
    ),
  })
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`Offline electron-builder failed: ${result.signal ?? result.code ?? 'unknown'}.`)
  }
  if (typeof result.resultManifestPath !== 'string' || !isAbsolute(result.resultManifestPath)
    || typeof result.attemptId !== 'string' || !/^[a-f0-9]{32}$/.test(result.attemptId)
    || !result.resultReceipt || typeof result.resultReceipt !== 'object') {
    throw new Error('Offline electron-builder returned no exact package-result manifest.')
  }
  process.stdout.write(`${JSON.stringify(result.resultReceipt)}\n`)
}

function requireAttemptTokenArgument(argv) {
  if (!Array.isArray(argv) || argv.length !== 3) {
    throw new Error('World FFmpeg clean package requires one exact attempt authority argument.')
  }
  const match = /^--world-ffmpeg-attempt=([a-f0-9]{32})$/.exec(argv[2] ?? '')
  if (!match) throw new Error('World FFmpeg clean package attempt authority is invalid.')
  return match[1]
}

export function worldFfmpegNestedPackageProcessLifecycle(platform, pid, bootstrapAuthority) {
  if (bootstrapAuthority !== WORLD_FFMPEG_CLEAN_BOOTSTRAP_STAGE) {
    throw new Error('World FFmpeg nested package bootstrap authority is invalid.')
  }
  if ((platform !== 'linux' && platform !== 'darwin' && platform !== 'win32')
    || !Number.isSafeInteger(pid) || pid < 1 || pid > 0xffff_ffff) {
    throw new Error('World FFmpeg nested package process-group authority is invalid.')
  }
  if (platform === 'win32') return Object.freeze({})
  return Object.freeze({ processGroupId: pid })
}

export function assertWorldFfmpegCleanPackageAuthority(
  execArgv = process.execArgv,
  environment = process.env,
  runtime = {
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    electronVersion: process.versions.electron,
  },
) {
  if (!Array.isArray(execArgv) || execArgv.length !== 0) {
    throw new Error('World FFmpeg clean package Node authority has invalid execArgv.')
  }
  return requireClosedWorldFfmpegCleanEnvironment(environment, runtime)
}

export { worldFfmpegPackageTargetFor }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Offline package failed.'}\n`)
    process.exitCode = 1
  })
}
