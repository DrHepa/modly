import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WORLD_FFMPEG_CANONICAL_SOURCE_ENTRIES,
  WORLD_FFMPEG_RELEASE_VERIFICATION_RECEIPT,
  validateWorldFfmpegReleaseVerificationReceipt,
} from './world-ffmpeg-release-material.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const SUPPLY_CHAIN_PATH = join(REPOSITORY_ROOT, 'resources', 'ffmpeg', 'supply-chain.v1.json')
const MAX_CONTRACT_BYTES = 256 * 1024
const EXPECTED_TARGETS = Object.freeze(['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'])
const EXPECTED_SOURCE_IDENTITIES = Object.freeze([
  Object.freeze({ name: 'ffmpeg', version: '7.1.1', archive: 'ffmpeg-7.1.1.tar.xz', url: 'https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz', sha256: '733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1', maximumBytes: 16_777_216, license: 'LGPL-2.1-or-later', integrityProvenance: 'locally-computed-plus-upstream-signature' }),
  Object.freeze({ name: 'libvpx', version: '1.15.2', archive: 'libvpx-1.15.2.tar.gz', url: 'https://codeload.github.com/webmproject/libvpx/tar.gz/refs/tags/v1.15.2', sha256: '26fcd3db88045dee380e581862a6ef106f49b74b6396ee95c2993a260b4636aa', maximumBytes: 8_388_608, license: 'BSD-3-Clause AND LicenseRef-WebM-Patent', integrityProvenance: 'locally-computed-cross-checked-tag-archive' }),
  Object.freeze({ name: 'opus', version: '1.5.2', archive: 'opus-1.5.2.tar.gz', url: 'https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz', sha256: '65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1', maximumBytes: 8_388_608, license: 'BSD-3-Clause', integrityProvenance: 'upstream-published' }),
  Object.freeze({ name: 'zlib', version: '1.3.2', archive: 'zlib-1.3.2.tar.gz', url: 'https://zlib.net/fossils/zlib-1.3.2.tar.gz', sha256: 'bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16', maximumBytes: 4_194_304, license: 'Zlib', integrityProvenance: 'upstream-published' }),
])
const EXPECTED_CONFIGURE = Object.freeze([
  '--disable-autodetect', '--disable-debug', '--disable-doc', '--disable-everything', '--disable-gpl',
  '--disable-network', '--disable-nonfree', '--disable-programs', '--disable-static', '--disable-version3',
  '--enable-decoder=pcm_s16le,png', '--enable-demuxer=image2pipe,pcm_s16le',
  '--enable-encoder=libopus,libvpx_vp9', '--enable-ffmpeg',
  '--enable-filter=aformat,aresample,format,interleave,scale,setpts,settb',
  '--enable-libopus', '--enable-libvpx', '--enable-muxer=webm', '--enable-parser=png', '--enable-pic',
  '--enable-protocol=fd,pipe', '--enable-shared', '--enable-zlib',
])
const EXPECTED_BUILD = Object.freeze({
  license: 'LGPL-2.1-or-later', linkage: 'shared', gpl: false, nonfree: false, version3: false,
  videoEncoders: ['libvpx-vp9'], audioEncoders: ['libopus'],
  decoders: ['pcm_s16le', 'png'], demuxers: ['image2pipe', 's16le'],
  filters: ['aformat', 'anull', 'aresample', 'atrim', 'crop', 'format', 'hflip', 'interleave', 'null', 'rotate', 'scale', 'setpts', 'settb', 'transpose', 'trim', 'vflip', 'abuffer', 'buffer', 'abuffersink', 'buffersink'],
  muxers: ['webm'], parsers: ['png'], protocols: ['fd', 'pipe'],
})
const EXPECTED_DYNAMIC_CLOSURE = Object.freeze({
  'darwin-arm64': { loaderSearch: ['@loader_path'], systemInterpreters: ['/usr/lib/dyld'], systemLibraries: [], systemPrefixes: ['/System/Library/Frameworks/', '/usr/lib/'] },
  'linux-arm64': { loaderSearch: ['$ORIGIN'], systemInterpreters: ['/lib/ld-linux-aarch64.so.1'], systemLibraries: ['ld-linux-aarch64.so.1', 'libc.so.6', 'libdl.so.2', 'libgcc_s.so.1', 'libm.so.6', 'libpthread.so.0', 'librt.so.1'], systemPrefixes: [], glibcBaseline: { distribution: 'Ubuntu 24.04', version: '2.39' } },
  'linux-x64': { loaderSearch: ['$ORIGIN'], systemInterpreters: ['/lib64/ld-linux-x86-64.so.2'], systemLibraries: ['ld-linux-x86-64.so.2', 'libc.so.6', 'libdl.so.2', 'libgcc_s.so.1', 'libm.so.6', 'libpthread.so.0', 'librt.so.1'], systemPrefixes: [] },
  'win32-x64': { loaderSearch: [], systemInterpreters: [], systemLibraries: ['ADVAPI32.dll', 'BCRYPT.dll', 'KERNEL32.dll', 'OLE32.dll', 'SHELL32.dll', 'USER32.dll', 'VCRUNTIME140.dll', 'WS2_32.dll', 'msvcrt.dll'], systemPrefixes: ['api-ms-win-', 'ext-ms-win-'] },
})
const EXPECTED_DISTRIBUTION_PATHS = Object.freeze([
  'THIRD_PARTY_NOTICES.md',
  'resources/licenses/world-ffmpeg-7.1.1/LGPL-2.1.txt',
  'resources/licenses/world-ffmpeg-7.1.1/SOURCE.md',
  'resources/licenses/world-ffmpeg-7.1.1/libvpx-LICENSE.txt',
  'resources/licenses/world-ffmpeg-7.1.1/libvpx-PATENTS.txt',
  'resources/licenses/world-ffmpeg-7.1.1/opus-COPYING.txt',
  'resources/licenses/world-ffmpeg-7.1.1/zlib-LICENSE.txt',
])

export async function loadWorldFfmpegSupplyChain(path = SUPPLY_CHAIN_PATH) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 2 || info.size > MAX_CONTRACT_BYTES) {
    throw new Error('World FFmpeg supply-chain contract is not an ordinary bounded file.')
  }
  const bytes = await readFile(path)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('World FFmpeg supply-chain contract is not valid JSON.') }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) {
    throw new Error('World FFmpeg supply-chain contract is not canonical JSON.')
  }
  validateWorldFfmpegSupplyChain(value)
  return deepFreeze(value)
}

export function validateWorldFfmpegSupplyChain(value) {
  const contract = exactRecord(value, [
    'schema', 'ffmpegVersion', 'targets', 'reproducibility', 'sources', 'ffmpegReleaseSignature',
    'ffmpegConfigure', 'build', 'dynamicClosure', 'distributionFiles',
  ])
  if (!contract || contract.schema !== 'modly.world-ffmpeg-supply-chain.v1'
    || contract.ffmpegVersion !== '7.1.1'
    || !exactArray(contract.targets, EXPECTED_TARGETS)
    || !exactArray(contract.ffmpegConfigure, EXPECTED_CONFIGURE)
    || JSON.stringify(contract.build) !== JSON.stringify(EXPECTED_BUILD)) {
    throw new Error('World FFmpeg supply-chain identity is invalid.')
  }
  const reproducibility = exactRecord(contract.reproducibility, [
    'claim', 'requiredMatchingBuilds', 'sourceDateEpoch',
  ])
  if (!reproducibility
    || reproducibility.claim !== 'unverified-until-two-independent-builds-match'
    || reproducibility.requiredMatchingBuilds !== 2
    || reproducibility.sourceDateEpoch !== 1740961320) {
    throw new Error('World FFmpeg reproducibility claim is invalid.')
  }
  if (!Array.isArray(contract.sources) || contract.sources.length !== EXPECTED_SOURCE_IDENTITIES.length) {
    throw new Error('World FFmpeg source closure is invalid.')
  }
  for (const [index, raw] of contract.sources.entries()) {
    const source = exactRecord(raw, [
      'name', 'version', 'archive', 'url', 'sha256', 'maximumBytes', 'license', 'integrityProvenance',
    ])
    const expected = EXPECTED_SOURCE_IDENTITIES[index]
    if (!source || !expected || JSON.stringify(source) !== JSON.stringify(expected)) {
      throw new Error('World FFmpeg source identity is invalid.')
    }
  }
  const signature = exactRecord(contract.ffmpegReleaseSignature, [
    'url', 'archive', 'keyUrl', 'keyArchive', 'fingerprint', 'maximumBytes', 'maximumKeyBytes',
  ])
  if (!signature || signature.url !== 'https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz.asc'
    || signature.archive !== 'ffmpeg-7.1.1.tar.xz.asc'
    || signature.keyUrl !== 'https://ffmpeg.org/ffmpeg-devel.asc'
    || signature.keyArchive !== 'ffmpeg-devel.asc'
    || signature.fingerprint !== 'FCF986EA15E6E293A5644F10B4322F04D67658D8'
    || signature.maximumBytes !== 4096 || signature.maximumKeyBytes !== 65536) {
    throw new Error('World FFmpeg release-signature contract is invalid.')
  }
  const closure = exactRecord(contract.dynamicClosure, EXPECTED_TARGETS)
  if (!closure) throw new Error('World FFmpeg dynamic closure is invalid.')
  for (const target of EXPECTED_TARGETS) {
    const entry = exactRecord(closure[target], [
      'loaderSearch', 'systemInterpreters', 'systemLibraries', 'systemPrefixes',
      ...(target === 'linux-arm64' ? ['glibcBaseline'] : []),
    ])
    if (!entry || !isSortedUniqueStringArray(entry.loaderSearch)
      || !isSortedUniqueStringArray(entry.systemInterpreters)
      || !isSortedUniqueStringArray(entry.systemLibraries)
      || !isSortedUniqueStringArray(entry.systemPrefixes)) {
      throw new Error('World FFmpeg dynamic closure is invalid.')
    }
    if (JSON.stringify(entry) !== JSON.stringify(EXPECTED_DYNAMIC_CLOSURE[target])) {
      throw new Error('World FFmpeg dynamic closure is invalid.')
    }
  }
  if (!Array.isArray(contract.distributionFiles) || contract.distributionFiles.length !== EXPECTED_DISTRIBUTION_PATHS.length) {
    throw new Error('World FFmpeg distribution-file closure is invalid.')
  }
  let previousPath = ''
  for (const [index, raw] of contract.distributionFiles.entries()) {
    const entry = exactRecord(raw, ['path', 'sha256'])
    if (!entry || typeof entry.path !== 'string' || !isSafeRepositoryPath(entry.path)
      || entry.path !== EXPECTED_DISTRIBUTION_PATHS[index]
      || entry.path <= previousPath || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('World FFmpeg distribution-file closure is invalid.')
    }
    previousPath = entry.path
  }
  return true
}

export function worldFfmpegTargetFor(platform, arch) {
  const candidate = `${platform}-${arch}`
  return EXPECTED_TARGETS.includes(candidate) ? candidate : null
}

export async function verifyWorldFfmpegSourceCache(cacheDirectory, contract, options = {}) {
  try {
    const mode = options.mode ?? 'acquisition'
    if (mode !== 'acquisition' && mode !== 'canonical') {
      return { ok: false, code: 'source-tree-invalid', source: null }
    }
    const root = resolve(cacheDirectory)
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) return { ok: false, code: 'source-tree-invalid', source: null }
    const expectedEntries = new Set(mode === 'acquisition'
      ? [
          ...contract.sources.map((source) => source.archive),
          contract.ffmpegReleaseSignature.archive,
          contract.ffmpegReleaseSignature.keyArchive,
        ]
      : WORLD_FFMPEG_CANONICAL_SOURCE_ENTRIES)
    const entries = await readdir(root)
    if (entries.some((entry) => !expectedEntries.has(entry))) {
      return { ok: false, code: 'source-tree-invalid', source: null }
    }
    for (const source of contract.sources) {
      const result = await verifyBoundedFile(join(root, source.archive), source.maximumBytes, source.sha256)
      if (result === 'missing') return { ok: false, code: 'source-missing', source: source.name }
      if (result !== 'valid') return { ok: false, code: 'source-invalid', source: source.name }
    }
    if (mode === 'acquisition') {
      for (const [name, filename, maximumBytes] of [
        ['ffmpeg-signature', contract.ffmpegReleaseSignature.archive, contract.ffmpegReleaseSignature.maximumBytes],
        ['ffmpeg-release-key', contract.ffmpegReleaseSignature.keyArchive, contract.ffmpegReleaseSignature.maximumKeyBytes],
      ]) {
        const result = await verifyBoundedFile(join(root, filename), maximumBytes, null)
        if (result === 'missing') return { ok: false, code: 'source-missing', source: name }
        if (result !== 'valid') return { ok: false, code: 'source-invalid', source: name }
      }
    } else {
      const receiptPath = join(root, WORLD_FFMPEG_RELEASE_VERIFICATION_RECEIPT)
      if (await verifyBoundedFile(receiptPath, 4096, null) !== 'valid') {
        return { ok: false, code: 'source-invalid', source: 'ffmpeg-release-verification' }
      }
      const receiptBytes = await readFile(receiptPath)
      let receipt
      try { receipt = JSON.parse(receiptBytes.toString('utf8')) } catch {
        return { ok: false, code: 'source-invalid', source: 'ffmpeg-release-verification' }
      }
      if (!receiptBytes.equals(Buffer.from(`${JSON.stringify(receipt)}\n`))
        || !validateWorldFfmpegReleaseVerificationReceipt(receipt, contract)) {
        return { ok: false, code: 'source-invalid', source: 'ffmpeg-release-verification' }
      }
    }
    if (entries.length !== expectedEntries.size) return { ok: false, code: 'source-tree-invalid', source: null }
    return { ok: true }
  } catch {
    return { ok: false, code: 'source-tree-invalid', source: null }
  }
}

export async function verifyWorldFfmpegDistributionFiles(contract, repositoryRoot = REPOSITORY_ROOT) {
  const root = resolve(repositoryRoot)
  for (const entry of contract.distributionFiles) {
    const path = resolve(root, entry.path)
    if (!isContained(root, path)) return { ok: false, code: 'distribution-file-invalid', path: entry.path }
    const result = await verifyBoundedFile(path, 2 * 1024 * 1024, entry.sha256)
    if (result !== 'valid') return { ok: false, code: 'distribution-file-invalid', path: entry.path }
  }
  return { ok: true }
}

export async function verifyWorldFfmpegPackagedDistributionFiles(contract, resourcesDirectory) {
  try {
    const root = resolve(resourcesDirectory)
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      return { ok: false, code: 'distribution-tree-invalid', path: null }
    }
    const licensePrefix = 'resources/licenses/world-ffmpeg-7.1.1/'
    const licenseRoot = join(root, 'licenses', 'world-ffmpeg-7.1.1')
    const expectedLicenseNames = contract.distributionFiles
      .filter((entry) => entry.path.startsWith(licensePrefix))
      .map((entry) => entry.path.slice(licensePrefix.length))
      .sort(codeUnitCompare)
    const licenseInfo = await lstat(licenseRoot)
    if (!licenseInfo.isDirectory() || licenseInfo.isSymbolicLink()
      || !exactArray((await readdir(licenseRoot)).sort(codeUnitCompare), expectedLicenseNames)) {
      return { ok: false, code: 'distribution-tree-invalid', path: 'licenses/world-ffmpeg-7.1.1' }
    }
    for (const entry of contract.distributionFiles) {
      const packagedPath = entry.path === 'THIRD_PARTY_NOTICES.md'
        ? entry.path
        : entry.path.startsWith(licensePrefix)
          ? `licenses/world-ffmpeg-7.1.1/${entry.path.slice(licensePrefix.length)}`
          : null
      if (!packagedPath) return { ok: false, code: 'distribution-file-invalid', path: entry.path }
      const path = resolve(root, packagedPath)
      if (!isContained(root, path)
        || await verifyBoundedFile(path, 2 * 1024 * 1024, entry.sha256) !== 'valid') {
        return { ok: false, code: 'distribution-file-invalid', path: packagedPath }
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, code: 'distribution-tree-invalid', path: null }
  }
}

export const WORLD_FFMPEG_REPOSITORY_ROOT = REPOSITORY_ROOT
export const WORLD_FFMPEG_SUPPLY_CHAIN_PATH = SUPPLY_CHAIN_PATH

async function verifyBoundedFile(path, maximumBytes, expectedSha256) {
  let handle
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximumBytes) return 'invalid'
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat()
    if (!sameFile(info, before) || !before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes) return 'invalid'
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.byteLength
      if (size > maximumBytes) return 'invalid'
      hash.update(chunk)
    }
    const after = await handle.stat()
    if (size !== before.size || !sameFile(before, after)) return 'invalid'
    if (expectedSha256 && hash.digest('hex') !== expectedSha256) return 'invalid'
    return 'valid'
  } catch (error) {
    return error && typeof error === 'object' && error.code === 'ENOENT' ? 'missing' : 'invalid'
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const actual = Object.keys(value).sort(codeUnitCompare)
  const expected = [...keys].sort(codeUnitCompare)
  return exactArray(actual, expected) ? value : null
}

function exactArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index])
}

function isSortedUniqueStringArray(value) {
  if (!Array.isArray(value)) return false
  let previous = ''
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || entry <= previous) return false
    previous = entry
  }
  return true
}

function isSafeRepositoryPath(value) {
  return !isAbsolute(value) && !value.includes('\\') && !value.includes('\0')
    && value !== '..' && !value.startsWith('../') && !value.includes('/../')
}

function isContained(root, candidate) {
  const suffix = relative(root, candidate)
  return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
