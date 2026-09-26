#!/usr/bin/env node

import { constants } from 'node:fs'
import { lstat, open, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { syncWorldFfmpegDirectory } from './world-ffmpeg-durability.mjs'
import { writeWorldFfmpegGithubOutputs } from './world-ffmpeg-github-release.mjs'
import {
  loadWorldFfmpegPackageResult,
  requireWorldFfmpegPackageResultReceipt,
} from './world-ffmpeg-package-tools.mjs'

export async function writeWorldFfmpegPackageArtifactList(input) {
  const manifestPath = requireAbsolute(input?.manifestPath, 'package-result manifest')
  const resultReceipt = requireWorldFfmpegPackageResultReceipt(input?.resultReceipt, manifestPath)
  const outputPath = requireAbsolute(input?.outputPath, 'package artifact-list output')
  const parent = dirname(outputPath)
  const parentInfo = await lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error('World FFmpeg package artifact-list parent is invalid.')
  }
  const manifest = await loadWorldFfmpegPackageResult(manifestPath, {
    resultReceipt,
    outputCustody: input?.outputCustody,
  })
  const outputDirectory = dirname(manifestPath)
  const paths = manifest.artifacts.map((artifact) => resolve(outputDirectory, ...artifact.path.split('/')))
  paths.push(resolve(outputDirectory, manifest.buildReport.path))
  paths.push(manifestPath)
  const bytes = Buffer.from(`${paths.join('\0')}\0`)
  let handle
  try {
    handle = await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null)
      if (bytesWritten < 1) throw new Error('World FFmpeg package artifact-list write made no progress.')
      offset += bytesWritten
    }
    await handle.sync()
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
  await syncWorldFfmpegDirectory(parent, input?.durability)
  return Object.freeze({ target: manifest.target, attemptId: manifest.attemptId, paths: Object.freeze(paths) })
}

export async function publishWorldFfmpegPackageGithubOutputs(input) {
  const bootstrapOutputPath = requireAbsolute(input?.bootstrapOutputPath, 'package bootstrap output')
  const outputBytes = await readOrdinaryBoundedFile(bootstrapOutputPath, 1024 * 1024)
  const matches = outputBytes.toString('utf8').split(/\r?\n/)
    .filter((line) => line.startsWith('WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT='))
  if (matches.length !== 1) throw new Error('World FFmpeg package bootstrap output has no unique result authority.')
  const encodedReceipt = matches[0].slice('WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT='.length)
  const resultReceipt = decodeResultReceipt(encodedReceipt)
  const manifestPath = requireAbsolute(resultReceipt.manifestPath, 'package-result manifest')
  const githubOutputPath = requireAbsolute(input?.githubOutputPath, 'GitHub output file')
  const manifest = await loadWorldFfmpegPackageResult(manifestPath, {
    resultReceipt,
    outputCustody: input?.outputCustody,
  })
  await writeWorldFfmpegGithubOutputs(githubOutputPath, [
    { key: 'WORLD_FFMPEG_PACKAGE_RESULT', value: manifestPath },
    { key: 'WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT', value: encodedReceipt },
  ], input?.githubOutputDependencies)
  return Object.freeze({
    target: manifest.target,
    attemptId: manifest.attemptId,
    verifiedCount: manifest.artifacts.length + 2,
    manifestPath,
    resultReceipt,
  })
}

function decodeResultReceipt(value) {
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

async function readOrdinaryBoundedFile(path, maximumBytes) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size < 1 || info.size > maximumBytes) {
    throw new Error('World FFmpeg workflow authority is not an ordinary bounded file.')
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) {
      throw new Error('World FFmpeg workflow authority identity changed.')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('World FFmpeg workflow authority changed while read.')
    }
    return bytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function parseArguments(argv) {
  if (argv.length === 6 && argv[0] === '--manifest' && argv[2] === '--receipt' && argv[4] === '--output') {
    return { mode: 'list', manifestPath: argv[1], resultReceipt: decodeResultReceipt(argv[3]), outputPath: argv[5] }
  }
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || typeof argv[index + 1] !== 'string') {
      throw new Error('World FFmpeg package-result workflow arguments are invalid.')
    }
    if (values.has(argv[index])) throw new Error('World FFmpeg package-result workflow argument is duplicated.')
    values.set(argv[index], argv[index + 1])
  }
  const expected = ['--bootstrap-output', '--github-output']
  if (values.size !== expected.length || expected.some((name) => !values.has(name))) {
    throw new Error('Usage: world-ffmpeg-package-result.mjs --bootstrap-output <absolute-log> --github-output <absolute-github-output>')
  }
  return {
    mode: 'github',
    bootstrapOutputPath: values.get('--bootstrap-output'),
    githubOutputPath: values.get('--github-output'),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = parseArguments(process.argv.slice(2))
  const operation = input.mode === 'github'
    ? publishWorldFfmpegPackageGithubOutputs(input)
    : writeWorldFfmpegPackageArtifactList(input)
  void operation.then((result) => {
    process.stdout.write(`Verified ${result.paths?.length ?? result.verifiedCount} exact ${result.target} package file(s).\n`)
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg package-result verification failed.'}\n`)
    process.exitCode = 1
  })
}
