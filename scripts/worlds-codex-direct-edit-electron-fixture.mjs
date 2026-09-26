#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSource = path.join(repositoryRoot, 'scripts/worlds-codex-direct-edit-electron-fixture')
const require = createRequire(import.meta.url)
const {
  PINNED_RUNTIME_ADDITIONS,
  createArgvSha256,
  createEnvironmentContract,
  createLaunchBindingSha256,
  createRuntimeEnvironmentAllowance,
  inspectRuntimeExecutable,
  materializePinnedRuntimeIdentity,
  validateRuntimeIdentity,
} = require(path.join(fixtureSource, 'bootstrap.cjs'))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const receipt = (bytes) => ({ bytes: bytes.length, sha256: sha256(bytes) })
const execFileAsync = promisify(execFile)

async function readGitCustody(privateHome) {
  const options = { cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: privateHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C.UTF-8' } }
  const [{ stdout: head }, { stdout: branch }, { stdout: porcelain }] = await Promise.all([
    execFileAsync('/usr/bin/git', ['rev-parse', 'HEAD'], options),
    execFileAsync('/usr/bin/git', ['rev-parse', '--abbrev-ref', 'HEAD'], options),
    execFileAsync('/usr/bin/git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options),
  ])
  return { head: head.toString().trim(), branch: branch.toString().trim(), porcelain: receipt(porcelain) }
}

export function parseBuildArguments(args) {
  if (args.length !== 1 || args[0] !== '--build-only') {
    throw new Error('Usage: node scripts/worlds-codex-direct-edit-electron-fixture.mjs --build-only (never launches Electron).')
  }
  return { buildOnly: true }
}

export function assertRepositoryNodeRuntime(versions = process.versions, execPath = process.execPath) {
  const major = Number.parseInt(String(versions.node).split('.')[0], 10)
  if (major !== 24 || execPath === '/usr/bin/node') {
    throw new Error('Worlds C3 fixture build requires the repository Node 24 runtime; /usr/bin/node is forbidden.')
  }
}

async function listFiles(root, prefix = '') {
  const files = []
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(root, relative))
    else if (entry.isFile()) files.push(relative)
    else throw new Error(`Unexpected linked or special fixture file: ${relative}`)
  }
  return files.sort()
}

async function collectProjectLocalImportClosure(entries) {
  const closure = new Set()
  const visit = async (filename) => {
    filename = path.resolve(filename)
    if (closure.has(filename)) return
    if (!filename.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('Config import escaped the repository.')
    const bytes = await readFile(filename)
    closure.add(filename)
    const source = bytes.toString('utf8')
    const imports = [...source.matchAll(/^\s*(?:import|export)(?:\s+type)?(?:\s+[^'"\n;]+?\s+from)?\s*['"](\.{1,2}\/[^'"]+)['"]/gm)]
      .map((match) => match[1])
    for (const specifier of imports) {
      const candidate = path.resolve(path.dirname(filename), specifier)
      const resolved = await stat(candidate).then((info) => info.isFile() ? candidate : null, () => null)
      if (!resolved) throw new Error(`Unresolved project-local config import: ${specifier}`)
      await visit(resolved)
    }
  }
  for (const entry of entries) await visit(entry)
  return [...closure].sort()
}

async function selectPinnedDisplay() {
  for (let number = 97; number <= 199; number += 1) {
    const lockPath = `/tmp/.X${number}-lock`
    const socketPath = `/tmp/.X11-unix/X${number}`
    const occupied = await Promise.all([lockPath, socketPath].map((filename) => lstat(filename).then(() => true, () => false)))
    if (!occupied.some(Boolean)) return { name: `:${number}`, number, lockPath, socketPath }
  }
  throw new Error('No unused private X display candidate is available.')
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

export function nativeAuthorityGateCommand(authorityPath, expectedOwnerUid) {
  if (!path.isAbsolute(authorityPath) || !Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 0) {
    throw new Error('Invalid native authority custody gate.')
  }
  const authority = shellQuote(authorityPath)
  return [
    `test -f ${authority}`,
    `test ! -L ${authority}`,
    `test "$(/usr/bin/stat -c '%u' ${authority})" = ${shellQuote(expectedOwnerUid)}`,
    `test "$(/usr/bin/stat -c '%a' ${authority})" = '600'`,
    `test "$(/usr/bin/stat -c '%h' ${authority})" = '1'`,
  ].join('\n')
}

async function ensurePrivateDirectory(filename) {
  await chmod(filename, 0o700)
  const info = await lstat(filename)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
    || (info.mode & 0o777) !== 0o700 || await realpath(filename) !== filename) {
    throw new Error(`Unsafe fixture directory: ${filename}`)
  }
  return { path: filename, uid: info.uid, mode: info.mode & 0o777 }
}

export async function prepareNativeState(outputDirectory) {
  if (path.dirname(outputDirectory) !== '/tmp' || !/^modly-worlds-c3-native-[A-Za-z0-9_-]+$/.test(path.basename(outputDirectory))
    || await realpath(outputDirectory) !== outputDirectory) throw new Error('Expected a new private C3 fixture directory.')
  const paths = { stateRoot: path.join(outputDirectory, 'native-state') }
  for (const name of ['userData', 'sessionData', 'crashDumps', 'home', 'config', 'cache', 'tmp', 'workspace', 'runtime', 'profiles', 'x11']) {
    paths[name] = path.join(paths.stateRoot, name)
  }
  const scenarios = {}
  const preparedDirectories = [await ensurePrivateDirectory(outputDirectory)]
  for (const filename of Object.values(paths)) {
    await mkdir(filename, { recursive: true, mode: 0o700 })
    preparedDirectories.push(await ensurePrivateDirectory(filename))
  }
  for (const scenario of ['primary', 'duplicate-loss', 'cancellation']) {
    const root = path.join(paths.stateRoot, `scenario-${scenario}`)
    const entries = { root, workspace: path.join(root, 'workspace'), runtime: path.join(root, 'runtime'),
      profile: path.join(paths.profiles, scenario), evidence: path.join(root, 'evidence') }
    for (const filename of Object.values(entries)) {
      await mkdir(filename, { recursive: true, mode: 0o700 })
      preparedDirectories.push(await ensurePrivateDirectory(filename))
    }
    scenarios[scenario] = entries
  }
  const candidate = await selectPinnedDisplay()
  const display = { ...candidate, authorityPath: path.join(paths.x11, 'Xauthority') }
  const environment = {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache,
    XDG_RUNTIME_DIR: paths.runtime,
    TMPDIR: paths.tmp,
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    DBUS_SESSION_BUS_ADDRESS: 'disabled:',
    DISPLAY: display.name,
    XAUTHORITY: display.authorityPath,
  }
  const expectedRuntimeIdentity = materializePinnedRuntimeIdentity(repositoryRoot)
  const argv = [expectedRuntimeIdentity.executable.path, path.join(outputDirectory, 'bootstrap.cjs'),
    `--user-data-dir=${paths.userData}`]
  const environmentContract = createEnvironmentContract(environment)
  const electronPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'node_modules/electron/package.json'), 'utf8'))
  const actualRuntimeIdentity = {
    schema: expectedRuntimeIdentity.schema,
    electronVersion: electronPackage.version,
    platform: process.platform,
    arch: process.arch,
    executable: inspectRuntimeExecutable(argv[0]),
  }
  validateRuntimeIdentity(expectedRuntimeIdentity, actualRuntimeIdentity)
  const runtimeEnvironmentAllowance = createRuntimeEnvironmentAllowance(
    environmentContract, PINNED_RUNTIME_ADDITIONS, expectedRuntimeIdentity)
  const supervisor = { commandShape: 'supervised-Xvfb-then-direct-env-i-Electron', expectedOwnerUid: process.getuid(),
    environmentKeys: Object.keys(environment).sort(), evidencePath: path.join(paths.stateRoot, 'supervisor-preexec.v2.json'),
    startedEvidencePath: path.join(paths.stateRoot, 'supervisor-started.json') }
  return { paths, display, supervisor, scenarios, argv, environment, preparedDirectories,
    environmentContract, runtimeEnvironmentAllowance, argvSha256: createArgvSha256(argv), launchBindingSha256: '' }
}

export function nativeSupervisorPreexecReceiptFormat(launch) {
  return `${JSON.stringify({
    schema: 'modly.worlds-c3-supervisor-preexec.v2', phase: 'PRE_EXEC', manifestFileSha256: '%s',
    launchBindingSha256: launch.launchBindingSha256, environmentContractSha256: launch.environmentContract.sha256,
    environmentEntries: launch.environmentContract.entries, argvSha256: launch.argvSha256,
    supervisorPid: '%SUPERVISOR_PID%', supervisorUid: '%SUPERVISOR_UID%', xvfbPid: '%XVFB_PID%',
    display: launch.display.name, authorityPath: launch.display.authorityPath,
    authority: { uid: '%AUTHORITY_UID%', mode: '%AUTHORITY_MODE%', nlink: '%AUTHORITY_NLINK%' }, authenticatedReady: true,
  }).replace('"%SUPERVISOR_PID%"', '%s').replace('"%SUPERVISOR_UID%"', '%s').replace('"%XVFB_PID%"', '%s')
    .replace('"%AUTHORITY_UID%"', '%s').replace('%AUTHORITY_MODE%', '%s').replace('"%AUTHORITY_NLINK%"', '%s')}\n`
}

function nativeSupervisorCommand(launch) {
  const env = launch.environmentContract.entries
    .map(([key]) => `${key}=${shellQuote(launch.environment[key])}`)
    .join(' ')
  const xvfbEnv = [
    `HOME=${shellQuote(launch.paths.home)}`, `PATH=${shellQuote('/usr/bin:/bin')}`,
    `LANG=${shellQuote('C.UTF-8')}`, `LC_ALL=${shellQuote('C.UTF-8')}`,
    `XAUTHORITY=${shellQuote(launch.display.authorityPath)}`,
  ].join(' ')
  const preexecFormat = nativeSupervisorPreexecReceiptFormat(launch)
  const startedFormat = JSON.stringify({
    schema: 'modly.worlds-c3-supervisor-started.v1', launchBindingSha256: launch.launchBindingSha256,
    supervisorPid: '%SUPERVISOR_PID%', xvfbPid: '%XVFB_PID%', electronPid: '%ELECTRON_PID%', authenticatedReady: true,
  }).replace('"%SUPERVISOR_PID%"', '%s').replace('"%XVFB_PID%"', '%s').replace('"%ELECTRON_PID%"', '%s')
  const script = [
    'set -eu',
    'umask 077',
    `authority=${shellQuote(launch.display.authorityPath)}`,
    `lock=${shellQuote(launch.display.lockPath)}`,
    `socket=${shellQuote(launch.display.socketPath)}`,
    'test ! -e "$authority" && test ! -e "$lock" && test ! -e "$socket"',
    'set -C; : > "$authority"; set +C; /usr/bin/chmod 600 "$authority"',
    `test "$(/usr/bin/stat -c '%u:%a:%h:%F' ${shellQuote(launch.paths.x11)})" = "$(/usr/bin/id -u):700:2:directory"`,
    nativeAuthorityGateCommand(launch.display.authorityPath, launch.supervisor.expectedOwnerUid),
    'cookie=$(/usr/bin/mcookie)',
    `/usr/bin/env -i ${xvfbEnv} /usr/bin/xauth -f "$authority" add ${shellQuote(launch.display.name)} . "$cookie"`,
    'unset cookie',
    `/usr/bin/env -i ${xvfbEnv} /usr/bin/Xvfb ${shellQuote(launch.display.name)} -screen 0 1440x960x24 -nolisten tcp -auth "$authority" >${shellQuote(path.join(launch.paths.stateRoot, 'xvfb.stdout.log'))} 2>${shellQuote(path.join(launch.paths.stateRoot, 'xvfb.stderr.log'))} &`,
    'xvfb_pid=$!',
    'electron_pid=""',
    'cleanup() { status=$?; trap - EXIT HUP INT TERM; if [ -n "$electron_pid" ]; then /bin/kill -TERM "$electron_pid" 2>/dev/null || true; wait "$electron_pid" 2>/dev/null || true; fi; /bin/kill -TERM "$xvfb_pid" 2>/dev/null || true; wait "$xvfb_pid" 2>/dev/null || true; exit "$status"; }',
    'trap cleanup EXIT HUP INT TERM',
    'ready=0; attempts=0',
    `while [ "$attempts" -lt 100 ]; do /bin/kill -0 "$xvfb_pid" 2>/dev/null || exit 1; if /usr/bin/env -i DISPLAY=${shellQuote(launch.display.name)} XAUTHORITY="$authority" PATH=${shellQuote('/usr/bin:/bin')} /usr/bin/xdpyinfo >/dev/null 2>&1; then ready=1; break; fi; attempts=$((attempts + 1)); /bin/sleep 0.05; done`,
    'test "$ready" -eq 1 && test -S "$socket"',
    `manifest=${shellQuote(path.join(launch.paths.stateRoot.slice(0, -'/native-state'.length), 'fixture-build.json'))}`,
    `preexec=${shellQuote(launch.supervisor.evidencePath)}`,
    `started=${shellQuote(launch.supervisor.startedEvidencePath)}`,
    'test ! -e "$preexec" && test ! -e "$started"',
    'manifest_line=$(/usr/bin/sha256sum "$manifest")',
    'manifest_sha=${manifest_line%% *}',
    'test "${#manifest_sha}" -eq 64',
    'set -C',
    `printf ${shellQuote(preexecFormat)} "$manifest_sha" "$$" "$(/usr/bin/id -u)" "$xvfb_pid" "$(/usr/bin/stat -c '%u' "$authority")" "$(/usr/bin/stat -c '%a' "$authority")" "$(/usr/bin/stat -c '%h' "$authority")" >"$preexec"`,
    'set +C',
    '/usr/bin/chmod 600 "$preexec"',
    nativeAuthorityGateCommand(launch.supervisor.evidencePath, launch.supervisor.expectedOwnerUid),
    `/usr/bin/env -i ${env} ${launch.argv.map(shellQuote).join(' ')} >${shellQuote(path.join(launch.paths.stateRoot, 'electron.stdout.log'))} 2>${shellQuote(path.join(launch.paths.stateRoot, 'electron.stderr.log'))} &`,
    'electron_pid=$!',
    'set -C',
    `printf ${shellQuote(`${startedFormat}\n`)} "$$" "$xvfb_pid" "$electron_pid" >"$started"`,
    'set +C',
    '/usr/bin/chmod 600 "$started"',
    'wait "$electron_pid"',
    'electron_status=$?',
    'electron_pid=""',
    'exit "$electron_status"',
  ].join('\n')
  const syntax = spawnSync('/bin/sh', ['-n', '-c', script], { encoding: 'utf8' })
  if (syntax.status !== 0) throw new Error(`Invalid native supervisor script: ${syntax.stderr.trim()}`)
  return `/usr/bin/timeout --signal=TERM --kill-after=5s 180s /bin/sh -c ${shellQuote(script)}`
}

async function makeTreePrivate(root) {
  await ensurePrivateDirectory(root)
  for (const relative of await listFiles(root)) {
    const filename = path.join(root, relative)
    await chmod(filename, 0o600)
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) {
      throw new Error(`Unsafe fixture output: ${relative}`)
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeTreePrivate(path.join(root, entry.name))
  }
}

export async function buildWorldsCodexDirectEditFixture() {
  assertRepositoryNodeRuntime()
  if (await realpath(process.cwd()) !== repositoryRoot) throw new Error(`Run build-only from ${repositoryRoot}.`)
  const outputDirectory = await mkdtemp('/tmp/modly-worlds-c3-native-')
  await chmod(outputDirectory, 0o700)
  try {
    const configPath = path.join(repositoryRoot, 'electron.vite.config.ts')
    const configExecutionClosure = await collectProjectLocalImportClosure([
      configPath,
      path.join(repositoryRoot, 'tailwind.config.js'),
      path.join(repositoryRoot, 'postcss.config.js'),
    ])
    const { default: appConfig } = await import(pathToFileURL(configPath).href)
    const renderer = appConfig.renderer
    if (!renderer || !Array.isArray(renderer.plugins)) throw new Error('Production renderer build contract changed.')
    const inputs = new Set([
      fileURLToPath(import.meta.url),
      path.join(repositoryRoot, 'scripts/worlds-codex-direct-edit-electron-fixture.test.mjs'),
      configPath,
      path.join(repositoryRoot, 'tailwind.config.js'),
      path.join(repositoryRoot, 'postcss.config.js'),
      ...configExecutionClosure,
    ])
    const track = { name: 'worlds-c3-native-source-evidence', load(id) {
      const clean = id.split('?')[0]
      if (path.isAbsolute(clean) && !clean.includes('\0')) inputs.add(clean)
      return null
    } }
    const launch = await prepareNativeState(outputDirectory)
    const gitCustody = await readGitCustody(launch.paths.home)
    await copyFile(path.join(fixtureSource, 'bootstrap.cjs'), path.join(outputDirectory, 'bootstrap.cjs'))
    const common = { bundle: true, metafile: true, target: 'es2022', external: ['electron'],
      tsconfig: path.join(fixtureSource, 'tsconfig.json'), logLevel: 'warning', sourcemap: false }
    const bundles = await Promise.all([
      esbuild({ ...common, entryPoints: [path.join(fixtureSource, 'main.ts')], outfile: path.join(outputDirectory, 'main.cjs'),
        platform: 'node', format: 'cjs', define: { 'import.meta.url': JSON.stringify('file:///tmp/modly-worlds-c3-native/main.cjs') } }),
      esbuild({ ...common, entryPoints: [path.join(fixtureSource, 'preload.ts')], outfile: path.join(outputDirectory, 'preload.cjs'),
        platform: 'browser', format: 'cjs' }),
    ])
    await viteBuild({ configFile: false, envFile: false, root: fixtureSource, publicDir: false, base: './',
      cacheDir: path.join(outputDirectory, 'vite-cache'), logLevel: 'warn', resolve: renderer.resolve,
      plugins: [...renderer.plugins, track], css: { postcss: repositoryRoot }, worker: renderer.worker,
      build: { target: renderer.build.target, outDir: path.join(outputDirectory, 'renderer'), emptyOutDir: false,
        minify: false, sourcemap: false, rollupOptions: { input: path.join(fixtureSource, 'index.html') } },
    })
    for (const bundle of bundles) for (const filename of Object.keys(bundle.metafile.inputs)) {
      inputs.add(path.isAbsolute(filename) ? filename : path.resolve(repositoryRoot, filename))
    }
    for (const relative of await listFiles(fixtureSource)) inputs.add(path.join(fixtureSource, relative))
    const sourceInputs = []
    for (const filename of [...inputs].sort()) {
      if (await stat(filename).then((value) => value.isFile(), () => false)) {
        const bytes = await readFile(filename)
        sourceInputs.push({ path: filename, bytes: bytes.length, sha256: sha256(bytes) })
      }
    }
    const sourceAggregateSha256 = sha256(Buffer.from(JSON.stringify(sourceInputs.map(({ path: filename, bytes, sha256: hash }) => [filename, bytes, hash]))))
    const versions = {}
    for (const name of ['electron', 'esbuild', 'vite', 'react', 'react-dom']) {
      versions[name] = JSON.parse(await readFile(path.join(repositoryRoot, 'node_modules', name, 'package.json'), 'utf8')).version
    }
    await makeTreePrivate(outputDirectory)
    const outputs = {}
    for (const relative of await listFiles(outputDirectory)) {
      if (relative === 'fixture-build.json' || relative.startsWith('native-state/') || relative.startsWith('vite-cache/')) continue
      outputs[relative] = receipt(await readFile(path.join(outputDirectory, relative)))
    }
    const outputInventory = Object.keys(outputs).sort()
    const result = {
      schema: 'modly.worlds-codex-direct-edit-native-build.v1',
      scope: 'source-module-c3-direct-edit-native-fixture',
      execution: 'NOT_RUN',
      nativeEvidence: 'ABSENT',
      outputDirectory,
      repositoryRoot,
      builtAt: new Date().toISOString(),
      versions,
      outputs,
      outputInventory,
      sourceInputs,
      sourceAggregateSha256,
      sourceGraph: { definition: 'esbuild-metafiles+vite-load-graph+fixture-tree+project-local-config-import-closure',
        configExecutionClosure },
      gitCustody,
      launch,
      nextCommand: '',
      limits: ['No native Electron or Xvfb execution by this builder', 'No network', 'No auxiliary runtime', 'No live model'],
    }
    launch.launchBindingSha256 = createLaunchBindingSha256(result)
    result.nextCommand = nativeSupervisorCommand(launch)
    await writeFile(path.join(outputDirectory, 'fixture-build.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return result
  } catch (error) {
    await writeFile(path.join(outputDirectory, 'build-failure.txt'), `${String(error)}\n`, { mode: 0o600 }).catch(() => undefined)
    throw new Error(`C3 build-only fixture failed; evidence retained at ${outputDirectory}`, { cause: error })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    parseBuildArguments(process.argv.slice(2))
    console.log(JSON.stringify(await buildWorldsCodexDirectEditFixture(), null, 2))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
