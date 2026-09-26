import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { classifyWorldFfmpegDynamicReferences, assertWorldFfmpegLinuxElfHeader, inspectWorldFfmpegBinary } from './world-ffmpeg-binary-audit.mjs'
import * as binaryAudit from './world-ffmpeg-binary-audit.mjs'
import { worldFfmpegBuildReportLinkAuthority } from './world-ffmpeg-build-report.mjs'
import { loadWorldFfmpegPackageToolLock, runWorldFfmpegOfflinePackage, verifyWorldFfmpegPackageToolCache, worldFfmpegPackageArguments } from './world-ffmpeg-package-tools.mjs'
import { prepareWorldFfmpegPackageToolCache } from './prepare-electron-builder-tool-cache.mjs'
import { loadWorldFfmpegSupplyChain, worldFfmpegTargetFor } from './world-ffmpeg-supply-chain.mjs'
import { assertWorldFfmpegLinuxArtifactElfHeader, validateWorldFfmpegExtractorContract } from './world-ffmpeg-artifact-inspector.mjs'
import * as artifactInspector from './world-ffmpeg-artifact-inspector.mjs'
import * as releaseFinalizer from './world-ffmpeg-release-finalizer.mjs'
import { assembleWorldFfmpegRuntime } from './world-ffmpeg-runtime-assembler.mjs'

const require = createRequire(import.meta.url)
const { electronBuilderTargetFor, beforePackWith } = require('./world-ffmpeg-before-pack.cjs')
const { worldFfmpegPackageTargetFor } = require('./world-ffmpeg-package-environment.cjs')

test('Linux ARM64 is an exact fourth source/runtime/package tuple without adjacent tuples', async () => {
  const contract = await loadWorldFfmpegSupplyChain()
  assert.deepEqual(contract.targets, ['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'])
  assert.equal(worldFfmpegTargetFor('linux', 'arm64'), 'linux-arm64')
  assert.equal(worldFfmpegTargetFor('linux', 'x64'), 'linux-x64')
  assert.equal(worldFfmpegTargetFor('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(worldFfmpegTargetFor('win32', 'x64'), 'win32-x64')
  assert.equal(worldFfmpegTargetFor('win32', 'arm64'), null)
  assert.equal(electronBuilderTargetFor('linux', 3), 'linux-arm64')
  assert.equal(worldFfmpegPackageTargetFor('linux', 'arm64'), 'linux-arm64')
  const calls = []
  await beforePackWith({ electronPlatformName: 'linux', arch: 3 }, {
    verify: async (request) => { calls.push(request); return { ok: true } },
  })
  assert.deepEqual(calls, [{ platform: 'linux', arch: 'arm64' }])
  await assert.rejects(beforePackWith({ electronPlatformName: 'win32', arch: 3 }, {
    verify: async () => ({ ok: true }),
  }), /Unsupported FFmpeg package target/)
})

test('Linux ARM64 closure rejects alien ELF, interpreter, loader path and unaudited dependency', async () => {
  const closure = (await loadWorldFfmpegSupplyChain()).dynamicClosure['linux-arm64']
  assert.deepEqual(closure.glibcBaseline, { distribution: 'Ubuntu 24.04', version: '2.39' })
  assert.deepEqual(closure.loaderSearch, ['$ORIGIN'])
  assert.deepEqual(closure.systemInterpreters, ['/lib/ld-linux-aarch64.so.1'])
  const elf = '  Class:                             ELF64\n  Data:                              2\'s complement, little endian\n  Machine:                           AArch64\n'
  assert.doesNotThrow(() => assertWorldFfmpegLinuxElfHeader(elf, 'linux-arm64'))
  assert.throws(() => assertWorldFfmpegLinuxElfHeader(elf.replace('AArch64', 'Advanced Micro Devices X86-64'), 'linux-arm64'), /ELF/)
  assert.throws(() => assertWorldFfmpegLinuxElfHeader(elf.replace('ELF64', 'ELF32'), 'linux-arm64'), /ELF/)
  const base = {
    dependencies: ['libavcodec.so.61', 'libc.so.6'], loaderSearch: ['$ORIGIN'],
    bundledNames: ['libavcodec.so.61'], target: 'linux-arm64',
    systemInterpreter: '/lib/ld-linux-aarch64.so.1',
  }
  assert.deepEqual(classifyWorldFfmpegDynamicReferences(base).bundledDependencies, ['libavcodec.so.61'])
  assert.throws(() => classifyWorldFfmpegDynamicReferences({ ...base, systemInterpreter: '/lib64/ld-linux-x86-64.so.2' }), /interpreter/)
  assert.throws(() => classifyWorldFfmpegDynamicReferences({ ...base, dependencies: ['/tmp/libavcodec.so.61'] }), /unsafe loader identity/)
  assert.ok(!closure.systemLibraries.includes('libgpl.so.1'))
  assert.ok(!closure.loaderSearch.includes('/usr/lib'))
  assert.ok(!closure.systemLibraries.includes('libavcodec.so.61'))
  assert.deepEqual(worldFfmpegBuildReportLinkAuthority('linux-arm64', '$ORIGIN').linkerEnvironment, { LD_RUN_PATH: '$ORIGIN' })
  assert.throws(() => worldFfmpegBuildReportLinkAuthority('linux-arm64', '/usr/lib'), /rpath/)
})

test('release CLI and workflow require a real fourth ARM package upload receipt', async () => {
  const env = Object.fromEntries([
    'WORLD_FFMPEG_WINDOWS_UPLOAD_RECEIPT', 'WORLD_FFMPEG_DARWIN_UPLOAD_RECEIPT',
    'WORLD_FFMPEG_LINUX_UPLOAD_RECEIPT', 'WORLD_FFMPEG_LINUX_ARM64_UPLOAD_RECEIPT',
  ].map((name) => [name, Buffer.from(JSON.stringify({ name })).toString('base64')]))
  assert.equal(releaseFinalizer.worldFfmpegFinalizerCliReceipts(env).length, 4)
  assert.throws(() => releaseFinalizer.worldFfmpegFinalizerCliReceipts({ ...env, WORLD_FFMPEG_LINUX_ARM64_UPLOAD_RECEIPT: undefined }), /LINUX_ARM64/)
  const yaml = require('js-yaml')
  const workflow = yaml.load(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const arm = workflow.jobs['build-linux-arm64']
  assert.equal(arm['runs-on'], 'ubuntu-24.04-arm')
  assert.match(arm.outputs.WORLD_FFMPEG_PACKAGE_UPLOAD_RECEIPT, /steps\.upload\.outputs\.WORLD_FFMPEG_PACKAGE_UPLOAD_RECEIPT/)
  assert.match(JSON.stringify(arm.steps), /--target linux-arm64/)
  assert.match(JSON.stringify(arm.steps), /--arch arm64/)
  assert.match(JSON.stringify(arm.steps), /world-ffmpeg-release-uploader\.mjs/)
  assert.ok(workflow.jobs['publish-release'].needs.includes('build-linux-arm64'))
  assert.match(workflow.jobs['publish-release'].steps.at(-1).env.WORLD_FFMPEG_LINUX_ARM64_UPLOAD_RECEIPT,
    /needs\.build-linux-arm64\.outputs\.WORLD_FFMPEG_PACKAGE_UPLOAD_RECEIPT/)
})

test('ARM packaged Electron architecture is checked inside mixed-arch AppImage and unpacked app', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-arm64-inner-elf-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resources = join(root, 'resources')
  await mkdir(resources)
  const header = Buffer.alloc(20)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  const outerAppImageHeader = Buffer.from(header)
  outerAppImageHeader.writeUInt16LE(183, 18)
  assert.doesNotThrow(() => assertWorldFfmpegLinuxArtifactElfHeader(outerAppImageHeader, 'linux-arm64'))
  header.writeUInt16LE(62, 18)
  await writeFile(join(root, 'modly'), header, { mode: 0o755 })
  await assert.rejects(artifactInspector.assertWorldFfmpegPackagedElectronExecutable(resources, 'linux-arm64'), /Electron executable.*ELF architecture/)
  header.writeUInt16LE(183, 18)
  await writeFile(join(root, 'modly'), header)
  await assert.doesNotReject(artifactInspector.assertWorldFfmpegPackagedElectronExecutable(resources, 'linux-arm64'))
})

test('ARM GLIBC requirements enforce the Ubuntu 24.04 host baseline and reject newer symbols', () => {
  const readelf = "Version needs section '.gnu.version_r' contains 1 entry:\n  0x0010:   Name: GLIBC_2.17  Flags: none  Version: 4\n  0x0020:   Name: GLIBC_2.39  Flags: none  Version: 3\n"
  assert.deepEqual(binaryAudit.parseWorldFfmpegGlibcRequirements(readelf, '2.39'), ['2.17', '2.39'])
  assert.throws(() => binaryAudit.parseWorldFfmpegGlibcRequirements(readelf.replace('2.39', '2.40'), '2.39'), /GLIBC baseline/)
  assert.throws(() => binaryAudit.parseWorldFfmpegGlibcRequirements(readelf.replace('GLIBC_2.39', 'GLIBC_PRIVATE'), '2.39'), /GLIBC symbol requirement/)
})

test('Linux ARM64 package contracts select only its resources and authenticate its helper lock', async () => {
  const config = JSON.parse(await readFile(new URL('./world-ffmpeg-electron-builder-config.json', import.meta.url), 'utf8'))
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const builder of [config, packageJson.build]) {
    const linuxResources = builder.linux.extraResources.map(({ from }) => from)
    assert.ok(!linuxResources.includes('resources/ffmpeg/linux-x64'))
    assert.ok(!linuxResources.includes('resources/world-ffmpeg-build-reports/linux-x64.json'))
    assert.deepEqual(linuxResources.slice(1), [
      'resources/ffmpeg/linux-${arch}',
      'resources/world-ffmpeg-build-reports/linux-${arch}.json',
    ])
    const { expandMacro } = require('app-builder-lib/out/util/macroExpander.js')
    for (const arch of ['x64', 'arm64']) {
      assert.deepEqual(builder.linux.extraResources.slice(1).map(({ from, to }) => ({
        from: expandMacro(from, arch, {}), to: expandMacro(to, arch, {}),
      })), [
        { from: `resources/ffmpeg/linux-${arch}`, to: `ffmpeg/linux-${arch}` },
        { from: `resources/world-ffmpeg-build-reports/linux-${arch}.json`, to: `world-ffmpeg-build-reports/linux-${arch}.json` },
      ])
    }
  }
  assert.deepEqual(worldFfmpegPackageArguments('linux-arm64'), ['--linux', '--arm64', '--publish', 'never'])
  const lock = await loadWorldFfmpegPackageToolLock()
  assert.deepEqual(lock.extractors['linux-arm64'], {
    source: { release: '7zip@1.0.0', filename: '7zip-linux-arm64.tar.gz', member: 'bin/7za' },
    sha256: 'ea6a2595eba6441e1e60ddaa47d73d849e99ef2ba18d3f386557cdcb9dc9cebd',
    size: 2452800, mode: 0o755, execution: 'proc-self-fd',
  })
  assert.equal(lock.targets['linux-arm64'][0].sha256, '5aff5034206b78f8261249ceb922b5c7e04c9bdb733784d8f5b6df9732cf1f79')
  assert.equal(validateWorldFfmpegExtractorContract(lock.extractors['linux-x64'], 'linux-arm64'), false)
  const result = await verifyWorldFfmpegPackageToolCache({ target: 'linux-arm64', cacheDirectory: '/tmp/nonexistent-world-ffmpeg-arm64-cache', contract: lock })
  assert.deepEqual(result, { ok: false, code: 'tool-cache-missing', entry: null })
})

test('AppImage inspection rejects wrong ELF machine before extraction', () => {
  const header = Buffer.alloc(20)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  header.writeUInt16LE(183, 18)
  assert.doesNotThrow(() => assertWorldFfmpegLinuxArtifactElfHeader(header, 'linux-arm64'))
  assert.throws(() => assertWorldFfmpegLinuxArtifactElfHeader(header, 'linux-x64'), /ELF/)
  header.writeUInt16LE(62, 18)
  assert.throws(() => assertWorldFfmpegLinuxArtifactElfHeader(header, 'linux-arm64'), /ELF/)
  header[4] = 1
  assert.throws(() => assertWorldFfmpegLinuxArtifactElfHeader(header, 'linux-arm64'), /ELF/)
})

test('ARM package preparation rejects wrong SHA and offline execution fails before builder without cache', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-arm64-no-helper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cache = join(root, 'cache')
  await mkdir(cache)
  let fetched = false
  await assert.rejects(prepareWorldFfmpegPackageToolCache({
    target: 'linux-arm64', cacheDirectory: cache,
    fetchImpl: async () => { fetched = true; return new Response('wrong archive', { status: 200 }) },
  }), /SHA-256 mismatch/)
  assert.equal(fetched, true)
  assert.deepEqual(await readdir(cache), [])
  await assert.rejects(runWorldFfmpegOfflinePackage({
    target: 'linux-arm64', cacheDirectory: cache,
    argv: ['--linux', '--arm64', '--publish', 'never'],
  }), /tool cache is missing/)
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-arm64']) {
    const bytes = Buffer.from(`ARM fixture: ${entry.release}/${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
  }
  const requests = []
  assert.deepEqual(await prepareWorldFfmpegPackageToolCache({
    target: 'linux-arm64', cacheDirectory: cache, contract,
    fetchImpl: async (url) => {
      requests.push(String(url))
      const entry = contract.targets['linux-arm64'].find(({ url: expected }) => expected === String(url))
      assert.ok(entry)
      return new Response(`ARM fixture: ${entry.release}/${entry.filename}`, { status: 200 })
    },
  }), { ok: true })
  assert.equal(requests.length, 3)
  assert.deepEqual(await verifyWorldFfmpegPackageToolCache({ target: 'linux-arm64', cacheDirectory: cache, contract }), { ok: true })
  assert.deepEqual(await prepareWorldFfmpegPackageToolCache({
    target: 'linux-arm64', cacheDirectory: cache, contract,
    fetchImpl: async () => { throw new Error('must remain offline') },
  }), { ok: true })
})

test('ARM upstream 7za symlink permits only its pinned local 7zz ELF target', async (t) => {
  if (process.platform !== 'linux' || process.arch !== 'arm64') return t.skip('Host-specific retained ARM extractor')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-arm64-7za-link-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cache = join(root, 'cache')
  const bin = join(cache, '7zip@1.0.0', 'fixture', 'bin')
  await mkdir(bin, { recursive: true })
  const binary = join(bin, '7zz')
  const alias = join(bin, '7za')
  const elf = Buffer.alloc(64)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  elf.writeUInt16LE(183, 18)
  await writeFile(binary, elf, { mode: 0o755 })
  await symlink('7zz', alias)
  const contract = {
    source: { release: '7zip@1.0.0', filename: '7zip-linux-arm64.tar.gz', member: 'bin/7za' },
    sha256: createHash('sha256').update(elf).digest('hex'), size: elf.length,
    mode: 0o755, execution: 'proc-self-fd',
  }
  let spawned = 0
  const run = (beforeSpawn) => artifactInspector._testOnlyRunPinnedWorldFfmpegExtractor({
    target: 'linux-arm64', platform: 'linux', cacheDirectory: cache,
    extractor: contract, arguments: [],
  }, {
    resolveExtractor: async () => alias,
    beforeSpawn,
    spawnProcess: () => {
      spawned += 1
      const child = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    },
  })
  const proof = await run()
  assert.equal(proof.sha256, contract.sha256)
  assert.equal(spawned, 1)
  await rm(alias)
  await symlink('../7zz', alias)
  await assert.rejects(run(), /symlink|link|extractor/i)
  await rm(alias)
  await symlink('7zz', alias)
  contract.sha256 = '0'.repeat(64)
  await assert.rejects(run(), /digest|SHA/i)
  assert.equal(spawned, 1)
  elf.writeUInt16LE(62, 18)
  await writeFile(binary, elf)
  contract.sha256 = createHash('sha256').update(elf).digest('hex')
  await assert.rejects(run(), /ELF|architecture/i)
  assert.equal(spawned, 1)
  elf.writeUInt16LE(183, 18)
  await writeFile(binary, elf)
  contract.sha256 = createHash('sha256').update(elf).digest('hex')
  await assert.rejects(run(async () => { await rm(alias); await symlink('other', alias) }), /changed|symlink|extractor/i)
  assert.equal(spawned, 1)
  await rm(alias)
  await symlink('7zz', alias)
  await rm(binary)
  await symlink('/usr/bin/true', binary)
  await assert.rejects(run(), /ELOOP|extractor|ordinary/i)
  assert.equal(spawned, 1)
  await rm(binary)
  await writeFile(binary, elf, { mode: 0o755 })
  await assert.rejects(run(async () => {
    await rm(binary)
    await writeFile(binary, elf, { mode: 0o755 })
  }), /changed during execution/i)
  assert.equal(spawned, 2)
})

test('native arm linker authority exports literal ORIGIN without host PATH fallback', () => {
  let output
  try {
    output = execFileSync('bash', ['-c',
      'source "$1"; world_ffmpeg_set_linker_environment linux-arm64; printf "%s\\n%s\\n" "$RUNTIME_RPATH" "$LD_RUN_PATH"',
      'bash', new URL('./world-ffmpeg-linker-environment.sh', import.meta.url).pathname,
    ], { encoding: 'utf8' })
  } catch (error) {
    // Some sandbox profiles report EPERM after a child successfully exits.
    if (error?.code !== 'EPERM' || error.status !== 0) throw error
    output = error.stdout
  }
  assert.equal(output, '$ORIGIN\n$ORIGIN\n')
})

test('readelf observes the real aarch64 interpreter and rejects that ELF as x64', async (t) => {
  if (process.platform !== 'linux' || process.arch !== 'arm64') return t.skip('Host-specific ELF probe')
  const input = { bundledNames: [], inspectorPath: '/usr/bin/readelf' }
  const result = await inspectWorldFfmpegBinary('/usr/bin/true', { ...input, target: 'linux-arm64' })
  assert.equal(result.systemInterpreter, '/lib/ld-linux-aarch64.so.1')
  assert.deepEqual(result.systemDependencies, ['ld-linux-aarch64.so.1', 'libc.so.6'])
  assert.ok(result.requiredGlibcVersions.includes('2.34'))
  await assert.rejects(inspectWorldFfmpegBinary('/usr/bin/true', { ...input, target: 'linux-x64' }), /ELF architecture/)
})

test('ARM assembler signs only an audited LGPL closure and leaves rejected trees unsigned', async (t) => {
  const contract = await loadWorldFfmpegSupplyChain()
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  async function candidate(label) {
    const resources = await mkdtemp(join(tmpdir(), `modly-arm64-assembly-${label}-`))
    t.after(() => rm(resources, { recursive: true, force: true }))
    const root = join(resources, 'ffmpeg', 'linux-arm64')
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true, mode: 0o755 })
    await writeFile(join(root, 'LICENSE.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE\nFFmpeg 7.1.1\nlibvpx 1.15.2\nlibopus 1.5.2\nzlib 1.3.2\n')
    await writeFile(join(bin, 'ffmpeg'), 'test-only executable')
    await writeFile(join(bin, 'libavcodec.so.61'), 'test-only shared library')
    await chmod(join(resources, 'ffmpeg'), 0o755)
    await chmod(root, 0o755)
    await chmod(bin, 0o755)
    await chmod(join(root, 'LICENSE.txt'), 0o644)
    await chmod(join(bin, 'ffmpeg'), 0o755)
    await chmod(join(bin, 'libavcodec.so.61'), 0o644)
    return root
  }
  const assemble = (root, systemDependency, libraryGlibc = '2.39') => assembleWorldFfmpegRuntime({
    bundleRoot: root, target: 'linux-arm64', supplyChain: contract,
    signingKeyId: 'arm64-test', privateKey: keys.privateKey,
    trustedManifestKeys: { 'arm64-test': publicKey },
    probe: async () => ({ ffmpegVersion: '7.1.1', configuration: contract.ffmpegConfigure, build: contract.build }),
    inspectBinary: async (path) => path.endsWith('/ffmpeg') ? {
      bundledDependencies: ['libavcodec.so.61'],
      systemDependencies: ['ld-linux-aarch64.so.1', systemDependency],
      loaderSearch: ['$ORIGIN'], systemInterpreter: '/lib/ld-linux-aarch64.so.1', requiredGlibcVersions: ['2.17'],
    } : {
      bundledDependencies: [], systemDependencies: ['libc.so.6'],
      loaderSearch: ['$ORIGIN'], systemInterpreter: null,
      requiredGlibcVersions: [libraryGlibc],
    },
  })
  const valid = await candidate('valid')
  const manifest = await assemble(valid, 'libc.so.6')
  assert.equal(manifest.target, 'linux-arm64')
  assert.equal(verify(null, await readFile(join(valid, 'manifest.json')), keys.publicKey,
    await readFile(join(valid, 'manifest.sig'))), true)
  const invalid = await candidate('unaudited-needed')
  await assert.rejects(assemble(invalid, 'libgpl.so.1'), /unaudited system library/)
  assert.deepEqual((await readdir(invalid)).sort(), ['LICENSE.txt', 'bin'])
  const newer = await candidate('newer-glibc-library')
  await assert.rejects(assemble(newer, 'libc.so.6', '2.40'), /GLIBC baseline/)
  assert.deepEqual((await readdir(newer)).sort(), ['LICENSE.txt', 'bin'])
})
