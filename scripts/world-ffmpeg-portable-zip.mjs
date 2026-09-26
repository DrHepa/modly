import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat, open, readdir,
} from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const DESCRIPTOR_SIGNATURE = 0x08074b50
const END_SIGNATURE = 0x06054b50
const UTF8_DATA_DESCRIPTOR_FLAGS = 0x0808
const STORED_METHOD = 0
const FIXED_DOS_TIME = 0
const FIXED_DOS_DATE = 0x0021
const MAX_ZIP32 = 0xffff_ff00
const MAX_ENTRIES = 65_535
const MAX_NAME_BYTES = 4_096
const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024 * 1024
const MAX_RETAINED_BYTES = 32 * 1024 * 1024
const CRC_TABLE = createCrcTable()

let cwdTail = Promise.resolve()

export async function createWorldFfmpegPortableZip(input) {
  const sourceDirectory = requireAbsoluteDirectory(input?.sourceDirectory, 'portable source')
  const outputDirectory = requireAbsoluteDirectory(input?.outputDirectory, 'portable output')
  const artifactName = requireDirectZipName(input?.artifactName)
  const rootName = requireDirectName(input?.rootName, 'portable root name')
  const sourceInfo = await lstat(sourceDirectory, { bigint: true })
  const outputInfo = await lstat(outputDirectory, { bigint: true })
  requireDirectory(sourceInfo, 'portable source')
  requireDirectory(outputInfo, 'portable output')
  requireExpectedIdentity(outputInfo, input?.outputIdentity, 'portable output')

  const artifact = await withCwd(outputDirectory, async () => {
    requireSameDirectory(await lstat('.', { bigint: true }), outputInfo, 'portable output')
    const handle = await open(
      artifactName,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    const identity = await handle.stat({ bigint: true })
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n || identity.size !== 0n) {
      await handle.close().catch(() => undefined)
      throw new Error('World FFmpeg portable ZIP output identity is invalid.')
    }
    return { handle, identity }
  })

  let primaryError
  try {
    const state = {
      writer: createWriter(artifact.handle),
      central: [],
      names: new Set(),
      extractedBytes: 0,
      rootName,
    }
    await withCwd(sourceDirectory, async () => {
      requireSameDirectory(await lstat('.', { bigint: true }), sourceInfo, 'portable source')
      await appendDirectory('.', [], state)
      requireSameDirectory(await lstat('.', { bigint: true }), sourceInfo, 'portable source')
    })
    if (state.central.length < 1) throw new Error('World FFmpeg portable ZIP source is empty.')
    const centralOffset = state.writer.position
    for (const entry of state.central) await state.writer.write(centralHeader(entry))
    const centralSize = state.writer.position - centralOffset
    if (centralSize < 1 || centralSize > MAX_ZIP32) {
      throw new Error('World FFmpeg portable ZIP central directory exceeded ZIP32 bounds.')
    }
    await state.writer.write(endRecord(state.central.length, centralSize, centralOffset))
    await artifact.handle.sync()
    const after = await artifact.handle.stat({ bigint: true })
    if (!sameOpenFileIdentity(artifact.identity, after) || after.size !== BigInt(state.writer.position)) {
      throw new Error('World FFmpeg portable ZIP output changed during publication.')
    }
    const sha256 = await hashHandle(artifact.handle, state.writer.position)
    const final = await artifact.handle.stat({ bigint: true })
    if (!sameStableFile(after, final)) throw new Error('World FFmpeg portable ZIP output changed during hashing.')
    const publicInfo = await lstat(join(outputDirectory, artifactName), { bigint: true })
    if (!sameStableFile(final, publicInfo)) throw new Error('World FFmpeg portable ZIP output path was replaced.')
    requireSameDirectory(await lstat(outputDirectory, { bigint: true }), outputInfo, 'portable output')
    return Object.freeze({
      path: join(outputDirectory, artifactName),
      name: artifactName,
      dev: String(final.dev),
      ino: String(final.ino),
      size: Number(final.size),
      sha256,
      entries: state.central.length,
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      await artifact.handle.close()
    } catch (error) {
      throw new AggregateError(
        primaryError ? [primaryError, error] : [error],
        'World FFmpeg portable ZIP descriptor release failed.',
      )
    }
  }
}

export async function snapshotWorldFfmpegPortableZip(input) {
  const handle = input?.artifactHandle
  const artifactSize = input?.artifactSize
  const rootName = requireDirectName(input?.rootName, 'portable root name')
  const target = requirePortableTarget(input?.target)
  if (!handle || typeof handle.read !== 'function' || typeof handle.stat !== 'function'
    || !Number.isSafeInteger(artifactSize) || artifactSize < 22 || artifactSize > MAX_ZIP32) {
    throw new Error('World FFmpeg portable ZIP input authority is invalid.')
  }
  const before = await handle.stat({ bigint: true })
  if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(artifactSize)) {
    throw new Error('World FFmpeg portable ZIP artifact identity is invalid.')
  }
  const end = await readExact(handle, artifactSize - 22, 22)
  if (end.readUInt32LE(0) !== END_SIGNATURE || end.readUInt16LE(4) !== 0
    || end.readUInt16LE(6) !== 0 || end.readUInt16LE(8) !== end.readUInt16LE(10)
    || end.readUInt16LE(20) !== 0) {
    throw new Error('World FFmpeg portable ZIP end record is invalid or noncanonical.')
  }
  const entryCount = end.readUInt16LE(10)
  const centralSize = end.readUInt32LE(12)
  const centralOffset = end.readUInt32LE(16)
  if (entryCount < 1 || centralOffset + centralSize + 22 !== artifactSize) {
    throw new Error('World FFmpeg portable ZIP central authority is invalid.')
  }

  const entries = []
  const names = new Set()
  let centralPosition = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    const fixed = await readExact(handle, centralPosition, 46)
    if (fixed.readUInt32LE(0) !== CENTRAL_SIGNATURE
      || fixed.readUInt16LE(8) !== UTF8_DATA_DESCRIPTOR_FLAGS
      || fixed.readUInt16LE(10) !== STORED_METHOD
      || fixed.readUInt16LE(12) !== FIXED_DOS_TIME || fixed.readUInt16LE(14) !== FIXED_DOS_DATE
      || fixed.readUInt16LE(30) !== 0 || fixed.readUInt16LE(32) !== 0
      || fixed.readUInt16LE(34) !== 0 || fixed.readUInt16LE(36) !== 0
      || fixed.readUInt32LE(20) !== fixed.readUInt32LE(24)) {
      throw new Error('World FFmpeg portable ZIP central entry is unsupported or noncanonical.')
    }
    const nameLength = fixed.readUInt16LE(28)
    if (nameLength < 1 || nameLength > MAX_NAME_BYTES) {
      throw new Error('World FFmpeg portable ZIP entry name exceeded its bound.')
    }
    const nameBytes = await readExact(handle, centralPosition + 46, nameLength)
    const name = decodeCanonicalName(nameBytes, rootName)
    const folded = name.toLowerCase()
    if (names.has(folded)) throw new Error('World FFmpeg portable ZIP entry names collide.')
    names.add(folded)
    entries.push(Object.freeze({
      name,
      nameBytes,
      crc32: fixed.readUInt32LE(16),
      size: fixed.readUInt32LE(24),
      localOffset: fixed.readUInt32LE(42),
      externalAttributes: fixed.readUInt32LE(38),
    }))
    centralPosition += 46 + nameLength
  }
  if (centralPosition !== centralOffset + centralSize) {
    throw new Error('World FFmpeg portable ZIP central directory has trailing data.')
  }
  requireNoPathCollisions(entries)

  let expectedLocalOffset = 0
  let totalBytes = 0
  let retainedBytes = 0
  const protectedEntries = []
  const resourcesPrefix = `${rootName}/resources/`
  for (const entry of entries) {
    if (entry.localOffset !== expectedLocalOffset) {
      throw new Error('World FFmpeg portable ZIP local entry ordering is noncanonical.')
    }
    const fixed = await readExact(handle, entry.localOffset, 30)
    if (fixed.readUInt32LE(0) !== LOCAL_SIGNATURE
      || fixed.readUInt16LE(6) !== UTF8_DATA_DESCRIPTOR_FLAGS
      || fixed.readUInt16LE(8) !== STORED_METHOD
      || fixed.readUInt16LE(10) !== FIXED_DOS_TIME || fixed.readUInt16LE(12) !== FIXED_DOS_DATE
      || fixed.readUInt32LE(14) !== 0 || fixed.readUInt32LE(18) !== 0 || fixed.readUInt32LE(22) !== 0
      || fixed.readUInt16LE(26) !== entry.nameBytes.byteLength || fixed.readUInt16LE(28) !== 0) {
      throw new Error('World FFmpeg portable ZIP local entry is unsupported or noncanonical.')
    }
    const localName = await readExact(handle, entry.localOffset + 30, entry.nameBytes.byteLength)
    if (!localName.equals(entry.nameBytes)) throw new Error('World FFmpeg portable ZIP names disagree.')
    const dataOffset = entry.localOffset + 30 + entry.nameBytes.byteLength
    const descriptorOffset = dataOffset + entry.size
    if (descriptorOffset + 16 > centralOffset) throw new Error('World FFmpeg portable ZIP entry escaped its data region.')
    let crc = 0xffff_ffff
    let position = 0
    const relativePath = entry.name.startsWith(resourcesPrefix)
      ? entry.name.slice(resourcesPrefix.length)
      : null
    const retentionLimit = relativePath === null ? 0 : retainedLimitFor(relativePath, target)
    if (retentionLimit > 0 && entry.size > retentionLimit) {
      throw new Error(`World FFmpeg portable ZIP protected entry exceeded its bound: ${relativePath}.`)
    }
    const retained = retentionLimit > 0 ? [] : null
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, entry.size)))
    while (position < entry.size) {
      const length = Math.min(buffer.byteLength, entry.size - position)
      const { bytesRead } = await handle.read(buffer, 0, length, dataOffset + position)
      if (bytesRead < 1) throw new Error('World FFmpeg portable ZIP entry ended early.')
      const chunk = buffer.subarray(0, bytesRead)
      crc = updateCrc32(crc, chunk)
      hash.update(chunk)
      if (retained) retained.push(Buffer.from(chunk))
      position += bytesRead
    }
    const descriptor = await readExact(handle, descriptorOffset, 16)
    const observedCrc = (crc ^ 0xffff_ffff) >>> 0
    if (descriptor.readUInt32LE(0) !== DESCRIPTOR_SIGNATURE
      || descriptor.readUInt32LE(4) !== entry.crc32 || descriptor.readUInt32LE(4) !== observedCrc
      || descriptor.readUInt32LE(8) !== entry.size || descriptor.readUInt32LE(12) !== entry.size) {
      throw new Error('World FFmpeg portable ZIP data descriptor or CRC is invalid.')
    }
    totalBytes += entry.size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_EXTRACTED_BYTES) {
      throw new Error('World FFmpeg portable ZIP parsed bytes exceeded their bound.')
    }
    if (relativePath !== null && isProtectedResourcePath(relativePath, target)) {
      const segments = relativePath.split('/')
      const name = segments.pop()
      const mode = (entry.externalAttributes >>> 16) & 0o7777
      const bytes = retained ? Buffer.concat(retained, entry.size) : null
      if (bytes) {
        retainedBytes += bytes.byteLength
        if (!Number.isSafeInteger(retainedBytes) || retainedBytes > MAX_RETAINED_BYTES) {
          throw new Error('World FFmpeg portable ZIP retained bytes exceeded their bound.')
        }
      }
      protectedEntries.push(Object.freeze({
        segments: Object.freeze(segments),
        name,
        size: entry.size,
        sha256: hash.digest('hex'),
        mode,
        ...(bytes ? { bytesBase64: bytes.toString('base64') } : {}),
      }))
    } else {
      hash.digest()
    }
    expectedLocalOffset = descriptorOffset + 16
  }
  if (expectedLocalOffset !== centralOffset) throw new Error('World FFmpeg portable ZIP has an unclaimed data gap.')
  const after = await handle.stat({ bigint: true })
  if (!sameStableFile(before, after)) throw new Error('World FFmpeg portable ZIP artifact changed during parsing.')
  const snapshot = createProtectedResourcesSnapshot(protectedEntries, target)
  return Object.freeze({
    entries: entryCount,
    parsedBytes: totalBytes,
    retainedBytes,
    rootName,
    target,
    snapshot,
  })
}

function requireNoPathCollisions(entries) {
  const names = new Set(entries.map(({ name }) => name.toLowerCase()))
  for (const entry of entries) {
    const fileType = (entry.externalAttributes >>> 16) & 0o170000
    if (fileType !== 0o100000) {
      throw new Error('World FFmpeg portable ZIP contains a nonordinary entry.')
    }
    const segments = entry.name.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join('/').toLowerCase()
      if (names.has(prefix)) {
        throw new Error('World FFmpeg portable ZIP file and directory paths collide.')
      }
    }
  }
}

function retainedLimitFor(relativePath, target) {
  if (relativePath === `ffmpeg/${target}/manifest.json`) return 256 * 1024
  if (relativePath === `ffmpeg/${target}/manifest.sig`) return 64
  if (relativePath === `world-ffmpeg-build-reports/${target}.json`) return 1024 * 1024
  if (relativePath === 'THIRD_PARTY_NOTICES.md') return 2 * 1024 * 1024
  if (relativePath.startsWith('licenses/world-ffmpeg-7.1.1/')) return 2 * 1024 * 1024
  return 0
}

function isProtectedResourcePath(relativePath, target) {
  return relativePath === 'THIRD_PARTY_NOTICES.md'
    || relativePath.startsWith(`ffmpeg/${target}/`)
    || relativePath.startsWith('licenses/world-ffmpeg-7.1.1/')
    || relativePath === `world-ffmpeg-build-reports/${target}.json`
}

function createProtectedResourcesSnapshot(entries, target) {
  const requiredManifest = entries.filter(({ segments, name, bytesBase64 }) => (
    segments.join('/') === `ffmpeg/${target}` && name === 'manifest.json'
      && typeof bytesBase64 === 'string'
  ))
  if (requiredManifest.length !== 1) {
    throw new Error('World FFmpeg portable ZIP has no unique protected runtime manifest.')
  }
  const files = []
  const hashFiles = []
  const directoryEntries = new Map()
  const addDirectoryEntry = (segments, name, kind, mode) => {
    const key = segments.join('/')
    const values = directoryEntries.get(key) ?? new Map()
    const prior = values.get(name.toLowerCase())
    if (prior && (prior.name !== name || prior.kind !== kind)) {
      throw new Error('World FFmpeg portable ZIP protected paths collide.')
    }
    values.set(name.toLowerCase(), Object.freeze({ name, kind, mode }))
    directoryEntries.set(key, values)
  }
  for (const entry of entries) {
    const file = Object.freeze({ name: entry.name, size: entry.size, sha256: entry.sha256 })
    const common = Object.freeze({
      segments: entry.segments,
      file,
      mode: entry.mode,
    })
    hashFiles.push(common)
    if (typeof entry.bytesBase64 === 'string') {
      files.push(Object.freeze({ ...common, bytesBase64: entry.bytesBase64 }))
    }
    addDirectoryEntry(entry.segments, entry.name, 'file', entry.mode)
    for (let index = 0; index < entry.segments.length; index += 1) {
      addDirectoryEntry(
        entry.segments.slice(0, index),
        entry.segments[index],
        'directory',
        0,
      )
    }
  }
  const directories = [...directoryEntries.entries()].map(([key, values]) => Object.freeze({
    segments: Object.freeze(key ? key.split('/') : []),
    mode: 0,
    entries: Object.freeze([...values.values()].sort(({ name: left }, { name: right }) => (
      codeUnitCompare(left, right)
    ))),
  })).sort((left, right) => codeUnitCompare(left.segments.join('/'), right.segments.join('/')))
  return Object.freeze({
    source: 'retained-portable-zip',
    target,
    files: Object.freeze(files),
    hashFiles: Object.freeze(hashFiles),
    directories: Object.freeze(directories),
  })
}

function requirePortableTarget(value) {
  if (value !== 'win32-x64') throw new Error('World FFmpeg portable ZIP target is invalid.')
  return value
}

async function appendDirectory(label, prefix, state) {
  const parent = await lstat('.', { bigint: true })
  requireDirectory(parent, `portable directory ${label}`)
  const entries = (await readdir('.', { withFileTypes: true }))
    .sort(({ name: left }, { name: right }) => codeUnitCompare(left, right))
  for (const entry of entries) {
    requireDirectName(entry.name, 'portable entry')
    const observed = await lstat(entry.name, { bigint: true })
    if (observed.isSymbolicLink()) throw new Error('World FFmpeg portable source contains a symbolic link.')
    if (observed.isDirectory()) {
      const directory = await open(entry.name, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0))
      let entered = false
      try {
        const opened = await directory.stat({ bigint: true })
        requireSameDirectory(observed, opened, 'portable child directory')
        process.chdir(entry.name)
        entered = true
        requireSameDirectory(await lstat('.', { bigint: true }), opened, 'portable child directory')
        await appendDirectory(entry.name, [...prefix, entry.name], state)
      } finally {
        if (entered) process.chdir('..')
        await directory.close()
      }
      requireSameDirectory(await lstat('.', { bigint: true }), parent, 'portable parent directory')
      continue
    }
    if (!observed.isFile() || observed.nlink !== 1n) {
      throw new Error('World FFmpeg portable source contains a nonordinary or hard-linked entry.')
    }
    const file = await open(entry.name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let primaryError
    try {
      const opened = await file.stat({ bigint: true })
      if (!sameStableFile(observed, opened) || opened.size > BigInt(MAX_ZIP32)) {
        throw new Error('World FFmpeg portable source file identity or size is invalid.')
      }
      const archiveName = [state.rootName, ...prefix, entry.name].join('/')
      const nameBytes = Buffer.from(archiveName)
      if (nameBytes.byteLength < 1 || nameBytes.byteLength > MAX_NAME_BYTES) {
        throw new Error('World FFmpeg portable ZIP entry name exceeded its bound.')
      }
      const folded = archiveName.toLowerCase()
      if (state.names.has(folded)) throw new Error('World FFmpeg portable source names collide.')
      state.names.add(folded)
      if (state.central.length >= MAX_ENTRIES) throw new Error('World FFmpeg portable ZIP entry count exceeded its bound.')
      const localOffset = state.writer.position
      await state.writer.write(localHeader(nameBytes))
      let crc = 0xffff_ffff
      let position = 0
      const size = Number(opened.size)
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)))
      while (position < size) {
        const length = Math.min(buffer.byteLength, size - position)
        const { bytesRead } = await file.read(buffer, 0, length, position)
        if (bytesRead < 1) throw new Error('World FFmpeg portable source file ended early.')
        const chunk = buffer.subarray(0, bytesRead)
        crc = updateCrc32(crc, chunk)
        await state.writer.write(chunk)
        position += bytesRead
      }
      const crc32 = (crc ^ 0xffff_ffff) >>> 0
      await state.writer.write(dataDescriptor(crc32, size))
      const after = await file.stat({ bigint: true })
      const publicAfter = await lstat(entry.name, { bigint: true })
      if (!sameStableFile(opened, after) || !sameStableFile(after, publicAfter)) {
        throw new Error('World FFmpeg portable source file changed during archive creation.')
      }
      state.extractedBytes += size
      if (!Number.isSafeInteger(state.extractedBytes) || state.extractedBytes > MAX_EXTRACTED_BYTES) {
        throw new Error('World FFmpeg portable source bytes exceeded their bound.')
      }
      state.central.push(Object.freeze({
        nameBytes, crc32, size, localOffset,
        mode: Number(opened.mode & 0o7777n),
      }))
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      try { await file.close() } catch (error) {
        throw new AggregateError(primaryError ? [primaryError, error] : [error], 'Portable ZIP input close failed.')
      }
    }
  }
}

function localHeader(nameBytes) {
  const value = Buffer.alloc(30 + nameBytes.byteLength)
  value.writeUInt32LE(LOCAL_SIGNATURE, 0)
  value.writeUInt16LE(20, 4)
  value.writeUInt16LE(UTF8_DATA_DESCRIPTOR_FLAGS, 6)
  value.writeUInt16LE(STORED_METHOD, 8)
  value.writeUInt16LE(FIXED_DOS_TIME, 10)
  value.writeUInt16LE(FIXED_DOS_DATE, 12)
  value.writeUInt16LE(nameBytes.byteLength, 26)
  nameBytes.copy(value, 30)
  return value
}

function dataDescriptor(crc32, size) {
  const value = Buffer.alloc(16)
  value.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0)
  value.writeUInt32LE(crc32, 4)
  value.writeUInt32LE(size, 8)
  value.writeUInt32LE(size, 12)
  return value
}

function centralHeader(entry) {
  const value = Buffer.alloc(46 + entry.nameBytes.byteLength)
  value.writeUInt32LE(CENTRAL_SIGNATURE, 0)
  value.writeUInt16LE((3 << 8) | 20, 4)
  value.writeUInt16LE(20, 6)
  value.writeUInt16LE(UTF8_DATA_DESCRIPTOR_FLAGS, 8)
  value.writeUInt16LE(STORED_METHOD, 10)
  value.writeUInt16LE(FIXED_DOS_TIME, 12)
  value.writeUInt16LE(FIXED_DOS_DATE, 14)
  value.writeUInt32LE(entry.crc32, 16)
  value.writeUInt32LE(entry.size, 20)
  value.writeUInt32LE(entry.size, 24)
  value.writeUInt16LE(entry.nameBytes.byteLength, 28)
  value.writeUInt32LE((((0o100000 | entry.mode) << 16) >>> 0), 38)
  value.writeUInt32LE(entry.localOffset, 42)
  entry.nameBytes.copy(value, 46)
  return value
}

function endRecord(entries, centralSize, centralOffset) {
  const value = Buffer.alloc(22)
  value.writeUInt32LE(END_SIGNATURE, 0)
  value.writeUInt16LE(entries, 8)
  value.writeUInt16LE(entries, 10)
  value.writeUInt32LE(centralSize, 12)
  value.writeUInt32LE(centralOffset, 16)
  return value
}

function createWriter(handle) {
  return {
    position: 0,
    async write(bytes) {
      if (!Buffer.isBuffer(bytes) || this.position + bytes.byteLength > MAX_ZIP32) {
        throw new Error('World FFmpeg portable ZIP exceeded its ZIP32 byte bound.')
      }
      await writeAll(handle, bytes, this.position)
      this.position += bytes.byteLength
    },
  }
}

async function writeAll(handle, bytes, position) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (bytesWritten < 1) throw new Error('World FFmpeg portable ZIP write made no progress.')
    offset += bytesWritten
  }
}

async function readExact(handle, position, length) {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new Error('World FFmpeg portable ZIP read range is invalid.')
  }
  const value = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(value, offset, length - offset, position + offset)
    if (bytesRead < 1) throw new Error('World FFmpeg portable ZIP ended before its declared boundary.')
    offset += bytesRead
  }
  return value
}

async function hashHandle(handle, size) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size))
  let position = 0
  while (position < size) {
    const length = Math.min(buffer.byteLength, size - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead < 1) throw new Error('World FFmpeg portable ZIP ended during hashing.')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

function decodeCanonicalName(bytes, rootName) {
  let value
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
    throw new Error('World FFmpeg portable ZIP entry name is not UTF-8.')
  }
  if (!Buffer.from(value).equals(bytes) || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) {
    throw new Error('World FFmpeg portable ZIP entry name is noncanonical.')
  }
  const segments = value.split('/')
  if (segments.length < 2 || segments.length > 64 || segments[0] !== rootName) {
    throw new Error('World FFmpeg portable ZIP root authority is invalid.')
  }
  for (const segment of segments) requireDirectName(segment, 'portable ZIP segment')
  return value
}

function createCrcTable() {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
    table[index] = value >>> 0
  }
  return table
}

function updateCrc32(crc, bytes) {
  let value = crc >>> 0
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]
  return value >>> 0
}

async function withCwd(directory, operation) {
  const previousTail = cwdTail
  let release
  cwdTail = new Promise((resolvePromise) => { release = resolvePromise })
  await previousTail
  const previous = process.cwd()
  try {
    process.chdir(directory)
    return await operation()
  } finally {
    try { process.chdir(previous) } finally { release() }
  }
}

function requireAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`World FFmpeg ${label} path is invalid.`)
  }
  return resolve(value)
}

function requireDirectZipName(value) {
  const name = requireDirectName(value, 'portable ZIP artifact')
  if (!name.endsWith('.zip')) throw new Error('World FFmpeg portable ZIP artifact suffix is invalid.')
  return name
}

function requireDirectName(value, label) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > 255
    || value === '.' || value === '..' || value.includes('/') || value.includes('\\')
    || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`World FFmpeg ${label} is invalid.`)
  }
  return value
}

function requireDirectory(info, label) {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`World FFmpeg ${label} is not an ordinary directory.`)
}

function requireExpectedIdentity(info, expected, label) {
  if (!expected || typeof expected !== 'object'
    || String(info.dev) !== expected.dev || String(info.ino) !== expected.ino) {
    throw new Error(`World FFmpeg ${label} identity mismatches.`)
  }
}

function requireSameDirectory(left, right, label) {
  requireDirectory(left, label)
  requireDirectory(right, label)
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error(`World FFmpeg ${label} identity changed.`)
  }
}

function sameStableFile(left, right) {
  return left.isFile() && right.isFile() && left.nlink === 1n && right.nlink === 1n
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function sameOpenFileIdentity(left, right) {
  return left.isFile() && right.isFile() && left.nlink === 1n && right.nlink === 1n
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
