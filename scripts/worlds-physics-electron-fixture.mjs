#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'
import { acceptanceDeclaration } from './worlds-physics-electron-fixture/acceptance-entry.ts'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSource = path.join(repositoryRoot, 'scripts/worlds-physics-electron-fixture')
export function parseBuildArguments(args) {
  if (args.length === 1 && args[0] === '--build-only') return { buildOnly: true }
  if (args.length === 2 && args[0] === '--build-only' && args[1] === '--lane=worker-only') return { buildOnly: true, lane: 'worker-only' }
  if (args.length === 3 && args[0] === '--build-only' && args[1] === '--lane=worker-only' && /^--acceptance-phase=(timing|ownership)$/.test(args[2])) return { buildOnly: true, lane: 'worker-only', acceptancePhase: args[2].split('=')[1] }
  throw new Error('Usage: node scripts/worlds-physics-electron-fixture.mjs --build-only [--lane=worker-only] (this command never launches Electron).')
}
const digest = (bytes) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
async function listFiles(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(directory, relative))
    else if (entry.isFile()) files.push(relative)
    else throw new Error(`Unexpected non-file build artifact: ${relative}`)
  }
  return files.sort()
}

/** Explicit build-only API. Allocate a new private root; never start or attach to an application. */
export async function buildWorldsPhysicsFixture(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['lane', 'acceptancePhase'].includes(key))) throw new Error('Unexpected physics fixture build option.')
  const lane = options.lane ?? 'native-ui'
  if (lane !== 'native-ui' && lane !== 'worker-only') throw new Error('Unsupported physics fixture lane.')
  const workerOnly = lane === 'worker-only'
  if (options.acceptancePhase !== undefined && !workerOnly) throw new Error('Acceptance phase requires worker-only lane.')
  const acceptance = options.acceptancePhase === undefined ? null : acceptanceDeclaration(options.acceptancePhase)
  if (await realpath(process.cwd()) !== repositoryRoot) throw new Error(`Build-only fixture must run from ${repositoryRoot}.`)
  if (process.env.WORLD_FFMPEG_BUILD_TRUST_FILE) throw new Error('Physics-only build refuses unrelated inherited WORLD_FFMPEG_BUILD_TRUST_FILE.')
  const outputDirectory = await mkdtemp(workerOnly ? '/tmp/modly-worlds-physics-worker-' : '/tmp/modly-worlds-physics-ui-')
  try {
    // Native TS import avoids Vite config-loader temporary writes outside our private output.
    // Reuse the actual production plugins, including the exact guarded Rapier transform.
    const configPath = path.join(repositoryRoot, 'electron.vite.config.ts')
    const { default: appConfig } = await import(pathToFileURL(configPath).href)
    const renderer = appConfig.renderer
    if (!renderer || !Array.isArray(renderer.plugins) || typeof renderer.worker?.plugins !== 'function') throw new Error('Production renderer/Worker plugin contract changed.')
    const sourceIds = new Set([configPath, fileURLToPath(import.meta.url)])
    const moduleIds = { renderer: new Set(), worker: new Set() }
    const trackInputs = (graph) => ({
      name: 'worlds-physics-fixture-source-evidence',
      load(id) { if (path.isAbsolute(id) && !id.includes('\0')) sourceIds.add(id.split('?')[0]); return null },
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) if (output.type === 'chunk') {
          for (const id of Object.keys(output.modules)) moduleIds[graph].add(id)
        }
      },
    })
    // Vite's earlier WASM loader can consume this input before our observer's load hook.
    const wasmPath = path.join(repositoryRoot, 'node_modules/@dimforge/rapier3d/rapier_wasm3d_bg.wasm')
    const rawRapierWasm = { path: wasmPath, ...digest(await readFile(wasmPath)) }
    sourceIds.add(wasmPath)
    const common = { bundle: true, metafile: true, logLevel: 'silent', tsconfig: path.join(fixtureSource, 'tsconfig.json'), target: 'es2022', external: ['electron'] }
    const builds = await Promise.all([
      esbuild({ ...common, entryPoints: [path.join(fixtureSource, 'main.ts')], outfile: path.join(outputDirectory, 'main.cjs'), platform: 'node', format: 'cjs' }),
      esbuild({ ...common, entryPoints: [path.join(fixtureSource, 'preload.ts')], outfile: path.join(outputDirectory, 'preload.cjs'), platform: 'browser', format: 'cjs' }),
    ])
    await viteBuild({
      configFile: false, envFile: false, root: fixtureSource, publicDir: false,
      cacheDir: path.join(outputDirectory, 'vite-cache'), base: './', logLevel: 'warn',
      resolve: renderer.resolve, plugins: [...renderer.plugins, trackInputs('renderer')],
      worker: { ...renderer.worker, plugins: () => [...renderer.worker.plugins(), trackInputs('worker')] },
      build: {
        target: renderer.build.target, outDir: path.join(outputDirectory, 'renderer'), emptyOutDir: false,
        minify: false, sourcemap: false, rollupOptions: { input: path.join(fixtureSource, workerOnly ? 'worker-index.html' : 'index.html') },
      },
    })
    const moduleGraphs = { renderer: [...moduleIds.renderer].sort(), worker: [...moduleIds.worker].sort() }
    if (workerOnly) {
      const forbidden = /@react-three|\/node_modules\/react(?:-dom)?\/|WorldRuntimeViewport|WorldEditorViewport|WorldsProjectBar|\/renderer\.tsx/
      if (moduleGraphs.renderer.some(id => forbidden.test(id))) throw new Error('Worker-only renderer unexpectedly imports the native/graphics UI graph.')
      if (!moduleGraphs.renderer.some(id => id.endsWith('/worker-renderer.ts')) || !moduleGraphs.worker.some(id => id.endsWith('/worldPhysics.worker.ts'))) throw new Error('Worker-only runtime entry graph is incomplete.')
    }
    for (const built of builds) for (const input of Object.keys(built.metafile.inputs)) sourceIds.add(path.resolve(repositoryRoot, input))
    for (const filename of await listFiles(fixtureSource)) sourceIds.add(path.join(fixtureSource, filename))
    const sourceInputs = []
    for (const filename of [...sourceIds].sort()) {
      if (await stat(filename).then((value) => value.isFile(), () => false)) sourceInputs.push({ path: filename, ...digest(await readFile(filename)) })
    }
    const outputs = {}
    for (const filename of await listFiles(outputDirectory)) outputs[filename] = digest(await readFile(path.join(outputDirectory, filename)))
    const workerFiles = Object.keys(outputs).filter((filename) => /^renderer\/assets\/worldPhysics\.worker-[\w-]+\.js$/.test(filename))
    if (workerFiles.length !== 1) throw new Error(`Expected exactly one production Worker artifact, got ${workerFiles.length}.`)
    const versions = {}
    for (const name of ['electron', 'esbuild', 'vite', 'react', 'react-dom', 'three', '@dimforge/rapier3d']) {
      versions[name] = JSON.parse(await readFile(path.join(repositoryRoot, 'node_modules', name, 'package.json'), 'utf8')).version
    }
    const result = {
      schema: workerOnly ? 'modly.worlds-physics-worker-build.v1' : 'modly.worlds-physics-ui-build.v1',
      scope: workerOnly ? 'programmatic-worker-play-phase1' : 'source-level-physics-play-phase1', execution: 'NOT_RUN', lane,
      ...(acceptance ? { acceptancePhase: options.acceptancePhase, acceptance } : {}),
      builtAt: new Date().toISOString(), outputDirectory, versions, outputs, sourceInputs, workerFiles, rawRapierWasm, moduleGraphs,
      productionWorkerEntry: 'src/areas/worlds/runtime/worldPhysics.worker.ts',
      rendererPlugins: renderer.plugins.flat(Infinity).filter(Boolean).map((plugin) => plugin.name),
      workerPlugins: renderer.worker.plugins().flat(Infinity).filter(Boolean).map((plugin) => plugin.name),
      csp: "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'none'",
      nextCommand: `/usr/bin/timeout --signal=TERM --kill-after=5s ${acceptance ? acceptance.outerMs / 1000 : workerOnly ? 135 : 145}s env -u ELECTRON_RUN_AS_NODE -u ELECTRON_DISABLE_SANDBOX -u NODE_OPTIONS -u NODE_PATH -u WAYLAND_DISPLAY /usr/bin/xvfb-run -a -s '-screen 0 1280x1024x24 -nolisten tcp' ${JSON.stringify(path.join(repositoryRoot, 'node_modules/electron/dist/electron'))} ${JSON.stringify(path.join(outputDirectory, 'main.cjs'))}`,
    }
    await writeFile(path.join(outputDirectory, 'fixture-build.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    return result
  } catch (error) {
    await writeFile(path.join(outputDirectory, 'build-failure.txt'), String(error)).catch(() => undefined)
    throw new Error(`Physics build-only fixture failed; retained evidence: ${outputDirectory}`, { cause: error })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const args = parseBuildArguments(process.argv.slice(2)); console.log(JSON.stringify(await buildWorldsPhysicsFixture(args.lane ? { lane: args.lane, ...(args.acceptancePhase ? { acceptancePhase: args.acceptancePhase } : {}) } : {}), null, 2)) }
  catch (error) { console.error(error); process.exitCode = 1 }
}
