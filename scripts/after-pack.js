// @ts-check

const path = require('node:path')
const { execFileSync } = require('node:child_process')
const {
  electronBuilderTargetFor,
  verifyPackagedRuntime,
} = require('./world-ffmpeg-before-pack.cjs')
const { verifyWorldsCodexCliBundle } = require('./worlds-codex-cli-package.cjs')
const REPOSITORY_ROOT = path.resolve(__dirname, '..')

async function verifyWorldsCodexCliPackage(resourcesPath) {
  const source = await verifyWorldsCodexCliBundle(REPOSITORY_ROOT, 'source')
  if (!source.ok) return source
  return verifyWorldsCodexCliBundle(resourcesPath, 'packaged')
}

/**
 * Verify the copied package resources before any distributable artifact is
 * produced. macOS ad-hoc signing happens only after that verification so the
 * exact native closure is included in the signature.
 */
async function afterPackWith(context, dependencies) {
  const target = electronBuilderTargetFor(context?.electronPlatformName, context?.arch)
  if (!target) throw new Error('Unsupported FFmpeg package target.')
  const productFilename = context?.packager?.appInfo?.productFilename
  if (typeof productFilename !== 'string' || !productFilename
    || path.basename(productFilename) !== productFilename) {
    throw new Error('Packaged application identity is invalid.')
  }
  if (typeof context?.appOutDir !== 'string' || !path.isAbsolute(context.appOutDir)) {
    throw new Error('Packaged application output path is invalid.')
  }
  const arch = target.slice(target.indexOf('-') + 1)
  const appPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${productFilename}.app`)
    : null
  const resourcesPath = appPath
    ? path.join(appPath, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const cliResult = await (dependencies.verifyCli ?? verifyWorldsCodexCliPackage)(resourcesPath)
  if (!cliResult || cliResult.ok !== true) {
    throw new Error(`Packaged Worlds CLI verification failed: ${cliResult?.code ?? 'verification-error'}`)
  }
  const result = await dependencies.verify({
    platform: context.electronPlatformName,
    arch,
    resourcesPath,
  })
  if (!result || result.ok !== true) {
    throw new Error(`Packaged FFmpeg verification failed: ${result?.code ?? 'verification-error'}`)
  }
  if (appPath) await dependencies.codesign(appPath)
}

async function codesignApp(appPath) {
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  })
  execFileSync('/usr/bin/codesign', ['--verify', '--verbose=2', appPath], {
    stdio: 'inherit',
  })
  console.log(`[after-pack] Ad-hoc signature applied: ${appPath}`)
}

async function afterPack(context) {
  return afterPackWith(context, {
    verify: verifyPackagedRuntime,
    codesign: codesignApp,
  })
}

exports.default = afterPack
exports.afterPackWith = afterPackWith
