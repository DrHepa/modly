import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  WORLD_FFMPEG_RUNTIME_SCHEMA,
  acquireWorldFfmpegExecutionLease,
  resolvePackagedWorldFfmpegRuntime,
} from './world-render-ffmpeg-runtime.ts'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const signingKeyId = 'modly-test-ed25519-2026'
const signingKeys = generateKeyPairSync('ed25519')
const trustedManifestKeys = Object.freeze({
  [signingKeyId]: signingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
})

async function writeLinuxBundle(resourcesPath: string, target: 'linux-x64' | 'linux-arm64' = 'linux-x64'): Promise<{
  readonly root: string
  readonly executablePath: string
  readonly libraryPath: string
  readonly licensePath: string
  readonly manifestPath: string
  readonly signaturePath: string
  readonly manifest: Record<string, unknown>
}> {
  const root = join(resourcesPath, 'ffmpeg', target)
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  const executablePath = join(bin, 'ffmpeg')
  const libraryPath = join(bin, 'libavcodec.so.61')
  const licensePath = join(root, 'LICENSE.txt')
  const executable = Buffer.from('audited fake ffmpeg executable')
  const library = Buffer.from('audited fake shared library')
  const license = Buffer.from('Audited fake LGPL-2.1-or-later license text.\n')
  await writeFile(executablePath, executable)
  await writeFile(libraryPath, library)
  await writeFile(licensePath, license)
  await chmod(executablePath, 0o755)
  await chmod(libraryPath, 0o644)
  await chmod(licensePath, 0o644)
  await chmod(join(resourcesPath, 'ffmpeg'), 0o755)
  await chmod(root, 0o755)
  await chmod(bin, 0o755)
  const manifest = {
    schema: WORLD_FFMPEG_RUNTIME_SCHEMA,
    target,
    ffmpegVersion: '7.1.1',
    signingKeyId,
    build: {
      license: 'LGPL-2.1-or-later',
      linkage: 'shared',
      gpl: false,
      nonfree: false,
      version3: false,
      videoEncoders: ['libvpx-vp9'],
      audioEncoders: ['libopus'],
      decoders: ['pcm_s16le', 'png'],
      demuxers: ['image2pipe', 's16le'],
      filters: ['aformat', 'anull', 'aresample', 'atrim', 'crop', 'format', 'hflip', 'interleave', 'null', 'rotate', 'scale', 'setpts', 'settb', 'transpose', 'trim', 'vflip', 'abuffer', 'buffer', 'abuffersink', 'buffersink'],
      muxers: ['webm'],
      parsers: ['png'],
      protocols: ['fd', 'pipe'],
    },
    directories: [
      { path: '.', mode: 0o755 },
      { path: 'bin', mode: 0o755 },
    ],
    license: {
      path: 'LICENSE.txt',
      size: license.byteLength,
      sha256: sha256(license),
      mode: 0o644,
    },
    executable: {
      path: 'bin/ffmpeg',
      size: executable.byteLength,
      sha256: sha256(executable),
      mode: 0o755,
    },
    sharedLibraries: [{
      path: 'bin/libavcodec.so.61',
      size: library.byteLength,
      sha256: sha256(library),
      mode: 0o644,
    }],
  }
  const manifestPath = join(root, 'manifest.json')
  const signaturePath = join(root, 'manifest.sig')
  await writeSignedManifest(manifestPath, signaturePath, manifest)
  return { root, executablePath, libraryPath, licensePath, manifestPath, signaturePath, manifest }
}

async function writeSignedManifest(
  manifestPath: string,
  signaturePath: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  await writeFile(manifestPath, bytes)
  await writeFile(signaturePath, sign(null, bytes, signingKeys.privateKey))
  await chmod(manifestPath, 0o644)
  await chmod(signaturePath, 0o644)
}

const resolveLinuxBundle = (resourcesPath: string) => resolvePackagedWorldFfmpegRuntime({
  resourcesPath,
  platform: 'linux',
  arch: 'x64',
  trustedManifestKeys,
})

test('resolves only the exact audited process.resourcesPath target bundle', async (t) => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runtime-'))
  t.after(() => rm(resourcesPath, { recursive: true, force: true }))
  const bundle = await writeLinuxBundle(resourcesPath)

  const result = await resolveLinuxBundle(resourcesPath)

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.runtime.target, 'linux-x64')
    assert.equal(result.runtime.rootPath, bundle.root)
    assert.equal(result.runtime.executablePath, bundle.executablePath)
    assert.deepEqual(result.runtime.sharedLibraryPaths, [bundle.libraryPath])
  }
})

test('Linux ARM64 selects its signed bundle rather than the x64 bundle or host PATH', async (t) => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-arm64-runtime-'))
  t.after(() => rm(resourcesPath, { recursive: true, force: true }))
  const bundle = await writeLinuxBundle(resourcesPath, 'linux-arm64')
  const result = await resolvePackagedWorldFfmpegRuntime({
    resourcesPath, platform: 'linux', arch: 'arm64', trustedManifestKeys,
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.runtime.executablePath, bundle.executablePath)
  assert.deepEqual(await resolveLinuxBundle(resourcesPath), { ok: false, code: 'bundle-missing' })
  await writeSignedManifest(bundle.manifestPath, bundle.signaturePath, { ...bundle.manifest, target: 'linux-x64' })
  assert.deepEqual(await resolvePackagedWorldFfmpegRuntime({
    resourcesPath, platform: 'linux', arch: 'arm64', trustedManifestKeys,
  }), { ok: false, code: 'bundle-invalid' })
})

test('fails closed for absent and unsupported packaged targets without PATH or environment fallback', async (t) => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runtime-'))
  t.after(() => rm(resourcesPath, { recursive: true, force: true }))

  assert.deepEqual(
    await resolvePackagedWorldFfmpegRuntime({ resourcesPath, platform: 'linux', arch: 'arm64' }),
    { ok: false, code: 'bundle-missing' },
  )
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'x64']] as const) {
    assert.deepEqual(
      await resolvePackagedWorldFfmpegRuntime({ resourcesPath, platform, arch, trustedManifestKeys }),
      { ok: false, code: 'bundle-missing' },
    )
  }
})

test('execution lease independently rejects a coherently signed unsupported target', async (t) => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runtime-'))
  t.after(() => rm(resourcesPath, { recursive: true, force: true }))
  const bundle = await writeLinuxBundle(resourcesPath)
  const unsupportedTarget = 'linux-riscv64'
  const unsupportedRoot = join(resourcesPath, 'ffmpeg', unsupportedTarget)
  await rename(bundle.root, unsupportedRoot)
  const manifest = { ...bundle.manifest, target: unsupportedTarget }
  const manifestPath = join(unsupportedRoot, 'manifest.json')
  await writeSignedManifest(manifestPath, join(unsupportedRoot, 'manifest.sig'), manifest)
  const attempted = await acquireWorldFfmpegExecutionLease({
    runtime: {
      target: unsupportedTarget,
      rootPath: unsupportedRoot,
      executablePath: join(unsupportedRoot, 'bin', 'ffmpeg'),
      sharedLibraryPaths: [join(unsupportedRoot, 'bin', 'libavcodec.so.61')],
      ffmpegVersion: '7.1.1',
      signingKeyId,
      manifestSha256: sha256(Buffer.from(`${JSON.stringify(manifest)}\n`)),
    } as never,
    trustedManifestKeys,
  }).then(async (lease) => {
    await lease.release()
    return null
  }, (error: unknown) => error)

  assert.match(attempted instanceof Error ? attempted.message : '', /unsupported target/)
})

test('rejects manifest drift, target mismatch, traversal, hashes, sizes, and POSIX modes', async (t) => {
  const mutations: Array<[string, (bundle: Awaited<ReturnType<typeof writeLinuxBundle>>) => Promise<void>]> = [
    ['extra manifest key', async ({ manifest, manifestPath }) => {
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), { ...manifest, unexpected: true })
    }],
    ['target mismatch', async ({ manifest, manifestPath }) => {
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), { ...manifest, target: 'darwin-arm64' })
    }],
    ['version mismatch', async ({ manifest, manifestPath }) => {
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), { ...manifest, ffmpegVersion: '7.1.2' })
    }],
    ['path traversal', async ({ manifest, manifestPath }) => {
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), { ...manifest, executable: { ...(manifest.executable as object), path: '../ffmpeg' } })
    }],
    ['hash mismatch', async ({ executablePath }) => { await writeFile(executablePath, 'tampered') }],
    ['size mismatch', async ({ manifest, manifestPath }) => {
      const executable = manifest.executable as Record<string, unknown>
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), { ...manifest, executable: { ...executable, size: Number(executable.size) + 1 } })
    }],
    ['mode mismatch', async ({ executablePath }) => { await chmod(executablePath, 0o700) }],
    ['special executable mode', async ({ executablePath }) => { await chmod(executablePath, 0o4755) }],
    ['forbidden build feature', async ({ manifest, manifestPath }) => {
      const build = manifest.build as Record<string, unknown>
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), { ...manifest, build: { ...build, gpl: true } })
    }],
    ['missing required VFR filter', async ({ manifest, manifestPath }) => {
      const build = manifest.build as Record<string, unknown>
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), {
        ...manifest,
        build: { ...build, filters: ['aformat', 'aresample', 'format', 'scale', 'setpts', 'settb'] },
      })
    }],
    ['missing exact PTS filter', async ({ manifest, manifestPath }) => {
      const build = manifest.build as Record<string, unknown>
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), {
        ...manifest,
        build: { ...build, filters: ['aformat', 'aresample', 'format', 'interleave', 'scale', 'settb'] },
      })
    }],
    ['missing required implicit filter', async ({ manifest, manifestPath }) => {
      const build = manifest.build as Record<string, unknown>
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), {
        ...manifest,
        build: { ...build, filters: (build.filters as string[]).filter((name) => name !== 'abuffersink') },
      })
    }],
    ['undeclared effective filter', async ({ manifest, manifestPath }) => {
      const build = manifest.build as Record<string, unknown>
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), {
        ...manifest,
        build: { ...build, filters: [...(build.filters as string[]), 'overlay'] },
      })
    }],
    ['reordered effective filters', async ({ manifest, manifestPath }) => {
      const build = manifest.build as Record<string, unknown>
      const filters = [...(build.filters as string[])]
      ;[filters[0], filters[1]] = [filters[1], filters[0]]
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), {
        ...manifest,
        build: { ...build, filters },
      })
    }],
    ['missing seekable fd protocol', async ({ manifest, manifestPath }) => {
      const build = manifest.build as Record<string, unknown>
      await writeSignedManifest(manifestPath, join(dirname(manifestPath), 'manifest.sig'), {
        ...manifest,
        build: { ...build, protocols: ['pipe'] },
      })
    }],
  ]

  for (const [label, mutate] of mutations) {
    await t.test(label, async (t) => {
      const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runtime-'))
      t.after(() => rm(resourcesPath, { recursive: true, force: true }))
      const bundle = await writeLinuxBundle(resourcesPath)
      await mutate(bundle)
      const result = await resolveLinuxBundle(resourcesPath)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'bundle-invalid')
    })
  }
})

test('rejects symlinked executable, shared library, and bundle descendants', async (t) => {
  for (const kind of ['executable', 'library'] as const) {
    await t.test(kind, async (t) => {
      const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runtime-'))
      t.after(() => rm(resourcesPath, { recursive: true, force: true }))
      const bundle = await writeLinuxBundle(resourcesPath)
      const victim = kind === 'executable' ? bundle.executablePath : bundle.libraryPath
      const external = join(resourcesPath, `external-${kind}`)
      await writeFile(external, kind)
      await rm(victim)
      await symlink(external, victim)
      const result = await resolveLinuxBundle(resourcesPath)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'bundle-invalid')
    })
  }
})

test('rejects unsigned manifests and any undeclared runtime tree entry', async (t) => {
  const cases: Array<[string, (bundle: Awaited<ReturnType<typeof writeLinuxBundle>>) => Promise<void>]> = [
    ['signature tamper', async ({ signaturePath }) => { await writeFile(signaturePath, Buffer.alloc(64, 7)) }],
    ['undeclared root file', async ({ root }) => { await writeFile(join(root, 'README.txt'), 'not declared') }],
    ['undeclared root directory', async ({ root }) => { await mkdir(join(root, 'extra')) }],
    ['undeclared bin file', async ({ root }) => { await writeFile(join(root, 'bin', 'loader-hook.so'), 'not declared') }],
  ]
  for (const [label, mutate] of cases) {
    await t.test(label, async (t) => {
      const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runtime-'))
      t.after(() => rm(resourcesPath, { recursive: true, force: true }))
      const bundle = await writeLinuxBundle(resourcesPath)
      await mutate(bundle)
      const result = await resolveLinuxBundle(resourcesPath)
      assert.deepEqual(result, { ok: false, code: 'bundle-invalid' })
    })
  }
})

test('rejects directory, manifest, license, hardlink, and special file mode drift', async (t) => {
  const cases: Array<[string, (bundle: Awaited<ReturnType<typeof writeLinuxBundle>>) => Promise<void>]> = [
    ['bundle directory mode', async ({ root }) => { await chmod(root, 0o775) }],
    ['bin directory mode', async ({ root }) => { await chmod(join(root, 'bin'), 0o775) }],
    ['manifest mode', async ({ manifestPath }) => { await chmod(manifestPath, 0o664) }],
    ['signature mode', async ({ signaturePath }) => { await chmod(signaturePath, 0o664) }],
    ['license mode', async ({ licensePath }) => { await chmod(licensePath, 0o664) }],
    ['library hardlink', async ({ libraryPath }) => {
      await link(libraryPath, `${libraryPath}.alias`)
      await rm(`${libraryPath}.alias`)
    }],
  ]
  for (const [label, mutate] of cases) {
    await t.test(label, async (t) => {
      const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runtime-'))
      t.after(() => rm(resourcesPath, { recursive: true, force: true }))
      const bundle = await writeLinuxBundle(resourcesPath)
      if (label === 'library hardlink') {
        const alias = `${bundle.libraryPath}.alias`
        await link(bundle.libraryPath, alias)
        const result = await resolveLinuxBundle(resourcesPath)
        assert.deepEqual(result, { ok: false, code: 'bundle-invalid' })
        await rm(alias)
      } else {
        await mutate(bundle)
        const result = await resolveLinuxBundle(resourcesPath)
        assert.deepEqual(result, { ok: false, code: 'bundle-invalid' })
      }
    })
  }
})

test('execution lease rejects replacement after asynchronous verification and never invokes spawn', async (t) => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'modly-ffmpeg-runtime-'))
  t.after(() => rm(resourcesPath, { recursive: true, force: true }))
  const bundle = await writeLinuxBundle(resourcesPath)
  const resolved = await resolveLinuxBundle(resourcesPath)
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return

  const lease = await acquireWorldFfmpegExecutionLease({
    runtime: resolved.runtime,
    trustedManifestKeys,
  })
  await rm(bundle.executablePath)
  await writeFile(bundle.executablePath, 'replacement executable')
  await chmod(bundle.executablePath, 0o755)
  let spawned = false
  assert.throws(() => lease.spawn(() => { spawned = true; return {} }, [], {}), /changed before spawn/)
  assert.equal(spawned, false)
  await lease.release()
})
