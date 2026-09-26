#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createWorldFfmpegBuildReport,
  worldFfmpegBuildReportLinkAuthority,
  worldFfmpegBuildReportBytes,
} from './world-ffmpeg-build-report.mjs'
import { syncWorldFfmpegDirectory } from './world-ffmpeg-durability.mjs'

export async function writeWorldFfmpegBuildReport(input) {
  const target = requireTarget(input?.target)
  const outputDirectory = requireAbsolute(input?.outputDirectory, 'build-report output')
  const bundleRoot = requireAbsolute(input?.bundleRoot, 'runtime bundle')
  const supplyChainPath = requireAbsolute(input?.supplyChainPath, 'supply-chain contract')
  const trustFile = requireAbsolute(input?.trustFile, 'build trust')
  const signingKeyId = requireKeyId(input?.signingKeyId)
  const linkAuthority = worldFfmpegBuildReportLinkAuthority(target, input?.runtimeRpath)
  const inspectTool = input?.inspectTool ?? inspectWorldFfmpegBuildTool
  const tools = {}
  for (const name of ['ar', 'cc', 'inspector']) {
    const path = requireAbsolute(input?.tools?.[name], `${name} tool`)
    tools[name] = await inspectTool(path, { name, target })
  }
  tools.node = await inspectTool(process.execPath, { name: 'node', target, knownVersion: process.version })
  const supplyChainBytes = await readFile(supplyChainPath)
  const supplyChain = JSON.parse(supplyChainBytes.toString('utf8'))
  const manifestBytes = await readFile(join(bundleRoot, 'manifest.json'))
  const signatureBytes = await readFile(join(bundleRoot, 'manifest.sig'))
  const trustBytes = await readFile(trustFile)
  const report = createWorldFfmpegBuildReport({
    target,
    supplyChainBytes,
    manifestBytes,
    signatureBytes,
    trustBytes,
    signingKeyId,
    runtimeRpath: linkAuthority.runtimeRpath,
    configure: input.configure ?? configureAuthority(supplyChain, linkAuthority),
    linkerEnvironment: linkAuthority.linkerEnvironment,
    tools,
  })
  const destination = join(outputDirectory, `world-ffmpeg-build-report-${target}.json`)
  await writeExclusive(destination, worldFfmpegBuildReportBytes(report), process.platform === 'win32' ? undefined : 0o644)
  await syncWorldFfmpegDirectory(outputDirectory, input.durability)
  return Object.freeze({ path: destination, report })
}

function configureAuthority(contract, linkAuthority) {
  return {
    zlib: ['./configure', '--prefix=<BUILD_PREFIX>', '--shared'],
    opus: ['./configure', '--prefix=<BUILD_PREFIX>', '--disable-static', '--enable-shared', '--disable-doc', '--disable-extra-programs'],
    libvpx: ['./configure', '--prefix=<BUILD_PREFIX>', '--target=<TARGET_FROM_SCRIPT>', '--disable-static', '--enable-shared', '--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests', '--disable-vp8', '--enable-vp9', '--disable-webm-io', '--disable-libyuv'],
    ffmpeg: [
      './configure', '--prefix=<BUILD_PREFIX>', '--bindir=<BUILD_PREFIX>/bin',
      '--libdir=<BUILD_PREFIX>/lib', '--shlibdir=<BUILD_PREFIX>/lib',
      '--extra-cflags=<REPRODUCIBLE_CFLAGS>',
      `--extra-ldflags=${linkAuthority.normalizedExtraLdflags}`,
      ...contract.ffmpegConfigure,
    ],
  }
}

export async function inspectWorldFfmpegBuildTool(path, options = {}) {
  const target = requireTarget(options.target)
  const name = requireToolName(options.name)
  const canonicalPath = await realpath(requireAbsolute(path, `${name} tool`))
  const info = await lstat(canonicalPath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 512 * 1024 * 1024) {
    throw new Error('World FFmpeg build-report tool is not an ordinary bounded file.')
  }
  const bytes = await readFile(canonicalPath)
  if (bytes.byteLength !== info.size) throw new Error('World FFmpeg build-report tool changed while hashing.')
  let version = options.knownVersion
  if (!version) {
    if (name === 'ar' && target === 'darwin-arm64') {
      await assertAppleArAuthority(canonicalPath, options.xcrunPath)
      version = 'Apple BSD ar (xcrun-selected usage contract)'
    } else {
      const result = runTool(canonicalPath, ['--version'])
      if (!toolSucceeded(result)) throw new Error('World FFmpeg build-report tool version is unavailable.')
      const lines = toolOutputLines(result)
      version = lines[0]
      if (!version) throw new Error('World FFmpeg build-report tool version is unavailable.')
    }
  } else if (typeof version !== 'string' || version.length < 1 || version.length > 1024 || version.includes('\0')) {
    throw new Error('World FFmpeg build-report known tool version is invalid.')
  }
  return {
    path: canonicalPath,
    version,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function assertAppleArAuthority(canonicalPath, injectedXcrunPath) {
  const requestedXcrun = injectedXcrunPath ?? '/usr/bin/xcrun'
  const xcrunPath = await realpath(requireAbsolute(requestedXcrun, 'xcrun tool'))
  if (injectedXcrunPath === undefined && xcrunPath !== '/usr/bin/xcrun') {
    throw new Error('World FFmpeg build-report Apple xcrun identity is invalid or foreign.')
  }
  const xcrunInfo = await lstat(xcrunPath)
  if (!xcrunInfo.isFile() || xcrunInfo.isSymbolicLink() || xcrunInfo.nlink !== 1
    || xcrunInfo.size < 1 || xcrunInfo.size > 512 * 1024 * 1024) {
    throw new Error('World FFmpeg build-report Apple xcrun identity is invalid or foreign.')
  }
  const selected = runTool(xcrunPath, ['--find', 'ar'])
  if (!toolSucceeded(selected)) throw new Error('World FFmpeg build-report Apple ar selection is unavailable.')
  const selectedLines = toolOutputLines(selected)
  if (selectedLines.length !== 1 || !isAbsolute(selectedLines[0])
    || await realpath(selectedLines[0]) !== canonicalPath) {
    throw new Error('World FFmpeg build-report Apple ar identity is invalid or foreign.')
  }

  // Apple's BSD-derived ar has no version operation. Its documented/current
  // usage contract exits 1 for -h; treat that exact behavior plus xcrun path
  // selection and the report's SHA-256 as the auditable identity.
  const usage = runTool(canonicalPath, ['-h'])
  if (usage.error || usage.signal !== null || usage.status !== 1
    || !isAppleArUsage(toolOutputLines(usage))) {
    if (usage.status !== 1) throw new Error('World FFmpeg build-report tool version is unavailable.')
    throw new Error('World FFmpeg build-report Apple ar identity is invalid or foreign.')
  }
}

function runTool(path, args) {
  return spawnSync(path, args, {
    cwd: '/', env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' },
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function toolSucceeded(result) {
  return !result.error && result.signal === null && result.status === 0
}

function toolOutputLines(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function isAppleArUsage(lines) {
  const patterns = [
    /^usage:\s+ar -d \[-TLsv\] archive file \.\.\.$/,
    /^ar -m \[-TLsv\] archive file \.\.\.$/,
    /^ar -m \[-abiTLsv\] position archive file \.\.\.$/,
    /^ar -p \[-TLsv\] archive \[file \.\.\.\]$/,
    /^ar -q \[-cTLsv\] archive file \.\.\.$/,
    /^ar -r \[-cuTLsv\] archive file \.\.\.$/,
    /^ar -r \[-abciuTLsv\] position archive file \.\.\.$/,
    /^ar -t \[-TLsv\] archive \[file \.\.\.\]$/,
    /^ar -x \[-ouTLsv\] archive \[file \.\.\.\]$/,
  ]
  return lines.length === patterns.length && lines.every((line, index) => patterns[index].test(line))
}

function requireToolName(value) {
  if (!['ar', 'cc', 'inspector', 'node'].includes(value)) {
    throw new Error('World FFmpeg build-report tool name is invalid.')
  }
  return value
}

async function writeExclusive(path, bytes, mode) {
  let handle
  let created = false
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
    created = true
    await handle.writeFile(bytes)
    if (mode !== undefined) await handle.chmod(mode)
    await handle.sync()
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    if (created) {
      const { rm } = await import('node:fs/promises')
      await rm(path, { force: true }).catch(() => undefined)
    }
    throw error
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined || values.has(argv[index])) throw usage()
    values.set(argv[index], argv[index + 1])
  }
  const required = ['--target', '--output', '--bundle-root', '--supply-chain', '--trust-file', '--signing-key-id', '--cc', '--ar', '--inspector', '--runtime-rpath']
  if (values.size !== required.length || required.some((key) => !values.has(key))) throw usage()
  return {
    target: values.get('--target'), outputDirectory: values.get('--output'), bundleRoot: values.get('--bundle-root'),
    supplyChainPath: values.get('--supply-chain'), trustFile: values.get('--trust-file'), signingKeyId: values.get('--signing-key-id'),
    tools: { cc: values.get('--cc'), ar: values.get('--ar'), inspector: values.get('--inspector') },
    runtimeRpath: values.get('--runtime-rpath'),
  }
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function requireTarget(value) {
  if (!['linux-arm64', 'linux-x64', 'darwin-arm64', 'win32-x64'].includes(value)) throw new Error('World FFmpeg build-report target is unsupported.')
  return value
}

function requireKeyId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error('World FFmpeg build-report key id is invalid.')
  return value
}

function usage() {
  return new Error('Usage: write-world-ffmpeg-build-report.mjs --target <tuple> --output <abs-dir> --bundle-root <abs-dir> --supply-chain <abs-json> --trust-file <abs-json> --signing-key-id <id> --cc <abs-tool> --ar <abs-tool> --inspector <abs-tool> --runtime-rpath <value>')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void writeWorldFfmpegBuildReport(parseArguments(process.argv.slice(2))).then(({ path }) => {
    process.stdout.write(`${path}\n`)
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg build-report creation failed.'}\n`)
    process.exitCode = 1
  })
}
