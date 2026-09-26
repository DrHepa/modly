import { createHash, sign, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { syncWorldFfmpegDirectory } from './world-ffmpeg-durability.mjs'

const RUNTIME_SCHEMA = 'modly.ffmpeg-runtime.v1'
const EXPECTED_TARGETS = Object.freeze(['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'])
const MAX_LICENSE_BYTES = 2 * 1024 * 1024
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024
const MAX_LIBRARY_BYTES = 128 * 1024 * 1024
const MAX_LIBRARY_TOTAL_BYTES = 768 * 1024 * 1024
const MAX_LIBRARY_COUNT = 128
const POSIX_DIRECTORY_MODE = 0o755
const POSIX_METADATA_MODE = 0o644
const POSIX_EXECUTABLE_MODE = 0o755
const POSIX_LIBRARY_MODE = 0o644

export async function assembleWorldFfmpegRuntime(input) {
  const target = requireTarget(input?.target)
  const supplyChain = input?.supplyChain
  if (!supplyChain || supplyChain.ffmpegVersion !== '7.1.1' || !supplyChain.targets?.includes(target)) {
    throw new Error('World FFmpeg assembly supply-chain identity is invalid.')
  }
  const bundleRoot = resolve(requireString(input.bundleRoot, 'bundle root'))
  if (basename(bundleRoot) !== target || basename(dirname(bundleRoot)) !== 'ffmpeg') {
    throw new Error('World FFmpeg assembly target path is invalid.')
  }
  const signingKeyId = requireSigningKeyId(input.signingKeyId)
  assertSigningAuthority(signingKeyId, input.privateKey, input.trustedManifestKeys)
  if (typeof input.probe !== 'function' || typeof input.inspectBinary !== 'function') {
    throw new Error('World FFmpeg assembly audit functions are required.')
  }

  const windows = target === 'win32-x64'
  const expectedDirectoryMode = windows ? null : POSIX_DIRECTORY_MODE
  await assertDirectory(dirname(bundleRoot), expectedDirectoryMode)
  await assertDirectory(bundleRoot, expectedDirectoryMode)
  const binPath = join(bundleRoot, 'bin')
  await assertDirectory(binPath, expectedDirectoryMode)
  await assertExactEntries(bundleRoot, ['LICENSE.txt', 'bin'])

  const executableName = windows ? 'ffmpeg.exe' : 'ffmpeg'
  const binEntries = (await readdir(binPath)).sort(codeUnitCompare)
  if (!binEntries.includes(executableName) || binEntries.length < 2 || binEntries.length > MAX_LIBRARY_COUNT + 1) {
    throw new Error('World FFmpeg assembly binary closure is invalid.')
  }
  const libraryNames = binEntries.filter((entry) => entry !== executableName)
  if (libraryNames.some((entry) => !isSharedLibraryName(entry, target))) {
    throw new Error('World FFmpeg assembly contains a non-library binary entry.')
  }

  const license = await inspectFile(join(bundleRoot, 'LICENSE.txt'), MAX_LICENSE_BYTES, windows ? null : POSIX_METADATA_MODE)
  const licenseText = license.bytes.toString('utf8')
  for (const marker of ['GNU LESSER GENERAL PUBLIC LICENSE', 'FFmpeg 7.1.1', 'libvpx 1.15.2', 'libopus 1.5.2', 'zlib 1.3.2']) {
    if (!licenseText.includes(marker)) throw new Error('World FFmpeg assembly license closure is invalid.')
  }
  const executablePath = join(binPath, executableName)
  const executable = await inspectFile(executablePath, MAX_EXECUTABLE_BYTES, windows ? null : POSIX_EXECUTABLE_MODE)
  const libraries = []
  let libraryBytes = 0
  for (const name of libraryNames) {
    const entry = await inspectFile(join(binPath, name), MAX_LIBRARY_BYTES, windows ? null : POSIX_LIBRARY_MODE)
    libraryBytes += entry.size
    if (libraryBytes > MAX_LIBRARY_TOTAL_BYTES) throw new Error('World FFmpeg assembly libraries exceed their total bound.')
    libraries.push({ name, ...entry })
  }

  const probe = await input.probe(executablePath, Object.freeze({ target, supplyChain }))
  assertExactProbe(probe, supplyChain)
  await assertDynamicClosure({
    target,
    executablePath,
    executableName,
    libraries,
    contract: supplyChain.dynamicClosure[target],
    inspectBinary: input.inspectBinary,
  })

  // Re-observe every audited input immediately before publication. Assembly is
  // deliberately no-overwrite: a partially or previously signed tree cannot be
  // silently blessed as a new release.
  await assertUnchanged(license)
  await assertUnchanged(executable)
  for (const library of libraries) await assertUnchanged(library)
  await assertExactEntries(bundleRoot, ['LICENSE.txt', 'bin'])
  await assertExactEntries(binPath, binEntries)

  const mode = (value) => windows ? null : value
  const manifest = {
    schema: RUNTIME_SCHEMA,
    target,
    ffmpegVersion: '7.1.1',
    signingKeyId,
    build: supplyChain.build,
    directories: [
      { path: '.', mode: mode(POSIX_DIRECTORY_MODE) },
      { path: 'bin', mode: mode(POSIX_DIRECTORY_MODE) },
    ],
    license: manifestFile('LICENSE.txt', license, mode(POSIX_METADATA_MODE)),
    executable: manifestFile(`bin/${executableName}`, executable, mode(POSIX_EXECUTABLE_MODE)),
    sharedLibraries: libraries.map((entry) => manifestFile(`bin/${entry.name}`, entry, mode(POSIX_LIBRARY_MODE))),
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  const signatureBytes = sign(null, manifestBytes, input.privateKey)
  if (signatureBytes.byteLength !== 64 || !verify(null, manifestBytes, ownKey(input.trustedManifestKeys, signingKeyId), signatureBytes)) {
    throw new Error('World FFmpeg assembly manifest signature is invalid.')
  }

  const manifestPath = join(bundleRoot, 'manifest.json')
  const signaturePath = join(bundleRoot, 'manifest.sig')
  let manifestCreated = false
  let signatureCreated = false
  try {
    await writeExclusiveFile(manifestPath, manifestBytes, windows ? undefined : POSIX_METADATA_MODE)
    manifestCreated = true
    await writeExclusiveFile(signaturePath, signatureBytes, windows ? undefined : POSIX_METADATA_MODE)
    signatureCreated = true
    await syncWorldFfmpegDirectory(bundleRoot, input.durability)
    await assertExactEntries(bundleRoot, ['LICENSE.txt', 'bin', 'manifest.json', 'manifest.sig'])
  } catch (error) {
    await Promise.allSettled([
      ...(manifestCreated ? [rm(manifestPath, { force: true })] : []),
      ...(signatureCreated ? [rm(signaturePath, { force: true })] : []),
    ])
    await syncWorldFfmpegDirectory(bundleRoot, input.durability).catch(() => undefined)
    throw error
  }
  return manifest
}

async function assertDynamicClosure(input) {
  const allowedNames = new Set(input.libraries.map((entry) => entry.name))
  const graph = new Map()
  for (const [name, path] of [
    [input.executableName, input.executablePath],
    ...input.libraries.map((entry) => [entry.name, entry.path]),
  ]) {
    const audit = exactAudit(await input.inspectBinary(path, Object.freeze({ target: input.target, bundledNames: [...allowedNames] })), input.target)
    if (!audit || !exactArray(audit.loaderSearch, input.contract.loaderSearch)) {
      throw new Error('World FFmpeg dynamic library closure has an invalid loader search path.')
    }
    if (input.target === 'linux-arm64') {
      if (input.contract.glibcBaseline?.distribution !== 'Ubuntu 24.04'
        || input.contract.glibcBaseline.version !== '2.39'
        || audit.requiredGlibcVersions.some((version) => {
          const [major, minor] = version.split('.').map(Number)
          return major > 2 || (major === 2 && minor > 39)
        })) {
        throw new Error('World FFmpeg dynamic library closure exceeds the declared GLIBC baseline.')
      }
    }
    if (name === input.executableName) {
      const exactInterpreter = input.contract.systemInterpreters.length === 0
        ? audit.systemInterpreter === null
        : input.contract.systemInterpreters.includes(audit.systemInterpreter)
      if (!exactInterpreter) {
        throw new Error('World FFmpeg dynamic library closure has an invalid system interpreter.')
      }
    } else if (audit.systemInterpreter !== null) {
      throw new Error('World FFmpeg shared library unexpectedly declares a system interpreter.')
    }
    for (const dependency of audit.bundledDependencies) {
      if (!allowedNames.has(dependency)) throw new Error('World FFmpeg dynamic library closure references an undeclared library.')
    }
    for (const dependency of audit.systemDependencies) {
      const normalizedDependency = input.target === 'win32-x64' ? dependency.toLowerCase() : dependency
      const systemLibraryAllowed = input.contract.systemLibraries.some((entry) => (
        input.target === 'win32-x64' ? entry.toLowerCase() : entry
      ) === normalizedDependency)
      const systemPrefixAllowed = input.contract.systemPrefixes.some((prefix) => normalizedDependency.startsWith(
        input.target === 'win32-x64' ? prefix.toLowerCase() : prefix,
      ))
      if (!systemLibraryAllowed && !systemPrefixAllowed) {
        throw new Error('World FFmpeg dynamic library closure references an unaudited system library.')
      }
    }
    graph.set(name, audit.bundledDependencies)
  }
  const reached = new Set()
  const queue = [...(graph.get(input.executableName) ?? [])]
  while (queue.length > 0) {
    const name = queue.shift()
    if (reached.has(name)) continue
    reached.add(name)
    for (const nested of graph.get(name) ?? []) queue.push(nested)
  }
  if (reached.size !== allowedNames.size || [...allowedNames].some((name) => !reached.has(name))) {
    throw new Error('World FFmpeg dynamic library closure contains an unreachable library.')
  }
}

function exactAudit(value, target) {
  const keys = ['bundledDependencies', 'loaderSearch', 'systemDependencies', 'systemInterpreter']
  if (target === 'linux-arm64') keys.push('requiredGlibcVersions')
  if (!exactRecord(value, keys)) return null
  if (!isSortedUniqueStrings(value.bundledDependencies)
    || !isSortedUniqueStrings(value.loaderSearch)
    || !isSortedUniqueStrings(value.systemDependencies)
    || (target === 'linux-arm64' && (!isSortedUniqueStrings(value.requiredGlibcVersions)
      || value.requiredGlibcVersions.some((version) => !/^\d+\.\d+$/.test(version))))
    || (value.systemInterpreter !== null && typeof value.systemInterpreter !== 'string')) return null
  return value
}

function assertExactProbe(probe, supplyChain) {
  if (!exactRecord(probe, ['build', 'configuration', 'ffmpegVersion'])
    || probe.ffmpegVersion !== '7.1.1'
    || !exactArray(probe.configuration, supplyChain.ffmpegConfigure)
    || JSON.stringify(probe.build) !== JSON.stringify(supplyChain.build)) {
    throw new Error('World FFmpeg binary probe does not match the audited build contract.')
  }
}

function assertSigningAuthority(signingKeyId, privateKey, trustedManifestKeys) {
  const publicKey = ownKey(trustedManifestKeys, signingKeyId)
  if (!publicKey) throw new Error('World FFmpeg assembly requires a trusted release key.')
  try {
    const challenge = Buffer.from('modly-world-ffmpeg-release-key-v1')
    const signature = sign(null, challenge, privateKey)
    if (signature.byteLength !== 64 || !verify(null, challenge, publicKey, signature)) throw new Error('mismatch')
  } catch {
    throw new Error('World FFmpeg assembly private key does not match its trusted release key.')
  }
}

async function inspectFile(path, maximumBytes, expectedMode) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximumBytes) {
    throw new Error('World FFmpeg assembly input is not an ordinary bounded file.')
  }
  if (expectedMode !== null && (info.mode & 0o7777) !== expectedMode) {
    throw new Error('World FFmpeg assembly input mode is invalid.')
  }
  const bytes = await readFile(path)
  if (bytes.byteLength !== info.size) throw new Error('World FFmpeg assembly input changed while reading.')
  return {
    path,
    bytes,
    size: info.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    identity: observe(info),
    expectedMode,
  }
}

async function assertUnchanged(entry) {
  const info = await lstat(entry.path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || !sameObservation(entry.identity, observe(info))) {
    throw new Error('World FFmpeg assembly input changed before publication.')
  }
  if (entry.expectedMode !== null && (info.mode & 0o7777) !== entry.expectedMode) {
    throw new Error('World FFmpeg assembly input mode changed before publication.')
  }
}

async function assertDirectory(path, expectedMode) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('World FFmpeg assembly directory is invalid.')
  if (expectedMode !== null && (info.mode & 0o7777) !== expectedMode) {
    throw new Error('World FFmpeg assembly directory mode is invalid.')
  }
}

async function assertExactEntries(path, expected) {
  const entries = (await readdir(path)).sort(codeUnitCompare)
  if (!exactArray(entries, [...expected].sort(codeUnitCompare))) {
    throw new Error('World FFmpeg assembly tree contains undeclared entries.')
  }
}

async function writeExclusiveFile(path, bytes, mode) {
  let handle
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
    await handle.writeFile(bytes)
    if (mode !== undefined) await handle.chmod(mode)
    await handle.sync()
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined)
      await rm(path, { force: true }).catch(() => undefined)
    }
    throw error
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function manifestFile(path, entry, mode) {
  return { path, size: entry.size, sha256: entry.sha256, mode }
}

function ownKey(keys, keyId) {
  return keys && typeof keys === 'object' && Object.prototype.hasOwnProperty.call(keys, keyId)
    ? keys[keyId]
    : null
}

function requireTarget(value) {
  if (!EXPECTED_TARGETS.includes(value)) throw new Error('World FFmpeg assembly target is unsupported.')
  return value
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`World FFmpeg ${label} is invalid.`)
  return value
}

function requireSigningKeyId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('World FFmpeg assembly signing key id is invalid.')
  }
  return value
}

function isSharedLibraryName(name, target) {
  if (target === 'win32-x64') return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.dll$/i.test(name)
  if (target === 'darwin-arm64') return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.dylib$/.test(name)
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.so(?:\.\d{1,4})*$/.test(name)
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  return exactArray(Object.keys(value).sort(codeUnitCompare), [...keys].sort(codeUnitCompare))
}

function exactArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index])
}

function isSortedUniqueStrings(value) {
  if (!Array.isArray(value)) return false
  let previous = null
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || (previous !== null && entry <= previous)) return false
    previous = entry
  }
  return true
}

function observe(info) {
  return { dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

function sameObservation(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
