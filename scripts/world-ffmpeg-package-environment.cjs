'use strict'

const path = require('node:path')

const ELECTRON_VERSION = '44.1.1'
const CLEAN_BOOTSTRAP_STAGE = 'modly.world-ffmpeg-package-bootstrap.v2'
const DENY_NETWORK_PRELOAD = path.join(__dirname, 'world-ffmpeg-deny-network.cjs')
const TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({ platform: 'darwin', arch: 'arm64' }),
  'linux-arm64': Object.freeze({ platform: 'linux', arch: 'arm64' }),
  'linux-x64': Object.freeze({ platform: 'linux', arch: 'x64' }),
  'win32-x64': Object.freeze({ platform: 'win32', arch: 'x64' }),
})
const CLEAN_COMMON_KEYS = Object.freeze([
  'ELECTRON_BUILDER_CACHE',
  'ELECTRON_RUN_AS_NODE',
  'LANG',
  'LC_ALL',
  'PATH',
  'TZ',
  'WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE',
  'WORLD_FFMPEG_BUILD_TRUST_FILE',
  'WORLD_FFMPEG_CLEAN_BOOTSTRAP',
  'WORLD_FFMPEG_PACKAGE_TARGET',
])
const BUILDER_COMMON_KEYS = Object.freeze([
  'CSC_IDENTITY_AUTO_DISCOVERY',
  'ELECTRON_BUILDER_CACHE',
  'ELECTRON_BUILDER_OFFLINE',
  'ELECTRON_DOWNLOAD_CACHE_MODE',
  'ELECTRON_GET_USE_PROXY',
  'ELECTRON_RUN_AS_NODE',
  'LANG',
  'LC_ALL',
  'NODE_OPTIONS',
  'NPM_CONFIG_OFFLINE',
  'PATH',
  'TZ',
  'WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE',
  'WORLD_FFMPEG_BUILD_TRUST_FILE',
  'WORLD_FFMPEG_PACKAGE_NETWORK',
  'WORLD_FFMPEG_PACKAGE_ATTEMPT_ID',
  'WORLD_FFMPEG_PACKAGE_CACHE_IDENTITY',
  'WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY',
  'WORLD_FFMPEG_PACKAGE_OUTPUT_IDENTITY',
  'WORLD_FFMPEG_PACKAGE_RUNNER_HEARTBEAT',
  'WORLD_FFMPEG_PACKAGE_RUNNER_TERMINAL',
  'WORLD_FFMPEG_PACKAGE_TARGET',
])
const WINDOWS_KEYS = Object.freeze(['COMSPEC', 'PATHEXT', 'SystemRoot', 'WINDIR'])

function worldFfmpegPackageTargetFor(platform, arch) {
  for (const [target, authority] of Object.entries(TARGETS)) {
    if (authority.platform === platform && authority.arch === arch) return target
  }
  throw new Error(`unsupported-target: ${String(platform)}-${String(arch)}`)
}

function createWorldFfmpegCleanEnvironment(input) {
  const target = requireTarget(input?.target)
  const authority = TARGETS[target]
  const cacheDirectory = requireAbsolute(input?.cacheDirectory, target, 'package-tool cache')
  const buildTrustFile = requireAbsolute(input?.buildTrustFile, target, 'build-trust file')
  const bootstrapExecutable = requireAbsolute(input?.bootstrapExecutable, target, 'bootstrap executable')
  const env = {
    ELECTRON_BUILDER_CACHE: cacheDirectory,
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    TZ: 'UTC',
    WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE: bootstrapExecutable,
    WORLD_FFMPEG_BUILD_TRUST_FILE: buildTrustFile,
    WORLD_FFMPEG_CLEAN_BOOTSTRAP: CLEAN_BOOTSTRAP_STAGE,
    WORLD_FFMPEG_PACKAGE_TARGET: target,
  }
  if (authority.platform === 'win32') addWindowsSystemEnvironment(env, input?.sourceEnvironment)
  return Object.freeze(env)
}

function requireClosedWorldFfmpegCleanEnvironment(environment, runtime) {
  const target = requireRuntime(runtime)
  const accessor = closedEnvironmentAccessor(environment, target, CLEAN_COMMON_KEYS)
  requireCommonRuntimeEnvironment(accessor, target, runtime)
  if (accessor.get('WORLD_FFMPEG_CLEAN_BOOTSTRAP') !== CLEAN_BOOTSTRAP_STAGE) {
    throw new Error('World FFmpeg clean package environment authority is invalid.')
  }
  requireAbsolute(accessor.get('ELECTRON_BUILDER_CACHE'), target, 'package-tool cache')
  requireAbsolute(accessor.get('WORLD_FFMPEG_BUILD_TRUST_FILE'), target, 'build-trust file')
  requireSystemEnvironment(accessor, target)
  return target
}

function createWorldFfmpegBuilderEnvironment(input) {
  const target = requireTarget(input?.target)
  const authority = TARGETS[target]
  const cacheDirectory = requireAbsolute(input?.cacheDirectory, target, 'package-tool cache')
  const buildTrustFile = requireAbsolute(input?.buildTrustFile, target, 'build-trust file')
  const bootstrapExecutable = requireAbsolute(input?.bootstrapExecutable, target, 'bootstrap executable')
  const attempt = requireAttemptInput(input, target)
  const env = {
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    ELECTRON_BUILDER_CACHE: cacheDirectory,
    ELECTRON_BUILDER_OFFLINE: 'true',
    ELECTRON_DOWNLOAD_CACHE_MODE: '1',
    ELECTRON_GET_USE_PROXY: 'false',
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'C',
    LC_ALL: 'C',
    NODE_OPTIONS: `--require=${DENY_NETWORK_PRELOAD}`,
    NPM_CONFIG_OFFLINE: 'true',
    PATH: '/usr/bin:/bin',
    TZ: 'UTC',
    WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE: bootstrapExecutable,
    WORLD_FFMPEG_BUILD_TRUST_FILE: buildTrustFile,
    WORLD_FFMPEG_PACKAGE_NETWORK: 'denied',
    WORLD_FFMPEG_PACKAGE_ATTEMPT_ID: attempt.attemptId,
    WORLD_FFMPEG_PACKAGE_CACHE_IDENTITY: encodeDirectoryIdentity(attempt.cacheIdentity),
    WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY: attempt.outputDirectory,
    WORLD_FFMPEG_PACKAGE_OUTPUT_IDENTITY: encodeDirectoryIdentity(attempt.outputIdentity),
    WORLD_FFMPEG_PACKAGE_RUNNER_HEARTBEAT: attempt.runnerHeartbeatPath,
    WORLD_FFMPEG_PACKAGE_RUNNER_TERMINAL: attempt.runnerTerminalPath,
    WORLD_FFMPEG_PACKAGE_TARGET: target,
  }
  if (authority.platform === 'win32') addWindowsSystemEnvironment(env, input?.sourceEnvironment)
  return Object.freeze(env)
}

function requireClosedWorldFfmpegBuilderEnvironment(environment, runtime) {
  const target = targetFromEnvironment(environment)
  const accessor = closedEnvironmentAccessor(environment, target, BUILDER_COMMON_KEYS)
  const expected = {
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    ELECTRON_BUILDER_OFFLINE: 'true',
    ELECTRON_DOWNLOAD_CACHE_MODE: '1',
    ELECTRON_GET_USE_PROXY: 'false',
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'C',
    LC_ALL: 'C',
    NODE_OPTIONS: `--require=${DENY_NETWORK_PRELOAD}`,
    NPM_CONFIG_OFFLINE: 'true',
    TZ: 'UTC',
    WORLD_FFMPEG_PACKAGE_NETWORK: 'denied',
    WORLD_FFMPEG_PACKAGE_TARGET: target,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (accessor.get(key) !== value) {
      throw new Error(`Audited electron-builder environment has invalid ${key}.`)
    }
  }
  requireAbsolute(accessor.get('ELECTRON_BUILDER_CACHE'), target, 'package-tool cache')
  requireAbsolute(accessor.get('WORLD_FFMPEG_BUILD_TRUST_FILE'), target, 'build-trust file')
  requireAbsolute(accessor.get('WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE'), target, 'bootstrap executable')
  requireAttemptEnvironment(accessor, target)
  requireSystemEnvironment(accessor, target)
  if (runtime !== undefined) requireCommonRuntimeEnvironment(accessor, target, runtime)
  return target
}

function requireAttemptInput(input, target) {
  const attemptId = input?.attemptId
  if (typeof attemptId !== 'string' || !/^[a-f0-9]{32}$/.test(attemptId)) {
    throw new Error('World FFmpeg package attempt identity is invalid.')
  }
  const outputDirectory = requireAbsolute(input?.outputDirectory, target, 'package output directory')
  const cacheIdentity = requireDirectoryIdentity(input?.cacheIdentity)
  const outputIdentity = requireDirectoryIdentity(input?.outputIdentity)
  const runnerHeartbeatPath = requireAbsolute(input?.runnerHeartbeatPath, target, 'runner heartbeat')
  const runnerTerminalPath = requireAbsolute(input?.runnerTerminalPath, target, 'runner terminal receipt')
  validateAttemptPathBindings({
    attemptId,
    cacheDirectory: requireAbsolute(input?.cacheDirectory, target, 'package-tool cache'),
    outputDirectory,
    runnerHeartbeatPath,
    runnerTerminalPath,
  }, target)
  return { attemptId, cacheIdentity, outputDirectory, outputIdentity, runnerHeartbeatPath, runnerTerminalPath }
}

function requireAttemptEnvironment(accessor, target) {
  const attemptId = accessor.get('WORLD_FFMPEG_PACKAGE_ATTEMPT_ID')
  if (typeof attemptId !== 'string' || !/^[a-f0-9]{32}$/.test(attemptId)) {
    throw new Error('World FFmpeg package attempt identity is invalid.')
  }
  validateAttemptPathBindings({
    attemptId,
    cacheDirectory: requireAbsolute(accessor.get('ELECTRON_BUILDER_CACHE'), target, 'package-tool cache'),
    outputDirectory: requireAbsolute(accessor.get('WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY'), target, 'package output directory'),
    runnerHeartbeatPath: requireAbsolute(accessor.get('WORLD_FFMPEG_PACKAGE_RUNNER_HEARTBEAT'), target, 'runner heartbeat'),
    runnerTerminalPath: requireAbsolute(accessor.get('WORLD_FFMPEG_PACKAGE_RUNNER_TERMINAL'), target, 'runner terminal receipt'),
  }, target)
  decodeDirectoryIdentity(accessor.get('WORLD_FFMPEG_PACKAGE_CACHE_IDENTITY'))
  decodeDirectoryIdentity(accessor.get('WORLD_FFMPEG_PACKAGE_OUTPUT_IDENTITY'))
}

function requireDirectoryIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'dev,ino'
    || typeof value.dev !== 'string' || !/^[0-9]{1,40}$/.test(value.dev)
    || typeof value.ino !== 'string' || !/^[1-9][0-9]{0,39}$/.test(value.ino)) {
    throw new Error('World FFmpeg package directory identity is invalid.')
  }
  return value
}

function encodeDirectoryIdentity(value) {
  return Buffer.from(JSON.stringify(requireDirectoryIdentity(value))).toString('base64')
}

function decodeDirectoryIdentity(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('World FFmpeg package directory identity encoding is invalid.')
  }
  try {
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') !== value) throw new Error('noncanonical')
    return requireDirectoryIdentity(JSON.parse(bytes.toString('utf8')))
  } catch {
    throw new Error('World FFmpeg package directory identity encoding is invalid.')
  }
}

function validateAttemptPathBindings(value, target) {
  const pathAuthority = TARGETS[target].platform === 'win32' ? path.win32 : path.posix
  const expected = [
    [value.cacheDirectory, `cache-${value.attemptId}`],
    [value.outputDirectory, `output-${value.attemptId}`],
    [value.runnerHeartbeatPath, `runner-${value.attemptId}.heartbeat`],
    [value.runnerTerminalPath, `terminal-${value.attemptId}.json`],
  ]
  if (expected.some(([candidate, name]) => pathAuthority.basename(candidate) !== name)
    || pathAuthority.dirname(value.runnerHeartbeatPath) !== pathAuthority.dirname(value.runnerTerminalPath)
    || new Set(expected.map(([candidate]) => TARGETS[target].platform === 'win32'
      ? candidate.toLowerCase() : candidate)).size !== expected.length) {
    throw new Error('World FFmpeg package attempt paths are not identity-bound.')
  }
}

function requireCommonRuntimeEnvironment(accessor, target, runtime) {
  const runtimeTarget = requireRuntime(runtime)
  if (runtimeTarget !== target
    || accessor.get('ELECTRON_RUN_AS_NODE') !== '1'
    || !samePath(accessor.get('WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE'), runtime.execPath, target)) {
    throw new Error('World FFmpeg Electron runtime authority is invalid.')
  }
}

function requireRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object' || runtime.electronVersion !== ELECTRON_VERSION) {
    throw new Error('World FFmpeg Electron runtime authority is invalid.')
  }
  const target = worldFfmpegPackageTargetFor(runtime.platform, runtime.arch)
  requireAbsolute(runtime.execPath, target, 'runtime executable')
  return target
}

function targetFromEnvironment(environment) {
  const index = windowsEnvironmentIndex(environment)
  const entry = index.get('world_ffmpeg_package_target')
  if (!entry) throw new Error('Audited electron-builder target is unavailable.')
  return requireTarget(entry.value)
}

function closedEnvironmentAccessor(environment, target, commonKeys) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('Audited package environment is unavailable.')
  }
  const windows = TARGETS[target].platform === 'win32'
  const expectedKeys = windows ? [...commonKeys, ...WINDOWS_KEYS] : [...commonKeys]
  if (!windows) {
    if (!sameArray(Object.keys(environment).sort(codeUnitCompare), expectedKeys.sort(codeUnitCompare))) {
      throw new Error('Audited package environment is not closed.')
    }
    return { get: (key) => environment[key] }
  }
  const index = windowsEnvironmentIndex(environment)
  const expectedFolded = expectedKeys.map((key) => key.toLowerCase()).sort(codeUnitCompare)
  if (!sameArray([...index.keys()].sort(codeUnitCompare), expectedFolded)) {
    throw new Error('Audited Windows package environment is not closed.')
  }
  return { get: (key) => index.get(key.toLowerCase())?.value }
}

function addWindowsSystemEnvironment(environment, sourceEnvironment) {
  const systemRoot = requireCanonicalWindowsSystemRoot(sourceEnvironment)
  environment.SystemRoot = systemRoot
  environment.WINDIR = systemRoot
  environment.PATH = `${systemRoot}\\System32;${systemRoot}`
  environment.COMSPEC = `${systemRoot}\\System32\\cmd.exe`
  environment.PATHEXT = '.COM;.EXE;.BAT;.CMD'
}

function requireSystemEnvironment(accessor, target) {
  if (TARGETS[target].platform !== 'win32') {
    if (accessor.get('PATH') !== '/usr/bin:/bin') {
      throw new Error('Audited package environment has invalid PATH.')
    }
    return
  }
  const systemRoot = requireCanonicalWindowsSystemRoot({
    SystemRoot: accessor.get('SystemRoot'),
    WINDIR: accessor.get('WINDIR'),
  })
  if (!equalWindows(accessor.get('PATH'), `${systemRoot}\\System32;${systemRoot}`)
    || !equalWindows(accessor.get('COMSPEC'), `${systemRoot}\\System32\\cmd.exe`)
    || accessor.get('PATHEXT') !== '.COM;.EXE;.BAT;.CMD') {
    throw new Error('Audited Windows package environment has invalid system authority.')
  }
}

function requireCanonicalWindowsSystemRoot(environment) {
  const index = windowsEnvironmentIndex(environment)
  const systemRoot = index.get('systemroot')?.value
  const windir = index.get('windir')?.value
  if (typeof systemRoot !== 'string' || typeof windir !== 'string'
    || !equalWindows(systemRoot, windir)
    || !/^[A-Za-z]:\\Windows$/i.test(systemRoot)
    || /[\u0000-\u001f\u007f"<>|?*&%!^]/.test(systemRoot)) {
    throw new Error('Windows SystemRoot authority is invalid.')
  }
  const normalized = path.win32.normalize(systemRoot)
  if (!equalWindows(normalized, systemRoot)) throw new Error('Windows SystemRoot authority is not canonical.')
  return `${normalized[0].toUpperCase()}${normalized.slice(1)}`
}

function windowsEnvironmentIndex(environment) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('Windows environment authority is unavailable.')
  }
  const index = new Map()
  for (const key of Object.keys(environment)) {
    const folded = key.toLowerCase()
    if (index.has(folded)) throw new Error(`Windows environment contains duplicate ${key} authority.`)
    index.set(folded, { key, value: environment[key] })
  }
  return index
}

function requireAbsolute(value, target, label) {
  if (typeof value !== 'string' || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  if (TARGETS[target].platform === 'win32') {
    if (!path.win32.isAbsolute(value)) throw new Error(`World FFmpeg ${label} must be an absolute Windows path.`)
    return path.win32.normalize(value)
  }
  if (!path.isAbsolute(value)) throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  return path.resolve(value)
}

function samePath(left, right, target) {
  try {
    const normalizedLeft = requireAbsolute(left, target, 'bootstrap executable')
    const normalizedRight = requireAbsolute(right, target, 'runtime executable')
    return TARGETS[target].platform === 'win32'
      ? equalWindows(normalizedLeft, normalizedRight)
      : normalizedLeft === normalizedRight
  } catch {
    return false
  }
}

function requireTarget(value) {
  if (!Object.hasOwn(TARGETS, value)) throw new Error('unsupported-target: package tuple')
  return value
}

function equalWindows(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase()
}

function sameArray(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

module.exports = Object.freeze({
  WORLD_FFMPEG_CLEAN_BOOTSTRAP_STAGE: CLEAN_BOOTSTRAP_STAGE,
  WORLD_FFMPEG_DENY_NETWORK_PRELOAD: DENY_NETWORK_PRELOAD,
  WORLD_FFMPEG_ELECTRON_VERSION: ELECTRON_VERSION,
  createWorldFfmpegBuilderEnvironment,
  createWorldFfmpegCleanEnvironment,
  requireCanonicalWindowsSystemRoot,
  requireClosedWorldFfmpegBuilderEnvironment,
  requireClosedWorldFfmpegCleanEnvironment,
  worldFfmpegPackageTargetFor,
})
