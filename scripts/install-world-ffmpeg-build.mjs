#!/usr/bin/env node

import { cp, lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolvePackagedWorldFfmpegRuntime } from '../electron/main/world-render-ffmpeg-runtime.ts'
import { loadWorldFfmpegBuildTrust } from './world-ffmpeg-build-trust.mjs'
import { validateWorldFfmpegBuildReport } from './world-ffmpeg-build-report.mjs'
import { syncWorldFfmpegDirectory, syncWorldFfmpegFile } from './world-ffmpeg-durability.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))

export async function installWorldFfmpegBuild(input) {
  const target = requireTarget(input?.target)
  const sourceResources = requireAbsolute(input?.sourceResources, 'built runtime resources')
  const repositoryResources = requireAbsolute(input?.repositoryResources, 'repository resources')
  const trust = await loadWorldFfmpegBuildTrust(requireAbsolute(input?.trustFile, 'build trust'))
  const platformArch = platformArchFor(target)
  const resolved = await resolvePackagedWorldFfmpegRuntime({
    resourcesPath: sourceResources,
    ...platformArch,
    trustedManifestKeys: trust.keys,
  })
  if (!resolved.ok || resolved.runtime.target !== target) {
    throw new Error(`World FFmpeg built runtime is invalid: ${resolved.ok ? 'target-mismatch' : resolved.code}.`)
  }
  await verifyBuildReport({
    reportPath: join(sourceResources, `world-ffmpeg-build-report-${target}.json`),
    resourcesPath: sourceResources,
    target,
    trust,
    signingKeyId: resolved.runtime.signingKeyId,
  })

  const ffmpegRoot = join(repositoryResources, 'ffmpeg')
  const reportRoot = join(repositoryResources, 'world-ffmpeg-build-reports')
  const destinationBundle = join(ffmpegRoot, target)
  const destinationReport = join(reportRoot, `${target}.json`)
  await assertOrdinaryDirectory(repositoryResources)
  await assertOrdinaryDirectory(ffmpegRoot)
  await rejectExisting(destinationBundle)
  await rejectExisting(destinationReport)
  let madeReportRoot = false
  let copiedBundle = false
  let copiedReport = false
  try {
    try {
      await mkdir(reportRoot, { mode: 0o755 })
      madeReportRoot = true
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error
      await assertOrdinaryDirectory(reportRoot)
      if ((await readdir(reportRoot)).length !== 0) throw new Error('World FFmpeg build-report destination is not empty.')
    }
    await cp(join(sourceResources, 'ffmpeg', target), destinationBundle, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      mode: constants.COPYFILE_EXCL,
    })
    copiedBundle = true
    await cp(
      join(sourceResources, `world-ffmpeg-build-report-${target}.json`),
      destinationReport,
      { errorOnExist: true, force: false, mode: constants.COPYFILE_EXCL },
    )
    copiedReport = true
    await syncInstalledTree(destinationBundle, input.durability)
    await syncWorldFfmpegFile(destinationReport)
    await syncWorldFfmpegDirectory(ffmpegRoot, input.durability)
    await syncWorldFfmpegDirectory(reportRoot, input.durability)
    await syncWorldFfmpegDirectory(repositoryResources, input.durability)
    const installed = await resolvePackagedWorldFfmpegRuntime({
      resourcesPath: repositoryResources,
      ...platformArch,
      trustedManifestKeys: trust.keys,
    })
    if (!installed.ok || installed.runtime.manifestSha256 !== resolved.runtime.manifestSha256) {
      throw new Error('Installed World FFmpeg runtime changed during publication.')
    }
    await verifyBuildReport({
      reportPath: destinationReport,
      resourcesPath: repositoryResources,
      target,
      trust,
      signingKeyId: installed.runtime.signingKeyId,
    })
    return Object.freeze({ target, bundlePath: destinationBundle, reportPath: destinationReport })
  } catch (error) {
    if (copiedReport) await rm(destinationReport, { force: true }).catch(() => undefined)
    if (copiedBundle) await rm(destinationBundle, { recursive: true, force: true }).catch(() => undefined)
    if (madeReportRoot) await rm(reportRoot, { recursive: true, force: true }).catch(() => undefined)
    await syncWorldFfmpegDirectory(repositoryResources, input.durability).catch(() => undefined)
    throw error
  }
}

async function verifyBuildReport(input) {
  const info = await lstat(input.reportPath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size < 2 || info.size > 1024 * 1024) throw new Error('World FFmpeg build report is invalid.')
  const reportBytes = await readFile(input.reportPath)
  let report
  try { report = JSON.parse(reportBytes.toString('utf8')) } catch { throw new Error('World FFmpeg build report is invalid.') }
  if (!reportBytes.equals(Buffer.from(`${JSON.stringify(report)}\n`))) throw new Error('World FFmpeg build report is noncanonical.')
  const [supplyChainBytes, manifestBytes, signatureBytes] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, 'resources', 'ffmpeg', 'supply-chain.v1.json')),
    readFile(join(input.resourcesPath, 'ffmpeg', input.target, 'manifest.json')),
    readFile(join(input.resourcesPath, 'ffmpeg', input.target, 'manifest.sig')),
  ])
  if (!validateWorldFfmpegBuildReport(report, {
    target: input.target,
    supplyChainBytes,
    manifestBytes,
    signatureBytes,
    trustBytes: input.trust.bytes,
    signingKeyId: input.signingKeyId,
  })) throw new Error('World FFmpeg build report identity is invalid.')
}

async function rejectExisting(path) {
  try { await lstat(path) } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return
    throw error
  }
  throw new Error('World FFmpeg install destination already exists.')
}

async function assertOrdinaryDirectory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('World FFmpeg install root is not an ordinary directory.')
}

async function syncInstalledTree(path, durability) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await syncInstalledTree(child, durability)
    else if (entry.isFile()) await syncWorldFfmpegFile(child)
    else throw new Error('World FFmpeg installed runtime contains a non-file entry.')
  }
  await syncWorldFfmpegDirectory(path, durability)
}

function platformArchFor(target) {
  if (target === 'linux-arm64') return { platform: 'linux', arch: 'arm64' }
  if (target === 'linux-x64') return { platform: 'linux', arch: 'x64' }
  if (target === 'darwin-arm64') return { platform: 'darwin', arch: 'arm64' }
  return { platform: 'win32', arch: 'x64' }
}

function requireTarget(value) {
  if (!['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'].includes(value)) {
    throw new Error('World FFmpeg install target is unsupported.')
  }
  return value
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function nodeErrorCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : null
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined || values.has(argv[index])) throw usage()
    values.set(argv[index], argv[index + 1])
  }
  const expected = ['--target', '--source-resources', '--repository-resources', '--trust-file']
  if (values.size !== expected.length || expected.some((key) => !values.has(key))) throw usage()
  return {
    target: values.get('--target'), sourceResources: values.get('--source-resources'),
    repositoryResources: values.get('--repository-resources'), trustFile: values.get('--trust-file'),
  }
}

function usage() {
  return new Error('Usage: install-world-ffmpeg-build.mjs --target <tuple> --source-resources <absolute-directory> --repository-resources <absolute-directory> --trust-file <absolute-json>')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void installWorldFfmpegBuild(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg install failed.'}\n`)
    process.exitCode = 1
  })
}
