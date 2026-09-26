import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnWorldFfmpegPackageProcess } from './world-ffmpeg-process-custody.mjs'
import {
  loadWorldFfmpegPackageResult,
  requireWorldFfmpegPackageResultReceipt,
} from './world-ffmpeg-package-tools.mjs'

const require = createRequire(import.meta.url)
const {
  WORLD_FFMPEG_ELECTRON_VERSION,
  createWorldFfmpegCleanEnvironment,
  worldFfmpegPackageTargetFor,
} = require('./world-ffmpeg-package-environment.cjs')

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const OFFLINE_PACKAGE = join(REPOSITORY_ROOT, 'scripts', 'world-ffmpeg-offline-package.mjs')
const BOOTSTRAP_AUTHORITY = 'modly.world-ffmpeg-package-bootstrap.v1'
const POSIX_BOOTSTRAP_KEYS = Object.freeze([
  'ELECTRON_BUILDER_CACHE',
  'ELECTRON_RUN_AS_NODE',
  'LANG',
  'LC_ALL',
  'PATH',
  'TZ',
  'WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE',
  'WORLD_FFMPEG_BUILD_TRUST_FILE',
  'WORLD_FFMPEG_CLEAN_BOOTSTRAP',
])
const PRE_EXECUTION_INJECTION_KEYS = Object.freeze([
  'BASH_ENV',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ENV',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_COMPILE_CACHE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_V8_COVERAGE',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
])

export async function runWorldFfmpegPackageBootstrap(dependencies = {}) {
  const validateResultReceipt = dependencies.requireResultReceipt
    ?? requireWorldFfmpegPackageResultReceipt
  const loadPackageResult = dependencies.loadPackageResult
    ?? loadWorldFfmpegPackageResult
  if (typeof validateResultReceipt !== 'function' || typeof loadPackageResult !== 'function') {
    throw new Error('World FFmpeg package bootstrap result authority is invalid.')
  }
  const runtime = dependencies.runtime ?? {
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    electronVersion: process.versions.electron,
  }
  const environment = dependencies.environment ?? process.env
  const execArgv = dependencies.execArgv ?? process.execArgv
  const argv = dependencies.argv ?? process.argv
  if (!Array.isArray(execArgv) || execArgv.length !== 0
    || !Array.isArray(argv) || argv.length !== 2
    || resolve(String(argv[1] ?? '')) !== fileURLToPath(import.meta.url)) {
    throw new Error('World FFmpeg package bootstrap Node authority is invalid.')
  }
  const target = worldFfmpegPackageTargetFor(runtime.platform, runtime.arch)
  const expectedExecutable = expectedElectronExecutable(target)
  if (runtime.electronVersion !== WORLD_FFMPEG_ELECTRON_VERSION
    || !sameExecutable(runtime.execPath, expectedExecutable, runtime.platform)) {
    throw new Error('World FFmpeg package bootstrap executable authority is invalid.')
  }
  const input = requireBootstrapEnvironment(environment, runtime.platform)
  if (!sameExecutable(input.bootstrapExecutable, expectedExecutable, runtime.platform)) {
    throw new Error('World FFmpeg package bootstrap executable environment is invalid.')
  }
  const childEnvironment = createWorldFfmpegCleanEnvironment({
    target,
    cacheDirectory: input.cacheDirectory,
    buildTrustFile: input.buildTrustFile,
    bootstrapExecutable: expectedExecutable,
    sourceEnvironment: environment,
  })
  const spawnProcess = dependencies.spawnProcess ?? spawnWorldFfmpegPackageProcess
  const attemptToken = randomBytes(16).toString('hex')
  const result = await spawnProcess(expectedExecutable, [
    OFFLINE_PACKAGE,
    `--world-ffmpeg-attempt=${attemptToken}`,
  ], Object.freeze({
    cwd: REPOSITORY_ROOT,
    env: childEnvironment,
    shell: false,
    detached: runtime.platform !== 'win32',
    windowsHide: true,
    stdio: Object.freeze(['ignore', 'pipe', 'inherit']),
  }), Object.freeze({
    ...(dependencies.processLifecycle ?? {}),
    platform: runtime.platform,
    captureStdoutBytes: 1024 * 1024,
  }))
  if (!result || typeof result !== 'object'
    || !Object.hasOwn(result, 'code') || !Object.hasOwn(result, 'signal')) {
    throw new Error('World FFmpeg clean package child returned an invalid process result.')
  }
  if (result.code !== 0 || result.signal !== null) return result
  if (!Buffer.isBuffer(result.stdout) || result.stdout.byteLength < 2 || result.stdout.byteLength > 1024 * 1024
    || result.stdout.includes(0)) {
    throw new Error('World FFmpeg clean package child returned no bounded result receipt.')
  }
  const candidates = result.stdout.toString('utf8').split(/\r?\n/).flatMap((line) => {
    if (line.length < 2 || line.length > 16 * 1024 || line[0] !== '{') return []
    try {
      const value = JSON.parse(line)
      return line === JSON.stringify(value)
        && value?.schema === 'modly.electron-builder-package-result-receipt.v1' ? [value] : []
    } catch { return [] }
  })
  if (candidates.length !== 1) throw new Error('World FFmpeg clean package child result receipt is invalid.')
  let receipt = candidates[0]
  receipt = validateResultReceipt(receipt)
  await loadPackageResult(receipt.manifestPath, { resultReceipt: receipt })
  return Object.freeze({ code: result.code, signal: result.signal, resultReceipt: receipt })
}

function requireBootstrapEnvironment(environment, platform) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('World FFmpeg package bootstrap environment is unavailable.')
  }
  const index = caseInsensitiveEnvironmentIndex(environment)
  for (const key of PRE_EXECUTION_INJECTION_KEYS) {
    if (index.has(key.toLowerCase())) {
      throw new Error(`World FFmpeg package bootstrap retained ${key}.`)
    }
  }
  if (platform !== 'win32') {
    const keys = Object.keys(environment).sort(codeUnitCompare)
    if (!sameArray(keys, [...POSIX_BOOTSTRAP_KEYS].sort(codeUnitCompare))
      || environment.PATH !== '/usr/bin:/bin'
      || environment.LANG !== 'C'
      || environment.LC_ALL !== 'C'
      || environment.TZ !== 'UTC') {
      throw new Error('World FFmpeg POSIX package bootstrap environment is not closed.')
    }
  }
  const value = (name) => index.get(name.toLowerCase())?.value
  if (value('ELECTRON_RUN_AS_NODE') !== '1'
    || value('WORLD_FFMPEG_CLEAN_BOOTSTRAP') !== BOOTSTRAP_AUTHORITY) {
    throw new Error('World FFmpeg package bootstrap environment authority is invalid.')
  }
  for (const [name, candidate] of [
    ['ELECTRON_BUILDER_CACHE', value('ELECTRON_BUILDER_CACHE')],
    ['WORLD_FFMPEG_BUILD_TRUST_FILE', value('WORLD_FFMPEG_BUILD_TRUST_FILE')],
    ['WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE', value('WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE')],
  ]) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new Error(`bundle-missing: ${name} is required.`)
    }
    if (candidate.includes('\0') || /[\r\n]/.test(candidate)
      || !(platform === 'win32' ? win32.isAbsolute(candidate) : isAbsolute(candidate))) {
      throw new Error(`World FFmpeg package bootstrap has invalid ${name}.`)
    }
  }
  return {
    cacheDirectory: value('ELECTRON_BUILDER_CACHE'),
    buildTrustFile: value('WORLD_FFMPEG_BUILD_TRUST_FILE'),
    bootstrapExecutable: value('WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE'),
  }
}

function expectedElectronExecutable(target) {
  if (target === 'darwin-arm64') {
    return join(REPOSITORY_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return join(REPOSITORY_ROOT, 'node_modules', 'electron', 'dist', target === 'win32-x64' ? 'electron.exe' : 'electron')
}

function sameExecutable(left, right, platform) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return platform === 'win32'
    ? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
    : resolve(left) === resolve(right)
}

function caseInsensitiveEnvironmentIndex(environment) {
  const index = new Map()
  for (const key of Object.keys(environment)) {
    const folded = key.toLowerCase()
    if (index.has(folded)) throw new Error(`Package bootstrap environment contains duplicate ${key}.`)
    index.set(folded, { key, value: environment[key] })
  }
  return index
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runWorldFfmpegPackageBootstrap().then((result) => {
    if (result.signal !== null) throw new Error(`World FFmpeg clean package child terminated by ${result.signal}.`)
    if (result.code === 0) {
      const encoded = Buffer.from(JSON.stringify(result.resultReceipt)).toString('base64')
      process.stdout.write(`WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT=${encoded}\n`)
    }
    process.exitCode = result.code ?? 1
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg package bootstrap failed.'}\n`)
    process.exitCode = 1
  })
}
