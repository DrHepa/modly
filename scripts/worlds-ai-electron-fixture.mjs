#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSource = path.join(repositoryRoot, 'scripts/worlds-ai-electron-fixture')
const digest = (bytes) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
export function parseBuildArguments(args) {
  if (args.length !== 1 || args[0] !== '--build-only') throw new Error('Usage: node scripts/worlds-ai-electron-fixture.mjs --build-only (never launches Electron or Python).')
  return { buildOnly: true }
}
// Only the main CJS graph needs file metadata; renderer/preload keep their own semantics.
export function mainBuildOptions(outfile) {
  if (!path.isAbsolute(outfile)) throw new Error('Main output must be absolute.')
  return { platform: 'node', format: 'cjs', define: { 'import.meta.url': JSON.stringify(pathToFileURL(outfile).href) },
    logLevel: 'warning', logOverride: { 'empty-import-meta': 'error' } }
}

/** Empty private directories only; no native process, profile, backend or World is initialized. */
export async function prepareNativeState(outputDirectory) {
  if (path.dirname(outputDirectory) !== '/tmp' || !/^modly-worlds-ai-ui-[A-Za-z0-9_-]+$/.test(path.basename(outputDirectory))
    || await realpath(outputDirectory) !== outputDirectory) throw new Error('Expected a new private fixture build directory.')
  const rootInfo = await lstat(outputDirectory)
  if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o777) !== 0o700) throw new Error('Unsafe fixture build directory.')
  const paths = { stateRoot: path.join(outputDirectory, 'native-state') }
  for (const name of ['userData', 'sessionData', 'crashDumps', 'home', 'config', 'cache', 'tmp']) paths[name] = path.join(paths.stateRoot, name)
  paths.agentSessions = path.join(paths.userData, 'agent-sessions')
  const preparedDirectories = []
  for (const filename of Object.values(paths)) {
    await mkdir(filename, { mode: 0o700 })
    const info = await lstat(filename)
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || await realpath(filename) !== filename) throw new Error('Unsafe prepared native state.')
    preparedDirectories.push({ path: filename, uid: info.uid, mode: info.mode & 0o777 })
  }
  const environment = { HOME: paths.home, XDG_CONFIG_HOME: paths.config, XDG_CACHE_HOME: paths.cache, TMPDIR: paths.tmp,
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', DBUS_SESSION_BUS_ADDRESS: 'disabled:' }
  const argv = [path.join(repositoryRoot, 'node_modules/electron/dist/electron'), path.join(outputDirectory, 'bootstrap.cjs'), `--user-data-dir=${paths.userData}`]
  return { paths, environment, argv, preparedDirectories }
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

/** Build only. No subprocess server, Python import, listening socket, app launch or repository out writes. */
export async function buildWorldsAiFixture() {
  if (await realpath(process.cwd()) !== repositoryRoot) throw new Error(`Run build-only from ${repositoryRoot}.`)
  if (process.env.WORLD_FFMPEG_BUILD_TRUST_FILE) throw new Error('Fixture refuses inherited unrelated FFmpeg trust configuration.')
  const outputDirectory = await mkdtemp('/tmp/modly-worlds-ai-ui-')
  try {
    const configPath = path.join(repositoryRoot, 'electron.vite.config.ts')
    const { default: appConfig } = await import(pathToFileURL(configPath).href)
    const renderer = appConfig.renderer
    if (!renderer || !Array.isArray(renderer.plugins)) throw new Error('Production renderer build contract changed.')
    const inputs = new Set([configPath, fileURLToPath(import.meta.url), path.join(repositoryRoot, 'tailwind.config.js'), path.join(repositoryRoot, 'postcss.config.js')])
    const track = { name: 'worlds-ai-fixture-source-evidence', load(id) { if (path.isAbsolute(id) && !id.includes('\0')) inputs.add(id.split('?')[0]); return null } }
    const launch = await prepareNativeState(outputDirectory)
    await copyFile(path.join(fixtureSource, 'bootstrap.cjs'), path.join(outputDirectory, 'bootstrap.cjs'))
    const common = { bundle: true, metafile: true, logLevel: 'warning', logOverride: { 'empty-import-meta': 'error' }, tsconfig: path.join(fixtureSource, 'tsconfig.json'), target: 'es2022', external: ['electron'] }
    const bundles = await Promise.all([
      esbuild({ ...common, entryPoints: [path.join(fixtureSource, 'main.ts')], outfile: path.join(outputDirectory, 'main.cjs'), ...mainBuildOptions(path.join(outputDirectory, 'main.cjs')) }),
      esbuild({ ...common, entryPoints: [path.join(fixtureSource, 'preload.ts')], outfile: path.join(outputDirectory, 'preload.cjs'), platform: 'browser', format: 'cjs' }),
    ])
    const buildWarnings = bundles.flatMap((bundle) => bundle.warnings.map(({ id, text, location }) => ({ id, text, location })))
    if (buildWarnings.some((warning) => warning.id === 'empty-import-meta')) throw new Error('Main import metadata was erased.')
    await viteBuild({ configFile: false, envFile: false, root: fixtureSource, publicDir: false, base: './',
      cacheDir: path.join(outputDirectory, 'vite-cache'), logLevel: 'warn', resolve: renderer.resolve,
      plugins: [...renderer.plugins, track], css: { postcss: repositoryRoot },
      build: { target: renderer.build.target, outDir: path.join(outputDirectory, 'renderer'), emptyOutDir: false,
        minify: false, sourcemap: false, rollupOptions: { input: path.join(fixtureSource, 'index.html') } },
    })
    for (const bundle of bundles) for (const input of Object.keys(bundle.metafile.inputs)) inputs.add(path.resolve(repositoryRoot, input))
    for (const relative of await listFiles(fixtureSource)) inputs.add(path.join(fixtureSource, relative))
    await mkdir(path.join(outputDirectory, 'backend/routers'), { recursive: true, mode: 0o700 })
    await mkdir(path.join(outputDirectory, 'backend/services/agent_providers'), { recursive: true, mode: 0o700 })
    for (const [original, destination] of [
      [path.join(fixtureSource, 'backend.py'), 'backend/backend.py'],
      ...['agent.py', 'world_ai.py', '__init__.py'].map((name) => [path.join(repositoryRoot, 'api/routers', name), `backend/routers/${name}`]),
      ...['__init__.py'].map((name) => [path.join(repositoryRoot, 'api/services', name), `backend/services/${name}`]),
      ...['openai.py', '__init__.py'].map((name) => [path.join(repositoryRoot, 'api/services/agent_providers', name), `backend/services/agent_providers/${name}`]),
    ]) { await copyFile(original, path.join(outputDirectory, destination)); inputs.add(original) }
    const sourceInputs = []
    for (const filename of [...inputs].sort()) if (await stat(filename).then((value) => value.isFile(), () => false)) sourceInputs.push({ path: filename, ...digest(await readFile(filename)) })
    const outputs = {}
    for (const relative of await listFiles(outputDirectory)) outputs[relative] = digest(await readFile(path.join(outputDirectory, relative)))
    const pythonExecutable = path.join(repositoryRoot, 'api/.venv/bin/python')
    await stat(pythonExecutable) // Existence only. Python must not start during build-only.
    const versions = {}
    for (const name of ['electron', 'esbuild', 'vite', 'react', 'react-dom']) versions[name] = JSON.parse(await readFile(path.join(repositoryRoot, 'node_modules', name, 'package.json'), 'utf8')).version
    const result = {
      schema: 'modly.worlds-ai-ui-build.v1', scope: 'source-level-edit-only-ai-direct-edit', execution: 'NOT_RUN', provider: 'DETERMINISTIC_NDJSON_STUB',
      builtAt: new Date().toISOString(), outputDirectory, pythonExecutable, versions, outputs, sourceInputs, launch, buildWarnings,
      backendSource: 'Unmodified hashed routers.agent/world_ai copies; fixture-only AUTOMATION_BRIDGE origin assignment.',
      runtimeConfiguration: 'Both servers bind owned loopback port 0 during the separately authorized native lifecycle only.',
      nextCommand: `/usr/bin/timeout --signal=TERM --kill-after=5s 145s env -i ${Object.entries(launch.environment).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')} /usr/bin/xvfb-run -a -s '-screen 0 1280x1024x24 -nolisten tcp' ${launch.argv.map((argument) => JSON.stringify(argument)).join(' ')}`,
      limits: ['No native/socket execution by builder', 'No live LLM', 'No full Workbench/GPU/Play', 'No native stale/cancel/scene-switch proof', 'No screen-reader or packaged acceptance'],
    }
    await writeFile(path.join(outputDirectory, 'fixture-build.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return result
  } catch (error) {
    await writeFile(path.join(outputDirectory, 'build-failure.txt'), String(error)).catch(() => {})
    throw new Error(`AI build-only fixture failed; evidence retained at ${outputDirectory}`, { cause: error })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { parseBuildArguments(process.argv.slice(2)); console.log(JSON.stringify(await buildWorldsAiFixture(), null, 2)) }
  catch (error) { console.error(error); process.exitCode = 1 }
}
