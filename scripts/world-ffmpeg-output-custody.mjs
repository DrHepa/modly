#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RECEIPT_SCHEMA = 'modly.world-ffmpeg-output-custody-receipt.v1'
const REQUEST_SCHEMA = 'modly.world-ffmpeg-output-custody-request.v1'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_OVERHEAD_BYTES = 64 * 1024
const MAX_FILE_BYTES = 16 * 1024 * 1024 * 1024
const MAX_COPY_BYTES = 1024 * 1024
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024
const MAX_SNAPSHOT_FILES = 32
const MAX_SNAPSHOT_HASH_FILES = 130
const MAX_SNAPSHOT_DIRECTORIES = 16
const MAX_SNAPSHOT_DIRECTORY_ENTRIES = 256
const MAX_SNAPSHOT_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOT_HASH_REQUEST_BYTES = 20 * 1024 * 1024 * 1024
const MAX_SNAPSHOT_HASHED_BYTES = 2 * 1024 * 1024 * 1024
const MAX_HELPER_MS = 10 * 60_000
const HELPER_PATH = fileURLToPath(import.meta.url)

export async function runWorldFfmpegOutputCustody(input, dependencies = {}) {
  const request = requireRequest(input)
  const directory = requireAbsolute(input?.directory, 'custody directory')
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const executable = dependencies.executable ?? process.execPath
  const environment = closedHelperEnvironment(
    dependencies.environment ?? input?.environment ?? process.env,
    dependencies.platform ?? process.platform,
  )
  if (typeof spawnProcess !== 'function' || typeof executable !== 'string' || !isAbsolute(executable)
    || !environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('World FFmpeg output custody process authority is invalid.')
  }
  const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`)
  if (requestBytes.byteLength > MAX_REQUEST_BYTES) {
    throw new Error('World FFmpeg output custody request exceeds its byte bound.')
  }
  const responsePayloadBytes = request.operation === 'read'
    ? request.maximumBytes
    : request.operation === 'snapshot'
      ? request.files.reduce((total, file) => total + file.maximumBytes, 0)
      : 0
  const maximumResponseBytes = Math.ceil((responsePayloadBytes * 4) / 3)
    + MAX_RESPONSE_OVERHEAD_BYTES
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawnProcess(executable, [HELPER_PATH], Object.freeze({
        cwd: directory,
        env: environment,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: Object.freeze(['pipe', 'pipe', 'pipe']),
      }))
    } catch (error) {
      rejectPromise(error)
      return
    }
    let stdout = Buffer.alloc(0)
    let stderr = ''
    let settled = false
    let timer
    const finish = (operation) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      operation()
    }
    child.stdout.on('data', (chunk) => {
      if (stdout.byteLength + chunk.byteLength > maximumResponseBytes) {
        child.kill('SIGKILL')
        finish(() => rejectPromise(new Error('World FFmpeg output custody response exceeded its byte bound.')))
        return
      }
      stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_RESPONSE_OVERHEAD_BYTES) {
        stderr += String(chunk).slice(0, MAX_RESPONSE_OVERHEAD_BYTES - stderr.length)
      }
    })
    child.once('error', (error) => finish(() => rejectPromise(error)))
    child.once('close', (code, signal) => finish(() => {
      if (code !== 0 || signal !== null) {
        rejectPromise(new Error(stderr.trim() || `World FFmpeg output custody helper failed: ${signal ?? code ?? 'unknown'}.`))
        return
      }
      try {
        const receipt = JSON.parse(stdout.toString('utf8'))
        if (!stdout.equals(Buffer.from(`${JSON.stringify(receipt)}\n`)) || !validateReceipt(receipt, request)) {
          throw new Error('World FFmpeg output custody helper returned an invalid receipt.')
        }
        resolvePromise(deepFreeze(receipt))
      } catch (error) {
        rejectPromise(error)
      }
    }))
    child.stdin.once('error', (error) => finish(() => rejectPromise(error)))
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => rejectPromise(new Error('World FFmpeg output custody helper timed out.')))
    }, MAX_HELPER_MS)
    child.stdin.end(requestBytes)
  })
}

// The sandboxed contract suite cannot reliably deliver piped stdin to a nested
// Node process whose cwd is a synthetic fixture directory. Keep that harness
// limitation out of the production helper path: this test-only seam executes
// the same request parser and descriptor-custody implementation in a serialized
// test process while restoring its original cwd exactly.
export async function _testOnlyRunWorldFfmpegOutputCustodyInProcess(input, dependencies = {}) {
  const request = requireRequest(input)
  const directory = requireAbsolute(input?.directory, 'custody directory')
  if ((dependencies.beforeEnter !== undefined && typeof dependencies.beforeEnter !== 'function')
    || (dependencies.afterRootOpen !== undefined && typeof dependencies.afterRootOpen !== 'function')) {
    throw new Error('World FFmpeg output custody in-process test seam is invalid.')
  }
  const previousDirectory = process.cwd()
  await dependencies.beforeEnter?.()
  process.chdir(directory)
  try {
    const receipt = await executeRequest(request, dependencies)
    if (!validateReceipt(receipt, request)) {
      throw new Error('World FFmpeg output custody in-process test seam returned an invalid receipt.')
    }
    return deepFreeze(receipt)
  } finally {
    process.chdir(previousDirectory)
  }
}

function closedHelperEnvironment(source, platform) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || !['linux', 'darwin', 'win32'].includes(platform)) {
    throw new Error('World FFmpeg output custody environment authority is invalid.')
  }
  const environment = {
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    TZ: 'UTC',
  }
  if (platform !== 'win32') return Object.freeze(environment)
  const index = new Map()
  for (const key of Object.keys(source)) {
    const folded = key.toLowerCase()
    if (index.has(folded)) throw new Error('World FFmpeg output custody Windows environment is ambiguous.')
    index.set(folded, source[key])
  }
  const systemRoot = index.get('systemroot')
  const windir = index.get('windir')
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/i.test(systemRoot)
    || typeof windir !== 'string' || windir.toLowerCase() !== systemRoot.toLowerCase()) {
    throw new Error('World FFmpeg output custody Windows system authority is invalid.')
  }
  environment.SystemRoot = systemRoot
  environment.WINDIR = systemRoot
  environment.PATH = `${systemRoot}\\System32;${systemRoot}`
  environment.COMSPEC = `${systemRoot}\\System32\\cmd.exe`
  environment.PATHEXT = '.COM;.EXE;.BAT;.CMD'
  return Object.freeze(environment)
}

function requireRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('World FFmpeg output custody request is invalid.')
  }
  const operation = input.operation
  if (!['directory', 'hash', 'read', 'write', 'snapshot'].includes(operation)) {
    throw new Error('World FFmpeg output custody operation is invalid.')
  }
  const segments = input.segments ?? []
  if (!Array.isArray(segments) || segments.length > 16 || !segments.every(validDirectName)) {
    throw new Error('World FFmpeg output custody directory traversal is invalid.')
  }
  const expectedDirectoryIdentity = input.expectedDirectoryIdentity ?? null
  if (expectedDirectoryIdentity !== null && !validateDirectoryIdentity(expectedDirectoryIdentity)) {
    throw new Error('World FFmpeg output custody expected directory identity is invalid.')
  }
  const request = {
    schema: REQUEST_SCHEMA,
    operation,
    segments,
    expectedDirectoryIdentity,
  }
  if (operation === 'snapshot') {
    if (segments.length !== 0
      || !Array.isArray(input.files) || input.files.length < 1
      || input.files.length > MAX_SNAPSHOT_FILES
      || !Array.isArray(input.hashFiles ?? [])
      || (input.hashFiles ?? []).length > MAX_SNAPSHOT_HASH_FILES
      || !Array.isArray(input.directories)
      || input.directories.length > MAX_SNAPSHOT_DIRECTORIES) {
      throw new Error('World FFmpeg output custody snapshot shape is invalid.')
    }
    request.files = input.files.map((file) => requireSnapshotFile(file))
    request.hashFiles = (input.hashFiles ?? []).map((file) => requireSnapshotHashFile(file))
    request.directories = input.directories.map((directory) => requireSnapshotDirectory(directory))
    const totalBytes = request.files.reduce((total, file) => total + file.maximumBytes, 0)
    const totalHashRequestBytes = request.hashFiles.reduce((total, file) => total + file.maximumBytes, 0)
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SNAPSHOT_TOTAL_BYTES
      || !Number.isSafeInteger(totalHashRequestBytes)
      || totalHashRequestBytes > MAX_SNAPSHOT_HASH_REQUEST_BYTES
      || !uniqueSnapshotPaths(request.files, request.hashFiles, request.directories)) {
      throw new Error('World FFmpeg output custody snapshot bounds are invalid.')
    }
    return deepFreeze(request)
  }
  if (operation !== 'directory') {
    if (!validDirectName(input.name)) throw new Error('World FFmpeg output custody file name is invalid.')
    request.name = input.name
    const maximumBytes = input.maximumBytes
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_FILE_BYTES) {
      throw new Error('World FFmpeg output custody file byte bound is invalid.')
    }
    request.maximumBytes = maximumBytes
    if (operation === 'read' && maximumBytes > MAX_COPY_BYTES) {
      throw new Error('World FFmpeg output custody read byte bound is invalid.')
    }
  }
  if (operation === 'write') {
    if (segments.length !== 0 || !Buffer.isBuffer(input.bytes)
      || input.bytes.byteLength < 2 || input.bytes.byteLength > MAX_COPY_BYTES
      || input.bytes.byteLength > request.maximumBytes) {
      throw new Error('World FFmpeg output custody write payload is invalid.')
    }
    request.bytesBase64 = input.bytes.toString('base64')
  }
  return Object.freeze(request)
}

async function executeRequest(request, dependencies = {}) {
  if (!validateRequest(request)) throw new Error('World FFmpeg output custody helper request is invalid.')
  const heldDirectories = []
  let root
  try {
    root = await openObservedDirectory('.')
    heldDirectories.push(root)
    await dependencies.afterRootOpen?.()
    const snapshotDirectoryBindings = new Map([['', root]])
    if (request.expectedDirectoryIdentity !== null
      && !sameDirectoryIdentity(root.identity, request.expectedDirectoryIdentity)) {
      throw new Error('World FFmpeg output custody root identity changed.')
    }
    let current = root
    for (const segment of request.segments) {
      const next = await openObservedDirectory(segment)
      process.chdir(segment)
      const entered = await observeCurrentDirectory()
      if (!sameDirectoryIdentity(next.identity, entered)) {
        await next.handle.close().catch(() => undefined)
        throw new Error('World FFmpeg output custody ancestor changed while entered.')
      }
      heldDirectories.push(next)
      current = next
    }
    const receipt = {
      schema: RECEIPT_SCHEMA,
      operation: request.operation,
      rootIdentity: root.identity,
      directoryIdentity: current.identity,
    }
    if (request.operation === 'snapshot') {
      const files = []
      for (const fileRequest of request.files) {
        const file = await executeWithinSegments(root, fileRequest.segments, heldDirectories, snapshotDirectoryBindings, () => (
          readDirectFile(fileRequest.name, fileRequest.maximumBytes, true)
        ))
        files.push(Object.freeze({
          segments: fileRequest.segments,
          file: file.descriptor,
          mode: file.mode,
          bytesBase64: file.bytes.toString('base64'),
        }))
      }
      let hashedBytes = 0
      const hashFiles = []
      for (const fileRequest of request.hashFiles) {
        const file = await executeWithinSegments(root, fileRequest.segments, heldDirectories, snapshotDirectoryBindings, () => (
          readDirectFile(fileRequest.name, fileRequest.maximumBytes, false)
        ))
        hashedBytes += file.descriptor.size
        if (!Number.isSafeInteger(hashedBytes) || hashedBytes > MAX_SNAPSHOT_HASHED_BYTES) {
          throw new Error('World FFmpeg output custody snapshot hashed files exceed their total byte bound.')
        }
        hashFiles.push(Object.freeze({
          segments: fileRequest.segments,
          file: file.descriptor,
          mode: file.mode,
        }))
      }
      const directories = []
      for (const directoryRequest of request.directories) {
        const listing = await executeWithinSegments(
          root,
          directoryRequest.segments,
          heldDirectories,
          snapshotDirectoryBindings,
          listDirectDirectory,
        )
        directories.push(Object.freeze({
          segments: directoryRequest.segments,
          mode: listing.mode,
          entries: listing.entries,
        }))
      }
      for (const binding of [...snapshotDirectoryBindings.values()].slice(1)) {
        await executeWithinSegments(
          root,
          binding.segments,
          heldDirectories,
          snapshotDirectoryBindings,
          async () => undefined,
        )
      }
      receipt.files = Object.freeze(files)
      receipt.hashFiles = Object.freeze(hashFiles)
      receipt.directories = Object.freeze(directories)
    }
    if (request.operation !== 'directory') {
      if (request.operation !== 'snapshot') {
        const file = request.operation === 'write'
          ? await writeDirectFile(request.name, request.maximumBytes, request.bytesBase64)
          : await readDirectFile(request.name, request.maximumBytes, request.operation === 'read')
        receipt.file = file.descriptor
        if (request.operation === 'read') receipt.bytesBase64 = file.bytes.toString('base64')
        if (request.operation === 'write' && process.platform !== 'win32') {
          await current.handle.sync()
        }
      }
    }
    const finalDirectory = await observeCurrentDirectory()
    if (!sameDirectoryIdentity(finalDirectory, current.identity)) {
      throw new Error('World FFmpeg output custody working directory identity changed.')
    }
    for (const directory of heldDirectories) {
      const opened = await directory.handle.stat({ bigint: true })
      if (!opened.isDirectory()
        || !sameDirectoryIdentity(directory.identity, directoryIdentity(opened))) {
        throw new Error('World FFmpeg output custody held directory identity changed.')
      }
    }
    return Object.freeze(receipt)
  } finally {
    await Promise.all(heldDirectories.map(({ handle }) => handle.close().catch(() => undefined)))
  }
}

async function executeWithinSegments(root, segments, heldDirectories, directoryBindings, operation) {
  const entered = [root]
  let failure
  try {
    for (const [index, segment] of segments.entries()) {
      const next = await openObservedDirectory(segment)
      process.chdir(segment)
      const observed = await observeCurrentDirectory()
      if (!sameDirectoryIdentity(next.identity, observed)) {
        await next.handle.close().catch(() => undefined)
        throw new Error('World FFmpeg output custody snapshot ancestor changed while entered.')
      }
      const key = segments.slice(0, index + 1).join('\0')
      const bound = directoryBindings.get(key)
      if (bound && !sameDirectoryIdentity(bound.identity, next.identity)) {
        await next.handle.close().catch(() => undefined)
        throw new Error('World FFmpeg output custody snapshot ancestor identity changed.')
      }
      if (bound) {
        await next.handle.close()
        entered.push(bound)
      } else {
        const retained = Object.freeze({ ...next, segments: Object.freeze(segments.slice(0, index + 1)) })
        directoryBindings.set(key, retained)
        heldDirectories.push(retained)
        entered.push(retained)
      }
    }
    return await operation()
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      for (let index = entered.length - 1; index > 0; index -= 1) {
        process.chdir('..')
        const observed = await observeCurrentDirectory()
        if (!sameDirectoryIdentity(observed, entered[index - 1].identity)) {
          throw new Error('World FFmpeg output custody snapshot ancestor changed while leaving.')
        }
      }
    } catch (returnError) {
      if (failure === undefined) throw returnError
    }
  }
}

async function listDirectDirectory() {
  const directoryBefore = await lstat('.', { bigint: true })
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    throw new Error('World FFmpeg output custody snapshot directory is invalid.')
  }
  const beforeNames = (await readdir('.')).sort(codeUnitCompare)
  if (beforeNames.length > MAX_SNAPSHOT_DIRECTORY_ENTRIES
    || !beforeNames.every(validDirectName)) {
    throw new Error('World FFmpeg output custody snapshot directory is invalid or exceeds its bound.')
  }
  const observations = []
  for (const name of beforeNames) {
    const info = await lstat(name, { bigint: true })
    const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : null
    if (kind === null || info.isSymbolicLink() || (kind === 'file' && info.nlink !== 1n)) {
      throw new Error('World FFmpeg output custody snapshot directory contains an unsafe entry.')
    }
    observations.push(Object.freeze({ name, kind, info }))
  }
  const afterNames = (await readdir('.')).sort(codeUnitCompare)
  if (!sameArray(beforeNames, afterNames)) {
    throw new Error('World FFmpeg output custody snapshot directory changed while listed.')
  }
  const directoryAfter = await lstat('.', { bigint: true })
  if (!sameStableDirectoryEntry(directoryBefore, directoryAfter, 'directory')) {
    throw new Error('World FFmpeg output custody snapshot directory changed while listed.')
  }
  const entries = []
  for (const observation of observations) {
    const after = await lstat(observation.name, { bigint: true })
    if (!sameStableDirectoryEntry(observation.info, after, observation.kind)) {
      throw new Error('World FFmpeg output custody snapshot directory entry changed while listed.')
    }
    entries.push(Object.freeze({
      name: observation.name,
      kind: observation.kind,
      dev: String(after.dev),
      ino: String(after.ino),
      size: Number(after.size),
      mode: Number(after.mode & 0o7777n),
    }))
  }
  return Object.freeze({
    mode: Number(directoryAfter.mode & 0o7777n),
    entries: Object.freeze(entries),
  })
}

async function openObservedDirectory(path) {
  let handle
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('World FFmpeg output custody directory is invalid.')
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat({ bigint: true })
    const identity = directoryIdentity(opened)
    if (!opened.isDirectory() || !sameDirectoryIdentity(identity, directoryIdentity(info))) {
      throw new Error('World FFmpeg output custody directory changed while opened.')
    }
    return Object.freeze({ handle, identity })
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    throw error
  }
}

async function observeCurrentDirectory() {
  const info = await lstat('.', { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('World FFmpeg output custody current directory is invalid.')
  }
  return directoryIdentity(info)
}

async function readDirectFile(name, maximumBytes, includeBytes) {
  let handle
  try {
    const info = await lstat(name, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
      || info.size < 1n || info.size > BigInt(maximumBytes)) {
      throw new Error('World FFmpeg output custody file is not an ordinary exclusive bounded file.')
    }
    handle = await open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat({ bigint: true })
    if (!sameFileIdentity(info, before)) throw new Error('World FFmpeg output custody file identity changed.')
    const hash = createHash('sha256')
    const chunks = []
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.byteLength
      if (size > maximumBytes) throw new Error('World FFmpeg output custody file exceeded its byte bound.')
      hash.update(chunk)
      if (includeBytes) chunks.push(chunk)
    }
    const after = await handle.stat({ bigint: true })
    if (!sameStableFile(before, after) || BigInt(size) !== before.size) {
      throw new Error('World FFmpeg output custody file changed while read.')
    }
    return Object.freeze({
      descriptor: fileDescriptor(name, before, size, hash.digest('hex')),
      mode: Number(before.mode & 0o7777n),
      bytes: includeBytes ? Buffer.concat(chunks, size) : Buffer.alloc(0),
    })
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

async function writeDirectFile(name, maximumBytes, bytesBase64) {
  const bytes = Buffer.from(bytesBase64, 'base64')
  if (bytes.byteLength < 2 || bytes.byteLength > maximumBytes
    || bytes.toString('base64') !== bytesBase64) {
    throw new Error('World FFmpeg output custody write bytes are invalid.')
  }
  let handle
  try {
    handle = await open(
      name,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null)
      if (bytesWritten < 1) throw new Error('World FFmpeg output custody write made no progress.')
      offset += bytesWritten
    }
    await handle.sync()
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(bytes.byteLength)) {
      throw new Error('World FFmpeg output custody written file identity is invalid.')
    }
    return Object.freeze({
      descriptor: fileDescriptor(
        name,
        info,
        bytes.byteLength,
        createHash('sha256').update(bytes).digest('hex'),
      ),
      mode: Number(info.mode & 0o7777n),
      bytes: Buffer.alloc(0),
    })
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function fileDescriptor(name, info, size, sha256) {
  return Object.freeze({
    name,
    dev: String(info.dev),
    ino: String(info.ino),
    size,
    sha256,
  })
}

function directoryIdentity(info) {
  return Object.freeze({ dev: String(info.dev), ino: String(info.ino) })
}

function validateRequest(value) {
  if (!exactRecord(value, [
    'schema', 'operation', 'segments', 'expectedDirectoryIdentity',
    ...(value?.operation === 'directory' || value?.operation === 'snapshot' ? [] : ['name', 'maximumBytes']),
    ...(value?.operation === 'write' ? ['bytesBase64'] : []),
    ...(value?.operation === 'snapshot' ? ['files', 'hashFiles', 'directories'] : []),
  ]) || value.schema !== REQUEST_SCHEMA
    || !['directory', 'hash', 'read', 'write', 'snapshot'].includes(value.operation)
    || !Array.isArray(value.segments) || value.segments.length > 16
    || !value.segments.every(validDirectName)
    || (value.expectedDirectoryIdentity !== null
      && !validateDirectoryIdentity(value.expectedDirectoryIdentity))) return false
  if (value.operation === 'directory') return true
  if (value.operation === 'snapshot') {
    if (value.segments.length !== 0
      || !Array.isArray(value.files) || value.files.length < 1
      || value.files.length > MAX_SNAPSHOT_FILES
      || !Array.isArray(value.hashFiles) || value.hashFiles.length > MAX_SNAPSHOT_HASH_FILES
      || !Array.isArray(value.directories)
      || value.directories.length > MAX_SNAPSHOT_DIRECTORIES
      || !value.files.every(validateSnapshotFile)
      || !value.hashFiles.every(validateSnapshotHashFile)
      || !value.directories.every(validateSnapshotDirectory)
      || !uniqueSnapshotPaths(value.files, value.hashFiles, value.directories)) return false
    const totalBytes = value.files.reduce((total, file) => total + file.maximumBytes, 0)
    const totalHashRequestBytes = value.hashFiles.reduce((total, file) => total + file.maximumBytes, 0)
    return Number.isSafeInteger(totalBytes) && totalBytes <= MAX_SNAPSHOT_TOTAL_BYTES
      && Number.isSafeInteger(totalHashRequestBytes)
      && totalHashRequestBytes <= MAX_SNAPSHOT_HASH_REQUEST_BYTES
  }
  if (!validDirectName(value.name)
    || !Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1
    || value.maximumBytes > MAX_FILE_BYTES
    || (value.operation === 'read' && value.maximumBytes > MAX_COPY_BYTES)) return false
  return value.operation !== 'write'
    || (value.segments.length === 0 && typeof value.bytesBase64 === 'string'
      && value.bytesBase64.length >= 4 && value.bytesBase64.length <= Math.ceil((MAX_COPY_BYTES * 4) / 3) + 4)
}

function validateReceipt(value, request) {
  if (!exactRecord(value, [
    'schema', 'operation', 'rootIdentity', 'directoryIdentity',
    ...(request.operation === 'directory' || request.operation === 'snapshot' ? [] : ['file']),
    ...(request.operation === 'read' ? ['bytesBase64'] : []),
    ...(request.operation === 'snapshot' ? ['files', 'hashFiles', 'directories'] : []),
  ]) || value.schema !== RECEIPT_SCHEMA || value.operation !== request.operation
    || !validateDirectoryIdentity(value.rootIdentity)
    || !validateDirectoryIdentity(value.directoryIdentity)) return false
  if (request.expectedDirectoryIdentity !== null
    && !sameDirectoryIdentity(value.rootIdentity, request.expectedDirectoryIdentity)) return false
  if (request.operation === 'directory') return true
  if (request.operation === 'snapshot') {
    if (!sameDirectoryIdentity(value.directoryIdentity, value.rootIdentity)
      || !Array.isArray(value.files) || value.files.length !== request.files.length
      || !Array.isArray(value.hashFiles) || value.hashFiles.length !== request.hashFiles.length
      || !Array.isArray(value.directories)
      || value.directories.length !== request.directories.length) return false
    for (const [index, entry] of value.files.entries()) {
      const expected = request.files[index]
      if (!exactRecord(entry, ['segments', 'file', 'mode', 'bytesBase64'])
        || !sameArray(entry.segments, expected.segments)
        || !validateFileDescriptor(entry.file) || entry.file.name !== expected.name
        || !validateMode(entry.mode)
        || entry.file.size > expected.maximumBytes || typeof entry.bytesBase64 !== 'string') return false
      const bytes = Buffer.from(entry.bytesBase64, 'base64')
      if (bytes.toString('base64') !== entry.bytesBase64 || bytes.byteLength !== entry.file.size
        || createHash('sha256').update(bytes).digest('hex') !== entry.file.sha256) return false
    }
    let hashedBytes = 0
    for (const [index, entry] of value.hashFiles.entries()) {
      const expected = request.hashFiles[index]
      if (!exactRecord(entry, ['segments', 'file', 'mode'])
        || !sameArray(entry.segments, expected.segments)
        || !validateFileDescriptor(entry.file) || entry.file.name !== expected.name
        || !validateMode(entry.mode) || entry.file.size > expected.maximumBytes) return false
      hashedBytes += entry.file.size
      if (!Number.isSafeInteger(hashedBytes) || hashedBytes > MAX_SNAPSHOT_HASHED_BYTES) return false
    }
    for (const [index, directory] of value.directories.entries()) {
      const expected = request.directories[index]
      if (!exactRecord(directory, ['segments', 'mode', 'entries'])
        || !sameArray(directory.segments, expected.segments)
        || !validateMode(directory.mode)
        || !validateDirectoryEntries(directory.entries)) return false
    }
    return true
  }
  if (!validateFileDescriptor(value.file) || value.file.name !== request.name
    || value.file.size > request.maximumBytes) return false
  if (request.operation === 'read') {
    if (typeof value.bytesBase64 !== 'string') return false
    const bytes = Buffer.from(value.bytesBase64, 'base64')
    if (bytes.toString('base64') !== value.bytesBase64 || bytes.byteLength !== value.file.size
      || createHash('sha256').update(bytes).digest('hex') !== value.file.sha256) return false
  }
  return true
}

export function validateWorldFfmpegOutputFileReceipt(value) {
  return validateFileDescriptor(value)
}

export function sameWorldFfmpegOutputFileReceipt(left, right) {
  return validateFileDescriptor(left) && validateFileDescriptor(right)
    && left.name === right.name && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.sha256 === right.sha256
}

export function sameWorldFfmpegOutputDirectoryIdentity(left, right) {
  return validateDirectoryIdentity(left) && validateDirectoryIdentity(right)
    && sameDirectoryIdentity(left, right)
}

function validateFileDescriptor(value) {
  return exactRecord(value, ['name', 'dev', 'ino', 'size', 'sha256'])
    && validDirectName(value.name)
    && /^[0-9]{1,40}$/.test(value.dev) && /^[1-9][0-9]{0,39}$/.test(value.ino)
    && Number.isSafeInteger(value.size) && value.size >= 1 && value.size <= MAX_FILE_BYTES
    && SHA256_PATTERN.test(value.sha256)
}

function validateDirectoryIdentity(value) {
  return exactRecord(value, ['dev', 'ino'])
    && typeof value.dev === 'string' && /^[0-9]{1,40}$/.test(value.dev)
    && typeof value.ino === 'string' && /^[1-9][0-9]{0,39}$/.test(value.ino)
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileIdentity(left, right) {
  return left.isFile() && right.isFile() && left.nlink === 1n && right.nlink === 1n
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

function sameStableFile(left, right) {
  return sameFileIdentity(left, right)
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function sameStableDirectoryEntry(left, right, kind) {
  const kindsMatch = kind === 'file' ? left.isFile() && right.isFile() : left.isDirectory() && right.isDirectory()
  return kindsMatch && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && (kind !== 'file' || (left.nlink === 1n && right.nlink === 1n))
}

function requireSnapshotFile(value) {
  if (!exactRecord(value, ['segments', 'name', 'maximumBytes'])
    || !validateSnapshotFile(value)) {
    throw new Error('World FFmpeg output custody snapshot file is invalid.')
  }
  return Object.freeze({
    segments: Object.freeze([...value.segments]),
    name: value.name,
    maximumBytes: value.maximumBytes,
  })
}

function validateSnapshotFile(value) {
  return exactRecord(value, ['segments', 'name', 'maximumBytes'])
    && validSegments(value.segments) && validDirectName(value.name)
    && Number.isSafeInteger(value.maximumBytes) && value.maximumBytes >= 1
    && value.maximumBytes <= MAX_SNAPSHOT_FILE_BYTES
}

function requireSnapshotHashFile(value) {
  if (!exactRecord(value, ['segments', 'name', 'maximumBytes'])
    || !validateSnapshotHashFile(value)) {
    throw new Error('World FFmpeg output custody snapshot hash file is invalid.')
  }
  return Object.freeze({
    segments: Object.freeze([...value.segments]),
    name: value.name,
    maximumBytes: value.maximumBytes,
  })
}

function validateSnapshotHashFile(value) {
  return exactRecord(value, ['segments', 'name', 'maximumBytes'])
    && validSegments(value.segments) && validDirectName(value.name)
    && Number.isSafeInteger(value.maximumBytes) && value.maximumBytes >= 1
    && value.maximumBytes <= MAX_FILE_BYTES
}

function requireSnapshotDirectory(value) {
  if (!exactRecord(value, ['segments']) || !validateSnapshotDirectory(value)) {
    throw new Error('World FFmpeg output custody snapshot directory is invalid.')
  }
  return Object.freeze({ segments: Object.freeze([...value.segments]) })
}

function validateSnapshotDirectory(value) {
  return exactRecord(value, ['segments']) && validSegments(value.segments)
}

function validSegments(value) {
  return Array.isArray(value) && value.length <= 16 && value.every(validDirectName)
}

function uniqueSnapshotPaths(files, hashFiles, directories) {
  const identities = [
    ...files.map((file) => `f:${JSON.stringify([...file.segments, file.name])}`),
    ...hashFiles.map((file) => `f:${JSON.stringify([...file.segments, file.name])}`),
    ...directories.map((directory) => `d:${JSON.stringify(directory.segments)}`),
  ]
  return new Set(identities).size === identities.length
}

function validateDirectoryEntries(value) {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_DIRECTORY_ENTRIES) return false
  let previous = ''
  for (const entry of value) {
    if (!exactRecord(entry, ['name', 'kind', 'dev', 'ino', 'size', 'mode'])
      || !validDirectName(entry.name) || entry.name <= previous
      || !['file', 'directory'].includes(entry.kind)
      || !/^[0-9]{1,40}$/.test(entry.dev) || !/^[1-9][0-9]{0,39}$/.test(entry.ino)
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !validateMode(entry.mode)) return false
    previous = entry.name
  }
  return true
}

function validateMode(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0o7777
}

function validDirectName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 255
    && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
    && !value.includes('\0') && !/[\r\n]/.test(value)
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  return sameArray(Object.keys(value).sort(codeUnitCompare), [...keys].sort(codeUnitCompare))
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

async function readStdinBounded() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.byteLength
    if (size > MAX_REQUEST_BYTES) throw new Error('World FFmpeg output custody stdin exceeded its byte bound.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

async function main() {
  if (process.argv.length !== 2) throw new Error('World FFmpeg output custody helper accepts no arguments.')
  const bytes = await readStdinBounded()
  let request
  try { request = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error('World FFmpeg output custody helper request is not valid JSON.')
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(request)}\n`))) {
    throw new Error('World FFmpeg output custody helper request is not canonical.')
  }
  const receipt = await executeRequest(request)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === HELPER_PATH) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg output custody failed.'}\n`)
    process.exitCode = 1
  })
}
