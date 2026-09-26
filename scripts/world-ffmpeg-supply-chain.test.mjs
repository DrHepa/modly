import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, createPrivateKey, generateKeyPairSync, verify as verifySignature } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { fetchWorldFfmpegSources } from './fetch-world-ffmpeg-sources.mjs'
import {
  classifyWorldFfmpegDynamicReferences,
  parseWorldFfmpegComponentTable,
  parseWorldFfmpegProtocols,
  assertWorldFfmpegConfiguration,
  assertWorldFfmpegGeneratedParserList,
  assertWorldFfmpegRuntimeComponentClosure,
  probeWorldFfmpegBinary,
} from './world-ffmpeg-binary-audit.mjs'
import {
  WORLD_FFMPEG_NATIVE_CASES,
  worldFfmpegNativeCasePlan,
} from './world-ffmpeg-native-e2e-contract.mjs'
import {
  assembleWorldFfmpegRuntime,
} from './world-ffmpeg-runtime-assembler.mjs'
import {
  loadWorldFfmpegSupplyChain,
  verifyWorldFfmpegDistributionFiles,
  verifyWorldFfmpegPackagedDistributionFiles,
  verifyWorldFfmpegSourceCache,
  worldFfmpegTargetFor,
} from './world-ffmpeg-supply-chain.mjs'
import {
  _testOnlyRunWorldFfmpegOutputCustodyInProcess as runWorldFfmpegOutputCustodyInProcess,
} from './world-ffmpeg-output-custody.mjs'
import { runWithWorldFfmpegCwdCustody } from './world-ffmpeg-cwd-custody.mjs'
import { verifyWorldFfmpegSources } from './verify-world-ffmpeg-sources.mjs'

const require = createRequire(import.meta.url)
const ASYNC_PIPE_CAPABILITY_MARKER = 'modly-world-ffmpeg-async-pipe-capability-v1'
const TEST_CUSTODY_DIRECTORY = dirname(fileURLToPath(import.meta.url))
let asyncPipeCapabilityPromise
let outputCustodyQueue = Promise.resolve()

function execFileAsync(file, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(Object.assign(error, { stdout, stderr }))
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

function runSerializedWorldFfmpegOutputCustody(input, dependencies = {}) {
  const operation = outputCustodyQueue.then(() => (
    runWorldFfmpegOutputCustodyInProcess(input, dependencies)
  ))
  outputCustodyQueue = operation.then(() => undefined, () => undefined)
  return operation
}

function runCwdCoordinatedWorldFfmpegOutputCustody(input, dependencies = {}) {
  const operation = outputCustodyQueue.then(() => (
    runWithWorldFfmpegCwdCustody(TEST_CUSTODY_DIRECTORY, () => (
      runWorldFfmpegOutputCustodyInProcess(input, dependencies)
    ))
  ))
  outputCustodyQueue = operation.then(() => undefined, () => undefined)
  return operation
}

function isUnavailablePipeCapabilityError(error) {
  return error?.code === 'EPERM' || error?.code === 'EACCES'
}

function probeExactAsyncPipeCapability() {
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(process.execPath, ['-e', `
let input = ''
for await (const chunk of process.stdin) input += chunk
process.stdout.write(input)
`], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      if (isUnavailablePipeCapabilityError(error)) {
        resolvePromise(Object.freeze({ available: false, reason: error.code }))
        return
      }
      rejectPromise(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (operation) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      operation()
    }
    const fail = (error) => finish(() => rejectPromise(error))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 4096) {
        child.kill('SIGKILL')
        fail(new Error('Nested async-pipe capability probe exceeded its stdout bound.'))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 4096) {
        child.kill('SIGKILL')
        fail(new Error('Nested async-pipe capability probe exceeded its stderr bound.'))
      }
    })
    child.once('error', (error) => {
      if (isUnavailablePipeCapabilityError(error)) {
        finish(() => resolvePromise(Object.freeze({ available: false, reason: error.code })))
        return
      }
      fail(error)
    })
    child.stdin.once('error', (error) => {
      if (isUnavailablePipeCapabilityError(error)) {
        finish(() => resolvePromise(Object.freeze({ available: false, reason: error.code })))
        return
      }
      fail(error)
    })
    child.once('close', (code, signal) => finish(() => {
      if (code === 0 && signal === null
        && stdout === ASYNC_PIPE_CAPABILITY_MARKER && stderr === '') {
        resolvePromise(Object.freeze({ available: true, reason: null }))
        return
      }
      if (code === 0 && signal === null && stdout === '' && stderr === '') {
        resolvePromise(Object.freeze({ available: false, reason: 'marker-loss' }))
        return
      }
      rejectPromise(new Error(
        `Nested async-pipe capability probe failed unexpectedly: code=${code}, signal=${signal}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)}.`,
      ))
    }))
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(new Error('Nested async-pipe capability probe timed out.'))
    }, 5_000)
    timer.unref()
    child.stdin.end(ASYNC_PIPE_CAPABILITY_MARKER)
  })
}

function getExactAsyncPipeCapability() {
  asyncPipeCapabilityPromise ??= probeExactAsyncPipeCapability()
  return asyncPipeCapabilityPromise
}

async function requireExactAsyncPipeCapability(t) {
  const capability = await getExactAsyncPipeCapability()
  if (capability.available) return true
  t.skip(`Nested asynchronous Node pipe transport is unavailable on this test host (${capability.reason}).`)
  return false
}

const fakeExtractorProof = (extractor) => {
  const base = {
    source: structuredClone(extractor.source),
    sha256: extractor.sha256,
    size: extractor.size,
    mode: extractor.mode,
    execution: extractor.execution,
    dev: '1',
    ino: '1',
  }
  const identity = {
    dev: '1', ino: '1', size: extractor.size, mode: extractor.mode,
    mtimeNs: '1', ctimeNs: '1',
  }
  return extractor.execution === 'in-process-portable-zip-v1'
    ? { ...base, modeAuthority: 'posix', preParse: identity, postParse: { ...identity } }
    : {
        ...base,
        preSpawn: { dev: '1', ino: '1', size: extractor.size, mtimeNs: '1', ctimeNs: '1' },
        postSpawn: { dev: '1', ino: '1', size: extractor.size, mtimeNs: '1', ctimeNs: '1' },
      }
}

const EXPECTED_CONFIGURE = [
  '--disable-autodetect',
  '--disable-debug',
  '--disable-doc',
  '--disable-everything',
  '--disable-gpl',
  '--disable-network',
  '--disable-nonfree',
  '--disable-programs',
  '--disable-static',
  '--disable-version3',
  '--enable-decoder=pcm_s16le,png',
  '--enable-demuxer=image2pipe,pcm_s16le',
  '--enable-encoder=libopus,libvpx_vp9',
  '--enable-ffmpeg',
  '--enable-filter=aformat,aresample,format,interleave,scale,setpts,settb',
  '--enable-libopus',
  '--enable-libvpx',
  '--enable-muxer=webm',
  '--enable-parser=png',
  '--enable-pic',
  '--enable-protocol=fd,pipe',
  '--enable-shared',
  '--enable-zlib',
]

test('FFmpeg buildconf recognizes only complete shell-quoted comma lists', () => {
  const native = EXPECTED_CONFIGURE.map((flag) => {
    const [name, value] = flag.split('=', 2)
    return value?.includes(',') ? `${name}='${value}'` : flag
  })
  const quotedExtras = [
    "--extra-cflags='-O2 -g0 --enable-encoder=forged'",
    "--extra-ldflags='-L/native/prefix/lib '",
  ]
  const configure = [...quotedExtras, ...native].join(' ')
  assert.doesNotThrow(() => assertWorldFfmpegConfiguration(configure, EXPECTED_CONFIGURE))
  for (const altered of [
    native.filter((flag) => !flag.startsWith('--enable-encoder=')),
    [...native, "--enable-encoder='libopus,libvpx_vp9'"],
    native.map((flag) => flag === "--enable-encoder='libopus,libvpx_vp9'" ? "--enable-encoder='libopus,libvpx_vp9_extra'" : flag),
    native.map((flag) => flag === "--enable-encoder='libopus,libvpx_vp9'" ? "--enable-encoder='libopus,libvpx_vp9,other'" : flag),
    native.map((flag) => flag === "--enable-encoder='libopus,libvpx_vp9'" ? "--enable-encoder='libopus, libvpx_vp9'" : flag),
    native.map((flag) => flag === "--enable-encoder='libopus,libvpx_vp9'" ? '--enable-encoder="libopus,libvpx_vp9"' : flag),
    native.map((flag) => flag === "--enable-encoder='libopus,libvpx_vp9'" ? "--enable-encoder=lib'opus,libvpx_vp9'" : flag),
    native.map((flag) => flag === "--enable-encoder='libopus,libvpx_vp9'" ? "--enable-encoder='libopus,libvpx_vp9" : flag),
    [...native, '--enable-gpl'],
  ]) {
    assert.throws(() => assertWorldFfmpegConfiguration([...quotedExtras, ...altered].join(' '), EXPECTED_CONFIGURE), /World FFmpeg probe configuration/)
  }
  const hidden = [...native].filter((flag) => !flag.startsWith('--enable-encoder='))
  assert.throws(() => assertWorldFfmpegConfiguration(["--extra-cflags='-O2 --enable-encoder=libopus,libvpx_vp9'", ...hidden].join(' '), EXPECTED_CONFIGURE), /missing an exact required flag/)
})

test('FFmpeg 7.1.1 configure token pcm_s16le is distinct from runtime s16le', async () => {
  const contract = await loadWorldFfmpegSupplyChain()
  assert.ok(contract.ffmpegConfigure.includes('--enable-demuxer=image2pipe,pcm_s16le'))
  assert.deepEqual(contract.build.demuxers, ['image2pipe', 's16le'])
  const wrong = EXPECTED_CONFIGURE.map((flag) => flag.replace('image2pipe,pcm_s16le', 'image2pipe,s16le'))
  assert.throws(() => assertWorldFfmpegConfiguration(wrong.join(' '), EXPECTED_CONFIGURE), /missing an exact required flag/)
})

test('FFmpeg 7.1.1 forced filters are an exact effective runtime closure', async () => {
  const contract = await loadWorldFfmpegSupplyChain()
  const expected = ['aformat', 'anull', 'aresample', 'atrim', 'crop', 'format', 'hflip', 'interleave', 'null', 'rotate', 'scale', 'setpts', 'settb', 'transpose', 'trim', 'vflip', 'abuffer', 'buffer', 'abuffersink', 'buffersink']
  assert.deepEqual(contract.build.filters, expected)
  const listing = `Filters:\n${expected.map((name) => ` ... ${name} A->A description`).join('\n')}\n`
  assert.doesNotThrow(() => assertWorldFfmpegRuntimeComponentClosure(parseWorldFfmpegComponentTable(listing, 'filters'), contract.build, 'filters'))
  for (const actual of [expected.slice(1), [...expected, 'sneaky'], expected.map((name) => name === 'rotate' ? 'rotated' : name)]) {
    assert.throws(() => assertWorldFfmpegRuntimeComponentClosure(actual, contract.build, 'filters'), /exact audited closure/)
  }
})

test('FFmpeg generated parser closure is exact, not fake parser CLI success', () => {
  assert.deepEqual(assertWorldFfmpegGeneratedParserList('static const AVCodecParser * const parser_list[] = {\n    &ff_png_parser,\n    NULL };\n'), ['png'])
  for (const text of [
    'static const AVCodecParser * const parser_list[] = {\n    NULL };\n',
    'static const AVCodecParser * const parser_list[] = {\n    &ff_png_parser,\n    &ff_h264_parser,\n    NULL };\n',
    'static const AVCodecParser * const parser_list[] = {\n    &ff_png_parser,\n    &ff_png_parser,\n    NULL };\n',
    'png',
  ]) assert.throws(() => assertWorldFfmpegGeneratedParserList(text), /parser closure/)
})

test('pre-sign probe binds exact native parser library and ignores unsupported ffmpeg -parsers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-ffmpeg-parser-probe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = await loadWorldFfmpegSupplyChain()
  const binary = join(root, 'ffmpeg')
  const library = join(root, 'libavcodec.so.61')
  const parserInspector = join(root, 'parser-inspector')
  const parserList = join(root, 'parser_list.c')
  await writeFile(library, 'bounded fake staged library')
  await writeFile(parserList, 'static const AVCodecParser * const parser_list[] = {\n    &ff_png_parser,\n    NULL };\n')
  const tables = {
    '-encoders': `Encoders:\n A....D libopus Opus\n V....D libvpx-vp9 VP9\n`,
    '-decoders': `Decoders:\n A....D pcm_s16le PCM\n V....D png PNG\n`,
    '-demuxers': `Demuxers:\n D  image2pipe Image\n D  s16le PCM\n`,
    '-filters': `Filters:\n${contract.build.filters.map((name) => ` ... ${name} A->A filter`).join('\n')}\n`,
    '-muxers': `Muxers:\n E  webm WebM\n`,
    '-protocols': `Supported file protocols:\nInput:\n  fd\n  pipe\nOutput:\n  fd\n  pipe\n`,
  }
  const commands = []
  let parserResult = 'png\n'
  let listings = { ...tables }
  const runTool = async (path, args) => {
    commands.push(args.at(-1))
    if (path === parserInspector) {
      assert.deepEqual(args, [library])
      return { stdout: parserResult, stderr: '' }
    }
    assert.equal(path, binary)
    const command = args.at(-1)
    if (command === '-version') return { stdout: `ffmpeg version 7.1.1\nconfiguration: ${contract.ffmpegConfigure.join(' ')}\n`, stderr: '' }
    if (command === '-parsers') throw new Error('ffmpeg 7.1.1 does not support -parsers')
    if (!Object.hasOwn(listings, command)) throw new Error(`Unknown FFmpeg probe: ${command}`)
    return { stdout: listings[command], stderr: '' }
  }
  const options = { supplyChain: contract, target: 'linux-arm64', parserInspectorPath: parserInspector, parserListPath: parserList, runTool }
  assert.deepEqual((await probeWorldFfmpegBinary(binary, options)).build, contract.build)
  assert.equal(commands.includes('-parsers'), false)
  listings = { ...tables, '-demuxers': 'Demuxers:\n D  image2pipe Image\n' }
  await assert.rejects(probeWorldFfmpegBinary(binary, options), /demuxers do not match/)
  listings = { ...tables, '-filters': `${tables['-filters']} ... undeclared A->A filter\n` }
  await assert.rejects(probeWorldFfmpegBinary(binary, options), /filters do not match/)
  listings = { ...tables }
  parserResult = 'png\nh264\n'
  await assert.rejects(probeWorldFfmpegBinary(binary, options), /parsers do not match/)
  parserResult = 'png\n'
  await rm(library)
  await assert.rejects(probeWorldFfmpegBinary(binary, options), /ENOENT|parser audit input/)
})

async function publishFakePackageRunnerSuccess(options, label = 'fixture') {
  const environment = options.env
  const outputDirectory = environment.WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY
  const outputInfo = await lstat(outputDirectory, { bigint: true })
  const cacheInfo = await lstat(environment.ELECTRON_BUILDER_CACHE, { bigint: true })
  const suffix = environment.WORLD_FFMPEG_PACKAGE_TARGET === 'linux-x64'
    ? '.AppImage'
    : environment.WORLD_FFMPEG_PACKAGE_TARGET === 'darwin-arm64' ? '.dmg' : '.zip'
  const artifactName = `Modly-${label}${suffix}`
  await writeFile(join(outputDirectory, artifactName), `artifact:${label}`)
  const reportRoot = join(outputDirectory, 'linux-unpacked', 'resources', 'world-ffmpeg-build-reports')
  await mkdir(reportRoot, { recursive: true })
  await writeFile(join(reportRoot, `${environment.WORLD_FFMPEG_PACKAGE_TARGET}.json`), `${JSON.stringify({
    fixture: label,
    target: environment.WORLD_FFMPEG_PACKAGE_TARGET,
  })}\n`)
  await writeFile(environment.WORLD_FFMPEG_PACKAGE_RUNNER_TERMINAL, `${JSON.stringify({
    schema: 'modly.electron-builder-package-runner-terminal.v1',
    attemptId: environment.WORLD_FFMPEG_PACKAGE_ATTEMPT_ID,
    target: environment.WORLD_FFMPEG_PACKAGE_TARGET,
    runnerIdentity: createHash('sha256').update(`runner:${label}`).digest('hex').slice(0, 32),
    runnerPid: process.pid,
    processStartIdentity: 'unavailable',
    cacheIdentity: { dev: String(cacheInfo.dev), ino: String(cacheInfo.ino) },
    outputIdentity: { dev: String(outputInfo.dev), ino: String(outputInfo.ino) },
    status: 'succeeded',
    artifacts: [artifactName],
  })}\n`)
}

function approveFakePackageVerification(request) {
  return Object.freeze({
    ok: true,
    buildReportReceipt: request.buildReportReceipt,
    runtimeManifestSha256: 'a'.repeat(64),
  })
}

async function approveFakeArtifactInspection(request) {
  const suffix = request.target === 'linux-x64' ? '.AppImage' : request.target === 'darwin-arm64' ? '.dmg' : '.zip'
  const artifactName = request.artifacts.filter((name) => name.endsWith(suffix))[0]
  const receipt = await request.outputCustody({
    operation: 'hash',
    directory: request.outputDirectory,
    expectedDirectoryIdentity: request.outputIdentity,
    name: artifactName,
    maximumBytes: 16 * 1024 * 1024 * 1024,
  })
  return Object.freeze({
    schema: 'modly.world-ffmpeg-artifact-inspection.v1',
    target: request.target,
    artifact: {
      path: receipt.file.name,
      dev: receipt.file.dev,
      ino: receipt.file.ino,
      size: receipt.file.size,
      sha256: receipt.file.sha256,
    },
    runtimeManifestSha256: request.expectedRuntimeManifestSha256,
    buildReportSha256: request.buildReportReceipt.sha256,
    extractor: fakeExtractorProof(request.extractor),
  })
}

test('pins the complete offline FFmpeg 7.1.1 source and minimal LGPL build contract', async () => {
  const contract = await loadWorldFfmpegSupplyChain()

  assert.equal(contract.schema, 'modly.world-ffmpeg-supply-chain.v1')
  assert.equal(contract.ffmpegVersion, '7.1.1')
  assert.deepEqual(contract.targets, ['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'])
  assert.deepEqual(contract.reproducibility, {
    claim: 'unverified-until-two-independent-builds-match',
    requiredMatchingBuilds: 2,
    sourceDateEpoch: 1740961320,
  })
  assert.deepEqual(contract.sources.map(({ name, version, archive, sha256 }) => ({
    name, version, archive, sha256,
  })), [
    {
      name: 'ffmpeg', version: '7.1.1', archive: 'ffmpeg-7.1.1.tar.xz',
      sha256: '733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1',
    },
    {
      name: 'libvpx', version: '1.15.2', archive: 'libvpx-1.15.2.tar.gz',
      sha256: '26fcd3db88045dee380e581862a6ef106f49b74b6396ee95c2993a260b4636aa',
    },
    {
      name: 'opus', version: '1.5.2', archive: 'opus-1.5.2.tar.gz',
      sha256: '65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1',
    },
    {
      name: 'zlib', version: '1.3.2', archive: 'zlib-1.3.2.tar.gz',
      sha256: 'bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16',
    },
  ])
  assert.deepEqual(contract.ffmpegConfigure, EXPECTED_CONFIGURE)
  assert.equal(contract.ffmpegReleaseSignature?.fingerprint, 'FCF986EA15E6E293A5644F10B4322F04D67658D8')
  assert.equal(contract.build.license, 'LGPL-2.1-or-later')
  assert.equal(contract.build.linkage, 'shared')
  assert.equal(contract.build.gpl, false)
  assert.equal(contract.build.nonfree, false)
  assert.equal(contract.build.version3, false)
  assert.deepEqual(contract.build.videoEncoders, ['libvpx-vp9'])
  assert.deepEqual(contract.build.audioEncoders, ['libopus'])
  assert.deepEqual(contract.build.decoders, ['pcm_s16le', 'png'])
  assert.deepEqual(contract.build.demuxers, ['image2pipe', 's16le'])
  assert.deepEqual(contract.build.filters, ['aformat', 'anull', 'aresample', 'atrim', 'crop', 'format', 'hflip', 'interleave', 'null', 'rotate', 'scale', 'setpts', 'settb', 'transpose', 'trim', 'vflip', 'abuffer', 'buffer', 'abuffersink', 'buffersink'])
  assert.deepEqual(contract.build.muxers, ['webm'])
  assert.deepEqual(contract.build.parsers, ['png'])
  assert.deepEqual(contract.build.protocols, ['fd', 'pipe'])
  assert.equal(contract.ffmpegConfigure.some((value) => /^--enable-(?:gpl|nonfree|version3)$/.test(value)), false)
})

test('native build passes the canonical lock path as data rather than interpolated JavaScript', async () => {
  const source = await readFile(new URL('./build-world-ffmpeg-runtime.sh', import.meta.url), 'utf8')
  const archive = await readFile(new URL('./create-world-ffmpeg-source-archive.sh', import.meta.url), 'utf8')
  assert.match(source, /world-ffmpeg-parser-inspector\.c/)
  assert.match(archive, /world-ffmpeg-parser-inspector\.c/)
  assert.doesNotMatch(source, /require\(['"]\$REPOSITORY_ROOT/)
  assert.match(source, /process\.argv\[2\]/)
  const arSelection = source.match(/if \[\[ "\$TARGET" == 'darwin-arm64' \]\]; then\n([\s\S]*?)\nelse\n([\s\S]*?)\nfi/)
  assert.ok(arSelection)
  assert.match(arSelection[1], /\/usr\/bin\/xcrun --find ar/)
  assert.doesNotMatch(arSelection[1], /command -v ["']?\$\{AR/)
  assert.match(arSelection[2], /command -v ["']?\$\{AR/)
})

test('Linux linker authority preserves literal $ORIGIN through the real shell and ELF linker', async (t) => {
  if (process.platform !== 'linux') return t.skip('ELF linker proof runs on the Linux tuple gate.')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-origin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const linkerAuthority = new URL('./world-ffmpeg-linker-environment.sh', import.meta.url)
  const { stdout: authorityStdout } = await execFileAsync('bash', [
    '-c',
    'source "$1"; world_ffmpeg_set_linker_environment linux-x64; printf "%s\\n%s\\n" "$RUNTIME_RPATH" "${LD_RUN_PATH-}"',
    'world-ffmpeg-linker-test',
    linkerAuthority.pathname,
  ], { encoding: 'utf8', timeout: 10_000 })
  const authority = authorityStdout.split('\n')
  assert.deepEqual(authority.slice(0, 2), ['$ORIGIN', '$ORIGIN'])

  await writeFile(join(root, 'library.c'), 'int world_ffmpeg_symbol(void) { return 7; }\n')
  await writeFile(join(root, 'main.c'), 'int main(void) { return 0; }\n')
  const env = { ...process.env, LD_RUN_PATH: authority[1], LC_ALL: 'C', LANG: 'C' }
  const binaries = [
    'libz.so.1', 'libopus.so.0', 'libvpx.so.11', 'libavcodec.so.61',
  ]
  for (const name of binaries) {
    await execFileAsync('cc', ['-fPIC', '-shared', 'library.c', `-Wl,-soname,${name}`, '-o', name], {
      cwd: root, env, timeout: 10_000,
    })
  }
  await execFileAsync('cc', ['main.c', '-o', 'ffmpeg'], { cwd: root, env, timeout: 10_000 })
  for (const name of [...binaries, 'ffmpeg']) {
    const { stdout: dynamic } = await execFileAsync('readelf', ['-dW', join(root, name)], {
      cwd: root, env: { LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 10_000,
    })
    assert.match(dynamic, /\((?:RUNPATH|RPATH)\)[^\n]*\[\$ORIGIN\]/)
    assert.doesNotMatch(dynamic, /\[(?:RIGIN|\\\$ORIGIN)\]/)
  }
})

test('maps only the four package tuples and rejects every adjacent architecture', () => {
  assert.equal(worldFfmpegTargetFor('linux', 'x64'), 'linux-x64')
  assert.equal(worldFfmpegTargetFor('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(worldFfmpegTargetFor('win32', 'x64'), 'win32-x64')
  assert.equal(worldFfmpegTargetFor('linux', 'arm64'), 'linux-arm64')
  assert.equal(worldFfmpegTargetFor('darwin', 'x64'), null)
  assert.equal(worldFfmpegTargetFor('win32', 'arm64'), null)
  assert.equal(worldFfmpegTargetFor('freebsd', 'x64'), null)
})

test('electron-builder hook verifies the requested tuple before packaging and rejects unsupported targets', async () => {
  const {
    beforePackWith,
    electronBuilderTargetFor,
  } = require('./world-ffmpeg-before-pack.cjs')
  assert.equal(electronBuilderTargetFor('linux', 1), 'linux-x64')
  assert.equal(electronBuilderTargetFor('darwin', 3), 'darwin-arm64')
  assert.equal(electronBuilderTargetFor('win32', 1), 'win32-x64')
  assert.equal(electronBuilderTargetFor('linux', 3), 'linux-arm64')

  const calls = []
  await beforePackWith({ electronPlatformName: 'linux', arch: 1 }, {
    verify: async (request) => { calls.push(request); return { ok: true } },
  })
  assert.deepEqual(calls, [{ platform: 'linux', arch: 'x64' }])
  await assert.rejects(
    beforePackWith({ electronPlatformName: 'darwin', arch: 1 }, { verify: async () => ({ ok: true }) }),
    /Unsupported FFmpeg package target/,
  )
  await assert.rejects(
    beforePackWith({ electronPlatformName: 'linux', arch: 1 }, {
      verify: async () => ({ ok: false, code: 'bundle-missing' }),
    }),
    /Audited FFmpeg package verification failed: bundle-missing/,
  )
})

test('package hooks spawn the verifier through the exact deny-network Node authority', async () => {
  const { runVerifierWith } = require('./world-ffmpeg-before-pack.cjs')
  const { assertWorldFfmpegPackageVerifierAuthority } = await import('./verify-world-ffmpeg-package.ts')
  const calls = []
  class FakeVerifier extends EventEmitter {
    constructor() {
      super()
      this.stderr = new EventEmitter()
    }

    kill() { return true }
  }
  const child = new FakeVerifier()
  const verification = runVerifierWith({
    platform: 'linux', arch: 'x64', trustFile: '/audited/trust.json',
  }, {
    sourceEnvironment: {
      NODE_OPTIONS: '--require=/attacker/preload.cjs',
      NODE_PATH: '/attacker/modules',
      BASH_ENV: '/attacker/bash-env',
      ELECTRON_BUILDER_7ZIP_PATH: '/attacker/7za',
      PATH: '/attacker/bin',
    },
    spawnProcess: (file, args, options) => {
      calls.push({ file, args, options })
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    },
  })
  assert.deepEqual(await verification, { ok: true })
  assert.equal(calls.length, 1)
  const [{ file, args, options }] = calls
  const denyNetwork = fileURLToPath(new URL('./world-ffmpeg-deny-network.cjs', import.meta.url))
  assert.equal(file, process.execPath)
  assert.deepEqual(args.slice(0, 3), [
    `--require=${denyNetwork}`, '--no-warnings', '--experimental-strip-types',
  ])
  assert.deepEqual(options.env, {
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin',
    NODE_OPTIONS: `--require=${denyNetwork}`,
    WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE: process.execPath,
    WORLD_FFMPEG_PACKAGE_NETWORK: 'denied',
    WORLD_FFMPEG_VERIFIER_AUTHORITY: 'modly.world-ffmpeg-verifier.v1',
  })
  assert.equal(options.shell, false)
  assert.equal(options.detached, false)
  assert.doesNotThrow(() => assertWorldFfmpegPackageVerifierAuthority(
    args.slice(0, 3), options.env, {
      platform: 'linux', arch: 'x64', execPath: process.execPath, electronVersion: '44.1.1',
    },
  ))
  for (const attack of [
    ['--require=/attacker/preload.cjs', ...args.slice(0, 3)],
    [...args.slice(0, 3), '--import=/attacker/module.mjs'],
    ['--loader=/attacker/loader.mjs', ...args.slice(1, 3)],
    ['--inspect=0.0.0.0:9229', ...args.slice(0, 3)],
    ['--experimental-policy=/attacker/policy.json', ...args.slice(0, 3)],
  ]) {
    assert.throws(
      () => assertWorldFfmpegPackageVerifierAuthority(attack, options.env, {
        platform: 'linux', arch: 'x64', execPath: process.execPath, electronVersion: '44.1.1',
      }),
      /Node authority|execArgv|verifier/i,
    )
  }
  assert.throws(
    () => assertWorldFfmpegPackageVerifierAuthority(args.slice(0, 3), {
      ...options.env, NODE_PATH: '/attacker/modules',
    }, { platform: 'linux', arch: 'x64', execPath: process.execPath, electronVersion: '44.1.1' }),
    /environment|verifier/i,
  )

  const windowsEnvironment = Object.fromEntries(Object.entries({
    ...options.env,
    PATH: 'C:\\Windows\\System32;C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: 'C:\\Windows',
    WINDIR: 'c:\\WINDOWS',
    WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
  }).map(([key, value]) => [key.toLowerCase(), value]))
  assert.doesNotThrow(() => assertWorldFfmpegPackageVerifierAuthority(
    args.slice(0, 3), windowsEnvironment, {
      platform: 'win32', arch: 'x64',
      execPath: 'c:\\REPO\\node_modules\\electron\\dist\\electron.exe',
      electronVersion: '44.1.1',
    },
  ))
  assert.throws(() => assertWorldFfmpegPackageVerifierAuthority(
    args.slice(0, 3), { ...windowsEnvironment, SYSTEMROOT: 'C:\\Windows' }, {
      platform: 'win32', arch: 'x64',
      execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
      electronVersion: '44.1.1',
    },
  ), /duplicate|environment/i)
})

test('package verifier returns only the exact opened build-report snapshot receipt', async () => {
  const { runVerifierWith } = require('./world-ffmpeg-before-pack.cjs')
  const receipt = {
    name: 'WORLD_FFMPEG_BUILD_REPORT.v1.json',
    dev: '101', ino: '202', size: 37, sha256: 'a'.repeat(64),
  }
  const request = {
    platform: 'linux', arch: 'x64', trustFile: '/audited/trust.json',
    resourcesPath: '/audited/output/linux-unpacked/resources',
    resourcesIdentity: { dev: '303', ino: '404' },
    buildReportDirectory: '/audited/output',
    buildReportDirectoryIdentity: { dev: '505', ino: '606' },
    buildReportName: receipt.name,
    buildReportReceipt: receipt,
  }
  const calls = []
  const runtimeManifestSha256 = 'c'.repeat(64)
  const invoke = (returnedReceipt) => runVerifierWith(request, {
    sourceEnvironment: {},
    spawnProcess(file, args, options) {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => true
      calls.push({ file, args, options })
      queueMicrotask(() => {
        child.stdout.emit('data', `${JSON.stringify({
          schema: 'modly.world-ffmpeg-verifier-receipt.v1',
          buildReportReceipt: returnedReceipt,
          runtimeManifestSha256,
        })}\n`)
        child.emit('close', 0, null)
      })
      return child
    },
  })
  assert.deepEqual(await invoke(receipt), {
    ok: true, buildReportReceipt: receipt, runtimeManifestSha256,
  })
  assert.equal(calls[0].options.cwd, request.resourcesPath)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  for (const name of [
    '--resources-identity', '--build-report-directory',
    '--build-report-directory-identity', '--build-report-name', '--build-report-receipt',
  ]) assert.equal(calls[0].args.includes(name), true)

  const verifierObservedB = { ...receipt, sha256: 'b'.repeat(64) }
  assert.deepEqual(await invoke(verifierObservedB), {
    ok: false, code: 'verifier-receipt-invalid',
  })
})

test('source-cache verification is closed, bounded, hash-pinned, and never fetches implicitly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-sources-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = await loadWorldFfmpegSupplyChain()

  assert.deepEqual(await verifyWorldFfmpegSourceCache(root, contract), {
    ok: false, code: 'source-missing', source: 'ffmpeg',
  })
  for (const source of contract.sources) await writeFile(join(root, source.archive), source.name)
  assert.deepEqual(await verifyWorldFfmpegSourceCache(root, contract), {
    ok: false, code: 'source-invalid', source: 'ffmpeg',
  })
  await writeFile(join(root, 'undeclared.tar.gz'), 'unexpected')
  assert.deepEqual(await verifyWorldFfmpegSourceCache(root, contract), {
    ok: false, code: 'source-tree-invalid', source: null,
  })
})

test('explicit source fetch is HTTPS-only, no-redirect, bounded, atomic, and hash checked', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-fetch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = await loadWorldFfmpegSupplyChain()
  const payloads = new Map()
  const contract = structuredClone(original)
  for (const source of contract.sources) {
    const bytes = Buffer.from(`source:${source.name}`)
    payloads.set(source.url, bytes)
    source.sha256 = createHash('sha256').update(bytes).digest('hex')
    source.maximumBytes = 1024
  }
  for (const [url, bytes] of [
    [contract.ffmpegReleaseSignature.url, Buffer.from('signature')],
    [contract.ffmpegReleaseSignature.keyUrl, Buffer.from('release-key')],
  ]) payloads.set(url, bytes)
  const requests = []
  await fetchWorldFfmpegSources({
    destination: root,
    contract,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      const bytes = payloads.get(String(url))
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
    },
  })
  assert.equal(requests.length, 6)
  assert.ok(requests.every(({ init }) => init.method === 'GET' && init.redirect === 'error'))
  assert.deepEqual((await readdir(root)).sort(), [
    'ffmpeg-7.1.1.tar.xz', 'ffmpeg-7.1.1.tar.xz.asc', 'ffmpeg-devel.asc',
    'libvpx-1.15.2.tar.gz', 'opus-1.5.2.tar.gz', 'zlib-1.3.2.tar.gz',
  ])
  await writeFile(join(root, 'undeclared.partial'), 'attack')
  await assert.rejects(fetchWorldFfmpegSources({ destination: root, contract, fetchImpl: async () => { throw new Error('must not fetch') } }), /undeclared entry/)
})

test('explicit source fetch bounds noncooperative request and body stalls', async (t) => {
  const contract = structuredClone(await loadWorldFfmpegSupplyChain())
  const requestRoot = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-fetch-request-timeout-'))
  const bodyRoot = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-fetch-body-timeout-'))
  t.after(() => Promise.all([
    rm(requestRoot, { recursive: true, force: true }),
    rm(bodyRoot, { recursive: true, force: true }),
  ]))

  await assert.rejects(fetchWorldFfmpegSources({
    destination: requestRoot,
    contract,
    requestTimeoutMs: 10,
    downloadTimeoutMs: 20,
    inactivityTimeoutMs: 10,
    fetchImpl: () => new Promise(() => {}),
  }), /request timed out/)

  const stalledBody = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
        return: async () => ({ done: true, value: undefined }),
      }
    },
  }
  await assert.rejects(fetchWorldFfmpegSources({
    destination: bodyRoot,
    contract,
    requestTimeoutMs: 20,
    downloadTimeoutMs: 20,
    inactivityTimeoutMs: 10,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      body: stalledBody,
    }),
  }), /body (?:became inactive|timed out)/)
  assert.deepEqual(await readdir(requestRoot), [])
  assert.deepEqual(await readdir(bodyRoot), [])
})

test('source verifier checks the exact release-key fingerprint and detached signature without network options', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-signature-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegSupplyChain())
  for (const source of contract.sources) {
    const bytes = Buffer.from(source.name)
    source.sha256 = createHash('sha256').update(bytes).digest('hex')
    source.maximumBytes = 1024
    await writeFile(join(root, source.archive), bytes)
  }
  await writeFile(join(root, contract.ffmpegReleaseSignature.archive), 'signature')
  await writeFile(join(root, contract.ffmpegReleaseSignature.keyArchive), 'release-key')
  const calls = []
  const runTool = async (file, args) => {
    calls.push({ file, args })
    if (args.includes('--fingerprint')) {
      return { stdout: `fpr:::::::::${contract.ffmpegReleaseSignature.fingerprint}:\n`, stderr: '' }
    }
    if (file.endsWith('/gpgv')) {
      return { stdout: `[GNUPG:] VALIDSIG ${contract.ffmpegReleaseSignature.fingerprint} 0 0 0 0 0 0 0 0 ${contract.ffmpegReleaseSignature.fingerprint}\n`, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  assert.deepEqual(await verifyWorldFfmpegSources({
    cache: root, gpg: '/audit/bin/gpg', gpgv: '/audit/bin/gpgv', contract, runTool,
  }), { ok: true, fingerprint: contract.ffmpegReleaseSignature.fingerprint })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map(({ file }) => file), ['/audit/bin/gpg', '/audit/bin/gpg', '/audit/bin/gpgv'])
  assert.equal(calls.flatMap(({ args }) => args).some((value) => /keyserver|auto-key-retrieve=true/.test(value)), false)
  assert.ok(calls[2].args.includes(join(root, 'ffmpeg-7.1.1.tar.xz')))
})

test('distribution notices and license/source offer files are exact hash-bound inputs', async (t) => {
  const contract = await loadWorldFfmpegSupplyChain()
  assert.deepEqual(await verifyWorldFfmpegDistributionFiles(contract), { ok: true })

  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-notices-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const entry of contract.distributionFiles) {
    const source = new URL(`../${entry.path}`, import.meta.url)
    const destination = join(root, entry.path)
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, await readFile(source))
  }
  await writeFile(join(root, contract.distributionFiles[0].path), 'tampered')
  assert.deepEqual(await verifyWorldFfmpegDistributionFiles(contract, root), {
    ok: false, code: 'distribution-file-invalid',
    path: contract.distributionFiles[0].path,
  })
})

test('post-package audit verifies exact emitted notices and license directory closure', async (t) => {
  const contract = await loadWorldFfmpegSupplyChain()
  const resources = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-packaged-notices-'))
  t.after(() => rm(resources, { recursive: true, force: true }))
  const licenseRoot = join(resources, 'licenses', 'world-ffmpeg-7.1.1')
  await mkdir(licenseRoot, { recursive: true })
  for (const entry of contract.distributionFiles) {
    const source = new URL(`../${entry.path}`, import.meta.url)
    const destination = entry.path === 'THIRD_PARTY_NOTICES.md'
      ? join(resources, entry.path)
      : join(licenseRoot, entry.path.split('/').at(-1))
    await copyFile(source, destination)
  }
  assert.deepEqual(await verifyWorldFfmpegPackagedDistributionFiles(contract, resources), { ok: true })
  await writeFile(join(licenseRoot, 'undeclared.txt'), 'not in the release contract')
  assert.deepEqual(await verifyWorldFfmpegPackagedDistributionFiles(contract, resources), {
    ok: false, code: 'distribution-tree-invalid', path: 'licenses/world-ffmpeg-7.1.1',
  })
})

test('assembles a canonical signed runtime only after exact probe and dynamic-closure audit', async (t) => {
  const resources = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-bundle-'))
  t.after(() => rm(resources, { recursive: true, force: true }))
  const root = join(resources, 'ffmpeg', 'linux-x64')
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true, mode: 0o755 })
  await writeFile(join(root, 'LICENSE.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE\nFFmpeg 7.1.1\nlibvpx 1.15.2\nlibopus 1.5.2\nzlib 1.3.2\n')
  await writeFile(join(bin, 'ffmpeg'), 'native executable')
  await writeFile(join(bin, 'libavcodec.so.61'), 'avcodec')
  await writeFile(join(bin, 'libopus.so.0'), 'opus')
  await writeFile(join(bin, 'libvpx.so.11'), 'vpx')
  await chmod(root, 0o755); await chmod(bin, 0o755); await chmod(join(root, 'LICENSE.txt'), 0o644)
  await chmod(join(bin, 'ffmpeg'), 0o755)
  for (const name of ['libavcodec.so.61', 'libopus.so.0', 'libvpx.so.11']) await chmod(join(bin, name), 0o644)

  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const contract = await loadWorldFfmpegSupplyChain()
  const result = await assembleWorldFfmpegRuntime({
    bundleRoot: root,
    target: 'linux-x64',
    supplyChain: contract,
    signingKeyId: 'modly-test-release-2026',
    privateKey: keys.privateKey,
    trustedManifestKeys: { 'modly-test-release-2026': publicKey },
    probe: async () => ({
      ffmpegVersion: '7.1.1',
      configuration: contract.ffmpegConfigure,
      build: contract.build,
    }),
    inspectBinary: async (path) => {
      const name = path.split('/').at(-1)
      return name === 'ffmpeg'
        ? {
            bundledDependencies: ['libavcodec.so.61', 'libopus.so.0', 'libvpx.so.11'],
            systemDependencies: ['ld-linux-x86-64.so.2', 'libc.so.6'],
            loaderSearch: ['$ORIGIN'],
            systemInterpreter: '/lib64/ld-linux-x86-64.so.2',
          }
        : { bundledDependencies: [], systemDependencies: ['libc.so.6'], loaderSearch: ['$ORIGIN'], systemInterpreter: null }
    },
  })
  assert.equal(result.ffmpegVersion, '7.1.1')
  assert.equal(result.target, 'linux-x64')
  assert.deepEqual((await readdir(root)).sort(), ['LICENSE.txt', 'bin', 'manifest.json', 'manifest.sig'])
  assert.equal((await readFile(join(root, 'manifest.sig'))).byteLength, 64)
  const manifestBytes = await readFile(join(root, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  assert.deepEqual(manifest.build, contract.build)
  assert.equal(manifest.ffmpegVersion, '7.1.1')
  assert.equal(manifest.signingKeyId, 'modly-test-release-2026')
  assert.deepEqual(manifest.sharedLibraries.map((entry) => entry.path), [
    'bin/libavcodec.so.61', 'bin/libopus.so.0', 'bin/libvpx.so.11',
  ])
  assert.deepEqual(manifestBytes, Buffer.from(`${JSON.stringify(manifest)}\n`))
})

test('assembles the Windows runtime with an exact null system-interpreter authority', async (t) => {
  const resources = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-windows-bundle-'))
  t.after(() => rm(resources, { recursive: true, force: true }))
  const root = join(resources, 'ffmpeg', 'win32-x64')
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(root, 'LICENSE.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE\nFFmpeg 7.1.1\nlibvpx 1.15.2\nlibopus 1.5.2\nzlib 1.3.2\n')
  await writeFile(join(bin, 'ffmpeg.exe'), 'windows executable')
  await writeFile(join(bin, 'avcodec-61.dll'), 'avcodec')

  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const contract = await loadWorldFfmpegSupplyChain()
  const manifest = await assembleWorldFfmpegRuntime({
    bundleRoot: root,
    target: 'win32-x64',
    supplyChain: contract,
    signingKeyId: 'windows-test-key',
    privateKey: keys.privateKey,
    trustedManifestKeys: { 'windows-test-key': publicKey },
    probe: async () => ({ ffmpegVersion: '7.1.1', configuration: contract.ffmpegConfigure, build: contract.build }),
    inspectBinary: async (path) => ({
      bundledDependencies: path.endsWith('ffmpeg.exe') ? ['avcodec-61.dll'] : [],
      systemDependencies: ['KERNEL32.dll'],
      loaderSearch: [],
      systemInterpreter: null,
    }),
  })
  assert.equal(manifest.target, 'win32-x64')
})

test('assembly rejects an untrusted signing key and an undeclared or unreachable shared library', async (t) => {
  async function candidate(suffix) {
    const resources = await mkdtemp(join(tmpdir(), `modly-ffmpeg-reject-${suffix}-`))
    const root = join(resources, 'ffmpeg', 'linux-x64')
    await mkdir(join(root, 'bin'), { recursive: true })
    await writeFile(join(root, 'LICENSE.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE\nFFmpeg 7.1.1\nlibvpx 1.15.2\nlibopus 1.5.2\nzlib 1.3.2\n')
    await writeFile(join(root, 'bin', 'ffmpeg'), 'ffmpeg')
    await writeFile(join(root, 'bin', 'liborphan.so.1'), 'orphan')
    await chmod(join(resources, 'ffmpeg'), 0o755); await chmod(root, 0o755); await chmod(join(root, 'bin'), 0o755)
    await chmod(join(root, 'LICENSE.txt'), 0o644); await chmod(join(root, 'bin', 'ffmpeg'), 0o755)
    await chmod(join(root, 'bin', 'liborphan.so.1'), 0o644)
    t.after(() => rm(resources, { recursive: true, force: true }))
    return root
  }
  const contract = await loadWorldFfmpegSupplyChain()
  const keys = generateKeyPairSync('ed25519')
  const validProbe = async () => ({ ffmpegVersion: '7.1.1', configuration: contract.ffmpegConfigure, build: contract.build })

  const untrusted = await candidate('key')
  await assert.rejects(assembleWorldFfmpegRuntime({
    bundleRoot: untrusted, target: 'linux-x64', supplyChain: contract,
    signingKeyId: 'unknown-key', privateKey: keys.privateKey, trustedManifestKeys: {},
    probe: validProbe,
    inspectBinary: async () => ({
      bundledDependencies: ['liborphan.so.1'], systemDependencies: ['libc.so.6'],
      loaderSearch: ['$ORIGIN'], systemInterpreter: null,
    }),
  }), /trusted release key/)
  assert.deepEqual((await readdir(untrusted)).sort(), ['LICENSE.txt', 'bin'])

  const orphan = await candidate('orphan')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  await assert.rejects(assembleWorldFfmpegRuntime({
    bundleRoot: orphan, target: 'linux-x64', supplyChain: contract,
    signingKeyId: 'test-key', privateKey: keys.privateKey, trustedManifestKeys: { 'test-key': publicKey },
    probe: validProbe,
    inspectBinary: async (path) => ({
      bundledDependencies: [],
      systemDependencies: path.endsWith('/ffmpeg') ? ['ld-linux-x86-64.so.2', 'libc.so.6'] : ['libc.so.6'],
      loaderSearch: ['$ORIGIN'],
      systemInterpreter: path.endsWith('/ffmpeg') ? '/lib64/ld-linux-x86-64.so.2' : null,
    }),
  }), /dynamic library closure/)
  assert.deepEqual((await readdir(orphan)).sort(), ['LICENSE.txt', 'bin'])
})

test('assembly never overwrites or retracts pre-existing manifest authorities', async (t) => {
  const resources = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-existing-manifest-'))
  t.after(() => rm(resources, { recursive: true, force: true }))
  const root = join(resources, 'ffmpeg', 'linux-x64')
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(root, 'LICENSE.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE\nFFmpeg 7.1.1\nlibvpx 1.15.2\nlibopus 1.5.2\nzlib 1.3.2\n')
  await writeFile(join(bin, 'ffmpeg'), 'ffmpeg')
  await writeFile(join(bin, 'libavcodec.so.61'), 'avcodec')
  await chmod(join(resources, 'ffmpeg'), 0o755); await chmod(root, 0o755); await chmod(bin, 0o755)
  await chmod(join(root, 'LICENSE.txt'), 0o644); await chmod(join(bin, 'ffmpeg'), 0o755)
  await chmod(join(bin, 'libavcodec.so.61'), 0o644)
  const priorManifest = Buffer.from('pre-existing-manifest')
  const priorSignature = Buffer.from('pre-existing-signature')
  await writeFile(join(root, 'manifest.json'), priorManifest)
  await writeFile(join(root, 'manifest.sig'), priorSignature)

  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const contract = await loadWorldFfmpegSupplyChain()
  await assert.rejects(assembleWorldFfmpegRuntime({
    bundleRoot: root, target: 'linux-x64', supplyChain: contract,
    signingKeyId: 'existing-test-key', privateKey: keys.privateKey,
    trustedManifestKeys: { 'existing-test-key': publicKey },
    probe: async () => ({ ffmpegVersion: '7.1.1', configuration: contract.ffmpegConfigure, build: contract.build }),
    inspectBinary: async () => { throw new Error('must not inspect a pre-published tree') },
  }), /undeclared entries/)
  assert.deepEqual(await readFile(join(root, 'manifest.json')), priorManifest)
  assert.deepEqual(await readFile(join(root, 'manifest.sig')), priorSignature)
})

test('native proof matrix covers exact rational tails and derives exact PCM authority', () => {
  assert.deepEqual(WORLD_FFMPEG_NATIVE_CASES.map((entry) => entry.id), [
    'aligned-100ms-at-30fps',
    'partial-115ms-at-30fps',
    'partial-1010ms-at-30fps',
    'one-frame-10ms-at-30fps',
  ])
  assert.deepEqual(WORLD_FFMPEG_NATIVE_CASES.map(worldFfmpegNativeCasePlan), [
    { fps: 30, frameCount: 3, audioSampleCount: 4_800, duration: { numerator: 1, denominator: 10 }, finalFrameDuration: { numerator: 1, denominator: 30 } },
    { fps: 30, frameCount: 4, audioSampleCount: 5_520, duration: { numerator: 23, denominator: 200 }, finalFrameDuration: { numerator: 3, denominator: 200 } },
    { fps: 30, frameCount: 31, audioSampleCount: 48_480, duration: { numerator: 101, denominator: 100 }, finalFrameDuration: { numerator: 1, denominator: 100 } },
    { fps: 30, frameCount: 1, audioSampleCount: 480, duration: { numerator: 1, denominator: 100 }, finalFrameDuration: { numerator: 1, denominator: 100 } },
  ])
})

test('parses the exact FFmpeg 7.1 component table shapes without accepting legend rows', () => {
  const encoders = `Encoders:\n V..... = Video\n ------\n A....D libopus libopus Opus (codec opus)\n V....D libvpx-vp9 libvpx VP9 (codec vp9)\n`
  assert.deepEqual(parseWorldFfmpegComponentTable(encoders, 'encoders'), ['libopus', 'libvpx-vp9'])
  for (const nearMatch of ['libvpx_vp9', 'libvpx-vp9-extra', 'libvpx-vp9x', 'libvpx-vp']) {
    assert.notDeepEqual(parseWorldFfmpegComponentTable(encoders.replace('libvpx-vp9 libvpx', `${nearMatch} libvpx`), 'encoders'), ['libopus', 'libvpx-vp9'])
  }
  assert.deepEqual(parseWorldFfmpegComponentTable(`Demuxers:\n D  = Demuxing supported\n --\n D  image2pipe piped image2 sequence\n D  s16le PCM signed 16-bit\n`, 'demuxers'), ['image2pipe', 's16le'])
  assert.deepEqual(parseWorldFfmpegComponentTable(`Filters:\n T.. = Timeline support\n ... aformat A->A\n ... aresample A->A\n ... format V->V\n ... interleave N->V\n ... scale V->V\n ... setpts V->V\n ... settb V->V\n`, 'filters'), ['aformat', 'aresample', 'format', 'interleave', 'scale', 'setpts', 'settb'])
  assert.deepEqual(parseWorldFfmpegComponentTable(`Parsers:\n  png\n`, 'parsers'), ['png'])
  assert.deepEqual(parseWorldFfmpegProtocols(`Supported file protocols:\nInput:\n  fd\n  pipe\nOutput:\n  fd\n  pipe\n`), ['fd', 'pipe'])
})

test('Linux binary audit binds the exact interpreter and rejects path-bearing DT_NEEDED entries', () => {
  assert.deepEqual(classifyWorldFfmpegDynamicReferences({
    dependencies: ['libavcodec.so.61', 'libc.so.6'],
    loaderSearch: ['$ORIGIN'],
    bundledNames: ['libavcodec.so.61'],
    target: 'linux-x64',
    systemInterpreter: '/lib64/ld-linux-x86-64.so.2',
  }), {
    bundledDependencies: ['libavcodec.so.61'],
    systemDependencies: ['ld-linux-x86-64.so.2', 'libc.so.6'],
    loaderSearch: ['$ORIGIN'],
    systemInterpreter: '/lib64/ld-linux-x86-64.so.2',
  })

  assert.throws(() => classifyWorldFfmpegDynamicReferences({
    dependencies: ['/tmp/libc.so.6'], loaderSearch: ['$ORIGIN'], bundledNames: [],
    target: 'linux-x64', systemInterpreter: '/lib64/ld-linux-x86-64.so.2',
  }), /unsafe loader identity/)
  assert.throws(() => classifyWorldFfmpegDynamicReferences({
    dependencies: ['libc.so.6'], loaderSearch: ['$ORIGIN'], bundledNames: [],
    target: 'linux-x64', systemInterpreter: '/tmp/ld-linux-x86-64.so.2',
  }), /interpreter/)
})

test('Darwin dyld remains the exact interpreter authority and is never reclassified as a dylib', async (t) => {
  const classified = classifyWorldFfmpegDynamicReferences({
    dependencies: ['@rpath/libavcodec.61.dylib', '/usr/lib/libSystem.B.dylib'],
    loaderSearch: ['@loader_path'],
    bundledNames: ['libavcodec.61.dylib'],
    target: 'darwin-arm64',
    systemInterpreter: '/usr/lib/dyld',
  })
  assert.deepEqual(classified, {
    bundledDependencies: ['libavcodec.61.dylib'],
    systemDependencies: ['/usr/lib/libSystem.B.dylib'],
    loaderSearch: ['@loader_path'],
    systemInterpreter: '/usr/lib/dyld',
  })
  assert.throws(() => classifyWorldFfmpegDynamicReferences({
    dependencies: ['/usr/lib/libSystem.B.dylib'], loaderSearch: ['@loader_path'], bundledNames: [],
    target: 'darwin-arm64', systemInterpreter: '/attacker/dyld',
  }), /interpreter/)
  assert.throws(() => classifyWorldFfmpegDynamicReferences({
    dependencies: ['/usr/lib/dyld'], loaderSearch: ['@loader_path'], bundledNames: [],
    target: 'darwin-arm64', systemInterpreter: '/usr/lib/dyld',
  }), /interpreter.*dependency|dependency.*interpreter/i)

  const resources = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-darwin-bundle-'))
  t.after(() => rm(resources, { recursive: true, force: true }))
  const root = join(resources, 'ffmpeg', 'darwin-arm64')
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true, mode: 0o755 })
  await writeFile(join(root, 'LICENSE.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE\nFFmpeg 7.1.1\nlibvpx 1.15.2\nlibopus 1.5.2\nzlib 1.3.2\n')
  await writeFile(join(bin, 'ffmpeg'), 'mach-o executable')
  await writeFile(join(bin, 'libavcodec.61.dylib'), 'mach-o dylib')
  await chmod(resources, 0o755); await chmod(join(resources, 'ffmpeg'), 0o755); await chmod(root, 0o755); await chmod(bin, 0o755)
  await chmod(join(root, 'LICENSE.txt'), 0o644); await chmod(join(bin, 'ffmpeg'), 0o755); await chmod(join(bin, 'libavcodec.61.dylib'), 0o644)
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const contract = await loadWorldFfmpegSupplyChain()
  const manifest = await assembleWorldFfmpegRuntime({
    bundleRoot: root, target: 'darwin-arm64', supplyChain: contract,
    signingKeyId: 'darwin-test-key', privateKey: keys.privateKey,
    trustedManifestKeys: { 'darwin-test-key': publicKey },
    probe: async () => ({ ffmpegVersion: '7.1.1', configuration: contract.ffmpegConfigure, build: contract.build }),
    inspectBinary: async (path) => classifyWorldFfmpegDynamicReferences({
      dependencies: path.endsWith('/ffmpeg')
        ? ['@rpath/libavcodec.61.dylib', '/usr/lib/libSystem.B.dylib']
        : ['/usr/lib/libSystem.B.dylib'],
      loaderSearch: ['@loader_path'], bundledNames: ['libavcodec.61.dylib'], target: 'darwin-arm64',
      systemInterpreter: path.endsWith('/ffmpeg') ? '/usr/lib/dyld' : null,
    }),
  })
  assert.equal(manifest.target, 'darwin-arm64')
})

test('Windows binary audit rejects every path-bearing raw DLL identity before allowlisting', () => {
  for (const dependency of [
    'C:\\attacker\\KERNEL32.dll',
    'C:/attacker/KERNEL32.dll',
    '\\\\attacker\\share\\KERNEL32.dll',
    '\\attacker\\KERNEL32.dll',
    '/attacker/KERNEL32.dll',
    'C:KERNEL32.dll',
    '.\\KERNEL32.dll',
    '..\\KERNEL32.dll',
  ]) {
    assert.throws(() => classifyWorldFfmpegDynamicReferences({
      dependencies: [dependency], loaderSearch: [], bundledNames: [],
      target: 'win32-x64', systemInterpreter: null,
    }), /unsafe loader identity/)
  }
  assert.deepEqual(classifyWorldFfmpegDynamicReferences({
    dependencies: ['KERNEL32.dll'], loaderSearch: [], bundledNames: [],
    target: 'win32-x64', systemInterpreter: null,
  }), {
    bundledDependencies: [], systemDependencies: ['KERNEL32.dll'], loaderSearch: [], systemInterpreter: null,
  })
})

test('Windows source fetch through final runtime install uses file flushes without opening directories read-only', async (t) => {
  const { stageWorldFfmpegRuntime } = await import('./stage-world-ffmpeg-runtime.mjs')
  const { createWorldFfmpegBuildTrust, loadWorldFfmpegBuildTrust } = await import('./world-ffmpeg-build-trust.mjs')
  const { inspectWorldFfmpegBuildTool, writeWorldFfmpegBuildReport } = await import('./write-world-ffmpeg-build-report.mjs')
  const { installWorldFfmpegBuild } = await import('./install-world-ffmpeg-build.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-win-durability-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'sources')
  const trustRoot = join(root, 'trust')
  const prefix = join(root, 'prefix')
  const buildOutput = join(root, 'build-output')
  const repositoryResources = join(root, 'repository-resources')
  await Promise.all([
    mkdir(sourceRoot), mkdir(trustRoot), mkdir(join(prefix, 'bin'), { recursive: true }),
    mkdir(buildOutput), mkdir(join(repositoryResources, 'ffmpeg'), { recursive: true }),
  ])

  const directorySyncs = []
  let directoryOpenAttempts = 0
  const durability = {
    platform: 'win32',
    openDirectory: async () => {
      directoryOpenAttempts += 1
      throw new Error('Windows directory handles must not be opened O_RDONLY for fsync.')
    },
    onDirectorySync: (event) => directorySyncs.push(event),
  }
  const contract = structuredClone(await loadWorldFfmpegSupplyChain())
  const payloads = new Map()
  for (const source of contract.sources) {
    const bytes = Buffer.from(`windows-source:${source.name}`)
    source.sha256 = createHash('sha256').update(bytes).digest('hex')
    source.maximumBytes = 1024
    payloads.set(source.url, bytes)
  }
  for (const [url, maximumKey] of [
    [contract.ffmpegReleaseSignature.url, 'signature'],
    [contract.ffmpegReleaseSignature.keyUrl, 'release-key'],
  ]) payloads.set(url, Buffer.from(maximumKey))
  await fetchWorldFfmpegSources({
    destination: sourceRoot,
    contract,
    durability,
    fetchImpl: async (url) => {
      const bytes = payloads.get(String(url))
      assert.ok(bytes)
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
    },
  })

  const generated = await createWorldFfmpegBuildTrust({
    outputDirectory: trustRoot, keyId: 'windows-durability-test', durability,
  })
  const trust = await loadWorldFfmpegBuildTrust(generated.trustFile)
  await writeFile(join(prefix, 'bin', 'ffmpeg.exe'), 'windows ffmpeg executable')
  await writeFile(join(prefix, 'bin', 'avcodec-61.dll'), 'windows avcodec library')
  const inspectBinary = async (path) => ({
    bundledDependencies: path.endsWith('ffmpeg.exe') ? ['avcodec-61.dll'] : [],
    systemDependencies: ['KERNEL32.dll'],
    loaderSearch: [],
    systemInterpreter: null,
  })
  const bundleRoot = await stageWorldFfmpegRuntime({
    target: 'win32-x64', prefix, output: buildOutput, inspector: process.execPath,
    inspectBinary, durability,
  })
  await assembleWorldFfmpegRuntime({
    bundleRoot, target: 'win32-x64', supplyChain: contract,
    signingKeyId: generated.keyId,
    privateKey: createPrivateKey(await readFile(generated.privateKeyFile)),
    trustedManifestKeys: trust.keys,
    probe: async () => ({ ffmpegVersion: '7.1.1', configuration: contract.ffmpegConfigure, build: contract.build }),
    inspectBinary,
    durability,
  })
  const writtenReport = await writeWorldFfmpegBuildReport({
    target: 'win32-x64', outputDirectory: buildOutput, bundleRoot,
    supplyChainPath: fileURLToPath(new URL('../resources/ffmpeg/supply-chain.v1.json', import.meta.url)),
    trustFile: generated.trustFile, signingKeyId: generated.keyId,
    tools: { ar: process.execPath, cc: process.execPath, inspector: process.execPath },
    runtimeRpath: '',
    inspectTool: async (path, options) => ({
      ...await inspectWorldFfmpegBuildTool(path, options),
      path: `C:\\audited-tools\\${options.name}.exe`,
    }),
    durability,
  })
  assert.equal(writtenReport.report.runtimeRpath, '')
  assert.deepEqual(writtenReport.report.linkerEnvironment, {})
  assert.ok(writtenReport.report.configure.ffmpeg.includes('--extra-ldflags=-L<BUILD_PREFIX>/lib'))
  assert.equal(writtenReport.report.configure.ffmpeg.some((entry) => entry.includes('RPATH')), false)
  const installed = await installWorldFfmpegBuild({
    target: 'win32-x64', sourceResources: buildOutput, repositoryResources,
    trustFile: generated.trustFile, durability,
  })
  assert.equal(installed.target, 'win32-x64')
  for (const entry of contract.distributionFiles) {
    const relativePath = entry.path === 'THIRD_PARTY_NOTICES.md'
      ? entry.path
      : entry.path.slice('resources/'.length)
    const destination = join(repositoryResources, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(new URL(`../${entry.path}`, import.meta.url), destination)
  }
  const { verifyWorldFfmpegPackage } = await import('./verify-world-ffmpeg-package.ts')
  const verifiedPackage = await verifyWorldFfmpegPackage({
    platform: 'win32', arch: 'x64', resourcesPath: repositoryResources,
    trustFile: generated.trustFile,
  }, { outputCustody: runSerializedWorldFfmpegOutputCustody })
  assert.equal(verifiedPackage.runtimeManifestSha256, createHash('sha256')
    .update(await readFile(join(repositoryResources, 'ffmpeg', 'win32-x64', 'manifest.json')))
    .digest('hex'))
  assert.equal(directoryOpenAttempts, 0)
  assert.ok(directorySyncs.length >= 10)
  assert.ok(directorySyncs.every((event) => event.platform === 'win32' && event.supported === false))
  assert.deepEqual((await readdir(join(repositoryResources, 'ffmpeg'))), ['win32-x64'])
})

test('a recipient-generated build key authorizes an exact rebuilt shared runtime without vendor private material', async (t) => {
  const { createWorldFfmpegBuildTrust, loadWorldFfmpegBuildTrust } = await import('./world-ffmpeg-build-trust.mjs')
  const trustRoot = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-user-trust-'))
  const bundleResources = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-user-runtime-'))
  t.after(() => Promise.all([
    rm(trustRoot, { recursive: true, force: true }),
    rm(bundleResources, { recursive: true, force: true }),
  ]))
  const generated = await createWorldFfmpegBuildTrust({
    outputDirectory: trustRoot,
    keyId: 'user-rebuild-test',
  })
  const trust = await loadWorldFfmpegBuildTrust(generated.trustFile)
  assert.deepEqual(Object.keys(trust.keys), ['user-rebuild-test'])
  assert.equal(trust.sha256, generated.trustSha256)

  const root = join(bundleResources, 'ffmpeg', 'linux-x64')
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true, mode: 0o755 })
  await writeFile(join(root, 'LICENSE.txt'), 'GNU LESSER GENERAL PUBLIC LICENSE\nFFmpeg 7.1.1\nlibvpx 1.15.2\nlibopus 1.5.2\nzlib 1.3.2\n')
  await writeFile(join(bin, 'ffmpeg'), 'recipient rebuilt executable')
  await writeFile(join(bin, 'libavcodec.so.61'), 'recipient rebuilt library')
  await chmod(root, 0o755); await chmod(bin, 0o755); await chmod(join(root, 'LICENSE.txt'), 0o644)
  await chmod(join(bin, 'ffmpeg'), 0o755); await chmod(join(bin, 'libavcodec.so.61'), 0o644)
  const contract = await loadWorldFfmpegSupplyChain()
  const manifest = await assembleWorldFfmpegRuntime({
    bundleRoot: root,
    target: 'linux-x64',
    supplyChain: contract,
    signingKeyId: generated.keyId,
    privateKey: createPrivateKey(await readFile(generated.privateKeyFile)),
    trustedManifestKeys: trust.keys,
    probe: async () => ({ ffmpegVersion: '7.1.1', configuration: contract.ffmpegConfigure, build: contract.build }),
    inspectBinary: async (path) => path.endsWith('/ffmpeg')
      ? {
          bundledDependencies: ['libavcodec.so.61'], systemDependencies: ['ld-linux-x86-64.so.2', 'libc.so.6'],
          loaderSearch: ['$ORIGIN'], systemInterpreter: '/lib64/ld-linux-x86-64.so.2',
        }
      : { bundledDependencies: [], systemDependencies: ['libc.so.6'], loaderSearch: ['$ORIGIN'], systemInterpreter: null },
  })
  const manifestBytes = await readFile(join(root, 'manifest.json'))
  const signatureBytes = await readFile(join(root, 'manifest.sig'))
  assert.equal(manifest.signingKeyId, generated.keyId)
  assert.equal(verifySignature(null, manifestBytes, trust.keys[generated.keyId], signatureBytes), true)
  assert.equal(verifySignature(null, Buffer.from(`${manifestBytes.toString('utf8')}tampered`), trust.keys[generated.keyId], signatureBytes), false)
  await assert.rejects(assembleWorldFfmpegRuntime({
    bundleRoot: root,
    target: 'linux-x64',
    supplyChain: contract,
    signingKeyId: generated.keyId,
    privateKey: createPrivateKey(await readFile(generated.privateKeyFile)),
    trustedManifestKeys: {},
    probe: async () => { throw new Error('must not probe') },
    inspectBinary: async () => { throw new Error('must not inspect') },
  }), /trusted release key|undeclared entries/)
})

test('release private-key materialization requires an exact maintainer Ed25519 secret', async (t) => {
  const { materializeWorldFfmpegReleasePrivateKey } = await import('./world-ffmpeg-release-key.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-release-key-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'release-private-key.pem')
  await assert.rejects(materializeWorldFfmpegReleasePrivateKey({ base64: '', output }), /secret/i)
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const result = await materializeWorldFfmpegReleasePrivateKey({ base64: pem.toString('base64'), output })
  assert.equal(result.path, output)
  assert.deepEqual(await readFile(output), pem)
  await assert.rejects(materializeWorldFfmpegReleasePrivateKey({ base64: pem.toString('base64'), output }), /exists|exclusive/i)
})

test('source release material is verification-only and canonical publication excludes raw key and signature bytes', async () => {
  const {
    WORLD_FFMPEG_CANONICAL_SOURCE_ENTRIES,
    createWorldFfmpegReleaseVerificationReceipt,
    validateWorldFfmpegReleaseVerificationReceipt,
  } = await import('./world-ffmpeg-release-material.mjs')
  const contract = await loadWorldFfmpegSupplyChain()
  const receipt = createWorldFfmpegReleaseVerificationReceipt(contract)
  assert.equal(validateWorldFfmpegReleaseVerificationReceipt(receipt, contract), true)
  assert.equal(WORLD_FFMPEG_CANONICAL_SOURCE_ENTRIES.includes(contract.ffmpegReleaseSignature.archive), false)
  assert.equal(WORLD_FFMPEG_CANONICAL_SOURCE_ENTRIES.includes(contract.ffmpegReleaseSignature.keyArchive), false)
  assert.deepEqual(receipt, {
    schema: 'modly.world-ffmpeg-release-verification.v1',
    ffmpegArchive: contract.sources[0].archive,
    ffmpegSha256: contract.sources[0].sha256,
    signerFingerprint: contract.ffmpegReleaseSignature.fingerprint,
    verification: 'detached-signature-valid',
  })
})

test('OS bootstrap strips ambient Node and shell injection before the first package Node process', async (t) => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-clean-bootstrap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const scripts = join(project, 'scripts')
  const electronDirectory = join(project, 'node_modules', 'electron', 'dist')
  const attackerBin = join(root, 'attacker-bin')
  const cache = join(root, 'empty-cache')
  const preloadMarker = join(root, 'ambient-preload-ran')
  const shellMarker = join(root, 'ambient-shell-ran')
  const nodeMarker = join(root, 'ambient-node-ran')
  const pwshMarker = join(root, 'ambient-pwsh-ran')
  const pinnedMarker = join(root, 'pinned-electron-ran')
  const argumentAttackMarker = join(root, 'argument-attack-ran')
  await mkdir(cache)
  await mkdir(scripts, { recursive: true })
  await mkdir(electronDirectory, { recursive: true })
  await mkdir(attackerBin)
  const preload = join(root, 'ambient-preload.cjs')
  await writeFile(preload, `'use strict'
require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'loaded')
const childProcess = require('node:child_process')
childProcess.spawn = () => ({ once() {}, stderr: { on() {} } })
process.on('exit', () => { process.exitCode = 0 })
`)
  const bashEnv = join(root, 'ambient-bash-env')
  await writeFile(bashEnv, `printf loaded > ${JSON.stringify(shellMarker)}\n`)
  for (const [name, marker] of [['node', nodeMarker], ['pwsh', pwshMarker], ['pwsh.exe', pwshMarker]]) {
    const path = join(attackerBin, name)
    await writeFile(path, `#!/bin/sh\nprintf loaded > ${JSON.stringify(marker)}\nexit 0\n`)
    await chmod(path, 0o755)
  }
  const bootstrap = join(scripts, 'world-ffmpeg-clean-package')
  await copyFile(fileURLToPath(new URL('./world-ffmpeg-clean-package', import.meta.url)), bootstrap)
  await chmod(bootstrap, 0o755)
  await writeFile(join(scripts, 'world-ffmpeg-package-bootstrap.mjs'), '')
  const pinnedElectron = join(electronDirectory, 'electron')
  await writeFile(pinnedElectron, `#!/bin/sh
{
  printf 'argc=%s\\n' "$#"
  printf 'entry=%s\\n' "\${1-}"
  printf 'node_options=%s\\n' "\${NODE_OPTIONS-unset}"
  printf 'node_path=%s\\n' "\${NODE_PATH-unset}"
  printf 'electron_run_as_node=%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}"
  printf 'path=%s\\n' "\${PATH-unset}"
} > ${JSON.stringify(pinnedMarker)}
exit 19
`)
  await chmod(pinnedElectron, 0o755)
  const outcome = await new Promise((resolvePromise) => {
    execFile(bootstrap, [], {
      cwd: project,
      env: {
        ...process.env,
        WORLD_FFMPEG_BUILD_TRUST_FILE: join(root, 'trust.json'),
        ELECTRON_BUILDER_CACHE: cache,
        NODE_OPTIONS: `--require=${preload}`,
        NODE_PATH: '/attacker/node-modules',
        BASH_ENV: bashEnv,
        ENV: bashEnv,
        PATH: attackerBin,
        'BASH_FUNC_node%%': `() { printf loaded > ${JSON.stringify(nodeMarker)}; }`,
      },
      timeout: 10_000,
    }, (error, stdout, stderr) => resolvePromise({ error, stdout, stderr }))
  })
  assert.ok(outcome.error)
  assert.equal(outcome.error.code, 19)
  await assert.rejects(readFile(preloadMarker), /ENOENT/)
  await assert.rejects(readFile(shellMarker), /ENOENT/)
  await assert.rejects(readFile(nodeMarker), /ENOENT/)
  await assert.rejects(readFile(pwshMarker), /ENOENT/)
  const audit = await readFile(pinnedMarker, 'utf8')
  assert.match(audit, /^argc=1$/m)
  assert.equal(audit.includes(`entry=${join(scripts, 'world-ffmpeg-package-bootstrap.mjs')}`), true)
  assert.match(audit, /^node_options=unset$/m)
  assert.match(audit, /^node_path=unset$/m)
  assert.match(audit, /^electron_run_as_node=1$/m)
  assert.match(audit, /^path=\/usr\/bin:\/bin$/m)

  await assert.rejects(new Promise((resolvePromise, rejectPromise) => {
    execFile(bootstrap, [`& printf attack > ${argumentAttackMarker}`], {
      cwd: project,
      env: {
        WORLD_FFMPEG_BUILD_TRUST_FILE: join(root, 'trust.json'),
        ELECTRON_BUILDER_CACHE: cache,
      },
    }, (error) => error ? rejectPromise(error) : resolvePromise())
  }), /does not accept arguments|exit code 2/i)
  await assert.rejects(readFile(argumentAttackMarker), /ENOENT/)

  const {
    assertWorldFfmpegCleanPackageAuthority,
    worldFfmpegPackageTargetFor,
  } = await import('./world-ffmpeg-offline-package.mjs')
  const exactEnvironment = {
    ELECTRON_BUILDER_CACHE: cache,
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    TZ: 'UTC',
    WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE: '/audited/electron',
    WORLD_FFMPEG_BUILD_TRUST_FILE: join(root, 'trust.json'),
    WORLD_FFMPEG_CLEAN_BOOTSTRAP: 'modly.world-ffmpeg-package-bootstrap.v2',
    WORLD_FFMPEG_PACKAGE_TARGET: 'linux-x64',
  }
  assert.doesNotThrow(() => assertWorldFfmpegCleanPackageAuthority(
    [], exactEnvironment, { platform: 'linux', arch: 'x64', execPath: '/audited/electron', electronVersion: '44.1.1' },
  ))
  assert.equal(worldFfmpegPackageTargetFor('linux', 'x64'), 'linux-x64')
  assert.equal(worldFfmpegPackageTargetFor('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(worldFfmpegPackageTargetFor('win32', 'x64'), 'win32-x64')
  assert.equal(worldFfmpegPackageTargetFor('linux', 'arm64'), 'linux-arm64')
  for (const attack of [
    ['--require=/attacker/preload.cjs'],
    ['--import=/attacker/module.mjs'],
    ['--loader=/attacker/loader.mjs'],
    ['--inspect=0.0.0.0:9229'],
    ['--experimental-policy=/attacker/policy.json'],
  ]) {
    assert.throws(
      () => assertWorldFfmpegCleanPackageAuthority(
        attack, exactEnvironment, { platform: 'linux', arch: 'x64', execPath: '/audited/electron', electronVersion: '44.1.1' },
      ),
      /Node authority.*execArgv/i,
    )
  }
  assert.throws(
    () => assertWorldFfmpegCleanPackageAuthority([], {
      ...exactEnvironment, NODE_PATH: '/attacker/node-modules',
    }, { platform: 'linux', arch: 'x64', execPath: '/audited/electron', electronVersion: '44.1.1' }),
    /environment|authority/i,
  )
})

test('pinned Electron bootstrap derives its target and spawns only the fixed offline entry', async () => {
  const { runWorldFfmpegPackageBootstrap } = await import('./world-ffmpeg-package-bootstrap.mjs')
  const bootstrap = fileURLToPath(new URL('./world-ffmpeg-package-bootstrap.mjs', import.meta.url))
  const electron = fileURLToPath(new URL('../node_modules/electron/dist/electron', import.meta.url))
  const cache = fileURLToPath(new URL('../.test-package-cache', import.meta.url))
  const trust = fileURLToPath(new URL('../.test-package-trust.json', import.meta.url))
  const calls = []
  const resultReceipt = {
    schema: 'modly.electron-builder-package-result-receipt.v1',
    manifestPath: '/attempt/RESULT.linux-x64.v1.json',
  }
  const result = await runWorldFfmpegPackageBootstrap({
    runtime: {
      platform: 'linux', arch: 'x64', execPath: electron, electronVersion: '44.1.1',
    },
    execArgv: [],
    argv: [electron, bootstrap],
    environment: {
      ELECTRON_BUILDER_CACHE: cache,
      ELECTRON_RUN_AS_NODE: '1',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      TZ: 'UTC',
      WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE: electron,
      WORLD_FFMPEG_BUILD_TRUST_FILE: trust,
      WORLD_FFMPEG_CLEAN_BOOTSTRAP: 'modly.world-ffmpeg-package-bootstrap.v1',
    },
    spawnProcess: async (...args) => {
      calls.push(args)
      return { code: 0, signal: null, stdout: Buffer.from(`${JSON.stringify(resultReceipt)}\n`) }
    },
    requireResultReceipt: (value) => value,
    loadPackageResult: async () => ({ target: 'linux-x64' }),
  })
  assert.deepEqual(result, { code: 0, signal: null, resultReceipt })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], electron)
  assert.equal(calls[0][1][0], fileURLToPath(new URL('./world-ffmpeg-offline-package.mjs', import.meta.url)))
  assert.match(calls[0][1][1], /^--world-ffmpeg-attempt=[a-f0-9]{32}$/)
  assert.equal(calls[0][1].length, 2)
  assert.equal(calls[0][2].cwd, fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''))
  assert.equal(calls[0][2].shell, false)
  assert.equal(calls[0][2].detached, true)
  assert.deepEqual(Object.keys(calls[0][2].env).sort(), [
    'ELECTRON_BUILDER_CACHE', 'ELECTRON_RUN_AS_NODE', 'LANG', 'LC_ALL', 'PATH', 'TZ',
    'WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE', 'WORLD_FFMPEG_BUILD_TRUST_FILE',
    'WORLD_FFMPEG_CLEAN_BOOTSTRAP', 'WORLD_FFMPEG_PACKAGE_TARGET',
  ].sort())
  assert.equal(calls[0][2].env.WORLD_FFMPEG_PACKAGE_TARGET, 'linux-x64')

  let unsupportedSpawned = false
  await assert.rejects(runWorldFfmpegPackageBootstrap({
    runtime: {
      platform: 'win32', arch: 'arm64', execPath: electron, electronVersion: '44.1.1',
    },
    execArgv: [],
    argv: [electron, bootstrap],
    environment: {},
    spawnProcess: async () => {
      unsupportedSpawned = true
      return { code: 0, signal: null }
    },
  }), /unsupported-target: win32-arm64/)
  assert.equal(unsupportedSpawned, false)

  await assert.rejects(runWorldFfmpegPackageBootstrap({
    runtime: {
      platform: 'linux', arch: 'x64', execPath: electron, electronVersion: '44.1.1',
    },
    execArgv: [],
    argv: [electron, bootstrap],
    environment: {
      ELECTRON_BUILDER_CACHE: '',
      ELECTRON_RUN_AS_NODE: '1',
      LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC',
      WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE: electron,
      WORLD_FFMPEG_BUILD_TRUST_FILE: '',
      WORLD_FFMPEG_CLEAN_BOOTSTRAP: 'modly.world-ffmpeg-package-bootstrap.v1',
    },
    spawnProcess: async () => {
      throw new Error('must not spawn')
    },
  }), /bundle-missing: (?:ELECTRON_BUILDER_CACHE|WORLD_FFMPEG_BUILD_TRUST_FILE)/)
})

test('Windows package environment is case-folded, canonical, and SystemRoot-derived', async () => {
  const {
    createWorldFfmpegBuilderEnvironment,
    requireClosedWorldFfmpegBuilderEnvironment,
  } = require('./world-ffmpeg-package-environment.cjs')
  const environment = createWorldFfmpegBuilderEnvironment({
    target: 'win32-x64',
    cacheDirectory: 'C:\\audit\\cache-0123456789abcdef0123456789abcdef',
    cacheIdentity: { dev: '1', ino: '2' },
    attemptId: '0123456789abcdef0123456789abcdef',
    outputDirectory: 'C:\\audit\\output-0123456789abcdef0123456789abcdef',
    outputIdentity: { dev: '3', ino: '4' },
    runnerHeartbeatPath: 'C:\\audit\\lifecycle\\runner-0123456789abcdef0123456789abcdef.heartbeat',
    runnerTerminalPath: 'C:\\audit\\lifecycle\\terminal-0123456789abcdef0123456789abcdef.json',
    buildTrustFile: 'C:\\audit\\trust.json',
    bootstrapExecutable: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
    sourceEnvironment: { SystemRoot: 'C:\\Windows', WINDIR: 'c:\\WINDOWS' },
  })
  assert.equal(Object.keys(environment).filter((key) => key.toLowerCase() === 'npm_config_offline').length, 1)
  assert.equal(environment.NPM_CONFIG_OFFLINE, 'true')
  assert.equal(environment.npm_config_offline, undefined)
  const folded = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]))
  assert.equal(requireClosedWorldFfmpegBuilderEnvironment(folded, {
    platform: 'win32', arch: 'x64',
    execPath: 'c:\\REPO\\node_modules\\electron\\dist\\electron.exe',
    electronVersion: '44.1.1',
  }), 'win32-x64')

  for (const [key, value] of [
    ['path', 'C:\\attacker;C:\\Windows\\System32'],
    ['comspec', 'C:\\attacker\\cmd.exe'],
    ['pathext', '.EXE;.JS'],
    ['windir', 'D:\\Windows'],
  ]) {
    assert.throws(
      () => requireClosedWorldFfmpegBuilderEnvironment({ ...folded, [key]: value }),
      /Windows|environment|SystemRoot/i,
    )
  }
  assert.throws(
    () => requireClosedWorldFfmpegBuilderEnvironment({ ...environment, SYSTEMROOT: 'C:\\Windows' }),
    /duplicate|environment/i,
  )
  for (const systemRoot of ['Windows', '\\\\attacker\\share', 'C:\\Windows\\..\\attack', 'C:\\Win&dows']) {
    assert.throws(() => createWorldFfmpegBuilderEnvironment({
      target: 'win32-x64',
      cacheDirectory: 'C:\\audit\\cache-0123456789abcdef0123456789abcdef',
      cacheIdentity: { dev: '1', ino: '2' },
      attemptId: '0123456789abcdef0123456789abcdef',
      outputDirectory: 'C:\\audit\\output-0123456789abcdef0123456789abcdef',
      outputIdentity: { dev: '3', ino: '4' },
      runnerHeartbeatPath: 'C:\\audit\\lifecycle\\runner-0123456789abcdef0123456789abcdef.heartbeat',
      runnerTerminalPath: 'C:\\audit\\lifecycle\\terminal-0123456789abcdef0123456789abcdef.json',
      buildTrustFile: 'C:\\audit\\trust.json',
      bootstrapExecutable: 'C:\\repo\\electron.exe',
      sourceEnvironment: { SystemRoot: systemRoot, WINDIR: systemRoot },
    }), /SystemRoot|Windows/i)
  }
})

test('offline package tool cache is exact, hash-pinned, and blocks electron-builder before spawn', async (t) => {
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
    verifyWorldFfmpegPackageToolCache,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const cache = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-builder-cache-'))
  t.after(() => rm(cache, { recursive: true, force: true }))
  const original = await loadWorldFfmpegPackageToolLock()
  const contract = structuredClone(original)
  const entries = contract.targets['linux-x64']
  for (const entry of entries) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
  }
  const spawns = []
  await assert.rejects(runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: cache, contract, argv: ['--linux'],
    spawnProcess: (...args) => { spawns.push(args); throw new Error('must not spawn') },
  }), /tool cache.*missing/i)
  assert.equal(spawns.length, 0)
  for (const entry of entries) {
    const directory = join(cache, entry.release)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, entry.filename), `tool:${entry.release}:${entry.filename}`)
  }
  assert.deepEqual(await verifyWorldFfmpegPackageToolCache({ target: 'linux-x64', cacheDirectory: cache, contract }), { ok: true })
  const buildTrustFile = join(cache, 'audited-build-trust.json')
  let unrelatedGroupSpawned = false
  await assert.rejects(runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: cache, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile,
    processLifecycle: { processGroupId: process.pid + 1 },
    spawnProcess: () => { unrelatedGroupSpawned = true; return Promise.resolve({ code: 0, signal: null }) },
    verifyPackage: approveFakePackageVerification,
    inspectArtifacts: approveFakeArtifactInspection,
  }), /process lifecycle/i)
  assert.equal(unrelatedGroupSpawned, false)
  const attackerEnvironment = {
    PATH: '/attacker/bin', HOME: '/attacker/home', UNRELATED_ATTACKER_VARIABLE: 'present',
    WORLD_FFMPEG_BUILD_TRUST_FILE: buildTrustFile,
    ELECTRON_BUILDER_7ZIP_PATH: '/attacker/7za',
    APPIMAGE_TOOLS_PATH: '/attacker/appimage-tools',
    CUSTOM_DMGBUILD_PATH: '/attacker/dmgbuild',
    MKSQUASHFS_PATH: '/attacker/mksquashfs',
    ELECTRON_BUILDER_ICONS_TOOLSET_DIR: '/attacker/icons',
    ELECTRON_BUILDER_WINE_TOOLSET_DIR: '/attacker/wine',
    ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: 'https://attacker.invalid/',
    ELECTRON_BUILDER_BINARIES_CUSTOM_DIR: 'attacker',
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR: 'https://attacker.invalid/',
    ELECTRON_MIRROR: 'https://attacker.invalid/',
    ELECTRON_CUSTOM_DIR: 'attacker',
    ELECTRON_CUSTOM_FILENAME: 'attacker',
    USE_SYSTEM_7ZA: 'true', USE_SYSTEM_FPM: 'true', USE_SYSTEM_WINE: 'true',
    DYLD_LIBRARY_PATH: '/attacker', LD_LIBRARY_PATH: '/attacker',
    APP_BUILDER_TMP_DIR: '/attacker/tmp', XDG_CACHE_HOME: '/attacker/cache',
    CSC_LINK: '/attacker/certificate', HTTP_PROXY: 'http://attacker.invalid/',
  }
  const verificationCalls = []
  const result = await runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: cache, contract, argv: ['--linux', '--publish', 'never'],
    buildTrustFile, environment: attackerEnvironment,
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    spawnProcess: async (file, args, options) => {
      spawns.push([file, args, options])
      await publishFakePackageRunnerSuccess(options, 'offline-cache')
      return { code: 0, signal: null }
    },
    verifyPackage: async (request) => {
      verificationCalls.push(request)
      return approveFakePackageVerification(request)
    },
    inspectArtifacts: approveFakeArtifactInspection,
  })
  assert.equal(result.code, 0)
  assert.equal(result.signal, null)
  assert.match(result.attemptId, /^[a-f0-9]{32}$/)
  assert.match(result.outputDirectory, new RegExp(`output-${result.attemptId}$`))
  assert.equal(result.resultManifestPath, join(result.outputDirectory, 'RESULT.linux-x64.v1.json'))
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0][2].env.ELECTRON_DOWNLOAD_CACHE_MODE, '1')
  assert.notEqual(spawns[0][2].env.ELECTRON_BUILDER_CACHE, cache)
  await assert.rejects(lstat(spawns[0][2].env.ELECTRON_BUILDER_CACHE), /ENOENT/)
  assert.equal(spawns[0][2].env.ELECTRON_RUN_AS_NODE, '1')
  assert.match(spawns[0][2].env.NODE_OPTIONS, /deny-network\.cjs/)
  assert.equal(spawns[0][2].env.PATH, '/usr/bin:/bin')
  assert.equal(spawns[0][2].env.WORLD_FFMPEG_BUILD_TRUST_FILE, buildTrustFile)
  assert.equal(spawns[0][2].env.WORLD_FFMPEG_PACKAGE_TARGET, 'linux-x64')
  assert.equal(spawns[0][2].env.WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE, process.execPath)
  assert.equal(spawns[0][2].detached, true)
  assert.equal(spawns[0][1].length, 3)
  assert.match(spawns[0][1][0], /^--require=.*world-ffmpeg-deny-network\.cjs$/)
  assert.match(spawns[0][1][1], /world-ffmpeg-electron-builder-runner\.cjs$/)
  assert.equal(spawns[0][1][2], `--world-ffmpeg-attempt=${result.attemptId}`)
  assert.equal(spawns[0][1].some((entry) => /electron-builder[/\\]out[/\\]cli/.test(entry)), false)
  assert.equal(verificationCalls.length, 1)
  assert.deepEqual(Object.keys(verificationCalls[0]).sort(), [
    'arch', 'buildReportDirectory', 'buildReportDirectoryIdentity', 'buildReportName',
    'buildReportReceipt', 'platform', 'resourcesIdentity', 'resourcesPath', 'trustFile',
  ])
  assert.equal(verificationCalls[0].platform, 'linux')
  assert.equal(verificationCalls[0].arch, 'x64')
  assert.equal(verificationCalls[0].trustFile, buildTrustFile)
  assert.equal(verificationCalls[0].resourcesPath, join(result.outputDirectory, 'linux-unpacked', 'resources'))
  assert.equal(verificationCalls[0].buildReportDirectory, result.outputDirectory)
  assert.equal(verificationCalls[0].buildReportName, 'WORLD_FFMPEG_BUILD_REPORT.linux-x64.v1.json')
  for (const identity of [
    verificationCalls[0].resourcesIdentity,
    verificationCalls[0].buildReportDirectoryIdentity,
  ]) {
    assert.deepEqual(Object.keys(identity).sort(), ['dev', 'ino'])
    assert.match(identity.dev, /^[0-9]+$/)
    assert.match(identity.ino, /^[0-9]+$/)
  }
  assert.deepEqual(Object.keys(verificationCalls[0].buildReportReceipt).sort(), [
    'dev', 'ino', 'name', 'sha256', 'size',
  ])
  assert.deepEqual(Object.keys(spawns[0][2].env).sort(), [
    'CSC_IDENTITY_AUTO_DISCOVERY', 'ELECTRON_BUILDER_CACHE', 'ELECTRON_BUILDER_OFFLINE',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_DOWNLOAD_CACHE_MODE', 'ELECTRON_GET_USE_PROXY', 'LANG', 'LC_ALL',
    'NODE_OPTIONS', 'NPM_CONFIG_OFFLINE', 'PATH', 'TZ', 'WORLD_FFMPEG_BUILD_TRUST_FILE',
    'WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE', 'WORLD_FFMPEG_PACKAGE_ATTEMPT_ID',
    'WORLD_FFMPEG_PACKAGE_CACHE_IDENTITY', 'WORLD_FFMPEG_PACKAGE_NETWORK',
    'WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY', 'WORLD_FFMPEG_PACKAGE_OUTPUT_IDENTITY',
    'WORLD_FFMPEG_PACKAGE_RUNNER_HEARTBEAT', 'WORLD_FFMPEG_PACKAGE_RUNNER_TERMINAL',
    'WORLD_FFMPEG_PACKAGE_TARGET',
  ].sort())

  const overrideArguments = [
    ['--linux', '--publish', 'never', '--config.beforePack=/attacker.js'],
    ['--linux', '--publish', 'never', '--config.afterPack=/attacker.js'],
    ['--linux', '--publish', 'never', '--config.electronDist=/attacker'],
    ['--linux', '--publish', 'never', '--config.directories.output=/attacker'],
    ['--linux', '--publish', 'never', '--config.extraResources.0.from=/attacker'],
    ['--linux', '--publish', 'never', '-c.afterPack=/attacker.js'],
    ['--linux', '--publish', 'always'],
    ['--linux', '--publish', 'never', '--dir'],
    ['--linux', '--publish', 'never', '--config', '/attacker.json'],
    ['--linux', '--publish', 'never', 'attacker-position'],
    ['--linux', '--x64', '--publish', 'never'],
    ['--win', '--publish', 'never'],
  ]
  for (const argv of overrideArguments) {
    let attackSpawned = false
    await assert.rejects(runWorldFfmpegOfflinePackage({
      target: 'linux-x64', cacheDirectory: cache, contract, argv, buildTrustFile,
      spawnProcess: () => { attackSpawned = true; return Promise.resolve({ code: 0, signal: null }) },
      verifyPackage: async () => ({ ok: true }),
    }), /package arguments|offline package invocation|unsupported/i)
    assert.equal(attackSpawned, false, `override reached spawn: ${argv.join(' ')}`)
  }

  await assert.rejects(runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: cache, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile,
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    spawnProcess: async (_file, _args, options) => {
      await publishFakePackageRunnerSuccess(options, 'post-verify-failure')
      return { code: 0, signal: null }
    },
    verifyPackage: async () => ({ ok: false, code: 'packaged-runtime-tampered' }),
  }), /post-package verification.*packaged-runtime-tampered/i)
})

test('mutable package-cache generations isolate repeats, concurrency, crashes, and cleanup failure', async (t) => {
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
    verifyWorldFfmpegPackageToolCache,
    worldFfmpegMutablePackageCacheRootFor,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const { prepareWorldFfmpegPackageToolCache } = await import('./prepare-electron-builder-tool-cache.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-cache-generations-'))
  const archiveStore = join(root, 'immutable-archives')
  const trustFile = join(root, 'trust.json')
  await mkdir(archiveStore)
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  const immutableStats = new Map()
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    const directory = join(archiveStore, entry.release)
    await mkdir(directory, { recursive: true })
    const path = join(directory, entry.filename)
    await writeFile(path, bytes)
    immutableStats.set(`${entry.release}/${entry.filename}`, await lstat(path))
  }

  const generationPaths = []
  const packageOnce = (cacheLifecycle) => runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: trustFile,
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    cacheLifecycle,
    spawnProcess: async (_file, _args, options) => {
      const generation = options.env.ELECTRON_BUILDER_CACHE
      generationPaths.push(generation)
      assert.notEqual(generation, archiveStore)
      for (const entry of contract.targets['linux-x64']) {
        const source = join(archiveStore, entry.release, entry.filename)
        const copy = join(generation, entry.release, entry.filename)
        assert.deepEqual(await readFile(copy), await readFile(source))
        const [sourceInfo, copyInfo] = await Promise.all([lstat(source), lstat(copy)])
        assert.notDeepEqual([copyInfo.dev, copyInfo.ino], [sourceInfo.dev, sourceInfo.ino])
        assert.equal(copyInfo.nlink, 1)
        await writeFile(copy, 'builder-mutated-private-copy')
        await mkdir(join(generation, entry.release, 'extracted-sibling'), { recursive: true })
      }
      await publishFakePackageRunnerSuccess(options, `generation-${generationPaths.length}`)
      return { code: 0, signal: null }
    },
    verifyPackage: approveFakePackageVerification,
    inspectArtifacts: approveFakeArtifactInspection,
  })

  await packageOnce()
  await packageOnce()
  assert.equal(new Set(generationPaths).size, 2)
  for (const generation of generationPaths) await assert.rejects(lstat(generation), /ENOENT/)
  assert.deepEqual(await verifyWorldFfmpegPackageToolCache({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
  }), { ok: true })
  for (const entry of contract.targets['linux-x64']) {
    const path = join(archiveStore, entry.release, entry.filename)
    const before = immutableStats.get(`${entry.release}/${entry.filename}`)
    const after = await lstat(path)
    assert.deepEqual([after.dev, after.ino, after.size], [before.dev, before.ino, before.size])
  }
  assert.deepEqual(await prepareWorldFfmpegPackageToolCache({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    fetchImpl: async () => { throw new Error('package retry must not fetch') },
  }), { ok: true })

  const concurrentPaths = []
  const releases = []
  let bothSpawnedResolve
  const bothSpawned = new Promise((resolvePromise) => { bothSpawnedResolve = resolvePromise })
  const concurrent = () => runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: trustFile,
    outputCustody: runCwdCoordinatedWorldFfmpegOutputCustody,
    spawnProcess: async (_file, _args, options) => {
      concurrentPaths.push(options.env.ELECTRON_BUILDER_CACHE)
      if (concurrentPaths.length === 2) bothSpawnedResolve()
      return new Promise((resolvePromise, rejectPromise) => {
        releases.push(async (result) => {
          try {
            await publishFakePackageRunnerSuccess(options, `concurrent-${concurrentPaths.length}`)
            resolvePromise(result)
          } catch (error) {
            rejectPromise(error)
          }
        })
      })
    },
    verifyPackage: approveFakePackageVerification,
    inspectArtifacts: approveFakeArtifactInspection,
  })
  const first = concurrent()
  const second = concurrent()
  await bothSpawned
  assert.equal(new Set(concurrentPaths).size, 2)
  for (const path of concurrentPaths) assert.equal((await lstat(path)).isDirectory(), true)
  releases.forEach((release) => release({ code: 0, signal: null }))
  await Promise.all([first, second])
  for (const path of concurrentPaths) await assert.rejects(lstat(path), /ENOENT/)

  const generationRoot = worldFfmpegMutablePackageCacheRootFor(archiveStore)
  const activeGenerationEntries = async () => (
    (await readdir(generationRoot)).filter((name) => !name.startsWith('.')).sort()
  )
  const foreign = join(generationRoot, 'foreign-do-not-delete')
  await mkdir(foreign)
  await packageOnce()
  assert.equal((await lstat(foreign)).isDirectory(), true)
  await rm(foreign, { recursive: true })

  const hostileToken = 'ffffffffffffffffffffffffffffffff'
  const hostileLease = join(generationRoot, `lease-${hostileToken}.json`)
  const hostileSource = join(root, 'hostile-lease-source.json')
  await writeFile(hostileSource, '{}\n')
  await symlink(hostileSource, hostileLease)
  await assert.rejects(packageOnce(), /mutable package cache lease is invalid/i)
  await rm(hostileLease)
  await link(hostileSource, hostileLease)
  await assert.rejects(packageOnce(), /mutable package cache lease is invalid/i)
  await rm(hostileLease)
  await rm(hostileSource)

  await assert.rejects(packageOnce({
    cleanupTimeoutMs: 10,
    beforeDirectoryQuarantine: () => new Promise(() => {}),
  }), /mutable package cache cleanup timed out/i)
  assert.ok((await readdir(generationRoot)).some((name) => name.startsWith('lease-')))
  await packageOnce()
  assert.deepEqual(await activeGenerationEntries(), [])

  await assert.rejects(packageOnce({
    cleanupTimeoutMs: 1_000,
    removeTree: async () => undefined,
  }), /mutable package cache lifecycle is invalid/i)

  await assert.rejects(packageOnce({
    cleanupTimeoutMs: 1_000,
    beforeDirectoryQuarantine: async () => { throw new Error('injected mutable-cache cleanup failure') },
  }), /injected mutable-cache cleanup failure/i)
  assert.ok((await readdir(generationRoot)).some((name) => name.startsWith('lease-')))
  await packageOnce()
  assert.deepEqual(await activeGenerationEntries(), [])

  const crashSignal = join(root, 'crash-ready')
  const crashScript = join(root, 'crash-package.mjs')
  const modulePath = fileURLToPath(new URL('./world-ffmpeg-package-tools.mjs', import.meta.url))
  const outputCustodyModulePath = fileURLToPath(new URL('./world-ffmpeg-output-custody.mjs', import.meta.url))
  await writeFile(crashScript, `
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { loadWorldFfmpegPackageToolLock, runWorldFfmpegOfflinePackage } from ${JSON.stringify(modulePath)}
import { _testOnlyRunWorldFfmpegOutputCustodyInProcess as outputCustody } from ${JSON.stringify(outputCustodyModulePath)}
const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
for (const entry of contract.targets['linux-x64']) {
  const bytes = Buffer.from(\`tool:\${entry.release}:\${entry.filename}\`)
  entry.sha256 = createHash('sha256').update(bytes).digest('hex')
  entry.maximumBytes = 1024
}
await runWorldFfmpegOfflinePackage({
  target: 'linux-x64', cacheDirectory: ${JSON.stringify(archiveStore)}, contract,
  argv: ['--linux', '--publish', 'never'], buildTrustFile: ${JSON.stringify(trustFile)},
  outputCustody,
  spawnProcess() {
    writeFileSync(${JSON.stringify(crashSignal)}, 'ready')
    process.exit(77)
  },
  verifyPackage: async (request) => ({ ok: true, buildReportReceipt: request.buildReportReceipt }),
})
`)
  const crash = await new Promise((resolvePromise) => {
    execFile(process.execPath, [crashScript], { timeout: 10_000 }, (error, stdout, stderr) => {
      resolvePromise({ error, stdout, stderr })
    })
  })
  assert.equal(crash.error?.code, 77, crash.stderr)
  assert.equal(await readFile(crashSignal, 'utf8'), 'ready')
  assert.ok((await readdir(generationRoot)).some((name) => name.startsWith('lease-')))
  await packageOnce()
  assert.deepEqual(await activeGenerationEntries(), [])
  assert.deepEqual(await verifyWorldFfmpegPackageToolCache({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
  }), { ok: true })
})

test('package attempts bind isolated bytes and manifests and reject final-hash root ABA', async (t) => {
  const {
    loadWorldFfmpegPackageResult,
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-output-attempts-'))
  const archiveStore = join(root, 'immutable-archives')
  await mkdir(archiveStore)
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    const directory = join(archiveStore, entry.release)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, entry.filename), bytes)
  }

  const attempts = []
  let releaseFirstVerify
  let firstReachedVerify
  const firstAtVerify = new Promise((resolvePromise) => { firstReachedVerify = resolvePromise })
  const holdFirstVerify = new Promise((resolvePromise) => { releaseFirstVerify = resolvePromise })
  const invoke = () => runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    spawnProcess: async (_file, _args, options) => {
      const environment = options.env
      const index = attempts.length
      const label = index === 0 ? 'A' : 'B'
      const outputDirectory = environment.WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY
      const attemptId = environment.WORLD_FFMPEG_PACKAGE_ATTEMPT_ID
      assert.match(attemptId, /^[a-f0-9]{32}$/)
      assert.match(outputDirectory, new RegExp(`output-${attemptId}$`))
      assert.notEqual(outputDirectory, join(fileURLToPath(new URL('../', import.meta.url)), 'dist'))
      const resourcesPath = join(outputDirectory, 'linux-unpacked', 'resources')
      await mkdir(resourcesPath, { recursive: true })
      await writeFile(join(resourcesPath, 'attempt.txt'), label)
      const reportDirectory = join(resourcesPath, 'world-ffmpeg-build-reports')
      await mkdir(reportDirectory)
      await writeFile(join(reportDirectory, 'linux-x64.json'), `${JSON.stringify({ attempt: label })}\n`)
      const artifactPath = join(outputDirectory, `Modly-${label}.AppImage`)
      await writeFile(artifactPath, `artifact-${label}`)
      const runnerIdentity = createHash('sha256').update(`runner-${label}`).digest('hex').slice(0, 32)
      const outputInfo = await lstat(outputDirectory, { bigint: true })
      const cacheInfo = await lstat(environment.ELECTRON_BUILDER_CACHE, { bigint: true })
      await writeFile(environment.WORLD_FFMPEG_PACKAGE_RUNNER_TERMINAL, `${JSON.stringify({
        schema: 'modly.electron-builder-package-runner-terminal.v1',
        attemptId,
        target: 'linux-x64',
        runnerIdentity,
        runnerPid: process.pid,
        processStartIdentity: 'unavailable',
        cacheIdentity: { dev: String(cacheInfo.dev), ino: String(cacheInfo.ino) },
        outputIdentity: { dev: String(outputInfo.dev), ino: String(outputInfo.ino) },
        status: 'succeeded',
        artifacts: [`Modly-${label}.AppImage`],
      })}\n`)
      attempts.push({ attemptId, label, outputDirectory, resourcesPath, artifactPath })
      return { code: 0, signal: null }
    },
    verifyPackage: async (request) => {
      const { resourcesPath } = request
      const attempt = attempts.find((candidate) => candidate.resourcesPath === resourcesPath)
      assert.ok(attempt, `verification escaped attempt output: ${resourcesPath}`)
      assert.equal(await readFile(join(resourcesPath, 'attempt.txt'), 'utf8'), attempt.label)
      if (attempt.label === 'A') {
        firstReachedVerify()
        await holdFirstVerify
        assert.equal(await readFile(join(resourcesPath, 'attempt.txt'), 'utf8'), 'A')
      }
      return approveFakePackageVerification(request)
    },
    inspectArtifacts: approveFakeArtifactInspection,
  })

  const first = invoke()
  await firstAtVerify
  const secondResult = await invoke()
  releaseFirstVerify()
  const firstResult = await first
  assert.notEqual(firstResult.outputDirectory, secondResult.outputDirectory)
  assert.notEqual(firstResult.resultManifestPath, secondResult.resultManifestPath)
  for (const result of [firstResult, secondResult]) {
    const manifest = await loadWorldFfmpegPackageResult(result.resultManifestPath, {
      resultReceipt: result.resultReceipt,
      outputCustody: runSerializedWorldFfmpegOutputCustody,
    })
    assert.equal(manifest.attemptId, result.attemptId)
    assert.equal(manifest.target, 'linux-x64')
    assert.equal(manifest.artifacts.length, 1)
    const bytes = await readFile(join(result.outputDirectory, manifest.artifacts[0].path))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.artifacts[0].sha256)
  }
  const {
    publishWorldFfmpegPackageGithubOutputs,
    writeWorldFfmpegPackageArtifactList,
  } = await import('./world-ffmpeg-package-result.mjs')
  const artifactList = join(root, 'artifacts.paths')
  const listed = await writeWorldFfmpegPackageArtifactList({
    manifestPath: firstResult.resultManifestPath,
    resultReceipt: firstResult.resultReceipt,
    outputPath: artifactList,
    outputCustody: runSerializedWorldFfmpegOutputCustody,
  })
  const attemptReport = join(firstResult.outputDirectory, 'WORLD_FFMPEG_BUILD_REPORT.linux-x64.v1.json')
  assert.deepEqual(listed.paths, [
    attempts.find(({ label }) => label === 'A').artifactPath,
    attemptReport,
    firstResult.resultManifestPath,
  ])
  assert.deepEqual((await readFile(artifactList)).toString('utf8').split('\0'), [
    listed.paths[0], attemptReport, firstResult.resultManifestPath, '',
  ])
  const bootstrapOutput = join(root, 'bootstrap-output.txt')
  const githubOutput = join(root, 'github-output.txt')
  const resultAuthorityLine = (result) => `WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT=${Buffer.from(
    JSON.stringify(result.resultReceipt),
  ).toString('base64')}\n`
  await writeFile(bootstrapOutput, `builder log\n${resultAuthorityLine(firstResult)}`)
  await writeFile(githubOutput, '')
  const published = await publishWorldFfmpegPackageGithubOutputs({
    bootstrapOutputPath: bootstrapOutput,
    githubOutputPath: githubOutput,
    outputCustody: runSerializedWorldFfmpegOutputCustody,
  })
  assert.equal(published.verifiedCount, listed.paths.length)
  const outputAuthority = await readFile(githubOutput, 'utf8')
  assert.match(outputAuthority, new RegExp(`WORLD_FFMPEG_PACKAGE_RESULT=${firstResult.resultManifestPath}`))
  assert.match(outputAuthority, /WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT=/)
  assert.doesNotMatch(outputAuthority, /artifact_paths|result_manifest/)
  await writeFile(bootstrapOutput, `${resultAuthorityLine(firstResult)}${resultAuthorityLine(secondResult)}`)
  await assert.rejects(publishWorldFfmpegPackageGithubOutputs({
    bootstrapOutputPath: bootstrapOutput,
    githubOutputPath: githubOutput,
    outputCustody: runSerializedWorldFfmpegOutputCustody,
  }), /no unique result authority/i)
  await writeFile(bootstrapOutput, resultAuthorityLine(firstResult))
  await writeFile(join(
    attempts.find(({ label }) => label === 'A').resourcesPath,
    'world-ffmpeg-build-reports',
    'linux-x64.json',
  ), '{"mutatedAfterVerification":true}\n')
  const republished = await publishWorldFfmpegPackageGithubOutputs({
    bootstrapOutputPath: bootstrapOutput,
    githubOutputPath: githubOutput,
    outputCustody: runSerializedWorldFfmpegOutputCustody,
  })
  assert.equal(republished.verifiedCount, listed.paths.length)
  const fs = require('node:fs')
  const foreignOutput = join(root, 'foreign-output-root')
  const displacedOutput = join(root, 'displaced-output-root')
  await mkdir(foreignOutput)
  let resultRootSwapCount = 0
  await assert.rejects(loadWorldFfmpegPackageResult(firstResult.resultManifestPath, {
    resultReceipt: firstResult.resultReceipt,
    outputCustody: (input) => input.operation === 'read' && resultRootSwapCount === 0
      ? runSerializedWorldFfmpegOutputCustody(input, {
          beforeEnter() {
            fs.renameSync(firstResult.outputDirectory, displacedOutput)
            fs.renameSync(foreignOutput, firstResult.outputDirectory)
            resultRootSwapCount += 1
          },
          afterRootOpen() {
            fs.renameSync(firstResult.outputDirectory, foreignOutput)
            fs.renameSync(displacedOutput, firstResult.outputDirectory)
          },
        })
      : runSerializedWorldFfmpegOutputCustody(input),
  }), /root identity changed/i)
  assert.equal(resultRootSwapCount, 1)
  assert.equal((await lstat(firstResult.outputDirectory)).isDirectory(), true)
  await writeFile(listed.paths[0], 'tampered-after-result')
  await assert.rejects(writeWorldFfmpegPackageArtifactList({
    manifestPath: firstResult.resultManifestPath,
    resultReceipt: firstResult.resultReceipt,
    outputPath: join(root, 'tampered-artifacts.paths'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
  }), /artifact changed after publication/i)
})

test('normal and startup-recovery cleanup preserve a replacement generation and fail observably', async (t) => {
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const makeFixture = async (label) => {
    const root = await mkdtemp(join(tmpdir(), `modly-ffmpeg-cleanup-${label}-`))
    const archiveStore = join(root, 'archives')
    await mkdir(archiveStore)
    const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
    for (const entry of contract.targets['linux-x64']) {
      const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
      entry.sha256 = createHash('sha256').update(bytes).digest('hex')
      entry.maximumBytes = 1024
      await mkdir(join(archiveStore, entry.release), { recursive: true })
      await writeFile(join(archiveStore, entry.release, entry.filename), bytes)
    }
    t.after(() => rm(root, { recursive: true, force: true }))
    return { root, archiveStore, contract }
  }
  const invoke = (fixture, label, cacheLifecycle = undefined, onSpawn = undefined) => (
    runWorldFfmpegOfflinePackage({
      target: 'linux-x64', cacheDirectory: fixture.archiveStore, contract: fixture.contract,
      argv: ['--linux', '--publish', 'never'], buildTrustFile: join(fixture.root, 'trust.json'),
      outputCustody: runSerializedWorldFfmpegOutputCustody,
      cacheLifecycle,
      spawnProcess: async (_file, _args, options) => {
        onSpawn?.(options)
        await publishFakePackageRunnerSuccess(options, label)
        return { code: 0, signal: null }
      },
      verifyPackage: approveFakePackageVerification,
      inspectArtifacts: approveFakeArtifactInspection,
    })
  )

  const normal = await makeFixture('normal')
  let normalCache
  let normalReplaced = false
  await assert.rejects(invoke(normal, 'normal', {
    beforeDirectoryRetirement: async ({ path }) => {
      if (!normalReplaced && path === normalCache) {
        await mkdir(normalCache)
        await writeFile(join(normalCache, 'foreign-sentinel'), 'normal replacement')
        normalReplaced = true
      }
    },
  }, (options) => { normalCache = options.env.ELECTRON_BUILDER_CACHE }), /replaced during retirement/i)
  assert.equal(normalReplaced, true)
  assert.equal(await readFile(join(normalCache, 'foreign-sentinel'), 'utf8'), 'normal replacement')

  const failedOutput = await makeFixture('failed-output')
  let failedOutputDirectory
  let outputReplaced = false
  await assert.rejects(runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: failedOutput.archiveStore, contract: failedOutput.contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: join(failedOutput.root, 'trust.json'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    cacheLifecycle: {
      beforeDirectoryRetirement: async ({ path }) => {
        if (!outputReplaced && path === failedOutputDirectory) {
          await mkdir(failedOutputDirectory)
          await writeFile(join(failedOutputDirectory, 'foreign-sentinel'), 'output replacement')
          outputReplaced = true
        }
      },
    },
    spawnProcess: async (_file, _args, options) => {
      failedOutputDirectory = options.env.WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY
      throw new Error('fixture package failure before result')
    },
    verifyPackage: async () => { throw new Error('must not verify failed output') },
  }), /fixture package failure.*replaced during retirement|replaced during retirement.*fixture package failure/i)
  assert.equal(outputReplaced, true)
  assert.equal(await readFile(join(failedOutputDirectory, 'foreign-sentinel'), 'utf8'), 'output replacement')

  const recovery = await makeFixture('recovery')
  let abandonedCache
  await assert.rejects(invoke(recovery, 'abandoned', {
    cleanupTimeoutMs: 10,
    beforeDirectoryQuarantine: () => new Promise(() => {}),
  }, (options) => { abandonedCache = options.env.ELECTRON_BUILDER_CACHE }), /cleanup timed out/i)
  let recoveryReplaced = false
  await assert.rejects(invoke(recovery, 'must-not-spawn', {
    beforeDirectoryRetirement: async ({ path }) => {
      if (!recoveryReplaced && path === abandonedCache) {
        await mkdir(abandonedCache)
        await writeFile(join(abandonedCache, 'foreign-sentinel'), 'recovery replacement')
        recoveryReplaced = true
      }
    },
  }, () => { throw new Error('recovery replacement must fail before spawn') }), /replaced during retirement/i)
  assert.equal(recoveryReplaced, true)
  assert.equal(await readFile(join(abandonedCache, 'foreign-sentinel'), 'utf8'), 'recovery replacement')
})

test('package result rejects an artifact that reaches outside through an intermediate symlink', async (t) => {
  const {
    loadWorldFfmpegPackageResult,
    loadWorldFfmpegPackageToolLock,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-result-ancestor-symlink-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const attemptId = '1234567890abcdef1234567890abcdef'
  const output = join(root, `output-${attemptId}`)
  const outside = join(root, 'outside')
  await mkdir(output)
  await mkdir(outside)
  await writeFile(join(outside, 'artifact.bin'), 'outside')
  await symlink(outside, join(output, 'linked'))
  const runner = require('./world-ffmpeg-electron-builder-runner.cjs')
  await assert.rejects(
    runner._testOnlyRequireContainedArtifacts(
      [join(output, 'linked', 'artifact.bin')], output, undefined,
      runSerializedWorldFfmpegOutputCustody,
    ),
    /direct child|artifact path/i,
  )
  await writeFile(join(output, 'Modly-*.bin'), 'glob-must-not-reach-workflow')
  await assert.rejects(
    runner._testOnlyRequireContainedArtifacts(
      [join(output, 'Modly-*.bin')], output, undefined,
      runSerializedWorldFfmpegOutputCustody,
    ),
    /workflow-safe/i,
  )
  await link(join(outside, 'artifact.bin'), join(output, 'hardlinked.bin'))
  await assert.rejects(
    runner._testOnlyRequireContainedArtifacts(
      [join(output, 'hardlinked.bin')], output, undefined,
      runSerializedWorldFfmpegOutputCustody,
    ),
    /exclusive|ordinary/i,
  )
  const bytes = await readFile(join(outside, 'artifact.bin'))
  const buildReportBytes = Buffer.from('{"attemptOwned":true}\n')
  const buildReportName = 'WORLD_FFMPEG_BUILD_REPORT.linux-x64.v1.json'
  const resultName = 'RESULT.linux-x64.v1.json'
  const publicationToken = 'abcdefabcdefabcdefabcdefabcdefab'
  await writeFile(join(output, buildReportName), buildReportBytes)
  const artifactInfo = await lstat(join(outside, 'artifact.bin'), { bigint: true })
  const reportInfo = await lstat(join(output, buildReportName), { bigint: true })
  const outputInfo = await lstat(output, { bigint: true })
  const outputIdentity = { dev: String(outputInfo.dev), ino: String(outputInfo.ino) }
  const resultValue = {
    schema: 'modly.electron-builder-package-result.v1', attemptId, target: 'linux-x64', publicationToken,
    outputIdentity,
    artifacts: [{
      path: 'linked/artifact.bin', dev: String(artifactInfo.dev), ino: String(artifactInfo.ino), size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
    buildReport: {
      path: buildReportName, dev: String(reportInfo.dev), ino: String(reportInfo.ino), size: buildReportBytes.byteLength,
      sha256: createHash('sha256').update(buildReportBytes).digest('hex'),
    },
    inspection: {
      schema: 'modly.world-ffmpeg-artifact-inspection.v1', target: 'linux-x64',
      artifact: { path: 'linked/artifact.bin', dev: String(artifactInfo.dev), ino: String(artifactInfo.ino), size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') },
      runtimeManifestSha256: 'a'.repeat(64),
      buildReportSha256: createHash('sha256').update(buildReportBytes).digest('hex'),
      extractor: fakeExtractorProof((await loadWorldFfmpegPackageToolLock()).extractors['linux-x64']),
    },
  }
  const resultBytes = Buffer.from(`${JSON.stringify(resultValue)}\n`)
  const resultPath = join(output, resultName)
  await writeFile(resultPath, resultBytes)
  const resultInfo = await lstat(resultPath, { bigint: true })
  const resultReceipt = {
    schema: 'modly.electron-builder-package-result-receipt.v1', attemptId,
    target: 'linux-x64', publicationToken, manifestPath: resultPath, outputIdentity,
    manifestFile: {
      name: resultName, dev: String(resultInfo.dev), ino: String(resultInfo.ino),
      size: resultBytes.byteLength, sha256: createHash('sha256').update(resultBytes).digest('hex'),
    },
  }
  await assert.rejects(loadWorldFfmpegPackageResult(resultPath, {
    resultReceipt,
    outputCustody: runSerializedWorldFfmpegOutputCustody,
  }), /artifact path|direct child|invalid/i)
})

test('artifact substitution after emitted-resource verification is rejected before RESULT publication', async (t) => {
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-artifact-substitution-'))
  const archiveStore = join(root, 'archives')
  await mkdir(archiveStore)
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    await mkdir(join(archiveStore, entry.release), { recursive: true })
    await writeFile(join(archiveStore, entry.release, entry.filename), bytes)
  }
  let outputDirectory
  await assert.rejects(runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    spawnProcess: async (_file, _args, options) => {
      outputDirectory = options.env.WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY
      await publishFakePackageRunnerSuccess(options, 'substituted')
      return { code: 0, signal: null }
    },
    verifyPackage: approveFakePackageVerification,
    inspectArtifacts: async (request) => {
      const name = request.artifacts.find((entry) => entry.endsWith('.AppImage'))
      const path = join(request.outputDirectory, name)
      const bytes = await readFile(path)
      const info = await lstat(path, { bigint: true })
      await writeFile(path, 'foreign artifact after pre-verification')
      return {
        schema: 'modly.world-ffmpeg-artifact-inspection.v1', target: request.target,
        artifact: {
          path: name, dev: String(info.dev), ino: String(info.ino), size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        runtimeManifestSha256: request.expectedRuntimeManifestSha256,
        buildReportSha256: request.buildReportReceipt.sha256,
        extractor: fakeExtractorProof(request.extractor),
      }
    },
  }), /artifact inspection receipt|artifact changed|inspection/i)
  if (outputDirectory) await assert.rejects(lstat(outputDirectory), /ENOENT/)
})

test('runner artifact custody rejects a transient output-root swap and restore', async (t) => {
  const fs = require('node:fs')
  const runner = require('./world-ffmpeg-electron-builder-runner.cjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runner-root-aba-'))
  const output = join(root, 'output')
  const foreign = join(root, 'foreign')
  const displaced = join(root, 'displaced')
  await mkdir(output)
  await mkdir(foreign)
  await writeFile(join(output, 'Modly.bin'), 'A')
  await writeFile(join(foreign, 'Modly.bin'), 'B')
  t.after(() => rm(root, { recursive: true, force: true }))
  const outputReceipt = await runSerializedWorldFfmpegOutputCustody({
    operation: 'directory', directory: output, segments: [],
  })
  let swapCount = 0
  const swappingCustody = (input) => runSerializedWorldFfmpegOutputCustody(input, {
    beforeEnter() {
      fs.renameSync(output, displaced)
      fs.renameSync(foreign, output)
      swapCount += 1
    },
    afterRootOpen() {
      fs.renameSync(output, foreign)
      fs.renameSync(displaced, output)
    },
  })
  await assert.rejects(runner._testOnlyRequireContainedArtifacts(
    [join(output, 'Modly.bin')],
    output,
    outputReceipt.rootIdentity,
    swappingCustody,
  ), /root identity|custody|changed/i)
  assert.equal(swapCount, 1)
  assert.equal(await readFile(join(output, 'Modly.bin'), 'utf8'), 'A')
})

test('build-report verifier custody rejects a transient resources-root swap and restore', async (t) => {
  const fs = require('node:fs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-report-root-aba-'))
  const resources = join(root, 'resources')
  const foreign = join(root, 'foreign')
  const displaced = join(root, 'displaced')
  for (const directory of [resources, foreign]) {
    await mkdir(join(directory, 'world-ffmpeg-build-reports'), { recursive: true })
  }
  await writeFile(join(resources, 'world-ffmpeg-build-reports', 'linux-x64.json'), '{"report":"A"}\n')
  await writeFile(join(foreign, 'world-ffmpeg-build-reports', 'linux-x64.json'), '{"report":"B"}\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  const authority = await runSerializedWorldFfmpegOutputCustody({
    operation: 'directory', directory: resources, segments: [],
  })
  let swapCount = 0
  const swappingCustody = (input) => runSerializedWorldFfmpegOutputCustody(input, {
    beforeEnter() {
      fs.renameSync(resources, displaced)
      fs.renameSync(foreign, resources)
      swapCount += 1
    },
    afterRootOpen() {
      fs.renameSync(resources, foreign)
      fs.renameSync(displaced, resources)
    },
  })
  await assert.rejects(swappingCustody({
    operation: 'read', directory: resources,
    expectedDirectoryIdentity: authority.rootIdentity,
    segments: ['world-ffmpeg-build-reports'], name: 'linux-x64.json',
    maximumBytes: 1024 * 1024,
  }), /root identity changed/i)
  assert.equal(swapCount, 1)
  assert.equal(await readFile(join(
    resources, 'world-ffmpeg-build-reports', 'linux-x64.json',
  ), 'utf8'), '{"report":"A"}\n')
})

test('package publication rejects a replaced output root despite a valid runner terminal token', async (t) => {
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-output-root-swap-'))
  const archiveStore = join(root, 'archives')
  await mkdir(archiveStore)
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    await mkdir(join(archiveStore, entry.release), { recursive: true })
    await writeFile(join(archiveStore, entry.release, entry.filename), bytes)
  }
  let replacementOutput
  await assert.rejects(runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    spawnProcess: async (_file, _args, options) => {
      await publishFakePackageRunnerSuccess(options, 'root-swap')
      const output = options.env.WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY
      await rename(output, `${output}.displaced`)
      await mkdir(output)
      replacementOutput = output
      await writeFile(join(output, 'foreign-sentinel'), 'preserve')
      return { code: 0, signal: null }
    },
    verifyPackage: async () => { throw new Error('replaced output must fail before verification') },
  }), /runner terminal receipt is invalid|root identity changed/i)
  assert.equal(await readFile(join(replacementOutput, 'foreign-sentinel'), 'utf8'), 'preserve')
})

test('package publication rejects a build-report ancestor swapped after independent verification starts', async (t) => {
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-report-ancestor-swap-'))
  const archiveStore = join(root, 'archives')
  await mkdir(archiveStore)
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    await mkdir(join(archiveStore, entry.release), { recursive: true })
    await writeFile(join(archiveStore, entry.release, entry.filename), bytes)
  }
  await assert.rejects(runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    spawnProcess: async (_file, _args, options) => {
      await publishFakePackageRunnerSuccess(options, 'ancestor-swap')
      return { code: 0, signal: null }
    },
    verifyPackage: async (request) => {
      const { resourcesPath, resourcesIdentity } = request
      const reportRoot = join(resourcesPath, 'world-ffmpeg-build-reports')
      const outside = join(root, 'outside-report')
      await mkdir(outside)
      await writeFile(join(outside, 'linux-x64.json'), '{"foreign":true}\n')
      await rm(reportRoot, { recursive: true })
      await symlink(outside, reportRoot)
      await runSerializedWorldFfmpegOutputCustody({
        operation: 'read', directory: resourcesPath,
        expectedDirectoryIdentity: resourcesIdentity,
        segments: ['world-ffmpeg-build-reports'], name: 'linux-x64.json',
        maximumBytes: 1024 * 1024,
      })
      return approveFakePackageVerification(request)
    },
  }), /ancestor|build report changed|invalid|directory/i)
})

test('package result rejects build-report A to B to A verification ambiguity', async (t) => {
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-report-aba-'))
  const archiveStore = join(root, 'archives')
  await mkdir(archiveStore)
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    await mkdir(join(archiveStore, entry.release), { recursive: true })
    await writeFile(join(archiveStore, entry.release, entry.filename), bytes)
  }
  await assert.rejects(runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    spawnProcess: async (_file, _args, options) => {
      await publishFakePackageRunnerSuccess(options, 'report-aba')
      return { code: 0, signal: null }
    },
    verifyPackage: async (request) => {
      const { buildReportDirectory, buildReportName } = request
      const snapshotPath = join(buildReportDirectory, buildReportName)
      const original = await readFile(snapshotPath)
      const replacement = Buffer.from(original)
      replacement[0] = replacement[0] === 0x7b ? 0x5b : 0x7b
      await writeFile(snapshotPath, replacement)
      const verifierObserved = await readFile(snapshotPath)
      const verifierInfo = await lstat(snapshotPath, { bigint: true })
      await writeFile(snapshotPath, original)
      assert.deepEqual(await readFile(snapshotPath), original)
      assert.notDeepEqual(verifierObserved, original)
      return {
        ok: true,
        buildReportReceipt: {
          name: buildReportName,
          dev: String(verifierInfo.dev),
          ino: String(verifierInfo.ino),
          size: verifierObserved.byteLength,
          sha256: createHash('sha256').update(verifierObserved).digest('hex'),
        },
      }
    },
  }), /verification receipt|exact snapshot/i)
})

test('runner heartbeat preserves a replacement path and reports refresh failure before terminal success', async (t) => {
  const runner = require('./world-ffmpeg-electron-builder-runner.cjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runner-heartbeat-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const heartbeatPath = join(root, 'runner-0123456789abcdef0123456789abcdef.heartbeat')
  const terminalPath = join(root, 'terminal-0123456789abcdef0123456789abcdef.json')
  const attempt = {
    attemptId: '0123456789abcdef0123456789abcdef', target: 'linux-x64',
    outputDirectory: join(root, 'output-0123456789abcdef0123456789abcdef'),
    heartbeatPath, terminalPath,
  }
  const heartbeat = runner._testOnlyStartRunnerHeartbeat(
    attempt, '11111111111111111111111111111111', 'linux-proc-start:1', { intervalMs: 5 },
  )
  const original = await readFile(heartbeatPath)
  await rm(heartbeatPath)
  await writeFile(heartbeatPath, 'replacement-must-survive')
  assert.throws(() => heartbeat.stop(), /identity changed/i)
  assert.equal(await readFile(heartbeatPath, 'utf8'), 'replacement-must-survive')
  assert.match(original.toString('utf8'), /runnerIdentity/)

  const failedPath = join(root, 'runner-fedcba9876543210fedcba9876543210.heartbeat')
  const failed = runner._testOnlyStartRunnerHeartbeat({
    ...attempt, attemptId: 'fedcba9876543210fedcba9876543210', heartbeatPath: failedPath,
  }, '22222222222222222222222222222222', 'unavailable', {
    intervalMs: 5,
    futimesSync() { throw new Error('fixture futimes failure') },
  })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 15))
  assert.throws(() => failed.assertHealthy(), /heartbeat refresh failed/i)
  assert.throws(() => failed.stop(), /heartbeat refresh failed/i)
})

test('bootstrap delegates signal and bounded process-tree custody to the shared authority', async () => {
  const { worldFfmpegNestedPackageProcessLifecycle } = await import('./world-ffmpeg-offline-package.mjs')
  const source = await readFile(new URL('./world-ffmpeg-package-bootstrap.mjs', import.meta.url), 'utf8')
  const offline = await readFile(new URL('./world-ffmpeg-offline-package.mjs', import.meta.url), 'utf8')
  const tools = await readFile(new URL('./world-ffmpeg-package-tools.mjs', import.meta.url), 'utf8')
  assert.match(source, /spawnWorldFfmpegPackageProcess/)
  assert.doesNotMatch(source, /function spawnPackageNode/)
  assert.match(offline, /worldFfmpegNestedPackageProcessLifecycle/)
  assert.match(tools, /detached:\s*packageTarget\.platform !== 'win32'\s*&& processLifecycle\.processGroupId === undefined/)
  assert.deepEqual(worldFfmpegNestedPackageProcessLifecycle(
    'linux', 42_424, 'modly.world-ffmpeg-package-bootstrap.v2',
  ), { processGroupId: 42_424 })
  assert.deepEqual(worldFfmpegNestedPackageProcessLifecycle(
    'win32', 42_424, 'modly.world-ffmpeg-package-bootstrap.v2',
  ), {})
  assert.throws(
    () => worldFfmpegNestedPackageProcessLifecycle('linux', 42_424),
    /bootstrap authority/i,
  )
})

test('executable bootstrap termination kills the exact POSIX offline-runner tree within bounds', async (t) => {
  if (process.platform !== 'linux') return t.skip('POSIX process-group proof runs on Linux.')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-bootstrap-custody-'))
  const readyPath = join(root, 'runner-ready.json')
  const cacheSentinel = join(root, 'cache-sentinel')
  const outputSentinel = join(root, 'output-sentinel')
  const runnerPath = join(root, 'runner.mjs')
  const offlinePath = join(root, 'offline.mjs')
  const harnessPath = join(root, 'bootstrap-harness.mjs')
  const bootstrapPath = fileURLToPath(new URL('./world-ffmpeg-package-bootstrap.mjs', import.meta.url))
  const offlinePackagePath = fileURLToPath(new URL('./world-ffmpeg-offline-package.mjs', import.meta.url))
  const custodyPath = fileURLToPath(new URL('./world-ffmpeg-process-custody.mjs', import.meta.url))
  const electron = fileURLToPath(new URL('../node_modules/electron/dist/electron', import.meta.url))
  await writeFile(cacheSentinel, 'owned-cache')
  await writeFile(outputSentinel, 'owned-output')
  await writeFile(runnerPath, `
import fs from 'node:fs'
process.on('SIGTERM', () => {})
const stat = fs.readFileSync('/proc/self/stat', 'utf8')
const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)
fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({
  pid: process.pid, parentPid: process.ppid, groupPid: Number(fields[2]),
}))
setInterval(() => {}, 1_000)
`)
  await writeFile(offlinePath, `
import { spawnWorldFfmpegPackageProcess } from ${JSON.stringify(custodyPath)}
import { worldFfmpegNestedPackageProcessLifecycle } from ${JSON.stringify(offlinePackagePath)}
const lifecycle = worldFfmpegNestedPackageProcessLifecycle(
  'linux', process.pid, 'modly.world-ffmpeg-package-bootstrap.v2',
)
void spawnWorldFfmpegPackageProcess(process.execPath, [${JSON.stringify(runnerPath)}], {
  stdio: 'ignore', shell: false, detached: lifecycle.processGroupId === undefined,
}, {
  ...lifecycle, platform: 'linux', executionTimeoutMs: 60_000,
  terminationGraceMs: 25, closeWaitMs: 100,
})
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
`)
  await writeFile(harnessPath, `
import { spawn } from 'node:child_process'
import { runWorldFfmpegPackageBootstrap } from ${JSON.stringify(bootstrapPath)}
const electron = ${JSON.stringify(electron)}
try {
  await runWorldFfmpegPackageBootstrap({
    runtime: { platform: 'linux', arch: 'x64', execPath: electron, electronVersion: '44.1.1' },
    execArgv: [], argv: [electron, ${JSON.stringify(bootstrapPath)}],
    environment: {
      ELECTRON_BUILDER_CACHE: ${JSON.stringify(root)}, ELECTRON_RUN_AS_NODE: '1',
      LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC',
      WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE: electron,
      WORLD_FFMPEG_BUILD_TRUST_FILE: ${JSON.stringify(join(root, 'trust.json'))},
      WORLD_FFMPEG_CLEAN_BOOTSTRAP: 'modly.world-ffmpeg-package-bootstrap.v1',
    },
    processLifecycle: {
      terminationGraceMs: 25, closeWaitMs: 100,
      spawnNative(_file, _args, options) {
        return spawn(process.execPath, [${JSON.stringify(offlinePath)}], options)
      },
    },
  })
} catch (error) {
  process.stderr.write(String(error && error.message || error) + '\\n')
  process.exitCode = 7
}
`)
  let groupPid
  const bootstrap = spawn(process.execPath, [harnessPath], { stdio: ['ignore', 'ignore', 'pipe'] })
  t.after(async () => {
    if (groupPid) try { process.kill(-groupPid, 'SIGKILL') } catch { /* already dead */ }
    try { process.kill(bootstrap.pid, 'SIGKILL') } catch { /* already dead */ }
    await rm(root, { recursive: true, force: true })
  })
  let stderr = ''
  bootstrap.stderr.on('data', (chunk) => { stderr += chunk })
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const ready = JSON.parse(await readFile(readyPath, 'utf8'))
      groupPid = ready.groupPid
      assert.equal(ready.groupPid, ready.parentPid)
      assert.equal((await lstat(cacheSentinel)).isFile(), true)
      assert.equal((await lstat(outputSentinel)).isFile(), true)
      break
    } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 10)) }
  }
  assert.ok(groupPid, 'runner heartbeat fixture never became ready')
  const runnerPid = JSON.parse(await readFile(readyPath, 'utf8')).pid
  const closed = new Promise((resolvePromise) => bootstrap.once('close', (code, signal) => resolvePromise({ code, signal })))
  const startedAt = Date.now()
  process.kill(bootstrap.pid, 'SIGTERM')
  const outcome = await Promise.race([
    closed,
    new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error('bootstrap public wait was unbounded')), 1_000)),
  ])
  assert.equal(outcome.code, 7, stderr)
  assert.equal(outcome.signal, null, stderr)
  assert.ok(Date.now() - startedAt < 1_000)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(runnerPid, 0); await new Promise((resolvePromise) => setTimeout(resolvePromise, 10)) } catch { break }
  }
  assert.throws(() => process.kill(runnerPid, 0), /ESRCH/)
})

test('orphan recovery removes only stale exact cache-output pairs and preserves results and symlinks', async (t) => {
  const {
    loadWorldFfmpegPackageResult,
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
    worldFfmpegMutablePackageCacheRootFor,
    worldFfmpegPackageOutputRootFor,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-orphan-recovery-'))
  const archiveStore = join(root, 'archives')
  await mkdir(archiveStore)
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    await mkdir(join(archiveStore, entry.release), { recursive: true })
    await writeFile(join(archiveStore, entry.release, entry.filename), bytes)
  }
  const invoke = (label) => runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    cacheLifecycle: {
      heartbeatIntervalMs: 5, heartbeatFreshMs: 50,
      now: () => Date.now() + 120_000,
    },
    spawnProcess: async (_file, _args, options) => {
      await publishFakePackageRunnerSuccess(options, label)
      return { code: 0, signal: null }
    },
    verifyPackage: approveFakePackageVerification,
    inspectArtifacts: approveFakeArtifactInspection,
  })
  const published = await invoke('published')
  const cacheRoot = worldFfmpegMutablePackageCacheRootFor(archiveStore)
  const outputRoot = worldFfmpegPackageOutputRootFor(archiveStore)
  const orphan = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const orphanCache = join(cacheRoot, `cache-${orphan}`)
  const orphanOutput = join(outputRoot, `output-${orphan}`)
  await mkdir(orphanCache)
  await mkdir(orphanOutput)
  await writeFile(join(outputRoot, `output-${orphan}`, 'partial'), 'partial')
  const orphanCacheInfo = await lstat(orphanCache, { bigint: true })
  const orphanOutputInfo = await lstat(orphanOutput, { bigint: true })
  await writeFile(join(cacheRoot, `terminal-${orphan}.json`), `${JSON.stringify({
    schema: 'modly.electron-builder-package-runner-terminal.v1',
    attemptId: orphan,
    target: 'linux-x64',
    runnerIdentity: '33333333333333333333333333333333',
    runnerPid: 4_000_000_000,
    processStartIdentity: 'linux-proc-start:1',
    cacheIdentity: { dev: String(orphanCacheInfo.dev), ino: String(orphanCacheInfo.ino) },
    outputIdentity: { dev: String(orphanOutputInfo.dev), ino: String(orphanOutputInfo.ino) },
    status: 'failed',
    artifacts: [],
  })}\n`)
  const unbound = 'cccccccccccccccccccccccccccccccc'
  await mkdir(join(cacheRoot, `cache-${unbound}`))
  await mkdir(join(outputRoot, `output-${unbound}`))
  const foreign = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  await symlink(root, join(cacheRoot, `cache-${foreign}`))
  await mkdir(join(outputRoot, `output-${foreign}`))
  await invoke('recovery')
  await assert.rejects(lstat(join(cacheRoot, `cache-${orphan}`)), /ENOENT/)
  await assert.rejects(lstat(join(outputRoot, `output-${orphan}`)), /ENOENT/)
  assert.equal((await lstat(join(cacheRoot, `cache-${unbound}`))).isDirectory(), true)
  assert.equal((await lstat(join(outputRoot, `output-${unbound}`))).isDirectory(), true)
  assert.equal((await lstat(join(cacheRoot, `cache-${foreign}`))).isSymbolicLink(), true)
  assert.equal((await lstat(join(outputRoot, `output-${foreign}`))).isDirectory(), true)
  assert.equal((await loadWorldFfmpegPackageResult(published.resultManifestPath, {
    resultReceipt: published.resultReceipt,
    outputCustody: runSerializedWorldFfmpegOutputCustody,
  })).attemptId, published.attemptId)
})

test('package runner cancellation retains late custody and forwards exact process-tree termination', async () => {
  const { _testOnlySpawnPackageProcess } = await import('./world-ffmpeg-package-tools.mjs')
  const child = new EventEmitter()
  child.pid = 42_424
  child.unrefCount = 0
  child.unref = () => { child.unrefCount += 1 }
  const signalSource = new EventEmitter()
  const kills = []
  let lateCloseCount = 0
  let lateCloseError
  const result = _testOnlySpawnPackageProcess('/audited/electron', ['/audited/runner'], {
    cwd: '/audited/repository', env: {}, shell: false, detached: true, windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  }, {
    platform: 'linux', signalSource,
    terminationGraceMs: 5, closeWaitMs: 15,
    spawnNative: () => child,
    killProcessGroup: (pid, signal) => { kills.push([pid, signal]) },
    onLateClose: async () => {
      lateCloseCount += 1
      throw new Error('injected late cleanup failure')
    },
    onLateCloseError: async (error) => { lateCloseError = error.message },
  })
  child.emit('spawn')
  signalSource.emit('SIGTERM')
  await assert.rejects(result, (error) => {
    assert.equal(error?.custodyUnsettled, true)
    return /termination.*timed out/i.test(String(error?.message))
  })
  assert.deepEqual(kills, [[-42_424, 'SIGTERM'], [-42_424, 'SIGKILL']])
  assert.equal(child.unrefCount, 0)
  assert.equal(signalSource.listenerCount('SIGINT'), 0)
  assert.equal(signalSource.listenerCount('SIGTERM'), 0)
  assert.equal(signalSource.listenerCount('SIGHUP'), 0)
  assert.doesNotThrow(() => child.emit('error', new Error('late kill error')))
  assert.doesNotThrow(() => child.emit('error', new Error('repeated late error')))
  child.emit('close', null, 'SIGKILL')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(lateCloseCount, 1)
  assert.equal(lateCloseError, 'injected late cleanup failure')
  child.emit('close', null, 'SIGKILL')
  assert.equal(lateCloseCount, 1)

  const windowsChild = new EventEmitter()
  windowsChild.pid = 9_191
  windowsChild.unref = () => undefined
  const windowsSignals = new EventEmitter()
  const taskkill = []
  const windowsResult = _testOnlySpawnPackageProcess('C:\\repo\\electron.exe', [], {
    cwd: 'C:\\repo',
    env: {
      SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32;C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    shell: false, detached: false, windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  }, {
    platform: 'win32', signalSource: windowsSignals,
    terminationGraceMs: 5, closeWaitMs: 15,
    spawnNative: () => windowsChild,
    spawnTreeKiller: (file, args, options) => {
      taskkill.push({ file, args, options })
      const killer = new EventEmitter()
      killer.unref = () => undefined
      queueMicrotask(() => killer.emit('close', 0, null))
      return killer
    },
    onLateClose: async () => undefined,
  })
  windowsChild.emit('spawn')
  windowsSignals.emit('SIGINT')
  await assert.rejects(windowsResult, /termination.*timed out/i)
  assert.equal(taskkill.length, 2)
  assert.equal(taskkill[0].file, 'C:\\Windows\\System32\\taskkill.exe')
  assert.deepEqual(taskkill[0].args, ['/PID', '9191', '/T'])
  assert.deepEqual(taskkill[1].args, ['/PID', '9191', '/T', '/F'])
  assert.equal(taskkill.every(({ options }) => options.shell === false
    && options.detached === false && options.windowsHide === true), true)
})

test('package process watchdog terminates a stalled tree without an external signal', async () => {
  const { _testOnlySpawnPackageProcess } = await import('./world-ffmpeg-package-tools.mjs')
  const { WORLD_FFMPEG_PACKAGE_EXECUTION_TIMEOUT_MS } = await import('./world-ffmpeg-process-custody.mjs')
  assert.equal(WORLD_FFMPEG_PACKAGE_EXECUTION_TIMEOUT_MS, 2 * 60 * 60 * 1_000)
  let invalidSpawned = false
  await assert.rejects(_testOnlySpawnPackageProcess('/audited/electron', [], {}, {
    executionTimeoutMs: 4 * 60 * 60 * 1_000 + 1,
    spawnNative: () => { invalidSpawned = true; return new EventEmitter() },
  }), /execution watchdog is invalid/i)
  assert.equal(invalidSpawned, false)
  const child = new EventEmitter()
  child.pid = 65_432
  const kills = []
  const result = _testOnlySpawnPackageProcess('/audited/electron', [], {
    env: {}, detached: true, shell: false,
  }, {
    platform: 'linux', spawnNative: () => child,
    executionTimeoutMs: 5, terminationGraceMs: 5, closeWaitMs: 10,
    killProcessGroup: (pid, signal) => kills.push([pid, signal]),
  })
  child.emit('spawn')
  await assert.rejects(result, (error) => error?.custodyUnsettled === true && /watchdog|timed out/i.test(error.message))
  assert.deepEqual(kills, [[-65_432, 'SIGTERM'], [-65_432, 'SIGKILL']])
})

test('offline package production path applies the watchdog and publishes no false success', async (t) => {
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-production-watchdog-'))
  const archiveStore = join(root, 'archives')
  await mkdir(archiveStore)
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    await mkdir(join(archiveStore, entry.release), { recursive: true })
    await writeFile(join(archiveStore, entry.release, entry.filename), bytes)
  }
  const child = new EventEmitter()
  child.pid = 54_321
  const kills = []
  const operation = runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    processLifecycle: {
      executionTimeoutMs: 5,
      terminationGraceMs: 5,
      closeWaitMs: 50,
      spawnNative: () => {
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
      killProcessGroup: (pid, signal) => {
        kills.push([pid, signal])
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
      },
    },
    verifyPackage: async () => { throw new Error('watchdog failure must not verify or publish') },
  })
  await assert.rejects(operation, /exceeded its execution watchdog/i)
  assert.deepEqual(kills, [[-54_321, 'SIGTERM'], [-54_321, 'SIGKILL']])
})

test('referenced late-close supervisor completes cleanup before a normal parent exits', async (t) => {
  if (process.platform !== 'linux') return t.skip('Referenced child custody proof runs on Linux.')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-late-supervisor-'))
  const childScript = join(root, 'child.mjs')
  const harness = join(root, 'harness.mjs')
  const marker = join(root, 'cleanup-complete')
  const custody = fileURLToPath(new URL('./world-ffmpeg-process-custody.mjs', import.meta.url))
  await writeFile(childScript, `setTimeout(() => process.exit(0), 80)\n`)
  await writeFile(harness, `
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { spawnWorldFfmpegPackageProcess } from ${JSON.stringify(custody)}
try {
  await spawnWorldFfmpegPackageProcess(process.execPath, [${JSON.stringify(childScript)}], {
    env: process.env, detached: true, shell: false, stdio: 'ignore',
  }, {
    platform: 'linux', executionTimeoutMs: 5, terminationGraceMs: 5, closeWaitMs: 5,
    killProcessGroup() {},
    async onLateClose() { await writeFile(${JSON.stringify(marker)}, 'complete') },
  })
} catch { /* public timeout is expected; referenced child still owns late cleanup */ }
`)
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await new Promise((resolvePromise) => {
    execFile(process.execPath, [harness], { timeout: 2_000 }, (error, stdout, stderr) => {
      resolvePromise({ error, stdout, stderr })
    })
  })
  assert.equal(result.error, null, result.stderr)
  assert.equal(await readFile(marker, 'utf8'), 'complete')
})

test('never-closing package runner returns bounded failure while late close owns exact cleanup', async (t) => {
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
    worldFfmpegMutablePackageCacheRootFor,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const { writeFileSync } = require('node:fs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-late-runner-'))
  const archiveStore = join(root, 'immutable-archives')
  await mkdir(archiveStore)
  t.after(() => rm(root, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    const directory = join(archiveStore, entry.release)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, entry.filename), bytes)
  }
  const child = new EventEmitter()
  child.pid = 73_731
  child.unref = () => undefined
  const signals = new EventEmitter()
  let spawnedResolve
  const spawned = new Promise((resolvePromise) => { spawnedResolve = resolvePromise })
  let cacheDirectory
  let outputDirectory
  let lateCleanupErrorResolve
  const lateCleanupError = new Promise((resolvePromise) => { lateCleanupErrorResolve = resolvePromise })
  let replacementCreated = false
  const startedAt = Date.now()
  const operation = runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    cacheLifecycle: {
      cleanupTimeoutMs: 1_000,
      heartbeatIntervalMs: 5,
      heartbeatFreshMs: 50,
      processStartIdentity: async (pid) => pid === process.pid ? 'linux-proc-start:1' : null,
      beforeDirectoryRetirement: async ({ path }) => {
        if (!replacementCreated && path === cacheDirectory) {
          await mkdir(cacheDirectory)
          await writeFile(join(cacheDirectory, 'foreign-sentinel'), 'late replacement')
          replacementCreated = true
        }
      },
    },
    processLifecycle: {
      signalSource: signals,
      terminationGraceMs: 5,
      closeWaitMs: 10,
      killProcessGroup: () => undefined,
      onLateCloseError: (error) => { lateCleanupErrorResolve(error) },
      spawnNative: (_file, _args, options) => {
        cacheDirectory = options.env.ELECTRON_BUILDER_CACHE
        outputDirectory = options.env.WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY
        writeFileSync(options.env.WORLD_FFMPEG_PACKAGE_RUNNER_HEARTBEAT, `${JSON.stringify({
          schema: 'modly.electron-builder-package-runner-heartbeat.v1',
          attemptId: options.env.WORLD_FFMPEG_PACKAGE_ATTEMPT_ID,
          target: 'linux-x64',
          runnerIdentity: '22222222222222222222222222222222',
          runnerPid: child.pid,
          processStartIdentity: 'unavailable',
        })}\n`)
        queueMicrotask(() => { child.emit('spawn'); spawnedResolve() })
        return child
      },
    },
    verifyPackage: async () => { throw new Error('must not verify') },
  })
  await spawned
  signals.emit('SIGTERM')
  await assert.rejects(operation, (error) => error?.custodyUnsettled === true)
  assert.ok(Date.now() - startedAt < 500)
  assert.equal((await lstat(cacheDirectory)).isDirectory(), true)
  assert.equal((await lstat(outputDirectory)).isDirectory(), true)
  assert.ok((await readdir(worldFfmpegMutablePackageCacheRootFor(archiveStore)))
    .some((name) => name.startsWith('lease-')))
  assert.doesNotThrow(() => child.emit('error', new Error('late error before close')))
  child.emit('close', null, 'SIGKILL')
  const observedLateError = await Promise.race([
    lateCleanupError,
    new Promise((_, rejectPromise) => setTimeout(
      () => rejectPromise(new Error('late cleanup failure was not observable')),
      1_000,
    )),
  ])
  assert.match(observedLateError.message, /replaced during retirement/i)
  assert.equal(replacementCreated, true)
  assert.equal(await readFile(join(cacheDirectory, 'foreign-sentinel'), 'utf8'), 'late replacement')
  assert.equal((await lstat(outputDirectory)).isDirectory(), true)
  assert.ok((await readdir(worldFfmpegMutablePackageCacheRootFor(archiveStore))).some((name) => name.startsWith('lease-')))
})

test('outer crash preserves a fresh identity-bound runner and recovery ignores a reused PID', async (t) => {
  if (process.platform !== 'linux') return
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
    worldFfmpegMutablePackageCacheRootFor,
    worldFfmpegPackageOutputRootFor,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runner-custody-'))
  const archiveStore = join(root, 'immutable-archives')
  const readyPath = join(root, 'runner-ready.json')
  const releasePath = join(root, 'release-runner')
  const runnerScript = join(root, 'fake-runner.mjs')
  const outerScript = join(root, 'outer-package.mjs')
  await mkdir(archiveStore)
  t.after(async () => {
    try {
      const ready = JSON.parse(await readFile(readyPath, 'utf8'))
      process.kill(ready.pid, 'SIGKILL')
    } catch { /* already terminal */ }
    await rm(root, { recursive: true, force: true })
  })
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    const directory = join(archiveStore, entry.release)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, entry.filename), bytes)
  }
  await writeFile(runnerScript, `
import fs from 'node:fs'
import path from 'node:path'
const env = process.env
const attemptId = env.WORLD_FFMPEG_PACKAGE_ATTEMPT_ID
const heartbeat = env.WORLD_FFMPEG_PACKAGE_RUNNER_HEARTBEAT
const terminal = env.WORLD_FFMPEG_PACKAGE_RUNNER_TERMINAL
const output = env.WORLD_FFMPEG_PACKAGE_OUTPUT_DIRECTORY
const value = fs.readFileSync('/proc/self/stat', 'utf8')
const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\\s+/)
const processStartIdentity = 'linux-proc-start:' + fields[19]
const runnerIdentity = '11111111111111111111111111111111'
const heartbeatRecord = {
  schema: 'modly.electron-builder-package-runner-heartbeat.v1', attemptId,
  target: 'linux-x64', runnerIdentity, runnerPid: process.pid, processStartIdentity,
}
const descriptor = fs.openSync(heartbeat, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600)
fs.writeFileSync(descriptor, JSON.stringify(heartbeatRecord) + '\\n')
fs.fsyncSync(descriptor)
const timer = setInterval(() => fs.futimesSync(descriptor, new Date(), new Date()), 60_000)
fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({
  pid: process.pid, attemptId, cache: env.ELECTRON_BUILDER_CACHE, output, heartbeat, terminal,
}))
while (!fs.existsSync(${JSON.stringify(releasePath)})) await new Promise((resolve) => setTimeout(resolve, 10))
const artifact = path.join(output, 'Modly-runner.AppImage')
fs.writeFileSync(artifact, 'runner-owned-artifact')
const reportRoot = path.join(output, 'linux-unpacked', 'resources', 'world-ffmpeg-build-reports')
fs.mkdirSync(reportRoot, { recursive: true })
fs.writeFileSync(path.join(reportRoot, 'linux-x64.json'), '{"fixture":"runner"}\\n')
const terminalRecord = {
  schema: 'modly.electron-builder-package-runner-terminal.v1', attemptId,
  target: 'linux-x64', runnerIdentity, runnerPid: process.pid, processStartIdentity,
  cacheIdentity: (() => { const info = fs.lstatSync(env.ELECTRON_BUILDER_CACHE, { bigint: true }); return { dev: String(info.dev), ino: String(info.ino) } })(),
  outputIdentity: (() => { const info = fs.lstatSync(output, { bigint: true }); return { dev: String(info.dev), ino: String(info.ino) } })(),
  status: 'succeeded', artifacts: ['Modly-runner.AppImage'],
}
fs.writeFileSync(terminal, JSON.stringify(terminalRecord) + '\\n')
clearInterval(timer)
fs.closeSync(descriptor)
  fs.rmSync(heartbeat)
`)
  const modulePath = fileURLToPath(new URL('./world-ffmpeg-package-tools.mjs', import.meta.url))
  const outputCustodyModulePath = fileURLToPath(new URL('./world-ffmpeg-output-custody.mjs', import.meta.url))
  await writeFile(outerScript, `
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadWorldFfmpegPackageToolLock, runWorldFfmpegOfflinePackage } from ${JSON.stringify(modulePath)}
import { _testOnlyRunWorldFfmpegOutputCustodyInProcess as outputCustody } from ${JSON.stringify(outputCustodyModulePath)}
const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
for (const entry of contract.targets['linux-x64']) {
  const bytes = Buffer.from(\`tool:\${entry.release}:\${entry.filename}\`)
  entry.sha256 = createHash('sha256').update(bytes).digest('hex')
  entry.maximumBytes = 1024
}
await runWorldFfmpegOfflinePackage({
  target: 'linux-x64', cacheDirectory: ${JSON.stringify(archiveStore)}, contract,
  argv: ['--linux', '--publish', 'never'], buildTrustFile: ${JSON.stringify(join(root, 'trust.json'))},
  outputCustody,
  spawnProcess(_file, _args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [${JSON.stringify(runnerScript)}], options)
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
  },
  verifyPackage: async (request) => ({
    ok: true, buildReportReceipt: request.buildReportReceipt, runtimeManifestSha256: 'a'.repeat(64),
  }),
  inspectArtifacts: async (request) => {
    const name = request.artifacts.find((entry) => entry.endsWith('.AppImage'))
    const bytes = fs.readFileSync(path.join(request.outputDirectory, name))
    const info = fs.lstatSync(path.join(request.outputDirectory, name), { bigint: true })
    return {
      schema: 'modly.world-ffmpeg-artifact-inspection.v1', target: request.target,
      artifact: { path: name, dev: String(info.dev), ino: String(info.ino), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      runtimeManifestSha256: request.expectedRuntimeManifestSha256,
      buildReportSha256: request.buildReportReceipt.sha256,
      extractor: {
        ...request.extractor, source: { ...request.extractor.source }, dev: '1', ino: '1',
        preSpawn: { dev: '1', ino: '1', size: request.extractor.size, mtimeNs: '1', ctimeNs: '1' },
        postSpawn: { dev: '1', ino: '1', size: request.extractor.size, mtimeNs: '1', ctimeNs: '1' },
      },
    }
  },
})
`)
  const outer = spawn(process.execPath, [outerScript], { stdio: ['ignore', 'ignore', 'pipe'] })
  let outerStderr = ''
  outer.stderr.on('data', (chunk) => { outerStderr += chunk })
  let outerOutcome
  const outerClosed = new Promise((resolvePromise) => outer.once('exit', (code, signal) => {
    outerOutcome = { code, signal }
    resolvePromise(outerOutcome)
  }))
  let ready
  for (let attempt = 0; attempt < 1_000 && !outerOutcome; attempt += 1) {
    try { ready = JSON.parse(await readFile(readyPath, 'utf8')); break } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
  }
  assert.ok(ready, `outer runner fixture never became ready: ${JSON.stringify(outerOutcome)} ${outerStderr}`)
  process.kill(outer.pid, 'SIGKILL')
  await outerClosed

  const successfulAttempt = () => runWorldFfmpegOfflinePackage({
    target: 'linux-x64', cacheDirectory: archiveStore, contract,
    argv: ['--linux', '--publish', 'never'], buildTrustFile: join(root, 'trust.json'),
    outputCustody: runSerializedWorldFfmpegOutputCustody,
    spawnProcess: async (_file, _args, options) => {
      await publishFakePackageRunnerSuccess(options, 'custody-probe')
      return { code: 0, signal: null }
    },
    verifyPackage: approveFakePackageVerification,
    inspectArtifacts: approveFakeArtifactInspection,
  })
  const staleHeartbeat = new Date(Date.now() - 60_000)
  await utimes(ready.heartbeat, staleHeartbeat, staleHeartbeat)
  await successfulAttempt()
  assert.equal((await lstat(ready.cache)).isDirectory(), true)
  assert.equal((await lstat(ready.output)).isDirectory(), true)
  await writeFile(releasePath, 'release')
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { process.kill(ready.pid, 0); await new Promise((resolvePromise) => setTimeout(resolvePromise, 10)) } catch { break }
  }
  await successfulAttempt()
  await assert.rejects(lstat(ready.cache), /ENOENT/)
  await assert.rejects(lstat(ready.output), /ENOENT/)

  await rm(readyPath, { force: true })
  await rm(releasePath, { force: true })
  const reusedOuter = spawn(process.execPath, [outerScript], { stdio: ['ignore', 'ignore', 'pipe'] })
  let reusedOuterStderr = ''
  reusedOuter.stderr.on('data', (chunk) => { reusedOuterStderr += chunk })
  let reusedOuterOutcome
  const reusedOuterClosed = new Promise((resolvePromise) => reusedOuter.once('exit', (code, signal) => {
    reusedOuterOutcome = { code, signal }
    resolvePromise(reusedOuterOutcome)
  }))
  let reusedReady
  for (let attempt = 0; attempt < 1_000 && !reusedOuterOutcome; attempt += 1) {
    try { reusedReady = JSON.parse(await readFile(readyPath, 'utf8')); break } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
  }
  assert.ok(reusedReady, `reused outer runner fixture never became ready: ${JSON.stringify(reusedOuterOutcome)} ${reusedOuterStderr}`)
  process.kill(reusedOuter.pid, 'SIGKILL')
  process.kill(reusedReady.pid, 'SIGKILL')
  await reusedOuterClosed
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(reusedReady.pid, 0); await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)) } catch { break }
  }
  const cacheRoot = worldFfmpegMutablePackageCacheRootFor(archiveStore)
  const leasePath = join(cacheRoot, `lease-${reusedReady.attemptId}.json`)
  const outerHeartbeatPath = join(cacheRoot, `outer-${reusedReady.attemptId}.heartbeat`)
  const runnerHeartbeatBytes = await readFile(reusedReady.heartbeat)
  await rm(reusedReady.heartbeat)
  await symlink(leasePath, reusedReady.heartbeat)
  await assert.rejects(successfulAttempt(), /runner heartbeat identity is invalid/i)
  assert.equal((await lstat(reusedReady.cache)).isDirectory(), true)
  assert.equal((await lstat(reusedReady.output)).isDirectory(), true)
  await rm(reusedReady.heartbeat)
  const hardlinkSource = join(root, 'attacker-heartbeat-hardlink')
  await writeFile(hardlinkSource, runnerHeartbeatBytes)
  await link(hardlinkSource, reusedReady.heartbeat)
  await assert.rejects(successfulAttempt(), /runner heartbeat identity is invalid/i)
  assert.equal((await lstat(reusedReady.cache)).isDirectory(), true)
  assert.equal((await lstat(reusedReady.output)).isDirectory(), true)
  await rm(reusedReady.heartbeat)
  await rm(hardlinkSource)
  await writeFile(reusedReady.heartbeat, runnerHeartbeatBytes)
  const lease = JSON.parse(await readFile(leasePath, 'utf8'))
  lease.ownerPid = process.pid
  lease.ownerStartIdentity = 'linux-proc-start:0'
  await writeFile(leasePath, `${JSON.stringify(lease)}\n`)
  const heartbeat = JSON.parse(await readFile(outerHeartbeatPath, 'utf8'))
  heartbeat.ownerPid = process.pid
  heartbeat.processStartIdentity = 'linux-proc-start:0'
  await writeFile(outerHeartbeatPath, `${JSON.stringify(heartbeat)}\n`)
  await successfulAttempt()
  await assert.rejects(lstat(reusedReady.cache), /ENOENT/)
  await assert.rejects(lstat(reusedReady.output), /ENOENT/)
  assert.equal((await readdir(worldFfmpegPackageOutputRootFor(archiveStore))).length >= 1, true)
  assert.equal(outerStderr, '')
})

test('programmatic package runner rejects attacker execArgv before custody or builder loading', async () => {
  const runner = require('./world-ffmpeg-electron-builder-runner.cjs')
  const denyNetworkPath = fileURLToPath(new URL('./world-ffmpeg-deny-network.cjs', import.meta.url))
  let custodyCalled = false
  let loadedBuilder = false

  await assert.rejects(runner._testOnlyRunTrustedWorldFfmpegElectronBuilderWith({
    environment: Object.create(null),
    execArgv: ['--require=/attacker/preload.cjs', `--require=${denyNetworkPath}`],
    projectDirectory: process.cwd(),
    runtime: {
      platform: 'linux', arch: 'x64', execPath: process.execPath, electronVersion: '44.1.1',
    },
    outputCustody: async () => { custodyCalled = true; throw new Error('must not enter custody') },
    loadBuilder: () => { loadedBuilder = true; throw new Error('must not load') },
  }), /invalid execArgv authority/i)
  assert.equal(custodyCalled, false)
  assert.equal(loadedBuilder, false)
})

test('programmatic package runner never loads repo-root electron-builder.env or exposes helper overrides', async (t) => {
  if (!await requireExactAsyncPipeCapability(t)) return
  const {
    loadWorldFfmpegPackageToolLock,
    runWorldFfmpegOfflinePackage,
    verifyWorldFfmpegPackageToolCache,
  } = await import('./world-ffmpeg-package-tools.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-programmatic-builder-'))
  const cache = join(root, 'audited-cache')
  const project = join(root, 'project')
  await mkdir(cache)
  await mkdir(project)
  t.after(() => rm(root, { recursive: true, force: true }))

  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`tool:${entry.release}:${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
    const directory = join(cache, entry.release)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, entry.filename), bytes)
  }

  const overrideKeys = [
    'APPIMAGE_TOOLS_PATH', 'APP_BUILDER_TMP_DIR', 'CUSTOM_DMGBUILD_PATH', 'CUSTOM_FPM_PATH',
    'CUSTOM_NSIS_RESOURCES', 'ELECTRON_BUILDER_7ZIP_PATH', 'ELECTRON_BUILDER_BINARIES_ALLOW_HTTP',
    'ELECTRON_BUILDER_BINARIES_CUSTOM_DIR', 'ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL',
    'ELECTRON_BUILDER_BINARIES_MIRROR', 'ELECTRON_BUILDER_ICONS_TOOLSET_DIR',
    'ELECTRON_BUILDER_NSIS_DIR', 'ELECTRON_BUILDER_NSIS_RESOURCES_DIR',
    'ELECTRON_BUILDER_OSSL_SIGNCODE_PATH', 'ELECTRON_BUILDER_RCEDIT_PATH',
    'ELECTRON_BUILDER_WINDOWS_KITS_PATH', 'ELECTRON_BUILDER_WINE_TOOLSET_DIR',
    'ELECTRON_CUSTOM_DIR', 'ELECTRON_CUSTOM_FILENAME', 'ELECTRON_MIRROR',
    'MKSQUASHFS_PATH', 'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_CUSTOM_DIR',
    'NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR', 'SIGNTOOL_PATH', 'USE_SYSTEM_7ZA',
    'USE_SYSTEM_FPM', 'USE_SYSTEM_OSSLSIGNCODE', 'USE_SYSTEM_SIGNCODE', 'USE_SYSTEM_WINE',
    'XDG_CACHE_HOME',
  ]
  await writeFile(join(project, 'electron-builder.env'), `${overrideKeys.map((key) => `${key}=/attacker/${key}`).join('\n')}\n`)
  await writeFile(join(project, 'package.json'), `${JSON.stringify({
    name: 'attacker-project', version: '1.0.0',
    build: { beforePack: '/attacker/before.js', afterPack: '/attacker/after.js', electronDist: '/attacker/electron' },
  })}\n`)

  const helperPathKeys = [
    ['APPIMAGE_TOOLS_PATH', 'directory'], ['CUSTOM_DMGBUILD_PATH', 'file'],
    ['CUSTOM_FPM_PATH', 'file'], ['ELECTRON_BUILDER_7ZIP_PATH', 'file'],
    ['ELECTRON_BUILDER_ICONS_TOOLSET_DIR', 'directory'], ['ELECTRON_BUILDER_NSIS_DIR', 'directory'],
    ['ELECTRON_BUILDER_NSIS_RESOURCES_DIR', 'directory'], ['ELECTRON_BUILDER_OSSL_SIGNCODE_PATH', 'file'],
    ['ELECTRON_BUILDER_RCEDIT_PATH', 'file'], ['ELECTRON_BUILDER_WINDOWS_KITS_PATH', 'directory'],
    ['ELECTRON_BUILDER_WINE_TOOLSET_DIR', 'directory'], ['MKSQUASHFS_PATH', 'file'],
    ['SIGNTOOL_PATH', 'file'],
  ]
  const builderUtilPath = fileURLToPath(new URL('../node_modules/builder-util', import.meta.url))
  const harness = join(root, 'instrument-electron-builder.cjs')
  const runnerPath = fileURLToPath(new URL('./world-ffmpeg-electron-builder-runner.cjs', import.meta.url))
  const denyNetworkPath = fileURLToPath(new URL('./world-ffmpeg-deny-network.cjs', import.meta.url))
  await writeFile(harness, `'use strict'
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const Module = require('node:module')
const { resolveEnvToolsetPath } = require(${JSON.stringify(builderUtilPath)})
const envPath = path.resolve(process.cwd(), 'electron-builder.env')
let envRead = false
let spawnCount = 0
const spawnedCommands = []
const originalReadFile = fs.promises.readFile
fs.promises.readFile = async function auditedReadFile(file, ...args) {
  if (path.resolve(String(file)) === envPath) envRead = true
  return originalReadFile.call(this, file, ...args)
}
for (const name of ['spawn', 'exec', 'execFile', 'fork']) {
  const original = childProcess[name]
  childProcess[name] = function auditedSpawn(...args) {
    spawnCount += 1
    spawnedCommands.push({ name, file: String(args[0]), args: Array.isArray(args[1]) ? args[1] : null })
    return original.apply(this, args)
  }
}
const originalLoad = Module._load
Module._load = function auditedLoad(request, parent, isMain) {
  if (request === 'electron-builder') {
    const Platform = { MAC: 'darwin', LINUX: 'linux', WINDOWS: 'win32' }
    return {
      Platform,
      createTargets(platforms, type, arch) {
        return new Map([[platforms[0], new Map([[arch, type == null ? [] : [type]]])]])
      },
      async build(options) {
        const helperResolution = {}
        for (const [key, type] of ${JSON.stringify(helperPathKeys)}) {
          try { helperResolution[key] = { value: await resolveEnvToolsetPath(key, type), error: null } }
          catch (error) { helperResolution[key] = { value: null, error: String(error && error.message) } }
        }
        const privateArchive = path.join(process.env.ELECTRON_BUILDER_CACHE, '7zip@1.0.0', '7zip-linux-x64.tar.gz')
        fs.writeFileSync(privateArchive, 'builder-mutated-private-copy')
        fs.mkdirSync(path.join(process.env.ELECTRON_BUILDER_CACHE, '7zip@1.0.0', 'extracted-sibling'))
        const artifact = path.join(options.config.directories.output, 'Modly-fixture.AppImage')
        fs.writeFileSync(artifact, 'programmatic-builder-artifact')
        const reportRoot = path.join(options.config.directories.output, 'linux-unpacked', 'resources', 'world-ffmpeg-build-reports')
        fs.mkdirSync(reportRoot, { recursive: true })
        fs.writeFileSync(path.join(reportRoot, 'linux-x64.json'), '{"fixture":"programmatic-builder"}\\n')
        fs.writeSync(3, JSON.stringify({
          envFileExists: fs.existsSync(envPath), envRead, spawnCount, spawnedCommands,
          overrideEnvironment: Object.fromEntries(${JSON.stringify(overrideKeys)}.map((key) => [key, process.env[key] ?? null])),
          cache: process.env.ELECTRON_BUILDER_CACHE,
          helperResolution,
          projectDir: options.projectDir,
          publish: options.publish,
          configOutput: options.config.directories.output,
          config: options.config,
          targets: [...options.targets].map(([platform, arches]) => [platform, [...arches]]),
        }))
        return [artifact]
      },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const runner = require(${JSON.stringify(runnerPath)})
runner._testOnlyRunTrustedWorldFfmpegElectronBuilderWith({
  environment: process.env,
  execArgv: [${JSON.stringify(`--require=${denyNetworkPath}`)}],
  projectDirectory: process.cwd(),
  runtime: {
    platform: 'linux', arch: 'x64',
    execPath: ${JSON.stringify(process.execPath)}, electronVersion: '44.1.1',
  },
}).then(() => {}, (error) => {
  process.stderr.write(String(error && error.stack || error) + '\\n')
  process.exitCode = 1
})
`)

  const runInstrumentedPackage = async () => {
    let auditBytes = ''
    let childStderr = ''
    const result = await runWorldFfmpegOfflinePackage({
      target: 'linux-x64', cacheDirectory: cache, contract,
      argv: ['--linux', '--publish', 'never'],
      buildTrustFile: join(root, 'audited-build-trust.json'),
      environment: { PATH: '/attacker/bin', HOME: '/attacker/home' },
      spawnProcess: (file, args, options) => new Promise((resolvePromise, rejectPromise) => {
        assert.equal(file, process.execPath)
        assert.deepEqual(args, [
          `--require=${denyNetworkPath}`,
          runnerPath,
          `--world-ffmpeg-attempt=${options.env.WORLD_FFMPEG_PACKAGE_ATTEMPT_ID}`,
        ])
        // Test instrumentation runs in a separate harness. It is deliberately
        // not appended to the production runner's exact execArgv authority.
        const child = spawn(file, [harness], {
          ...options,
          cwd: project,
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        })
        child.stdio[3].setEncoding('utf8')
        child.stdio[3].on('data', (chunk) => { auditBytes += chunk })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => { childStderr = `${childStderr}${chunk}`.slice(-16_384) })
        const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000)
        deadline.unref()
        child.once('error', rejectPromise)
        child.once('close', (code, signal) => {
          clearTimeout(deadline)
          resolvePromise({ code, signal })
        })
      }),
    verifyPackage: approveFakePackageVerification,
    inspectArtifacts: approveFakeArtifactInspection,
    })
    assert.equal(result.code, 0, childStderr)
    assert.equal(result.signal, null, childStderr)
    return JSON.parse(auditBytes)
  }
  const audit = await runInstrumentedPackage()
  const repeatAudit = await runInstrumentedPackage()
  assert.notEqual(audit.cache, repeatAudit.cache)
  for (const generation of [audit.cache, repeatAudit.cache]) {
    assert.notEqual(generation, cache)
    await assert.rejects(lstat(generation), /ENOENT/)
  }
  assert.deepEqual(await verifyWorldFfmpegPackageToolCache({
    target: 'linux-x64', cacheDirectory: cache, contract,
  }), { ok: true })
  assert.equal(audit.envFileExists, true)
  assert.equal(audit.envRead, false)
  assert.equal(audit.spawnCount, 2)
  assert.deepEqual(audit.spawnedCommands, [0, 1].map(() => ({
    name: 'spawn',
    file: process.execPath,
    args: [fileURLToPath(new URL('./world-ffmpeg-output-custody.mjs', import.meta.url))],
  })))
  assert.ok(Object.values(audit.overrideEnvironment).every((value) => value === null))
  assert.ok(Object.values(audit.helperResolution).every(({ value, error }) => value === null && error === null))
  assert.equal(audit.projectDir, project)
  assert.equal(audit.publish, 'never')
  const auditAttemptId = audit.cache.match(/cache-([a-f0-9]{32})$/)?.[1]
  assert.match(auditAttemptId, /^[a-f0-9]{32}$/)
  assert.match(audit.configOutput, new RegExp(`output-${auditAttemptId}$`))
  assert.notEqual(audit.configOutput, join(fileURLToPath(new URL('../', import.meta.url)), 'dist'))
  assert.equal(audit.config.beforePack, 'scripts/world-ffmpeg-before-pack.cjs')
  assert.equal(audit.config.afterPack, 'scripts/after-pack.js')
  assert.equal(audit.config.electronDist, 'node_modules/electron/dist')
  assert.deepEqual(audit.targets, [['linux', [['x64', []]]]])

})

test('package-tool cache preparation is the only explicit network phase and publishes hash-verified archives', async (t) => {
  const { prepareWorldFfmpegPackageToolCache } = await import('./prepare-electron-builder-tool-cache.mjs')
  const { loadWorldFfmpegPackageToolLock, verifyWorldFfmpegPackageToolCache } = await import('./world-ffmpeg-package-tools.mjs')
  const cache = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-builder-fetch-'))
  t.after(() => rm(cache, { recursive: true, force: true }))
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  const requests = []
  for (const entry of contract.targets['linux-x64']) {
    const bytes = Buffer.from(`download:${entry.release}/${entry.filename}`)
    entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    entry.maximumBytes = 1024
  }
  const redirectTargets = new Map(contract.targets['linux-x64'].map((entry, index) => [
    entry.url,
    `https://release-assets.githubusercontent.com/github-production-release-asset/${index}/${entry.filename}?token=pinned-by-sha256`,
  ]))
  await prepareWorldFfmpegPackageToolCache({
    target: 'linux-x64', cacheDirectory: cache, contract,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      const redirect = redirectTargets.get(String(url))
      if (redirect) return new Response(null, { status: 302, headers: { location: redirect } })
      const entry = contract.targets['linux-x64'].find((candidate) => redirectTargets.get(candidate.url) === String(url))
      assert.ok(entry)
      const bytes = Buffer.from(`download:${entry.release}/${entry.filename}`)
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
    },
  })
  assert.equal(requests.length, contract.targets['linux-x64'].length * 2)
  assert.ok(requests.every(({ init }) => init.redirect === 'manual' && init.method === 'GET'))
  for (let index = 0; index < requests.length; index += 2) {
    assert.match(requests[index].url, /^https:\/\/github\.com\/electron-userland\/electron-builder-binaries\/releases\/download\//)
    assert.match(requests[index + 1].url, /^https:\/\/release-assets\.githubusercontent\.com\//)
  }
  assert.deepEqual(await verifyWorldFfmpegPackageToolCache({ target: 'linux-x64', cacheDirectory: cache, contract }), { ok: true })
  await writeFile(join(cache, contract.targets['linux-x64'][0].release, 'undeclared.partial'), 'attack')
  await assert.rejects(prepareWorldFfmpegPackageToolCache({
    target: 'linux-x64', cacheDirectory: cache, contract,
    fetchImpl: async () => { throw new Error('must not fetch') },
  }), /cache.*invalid|undeclared/i)
})

test('package-tool redirect policy rejects hostile, looping, downgraded, and unbounded chains', async (t) => {
  const { prepareWorldFfmpegPackageToolCache } = await import('./prepare-electron-builder-tool-cache.mjs')
  const { loadWorldFfmpegPackageToolLock } = await import('./world-ffmpeg-package-tools.mjs')
  const contract = structuredClone(await loadWorldFfmpegPackageToolLock())
  const first = contract.targets['linux-x64'][0]
  first.sha256 = createHash('sha256').update('unused').digest('hex')
  first.maximumBytes = 1024

  const cases = [
    ['foreign host', () => 'https://attacker.invalid/tool.tar.gz', /redirect.*host|transition/i],
    ['downgrade', () => 'http://release-assets.githubusercontent.com/tool.tar.gz', /HTTPS|redirect/i],
    ['credentials', () => 'https://user@release-assets.githubusercontent.com/tool.tar.gz', /credential|redirect/i],
    ['port', () => 'https://release-assets.githubusercontent.com:444/tool.tar.gz', /port|redirect/i],
  ]
  for (const [name, location, expected] of cases) {
    const cache = await mkdtemp(join(tmpdir(), `modly-ffmpeg-redirect-${String(name).replace(' ', '-')}-`))
    t.after(() => rm(cache, { recursive: true, force: true }))
    await assert.rejects(prepareWorldFfmpegPackageToolCache({
      target: 'linux-x64', cacheDirectory: cache, contract,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: location() } }),
    }), expected)
  }

  const loopCache = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-redirect-loop-'))
  t.after(() => rm(loopCache, { recursive: true, force: true }))
  const asset = 'https://release-assets.githubusercontent.com/github-production-release-asset/loop/tool.tar.gz'
  await assert.rejects(prepareWorldFfmpegPackageToolCache({
    target: 'linux-x64', cacheDirectory: loopCache, contract,
    fetchImpl: async (url) => new Response(null, {
      status: 302,
      headers: { location: String(url) === first.url ? asset : asset },
    }),
  }), /redirect.*loop/i)

  const hopCache = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-redirect-hops-'))
  t.after(() => rm(hopCache, { recursive: true, force: true }))
  let hop = 0
  await assert.rejects(prepareWorldFfmpegPackageToolCache({
    target: 'linux-x64', cacheDirectory: hopCache, contract,
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: `https://release-assets.githubusercontent.com/github-production-release-asset/hop-${hop += 1}/tool.tar.gz` },
    }),
  }), /redirect.*(?:hop|many|limit)/i)
})

test('corresponding-source generation publishes archive and checksum atomically with one concurrent winner', async (t) => {
  const {
    WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY,
    WORLD_FFMPEG_SOURCE_GENERATION_READY,
    WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY,
    publishWorldFfmpegSourceGeneration,
    verifyWorldFfmpegSourceGeneration,
  } = await import('./world-ffmpeg-source-publication.mjs')
  const destination = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-source-publish-'))
  const first = await mkdtemp(join(destination, '.candidate-a-'))
  const second = await mkdtemp(join(destination, '.candidate-b-'))
  t.after(() => rm(destination, { recursive: true, force: true }))
  for (const directory of [first, second]) {
    const archive = Buffer.from('canonical-source-archive')
    await writeFile(join(directory, 'modly-world-ffmpeg-7.1.1-sources.tar.xz'), archive)
    await writeFile(join(directory, 'modly-world-ffmpeg-7.1.1-sources.tar.xz.sha256'), `${createHash('sha256').update(archive).digest('hex')}  modly-world-ffmpeg-7.1.1-sources.tar.xz\n`)
  }
  const outcomes = await Promise.allSettled([
    publishWorldFfmpegSourceGeneration({ preparedDirectory: first, destinationDirectory: destination }),
    publishWorldFfmpegSourceGeneration({ preparedDirectory: second, destinationDirectory: destination }),
  ])
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1)
  const published = join(destination, WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY)
  assert.deepEqual((await readdir(published)).sort(), [
    WORLD_FFMPEG_SOURCE_GENERATION_IDENTITY,
    WORLD_FFMPEG_SOURCE_GENERATION_READY,
    'modly-world-ffmpeg-7.1.1-sources.tar.xz',
    'modly-world-ffmpeg-7.1.1-sources.tar.xz.sha256',
  ].sort())
  assert.match(await readFile(join(published, 'modly-world-ffmpeg-7.1.1-sources.tar.xz.sha256'), 'utf8'), /^[a-f0-9]{64}  modly-world-ffmpeg-7\.1\.1-sources\.tar\.xz\n$/)
  assert.deepEqual(await verifyWorldFfmpegSourceGeneration(published), { ok: true })
})

test('source-generation publication rejects every pre-existing destination identity without replacement', async (t) => {
  const {
    WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY,
    publishWorldFfmpegSourceGeneration,
  } = await import('./world-ffmpeg-source-publication.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-source-existing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const kind of ['empty', 'nonempty', 'symlink']) {
    const destination = join(root, kind)
    await mkdir(destination)
    const finalDirectory = join(destination, WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY)
    if (kind === 'symlink') {
      const target = join(root, `${kind}-target`)
      await mkdir(target)
      await symlink(target, finalDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    } else {
      await mkdir(finalDirectory)
      if (kind === 'nonempty') await writeFile(join(finalDirectory, 'owned-by-someone-else'), 'keep')
    }
    const prepared = await mkdtemp(join(destination, '.candidate-'))
    const archive = Buffer.from(`source-${kind}`)
    await writeFile(join(prepared, 'modly-world-ffmpeg-7.1.1-sources.tar.xz'), archive)
    await writeFile(
      join(prepared, 'modly-world-ffmpeg-7.1.1-sources.tar.xz.sha256'),
      `${createHash('sha256').update(archive).digest('hex')}  modly-world-ffmpeg-7.1.1-sources.tar.xz\n`,
    )
    await assert.rejects(
      publishWorldFfmpegSourceGeneration({ preparedDirectory: prepared, destinationDirectory: destination }),
      /already exists|overwrite/i,
    )
    if (kind === 'empty') assert.deepEqual(await readdir(finalDirectory), [])
    if (kind === 'nonempty') assert.equal(await readFile(join(finalDirectory, 'owned-by-someone-else'), 'utf8'), 'keep')
    if (kind === 'symlink') assert.equal((await lstat(finalDirectory)).isSymbolicLink(), true)
  }
})

test('source-generation retries its exact crash claim but never accepts a half-published pair', async (t) => {
  const {
    WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY,
    publishWorldFfmpegSourceGeneration,
    verifyWorldFfmpegSourceGeneration,
  } = await import('./world-ffmpeg-source-publication.mjs')
  const checkpoints = ['generation-claimed', 'archive-published', 'checksum-published', 'ready-published']
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-source-crash-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const checkpoint of checkpoints) {
    const destination = join(root, checkpoint)
    await mkdir(destination)
    const prepared = await mkdtemp(join(destination, '.candidate-'))
    const archive = Buffer.from(`source-${checkpoint}`)
    await writeFile(join(prepared, 'modly-world-ffmpeg-7.1.1-sources.tar.xz'), archive)
    await writeFile(
      join(prepared, 'modly-world-ffmpeg-7.1.1-sources.tar.xz.sha256'),
      `${createHash('sha256').update(archive).digest('hex')}  modly-world-ffmpeg-7.1.1-sources.tar.xz\n`,
    )
    let interrupted = false
    await assert.rejects(publishWorldFfmpegSourceGeneration({
      preparedDirectory: prepared,
      destinationDirectory: destination,
      checkpoint: async (name) => {
        if (!interrupted && name === checkpoint) {
          interrupted = true
          throw new Error(`crash:${name}`)
        }
      },
    }), new RegExp(`crash:${checkpoint}`))
    const published = join(destination, WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY)
    if (checkpoint !== 'ready-published') {
      assert.notDeepEqual(await verifyWorldFfmpegSourceGeneration(published), { ok: true })
    }
    const recovered = await publishWorldFfmpegSourceGeneration({
      preparedDirectory: prepared, destinationDirectory: destination,
    })
    assert.equal(recovered.generationDirectory, published)
    assert.deepEqual(await verifyWorldFfmpegSourceGeneration(published), { ok: true })
  }
})

test('source-generation payload entries are durably committed before READY and READY is committed again', async (t) => {
  const {
    WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY,
    publishWorldFfmpegSourceGeneration,
  } = await import('./world-ffmpeg-source-publication.mjs')
  const destination = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-source-order-'))
  const prepared = await mkdtemp(join(destination, '.candidate-'))
  t.after(() => rm(destination, { recursive: true, force: true }))
  const archiveName = 'modly-world-ffmpeg-7.1.1-sources.tar.xz'
  const archive = Buffer.from('durability-ordered-source')
  await writeFile(join(prepared, archiveName), archive)
  await writeFile(join(prepared, `${archiveName}.sha256`), `${createHash('sha256').update(archive).digest('hex')}  ${archiveName}\n`)
  const events = []
  const finalDirectory = join(destination, WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY)
  const durability = {
    platform: 'linux',
    openDirectory: async (path) => ({
      stat: async () => ({ isDirectory: () => true }),
      sync: async () => { if (path === finalDirectory) events.push('barrier:final') },
      close: async () => undefined,
    }),
  }
  await publishWorldFfmpegSourceGeneration({
    preparedDirectory: prepared,
    destinationDirectory: destination,
    durability,
    checkpoint: async (name) => events.push(`checkpoint:${name}`),
  })
  const payloadBarrier = events.indexOf('barrier:final')
  const readyPublished = events.indexOf('checkpoint:ready-published')
  const readyBarrier = events.lastIndexOf('barrier:final')
  assert.ok(payloadBarrier > events.indexOf('checkpoint:checksum-published'))
  assert.ok(payloadBarrier < readyPublished)
  assert.ok(readyBarrier > readyPublished)
  assert.ok(events.indexOf('checkpoint:payload-durable') > payloadBarrier)
  assert.ok(events.indexOf('checkpoint:ready-durable') > readyBarrier)
})

async function assertSourceCliRefusal(execution, stderrPattern) {
  await assert.rejects(execution, (error) => {
    assert.equal(error?.code, 1, 'source CLI refusal must have exit status 1')
    assert.equal(error?.signal, null, 'source CLI refusal must not be a signal termination')
    assert.match(error?.stderr, stderrPattern)
    return true
  })
}

test('source-archive refusal evidence requires nonzero exit and matching stderr', async () => {
  const failure = (code, stderr) => Promise.reject(Object.assign(new Error('Command failed: /bin/bash create-world-ffmpeg-source-archive.sh'), {
    code, signal: null, stderr,
  }))
  await assertSourceCliRefusal(failure(1, 'different source owner\n'), /different source owner/)
  await assert.rejects(assertSourceCliRefusal(failure(0, 'different source owner\n'), /different source owner/), /exit status/)
  await assert.rejects(assertSourceCliRefusal(failure(1, 'unrelated failure\n'), /different source owner/), /different source owner/)
})

test('actual source-archive CLI resumes identical bytes after interruption at every publication checkpoint', async (t) => {
  if (!await requireExactAsyncPipeCapability(t)) return
  const {
    WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY,
    verifyWorldFfmpegSourceGeneration,
  } = await import('./world-ffmpeg-source-publication.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-source-cli-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceCache = join(root, 'source-cache')
  const fakeBin = join(root, 'fake-bin')
  await mkdir(sourceCache)
  await mkdir(fakeBin)
  for (const name of ['ffmpeg-7.1.1.tar.xz', 'libvpx-1.15.2.tar.gz', 'opus-1.5.2.tar.gz', 'zlib-1.3.2.tar.gz']) {
    await writeFile(join(sourceCache, name), `canonical-fixture:${name}`)
  }
  const nodeShim = join(fakeBin, 'node')
  await writeFile(nodeShim, `#!/usr/bin/env bash
set -Eeuo pipefail
case "\${1:-}" in
  */verify-world-ffmpeg-sources.mjs)
    receipt=''
    for ((index=2; index <= \$#; index++)); do
      if [[ "\${!index}" == '--receipt-output' ]]; then
        next=\$((index + 1)); receipt="\${!next}"
      fi
    done
    if [[ -n "\$receipt" ]]; then printf '%s\\n' '{"fixture":"verified"}' > "\$receipt"; fi
    ;;
  *) exec "\$REAL_NODE" "\$@" ;;
esac
`)
  await chmod(nodeShim, 0o755)
  const checkpoints = [
    'generation-claimed', 'archive-published', 'checksum-published',
    'payload-durable', 'ready-published', 'ready-durable',
    'claim-removed', 'prepared-removed', 'cleanup-durable', 'return-committed',
  ]
  const createScript = fileURLToPath(new URL('./create-world-ffmpeg-source-archive.sh', import.meta.url))
  const runCli = (destination, workRoot, checkpoint = '') => new Promise((resolvePromise, rejectPromise) => {
    execFile('/bin/bash', [createScript,
      '--source-cache', sourceCache, '--work-root', workRoot, '--destination', destination,
      '--gpg', '/usr/bin/false', '--gpgv', '/usr/bin/false',
    ], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`, REAL_NODE: process.execPath,
        NODE_ENV: 'test',
        WORLD_FFMPEG_SOURCE_PUBLICATION_TEST_INTERRUPT: checkpoint,
      },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) rejectPromise(Object.assign(error, { stdout, stderr }))
      else resolvePromise({ stdout, stderr })
    })
  })
  for (const checkpoint of checkpoints) {
    const destination = join(root, `destination-${checkpoint}`)
    const workRoot = join(root, `work-${checkpoint}`)
    await mkdir(destination)
    await assert.rejects(runCli(destination, workRoot, checkpoint))
    const claimPresent = (await readdir(destination)).some((name) => name.endsWith('.claim.v1.json'))
    const cleanupCheckpoints = ['claim-removed', 'prepared-removed', 'cleanup-durable', 'return-committed']
    assert.equal(claimPresent, !cleanupCheckpoints.includes(checkpoint))
    const preparedPath = join(workRoot, '.world-ffmpeg-source-generation')
    const preparedPresent = await lstat(preparedPath).then((info) => info.isDirectory(), () => false)
    assert.equal(preparedPresent, !['prepared-removed', 'cleanup-durable', 'return-committed'].includes(checkpoint))
    const recovered = await runCli(destination, workRoot)
    assert.match(recovered.stdout, /Created corresponding-source generation/)
    assert.deepEqual(
      await verifyWorldFfmpegSourceGeneration(join(destination, WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY)),
      { ok: true },
    )
  }

  const mismatchDestination = join(root, 'destination-mismatch')
  await mkdir(mismatchDestination)
  await assert.rejects(runCli(mismatchDestination, join(root, 'work-mismatch-first'), 'archive-published'))
  await writeFile(join(sourceCache, 'zlib-1.3.2.tar.gz'), 'different-source-owner')
  await assertSourceCliRefusal(
    runCli(mismatchDestination, join(root, 'work-mismatch-second')),
    /different publication claim|different source owner|already exists|unrelated/i,
  )

  const residualClaimDestination = join(root, 'destination-residual-claim')
  const residualClaimWorkRoot = join(root, 'work-residual-claim')
  await mkdir(residualClaimDestination)
  await assert.rejects(runCli(residualClaimDestination, residualClaimWorkRoot, 'ready-durable'))
  await rm(join(residualClaimWorkRoot, '.world-ffmpeg-source-generation'), { recursive: true })
  assert.ok((await readdir(residualClaimDestination)).some((name) => name.endsWith('.claim.v1.json')))
  const residualRecovered = await runCli(residualClaimDestination, residualClaimWorkRoot)
  assert.match(residualRecovered.stdout, /Created corresponding-source generation/)

  const fullyGoneDestination = join(root, 'destination-fully-gone-owner')
  const fullyGoneWorkRoot = join(root, 'work-fully-gone-owner')
  await mkdir(fullyGoneDestination)
  await assert.rejects(runCli(fullyGoneDestination, fullyGoneWorkRoot, 'return-committed'))
  await rm(fullyGoneWorkRoot, { recursive: true })
  const fullyGoneRecovered = await runCli(fullyGoneDestination, fullyGoneWorkRoot)
  assert.match(fullyGoneRecovered.stdout, /Created corresponding-source generation/)

  const corruptDestination = join(root, 'destination-corrupt-terminal')
  const corruptWorkRoot = join(root, 'work-corrupt-terminal')
  await mkdir(corruptDestination)
  await assert.rejects(runCli(corruptDestination, corruptWorkRoot, 'return-committed'))
  await writeFile(join(
    corruptDestination,
    WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY,
    'modly-world-ffmpeg-7.1.1-sources.tar.xz',
  ), 'corrupt-terminal-generation')
  await assertSourceCliRefusal(
    runCli(corruptDestination, corruptWorkRoot),
    /verification|invalid|conflicting|checksum/i,
  )
})

test('source-generation recovery never overwrites a conflicting partial publication', async (t) => {
  const {
    WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY,
    publishWorldFfmpegSourceGeneration,
    verifyWorldFfmpegSourceGeneration,
  } = await import('./world-ffmpeg-source-publication.mjs')
  const destination = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-source-conflict-'))
  const prepared = await mkdtemp(join(destination, '.candidate-'))
  t.after(() => rm(destination, { recursive: true, force: true }))
  const archiveName = 'modly-world-ffmpeg-7.1.1-sources.tar.xz'
  const archive = Buffer.from('owned-source')
  await writeFile(join(prepared, archiveName), archive)
  await writeFile(
    join(prepared, `${archiveName}.sha256`),
    `${createHash('sha256').update(archive).digest('hex')}  ${archiveName}\n`,
  )
  await assert.rejects(publishWorldFfmpegSourceGeneration({
    preparedDirectory: prepared,
    destinationDirectory: destination,
    checkpoint: async (name) => {
      if (name === 'archive-published') throw new Error('crash:archive-published')
    },
  }), /crash:archive-published/)
  const publishedArchive = join(destination, WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY, archiveName)
  await writeFile(publishedArchive, 'conflicting-source')
  await assert.rejects(
    publishWorldFfmpegSourceGeneration({ preparedDirectory: prepared, destinationDirectory: destination }),
    /conflicting published entry/i,
  )
  assert.equal(await readFile(publishedArchive, 'utf8'), 'conflicting-source')
  assert.notDeepEqual(
    await verifyWorldFfmpegSourceGeneration(join(destination, WORLD_FFMPEG_SOURCE_GENERATION_DIRECTORY)),
    { ok: true },
  )
})

test('tuple build reports are canonical and bind the exact supply contract, runtime manifest, signature, and trust', async () => {
  const {
    createWorldFfmpegBuildReport,
    validateWorldFfmpegBuildReport,
  } = await import('./world-ffmpeg-build-report.mjs')
  const supplyBytes = await readFile(new URL('../resources/ffmpeg/supply-chain.v1.json', import.meta.url))
  const supply = JSON.parse(supplyBytes.toString('utf8'))
  const manifestBytes = Buffer.from('{"schema":"modly.ffmpeg-runtime.v1","target":"linux-x64","signingKeyId":"ci-test"}\n')
  const signatureBytes = Buffer.alloc(64, 7)
  const trustBytes = Buffer.from('{"ci-test":"public-key"}\n')
  const report = createWorldFfmpegBuildReport({
    target: 'linux-x64', supplyChainBytes: supplyBytes, manifestBytes, signatureBytes, trustBytes,
    signingKeyId: 'ci-test', runtimeRpath: '$ORIGIN',
    configure: {
      zlib: ['./configure', '--prefix=<BUILD_PREFIX>', '--shared'],
      opus: ['./configure', '--prefix=<BUILD_PREFIX>', '--disable-static', '--enable-shared', '--disable-doc', '--disable-extra-programs'],
      libvpx: ['./configure', '--prefix=<BUILD_PREFIX>', '--target=<TARGET_FROM_SCRIPT>', '--disable-static', '--enable-shared', '--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests', '--disable-vp8', '--enable-vp9', '--disable-webm-io', '--disable-libyuv'],
      ffmpeg: ['./configure', '--prefix=<BUILD_PREFIX>', '--bindir=<BUILD_PREFIX>/bin', '--libdir=<BUILD_PREFIX>/lib', '--shlibdir=<BUILD_PREFIX>/lib', '--extra-cflags=<REPRODUCIBLE_CFLAGS>', '--extra-ldflags=-L<BUILD_PREFIX>/lib', ...supply.ffmpegConfigure],
    },
    linkerEnvironment: { LD_RUN_PATH: '$ORIGIN' },
    tools: {
      ar: { path: '/usr/bin/ar', version: 'ar test', sha256: '1'.repeat(64) },
      cc: { path: '/usr/bin/cc', version: 'cc test', sha256: '2'.repeat(64) },
      inspector: { path: '/usr/bin/readelf', version: 'readelf test', sha256: '3'.repeat(64) },
      node: { path: '/usr/bin/node', version: 'v24.0.0', sha256: '4'.repeat(64) },
    },
  })
  assert.equal(report.runtimeRpath, '$ORIGIN')
  assert.equal(validateWorldFfmpegBuildReport(report, {
    target: 'linux-x64', supplyChainBytes: supplyBytes, manifestBytes, signatureBytes, trustBytes,
    signingKeyId: 'ci-test',
  }), true)
  assert.equal(validateWorldFfmpegBuildReport({ ...report, runtimeManifestSha256: '0'.repeat(64) }, {
    target: 'linux-x64', supplyChainBytes: supplyBytes, manifestBytes, signatureBytes, trustBytes,
    signingKeyId: 'ci-test',
  }), false)
  assert.equal(validateWorldFfmpegBuildReport({ ...report, linkerEnvironment: {} }, {
    target: 'linux-x64', supplyChainBytes: supplyBytes, manifestBytes, signatureBytes, trustBytes,
    signingKeyId: 'ci-test',
  }), false)
  assert.equal(validateWorldFfmpegBuildReport({ ...report, runtimeRpath: '@loader_path' }, {
    target: 'linux-x64', supplyChainBytes: supplyBytes, manifestBytes, signatureBytes, trustBytes,
    signingKeyId: 'ci-test',
  }), false)
  assert.throws(() => createWorldFfmpegBuildReport({
    target: 'linux-x64', supplyChainBytes: supplyBytes, manifestBytes, signatureBytes, trustBytes,
    signingKeyId: 'ci-test', runtimeRpath: '@loader_path',
    configure: report.configure, linkerEnvironment: report.linkerEnvironment, tools: report.tools,
  }), /rpath|invalid/i)
})

test('build-report link authority binds the exact tuple rpath and a prefix-only Windows recipe', async () => {
  const { worldFfmpegBuildReportLinkAuthority } = await import('./world-ffmpeg-build-report.mjs')
  assert.deepEqual(worldFfmpegBuildReportLinkAuthority('linux-x64', '$ORIGIN'), {
    runtimeRpath: '$ORIGIN',
    linkerEnvironment: { LD_RUN_PATH: '$ORIGIN' },
    normalizedExtraLdflags: '-L<BUILD_PREFIX>/lib',
  })
  assert.deepEqual(worldFfmpegBuildReportLinkAuthority('darwin-arm64', '@loader_path'), {
    runtimeRpath: '@loader_path',
    linkerEnvironment: { LDFLAGS_RPATH: '-Wl,-rpath,@loader_path' },
    normalizedExtraLdflags: '-L<BUILD_PREFIX>/lib -Wl,-rpath,@loader_path',
  })
  assert.deepEqual(worldFfmpegBuildReportLinkAuthority('win32-x64', ''), {
    runtimeRpath: '',
    linkerEnvironment: {},
    normalizedExtraLdflags: '-L<BUILD_PREFIX>/lib',
  })
  for (const [target, rpath] of [
    ['linux-x64', 'RIGIN'], ['linux-x64', '@loader_path'],
    ['darwin-arm64', '$ORIGIN'], ['darwin-arm64', '@executable_path'],
    ['win32-x64', '$ORIGIN'], ['win32-x64', '.'],
  ]) {
    assert.throws(() => worldFfmpegBuildReportLinkAuthority(target, rpath), /rpath|invalid/i)
  }
})

test('Darwin build-tool audit uses xcrun plus the stock Apple BSD ar usage contract', async (t) => {
  const { inspectWorldFfmpegBuildTool } = await import('./write-world-ffmpeg-build-report.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-apple-ar-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const writeTool = async (name, body) => {
    const directory = join(root, name)
    await mkdir(directory)
    const path = join(directory, 'ar')
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o755)
    return path
  }
  const apple = await writeTool('apple', `
if [ "\${1:-}" = '-h' ]; then
  printf '%s\\n' \\
    'usage:  ar -d [-TLsv] archive file ...' \\
    '        ar -m [-TLsv] archive file ...' \\
    '        ar -m [-abiTLsv] position archive file ...' \\
    '        ar -p [-TLsv] archive [file ...]' \\
    '        ar -q [-cTLsv] archive file ...' \\
    '        ar -r [-cuTLsv] archive file ...' \\
    '        ar -r [-abciuTLsv] position archive file ...' \\
    '        ar -t [-TLsv] archive [file ...]' \\
    '        ar -x [-ouTLsv] archive [file ...]' >&2
  exit 1
fi
exit 91`)
  const xcrun = join(root, 'xcrun')
  const pointXcrunAt = async (path) => {
    await writeFile(xcrun, `#!/bin/sh\nif [ "\${1:-}" = '--find' ] && [ "\${2:-}" = 'ar' ]; then printf '%s\\n' '${path}'; exit 0; fi\nexit 2\n`)
    await chmod(xcrun, 0o755)
  }
  await pointXcrunAt(apple)
  const appleIdentity = await inspectWorldFfmpegBuildTool(apple, {
    target: 'darwin-arm64', name: 'ar', xcrunPath: xcrun,
  })
  assert.equal(appleIdentity.version, 'Apple BSD ar (xcrun-selected usage contract)')
  assert.equal(appleIdentity.path, apple)
  assert.equal(appleIdentity.sha256, createHash('sha256').update(await readFile(apple)).digest('hex'))

  const foreign = await writeTool('foreign', `
if [ "\${1:-}" = '-h' ]; then printf '%s\\n' 'Usage: ar [emulation options] [-]{dmpqrstx}[abcDfilMNoOPsSTuvV]'; exit 1; fi
exit 91`)
  await pointXcrunAt(foreign)
  await assert.rejects(
    inspectWorldFfmpegBuildTool(foreign, {
      target: 'darwin-arm64', name: 'ar', xcrunPath: xcrun,
    }),
    /Apple ar|foreign|identity/i,
  )
  const failing = await writeTool('failing', 'exit 2')
  await pointXcrunAt(failing)
  await assert.rejects(
    inspectWorldFfmpegBuildTool(failing, {
      target: 'darwin-arm64', name: 'ar', xcrunPath: xcrun,
    }),
    /version.*unavailable/i,
  )
})
