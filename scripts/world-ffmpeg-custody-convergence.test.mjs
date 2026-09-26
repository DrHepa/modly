import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { closeSync, constants, linkSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  _testOnlyRunWorldFfmpegOutputCustodyInProcess,
} from './world-ffmpeg-output-custody.mjs'
import {
  _testOnlyReadProcessStartIdentity,
  _testOnlyRemoveOwnedMutableCacheAuthority,
  _testOnlyRetireOwnedPackageDirectory,
  _testOnlyStartOuterHeartbeat,
  loadWorldFfmpegPackageToolLock,
  loadWorldFfmpegPackageResult,
} from './world-ffmpeg-package-tools.mjs'
import { loadWorldFfmpegSupplyChain } from './world-ffmpeg-supply-chain.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const RELEASE_REPOSITORY = 'modly/example'
const RELEASE_TAG = 'v1.0.0'
const RELEASE_TITLE = 'Modly Beta v1.0.0'
const RELEASE_BODY = 'World FFmpeg release evidence for v1.0.0.'
const RELEASE_COMMIT = '1'.repeat(40)
const directoryIdentity = (info) => ({ dev: String(info.dev), ino: String(info.ino) })
const MAXIMUM_WORKER_OUTPUT_BYTES = 1024 * 1024
const collectBoundedWorkerStream = (stream, label, maximumBytes = MAXIMUM_WORKER_OUTPUT_BYTES) => {
  if (!stream) return { promise: Promise.resolve('') }
  const chunks = []
  let bytes = 0
  let settled = false
  const promise = new Promise((resolvePromise, rejectPromise) => {
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      callback(value)
    }
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > maximumBytes) {
        settle(rejectPromise, new Error(`${label} exceeded ${maximumBytes} byte output bound`))
        stream.destroy()
        return
      }
      chunks.push(buffer)
    })
    stream.once('error', (error) => {
      settle(rejectPromise, new Error(`${label} stream error: ${error?.message ?? error}`))
    })
    stream.once('end', () => {
      settle(resolvePromise, Buffer.concat(chunks, bytes).toString('utf8'))
    })
  })
  promise.catch(() => undefined)
  return { promise }
}
const collectProcessClose = (child, label) => new Promise((resolvePromise, rejectPromise) => {
  child.once('error', (error) => {
    rejectPromise(new Error(`${label} failed to spawn: ${error?.message ?? error}`))
  })
  child.once('close', (code, signal) => { resolvePromise({ code, signal }) })
})
const collectChildProcess = async (child, { active, timeoutMs = 15_000, label = 'child process' } = {}) => {
  active?.add(child)
  const stdout = collectBoundedWorkerStream(child.stdout, `${label} stdout`)
  const stderr = collectBoundedWorkerStream(child.stderr, `${label} stderr`)
  const closedPromise = collectProcessClose(child, label)
  const killLiveChild = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  let timer
  const timeoutPromise = new Promise((_, rejectPromise) => {
    timer = setTimeout(() => {
      killLiveChild()
      rejectPromise(new Error(`${label} settlement timed out`))
    }, timeoutMs)
  })
  const settledPromise = Promise.all([closedPromise, stdout.promise, stderr.promise])
    .then(([closed, stdoutText, stderrText]) => ({ ...closed, stdout: stdoutText, stderr: stderrText }))
  try {
    return await Promise.race([settledPromise, timeoutPromise])
  } catch (error) {
    killLiveChild()
    await Promise.allSettled([closedPromise, stdout.promise, stderr.promise])
    throw error
  } finally {
    clearTimeout(timer)
    active?.delete(child)
    settledPromise.catch(() => undefined)
  }
}
const parseWorkerJsonResult = (result, label, phases = []) => {
  const output = result.stdout.trim()
  assert.notEqual(output, '', `${label} produced empty stdout; phases=${JSON.stringify(phases)} stderr=${result.stderr}`)
  return JSON.parse(output)
}
const fileReceipt = (name, info, bytes) => ({
  name,
  dev: String(info.dev),
  ino: String(info.ino),
  size: bytes.byteLength,
  sha256: sha256(bytes),
})
const extractorProof = (extractor, dev = '1', ino = '1') => {
  const base = {
    source: structuredClone(extractor.source),
    sha256: extractor.sha256,
    size: extractor.size,
    mode: extractor.mode,
    execution: extractor.execution,
    dev,
    ino,
  }
  if (extractor.execution === 'in-process-portable-zip-v1') {
    const identity = { dev, ino, size: extractor.size, mode: extractor.mode, mtimeNs: '1', ctimeNs: '1' }
    return { ...base, modeAuthority: 'posix', preParse: identity, postParse: { ...identity } }
  }
  return {
    ...base,
    preSpawn: { dev, ino, size: extractor.size, mtimeNs: '1', ctimeNs: '1' },
    postSpawn: { dev, ino, size: extractor.size, mtimeNs: '1', ctimeNs: '1' },
  }
}

async function createPackageUploadFixture(parent, options = {}) {
  const target = options.target ?? 'linux-x64'
  const token = options.token ?? '7'.repeat(32)
  const publicationToken = options.publicationToken ?? '8'.repeat(32)
  const suffix = target === 'win32-x64' ? '.zip' : target === 'darwin-arm64' ? '.dmg' : '.AppImage'
  const root = join(parent, `output-${token}`)
  await mkdir(root)
  const artifactName = `Modly-${target}${suffix}`
  const reportName = `WORLD_FFMPEG_BUILD_REPORT.${target}.v1.json`
  const resultName = `RESULT.${target}.v1.json`
  const artifactBytes = options.artifactBytes ?? Buffer.from(`verified deployable ${target}`)
  const reportBytes = options.reportBytes ?? Buffer.from('{}\n')
  await writeFile(join(root, artifactName), artifactBytes)
  await writeFile(join(root, reportName), reportBytes)
  const outputIdentity = directoryIdentity(await lstat(root, { bigint: true }))
  const artifactReceipt = fileReceipt(
    artifactName, await lstat(join(root, artifactName), { bigint: true }), artifactBytes,
  )
  const reportReceipt = fileReceipt(
    reportName, await lstat(join(root, reportName), { bigint: true }), reportBytes,
  )
  const extractor = (await loadWorldFfmpegPackageToolLock()).extractors[target]
  const manifest = {
    schema: 'modly.electron-builder-package-result.v1',
    attemptId: token,
    target,
    publicationToken,
    outputIdentity,
    artifacts: [{ path: artifactName, ...artifactReceipt }].map(({ name: _name, ...value }) => value),
    buildReport: { path: reportName, ...reportReceipt },
    inspection: {
      schema: 'modly.world-ffmpeg-artifact-inspection.v1', target,
      artifact: { path: artifactName, ...artifactReceipt },
      runtimeManifestSha256: 'a'.repeat(64),
      buildReportSha256: reportReceipt.sha256,
      extractor: extractorProof(extractor),
    },
  }
  delete manifest.buildReport.name
  delete manifest.inspection.artifact.name
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  await writeFile(join(root, resultName), manifestBytes)
  const manifestFile = fileReceipt(
    resultName, await lstat(join(root, resultName), { bigint: true }), manifestBytes,
  )
  return {
    target, token, publicationToken, root, artifactName, reportName, resultName,
    artifactBytes, reportBytes, manifestBytes, outputIdentity,
    resultReceipt: {
      schema: 'modly.electron-builder-package-result-receipt.v1',
      attemptId: token, target, publicationToken,
      manifestPath: join(root, resultName), outputIdentity, manifestFile,
    },
  }
}

async function createReleaseSetupReceipt(releaseClient, overrides = {}) {
  const { ensureWorldFfmpegReleaseDraft } = await import('./world-ffmpeg-release-draft.mjs')
  return ensureWorldFfmpegReleaseDraft({
    repository: overrides.repository ?? RELEASE_REPOSITORY,
    tag: overrides.tag ?? RELEASE_TAG,
    title: overrides.title ?? RELEASE_TITLE,
    body: overrides.body ?? RELEASE_BODY,
    targetCommitish: overrides.targetCommitish ?? RELEASE_COMMIT,
    releaseClient,
  })
}

test('one output-custody snapshot stays on its opened root during a path swap and rejects aliases', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'modly-output-snapshot-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, 'output')
  const replacement = join(parent, 'replacement')
  const displaced = join(parent, 'displaced')
  await mkdir(join(root, 'ffmpeg', 'linux-x64'), { recursive: true })
  await mkdir(join(replacement, 'ffmpeg', 'linux-x64'), { recursive: true })
  await writeFile(join(root, 'ffmpeg', 'linux-x64', 'manifest.json'), 'A\n')
  await writeFile(join(replacement, 'ffmpeg', 'linux-x64', 'manifest.json'), 'B\n')
  const expectedRoot = directoryIdentity(await lstat(root, { bigint: true }))
  let swapped = false
  const snapshot = await _testOnlyRunWorldFfmpegOutputCustodyInProcess({
    operation: 'snapshot',
    directory: root,
    expectedDirectoryIdentity: expectedRoot,
    files: [{ segments: ['ffmpeg', 'linux-x64'], name: 'manifest.json', maximumBytes: 32 }],
    directories: [{ segments: ['ffmpeg'] }],
  }, {
    async afterRootOpen() {
      await rename(root, displaced)
      await rename(replacement, root)
      swapped = true
    },
  })
  await rename(root, replacement)
  await rename(displaced, root)
  assert.equal(swapped, true)
  assert.deepEqual(snapshot.rootIdentity, expectedRoot)
  assert.equal(Buffer.from(snapshot.files[0].bytesBase64, 'base64').toString(), 'A\n')
  assert.deepEqual(snapshot.directories[0].entries.map((entry) => entry.name), ['linux-x64'])

  await writeFile(join(root, 'ffmpeg', 'linux-x64', 'runtime.bin'), 'runtime-bytes')
  await chmod(join(root, 'ffmpeg', 'linux-x64', 'manifest.json'), 0o644)
  await chmod(join(root, 'ffmpeg', 'linux-x64', 'runtime.bin'), 0o644)
  await chmod(join(root, 'ffmpeg', 'linux-x64'), 0o755)
  const runtimeSnapshot = await _testOnlyRunWorldFfmpegOutputCustodyInProcess({
    operation: 'snapshot',
    directory: root,
    expectedDirectoryIdentity: expectedRoot,
    files: [{ segments: ['ffmpeg', 'linux-x64'], name: 'manifest.json', maximumBytes: 32 }],
    hashFiles: [{ segments: ['ffmpeg', 'linux-x64'], name: 'runtime.bin', maximumBytes: 1024 }],
    directories: [{ segments: ['ffmpeg', 'linux-x64'] }],
  })
  assert.equal(runtimeSnapshot.hashFiles.length, 1)
  assert.equal(runtimeSnapshot.hashFiles[0].file.sha256, sha256(Buffer.from('runtime-bytes')))
  assert.equal(runtimeSnapshot.hashFiles[0].mode, 0o644)
  assert.equal(runtimeSnapshot.files[0].mode, 0o644)
  assert.equal(runtimeSnapshot.directories[0].mode, 0o755)
  assert.equal(runtimeSnapshot.directories[0].entries.find(({ name }) => name === 'runtime.bin').mode, 0o644)

  await symlink(join(root, 'ffmpeg'), join(root, 'linked'))
  await assert.rejects(_testOnlyRunWorldFfmpegOutputCustodyInProcess({
    operation: 'snapshot',
    directory: root,
    expectedDirectoryIdentity: expectedRoot,
    files: [{ segments: ['linked', 'linux-x64'], name: 'manifest.json', maximumBytes: 32 }],
    directories: [],
  }), /directory|ancestor|symbolic|invalid/i)
})

test('output custody retains POSIX special mode bits instead of normalizing unsafe executables and directories', async (t) => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(tmpdir(), 'modly-output-special-modes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin', 'ffmpeg'), 'fixture executable')
  await chmod(join(root, 'bin'), 0o2755)
  await chmod(join(root, 'bin', 'ffmpeg'), 0o4755)
  const rootIdentity = directoryIdentity(await lstat(root, { bigint: true }))
  const snapshot = await _testOnlyRunWorldFfmpegOutputCustodyInProcess({
    operation: 'snapshot',
    directory: root,
    expectedDirectoryIdentity: rootIdentity,
    files: [{ segments: ['bin'], name: 'ffmpeg', maximumBytes: 1024 }],
    directories: [{ segments: ['bin'] }],
  })
  assert.equal(snapshot.files[0].mode, 0o4755)
  assert.equal(snapshot.directories[0].mode, 0o2755)
  assert.equal(snapshot.directories[0].entries[0].mode, 0o4755)
})

test('artifact inspector opens, hashes, and executes only the retained pinned extractor inode', async (t) => {
  if (process.platform !== 'linux') return
  const {
    _testOnlyRunPinnedWorldFfmpegExtractor,
    validateWorldFfmpegExtractorContract,
  } = await import('./world-ffmpeg-artifact-inspector.mjs')
  const scratch = join(process.cwd(), 'node_modules', '.cache')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'modly-pinned-extractor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cache = join(root, 'cache')
  const toolDirectory = join(cache, '7zip@1.0.0', 'fixture', 'bin')
  const extractorPath = join(toolDirectory, '7za')
  await mkdir(toolDirectory, { recursive: true })
  await copyFile('/usr/bin/true', extractorPath)
  await chmod(extractorPath, 0o755)
  const extractorBytes = await readFile(extractorPath)
  const extractorContract = {
    source: {
      release: '7zip@1.0.0', filename: '7zip-linux-x64.tar.gz', member: 'bin/7za',
    },
    sha256: sha256(extractorBytes), size: extractorBytes.byteLength,
    mode: 0o755, execution: 'proc-self-fd',
  }
  const run = (dependencies = {}) => _testOnlyRunPinnedWorldFfmpegExtractor({
    cacheDirectory: cache,
    extractor: extractorContract,
    arguments: [],
    platform: 'linux',
  }, { resolveExtractor: async () => extractorPath, ...dependencies })

  assert.equal(validateWorldFfmpegExtractorContract({
    ...extractorContract,
    source: { ...extractorContract.source, filename: '7zip-darwin-arm64.tar.gz' },
  }, 'linux'), false)

  const proof = await run()
  assert.equal(proof.sha256, extractorContract.sha256)
  assert.equal(proof.size, extractorContract.size)
  assert.equal(proof.mode, 0o755)
  assert.equal(proof.execution, 'proc-self-fd')
  assert.match(proof.dev, /^[0-9]+$/)
  assert.match(proof.ino, /^[1-9][0-9]*$/)
  assert.deepEqual(proof.preSpawn, proof.postSpawn)

  await chmod(extractorPath, 0o4755)
  await assert.rejects(run(), /mode|extractor/i)
  await chmod(extractorPath, 0o755)
  const ordinary = join(root, 'ordinary')
  await copyFile('/usr/bin/true', ordinary)
  await rm(extractorPath)
  await symlink(ordinary, extractorPath)
  await assert.rejects(run(), /symbolic|extractor|ordinary/i)
  await rm(extractorPath)
  await link(ordinary, extractorPath)
  await assert.rejects(run(), /hardlink|extractor|ordinary/i)
  await rm(extractorPath)
  await copyFile('/usr/bin/true', extractorPath)
  await chmod(extractorPath, 0o755)
  await writeFile(extractorPath, 'swapped before open')
  await chmod(extractorPath, 0o755)
  await assert.rejects(run(), /digest|size|extractor/i)

  await copyFile('/usr/bin/true', extractorPath)
  await chmod(extractorPath, 0o755)
  const displaced = join(root, 'opened-extractor')
  await assert.rejects(run({
    async beforeSpawn() {
      await rename(extractorPath, displaced)
      await copyFile('/usr/bin/false', extractorPath)
      await chmod(extractorPath, 0o755)
    },
  }), /changed during execution/i)
  assert.equal((await readFile(extractorPath)).equals(await readFile('/usr/bin/false')), true)
})

test('Windows portable package writer and parser are deterministic and snapshot retained bytes without extraction paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-portable-zip-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const firstOutput = join(root, 'first')
  const secondOutput = join(root, 'second')
  const external = join(root, 'external')
  const extractedAlias = join(root, 'extracted-alias')
  await mkdir(join(source, 'resources', 'ffmpeg', 'win32-x64'), { recursive: true })
  await mkdir(join(source, 'resources', 'world-ffmpeg-build-reports'), { recursive: true })
  await mkdir(firstOutput)
  await mkdir(secondOutput)
  await mkdir(external)
  await symlink(external, extractedAlias, 'dir')
  await writeFile(join(source, 'Modly.exe'), 'portable executable fixture')
  await writeFile(join(source, 'Other.exe'), 'second portable executable fixture')
  await writeFile(join(source, 'resources', 'ffmpeg', 'win32-x64', 'manifest.json'), '{"runtime":true}\n')
  await writeFile(join(source, 'resources', 'world-ffmpeg-build-reports', 'win32-x64.json'), '{"report":true}\n')
  const {
    createWorldFfmpegPortableZip,
    snapshotWorldFfmpegPortableZip,
  } = await import('./world-ffmpeg-portable-zip.mjs')
  const artifactName = 'Modly-0.1.0-win32-x64.zip'
  const create = async (outputDirectory) => createWorldFfmpegPortableZip({
    sourceDirectory: source,
    outputDirectory,
    outputIdentity: directoryIdentity(await lstat(outputDirectory, { bigint: true })),
    artifactName,
    rootName: 'Modly-win32-x64',
  })
  const first = await create(firstOutput)
  const second = await create(secondOutput)
  assert.equal(first.sha256, second.sha256)
  assert.deepEqual(await readFile(first.path), await readFile(second.path))

  const retained = await open(first.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const displaced = join(root, 'retained.zip')
  await rename(first.path, displaced)
  await writeFile(first.path, Buffer.from('foreign pathname replacement'))
  try {
    const receipt = await snapshotWorldFfmpegPortableZip({
      artifactHandle: retained,
      artifactSize: first.size,
      rootName: 'Modly-win32-x64',
      target: 'win32-x64',
    })
    assert.equal(receipt.entries, 4)
    const manifest = receipt.snapshot.files.find(({ segments, file }) => (
      segments.join('/') === 'ffmpeg/win32-x64' && file.name === 'manifest.json'
    ))
    assert.equal(Buffer.from(manifest.bytesBase64, 'base64').toString(), '{"runtime":true}\n')
  } finally {
    await retained.close()
  }
  assert.deepEqual(await readdir(external), [])
  assert.equal((await lstat(extractedAlias)).isSymbolicLink(), true)
  assert.deepEqual(await readFile(first.path), Buffer.from('foreign pathname replacement'))

  const collidedOutput = join(root, 'collided')
  await mkdir(collidedOutput)
  const collided = await create(collidedOutput)
  const collidedBytes = await readFile(collided.path)
  const originalName = Buffer.from('Modly-win32-x64/Other.exe')
  const collidingName = Buffer.from('Modly-win32-x64/modly.exe')
  let nameOffset = -1
  while ((nameOffset = collidedBytes.indexOf(originalName, nameOffset + 1)) !== -1) {
    collidingName.copy(collidedBytes, nameOffset)
  }
  await writeFile(collided.path, collidedBytes)
  const collisionHandle = await open(collided.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    await assert.rejects(snapshotWorldFfmpegPortableZip({
      artifactHandle: collisionHandle,
      artifactSize: collidedBytes.byteLength,
      rootName: 'Modly-win32-x64',
      target: 'win32-x64',
    }), /collide/i)
  } finally {
    await collisionHandle.close()
  }

  const bombOutput = join(root, 'bomb')
  await mkdir(bombOutput)
  const bomb = await create(bombOutput)
  const bombBytes = await readFile(bomb.path)
  const centralOffset = bombBytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.ok(centralOffset >= 0)
  bombBytes.writeUInt32LE(0xffff_ff00, centralOffset + 20)
  bombBytes.writeUInt32LE(0xffff_ff00, centralOffset + 24)
  await writeFile(bomb.path, bombBytes)
  const bombHandle = await open(bomb.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    await assert.rejects(snapshotWorldFfmpegPortableZip({
      artifactHandle: bombHandle,
      artifactSize: bombBytes.byteLength,
      rootName: 'Modly-win32-x64',
      target: 'win32-x64',
    }), /bound|escaped|region|size/i)
  } finally {
    await bombHandle.close()
  }
})

test('Windows runner publishes the deterministic portable ZIP instead of an uninspectable installer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-windows-portable-runner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const output = join(root, 'output')
  await mkdir(project)
  await mkdir(join(output, 'win-unpacked'), { recursive: true })
  await writeFile(join(project, 'package.json'), `${JSON.stringify({
    name: 'modly', productName: 'Modly', version: '0.1.0',
  })}\n`)
  const runner = await import('./world-ffmpeg-electron-builder-runner.cjs')
  let observed
  const artifact = await runner._testOnlyCreateWindowsPortableArtifact({
    projectDir: project,
    attempt: { outputDirectory: output },
    outputRootIdentity: directoryIdentity(await lstat(output, { bigint: true })),
    async createPortableZip(input) {
      observed = input
      const path = join(input.outputDirectory, input.artifactName)
      const bytes = Buffer.from('deterministic injected portable ZIP')
      await writeFile(path, bytes)
      return { path, name: input.artifactName, size: bytes.byteLength, sha256: sha256(bytes) }
    },
  })
  assert.equal(artifact, join(output, 'Modly-0.1.0-win32-x64.zip'))
  assert.equal(observed.sourceDirectory, join(output, 'win-unpacked'))
  assert.equal(observed.rootName, 'Modly-win32-x64')
  assert.deepEqual(observed.outputIdentity, directoryIdentity(await lstat(output, { bigint: true })))
  const config = JSON.parse(await readFile(new URL('./world-ffmpeg-electron-builder-config.json', import.meta.url)))
  assert.equal(config.win.target, 'dir')
  assert.equal(config.win.artifactName, '${productName}-${version}-win32-x64.${ext}')
})

test('Windows inspector uses LF-pinned parser bytes and host-truthful mode authority', async (t) => {
  const {
    _testOnlyOpenWorldFfmpegPortableZipAuthority,
    validateWorldFfmpegExtractorContract,
  } = await import('./world-ffmpeg-artifact-inspector.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-windows-parser-authority-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parserPath = join(root, 'world-ffmpeg-portable-zip.mjs')
  await copyFile(new URL('./world-ffmpeg-portable-zip.mjs', import.meta.url), parserPath)
  await chmod(parserPath, 0o644)
  const bytes = await readFile(parserPath)
  const contract = {
    source: {
      release: 'modly-world-ffmpeg-portable-zip@1',
      filename: 'world-ffmpeg-portable-zip.mjs',
      member: 'module',
    },
    sha256: sha256(bytes), size: bytes.byteLength, mode: 0o644,
    execution: 'in-process-portable-zip-v1',
  }
  assert.equal(validateWorldFfmpegExtractorContract(contract, 'win32'), true)
  const authority = await _testOnlyOpenWorldFfmpegPortableZipAuthority(contract, {
    parserPath, platform: 'linux',
  })
  assert.equal(typeof authority.module.snapshotWorldFfmpegPortableZip, 'function')
  const proof = await authority.finalize()
  assert.equal(proof.execution, 'in-process-portable-zip-v1')
  assert.equal(proof.sha256, contract.sha256)
  assert.equal(proof.mode, 0o644)
  assert.deepEqual(proof.preParse, proof.postParse)

  await chmod(parserPath, 0o600)
  await assert.rejects(_testOnlyOpenWorldFfmpegPortableZipAuthority(contract, {
    parserPath, platform: 'linux',
  }), /mode|identity/i)
  const windowsAuthority = await _testOnlyOpenWorldFfmpegPortableZipAuthority(contract, {
    parserPath, platform: 'win32',
  })
  const windowsProof = await windowsAuthority.finalize()
  assert.equal(windowsProof.mode, null)
  assert.equal(windowsProof.preParse.mode, null)
  await chmod(parserPath, 0o644)

  const lfBytes = await readFile(parserPath, 'utf8')
  await writeFile(parserPath, lfBytes.replaceAll('\n', '\r\n'))
  await assert.rejects(_testOnlyOpenWorldFfmpegPortableZipAuthority(contract, {
    parserPath, platform: 'win32',
  }), /digest|size/i)
  await writeFile(parserPath, bytes)
  await chmod(parserPath, 0o644)

  const replacement = await _testOnlyOpenWorldFfmpegPortableZipAuthority(contract, {
    parserPath, platform: 'linux',
  })
  const displaced = `${parserPath}.opened`
  await rename(parserPath, displaced)
  await writeFile(parserPath, 'export const foreign = true\n')
  await assert.rejects(replacement.finalize(), /portable parser.*replaced|identity changed/i)
  assert.equal(await readFile(parserPath, 'utf8'), 'export const foreign = true\n')
})

test('package verifier consumes the retained Windows archive snapshot without a resources pathname', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-windows-archive-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const output = join(root, 'output')
  const target = 'win32-x64'
  await mkdir(join(source, 'resources', 'ffmpeg', target, 'bin'), { recursive: true })
  await mkdir(join(source, 'resources', 'world-ffmpeg-build-reports'), { recursive: true })
  await mkdir(output)
  await writeFile(join(source, 'Modly.exe'), 'portable application')
  const runtimeFiles = new Map([
    ['LICENSE.txt', Buffer.from('GNU LESSER GENERAL PUBLIC LICENSE\n')],
    ['bin/ffmpeg.exe', Buffer.from('portable ffmpeg executable\n')],
    ['bin/avcodec-61.dll', Buffer.from('portable avcodec shared library\n')],
  ])
  for (const [path, bytes] of runtimeFiles) {
    const destination = join(source, 'resources', 'ffmpeg', target, ...path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
  const supply = await loadWorldFfmpegSupplyChain()
  const {
    resolvePackagedWorldFfmpegRuntime,
    WORLD_FFMPEG_RUNTIME_SCHEMA,
  } = await import('../electron/main/world-render-ffmpeg-runtime.ts')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const manifest = {
    schema: WORLD_FFMPEG_RUNTIME_SCHEMA,
    target,
    ffmpegVersion: '7.1.1',
    signingKeyId: 'windows-archive-key',
    build: supply.build,
    directories: [{ path: '.', mode: null }, { path: 'bin', mode: null }],
    license: {
      path: 'LICENSE.txt', size: runtimeFiles.get('LICENSE.txt').byteLength,
      sha256: sha256(runtimeFiles.get('LICENSE.txt')), mode: null,
    },
    executable: {
      path: 'bin/ffmpeg.exe', size: runtimeFiles.get('bin/ffmpeg.exe').byteLength,
      sha256: sha256(runtimeFiles.get('bin/ffmpeg.exe')), mode: null,
    },
    sharedLibraries: [{
      path: 'bin/avcodec-61.dll', size: runtimeFiles.get('bin/avcodec-61.dll').byteLength,
      sha256: sha256(runtimeFiles.get('bin/avcodec-61.dll')), mode: null,
    }],
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  await writeFile(join(source, 'resources', 'ffmpeg', target, 'manifest.json'), manifestBytes)
  await writeFile(
    join(source, 'resources', 'ffmpeg', target, 'manifest.sig'),
    sign(null, manifestBytes, privateKey),
  )
  for (const distribution of supply.distributionFiles) {
    const repositoryPath = join(process.cwd(), distribution.path)
    const destination = distribution.path === 'THIRD_PARTY_NOTICES.md'
      ? join(source, 'resources', distribution.path)
      : join(source, distribution.path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(repositoryPath, destination)
  }
  const reportBytes = Buffer.from('{}\n')
  await writeFile(join(source, 'resources', 'world-ffmpeg-build-reports', `${target}.json`), reportBytes)

  const { createWorldFfmpegPortableZip, snapshotWorldFfmpegPortableZip } = await import('./world-ffmpeg-portable-zip.mjs')
  const artifact = await createWorldFfmpegPortableZip({
    sourceDirectory: source,
    outputDirectory: output,
    outputIdentity: directoryIdentity(await lstat(output, { bigint: true })),
    artifactName: 'Modly-win32-x64.zip',
    rootName: 'Modly-win32-x64',
  })
  const artifactHandle = await open(artifact.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let archiveSnapshot
  try {
    archiveSnapshot = (await snapshotWorldFfmpegPortableZip({
      artifactHandle,
      artifactSize: artifact.size,
      rootName: 'Modly-win32-x64',
      target,
    })).snapshot
  } finally {
    await artifactHandle.close()
  }

  const externalReport = join(output, 'WORLD_FFMPEG_BUILD_REPORT.win32-x64.v1.json')
  await writeFile(externalReport, reportBytes)
  const externalReceipt = fileReceipt(
    'WORLD_FFMPEG_BUILD_REPORT.win32-x64.v1.json',
    await lstat(externalReport, { bigint: true }),
    reportBytes,
  )
  const outputIdentity = directoryIdentity(await lstat(output, { bigint: true }))
  let custodyCalls = 0
  const { verifyWorldFfmpegPackage } = await import('./verify-world-ffmpeg-package.ts')
  const verification = await verifyWorldFfmpegPackage({
    platform: 'win32', arch: 'x64', trustFile: '/trusted/build-trust.json',
    resourcesPath: '/path/that/must/not/be-read',
    buildReportDirectory: output,
    buildReportDirectoryIdentity: outputIdentity,
    buildReportName: externalReceipt.name,
    buildReportReceipt: externalReceipt,
  }, {
    packageSnapshot: archiveSnapshot,
    outputCustody: async (request) => {
      custodyCalls += 1
      assert.equal(request.operation, 'read')
      assert.equal(request.directory, output)
      return {
        rootIdentity: outputIdentity,
        directoryIdentity: outputIdentity,
        file: externalReceipt,
        bytesBase64: reportBytes.toString('base64'),
      }
    },
    loadBuildTrust: async () => ({
      keys: { 'windows-archive-key': publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      bytes: Buffer.from('trusted build key'),
    }),
    loadSupplyChain: async () => supply,
    resolveRuntime: resolvePackagedWorldFfmpegRuntime,
    validateBuildReport: () => true,
    supplyChainBytes: Buffer.from('{}\n'),
  })
  assert.equal(verification.runtimeManifestSha256, sha256(manifestBytes))
  assert.equal(custodyCalls, 1)
})

test('injected Darwin and Windows process identities distinguish live, dead, and PID reuse without PID-only probes', async () => {
  const calls = []
  const probe = (stdout, code = 0) => (file, args, options) => {
    calls.push({ file, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.kill = () => true
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', stdout)
      child.emit('close', code, null)
    })
    return child
  }
  const darwinToken = 'a'.repeat(32)
  const darwinMarker = `--world-ffmpeg-attempt=${darwinToken}`
  const darwinA = await _testOnlyReadProcessStartIdentity(42, {
    platform: 'darwin', attemptToken: darwinToken,
    spawnProcess: probe(`Sat Sep  5 12:34:56 2026 /trusted/node offline.mjs ${darwinMarker}\n`),
  })
  const darwinB = await _testOnlyReadProcessStartIdentity(42, {
    platform: 'darwin', attemptToken: darwinToken,
    spawnProcess: probe(`Sat Sep  5 12:34:56 2026 /trusted/node other.mjs ${darwinMarker}\n`),
  })
  assert.match(darwinA, /^darwin-ps-start-command:[a-f0-9]{64}$/)
  assert.notEqual(darwinA, darwinB)
  assert.equal(await _testOnlyReadProcessStartIdentity(42, {
    platform: 'darwin', attemptToken: darwinToken,
    spawnProcess: probe('Sat Sep  5 12:34:56 2026 /trusted/node reused.mjs --world-ffmpeg-attempt=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'),
  }), 'unavailable')
  assert.equal(await _testOnlyReadProcessStartIdentity(42, {
    platform: 'darwin', attemptToken: darwinToken, spawnProcess: probe('', 1),
  }), null)
  assert.deepEqual(calls[0].args, ['-ww', '-p', '42', '-o', 'lstart=', '-o', 'command='])
  assert.equal(calls[0].file, '/bin/ps')
  assert.equal(calls[0].options.shell, false)

  const environment = { SystemRoot: 'C:\\Windows', WINDIR: 'c:\\WINDOWS' }
  const windowsA = await _testOnlyReadProcessStartIdentity(77, {
    platform: 'win32', environment, spawnProcess: probe('638927876960000000'),
  })
  const windowsB = await _testOnlyReadProcessStartIdentity(77, {
    platform: 'win32', environment, spawnProcess: probe('638927876970000000'),
  })
  assert.equal(windowsA, 'win32-process-start:638927876960000000')
  assert.notEqual(windowsA, windowsB)
  assert.equal(await _testOnlyReadProcessStartIdentity(77, {
    platform: 'win32', environment, spawnProcess: probe('', 3),
  }), null)
  const windowsCall = calls.find(({ file }) => file.includes('WindowsPowerShell'))
  assert.equal(windowsCall.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(windowsCall.options.shell, false)
  assert.match(windowsCall.args.at(-1), /Get-Process -Id 77/)

  const runner = (await import('./world-ffmpeg-electron-builder-runner.cjs')).default
  const syncCalls = []
  const syncProbe = (stdout, status = 0) => (file, args, options) => {
    syncCalls.push({ file, args, options })
    return { stdout, status, signal: null }
  }
  assert.match(runner._testOnlyReadProcessStartIdentity(42, {
    platform: 'darwin', attemptToken: darwinToken,
    spawnSync: syncProbe(`Sat Sep  5 12:34:56 2026 /trusted/node runner.cjs ${darwinMarker}\n`),
  }), /^darwin-ps-start-command:[a-f0-9]{64}$/)
  assert.equal(runner._testOnlyReadProcessStartIdentity(77, {
    platform: 'win32', environment, spawnSync: syncProbe('638927876960000000'),
  }), windowsA)
  assert.equal(syncCalls[0].file, '/bin/ps')
  assert.equal(syncCalls[1].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(syncCalls.every(({ options }) => options.shell === false), true)
})

test('outer, generic, and runner authority cleanup quarantine exact inodes and preserve same-name replacements', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-authority-quarantine-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const token = '4'.repeat(32)
  const outerPath = join(root, `outer-${token}.heartbeat`)
  const outer = await _testOnlyStartOuterHeartbeat({
    rootDirectory: root,
    outerHeartbeatPath: outerPath,
    record: {
      token, target: 'linux-x64', ownerIdentity: '5'.repeat(32),
      ownerPid: process.pid, ownerStartIdentity: 'linux-proc-start:1',
    },
  }, {
    heartbeatIntervalMs: 60_000,
    now: Date.now,
    async afterAuthorityQuarantine({ path }) {
      await writeFile(path, 'foreign outer replacement')
    },
  })
  await assert.rejects(outer.stop(), /outer heartbeat was replaced during (?:cleanup|retirement)/i)
  assert.equal(await readFile(outerPath, 'utf8'), 'foreign outer replacement')

  const terminalPath = join(root, `terminal-${token}.json`)
  await writeFile(terminalPath, '{"owned":true}\n')
  await assert.rejects(_testOnlyRemoveOwnedMutableCacheAuthority(
    terminalPath,
    'runner terminal receipt',
    async (candidatePath) => ({ bytes: await readFile(candidatePath, 'utf8') }),
    {
      async afterQuarantine({ path }) {
        await writeFile(path, 'foreign terminal replacement')
      },
    },
  ), /runner terminal receipt was replaced during (?:cleanup|retirement)/i)
  assert.equal(await readFile(terminalPath, 'utf8'), 'foreign terminal replacement')

  const runner = (await import('./world-ffmpeg-electron-builder-runner.cjs')).default
  const runnerPath = join(root, `runner-${token}.heartbeat`)
  const runnerHeartbeat = runner._testOnlyStartRunnerHeartbeat({
    attemptId: token,
    target: 'linux-x64',
    heartbeatPath: runnerPath,
  }, '6'.repeat(32), 'linux-proc-start:1', {
    intervalMs: 60_000,
    afterQuarantine({ path }) {
      writeFileSync(path, 'foreign runner replacement')
    },
  })
  assert.throws(() => runnerHeartbeat.stop(), /runner heartbeat was replaced during (?:cleanup|retirement)/i)
  assert.equal(await readFile(runnerPath, 'utf8'), 'foreign runner replacement')
})

test('final retirement never deletes a foreign replacement at an owned quarantine pathname', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-final-retirement-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let authorityQuarantine
  const replaceFileQuarantine = async ({ quarantinePath }) => {
    authorityQuarantine = quarantinePath
    await rename(quarantinePath, `${quarantinePath}.owned`)
    await writeFile(quarantinePath, 'foreign final replacement')
  }
  const authorityPath = join(root, 'terminal.json')
  await writeFile(authorityPath, '{"owned":true}\n')
  await assert.rejects(_testOnlyRemoveOwnedMutableCacheAuthority(
    authorityPath,
    'terminal',
    async (candidatePath) => ({ bytes: await readFile(candidatePath, 'utf8') }),
    { beforeRetirement: replaceFileQuarantine },
  ), /retirement|quarantine|changed/i)
  assert.equal(await readFile(authorityQuarantine, 'utf8'), 'foreign final replacement')
  assert.equal((await lstat(`${authorityQuarantine}.owned`)).size, 0)

  const runner = (await import('./world-ffmpeg-electron-builder-runner.cjs')).default
  const runnerPath = join(root, 'runner.heartbeat')
  let runnerQuarantine
  const heartbeat = runner._testOnlyStartRunnerHeartbeat({
    attemptId: 'a'.repeat(32), target: 'linux-x64', heartbeatPath: runnerPath,
  }, 'b'.repeat(32), 'linux-proc-start:1', {
    intervalMs: 60_000,
    beforeRetirement({ quarantinePath }) {
      runnerQuarantine = quarantinePath
      renameSync(quarantinePath, `${quarantinePath}.owned`)
      writeFileSync(quarantinePath, 'foreign runner final replacement')
    },
  })
  assert.throws(() => heartbeat.stop(), /retirement|quarantine|changed/i)
  assert.equal(await readFile(runnerQuarantine, 'utf8'), 'foreign runner final replacement')
  assert.equal((await lstat(`${runnerQuarantine}.owned`)).size, 0)

  const directoryPath = join(root, 'output-owned')
  await mkdir(directoryPath)
  await writeFile(join(directoryPath, 'large.bin'), 'owned directory payload')
  const directoryId = directoryIdentity(await lstat(directoryPath, { bigint: true }))
  let directoryQuarantine
  await assert.rejects(_testOnlyRetireOwnedPackageDirectory({
    path: directoryPath, expectedIdentity: directoryId,
  }, {
    async beforeRetirement({ quarantinePath }) {
      directoryQuarantine = quarantinePath
      await rename(quarantinePath, `${quarantinePath}.owned`)
      await mkdir(quarantinePath)
      await writeFile(join(quarantinePath, 'foreign.bin'), 'foreign directory final replacement')
    },
  }), /retirement|quarantine|identity/i)
  assert.equal(await readFile(join(directoryQuarantine, 'foreign.bin'), 'utf8'), 'foreign directory final replacement')
  assert.equal((await lstat(join(`${directoryQuarantine}.owned`, 'large.bin'))).size, 0)

  const inspectionPath = join(root, '.inspection-linux-x64-owned')
  await mkdir(inspectionPath)
  await writeFile(join(inspectionPath, 'payload'), 'owned inspection payload')
  const inspectionId = directoryIdentity(await lstat(inspectionPath, { bigint: true }))
  let inspectionQuarantine
  const { _testOnlyRetireWorldFfmpegInspectionDirectory } = await import('./world-ffmpeg-artifact-inspector.mjs')
  await assert.rejects(_testOnlyRetireWorldFfmpegInspectionDirectory(
    inspectionPath,
    inspectionId,
    {
      async beforeRetirement({ quarantinePath }) {
        inspectionQuarantine = quarantinePath
        await rename(quarantinePath, `${quarantinePath}.owned`)
        await mkdir(quarantinePath)
        await writeFile(join(quarantinePath, 'foreign'), 'foreign inspection final replacement')
      },
    },
  ), /retirement|quarantine|identity/i)
  assert.equal(await readFile(join(inspectionQuarantine, 'foreign'), 'utf8'), 'foreign inspection final replacement')
  assert.equal((await lstat(join(`${inspectionQuarantine}.owned`, 'payload'))).size, 0)
})

test('identity-owned garbage collection reclaims retained bytes, records receipts, and preserves final ABA replacements', async (t) => {
  const {
    quarantineAndReclaimWorldFfmpegDirectory,
    reclaimWorldFfmpegDirectoryQuarantine,
  } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const owned = join(root, 'owned')
  await mkdir(join(owned, 'nested'), { recursive: true })
  await writeFile(join(owned, 'nested', 'bulk.bin'), Buffer.alloc(1024 * 1024, 0x61))
  const result = await quarantineAndReclaimWorldFfmpegDirectory({
    path: owned,
    expectedIdentity: directoryIdentity(await lstat(owned, { bigint: true })),
    label: 'test-owned-output',
  })
  assert.equal(result.schema, 'modly.world-ffmpeg-owned-garbage-receipt.v1')
  assert.equal(result.reclaimedBytes, 1024 * 1024)
  assert.equal((await lstat(join(result.quarantinePath, 'nested', 'bulk.bin'))).size, 0)
  assert.equal(JSON.parse(await readFile(join(result.quarantinePath, '.WORLD_FFMPEG_GC.v1.json'))).reclaimedBytes, 1024 * 1024)

  const racing = join(root, 'racing')
  await mkdir(racing)
  await writeFile(join(racing, 'bulk.bin'), Buffer.alloc(4096, 0x62))
  let displaced
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: racing,
    expectedIdentity: directoryIdentity(await lstat(racing, { bigint: true })),
    label: 'test-racing-output',
    async beforeFileReclaim({ absolutePath }) {
      displaced = `${absolutePath}.owned`
      await rename(absolutePath, displaced)
      await writeFile(absolutePath, Buffer.from('foreign replacement must survive'))
    },
  }), /foreign replacement|identity changed/i)
  assert.equal(await readFile(join(dirname(displaced), 'bulk.bin'), 'utf8'), 'foreign replacement must survive')
  assert.equal((await lstat(displaced)).size, 0)

  const pending = join(root, '.pending.remove-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  await mkdir(pending)
  const pendingIdentity = directoryIdentity(await lstat(pending, { bigint: true }))
  await assert.rejects(reclaimWorldFfmpegDirectoryQuarantine({
    quarantinePath: pending,
    expectedIdentity: pendingIdentity,
    label: 'pending-recovery',
    quarantinedAtMs: 10_000,
    nowMs: 10_500,
    minimumAgeMs: 1_000,
  }), /grace/i)

  const restart = join(root, '.restart.remove-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  await mkdir(join(restart, 'nested'), { recursive: true })
  await writeFile(join(restart, 'nested', 'bulk.bin'), Buffer.alloc(8192, 0x63))
  const restarted = await reclaimWorldFfmpegDirectoryQuarantine({
    quarantinePath: restart,
    expectedIdentity: directoryIdentity(await lstat(restart, { bigint: true })),
    label: 'restart-recovery',
    quarantinedAtMs: 1_000,
    nowMs: 2_000,
    minimumAgeMs: 500,
  })
  assert.equal(restarted.reclaimedBytes, 8192)
  assert.equal((await lstat(join(restarted.quarantinePath, 'nested', 'bulk.bin'))).size, 0)
  await assert.rejects(lstat(restart), /ENOENT/)

  const nestedRace = join(root, 'nested-race')
  await mkdir(join(nestedRace, 'child'), { recursive: true })
  await writeFile(join(nestedRace, 'child', 'bulk.bin'), Buffer.alloc(4096, 0x64))
  let displacedChild
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: nestedRace,
    expectedIdentity: directoryIdentity(await lstat(nestedRace, { bigint: true })),
    label: 'nested-race-recovery',
    async afterDirectoryReclaim({ absolutePath, relativePath }) {
      if (relativePath !== 'child') return
      displacedChild = `${absolutePath}.owned`
      await rename(absolutePath, displacedChild)
      await mkdir(absolutePath)
      await writeFile(join(absolutePath, 'foreign.bin'), 'foreign nested replacement')
    },
  }), /foreign replacement|identity changed/i)
  assert.equal(await readFile(join(dirname(displacedChild), 'child', 'foreign.bin'), 'utf8'), 'foreign nested replacement')
  assert.equal((await lstat(join(displacedChild, 'bulk.bin'))).size, 0)

  const cycleResults = []
  for (let index = 0; index < 70; index += 1) {
    const cycle = join(root, `cycle-${String(index).padStart(2, '0')}`)
    await mkdir(cycle)
    await writeFile(join(cycle, 'bulk.bin'), Buffer.alloc(4096, index))
    cycleResults.push(await quarantineAndReclaimWorldFfmpegDirectory({
      path: cycle,
      expectedIdentity: directoryIdentity(await lstat(cycle, { bigint: true })),
      label: 'repeated-package-cycle',
    }))
  }
  assert.equal(cycleResults.length, 70)
  for (const cycle of cycleResults) {
    assert.equal((await lstat(join(cycle.quarantinePath, 'bulk.bin'))).size, 0)
    assert.ok((await lstat(join(cycle.quarantinePath, '.WORLD_FFMPEG_GC.v1.json'))).size < 4096)
  }

})

test('cleanup intents recover crashes before rename, after quarantine, and during reclaim without deleting replacements', async (t) => {
  const {
    quarantineAndReclaimWorldFfmpegDirectory,
    quarantineAndReclaimWorldFfmpegFile,
    recoverWorldFfmpegOwnedGarbage,
  } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-restart-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  for (const checkpoint of [
    'intent-durable',
    'after-quarantine',
    'during-reclaim',
    'after-receipt',
    'completion-temp-write',
    'completion-temp-sync',
    'completion-rename',
    'completion-directory-sync',
  ]) {
    const source = join(root, checkpoint)
    await mkdir(join(source, 'nested'), { recursive: true })
    await writeFile(join(source, 'a.bin'), Buffer.alloc(4096, 0x61))
    await writeFile(join(source, 'nested', 'b.bin'), Buffer.alloc(4096, 0x62))
    let authority
    let durableIntentBytes
    let interrupted = false
    await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
      path: source,
      expectedIdentity: directoryIdentity(await lstat(source, { bigint: true })),
      label: `restart-${checkpoint}`,
      async afterIntentDurable(value) {
        authority = value
        durableIntentBytes = await readFile(value.intentPath)
        const intent = JSON.parse(durableIntentBytes.toString('utf8'))
        assert.equal(intent.schema, 'modly.world-ffmpeg-owned-garbage-intent.v1')
        assert.equal(intent.sourceName, checkpoint)
        assert.equal(intent.quarantineName, value.quarantinePath.split('/').at(-1))
        assert.equal(intent.maximumBytes >= intent.plannedBytes, true)
        if (checkpoint === 'intent-durable') throw new Error(`fixture crash at ${checkpoint}`)
      },
      async afterQuarantine() {
        if (checkpoint === 'after-quarantine') throw new Error(`fixture crash at ${checkpoint}`)
      },
      async afterFileReclaim() {
        if (checkpoint === 'during-reclaim' && !interrupted) {
          interrupted = true
          throw new Error(`fixture crash at ${checkpoint}`)
        }
      },
      async afterReceiptDurable() {
        if (checkpoint === 'after-receipt') throw new Error(`fixture crash at ${checkpoint}`)
      },
      async afterCompletionTempWrite() {
        if (checkpoint === 'completion-temp-write') throw new Error(`fixture crash at ${checkpoint}`)
      },
      async afterCompletionTempSync() {
        if (checkpoint === 'completion-temp-sync') throw new Error(`fixture crash at ${checkpoint}`)
      },
      async afterCompletionRename() {
        if (checkpoint === 'completion-rename') throw new Error(`fixture crash at ${checkpoint}`)
      },
      async afterCompletionDirectorySync() {
        if (checkpoint === 'completion-directory-sync') throw new Error(`fixture crash at ${checkpoint}`)
      },
    }), new RegExp(`fixture crash at ${checkpoint}`))
    assert.ok(authority)

    if (checkpoint === 'after-quarantine') {
      await mkdir(source)
      await writeFile(join(source, 'foreign.txt'), 'foreign active-name replacement')
    }
    const recovered = await recoverWorldFfmpegOwnedGarbage({
      parentDirectory: root,
      minimumAgeMs: 0,
    })
    if (checkpoint === 'completion-temp-sync'
      || checkpoint === 'completion-rename' || checkpoint === 'completion-directory-sync') {
      assert.equal(recovered.completed >= 1, true, `${checkpoint}: ${JSON.stringify(recovered)}`)
    } else {
      assert.equal(recovered.recovered >= 1, true, `${checkpoint}: ${JSON.stringify(recovered)}`)
    }
    const tombstone = JSON.parse(await readFile(authority.completionPath, 'utf8'))
    assert.deepEqual(await readFile(authority.intentPath), durableIntentBytes)
    assert.equal(tombstone.schema, 'modly.world-ffmpeg-owned-garbage-tombstone.v1')
    assert.equal(tombstone.quarantineName, authority.quarantinePath.split('/').at(-1))
    assert.equal((await lstat(dirname(authority.quarantinePath))).isDirectory(), true)
    assert.equal((await lstat(join(authority.quarantinePath, 'a.bin'))).size, 0)
    assert.ok((await lstat(join(authority.quarantinePath, '.WORLD_FFMPEG_GC.v1.json'))).isFile())
    if (checkpoint === 'after-quarantine') {
      assert.equal(await readFile(join(source, 'foreign.txt'), 'utf8'), 'foreign active-name replacement')
    } else {
      await assert.rejects(lstat(source), /ENOENT/)
    }
  }

  const authorityPath = join(root, 'terminal.json')
  await writeFile(authorityPath, '{"owned":true}\n')
  let fileAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegFile({
    path: authorityPath,
    label: 'restart-authority-file',
    async afterIntentDurable(value) { fileAuthority = value },
    async afterQuarantine() { throw new Error('fixture file crash after quarantine') },
  }), /fixture file crash after quarantine/)
  await writeFile(authorityPath, 'foreign authority replacement')
  await recoverWorldFfmpegOwnedGarbage({ parentDirectory: root, minimumAgeMs: 0 })
  assert.equal(await readFile(authorityPath, 'utf8'), 'foreign authority replacement')
  assert.equal((await lstat(dirname(fileAuthority.quarantinePath))).isDirectory(), true)
  assert.equal((await lstat(fileAuthority.quarantinePath)).size, 0)
  assert.ok((await lstat(`${fileAuthority.quarantinePath}.GC.v1.json`)).isFile())
  assert.equal(
    JSON.parse(await readFile(fileAuthority.completionPath, 'utf8')).schema,
    'modly.world-ffmpeg-owned-garbage-tombstone.v1',
  )

  const runner = (await import('./world-ffmpeg-electron-builder-runner.cjs')).default
  for (const [runnerCheckpoint, hook] of [
    ['claim', 'afterClaimDurable'],
    ['receipt', 'afterReceiptDurable'],
    ['completion-temp-write', 'afterCompletionTempWrite'],
    ['completion-temp-sync', 'afterCompletionTempSync'],
    ['completion-rename', 'afterCompletionRename'],
    ['completion-directory-sync', 'afterCompletionDirectorySync'],
  ]) {
    const runnerPath = join(root, `runner-${runnerCheckpoint}.heartbeat`)
    let runnerAuthority
    const heartbeat = runner._testOnlyStartRunnerHeartbeat({
      attemptId: sha256(Buffer.from(runnerCheckpoint)).slice(0, 32),
      target: 'linux-x64',
      heartbeatPath: runnerPath,
    }, 'e'.repeat(32), 'linux-proc-start:1', {
      intervalMs: 60_000,
      [hook](value) {
        runnerAuthority = value
        throw new Error(`fixture runner crash at ${runnerCheckpoint}`)
      },
    })
    assert.throws(() => heartbeat.stop(), new RegExp(`fixture runner crash at ${runnerCheckpoint}`))
    assert.ok(runnerAuthority)
    await recoverWorldFfmpegOwnedGarbage({ parentDirectory: root, minimumAgeMs: 0 })
    assert.equal((await lstat(dirname(runnerAuthority.quarantinePath))).isDirectory(), true)
    assert.equal((await lstat(runnerAuthority.quarantinePath)).size, 0)
    assert.ok((await lstat(`${runnerAuthority.quarantinePath}.GC.v1.json`)).isFile())
    assert.equal(
      JSON.parse(await readFile(runnerAuthority.intentPath, 'utf8')).schema,
      'modly.world-ffmpeg-owned-garbage-intent.v1',
    )
    assert.equal(
      JSON.parse(await readFile(runnerAuthority.completionPath, 'utf8')).schema,
      'modly.world-ffmpeg-owned-garbage-tombstone.v1',
    )
  }

  const unclaimed = join(root, `.foreign.remove-${'f'.repeat(32)}`)
  await mkdir(unclaimed)
  await writeFile(join(unclaimed, 'foreign.bin'), 'foreign unclaimed generation')
  const enumerated = await recoverWorldFfmpegOwnedGarbage({ parentDirectory: root, minimumAgeMs: 0 })
  assert.deepEqual(enumerated.unclaimed, [unclaimed.split('/').at(-1)])
  assert.equal(await readFile(join(unclaimed, 'foreign.bin'), 'utf8'), 'foreign unclaimed generation')
})

test('garbage byte bounds preflight the whole generation and cover the public 64 GiB package-output contract', async (t) => {
  const {
    quarantineAndReclaimWorldFfmpegDirectory,
    WORLD_FFMPEG_PACKAGE_OUTPUT_GARBAGE_MAXIMUM_BYTES,
  } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-bounds-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const over = join(root, 'over')
  await mkdir(over)
  await writeFile(join(over, 'a.bin'), '123456')
  await writeFile(join(over, 'b.bin'), 'abcdef')
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: over,
    expectedIdentity: directoryIdentity(await lstat(over, { bigint: true })),
    label: 'over-cap-output',
    maximumBytes: 10,
  }), /byte bound/i)
  assert.equal(await readFile(join(over, 'a.bin'), 'utf8'), '123456')
  assert.equal(await readFile(join(over, 'b.bin'), 'utf8'), 'abcdef')
  assert.equal((await readdir(root)).some((name) => name.startsWith('.over.remove-')), false)

  const recovered = await quarantineAndReclaimWorldFfmpegDirectory({
    path: over,
    expectedIdentity: directoryIdentity(await lstat(over, { bigint: true })),
    label: 'within-cap-output',
    maximumBytes: 12,
  })
  assert.equal(recovered.reclaimedBytes, 12)

  const publicArtifactTotal = 64 * 1024 * 1024 * 1024
  assert.equal(
    WORLD_FFMPEG_PACKAGE_OUTPUT_GARBAGE_MAXIMUM_BYTES >= publicArtifactTotal + 1024 * 1024 + 128 * 1024,
    true,
  )
  const sparse = join(root, 'sparse-over-old-default')
  await mkdir(sparse)
  const sparseHandle = await open(join(sparse, 'artifact.bin'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
  const sparseBytes = 32 * 1024 * 1024 * 1024 + 1
  try { await sparseHandle.truncate(sparseBytes) } finally { await sparseHandle.close() }
  const sparseResult = await quarantineAndReclaimWorldFfmpegDirectory({
    path: sparse,
    expectedIdentity: directoryIdentity(await lstat(sparse, { bigint: true })),
    label: 'public-package-output-bound',
  })
  assert.equal(sparseResult.reclaimedBytes, sparseBytes)
  assert.equal((await lstat(join(sparseResult.quarantinePath, 'artifact.bin'))).size, 0)
})

test('garbage recovery applies caller ceilings and isolates malformed or token-mismatched authorities', async (t) => {
  const {
    quarantineAndReclaimWorldFfmpegDirectory,
    recoverWorldFfmpegOwnedGarbage,
  } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const bounded = join(root, 'bounded')
  await mkdir(bounded)
  const boundedBytes = Buffer.from('caller ceiling must win')
  await writeFile(join(bounded, 'payload.bin'), boundedBytes)
  let boundedAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: bounded,
    expectedIdentity: directoryIdentity(await lstat(bounded, { bigint: true })),
    label: 'caller-policy-bounded',
    maximumBytes: 1024,
    async afterIntentDurable(value) {
      boundedAuthority = value
      throw new Error('fixture owner crash before bounded recovery')
    },
  }), /fixture owner crash/)
  const refused = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 10,
    maximumBytes: boundedBytes.byteLength - 1,
  })
  assert.equal(refused.failures.some(({ message }) => /caller|policy|byte bound/i.test(message)), true)
  assert.deepEqual(await readFile(join(bounded, 'payload.bin')), boundedBytes)
  await assert.rejects(lstat(boundedAuthority.quarantinePath), /ENOENT/)
  const accepted = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 10,
    maximumBytes: 1024,
  })
  assert.equal(accepted.recovered >= 1, true)
  assert.equal((await lstat(dirname(boundedAuthority.quarantinePath))).isDirectory(), true)

  const entryBounded = join(root, 'entry-bounded')
  await mkdir(entryBounded)
  await writeFile(join(entryBounded, 'first.bin'), 'first')
  await writeFile(join(entryBounded, 'second.bin'), 'second')
  let entryAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: entryBounded,
    expectedIdentity: directoryIdentity(await lstat(entryBounded, { bigint: true })),
    label: 'caller-entry-policy-bounded',
    maximumEntries: 10,
    maximumBytes: 1024,
    async afterIntentDurable(value) {
      entryAuthority = value
      throw new Error('fixture owner crash before entry-bounded recovery')
    },
  }), /fixture owner crash/)
  const entryRefused = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1024,
  })
  assert.equal(entryRefused.failures.some(({ message }) => /caller|policy|entry bound/i.test(message)), true)
  assert.equal(await readFile(join(entryBounded, 'first.bin'), 'utf8'), 'first')
  await assert.rejects(lstat(entryAuthority.quarantinePath), /ENOENT/)
  const entryAccepted = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 10,
    maximumBytes: 1024,
  })
  assert.equal(entryAccepted.recovered >= 1, true)
  assert.equal((await lstat(dirname(entryAuthority.quarantinePath))).isDirectory(), true)

  const mismatched = join(root, 'mismatched-token')
  await mkdir(mismatched)
  await writeFile(join(mismatched, 'payload.bin'), 'token-bound bytes')
  let mismatchedAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: mismatched,
    expectedIdentity: directoryIdentity(await lstat(mismatched, { bigint: true })),
    label: 'token-bound-generation',
    async afterIntentDurable(value) {
      mismatchedAuthority = value
      throw new Error('fixture owner crash before token recovery')
    },
  }), /fixture owner crash/)
  const forged = JSON.parse(await readFile(mismatchedAuthority.intentPath, 'utf8'))
  forged.quarantineDirectoryName = `.WORLD_FFMPEG_GC.quarantine-${'f'.repeat(32)}`
  await writeFile(mismatchedAuthority.intentPath, `${JSON.stringify(forged)}\n`)
  const tokenRecovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
  })
  assert.equal(tokenRecovery.failures.some(({ message }) => /token|claim|identity/i.test(message)), true)
  assert.equal(await readFile(join(mismatched, 'payload.bin'), 'utf8'), 'token-bound bytes')
  await assert.rejects(lstat(mismatchedAuthority.quarantinePath), /ENOENT/)

  const healthy = join(root, 'healthy')
  await mkdir(healthy)
  await writeFile(join(healthy, 'payload.bin'), 'healthy bytes')
  let healthyAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: healthy,
    expectedIdentity: directoryIdentity(await lstat(healthy, { bigint: true })),
    label: 'healthy-independent-generation',
    async afterIntentDurable(value) {
      healthyAuthority = value
      throw new Error('fixture healthy owner crash')
    },
  }), /fixture healthy owner crash/)
  const malformedName = `.WORLD_FFMPEG_GC.intent-${'0'.repeat(32)}.v1.json`
  await writeFile(join(root, malformedName), '{malformed\n')
  const mixed = await recoverWorldFfmpegOwnedGarbage({ parentDirectory: root, minimumAgeMs: 0 })
  assert.equal(mixed.recovered >= 1, true)
  assert.equal(mixed.failures.some(({ name }) => name === malformedName), true)
  assert.equal((await lstat(dirname(healthyAuthority.quarantinePath))).isDirectory(), true)
  assert.equal(await readFile(join(root, malformedName), 'utf8'), '{malformed\n')
})

test('garbage authority publication is complete, no-replace, and resumes exact leftover temporaries', async (t) => {
  const {
    quarantineAndReclaimWorldFfmpegDirectory,
    recoverWorldFfmpegOwnedGarbage,
  } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-publication-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const collision = join(root, 'claim-collision')
  await mkdir(collision)
  await writeFile(join(collision, 'payload.bin'), 'owned payload')
  let claimPublicationObserved = false
  let collisionTemporaryPath
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: collision,
    expectedIdentity: directoryIdentity(await lstat(collision, { bigint: true })),
    label: 'atomic-claim-collision',
    async afterClaimTempSync({ claimPath, temporaryPath }) {
      claimPublicationObserved = true
      collisionTemporaryPath = temporaryPath
      const temporaryBytes = await readFile(temporaryPath)
      assert.doesNotThrow(() => JSON.parse(temporaryBytes.toString('utf8')))
      await writeFile(claimPath, 'foreign claim authority\n', { flag: 'wx' })
    },
  }), /claim.*conflict|foreign.*claim|publication/i)
  assert.equal(claimPublicationObserved, true)
  const foreignClaim = (await readdir(root)).find((name) => name.startsWith('.WORLD_FFMPEG_GC.claim-'))
  assert.ok(foreignClaim)
  assert.equal(await readFile(join(root, foreignClaim), 'utf8'), 'foreign claim authority\n')
  assert.equal(await readFile(join(collision, 'payload.bin'), 'utf8'), 'owned payload')

  const resumable = join(root, 'resumable-claim')
  await mkdir(resumable)
  await writeFile(join(resumable, 'payload.bin'), 'resumable bytes')
  let interruptedClaim
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: resumable,
    expectedIdentity: directoryIdentity(await lstat(resumable, { bigint: true })),
    label: 'atomic-claim-resume',
    async afterClaimTempSync(authority) {
      interruptedClaim = authority
      throw new Error('fixture crash after complete claim temporary sync')
    },
  }), /fixture crash after complete claim temporary sync/)
  assert.ok(interruptedClaim)
  await assert.rejects(lstat(interruptedClaim.claimPath), /ENOENT/)
  assert.ok((await lstat(interruptedClaim.temporaryPath)).isFile())
  const recovered = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 100,
    maximumBytes: 1024 * 1024,
  })
  assert.equal(recovered.failures.length >= 1, true, JSON.stringify(recovered))
  assert.equal(recovered.recovered >= 1, true, JSON.stringify(recovered))
  assert.ok(collisionTemporaryPath)
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes('.tmp-')),
    [collisionTemporaryPath.split('/').at(-1)],
  )

  const completion = join(root, 'completion-collision')
  await mkdir(completion)
  await writeFile(join(completion, 'payload.bin'), 'completion bytes')
  let foreignCompletionPath
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: completion,
    expectedIdentity: directoryIdentity(await lstat(completion, { bigint: true })),
    label: 'atomic-completion-collision',
    async afterCompletionTempSync({ completionPath }) {
      foreignCompletionPath = completionPath
      await writeFile(completionPath, 'foreign completion authority\n', { flag: 'wx' })
    },
  }), /completion|tombstone|conflict|foreign/i)
  assert.equal(await readFile(foreignCompletionPath, 'utf8'), 'foreign completion authority\n')

  const aliasRoot = join(root, 'aliased-temporary-root')
  await mkdir(aliasRoot)
  const aliased = join(aliasRoot, 'aliased-claim')
  await mkdir(aliased)
  await writeFile(join(aliased, 'payload.bin'), 'aliased temporary bytes')
  let aliasedClaim
  const foreignAlias = join(aliasRoot, 'foreign-hardlink')
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: aliased,
    expectedIdentity: directoryIdentity(await lstat(aliased, { bigint: true })),
    label: 'atomic-claim-alias',
    async afterClaimTempSync(authority) {
      aliasedClaim = authority
      await link(authority.temporaryPath, foreignAlias)
    },
  }), /hard link|alias|publication/i)
  await assert.rejects(lstat(aliasedClaim.claimPath), /ENOENT/)
  const aliasRecovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: aliasRoot,
    minimumAgeMs: 0,
    maximumEntries: 10,
    maximumBytes: 1024,
  })
  assert.equal(
    aliasRecovery.failures.some(({ message }) => /hard link|alias/i.test(message)),
    true,
  )
  await assert.rejects(lstat(aliasedClaim.claimPath), /ENOENT/)
  assert.equal(await readFile(foreignAlias, 'utf8'), await readFile(aliasedClaim.temporaryPath, 'utf8'))
  assert.equal(await readFile(join(aliased, 'payload.bin'), 'utf8'), 'aliased temporary bytes')

  const runner = (await import('./world-ffmpeg-electron-builder-runner.cjs')).default
  const runnerPath = join(root, 'runner.heartbeat')
  await writeFile(runnerPath, 'runner heartbeat')
  const runnerHandle = await open(runnerPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  const descriptor = runnerHandle.fd
  let syncObserved = false
  try {
    assert.throws(() => runner._testOnlyQuarantineOwnedAuthorityFileSync(runnerPath, descriptor, {
      afterClaimTempSync({ claimPath, temporaryPath }) {
        syncObserved = true
        assert.doesNotThrow(() => JSON.parse(String(readFileSync(temporaryPath))))
        writeFileSync(claimPath, 'foreign sync claim\n', { flag: 'wx' })
      },
    }), /claim.*conflict|foreign.*claim|publication/i)
  } finally {
    await runnerHandle.close()
  }
  assert.equal(syncObserved, true)

  const syncAliasPath = join(root, 'runner-alias.heartbeat')
  const syncForeignAlias = join(root, 'runner-alias.foreign-hardlink')
  await writeFile(syncAliasPath, 'runner alias heartbeat')
  const syncAliasHandle = await open(syncAliasPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  let syncAliasClaim
  try {
    assert.throws(() => runner._testOnlyQuarantineOwnedAuthorityFileSync(
      syncAliasPath,
      syncAliasHandle.fd,
      {
        afterClaimTempSync(authority) {
          syncAliasClaim = authority
          linkSync(authority.temporaryPath, syncForeignAlias)
        },
      },
    ), /hard link|alias|publication/i)
  } finally {
    await syncAliasHandle.close()
  }
  await assert.rejects(lstat(syncAliasClaim.claimPath), /ENOENT/)
  assert.equal(readFileSync(syncForeignAlias, 'utf8'), readFileSync(syncAliasClaim.temporaryPath, 'utf8'))
  assert.equal(await readFile(syncAliasPath, 'utf8'), 'runner alias heartbeat')

  const syncOccupiedPath = join(root, 'runner-occupied-quarantine.heartbeat')
  await writeFile(syncOccupiedPath, 'runner occupied quarantine heartbeat')
  const syncOccupiedHandle = await open(syncOccupiedPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  let syncOccupiedAuthority
  try {
    assert.throws(() => runner._testOnlyQuarantineOwnedAuthorityFileSync(
      syncOccupiedPath,
      syncOccupiedHandle.fd,
      {
        afterClaimDurable(authority) {
          syncOccupiedAuthority = authority
          mkdirSync(authority.quarantineParentPath, { mode: 0o700 })
          writeFileSync(join(authority.quarantineParentPath, 'foreign-owner.txt'), 'foreign quarantine owner\n')
        },
      },
    ), /private cleanup quarantine was occupied before creation/i)
  } finally {
    await syncOccupiedHandle.close()
  }
  assert.ok(syncOccupiedAuthority)
  assert.equal(await readFile(syncOccupiedPath, 'utf8'), 'runner occupied quarantine heartbeat')
  assert.equal(
    await readFile(join(syncOccupiedAuthority.quarantineParentPath, 'foreign-owner.txt'), 'utf8'),
    'foreign quarantine owner\n',
  )

  const runnerCompletionPath = join(root, 'runner-completion.heartbeat')
  let syncForeignCompletion
  const heartbeat = runner._testOnlyStartRunnerHeartbeat({
    attemptId: '9'.repeat(32), target: 'linux-x64', heartbeatPath: runnerCompletionPath,
  }, 'a'.repeat(32), 'linux-proc-start:1', {
    intervalMs: 60_000,
    afterCompletionTempSync({ completionPath }) {
      syncForeignCompletion = completionPath
      writeFileSync(completionPath, 'foreign sync completion\n', { flag: 'wx' })
    },
  })
  assert.throws(() => heartbeat.stop(), /completion|tombstone|conflict|foreign/i)
  assert.equal(await readFile(syncForeignCompletion, 'utf8'), 'foreign sync completion\n')

  const boundedRoot = join(root, 'bounded-temporaries')
  await mkdir(boundedRoot)
  const boundedSource = join(boundedRoot, 'owned')
  await mkdir(boundedSource)
  await writeFile(join(boundedSource, 'payload.bin'), 'bounded publication temp source')
  const protocol = (await import('./world-ffmpeg-owned-garbage-protocol.cjs')).default
  const boundedInfo = await lstat(boundedSource, { bigint: true })
  const boundedClaimName = protocol.claimNameFor(
    'directory', 'owned', protocol.sourceAuthorityFromStat(boundedInfo),
  )
  for (let index = 0; index < 65; index += 1) {
    await writeFile(
      join(boundedRoot, `${boundedClaimName}.tmp-${index.toString(16).padStart(32, '0')}`),
      '{}\n',
    )
  }
  const boundedRecovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: boundedRoot, minimumAgeMs: 0, maximumEntries: 100, maximumBytes: 1024,
  })
  assert.equal(
    boundedRecovery.failures.some(({ message }) => /temporary count exceeds.*bound/i.test(message)),
    true,
    JSON.stringify(boundedRecovery),
  )
  assert.equal((await readdir(boundedRoot)).filter((name) => name.startsWith(`${boundedClaimName}.tmp-`)).length, 65)
  assert.equal(await readFile(join(boundedSource, 'payload.bin'), 'utf8'), 'bounded publication temp source')
  await rm(boundedRoot, { recursive: true, force: true })

  const boundedTombstoneParent = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-bounded-tombstone-'))
  t.after(() => rm(boundedTombstoneParent, { recursive: true, force: true }))
  const boundedTombstoneRoot = join(boundedTombstoneParent, 'bounded-tombstone-temporaries')
  await mkdir(boundedTombstoneRoot)
  const boundedTombstoneSource = join(boundedTombstoneRoot, 'owned')
  await writeFile(boundedTombstoneSource, 'bounded tombstone source')
  let boundedTombstoneAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: boundedTombstoneRoot,
    expectedIdentity: directoryIdentity(await lstat(boundedTombstoneRoot, { bigint: true })),
    label: 'bounded-tombstone-temporaries',
    async afterIntentDurable(authority) {
      boundedTombstoneAuthority = authority
      throw new Error('fixture crash before tombstone publication')
    },
  }), /fixture crash before tombstone publication/)
  for (let index = 0; index < 65; index += 1) {
    await writeFile(
      `${boundedTombstoneAuthority.completionPath}.tmp-${index.toString(16).padStart(32, '0')}`,
      '{}\n',
    )
  }
  const boundedTombstoneRecovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: boundedTombstoneParent, minimumAgeMs: 0, maximumEntries: 100, maximumBytes: 1024,
  })
  assert.equal(
    boundedTombstoneRecovery.failures.some(({ message }) => /tombstone.*temporary count exceeds.*bound/i.test(message)),
    true,
    JSON.stringify(boundedTombstoneRecovery),
  )
  assert.equal(
    (await readdir(boundedTombstoneParent)).filter((name) => name.startsWith(`${boundedTombstoneAuthority.completionPath.split('/').at(-1)}.tmp-`)).length,
    65,
  )
  assert.equal(await readFile(boundedTombstoneSource, 'utf8'), 'bounded tombstone source')

  const boundedRetirementRoot = join(root, 'bounded-retirement-temporaries')
  await mkdir(boundedRetirementRoot)
  for (let index = 0; index < 65; index += 1) {
    const transactionToken = index.toString(16).padStart(32, '0')
    await writeFile(
      join(boundedRetirementRoot, `.WORLD_FFMPEG_GC.retirement-${transactionToken}.v1.json.tmp-${'f'.repeat(32)}`),
      '{}\n',
    )
  }
  const boundedRetirementRecovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: boundedRetirementRoot, minimumAgeMs: 0, maximumEntries: 1, maximumBytes: 1,
  })
  assert.equal(
    boundedRetirementRecovery.failures.some(({ message }) => /retirement authority count exceeds.*bound/i.test(message)),
    true,
    JSON.stringify(boundedRetirementRecovery),
  )
  assert.equal((await readdir(boundedRetirementRoot)).length, 65)
})

test('garbage retirement rechecks the currently opened single-link inode before destructive reclaim', async (t) => {
  const { quarantineAndReclaimWorldFfmpegDirectory } = await import('./world-ffmpeg-owned-garbage.mjs')
  const runner = (await import('./world-ffmpeg-electron-builder-runner.cjs')).default
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-final-hardlink-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const directory = join(root, 'directory')
  const directoryAlias = join(root, 'directory-payload.alias')
  await mkdir(directory)
  await writeFile(join(directory, 'payload.bin'), 'directory payload must survive')
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: directory,
    expectedIdentity: directoryIdentity(await lstat(directory, { bigint: true })),
    label: 'final-directory-hardlink',
    async beforeFileReclaim({ absolutePath }) {
      await link(absolutePath, directoryAlias)
    },
  }), /hard link|single.link|identity|foreign/i)
  assert.equal(await readFile(directoryAlias, 'utf8'), 'directory payload must survive')

  const runnerPath = join(root, 'runner.heartbeat')
  const runnerAlias = join(root, 'runner.heartbeat.alias')
  await writeFile(runnerPath, 'runner heartbeat must survive')
  const runnerHandle = await open(runnerPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  try {
    assert.throws(() => runner._testOnlyQuarantineOwnedAuthorityFileSync(
      runnerPath,
      runnerHandle.fd,
      { beforeRetirement({ quarantinePath }) { linkSync(quarantinePath, runnerAlias) } },
    ), /hard link|single.link|identity|foreign/i)
  } finally {
    await runnerHandle.close()
  }
  assert.equal(await readFile(runnerAlias, 'utf8'), 'runner heartbeat must survive')
})

test('equivalent ESM and CJS claim temporaries converge semantically instead of requiring random byte equality', async (t) => {
  const garbageProtocol = (await import('./world-ffmpeg-owned-garbage-protocol.cjs')).default
  const { recoverWorldFfmpegOwnedGarbage } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-equivalent-temps-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'authority')
  await mkdir(sourcePath)
  await writeFile(join(sourcePath, 'payload.bin'), 'semantically equivalent claim bytes')
  const sourceInfo = await lstat(sourcePath, { bigint: true })
  const sourceAuthority = garbageProtocol.sourceAuthorityFromStat(sourceInfo)
  const claimName = garbageProtocol.claimNameFor('directory', 'authority', sourceAuthority)
  const base = {
    kind: 'directory',
    label: 'equivalent-claim-temporaries',
    sourceName: 'authority',
    sourceIdentity: directoryIdentity(sourceInfo),
    sourceAuthority,
    createdAtMs: 1,
    maximumEntries: garbageProtocol.MAXIMUM_SUPPORTED_ENTRIES,
    maximumBytes: garbageProtocol.MAXIMUM_SUPPORTED_BYTES,
  }
  const candidates = [
    garbageProtocol.buildClaim({ ...base, token: '1'.repeat(32), ownerPid: 101, ownerToken: '3'.repeat(32) }),
    garbageProtocol.buildClaim({ ...base, token: '2'.repeat(32), ownerPid: 202, ownerToken: '4'.repeat(32) }),
  ]
  await Promise.all(candidates.map((candidate, index) => writeFile(
    join(root, `${claimName}.tmp-${index === 0 ? 'a'.repeat(32) : 'b'.repeat(32)}`),
    garbageProtocol.canonicalBytes(candidate),
  )))
  const recovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 10,
    maximumBytes: 1024 * 1024,
  })
  assert.equal(recovery.failures.length, 0, JSON.stringify(recovery))
  assert.equal((await readdir(root)).some((name) => name.startsWith(`${claimName}.tmp-`)), false)
  assert.equal((await readdir(root)).filter((name) => name === claimName).length, 1)

  const runner = (await import('./world-ffmpeg-electron-builder-runner.cjs')).default
  const runnerPath = join(root, 'runner.heartbeat')
  await writeFile(runnerPath, 'CJS semantic publication candidate')
  const runnerInfo = await lstat(runnerPath, { bigint: true })
  const runnerAuthority = garbageProtocol.sourceAuthorityFromStat(runnerInfo)
  const runnerClaimName = garbageProtocol.claimNameFor('file', 'runner.heartbeat', runnerAuthority)
  const runnerBase = {
    kind: 'file',
    label: 'runner-heartbeat',
    sourceName: 'runner.heartbeat',
    sourceIdentity: {
      dev: String(runnerInfo.dev), ino: String(runnerInfo.ino), size: Number(runnerInfo.size),
      mode: Number(runnerInfo.mode & 0o7777n),
    },
    sourceAuthority: runnerAuthority,
    maximumEntries: garbageProtocol.MAXIMUM_SUPPORTED_ENTRIES,
    maximumBytes: garbageProtocol.MAXIMUM_SUPPORTED_BYTES,
  }
  const runnerCandidates = [
    garbageProtocol.buildClaim({
      ...runnerBase, token: '5'.repeat(32), ownerPid: 303, ownerToken: '7'.repeat(32), createdAtMs: 2,
    }),
    garbageProtocol.buildClaim({
      ...runnerBase, token: '6'.repeat(32), ownerPid: 404, ownerToken: '8'.repeat(32), createdAtMs: 3,
    }),
  ]
  for (const [index, candidate] of runnerCandidates.entries()) {
    await writeFile(
      join(root, `${runnerClaimName}.tmp-${index === 0 ? 'c'.repeat(32) : 'd'.repeat(32)}`),
      garbageProtocol.canonicalBytes(candidate),
    )
  }
  const runnerHandle = await open(runnerPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  try {
    assert.equal(runner._testOnlyQuarantineOwnedAuthorityFileSync(
      runnerPath, runnerHandle.fd,
    ).reclaimedBytes, Number(runnerInfo.size))
  } finally {
    await runnerHandle.close()
  }
  assert.equal((await readdir(root)).some((name) => name.startsWith(`${runnerClaimName}.tmp-`)), false)
  assert.equal((await readdir(root)).filter((name) => name === runnerClaimName).length, 1)
})

test('directory quarantine uses an exact private authority and never overwrites source or destination races', async (t) => {
  const { quarantineAndReclaimWorldFfmpegDirectory } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-private-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const destinationRace = join(root, 'destination-race')
  await mkdir(destinationRace)
  await writeFile(join(destinationRace, 'owned.bin'), 'owned destination-race bytes')
  let privateAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: destinationRace,
    expectedIdentity: directoryIdentity(await lstat(destinationRace, { bigint: true })),
    label: 'private-destination-race',
    async afterQuarantineParentDurable(authority) {
      privateAuthority = authority
      assert.notEqual(dirname(authority.quarantinePath), root)
      await mkdir(authority.quarantinePath)
      await writeFile(join(authority.quarantinePath, 'foreign.bin'), 'foreign private destination')
    },
  }), /destination|quarantine|foreign|occupied/i)
  assert.ok(privateAuthority)
  assert.equal(await readFile(join(destinationRace, 'owned.bin'), 'utf8'), 'owned destination-race bytes')
  assert.equal(await readFile(join(privateAuthority.quarantinePath, 'foreign.bin'), 'utf8'), 'foreign private destination')

  const sourceRace = join(root, 'source-race')
  const displacedSource = join(root, 'source-race-owned-generation')
  await mkdir(sourceRace)
  await writeFile(join(sourceRace, 'owned.bin'), 'owned source-race bytes')
  let sourceAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: sourceRace,
    expectedIdentity: directoryIdentity(await lstat(sourceRace, { bigint: true })),
    label: 'private-source-race',
    async beforeQuarantineMove(authority) {
      sourceAuthority = authority
      await rename(sourceRace, displacedSource)
      await mkdir(sourceRace)
      await writeFile(join(sourceRace, 'foreign.bin'), 'foreign source replacement')
    },
  }), /source generation|identity|replacement/i)
  assert.equal(await readFile(join(displacedSource, 'owned.bin'), 'utf8'), 'owned source-race bytes')
  assert.equal(await readFile(join(sourceRace, 'foreign.bin'), 'utf8'), 'foreign source replacement')
  await assert.rejects(lstat(sourceAuthority.quarantinePath), /ENOENT/)
})

test('completed cleanup replay revalidates terminal bytes and compacts more than one thousand generations', async (t) => {
  const {
    quarantineAndReclaimWorldFfmpegDirectory,
    quarantineAndReclaimWorldFfmpegFile,
    recoverWorldFfmpegOwnedGarbage,
  } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-terminal-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const tampered = join(root, 'tampered-terminal')
  await mkdir(tampered)
  await writeFile(join(tampered, 'payload.bin'), 'terminal bytes')
  let authority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: tampered,
    expectedIdentity: directoryIdentity(await lstat(tampered, { bigint: true })),
    label: 'terminal-revalidation',
    async afterCompletionDirectorySync(value) {
      authority = value
      throw new Error('fixture crash after terminal publication')
    },
  }), /fixture crash after terminal publication/)
  const terminalTombstone = JSON.parse(await readFile(authority.completionPath, 'utf8'))
  const terminalReceiptBytes = await readFile(join(authority.quarantinePath, '.WORLD_FFMPEG_GC.v1.json'))
  assert.equal(terminalTombstone.receiptSha256, sha256(terminalReceiptBytes))
  await writeFile(join(authority.quarantinePath, 'payload.bin'), 'foreign nonzero replacement')
  const refused = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root, minimumAgeMs: 0, maximumEntries: 10, maximumBytes: 1024,
  })
  assert.equal(refused.completed, 0)
  assert.equal(refused.failures.some(({ message }) => /terminal|nonzero|replacement|reclaimed/i.test(message)), true)
  assert.equal(await readFile(join(authority.quarantinePath, 'payload.bin'), 'utf8'), 'foreign nonzero replacement')

  const receiptTampered = join(root, 'receipt-tampered-terminal')
  await mkdir(receiptTampered)
  await writeFile(join(receiptTampered, 'payload.bin'), 'receipt terminal bytes')
  let receiptAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: receiptTampered,
    expectedIdentity: directoryIdentity(await lstat(receiptTampered, { bigint: true })),
    label: 'terminal-receipt-revalidation',
    async afterCompletionDirectorySync(value) {
      receiptAuthority = value
      throw new Error('fixture crash before receipt terminal replay')
    },
  }), /fixture crash before receipt terminal replay/)
  const receiptPath = join(receiptAuthority.quarantinePath, '.WORLD_FFMPEG_GC.v1.json')
  await writeFile(receiptPath, '{"foreign":true}\n')
  const receiptRefused = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root, minimumAgeMs: 0, maximumEntries: 10, maximumBytes: 1024,
  })
  assert.equal(
    receiptRefused.failures.some(({ message }) => /receipt.*foreign|receipt.*invalid/i.test(message)),
    true,
  )
  assert.equal(await readFile(receiptPath, 'utf8'), '{"foreign":true}\n')

  const replacedTerminal = join(root, 'replaced-terminal')
  await mkdir(replacedTerminal)
  await writeFile(join(replacedTerminal, 'payload.bin'), 'replace terminal bytes')
  let replacedAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: replacedTerminal,
    expectedIdentity: directoryIdentity(await lstat(replacedTerminal, { bigint: true })),
    label: 'terminal-quarantine-revalidation',
    async afterCompletionDirectorySync(value) {
      replacedAuthority = value
      throw new Error('fixture crash before quarantine terminal replay')
    },
  }), /fixture crash before quarantine terminal replay/)
  await rename(replacedAuthority.quarantinePath, `${replacedAuthority.quarantinePath}.owned`)
  await mkdir(replacedAuthority.quarantinePath)
  await writeFile(join(replacedAuthority.quarantinePath, 'foreign.bin'), 'foreign quarantine replacement')
  const replacementRefused = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root, minimumAgeMs: 0, maximumEntries: 10, maximumBytes: 1024,
  })
  assert.equal(
    replacementRefused.failures.some(({ message }) => /quarantine.*foreign|foreign.*terminal/i.test(message)),
    true,
  )
  assert.equal(
    await readFile(join(replacedAuthority.quarantinePath, 'foreign.bin'), 'utf8'),
    'foreign quarantine replacement',
  )

  const displacedTerminal = join(root, 'displaced-terminal')
  await mkdir(displacedTerminal)
  await writeFile(join(displacedTerminal, 'payload.bin'), 'displaced terminal bytes')
  let displacedAuthority
  await assert.rejects(quarantineAndReclaimWorldFfmpegDirectory({
    path: displacedTerminal,
    expectedIdentity: directoryIdentity(await lstat(displacedTerminal, { bigint: true })),
    label: 'terminal-displaced-quarantine-revalidation',
    async afterCompletionDirectorySync(value) {
      displacedAuthority = value
      throw new Error('fixture crash before displaced quarantine replay')
    },
  }), /fixture crash before displaced quarantine replay/)
  const displacedQuarantineParent = `${dirname(displacedAuthority.quarantinePath)}.displaced`
  await rename(dirname(displacedAuthority.quarantinePath), displacedQuarantineParent)
  const displacedRefused = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root, minimumAgeMs: 0, maximumEntries: 10, maximumBytes: 1024,
  })
  assert.equal(
    displacedRefused.failures.some(({ message }) => /quarantine.*displaced|quarantine.*authority/i.test(message)),
    true,
  )
  assert.equal(
    await readFile(join(displacedQuarantineParent, 'owned', 'payload.bin'), 'utf8'),
    '',
  )

  const cyclesRoot = join(root, 'cycles')
  await mkdir(cyclesRoot)
  for (let index = 0; index < 1001; index += 1) {
    const cyclePath = join(cyclesRoot, 'authority')
    await writeFile(cyclePath, '')
    const handle = await open(cyclePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      await quarantineAndReclaimWorldFfmpegFile({
        path: cyclePath,
        retainedHandle: handle,
        label: 'bounded-terminal-ledger',
        maximumBytes: 1,
        durability: { platform: 'win32' },
      })
    } finally {
      await handle.close()
    }
  }
  const restart = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: cyclesRoot,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1,
    durability: { platform: 'win32' },
  })
  assert.equal(restart.failures.length, 0, JSON.stringify(restart))
  const remaining = (await readdir(cyclesRoot)).sort()
  assert.equal(remaining.length <= 260, true, `unbounded cleanup metadata: ${remaining.length}`)
  let retainedBytes = 0
  for (const name of remaining) retainedBytes += Number((await lstat(join(cyclesRoot, name), { bigint: true })).size)
  assert.equal(retainedBytes < 2 * 1024 * 1024, true, `unbounded cleanup ledger bytes: ${retainedBytes}`)
  const restartedAgain = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: cyclesRoot,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1,
    durability: { platform: 'win32' },
  })
  assert.equal(restartedAgain.failures.length, 0, JSON.stringify(restartedAgain))
  assert.deepEqual((await readdir(cyclesRoot)).sort(), remaining)
})

test('completed ledger convergence source has one anchored state-machine success path', async () => {
  const source = await readFile(new URL('./world-ffmpeg-owned-garbage.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes('settleLedgerRetirementManifestGeneration'), false)
  assert.equal(source.includes('observeLedgerRetirementManifestGeneration'), false)
  assert.equal(source.includes('completedLedgerRecordSourcesAbsent'), false)
  assert.doesNotMatch(source, /catch \(error\) \{[\s\S]{0,800}completedLedgerRecordSourcesAbsent/)
  assert.doesNotMatch(source, /catch \(error\) \{[\s\S]{0,800}settleLedgerRetirementManifestGeneration/)
  assert.equal(
    source.includes('const currentState = await settleCompletedLedgerGeneration(activeRecord, manifestPath, directoryPath)'),
    true,
  )
  assert.equal(
    source.includes('const generationState = activeRecord && !injectedProofFailure\n      ? await settleCompletedLedgerGeneration('),
    true,
  )
})

test('completed-ledger retirement is one recoverable transaction and preserves a final hard-link injection', async (t) => {
  const {
    quarantineAndReclaimWorldFfmpegFile,
    recoverWorldFfmpegOwnedGarbage,
  } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-ledger-retirement-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const makeLedger = async (parent) => {
    await mkdir(parent)
    for (let index = 0; index < 65; index += 1) {
      const path = join(parent, 'authority')
      await writeFile(path, '')
      const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      let result
      try {
        result = await quarantineAndReclaimWorldFfmpegFile({
          path,
          retainedHandle: handle,
          label: 'transactional-ledger-retirement',
          maximumBytes: 1,
          durability: { platform: 'win32' },
        })
      } finally {
        await handle.close()
      }
      await rm(dirname(result.quarantinePath), { recursive: true })
    }
  }

  const templateRoot = join(root, 'template')
  await makeLedger(templateRoot)
  const cloneLedger = (parent) => cp(templateRoot, parent, { recursive: true })

  const hardlinkRoot = join(root, 'hardlink')
  await cloneLedger(hardlinkRoot)
  const alias = join(hardlinkRoot, 'retirement-authority.alias')
  let injected = false
  const refused = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: hardlinkRoot,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1,
    durability: { platform: 'win32' },
    async beforeLedgerRetirement({ path }) {
      if (injected) return
      injected = true
      await link(path, alias)
    },
  })
  assert.equal(injected, true)
  assert.equal(
    refused.failures.some(({ message }) => /hard link|single.link|aliased|foreign/i.test(message)),
    true,
    JSON.stringify(refused),
  )
  assert.ok((await readFile(alias)).byteLength > 0)

  for (const role of ['claim', 'intent', 'tombstone']) {
    const roleRoot = join(root, `hardlink-${role}`)
    await cloneLedger(roleRoot)
    const roleAlias = join(roleRoot, `${role}.alias`)
    let roleInjected = false
    const roleRefused = await recoverWorldFfmpegOwnedGarbage({
      parentDirectory: roleRoot,
      minimumAgeMs: 0,
      maximumEntries: 1,
      maximumBytes: 1,
      durability: { platform: 'win32' },
      async beforeLedgerReclaim({ path, role: candidateRole }) {
        if (roleInjected || candidateRole !== role) return
        roleInjected = true
        await link(path, roleAlias)
      },
    })
    assert.equal(roleInjected, true, role)
    assert.equal(
      roleRefused.failures.some(({ message }) => /hard link|single.link/i.test(message)),
      true,
      `${role}: ${JSON.stringify(roleRefused)}`,
    )
    assert.ok((await readFile(roleAlias)).byteLength > 0, role)
  }

  const manifestAliasRoot = join(root, 'hardlink-retirement-manifest')
  await cloneLedger(manifestAliasRoot)
  const manifestAlias = join(manifestAliasRoot, 'retirement-manifest.alias')
  let manifestInjected = false
  const manifestRefused = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: manifestAliasRoot,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1,
    durability: { platform: 'win32' },
    async beforeLedgerRetirementManifestDelete({ manifestPath }) {
      if (manifestInjected) return
      manifestInjected = true
      await link(manifestPath, manifestAlias)
    },
  })
  assert.equal(manifestInjected, true)
  assert.equal(
    manifestRefused.failures.some(({ message }) => /hard link|single.link/i.test(message)),
    true,
    JSON.stringify(manifestRefused),
  )
  assert.ok((await readFile(manifestAlias)).byteLength > 0)

  const crashRoot = join(root, 'crash')
  await cloneLedger(crashRoot)
  let crashed = false
  const interrupted = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: crashRoot,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1,
    durability: { platform: 'win32' },
    async afterLedgerRetirementIntentDurable() {
      if (crashed) return
      crashed = true
      throw new Error('fixture crash after durable retirement intent')
    },
  })
  assert.equal(crashed, true)
  assert.equal(interrupted.failures.some(({ message }) => /fixture crash after durable retirement intent/i.test(message)), true)
  const restarted = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: crashRoot,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1,
    durability: { platform: 'win32' },
  })
  assert.equal(restarted.failures.length, 0, JSON.stringify(restarted))
  assert.equal((await readdir(crashRoot)).some((name) => /\.retire|\.retirement/.test(name)), false)

  for (const [hook, role] of [
    ['afterLedgerRetirementIntentTempSync', undefined],
    ['afterLedgerRetirementIntentPublish', undefined],
    ['afterLedgerRetirementIntentDirectorySync', undefined],
    ['afterLedgerRetirementMove', 'intent'],
    ['afterLedgerRetirementSourceSync', 'intent'],
    ['afterLedgerRetirementDirectorySync', 'intent'],
    ['afterLedgerReclaim', 'intent'],
    ['afterLedgerFinalDelete', 'intent'],
    ['afterLedgerFinalDeleteSync', 'intent'],
    ['afterLedgerRetirementDirectoryDelete', undefined],
    ['afterLedgerRetirementParentSync', undefined],
    ['afterLedgerRetirementManifestDelete', undefined],
  ]) {
    const checkpointRoot = join(root, `checkpoint-${hook}`)
    await cloneLedger(checkpointRoot)
    let observed = false
    const checkpointFailure = `fixture crash at ${hook}`
    const interruptedCheckpoint = await recoverWorldFfmpegOwnedGarbage({
      parentDirectory: checkpointRoot,
      minimumAgeMs: 0,
      maximumEntries: 1,
      maximumBytes: 1,
      durability: { platform: 'win32' },
      [hook]: async (details = {}) => {
        if (observed || (role !== undefined && details.role !== role)) return
        observed = true
        throw new Error(checkpointFailure)
      },
    })
    assert.equal(observed, true, hook)
    assert.equal(
      interruptedCheckpoint.failures.some(({ message }) => message.includes(checkpointFailure)),
      true,
      `${hook}: ${JSON.stringify(interruptedCheckpoint)}`,
    )
    const checkpointRestart = await recoverWorldFfmpegOwnedGarbage({
      parentDirectory: checkpointRoot,
      minimumAgeMs: 0,
      maximumEntries: 1,
      maximumBytes: 1,
      durability: { platform: 'win32' },
    })
    assert.equal(checkpointRestart.failures.length, 0, `${hook}: ${JSON.stringify(checkpointRestart)}`)
    assert.equal(
      (await readdir(checkpointRoot)).some((name) => /\.retire|\.retirement/.test(name)),
      false,
      hook,
    )
  }

  const interleavedRoot = join(root, 'interleaved-final-unlink')
  await cloneLedger(interleavedRoot)
  const finalCheckGate = retirementReadGate()
  let finalCheckCount = 0
  const finalCheckSnapshots = []
  const interleavedResults = await Promise.all([0, 1].map(() => recoverWorldFfmpegOwnedGarbage({
    parentDirectory: interleavedRoot,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1,
    durability: { platform: 'win32' },
    async afterLedgerFinalCheck({ path, role }) {
      if (role !== 'claim') return
      finalCheckSnapshots.push({ role, path, stat: retirementWitnessStat(await lstat(path, { bigint: true })) })
      finalCheckCount += 1
      if (finalCheckCount === 2) finalCheckGate.resolve()
      await finalCheckGate.promise
    },
  })))
  assert.equal(finalCheckCount, 2, JSON.stringify(finalCheckSnapshots))
  for (const result of interleavedResults) {
    assert.equal(result.failures.length, 0, JSON.stringify(interleavedResults))
  }
  assert.equal((await readdir(interleavedRoot)).some((name) => /\.retire|\.retirement/.test(name)), false)

  const concurrentRoot = join(root, 'concurrent-recovery')
  await cloneLedger(concurrentRoot)
  const concurrentResults = await Promise.all([0, 1].map(() => recoverWorldFfmpegOwnedGarbage({
    parentDirectory: concurrentRoot,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1,
    durability: { platform: 'win32' },
  })))
  for (const result of concurrentResults) {
    assert.equal(result.failures.length, 0, JSON.stringify(concurrentResults))
  }
  assert.equal((await readdir(concurrentRoot)).some((name) => /\.retire|\.retirement/.test(name)), false)

  const partialRoot = join(root, 'partial-retirement-publication')
  await cloneLedger(partialRoot)
  const partialToken = 'e'.repeat(32)
  const partialName = `.WORLD_FFMPEG_GC.retirement-${partialToken}.v1.json.tmp-${'f'.repeat(32)}`
  await writeFile(join(partialRoot, partialName), '{}\n')
  const claimsBeforePartialRecovery = (await readdir(partialRoot)).filter((name) => name.startsWith('.WORLD_FFMPEG_GC.claim-')).length
  const partialRecovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: partialRoot,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1,
    durability: { platform: 'win32' },
  })
  assert.equal(
    partialRecovery.failures.some(({ message }) => /retirement.*(?:invalid|publication)/i.test(message)),
    true,
    JSON.stringify(partialRecovery),
  )
  assert.equal(await readFile(join(partialRoot, partialName), 'utf8'), '{}\n')
  assert.equal(
    (await readdir(partialRoot)).filter((name) => name.startsWith('.WORLD_FFMPEG_GC.claim-')).length,
    claimsBeforePartialRecovery,
    'an unresolved retirement authority must block creation of another retirement transaction',
  )
})

test('ledger retirement binds terminal quarantine and receipt before reclaiming the generation', async (t) => {
  const {
    quarantineAndReclaimWorldFfmpegFile,
    recoverWorldFfmpegOwnedGarbage,
  } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-full-ledger-retirement-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (let index = 0; index < 65; index += 1) {
    const path = join(root, 'authority')
    await writeFile(path, `terminal generation ${index}`)
    const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      await quarantineAndReclaimWorldFfmpegFile({
        path,
        retainedHandle: handle,
        label: 'full-ledger-retirement',
        maximumBytes: 64,
        nowMs: index + 1,
        durability: { platform: 'win32' },
      })
    } finally {
      await handle.close()
    }
  }

  const quarantineAlias = join(root, 'retired-quarantine.alias')
  let quarantineObserved = false
  const refused = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 64,
    durability: { platform: 'win32' },
    async beforeLedgerReclaim({ path, role }) {
      if (quarantineObserved || role !== 'quarantine') return
      quarantineObserved = true
      await link(path, quarantineAlias)
    },
  })
  assert.equal(quarantineObserved, true)
  assert.equal(
    refused.failures.some(({ message }) => /hard link|single.link|aliased|foreign/i.test(message)),
    true,
    JSON.stringify(refused),
  )
  assert.ok((await lstat(quarantineAlias, { bigint: true })).isFile())
  await unlink(quarantineAlias)

  const lowBoundRecovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 1,
    durability: { platform: 'win32' },
  })
  assert.equal(
    lowBoundRecovery.failures.some(({ message }) => /caller|policy|byte bound/i.test(message)),
    true,
    JSON.stringify(lowBoundRecovery),
  )
  assert.equal((await readdir(root)).some((name) => /\.retirement-/.test(name)), true)

  const receiptAlias = join(root, 'retired-receipt.alias')
  let receiptObserved = false
  const receiptRefused = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 64,
    durability: { platform: 'win32' },
    async beforeLedgerReclaim({ path, role }) {
      if (receiptObserved || role !== 'receipt') return
      receiptObserved = true
      await link(path, receiptAlias)
    },
  })
  assert.equal(receiptObserved, true)
  assert.equal(
    receiptRefused.failures.some(({ message }) => /hard link|single.link|aliased|foreign|ordinary bounded/i.test(message)),
    true,
    JSON.stringify(receiptRefused),
  )
  assert.ok((await readFile(receiptAlias)).byteLength > 0)
  await unlink(receiptAlias)

  const completed = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 1,
    maximumBytes: 64,
    durability: { platform: 'win32' },
  })
  assert.equal(completed.failures.length, 0, JSON.stringify(completed))
  assert.equal((await readdir(root)).some((name) => /\.retire|\.retirement/.test(name)), false)
})

test('ESM and CJS processes converge one cleanup claim and concurrent crash recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-garbage-processes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const esmModule = new URL('./world-ffmpeg-owned-garbage.mjs', import.meta.url).href
  const cjsModule = fileURLToPath(new URL('./world-ffmpeg-electron-builder-runner.cjs', import.meta.url))
  const esmWorker = join(root, 'cleanup-worker.mjs')
  const cjsWorker = join(root, 'cleanup-worker.cjs')
	  await writeFile(esmWorker, `
	import { constants } from 'node:fs'
	import { writeFileSync, writeSync } from 'node:fs'
	import { lstat, open, writeFile } from 'node:fs/promises'
	import { dirname, join } from 'node:path'
	  const [moduleUrl, operation, path, ready, go, parent] = process.argv.slice(2)
	  const api = await import(moduleUrl)
	const phaseRoot = ready === '-' ? parent : dirname(ready)
	const phase = (name) => join(phaseRoot, \`\${operation}.\${process.pid}.\${name}.phase\`)
	const markPhase = (name) => writeFile(phase(name), name)
	const markPhaseSync = (name) => writeFileSync(phase(name), name)
	  const writeResult = (result) => {
	  markPhaseSync('stdout-write-start')
	  writeSync(1, Buffer.from(JSON.stringify(result) + '\\n'))
	  }
const waitForGo = async () => {
  for (let index = 0; index < 500; index += 1) {
    try { await lstat(go); return } catch (error) { if (error?.code !== 'ENOENT') throw error }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('worker start barrier timed out')
}
	  if (operation === 'recover') {
	  await markPhase('recover-ready')
	  await writeFile(ready, 'ready')
	  await waitForGo()
	  await markPhase('recover-start')
	  const result = await api.recoverWorldFfmpegOwnedGarbage({
	    parentDirectory: parent, minimumAgeMs: 0, maximumEntries: 100, maximumBytes: 1024 * 1024,
	  })
	  writeResult(result)
	  await markPhase('recover-result-written')
	} else {
	  await markPhase('open-start')
	  const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
	  try {
	    if (operation === 'fresh') {
	      await markPhase('fresh-ready')
	      await writeFile(ready, 'ready')
	      await waitForGo()
	    }
	    await markPhase('claim-start')
	    const result = await api.quarantineAndReclaimWorldFfmpegFile({
	      path, retainedHandle: handle, label: 'runner-heartbeat', maximumBytes: 1024 * 1024,
	      afterClaimDurable: operation === 'crash-claim' ? () => { markPhaseSync('crash-claim-exit'); process.exit(70) } : undefined,
	      afterIntentDurable: operation === 'crash-intent' ? () => { markPhaseSync('crash-intent-exit'); process.exit(71) } : undefined,
	      afterQuarantine: operation === 'crash-rename' ? () => { markPhaseSync('crash-rename-exit'); process.exit(72) } : undefined,
	    })
	    writeResult(result)
	    await markPhase('claim-result-written')
	  } finally { await handle.close() }
	}
	`)
	  await writeFile(cjsWorker, `
	  const fs = require('node:fs')
	const { dirname, join } = require('node:path')
	  const [cjsModule, esmModule, operation, path, ready, go, parent] = process.argv.slice(2)
	const phaseRoot = ready === '-' ? parent : dirname(ready)
	const phase = (name) => join(phaseRoot, \`\${operation}.\${process.pid}.\${name}.phase\`)
	const markPhase = (name) => fs.promises.writeFile(phase(name), name)
	const markPhaseSync = (name) => fs.writeFileSync(phase(name), name)
	  const writeResult = (result) => {
	  markPhaseSync('stdout-write-start')
	  fs.writeSync(1, Buffer.from(JSON.stringify(result) + '\\n'))
	  }
const waitForGo = async () => {
  for (let index = 0; index < 500; index += 1) {
    if (fs.existsSync(go)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('worker start barrier timed out')
}
	  void (async () => {
	    if (operation === 'recover') {
	      const api = await import(esmModule)
	      await markPhase('recover-ready')
	      fs.writeFileSync(ready, 'ready')
	      await waitForGo()
	      await markPhase('recover-start')
	      const result = await api.recoverWorldFfmpegOwnedGarbage({
	        parentDirectory: parent, minimumAgeMs: 0, maximumEntries: 100, maximumBytes: 1024 * 1024,
	      })
	      writeResult(result)
	      await markPhase('recover-result-written')
	      return
	    }
	    const api = require(cjsModule)
	    await markPhase('open-start')
	    const descriptor = fs.openSync(path, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0))
	    try {
	      await markPhase('fresh-ready')
	      fs.writeFileSync(ready, 'ready')
	      await waitForGo()
	      await markPhase('claim-start')
	      const result = api._testOnlyQuarantineOwnedAuthorityFileSync(path, descriptor)
	      writeResult(result)
	      await markPhase('claim-result-written')
	    } finally { fs.closeSync(descriptor) }
	  })().catch((error) => { process.stderr.write(String(error?.stack ?? error) + '\\n'); process.exitCode = 1 })
	`)

	  const active = new Set()
	  t.after(() => { for (const child of active) child.kill('SIGKILL') })
	  const launch = (file, args) => {
	    const child = spawn(process.execPath, [file, ...args], {
	      cwd: root, env: {}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
	    })
	    const settled = collectChildProcess(child, { active, label: 'cleanup worker' })
	    return { child, settled }
	  }
	  const readPhases = async (directory) => (await readdir(directory))
	    .filter((name) => name.endsWith('.phase'))
	    .sort()
  const waitForReady = async (paths) => {
    for (let index = 0; index < 500; index += 1) {
      const states = await Promise.all(paths.map(async (path) => {
        try { await lstat(path); return true } catch (error) {
          if (error?.code === 'ENOENT') return false
          throw error
        }
      }))
      if (states.every(Boolean)) return
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
    throw new Error('cleanup worker readiness timed out')
  }
	  const settle = (worker) => worker.settled

  const freshRoot = join(root, 'fresh')
  await mkdir(freshRoot)
  const freshPath = join(freshRoot, 'runner.heartbeat')
  await writeFile(freshPath, 'shared fresh authority')
  const esmReady = join(freshRoot, 'esm.ready')
  const cjsReady = join(freshRoot, 'cjs.ready')
  const freshGo = join(freshRoot, 'go')
  const esm = launch(esmWorker, [esmModule, 'fresh', freshPath, esmReady, freshGo, freshRoot])
  const cjs = launch(cjsWorker, [cjsModule, esmModule, 'fresh', freshPath, cjsReady, freshGo, freshRoot])
  await waitForReady([esmReady, cjsReady])
  await writeFile(freshGo, 'go')
	  const [esmResult, cjsResult] = await Promise.all([settle(esm), settle(cjs)])
	  assert.deepEqual([esmResult.code, cjsResult.code], [0, 0], `${esmResult.stderr}\n${cjsResult.stderr}`)
	  const freshPhases = await readPhases(freshRoot)
	  const esmValue = parseWorkerJsonResult(esmResult, 'esm fresh worker', freshPhases)
	  const cjsValue = parseWorkerJsonResult(cjsResult, 'cjs fresh worker', freshPhases)
  for (const key of ['claimPath', 'intentPath', 'quarantinePath', 'completionPath', 'reclaimedBytes']) {
    assert.equal(cjsValue[key], esmValue[key], key)
  }
  assert.equal((await lstat(esmValue.quarantinePath)).size, 0)
  assert.equal((await readdir(freshRoot)).filter((name) => name.includes('.WORLD_FFMPEG_GC.claim-')).length, 1)
  const freshClaim = JSON.parse(await readFile(esmValue.claimPath, 'utf8'))
  const freshIntent = JSON.parse(await readFile(esmValue.intentPath, 'utf8'))
  assert.equal(freshClaim.token, freshIntent.token)
  assert.equal(freshClaim.intentName, esmValue.intentPath.split('/').at(-1))
  assert.equal(freshClaim.quarantineDirectoryName, dirname(esmValue.quarantinePath).split('/').at(-1))
  assert.equal(freshClaim.quarantineName, esmValue.quarantinePath.split('/').at(-1))
  assert.equal(freshClaim.completionName, esmValue.completionPath.split('/').at(-1))
  assert.deepEqual(freshClaim.sourceAuthority, freshIntent.sourceAuthority)

  for (const [operation, exitCode] of [
    ['crash-claim', 70], ['crash-intent', 71], ['crash-rename', 72],
  ]) {
    const recoveryRoot = join(root, operation)
    await mkdir(recoveryRoot)
    const authorityPath = join(recoveryRoot, 'runner.heartbeat')
    await writeFile(authorityPath, `owned ${operation}`)
    const owner = launch(esmWorker, [esmModule, operation, authorityPath, '-', '-', recoveryRoot])
    const ownerResult = await settle(owner)
    assert.equal(ownerResult.code, exitCode, ownerResult.stderr)
    const firstReady = join(recoveryRoot, 'first.ready')
    const secondReady = join(recoveryRoot, 'second.ready')
    const recoverGo = join(recoveryRoot, 'recover.go')
    const first = launch(esmWorker, [esmModule, 'recover', '-', firstReady, recoverGo, recoveryRoot])
    const second = launch(cjsWorker, [cjsModule, esmModule, 'recover', '-', secondReady, recoverGo, recoveryRoot])
    await waitForReady([firstReady, secondReady])
    await writeFile(recoverGo, 'go')
	    const [firstResult, secondResult] = await Promise.all([settle(first), settle(second)])
	    assert.deepEqual([firstResult.code, secondResult.code], [0, 0], `${firstResult.stderr}\n${secondResult.stderr}`)
	    const recoveryPhases = await readPhases(recoveryRoot)
	    const recoveries = [
	      parseWorkerJsonResult(firstResult, `${operation} first recovery worker`, recoveryPhases),
	      parseWorkerJsonResult(secondResult, `${operation} second recovery worker`, recoveryPhases),
	    ]
    assert.equal(
      recoveries.every(({ failures }) => failures.length === 0),
      true,
      `${operation}: ${JSON.stringify(recoveries)}`,
    )
    assert.equal(
      (await readdir(recoveryRoot)).filter((name) => name.startsWith('.WORLD_FFMPEG_GC.quarantine-')).length,
      1,
    )
  }
})

test('cleanup worker output contract rejects empty stdout and waits for late stream completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-worker-output-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const emptyWorker = join(root, 'empty-worker.mjs')
  const lateWorker = join(root, 'late-worker.mjs')
  const oversizedWorker = join(root, 'oversized-worker.mjs')
  await writeFile(emptyWorker, 'process.exit(0)\n')
  await writeFile(lateWorker, `
	import { writeSync } from 'node:fs'
	await new Promise((resolve) => setTimeout(resolve, 25))
	writeSync(1, Buffer.from(JSON.stringify({ ok: true }) + '\\n'))
  `)
  await writeFile(oversizedWorker, `
	import { writeSync } from 'node:fs'
	writeSync(1, Buffer.alloc(${MAXIMUM_WORKER_OUTPUT_BYTES + 1}, 65))
	setInterval(() => {}, 1000)
  `)
  const empty = await collectChildProcess(spawn(process.execPath, [emptyWorker], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }), { label: 'empty worker' })
  assert.equal(empty.code, 0, empty.stderr)
  assert.throws(() => parseWorkerJsonResult(empty, 'empty worker'), /empty stdout/)

  const late = await collectChildProcess(spawn(process.execPath, [lateWorker], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }), { label: 'late worker' })
  assert.equal(late.code, 0, late.stderr)
  assert.deepEqual(parseWorkerJsonResult(late, 'late worker'), { ok: true })

  const active = new Set()
  const oversized = spawn(process.execPath, [oversizedWorker], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let childClosed = false
  let stdoutClosed = false
  let stderrClosed = false
  oversized.once('close', () => { childClosed = true })
  oversized.stdout.once('close', () => { stdoutClosed = true })
  oversized.stderr.once('close', () => { stderrClosed = true })
  await assert.rejects(
    collectChildProcess(oversized, { active, label: 'oversized persistent worker' }),
    /oversized persistent worker stdout exceeded 1048576 byte output bound/,
  )
  assert.equal(childClosed, true)
  assert.equal(stdoutClosed, true)
  assert.equal(stderrClosed, true)
  assert.equal(oversized.signalCode, 'SIGKILL')
  assert.equal(active.size, 0)
})

test('platform-injected recovery preserves exact live attempts and reclaims only dead or reused identities', async (t) => {
  const {
    runWorldFfmpegOfflinePackage,
    worldFfmpegMutablePackageCacheRootFor,
    worldFfmpegPackageOutputRootFor,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const currentIdentities = {
    darwin: `darwin-ps-start-command:${'1'.repeat(64)}`,
    win32: 'win32-process-start:638927876960000000',
  }
  const oldIdentities = {
    darwin: `darwin-ps-start-command:${'2'.repeat(64)}`,
    win32: 'win32-process-start:638927876950000000',
  }
  const reusedIdentities = {
    darwin: `darwin-ps-start-command:${'3'.repeat(64)}`,
    win32: 'win32-process-start:638927876940000000',
  }
  const oldPid = 0xffff_fffe
  const scenarios = [
    { platform: 'darwin', status: 'live' },
    { platform: 'darwin', status: 'dead' },
    { platform: 'win32', status: 'reused' },
    { platform: 'win32', status: 'unavailable' },
  ]
  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), `modly-recovery-${scenario.platform}-${scenario.status}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const archiveStore = join(root, 'archives')
    await mkdir(archiveStore)
    const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
    for (const entry of contract.targets['linux-x64']) {
      const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
      entry.sha256 = sha256(bytes)
      entry.maximumBytes = 1024
      await mkdir(join(archiveStore, entry.release), { recursive: true })
      await writeFile(join(archiveStore, entry.release, entry.filename), bytes)
    }
    await assert.rejects(runWorldFfmpegOfflinePackage({
      target: 'linux-x64', cacheDirectory: archiveStore, contract,
      argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
      outputCustody: _testOnlyRunWorldFfmpegOutputCustodyInProcess,
      cacheLifecycle: {
        processPlatform: scenario.platform,
        processStartIdentity: async () => oldIdentities[scenario.platform],
        cleanupTimeoutMs: 1_000,
        beforeDirectoryQuarantine: async () => { throw new Error('fixture retains crashed attempt') },
      },
      spawnProcess: async () => { throw new Error('fixture package crash') },
      verifyPackage: async () => { throw new Error('must not verify crashed attempt') },
    }), /fixture package crash|fixture retains crashed attempt/)
    const cacheRoot = worldFfmpegMutablePackageCacheRootFor(archiveStore)
    const outputRoot = worldFfmpegPackageOutputRootFor(archiveStore)
    const leaseName = (await readdir(cacheRoot)).find((name) => /^lease-[a-f0-9]{32}\.json$/.test(name))
    assert.ok(leaseName)
    const token = leaseName.slice('lease-'.length, -'.json'.length)
    await rm(join(cacheRoot, `cleanup-${token}`), { recursive: true, force: true })
    const leasePath = join(cacheRoot, leaseName)
    const lease = JSON.parse(await readFile(leasePath, 'utf8'))
    lease.ownerPid = oldPid
    lease.createdAtMs = 0
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`)
    const oldCache = join(cacheRoot, lease.cacheName)
    const oldOutput = join(outputRoot, lease.outputName)
    const observedOld = scenario.status === 'live'
      ? oldIdentities[scenario.platform]
      : scenario.status === 'reused' ? reusedIdentities[scenario.platform]
        : scenario.status === 'dead' ? null : 'unavailable'
    const runProbe = () => runWorldFfmpegOfflinePackage({
      target: 'linux-x64', cacheDirectory: archiveStore, contract,
      argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
      outputCustody: _testOnlyRunWorldFfmpegOutputCustodyInProcess,
      cacheLifecycle: {
        processPlatform: scenario.platform,
        now: () => 100_000,
        heartbeatIntervalMs: 5,
        heartbeatFreshMs: 20,
        processStartIdentity: async (pid) => pid === oldPid
          ? observedOld
          : currentIdentities[scenario.platform],
      },
      spawnProcess: async (_file, _args, options) => {
        const environment = options.env
        const output = environment.WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY
        const artifactName = 'Modly-recovery.AppImage'
        await writeFile(join(output, artifactName), 'artifact')
        const reportRoot = join(output, 'linux-unpacked', 'resources', 'world-ffmpeg-build-reports')
        await mkdir(reportRoot, { recursive: true })
        await writeFile(join(reportRoot, 'linux-x64.json'), '{}\n')
        const cacheInfo = await lstat(environment.ELECTRON_BUILDER_CACHE, { bigint: true })
        const outputInfo = await lstat(output, { bigint: true })
        await writeFile(environment.WORLD_FFMPEG_PACKAGE_RUNNER_TERMINAL, `${JSON.stringify({
          schema: 'modly.electron-builder-package-runner-terminal.v1',
          attemptId: environment.WORLD_FFMPEG_PACKAGE_ATTEMPT_ID,
          target: 'linux-x64', runnerIdentity: '1'.repeat(32), runnerPid: process.pid,
          processStartIdentity: currentIdentities[scenario.platform],
          cacheIdentity: directoryIdentity(cacheInfo), outputIdentity: directoryIdentity(outputInfo),
          status: 'succeeded', artifacts: [artifactName],
        })}\n`)
        return { code: 0, signal: null }
      },
      verifyPackage: async (request) => ({
        ok: true, buildReportReceipt: request.buildReportReceipt,
        runtimeManifestSha256: 'a'.repeat(64),
      }),
      inspectArtifacts: async (request) => {
        const artifact = await request.outputCustody({
          operation: 'hash', directory: request.outputDirectory,
          expectedDirectoryIdentity: request.outputIdentity,
          name: 'Modly-recovery.AppImage', maximumBytes: 1024,
        })
        return {
          schema: 'modly.world-ffmpeg-artifact-inspection.v1', target: 'linux-x64',
          artifact: { path: artifact.file.name, dev: artifact.file.dev, ino: artifact.file.ino, size: artifact.file.size, sha256: artifact.file.sha256 },
          runtimeManifestSha256: request.expectedRuntimeManifestSha256,
          buildReportSha256: request.buildReportReceipt.sha256,
          extractor: extractorProof(request.extractor),
        }
      },
    })
    if (scenario.status === 'unavailable') {
      await assert.rejects(runProbe(), /identity authority is unavailable/i)
      assert.equal((await lstat(oldCache)).isDirectory(), true)
      assert.equal((await lstat(oldOutput)).isDirectory(), true)
    } else {
      await runProbe()
      if (scenario.status === 'live') {
        assert.equal((await lstat(oldCache)).isDirectory(), true)
        assert.equal((await lstat(oldOutput)).isDirectory(), true)
      } else {
        await assert.rejects(lstat(oldCache), /ENOENT/)
        await assert.rejects(lstat(oldOutput), /ENOENT/)
      }
    }
  }
})

test('trusted result receipt rejects a consistent replacement root before the first manifest read', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'modly-result-root-receipt-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const token = '1'.repeat(32)
  const publicationToken = '2'.repeat(32)
  const target = 'linux-x64'
  const resultName = `RESULT.${target}.v1.json`
  const root = join(parent, `output-${token}`)
  const replacement = join(parent, 'replacement')
  await mkdir(root)
  const artifactName = 'Modly.AppImage'
  const reportName = `WORLD_FFMPEG_BUILD_REPORT.${target}.v1.json`
  const artifactBytes = Buffer.from('artifact')
  const reportBytes = Buffer.from('{}\n')
  await writeFile(join(root, artifactName), artifactBytes)
  await writeFile(join(root, reportName), reportBytes)
  const rootIdentity = directoryIdentity(await lstat(root, { bigint: true }))
  const artifact = fileReceipt(artifactName, await lstat(join(root, artifactName), { bigint: true }), artifactBytes)
  const report = fileReceipt(reportName, await lstat(join(root, reportName), { bigint: true }), reportBytes)
  const manifest = {
    schema: 'modly.electron-builder-package-result.v1',
    attemptId: token,
    target,
    publicationToken,
    outputIdentity: rootIdentity,
    artifacts: [{ path: artifact.name, dev: artifact.dev, ino: artifact.ino, size: artifact.size, sha256: artifact.sha256 }],
    buildReport: { path: report.name, dev: report.dev, ino: report.ino, size: report.size, sha256: report.sha256 },
    inspection: {
      schema: 'modly.world-ffmpeg-artifact-inspection.v1',
      target,
      artifact: { path: artifact.name, dev: artifact.dev, ino: artifact.ino, size: artifact.size, sha256: artifact.sha256 },
      runtimeManifestSha256: 'a'.repeat(64),
      buildReportSha256: report.sha256,
      extractor: extractorProof((await loadWorldFfmpegPackageToolLock()).extractors[target]),
    },
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  await writeFile(join(root, resultName), manifestBytes)
  const manifestFile = fileReceipt(resultName, await lstat(join(root, resultName), { bigint: true }), manifestBytes)
  const receipt = {
    schema: 'modly.electron-builder-package-result-receipt.v1',
    attemptId: token,
    target,
    publicationToken,
    manifestPath: join(root, resultName),
    outputIdentity: rootIdentity,
    manifestFile,
  }
  assert.equal((await loadWorldFfmpegPackageResult(receipt.manifestPath, {
    resultReceipt: receipt,
    outputCustody: _testOnlyRunWorldFfmpegOutputCustodyInProcess,
  })).attemptId, token)

  await mkdir(replacement)
  for (const [name, bytes] of [[artifactName, artifactBytes], [reportName, reportBytes], [resultName, manifestBytes]]) {
    await writeFile(join(replacement, name), bytes)
  }
  const displaced = join(parent, 'original')
  await rename(root, displaced)
  await rename(replacement, root)
  await assert.rejects(
    loadWorldFfmpegPackageResult(receipt.manifestPath, {
      resultReceipt: receipt,
      outputCustody: _testOnlyRunWorldFfmpegOutputCustodyInProcess,
    }),
    /root identity|identity changed/i,
  )
  await rename(root, replacement)
  await rename(displaced, root)
})

test('package-result GitHub outputs retain one ordinary inode and reject links or pathname swaps', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'modly-package-github-output-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const fixture = await createPackageUploadFixture(parent)
  const bootstrapOutputPath = join(parent, 'bootstrap.txt')
  const encoded = Buffer.from(JSON.stringify(fixture.resultReceipt)).toString('base64')
  await writeFile(bootstrapOutputPath, `WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT=${encoded}\n`)
  const { publishWorldFfmpegPackageGithubOutputs } = await import('./world-ffmpeg-package-result.mjs')

  const ordinary = join(parent, 'github-output')
  await writeFile(ordinary, '')
  await publishWorldFfmpegPackageGithubOutputs({
    bootstrapOutputPath, githubOutputPath: ordinary,
    outputCustody: _testOnlyRunWorldFfmpegOutputCustodyInProcess,
  })
  const ordinaryBytes = await readFile(ordinary, 'utf8')
  assert.match(ordinaryBytes, /^WORLD_FFMPEG_PACKAGE_RESULT=/m)
  assert.match(ordinaryBytes, /^WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT=/m)

  const symlinkTarget = join(parent, 'symlink-target')
  const symlinkOutput = join(parent, 'symlink-output')
  await writeFile(symlinkTarget, 'foreign symlink target')
  await symlink(symlinkTarget, symlinkOutput)
  await assert.rejects(publishWorldFfmpegPackageGithubOutputs({
    bootstrapOutputPath, githubOutputPath: symlinkOutput,
    outputCustody: _testOnlyRunWorldFfmpegOutputCustodyInProcess,
  }), /ordinary|single-link|symbolic|output/i)
  assert.equal(await readFile(symlinkTarget, 'utf8'), 'foreign symlink target')

  const hardlinkTarget = join(parent, 'hardlink-target')
  const hardlinkOutput = join(parent, 'hardlink-output')
  await writeFile(hardlinkTarget, 'foreign hardlink target')
  await link(hardlinkTarget, hardlinkOutput)
  await assert.rejects(publishWorldFfmpegPackageGithubOutputs({
    bootstrapOutputPath, githubOutputPath: hardlinkOutput,
    outputCustody: _testOnlyRunWorldFfmpegOutputCustodyInProcess,
  }), /ordinary|single-link|output/i)
  assert.equal(await readFile(hardlinkTarget, 'utf8'), 'foreign hardlink target')

  const swapped = join(parent, 'swapped-output')
  const displaced = join(parent, 'swapped-output.opened')
  await writeFile(swapped, '')
  await assert.rejects(publishWorldFfmpegPackageGithubOutputs({
    bootstrapOutputPath,
    githubOutputPath: swapped,
    outputCustody: _testOnlyRunWorldFfmpegOutputCustodyInProcess,
    githubOutputDependencies: {
      async afterOpen() {
        await rename(swapped, displaced)
        await writeFile(swapped, 'foreign swapped output')
      },
    },
  }), /identity changed|replaced/i)
  assert.equal(await readFile(swapped, 'utf8'), 'foreign swapped output')
})

test('release uploader streams only retained verified descriptors and rejects a pathname replacement', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'modly-same-handle-upload-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const token = '7'.repeat(32)
  const publicationToken = '8'.repeat(32)
  const target = 'linux-x64'
  const root = join(parent, `output-${token}`)
  await mkdir(root)
  const artifactName = 'Modly-same-handle.AppImage'
  const reportName = `WORLD_FFMPEG_BUILD_REPORT.${target}.v1.json`
  const resultName = `RESULT.${target}.v1.json`
  const artifactBytes = Buffer.from('verified deployable A')
  const replacementBytes = Buffer.from('foreign deployable B')
  const reportBytes = Buffer.from('{}\n')
  await writeFile(join(root, artifactName), artifactBytes)
  await writeFile(join(root, reportName), reportBytes)
  const outputIdentity = directoryIdentity(await lstat(root, { bigint: true }))
  const artifactReceipt = fileReceipt(
    artifactName, await lstat(join(root, artifactName), { bigint: true }), artifactBytes,
  )
  const reportReceipt = fileReceipt(
    reportName, await lstat(join(root, reportName), { bigint: true }), reportBytes,
  )
  const extractor = (await loadWorldFfmpegPackageToolLock()).extractors[target]
  const manifest = {
    schema: 'modly.electron-builder-package-result.v1',
    attemptId: token,
    target,
    publicationToken,
    outputIdentity,
    artifacts: [{ path: artifactName, ...artifactReceipt }].map(({ name: _name, ...value }) => value),
    buildReport: { path: reportName, ...reportReceipt, name: undefined },
    inspection: {
      schema: 'modly.world-ffmpeg-artifact-inspection.v1', target,
      artifact: { path: artifactName, ...artifactReceipt, name: undefined },
      runtimeManifestSha256: 'a'.repeat(64),
      buildReportSha256: reportReceipt.sha256,
      extractor: extractorProof(extractor),
    },
  }
  delete manifest.buildReport.name
  delete manifest.inspection.artifact.name
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  await writeFile(join(root, resultName), manifestBytes)
  const manifestFile = fileReceipt(
    resultName, await lstat(join(root, resultName), { bigint: true }), manifestBytes,
  )
  const resultReceipt = {
    schema: 'modly.electron-builder-package-result-receipt.v1',
    attemptId: token, target, publicationToken,
    manifestPath: join(root, resultName), outputIdentity, manifestFile,
  }
  const { verifyOrUploadWorldFfmpegPackageResult } = await import('./world-ffmpeg-release-uploader.mjs')
  const verified = await verifyOrUploadWorldFfmpegPackageResult({ resultReceipt, verifyOnly: true })
  assert.deepEqual(verified.verified.map(({ name }) => name), [artifactName, reportName, resultName])
  assert.equal(verified.verificationReceipt.schema, 'modly.electron-builder-package-verification-receipt.v1')
  assert.equal(verified.verificationReceipt.uploaded, false)
  assert.deepEqual(verified.verificationReceipt.outputIdentity, outputIdentity)

  const uploaded = new Map()
  let nextRemoteId = 1
  const releaseClient = {
    async ensureRelease({ title, body, targetCommitish }) {
      return {
        id: 1, tag: RELEASE_TAG, title, body, targetCommitish, draft: true,
      }
    },
    async getRelease() {
      return {
        id: 1, tag: RELEASE_TAG, title: RELEASE_TITLE, body: RELEASE_BODY,
        targetCommitish: RELEASE_COMMIT, draft: true,
      }
    },
    async listAssets() {
      return [...uploaded.values()].map(({ bytes: _bytes, ...asset }) => asset)
    },
    async verifyAsset({ asset, expected }) {
      const stored = uploaded.get(asset.name)
      if (!stored || stored.id !== asset.id || stored.size !== expected.size
        || sha256(stored.bytes) !== expected.sha256) throw new Error('fixture remote digest conflict')
      return { size: stored.size, sha256: expected.sha256 }
    },
    async uploadAsset({ name, size, chunks }) {
      const values = []
      for await (const chunk of chunks) values.push(Buffer.from(chunk))
      const bytes = Buffer.concat(values)
      const asset = { id: nextRemoteId++, name, size, state: 'uploaded', bytes }
      uploaded.set(name, asset)
      return { assetId: asset.id, name, size }
    },
    async deleteAsset(asset) { uploaded.delete(asset.name) },
  }
  const releaseSetupReceipt = await createReleaseSetupReceipt(releaseClient)
  const displaced = join(parent, 'opened-artifact')
  await assert.rejects(verifyOrUploadWorldFfmpegPackageResult({
    resultReceipt,
    repository: 'modly/example',
    tag: 'v1.0.0',
    releaseSetupReceipt,
    releaseClient,
    token: 'not-used-by-injected-transport',
    async beforeUpload() {
      await rename(join(root, artifactName), displaced)
      await writeFile(join(root, artifactName), replacementBytes)
    },
  }), /was replaced after open/i)
  assert.ok([...uploaded.values()].some(({ bytes }) => bytes.equals(artifactBytes)))
  assert.deepEqual(await readFile(join(root, artifactName)), replacementBytes)
  await assert.rejects(lstat(join(root, `UPLOAD.${target}.v1.json`)), /ENOENT/)

  await rm(join(root, artifactName))
  await rename(displaced, join(root, artifactName))
  for (const name of [...uploaded.keys()]) {
    if (name !== releaseSetupReceipt.generationLock.name) uploaded.delete(name)
  }
  const completed = await verifyOrUploadWorldFfmpegPackageResult({
    resultReceipt,
    repository: 'modly/example',
    tag: 'v1.0.0',
    releaseSetupReceipt,
    releaseClient,
    token: 'not-used-by-injected-transport',
  })
  assert.equal(completed.uploadReceipt.schema, 'modly.electron-builder-package-upload-receipt.v1')
  assert.equal(completed.uploadReceipt.target, target)
  assert.equal(completed.uploadResultReceipt.schema, 'modly.electron-builder-package-upload-result-receipt.v1')
  assert.deepEqual(completed.uploadResultReceipt.outputIdentity, outputIdentity)
  assert.ok(completed.uploadReceipt.assets.every(({ name }) => (
    new RegExp(`^world-ffmpeg-package-${target}-[a-f0-9]{64}-`).test(name)
  )))
  assert.ok(completed.uploadResultReceipt.uploadReceiptFile.name.startsWith(
    `world-ffmpeg-package-${target}-`,
  ))
  assert.deepEqual(new Set(uploaded.keys()), new Set([
    releaseSetupReceipt.generationLock.name,
    ...completed.uploadReceipt.assets.map(({ name }) => name),
    completed.uploadResultReceipt.uploadReceiptFile.name,
  ]))
  const uploadedArtifact = completed.uploadReceipt.assets.find(({ sha256: digest }) => digest === sha256(artifactBytes))
  assert.deepEqual(uploaded.get(uploadedArtifact.name).bytes, artifactBytes)
})

test('package and source uploaders reject stale release metadata between asset mutations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-release-stale-metadata-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const kind of ['package', 'source']) {
    const directory = join(root, kind)
    await mkdir(directory)
    let release = {
      id: 5, tag: RELEASE_TAG, title: RELEASE_TITLE, body: RELEASE_BODY,
      targetCommitish: RELEASE_COMMIT, draft: true,
    }
    const assets = new Map()
    let armed = false
    let payloadUploads = 0
    const client = {
      async ensureRelease() { return { ...release } },
      async getRelease() { return { ...release } },
      async listAssets() { return [...assets.values()].map(({ bytes: _bytes, ...asset }) => asset) },
      async verifyAsset({ asset, expected }) {
        const stored = assets.get(asset.name)
        assert.equal(sha256(stored.bytes), expected.sha256)
        return { size: stored.size, sha256: expected.sha256 }
      },
      async readAsset({ asset }) { return Buffer.from(assets.get(asset.name).bytes) },
      async uploadAsset({ name, size, chunks }) {
        const pieces = []
        for await (const chunk of chunks) pieces.push(Buffer.from(chunk))
        const bytes = Buffer.concat(pieces)
        assert.equal(bytes.length, size)
        const asset = { id: assets.size + 10, name, size, bytes }
        assets.set(name, asset)
        if (armed) {
          payloadUploads += 1
          release = { ...release, body: 'Maintainer edited release notes' }
        }
        return { assetId: asset.id, name, size }
      },
    }
    const releaseSetupReceipt = await createReleaseSetupReceipt(client)
    let run
    if (kind === 'package') {
      const fixture = await createPackageUploadFixture(directory)
      const { verifyOrUploadWorldFfmpegPackageResult } = await import('./world-ffmpeg-release-uploader.mjs')
      run = () => verifyOrUploadWorldFfmpegPackageResult({
        resultReceipt: fixture.resultReceipt, repository: RELEASE_REPOSITORY, tag: RELEASE_TAG,
        releaseClient: client, releaseSetupReceipt,
      })
    } else {
      const prepared = join(directory, 'prepared')
      const destination = join(directory, 'destination')
      await mkdir(prepared)
      await mkdir(destination)
      const archiveName = 'modly-world-ffmpeg-7.1.1-sources.tar.xz'
      const archive = Buffer.from('deterministic source fixture')
      await writeFile(join(prepared, archiveName), archive)
      await writeFile(join(prepared, `${archiveName}.sha256`), `${sha256(archive)}  ${archiveName}\n`)
      const { publishWorldFfmpegSourceGeneration } = await import('./world-ffmpeg-source-publication.mjs')
      const generation = await publishWorldFfmpegSourceGeneration({ preparedDirectory: prepared, destinationDirectory: destination })
      const { uploadWorldFfmpegSourceGeneration } = await import('./world-ffmpeg-source-release-uploader.mjs')
      run = () => uploadWorldFfmpegSourceGeneration({
        generationDirectory: generation.generationDirectory, repository: RELEASE_REPOSITORY, tag: RELEASE_TAG,
        releaseClient: client, releaseSetupReceipt,
      })
    }
    armed = true
    await assert.rejects(run(), /metadata|authority|conflict/i, kind)
    assert.equal(payloadUploads, 1, `${kind} continued mutating after the release changed`)
  }
})

test('release uploader reconciles ambiguous stores and 422 duplicates, resumes reruns, and rejects foreign assets', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'modly-release-resume-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const fixture = await createPackageUploadFixture(parent)
  const remote = new Map()
  const attempts = new Map()
  let nextId = 10
  const client = {
    async ensureRelease({ title, body, targetCommitish }) {
      return { id: 5, tag: RELEASE_TAG, title, body, targetCommitish, draft: true }
    },
    async getRelease() {
      return {
        id: 5, tag: RELEASE_TAG, title: RELEASE_TITLE, body: RELEASE_BODY,
        targetCommitish: RELEASE_COMMIT, draft: true,
      }
    },
    async getDraftRelease() {
      return {
        id: 5, tag: RELEASE_TAG, title: RELEASE_TITLE, body: RELEASE_BODY,
        targetCommitish: RELEASE_COMMIT, draft: true,
      }
    },
    async listAssets() {
      return [...remote.values()].map(({ bytes: _bytes, ...asset }) => asset)
    },
    async verifyAsset({ asset, expected }) {
      const stored = remote.get(asset.name)
      assert.ok(stored)
      const observed = { size: stored.bytes.byteLength, sha256: sha256(stored.bytes) }
      if (observed.size !== expected.size || observed.sha256 !== expected.sha256) {
        throw new Error(`foreign remote asset conflict: ${asset.name}`)
      }
      return observed
    },
    async uploadAsset({ name, size, chunks }) {
      const values = []
      for await (const chunk of chunks) values.push(chunk)
      const bytes = Buffer.concat(values)
      assert.equal(bytes.byteLength, size)
      const attempt = (attempts.get(name) ?? 0) + 1
      attempts.set(name, attempt)
      if (!remote.has(name)) remote.set(name, { id: nextId++, name, size, bytes })
      if (name.endsWith('-artifact.AppImage') && attempt === 1) {
        throw Object.assign(new Error('socket timed out after remote store'), {
          retryable: true, ambiguous: true,
        })
      }
      if (name.endsWith('-build-report.v1.json') && attempt === 1) {
        throw Object.assign(new Error('duplicate'), { statusCode: 422, ambiguous: true })
      }
      return { assetId: remote.get(name).id, name, size }
    },
    async deleteAsset(asset) {
      const stored = remote.get(asset.name)
      assert.equal(stored?.id, asset.id)
      remote.delete(asset.name)
    },
  }
  const { verifyOrUploadWorldFfmpegPackageResult } = await import('./world-ffmpeg-release-uploader.mjs')
  const releaseSetupReceipt = await createReleaseSetupReceipt(client)
  const first = await verifyOrUploadWorldFfmpegPackageResult({
    resultReceipt: fixture.resultReceipt,
    repository: 'modly/example', tag: 'v1.0.0', releaseClient: client, releaseSetupReceipt,
  })
  assert.equal(first.uploadResultReceipt.releaseId, 5)
  assert.equal(remote.size, 5)
  const artifactAsset = first.uploadReceipt.assets.find(({ sha256: digest }) => digest === sha256(fixture.artifactBytes))
  const reportAsset = first.uploadReceipt.assets.find(({ sha256: digest }) => digest === sha256(fixture.reportBytes))
  assert.equal(attempts.get(artifactAsset.name), 1)
  assert.equal(attempts.get(reportAsset.name), 1)

  const attemptsBeforeRerun = new Map(attempts)
  const rerun = await verifyOrUploadWorldFfmpegPackageResult({
    resultReceipt: fixture.resultReceipt,
    repository: 'modly/example', tag: 'v1.0.0', releaseClient: client, releaseSetupReceipt,
  })
  assert.deepEqual(rerun.uploadResultReceipt, first.uploadResultReceipt)
  assert.deepEqual(attempts, attemptsBeforeRerun)

  const nextFixture = await createPackageUploadFixture(parent, {
    token: '9'.repeat(32), publicationToken: 'a'.repeat(32),
    artifactBytes: fixture.artifactBytes, reportBytes: fixture.reportBytes,
  })
  const converged = await verifyOrUploadWorldFfmpegPackageResult({
    resultReceipt: nextFixture.resultReceipt,
    repository: 'modly/example', tag: 'v1.0.0', releaseClient: client, releaseSetupReceipt,
  })
  assert.equal(remote.size, 5)
  assert.deepEqual(new Set(remote.keys()), new Set([
    releaseSetupReceipt.generationLock.name,
    ...converged.uploadReceipt.assets.map(({ name }) => name),
    converged.uploadResultReceipt.uploadReceiptFile.name,
  ]))

  const stored = remote.get(artifactAsset.name)
  stored.bytes = Buffer.from('foreign bytes with same length'.padEnd(stored.size, '!').slice(0, stored.size))
  await assert.rejects(verifyOrUploadWorldFfmpegPackageResult({
    resultReceipt: fixture.resultReceipt,
    repository: 'modly/example', tag: 'v1.0.0', releaseClient: client, releaseSetupReceipt,
  }), /foreign remote asset conflict|digest|conflict/i)
})

test('content-addressed GitHub assets converge after stale 409, 422, and owned starter responses', async () => {
  const {
    reconcileWorldFfmpegGithubAsset,
    worldFfmpegGithubContentAddressedAssetName,
  } = await import('./world-ffmpeg-github-release.mjs')
  const bytes = Buffer.from('exact deployable bytes')
  const digest = sha256(bytes)
  const createStream = () => {
    let complete = false
    return {
      chunks: (async function * () { yield bytes; complete = true })(),
      assertComplete() { assert.equal(complete, true) },
    }
  }
  const run = async (statusCode, starter = false) => {
    const name = worldFfmpegGithubContentAddressedAssetName(
      'package-linux-x64', digest, statusCode === 409 ? 'artifact.AppImage' : 'result.v1.json',
    )
    let asset = starter ? { id: 40, name, size: 0, state: 'starter', bytes: Buffer.alloc(0) } : null
    let nextId = 41
    let staleListings = 0
    let deletes = 0
    let uploads = 0
    const client = {
      async listAssets() {
        if (asset && staleListings++ === 0 && !starter) return []
        return asset ? [{ id: asset.id, name: asset.name, size: asset.size, state: asset.state }] : []
      },
      async verifyAsset({ asset: candidate, expected }) {
        assert.equal(candidate.id, asset.id)
        if (asset.size !== expected.size || sha256(asset.bytes) !== expected.sha256) {
          throw new Error('foreign remote asset conflict')
        }
      },
      async deleteAsset(candidate) {
        assert.equal(candidate.id, asset.id)
        asset = null
        deletes += 1
      },
      async uploadAsset({ name: uploadedName, size, chunks }) {
        uploads += 1
        const chunksRead = []
        for await (const chunk of chunks) chunksRead.push(chunk)
        const uploaded = Buffer.concat(chunksRead)
        assert.equal(uploadedName, name)
        assert.equal(size, bytes.byteLength)
        asset = { id: nextId++, name, size, state: 'uploaded', bytes: uploaded }
        if (uploads === 1 && !starter) {
          throw Object.assign(new Error(`ambiguous ${statusCode}`), {
            statusCode, ambiguous: true, retryable: statusCode === 409,
          })
        }
        return { assetId: asset.id, name, size }
      },
      async waitForRetry() {},
    }
    const result = await reconcileWorldFfmpegGithubAsset({
      client, releaseId: 7, expected: { name, size: bytes.byteLength, sha256: digest },
      createStream, maxAttempts: 3,
    })
    assert.equal(result.name, name)
    assert.equal(result.sha256, digest)
    assert.equal(deletes, starter ? 1 : 0)
    assert.equal(uploads, 1)
  }
  await run(409)
  await run(422)
  await run(201, true)

  const foreignName = worldFfmpegGithubContentAddressedAssetName(
    'package-linux-x64', digest, 'artifact.AppImage',
  )
  let deleted = false
  await assert.rejects(reconcileWorldFfmpegGithubAsset({
    client: {
      async listAssets() { return [{ id: 99, name: foreignName, size: bytes.byteLength, state: 'uploaded' }] },
      async verifyAsset() { throw new Error('foreign remote digest conflict') },
      async deleteAsset() { deleted = true },
      async uploadAsset() { throw new Error('must not upload') },
    },
    releaseId: 7,
    expected: { name: foreignName, size: bytes.byteLength, sha256: digest },
    createStream,
  }), /foreign|digest|conflict/i)
  assert.equal(deleted, false)
})

test('source release upload reopens exact generation bytes and is idempotent on rerun', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-source-release-upload-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const prepared = join(root, 'prepared')
  const destination = join(root, 'destination')
  await mkdir(prepared)
  await mkdir(destination)
  const archiveName = 'modly-world-ffmpeg-7.1.1-sources.tar.xz'
  const archive = Buffer.from('deterministic source archive')
  await writeFile(join(prepared, archiveName), archive)
  await writeFile(join(prepared, `${archiveName}.sha256`), `${sha256(archive)}  ${archiveName}\n`)
  const {
    publishWorldFfmpegSourceGeneration,
  } = await import('./world-ffmpeg-source-publication.mjs')
  const generation = await publishWorldFfmpegSourceGeneration({
    preparedDirectory: prepared, destinationDirectory: destination,
  })
  const preparedGarbage = (await readdir(root)).find((name) => (
    /^\.WORLD_FFMPEG_GC\.quarantine-[a-f0-9]{32}$/.test(name)
  ))
  assert.ok(preparedGarbage)
  const preparedOwned = join(root, preparedGarbage, 'owned')
  assert.equal((await lstat(join(preparedOwned, archiveName))).size, 0)
  assert.equal(
    JSON.parse(await readFile(join(preparedOwned, '.WORLD_FFMPEG_GC.v1.json'))).schema,
    'modly.world-ffmpeg-owned-garbage-receipt.v1',
  )
  const claimGarbage = (await readdir(destination)).find((name) => (
    /^\.WORLD_FFMPEG_GC\.quarantine-[a-f0-9]{32}$/.test(name)
  ))
  assert.ok(claimGarbage)
  assert.equal((await lstat(join(destination, claimGarbage, 'owned'))).size, 0)
  assert.equal(
    JSON.parse(await readFile(join(destination, claimGarbage, 'owned.GC.v1.json'))).schema,
    'modly.world-ffmpeg-owned-garbage-receipt.v1',
  )
  const remote = new Map()
  let nextId = 40
  let uploads = 0
  const client = {
    async ensureRelease({ title, body, targetCommitish }) {
      return { id: 9, tag: RELEASE_TAG, title, body, targetCommitish, draft: true }
    },
    async getRelease() {
      return {
        id: 9, tag: RELEASE_TAG, title: RELEASE_TITLE, body: RELEASE_BODY,
        targetCommitish: RELEASE_COMMIT, draft: true,
      }
    },
    async getDraftRelease() { return this.getRelease() },
    async listAssets() { return [...remote.values()].map(({ bytes: _bytes, ...asset }) => asset) },
    async verifyAsset({ asset, expected }) {
      const stored = remote.get(asset.name)
      const observed = { size: stored.bytes.byteLength, sha256: sha256(stored.bytes) }
      if (observed.size !== expected.size || observed.sha256 !== expected.sha256) throw new Error('source conflict')
      return observed
    },
    async readAsset({ asset, maximumBytes }) {
      const stored = remote.get(asset.name)
      assert.ok(stored.bytes.byteLength <= maximumBytes)
      return Buffer.from(stored.bytes)
    },
    async uploadAsset({ name, size, chunks }) {
      uploads += 1
      const values = []
      for await (const chunk of chunks) values.push(chunk)
      const bytes = Buffer.concat(values)
      const asset = { id: nextId++, name, size, bytes }
      remote.set(name, asset)
      return { assetId: asset.id, name, size }
    },
  }
  const {
    uploadWorldFfmpegSourceGeneration,
    _testOnlyCloseWorldFfmpegSourceUploadFiles,
  } = await import('./world-ffmpeg-source-release-uploader.mjs')
  const releaseSetupReceipt = await createReleaseSetupReceipt(client)
  const first = await uploadWorldFfmpegSourceGeneration({
    generationDirectory: generation.generationDirectory,
    repository: 'modly/example', tag: 'v1.0.0', releaseClient: client, releaseSetupReceipt,
  })
  assert.equal(first.uploadResultReceipt.releaseId, 9)
  assert.equal(remote.size, 6)
  assert.equal(uploads, 6)
  assert.ok([...remote.keys()].filter((name) => name !== releaseSetupReceipt.generationLock.name).every((name) => (
    /^world-ffmpeg-source-[a-f0-9]{64}-/.test(name)
  )))
  const second = await uploadWorldFfmpegSourceGeneration({
    generationDirectory: generation.generationDirectory,
    repository: 'modly/example', tag: 'v1.0.0', releaseClient: client, releaseSetupReceipt,
  })
  assert.deepEqual(second.uploadResultReceipt, first.uploadResultReceipt)
  assert.equal(uploads, 6)

  const preparedRetry = join(root, 'prepared-retry')
  const destinationRetry = join(root, 'destination-retry')
  await mkdir(preparedRetry)
  await mkdir(destinationRetry)
  await writeFile(join(preparedRetry, archiveName), archive)
  await writeFile(join(preparedRetry, `${archiveName}.sha256`), `${sha256(archive)}  ${archiveName}\n`)
  const retryGeneration = await publishWorldFfmpegSourceGeneration({
    preparedDirectory: preparedRetry, destinationDirectory: destinationRetry,
  })
  assert.notEqual(
    await readFile(join(retryGeneration.generationDirectory, 'GENERATION.v1.json'), 'utf8'),
    await readFile(join(generation.generationDirectory, 'GENERATION.v1.json'), 'utf8'),
  )
  const resumed = await uploadWorldFfmpegSourceGeneration({
    generationDirectory: retryGeneration.generationDirectory,
    repository: 'modly/example', tag: 'v1.0.0', releaseClient: client, releaseSetupReceipt,
  })
  assert.deepEqual(resumed.uploadResultReceipt, first.uploadResultReceipt)
  assert.equal(uploads, 6)

  const primaryError = new Error('source upload failed')
  const closeError = new Error('source descriptor close failed')
  await assert.rejects(
    _testOnlyCloseWorldFfmpegSourceUploadFiles([
      { handle: { async close() { throw closeError } } },
    ], primaryError),
    (error) => error instanceof AggregateError
      && error.errors.length === 2
      && error.errors[0] === primaryError
      && error.errors[1] === closeError,
  )
})

test('source publication cleanup reclaims its retained claim inode and preserves a final-name replacement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-source-cleanup-aba-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const prepared = join(root, 'prepared')
  const destination = join(root, 'destination')
  const archiveName = 'modly-world-ffmpeg-7.1.1-sources.tar.xz'
  const archive = Buffer.from('source cleanup ABA archive')
  await mkdir(prepared)
  await mkdir(destination)
  await writeFile(join(prepared, archiveName), archive)
  await writeFile(join(prepared, `${archiveName}.sha256`), `${sha256(archive)}  ${archiveName}\n`)
  const { publishWorldFfmpegSourceGeneration } = await import('./world-ffmpeg-source-publication.mjs')
  let displaced
  let replacement
  await assert.rejects(publishWorldFfmpegSourceGeneration({
    preparedDirectory: prepared,
    destinationDirectory: destination,
    async beforeClaimRetirement({ quarantinePath }) {
      displaced = `${quarantinePath}.owned`
      replacement = quarantinePath
      await rename(quarantinePath, displaced)
      await writeFile(quarantinePath, 'foreign claim replacement')
    },
  }), /replaced during cleanup retirement|foreign replacement/i)
  assert.equal(await readFile(replacement, 'utf8'), 'foreign claim replacement')
  assert.equal((await lstat(displaced)).size, 0)
})

test('release setup publishes one immutable generation lock and publication converges forward without conditional ownership', async () => {
  const {
    ensureWorldFfmpegReleaseDraft,
    requireWorldFfmpegReleaseDraftReceipt,
  } = await import('./world-ffmpeg-release-draft.mjs')
  const { createWorldFfmpegGithubReleaseClient } = await import('./world-ffmpeg-github-release.mjs')
  const repository = 'modly/example'
  const tag = 'v1.0.0'
  const title = 'Modly Beta v1.0.0'
  const body = RELEASE_BODY
  const targetCommitish = RELEASE_COMMIT
  const releaseId = 41
  const remote = new Map()
  let uploads = 0
  const setupClient = {
    async ensureRelease(metadata) {
      assert.deepEqual(metadata, { title, body, targetCommitish })
      return { id: releaseId, tag, title, body, targetCommitish, draft: true }
    },
    async listAssets() {
      return [...remote.values()].map(({ bytes: _bytes, ...asset }) => asset)
    },
    async uploadAsset({ name, size, chunks }) {
      const pieces = []
      for await (const chunk of chunks) pieces.push(Buffer.from(chunk))
      const bytes = Buffer.concat(pieces)
      assert.equal(bytes.byteLength, size)
      const asset = { id: 500, name, size, state: 'uploaded', bytes }
      remote.set(name, asset)
      uploads += 1
      return { assetId: asset.id, name, size }
    },
    async verifyAsset({ asset, expected }) {
      const stored = remote.get(asset.name)
      assert.ok(stored)
      assert.equal(stored.id, asset.id)
      assert.equal(stored.size, expected.size)
      assert.equal(sha256(stored.bytes), expected.sha256)
      return { size: stored.size, sha256: expected.sha256 }
    },
    async readAsset({ asset }) { return Buffer.from(remote.get(asset.name).bytes) },
  }
  const first = await ensureWorldFfmpegReleaseDraft({
    repository, tag, title, body, targetCommitish, releaseClient: setupClient,
  })
  assert.equal(first.generationLock.name, 'WORLD_FFMPEG_RELEASE_GENERATION.v1.json')
  assert.equal(first.metadata.title, title)
  assert.equal(first.metadata.body, body)
  assert.equal(first.metadata.targetCommitish, targetCommitish)
  assert.equal(first.metadata.draft, true)
  assert.equal(uploads, 1)
  const second = await ensureWorldFfmpegReleaseDraft({
    repository, tag, title, body, targetCommitish, releaseClient: setupClient,
  })
  assert.deepEqual(second, first)
  assert.equal(uploads, 1)
  assert.deepEqual(requireWorldFfmpegReleaseDraftReceipt(first, {
    repository, tag, title, body, targetCommitish,
  }), first)

  const releaseBody = (draft) => Buffer.from(JSON.stringify({
    id: releaseId,
    tag_name: tag,
    name: title,
    body,
    target_commitish: targetCommitish,
    draft,
    upload_url: `https://uploads.github.com/repos/modly/example/releases/${releaseId}/assets{?name,label}`,
  }))
  let draft = true
  let patchCalls = 0
  let patchHeaders
  let patchBody
  const requestFactory = (options, onResponse) => {
    const request = new EventEmitter()
    const written = []
    request.write = (bytes) => { written.push(Buffer.from(bytes)); return true }
    request.destroy = () => undefined
    request.end = () => queueMicrotask(() => {
      if (options.method === 'PATCH') {
        patchCalls += 1
        patchHeaders = options.headers
        patchBody = Buffer.concat(written)
        draft = false
      }
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = { etag: '"opaque-cache-validator"' }
      response.destroy = () => undefined
      onResponse(response)
      response.emit('data', releaseBody(draft))
      response.emit('end')
      response.emit('close')
    })
    return request
  }
  const github = createWorldFfmpegGithubReleaseClient({
    repository, tag, token: 'fixture', requestFactory, maxAttempts: 3,
  })
  const transition = await github.publishRelease({
    releaseId, metadata: first.metadata,
  })
  assert.equal(transition.release.draft, false)
  assert.equal(transition.publicationProof.settlement, 'patch-response')
  assert.equal('transitionOwned' in transition.publicationProof, false)
  assert.equal('expectedEtag' in transition.publicationProof, false)
  assert.equal(patchCalls, 1)
  assert.equal('if-match' in patchHeaders, false)
  assert.deepEqual(JSON.parse(patchBody), {
    tag_name: tag,
    target_commitish: targetCommitish,
    name: title,
    body,
    draft: false,
    make_latest: 'true',
  })
})

test('release draft setup is idempotent and rejects a mismatched existing authority', async () => {
  const { ensureWorldFfmpegReleaseDraft } = await import('./world-ffmpeg-release-draft.mjs')
  let creates = 0
  let draft = true
  let nextId = 17
  const remote = new Map()
  const matchingClient = {
    async ensureRelease({ title, body, targetCommitish }) {
      creates += 1
      return { id: 17, tag: RELEASE_TAG, title, body, targetCommitish, draft }
    },
    async listAssets() { return [...remote.values()].map(({ bytes: _bytes, ...asset }) => asset) },
    async uploadAsset({ name, size, chunks }) {
      const values = []
      for await (const chunk of chunks) values.push(Buffer.from(chunk))
      const bytes = Buffer.concat(values)
      const asset = { id: nextId++, name, size, state: 'uploaded', bytes }
      remote.set(name, asset)
      return { assetId: asset.id, name, size }
    },
    async verifyAsset({ asset, expected }) {
      const stored = remote.get(asset.name)
      if (!stored || stored.id !== asset.id || stored.size !== expected.size
        || sha256(stored.bytes) !== expected.sha256) throw new Error('generation lock conflict')
    },
  }
  const first = await ensureWorldFfmpegReleaseDraft({
    repository: RELEASE_REPOSITORY, tag: RELEASE_TAG, title: RELEASE_TITLE,
    body: RELEASE_BODY, targetCommitish: RELEASE_COMMIT,
    releaseClient: matchingClient,
  })
  const second = await ensureWorldFfmpegReleaseDraft({
    repository: RELEASE_REPOSITORY, tag: RELEASE_TAG, title: RELEASE_TITLE,
    body: RELEASE_BODY, targetCommitish: RELEASE_COMMIT,
    releaseClient: matchingClient,
  })
  assert.deepEqual(second, first)
  assert.equal(creates, 2)
  await assert.rejects(ensureWorldFfmpegReleaseDraft({
    repository: RELEASE_REPOSITORY, tag: RELEASE_TAG, title: RELEASE_TITLE,
    body: RELEASE_BODY, targetCommitish: RELEASE_COMMIT,
    releaseClient: {
      async ensureRelease() {
        return {
          id: 17, tag: RELEASE_TAG, title: 'Foreign title', body: RELEASE_BODY,
          targetCommitish: RELEASE_COMMIT, draft: true,
        }
      },
    },
  }), /authority|mismatch|conflict/i)

  draft = false
  const resumed = await ensureWorldFfmpegReleaseDraft({
    repository: RELEASE_REPOSITORY, tag: RELEASE_TAG, title: RELEASE_TITLE,
    body: RELEASE_BODY, targetCommitish: RELEASE_COMMIT,
    releaseClient: matchingClient,
  })
  assert.equal(resumed.releaseId, 17)
  assert.deepEqual(resumed, first)
})

test('three legacy package uploads cannot publish the four-target release', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-release-whole-workflow-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = 'modly/example'
  const tag = 'v1.0.0'
  const title = 'Modly Beta v1.0.0'
  const body = RELEASE_BODY
  const targetCommitish = RELEASE_COMMIT
  const releaseId = 91
  const remote = new Map()
  let nextId = 100
  let draft = true
  let uploads = 0
  let publishes = 0
  const client = {
    async ensureRelease({ title: requestedTitle, body: requestedBody, targetCommitish: requestedCommit }) {
      if (requestedTitle !== title || requestedBody !== body || requestedCommit !== targetCommitish) {
        throw new Error('release metadata conflict')
      }
      return { id: releaseId, tag, title, body, targetCommitish, draft }
    },
    async ensureDraftRelease({ title: requestedTitle }) {
      if (requestedTitle !== title || !draft) throw new Error('release is already public')
      return { id: releaseId, tag, title, body, targetCommitish, draft: true }
    },
    async getRelease() { return { id: releaseId, tag, title, body, targetCommitish, draft } },
    async getDraftRelease() {
      if (!draft) throw new Error('release is already public')
      return { id: releaseId, tag, title, body, targetCommitish, draft: true }
    },
    async listAssets() {
      return [...remote.values()].map(({ bytes: _bytes, ...asset }) => ({ ...asset }))
    },
    async readAsset({ asset, maximumBytes }) {
      const stored = remote.get(asset.name)
      assert.ok(stored)
      assert.equal(stored.id, asset.id)
      assert.ok(stored.bytes.byteLength <= maximumBytes)
      return Buffer.from(stored.bytes)
    },
    async verifyAsset({ asset, expected }) {
      const stored = remote.get(asset.name)
      if (!stored || stored.id !== asset.id || stored.size !== expected.size
        || sha256(stored.bytes) !== expected.sha256) {
        throw new Error(`foreign remote asset conflict: ${asset.name}`)
      }
      return { size: stored.size, sha256: expected.sha256 }
    },
    async uploadAsset({ releaseId: requestedReleaseId, name, size, chunks }) {
      assert.equal(requestedReleaseId, releaseId)
      if (!draft) throw new Error('public release must reconcile without upload')
      const values = []
      for await (const chunk of chunks) values.push(Buffer.from(chunk))
      const bytes = Buffer.concat(values)
      assert.equal(bytes.byteLength, size)
      const asset = { id: nextId++, name, size, state: 'uploaded', bytes }
      remote.set(name, asset)
      uploads += 1
      return { assetId: asset.id, name, size }
    },
    async deleteAsset(asset) {
      if (!draft) throw new Error('public release assets must never be pruned')
      assert.equal(remote.get(asset.name)?.id, asset.id)
      remote.delete(asset.name)
    },
    async publishRelease({ metadata }) {
      assert.equal(draft, true)
      assert.deepEqual(metadata, { tag, title, body, targetCommitish, draft: true })
      draft = false
      publishes += 1
      return {
        release: { id: releaseId, tag, title, body, targetCommitish, draft: false },
        publicationProof: {
          schema: 'modly.world-ffmpeg-release-publication-proof.v1', releaseId, tag,
          requestSha256: '1'.repeat(64),
          metadataSha256: sha256(Buffer.from(`${JSON.stringify(metadata)}\n`)),
          settlement: 'patch-response',
        },
      }
    },
    async revertReleaseToDraft() {
      draft = true
      return { id: releaseId, tag, title, draft: true }
    },
  }
  const { ensureWorldFfmpegReleaseDraft } = await import('./world-ffmpeg-release-draft.mjs')
  const { uploadWorldFfmpegSourceGeneration } = await import('./world-ffmpeg-source-release-uploader.mjs')
  const { verifyOrUploadWorldFfmpegPackageResult } = await import('./world-ffmpeg-release-uploader.mjs')
  const { finalizeWorldFfmpegRelease } = await import('./world-ffmpeg-release-finalizer.mjs')
  const { publishWorldFfmpegSourceGeneration } = await import('./world-ffmpeg-source-publication.mjs')
  const archiveName = 'modly-world-ffmpeg-7.1.1-sources.tar.xz'
  const archiveBytes = Buffer.from('whole-workflow exact corresponding source')
  const makeSourceGeneration = async (name) => {
    const prepared = join(root, `${name}-prepared`)
    const destination = join(root, `${name}-destination`)
    await mkdir(prepared)
    await mkdir(destination)
    await writeFile(join(prepared, archiveName), archiveBytes)
    await writeFile(join(prepared, `${archiveName}.sha256`), `${sha256(archiveBytes)}  ${archiveName}\n`)
    return publishWorldFfmpegSourceGeneration({ preparedDirectory: prepared, destinationDirectory: destination })
  }
  const targets = ['win32-x64', 'darwin-arm64', 'linux-x64']
  const makePackages = async (round) => Promise.all(targets.map((target, index) => {
    const attemptMarker = (round * 3 + index + 1).toString(16).padStart(32, '0')
    const publicationMarker = (round * 3 + index + 33).toString(16).padStart(32, '0')
    return createPackageUploadFixture(root, {
      target,
      token: attemptMarker,
      publicationToken: publicationMarker,
    })
  }))
  let setupReceipt
  const runUploadJobs = async (round) => {
    const sourceGeneration = await makeSourceGeneration(`round-${round}`)
    const source = await uploadWorldFfmpegSourceGeneration({
      generationDirectory: sourceGeneration.generationDirectory,
      repository, tag, releaseClient: client, releaseSetupReceipt: setupReceipt,
    })
    const packages = []
    for (const fixture of await makePackages(round)) {
      packages.push(await verifyOrUploadWorldFfmpegPackageResult({
        resultReceipt: fixture.resultReceipt,
        repository, tag, releaseClient: client, releaseSetupReceipt: setupReceipt,
      }))
    }
    return { source, packages }
  }

  const created = await ensureWorldFfmpegReleaseDraft({
    repository, tag, title, body, targetCommitish, releaseClient: client,
  })
  setupReceipt = created
  assert.equal(created.metadata.draft, true)
  const first = await runUploadJobs(0)
  await assert.rejects(finalizeWorldFfmpegRelease({
    repository,
    tag,
    releaseSetupReceipt: setupReceipt,
    sourceUploadReceipt: first.source.uploadResultReceipt,
    packageUploadReceipts: first.packages.map(({ uploadResultReceipt }) => uploadResultReceipt),
    releaseClient: client,
  }), /exactly four target upload receipts/i)
  assert.equal(first.packages.length, 3)
  assert.ok(uploads > 0)
  assert.equal(publishes, 0)
  assert.equal(draft, true)
})

test('release finalizer requires all tuple receipts and reconciles the exact remote bytes before publish', async () => {
  const { worldFfmpegGithubContentAddressedAssetName } = await import('./world-ffmpeg-github-release.mjs')
  const repository = 'modly/example'
  const tag = 'v1.0.0'
  const releaseId = 77
  const remote = new Map()
  let nextId = 100
  const add = (name, bytes) => {
    const asset = { id: nextId++, name, size: bytes.byteLength, bytes }
    remote.set(name, asset)
    return asset
  }
  const addContent = (namespace, kind, bytes) => add(
    worldFfmpegGithubContentAddressedAssetName(namespace, sha256(bytes), kind), bytes,
  )
  const metadata = {
    tag, title: RELEASE_TITLE, body: RELEASE_BODY, targetCommitish: RELEASE_COMMIT, draft: true,
  }
  const generationLockBytes = Buffer.from(`${JSON.stringify({
    schema: 'modly.world-ffmpeg-release-generation-lock.v1',
    repository,
    releaseId,
    metadata,
  })}\n`)
  const generationLockAsset = add('WORLD_FFMPEG_RELEASE_GENERATION.v1.json', generationLockBytes)
  const releaseSetupReceipt = {
    schema: 'modly.world-ffmpeg-release-draft-receipt.v1',
    repository,
    tag,
    releaseId,
    metadata,
    generationLock: {
      name: generationLockAsset.name,
      size: generationLockAsset.size,
      sha256: sha256(generationLockAsset.bytes),
      githubAssetId: generationLockAsset.id,
    },
  }
  const setupReceiptSha256 = sha256(Buffer.from(JSON.stringify(releaseSetupReceipt)))
  const descriptor = (asset) => ({
    name: asset.name, size: asset.size, sha256: sha256(asset.bytes), githubAssetId: asset.id,
  })
  const packageResults = []
  for (const [target, marker] of [
    ['win32-x64', 'a'], ['darwin-arm64', 'b'], ['linux-x64', 'c'], ['linux-arm64', 'd'],
  ]) {
    const binary = addContent(`package-${target}`, 'artifact.bin', Buffer.from(`binary-${target}`))
    const report = addContent(`package-${target}`, 'build-report.v1.json', Buffer.from(`{"target":"${target}"}\n`))
    const result = addContent(`package-${target}`, 'result.v1.json', Buffer.from(`{"target":"${target}"}\n`))
    const uploadReceipt = {
      schema: 'modly.electron-builder-package-upload-receipt.v1',
      target, attemptId: marker.repeat(32), publicationToken: marker.repeat(32),
      repository, tag, releaseId, setupReceiptSha256,
      assets: [binary, report, result].map(descriptor),
    }
    const uploadBytes = Buffer.from(`${JSON.stringify(uploadReceipt)}\n`)
    const uploadAsset = addContent(`package-${target}`, 'upload-receipt.v1.json', uploadBytes)
    packageResults.push({
      schema: 'modly.electron-builder-package-upload-result-receipt.v1',
      target, attemptId: marker.repeat(32), publicationToken: marker.repeat(32),
      repository, tag, releaseId, setupReceiptSha256,
      outputIdentity: { dev: '1', ino: String(packageResults.length + 1) },
      uploadReceiptFile: descriptor(uploadAsset),
    })
  }
  const sourceFiles = [
    addContent('source', 'sources.tar.xz', Buffer.from('source archive')),
    addContent('source', 'sources.sha256', Buffer.from('source checksum')),
    addContent('source', 'generation.v1.json', Buffer.from('{"generation":true}\n')),
    addContent('source', 'ready.v1.json', Buffer.from('{"ready":true}\n')),
  ]
  const sourceUpload = {
    schema: 'modly.world-ffmpeg-source-upload-receipt.v1', repository, tag, releaseId,
    setupReceiptSha256,
    assets: sourceFiles.map(descriptor),
  }
  const sourceUploadAsset = addContent(
    'source', 'source-upload.v1.json', Buffer.from(`${JSON.stringify(sourceUpload)}\n`),
  )
  const sourceResult = {
    schema: 'modly.world-ffmpeg-source-upload-result-receipt.v1', repository, tag, releaseId,
    setupReceiptSha256,
    uploadReceiptFile: descriptor(sourceUploadAsset),
  }
  let published = 0
  let reverted = 0
  let draft = true
  let mutateAfterPublish = false
  let publishSettlement = 'patch-response'
  let listFailure
  const client = {
    async getDraftRelease() {
      if (!draft) throw new Error('release is already public')
      return { id: releaseId, tag, draft: true }
    },
    async getRelease() {
      return {
        id: releaseId, tag, title: metadata.title, body: metadata.body,
        targetCommitish: metadata.targetCommitish, draft,
      }
    },
    async listAssets() {
      if (listFailure) {
        const error = listFailure
        listFailure = undefined
        throw error
      }
      return [...remote.values()].map(({ bytes: _bytes, ...asset }) => asset)
    },
    async readAsset({ asset, maximumBytes }) {
      const stored = remote.get(asset.name)
      assert.ok(stored.bytes.byteLength <= maximumBytes)
      return Buffer.from(stored.bytes)
    },
    async verifyAsset({ asset, expected }) {
      const stored = remote.get(asset.name)
      const observed = { size: stored.bytes.byteLength, sha256: sha256(stored.bytes) }
      if (observed.size !== expected.size || observed.sha256 !== expected.sha256) {
        throw new Error(`remote digest conflict: ${asset.name}`)
      }
      return observed
    },
    async publishRelease({ metadata: requestedMetadata }) {
      assert.deepEqual(requestedMetadata, metadata)
      published += 1
      draft = false
      if (mutateAfterPublish) linuxBinary.bytes = Buffer.from('post-publish foreign bytes')
      return {
        release: {
          id: releaseId, tag, title: metadata.title, body: metadata.body,
          targetCommitish: metadata.targetCommitish, draft: false,
        },
        publicationProof: {
          schema: 'modly.world-ffmpeg-release-publication-proof.v1', releaseId, tag,
          requestSha256: '2'.repeat(64),
          metadataSha256: sha256(Buffer.from(`${JSON.stringify(metadata)}\n`)),
          settlement: publishSettlement,
        },
      }
    },
    async revertReleaseToDraft() { reverted += 1; draft = true; return { id: releaseId, tag, draft: true } },
  }
  const { finalizeWorldFfmpegRelease } = await import('./world-ffmpeg-release-finalizer.mjs')
  await assert.rejects(finalizeWorldFfmpegRelease({
    repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
    packageUploadReceipts: packageResults.slice(0, 3), releaseClient: client,
  }), /exactly four target upload receipts/i)
  await assert.rejects(finalizeWorldFfmpegRelease({
    repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
    packageUploadReceipts: [...packageResults.slice(0, 3), packageResults[2]], releaseClient: client,
  }), /target tuple is incomplete or duplicated/i)
  const linuxBinary = [...remote.values()].find(({ name }) => (
    name.startsWith('world-ffmpeg-package-linux-x64-') && name.endsWith('-artifact.bin')
  ))
  remote.delete(linuxBinary.name)
  await assert.rejects(finalizeWorldFfmpegRelease({
    repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
    packageUploadReceipts: packageResults, releaseClient: client,
  }), /missing|exact remote asset set/i)
  assert.equal(published, 0)
  remote.set(linuxBinary.name, linuxBinary)

  const complete = await finalizeWorldFfmpegRelease({
    repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
    packageUploadReceipts: packageResults, releaseClient: client,
  })
  assert.equal(complete.schema, 'modly.world-ffmpeg-release-publication-receipt.v1')
  assert.equal(complete.assets.length, remote.size)
  assert.equal(published, 1)
  assert.equal(complete.postPublishVerified, true)

  for (const crashPoint of [
    'after-draft-false',
    'during-post-release-read',
    'during-post-asset-hash',
    'after-postcheck-before-receipt-write',
  ]) {
    const recovered = await finalizeWorldFfmpegRelease({
      repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
      packageUploadReceipts: packageResults, releaseClient: client,
    })
    assert.equal(recovered.releaseId, releaseId, crashPoint)
    assert.equal(recovered.postPublishVerified, true, crashPoint)
    assert.equal(recovered.assetSetSha256, complete.assetSetSha256, crashPoint)
    assert.equal(published, 1, crashPoint)
  }

  const revertsBeforePublicFailure = reverted
  const publicBytes = Buffer.from(linuxBinary.bytes)
  linuxBinary.bytes = Buffer.from('pre-existing public release foreign bytes')
  await assert.rejects(finalizeWorldFfmpegRelease({
    repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
    packageUploadReceipts: packageResults, releaseClient: client,
  }), /foreign|missing|digest|exact remote asset set/i)
  assert.equal(draft, false)
  assert.equal(reverted, revertsBeforePublicFailure)
  linuxBinary.bytes = publicBytes

  remote.delete(linuxBinary.name)
  await assert.rejects(finalizeWorldFfmpegRelease({
    repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
    packageUploadReceipts: packageResults, releaseClient: client,
  }), /missing|exact remote asset set/i)
  assert.equal(draft, false)
  assert.equal(reverted, revertsBeforePublicFailure)
  remote.set(linuxBinary.name, linuxBinary)

  listFailure = new Error('fixture transient public validation failure')
  await assert.rejects(finalizeWorldFfmpegRelease({
    repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
    packageUploadReceipts: packageResults, releaseClient: client,
  }), /fixture transient public validation failure/)
  assert.equal(draft, false)
  assert.equal(reverted, revertsBeforePublicFailure)

  draft = true
  mutateAfterPublish = true
  const originalLinuxBytes = Buffer.from(linuxBinary.bytes)
  await assert.rejects(finalizeWorldFfmpegRelease({
    repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
    packageUploadReceipts: packageResults, releaseClient: client,
  }), /post-publication|remote digest conflict/i)
  assert.equal(reverted, 0)
  assert.equal(draft, false)
  linuxBinary.bytes = originalLinuxBytes
  mutateAfterPublish = false

  for (const scenario of ['actor-published-between-get-and-patch', 'lost-patch-response']) {
    draft = true
    publishSettlement = 'public-reconciliation'
    const converged = await finalizeWorldFfmpegRelease({
      repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
      packageUploadReceipts: packageResults, releaseClient: client,
    })
    assert.equal('transitionOwned' in converged.publicationProof, false, scenario)
    assert.equal(converged.publicationProof.settlement, 'public-reconciliation')
    assert.equal(draft, false)
    assert.equal(reverted, 0)
  }
  publishSettlement = 'patch-response'

  const publishedBeforeForeign = published
  const foreign = add('FOREIGN.bin', Buffer.from('foreign'))
  await assert.rejects(finalizeWorldFfmpegRelease({
    repository, tag, releaseSetupReceipt, sourceUploadReceipt: sourceResult,
    packageUploadReceipts: packageResults, releaseClient: client,
  }), /foreign|exact remote asset set/i)
  assert.equal(remote.get(foreign.name), foreign)
  assert.equal(published, publishedBeforeForeign)
})

test('release publication converges forward after another actor or a lost response without CAS ownership claims', async () => {
  const { createWorldFfmpegGithubReleaseClient } = await import('./world-ffmpeg-github-release.mjs')
  const metadata = {
    tag: RELEASE_TAG, title: RELEASE_TITLE, body: RELEASE_BODY,
    targetCommitish: RELEASE_COMMIT, draft: true,
  }
  const releaseBody = (draft) => Buffer.from(JSON.stringify({
    id: 77,
    tag_name: RELEASE_TAG,
    name: RELEASE_TITLE,
    body: RELEASE_BODY,
    target_commitish: RELEASE_COMMIT,
    draft,
    upload_url: 'https://uploads.github.com/repos/modly/example/releases/77/assets{?name,label}',
  }))
  const createFactory = (scenario) => {
    let patchCalls = 0
    let getCalls = 0
    let draft = scenario !== 'actor-published'
    const patchHeaders = []
    return {
      counts: () => ({ patchCalls, getCalls, patchHeaders }),
      factory(options, onResponse) {
        const request = new EventEmitter()
        request.write = () => true
        request.destroy = () => undefined
        request.end = () => queueMicrotask(() => {
          if (options.method === 'PATCH') {
            patchCalls += 1
            draft = false
            patchHeaders.push(options.headers)
            if (scenario === 'lost-applied') {
              request.emit('error', Object.assign(new Error('ambiguous publish socket close'), { code: 'ECONNRESET' }))
              return
            }
            const response = new EventEmitter()
            response.statusCode = scenario === 'actor-published' ? 409 : 200
            response.headers = { etag: '"public-owned"' }
            response.destroy = () => undefined
            onResponse(response)
            response.emit('data', scenario === 'actor-published' ? Buffer.from('{}') : releaseBody(false))
            response.emit('end')
            response.emit('close')
            return
          }
          getCalls += 1
          const response = new EventEmitter()
          response.statusCode = 200
          response.headers = { etag: '"public-other-actor"' }
          response.destroy = () => undefined
          onResponse(response)
          response.emit('data', releaseBody(draft))
          response.emit('end')
          response.emit('close')
        })
        return request
      },
    }
  }

  const actor = createFactory('actor-published')
  const actorClient = createWorldFfmpegGithubReleaseClient({
    repository: 'modly/example', tag: 'v1.0.0', token: 'fixture',
    requestFactory: actor.factory, sleep: async () => undefined, maxAttempts: 3,
  })
  const actorResult = await actorClient.publishRelease({ releaseId: 77, metadata })
  assert.equal(actorResult.release.draft, false)
  assert.equal(actorResult.publicationProof.settlement, 'public-reconciliation')
  assert.equal('transitionOwned' in actorResult.publicationProof, false)
  assert.deepEqual(actor.counts().patchHeaders, [])
  assert.equal(actor.counts().patchCalls, 0)
  assert.equal(actorClient.revertReleaseToDraft, undefined)

  const lost = createFactory('lost-applied')
  const lostClient = createWorldFfmpegGithubReleaseClient({
    repository: 'modly/example', tag: 'v1.0.0', token: 'fixture',
    requestFactory: lost.factory, sleep: async () => undefined, maxAttempts: 3,
  })
  const lostResult = await lostClient.publishRelease({ releaseId: 77, metadata })
  assert.equal(lostResult.release.draft, false)
  assert.equal(lostResult.publicationProof.settlement, 'public-reconciliation')
  assert.equal('transitionOwned' in lostResult.publicationProof, false)
  assert.equal(lost.counts().patchCalls, 1)

  const owned = createFactory('owned')
  const ownedClient = createWorldFfmpegGithubReleaseClient({
    repository: 'modly/example', tag: 'v1.0.0', token: 'fixture',
    requestFactory: owned.factory, sleep: async () => undefined, maxAttempts: 3,
  })
  const ownedResult = await ownedClient.publishRelease({ releaseId: 77, metadata })
  assert.equal(ownedResult.publicationProof.settlement, 'patch-response')
  assert.equal('transitionOwned' in ownedResult.publicationProof, false)
  assert.equal(owned.counts().patchCalls, 1)
})

test('GitHub transport fails closed on incomplete responses and bounds safe Retry-After retries', async () => {
  const {
    createWorldFfmpegGithubReleaseClient,
    _testOnlyGithubRequestOnce,
    _testOnlyRetrySafeGithubOperation,
  } = await import('./world-ffmpeg-github-release.mjs')
  const factory = (event) => (_options, onResponse) => {
    const request = new EventEmitter()
    request.write = () => true
    request.end = () => queueMicrotask(() => {
      if (event === 'request-timeout') { request.emit('timeout'); return }
      if (event === 'operation-deadline') return
      if (event === 'request-close') { request.emit('close'); return }
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = {}
      response.destroy = () => undefined
      onResponse(response)
      if (event === 'aborted') response.emit('aborted')
      else if (event === 'error') response.emit('error', new Error('response socket error'))
      else if (event === 'premature-close') response.emit('close')
      else if (event === 'request-close-after-response') request.emit('close')
    })
    request.destroy = (error) => queueMicrotask(() => request.emit('error', error ?? new Error('destroyed')))
    return request
  }
  for (const [event, pattern] of [
    ['aborted', /aborted/i],
    ['error', /response socket error/i],
    ['premature-close', /closed before completion/i],
    ['request-timeout', /timed out/i],
    ['operation-deadline', /deadline expired/i],
    ['request-close', /request.*closed/i],
    ['request-close-after-response', /request.*closed/i],
  ]) {
    await assert.rejects(_testOnlyGithubRequestOnce({
      requestFactory: factory(event), hostname: 'api.github.com', path: '/fixture',
      method: 'GET', token: 'fixture', operationDeadlineMs: 100,
    }), pattern)
  }

  const responses = [
    { statusCode: 503, headers: { 'retry-after': '99' }, bytes: Buffer.alloc(0) },
    { statusCode: 200, headers: {}, bytes: Buffer.from('{}') },
  ]
  const sleeps = []
  const retried = await _testOnlyRetrySafeGithubOperation(
    async () => responses.shift(),
    { maxAttempts: 2, retryAfterCapMs: 2_000, sleep: async (ms) => sleeps.push(ms) },
  )
  assert.equal(retried.statusCode, 200)
  assert.deepEqual(sleeps, [2_000])

  let unsafeAttempts = 0
  await assert.rejects(_testOnlyRetrySafeGithubOperation(async () => {
    unsafeAttempts += 1
    throw Object.assign(new Error('ambiguous upload'), { retryable: true })
  }, { safe: false, maxAttempts: 3, sleep: async () => undefined }), /ambiguous upload/)
  assert.equal(unsafeAttempts, 1)

  let downloadAttempts = 0
  const retryingDownloadFactory = (_options, onResponse) => {
    const request = new EventEmitter()
    request.write = () => true
    request.destroy = () => undefined
    request.end = () => queueMicrotask(() => {
      downloadAttempts += 1
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = {}
      response.destroy = () => undefined
      onResponse(response)
      if (downloadAttempts === 1) {
        response.emit('data', Buffer.from('ab'))
        response.emit('aborted')
      } else {
        response.emit('data', Buffer.from('abc'))
        response.emit('end')
        response.emit('close')
      }
    })
    return request
  }
  const retryingClient = createWorldFfmpegGithubReleaseClient({
    repository: 'modly/example', tag: 'v1.0.0', token: 'fixture',
    requestFactory: retryingDownloadFactory,
    sleep: async () => undefined,
    maxAttempts: 2,
  })
  assert.deepEqual(await retryingClient.verifyAsset({
    asset: { id: 4, name: 'artifact.bin', size: 3 },
    expected: { name: 'artifact.bin', size: 3, sha256: sha256(Buffer.from('abc')) },
  }), { size: 3, sha256: sha256(Buffer.from('abc')) })
  assert.equal(downloadAttempts, 2)

  const errorListenerCounts = []
  const backpressureFactory = (_options, onResponse) => {
    const request = new EventEmitter()
    request.write = () => {
      errorListenerCounts.push(request.listenerCount('error'))
      queueMicrotask(() => request.emit('drain'))
      return false
    }
    request.destroy = () => undefined
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter()
      response.statusCode = 201
      response.headers = {}
      response.destroy = () => undefined
      onResponse(response)
      response.emit('end')
      response.emit('close')
    })
    return request
  }
  await _testOnlyGithubRequestOnce({
    requestFactory: backpressureFactory,
    hostname: 'uploads.github.com',
    path: '/fixture',
    method: 'POST',
    token: 'fixture',
    operationDeadlineMs: 100,
    chunks: (async function * () {
      yield Buffer.from('a')
      yield Buffer.from('b')
    })(),
  })
  assert.deepEqual(errorListenerCounts, [1, 1])

  let iteratorReturned = false
  let closedRequest
  const closingBackpressureFactory = () => {
    const request = new EventEmitter()
    closedRequest = request
    request.write = () => {
      queueMicrotask(() => request.emit('close'))
      return false
    }
    request.destroy = () => undefined
    request.end = () => undefined
    return request
  }
  await assert.rejects(_testOnlyGithubRequestOnce({
    requestFactory: closingBackpressureFactory,
    hostname: 'uploads.github.com', path: '/fixture', method: 'POST', token: 'fixture',
    operationDeadlineMs: 100,
    chunks: (async function * () {
      try { yield Buffer.from('a'); yield Buffer.from('b') } finally { iteratorReturned = true }
    })(),
  }), /closed|aborted/i)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(iteratorReturned, true)
  for (const event of ['drain', 'error', 'close', 'abort']) {
    assert.equal(closedRequest.listenerCount(event), event === 'error' ? 1 : 0)
  }

  let redirectRequests = 0
  const redirectFactory = (_options, onResponse) => {
    const request = new EventEmitter()
    request.write = () => true
    request.destroy = () => undefined
    request.end = () => queueMicrotask(() => {
      redirectRequests += 1
      const response = new EventEmitter()
      response.statusCode = redirectRequests === 1 ? 302 : 200
      response.headers = redirectRequests === 1
        ? { location: 'https://objects.githubusercontent.com/asset?token=fixture' }
        : {}
      response.destroy = () => undefined
      onResponse(response)
      response.emit('data', redirectRequests === 1 ? Buffer.from('redirect metadata') : Buffer.from('abc'))
      response.emit('end')
      response.emit('close')
    })
    return request
  }
  const redirectingClient = createWorldFfmpegGithubReleaseClient({
    repository: 'modly/example', tag: 'v1.0.0', token: 'fixture',
    requestFactory: redirectFactory,
  })
  assert.deepEqual(await redirectingClient.verifyAsset({
    asset: { id: 5, name: 'redirect.bin', size: 3 },
    expected: { name: 'redirect.bin', size: 3, sha256: sha256(Buffer.from('abc')) },
  }), { size: 3, sha256: sha256(Buffer.from('abc')) })
  assert.equal(redirectRequests, 2)
})

test('GitHub Enterprise client binds API and release upload authorities and rejects cross-origin uploads', async () => {
  const { createWorldFfmpegGithubReleaseClient } = await import('./world-ffmpeg-github-release.mjs')
  const requests = []
  let foreignUpload = false
  const requestFactory = (options, onResponse) => {
    requests.push(options)
    const request = new EventEmitter()
    request.write = () => true
    request.destroy = () => undefined
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter()
      response.headers = {}
      response.destroy = () => undefined
      if (options.method === 'GET') {
        response.statusCode = 200
        const body = Buffer.from(JSON.stringify({
          id: 71, tag_name: 'v1.0.0', name: 'Modly Beta v1.0.0', draft: true,
          body: RELEASE_BODY,
          target_commitish: RELEASE_COMMIT,
          upload_url: foreignUpload
            ? 'https://attacker.example/assets{?name,label}'
            : 'https://ghe.example/api/uploads/repos/modly/example/releases/71/assets{?name,label}',
        }))
        onResponse(response)
        response.emit('data', body)
      } else {
        response.statusCode = 201
        const body = Buffer.from(JSON.stringify({ id: 72, name: 'asset.bin', size: 3, state: 'uploaded' }))
        onResponse(response)
        response.emit('data', body)
      }
      response.emit('end')
      response.emit('close')
    })
    return request
  }
  const client = createWorldFfmpegGithubReleaseClient({
    repository: 'modly/example', tag: 'v1.0.0', token: 'enterprise-token',
    apiUrl: 'https://ghe.example/api/v3', requestFactory,
  })
  assert.equal((await client.getDraftRelease()).id, 71)
  const stream = { chunks: (async function * () { yield Buffer.from('abc') })() }
  assert.equal((await client.uploadAsset({
    releaseId: 71, name: 'asset.bin', size: 3, chunks: stream.chunks,
  })).assetId, 72)
  assert.equal(requests[0].hostname, 'ghe.example')
  assert.equal(requests[0].path, '/api/v3/repos/modly/example/releases/tags/v1.0.0')
  assert.equal(requests[1].hostname, 'ghe.example')
  assert.equal(requests[1].path, '/api/v3/repos/modly/example/releases/tags/v1.0.0')
  assert.equal(requests[2].path, '/api/uploads/repos/modly/example/releases/71/assets?name=asset.bin')
  assert.equal(requests[0].headers.authorization, 'Bearer enterprise-token')
  assert.equal(requests[1].headers.authorization, 'Bearer enterprise-token')
  assert.equal(requests[2].headers.authorization, 'Bearer enterprise-token')

  foreignUpload = true
  const rejected = createWorldFfmpegGithubReleaseClient({
    repository: 'modly/example', tag: 'v1.0.0', token: 'enterprise-token',
    apiUrl: 'https://ghe.example/api/v3', requestFactory,
  })
  await assert.rejects(rejected.getDraftRelease(), /upload.*authority|cross-origin/i)
})

test('release evidence names are target-qualified and collision-free for all target upload lists', async () => {
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const uploader = await readFile(new URL('./world-ffmpeg-release-uploader.mjs', import.meta.url), 'utf8')
  const {
    worldFfmpegBuildReportEvidenceName,
    worldFfmpegPackageResultEvidenceName,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const names = []
  for (const target of ['win32-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) {
    names.push(
      worldFfmpegBuildReportEvidenceName(target),
      worldFfmpegPackageResultEvidenceName(target),
      `UPLOAD.${target}.v1.json`,
    )
  }
  assert.equal(new Set(names).size, 12)
  assert.match(uploader, /`UPLOAD\.\$\{manifest\.target\}\.v1\.json`/)
  assert.equal(release.match(/world-ffmpeg-release-uploader\.mjs/g)?.length, 4)
  assert.equal(release.match(/WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT:/g)?.length, 4)
  assert.equal(
    release.match(/WORLD_FFMPEG_RELEASE_DRAFT_RECEIPT:\s*\$\{\{ needs\.create-release\.outputs\.WORLD_FFMPEG_RELEASE_DRAFT_RECEIPT \}\}/g)?.length,
    6,
  )
  assert.match(release, /world-ffmpeg-release-draft\.mjs[\s\S]*--target-commitish "\$\{\{ github\.sha \}\}"/)
  assert.match(release, /WORLD_FFMPEG_RELEASE_GENERATION\.v1\.json|world-ffmpeg-release-draft\.mjs/)
  assert.match(release, /concurrency:\s*\n\s*group:\s*world-ffmpeg-release-\$\{\{ github\.repository \}\}-\$\{\{ github\.ref_name \}\}\s*\n\s*cancel-in-progress:\s*false/)
  assert.ok((release.match(/GITHUB_API_URL:\s*\$\{\{ github\.api_url \}\}/g) ?? []).length >= 6)
  assert.doesNotMatch(release, /artifacts=\(\)|world-ffmpeg-package-artifacts\.paths0/)
  assert.doesNotMatch(release, /--clobber/)
  assert.doesNotMatch(
    `${await readFile(new URL('./world-ffmpeg-github-release.mjs', import.meta.url), 'utf8')}\n${await readFile(new URL('./world-ffmpeg-release-finalizer.mjs', import.meta.url), 'utf8')}`,
    /If-Match|transitionOwned|expectedEtag/,
  )
})

test('runtime resolution verifies only the exact supplied custody snapshot and never rereads its pathname', async () => {
  const {
    resolvePackagedWorldFfmpegRuntime,
    WORLD_FFMPEG_RUNTIME_SCHEMA,
  } = await import('../electron/main/world-render-ffmpeg-runtime.ts')
  const contract = await loadWorldFfmpegSupplyChain()
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const files = {
    'LICENSE.txt': Buffer.from('GNU LESSER GENERAL PUBLIC LICENSE\n'),
    'bin/ffmpeg': Buffer.from('snapshot executable\n'),
    'bin/libavcodec.so.61': Buffer.from('snapshot library\n'),
  }
  const descriptor = (path, mode) => ({
    path,
    size: files[path].byteLength,
    sha256: sha256(files[path]),
    mode,
  })
  const manifest = {
    schema: WORLD_FFMPEG_RUNTIME_SCHEMA,
    target: 'linux-x64',
    ffmpegVersion: '7.1.1',
    signingKeyId: 'snapshot-test-key',
    build: contract.build,
    directories: [{ path: '.', mode: 0o755 }, { path: 'bin', mode: 0o755 }],
    license: descriptor('LICENSE.txt', 0o644),
    executable: descriptor('bin/ffmpeg', 0o755),
    sharedLibraries: [descriptor('bin/libavcodec.so.61', 0o644)],
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  const signatureBytes = sign(null, manifestBytes, privateKey)
  const snapshot = {
    manifestBytes,
    signatureBytes,
    ffmpegRootMode: 0o755,
    rootMode: 0o755,
    binMode: 0o755,
    manifestMode: 0o644,
    signatureMode: 0o644,
    rootEntries: ['LICENSE.txt', 'bin', 'manifest.json', 'manifest.sig'],
    binEntries: ['ffmpeg', 'libavcodec.so.61'],
    files: Object.entries(files).map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      mode: path === 'bin/ffmpeg' ? 0o755 : 0o644,
    })),
  }
  const missingResources = '/definitely/not/a/world-ffmpeg-package-path'
  const resolved = await resolvePackagedWorldFfmpegRuntime({
    resourcesPath: missingResources,
    platform: 'linux',
    arch: 'x64',
    trustedManifestKeys: {
      'snapshot-test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
    snapshot,
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.runtime.manifestSha256, sha256(manifestBytes))

  const substituted = structuredClone(snapshot)
  substituted.manifestBytes = Buffer.from(manifestBytes)
  substituted.manifestBytes[0] ^= 1
  assert.deepEqual(await resolvePackagedWorldFfmpegRuntime({
    resourcesPath: missingResources,
    platform: 'linux',
    arch: 'x64',
    trustedManifestKeys: {
      'snapshot-test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
    snapshot: substituted,
  }), { ok: false, code: 'bundle-invalid' })

  const wrongManifestMode = { ...snapshot, manifestMode: 0o600 }
  assert.deepEqual(await resolvePackagedWorldFfmpegRuntime({
    resourcesPath: missingResources,
    platform: 'linux',
    arch: 'x64',
    trustedManifestKeys: {
      'snapshot-test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
    snapshot: wrongManifestMode,
  }), { ok: false, code: 'bundle-invalid' })
})

test('package verifier binds runtime, manifest, signature, and report to one final custody snapshot', async () => {
  const {
    resolvePackagedWorldFfmpegRuntime,
    WORLD_FFMPEG_RUNTIME_SCHEMA,
  } = await import('../electron/main/world-render-ffmpeg-runtime.ts')
  const { verifyWorldFfmpegPackage } = await import('./verify-world-ffmpeg-package.ts')
  const contract = await loadWorldFfmpegSupplyChain()
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const target = 'linux-x64'
  const runtimeFiles = new Map([
    ['LICENSE.txt', { bytes: Buffer.from('GNU LESSER GENERAL PUBLIC LICENSE\n'), mode: 0o644 }],
    ['bin/ffmpeg', { bytes: Buffer.from('snapshot executable\n'), mode: 0o755 }],
    ['bin/libavcodec.so.61', { bytes: Buffer.from('snapshot library\n'), mode: 0o644 }],
  ])
  const manifestDescriptor = (path) => {
    const value = runtimeFiles.get(path)
    return { path, size: value.bytes.byteLength, sha256: sha256(value.bytes), mode: value.mode }
  }
  const manifest = {
    schema: WORLD_FFMPEG_RUNTIME_SCHEMA,
    target,
    ffmpegVersion: '7.1.1',
    signingKeyId: 'verifier-snapshot-key',
    build: contract.build,
    directories: [{ path: '.', mode: 0o755 }, { path: 'bin', mode: 0o755 }],
    license: manifestDescriptor('LICENSE.txt'),
    executable: manifestDescriptor('bin/ffmpeg'),
    sharedLibraries: [manifestDescriptor('bin/libavcodec.so.61')],
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  const signatureBytes = sign(null, manifestBytes, privateKey)
  const reportBytes = Buffer.from('{}\n')
  const identities = { root: { dev: '11', ino: '12' }, nextIno: 100 }
  const receipt = (name, bytes) => ({
    name, dev: '11', ino: String(identities.nextIno++), size: bytes.byteLength, sha256: sha256(bytes),
  })
  const calls = []
  const bytesByPath = new Map([
    [`ffmpeg/${target}/manifest.json`, manifestBytes],
    [`ffmpeg/${target}/manifest.sig`, signatureBytes],
    [`world-ffmpeg-build-reports/${target}.json`, reportBytes],
  ])
  const externalReportReceipt = {
    name: 'WORLD_FFMPEG_BUILD_REPORT.linux-x64.v1.json',
    dev: '21', ino: '22', size: reportBytes.byteLength, sha256: sha256(reportBytes),
  }
  const outputCustody = async (request) => {
    calls.push(request)
    if (request.operation === 'read') {
      if (request.name === externalReportReceipt.name) {
        return { rootIdentity: { dev: '21', ino: '23' }, directoryIdentity: { dev: '21', ino: '23' }, file: externalReportReceipt, bytesBase64: reportBytes.toString('base64') }
      }
      return { rootIdentity: identities.root, directoryIdentity: { dev: '11', ino: '13' }, file: receipt(request.name, manifestBytes), bytesBase64: manifestBytes.toString('base64') }
    }
    assert.equal(request.operation, 'snapshot')
    const files = request.files.map(({ segments, name }) => {
      const bytes = bytesByPath.get([...segments, name].join('/'))
      assert.ok(bytes)
      return { segments, file: receipt(name, bytes), mode: 0o644, bytesBase64: bytes.toString('base64') }
    })
    const hashFiles = request.hashFiles.map(({ segments, name }) => {
      const path = [...segments.slice(2), name].join('/')
      const value = runtimeFiles.get(path)
      assert.ok(value)
      return { segments, file: receipt(name, value.bytes), mode: value.mode }
    })
    const directoryEntries = new Map([
      ['ffmpeg', [{ name: target, kind: 'directory' }]],
      ['world-ffmpeg-build-reports', [{ name: `${target}.json`, kind: 'file' }]],
      ['licenses/world-ffmpeg-7.1.1', []],
      [`ffmpeg/${target}`, [
        { name: 'LICENSE.txt', kind: 'file' }, { name: 'bin', kind: 'directory' },
        { name: 'manifest.json', kind: 'file' }, { name: 'manifest.sig', kind: 'file' },
      ]],
      [`ffmpeg/${target}/bin`, [{ name: 'ffmpeg', kind: 'file' }, { name: 'libavcodec.so.61', kind: 'file' }]],
    ])
    return {
      rootIdentity: identities.root,
      directoryIdentity: identities.root,
      files,
      hashFiles,
      directories: request.directories.map(({ segments }) => ({
        segments,
        mode: 0o755,
        entries: directoryEntries.get(segments.join('/')).map((entry) => ({
          ...entry, dev: '11', ino: String(identities.nextIno++), size: 1, mode: entry.kind === 'directory' ? 0o755 : 0o644,
        })),
      })),
    }
  }
  const verification = await verifyWorldFfmpegPackage({
    platform: 'linux', arch: 'x64', trustFile: '/trusted/build-trust.json',
    resourcesPath: '/pathname/must/not/be/read', resourcesIdentity: identities.root,
    buildReportDirectory: '/attempt/output',
    buildReportDirectoryIdentity: { dev: '21', ino: '23' },
    buildReportName: externalReportReceipt.name,
    buildReportReceipt: externalReportReceipt,
  }, {
    outputCustody,
    loadBuildTrust: async () => ({
      keys: { 'verifier-snapshot-key': publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      bytes: Buffer.from('trusted build key'),
    }),
    loadSupplyChain: async () => ({ distributionFiles: [] }),
    resolveRuntime: resolvePackagedWorldFfmpegRuntime,
    validateBuildReport: () => true,
    supplyChainBytes: Buffer.from('{}\n'),
  })
  assert.equal(verification.runtimeManifestSha256, sha256(manifestBytes))
  assert.deepEqual(calls.map(({ operation }) => operation), ['read', 'snapshot', 'read'])
  assert.equal(calls[1].hashFiles.length, 3)
})

test('deployable inspector binds the exact artifact snapshot and rejects post-inspection substitution', async (t) => {
  const { inspectWorldFfmpegPackageArtifacts } = await import('./world-ffmpeg-artifact-inspector.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-artifact-inspector-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'output')
  const cache = join(root, 'cache')
  await mkdir(output)
  await mkdir(cache)
  const artifactName = 'Modly.AppImage'
  const reportName = 'WORLD_FFMPEG_BUILD_REPORT.linux-x64.v1.json'
  const artifactBytes = Buffer.from('deployable A')
  const reportBytes = Buffer.from('{}\n')
  await writeFile(join(output, artifactName), artifactBytes)
  await writeFile(join(output, reportName), reportBytes)
  const outputIdentity = directoryIdentity(await lstat(output, { bigint: true }))
  const cacheIdentity = directoryIdentity(await lstat(cache, { bigint: true }))
  const reportReceipt = fileReceipt(
    reportName,
    await lstat(join(output, reportName), { bigint: true }),
    reportBytes,
  )
  let childSpawned = false
  let mutateArtifact = false
  const spawnProcess = (_file, _args, options) => {
    childSpawned = true
    assert.equal(options.cwd, output)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    child.stdin = {
      end(requestBytes) {
        queueMicrotask(async () => {
          const request = JSON.parse(requestBytes.toString('utf8'))
          if (mutateArtifact) await writeFile(join(output, artifactName), 'deployable B after inspection')
          const artifact = {
            path: artifactName,
            dev: request.artifactReceipt.dev,
            ino: request.artifactReceipt.ino,
            size: request.artifactReceipt.size,
            sha256: request.artifactReceipt.sha256,
          }
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({
            schema: 'modly.world-ffmpeg-artifact-inspection.v1',
            target: 'linux-x64',
            artifact,
            runtimeManifestSha256: request.expectedRuntimeManifestSha256,
            buildReportSha256: request.buildReportReceipt.sha256,
            extractor: extractorProof(request.extractor),
          })}\n`))
          child.emit('close', 0, null)
        })
      },
    }
    return child
  }
  const inspectionInput = {
    target: 'linux-x64', platform: 'linux', arch: 'x64',
    artifacts: [artifactName], outputDirectory: output, outputIdentity,
    cacheDirectory: cache, cacheIdentity,
    buildTrustFile: join(root, 'trust.json'),
    buildReportDirectory: output, buildReportDirectoryIdentity: outputIdentity,
    buildReportName: reportName, buildReportReceipt: reportReceipt,
    expectedRuntimeManifestSha256: 'a'.repeat(64),
    extractor: (await loadWorldFfmpegPackageToolLock()).extractors['linux-x64'],
    outputCustody: _testOnlyRunWorldFfmpegOutputCustodyInProcess,
    environment: {},
  }
  const accepted = await inspectWorldFfmpegPackageArtifacts(inspectionInput, { spawnProcess })
  assert.equal(accepted.artifact.sha256, sha256(artifactBytes))
  mutateArtifact = true
  await assert.rejects(
    inspectWorldFfmpegPackageArtifacts(inspectionInput, { spawnProcess }),
    /artifact changed after inspection/i,
  )
  assert.equal(childSpawned, true)

  childSpawned = false
  await assert.rejects(inspectWorldFfmpegPackageArtifacts({
    target: 'linux-x64', platform: 'linux', arch: 'x64',
    artifacts: ['Modly.exe'], outputDirectory: output, outputIdentity,
    cacheDirectory: cache, cacheIdentity,
    buildTrustFile: join(root, 'trust.json'),
    buildReportDirectory: output, buildReportDirectoryIdentity: outputIdentity,
    buildReportName: reportName, buildReportReceipt: reportReceipt,
    expectedRuntimeManifestSha256: 'a'.repeat(64),
  }, { spawnProcess }), /exactly one inspectable deployable artifact/i)
  assert.equal(childSpawned, false)
})

test('runner heartbeat cleanup remains available beyond sixty-four retained tombstones', async (t) => {
  const runner = (await import('./world-ffmpeg-electron-builder-runner.cjs')).default
  const root = await mkdtemp(join(tmpdir(), 'modly-runner-heartbeat-cycles-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (let index = 0; index < 70; index += 1) {
    const token = index.toString(16).padStart(32, '0')
    const heartbeatPath = join(root, `runner-${token}.heartbeat`)
    const heartbeat = runner._testOnlyStartRunnerHeartbeat({
      attemptId: token,
      target: 'linux-x64',
      heartbeatPath,
    }, 'e'.repeat(32), 'linux-proc-start:1', { intervalMs: 60_000 })
    heartbeat.stop()
  }
  const garbage = (await readdir(root)).filter((name) => (
    /^\.WORLD_FFMPEG_GC\.quarantine-[a-f0-9]{32}$/.test(name)
  ))
  assert.equal(garbage.length, 70)
  for (const name of garbage) assert.equal((await lstat(join(root, name, 'owned'))).size, 0)
})

function retirementReadGate() {
  let settled = false
  let resolveGate, rejectGate
  const promise = new Promise((resolve, reject) => { resolveGate = resolve; rejectGate = reject })
  promise.catch(() => undefined)
  return { promise, resolve() { if (!settled) { settled = true; resolveGate() } },
    reject(error) { if (!settled) { settled = true; rejectGate(error) } } }
}

const retirementWitnessStat = (info) => Object.fromEntries(
  ['dev', 'ino', 'birthtimeNs', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [key, String(info[key])]),
)

async function witnessRetirementRead(t, scenario, targetRole = 'claim') {
  const { quarantineAndReclaimWorldFfmpegFile, recoverWorldFfmpegOwnedGarbage,
    _testOnlyRecoverWorldFfmpegOwnedGarbageWithReadWitness } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-retirement-read-witness-'))
  const gates = Object.fromEntries(['writerReady', 'readerReady', 'permitTruncate', 'releaseRead', 'readObserved']
    .map((name) => [name, retirementReadGate()]))
  const events = [], sequence = [], producers = []
  const fail = (error) => { for (const gate of Object.values(gates)) gate.reject(error) }
  let writer, target, writerZero, readerBefore, readerAfter
  const watchdog = setTimeout(() => fail(new Error('Retirement read witness producer deadline.')), 30_000)
  const observe = (promise) => {
    producers.push(promise)
    promise.then((report) => { if (report.failures.length) fail(new Error(JSON.stringify(report))) }, fail)
    return promise
  }
  try {
    for (let index = 0; index < 65; index += 1) {
      const path = join(root, 'authority')
      await writeFile(path, '')
      const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      let result, claimPath
      try {
        result = await quarantineAndReclaimWorldFfmpegFile({ path, retainedHandle: handle,
          label: 'retirement-read-witness', nowMs: 1000 + index, maximumBytes: 1,
          durability: { platform: 'win32' }, afterClaimDurable(authority) { claimPath = authority.claimPath } })
      } finally { await handle.close() }
      if (index === 0) {
        const claim = JSON.parse(await readFile(claimPath, 'utf8'))
        target = { claimName: claimPath.slice(root.length + 1), token: claim.token }
      }
      await rm(dirname(result.quarantinePath), { recursive: true })
    }
    const role = scenario === 'prune-tombstone' ? 'tombstone' : targetRole
    const destination = join(root, `.WORLD_FFMPEG_GC.retirement-private-${target.token}`, `${role}.v1.json`)
    const input = { parentDirectory: root, minimumAgeMs: 0, maximumEntries: 1, maximumBytes: 1,
      durability: { platform: 'win32' } }
    const startWriter = () => observe(recoverWorldFfmpegOwnedGarbage({ ...input,
      async beforeLedgerReclaim(candidate) {
        if (scenario !== 'executor-reclaim-claim' || candidate.path !== destination || candidate.role !== role) return
        sequence.push('writer-ready'); gates.writerReady.resolve()
      },
      async afterLedgerFinalDelete(candidate) {
        if (candidate.path !== destination || candidate.role !== role) return
        writerZero = { path: candidate.path, role: candidate.role, stat: null }
        await assert.rejects(lstat(candidate.path, { bigint: true }), /ENOENT/)
        sequence.push('writer-unlinked'); gates.releaseRead.resolve()
        await gates.readObserved.promise
      },
    }))
    const startReader = () => observe(_testOnlyRecoverWorldFfmpegOwnedGarbageWithReadWitness(input, {
      scenario, ...target, role,
      async beforeRead(event) {
        events.push(event); readerBefore = event
        assert.equal(event.stage, 'before'); assert.ok(Number(event.held.size) > 0)
        assert.equal(event.held.nlink, '1'); assert.equal(event.offset, 0); assert.ok(event.requested > 0)
        assert.deepEqual(event.pathStat, event.held)
        sequence.push('reader-ready'); gates.readerReady.resolve()
        await gates.releaseRead.promise
      },
      async afterRead(event) {
        events.push(event); readerAfter = event
        assert.equal(event.stage, 'after')
        for (const key of ['dev', 'ino', 'birthtimeNs', 'mode']) assert.equal(event.held[key], readerBefore.held[key])
        assert.equal(event.fd, readerBefore.fd); assert.equal(event.position, 0)
        assert.equal(event.requested, readerBefore.requested)
        if (scenario === 'prune-tombstone') {
          assert.equal(event.bytesRead, 0); assert.equal(event.held.size, '0'); assert.equal(event.pathStat, null)
          sequence.push('read-zero')
        } else {
          assert.equal(event.bytesRead, readerBefore.requested)
          assert.equal(event.held.size, readerBefore.held.size)
          assert.equal(event.held.nlink, '0')
          assert.equal(event.pathStat, null)
          sequence.push('read-complete-after-unlink')
        }
        gates.readObserved.resolve()
        await writer
        sequence.push('writer-settled')
      },
    }))
    let reader
    if (scenario === 'prune-tombstone') {
      reader = startReader(); await gates.readerReady.promise
      writer = startWriter()
    } else {
      reader = startReader(); await gates.readerReady.promise
      writer = startWriter(); await gates.writerReady.promise
    }
    const [writerReport, readerReport] = await Promise.all([writer, reader])
    const diagnostic = { scenario, ...target, events, writerZero, sequence, writerReport, readerReport,
      convergenceAssertion: 'readerReport.failures.length === 0' }
    assert.ok(events.length <= 8); assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) <= 32 * 1024)
    t.diagnostic(JSON.stringify(diagnostic))
    assert.equal(writerReport.failures.length, 0, JSON.stringify(writerReport))
    assert.equal(readerReport.failures.length, 0, JSON.stringify(readerReport))
    assert.ok(Number(readerBefore.held.size) > 0)
    if (scenario === 'prune-tombstone') {
      assert.equal(readerAfter.bytesRead, 0)
      assert.equal(readerAfter.held.size, '0')
      assert.deepEqual(sequence.slice(0), ['reader-ready', 'writer-unlinked', 'read-zero', 'writer-settled'])
    } else {
      assert.equal(readerAfter.bytesRead, readerBefore.requested)
      assert.equal(readerAfter.held.size, readerBefore.held.size)
      assert.deepEqual(sequence, ['reader-ready', 'writer-ready', 'writer-unlinked', 'read-complete-after-unlink', 'writer-settled'])
    }
    assert.equal(readerReport.failures.length, 0, JSON.stringify(diagnostic))
  } finally {
    fail(new Error('Retirement read witness teardown.'))
    await Promise.allSettled(producers)
    clearTimeout(watchdog)
    await rm(root, { recursive: true, force: true })
  }
}

async function createCompletedLedgerBurst(root, largeEntries = 160) {
  const { quarantineAndReclaimWorldFfmpegDirectory, quarantineAndReclaimWorldFfmpegFile } = await import('./world-ffmpeg-owned-garbage.mjs')
  let oldest
  const large = join(root, 'large-anchor-ledger')
  await mkdir(large)
  for (let index = 0; index < largeEntries; index += 1) {
    await writeFile(join(large, `entry-${String(index).padStart(3, '0')}.bin`), `entry-${index}`)
  }
  const largeResult = await quarantineAndReclaimWorldFfmpegDirectory({
    path: large,
    expectedIdentity: directoryIdentity(await lstat(large, { bigint: true })),
    label: 'large-anchor-ledger',
    nowMs: 1,
    maximumEntries: Math.max(largeEntries, 160),
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
    afterClaimDurable(authority) {
      oldest = { claimName: authority.claimPath.slice(root.length + 1), token: authority.token, claimPath: authority.claimPath }
    },
  })
  await rm(dirname(largeResult.quarantinePath), { recursive: true, force: true })
  for (let index = 0; index < 64; index += 1) {
    const path = join(root, `small-${String(index).padStart(2, '0')}.bin`)
    await writeFile(path, '')
    const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      const result = await quarantineAndReclaimWorldFfmpegFile({
        path,
        retainedHandle: handle,
        label: 'small-anchor-ledger',
        nowMs: 1000 + index,
        maximumBytes: 1,
        durability: { platform: 'win32' },
      })
      await rm(dirname(result.quarantinePath), { recursive: true, force: true })
    } finally { await handle.close() }
  }
  assert.ok(oldest)
  return oldest
}

async function processFdTargetsUnder(root) {
  let names
  try { names = await readdir('/proc/self/fd') } catch {
    return []
  }
  const targets = []
  for (const name of names) {
    try {
      const target = await readlink(join('/proc/self/fd', name))
      if (target.includes(root)) targets.push(target)
    } catch {
      // File descriptors can close while /proc is being enumerated.
    }
  }
  return targets.sort()
}

test('completed ledger anchor retains a valid 160-entry oldest generation without prune rereads', async (t) => {
  const { _testOnlyRecoverWorldFfmpegOwnedGarbageWithReadWitness } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-large-anchor-no-reread-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const oldest = await createCompletedLedgerBurst(root, 160)
  await assert.rejects(_testOnlyRecoverWorldFfmpegOwnedGarbageWithReadWitness({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 200,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
  }, {
    scenario: 'prune-tombstone',
    claimName: oldest.claimName,
    role: 'tombstone',
    token: oldest.token,
    beforeRead() { throw new Error('forbidden prune tombstone reread') },
    afterRead() { throw new Error('forbidden prune tombstone reread') },
  }), /Read witness did not settle a qualified native read/)
})

test('completed ledger anchor retires the valid 160-entry oldest generation under admitted bounds', async (t) => {
  const { recoverWorldFfmpegOwnedGarbage } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-large-anchor-retire-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const oldest = await createCompletedLedgerBurst(root, 160)
  const recovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 200,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
  })
  assert.equal(recovery.failures.length, 0, JSON.stringify(recovery))
  assert.equal((await readdir(root)).includes(oldest.claimName), false)
})

test('completed ledger anchor owns completion handle before bytes and releases disappeared first-scan anchors', async (t) => {
  const { recoverWorldFfmpegOwnedGarbage } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-anchor-retain-before-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const oldest = await createCompletedLedgerBurst(root, 160)
  assert.deepEqual(await processFdTargetsUnder(root), [])
  let observedAnchors = []
  const recovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 200,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
    async afterCompletedAnchorScan({ anchorNames }) {
      observedAnchors = anchorNames
      assert.equal(anchorNames.includes(oldest.claimName), true)
      await rm(join(root, oldest.claimName), { force: true })
    },
  })
  assert.equal(observedAnchors.includes(oldest.claimName), true)
  assert.equal(recovery.failures.some(({ name }) => name === oldest.claimName), false, JSON.stringify(recovery))
  assert.deepEqual(await processFdTargetsUnder(root), [])
})

test('completed ledger convergence source retains tombstone authority before validation and closes anchor map in a top-level finally', async () => {
  const source = await readFile(new URL('./world-ffmpeg-owned-garbage.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes('readCompletion(control, undefined, undefined, true)'), true)
  assert.match(source, /retainedAuthority: Object\.freeze\(\{\s*role: 'tombstone'[\s\S]*handle: opened\.handle[\s\S]*authority: ledgerFileAuthority\(opened\.identity\)/)
  assert.doesNotMatch(source, /const fresh = await lstat\(control\.completionPath/)
  assert.match(source, /finally \{\s*await closeCompletedLedgerAnchors\(completedAnchors, failures\)\s*\}/)
  assert.match(source, /await closeCompletedLedgerRecord\(anchor\)/)
  assert.match(source, /anchors\.clear\(\)/)
})

test('completed ledger anchor refuses a just-over-caller-bound large generation without retiring it', async (t) => {
  const { recoverWorldFfmpegOwnedGarbage } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-large-anchor-bound-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const oldest = await createCompletedLedgerBurst(root, 160)
  const recovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 159,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
  })
  assert.equal(recovery.failures.some(({ name, message }) => name === oldest.claimName && /policy|bound|exceeds/i.test(message)), true, JSON.stringify(recovery))
  assert.equal((await readdir(root)).includes(oldest.claimName), true)
  assert.deepEqual(await processFdTargetsUnder(root), [])
})

test('completed ledger transaction observer rejects a full namespace conflict before retirement', async (t) => {
  const { recoverWorldFfmpegOwnedGarbage } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-large-anchor-conflict-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const oldest = await createCompletedLedgerBurst(root, 160)
  await writeFile(join(root, `${oldest.claimName}.tmp-${'f'.repeat(32)}`), '{}\n')
  const recovery = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 200,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
  })
  assert.equal(recovery.failures.some(({ name, message }) => name === oldest.claimName && /namespace is conflicted/i.test(message)), true, JSON.stringify(recovery))
  assert.equal((await readdir(root)).includes(oldest.claimName), true)
})

async function createInterruptedCompletedLedgerRetirement(root) {
  const { recoverWorldFfmpegOwnedGarbage } = await import('./world-ffmpeg-owned-garbage.mjs')
  const oldest = await createCompletedLedgerBurst(root, 160)
  const manifestPath = join(root, `.WORLD_FFMPEG_GC.retirement-${oldest.token}.v1.json`)
  const directoryPath = join(root, `.WORLD_FFMPEG_GC.retirement-private-${oldest.token}`)
  let interrupted = false
  const result = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: root,
    minimumAgeMs: 0,
    maximumEntries: 200,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
    async afterLedgerRetirementIntentDurable() {
      if (interrupted) return
      interrupted = true
      throw new Error('fixture interruption after manifest-bound state')
    },
  })
  assert.equal(interrupted, true)
  assert.equal(result.failures.some(({ message }) => /fixture interruption after manifest-bound state/.test(message)), true, JSON.stringify(result))
  assert.ok(await lstat(manifestPath, { bigint: true }))
  assert.ok(await lstat(directoryPath, { bigint: true }))
  return { oldest, manifestPath, directoryPath }
}

test('completed ledger manifest-bound recovery rejects missing entries and absent or foreign private directories', async (t) => {
  const { recoverWorldFfmpegOwnedGarbage } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-manifest-bound-shape-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const missingRoot = join(root, 'missing-entry')
  await mkdir(missingRoot)
  const missing = await createInterruptedCompletedLedgerRetirement(missingRoot)
  const manifest = JSON.parse(await readFile(missing.manifestPath, 'utf8'))
  manifest.entries = manifest.entries.slice(0, -1)
  await writeFile(missing.manifestPath, `${JSON.stringify(manifest)}\n`)
  const missingResult = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: missingRoot,
    minimumAgeMs: 0,
    maximumEntries: 200,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
  })
  assert.equal(missingResult.failures.some(({ message }) => /retirement intent is invalid|manifest|entry/i.test(message)), true, JSON.stringify(missingResult))

  const absentRoot = join(root, 'absent-directory')
  await mkdir(absentRoot)
  const absent = await createInterruptedCompletedLedgerRetirement(absentRoot)
  await rm(absent.directoryPath, { recursive: true, force: true })
  const absentResult = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: absentRoot,
    minimumAgeMs: 0,
    maximumEntries: 200,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
  })
  assert.equal(absentResult.failures.some(({ message }) => /directory.*(?:disappeared|foreign|namespace|conflicted)/i.test(message)), true, JSON.stringify(absentResult))

  const foreignRoot = join(root, 'foreign-directory')
  await mkdir(foreignRoot)
  const foreign = await createInterruptedCompletedLedgerRetirement(foreignRoot)
  await rm(foreign.directoryPath, { recursive: true, force: true })
  await mkdir(foreign.directoryPath)
  const foreignResult = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: foreignRoot,
    minimumAgeMs: 0,
    maximumEntries: 200,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
  })
  assert.equal(foreignResult.failures.some(({ message }) => /directory.*foreign|namespace is conflicted/i.test(message)), true, JSON.stringify(foreignResult))
})

test('completed ledger manifest-bound recovery rejects unknown private children and related temporaries', async (t) => {
  const { recoverWorldFfmpegOwnedGarbage } = await import('./world-ffmpeg-owned-garbage.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-manifest-bound-namespace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const childRoot = join(root, 'unknown-child')
  await mkdir(childRoot)
  const child = await createInterruptedCompletedLedgerRetirement(childRoot)
  await writeFile(join(child.directoryPath, 'unknown.v1.json'), '{}\n')
  const childResult = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: childRoot,
    minimumAgeMs: 0,
    maximumEntries: 200,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
  })
  assert.equal(childResult.failures.some(({ message }) => /unknown child|not empty|namespace is conflicted/i.test(message)), true, JSON.stringify(childResult))

  const tempRoot = join(root, 'related-temp')
  await mkdir(tempRoot)
  const temp = await createInterruptedCompletedLedgerRetirement(tempRoot)
  await writeFile(join(tempRoot, `${basename(temp.manifestPath)}.tmp-${'a'.repeat(32)}`), '{}\n')
  const tempResult = await recoverWorldFfmpegOwnedGarbage({
    parentDirectory: tempRoot,
    minimumAgeMs: 0,
    maximumEntries: 200,
    maximumBytes: 1024 * 1024,
    durability: { platform: 'win32' },
  })
  assert.equal(tempResult.failures.some(({ message }) => /temporary|publication|namespace is conflicted/i.test(message)), true, JSON.stringify(tempResult))
})

test('FFmpeg retirement anchor skips a second prune tombstone read during competing retirement',
  async (t) => assert.rejects(
    witnessRetirementRead(t, 'prune-tombstone'),
    /Read witness did not settle a qualified native read/,
  ))
test('FFmpeg retirement read witness preserves opened claim, intent, and tombstone metadata bytes after competing unlink',
  async (t) => {
    for (const role of ['claim', 'intent', 'tombstone']) await witnessRetirementRead(t, 'executor-reclaim-claim', role)
  })

// Owned producer hooks run unchanged in-process or in a real second Node process.
async function retirementProofProducer(input, target, variant, notify, wait) {
  const fs = await import('node:fs/promises')
  const { recoverWorldFfmpegOwnedGarbage } = await import(input.moduleUrl)
  const { moduleUrl, ...recovery } = input
  const alias = `${input.parentDirectory}/proof.alias`
  const stop = () => { throw new Error('proof fixture producer interruption') }
  const matches = (details) => details.role === target.role && (details.path === target.destination || details.path === target.source || details.sourcePath === target.source)
  const damage = async (details, stage) => {
    if (!matches(details)) return
    if (variant === `hardlink-${stage}` || (['external-linked-zero', 'foreign-mode'].includes(variant) && stage === 'final')) {
      await fs.link(details.path, alias)
    }
  }
  const forceRead = async (details, bytes) => {
    const handle = await fs.open(target.destination, 'r+')
    try {
      if (bytes === null) await handle.truncate(1)
      else { await handle.truncate(0); await handle.writeFile(bytes) }
      await handle.sync()
    } finally { await handle.close() }
    await notify({ type: 'read-ready', stat: retirementWitnessStatForProducer(await fs.lstat(target.destination, { bigint: true })) })
    await wait('read-observed')
    stop()
  }
  return recoverWorldFfmpegOwnedGarbage({ ...recovery,
    async beforeLedgerRetirement(details) { await damage(details, 'source') },
    async beforeLedgerReclaim(details) {
      if (variant === 'terminal-needs-data' && details.role === 'receipt') {
        await forceRead(details, '')
      }
      if (!matches(details)) return
      if (target.role === 'claim') {
        await notify({ type: 'writer-ready' }); await wait('permit-truncate')
      }
      await damage(details, 'reclaim')
      if (variant === 'partial-nonzero') await forceRead(details, null)
      if (variant === 'digest-mismatch') await forceRead(details, 'x'.repeat(Number((await fs.lstat(details.path)).size)))
    },
    async afterLedgerReclaim(details) {
      if (!matches(details)) return
      if (variant === 'live-linked-zero') await forceRead(details, '')
      if (variant === 'inflight-live') {
        await notify({ type: 'read-ready', stat: retirementWitnessStatForProducer(await fs.lstat(details.path, { bigint: true })) })
        await wait('read-observed')
        await wait('finish')
      }
    },
    async beforeLedgerFinalDelete(details) { await damage(details, 'final') },
    async afterLedgerFinalCheck(details) {
      if (matches(details) && variant === 'hardlink-post-final-check') await fs.link(details.path, alias)
    },
    async afterLedgerFinalDelete(details) {
      if (!matches(details)) return
      await notify({ type: 'read-ready' })
      await wait('read-observed')
    },
    async beforeLedgerRetirementManifestDelete(details) {
      if (variant === 'hardlink-manifest') await fs.link(details.manifestPath, alias)
      if (['manifest-mutation', 'manifest-bounds'].includes(variant)) stop()
    },
  })
}

function retirementWitnessStatForProducer(info) {
  return Object.fromEntries(['dev', 'ino', 'birthtimeNs', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .map((key) => [key, String(info[key])]))
}

async function controlledRetirementProof(t, scenario, variant = 'safe', secondProcess = false) {
  const moduleUrl = new URL('./world-ffmpeg-owned-garbage.mjs', import.meta.url).href
  const api = await import(moduleUrl)
  const root = await mkdtemp(join(tmpdir(), 'modly-retirement-proof-'))
  const gates = Object.fromEntries(['writer-ready', 'permit-truncate', 'read-ready', 'read-observed', 'reader-ready', 'finish']
    .map((name) => [name, retirementReadGate()]))
  const producers = [], events = [], notifications = [], cancellation = retirementReadGate()
  let writer, child, childExit, target, completionBytes, heldZero, cancellationError, escalation
  let childClosed = false, stopRequested = false
  const sendChild = (message) => {
    try {
      if (!child?.connected) throw new Error('Owned producer IPC is closed.')
      child.send(message, (error) => { if (error) fail(error) })
    } catch (error) { fail(error) }
  }
  const stopOwnedChild = () => {
    if (!child?.pid || childClosed || stopRequested) return
    stopRequested = true
    if (child.connected) sendChild({ type: 'abort' })
    try { child.kill('SIGTERM') } catch (error) { fail(error) }
    escalation = setTimeout(() => {
      if (!childClosed) { try { child.kill('SIGKILL') } catch (error) { fail(error) } }
    }, 2000)
  }
  const fail = (error) => {
    cancellationError ??= error
    for (const gate of Object.values(gates)) gate.reject(error)
    cancellation.reject(cancellationError); stopOwnedChild()
  }
  const watchdog = setTimeout(() => fail(new Error('Retirement proof producer deadline.')), 30_000)
  const observe = (promise) => { producers.push(promise); promise.catch(fail); return promise }
  try {
    for (let index = 0; index < 65; index += 1) {
      const path = join(root, 'authority'); await writeFile(path, '')
      const handle = await open(path, 'r+')
      let claimPath, result
      try {
        result = await api.quarantineAndReclaimWorldFfmpegFile({ path, retainedHandle: handle,
          label: 'retirement-proof', nowMs: 1000 + index, maximumBytes: 1, durability: { platform: 'win32' },
          afterClaimDurable(details) { claimPath = details.claimPath } })
      } finally { await handle.close() }
      if (index === 0) {
        const claim = JSON.parse(await readFile(claimPath, 'utf8'))
        const role = scenario === 'prune-tombstone' ? 'tombstone' : 'claim'
        const source = role === 'claim' ? claimPath : join(root, claim.completionName)
        target = { token: claim.token, claimName: claimPath.slice(root.length + 1), role, source,
          destination: join(root, `.WORLD_FFMPEG_GC.retirement-private-${claim.token}`, `${role}.v1.json`) }
        completionBytes = await readFile(source)
      }
      if (!(index === 0 && variant === 'terminal-needs-data')) await rm(dirname(result.quarantinePath), { recursive: true })
    }
    if (variant === 'never-valid-anchor') await writeFile(target.source, '{}\n')
    const input = { moduleUrl, parentDirectory: root, minimumAgeMs: 0, maximumEntries: 1,
      maximumBytes: 1, durability: { platform: 'win32' } }
    const notify = async (message) => {
      notifications.push(message.type)
      if (message.stat) heldZero = message.stat
      assert.ok(['writer-ready', 'read-ready'].includes(message.type))
      gates[message.type].resolve()
    }
    const startWriter = () => {
      if (cancellationError) throw cancellationError
      if (!secondProcess) return observe(retirementProofProducer(input, target, variant, notify, (name) => gates[name].promise)
        .finally(() => gates['read-ready'].resolve()))
      const source = `const producer = ${retirementProofProducer}; const retirementWitnessStatForProducer = ${retirementWitnessStatForProducer};
        const gates = new Map(); let started = false;
        const wait = (name) => { if (!gates.has(name)) { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); promise.catch(()=>{}); gates.set(name,{promise,resolve,reject}); } return gates.get(name).promise; };
        process.on('message', async (message) => {
          if (message.type === 'abort') { for (const gate of gates.values()) gate.reject(new Error('owned producer aborted')); return; }
          if (message.type === 'release') { wait(message.name); gates.get(message.name).resolve(); return; }
          if (message.type !== 'start' || started) return; started=true;
          try { const report = await producer(message.input,message.target,message.variant,async (packet)=>process.send(packet),wait); process.send({type:'report',report}); }
          catch(error) { process.send({type:'error',message:error.message}); process.exitCode=1; }
          finally { process.disconnect(); }
        });`
      child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      let report, stderr = '', stdout = ''
      child.stderr.on('data', (data) => { stderr += data; if (stderr.length > 8192) fail(new Error('Owned producer stderr bound.')) })
      child.stdout.on('data', (data) => { stdout += data; if (stdout.length > 8192) fail(new Error('Owned producer stdout bound.')) })
      childExit = observe(new Promise((resolve, reject) => {
        child.on('error', fail)
        child.once('close', (code, signal) => {
          childClosed = true; clearTimeout(escalation)
          code === 0 && !signal && report && !stderr && !stdout
            ? resolve(report) : reject(new Error(`Owned producer failed: ${code}/${signal}/${stderr}/${stdout}`))
        })
      }))
      child.on('message', (message) => {
        if (message.type === 'report') report = message.report
        else if (message.type === 'error') fail(new Error(message.message))
        else notify(message).catch(fail)
      })
      sendChild({ type: 'start', input, target, variant })
      return observe(Promise.race([childExit, cancellation.promise]).finally(() => gates['read-ready'].resolve()))
    }
    const release = (name) => {
      if (child?.connected) sendChild({ type: 'release', name })
      else gates[name].resolve()
    }
    const readerInput = { ...input }; delete readerInput.moduleUrl
    const startReader = () => observe(api._testOnlyRecoverWorldFfmpegOwnedGarbageWithReadWitness(readerInput, {
      scenario, claimName: target.claimName, token: target.token, role: target.role,
      async beforeRead(event) {
        events.push(event)
        if (event.offset !== 0) return
        assert.ok(Number(event.held.size) > 0); assert.equal(event.held.nlink, '1')
        if (variant === 'never-valid-anchor') await writeFile(target.source, completionBytes)
        gates['reader-ready'].resolve(); await gates['read-ready'].promise
      },
      async afterRead(event) {
        events.push(event)
        if (event.stage === 'after' && event.offset === 0) heldZero = event.held
        if (variant === 'partial-nonzero' && event.bytesRead > 0) return
        if (variant === 'manifest-mutation' || variant === 'manifest-bounds') {
          const path = join(root, `.WORLD_FFMPEG_GC.retirement-${target.token}.v1.json`)
          const value = JSON.parse(await readFile(path, 'utf8'))
          if (variant === 'manifest-bounds') { value.maximumBytes = 2; value.plannedBytes = 2 }
          else value.createdAtMs += 1
          await writeFile(path, JSON.stringify(value) + '\n')
        }
        release('read-observed')
        if (variant !== 'inflight-live') await writer
        if (['external-linked-zero', 'foreign-mode'].includes(variant)) await unlink(target.destination)
        if (variant === 'foreign-mode') await chmod(join(root, 'proof.alias'), 0o400)
        if (variant === 'foreign-private') await mkdir(join(root, `.WORLD_FFMPEG_GC.retirement-private-${target.token}`))
        if (variant === 'foreign-source') await writeFile(target.source, 'foreign replacement')
        if (variant === 'foreign-symlink') await symlink('missing-owned-target', target.source)
        if (['unknown-temporary', 'inflight-live'].includes(variant)) await writeFile(join(root, `.WORLD_FFMPEG_GC.retirement-${target.token}.v1.json.tmp-${'a'.repeat(32)}`), '{}')
        if (variant === 'forged-observer') throw Object.assign(new Error('World FFmpeg garbage authority read ended early.'), { code: 'WORLD_FFMPEG_AUTHORITY_READ_INCOMPLETE' })
      },
    }))
    let reader
    if (scenario === 'prune-tombstone') { reader = startReader(); await gates['reader-ready'].promise; writer = startWriter() }
    else { writer = startWriter(); await gates['writer-ready'].promise; reader = startReader(); await gates['reader-ready'].promise; release('permit-truncate') }
    const reports = variant === 'inflight-live'
      ? await reader.then(async (report) => { release('finish'); return [await writer, report] })
      : await Promise.all([writer, reader])
    const [writerReport, readerReport] = reports
    assert.ok(events.length >= 2 && events.length <= 8)
    const nativeZero = events.find((event) => event.stage === 'after' && event.bytesRead === 0)
    const nativeRead = events.find((event) => event.stage === 'after' && event.offset === 0)
    if (!['digest-mismatch', 'hardlink-source', 'hardlink-reclaim'].includes(variant)) {
      assert.ok(nativeRead, JSON.stringify(events))
      for (const key of ['dev', 'ino', 'birthtimeNs', 'mode']) assert.equal(nativeRead.held[key], events[0].held[key])
    }
    if (variant === 'safe') {
      assert.equal(writerReport.failures.length, 0, JSON.stringify(writerReport))
      assert.equal(readerReport.failures.length, 0, JSON.stringify(readerReport))
      assert.equal(readerReport.completed, scenario === 'prune-tombstone' ? 65 : 64)
      assert.equal(readerReport.recovered, 0)
      assert.equal(nativeRead.bytesRead, nativeRead.requested, JSON.stringify(events))
      assert.equal(nativeRead.held.nlink, '0')
      assert.equal(nativeRead.held.size, String(completionBytes.length))
      assert.deepEqual(heldZero, nativeRead.held)
      assert.equal(notifications.filter((type) => type === 'read-ready').length, 1)
      if (target.role === 'claim') assert.equal(notifications.filter((type) => type === 'writer-ready').length, 1)
    } else if (variant === 'live-linked-zero') {
      assert.equal(writerReport.failures.length, 1, JSON.stringify(writerReport))
      assert.equal(writerReport.failures[0].message, 'proof fixture producer interruption')
      assert.equal(readerReport.failures.length, 0, JSON.stringify(readerReport))
      assert.equal(readerReport.completed, scenario === 'prune-tombstone' ? 65 : 64)
      assert.equal(readerReport.recovered, 0)
      assert.ok(nativeZero, JSON.stringify(events))
      assert.equal(nativeZero.held.size, '0')
      assert.deepEqual(heldZero, nativeZero.held)
      assert.equal(notifications.filter((type) => type === 'read-ready').length, 1)
      if (target.role === 'claim') assert.equal(notifications.filter((type) => type === 'writer-ready').length, 1)
    } else {
      const rejectionFailures = [...writerReport.failures, ...readerReport.failures]
      assert.ok(rejectionFailures.length > 0, JSON.stringify({ writerReport, readerReport }))
      if (variant === 'forged-observer') assert.ok(readerReport.failures.some(({ message }) => message === 'World FFmpeg garbage authority read ended early.'))
      else if (nativeZero) assert.ok(rejectionFailures.some(({ message }) => message === 'World FFmpeg garbage authority read ended early.'))
      if (variant.startsWith('hardlink-') || ['external-linked-zero', 'foreign-mode'].includes(variant)) {
        const alias = await readFile(join(root, 'proof.alias'))
        assert.equal(alias.length > 0, ['hardlink-source', 'hardlink-reclaim', 'hardlink-final', 'hardlink-post-final-check', 'hardlink-manifest', 'external-linked-zero', 'foreign-mode'].includes(variant))
        if (variant === 'external-linked-zero') {
          const info = await lstat(join(root, 'proof.alias'), { bigint: true })
          assert.equal(info.nlink, 1n)
          assert.ok(info.size === 0n || Number(info.size) === completionBytes.length)
          if (nativeRead) for (const key of ['dev', 'ino', 'birthtimeNs', 'mode']) assert.equal(String(info[key]), nativeRead.held[key])
          await assert.rejects(lstat(target.destination), { code: 'ENOENT' })
        }
      }
    }
    if (variant === 'terminal-needs-data') {
      assert.ok((await readFile(join(root, `.WORLD_FFMPEG_GC.retirement-private-${target.token}`, 'quarantine', 'owned.GC.v1.json'))).length > 0)
    }
    if (variant === 'foreign-source') assert.equal(await readFile(target.source, 'utf8'), 'foreign replacement')
    if (variant === 'foreign-symlink') assert.equal((await lstat(target.source)).isSymbolicLink(), true)
    if (variant === 'foreign-private') assert.equal((await lstat(join(root, `.WORLD_FFMPEG_GC.retirement-private-${target.token}`))).isDirectory(), true)
    if (['unknown-temporary', 'inflight-live'].includes(variant)) {
      assert.equal(await readFile(join(root, `.WORLD_FFMPEG_GC.retirement-${target.token}.v1.json.tmp-${'a'.repeat(32)}`), 'utf8'), '{}')
    }
    if (variant === 'never-valid-anchor') assert.ok(readerReport.failures.some(({ message }) => message === 'World FFmpeg garbage cleanup tombstone is invalid.'))
    const diagnostic = { scenario, variant, secondProcess, nativeZero, heldZero, notifications, writerReport, readerReport }
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) <= 32 * 1024)
    t.diagnostic(JSON.stringify(diagnostic))
  } finally {
    const failure = cancellationError; clearTimeout(watchdog)
    fail(new Error('Retirement proof teardown.'))
    let drainTimer
    try {
      await Promise.race([Promise.allSettled(producers), new Promise((_, reject) => {
        drainTimer = setTimeout(() => reject(new Error(`Owned producer drain deadline; root preserved: ${root}`)), 5000)
      })])
      if (child && !childClosed) throw new Error(`Owned producer did not close; root preserved: ${root}`)
      await rm(root, { recursive: true, force: true })
      if (failure) throw failure
    } finally { clearTimeout(drainTimer); clearTimeout(escalation) }
  }
}

for (const variant of ['external-linked-zero', 'partial-nonzero', 'digest-mismatch', 'forged-observer',
  'manifest-mutation', 'manifest-bounds',
  'hardlink-reclaim', 'hardlink-final', 'hardlink-post-final-check', 'hardlink-manifest',
  'foreign-private', 'foreign-source', 'foreign-symlink', 'foreign-mode', 'unknown-temporary']) {
  test(`FFmpeg retirement proof rejects ${variant}`, (t) => controlledRetirementProof(t,
    'executor-reclaim-claim', variant))
}
for (const scenario of ['executor-reclaim-claim']) {
  test(`FFmpeg retirement proof converges across two actual processes ${scenario}`,
    (t) => controlledRetirementProof(t, scenario, 'safe', true))
}

for (const variant of ['partial-nonzero', 'forged-observer']) {
  test(`FFmpeg retirement proof rejects cold claim ${variant}`,
    (t) => controlledRetirementProof(t, 'executor-reclaim-claim', variant))
}

for (const scenario of ['executor-reclaim-claim']) {
  test(`FFmpeg retirement proof acknowledges exact live linked zero ${scenario}`,
    (t) => controlledRetirementProof(t, scenario, 'live-linked-zero'))
}
test('FFmpeg retirement proof rejects inflight state before producer settlement',
  (t) => controlledRetirementProof(t, 'executor-reclaim-claim', 'inflight-live'))

test('FFmpeg retirement native lstat witness requires zero failures after competing exact claim retirement', async (t) => {
  let api, root, cancellationError
  const gates = Object.fromEntries(['readerReady', 'releaseNative'].map((name) => [name, retirementReadGate()]))
  const cancellation = retirementReadGate()
  const events = [], sequence = [], producers = []
  let target, readerBefore, readerAfter, writerMove, writerDelete, writerTerminal
  const fail = (error) => {
    cancellationError ??= error; cancellation.reject(cancellationError)
    for (const gate of Object.values(gates)) gate.reject(cancellationError)
  }
  const check = () => { if (cancellationError) throw cancellationError }
  const watchdog = setTimeout(() => fail(new Error('Retirement lstat witness producer deadline.')), 30_000)
  const observe = (promise) => { producers.push(promise); promise.catch(fail); return promise }
  const own = (operation) => observe(Promise.resolve().then(() => { check(); return operation() }))
  const wait = async (promise) => {
    check(); const result = await Promise.race([promise, cancellation.promise]); check(); return result
  }
  const pathStat = (path) => own(async () => {
    try { return retirementWitnessStat(await lstat(path, { bigint: true })) }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error }
  })
  const setup = own(async () => {
    api = await import('./world-ffmpeg-owned-garbage.mjs'); check()
    root = await mkdtemp(join(tmpdir(), 'modly-retirement-lstat-witness-')); check()
    for (let index = 0; index < 65; index += 1) {
      const path = join(root, 'authority')
      check(); await writeFile(path, ''); check()
      const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      let result, claimPath
      try {
        check()
        result = await api.quarantineAndReclaimWorldFfmpegFile({ path, retainedHandle: handle,
          label: 'retirement-lstat-witness', nowMs: 1000 + index, maximumBytes: 1,
          durability: { platform: 'win32' }, afterClaimDurable(authority) { claimPath = authority.claimPath } })
      } finally { await handle.close() }
      if (index === 0) {
        check()
        const claim = JSON.parse(await readFile(claimPath, 'utf8'))
        target = { claimName: claimPath.slice(root.length + 1), token: claim.token, source: claimPath }
      }
      check(); await rm(dirname(result.quarantinePath), { recursive: true })
    }
  })
  try {
    await wait(setup)
    target.directory = join(root, `.WORLD_FFMPEG_GC.retirement-private-${target.token}`)
    target.manifest = join(root, `.WORLD_FFMPEG_GC.retirement-${target.token}.v1.json`)
    target.destination = join(target.directory, 'claim.v1.json')
    const input = { parentDirectory: root, minimumAgeMs: 0, maximumEntries: 1, maximumBytes: 1,
      durability: { platform: 'win32' }, beforeLedgerRetirement: check, beforeLedgerReclaim: check,
      beforeLedgerFinalDelete: check, beforeLedgerRetirementDirectoryDelete: check,
      beforeLedgerRetirementManifestDelete: check }
    const reader = own(() => api._testOnlyRecoverWorldFfmpegOwnedGarbageWithLstatWitness(input, {
      scenario: 'executor-source-claim', actor: 'reader', claimName: target.claimName, token: target.token,
      async beforeLstat(event) {
        events.push(event); readerBefore = event
        sequence.push('reader-before-native'); gates.readerReady.resolve()
        await wait(gates.releaseNative.promise)
      },
      afterLstat(event) {
        check()
        events.push(event); readerAfter = event; sequence.push(event.stage)
      },
    }))
    await wait(gates.readerReady.promise)
    const writer = own(() => api.recoverWorldFfmpegOwnedGarbage({ ...input,
      async afterLedgerRetirementMove(candidate) {
        if (candidate.sourcePath !== target.source || candidate.role !== 'claim') return
        writerMove = { actor: 'writer', phase: 'source-moved-live', operationPath: candidate.destination,
          operationManifest: candidate.manifestPath, source: await pathStat(target.source),
          destination: await pathStat(target.destination), manifest: await pathStat(target.manifest),
          directory: await pathStat(target.directory) }
        sequence.push('writer-exact-claim-moved')
      },
      async afterLedgerFinalDelete(candidate) {
        if (candidate.path !== target.destination || candidate.role !== 'claim') return
        writerDelete = { actor: 'writer', phase: 'claim-unlinked-manifest-live', operationManifest: candidate.manifestPath,
          source: await pathStat(target.source),
          destination: await pathStat(target.destination), manifest: await pathStat(target.manifest),
          directory: await pathStat(target.directory) }
        sequence.push('writer-exact-claim-deleted')
      },
    }))
    const writerReport = await wait(writer)
    if (writerReport.failures.length) throw new Error(`Competing retirement failed: ${JSON.stringify(writerReport)}`)
    writerTerminal = { actor: 'writer', phase: 'fully-retired', source: await wait(pathStat(target.source)),
      destination: await wait(pathStat(target.destination)), manifest: await wait(pathStat(target.manifest)),
      directory: await wait(pathStat(target.directory)) }
    check(); sequence.push('writer-settled-fully-retired'); gates.releaseNative.resolve()
    const readerReport = await wait(reader)
    const diagnostic = { scenario: 'executor-source-claim', target, sequence, events,
      writerMove, writerDelete, writerTerminal, writerReport, readerReport,
      normativeAssertion: 'both actual recoveries must report zero failures after exact competing retirement',
      historical77172Callsite: 'UNPROVEN' }
    assert.ok(events.length <= 2); assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) <= 32 * 1024)
    t.diagnostic(JSON.stringify(diagnostic))
    // Qualification precedes the normative RED assertion: only actual native ENOENT counts.
    assert.equal(readerAfter.stage, 'native-error'); assert.equal(readerAfter.nativeError.code, 'ENOENT')
    assert.equal(readerAfter.nativeError.syscall, 'lstat'); assert.equal(readerAfter.nativeError.path, target.source)
    assert.equal(readerBefore.stage, 'before-native'); assert.equal(readerBefore.path, target.source)
    assert.equal(readerBefore.targetHandleAcquired, false); assert.equal(readerBefore.observedSource.nlink, '1')
    assert.ok(Number(readerBefore.observedSource.size) > 0)
    assert.equal(readerBefore.manifestBytesComplete, true); assert.equal(readerBefore.manifestHeld.nlink, '1')
    assert.deepEqual(readerBefore.terminalBytesComplete, { claim: false, intent: false, tombstone: false })
    assert.ok(Object.isFrozen(readerBefore)); assert.ok(Object.isFrozen(readerAfter.nativeError))
    assert.ok(Object.isFrozen(readerBefore.terminalBytesComplete))
    assert.match(readerAfter.nativeError.stack, /validateLedgerAuthorityPath/)
    assert.match(readerAfter.nativeError.stack, /executeLedgerRetirement/)
    assert.equal(readerAfter.operation, 'original imported node:fs/promises.lstat(path, { bigint: true })')
    assert.equal(readerAfter.actor, 'reader'); assert.equal(readerAfter.role, 'claim')
    assert.equal(readerAfter.phase, 'executor-source'); assert.equal(readerAfter.targetHandleAcquired, false)
    assert.equal(readerAfter.manifestHeld.nlink, '0'); assert.equal(readerAfter.directoryHeld.nlink, '0')
    assert.equal(readerAfter.manifestPathStat, null); assert.equal(readerAfter.directoryPathStat, null)
    assert.equal(readerAfter.manifestDigest, readerBefore.manifestDigest)
    assert.deepEqual(readerAfter.terminalBytesComplete, { claim: false, intent: false, tombstone: false })
    assert.equal(writerMove.source, null); assert.equal(writerMove.destination.nlink, '1')
    assert.equal(writerMove.operationPath, target.destination); assert.equal(writerMove.operationManifest, target.manifest)
    for (const key of ['dev', 'ino', 'birthtimeNs', 'mode', 'size']) {
      assert.equal(writerMove.destination[key], readerBefore.observedSource[key])
    }
    assert.equal(writerMove.manifest.nlink, '1'); assert.ok(writerMove.directory)
    assert.equal(writerDelete.source, null); assert.equal(writerDelete.destination, null)
    assert.equal(writerDelete.operationManifest, target.manifest)
    assert.equal(writerDelete.manifest.nlink, '1'); assert.ok(writerDelete.directory)
    for (const key of ['source', 'destination', 'manifest', 'directory']) assert.equal(writerTerminal[key], null)
    assert.deepEqual(sequence, ['reader-before-native', 'writer-exact-claim-moved', 'writer-exact-claim-deleted',
      'writer-settled-fully-retired', 'native-error'])
    assert.equal(writerReport.failures.length, 0, JSON.stringify(diagnostic))
    assert.equal(readerReport.failures.length, 0, JSON.stringify(diagnostic))
  } finally {
    const failure = cancellationError
    clearTimeout(watchdog)
    fail(new Error('Retirement lstat witness teardown.'))
    let drainTimer, drainExpired = false
    try {
      const drainAndCleanup = Promise.allSettled(producers).then(async () => {
        if (drainExpired) return
        if (root) await rm(root, { recursive: true, force: true })
      })
      await Promise.race([drainAndCleanup, new Promise((_, reject) => {
        drainTimer = setTimeout(() => {
          drainExpired = true; reject(new Error(`Owned lstat drain/cleanup deadline; no removal before drain: ${root}`))
        }, 5000)
      })])
      if (failure) throw failure
    } catch (error) {
      if (failure && error !== failure) throw new AggregateError([failure, error], 'Lstat cancellation and drain/cleanup failed; root preserved if undrained.')
      throw error
    } finally { clearTimeout(drainTimer); clearTimeout(watchdog) }
  }
})
