#!/usr/bin/env node

import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectWorldFfmpegBinary } from './world-ffmpeg-binary-audit.mjs'
import { syncWorldFfmpegDirectory, syncWorldFfmpegFile } from './world-ffmpeg-durability.mjs'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const LICENSE_ROOT = join(REPOSITORY_ROOT, 'resources', 'licenses', 'world-ffmpeg-7.1.1')

export async function stageWorldFfmpegRuntime(input) {
  const target = requireTarget(input.target)
  const prefix = absolute(input.prefix, 'build prefix')
  const output = absolute(input.output, 'runtime output')
  const inspectorPath = absolute(input.inspector, 'inspector')
  const inspectBinary = input.inspectBinary ?? inspectWorldFfmpegBinary
  await assertDirectory(prefix)
  await assertDirectory(output)
  if (isContained(REPOSITORY_ROOT, output)) {
    throw new Error('World FFmpeg generated runtime output must stay outside the source repository.')
  }
  const ffmpegRoot = join(output, 'ffmpeg')
  const bundleRoot = join(ffmpegRoot, target)
  const binRoot = join(bundleRoot, 'bin')
  await mkdir(binRoot, { recursive: true, mode: 0o755 })
  await chmod(join(output, 'ffmpeg'), 0o755)
  await chmod(bundleRoot, 0o755)
  await chmod(binRoot, 0o755)
  if ((await readdir(binRoot)).length !== 0 || (await readdir(bundleRoot)).some((entry) => entry !== 'bin')) {
    throw new Error('World FFmpeg runtime staging destination is not empty.')
  }

  const executableName = target === 'win32-x64' ? 'ffmpeg.exe' : 'ffmpeg'
  const executableSource = join(prefix, 'bin', executableName)
  await copyOrdinary(executableSource, join(binRoot, executableName), target === 'win32-x64' ? null : 0o755, prefix)
  const candidates = await libraryCandidates(prefix, target)
  const bundledNames = [...candidates.keys()].sort(codeUnitCompare)
  const queue = [executableSource]
  const copied = new Set()
  while (queue.length > 0) {
    const binary = queue.shift()
    const audit = await inspectBinary(binary, { target, bundledNames, inspectorPath })
    for (const dependency of audit.bundledDependencies) {
      if (copied.has(dependency)) continue
      const source = candidates.get(dependency)
      if (!source) throw new Error(`World FFmpeg linked library is absent from the build prefix: ${dependency}`)
      copied.add(dependency)
      await copyOrdinary(source, join(binRoot, dependency), target === 'win32-x64' ? null : 0o644, prefix)
      queue.push(source)
    }
  }
  if (copied.size < 1) throw new Error('World FFmpeg staged runtime has no shared-library closure.')

  const licenseParts = [
    'Modly Worlds optional FFmpeg runtime\nFFmpeg 7.1.1\nlibvpx 1.15.2\nlibopus 1.5.2\nzlib 1.3.2\n\n',
    await readFile(join(LICENSE_ROOT, 'LGPL-2.1.txt'), 'utf8'),
    '\n\n--- libvpx license ---\n', await readFile(join(LICENSE_ROOT, 'libvpx-LICENSE.txt'), 'utf8'),
    '\n\n--- libvpx patent grant ---\n', await readFile(join(LICENSE_ROOT, 'libvpx-PATENTS.txt'), 'utf8'),
    '\n\n--- libopus license ---\n', await readFile(join(LICENSE_ROOT, 'opus-COPYING.txt'), 'utf8'),
    '\n\n--- zlib license ---\n', await readFile(join(LICENSE_ROOT, 'zlib-LICENSE.txt'), 'utf8'),
  ]
  const licensePath = join(bundleRoot, 'LICENSE.txt')
  const handle = await open(licensePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644)
  try {
    await handle.writeFile(licenseParts.join(''))
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (target !== 'win32-x64') await chmod(licensePath, 0o644)
  await syncWorldFfmpegDirectory(binRoot, input.durability)
  await syncWorldFfmpegDirectory(bundleRoot, input.durability)
  await syncWorldFfmpegDirectory(ffmpegRoot, input.durability)
  await syncWorldFfmpegDirectory(output, input.durability)
  return bundleRoot
}

async function libraryCandidates(prefix, target) {
  const roots = target === 'win32-x64' ? [join(prefix, 'bin'), join(prefix, 'lib')] : [join(prefix, 'lib')]
  const candidates = new Map()
  for (const root of roots) {
    let names
    try { names = await readdir(root) } catch { continue }
    for (const name of names.sort(codeUnitCompare)) {
      if (!isSharedLibraryName(name, target)) continue
      if (candidates.has(name)) throw new Error(`Duplicate World FFmpeg library name in build prefix: ${name}`)
      candidates.set(name, join(root, name))
    }
  }
  return candidates
}

async function copyOrdinary(source, destination, mode, prefix) {
  const sourceRealPath = await realpath(source)
  if (!isContained(prefix, sourceRealPath)) throw new Error('World FFmpeg build artifact escaped its prefix.')
  const info = await lstat(sourceRealPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) throw new Error('World FFmpeg build artifact is not an ordinary file.')
  await copyFile(sourceRealPath, destination, constants.COPYFILE_EXCL)
  if (mode !== null) await chmod(destination, mode)
  await syncWorldFfmpegFile(destination)
  const copied = await lstat(destination)
  if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1 || copied.size !== info.size) {
    throw new Error('World FFmpeg staged artifact identity is invalid.')
  }
}

async function assertDirectory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('World FFmpeg staging input is not an ordinary directory.')
}

function isContained(root, candidate) {
  const suffix = relative(root, candidate)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function requireTarget(value) {
  if (!['linux-arm64', 'linux-x64', 'darwin-arm64', 'win32-x64'].includes(value)) {
    throw new Error('World FFmpeg staging target is unsupported.')
  }
  return value
}

function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function isSharedLibraryName(name, target) {
  if (target === 'win32-x64') return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.dll$/i.test(name)
  if (target === 'darwin-arm64') return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.dylib$/.test(name)
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}\.so(?:\.\d{1,4})*$/.test(name)
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || values.has(key)) return null
    values.set(key, value)
  }
  if (values.size !== 4) return null
  return { prefix: values.get('--prefix'), output: values.get('--output'), target: values.get('--target'), inspector: values.get('--inspector') }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = parseArguments(process.argv.slice(2))
  if (!input) {
    process.stderr.write('Usage: stage-world-ffmpeg-runtime.mjs --prefix <absolute-dir> --output <absolute-empty-dir> --target <tuple> --inspector <absolute-path>\n')
    process.exitCode = 1
  } else {
    void stageWorldFfmpegRuntime(input).then((root) => process.stdout.write(`${root}\n`), (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'World FFmpeg runtime staging failed.'}\n`)
      process.exitCode = 1
    })
  }
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
