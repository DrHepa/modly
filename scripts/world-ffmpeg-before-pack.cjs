'use strict'

const { spawn } = require('node:child_process')
const { isAbsolute, resolve } = require('node:path')
const { requireCanonicalWindowsSystemRoot } = require('./world-ffmpeg-package-environment.cjs')
const { verifyWorldsCodexCliBundle } = require('./worlds-codex-cli-package.cjs')

const REPOSITORY_ROOT = resolve(__dirname, '..')
const VERIFY_SCRIPT = resolve(__dirname, 'verify-world-ffmpeg-package.ts')
const DENY_NETWORK_PRELOAD = resolve(__dirname, 'world-ffmpeg-deny-network.cjs')
const VERIFIER_AUTHORITY = 'modly.world-ffmpeg-verifier.v1'
const ARCH_NAMES = Object.freeze({ 1: 'x64', 3: 'arm64' })

function electronBuilderTargetFor(platform, arch) {
  const name = ARCH_NAMES[arch] ?? null
  if ((platform === 'linux' || platform === 'win32') && name === 'x64') return `${platform}-x64`
  if (platform === 'linux' && name === 'arm64') return 'linux-arm64'
  if (platform === 'darwin' && name === 'arm64') return 'darwin-arm64'
  return null
}

async function beforePackWith(context, dependencies) {
  const target = electronBuilderTargetFor(context?.electronPlatformName, context?.arch)
  if (!target) throw new Error('Unsupported FFmpeg package target.')
  const cliResult = await (dependencies.verifyCli ?? verifyWorldsCodexCliBundle)(REPOSITORY_ROOT, 'source')
  if (!cliResult || cliResult.ok !== true) {
    throw new Error(`Packaged Worlds CLI verification failed: ${cliResult?.code ?? 'verification-error'}`)
  }
  const arch = target.slice(target.indexOf('-') + 1)
  const result = await dependencies.verify({ platform: context.electronPlatformName, arch })
  if (!result || result.ok !== true) {
    throw new Error(`Audited FFmpeg package verification failed: ${result?.code ?? 'verification-error'}`)
  }
}

async function verifyPackagedRuntime(request) {
  const supply = await import('./world-ffmpeg-supply-chain.mjs')
  const contract = await supply.loadWorldFfmpegSupplyChain()
  const distribution = await supply.verifyWorldFfmpegDistributionFiles(contract)
  if (!distribution.ok) return { ok: false, code: distribution.code }
  return runVerifier(request)
}

function runVerifier(request) {
  return runVerifierWith(request, { spawnProcess: spawn, sourceEnvironment: process.env })
}

function runVerifierWith(request, dependencies) {
  if (!dependencies || typeof dependencies.spawnProcess !== 'function'
    || !dependencies.sourceEnvironment || typeof dependencies.sourceEnvironment !== 'object') {
    return Promise.resolve({ ok: false, code: 'verifier-authority-invalid' })
  }
  const trustFile = request.trustFile ?? dependencies.sourceEnvironment.WORLD_FFMPEG_BUILD_TRUST_FILE
  if (typeof trustFile !== 'string' || !isAbsolute(trustFile) || trustFile.includes('\0')) {
    return Promise.resolve({ ok: false, code: 'build-trust-missing' })
  }
  const resourceArguments = request.resourcesPath
    ? ['--resources', request.resourcesPath]
    : []
  const snapshot = requireVerifierSnapshotAuthority(request)
  const snapshotArguments = snapshot ? [
    '--resources-identity', encodeAuthority(snapshot.resourcesIdentity),
    '--build-report-directory', snapshot.directory,
    '--build-report-directory-identity', encodeAuthority(snapshot.directoryIdentity),
    '--build-report-name', snapshot.name,
    '--build-report-receipt', encodeAuthority(snapshot.receipt),
  ] : []
  const env = verifierEnvironment(request.platform, dependencies.sourceEnvironment)
  return new Promise((resolveResult) => {
    let timer = null
    const child = dependencies.spawnProcess(process.execPath, [
      `--require=${DENY_NETWORK_PRELOAD}`,
      '--no-warnings',
      '--experimental-strip-types',
      VERIFY_SCRIPT,
      ...resourceArguments,
      ...snapshotArguments,
      '--platform', request.platform,
      '--arch', request.arch,
      '--trust-file', resolve(trustFile),
    ], {
      cwd: snapshot ? request.resourcesPath : REPOSITORY_ROOT,
      env,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ['ignore', snapshot ? 'pipe' : 'ignore', 'pipe'],
    })
    let stderr = ''
    let stdout = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolveResult(result)
    }
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk).slice(0, 64 * 1024 - stderr.length)
    })
    if (snapshot) {
      if (!child.stdout || typeof child.stdout.on !== 'function') {
        finish({ ok: false, code: 'verifier-receipt-unavailable' })
        return
      }
      child.stdout.on('data', (chunk) => {
        if (stdout.length < 64 * 1024) stdout += String(chunk).slice(0, 64 * 1024 - stdout.length)
      })
    }
    child.once('error', () => finish({ ok: false, code: 'verifier-spawn-failed' }))
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        finish({ ok: false, code: stderr.trim() || `verifier-exit-${code ?? signal ?? 'unknown'}` })
        return
      }
      if (!snapshot) {
        finish({ ok: true })
        return
      }
      let receipt
      try { receipt = JSON.parse(stdout) } catch {
        finish({ ok: false, code: 'verifier-receipt-invalid' })
        return
      }
      const canonical = stdout === `${JSON.stringify(receipt)}\n`
      const valid = canonical
        && exactRecord(receipt, ['schema', 'buildReportReceipt', 'runtimeManifestSha256'])
        && receipt.schema === 'modly.world-ffmpeg-verifier-receipt.v1'
        && validFileReceipt(receipt.buildReportReceipt)
        && sameFileReceipt(receipt.buildReportReceipt, snapshot.receipt)
        && typeof receipt.runtimeManifestSha256 === 'string'
        && /^[a-f0-9]{64}$/.test(receipt.runtimeManifestSha256)
      finish(valid
        ? {
            ok: true,
            buildReportReceipt: snapshot.receipt,
            runtimeManifestSha256: receipt.runtimeManifestSha256,
          }
        : { ok: false, code: 'verifier-receipt-invalid' })
    })
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, code: 'verifier-timeout' })
    }, 60_000)
    timer.unref?.()
  })
}

function requireVerifierSnapshotAuthority(request) {
  const values = [
    request.resourcesIdentity,
    request.buildReportDirectory,
    request.buildReportDirectoryIdentity,
    request.buildReportName,
    request.buildReportReceipt,
  ]
  if (values.every((value) => value === undefined)) return null
  if (!validAbsolutePath(request.resourcesPath)
    || !validDirectoryIdentity(request.resourcesIdentity)
    || !validAbsolutePath(request.buildReportDirectory)
    || !validDirectoryIdentity(request.buildReportDirectoryIdentity)
    || !validDirectName(request.buildReportName)
    || !validFileReceipt(request.buildReportReceipt)
    || request.buildReportReceipt.name !== request.buildReportName) {
    throw new Error('Verifier build-report snapshot authority is invalid.')
  }
  return Object.freeze({
    resourcesIdentity: request.resourcesIdentity,
    directory: resolve(request.buildReportDirectory),
    directoryIdentity: request.buildReportDirectoryIdentity,
    name: request.buildReportName,
    receipt: request.buildReportReceipt,
  })
}

function validAbsolutePath(value) {
  return typeof value === 'string' && isAbsolute(value)
    && !value.includes('\0') && !/[\r\n]/.test(value)
}

function encodeAuthority(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64')
}

function validDirectoryIdentity(value) {
  return exactRecord(value, ['dev', 'ino'])
    && /^[0-9]{1,40}$/.test(value.dev) && /^[1-9][0-9]{0,39}$/.test(value.ino)
}

function validFileReceipt(value) {
  return exactRecord(value, ['name', 'dev', 'ino', 'size', 'sha256'])
    && validDirectName(value.name)
    && /^[0-9]{1,40}$/.test(value.dev) && /^[1-9][0-9]{0,39}$/.test(value.ino)
    && Number.isSafeInteger(value.size) && value.size >= 2 && value.size <= 1024 * 1024
    && /^[a-f0-9]{64}$/.test(value.sha256)
}

function sameFileReceipt(left, right) {
  return validFileReceipt(left) && validFileReceipt(right)
    && left.name === right.name && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.sha256 === right.sha256
}

function validDirectName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 255
    && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
    && !value.includes('\0') && !/[\r\n]/.test(value)
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index])
}

function verifierEnvironment(platform, sourceEnvironment) {
  const bootstrapExecutable = sourceEnvironment.WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE ?? process.execPath
  if (typeof bootstrapExecutable !== 'string' || bootstrapExecutable.includes('\0')) {
    throw new Error('Verifier Electron runtime authority is unavailable.')
  }
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    PATH: '/usr/bin:/bin',
    NODE_OPTIONS: `--require=${DENY_NETWORK_PRELOAD}`,
    WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE: bootstrapExecutable,
    WORLD_FFMPEG_PACKAGE_NETWORK: 'denied',
    WORLD_FFMPEG_VERIFIER_AUTHORITY: VERIFIER_AUTHORITY,
  }
  if (platform === 'win32') {
    const systemRoot = requireCanonicalWindowsSystemRoot(sourceEnvironment)
    env.SystemRoot = systemRoot
    env.WINDIR = systemRoot
    env.PATH = `${systemRoot}\\System32;${systemRoot}`
    env.COMSPEC = `${systemRoot}\\System32\\cmd.exe`
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
  }
  return Object.freeze(env)
}

async function beforePack(context) {
  return beforePackWith(context, { verify: verifyPackagedRuntime })
}

module.exports = beforePack
module.exports.beforePackWith = beforePackWith
module.exports.electronBuilderTargetFor = electronBuilderTargetFor
module.exports.runVerifierWith = runVerifierWith
module.exports.verifyPackagedRuntime = verifyPackagedRuntime
