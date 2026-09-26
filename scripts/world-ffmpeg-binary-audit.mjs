import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const TOOL_TIMEOUT_MS = 30_000
const MAX_CONFIGURATION_BYTES = 64 * 1024
const MAX_CONFIGURATION_FLAGS = 256
// FFmpeg prints values with spaces or commas in single quotes. Treat each
// argument as one token, never as a shell program to execute or interpolate.
const CONFIGURATION_FLAG = /--[a-z][a-z0-9-]*(?:=(?:[^\s'"\0]+|'[^'\r\n\0]*'))?(?=\s|$)/y
const QUOTED_COMPONENT_LIST = /^(--enable-(?:decoder|demuxer|encoder|filter|muxer|parser|protocol)=)'([a-z0-9_]+(?:,[a-z0-9_]+)+)'$/
const EXACT_SYSTEM_INTERPRETERS = Object.freeze({
  'linux-arm64': Object.freeze(['/lib/ld-linux-aarch64.so.1']),
  'linux-x64': Object.freeze(['/lib64/ld-linux-x86-64.so.2']),
  'darwin-arm64': Object.freeze(['/usr/lib/dyld']),
  'win32-x64': Object.freeze([]),
})

const CODEC_LIBRARIES = Object.freeze({
  'linux-arm64': 'libavcodec.so.61',
  'linux-x64': 'libavcodec.so.61',
  'darwin-arm64': 'libavcodec.61.dylib',
  'win32-x64': 'avcodec-61.dll',
})

export async function probeWorldFfmpegBinary(executablePath, { supplyChain, target, parserInspectorPath, parserListPath, runTool = runBoundedTool }) {
  const executable = requireAbsolute(executablePath, 'FFmpeg executable')
  const version = await runTool(executable, ['-version'], dirname(executable))
  if (!/^ffmpeg version 7\.1\.1(?:\s|$)/m.test(version.stdout)) {
    throw new Error('World FFmpeg probe found the wrong FFmpeg version.')
  }
  const configurationLine = version.stdout.split('\n').find((line) => line.startsWith('configuration:'))
  if (!configurationLine) throw new Error('World FFmpeg probe found no build configuration.')
  assertWorldFfmpegConfiguration(configurationLine.slice('configuration:'.length).trim(), supplyChain.ffmpegConfigure)

  for (const [kind, command] of [
    ['encoders', '-encoders'], ['decoders', '-decoders'], ['demuxers', '-demuxers'],
    ['filters', '-filters'], ['muxers', '-muxers'],
  ]) {
    const output = await runTool(executable, ['-hide_banner', command], dirname(executable))
    assertWorldFfmpegRuntimeComponentClosure(parseWorldFfmpegComponentTable(output.stdout, kind), supplyChain.build, kind)
  }
  const protocols = await runTool(executable, ['-hide_banner', '-protocols'], dirname(executable))
  assertWorldFfmpegRuntimeComponentClosure(parseWorldFfmpegProtocols(protocols.stdout), supplyChain.build, 'protocols')
  const parserInspector = requireAbsolute(parserInspectorPath, 'parser inspector')
  const generatedParserList = requireAbsolute(parserListPath, 'generated parser list')
  const libraryName = CODEC_LIBRARIES[target]
  if (!libraryName) throw new Error('World FFmpeg parser probe target is unsupported.')
  const libraryPath = join(dirname(executable), libraryName)
  const [libraryInfo, parserListInfo] = await Promise.all([lstat(libraryPath), lstat(generatedParserList)])
  if (!libraryInfo.isFile() || libraryInfo.isSymbolicLink() || libraryInfo.nlink !== 1
    || !parserListInfo.isFile() || parserListInfo.isSymbolicLink() || parserListInfo.nlink !== 1
    || parserListInfo.size < 1 || parserListInfo.size > 4096) {
    throw new Error('World FFmpeg parser audit input is not an ordinary bounded file.')
  }
  const generatedParsers = assertWorldFfmpegGeneratedParserList(await readFile(generatedParserList, 'utf8'))
  const parserOutput = await runTool(parserInspector, [libraryPath], dirname(executable))
  const parserNames = parseWorldFfmpegNativeParserOutput(parserOutput.stdout)
  assertWorldFfmpegRuntimeComponentClosure(generatedParsers, supplyChain.build, 'parsers')
  assertWorldFfmpegRuntimeComponentClosure(parserNames, supplyChain.build, 'parsers')
  return {
    ffmpegVersion: '7.1.1',
    configuration: [...supplyChain.ffmpegConfigure],
    build: supplyChain.build,
  }
}

export function assertWorldFfmpegGeneratedParserList(content) {
  if (typeof content !== 'string' || !/^static const AVCodecParser \* const parser_list\[\] = \{\n    &ff_png_parser,\n    NULL \};\n$/.test(content)) {
    throw new Error('World FFmpeg generated parser closure is invalid.')
  }
  return ['png']
}

export function parseWorldFfmpegNativeParserOutput(output) {
  if (typeof output !== 'string' || !/^[a-z0-9_]+\n(?:[a-z0-9_]+\n)*$/.test(output) || output.length > 4096) {
    throw new Error('World FFmpeg native parser closure is invalid.')
  }
  return output.trimEnd().split('\n')
}

export function assertWorldFfmpegRuntimeComponentClosure(actual, build, kind) {
  const expected = kind === 'encoders' ? [...build.audioEncoders, ...build.videoEncoders]
    : ['decoders', 'demuxers', 'filters', 'muxers', 'parsers', 'protocols'].includes(kind) ? build[kind] : null
  if (!Array.isArray(actual) || !Array.isArray(expected) || !sameArray([...actual].sort(codeUnitCompare), [...expected].sort(codeUnitCompare))) {
    throw new Error(`World FFmpeg probe ${kind} do not match the exact audited closure.`)
  }
}

export async function inspectWorldFfmpegBinary(path, { target, bundledNames, inspectorPath }) {
  const binary = requireAbsolute(path, 'binary')
  const inspector = requireAbsolute(inspectorPath, 'binary inspector')
  const bundled = new Set(bundledNames)
  if (target === 'linux-arm64' || target === 'linux-x64') {
    const [header, dynamic, program, versions] = await Promise.all([
      runBoundedTool(inspector, ['-hW', binary], dirname(binary)),
      runBoundedTool(inspector, ['-dW', binary], dirname(binary)),
      runBoundedTool(inspector, ['-lW', binary], dirname(binary)),
      ...(target === 'linux-arm64' ? [runBoundedTool(inspector, ['-VW', binary], dirname(binary))] : [Promise.resolve(null)]),
    ])
    assertWorldFfmpegLinuxElfHeader(header.stdout, target)
    const needed = [...dynamic.stdout.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map((match) => match[1])
    const interpreter = program.stdout.match(/Requesting program interpreter:\s*([^\]]+)\]/)?.[1]
    const searches = [...dynamic.stdout.matchAll(/\((?:RUNPATH|RPATH)\).*?\[([^\]]*)\]/g)]
      .flatMap((match) => match[1].split(':')).filter(Boolean)
    const classified = classifyWorldFfmpegDynamicReferences({
      dependencies: needed,
      loaderSearch: searches,
      bundledNames: bundled,
      target,
      systemInterpreter: interpreter ?? null,
    })
    return target === 'linux-arm64'
      ? { ...classified, requiredGlibcVersions: parseWorldFfmpegGlibcRequirements(versions.stdout, '2.39') }
      : classified
  }
  if (target === 'darwin-arm64') {
    const [links, loadCommands] = await Promise.all([
      runBoundedTool(inspector, ['-L', binary], dirname(binary)),
      runBoundedTool(inspector, ['-l', binary], dirname(binary)),
    ])
    const dependencies = links.stdout.split('\n').slice(1)
      .map((line) => line.trim().split(/\s+\(/, 1)[0]).filter(Boolean)
    const searches = []
    let interpreter = null
    const lines = loadCommands.stdout.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const command = lines[index].trim()
      if (command === 'cmd LC_RPATH') {
        const pathLine = lines.slice(index + 1, index + 6).find((line) => /^\s*path\s+/.test(line))
        if (pathLine) searches.push(pathLine.trim().slice(5).split(' (offset ', 1)[0])
      } else if (command === 'cmd LC_LOAD_DYLINKER') {
        if (interpreter !== null) throw new Error('World FFmpeg binary has duplicate system interpreters.')
        const nameLine = lines.slice(index + 1, index + 6).find((line) => /^\s*name\s+/.test(line))
        if (!nameLine) throw new Error('World FFmpeg binary has an invalid system interpreter.')
        interpreter = nameLine.trim().slice(5).split(' (offset ', 1)[0]
      }
    }
    return classifyWorldFfmpegDynamicReferences({
      dependencies,
      loaderSearch: searches,
      bundledNames: bundled,
      target,
      systemInterpreter: interpreter,
    })
  }
  if (target === 'win32-x64') {
    const result = await runBoundedTool(inspector, ['-p', binary], dirname(binary))
    const dependencies = [...result.stdout.matchAll(/^\s*DLL Name:\s*(\S+)\s*$/gmi)].map((match) => match[1])
    return classifyWorldFfmpegDynamicReferences({
      dependencies,
      loaderSearch: [],
      bundledNames: bundled,
      target,
      systemInterpreter: null,
    })
  }
  throw new Error('World FFmpeg binary audit target is unsupported.')
}

export function parseWorldFfmpegGlibcRequirements(output, baseline) {
  if (typeof output !== 'string' || !/^\d+\.\d+$/.test(baseline)) {
    throw new Error('World FFmpeg GLIBC version audit input is invalid.')
  }
  let inNeeds = false
  let sawNeeds = false
  const versions = new Set()
  for (const line of output.split('\n')) {
    if (/^Version needs section '\.gnu\.version_r' contains \d+ entr(?:y|ies):$/.test(line)) {
      inNeeds = true
      sawNeeds = true
      continue
    }
    if (/^Version (?:symbols|definition) section /.test(line)) inNeeds = false
    if (!inNeeds) continue
    for (const match of line.matchAll(/\bName:\s+(\S+)/g)) {
      if (!match[1].startsWith('GLIBC_')) continue
      const version = match[1].slice('GLIBC_'.length)
      if (!/^\d+\.\d+$/.test(version)) {
        throw new Error('World FFmpeg GLIBC symbol requirement is invalid.')
      }
      const [major, minor] = version.split('.').map(Number)
      const [baseMajor, baseMinor] = baseline.split('.').map(Number)
      if (major > baseMajor || (major === baseMajor && minor > baseMinor)) {
        throw new Error('World FFmpeg binary exceeds the declared GLIBC baseline.')
      }
      versions.add(version)
    }
  }
  if (!sawNeeds && !output.includes('No version information found in this file.')) {
    throw new Error('World FFmpeg GLIBC version needs are unavailable.')
  }
  return [...versions].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

export function assertWorldFfmpegLinuxElfHeader(header, target) {
  const machine = target === 'linux-arm64' ? 'AArch64'
    : target === 'linux-x64' ? 'Advanced Micro Devices X86-64' : null
  if (machine === null || typeof header !== 'string'
    || !/^\s*Class:\s+ELF64\s*$/m.test(header)
    || !/^\s*Data:\s+2's complement, little endian\s*$/m.test(header)
    || header.match(/^\s*Machine:\s*(.*?)\s*$/m)?.[1] !== machine) {
    throw new Error('World FFmpeg binary ELF architecture is invalid.')
  }
}

export function classifyWorldFfmpegDynamicReferences(input) {
  const { dependencies, loaderSearch, target } = input
  const bundledNames = input.bundledNames instanceof Set
    ? input.bundledNames
    : new Set(input.bundledNames)
  const systemInterpreter = input.systemInterpreter ?? null
  if (!Object.hasOwn(EXACT_SYSTEM_INTERPRETERS, target)) {
    throw new Error('World FFmpeg binary audit target is unsupported.')
  }
  if (systemInterpreter !== null
    && !EXACT_SYSTEM_INTERPRETERS[target].includes(systemInterpreter)) {
    throw new Error('World FFmpeg binary system interpreter is invalid.')
  }
  if (target === 'darwin-arm64'
    && dependencies.some((dependency) => EXACT_SYSTEM_INTERPRETERS[target].includes(dependency))) {
    throw new Error('World FFmpeg binary interpreter must not also be an ordinary dependency.')
  }
  if (((target === 'linux-arm64' || target === 'linux-x64') && dependencies.some((dependency) => (
    dependency !== basename(dependency) || dependency.includes('\\')
  ))) || (target === 'win32-x64' && dependencies.some((dependency) => (
    typeof dependency !== 'string'
      || dependency.includes('/')
      || dependency.includes('\\')
      || dependency.includes(':')
      || dependency === '.'
      || dependency === '..'
  )))) {
    throw new Error('World FFmpeg dependency has an unsafe loader identity.')
  }
  const bundledDependencies = []
  const systemDependencies = []
  const windowsBundledNames = target === 'win32-x64'
    ? new Map([...bundledNames].map((name) => [name.toLowerCase(), name]))
    : null
  for (const raw of dependencies) {
    const name = basename(raw.replaceAll('\\', '/'))
    const bundledName = windowsBundledNames?.get(name.toLowerCase()) ?? (bundledNames.has(name) ? name : null)
    if (bundledName) {
      const validIdentity = target === 'darwin-arm64'
        ? raw === `@rpath/${bundledName}` || raw === `@loader_path/${bundledName}`
        : target === 'win32-x64' ? raw.toLowerCase() === name.toLowerCase() : raw === name
      if (!validIdentity) throw new Error('World FFmpeg bundled dependency has an unsafe loader identity.')
      bundledDependencies.push(bundledName)
    } else {
      systemDependencies.push(target === 'darwin-arm64' ? raw : name)
    }
  }
  // Mach-O's LC_LOAD_DYLINKER is a separate interpreter authority, not an
  // LC_LOAD_DYLIB dependency. Reclassifying /usr/lib/dyld as bare "dyld"
  // loses its canonical identity and makes the assembler contradict its own
  // exact interpreter check.
  if (systemInterpreter !== null && target !== 'darwin-arm64') {
    systemDependencies.push(basename(systemInterpreter))
  }
  return {
    bundledDependencies: sortedUnique(bundledDependencies),
    systemDependencies: sortedUnique(systemDependencies),
    loaderSearch: sortedUnique(loaderSearch),
    systemInterpreter,
  }
}

export function assertWorldFfmpegConfiguration(configuration, required) {
  if (typeof configuration !== 'string' || configuration.length === 0
    || configuration.length > MAX_CONFIGURATION_BYTES || /[\r\n\0]/.test(configuration)) {
    throw new Error('World FFmpeg probe configuration has invalid framing.')
  }
  const actual = []
  let position = 0
  while (position < configuration.length) {
    while (configuration[position] === ' ' || configuration[position] === '\t') position += 1
    if (position === configuration.length) break
    CONFIGURATION_FLAG.lastIndex = position
    const match = CONFIGURATION_FLAG.exec(configuration)
    if (!match) throw new Error('World FFmpeg probe configuration contains a malformed flag.')
    const component = QUOTED_COMPONENT_LIST.exec(match[0])
    actual.push(component ? `${component[1]}${component[2]}` : match[0])
    if (actual.length > MAX_CONFIGURATION_FLAGS) {
      throw new Error('World FFmpeg probe configuration has too many flags.')
    }
    position = CONFIGURATION_FLAG.lastIndex
  }
  assertConfiguration(actual, required)
}

function assertConfiguration(actual, required) {
  const counts = new Map()
  for (const flag of actual) counts.set(flag, (counts.get(flag) ?? 0) + 1)
  if (required.some((flag) => counts.get(flag) !== 1)) {
    throw new Error('World FFmpeg probe configuration is missing an exact required flag.')
  }
  if (actual.some((flag) => /^--enable-(?:gpl|nonfree|version3|network)$/.test(flag))) {
    throw new Error('World FFmpeg probe configuration enables a forbidden feature.')
  }
  const componentPrefix = /^--enable-(?:decoder|demuxer|encoder|filter|muxer|parser|protocol)=/
  const expectedComponentFlags = required.filter((flag) => componentPrefix.test(flag)).sort(codeUnitCompare)
  const actualComponentFlags = actual.filter((flag) => componentPrefix.test(flag)).sort(codeUnitCompare)
  if (!sameArray(actualComponentFlags, expectedComponentFlags)) {
    throw new Error('World FFmpeg probe configuration enables an undeclared component.')
  }
}

export function parseWorldFfmpegComponentTable(output, kind) {
  const names = []
  for (const line of output.split('\n')) {
    let match = null
    if (kind === 'encoders' || kind === 'decoders') {
      match = line.match(/^\s*[A-Z.]{6}\s+([a-z0-9_-]+)\s/i)
    } else if (kind === 'demuxers' || kind === 'muxers') {
      match = line.match(/^\s*[DE]\s+([a-z0-9_]+)(?:,[a-z0-9_]+)*\s/i)
    } else if (kind === 'filters') {
      match = line.match(/^\s*[TSC.]{3}\s+([a-z0-9_]+)\s/i)
    } else if (kind === 'parsers') {
      match = line.match(/^\s{2}([a-z0-9_]+)\s*$/i)
    }
    if (match) names.push(match[1])
  }
  return sortedUnique(names)
}

export function parseWorldFfmpegProtocols(output) {
  return sortedUnique(output.split('\n').map((line) => line.trim()).filter((line) => /^[a-z0-9_]+$/i.test(line)
    && line !== 'Input' && line !== 'Output'))
}

function runBoundedTool(executable, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(executable, args, {
      cwd,
      env: Object.freeze({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }),
      shell: false,
      windowsHide: true,
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`World FFmpeg audit command failed: ${String(stderr).slice(0, 4096)}`))
        return
      }
      resolvePromise({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`World FFmpeg ${label} must be an absolute path.`)
  }
  return resolve(value)
}

function sortedUnique(values) {
  return [...new Set(values)].sort(codeUnitCompare)
}

function sameArray(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
