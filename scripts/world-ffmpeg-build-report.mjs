import { createHash } from 'node:crypto'

const REPORT_SCHEMA = 'modly.world-ffmpeg-build-report.v1'
const TARGETS = Object.freeze(['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'])
const SOURCE_DATE_EPOCH = 1740961320
const REPRODUCIBILITY = 'unverified-until-two-independent-builds-match'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const TOOL_NAMES = Object.freeze(['ar', 'cc', 'inspector', 'node'])
const CONFIGURE_NAMES = Object.freeze(['ffmpeg', 'libvpx', 'opus', 'zlib'])
const RUNTIME_RPATHS = Object.freeze({
  'darwin-arm64': '@loader_path',
  'linux-arm64': '$ORIGIN',
  'linux-x64': '$ORIGIN',
  'win32-x64': '',
})

export function createWorldFfmpegBuildReportIdentity(input) {
  const target = requireTarget(input?.target)
  const supplyChainBytes = requireBytes(input?.supplyChainBytes, 'supply-chain contract')
  const manifestBytes = requireBytes(input?.manifestBytes, 'runtime manifest')
  const signatureBytes = requireBytes(input?.signatureBytes, 'runtime signature')
  const trustBytes = requireBytes(input?.trustBytes, 'build trust')
  if (signatureBytes.byteLength !== 64) throw new Error('World FFmpeg runtime signature has an invalid size.')
  return Object.freeze({
    target,
    supplyChainSha256: sha256(supplyChainBytes),
    runtimeManifestSha256: sha256(manifestBytes),
    runtimeManifestSignatureSha256: sha256(signatureBytes),
    buildTrustSha256: sha256(trustBytes),
  })
}

export function createWorldFfmpegBuildReport(input) {
  const identity = createWorldFfmpegBuildReportIdentity(input)
  const signingKeyId = requireKeyId(input?.signingKeyId)
  const linkAuthority = worldFfmpegBuildReportLinkAuthority(identity.target, input?.runtimeRpath)
  const report = {
    schema: REPORT_SCHEMA,
    ...identity,
    signingKeyId,
    assemblyStatus: 'signed-runtime',
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    runtimeRpath: linkAuthority.runtimeRpath,
    configure: cloneJson(input?.configure),
    linkerEnvironment: cloneJson(input?.linkerEnvironment),
    tools: cloneJson(input?.tools),
    reproducibility: REPRODUCIBILITY,
  }
  if (!validateWorldFfmpegBuildReport(report, { ...input, ...identity, signingKeyId })) {
    throw new Error('World FFmpeg build report inputs are invalid.')
  }
  return deepFreeze(report)
}

export function validateWorldFfmpegBuildReport(value, input) {
  if (!exactRecord(value, [
    'schema', 'target', 'supplyChainSha256', 'runtimeManifestSha256',
    'runtimeManifestSignatureSha256', 'buildTrustSha256', 'signingKeyId',
    'assemblyStatus', 'sourceDateEpoch', 'runtimeRpath', 'configure', 'linkerEnvironment', 'tools', 'reproducibility',
  ]) || value.schema !== REPORT_SCHEMA || value.assemblyStatus !== 'signed-runtime'
    || value.sourceDateEpoch !== SOURCE_DATE_EPOCH || value.reproducibility !== REPRODUCIBILITY) return false
  let identity
  try { identity = createWorldFfmpegBuildReportIdentity(input) } catch { return false }
  if (value.target !== identity.target
    || value.supplyChainSha256 !== identity.supplyChainSha256
    || value.runtimeManifestSha256 !== identity.runtimeManifestSha256
    || value.runtimeManifestSignatureSha256 !== identity.runtimeManifestSignatureSha256
    || value.buildTrustSha256 !== identity.buildTrustSha256
    || value.signingKeyId !== input.signingKeyId
    || !KEY_ID_PATTERN.test(value.signingKeyId)) return false
  let supply
  let manifest
  let trust
  try {
    supply = parseCanonicalJson(input.supplyChainBytes)
    manifest = parseCanonicalJson(input.manifestBytes)
    trust = parseCanonicalJson(input.trustBytes)
  } catch {
    return false
  }
  if (supply.ffmpegVersion !== '7.1.1' || !supply.targets?.includes(identity.target)
    || manifest.schema !== 'modly.ffmpeg-runtime.v1' || manifest.target !== identity.target
    || manifest.signingKeyId !== value.signingKeyId
    || !Object.prototype.hasOwnProperty.call(trust, value.signingKeyId)) return false
  if (!exactRecord(value.configure, CONFIGURE_NAMES)) return false
  let linkAuthority
  try {
    linkAuthority = worldFfmpegBuildReportLinkAuthority(identity.target, value.runtimeRpath)
  } catch {
    return false
  }
  for (const name of CONFIGURE_NAMES) {
    const args = value.configure[name]
    if (!Array.isArray(args) || args.length < 2 || args.length > 128
      || args[0] !== './configure'
      || args.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 1024 || entry.includes('\0'))) return false
  }
  const ffmpegPrefix = [
    './configure', '--prefix=<BUILD_PREFIX>', '--bindir=<BUILD_PREFIX>/bin',
    '--libdir=<BUILD_PREFIX>/lib', '--shlibdir=<BUILD_PREFIX>/lib',
    '--extra-cflags=<REPRODUCIBLE_CFLAGS>',
    `--extra-ldflags=${linkAuthority.normalizedExtraLdflags}`,
  ]
  if (value.configure.ffmpeg.length !== supply.ffmpegConfigure.length + ffmpegPrefix.length
    || value.configure.ffmpeg.slice(0, ffmpegPrefix.length).some((entry, index) => entry !== ffmpegPrefix[index])
    || value.configure.ffmpeg.slice(ffmpegPrefix.length).some((entry, index) => entry !== supply.ffmpegConfigure[index])) return false
  if (!sameArray(value.configure.zlib, ['./configure', '--prefix=<BUILD_PREFIX>', '--shared'])
    || !sameArray(value.configure.opus, ['./configure', '--prefix=<BUILD_PREFIX>', '--disable-static', '--enable-shared', '--disable-doc', '--disable-extra-programs'])
    || !sameArray(value.configure.libvpx, ['./configure', '--prefix=<BUILD_PREFIX>', '--target=<TARGET_FROM_SCRIPT>', '--disable-static', '--enable-shared', '--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests', '--disable-vp8', '--enable-vp9', '--disable-webm-io', '--disable-libyuv'])) return false
  if (JSON.stringify(value.linkerEnvironment) !== JSON.stringify(linkAuthority.linkerEnvironment)) return false
  if (!exactRecord(value.tools, TOOL_NAMES)) return false
  for (const name of TOOL_NAMES) {
    const tool = value.tools[name]
    if (!exactRecord(tool, ['path', 'version', 'sha256'])
      || typeof tool.path !== 'string' || !isAbsoluteToolPath(tool.path, identity.target)
      || typeof tool.version !== 'string' || tool.version.length < 1 || tool.version.length > 1024
      || tool.version.includes('\0') || !SHA256_PATTERN.test(tool.sha256)) return false
  }
  return true
}

export function worldFfmpegBuildReportLinkAuthority(targetValue, runtimeRpathValue) {
  const target = requireTarget(targetValue)
  const expected = RUNTIME_RPATHS[target]
  if (typeof runtimeRpathValue !== 'string' || runtimeRpathValue !== expected
    || runtimeRpathValue.includes('\0')) {
    throw new Error('World FFmpeg build-report runtime rpath is invalid for the target tuple.')
  }
  const linkerEnvironment = target === 'linux-arm64' || target === 'linux-x64'
    ? { LD_RUN_PATH: runtimeRpathValue }
    : target === 'darwin-arm64'
      ? { LDFLAGS_RPATH: `-Wl,-rpath,${runtimeRpathValue}` }
      : {}
  const normalizedExtraLdflags = target === 'darwin-arm64'
    ? `-L<BUILD_PREFIX>/lib -Wl,-rpath,${runtimeRpathValue}`
    : '-L<BUILD_PREFIX>/lib'
  return deepFreeze({ runtimeRpath: runtimeRpathValue, linkerEnvironment, normalizedExtraLdflags })
}

function isAbsoluteToolPath(value, target) {
  if (value.includes('\0') || value.length > 4096) return false
  return target === 'win32-x64'
    ? /^(?:[A-Za-z]:[\\/]|\\\\)[^\0]+$/.test(value)
    : value.startsWith('/')
}

export function worldFfmpegBuildReportBytes(report) {
  return Buffer.from(`${JSON.stringify(report)}\n`)
}

function parseCanonicalJson(bytes) {
  const buffer = requireBytes(bytes, 'canonical JSON')
  const value = JSON.parse(buffer.toString('utf8'))
  if (!buffer.equals(Buffer.from(`${JSON.stringify(value)}\n`))) throw new Error('noncanonical')
  return value
}

function requireBytes(value, label) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 4 * 1024 * 1024) {
    throw new Error(`World FFmpeg ${label} bytes are invalid.`)
  }
  return Buffer.from(value)
}

const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

function requireKeyId(value) {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    throw new Error('World FFmpeg build-report signing key id is invalid.')
  }
  return value
}

function requireTarget(value) {
  if (!TARGETS.includes(value)) throw new Error('World FFmpeg build-report target is unsupported.')
  return value
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort(codeUnitCompare)
  const expected = [...keys].sort(codeUnitCompare)
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index])
}

function cloneJson(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length
    && left.every((entry, index) => entry === right[index])
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
