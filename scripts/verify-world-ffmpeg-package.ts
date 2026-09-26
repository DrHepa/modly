#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolvePackagedWorldFfmpegRuntime,
  planPackagedWorldFfmpegRuntimeSnapshot,
  WORLD_FFMPEG_VERSION,
  type WorldFfmpegRuntimeResolution,
} from '../electron/main/world-render-ffmpeg-runtime.ts'
import {
  loadWorldFfmpegSupplyChain,
  worldFfmpegTargetFor,
} from './world-ffmpeg-supply-chain.mjs'
import { loadWorldFfmpegBuildTrust } from './world-ffmpeg-build-trust.mjs'
import { validateWorldFfmpegBuildReport } from './world-ffmpeg-build-report.mjs'
import {
  runWorldFfmpegOutputCustody,
  sameWorldFfmpegOutputDirectoryIdentity,
  sameWorldFfmpegOutputFileReceipt,
  validateWorldFfmpegOutputFileReceipt,
} from './world-ffmpeg-output-custody.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const require = createRequire(import.meta.url)
const { requireCanonicalWindowsSystemRoot } = require('./world-ffmpeg-package-environment.cjs') as {
  requireCanonicalWindowsSystemRoot(environment: Readonly<Record<string, string | undefined>>): string
}
const RESOURCES_PATH = resolve(REPOSITORY_ROOT, 'resources')
const DENY_NETWORK_PRELOAD = resolve(REPOSITORY_ROOT, 'scripts', 'world-ffmpeg-deny-network.cjs')
const VERIFIER_AUTHORITY = 'modly.world-ffmpeg-verifier.v1'
const VERIFIER_ENVIRONMENT_KEYS = Object.freeze([
  'ELECTRON_RUN_AS_NODE', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'PATH', 'TZ',
  'WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE',
  'WORLD_FFMPEG_PACKAGE_NETWORK', 'WORLD_FFMPEG_VERIFIER_AUTHORITY',
])

type OutputDirectoryIdentity = Readonly<{ dev: string; ino: string }>
type OutputFileReceipt = Readonly<{
  name: string
  dev: string
  ino: string
  size: number
  sha256: string
}>

interface VerifyRequest {
  readonly platform: 'linux' | 'darwin' | 'win32'
  readonly arch: 'x64' | 'arm64'
  readonly trustFile: string
  readonly resourcesPath?: string
  readonly resourcesIdentity?: OutputDirectoryIdentity
  readonly buildReportDirectory?: string
  readonly buildReportDirectoryIdentity?: OutputDirectoryIdentity
  readonly buildReportName?: string
  readonly buildReportReceipt?: OutputFileReceipt
}

interface WorldFfmpegPackageVerificationReceipt {
  readonly buildReportReceipt: OutputFileReceipt | null
  readonly runtimeManifestSha256: string
}

interface VerifyDependencies {
  readonly outputCustody?: typeof runWorldFfmpegOutputCustody
  readonly loadBuildTrust?: typeof loadWorldFfmpegBuildTrust
  readonly loadSupplyChain?: typeof loadWorldFfmpegSupplyChain
  readonly resolveRuntime?: typeof resolvePackagedWorldFfmpegRuntime
  readonly validateBuildReport?: typeof validateWorldFfmpegBuildReport
  readonly supplyChainBytes?: Buffer
  readonly packageSnapshot?: PackageSnapshot
}

export async function verifyWorldFfmpegPackage(
  request: VerifyRequest,
  dependencies: VerifyDependencies = {},
): Promise<WorldFfmpegPackageVerificationReceipt> {
  const resourcesPath = request.resourcesPath ?? RESOURCES_PATH
  const suppliedSnapshot = dependencies.packageSnapshot
    ? requirePackageSnapshot(dependencies.packageSnapshot)
    : null
  const snapshotAuthority = requireSnapshotAuthority(request, suppliedSnapshot !== null)
  const target = worldFfmpegTargetFor(request.platform, request.arch)
  if (!target) throw new Error('unsupported-target')
  if (suppliedSnapshot && suppliedSnapshot.target !== target) throw new Error('package-snapshot-target-invalid')
  const outputCustody = dependencies.outputCustody ?? runWorldFfmpegOutputCustody
  const resolveRuntime = dependencies.resolveRuntime ?? resolvePackagedWorldFfmpegRuntime
  const validateBuildReport = dependencies.validateBuildReport ?? validateWorldFfmpegBuildReport
  const trust = await (dependencies.loadBuildTrust ?? loadWorldFfmpegBuildTrust)(request.trustFile)
  const contract = await (dependencies.loadSupplyChain ?? loadWorldFfmpegSupplyChain)()
  const distributionFiles = packagedDistributionSnapshotFiles(contract)
  const manifestPlanReceipt = suppliedSnapshot
    ? requireSnapshotFile(suppliedSnapshot, ['ffmpeg', target], 'manifest.json')
    : await outputCustody({
        operation: 'read',
        directory: resolve(resourcesPath),
        expectedDirectoryIdentity: request.resourcesIdentity ?? undefined,
        segments: ['ffmpeg', target],
        name: 'manifest.json',
        maximumBytes: 256 * 1024,
        environment: process.env,
      })
  if (!manifestPlanReceipt.file || typeof manifestPlanReceipt.bytesBase64 !== 'string') {
    throw new Error('package-snapshot-plan-invalid')
  }
  const runtimePlan = planPackagedWorldFfmpegRuntimeSnapshot(
    Buffer.from(manifestPlanReceipt.bytesBase64, 'base64'),
    target,
  )
  const runtimeHashFiles = runtimePlan.map(({ path, maximumBytes }) => {
    const segments = path.split('/')
    return {
      segments: ['ffmpeg', target, ...segments.slice(0, -1)],
      name: segments.at(-1)!,
      maximumBytes,
    }
  })
  const snapshot = suppliedSnapshot ?? await outputCustody({
    operation: 'snapshot',
    directory: resolve(resourcesPath),
    expectedDirectoryIdentity: request.resourcesIdentity,
    files: [
      { segments: ['ffmpeg', target], name: 'manifest.json', maximumBytes: 256 * 1024 },
      { segments: ['ffmpeg', target], name: 'manifest.sig', maximumBytes: 64 },
      { segments: ['world-ffmpeg-build-reports'], name: `${target}.json`, maximumBytes: 1024 * 1024 },
      ...distributionFiles.map(({ segments, name }) => ({ segments, name, maximumBytes: 2 * 1024 * 1024 })),
    ],
    hashFiles: runtimeHashFiles,
    directories: [
      { segments: ['ffmpeg'] },
      { segments: ['world-ffmpeg-build-reports'] },
      { segments: ['licenses', 'world-ffmpeg-7.1.1'] },
      { segments: ['ffmpeg', target] },
      { segments: ['ffmpeg', target, 'bin'] },
    ],
    environment: process.env,
  })
  if (!suppliedSnapshot && request.resourcesIdentity
    && (!('rootIdentity' in snapshot) || !sameWorldFfmpegOutputDirectoryIdentity(
      snapshot.rootIdentity,
      request.resourcesIdentity,
    ))) throw new Error('resources-root-invalid')
  const manifestSnapshot = requireSnapshotFile(snapshot, ['ffmpeg', target], 'manifest.json')
  const signatureSnapshot = requireSnapshotFile(snapshot, ['ffmpeg', target], 'manifest.sig')
  const reportSnapshot = requireSnapshotFile(
    snapshot,
    ['world-ffmpeg-build-reports'],
    `${target}.json`,
  )
  const manifestBytes = Buffer.from(manifestSnapshot.bytesBase64, 'base64')
  const signatureBytes = Buffer.from(signatureSnapshot.bytesBase64, 'base64')
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  const ffmpegRoot = requireSnapshotDirectory(snapshot, ['ffmpeg'])
  const runtimeRoot = requireSnapshotDirectory(snapshot, ['ffmpeg', target])
  const runtimeBin = requireSnapshotDirectory(snapshot, ['ffmpeg', target, 'bin'])
  const runtimeFiles = runtimePlan.map(({ path }) => {
    const segments = path.split('/')
    const entry = requireSnapshotHashFile(
      snapshot,
      ['ffmpeg', target, ...segments.slice(0, -1)],
      segments.at(-1)!,
    )
    return Object.freeze({
      path,
      size: entry.file.size,
      sha256: entry.file.sha256,
      mode: target === 'win32-x64' ? null : entry.mode,
    })
  })
  const result: WorldFfmpegRuntimeResolution = await resolveRuntime({
    resourcesPath,
    platform: request.platform,
    arch: request.arch,
    trustedManifestKeys: trust.keys,
    snapshot: {
      manifestBytes,
      signatureBytes,
      ffmpegRootMode: target === 'win32-x64' ? null : ffmpegRoot.mode,
      rootMode: target === 'win32-x64' ? null : runtimeRoot.mode,
      binMode: target === 'win32-x64' ? null : runtimeBin.mode,
      manifestMode: target === 'win32-x64' ? null : manifestSnapshot.mode,
      signatureMode: target === 'win32-x64' ? null : signatureSnapshot.mode,
      rootEntries: runtimeRoot.entries.map(({ name }) => name),
      binEntries: runtimeBin.entries.map(({ name }) => name),
      files: runtimeFiles,
    },
  })
  if (!result.ok) throw new Error(result.code)
  if (result.runtime.ffmpegVersion !== WORLD_FFMPEG_VERSION
    || result.runtime.target !== target
    || result.runtime.manifestSha256 !== manifestSha256) throw new Error('bundle-invalid')
  const supplyChainBytes = dependencies.supplyChainBytes
    ?? await readFile(join(REPOSITORY_ROOT, 'resources', 'ffmpeg', 'supply-chain.v1.json'))
  const emittedReportBytes = Buffer.from(reportSnapshot.bytesBase64, 'base64')
  let reportBytes = emittedReportBytes
  let verifiedSnapshotReceipt: OutputFileReceipt | null = null
  if (snapshotAuthority) {
    const reportAuthority = await outputCustody({
      operation: 'read',
      directory: snapshotAuthority.directory,
      expectedDirectoryIdentity: snapshotAuthority.directoryIdentity,
      segments: [],
      name: snapshotAuthority.name,
      maximumBytes: 1024 * 1024,
      environment: process.env,
    })
    if (!reportAuthority.file || typeof reportAuthority.bytesBase64 !== 'string'
      || !sameWorldFfmpegOutputFileReceipt(reportAuthority.file, snapshotAuthority.receipt)) {
      throw new Error('build-report-snapshot-invalid')
    }
    const authorityBytes = Buffer.from(reportAuthority.bytesBase64, 'base64')
    if (!authorityBytes.equals(emittedReportBytes)) {
      throw new Error('build-report-snapshot-mismatch')
    }
    reportBytes = authorityBytes
    verifiedSnapshotReceipt = reportAuthority.file
  }
  let report: unknown
  try { report = JSON.parse(reportBytes.toString('utf8')) } catch { throw new Error('build-report-invalid') }
  if (!reportBytes.equals(Buffer.from(`${JSON.stringify(report)}\n`))
    || !validateBuildReport(report, {
      target,
      supplyChainBytes,
      manifestBytes,
      signatureBytes,
      trustBytes: trust.bytes,
      signingKeyId: result.runtime.signingKeyId,
    })) throw new Error('build-report-invalid')
  if (!sameDirectoryEntries(snapshot, ['ffmpeg'], [{ name: target, kind: 'directory' }])
    || !sameDirectoryEntries(snapshot, ['world-ffmpeg-build-reports'], [{ name: `${target}.json`, kind: 'file' }])) {
    throw new Error('bundle-root-invalid')
  }
  const expectedLicenseNames = distributionFiles
    .filter(({ segments }) => sameArray(segments, ['licenses', 'world-ffmpeg-7.1.1']))
    .map(({ name }) => ({ name, kind: 'file' as const }))
    .sort((left, right) => codeUnitCompare(left.name, right.name))
  if (!sameDirectoryEntries(snapshot, ['licenses', 'world-ffmpeg-7.1.1'], expectedLicenseNames)) {
    throw new Error('distribution-tree-invalid:licenses/world-ffmpeg-7.1.1')
  }
  for (const distribution of distributionFiles) {
    const file = requireSnapshotFile(snapshot, distribution.segments, distribution.name).file
    if (file.sha256 !== distribution.sha256) {
      throw new Error(`distribution-file-invalid:${[...distribution.segments, distribution.name].join('/')}`)
    }
  }
  return Object.freeze({
    buildReportReceipt: verifiedSnapshotReceipt,
    runtimeManifestSha256: manifestSha256,
  })
}

interface SnapshotFileAuthority {
  readonly name: string
  readonly size: number
  readonly sha256: string
}

interface SnapshotFileEntry {
  readonly segments: readonly string[]
  readonly file: SnapshotFileAuthority
  readonly mode: number
  readonly bytesBase64: string
}

interface SnapshotHashFileEntry {
  readonly segments: readonly string[]
  readonly file: SnapshotFileAuthority
  readonly mode: number
}

interface SnapshotDirectoryEntry {
  readonly segments: readonly string[]
  readonly mode: number
  readonly entries: readonly Readonly<{ name: string; kind: 'file' | 'directory' }>[]
}

interface PackageSnapshot {
  readonly source: 'retained-portable-zip'
  readonly target: string
  readonly files: readonly SnapshotFileEntry[]
  readonly hashFiles: readonly SnapshotHashFileEntry[]
  readonly directories: readonly SnapshotDirectoryEntry[]
}

function requirePackageSnapshot(value: PackageSnapshot): PackageSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.source !== 'retained-portable-zip' || typeof value.target !== 'string'
    || !Array.isArray(value.files) || !Array.isArray(value.hashFiles)
    || !Array.isArray(value.directories)) {
    throw new Error('World FFmpeg retained package snapshot authority is invalid.')
  }
  return value
}

function packagedDistributionSnapshotFiles(contract: Awaited<ReturnType<typeof loadWorldFfmpegSupplyChain>>): readonly Readonly<{
  segments: readonly string[]
  name: string
  sha256: string
}>[] {
  const licensePrefix = 'resources/licenses/world-ffmpeg-7.1.1/'
  return Object.freeze(contract.distributionFiles.map((entry) => {
    if (entry.path === 'THIRD_PARTY_NOTICES.md') {
      return Object.freeze({ segments: Object.freeze([]), name: entry.path, sha256: entry.sha256 })
    }
    if (!entry.path.startsWith(licensePrefix)) throw new Error('distribution-file-invalid')
    const name = entry.path.slice(licensePrefix.length)
    if (!validDirectName(name)) throw new Error('distribution-file-invalid')
    return Object.freeze({
      segments: Object.freeze(['licenses', 'world-ffmpeg-7.1.1']),
      name,
      sha256: entry.sha256,
    })
  }))
}

function requireSnapshotFile(
  snapshot: Readonly<{ files?: readonly SnapshotFileEntry[] }>,
  segments: readonly string[],
  name: string,
): SnapshotFileEntry {
  const matches = (snapshot.files ?? []).filter((entry) => (
    entry.file.name === name && sameArray(entry.segments, segments)
  ))
  if (matches.length !== 1) throw new Error('package-snapshot-invalid')
  return matches[0]
}

function requireSnapshotHashFile(
  snapshot: Readonly<{ hashFiles?: readonly SnapshotHashFileEntry[] }>,
  segments: readonly string[],
  name: string,
): SnapshotHashFileEntry {
  const matches = (snapshot.hashFiles ?? []).filter((entry) => (
    entry.file.name === name && sameArray(entry.segments, segments)
  ))
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].mode)
    || matches[0].mode < 0 || matches[0].mode > 0o7777) {
    throw new Error('package-runtime-snapshot-invalid')
  }
  return matches[0]
}

function requireSnapshotDirectory(
  snapshot: Readonly<{ directories?: readonly SnapshotDirectoryEntry[] }>,
  segments: readonly string[],
): SnapshotDirectoryEntry {
  const matches = (snapshot.directories ?? []).filter((entry) => sameArray(entry.segments, segments))
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].mode)
    || matches[0].mode < 0 || matches[0].mode > 0o7777) {
    throw new Error('package-runtime-snapshot-invalid')
  }
  return matches[0]
}

function sameDirectoryEntries(
  snapshot: Readonly<{ directories?: readonly SnapshotDirectoryEntry[] }>,
  segments: readonly string[],
  expected: readonly Readonly<{ name: string; kind: 'file' | 'directory' }>[],
): boolean {
  const matches = (snapshot.directories ?? []).filter((entry) => sameArray(entry.segments, segments))
  if (matches.length !== 1 || matches[0].entries.length !== expected.length) return false
  return matches[0].entries.every((entry, index) => (
    entry.name === expected[index]?.name && entry.kind === expected[index]?.kind
  ))
}

export function parseWorldFfmpegPackageArguments(argv: readonly string[]): VerifyRequest {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || values.has(key)) throw usage()
    values.set(key, value)
  }
  const snapshotArguments = [
    '--resources-identity',
    '--build-report-directory',
    '--build-report-directory-identity',
    '--build-report-name',
    '--build-report-receipt',
  ]
  const allowed = new Set(['--resources', '--platform', '--arch', '--trust-file', ...snapshotArguments])
  if ([...values.keys()].some((key) => !allowed.has(key))
    || !values.has('--platform') || !values.has('--arch') || !values.has('--trust-file')) throw usage()
  const platform = values.get('--platform')
  const arch = values.get('--arch')
  if ((platform !== 'linux' && platform !== 'darwin' && platform !== 'win32')
    || (arch !== 'x64' && arch !== 'arm64')) {
    throw new Error('Unsupported FFmpeg package target.')
  }
  const trustFileValue = values.get('--trust-file')
  if (!trustFileValue || !isAbsolute(trustFileValue) || trustFileValue.includes('\0')) throw usage()
  const resourcesValue = values.get('--resources')
  if (resourcesValue !== undefined && (!isAbsolute(resourcesValue) || resourcesValue.includes('\0'))) throw usage()
  const snapshotCount = snapshotArguments.filter((name) => values.has(name)).length
  if (snapshotCount !== 0 && snapshotCount !== snapshotArguments.length) throw usage()
  const baseRequest: VerifyRequest = {
    platform, arch, trustFile: resolve(trustFileValue),
    ...(resourcesValue ? { resourcesPath: resolve(resourcesValue) } : {}),
  }
  let request = baseRequest
  if (snapshotCount === snapshotArguments.length) {
    const directory = values.get('--build-report-directory')
    const name = values.get('--build-report-name')
    if (!directory || !isAbsolute(directory) || directory.includes('\0')
      || !name || !validDirectName(name)) throw usage()
    const resourcesIdentity = decodeAuthorityArgument<OutputDirectoryIdentity>(
      values.get('--resources-identity'),
      validateDirectoryIdentity,
    )
    const buildReportDirectoryIdentity = decodeAuthorityArgument<OutputDirectoryIdentity>(
      values.get('--build-report-directory-identity'),
      validateDirectoryIdentity,
    )
    const buildReportReceipt = decodeAuthorityArgument<OutputFileReceipt>(
      values.get('--build-report-receipt'),
      validateWorldFfmpegOutputFileReceipt,
    )
    request = {
      ...baseRequest,
      resourcesIdentity,
      buildReportDirectory: resolve(directory),
      buildReportDirectoryIdentity,
      buildReportName: name,
      buildReportReceipt,
    }
  }
  requireSnapshotAuthority(request)
  return request
}

function requireSnapshotAuthority(request: VerifyRequest, retainedPackageSnapshot = false): Readonly<{
  directory: string
  directoryIdentity: OutputDirectoryIdentity
  name: string
  receipt: OutputFileReceipt
}> | null {
  const values = [
    request.resourcesIdentity,
    request.buildReportDirectory,
    request.buildReportDirectoryIdentity,
    request.buildReportName,
    request.buildReportReceipt,
  ]
  if (values.every((value) => value === undefined)) return null
  if (!request.resourcesPath || (!retainedPackageSnapshot && !request.resourcesIdentity)
    || !request.buildReportDirectory || !isAbsolute(request.buildReportDirectory)
    || !request.buildReportDirectoryIdentity || !request.buildReportName
    || !validDirectName(request.buildReportName) || !request.buildReportReceipt
    || !sameWorldFfmpegOutputFileReceipt(request.buildReportReceipt, request.buildReportReceipt)
    || request.buildReportReceipt.name !== request.buildReportName) {
    throw new Error('World FFmpeg build-report snapshot authority is invalid.')
  }
  return Object.freeze({
    directory: request.buildReportDirectory,
    directoryIdentity: request.buildReportDirectoryIdentity,
    name: request.buildReportName,
    receipt: request.buildReportReceipt,
  })
}

function decodeAuthorityArgument<T>(
  value: string | undefined,
  validate: (candidate: unknown) => boolean,
): T {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw usage()
  let parsed: unknown
  try {
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') !== value) throw usage()
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch { throw usage() }
  if (!validate(parsed)) throw usage()
  return parsed as T
}

function validateDirectoryIdentity(value: unknown): value is OutputDirectoryIdentity {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === 2
    && typeof (value as { dev?: unknown }).dev === 'string'
    && /^[0-9]{1,40}$/.test((value as { dev: string }).dev)
    && typeof (value as { ino?: unknown }).ino === 'string'
    && /^[1-9][0-9]{0,39}$/.test((value as { ino: string }).ino)
}

function validDirectName(value: string): boolean {
  return value.length >= 1 && value.length <= 255 && value !== '.' && value !== '..'
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0') && !/[\r\n]/.test(value)
}

export function assertWorldFfmpegPackageVerifierAuthority(
  execArgv: readonly string[] = process.execArgv,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  runtime: Readonly<{
    platform: string
    arch: string
    execPath: string
    electronVersion: string | undefined
  }> = {
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    electronVersion: process.versions.electron,
  },
): void {
  const expectedExecArgv = [
    `--require=${DENY_NETWORK_PRELOAD}`,
    '--no-warnings',
    '--experimental-strip-types',
  ]
  if (!sameArray(execArgv, expectedExecArgv)) {
    throw new Error('World FFmpeg verifier Node authority has invalid execArgv.')
  }
  const isWindows = runtime.platform === 'win32'
  const expectedKeys = isWindows
    ? [...VERIFIER_ENVIRONMENT_KEYS, 'COMSPEC', 'PATHEXT', 'SystemRoot', 'WINDIR']
    : [...VERIFIER_ENVIRONMENT_KEYS]
  const index = new Map<string, string | undefined>()
  for (const key of Object.keys(environment)) {
    const identity = isWindows ? key.toLowerCase() : key
    if (index.has(identity)) {
      throw new Error('World FFmpeg verifier environment contains duplicate authority.')
    }
    index.set(identity, environment[key])
  }
  const expectedIdentities = expectedKeys
    .map((key) => isWindows ? key.toLowerCase() : key)
    .sort(codeUnitCompare)
  if (!sameArray([...index.keys()].sort(codeUnitCompare), expectedIdentities)) {
    throw new Error('World FFmpeg verifier environment authority is invalid.')
  }
  const value = (key: string): string | undefined => index.get(isWindows ? key.toLowerCase() : key)
  if (value('LANG') !== 'C'
    || value('LC_ALL') !== 'C'
    || value('TZ') !== 'UTC'
    || value('ELECTRON_RUN_AS_NODE') !== '1'
    || value('NODE_OPTIONS') !== `--require=${DENY_NETWORK_PRELOAD}`
    || value('WORLD_FFMPEG_PACKAGE_NETWORK') !== 'denied'
    || value('WORLD_FFMPEG_VERIFIER_AUTHORITY') !== VERIFIER_AUTHORITY) {
    throw new Error('World FFmpeg verifier environment authority is invalid.')
  }
  if (isWindows) {
    const systemRoot = requireCanonicalWindowsSystemRoot(environment)
    if (value('PATH')?.toLowerCase() !== `${systemRoot}\\System32;${systemRoot}`.toLowerCase()
      || value('COMSPEC')?.toLowerCase() !== `${systemRoot}\\System32\\cmd.exe`.toLowerCase()
      || value('PATHEXT') !== '.COM;.EXE;.BAT;.CMD') {
      throw new Error('World FFmpeg verifier Windows environment authority is invalid.')
    }
  } else if (value('PATH') !== '/usr/bin:/bin') {
    throw new Error('World FFmpeg verifier environment PATH authority is invalid.')
  }
  const target = runtime.platform === 'linux' && runtime.arch === 'arm64'
    ? 'linux-arm64'
    : runtime.platform === 'linux' && runtime.arch === 'x64'
      ? 'linux-x64'
    : runtime.platform === 'darwin' && runtime.arch === 'arm64'
      ? 'darwin-arm64'
      : runtime.platform === 'win32' && runtime.arch === 'x64'
        ? 'win32-x64'
        : null
  const bootstrapExecutable = value('WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE')
  const sameExecutable = isWindows
    ? typeof bootstrapExecutable === 'string'
      && win32.normalize(bootstrapExecutable).toLowerCase() === win32.normalize(runtime.execPath).toLowerCase()
    : bootstrapExecutable === resolve(runtime.execPath)
  if (target === null || runtime.electronVersion !== '44.1.1' || !sameExecutable) {
    throw new Error('World FFmpeg verifier Electron runtime authority is invalid.')
  }
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function usage(): Error {
  return new Error('Usage: verify-world-ffmpeg-package.ts [--resources <absolute-packaged-resources>] --platform <linux|darwin|win32> --arch <x64|arm64> --trust-file <absolute-trusted-keys-json>')
}

async function main(): Promise<void> {
  if (process.env.WORLD_FFMPEG_VERIFIER_AUTHORITY !== undefined
    || process.env.WORLD_FFMPEG_PACKAGE_NETWORK !== undefined) {
    assertWorldFfmpegPackageVerifierAuthority()
  }
  const request = parseWorldFfmpegPackageArguments(process.argv.slice(2))
  const verification = await verifyWorldFfmpegPackage(request)
  if (verification.buildReportReceipt) {
    process.stdout.write(`${JSON.stringify({
      schema: 'modly.world-ffmpeg-verifier-receipt.v1',
      buildReportReceipt: verification.buildReportReceipt,
      runtimeManifestSha256: verification.runtimeManifestSha256,
    })}\n`)
  } else {
    process.stdout.write(`Verified audited FFmpeg ${WORLD_FFMPEG_VERSION} bundle for ${request.platform}-${request.arch}.\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'verification-error'}\n`)
    process.exitCode = 1
  })
}
